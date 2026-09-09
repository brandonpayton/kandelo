/*
 * channel_syscall.c — Channel-based syscall dispatch for the shared kernel.
 *
 * Instead of importing kernel_* functions, this glue writes the syscall
 * number and arguments to a shared-memory channel, notifies the kernel
 * worker, and blocks until the result is ready.
 *
 * The exact channel status values, layout, and signal-delivery slots come
 * from wasm_posix_shared through the generated abi_constants.h header.
 *
 * Each thread has its own channel region within the process's shared
 * WebAssembly.Memory. The base address is stored in __channel_base,
 * an imported WebAssembly global set by the host at instantiation time.
 *
 * This file replaces syscall_glue.c — no kernel.* Wasm imports are used.
 * User programs compiled with this glue have zero kernel imports.
 */

/*
 * This translation unit implements POSIX signal and clock behavior even when
 * the user program selects a strict ISO C language mode.  musl intentionally
 * hides those declarations unless a POSIX feature level is requested, so the
 * glue must declare the platform contract before including system headers.
 */
#ifndef _POSIX_C_SOURCE
#define _POSIX_C_SOURCE 200809L
#endif

#include <stddef.h>
#include <stdint.h>
#include <fcntl.h>
#include <signal.h>
#include <time.h>
#include <sys/file.h>
#include <sys/soundcard.h>
#include <sys/uio.h>
#include <sys/socket.h>
#include <sys/select.h>
#include <sys/epoll.h>
#include <sys/msg.h>
#include <sys/shm.h>
#include <sys/sem.h>
#include <bits/kandelo_channel_scalars.h>
#include <bits/kandelo_process_layouts.h>
#include <bits/kandelo_syscall_marshal.h>
#include <bits/kandelo_thread_syscalls.h>
#include "abi_constants.h"

