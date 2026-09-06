#![no_std]

pub mod channel_scalar;
pub mod host_abi;
pub mod ioctl_contract;
pub mod process_layout;

/// Kernel ABI version.
///
/// This number is baked into every compiled user program (wasm custom section
/// `wasm-posix-abi`) and exported by the kernel as `__abi_version`. The host
/// refuses to launch binaries whose ABI does not match the running kernel.
///
/// **Bump this whenever the binary-level contract between user programs and
/// the kernel changes in a way that breaks backward compatibility.**
///
/// The structural snapshot at `abi/snapshot.json` is the source of truth for
/// what that contract covers — field offsets of marshalled structs, channel
/// header layout, syscall numbers, and kernel export signatures. CI
/// regenerates the snapshot and compares it to the committed copy; any diff
/// requires bumping `ABI_VERSION` in the same commit.
///
/// See `docs/abi-versioning.md` for the full policy.
///
/// 13: process memory layout ABI is Rust-declared; per-pthread slots
///     use explicit TLS/control, fork-save, channel, and spill pages,
///     with a wasm-declared reserved thread-slot count.
/// 15: remove the obsolete `kernel_set_mode` export; the kernel is always
///     the shared point of contact for all programs.
/// 16: process creation takes explicit stdio descriptor kinds and removes the
///     post-creation stdin pipe mutation export.
/// 17: intentionally skipped during release coordination.
/// 18: fork frame cursors are absolute save-buffer addresses, isolating
///     concurrent pthread unwind payloads.
/// 19: bridged TCP EPIPE delivery raises SIGPIPE unless the caller suppresses
///     it, matching the signal contract of local stream writes.
/// 20: mremap rejects unsupported flag bits instead of silently accepting
///     them under the existing syscall number.
/// 21: missing, PID-zero, and reaped procfs paths report ENOENT instead of
///     returning synthetic success through stat/access/path operations.
/// 22: socket addresses, option pointers, accepted descriptors, multicast,
///     routing, hostname errors, and inherited socket state are reconciled.
/// 23: TCP FIN, EOF, EPIPE, wakeup, bridge-reader, and queued-data behavior
///     use the required real-reader kernel export.
/// 24: datagram admission, Unix EAGAIN, blocking, readiness, wakeups, and
///     finite deadlines expose queue pressure consistently.
/// 25: broadcast errors, MSG_TRUNC results, and zero-length output pointers
///     follow the reconciled datagram contract.
/// 26: wait/signal, mmap, exec, descriptor/socket/shared-memory inheritance,
///     fork metadata, epoll, sleep, and forced-removal state are preserved.
/// 27: rebuilt PHP programs require the cooperative VM-interrupt host hook,
///     and POSIX timer notifications use validated fixed-width signal fields.
/// 28: host path, clock/timer, exec/spawn, worker, and persistent-VFS behavior
///     is aligned across Node and browser runtime boundaries.
/// 29: cancellation-point function types, 64-bit argument slots, lseek state,
///     and select/pselect signal interruption are reconciled.
/// 30: launch environments and unchanged-ID chown operations preserve their
///     process, authorization, and backend-error semantics.
/// 31: operation-wide file-size preflight and exact-thread SIGXFSZ delivery
///     are required for write-family operations.
/// 32: component-wise path, symlink, mount, errno, and current-directory
///     resolution use one canonical namespace contract.
/// 33: no-follow symlink ownership requires the lchown host surface and its
///     descriptor/flag behavior.
/// 34: pathconf uses 64-bit result storage, live-object queries, and the
///     required host marshalling surface.
/// 35: wait/status/rusage, WNOWAIT, stop/continue, blocking, and pthread-exit
///     lifecycle use the reconciled process wire contract.
/// 36: side-module replay-control memory and concurrent pthread-fork
///     arbitration share one host/guest continuation contract.
/// 37: pending host-delegated AF_INET stream connects expose EINPROGRESS then
///     EALREADY to non-blocking callers while blocking callers wait for the
///     same host handshake to complete or fail.
/// 38: sched_getaffinity marshals its fixed kernel mask across process memory,
///     validates live task identity, and exposes the Linux raw return contract.
/// 39: kernel-owned POSIX timer expiration preserves exact thread targets,
///     SI_TIMER metadata, overruns, and finite signal-wait deadlines through
///     the required host timer-fire export.
/// 40: advisory locks are kernel-owned, use stable file/OFD identities and
///     bounded dynamic storage, report ENOLCK distinctly, and no longer
///     require the host_fcntl_lock import; fork/exec OFD state is versioned.
/// 41: main-thread, pthread, and side-module fork continuations reserve 60 KiB
///     so valid wide call stacks do not overwrite adjacent host control state.
/// 42: process and thread identities come from one kernel-owned allocator,
///     while fork continuations use transactional, dynamically allocated
///     linked chunks instead of a fixed-capacity save buffer. Process creation
///     and fork exports return kernel-allocated identities; instrumented
///     modules declare the continuation format and import reserve, commit, and
///     replay hooks.
/// 43: fork artifacts prove activation-state safety explicitly. Activation
///     references, complete exceptions, mutable reference globals, and mutable
///     tables are serialized as versioned process-owned recipes and rebuilt
///     with fresh instance-local identities before continuation replay.
///     Variable-sized host writes into reusable kernel spawn storage and fresh
///     kernel-owned large-I/O storage use tokenized begin/copy/execute
///     transactions; vector I/O executes as one scalar operation, obsolete
///     raw scalar/vector I/O exports and the decomposed-write budget export are
///     removed, and positioned host I/O preserves exact signed-i64 offsets
///     without changing the shared cursor. Paired host append imports report
///     one atomic append's written prefix and exact ending offset before Rust
///     advances the shared cursor. System V IPC control transfers plus
///     caller-native signal-stack, interval-timer, POSIX message-queue,
///     filesystem-statistics, and system-information records use required
///     pointer-width-aware kernel structure sizes. Host-deferred retries retain
///     exact kernel targets through required token/release exports, and their
///     signal interruption policy requires exact target, deliverability,
///     descriptor-mode, and socket-timeout query exports. Each channel request
///     also carries generated, one-shot flags that distinguish `__syscall_cp`
///     from a plain syscall with the same number and defer signal delivery for
///     completions consumed outside libc's post-syscall trampoline. OSS PCM
///     ioctl transfers use request-sized arguments, `/dev/dsp` descriptors
///     share a refcounted stream across fork and exec, and the host consumes a
///     versioned bounded transport paced by the audio clock.
/// 44: machine checkpoints reserve a channel request word directly below the
///     signal delivery area, freshly built programs import the no-argument,
///     no-result `kernel.kernel_checkpoint` unwind hook from the post-syscall
///     trampoline, and machine restore uses the host-handle enumerate and
///     remap, host-timer re-arm, and PTY-index kernel exports.
/// 45: the checkpoint request word is a bit set rather than a single value.
///     The freeze completes a parked blocking syscall with `EINTR` so the
///     process reaches the post-syscall trampoline at all, and publishes
///     `CHECKPOINT_REQUEST_RESTART` alongside `CHECKPOINT_REQUEST_UNWIND` to
///     tell the guest to resubmit that syscall once the rewind returns.
pub const ABI_VERSION: u32 = 45;

/// Byte width of Kandelo's Linux-compatible kernel CPU-affinity mask.
///
/// The current kernel models one CPU and uses one wasm32 kernel word. Both
/// wasm32 and wasm64 guests therefore receive the same four-byte raw mask;
/// changing this width is an ABI change.
pub const SCHED_AFFINITY_MASK_SIZE: u32 = 4;

/// Kandelo's advertised cross-layer POSIX limits.
///
/// Keep these outside any one syscall protocol: libc headers, Rust syscall
/// implementations, and TypeScript host validation all consume the generated
/// values. Parser-specific defensive limits belong with their parser instead.
pub mod platform_limits {
    pub const ARG_MAX_BYTES: usize = 4 * 1024 * 1024;
    pub const PATH_MAX_BYTES: usize = 4096;
    /// Maximum component plus its terminating NUL in a caller C string.
    pub const NAME_MAX_BYTES: usize = 256;
    /// Maximum hostname plus its terminating NUL in a caller C string.
    pub const HOST_NAME_MAX_BYTES: usize = 256;
    /// Linux memfd name content is limited to 249 bytes, plus its NUL.
    pub const MEMFD_NAME_MAX_BYTES: usize = 250;
    /// Largest one-entry argv/environment transport admitted by the host.
    ///
    /// This is not POSIX ARG_MAX; complete argv+env representation remains
    /// governed independently by ARG_MAX_BYTES.
    pub const PROCESS_METADATA_ENTRY_MAX_BYTES: usize = 65_536;
    /// Maximum argv entries admitted through process creation and reconstructed
    /// by the guest startup code.
    ///
    /// This is a defensive representation bound, not an additional POSIX
    /// `ARG_MAX` promise. The complete pointer-plus-string representation must
    /// still fit `ARG_MAX_BYTES`.
    pub const PROCESS_STARTUP_MAX_ARGV_COUNT: usize = 4096;
    /// Maximum environment entries admitted through process creation and
    /// reconstructed by the guest startup code.
    pub const PROCESS_STARTUP_MAX_ENVP_COUNT: usize = 4096;
    pub const NGROUPS_MAX: usize = 32;
    pub const SYSV_MSG_MAX_BYTES: usize = 8192;
    /// Largest successful byte count representable by the signed-i32 channel
    /// result without becoming indistinguishable from an errno return.
    pub const MAX_REPORTABLE_TRANSFER_BYTES: usize = i32::MAX as usize;
    /// Largest private host/kernel transfer allocation representable by the
    /// u32 byte-length wire used by tokenized scratch reservations.
    pub const MAX_TRANSFER_ALLOCATION_BYTES: usize = u32::MAX as usize;
    pub const IOV_MAX: usize = 1024;
}

/// Host/kernel selectors for one atomic argv/environment replacement.
///
/// These values cross the Wasm export boundary. Keep TypeScript consumers on
/// the generated constants rather than repeating kind literals in the host.
pub mod process_metadata_contract {
    pub const KIND_ARGV: u32 = 0;
    pub const KIND_ENVIRONMENT: u32 = 1;
}

/// Cross-layer selectors for the process-creation import that begins fork
/// continuation capture.
///
/// The value is carried by the guest `kernel.kernel_fork` import, translated
/// to the corresponding host-intercepted syscall, and passed to the Rust
/// process-table export. Keeping it in shared ABI metadata prevents libc,
/// fork instrumentation, and the Node/browser hosts from assigning different
/// meanings to the same i32.
pub mod fork_contract {
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    #[repr(u32)]
    pub enum Mode {
        Fork = 0,
        Vfork = 1,
    }

    impl Mode {
        pub const fn from_u32(value: u32) -> Option<Self> {
            match value {
                value if value == Self::Fork as u32 => Some(Self::Fork),
                value if value == Self::Vfork as u32 => Some(Self::Vfork),
                _ => None,
            }
        }
    }

    pub const MODE_FORK: u32 = Mode::Fork as u32;
    pub const MODE_VFORK: u32 = Mode::Vfork as u32;
}

/// Packed host/kernel wire layout for one process-table snapshot record.
///
/// This record is not a native Rust or C structure: the `u64` field is
/// deliberately packed at byte 16, so a native `repr(C)` structure would add
/// tail padding and report 40 bytes instead of the 36 bytes actually written.
/// Keep every producer and consumer on these generated offsets.
pub mod process_snapshot_wire {
    use core::mem::size_of;

    pub const COUNT_OFFSET: usize = 0;
    pub const COUNT_BYTES: usize = size_of::<u32>();
    pub const RECORDS_OFFSET: usize = COUNT_OFFSET + COUNT_BYTES;

    pub const PID_OFFSET: usize = 0;
    pub const PPID_OFFSET: usize = PID_OFFSET + size_of::<u32>();
    pub const UID_OFFSET: usize = PPID_OFFSET + size_of::<u32>();
    pub const GID_OFFSET: usize = UID_OFFSET + size_of::<u32>();
    pub const VSIZE_OFFSET: usize = GID_OFFSET + size_of::<u32>();
    pub const STATE_OFFSET: usize = VSIZE_OFFSET + size_of::<u64>();
    pub const COMM_LEN_OFFSET: usize = STATE_OFFSET + size_of::<u32>();
    pub const CMDLINE_LEN_OFFSET: usize = COMM_LEN_OFFSET + size_of::<u32>();
    pub const HEADER_BYTES: usize = CMDLINE_LEN_OFFSET + size_of::<u32>();
}

/// Packed kernel/host wire layout for one readiness or lifecycle wake event.
///
/// The event type is a bitset because one kernel transition may make several
/// host-owned retry classes eligible at once. Keep both producers and the
/// shared Node/browser consumer on these generated values.
pub mod wakeup_event_wire {
    use core::mem::size_of;

    pub const IDX_OFFSET: usize = 0;
    pub const IDX_BYTES: usize = size_of::<u32>();
    pub const TYPE_OFFSET: usize = IDX_OFFSET + IDX_BYTES;
    pub const TYPE_BYTES: usize = size_of::<u8>();
    pub const RECORD_BYTES: usize = TYPE_OFFSET + TYPE_BYTES;

    pub const TYPE_READABLE: u8 = 1;
    pub const TYPE_WRITABLE: u8 = 2;
    pub const TYPE_ACCEPT: u8 = 4;
    pub const TYPE_DATAGRAM_WRITABLE: u8 = 8;
    pub const TYPE_PROCESS_STOPPED: u8 = 16;
    pub const TYPE_PROCESS_CONTINUED: u8 = 32;
    pub const TYPE_ADVISORY_LOCK: u8 = 64;
}

/// Cross-layer layout values and defensive limits for the non-forking spawn
/// protocol.
///
/// The `POSIX_*` aliases deliberately refer to the advertised platform
/// limits. The count caps are defensive parser limits for this wire
/// representation, not additional POSIX limits on applications.
pub mod spawn_contract {
    use core::mem::size_of;

    use super::platform_limits;

    pub const POSIX_ARG_MAX_BYTES: usize = platform_limits::ARG_MAX_BYTES;
    pub const POSIX_PATH_MAX_BYTES: usize = platform_limits::PATH_MAX_BYTES;

    pub const WIRE_STRING_OFFSET_BYTES: usize = size_of::<u32>();

    pub const WIRE_HEADER_ARGC_OFFSET: usize = 0;
    pub const WIRE_HEADER_ENVC_OFFSET: usize = WIRE_HEADER_ARGC_OFFSET + size_of::<u32>();
    pub const WIRE_HEADER_ACTION_COUNT_OFFSET: usize = WIRE_HEADER_ENVC_OFFSET + size_of::<u32>();
    pub const WIRE_HEADER_ATTR_FLAGS_OFFSET: usize =
        WIRE_HEADER_ACTION_COUNT_OFFSET + size_of::<u32>();
    pub const WIRE_HEADER_PGRP_OFFSET: usize = WIRE_HEADER_ATTR_FLAGS_OFFSET + size_of::<u32>();
    pub const WIRE_HEADER_PAD_OFFSET: usize = WIRE_HEADER_PGRP_OFFSET + size_of::<i32>();
    pub const WIRE_HEADER_SIGDEF_OFFSET: usize = WIRE_HEADER_PAD_OFFSET + size_of::<u32>();
    pub const WIRE_HEADER_SIGMASK_OFFSET: usize = WIRE_HEADER_SIGDEF_OFFSET + size_of::<u64>();
    pub const WIRE_HEADER_BYTES: usize = WIRE_HEADER_SIGMASK_OFFSET + size_of::<u64>();

    pub const WIRE_ACTION_OP_OFFSET: usize = 0;
    pub const WIRE_ACTION_FD_OFFSET: usize = WIRE_ACTION_OP_OFFSET + size_of::<u32>();
    pub const WIRE_ACTION_NEWFD_OFFSET: usize = WIRE_ACTION_FD_OFFSET + size_of::<i32>();
    pub const WIRE_ACTION_PATH_OFF_OFFSET: usize = WIRE_ACTION_NEWFD_OFFSET + size_of::<i32>();
    pub const WIRE_ACTION_PATH_LEN_OFFSET: usize = WIRE_ACTION_PATH_OFF_OFFSET + size_of::<u32>();
    pub const WIRE_ACTION_OFLAG_OFFSET: usize = WIRE_ACTION_PATH_LEN_OFFSET + size_of::<u32>();
    pub const WIRE_ACTION_MODE_OFFSET: usize = WIRE_ACTION_OFLAG_OFFSET + size_of::<i32>();
    pub const WIRE_ACTION_RECORD_BYTES: usize = WIRE_ACTION_MODE_OFFSET + size_of::<u32>();

    pub const WIRE_OP_OPEN: u32 = 0;
    pub const WIRE_OP_CLOSE: u32 = 1;
    pub const WIRE_OP_DUP2: u32 = 2;
    pub const WIRE_OP_CHDIR: u32 = 3;
    pub const WIRE_OP_FCHDIR: u32 = 4;

    // These are every musl flag bit transported byte-for-byte in the blob.
    // Kernel support remains an explicit subset in `kernel::spawn::attr_flags`;
    // defining a transport value here does not claim the behavior exists.
    pub const ATTR_RESETIDS: u32 = 0x01;
    pub const ATTR_SETPGROUP: u32 = 0x02;
    pub const ATTR_SETSIGDEF: u32 = 0x04;
    pub const ATTR_SETSIGMASK: u32 = 0x08;
    pub const ATTR_SETSCHEDPARAM: u32 = 0x10;
    pub const ATTR_SETSCHEDULER: u32 = 0x20;
    pub const ATTR_USEVFORK: u32 = 0x40;
    pub const ATTR_SETSID: u32 = 0x80;
    pub const MAX_ARGV_COUNT: usize = platform_limits::PROCESS_STARTUP_MAX_ARGV_COUNT;
    pub const MAX_ENVP_COUNT: usize = platform_limits::PROCESS_STARTUP_MAX_ENVP_COUNT;
    pub const MAX_ACTION_COUNT: usize = 1024;

    /// Complete transport ceiling: POSIX argv/environment budget plus the
    /// defensive maximum number of PATH_MAX-sized file actions.
    pub const WIRE_MAX_BYTES: usize = POSIX_ARG_MAX_BYTES
        + WIRE_HEADER_BYTES
        + MAX_ACTION_COUNT * (WIRE_ACTION_RECORD_BYTES + POSIX_PATH_MAX_BYTES);

    // WHY: counts, string offsets, and action path lengths are serialized as
    // u32. Keep the complete representation within that address domain so a
    // future platform-limit change cannot make the C encoder truncate a
    // `size_t` cursor while Rust and TypeScript continue accepting the blob.
    const _: () = {
        assert!(MAX_ARGV_COUNT <= u32::MAX as usize);
        assert!(MAX_ENVP_COUNT <= u32::MAX as usize);
        assert!(MAX_ACTION_COUNT <= u32::MAX as usize);
        assert!(POSIX_PATH_MAX_BYTES <= u32::MAX as usize);
        assert!(WIRE_MAX_BYTES <= u32::MAX as usize);
    };

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn wire_layout_fields_are_contiguous_and_cover_the_records() {
            assert_eq!(WIRE_STRING_OFFSET_BYTES, size_of::<u32>());

            assert_eq!(WIRE_HEADER_ARGC_OFFSET, 0);
            assert_eq!(
                WIRE_HEADER_ENVC_OFFSET,
                WIRE_HEADER_ARGC_OFFSET + size_of::<u32>()
            );
            assert_eq!(
                WIRE_HEADER_ACTION_COUNT_OFFSET,
                WIRE_HEADER_ENVC_OFFSET + size_of::<u32>()
            );
            assert_eq!(
                WIRE_HEADER_ATTR_FLAGS_OFFSET,
                WIRE_HEADER_ACTION_COUNT_OFFSET + size_of::<u32>()
            );
            assert_eq!(
                WIRE_HEADER_PGRP_OFFSET,
                WIRE_HEADER_ATTR_FLAGS_OFFSET + size_of::<u32>()
            );
            assert_eq!(
                WIRE_HEADER_PAD_OFFSET,
                WIRE_HEADER_PGRP_OFFSET + size_of::<i32>()
            );
            assert_eq!(
                WIRE_HEADER_SIGDEF_OFFSET,
                WIRE_HEADER_PAD_OFFSET + size_of::<u32>()
            );
            assert_eq!(
                WIRE_HEADER_SIGMASK_OFFSET,
                WIRE_HEADER_SIGDEF_OFFSET + size_of::<u64>()
            );
            assert_eq!(
                WIRE_HEADER_BYTES,
                WIRE_HEADER_SIGMASK_OFFSET + size_of::<u64>()
            );
            assert_eq!(WIRE_HEADER_BYTES, 40);

            assert_eq!(WIRE_ACTION_OP_OFFSET, 0);
            assert_eq!(
                WIRE_ACTION_FD_OFFSET,
                WIRE_ACTION_OP_OFFSET + size_of::<u32>()
            );
            assert_eq!(
                WIRE_ACTION_NEWFD_OFFSET,
                WIRE_ACTION_FD_OFFSET + size_of::<i32>()
            );
            assert_eq!(
                WIRE_ACTION_PATH_OFF_OFFSET,
                WIRE_ACTION_NEWFD_OFFSET + size_of::<i32>()
            );
            assert_eq!(
                WIRE_ACTION_PATH_LEN_OFFSET,
                WIRE_ACTION_PATH_OFF_OFFSET + size_of::<u32>()
            );
            assert_eq!(
                WIRE_ACTION_OFLAG_OFFSET,
                WIRE_ACTION_PATH_LEN_OFFSET + size_of::<u32>()
            );
            assert_eq!(
                WIRE_ACTION_MODE_OFFSET,
                WIRE_ACTION_OFLAG_OFFSET + size_of::<i32>()
            );
            assert_eq!(
                WIRE_ACTION_RECORD_BYTES,
                WIRE_ACTION_MODE_OFFSET + size_of::<u32>()
            );
            assert_eq!(WIRE_ACTION_RECORD_BYTES, 28);
        }

        #[test]
        fn transported_attr_bits_cover_musls_complete_flag_byte() {
            assert_eq!(ATTR_RESETIDS, 0x01);
            assert_eq!(ATTR_SETPGROUP, 0x02);
            assert_eq!(ATTR_SETSIGDEF, 0x04);
            assert_eq!(ATTR_SETSIGMASK, 0x08);
            assert_eq!(ATTR_SETSCHEDPARAM, 0x10);
            assert_eq!(ATTR_SETSCHEDULER, 0x20);
            assert_eq!(ATTR_USEVFORK, 0x40);
            assert_eq!(ATTR_SETSID, 0x80);
            assert_eq!(
                ATTR_RESETIDS
                    | ATTR_SETPGROUP
                    | ATTR_SETSIGDEF
                    | ATTR_SETSIGMASK
                    | ATTR_SETSCHEDPARAM
                    | ATTR_SETSCHEDULER
                    | ATTR_USEVFORK
                    | ATTR_SETSID,
                0xff
            );
        }

        #[test]
        fn wire_counts_lengths_and_offsets_are_u32_representable() {
            assert!(MAX_ARGV_COUNT <= u32::MAX as usize);
            assert!(MAX_ENVP_COUNT <= u32::MAX as usize);
            assert!(MAX_ACTION_COUNT <= u32::MAX as usize);
            assert!(POSIX_PATH_MAX_BYTES <= u32::MAX as usize);
            assert!(WIRE_MAX_BYTES <= u32::MAX as usize);
        }
    }
}

/// Syscall numbers for the POSIX kernel interface.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u32)]
pub enum Syscall {
    Open = 1,
    Close = 2,
    Read = 3,
    Write = 4,
    Seek = 5,
    Fstat = 6,
    Dup = 7,
    Dup2 = 8,
    Pipe = 9,
    Fcntl = 10,
    Stat = 11,
    Lstat = 12,
    Mkdir = 13,
    Rmdir = 14,
    Unlink = 15,
    Rename = 16,
    Link = 17,
    Symlink = 18,
    Readlink = 19,
    Chmod = 20,
    Chown = 21,
    Access = 22,
    Getcwd = 23,
    Chdir = 24,
    Opendir = 25,
    Readdir = 26,
    Closedir = 27,
    Getpid = 28,
    Getppid = 29,
    Getuid = 30,
    Geteuid = 31,
    Getgid = 32,
    Getegid = 33,
    Exit = 34,
    Kill = 35,
    Sigaction = 36,
    Sigprocmask = 37,
    Raise = 38,
    Alarm = 39,
    ClockGettime = 40,
    Nanosleep = 41,
    Isatty = 42,
    GetEnv = 43,
    SetEnv = 44,
    UnsetEnv = 45,
    Mmap = 46,
    Munmap = 47,
    Brk = 48,
    Mprotect = 49,
    Socket = 50,
    Bind = 51,
    Listen = 52,
    Accept = 53,
    Connect = 54,
    Send = 55,
    Recv = 56,
    Shutdown = 57,
    Getsockopt = 58,
    Setsockopt = 59,
    Poll = 60,
    Socketpair = 61,
    Sendto = 62,
    Recvfrom = 63,
    Pread = 64,
    Pwrite = 65,
    Time = 66,
    Gettimeofday = 67,
    Usleep = 68,
    Openat = 69,
    Tcgetattr = 70,
    Tcsetattr = 71,
    Ioctl = 72,
    Signal = 73,
    Umask = 74,
    Uname = 75,
    Sysconf = 76,
    Dup3 = 77,
    Pipe2 = 78,
    Ftruncate = 79,
    Fsync = 80,
    Writev = 81,
    Readv = 82,
    Getrlimit = 83,
    Setrlimit = 84,
    Truncate = 85,
    Fdatasync = 86,
    Fchmod = 87,
    Fchown = 88,
    Getpgrp = 89,
    Setpgid = 90,
    Getsid = 91,
    Setsid = 92,
    Fstatat = 93,
    Unlinkat = 94,
    Mkdirat = 95,
    Renameat = 96,
    Faccessat = 97,
    Fchmodat = 98,
    Fchownat = 99,
    Linkat = 100,
    Symlinkat = 101,
    Readlinkat = 102,
    Select = 103,
    Setuid = 104,
    Setgid = 105,
    Seteuid = 106,
    Setegid = 107,
    Getrusage = 108,
    Realpath = 109,
    Sigsuspend = 110,
    Pause = 111,
    Pathconf = 112,
    Fpathconf = 113,
    Getsockname = 114,
    Getpeername = 115,
    Rewinddir = 116,
    Telldir = 117,
    Seekdir = 118,
    Getdents64 = 122,
    ClockGetres = 123,
    ClockNanosleep = 124,
    Utimensat = 125,
    Mremap = 126,
    Fchdir = 127,
    Madvise = 128,
    Statfs = 129,
    Fstatfs = 130,
    Setresuid = 131,
    Getresuid = 132,
    Setresgid = 133,
    Getresgid = 134,
    Getgroups = 135,
    Setgroups = 136,
    Sendmsg = 137,
    Recvmsg = 138,
    Wait4 = 139,
    Getaddrinfo = 140,
}

impl Syscall {
    /// Convert a raw u32 value to a Syscall variant.
    pub fn from_u32(val: u32) -> Option<Syscall> {
        match val {
            1 => Some(Syscall::Open),
            2 => Some(Syscall::Close),
            3 => Some(Syscall::Read),
            4 => Some(Syscall::Write),
            5 => Some(Syscall::Seek),
            6 => Some(Syscall::Fstat),
            7 => Some(Syscall::Dup),
            8 => Some(Syscall::Dup2),
            9 => Some(Syscall::Pipe),
            10 => Some(Syscall::Fcntl),
            11 => Some(Syscall::Stat),
            12 => Some(Syscall::Lstat),
            13 => Some(Syscall::Mkdir),
            14 => Some(Syscall::Rmdir),
            15 => Some(Syscall::Unlink),
            16 => Some(Syscall::Rename),
            17 => Some(Syscall::Link),
            18 => Some(Syscall::Symlink),
            19 => Some(Syscall::Readlink),
            20 => Some(Syscall::Chmod),
            21 => Some(Syscall::Chown),
            22 => Some(Syscall::Access),
            23 => Some(Syscall::Getcwd),
            24 => Some(Syscall::Chdir),
            25 => Some(Syscall::Opendir),
            26 => Some(Syscall::Readdir),
            27 => Some(Syscall::Closedir),
            28 => Some(Syscall::Getpid),
            29 => Some(Syscall::Getppid),
            30 => Some(Syscall::Getuid),
            31 => Some(Syscall::Geteuid),
            32 => Some(Syscall::Getgid),
            33 => Some(Syscall::Getegid),
            34 => Some(Syscall::Exit),
            35 => Some(Syscall::Kill),
            36 => Some(Syscall::Sigaction),
            37 => Some(Syscall::Sigprocmask),
            38 => Some(Syscall::Raise),
            39 => Some(Syscall::Alarm),
            40 => Some(Syscall::ClockGettime),
            41 => Some(Syscall::Nanosleep),
            42 => Some(Syscall::Isatty),
            43 => Some(Syscall::GetEnv),
            44 => Some(Syscall::SetEnv),
            45 => Some(Syscall::UnsetEnv),
            46 => Some(Syscall::Mmap),
            47 => Some(Syscall::Munmap),
            48 => Some(Syscall::Brk),
            49 => Some(Syscall::Mprotect),
            50 => Some(Syscall::Socket),
            51 => Some(Syscall::Bind),
            52 => Some(Syscall::Listen),
            53 => Some(Syscall::Accept),
            54 => Some(Syscall::Connect),
            55 => Some(Syscall::Send),
            56 => Some(Syscall::Recv),
            57 => Some(Syscall::Shutdown),
            58 => Some(Syscall::Getsockopt),
            59 => Some(Syscall::Setsockopt),
            60 => Some(Syscall::Poll),
            61 => Some(Syscall::Socketpair),
            62 => Some(Syscall::Sendto),
            63 => Some(Syscall::Recvfrom),
            64 => Some(Syscall::Pread),
            65 => Some(Syscall::Pwrite),
            66 => Some(Syscall::Time),
            67 => Some(Syscall::Gettimeofday),
            68 => Some(Syscall::Usleep),
            69 => Some(Syscall::Openat),
            70 => Some(Syscall::Tcgetattr),
            71 => Some(Syscall::Tcsetattr),
            72 => Some(Syscall::Ioctl),
            73 => Some(Syscall::Signal),
            74 => Some(Syscall::Umask),
            75 => Some(Syscall::Uname),
            76 => Some(Syscall::Sysconf),
            77 => Some(Syscall::Dup3),
            78 => Some(Syscall::Pipe2),
            79 => Some(Syscall::Ftruncate),
            80 => Some(Syscall::Fsync),
            81 => Some(Syscall::Writev),
            82 => Some(Syscall::Readv),
            83 => Some(Syscall::Getrlimit),
            84 => Some(Syscall::Setrlimit),
            85 => Some(Syscall::Truncate),
            86 => Some(Syscall::Fdatasync),
            87 => Some(Syscall::Fchmod),
            88 => Some(Syscall::Fchown),
            89 => Some(Syscall::Getpgrp),
            90 => Some(Syscall::Setpgid),
            91 => Some(Syscall::Getsid),
            92 => Some(Syscall::Setsid),
            93 => Some(Syscall::Fstatat),
            94 => Some(Syscall::Unlinkat),
            95 => Some(Syscall::Mkdirat),
            96 => Some(Syscall::Renameat),
            97 => Some(Syscall::Faccessat),
            98 => Some(Syscall::Fchmodat),
            99 => Some(Syscall::Fchownat),
            100 => Some(Syscall::Linkat),
            101 => Some(Syscall::Symlinkat),
            102 => Some(Syscall::Readlinkat),
            103 => Some(Syscall::Select),
            104 => Some(Syscall::Setuid),
            105 => Some(Syscall::Setgid),
            106 => Some(Syscall::Seteuid),
            107 => Some(Syscall::Setegid),
            108 => Some(Syscall::Getrusage),
            109 => Some(Syscall::Realpath),
            110 => Some(Syscall::Sigsuspend),
            111 => Some(Syscall::Pause),
            112 => Some(Syscall::Pathconf),
            113 => Some(Syscall::Fpathconf),
            114 => Some(Syscall::Getsockname),
            115 => Some(Syscall::Getpeername),
            116 => Some(Syscall::Rewinddir),
            117 => Some(Syscall::Telldir),
            118 => Some(Syscall::Seekdir),
            122 => Some(Syscall::Getdents64),
            123 => Some(Syscall::ClockGetres),
            124 => Some(Syscall::ClockNanosleep),
            125 => Some(Syscall::Utimensat),
            126 => Some(Syscall::Mremap),
            127 => Some(Syscall::Fchdir),
            128 => Some(Syscall::Madvise),
            129 => Some(Syscall::Statfs),
            130 => Some(Syscall::Fstatfs),
            131 => Some(Syscall::Setresuid),
            132 => Some(Syscall::Getresuid),
            133 => Some(Syscall::Setresgid),
            134 => Some(Syscall::Getresgid),
            135 => Some(Syscall::Getgroups),
            136 => Some(Syscall::Setgroups),
            137 => Some(Syscall::Sendmsg),
            138 => Some(Syscall::Recvmsg),
            139 => Some(Syscall::Wait4),
            140 => Some(Syscall::Getaddrinfo),
            _ => None,
        }
    }
}

