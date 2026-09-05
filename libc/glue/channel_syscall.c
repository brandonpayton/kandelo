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
#include <bits/kandelo_channel_scalars.h>
#include <bits/kandelo_process_layouts.h>
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
#define CH_STATUS      WASM_POSIX_CHANNEL_STATUS_OFFSET
#define CH_SYSCALL     WASM_POSIX_CHANNEL_SYSCALL_OFFSET
#define CH_ARGS        WASM_POSIX_CHANNEL_ARGS_OFFSET
#define CH_ARG_SIZE    WASM_POSIX_CHANNEL_ARG_SIZE
#define CH_RETURN      WASM_POSIX_CHANNEL_RETURN_OFFSET
#define CH_ERRNO       WASM_POSIX_CHANNEL_ERRNO_OFFSET
#define CH_REQUEST_FLAGS WASM_POSIX_CHANNEL_REQUEST_FLAGS_OFFSET
#define CH_REQUEST_FLAG_CANCELLATION_POINT \
    WASM_POSIX_CHANNEL_REQUEST_FLAG_CANCELLATION_POINT
#define CH_REQUEST_FLAG_CANCELLATION_WAKE_ALLOWED \
    WASM_POSIX_CHANNEL_REQUEST_FLAG_CANCELLATION_WAKE_ALLOWED
#define CH_REQUEST_FLAG_DEFER_SIGNAL_DELIVERY \
    WASM_POSIX_CHANNEL_REQUEST_FLAG_DEFER_SIGNAL_DELIVERY
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
#define CH_CHECKPOINT_REQUEST WASM_POSIX_CHANNEL_CHECKPOINT_REQUEST_OFFSET

_Static_assert(WASM_POSIX_CHANNEL_ARGS_COUNT == 6u,
               "channel syscall glue requires six argument slots");
_Static_assert(WASM_POSIX_CHANNEL_REQUEST_FLAGS_SIZE == sizeof(uint32_t),
               "channel request flags must remain one u32");
_Static_assert(
    WASM_POSIX_CHANNEL_REQUEST_FLAGS_KNOWN_MASK
        == (WASM_POSIX_CHANNEL_REQUEST_FLAG_CANCELLATION_POINT
            | WASM_POSIX_CHANNEL_REQUEST_FLAG_CANCELLATION_WAKE_ALLOWED
            | WASM_POSIX_CHANNEL_REQUEST_FLAG_DEFER_SIGNAL_DELIVERY),
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
_Static_assert(WASM_POSIX_CHANNEL_CHECKPOINT_BASE_OFFSET
                       + WASM_POSIX_CHANNEL_CHECKPOINT_AREA_SIZE
                   == WASM_POSIX_CHANNEL_SIG_BASE_OFFSET,
               "checkpoint request area must sit directly below the signal area");
_Static_assert(WASM_POSIX_CHANNEL_CHECKPOINT_REQUEST_OFFSET
                       + WASM_POSIX_CHANNEL_CHECKPOINT_WIRE_SIZE
                   <= WASM_POSIX_CHANNEL_SIG_BASE_OFFSET,
               "checkpoint request word must not reach into the signal area");
_Static_assert(sizeof(uint32_t) == WASM_POSIX_CHANNEL_CHECKPOINT_WIRE_SIZE,
               "checkpoint request word width must match generated ABI");

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

/* Checkpoint — the migration unwind boundary, seeded exactly like kernel_fork.
 *
 * Unlike kernel_fork this IS reached from the syscall dispatcher, deliberately.
 * A checkpoint must unwind the whole call stack, so seeding the instrumenter
 * from here is what gives it every function that can be live at a syscall
 * return. Programs that never fork, such as fbDOOM, have no other seed.
 *
 * The capture pass does not return: the frames unwind into linear memory. The
 * only return the guest ever observes comes from a rewind, which is why the
 * value distinguishes a resumed-in-place process from a restored one. */
__attribute__((import_module("kernel"), import_name("kernel_checkpoint")))
int32_t kernel_checkpoint(void);

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

static void __take_pending_checkpoint(uintptr_t base)
{
    uint32_t *request_ptr = (uint32_t *)(uintptr_t)(base + CH_CHECKPOINT_REQUEST);

    if (*request_ptr == 0) return;

    /* Clear before the call, never after. The capture pass unwinds instead of
     * returning, so a clear placed after it never runs, and the restored
     * process would read the request again and checkpoint itself forever. */
    *request_ptr = 0;
    (void)kernel_checkpoint();
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

restart_wait_syscall:
    base = get_channel_base();

    /* Write syscall number and arguments directly using base offsets.
     * These are one-shot writes — if the shadow stack value of 'base' is
     * corrupted after these writes, it doesn't matter because we re-read
     * the global for the atomic operations below.
     * Args are written as i64 — on wasm32, long long values are sign-extended
     * from 32-bit long; on wasm64, they are native 64-bit. */
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
    result = (long)*(int64_t *)(uintptr_t)(base + CH_RETURN);
    err = *(int32_t *)(uintptr_t)(base + CH_ERRNO);

    /* Reset status to IDLE for next syscall */
    __c11_atomic_store((_Atomic int32_t *)(uintptr_t)(base + CH_STATUS),
                       CH_IDLE, __ATOMIC_SEQ_CST);

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

    /* Take a pending checkpoint before the restart block below. A frozen
     * process must unwind here rather than resubmit a blocking syscall it
     * would then park on, leaving the keeper waiting for an unwind that
     * cannot arrive. */
    __take_pending_checkpoint(get_channel_base());

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
