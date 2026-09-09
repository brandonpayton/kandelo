//! Authoritative "keep-raw-args" syscall set for the Phase 2 opaque transport.
//!
//! # Why this exists
//!
//! Phase 2 flips *non-blocking, purely-marshalling* syscalls onto the opaque
//! self-describing channel record (see [`crate::channel_record`]): the guest
//! glue marshals its pointer arguments into a record, the host transports the
//! byte region blindly, and the kernel decodes it. The host is then out of the
//! syscall data path for those calls.
//!
//! Many syscalls, however, are **not** pure marshalling. They require host-side
//! work that the blind record transport bypasses:
//!
//! * **Capability / interception** — `fork`, `execve`, `clone`, `futex`,
//!   `writev`/`readv`, `sendmsg`/`recvmsg`, the SysV IPC families, `mmap`/`brk`
//!   process-memory growth, `kill`/`setpgid` blocked-waiter wakeups, and more.
//!   These are intercepted before or after the kernel call, and the host mutates
//!   process memory, the process WebAssembly.Memory, or scheduler state.
//! * **Blocking I/O** — `read`, `write`, `poll`, `connect`, `accept`, `semop`,
//!   … participate in the host EAGAIN park / retry-snapshot machinery
//!   (`GENERIC_BLOCKING_SNAPSHOT_SYSCALLS` and the Tier-A blocking handlers in
//!   `host/src/kernel-worker.ts`). Routing a blocking syscall through the blind
//!   record path would deadlock host readiness/retry.
//!
//! For **Phase 2 (Option A)** the entire host-blocking-managed set AND the
//! capability set stay on RAW args; only the leftover pure-marshalling syscalls
//! flip to the record path. Blocking I/O moves to the record path later
//! (Phase 4). This module is the single source of truth for that RAW set. It is
//! projected into:
//!
//! * the guest C marshal header (`bits/kandelo_syscall_marshal.h`, via
//!   `cargo xtask dump-abi`) so `__do_syscall_impl` writes raw args and never
//!   builds a record for a RAW syscall; and
//! * `host/src/generated/abi.ts` (`HOST_RAW_SYSCALLS`) so the host's blind
//!   record fast-path can assert, defensively, that a RAW syscall never carries
//!   a record magic (a RAW syscall arriving with `RECORD_MAGIC` is a loud
//!   protocol failure, never a silent proceed — this is the deadlock/corruption
//!   prevention net).
//!
//! # Completeness contract (load-bearing)
//!
//! A **missing blocking** entry deadlocks the host retry protocol; a **missing
//! capability** entry silently corrupts (the host post-processing that grows
//! memory, wakes waiters, flushes shared mappings, or translates a width-
//! dependent wire is skipped). The set below is therefore the *union of every
//! host-involved syscall*, deliberately erring toward RAW: marking a pure
//! syscall RAW only forgoes a Phase-2 optimization, whereas omitting a host-
//! involved syscall breaks correctness. `ioctl`, `fcntl`, and `prctl` are kept
//! wholly RAW (rather than per-request / per-cmd) so the syscall-number-level
//! host guard stays airtight for them.
//!
//! Blocking is not one set. `GENERIC_BLOCKING_SNAPSHOT_SYSCALLS` covers the
//! host EAGAIN park/retry *snapshot* family, but it is not the whole blocking
//! surface: `sigsuspend` and `pause` block through the distinct
//! `host_sigsuspend_wait` signal-wait park (see `sys_sigsuspend`) and appear in
//! neither snapshot set. They must be RAW too — `sigsuspend` carries a mask
//! pointer, so absent this entry the guest would marshal it onto the record
//! fast-path, which performs no EAGAIN park and would leak the kernel's
//! blocking EAGAIN straight to the caller.
//!
//! Every value here is drawn from [`crate::Syscall`],
//! [`crate::abi::extended_syscalls`], or [`crate::abi::host_intercepted`], so
//! adding or removing an entry is an ABI-adjacent change captured by the
//! generated artifacts.

use crate::abi::{extended_syscalls as ext, host_intercepted as hi};
use crate::Syscall;