/// ABI-visible names accepted by `pathconf()` and `fpathconf()`.
///
/// These values are consumed by libc, the kernel, and the generated host
/// bindings. Keep the numeric contract centralized here rather than copying
/// the `_PC_*` numbering into each layer.
pub mod pathconf {
    pub const LINK_MAX: i32 = 0;
    pub const MAX_CANON: i32 = 1;
    pub const MAX_INPUT: i32 = 2;
    pub const NAME_MAX: i32 = 3;
    pub const PATH_MAX: i32 = 4;
    pub const PIPE_BUF: i32 = 5;
    pub const CHOWN_RESTRICTED: i32 = 6;
    pub const NO_TRUNC: i32 = 7;
    pub const VDISABLE: i32 = 8;
    pub const SYNC_IO: i32 = 9;
    pub const ASYNC_IO: i32 = 10;
    pub const PRIO_IO: i32 = 11;
    pub const SOCK_MAXBUF: i32 = 12;
    pub const FILESIZEBITS: i32 = 13;
    pub const REC_INCR_XFER_SIZE: i32 = 14;
    pub const REC_MAX_XFER_SIZE: i32 = 15;
    pub const REC_MIN_XFER_SIZE: i32 = 16;
    pub const REC_XFER_ALIGN: i32 = 17;
    pub const ALLOC_SIZE_MIN: i32 = 18;
    pub const SYMLINK_MAX: i32 = 19;
    pub const POSIX2_SYMLINKS: i32 = 20;
    pub const FALLOC: i32 = 21;
    pub const TEXTDOMAIN_MAX: i32 = 22;
    pub const TIMESTAMP_RESOLUTION: i32 = 23;

    pub const ABI_NAMES: &[(&str, i32)] = &[
        ("LINK_MAX", LINK_MAX),
        ("MAX_CANON", MAX_CANON),
        ("MAX_INPUT", MAX_INPUT),
        ("NAME_MAX", NAME_MAX),
        ("PATH_MAX", PATH_MAX),
        ("PIPE_BUF", PIPE_BUF),
        ("CHOWN_RESTRICTED", CHOWN_RESTRICTED),
        ("NO_TRUNC", NO_TRUNC),
        ("VDISABLE", VDISABLE),
        ("SYNC_IO", SYNC_IO),
        ("ASYNC_IO", ASYNC_IO),
        ("PRIO_IO", PRIO_IO),
        ("SOCK_MAXBUF", SOCK_MAXBUF),
        ("FILESIZEBITS", FILESIZEBITS),
        ("REC_INCR_XFER_SIZE", REC_INCR_XFER_SIZE),
        ("REC_MAX_XFER_SIZE", REC_MAX_XFER_SIZE),
        ("REC_MIN_XFER_SIZE", REC_MIN_XFER_SIZE),
        ("REC_XFER_ALIGN", REC_XFER_ALIGN),
        ("ALLOC_SIZE_MIN", ALLOC_SIZE_MIN),
        ("SYMLINK_MAX", SYMLINK_MAX),
        ("POSIX2_SYMLINKS", POSIX2_SYMLINKS),
        ("FALLOC", FALLOC),
        ("TEXTDOMAIN_MAX", TEXTDOMAIN_MAX),
        ("TIMESTAMP_RESOLUTION", TIMESTAMP_RESOLUTION),
    ];
}

/// Status of the shared-memory syscall channel.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u32)]
pub enum ChannelStatus {
    Idle = 0,
    Pending = 1,
    Complete = 2,
    Error = 3,
}

impl ChannelStatus {
    /// Convert a raw u32 value to a ChannelStatus variant.
    pub fn from_u32(val: u32) -> Option<ChannelStatus> {
        if val == Self::Idle as u32 {
            Some(Self::Idle)
        } else if val == Self::Pending as u32 {
            Some(Self::Pending)
        } else if val == Self::Complete as u32 {
            Some(Self::Complete)
        } else if val == Self::Error as u32 {
            Some(Self::Error)
        } else {
            None
        }
    }
}

/// Standard POSIX errno values.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u32)]
pub enum Errno {
    EPERM = 1,
    ENOENT = 2,
    ESRCH = 3,
    EINTR = 4,
    EIO = 5,
    ENXIO = 6,
    E2BIG = 7,
    EBADF = 9,
    ECHILD = 10,
    EAGAIN = 11,
    ENOMEM = 12,
    EACCES = 13,
    EFAULT = 14,
    EBUSY = 16,
    EEXIST = 17,
    EXDEV = 18,
    ENODEV = 19,
    ENOTDIR = 20,
    EISDIR = 21,
    EINVAL = 22,
    ENFILE = 23,
    EMFILE = 24,
    ENOTTY = 25,
    ETXTBSY = 26,
    EFBIG = 27,
    ENOSPC = 28,
    ESPIPE = 29,
    EROFS = 30,
    EMLINK = 31,
    EPIPE = 32,
    ERANGE = 34,
    EDEADLK = 35,
    ENAMETOOLONG = 36,
    ENOLCK = 37,
    ENOSYS = 38,
    ENOTEMPTY = 39,
    ELOOP = 40,
    ENOMSG = 42,
    EIDRM = 43,
    ENODATA = 61,
    EOVERFLOW = 75,
    ENOTSOCK = 88,
    EDESTADDRREQ = 89,
    EMSGSIZE = 90,
    EPROTOTYPE = 91,
    ENOPROTOOPT = 92,
    EPROTONOSUPPORT = 93,
    EOPNOTSUPP = 95,
    EAFNOSUPPORT = 97,
    EADDRINUSE = 98,
    EADDRNOTAVAIL = 99,
    ENETUNREACH = 101,
    ECONNABORTED = 103,
    ECONNRESET = 104,
    ECONNREFUSED = 111,
    EISCONN = 106,
    ENOTCONN = 107,
    ESHUTDOWN = 108,
    ETIMEDOUT = 110,
    EALREADY = 114,
    EINPROGRESS = 115,
}

impl Errno {
    /// POSIX permits ENOTSUP and EOPNOTSUPP to share one numeric value.
    pub const ENOTSUP: Self = Self::EOPNOTSUPP;

    /// Convert a raw u32 value to an Errno variant.
    pub fn from_u32(val: u32) -> Option<Errno> {
        match val {
            1 => Some(Errno::EPERM),
            2 => Some(Errno::ENOENT),
            3 => Some(Errno::ESRCH),
            4 => Some(Errno::EINTR),
            5 => Some(Errno::EIO),
            6 => Some(Errno::ENXIO),
            7 => Some(Errno::E2BIG),
            9 => Some(Errno::EBADF),
            10 => Some(Errno::ECHILD),
            11 => Some(Errno::EAGAIN),
            12 => Some(Errno::ENOMEM),
            13 => Some(Errno::EACCES),
            14 => Some(Errno::EFAULT),
            16 => Some(Errno::EBUSY),
            17 => Some(Errno::EEXIST),
            18 => Some(Errno::EXDEV),
            19 => Some(Errno::ENODEV),
            20 => Some(Errno::ENOTDIR),
            21 => Some(Errno::EISDIR),
            22 => Some(Errno::EINVAL),
            23 => Some(Errno::ENFILE),
            24 => Some(Errno::EMFILE),
            25 => Some(Errno::ENOTTY),
            26 => Some(Errno::ETXTBSY),
            27 => Some(Errno::EFBIG),
            28 => Some(Errno::ENOSPC),
            29 => Some(Errno::ESPIPE),
            30 => Some(Errno::EROFS),
            31 => Some(Errno::EMLINK),
            32 => Some(Errno::EPIPE),
            34 => Some(Errno::ERANGE),
            35 => Some(Errno::EDEADLK),
            36 => Some(Errno::ENAMETOOLONG),
            37 => Some(Errno::ENOLCK),
            38 => Some(Errno::ENOSYS),
            39 => Some(Errno::ENOTEMPTY),
            40 => Some(Errno::ELOOP),
            42 => Some(Errno::ENOMSG),
            43 => Some(Errno::EIDRM),
            61 => Some(Errno::ENODATA),
            75 => Some(Errno::EOVERFLOW),
            88 => Some(Errno::ENOTSOCK),
            89 => Some(Errno::EDESTADDRREQ),
            90 => Some(Errno::EMSGSIZE),
            91 => Some(Errno::EPROTOTYPE),
            92 => Some(Errno::ENOPROTOOPT),
            93 => Some(Errno::EPROTONOSUPPORT),
            95 => Some(Errno::EOPNOTSUPP),
            97 => Some(Errno::EAFNOSUPPORT),
            98 => Some(Errno::EADDRINUSE),
            99 => Some(Errno::EADDRNOTAVAIL),
            101 => Some(Errno::ENETUNREACH),
            103 => Some(Errno::ECONNABORTED),
            104 => Some(Errno::ECONNRESET),
            106 => Some(Errno::EISCONN),
            111 => Some(Errno::ECONNREFUSED),
            107 => Some(Errno::ENOTCONN),
            108 => Some(Errno::ESHUTDOWN),
            110 => Some(Errno::ETIMEDOUT),
            114 => Some(Errno::EALREADY),
            115 => Some(Errno::EINPROGRESS),
            _ => None,
        }
    }
}

/// File open flags (O_*).
pub mod flags {
    pub const O_RDONLY: u32 = 0;
    pub const O_WRONLY: u32 = 1;
    pub const O_RDWR: u32 = 2;
    pub const O_ACCMODE: u32 = 3;
    pub const O_CREAT: u32 = 0o100;
    pub const O_EXCL: u32 = 0o200;
    pub const O_NOCTTY: u32 = 0o400;
    pub const O_TRUNC: u32 = 0o1000;
    pub const O_APPEND: u32 = 0o2000;
    pub const O_NONBLOCK: u32 = 0o4000;
    pub const O_ASYNC: u32 = 0o20000;
    pub const O_DIRECTORY: u32 = 0o200000;
    pub const O_NOFOLLOW: u32 = 0o400000;
    pub const O_CLOEXEC: u32 = 0o2000000;
    pub const O_PATH: u32 = 0o10000000;
    pub const O_CLOFORK: u32 = 0o40000000;
    pub const AT_FDCWD: i32 = -100;
    pub const AT_SYMLINK_NOFOLLOW: u32 = 0x100;
    pub const AT_REMOVEDIR: u32 = 0x200;
    pub const AT_EMPTY_PATH: u32 = 0x1000;
}

/// File descriptor flags (FD_*).
pub mod fd_flags {
    pub const FD_CLOEXEC: u32 = 1;
    pub const FD_CLOFORK: u32 = 2;
}

/// Filesystem mount flags reported through statfs(2).
pub mod statfs_flags {
    /// Ignore set-user-ID and set-group-ID mode bits on execution.
    pub const ST_NOSUID: u32 = 0x2;
}

/// fcntl command constants (F_*).
pub mod fcntl_cmd {
    pub const F_DUPFD: u32 = 0;
    pub const F_GETFD: u32 = 1;
    pub const F_SETFD: u32 = 2;
    pub const F_GETFL: u32 = 3;
    pub const F_SETFL: u32 = 4;
    pub const F_GETLK: u32 = 12;
    pub const F_SETLK: u32 = 13;
    pub const F_SETLKW: u32 = 14;
    pub const F_SETOWN: u32 = 8;
    pub const F_GETOWN: u32 = 9;
    pub const F_DUPFD_CLOEXEC: u32 = 1030;
    pub const F_DUPFD_CLOFORK: u32 = 1028;
    pub const F_OFD_GETLK: u32 = 36;
    pub const F_OFD_SETLK: u32 = 37;
    pub const F_OFD_SETLKW: u32 = 38;
}

/// `prctl(2)` operation constants implemented by the kernel.
pub mod prctl {
    pub const PR_SET_NAME: u32 = 15;
    pub const PR_GET_NAME: u32 = 16;
}

/// Lock type constants for advisory record locking.
pub mod lock_type {
    pub const F_RDLCK: u32 = 0;
    pub const F_WRLCK: u32 = 1;
    pub const F_UNLCK: u32 = 2;
}

/// BSD flock() operation constants.
pub mod flock_op {
    pub const LOCK_SH: u32 = 1;
    pub const LOCK_EX: u32 = 2;
    pub const LOCK_UN: u32 = 8;
    pub const LOCK_NB: u32 = 4;
}

/// Memory mapping constants.
pub mod mmap {
    // Protection flags (largely ignored in Wasm, but tracked for compatibility)
    pub const PROT_NONE: u32 = 0;
    pub const PROT_READ: u32 = 1;
    pub const PROT_WRITE: u32 = 2;
    pub const PROT_EXEC: u32 = 4;

    // Map flags
    pub const MAP_SHARED: u32 = 0x01;
    pub const MAP_PRIVATE: u32 = 0x02;
    pub const MAP_FIXED: u32 = 0x10;
    pub const MAP_ANONYMOUS: u32 = 0x20;
    pub const MAP_ANON: u32 = MAP_ANONYMOUS;

    // Return value for failure (usize::MAX — works for both wasm32 and wasm64)
    pub const MAP_FAILED: usize = usize::MAX;
}

/// Socket constants.
pub mod socket {
    pub const AF_UNIX: u32 = 1;
    pub const AF_INET: u32 = 2;
    pub const AF_INET6: u32 = 10;
    pub const SOCK_STREAM: u32 = 1;
    pub const SOCK_DGRAM: u32 = 2;
    pub const SOCK_NONBLOCK: u32 = 0o4000;
    pub const SOCK_CLOEXEC: u32 = 0o2000000;
    pub const SOL_SOCKET: u32 = 1;
    pub const SCM_RIGHTS: u32 = 1;
    /// Serialized width of one file descriptor in SCM_RIGHTS payload data.
    pub const SCM_RIGHTS_FD_BYTES: usize = 4;
    /// Exact iovec-record count in a nonempty flattened kernel message wire.
    ///
    /// WHY: public sendmsg/recvmsg still accept IOV_MAX native entries. The
    /// host flattens or scatters those entries through one canonical scratch
    /// iovec so Rust never interprets a caller-width table. An empty caller
    /// list uses zero records; every nonempty list uses exactly this count.
    pub const KERNEL_MESSAGE_WIRE_FLATTENED_IOVEC_COUNT: u32 = 1;
    pub const SCM_CREDENTIALS: u32 = 2;
    pub const SO_REUSEADDR: u32 = 2;
    pub const SO_ERROR: u32 = 4;
    pub const SO_KEEPALIVE: u32 = 9;
    pub const SO_RCVBUF: u32 = 8;
    pub const SO_SNDBUF: u32 = 7;
    pub const SO_TYPE: u32 = 3;
    pub const SO_DOMAIN: u32 = 39;
    pub const SO_ACCEPTCONN: u32 = 30;
    pub const SO_REUSEPORT: u32 = 15;
    pub const SO_PASSCRED: u32 = 16;
    pub const SHUT_RD: u32 = 0;
    pub const SHUT_WR: u32 = 1;
    pub const SHUT_RDWR: u32 = 2;
    pub const SO_BROADCAST: u32 = 6;
    pub const SO_LINGER: u32 = 13;
    pub const SO_BINDTODEVICE: u32 = 25;
    pub const SO_ATTACH_REUSEPORT_CBPF: u32 = 51;
    pub const SO_ZEROCOPY: u32 = 60;
    // Traditional Linux numbers used when `long` is 64 bits (including
    // wasm64). The time64 aliases below are used when `long` is 32 bits.
    pub const SO_RCVTIMEO_OLD: u32 = 20;
    pub const SO_SNDTIMEO_OLD: u32 = 21;
    // time64 values used by musl on wasm32 (where __LONG_MAX == 0x7fffffff)
    pub const SO_RCVTIMEO: u32 = 66;
    pub const SO_SNDTIMEO: u32 = 67;
    pub const IPPROTO_IP: u32 = 0;
    pub const IPPROTO_TCP: u32 = 6;
    pub const IPPROTO_UDP: u32 = 17;
    pub const IPPROTO_IPV6: u32 = 41;
    pub const IP_TOS: u32 = 1;
    pub const IP_PKTINFO: u32 = 8;
    pub const IP_MTU_DISCOVER: u32 = 10;
    pub const IP_MTU: u32 = 14;
    pub const IP_MULTICAST_IF: u32 = 32;
    pub const IP_MULTICAST_TTL: u32 = 33;
    pub const IP_MULTICAST_LOOP: u32 = 34;
    pub const IP_ADD_MEMBERSHIP: u32 = 35;
    pub const IP_DROP_MEMBERSHIP: u32 = 36;
    pub const IP_UNBLOCK_SOURCE: u32 = 37;
    pub const IP_BLOCK_SOURCE: u32 = 38;
    pub const IP_ADD_SOURCE_MEMBERSHIP: u32 = 39;
    pub const IP_DROP_SOURCE_MEMBERSHIP: u32 = 40;
    pub const IP_MSFILTER: u32 = 41;
    pub const MCAST_JOIN_GROUP: u32 = 42;
    pub const MCAST_BLOCK_SOURCE: u32 = 43;
    pub const MCAST_UNBLOCK_SOURCE: u32 = 44;
    pub const MCAST_LEAVE_GROUP: u32 = 45;
    pub const MCAST_JOIN_SOURCE_GROUP: u32 = 46;
    pub const MCAST_LEAVE_SOURCE_GROUP: u32 = 47;
    pub const MCAST_MSFILTER: u32 = 48;
    pub const IP_MULTICAST_ALL: u32 = 49;
    pub const TCP_NODELAY: u32 = 1;
    pub const TCP_CORK: u32 = 3;
    pub const TCP_KEEPIDLE: u32 = 4;
    pub const TCP_KEEPINTVL: u32 = 5;
    pub const TCP_KEEPCNT: u32 = 6;
    pub const TCP_DEFER_ACCEPT: u32 = 9;
    pub const TCP_INFO: u32 = 11;
    pub const TCP_QUICKACK: u32 = 12;
    pub const TCP_CONGESTION: u32 = 13;
    pub const TCP_USER_TIMEOUT: u32 = 18;
    pub const IPV6_MULTICAST_IF: u32 = 17;
    pub const IPV6_MULTICAST_HOPS: u32 = 18;
    pub const IPV6_MULTICAST_LOOP: u32 = 19;
    pub const IPV6_V6ONLY: u32 = 26;
    pub const IPV6_RECVPKTINFO: u32 = 49;
    pub const IPV6_PKTINFO: u32 = 50;
    pub const IPV6_DONTFRAG: u32 = 62;
    pub const IPV6_RECVTCLASS: u32 = 66;
    pub const IPV6_TCLASS: u32 = 67;
    pub const MSG_OOB: u32 = 1;
    pub const MSG_PEEK: u32 = 2;
    pub const MSG_CTRUNC: u32 = 0x08;
    pub const MSG_TRUNC: u32 = 0x20;
    pub const MSG_DONTWAIT: u32 = 64;
    pub const MSG_NOSIGNAL: u32 = 0x4000;
    pub const MSG_CMSG_CLOEXEC: u32 = 0x4000_0000;
}

/// Poll constants.
pub mod poll {
    pub const POLLIN: i16 = 0x0001;
    pub const POLLPRI: i16 = 0x0002;
    pub const POLLOUT: i16 = 0x0004;
    pub const POLLERR: i16 = 0x0008;
    pub const POLLHUP: i16 = 0x0010;
    pub const POLLNVAL: i16 = 0x0020;
}

/// Epoll event constants.
pub mod epoll {
    pub const EPOLLIN: u32 = 0x0001;
    pub const EPOLLOUT: u32 = 0x0004;
    pub const EPOLLERR: u32 = 0x0008;
    pub const EPOLLHUP: u32 = 0x0010;
}

/// Seek whence constants.
pub mod seek {
    pub const SEEK_SET: u32 = 0;
    pub const SEEK_CUR: u32 = 1;
    pub const SEEK_END: u32 = 2;
}

/// Access mode constants for access()/faccessat().
pub mod access {
    pub const F_OK: u32 = 0;
    pub const R_OK: u32 = 4;
    pub const W_OK: u32 = 2;
    pub const X_OK: u32 = 1;
}

/// Directory entry type constants (DT_*).
pub mod dirent {
    pub const DT_UNKNOWN: u32 = 0;
    pub const DT_FIFO: u32 = 1;
    pub const DT_CHR: u32 = 2;
    pub const DT_DIR: u32 = 4;
    pub const DT_BLK: u32 = 6;
    pub const DT_REG: u32 = 8;
    pub const DT_LNK: u32 = 10;
    pub const DT_SOCK: u32 = 12;
}

/// File mode and type constants (S_*).
pub mod mode {
    // File type mask and values
    pub const S_IFMT: u32 = 0o170000;
    pub const S_IFSOCK: u32 = 0o140000;
    pub const S_IFLNK: u32 = 0o120000;
    pub const S_IFREG: u32 = 0o100000;
    pub const S_IFBLK: u32 = 0o060000;
    pub const S_IFDIR: u32 = 0o040000;
    pub const S_IFCHR: u32 = 0o020000;
    pub const S_IFIFO: u32 = 0o010000;

    // Special permission bits
    pub const S_ISUID: u32 = 0o4000;
    pub const S_ISGID: u32 = 0o2000;
    pub const S_ISVTX: u32 = 0o1000;

    // Owner permissions
    pub const S_IRWXU: u32 = 0o700;
    pub const S_IRUSR: u32 = 0o400;
    pub const S_IWUSR: u32 = 0o200;
    pub const S_IXUSR: u32 = 0o100;

    // Group permissions
    pub const S_IRWXG: u32 = 0o070;
    pub const S_IRGRP: u32 = 0o040;
    pub const S_IWGRP: u32 = 0o020;
    pub const S_IXGRP: u32 = 0o010;

    // Other permissions
    pub const S_IRWXO: u32 = 0o007;
    pub const S_IROTH: u32 = 0o004;
    pub const S_IWOTH: u32 = 0o002;
    pub const S_IXOTH: u32 = 0o001;

    pub const S_MODE_BITS: u32 =
        S_ISUID | S_ISGID | S_ISVTX | S_IRWXU | S_IRWXG | S_IRWXO;
}

/// Shared-memory channel layout offsets and sizes.
///
/// Channel layout (i64 args for wasm32/wasm64 dual ABI):
///   Offset  Size  Field
///   0       4B    status (i32 atomic — must stay i32 for Atomics.wait32)
///   4       4B    syscall number (i32)
///   8       48B   arguments (6 × i64)
///   56      8B    return value (i64)
///   64      4B    errno (i32)
///   68      4B    request flags (u32)
///   72      64KB  data transfer buffer
pub mod channel {
    use super::kernel_scratch_wire;
    use core::mem::size_of;

    /// Byte offset of the status field (i32, atomic).
    pub const STATUS_OFFSET: usize = 0;
    pub const STATUS_SIZE: usize = size_of::<u32>();
    /// Byte offset of the syscall number field (i32).
    pub const SYSCALL_OFFSET: usize = STATUS_OFFSET + STATUS_SIZE;
    pub const SYSCALL_SIZE: usize = size_of::<u32>();
    /// Byte offset of the first argument slot (i64 each, 8 bytes).
    pub const ARGS_OFFSET: usize = SYSCALL_OFFSET + SYSCALL_SIZE;
    /// Number of argument slots.
    pub const ARGS_COUNT: usize = 6;
    /// Size of each argument slot in bytes.
    pub const ARG_SIZE: usize = size_of::<i64>();
    /// Byte offset of the return value field (i64).
    pub const RETURN_OFFSET: usize = ARGS_OFFSET + ARGS_COUNT * ARG_SIZE;
    pub const RETURN_SIZE: usize = size_of::<i64>();
    /// Byte offset of the errno field (i32).
    pub const ERRNO_OFFSET: usize = RETURN_OFFSET + RETURN_SIZE;
    pub const ERRNO_SIZE: usize = size_of::<u32>();
    /// Byte offset of request flags written before the PENDING publication.
    pub const REQUEST_FLAGS_OFFSET: usize = ERRNO_OFFSET + ERRNO_SIZE;
    pub const REQUEST_FLAGS_SIZE: usize = size_of::<u32>();
    /// This request entered libc through `__syscall_cp`, not a plain
    /// `__syscallN` wrapper for the same syscall number.
    pub const REQUEST_FLAG_CANCELLATION_POINT: u32 = 1 << 0;
    /// The cancellation-point request may be interrupted for pthread_cancel.
    ///
    /// A target in PTHREAD_CANCEL_DISABLE still publishes cancellation-point
    /// identity, but omits this bit so the host records cancellation without
    /// disturbing the already-blocked operation or resetting its deadline.
    pub const REQUEST_FLAG_CANCELLATION_WAKE_ALLOWED: u32 = 1 << 1;
    /// The request completion is consumed by process-worker JavaScript, not
    /// the libc channel trampoline. Caught signals must remain kernel-pending
    /// until an explicit guest checkpoint can invoke the handler after the
    /// owning host transition returns.
    pub const REQUEST_FLAG_DEFER_SIGNAL_DELIVERY: u32 = 1 << 2;
    /// Every request flag understood by this ABI epoch.
    pub const REQUEST_FLAGS_KNOWN_MASK: u32 = REQUEST_FLAG_CANCELLATION_POINT
        | REQUEST_FLAG_CANCELLATION_WAKE_ALLOWED
        | REQUEST_FLAG_DEFER_SIGNAL_DELIVERY;
    /// Total header size before data buffer.
    pub const HEADER_SIZE: usize = REQUEST_FLAGS_OFFSET + REQUEST_FLAGS_SIZE;
    /// Byte offset of the data buffer region.
    pub const DATA_OFFSET: usize = HEADER_SIZE;
    /// Size of the data buffer.
    pub const DATA_SIZE: usize = 65536;
    /// Minimum total size of a channel in bytes (header + 64 KiB data buffer).
    pub const MIN_CHANNEL_SIZE: usize = HEADER_SIZE + DATA_SIZE;

    // Signal delivery area — reserved at the end of the data buffer.
    // After each syscall, if a signal with a Handler disposition is pending,
    // the kernel writes delivery info here so the glue code can invoke it.
    /// Bytes populated by the kernel signal-delivery wire.
    pub const SIG_DELIVERY_SIZE: usize = kernel_scratch_wire::SIGNAL_DELIVERY_BYTES as usize;
    /// Keep the reserved tail naturally aligned even though the wire is packed.
    pub const SIG_AREA_ALIGNMENT: usize = core::mem::align_of::<u64>();
    /// Complete reserved signal area, including any trailing alignment pad.
    pub const SIG_AREA_SIZE: usize =
        (SIG_DELIVERY_SIZE + SIG_AREA_ALIGNMENT - 1) / SIG_AREA_ALIGNMENT * SIG_AREA_ALIGNMENT;
    /// Base offset of signal delivery area.
    pub const SIG_BASE: usize = DATA_OFFSET + DATA_SIZE - SIG_AREA_SIZE;
    /// Signal number to deliver (u32). 0 = no signal.
    pub const SIG_SIGNUM: usize = SIG_BASE + kernel_scratch_wire::SIGNAL_SIGNUM_OFFSET;
    /// Handler function table index (u32).
    pub const SIG_HANDLER: usize = SIG_BASE + kernel_scratch_wire::SIGNAL_HANDLER_OFFSET;
    /// sa_flags from sigaction (u32).
    pub const SIG_FLAGS: usize = SIG_BASE + kernel_scratch_wire::SIGNAL_FLAGS_OFFSET;
    /// Raw `union sigval` payload bits (u64).
    ///
    /// wasm32 callers use the low 32 bits. Keeping the channel field at the
    /// widest supported pointer width lets wasm64 `sival_ptr` values survive
    /// delivery without narrowing.
    pub const SIG_SI_VALUE: usize = SIG_BASE + kernel_scratch_wire::SIGNAL_SI_VALUE_OFFSET;
    /// Saved blocked mask before handler (u64, little-endian).
    pub const SIG_OLD_MASK: usize = SIG_BASE + kernel_scratch_wire::SIGNAL_OLD_MASK_OFFSET;
    /// siginfo si_code (i32).
    pub const SIG_SI_CODE: usize = SIG_BASE + kernel_scratch_wire::SIGNAL_SI_CODE_OFFSET;
    /// First siginfo union word: pid for ordinary signals, timer ID for SI_TIMER.
    pub const SIGINFO_WORD_1: usize = SIG_BASE + kernel_scratch_wire::SIGNAL_SIGINFO_WORD_1_OFFSET;
    /// Second siginfo union word: uid for ordinary signals, overrun for SI_TIMER.
    pub const SIGINFO_WORD_2: usize = SIG_BASE + kernel_scratch_wire::SIGNAL_SIGINFO_WORD_2_OFFSET;
    /// Alternate signal-stack pointer, or zero when no switch is needed.
    pub const SIG_ALT_SP: usize = SIG_BASE + kernel_scratch_wire::SIGNAL_ALT_SP_OFFSET;
    /// Alternate signal-stack size.
    pub const SIG_ALT_SIZE: usize = SIG_BASE + kernel_scratch_wire::SIGNAL_ALT_SIZE_OFFSET;

    // Checkpoint request area — reserved immediately below the signal delivery
    // area, at the end of the data buffer. The host writes the request word
    // before it completes a process's pending syscall. The glue reads it at the
    // same post-syscall hook that delivers a signal, and calls
    // `kernel.kernel_checkpoint` when it is set.
    //
    // This is not the libc `__wasm_posix_signal_checkpoint` trampoline, which
    // re-enters one channel completion so a deferred signal handler can run.
    /// Bytes the checkpoint request wire occupies.
    pub const CHECKPOINT_WIRE_SIZE: usize = size_of::<u32>();
    /// Keep the reserved tail naturally aligned even though the wire is packed.
    pub const CHECKPOINT_AREA_ALIGNMENT: usize = core::mem::align_of::<u64>();
    /// Complete reserved checkpoint area, including any trailing alignment pad.
    pub const CHECKPOINT_AREA_SIZE: usize = (CHECKPOINT_WIRE_SIZE + CHECKPOINT_AREA_ALIGNMENT - 1)
        / CHECKPOINT_AREA_ALIGNMENT
        * CHECKPOINT_AREA_ALIGNMENT;
    /// Base offset of the checkpoint request area.
    pub const CHECKPOINT_BASE: usize = SIG_BASE - CHECKPOINT_AREA_SIZE;
    /// The checkpoint request word (u32), a bit set. 0 = no request.
    ///
    /// The host publishes it; the guest clears it once it has taken the
    /// request, so a later syscall on the same channel does not unwind again.
    pub const CHECKPOINT_REQUEST: usize = CHECKPOINT_BASE;
    /// Request bit: unwind this process's call stack into its linear memory.
    pub const CHECKPOINT_REQUEST_UNWIND: u32 = 1;
    /// Request bit: resubmit the syscall this request rode in on.
    ///
    /// The freeze completes a parked syscall with `EINTR` to reach a boundary
    /// the process would otherwise never reach. No signal was caught, so the
    /// process is owed the call it was making rather than an interruption.
    /// This bit is what tells the guest to make that call again.
    pub const CHECKPOINT_REQUEST_RESTART: u32 = 2;
    /// Every request bit the host may publish.
    pub const CHECKPOINT_REQUEST_KNOWN_MASK: u32 =
        CHECKPOINT_REQUEST_UNWIND | CHECKPOINT_REQUEST_RESTART;
}

#[cfg(test)]
mod channel_abi_tests {
    use super::{channel, kernel_scratch_wire};

    #[test]
    fn signal_delivery_wire_fits_the_reserved_channel_tail() {
        assert_eq!(channel::SYSCALL_OFFSET, channel::STATUS_SIZE);
        assert_eq!(
            channel::ARGS_OFFSET,
            channel::SYSCALL_OFFSET + channel::SYSCALL_SIZE,
        );
        assert_eq!(
            channel::RETURN_OFFSET,
            channel::ARGS_OFFSET + channel::ARGS_COUNT * channel::ARG_SIZE,
        );
        assert_eq!(
            channel::ERRNO_OFFSET,
            channel::RETURN_OFFSET + channel::RETURN_SIZE,
        );
        assert_eq!(
            channel::REQUEST_FLAGS_OFFSET,
            channel::ERRNO_OFFSET + channel::ERRNO_SIZE,
        );
        assert_eq!(
            channel::DATA_OFFSET,
            channel::REQUEST_FLAGS_OFFSET + channel::REQUEST_FLAGS_SIZE,
        );
        assert_eq!(
            channel::REQUEST_FLAGS_KNOWN_MASK,
            channel::REQUEST_FLAG_CANCELLATION_POINT
                | channel::REQUEST_FLAG_CANCELLATION_WAKE_ALLOWED
                | channel::REQUEST_FLAG_DEFER_SIGNAL_DELIVERY,
        );
        assert_eq!(
            channel::SIG_BASE + channel::SIG_AREA_SIZE,
            channel::DATA_OFFSET + channel::DATA_SIZE,
        );
        assert_eq!(
            channel::SIG_ALT_SIZE + kernel_scratch_wire::SIGNAL_ALT_SIZE_BYTES,
            channel::SIG_BASE + channel::SIG_DELIVERY_SIZE,
        );
        assert_eq!(
            channel::SIG_DELIVERY_SIZE,
            kernel_scratch_wire::SIGNAL_DELIVERY_BYTES as usize,
        );
        assert!(channel::SIG_DELIVERY_SIZE <= channel::SIG_AREA_SIZE);
        assert_eq!(channel::SIG_AREA_SIZE - channel::SIG_DELIVERY_SIZE, 0);
        assert_eq!(channel::SIG_BASE % channel::SIG_AREA_ALIGNMENT, 0);
    }

    #[test]
    fn checkpoint_request_sits_below_the_signal_area_without_moving_it() {
        assert_eq!(
            channel::CHECKPOINT_BASE + channel::CHECKPOINT_AREA_SIZE,
            channel::SIG_BASE,
        );
        assert!(
            channel::CHECKPOINT_REQUEST + channel::CHECKPOINT_WIRE_SIZE <= channel::SIG_BASE,
        );
        assert_eq!(channel::CHECKPOINT_BASE % channel::CHECKPOINT_AREA_ALIGNMENT, 0);
        assert!(channel::CHECKPOINT_BASE >= channel::DATA_OFFSET);
        assert_ne!(channel::CHECKPOINT_REQUEST_UNWIND, 0);
        assert_ne!(channel::CHECKPOINT_REQUEST_RESTART, 0);
        assert_eq!(
            channel::CHECKPOINT_REQUEST_UNWIND & channel::CHECKPOINT_REQUEST_RESTART,
            0,
        );
        assert_eq!(
            channel::CHECKPOINT_REQUEST_KNOWN_MASK,
            channel::CHECKPOINT_REQUEST_UNWIND | channel::CHECKPOINT_REQUEST_RESTART,
        );
    }
}