#ifdef __cplusplus
extern "C" {
#endif

/*
 * Exported ABI marker.
 *
 * Every user program built against this glue exports `__abi_version`,
 * which the host calls at instantiation time to verify the program
 * was built against a compatible kernel. The value comes from the
 * generated `abi_constants.h` header, which mirrors
 * wasm_posix_shared::ABI_VERSION — bump ABI_VERSION and regenerate
 * the header (`bash scripts/check-abi-version.sh update`) together.
 */
__attribute__((used))
__attribute__((retain))
__attribute__((export_name("__abi_version")))
unsigned int __wasm_posix_user_abi_version(void) {
    return WASM_POSIX_ABI_VERSION;
}

#ifndef WASM_POSIX_THREAD_SLOT_DECL
#define WASM_POSIX_THREAD_SLOT_DECL WASM_POSIX_THREAD_SLOT_DECL_DEFAULT
#endif

/*
 * Exported process-memory declaration.
 *
 * The SDK sets WASM_POSIX_THREAD_SLOT_DECL when it can make an explicit
 * statement about the pthread concurrency limit. -1 means "use host
 * default", 0 means "allow no pthreads", and positive values request
 * exactly that many concurrent pthreads.
 */
__attribute__((used))
__attribute__((retain))
__attribute__((export_name("__wasm_posix_thread_slots")))
int __wasm_posix_thread_slots(void) {
    return WASM_POSIX_THREAD_SLOT_DECL;
}

/* musl's errno is a macro expanding to (*__errno_location()). We only
 * need to set it on error, so we reference the function directly to
 * avoid pulling in the full errno.h header during cross-compilation. */
int *__errno_location(void);
#define errno (*__errno_location())

/* Short aliases retain the glue's readable field names without owning values. */
#define CH_IDLE        WASM_POSIX_CHANNEL_STATUS_IDLE
#define CH_PENDING     WASM_POSIX_CHANNEL_STATUS_PENDING
#define CH_TEARDOWN    WASM_POSIX_CHANNEL_STATUS_TEARDOWN
#define CH_STATUS      WASM_POSIX_CHANNEL_STATUS_OFFSET
#define CH_SYSCALL     WASM_POSIX_CHANNEL_SYSCALL_OFFSET
#define CH_ARGS        WASM_POSIX_CHANNEL_ARGS_OFFSET
#define CH_ARG_SIZE    WASM_POSIX_CHANNEL_ARG_SIZE
#define CH_RETURN      WASM_POSIX_CHANNEL_RETURN_OFFSET
#define CH_ERRNO       WASM_POSIX_CHANNEL_ERRNO_OFFSET
#define CH_DATA        WASM_POSIX_CHANNEL_DATA_OFFSET
#define CH_DATA_SIZE   WASM_POSIX_CHANNEL_DATA_SIZE
#define CH_REQUEST_FLAGS WASM_POSIX_CHANNEL_REQUEST_FLAGS_OFFSET
#define CH_REQUEST_FLAG_CANCELLATION_POINT \
    WASM_POSIX_CHANNEL_REQUEST_FLAG_CANCELLATION_POINT
#define CH_REQUEST_FLAG_CANCELLATION_WAKE_ALLOWED \
    WASM_POSIX_CHANNEL_REQUEST_FLAG_CANCELLATION_WAKE_ALLOWED
#define CH_REQUEST_FLAG_DEFER_SIGNAL_DELIVERY \
    WASM_POSIX_CHANNEL_REQUEST_FLAG_DEFER_SIGNAL_DELIVERY
#define CH_REQUEST_FLAG_OPAQUE_RECORD \
    WASM_POSIX_CHANNEL_REQUEST_FLAG_OPAQUE_RECORD
#define CH_SIG_SIGNUM  WASM_POSIX_CHANNEL_SIG_SIGNUM_OFFSET
#define CH_SIG_HANDLER WASM_POSIX_CHANNEL_SIG_HANDLER_OFFSET
#define CH_SIG_FLAGS   WASM_POSIX_CHANNEL_SIG_FLAGS_OFFSET
#define CH_SIG_SI_VALUE WASM_POSIX_CHANNEL_SIG_SI_VALUE_OFFSET
#define CH_SIG_OLD_MASK WASM_POSIX_CHANNEL_SIG_OLD_MASK_OFFSET
#define CH_SIG_SI_CODE WASM_POSIX_CHANNEL_SIG_SI_CODE_OFFSET
#define CH_SIGINFO_WORD_1 WASM_POSIX_CHANNEL_SIGINFO_WORD_1_OFFSET
#define CH_SIGINFO_WORD_2 WASM_POSIX_CHANNEL_SIGINFO_WORD_2_OFFSET
#define CH_SIG_ALT_SP  WASM_POSIX_CHANNEL_SIG_ALT_SP_OFFSET
#define CH_SIG_ALT_SIZE WASM_POSIX_CHANNEL_SIG_ALT_SIZE_OFFSET

_Static_assert(WASM_POSIX_CHANNEL_ARGS_COUNT == 6u,
               "channel syscall glue requires six argument slots");
_Static_assert(WASM_POSIX_CHANNEL_REQUEST_FLAGS_SIZE == sizeof(uint32_t),
               "channel request flags must remain one u32");
_Static_assert(
    WASM_POSIX_CHANNEL_REQUEST_FLAGS_KNOWN_MASK
        == (WASM_POSIX_CHANNEL_REQUEST_FLAG_CANCELLATION_POINT
            | WASM_POSIX_CHANNEL_REQUEST_FLAG_CANCELLATION_WAKE_ALLOWED
            | WASM_POSIX_CHANNEL_REQUEST_FLAG_DEFER_SIGNAL_DELIVERY
            | WASM_POSIX_CHANNEL_REQUEST_FLAG_OPAQUE_RECORD),
    "channel request flag mask drift"
);
_Static_assert(WASM_POSIX_CHANNEL_SIG_DELIVERY_SIZE
                   <= WASM_POSIX_CHANNEL_SIG_AREA_SIZE,
               "signal delivery wire must fit its reserved channel area");
_Static_assert(sizeof(uint32_t) == WASM_POSIX_CHANNEL_SIG_WORD_BYTES,
               "signal delivery word width must match generated ABI");
_Static_assert(sizeof(uint64_t) == WASM_POSIX_CHANNEL_SIG_SI_VALUE_BYTES,
               "signal delivery sigval width must match generated ABI");
_Static_assert(sizeof(uint64_t) == WASM_POSIX_CHANNEL_SIG_OLD_MASK_BYTES,
               "signal delivery mask width must match generated ABI");
_Static_assert(sizeof(uint64_t) == WASM_POSIX_CHANNEL_SIG_ALT_SP_BYTES,
               "signal delivery alt-stack pointer width must match generated ABI");
_Static_assert(sizeof(uint64_t) == WASM_POSIX_CHANNEL_SIG_ALT_SIZE_BYTES,
               "signal delivery alt-stack size width must match generated ABI");

#define EFAULT 14
#define EINTR 4
#define EINVAL 22
#define SYS_SIGACTION __NR_sigaction
#define SYS_WAIT4 __NR_wait4
#define SYS_WAITID __NR_waitid
#define SYS_SIGPROCMASK __NR_sigprocmask
#define SYS_RT_SIGRETURN __NR_rt_sigreturn
#define SYS_GETTID __NR_gettid
#define SYS_CLOCK_GETTIME __NR_clock_gettime
#define SYS_THREAD_CANCEL KANDELO_SYS_THREAD_CANCEL

#define KANDELO_FUTEX_WAIT 0
#define KANDELO_FUTEX_WAIT_BITSET 9
#define KANDELO_FUTEX_CMD_MASK 0x7f

static long __do_syscall(long n, long long a1, long long a2, long long a3,
                         long long a4, long long a5, long long a6);
static long __do_syscall_impl(long n, long long a1, long long a2, long long a3,
                              long long a4, long long a5, long long a6,
                              int cancellation_point,
                              uint32_t extra_request_flags);

static _Thread_local uint32_t kandelo_caught_handler_depth;

unsigned long __wasm_posix_caught_handler_depth(void)
{
    return kandelo_caught_handler_depth;
}

void __wasm_posix_longjmp_cleanup(unsigned long target_depth)
{
    /* Generic setjmp/longjmp at equal depth is an ordinary nonlocal jump.
     * Avoid even a diagnostic syscall so signal-aware longjmp can share this
     * idempotent helper before its mask restore and the runtime throw. */
    if (kandelo_caught_handler_depth <= target_depth)
        return;

    long tid = __do_syscall(SYS_GETTID, 0, 0, 0, 0, 0, 0);

    while (kandelo_caught_handler_depth > target_depth) {
        /* Retire the handler frame first. The immediately following exact
         * self cancellation is then distinguishable from normal return,
         * whose rt_sigreturn is followed by libc's old-mask restoration. */
        kandelo_caught_handler_depth--;
        (void)__do_syscall(SYS_RT_SIGRETURN, 0, 0, 0, 0, 0, 0);
        if (tid > 0)
            (void)__do_syscall(SYS_THREAD_CANCEL, tid, 0, 0, 0, 0, 0);
    }
}

static int kandelo_capture_ppoll_deadline(
    long n,
    long long timeout_arg,
    struct timespec *deadline)
{
    struct timespec timeout;
    struct timespec now;
    uintptr_t timeout_ptr;
    uintptr_t memory_bytes;

    if (n != __NR_ppoll || timeout_arg == 0)
        return 0;
    timeout_ptr = (uintptr_t)timeout_arg;
    memory_bytes = (uintptr_t)__builtin_wasm_memory_size(0) * 65536u;
    if (timeout_ptr > memory_bytes ||
        sizeof(timeout) > memory_bytes - timeout_ptr)
        return 0;
    __builtin_memcpy(&timeout, (const void *)timeout_ptr, sizeof(timeout));
    if (timeout.tv_sec < 0 || timeout.tv_nsec < 0 ||
        timeout.tv_nsec >= 1000000000L)
        return 0;
    /* Reading the clock is internal accounting for the enclosing ppoll, not
     * a guest signal checkpoint. In particular, a signal already pending at
     * ppoll entry must interrupt ppoll itself rather than this timestamp. */
    if (__do_syscall_impl(
            SYS_CLOCK_GETTIME,
            CLOCK_MONOTONIC,
            (long long)(uintptr_t)&now,
            0, 0, 0, 0,
            0,
            CH_REQUEST_FLAG_DEFER_SIGNAL_DELIVERY
        ) != 0)
        return 0;
    deadline->tv_sec = now.tv_sec + timeout.tv_sec;
    deadline->tv_nsec = now.tv_nsec + timeout.tv_nsec;
    if (deadline->tv_nsec >= 1000000000L) {
        deadline->tv_sec++;
        deadline->tv_nsec -= 1000000000L;
    }
    return 1;
}

static void kandelo_ppoll_remaining(
    const struct timespec *deadline,
    struct timespec *remaining)
{
    struct timespec now;

    if (__do_syscall_impl(
            SYS_CLOCK_GETTIME,
            CLOCK_MONOTONIC,
            (long long)(uintptr_t)&now,
            0, 0, 0, 0,
            0,
            CH_REQUEST_FLAG_DEFER_SIGNAL_DELIVERY
        ) != 0 || now.tv_sec > deadline->tv_sec ||
        (now.tv_sec == deadline->tv_sec && now.tv_nsec >= deadline->tv_nsec)) {
        remaining->tv_sec = 0;
        remaining->tv_nsec = 0;
        return;
    }
    remaining->tv_sec = deadline->tv_sec - now.tv_sec;
    if (deadline->tv_nsec < now.tv_nsec) {
        remaining->tv_sec--;
        remaining->tv_nsec = 1000000000L + deadline->tv_nsec - now.tv_nsec;
    } else {
        remaining->tv_nsec = deadline->tv_nsec - now.tv_nsec;
    }
}

/*
 * Classify only operations whose zero-progress interruption may be submitted
 * again after the caught handler runs.
 *
 * WHY: CH_SIG_FLAGS carries the effective action flags for this interruption.
 * The host clears SA_RESTART in its owned signal record when an exact socket
 * OFD has SO_RCVTIMEO/SO_SNDTIMEO, so the socket cases below cannot reset a
 * live deadline. ppoll is included because POSIX requires an interruptible
 * function to restart with SA_RESTART unless that function says otherwise;
 * unlike pselect, ppoll has no implementation-defined EINTR exception.
 * pselect, signal waits, sleeps, and SysV IPC are deliberately absent:
 * Kandelo selects pselect's POSIX-permitted EINTR behavior, while the other
 * operations have their own interruption rules.
 */
static int kandelo_should_restart_after_handler(
    long n,
    long long a1,
    long long a2,
    long long a3,
    long long a4,
    long long a5,
    long long a6)
{
    (void)a1;
    (void)a3;
    (void)a5;
    (void)a6;

    switch (n) {
    case __NR_open:
    case __NR_openat:
    case __NR_wait4:
    case __NR_waitid:
    case __NR_ppoll:
    case __NR_read:
    case __NR_write:
    case __NR_pread:
    case __NR_pwrite:
    case __NR_readv:
    case __NR_writev:
    case __NR_preadv:
    case __NR_pwritev:
    case __NR_preadv2:
    case __NR_pwritev2:
    case __NR_accept:
    case __NR_accept4:
    case __NR_connect:
    case __NR_send:
    case __NR_recv:
    case __NR_sendto:
    case __NR_recvfrom:
    case __NR_sendmsg:
    case __NR_recvmsg:
    case __NR_mq_timedsend:
    case __NR_mq_timedreceive:
        return 1;
    case __NR_ioctl:
        /* OSS output drain is a zero-progress slow-device wait. */
        return (uint32_t)a2 == SNDCTL_DSP_SYNC;
    case __NR_fcntl:
        /*
         * musl aliases the feature-gated F_SETLKW64 spelling to this same
         * target command. Classify the canonical value so ordinary builds
         * do not depend on _LARGEFILE64_SOURCE exposing the alias.
         */
        return a2 == F_SETLKW
            || a2 == F_OFD_SETLKW;
    case __NR_flock:
        return (a2 & LOCK_NB) == 0;
    case __NR_futex: {
        const long long command = a2 & KANDELO_FUTEX_CMD_MASK;
        return a4 == 0
            && (command == KANDELO_FUTEX_WAIT
                || command == KANDELO_FUTEX_WAIT_BITSET);
    }
    default:
        return 0;
    }
}

/*
 * Cancel the Rust-owned state of an interrupted signal-mask-swapping wait.
 *
 * The kernel deliberately retains the pre-wait mask while libc runs a caught
 * handler and decides whether SA_RESTART applies. A restarted ppoll simply
 * resubmits with the replacement mask still current. A final ppoll/pselect
 * EINTR, rt_sigsuspend, or pause instead uses the existing exact-task
 * host-wait cancellation syscall after the handler has returned. The
 * self-target form is reserved for this cleanup; pthread_cancel(self) never
 * issues SYS_THREAD_CANCEL. No poll/select result buffers are touched and no
 * second mask owner or channel field is introduced.
 */
static void kandelo_finish_interrupted_mask_wait(
    long n,
    long long a4,
    long long a6)
{
    if ((n == __NR_ppoll && a4 != 0) ||
        (n == __NR_pselect6 && a6 != 0) ||
        n == __NR_rt_sigsuspend ||
        n == __NR_pause) {
        long tid = __do_syscall(SYS_GETTID, 0, 0, 0, 0, 0, 0);
        if (tid > 0) {
            (void)__do_syscall(SYS_THREAD_CANCEL, tid, 0, 0, 0, 0, 0);
        }
    }
}

/* The kernel ABI deliberately keeps sigaction's transport record fixed at
 * 16 bytes: u32 table index, u32 flags, u64 mask.  musl's internal
 * k_sigaction happens to match that prefix on wasm32, while its pointer and
 * unsigned-long fields make the memory64 form 32 bytes. */
struct kandelo_sigaction_wire {
    uint32_t handler;
    uint32_t flags;
    uint64_t mask;
};

_Static_assert(sizeof(struct kandelo_sigaction_wire) == 16,
               "sigaction wire record must stay 16 bytes");

#if __SIZEOF_POINTER__ == 8
#define KANDELO_NATIVE_SIGINFO_SIZE KANDELO_PROCESS_SIGINFO_WASM64_SIZE
#define KANDELO_NATIVE_SIGINFO_PID_OFFSET \
    KANDELO_PROCESS_SIGINFO_WASM64_PID_OFFSET
#define KANDELO_NATIVE_SIGINFO_UID_OFFSET \
    KANDELO_PROCESS_SIGINFO_WASM64_UID_OFFSET
#define KANDELO_NATIVE_SIGINFO_VALUE_OFFSET \
    KANDELO_PROCESS_SIGINFO_WASM64_VALUE_OFFSET
#define KANDELO_NATIVE_SIGINFO_VALUE_SIZE \
    KANDELO_PROCESS_SIGINFO_WASM64_VALUE_SIZE
#else
#define KANDELO_NATIVE_SIGINFO_SIZE KANDELO_PROCESS_SIGINFO_WASM32_SIZE
#define KANDELO_NATIVE_SIGINFO_PID_OFFSET \
    KANDELO_PROCESS_SIGINFO_WASM32_PID_OFFSET
#define KANDELO_NATIVE_SIGINFO_UID_OFFSET \
    KANDELO_PROCESS_SIGINFO_WASM32_UID_OFFSET
#define KANDELO_NATIVE_SIGINFO_VALUE_OFFSET \
    KANDELO_PROCESS_SIGINFO_WASM32_VALUE_OFFSET
#define KANDELO_NATIVE_SIGINFO_VALUE_SIZE \
    KANDELO_PROCESS_SIGINFO_WASM32_VALUE_SIZE
#endif

_Static_assert(sizeof(siginfo_t) == KANDELO_NATIVE_SIGINFO_SIZE,
               "generated siginfo_t size must match musl");
_Static_assert(offsetof(siginfo_t, si_signo)
                   == KANDELO_PROCESS_SIGINFO_SIGNO_OFFSET,
               "generated siginfo_t signo offset must match musl");
_Static_assert(offsetof(siginfo_t, si_errno)
                   == KANDELO_PROCESS_SIGINFO_ERRNO_OFFSET,
               "generated siginfo_t errno offset must match musl");
_Static_assert(offsetof(siginfo_t, si_code)
                   == KANDELO_PROCESS_SIGINFO_CODE_OFFSET,
               "generated siginfo_t code offset must match musl");
_Static_assert(offsetof(siginfo_t, si_pid) == KANDELO_NATIVE_SIGINFO_PID_OFFSET,
               "generated siginfo_t pid offset must match musl");
_Static_assert(offsetof(siginfo_t, si_uid) == KANDELO_NATIVE_SIGINFO_UID_OFFSET,
               "generated siginfo_t uid offset must match musl");
_Static_assert(offsetof(siginfo_t, si_value)
                   == KANDELO_NATIVE_SIGINFO_VALUE_OFFSET,
               "generated siginfo_t value offset must match musl");
_Static_assert(sizeof(union sigval) == KANDELO_NATIVE_SIGINFO_VALUE_SIZE,
               "generated siginfo_t value width must match musl");
_Static_assert(offsetof(siginfo_t, si_timerid)
                   == KANDELO_NATIVE_SIGINFO_PID_OFFSET,
               "generated siginfo_t timer ID offset must match musl");
_Static_assert(offsetof(siginfo_t, si_overrun)
                   == KANDELO_NATIVE_SIGINFO_UID_OFFSET,
               "generated siginfo_t timer overrun offset must match musl");

/* Per-thread channel base address.
 *
 * Stored as an imported WebAssembly global — each wasm instance (thread)
 * gets its own copy, immune to cross-thread shared memory corruption.
 * The host provides the value via WebAssembly.Global at instantiation time.
 *
 * Unlike _Thread_local (which stores in shared linear memory at __tls_base +
 * offset), wasm globals are instance-local and cannot be corrupted by other
 * threads' pointer arithmetic into the same memory region. */
#if __SIZEOF_POINTER__ == 8
__asm__(".globaltype __channel_base, i64\n");
#else
__asm__(".globaltype __channel_base, i32\n");
#endif

static inline uintptr_t get_channel_base(void) {
    uintptr_t val;
    __asm__ volatile("global.get __channel_base\n"
                     "local.set %0" : "=r"(val));
    return val;
}

/* Return 0 to signal that channel base uses a wasm global import,
 * not a TLS memory address. The host checks: if this returns 0,
 * skip TLS-based channel setup (the global is set at instantiation). */
__attribute__((export_name("__get_channel_base_addr")))
uintptr_t __get_channel_base_addr(void) {
    return 0;
}

/* SYS_EXIT needs special handling */
#define SYS_EXIT 34
#define SYS_GETPID 28

/* SYS_FORK/VFORK — kernel_fork import is the fork-continuation boundary.
 * wasm-fork-instrument rewrites the call graph around kernel.kernel_fork, enabling
 * the host to save/restore the call stack across fork — so the child
 * resumes from the fork point with all local variables intact.
 *
 * IMPORTANT: fork()/vfork()/_Fork() call kernel_fork(mode) directly below,
 * NOT through __do_syscall(). This keeps fork instrumentation limited
 * to the fork call chain. If kernel_fork were reachable from __do_syscall,
 * the tool would instrument every function that makes any syscall (~54K
 * functions in PHP-FPM), bloating frame sizes and overflowing V8's stack
 * in browser web workers. */
#define SYS_FORK  212
#define SYS_VFORK 213

__attribute__((import_module("kernel"), import_name("kernel_fork")))
int32_t kernel_fork(int32_t mode);

__attribute__((import_module("kernel"), import_name("kernel_exit")))
_Noreturn void kernel_exit(int32_t status);

/*
 * Complete one ordinary guest-owned channel request after a host import that
 * performed channel work in JavaScript. Those host-owned completions leave
 * caught signals kernel-pending because they cannot invoke this file's signal
 * trampoline. GETPID is side-effect-free and gives the pending signal an exact
 * libc-owned completion without introducing a host-to-Wasm callback.
 */
/*
 * The fork instrumenter uses this stable local entry when it lowers the
 * historical monolithic __wasm_dlopen import to ABI 43's staged protocol.
 * Exporting it lets the generated adapter hand deferred signal delivery back
 * to libc after each host-owned loader request, without a host-to-Wasm
 * callback or a second signal implementation in the instrumenter.
 */
__attribute__((used))
__attribute__((retain))
__attribute__((export_name("__wasm_posix_signal_checkpoint")))
void __wasm_posix_signal_checkpoint(void)
{
    (void)__do_syscall(SYS_GETPID, 0, 0, 0, 0, 0, 0);
}

/* Direct fork/vfork/_Fork — call kernel_fork without going through the
 * general syscall dispatcher.  This ensures fork instrumentation only covers
 * fork callers, not every function that makes any syscall. */

void __fork_handler(int);
void __wasm_posix_after_fork_child(void);

/* _Fork/fork/vfork MUST NOT be inlined. wasm-fork-instrument discovers
 * the call chain around kernel_fork. At -O2, LLVM inlines these wrappers into every caller
 * and can then eliminate the kernel_fork call on paths where it decides
 * the return value is unused in a specific way — a silent miscompile that
 * makes bash's make_child appear to "fork" but never actually invoke
 * kernel_fork, so pipeline child-side redirection runs in the parent
 * process and subsequent writes to the pipe fail with EPIPE. Keeping these
 * as distinct non-inlined functions preserves both the fork call graph
 * and the observable side effect of the kernel_fork import. */

static int __wasm_posix_finish_fork(long ret)
{
    if (ret == 0) {
        __wasm_posix_after_fork_child();
    } else {
        /*
         * WHY: fork transaction allocation and cleanup are consumed by the
         * process Worker rather than this libc trampoline, so the host leaves
         * caught signals kernel-pending. Re-enter through one ordinary channel
         * completion before returning to user code; this invokes any handler
         * without a reentrant host-to-Wasm call.
         */
        __wasm_posix_signal_checkpoint();
    }
    if (ret < 0) {
        *__errno_location() = (int)(-ret);
        return -1;
    }
    return (int)ret;
}

static int __wasm_posix_finish_vfork(long ret)
{
    /*
     * WHY: the vfork child is still borrowing the suspended caller's TLS and
     * libc globals. Ordinary fork must rebind a copied pthread descriptor to
     * the new PID, but doing that here would overwrite the live parent's TID,
     * thread list, and threads_minus_1 count. A successful exec replaces this
     * state; _exit needs no libc-side child reinitialization.
     */
    if (ret != 0) {
        __wasm_posix_signal_checkpoint();
    }
    if (ret < 0) {
        *__errno_location() = (int)(-ret);
        return -1;
    }
    return (int)ret;
}

__attribute__((noinline))
int _Fork(void)
{
    return __wasm_posix_finish_fork(
        (long)kernel_fork(WASM_POSIX_FORK_MODE_FORK));
}

__attribute__((noinline))
int fork(void)
{
    __fork_handler(-1);
    int ret = _Fork();
    __fork_handler(!ret);
    return ret;
}

__attribute__((noinline))
int vfork(void)
{
    /* vfork neither runs pthread_atfork handlers nor rewrites the borrowed
     * caller state before exec/_exit. */
    return __wasm_posix_finish_vfork(
        (long)kernel_fork(WASM_POSIX_FORK_MODE_VFORK));
}

/* ------------------------------------------------------------------ */
/* Signal delivery — invoked after each syscall if a signal is pending */
/* ------------------------------------------------------------------ */

extern long __syscall_cp_check(long r);
extern int __syscall_cp_cancel_wake_allowed(void);

static uint32_t __deliver_pending_signal(uintptr_t base, int *delivered)
{
    *delivered = 0;
    uint32_t *sig_signum_ptr  = (uint32_t *)(uintptr_t)(base + CH_SIG_SIGNUM);
    uint32_t *sig_handler_ptr = (uint32_t *)(uintptr_t)(base + CH_SIG_HANDLER);
    uint32_t *sig_flags_ptr   = (uint32_t *)(uintptr_t)(base + CH_SIG_FLAGS);

    uint32_t signum  = *sig_signum_ptr;
    if (signum == 0) return 0;
    *delivered = 1;

    /* Cooperative hard-exit for host teardown.
     *
     * [JSC-TERMINATE-ATOMICS-WAIT-LEAK] — WORKAROUND, remove when the engine bug
     * is fixed; see docs/jsc-terminate-atomics-wait-workaround.md.
     *
     * SIGKILL is never delivered to the guest in normal operation — it is
     * uncatchable, so the kernel enforces its default terminate action itself
     * and never writes it into the channel signal slot. The host therefore
     * uses a queued SIGKILL as an unambiguous "exit now" instruction: on
     * teardown it wakes each blocked worker and queues SIGKILL so this runs.
     *
     * We must reach the exit path that ends in a wasm trap so the worker
     * returns to its JS event loop and the host can actually reclaim it. This
     * matters because on JSC (Safari, and Bun) Worker.terminate() cannot free a
     * worker parked in Atomics.wait on the syscall channel — the state every
     * blocked process worker sits in. (V8 — Chrome, Node — reclaims such workers
     * on terminate, so this path is simply never exercised there.)
     *
     * Crucially we do NOT call musl _exit() here: on this port _exit() issues
     * SYS_exit_group over the channel (which returns normally) and then spins
     * `for (;;) __syscall(SYS_exit)`, re-parking the worker in Atomics.wait —
     * exactly the un-reclaimable state we are trying to escape. Instead we call
     * the kernel_exit import directly. worker-main services the SYS_EXIT, then
     * the _Noreturn import is followed by an `unreachable` trap that worker-main
     * catches as a clean exit, unwinding the wasm and idling the worker so the
     * host terminate() can reclaim its thread + memory. Without this, each image
     * switch leaks a machine's worth of un-killable worker threads and Safari
     * OOMs. */
    if (signum == SIGKILL) {
        extern _Noreturn void kernel_exit(int32_t status)
            __attribute__((import_module("kernel"), import_name("kernel_exit")));
        kernel_exit(128 + SIGKILL);
    }

    uint32_t handler = *sig_handler_ptr;
    uint32_t flags   = *sig_flags_ptr;

    /* Read the saved old blocked mask from its generated channel slot. */
    uint64_t old_mask;
    __builtin_memcpy(&old_mask,
                     (void *)(uintptr_t)(base + CH_SIG_OLD_MASK),
                     sizeof(old_mask));

    /* Read alt stack info — non-zero alt_sp means we need to switch
     * the wasm shadow stack (__stack_pointer) to the alt stack buffer
     * before calling the handler.  This makes &local_var land inside
     * the alt stack range, matching real sigaltstack behavior. */
    uint64_t alt_sp_wire;
    uint64_t alt_size_wire;
    __builtin_memcpy(&alt_sp_wire,
                     (void *)(uintptr_t)(base + CH_SIG_ALT_SP),
                     sizeof(alt_sp_wire));
    __builtin_memcpy(&alt_size_wire,
                     (void *)(uintptr_t)(base + CH_SIG_ALT_SIZE),
                     sizeof(alt_size_wire));
    if (alt_sp_wire > UINTPTR_MAX ||
        alt_size_wire > SIZE_MAX ||
        alt_sp_wire > UINTPTR_MAX - alt_size_wire) {
        /* The kernel validates this range before storing sigaltstack state.
         * Reaching this branch means the shared ABI was violated; trapping is
         * safer than wrapping the process shadow-stack pointer. */
        __builtin_trap();
    }
    uintptr_t alt_sp = (uintptr_t)alt_sp_wire;
    size_t alt_size = (size_t)alt_size_wire;

    /* Clear signal delivery area before calling handler */
    *sig_signum_ptr = 0;

    /* Save the current shadow stack pointer and switch to alt stack
     * if the kernel told us to.  We use inline asm to access the wasm
     * __stack_pointer global directly.  The saved_sp local lives in a
     * wasm register (not on the shadow stack) so it survives the switch. */
    void *saved_sp = 0;
    if (alt_sp != 0) {
        __asm__ volatile("global.get __stack_pointer\nlocal.set %0" : "=r"(saved_sp));
        void *new_sp = (void *)(uintptr_t)(alt_sp + alt_size);
        /* Shadow stack grows downward — set to top of alt stack buffer */
        __asm__ volatile("local.get %0\nglobal.set __stack_pointer" :: "r"(new_sp));
    }

    kandelo_caught_handler_depth++;

    /* Invoke the signal handler via function pointer.
     * In Wasm, function pointers are table indices — casting the
     * handler_index to a function pointer and calling it uses
     * call_indirect, which looks up the indirect function table. */
    if (flags & SA_SIGINFO) {
        /* Build the native musl type so its compiler-owned alignment and
         * effective type cannot drift from the generated layout assertions. */
        uint64_t si_value_bits;
        __builtin_memcpy(&si_value_bits,
                         (void *)(uintptr_t)(base + CH_SIG_SI_VALUE),
                         sizeof(si_value_bits));
        int32_t si_code =
            *(int32_t *)(uintptr_t)(base + CH_SIG_SI_CODE);
        int32_t siginfo_word_1 =
            *(int32_t *)(uintptr_t)(base + CH_SIGINFO_WORD_1);
        int32_t siginfo_word_2 =
            *(int32_t *)(uintptr_t)(base + CH_SIGINFO_WORD_2);
        siginfo_t info;
        __builtin_memset(&info, 0, sizeof(info));
        info.si_signo = (int)signum;
        info.si_code = si_code;
        if (si_code == SI_TIMER) {
            info.si_timerid = siginfo_word_1;
            info.si_overrun = siginfo_word_2;
        } else {
            info.si_pid = (pid_t)siginfo_word_1;
            info.si_uid = (uid_t)(uint32_t)siginfo_word_2;
        }
        /*
         * WHY: union sigval is pointer-width native data. Copying its raw
         * bytes preserves both sival_int's low 32 bits and a wasm64
         * sival_ptr without selecting the wrong union member. In a mixed
         * wasm32/wasm64 machine, copying the native union width deliberately
         * gives a wasm32 recipient the low 32 bits.
         */
        __builtin_memcpy(&info.si_value, &si_value_bits, sizeof(info.si_value));
        void (*sa)(int, siginfo_t *, void *) =
            (void (*)(int, siginfo_t *, void *))(uintptr_t)handler;
        sa((int)signum, &info, (void *)0);
    } else {
        void (*sa)(int) = (void (*)(int))(uintptr_t)handler;
        sa((int)signum);
    }

    /* Restore shadow stack before making further syscalls */
    if (saved_sp != 0) {
        __asm__ volatile("local.get %0\nglobal.set __stack_pointer" :: "r"(saved_sp));
    }

    /* Notify kernel that signal handler has returned.
     * This clears SS_ONSTACK if we were on the alt stack. */
    kandelo_caught_handler_depth--;
    __do_syscall(SYS_RT_SIGRETURN, 0, 0, 0, 0, 0, 0);

    /* Restore the old blocked mask via sigprocmask syscall.
     * This also triggers delivery of any further pending signals
     * (the kernel writes signal info on the sigprocmask return). */
    __do_syscall(SYS_SIGPROCMASK, SIG_SETMASK,
                 (long)(uintptr_t)&old_mask, 0, 8, 0, 0);

    return flags;
}

/* ================================================================== */
/* Phase 2 opaque transport: guest self-marshalled channel record.     */
/*                                                                     */
/* ADDITIVE / DORMANT. __marshal_channel_record encodes a syscall's    */
/* pointer arguments into a `channel_record` (record ABI v1) laid at    */
/* the channel DATA region, byte-for-byte matching the layout the       */
/* runtime-core decoder                                                */
/* (crates/runtime-core/src/channel_record_decode.rs) and the kernel   */
/* reconstruction (channel_scratch.rs::prepare_channel_record) consume. */
/* It is intentionally NOT wired into __do_syscall_impl; the atomic     */
/* flip to the record path is Task 6. Per-syscall pointer knowledge     */
/* comes entirely from the generated bits/kandelo_syscall_marshal.h     */
/* table, whose single source of truth is                              */
/* wasm_posix_shared::host_abi::SYSCALL_ARG_DESCRIPTORS.               */
/*                                                                     */
/* Returns the encoded record byte length on success, or a negative    */
/* value when the syscall cannot be faithfully marshalled inline (the   */
/* caller must fall back to the raw-arg path). Coverage is the flat      */
/* descriptor-table syscalls, the nested iovec/msghdr shapes, and the    */
/* bespoke special-layout families (ioctl, select/pselect6, epoll,       */
/* prctl, fcntl-lock, SysV IPC including semctl GETALL/SETALL). ioctl    */
/* sizing uses the generated ioctl contract table; select converts its   */
/* timeout to the kernel's millisecond scalar; semctl GETALL/SETALL      */
/* size their buffer via one preliminary IPC_STAT (see that case).       */
/* ================================================================== */

#define KANDELO_MARSHAL_FALLBACK (-1)

/* Guest linear-memory size in bytes (wasm pages are 64 KiB). */
static inline uint64_t kandelo_guest_memory_bytes(void) {
    return (uint64_t)__builtin_wasm_memory_size(0) * 65536ull;
}

/* True when [ptr, ptr+len) lies fully within guest memory. A pointer argument
 * that fails this must NOT be read by the encoder: the legacy host path
 * bounds-checked every pointer and surfaced EFAULT, so an out-of-range span is
 * a fallback to the raw path (where the kernel returns the same EFAULT) rather
 * than an out-of-bounds trap in the guest. */
static inline int kandelo_range_in_bounds(uintptr_t ptr, uint64_t len) {
    uint64_t mem = kandelo_guest_memory_bytes();
    if ((uint64_t)ptr > mem)
        return 0;
    if (len > mem - (uint64_t)ptr)
        return 0;
    return 1;
}

static inline void kandelo_store_u16(uint8_t *p, uint16_t v) {
    __builtin_memcpy(p, &v, sizeof v);
}
static inline void kandelo_store_u32(uint8_t *p, uint32_t v) {
    __builtin_memcpy(p, &v, sizeof v);
}
static inline void kandelo_store_i64(uint8_t *p, int64_t v) {
    __builtin_memcpy(p, &v, sizeof v);
}

static const struct kandelo_marshal_syscall *
kandelo_marshal_lookup(uint32_t syscall_number) {
    /* The generated table is sorted by syscall number; the table is small,
     * so a linear scan keeps the dormant encoder simple. */
    for (uint32_t i = 0; i < KANDELO_MARSHAL_SYSCALL_COUNT; i++) {
        if (kandelo_marshal_table[i].syscall_number == syscall_number)
            return &kandelo_marshal_table[i];
    }
    return (const struct kandelo_marshal_syscall *)0;
}

/* Look up an ioctl request in the generated request->size/direction contract
 * (bits/kandelo_syscall_marshal.h, projected from
 * wasm_posix_shared::ioctl_contract). The table is sorted by request; a linear
 * scan keeps the dormant encoder simple. Returns NULL for an unknown request. */
static const struct kandelo_ioctl_contract *
kandelo_ioctl_lookup(uint32_t request) {
    for (uint32_t i = 0; i < KANDELO_IOCTL_CONTRACT_COUNT; i++) {
        if (kandelo_ioctl_contracts[i].request == request)
            return &kandelo_ioctl_contracts[i];
    }
    return (const struct kandelo_ioctl_contract *)0;
}

/* Compute the flat span byte length for one pointer arg, reading from guest
 * memory when the rule dereferences a length or scans a C string. Returns
 * KANDELO_MARSHAL_FALLBACK (< 0) when the length cannot be determined. */
static long kandelo_marshal_arg_len(const struct kandelo_marshal_arg *arg,
                                    const long long *args, uintptr_t ptr) {
    switch (arg->size_kind) {
    case KANDELO_MARSHAL_SIZE_CSTRING: {
        /* PATH_STR: scan for the terminator, len includes the NUL, bounded by
         * `a` (max_bytes) AND by guest memory so a string near the memory edge
         * cannot be scanned out of bounds. No terminator within the available
         * ceiling is a fallback (the raw path then surfaces the real errno). */
        const uint8_t *s = (const uint8_t *)ptr;
        uint64_t mem = kandelo_guest_memory_bytes();
        if ((uint64_t)ptr >= mem)
            return KANDELO_MARSHAL_FALLBACK;
        uint64_t avail = mem - (uint64_t)ptr;
        uint32_t max = arg->a;
        if ((uint64_t)max > avail)
            max = (uint32_t)avail;
        for (uint32_t i = 0; i < max; i++) {
            if (s[i] == 0)
                return (long)i + 1;
        }
        return KANDELO_MARSHAL_FALLBACK;
    }
    case KANDELO_MARSHAL_SIZE_ARG: {
        long long n = args[arg->a];
        if (n < 0)
            return KANDELO_MARSHAL_FALLBACK;
        /* len = n * multiplier + add */
        unsigned long long len = (unsigned long long)n * arg->b + arg->c;
        if (len > 0xFFFFFFFFull)
            return KANDELO_MARSHAL_FALLBACK;
        return (long)len;
    }
    case KANDELO_MARSHAL_SIZE_DEREF: {
        uintptr_t lp = (uintptr_t)(unsigned long long)args[arg->a];
        if (lp == 0 || !kandelo_range_in_bounds(lp, sizeof(uint32_t)))
            return KANDELO_MARSHAL_FALLBACK;
        uint32_t v;
        __builtin_memcpy(&v, (const void *)lp, sizeof v);
        return (long)v;
    }
    case KANDELO_MARSHAL_SIZE_FIXED:
        return (long)arg->a;
    case KANDELO_MARSHAL_SIZE_LAYOUT:
        return (sizeof(void *) == 8) ? (long)arg->b : (long)arg->a;
    default:
        return KANDELO_MARSHAL_FALLBACK;
    }
}

/* ================================================================== */
/* Special-layout syscall families (Task 5b).                          */
/*                                                                     */
/* These bespoke families are NOT in the generated marshal table, so   */
/* the flat-descriptor path above would lose their pointer args. Their */
/* per-syscall size/direction knowledge lives in the guest (it owns the */
/* fcntl lock cmd, the epoll count, the msg size, the IPC cmd, the      */
/* pointer width), so the guest self-marshals a generic In/Out/InOut    */
/* span the kernel's `prepare_channel_record` lays back into the exact  */
/* scratch layout the UNCHANGED `validate_special_layout`/dispatch      */
/* accepts. DORMANT: reached only from the (dormant) record encoder.    */
/* ================================================================== */

#define KANDELO_MARSHAL_NOT_SPECIAL (-2)

/* Kandelo/Linux syscall numbers for the special families. These match the
 * wasm_posix_shared::Syscall / abi::extended_syscalls values the guest issues
 * and the kernel dispatch (crates/kernel/src/wasm_api.rs) branches on. */
#define KANDELO_SYS_IOCTL       72
#define KANDELO_SYS_SELECT      103
#define KANDELO_SYS_FCNTL       25
#define KANDELO_SYS_PRCTL       223
#define KANDELO_SYS_EPOLL_CTL   240
#define KANDELO_SYS_EPOLL_PWAIT 241
#define KANDELO_SYS_PSELECT6    252
#define KANDELO_SYS_MSGRCV      338
#define KANDELO_SYS_MSGSND      339
#define KANDELO_SYS_MSGCTL      340
#define KANDELO_SYS_SEMCTL      343
#define KANDELO_SYS_SHMCTL      347
#define KANDELO_SYS_EPOLL_WAIT  379

/* Fixed record-buffer sizes for the special families. The struct-sized ones
 * come from the guest's own (caller-width) musl headers, which are the same
 * ABI the kernel's wasm32/wasm64 wire sizes describe; static_asserts below
 * pin the wasm32 sizes so any drift is a loud compile failure. PRCTL name /
 * SysV header / signal-mask sizes mirror wasm_posix_shared::kernel_scratch_wire
 * (PRCTL_NAME_BYTES, WasmSysvMessageHeader, SIGNAL_MASK_BYTES). */
#define KANDELO_MARSHAL_PRCTL_NAME_BYTES 16u
#define KANDELO_MARSHAL_SYSV_MSG_HEADER_BYTES 8u

#if defined(__wasm32__)
_Static_assert(sizeof(struct flock) == 32, "wasm32 struct flock must match WasmFlock (FCNTL_FLOCK_BYTES)");
_Static_assert(sizeof(struct epoll_event) == 16, "wasm32 struct epoll_event must match WasmEpollEvent");
_Static_assert(sizeof(struct msqid_ds) == 96, "wasm32 struct msqid_ds must match msqid_ds_size(4)");
_Static_assert(sizeof(struct shmid_ds) == 88, "wasm32 struct shmid_ds must match shmid_ds_size(4)");
#endif
_Static_assert(KANDELO_MARSHAL_SYSV_MSG_HEADER_BYTES == sizeof(int64_t),
               "SysV message wire header is one canonical i64");

/* Write the record header (magic/abi/syscall/span_count + the six scalar
 * words) from a possibly-adjusted scalar array. Mirrors KANDELO_WRITE_HEADER
 * in __marshal_channel_record; the special families adjust scalar slots the
 * kernel reads (e.g. the SysV pointer-width word) before emitting. */
static void kandelo_write_record_header(uint8_t *data, long n,
                                        uint16_t span_count,
                                        const long long *sargs) {
    kandelo_store_u32(data + KANDELO_RECORD_H_MAGIC, KANDELO_RECORD_MAGIC);
    kandelo_store_u16(data + KANDELO_RECORD_H_RECORD_ABI, KANDELO_RECORD_ABI);
    kandelo_store_u16(data + KANDELO_RECORD_H_SYSCALL, (uint16_t)n);
    kandelo_store_u16(data + KANDELO_RECORD_H_SPAN_COUNT, span_count);
    kandelo_store_u16(data + KANDELO_RECORD_H_FLAGS, 0);
    kandelo_store_u32(data + 12u, 0); /* _reserved */
    for (uint32_t si = 0; si < 6; si++) {
        /* Slot 5 carries the caller pointer width in bytes, mirroring the host
         * PROCESS_POINTER_WIDTH_ARG_INDEX injection. See kandelo_record_scalar. */
        int64_t word = (si == 5u) ? (int64_t)sizeof(void *) : (int64_t)sargs[si];
        kandelo_store_i64(data + KANDELO_RECORD_H_SCALARS + si * 8u, word);
    }
}

/* Marshal one special-layout syscall's pointer arguments into `data`.
 *
 * Returns the encoded record byte length (>= header) when `n` was marshalled
 * here; KANDELO_MARSHAL_NOT_SPECIAL when `n` is not a special family (the
 * caller emits a scalar-only record); or KANDELO_MARSHAL_FALLBACK when `n` is
 * special but cannot be self-marshalled inline yet (the caller falls back to
 * the raw-arg path). */
static long kandelo_marshal_special(long n, const long long *args_in,
                                    uint8_t *data, size_t budget) {
    long long sargs[6];
    for (int i = 0; i < 6; i++)
        sargs[i] = args_in[i];

    /* Flat (kind, arg_index, src, len) plan shared by the families whose
     * pointer args copy verbatim; msgsnd/msgrcv build their wire directly. */
    struct {
        uint8_t kind;
        uint8_t arg_index;
        const void *src;
        uint32_t len;
    } plan[KANDELO_RECORD_MAX_SPANS];
    uint32_t nplan = 0;

    switch ((uint32_t)n) {
    case KANDELO_SYS_FCNTL: {
        long long cmd = sargs[1];
        /* Advisory lock commands carry a struct flock at arg 2; every other
         * fcntl uses arg 2 (arg 3 here) as a scalar -> scalar-only record. */
        int is_getlk = (cmd == 5 || cmd == 12 || cmd == 36);
        int is_setlk = (cmd == 6 || cmd == 7 || cmd == 13 || cmd == 14
                        || cmd == 37 || cmd == 38);
        if (is_getlk || is_setlk) {
            uintptr_t p = (uintptr_t)(unsigned long long)sargs[2];
            if (p == 0)
                return KANDELO_MARSHAL_FALLBACK;
            plan[nplan].kind = is_getlk ? KANDELO_MARSHAL_SPAN_IN_OUT_PTR
                                        : KANDELO_MARSHAL_SPAN_IN_PTR;
            plan[nplan].arg_index = 2;
            plan[nplan].src = (const void *)p;
            plan[nplan].len = (uint32_t)sizeof(struct flock);
            nplan++;
        }
        break;
    }
    case KANDELO_SYS_PRCTL: {
        long long opt = sargs[0];
        /* PR_SET_NAME (15, in) / PR_GET_NAME (16, out) name a 16-byte buffer at
         * arg 1; other prctl options use the slot as a scalar. */
        if (opt == 15 || opt == 16) {
            uintptr_t p = (uintptr_t)(unsigned long long)sargs[1];
            if (p == 0)
                return KANDELO_MARSHAL_FALLBACK;
            plan[nplan].kind = (opt == 15) ? KANDELO_MARSHAL_SPAN_IN_PTR
                                           : KANDELO_MARSHAL_SPAN_OUT_PTR;
            plan[nplan].arg_index = 1;
            plan[nplan].src = (const void *)p;
            plan[nplan].len = KANDELO_MARSHAL_PRCTL_NAME_BYTES;
            nplan++;
        }
        break;
    }
    case KANDELO_SYS_EPOLL_CTL: {
        /* One input event struct at arg 3 (null for EPOLL_CTL_DEL). */
        uintptr_t p = (uintptr_t)(unsigned long long)sargs[3];
        if (p != 0) {
            plan[nplan].kind = KANDELO_MARSHAL_SPAN_IN_PTR;
            plan[nplan].arg_index = 3;
            plan[nplan].src = (const void *)p;
            plan[nplan].len = (uint32_t)sizeof(struct epoll_event);
            nplan++;
        }
        break;
    }
    case KANDELO_SYS_EPOLL_PWAIT:
    case KANDELO_SYS_EPOLL_WAIT: {
        /* Output event array at arg 1 (maxevents entries), then the optional
         * epoll_pwait sigmask at arg 4. The kernel places the mask immediately
         * after the array; emitting the array span first preserves that. */
        long long maxevents = sargs[2];
        uintptr_t ev = (uintptr_t)(unsigned long long)sargs[1];
        if (maxevents < 0)
            return KANDELO_MARSHAL_FALLBACK;
        if (ev != 0 && maxevents > 0) {
            unsigned long long len =
                (unsigned long long)maxevents * sizeof(struct epoll_event);
            if (len > 0xFFFFFFFFull)
                return KANDELO_MARSHAL_FALLBACK;
            plan[nplan].kind = KANDELO_MARSHAL_SPAN_OUT_PTR;
            plan[nplan].arg_index = 1;
            plan[nplan].src = (const void *)ev;
            plan[nplan].len = (uint32_t)len;
            nplan++;
        }
        if ((uint32_t)n == KANDELO_SYS_EPOLL_PWAIT) {
            uintptr_t mask = (uintptr_t)(unsigned long long)sargs[4];
            if (mask != 0) {
                plan[nplan].kind = KANDELO_MARSHAL_SPAN_IN_PTR;
                plan[nplan].arg_index = 4;
                plan[nplan].src = (const void *)mask;
                plan[nplan].len = (uint32_t)sizeof(uint64_t); /* SIGNAL_MASK_BYTES */
                nplan++;
            }
        }
        break;
    }
    case KANDELO_SYS_MSGCTL:
    case KANDELO_SYS_SHMCTL: {
        /* IPC control buffer at arg 2, present only for IPC_SET (1, in) and
         * IPC_STAT (2, out); other commands carry no buffer. The kernel reads
         * the caller pointer width from scalar slot 5. */
        sargs[5] = (long long)sizeof(void *);
        long long cmd = sargs[1] & ~0x100LL; /* strip IPC_64 */
        if (cmd == 1 || cmd == 2) {
            uintptr_t p = (uintptr_t)(unsigned long long)sargs[2];
            if (p == 0)
                return KANDELO_MARSHAL_FALLBACK;
            uint32_t sz = ((uint32_t)n == KANDELO_SYS_MSGCTL)
                              ? (uint32_t)sizeof(struct msqid_ds)
                              : (uint32_t)sizeof(struct shmid_ds);
            plan[nplan].kind = (cmd == 1) ? KANDELO_MARSHAL_SPAN_IN_PTR
                                          : KANDELO_MARSHAL_SPAN_OUT_PTR;
            plan[nplan].arg_index = 2;
            plan[nplan].src = (const void *)p;
            plan[nplan].len = sz;
            nplan++;
        }
        break;
    }
    case KANDELO_SYS_MSGSND: {
        /* Build the width-independent wire { i64 mtype; msgsz payload } from the
         * caller's `struct msgbuf { long mtype; char mtext[]; }` at arg 1. */
        sargs[5] = (long long)sizeof(void *);
        uintptr_t msgp = (uintptr_t)(unsigned long long)sargs[1];
        long long msgsz = sargs[2];
        if (msgp == 0 || msgsz < 0)
            return KANDELO_MARSHAL_FALLBACK;
        unsigned long long wire =
            (unsigned long long)KANDELO_MARSHAL_SYSV_MSG_HEADER_BYTES
            + (unsigned long long)msgsz;
        if (wire > 0xFFFFFFFFull)
            return KANDELO_MARSHAL_FALLBACK;
        uint32_t off = KANDELO_RECORD_HEADER_BYTES
                       + KANDELO_RECORD_SPAN_DESCRIPTOR_BYTES;
        if ((size_t)off + (size_t)wire > budget)
            return KANDELO_MARSHAL_FALLBACK;
        long mtype;
        __builtin_memcpy(&mtype, (const void *)msgp, sizeof(long));
        kandelo_store_i64(data + off, (int64_t)mtype);
        if (msgsz > 0) {
            __builtin_memcpy(data + off + KANDELO_MARSHAL_SYSV_MSG_HEADER_BYTES,
                             (const void *)(msgp + sizeof(long)), (size_t)msgsz);
        }
        uint8_t *d = data + KANDELO_RECORD_HEADER_BYTES;
        d[KANDELO_RECORD_D_KIND] = KANDELO_MARSHAL_SPAN_IN_PTR;
        d[KANDELO_RECORD_D_ARG_INDEX] = 1;
        kandelo_store_u16(d + 2u, 0);
        kandelo_store_u32(d + KANDELO_RECORD_D_OFFSET, off);
        kandelo_store_u32(d + KANDELO_RECORD_D_LEN, (uint32_t)wire);
        kandelo_write_record_header(data, n, 1, sargs);
        return (long)(off + (uint32_t)wire);
    }
    case KANDELO_SYS_MSGRCV: {
        /* Reserve the width-independent wire { i64 mtype; msgsz payload } as an
         * output buffer at arg 1; the kernel fills it and the copy-back returns
         * it (the guest converts it back to the caller's msgbuf at flip time). */
        sargs[5] = (long long)sizeof(void *);
        uintptr_t msgp = (uintptr_t)(unsigned long long)sargs[1];
        long long msgsz = sargs[2];
        if (msgp == 0 || msgsz < 0)
            return KANDELO_MARSHAL_FALLBACK;
        unsigned long long wire =
            (unsigned long long)KANDELO_MARSHAL_SYSV_MSG_HEADER_BYTES
            + (unsigned long long)msgsz;
        if (wire > 0xFFFFFFFFull)
            return KANDELO_MARSHAL_FALLBACK;
        uint32_t off = KANDELO_RECORD_HEADER_BYTES
                       + KANDELO_RECORD_SPAN_DESCRIPTOR_BYTES;
        if ((size_t)off + (size_t)wire > budget)
            return KANDELO_MARSHAL_FALLBACK;
        __builtin_memset(data + off, 0, (size_t)wire);
        uint8_t *d = data + KANDELO_RECORD_HEADER_BYTES;
        d[KANDELO_RECORD_D_KIND] = KANDELO_MARSHAL_SPAN_OUT_PTR;
        d[KANDELO_RECORD_D_ARG_INDEX] = 1;
        kandelo_store_u16(d + 2u, 0);
        kandelo_store_u32(d + KANDELO_RECORD_D_OFFSET, off);
        kandelo_store_u32(d + KANDELO_RECORD_D_LEN, (uint32_t)wire);
        kandelo_write_record_header(data, n, 1, sargs);
        return (long)(off + (uint32_t)wire);
    }
    case KANDELO_SYS_SELECT:
    case KANDELO_SYS_PSELECT6: {
        /* select(nfds, readfds, writefds, exceptfds, timeout[, sigmask]).
         * The kernel's prepare_select_record lays each present fd_set (args
         * 1..3) and the pselect6 sigmask (arg 5) at fixed disjoint offsets, so
         * the guest just emits an INOUT span per non-null fd_set (each the fixed
         * sizeof(fd_set) the kernel re-proves) and an IN span for the 8-byte
         * sigmask. The kernel dispatch reads the timeout as a scalar millisecond
         * value in a5 (word 4); the host converts it today, so the guest does it
         * here, matching that read exactly. A null timeout keeps the -1 infinite
         * sentinel the kernel already uses. */
        int is_pselect6 = ((uint32_t)n == KANDELO_SYS_PSELECT6);

        for (uint8_t fdset_arg = 1; fdset_arg <= 3; fdset_arg++) {
            uintptr_t p = (uintptr_t)(unsigned long long)sargs[fdset_arg];
            if (p == 0)
                continue; /* null fd_set: scalar 0, no span */
            plan[nplan].kind = KANDELO_MARSHAL_SPAN_IN_OUT_PTR;
            plan[nplan].arg_index = fdset_arg;
            plan[nplan].src = (const void *)p;
            plan[nplan].len = (uint32_t)sizeof(fd_set);
            nplan++;
        }

        /* Timeout -> milliseconds in word 4 (a5), from the caller's own struct
         * (timeval for select, timespec for pselect6), matching the current
         * host conversion. A null pointer means "wait forever" (-1). */
        uintptr_t tp = (uintptr_t)(unsigned long long)sargs[4];
        long long timeout_ms;
        if (tp == 0) {
            timeout_ms = -1;
        } else if (is_pselect6) {
            const struct timespec *ts = (const struct timespec *)tp;
            timeout_ms = (long long)ts->tv_sec * 1000
                         + (long long)ts->tv_nsec / 1000000;
        } else {
            const struct timeval *tv = (const struct timeval *)tp;
            timeout_ms = (long long)tv->tv_sec * 1000
                         + (long long)tv->tv_usec / 1000;
            if (timeout_ms < 0)
                timeout_ms = 0;
        }
        sargs[4] = timeout_ms;

        /* pselect6 sigmask: word 5 points at { const sigset_t *ss; size_t
         * ss_len }. The kernel reads the inner 8-byte sigset directly from word
         * 5, so emit an IN span with those bytes when a mask is present, and set
         * word 5 to 0 (no mask) otherwise. */
        if (is_pselect6) {
            /* Read the outer descriptor from the untouched inputs before
             * clearing word 5 to the "no mask" sentinel. */
            uintptr_t dp = (uintptr_t)(unsigned long long)args_in[5];
            sargs[5] = 0;
            if (dp != 0) {
                struct kandelo_pselect6_sigmask {
                    const void *ss;
                    size_t ss_len;
                } *desc = (struct kandelo_pselect6_sigmask *)dp;
                uintptr_t ss = (uintptr_t)desc->ss;
                if (ss != 0) {
                    if (desc->ss_len != 8u)
                        return KANDELO_MARSHAL_FALLBACK; /* wrong sigset size */
                    plan[nplan].kind = KANDELO_MARSHAL_SPAN_IN_PTR;
                    plan[nplan].arg_index = 5;
                    plan[nplan].src = (const void *)ss;
                    plan[nplan].len = 8u; /* SIGNAL_MASK_BYTES */
                    nplan++;
                }
            }
        }
        break;
    }
    case KANDELO_SYS_IOCTL: {
        /* ioctl(fd, request, arg): the request number selects arg's size and
         * direction. The generated kandelo_ioctl_contracts table (projected
         * from wasm_posix_shared::ioctl_contract) is the guest's source of
         * truth, since legacy request encodings (TIOCGWINSZ 0x5413, etc.) do
         * not embed their size. */
        uint32_t request = (uint32_t)sargs[1];
        const struct kandelo_ioctl_contract *c = kandelo_ioctl_lookup(request);
        if (c == (const struct kandelo_ioctl_contract *)0)
            return KANDELO_MARSHAL_FALLBACK; /* unknown request: not inline */
        if (c->arg_kind != KANDELO_IOCTL_ARG_POINTER)
            break; /* None / scalar-i32 arg: no pointer span, scalar-only */
        uint32_t size = (sizeof(void *) == 8) ? c->wasm64_size : c->wasm32_size;
        if (size == KANDELO_IOCTL_SIZE_UNSUPPORTED)
            return KANDELO_MARSHAL_FALLBACK; /* known but unsupported width */
        uintptr_t p = (uintptr_t)(unsigned long long)sargs[2];
        if (p == 0)
            return KANDELO_MARSHAL_FALLBACK; /* required buffer absent */
        uint8_t kind;
        switch (c->direction) {
        case KANDELO_IOCTL_DIR_IN:    kind = KANDELO_MARSHAL_SPAN_IN_PTR; break;
        case KANDELO_IOCTL_DIR_OUT:   kind = KANDELO_MARSHAL_SPAN_OUT_PTR; break;
        case KANDELO_IOCTL_DIR_INOUT: kind = KANDELO_MARSHAL_SPAN_IN_OUT_PTR; break;
        default: return KANDELO_MARSHAL_FALLBACK; /* pointer with no direction */
        }
        plan[nplan].kind = kind;
        plan[nplan].arg_index = 2;
        plan[nplan].src = (const void *)p;
        plan[nplan].len = size;
        nplan++;
        /* The kernel's validate_ioctl_layout re-proves arg 2 at the region base
         * from these two scalar words: arg 3 carries the buffer size and arg 5
         * the caller pointer width. */
        sargs[3] = (long long)size;
        sargs[5] = (long long)sizeof(void *);
        break;
    }
    case KANDELO_SYS_SEMCTL: {
        /* semctl(semid, semnum, cmd, arg): only GETALL (13) and SETALL (17)
         * carry a pointer buffer (the `union semun`'s `array` field) at arg 3.
         * SETVAL/GETVAL and the other commands keep arg 3 as a scalar and marshal
         * as a scalar-only record.
         *
         * ------------------------------------------------------------------
         * DESIGN DECISION (interim) -- GETALL/SETALL buffer sizing.
         *
         * The buffer size is `nsems * sizeof(unsigned short)`, where `nsems` is
         * the semaphore set's cardinality. That count is kernel state; it is NOT
         * present in the syscall arguments, and the opaque record format carries
         * no kernel-computed span length. Three options were considered:
         *   (a) the guest issues one preliminary semctl(semid, 0, IPC_STAT,&buf)
         *       to read `sem_nsems`, then sizes and marshals the buffer;
         *   (b) add a kernel-sized-span record kind the kernel fills in;
         *   (c) leave semctl GETALL/SETALL on the raw fallback path.
         * Option (a) is chosen for now: it keeps the record format uniform (a
         * plain IN/OUT span at the region base, which the kernel semctl dispatch
         * already re-proves via checked_channel_scratch_start_range) at the cost
         * of one extra IPC_STAT round-trip on the GETALL/SETALL path only. This
         * is deliberately left open to future reinterpretation as (b) or (c).
         * ------------------------------------------------------------------ */
        long long cmd = sargs[2] & ~0x100LL; /* strip IPC_64 */
        if (cmd != GETALL && cmd != SETALL)
            break; /* SETVAL/GETVAL/etc.: arg 3 stays scalar */
        uintptr_t p = (uintptr_t)(unsigned long long)sargs[3];
        if (p == 0)
            return KANDELO_MARSHAL_FALLBACK;
        /* Option (a): one preliminary IPC_STAT to read the set's cardinality.
         * This issues through the ordinary (raw-arg) syscall path -- the record
         * encoder is dormant -- so it completes before this record is built. */
        struct semid_ds ds;
        long rc = __do_syscall_impl(KANDELO_SYS_SEMCTL, sargs[0], 0, IPC_STAT,
                                    (long long)(uintptr_t)&ds, 0, 0, 0, 0);
        if (rc < 0)
            return KANDELO_MARSHAL_FALLBACK; /* surface the error via raw path */
        unsigned long long nbytes =
            (unsigned long long)ds.sem_nsems * sizeof(unsigned short);
        if (nbytes > 0xFFFFFFFFull)
            return KANDELO_MARSHAL_FALLBACK;
        plan[nplan].kind = (cmd == GETALL) ? KANDELO_MARSHAL_SPAN_OUT_PTR
                                           : KANDELO_MARSHAL_SPAN_IN_PTR;
        plan[nplan].arg_index = 3;
        plan[nplan].src = (const void *)p;
        plan[nplan].len = (uint32_t)nbytes;
        nplan++;
        break;
    }
    default:
        return KANDELO_MARSHAL_NOT_SPECIAL;
    }

    /* Emit the planned flat spans contiguously after the descriptor array. */
    uint32_t desc_end = KANDELO_RECORD_HEADER_BYTES
                        + nplan * KANDELO_RECORD_SPAN_DESCRIPTOR_BYTES;
    if (desc_end > budget)
        return KANDELO_MARSHAL_FALLBACK;
    uint32_t cursor = desc_end;
    for (uint32_t i = 0; i < nplan; i++) {
        uint32_t off = cursor;
        if (plan[i].len > 0) {
            if ((size_t)cursor + plan[i].len > budget)
                return KANDELO_MARSHAL_FALLBACK;
            __builtin_memcpy(data + cursor, plan[i].src, plan[i].len);
            cursor += plan[i].len;
        }
        uint8_t *d = data + KANDELO_RECORD_HEADER_BYTES
                     + i * KANDELO_RECORD_SPAN_DESCRIPTOR_BYTES;
        d[KANDELO_RECORD_D_KIND] = plan[i].kind;
        d[KANDELO_RECORD_D_ARG_INDEX] = plan[i].arg_index;
        kandelo_store_u16(d + 2u, 0); /* _pad */
        kandelo_store_u32(d + KANDELO_RECORD_D_OFFSET, off);
        kandelo_store_u32(d + KANDELO_RECORD_D_LEN, plan[i].len);
    }
    kandelo_write_record_header(data, n, (uint16_t)nplan, sargs);
    return (long)cursor;
}

int __marshal_channel_record(long n, long long a1, long long a2, long long a3,
                             long long a4, long long a5, long long a6,
                             void *data_base, size_t data_capacity) {
    const long long args[6] = {a1, a2, a3, a4, a5, a6};
    uint8_t *data = (uint8_t *)data_base;

    if (data_capacity < KANDELO_RECORD_HEADER_BYTES)
        return KANDELO_MARSHAL_FALLBACK;
    size_t budget = data_capacity;
    if (budget > KANDELO_RECORD_INLINE_BUDGET)
        budget = KANDELO_RECORD_INLINE_BUDGET;

    const struct kandelo_marshal_syscall *entry =
        kandelo_marshal_lookup((uint32_t)n);

    /* Header writer shared by every path. `span_count` is patched in after
     * the spans are known. */
    #define KANDELO_WRITE_HEADER(span_count) do {                              \
        kandelo_store_u32(data + KANDELO_RECORD_H_MAGIC, KANDELO_RECORD_MAGIC); \
        kandelo_store_u16(data + KANDELO_RECORD_H_RECORD_ABI,                   \
                          KANDELO_RECORD_ABI);                                  \
        kandelo_store_u16(data + KANDELO_RECORD_H_SYSCALL, (uint16_t)n);        \
        kandelo_store_u16(data + KANDELO_RECORD_H_SPAN_COUNT,                   \
                          (uint16_t)(span_count));                             \
        kandelo_store_u16(data + KANDELO_RECORD_H_FLAGS, 0);                    \
        kandelo_store_u32(data + 12u, 0); /* _reserved */                      \
        for (uint32_t si = 0; si < 6; si++) {                                  \
            int64_t kwh_word = (si == 5u)                                      \
                ? (int64_t)sizeof(void *) /* caller pointer width, slot 5 */   \
                : (int64_t)args[si];                                           \
            kandelo_store_i64(                                                 \
                data + KANDELO_RECORD_H_SCALARS + si * 8u, kwh_word);          \
        }                                                                      \
    } while (0)

    /* Not in the generated descriptor table: try the bespoke special-layout
     * families (ioctl/select/epoll/prctl/fcntl-lock/SysV IPC). A NOT_SPECIAL
     * result means there are no pointer args to marshal, so emit a scalar-only
     * record; a FALLBACK (< 0) propagates so the caller uses the raw-arg path. */
    if (entry == (const struct kandelo_marshal_syscall *)0) {
        long special = kandelo_marshal_special(n, args, data, budget);
        if (special != KANDELO_MARSHAL_NOT_SPECIAL)
            return (int)special;
        KANDELO_WRITE_HEADER(0);
        return (int)KANDELO_RECORD_HEADER_BYTES;
    }

    /* ----- Nested iovec syscalls (writev/readv/preadv/pwritev/...) ----- */
    if (entry->nested == KANDELO_MARSHAL_NESTED_IOVEC) {
        const struct kandelo_marshal_arg *ma = &entry->args[0];
        uintptr_t iov_ptr = (uintptr_t)(unsigned long long)args[ma->arg_index];
        long long cnt = args[ma->a]; /* iovcnt */
        if (iov_ptr == 0 || cnt <= 0) {
            KANDELO_WRITE_HEADER(0);
            return (int)KANDELO_RECORD_HEADER_BYTES;
        }
        if ((unsigned long long)cnt > KANDELO_RECORD_MAX_IOVEC)
            return KANDELO_MARSHAL_FALLBACK;
        const struct iovec *iov = (const struct iovec *)iov_ptr;

        uint32_t desc_end =
            KANDELO_RECORD_HEADER_BYTES + KANDELO_RECORD_SPAN_DESCRIPTOR_BYTES;
        uint32_t region_off = desc_end;
        uint32_t struct_len = 4u + (uint32_t)cnt * KANDELO_RECORD_IOVEC_ENTRY_BYTES;
        uint32_t buffers_base = region_off + struct_len;
        if (buffers_base > budget)
            return KANDELO_MARSHAL_FALLBACK;

        /* count word */
        kandelo_store_u32(data + region_off + KANDELO_RECORD_IOVEC_COUNT_OFFSET,
                          (uint32_t)cnt);
        uint32_t cursor = buffers_base;
        for (long long i = 0; i < cnt; i++) {
            uint32_t blen = (uint32_t)iov[i].iov_len;
            uint32_t entry_pos = region_off + KANDELO_RECORD_IOVEC_ENTRIES_OFFSET +
                                 (uint32_t)i * KANDELO_RECORD_IOVEC_ENTRY_BYTES;
            kandelo_store_u32(data + entry_pos, cursor);      /* buf_off */
            kandelo_store_u32(data + entry_pos + 4u, blen);   /* buf_len */
            if (blen > 0) {
                if ((size_t)cursor + blen > budget)
                    return KANDELO_MARSHAL_FALLBACK;
                __builtin_memcpy(data + cursor, iov[i].iov_base, blen);
                cursor += blen;
            }
        }
        uint32_t region_len = cursor - region_off;
        /* descriptor */
        uint8_t *d = data + KANDELO_RECORD_HEADER_BYTES;
        d[KANDELO_RECORD_D_KIND] = KANDELO_MARSHAL_SPAN_IOVEC_ARRAY;
        d[KANDELO_RECORD_D_ARG_INDEX] = ma->arg_index;
        kandelo_store_u16(d + 2u, 0); /* _pad */
        kandelo_store_u32(d + KANDELO_RECORD_D_OFFSET, region_off);
        kandelo_store_u32(d + KANDELO_RECORD_D_LEN, region_len);
        KANDELO_WRITE_HEADER(1);
        return (int)cursor;
    }

    /* ----- Nested msghdr syscalls (sendmsg/recvmsg) ----- */
    if (entry->nested == KANDELO_MARSHAL_NESTED_MSGHDR) {
        const struct kandelo_marshal_arg *ma = &entry->args[0];
        uintptr_t msg_ptr = (uintptr_t)(unsigned long long)args[ma->arg_index];
        if (msg_ptr == 0) {
            KANDELO_WRITE_HEADER(0);
            return (int)KANDELO_RECORD_HEADER_BYTES;
        }
        const struct msghdr *m = (const struct msghdr *)msg_ptr;
        uint32_t name_len = (uint32_t)m->msg_namelen;
        uint32_t control_len = (uint32_t)m->msg_controllen;
        uint32_t flags = (uint32_t)m->msg_flags;

        /* The canonical wire the kernel reconstructs holds at most one iovec
         * (KERNEL_MESSAGE_WIRE_FLATTENED_IOVEC_COUNT == 1), so flatten the
         * scatter/gather list into a single contiguous buffer. */
        const struct iovec *iov = (const struct iovec *)(uintptr_t)m->msg_iov;
        long iovlen = (long)m->msg_iovlen;
        uint32_t total = 0;
        for (long i = 0; i < iovlen; i++)
            total += (uint32_t)iov[i].iov_len;
        uint32_t iov_count = (iovlen > 0) ? 1u : 0u;

        uint32_t desc_end =
            KANDELO_RECORD_HEADER_BYTES + KANDELO_RECORD_SPAN_DESCRIPTOR_BYTES;
        uint32_t region_off = desc_end;
        uint32_t struct_len =
            KANDELO_RECORD_MSGHDR_IOVEC_BLOCK_OFFSET /* name_off + name_len */
            + 4u + iov_count * KANDELO_RECORD_IOVEC_ENTRY_BYTES /* iovec block */
            + 12u; /* control_off + control_len + flags */
        uint32_t ref_base = region_off + struct_len;
        if (ref_base > budget)
            return KANDELO_MARSHAL_FALLBACK;

        /* Referenced payloads laid in the order the decoder walks them: name,
         * flattened iovec buffer, control. */
        uint32_t cursor = ref_base;
        uint32_t name_off = 0;
        if (name_len > 0) {
            if ((size_t)cursor + name_len > budget)
                return KANDELO_MARSHAL_FALLBACK;
            name_off = cursor;
            __builtin_memcpy(data + cursor, (const void *)(uintptr_t)m->msg_name,
                             name_len);
            cursor += name_len;
        }

        uint32_t iov_buf_off = cursor;
        if (iov_count == 1) {
            if ((size_t)cursor + total > budget)
                return KANDELO_MARSHAL_FALLBACK;
            uint32_t w = cursor;
            for (long i = 0; i < iovlen; i++) {
                uint32_t seg = (uint32_t)iov[i].iov_len;
                if (seg > 0) {
                    __builtin_memcpy(data + w, iov[i].iov_base, seg);
                    w += seg;
                }
            }
            cursor += total;
        }

        uint32_t control_off = 0;
        if (control_len > 0) {
            if ((size_t)cursor + control_len > budget)
                return KANDELO_MARSHAL_FALLBACK;
            control_off = cursor;
            __builtin_memcpy(data + cursor,
                             (const void *)(uintptr_t)m->msg_control, control_len);
            cursor += control_len;
        }

        /* Structural prefix. */
        kandelo_store_u32(data + region_off + KANDELO_RECORD_MSGHDR_NAME_OFF_OFFSET,
                          name_off);
        kandelo_store_u32(data + region_off + KANDELO_RECORD_MSGHDR_NAME_LEN_OFFSET,
                          name_len);
        uint32_t block_off = region_off + KANDELO_RECORD_MSGHDR_IOVEC_BLOCK_OFFSET;
        kandelo_store_u32(data + block_off + KANDELO_RECORD_IOVEC_COUNT_OFFSET,
                          iov_count);
        if (iov_count == 1) {
            uint32_t ep = block_off + KANDELO_RECORD_IOVEC_ENTRIES_OFFSET;
            kandelo_store_u32(data + ep, iov_buf_off);
            kandelo_store_u32(data + ep + 4u, total);
        }
        uint32_t tail = block_off + 4u + iov_count * KANDELO_RECORD_IOVEC_ENTRY_BYTES;
        kandelo_store_u32(data + tail, control_off);
        kandelo_store_u32(data + tail + 4u, control_len);
        kandelo_store_u32(data + tail + 8u, flags);

        /* descriptor: len is the structural prefix only (not the payloads). */
        uint8_t *d = data + KANDELO_RECORD_HEADER_BYTES;
        d[KANDELO_RECORD_D_KIND] = KANDELO_MARSHAL_SPAN_MSGHDR;
        d[KANDELO_RECORD_D_ARG_INDEX] = ma->arg_index;
        kandelo_store_u16(d + 2u, 0);
        kandelo_store_u32(d + KANDELO_RECORD_D_OFFSET, region_off);
        kandelo_store_u32(d + KANDELO_RECORD_D_LEN, struct_len);
        KANDELO_WRITE_HEADER(1);
        return (int)cursor;
    }

    /* ----- Flat descriptor-table syscalls ----- */
    struct {
        uint8_t kind;
        uint8_t arg_index;
        uintptr_t src;
        uint32_t len;
    } plan[KANDELO_RECORD_MAX_SPANS];
    uint32_t nplan = 0;

    for (uint8_t i = 0; i < entry->arg_count; i++) {
        const struct kandelo_marshal_arg *arg = &entry->args[i];
        uintptr_t ptr = (uintptr_t)(unsigned long long)args[arg->arg_index];
        if (ptr == 0)
            continue; /* null pointer -> omit the span (nullable/degenerate) */
        long len = kandelo_marshal_arg_len(arg, args, ptr);
        if (len < 0)
            return KANDELO_MARSHAL_FALLBACK;
        /* The span bytes are read from (IN/InOut) or reserved at (OUT) this
         * caller pointer; an out-of-range pointer must fall back to the raw
         * path so the kernel returns EFAULT instead of trapping the encoder. */
        if (!kandelo_range_in_bounds(ptr, (uint64_t)len))
            return KANDELO_MARSHAL_FALLBACK;
        if (nplan >= KANDELO_RECORD_MAX_SPANS)
            return KANDELO_MARSHAL_FALLBACK;
        plan[nplan].kind = arg->span_kind;
        plan[nplan].arg_index = arg->arg_index;
        plan[nplan].src = ptr;
        plan[nplan].len = (uint32_t)len;
        nplan++;
    }

    uint32_t desc_end = KANDELO_RECORD_HEADER_BYTES +
                        nplan * KANDELO_RECORD_SPAN_DESCRIPTOR_BYTES;
    if (desc_end > budget)
        return KANDELO_MARSHAL_FALLBACK;
    uint32_t cursor = desc_end;
    for (uint32_t i = 0; i < nplan; i++) {
        uint32_t off = cursor;
        if (plan[i].len > 0) {
            if ((size_t)cursor + plan[i].len > budget)
                return KANDELO_MARSHAL_FALLBACK;
            __builtin_memcpy(data + cursor, (const void *)plan[i].src, plan[i].len);
            cursor += plan[i].len;
        }
        uint8_t *d = data + KANDELO_RECORD_HEADER_BYTES +
                     i * KANDELO_RECORD_SPAN_DESCRIPTOR_BYTES;
        d[KANDELO_RECORD_D_KIND] = plan[i].kind;
        d[KANDELO_RECORD_D_ARG_INDEX] = plan[i].arg_index;
        kandelo_store_u16(d + 2u, 0); /* _pad */
        kandelo_store_u32(d + KANDELO_RECORD_D_OFFSET, off);
        kandelo_store_u32(d + KANDELO_RECORD_D_LEN, plan[i].len);
    }
    KANDELO_WRITE_HEADER(nplan);
    #undef KANDELO_WRITE_HEADER
    return (int)cursor;
}