/// Syscalls that keep raw arguments in Phase 2 (never marshalled into a record).
///
/// Each grouping cites its reason: `CAP` = host capability / interception that
/// the blind record transport would bypass; `BLK` = host-managed blocking I/O
/// that must not be routed through the blind path (Phase 4 candidate). Kept
/// sorted-agnostic here for readability; [`host_raw_syscalls_sorted`] returns a
/// sorted, de-duplicated view for the guard/codegen.
pub const HOST_RAW_SYSCALLS: &[u32] = &[
    // --- CAP: fork/exec/clone/exit/wait interception (Tier-A) ---
    hi::SYS_FORK,
    hi::SYS_VFORK,
    hi::SYS_SPAWN,
    hi::SYS_EXECVE,
    hi::SYS_EXECVEAT,
    ext::SYS_CLONE,
    Syscall::Exit as u32,
    ext::SYS_EXIT_GROUP,
    Syscall::Wait4 as u32,
    ext::SYS_WAITID,
    // --- CAP: threading / cancellation operating on process memory ---
    ext::SYS_FUTEX,
    ext::SYS_THREAD_CANCEL,
    // --- CAP: scatter/gather + message I/O with nested pointers (Tier-A) ---
    Syscall::Writev as u32,
    Syscall::Readv as u32,
    ext::SYS_PREADV,
    ext::SYS_PWRITEV,
    ext::SYS_PREADV2,
    ext::SYS_PWRITEV2,
    Syscall::Sendmsg as u32,
    Syscall::Recvmsg as u32,
    // --- CAP: SysV IPC (width-dependent wires, host memory, blocking) ---
    ext::SYS_MSGSND,
    ext::SYS_MSGRCV,
    ext::SYS_MSGCTL,
    ext::SYS_SEMOP,
    ext::SYS_SEMCTL,
    ext::SYS_SHMAT,
    ext::SYS_SHMDT,
    ext::SYS_SHMCTL,
    // --- CAP: select/epoll host-managed readiness (Tier-A) ---
    Syscall::Select as u32,
    ext::SYS_PSELECT6,
    ext::SYS_EPOLL_CREATE,
    ext::SYS_EPOLL_CREATE1,
    ext::SYS_EPOLL_CTL,
    ext::SYS_EPOLL_PWAIT,
    ext::SYS_EPOLL_WAIT,
    // --- CAP: whole-syscall RAW for airtight per-cmd/per-request guard ---
    Syscall::Fcntl as u32,   // advisory-lock cmds are host-intercepted + block
    Syscall::Ioctl as u32,   // SIOCGIF* are host-intercepted
    ext::SYS_PRCTL,          // PR_{SET,GET}_NAME + width-clamped scalar args
    // --- CAP: POSIX mqueue (host descriptor sizing + blocking) ---
    ext::SYS_MQ_TIMEDSEND,
    ext::SYS_MQ_TIMEDRECEIVE,
    // --- CAP: affinity mask host validation/output invalidation ---
    ext::SYS_SCHED_GETAFFINITY,
    // --- CAP: process-memory growth / shared-mapping coherence (post-dispatch) ---
    Syscall::Mmap as u32,
    Syscall::Munmap as u32,
    Syscall::Brk as u32,
    Syscall::Mprotect as u32,
    Syscall::Mremap as u32,
    ext::SYS_MSYNC,
    // --- CAP: file-content mutation flushed into MAP_SHARED backings ---
    Syscall::Ftruncate as u32,
    Syscall::Truncate as u32,
    ext::SYS_FALLOCATE,
    // --- CAP: sleep completion delay (host-simulated) ---
    Syscall::Nanosleep as u32,
    Syscall::ClockNanosleep as u32,
    // --- CAP: signal generation waking blocked peers / reaping (post-dispatch) ---
    Syscall::Kill as u32,
    ext::SYS_TKILL,
    ext::SYS_RT_SIGQUEUEINFO,
    // --- CAP: process-group change re-checks deferred waitpid (post-dispatch) ---
    Syscall::Setpgid as u32,
    Syscall::Setsid as u32,
    // --- BLK: GENERIC_BLOCKING_SNAPSHOT_SYSCALLS (host EAGAIN park/retry) ---
    Syscall::Open as u32,
    Syscall::Openat as u32,
    Syscall::Read as u32,
    Syscall::Write as u32,
    Syscall::Pread as u32,
    Syscall::Pwrite as u32,
    Syscall::Recv as u32,
    Syscall::Send as u32,
    Syscall::Recvfrom as u32,
    Syscall::Sendto as u32,
    Syscall::Accept as u32,
    ext::SYS_ACCEPT4,
    Syscall::Connect as u32,
    Syscall::Poll as u32,
    ext::SYS_PPOLL,
    ext::SYS_RT_SIGTIMEDWAIT,
    // --- BLK: signal-wait blockers parked via host_sigsuspend_wait (NOT in
    // GENERIC_BLOCKING_SNAPSHOT_SYSCALLS; they block through a distinct host
    // signal-wait park/retry rather than the generic snapshot machinery). The
    // record fast-path performs no EAGAIN park, so routing sigsuspend/pause
    // through it would leak the kernel's blocking EAGAIN straight to the guest.
    // sigsuspend carries a mask pointer (so it would otherwise take the record
    // path); pause is scalar-only but is host-blocking-managed and kept RAW to
    // honor the "union of every host-involved syscall" completeness contract. ---
    Syscall::Sigsuspend as u32,
    Syscall::Pause as u32,
    ext::SYS_SENDFILE,
    ext::SYS_COPY_FILE_RANGE,
    ext::SYS_SPLICE,
];