/// Stat structure for the Wasm POSIX interface.
///
/// Uses `repr(C)` for a stable, predictable memory layout that can be
/// shared across the Wasm shared-memory boundary.
#[derive(Debug, Clone, Copy)]
#[repr(C)]
pub struct WasmStat {
    pub st_dev: u64,
    pub st_ino: u64,
    pub st_mode: u32,
    pub st_nlink: u32,
    pub st_uid: u32,
    pub st_gid: u32,
    pub st_size: u64,
    pub st_atime_sec: u64,
    pub st_atime_nsec: u32,
    pub st_mtime_sec: u64,
    pub st_mtime_nsec: u32,
    pub st_ctime_sec: u64,
    pub st_ctime_nsec: u32,
    pub _pad: u32,
}

/// Directory entry structure for the Wasm POSIX interface.
///
/// Uses `repr(C)` for a stable, predictable memory layout that can be
/// shared across the Wasm shared-memory boundary.
#[derive(Debug, Clone, Copy)]
#[repr(C)]
pub struct WasmDirent {
    pub d_ino: u64,
    pub d_type: u32,
    pub d_namlen: u32,
}

/// flock structure for advisory record locking.
///
/// Matches musl wasm32 layout: `short l_type, short l_whence` (with padding
/// to align off_t fields to 8 bytes), `off_t l_start`, `off_t l_len`,
/// `pid_t l_pid`, plus trailing padding for 8-byte struct alignment.
///
/// Verified offsets: l_type=0, l_whence=2, l_start=8, l_len=16, l_pid=24.
/// Total size: 32 bytes.
#[derive(Debug, Clone, Copy)]
#[repr(C)]
pub struct WasmFlock {
    pub l_type: i16,   // F_RDLCK, F_WRLCK, F_UNLCK (short)
    pub l_whence: i16, // SEEK_SET, SEEK_CUR, SEEK_END (short)
    pub _pad1: u32,    // padding to align l_start to 8 bytes
    pub l_start: i64,  // offset (off_t = long long on wasm32)
    pub l_len: i64,    // length (0 = to end of file)
    pub l_pid: u32,    // process ID (pid_t = int)
    pub _pad2: u32,    // trailing padding for struct alignment
}

/// POSIX signal constants.
pub mod signal {
    // Standard POSIX signals
    pub const SIGHUP: u32 = 1;
    pub const SIGINT: u32 = 2;
    pub const SIGQUIT: u32 = 3;
    pub const SIGILL: u32 = 4;
    pub const SIGTRAP: u32 = 5;
    pub const SIGABRT: u32 = 6;
    pub const SIGBUS: u32 = 7;
    pub const SIGFPE: u32 = 8;
    pub const SIGKILL: u32 = 9;
    pub const SIGUSR1: u32 = 10;
    pub const SIGUSR2: u32 = 12;
    pub const SIGPIPE: u32 = 13;
    pub const SIGALRM: u32 = 14;
    pub const SIGTERM: u32 = 15;
    pub const SIGCHLD: u32 = 17;
    pub const SIGCONT: u32 = 18;
    pub const SIGSTOP: u32 = 19;
    pub const SIGTSTP: u32 = 20;
    pub const SIGTTIN: u32 = 21;
    pub const SIGTTOU: u32 = 22;
    pub const SIGXCPU: u32 = 24;
    pub const SIGXFSZ: u32 = 25;
    pub const SIGWINCH: u32 = 28;

    // One past the maximum signal number (matches musl _NSIG=65).
    // Valid signals are 1..NSIG-1 (i.e. 1..64 inclusive).
    pub const NSIG: u32 = 65;

    // Signal handler special values
    pub const SIG_DFL: u32 = 0;
    pub const SIG_IGN: u32 = 1;

    // sigprocmask how values
    pub const SIG_BLOCK: u32 = 0;
    pub const SIG_UNBLOCK: u32 = 1;
    pub const SIG_SETMASK: u32 = 2;

    // sigaction sa_flags
    pub const SA_RESTART: u32 = 0x10000000;
    pub const SA_NOCLDSTOP: u32 = 1;
    pub const SA_NOCLDWAIT: u32 = 2;
    pub const SA_SIGINFO: u32 = 4;
    pub const SA_RESTORER: u32 = 0x04000000;

    // Default actions
    pub const SA_DEFAULT_TERM: u32 = 0; // Terminate
    pub const SA_DEFAULT_IGN: u32 = 1; // Ignore
    pub const SA_DEFAULT_CORE: u32 = 2; // Core dump (treated as terminate in Wasm)
    pub const SA_DEFAULT_STOP: u32 = 3; // Stop until a continue transition
    pub const SA_DEFAULT_CONT: u32 = 4; // Continue a stopped process
}

/// Resource limit constants for getrlimit/setrlimit.
pub mod rlimit {
    pub const RLIMIT_CPU: u32 = 0;
    pub const RLIMIT_FSIZE: u32 = 1;
    pub const RLIMIT_DATA: u32 = 2;
    pub const RLIMIT_STACK: u32 = 3;
    pub const RLIMIT_CORE: u32 = 4;
    pub const RLIMIT_NOFILE: u32 = 7;
    pub const RLIMIT_AS: u32 = 9;
    pub const RLIMIT_NPROC: u32 = 6;
    pub const RLIM_NLIMITS: usize = 16;
    pub const RLIM_INFINITY: u64 = u64::MAX;
}

/// getrusage who constants.
pub mod rusage {
    pub const RUSAGE_SELF: i32 = 0;
    pub const RUSAGE_CHILDREN: i32 = -1;
}

/// Process-wait event, option, result, and host-wakeup constants.
pub mod wait {
    /// A child exit event is eligible for selection.
    pub const EVENT_EXITED: u32 = 1;
    /// A child stop event is eligible for selection.
    pub const EVENT_STOPPED: u32 = 2;
    /// A child continue event is eligible for selection.
    pub const EVENT_CONTINUED: u32 = 4;

    pub const WNOHANG: u32 = 1;
    pub const WUNTRACED: u32 = 2;
    pub const WSTOPPED: u32 = WUNTRACED;
    pub const WEXITED: u32 = 4;
    pub const WCONTINUED: u32 = 8;
    pub const WNOWAIT: u32 = 0x0100_0000;

    pub const CLD_EXITED: i32 = 1;
    pub const CLD_KILLED: i32 = 2;
    pub const CLD_STOPPED: i32 = 5;
    pub const CLD_CONTINUED: i32 = 6;

    pub const PROCESS_STATE_RUNNING: i32 = 0;
    pub const PROCESS_STATE_STOPPED: i32 = 1;
    pub const PROCESS_STATE_EXITED: i32 = 2;

    /// Host retry wake reason: the process entered a stopped state.
    pub const WAKE_PROCESS_STOPPED: u8 = super::wakeup_event_wire::TYPE_PROCESS_STOPPED;
    /// Host retry wake reason: the process resumed from a stopped state.
    pub const WAKE_PROCESS_CONTINUED: u8 = super::wakeup_event_wire::TYPE_PROCESS_CONTINUED;
}

/// Fixed-width kernel/musl resource-usage wire record.
///
/// This is not musl's public `struct rusage`, whose size depends on the
/// target's `long` width. Both wasm32 and wasm64 exchange the meaningful
/// prefix as eighteen little-endian 64-bit slots.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
#[repr(C)]
pub struct WasmRusageWire {
    pub ru_utime_sec: i64,
    pub ru_utime_usec: i64,
    pub ru_stime_sec: i64,
    pub ru_stime_usec: i64,
    pub ru_maxrss: i64,
    pub ru_ixrss: i64,
    pub ru_idrss: i64,
    pub ru_isrss: i64,
    pub ru_minflt: i64,
    pub ru_majflt: i64,
    pub ru_nswap: i64,
    pub ru_inblock: i64,
    pub ru_oublock: i64,
    pub ru_msgsnd: i64,
    pub ru_msgrcv: i64,
    pub ru_nsignals: i64,
    pub ru_nvcsw: i64,
    pub ru_nivcsw: i64,
}

/// Compatibility name used by kernel-side wait/resource-usage code.
pub type KernelRusage = WasmRusageWire;

pub const WASM_RUSAGE_WIRE_SIZE: u32 = core::mem::size_of::<WasmRusageWire>() as u32;

/// Fixed result record written by `kernel_wait_child_poll`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
#[repr(C)]
pub struct KernelWaitResult {
    pub wait_status: i32,
    pub si_code: i32,
    pub si_status: i32,
    pub child_uid: u32,
    pub rusage: WasmRusageWire,
}

pub const KERNEL_WAIT_RESULT_SIZE: u32 = core::mem::size_of::<KernelWaitResult>() as u32;

/// Fixed host/kernel records borrowed through kernel-owned scratch.
///
/// These are representation limits, not public POSIX limits. Keeping them in
/// the shared ABI source lets Rust validate every explicit export capacity and
/// lets generated host code size the matching opaque borrow without copying
/// protocol literals across languages.
pub mod kernel_scratch_wire {
    use super::WasmFlock;
    use core::mem::size_of;

    pub const SIGNAL_WORD_BYTES: usize = size_of::<u32>();
    pub const SIGNAL_SI_VALUE_BYTES: usize = size_of::<u64>();
    pub const SIGNAL_OLD_MASK_BYTES: usize = size_of::<u64>();
    pub const SIGNAL_ALT_SP_BYTES: usize = size_of::<u64>();
    pub const SIGNAL_ALT_SIZE_BYTES: usize = size_of::<u64>();
    pub const SIGNAL_SIGNUM_OFFSET: usize = 0;
    pub const SIGNAL_HANDLER_OFFSET: usize = SIGNAL_SIGNUM_OFFSET + SIGNAL_WORD_BYTES;
    pub const SIGNAL_FLAGS_OFFSET: usize = SIGNAL_HANDLER_OFFSET + SIGNAL_WORD_BYTES;
    pub const SIGNAL_SI_VALUE_OFFSET: usize = SIGNAL_FLAGS_OFFSET + SIGNAL_WORD_BYTES;
    pub const SIGNAL_OLD_MASK_OFFSET: usize = SIGNAL_SI_VALUE_OFFSET + SIGNAL_SI_VALUE_BYTES;
    pub const SIGNAL_SI_CODE_OFFSET: usize = SIGNAL_OLD_MASK_OFFSET + SIGNAL_OLD_MASK_BYTES;
    pub const SIGNAL_SIGINFO_WORD_1_OFFSET: usize = SIGNAL_SI_CODE_OFFSET + SIGNAL_WORD_BYTES;
    pub const SIGNAL_SIGINFO_WORD_2_OFFSET: usize =
        SIGNAL_SIGINFO_WORD_1_OFFSET + SIGNAL_WORD_BYTES;
    pub const SIGNAL_ALT_SP_OFFSET: usize = SIGNAL_SIGINFO_WORD_2_OFFSET + SIGNAL_WORD_BYTES;
    pub const SIGNAL_ALT_SIZE_OFFSET: usize = SIGNAL_ALT_SP_OFFSET + SIGNAL_ALT_SP_BYTES;
    pub const SIGNAL_DELIVERY_BYTES: u32 = (SIGNAL_ALT_SIZE_OFFSET + SIGNAL_ALT_SIZE_BYTES) as u32;
    pub const FD_PAIR_BYTES: u32 = 8;
    pub const MQUEUE_NOTIFICATION_BYTES: u32 = 8;
    pub const SOCKLEN_BYTES: u32 = 4;
    /// Complete generic native socket-address container accepted or produced
    /// at the syscall boundary (`struct sockaddr_storage`).
    pub const SOCKADDR_STORAGE_BYTES: u32 = 128;
    /// Offset of `sockaddr_un.sun_path` after `sa_family_t`.
    pub const SOCKADDR_UNIX_PATH_OFFSET_BYTES: u32 = 2;
    /// Native `sockaddr_un.sun_path` field capacity.
    pub const SOCKADDR_UNIX_PATH_BYTES: u32 = 108;
    /// Native AF_UNIX structure capacity.
    ///
    /// WHY: generic staging must accept a full `sockaddr_storage`, while
    /// Rust's family parser must still reject AF_UNIX names that do not fit
    /// the concrete `sockaddr_un` structure.
    pub const SOCKADDR_UNIX_BYTES: u32 =
        SOCKADDR_UNIX_PATH_OFFSET_BYTES + SOCKADDR_UNIX_PATH_BYTES;
    /// Largest value currently produced by getsockopt (`struct tcp_info`).
    pub const SOCKET_OPTION_MAX_BYTES: u32 = 232;
    /// Largest currently accepted setsockopt record (`group_source_req` on
    /// wasm64). Individual option parsers still enforce their exact layouts.
    pub const SOCKET_OPTION_INPUT_MAX_BYTES: u32 = 264;
    pub const PRCTL_NAME_BYTES: u32 = 16;
    pub const FCNTL_FLOCK_BYTES: u32 = size_of::<WasmFlock>() as u32;
    pub const SIGNAL_MASK_BYTES: u32 = size_of::<u64>() as u32;
}

#[cfg(test)]
mod wait_abi_tests {
    use super::{KernelWaitResult, WasmRusageWire, KERNEL_WAIT_RESULT_SIZE, WASM_RUSAGE_WIRE_SIZE};
    use core::mem::{offset_of, size_of};

    #[test]
    fn rusage_wire_layout_is_eighteen_i64_slots() {
        assert_eq!(WASM_RUSAGE_WIRE_SIZE, 144);
        assert_eq!(size_of::<WasmRusageWire>(), 144);
        assert_eq!(offset_of!(WasmRusageWire, ru_utime_sec), 0);
        assert_eq!(offset_of!(WasmRusageWire, ru_stime_sec), 16);
        assert_eq!(offset_of!(WasmRusageWire, ru_maxrss), 32);
        assert_eq!(offset_of!(WasmRusageWire, ru_nivcsw), 136);
    }

    #[test]
    fn kernel_wait_result_layout_is_stable() {
        assert_eq!(KERNEL_WAIT_RESULT_SIZE, 160);
        assert_eq!(size_of::<KernelWaitResult>(), 160);
        assert_eq!(offset_of!(KernelWaitResult, wait_status), 0);
        assert_eq!(offset_of!(KernelWaitResult, si_code), 4);
        assert_eq!(offset_of!(KernelWaitResult, si_status), 8);
        assert_eq!(offset_of!(KernelWaitResult, child_uid), 12);
        assert_eq!(offset_of!(KernelWaitResult, rusage), 16);
    }
}

/// select() constants.
pub mod select {
    pub const FD_SETSIZE: usize = 1024;
    /// Size of fd_set in bytes (FD_SETSIZE / 8).
    pub const FD_SET_BYTES: usize = FD_SETSIZE / 8;
}

/// Clock ID constants for clock_gettime/clock_settime.
pub mod clock {
    pub const CLOCK_REALTIME: u32 = 0;
    pub const CLOCK_MONOTONIC: u32 = 1;
    pub const CLOCK_PROCESS_CPUTIME_ID: u32 = 2;
    pub const CLOCK_THREAD_CPUTIME_ID: u32 = 3;
    pub const CLOCK_REALTIME_COARSE: u32 = 5;
    pub const CLOCK_MONOTONIC_COARSE: u32 = 6;
    pub const CLOCK_BOOTTIME: u32 = 7;
}

/// Timespec structure for the Wasm POSIX interface.
///
/// Uses `repr(C)` for a stable, predictable memory layout that can be
/// shared across the Wasm shared-memory boundary.
#[derive(Debug, Clone, Copy)]
#[repr(C)]
pub struct WasmTimespec {
    pub tv_sec: i64,
    pub tv_nsec: i64,
}

/// Poll file descriptor structure for the Wasm POSIX interface.
///
/// Uses `repr(C)` for a stable, predictable memory layout that can be
/// shared across the Wasm shared-memory boundary.
#[repr(C)]
#[derive(Debug, Clone, Copy)]
pub struct WasmPollFd {
    pub fd: i32,
    pub events: i16,
    pub revents: i16,
}

/// Fixed u32-pointer iovec used only inside kernel-owned scratch.
///
/// Guest wasm64 `struct iovec` is wider. The host validates and translates
/// caller-native records before Rust receives this width-independent wire.
#[repr(C)]
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct KernelIovecWire {
    pub base: u32,
    pub len: u32,
}

/// Fixed u32-pointer `msghdr` used only inside kernel-owned scratch.
///
/// The pointed-to name, control, iovec, and data ranges all live within the
/// same synchronously leased kernel allocation.
#[repr(C)]
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct KernelMsghdrWire {
    pub name: u32,
    pub name_len: u32,
    pub iov: u32,
    pub iov_len: u32,
    pub control: u32,
    pub control_len: u32,
    pub flags: u32,
}

/// Fixed ancillary-message header used only inside kernel-owned scratch.
///
/// This matches the wasm32 C layout by design, but it is not a caller-native
/// structure. The host translates wasm64 headers and eight-byte CMSG
/// alignment before and after the synchronous kernel call.
#[repr(C)]
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct KernelCmsghdrWire {
    pub cmsg_len: u32,
    pub cmsg_level: u32,
    pub cmsg_type: u32,
}

/// Canonical `struct epoll_event` layout used by both Kandelo musl targets.
///
/// The C ABI aligns `epoll_data_t` to eight bytes on wasm32 and wasm64, so
/// bytes 4..8 are padding. Keep this explicit: treating the record as packed
/// changes both its stride and the location of `data`.
#[repr(C)]
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct WasmEpollEvent {
    pub events: u32,
    pub _pad: u32,
    pub data: u64,
}

/// Fixed kernel-scratch header for System V message payloads.
///
/// Guest `long` is four bytes on wasm32 and eight on wasm64. The host converts
/// either native prefix to this width-independent record before invoking Rust.
#[repr(C)]
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct WasmSysvMessageHeader {
    pub mtype: i64,
}

/// Statfs structure for the Wasm POSIX interface.
///
/// Uses `repr(C)` for a stable, predictable memory layout matching
/// musl's struct statfs on 32-bit targets.
#[repr(C)]
#[derive(Debug, Clone, Copy)]
pub struct WasmStatfs {
    pub f_type: u32,
    pub f_bsize: u32,
    pub f_blocks: u64,
    pub f_bfree: u64,
    pub f_bavail: u64,
    pub f_files: u64,
    pub f_ffree: u64,
    pub f_fsid: u64,
    pub f_namelen: u32,
    pub f_frsize: u32,
    pub f_flags: u32,
    pub _pad: u32,
}

#[cfg(test)]
mod native_wire_layout_tests {
    use super::{
        kernel_scratch_wire, prctl, KernelCmsghdrWire, KernelIovecWire, KernelMsghdrWire,
        WasmEpollEvent, WasmFlock, WasmSysvMessageHeader,
    };
    use core::mem::{align_of, offset_of, size_of};

    #[test]
    fn epoll_event_layout_matches_both_kandelo_musl_targets() {
        assert_eq!(size_of::<WasmEpollEvent>(), 16);
        assert_eq!(offset_of!(WasmEpollEvent, events), 0);
        assert_eq!(offset_of!(WasmEpollEvent, _pad), 4);
        assert_eq!(offset_of!(WasmEpollEvent, data), 8);
    }

    #[test]
    fn sysv_message_header_is_one_canonical_i64() {
        assert_eq!(size_of::<WasmSysvMessageHeader>(), 8);
        assert_eq!(offset_of!(WasmSysvMessageHeader, mtype), 0);
    }

    #[test]
    fn kernel_socket_scratch_wires_use_fixed_u32_fields() {
        assert_eq!(size_of::<KernelIovecWire>(), 8);
        assert_eq!(align_of::<KernelIovecWire>(), 4);
        assert_eq!(offset_of!(KernelIovecWire, base), 0);
        assert_eq!(offset_of!(KernelIovecWire, len), 4);

        assert_eq!(size_of::<KernelMsghdrWire>(), 28);
        assert_eq!(align_of::<KernelMsghdrWire>(), 4);
        assert_eq!(offset_of!(KernelMsghdrWire, name), 0);
        assert_eq!(offset_of!(KernelMsghdrWire, name_len), 4);
        assert_eq!(offset_of!(KernelMsghdrWire, iov), 8);
        assert_eq!(offset_of!(KernelMsghdrWire, iov_len), 12);
        assert_eq!(offset_of!(KernelMsghdrWire, control), 16);
        assert_eq!(offset_of!(KernelMsghdrWire, control_len), 20);
        assert_eq!(offset_of!(KernelMsghdrWire, flags), 24);

        assert_eq!(size_of::<KernelCmsghdrWire>(), 12);
        assert_eq!(align_of::<KernelCmsghdrWire>(), 4);
        assert_eq!(offset_of!(KernelCmsghdrWire, cmsg_len), 0);
        assert_eq!(offset_of!(KernelCmsghdrWire, cmsg_level), 4);
        assert_eq!(offset_of!(KernelCmsghdrWire, cmsg_type), 8);
    }

    #[test]
    fn special_scratch_contracts_derive_record_sizes_once() {
        assert_eq!(prctl::PR_SET_NAME, 15);
        assert_eq!(prctl::PR_GET_NAME, 16);
        assert_eq!(kernel_scratch_wire::PRCTL_NAME_BYTES, 16);
        assert_eq!(
            kernel_scratch_wire::FCNTL_FLOCK_BYTES,
            size_of::<WasmFlock>() as u32,
        );
        assert_eq!(
            kernel_scratch_wire::SIGNAL_MASK_BYTES,
            size_of::<u64>() as u32,
        );
    }
}

/// Process memory layout ABI metadata.
///
/// Rust owns this declaration so the structural ABI snapshot, generated host
/// bindings, and JavaScript memory allocator all change together. Any value
/// change here changes the process/user-program ABI and requires bumping
/// [`ABI_VERSION`].
pub mod process_memory {
    /// WebAssembly linear memory page size in bytes.
    pub const WASM_PAGE_SIZE: u32 = 65_536;

    /// Host policy default for process maximum memory pages. This is not a
    /// user-program promise, but generated host bindings expose it next to the
    /// layout constants so host defaults are centralized.
    pub const DEFAULT_MAX_PAGES: u32 = 16_384;

    /// Minimum initial page count used when a binary does not import more.
    pub const DEFAULT_INITIAL_PAGES: u32 = 17;

    /// Host default concurrent pthread limit when a program declares
    /// [`THREAD_SLOTS_USE_HOST_DEFAULT`]. This is intentionally an arbitrary
    /// high default to avoid surprising pthread_create failures for most
    /// programs; hosts can tune it through the kernel worker options.
    pub const DEFAULT_THREAD_SLOTS: u32 = 1024;

    /// A process-wasm declaration value meaning "use the host default".
    pub const THREAD_SLOTS_USE_HOST_DEFAULT: i32 = -1;

    /// A process-wasm declaration value meaning "allow no pthreads".
    pub const THREAD_SLOTS_NONE: i32 = 0;

    /// Export name of the process-wasm constant-return function that declares
    /// the requested concurrent pthread limit.
    pub const THREAD_SLOT_DECL_EXPORT: &str = "__wasm_posix_thread_slots";

    /// Legacy kernel MemoryManager::MMAP_BASE. Compact hosts override this
    /// per process but still expose the legacy boundary for compatibility.
    pub const LEGACY_MMAP_BASE: u32 = 0x0400_0000;

    /// Fallback initial brk when a binary does not export `__heap_base`.
    pub const FALLBACK_BRK_BASE: u32 = 0x0100_0000;

    /// Bytes kept below each fork save buffer for host-owned control metadata.
    /// The current main-module dlopen slots use at most 40 bytes; one 4 KiB
    /// prefix gives that private layout room to grow without moving the buffer.
    pub const FORK_SAVE_CONTROL_PREFIX_SIZE: u32 = 4 * 1024;

    /// Size of one fork save buffer in bytes. The control prefix and buffer
    /// together occupy exactly one dedicated 64 KiB scratch page.
    pub const FORK_SAVE_BUFFER_SIZE: u32 = WASM_PAGE_SIZE - FORK_SAVE_CONTROL_PREFIX_SIZE;

    /// Main-thread fork-save/scratch page, relative to `controlBasePage`.
    pub const MAIN_FORK_SAVE_PAGE: u32 = 0;

    /// Main-thread syscall channel primary page, relative to
    /// `controlBasePage`.
    pub const MAIN_CHANNEL_PRIMARY_PAGE: u32 = 1;

    /// Main-thread syscall channel spill page, relative to `controlBasePage`.
    pub const MAIN_CHANNEL_SPILL_PAGE: u32 = 2;

    /// TLS/control page, relative to a pthread slot start page.
    pub const THREAD_SLOT_TLS_PAGE: u32 = 0;

    /// Fork-save/scratch page, relative to a pthread slot start page.
    pub const THREAD_SLOT_FORK_SAVE_PAGE: u32 = 1;

    /// Syscall channel primary page, relative to a pthread slot start page.
    pub const THREAD_SLOT_CHANNEL_PRIMARY_PAGE: u32 = 2;

    /// Syscall channel spill page, relative to a pthread slot start page.
    pub const THREAD_SLOT_CHANNEL_SPILL_PAGE: u32 = 3;

    /// Pages reserved for one pthread control slot.
    pub const PAGES_PER_THREAD_SLOT: u32 = 4;
}

/// ABI-surface constants captured by the structural ABI snapshot.
///
/// Any addition, removal, or value change in this module is, by definition,
/// an ABI change and requires bumping [`ABI_VERSION`].
pub mod abi {
    /// Name of the wasm custom section in which user programs embed their
    /// ABI version (single little-endian u32). The kernel host rejects
    /// binaries whose value does not match [`crate::ABI_VERSION`].
    pub const ABI_CUSTOM_SECTION: &str = "wasm-posix-abi";

    /// Name of the wasm global exported by the kernel that carries its
    /// [`crate::ABI_VERSION`] at load time (i32, immutable).
    pub const ABI_KERNEL_EXPORT: &str = "__abi_version";

    /// Globals that each user process instance is expected to expose so
    /// the host can thread channel / TLS state through fork and exec.
    pub const PROCESS_EXPECTED_GLOBALS: &[&str] = &["__channel_base", "__tls_base"];

    /// Pointer-sensitive value types used by program-artifact function
    /// requirements. `Pointer` resolves to i32 for wasm32 artifacts and i64
    /// for wasm64 artifacts.
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub enum ProgramArtifactValueType {
        Pointer,
        I32,
        I64,
        FuncRef,
        ExternRef,
        ExnRef,
        AnyRef,
    }

    /// One required function import in an instrumented program artifact.
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub struct ProgramArtifactImport {
        pub module: &'static str,
        pub name: &'static str,
        pub params: &'static [ProgramArtifactValueType],
        pub results: &'static [ProgramArtifactValueType],
    }

    /// One required private table import in an instrumented program artifact.
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub struct ProgramArtifactTableImport {
        pub module: &'static str,
        pub name: &'static str,
        pub table64: bool,
        pub element: ProgramArtifactValueType,
        pub minimum: u64,
        pub maximum: Option<u64>,
    }

    /// One required function export in an instrumented program artifact.
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub struct ProgramArtifactExport {
        pub name: &'static str,
        pub params: &'static [ProgramArtifactValueType],
        pub results: &'static [ProgramArtifactValueType],
    }

    /// ABI 42+ linked-continuation metadata and function surface.
    ///
    /// WHY this lives in `shared::abi`: these names and descriptor fields are
    /// consumed before a program starts, by the instrumenter, host, and package
    /// publisher. Keeping the publication contract in
    /// Rust-owned ABI metadata makes `dump-abi` record drift instead of
    /// allowing a newly instrumented program to publish successfully and fail
    /// only when its first `fork()` reaches the host.
    pub const WPK_FORK_LINKED_FRAME_FORMAT_SECTION: &str = "kandelo.wpk_fork.linked_frames";
    pub const WPK_FORK_LINKED_FRAME_FORMAT_MAGIC: [u8; 4] = *b"KLCF";
    pub const WPK_FORK_LINKED_FRAME_FORMAT_VERSION: u16 = 1;
    pub const WPK_FORK_LINKED_FRAME_DESCRIPTOR_SIZE: u16 = 24;
    pub const WPK_FORK_LINKED_FRAME_RECORD_ALIGNMENT: u8 = 8;
    pub const WPK_FORK_LINKED_FRAME_FLAG_TRANSACTIONAL_NODES: u16 = 1 << 0;
    pub const WPK_FORK_LINKED_FRAME_FLAG_ABORT_UNWINDING: u16 = 1 << 1;
    pub const WPK_FORK_LINKED_FRAME_REQUIRED_FLAGS: u16 =
        WPK_FORK_LINKED_FRAME_FLAG_TRANSACTIONAL_NODES | WPK_FORK_LINKED_FRAME_FLAG_ABORT_UNWINDING;
    pub const WPK_FORK_LINKED_FRAME_POINTER_WIDTHS: &[u8] = &[4, 8];

    /// ABI 43+ activation-owned module-state recipe format.
    ///
    /// WHY this is shared ABI rather than host-private metadata: an
    /// instrumented activation writes the arena before the host copies linear
    /// memory, and a fresh child instance validates and consumes it. Every
    /// literal below therefore crosses the instrumenter/guest/host boundary.
    pub const WPK_FORK_MODULE_STATE_FORMAT_SECTION: &str = "kandelo.wpk_fork.module_state";
    pub const WPK_FORK_MODULE_STATE_FORMAT_MAGIC: [u8; 4] = *b"KFMD";
    pub const WPK_FORK_MODULE_STATE_FORMAT_VERSION: u16 = 1;
    pub const WPK_FORK_MODULE_STATE_DESCRIPTOR_SIZE: u16 = 24;
    pub const WPK_FORK_MODULE_STATE_RECORD_ALIGNMENT: u8 = 8;
    pub const WPK_FORK_MODULE_STATE_FLAG_ROOT_PREFIX_POINTER: u16 = 1 << 0;
    pub const WPK_FORK_MODULE_STATE_FLAG_EXPLICIT_OWNERS: u16 = 1 << 1;
    pub const WPK_FORK_MODULE_STATE_FLAG_SPARSE_TABLES: u16 = 1 << 2;
    pub const WPK_FORK_MODULE_STATE_REQUIRED_FLAGS: u16 =
        WPK_FORK_MODULE_STATE_FLAG_ROOT_PREFIX_POINTER
            | WPK_FORK_MODULE_STATE_FLAG_EXPLICIT_OWNERS
            | WPK_FORK_MODULE_STATE_FLAG_SPARSE_TABLES;
    pub const WPK_FORK_MODULE_STATE_KNOWN_FLAGS: u16 = WPK_FORK_MODULE_STATE_REQUIRED_FLAGS;
    pub const WPK_FORK_MODULE_STATE_ARENA_VERSION: u16 = 1;
    pub const WPK_FORK_MODULE_STATE_RECORD_VERSION: u16 = 1;
    pub const WPK_FORK_MODULE_STATE_ROOT_POINTER_WORD_OFFSET: u32 = 1;
    pub const WPK_FORK_MODULE_STATE_POINTER_WIDTHS: &[u8] = &[4, 8];

    pub const WPK_FORK_MODULE_STATE_CHUNK_MAGIC: [u8; 4] = *b"KFMC";
    pub const WPK_FORK_MODULE_STATE_CHUNK_FLAG_ROOT: u16 = 1 << 0;
    pub const WPK_FORK_MODULE_STATE_CHUNK_FLAG_SEALED: u16 = 1 << 1;
    pub const WPK_FORK_MODULE_STATE_CHUNK_KNOWN_FLAGS: u16 =
        WPK_FORK_MODULE_STATE_CHUNK_FLAG_ROOT | WPK_FORK_MODULE_STATE_CHUNK_FLAG_SEALED;

    pub const WPK_FORK_MODULE_STATE_RECORD_MAGIC: [u8; 4] = *b"KFMR";
    pub const WPK_FORK_MODULE_STATE_RECORD_HEADER_SIZE: u16 = 24;
    pub const WPK_FORK_MODULE_STATE_RECORD_KIND_MODULE: u16 = 1;
    pub const WPK_FORK_MODULE_STATE_RECORD_KIND_REFERENCE_RECIPE: u16 = 2;
    pub const WPK_FORK_MODULE_STATE_RECORD_KIND_MUTABLE_GLOBAL: u16 = 3;
    pub const WPK_FORK_MODULE_STATE_RECORD_KIND_TABLE: u16 = 4;
    pub const WPK_FORK_MODULE_STATE_RECORD_KIND_TABLE_PAGE: u16 = 5;
    pub const WPK_FORK_MODULE_STATE_RECORD_KIND_ELEMENT_SEGMENTS: u16 = 6;
    pub const WPK_FORK_MODULE_STATE_RECORD_KIND_DATA_SEGMENTS: u16 = 7;
    pub const WPK_FORK_MODULE_STATE_RECORD_KIND_REPLAY_EVENTS: u16 = 8;
    pub const WPK_FORK_MODULE_STATE_RECORD_KIND_IMPORTED_GLOBAL_BINDINGS: u16 = 9;
    pub const WPK_FORK_MODULE_STATE_RECORD_KIND_ACTIVATION_CONTINUATIONS: u16 = 10;
    pub const WPK_FORK_MODULE_STATE_RECORD_KIND_IMPORTED_TABLE_BINDINGS: u16 = 11;
    pub const WPK_FORK_MODULE_STATE_RECORD_KIND_REFERENCE_RECIPE_SEGMENT: u16 = 12;
    pub const WPK_FORK_MODULE_STATE_RECORD_KIND_REPLAY_EVENT_SEGMENT: u16 = 13;

