# POSIX API Compliance Status

**Vision:** A POSIX-compliant kernel for WebAssembly that runs and coordinates multiple Wasm-based processes. The goal is to take existing systems software and run it on this kernel with minimal changes — ideally none. Full POSIX compliance is the default; developers can optionally trade compliance for simplicity or performance.

This document tracks the implementation status of POSIX APIs in Kandelo. It is organized by subsystem and updated as features are implemented.

**Legend:**
- **Full** — Fully implemented per POSIX spec
- **Partial** — Implemented with documented limitations
- **Stub** — Returns ENOSYS or placeholder
- **Planned** — Not yet started, on roadmap
- **N/A** — Not applicable to Wasm environment

---

## Architecture: Shared Kernel Model

Kandelo uses a single kernel Wasm instance that holds a `ProcessTable` and serves all process workers via channel IPC (`Atomics.waitAsync`).

**Key properties:**
- **Single kernel instance** with a `ProcessTable` mapping PIDs to `Process` structs
- **One kernel-owned task-ID sequence** in that Rust `ProcessTable` allocates all
  top-level, fork, spawn, and clone PIDs/TIDs monotonically from 100. Callers do
  not choose IDs, and PID 1 is a kernel-created synthetic init reservation.
- **Process workers** communicate with the kernel via channel IPC — each process/thread has a channel region in shared memory, and the kernel services syscalls one at a time from the JS event loop
- **Cross-process shared state** uses kernel-global or host-coordinated
  backings where implemented. Pipes, locks, IPC objects, sockets, and selected
  stateful descriptors retain one backing across fork. Inherited and
  transferred open file descriptions retain one exactly owned mutable state
  object for offsets, status flags, and async ownership. Directory descriptors
  keep process-local host iterators but rebuild them whenever a peer advances
  the shared guest-visible cookie.
- **Serialized syscall execution** — the kernel handles one syscall at a time, which provides natural atomicity for kernel-owned operations such as memfd `O_APPEND` and `PIPE_BUF`-sized pipe writes; host-backed append additionally requires an exact backend outcome
- **Signal delivery** across processes is direct — the kernel can write to any process's pending signal mask

**Key kernel-side APIs:**
- `kernel_create_process()` — allocate and register a new process, returning its PID
- `kernel_create_process_with_stdio(stdin_kind, stdout_kind, stderr_kind)` — same allocation with explicit stdio semantics
- `kernel_fork_process(parent, caller_tid, mode)` — validate the calling task
  and ABI-owned ordinary/vfork mode, allocate a child PID, and copy inherited
  state including that task's signal mask
- `kernel_spawn_process(parent, caller_tid, blob_ptr, blob_len)` — validate the calling task, allocate the child PID, and apply spawn attributes and file actions
- `kernel_remove_process(pid)` — clean up on exit
- `kernel_handle_channel(offset, capacity, pid, retry_token)` — dispatch a
  syscall from a process's capacity-bounded channel allocation; token zero is
  an initial attempt
- `kernel_blocking_retry_token(pid, tid, syscall_nr)` — obtain the opaque
  stable-target token created by the first `EAGAIN`
- `kernel_blocking_retry_release(pid, tid, token)` — consume one exact retry
  binding and its kernel-owned references

---

## File Descriptors & I/O

