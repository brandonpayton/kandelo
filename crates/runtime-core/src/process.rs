extern crate alloc;

use alloc::vec::Vec;
use core::ops::Deref;
use wasm_posix_shared::{
    platform_limits, process_metadata_contract, Errno, KernelRusage, WasmStat,
    WasmStatfs,
};

use crate::credentials::Credentials;
use crate::exec_target::PreparedExecLedger;
use crate::fd::FdTable;
use crate::memory::MemoryManager;
use crate::ofd::{FileType, OfdTable};
use crate::pipe::PipeBuffer;
use crate::signal::{PerThreadSignalState, SignalState};
use crate::socket::SocketTable;
use crate::terminal::TerminalState;

/// A handle to an open directory stream for readdir iteration.
pub struct DirStream {
    pub host_handle: i64,
    pub path: Vec<u8>, // resolved directory path (for rewinddir)
    pub position: u64, // entry counter (for telldir/seekdir)
    /// Synthetic "." / ".." state: 0 = emit ".", 1 = emit "..", 2 = host entries
    pub synth_dot_state: u8,
}

/// Result of one backing-owned append operation.
///
/// `end` is captured while the backing still owns the EOF serialization
/// boundary. Callers must not reconstruct it from a separate stat.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct HostAppendOutcome {
    pub written: usize,
    pub end: u64,
}

/// Trait for host I/O operations that the kernel delegates to the runtime.
pub trait HostIO {
    fn host_open(&mut self, path: &[u8], flags: u32, mode: u32) -> Result<i64, Errno>;
    fn host_close(&mut self, handle: i64) -> Result<(), Errno>;
    fn host_read(&mut self, handle: i64, buf: &mut [u8]) -> Result<usize, Errno>;
    fn host_write(&mut self, handle: i64, buf: &[u8]) -> Result<usize, Errno>;
    fn host_append(
        &mut self,
        _handle: i64,
        _buf: &[u8],
        _limit: Option<u64>,
    ) -> Result<HostAppendOutcome, Errno> {
        // Append must remain one host operation. Emulating it with seek/write
        // would lose atomicity at the backing-filesystem boundary.
        Err(Errno::ENOSYS)
    }
    fn host_pread(&mut self, _handle: i64, _buf: &mut [u8], _offset: i64) -> Result<usize, Errno> {
        // Positioned I/O must be one host operation. A default seek/read/seek
        // implementation would race another user of the shared host cursor.
        Err(Errno::ENOSYS)
    }
    /// Read up to `buf.len()` bytes at `offset` from a content byte-leaf named by
    /// `blob_id`. This is the narrow byte-provider seam for the in-kernel rootfs
    /// overlay (Phase 5 Increment 2): the kernel owns the `/` tree and asks the
    /// host only for a base file's immutable bytes, addressed by a manifest-
    /// assigned blob id rather than a mutable path or a shared-cursor handle.
    /// Returns the number of bytes read (0 at EOF). Defaults to unsupported so
    /// mock hosts and hosts predating the overlay compile unchanged.
    fn blob_read(&mut self, _blob_id: u64, _buf: &mut [u8], _offset: u64) -> Result<usize, Errno> {
        Err(Errno::ENOSYS)
    }
    /// Read up to `buf.len()` bytes at `offset` from the raw byte store backing
    /// lazy-archive member `archive_id`. This is the narrow raw-archive
    /// transport seam for the in-kernel rootfs overlay's `LazyMember` nodes
    /// (Phase 5 Increment 3b-wiring.2): the host is only a byte store for the
    /// whole archive blob, addressed by a manifest-assigned `archive_id`; the
    /// kernel decodes the archive format (zip) and owns member extraction.
    /// Returns the number of bytes read (0 at EOF). Defaults to unsupported so
    /// mock hosts and hosts predating lazy-archive support compile unchanged.
    fn fetch_archive(&mut self, _archive_id: u32, _buf: &mut [u8], _offset: u64) -> Result<usize, Errno> {
        Err(Errno::ENOSYS)
    }
    fn host_pwrite(&mut self, _handle: i64, _buf: &[u8], _offset: i64) -> Result<usize, Errno> {
        // See host_pread: unsupported is truthful; cursor emulation is not.
        Err(Errno::ENOSYS)
    }
    fn host_seek(&mut self, handle: i64, offset: i64, whence: u32) -> Result<i64, Errno>;
    fn host_fstat(&mut self, handle: i64) -> Result<WasmStat, Errno>;
    fn host_stat(&mut self, path: &[u8]) -> Result<WasmStat, Errno>;
    fn host_lstat(&mut self, path: &[u8]) -> Result<WasmStat, Errno>;
    fn host_statfs(&mut self, _path: &[u8]) -> Result<WasmStatfs, Errno> {
        Err(Errno::ENOSYS)
    }
    /// Query filesystem policy through an already-open exact host object.
    /// Pathname lookup is not an acceptable fallback for retained authority.
    fn host_fstatfs(&mut self, _handle: i64) -> Result<WasmStatfs, Errno> {
        Err(Errno::ENOSYS)
    }
    fn host_pathconf(&mut self, _path: &[u8], _name: i32) -> Result<Option<i64>, Errno> {
        Err(Errno::ENOSYS)
    }
    fn host_fpathconf(&mut self, _handle: i64, _name: i32) -> Result<Option<i64>, Errno> {
        Err(Errno::ENOSYS)
    }
    fn host_mkdir(&mut self, path: &[u8], mode: u32) -> Result<(), Errno>;
    fn host_rmdir(&mut self, path: &[u8]) -> Result<(), Errno>;
    fn host_unlink(&mut self, path: &[u8]) -> Result<(), Errno>;
    fn host_rename(&mut self, oldpath: &[u8], newpath: &[u8]) -> Result<(), Errno>;
    fn host_link(&mut self, oldpath: &[u8], newpath: &[u8]) -> Result<(), Errno>;
    fn host_symlink(&mut self, target: &[u8], linkpath: &[u8]) -> Result<(), Errno>;
    fn host_readlink(&mut self, path: &[u8], buf: &mut [u8]) -> Result<usize, Errno>;
    fn host_chmod(&mut self, path: &[u8], mode: u32) -> Result<(), Errno>;
    fn host_chown(&mut self, path: &[u8], uid: u32, gid: u32) -> Result<(), Errno>;
    fn host_lchown(&mut self, _path: &[u8], _uid: u32, _gid: u32) -> Result<(), Errno> {
        Err(Errno::ENOSYS)
    }
    fn host_access(&mut self, path: &[u8], amode: u32) -> Result<(), Errno>;
    fn host_opendir(&mut self, path: &[u8]) -> Result<i64, Errno>;
    /// Read and consume the next directory entry.
    ///
    /// An error must leave the iterator at the same entry. The kernel may
    /// return a short successful getdents64 result after earlier records were
    /// copied, then retry this host operation on the next syscall.
    fn host_readdir(
        &mut self,
        handle: i64,
        name_buf: &mut [u8],
    ) -> Result<Option<(u64, u32, usize)>, Errno>;
    fn host_closedir(&mut self, handle: i64) -> Result<(), Errno>;
    fn host_clock_gettime(&mut self, clock_id: u32) -> Result<(i64, i64), Errno>;
    fn host_nanosleep(&mut self, seconds: i64, nanoseconds: i64) -> Result<(), Errno>;
    fn host_ftruncate(&mut self, handle: i64, length: i64) -> Result<(), Errno>;
    fn host_fsync(&mut self, handle: i64) -> Result<(), Errno>;
    fn host_fchmod(&mut self, handle: i64, mode: u32) -> Result<(), Errno>;
    fn host_fchown(&mut self, handle: i64, uid: u32, gid: u32) -> Result<(), Errno>;
    fn host_set_alarm(&mut self, seconds: u32) -> Result<(), Errno>;
    /// Arm/disarm a POSIX timer on the host.
    /// `timer_id` is the per-process timer slot index.
    /// `signo` is the signal to deliver on expiry.
    /// `value_ms` is the initial delay in milliseconds (0 = disarm).
    /// `interval_ms` is the repeat interval in milliseconds (0 = one-shot).
    fn host_set_posix_timer(
        &mut self,
        timer_id: i32,
        signo: i32,
        value_ms: i64,
        interval_ms: i64,
    ) -> Result<(), Errno>;
    /// Block until a signal is delivered. Returns the signal number.
    fn host_sigsuspend_wait(&mut self) -> Result<u32, Errno>;
    /// Ask the host to invoke a user-space signal handler.
    /// `handler_index` is the Wasm function table index.
    /// `signum` is the signal number being delivered.
    /// `sa_flags` is the sigaction flags (SA_SIGINFO, SA_RESTART, etc.)
    /// When SA_SIGINFO is set, the host should call handler(signum, siginfo_ptr, 0)
    /// instead of handler(signum).
    fn host_call_signal_handler(
        &mut self,
        handler_index: u32,
        signum: u32,
        sa_flags: u32,
    ) -> Result<(), Errno>;
    fn host_getrandom(&mut self, buf: &mut [u8]) -> Result<usize, Errno>;
    fn host_utimensat(
        &mut self,
        path: &[u8],
        atime_sec: i64,
        atime_nsec: i64,
        mtime_sec: i64,
        mtime_nsec: i64,
    ) -> Result<(), Errno>;
    fn host_waitpid(&mut self, pid: i32, options: u32) -> Result<(i32, i32), Errno>;
    fn host_net_connect(&mut self, handle: i32, addr: &[u8], port: u16) -> Result<(), Errno>;
    /// Query the status of a host-delegated connect that was previously
    /// kicked off via `host_net_connect`. Returns `Ok(())` once the TCP
    /// handshake completed successfully, `Err(EAGAIN)` while still pending,
    /// and `Err(<other>)` if the connect failed (e.g., ECONNREFUSED).
    fn host_net_connect_status(&mut self, handle: i32) -> Result<(), Errno>;
    fn host_net_send(&mut self, handle: i32, data: &[u8], flags: u32) -> Result<usize, Errno>;
    fn host_net_recv(
        &mut self,
        handle: i32,
        len: u32,
        flags: u32,
        buf: &mut [u8],
    ) -> Result<usize, Errno>;
    fn host_net_poll(&mut self, handle: i32, events: i16) -> Result<i16, Errno> {
        let _ = handle;
        Ok(events)
    }
    fn host_net_close(&mut self, handle: i32) -> Result<(), Errno>;
    /// Notify the host that an AF_INET socket is now listening, so the host
    /// can open a real TCP server on the given port.
    fn host_net_listen(&mut self, fd: i32, port: u16, addr: &[u8; 4]) -> Result<(), Errno>;
    fn host_udp_bind(&mut self, handle: i32, addr: &[u8; 4], port: u16) -> Result<(), Errno> {
        let _ = (handle, addr, port);
        Ok(())
    }
    fn host_udp_unbind(&mut self, handle: i32) -> Result<(), Errno> {
        let _ = handle;
        Ok(())
    }
    fn host_udp_send(
        &mut self,
        src_addr: &[u8; 4],
        src_port: u16,
        dst_addr: &[u8; 4],
        dst_port: u16,
        data: &[u8],
    ) -> Result<usize, Errno> {
        let _ = (src_addr, src_port, dst_addr, dst_port, data);
        Err(Errno::ENETUNREACH)
    }
    fn host_getaddrinfo(&mut self, name: &[u8], result: &mut [u8]) -> Result<usize, Errno>;
    /// The machine's real assigned IPv4 address, for the kernel-owned
    /// network-interface `ioctl`s (`SIOCGIFADDR`, `SIOCGIFCONF`) to report on
    /// the one non-loopback virtual interface. `None` means the host has no
    /// address configured (yet) or does not model one at all — hosts that
    /// don't track network configuration (e.g. `host-native`'s headless
    /// conformance target) keep this default.
    fn host_network_local_address(&mut self) -> Option<[u8; 4]> {
        None
    }
    /// Futex wait: block if `*addr == expected`, with optional timeout in nanoseconds.
    /// timeout_ns < 0 means infinite wait.
    /// Returns 0 on wake, negative errno on error.
    fn host_futex_wait(
        &mut self,
        addr: usize,
        expected: u32,
        timeout_ns: i64,
    ) -> Result<i32, Errno>;
    /// Futex wake: wake up to `count` waiters on addr. Returns number woken.
    fn host_futex_wake(&mut self, addr: usize, count: u32) -> Result<i32, Errno>;
    /// Notify the host that process `pid` has mapped its `/dev/fb0`
    /// framebuffer at `[addr, addr+len)` within its wasm `Memory`. The host
    /// should mirror that byte range to whatever display surface it owns.
    /// `fmt` is reserved for future format negotiation; currently always
    /// BGRA32 (0).
    fn bind_framebuffer(
        &mut self,
        pid: i32,
        addr: usize,
        len: usize,
        w: u32,
        h: u32,
        stride: u32,
        fmt: u32,
    );
    /// Notify the host that the framebuffer for `pid` is gone (`munmap`,
    /// process exit, or exec). Idempotent: calling unbind on a pid with no
    /// binding is a no-op.
    fn unbind_framebuffer(&mut self, pid: i32);
    /// Push pixel bytes to the host's framebuffer surface for `pid` at
    /// byte `offset`. Used by software (e.g. fbDOOM) that issues
    /// `write(fd_fb, …)` rather than mmap-and-store. The host owns the
    /// pixel buffer in this mode; the kernel has no `FbBinding.addr` to
    /// copy into. Geometry/format come from a prior `bind_framebuffer`
    /// call with `addr=0, len=0` (the sentinel "write-based binding").
    fn fb_write(&mut self, pid: i32, offset: usize, bytes: &[u8]);
    // --- DRI v2 buffer-sharing surface (renderD128 GBM) -----------------
    //
    // Default impls return `-ENOSYS as i32` / no-op so existing test
    // mocks need no boilerplate. Concrete production hosts (Node +
    // Browser) override these with their wasm-import bindings.

    /// Allocate host-side SAB backing for a freshly-created bo. Called
    /// once per `DRM_IOCTL_MODE_CREATE_DUMB`. Returns ≥ 0 on success,
    /// negative errno on failure.
    #[allow(unused_variables)]
    fn gbm_bo_create(
        &mut self,
        pid: i32,
        bo_id: u32,
        size: u64,
        width: u32,
        height: u32,
        stride: u32,
    ) -> i32 {
        -(Errno::ENOSYS as i32)
    }

    /// Free host-side SAB backing for a bo whose refcount has reached
    /// zero. Idempotent: calling on an unknown `bo_id` is a no-op.
    #[allow(unused_variables)]
    fn gbm_bo_destroy(&mut self, pid: i32, bo_id: u32) {}

    /// Bind a bo's SAB slice into a process's wasm `Memory` at `addr`
    /// for `len` bytes. Called from the mmap path once
    /// `mmap_anonymous` has reserved the wasm pages. After this
    /// returns, writes to `[addr, addr+len)` go directly to the SAB.
    /// Returns 0 on success, negative errno on failure.
    #[allow(unused_variables)]
    fn gbm_bo_bind(&mut self, pid: i32, bo_id: u32, addr: usize, len: usize) -> i32 {
        -(Errno::ENOSYS as i32)
    }

    /// Unbind a prior `gbm_bo_bind` — called from munmap /
    /// process-exit before the wasm pages are returned to the
    /// anonymous pool.
    #[allow(unused_variables)]
    fn gbm_bo_unbind(&mut self, pid: i32, bo_id: u32, addr: usize, len: usize) {}

    /// Notify the host that process `pid` has mapped its GL cmdbuf at the
    /// given offset within its wasm `Memory`. Length is always
    /// `shared::gl::CMDBUF_LEN` in v1.
    #[allow(unused_variables)]
    fn gl_bind(&mut self, pid: i32, addr: usize, len: usize) {}

    /// Notify the host that the GL cmdbuf for `pid` is gone (`munmap`,
    /// process exit, or exec). Idempotent.
    #[allow(unused_variables)]
    fn gl_unbind(&mut self, pid: i32) {}

    /// Allocate a host-side WebGL context. `ctx_id` is the per-fd id chosen
    /// by the kernel; `attrs` is a marshalled `shared::gl::GlContextAttrs`.
    #[allow(unused_variables)]
    fn gl_create_context(&mut self, pid: i32, ctx_id: u32, attrs: &[u8]) {}

    #[allow(unused_variables)]
    fn gl_destroy_context(&mut self, pid: i32, ctx_id: u32) {}

    /// Allocate a host-side surface (default canvas or pbuffer). `attrs`
    /// is a marshalled `shared::gl::GlSurfaceAttrs`.
    #[allow(unused_variables)]
    fn gl_create_surface(&mut self, pid: i32, surface_id: u32, attrs: &[u8]) {}

    #[allow(unused_variables)]
    fn gl_destroy_surface(&mut self, pid: i32, surface_id: u32) {}

    /// Bind ctx + surface as the current rendering target for `pid`.
    #[allow(unused_variables)]
    fn gl_make_current(&mut self, pid: i32, ctx_id: u32, surface_id: u32) {}

    /// Decode and dispatch one cmdbuf submit. `offset` / `length` are
    /// within the bound cmdbuf region (validated by the kernel against
    /// `shared::gl::CMDBUF_LEN`). Returns 0 on success, or a negative
    /// errno when the host rejects the command stream or cannot dispatch it.
    #[allow(unused_variables)]
    fn gl_submit(&mut self, pid: i32, offset: usize, length: usize) -> i32 {
        0
    }

    /// Flush any pending GL work and signal "frame ready". v1 no-op
    /// (canvas presents on the next RAF); kept as a hook for future
    /// fence/sync work.
    #[allow(unused_variables)]
    fn gl_present(&mut self, pid: i32) {}

    /// Synchronous GL query (`glGetError`, `glReadPixels`, etc.).
    /// Returns bytes written into `out`, or negative errno on failure.
    #[allow(unused_variables)]
    fn gl_query(&mut self, pid: i32, op: u32, input: &[u8], out: &mut [u8]) -> i32 {
        -(Errno::ENOSYS as i32)
    }

    #[allow(unused_variables)]
    fn kms_set_master(&mut self, pid: i32) {}

    #[allow(unused_variables)]
    fn kms_drop_master(&mut self, pid: i32) {}

    #[allow(unused_variables)]
    fn proc_write_bytes(&mut self, pid: i32, addr: u32, src: &[u8]) -> i32 {
        0
    }

    /// Copy `dst.len()` bytes from the wasm process at `pid`'s linear
    /// memory at `addr` into the kernel-side scratch `dst`. Returns 0 on
    /// success, negative errno on failure.
    #[allow(unused_variables)]
    fn proc_read_bytes(&mut self, pid: i32, addr: u32, dst: &mut [u8]) -> i32 {
        0
    }