/* True when `n` keeps raw args in Phase 2 (never a record). The generated
 * kandelo_raw_syscalls table is sorted ascending; the set is tiny, so a linear
 * scan is fine on this pre-dispatch path. Single source of truth:
 * wasm_posix_shared::host_raw_syscalls (mirrored in host abi.ts). */
static int kandelo_syscall_is_raw(long n) {
    uint32_t needle = (uint32_t)n;
    for (uint32_t i = 0; i < KANDELO_RAW_SYSCALL_COUNT; i++) {
        if (kandelo_raw_syscalls[i] == needle)
            return 1;
        if (kandelo_raw_syscalls[i] > needle)
            break; /* sorted ascending */
    }
    return 0;
}

/* Copy each OUT / InOut flat span's result bytes back into the caller's
 * original pointer arg.
 *
 * The kernel reconstructs its scratch layout IN PLACE over the record region,
 * so after completion the record's header and descriptors in the data buffer
 * are destroyed. The kernel does, however, write each OUT/InOut result back at
 * the span's ORIGINAL byte offset (channel_dest = region_start + offset). So the
 * guest must supply the span descriptors it saved BEFORE issuing the syscall,
 * and read the results from the live data buffer at those saved offsets — it can
 * never re-read the (overwritten) descriptors from the buffer.
 *
 * FLAT ONLY: the nested iovec/msghdr syscalls are all in the RAW set, so a live
 * record never carries a nested span. IN_PTR / PATH_STR spans are guest->kernel
 * only and are skipped here. `data` points at the data buffer base (channel base
 * + CH_DATA); saved span offsets are relative to that base. `saved_descriptors`
 * is the descriptor block copied out of the record before the syscall. */