/// Maximum number of RAW syscall numbers (bound for the sorted copy buffer).
pub const HOST_RAW_SYSCALLS_MAX: usize = 96;

/// Returns the RAW syscall numbers sorted ascending and de-duplicated, along
/// with the count. Codegen and the runtime guard consume a sorted view so a
/// linear or binary scan is well-defined and drift-free.
pub fn host_raw_syscalls_sorted() -> ([u32; HOST_RAW_SYSCALLS_MAX], usize) {
    let mut buf = [0u32; HOST_RAW_SYSCALLS_MAX];
    let mut len = 0usize;
    for &n in HOST_RAW_SYSCALLS {
        // Insertion sort with de-dup; the list is tiny so this stays trivial and
        // has no allocation (usable from build tooling and no_std tests alike).
        let mut i = 0usize;
        while i < len && buf[i] < n {
            i += 1;
        }
        if i < len && buf[i] == n {
            continue; // duplicate
        }
        let mut j = len;
        while j > i {
            buf[j] = buf[j - 1];
            j -= 1;
        }
        buf[i] = n;
        len += 1;
    }
    (buf, len)
}

/// True when `syscall` keeps raw args in Phase 2 (must never carry a record).
pub fn is_host_raw_syscall(syscall: u32) -> bool {
    HOST_RAW_SYSCALLS.iter().any(|&n| n == syscall)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn raw_set_is_within_the_sorted_capacity() {
        assert!(HOST_RAW_SYSCALLS.len() <= HOST_RAW_SYSCALLS_MAX);
    }

    #[test]
    fn sorted_view_is_ascending_unique_and_covers_every_entry() {
        let (sorted, len) = host_raw_syscalls_sorted();
        for window in sorted[..len].windows(2) {
            assert!(window[0] < window[1], "sorted RAW set must be strictly ascending");
        }
        for &n in HOST_RAW_SYSCALLS {
            assert!(sorted[..len].contains(&n), "sorted view dropped {n}");
        }
    }

    #[test]
    fn blocking_snapshot_syscalls_are_all_raw() {
        // Mirror of host `GENERIC_BLOCKING_SNAPSHOT_SYSCALLS`. A blocking syscall
        // missing from the RAW set would deadlock the host retry protocol once
        // the record path is live, so pin the invariant on the Rust side too.
        let blocking: &[u32] = &[
            Syscall::Open as u32,
            Syscall::Read as u32,
            Syscall::Write as u32,
            Syscall::Pread as u32,
            Syscall::Pwrite as u32,
            Syscall::Recv as u32,
            Syscall::Send as u32,
            Syscall::Recvfrom as u32,
            Syscall::Sendto as u32,
            Syscall::Accept as u32,
            Syscall::Connect as u32,
            Syscall::Poll as u32,
            Syscall::Openat as u32,
            ext::SYS_RT_SIGTIMEDWAIT,
            ext::SYS_PPOLL,
            ext::SYS_MQ_TIMEDSEND,
            ext::SYS_MQ_TIMEDRECEIVE,
            ext::SYS_SEMOP,
            ext::SYS_SENDFILE,
            ext::SYS_COPY_FILE_RANGE,
            ext::SYS_SPLICE,
            ext::SYS_ACCEPT4,
        ];
        for &n in blocking {
            assert!(is_host_raw_syscall(n), "blocking syscall {n} is not RAW");
        }
    }

    #[test]
    fn tier_a_blocking_handlers_are_raw() {
        for n in [
            Syscall::Select as u32,
            ext::SYS_PSELECT6,
            ext::SYS_EPOLL_CREATE,
            ext::SYS_EPOLL_CREATE1,
            ext::SYS_EPOLL_CTL,
            ext::SYS_EPOLL_PWAIT,
            ext::SYS_EPOLL_WAIT,
            Syscall::Fcntl as u32,
            ext::SYS_SEMOP,
            ext::SYS_FUTEX,
        ] {
            assert!(is_host_raw_syscall(n), "Tier-A blocking handler {n} is not RAW");
        }
    }
}