    #[allow(unused_variables)]
    fn kms_mode_info(&mut self, connector_id: u32) -> wasm_posix_shared::dri::WpkDrmModeModeinfo {
        wasm_posix_shared::dri::WpkDrmModeModeinfo::default()
    }

    #[allow(unused_variables)]
    fn kms_addfb(
        &mut self,
        pid: i32,
        fb_id: u32,
        bo_id: u32,
        width: u32,
        height: u32,
        pixel_format: u32,
        pitch: u32,
    ) -> i32 {
        0
    }

    #[allow(unused_variables)]
    fn kms_rmfb(&mut self, pid: i32, fb_id: u32) {}

    #[allow(unused_variables)]
    fn kms_set_fb(&mut self, pid: i32, crtc_id: u32, fb_id: u32) {}
}

/// Process lifecycle state.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProcessState {
    Running,
    /// Execution is suspended by a default job-control stop action. The
    /// process remains alive, owns all of its resources, and stays visible in
    /// procfs until SIGCONT resumes it or a terminating signal exits it.
    Stopped,
    Exited,
    /// Reaped process-group leader retained only as a pgid/session identity
    /// placeholder while live or zombie members remain in the group.
    Limbo,
}

/// The latest parent-observable child status record.
///
/// POSIX gives each process at most one status-information record: generating
/// a new status replaces an older unconsumed record. The record stays on the
/// child whose state changed, where WNOWAIT can repeatedly peek it and an
/// ordinary matching wait can consume it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ChildWaitEvent {
    /// One of `wait::EVENT_{EXITED,STOPPED,CONTINUED}`.
    pub event_mask: u32,
    /// Traditional waitpid/wait4 status encoding.
    pub wait_status: i32,
    /// `CLD_*` code for waitid's siginfo_t.
    pub si_code: i32,
    /// Exit code or signal number for waitid's si_status.
    pub si_status: i32,
    /// Real uid of the child when the event occurred.
    pub child_uid: u32,
    /// Architecture-neutral kernel/host resource-usage wire snapshot.
    pub rusage: KernelRusage,
}

/// Per-process binding tracking the live mmap of `/dev/fb0`.
///
/// The pixel buffer lives inside the process's wasm `Memory`. The host
/// reads it directly via a typed-array view over the same SharedArrayBuffer.
#[derive(Debug, Clone, Copy)]
pub struct FbBinding {
    /// Offset within the process's wasm `Memory` where the pixel buffer
    /// starts. Address-style usize so it survives wasm32 / wasm64.
    pub addr: usize,
    /// Length in bytes (`smem_len`).
    pub len: usize,
    pub w: u32,
    pub h: u32,
    pub stride: u32,
    /// Pixel format tag (reserved; currently always 0 = BGRA32).
    pub fmt: u32,
}

/// Per-process binding tracking the live mmap of a DRI buffer object.
///
/// Recorded by `sys_mmap` on a `/dev/dri/{card0,renderD128}` fd whose
/// `MODE_MAP_DUMB` offset decodes to `bo_id`. `sys_munmap` consults
/// this list so it can call [`HostIO::gbm_bo_unbind`] before the wasm
/// pages are returned to the anonymous pool.
#[derive(Debug, Clone, Copy)]
pub struct DriBoBinding {
    /// Start address in the process's wasm `Memory`.
    pub addr: usize,
    /// Length in bytes (aligned to wasm page).
    pub len: usize,
    /// Bo currently bound at `[addr, addr+len)`.
    pub bo_id: crate::dri::BoId,
}

/// Kernel-owned identity for one System V shared-memory attachment.
///
/// The host retains byte-coherence snapshots because it owns guest Memory,
/// but attachment identity and lifetime belong to the process table.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ShmMapping {
    pub addr: usize,
    pub shmid: i32,
    pub size: usize,
}

/// Exact Rust-owned timer identities whose platform handles must be retired.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostTimerCleanup {
    pub cancel_alarm: bool,
    pub posix_timer_ids: Vec<u32>,
}

const MAX_SYSV_SHM_MAPPINGS_PER_PROCESS: usize = 4096;

/// Read-only identity of a thread owned by [`crate::process_table::ProcessTable`].
///
/// [`ThreadInfo`] dereferences to this view so existing `thread.tid` reads stay
/// ergonomic. It deliberately does not implement `DerefMut`: only the process
/// table may assign a TID.
///
/// ```compile_fail
/// use kandelo_kernel::process::ThreadInfo;
/// fn rewrite_tid(thread: &mut ThreadInfo) {
///     thread.tid = 999;
/// }
/// ```
#[doc(hidden)]
#[derive(Debug)]
pub struct ThreadIdentity {
    pub tid: u32,
    state: ThreadState,
}

impl Deref for ThreadIdentity {
    type Target = ThreadState;

    fn deref(&self) -> &Self::Target {
        &self.state
    }
}

/// Mutable non-identity state for a retained thread.
#[derive(Debug, Clone)]
pub struct ThreadState {
    pub ctid_ptr: usize, // CLONE_CHILD_CLEARTID address (futex wake on exit)
    pub stack_ptr: usize,
    pub tls_ptr: usize,
    pub tidptr: usize, // set_tid_address pointer
    /// Per-thread signal state: directed-pending set + blocked mask + RT queue.
    /// Handlers remain process-wide and live on [`Process::signals`].
    pub signals: PerThreadSignalState,
}

/// A kernel-owned thread identity paired with its mutable non-identity state.
///
/// Identity-bearing records cannot be duplicated into detached owned values:
///
/// ```compile_fail
/// use kandelo_kernel::process::ThreadInfo;
/// fn duplicate(thread: &ThreadInfo) -> ThreadInfo {
///     ThreadInfo::clone(thread)
/// }
/// ```
#[derive(Debug)]
pub struct ThreadInfo {
    identity: ThreadIdentity,
}

impl Deref for ThreadInfo {
    type Target = ThreadIdentity;

    fn deref(&self) -> &Self::Target {
        &self.identity
    }
}

impl ThreadInfo {
    fn new_inner(tid: u32, ctid_ptr: usize, stack_ptr: usize, tls_ptr: usize) -> Self {
        ThreadInfo {
            identity: ThreadIdentity {
                tid,
                state: ThreadState {
                    ctid_ptr,
                    stack_ptr,
                    tls_ptr,
                    tidptr: 0,
                    signals: PerThreadSignalState::new(),
                },
            },
        }
    }

    fn state_mut(&mut self) -> &mut ThreadState {
        &mut self.identity.state
    }

    #[cfg(test)]
    pub fn state_mut_for_test(&mut self) -> &mut ThreadState {
        self.state_mut()
    }

    fn into_state(self) -> ThreadState {
        self.identity.state
    }

    /// Construct a thread record by consuming an identity allocated by
    /// `ProcessTable`.
    fn new_allocated(
        task_id: crate::process_table::AllocatedTaskId,
        ctid_ptr: usize,
        stack_ptr: usize,
        tls_ptr: usize,
    ) -> Self {
        let tid = task_id.into_raw();
        Self::new_inner(tid, ctid_ptr, stack_ptr, tls_ptr)
    }

    /// Construct an isolated thread fixture with a caller-selected TID.
    #[cfg(test)]
    pub fn new(tid: u32, ctid_ptr: usize, stack_ptr: usize, tls_ptr: usize) -> Self {
        Self::new_inner(tid, ctid_ptr, stack_ptr, tls_ptr)
    }
}

/// Per-eventfd state: a u64 counter with optional semaphore semantics.
#[derive(Debug, Clone)]
pub struct EventFdState {
    pub counter: u64,
    pub semaphore: bool,
}

/// An entry in an epoll interest list.
#[derive(Debug, Clone)]
pub struct EpollInterest {
    pub fd: i32,
    pub events: u32,
    pub data: u64,
}

/// An epoll instance: a set of monitored file descriptors.
#[derive(Debug, Clone)]
pub struct EpollInstance {
    pub interests: Vec<EpollInterest>,
}

impl EpollInstance {
    pub fn new() -> Self {
        EpollInstance {
            interests: Vec::new(),
        }
    }
}

/// Per-timerfd state: clock, interval, and next expiration.
#[derive(Debug, Clone)]
pub struct TimerFdState {
    pub clock_id: u32,
    /// Interval for repeating timers (0 = one-shot).
    pub interval_sec: i64,
    pub interval_nsec: i64,
    /// Next expiration time (absolute, in the timer's clock).
    /// 0/0 = disarmed.
    pub value_sec: i64,
    pub value_nsec: i64,
    /// Number of expirations not yet read.
    pub expirations: u64,
}

/// POSIX timer (timer_create / timer_settime).
#[derive(Debug, Clone)]
pub struct PosixTimerState {
    pub clock_id: u32,
    pub sigev_signo: u32,
    /// Raw `union sigval` bits, zero-extended when supplied by wasm32.
    pub sigev_value_bits: u64,
    /// Kernel-facing notification mode (`SIGEV_SIGNAL`, `SIGEV_NONE`, or
    /// Linux's `SIGEV_THREAD_ID`). musl implements POSIX `SIGEV_THREAD` by
    /// creating a helper pthread and asking the kernel to target that TID.
    pub sigev_notify: u32,
    /// Target thread for `SIGEV_THREAD_ID`; zero for process-wide modes.
    pub sigev_tid: u32,
    /// Interval for repeating timers (0 = one-shot).
    pub interval_sec: i64,
    pub interval_nsec: i64,
    /// Next expiration value (relative, for host-side setTimeout).
    /// 0/0 = disarmed.
    pub value_sec: i64,
    pub value_nsec: i64,
    /// True while this timer owns a queued notification not yet accepted.
    pub notification_pending: bool,
    /// Expirations accumulated while the current notification is pending.
    pub overrun_current: i32,
    /// Overrun count associated with the most recently accepted notification.
    pub overrun_last: i32,
}

/// Normalize the guest sigevent notification into the signal number passed to
/// the host timer. SIGEV_NONE uses zero internally; SIGEV_SIGNAL must name a
/// real signal so it cannot silently become a no-notification timer.
const SIGEV_SIGNAL: u32 = 0;
const SIGEV_NONE: u32 = 1;
const SIGEV_THREAD_ID: u32 = 4;

pub fn normalize_posix_timer_signo(
    sigev_notify: u32,
    sigev_signo: u32,
) -> Result<u32, Errno> {
    match sigev_notify {
        SIGEV_NONE => Ok(0),
        SIGEV_SIGNAL if (1..=64).contains(&sigev_signo) => Ok(sigev_signo),
        SIGEV_THREAD_ID if (1..=64).contains(&sigev_signo) => Ok(sigev_signo),
        _ => Err(Errno::EINVAL),
    }
}

#[cfg(test)]
#[test]
fn posix_timer_notification_validates_and_normalizes_signals() {
    assert_eq!(normalize_posix_timer_signo(SIGEV_NONE, 14).unwrap(), 0);
    assert_eq!(normalize_posix_timer_signo(SIGEV_SIGNAL, 1).unwrap(), 1);
    assert_eq!(normalize_posix_timer_signo(SIGEV_SIGNAL, 64).unwrap(), 64);
    assert!(normalize_posix_timer_signo(SIGEV_SIGNAL, 0).is_err());
    assert!(normalize_posix_timer_signo(SIGEV_SIGNAL, 65).is_err());
    assert_eq!(
        normalize_posix_timer_signo(SIGEV_THREAD_ID, 14).unwrap(),
        14
    );
    assert!(normalize_posix_timer_signo(SIGEV_THREAD_ID, 0).is_err());
}

/// Per-signalfd state: the set of signals to watch.
#[derive(Debug, Clone)]
pub struct SignalFdState {
    pub mask: u64,
}

/// File descriptor action to apply in a fork child before exec.
#[derive(Debug, Clone)]
pub enum FdAction {
    Dup2 {
        old_fd: i32,
        new_fd: i32,
    },
    Close {
        fd: i32,
    },
    Open {
        fd: i32,
        path: Vec<u8>,
        flags: i32,
        mode: i32,
    },
}

/// Read-only identity and task-membership view of a [`Process`].
///
/// `Process` dereferences to this type so callers can inspect `process.pid` and
/// `process.threads`, but the absence of `DerefMut` prevents them from
/// rewriting the PID or injecting/remapping thread identities.
///
/// ```compile_fail
/// use kandelo_kernel::process::Process;
/// fn rewrite_pid(process: &mut Process) {
///     process.pid = 999;
/// }
/// ```
///
/// ```compile_fail
/// use kandelo_kernel::process::{Process, ThreadInfo};
/// fn inject_thread(process: &mut Process, thread: ThreadInfo) {
///     process.threads.push(thread);
/// }
/// ```
///
/// Production callers also cannot construct a process with a selected PID:
///
/// ```compile_fail
/// use kandelo_kernel::process::Process;
/// let _ = Process::new(999);
/// ```
#[doc(hidden)]
pub struct ProcessIdentity {
    pub pid: u32,
    pub threads: Vec<ThreadInfo>,
}

/// Per-process kernel state: file descriptor table, OFD table, pipes, cwd, and directory streams.
pub struct Process {
    identity: ProcessIdentity,
    pub ppid: u32,
    credentials: Credentials,
    /// Kernel-owned secure-startup fact for the current process image.
    ///
    /// Task 9 only preserves this marker across process-state transport.
    /// Target-aware exec commit is the sole future authority that may set it.
    pub secure_exec: bool,
    /// Successful image replacements advance this generation exactly once.
    /// Prepared exec targets bind to its current value and cannot survive a
    /// competing commit for the same persistent PID.
    pub exec_generation: u64,
    /// Kernel-owned exact executable-object leases awaiting commit/cancel.
    pub prepared_exec_targets: PreparedExecLedger,
    /// A `posix_spawn` child is a real signal target while its host launch is
    /// pending, but it is not yet part of the parent's waitable child set.
    /// Only the parent-bound spawn publication transaction may clear this.
    pub spawn_publication_pending: bool,
    pub pgid: u32,
    pub sid: u32,
    /// True iff this process is the session leader of its session (i.e. the
    /// process that called `setsid()` or was implicitly made a session
    /// leader by a PTY-creation path). Linux tracks this as an explicit flag
    /// (`task->signal->leader`) rather than `sid == pid`, because a forked
    /// child inherits its parent's sid but is NOT itself a session leader.
    /// POSIX uses this flag (not `sid == pid`) to gate setpgid EPERM checks.
    pub is_session_leader: bool,
    pub state: ProcessState,
    /// Low 8-bit status supplied to `_exit()`/`exit_group()` for a normal
    /// exit. Signal termination is recorded separately in `exit_signal` so
    /// normal statuses 128..=255 remain distinguishable to waiters.
    pub exit_status: i32,
    pub exit_signal: u32,
    /// Latest consumable parent wait status, if any.
    pub wait_event: Option<ChildWaitEvent>,
    pub fd_table: FdTable,
    pub ofd_table: OfdTable,
    /// Exact kernel-owned resources retained across host-driven blocking
    /// retries. Numeric descriptors and IPC ids may be reused while a task is
    /// asleep, so they are never sufficient retry authority by themselves.
    pub blocked_retries: crate::blocked_retry::BlockingRetryState,
    pub pipes: Vec<Option<PipeBuffer>>,
    pub sockets: SocketTable,
    pub cwd: Vec<u8>,
    pub dir_streams: Vec<Option<DirStream>>,
    /// Process-directed pending signals and process-wide dispositions. The
    /// blocked mask remains the main thread's mask for historical ABI reasons.
    pub signals: SignalState,
    /// Signals directed to the main thread. Its blocked mask and sigsuspend
    /// save slot remain in the historical Process fields; this state owns the
    /// directed pending bits and siginfo queue only.
    pub main_thread_signals: PerThreadSignalState,
    pub memory: MemoryManager,
    pub terminal: TerminalState,
    pub environ: Vec<Vec<u8>>,
    pub argv: Vec<Vec<u8>>,
    /// In-progress host replacement, invisible until one token-bound commit
    /// swaps the complete argv/environment pair.
    metadata_replacement: Option<ProcessMetadataReplacement>,
    /// Positive transaction tokens are never reused for this Process.
    next_metadata_replacement_token: u32,
    pub umask: u32,
    /// Scheduling priority nice value (-20 to 19, default 0).
    pub nice: i32,
    pub rlimits: [[u64; 2]; 16], // [soft, hard] pairs for each resource
    pub alarm_deadline_ns: u64,
    pub alarm_interval_ns: u64,
    pub thread_name: [u8; wasm_posix_shared::kernel_scratch_wire::PRCTL_NAME_BYTES as usize],
    /// True if this process is a fork child that should exec on startup.
    pub fork_child: bool,
    /// True while this process borrows its vfork parent's address space.
    ///
    /// This is kernel-internal lifecycle state, not guest-visible fork replay
    /// state. It prevents the borrower from creating another address-space or
    /// pthread owner before successful exec replaces the borrowed image.
    pub vfork_child: bool,
    /// Nested signal-mask-swapping waits owned by the process leader.
    pub mask_waits: Vec<crate::signal::SignalMaskWaitContext>,
    /// Caught-handler bookkeeping for the process leader. Pthreads keep the
    /// same fields in their PerThreadSignalState.
    pub caught_handler_depth: u32,
    pub returned_handler_depths: Vec<u32>,
    /// Path to exec after fork (set by posix_spawn before forking).
    pub fork_exec_path: Option<Vec<u8>>,
    /// Argv for exec after fork.
    pub fork_exec_argv: Option<Vec<Vec<u8>>>,
    /// FD actions to apply before exec in fork child.
    pub fork_fd_actions: Vec<FdAction>,
    /// Next ephemeral port to assign for bind(port=0).
    pub next_ephemeral_port: u16,
    /// Epoll instances owned by this process.
    pub epolls: Vec<Option<EpollInstance>>,
    /// POSIX timers (timer_create / timer_settime).
    pub posix_timers: Vec<Option<PosixTimerState>>,
    /// Alternate signal stack (sigaltstack): ss_sp, ss_flags, ss_size.
    pub alt_stack_sp: u64,
    pub alt_stack_flags: u32,
    pub alt_stack_size: u64,
    /// Number of nested signal handlers running with SA_ONSTACK on alt stack.
    /// When > 0, SS_ONSTACK is set in alt_stack_flags.
    pub alt_stack_depth: u32,
    /// Pipe FD pairs inherited from parent, for replay during fork child
    /// re-execution. Each entry is (read_fd, write_fd). sys_pipe pops
    /// from this list to return the correct FDs when the child re-runs
    /// code before fork(). Empty in non-fork-child processes.
    pub fork_pipe_replay: Vec<(i32, i32)>,
    /// True if this process has called exec (for POSIX setpgid EACCES check).
    pub has_exec: bool,
    /// Live mmap of `/dev/fb0`, if any. `Some` between successful
    /// `mmap` and the matching `munmap`/process-exit/exec.
    pub fb_binding: Option<FbBinding>,
    /// Active mmaps of DRI buffer objects. Each entry pairs a wasm
    /// memory region with the bo currently bound there so `sys_munmap`
    /// can issue the matching [`HostIO::gbm_bo_unbind`].
    pub dri_bindings: Vec<DriBoBinding>,
    /// SysV shared-memory attachments keyed by the process virtual address
    /// returned from `shmat`.
    pub shm_mappings: Vec<ShmMapping>,
    /// Counts how many times this process has called fork() (parent side, on success).
    /// Read-only from outside the kernel via `kernel_get_fork_count`.
    /// Used as a regression guardrail by the spawn test suite to confirm
    /// non-forking spawn doesn't sneak through the fork path.
    pub fork_count: u64,
}