static void __unmarshal_channel_record(const uint8_t *data,
                                       const uint8_t *saved_descriptors,
                                       uint16_t span_count,
                                       const long long *args) {
    for (uint16_t i = 0; i < span_count; i++) {
        const uint8_t *d = saved_descriptors
                           + (uint32_t)i * KANDELO_RECORD_SPAN_DESCRIPTOR_BYTES;
        uint8_t kind = d[KANDELO_RECORD_D_KIND];
        if (kind != KANDELO_MARSHAL_SPAN_OUT_PTR &&
            kind != KANDELO_MARSHAL_SPAN_IN_OUT_PTR)
            continue;
        uint8_t arg_index = d[KANDELO_RECORD_D_ARG_INDEX];
        if (arg_index >= 6u)
            continue;
        uint32_t offset;
        uint32_t len;
        __builtin_memcpy(&offset, d + KANDELO_RECORD_D_OFFSET, sizeof offset);
        __builtin_memcpy(&len, d + KANDELO_RECORD_D_LEN, sizeof len);
        uintptr_t dst = (uintptr_t)(unsigned long long)args[arg_index];
        if (dst == 0 || len == 0)
            continue;
        __builtin_memcpy((void *)dst, data + offset, (size_t)len);
    }
}

/* ------------------------------------------------------------------ */
/* Central dispatch — writes to channel and blocks for result          */
/* ------------------------------------------------------------------ */