    /// One recognized module-state arena record kind.
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub struct ForkModuleStateRecordKind {
        pub number: u16,
        pub name: &'static str,
    }

    pub const WPK_FORK_MODULE_STATE_RECORD_KINDS: &[ForkModuleStateRecordKind] = &[
        ForkModuleStateRecordKind {
            number: WPK_FORK_MODULE_STATE_RECORD_KIND_MODULE,
            name: "module",
        },
        ForkModuleStateRecordKind {
            number: WPK_FORK_MODULE_STATE_RECORD_KIND_REFERENCE_RECIPE,
            name: "reference_recipe",
        },
        ForkModuleStateRecordKind {
            number: WPK_FORK_MODULE_STATE_RECORD_KIND_MUTABLE_GLOBAL,
            name: "mutable_global",
        },
        ForkModuleStateRecordKind {
            number: WPK_FORK_MODULE_STATE_RECORD_KIND_TABLE,
            name: "table",
        },
        ForkModuleStateRecordKind {
            number: WPK_FORK_MODULE_STATE_RECORD_KIND_TABLE_PAGE,
            name: "table_page",
        },
        ForkModuleStateRecordKind {
            number: WPK_FORK_MODULE_STATE_RECORD_KIND_ELEMENT_SEGMENTS,
            name: "element_segments",
        },
        ForkModuleStateRecordKind {
            number: WPK_FORK_MODULE_STATE_RECORD_KIND_DATA_SEGMENTS,
            name: "data_segments",
        },
        ForkModuleStateRecordKind {
            number: WPK_FORK_MODULE_STATE_RECORD_KIND_REPLAY_EVENTS,
            name: "replay_events",
        },
        ForkModuleStateRecordKind {
            number: WPK_FORK_MODULE_STATE_RECORD_KIND_IMPORTED_GLOBAL_BINDINGS,
            name: "imported_global_bindings",
        },
        ForkModuleStateRecordKind {
            number: WPK_FORK_MODULE_STATE_RECORD_KIND_ACTIVATION_CONTINUATIONS,
            name: "activation_continuations",
        },
        ForkModuleStateRecordKind {
            number: WPK_FORK_MODULE_STATE_RECORD_KIND_IMPORTED_TABLE_BINDINGS,
            name: "imported_table_bindings",
        },
        ForkModuleStateRecordKind {
            number: WPK_FORK_MODULE_STATE_RECORD_KIND_REFERENCE_RECIPE_SEGMENT,
            name: "reference_recipe_segment",
        },
        ForkModuleStateRecordKind {
            number: WPK_FORK_MODULE_STATE_RECORD_KIND_REPLAY_EVENT_SEGMENT,
            name: "replay_event_segment",
        },
    ];

    pub const WPK_FORK_MODULE_STATE_MODULE_TEMPLATE_ID_SIZE: u16 = 32;
    pub const WPK_FORK_MODULE_STATE_MODULE_RECORD_PAYLOAD_SIZE: u16 =
        WPK_FORK_MODULE_STATE_MODULE_TEMPLATE_ID_SIZE + 8;
    pub const WPK_FORK_MODULE_STATE_MODULE_RECORD_KNOWN_FLAGS: u32 = 0;
    pub const WPK_FORK_MODULE_STATE_GLOBAL_HEADER_SIZE: u16 = 8;
    pub const WPK_FORK_MODULE_STATE_GLOBAL_TYPE_I32: u8 = 1;
    pub const WPK_FORK_MODULE_STATE_GLOBAL_TYPE_I64: u8 = 2;
    pub const WPK_FORK_MODULE_STATE_GLOBAL_TYPE_F32: u8 = 3;
    pub const WPK_FORK_MODULE_STATE_GLOBAL_TYPE_F64: u8 = 4;
    pub const WPK_FORK_MODULE_STATE_GLOBAL_TYPE_V128: u8 = 5;
    pub const WPK_FORK_MODULE_STATE_GLOBAL_TYPE_FUNCREF: u8 = 6;
    pub const WPK_FORK_MODULE_STATE_GLOBAL_TYPE_EXTERNREF: u8 = 7;
    pub const WPK_FORK_MODULE_STATE_GLOBAL_TYPE_EXNREF: u8 = 8;
    pub const WPK_FORK_MODULE_STATE_GLOBAL_TYPE_ANYREF: u8 = 9;
    pub const WPK_FORK_MODULE_STATE_TABLE_BASELINE_FINGERPRINT_SIZE: u16 = 32;
    pub const WPK_FORK_MODULE_STATE_TABLE_DESCRIPTOR_PAYLOAD_SIZE: u16 =
        WPK_FORK_MODULE_STATE_TABLE_BASELINE_FINGERPRINT_SIZE + 24;
    pub const WPK_FORK_MODULE_STATE_TABLE_FLAG_SPARSE_OVERRIDES: u32 = 1 << 0;
    pub const WPK_FORK_MODULE_STATE_TABLE_KNOWN_FLAGS: u32 =
        WPK_FORK_MODULE_STATE_TABLE_FLAG_SPARSE_OVERRIDES;
    pub const WPK_FORK_MODULE_STATE_TABLE_PAGE_HEADER_SIZE: u16 = 16;
    pub const WPK_FORK_MODULE_STATE_TABLE_RUN_HEADER_SIZE: u16 = 8;
    pub const WPK_FORK_MODULE_STATE_ELEMENT_SEGMENT_HEADER_SIZE: u16 = 8;
    pub const WPK_FORK_MODULE_STATE_DATA_SEGMENT_HEADER_SIZE: u16 = 8;
    pub const WPK_FORK_MODULE_STATE_REPLAY_EVENTS_OWNER: u32 = 1;
    pub const WPK_FORK_MODULE_STATE_REPLAY_EVENTS_MAGIC: [u8; 4] = *b"KFRE";
    pub const WPK_FORK_MODULE_STATE_REPLAY_EVENTS_VERSION: u16 = 2;
    pub const WPK_FORK_MODULE_STATE_REPLAY_EVENTS_HEADER_SIZE: u16 = 40;
    pub const WPK_FORK_MODULE_STATE_REPLAY_EVENT_SIZE: u16 = 8;
    pub const WPK_FORK_MODULE_STATE_REPLAY_EVENTS_KNOWN_FLAGS: u16 = 0;
    pub const WPK_FORK_MODULE_STATE_REPLAY_EVENT_SEGMENT_VERSION: u16 = 1;
    pub const WPK_FORK_MODULE_STATE_REPLAY_EVENT_SEGMENT_HEADER_SIZE: u16 = 24;
    pub const WPK_FORK_MODULE_STATE_REPLAY_EVENT_SEGMENT_CAPACITY: u32 = 4080;
    pub const WPK_FORK_MODULE_STATE_REPLAY_EVENT_SEGMENT_KNOWN_FLAGS: u16 = 0;
    pub const WPK_FORK_REFERENCE_TRANSACTION_OWNER: u32 = 1;
    pub const WPK_FORK_REFERENCE_TRANSACTION_MAGIC: [u8; 4] = *b"KFRV";
    pub const WPK_FORK_REFERENCE_TRANSACTION_VERSION: u16 = 2;
    pub const WPK_FORK_REFERENCE_TRANSACTION_MANIFEST_SIZE: u16 = 96;
    pub const WPK_FORK_REFERENCE_TRANSACTION_FLAG_SEALED: u32 = 1 << 0;
    pub const WPK_FORK_REFERENCE_TRANSACTION_KNOWN_FLAGS: u32 =
        WPK_FORK_REFERENCE_TRANSACTION_FLAG_SEALED;
    pub const WPK_FORK_REFERENCE_SEGMENT_MAGIC: [u8; 4] = *b"KFRS";
    pub const WPK_FORK_REFERENCE_SEGMENT_HEADER_SIZE: u16 = 40;
    pub const WPK_FORK_REFERENCE_SEGMENT_KNOWN_FLAGS: u16 = 0;
    pub const WPK_FORK_REFERENCE_NODE_RECORD_SIZE: u16 = 48;
    pub const WPK_FORK_REFERENCE_VECTOR_INDEX_SIZE: u16 = 16;
    pub const WPK_FORK_REFERENCE_SECTION_NODES: u16 = 1;
    pub const WPK_FORK_REFERENCE_SECTION_EDGES: u16 = 2;
    pub const WPK_FORK_REFERENCE_SECTION_SCALARS: u16 = 3;
    pub const WPK_FORK_REFERENCE_SECTION_VECTOR_INDEX: u16 = 4;
    pub const WPK_FORK_REFERENCE_SECTION_VECTOR_ENTRIES: u16 = 5;
    pub const WPK_FORK_IMPORTED_GLOBAL_BINDINGS_OWNER: u32 = 2;
    pub const WPK_FORK_IMPORTED_GLOBAL_BINDINGS_MAGIC: [u8; 4] = *b"KFBG";
    pub const WPK_FORK_IMPORTED_GLOBAL_BINDINGS_VERSION: u16 = 1;
    pub const WPK_FORK_IMPORTED_GLOBAL_BINDINGS_HEADER_SIZE: u16 = 24;
    pub const WPK_FORK_IMPORTED_GLOBAL_BINDINGS_ENTRY_SIZE: u16 = 40;
    pub const WPK_FORK_IMPORTED_GLOBAL_BINDINGS_KNOWN_FLAGS: u16 = 0;
    pub const WPK_FORK_IMPORTED_GLOBAL_BINDING_RAW_NUMBER: u8 = 1;
    pub const WPK_FORK_IMPORTED_GLOBAL_BINDING_RAW_BIGINT: u8 = 2;
    pub const WPK_FORK_IMPORTED_GLOBAL_BINDING_RAW_REFERENCE: u8 = 3;
    pub const WPK_FORK_IMPORTED_GLOBAL_BINDING_ACTIVATION_GLOBAL: u8 = 4;
    pub const WPK_FORK_IMPORTED_GLOBAL_BINDING_BASE_IMPORT: u8 = 5;
    pub const WPK_FORK_GLOBAL_CATALOG_EXPORT_PREFIX: &str = "__wpk_fork_global_";
    pub const WPK_FORK_ACTIVATION_CONTINUATIONS_OWNER: u32 = 3;
    pub const WPK_FORK_ACTIVATION_CONTINUATIONS_MAGIC: [u8; 4] = *b"KFAC";
    pub const WPK_FORK_ACTIVATION_CONTINUATIONS_VERSION: u16 = 1;
    pub const WPK_FORK_ACTIVATION_CONTINUATIONS_HEADER_SIZE: u16 = 24;
    pub const WPK_FORK_ACTIVATION_CONTINUATION_ENTRY_SIZE: u16 = 16;
    pub const WPK_FORK_ACTIVATION_CONTINUATIONS_KNOWN_FLAGS: u16 = 0;
    pub const WPK_FORK_ACTIVATION_CONTINUATION_ENTRY_KNOWN_FLAGS: u32 = 0;
    pub const WPK_FORK_IMPORTED_TABLE_BINDINGS_OWNER: u32 = 4;
    pub const WPK_FORK_IMPORTED_TABLE_BINDINGS_MAGIC: [u8; 4] = *b"KFBT";
    pub const WPK_FORK_IMPORTED_TABLE_BINDINGS_VERSION: u16 = 1;
    pub const WPK_FORK_IMPORTED_TABLE_BINDINGS_HEADER_SIZE: u16 = 24;
    pub const WPK_FORK_IMPORTED_TABLE_BINDINGS_ENTRY_SIZE: u16 = 24;
    pub const WPK_FORK_IMPORTED_TABLE_BINDINGS_KNOWN_FLAGS: u16 = 0;
    pub const WPK_FORK_IMPORTED_TABLE_BINDING_ACTIVATION_TABLE: u8 = 1;
    pub const WPK_FORK_IMPORTED_TABLE_BINDING_BASE_IMPORT: u8 = 2;
    pub const WPK_FORK_TABLE_CATALOG_EXPORT_PREFIX: &str = "__wpk_fork_table_";
    pub const WPK_FORK_MODULE_STATE_MIN_TABLE_PAGE_SHIFT: u8 = 4;
    pub const WPK_FORK_MODULE_STATE_MAX_TABLE_PAGE_SHIFT: u8 = 20;
    /// Exact sparse-page geometry emitted by the ABI 43 instrumenter.
    pub const WPK_FORK_MODULE_STATE_TABLE_PAGE_SHIFT: u8 = 10;

    /// ABI 43 imported-global ownership metadata. A fresh child consumes this
    /// before module instantiation, which is earlier than KFMS restore and is
    /// therefore the only phase that can preserve immutable exports and
    /// constant initializers that observe imported globals.
    pub const WPK_FORK_IMPORTED_GLOBALS_SECTION: &str = "kandelo.wpk_fork.imported_globals";
    pub const WPK_FORK_IMPORTED_GLOBALS_MAGIC: [u8; 4] = *b"KFIG";
    pub const WPK_FORK_IMPORTED_GLOBALS_VERSION: u16 = 1;
    pub const WPK_FORK_IMPORTED_GLOBALS_HEADER_SIZE: u16 = 16;
    pub const WPK_FORK_IMPORTED_GLOBALS_RECORD_HEADER_SIZE: u16 = 24;
    pub const WPK_FORK_IMPORTED_GLOBAL_FLAG_MUTABLE: u8 = 1 << 0;
    pub const WPK_FORK_IMPORTED_GLOBAL_FLAG_SHARED: u8 = 1 << 1;
    pub const WPK_FORK_IMPORTED_GLOBAL_KNOWN_FLAGS: u8 =
        WPK_FORK_IMPORTED_GLOBAL_FLAG_MUTABLE | WPK_FORK_IMPORTED_GLOBAL_FLAG_SHARED;
    pub const WPK_FORK_IMPORTED_TABLES_SECTION: &str = "kandelo.wpk_fork.imported_tables";
    pub const WPK_FORK_IMPORTED_TABLES_MAGIC: [u8; 4] = *b"KFIT";
    pub const WPK_FORK_IMPORTED_TABLES_VERSION: u16 = 1;
    pub const WPK_FORK_IMPORTED_TABLES_HEADER_SIZE: u16 = 16;
    pub const WPK_FORK_IMPORTED_TABLES_RECORD_HEADER_SIZE: u16 = 24;
    pub const WPK_FORK_IMPORTED_TABLE_FLAG_TABLE64: u8 = 1 << 0;
    pub const WPK_FORK_IMPORTED_TABLE_KNOWN_FLAGS: u8 = WPK_FORK_IMPORTED_TABLE_FLAG_TABLE64;

    /// ABI 43 structural Wasm GC reconstruction catalog.
    ///
    /// GC object identities cannot cross Store or worker boundaries. The
    /// catalog lets the fresh child allocate the same typed object graph and
    /// then fill its scalar and reference fields without retaining parent
    /// instance references.
    pub const WPK_FORK_GC_CODEC_SECTION: &str = "kandelo.wpk_fork.gc_codec";
    pub const WPK_FORK_GC_CODEC_MAGIC: [u8; 4] = *b"KFGC";
    pub const WPK_FORK_GC_CODEC_VERSION: u16 = 1;
    pub const WPK_FORK_GC_CODEC_HEADER_SIZE: u16 = 16;
    pub const WPK_FORK_GC_CODEC_LAYOUT_RECORD_SIZE: u16 = 44;
    pub const WPK_FORK_GC_CODEC_FIELD_RECORD_SIZE: u16 = 12;

    /// ABI 43 exact-tag exception reconstruction catalog.
    ///
    /// A tag is instance-local, so copied `exnref` values cannot be replayed
    /// by importing a JavaScript-side reference. The instrumented activation
    /// publishes deterministic tag ordinals and payload layouts instead. The
    /// fresh child reconstructs each exception using its own corresponding tag.
    pub const WPK_FORK_EXCEPTION_CODEC_SECTION: &str = "kandelo.wpk_fork.exception_codec";
    pub const WPK_FORK_EXCEPTION_CODEC_VERSION: u8 = 1;
    pub const WPK_FORK_EXCEPTION_CODEC_HEADER_SIZE: u16 = 8;
    pub const WPK_FORK_EXCEPTION_CODEC_TAG_RECORD_SIZE: u16 = 16;

    /// Private zero-payload tag used to unwind instrumented Wasm without
    /// manufacturing values for arbitrary function result types.
    pub const WPK_FORK_UNWIND_TAG_IMPORT_MODULE: &str = "env";
    pub const WPK_FORK_UNWIND_TAG_IMPORT_NAME: &str = "__wpk_fork_unwind";
    pub const WPK_FORK_UNWIND_TRANSPORT_SECTION: &str = "kandelo.wpk_fork.unwind_transport";
    pub const WPK_FORK_UNWIND_TRANSPORT_VERSION: u8 = 1;
    pub const WPK_FORK_UNWIND_TRANSPORT_PAYLOAD_ARITY: u8 = 0;

    /// Fixed instance-local identities recreated by static initializers.
    pub const WPK_FORK_STATIC_ROOT_CATALOG_EXPORT: &str = "__wpk_fork_static_root_catalog";
    pub const WPK_FORK_STATIC_ROOT_CATALOG_SECTION: &str = "kandelo.wpk_fork.static_root_catalog";
    pub const WPK_FORK_STATIC_ROOT_CATALOG_MAGIC: [u8; 4] = *b"KFSR";
    pub const WPK_FORK_STATIC_ROOT_CATALOG_VERSION: u16 = 1;
    pub const WPK_FORK_STATIC_ROOT_CATALOG_HEADER_SIZE: u16 = 12;
    pub const WPK_FORK_STATIC_ROOT_HARVEST_EXPORT: &str = "__wpk_fork_static_root_harvest";

    /// Versioned instrumentation claims required by ABI 43.
    ///
    /// Role flags say which call graph was transformed. In ABI 43,
    /// `SIDE_ENTRY` means complete side-module boundary coverage: callers of
    /// every function import and unresolved function-reference dispatch are
    /// resumable even if fork occurs in a different module. The
    /// activation-state bit proves all replay state has a fresh-instance
    /// reconstruction owner.
    pub const WPK_FORK_CAPABILITIES_SECTION: &str = "kandelo.wpk_fork.capabilities";
    pub const WPK_FORK_CAPABILITIES_VERSION: u8 = 1;
    pub const WPK_FORK_CAP_SIDE_ENTRY: u8 = 1 << 0;
    pub const WPK_FORK_CAP_DYLINK_MAIN: u8 = 1 << 1;
    pub const WPK_FORK_CAP_ACTIVATION_STATE_SAFE: u8 = 1 << 2;
    pub const WPK_FORK_CAP_KNOWN_MASK: u8 =
        WPK_FORK_CAP_SIDE_ENTRY | WPK_FORK_CAP_DYLINK_MAIN | WPK_FORK_CAP_ACTIVATION_STATE_SAFE;
    pub const WPK_FORK_CAP_REQUIRED_FLAGS: u8 = WPK_FORK_CAP_ACTIVATION_STATE_SAFE;

    pub const WPK_FORK_FRAME_IMPORT_MODULE: &str = "env";
    pub const WPK_FORK_FRAME_IMPORT_RESERVE: &str = "__wpk_fork_frame_reserve";
    pub const WPK_FORK_FRAME_IMPORT_COMMIT: &str = "__wpk_fork_frame_commit";
    pub const WPK_FORK_FRAME_IMPORT_NEXT: &str = "__wpk_fork_frame_next";
    pub const WPK_FORK_FRAME_IMPORT_PEEK: &str = "__wpk_fork_frame_peek";
    pub const WPK_FORK_RESUME_IMPORT_PEEK: &str = "__wpk_fork_resume_peek";
    pub const WPK_FORK_RESUME_IMPORT_TABLE: &str = "__wpk_fork_resume_table";

    pub const WPK_FORK_MODULE_STATE_IMPORT_MODULE: &str = "env";
    pub const WPK_FORK_MODULE_STATE_IMPORT_RECORD_COMMIT: &str =
        "__wpk_fork_module_state_record_commit";
    pub const WPK_FORK_MODULE_STATE_IMPORT_RECORD_FIND: &str =
        "__wpk_fork_module_state_record_find";
    pub const WPK_FORK_MODULE_STATE_IMPORT_RECORD_RESERVE: &str =
        "__wpk_fork_module_state_record_reserve";
    pub const WPK_FORK_MODULE_STATE_IMPORT_TABLE_DIRTY_COUNT: &str =
        "__wpk_fork_module_state_table_dirty_count";
    pub const WPK_FORK_MODULE_STATE_IMPORT_TABLE_DIRTY_MARK: &str =
        "__wpk_fork_module_state_table_dirty_mark";
    pub const WPK_FORK_MODULE_STATE_IMPORT_TABLE_DIRTY_PAGE: &str =
        "__wpk_fork_module_state_table_dirty_page";
    pub const WPK_FORK_MODULE_STATE_IMPORT_TABLE_STATE_OWNED: &str =
        "__wpk_fork_module_state_table_state_owned";
    pub const WPK_FORK_MODULE_STATE_IMPORT_TABLE_MUTATION_BEGIN: &str =
        "__wpk_fork_module_state_table_mutation_begin";
    pub const WPK_FORK_MODULE_STATE_IMPORT_TABLE_MUTATION_COMMIT: &str =
        "__wpk_fork_module_state_table_mutation_commit";
    pub const WPK_FORK_MODULE_STATE_IMPORT_TABLE_MUTATION_ABORT: &str =
        "__wpk_fork_module_state_table_mutation_abort";
    pub const WPK_FORK_MODULE_STATE_IMPORT_TABLE_RECONCILE: &str =
        "__wpk_fork_module_state_table_reconcile";
    pub const WPK_FORK_MODULE_STATE_IMPORT_TABLE_GENERATION_ADDR: &str =
        "__wpk_fork_module_state_table_generation_addr";

    pub const WPK_FORK_EXCEPTION_CODEC_IMPORT_MODULE: &str = "env";
    pub const WPK_FORK_EXCEPTION_IMPORT_ACTIVATION: &str = "__wpk_fork_module_activation";
    pub const WPK_FORK_EXCEPTION_IMPORT_BROKER_ENCODE: &str = "__wpk_fork_ref_exn_broker_encode";
    pub const WPK_FORK_EXCEPTION_IMPORT_BROKER_THROW_RECIPE: &str =
        "__wpk_fork_ref_exn_broker_throw_recipe";
    pub const WPK_FORK_EXCEPTION_IMPORT_CACHE_INDEX: &str = "__wpk_fork_ref_exn_cache_index";
    pub const WPK_FORK_EXCEPTION_IMPORT_CLAIM: &str = "__wpk_fork_ref_exn_claim";
    pub const WPK_FORK_EXCEPTION_IMPORT_DEFINE: &str = "__wpk_fork_ref_exn_define";
    pub const WPK_FORK_EXCEPTION_IMPORT_INGRESS_THROW: &str = "__wpk_fork_ref_exn_ingress_throw";
    pub const WPK_FORK_EXCEPTION_IMPORT_LOAD: &str = "__wpk_fork_ref_exn_load";
    pub const WPK_FORK_EXCEPTION_IMPORT_LOOKUP: &str = "__wpk_fork_ref_exn_lookup";
    pub const WPK_FORK_EXCEPTION_IMPORT_ROUTE: &str = "__wpk_fork_ref_exn_route";

    pub const WPK_FORK_REFERENCE_CODEC_IMPORT_MODULE: &str = "env";
    pub const WPK_FORK_REFERENCE_IMPORT_DECODE_ANYREF: &str = "__wpk_fork_ref_decode_anyref";
    pub const WPK_FORK_REFERENCE_IMPORT_DECODE_EXNREF: &str = "__wpk_fork_ref_decode_exnref";
    pub const WPK_FORK_REFERENCE_IMPORT_DECODE_EXTERNREF: &str = "__wpk_fork_ref_decode_externref";
    pub const WPK_FORK_REFERENCE_IMPORT_DECODE_FUNCREF: &str = "__wpk_fork_ref_decode_funcref";
    pub const WPK_FORK_REFERENCE_IMPORT_ENCODE_ANYREF: &str = "__wpk_fork_ref_encode_anyref";
    pub const WPK_FORK_REFERENCE_IMPORT_ENCODE_EXNREF: &str = "__wpk_fork_ref_encode_exnref";
    pub const WPK_FORK_REFERENCE_IMPORT_ENCODE_EXTERNREF: &str = "__wpk_fork_ref_encode_externref";
    pub const WPK_FORK_REFERENCE_IMPORT_ENCODE_FUNCREF: &str = "__wpk_fork_ref_encode_funcref";
    pub const WPK_FORK_REFERENCE_IMPORT_GC_BROKER_ENCODE: &str = "__wpk_fork_ref_gc_broker_encode";
    pub const WPK_FORK_REFERENCE_IMPORT_GC_CAPTURE_LAYOUT: &str =
        "__wpk_fork_ref_gc_capture_layout";
    pub const WPK_FORK_REFERENCE_IMPORT_GC_CLAIM: &str = "__wpk_fork_ref_gc_claim";
    pub const WPK_FORK_REFERENCE_IMPORT_GC_DEFINE: &str = "__wpk_fork_ref_gc_define";
    pub const WPK_FORK_REFERENCE_IMPORT_GC_I31: &str = "__wpk_fork_ref_gc_i31";
    pub const WPK_FORK_REFERENCE_IMPORT_GC_LOAD: &str = "__wpk_fork_ref_gc_load";
    pub const WPK_FORK_REFERENCE_IMPORT_GC_LOOKUP: &str = "__wpk_fork_ref_gc_lookup";
    pub const WPK_FORK_REFERENCE_IMPORT_GC_PAYLOAD_LEN: &str = "__wpk_fork_ref_gc_payload_len";
    pub const WPK_FORK_REFERENCE_IMPORT_GC_PROVENANCE_BEGIN: &str =
        "__wpk_fork_ref_gc_provenance_begin";
    pub const WPK_FORK_REFERENCE_IMPORT_GC_PROVENANCE_END: &str =
        "__wpk_fork_ref_gc_provenance_end";
    pub const WPK_FORK_REFERENCE_IMPORT_GC_PROVENANCE_REF: &str =
        "__wpk_fork_ref_gc_provenance_ref";
    pub const WPK_FORK_REFERENCE_IMPORT_GC_ROUTE: &str = "__wpk_fork_ref_gc_route";
    pub const WPK_FORK_REFERENCE_IMPORT_GC_TRANSIT: &str = "__wpk_fork_ref_gc_transit";
    pub const WPK_FORK_REFERENCE_IMPORT_SCRATCH_RELEASE: &str = "__wpk_fork_ref_scratch_release";
    pub const WPK_FORK_REFERENCE_IMPORT_SCRATCH_RESERVE: &str = "__wpk_fork_ref_scratch_reserve";
    pub const WPK_FORK_REFERENCE_IMPORT_VECTOR_APPEND: &str = "__wpk_fork_ref_vector_append";
    pub const WPK_FORK_REFERENCE_IMPORT_VECTOR_BEGIN: &str = "__wpk_fork_ref_vector_begin";
    pub const WPK_FORK_REFERENCE_IMPORT_VECTOR_FINISH: &str = "__wpk_fork_ref_vector_finish";
    pub const WPK_FORK_REFERENCE_IMPORT_VECTOR_GET: &str = "__wpk_fork_ref_vector_get";

    pub const WPK_FORK_EXCEPTION_EXPORT_DECODE: &str = "__wpk_fork_ref_decode_exnref";
    pub const WPK_FORK_EXCEPTION_EXPORT_ENCODE: &str = "__wpk_fork_ref_encode_exnref";
    pub const WPK_FORK_EXCEPTION_EXPORT_ABORT: &str = "__wpk_fork_ref_exn_abort";
    pub const WPK_FORK_EXCEPTION_EXPORT_CLEAR: &str = "__wpk_fork_ref_exn_clear";
    pub const WPK_FORK_EXCEPTION_EXPORT_ENCODE_INGRESS: &str = "__wpk_fork_ref_exn_encode_ingress";
    pub const WPK_FORK_EXCEPTION_EXPORT_MATERIALIZE: &str = "__wpk_fork_exception_materialize";
    pub const WPK_FORK_EXCEPTION_EXPORT_THROW_RECIPE: &str = "__wpk_fork_ref_exn_throw_recipe";
    pub const WPK_FORK_EXCEPTION_EXPORT_THROW_SLOT: &str = "__wpk_fork_ref_exn_throw_slot";
    pub const WPK_FORK_REFERENCE_EXPORT_GC_ALLOCATE: &str = "__wpk_fork_ref_gc_allocate";
    pub const WPK_FORK_REFERENCE_EXPORT_GC_ENCODE_SLOT: &str = "__wpk_fork_ref_gc_encode_slot";
    pub const WPK_FORK_REFERENCE_EXPORT_GC_FILL: &str = "__wpk_fork_ref_gc_fill";
    pub const WPK_FORK_REFERENCE_EXPORT_GC_PUBLISH_EXTERNREF: &str =
        "__wpk_fork_ref_gc_publish_externref";
    pub const WPK_FORK_REFERENCE_EXPORT_GC_PROBE: &str = "__wpk_fork_ref_gc_probe";

    pub const WPK_FORK_EXPORT_ABORT_BEGIN: &str = "wpk_fork_abort_begin";
    pub const WPK_FORK_EXPORT_ABORT_END: &str = "wpk_fork_abort_end";
    pub const WPK_FORK_EXPORT_MODULE_BOOTSTRAP: &str = "wpk_fork_module_bootstrap";
    pub const WPK_FORK_EXPORT_MODULE_THREAD_BOOTSTRAP: &str = "wpk_fork_module_thread_bootstrap";
    pub const WPK_FORK_EXPORT_MODULE_STATE_FINISH_RESTORE: &str =
        "wpk_fork_module_state_finish_restore";
    pub const WPK_FORK_EXPORT_MODULE_STATE_RESTORE: &str = "wpk_fork_module_state_restore";
    pub const WPK_FORK_EXPORT_MODULE_STATE_SAVE: &str = "wpk_fork_module_state_save";
    pub const WPK_FORK_EXPORT_MODULE_TABLE_STATE_SAVE: &str = "wpk_fork_module_table_state_save";
    pub const WPK_FORK_EXPORT_MODULE_TABLE_STATE_RESTORE: &str =
        "wpk_fork_module_table_state_restore";
    pub const WPK_FORK_EXPORT_RESUME_START: &str = "wpk_fork_resume_start";
    pub const WPK_FORK_EXPORT_RESUME_THREAD: &str = "wpk_fork_resume_thread";
    pub const WPK_FORK_EXPORT_REWIND_BEGIN: &str = "wpk_fork_rewind_begin";
    pub const WPK_FORK_EXPORT_REWIND_END: &str = "wpk_fork_rewind_end";
    pub const WPK_FORK_EXPORT_STATE: &str = "wpk_fork_state";
    pub const WPK_FORK_EXPORT_UNWIND_BEGIN: &str = "wpk_fork_unwind_begin";
    pub const WPK_FORK_EXPORT_UNWIND_END: &str = "wpk_fork_unwind_end";

    use ProgramArtifactValueType::{AnyRef, ExnRef, ExternRef, FuncRef, I32, I64, Pointer};

    /// Exact process-worker import that seeds main-program fork discovery.
    ///
    /// Side modules continue to enter through `env.fork`; this requirement is
    /// therefore validated conditionally only when a program imports
    /// `kernel.kernel_fork`.
    pub const WPK_FORK_PROCESS_IMPORT: ProgramArtifactImport = ProgramArtifactImport {
        module: "kernel",
        name: "kernel_fork",
        params: &[I32],
        results: &[I32],
    };

    /// Exact process-worker import that seeds checkpoint discovery.
    ///
    /// The glue calls it from the post-syscall hook when the channel
    /// checkpoint request word is set. The capture pass unwinds instead of
    /// returning and a rewind resumes the guest after the carrying syscall,
    /// so the import takes nothing and returns nothing. Side modules do not
    /// import it; the requirement is therefore validated conditionally only
    /// when a program imports `kernel.kernel_checkpoint`.
    pub const WPK_CHECKPOINT_PROCESS_IMPORT: ProgramArtifactImport = ProgramArtifactImport {
        module: "kernel",
        name: "kernel_checkpoint",
        params: &[],
        results: &[],
    };