impl Deref for Process {
    type Target = ProcessIdentity;

    fn deref(&self) -> &Self::Target {
        &self.identity
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StdioKind {
    HostPipe,
    HostTerminal,
}

impl StdioKind {
    pub fn from_abi(value: u32) -> Option<Self> {
        match value {
            0 => Some(Self::HostPipe),
            1 => Some(Self::HostTerminal),
            _ => None,
        }
    }

    fn file_type(self) -> FileType {
        match self {
            Self::HostPipe => FileType::Pipe,
            Self::HostTerminal => FileType::CharDevice,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct StdioConfig {
    pub stdin: StdioKind,
    pub stdout: StdioKind,
    pub stderr: StdioKind,
}

impl StdioConfig {
    pub const fn captured() -> Self {
        Self {
            stdin: StdioKind::HostPipe,
            stdout: StdioKind::HostPipe,
            stderr: StdioKind::HostPipe,
        }
    }

    pub const fn terminal() -> Self {
        Self {
            stdin: StdioKind::HostTerminal,
            stdout: StdioKind::HostTerminal,
            stderr: StdioKind::HostTerminal,
        }
    }

    fn kind_for_fd(self, fd: i32) -> StdioKind {
        match fd {
            0 => self.stdin,
            1 => self.stdout,
            2 => self.stderr,
            _ => unreachable!("stdio fd must be 0, 1, or 2"),
        }
    }
}

struct ProcessMetadataReplacement {
    token: u32,
    argv: Vec<Vec<u8>>,
    environment: Vec<Vec<u8>>,
    failed: bool,
}

impl ProcessMetadataReplacement {
    fn entries_mut(
        &mut self,
        kind: u32,
    ) -> Result<(&mut Vec<Vec<u8>>, usize), Errno> {
        match kind {
            process_metadata_contract::KIND_ARGV => Ok((
                &mut self.argv,
                platform_limits::PROCESS_STARTUP_MAX_ARGV_COUNT,
            )),
            process_metadata_contract::KIND_ENVIRONMENT => Ok((
                &mut self.environment,
                platform_limits::PROCESS_STARTUP_MAX_ENVP_COUNT,
            )),
            _ => Err(Errno::EINVAL),
        }
    }

    fn stage_entry_with<F>(
        &mut self,
        kind: u32,
        entry: &[u8],
        allocate: F,
    ) -> Result<(), Errno>
    where
        F: FnOnce(&[u8]) -> Result<Vec<u8>, Errno>,
    {
        if self.failed {
            return Err(Errno::EINVAL);
        }

        let result = (|| {
            if entry.len() > platform_limits::PROCESS_METADATA_ENTRY_MAX_BYTES {
                return Err(Errno::E2BIG);
            }
            let (entries, maximum_entries) = self.entries_mut(kind)?;
            if entries.len() >= maximum_entries {
                return Err(Errno::E2BIG);
            }

            // Allocate the entry and the vector slot before publishing either
            // one into the transaction. A failure therefore leaves the
            // already-staged prefix intact for cancellation and cannot touch
            // the live process metadata.
            let owned = allocate(entry)?;
            entries.try_reserve(1).map_err(|_| Errno::ENOMEM)?;
            entries.push(owned);
            Ok(())
        })();

        // WHY: after any matching stage fails, committing the successfully
        // staged prefix would recreate the partial-replacement bug even if a
        // future host forgot its cancel path.
        if result.is_err() {
            self.failed = true;
        }
        result
    }
}

impl Process {
    /// Create a process for an identity allocated by `ProcessTable`.
    pub fn new_allocated(task_id: crate::process_table::AllocatedTaskId) -> Self {
        Self::new_allocated_with_stdio(task_id, StdioConfig::captured())
    }

    /// Create a process with caller-selected stdio for a `ProcessTable` ID.
    pub fn new_allocated_with_stdio(
        task_id: crate::process_table::AllocatedTaskId,
        stdio: StdioConfig,
    ) -> Self {
        let pid = task_id.into_raw();
        Self::new_inner(pid, Some(stdio))
    }

    /// Create an empty process record for fork-state restoration. The caller
    /// must hold the `ProcessTable` identity capability and install state
    /// before publishing the record.
    pub fn new_allocated_empty(task_id: crate::process_table::AllocatedTaskId) -> Self {
        let pid = task_id.into_raw();
        Self::new_inner(pid, None)
    }

    /// Construct an isolated process fixture with a caller-selected PID.
    #[cfg(test)]
    pub fn new(pid: u32) -> Self {
        Self::new_inner(pid, Some(StdioConfig::captured()))
    }

    /// Construct an isolated process fixture with caller-selected stdio.
    #[cfg(test)]
    pub fn new_with_stdio(pid: u32, stdio: StdioConfig) -> Self {
        Self::new_inner(pid, Some(stdio))
    }

    /// Construct an empty isolated fixture for deserialization tests.
    #[cfg(test)]
    pub fn new_empty_for_test(pid: u32) -> Self {
        Self::new_inner(pid, None)
    }

    fn new_inner(pid: u32, stdio: Option<StdioConfig>) -> Self {
        use wasm_posix_shared::flags::{O_RDONLY, O_WRONLY};

        let mut ofd_table = OfdTable::new();
        let mut fd_table = FdTable::new();
        if let Some(stdio) = stdio {
            ofd_table.create(
                stdio.kind_for_fd(0).file_type(),
                O_RDONLY,
                0,
                b"/dev/stdin".to_vec(),
            );
            ofd_table.create(
                stdio.kind_for_fd(1).file_type(),
                O_WRONLY,
                1,
                b"/dev/stdout".to_vec(),
            );
            ofd_table.create(
                stdio.kind_for_fd(2).file_type(),
                O_WRONLY,
                2,
                b"/dev/stderr".to_vec(),
            );
            fd_table.preopen_stdio(); // fds 0,1,2 → OFD refs 0,1,2
        }

        let mut rlimits = [[u64::MAX; 2]; 16]; // Default: infinity for all
        rlimits[7] = [1024, 4096]; // RLIMIT_NOFILE: soft=1024, hard=4096
        rlimits[3] = [8 * 1024 * 1024, u64::MAX]; // RLIMIT_STACK: soft=8MB, hard=infinity
        let mut terminal = TerminalState::new();
        terminal.foreground_pgid = pid as i32;

        Process {
            identity: ProcessIdentity {
                pid,
                threads: Vec::new(),
            },
            ppid: 0,
            credentials: Credentials::root(),
            secure_exec: false,
            exec_generation: 0,
            prepared_exec_targets: PreparedExecLedger::new(),
            spawn_publication_pending: false,
            pgid: pid,
            sid: 0,
            is_session_leader: false,
            state: ProcessState::Running,
            exit_status: 0,
            exit_signal: 0,
            wait_event: None,
            fd_table,
            ofd_table,
            blocked_retries: crate::blocked_retry::BlockingRetryState::new(),
            pipes: Vec::new(),
            sockets: SocketTable::new(),
            cwd: alloc::vec![b'/'],
            dir_streams: Vec::new(),
            signals: SignalState::new(),
            main_thread_signals: PerThreadSignalState::new(),
            memory: MemoryManager::new(),
            terminal,
            environ: Vec::new(),
            argv: Vec::new(),
            metadata_replacement: None,
            next_metadata_replacement_token: 1,
            umask: 0o022,
            nice: 0,
            rlimits,
            alarm_deadline_ns: 0,
            alarm_interval_ns: 0,
            thread_name: [0u8; wasm_posix_shared::kernel_scratch_wire::PRCTL_NAME_BYTES as usize],
            fork_child: false,
            vfork_child: false,
            mask_waits: Vec::new(),
            caught_handler_depth: 0,
            returned_handler_depths: Vec::new(),
            fork_exec_path: None,
            fork_exec_argv: None,
            fork_fd_actions: Vec::new(),
            next_ephemeral_port: 49152,
            epolls: Vec::new(),
            posix_timers: Vec::new(),
            alt_stack_sp: 0,
            alt_stack_flags: 2, // SS_DISABLE
            alt_stack_size: 0,
            alt_stack_depth: 0,
            fork_pipe_replay: Vec::new(),
            has_exec: false,
            fb_binding: None,
            dri_bindings: Vec::new(),
            shm_mappings: Vec::new(),
            fork_count: 0,
        }
    }

    /// Return the immutable process identity assigned by `ProcessTable`.
    pub fn pid(&self) -> u32 {
        self.identity.pid
    }

    pub fn real_uid(&self) -> u32 {
        self.credentials.ruid
    }

    pub fn effective_uid(&self) -> u32 {
        self.credentials.euid
    }

    pub fn saved_uid(&self) -> u32 {
        self.credentials.suid
    }

    pub fn real_gid(&self) -> u32 {
        self.credentials.rgid
    }

    pub fn effective_gid(&self) -> u32 {
        self.credentials.egid
    }

    pub fn saved_gid(&self) -> u32 {
        self.credentials.sgid
    }

    pub fn supplementary_groups(&self) -> &[u32] {
        &self.credentials.supplementary_groups
    }

    pub fn is_member_of_group(&self, gid: u32) -> bool {
        self.credentials.is_member_of_group(gid)
    }

    pub fn setuid(&mut self, uid: u32) -> Result<(), Errno> {
        self.credentials.setuid(uid)
    }

    pub fn seteuid(&mut self, uid: u32) -> Result<(), Errno> {
        self.credentials.seteuid(uid)
    }

    pub fn setresuid(&mut self, ruid: u32, euid: u32, suid: u32) -> Result<(), Errno> {
        self.credentials.setresuid(ruid, euid, suid)
    }

    pub fn setreuid(&mut self, ruid: u32, euid: u32) -> Result<(), Errno> {
        self.credentials.setreuid(ruid, euid)
    }

    pub fn setgid(&mut self, gid: u32) -> Result<(), Errno> {
        self.credentials.setgid(gid)
    }

    pub fn setegid(&mut self, gid: u32) -> Result<(), Errno> {
        self.credentials.setegid(gid)
    }

    pub fn setresgid(&mut self, rgid: u32, egid: u32, sgid: u32) -> Result<(), Errno> {
        self.credentials.setresgid(rgid, egid, sgid)
    }

    pub fn setregid(&mut self, rgid: u32, egid: u32) -> Result<(), Errno> {
        self.credentials.setregid(rgid, egid)
    }

    pub fn setgroups(&mut self, groups: &[u32]) -> Result<(), Errno> {
        self.credentials.setgroups(groups)
    }

    pub fn credentials(&self) -> &Credentials {
        &self.credentials
    }

    pub fn install_credentials(&mut self, credentials: Credentials) {
        self.credentials = credentials;
    }

    /// Apply POSIX_SPAWN_RESETIDS to the inherited child record.
    ///
    /// Saved IDs and supplementary groups remain exactly as inherited. This
    /// mutation is intentionally private to the kernel's pending-child setup;
    /// ordinary credential syscalls have their own permission transitions.
    pub fn reset_effective_ids_to_real(&mut self) {
        self.credentials.euid = self.credentials.ruid;
        self.credentials.egid = self.credentials.rgid;
    }

    pub fn configure_ids(&mut self, uid: Option<u32>, gid: Option<u32>) {
        let mut credentials = self.credentials.clone();
        if let Some(uid) = uid {
            credentials.ruid = uid;
            credentials.euid = uid;
            credentials.suid = uid;
        }
        if let Some(gid) = gid {
            credentials.rgid = gid;
            credentials.egid = gid;
            credentials.sgid = gid;
        }
        self.credentials = credentials;
    }

    /// Override a fixture identity without exposing a production mutation API.
    #[cfg(test)]
    pub fn set_pid_for_test(&mut self, pid: u32) {
        self.identity.pid = pid;
    }

    /// Returns how many times this process has successfully forked (parent side).
    pub fn fork_count(&self) -> u64 {
        self.fork_count
    }

    /// Increment the fork counter. Called by
    /// `ProcessTable::fork_process_for_caller` after child creation.
    pub fn increment_fork_count(&mut self) {
        self.fork_count += 1;
    }

    fn set_wait_event(&mut self, event_mask: u32, wait_status: i32, si_code: i32, si_status: i32) {
        self.wait_event = Some(ChildWaitEvent {
            event_mask,
            wait_status,
            si_code,
            si_status,
            child_uid: self.real_uid(),
            rusage: KernelRusage::default(),
        });
    }

    /// Apply a delivered default stop action. Repeated stop signals while the
    /// process is already stopped do not create duplicate state transitions.
    pub fn record_stop(&mut self, signum: u32) -> bool {
        if self.state != ProcessState::Running {
            return false;
        }
        self.state = ProcessState::Stopped;
        self.set_wait_event(
            wasm_posix_shared::wait::EVENT_STOPPED,
            ((signum as i32) << 8) | 0x7f,
            wasm_posix_shared::wait::CLD_STOPPED,
            signum as i32,
        );
        crate::wakeup::push(
            self.pid,
            wasm_posix_shared::wait::WAKE_PROCESS_STOPPED as u8,
        );
        true
    }

    /// Resume a stopped process. SIGCONT invokes this at signal-generation
    /// time, before its blocked mask or disposition is consulted.
    pub fn record_continue(&mut self) -> bool {
        if self.state != ProcessState::Stopped {
            return false;
        }
        self.state = ProcessState::Running;
        self.set_wait_event(
            wasm_posix_shared::wait::EVENT_CONTINUED,
            0xffff,
            wasm_posix_shared::wait::CLD_CONTINUED,
            wasm_posix_shared::signal::SIGCONT as i32,
        );
        crate::wakeup::push(
            self.pid,
            wasm_posix_shared::wait::WAKE_PROCESS_CONTINUED as u8,
        );
        true
    }

    /// Record one normal process exit after exit cleanup has completed.
    pub fn record_normal_exit(&mut self, status: i32) -> bool {
        if self.state == ProcessState::Exited || self.state == ProcessState::Limbo {
            return false;
        }
        let status = status & 0xff;
        self.state = ProcessState::Exited;
        self.exit_status = status;
        self.exit_signal = 0;
        self.set_wait_event(
            wasm_posix_shared::wait::EVENT_EXITED,
            status << 8,
            wasm_posix_shared::wait::CLD_EXITED,
            status,
        );
        true
    }

    /// Record one signal-caused process exit after exit cleanup has completed.
    pub fn record_signal_exit(&mut self, signum: u32) -> bool {
        if self.state == ProcessState::Exited || self.state == ProcessState::Limbo {
            return false;
        }
        let signum = signum & 0x7f;
        self.state = ProcessState::Exited;
        self.exit_status = 0;
        self.exit_signal = signum;
        self.set_wait_event(
            wasm_posix_shared::wait::EVENT_EXITED,
            signum as i32,
            wasm_posix_shared::wait::CLD_KILLED,
            signum as i32,
        );
        true
    }

    pub fn clear_signal_everywhere(&mut self, signum: u32) {
        self.signals.clear_pending(signum);
        self.clear_directed_signal(signum);
    }

    /// Apply process-control effects when a signal is generated, before the
    /// signal is queued or tested against a mask/disposition.
    fn prepare_signal_generation(&mut self, signum: u32) {
        use wasm_posix_shared::signal::{NSIG, SIGCONT, SIGSTOP, SIGTSTP, SIGTTIN, SIGTTOU};

        if signum == 0 || signum >= NSIG {
            return;
        }
        if signum == SIGCONT {
            for stop in [SIGSTOP, SIGTSTP, SIGTTIN, SIGTTOU] {
                self.clear_signal_everywhere(stop);
            }
            // This transition is mandatory even when SIGCONT is blocked,
            // ignored, or caught. The signal itself is still queued below.
            self.record_continue();
        } else if matches!(signum, SIGSTOP | SIGTSTP | SIGTTIN | SIGTTOU) {
            self.clear_signal_everywhere(SIGCONT);
        }
    }

    pub fn raise_signal(&mut self, signum: u32) -> bool {
        self.prepare_signal_generation(signum);
        self.signals.raise(signum)
    }

    pub fn raise_signal_with_value(&mut self, signum: u32, si_value_bits: u64) -> bool {
        self.prepare_signal_generation(signum);
        self.signals.raise_with_value(signum, si_value_bits)
    }

    /// Queue a process-directed signal with the generation metadata exposed
    /// through `siginfo_t`. Plain `kill()` uses `SI_USER` (0), while
    /// `rt_sigqueueinfo()` uses `SI_QUEUE` (-1).
    pub fn raise_signal_with_metadata(
        &mut self,
        signum: u32,
        si_value_bits: u64,
        si_code: i32,
        sender_pid: u32,
        sender_uid: u32,
    ) -> bool {
        self.prepare_signal_generation(signum);
        self.signals
            .raise_with_metadata(signum, si_value_bits, si_code, sender_pid, sender_uid)
    }

    /// Compatibility helper for the legacy pipe slot vector, reusing the first
    /// free slot. Runtime pipe operations use the kernel-global pipe table.
    pub fn alloc_pipe(&mut self, pipe: PipeBuffer) -> usize {
        for (i, slot) in self.pipes.iter().enumerate() {
            if slot.is_none() {
                self.pipes[i] = Some(pipe);
                return i;
            }
        }
        let idx = self.pipes.len();
        self.pipes.push(Some(pipe));
        idx
    }

    /// Compatibility helper for a consecutive pair of legacy pipe slots.
    /// Runtime pipe operations use the kernel-global pipe table.
    pub fn alloc_pipe_pair(&mut self, first: PipeBuffer, second: PipeBuffer) -> (usize, usize) {
        let len = self.pipes.len();
        for i in 0..len.saturating_sub(1) {
            if self.pipes[i].is_none() && self.pipes[i + 1].is_none() {
                self.pipes[i] = Some(first);
                self.pipes[i + 1] = Some(second);
                return (i, i + 1);
            }
        }
        let idx = self.pipes.len();
        self.pipes.push(Some(first));
        self.pipes.push(Some(second));
        (idx, idx + 1)
    }

    /// Consume a `ProcessTable`-allocated identity and attach its thread record.
    pub fn add_allocated_thread(
        &mut self,
        task_id: crate::process_table::AllocatedTaskId,
        ctid_ptr: usize,
        stack_ptr: usize,
        tls_ptr: usize,
    ) -> &mut ThreadState {
        let info = ThreadInfo::new_allocated(task_id, ctid_ptr, stack_ptr, tls_ptr);
        self.identity.threads.push(info);
        self.identity
            .threads
            .last_mut()
            .expect("just-added thread must exist")
            .state_mut()
    }

    /// Add an isolated caller-constructed thread fixture.
    #[cfg(test)]
    pub fn add_thread(&mut self, info: ThreadInfo) {
        self.identity.threads.push(info);
    }

    /// Remove a thread by TID.
    pub fn remove_thread(&mut self, tid: u32) -> Option<ThreadState> {
        if let Some(idx) = self.identity.threads.iter().position(|t| t.tid == tid) {
            Some(self.identity.threads.swap_remove(idx).into_state())
        } else {
            None
        }
    }

    /// Find a thread by TID.
    pub fn get_thread(&self, tid: u32) -> Option<&ThreadInfo> {
        self.threads.iter().find(|t| t.tid == tid)
    }

    /// Find a thread by TID (mutable).
    pub fn get_thread_mut(&mut self, tid: u32) -> Option<&mut ThreadState> {
        self.identity
            .threads
            .iter_mut()
            .find(|t| t.tid == tid)
            .map(ThreadInfo::state_mut)
    }

    /// Mutably visit retained thread state without exposing identity records or
    /// vector membership.
    pub fn thread_states_mut(&mut self) -> impl Iterator<Item = &mut ThreadState> {
        self.identity.threads.iter_mut().map(ThreadInfo::state_mut)
    }

    /// Remove all non-leader tasks during exec replacement.
    pub fn clear_threads(&mut self) {
        self.identity.threads.clear();
    }

    /// Record one SysV shared-memory attachment after the host commits mmap.
    pub fn record_shm_mapping(
        &mut self,
        addr: usize,
        shmid: i32,
        size: usize,
    ) -> Result<(), Errno> {
        if addr == 0 || shmid < 0 || size == 0 {
            return Err(Errno::EINVAL);
        }
        if size > i32::MAX as usize {
            return Err(Errno::EOVERFLOW);
        }
        if let Some(mapping) = self.shm_mapping_at(addr) {
            return if mapping.shmid == shmid && mapping.size == size {
                Ok(())
            } else {
                Err(Errno::EINVAL)
            };
        }
        if self.shm_mappings.len() >= MAX_SYSV_SHM_MAPPINGS_PER_PROCESS {
            return Err(Errno::ENOMEM);
        }
        self.shm_mappings
            .try_reserve_exact(1)
            .map_err(|_| Errno::ENOMEM)?;
        self.shm_mappings.push(ShmMapping { addr, shmid, size });
        Ok(())
    }

    /// Find a SysV shared-memory attachment by its process address.
    pub fn shm_mapping_at(&self, addr: usize) -> Option<ShmMapping> {
        self.shm_mappings.iter().copied().find(|m| m.addr == addr)
    }

    /// Remove and return a SysV shared-memory attachment by its process address.
    pub fn remove_shm_mapping(&mut self, addr: usize) -> Option<ShmMapping> {
        let idx = self.shm_mappings.iter().position(|m| m.addr == addr)?;
        Some(self.shm_mappings.swap_remove(idx))
    }

    /// Drain every SysV attachment owned by the discarded address space.
    pub fn take_shm_mappings(&mut self) -> Vec<ShmMapping> {
        core::mem::take(&mut self.shm_mappings)
    }

    /// Drain the complete process-owned host timer identity list when it fits.
    ///
    /// Timer handles themselves are host primitives, but Rust owns whether an
    /// alarm or POSIX timer remains attached to this process. Build the exact
    /// batch before mutating either side so allocation or ID conversion failure
    /// cannot leave a partially drained cleanup transaction.
    pub fn take_host_timer_cleanup(
        &mut self,
        max_posix_timer_ids: usize,
    ) -> Result<HostTimerCleanup, Errno> {
        let timer_count = self
            .posix_timers
            .iter()
            .filter(|slot| slot.is_some())
            .count();
        if timer_count > max_posix_timer_ids {
            return Err(Errno::ERANGE);
        }
        let mut posix_timer_ids = Vec::new();
        posix_timer_ids
            .try_reserve_exact(timer_count)
            .map_err(|_| Errno::ENOMEM)?;
        if timer_count != 0 {
            for (timer_id, slot) in self.posix_timers.iter().enumerate() {
                if slot.is_none() {
                    continue;
                }
                posix_timer_ids.push(u32::try_from(timer_id).map_err(|_| Errno::EOVERFLOW)?);
                if posix_timer_ids.len() == timer_count {
                    break;
                }
            }
        }

        let cancel_alarm = self.alarm_deadline_ns != 0 || self.alarm_interval_ns != 0;
        self.alarm_deadline_ns = 0;
        self.alarm_interval_ns = 0;
        for timer_id in &posix_timer_ids {
            self.remove_posix_timer_notification(*timer_id);
            self.posix_timers[*timer_id as usize] = None;
        }

        Ok(HostTimerCleanup {
            cancel_alarm,
            posix_timer_ids,
        })
    }

    /// True if `tid` names the process's main thread. The main thread's TID
    /// equals the process PID (Linux convention) and is not tracked in
    /// [`Process::threads`]; its blocked mask lives in [`Process::signals`]
    /// and its directed pending queue in [`Process::main_thread_signals`].
    ///
    /// `tid == 0` remains an internal main-thread sentinel for isolated
    /// syscall unit tests. Host dispatch binds the explicit leader PID.
    pub fn is_main_thread(&self, tid: u32) -> bool {
        tid == 0 || tid == self.pid
    }

    /// True when a nonzero TID explicitly names the live process leader or a
    /// retained worker. Kernel-internal TID 0 aliases the leader but is not a
    /// valid user-supplied exact-thread target. Synthetic PID 1 has no worker
    /// and therefore can never be an executing caller task.
    pub fn is_live_explicit_tid(&self, tid: u32) -> bool {
        self.pid != 1
            && matches!(self.state, ProcessState::Running | ProcessState::Stopped)
            && tid != 0
            && (tid == self.pid || self.get_thread(tid).is_some())
    }

    /// Effective blocked mask for the given TID.
    pub fn blocked_for(&self, tid: u32) -> u64 {
        if self.is_main_thread(tid) {
            self.signals.blocked
        } else if let Some(thread) = self.get_thread(tid) {
            thread.signals.blocked
        } else {
            // Unknown tasks must not inherit leader state. Treat every signal
            // as blocked so stale internal callers fail closed.
            u64::MAX
        }
    }

    /// Replace the blocked mask for an exact retained TID.
    /// Returns false without mutation when the task is unknown.
    pub fn set_blocked_for(&mut self, tid: u32, new_blocked: u64) -> bool {
        if self.is_main_thread(tid) {
            self.signals.blocked = new_blocked;
            true
        } else if let Some(t) = self.get_thread_mut(tid) {
            t.signals.blocked = new_blocked;
            true
        } else {
            false
        }
    }

    /// Union of the process's shared pending bits and TID's directed pending
    /// bits — the full set of signals that *could* be delivered to TID once
    /// unblocked.
    pub fn pending_for(&self, tid: u32) -> u64 {
        if self.is_main_thread(tid) {
            self.signals.pending | self.main_thread_signals.pending
        } else if let Some(thread) = self.get_thread(tid) {
            self.signals.pending | thread.signals.pending
        } else {
            0
        }
    }

    /// True iff `sig` is pending somewhere visible to TID (directed at TID
    /// or sitting in the shared process-level pending set).
    pub fn signal_pending_for(&self, tid: u32, sig: u32) -> bool {
        if sig == 0 || sig >= wasm_posix_shared::signal::NSIG {
            return false;
        }
        if !self.is_main_thread(tid) && self.get_thread(tid).is_none() {
            return false;
        }
        let bit = crate::signal::sig_bit(sig);
        let shared = (self.signals.pending & bit) != 0;
        if self.is_main_thread(tid) {
            shared || (self.main_thread_signals.pending & bit) != 0
        } else {
            let thread_bit = self
                .get_thread(tid)
                .map(|t| (t.signals.pending & bit) != 0)
                .unwrap_or(false);
            shared || thread_bit
        }
    }

    /// Whether a pending instance exists in the shared queue or any directed
    /// thread queue. SIGKILL uses this while stopped because it terminates the
    /// whole process regardless of which thread was targeted.
    pub fn signal_pending_anywhere(&self, sig: u32) -> bool {
        if sig == 0 || sig >= wasm_posix_shared::signal::NSIG {
            return false;
        }
        let bit = crate::signal::sig_bit(sig);
        self.signals.pending & bit != 0
            || self.main_thread_signals.pending & bit != 0
            || self
                .threads
                .iter()
                .any(|thread| thread.signals.pending & bit != 0)
    }

    /// Pick a thread TID that does not block `sig`. Preference order:
    ///   1. Main thread, if it does not block `sig`.
    ///   2. Any worker thread (in allocation order) with `sig` unblocked.
    /// Returns `None` if every thread blocks `sig`; the signal stays queued
    /// in the shared pending set until some thread unblocks it.
    pub fn pick_thread_for_shared_signal(&self, sig: u32) -> Option<u32> {
        if !self.is_live_explicit_tid(self.pid)
            || sig == 0
            || sig >= wasm_posix_shared::signal::NSIG
        {
            return None;
        }
        let bit = crate::signal::sig_bit(sig);
        if (self.signals.blocked & bit) == 0 {
            return Some(self.pid); // main thread
        }
        for t in &self.threads {
            if (t.signals.blocked & bit) == 0 {
                return Some(t.tid);
            }
        }
        None
    }

    /// Bitmask of signals currently deliverable to TID:
    /// `(shared_pending | thread_pending) & !thread_blocked`.
    pub fn deliverable_for(&self, tid: u32) -> u64 {
        let pending = self.pending_for(tid);
        let blocked = self.blocked_for(tid);
        pending & !blocked
    }

    /// Return the next signal deliverable in the current lifecycle state.
    /// Stopped processes retain every pending signal except SIGKILL; SIGCONT
    /// resumes at generation time and reaches this method as Running.
    pub fn next_deliverable_signal(&self, tid: u32) -> Option<u32> {
        if !self.is_main_thread(tid) && self.get_thread(tid).is_none() {
            return None;
        }
        if self.state == ProcessState::Stopped {
            let sigkill = wasm_posix_shared::signal::SIGKILL;
            return self.signal_pending_anywhere(sigkill).then_some(sigkill);
        }

        let deliverable = self.deliverable_for(tid);
        if deliverable == 0 {
            return None;
        }
        let signum = deliverable.trailing_zeros() + 1;
        (signum < wasm_posix_shared::signal::NSIG).then_some(signum)
    }

    /// Whether the lowest-numbered signal deliverable to `tid` carries
    /// SA_RESTART. Dispositions are process-wide even for directed signals.
    pub fn should_restart_for(&self, tid: u32) -> bool {
        let deliverable = self.deliverable_for(tid);
        if deliverable == 0 {
            return false;
        }
        let signum = deliverable.trailing_zeros() + 1;
        if signum >= wasm_posix_shared::signal::NSIG {
            return false;
        }
        self.signals.get_action(signum).flags & wasm_posix_shared::signal::SA_RESTART != 0
    }

    /// Queue a signal for one exact thread. Main-thread-directed signals have
    /// their own queue because `SignalState::pending` is process-shared.
    pub fn raise_for_thread(&mut self, tid: u32, signum: u32) -> bool {
        if signum == 0 || signum >= wasm_posix_shared::signal::NSIG {
            return false;
        }
        if !self.is_main_thread(tid) && self.get_thread(tid).is_none() {
            return false;
        }
        self.prepare_signal_generation(signum);
        let handler = self.signals.get_handler(signum);
        if crate::signal::should_discard_pending(signum, &handler) {
            return true;
        }
        if self.is_main_thread(tid) {
            self.main_thread_signals.raise(signum)
        } else if let Some(thread) = self.get_thread_mut(tid) {
            thread.signals.raise(signum)
        } else {
            false
        }
    }

    /// Queue a signal with sigqueue metadata for one exact thread.
    pub fn raise_for_thread_with_value(
        &mut self,
        tid: u32,
        signum: u32,
        si_value_bits: u64,
    ) -> bool {
        if signum == 0 || signum >= wasm_posix_shared::signal::NSIG {
            return false;
        }
        if !self.is_main_thread(tid) && self.get_thread(tid).is_none() {
            return false;
        }
        self.prepare_signal_generation(signum);
        let handler = self.signals.get_handler(signum);
        if crate::signal::should_discard_pending(signum, &handler) {
            return true;
        }
        if self.is_main_thread(tid) {
            self.main_thread_signals
                .raise_with_value(signum, si_value_bits)
        } else if let Some(thread) = self.get_thread_mut(tid) {
            thread.signals.raise_with_value(signum, si_value_bits)
        } else {
            false
        }
    }

    /// Queue a directed signal with authoritative sender metadata.
    pub fn raise_for_thread_with_metadata(
        &mut self,
        tid: u32,
        signum: u32,
        si_value_bits: u64,
        si_code: i32,
        sender_pid: u32,
        sender_uid: u32,
    ) -> bool {
        if signum == 0 || signum >= wasm_posix_shared::signal::NSIG {
            return false;
        }
        if !self.is_main_thread(tid) && self.get_thread(tid).is_none() {
            return false;
        }
        self.prepare_signal_generation(signum);
        let handler = self.signals.get_handler(signum);
        if crate::signal::should_discard_pending(signum, &handler) {
            return true;
        }
        if self.is_main_thread(tid) {
            self.main_thread_signals.raise_with_metadata(
                signum,
                si_value_bits,
                si_code,
                sender_pid,
                sender_uid,
            )
        } else if let Some(thread) = self.get_thread_mut(tid) {
            thread.signals.raise_with_metadata(
                signum,
                si_value_bits,
                si_code,
                sender_pid,
                sender_uid,
            )
        } else {
            false
        }
    }

    /// Queue one timer notification for an exact live thread, including the
    /// main thread's dedicated directed queue.
    pub fn raise_timer_for_thread(
        &mut self,
        tid: u32,
        signum: u32,
        si_value_bits: u64,
        timer_id: u32,
    ) -> bool {
        if signum == 0 || signum >= wasm_posix_shared::signal::NSIG {
            return false;
        }
        if !self.is_main_thread(tid) && self.get_thread(tid).is_none() {
            return false;
        }
        self.prepare_signal_generation(signum);
        let handler = self.signals.get_handler(signum);
        if crate::signal::should_discard_pending(signum, &handler) {
            return true;
        }
        if self.is_main_thread(tid) {
            self.main_thread_signals
                .raise_timer(signum, si_value_bits, timer_id)
        } else if let Some(thread) = self.get_thread_mut(tid) {
            thread.signals.raise_timer(signum, si_value_bits, timer_id)
        } else {
            false
        }
    }

    /// Clear a directed signal from every thread. Used when a new
    /// disposition requires pending instances to be discarded.
    pub fn clear_directed_signal(&mut self, signum: u32) {
        self.main_thread_signals.clear_pending(signum);
        for thread in &mut self.identity.threads {
            thread.state_mut().signals.clear_pending(signum);
        }
    }

    /// Consume one pending instance visible to `tid`, preferring that exact
    /// thread's directed queue before the shared process queue.
    pub fn consume_signal_for(
        &mut self,
        tid: u32,
        signum: u32,
    ) -> Option<crate::signal::PendingSignalInfo> {
        if !self.is_main_thread(tid) && self.get_thread(tid).is_none() {
            return None;
        }
        let directed = if self.is_main_thread(tid) {
            self.main_thread_signals
                .is_pending(signum)
                .then(|| self.main_thread_signals.consume_one_info(signum))
        } else if let Some(thread) = self.get_thread_mut(tid) {
            thread
                .signals
                .is_pending(signum)
                .then(|| thread.signals.consume_one_info(signum))
        } else {
            None
        };
        if directed.is_some() {
            return directed;
        }
        if self.signals.pending & crate::signal::sig_bit(signum) == 0 {
            return None;
        }
        Some(self.signals.consume_one(signum))
    }

    /// Mark a timer notification as accepted and snapshot its overrun count.
    pub fn accept_posix_timer_notification(&mut self, timer_id: u32) -> Option<i32> {
        let timer = self.posix_timers.get_mut(timer_id as usize)?.as_mut()?;
        if !timer.notification_pending {
            return None;
        }
        timer.notification_pending = false;
        timer.overrun_last = timer.overrun_current;
        timer.overrun_current = 0;
        Some(timer.overrun_last)
    }

    /// Preserve the interval-fire contract used by hosts predating the
    /// kernel-owned POSIX timer notification path. Returns true when the host
    /// must suppress a duplicate process-wide signal.
    pub fn note_legacy_posix_timer_interval_fire(&mut self, timer_id: u32) -> bool {
        let signum = match self.posix_timers.get(timer_id as usize) {
            Some(Some(timer)) => timer.sigev_signo,
            _ => return false,
        };
        if signum == 0 || signum >= wasm_posix_shared::signal::NSIG {
            return false;
        }

        let pending = (self.signals.pending & crate::signal::sig_bit(signum)) != 0;
        let timer = self.posix_timers[timer_id as usize].as_mut().unwrap();
        if pending {
            timer.overrun_last = timer.overrun_last.saturating_add(1);
        } else {
            timer.overrun_last = 0;
        }
        pending
    }

    /// Discard every shared and directed pending instance of a signal.
    pub fn discard_pending_signal(&mut self, signum: u32) {
        let mut timer_ids: Vec<u32> = self.signals.pending_timer_ids(signum).collect();
        timer_ids.extend(
            self.main_thread_signals
                .rt_queue
                .iter()
                .filter(|entry| entry.signum == signum)
                .filter_map(|entry| entry.timer_id),
        );
        for thread in &self.threads {
            timer_ids.extend(
                thread
                    .signals
                    .rt_queue
                    .iter()
                    .filter(|entry| entry.signum == signum)
                    .filter_map(|entry| entry.timer_id),
            );
        }
        self.signals.clear_pending(signum);
        self.main_thread_signals.clear_pending(signum);
        for thread in &mut self.identity.threads {
            thread.state_mut().signals.clear_pending(signum);
        }
        for timer_id in timer_ids {
            self.accept_posix_timer_notification(timer_id);
        }
    }

    /// Purge a deleted timer's queued notification before its slot is reused.
    pub fn remove_posix_timer_notification(&mut self, timer_id: u32) -> bool {
        let mut removed = self.signals.remove_timer_notification(timer_id);
        removed |= self.main_thread_signals.remove_timer_notification(timer_id);
        for thread in &mut self.identity.threads {
            removed |= thread
                .state_mut()
                .signals
                .remove_timer_notification(timer_id);
        }
        removed
    }

    fn mask_waits_for(
        &self,
        tid: u32,
    ) -> Option<&[crate::signal::SignalMaskWaitContext]> {
        if self.is_main_thread(tid) {
            Some(&self.mask_waits)
        } else {
            self.get_thread(tid)
                .map(|thread| thread.signals.mask_waits.as_slice())
        }
    }

    fn mask_waits_for_mut(
        &mut self,
        tid: u32,
    ) -> Option<&mut Vec<crate::signal::SignalMaskWaitContext>> {
        if self.is_main_thread(tid) {
            Some(&mut self.mask_waits)
        } else {
            self.get_thread_mut(tid)
                .map(|thread| &mut thread.signals.mask_waits)
        }
    }

    pub fn mask_wait_depth_for(&self, tid: u32) -> usize {
        self.mask_waits_for(tid).map_or(0, |waits| waits.len())
    }

    pub fn caught_handler_depth_for(&self, tid: u32) -> u32 {
        if self.is_main_thread(tid) {
            self.caught_handler_depth
        } else {
            self.get_thread(tid)
                .map_or(0, |thread| thread.signals.caught_handler_depth)
        }
    }

    fn set_caught_handler_depth_for(&mut self, tid: u32, depth: u32) {
        if self.is_main_thread(tid) {
            self.caught_handler_depth = depth;
        } else if let Some(thread) = self.get_thread_mut(tid) {
            thread.signals.caught_handler_depth = depth;
        }
    }

    fn returned_handler_depths_for_mut(&mut self, tid: u32) -> Option<&mut Vec<u32>> {
        if self.is_main_thread(tid) {
            Some(&mut self.returned_handler_depths)
        } else {
            self.get_thread_mut(tid)
                .map(|thread| &mut thread.signals.returned_handler_depths)
        }
    }

    /// Enter a mask-swapping wait, distinguishing a host retry or libc
    /// restart from a new wait nested inside a caught handler.
    pub fn enter_signal_mask_wait_for(
        &mut self,
        tid: u32,
        kind: crate::signal::SignalMaskWaitKind,
        new_mask: u64,
    ) {
        use crate::signal::SignalMaskWaitState;

        let current_mask = self.blocked_for(tid);
        let current_handler_depth = self.caught_handler_depth_for(tid);
        let reuse = self
            .mask_waits_for(tid)
            .and_then(|waits| waits.last())
            .is_some_and(|wait| {
                wait.kind == kind
                    && wait.replacement_mask == new_mask
                    && current_mask == wait.replacement_mask
                    && match wait.state {
                        // Repeated kernel attempts remain part of the active
                        // invocation, including a wait nested in a handler.
                        SignalMaskWaitState::Active => true,
                        // A libc restart can only occur after the handler
                        // which interrupted this frame has returned. At that
                        // point the current handler depth is lower. Equal or
                        // greater depth is a genuinely nested invocation,
                        // even when the handler restored the same mask.
                        SignalMaskWaitState::Interrupted { handler_depth } => {
                            current_handler_depth < handler_depth
                        }
                    }
            });
        if reuse {
            if let Some(wait) = self
                .mask_waits_for_mut(tid)
                .and_then(|waits| waits.last_mut())
            {
                wait.state = SignalMaskWaitState::Active;
            }
            return;
        }

        let saved_mask = self.blocked_for(tid);
        if let Some(waits) = self.mask_waits_for_mut(tid) {
            waits.push(crate::signal::SignalMaskWaitContext {
                saved_mask,
                replacement_mask: new_mask,
                kind,
                state: SignalMaskWaitState::Active,
            });
            self.set_blocked_for(tid, new_mask);
        }
    }

    /// Complete the active top wait in strict LIFO order.
    pub fn finish_signal_mask_wait_for(
        &mut self,
        tid: u32,
        kind: crate::signal::SignalMaskWaitKind,
    ) -> bool {
        use crate::signal::SignalMaskWaitState;

        let saved = self.mask_waits_for_mut(tid).and_then(|waits| {
            waits
                .last()
                .filter(|wait| wait.kind == kind && wait.state == SignalMaskWaitState::Active)?;
            waits.pop().map(|wait| wait.saved_mask)
        });
        if let Some(saved) = saved {
            self.set_blocked_for(tid, saved);
            true
        } else {
            false
        }
    }

    /// Record one normal or nonlocal rt_sigreturn boundary.
    pub fn return_from_caught_handler_for(&mut self, tid: u32) -> bool {
        let depth = self.caught_handler_depth_for(tid);
        if depth == 0 {
            return false;
        }
        self.set_caught_handler_depth_for(tid, depth - 1);
        if let Some(returned) = self.returned_handler_depths_for_mut(tid) {
            returned.push(depth);
        }
        true
    }

    /// A following sigprocmask is libc's normal-return restoration, not a
    /// siglongjmp abandonment.
    pub fn acknowledge_caught_handler_mask_restore_for(&mut self, tid: u32) {
        if let Some(returned) = self.returned_handler_depths_for_mut(tid) {
            returned.pop();
        }
    }

    /// Retire one exact mask-wait context. A context paired with an
    /// unacknowledged rt_sigreturn belongs to siglongjmp and is discarded
    /// without exposing an intermediate mask; the jump buffer supplies the
    /// final mask. Normal and host cancellations restore the saved mask.
    pub fn cancel_signal_mask_wait_for(&mut self, tid: u32) -> bool {
        use crate::signal::SignalMaskWaitState;

        let current_depth = self.caught_handler_depth_for(tid);
        let returned_depth = self
            .returned_handler_depths_for_mut(tid)
            .and_then(|returned| returned.last().copied());
        if let Some(depth) = returned_depth {
            if let Some(returned) = self.returned_handler_depths_for_mut(tid) {
                returned.pop();
            }
            let abandoned = self.mask_waits_for_mut(tid).and_then(|waits| {
                waits
                    .last()
                    .filter(|wait| {
                        wait.state
                            == SignalMaskWaitState::Interrupted {
                                handler_depth: depth,
                            }
                    })?;
                waits.pop()
            });
            return abandoned.is_some();
        }

        let saved = self.mask_waits_for_mut(tid).and_then(|waits| {
            let top = waits.last()?;
            let eligible = match top.state {
                SignalMaskWaitState::Active => true,
                SignalMaskWaitState::Interrupted { handler_depth } => {
                    handler_depth == current_depth.saturating_add(1)
                }
            };
            eligible.then(|| waits.pop().expect("checked top mask wait"))
        });
        if let Some(wait) = saved {
            self.set_blocked_for(tid, wait.saved_mask);
            true
        } else {
            false
        }
    }

    /// Install the mask active while a caught handler runs and return the
    /// mask that normal handler return must restore.
    ///
    /// ppoll, pselect, and sigsuspend leave their replacement mask current
    /// while the handler runs.  Their saved pre-wait mask remains Rust-owned
    /// until the wait reaches a terminal kernel attempt or exact host-owned
    /// cancellation.  The delivery record therefore restores the current
    /// replacement mask after the handler, preserving one logical restarted
    /// wait without exposing the caller's pre-wait mask between attempts.
    pub fn install_caught_handler_mask_for(
        &mut self,
        tid: u32,
        action_mask: u64,
        signum: u32,
    ) -> u64 {
        use crate::signal::SignalMaskWaitState;

        let handler_base_mask = self.blocked_for(tid);
        let handler_depth = self.caught_handler_depth_for(tid).saturating_add(1);
        self.set_caught_handler_depth_for(tid, handler_depth);
        if let Some(wait) = self
            .mask_waits_for_mut(tid)
            .and_then(|waits| waits.last_mut())
        {
            if wait.state == SignalMaskWaitState::Active {
                wait.state = SignalMaskWaitState::Interrupted { handler_depth };
            }
        }
        self.set_blocked_for(
            tid,
            handler_base_mask | action_mask | crate::signal::sig_bit(signum),
        );
        handler_base_mask
    }

    /// Collect every TID that has `sig` unblocked (main + worker threads).
    /// Used by the host to decide which thread channels to wake when a new
    /// shared signal arrives.
    pub fn tids_accepting(&self, sig: u32) -> Vec<u32> {
        let mut out = Vec::new();
        if sig == 0 || sig >= wasm_posix_shared::signal::NSIG {
            return out;
        }
        let bit = crate::signal::sig_bit(sig);
        if (self.signals.blocked & bit) == 0 {
            out.push(self.pid);
        }
        for t in &self.threads {
            if (t.signals.blocked & bit) == 0 {
                out.push(t.tid);
            }
        }
        out
    }

    pub fn begin_metadata_replacement(&mut self) -> Result<u32, Errno> {
        if self.metadata_replacement.is_some() {
            return Err(Errno::EBUSY);
        }

        let token = self.next_metadata_replacement_token;
        if token == 0 || token > i32::MAX as u32 {
            return Err(Errno::EOVERFLOW);
        }
        self.next_metadata_replacement_token = token + 1;
        self.metadata_replacement = Some(ProcessMetadataReplacement {
            token,
            argv: Vec::new(),
            environment: Vec::new(),
            failed: false,
        });
        Ok(token)
    }

    fn stage_metadata_entry_with<F>(
        &mut self,
        token: u32,
        kind: u32,
        entry: &[u8],
        allocate: F,
    ) -> Result<(), Errno>
    where
        F: FnOnce(&[u8]) -> Result<Vec<u8>, Errno>,
    {
        let transaction = self
            .metadata_replacement
            .as_mut()
            .filter(|transaction| transaction.token == token)
            .ok_or(Errno::EINVAL)?;
        transaction.stage_entry_with(kind, entry, allocate)
    }

    pub fn stage_metadata_entry(
        &mut self,
        token: u32,
        kind: u32,
        entry: &[u8],
    ) -> Result<(), Errno> {
        self.stage_metadata_entry_with(token, kind, entry, |source| {
            let mut owned = Vec::new();
            owned
                .try_reserve_exact(source.len())
                .map_err(|_| Errno::ENOMEM)?;
            owned.extend_from_slice(source);
            Ok(owned)
        })
    }

    pub fn commit_metadata_replacement(&mut self, token: u32) -> Result<(), Errno> {
        let transaction = self
            .metadata_replacement
            .as_ref()
            .filter(|transaction| transaction.token == token)
            .ok_or(Errno::EINVAL)?;
        if transaction.failed {
            return Err(Errno::EINVAL);
        }

        let transaction = self
            .metadata_replacement
            .take()
            .expect("validated metadata transaction disappeared");
        // WHY: both new vectors are fully Rust-owned before either live field
        // changes. No host import or fallible allocation occurs between these
        // assignments, so one export makes the pair visible atomically.
        self.argv = transaction.argv;
        self.environ = transaction.environment;
        Ok(())
    }

    pub fn cancel_metadata_replacement(&mut self, token: u32) -> Result<(), Errno> {
        self.metadata_replacement
            .as_ref()
            .filter(|transaction| transaction.token == token)
            .ok_or(Errno::EINVAL)?;
        self.metadata_replacement = None;
        Ok(())
    }
}

/// A `HostIO` impl that returns sensible defaults for the methods our
/// kernel-level unit tests actually invoke, and `unimplemented!()` for the
/// rest. Lives at module scope (under `#[cfg(test)]`) so any test in the
/// crate can `use crate::process::test_host::NoopHost;`.
#[cfg(test)]
pub mod test_host {
    use super::HostIO;
    use wasm_posix_shared::Errno;
    use wasm_posix_shared::WasmStat;

    pub struct NoopHost;

    impl HostIO for NoopHost {
        fn host_open(&mut self, _path: &[u8], _flags: u32, _mode: u32) -> Result<i64, Errno> {
            Err(Errno::ENOSYS)
        }
        fn host_close(&mut self, _h: i64) -> Result<(), Errno> {
            Ok(())
        }
        fn host_read(&mut self, _h: i64, _b: &mut [u8]) -> Result<usize, Errno> {
            Ok(0)
        }
        fn host_write(&mut self, _h: i64, b: &[u8]) -> Result<usize, Errno> {
            Ok(b.len())
        }
        fn host_seek(&mut self, _h: i64, _o: i64, _w: u32) -> Result<i64, Errno> {
            Ok(0)
        }
        fn host_fstat(&mut self, _h: i64) -> Result<WasmStat, Errno> {
            Err(Errno::ENOSYS)
        }
        fn host_stat(&mut self, _p: &[u8]) -> Result<WasmStat, Errno> {
            Err(Errno::ENOENT)
        }
        fn host_lstat(&mut self, _p: &[u8]) -> Result<WasmStat, Errno> {
            Err(Errno::ENOENT)
        }
        fn host_mkdir(&mut self, _p: &[u8], _m: u32) -> Result<(), Errno> {
            Err(Errno::ENOSYS)
        }
        fn host_rmdir(&mut self, _p: &[u8]) -> Result<(), Errno> {
            Err(Errno::ENOSYS)
        }
        fn host_unlink(&mut self, _p: &[u8]) -> Result<(), Errno> {
            Err(Errno::ENOSYS)
        }
        fn host_rename(&mut self, _o: &[u8], _n: &[u8]) -> Result<(), Errno> {
            Err(Errno::ENOSYS)
        }
        fn host_link(&mut self, _o: &[u8], _n: &[u8]) -> Result<(), Errno> {
            Err(Errno::ENOSYS)
        }
        fn host_symlink(&mut self, _t: &[u8], _l: &[u8]) -> Result<(), Errno> {
            Err(Errno::ENOSYS)
        }
        fn host_readlink(&mut self, _p: &[u8], _b: &mut [u8]) -> Result<usize, Errno> {
            Err(Errno::ENOSYS)
        }
        fn host_chmod(&mut self, _p: &[u8], _m: u32) -> Result<(), Errno> {
            Err(Errno::ENOSYS)
        }
        fn host_chown(&mut self, _p: &[u8], _u: u32, _g: u32) -> Result<(), Errno> {
            Err(Errno::ENOSYS)
        }
        fn host_access(&mut self, _p: &[u8], _a: u32) -> Result<(), Errno> {
            Err(Errno::ENOENT)
        }
        fn host_opendir(&mut self, _p: &[u8]) -> Result<i64, Errno> {
            Err(Errno::ENOSYS)
        }
        fn host_readdir(
            &mut self,
            _h: i64,
            _b: &mut [u8],
        ) -> Result<Option<(u64, u32, usize)>, Errno> {
            Ok(None)
        }
        fn host_closedir(&mut self, _h: i64) -> Result<(), Errno> {
            Ok(())
        }
        fn host_clock_gettime(&mut self, _c: u32) -> Result<(i64, i64), Errno> {
            Ok((0, 0))
        }
        fn host_nanosleep(&mut self, _s: i64, _n: i64) -> Result<(), Errno> {
            Ok(())
        }
        fn host_ftruncate(&mut self, _h: i64, _l: i64) -> Result<(), Errno> {
            Ok(())
        }
        fn host_fsync(&mut self, _h: i64) -> Result<(), Errno> {
            Ok(())
        }
        fn host_fchmod(&mut self, _h: i64, _m: u32) -> Result<(), Errno> {
            Ok(())
        }
        fn host_fchown(&mut self, _h: i64, _u: u32, _g: u32) -> Result<(), Errno> {
            Ok(())
        }
        fn host_set_alarm(&mut self, _s: u32) -> Result<(), Errno> {
            Ok(())
        }
        fn host_set_posix_timer(
            &mut self,
            _t: i32,
            _s: i32,
            _v: i64,
            _i: i64,
        ) -> Result<(), Errno> {
            Ok(())
        }
        fn host_sigsuspend_wait(&mut self) -> Result<u32, Errno> {
            Err(Errno::EINTR)
        }
        fn host_call_signal_handler(&mut self, _h: u32, _s: u32, _f: u32) -> Result<(), Errno> {
            Ok(())
        }
        fn host_getrandom(&mut self, b: &mut [u8]) -> Result<usize, Errno> {
            for x in b.iter_mut() {
                *x = 0;
            }
            Ok(b.len())
        }
        fn host_utimensat(
            &mut self,
            _p: &[u8],
            _as: i64,
            _an: i64,
            _ms: i64,
            _mn: i64,
        ) -> Result<(), Errno> {
            Ok(())
        }
        fn host_waitpid(&mut self, _p: i32, _o: u32) -> Result<(i32, i32), Errno> {
            Err(Errno::ECHILD)
        }
        fn host_net_connect(&mut self, _h: i32, _a: &[u8], _p: u16) -> Result<(), Errno> {
            Ok(())
        }
        fn host_net_connect_status(&mut self, _h: i32) -> Result<(), Errno> {
            Ok(())
        }
        fn host_net_send(&mut self, _h: i32, d: &[u8], _f: u32) -> Result<usize, Errno> {
            Ok(d.len())
        }
        fn host_net_recv(
            &mut self,
            _h: i32,
            _l: u32,
            _f: u32,
            _b: &mut [u8],
        ) -> Result<usize, Errno> {
            Ok(0)
        }
        fn host_net_close(&mut self, _h: i32) -> Result<(), Errno> {
            Ok(())
        }
        fn host_net_listen(&mut self, _f: i32, _p: u16, _a: &[u8; 4]) -> Result<(), Errno> {
            Ok(())
        }
        fn host_getaddrinfo(&mut self, _n: &[u8], _r: &mut [u8]) -> Result<usize, Errno> {
            Err(Errno::ENOENT)
        }
        fn host_futex_wait(&mut self, _a: usize, _e: u32, _t: i64) -> Result<i32, Errno> {
            Err(Errno::EAGAIN)
        }
        fn host_futex_wake(&mut self, _a: usize, _c: u32) -> Result<i32, Errno> {
            Ok(0)
        }
        fn bind_framebuffer(
            &mut self,
            _p: i32,
            _a: usize,
            _l: usize,
            _w: u32,
            _h: u32,
            _s: u32,
            _f: u32,
        ) {
        }
        fn unbind_framebuffer(&mut self, _p: i32) {}
        fn fb_write(&mut self, _p: i32, _o: usize, _b: &[u8]) {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ofd::FileType;
    use crate::pipe::PipeBuffer;

    fn install_socket_with_fd(proc: &mut Process, socket: crate::socket::SocketInfo) -> usize {
        let socket_index = proc.sockets.alloc(socket);
        let ofd_index = proc.ofd_table.create(
            FileType::Socket,
            wasm_posix_shared::flags::O_RDWR,
            -((socket_index as i64) + 1),
            b"/dev/socket".to_vec(),
        );
        proc.fd_table
            .alloc(crate::fd::OpenFileDescRef(ofd_index), 0)
            .unwrap();
        socket_index
    }

    #[test]
    fn temporary_wait_mask_forms_handler_mask_and_cancel_restores_once() {
        use crate::signal::{SignalMaskWaitKind, sig_bit};
        use crate::syscalls::cancel_host_owned_wait_for_tid;
        use wasm_posix_shared::signal::{SIGALRM, SIGTERM, SIGUSR1, SIGUSR2};

        let mut proc = Process::new(740);
        let worker_tid = 741;
        proc.add_thread(ThreadInfo::new(worker_tid, 0, 0, 0));

        let original = sig_bit(SIGUSR2);
        let temporary = sig_bit(SIGTERM);
        let action_mask = sig_bit(SIGUSR1);
        let handler_mask = temporary | action_mask | sig_bit(SIGALRM);

        for tid in [proc.pid, worker_tid] {
            proc.set_blocked_for(tid, original);
            proc.enter_signal_mask_wait_for(tid, SignalMaskWaitKind::Ppoll, temporary);

            let restore_mask = proc.install_caught_handler_mask_for(tid, action_mask, SIGALRM);

            assert_eq!(restore_mask, temporary);
            assert_eq!(proc.blocked_for(tid), handler_mask);
            assert_eq!(proc.mask_wait_depth_for(tid), 1);

            // Normal handler return preserves the replacement mask while the
            // interrupted wait decides whether it will be resubmitted.
            assert!(proc.return_from_caught_handler_for(tid));
            proc.set_blocked_for(tid, restore_mask);
            proc.acknowledge_caught_handler_mask_restore_for(tid);
            assert_eq!(proc.blocked_for(tid), temporary);

            assert!(cancel_host_owned_wait_for_tid(&mut proc, tid));
            assert_eq!(proc.blocked_for(tid), original);
            assert_eq!(proc.mask_wait_depth_for(tid), 0);
            assert!(!cancel_host_owned_wait_for_tid(&mut proc, tid));
            assert_eq!(proc.blocked_for(tid), original);
        }
    }

    #[test]
    fn ordinary_handler_return_uses_the_current_mask() {
        use crate::signal::sig_bit;
        use wasm_posix_shared::signal::{SIGALRM, SIGUSR1, SIGUSR2};

        let mut proc = Process::new(742);
        let original = sig_bit(SIGUSR2);
        let action_mask = sig_bit(SIGUSR1);

        proc.set_blocked_for(proc.pid, original);
        let restore_mask = proc.install_caught_handler_mask_for(proc.pid, action_mask, SIGALRM);

        assert_eq!(restore_mask, original);
        assert_eq!(
            proc.blocked_for(proc.pid),
            original | action_mask | sig_bit(SIGALRM),
        );
        assert_eq!(proc.mask_wait_depth_for(proc.pid), 0);
        assert!(proc.return_from_caught_handler_for(proc.pid));
        proc.acknowledge_caught_handler_mask_restore_for(proc.pid);
    }

    #[test]
    fn nested_mask_waits_restore_lifo_and_nonlocal_unwind_discards_each_frame() {
        use crate::signal::{SignalMaskWaitKind, sig_bit};
        use wasm_posix_shared::signal::{SIGALRM, SIGTERM, SIGUSR1, SIGUSR2};

        let mut proc = Process::new(743);
        let tid = proc.pid;
        let original = sig_bit(SIGUSR2);
        let outer = sig_bit(SIGTERM);
        let inner = sig_bit(SIGUSR1);

        proc.set_blocked_for(tid, original);
        proc.enter_signal_mask_wait_for(tid, SignalMaskWaitKind::Ppoll, outer);
        let outer_handler = proc.install_caught_handler_mask_for(tid, 0, SIGALRM);
        // A handler may deliberately restore the outer replacement mask. A
        // same-kind, same-mask wait entered at this handler depth is still a
        // nested invocation, not a restart of the interrupted outer wait.
        proc.set_blocked_for(tid, outer_handler);
        proc.enter_signal_mask_wait_for(tid, SignalMaskWaitKind::Ppoll, outer);
        assert_eq!(proc.mask_wait_depth_for(tid), 2);
        assert!(proc.finish_signal_mask_wait_for(tid, SignalMaskWaitKind::Ppoll));
        assert_eq!(proc.blocked_for(tid), outer_handler);
        assert_eq!(proc.mask_wait_depth_for(tid), 1);

        proc.enter_signal_mask_wait_for(tid, SignalMaskWaitKind::Pselect, inner);
        assert_eq!(proc.mask_wait_depth_for(tid), 2);
        assert!(proc.finish_signal_mask_wait_for(tid, SignalMaskWaitKind::Pselect));
        assert_eq!(proc.blocked_for(tid), outer_handler);
        assert_eq!(proc.mask_wait_depth_for(tid), 1);

        assert!(proc.return_from_caught_handler_for(tid));
        proc.set_blocked_for(tid, outer_handler);
        proc.acknowledge_caught_handler_mask_restore_for(tid);
        proc.enter_signal_mask_wait_for(tid, SignalMaskWaitKind::Ppoll, outer);
        assert_eq!(proc.mask_wait_depth_for(tid), 1);
        assert!(proc.finish_signal_mask_wait_for(tid, SignalMaskWaitKind::Ppoll));
        assert_eq!(proc.blocked_for(tid), original);

        proc.enter_signal_mask_wait_for(tid, SignalMaskWaitKind::Ppoll, outer);
        proc.install_caught_handler_mask_for(tid, 0, SIGALRM);
        proc.enter_signal_mask_wait_for(tid, SignalMaskWaitKind::Sigsuspend, inner);
        proc.install_caught_handler_mask_for(tid, 0, SIGUSR1);
        assert_eq!(proc.mask_wait_depth_for(tid), 2);
        assert!(proc.return_from_caught_handler_for(tid));
        assert!(proc.cancel_signal_mask_wait_for(tid));
        assert_eq!(proc.mask_wait_depth_for(tid), 1);
        assert!(proc.return_from_caught_handler_for(tid));
        assert!(proc.cancel_signal_mask_wait_for(tid));
        assert_eq!(proc.mask_wait_depth_for(tid), 0);
        assert!(!proc.cancel_signal_mask_wait_for(tid));
    }

    #[test]
    fn fork_count_starts_at_zero() {
        let proc = Process::new(1);
        assert_eq!(proc.fork_count(), 0);
    }

    #[test]
    fn child_status_record_is_replaced_by_each_new_transition() {
        use wasm_posix_shared::signal::{SIGCONT, SIGTERM, SIGTSTP};
        use wasm_posix_shared::wait::{
            CLD_CONTINUED, CLD_KILLED, CLD_STOPPED, EVENT_CONTINUED, EVENT_EXITED, EVENT_STOPPED,
        };

        let mut proc = Process::new(41);
        assert!(proc.record_stop(SIGTSTP));
        let stopped = proc.wait_event.unwrap();
        assert_eq!(stopped.event_mask, EVENT_STOPPED);
        assert_eq!(stopped.si_code, CLD_STOPPED);
        assert_eq!(stopped.si_status, SIGTSTP as i32);

        assert!(proc.record_continue());
        let continued = proc.wait_event.unwrap();
        assert_eq!(continued.event_mask, EVENT_CONTINUED);
        assert_eq!(continued.wait_status, 0xffff);
        assert_eq!(continued.si_code, CLD_CONTINUED);
        assert_eq!(continued.si_status, SIGCONT as i32);

        assert!(proc.record_signal_exit(SIGTERM));
        let exited = proc.wait_event.unwrap();
        assert_eq!(exited.event_mask, EVENT_EXITED);
        assert_eq!(exited.wait_status, SIGTERM as i32);
        assert_eq!(exited.si_code, CLD_KILLED);
        assert_eq!(exited.si_status, SIGTERM as i32);
    }

    #[test]
    fn sigcont_resumes_immediately_for_blocked_caught_and_ignored_dispositions() {
        use crate::signal::{SignalHandler, sig_bit};
        use wasm_posix_shared::signal::{SIGCONT, SIGSTOP};
        use wasm_posix_shared::wait::EVENT_CONTINUED;

        for (handler, blocked, expect_pending) in [
            (SignalHandler::Default, true, true),
            (SignalHandler::Handler(7), false, true),
            (SignalHandler::Ignore, false, false),
        ] {
            let mut proc = Process::new(42);
            proc.signals.set_handler(SIGCONT, handler).unwrap();
            if blocked {
                proc.signals.blocked |= sig_bit(SIGCONT);
            }
            assert!(proc.record_stop(SIGSTOP));

            let queued = proc.raise_signal(SIGCONT);

            assert_eq!(proc.state, ProcessState::Running);
            assert_eq!(proc.wait_event.unwrap().event_mask, EVENT_CONTINUED);
            if expect_pending {
                assert!(queued);
                assert!(proc.signals.is_pending(SIGCONT));
            } else {
                assert!(!proc.signals.is_pending(SIGCONT));
            }
        }
    }

    #[test]
    fn job_control_generation_cancels_opposing_pending_signals_everywhere() {
        use crate::signal::sig_bit;
        use wasm_posix_shared::signal::{SIGCONT, SIGSTOP, SIGTSTP, SIGTTIN, SIGTTOU};

        let mut proc = Process::new(43);
        proc.add_thread(ThreadInfo::new(99, 0, 0, 0));
        proc.signals.raise(SIGSTOP);
        proc.main_thread_signals.raise(SIGTSTP);
        proc.get_thread_mut(99).unwrap().signals.raise(SIGTTIN);
        proc.get_thread_mut(99).unwrap().signals.raise(SIGTTOU);

        assert!(proc.raise_signal(SIGCONT));
        let stop_bits = [SIGSTOP, SIGTSTP, SIGTTIN, SIGTTOU]
            .into_iter()
            .fold(0, |bits, sig| bits | sig_bit(sig));
        assert_eq!(proc.signals.pending & stop_bits, 0);
        assert_eq!(proc.main_thread_signals.pending & stop_bits, 0);
        assert_eq!(proc.threads[0].signals.pending & stop_bits, 0);

        proc.main_thread_signals.raise(SIGCONT);
        proc.get_thread_mut(99).unwrap().signals.raise(SIGCONT);
        assert!(proc.raise_signal(SIGSTOP));
        assert!(!proc.signals.is_pending(SIGCONT));
        assert_eq!(proc.main_thread_signals.pending & sig_bit(SIGCONT), 0);
        assert_eq!(proc.threads[0].signals.pending & sig_bit(SIGCONT), 0);
    }

    #[test]
    fn metadata_replacement_commits_both_vectors_and_preserves_empty_values() {
        let mut proc = Process::new(77);
        proc.argv = vec![b"old".to_vec()];
        proc.environ = vec![b"OLD=value".to_vec()];

        let token = proc.begin_metadata_replacement().unwrap();
        proc.stage_metadata_entry(
            token,
            process_metadata_contract::KIND_ARGV,
            b"new",
        )
        .unwrap();
        proc.stage_metadata_entry(
            token,
            process_metadata_contract::KIND_ARGV,
            b"",
        )
        .unwrap();
        proc.commit_metadata_replacement(token).unwrap();

        assert_eq!(proc.argv, vec![b"new".to_vec(), Vec::new()]);
        assert!(proc.environ.is_empty());
    }

    #[test]
    fn metadata_replacement_later_environment_allocation_failure_rolls_back_pair() {
        let mut proc = Process::new(78);
        proc.argv = vec![b"old-program".to_vec(), b"old-argument".to_vec()];
        proc.environ = vec![b"OLD=value".to_vec()];

        let token = proc.begin_metadata_replacement().unwrap();
        proc.stage_metadata_entry(
            token,
            process_metadata_contract::KIND_ARGV,
            b"new-program",
        )
        .unwrap();
        proc.stage_metadata_entry(
            token,
            process_metadata_contract::KIND_ENVIRONMENT,
            b"NEW=first",
        )
        .unwrap();
        assert_eq!(
            proc.stage_metadata_entry_with(
                token,
                process_metadata_contract::KIND_ENVIRONMENT,
                b"NEW=second",
                |_| Err(Errno::ENOMEM),
            ),
            Err(Errno::ENOMEM),
        );

        // A failed transaction is not committable even if a host omits its
        // required cancel path.
        assert_eq!(
            proc.commit_metadata_replacement(token),
            Err(Errno::EINVAL),
        );
        assert_eq!(
            proc.argv,
            vec![b"old-program".to_vec(), b"old-argument".to_vec()]
        );
        assert_eq!(proc.environ, vec![b"OLD=value".to_vec()]);
        proc.cancel_metadata_replacement(token).unwrap();
        assert_eq!(
            proc.argv,
            vec![b"old-program".to_vec(), b"old-argument".to_vec()]
        );
        assert_eq!(proc.environ, vec![b"OLD=value".to_vec()]);
    }

    #[test]
    fn metadata_replacement_rejects_overlap_stale_tokens_and_unknown_kinds() {
        let mut proc = Process::new(79);
        proc.argv = vec![b"old".to_vec()];
        proc.environ = vec![b"OLD=value".to_vec()];

        let first = proc.begin_metadata_replacement().unwrap();
        assert_eq!(
            proc.begin_metadata_replacement(),
            Err(Errno::EBUSY),
        );
        assert_eq!(
            proc.stage_metadata_entry(
                first + 1,
                process_metadata_contract::KIND_ARGV,
                b"stale",
            ),
            Err(Errno::EINVAL),
        );
        assert_eq!(
            proc.cancel_metadata_replacement(first + 1),
            Err(Errno::EINVAL),
        );
        assert_eq!(
            proc.stage_metadata_entry(
                first,
                99,
                b"unknown-kind",
            ),
            Err(Errno::EINVAL),
        );
        assert_eq!(
            proc.commit_metadata_replacement(first),
            Err(Errno::EINVAL),
        );
        proc.cancel_metadata_replacement(first).unwrap();
        assert_eq!(proc.argv, vec![b"old".to_vec()]);
        assert_eq!(proc.environ, vec![b"OLD=value".to_vec()]);

        let second = proc.begin_metadata_replacement().unwrap();
        assert!(second > first);
        proc.stage_metadata_entry(
            second,
            process_metadata_contract::KIND_ARGV,
            b"second",
        )
        .unwrap();
        proc.stage_metadata_entry(
            second,
            process_metadata_contract::KIND_ENVIRONMENT,
            b"SECOND=value",
        )
        .unwrap();
        proc.commit_metadata_replacement(second).unwrap();
        assert_eq!(proc.argv, vec![b"second".to_vec()]);
        assert_eq!(proc.environ, vec![b"SECOND=value".to_vec()]);

        let third = proc.begin_metadata_replacement().unwrap();
        proc.stage_metadata_entry(
            third,
            process_metadata_contract::KIND_ARGV,
            b"argv-only",
        )
        .unwrap();
        proc.stage_metadata_entry(
            third,
            process_metadata_contract::KIND_ENVIRONMENT,
            b"THIRD=value",
        )
        .unwrap();
        proc.commit_metadata_replacement(third).unwrap();
        assert_eq!(proc.argv, vec![b"argv-only".to_vec()]);
        assert_eq!(proc.environ, vec![b"THIRD=value".to_vec()]);
    }

    #[test]
    fn accepting_timer_notification_snapshots_overrun() {
        let mut proc = Process::new(1);
        proc.posix_timers.push(Some(PosixTimerState {
            clock_id: 1,
            sigev_signo: 32,
            sigev_value_bits: 7,
            sigev_notify: 0,
            sigev_tid: 0,
            interval_sec: 0,
            interval_nsec: 1,
            value_sec: 0,
            value_nsec: 1,
            notification_pending: true,
            overrun_current: 3,
            overrun_last: 1,
        }));

        assert_eq!(proc.accept_posix_timer_notification(0), Some(3));
        let timer = proc.posix_timers[0].as_ref().unwrap();
        assert!(!timer.notification_pending);
        assert_eq!(timer.overrun_current, 0);
        assert_eq!(timer.overrun_last, 3);
        assert_eq!(proc.accept_posix_timer_notification(0), None);
    }

    #[test]
    fn exact_thread_targets_accept_leader_and_live_worker_only() {
        let mut proc = Process::new(41);
        proc.add_thread(ThreadInfo::new(42, 0, 0, 0));

        assert!(!proc.is_live_explicit_tid(0));
        assert!(proc.is_live_explicit_tid(41));
        assert!(proc.is_live_explicit_tid(42));
        assert!(!proc.is_live_explicit_tid(43));
        proc.remove_thread(42);
        assert!(!proc.is_live_explicit_tid(42));

        let synthetic_init = Process::new(1);
        assert!(!synthetic_init.is_live_explicit_tid(1));
        assert_eq!(synthetic_init.pick_thread_for_shared_signal(15), None);

        proc.state = ProcessState::Exited;
        assert_eq!(proc.pick_thread_for_shared_signal(15), None);
    }

    #[test]
    fn legacy_interval_fire_preserves_host_signal_contract() {
        let mut proc = Process::new(1);
        proc.posix_timers.push(Some(PosixTimerState {
            clock_id: 1,
            sigev_signo: 10,
            sigev_value_bits: 7,
            sigev_notify: 0,
            sigev_tid: 0,
            interval_sec: 0,
            interval_nsec: 1,
            value_sec: 0,
            value_nsec: 1,
            notification_pending: false,
            overrun_current: 0,
            overrun_last: 4,
        }));

        assert!(!proc.note_legacy_posix_timer_interval_fire(0));
        assert_eq!(proc.posix_timers[0].as_ref().unwrap().overrun_last, 0);

        proc.signals.raise(10);
        assert!(proc.note_legacy_posix_timer_interval_fire(0));
        assert_eq!(proc.posix_timers[0].as_ref().unwrap().overrun_last, 1);
        assert!(proc.note_legacy_posix_timer_interval_fire(0));
        assert_eq!(proc.posix_timers[0].as_ref().unwrap().overrun_last, 2);
    }

    #[test]
    fn deleting_timer_notification_prevents_slot_reuse_aba() {
        let mut proc = Process::new(1);
        proc.add_thread(ThreadInfo::new(2, 0, 0, 0));
        proc.posix_timers.push(Some(PosixTimerState {
            clock_id: 1,
            sigev_signo: 10,
            sigev_value_bits: 7,
            sigev_notify: 4,
            sigev_tid: 2,
            interval_sec: 0,
            interval_nsec: 1,
            value_sec: 0,
            value_nsec: 1,
            notification_pending: true,
            overrun_current: 2,
            overrun_last: 0,
        }));
        proc.get_thread_mut(2)
            .unwrap()
            .signals
            .raise_timer(10, 7, 0);

        assert!(proc.remove_posix_timer_notification(0));
        proc.posix_timers[0] = Some(PosixTimerState {
            clock_id: 1,
            sigev_signo: 10,
            sigev_value_bits: 8,
            sigev_notify: 0,
            sigev_tid: 0,
            interval_sec: 0,
            interval_nsec: 1,
            value_sec: 0,
            value_nsec: 1,
            notification_pending: false,
            overrun_current: 0,
            overrun_last: 0,
        });

        assert!(!proc.get_thread(2).unwrap().signals.is_pending(10));
        assert_eq!(
            proc.get_thread_mut(2)
                .unwrap()
                .signals
                .consume_one_info(10)
                .timer_id,
            None,
        );
        assert_eq!(proc.accept_posix_timer_notification(0), None);
    }

    #[test]
    fn new_creates_captured_stdio_as_pipes() {
        let proc = Process::new(1);
        for fd in 0..=2 {
            let entry = proc.fd_table.get(fd).expect("stdio fd");
            let ofd = proc.ofd_table.get(entry.ofd_ref.0).expect("stdio ofd");
            assert_eq!(ofd.file_type, FileType::Pipe);
            assert_eq!(ofd.host_handle, fd as i64);
        }
    }

    #[test]
    fn new_with_stdio_can_create_terminal_stdio() {
        let proc = Process::new_with_stdio(1, StdioConfig::terminal());
        for fd in 0..=2 {
            let entry = proc.fd_table.get(fd).expect("stdio fd");
            let ofd = proc.ofd_table.get(entry.ofd_ref.0).expect("stdio ofd");
            assert_eq!(ofd.file_type, FileType::CharDevice);
            assert_eq!(ofd.host_handle, fd as i64);
        }
        assert_eq!(proc.terminal.foreground_pgid, 1);
    }

    #[test]
    fn shm_mapping_bookkeeping_is_keyed_by_process_addr() {
        let mut proc = Process::new(1);

        proc.record_shm_mapping(0x20000, 7, 4096).unwrap();
        assert_eq!(
            proc.shm_mapping_at(0x20000),
            Some(ShmMapping {
                addr: 0x20000,
                shmid: 7,
                size: 4096,
            })
        );

        assert_eq!(
            proc.record_shm_mapping(0x20000, 8, 8192),
            Err(Errno::EINVAL)
        );
        assert_eq!(
            proc.record_shm_mapping(0x30000, 8, i32::MAX as usize + 1),
            Err(Errno::EOVERFLOW)
        );
        assert_eq!(proc.shm_mappings.len(), 1);
        assert_eq!(
            proc.remove_shm_mapping(0x20000),
            Some(ShmMapping {
                addr: 0x20000,
                shmid: 7,
                size: 4096,
            })
        );
        assert_eq!(proc.shm_mapping_at(0x20000), None);
    }

    #[test]
    fn host_timer_cleanup_is_bounded_and_transactional() {
        let timer = |signo| PosixTimerState {
            clock_id: 1,
            sigev_signo: signo,
            sigev_value_bits: 0,
            sigev_notify: 0,
            sigev_tid: 0,
            interval_sec: 0,
            interval_nsec: 0,
            value_sec: 1,
            value_nsec: 0,
            notification_pending: false,
            overrun_current: 0,
            overrun_last: 0,
        };
        let mut proc = Process::new(1);
        proc.alarm_deadline_ns = 10;
        proc.alarm_interval_ns = 5;
        proc.posix_timers.push(Some(timer(14)));
        proc.posix_timers.push(None);
        proc.posix_timers.push(Some(timer(15)));

        assert_eq!(proc.take_host_timer_cleanup(1), Err(Errno::ERANGE));
        assert_eq!(proc.alarm_deadline_ns, 10);
        assert_eq!(proc.alarm_interval_ns, 5);
        assert!(proc.posix_timers[0].is_some());
        assert!(proc.posix_timers[2].is_some());

        let cleanup = proc.take_host_timer_cleanup(2).unwrap();
        assert!(cleanup.cancel_alarm);
        assert_eq!(cleanup.posix_timer_ids, alloc::vec![0, 2]);
        assert_eq!(proc.alarm_deadline_ns, 0);
        assert_eq!(proc.alarm_interval_ns, 0);
        assert!(proc.posix_timers.iter().all(Option::is_none));

        assert_eq!(
            proc.take_host_timer_cleanup(1).unwrap(),
            HostTimerCleanup {
                cancel_alarm: false,
                posix_timer_ids: alloc::vec![],
            }
        );
    }

    #[test]
    fn spawn_child_basic_inherits_cwd_and_returns_pid() {
        use crate::process_table::ProcessTable;
        use crate::spawn::SpawnAttrs;
        let mut table = ProcessTable::new();
        let parent_pid = table.create_process().unwrap();
        table.processes.get_mut(&parent_pid).unwrap().cwd = b"/tmp".to_vec();

        let mut host = test_host::NoopHost;
        let child_pid = table
            .spawn_child_for_caller(
                parent_pid,
                parent_pid,
                &[b"/bin/echo".as_slice(), b"hi".as_slice()],
                &[b"PATH=/bin".as_slice()],
                &[],
                &SpawnAttrs::empty(),
                &mut host,
            )
            .expect("spawn_child");

        assert_ne!(child_pid, parent_pid, "child pid must differ from parent");
        let child = table.get(child_pid).expect("child in table");
        assert_eq!(child.cwd, b"/tmp", "child inherits parent cwd");
        assert_eq!(child.ppid, parent_pid, "child ppid is parent pid");
        assert!(
            child.wait_event.is_none(),
            "spawn child starts without status"
        );
        assert_eq!(
            child.argv,
            alloc::vec![b"/bin/echo".to_vec(), b"hi".to_vec()],
            "child argv comes from caller, not parent"
        );
        // The whole point of non-forking spawn: the parent's fork counter
        // must NOT bump.
        assert_eq!(table.get(parent_pid).unwrap().fork_count(), 0);
    }

    #[test]
    fn spawn_child_bumps_shared_listener_backlog_refcount() {
        // Regression: spawn must inherit AF_INET listener backlog the same
        // way fork does. Otherwise a parent that opened a listener and then
        // spawned a child would see the backlog free'd when the child
        // exited and called dec_ref one too many times.
        use crate::process_table::ProcessTable;
        use crate::socket::{SocketDomain, SocketInfo, SocketType, shared_listener_backlog_table};
        use crate::spawn::SpawnAttrs;

        let mut table = ProcessTable::new();
        let parent_pid = table.create_process().unwrap();

        // Allocate a backlog slot (starts with ref_count=1) and attach it
        // to a parent-owned listener socket.
        let backlog_idx = unsafe { shared_listener_backlog_table().alloc() };
        let mut listener = SocketInfo::new(SocketDomain::Inet, SocketType::Stream, 0);
        listener.shared_backlog_idx = Some(backlog_idx);
        let _sock_idx = install_socket_with_fd(
            table.processes.get_mut(&parent_pid).unwrap(),
            listener,
        );

        let initial = unsafe { shared_listener_backlog_table().entries[backlog_idx].ref_count };
        assert_eq!(initial, 1, "alloc starts the slot at ref_count=1");

        let mut host = test_host::NoopHost;
        let _child_pid = table
            .spawn_child_for_caller(
                parent_pid,
                parent_pid,
                &[b"a".as_slice()],
                &[],
                &[],
                &SpawnAttrs::empty(),
                &mut host,
            )
            .expect("spawn_child");

        let after_spawn = unsafe { shared_listener_backlog_table().entries[backlog_idx].ref_count };
        assert_eq!(
            after_spawn, 2,
            "spawn child must add one ref to the inherited listener backlog"
        );

        // Same slot should also bump on fork — the helper is shared.
        table
            .fork_process_for_caller(parent_pid, parent_pid)
            .expect("fork_process");
        let after_fork = unsafe { shared_listener_backlog_table().entries[backlog_idx].ref_count };
        assert_eq!(
            after_fork, 3,
            "fork child must add one ref via the shared helper"
        );
    }

    #[test]
    fn fork_and_spawn_bump_host_net_handle_refcount() {
        // Regression: connected AF_INET sockets were value-cloned across
        // fork and spawn, so the first process to call close()/host_net_close
        // would kill the other's view of the connection. Now we refcount
        // host_net_handle the same way we refcount file host handles.
        use crate::process_table::ProcessTable;
        use crate::socket::{SocketDomain, SocketInfo, SocketType, host_net_handle_ref_count};
        use crate::spawn::SpawnAttrs;

        let mut table = ProcessTable::new();
        let parent_pid = table.create_process().unwrap();

        // Pretend the parent connected an AF_INET socket; the host returned
        // handle 42.
        const HANDLE: i32 = 42;
        let mut sock = SocketInfo::new(SocketDomain::Inet, SocketType::Stream, 0);
        sock.host_net_handle = Some(HANDLE);
        install_socket_with_fd(table.processes.get_mut(&parent_pid).unwrap(), sock);

        // The handle isn't in the cross-process table yet — single-owner.
        assert_eq!(host_net_handle_ref_count(HANDLE), 0);

        // Spawn a child. The bump turns the table entry into "1 (parent) + 1
        // (child) = 2".
        let mut host = test_host::NoopHost;
        let _child = table
            .spawn_child_for_caller(
                parent_pid,
                parent_pid,
                &[b"a".as_slice()],
                &[],
                &[],
                &SpawnAttrs::empty(),
                &mut host,
            )
            .expect("spawn_child");
        assert_eq!(
            host_net_handle_ref_count(HANDLE),
            2,
            "spawn child must bump host_net_handle ref"
        );

        // Forking again bumps once more.
        table
            .fork_process_for_caller(parent_pid, parent_pid)
            .expect("fork_process");
        assert_eq!(
            host_net_handle_ref_count(HANDLE),
            3,
            "fork child must bump host_net_handle ref via the same helper"
        );
    }

    #[test]
    fn spawn_child_clears_consume_once_socket_state() {
        // Regression: SocketInfo's hand-written Clone must drop dgram_queue
        // and oob_byte so a fork/spawn child can't consume the "same"
        // datagram or OOB byte the parent will consume. fork already
        // discards these via its serialize-side skip; this test pins the
        // spawn path to the same behavior.
        use crate::process_table::ProcessTable;
        use crate::socket::{Datagram, SocketDomain, SocketInfo, SocketType};
        use crate::spawn::SpawnAttrs;

        let mut table = ProcessTable::new();
        let parent_pid = table.create_process().unwrap();

        // Parent has a UDP socket with a pending datagram and a TCP socket
        // with a pending OOB byte.
        let mut udp = SocketInfo::new(SocketDomain::Inet, SocketType::Dgram, 0);
        udp.dgram_queue.push(Datagram {
            data: b"hello".to_vec(),
            src_addr: [127, 0, 0, 1],
            src_addr6: [0; 16],
            dst_addr: [127, 0, 0, 1],
            dst_addr6: [0; 16],
            src_port: 12345,
            src_sock_idx: None,
            ipv6_tclass: 0,
            src_pid: parent_pid,
            src_uid: 0,
            src_gid: 0,
            ancillary_fds: Vec::new(),
        });
        let mut tcp = SocketInfo::new(SocketDomain::Inet, SocketType::Stream, 0);
        tcp.oob_byte = Some(0xAB);
        let parent = table.processes.get_mut(&parent_pid).unwrap();
        let udp_idx = install_socket_with_fd(parent, udp);
        let tcp_idx = install_socket_with_fd(parent, tcp);

        // Sanity: parent still has the consume-once data.
        assert_eq!(
            table
                .get(parent_pid)
                .unwrap()
                .sockets
                .get(udp_idx)
                .unwrap()
                .dgram_queue
                .len(),
            1
        );
        assert_eq!(
            table
                .get(parent_pid)
                .unwrap()
                .sockets
                .get(tcp_idx)
                .unwrap()
                .oob_byte,
            Some(0xAB)
        );

        let mut host = test_host::NoopHost;
        let child_pid = table
            .spawn_child_for_caller(
                parent_pid,
                parent_pid,
                &[b"a".as_slice()],
                &[],
                &[],
                &SpawnAttrs::empty(),
                &mut host,
            )
            .expect("spawn_child");

        // Child must NOT see them.
        let child = table.get(child_pid).unwrap();
        assert!(
            child.sockets.get(udp_idx).unwrap().dgram_queue.is_empty(),
            "child must start with empty dgram queue"
        );
        assert_eq!(
            child.sockets.get(tcp_idx).unwrap().oob_byte,
            None,
            "child must not inherit pending OOB byte"
        );

        // Parent's pending data is intact (consume-once stayed with parent).
        let parent = table.get(parent_pid).unwrap();
        assert_eq!(parent.sockets.get(udp_idx).unwrap().dgram_queue.len(), 1);
        assert_eq!(parent.sockets.get(tcp_idx).unwrap().oob_byte, Some(0xAB));
    }

    #[test]
    fn fork_and_spawn_clear_listen_backlog_on_child() {
        // Pre-accepted AF_UNIX same-process connections are consume-once
        // (the indices reference the same SocketTable both processes now
        // hold copies of). A child that inherited them could double-accept.
        // Fork serializes 0-length; spawn's hand-written Clone clears the
        // Vec.
        use crate::process_table::ProcessTable;
        use crate::socket::{SocketDomain, SocketInfo, SocketType};
        use crate::spawn::SpawnAttrs;

        let mut table = ProcessTable::new();
        let parent_pid = table.create_process().unwrap();

        // Parent has a listening AF_UNIX socket with pending pre-accepted
        // connections.
        let mut listener = SocketInfo::new(SocketDomain::Unix, SocketType::Stream, 0);
        listener.listen_backlog.push(7);
        listener.listen_backlog.push(11);
        let parent = table.processes.get_mut(&parent_pid).unwrap();
        let listener_idx = install_socket_with_fd(parent, listener);

        // Sanity: parent has both pending entries.
        assert_eq!(
            table
                .get(parent_pid)
                .unwrap()
                .sockets
                .get(listener_idx)
                .unwrap()
                .listen_backlog
                .len(),
            2
        );

        // Spawn child must NOT inherit them.
        let mut host = test_host::NoopHost;
        let spawn_child = table
            .spawn_child_for_caller(
                parent_pid,
                parent_pid,
                &[b"a".as_slice()],
                &[],
                &[],
                &SpawnAttrs::empty(),
                &mut host,
            )
            .expect("spawn_child");
        assert!(
            table
                .get(spawn_child)
                .unwrap()
                .sockets
                .get(listener_idx)
                .unwrap()
                .listen_backlog
                .is_empty(),
            "spawn child must start with empty listen_backlog"
        );

        // Fork child must NOT inherit them either.
        let fork_child = table
            .fork_process_for_caller(parent_pid, parent_pid)
            .expect("fork_process");
        assert!(
            table
                .get(fork_child)
                .unwrap()
                .sockets
                .get(listener_idx)
                .unwrap()
                .listen_backlog
                .is_empty(),
            "fork child must start with empty listen_backlog"
        );

        // Parent retains them.
        assert_eq!(
            table
                .get(parent_pid)
                .unwrap()
                .sockets
                .get(listener_idx)
                .unwrap()
                .listen_backlog
                .len(),
            2,
            "parent's pending pre-accepted connections are intact"
        );
    }

    #[test]
    fn remove_process_emits_host_net_close_only_on_last_ref() {
        // Regression: when the last process holding a host_net_handle
        // exits, remove_process must report it in `host_net_closes` so
        // the kernel-export wrapper can call host_net_close. Earlier
        // refs (parent still holding it) must NOT report it.
        use crate::process_table::ProcessTable;
        use crate::socket::{SocketDomain, SocketInfo, SocketType, host_net_handle_ref_count};
        use crate::spawn::SpawnAttrs;

        const HANDLE: i32 = 84;
        let mut table = ProcessTable::new();
        let parent_pid = table.create_process().unwrap();
        let mut sock = SocketInfo::new(SocketDomain::Inet, SocketType::Stream, 0);
        sock.host_net_handle = Some(HANDLE);
        let _sock_idx =
            install_socket_with_fd(table.processes.get_mut(&parent_pid).unwrap(), sock);

        // Spawn a child → bump the refcount to (parent=1, child=2).
        let mut host = test_host::NoopHost;
        let child_pid = table
            .spawn_child_for_caller(
                parent_pid,
                parent_pid,
                &[b"a".as_slice()],
                &[],
                &[],
                &SpawnAttrs::empty(),
                &mut host,
            )
            .expect("spawn_child");
        assert_eq!(host_net_handle_ref_count(HANDLE), 2);

        // Removing the child first: NOT the last reference → no close.
        let r1 = table.remove_process(child_pid).expect("remove child");
        assert!(
            r1.host_net_closes.is_empty(),
            "child exit must not emit host_net_close while parent still holds the handle"
        );
        assert_eq!(host_net_handle_ref_count(HANDLE), 1);

        // Removing the parent now: IS the last reference → emit close.
        let r2 = table.remove_process(parent_pid).expect("remove parent");
        assert_eq!(
            r2.host_net_closes,
            alloc::vec![HANDLE],
            "parent exit must emit host_net_close for the last-ref handle"
        );
        // The refcount table entry should be gone (close_ref dropped to 0).
        assert_eq!(host_net_handle_ref_count(HANDLE), 0);
    }

    #[test]
    fn remove_process_emits_host_file_close_only_on_last_ref() {
        // Forced host teardown removes a process without running sys_exit.
        // Its live host-backed OFDs must still drop their inherited ownership,
        // and only the last owner may close the shared backend handle.
        use crate::fd::FdTable;
        use crate::ofd::{FileType, OfdTable, host_handle_ref_count};
        use crate::process_table::ProcessTable;

        const HANDLE: i64 = 900_000_091;
        let mut table = ProcessTable::new();
        let parent_pid = table.create_process().unwrap();
        let parent = table.processes.get_mut(&parent_pid).unwrap();
        // Keep the assertion independent of globally-numbered stdio handles,
        // which other ProcessTable tests may share while the test runner is
        // executing in parallel.
        parent.fd_table = FdTable::new();
        parent.ofd_table = OfdTable::new();
        let ofd_idx = parent.ofd_table.create(
            FileType::Regular,
            wasm_posix_shared::flags::O_RDONLY,
            HANDLE,
            b"/tmp/forced-exit-file".to_vec(),
        );
        parent
            .fd_table
            .alloc(crate::fd::OpenFileDescRef(ofd_idx), 0)
            .unwrap();

        let child_pid = table
            .fork_process_for_caller(parent_pid, parent_pid)
            .expect("fork_process");
        assert_eq!(host_handle_ref_count(HANDLE), 2);

        let child = table.remove_process(child_pid).expect("remove child");
        assert!(child.host_closes.is_empty());
        assert_eq!(host_handle_ref_count(HANDLE), 1);

        let parent = table.remove_process(parent_pid).expect("remove parent");
        assert_eq!(parent.host_closes, alloc::vec![HANDLE]);
        assert_eq!(host_handle_ref_count(HANDLE), 0);
    }

    #[test]
    fn remove_process_emits_all_uninherited_directory_handles() {
        use crate::fd::FdTable;
        use crate::ofd::{FileType, OfdTable};
        use crate::process::DirStream;
        use crate::process_table::ProcessTable;

        let mut table = ProcessTable::new();
        let pid = table.create_process().unwrap();
        let process = table.processes.get_mut(&pid).unwrap();
        process.fd_table = FdTable::new();
        process.ofd_table = OfdTable::new();
        let ofd_idx = process.ofd_table.create(
            FileType::Directory,
            wasm_posix_shared::flags::O_RDONLY,
            92,
            b"/tmp".to_vec(),
        );
        process.ofd_table.get_mut(ofd_idx).unwrap().dir_host_handle = 7;
        process
            .fd_table
            .alloc(crate::fd::OpenFileDescRef(ofd_idx), 0)
            .unwrap();
        process.dir_streams.push(Some(DirStream {
            host_handle: 8,
            path: b"/var".to_vec(),
            position: 0,
            synth_dot_state: 0,
        }));

        let removed = table.remove_process(pid).expect("remove process");
        assert_eq!(removed.host_dir_closes, alloc::vec![7, 8]);
        assert_eq!(removed.host_closes, alloc::vec![92]);
    }

    #[test]
    fn spawn_child_applies_close_action() {
        // Parent has fd 5 → some inherited OFD. After spawn with file
        // action Close{fd:5}, the child must NOT have fd 5; the parent
        // is unaffected.
        use crate::process_table::ProcessTable;
        use crate::spawn::{FileAction, SpawnAttrs};

        let mut table = ProcessTable::new();
        let parent_pid = table.create_process().unwrap();

        // Inject an OFD + fd 5 into parent. Use a file_type+host_handle that
        // won't trigger any host call on close-after-spawn.
        let parent = table.processes.get_mut(&parent_pid).unwrap();
        let ofd_idx = parent.ofd_table.create(
            crate::ofd::FileType::Regular,
            wasm_posix_shared::flags::O_RDONLY,
            42, // host_handle (positive). bump_inherited_resource_refcounts
            // will register it; close_ref returns false → no host_close.
            b"/tmp/foo".to_vec(),
        );
        parent
            .fd_table
            .alloc_at_min(crate::fd::OpenFileDescRef(ofd_idx), 0, 5)
            .unwrap();
        // Sanity: parent has fd 5.
        assert!(table.get(parent_pid).unwrap().fd_table.get(5).is_ok());

        let mut host = test_host::NoopHost;
        let child_pid = table
            .spawn_child_for_caller(
                parent_pid,
                parent_pid,
                &[b"a".as_slice()],
                &[],
                &[FileAction::Close { fd: 5 }],
                &SpawnAttrs::empty(),
                &mut host,
            )
            .expect("spawn_child");

        // Child: fd 5 closed.
        assert!(
            table.get(child_pid).unwrap().fd_table.get(5).is_err(),
            "child must have fd 5 closed by file action"
        );
        // Parent: fd 5 still open.
        assert!(
            table.get(parent_pid).unwrap().fd_table.get(5).is_ok(),
            "parent fd 5 must be unaffected"
        );
    }

    #[test]
    fn spawn_child_applies_dup2_action() {
        // Parent has fd 5 → some OFD. After spawn with Dup2{srcfd:5, fd:1},
        // the child's fd 1 points at fd 5's OFD; the parent is unaffected.
        use crate::process_table::ProcessTable;
        use crate::spawn::{FileAction, SpawnAttrs};

        let mut table = ProcessTable::new();
        let parent_pid = table.create_process().unwrap();

        let parent = table.processes.get_mut(&parent_pid).unwrap();
        let ofd_idx = parent.ofd_table.create(
            crate::ofd::FileType::Regular,
            wasm_posix_shared::flags::O_RDONLY,
            43,
            b"/tmp/bar".to_vec(),
        );
        parent
            .fd_table
            .alloc_at_min(crate::fd::OpenFileDescRef(ofd_idx), 0, 5)
            .unwrap();
        let parent_fd1_ofd = table
            .get(parent_pid)
            .unwrap()
            .fd_table
            .get(1)
            .unwrap()
            .ofd_ref
            .0;

        let mut host = test_host::NoopHost;
        let child_pid = table
            .spawn_child_for_caller(
                parent_pid,
                parent_pid,
                &[b"a".as_slice()],
                &[],
                &[FileAction::Dup2 { srcfd: 5, fd: 1 }],
                &SpawnAttrs::empty(),
                &mut host,
            )
            .expect("spawn_child");

        // Child fd 1 now points at the same OFD as fd 5.
        let child = table.get(child_pid).unwrap();
        let child_fd1_ofd = child.fd_table.get(1).unwrap().ofd_ref.0;
        let child_fd5_ofd = child.fd_table.get(5).unwrap().ofd_ref.0;
        assert_eq!(child_fd1_ofd, child_fd5_ofd, "child fd 1 dup2'd from fd 5");
        // Parent fd 1 unchanged.
        assert_eq!(
            table
                .get(parent_pid)
                .unwrap()
                .fd_table
                .get(1)
                .unwrap()
                .ofd_ref
                .0,
            parent_fd1_ofd,
            "parent fd 1 unaffected"
        );
    }

    #[test]
    fn spawn_child_late_action_failure_drops_partial_child() {
        // A successful first action followed by Dup2 from a closed source fd
        // must fail with EBADF and leave the parent's process table unchanged.
        use crate::process_table::ProcessTable;
        use crate::spawn::{FileAction, SpawnAttrs};
        use wasm_posix_shared::Errno;

        let mut table = ProcessTable::new();
        let parent_pid = table.create_process().unwrap();
        let pids_before: Vec<u32> = table.all_pids();
        let parent_fork_count_before = table.get(parent_pid).unwrap().fork_count();
        assert!(table.get(parent_pid).unwrap().fd_table.get(0).is_ok());

        let mut host = test_host::NoopHost;
        let err = table
            .spawn_child_for_caller(
                parent_pid,
                parent_pid,
                &[b"a".as_slice()],
                &[],
                &[
                    FileAction::Close { fd: 0 },
                    FileAction::Dup2 { srcfd: 999, fd: 1 },
                ],
                &SpawnAttrs::empty(),
                &mut host,
            )
            .expect_err("spawn_child must fail when an action errors");
        assert_eq!(err, Errno::EBADF);

        // No new pid leaked.
        let pids_after: Vec<u32> = table.all_pids();
        assert_eq!(pids_before, pids_after, "no partial child must remain");
        assert!(
            table.get(parent_pid).unwrap().fd_table.get(0).is_ok(),
            "the successful child-only action must not affect the parent"
        );
        // fork_count still 0.
        assert_eq!(
            table.get(parent_pid).unwrap().fork_count(),
            parent_fork_count_before
        );
    }

    #[test]
    fn spawn_child_setsid_makes_session_leader() {
        use crate::process_table::ProcessTable;
        use crate::spawn::{SpawnAttrs, attr_flags};

        let mut table = ProcessTable::new();
        let parent_pid = table.create_process().unwrap();
        // Parent's identity to confirm child diverges.
        table.processes.get_mut(&parent_pid).unwrap().sid = 50;
        table.processes.get_mut(&parent_pid).unwrap().pgid = 60;

        let attrs = SpawnAttrs {
            flags: attr_flags::SETSID,
            pgrp: 0,
            sigdef: 0,
            sigmask: 0,
        };
        let mut host = test_host::NoopHost;
        let cpid = table
            .spawn_child_for_caller(
                parent_pid,
                parent_pid,
                &[b"a".as_slice()],
                &[],
                &[],
                &attrs,
                &mut host,
            )
            .unwrap();

        let child = table.get(cpid).unwrap();
        assert_eq!(child.sid, cpid, "SETSID makes child its own session leader");
        assert_eq!(
            child.pgid, cpid,
            "SETSID also makes child its own pgrp leader"
        );
        assert!(child.is_session_leader, "is_session_leader flag set");
    }

    #[test]
    fn spawn_child_setpgroup_zero_uses_child_pid() {
        use crate::process_table::ProcessTable;
        use crate::spawn::{SpawnAttrs, attr_flags};

        let mut table = ProcessTable::new();
        let parent_pid = table.create_process().unwrap();

        let attrs = SpawnAttrs {
            flags: attr_flags::SETPGROUP,
            pgrp: 0,
            sigdef: 0,
            sigmask: 0,
        };
        let mut host = test_host::NoopHost;
        let cpid = table
            .spawn_child_for_caller(
                parent_pid,
                parent_pid,
                &[b"a".as_slice()],
                &[],
                &[],
                &attrs,
                &mut host,
            )
            .unwrap();
        assert_eq!(
            table.get(cpid).unwrap().pgid,
            cpid,
            "SETPGROUP with pgrp=0 → child's own pid"
        );
    }

    #[test]
    fn spawn_child_setpgroup_explicit_lands_in_target() {
        use crate::process_table::ProcessTable;
        use crate::spawn::{SpawnAttrs, attr_flags};

        let mut table = ProcessTable::new();
        let parent_pid = table.create_process().unwrap();

        let attrs = SpawnAttrs {
            flags: attr_flags::SETPGROUP,
            pgrp: 42,
            sigdef: 0,
            sigmask: 0,
        };
        let mut host = test_host::NoopHost;
        let cpid = table
            .spawn_child_for_caller(
                parent_pid,
                parent_pid,
                &[b"a".as_slice()],
                &[],
                &[],
                &attrs,
                &mut host,
            )
            .unwrap();
        assert_eq!(table.get(cpid).unwrap().pgid, 42);
    }

    #[test]
    fn spawn_child_setsigmask_overrides_inherited_mask() {
        use crate::process_table::ProcessTable;
        use crate::spawn::{SpawnAttrs, attr_flags};

        let mut table = ProcessTable::new();
        let parent_pid = table.create_process().unwrap();
        // Parent has SIGINT (bit 0) blocked.
        table
            .processes
            .get_mut(&parent_pid)
            .unwrap()
            .signals
            .blocked = 0x1;

        let attrs = SpawnAttrs {
            flags: attr_flags::SETSIGMASK,
            pgrp: 0,
            sigdef: 0,
            sigmask: 0xFFu64,
        };
        let mut host = test_host::NoopHost;
        let cpid = table
            .spawn_child_for_caller(
                parent_pid,
                parent_pid,
                &[b"a".as_slice()],
                &[],
                &[],
                &attrs,
                &mut host,
            )
            .unwrap();
        assert_eq!(
            table.get(cpid).unwrap().signals.blocked,
            0xFFu64,
            "SETSIGMASK overrides the inherited mask wholesale"
        );
    }

    #[test]
    fn spawn_child_without_setsigmask_inherits_blocked_mask() {
        // Sanity: confirm that without SETSIGMASK, the child gets the parent's
        // blocked mask. This is the baseline the override test contrasts against.
        use crate::process_table::ProcessTable;
        use crate::spawn::SpawnAttrs;

        let mut table = ProcessTable::new();
        let parent_pid = table.create_process().unwrap();
        table
            .processes
            .get_mut(&parent_pid)
            .unwrap()
            .signals
            .blocked = 0xAAu64;
        let mut host = test_host::NoopHost;
        let cpid = table
            .spawn_child_for_caller(
                parent_pid,
                parent_pid,
                &[b"a".as_slice()],
                &[],
                &[],
                &SpawnAttrs::empty(),
                &mut host,
            )
            .unwrap();
        assert_eq!(table.get(cpid).unwrap().signals.blocked, 0xAAu64);
    }

    #[test]
    fn spawn_child_inherits_sig_ign_but_not_custom_handlers() {
        // POSIX exec semantics: SIG_IGN persists across exec, custom handlers
        // reset to SIG_DFL. spawn is fork+exec atomic, so the same applies.
        use crate::process_table::ProcessTable;
        use crate::signal::SignalHandler;
        use crate::spawn::SpawnAttrs;
        use wasm_posix_shared::signal::{SIGUSR1, SIGUSR2};

        let mut table = ProcessTable::new();
        let parent_pid = table.create_process().unwrap();
        let parent = table.processes.get_mut(&parent_pid).unwrap();
        parent
            .signals
            .set_handler(SIGUSR1, SignalHandler::Ignore)
            .unwrap();
        parent
            .signals
            .set_handler(SIGUSR2, SignalHandler::Handler(42))
            .unwrap();

        let mut host = test_host::NoopHost;
        let cpid = table
            .spawn_child_for_caller(
                parent_pid,
                parent_pid,
                &[b"a".as_slice()],
                &[],
                &[],
                &SpawnAttrs::empty(),
                &mut host,
            )
            .unwrap();

        let child = table.get(cpid).unwrap();
        assert_eq!(
            child.signals.get_handler(SIGUSR1),
            SignalHandler::Ignore,
            "child inherits SIG_IGN across the implicit exec"
        );
        assert_eq!(
            child.signals.get_handler(SIGUSR2),
            SignalHandler::Default,
            "child resets parent's custom handler to SIG_DFL"
        );
    }

    #[test]
    fn spawn_child_setsigdef_resets_named_handlers_to_default() {
        // SETSIGDEF should override SIG_IGN inheritance for named signals.
        use crate::process_table::ProcessTable;
        use crate::signal::SignalHandler;
        use crate::spawn::{SpawnAttrs, attr_flags};
        use wasm_posix_shared::signal::{SIGUSR1, SIGUSR2};

        let mut table = ProcessTable::new();
        let parent_pid = table.create_process().unwrap();
        let parent = table.processes.get_mut(&parent_pid).unwrap();
        parent
            .signals
            .set_handler(SIGUSR1, SignalHandler::Ignore)
            .unwrap();
        parent
            .signals
            .set_handler(SIGUSR2, SignalHandler::Ignore)
            .unwrap();

        // Reset SIGUSR1 to SIG_DFL via SETSIGDEF; leave SIGUSR2 alone.
        let sigdef = 1u64 << (SIGUSR1 - 1);
        let attrs = SpawnAttrs {
            flags: attr_flags::SETSIGDEF,
            pgrp: 0,
            sigdef,
            sigmask: 0,
        };
        let mut host = test_host::NoopHost;
        let cpid = table
            .spawn_child_for_caller(
                parent_pid,
                parent_pid,
                &[b"a".as_slice()],
                &[],
                &[],
                &attrs,
                &mut host,
            )
            .unwrap();

        let child = table.get(cpid).unwrap();
        assert_eq!(child.signals.get_handler(SIGUSR1), SignalHandler::Default);
        assert_eq!(child.signals.get_handler(SIGUSR2), SignalHandler::Ignore);
    }

    #[test]
    fn fork_count_bumps_on_successful_fork() {
        use crate::process_table::ProcessTable;
        let mut table = ProcessTable::new();
        assert_eq!(table.create_process().unwrap(), 100);
        // Sanity: counter starts at 0.
        assert_eq!(table.get(100).unwrap().fork_count(), 0);

        assert_eq!(
            table.fork_process_for_caller(100, 100).expect("first fork"),
            101
        );
        assert_eq!(table.get(100).unwrap().fork_count(), 1);

        assert_eq!(
            table
                .fork_process_for_caller(100, 100)
                .expect("second fork"),
            102
        );
        assert_eq!(table.get(100).unwrap().fork_count(), 2);

        // Children's counters are independent and start at 0 — they have not
        // forked themselves.
        assert_eq!(table.get(101).unwrap().fork_count(), 0);
        assert_eq!(table.get(102).unwrap().fork_count(), 0);
    }

    #[test]
    fn test_alloc_pipe_reuses_freed_slots() {
        let mut proc = Process::new(1);
        assert!(proc.pipes.is_empty());

        // Allocate first pipe
        let idx0 = proc.alloc_pipe(PipeBuffer::new(64));
        assert_eq!(idx0, 0);
        let idx1 = proc.alloc_pipe(PipeBuffer::new(64));
        assert_eq!(idx1, 1);
        assert_eq!(proc.pipes.len(), 2);

        // Free slot 0
        proc.pipes[0] = None;

        // Next alloc should reuse slot 0
        let idx2 = proc.alloc_pipe(PipeBuffer::new(64));
        assert_eq!(idx2, 0);
        assert_eq!(proc.pipes.len(), 2); // No growth
    }

    #[test]
    fn test_alloc_pipe_pair_reuses_consecutive_slots() {
        let mut proc = Process::new(1);

        // Allocate 4 pipes (2 pairs)
        let (a, b) = proc.alloc_pipe_pair(PipeBuffer::new(64), PipeBuffer::new(64));
        assert_eq!((a, b), (0, 1));
        let (c, d) = proc.alloc_pipe_pair(PipeBuffer::new(64), PipeBuffer::new(64));
        assert_eq!((c, d), (2, 3));
        assert_eq!(proc.pipes.len(), 4);

        // Free first pair
        proc.pipes[0] = None;
        proc.pipes[1] = None;

        // Next pair should reuse slots 0,1
        let (e, f) = proc.alloc_pipe_pair(PipeBuffer::new(64), PipeBuffer::new(64));
        assert_eq!((e, f), (0, 1));
        assert_eq!(proc.pipes.len(), 4); // No growth
    }

    #[test]
    fn test_alloc_pipe_pair_skips_non_consecutive_free_slots() {
        let mut proc = Process::new(1);

        // Allocate 4 individual pipes
        for _ in 0..4 {
            proc.alloc_pipe(PipeBuffer::new(64));
        }
        assert_eq!(proc.pipes.len(), 4);

        // Free only slots 0 and 2 (not consecutive)
        proc.pipes[0] = None;
        proc.pipes[2] = None;

        // Pair allocation needs consecutive slots, should append
        let (a, b) = proc.alloc_pipe_pair(PipeBuffer::new(64), PipeBuffer::new(64));
        assert_eq!((a, b), (4, 5));
        assert_eq!(proc.pipes.len(), 6);
    }

    #[test]
    fn process_signal_metadata_distinguishes_kill_from_sigqueue() {
        use wasm_posix_shared::signal::SIGUSR1;

        let mut proc = Process::new(100);
        proc.raise_signal_with_metadata(SIGUSR1, 0, 0, 41, 42);
        let plain = proc.consume_signal_for(proc.pid, SIGUSR1).unwrap();
        assert_eq!(plain.si_code, 0);
        assert_eq!(plain.si_value_bits, 0);
        assert_eq!((plain.sender_pid, plain.sender_uid), (41, 42));

        proc.raise_signal_with_metadata(SIGUSR1, 0x1234, -1, 51, 52);
        let queued = proc.consume_signal_for(proc.pid, SIGUSR1).unwrap();
        assert_eq!(queued.si_code, -1);
        assert_eq!(queued.si_value_bits, 0x1234);
        assert_eq!((queued.sender_pid, queued.sender_uid), (51, 52));
    }
}