static long __do_syscall_impl(long n, long long a1, long long a2, long long a3,
                              long long a4, long long a5, long long a6,
                              int cancellation_point,
                              uint32_t extra_request_flags)
{
    struct timespec kandelo_ppoll_deadline;
    struct timespec kandelo_ppoll_remaining_timeout;
    int kandelo_ppoll_has_deadline = kandelo_capture_ppoll_deadline(
        n,
        a3,
        &kandelo_ppoll_deadline
    );
    /* Fork/vfork are handled by fork()/_Fork()/vfork() overrides above,
     * which call kernel_fork(mode) directly.  If we somehow get here (e.g. a
     * program calls __syscall(SYS_fork) directly), return ENOSYS because
     * fork instrumentation cannot save the call stack through the channel path. */
    if (n == SYS_FORK || n == SYS_VFORK) {
        return -38; /* ENOSYS */
    }

    /* Per-thread exit is non-returning. Route it through the dedicated import
     * so worker-main can record the status and unwind the Wasm entry after the
     * channel completes. Returning through the generic channel path lets
     * musl's mandatory SYS_exit retry loop park a second time on a channel the
     * host has already removed, leaving a stale waiter when the pthread slot is
     * reused. Keep exit_group on the generic path: the host must see that
     * distinct syscall so exit() from a pthread still terminates the process. */
    if (n == SYS_EXIT) {
        kernel_exit((int32_t)a1);
    }

#if __SIZEOF_POINTER__ == 8
    struct kandelo_sigaction_wire sigaction_in_wire;
    struct kandelo_sigaction_wire sigaction_out_wire;
    uintptr_t sigaction_old_guest = 0;
    int translate_sigaction = n == SYS_SIGACTION;

    if (translate_sigaction) {
        const uintptr_t memory_bytes =
            (uintptr_t)__builtin_wasm_memory_size(0) * 65536u;
        if (a2 != 0) {
            const uintptr_t act = (uintptr_t)a2;
            if (act > memory_bytes || 24u > memory_bytes - act)
                return -EFAULT;

            uint64_t handler;
            uint64_t flags;
            __builtin_memcpy(&handler, (const void *)act, sizeof(handler));
            __builtin_memcpy(&flags, (const void *)(act + 8), sizeof(flags));
            __builtin_memcpy(
                &sigaction_in_wire.mask,
                (const void *)(act + 16),
                sizeof(sigaction_in_wire.mask)
            );
            if (handler > UINT32_MAX || flags > UINT32_MAX)
                return -EINVAL;
            sigaction_in_wire.handler = (uint32_t)handler;
            sigaction_in_wire.flags = (uint32_t)flags;
            a2 = (long long)(uintptr_t)&sigaction_in_wire;
        }
        if (a3 != 0) {
            sigaction_old_guest = (uintptr_t)a3;
            if (sigaction_old_guest > memory_bytes ||
                24u > memory_bytes - sigaction_old_guest)
                return -EFAULT;
            __builtin_memset(&sigaction_out_wire, 0, sizeof(sigaction_out_wire));
            a3 = (long long)(uintptr_t)&sigaction_out_wire;
        }
    }
#endif

    /* IMPORTANT: In multi-threaded wasm programs (like BEAM), all threads
     * share the same linear memory. The compiler may spill local variables
     * to the shadow stack (linear memory). If another thread's pointer
     * arithmetic overwrites the shadow stack, spilled values get corrupted.
     *
     * To avoid this, we use get_channel_base() (inline asm: global.get)
     * at each point where we need the channel base, rather than caching it
     * in a local variable that might be spilled to the shadow stack.
     * The wasm global is per-instance and immune to cross-thread corruption. */

    uintptr_t base;
    long result;
    int32_t err;
    uint32_t delivered_flags;
    int delivered_signal;
    int used_record;
    /* Span descriptors saved from the record BEFORE the syscall: the kernel
     * overwrites the record region with its scratch layout, so the OUT/InOut
     * copy-back can only rely on descriptors captured here. */
    uint16_t saved_span_count = 0;
    uint8_t saved_descriptors[KANDELO_RECORD_MAX_SPANS
                              * KANDELO_RECORD_SPAN_DESCRIPTOR_BYTES];

restart_wait_syscall:
    base = get_channel_base();

    /* Phase 2 opaque transport (Option A). A non-RAW syscall self-marshals its
     * pointer arguments into a channel record at CH_DATA; the host transports
     * that region blindly and the kernel decodes it. RAW syscalls keep raw args
     * because the host owns their capability or blocking behaviour. On a record
     * marshal fallback (< 0) — an unmarshallable shape — fall back to raw args
     * for this attempt. Recomputed each retry so a modified arg (e.g. a
     * restarted deadline) re-marshals; RAW blocking syscalls own all retries. */
    used_record = 0;
    if (!kandelo_syscall_is_raw(n)) {
        int rlen = __marshal_channel_record(
            n, a1, a2, a3, a4, a5, a6,
            (void *)(uintptr_t)(base + CH_DATA), CH_DATA_SIZE);
        if (rlen >= 0) {
            /* Only take the record path when there is at least one pointer span
             * to move off the host. A scalar-only syscall (e.g. getpid, close)
             * gains nothing from the record transport, so keep it on the raw
             * path — the host descriptor path handles it trivially, and this
             * avoids exercising the record transport for the trivial syscalls
             * that dominate fork-child startup. */
            uint16_t span_count;
            __builtin_memcpy(
                &span_count,
                (const void *)(uintptr_t)(base + CH_DATA
                                          + KANDELO_RECORD_H_SPAN_COUNT),
                sizeof span_count);
            if (span_count > 0 && span_count <= KANDELO_RECORD_MAX_SPANS) {
                used_record = 1;
                /* Save the descriptor block before the kernel overwrites the
                 * record region with its scratch layout. */
                saved_span_count = span_count;
                __builtin_memcpy(
                    saved_descriptors,
                    (const void *)(uintptr_t)(base + CH_DATA
                                              + KANDELO_RECORD_HEADER_BYTES),
                    (size_t)span_count * KANDELO_RECORD_SPAN_DESCRIPTOR_BYTES);
            }
        }
    }

    /* Write syscall number and arguments directly using base offsets.
     * These are one-shot writes — if the shadow stack value of 'base' is
     * corrupted after these writes, it doesn't matter because we re-read
     * the global for the atomic operations below.
     * Args are written as i64 — on wasm32, long long values are sign-extended
     * from 32-bit long; on wasm64, they are native 64-bit.
     *
     * The raw arg words are always published: they drive the host's syscall
     * diagnostics/logging and are harmless on the record path (there the kernel
     * reads args from the record, not these words). The record-vs-raw decision
     * travels in the header via CH_REQUEST_FLAG_OPAQUE_RECORD (written below),
     * never via a data-buffer magic, which a fork child or reused channel slot
     * could inherit stale. */
    *(int32_t *)(uintptr_t)(base + CH_SYSCALL) = (int32_t)n;
    *(int64_t *)(uintptr_t)(base + CH_ARGS + 0 * CH_ARG_SIZE) = (int64_t)a1;
    *(int64_t *)(uintptr_t)(base + CH_ARGS + 1 * CH_ARG_SIZE) = (int64_t)a2;
    *(int64_t *)(uintptr_t)(base + CH_ARGS + 2 * CH_ARG_SIZE) = (int64_t)a3;
    *(int64_t *)(uintptr_t)(base + CH_ARGS + 3 * CH_ARG_SIZE) = (int64_t)a4;
    *(int64_t *)(uintptr_t)(base + CH_ARGS + 4 * CH_ARG_SIZE) = (int64_t)a5;
    *(int64_t *)(uintptr_t)(base + CH_ARGS + 5 * CH_ARG_SIZE) = (int64_t)a6;
    /* WHY: syscall number alone cannot distinguish a public cancellation
     * point from an internal plain syscall using the same number (for example
     * waitpid and wait4). Publish the call-site identity before the
     * release-ordered PENDING store. The host consumes and clears it with this
     * request, so mailbox reuse cannot inherit cancellation authority. */
    uint32_t request_flags = extra_request_flags;
    /* Publish the opaque-record transport decision in the header, fresh every
     * request, so a fork child or reused channel slot inheriting a stale record
     * magic in the data buffer cannot misroute a RAW syscall. */
    if (used_record)
        request_flags |= CH_REQUEST_FLAG_OPAQUE_RECORD;
    if (cancellation_point) {
        request_flags |= CH_REQUEST_FLAG_CANCELLATION_POINT;
        /*
         * WHY: the host cannot inspect musl's private pthread state. Freeze
         * whether this exact cancellation point may be woken before PENDING
         * is published. A disabled target keeps the operation and any finite
         * deadline intact while pthread_cancel remains pending.
         */
        if (__syscall_cp_cancel_wake_allowed())
            request_flags |= CH_REQUEST_FLAG_CANCELLATION_WAKE_ALLOWED;
    }
    *(uint32_t *)(uintptr_t)(base + CH_REQUEST_FLAGS) = request_flags;

    /* Set status to PENDING and wake the kernel worker.
     * Use inline asm to read __channel_base directly from the wasm global,
     * bypassing any shadow stack spills that might be corrupted. */
    {
        uintptr_t addr;
        __asm__ volatile(
            "global.get __channel_base\n"
            "local.set %0"
            : "=r"(addr)
        );
        __c11_atomic_store((_Atomic int32_t *)(uintptr_t)(addr + CH_STATUS),
                           CH_PENDING, __ATOMIC_SEQ_CST);
        __builtin_wasm_memory_atomic_notify(
            (int32_t *)(uintptr_t)(addr + CH_STATUS), 1);
    }

    /* Block until the kernel sets status to COMPLETE or ERROR.
     * CRITICAL: Re-read __channel_base from the wasm global on every
     * iteration. The compiler at -O0 would spill the address to the
     * shadow stack, where cross-thread memory writes can corrupt it.
     * Reading from the global (a per-instance register) is immune. */
    {
        int wait_ret;
        do {
            uintptr_t addr;
            __asm__ volatile(
                "global.get __channel_base\n"
                "local.set %0"
                : "=r"(addr)
            );
            wait_ret = __builtin_wasm_memory_atomic_wait32(
                (int32_t *)(uintptr_t)(addr + CH_STATUS), CH_PENDING, -1);
        } while (wait_ret == 0);
    }

    /* Read result — re-read base from global for safety */
    base = get_channel_base();

    /* Host-driven thread reclamation (execve-abandon / fork-replay /
     * spawn-rollback): the pump published TEARDOWN + notified us precisely
     * to unwind this thread WITHOUT resuming the (now-doomed or superseded)
     * image. Do not read results or return to the caller. Trap so wasmtime
     * unwinds the stack and the host OS thread exits, dropping its Store +
     * SharedMemory. Inert until a host reclaims a channel: no pump writes
     * CH_TEARDOWN today. */
    if (__c11_atomic_load((_Atomic int32_t *)(uintptr_t)(base + CH_STATUS),
            __ATOMIC_SEQ_CST) == CH_TEARDOWN) {
        __builtin_trap();
    }

    result = (long)*(int64_t *)(uintptr_t)(base + CH_RETURN);
    err = *(int32_t *)(uintptr_t)(base + CH_ERRNO);

    /* Reset status to IDLE for next syscall */
    __c11_atomic_store((_Atomic int32_t *)(uintptr_t)(base + CH_STATUS),
                       CH_IDLE, __ATOMIC_SEQ_CST);

    /* Record path: copy each OUT/InOut span's result bytes back to the caller's
     * pointer arg. On error the kernel produced no fresh output, so leave the
     * caller buffers untouched, matching the host's success-only copy-out. */
    if (used_record && err == 0) {
        const long long uargs[6] = {a1, a2, a3, a4, a5, a6};
        __unmarshal_channel_record(
            (const uint8_t *)(uintptr_t)(base + CH_DATA),
            saved_descriptors, saved_span_count, uargs);
    }

#if __SIZEOF_POINTER__ == 8
    if (translate_sigaction && sigaction_old_guest != 0 && err == 0) {
        const uint64_t handler = sigaction_out_wire.handler;
        const uint64_t flags = sigaction_out_wire.flags;
        __builtin_memcpy(
            (void *)sigaction_old_guest,
            &handler,
            sizeof(handler)
        );
        __builtin_memcpy(
            (void *)(sigaction_old_guest + 8),
            &flags,
            sizeof(flags)
        );
        __builtin_memcpy(
            (void *)(sigaction_old_guest + 16),
            &sigaction_out_wire.mask,
            sizeof(sigaction_out_wire.mask)
        );
    }
#endif

    /* Check for pending signal delivery from the kernel.
     * The kernel writes signal info to CH_SIG_* after each syscall if
     * a Handler signal is deliverable. We invoke the handler here,
     * synchronously before returning to the caller, matching POSIX
     * semantics (raise() doesn't return until signal handler completes). */
    delivered_flags = __deliver_pending_signal(
        get_channel_base(),
        &delivered_signal
    );

    /* A host-deferred blocking operation or slow PCM drain completes the
     * channel with EINTR so the caught handler runs at the real interruption
     * boundary. SA_RESTART resubmits only explicitly classified zero-progress
     * operations after handler mask restoration and cancellation preflight.
     * An interrupted final /dev/dsp close deliberately remains non-restarted:
     * its fd stays valid for an explicit caller retry. */
    if (err == EINTR && delivered_signal &&
        (delivered_flags & SA_RESTART) != 0 &&
        kandelo_should_restart_after_handler(n, a1, a2, a3, a4, a5, a6)) {
        /* __syscall_cp's outer cancellation check has not run yet. A signal
         * handler may have enabled a cancellation that was already pending,
         * or the host may have used this EINTR completion to wake a canceled
         * stopped waiter. Honor that cancellation before submitting another
         * indefinite wait. MASKED cancellation returns -ECANCELED; enabled
         * cancellation exits through pthread_exit. */
        if (cancellation_point) {
            long checked = __syscall_cp_check(-(long)EINTR);
            if (checked != -(long)EINTR) {
                kandelo_finish_interrupted_mask_wait(n, a4, a6);
                return checked;
            }
        }
        if (kandelo_ppoll_has_deadline) {
            kandelo_ppoll_remaining(
                &kandelo_ppoll_deadline,
                &kandelo_ppoll_remaining_timeout
            );
            a3 = (long long)(uintptr_t)&kandelo_ppoll_remaining_timeout;
        }
        goto restart_wait_syscall;
    }

    if (err == EINTR && delivered_signal) {
        kandelo_finish_interrupted_mask_wait(n, a4, a6);
    }

    /* Return in musl's expected format: negative errno on error.
     * musl's __syscall_ret() converts this to set errno and return -1. */
    if (err) {
        return -(long)err;
    }
    return result;
}