    pub const WPK_FORK_REQUIRED_IMPORTS: &[ProgramArtifactImport] = &[
        ProgramArtifactImport {
            module: WPK_FORK_FRAME_IMPORT_MODULE,
            name: WPK_FORK_FRAME_IMPORT_COMMIT,
            params: &[Pointer],
            results: &[],
        },
        ProgramArtifactImport {
            module: WPK_FORK_FRAME_IMPORT_MODULE,
            name: WPK_FORK_FRAME_IMPORT_NEXT,
            params: &[Pointer],
            results: &[Pointer],
        },
        ProgramArtifactImport {
            module: WPK_FORK_FRAME_IMPORT_MODULE,
            name: WPK_FORK_FRAME_IMPORT_PEEK,
            params: &[Pointer],
            results: &[Pointer],
        },
        ProgramArtifactImport {
            module: WPK_FORK_FRAME_IMPORT_MODULE,
            name: WPK_FORK_FRAME_IMPORT_RESERVE,
            params: &[Pointer],
            results: &[Pointer],
        },
        ProgramArtifactImport {
            module: WPK_FORK_MODULE_STATE_IMPORT_MODULE,
            name: WPK_FORK_MODULE_STATE_IMPORT_RECORD_COMMIT,
            params: &[Pointer],
            results: &[],
        },
        ProgramArtifactImport {
            module: WPK_FORK_MODULE_STATE_IMPORT_MODULE,
            name: WPK_FORK_MODULE_STATE_IMPORT_RECORD_FIND,
            params: &[I32, I32, I32, I32],
            results: &[Pointer],
        },
        ProgramArtifactImport {
            module: WPK_FORK_MODULE_STATE_IMPORT_MODULE,
            name: WPK_FORK_MODULE_STATE_IMPORT_RECORD_RESERVE,
            params: &[I32, I32, I32, Pointer],
            results: &[Pointer],
        },
        ProgramArtifactImport {
            module: WPK_FORK_MODULE_STATE_IMPORT_MODULE,
            name: WPK_FORK_MODULE_STATE_IMPORT_TABLE_DIRTY_COUNT,
            params: &[I32],
            results: &[I32],
        },
        ProgramArtifactImport {
            module: WPK_FORK_MODULE_STATE_IMPORT_MODULE,
            name: WPK_FORK_MODULE_STATE_IMPORT_TABLE_DIRTY_MARK,
            params: &[I32, I64, I64],
            results: &[],
        },
        ProgramArtifactImport {
            module: WPK_FORK_MODULE_STATE_IMPORT_MODULE,
            name: WPK_FORK_MODULE_STATE_IMPORT_TABLE_DIRTY_PAGE,
            params: &[I32, I32],
            results: &[I64],
        },
        ProgramArtifactImport {
            module: WPK_FORK_MODULE_STATE_IMPORT_MODULE,
            name: WPK_FORK_MODULE_STATE_IMPORT_TABLE_MUTATION_ABORT,
            params: &[],
            results: &[],
        },
        ProgramArtifactImport {
            module: WPK_FORK_MODULE_STATE_IMPORT_MODULE,
            name: WPK_FORK_MODULE_STATE_IMPORT_TABLE_MUTATION_BEGIN,
            params: &[],
            results: &[I64],
        },
        ProgramArtifactImport {
            module: WPK_FORK_MODULE_STATE_IMPORT_MODULE,
            name: WPK_FORK_MODULE_STATE_IMPORT_TABLE_MUTATION_COMMIT,
            params: &[I32, I64, I64],
            results: &[],
        },
        ProgramArtifactImport {
            module: WPK_FORK_MODULE_STATE_IMPORT_MODULE,
            name: WPK_FORK_MODULE_STATE_IMPORT_TABLE_RECONCILE,
            params: &[],
            results: &[I64],
        },
        ProgramArtifactImport {
            module: WPK_FORK_MODULE_STATE_IMPORT_MODULE,
            name: WPK_FORK_MODULE_STATE_IMPORT_TABLE_STATE_OWNED,
            params: &[I32],
            results: &[I32],
        },
        ProgramArtifactImport {
            module: WPK_FORK_REFERENCE_CODEC_IMPORT_MODULE,
            name: WPK_FORK_REFERENCE_IMPORT_DECODE_FUNCREF,
            params: &[I32],
            results: &[FuncRef],
        },
        ProgramArtifactImport {
            module: WPK_FORK_REFERENCE_CODEC_IMPORT_MODULE,
            name: WPK_FORK_REFERENCE_IMPORT_ENCODE_FUNCREF,
            params: &[FuncRef],
            results: &[I32],
        },
        ProgramArtifactImport {
            module: WPK_FORK_EXCEPTION_CODEC_IMPORT_MODULE,
            name: WPK_FORK_EXCEPTION_IMPORT_BROKER_ENCODE,
            params: &[I32],
            results: &[I32],
        },
        ProgramArtifactImport {
            module: WPK_FORK_EXCEPTION_CODEC_IMPORT_MODULE,
            name: WPK_FORK_EXCEPTION_IMPORT_BROKER_THROW_RECIPE,
            params: &[I32],
            results: &[],
        },
        ProgramArtifactImport {
            module: WPK_FORK_EXCEPTION_CODEC_IMPORT_MODULE,
            name: WPK_FORK_EXCEPTION_IMPORT_CACHE_INDEX,
            params: &[I32],
            results: &[I32],
        },
        ProgramArtifactImport {
            module: WPK_FORK_EXCEPTION_CODEC_IMPORT_MODULE,
            name: WPK_FORK_EXCEPTION_IMPORT_CLAIM,
            params: &[I32],
            results: &[I32],
        },
        ProgramArtifactImport {
            module: WPK_FORK_EXCEPTION_CODEC_IMPORT_MODULE,
            name: WPK_FORK_EXCEPTION_IMPORT_DEFINE,
            params: &[I32, I32, I32, I32, Pointer, I32, Pointer, I32],
            results: &[],
        },
        ProgramArtifactImport {
            module: WPK_FORK_EXCEPTION_CODEC_IMPORT_MODULE,
            name: WPK_FORK_EXCEPTION_IMPORT_INGRESS_THROW,
            params: &[I32],
            results: &[],
        },
        ProgramArtifactImport {
            module: WPK_FORK_EXCEPTION_CODEC_IMPORT_MODULE,
            name: WPK_FORK_EXCEPTION_IMPORT_LOAD,
            params: &[I32, I32, I32, I32, Pointer, I32, Pointer, I32],
            results: &[I32],
        },
        ProgramArtifactImport {
            module: WPK_FORK_EXCEPTION_CODEC_IMPORT_MODULE,
            name: WPK_FORK_EXCEPTION_IMPORT_LOOKUP,
            params: &[I32],
            results: &[I32],
        },
        ProgramArtifactImport {
            module: WPK_FORK_EXCEPTION_CODEC_IMPORT_MODULE,
            name: WPK_FORK_EXCEPTION_IMPORT_ROUTE,
            params: &[I32, I32],
            results: &[I32],
        },
        ProgramArtifactImport {
            module: WPK_FORK_REFERENCE_CODEC_IMPORT_MODULE,
            name: WPK_FORK_REFERENCE_IMPORT_GC_BROKER_ENCODE,
            params: &[I32],
            results: &[I32],
        },
        ProgramArtifactImport {
            module: WPK_FORK_REFERENCE_CODEC_IMPORT_MODULE,
            name: WPK_FORK_REFERENCE_IMPORT_GC_CAPTURE_LAYOUT,
            params: &[I32, I32, I32],
            results: &[I32],
        },
        ProgramArtifactImport {
            module: WPK_FORK_REFERENCE_CODEC_IMPORT_MODULE,
            name: WPK_FORK_REFERENCE_IMPORT_GC_CLAIM,
            params: &[I32],
            results: &[I32],
        },
        ProgramArtifactImport {
            module: WPK_FORK_REFERENCE_CODEC_IMPORT_MODULE,
            name: WPK_FORK_REFERENCE_IMPORT_GC_DEFINE,
            params: &[I32, I32, I32, I32, I32, Pointer, I32, I32],
            results: &[],
        },
        ProgramArtifactImport {
            module: WPK_FORK_REFERENCE_CODEC_IMPORT_MODULE,
            name: WPK_FORK_REFERENCE_IMPORT_GC_I31,
            params: &[I32],
            results: &[I32],
        },
        ProgramArtifactImport {
            module: WPK_FORK_REFERENCE_CODEC_IMPORT_MODULE,
            name: WPK_FORK_REFERENCE_IMPORT_GC_LOAD,
            params: &[I32, I32, I32, I32, I32, Pointer, I32],
            results: &[I32],
        },
        ProgramArtifactImport {
            module: WPK_FORK_REFERENCE_CODEC_IMPORT_MODULE,
            name: WPK_FORK_REFERENCE_IMPORT_GC_LOOKUP,
            params: &[I32],
            results: &[I32],
        },
        ProgramArtifactImport {
            module: WPK_FORK_REFERENCE_CODEC_IMPORT_MODULE,
            name: WPK_FORK_REFERENCE_IMPORT_GC_PAYLOAD_LEN,
            params: &[I32, I32, I32],
            results: &[I32],
        },
        ProgramArtifactImport {
            module: WPK_FORK_REFERENCE_CODEC_IMPORT_MODULE,
            name: WPK_FORK_REFERENCE_IMPORT_GC_PROVENANCE_BEGIN,
            params: &[I32, I32, I32, I32, I64, I64, I32],
            results: &[I32],
        },
        ProgramArtifactImport {
            module: WPK_FORK_REFERENCE_CODEC_IMPORT_MODULE,
            name: WPK_FORK_REFERENCE_IMPORT_GC_PROVENANCE_END,
            params: &[I32],
            results: &[],
        },
        ProgramArtifactImport {
            module: WPK_FORK_REFERENCE_CODEC_IMPORT_MODULE,
            name: WPK_FORK_REFERENCE_IMPORT_GC_PROVENANCE_REF,
            params: &[I32, I32, I32],
            results: &[],
        },
        ProgramArtifactImport {
            module: WPK_FORK_REFERENCE_CODEC_IMPORT_MODULE,
            name: WPK_FORK_REFERENCE_IMPORT_GC_ROUTE,
            params: &[I32, I32],
            results: &[I32],
        },
        ProgramArtifactImport {
            module: WPK_FORK_REFERENCE_CODEC_IMPORT_MODULE,
            name: WPK_FORK_REFERENCE_IMPORT_SCRATCH_RELEASE,
            params: &[Pointer, Pointer],
            results: &[],
        },
        ProgramArtifactImport {
            module: WPK_FORK_REFERENCE_CODEC_IMPORT_MODULE,
            name: WPK_FORK_REFERENCE_IMPORT_SCRATCH_RESERVE,
            params: &[Pointer],
            results: &[Pointer],
        },
        ProgramArtifactImport {
            module: WPK_FORK_REFERENCE_CODEC_IMPORT_MODULE,
            name: WPK_FORK_REFERENCE_IMPORT_VECTOR_APPEND,
            params: &[I32, I32],
            results: &[],
        },
        ProgramArtifactImport {
            module: WPK_FORK_REFERENCE_CODEC_IMPORT_MODULE,
            name: WPK_FORK_REFERENCE_IMPORT_VECTOR_BEGIN,
            params: &[I32],
            results: &[I32],
        },
        ProgramArtifactImport {
            module: WPK_FORK_REFERENCE_CODEC_IMPORT_MODULE,
            name: WPK_FORK_REFERENCE_IMPORT_VECTOR_FINISH,
            params: &[I32],
            results: &[I32],
        },
        ProgramArtifactImport {
            module: WPK_FORK_REFERENCE_CODEC_IMPORT_MODULE,
            name: WPK_FORK_REFERENCE_IMPORT_VECTOR_GET,
            params: &[I32, I32],
            results: &[I32],
        },
        ProgramArtifactImport {
            module: WPK_FORK_FRAME_IMPORT_MODULE,
            name: WPK_FORK_RESUME_IMPORT_PEEK,
            params: &[I32],
            results: &[I32],
        },
    ];

    pub const WPK_FORK_REQUIRED_TABLE_IMPORTS: &[ProgramArtifactTableImport] = &[
        ProgramArtifactTableImport {
            module: WPK_FORK_REFERENCE_CODEC_IMPORT_MODULE,
            name: WPK_FORK_REFERENCE_IMPORT_GC_TRANSIT,
            table64: false,
            element: AnyRef,
            minimum: 1,
            maximum: None,
        },
        ProgramArtifactTableImport {
            module: WPK_FORK_FRAME_IMPORT_MODULE,
            name: WPK_FORK_RESUME_IMPORT_TABLE,
            table64: false,
            element: FuncRef,
            minimum: 1,
            maximum: None,
        },
    ];

    pub const WPK_FORK_REQUIRED_EXPORTS: &[ProgramArtifactExport] = &[
        ProgramArtifactExport {
            name: WPK_FORK_EXCEPTION_EXPORT_MATERIALIZE,
            params: &[I32],
            results: &[],
        },
        ProgramArtifactExport {
            name: WPK_FORK_EXCEPTION_EXPORT_DECODE,
            params: &[I32],
            results: &[ExnRef],
        },
        ProgramArtifactExport {
            name: WPK_FORK_EXCEPTION_EXPORT_ENCODE,
            params: &[ExnRef],
            results: &[I32],
        },
        ProgramArtifactExport {
            name: WPK_FORK_EXCEPTION_EXPORT_ABORT,
            params: &[],
            results: &[],
        },
        ProgramArtifactExport {
            name: WPK_FORK_EXCEPTION_EXPORT_CLEAR,
            params: &[],
            results: &[],
        },
        ProgramArtifactExport {
            name: WPK_FORK_EXCEPTION_EXPORT_ENCODE_INGRESS,
            params: &[I32],
            results: &[I32],
        },
        ProgramArtifactExport {
            name: WPK_FORK_EXCEPTION_EXPORT_THROW_RECIPE,
            params: &[I32],
            results: &[],
        },
        ProgramArtifactExport {
            name: WPK_FORK_EXCEPTION_EXPORT_THROW_SLOT,
            params: &[I32],
            results: &[],
        },
        ProgramArtifactExport {
            name: WPK_FORK_REFERENCE_EXPORT_GC_ALLOCATE,
            params: &[I32],
            results: &[],
        },
        ProgramArtifactExport {
            name: WPK_FORK_REFERENCE_EXPORT_GC_ENCODE_SLOT,
            params: &[I32],
            results: &[I32],
        },
        ProgramArtifactExport {
            name: WPK_FORK_REFERENCE_EXPORT_GC_FILL,
            params: &[I32],
            results: &[],
        },
        ProgramArtifactExport {
            name: WPK_FORK_REFERENCE_EXPORT_GC_PROBE,
            params: &[I32],
            results: &[I64],
        },
        ProgramArtifactExport {
            name: WPK_FORK_REFERENCE_EXPORT_GC_PUBLISH_EXTERNREF,
            params: &[I32, ExternRef],
            results: &[],
        },
        ProgramArtifactExport {
            name: WPK_FORK_STATIC_ROOT_HARVEST_EXPORT,
            params: &[],
            results: &[],
        },
        ProgramArtifactExport {
            name: WPK_FORK_EXPORT_ABORT_BEGIN,
            params: &[Pointer],
            results: &[],
        },
        ProgramArtifactExport {
            name: WPK_FORK_EXPORT_ABORT_END,
            params: &[],
            results: &[],
        },
        ProgramArtifactExport {
            name: WPK_FORK_EXPORT_MODULE_BOOTSTRAP,
            params: &[],
            results: &[],
        },
        ProgramArtifactExport {
            name: WPK_FORK_EXPORT_MODULE_STATE_FINISH_RESTORE,
            params: &[I32],
            results: &[],
        },
        ProgramArtifactExport {
            name: WPK_FORK_EXPORT_MODULE_STATE_RESTORE,
            params: &[I32],
            results: &[],
        },
        ProgramArtifactExport {
            name: WPK_FORK_EXPORT_MODULE_STATE_SAVE,
            params: &[I32],
            results: &[],
        },
        ProgramArtifactExport {
            name: WPK_FORK_EXPORT_MODULE_TABLE_STATE_RESTORE,
            params: &[I32],
            results: &[],
        },
        ProgramArtifactExport {
            name: WPK_FORK_EXPORT_MODULE_TABLE_STATE_SAVE,
            params: &[I32],
            results: &[],
        },
        ProgramArtifactExport {
            name: WPK_FORK_EXPORT_MODULE_THREAD_BOOTSTRAP,
            params: &[],
            results: &[],
        },
        ProgramArtifactExport {
            name: WPK_FORK_EXPORT_REWIND_BEGIN,
            params: &[Pointer],
            results: &[],
        },
        ProgramArtifactExport {
            name: WPK_FORK_EXPORT_REWIND_END,
            params: &[],
            results: &[],
        },
        ProgramArtifactExport {
            name: WPK_FORK_EXPORT_STATE,
            params: &[],
            results: &[I32],
        },
        ProgramArtifactExport {
            name: WPK_FORK_EXPORT_UNWIND_BEGIN,
            params: &[Pointer],
            results: &[],
        },
        ProgramArtifactExport {
            name: WPK_FORK_EXPORT_UNWIND_END,
            params: &[],
            results: &[],
        },
    ];

    /// Return the version-1 linked-chunk header size for one pointer width.
    pub const fn wpk_fork_linked_chunk_header_size(pointer_width: u8) -> Option<u32> {
        match pointer_width {
            4 => Some(32),
            8 => Some(56),
            _ => None,
        }
    }

    /// Return the version-1 linked-frame-node header size for one pointer
    /// width, including the required eight-byte alignment.
    pub const fn wpk_fork_linked_node_header_size(pointer_width: u8) -> Option<u32> {
        match pointer_width {
            4 => Some(24),
            8 => Some(32),
            _ => None,
        }
    }

    /// Return the version-1 module-state chunk header size for one pointer
    /// width, including the required eight-byte alignment.
    pub const fn wpk_fork_module_state_chunk_header_size(pointer_width: u8) -> Option<u32> {
        match pointer_width {
            4 => Some(40),
            8 => Some(56),
            _ => None,
        }
    }

    /// Patterns (applied as prefix match) for kernel-wasm exports that
    /// are implementation details of the toolchain, not part of the
    /// host/kernel ABI. The snapshot excludes any export whose name
    /// starts with one of these.
    ///
    /// Adding or removing a pattern is itself an ABI-relevant change —
    /// it affects what the snapshot tracks. The check will flag it.
    pub const EXPORT_DENY_PREFIXES: &[&str] = &[
        "__wasm_call_",
        "__wasm_init_",
        "__wasm_apply_",
        "__llvm_",
        // LLD/wasm-ld emits __tls_align / __tls_base / __tls_size as a
        // side-effect of TLS-aware codegen. Whether they appear depends
        // on the toolchain version (newer nightlies optimise them away
        // when no kernel-internal code references them externally), and
        // nothing in the host runtime reads them from the kernel module
        // (host/src/worker-main.ts reads __tls_base only from user-program
        // instances). Filtering them keeps the snapshot stable across
        // toolchain churn.
        "__tls_",
    ];

    /// Exact-name variant of [`EXPORT_DENY_PREFIXES`] — exports we
    /// never track regardless of toolchain tweaks.
    pub const EXPORT_DENY_EXACT: &[&str] = &[
        "__dso_handle",
        "__data_end",
        "__heap_base",
        "__heap_end",
        "__memory_base",
        "__table_base",
        "__global_base",
    ];

    /// Prefix patterns for exports whose *value* is part of the ABI,
    /// not just their type. The snapshot captures the initial value of
    /// matching immutable globals.
    ///
    /// Today this is just `__abi_*`. The convention: anything that
    /// declares "this value is the contract" gets an `__abi_` prefix
    /// and is tracked for value-identity. Everything else is tracked
    /// for existence + type, because its value is linker- or
    /// runtime-determined and would churn without encoding real ABI
    /// changes.
    pub const ABI_VALUE_CAPTURE_PREFIXES: &[&str] = &["__abi_"];

    /// Binary manifest exported by the kernel so host adapters can validate the
    /// boot-time host/kernel contract from Rust-owned metadata.
    #[repr(C)]
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub struct HostAdapterManifest {
        pub magic: u32,
        pub manifest_version: u16,
        pub manifest_size: u16,
        pub abi_version: u32,
        pub required_host_adapter_version: u32,
        pub required_worker_features: u32,
        pub optional_kernel_features: u32,
        pub channel_header_size: u32,
        pub channel_data_offset: u32,
        pub channel_data_size: u32,
        pub channel_min_size: u32,
    }

    pub const HOST_ADAPTER_MANIFEST_MAGIC: u32 = 0x4d4b_5057; // "WPKM", little-endian.
    pub const HOST_ADAPTER_MANIFEST_VERSION: u16 = 1;
    /// Version 2 adds the `host_accept_select` import. A host that predates it
    /// cannot instantiate this kernel, and the manifest check is what turns
    /// that into a named refusal instead of a raw Wasm link error.
    pub const HOST_ADAPTER_VERSION: u32 = 2;
    pub const HOST_ADAPTER_MANIFEST_SIZE: u16 = core::mem::size_of::<HostAdapterManifest>() as u16;

    pub const HOST_FEATURE_SHARED_ARRAY_BUFFER: u32 = 1 << 0;
    pub const HOST_FEATURE_ATOMICS_WAIT: u32 = 1 << 1;
    pub const HOST_FEATURE_ATOMICS_WAIT_ASYNC: u32 = 1 << 2;

    pub const HOST_ADAPTER_REQUIRED_WORKER_FEATURES: u32 = HOST_FEATURE_SHARED_ARRAY_BUFFER
        | HOST_FEATURE_ATOMICS_WAIT
        | HOST_FEATURE_ATOMICS_WAIT_ASYNC;
    pub const HOST_ADAPTER_OPTIONAL_KERNEL_FEATURES: u32 = 0;

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub struct HostAdapterFeature {
        pub name: &'static str,
        pub bit: u32,
    }

    pub const HOST_ADAPTER_WORKER_FEATURES: &[HostAdapterFeature] = &[
        HostAdapterFeature {
            name: "atomics_wait",
            bit: HOST_FEATURE_ATOMICS_WAIT,
        },
        HostAdapterFeature {
            name: "atomics_wait_async",
            bit: HOST_FEATURE_ATOMICS_WAIT_ASYNC,
        },
        HostAdapterFeature {
            name: "shared_array_buffer",
            bit: HOST_FEATURE_SHARED_ARRAY_BUFFER,
        },
    ];

    pub const HOST_ADAPTER_REQUIRED_KERNEL_EXPORTS: &[&str] = &[
        "__abi_version",
        "kernel_alloc_scratch",
        "kernel_blocking_retry_release",
        "kernel_blocking_retry_token",
        "kernel_commit_process_exit",
        "kernel_create_process",
        "kernel_create_process_with_stdio",
        "kernel_dequeue_signal",
        "kernel_exec_commit",
        "kernel_exec_target_cancel",
        "kernel_exec_target_prepare",
        "kernel_exec_target_read",
        "kernel_exec_target_size",
        "kernel_fork_process",
        "kernel_get_cwd",
        "kernel_get_dirfd_path",
        "kernel_get_fd_path",
        "kernel_get_parent_pid",
        "kernel_get_process_exit_signal",
        "kernel_get_process_state",
        "kernel_get_socket_timeout_ms",
        "kernel_handle_channel",
        "kernel_has_sa_nocldstop",
        "kernel_host_adapter_manifest_len",
        "kernel_host_adapter_manifest_ptr",
        "kernel_ipc_shm_lookup_mapping_for_task",
        "kernel_ipc_shm_record_mapping_for_process",
        "kernel_ipc_shm_record_mapping_for_task",
        "kernel_ipc_shmat_for_process",
        "kernel_ipc_shmat_for_task",
        "kernel_ipc_shmdt_addr_for_process",
        "kernel_ipc_shmdt_addr_for_task",
        "kernel_ipc_shmdt_for_process",
        "kernel_ipc_shmdt_for_task",
        "kernel_is_fd_nonblock",
        "kernel_mark_process_signaled",
        "kernel_mq_descriptor_msgsize",
        "kernel_msqid_ds_bytes",
        "kernel_pcm_claim_transport",
        "kernel_pcm_clock_update",
        "kernel_pcm_reconcile",
        "kernel_pcm_transport_len",
        "kernel_pcm_transport_ptr",
        "kernel_pick_signal_target_tid",
        "kernel_pick_tcp_listener_target",
        "kernel_pipe_has_readers",
        "kernel_posix_timer_fire",
        "kernel_process_metadata_begin",
        "kernel_process_metadata_cancel",
        "kernel_process_metadata_commit",
        "kernel_process_metadata_stage",
        "kernel_process_secure_exec",
        "kernel_publish_spawn_child",
        "kernel_reap_exited_child",
        "kernel_remove_process",
        "kernel_semctl_array_bytes",
        "kernel_semid_ds_bytes",
        "kernel_set_current_tid",
        "kernel_set_cwd",
        "kernel_shmid_ds_bytes",
        "kernel_spawn_exec_commit",
        "kernel_spawn_exec_target_prepare",
        "kernel_spawn_process",
        "kernel_spawn_reserved_process",
        "kernel_spawn_scratch_begin",
        "kernel_spawn_scratch_cancel",
        "kernel_spawn_scratch_capacity",
        "kernel_spawn_scratch_pointer",
        "kernel_spawn_scratch_retained_capacity",
        "kernel_take_process_timer_cleanup",
        "kernel_thread_exit",
        "kernel_thread_has_deliverable",
        "kernel_transfer_channel_execute",
        "kernel_transfer_io_execute",
        "kernel_transfer_scratch_begin",
        "kernel_transfer_scratch_cancel",
        "kernel_transfer_scratch_capacity",
        "kernel_transfer_scratch_pointer",
        "kernel_validate_task",
        "kernel_wait_child_poll",
    ];

    pub const HOST_ADAPTER_OPTIONAL_KERNEL_EXPORTS: &[&str] = &[
        "kernel_reserve_host_region",
        "kernel_reserve_host_region_at",
        "kernel_set_max_addr",
        "kernel_set_mmap_base",
    ];

    pub static HOST_ADAPTER_MANIFEST: HostAdapterManifest = HostAdapterManifest {
        magic: HOST_ADAPTER_MANIFEST_MAGIC,
        manifest_version: HOST_ADAPTER_MANIFEST_VERSION,
        manifest_size: HOST_ADAPTER_MANIFEST_SIZE,
        abi_version: crate::ABI_VERSION,
        required_host_adapter_version: HOST_ADAPTER_VERSION,
        required_worker_features: HOST_ADAPTER_REQUIRED_WORKER_FEATURES,
        optional_kernel_features: HOST_ADAPTER_OPTIONAL_KERNEL_FEATURES,
        channel_header_size: crate::channel::HEADER_SIZE as u32,
        channel_data_offset: crate::channel::DATA_OFFSET as u32,
        channel_data_size: crate::channel::DATA_SIZE as u32,
        channel_min_size: crate::channel::MIN_CHANNEL_SIZE as u32,
    };

    /// One named syscall number in the host/kernel ABI metadata.
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub struct AbiSyscallNumber {
        pub name: &'static str,
        pub number: u32,
    }

    /// ABI-visible syscall numbers that are not yet represented in
    /// [`crate::Syscall`].
    ///
    /// These include Linux-like extended calls handled by `wasm_api.rs`, plus
    /// host-adapter control calls that enter through the normal syscall
    /// channel. Fork/exec/spawn calls caught before normal dispatch stay in
    /// [`host_intercepted`] instead.
    pub mod extended_syscalls {
        use super::AbiSyscallNumber;

        pub const SYS_LLSEEK: u32 = 119;
        pub const SYS_GETRANDOM: u32 = 120;
        pub const SYS_FLOCK: u32 = 121;
        pub const SYS_FUTEX: u32 = 200;
        pub const SYS_CLONE: u32 = 201;
        pub const SYS_GETTID: u32 = 202;
        pub const SYS_SET_TID_ADDRESS: u32 = 203;
        pub const SYS_TKILL: u32 = 204;
        pub const SYS_RT_SIGQUEUEINFO: u32 = 205;
        pub const SYS_RT_SIGPENDING: u32 = 206;
        pub const SYS_RT_SIGTIMEDWAIT: u32 = 207;
        pub const SYS_RT_SIGRETURN: u32 = 208;
        pub const SYS_SIGALTSTACK: u32 = 209;
        pub const SYS_GETPGID: u32 = 214;
        pub const SYS_SETREUID: u32 = 215;
        pub const SYS_SETREGID: u32 = 216;
        pub const SYS_PRCTL: u32 = 223;
        pub const SYS_GETITIMER: u32 = 224;
        pub const SYS_SETITIMER: u32 = 225;
        pub const SYS_CLOCK_SETTIME: u32 = 226;
        pub const SYS_SCHED_YIELD: u32 = 229;
        pub const SYS_SCHED_GETPARAM: u32 = 230;
        pub const SYS_SCHED_SETPARAM: u32 = 231;
        pub const SYS_SCHED_SETSCHEDULER: u32 = 233;
        pub const SYS_SCHED_RR_GET_INTERVAL: u32 = 236;
        pub const SYS_SCHED_SETAFFINITY: u32 = 237;
        pub const SYS_SCHED_GETAFFINITY: u32 = 238;
        pub const SYS_EPOLL_CREATE1: u32 = 239;
        pub const SYS_EPOLL_CTL: u32 = 240;
        pub const SYS_EPOLL_PWAIT: u32 = 241;
        pub const SYS_TIMERFD_CREATE: u32 = 243;
        pub const SYS_TIMERFD_SETTIME: u32 = 244;
        pub const SYS_TIMERFD_GETTIME: u32 = 245;
        pub const SYS_SIGNALFD4: u32 = 246;
        pub const SYS_PRLIMIT64: u32 = 250;
        pub const SYS_PPOLL: u32 = 251;
        pub const SYS_PSELECT6: u32 = 252;
        pub const SYS_MEMFD_CREATE: u32 = 256;
        pub const SYS_STATX: u32 = 260;
        pub const SYS_SET_ROBUST_LIST: u32 = 261;
        pub const SYS_GET_ROBUST_LIST: u32 = 262;
        pub const SYS_SYSINFO: u32 = 269;
        pub const SYS_MKNOD: u32 = 271;
        pub const SYS_MKNODAT: u32 = 272;
        pub const SYS_MSYNC: u32 = 278;
        pub const SYS_MLOCK: u32 = 279;
        pub const SYS_MLOCK2: u32 = 280;
        pub const SYS_MUNLOCK: u32 = 281;
        pub const SYS_WAITID: u32 = 288;
        pub const SYS_COPY_FILE_RANGE: u32 = 290;
        pub const SYS_SPLICE: u32 = 291;
        pub const SYS_READAHEAD: u32 = 293;
        pub const SYS_SENDFILE: u32 = 294;
        pub const SYS_PREADV: u32 = 295;
        pub const SYS_PWRITEV: u32 = 296;
        pub const SYS_PREADV2: u32 = 297;
        pub const SYS_PWRITEV2: u32 = 298;
        pub const SYS_LCHOWN: u32 = 299;
        pub const SYS_RENAMEAT2: u32 = 306;
        pub const SYS_FALLOCATE: u32 = 308;
        pub const SYS_GETCPU: u32 = 325;
        pub const SYS_TIMER_CREATE: u32 = 326;
        pub const SYS_TIMER_SETTIME: u32 = 327;
        pub const SYS_TIMER_GETTIME: u32 = 328;
        pub const SYS_TIMER_GETOVERRUN: u32 = 329;
        pub const SYS_TIMER_DELETE: u32 = 330;
        pub const SYS_MQ_OPEN: u32 = 331;
        pub const SYS_MQ_UNLINK: u32 = 332;
        pub const SYS_MQ_TIMEDSEND: u32 = 333;
        pub const SYS_MQ_TIMEDRECEIVE: u32 = 334;
        pub const SYS_MQ_NOTIFY: u32 = 335;
        pub const SYS_MQ_GETSETATTR: u32 = 336;
        pub const SYS_MSGGET: u32 = 337;
        pub const SYS_MSGRCV: u32 = 338;
        pub const SYS_MSGSND: u32 = 339;
        pub const SYS_MSGCTL: u32 = 340;
        pub const SYS_SEMGET: u32 = 341;
        pub const SYS_SEMOP: u32 = 342;
        pub const SYS_SEMCTL: u32 = 343;
        pub const SYS_SHMGET: u32 = 344;
        pub const SYS_SHMAT: u32 = 345;
        pub const SYS_SHMDT: u32 = 346;
        pub const SYS_SHMCTL: u32 = 347;
        pub const SYS_SIGNALFD: u32 = 377;
        pub const SYS_EPOLL_CREATE: u32 = 378;
        pub const SYS_EPOLL_WAIT: u32 = 379;
        pub const SYS_FACCESSAT2: u32 = 382;
        pub const SYS_FCHMODAT2: u32 = 383;
        pub const SYS_ACCEPT4: u32 = 384;
        pub const SYS_EXIT_GROUP: u32 = 387;
        pub const SYS_THREAD_CANCEL: u32 = 415;