| Function | Status | Notes |
|----------|--------|-------|
| `open()` | Partial | Host-delegated for ordinary files. O_CREAT, O_EXCL, O_TRUNC, O_APPEND, O_NONBLOCK, O_CLOEXEC, O_DIRECTORY, O_NOFOLLOW flags handled. umask applied to mode on O_CREAT. Size-changing O_TRUNC clears S_ISUID and S_ISGID on a metadata-backed regular file; creating a file or truncating an already-empty file preserves the requested/current mode. Named FIFOs use kernel-owned rendezvous state: blocking read/write-only opens reserve an fd and wait for a peer, nonblocking write-only open returns ENXIO without a reader, and O_RDWR opens both ends without waiting. O_PATH/O_SEARCH opens retain a FIFO for metadata and `*at()` use without creating an I/O endpoint. Signals, thread cancellation, exec, and process exit release incomplete-open reservations; a cancellation request remains pending while cancellation is disabled and the FIFO open continues blocking until a peer arrives or a signal interrupts it. Virtual device interception (`/dev/null`, `/dev/zero`, `/dev/urandom`, `/dev/full`, `/dev/fd/N`, `/dev/stdin`, `/dev/stdout`, `/dev/stderr`). |
| `openat()` | Full | AT_FDCWD delegates to open(). Absolute paths handled. Real dirfd supported via stored OFD paths. |
| `close()` | Partial | Ref-counted OFD cleanup. Host handle closed when last ref dropped. Closing any descriptor for a file releases every process lock held by that PID on the file; OFD locks survive duplicated/inherited references and disappear only with the final machine-wide OFD reference. EINTR not yet handled. |
| `read()` | Partial | Host-delegated for files. Pipe/socket reads from kernel ring buffer with blocking when empty (EINTR on signal). Short reads permitted. O_NONBLOCK returns EAGAIN. |
| `pread()` | Partial | Host-backed files use one positioned backend read without changing the OFD cursor; in-kernel files retain their native positioned path. Rejects pipes/sockets with ESPIPE. Signed-i64 offsets stay exact through the host contract; number-only backends return EOVERFLOW rather than rounding an unrepresentable offset. |
| `write()` | Partial | Host-delegated for files. A successful non-empty metadata-backed regular-file write or append clears S_ISUID and S_ISGID; a zero-byte or failed operation leaves mode unchanged. Kandelo deliberately applies this to non-executable S_ISGID too: POSIX permits clearing both bits after write or ftruncate, and Kandelo does not implement the System V mandatory-locking interpretation of that bit. Pipe writes to kernel ring buffer with blocking when full (EINTR on signal). EPIPE + SIGPIPE on closed read end (POSIX-compliant). `O_APPEND` is one EOF/limit/write transaction that returns the exact written prefix and ending offset: memfds and shared-memory files serialize under their backing lock, OPFS serializes in its channel handler, and lifecycle-owned Node scratch mounts use a verified native append route. Node session seeds are copied to new private inodes before readiness and therefore retain that lifecycle-owned route; no mutation is written back to the source tree. Externally mutable `HostFileSystem` mounts and the legacy raw Node adapter cannot prove the exact ending offset and return `EOPNOTSUPP` before mutation. For regular files and memfds, `RLIMIT_FSIZE` applies once per logical operation: a crossing operation returns the prefix that fits without a signal; a later non-empty operation with no room fails with `EFBIG` and generates thread-directed `SIGXFSZ`. |
| `pwrite()` | Partial | Host-backed files use one positioned backend write without changing the OFD cursor; in-kernel files retain their native positioned path. Successful non-empty regular-file writes use the same set-ID invalidation rule as `write()`. Rejects pipes/sockets with ESPIPE. Uses the same operation-wide RLIMIT_FSIZE rule as write. Number-only backends, including Node's synchronous positioned-write API above JavaScript's safe-integer range, return EOVERFLOW rather than rounding. |
| `lseek()` | Partial | Regular files support SEEK_SET, SEEK_CUR, and SEEK_END; SEEK_END delegates to the host for size calculation. Directories accept a nonnegative next-record cookie with SEEK_SET and expose the current cookie through SEEK_CUR with offset zero; other directory seeks fail with EINVAL without changing the cursor. A regular-file seek whose result would be negative likewise fails with EINVAL, and arithmetic or host-number overflow fails with EOVERFLOW. Inherited and transferred descriptors share the same OFD position. |
| `dup()` | Full | Lowest available fd. FD_CLOEXEC cleared. Shares OFD with original. |
| `dup2()` | Full | Atomic close-and-dup. Same-fd no-op. FD_CLOEXEC cleared. |
| `dup3()` | Full | Like dup2 but returns EINVAL if oldfd==newfd. Supports O_CLOEXEC flag. |
| `pipe()` | Partial | Kernel-space ring buffer (64KB). PIPE_BUF=4096 atomicity is guaranteed by serialized kernel syscalls. O_NONBLOCK returns EAGAIN. Forked descriptors retain the same global pipe backing and shared OFD status. |
| `pipe2()` | Full | Like pipe with O_NONBLOCK and O_CLOEXEC flag support. |
| `readv()` | Full | Validates the complete caller-native iovec table and `IOV_MAX`, performs one contiguous scalar read, then scatters only the returned prefix. This preserves datagram/record boundaries and stops naturally on a short read or EOF even when the vector exceeds ordinary channel scratch. |
| `writev()` | Full | Validates and gathers the complete vector, then performs one scalar write. Pipe/datagram operation boundaries and operation-wide `RLIMIT_FSIZE` are preserved even when the vector exceeds ordinary channel scratch. |
| `fstat()` | Partial | Host-delegated for regular files. Anonymous pipes report S_IFIFO with synthetic metadata; named FIFOs preserve their VFS permissions, ownership, timestamps, and authoritative link count across rename and unlink while an fd remains open. Removing the final name sets the cached inode link count to zero and advances ctime. ABI 39 does not report `st_rdev`, `st_blksize`, or `st_blocks`; libc initializes those fields to zero instead of exposing uninitialized memory. Truthful backend metadata is tracked in [issue #928](https://github.com/Automattic/kandelo/issues/928). |
| `ftruncate()` | Partial | Host-delegated for regular files, with in-kernel memfd support. A size change clears S_ISUID and S_ISGID on metadata-backed regular files; a same-size or failed operation leaves mode unchanged. Requires write access, validates length >= 0, rejects non-regular fds, and enforces RLIMIT_FSIZE before changing either backing. |
| `fsync()` | Partial | Host-delegated for regular files and directories. Node-backed directories use the native durability barrier; memory-backed filesystems have no queued writes. Browser OPFS flushes regular-file access handles, but its API exposes no separate directory durability barrier. Rejects pipes and sockets. |
| `fdatasync()` | Partial | Alias for fsync(). No metadata distinction in Wasm environment. |
| `truncate()` | Partial | Path-based. Named FIFOs fail with EINVAL without entering their open rendezvous; ordinary paths open O_WRONLY, call ftruncate, and close. |
| `fchmod()` | Partial | Regular files, directories, named FIFOs, and devpts slave descriptors update authoritative metadata; an unlinked but open named FIFO retains the updated cached inode metadata, and a devpts slave retains its mode for the PTY pair lifetime. O_PATH/O_SEARCH descriptors return EBADF. Other kernel-owned pipes/sockets accept the call as a no-op. Node host-backed files never receive native mode changes after creation. |
| `fchown()` | Partial | Regular files, directories, named FIFOs, and devpts slave descriptors update authoritative metadata. `(uid_t)-1` and `(gid_t)-1` preserve the corresponding current ID without bypassing descriptor, authorization, or backend-error checks. Root may select arbitrary IDs; an unprivileged owner must preserve its user ID and may select its effective GID or any authoritative supplementary group. On metadata-backed SharedFS and Node regular files, every successful ownership call clears S_ISUID and S_ISGID, regardless of execute bits. Directories, symlinks, and character-device PTY slaves retain their modes. O_PATH/O_SEARCH descriptors return EBADF. Unlinked open named FIFOs retain updated cached ownership; other kernel-owned non-file descriptors still accept the call as a metadata-less no-op, and Node host-backed ownership changes stay virtual. |
| `preadv()` | Full | Validates the complete vector and performs one exact-offset scalar read, then scatters only the returned prefix without changing the OFD cursor. |
| `pwritev()` | Full | Validates and gathers the complete vector, then performs one exact-offset scalar write without changing the OFD cursor. The aggregate `RLIMIT_FSIZE` decision applies once to that operation. |
| `preadv2()` / `pwritev2()` | Partial | Delegates to preadv/pwritev. Extra flags parameter ignored. |
| `sendfile()` | Full | Emulated with read+write loop (no zero-copy in Wasm). Supports an optional positioned input offset. The output `RLIMIT_FSIZE` budget is fixed before input is consumed. When source and destination can alias, each chunk stages the input before mutating the output and advances the input only by the prefix the output reports. |
| `fallocate()` | Partial | Mode 0 extends through ftruncate when needed, including RLIMIT_FSIZE enforcement; allocation guarantees and nonzero modes are not implemented. |
| `copy_file_range()` | Full | Emulated with pread+pwrite loop. Supports optional offsets for both input and output fds. The output `RLIMIT_FSIZE` budget is fixed before input is consumed; staged input is committed only through the written prefix. |
| `splice()` | Full | Emulated through the same staged copy loop with optional offsets. The output `RLIMIT_FSIZE` budget is fixed before input is consumed, and source position advances only through the written prefix. |
| `tee()` / `vmsplice()` | Stub | Returns ENOSYS. |
| `readahead()` | Stub | Returns 0 (no-op advisory). |
| `fstatat()` | Partial | AT_FDCWD delegates to stat/lstat. AT_SYMLINK_NOFOLLOW and Linux AT_EMPTY_PATH are supported; an empty path targets either the supplied fd or the current working directory for AT_FDCWD. Real dirfds are supported through stored OFD paths. Cwd- and dirfd-relative lookup inherit the pathname-backed directory-identity limitation documented below. ABI 39 omits `st_rdev`, `st_blksize`, and `st_blocks`; libc reports zero for those fields pending [issue #928](https://github.com/Automattic/kandelo/issues/928). |
| `statx()` | Partial | Delegates to fstatat, accepts the statx synchronization flags, and fills the 256-byte statx structure from WasmStat using the STATX_BASIC_STATS mask. Basic identity, mode, ownership, size, and timestamp fields are reported, but block and device metadata are incomplete pending [issue #928](https://github.com/Automattic/kandelo/issues/928). It inherits fstatat's pathname-backed directory-identity limitation. |
| `unlinkat()` | Full | AT_FDCWD delegates to unlink/rmdir. AT_REMOVEDIR flag supported. Real dirfd supported. |
| `mkdirat()` | Full | AT_FDCWD delegates to mkdir. umask applied. Real dirfd supported. |
| `renameat()` | Full | Both dirfds supported (AT_FDCWD, absolute, or real dirfd). |
| `faccessat()` | Full | AT_FDCWD delegates to access(). Absolute paths and real dirfd supported. |
| `fchmodat()` | Full | AT_FDCWD delegates to chmod(). AT_SYMLINK_NOFOLLOW accepted. Real dirfd supported. |
| `fchownat()` | Partial | AT_FDCWD and real dirfds are supported, including unchanged-ID sentinels and the same root/owner/group authorization as `chown()`. The final symlink is followed by default and changed directly with `AT_SYMLINK_NOFOLLOW`. Unsupported flags, including `AT_EMPTY_PATH`, return EINVAL. |
| `linkat()` | Full | Both dirfds supported (AT_FDCWD, absolute, or real dirfd). |
| `symlinkat()` | Full | Target stored as-is. Linkpath resolved via dirfd. Real dirfd supported. |
| `readlinkat()` | Full | AT_FDCWD delegates to readlink(). Real dirfd supported. |

## fcntl()

| Command | Status | Notes |
|---------|--------|-------|
| `F_DUPFD` | Full | Lowest fd >= arg. FD_CLOEXEC cleared. |
| `F_DUPFD_CLOEXEC` | Full | Atomic dup + set FD_CLOEXEC. |
| `F_GETFD` | Full | Returns FD_CLOEXEC flag. |
| `F_SETFD` | Full | Sets FD_CLOEXEC flag. Per-fd, not per-OFD. |
| `F_GETFL` | Full | Returns status flags + access mode. Use O_ACCMODE mask. |
| `F_SETFL` | Full | Only O_APPEND, O_NONBLOCK modifiable. Access mode bits preserved. |
| `F_GETLK` | Full | Rust-owned advisory record lookup. Requests normalize positive, zero-to-EOF, and negative lengths into half-open ranges. The lowest-range conflicting record is returned deterministically; `l_pid` is the blocking process PID or `-1` for an OFD owner. |
| `F_SETLK` | Full | Non-blocking lock acquisition with read/read compatibility, same-owner replacement, split/coalesce, upgrade/downgrade, and partial unlock. Returns EAGAIN for a conflicting owner and ENOLCK if the atomic result would exceed the 4096 normalized-record limit or cannot be reserved. Read/write access mode is validated. |
| `F_SETLKW` | Partial | Blocking acquisition uses the same Rust semantics as F_SETLK. Only conflicts enter the host channel's retry state; Rust advisory-lock wake events reschedule parked requests after a potentially unblocking change, with a short timer as a safety net. ENOLCK completes immediately. No deadlock detection. |
| `F_OFD_GETLK` / `F_OFD_SETLK` / `F_OFD_SETLKW` | Full / Full / Partial | Use a kernel-global OFD identity, not a process-local table index. Independent opens have different owners; dup, fork, and exec retain one owner, and locks are released only after the last machine-wide OFD reference closes. Blocking OFD acquisition has the same no-deadlock-detection limitation as F_SETLKW. |
| `F_GETOWN` | Full | Returns async I/O owner PID from OFD. Default 0. |
| `F_SETOWN` | Full | Sets async I/O owner PID on OFD. SIGIO delivery deferred to signal delivery phase. |

All advisory records are owned by one Rust manager in the machine-wide
`ProcessTable`; the host has no parallel lock table. Host regular-file identity
comes from exact `st_dev`/`st_ino` values returned by `fstat` on the live open
handle, so hard links, rename, and unlink-while-open preserve identity while an
unlink/recreate does not. VFS device identity is qualified by backend object,
and OPFS uses session-scoped inode tokens unified with `isSameEntry()`. A
backend that cannot prove an exact stable identity returns `ENOLCK` for locking
instead of using a pathname hash. Memfd, procfs regular objects, and read-only
synthetic regular files use tagged in-kernel identities and participate in the
same final-OFD lifetime rules.

## Process Management

| Function | Status | Notes |
|----------|--------|-------|
| `fork()` | Partial | The kernel validates the calling task, allocates the child PID, and copies process state; the host starts a child Worker with copied Memory. The child inherits the calling task's blocked signal mask, and libc refreshes a copied pthread TID from the kernel before returning from `fork()`. Host-owned continuation and fork channel requests leave caught signals kernel-pending; after the import returns, libc performs an ordinary syscall checkpoint so the guest signal trampoline owns handler invocation and mask restoration without host-to-Wasm reentrancy. Initial launch mirrors the environment into kernel-owned process state; fork copies that metadata while instrumented rewind preserves the live libc `environ` in copied Memory, and `execve()` replaces both from its supplied `envp`. `wasm-fork-instrument` resumes the child at the call site with scalar locals in linked frames and versioned reconstruction recipes for references, exceptions, globals, tables, and dynamic-link activations. Root or later continuation-allocation failure and a negative `SYS_FORK` result unwind transactionally, create no child, and return the failure to the still-running parent. Main-thread and pthread fork are supported, including nested main/side-module stacks and process-owned dynamic-link/table replay. Pipes, sockets, PTYs, eventfd/timerfd/signalfd, memfd, procfs snapshots, and shared mappings retain their existing backings; signal and wait lifecycle state is copied/coordinated by the kernel. Inherited OFDs share offset, status flags, and async owner through exact kernel ownership. Directory host iterators remain process-local and reopen at the one shared next-record cookie. See [fork-instrumentation.md](fork-instrumentation.md). |
| `exec()` | Partial | Kernel-initiated via SYS_EXECVE (syscall 211). The host preflights the module, ABI, replacement memory, caller, generated 4,096/4,096 argv/environment count caps, deferred file actions, and a 4 MiB combined argv/environment representation (strings, terminators, and pointer entries) before replacing the image in place. Independently, each string is limited to the current 64 KiB process-metadata transfer; this is an implementation transport ceiling, not part of aggregate `ARG_MAX`, and oversize returns `E2BIG` without truncation. At `_start`, immutable entry reads are zero-capacity queried and then copied complete-or-`ERANGE` into one exact-lifetime guest `mmap`; allocation failure or changed length traps before libc publishes a partial vector. Preserves PID, non-CLOEXEC fds and their exact kernel-backed object state, new argv/envp (including an explicitly empty environment), CWD, the calling pthread's signal mask and directed queue, terminal queues, and `alarm()`/`ITIMER_REAL`; closes directory streams, deletes `timer_create()` timers, publishes and detaches old mappings, terminates sibling threads, and resets the program break before installing the new `__heap_base`. File mappings retain a stable writeback handle even after their original fd closes. For an executable on a mount without `nosuid`, retained root ownership plus `S_ISUID`/`S_ISGID` metadata drives the atomic effective-credential transition; explicit `nosuid` suppresses it. The retained handle, bytes, metadata, mount flags, and inode identity are revalidated before commit. Remaining gaps: POSIX message-queue descriptors are not process-owned and therefore cannot yet be closed on exec; epoll registrations track numeric fds rather than OFD identity, so close/dup and same-number replacement cases are incomplete; and main-thread-directed signals share the process-pending queue and therefore cannot be distinguished from process-directed signals when a worker pthread execs. |
| `wait()` / `waitpid()` / `wait4()` / `waitid()` | Partial | Rust-owned child status covers stop, continue, normal exit, and signal death. New status replaces older unconsumed status; `waitid(WNOWAIT)` preserves the current record. `WNOHANG`, `WUNTRACED`/`WSTOPPED`, `WEXITED`, and `WCONTINUED` are supported, as are specific-PID, any-child, same-process-group, and specific-process-group selection. Stop/continue reports do not reap; consuming exit status does. A top-level host launch has `ppid=0`; its status is consumed by the host API, and the host asks Rust to reap it only after its Workers can issue no more syscalls. `wait4()` returns the zero-filled resource-usage wire record described under `getrusage()`. Remaining gap: a blocked `pid == 0` / `P_PGID,id == 0` wait currently re-evaluates the caller's process group on each host retry instead of freezing it at call entry. |
| `exit()` / `_exit()` | Partial | Closes all fds and dir streams, releases locks and mapping/backing ownership, and retains the low eight status bits. Normal codes 128–255 remain distinct from signal termination, which is stored separately. SIGCHLD is delivered to a guest parent and guest-child zombie state remains until `waitpid()` reaps it. The host separately reaps only exited direct children of `ppid=0` after Worker teardown. Orphan adoption is not yet implemented when a guest parent exits. |
| `getpid()` | Full | Returns pid from Process struct. |
| `getppid()` | Partial | Returns the stored ppid (0 for virtual init and a top-level process launched directly by the host). An orphaned guest child is not yet reparented to virtual init. |
| `getuid()` / `geteuid()` | Full | Simulated; defaults to uid=0 (root). Configurable via setuid/seteuid. |
| `getgid()` / `getegid()` | Full | Simulated; defaults to gid=0 (root). Configurable via setgid/setegid. |
| `setuid()` / `seteuid()` | Full | The process retains real, effective, and saved IDs. Privileged `setuid()` updates all three; an unprivileged process may select its real or saved ID as effective. Transitions are atomic and return `EPERM` without mutation when disallowed. |
| `setgid()` / `setegid()` | Full | Mirrors the complete real/effective/saved UID model and uses effective UID 0 for privileged changes. Disallowed transitions return `EPERM` without mutation. |
| `getgroups()` / `setgroups()` | Full | Stores an ordered supplementary-group list of zero through `NGROUPS_MAX` (32) entries. A zero-size `getgroups()` query returns the count without a destination; short capacity returns `EINVAL`, and successful copyout touches only the returned entries. `setgroups()` is root-only and atomically replaces the complete list. Fork, vfork, and exec-state transport preserve the list independently. |
| `getpriority()` / `setpriority()` | Partial | Stores a per-process nice value; WebAssembly has no host CPU scheduler to apply it to. Linux-compatible `/proc/<pid>/stat` exposes scheduler priority in field 18 and nice in field 19. Procfs metadata operations reject missing or reaped PID scopes. |
| `getpgrp()` | Full | Returns process group ID (simulated, defaults to pid). |
| `setpgid()` | Partial | Sets process group ID. pid=0 means self. pgid=0 means use target pid. Only supports setting own pgid; other processes return ESRCH. |
| `getsid()` | Full | Returns session ID (simulated, defaults to pid). pid=0 means self. |
| `setsid()` | Full | Creates new session. Sets sid=pid, pgid=pid. Returns new session ID. Returns EPERM if already session leader (POSIX-compliant). |
| `prctl()` | Partial | `PR_SET_NAME` and `PR_GET_NAME` store/retrieve one required, exact 16-byte thread-name buffer; null fails with `EFAULT` on wasm32 and wasm64. Other operations preserve argument 1 as a low-32-bit scalar, stage no scratch pointer, and currently return success as a no-op. Syscall number fixed to 223 (Batch 3). |
| `gettid()` | Partial | Returns pid for the main thread and the host-bound worker TID for pthread workers. Remaining limitation: this is Linux-compatible rather than POSIX-standard, and not all signal/thread APIs consume TID-specific state yet. |
| `set_tid_address()` | Partial | Returns the calling TID and stores the clear-TID pointer for thread exit notification. Host thread cleanup writes 0 and futex-wakes the address for normal pthread exit and forced cleanup paths. Robust-list handling remains deferred. |
| `set_robust_list()` | Stub | No-op. Robust futex list tracking deferred until threading is fully tested. |
| `futex()` | Partial | FUTEX_WAIT, FUTEX_WAKE, FUTEX_REQUEUE, FUTEX_CMP_REQUEUE, and FUTEX_WAKE_OP operate on one process's shared memory. Main-process WAIT uses host `Atomics.waitAsync`; pthread workers use direct `Atomics.wait`. Separate processes have separate `SharedArrayBuffer` objects, so these operations do not wake or synchronize a peer PID even when the futex word lies in a host-coordinated MAP_SHARED mapping. |
| `execve()` | Partial | Delegates to the in-place `exec()` path and has the same remaining descriptor/signal/mapping limitations described above. |
| `execveat()` | Partial | SYS_EXECVEAT (386). Host-derived paths, including strings from `kernel_get_fd_path` or `kernel_get_dirfd_path`, are diagnostic-only and may be used as a lazy VFS materialization hint; they never authorize execution. The centralized kernel entry passes the original fd/path/flags to `kernel_exec_target_prepare`, then uses the owner-bound token with `kernel_exec_target_size` and bounded `kernel_exec_target_read`. The host validates and compiles the exact bytes under the current ABI/artifact policy and completes replacement-memory preflight. Precommit failure uses exactly one `kernel_exec_target_cancel`; success calls `kernel_exec_commit`, which revalidates the retained exact handle, bytes, metadata, and capability before its atomic in-place commit. `AT_EMPTY_PATH`, relative-dirfd, and absolute-path semantics are therefore resolved from authoritative process/VFS state rather than path getters or program maps. It otherwise has the same remaining `exec()` limitations. |
| `fork()` (syscall) | Partial | Glue traps through channel IPC; the kernel copies process state, the host starts a child Worker, and `wasm-fork-instrument` replays the call stack so parent/child receive the POSIX return values. ABI 43 requires the activation-state-safe artifact capability before launch and validates the linked-frame, reference/exception recipe, mutable module-state, table-journal, and activation-catalog contracts. Unsafe ABI 42, malformed, or mixed-version artifacts fail before execution. Negative results replay to the caller without terminating the parent, including continuation-allocation failure before or during unwind. |
| `vfork()` | Partial | ABI 43 gives vfork a distinct libc and host transaction mode, maps it to `SYS_VFORK`, and does not run `pthread_atfork` handlers. A separate child Worker aliases the parent's existing `Shared WebAssembly.Memory`; the launch constructs no child process Memory and copies no address-space bytes. The child has private syscall-channel, replay-prefix, reference-codec, loader, and continuation-control state plus an independent kernel Process record. Only the calling parent thread remains parked until successful exec commit or exact `_exit()`/signal/trap teardown; sibling pthreads remain runnable. Failed exec returns to the child and keeps the lifetime active. Nested fork/vfork, spawn, and pthread creation fail with `EAGAIN`. Inherited descriptor tables, cwd, credentials, and process groups remain independent, while each inherited OFD shares its mutable offset, status flags, and async owner. Node, Chromium, Firefox, and WebKit production paths cover these lifecycles. A fatal signal delivered while the child has no pending syscall cannot obtain an exact browser Worker-quiescence fence; Kandelo truthfully contains the complete shared address space instead of resuming the parent. This row remains Partial pending broad conformance, pristine upstream CRuby selection, and full RSS validation. |
| `posix_spawn()` | Partial | **Non-forking implementation** (this kernel's invention; no Linux equivalent). Glue issues `SYS_SPAWN` (500) with a marshalled blob (argv + envp + file actions + spawn attrs). Generated platform limits supply the advertised 4 MiB combined argv/environment `ARG_MAX`, 4,096-byte `PATH_MAX` including NUL, and defensive 4,096-entry caps for each process-startup vector; the separate generated wire contract aliases those counts and defines a 40-byte header, 28-byte action records, 1,024 actions, and an 8,417,320-byte complete transport ceiling. These representation caps are not additional POSIX limits. Independently, each argv/environment string must fit the current 64 KiB process-metadata transfer. That host implementation ceiling is separate from aggregate `ARG_MAX`. Child startup uses the same immutable query/exact-copy guest-mapping contract as `exec()`, so it cannot silently clamp counts or keep only 64/128 KiB prefixes. The host proves caller ranges, parsed limits, the selected kernel-owned allocation capacity, and the current kernel-memory range independently; fitting inside total kernel Wasm memory is not proof that the destination allocation owns those bytes. Ordinary blobs reuse channel scratch. Each larger blob begins a fresh exclusive reservation on a Rust-owned reusable high-water buffer, reads its pointer and capacity, copies under one synchronous lease, and commits with the matching opaque token. Begin and pointer/capacity queries are nonblocking; commit and cancellation wait on a no-host-import critical section. After every successful begin, the host cancels in a `finally` block, including setup and copy failures, so it returns with either a released unconsumed token or a definitive already-consumed/stale result. Overlapping or reentrant large-spawn attempts cannot replace live bytes. Shared trusted code snapshots candidate bytes immediately, compiles only that isolated snapshot, and ignores a separately supplied module; candidate lookup remains side-effect-free and cannot become launch authority. The Rust `ProcessTable` validates the calling TID, reserves the child PID, inherits the complete credential record, applies `POSIX_SPAWN_RESETIDS` before remaining attributes, and drains file actions once. In the resulting child CWD/fd/credential state, Rust retains an exact executable target; byte divergence from the isolated candidate snapshot triggers recompilation, and `kernel_spawn_exec_commit` evaluates set-ID/nosuid state and closes `FD_CLOEXEC` before `onSpawn` launches either host's Worker. Until successful launch publishes the PID, authoritative kernel state hides the pending child from `waitpid()` selection/reaping while retaining signal-exit status. The parent-bound publication operation makes a child killed during async target work visible as a real waitable zombie only after `posix_spawn()` returns success; ordinary failure removes the hidden child once and wakes parked waiters. Failure cancels the exact target and removes host mirrors without action replay or parent mutation. The child inherits the calling task's signal mask unless `POSIX_SPAWN_SETSIGMASK` replaces it. No fork, no `wpk_fork_*` rewind, no exec replay. Supports POSIX_SPAWN_RESETIDS / SETSID / SETPGROUP / SETSIGMASK / SETSIGDEF and FDOP_OPEN / CLOSE / DUP2 / CHDIR / FCHDIR. SIG_IGN dispositions persist across the implicit exec; custom handlers reset to SIG_DFL (POSIX exec semantics). An inherited directory never aliases the parent's live host iterator: spawn preserves one shared next-record cookie and lazily reopens a child-owned iterator there. Inherited OFD offset, status, and owner state remain shared. Regression-guarded: `kernel_get_fork_count` exposes a per-process counter the test suite asserts is unchanged across SYS_SPAWN. See `docs/plans/2026-05-04-non-forking-posix-spawn-design.md`. |
| `posix_spawnp()` | Partial | PATH search lives in libc (`libc/musl-overlay/src/process/wasm32posix/posix_spawnp.c`); resolves the absolute path then delegates to `posix_spawn()`. Empty PATH entries are treated as `.` and EACCES is deferred per `__execvpe` policy. It otherwise inherits `posix_spawn()`'s status. |
| `clone()` | Partial | Thread-style clone (CLONE_VM\|CLONE_THREAD) supported. The Rust `ProcessTable` allocates the TID from the same global task-ID sequence as every PID, and the host spawns a thread Worker sharing the parent's Memory. Normal pthread return, pthread_exit, and cancellation cleanup remain per-thread and wake join/clear-TID waiters; uncaught fatal Wasm traps in a pthread worker terminate the whole process with signal-style wait status. |
| `personality()` | Stub | Returns 0 (PER_LINUX). |
| `unshare()` / `setns()` | Stub | Returns EPERM. No namespace support. |
| `ptrace()` | Stub | Returns ENOSYS. |
| `process_vm_readv()` / `process_vm_writev()` | Stub | Returns ENOSYS. |
| `membarrier()` | Stub | Returns 0 (no-op, single-threaded). |
| `getcpu()` | Stub | Writes cpu=0, node=0. Single-CPU Wasm. |
| `get_robust_list()` | Stub | Returns ENOSYS. |
| `set_thread_area()` | Stub | Returns ENOSYS. |
| `setfsuid()` / `setfsgid()` | Stub | Returns 0 (no-op). |
| `acct()` | Stub | Returns ENOSYS. |
| `reboot()` | Stub | Returns EPERM. |
| `swapon()` / `swapoff()` | Stub | Returns EPERM. |
| `syslog()` | Partial | `SYS_SYSLOG` (kernel-log control) returns 0. Kandelo does not currently provide a `/dev/log` datagram receiver; AF_UNIX datagram connect therefore exposes the missing endpoint instead of silently discarding messages. |
| `capget()` / `capset()` | Stub | Returns EPERM. No capabilities model. |
| `vhangup()` | Stub | Returns EPERM. |
| `sethostname()` / `setdomainname()` | Stub | Returns EPERM. |
| `init_module()` / `delete_module()` | Stub | Returns EPERM. No kernel module support. |
| `ioperm()` / `iopl()` | Stub | Returns EPERM. No I/O port access. |
| `remap_file_pages()` | Stub | Returns ENOSYS. |
| `getcontext()` / `setcontext()` / `makecontext()` / `swapcontext()` | Unsupported | Userspace stack-switching primitives, deprecated in POSIX.1-2008, not planned. See the "ucontext API unsupported" row under [Wasm-Inherent gaps](#wasm-inherent--gaps-that-cannot-be-fully-resolved-in-wasm) for rationale. |
| `fork()` called from an exception catch handler | Partial | ABI 43 supports mixed `Catch`, `CatchRef`, `CatchAll`, and `CatchAllRef` arms, including scalar, vector, reference, JSTag, and modern C++ cleanup payloads. Scalar tagged arms serialize one exact activation selector and maximum live operand tuple; complete exceptions use the process reference graph and are thrown inside the fresh Wasm instance so reference clauses receive child-local exnrefs. Multiple arms/targets, recursion, loop re-entry, nested catches, later merged-flow forks, reference locals/carryovers, mutable reference globals, and mutated tables use the same versioned ownership machinery without module-static stashes. Dash and the configured shell/rootfs closure rebuild through this path. This row inherits the broader incomplete `fork()` status; catch/reference replay itself is not intentionally excluded. See [fork-instrumentation.md](fork-instrumentation.md). |

## Signals

| Function | Status | Notes |
|----------|--------|-------|
| `kill()` | Partial | The centralized Rust process table validates the caller, resolves process and process-group targets, and owns pending signal state; the host only wakes exact channels selected from kernel-owned tasks. `sig=0` performs existence and permission checks without queuing. Pending signals are delivered at syscall boundaries. POSIX `EPERM` is enforced when an unprivileged caller's real/effective uid does not match the target. The immutable synthetic init reservation (PID 1, uid 0, no user worker) resolves existence checks without becoming a mutable delivery target; target 4 in compromising-xfails.md. |
| `tkill()` / `tgkill()` | Partial | Linux-compatible exact-thread delivery within the calling process uses kernel-owned task records and the target thread's directed pending queue. TID 0 and unknown or exited targets return `ESRCH`; an exact-thread request never falls back to process-wide delivery. Signal 0 performs the same target validation without queuing a signal. Cross-process per-thread delivery is not yet supported and returns `ESRCH`. |
| `signal()` | Full | Legacy API. Returns previous handler. Wraps sigaction() semantics. SIGKILL/SIGSTOP immutable. |
| `sigaction()` | Partial | Sets handler disposition (SIG_DFL, SIG_IGN, or function pointer) plus sa_flags and sa_mask. SIGKILL/SIGSTOP immutable. In the default SA_NODEFER-clear/SA_RESETHAND-clear case, the catcher runs with the current mask union sa_mask and the delivered signal. A ppoll/pselect replacement mask stays current through handler return and any ppoll restart dispatch; per-TID LIFO wait contexts preserve nested mask-swapping waits and restore each pre-wait mask once. `longjmp` and `siglongjmp` retire every abandoned handler/wait context; `siglongjmp` then applies the jump buffer's saved mask when requested. SA_RESTART is honored by the existing blocking read/write/recv/poll/ppoll paths and by host-deferred waits; pselect deliberately returns EINTR because POSIX permits that implementation-defined SA_RESTART outcome. SA_SIGINFO calls `handler(signum, siginfo_ptr, ucontext_ptr)` with pointer-width-correct layout, but host-generated SIGCHLD currently lacks the exact child pid/CLD code/status metadata. SA_NOCLDWAIT auto-reaps children and suppresses SIGCHLD. SA_NOCLDSTOP suppresses stop/continue SIGCHLD notification without discarding waitable status. SIG_IGN discards pending signals; SIG_DFL discards pending signals for signals whose default action is "ignore" (e.g., SIGCHLD). **Note:** Programs must be linked with `--table-base=3 --export-table` so the host can dispatch handlers from the user program's function table (indices 0/1 reserved for SIG_DFL/SIG_IGN, index 2 reserved for `__main_void`). |
| `sigprocmask()` | Full | Per-TID block/unblock/setmask and query operations on a 64-bit signal mask. SIGKILL and SIGSTOP cannot be blocked per POSIX. |
| `sigsuspend()` | Full | Atomically replaces the signal mask and blocks until a deliverable signal arrives. The catcher observes the replacement mask; exact post-handler cancellation restores the pre-wait mask once before returning EINTR. Uses SharedArrayBuffer + Atomics.wait/notify for cross-thread wake. |
| `pause()` | Full | Suspends until a signal is delivered. Delegates to sigsuspend with the current mask, then uses the same exact post-handler cleanup before returning EINTR. |
| `raise()` | Full | Equivalent to kill(getpid(), sig). |
| `alarm()` | Full | Sets SIGALRM timer via host setTimeout. Returns previous remaining seconds. alarm(0) cancels. Not inherited by fork; preserved across exec. |
| `setitimer()` | Full | ITIMER_REAL: sets alarm deadline + interval via host_set_alarm. ITIMER_VIRTUAL/ITIMER_PROF: no-op (no CPU time tracking). Fixes musl's alarm() which internally calls setitimer. |
| `getitimer()` | Full | ITIMER_REAL: returns stored interval + remaining time from deadline. ITIMER_VIRTUAL/ITIMER_PROF: returns zero. |
| `sigtimedwait()` | Partial | Checks the calling thread's directed and process-shared pending signals, dequeues the lowest match, and returns signal-specific `siginfo_t` metadata, including timer ID and overrun for `SI_TIMER`. Host-originated signals wake matching blocked thread channels immediately; finite retries preserve the original deadline and timeout expiry returns EAGAIN. Remaining gap: a caught signal outside the waited set does not yet interrupt the wait with `EINTR`. |
| `sigqueue()` / `rt_sigqueueinfo()` | Full | Sends signal with si_value. RT signals (32-63) are queued with FIFO ordering; standard signals (1-31) coalesced. si_code set to SI_QUEUE (-1). |
| `rt_sigreturn()` | Stub | Returns 0. Signal trampoline handled by host. |
| `signalfd()` / `signalfd4()` | Full | Creates a descriptor whose mask is held in a refcounted kernel-global backing, shared across inherited descriptors and retained by non-CLOEXEC exec. Reads return 128-byte `signalfd_siginfo` records for matching pending signals; poll readiness is supported. |

## Memory Management

| Function | Status | Notes |
|----------|--------|-------|
| `mmap()` | Partial | Anonymous, regular-file `MAP_PRIVATE`, and regular-file `MAP_SHARED` mappings use 64 KiB Wasm pages. `MAP_FIXED` replaces the complete rounded page range; a usable non-fixed hint is rounded down and preferred without replacing occupied mappings. Anonymous and regular-file shared mappings inherited by fork converge at syscall boundaries through a host-owned backing, not immediately on direct loads/stores. Regular-file sharing requires stable backend device/inode identity and retains the original open host handle, so mapping remains valid after the guest fd closes or its pathname is unlinked or renamed. Node/VFS and OPFS regular files provide backend-qualified identity; in-kernel memfd and any backend unable to prove stable identity return `ENOTSUP` for `MAP_SHARED`. `MAP_PRIVATE` still works. Bytes beyond EOF are zero-filled/dropped instead of delivering Linux `SIGBUS`, and external host writers are not detected. |
| `msync()` | Partial | Publishes the calling process's changed bytes and writes dirty regular-file pages through the stable mapping handle; `MAP_PRIVATE` remains private. Writeback is clipped to the current file size and reports `EIO` on a coherence/writeback failure. `MS_SYNC` versus `MS_ASYNC` scheduling is not distinguished, and visibility between processes is not immediate between syscalls. |
| `shm_open()` / `shm_unlink()` | Partial | musl maps names to `/dev/shm/` files (with the Node/macOS host rewrite). The resulting regular-file `MAP_SHARED` mappings work across fork and independent fds at syscall boundaries, subject to the file-mapping, futex, and EOF limitations in this section. |
| `munmap()` | Full | Removes tracked regions. The address must be 64KB-page-aligned; the length is rounded up to the next Wasm page. Partial munmap supports front trim, back trim, and middle split, including matching host-side MAP_SHARED tracking. |
| `mremap()` | Partial | Supports page-rounded shrink, in-place growth, and `MREMAP_MAYMOVE`; other flags are rejected. The host moves/resizes matching anonymous and file-shared tracking and preloads a file expansion before the destructive kernel step. Wasm cannot revoke the old bytes after a move, just as `munmap()` cannot make later direct access fault. |
| `brk()` / `sbrk()` | Partial | Kernel-managed program break. Initial break installed by host from the program's `__heap_base` export via `kernel_set_brk_base` (16MB hardcoded fallback for binaries without `__heap_base`). Growing and shrinking supported. Inherited on `fork`; **reset** on `exec` and re-installed from the new program's `__heap_base` (POSIX-correct). |
| `mprotect()` | Partial | Wasm cannot enforce page protection on direct memory access. A successful write upgrade validates that an overlapping file-shared mapping has a lifetime-stable writable handle and marks the whole tracked interval writeback-eligible; that eligibility remains monotonic after a later downgrade. Other protection effects are not enforced. |
| `memfd_create()` | Full | In-kernel anonymous file backed by a refcounted global object whose contents and cursor survive fork/spawn and non-CLOEXEC exec. MFD_CLOEXEC and MFD_ALLOW_SEALING flags are supported. `MAP_PRIVATE` population works; `MAP_SHARED` deliberately returns `ENOTSUP` until memfd has a coherent mapping bridge. |

## Directory Operations

Pathname syscalls walk components in the kernel's global namespace before
dispatching the resolved path to rootfs, a host-backed mount, procfs, devfs, or
an AF_UNIX pathname. This preserves `.` and `..` until the preceding component
has been checked, follows relative and absolute symlinks across mount
boundaries, enforces the 40-link limit, and gives a trailing slash its required
directory semantics. Cwd and directory OFDs still retain canonical pathnames
rather than stable directory identities: rename/unlink followed by recreation
can therefore make `getcwd()`, `fchdir()`, or a dirfd-relative operation refer
to a different directory than the original OFD.

| Function | Status | Notes |
|----------|--------|-------|
| `opendir()` | Partial | Host-delegated via DirStream table. Entry-at-a-time iteration. Stores resolved path for rewinddir. |
| `readdir()` | Full | Returns WasmDirent (d_ino, d_type, d_namlen) + name buffer. Synthesizes "." and ".." entries before host entries. Tracks position for telldir/seekdir. |
| `closedir()` | Full | Frees DirStream slot, delegates to host. |
| `rewinddir()` | Full | Reopens the directory via its stored path and resets the position to zero. The replacement is opened before the live iterator is retired, so a failed reopen leaves the previous stream and position intact. |
| `telldir()` | Full | Returns current position counter from DirStream. |
| `seekdir()` | Full | Rewinds and skips entries to reach target position. |
| `mkdir()` | Partial | Host-delegated. Relative paths resolved via kernel cwd. umask applied to mode. |
| `rmdir()` | Partial | Host-delegated. Relative paths resolved via kernel cwd. |
| `chdir()` / `getcwd()` | Partial | `chdir()` resolves components and symlinks across mounts, verifies search permissions and a directory target, and stores the canonical physical pathname. Initial process cwd uses the same validation after child credentials are installed. `getcwd()` validates that spelling and returns ERANGE if the buffer is too small, but cwd remains pathname-backed rather than a stable directory identity after rename/unlink. |
| `link()` / `unlink()` | Partial | Host-delegated. Relative paths resolved via kernel cwd. Named-FIFO hard links share one pipe identity and update its authoritative link count; the backing survives the last unlink while an open description remains, with link count zero and ctime updated to the unlink time. |
| `rename()` | Partial | Host-delegated. Both paths resolved via kernel cwd. Named-FIFO identities follow file and containing-directory renames, including destination replacement. |
| `stat()` / `lstat()` | Partial | Host-delegated. stat follows symlinks, lstat does not. Procfs fd magic links are validated against live fd/OFD pairs: following `/proc/<pid>/fd/N` returns the target OFD metadata even after its pathname is unlinked, while no-follow operations report the symlink and closed slots return ENOENT. Registered AF_UNIX pathname sockets preserve the backing VFS inode's uid, gid, permissions, timestamps, and link count while reporting `S_IFSOCK`. Registered named FIFOs likewise preserve VFS metadata while reporting `S_IFIFO`; `readdir()` and `getdents64()` report `DT_FIFO`. |
| `statfs()` / `fstatfs()` | Partial | Host-backed and virtual filesystem statistics are reported. Ordinary VFS mounts honor set-ID mode bits and clear `ST_NOSUID`; mounts configured with explicit `nosuid` set the flag. Node and browser use the same resolved mount option rather than trusting raw backend flags. The default writable root image honors set-ID, while scratch, device, and shared-memory mounts are explicitly `nosuid`. |
| `chmod()` / `chown()` / `lchown()` | Partial | VFS metadata updates, plus persistent updates to the live devpts slave record. `chown()` follows the final symlink; `lchown()` changes the link itself, including dangling links. Ownership calls preserve either unchanged-ID sentinel and validate the selected object and authorization before delegation. Root may select arbitrary IDs; an unprivileged owner must preserve its user ID and may select its effective GID or any authoritative supplementary group. On metadata-backed SharedFS and Node regular files, every successful ownership call clears S_ISUID and S_ISGID, regardless of execute bits, while directories, symlinks, and character-device PTY slaves retain their modes. Node host-backed changes stay in virtual metadata; browser memory-backed mounts store them in the VFS. OPFS has neither symlinks nor ownership metadata, so its existing ownership operations are no-ops. |
| `access()` | Partial | Resolves the pathname component-wise and checks traversal plus target permissions with real credentials. `faccessat(..., AT_EACCESS)` selects effective credentials. Both use effective GID and the process's complete supplementary-group membership for group checks. |
| `realpath()` | Full | Uses the global component walker against cwd, including mount crossings and relative or absolute symlinks; `missing/..` fails instead of being collapsed lexically, trailing slash requires a directory, and more than 40 symlinks returns ELOOP. |
| `symlink()` / `readlink()` | Partial | Host-delegated. Symlink target stored as-is, linkpath resolved. |
| `sync()` / `syncfs()` | Stub | Returns 0 (no-op). Filesystem sync managed by host. |
| `sync_file_range()` | Stub | Returns 0 (no-op). |
| `chroot()` | Stub | Returns EPERM. No filesystem namespace isolation. |
| `mount()` / `umount2()` | Stub | Returns EPERM. Future: VFS mount/unmount support. |
| `pivot_root()` | Stub | Returns EPERM. |
| `mkfifo()` / `mkfifoat()` / `mknod()` / `mknodat()` | Partial | S_IFREG and S_IFIFO are supported. A FIFO has a VFS marker for namespace and metadata plus a kernel pipe for I/O, with mode/umask/ownership, hard links, rename, unlink, forked descriptors, and blocking rendezvous preserved. Device nodes (S_IFCHR, S_IFBLK) return EPERM. The kernel-resident FIFO classification is not yet reconstructed when only a VFS snapshot is restored into a fresh kernel. |
| `quotactl()` | Stub | Returns ENOSYS. |
| `renameat2()` | Full | Delegates to renameat. Extra flags parameter ignored. |
| `faccessat2()` | Full | Delegates to faccessat. Extra flags parameter ignored. |
| `fchmodat2()` | Full | Delegates to fchmodat. Extra flags parameter ignored. |
| `getdents64()` | Partial | Host-backed directories, procfs, and devfs emit complete Linux directory records with the same cursor rules. A full buffer retains the next record, a later host error returns the complete prefix already copied, and EINVAL is returned only when an otherwise empty buffer cannot hold the next record. Each `d_off` is a stable next-record cookie: zero rewinds before `.`, the cookie after `.` resumes at `..`, and `lseek(fd, cookie, SEEK_SET)` resumes host and kernel-generated directories at that position. `dup()`, fork, `posix_spawn()`, retained legacy exec, and `SCM_RIGHTS` share that cookie. Each process retains its own host iterator; a generation mismatch closes and reconstructs it at the latest shared cookie, subject to the pathname-backed directory identity limitation above. |
| `getdents()` (legacy) | Partial | Delegates to getdents64 and shares its cursor and pathname-identity semantics. |
| `name_to_handle_at()` / `open_by_handle_at()` | Stub | Returns ENOSYS. |

## Linux-Compatible Device Extensions

These interfaces are intentionally Linux-shaped rather than POSIX. They live
in the kernel because they are device and process-lifecycle contracts, not demo
shortcuts.

| Interface | Status | Notes |
|-----------|--------|-------|
| `/dev/dri/renderD128` | Partial | Render-node subset for `libdrm`, GBM, EGL, and GLES. GEM handles are fd-local. BO mmap offsets must come from `DRM_IOCTL_MODE_MAP_DUMB` on the same open file description. GLIO command buffers live in process memory and are unbound on `munmap`, `exec`, `exit`, and final fd close. |
| `/dev/dri/card0` | Partial | Single virtual KMS device with one connector, encoder, and CRTC. Supports dumb buffers, `ADDFB2`/`RMFB`, DRM master, `SET_CRTC`, `PAGE_FLIP`, vblank event reads, and host-provided mode info for the attached KMS canvas. Multi-head, real display probing, PRIME dma-buf fds, and hardware acceleration are out of scope for v1. |
| Sysroot graphics libraries | Partial | `scripts/build-musl.sh` builds `libdrm.a`, `libgbm.a`, `libEGL.a`, and `libGLESv2.a` into `sysroot/lib` with pkg-config files. Packages consume these via `wasm32posix-pkg-config`; the libraries are not standalone package outputs. |

## Socket Operations

| Function | Status | Notes |
|----------|--------|-------|
| `socket()` | Partial | AF_UNIX, AF_INET, and AF_INET6 support SOCK_STREAM and SOCK_DGRAM. SOCK_NONBLOCK and SOCK_CLOEXEC flags are handled. AF_INET6 is limited to local `::`/`::1` routes; external and virtual-network IPv6 transports are not implemented. AF_INET SOCK_DGRAM uses kernel queues for loopback and a HostIO backend for routed virtual IPv4; external raw UDP is not exposed directly to userspace. |
| `socketpair()` | Full | AF_UNIX SOCK_STREAM. Bidirectional ring buffers (64KB each). Returns pre-connected pair. |
| `bind()` | Partial | AF_UNIX pathname and Linux abstract-namespace addresses, AF_INET TCP host-backed bind/listen, and AF_INET UDP in-kernel bind for INADDR_ANY, loopback, and broadcast addresses. AF_UNIX pathname bind resolves to a canonical namespace path and creates a VFS inode with mode `0777 & ~umask`; `stat`/`lstat`/`fstatat`, `chmod`, and `chown` share that inode metadata, and the socket metadata remains until unlink after the final close. Ordinary pathname rename rekeys the socket registry, including replacement of a stale destination registration; hard-link identity is not tracked. Abstract addresses create no VFS inode and become reusable after their final inherited owner closes. AF_INET6 accepts `::` and `::1`; stream and datagram binds use machine-wide conflict tables, and a non-`IPV6_V6ONLY` wildcard stream bind also reserves the IPv4 wildcard port. The browser local virtual-network backend supports AF_INET TCP/UDP binds between attached Kandelo machines, not IPv6. |
| `listen()` | Partial | AF_INET TCP delegates to the active HostIO networking backend, including Node `net` and the browser local virtual-network backend. AF_UNIX stream listen is implemented. AF_INET, AF_INET6, and AF_UNIX listeners inherited by fork share one accept queue, so any surviving pre-fork worker can accept each connection once. AF_INET6 `::`/`::1` loopback listeners support same- and cross-process connections; external and virtual IPv6 listeners do not. Datagram listen rejects as unsupported. |
| `accept()` / `accept4()` | Partial | AF_INET TCP delegates to the active HostIO networking backend; AF_UNIX and AF_INET6 loopback streams return connected sockets from the shared kernel queue. A dual-stack IPv6 listener reports IPv4 peers as IPv4-mapped `sockaddr_in6`. Linux-style accept does not inherit O_NONBLOCK; accept4 applies SOCK_NONBLOCK and SOCK_CLOEXEC explicitly and rejects other flags before consuming a pending connection. Datagram accept rejects as unsupported. |
| `connect()` | Partial | AF_UNIX streams support same- and cross-process pathname or abstract-namespace listeners; pathname lookup uses the same canonical component walker as bind, including cross-process retries. AF_UNIX datagrams deliver to a registered peer only within the same process; a missing, wrong-type, or cross-process peer returns ECONNREFUSED until machine-wide datagram routing exists. AF_INET TCP is host-backed and works over Node external TCP or the browser local virtual-network backend. For an external non-blocking TCP handshake, the first pending call reports EINPROGRESS, a repeat while it remains pending reports EALREADY, and poll reports writable when completion or failure can be collected through SO_ERROR; blocking callers wait through the same host connection. AF_INET UDP connect stores the peer, auto-binds an ephemeral local port when needed, filters receives to the connected peer, and supports AF_UNSPEC unconnect. AF_INET6 streams support same- and cross-process `::1`; AF_INET6 datagrams are process-local and report `IPV6_V6ONLY=1` because dual-stack datagram routing is not implemented. Non-loopback IPv6 fails with EADDRNOTAVAIL for streams and ENETUNREACH for datagrams. External raw UDP also returns ENETUNREACH without another HostIO transport. |
| `send()` / `recv()` | Partial | Unix domain streams and datagrams, AF_INET/AF_INET6 TCP streams, and connected AF_INET/AF_INET6 UDP preserve their socket-family addressing and datagram boundaries. TCP send/recv works over Node external TCP and the local virtual-network backend. Datagram MSG_PEEK and MSG_DONTWAIT are handled through recvfrom. Normal TCP close drains queued bytes before FIN and EOF; no transport invents a fixed post-FIN write count. A send rejected by a closed/reset stream returns EPIPE and raises SIGPIPE, while direct host/virtual handles may preserve ECONNRESET; accepted pipe-bridged resets currently surface as EOF/EPIPE. MSG_NOSIGNAL suppresses SIGPIPE without changing the errno. |
| `sendto()` / `recvfrom()` | Partial | AF_INET, AF_INET6, and AF_UNIX datagrams support connected and unconnected send, receive queues, and connected-peer filtering. IPv4/IPv6 return sender addresses; AF_UNIX currently returns only the family. IPv4 limited-broadcast sends to `255.255.255.255` require `SO_BROADCAST` and fail with `EACCES` without it; enabling the option passes that permission gate, after which the send reaches the active routing/backend boundary. Kandelo does not itself model broadcast delivery. On AF_INET, AF_INET6, and AF_UNIX datagrams, Linux's input `MSG_TRUNC` extension returns the full datagram length while copying at most the caller's buffer; ordinary consume/`MSG_PEEK` behavior is unchanged. IPv4/IPv6 UDP receive queues hold 128 datagrams and drop a new arrival once full, preserving the accepted queue's order; `SO_RCVBUF` requests do not size that fixed queue, and `getsockopt` reports the fixed default capacity. AF_UNIX uses the same bound but preserves reliable delivery: a full queue blocks a blocking send through host retry and returns EAGAIN for `O_NONBLOCK`/`MSG_DONTWAIT`; capacity, association, shutdown, close, and pathname changes wake blocked sends and writable readiness waits to observe capacity or the new immediate error. In-kernel IPv4 loopback unicast reaches one accepting socket across processes on the same machine. IPv6 loopback, AF_UNIX datagrams, and IPv4 multicast remain process-local; generic machine-wide cross-process datagram routing is not implemented. Fork preserves kernel-local bind reservations and lookup ownership, but it does not yet share or transfer a host-backed UDP registration. The `10.88.*` LocalVirtualNetwork path can route IPv4 datagrams between attached Kandelo machines through HostIO for the process that registered the endpoint. IPv4 multicast supports interface selection, loop suppression, membership, and source filtering only; IPv6 multicast and external raw UDP are not implemented. |
| `sendmsg()` / `recvmsg()` | Partial | The host validates every native wasm32/wasm64 iovec and enforces the generated `IOV_MAX` of 1,024. It flattens the complete send list into one fixed-wire kernel buffer and scatters a received prefix across the complete caller list; zero-length entries remain valid. The complete aligned header, optional name, translated control records, one canonical iovec, and payload are capacity-checked as one owned layout: the ordinary channel allocation is used when it fits, and a fresh Rust-owned token reservation is used otherwise. The operation is never shortened merely to fit scratch. Native `cmsghdr` records are translated between the generated wasm32/wasm64 layouts and a fixed kernel wire, so receive capacity reflects the descriptors the caller layout can actually represent. `SCM_RIGHTS` preserves owned, receiver-reconstructible non-socket descriptions while they are queued. A batch containing a socket, epoll instance, stale backing, or other process-owned description that cannot be reconstructed fails atomically with `EOPNOTSUPP` before carrier bytes are published; a copied socket snapshot is never reported as successful transfer. AF_UNIX stream rights remain associated with their carrier-byte positions, `MSG_WAITALL` stops at a rights boundary, ordinary reads discard only rights whose bytes they consume, and repeated `MSG_PEEK` does not consume bytes or rights. AF_UNIX datagrams queue payload/address/rights atomically for connected and addressed same-process sends, including zero-byte messages received with `msg_iovlen == 0`; ordinary `read(..., 0)` remains a no-op. Closing the sender's fd cannot invalidate a supported in-flight or received reference. `recvmsg()` installs the descriptor prefix that fits the caller's control buffer, releases the excess, reports `MSG_CTRUNC`, applies `MSG_CMSG_CLOEXEC` atomically, and reports output `MSG_TRUNC` independently of the input flag that selects full-length return behavior. Cross-process AF_UNIX datagram routing, socket-descriptor transfer, and other socket-family ancillary messages remain unsupported, so this surface is still partial. |
| `setsockopt()` / `getsockopt()` | Partial | SOL_SOCKET exposes SO_TYPE, SO_DOMAIN, SO_ERROR, SO_ACCEPTCONN, SO_RCVBUF, and SO_SNDBUF; SO_REUSEADDR affects UDP bind conflicts. The public host scalar `setsockopt` wrapper stages exactly four value bytes in allocator-owned scratch and passes the lease-derived pointer plus length to Rust; the scalar is never interpreted as a kernel address. `SO_RCVTIMEO`/`SO_SNDTIMEO` accept musl's wasm32 time64 option numbers (66/67) and wasm64 long64 numbers (20/21), canonicalizing both to the same stored timeout state; `struct timeval` is 16 bytes on both ABIs. `SO_RCVBUF`/`SO_SNDBUF` requests are accepted and stored but do not resize kernel queues or pipe buffers; `getsockopt()` reports the fixed default. `SO_BROADCAST` controls only the IPv4 limited-broadcast permission gate and does not provide broadcast delivery. SO_LINGER uses `struct linger`; its disabled form is stored, while enabling timed or reset-style linger returns EOPNOTSUPP until every transport supports the close mode. SO_BINDTODEVICE validates `lo`/`eth0`, supports empty-name unbind, and constrains bind/connect/send routing. TCP_CONGESTION uses a string layout and accepts only the modeled `cubic` policy; selecting unimplemented algorithms fails. IPv4 multicast membership/source-filter options drive process-local loopback delivery. IPV6_V6ONLY controls pre-bind stream dual-stack behavior; AF_INET6 datagrams truthfully remain V6-only. Other accepted IPv6 multicast options are stored but do not provide IPv6 multicast transport. |
| `shutdown()` | Partial | SHUT_RD, SHUT_WR, and SHUT_RDWR transitions are idempotent within a process and release each owned pipe/host reference once. UDP write shutdown returns EPIPE on datagram send; read shutdown is EOF-like for recv/poll. Sending to a read-shut AF_UNIX datagram peer returns EPIPE (and SIGPIPE unless MSG_NOSIGNAL is used), and the transition wakes blocked sends/readiness waits. Fork-inherited sockets still clone shutdown flags per process instead of sharing one socket-wide shutdown state, and the external host ABI has no half-shutdown operation. |
| `select()` | Partial | Wrapper around poll(). Converts fd_set bitmasks to pollfd array. A finite wait keeps one absolute deadline across host retries and finishes with a zero-time kernel pass, except for the descriptor-free sleep form. A caught signal interrupts a would-block retry, including the no-fd sleep path, with EINTR; ignored signals leave it parked and a concurrently ready result is preserved. |
| `poll()` | Partial | Checks readiness for regular files, pipes, and sockets. UDP poll reports queued datagrams, connected-peer filtering, EOF-like read shutdown, write-shutdown hangup, and pending socket errors. A finite wait keeps one absolute deadline across targeted wakeups and safety retries, then finishes with a zero-time kernel pass that clears `revents`. Returns EINTR on pending signals. |
| `ppoll()` | Full | Wraps poll() with atomic signal mask swap: save → set → poll → restore. If the replacement mask makes a caught signal deliverable, its catcher observes that replacement mask together with sa_mask and the delivered signal. Per-TID LIFO contexts keep nested waits distinct while SA_RESTART resubmits a zero-progress outer ppoll; terminal completion, exact final-EINTR cancellation, or `longjmp`/`siglongjmp` abandonment retires each context once. The glue layer converts the timespec to milliseconds. A finite call keeps its absolute deadline in that libc call frame across host retries and catcher syscalls, so nested or later identical-argument calls cannot inherit it; expiry still reaches the kernel so `revents` is copied back and the temporary mask is restored. |
| `pselect6()` | Partial | Wraps select() with an atomic signal-mask swap across the host retry loop. The pselect6-style `{sigset_t *, size_t}` argument supplies the mask; timeout precision is rounded to host milliseconds. A catcher observes the replacement mask while it runs, and exact final-EINTR cancellation restores the Rust-owned pre-wait mask once after the catcher. A finite wait preserves its deadline and expires through a zero-time kernel pass. Caught signals interrupt a would-block retry with EINTR; with SA_RESTART, Kandelo deliberately selects POSIX's implementation-defined EINTR result instead of restart. |
| `epoll_create1()` | Full | Creates epoll instance with per-process interest list. EPOLL_CLOEXEC flag supported. |
| `epoll_ctl()` | Full | EPOLL_CTL_ADD, EPOLL_CTL_MOD, EPOLL_CTL_DEL. Stores interest set with events + data. |
| `epoll_pwait()` | Full | Builds pollfd from interest set, delegates to poll, maps results back to epoll_event structs. Optional signal mask swap. |
| `epoll_create()` / `epoll_wait()` | Full | Legacy aliases. epoll_create ignores size param. epoll_wait delegates to epoll_pwait with null sigmask. |
| `sendmmsg()` / `recvmmsg()` | Stub | Returns ENOSYS. |

Socket-address transport uses two generated limits rather than one ambiguous
maximum. Bind, connect, sendto, and nested `sendmsg.msg_name` accept a complete
128-byte `sockaddr_storage`; generic address outputs use the same complete
container, while family-specific AF_UNIX parsing remains bounded by the
110-byte `sockaddr_un`. The registry keeps the canonical AF_UNIX namespace key,
but `getsockname()` returns the bounded original name supplied to `bind()`.
Consequently a short relative bind cannot expand into a deep canonical path on
output, while an exact 108-byte non-NUL pathname may still report 111 bytes
after its output terminator. A larger receive buffer is valid, but the host
proves and reserves only the 128-byte prefix the kernel can write.

## Time

| Function | Status | Notes |
|----------|--------|-------|
| `time()` | Full | Wrapper around clock_gettime(CLOCK_REALTIME). Returns seconds since epoch. |
| `gettimeofday()` | Full | Wrapper around clock_gettime(CLOCK_REALTIME). Returns (sec, usec) pair. |
| `clock_gettime()` | Partial | Host-delegated. `CLOCK_REALTIME` and `CLOCK_MONOTONIC` are supported. Linux `CLOCK_REALTIME_COARSE` and `CLOCK_MONOTONIC_COARSE` requests use the corresponding host clock as an equivalent fallback because Kandelo hosts do not expose separate coarse sources. `CLOCK_BOOTTIME` is a monotonic-equivalent fallback because Kandelo hosts do not expose suspend accounting. The named process/thread CPU clocks currently report elapsed monotonic time rather than authoritative CPU usage; musl's encoded per-thread clock IDs returned by `pthread_getcpuclockid()` are not yet recognized and return `EINVAL`. Linux-style encoded process CPU clock IDs must be negative; malformed positive encodings are rejected with `EINVAL` (which musl's `clock_getcpuclockid()` maps to `ESRCH`). Node.js uses `Date.now()` and `process.hrtime.bigint()`; browsers use `Date.now()` and `performance.now()`. |
| `nanosleep()` | Partial | Host-delegated. Node.js uses Atomics.wait with timeout. Browser support requires a worker context that can block with Atomics.wait. Validates tv_sec >= 0 and tv_nsec < 1e9. |
| `usleep()` | Full | Converts microseconds to sec+nsec, delegates to host_nanosleep. |
| `clock_settime()` | Stub | Returns EPERM. Cannot set system clock from Wasm. |
| `settimeofday()` | Stub | Returns EPERM. Cannot set system clock from Wasm. |
| `adjtimex()` / `clock_adjtime()` | Stub | Returns EPERM. Cannot adjust system clock from Wasm. |
| `utimes()` | Full | Converts timeval to timespec, delegates to utimensat. |
| `futimesat()` | Full | Like utimes but relative to dirfd. Delegates to utimensat. |
| `utimensat()` / `futimens()` | Partial | Updates access and modification times for host-backed files and named FIFOs. Setting both timestamps to the current time accepts either ownership or write permission; explicit timestamps require ownership, while two `UTIME_OMIT` values are an authorization-free no-op after path/fd validation. Direct descriptor mutation through futimens rejects O_PATH/O_SEARCH descriptors with EBADF. |

## Scheduler

| Function | Status | Notes |
|----------|--------|-------|
| `sched_getparam()` | Stub | Writes sched_priority=0. Single-threaded Wasm has no scheduling policy. Returns EPERM when the caller's effective uid doesn't match the target's. |
| `sched_setparam()` | Stub | Returns 0 (no-op). Returns EPERM for cross-user targets. |
| `sched_getscheduler()` | Stub | Returns 0 (SCHED_OTHER). Returns EPERM for cross-user targets. |
| `sched_setscheduler()` | Stub | Returns 0 (no-op). Returns EPERM for cross-user targets. |
| `sched_get_priority_max()` | Stub | Returns 0. |
| `sched_get_priority_min()` | Stub | Returns 0. |
| `sched_rr_get_interval()` | Stub | Writes 10ms timespec. |
| `sched_setaffinity()` | Stub | Returns 0 (no-op). |
| `sched_getaffinity()` | Stub | Linux-specific one-CPU compatibility surface. Running or stopped workers and process leaders that have not been reaped (including zombie leaders) report a fixed four-byte CPU-0 mask; reaped leaders, dead workers, and absent tasks return `ESRCH`. The raw syscall requires a size of at least four bytes aligned to four, writes and returns exactly four bytes, and leaves a larger raw buffer's tail untouched. Musl's public wrapper zero-fills that tail and returns 0. Process leaders and worker TIDs share the kernel's global task-ID sequence, so each numeric target identifies at most one retained task. |
| `sched_yield()` | Stub | Returns 0 (no-op, single-threaded). |

## Event/Notification

| Function | Status | Notes |
|----------|--------|-------|
| `eventfd()` / `eventfd2()` | Full | A refcounted kernel-global u64 counter is shared by inherited descriptors across fork/spawn and survives exec unless CLOEXEC. read returns the counter (or 1 for EFD_SEMAPHORE); write adds to it. EFD_NONBLOCK/EFD_CLOEXEC and poll readiness are supported. |
| `timerfd_create()` | Full | Creates a refcounted kernel-global timerfd backing with CLOCK_REALTIME or CLOCK_MONOTONIC. Inherited descriptors observe the same timer and expiration count; non-CLOEXEC state survives exec. TFD_NONBLOCK and TFD_CLOEXEC are supported. |
| `timerfd_settime()` / `timerfd_gettime()` | Full | Arms/disarms the shared timerfd backing with interval and initial expiration. TFD_TIMER_ABSTIME is supported; read returns the shared expiration count and poll reports POLLIN when expired. |
| `inotify_init()` / `inotify_init1()` | Stub | Returns ENOSYS. |
| `inotify_add_watch()` / `inotify_rm_watch()` | Stub | Returns EBADF. |
| `fanotify_init()` / `fanotify_mark()` | Stub | Returns ENOSYS. |
| `timer_create()` | Partial | Supports `CLOCK_REALTIME`, `CLOCK_MONOTONIC`, and monotonic-equivalent `CLOCK_BOOTTIME` with `SIGEV_SIGNAL`, `SIGEV_NONE`, Linux `SIGEV_THREAD_ID`, and POSIX `SIGEV_THREAD` through musl's exact-thread helper. Expirations preserve `SI_TIMER`, timer ID, overrun metadata, and the complete caller-native `union sigval` on Node and browser hosts. The generated 64-byte `sigevent` layout and explicit process pointer width preserve a wasm64 `sival_ptr`; wasm32 delivery uses its target-native 32-bit union width. |
| `timer_settime()` / `timer_gettime()` | Partial | Absolute (`TIMER_ABSTIME`) and relative timers and automatic interval rearming use host timers with millisecond granularity. `timer_gettime()` and `timer_settime()`'s old-value result currently report the last configured value rather than decreasing remaining time. |
| `timer_getoverrun()` | Full | Tracks overruns per timer while its notification remains pending and reports the count associated with the most recently accepted notification. |
| `timer_delete()` | Full | Cancels the host timer, removes its queued notification before slot reuse, and removes it from the per-process table. |

## IPC (System V & POSIX Message Queues)

| Function | Status | Notes |
|----------|--------|-------|
| `msgget()` / `msgsnd()` / `msgrcv()` / `msgctl()` | Full | Host-side SysV message queues via SharedIpcTable. Key-based creation, blocking send/recv with message types, IPC_STAT/IPC_SET/IPC_RMID control. IPC_STAT/IPC_SET stage the caller-width `msqid_ds`: 96 bytes for wasm32 time64 and 120 bytes for wasm64 LP64. |
| `semget()` / `semop()` / `semctl()` / `semtimedop()` | Full | Host-side SysV semaphore sets. Atomic multi-semaphore operations, SEM_UNDO support, IPC_STAT/SETVAL/GETVAL/SETALL/GETALL. Before a pointer transfer, required kernel preflights return the exact allocation demand: permission-aware array bytes for GETALL/SETALL and the caller-layout `semid_ds` size for IPC_STAT. Musl's wasm32 time64 structure is 72 bytes and its wasm64 LP64 structure is 88 bytes; the process pointer width, not the kernel Wasm width, selects the layout. |
| `shmget()` / `shmat()` / `shmdt()` / `shmctl()` | Partial | Host-side SysV shared-memory segments support IPC_STAT/IPC_SET/IPC_RMID, fork inheritance, and exact attach/detach accounting. IPC_STAT/IPC_SET stage the caller-width `shmid_ds`: 88 bytes for wasm32 time64 and 112 bytes for wasm64 LP64. Separate process memories merge changed attachment bytes and import peer changes at syscall boundaries. Direct stores are not immediately visible and cross-process futex synchronization over an attachment is unsupported. |
| `ftok()` | Full | Standard ftok algorithm using stat inode + proj_id. |
| `mq_open()` / `mq_close()` / `mq_unlink()` | Full | Host-side POSIX message queues via PosixMqueueTable. O_CREAT/O_EXCL/O_RDONLY/O_WRONLY/O_RDWR/O_NONBLOCK. Descriptor range 0x40000000+. |
| `mq_timedsend()` / `mq_timedreceive()` | Full | Priority-ordered message delivery. Blocking with timeout support. O_NONBLOCK returns EAGAIN. |
| `mq_notify()` | Full | One `SIGEV_SIGNAL` notification on the first message sent to an empty queue, with one registration per queue. Signal numbers outside `1..NSIG` fail with `EINVAL`. Rust queues authoritative `SI_MESGQ`, full-width `union sigval`, and sender metadata before the host wake; the host does not synthesize a second signal. |
| `mq_getattr()` / `mq_setattr()` | Full | Get/set queue attributes (mq_flags, mq_maxmsg, mq_msgsize, mq_curmsgs). |

## Extended Attributes

| Function | Status | Notes |
|----------|--------|-------|
| `getxattr()` / `setxattr()` / `removexattr()` / `listxattr()` | Stub | Returns ENOSYS. Extended attributes not supported by host filesystem abstraction. |
| `lgetxattr()` / `lsetxattr()` / `lremovexattr()` / `llistxattr()` | Stub | Returns ENOSYS. |
| `fgetxattr()` / `fsetxattr()` / `fremovexattr()` / `flistxattr()` | Stub | Returns ENOSYS. |

## Terminal / TTY

| Function | Status | Notes |
|----------|--------|-------|
| `isatty()` | Full | Returns 1 for host terminal stdio and PTY master/slave fds; returns ENOTTY for pipes, files, and non-terminal character devices such as `/dev/null`, `/dev/zero`, framebuffer, audio, and DRM nodes. |
| `tcgetattr()` / `tcsetattr()` | Partial | Host terminal and PTY fds round-trip musl's exact 60-byte termios layout, including all four flag words, `c_line`, `c_cc`, and input/output speeds; custom syscalls 70/71 use that same layout and no longer expose a second shortened format. Non-terminal character devices return ENOTTY. `TCSANOW` and `TCSADRAIN` preserve unread input across `ICANON` transitions: completed lines and the current edited partial line become raw-readable in byte order, while unread raw bytes become immediately readable if the mode changes back, matching Linux EOF-push behavior. `TCSAFLUSH` discards unread input before applying the change. PTY writes synchronously enter the output queue, so there is no deferred device transmission to await. Implemented line discipline includes `VERASE`, `VKILL`, non-empty-line `VEOF`, ICRNL/INLCR/IGNCR, and ECHO/ECHOE/ECHOK/ECHONL. Remaining gaps: `VMIN`/`VTIME` values round-trip but raw-read timing is approximated, an empty canonical `VEOF` does not create a queued EOF event, a canonical `read()` can return bytes from multiple completed lines instead of stopping after one line, `VWERASE` is not implemented, and exposed input/output flags outside the listed subset do not all have data-path semantics. |
| `ioctl()` | Full | 16 terminal ioctls: TCGETS/TCSETS/TCSETSW/TCSETSF (termios), TIOCGPTN (PTY number), TIOCSPTLCK (unlock PTY), TIOCGPGRP/TIOCSPGRP (foreground pgid), TIOCGWINSZ/TIOCSWINSZ (window size + SIGWINCH), TCSBRK/TCXONC/TCFLSH, TIOCGSID/TIOCSCTTY/TIOCNOTTY (session/controlling terminal). Generic: FIONREAD, FIONBIO, FIOCLEX/FIONCLEX, FIOASYNC. Terminal and Linux-VT requests work on host terminals and PTYs and return ENOTTY on other character devices. |
| `posix_openpt()` | Full | Opens `/dev/ptmx`, allocates PTY pair, returns master fd. |
| `grantpt()` / `unlockpt()` | Full | PTY allocation already initializes the persistent slave metadata, so `grantpt()` is a no-op. `unlockpt()` clears the lock flag on the PTY pair. |
| `ptsname()` | Full | Returns `/dev/pts/N` path for the slave side. |
| `ttyname()` | Full | Via `/proc/self/fd/N` readlink on PTY slave fds. |
| `tcgetsid()` | Full | Via TIOCGSID ioctl. Returns session ID of the controlling terminal. |
| `tcgetpgrp()` / `tcsetpgrp()` | Full | Via TIOCGPGRP/TIOCSPGRP ioctls. Gets/sets foreground process group. |

## Virtual Device Files

| Device | Status | Notes |
|--------|--------|-------|
| `/dev/null` | Full | Read returns EOF (0). Write discards data (returns count). Seek no-op. |
| `/dev/zero` | Full | Read fills buffer with zeros. Write discards data (returns count). |
| `/dev/urandom` / `/dev/random` | Full | Read delegates to `host_getrandom()` (crypto.getRandomValues on host). Write discards. |
| `/dev/full` | Full | Read fills buffer with zeros. Write returns ENOSPC. |
| `/dev/fd/N` | Full | Symlink-like descriptor alias. `open()` duplicates fd N; following `stat()`/`fstatat()` returns the same metadata as `fstat(N)`, while `lstat()`/`AT_SYMLINK_NOFOLLOW` reports the devfs symlink. `readlink()` returns the open file description's path. Opening validates the target fd exists (EBADF if not). |
| `/dev/stdin` | Full | Symlink alias for `/dev/fd/0`; following metadata is fd 0 metadata. |
| `/dev/stdout` | Full | Symlink alias for `/dev/fd/1`; following metadata is fd 1 metadata. |
| `/dev/stderr` | Full | Symlink alias for `/dev/fd/2`; following metadata is fd 2 metadata. |
| `/dev/tty` | Partial | Uses the first open PTY-slave OFD as the current controlling-terminal heuristic. A PTY-backed open publishes a distinct control-alias OFD: descriptor stat keeps the root-owned `/dev/tty` identity, and descriptor chmod/chown do not mutate the selected slave. When no PTY slave is open, it currently falls back to fd 0 rather than returning ENXIO; `pathconf()` follows that same OFD selection and therefore does not advertise terminal variables for the captured, pipe-backed case. |
| `/dev/ptmx` | Full | PTY master multiplexer. `open()` allocates a new PTY pair, returns master fd. |
| `/dev/pts/*` | Full | PTY slave devices. Allocation captures the creator's effective UID and, because no separate tty group is configured, effective GID, with mode `0620`. `stat()`, `lstat()`, `fstatat()`, `statx()`, and descriptor stat share that persistent record; authorized chmod/chown operations update it, and open checks use the caller's current effective credentials and complete supplementary groups. Metadata survives slave close/reopen and is discarded with the pair. `/dev/ptmx` remains a distinct root-owned clone node. Also supports `posix_openpt()` + `grantpt()` + `unlockpt()` + `ptsname()`, full line discipline, canonical/raw mode, OPOST/ONLCR, and 16 terminal ioctls. |
| `/dev/fb0` | Full | Linux fbdev framebuffer. Single-open (`EBUSY` for second opener). 640×400 BGRA32 packed-pixel. ioctls: `FBIOGET_VSCREENINFO`, `FBIOGET_FSCREENINFO`, `FBIOPAN_DISPLAY` (no-op success), `FBIOPUT_VSCREENINFO` (validates geometry). `mmap` returns a region in process memory and notifies the host (`bind_framebuffer` callback) so the browser canvas can mirror pixels. `munmap`/`exit`/`exec` discard the image mapping; a surviving fd retains device ownership across exec. Ownership is released after both the final fd and any live mapping are gone, since a mapping remains valid after `close()`. Linux-VT keyboard ioctls (`KDGKBTYPE`/`KDGKBMODE`/`KDSKBMODE`) are accepted on the process's terminal fd so fbDOOM-style software works unmodified; `/dev/fb0` itself is not a terminal. |
| `/dev/input/mice` | Full | Linux `mousedev` PS/2 mouse stream. Single-open (`EBUSY` for second pid). 3-byte packets: byte0 button bits + sign/overflow flags, bytes 1..2 signed dx/dy with positive-up dy. Host pushes events via `kernel_inject_mouse_event(dx, dy, buttons)`; the kernel buffers up to 4096 packets (whole-packet drop on overflow). `read()` drains queued bytes; returns `EAGAIN` when empty. `poll()` reports `POLLIN` only when bytes are queued. Ownership and queued packets survive exec with a non-CLOEXEC fd; last close or exit releases and clears them. No IMPS/2 wheel protocol, no `evdev`/`/dev/input/eventN`. |
| `/dev/dsp` | Partial (playback only) | Source-compatible OSS PCM playback over the implementation-neutral Kandelo PCM core. U8/S16_LE/S16_BE, mono/stereo, 8–192 kHz; bounded fragment queue with blocking/nonblocking backpressure and audio-clock drain. Exclusive ownership is per OFD, not PID. See the matrix below. Capture, duplex, mmap, mixer controls, and multi-client mixing are unsupported. |
| `/dev/shm/*` | Partial | POSIX shm objects are regular files used by `shm_open()`. Stable-identity backends support host-coordinated `MAP_SHARED` across processes at syscall boundaries; this is not immediate shared linear memory and does not make process-shared futexes work. |

Character-device entries return synthetic `stat()` with deterministic inode numbers and `st_dev=5`. Descriptor aliases are devfs symlinks: following metadata comes from the referenced descriptor, and no-follow metadata uses a deterministic devfs inode. Path interception happens in the kernel before host delegation, so Node.js and browser hosts share the same behavior without host filesystem changes. `access()` returns OK for all virtual devices.

## OSS playback compatibility

Kandelo owns a fixed wasm32 OSS source ABI in `<sys/soundcard.h>`; it does not
import a Linux host UAPI. `audio_buf_info` is four signed 32-bit fields in the
canonical `fragments`, `fragstotal`, `fragsize`, `bytes` order (16 bytes,
4-byte alignment). `count_info` is three signed 32-bit fields (`bytes`,
`blocks`, `ptr`; 12 bytes, 4-byte alignment). The C header, Rust constants,
and ABI snapshot assert every numeric value and layout. Canonical source aliases
are emitted by the same Rust-owned generator and carry C equality assertions.
The command semantics follow
the established [FreeBSD PCM/OSS frontend](https://github.com/freebsd/freebsd-src/blob/main/sys/dev/sound/pcm/dsp.c)
and [canonical OSS definitions](https://github.com/torvalds/linux/blob/master/include/uapi/linux/soundcard.h),
while the numeric encodings below are specifically Kandelo's wasm32 ABI.

| Command | wasm32 value | Support and observable behavior |
|---|---:|---|
| `SNDCTL_DSP_RESET` (`SNDCTL_DSP_HALT`, `SOUND_PCM_RESET`) | `0x00005000` | Discards queued output, stops the stream, advances the reset generation, and wakes capacity/drain waiters. This is the explicit non-draining shutdown operation. |
| `SNDCTL_DSP_SYNC` (`SOUND_PCM_SYNC`) | `0x00005001` | Pads a terminal incomplete PCM frame with format silence, then blocks until the host audio clock has consumed all queued frames. Existing signal interruption rules apply; it is not an acknowledge-only no-op. |
| `SNDCTL_DSP_SPEED` (`SOUND_PCM_WRITE_RATE`) | `0xc0045002` | Signed 32-bit in/out rate. Zero queries the current rate; nonzero requests clamp to 8000–192000 Hz and return the actual value. Reconfiguration while running or draining returns `EBUSY`. |
| `SOUND_PCM_READ_RATE` | `0x80045002` | Returns the current actual rate as a signed 32-bit value without changing the configuration. |
| `SNDCTL_DSP_STEREO` | `0xc0045003` | Signed 32-bit in/out legacy mono/stereo selector (`0`/`1`), returning the actual selection. |
| `SNDCTL_DSP_GETBLKSIZE` | `0xc0045004` | Returns the actual fragment size in bytes. |
| `SNDCTL_DSP_SETFMT` (`SNDCTL_DSP_SAMPLESIZE`, `SOUND_PCM_SETFMT`, `SOUND_PCM_WRITE_BITS`) | `0xc0045005` | Signed 32-bit in/out format. Supports `AFMT_U8`, `AFMT_S16_LE`, and `AFMT_S16_BE`; `AFMT_QUERY` returns the current format. Reconfiguration while running or draining returns `EBUSY`. |
| `SOUND_PCM_READ_BITS` | `0x80045005` | Returns the current actual sample width (`8` or `16`) as a signed 32-bit value without changing the configuration. |
| `SNDCTL_DSP_CHANNELS` (`SOUND_PCM_WRITE_CHANNELS`) | `0xc0045006` | Signed 32-bit in/out channel count. Zero queries; requests negotiate to mono or stereo and return the actual count. |
| `SOUND_PCM_READ_CHANNELS` | `0x80045006` | Returns the current actual channel count as a signed 32-bit value without changing the configuration. |
| `SNDCTL_DSP_POST` (`SOUND_PCM_POST`) | `0x00005008` | Starts output without fabricating data. An empty stream underruns to silence. |
| `SNDCTL_DSP_SETFRAGMENT` (`SOUND_PCM_SETFRAGMENT`) | `0xc004500a` | Signed 32-bit in/out geometry: high 16 bits request fragment count, low 16 bits request log2 fragment bytes. The exponent clamps to 4–16. A zero count selects the maximum whole-fragment count fitting 65536 bytes; a nonzero count clamps to at least two fragments when two fit, then to that maximum. Thus exponent 16 truthfully selects the only possible geometry: one 64 KiB fragment. Returns the encoded actual geometry. Reconfiguration while running or draining returns `EBUSY`. |
| `SNDCTL_DSP_GETFMTS` (`SOUND_PCM_GETFMTS`) | `0x8004500b` | Returns exactly the supported playback format mask: U8, S16_LE, and S16_BE. |
| `SNDCTL_DSP_GETOSPACE` (`SOUND_PCM_GETOSPACE`) | `0x8010500c` | Returns truthful `audio_buf_info`: whole immediately available fragments, total fragments, fragment bytes, and all immediately writable bytes (including a partial fragment). SDL3 uses `bytes` to pace its wait path. |
| `SNDCTL_DSP_NONBLOCK` (`SOUND_PCM_NONBLOCK`) | `0x0000500e` | Sets `O_NONBLOCK` on the shared OFD. `fcntl()`/`FIONBIO` may subsequently manage that status flag through the normal descriptor path. |
| `SNDCTL_DSP_GETCAPS` (`SOUND_PCM_GETCAPS`) | `0x8004500f` | Returns only `PCM_CAP_OUTPUT | PCM_CAP_VIRTUAL | PCM_CAP_DEFAULT`. It does not advertise capture, duplex, mmap, trigger, or multi-open capabilities. |
| `SNDCTL_DSP_GETOPTR` (`SOUND_PCM_GETOPTR`) | `0x800c5012` | Returns `count_info`: low 32 bits of audio-clock-consumed bytes, fragment transitions since the previous query on this stream, and the consumer byte offset modulo active capacity. `RESET` discards do not advance it; drain padding counts when played. |
| `SNDCTL_DSP_GETODELAY` | `0x80045017` | Returns all queued, not-yet-consumed output bytes, including terminal-frame padding once a drain begins. |

The SDK header also defines the canonical FreeBSD OSS format identifiers for
mu-law, A-law, IMA ADPCM, signed 8-bit, unsigned 16/24/32-bit, signed
24/32-bit, MPEG, AC3, and 32-bit float formats, including native- and
opposite-endian aliases. This is source compatibility, not an advertisement:
`GETFMTS` contains only U8/S16_LE/S16_BE, and `SETFMT` returns `EINVAL` for the
other identifiers.

The following canonical command numbers are pinned in the SDK header so source
and ioctl marshalling cannot drift, but the playback-only frontend rejects each
one with `ENOTTY`; none is accepted as a no-op or advertised by `GETCAPS`.

| Unsupported command | wasm32 value | Boundary |
|---|---:|---|
| `SNDCTL_DSP_SETBLKSIZE` | `0x40045004` | FreeBSD's distinct block-size setter is source-visible, but direct block-size setting is not implemented. It does not collide with the supported `GETBLKSIZE` request. |
| `SOUND_PCM_WRITE_FILTER` | `0xc0045007` | Legacy PCM filter control is not implemented. |
| `SOUND_PCM_READ_FILTER` | `0x80045007` | Legacy PCM filter query is not implemented. |
| `SNDCTL_DSP_SUBDIVIDE` (`SOUND_PCM_SUBDIVIDE`) | `0xc0045009` | Legacy fragment subdivision is not implemented; use `SETFRAGMENT`. |
| `SNDCTL_DSP_GETISPACE` (`SOUND_PCM_GETISPACE`) | `0x8010500d` | Capture-space query; capture is not implemented. |
| `SNDCTL_DSP_SETTRIGGER` (`SOUND_PCM_SETTRIGGER`) | `0x40045010` | Trigger control is not implemented. The header defines canonical values `PCM_ENABLE_INPUT=1` and `PCM_ENABLE_OUTPUT=2` without advertising trigger capability. |
| `SNDCTL_DSP_GETTRIGGER` (`SOUND_PCM_GETTRIGGER`) | `0x80045010` | Trigger control is not implemented. |
| `SNDCTL_DSP_GETIPTR` (`SOUND_PCM_GETIPTR`) | `0x800c5011` | Capture-position accounting is not implemented. |
| `SNDCTL_DSP_MAPINBUF` (`SOUND_PCM_MAPINBUF`) | `0x80085013` | Direct mapped capture buffers are not implemented. |
| `SNDCTL_DSP_MAPOUTBUF` (`SOUND_PCM_MAPOUTBUF`) | `0x80085014` | Direct mapped playback buffers are not implemented. |
| `SNDCTL_DSP_SETSYNCRO` (`SOUND_PCM_SETSYNCRO`) | `0x00005015` | Synchronized input/output start is not implemented. |
| `SNDCTL_DSP_SETDUPLEX` | `0x00005016` | Duplex operation is not implemented. |

The initial stream is 48 kHz stereo S16_LE with four 1024-byte fragments.
Configuration calls record both requested and returned actual values. Format,
rate, channel, and fragment changes return `EBUSY` while running or draining;
they are accepted again after a successful `SYNC` leaves the stream stopped,
or after `RESET`. Writes
accept arbitrary byte lengths and form one continuous PCM byte stream; a
partial frame remains queued across subsequent writes. `SYNC` and final OFD
close pad a terminal partial frame with `0x80` for U8 or `0x00` for either S16
format before draining. `POST` does not pad. A frame-aligned blocking write no
larger than active capacity waits for the full request, including normal SDL
period writes. If a prior unaligned write has left an incomplete frame at a
full queue boundary, a later blocking call may return the prefix that completes
that frame so playback can resume; callers must handle that ordinary Unix
short-write result. Requests larger than capacity may also advance partially.
With `O_NONBLOCK`, available bytes are accepted immediately, and no capacity
returns `EAGAIN`. `poll(POLLOUT)` is reported only when at least one fragment
is free. Consumer progress wakes writers and poll/drain waiters. Underruns
output silence; queue overflow never discards older audio.
Underruns are counted once per continuous starvation episode, and a short,
successfully draining tail is not classified as an underrun.

The one physical/default device is exclusively owned by its OFD. `dup()` and
fork inheritance share it; a separate `open()` returns `EBUSY`, including one
from the same PID. Explicit final `close()` drains before releasing ownership.
Exit, `CLOEXEC`, or forced teardown leaves a queued tail draining and keeps the
device busy until the audio clock reaches the producer. A non-`CLOEXEC`
descriptor and its queued state survive `exec`. Caught signals interrupt a
blocked write, `SYNC`, or final close with `EINTR`; `SA_RESTART` applies to
write and `SYNC`, while an interrupted close keeps the descriptor open for a
caller-directed retry.

A permanent host sink failure is latched and wakes every affected waiter.
Further writes and drains fail with `EIO`, `poll()` exposes `POLLERR`, and final
close discards the now-unplayable tail, releases the fd/OFD and exclusive
ownership, and returns `EIO`. If the failure arrives during an orphan drain
after exit or `CLOEXEC`, reconciliation discards the unplayable orphan tail and
releases exclusive ownership; there is no fd left to report `EIO` through.
Browser user-activation suspension is recoverable backpressure and does not set
this fatal state.

Capture opens (`O_RDONLY` and `O_RDWR`) fail with `ENOTSUP`; they do not expose
a device that returns EOF. Unsupported and unknown ioctls fail with `ENOTTY`,
`mmap()` fails with `ENODEV`, and seek-style operations fail with `ESPIPE`. `/dev/mixer`,
recording, duplex, trigger control, direct mapped playback, and kernel mixing
remain explicit gaps.

## Environment

| Function | Status | Notes |
|----------|--------|-------|
| `getenv()` | Full | Kernel-managed environment block. Returns value or ENOENT. ERANGE if buffer too small. |
| `setenv()` / `unsetenv()` | Full | Kernel-managed. setenv supports overwrite flag. Rejects empty name or name containing '='. |
| `environ` | Partial | Stored as Vec of KEY=VALUE entries in Process. No C-style char** environ pointer yet. |

## Locale

| Function | Status | Notes |
|----------|--------|-------|
| `getlocalename_l()` | Full | Returns the real per-category name from local and global locale objects. LC_ALL returns a `setlocale()`-compatible name, including mixed-category locales. |
| `nl_langinfo()` / `nl_langinfo_l()` | Partial | Implements musl's locale data plus POSIX.1-2024 `ALTMON_1` through `ALTMON_12` and `ABALTMON_1` through `ABALTMON_12`. Musl catalogs do not encode a distinct alternate grammatical month form, so those items fall back to the corresponding full or abbreviated month name. |

## System Information

| Function | Status | Notes |
|----------|--------|-------|
| `uname()` | Full | Returns sysname="wasm-posix", nodename="localhost", release="1.0.0", version="kandelo", machine="wasm32". 5 x 65-byte null-terminated strings. |
| `sysconf()` | Partial | Handles _SC_CHILD_MAX, _SC_CLK_TCK=100, _SC_PAGE_SIZE=65536, _SC_OPEN_MAX=1024, _SC_NPROCESSORS_ONLN=1, _SC_NPROCESSORS_CONF=1, _SC_MONOTONIC_CLOCK=1, _SC_THREAD_SAFE_FUNCTIONS=1, plus 100+ POSIX.1-2024 constants via musl overlay. Unknown names return EINVAL. |
| `umask()` | Full | Set file creation mask, returns previous mask. Default 0o022. Applied in open() and mkdir(). Masked to 0o777. |
| `getrlimit()` | Full | Returns (soft, hard) resource limits. Defaults: NOFILE=(1024,4096), STACK=(8MB,infinity), others infinity. |
| `setrlimit()` | Partial | Sets resource limits and validates soft <= hard. RLIMIT_NOFILE updates the fd-table ceiling. RLIMIT_FSIZE covers regular-file and memfd write/pwrite, vectored, transfer, truncate, and mode-0 fallocate paths with partial-to-limit results and thread-directed SIGXFSZ only when no byte can be written. Other resource limits remain advisory or unsupported. |
| `getrusage()` | Partial | Returns the 144-byte kernel wire record used by musl: two timevals and 14 counters, all zero because Wasm hosts do not expose the required accounting. Musl converts that record into the target's public `struct rusage` layout. RUSAGE_SELF and RUSAGE_CHILDREN are supported. |
| `pathconf()` | Partial | Resolves the real namespace path and queries the selected backend. The common resolver enforces byte-based `_PC_NAME_MAX=255`, `_PC_PATH_MAX=4096` for caller and symlink-substituted pathnames (including the terminating NUL), and `_PC_NO_TRUNC=1`; a relative pathname is not charged for the process's internal absolute CWD prefix. `_PC_CHOWN_RESTRICTED=1` reflects the kernel authorization gate. Regular files report thread-backed AIO support. Symlink and timestamp answers reflect the backend (HostFS/MemoryFS timestamps are millisecond-granularity; OPFS reports indeterminate). `_PC_FILESIZEBITS` is currently indeterminate because the selected backend does not yet prove a file-offset bit width. Invalid names and unsupported file-type associations return EINVAL; valid indeterminate or unsupported options return -1 without changing errno. |
| `fpathconf()` | Partial | Uses the live OFD/backend identity rather than a remembered pathname, so renamed or unlinked open files remain queryable. Invalid fds return EBADF. Kernel pipes report `_PC_PIPE_BUF=4096`; host-backed captured stdio leaves it indeterminate because atomicity through that boundary is not yet proven. `_PC_FILESIZEBITS` remains indeterminate until the selected live backend can prove a file-offset bit width. Terminal buffers are currently unbounded, `_PC_VDISABLE=0`, and socket maximum buffering is indeterminate. |
| `getsockname()` | Partial | Returns stored local addresses for AF_UNIX and AF_INET/AF_INET6 stream or datagram sockets. UDP ephemeral ports, loopback/INADDR_ANY binds, and accepted INADDR_ANY connect outcomes are covered by Sortix UDP tests. External-route local address selection remains unsupported without a HostIO networking backend. |
| `getpeername()` | Full | Returns stored peer address for connected sockets. Returns ENOTCONN for unconnected. |

---

## Known POSIX Gaps

Systematic audit of all subsystems against POSIX specifications. Gaps are categorized by severity and actionability.

### Critical — Violates POSIX semantics, causes incorrect behavior

| Gap | Subsystem | Description |
|-----|-----------|-------------|
| ~~**fork, posix_spawn, and SCM_RIGHTS recipients have independent ordinary-file OFD metadata**~~ | fork / spawn / fd / sockets | **Resolved.** Per-process descriptor tables retain exact shared OFD state for offset, status flags, and async owner across fork, vfork, non-forking spawn, and supported `SCM_RIGHTS`. The ancillary queue retains the state even after sender close and observes mutations made after send. Directory host iterators remain process-local, but a shared position generation forces stale iterators to reopen and replay at the one authoritative cookie. `OfdId`, `FileId`, backing, and OFD/`flock()` lifetime remain exact until the final reference. Socket transfer is still rejected at its separate machine-wide-backing boundary. |

### High — Missing features that affect common programs

| Gap | Subsystem | Description |
|-----|-----------|-------------|
| **EINTR partially implemented** | all | read, write, recv, poll, select return EINTR when a signal is pending during a blocking wait. close() and other non-blocking syscalls do not check. Tied to signal handler invocation gap. |
| **PIPE_BUF guarantee at host-backed stdio boundary** | pipe / host | In-kernel pipes guarantee atomic writes through 4096 bytes and report that value from `fpathconf()`. Captured stdio uses host-backed pipe OFDs; its callback/native-write boundary has not been proven all-or-nothing through the compile-time `PIPE_BUF` value, so `fpathconf()` reports the limit as indeterminate. Do not treat the global `<limits.h>` promise as fully reconciled until that boundary is enforced or stdio is modeled differently. |
| Host-backed `O_APPEND` on externally mutable native mounts | write | Managed shared-memory, OPFS, memfd, lifecycle-owned Node scratch backings, and private copies imported into those scratch backings before boot readiness perform one exact EOF/limit/write operation. Public or extra native mounts return `EOPNOTSUPP` before mutation because Node does not expose the ending offset of its atomic append; supporting that boundary requires a native broker/capability that can return the exact outcome. |
| ~~**sigaction() missing sa_flags**~~ | signals | **Resolved.** SA_RESTART supported (auto-restart blocking syscalls). sa_flags and sa_mask stored. SA_SIGINFO handler delivery with siginfo_t. SA_NOCLDWAIT auto-reaps children. SA_NOCLDSTOP suppresses stop/continue SIGCHLD notification while preserving waitable status. |
| ~~**No signal queuing**~~ | signals | **Resolved.** RT signals (32-63) are now queued in a VecDeque; standard signals (1-31) remain coalesced per POSIX. |
| ~~**`*at()` functions with real dirfd**~~ | filesystem | **Resolved.** All *at() syscalls now support real dirfd via stored OFD paths. |
| ~~**No seekdir/telldir/rewinddir**~~ | directory | **Resolved.** DirStream now tracks path and position. rewinddir/telldir/seekdir implemented. |

### Medium — Spec deviations with limited practical impact

| Gap | Subsystem | Description |
|-----|-----------|-------------|
| ~~**RLIMIT_FSIZE partial enforcement**~~ | rlimits | **Resolved for implemented write and size-changing operations.** Scalar, vectored, tokenized large-transfer, regular-file, memfd, truncate, and mode-0 fallocate paths share one operation-boundary contract. Pipes, terminals, sockets, and other non-size-bearing objects remain unaffected. |
| **setpgid() self-only** | process | Only supports setting own pgid. Setting another process's pgid returns ESRCH. |
| ~~**realpath() no symlink resolution**~~ | filesystem | **Resolved.** Now resolves symlinks via iterative lstat/readlink with ELOOP after 40 resolutions. |
| **Socket options partially no-op** | socket | `SO_REUSEADDR` affects UDP bind conflicts, and `SO_BROADCAST` enforces the IPv4 limited-broadcast permission gate, but actual broadcast delivery remains unavailable. `SO_RCVBUF` and `SO_SNDBUF` are accepted/stored without resizing queues or pipe buffers; `getsockopt()` reports the fixed default. `SO_KEEPALIVE`, `SO_RCVTIMEO`, `SO_SNDTIMEO`, and `TCP_NODELAY` remain accepted/stored with limited or no data-path effect. The timeout options recognize both wasm32 time64 numbers (66/67) and wasm64 long64 numbers (20/21); that ABI parity does not broaden their documented data-path effect. Enabled `SO_LINGER` is rejected rather than stored as a no-op. |
| **POLLERR partial** | I/O multiplex | poll() reports UDP pending socket errors and stream shutdown/error cases. Some edge cases remain implementation-defined. |
| ~~**pread/pwrite not multi-process safe**~~ | I/O | **Resolved.** Host-backed positioned I/O uses direct read-at/write-at operations and never changes or restores the shared OFD cursor. Backends that cannot represent an exact signed-i64 position fail with `EOVERFLOW`. |
| ~~**brk not inherited on fork**~~ | memory | **Resolved.** Program break serialized/deserialized in fork state. (`exec` reset is intentional per POSIX; host re-installs from new program's `__heap_base`.) |
| ~~**VMIN/VTIME not interpreted**~~ | terminal | **Partially resolved.** `VMIN`/`VTIME` values round-trip through both termios layouts, but full timer-based raw-read semantics remain approximated. Empty-line `VEOF` also lacks the queued EOF event needed to distinguish EOF from ordinary no-data, canonical reads can coalesce multiple completed lines, and `VWERASE` remains unimplemented. |
| ~~**ICANON no line buffering**~~ | terminal | **Resolved.** ICANON mode now buffers input with line editing: VERASE (backspace), VKILL (^U), VEOF (^D). ICRNL/INLCR/IGNCR input processing and ECHO/ECHOE/ECHOK/ECHONL echo handling. |
| ~~**No job control**~~ | terminal | **Partially resolved.** tcgetpgrp()/tcsetpgrp() are implemented via TIOCGPGRP/TIOCSPGRP. SIGSTOP, SIGTSTP, SIGTTIN, and SIGTTOU have process-wide stop semantics, and SIGCONT resumes regardless of mask or disposition. Terminal background-I/O generation of SIGTTIN/SIGTTOU is not yet implemented. |
| ~~**readdir() "." and ".." entries**~~ | directory | **Resolved.** Kernel now synthesizes "." and ".." entries before host entries. |
| **No ENFILE** | fd | Only per-process EMFILE limit exists. No system-wide fd limit tracking. |
| **node-compat `spawn`/`exec`/`execFile` are real async subprocesses (supported)** | process / node-compat | `child_process.spawn` (and `exec`/`execFile`, layered on it) run as genuine async subprocesses over the native POSIX seam added to spidermonkey-node for this (SpiderMonkey shell patch `patches/0022-kandelo-async-subprocess.patch`, delegated through `packages/registry/spidermonkey/node-compat/adapter.js`): `posix_spawn` with `dup2`/`close`/`open`/`chdir` file-actions, non-blocking pipe fds for `stdin`/`stdout`/`stderr` (async `__kandeloFdRead`/`__kandeloFdWrite`/`__kandeloFdClose`), and `__kandeloWaitPid` (`WNOHANG` reap) for exit/signal reporting. `child.pid` is the real kernel pid; `stdin`/`stdout`/`stderr` are genuine Node-shaped streams — `stdin.end()` closes the write end of the pipe, which delivers real EOF to the child. This is what dissolves the historical deadlock where a child shelled out via the old synchronous path blocked forever on `read(0)` with no way to observe end-of-input. `'exit'(code, signal)`/`'close'` fire from the real reaped exit status (`'close'` waits for both the reaped exit and every opened `stdout`/`stderr` stream to reach EOF), and `child.kill(sig)` sends a real signal through `__kandeloKill`. The full `stdio` matrix is supported per fd index: `'pipe'` (default), `'ignore'` (opens `/dev/null`), `'inherit'` (`dup2` from the parent's fd), and an explicit integer fd. `options.cwd` is honored via a `chdir` file-action the child executes before `exec`. `options.shell` execs `/bin/sh -c <command and args joined with a space>` (Node's own shell-quoting caveats apply — arguments are not individually quoted). A `posix_spawn` failure surfaces asynchronously as an `'error'` event, never a silent hang, matching Node's own async-error contract. This same native poll loop also fixed real-delay `setTimeout`/`setInterval`, which previously never fired on spidermonkey-node (the timer-drain function existed but had no caller); both now fire on real host-clock delay. **Boundaries:** `options.detached` and the `setsid`/`setpgroup` bits it sets in `posix_spawnattr` are transported to the kernel but not behaviorally implemented — the child spawns as an ordinary child in the caller's session/process group, not a new session/process-group leader (`crates/runtime-core/src/spawn.rs:219` parses the attribute flag bits; the process table does not yet act on `SETSID`/`SETPGROUP`). This is a tracked `runtime-core` gap, not specific to node-compat. Likewise `options.uid`/`options.gid` are accepted but not applied to the spawned child. `spawnSync`/`execSync`/`execFileSync` remain the old synchronous `popen()`-based implementation — see the row below; graduating them to the same seam is a follow-up. |
| **node-compat `spawnSync`/`execSync`/`execFileSync` always shell via `popen()`** | process / node-compat | The spidermonkey-node package's node-compat shim (`packages/registry/node-compat/bootstrap.js`) implements `child_process.spawnSync`/`execSync`/`execFileSync` by building a shell command line and running it through libc `popen()`, so every call requires `/bin/sh` on the target rootfs and cannot exec an argv array directly. `spawnSync` also ignores the caller's `encoding` option and always returns `Buffer`s. Child stderr is discarded (redirected to `/dev/null`) unless the caller passes `stdio: 'inherit'` (or an array with `stdio[2] === 'inherit'`), in which case it is not captured into `result.stderr` (always `''`) but is let through to the real process stderr instead. Surfaced by the `bun-run` bootstrap (`runtime/bun-run/bun-run.js`), which needs `stdio: 'inherit'` to let `bun-extract`'s own diagnostics reach the user. The async `spawn`/`exec`/`execFile` above no longer share this limitation. |
| **spidermonkey-node interactive-runtime gaps for a full `claude` session** | tty / process / crypto | Surfaced while porting the Claude Code CLI to run via `bun-run` on spidermonkey-node: (1) `process.stdin.setRawMode()` is a no-op — the node-compat adapter (`packages/registry/spidermonkey/node-compat/adapter.js`) forwards to a `native.setRawMode` shell hook that the SpiderMonkey build never defines, so raw-mode terminal input for an interactive TUI is not yet wired; (2) the `tls`/`https` egress path used for the CLI's outbound API calls has not been proven under a long-lived keep-alive loop; (3) `crypto.randomBytes()`/`Math.random()`-backed helpers in node-compat are not a CSPRNG (plain `Math.random()`), which is unsuitable for anything security-sensitive. None of these block the one-shot `--version`/non-interactive `bun-run` path validated in `host/test/claude-run-native-guest.test.ts`, but all three are open gaps for a full interactive `claude` session. |
| **spidermonkey-node `require()` of an ES module (supported)** | node-compat / esm | `require()` (and `import.meta.require` / the Bun `__breq` cross-chunk helper) of an ES module is supported on spidermonkey-node. When the resolved target is an ES module (a `.mjs` file, or a `.js`/extensionless file whose nearest `package.json` has `"type":"module"`, and not a `.cjs` file), the node-compat require loader (`packages/registry/node-compat/bootstrap.js`) routes it to the native `_nodeNative.__kandeloRequireModule(path)` C seam (SpiderMonkey shell `ModuleLoader::requireModuleNamespace`, `patches/0018-kandelo-require-module.patch`) instead of CommonJS-wrapping it (which would throw `import declarations may only appear at top level of a module`). The module is loaded, linked, and evaluated through the shell module registry, so `require`, static `import`, and dynamic `import()` of the same resolved path share one module instance and namespace. `require()` returns that namespace (named exports as properties, the default export as `.default`). **Boundary:** a required ES module with a pending *top-level await* cannot complete synchronously, so `require()` of it throws an `Error` whose `.code` is `ERR_REQUIRE_ASYNC_MODULE` (matching Node); load it with dynamic `import()` instead. A synchronous evaluation rejection is rethrown to the caller. **Cyclic `require(esm)`:** when the required ES module is *still evaluating* because it was re-entered through a dependency cycle (module A `require`s B, B `require`s A while A is mid-evaluation), the seam returns that module's *partial live namespace* instead of re-evaluating it (which would make the engine throw `module record has unexpected status: Evaluating`) — matching Node's circular `require(esm)`. The namespace is a live binding view: every exported name is present from link time, an export that has not run its initializer yet reads as a temporal-dead-zone `ReferenceError`, and the same key returns the value once the module runs that initializer (the binding fills in live through the same object, it is not a point-in-time copy). A module reached via a cycle while its *top-level await is still settling* (`EvaluatingAsync`) cannot complete synchronously and therefore throws `ERR_REQUIRE_ASYNC_MODULE`, the same boundary as a direct `require()` of a pending-TLA module. |
| **spidermonkey-node `vm` module with real context isolation (supported)** | node-compat / vm | The node-compat `vm` module (`packages/registry/node-compat/bootstrap.js`) is a faithful implementation of Node's `vm` surface — `createContext`, `isContext`, `runInContext`, `runInNewContext`, `runInThisContext`, `Script` (with `runInContext`/`runInNewContext`/`runInThisContext`), and `compileFunction` — backed by a C seam in the SpiderMonkey shell (`patches/0020-kandelo-vm-context.patch`, delegated through `packages/registry/spidermonkey/node-compat/adapter.js`). `createContext(sandbox)` builds a genuinely isolated realm/global (a fresh compartment and zone) whose property operations delegate to the user's sandbox: a *new* global binding created by run code writes through to the sandbox on first assignment, deletions delete through, and enumeration enumerates through. **Context identity (divergence from Node):** `createContext` returns a *distinct* contextified global, not the sandbox object itself, and builds a fresh isolated context on each call (it does not contextify the sandbox in place). Consequently `isContext(theOriginalSandbox)` is `false` (pass the returned context to `runInContext`), and `createContext` is not idempotent-by-sandbox. Node instead contextifies the sandbox in place; Kandelo's fresh-context-per-call is behaviorally equivalent for the create-then-run flow but observably different if code inspects the sandbox's own context identity. `codeGeneration:{strings:false}` (and `{wasm:false}`) is honored per-context — `eval`/`new Function` (or WebAssembly compilation) inside such a context throw `EvalError`, while every other realm's `eval` is unaffected — enforced by a per-realm content-security-policy check installed with `JS_SetSecurityCallbacks` (existing callbacks preserved). Values and thrown errors are marshaled across the realm boundary, so `runInContext("throw new Error('x')", ctx)` rethrows to the caller, and a single compiled `vm.Script` runs in multiple contexts (compiled once to a realm-independent Stencil, instantiated per context). **Boundary — copy-on-first-access reads:** ESR 140's `JSClassOps` has no per-property get/set interceptors (removed upstream), so the read side is served by the realm's `resolve` hook, which fires once per not-yet-seen name and copies the sandbox value onto the context global. Seeding a sandbox and reading results back works exactly, but an *external* mutation of a sandbox property made *after* the context has already read that same property is not re-observed by the context (the global's own copy shadows the sandbox from then on). **The write side has the same boundary:** a *new* global binding writes through on its first assignment (via the `addProperty` hook), but *reassigning* an already-materialized property — one previously seeded-and-read or previously created by run code — does not propagate back to the sandbox, because the removed set interceptor means the update lands only on the context global's own copy. Delete-through and enumerate-through *are* fully live (their hooks fire on every operation). Fully-live per-access reads and writes would require a Proxy-backed global, which this seam intentionally does not use. **Unthreaded options:** `filename` and `lineOffset` are honored; `columnOffset` and `displayErrors` are accepted but not threaded through (they affect only error column numbers / decoration), and `compileFunction`'s `contextExtensions` is ignored. **Boundary — `timeout` unsupported:** the engine's interrupt-callback machinery is not wired, so `runInContext`/`Script`/`compileFunction` throw `"vm timeout is not supported on spidermonkey-node"` if an `options.timeout` is supplied rather than silently ignoring it. |
| **node-compat builtin exports that link but throw when called** | node-compat | The node-compat shim (`packages/registry/node-compat/bootstrap.js`) now exports 40 additional Node builtin names that the Claude Code CLI's extracted ESM app imports, so that its module graph links (a named import of a name a module doesn't export fails at ESM link time even if the name is never called). Most are real implementations (e.g. `os.availableParallelism`, `util.stripVTControlCharacters`, `crypto.timingSafeEqual`, `zlib.deflate`/`inflate`, `dns.promises.lookup`, `path/posix`). The remainder are honest stubs that link but throw `"<mod>.<name> is not implemented on spidermonkey-node"` if actually called: `fs.fsyncSync`/`fs.ftruncateSync` (no `fsync`/`ftruncate` primitive in the `qjs:os` native module), `fs/promises.link`/`lutimes`/`opendir`/`statfs`, `crypto.randomFillSync`/`createCipheriv`/`createDecipheriv`/`createPrivateKey`/`createPublicKey`/`generateKeyPairSync`/`sign`/`verify`, `zlib.inflateRawSync`, and `tls.createSecureContext` (zstd decompression is now real — see the zstd rows below). Two constructable stubs (`net.BlockList`, `crypto.X509Certificate`) link and construct as no-ops/throw-on-construct rather than throwing at call time, since npm/CLI code commonly does `new BlockList()` at module scope. Phase B graduates whichever of these the app actually calls at runtime to a real implementation. |
| **`bun-run` loader-class dispatch in `require()` (supported)** | node-compat / bun-run | Bun's standalone-executable format records a *loader class* per embedded module (`js`, `text`, `file`, `json`, `napi`, …) in its module-graph metadata, because file extension alone cannot disambiguate — a `.js`/`.mjs` path can legitimately carry any of these classes depending on how the original bundle imported it. `bun-extract --prepare` (M2 Phase I/J, `runtime/bun-extract`) records this per-file class into `cache/manifest.json`'s `loaders` map (`js` and `unknown` omitted, since they are `require()`'s existing default behavior). `bun-run.js` (`runtime/bun-run/bun-run.js`) reads that map after extraction and installs `globalThis.__kandeloAssetLoaders`, keyed by *absolute cache path* (`<cache-dir>/<relpath>`). The node-compat `require()` loader (`packages/registry/node-compat/bootstrap.js`) consults this map — keyed by the same realpath'd `resolved` path `require()` already computes — **before** shebang-stripping, the `.json`-extension check, and the ESM/CJS dispatch, so the recorded loader byte is authoritative over any extension-based guess: `text` returns the *raw, pre-shebang-strip* file contents as a string (a `.txt`/`.md` asset may legitimately start with `#!`, which is not a shebang to strip), `file` returns the absolute on-disk path (never reads/executes the contents), `json` returns `JSON.parse(source)` (same result `require()` already gives a `.json` file, made explicit for a non-`.json`-named module recorded with this class), and `js` behaves exactly as unmapped `require()` always has (falls through to shebang-strip + ESM/CJS dispatch). With no manifest present (an old cache, or a binary extracted before Task 1), `__kandeloAssetLoaders` is never installed and `require()` is behaviorally unchanged. **Boundary — static `import` of a non-JS asset is not covered:** this dispatch only wires `require()` (and the paths that call it: `import.meta.require`, the Bun `__breq` cross-chunk helper). The extracted Claude Code app loads its non-JS embedded assets exclusively via `require()`/`__breq()`, never via a static `import` statement, so this is a documented boundary of the current surface, not an observed live gap. **Boundary — `.node` native addons (`napi` class) are an honest throw:** `require()` of a module recorded as `napi` throws `"<id>: native Node addons (.node) are not supported on spidermonkey-node"` rather than silently returning an empty/broken exports object. Real N-API support is deferred future work that needs a wasm-side N-API ABI plus the in-Kandelo C/C++ toolchain (see the clang-toolchain plan) to compile `.node` addons for this target; there is no faked or partial addon loading today. Verified end-to-end: `require()` of a `.md` text asset, a `file`-class asset, an unmapped `.cjs` module, and a `napi`-class asset all dispatch correctly in `host/test/esm-probe-guest.test.ts`; the `json` class is behaviorally identical to the already-tested `.json`-extension `require()` path and is not separately exercised by the fixture. Headless `claude -p` advances past the `loopAutonomousPreamble.md` `SyntaxError` that this Phase closes. |

#### node-compat (spidermonkey-node) — stubbed & approximated Node core surface (tracked future work)

This is the single, complete inventory of Node core APIs the node-compat
shim (`packages/registry/node-compat/bootstrap.js`, plus the
`packages/registry/spidermonkey/node-compat/adapter.js` native bridge) does
**not** yet implement faithfully. Every entry is future work to graduate to a
real implementation. Entries are grouped by *honesty class*, which is what the
platform-values contract cares about most:

- **Fail-loud** — link-time present, throws a clear
  `"<mod>.<name> is not implemented on spidermonkey-node"` when actually
  called. Never silently wrong; safe to ship as a boundary.
- **Silent** — returns a plausible value without doing the real work. These
  can be *quietly wrong* and are the priority to graduate. Each is called out
  so it is a visible boundary, not a hidden one.
- **Approximate** — partially real; correct for the paths exercised today but
  not a full implementation.

**Fail-loud throwing stubs** (present for ESM link-time completeness, throw on call):

| API | Note |
|-----|------|
| `fs.fsyncSync`, `fs.ftruncateSync` | no `fsync`/`ftruncate` primitive in the `qjs:os` native module |
| `fs/promises.link`, `.lutimes`, `.opendir`, `.statfs` | no kernel/native primitive wired |
| `crypto.randomFillSync`, `.createCipheriv`, `.createDecipheriv`, `.createPrivateKey`, `.createPublicKey`, `.generateKeyPairSync`, `.sign`, `.verify` | no libcrypto cipher/asymmetric-key surface wired |
| `crypto.X509Certificate` | constructable stub — throws on `new` (links so module-scope imports succeed) |
| `tls.createSecureContext` | no secure-context/cert-chain surface |
| `zlib.inflateRawSync` | raw-inflate window not wired |
| `zlib.zstdCompressSync`, `zlib.createZstdCompress` | zstd **compression** is not wired — the native backend links the decode-only libzstd amalgamation (`packages/registry/libzstd`), which omits the compressor. Decompression (`zlib.zstdDecompressSync`/`createZstdDecompress`, `Bun.zstdDecompressSync`/`zstdDecompress`) is real; see the supported-zstd row below. |
| `zlib` Brotli — `zlib.brotliCompressSync`/`brotliDecompressSync` throw on call; `zlib.createBrotliCompress`/`createBrotliDecompress` return a stream that **constructs but errors on the first byte of data** | There is no Brotli codec in the native backend (patch 0012 wires libz only, no libbrotli), so real Brotli is not implemented. `zlib.constants` still exposes the real `BROTLI_*` numeric values so module-init that reads them works. **Full real Brotli is deferred future work:** add a Brotli codec (link libbrotli into the SpiderMonkey C build, or bundle a JS/wasm decoder) for `Content-Encoding: br` HTTP response decompression. Verified that headless `claude -p` reads `zlib.constants` and constructs decompressors but does not feed the Brotli stream (no `br` response on the default Anthropic-API path), so the fail-loud stub unblocks it; a real `br` response would surface a stream `error` rather than silently wrong bytes. gzip/deflate/`createUnzip` are real. |
| `zlib.zstdDecompressSync`, `zlib.createZstdDecompress`, `Bun.zstdDecompressSync`, `Bun.zstdDecompress` — **real zstd decompression** | The native backend links libzstd's decode-only single-file amalgamation (`packages/registry/libzstd`, zstd 1.5.6, mirroring how patch 0012 links libz) and exposes it through the SpiderMonkey shell native `__kandeloZstdDecompress` (patch 0021). The seam handles both explicit-content-size frames (`ZSTD_getFrameContentSize` + `ZSTD_decompress`) and unknown-size frames (streaming `ZSTD_createDStream`/`ZSTD_decompressStream`), and **fails loud** — a truncated or corrupt frame throws `"zstd decompression failed: <ZSTD_getErrorName>"` rather than returning partial bytes. `createZstdDecompress` is a real Transform over the seam. **Compression is intentionally not implemented** (the decode-only amalgamation omits the compressor); see the `zlib.zstdCompressSync` row above. Verified that headless `claude -p` decompresses its embedded zstd-compressed text assets through this path — before Phase I it aborted init with `Error: embedded text asset is missing or corrupt`. |
| `ws` (the WebSocket npm package, provided by node-compat because Bun ships it natively and Bun-bundled apps mark it external) | The module resolves and the `WebSocket` class exists (static ready-state constants, `instanceof`, subclassing, and `require`/`import` all work at module scope), but **constructing a live `WebSocket`/`WebSocketServer` or calling `createWebSocketStream` throws** `"ws (...) is not implemented on spidermonkey-node"`. **Full real `ws` is deferred future work:** a real WebSocket client (and eventually server) over the platform's TCP/TLS with `permessage-deflate`. Depends on the outbound TLS keep-alive egress path and a CSPRNG for `Sec-WebSocket-Key` (see the silent-approximations table and the interactive-runtime row). Verified that headless `claude -p` imports `ws` but never opens a socket, so the throwing stub unblocks it without faking WebSocket behavior. |

**Silent approximations** (return a plausible value without the real work — graduate first):

| API | Behavior today | Risk if relied on |
|-----|----------------|-------------------|
| `crypto.randomBytes`, `.randomUUID`, `.randomInt`, `.randomFill*` | backed by `Math.random()`, **not a CSPRNG** | security-sensitive: predictable randomness for keys/tokens/nonces |
| `tls.checkServerIdentity` | returns `undefined` (always "valid") | no hostname/identity verification on TLS peers |
| `net.BlockList` | no-op class; `.check()` always returns `false` (never blocked) | address allow/deny lists silently ineffective |
| `net.Server` | stub — spidermonkey-node ships client sockets only (no `listen()`) | inbound/listening sockets don't work |
| `perf_hooks.monitorEventLoopDelay` | inert histogram; all percentiles/min/max/mean/stddev return `0` | event-loop-delay metrics are fake zeros |
| `os.getPriority` / `os.setPriority` | returns `0` / no-op | scheduling niceness not reflected |
| `os.version` | returns `''` | empty kernel-version string |
| `diagnostics_channel` | inert channels; `publish`/`subscribe`/`tracingChannel` are no-ops (`hasSubscribers:false`) | tracing/diagnostics hooks never fire |
| `events.setMaxListeners` | no-op for the process-wide default | max-listeners warning cannot be tuned globally |
| WHATWG `fetch` / `Headers` / `Request` / `Response` / `ReadableStream` | see the fetch section below — reserved globals with a real impl where wired; unwired surface is inert | HTTP paths that hit inert surface fail or no-op |

**Approximate implementations** (partially real):

| API | Behavior today | Gap |
|-----|----------------|-----|
| `path/win32` (subpath) and `path.win32` | resolves to `{...path.posix, sep: '\\'}` — only `sep`/`delimiter` differ; `join`/`resolve`/`parse`/`normalize` still use POSIX `/` | not real Windows-path semantics. Fine today because Claude Code imports `path/win32` in cross-platform code that only *calls* it under `process.platform === 'win32'` / `O() === 'windows'` guards, which are false on Kandelo (`process.platform` is `linux`). Would need real win32 semantics only if a feature parsed Windows paths regardless of host OS. |
| `child_process.spawnSync` / `execSync` / `execFileSync` | synchronous, shell out through libc `popen()` (needs `/bin/sh`), `pid: 0`, no stdin, no streaming, ignores `encoding` (always `Buffer`), stderr discarded unless `stdio: 'inherit'` | see the dedicated row above; async `spawn`/`exec`/`execFile` are real subprocesses (see the supported row above) — only the `*Sync` variants remain on `popen()` |
| `process.stdin.setRawMode` | forwards to a `native.setRawMode` shell hook the SpiderMonkey build does not define → effectively a no-op | see the interactive-runtime row above; raw-mode TTY input not wired |
| `tls`/`https` egress | works for one-shot requests; not proven under a long-lived keep-alive loop | see the interactive-runtime row above |

The `crypto` CSPRNG, `setRawMode`, and `tls`/`https` keep-alive items are also
described in the **spidermonkey-node interactive-runtime gaps** row above; they
are repeated here so this inventory is complete on its own.

### Wasm-Inherent — Gaps that cannot be fully resolved in Wasm

| Gap | Subsystem | Reason |
|-----|-----------|--------|
| **mprotect() is a no-op** | memory | Returns success but does not enforce. Wasm linear memory has no page-level protection. |
| **No immediate cross-process shared-memory or futex semantics** | memory | Anonymous, SysV, and stable-identity regular-file shared mappings now merge and refresh across processes at syscall boundaries. They are not one physical linear memory: direct stores remain private until a syscall, a peer spinning only on loads sees no update, and futex WAIT/WAKE targets only the caller's process `SharedArrayBuffer`. Process-shared pthread locks and PHP opcache's normal shared-memory locking model therefore remain unsupported. The PHP package rejects its normal SHM mode and supports only explicitly configured `opcache.file_cache_only=1`; otherwise FPM workers would observe divergent cache and lock state. memfd `MAP_SHARED`, Linux `SIGBUS` on access beyond EOF, and detection of external host writes also remain gaps. |
| **External raw UDP routes** | socket | AF_INET SOCK_DGRAM has POSIX-style in-kernel loopback/virtual semantics, but browsers cannot expose raw UDP and Node raw UDP is not yet wired behind HostIO. Non-loopback UDP routes currently return ENETUNREACH unless a future host backend/proxy handles them. |
| **Stop is cooperative at a Wasm boundary** | process / signals | The kernel records stopped state immediately and the shared host withholds every exact channel completion until SIGCONT. This suspends code at syscall boundaries in both Node and browser, but a process executing CPU-bound Wasm without reaching a syscall cannot be stopped at an arbitrary instruction by current WebAssembly execution APIs. |
| **Permission checks** | filesystem | Delegated to host. Kernel does not independently verify file permissions. |
| **getrusage() zeroed** | sysinfo | No actual resource tracking available in Wasm. Returns zero-filled struct. |
| **ucontext API unsupported** | process | `makecontext()`, `swapcontext()`, `getcontext()`, `setcontext()` are userspace stack-switching primitives. Supporting them would require `wasm-fork-instrument`-style compile-time instrumentation extended to general stack-switching for every program that uses them — we already do this narrowly for `fork()` (see [fork-instrumentation.md](fork-instrumentation.md) and `plans/2026-04-20-fork-instrumentation-design.md`), but generalising the same machinery to ucontext multiplies the instrumentation surface for a feature **deprecated in POSIX.1-2008** and effectively unused in modern code. Programs needing coroutines implement their own at the runtime level (Erlang/BEAM, Ruby fibers, Python `greenlet`). |

### Future Work — Remaining items

**Threading:**
- `clone()` — CLONE_VM|CLONE_THREAD: the Rust `ProcessTable` allocates the TID from its global PID/TID sequence, and the host spawns a thread Worker sharing the parent's Memory. TLS initialization via `__wasm_thread_init` export.
- `gettid()` — returns actual TID for threads, pid for main thread
- `set_tid_address()` — stores tidptr; kernel writes 0 + futex-wakes on thread exit (CLONE_CHILD_CLEARTID)
- `futex()` — WAIT/WAKE/REQUEUE/CMP_REQUEUE/WAKE_OP are implemented within one process; cross-process waits/wakes remain unsupported even over a coordinated shared mapping
- `pthread_create` — works via clone(). Basic pthreads tested (mutex, join). Normal thread return, `pthread_exit`, and cancellation cleanup are per-thread; uncaught fatal Wasm traps in a pthread worker are process-fatal and visible to parent `waitpid()` as signal termination. Cancellation remains limited; see the Wasm-inherent gaps below.

**File descriptors:**
- `close_range()` — this Linux extension is not exposed by Kandelo's target libc/syscall surface (`sdk/config.site` reports it unavailable). It is implementable as future Rust-kernel work rather than a Wasm-inherent limitation. Lock-aware cleanup already covers `close`, dup replacement, close-on-exec, and process teardown; there is no hidden host-side bulk-close path.

**Hard / Architectural:**
- Immediate cross-process MAP_SHARED visibility and process-shared futexes (would require one addressable shared backing or an equivalent wake protocol across process workers)
- True async poll/select (replace polling loop with host-based event notification)
- Full VMIN/VTIME raw mode semantics (timer-based timeout)
- Canonical one-record-per-read behavior, empty-line VEOF events, and VWERASE word editing

**Shared-kernel advantages (already free):**
- Kernel-owned `O_APPEND` atomicity (serialized syscalls); host-backed append
  additionally requires an exact backend outcome
- PIPE_BUF atomicity (serialized syscalls)
- Cross-process pipe/socket/PTY and eventfd/timerfd/signalfd/memfd/procfs backing identity across inherited descriptors
- Signal delivery across processes is direct

---

## Environment-Specific Tradeoffs

Some POSIX APIs have different implementation strategies depending on the host environment. This section documents those tradeoffs.

### SharedArrayBuffer Required

These features require SharedArrayBuffer (and cross-origin isolation headers in browsers):

| Feature | With SAB | Without SAB |
|---------|----------|-------------|
| Blocking syscalls | `Atomics.wait()` — true blocking | Not supported without a worker/blocking bridge |
| `fcntl()` locking | Lock state and range semantics are Rust-owned; SAB is used only by the generic syscall channel when a blocking request parks | A native host can consume the kernel's generic advisory-lock wake event; no lock-specific JavaScript store is required |
| `pipe()` / named-FIFO blocking operation | Blocks worker until data or a FIFO peer is available | Not supported without a worker/blocking bridge |
| `nanosleep()` | `Atomics.wait()` with timeout | Not supported without a worker/blocking bridge |
| Multi-process shared memory | Host-coordinated merge/import at syscall boundaries; not direct shared pages or cross-process futexes | Not supported without the worker/channel SAB runtime |

### Browser vs Node.js

| Feature | Node.js | Browser |
|---------|---------|---------|
| File I/O | Native `fs` module for data and creation modes; VFS-only post-creation mode/ownership metadata | OPFS (limited), fetch (read-only), or virtual FS |
| `fork()` | `worker_threads` — feasible | Web Workers — feasible but different API |
| `Atomics.wait()` on main thread | Works | Throws — must use workers |
| Network sockets | TCP via `net` backend plus in-kernel/virtual UDP; raw external UDP not yet wired behind HostIO | Local virtual TCP/UDP works between browser Kandelo machines; external networking still requires WebSocket/WebRTC/proxy backends because browsers expose no raw sockets |
| Process signals | `process.on('SIGINT', ...)` | Not available |
| stdin | `process.stdin` | Requires custom input mechanism |

---

## Implementation Priority

1. **Phase 1 (Complete):** File descriptors & basic I/O — open, close, read, write, lseek, dup, dup2, pipe, fstat, fcntl (flags)
2. **Phase 2 (Complete):** Directory operations — stat, lstat, mkdir, rmdir, unlink, link, symlink, readlink, rename, chmod, chown, access, opendir, readdir, closedir, chdir, getcwd
3. **Phase 3a (Complete):** Process identity & lifecycle — getpid, getppid, getuid/geteuid, getgid/getegid, exit/_exit
3b. **Phase 3b (Deferred):** Multi-process — fork, exec, waitpid (requires multi-worker architecture)
4. **Phase 4 (Complete):** Signals — kill, raise, sigaction, sigprocmask. Signal delivery mechanism deferred.
5. **Phase 5 (Complete):** fcntl locking — F_GETLK, F_SETLK, F_SETLKW with byte-range granularity
6. **Phase 6 (Complete):** Sockets & I/O multiplexing — socket, socketpair, shutdown, send/recv, getsockopt/setsockopt, poll, epoll. AF_INET TCP via host-backed networking (Node `net` and browser local virtual network). AF_INET UDP is partial: in-kernel loopback/local virtual datagrams are implemented; external raw UDP remains a HostIO/backend task.
7. **Phase 7 (Complete):** Time, TTY, environment — clock_gettime, nanosleep, isatty, getenv/setenv/unsetenv
8. **Phase 8 (Complete):** Memory management — mmap (anonymous), munmap, brk, mprotect (stub)
9. **Phase 9 (Complete):** Polish & gaps — tcgetattr/tcsetattr, ioctl (TIOCGWINSZ/TIOCSWINSZ), signal(), fcntl F_GETOWN/F_SETOWN, MSG_PEEK, O_NONBLOCK pipe enforcement, O_NOFOLLOW, time/gettimeofday/usleep/openat wrappers
10. **Phase 10 (Complete):** Extended POSIX — umask, uname, sysconf, dup3, pipe2, ftruncate, fsync, writev, readv, getrlimit, setrlimit
11. **Phase 11 (Complete):** Final gaps — truncate, fdatasync, fchmod, fchown, getpgrp, setpgid, getsid, setsid, fstatat, unlinkat, mkdirat, renameat
12. **Phase 12 (Complete):** Remaining tractable — faccessat, fchmodat, fchownat, linkat, symlinkat, readlinkat, select, setuid/setgid/seteuid/setegid, getrusage
13a. **Phase 13a (Complete):** Multi-Worker Infrastructure
- ProcessManager with process table and worker lifecycle
- WorkerAdapter abstraction (Node.js worker_threads + mock)
- Worker entry point: kernel initialization in worker thread
- Message protocol for host ↔ worker communication
13b. **Phase 13b (Complete):** Fork & Waitpid
- Binary fork state serialization/deserialization (Rust)
- `kernel_fork_process(parent, caller_tid, mode)` validates the calling task
  and ABI 43 fork mode, allocates the child identity, and copies its state; the
  caller-selected `kernel_init_from_fork(..., child_pid)` constructor was
  removed in ABI 42
- ProcessManager.fork() with state transfer to child worker
- ProcessManager.waitpid() with WNOHANG support
13c. **Phase 13c (Complete):** Cross-Process Pipes
- SharedPipeBuffer class (SharedArrayBuffer ring buffer with atomics)
- Host-delegated pipe support in kernel (host_handle >= 0 routes to host_read/host_write)
- kernel_convert_pipe_to_host Wasm export
- Pipe detection and conversion on fork via ProcessManager
13d. **Phase 13d (Complete):** Cross-Process Signals
- Centralized kernel-owned target resolution, pending queues, and permission checks
- Exact `(pid, tid)` dequeue at the host boundary; the host wakes channels but does not own signal state
- Obsolete host-side `DeliverSignalMessage` / `ProcessManager.deliverSignal()` authority removed in ABI 42
13e. **Phase 13e (historical milestone complete; current conformance remains Partial):** Exec
- In-place centralized exec: CLOEXEC filtering, signal disposition reset, pending-queue preservation
- Obsolete targetless/pathname-authority exports are removed. ABI 43 exec uses only centralized `kernel_exec_target_prepare` / `kernel_exec_target_size` / `kernel_exec_target_read` / `kernel_exec_target_cancel` and final retained-target `kernel_exec_commit` operations.
- host_exec Wasm import and sys_execve syscall
- Worker re-initialization against the continuing centralized kernel Process
- ProcessManager.exec() for host-initiated exec
14. **POSIX Compliance Batch 4 (Complete):** ~20 syscalls — tkill, sigpending, getpgid, setreuid/setregid, sysinfo, times, lchown, waitid, plus glue-only stubs
15. **POSIX Compliance Batch 5 (Complete):** ~100+ syscalls
- **Critical fix:** setitimer/getitimer (fixes musl's alarm() which internally calls setitimer)
- **Kernel syscalls:** rt_sigtimedwait, preadv/pwritev, sendfile, statx
- **Scheduler stubs:** sched_getparam/setparam/getscheduler/setscheduler/priorities/affinity (9 syscalls)
- **File I/O extensions:** preadv2/pwritev2, fallocate, copy_file_range, splice/tee/vmsplice, readahead
- **Filesystem stubs:** sync/syncfs, chroot, mount/umount2, mknod/mknodat, renameat2, faccessat2/fchmodat2
- **Time stubs:** clock_settime, settimeofday, adjtimex, utimes/futimesat
- **Process stubs:** fork/vfork/clone (ENOSYS), execve/execveat, personality, unshare/setns
- **Event stubs:** eventfd2, signalfd4, timerfd_*, inotify_*, fanotify_*
- **IPC stubs:** SysV msg/sem/shm (12), POSIX mq (6), ipc multiplexer
- **Extended attributes:** 12 xattr syscalls (all ENOSYS)
- **Remaining:** memfd_create, membarrier, getcpu, splice/tee, POSIX timers, capget/capset, and more

---

## PHP-WASM / WordPress Playground Gap Analysis

Target use case: hosting PHP-WASM (as used by WordPress Playground) on this kernel, replacing Emscripten's POSIX emulation layer. This section tracks what's needed and what's missing.

### Phase A — Foundational (makes kernel viable as a PHP POSIX layer)

| Gap | Subsystem | Description | Difficulty |
|-----|-----------|-------------|------------|
| ~~`flock()` syscall~~ | file locking | **Done.** Uses the Rust advisory manager with OFD-style ownership, so dup/fork share ownership and final close releases it. LOCK_SH, LOCK_EX, LOCK_UN, and LOCK_NB are supported; shared/exclusive conversion follows the non-atomic BSD/Linux rule by dropping the old mode before attempting the new one, preventing mutually upgrading shared holders from retaining a deadlocking lock. | ~~Medium~~ |
| ~~`/dev/urandom` virtual device~~ | VFS | **Done.** `/dev/urandom` and `/dev/random` intercept in kernel, delegate to `host_getrandom()` → `crypto.getRandomValues()`. | ~~Easy~~ |
| ~~`getrandom()` syscall~~ | random | **Done.** Host-delegated to `crypto.getRandomValues()`. | ~~Easy~~ |
| ~~`putenv()` syscall~~ | environment | **Done.** Parses `KEY=VALUE` string, delegates to setenv. | ~~Easy~~ |
| ~~Virtual device files in VFS~~ | VFS | **Done.** `/dev/null`, `/dev/zero`, `/dev/urandom`, `/dev/full`, `/dev/fd/N`, `/dev/stdin`, `/dev/stdout`, `/dev/stderr` all handled in-kernel. | ~~Medium~~ |
| ~~`initgroups()` stub~~ | process | **Done.** musl's `initgroups()` calls the root-only, atomic complete-list `setgroups()` implementation. | ~~Easy~~ |

### Phase B — Networking (enables WordPress HTTP requests + MySQL)

| Gap | Subsystem | Description | Difficulty |
|-----|-----------|-------------|------------|
| ~~`connect()` for AF_INET~~ | socket | **Done.** Host-delegated TCP networking. bind/listen/accept/connect/send/recv all functional. Node.js backend uses `net` module; browser backend uses fetch for HTTP. | ~~Hard~~ |
| ~~`getaddrinfo()` / `gethostbyname()`~~ | DNS | **Done.** Host-delegated via `host_getaddrinfo` import. Returns AF_INET sockaddr_in. `/etc/hosts` is served from the canonical `rootfs.vfs` mount at `/` for localhost resolution. | ~~Medium~~ |
| ~~`setsockopt()` expansion~~ | socket | **Done.** SO_KEEPALIVE, TCP_NODELAY, SO_REUSEADDR, disabled SO_LINGER state, and many more are represented; enabled SO_LINGER remains explicitly unsupported. | ~~Easy~~ |
| ~~Async socket polling bridge~~ | socket | **Done.** poll/select/epoll all work with socket fds. The kernel checks readiness inline. | ~~Medium~~ |

### Phase C — Process management (enables wp-cli, Composer, PHPUnit)

| Gap | Subsystem | Description | Difficulty |
|-----|-----------|-------------|------------|
| ~~Guest-initiated `fork()`~~ | process | **Done.** fork() works as a kernel syscall. Children re-execute from `_start` with forked state. Cross-process pipes and signals functional. | ~~Hard~~ |
| ~~**Guest-initiated `exec()`**~~ | process | **Done.** exec() wired as SYS_EXECVE (syscall 211). Host `handleExec` reads path/argv/envp from process memory, calls `onExec` callback. Fork+exec tested. | ~~Hard~~ |
| ~~Blocking pipe reads with timeout~~ | pipe | **Done.** Pipes support blocking reads/writes with EINTR on signal delivery. O_NONBLOCK returns EAGAIN. | ~~Medium~~ |

### Phase D — Browser persistence + PHP compilation

| Gap | Subsystem | Description | Difficulty |
|-----|-----------|-------------|------------|
| **OPFS filesystem backend** | VFS | Origin Private File System for browser persistence across page loads. WordPress needs this for wp-content, uploads, database. | Medium |
| **PHP compiled with clang → wasm32 + this musl sysroot** | toolchain | Replace Emscripten compilation with direct clang targeting. Requires new minimal PHP SAPI replacing Emscripten's `EM_JS`/`EM_ASYNC_JS` integration. | Very Hard |
| **Emscripten SAPI replacement** | toolchain | PHP-WASM uses a ~2000-line custom C SAPI (`php_wasm.c`) tightly coupled to Emscripten. Would need a new SAPI using this kernel's syscall interface. | Very Hard |

### Architectural Decision: Async/Blocking Bridge

PHP is synchronous but the browser host is async. Two approaches:

| Approach | Pros | Cons |
|----------|------|------|
| **SAB + `Atomics.wait()`** (current) | True blocking, no stack transform overhead, works reliably in Workers | Cannot block browser main thread; PHP must run in Web Worker |
| **JSPI or promise-driven bridge** | Could work on main thread in future designs | Requires a different host/runtime contract and does not cover fork continuation |

The `Atomics.wait()` approach is architecturally superior but requires PHP to run in a Web Worker, which is different from current Playground architecture.

### Already Covered for PHP-WASM

These PHP needs are well-handled by the current kernel:
- File I/O: open, close, read, write, lseek, fstat, stat, lstat, ftruncate, fsync
- Directory ops: opendir, readdir, closedir, mkdir, rmdir, rename, unlink
- FD manipulation: dup, dup2, dup3, pipe, pipe2, fcntl (with locking)
- Process identity: getpid, getppid, getuid/geteuid, getgid/getegid, setsid
- Signals: sigaction, sigprocmask, kill, signal, alarm
- Time: clock_gettime, gettimeofday, nanosleep, usleep
- Terminal: isatty, tcgetattr/tcsetattr, ioctl
- Environment: getenv, setenv, unsetenv
- Memory: anonymous mmap, munmap, brk
- Multi-process: fork (kernel syscall), exec (host-initiated), waitpid (kernel syscall)
- Networking: AF_INET TCP (connect, bind, listen, accept, send, recv), getaddrinfo
- Dynamic linking: dlopen (including the main-program handle), dlsym (including
  RTLD_DEFAULT), dlclose, dlerror (Wasm dylink on the process worker) for both
  wasm32 and wasm64 processes. The wasm64 path uses memory64 pointer globals,
  GOT entries, and table64 indices without narrowing them to JavaScript
  numbers at the Wasm boundary. `DT_NEEDED`, `RTLD_LOCAL`/`RTLD_GLOBAL`,
  dependency/provider lifetimes, nested loader transactions, pthread
  `dlopen`/`dlsym`, and fork after dynamic loading use a process archive plus a
  fresh local linker replica in each Worker. ABI 43 libc stages
  prepare/initialization so a host import never calls back into Wasm before
  returning; constructors and relocation helpers run as ordinary
  Wasm-to-Wasm calls. Instrumentation removes native start sections from
  accepted ABI 43 modules and lowers the historical canonical two-, four-, and
  five-argument `env.__wasm_dlopen` forms to that same staged path while
  preserving direct, table, export, and `ref.func` aliases. The earliest
  two-argument form retains its deterministic historical buffer-derived module
  name. ABI 43 publication and launch guards reject a remaining monolithic
  import or native start section in a completed instrumented artifact; source
  start sections remain supported through the explicit module bootstrap.
  Loader-owned VFS/mapping completions leave caught signals pending, and libc
  performs an ordinary signal-delivery checkpoint after each staged import
  returns and after `dlclose`. RTLD_NEXT lookup is not currently supported.
- POSIX timers: `SIGEV_SIGNAL`, `SIGEV_NONE`, and `SIGEV_THREAD` timer creation,
  timer_settime, timer_gettime, overrun reporting, and deletion. Timer timing
  remains host-scheduled at millisecond granularity. Direct wasm64
  notifications preserve the complete native `union sigval`.
- System info: uname, sysconf, umask, getrlimit/setrlimit

---

## Continuous Testing: musl libc-test Suite

The full musl libc-test suite (functional + regression + math) is run via `scripts/run-libc-tests.sh`. Use `--report` to generate `docs/libc-test-failures.md`.

### Summary (as of 2026-04-04)

All tests pass (0 unexpected failures). XFAIL (expected failures) and TIME (timeouts) are acceptable. Run `scripts/run-libc-tests.sh` for current results.

### Known Unfixable Failures

These require features fundamentally unavailable in the Wasm architecture:

- **Wasm FP exceptions (110 math tests):** WebAssembly has no floating-point exception flags (`fenv.h`). All `fe*` math tests fail. `long double` variants pass because they use software fp128.
- **No pthread_cancel:** Wasm has no async cancellation mechanism or cancel-point assembly. `pthread_create` works; `pthread_cancel` does not.
- **No musl DTV expansion for arbitrary DSOs:** `tls_get_new-dtv_dso` requires
  native-style per-thread dynamic TLS-vector growth. Kandelo can replay the
  fixed TLS reservation of a Wasm side module across process `fork`, but that
  does not implement musl's general pthread DTV contract.

### Linker Requirements for Signal Handlers

Programs must be linked with two extra flags for signal handler dispatch to work:

- `--table-base=3`: Reserves function table indices 0 (SIG_DFL), 1 (SIG_IGN), and 2 (`__main_void` wrapper) so they don't collide with real C function pointers.
- `--export-table`: Exports `__indirect_function_table` so the host can look up handler functions to call them.

### C++ exception support

C++ programs that throw exceptions work end-to-end (commit `9482326ef`).
Itanium-EH unwinding uses LLVM `libunwind` statically bundled into
`libc++abi.a` via the libcxx package (`packages/registry/libcxx/`,
`LIBCXXABI_USE_LLVM_UNWINDER` + `LIBCXXABI_STATICALLY_LINK_UNWINDER_IN_STATIC_LIBRARY`),
so consumers link `-lc++ -lc++abi` and `_Unwind_*` resolves internally —
no separate `-lunwind`. clang must be invoked with `-fwasm-exceptions`;
without it catch handlers are dead-code-eliminated and `throw` hangs.

Regression gate: `programs/cpp_throw_test.cpp` exercises throw → catch
in a single program; `host/test/cpp-throw-test.test.ts` runs it via the
kernel harness. The gap was first surfaced by the SpiderMonkey EH
spike (see external `memory/spidermonkey-spike-eh-toolchain-gap.md`).