static long __do_syscall(long n, long long a1, long long a2, long long a3,
                         long long a4, long long a5, long long a6)
{
    return __do_syscall_impl(n, a1, a2, a3, a4, a5, a6, 0, 0u);
}

/* ================================================================== */
/* Public __syscallN entry points — musl calls these                   */
/* ================================================================== */

long __syscall0(long n)
{
    return __do_syscall(n, 0, 0, 0, 0, 0, 0);
}

long __syscall1(long n, long long a1)
{
    return __do_syscall(n, a1, 0, 0, 0, 0, 0);
}

long __syscall2(long n, long long a1, long long a2)
{
    return __do_syscall(n, a1, a2, 0, 0, 0, 0);
}

long __syscall3(long n, long long a1, long long a2, long long a3)
{
    return __do_syscall(n, a1, a2, a3, 0, 0, 0);
}

long __syscall4(long n, long long a1, long long a2, long long a3, long long a4)
{
    return __do_syscall(n, a1, a2, a3, a4, 0, 0);
}

long __syscall5(long n, long long a1, long long a2, long long a3, long long a4, long long a5)
{
    return __do_syscall(n, a1, a2, a3, a4, a5, 0);
}

long __syscall6(long n, long long a1, long long a2, long long a3, long long a4, long long a5,
                long long a6)
{
    return __do_syscall(n, a1, a2, a3, a4, a5, a6);
}