        pub const SYSCALLS: &[AbiSyscallNumber] = &[
            AbiSyscallNumber {
                name: "Llseek",
                number: SYS_LLSEEK,
            },
            AbiSyscallNumber {
                name: "Getrandom",
                number: SYS_GETRANDOM,
            },
            AbiSyscallNumber {
                name: "Flock",
                number: SYS_FLOCK,
            },
            AbiSyscallNumber {
                name: "Futex",
                number: SYS_FUTEX,
            },
            AbiSyscallNumber {
                name: "Clone",
                number: SYS_CLONE,
            },
            AbiSyscallNumber {
                name: "Gettid",
                number: SYS_GETTID,
            },
            AbiSyscallNumber {
                name: "SetTidAddress",
                number: SYS_SET_TID_ADDRESS,
            },
            AbiSyscallNumber {
                name: "Tkill",
                number: SYS_TKILL,
            },
            AbiSyscallNumber {
                name: "RtSigqueueinfo",
                number: SYS_RT_SIGQUEUEINFO,
            },
            AbiSyscallNumber {
                name: "RtSigpending",
                number: SYS_RT_SIGPENDING,
            },
            AbiSyscallNumber {
                name: "RtSigtimedwait",
                number: SYS_RT_SIGTIMEDWAIT,
            },
            AbiSyscallNumber {
                name: "RtSigreturn",
                number: SYS_RT_SIGRETURN,
            },
            AbiSyscallNumber {
                name: "Sigaltstack",
                number: SYS_SIGALTSTACK,
            },
            AbiSyscallNumber {
                name: "Getpgid",
                number: SYS_GETPGID,
            },
            AbiSyscallNumber {
                name: "Setreuid",
                number: SYS_SETREUID,
            },
            AbiSyscallNumber {
                name: "Setregid",
                number: SYS_SETREGID,
            },
            AbiSyscallNumber {
                name: "Prctl",
                number: SYS_PRCTL,
            },
            AbiSyscallNumber {
                name: "Getitimer",
                number: SYS_GETITIMER,
            },
            AbiSyscallNumber {
                name: "Setitimer",
                number: SYS_SETITIMER,
            },
            AbiSyscallNumber {
                name: "ClockSettime",
                number: SYS_CLOCK_SETTIME,
            },
            AbiSyscallNumber {
                name: "SchedYield",
                number: SYS_SCHED_YIELD,
            },
            AbiSyscallNumber {
                name: "SchedGetparam",
                number: SYS_SCHED_GETPARAM,
            },
            AbiSyscallNumber {
                name: "SchedSetparam",
                number: SYS_SCHED_SETPARAM,
            },
            AbiSyscallNumber {
                name: "SchedSetscheduler",
                number: SYS_SCHED_SETSCHEDULER,
            },
            AbiSyscallNumber {
                name: "SchedRrGetInterval",
                number: SYS_SCHED_RR_GET_INTERVAL,
            },
            AbiSyscallNumber {
                name: "SchedSetaffinity",
                number: SYS_SCHED_SETAFFINITY,
            },
            AbiSyscallNumber {
                name: "SchedGetaffinity",
                number: SYS_SCHED_GETAFFINITY,
            },
            AbiSyscallNumber {
                name: "EpollCreate1",
                number: SYS_EPOLL_CREATE1,
            },
            AbiSyscallNumber {
                name: "EpollCtl",
                number: SYS_EPOLL_CTL,
            },
            AbiSyscallNumber {
                name: "EpollPwait",
                number: SYS_EPOLL_PWAIT,
            },
            AbiSyscallNumber {
                name: "TimerfdCreate",
                number: SYS_TIMERFD_CREATE,
            },
            AbiSyscallNumber {
                name: "TimerfdSettime",
                number: SYS_TIMERFD_SETTIME,
            },
            AbiSyscallNumber {
                name: "TimerfdGettime",
                number: SYS_TIMERFD_GETTIME,
            },
            AbiSyscallNumber {
                name: "Signalfd4",
                number: SYS_SIGNALFD4,
            },
            AbiSyscallNumber {
                name: "Prlimit64",
                number: SYS_PRLIMIT64,
            },
            AbiSyscallNumber {
                name: "Ppoll",
                number: SYS_PPOLL,
            },
            AbiSyscallNumber {
                name: "Pselect6",
                number: SYS_PSELECT6,
            },
            AbiSyscallNumber {
                name: "MemfdCreate",
                number: SYS_MEMFD_CREATE,
            },
            AbiSyscallNumber {
                name: "Statx",
                number: SYS_STATX,
            },
            AbiSyscallNumber {
                name: "SetRobustList",
                number: SYS_SET_ROBUST_LIST,
            },
            AbiSyscallNumber {
                name: "GetRobustList",
                number: SYS_GET_ROBUST_LIST,
            },
            AbiSyscallNumber {
                name: "Sysinfo",
                number: SYS_SYSINFO,
            },
            AbiSyscallNumber {
                name: "Mknod",
                number: SYS_MKNOD,
            },
            AbiSyscallNumber {
                name: "Mknodat",
                number: SYS_MKNODAT,
            },
            AbiSyscallNumber {
                name: "Msync",
                number: SYS_MSYNC,
            },
            AbiSyscallNumber {
                name: "Mlock",
                number: SYS_MLOCK,
            },
            AbiSyscallNumber {
                name: "Mlock2",
                number: SYS_MLOCK2,
            },
            AbiSyscallNumber {
                name: "Munlock",
                number: SYS_MUNLOCK,
            },
            AbiSyscallNumber {
                name: "Waitid",
                number: SYS_WAITID,
            },
            AbiSyscallNumber {
                name: "CopyFileRange",
                number: SYS_COPY_FILE_RANGE,
            },
            AbiSyscallNumber {
                name: "Splice",
                number: SYS_SPLICE,
            },
            AbiSyscallNumber {
                name: "Readahead",
                number: SYS_READAHEAD,
            },
            AbiSyscallNumber {
                name: "Sendfile",
                number: SYS_SENDFILE,
            },
            AbiSyscallNumber {
                name: "Preadv",
                number: SYS_PREADV,
            },
            AbiSyscallNumber {
                name: "Pwritev",
                number: SYS_PWRITEV,
            },
            AbiSyscallNumber {
                name: "Preadv2",
                number: SYS_PREADV2,
            },
            AbiSyscallNumber {
                name: "Pwritev2",
                number: SYS_PWRITEV2,
            },
            AbiSyscallNumber {
                name: "Lchown",
                number: SYS_LCHOWN,
            },
            AbiSyscallNumber {
                name: "Renameat2",
                number: SYS_RENAMEAT2,
            },
            AbiSyscallNumber {
                name: "Fallocate",
                number: SYS_FALLOCATE,
            },
            AbiSyscallNumber {
                name: "Getcpu",
                number: SYS_GETCPU,
            },
            AbiSyscallNumber {
                name: "TimerCreate",
                number: SYS_TIMER_CREATE,
            },
            AbiSyscallNumber {
                name: "TimerSettime",
                number: SYS_TIMER_SETTIME,
            },
            AbiSyscallNumber {
                name: "TimerGettime",
                number: SYS_TIMER_GETTIME,
            },
            AbiSyscallNumber {
                name: "TimerGetoverrun",
                number: SYS_TIMER_GETOVERRUN,
            },
            AbiSyscallNumber {
                name: "TimerDelete",
                number: SYS_TIMER_DELETE,
            },
            AbiSyscallNumber {
                name: "MqOpen",
                number: SYS_MQ_OPEN,
            },
            AbiSyscallNumber {
                name: "MqUnlink",
                number: SYS_MQ_UNLINK,
            },
            AbiSyscallNumber {
                name: "MqTimedsend",
                number: SYS_MQ_TIMEDSEND,
            },
            AbiSyscallNumber {
                name: "MqTimedreceive",
                number: SYS_MQ_TIMEDRECEIVE,
            },
            AbiSyscallNumber {
                name: "MqNotify",
                number: SYS_MQ_NOTIFY,
            },
            AbiSyscallNumber {
                name: "MqGetsetattr",
                number: SYS_MQ_GETSETATTR,
            },
            AbiSyscallNumber {
                name: "Msgget",
                number: SYS_MSGGET,
            },
            AbiSyscallNumber {
                name: "Msgrcv",
                number: SYS_MSGRCV,
            },
            AbiSyscallNumber {
                name: "Msgsnd",
                number: SYS_MSGSND,
            },
            AbiSyscallNumber {
                name: "Msgctl",
                number: SYS_MSGCTL,
            },
            AbiSyscallNumber {
                name: "Semget",
                number: SYS_SEMGET,
            },
            AbiSyscallNumber {
                name: "Semop",
                number: SYS_SEMOP,
            },
            AbiSyscallNumber {
                name: "Semctl",
                number: SYS_SEMCTL,
            },
            AbiSyscallNumber {
                name: "Shmget",
                number: SYS_SHMGET,
            },
            AbiSyscallNumber {
                name: "Shmat",
                number: SYS_SHMAT,
            },
            AbiSyscallNumber {
                name: "Shmdt",
                number: SYS_SHMDT,
            },
            AbiSyscallNumber {
                name: "Shmctl",
                number: SYS_SHMCTL,
            },
            AbiSyscallNumber {
                name: "Signalfd",
                number: SYS_SIGNALFD,
            },
            AbiSyscallNumber {
                name: "EpollCreate",
                number: SYS_EPOLL_CREATE,
            },
            AbiSyscallNumber {
                name: "EpollWait",
                number: SYS_EPOLL_WAIT,
            },
            AbiSyscallNumber {
                name: "Faccessat2",
                number: SYS_FACCESSAT2,
            },
            AbiSyscallNumber {
                name: "Fchmodat2",
                number: SYS_FCHMODAT2,
            },
            AbiSyscallNumber {
                name: "Accept4",
                number: SYS_ACCEPT4,
            },
            AbiSyscallNumber {
                name: "ExitGroup",
                number: SYS_EXIT_GROUP,
            },
            AbiSyscallNumber {
                name: "ThreadCancel",
                number: SYS_THREAD_CANCEL,
            },
        ];
    }

    /// Host-intercepted syscall numbers (caught by `host/src/kernel-worker.ts`
    /// before reaching the kernel's syscall dispatcher). The kernel never sees
    /// these on the channel — the host calls the corresponding `kernel_*`
    /// export directly.
    ///
    /// These exist outside the [`crate::Syscall`] enum because that enum is for
    /// kernel-dispatched syscalls only. Adding/removing a value here is an ABI
    /// change and requires bumping [`crate::ABI_VERSION`].
    pub mod host_intercepted {
        /// Non-forking `posix_spawn` (this kernel's invention; no Linux
        /// equivalent). Host calls `kernel_spawn_process`. See
        /// `docs/plans/2026-05-04-non-forking-posix-spawn-design.md`.
        ///
        /// Numbered 500 to sit clear of every Linux syscall numbering
        /// scheme and of our kernel-side dispatch table in `wasm_api.rs`
        /// (highest used: 415). The original plan picked 214 to neighbour
        /// SYS_FORK, but 214 collides with the kernel's existing
        /// SYS_GETPGID handler — host-interception alone wouldn't help
        /// because every legitimate getpgid call would also be caught.
        pub const SYS_SPAWN: u32 = 500;

        /// Documented for completeness — also defined in
        /// `libc/glue/channel_syscall.c` and `host/src/kernel-worker.ts`.
        pub const SYS_EXECVE: u32 = 211;
        pub const SYS_FORK: u32 = 212;
        pub const SYS_VFORK: u32 = 213;
        pub const SYS_EXECVEAT: u32 = 386;
    }

    /// Decide whether a kernel-wasm export name should appear in the
    /// snapshot. Implementation-detail symbols (per
    /// [`EXPORT_DENY_PREFIXES`] / [`EXPORT_DENY_EXACT`]) are filtered
    /// out; everything else is kept.
    pub fn export_is_tracked(name: &str) -> bool {
        if EXPORT_DENY_EXACT.iter().any(|&n| n == name) {
            return false;
        }
        if EXPORT_DENY_PREFIXES.iter().any(|&p| name.starts_with(p)) {
            return false;
        }
        true
    }

    /// Decide whether the initial value of a matching immutable global
    /// should be captured in the snapshot.
    pub fn export_value_is_tracked(name: &str) -> bool {
        ABI_VALUE_CAPTURE_PREFIXES
            .iter()
            .any(|&p| name.starts_with(p))
    }

    #[cfg(test)]
    mod tests {
        use super::{
            HOST_ADAPTER_MANIFEST, HOST_ADAPTER_MANIFEST_MAGIC, HOST_ADAPTER_MANIFEST_SIZE,
            HOST_ADAPTER_MANIFEST_VERSION, HOST_ADAPTER_OPTIONAL_KERNEL_EXPORTS,
            HOST_ADAPTER_REQUIRED_KERNEL_EXPORTS, HOST_ADAPTER_REQUIRED_WORKER_FEATURES,
            HOST_ADAPTER_VERSION, HOST_ADAPTER_WORKER_FEATURES,
            WPK_FORK_ACTIVATION_CONTINUATION_ENTRY_SIZE,
            WPK_FORK_ACTIVATION_CONTINUATIONS_HEADER_SIZE, WPK_FORK_ACTIVATION_CONTINUATIONS_MAGIC,
            WPK_FORK_ACTIVATION_CONTINUATIONS_OWNER, WPK_FORK_EXCEPTION_CODEC_HEADER_SIZE,
            WPK_FORK_EXCEPTION_CODEC_SECTION, WPK_FORK_EXCEPTION_CODEC_TAG_RECORD_SIZE,
            WPK_FORK_EXCEPTION_CODEC_VERSION, WPK_FORK_EXCEPTION_IMPORT_ACTIVATION,
            WPK_FORK_GC_CODEC_FIELD_RECORD_SIZE, WPK_FORK_GC_CODEC_HEADER_SIZE,
            WPK_FORK_GC_CODEC_LAYOUT_RECORD_SIZE, WPK_FORK_GC_CODEC_MAGIC,
            WPK_FORK_IMPORTED_GLOBAL_BINDINGS_ENTRY_SIZE,
            WPK_FORK_IMPORTED_GLOBAL_BINDINGS_HEADER_SIZE, WPK_FORK_IMPORTED_GLOBAL_BINDINGS_MAGIC,
            WPK_FORK_IMPORTED_GLOBAL_BINDINGS_OWNER, WPK_FORK_IMPORTED_GLOBAL_FLAG_MUTABLE,
            WPK_FORK_IMPORTED_GLOBAL_FLAG_SHARED, WPK_FORK_IMPORTED_GLOBAL_KNOWN_FLAGS,
            WPK_FORK_IMPORTED_GLOBALS_HEADER_SIZE, WPK_FORK_IMPORTED_GLOBALS_MAGIC,
            WPK_FORK_IMPORTED_GLOBALS_RECORD_HEADER_SIZE,
            WPK_FORK_IMPORTED_TABLE_BINDINGS_ENTRY_SIZE,
            WPK_FORK_IMPORTED_TABLE_BINDINGS_HEADER_SIZE, WPK_FORK_IMPORTED_TABLE_BINDINGS_MAGIC,
            WPK_FORK_IMPORTED_TABLE_BINDINGS_OWNER, WPK_FORK_IMPORTED_TABLES_HEADER_SIZE,
            WPK_FORK_IMPORTED_TABLES_MAGIC, WPK_FORK_IMPORTED_TABLES_RECORD_HEADER_SIZE,
            WPK_FORK_LINKED_FRAME_DESCRIPTOR_SIZE, WPK_FORK_LINKED_FRAME_FORMAT_MAGIC,
            WPK_FORK_LINKED_FRAME_POINTER_WIDTHS, WPK_FORK_LINKED_FRAME_REQUIRED_FLAGS,
            WPK_FORK_MODULE_STATE_ARENA_VERSION, WPK_FORK_MODULE_STATE_CHUNK_KNOWN_FLAGS,
            WPK_FORK_MODULE_STATE_CHUNK_MAGIC, WPK_FORK_MODULE_STATE_DATA_SEGMENT_HEADER_SIZE,
            WPK_FORK_MODULE_STATE_DESCRIPTOR_SIZE,
            WPK_FORK_MODULE_STATE_ELEMENT_SEGMENT_HEADER_SIZE, WPK_FORK_MODULE_STATE_FORMAT_MAGIC,
            WPK_FORK_MODULE_STATE_KNOWN_FLAGS, WPK_FORK_MODULE_STATE_MAX_TABLE_PAGE_SHIFT,
            WPK_FORK_MODULE_STATE_MIN_TABLE_PAGE_SHIFT,
            WPK_FORK_MODULE_STATE_MODULE_RECORD_PAYLOAD_SIZE,
            WPK_FORK_MODULE_STATE_MODULE_TEMPLATE_ID_SIZE, WPK_FORK_MODULE_STATE_POINTER_WIDTHS,
            WPK_FORK_MODULE_STATE_RECORD_HEADER_SIZE, WPK_FORK_MODULE_STATE_RECORD_KINDS,
            WPK_FORK_MODULE_STATE_RECORD_MAGIC, WPK_FORK_MODULE_STATE_RECORD_VERSION,
            WPK_FORK_MODULE_STATE_REPLAY_EVENT_SEGMENT_CAPACITY,
            WPK_FORK_MODULE_STATE_REPLAY_EVENT_SEGMENT_HEADER_SIZE,
            WPK_FORK_MODULE_STATE_REPLAY_EVENT_SEGMENT_VERSION,
            WPK_FORK_MODULE_STATE_REPLAY_EVENT_SIZE,
            WPK_FORK_MODULE_STATE_REPLAY_EVENTS_HEADER_SIZE,
            WPK_FORK_MODULE_STATE_REPLAY_EVENTS_MAGIC, WPK_FORK_MODULE_STATE_REPLAY_EVENTS_OWNER,
            WPK_FORK_MODULE_STATE_REPLAY_EVENTS_VERSION, WPK_FORK_MODULE_STATE_REQUIRED_FLAGS,
            WPK_FORK_MODULE_STATE_ROOT_POINTER_WORD_OFFSET,
            WPK_FORK_MODULE_STATE_TABLE_BASELINE_FINGERPRINT_SIZE,
            WPK_FORK_MODULE_STATE_TABLE_DESCRIPTOR_PAYLOAD_SIZE,
            WPK_FORK_MODULE_STATE_TABLE_PAGE_SHIFT, WPK_FORK_REQUIRED_EXPORTS,
            WPK_CHECKPOINT_PROCESS_IMPORT, WPK_FORK_PROCESS_IMPORT, WPK_FORK_REQUIRED_IMPORTS,
            WPK_FORK_REQUIRED_TABLE_IMPORTS,
            extended_syscalls::SYSCALLS, wpk_fork_linked_chunk_header_size,
            wpk_fork_linked_node_header_size, wpk_fork_module_state_chunk_header_size,
        };
        use crate::Syscall;

        #[test]
        fn extended_syscalls_are_sorted_unique_and_do_not_overlap_core_enum() {
            let mut prev = None;
            for syscall in SYSCALLS {
                if let Some(prev) = prev {
                    assert!(
                        prev < syscall.number,
                        "extended syscall metadata must be sorted and unique"
                    );
                }
                assert!(
                    Syscall::from_u32(syscall.number).is_none(),
                    "extended syscall {} overlaps core Syscall enum",
                    syscall.name
                );
                prev = Some(syscall.number);
            }
        }

        #[test]
        fn host_adapter_manifest_matches_channel_and_abi_metadata() {
            assert_eq!(HOST_ADAPTER_MANIFEST.magic, HOST_ADAPTER_MANIFEST_MAGIC);
            assert_eq!(
                HOST_ADAPTER_MANIFEST.manifest_version,
                HOST_ADAPTER_MANIFEST_VERSION
            );
            assert_eq!(
                HOST_ADAPTER_MANIFEST.manifest_size,
                HOST_ADAPTER_MANIFEST_SIZE
            );
            assert_eq!(HOST_ADAPTER_MANIFEST.abi_version, crate::ABI_VERSION);
            assert_eq!(
                HOST_ADAPTER_MANIFEST.required_host_adapter_version,
                HOST_ADAPTER_VERSION
            );
            assert_eq!(
                HOST_ADAPTER_MANIFEST.required_worker_features,
                HOST_ADAPTER_REQUIRED_WORKER_FEATURES
            );
            assert_eq!(
                HOST_ADAPTER_MANIFEST.channel_header_size,
                crate::channel::HEADER_SIZE as u32
            );
            assert_eq!(
                HOST_ADAPTER_MANIFEST.channel_data_offset,
                crate::channel::DATA_OFFSET as u32
            );
            assert_eq!(
                HOST_ADAPTER_MANIFEST.channel_data_size,
                crate::channel::DATA_SIZE as u32
            );
            assert_eq!(
                HOST_ADAPTER_MANIFEST.channel_min_size,
                crate::channel::MIN_CHANNEL_SIZE as u32
            );
        }

        #[test]
        fn host_adapter_export_and_feature_lists_are_sorted_unique() {
            assert_sorted_unique(HOST_ADAPTER_REQUIRED_KERNEL_EXPORTS);
            assert_sorted_unique(HOST_ADAPTER_OPTIONAL_KERNEL_EXPORTS);

            let mut required_worker_features = 0;
            let mut previous_name = "";
            for feature in HOST_ADAPTER_WORKER_FEATURES {
                assert!(previous_name < feature.name, "features must be sorted");
                assert_ne!(feature.bit, 0, "feature bit must be non-zero");
                assert_eq!(
                    feature.bit.count_ones(),
                    1,
                    "feature bit must be a single bit"
                );
                assert_eq!(
                    required_worker_features & feature.bit,
                    0,
                    "feature bits must be unique"
                );
                required_worker_features |= feature.bit;
                previous_name = feature.name;
            }
            assert_eq!(
                required_worker_features,
                HOST_ADAPTER_REQUIRED_WORKER_FEATURES
            );
        }

        #[test]
        fn host_adapter_requires_every_host_owned_retry_authority_export() {
            for required in [
                "kernel_blocking_retry_release",
                "kernel_blocking_retry_token",
                "kernel_dequeue_signal",
                "kernel_get_socket_timeout_ms",
                "kernel_is_fd_nonblock",
                "kernel_pick_signal_target_tid",
                "kernel_thread_has_deliverable",
            ] {
                assert!(
                    HOST_ADAPTER_REQUIRED_KERNEL_EXPORTS
                        .binary_search(&required)
                        .is_ok(),
                    "host-owned retry protocol silently treats {required} as optional"
                );
            }
        }

        #[test]
        fn linked_fork_program_artifact_contract_is_complete_and_sorted() {
            assert_eq!(crate::fork_contract::MODE_FORK, 0);
            assert_eq!(crate::fork_contract::MODE_VFORK, 1);
            assert_eq!(
                crate::fork_contract::Mode::from_u32(crate::fork_contract::MODE_FORK),
                Some(crate::fork_contract::Mode::Fork),
            );
            assert_eq!(
                crate::fork_contract::Mode::from_u32(crate::fork_contract::MODE_VFORK),
                Some(crate::fork_contract::Mode::Vfork),
            );
            assert_eq!(crate::fork_contract::Mode::from_u32(2), None);
            assert_eq!(WPK_FORK_PROCESS_IMPORT.module, "kernel");
            assert_eq!(WPK_FORK_PROCESS_IMPORT.name, "kernel_fork");
            assert_eq!(WPK_FORK_PROCESS_IMPORT.params, &[super::ProgramArtifactValueType::I32]);
            assert_eq!(WPK_FORK_PROCESS_IMPORT.results, &[super::ProgramArtifactValueType::I32]);

            assert_eq!(WPK_CHECKPOINT_PROCESS_IMPORT.module, "kernel");
            assert_eq!(WPK_CHECKPOINT_PROCESS_IMPORT.name, "kernel_checkpoint");
            assert!(WPK_CHECKPOINT_PROCESS_IMPORT.params.is_empty());
            assert!(WPK_CHECKPOINT_PROCESS_IMPORT.results.is_empty());

            assert_eq!(WPK_FORK_LINKED_FRAME_FORMAT_MAGIC, *b"KLCF");
            assert_eq!(WPK_FORK_LINKED_FRAME_DESCRIPTOR_SIZE, 24);
            assert_eq!(WPK_FORK_LINKED_FRAME_REQUIRED_FLAGS, 0b11);
            assert_eq!(WPK_FORK_LINKED_FRAME_POINTER_WIDTHS, &[4, 8]);
            assert_eq!(wpk_fork_linked_chunk_header_size(4), Some(32));
            assert_eq!(wpk_fork_linked_node_header_size(4), Some(24));
            assert_eq!(wpk_fork_linked_chunk_header_size(8), Some(56));
            assert_eq!(wpk_fork_linked_node_header_size(8), Some(32));
            assert_eq!(wpk_fork_linked_chunk_header_size(16), None);
            assert_eq!(wpk_fork_linked_node_header_size(16), None);

            assert_eq!(WPK_FORK_REQUIRED_IMPORTS.len(), 45);
            let mut previous_import = ("", "");
            for requirement in WPK_FORK_REQUIRED_IMPORTS {
                let current = (requirement.module, requirement.name);
                assert!(
                    previous_import < current,
                    "fork imports must be sorted and unique: \
                     previous={previous_import:?}, current={current:?}"
                );
                previous_import = current;
            }

            assert_eq!(WPK_FORK_REQUIRED_TABLE_IMPORTS.len(), 2);
            let mut previous_table_import = ("", "");
            for requirement in WPK_FORK_REQUIRED_TABLE_IMPORTS {
                let current = (requirement.module, requirement.name);
                assert!(
                    previous_table_import < current,
                    "fork table imports must be sorted and unique"
                );
                previous_table_import = current;
            }
            assert_eq!(WPK_FORK_REQUIRED_EXPORTS.len(), 28);
            let mut previous_export = "";
            for requirement in WPK_FORK_REQUIRED_EXPORTS {
                assert!(
                    previous_export < requirement.name,
                    "fork exports must be sorted and unique: \
                     previous={previous_export:?}, current={:?}",
                    requirement.name,
                );
                previous_export = requirement.name;
            }
        }

        #[test]
        fn module_state_recipe_contract_is_complete_and_sorted() {
            assert_eq!(WPK_FORK_MODULE_STATE_FORMAT_MAGIC, *b"KFMD");
            assert_eq!(WPK_FORK_MODULE_STATE_DESCRIPTOR_SIZE, 24);
            assert_eq!(WPK_FORK_MODULE_STATE_REQUIRED_FLAGS, 0b111);
            assert_eq!(
                WPK_FORK_MODULE_STATE_KNOWN_FLAGS,
                WPK_FORK_MODULE_STATE_REQUIRED_FLAGS
            );
            assert_eq!(WPK_FORK_MODULE_STATE_ARENA_VERSION, 1);
            assert_eq!(WPK_FORK_MODULE_STATE_RECORD_VERSION, 1);
            assert_eq!(WPK_FORK_MODULE_STATE_ROOT_POINTER_WORD_OFFSET, 1);
            assert_eq!(WPK_FORK_MODULE_STATE_CHUNK_MAGIC, *b"KFMC");
            assert_eq!(WPK_FORK_MODULE_STATE_CHUNK_KNOWN_FLAGS, 0b11);
            assert_eq!(WPK_FORK_MODULE_STATE_RECORD_MAGIC, *b"KFMR");
            assert_eq!(WPK_FORK_MODULE_STATE_RECORD_HEADER_SIZE, 24);
            assert_eq!(WPK_FORK_MODULE_STATE_POINTER_WIDTHS, &[4, 8]);
            assert_eq!(wpk_fork_module_state_chunk_header_size(4), Some(40));
            assert_eq!(wpk_fork_module_state_chunk_header_size(8), Some(56));
            assert_eq!(wpk_fork_module_state_chunk_header_size(16), None);

            let mut previous_number = 0;
            for kind in WPK_FORK_MODULE_STATE_RECORD_KINDS {
                assert!(
                    previous_number < kind.number,
                    "module-state record kinds must be sorted and unique"
                );
                assert!(!kind.name.is_empty());
                previous_number = kind.number;
            }
            assert_eq!(WPK_FORK_MODULE_STATE_RECORD_KINDS.len(), 13);

            assert_eq!(WPK_FORK_MODULE_STATE_MODULE_TEMPLATE_ID_SIZE, 32);
            assert_eq!(WPK_FORK_MODULE_STATE_MODULE_RECORD_PAYLOAD_SIZE, 40);
            assert_eq!(WPK_FORK_MODULE_STATE_TABLE_BASELINE_FINGERPRINT_SIZE, 32);
            assert_eq!(WPK_FORK_MODULE_STATE_TABLE_DESCRIPTOR_PAYLOAD_SIZE, 56);
            assert_eq!(WPK_FORK_MODULE_STATE_ELEMENT_SEGMENT_HEADER_SIZE, 8);
            assert_eq!(WPK_FORK_MODULE_STATE_DATA_SEGMENT_HEADER_SIZE, 8);
            assert_eq!(WPK_FORK_MODULE_STATE_REPLAY_EVENTS_OWNER, 1);
            assert_eq!(WPK_FORK_MODULE_STATE_REPLAY_EVENTS_MAGIC, *b"KFRE");
            assert_eq!(WPK_FORK_MODULE_STATE_REPLAY_EVENTS_VERSION, 2);
            assert_eq!(WPK_FORK_MODULE_STATE_REPLAY_EVENTS_HEADER_SIZE, 40);
            assert_eq!(WPK_FORK_MODULE_STATE_REPLAY_EVENT_SIZE, 8);
            assert_eq!(WPK_FORK_MODULE_STATE_REPLAY_EVENT_SEGMENT_VERSION, 1);
            assert_eq!(WPK_FORK_MODULE_STATE_REPLAY_EVENT_SEGMENT_HEADER_SIZE, 24);
            assert_eq!(WPK_FORK_MODULE_STATE_REPLAY_EVENT_SEGMENT_CAPACITY, 4080);
            assert_eq!(WPK_FORK_IMPORTED_GLOBAL_BINDINGS_MAGIC, *b"KFBG");
            assert_eq!(WPK_FORK_IMPORTED_GLOBAL_BINDINGS_OWNER, 2);
            assert_eq!(WPK_FORK_IMPORTED_GLOBAL_BINDINGS_HEADER_SIZE, 24);
            assert_eq!(WPK_FORK_IMPORTED_GLOBAL_BINDINGS_ENTRY_SIZE, 40);
            assert_eq!(WPK_FORK_ACTIVATION_CONTINUATIONS_MAGIC, *b"KFAC");
            assert_eq!(WPK_FORK_ACTIVATION_CONTINUATIONS_OWNER, 3);
            assert_eq!(WPK_FORK_ACTIVATION_CONTINUATIONS_HEADER_SIZE, 24);
            assert_eq!(WPK_FORK_ACTIVATION_CONTINUATION_ENTRY_SIZE, 16);
            assert_eq!(WPK_FORK_IMPORTED_TABLE_BINDINGS_MAGIC, *b"KFBT");
            assert_eq!(WPK_FORK_IMPORTED_TABLE_BINDINGS_OWNER, 4);
            assert_eq!(WPK_FORK_IMPORTED_TABLE_BINDINGS_HEADER_SIZE, 24);
            assert_eq!(WPK_FORK_IMPORTED_TABLE_BINDINGS_ENTRY_SIZE, 24);
            assert_eq!(WPK_FORK_IMPORTED_GLOBALS_MAGIC, *b"KFIG");
            assert_eq!(WPK_FORK_IMPORTED_GLOBALS_HEADER_SIZE, 16);
            assert_eq!(WPK_FORK_IMPORTED_GLOBALS_RECORD_HEADER_SIZE, 24);
            assert_eq!(WPK_FORK_IMPORTED_GLOBAL_KNOWN_FLAGS, 0b11);
            assert_eq!(WPK_FORK_IMPORTED_GLOBAL_FLAG_MUTABLE, 0b01);
            assert_eq!(WPK_FORK_IMPORTED_GLOBAL_FLAG_SHARED, 0b10);
            assert_eq!(WPK_FORK_IMPORTED_TABLES_MAGIC, *b"KFIT");
            assert_eq!(WPK_FORK_IMPORTED_TABLES_HEADER_SIZE, 16);
            assert_eq!(WPK_FORK_IMPORTED_TABLES_RECORD_HEADER_SIZE, 24);
            assert_eq!(WPK_FORK_GC_CODEC_MAGIC, *b"KFGC");
            assert_eq!(WPK_FORK_GC_CODEC_HEADER_SIZE, 16);
            assert_eq!(WPK_FORK_GC_CODEC_LAYOUT_RECORD_SIZE, 44);
            assert_eq!(WPK_FORK_GC_CODEC_FIELD_RECORD_SIZE, 12);
            assert_eq!(
                WPK_FORK_EXCEPTION_CODEC_SECTION,
                "kandelo.wpk_fork.exception_codec"
            );
            assert_eq!(WPK_FORK_EXCEPTION_CODEC_VERSION, 1);
            assert_eq!(WPK_FORK_EXCEPTION_CODEC_HEADER_SIZE, 8);
            assert_eq!(WPK_FORK_EXCEPTION_CODEC_TAG_RECORD_SIZE, 16);
            assert_eq!(
                WPK_FORK_EXCEPTION_IMPORT_ACTIVATION,
                "__wpk_fork_module_activation"
            );
            assert_eq!(WPK_FORK_MODULE_STATE_MIN_TABLE_PAGE_SHIFT, 4);
            assert_eq!(WPK_FORK_MODULE_STATE_MAX_TABLE_PAGE_SHIFT, 20);
            assert_eq!(WPK_FORK_MODULE_STATE_TABLE_PAGE_SHIFT, 10);
        }

        fn assert_sorted_unique(items: &[&str]) {
            let mut prev = None;
            for item in items {
                if let Some(prev) = prev {
                    assert!(prev < *item, "items must be sorted and unique");
                }
                prev = Some(*item);
            }
        }
    }
}

/// Linux fbdev ABI constants and marshalled structs.
///
/// These mirror what musl exposes via `<linux/fb.h>` to programs built with
/// `wasm32posix-cc`. Field order, sizes, and offsets must match the Linux
/// ABI exactly: any change here is a binary-level break and requires
/// bumping [`ABI_VERSION`] (see crate root) and updating
/// `abi/snapshot.json` in the same commit.
pub mod fbdev {
    /// `FBIOGET_VSCREENINFO` — read variable screen info.
    pub const FBIOGET_VSCREENINFO: u32 = 0x4600;
    /// `FBIOPUT_VSCREENINFO` — write variable screen info (mode set).
    pub const FBIOPUT_VSCREENINFO: u32 = 0x4601;
    /// `FBIOGET_FSCREENINFO` — read fixed screen info.
    pub const FBIOGET_FSCREENINFO: u32 = 0x4602;
    /// `FBIOPAN_DISPLAY` — pan / present.
    pub const FBIOPAN_DISPLAY: u32 = 0x4606;

    /// `FB_TYPE_PACKED_PIXELS`.
    pub const FB_TYPE_PACKED_PIXELS: u32 = 0;
    /// `FB_VISUAL_TRUECOLOR`.
    pub const FB_VISUAL_TRUECOLOR: u32 = 2;

    /// Linux `struct fb_bitfield` — one channel of pixel layout.
    /// Total: 12 bytes. No padding.
    #[derive(Debug, Clone, Copy, Default)]
    #[repr(C)]
    pub struct FbBitfield {
        pub offset: u32,
        pub length: u32,
        pub msb_right: u32,
    }

    /// Linux `struct fb_var_screeninfo` — variable screen info.
    ///
    /// Total: 160 bytes. Field offsets are part of the ABI.
    #[derive(Debug, Clone, Copy, Default)]
    #[repr(C)]
    pub struct FbVarScreenInfo {
        pub xres: u32,           // 0
        pub yres: u32,           // 4
        pub xres_virtual: u32,   // 8
        pub yres_virtual: u32,   // 12
        pub xoffset: u32,        // 16
        pub yoffset: u32,        // 20
        pub bits_per_pixel: u32, // 24
        pub grayscale: u32,      // 28
        pub red: FbBitfield,     // 32 (12)
        pub green: FbBitfield,   // 44 (12)
        pub blue: FbBitfield,    // 56 (12)
        pub transp: FbBitfield,  // 68 (12)
        pub nonstd: u32,         // 80
        pub activate: u32,       // 84
        pub height: u32,         // 88
        pub width: u32,          // 92
        pub accel_flags: u32,    // 96
        pub pixclock: u32,       // 100
        pub left_margin: u32,    // 104
        pub right_margin: u32,   // 108
        pub upper_margin: u32,   // 112
        pub lower_margin: u32,   // 116
        pub hsync_len: u32,      // 120
        pub vsync_len: u32,      // 124
        pub sync: u32,           // 128
        pub vmode: u32,          // 132
        pub rotate: u32,         // 136
        pub colorspace: u32,     // 140
        pub reserved: [u32; 4],  // 144 (16)
                                 // total: 160
    }

    /// Linux `struct fb_fix_screeninfo` — fixed screen info (32-bit user-space
    /// flavour, total 80 bytes).
    ///
    /// On native Linux this struct uses native pointer width for `smem_start`
    /// and `mmio_start`. fbDOOM only reads `id`, `smem_len`, `line_length`,
    /// `type`, and `visual` — we report 0 for the address-shaped fields,
    /// keeping the struct 32-bit-flavoured to match what musl's
    /// `<linux/fb.h>` exposes to user-space programs built with `wasm32posix-cc`.
    /// The trailing `_pad_to_80` aligns this to the 80-byte size that musl
    /// programs (and the kernel ABI snapshot) expect.
    #[derive(Debug, Clone, Copy, Default)]
    #[repr(C)]
    pub struct FbFixScreenInfo {
        pub id: [u8; 16],         // 0
        pub smem_start: u32,      // 16  (always 0 in our model)
        pub smem_len: u32,        // 20
        pub fb_type: u32,         // 24  (FB_TYPE_PACKED_PIXELS)
        pub type_aux: u32,        // 28
        pub visual: u32,          // 32  (FB_VISUAL_TRUECOLOR)
        pub xpanstep: u16,        // 36
        pub ypanstep: u16,        // 38
        pub ywrapstep: u16,       // 40
        pub _pad: u16,            // 42
        pub line_length: u32,     // 44
        pub mmio_start: u32,      // 48  (always 0)
        pub mmio_len: u32,        // 52
        pub accel: u32,           // 56
        pub capabilities: u16,    // 60
        pub reserved: [u16; 3],   // 62 (6)
        pub _pad_to_80: [u8; 12], // 68 (12) → 80
    }
}

#[cfg(test)]
mod fbdev_tests {
    use super::fbdev::*;
    use core::mem::size_of;

    #[test]
    fn struct_sizes_match_linux_abi() {
        assert_eq!(size_of::<FbBitfield>(), 12);
        assert_eq!(size_of::<FbVarScreenInfo>(), 160);
        assert_eq!(size_of::<FbFixScreenInfo>(), 80);
    }
}

/// OSS (Open Sound System) ABI constants.
///
/// This is Kandelo's owned wasm32 source ABI, informed by canonical OSS and
/// FreeBSD's PCM frontend. Every supported command has real state semantics;
/// unsupported capture, duplex, trigger, and mmap operations remain errors.
pub mod oss {
    // Pin canonical OSS ioctl encodings explicitly so the SDK header and Rust
    // frontend cannot inherit or drift with a host operating system's ABI.

    /// `SNDCTL_DSP_RESET` — flush + stop. No argument.
    pub const SNDCTL_DSP_RESET: u32 = 0x00005000;
    /// `SNDCTL_DSP_SYNC` — block until output drains. No argument.
    pub const SNDCTL_DSP_SYNC: u32 = 0x00005001;
    /// `SNDCTL_DSP_SPEED` — get/set sample rate. inout: i32 hz.
    pub const SNDCTL_DSP_SPEED: u32 = 0xc0045002;
    /// `SNDCTL_DSP_STEREO` — get/set channel count via boolean. inout: i32 (0=mono, 1=stereo).
    pub const SNDCTL_DSP_STEREO: u32 = 0xc0045003;
    /// `SNDCTL_DSP_GETBLKSIZE` — preferred fragment size. out: i32 bytes.
    pub const SNDCTL_DSP_GETBLKSIZE: u32 = 0xc0045004;
    /// FreeBSD's distinct block-size setter; pinned for source ABI but unsupported.
    pub const SNDCTL_DSP_SETBLKSIZE: u32 = 0x40045004;
    /// `SNDCTL_DSP_SETFMT` — get/set sample format. inout: i32 AFMT_*.
    pub const SNDCTL_DSP_SETFMT: u32 = 0xc0045005;
    /// `SNDCTL_DSP_CHANNELS` — get/set explicit channel count. inout: i32.
    pub const SNDCTL_DSP_CHANNELS: u32 = 0xc0045006;
    /// Legacy PCM filter control; pinned for source ABI but unsupported.
    pub const SOUND_PCM_WRITE_FILTER: u32 = 0xc0045007;
    /// `SNDCTL_DSP_POST` — start playback of queued output. No argument.
    pub const SNDCTL_DSP_POST: u32 = 0x00005008;
    /// Legacy fragment subdivision control; pinned for source ABI but unsupported.
    pub const SNDCTL_DSP_SUBDIVIDE: u32 = 0xc0045009;
    /// `SNDCTL_DSP_GETFMTS` — bitmask of supported formats. out: i32 AFMT_* mask.
    pub const SNDCTL_DSP_GETFMTS: u32 = 0x8004500b;
    /// `SNDCTL_DSP_SETFRAGMENT` — fragment-size hint. inout: i32.
    pub const SNDCTL_DSP_SETFRAGMENT: u32 = 0xc004500a;
    /// `SNDCTL_DSP_GETOSPACE` — immediately writable output geometry.
    pub const SNDCTL_DSP_GETOSPACE: u32 = 0x8010500c;
    /// Canonical capture query; pinned for source ABI but unsupported.
    pub const SNDCTL_DSP_GETISPACE: u32 = 0x8010500d;
    /// `SNDCTL_DSP_NONBLOCK` — enable non-blocking mode on this OFD.
    pub const SNDCTL_DSP_NONBLOCK: u32 = 0x0000500e;
    /// `SNDCTL_DSP_GETCAPS` — query truthful PCM capabilities.
    pub const SNDCTL_DSP_GETCAPS: u32 = 0x8004500f;
    /// Canonical trigger controls; pinned for source ABI but unsupported.
    pub const SNDCTL_DSP_SETTRIGGER: u32 = 0x40045010;
    pub const SNDCTL_DSP_GETTRIGGER: u32 = 0x80045010;
    /// Canonical capture position; pinned for source ABI but unsupported.
    pub const SNDCTL_DSP_GETIPTR: u32 = 0x800c5011;
    /// `SNDCTL_DSP_GETOPTR` — query monotonic output position.
    pub const SNDCTL_DSP_GETOPTR: u32 = 0x800c5012;
    /// Canonical mmap-buffer operations; pinned for source ABI but unsupported.
    pub const SNDCTL_DSP_MAPINBUF: u32 = 0x80085013;
    pub const SNDCTL_DSP_MAPOUTBUF: u32 = 0x80085014;
    /// Canonical synchronization/duplex controls; pinned but unsupported.
    pub const SNDCTL_DSP_SETSYNCRO: u32 = 0x00005015;
    pub const SNDCTL_DSP_SETDUPLEX: u32 = 0x00005016;
    /// `SNDCTL_DSP_GETODELAY` — queued, not-yet-played output bytes.
    pub const SNDCTL_DSP_GETODELAY: u32 = 0x80045017;
    /// Read-only aliases used by portable OSS clients.
    pub const SOUND_PCM_READ_RATE: u32 = 0x80045002;
    pub const SOUND_PCM_READ_BITS: u32 = 0x80045005;
    pub const SOUND_PCM_READ_CHANNELS: u32 = 0x80045006;
    pub const SOUND_PCM_READ_FILTER: u32 = 0x80045007;

    /// Values accepted by the canonical (currently unsupported) trigger ioctls.
    pub const PCM_ENABLE_INPUT: u32 = 0x0000_0001;
    pub const PCM_ENABLE_OUTPUT: u32 = 0x0000_0002;

    /// `AFMT_QUERY` — query the current format without changing it.
    pub const AFMT_QUERY: u32 = 0;
    // Keep the canonical OSS/FreeBSD format namespace available to source
    // consumers even when the initial playback core does not implement a
    // particular encoding.  `GETFMTS` advertises only `SUPPORTED_FORMATS`,
    // and `SETFMT` rejects every other value.
    pub const AFMT_MU_LAW: u32 = 0x0000_0001;
    pub const AFMT_A_LAW: u32 = 0x0000_0002;
    pub const AFMT_IMA_ADPCM: u32 = 0x0000_0004;
    /// `AFMT_U8` — unsigned 8-bit PCM.
    pub const AFMT_U8: u32 = 0x0000_0008;
    /// `AFMT_S16_LE` — signed 16-bit little-endian PCM.
    pub const AFMT_S16_LE: u32 = 0x0000_0010;
    /// `AFMT_S16_BE` — signed 16-bit big-endian PCM.
    pub const AFMT_S16_BE: u32 = 0x0000_0020;
    pub const AFMT_S8: u32 = 0x0000_0040;
    pub const AFMT_U16_LE: u32 = 0x0000_0080;
    pub const AFMT_U16_BE: u32 = 0x0000_0100;
    pub const AFMT_MPEG: u32 = 0x0000_0200;
    pub const AFMT_AC3: u32 = 0x0000_0400;
    pub const AFMT_S32_LE: u32 = 0x0000_1000;
    pub const AFMT_S32_BE: u32 = 0x0000_2000;
    pub const AFMT_U32_LE: u32 = 0x0000_4000;
    pub const AFMT_U32_BE: u32 = 0x0000_8000;
    pub const AFMT_S24_LE: u32 = 0x0001_0000;
    pub const AFMT_S24_BE: u32 = 0x0002_0000;
    pub const AFMT_U24_LE: u32 = 0x0004_0000;
    pub const AFMT_U24_BE: u32 = 0x0008_0000;
    pub const AFMT_F32_LE: u32 = 0x1000_0000;
    pub const AFMT_F32_BE: u32 = 0x2000_0000;

    pub const SUPPORTED_FORMATS: u32 = AFMT_U8 | AFMT_S16_LE | AFMT_S16_BE;

    // OSS4/FreeBSD core capability bits. The SDK exposes these names for
    // source compatibility; only output/default/virtual are advertised.
    pub const PCM_CAP_REVISION: u32 = 0x0000_00ff;
    pub const PCM_CAP_DUPLEX: u32 = 0x0000_0100;
    pub const PCM_CAP_REALTIME: u32 = 0x0000_0200;
    pub const PCM_CAP_BATCH: u32 = 0x0000_0400;
    pub const PCM_CAP_COPROC: u32 = 0x0000_0800;
    pub const PCM_CAP_TRIGGER: u32 = 0x0000_1000;
    pub const PCM_CAP_MMAP: u32 = 0x0000_2000;
    pub const PCM_CAP_MULTI: u32 = 0x0000_4000;
    pub const PCM_CAP_BIND: u32 = 0x0000_8000;
    pub const PCM_CAP_INPUT: u32 = 0x0001_0000;
    pub const PCM_CAP_OUTPUT: u32 = 0x0002_0000;
    pub const PCM_CAP_VIRTUAL: u32 = 0x0004_0000;
    pub const PCM_CAP_DEFAULT: u32 = 0x4000_0000;
    pub const SUPPORTED_CAPS: u32 = PCM_CAP_OUTPUT | PCM_CAP_VIRTUAL | PCM_CAP_DEFAULT;

    /// Wasm32-owned layout of OSS `audio_buf_info`.
    #[repr(C)]
    #[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
    pub struct AudioBufInfo {
        pub fragments: i32,
        pub fragstotal: i32,
        pub fragsize: i32,
        pub bytes: i32,
    }

    /// Wasm32-owned layout of OSS `count_info`.
    #[repr(C)]
    #[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
    pub struct CountInfo {
        pub bytes: i32,
        pub blocks: i32,
        pub ptr: i32,
    }

}

/// Implementation-neutral PCM host transport contract.
pub mod pcm {
    pub const PCM_TRANSPORT_MAGIC: u32 = 0x314d_4350; // "PCM1" LE
    pub const PCM_TRANSPORT_VERSION: u32 = 1;
    pub const PCM_TRANSPORT_HEADER_BYTES: u32 = 128;
    pub const PCM_TRANSPORT_RING_BYTES: u32 = 64 * 1024;
    pub const PCM_TRANSPORT_BYTES: u32 = PCM_TRANSPORT_HEADER_BYTES + PCM_TRANSPORT_RING_BYTES;

    pub const PCM_STATE_CLOSED: u32 = 0;
    pub const PCM_STATE_STOPPED: u32 = 1;
    pub const PCM_STATE_RUNNING: u32 = 2;
    pub const PCM_STATE_DRAINING: u32 = 3;

    pub const PCM_FORMAT_UNKNOWN: u32 = 0;
    pub const PCM_FORMAT_U8: u32 = 1;
    pub const PCM_FORMAT_S16_LE: u32 = 2;
    pub const PCM_FORMAT_S16_BE: u32 = 3;

    pub const PCM_TRANSPORT_UNCLAIMED: u32 = 0;
    pub const PCM_TRANSPORT_LEGACY_PULL: u32 = 1;
    pub const PCM_TRANSPORT_SHARED_CLOCK: u32 = 2;

    /// Kernel is publishing a new multi-field stream configuration. Host
    /// clocks must render silence and avoid cursor publication until clear.
    pub const PCM_FLAG_CONFIGURING: u32 = 1 << 0;
    /// Playback is currently in an underrun episode. The first transition
    /// into an episode increments `PcmSharedControl::underruns`.
    pub const PCM_FLAG_UNDERRUN_ACTIVE: u32 = 1 << 1;
    /// The attached physical sink failed permanently. Suspension and browser
    /// user-activation waits are recoverable and must not set this bit.
    pub const PCM_FLAG_FATAL_ERROR: u32 = 1 << 2;

    /// Versioned PCM-only header shared with browser AudioWorklets and Node
    /// sinks. Every field is a 32-bit word so JS can use `Atomics` directly.
    /// The three u64 cursors use odd/even seqlocks around low/high words.
    #[repr(C)]
    #[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
    pub struct PcmSharedControl {
        pub magic: u32,
        pub version: u32,
        pub header_bytes: u32,
        pub physical_capacity_bytes: u32,
        pub active_capacity_bytes: u32,
        pub format: u32,
        pub rate: u32,
        pub channels: u32,
        pub frame_bytes: u32,
        pub fragment_bytes: u32,
        pub fragment_count: u32,
        pub state: u32,
        pub generation: u32,
        pub flags: u32,
        pub transport_mode: u32,
        pub producer_seq: u32,
        pub producer_lo: u32,
        pub producer_hi: u32,
        pub consumer_seq: u32,
        pub consumer_lo: u32,
        pub consumer_hi: u32,
        pub discard_seq: u32,
        pub discard_lo: u32,
        pub discard_hi: u32,
        pub underruns: u32,
        pub wake_seq: u32,
        pub reserved: [u32; 6],
    }
}

#[cfg(test)]
mod oss_abi_tests {
    use super::oss::*;
    use super::pcm::*;
    use core::mem::{align_of, offset_of, size_of};

    #[test]
    fn ioctl_values_and_struct_layouts_are_pinned() {
        assert_eq!(SNDCTL_DSP_RESET, 0x0000_5000);
        assert_eq!(SNDCTL_DSP_SYNC, 0x0000_5001);
        assert_eq!(SNDCTL_DSP_SPEED, 0xc004_5002);
        assert_eq!(SNDCTL_DSP_STEREO, 0xc004_5003);
        assert_eq!(SNDCTL_DSP_GETBLKSIZE, 0xc004_5004);
        assert_eq!(SNDCTL_DSP_SETBLKSIZE, 0x4004_5004);
        assert_eq!(SNDCTL_DSP_SETFMT, 0xc004_5005);
        assert_eq!(SNDCTL_DSP_CHANNELS, 0xc004_5006);
        assert_eq!(SOUND_PCM_WRITE_FILTER, 0xc004_5007);
        assert_eq!(SNDCTL_DSP_POST, 0x0000_5008);
        assert_eq!(SNDCTL_DSP_SUBDIVIDE, 0xc004_5009);
        assert_eq!(SNDCTL_DSP_SETFRAGMENT, 0xc004_500a);
        assert_eq!(SNDCTL_DSP_GETFMTS, 0x8004_500b);
        assert_eq!(SNDCTL_DSP_GETOSPACE, 0x8010_500c);
        assert_eq!(SNDCTL_DSP_GETISPACE, 0x8010_500d);
        assert_eq!(SNDCTL_DSP_NONBLOCK, 0x0000_500e);
        assert_eq!(SNDCTL_DSP_GETCAPS, 0x8004_500f);
        assert_eq!(SNDCTL_DSP_SETTRIGGER, 0x4004_5010);
        assert_eq!(SNDCTL_DSP_GETTRIGGER, 0x8004_5010);
        assert_eq!(SNDCTL_DSP_GETIPTR, 0x800c_5011);
        assert_eq!(SNDCTL_DSP_GETOPTR, 0x800c_5012);
        assert_eq!(SNDCTL_DSP_MAPINBUF, 0x8008_5013);
        assert_eq!(SNDCTL_DSP_MAPOUTBUF, 0x8008_5014);
        assert_eq!(SNDCTL_DSP_SETSYNCRO, 0x0000_5015);
        assert_eq!(SNDCTL_DSP_SETDUPLEX, 0x0000_5016);
        assert_eq!(SNDCTL_DSP_GETODELAY, 0x8004_5017);
        assert_eq!(SOUND_PCM_READ_RATE, 0x8004_5002);
        assert_eq!(SOUND_PCM_READ_BITS, 0x8004_5005);
        assert_eq!(SOUND_PCM_READ_CHANNELS, 0x8004_5006);
        assert_eq!(SOUND_PCM_READ_FILTER, 0x8004_5007);
        assert_eq!(PCM_ENABLE_INPUT, 0x0000_0001);
        assert_eq!(PCM_ENABLE_OUTPUT, 0x0000_0002);
        assert_eq!(AFMT_QUERY, 0x0000_0000);
        assert_eq!(AFMT_MU_LAW, 0x0000_0001);
        assert_eq!(AFMT_A_LAW, 0x0000_0002);
        assert_eq!(AFMT_IMA_ADPCM, 0x0000_0004);
        assert_eq!(AFMT_U8, 0x0000_0008);
        assert_eq!(AFMT_S16_LE, 0x0000_0010);
        assert_eq!(AFMT_S16_BE, 0x0000_0020);
        assert_eq!(AFMT_S8, 0x0000_0040);
        assert_eq!(AFMT_U16_LE, 0x0000_0080);
        assert_eq!(AFMT_U16_BE, 0x0000_0100);
        assert_eq!(AFMT_MPEG, 0x0000_0200);
        assert_eq!(AFMT_AC3, 0x0000_0400);
        assert_eq!(AFMT_S32_LE, 0x0000_1000);
        assert_eq!(AFMT_S32_BE, 0x0000_2000);
        assert_eq!(AFMT_U32_LE, 0x0000_4000);
        assert_eq!(AFMT_U32_BE, 0x0000_8000);
        assert_eq!(AFMT_S24_LE, 0x0001_0000);
        assert_eq!(AFMT_S24_BE, 0x0002_0000);
        assert_eq!(AFMT_U24_LE, 0x0004_0000);
        assert_eq!(AFMT_U24_BE, 0x0008_0000);
        assert_eq!(AFMT_F32_LE, 0x1000_0000);
        assert_eq!(AFMT_F32_BE, 0x2000_0000);
        assert_eq!(SUPPORTED_FORMATS, 0x0000_0038);
        assert_eq!(PCM_CAP_REVISION, 0x0000_00ff);
        assert_eq!(PCM_CAP_DUPLEX, 0x0000_0100);
        assert_eq!(PCM_CAP_REALTIME, 0x0000_0200);
        assert_eq!(PCM_CAP_BATCH, 0x0000_0400);
        assert_eq!(PCM_CAP_COPROC, 0x0000_0800);
        assert_eq!(PCM_CAP_TRIGGER, 0x0000_1000);
        assert_eq!(PCM_CAP_MMAP, 0x0000_2000);
        assert_eq!(PCM_CAP_MULTI, 0x0000_4000);
        assert_eq!(PCM_CAP_BIND, 0x0000_8000);
        assert_eq!(PCM_CAP_INPUT, 0x0001_0000);
        assert_eq!(PCM_CAP_OUTPUT, 0x0002_0000);
        assert_eq!(PCM_CAP_VIRTUAL, 0x0004_0000);
        assert_eq!(PCM_CAP_DEFAULT, 0x4000_0000);
        assert_eq!(size_of::<AudioBufInfo>(), 16);
        assert_eq!(align_of::<AudioBufInfo>(), 4);
        assert_eq!(offset_of!(AudioBufInfo, fragments), 0);
        assert_eq!(offset_of!(AudioBufInfo, fragstotal), 4);
        assert_eq!(offset_of!(AudioBufInfo, fragsize), 8);
        assert_eq!(offset_of!(AudioBufInfo, bytes), 12);
        assert_eq!(size_of::<CountInfo>(), 12);
        assert_eq!(align_of::<CountInfo>(), 4);
        assert_eq!(offset_of!(CountInfo, bytes), 0);
        assert_eq!(offset_of!(CountInfo, blocks), 4);
        assert_eq!(offset_of!(CountInfo, ptr), 8);
    }

    #[test]
    fn pcm_transport_layout_is_fixed_for_js_atomics() {
        assert_eq!(size_of::<PcmSharedControl>(), 128);
        assert_eq!(align_of::<PcmSharedControl>(), 4);
        assert_eq!(offset_of!(PcmSharedControl, active_capacity_bytes), 16);
        assert_eq!(offset_of!(PcmSharedControl, state), 44);
        assert_eq!(offset_of!(PcmSharedControl, producer_seq), 60);
        assert_eq!(offset_of!(PcmSharedControl, consumer_seq), 72);
        assert_eq!(offset_of!(PcmSharedControl, discard_seq), 84);
        assert_eq!(offset_of!(PcmSharedControl, underruns), 96);
        assert_eq!(offset_of!(PcmSharedControl, wake_seq), 100);
        assert_eq!(PCM_FLAG_CONFIGURING, 1);
        assert_eq!(PCM_FLAG_UNDERRUN_ACTIVE, 2);
        assert_eq!(PCM_FLAG_FATAL_ERROR, 4);
        assert_eq!(PCM_TRANSPORT_BYTES, 65_664);
    }
}

/// GLES / EGL ABI: ioctl numbers, opcode tables, and marshalled argument
/// structs for `/dev/dri/renderD128`.
///
/// These are part of the kernel↔user-space ABI: any change to the ioctl
/// numbers, the marshalled struct layouts, or surface-kind tags requires
/// bumping `ABI_VERSION` (see crate root) and updating `abi/snapshot.json`.
///
/// The kernel itself never decodes the cmdbuf opcode (`OP_*`) or sync-query
/// (`QOP_*`) tables — it forwards bytes to `HostIO::gl_submit` /
/// `HostIO::gl_query`. The opcodes are still owned by `shared::gl` because
/// they are the wire contract between Phase B's host TS bridge and Phase
/// C's user-space `libGLESv2` cmdbuf encoder; both sides mirror this
/// table. Adding new opcodes bumps `OP_VERSION`, not `ABI_VERSION`, since
/// the byte layout is unchanged from the kernel's perspective.
pub mod gl {
    /// Cmdbuf mmap length (1 MiB). Single fixed size in v1; see
    /// the design doc §3 "Cmdbuf overflow".
    pub const CMDBUF_LEN: usize = 1 << 20;

    /// Version of the GLES op-table. Bumped independently of `ABI_VERSION`
    /// when the cmdbuf opcode set changes; the libGLESv2 stub records this
    /// at compile time and the kernel refuses GLIO_INIT on mismatch.
    pub const OP_VERSION: u32 = 1;

    // --- ioctl request numbers (DRM 'D' magic, starting at 0x40) -----------

    // GLIO_INIT takes a pointer to a `u32` carrying the client's compile-time
    // `OP_VERSION`. The kernel rejects mismatches with `ENOSYS` so a process
    // built against an older op-table can't talk to a newer kernel (and vice
    // versa) without the divergence being caught at first contact rather than
    // surfacing later as a silent decode error. See A6's GLIO_INIT handler.
    pub const GLIO_INIT: u32 = 0x40;
    pub const GLIO_TERMINATE: u32 = 0x41;
    pub const GLIO_CREATE_CONTEXT: u32 = 0x42;
    pub const GLIO_DESTROY_CONTEXT: u32 = 0x43;
    pub const GLIO_CREATE_SURFACE: u32 = 0x44;
    pub const GLIO_DESTROY_SURFACE: u32 = 0x45;
    pub const GLIO_MAKE_CURRENT: u32 = 0x46;
    pub const GLIO_SUBMIT: u32 = 0x47;
    pub const GLIO_PRESENT: u32 = 0x48;
    pub const GLIO_QUERY: u32 = 0x49;

    // --- surface kind tags -------------------------------------------------

    /// `kind` value for the bound canvas surface.
    pub const WPK_SURFACE_DEFAULT: u32 = 1;
    /// `kind` value for an off-screen pbuffer surface (Phase C).
    pub const WPK_SURFACE_PBUFFER: u32 = 2;

    /// Upper bound on `GlQueryInfo.in_buf_len` / `out_buf_len`. The
    /// kernel allocates scratch buffers of these sizes before forwarding
    /// the query to the host; capping prevents a malicious wasm process
    /// from passing `0xFFFFFFFE` and OOMing the kernel worker.
    ///
    /// 64 KiB comfortably fits every realistic sync-query output: shader
    /// info logs (typically ~1 KB), program info logs, `glGetString`
    /// results, framebuffer-completeness, and `glReadPixels` of a 64×64
    /// RGBA thumbnail (16 KB). Demos that need to read back a full
    /// framebuffer should do it in tiles.
    pub const MAX_QUERY_IN_LEN: u32 = 64 * 1024;
    pub const MAX_QUERY_OUT_LEN: u32 = 64 * 1024;

    // --- cmdbuf opcodes (mirrored in host/src/webgl/ops.ts) ----------------
    //
    // Layout: TLV `{u16 op, u16 payload_len, payload[payload_len]}` little-
    // endian. Payload formats are documented inline next to the libGLESv2
    // stub call sites in glue/libglesv2_stub.c (Phase C).

    pub const OP_CLEAR: u16 = 0x0001;
    pub const OP_CLEAR_COLOR: u16 = 0x0002;
    pub const OP_VIEWPORT: u16 = 0x0003;
    pub const OP_SCISSOR: u16 = 0x0004;
    pub const OP_ENABLE: u16 = 0x0005;
    pub const OP_DISABLE: u16 = 0x0006;
    pub const OP_BLEND_FUNC: u16 = 0x0007;
    pub const OP_DEPTH_FUNC: u16 = 0x0008;
    pub const OP_CULL_FACE: u16 = 0x0009;
    pub const OP_FRONT_FACE: u16 = 0x000A;
    pub const OP_LINE_WIDTH: u16 = 0x000B;
    pub const OP_PIXEL_STOREI: u16 = 0x000C;

    pub const OP_GEN_BUFFERS: u16 = 0x0100;
    pub const OP_DELETE_BUFFERS: u16 = 0x0101;
    pub const OP_BIND_BUFFER: u16 = 0x0102;
    pub const OP_BUFFER_DATA: u16 = 0x0103;
    pub const OP_BUFFER_SUB_DATA: u16 = 0x0104;

    pub const OP_GEN_TEXTURES: u16 = 0x0200;
    pub const OP_DELETE_TEXTURES: u16 = 0x0201;
    pub const OP_BIND_TEXTURE: u16 = 0x0202;
    pub const OP_TEX_IMAGE_2D: u16 = 0x0203;
    pub const OP_TEX_SUB_IMAGE_2D: u16 = 0x0204;
    pub const OP_TEX_PARAMETERI: u16 = 0x0205;
    pub const OP_ACTIVE_TEXTURE: u16 = 0x0206;
    pub const OP_GENERATE_MIPMAP: u16 = 0x0207;

    pub const OP_CREATE_SHADER: u16 = 0x0300;
    pub const OP_SHADER_SOURCE: u16 = 0x0301;
    pub const OP_COMPILE_SHADER: u16 = 0x0302;
    pub const OP_DELETE_SHADER: u16 = 0x0303;
    pub const OP_CREATE_PROGRAM: u16 = 0x0304;
    pub const OP_ATTACH_SHADER: u16 = 0x0305;
    pub const OP_LINK_PROGRAM: u16 = 0x0306;
    pub const OP_USE_PROGRAM: u16 = 0x0307;
    pub const OP_BIND_ATTRIB_LOCATION: u16 = 0x0308;
    pub const OP_DELETE_PROGRAM: u16 = 0x0309;

    pub const OP_UNIFORM1I: u16 = 0x0400;
    pub const OP_UNIFORM1F: u16 = 0x0401;
    pub const OP_UNIFORM2F: u16 = 0x0402;
    pub const OP_UNIFORM3F: u16 = 0x0403;
    pub const OP_UNIFORM4F: u16 = 0x0404;
    pub const OP_UNIFORM_MATRIX4FV: u16 = 0x0405;
    /// `glUniform4fv(location, count, value)` — vector form. es2gears uses
    /// this for the directional light position. `OP_UNIFORM4F` (scalar) is a
    /// different signature; both are needed.
    pub const OP_UNIFORM4FV: u16 = 0x0406;

    pub const OP_ENABLE_VERTEX_ATTRIB_ARRAY: u16 = 0x0500;
    pub const OP_DISABLE_VERTEX_ATTRIB_ARRAY: u16 = 0x0501;
    pub const OP_VERTEX_ATTRIB_POINTER: u16 = 0x0502;
    pub const OP_DRAW_ARRAYS: u16 = 0x0503;
    pub const OP_DRAW_ELEMENTS: u16 = 0x0504;

    pub const OP_GEN_VERTEX_ARRAYS: u16 = 0x0600;
    pub const OP_DELETE_VERTEX_ARRAYS: u16 = 0x0601;
    pub const OP_BIND_VERTEX_ARRAY: u16 = 0x0602;

    pub const OP_GEN_FRAMEBUFFERS: u16 = 0x0700;
    pub const OP_BIND_FRAMEBUFFER: u16 = 0x0701;
    pub const OP_FRAMEBUFFER_TEXTURE_2D: u16 = 0x0702;
    pub const OP_GEN_RENDERBUFFERS: u16 = 0x0703;
    pub const OP_BIND_RENDERBUFFER: u16 = 0x0704;
    pub const OP_RENDERBUFFER_STORAGE: u16 = 0x0705;
    pub const OP_FRAMEBUFFER_RENDERBUFFER: u16 = 0x0706;

    // --- sync query op tags (used in GlQueryInfo.op) -----------------------

    pub const QOP_GET_ERROR: u32 = 0x01;
    pub const QOP_GET_STRING: u32 = 0x02;
    pub const QOP_GET_INTEGERV: u32 = 0x03;
    pub const QOP_GET_FLOATV: u32 = 0x04;
    pub const QOP_GET_UNIFORM_LOC: u32 = 0x05;
    pub const QOP_GET_ATTRIB_LOC: u32 = 0x06;
    pub const QOP_GET_SHADERIV: u32 = 0x07;
    pub const QOP_GET_SHADER_INFO_LOG: u32 = 0x08;
    pub const QOP_GET_PROGRAMIV: u32 = 0x09;
    pub const QOP_GET_PROGRAM_INFO_LOG: u32 = 0x0A;
    pub const QOP_READ_PIXELS: u32 = 0x0B;
    pub const QOP_CHECK_FB_STATUS: u32 = 0x0C;

    // --- marshalled ioctl argument structs ---------------------------------

    /// Argument to `GLIO_SUBMIT`. Total: 8 bytes.
    #[repr(C)]
    #[derive(Clone, Copy, Default)]
    pub struct GlSubmitInfo {
        /// Byte offset within the cmdbuf at which to start decoding.
        pub offset: u32,
        /// Number of bytes to decode (must end on a TLV boundary).
        pub length: u32,
    }

    /// Argument to `GLIO_CREATE_CONTEXT`. Total: 16 bytes.
    /// Mirrors a tiny subset of EGL config attrs; v1 only consults
    /// `client_version`.
    #[repr(C)]
    #[derive(Clone, Copy, Default)]
    pub struct GlContextAttrs {
        /// EGL client version (2 → GLES 2, 3 → GLES 3).
        pub client_version: u32,
        /// Reserved for `share_context`, debug bit, robustness bit, etc.
        pub reserved: [u32; 3],
    }

    /// Argument to `GLIO_CREATE_SURFACE`. Total: 32 bytes.
    #[repr(C)]
    #[derive(Clone, Copy, Default)]
    pub struct GlSurfaceAttrs {
        /// Surface kind (only `WPK_SURFACE_DEFAULT` in v1).
        pub kind: u32,
        /// Pbuffer width (default-canvas surfaces ignore this).
        pub width: u32,
        /// Pbuffer height (default-canvas surfaces ignore this).
        pub height: u32,
        /// EGL config id (opaque; v1 reports a single config "1").
        pub config_id: u32,
        /// Reserved.
        pub reserved: [u32; 4],
    }