/* Deferred cancellation.
 *
 * Stock musl dispatches cancellation-point syscalls through
 * __syscall_cp_asm, an arch-specific trampoline that the SIGCANCEL
 * handler can interrupt and re-direct to __cp_cancel.  Wasm has no
 * equivalent, so we implement deferred cancellation on the guest side:
 * libc/musl-overlay/src/thread/wasm32posix/pthread_cancel.c provides
 * __syscall_cp_cancel_preflight and __syscall_cp_check (the
 * one-function moral equivalent of stock __syscall_cp_asm +
 * __syscall_cp_c).  We invoke them here around the blocking dispatch.
 *
 * - Pre-dispatch: enabled cancellation exits before dispatch; MASKED
 *   cancellation returns ECANCELED so condition waits can relock first;
 *   DISABLE leaves the operation live.
 * - Post-dispatch: __syscall_cp_check(r) — if cancellation arrived
 *   while we were blocked (host woke us with -EINTR on cancel), this
 *   either calls pthread_exit (ENABLE state) or synthesizes
 *   -ECANCELED (MASKED state, used inside pthread_cond_wait so it can
 *   reacquire the mutex and then trigger the actual exit).
 *
 * Non-cancel-point syscalls (the __syscall_N entries) deliberately
 * skip this — POSIX reserves cancellation for the specific
 * cancellation-point functions.  Only __syscall_cp threads it.
 *
 * Async cancellation of a pure-CPU loop is not supported: there is no
 * wasm facility to preempt a running thread mid-computation.
 */
extern long __syscall_cp_cancel_preflight(void);

long __syscall_cp(long n, long long a1, long long a2, long long a3,
                  long long a4, long long a5, long long a6)
{
    long pending = __syscall_cp_cancel_preflight();
    if (pending) return pending;
    long r = __do_syscall_impl(n, a1, a2, a3, a4, a5, a6, 1, 0u);
    return __syscall_cp_check(r);
}

#ifdef __cplusplus
}
#endif