    /// Argument to `GLIO_QUERY`. Total: 24 bytes.
    /// `in_buf_ptr` / `out_buf_ptr` are wasm-process addresses that Phase B
    /// dereferences via the host's typed-array view of process memory. v1
    /// kernel forwards `op` + a kernel-scratch buffer sized by `out_buf_len`
    /// to `HostIO::gl_query` and ignores the pointers.
    #[repr(C)]
    #[derive(Clone, Copy, Default)]
    pub struct GlQueryInfo {
        /// Sync-query op tag. The full table (QOP_*) is owned by the host
        /// bridge in Phase B; the kernel forwards this value unchanged.
        pub op: u32,
        /// Process-relative pointer to the input bytes (Phase B only).
        pub in_buf_ptr: u32,
        /// Length of input in bytes (Phase B only).
        pub in_buf_len: u32,
        /// Process-relative pointer to the output buffer (Phase B only).
        pub out_buf_ptr: u32,
        /// Capacity of the output buffer in bytes. The kernel rejects
        /// values above `MAX_QUERY_OUT_LEN` to bound the scratch
        /// allocation and otherwise forwards.
        pub out_buf_len: u32,
        /// Reserved for a future async-completion handle.
        pub reserved: u32,
    }
}

/// Linux DRM `/dev/dri/*` ABI — ioctl numbers, fourcc constants, and
/// marshalled argument structs.
///
/// Numbers are encoded with `_IOWR('d', nr, struct)` where `'d' = 0x64`.
/// Struct field offsets must match the Linux ABI byte-for-byte; bumping
/// `ABI_VERSION` is not required for *adding* new structs (additive
/// compatibility, see `docs/abi-versioning.md`), but any change to an
/// existing struct's layout requires a snapshot regen and a version bump.
pub mod dri {
    // --- ioctl numbers -----------------------------------------------------
    // Derivation: dir=11 (READ|WRITE), size=struct sizeof, magic='d', nr=…
    // Encoded: (dir << 30) | (size << 16) | (magic << 8) | nr
    // The constants below are the byte-for-byte Linux values; the tests in
    // `dri_tests` re-derive them from `_IOWR!` to catch drift.

    /// `_IOWR('d', 0x00, drm_version)` — driver name / date / desc query.
    /// `struct drm_version` is 36 bytes on wasm32 (ilp32: 3 × `int` + 3 ×
    /// `__kernel_size_t` + 3 × `char *`, all 4-byte). Ioctl number encodes
    /// 36 → `0xc0246400`.
    pub const DRM_IOCTL_VERSION: u32 = 0xc024_6400;

    /// Native wasm64 `_IOWR('d', 0x00, drm_version)`.
    ///
    /// wasm64 follows the 64-bit Linux UAPI layout: three `int` fields,
    /// four bytes of alignment, then three `(size_t, pointer)` pairs.
    pub const DRM_IOCTL_VERSION_WASM64: u32 = 0xc040_6400;

    /// `_IOWR('d', 0x0c, drm_get_cap)` — feature capability query.
    pub const DRM_IOCTL_GET_CAP: u32 = 0xc010_640c;

    /// `_IOW('d', 0x09, drm_gem_close)` — drop a GEM handle.
    pub const DRM_IOCTL_GEM_CLOSE: u32 = 0x4008_6409;

    /// `_IOWR('d', 0x2d, drm_prime_handle)` — export bo as prime fd.
    pub const DRM_IOCTL_PRIME_HANDLE_TO_FD: u32 = 0xc00c_642d;

    /// `_IOWR('d', 0x2e, drm_prime_handle)` — import prime fd as bo handle.
    pub const DRM_IOCTL_PRIME_FD_TO_HANDLE: u32 = 0xc00c_642e;

    /// `_IOWR('d', 0xb2, drm_mode_create_dumb)` — allocate dumb buffer.
    pub const DRM_IOCTL_MODE_CREATE_DUMB: u32 = 0xc020_64b2;

    /// `_IOWR('d', 0xb3, drm_mode_map_dumb)` — fetch dumb-buffer mmap offset.
    pub const DRM_IOCTL_MODE_MAP_DUMB: u32 = 0xc010_64b3;

    /// `_IOWR('d', 0xb4, drm_mode_destroy_dumb)` — drop dumb buffer.
    pub const DRM_IOCTL_MODE_DESTROY_DUMB: u32 = 0xc004_64b4;

    // --- DRM_GET_CAP keys (clients call to probe features) ----------------

    pub const DRM_CAP_DUMB_BUFFER: u64 = 0x1;
    pub const DRM_CAP_PRIME: u64 = 0x5;
    pub const DRM_PRIME_CAP_IMPORT: u64 = 0x1;
    pub const DRM_PRIME_CAP_EXPORT: u64 = 0x2;

    // --- DRM fourcc pixel formats ----------------------------------------
    // Little-endian fourcc codes from `include/uapi/drm/drm_fourcc.h`.

    /// `fourcc('A','R','2','4')` — 8-8-8-8 alpha + RGB.
    pub const DRM_FORMAT_ARGB8888: u32 = 0x34325241;
    /// `fourcc('X','R','2','4')` — 8-8-8-8 padding + RGB.
    pub const DRM_FORMAT_XRGB8888: u32 = 0x34325258;
    /// `fourcc('R','G','1','6')` — 5-6-5 RGB.
    pub const DRM_FORMAT_RGB565: u32 = 0x36314752;

    // --- marshalled structs ------------------------------------------------

    /// Linux `struct drm_mode_create_dumb` (32 bytes, identical layout on
    /// wasm32 and x86_64 — fixed-width fields only).
    #[repr(C)]
    #[derive(Clone, Copy, Default)]
    pub struct WpkDrmModeCreateDumb {
        pub height: u32, // 0   in
        pub width: u32,  // 4   in
        pub bpp: u32,    // 8   in    bits-per-pixel (32 for ARGB8888)
        pub flags: u32,  // 12  in    must be 0
        pub handle: u32, // 16  out   process-local bo handle
        pub pitch: u32,  // 20  out   stride in bytes
        pub size: u64,   // 24  out   total bytes (pitch * height)
                         // total: 32
    }

    /// Linux `struct drm_mode_map_dumb` (16 bytes).
    #[repr(C)]
    #[derive(Clone, Copy, Default)]
    pub struct WpkDrmModeMapDumb {
        pub handle: u32, // 0   in
        pub pad: u32,    // 4   reserved
        pub offset: u64, // 8   out   pass to mmap() as the file offset
                         // total: 16
    }

    /// Linux `struct drm_mode_destroy_dumb` (4 bytes).
    #[repr(C)]
    #[derive(Clone, Copy, Default)]
    pub struct WpkDrmModeDestroyDumb {
        pub handle: u32, // 0
                         // total: 4
    }

    /// Linux `struct drm_gem_close` (8 bytes).
    #[repr(C)]
    #[derive(Clone, Copy, Default)]
    pub struct WpkDrmGemClose {
        pub handle: u32, // 0
        pub pad: u32,    // 4
                         // total: 8
    }

    /// Linux `struct drm_prime_handle` (12 bytes). Reused both for
    /// HANDLE_TO_FD (handle → fd, flags=O_CLOEXEC|O_RDWR-ish) and
    /// FD_TO_HANDLE (fd → handle).
    #[repr(C)]
    #[derive(Clone, Copy, Default)]
    pub struct WpkDrmPrimeHandle {
        pub handle: u32, // 0   in/out
        pub flags: u32,  // 4   in    O_CLOEXEC/O_RDWR; we accept any, store none
        pub fd: i32,     // 8   in/out   signed (-1 on error sentinel; -EBADF tests)
                         // total: 12
    }

    /// Linux `struct drm_get_cap` (16 bytes).
    #[repr(C)]
    #[derive(Clone, Copy, Default)]
    pub struct WpkDrmGetCap {
        pub capability: u64, // 0  in   DRM_CAP_* constant
        pub value: u64,      // 8  out
                             // total: 16
    }

    /// Linux `struct drm_version` — used by `DRM_IOCTL_VERSION`. 36 bytes on
    /// wasm32 (ilp32: 3 × `int` + 3 × `__kernel_size_t` + 3 × `char *`, all
    /// 4-byte). Field order matches `include/uapi/drm/drm.h` — interleaved
    /// `(len, ptr)` triples (not "lens first, then ptrs"). The kernel reads
    /// `*_len` (caller-allocated capacity), writes strings via the three
    /// pointers, and updates `*_len` to bytes actually written. v1 writes
    /// zero-length strings (see Task A5); the field shape is fixed for the
    /// future string-write path.
    #[repr(C)]
    #[derive(Clone, Copy, Default)]
    pub struct WpkDrmVersion {
        pub version_major: i32,      // 0
        pub version_minor: i32,      // 4
        pub version_patchlevel: i32, // 8
        pub name_len: u32,           // 12   in/out
        pub name_ptr: u32,           // 16   wasm32 user pointer
        pub date_len: u32,           // 20   in/out
        pub date_ptr: u32,           // 24   wasm32 user pointer
        pub desc_len: u32,           // 28   in/out
        pub desc_ptr: u32,           // 32   wasm32 user pointer
                                     // total: 36
    }

    // --- WPK extensions ('d' magic, nrs 0xE0+ — unused by Linux 6.x) ----

    /// `_IOWR('d', 0xE0, WpkDrmGpuBoCreate)` — allocate a GPU-tier bo.
    /// `MODE_CREATE_DUMB` covers CPU-shared bos (LINEAR, mmap'able). This
    /// ioctl covers the GPU tier: the bo's backing is a host `WebGLTexture`,
    /// not a SAB; the bo is unmappable on the CPU side and is intended for
    /// sampling / rendering via the multiplexer.
    pub const DRM_IOCTL_WPK_CREATE_GPU_BO: u32 = 0xc010_64e0;

    /// `_IOWR('d', 0xE1, WpkDrmBindForeignTexture)` — bind a foreign bo as
    /// a `WebGLTexture` in the caller's GL context. The caller must already
    /// hold a local bo handle (via PRIME_FD_TO_HANDLE), and the bo must be
    /// GPU-tier. Used by the compositor to sample client bos and by
    /// `gbm_bo_import` callers that want texture-side access.
    pub const DRM_IOCTL_WPK_BIND_FOREIGN_TEXTURE: u32 = 0xc010_64e1;

    /// GPU-bo allocator argument. 16 bytes on wasm32 (4 × u32). `format` and
    /// `usage` are passed through to libgbm's `gbm_bo_create(format, usage)`
    /// from the user side.
    ///
    /// The kernel writes back over the same buffer on return; layout:
    ///
    ///   0..4   width    (echoed back, unchanged)
    ///   4..8   height   (echoed back, unchanged)
    ///   8..12  handle   (out — process-local; was `format` on the way in)
    ///   12..16 stride   (out — bytes; was `usage` on the way in)
    ///
    /// The 16-byte size is preserved (ioctl encoding stays 0xc010_64e0).
    #[repr(C)]
    #[derive(Clone, Copy, Default)]
    pub struct WpkDrmGpuBoCreate {
        pub width: u32,  // 0   in
        pub height: u32, // 4   in
        pub format: u32, // 8   in    DRM_FORMAT_* (ARGB8888 etc.)
        pub usage: u32,  // 12  in    GBM_BO_USE_* bitmask
                         // total: 16
    }

    /// `BIND_FOREIGN_TEXTURE` argument. 16 bytes on wasm32 (4 × u32). After
    /// the call, the caller's GL context has a `WebGLTexture` accessible by
    /// `gl_texture_id` until the bo's refcount drops to zero — the bo is
    /// the canonical owner; bo destruction (last `GEM_CLOSE` / OFD
    /// final-close) deletes the underlying `WebGLTexture` and invalidates
    /// every binding to it. There is no separate `UNBIND_FOREIGN_TEXTURE`
    /// ioctl: bind lifetime is tied to the bo lifetime, scoped by the bo
    /// refcount.
    #[repr(C)]
    #[derive(Clone, Copy, Default)]
    pub struct WpkDrmBindForeignTexture {
        pub bo_handle: u32, // 0   in    caller's local GEM handle
        pub gl_target: u32, // 4   in    GL_TEXTURE_2D etc.
        pub ctx_id: u32,    // 8   in    caller's GL ctx_id
        pub gl_texture_id: u32, // 12  out   the WebGLTexture id assigned
                            //          (also writable as a sampler binding)
    }

    // --- KMS ioctls ('d' magic, Linux UAPI) -------------------------------

    /// `_IO('d', 0x1e)` — request DRM_MASTER.
    pub const DRM_IOCTL_SET_MASTER: u32 = 0x0000_641e;

    /// `_IO('d', 0x1f)` — release DRM_MASTER.
    pub const DRM_IOCTL_DROP_MASTER: u32 = 0x0000_641f;

    /// `_IOWR('d', 0x3a, drm_wait_vblank)` — block until next vblank.
    pub const DRM_IOCTL_WAIT_VBLANK: u32 = 0xc010_643a;

    /// `_IOWR('d', 0xa0, drm_mode_card_res)` — crtc/connector/encoder counts.
    pub const DRM_IOCTL_MODE_GETRESOURCES: u32 = 0xc040_64a0;

    /// `_IOWR('d', 0xa1, drm_mode_crtc)`.
    pub const DRM_IOCTL_MODE_GETCRTC: u32 = 0xc068_64a1;

    /// `_IOWR('d', 0xa2, drm_mode_crtc)`.
    pub const DRM_IOCTL_MODE_SETCRTC: u32 = 0xc068_64a2;

    /// `_IOWR('d', 0xa6, drm_mode_get_encoder)`.
    pub const DRM_IOCTL_MODE_GETENCODER: u32 = 0xc014_64a6;

    /// `_IOWR('d', 0xa7, drm_mode_get_connector)`.
    pub const DRM_IOCTL_MODE_GETCONNECTOR: u32 = 0xc050_64a7;

    /// `_IOWR('d', 0xaf, u32)` — drop fb id.
    pub const DRM_IOCTL_MODE_RMFB: u32 = 0xc004_64af;

    /// `_IOWR('d', 0xb0, drm_mode_crtc_page_flip)` — queue page-flip.
    pub const DRM_IOCTL_MODE_PAGE_FLIP: u32 = 0xc018_64b0;

    /// `_IOWR('d', 0xb8, drm_mode_fb_cmd2)`.
    pub const DRM_IOCTL_MODE_ADDFB2: u32 = 0xc068_64b8;

    // --- KMS enums --------------------------------------------------------

    pub const DRM_MODE_CONNECTOR_VIRTUAL: u32 = 15;
    pub const DRM_MODE_CONNECTED: u32 = 1;
    pub const DRM_MODE_SUBPIXEL_UNKNOWN: u32 = 1;
    pub const DRM_EVENT_VBLANK: u32 = 1;
    pub const DRM_EVENT_FLIP_COMPLETE: u32 = 2;

    // --- KMS marshalled structs -------------------------------------------

    /// `struct drm_mode_card_res`. 64 bytes. The four `*_ptr` fields are
    /// `__u64` upstream for x86_32/x86_64 portability; on wasm32 the user
    /// pointer occupies the low 32 bits, high 32 bits are zero.
    #[repr(C)]
    #[derive(Clone, Copy, Default)]
    pub struct WpkDrmModeCardRes {
        pub fb_id_ptr: u64,        // 0   in
        pub crtc_id_ptr: u64,      // 8   in
        pub connector_id_ptr: u64, // 16  in
        pub encoder_id_ptr: u64,   // 24  in
        pub count_fbs: u32,        // 32  in/out
        pub count_crtcs: u32,      // 36  in/out
        pub count_connectors: u32, // 40  in/out
        pub count_encoders: u32,   // 44  in/out
        pub min_width: u32,        // 48  out
        pub max_width: u32,        // 52  out
        pub min_height: u32,       // 56  out
        pub max_height: u32,       // 60  out
                                   // total: 64
    }

    /// `struct drm_mode_modeinfo`. 68 bytes.
    #[repr(C)]
    #[derive(Clone, Copy, Default)]
    pub struct WpkDrmModeModeinfo {
        pub clock: u32,       // 0
        pub hdisplay: u16,    // 4
        pub hsync_start: u16, // 6
        pub hsync_end: u16,   // 8
        pub htotal: u16,      // 10
        pub hskew: u16,       // 12
        pub vdisplay: u16,    // 14
        pub vsync_start: u16, // 16
        pub vsync_end: u16,   // 18
        pub vtotal: u16,      // 20
        pub vscan: u16,       // 22
        pub vrefresh: u32,    // 24
        pub flags: u32,       // 28
        pub mode_type: u32,   // 32
        pub name: [u8; 32],   // 36..68
                              // total: 68
    }

    /// `struct drm_mode_crtc`. 104 bytes (embedded modeinfo at offset 36).
    #[repr(C)]
    #[derive(Clone, Copy, Default)]
    pub struct WpkDrmModeGetCrtc {
        pub set_connectors_ptr: u64, // 0    in   (SETCRTC only)
        pub count_connectors: u32,   // 8    in   (SETCRTC only)
        pub crtc_id: u32,            // 12   in/out
        pub fb_id: u32,              // 16   in/out
        pub x: u32,                  // 20   in/out
        pub y: u32,                  // 24   in/out
        pub gamma_size: u32,         // 28   out
        pub mode_valid: u32,         // 32   in/out
        pub mode: WpkDrmModeModeinfo, // 36..104
                                     // total: 104
    }

    /// `struct drm_mode_get_connector`. 80 bytes.
    #[repr(C)]
    #[derive(Clone, Copy, Default)]
    pub struct WpkDrmModeGetConnector {
        pub encoders_ptr: u64,      // 0    in
        pub modes_ptr: u64,         // 8    in
        pub props_ptr: u64,         // 16   in
        pub prop_values_ptr: u64,   // 24   in
        pub count_modes: u32,       // 32   in/out
        pub count_props: u32,       // 36   in/out
        pub count_encoders: u32,    // 40   in/out
        pub encoder_id: u32,        // 44   out
        pub connector_id: u32,      // 48   in/out
        pub connector_type: u32,    // 52   out
        pub connector_type_id: u32, // 56   out
        pub connection: u32,        // 60   out
        pub mm_width: u32,          // 64   out
        pub mm_height: u32,         // 68   out
        pub subpixel: u32,          // 72   out
        pub pad: u32,               // 76
                                    // total: 80
    }

    /// `struct drm_mode_get_encoder`. 20 bytes.
    #[repr(C)]
    #[derive(Clone, Copy, Default)]
    pub struct WpkDrmModeGetEncoder {
        pub encoder_id: u32,     // 0    in/out
        pub encoder_type: u32,   // 4    out
        pub crtc_id: u32,        // 8    out
        pub possible_crtcs: u32, // 12   out
        pub possible_clones: u32, // 16   out
                                 // total: 20
    }

    /// `struct drm_mode_fb_cmd2`. 104 bytes — `[u64; 4] modifier` aligns
    /// to offset 72, leaving 4 bytes of pad after `offsets`.
    #[repr(C)]
    #[derive(Clone, Copy, Default)]
    pub struct WpkDrmModeFbCmd2 {
        pub fb_id: u32,        // 0    out
        pub width: u32,        // 4    in
        pub height: u32,       // 8    in
        pub pixel_format: u32, // 12   in
        pub flags: u32,        // 16   in
        pub handles: [u32; 4], // 20   in
        pub pitches: [u32; 4], // 36   in
        pub offsets: [u32; 4], // 52   in
        pub modifier: [u64; 4], // 72..104   in
                               // total: 104
    }

    /// `struct drm_mode_crtc_page_flip`. 24 bytes.
    #[repr(C)]
    #[derive(Clone, Copy, Default)]
    pub struct WpkDrmModeCrtcPageFlip {
        pub crtc_id: u32,  // 0    in
        pub fb_id: u32,    // 4    in
        pub flags: u32,    // 8    in
        pub reserved: u32, // 12
        pub user_data: u64, // 16   in
                           // total: 24
    }

    /// `struct drm_event_vblank`. 32 bytes — `drm_event` header (8) +
    /// body (24). Carries `sequence` + `crtc_id` at the tail so libdrm v3's
    /// `page_flip_handler2(fd, sequence, tv_sec, tv_usec, crtc_id,
    /// user_data)` reads correct bytes.
    #[repr(C)]
    #[derive(Clone, Copy, Default)]
    pub struct WpkDrmEventVblank {
        pub ev_type: u32,   // 0
        pub length: u32,    // 4
        pub user_data: u64, // 8
        pub tv_sec: u32,    // 16
        pub tv_usec: u32,   // 20
        pub sequence: u32,  // 24
        pub crtc_id: u32,   // 28
                            // total: 32
    }

    /// `struct drm_wait_vblank_request`. Union member (input). 16 bytes.
    #[repr(C)]
    #[derive(Clone, Copy, Default)]
    pub struct WpkDrmWaitVblankRequest {
        pub req_type: u32, // 0
        pub sequence: u32, // 4
        pub signal: u64,   // 8
                           // total: 16
    }

    /// `struct drm_wait_vblank_reply`. Union member (output). 16 bytes.
    #[repr(C)]
    #[derive(Clone, Copy, Default)]
    pub struct WpkDrmWaitVblankReply {
        pub rep_type: u32, // 0
        pub sequence: u32, // 4
        pub tv_sec: u32,   // 8
        pub tv_usec: u32,  // 12
                           // total: 16
    }
}

#[cfg(test)]
mod dri_tests {
    use super::dri::*;
    use core::mem::size_of;

    /// `_IOWR(magic, nr, type)` packs (dir, size, magic, nr) into a u32.
    /// Mirrors include/uapi/asm-generic/ioctl.h.
    const fn ioc(dir: u32, magic: u32, nr: u32, size: u32) -> u32 {
        (dir << 30) | (size << 16) | (magic << 8) | nr
    }
    const IOC_READ: u32 = 2;
    const IOC_WRITE: u32 = 1;

    #[test]
    fn struct_sizes_match_linux_abi() {
        assert_eq!(size_of::<WpkDrmModeCreateDumb>(), 32);
        assert_eq!(size_of::<WpkDrmModeMapDumb>(), 16);
        assert_eq!(size_of::<WpkDrmModeDestroyDumb>(), 4);
        assert_eq!(size_of::<WpkDrmGemClose>(), 8);
        assert_eq!(size_of::<WpkDrmPrimeHandle>(), 12);
        assert_eq!(size_of::<WpkDrmGetCap>(), 16);
        assert_eq!(size_of::<WpkDrmVersion>(), 36);
    }

    #[test]
    fn ioctl_numbers_match_linux_uapi() {
        let iowr = IOC_READ | IOC_WRITE;
        assert_eq!(
            DRM_IOCTL_VERSION,
            ioc(iowr, 'd' as u32, 0x00, size_of::<WpkDrmVersion>() as u32)
        );
        assert_eq!(DRM_IOCTL_VERSION_WASM64, ioc(iowr, 'd' as u32, 0x00, 64));
        assert_eq!(
            DRM_IOCTL_GET_CAP,
            ioc(iowr, 'd' as u32, 0x0c, size_of::<WpkDrmGetCap>() as u32)
        );
        assert_eq!(
            DRM_IOCTL_GEM_CLOSE,
            ioc(
                IOC_WRITE,
                'd' as u32,
                0x09,
                size_of::<WpkDrmGemClose>() as u32
            )
        );
        assert_eq!(
            DRM_IOCTL_PRIME_HANDLE_TO_FD,
            ioc(
                iowr,
                'd' as u32,
                0x2d,
                size_of::<WpkDrmPrimeHandle>() as u32
            )
        );
        assert_eq!(
            DRM_IOCTL_PRIME_FD_TO_HANDLE,
            ioc(
                iowr,
                'd' as u32,
                0x2e,
                size_of::<WpkDrmPrimeHandle>() as u32
            )
        );
        assert_eq!(
            DRM_IOCTL_MODE_CREATE_DUMB,
            ioc(
                iowr,
                'd' as u32,
                0xb2,
                size_of::<WpkDrmModeCreateDumb>() as u32
            )
        );
        assert_eq!(
            DRM_IOCTL_MODE_MAP_DUMB,
            ioc(
                iowr,
                'd' as u32,
                0xb3,
                size_of::<WpkDrmModeMapDumb>() as u32
            )
        );
        assert_eq!(
            DRM_IOCTL_MODE_DESTROY_DUMB,
            ioc(
                iowr,
                'd' as u32,
                0xb4,
                size_of::<WpkDrmModeDestroyDumb>() as u32
            )
        );
    }

    #[test]
    fn wpk_extension_sizes_match_wasm32() {
        assert_eq!(size_of::<WpkDrmGpuBoCreate>(), 16);
        assert_eq!(size_of::<WpkDrmBindForeignTexture>(), 16);
    }

    #[test]
    fn wpk_extension_ioctl_numbers() {
        let iowr = IOC_READ | IOC_WRITE;
        assert_eq!(
            DRM_IOCTL_WPK_CREATE_GPU_BO,
            ioc(
                iowr,
                'd' as u32,
                0xE0,
                size_of::<WpkDrmGpuBoCreate>() as u32
            )
        );
        assert_eq!(
            DRM_IOCTL_WPK_BIND_FOREIGN_TEXTURE,
            ioc(
                iowr,
                'd' as u32,
                0xE1,
                size_of::<WpkDrmBindForeignTexture>() as u32
            )
        );
    }

    #[test]
    fn drm_fourcc_constants_match_uapi() {
        const fn fourcc(a: u8, b: u8, c: u8, d: u8) -> u32 {
            (a as u32) | ((b as u32) << 8) | ((c as u32) << 16) | ((d as u32) << 24)
        }
        assert_eq!(DRM_FORMAT_ARGB8888, fourcc(b'A', b'R', b'2', b'4'));
        assert_eq!(DRM_FORMAT_XRGB8888, fourcc(b'X', b'R', b'2', b'4'));
        assert_eq!(DRM_FORMAT_RGB565, fourcc(b'R', b'G', b'1', b'6'));
    }

    #[test]
    fn kms_struct_sizes_match_linux_abi() {
        assert_eq!(size_of::<WpkDrmModeCardRes>(), 64);
        assert_eq!(size_of::<WpkDrmModeModeinfo>(), 68);
        assert_eq!(size_of::<WpkDrmModeGetCrtc>(), 104);
        assert_eq!(size_of::<WpkDrmModeGetConnector>(), 80);
        assert_eq!(size_of::<WpkDrmModeGetEncoder>(), 20);
        assert_eq!(size_of::<WpkDrmModeFbCmd2>(), 104);
        assert_eq!(size_of::<WpkDrmModeCrtcPageFlip>(), 24);
        assert_eq!(size_of::<WpkDrmEventVblank>(), 32);
        assert_eq!(size_of::<WpkDrmWaitVblankRequest>(), 16);
        assert_eq!(size_of::<WpkDrmWaitVblankReply>(), 16);
    }

    #[test]
    fn kms_ioctl_numbers_match_linux_uapi() {
        let iowr = IOC_READ | IOC_WRITE;
        assert_eq!(DRM_IOCTL_SET_MASTER, ioc(0, 'd' as u32, 0x1e, 0));
        assert_eq!(DRM_IOCTL_DROP_MASTER, ioc(0, 'd' as u32, 0x1f, 0));
        assert_eq!(
            DRM_IOCTL_WAIT_VBLANK,
            ioc(
                iowr,
                'd' as u32,
                0x3a,
                size_of::<WpkDrmWaitVblankRequest>() as u32
            )
        );
        assert_eq!(
            DRM_IOCTL_MODE_GETRESOURCES,
            ioc(
                iowr,
                'd' as u32,
                0xa0,
                size_of::<WpkDrmModeCardRes>() as u32
            )
        );
        assert_eq!(
            DRM_IOCTL_MODE_GETCRTC,
            ioc(
                iowr,
                'd' as u32,
                0xa1,
                size_of::<WpkDrmModeGetCrtc>() as u32
            )
        );
        assert_eq!(
            DRM_IOCTL_MODE_SETCRTC,
            ioc(
                iowr,
                'd' as u32,
                0xa2,
                size_of::<WpkDrmModeGetCrtc>() as u32
            )
        );
        assert_eq!(
            DRM_IOCTL_MODE_GETENCODER,
            ioc(
                iowr,
                'd' as u32,
                0xa6,
                size_of::<WpkDrmModeGetEncoder>() as u32
            )
        );
        assert_eq!(
            DRM_IOCTL_MODE_GETCONNECTOR,
            ioc(
                iowr,
                'd' as u32,
                0xa7,
                size_of::<WpkDrmModeGetConnector>() as u32
            )
        );
        assert_eq!(DRM_IOCTL_MODE_RMFB, ioc(iowr, 'd' as u32, 0xaf, 4));
        assert_eq!(
            DRM_IOCTL_MODE_PAGE_FLIP,
            ioc(
                iowr,
                'd' as u32,
                0xb0,
                size_of::<WpkDrmModeCrtcPageFlip>() as u32
            )
        );
        assert_eq!(
            DRM_IOCTL_MODE_ADDFB2,
            ioc(iowr, 'd' as u32, 0xb8, size_of::<WpkDrmModeFbCmd2>() as u32)
        );
    }

    #[test]
    fn kms_enum_constants_match_uapi() {
        assert_eq!(DRM_MODE_CONNECTOR_VIRTUAL, 15);
        assert_eq!(DRM_MODE_CONNECTED, 1);
        assert_eq!(DRM_EVENT_VBLANK, 1);
        assert_eq!(DRM_EVENT_FLIP_COMPLETE, 2);
    }
}

#[cfg(test)]
mod gl_tests {
    use super::gl::*;
    use core::mem::size_of;

    #[test]
    fn struct_sizes_match_abi() {
        assert_eq!(size_of::<GlSubmitInfo>(), 8);
        assert_eq!(size_of::<GlContextAttrs>(), 16);
        assert_eq!(size_of::<GlSurfaceAttrs>(), 32);
        assert_eq!(size_of::<GlQueryInfo>(), 24);
    }

    #[test]
    fn cmdbuf_len_is_one_mib() {
        assert_eq!(CMDBUF_LEN, 1024 * 1024);
    }

    #[test]
    fn opcodes_are_unique() {
        let ops: &[u16] = &[
            OP_CLEAR,
            OP_CLEAR_COLOR,
            OP_VIEWPORT,
            OP_SCISSOR,
            OP_ENABLE,
            OP_DISABLE,
            OP_BLEND_FUNC,
            OP_DEPTH_FUNC,
            OP_CULL_FACE,
            OP_FRONT_FACE,
            OP_LINE_WIDTH,
            OP_PIXEL_STOREI,
            OP_GEN_BUFFERS,
            OP_DELETE_BUFFERS,
            OP_BIND_BUFFER,
            OP_BUFFER_DATA,
            OP_BUFFER_SUB_DATA,
            OP_GEN_TEXTURES,
            OP_DELETE_TEXTURES,
            OP_BIND_TEXTURE,
            OP_TEX_IMAGE_2D,
            OP_TEX_SUB_IMAGE_2D,
            OP_TEX_PARAMETERI,
            OP_ACTIVE_TEXTURE,
            OP_GENERATE_MIPMAP,
            OP_CREATE_SHADER,
            OP_SHADER_SOURCE,
            OP_COMPILE_SHADER,
            OP_DELETE_SHADER,
            OP_CREATE_PROGRAM,
            OP_ATTACH_SHADER,
            OP_LINK_PROGRAM,
            OP_USE_PROGRAM,
            OP_BIND_ATTRIB_LOCATION,
            OP_DELETE_PROGRAM,
            OP_UNIFORM1I,
            OP_UNIFORM1F,
            OP_UNIFORM2F,
            OP_UNIFORM3F,
            OP_UNIFORM4F,
            OP_UNIFORM_MATRIX4FV,
            OP_UNIFORM4FV,
            OP_ENABLE_VERTEX_ATTRIB_ARRAY,
            OP_DISABLE_VERTEX_ATTRIB_ARRAY,
            OP_VERTEX_ATTRIB_POINTER,
            OP_DRAW_ARRAYS,
            OP_DRAW_ELEMENTS,
            OP_GEN_VERTEX_ARRAYS,
            OP_DELETE_VERTEX_ARRAYS,
            OP_BIND_VERTEX_ARRAY,
            OP_GEN_FRAMEBUFFERS,
            OP_BIND_FRAMEBUFFER,
            OP_FRAMEBUFFER_TEXTURE_2D,
            OP_GEN_RENDERBUFFERS,
            OP_BIND_RENDERBUFFER,
            OP_RENDERBUFFER_STORAGE,
            OP_FRAMEBUFFER_RENDERBUFFER,
        ];
        for (i, &a) in ops.iter().enumerate() {
            for &b in &ops[i + 1..] {
                assert_ne!(a, b, "duplicate opcode 0x{a:04x}");
            }
        }
    }

    #[test]
    fn query_opcodes_are_unique() {
        let qops: &[u32] = &[
            QOP_GET_ERROR,
            QOP_GET_STRING,
            QOP_GET_INTEGERV,
            QOP_GET_FLOATV,
            QOP_GET_UNIFORM_LOC,
            QOP_GET_ATTRIB_LOC,
            QOP_GET_SHADERIV,
            QOP_GET_SHADER_INFO_LOG,
            QOP_GET_PROGRAMIV,
            QOP_GET_PROGRAM_INFO_LOG,
            QOP_READ_PIXELS,
            QOP_CHECK_FB_STATUS,
        ];
        for (i, &a) in qops.iter().enumerate() {
            for &b in &qops[i + 1..] {
                assert_ne!(a, b, "duplicate query opcode 0x{a:02x}");
            }
        }
    }
}
