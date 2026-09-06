//! Process table for the kernel.
//!
//! A single kernel instance manages all processes. The `ProcessTable` maps
//! PIDs to `Process` structs, allowing the kernel to service syscalls for
//! any process based on the PID passed via `kernel_handle_channel`.
//!
//! Operations:
//! - `create_process` — create a new empty process
//! - `fork_process_for_caller` — clone a parent after exact-task validation
//! - `remove_process` — remove a process from the table
//! - `bind_current_tid` — validate the exact task being serviced

extern crate alloc;

use alloc::collections::BTreeMap;
use alloc::vec::Vec;
use core::cell::UnsafeCell;
use core::sync::atomic::AtomicI32;

use wasm_posix_shared::Errno;
use wasm_posix_shared::flags::O_ACCMODE;

use crate::credentials::Credentials;
use crate::lock::AdvisoryLockManager;
use crate::ofd::FileType;
#[cfg(test)]
use crate::process::ThreadInfo;
use crate::process::{ChildWaitEvent, Process, ProcessState, StdioConfig};
use crate::socket::SocketState;

const INITIAL_FORK_STATE_BUFFER_LEN: usize = 64 * 1024;
const MAX_FORK_STATE_BUFFER_LEN: usize = 4 * 1024 * 1024;
pub const SYNTHETIC_INIT_PID: u32 = 1;
const FIRST_TASK_ID: u32 = 100;
const MAX_TASK_ID: u32 = i32::MAX as u32;

/// A fresh machine-wide task identity minted by [`ProcessTable`].
///
/// The private field and absence of `Copy`/`Clone` make this a linear safe-Rust
/// capability: production process/thread constructors must consume it, while
/// code outside this module cannot manufacture or duplicate one.
pub struct AllocatedTaskId(u32);

impl AllocatedTaskId {
    pub fn as_raw(&self) -> u32 {
        self.0
    }

    pub fn into_raw(self) -> u32 {
        self.0
    }
}

/// Owning pid of `/dev/fb0`, or `-1` if no process holds it.
///
/// `/dev/fb0` is single-open; the second `open` while another process
/// holds the device returns `EBUSY`. The owner is released when the
/// owning process closes its last `/dev/fb0` fd, calls `munmap` on its
/// framebuffer region, or exits.
pub static FB0_OWNER: AtomicI32 = AtomicI32::new(-1);

/// Table of all processes managed by the kernel.
///
/// Each process is identified by its pid. The current pid/tid pair is a
/// short-lived, validated dispatch binding for one syscall channel; it is not
/// an alternate process selector or identity authority.
///
/// Production callers cannot create a second task-ID allocator:
///
/// ```compile_fail
/// use kandelo_kernel::process_table::ProcessTable;
/// let _ = ProcessTable::new();
/// ```
pub struct ProcessTable {
    #[cfg(not(test))]
    processes: BTreeMap<u32, Process>,
    // Cross-module unit tests build Process fixtures directly. Production
    // code cannot bypass the guarded accessors below.
    #[cfg(test)]
    pub processes: BTreeMap<u32, Process>,
    /// Sole machine-wide authority for POSIX, OFD, and flock advisory locks.
    advisory_locks: AdvisoryLockManager,
    current_pid: u32,
    /// Next machine-wide process or thread identity to consider.
    ///
    /// This cursor is monotonic and remains ahead of every identity ever
    /// allocated by this kernel instance. `MAX_TASK_ID + 1` is the exhausted
    /// sentinel, so successful IDs always fit in the positive `i32` ABI.
    next_task_id: u32,
    /// Kernel/libc thread id for the syscall currently being serviced.
    ///
    /// The host already selected a syscall channel by its `channelOffset`; this
    /// field supplies the POSIX thread identity that cannot be inferred from the
    /// `kernel_handle_channel(pid)` call. Production bindings always use an
    /// explicit positive task ID; `0` remains an internal unit-test sentinel.
    ///
    /// This is ambient dispatch context for the current serialized kernel call.
    /// If a single kernel instance ever services channels concurrently or
    /// reentrantly, the TID should move into the syscall header or be passed as
    /// an explicit `kernel_handle_channel` argument.
    current_tid: u32,
    /// Process that owns `current_tid` for the pending serialized dispatch.
    /// Keeping the pair prevents a stale or misrouted host dispatch from
    /// applying one process's valid TID to another process.
    current_tid_pid: u32,
    /// Round-robin cursor for host-bridged TCP listener target selection.
    tcp_listener_rr: BTreeMap<u16, usize>,
}

/// Outcome of `ProcessTable::remove_process`. Bundles the side effects the
/// caller must drain after the removed process has been consumed here. The
/// caller is `kernel_remove_process`, which has access to the raw host-close
/// externs; this layer doesn't.
pub struct RemoveProcessResult {
    /// Whether the removed process had a live framebuffer mapping that the
    /// host must unbind. The owned `Process` deliberately does not escape the
    /// table: otherwise it could replace a different table entry wholesale
    /// and smuggle its immutable PID under the wrong map key.
    pub had_framebuffer_binding: bool,
    /// Host file handles whose cross-process refcount reached 0 during
    /// teardown. The caller must invoke `host_close(h)` on each.
    pub host_closes: Vec<i64>,
    /// Per-process directory-iteration handles that were still open during
    /// teardown. These are never inherited across fork, so every retained
    /// handle must be closed by the caller.
    pub host_dir_closes: Vec<i64>,
    /// Host net handles whose cross-process refcount reached 0 during
    /// teardown. The caller must invoke `host_net_close(h)` on each —
    /// this kernel-side bookkeeping intentionally doesn't touch the
    /// host trait so `process_table.rs` stays host-agnostic.
    pub host_net_closes: Vec<i32>,
}

/// Subset of parent state inherited by a `posix_spawn` child. Captured up
/// front under an immutable `&parent` borrow so the rest of `spawn_child`
/// can mutate `self.processes` freely.
struct SpawnInheritFromParent {
    credentials: Credentials,
    pgid: u32,
    sid: u32,
    umask: u32,
    nice: i32,
    rlimits: [[u64; 2]; 16],
    cwd: Vec<u8>,
    blocked_signals: u64,
    /// Bitmask of signals (1..=64) where the parent's disposition is
    /// `SIG_IGN`. POSIX exec preserves SIG_IGN across the boundary while
    /// resetting custom handlers to SIG_DFL — spawn applies the same
    /// rule. SIGKILL and SIGSTOP can't be set to ignored, so they
    /// can't appear here.
    ignored_signals: u64,
    fd_table: crate::fd::FdTable,
    ofd_table: crate::ofd::OfdTable,
    sockets: crate::socket::SocketTable,
}

/// Return each socket-table slot owned by at least one live OFD, exactly once.
///
/// `peer_idx` is not authority to retain another slot. Only a socket OFD
/// inherited through the child's descriptor table is an owning root.
fn socket_indices_named_by_live_ofds(process: &Process) -> Result<Vec<usize>, Errno> {
    let socket_ofd_count = process
        .ofd_table
        .iter()
        .filter(|(_, ofd)| ofd.file_type == FileType::Socket)
        .count();
    let mut indices = Vec::new();
    indices
        .try_reserve_exact(socket_ofd_count)
        .map_err(|_| Errno::ENOMEM)?;
    for (_, ofd) in process.ofd_table.iter() {
        if ofd.file_type != FileType::Socket {
            continue;
        }
        let index = crate::socket::SocketTable::index_from_ofd_handle(ofd.host_handle)?;
        if process.sockets.get(index).is_none() {
            return Err(Errno::EBADF);
        }
        if !indices.contains(&index) {
            indices.push(index);
        }
    }
    Ok(indices)
}

/// Allocation-free ownership query for process teardown.
fn socket_index_is_named_by_live_ofd(process: &Process, socket_index: usize) -> bool {
    process.ofd_table.iter().any(|(_, ofd)| {
        ofd.file_type == FileType::Socket
            && crate::socket::SocketTable::index_from_ofd_handle(ofd.host_handle)
                == Ok(socket_index)
    })
}

/// Bump cross-process refcounts on resources the child inherited from the
/// parent (host file handles, global pipes, PTYs, and the global pipes
/// referenced by sockets with `global_pipes`).
///
/// Both fork and spawn need this — once a child holds a reference to any of
/// these shared resources, the parent closing or exiting must not free them
/// out from under the child.
///
/// The function operates only on global tables and the child's own state,
/// so it does not need access to `ProcessTable`. `parent_pid` identifies the
/// exact source owner when copying machine-wide INET binding ownership.
pub fn bump_inherited_resource_refcounts(
    parent_pid: u32,
    child: &Process,
) -> Result<(), Errno> {
    // Resolve and deduplicate every fallible socket root before the first
    // machine-wide refcount mutation. An allocation or malformed handle must
    // fail without requiring rollback of unrelated inherited resources.
    let owned_socket_indices = socket_indices_named_by_live_ofds(child)?;

    // Backings for eventfd/timerfd/signalfd/memfd/procfs are indexed by the
    // inherited OFD's stable negative handle. Add these fallible references
    // first, rolling them back if a stale handle is encountered, before
    // touching the older infallible global-resource refcounts below.
    let inherited_ofd_count = child.ofd_table.iter().count();
    let mut shared_backings_bumped: Vec<(FileType, i64)> = Vec::new();
    shared_backings_bumped
        .try_reserve_exact(inherited_ofd_count)
        .map_err(|_| Errno::ENOMEM)?;
    let mut unix_registry_owners_added = Vec::new();
    unix_registry_owners_added
        .try_reserve_exact(owned_socket_indices.len())
        .map_err(|_| Errno::ENOMEM)?;
    for (_idx, ofd) in child.ofd_table.iter() {
        match crate::descriptor_backing::add_ref_for_ofd(ofd.file_type, ofd.host_handle) {
            Ok(true) => shared_backings_bumped.push((ofd.file_type, ofd.host_handle)),
            Ok(false) => {}
            Err(err) => {
                for (file_type, host_handle) in shared_backings_bumped.into_iter().rev() {
                    crate::descriptor_backing::release_for_ofd(file_type, host_handle);
                }
                return Err(err);
            }
        }
    }

    // A bound socket's historical sockaddr can be stale after rename+reuse.
    // Inherit only from the exact parent owner tuple. This operation can
    // allocate, so rollback both earlier registry additions and descriptor
    // backing refs before returning an error.
    for &sock_idx in &owned_socket_indices {
        let sock = child
            .sockets
            .get(sock_idx)
            .expect("validated socket OFD lost its table slot");
        if sock.bind_path.is_none() {
            continue;
        }
        let result = unsafe { crate::unix_socket::global_unix_socket_registry() }
            .add_inherited_owner(parent_pid, sock_idx, child.pid, sock_idx);
        match result {
            Ok(true) => unix_registry_owners_added.push(sock_idx),
            Ok(false) => {}
            Err(err) => {
                let registry =
                    unsafe { crate::unix_socket::global_unix_socket_registry() };
                for added_sock_idx in unix_registry_owners_added.into_iter().rev() {
                    registry.remove_owner_exact(child.pid, added_sock_idx);
                }
                for (file_type, host_handle) in shared_backings_bumped.into_iter().rev() {
                    crate::descriptor_backing::release_for_ofd(file_type, host_handle);
                }
                return Err(err);
            }
        }
    }

    let pipe_table = unsafe { crate::pipe::global_pipe_table() };

    // Pipe-OFDs (host_handle is the negative-encoded global pipe index).
    for (_idx, ofd) in child.ofd_table.iter() {
        if ofd.file_type == FileType::Pipe && ofd.host_handle < 0 {
            let pipe_idx = (-(ofd.host_handle + 1)) as usize;
            if let Some(pipe) = pipe_table.get_mut(pipe_idx) {
                if let Some(kind) = pipe.reference_kind(ofd.status_flags()) {
                    pipe.add_reference(kind);
                }
            }
        }
    }

    // Host file handles (regular files / dirs / chardevs / pipe-via-host).
    for (_idx, ofd) in child.ofd_table.iter() {
        if ofd.host_handle >= 0 {
            match ofd.file_type {
                FileType::Regular | FileType::Directory | FileType::CharDevice | FileType::Pipe => {
                    crate::ofd::host_handle_fork_ref(ofd.host_handle);
                }
                _ => {}
            }
        }
    }

    // PTYs.
    for (_idx, ofd) in child.ofd_table.iter() {
        match ofd.file_type {
            FileType::PtyMaster => {
                let pty_idx = ofd.host_handle as usize;
                if let Some(pty) = crate::pty::get_pty(pty_idx) {
                    pty.master_refs += 1;
                }
            }
            FileType::PtySlave => {
                let pty_idx = ofd.host_handle as usize;
                if let Some(pty) = crate::pty::get_pty(pty_idx) {
                    pty.slave_refs += 1;
                }
            }
            _ => {}
        }
    }

    // Global pipes referenced by socket OFDs (cross-process loopback).
    for (_idx, ofd) in child.ofd_table.iter() {
        if ofd.file_type == FileType::Socket && ofd.host_handle < 0 {
            let sock_idx = (-(ofd.host_handle + 1)) as usize;
            if let Some(sock) = child.sockets.get(sock_idx) {
                if sock.global_pipes {
                    if let Some(send_idx) = sock.send_buf_idx {
                        if let Some(pipe) = pipe_table.get_mut(send_idx) {
                            pipe.add_writer();
                        }
                    }
                    if let Some(recv_idx) = sock.recv_buf_idx {
                        if let Some(pipe) = pipe_table.get_mut(recv_idx) {
                            pipe.add_reader();
                        }
                    }
                }
            }
        }
    }

    // Shared listener backlog, host_net_handle, INET binding ownership, and
    // AF_UNIX registry ownership belong only to socket slots named by live
    // child OFDs. `peer_idx` is not a capability: acquiring ownership for its
    // target would let CLOFORK or retry-only peer state survive in a child
    // that inherited no descriptor for it.
    let backlog_table = unsafe { crate::socket::shared_listener_backlog_table() };
    for sock_idx in owned_socket_indices {
        let sock = child
            .sockets
            .get(sock_idx)
            .expect("validated socket OFD lost its table slot");
        crate::socket::inherit_inet_binding_owners(parent_pid, child.pid, sock_idx);
        if let Some(shared_idx) = sock.shared_backlog_idx {
            backlog_table.add_ref(shared_idx);
        }
        if let Some(net_handle) = sock.host_net_handle {
            crate::socket::host_net_handle_fork_ref(net_handle);
        }
    }

    Ok(())
}

/// Build the fork-only `fork_pipe_replay` table: a list of (read_fd,
/// write_fd) pairs so that when the child resumes through fork rewind,
/// `sys_pipe` returns the same fd numbers the parent saw.
/// Spawn doesn't replay code, so this stays fork-local.
fn build_fork_pipe_replay(child: &Process) -> Vec<(i32, i32)> {
    use alloc::collections::BTreeMap;
    let mut pipe_fd_pairs: BTreeMap<usize, (i32, i32)> = BTreeMap::new();
    for (fd, entry) in child.fd_table.iter() {
        if let Some(ofd) = child.ofd_table.get(entry.ofd_ref.0) {
            if ofd.file_type == FileType::Pipe && ofd.host_handle < 0 {
                let pipe_idx = (-(ofd.host_handle + 1)) as usize;
                if unsafe { crate::pipe::global_pipe_table().get(pipe_idx) }
                    .is_some_and(crate::pipe::PipeBuffer::is_fifo)
                {
                    continue;
                }
                let access_mode = ofd.status_flags() & O_ACCMODE;
                let pair = pipe_fd_pairs.entry(pipe_idx).or_insert((-1, -1));
                if access_mode == wasm_posix_shared::flags::O_RDONLY {
                    pair.0 = fd;
                } else {
                    pair.1 = fd;
                }
            }
        }
    }
    pipe_fd_pairs.into_values().collect()
}

fn serialize_fork_state_with_growing_buffer(parent: &Process) -> Result<Vec<u8>, Errno> {
    let mut len = INITIAL_FORK_STATE_BUFFER_LEN;

    loop {
        let mut buf = Vec::new();
        buf.resize(len, 0u8);

        match crate::fork::serialize_fork_state(parent, &mut buf) {
            Ok(written) => {
                buf.truncate(written);
                return Ok(buf);
            }
            Err(Errno::ENOMEM) if len < MAX_FORK_STATE_BUFFER_LEN => {
                len = len.saturating_mul(2).min(MAX_FORK_STATE_BUFFER_LEN);
            }
            Err(err) => return Err(err),
        }
    }
}

impl ProcessTable {
    const fn new_inner() -> Self {
        ProcessTable {
            processes: BTreeMap::new(),
            advisory_locks: AdvisoryLockManager::new(),
            current_pid: 0,
            next_task_id: FIRST_TASK_ID,
            current_tid: 0,
            current_tid_pid: 0,
            tcp_listener_rr: BTreeMap::new(),
        }
    }

    /// Construct the one production process table owned by the kernel.
    #[cfg(not(test))]
    const fn new() -> Self {
        Self::new_inner()
    }

    /// Construct an isolated process-table fixture.
    #[cfg(test)]
    pub const fn new() -> Self {
        Self::new_inner()
    }

    /// Create a new process with captured, pipe-backed stdio and add it to
    /// the table.
    ///
    /// Also lazily registers a virtual init process (pid 1) if absent. Init has
    /// no worker — it exists so that `kill(1, ...)` and `sched_*(1, ...)` from
    /// user processes resolve to a real target owned by root, enabling EPERM
    /// checks to fire instead of ESRCH.
    pub fn create_process(&mut self) -> Result<u32, Errno> {
        self.create_process_with_stdio(StdioConfig::captured())
    }

    /// Create a new process with explicit stdio wiring and add it to the table.
    pub fn create_process_with_stdio(&mut self, stdio: StdioConfig) -> Result<u32, Errno> {
        self.ensure_init();
        let task_id = self.allocate_task_id()?;
        let pid = task_id.as_raw();
        self.processes
            .insert(pid, Process::new_allocated_with_stdio(task_id, stdio));
        Ok(pid)
    }

    /// Ensure the virtual init process (pid 1) is present. Idempotent.
    pub fn ensure_init(&mut self) {
        if !self.processes.contains_key(&SYNTHETIC_INIT_PID) {
            // PID 1 is a reserved kernel identity rather than an allocation
            // from the user task sequence, so mint its capability here at the
            // sole identity-authority boundary.
            let mut init = Process::new_allocated(AllocatedTaskId(SYNTHETIC_INIT_PID));
            init.ppid = 0;
            init.argv.push(alloc::vec::Vec::from(b"init".as_slice()));
            // PID 1 is an addressable kernel identity, not a schedulable
            // process. It must not own normal-process descriptors or terminal
            // state that could later be mutated or cleaned up by a host path.
            init.fd_table = crate::fd::FdTable::new();
            init.ofd_table = crate::ofd::OfdTable::new();
            init.terminal.foreground_pgid = 0;
            self.processes.insert(SYNTHETIC_INIT_PID, init);
        }
    }

    /// Remove a process from the table.
    /// Cleans up all cross-process resources: pipe ref counts, socket pipes,
    /// and listening socket backlogs in the global pipe table.
    pub fn remove_process(&mut self, pid: u32) -> Option<RemoveProcessResult> {
        let result = self.remove_process_inner(pid, false)?;
        self.prune_empty_limbo_groups();
        Some(result)
    }

    /// Reap a wait-consumed process from the table. If it is still the
    /// process-group leader for remaining members, keep a resource-free limbo
    /// record so getpgid/setpgid can still address the leader until the group
    /// empties.
    pub fn reap_process(&mut self, pid: u32) -> Option<RemoveProcessResult> {
        let result = self.remove_process_inner(pid, true)?;
        self.prune_empty_limbo_groups();
        Some(result)
    }

    fn remove_process_inner(
        &mut self,
        pid: u32,
        retain_limbo_leader: bool,
    ) -> Option<RemoveProcessResult> {
        // PID 1 is the kernel-reserved synthetic init identity. It is outside
        // the allocatable task sequence and must remain present for the entire
        // kernel instance rather than being removed and lazily recreated.
        if pid == SYNTHETIC_INIT_PID {
            return None;
        }
        let mut proc = self.processes.remove(&pid)?;
        // Whole-process teardown consumes the OFD table itself, but retry
        // bindings can also own machine-global MQ/IPC pins and SCM_RIGHTS
        // references. Drop those before the ordinary backing walk and its
        // deferred ancillary cleanup boundary.
        crate::syscalls::discard_blocking_retry_bindings_for_process_removal(&mut proc);
        let _ = unsafe { crate::pipe::global_pipe_table().cancel_fifo_opens_for_process(pid) };
        let mut host_closes: Vec<i64> = Vec::new();
        let mut host_dir_closes: Vec<i64> = Vec::new();
        let mut host_net_closes: Vec<i32> = Vec::new();

        // Keep the global pipe-table borrow in a strict lexical scope. Closing
        // a final read end can drop queued SCM_RIGHTS entries, whose Drop impl
        // only appends fixed deferred metadata. The real cleanup below runs
        // after this scope ends and may safely re-enter the pipe table.
        {
            let pipe_table = unsafe { crate::pipe::global_pipe_table() };

            // Clean up pipe OFDs: decrement ref counts in the global pipe table.
            // Each OFD represents one pipe endpoint (one reader or one writer),
            // regardless of how many FDs point to it (ofd.ref_count).
            for (_ofd_idx, ofd) in proc.ofd_table.iter() {
                if ofd.file_type == FileType::Pipe && ofd.host_handle < 0 {
                    let pipe_idx = (-(ofd.host_handle + 1)) as usize;
                    if let Some(pipe) = pipe_table.get_mut(pipe_idx) {
                        if let Some(kind) = pipe.reference_kind(ofd.status_flags()) {
                            pipe.close_reference(kind);
                        }
                    }
                    pipe_table.free_if_closed(pipe_idx);
                }
            }
        }

        // Clean up PTY OFDs: decrement master/slave refcounts on PTY pairs.
        for (_ofd_idx, ofd) in proc.ofd_table.iter() {
            match ofd.file_type {
                FileType::PtyMaster => {
                    let pty_idx = ofd.host_handle as usize;
                    if let Some(pty) = crate::pty::get_pty(pty_idx) {
                        if pty.master_refs > 0 {
                            pty.master_refs -= 1;
                        }
                        if !pty.is_alive() {
                            crate::pty::free_pty(pty_idx);
                        }
                    }
                }
                FileType::PtySlave => {
                    let pty_idx = ofd.host_handle as usize;
                    if let Some(pty) = crate::pty::get_pty(pty_idx) {
                        if pty.slave_refs > 0 {
                            pty.slave_refs -= 1;
                        }
                        if !pty.is_alive() {
                            crate::pty::free_pty(pty_idx);
                        }
                    }
                }
                _ => {}
            }
        }

        // Drop kernel-global eventfd/timerfd/signalfd/memfd/procfs backing
        // references for every OFD the process still owns. Normal exit closes
        // fds first; this also covers crash removal and spawn rollback.
        for (_ofd_idx, ofd) in proc.ofd_table.iter() {
            crate::descriptor_backing::release_for_ofd(ofd.file_type, ofd.host_handle);
        }

        // Drop host-backed file and directory handles that a process still
        // owned when it was removed without reaching sys_exit (worker crash,
        // explicit host termination, or failed fork/spawn launch). Normal
        // exit closes every fd first, so these lists are empty on the zombie
        // reaping path. Fork/spawn share positive host handles by refcount;
        // only the last process queues the underlying host_close.
        for (_ofd_idx, ofd) in proc.ofd_table.iter() {
            if ofd.dir_host_handle >= 0 {
                host_dir_closes.push(ofd.dir_host_handle);
            }
            if ofd.host_handle < 0 {
                continue;
            }
            if matches!(
                ofd.file_type,
                FileType::Regular | FileType::Directory | FileType::CharDevice | FileType::Pipe
            ) && crate::ofd::host_handle_close_ref(ofd.host_handle)
            {
                host_closes.push(ofd.host_handle);
            }
        }
        for stream in proc.dir_streams.iter().flatten() {
            host_dir_closes.push(stream.host_handle);
        }

        // Clean up socket OFDs. Active TCP streams use the same orderly FIN
        // and orphaned receive state as close(2); other socket kinds close
        // their pipe endpoints directly.
        // Without this, a peer process reading from a connected socket would
        // block forever instead of getting EOF when this process exits.
        //
        // NOTE: refcount drops for shared_backlog_idx and host_net_handle
        // happen in the separate per-socket loop below — once per socket
        // entry, not once per Socket OFD. That matches the per-socket bump
        // in `bump_inherited_resource_refcounts` and stays consistent
        // regardless of fd-dup count.
        {
            let pipe_table = unsafe { crate::pipe::global_pipe_table() };
            for (_ofd_idx, ofd) in proc.ofd_table.iter() {
                if ofd.file_type == FileType::Socket && ofd.host_handle < 0 {
                    let sock_idx = (-(ofd.host_handle + 1)) as usize;
                    if let Some(sock) = proc.sockets.get(sock_idx) {
                        if sock.global_pipes {
                            let orderly_tcp_close = matches!(
                                (sock.domain, sock.sock_type),
                                (
                                    crate::socket::SocketDomain::Inet
                                        | crate::socket::SocketDomain::Inet6,
                                    crate::socket::SocketType::Stream,
                                )
                            );
                            // Cross-process socket: close pipe ends in global table
                            if let Some(send_idx) = sock.send_buf_idx {
                                if let Some(pipe) = pipe_table.get_mut(send_idx) {
                                    pipe.close_write_end();
                                }
                                pipe_table.free_if_closed(send_idx);
                            }
                            if let Some(recv_idx) = sock.recv_buf_idx {
                                if let Some(pipe) = pipe_table.get_mut(recv_idx) {
                                    if orderly_tcp_close {
                                        pipe.close_read_end_orderly();
                                    } else {
                                        pipe.close_read_end();
                                    }
                                }
                                pipe_table.free_if_closed(recv_idx);
                            }
                        }
                        // Clean up unaccepted connections in listen backlog
                        for &backlog_sock_idx in &sock.listen_backlog {
                            if let Some(backlog_sock) = proc.sockets.get(backlog_sock_idx) {
                                if backlog_sock.global_pipes {
                                    if let Some(send_idx) = backlog_sock.send_buf_idx {
                                        if let Some(pipe) = pipe_table.get_mut(send_idx) {
                                            pipe.close_write_end();
                                        }
                                        pipe_table.free_if_closed(send_idx);
                                    }
                                    if let Some(recv_idx) = backlog_sock.recv_buf_idx {
                                        if let Some(pipe) = pipe_table.get_mut(recv_idx) {
                                            pipe.close_read_end();
                                        }
                                        pipe_table.free_if_closed(recv_idx);
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }

        // Drop cross-process refcounts for socket-side resources, once per
        // deduplicated OFD-named socket root. Mirrors the root-only bump in
        // `bump_inherited_resource_refcounts` so a fork/spawn parent and
        // child each contribute exactly one ref on inheritance and one
        // drop on exit. Sockets that the process closed via sys_close are
        // already removed from `proc.sockets` (sys_close calls
        // `sockets.free` on its happy path), so this loop visits only
        // owning roots the process held until exit.
        let shared_backlog_table = unsafe { crate::socket::shared_listener_backlog_table() };
        for sock_idx in 0..proc.sockets.len() {
            // A process-local slot without a live OFD never acquired these
            // machine-wide inherited references, so teardown must not
            // decrement them.
            if !socket_index_is_named_by_live_ofd(&proc, sock_idx) {
                continue;
            }
            if let Some(sock) = proc.sockets.get(sock_idx) {
                if let Some(shared_idx) = sock.shared_backlog_idx {
                    shared_backlog_table.dec_ref(shared_idx);
                }
                if let Some(net_handle) = sock.host_net_handle {
                    if crate::socket::host_net_handle_close_ref(net_handle) {
                        host_net_closes.push(net_handle);
                    }
                }
            }
        }

        // WHY: AF_UNIX datagrams can own retained SCM_RIGHTS descriptors.
        // `proc` remains live until this function returns, but the deferred
        // release queue is drained below. Drop every queued datagram now so
        // crash/forced-removal cleanup observes those releases in this same
        // transaction rather than leaving them for an unrelated later syscall.
        for sock_idx in 0..proc.sockets.len() {
            if let Some(sock) = proc.sockets.get_mut(sock_idx) {
                sock.dgram_queue.clear();
            }
        }

        // Clean up mqueue notifications for this process
        let mq_table = unsafe { crate::mqueue::global_mqueue_table() };
        mq_table.cleanup_process(pid);

        // Clean up Unix socket registry entries for this process
        let unix_reg = unsafe { crate::unix_socket::global_unix_socket_registry() };
        unix_reg.cleanup_process(pid);

        // Clean up AF_INET bind table entries for sockets the process held.
        crate::socket::udp_cleanup_process(pid);
        crate::socket::udp6_cleanup_process(pid);
        crate::socket::tcp_cleanup_process(pid);
        crate::socket::tcp6_cleanup_process(pid);

        // Release any PTHREAD_PROCESS_SHARED primitives owned by this pid
        // so peers aren't wedged on mutexes or waiter queues.
        let pshared = unsafe { crate::pshared::global_pshared_table() };
        pshared.cleanup_process(pid);

        // A final read-end close above may have discarded queued SCM_RIGHTS
        // entries. Release their real resource references only after all
        // PipeTable borrows have ended, and collect host closes for the caller.
        let mut deferred_lock_state_changed = false;
        while let Some(release) = crate::pipe::pop_deferred_in_flight_release() {
            let released = crate::pipe::release_deferred_in_flight_resource(release);
            if let Some(handle) = released.host_close {
                host_closes.push(handle);
            }
            if released.final_ofd_reference {
                deferred_lock_state_changed |=
                    self.advisory_locks.remove_ofd(released.ofd_id).changed;
            }
        }

        // POSIX locks are process-owned and disappear on every exit/removal.
        // OFD/flock locks disappear only when no other machine process still
        // references that stable open-file-description identity, including a
        // descriptor currently queued in SCM_RIGHTS ancillary data.
        let mut lock_state_changed =
            deferred_lock_state_changed | self.advisory_locks.remove_process(pid).changed;
        for (_, ofd) in proc.ofd_table.iter() {
            let still_referenced = self.processes.values().any(|other| {
                other
                    .ofd_table
                    .iter()
                    .any(|(_, candidate)| candidate.ofd_id == ofd.ofd_id)
            }) || crate::ofd::has_in_flight_ofd(ofd.ofd_id);
            if !still_referenced {
                lock_state_changed |= self.advisory_locks.remove_ofd(ofd.ofd_id).changed;
            }
        }
        if lock_state_changed {
            crate::wakeup::push_advisory_lock();
        }

        // Drop SysV shared-memory attachments that were still live when the
        // process exited or was reaped.
        let ipc = unsafe { crate::ipc::global_ipc_table() };
        for mapping in &proc.shm_mappings {
            let _ = ipc.shmdt(mapping.shmid, pid);
        }

        if retain_limbo_leader && proc.pgid == pid && self.group_has_member(pid) {
            self.processes.insert(pid, Self::limbo_process_from(&proc));
        }

        Some(RemoveProcessResult {
            had_framebuffer_binding: proc.fb_binding.is_some(),
            host_closes,
            host_dir_closes,
            host_net_closes,
        })
    }

    fn group_has_member(&self, pgid: u32) -> bool {
        self.processes.iter().any(|(&pid, proc)| {
            pid != pgid && proc.pgid == pgid && proc.state != ProcessState::Limbo
        })
    }

    fn limbo_process_from(proc: &Process) -> Process {
        let mut limbo = Process::new_allocated(AllocatedTaskId(proc.pid));
        limbo.ppid = proc.ppid;
        limbo.install_credentials(proc.credentials().clone());
        limbo.secure_exec = proc.secure_exec;
        limbo.exec_generation = proc.exec_generation;
        limbo.pgid = proc.pgid;
        limbo.sid = proc.sid;
        limbo.is_session_leader = proc.is_session_leader;
        limbo.state = ProcessState::Limbo;
        limbo.exit_status = proc.exit_status;
        limbo.exit_signal = proc.exit_signal;
        limbo.cwd = proc.cwd.clone();
        limbo.environ = proc.environ.clone();
        limbo.argv = proc.argv.clone();
        limbo.umask = proc.umask;
        limbo.nice = proc.nice;
        limbo.rlimits = proc.rlimits;
        limbo.thread_name = proc.thread_name;
        limbo.has_exec = proc.has_exec;

        // Limbo records must not own any resources because teardown already
        // ran for the real process.
        limbo.fd_table = crate::fd::FdTable::new();
        limbo.ofd_table = crate::ofd::OfdTable::new();
        limbo
    }

    pub fn prune_empty_limbo_groups(&mut self) {
        let limbo_pids: Vec<u32> = self
            .processes
            .iter()
            .filter(|(pid, proc)| {
                let pid = **pid;
                proc.state == ProcessState::Limbo && proc.pgid == pid && !self.group_has_member(pid)
            })
            .map(|(pid, _)| *pid)
            .collect();

        for pid in limbo_pids {
            self.processes.remove(&pid);
        }
    }

    /// Get the current pid.
    pub fn current_pid(&self) -> u32 {
        if self.has_current_tid_binding(self.current_pid) {
            self.current_pid
        } else {
            0
        }
    }

    /// Bind the current kernel/libc thread id for the next serialized dispatch.
    ///
    /// The host transports the channel-to-TID association, but it cannot mint
    /// that identity: a non-main TID must already belong to the addressed live
    /// Process. The process PID explicitly names the main thread; zero is not
    /// accepted at this host-callable boundary.
    pub fn bind_current_tid(&mut self, pid: u32, tid: u32) -> Result<(), Errno> {
        // Every bind attempt supersedes any earlier ambient authority, even
        // when validation fails. Otherwise a stale same-PID binding could
        // authorize the next mailbox after a rejected replacement attempt.
        self.clear_current_tid_binding();
        self.validate_task(pid, tid)?;
        self.current_pid = pid;
        self.current_tid = tid;
        self.current_tid_pid = pid;
        self.processes
            .get_mut(&pid)
            .expect("validated process disappeared during serialized bind")
            .blocked_retries
            .bind_task(tid);
        Ok(())
    }

    /// Validate an exact live task without installing ambient dispatch state.
    ///
    /// Host registration uses this read-only query before attaching transport
    /// metadata. Only `bind_current_tid` may create the one-shot authority used
    /// by `kernel_handle_channel`.
    pub fn validate_task(&self, pid: u32, tid: u32) -> Result<(), Errno> {
        if pid == SYNTHETIC_INIT_PID {
            return Err(Errno::ESRCH);
        }
        let process = self.processes.get(&pid).ok_or(Errno::ESRCH)?;
        if !matches!(process.state, ProcessState::Running | ProcessState::Stopped)
            || !process.is_live_explicit_tid(tid)
        {
            return Err(Errno::ESRCH);
        }
        Ok(())
    }

    /// Whether the next channel dispatch has an explicit, live task binding
    /// for exactly `pid`.
    pub fn has_current_tid_binding(&self, pid: u32) -> bool {
        if self.current_tid_pid != pid || self.current_tid == 0 {
            return false;
        }
        self.processes.get(&pid).is_some_and(|process| {
            matches!(process.state, ProcessState::Running | ProcessState::Stopped)
                && process.is_live_explicit_tid(self.current_tid)
        })
    }

    /// Consume the ambient task binding after one serialized channel call.
    /// A stale binding must never authorize a later mailbox dispatch.
    pub fn clear_current_tid_binding(&mut self) {
        if self.current_tid_pid != 0 {
            if let Some(process) = self.processes.get_mut(&self.current_tid_pid) {
                process
                    .blocked_retries
                    .clear_bound_task(self.current_tid);
            }
        }
        self.current_pid = 0;
        self.current_tid = 0;
        self.current_tid_pid = 0;
    }

    /// Set synthetic dispatch state in unit tests that exercise a standalone
    /// `Process` without installing it in the global ProcessTable.
    #[cfg(test)]
    pub fn set_current_tid_for_test(&mut self, tid: u32) {
        self.current_tid = tid;
        self.current_tid_pid = 0;
    }

    /// Get the current kernel/libc thread id (0 for main thread).
    pub fn current_tid(&self) -> u32 {
        // `current_tid_pid == 0` is reserved for isolated unit-test dispatch
        // state installed by `set_current_tid_for_test`.
        if self.current_tid_pid == 0 {
            return self.current_tid;
        }
        if self.current_tid_pid != self.current_pid {
            return 0;
        }
        let Some(process) = self.processes.get(&self.current_pid) else {
            return 0;
        };
        if matches!(process.state, ProcessState::Exited | ProcessState::Limbo) {
            return 0;
        }
        if process.is_main_thread(self.current_tid)
            || process.get_thread(self.current_tid).is_some()
        {
            self.current_tid
        } else {
            0
        }
    }

    /// Get a mutable reference to the current process.
    pub fn current_process(&mut self) -> Option<&mut Process> {
        let pid = self.current_pid;
        if !self.has_current_tid_binding(pid) {
            return None;
        }
        self.processes.get_mut(&pid)
    }

    /// Borrow the current process and machine-wide lock manager together.
    /// These references are safe and disjoint because they originate from
    /// separate `ProcessTable` fields.
    pub fn current_process_and_advisory_locks(
        &mut self,
    ) -> Option<(&mut Process, &mut AdvisoryLockManager)> {
        let pid = self.current_pid;
        if !self.has_current_tid_binding(pid) {
            return None;
        }
        let processes = &mut self.processes;
        let advisory_locks = &mut self.advisory_locks;
        processes
            .get_mut(&pid)
            .map(|process| (process, advisory_locks))
    }

    /// Borrow an addressed process and the lock manager as disjoint fields.
    pub fn process_and_advisory_locks(
        &mut self,
        pid: u32,
    ) -> Option<(&mut Process, &mut AdvisoryLockManager)> {
        if pid == SYNTHETIC_INIT_PID {
            return None;
        }
        let processes = &mut self.processes;
        let advisory_locks = &mut self.advisory_locks;
        processes
            .get_mut(&pid)
            .map(|process| (process, advisory_locks))
    }

    /// Borrow an ordinary process only when `tid` names one of its exact live
    /// kernel-owned tasks. This is the mutation boundary for host operations
    /// that carry explicit `(pid, tid)` transport metadata instead of using a
    /// channel dispatch binding.
    pub fn task_and_advisory_locks(
        &mut self,
        pid: u32,
        tid: u32,
    ) -> Option<(&mut Process, &mut AdvisoryLockManager)> {
        if pid == SYNTHETIC_INIT_PID {
            return None;
        }
        let processes = &mut self.processes;
        let advisory_locks = &mut self.advisory_locks;
        let process = processes.get_mut(&pid)?;
        if !process.is_live_explicit_tid(tid) {
            return None;
        }
        Some((process, advisory_locks))
    }

    #[cfg(test)]
    pub fn advisory_locks(&self) -> &AdvisoryLockManager {
        &self.advisory_locks
    }

    /// Borrow the machine lock manager for resource cleanup that has no live
    /// process owner, such as a direct host-pipe operation dropping queued
    /// SCM_RIGHTS. This is crate-private so callers cannot bypass the
    /// process-and-lock paired access used by ordinary syscalls.
    pub fn advisory_locks_mut(&mut self) -> &mut AdvisoryLockManager {
        &mut self.advisory_locks
    }

    /// Get a mutable reference to a process by pid.
    pub fn get_mut(&mut self, pid: u32) -> Option<&mut Process> {
        if pid == SYNTHETIC_INIT_PID {
            return None;
        }
        self.processes.get_mut(&pid)
    }

    /// Fork a process on behalf of a kernel-validated task in that process.
    pub fn fork_process_for_caller(
        &mut self,
        parent_pid: u32,
        caller_tid: u32,
    ) -> Result<u32, Errno> {
        self.fork_process_for_caller_with_mode(
            parent_pid,
            caller_tid,
            wasm_posix_shared::fork_contract::Mode::Fork,
        )
    }

    /// Fork a process with an explicit host address-space lifetime mode.
    ///
    /// Both modes inherit identical POSIX process state. The vfork marker is
    /// kernel-internal authority that rejects creation of another process or
    /// pthread owner while the child still borrows its parent's Memory.
    pub fn fork_process_for_caller_with_mode(
        &mut self,
        parent_pid: u32,
        caller_tid: u32,
        mode: wasm_posix_shared::fork_contract::Mode,
    ) -> Result<u32, Errno> {
        let (serialized_parent, caller_blocked) = {
            let parent = self.processes.get(&parent_pid).ok_or(Errno::ESRCH)?;
            if matches!(
                parent.state,
                crate::process::ProcessState::Exited | crate::process::ProcessState::Limbo
            ) {
                return Err(Errno::ESRCH);
            }
            if !parent.is_live_explicit_tid(caller_tid) {
                return Err(Errno::ESRCH);
            }
            if parent.vfork_child {
                return Err(Errno::EAGAIN);
            }
            (
                serialize_fork_state_with_growing_buffer(parent)?,
                parent.blocked_for(caller_tid),
            )
        };

        let child_task_id = self.allocate_task_id()?;
        let child_pid = child_task_id.as_raw();

        // Install fork state into a record whose identity capability was
        // already allocated here; the deserializer cannot select a PID.
        let mut child = Process::new_allocated_empty(child_task_id);
        crate::fork::deserialize_allocated_fork_state(&serialized_parent, &mut child)?;
        // WHY: bytes preserve an OfdId and scalar snapshot, not object
        // identity. Relink before publication so fork and vfork inherit the
        // parent's exact open file description instead of a matching copy.
        child.ofd_table.link_shared_states_from(
            &self
                .processes
                .get(&parent_pid)
                .ok_or(Errno::ESRCH)?
                .ofd_table,
        )?;
        // POSIX fork leaves one thread in the child, and that thread inherits
        // the mask of the task that called fork rather than the process
        // leader's mask.
        child.signals.blocked = caller_blocked;
        child.vfork_child = mode == wasm_posix_shared::fork_contract::Mode::Vfork;

        // Bump cross-process refcounts on inherited fd state (host handles,
        // global pipes, PTYs, socket-pipes). Identical to spawn's needs —
        // factored out into a free helper.
        bump_inherited_resource_refcounts(parent_pid, &child)?;

        // Build fork-only `fork_pipe_replay` (fork replay needs it to
        // return the same fds as the parent did when re-running
        // pre-fork code). Spawn doesn't replay, so this stays fork-local.
        child.fork_pipe_replay = build_fork_pipe_replay(&child);

        self.processes.insert(child_pid, child);

        // Parent's fork-counter regression guardrail. The non-forking spawn
        // tests assert this stays put across a SYS_SPAWN, proving the new
        // path doesn't fall back to fork.
        if let Some(parent) = self.processes.get_mut(&parent_pid) {
            parent.increment_fork_count();
        }

        Ok(child_pid)
    }

    /// Non-forking spawn on behalf of a kernel-validated task in the parent.
    pub fn spawn_child_for_caller(
        &mut self,
        parent_pid: u32,
        caller_tid: u32,
        argv: &[&[u8]],
        envp: &[&[u8]],
        file_actions: &[crate::spawn::FileAction],
        attrs: &crate::spawn::SpawnAttrs,
        host: &mut dyn crate::process::HostIO,
    ) -> Result<u32, Errno> {
        // Snapshot inheritable parent state under an immutable borrow.
        let inherit = {
            let parent = self.processes.get(&parent_pid).ok_or(Errno::ESRCH)?;
            if matches!(
                parent.state,
                crate::process::ProcessState::Exited | crate::process::ProcessState::Limbo
            ) {
                return Err(Errno::ESRCH);
            }
            if !parent.is_live_explicit_tid(caller_tid) {
                return Err(Errno::ESRCH);
            }
            if parent.vfork_child {
                return Err(Errno::EAGAIN);
            }
            // Compute the SIG_IGN-disposition bitmask for signals 1..=64.
            let mut ignored_signals: u64 = 0;
            for sig in 1u32..=64 {
                if parent.signals.get_handler(sig) == crate::signal::SignalHandler::Ignore {
                    ignored_signals |= 1u64 << (sig - 1);
                }
            }
            SpawnInheritFromParent {
                credentials: parent.credentials().clone(),
                pgid: parent.pgid,
                sid: parent.sid,
                umask: parent.umask,
                nice: parent.nice,
                rlimits: parent.rlimits,
                cwd: parent.cwd.clone(),
                blocked_signals: parent.blocked_for(caller_tid),
                ignored_signals,
                fd_table: parent.fd_table.clone(),
                ofd_table: parent.ofd_table.clone(),
                sockets: parent.sockets.clone(),
            }
        };

        let child_task_id = self.allocate_task_id()?;
        let child_pid = child_task_id.as_raw();
        let mut child = Process::new_allocated(child_task_id);

        // ── POSIX-required inheritance ─────────────────────────────────
        child.ppid = parent_pid;
        child.install_credentials(inherit.credentials);
        child.pgid = inherit.pgid; // POSIX_SPAWN_SETPGROUP may override (Task 9).
        child.sid = inherit.sid; // POSIX_SPAWN_SETSID may override (Task 9).
        child.umask = inherit.umask;
        child.nice = inherit.nice;
        child.rlimits = inherit.rlimits;
        child.cwd = inherit.cwd;

        // The new program's argv/envp come from the spawn caller.
        child.argv = argv.iter().map(|s| s.to_vec()).collect();
        child.environ = envp.iter().map(|s| s.to_vec()).collect();

        // Parent's fd state replaces the fresh process fd table; spawn
        // inherits the parent's open fds instead of creating new stdio.
        // The constructor-created OFDs at indices 0/1/2 are dropped here
        // without decrementing any global refcount because they never
        // bumped one.
        child.fd_table = inherit.fd_table;
        child.ofd_table = inherit.ofd_table;
        child.sockets = inherit.sockets;

        // Retry pins are kernel capabilities owned by the parent task, not
        // descriptors inherited by a new process. Rebuild local OFD counts
        // from the child's actual fd aliases before acquiring any shared
        // backing references, then keep only the socket graph those OFDs own.
        child.ofd_table.retain_fd_references(&child.fd_table)?;
        let socket_roots = socket_indices_named_by_live_ofds(&child)?;
        child.sockets.retain_inherited_roots(&socket_roots)?;

        // A host directory iterator is process-local mutable state, not part
        // of the positive backing-handle ownership that fork/spawn refcount.
        // Cloning it here would give parent and child one host handle with
        // independent pending-record/cookie metadata, and either process
        // could close the iterator out from under the other. Preserve the
        // snapshot cookie instead; the child lazily reopens and replays to it
        // on its first getdents64 call.
        for (_, ofd) in child.ofd_table.iter_mut() {
            ofd.reset_directory_iterator_for_reopen();
        }

        // Signal state inheritance:
        //   * Blocked mask: inherited from parent unless SETSIGMASK overrides.
        //   * Handlers: parent's custom handlers reset to SIG_DFL (POSIX exec
        //     semantics); SIG_IGN dispositions are preserved across the
        //     implicit exec; SETSIGDEF (below) can force named signals back
        //     to SIG_DFL.
        child.signals.blocked = inherit.blocked_signals;
        for sig in 1u32..=64 {
            if (inherit.ignored_signals & (1u64 << (sig - 1))) != 0 {
                // SIGKILL/SIGSTOP can never be ignored, so they can't appear
                // in this mask; set_handler still rejects them — ignore Err.
                let _ = child
                    .signals
                    .set_handler(sig, crate::signal::SignalHandler::Ignore);
            }
        }

        // Apply spawn attrs in POSIX order (RESETIDS → SETSID → SETPGROUP
        // → SETSIGMASK → SETSIGDEF). All operate on local Process state
        // and are infallible; happens before file actions, before insertion.
        {
            use crate::spawn::attr_flags;
            if attrs.flags & attr_flags::RESETIDS != 0 {
                child.reset_effective_ids_to_real();
            }
            if attrs.flags & attr_flags::SETSID != 0 {
                child.sid = child.pid;
                child.pgid = child.pid;
                child.is_session_leader = true;
                // POSIX also releases the controlling tty here. The spawn
                // child starts from fresh terminal state, so there's no ctty
                // to release.
            }
            if attrs.flags & attr_flags::SETPGROUP != 0 {
                child.pgid = if attrs.pgrp == 0 {
                    child.pid
                } else {
                    attrs.pgrp as u32
                };
            }
            if attrs.flags & attr_flags::SETSIGMASK != 0 {
                child.signals.blocked = attrs.sigmask;
            }
            if attrs.flags & attr_flags::SETSIGDEF != 0 {
                for sig in 1u32..=64 {
                    if (attrs.sigdef & (1u64 << (sig - 1))) != 0 {
                        // SIGKILL/SIGSTOP set_handler rejects — ignore Err
                        // (those signals are always SIG_DFL anyway).
                        let _ = child
                            .signals
                            .set_handler(sig, crate::signal::SignalHandler::Default);
                    }
                }
            }
        }

        // Bump cross-process refcounts on the inherited fd state. The same
        // helper fork uses — this is the genuinely-shared concern.
        bump_inherited_resource_refcounts(parent_pid, &child)?;

        // The child is a real kernel process and signal target, but the
        // parent has not received a successful posix_spawn result yet. Wait
        // selection must not consume it until the host completes the exact
        // target launch transaction and publishes that result.
        child.spawn_publication_pending = true;
        self.processes.insert(child_pid, child);

        // Apply file actions in forward order against the child. Any failure
        // rolls back the partial child via remove_process — which runs the
        // proper exit cleanup (decrements every refcount we bumped, drops
        // any newly-opened fds, queues last-ref host net handles for close).
        if let Err(e) = self.apply_spawn_file_actions(child_pid, file_actions, host) {
            if let Some(removed) = self.remove_process(child_pid) {
                for dir_handle in removed.host_dir_closes {
                    let _ = host.host_closedir(dir_handle);
                }
                for handle in removed.host_closes {
                    let _ = host.host_close(handle);
                }
                for net_handle in removed.host_net_closes {
                    let _ = host.host_net_close(net_handle);
                }
            }
            return Err(e);
        }

        Ok(child_pid)
    }

    /// Apply a list of `posix_spawn` file actions to the child process,
    /// in the order given. Each action is dispatched to the existing
    /// `sys_*` helper that takes `&mut Process`. On error, returns the
    /// errno; the caller (`spawn_child`) is responsible for cleanup.
    fn apply_spawn_file_actions(
        &mut self,
        child_pid: u32,
        file_actions: &[crate::spawn::FileAction],
        host: &mut dyn crate::process::HostIO,
    ) -> Result<(), Errno> {
        use crate::spawn::FileAction;
        for action in file_actions {
            let (child, advisory_locks) = self
                .process_and_advisory_locks(child_pid)
                .ok_or(Errno::ESRCH)?;
            match action {
                FileAction::Close { fd } => {
                    // POSIX: close errors are silently ignored for spawn.
                    let _ = crate::syscalls::sys_close_with_locks(child, advisory_locks, host, *fd);
                }
                FileAction::Dup2 { srcfd, fd } => {
                    if srcfd == fd {
                        // POSIX dup2(N,N) clears FD_CLOEXEC if N is open;
                        // EBADF otherwise.
                        let entry = child.fd_table.get_mut(*fd)?;
                        entry.fd_flags &= !wasm_posix_shared::fd_flags::FD_CLOEXEC;
                    } else {
                        let _ = crate::syscalls::sys_dup2_with_locks(
                            child,
                            advisory_locks,
                            host,
                            *srcfd,
                            *fd,
                        )?;
                    }
                }
                FileAction::Open {
                    fd,
                    path,
                    oflag,
                    mode,
                } => {
                    let opened =
                        crate::syscalls::sys_open(child, host, path, *oflag as u32, *mode)?;
                    if opened != *fd {
                        // Move opened fd to the requested target slot.
                        let r = crate::syscalls::sys_dup2_with_locks(
                            child,
                            advisory_locks,
                            host,
                            opened,
                            *fd,
                        );
                        // Always close the temporary fd, even if dup2 failed —
                        // we don't want to leak it on the error path.
                        let _ = crate::syscalls::sys_close_with_locks(
                            child,
                            advisory_locks,
                            host,
                            opened,
                        );
                        let _ = r?;
                    }
                }
                FileAction::Chdir { path } => {
                    crate::syscalls::sys_chdir(child, host, path)?;
                }
                FileAction::Fchdir { fd } => {
                    crate::syscalls::sys_fchdir(child, *fd)?;
                }
            }
        }

        // FD_CLOEXEC closure is part of the exact prepared-target commit, not
        // child construction. Keeping it there lets final-target preparation
        // observe the descriptor state produced by the one file-action pass.
        Ok(())
    }

    /// Allocate the sole machine-wide POSIX task identity.
    ///
    /// Process IDs and pthread thread IDs share this monotonically increasing
    /// namespace. IDs are never reused within a kernel instance, including
    /// after process reaping or thread exit. Exhaustion is reported instead of
    /// wrapping into reserved IDs or the negative half of the `i32` ABI.
    fn allocate_task_id(&mut self) -> Result<AllocatedTaskId, Errno> {
        let mut candidate = self.next_task_id;
        while candidate <= MAX_TASK_ID {
            let in_use = self.processes.contains_key(&candidate)
                || self
                    .processes
                    .values()
                    .any(|process| process.get_thread(candidate).is_some());
            if !in_use {
                self.next_task_id = candidate + 1;
                return Ok(AllocatedTaskId(candidate));
            }
            candidate += 1;
        }
        self.next_task_id = MAX_TASK_ID + 1;
        Err(Errno::EAGAIN)
    }

    /// Create a pthread task in an existing live process.
    pub fn create_thread(
        &mut self,
        pid: u32,
        caller_tid: u32,
        stack_ptr: usize,
        tls_ptr: usize,
        ctid_ptr: usize,
    ) -> Result<u32, Errno> {
        let inherited_blocked = {
            let process = self.processes.get(&pid).ok_or(Errno::ESRCH)?;
            if matches!(process.state, ProcessState::Exited | ProcessState::Limbo) {
                return Err(Errno::ESRCH);
            }
            if !process.is_live_explicit_tid(caller_tid) {
                return Err(Errno::ESRCH);
            }
            process.blocked_for(caller_tid)
        };
        let task_id = self.allocate_task_id()?;
        let tid = task_id.as_raw();
        let process = self.processes.get_mut(&pid).ok_or(Errno::ESRCH)?;
        let thread_info = process.add_allocated_thread(task_id, ctid_ptr, stack_ptr, tls_ptr);
        thread_info.signals.blocked = inherited_blocked;
        Ok(tid)
    }

    /// Get a reference to a process by pid.
    pub fn get(&self, pid: u32) -> Option<&Process> {
        self.processes.get(&pid)
    }

    /// Iterate live, ordinary processes from newest to oldest identity.
    ///
    /// Keeping lifecycle filtering here prevents kernel subsystems from
    /// treating the immutable synthetic init record or retained exited records
    /// as runnable processes while scanning machine-wide state.
    pub fn live_processes_descending(&self) -> impl Iterator<Item = (u32, &Process)> {
        self.processes.iter().rev().filter_map(|(&pid, process)| {
            if pid == SYNTHETIC_INIT_PID
                || matches!(process.state, ProcessState::Exited | ProcessState::Limbo)
            {
                None
            } else {
                Some((pid, process))
            }
        })
    }

    /// Find the process record that owns a retained Linux-style task ID.
    ///
    /// A process leader's TID is its PID; pthread TIDs live in the owning
    /// Process record. Exited leaders remain addressable until reaped, while a
    /// Limbo record is only an internal process-group/session placeholder.
    pub fn get_process_containing_task(&self, tid: u32) -> Option<&Process> {
        if tid == SYNTHETIC_INIT_PID {
            return None;
        }
        if let Some(leader) = self
            .processes
            .get(&tid)
            .filter(|process| process.state != ProcessState::Limbo)
        {
            return Some(leader);
        }

        self.processes.values().find(|process| {
            matches!(process.state, ProcessState::Running | ProcessState::Stopped)
                && process.get_thread(tid).is_some()
        })
    }

    /// Collect every retained PID, including internal limbo identities.
    pub fn all_pids(&self) -> Vec<u32> {
        self.processes.keys().copied().collect()
    }

    /// Walk every live host handle held inside kernel memory.
    ///
    /// Emits one `(pid, fd, kind, handle)` tuple per open file description
    /// slot holding a non-negative handle, per descriptor that can reach it.
    /// A handle shared by dup, fork, or spawn appears once per (pid, fd)
    /// naming it, so a reader sees the sharing and deduplicates by
    /// (kind, handle). Negative handles are kernel-internal encodings
    /// (sockets, backing tables, synthetic and sentinel values) and are
    /// never emitted. `kind` 0 names the stream slot (`host_handle`),
    /// `kind` 1 the directory iterator slot (`dir_host_handle`).
    pub fn enumerate_host_handles(&self, emit: &mut dyn FnMut(u32, i32, u32, i64)) {
        for (&pid, proc) in self.processes.iter() {
            for (fd, entry) in proc.fd_table.iter() {
                let Some(ofd) = proc.ofd_table.get(entry.ofd_ref.0) else {
                    continue;
                };
                if ofd.host_handle >= 0 {
                    emit(pid, fd, 0, ofd.host_handle);
                }
                if ofd.dir_host_handle >= 0 {
                    emit(pid, fd, 1, ofd.dir_host_handle);
                }
            }
        }
    }

    /// Serialize [`Self::enumerate_host_handles`] for the host.
    ///
    /// Wire format (all integers little-endian):
    ///
    ///   u32  count
    ///   for each record (20 bytes):
    ///     u32  pid
    ///     u32  fd
    ///     u32  kind
    ///     i64  handle
    ///
    /// Returns total bytes written, or `ENOSPC` when `out` is too small.
    pub fn write_host_handle_records(&self, out: &mut [u8]) -> Result<usize, Errno> {
        const RECORD_SIZE: usize = 4 + 4 + 4 + 8;
        let mut records: usize = 0;
        self.enumerate_host_handles(&mut |_, _, _, _| records += 1);
        let need = 4 + records * RECORD_SIZE;
        if out.len() < need {
            return Err(Errno::ENOSPC);
        }
        out[0..4].copy_from_slice(&(records as u32).to_le_bytes());
        let mut off = 4usize;
        self.enumerate_host_handles(&mut |pid, fd, kind, handle| {
            out[off..off + 4].copy_from_slice(&pid.to_le_bytes());
            out[off + 4..off + 8].copy_from_slice(&(fd as u32).to_le_bytes());
            out[off + 8..off + 12].copy_from_slice(&kind.to_le_bytes());
            out[off + 12..off + 20].copy_from_slice(&handle.to_le_bytes());
            off += RECORD_SIZE;
        });
        Ok(off)
    }

    /// Rewrite every open file description slot of `kind` that holds
    /// `old_handle` to `new_handle`, machine-wide.
    ///
    /// A restored machine's kernel memory still names the captured machine's
    /// host handles. The receiver reopens each host resource, then remaps the
    /// old handle to the fresh one here. Rewriting by value in one call keeps
    /// dup-, fork-, and spawn-shared descriptions shared: every slot naming
    /// the old handle moves together, and the cross-process refcount entry
    /// moves with them.
    ///
    /// `kind` 0 names the stream slot (`host_handle`: files, host-delegated
    /// pipes, host-backed devices); `kind` 1 names the directory iterator
    /// slot (`dir_host_handle`). Negative handles are kernel-internal
    /// encodings, never host identities, so both handles must be
    /// non-negative. Returns the number of rewritten slots, `EINVAL` for a
    /// bad kind or a negative handle, `EEXIST` when a different resource
    /// already answers to `new_handle` (rewriting would merge two host
    /// identities under one number), and `EBADF` when no slot holds
    /// `old_handle`. An identity remap (`old_handle == new_handle`) is
    /// legal: a deterministic receiver can reopen into the same number.
    pub fn remap_host_handles(
        &mut self,
        kind: u32,
        old_handle: i64,
        new_handle: i64,
    ) -> Result<u32, Errno> {
        if kind > 1 || old_handle < 0 || new_handle < 0 {
            return Err(Errno::EINVAL);
        }
        fn slot_of(kind: u32, ofd: &mut crate::ofd::OpenFileDesc) -> &mut i64 {
            if kind == 0 {
                &mut ofd.host_handle
            } else {
                &mut ofd.dir_host_handle
            }
        }
        if new_handle != old_handle {
            for proc in self.processes.values_mut() {
                for (_, ofd) in proc.ofd_table.iter_mut() {
                    if *slot_of(kind, ofd) == new_handle {
                        return Err(Errno::EEXIST);
                    }
                }
            }
        }
        let mut rewritten: u32 = 0;
        for proc in self.processes.values_mut() {
            for (_, ofd) in proc.ofd_table.iter_mut() {
                let slot = slot_of(kind, ofd);
                if *slot == old_handle {
                    *slot = new_handle;
                    rewritten += 1;
                }
            }
        }
        if rewritten == 0 {
            return Err(Errno::EBADF);
        }
        if kind == 0 && new_handle != old_handle {
            crate::ofd::host_handle_migrate_refs(old_handle, new_handle);
        }
        Ok(rewritten)
    }

    /// Name the PTY pair serving as `pid`'s terminal.
    ///
    /// A restored kernel memory carries the whole PTY table, but the host's
    /// pid → PTY routing (keyboard input, winsize, output drain) died with
    /// the captured machine. The slave side lives in the process's own file
    /// descriptors, so the lowest slave descriptor names the terminal.
    /// Returns `ESRCH` for a dead pid and `ENOENT` for a process holding no
    /// PTY slave descriptor.
    pub fn pty_index_for_pid(&self, pid: u32) -> Result<u32, Errno> {
        let Some(proc) = self.processes.get(&pid) else {
            return Err(Errno::ESRCH);
        };
        let mut named: Option<(i32, u32)> = None;
        for (fd, entry) in proc.fd_table.iter() {
            let Some(ofd) = proc.ofd_table.get(entry.ofd_ref.0) else {
                continue;
            };
            if ofd.file_type != FileType::PtySlave || ofd.host_handle < 0 {
                continue;
            }
            match named {
                Some((named_fd, _)) if named_fd <= fd => {}
                _ => named = Some((fd, ofd.host_handle as u32)),
            }
        }
        named.map(|(_, pty_idx)| pty_idx).ok_or(Errno::ENOENT)
    }

    /// Collect PIDs that should be visible through procfs.
    ///
    /// Exited processes remain visible as zombies until their parent reaps
    /// them. Limbo entries are already reaped and retained only as internal
    /// process-group/session identities, so exposing them as `/proc/<pid>`
    /// would resurrect a process that no longer exists.
    pub fn procfs_pids(&self) -> Vec<u32> {
        self.processes
            .iter()
            .filter(|(_, proc)| proc.state != ProcessState::Limbo)
            .map(|(&pid, _)| pid)
            .collect()
    }

    /// Collect PIDs of all processes in a given process group.
    pub fn pids_in_group(&self, pgid: u32) -> Vec<u32> {
        self.processes
            .iter()
            .filter(|(_, p)| p.pgid == pgid && p.state != ProcessState::Limbo)
            .map(|(&pid, _)| pid)
            .collect()
    }

    /// Return the host-visible parent pid for a process. An unpublished spawn
    /// child is hidden so an early signal-exit finalizer cannot emit SIGCHLD
    /// before the parent receives the successful spawn result.
    pub fn parent_pid(&self, pid: u32) -> Option<u32> {
        self.processes
            .get(&pid)
            .filter(|proc| !proc.spawn_publication_pending)
            .map(|proc| proc.ppid)
    }

    /// Publish one pending spawn child to its exact parent.
    ///
    /// The result deliberately mirrors `kernel_get_process_exit_signal`: `-1`
    /// means the child is live, `0` is a normal zombie, and a positive value
    /// is the terminating signal. The caller can therefore publish the spawn
    /// result before waking waiters without conflating a live child with the
    /// `-ESRCH` absence error.
    pub fn publish_spawn_child(
        &mut self,
        parent_pid: u32,
        child_pid: u32,
    ) -> Result<i32, Errno> {
        let parent_accepts_publication = self
            .processes
            .get(&parent_pid)
            .is_some_and(|parent| {
                matches!(parent.state, ProcessState::Running | ProcessState::Stopped)
            });
        let child = self.processes.get_mut(&child_pid).ok_or(Errno::ESRCH)?;
        if child.ppid != parent_pid {
            return Err(Errno::ESRCH);
        }
        if !child.spawn_publication_pending {
            return Err(Errno::EINVAL);
        }
        if child.state == ProcessState::Limbo {
            return Err(Errno::ESRCH);
        }
        if !parent_accepts_publication {
            // The exact unpublished child still exists and must be removed by
            // the host's ordinary rollback seam. Distinguish that ownership
            // from ESRCH, which means there is no exact child left to remove.
            return Err(Errno::ECHILD);
        }
        child.spawn_publication_pending = false;
        Ok(if child.state == ProcessState::Exited {
            child.exit_signal as i32
        } else {
            -1
        })
    }

    /// Pick the process/fd that should receive the next host-bridged TCP
    /// connection for `port`.
    ///
    /// JS still owns the actual `net.Server`/service-worker bridge, but the
    /// process table owns which live process currently has an inherited
    /// listening socket. When children inherited a listener through fork,
    /// prefer them over the original parent just as the previous host-side
    /// policy did.
    pub fn pick_tcp_listener_target(
        &mut self,
        port: u16,
        exclude_pid: u32,
    ) -> Option<(u32, i32)> {
        let mut targets = self.tcp_listener_targets(port, exclude_pid);
        if targets.len() > 1 {
            let children: Vec<(u32, i32)> = targets
                .iter()
                .copied()
                .filter(|(pid, _fd)| {
                    self.processes
                        .get(pid)
                        .is_some_and(|proc| proc.ppid > 0)
                })
                .collect();
            if !children.is_empty() {
                targets = children;
            }
        }

        if targets.is_empty() {
            self.tcp_listener_rr.remove(&port);
            return None;
        }

        let idx = self.tcp_listener_rr.get(&port).copied().unwrap_or(0) % targets.len();
        self.tcp_listener_rr.insert(port, idx + 1);
        Some(targets[idx])
    }

    fn tcp_listener_targets(&self, port: u16, exclude_pid: u32) -> Vec<(u32, i32)> {
        let mut targets = Vec::new();
        for (&pid, proc) in &self.processes {
            if pid == exclude_pid || proc.state != ProcessState::Running {
                continue;
            }
            for (fd, entry) in proc.fd_table.iter() {
                let Some(ofd) = proc.ofd_table.get(entry.ofd_ref.0) else {
                    continue;
                };
                if ofd.file_type != FileType::Socket || ofd.host_handle >= 0 {
                    continue;
                }
                let sock_idx = (-(ofd.host_handle + 1)) as usize;
                let Some(sock) = proc.sockets.get(sock_idx) else {
                    continue;
                };
                if sock.state == SocketState::Listening && sock.bind_port == port {
                    targets.push((pid, fd));
                }
            }
        }
        targets
    }

    /// Select the latest status-information record for a direct child.
    /// Nonmatching masks and WNOWAIT leave that single record untouched.
    pub fn poll_wait_event(
        &mut self,
        parent_pid: u32,
        target_pid: i32,
        event_mask: u32,
        flags: u32,
    ) -> Result<Option<(u32, ChildWaitEvent)>, Errno> {
        use wasm_posix_shared::wait::{EVENT_CONTINUED, EVENT_EXITED, EVENT_STOPPED, WNOWAIT};

        let valid_events = EVENT_EXITED | EVENT_STOPPED | EVENT_CONTINUED;
        if event_mask == 0 || event_mask & !valid_events != 0 || flags & !WNOWAIT != 0 {
            return Err(Errno::EINVAL);
        }

        let parent_pgid = self.processes.get(&parent_pid).ok_or(Errno::ESRCH)?.pgid;
        let mut saw_matching_child = false;

        for (&child_pid, child) in &mut self.processes {
            if child_pid == SYNTHETIC_INIT_PID
                || child.ppid != parent_pid
                || child.state == ProcessState::Limbo
            {
                continue;
            }
            if !Self::child_matches_wait_target(child_pid, child, target_pid, parent_pgid) {
                continue;
            }
            saw_matching_child = true;

            // The pending child is real enough to keep a blocking waiter
            // parked, but neither WNOHANG nor a queued waiter may observe or
            // consume its status before posix_spawn publishes the PID/result.
            if child.spawn_publication_pending {
                continue;
            }

            let Some(event) = child.wait_event else {
                continue;
            };
            if event.event_mask & event_mask == 0 {
                continue;
            }
            if flags & WNOWAIT == 0 {
                child.wait_event = None;
            }
            return Ok(Some((child_pid, event)));
        }

        if saw_matching_child {
            Ok(None)
        } else {
            Err(Errno::ECHILD)
        }
    }

    /// True when `child_pid` is an exited direct child of `parent_pid`.
    pub fn is_exited_child_of(&self, parent_pid: u32, child_pid: u32) -> bool {
        self.processes
            .get(&child_pid)
            .map(|child| {
                child.ppid == parent_pid
                    && !child.spawn_publication_pending
                    && child.state == ProcessState::Exited
            })
            .unwrap_or(false)
    }

    fn child_matches_wait_target(
        child_pid: u32,
        child: &Process,
        target_pid: i32,
        parent_pgid: u32,
    ) -> bool {
        if target_pid > 0 {
            return child_pid == target_pid as u32;
        }
        if target_pid == -1 {
            return true;
        }
        if target_pid == 0 {
            return child.pgid == parent_pgid;
        }
        let Some(target_pgid) = target_pid.checked_neg().map(|pid| pid as u32) else {
            return false;
        };
        child.pgid == target_pgid
    }
}

#[cfg(test)]
mod wait_tests {
    use super::*;

    #[test]
    fn spawn_inherits_credentials_as_one_complete_process_record() {
        use crate::credentials::Credentials;
        use crate::process::test_host::NoopHost;
        use crate::spawn::SpawnAttrs;

        let mut table = ProcessTable::new();
        let parent_pid = table.create_process().unwrap();
        let credentials = Credentials {
            ruid: 1000,
            euid: 2000,
            suid: 3000,
            rgid: 4000,
            egid: 5000,
            sgid: 6000,
            supplementary_groups: vec![7000, 8000],
        };
        table
            .get_mut(parent_pid)
            .unwrap()
            .install_credentials(credentials.clone());

        let mut host = NoopHost;
        let spawn_pid = table
            .spawn_child_for_caller(
                parent_pid,
                parent_pid,
                &[b"/bin/child".as_slice()],
                &[],
                &[],
                &SpawnAttrs::empty(),
                &mut host,
            )
            .unwrap();

        assert_eq!(table.get(spawn_pid).unwrap().credentials(), &credentials);
    }

    #[test]
    fn spawn_resetids_changes_only_effective_ids_before_child_publication() {
        use crate::credentials::Credentials;
        use crate::process::test_host::NoopHost;
        use crate::spawn::SpawnAttrs;

        let mut table = ProcessTable::new();
        let parent_pid = table.create_process().unwrap();
        let parent_credentials = Credentials {
            ruid: 1000,
            euid: 2000,
            suid: 3000,
            rgid: 4000,
            egid: 5000,
            sgid: 6000,
            supplementary_groups: vec![7000, 8000],
        };
        table
            .get_mut(parent_pid)
            .unwrap()
            .install_credentials(parent_credentials.clone());

        let attrs = SpawnAttrs {
            flags: wasm_posix_shared::spawn_contract::ATTR_RESETIDS,
            pgrp: 0,
            sigdef: 0,
            sigmask: 0,
        };
        let mut host = NoopHost;
        let child_pid = table
            .spawn_child_for_caller(
                parent_pid,
                parent_pid,
                &[b"/bin/child".as_slice()],
                &[],
                &[],
                &attrs,
                &mut host,
            )
            .unwrap();

        let child = table.get(child_pid).unwrap();
        assert_eq!(
            (
                child.real_uid(),
                child.effective_uid(),
                child.saved_uid(),
                child.real_gid(),
                child.effective_gid(),
                child.saved_gid(),
            ),
            (1000, 1000, 3000, 4000, 4000, 6000),
        );
        assert_eq!(child.supplementary_groups(), &[7000, 8000]);
        assert_eq!(
            table.get(parent_pid).unwrap().credentials(),
            &parent_credentials,
            "spawn attributes must never mutate the parent credential record",
        );
    }

    #[test]
    fn task_ids_are_shared_by_create_clone_fork_and_spawn() {
        use crate::process::test_host::NoopHost;
        use crate::spawn::SpawnAttrs;

        let mut table = ProcessTable::new();
        let parent_pid = table.create_process().unwrap();
        let tid = table
            .create_thread(parent_pid, parent_pid, 0x1000, 0, 0)
            .unwrap();
        let fork_pid = table
            .fork_process_for_caller(parent_pid, parent_pid)
            .unwrap();
        let mut host = NoopHost;
        let spawn_pid = table
            .spawn_child_for_caller(
                parent_pid,
                parent_pid,
                &[b"/bin/child".as_slice()],
                &[],
                &[],
                &SpawnAttrs::empty(),
                &mut host,
            )
            .unwrap();
        let top_level_pid = table.create_process().unwrap();

        assert_eq!(
            [parent_pid, tid, fork_pid, spawn_pid, top_level_pid],
            [100, 101, 102, 103, 104]
        );
        for pid in [parent_pid, fork_pid, spawn_pid, top_level_pid] {
            assert_eq!(
                table.get(pid).unwrap().pid,
                pid,
                "ProcessTable key and immutable process identity diverged"
            );
        }
        assert_eq!(
            table.get(parent_pid).unwrap().get_thread(tid).unwrap().tid,
            tid
        );
        assert_eq!(table.get(fork_pid).unwrap().ppid, parent_pid);
        assert_eq!(table.get(spawn_pid).unwrap().ppid, parent_pid);
    }

    #[test]
    fn fork_and_spawn_inherit_the_kernel_validated_callers_signal_mask() {
        use crate::process::test_host::NoopHost;
        use crate::spawn::SpawnAttrs;

        let mut table = ProcessTable::new();
        let parent_pid = table.create_process().unwrap();
        let caller_tid = table
            .create_thread(parent_pid, parent_pid, 0x1000, 0, 0)
            .unwrap();
        let parent = table.get_mut(parent_pid).unwrap();
        parent.signals.blocked = 0x11;
        parent.get_thread_mut(caller_tid).unwrap().signals.blocked = 0x22;

        let fork_pid = table
            .fork_process_for_caller(parent_pid, caller_tid)
            .unwrap();
        assert_eq!(table.get(fork_pid).unwrap().signals.blocked, 0x22);

        let mut host = NoopHost;
        let spawn_pid = table
            .spawn_child_for_caller(
                parent_pid,
                caller_tid,
                &[b"/bin/child".as_slice()],
                &[],
                &[],
                &SpawnAttrs::empty(),
                &mut host,
            )
            .unwrap();
        assert_eq!(table.get(spawn_pid).unwrap().signals.blocked, 0x22);
    }

    #[test]
    fn vfork_child_rejects_nested_process_owners() {
        use crate::process::test_host::NoopHost;
        use crate::spawn::SpawnAttrs;
        use wasm_posix_shared::fork_contract::Mode;

        let mut table = ProcessTable::new();
        let parent_pid = table.create_process().unwrap();
        let ordinary_child_pid = table
            .fork_process_for_caller_with_mode(parent_pid, parent_pid, Mode::Fork)
            .unwrap();
        assert!(!table.get(ordinary_child_pid).unwrap().vfork_child);

        let child_pid = table
            .fork_process_for_caller_with_mode(parent_pid, parent_pid, Mode::Vfork)
            .unwrap();
        assert!(table.get(child_pid).unwrap().vfork_child);

        assert_eq!(
            table.fork_process_for_caller(child_pid, child_pid),
            Err(Errno::EAGAIN),
        );
        let mut host = NoopHost;
        assert_eq!(
            table.spawn_child_for_caller(
                child_pid,
                child_pid,
                &[b"/bin/child".as_slice()],
                &[],
                &[],
                &SpawnAttrs::empty(),
                &mut host,
            ),
            Err(Errno::EAGAIN),
        );
    }

    #[test]
    fn fork_and_spawn_reject_unallocated_caller_task_ids() {
        use crate::process::test_host::NoopHost;
        use crate::spawn::SpawnAttrs;

        let mut table = ProcessTable::new();
        let parent_pid = table.create_process().unwrap();
        let unknown_tid = parent_pid + 1;

        assert_eq!(
            table.fork_process_for_caller(parent_pid, 0),
            Err(Errno::ESRCH)
        );
        assert_eq!(
            table.fork_process_for_caller(parent_pid, unknown_tid),
            Err(Errno::ESRCH)
        );
        let mut host = NoopHost;
        assert_eq!(
            table.spawn_child_for_caller(
                parent_pid,
                unknown_tid,
                &[b"/bin/child".as_slice()],
                &[],
                &[],
                &SpawnAttrs::empty(),
                &mut host,
            ),
            Err(Errno::ESRCH)
        );
        assert_eq!(
            table.create_process(),
            Ok(unknown_tid),
            "rejected identities must not consume a kernel task ID"
        );
    }

    #[test]
    fn task_id_allocation_skips_retained_processes_and_threads() {
        let mut table = ProcessTable::new();
        let mut zombie = Process::new(100);
        zombie.state = ProcessState::Exited;
        zombie.add_thread(ThreadInfo::new(101, 0, 0, 0));
        table.processes.insert(100, zombie);

        assert_eq!(table.allocate_task_id().map(|id| id.into_raw()), Ok(102));
    }

    #[test]
    fn task_ids_are_not_reused_and_exhaustion_is_reported() {
        let mut table = ProcessTable::new();
        let first_pid = table.create_process().unwrap();
        table.remove_process(first_pid).unwrap();
        assert_eq!(table.create_process(), Ok(first_pid + 1));

        table.next_task_id = MAX_TASK_ID;
        assert_eq!(table.create_process(), Ok(MAX_TASK_ID));
        assert_eq!(table.create_process(), Err(Errno::EAGAIN));
        table.remove_process(MAX_TASK_ID).unwrap();
        assert_eq!(table.create_process(), Err(Errno::EAGAIN));
    }

    #[test]
    fn repeated_spawn_and_reap_preserves_only_live_processes() {
        use crate::process::test_host::NoopHost;
        use crate::spawn::SpawnAttrs;

        let mut table = ProcessTable::new();
        let parent_pid = table.create_process().unwrap();
        let baseline_pids = table.all_pids();
        let mut host = NoopHost;

        for iteration in 0..4_096 {
            let child_pid = table
                .spawn_child_for_caller(
                    parent_pid,
                    parent_pid,
                    &[b"/bin/child".as_slice()],
                    &[],
                    &[],
                    &SpawnAttrs::empty(),
                    &mut host,
                )
                .unwrap_or_else(|error| panic!("spawn {iteration} failed: {error:?}"));
            table.get_mut(child_pid).unwrap().state = ProcessState::Exited;
            table
                .reap_process(child_pid)
                .unwrap_or_else(|| panic!("reap {iteration} lost child {child_pid}"));

            // WHY: task IDs are monotonic identities, not table slots. A
            // completed wait must remove every child-owned process record even
            // after the numeric PID grows into the thousands.
            assert_eq!(table.all_pids(), baseline_pids, "iteration {iteration}");
        }

        assert_eq!(table.get(parent_pid).unwrap().state, ProcessState::Running);
    }

    #[test]
    fn synthetic_init_reservation_cannot_be_removed_or_reaped() {
        use crate::process::test_host::NoopHost;
        use crate::spawn::SpawnAttrs;

        let mut table = ProcessTable::new();
        let first_pid = table.create_process().unwrap();
        assert!(table.get(1).is_some());
        assert!(table.get_process_containing_task(1).is_none());
        assert!(table.get_mut(1).is_none());
        assert!(table.process_and_advisory_locks(1).is_none());
        assert!(table.task_and_advisory_locks(1, 1).is_none());
        assert!(table.current_process().is_none());
        assert!(table.current_process_and_advisory_locks().is_none());

        assert_eq!(table.bind_current_tid(1, 1), Err(Errno::ESRCH));
        assert_eq!(table.create_thread(1, 1, 0, 0, 0), Err(Errno::ESRCH));
        assert_eq!(table.fork_process_for_caller(1, 1), Err(Errno::ESRCH));
        let mut host = NoopHost;
        assert_eq!(
            table.spawn_child_for_caller(
                1,
                1,
                &[b"/bin/child".as_slice()],
                &[],
                &[],
                &SpawnAttrs::empty(),
                &mut host,
            ),
            Err(Errno::ESRCH),
        );
        assert!(table.remove_process(1).is_none());
        assert!(table.reap_process(1).is_none());
        assert!(table.get(1).is_some());
        assert_eq!(table.create_process(), Ok(first_pid + 1));
    }

    #[test]
    fn dispatch_tid_binding_accepts_only_kernel_owned_tasks() {
        let mut table = ProcessTable::new();
        let pid = table.create_process().unwrap();
        let tid = table.create_thread(pid, pid, 0, 0, 0).unwrap();

        assert_eq!(table.bind_current_tid(pid, 0), Err(Errno::ESRCH));
        assert_eq!(table.bind_current_tid(pid, pid), Ok(()));
        assert_eq!(table.bind_current_tid(pid, tid), Ok(()));
        assert_eq!(table.current_tid(), tid);
        assert!(table.has_current_tid_binding(pid));
        assert_eq!(table.get(pid).unwrap().blocked_retries.bound_tid(), Some(tid));

        assert_eq!(table.bind_current_tid(pid, tid + 1), Err(Errno::ESRCH));
        assert!(!table.has_current_tid_binding(pid));
        assert_eq!(table.current_tid(), 0);
        assert_eq!(table.get(pid).unwrap().blocked_retries.bound_tid(), None);

        assert_eq!(table.bind_current_tid(pid, tid), Ok(()));
        table.clear_current_tid_binding();
        assert!(!table.has_current_tid_binding(pid));
        assert_eq!(table.current_pid(), 0);
        assert_eq!(table.current_tid(), 0);
        assert_eq!(table.get(pid).unwrap().blocked_retries.bound_tid(), None);
        assert!(table.current_process().is_none());
        assert!(table.current_process_and_advisory_locks().is_none());

        assert_eq!(table.bind_current_tid(pid + 99, 0), Err(Errno::ESRCH));
        assert_eq!(table.current_pid(), 0);

        assert!(table.task_and_advisory_locks(pid, 0).is_none());
        assert!(table.task_and_advisory_locks(pid, pid + 99).is_none());
        assert!(table.task_and_advisory_locks(pid + 99, pid).is_none());
        assert!(table.task_and_advisory_locks(pid, pid).is_some());
        assert!(table.task_and_advisory_locks(pid, tid).is_some());

        let other_pid = table.create_process().unwrap();
        table.bind_current_tid(other_pid, other_pid).unwrap();
        assert_eq!(table.current_tid(), other_pid);
        table.clear_current_tid_binding();
        assert_eq!(table.current_tid(), 0);

        table.bind_current_tid(pid, tid).unwrap();
        table.get_mut(pid).unwrap().state = ProcessState::Exited;
        assert_eq!(table.current_pid(), 0);
        assert!(table.current_process().is_none());
        assert!(table.current_process_and_advisory_locks().is_none());
        assert!(table.task_and_advisory_locks(pid, pid).is_none());
        assert!(table.task_and_advisory_locks(pid, tid).is_none());
        assert_eq!(table.bind_current_tid(pid, 0), Err(Errno::ESRCH));
        assert_eq!(table.bind_current_tid(pid, tid), Err(Errno::ESRCH));
        assert_eq!(table.current_tid(), 0);
    }

    #[test]
    fn thread_creation_accepts_only_a_live_caller_owned_by_the_process() {
        let mut table = ProcessTable::new();
        let pid = table.create_process().unwrap();
        let other_pid = table.create_process().unwrap();

        assert_eq!(table.create_thread(pid, 9_999, 0, 0, 0), Err(Errno::ESRCH));
        assert_eq!(
            table.create_thread(pid, other_pid, 0, 0, 0),
            Err(Errno::ESRCH)
        );

        assert_eq!(table.create_thread(pid, 0, 0, 0, 0), Err(Errno::ESRCH));
        let creator_tid = table.create_thread(pid, pid, 0, 0, 0).unwrap();
        assert_eq!(creator_tid, other_pid + 1);
        let child_tid = table.create_thread(pid, creator_tid, 0, 0, 0).unwrap();
        assert_eq!(child_tid, creator_tid + 1);

        table.get_mut(pid).unwrap().remove_thread(creator_tid);
        assert_eq!(
            table.create_thread(pid, creator_tid, 0, 0, 0),
            Err(Errno::ESRCH),
        );
        assert_eq!(
            table.create_thread(pid, pid, 0, 0, 0).unwrap(),
            child_tid + 1,
            "rejected caller identities must not consume a task ID",
        );
    }

    #[test]
    fn reap_retains_group_leader_as_limbo_until_group_empties() {
        let mut table = ProcessTable::new();
        assert_eq!(table.create_process().unwrap(), 100);
        assert_eq!(table.fork_process_for_caller(100, 100).unwrap(), 101);
        assert_eq!(table.fork_process_for_caller(100, 100).unwrap(), 102);
        table.processes.get_mut(&101).unwrap().pgid = 101;
        table.processes.get_mut(&102).unwrap().pgid = 101;
        table.processes.get_mut(&101).unwrap().state = ProcessState::Exited;

        assert!(
            table.procfs_pids().contains(&101),
            "an unreaped zombie remains visible through procfs"
        );

        table.reap_process(101).expect("reap group leader");

        let limbo = table.get(101).expect("limbo leader retained");
        assert_eq!(limbo.state, ProcessState::Limbo);
        assert_eq!(limbo.pgid, 101);
        assert_eq!(limbo.ppid, 100);
        assert!(table.all_pids().contains(&101));
        assert!(
            !table.procfs_pids().contains(&101),
            "a reaped limbo identity must not remain visible through procfs"
        );

        table.processes.get_mut(&102).unwrap().state = ProcessState::Exited;
        table.reap_process(102).expect("reap final member");
        assert!(table.get(101).is_none(), "empty limbo group is pruned");
    }

    #[test]
    fn remove_process_does_not_create_limbo_record() {
        let mut table = ProcessTable::new();
        assert_eq!(table.create_process().unwrap(), 100);
        assert_eq!(table.fork_process_for_caller(100, 100).unwrap(), 101);
        assert_eq!(table.fork_process_for_caller(100, 100).unwrap(), 102);
        table.processes.get_mut(&101).unwrap().pgid = 101;
        table.processes.get_mut(&102).unwrap().pgid = 101;
        table.processes.get_mut(&101).unwrap().state = ProcessState::Exited;

        table.remove_process(101).expect("remove group leader");

        assert!(table.get(101).is_none());
        assert_eq!(table.get(102).unwrap().pgid, 101);
    }
}

/// Global process table wrapper for static storage.
pub struct GlobalProcessTable(pub UnsafeCell<ProcessTable>);

/// SAFETY: Access is serialized — the kernel services one syscall at a time
/// from the JS event loop (no concurrent Wasm execution).
unsafe impl Sync for GlobalProcessTable {}

/// Single global `ProcessTable` instance used by the kernel. Lives here
/// (rather than inside `wasm_api.rs`) so other modules can read the
/// currently-serviced `pid`/`tid` without a back-reference through the export
/// layer.
pub static GLOBAL_PROCESS_TABLE: GlobalProcessTable =
    GlobalProcessTable(UnsafeCell::new(ProcessTable::new()));

/// Read the currently-serviced kernel/libc thread id (0 = main thread).
#[inline]
pub fn current_tid() -> u32 {
    unsafe { (*GLOBAL_PROCESS_TABLE.0.get()).current_tid() }
}

/// Read the currently-serviced process id.
#[inline]
pub fn current_pid() -> u32 {
    unsafe { (*GLOBAL_PROCESS_TABLE.0.get()).current_pid() }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exec_target_kernel_table_removal_fallback_closes_each_lease_once() {
        use crate::exec_target::{PreparedExecOwner, PreparedExecTarget};
        use crate::fd::OpenFileDescRef;
        use crate::lock::FileId;
        use wasm_posix_shared::{WasmStat, WasmStatfs};
        use wasm_posix_shared::flags::O_RDONLY;
        use wasm_posix_shared::mode::S_IFREG;
        use wasm_posix_shared::statfs_flags::ST_NOSUID;

        // Host teardown and forced vfork containment both converge on this
        // table-removal fallback after their route-specific host fences. The
        // vfork marker must not change exact OFD retirement here.
        for (case, vfork_child) in [(0i64, false), (1, true)] {
            let handle = 9_452_100 + case;
            let mut table = ProcessTable::new();
            let pid = table.create_process().unwrap();
            let proc = table.get_mut(pid).unwrap();
            proc.vfork_child = vfork_child;
            let ofd_index = proc.ofd_table.create(
                FileType::Regular,
                O_RDONLY,
                handle,
                b"/bin/retained-removal-target".to_vec(),
            );
            let ofd_id = proc.ofd_table.get(ofd_index).unwrap().ofd_id;
            let target = PreparedExecTarget::new(
                PreparedExecOwner::Process {
                    pid,
                    caller_tid: pid,
                    generation: 0,
                },
                OpenFileDescRef(ofd_index),
                ofd_id,
                Some(FileId::Host { dev: 7, ino: 11 }),
                WasmStat {
                    st_dev: 7,
                    st_ino: 11,
                    st_mode: S_IFREG | 0o755,
                    st_nlink: 1,
                    st_uid: 0,
                    st_gid: 0,
                    st_size: 0,
                    st_atime_sec: 0,
                    st_atime_nsec: 0,
                    st_mtime_sec: 0,
                    st_mtime_nsec: 0,
                    st_ctime_sec: 0,
                    st_ctime_nsec: 0,
                    _pad: 0,
                },
                WasmStatfs {
                    f_type: 1,
                    f_bsize: 4096,
                    f_blocks: 1,
                    f_bfree: 0,
                    f_bavail: 0,
                    f_files: 1,
                    f_ffree: 0,
                    f_fsid: 19,
                    f_namelen: 255,
                    f_frsize: 4096,
                    f_flags: ST_NOSUID,
                    _pad: 0,
                },
                b"/bin/retained-removal-target".to_vec(),
            )
            .unwrap();
            proc.prepared_exec_targets.insert(target).unwrap();

            let removed = table.remove_process(pid).unwrap();
            assert_eq!(
                removed
                    .host_closes
                    .iter()
                    .filter(|&&candidate| candidate == handle)
                    .count(),
                1,
            );
            assert_eq!(crate::ofd::host_handle_ref_count(handle), 0);
        }
    }

    #[test]
    fn vfork_child_credential_mutation_isolated_from_parent_record() {
        use wasm_posix_shared::fork_contract::Mode;

        let mut table = ProcessTable::new();
        let parent_pid = table.create_process().unwrap();
        let parent_credentials = Credentials {
            ruid: 1000,
            euid: 0,
            suid: 3000,
            rgid: 4000,
            egid: 5000,
            sgid: 6000,
            supplementary_groups: vec![7000, 8000],
        };
        {
            let parent = table.get_mut(parent_pid).unwrap();
            parent.install_credentials(parent_credentials.clone());
            parent.secure_exec = true;
        }

        let child_pid = table
            .fork_process_for_caller_with_mode(parent_pid, parent_pid, Mode::Vfork)
            .unwrap();
        {
            let child = table.get_mut(child_pid).unwrap();
            assert_eq!(child.credentials(), &parent_credentials);
            assert!(child.secure_exec);
            child.setgroups(&[42, 43]).unwrap();
            child.setresuid(9000, 9001, 9002).unwrap();
            child.secure_exec = false;
        }

        let parent = table.get(parent_pid).unwrap();
        assert_eq!(parent.credentials(), &parent_credentials);
        assert!(parent.secure_exec);
        let child = table.get(child_pid).unwrap();
        assert_eq!(
            (child.real_uid(), child.effective_uid(), child.saved_uid()),
            (9000, 9001, 9002),
        );
        assert_eq!(child.supplementary_groups(), &[42, 43]);
        assert!(!child.secure_exec);
    }

    #[test]
    fn fork_pipe_replay_includes_fds_above_default_nofile_limit() {
        use crate::fd::OpenFileDescRef;
        use wasm_posix_shared::flags::{O_RDONLY, O_WRONLY};

        let mut child = Process::new(100);
        child.fd_table.set_max_fds(4096);
        let read_ofd = child
            .ofd_table
            .create(FileType::Pipe, O_RDONLY, -1, b"pipe-read".to_vec());
        let write_ofd =
            child
                .ofd_table
                .create(FileType::Pipe, O_WRONLY, -1, b"pipe-write".to_vec());
        let read_fd = child
            .fd_table
            .alloc_at_min(OpenFileDescRef(read_ofd), 0, 2048)
            .unwrap();
        let write_fd = child
            .fd_table
            .alloc_at_min(OpenFileDescRef(write_ofd), 0, 2049)
            .unwrap();

        assert_eq!(build_fork_pipe_replay(&child), vec![(read_fd, write_fd)]);
    }

    #[test]
    fn exited_parent_cannot_fork_or_spawn() {
        use crate::process::test_host::NoopHost;
        use crate::spawn::SpawnAttrs;

        let mut table = ProcessTable::new();
        assert_eq!(table.create_process().unwrap(), 100);
        table.get_mut(100).unwrap().state = crate::process::ProcessState::Exited;

        assert_eq!(table.fork_process_for_caller(100, 100), Err(Errno::ESRCH));
        let mut host = NoopHost;
        assert_eq!(
            table.spawn_child_for_caller(
                100,
                100,
                &[b"/bin/child".as_slice()],
                &[],
                &[],
                &SpawnAttrs::empty(),
                &mut host,
            ),
            Err(Errno::ESRCH),
        );
    }

    #[test]
    fn stopped_parent_can_finish_spawn_after_async_resolution() {
        use crate::process::test_host::NoopHost;
        use crate::spawn::SpawnAttrs;
        use wasm_posix_shared::signal::SIGSTOP;

        let mut table = ProcessTable::new();
        assert_eq!(table.create_process().unwrap(), 100);
        assert!(table.get_mut(100).unwrap().record_stop(SIGSTOP));

        // The host resolves a posix_spawn executable asynchronously. A stop
        // can land during that await; the parent remains a live process and
        // the resolved continuation must still be allowed to create its child.
        let mut host = NoopHost;
        let child_pid = table
            .spawn_child_for_caller(
                100,
                100,
                &[b"/bin/child".as_slice()],
                &[],
                &[],
                &SpawnAttrs::empty(),
                &mut host,
            )
            .expect("stopped parent remains eligible to complete spawn");

        assert_eq!(table.get(100).unwrap().state, ProcessState::Stopped);
        assert_eq!(table.get(child_pid).unwrap().ppid, 100);
        assert_eq!(table.get(child_pid).unwrap().state, ProcessState::Running);
    }

    #[test]
    fn spawn_recomputes_child_ofd_refs_without_inheriting_a_sibling_retry_pin() {
        use crate::fd::OpenFileDescRef;
        use crate::process::test_host::NoopHost;
        use crate::spawn::SpawnAttrs;
        use wasm_posix_shared::flags::O_RDONLY;

        const HANDLE: i64 = 9_470_001;

        let mut table = ProcessTable::new();
        let parent_pid = table.create_process().unwrap();
        let caller_tid = table
            .create_thread(parent_pid, parent_pid, 0x1000, 0, 0)
            .unwrap();
        let mut host = NoopHost;
        let (fd, ofd_index, token) = {
            let (parent, locks) = table
                .process_and_advisory_locks(parent_pid)
                .unwrap();
            let ofd_index = parent.ofd_table.create(
                FileType::Regular,
                O_RDONLY,
                HANDLE,
                b"/retry-pinned".to_vec(),
            );
            let fd = parent
                .fd_table
                .alloc(OpenFileDescRef(ofd_index), 0)
                .unwrap();
            let token = crate::syscalls::ensure_blocking_retry_ofd_binding(
                parent,
                locks,
                &mut host,
                parent_pid,
                3,
                fd,
                None,
            )
            .unwrap();
            assert_eq!(parent.ofd_table.get(ofd_index).unwrap().ref_count, 2);
            (fd, ofd_index, token)
        };

        let child_pid = table
            .spawn_child_for_caller(
                parent_pid,
                caller_tid,
                &[b"/bin/child".as_slice()],
                &[],
                &[],
                &SpawnAttrs::empty(),
                &mut host,
            )
            .unwrap();
        let child = table.get(child_pid).unwrap();
        assert_eq!(child.blocked_retries.binding_count(), 0);
        assert_eq!(child.ofd_table.get(ofd_index).unwrap().ref_count, 1);

        {
            let (child, locks) = table
                .process_and_advisory_locks(child_pid)
                .unwrap();
            crate::syscalls::sys_close_with_locks(child, locks, &mut host, fd).unwrap();
            assert!(child.ofd_table.get(ofd_index).is_none());
        }
        assert_eq!(crate::ofd::host_handle_ref_count(HANDLE), 1);

        {
            let (parent, locks) = table
                .process_and_advisory_locks(parent_pid)
                .unwrap();
            crate::syscalls::release_blocking_retry_binding(
                parent,
                locks,
                &mut host,
                parent_pid,
                token,
            )
            .unwrap();
            crate::syscalls::sys_close_with_locks(parent, locks, &mut host, fd).unwrap();
        }
        assert_eq!(crate::ofd::host_handle_ref_count(HANDLE), 0);
    }

    #[test]
    fn fork_and_spawn_exclude_retry_only_ofd_and_socket_state() {
        use crate::process::test_host::NoopHost;
        use crate::spawn::SpawnAttrs;
        use wasm_posix_shared::socket::{AF_INET, SOCK_DGRAM};

        let mut table = ProcessTable::new();
        let parent_pid = table.create_process().unwrap();
        let caller_tid = table
            .create_thread(parent_pid, parent_pid, 0x1000, 0, 0)
            .unwrap();
        let mut host = NoopHost;
        let (ofd_index, socket_index, token) = {
            let (parent, locks) = table
                .process_and_advisory_locks(parent_pid)
                .unwrap();
            let fd =
                crate::syscalls::sys_socket(parent, &mut host, AF_INET, SOCK_DGRAM, 0).unwrap();
            let ofd_index = parent.fd_table.get(fd).unwrap().ofd_ref.0;
            let socket_index = crate::socket::SocketTable::index_from_ofd_handle(
                parent.ofd_table.get(ofd_index).unwrap().host_handle,
            )
            .unwrap();
            let token = crate::syscalls::ensure_blocking_retry_ofd_binding(
                parent,
                locks,
                &mut host,
                parent_pid,
                56,
                fd,
                None,
            )
            .unwrap();
            crate::syscalls::sys_close_with_locks(parent, locks, &mut host, fd).unwrap();
            assert!(parent.ofd_table.get(ofd_index).is_some());
            assert!(parent.sockets.get(socket_index).is_some());
            (ofd_index, socket_index, token)
        };

        let fork_pid = table
            .fork_process_for_caller(parent_pid, caller_tid)
            .unwrap();
        let mut host = NoopHost;
        let spawn_pid = table
            .spawn_child_for_caller(
                parent_pid,
                caller_tid,
                &[b"/bin/child".as_slice()],
                &[],
                &[],
                &SpawnAttrs::empty(),
                &mut host,
            )
            .unwrap();
        for child_pid in [fork_pid, spawn_pid] {
            let child = table.get(child_pid).unwrap();
            assert_eq!(child.blocked_retries.binding_count(), 0);
            assert!(child.ofd_table.get(ofd_index).is_none());
            assert!(child.sockets.get(socket_index).is_none());
        }

        let (parent, locks) = table
            .process_and_advisory_locks(parent_pid)
            .unwrap();
        crate::syscalls::release_blocking_retry_binding(
            parent,
            locks,
            &mut host,
            parent_pid,
            token,
        )
        .unwrap();
        assert!(parent.ofd_table.get(ofd_index).is_none());
        assert!(parent.sockets.get(socket_index).is_none());
    }

    #[test]
    fn fork_clofork_unix_datagram_peer_fails_truthfully_without_an_orphan_proxy() {
        use crate::process::test_host::NoopHost;
        use wasm_posix_shared::fd_flags::FD_CLOFORK;
        use wasm_posix_shared::socket::{AF_UNIX, SOCK_DGRAM};

        const ABSTRACT_PATH: &[u8] = b"\0kandelo-clofork-peer-proxy";

        let registry = unsafe { crate::unix_socket::global_unix_socket_registry() };
        registry.unregister(ABSTRACT_PATH);

        let mut table = ProcessTable::new();
        let parent_pid = table.create_process().unwrap();
        let mut host = NoopHost;
        let (source_fd, peer_fd, peer_index) = {
            let parent = table.get_mut(parent_pid).unwrap();
            let source_fd =
                crate::syscalls::sys_socket(parent, &mut host, AF_UNIX, SOCK_DGRAM, 0).unwrap();
            let peer_fd =
                crate::syscalls::sys_socket(parent, &mut host, AF_UNIX, SOCK_DGRAM, 0).unwrap();
            let mut address = vec![0u8; 2 + ABSTRACT_PATH.len()];
            address[0] = AF_UNIX as u8;
            address[2..].copy_from_slice(ABSTRACT_PATH);
            crate::syscalls::sys_bind(parent, &mut host, peer_fd, &address).unwrap();
            crate::syscalls::sys_connect(parent, &mut host, source_fd, &address).unwrap();
            parent.fd_table.get_mut(peer_fd).unwrap().fd_flags |= FD_CLOFORK;

            let peer_ofd_index = parent.fd_table.get(peer_fd).unwrap().ofd_ref.0;
            let peer_index = crate::socket::SocketTable::index_from_ofd_handle(
                parent.ofd_table.get(peer_ofd_index).unwrap().host_handle,
            )
            .unwrap();
            (source_fd, peer_fd, peer_index)
        };

        let child_pid = table
            .fork_process_for_caller(parent_pid, parent_pid)
            .unwrap();
        let child = table.get(child_pid).unwrap();
        assert!(child.fd_table.get(source_fd).is_ok());
        assert!(child.fd_table.get(peer_fd).is_err());
        assert!(
            child.sockets.get(peer_index).is_none(),
            "a non-inherited peer must not survive as a fake local endpoint"
        );

        let owner = unsafe { crate::unix_socket::global_unix_socket_registry() }
            .lookup(ABSTRACT_PATH)
            .unwrap();
        assert_eq!((owner.pid, owner.sock_idx), (parent_pid, peer_index));

        {
            let (parent, locks) = table.process_and_advisory_locks(parent_pid).unwrap();
            crate::syscalls::sys_close_with_locks(parent, locks, &mut host, peer_fd).unwrap();
        }
        assert!(
            unsafe { crate::unix_socket::global_unix_socket_registry() }
                .lookup(ABSTRACT_PATH)
                .is_none(),
            "closing the sole owning descriptor must not reveal a child proxy as an owner"
        );
        assert_eq!(
            crate::syscalls::sys_send(
                table.get_mut(child_pid).unwrap(),
                &mut host,
                source_fd,
                b"orphan",
                0,
            ),
            Err(Errno::ECONNREFUSED),
            "a child must not report success by queueing into an unreachable proxy"
        );
        {
            let (child, locks) = table.process_and_advisory_locks(child_pid).unwrap();
            crate::syscalls::sys_close_with_locks(child, locks, &mut host, source_fd).unwrap();
            assert!(child.sockets.get(peer_index).is_none());
        }

        table.remove_process(child_pid).unwrap();
        table.remove_process(parent_pid).unwrap();
        unsafe { crate::unix_socket::global_unix_socket_registry() }.unregister(ABSTRACT_PATH);
    }

    #[test]
    fn fork_and_spawn_drop_a_connected_unix_datagram_peer_owned_only_by_retry() {
        use crate::process::test_host::NoopHost;
        use crate::spawn::SpawnAttrs;
        use wasm_posix_shared::socket::{AF_UNIX, SOCK_DGRAM};

        const ABSTRACT_PATH: &[u8] = b"\0kandelo-retry-only-connected-peer";

        unsafe { crate::unix_socket::global_unix_socket_registry() }.unregister(ABSTRACT_PATH);

        let mut table = ProcessTable::new();
        let parent_pid = table.create_process().unwrap();
        let caller_tid = table
            .create_thread(parent_pid, parent_pid, 0x1000, 0, 0)
            .unwrap();
        let mut host = NoopHost;
        let (source_fd, peer_fd, source_index, peer_index, token) = {
            let (parent, locks) = table
                .process_and_advisory_locks(parent_pid)
                .unwrap();
            let source_fd =
                crate::syscalls::sys_socket(parent, &mut host, AF_UNIX, SOCK_DGRAM, 0).unwrap();
            let peer_fd =
                crate::syscalls::sys_socket(parent, &mut host, AF_UNIX, SOCK_DGRAM, 0).unwrap();
            let mut address = vec![0u8; 2 + ABSTRACT_PATH.len()];
            address[0] = AF_UNIX as u8;
            address[2..].copy_from_slice(ABSTRACT_PATH);
            crate::syscalls::sys_bind(parent, &mut host, peer_fd, &address).unwrap();
            crate::syscalls::sys_connect(parent, &mut host, source_fd, &address).unwrap();

            let source_ofd = parent.fd_table.get(source_fd).unwrap().ofd_ref.0;
            let source_index = crate::socket::SocketTable::index_from_ofd_handle(
                parent.ofd_table.get(source_ofd).unwrap().host_handle,
            )
            .unwrap();
            let peer_ofd = parent.fd_table.get(peer_fd).unwrap().ofd_ref.0;
            let peer_index = crate::socket::SocketTable::index_from_ofd_handle(
                parent.ofd_table.get(peer_ofd).unwrap().host_handle,
            )
            .unwrap();
            let token = crate::syscalls::ensure_blocking_retry_ofd_binding(
                parent,
                locks,
                &mut host,
                parent_pid,
                56,
                peer_fd,
                None,
            )
            .unwrap();
            crate::syscalls::sys_close_with_locks(parent, locks, &mut host, peer_fd).unwrap();
            assert!(parent.sockets.get(peer_index).is_some());
            (source_fd, peer_fd, source_index, peer_index, token)
        };

        let fork_pid = table
            .fork_process_for_caller(parent_pid, caller_tid)
            .unwrap();
        let spawn_pid = table
            .spawn_child_for_caller(
                parent_pid,
                caller_tid,
                &[b"/bin/child".as_slice()],
                &[],
                &[],
                &SpawnAttrs::empty(),
                &mut host,
            )
            .unwrap();
        for child_pid in [fork_pid, spawn_pid] {
            let child = table.get(child_pid).unwrap();
            assert!(child.fd_table.get(source_fd).is_ok());
            assert!(child.fd_table.get(peer_fd).is_err());
            assert!(child.sockets.get(peer_index).is_none());
            assert_eq!(child.sockets.get(source_index).unwrap().peer_idx, None);
        }

        {
            let (parent, locks) = table
                .process_and_advisory_locks(parent_pid)
                .unwrap();
            crate::syscalls::release_blocking_retry_binding(
                parent,
                locks,
                &mut host,
                parent_pid,
                token,
            )
            .unwrap();
            assert!(parent.sockets.get(peer_index).is_none());
        }
        assert!(
            unsafe { crate::unix_socket::global_unix_socket_registry() }
                .lookup(ABSTRACT_PATH)
                .is_none()
        );

        for child_pid in [fork_pid, spawn_pid] {
            assert_eq!(
                crate::syscalls::sys_send(
                    table.get_mut(child_pid).unwrap(),
                    &mut host,
                    source_fd,
                    b"orphan",
                    0,
                ),
                Err(Errno::ECONNREFUSED)
            );
        }

        table.remove_process(fork_pid).unwrap();
        table.remove_process(spawn_pid).unwrap();
        table.remove_process(parent_pid).unwrap();
        unsafe { crate::unix_socket::global_unix_socket_registry() }.unregister(ABSTRACT_PATH);
    }

    #[test]
    fn fork_preserves_both_owned_unix_datagram_socketpair_roots() {
        use crate::process::test_host::NoopHost;
        use wasm_posix_shared::socket::{AF_UNIX, SOCK_DGRAM};

        let mut table = ProcessTable::new();
        let parent_pid = table.create_process().unwrap();
        let mut host = NoopHost;
        let (sender_fd, receiver_fd) = crate::syscalls::sys_socketpair(
            table.get_mut(parent_pid).unwrap(),
            &mut host,
            AF_UNIX,
            SOCK_DGRAM,
            0,
        )
        .unwrap();

        let child_pid = table
            .fork_process_for_caller(parent_pid, parent_pid)
            .unwrap();
        assert_eq!(
            crate::syscalls::sys_send(
                table.get_mut(child_pid).unwrap(),
                &mut host,
                sender_fd,
                b"owned-pair",
                0,
            ),
            Ok(10)
        );
        let mut received = [0u8; 16];
        assert_eq!(
            crate::syscalls::sys_recv(
                table.get_mut(child_pid).unwrap(),
                &mut host,
                receiver_fd,
                &mut received,
                0,
            ),
            Ok(10)
        );
        assert_eq!(&received[..10], b"owned-pair");

        table.remove_process(child_pid).unwrap();
        table.remove_process(parent_pid).unwrap();
    }

    #[test]
    fn fork_clofork_unix_stream_keeps_pipe_data_but_not_process_local_oob_peer() {
        use crate::process::test_host::NoopHost;
        use wasm_posix_shared::fd_flags::FD_CLOFORK;
        use wasm_posix_shared::socket::{
            AF_UNIX, MSG_NOSIGNAL, MSG_OOB, SOCK_STREAM,
        };

        let mut table = ProcessTable::new();
        let parent_pid = table.create_process().unwrap();
        let mut host = NoopHost;
        let (sender_fd, receiver_fd, receiver_index) = {
            let parent = table.get_mut(parent_pid).unwrap();
            let (sender_fd, receiver_fd) = crate::syscalls::sys_socketpair(
                parent,
                &mut host,
                AF_UNIX,
                SOCK_STREAM,
                0,
            )
            .unwrap();
            parent.fd_table.get_mut(receiver_fd).unwrap().fd_flags |= FD_CLOFORK;
            let receiver_ofd = parent.fd_table.get(receiver_fd).unwrap().ofd_ref.0;
            let receiver_index = crate::socket::SocketTable::index_from_ofd_handle(
                parent.ofd_table.get(receiver_ofd).unwrap().host_handle,
            )
            .unwrap();
            (sender_fd, receiver_fd, receiver_index)
        };

        let child_pid = table
            .fork_process_for_caller(parent_pid, parent_pid)
            .unwrap();
        let child = table.get(child_pid).unwrap();
        assert!(child.fd_table.get(sender_fd).is_ok());
        assert!(child.fd_table.get(receiver_fd).is_err());
        assert!(child.sockets.get(receiver_index).is_none());

        assert_eq!(
            crate::syscalls::sys_send(
                table.get_mut(child_pid).unwrap(),
                &mut host,
                sender_fd,
                b"pipe-data",
                0,
            ),
            Ok(9)
        );
        let mut received = [0u8; 16];
        assert_eq!(
            crate::syscalls::sys_recv(
                table.get_mut(parent_pid).unwrap(),
                &mut host,
                receiver_fd,
                &mut received,
                0,
            ),
            Ok(9)
        );
        assert_eq!(&received[..9], b"pipe-data");

        assert_eq!(
            crate::syscalls::sys_send(
                table.get_mut(child_pid).unwrap(),
                &mut host,
                sender_fd,
                b"X",
                MSG_OOB | MSG_NOSIGNAL,
            ),
            Err(Errno::EPIPE)
        );

        table.remove_process(child_pid).unwrap();
        table.remove_process(parent_pid).unwrap();
    }

    #[test]
    fn inherited_unix_registry_owner_is_deduplicated_across_fd_aliases() {
        use crate::process::test_host::NoopHost;
        use wasm_posix_shared::socket::{AF_UNIX, SOCK_DGRAM};

        const ABSTRACT_PATH: &[u8] = b"\0kandelo-inherited-alias-owner";

        unsafe { crate::unix_socket::global_unix_socket_registry() }.unregister(ABSTRACT_PATH);

        let mut table = ProcessTable::new();
        let parent_pid = table.create_process().unwrap();
        let mut host = NoopHost;
        let (bound_fd, alias_fd, socket_index) = {
            let parent = table.get_mut(parent_pid).unwrap();
            let bound_fd =
                crate::syscalls::sys_socket(parent, &mut host, AF_UNIX, SOCK_DGRAM, 0).unwrap();
            let mut address = vec![0u8; 2 + ABSTRACT_PATH.len()];
            address[0] = AF_UNIX as u8;
            address[2..].copy_from_slice(ABSTRACT_PATH);
            crate::syscalls::sys_bind(parent, &mut host, bound_fd, &address).unwrap();
            let alias_fd = crate::syscalls::sys_dup(parent, bound_fd).unwrap();
            let ofd_index = parent.fd_table.get(bound_fd).unwrap().ofd_ref.0;
            let socket_index = crate::socket::SocketTable::index_from_ofd_handle(
                parent.ofd_table.get(ofd_index).unwrap().host_handle,
            )
            .unwrap();
            (bound_fd, alias_fd, socket_index)
        };

        let child_pid = table
            .fork_process_for_caller(parent_pid, parent_pid)
            .unwrap();

        {
            let (parent, locks) = table
                .process_and_advisory_locks(parent_pid)
                .unwrap();
            crate::syscalls::sys_close_with_locks(parent, locks, &mut host, bound_fd).unwrap();
            crate::syscalls::sys_close_with_locks(parent, locks, &mut host, alias_fd).unwrap();
        }
        let owner = unsafe { crate::unix_socket::global_unix_socket_registry() }
            .lookup(ABSTRACT_PATH)
            .unwrap();
        assert_eq!((owner.pid, owner.sock_idx), (child_pid, socket_index));

        {
            let (child, locks) = table.process_and_advisory_locks(child_pid).unwrap();
            crate::syscalls::sys_close_with_locks(child, locks, &mut host, bound_fd).unwrap();
            let owner = unsafe { crate::unix_socket::global_unix_socket_registry() }
                .lookup(ABSTRACT_PATH)
                .unwrap();
            assert_eq!((owner.pid, owner.sock_idx), (child_pid, socket_index));
            crate::syscalls::sys_close_with_locks(child, locks, &mut host, alias_fd).unwrap();
        }
        assert!(
            unsafe { crate::unix_socket::global_unix_socket_registry() }
                .lookup(ABSTRACT_PATH)
                .is_none()
        );

        table.remove_process(child_pid).unwrap();
        table.remove_process(parent_pid).unwrap();
        unsafe { crate::unix_socket::global_unix_socket_registry() }.unregister(ABSTRACT_PATH);
    }

    #[test]
    fn inherited_unix_owner_follows_rename_while_old_name_is_reused() {
        use crate::fd::OpenFileDescRef;
        use crate::process::test_host::NoopHost;
        use crate::socket::{SocketDomain, SocketInfo, SocketState, SocketType};
        use wasm_posix_shared::fd_flags::FD_CLOFORK;
        use wasm_posix_shared::flags::O_RDWR;

        const OLD_NAME: &[u8] = b"/tmp/kandelo-owner-before-rename.sock";
        const NEW_NAME: &[u8] = b"/tmp/kandelo-owner-after-rename.sock";

        let registry = unsafe { crate::unix_socket::global_unix_socket_registry() };
        registry.unregister(OLD_NAME);
        registry.unregister(NEW_NAME);

        let mut table = ProcessTable::new();
        let parent_pid = table.create_process().unwrap();
        let mut host = NoopHost;
        let (renamed_fd, renamed_index, reused_fd, reused_index) = {
            let parent = table.get_mut(parent_pid).unwrap();
            let mut renamed_socket =
                SocketInfo::new(SocketDomain::Unix, SocketType::Dgram, 0);
            renamed_socket.bind_path = Some(OLD_NAME.to_vec());
            renamed_socket.state = SocketState::Bound;
            let renamed_index = parent.sockets.alloc(renamed_socket);
            let renamed_ofd = parent.ofd_table.create(
                FileType::Socket,
                O_RDWR,
                -((renamed_index as i64) + 1),
                b"/dev/socket".to_vec(),
            );
            let renamed_fd = parent
                .fd_table
                .alloc(OpenFileDescRef(renamed_ofd), 0)
                .unwrap();
            assert!(
                unsafe { crate::unix_socket::global_unix_socket_registry() }.register(
                    OLD_NAME.to_vec(),
                    parent_pid,
                    renamed_index,
                )
            );

            assert!(
                unsafe { crate::unix_socket::global_unix_socket_registry() }
                    .rename_path(OLD_NAME, NEW_NAME)
            );

            let mut reused_socket =
                SocketInfo::new(SocketDomain::Unix, SocketType::Dgram, 0);
            reused_socket.bind_path = Some(OLD_NAME.to_vec());
            reused_socket.state = SocketState::Bound;
            let reused_index = parent.sockets.alloc(reused_socket);
            let reused_ofd = parent.ofd_table.create(
                FileType::Socket,
                O_RDWR,
                -((reused_index as i64) + 1),
                b"/dev/socket".to_vec(),
            );
            let reused_fd = parent
                .fd_table
                .alloc(OpenFileDescRef(reused_ofd), 0)
                .unwrap();
            parent.fd_table.get_mut(reused_fd).unwrap().fd_flags |= FD_CLOFORK;
            assert!(
                unsafe { crate::unix_socket::global_unix_socket_registry() }.register(
                    OLD_NAME.to_vec(),
                    parent_pid,
                    reused_index,
                )
            );
            (renamed_fd, renamed_index, reused_fd, reused_index)
        };

        let child_pid = table
            .fork_process_for_caller(parent_pid, parent_pid)
            .unwrap();
        assert!(table.get(child_pid).unwrap().fd_table.get(renamed_fd).is_ok());
        assert!(table.get(child_pid).unwrap().fd_table.get(reused_fd).is_err());

        {
            let (parent, locks) = table
                .process_and_advisory_locks(parent_pid)
                .unwrap();
            crate::syscalls::sys_close_with_locks(parent, locks, &mut host, renamed_fd).unwrap();
        }
        let renamed_owner = unsafe { crate::unix_socket::global_unix_socket_registry() }
            .lookup(NEW_NAME)
            .unwrap();
        assert_eq!(
            (renamed_owner.pid, renamed_owner.sock_idx),
            (child_pid, renamed_index)
        );
        let reused_owner = unsafe { crate::unix_socket::global_unix_socket_registry() }
            .lookup(OLD_NAME)
            .unwrap();
        assert_eq!(
            (reused_owner.pid, reused_owner.sock_idx),
            (parent_pid, reused_index)
        );

        {
            let (child, locks) = table.process_and_advisory_locks(child_pid).unwrap();
            crate::syscalls::sys_close_with_locks(child, locks, &mut host, renamed_fd).unwrap();
        }
        assert!(
            unsafe { crate::unix_socket::global_unix_socket_registry() }
                .lookup(NEW_NAME)
                .is_none()
        );
        {
            let (parent, locks) = table
                .process_and_advisory_locks(parent_pid)
                .unwrap();
            crate::syscalls::sys_close_with_locks(parent, locks, &mut host, reused_fd).unwrap();
        }
        assert!(
            unsafe { crate::unix_socket::global_unix_socket_registry() }
                .lookup(OLD_NAME)
                .is_none()
        );

        table.remove_process(child_pid).unwrap();
        table.remove_process(parent_pid).unwrap();
        let registry = unsafe { crate::unix_socket::global_unix_socket_registry() };
        registry.unregister(OLD_NAME);
        registry.unregister(NEW_NAME);
    }

    #[test]
    fn invalid_socket_root_fails_before_any_inherited_authority_is_mutated() {
        use crate::socket::{SocketDomain, SocketInfo, SocketType};
        use wasm_posix_shared::flags::{O_RDONLY, O_RDWR};

        const ABSTRACT_PATH: &[u8] = b"\0kandelo-invalid-root-atomicity";
        const HOST_HANDLE: i64 = 9_490_001;
        const PARENT_PID: u32 = 9_490_010;
        const CHILD_PID: u32 = 9_490_011;

        let registry = unsafe { crate::unix_socket::global_unix_socket_registry() };
        registry.unregister(ABSTRACT_PATH);
        assert!(registry.register(ABSTRACT_PATH.to_vec(), PARENT_PID, 0));

        let mut child = Process::new(CHILD_PID);
        let socket_index = child.sockets.alloc(SocketInfo::new(
            SocketDomain::Unix,
            SocketType::Dgram,
            0,
        ));
        assert_eq!(socket_index, 0);
        child.sockets.get_mut(socket_index).unwrap().bind_path =
            Some(ABSTRACT_PATH.to_vec());
        child.ofd_table.create(
            FileType::Regular,
            O_RDONLY,
            HOST_HANDLE,
            b"/host-backed".to_vec(),
        );
        child.ofd_table.create(
            FileType::Socket,
            O_RDWR,
            -((socket_index as i64) + 1),
            b"/dev/socket".to_vec(),
        );
        child.ofd_table.create(
            FileType::Socket,
            O_RDWR,
            -100,
            b"/dev/socket".to_vec(),
        );

        assert_eq!(
            bump_inherited_resource_refcounts(PARENT_PID, &child),
            Err(Errno::EBADF)
        );
        assert_eq!(crate::ofd::host_handle_ref_count(HOST_HANDLE), 0);
        let owner = unsafe { crate::unix_socket::global_unix_socket_registry() }
            .lookup(ABSTRACT_PATH)
            .unwrap();
        assert_eq!((owner.pid, owner.sock_idx), (PARENT_PID, socket_index));

        assert!(
            unsafe { crate::unix_socket::global_unix_socket_registry() }
                .remove_owner_exact(PARENT_PID, socket_index)
        );
        assert!(
            unsafe { crate::unix_socket::global_unix_socket_registry() }
                .lookup(ABSTRACT_PATH)
                .is_none()
        );
    }

    #[test]
    fn spawn_reopens_inherited_directory_without_owning_the_parent_iterator() {
        use crate::fd::OpenFileDescRef;
        use crate::ofd::PendingDirEntry;
        use crate::process::test_host::NoopHost;
        use crate::spawn::SpawnAttrs;
        use wasm_posix_shared::flags::O_RDONLY;

        const BACKING_HANDLE: i64 = 9_450_010;
        const ITERATOR_HANDLE: i64 = 9_450_011;

        let mut table = ProcessTable::new();
        let parent_pid = table.create_process().unwrap();
        let inherited_fd = {
            let parent = table.get_mut(parent_pid).unwrap();
            let ofd_idx = parent.ofd_table.create(
                FileType::Directory,
                O_RDONLY,
                BACKING_HANDLE,
                b"/inherited-directory".to_vec(),
            );
            let ofd = parent.ofd_table.get_mut(ofd_idx).unwrap();
            ofd.set_directory_offset(4);
            ofd.dir_host_handle = ITERATOR_HANDLE;
            ofd.dir_synth_state = 2;
            ofd.dir_entry_offset = 4;
            ofd.dir_pending_entry = Some(PendingDirEntry {
                ino: 77,
                d_type: 8,
                name: b"pending".to_vec(),
            });
            parent.fd_table.alloc(OpenFileDescRef(ofd_idx), 0).unwrap()
        };

        let mut host = NoopHost;
        let child_pid = table
            .spawn_child_for_caller(
                parent_pid,
                parent_pid,
                &[b"/bin/child".as_slice()],
                &[],
                &[],
                &SpawnAttrs::empty(),
                &mut host,
            )
            .unwrap();

        let child_entry = table
            .get(child_pid)
            .unwrap()
            .fd_table
            .get(inherited_fd)
            .unwrap();
        let child_ofd = table
            .get(child_pid)
            .unwrap()
            .ofd_table
            .get(child_entry.ofd_ref.0)
            .unwrap();
        assert_eq!(child_ofd.offset(), 4);
        assert_eq!(child_ofd.dir_entry_offset, 4);
        assert_eq!(child_ofd.dir_synth_state, 2);
        assert_eq!(child_ofd.dir_host_handle, -1);
        assert!(child_ofd.dir_pending_entry.is_none());

        let parent_entry = table
            .get(parent_pid)
            .unwrap()
            .fd_table
            .get(inherited_fd)
            .unwrap();
        let parent_ofd = table
            .get(parent_pid)
            .unwrap()
            .ofd_table
            .get(parent_entry.ofd_ref.0)
            .unwrap();
        assert_eq!(parent_ofd.dir_host_handle, ITERATOR_HANDLE);
        assert_eq!(
            parent_ofd.dir_pending_entry.as_ref().unwrap().name,
            b"pending"
        );

        // Crash/rollback-style child cleanup must not close the iterator that
        // remains owned by the parent. Parent cleanup releases it exactly once.
        let child_cleanup = table.remove_process(child_pid).unwrap();
        assert!(!child_cleanup.host_dir_closes.contains(&ITERATOR_HANDLE));
        let parent_cleanup = table.remove_process(parent_pid).unwrap();
        assert_eq!(
            parent_cleanup
                .host_dir_closes
                .iter()
                .filter(|&&handle| handle == ITERATOR_HANDLE)
                .count(),
            1,
        );
    }

    #[test]
    fn fork_reopens_inherited_directory_without_owning_the_parent_iterator() {
        use crate::fd::OpenFileDescRef;
        use crate::ofd::PendingDirEntry;
        use wasm_posix_shared::flags::O_RDONLY;

        const BACKING_HANDLE: i64 = 9_451_010;
        const ITERATOR_HANDLE: i64 = 9_451_011;

        let mut table = ProcessTable::new();
        let parent_pid = table.create_process().unwrap();
        let inherited_fd = {
            let parent = table.get_mut(parent_pid).unwrap();
            let ofd_idx = parent.ofd_table.create(
                FileType::Directory,
                O_RDONLY,
                BACKING_HANDLE,
                b"/forked-directory".to_vec(),
            );
            let ofd = parent.ofd_table.get_mut(ofd_idx).unwrap();
            ofd.set_directory_offset(3);
            ofd.dir_host_handle = ITERATOR_HANDLE;
            ofd.dir_synth_state = 2;
            ofd.dir_entry_offset = 3;
            ofd.dir_pending_entry = Some(PendingDirEntry {
                ino: 88,
                d_type: 8,
                name: b"next".to_vec(),
            });
            parent.fd_table.alloc(OpenFileDescRef(ofd_idx), 0).unwrap()
        };

        let child_pid = table
            .fork_process_for_caller(parent_pid, parent_pid)
            .unwrap();

        let child_entry = table
            .get(child_pid)
            .unwrap()
            .fd_table
            .get(inherited_fd)
            .unwrap();
        let child_ofd = table
            .get(child_pid)
            .unwrap()
            .ofd_table
            .get(child_entry.ofd_ref.0)
            .unwrap();
        assert_eq!(child_ofd.offset(), 3);
        assert_eq!(child_ofd.dir_entry_offset, 3);
        assert_eq!(child_ofd.dir_host_handle, -1);
        assert!(child_ofd.dir_pending_entry.is_none());

        let child_cleanup = table.remove_process(child_pid).unwrap();
        assert!(!child_cleanup.host_dir_closes.contains(&ITERATOR_HANDLE));
        let parent_cleanup = table.remove_process(parent_pid).unwrap();
        assert_eq!(
            parent_cleanup
                .host_dir_closes
                .iter()
                .filter(|&&handle| handle == ITERATOR_HANDLE)
                .count(),
            1,
        );
    }

    #[test]
    fn fork_modes_share_mutable_ofd_state_with_exact_lifetime() {
        use crate::fd::OpenFileDescRef;
        use wasm_posix_shared::flags::{O_APPEND, O_NONBLOCK, O_RDWR};
        use wasm_posix_shared::fork_contract::Mode;

        for mode in [Mode::Fork, Mode::Vfork] {
            let mut table = ProcessTable::new();
            let parent_pid = table.create_process().unwrap();
            let ofd_idx = {
                let parent = table.get_mut(parent_pid).unwrap();
                let ofd_idx = parent.ofd_table.create(
                    FileType::Regular,
                    O_RDWR,
                    9_452_010,
                    b"/shared-ofd".to_vec(),
                );
                parent
                    .fd_table
                    .alloc(OpenFileDescRef(ofd_idx), 0)
                    .unwrap();
                let ofd = parent.ofd_table.get_mut(ofd_idx).unwrap();
                ofd.set_offset(4);
                ofd.set_owner_pid(parent_pid);
                assert_eq!(ofd.shared_state_ref_count(), 1);
                ofd_idx
            };

            let child_pid = table
                .fork_process_for_caller_with_mode(parent_pid, parent_pid, mode)
                .unwrap();
            assert_eq!(
                table
                    .get(parent_pid)
                    .unwrap()
                    .ofd_table
                    .get(ofd_idx)
                    .unwrap()
                    .shared_state_ref_count(),
                2,
            );

            {
                let child_ofd = table
                    .get_mut(child_pid)
                    .unwrap()
                    .ofd_table
                    .get_mut(ofd_idx)
                    .unwrap();
                child_ofd.set_offset(17);
                child_ofd.set_status_flags_raw(O_RDWR | O_NONBLOCK);
                child_ofd.set_owner_pid(child_pid);
            }
            let parent_ofd = table
                .get(parent_pid)
                .unwrap()
                .ofd_table
                .get(ofd_idx)
                .unwrap();
            assert_eq!(parent_ofd.offset(), 17);
            assert_eq!(parent_ofd.status_flags(), O_RDWR | O_NONBLOCK);
            assert_eq!(parent_ofd.owner_pid(), child_pid);

            table
                .get_mut(parent_pid)
                .unwrap()
                .ofd_table
                .get_mut(ofd_idx)
                .unwrap()
                .set_status_flags_raw(O_RDWR | O_APPEND);
            assert_eq!(
                table
                    .get(child_pid)
                    .unwrap()
                    .ofd_table
                    .get(ofd_idx)
                    .unwrap()
                    .status_flags(),
                O_RDWR | O_APPEND,
            );

            table.remove_process(child_pid).unwrap();
            assert_eq!(
                table
                    .get(parent_pid)
                    .unwrap()
                    .ofd_table
                    .get(ofd_idx)
                    .unwrap()
                    .shared_state_ref_count(),
                1,
            );
            table.remove_process(parent_pid).unwrap();
        }
    }

    #[test]
    fn process_exit_closes_tcp_pipes_orderly() {
        use crate::pipe::{DEFAULT_PIPE_CAPACITY, PipeBuffer, global_pipe_table};
        use crate::socket::{SocketDomain, SocketInfo, SocketState, SocketType};

        let pipe_table = unsafe { global_pipe_table() };
        let send_idx = pipe_table.alloc(PipeBuffer::new(DEFAULT_PIPE_CAPACITY));
        let recv_idx = pipe_table.alloc(PipeBuffer::new(DEFAULT_PIPE_CAPACITY));

        let mut table = ProcessTable::new();
        let pid = table.create_process().unwrap();
        let proc = table.processes.get_mut(&pid).unwrap();
        let mut socket = SocketInfo::new(SocketDomain::Inet, SocketType::Stream, 6);
        socket.state = SocketState::Connected;
        socket.send_buf_idx = Some(send_idx);
        socket.recv_buf_idx = Some(recv_idx);
        socket.global_pipes = true;
        let sock_idx = proc.sockets.alloc(socket);
        let ofd_idx = proc.ofd_table.create(
            FileType::Socket,
            wasm_posix_shared::flags::O_RDWR,
            -((sock_idx as i64) + 1),
            Vec::new(),
        );
        proc.fd_table
            .alloc(crate::fd::OpenFileDescRef(ofd_idx), 0)
            .unwrap();

        table.remove_process(pid).unwrap();

        let send_pipe = pipe_table.get_mut(send_idx).unwrap();
        assert!(!send_pipe.is_write_end_open());
        assert!(send_pipe.is_read_end_open());
        let recv_pipe = pipe_table.get_mut(recv_idx).unwrap();
        assert!(recv_pipe.is_read_end_open());
        assert_eq!(recv_pipe.write(b"after-exit-one"), 14);
        assert_eq!(recv_pipe.write(b"after-exit-two"), 14);
        assert_eq!(recv_pipe.available(), 0);

        pipe_table.get_mut(send_idx).unwrap().close_read_end();
        pipe_table.free_if_closed(send_idx);
        pipe_table.get_mut(recv_idx).unwrap().close_write_end();
        pipe_table.free_if_closed(recv_idx);
        assert!(pipe_table.get(send_idx).is_none());
        assert!(pipe_table.get(recv_idx).is_none());
    }

    fn install_bound_udp4_socket(table: &mut ProcessTable, pid: u32, port: u16) -> usize {
        use crate::socket::{SocketDomain, SocketInfo, SocketState, SocketType};

        let sock_idx = {
            let proc = table.processes.get_mut(&pid).unwrap();
            let mut socket = SocketInfo::new(SocketDomain::Inet, SocketType::Dgram, 17);
            socket.state = SocketState::Bound;
            socket.bind_addr = [127, 0, 0, 1];
            socket.bind_port = port;
            let sock_idx = proc.sockets.alloc(socket);
            let ofd_idx = proc.ofd_table.create(
                FileType::Socket,
                wasm_posix_shared::flags::O_RDWR,
                -((sock_idx as i64) + 1),
                b"/dev/socket".to_vec(),
            );
            proc.fd_table
                .alloc(crate::fd::OpenFileDescRef(ofd_idx), 0)
                .unwrap();
            sock_idx
        };
        crate::socket::udp_register(pid, sock_idx, [127, 0, 0, 1], port, false).unwrap();
        sock_idx
    }

    fn assert_udp_owner(port: u16, pid: u32, sock_idx: usize, present: bool) {
        let present_in_lookup = crate::socket::udp_lookup([127, 0, 0, 1], port)
            .iter()
            .any(|target| target.pid == pid && target.sock_idx == sock_idx);
        assert_eq!(present_in_lookup, present);
    }

    #[test]
    fn fork_process_grows_state_buffer_for_large_parent_state() {
        const LARGE_FD_COUNT: usize = 80;
        const LARGE_PATH_LEN: usize = 1024;

        let mut table = ProcessTable::new();
        assert_eq!(table.create_process().unwrap(), 100);

        let last_fd = {
            let parent = table.processes.get_mut(&100).unwrap();
            let mut last_fd = -1;

            for _ in 0..LARGE_FD_COUNT {
                let path = alloc::vec![b'x'; LARGE_PATH_LEN];
                let ofd_ref = parent.ofd_table.create(FileType::Regular, 0, -10, path);
                last_fd = parent
                    .fd_table
                    .alloc(crate::fd::OpenFileDescRef(ofd_ref), 0)
                    .unwrap();
            }

            last_fd
        };

        {
            let parent = table.processes.get(&100).unwrap();
            let mut old_limit_buf = alloc::vec![0u8; INITIAL_FORK_STATE_BUFFER_LEN];

            assert_eq!(
                crate::fork::serialize_fork_state(parent, &mut old_limit_buf),
                Err(Errno::ENOMEM)
            );
        }

        assert_eq!(
            table
                .fork_process_for_caller(100, 100)
                .expect("fork should grow its process-state buffer"),
            101
        );

        let child = table.processes.get(&101).unwrap();
        let child_fd = child.fd_table.get(last_fd).unwrap();
        let child_ofd = child.ofd_table.get(child_fd.ofd_ref.0).unwrap();

        assert_eq!(child.ppid, 100);
        assert_eq!(child_ofd.file_type, FileType::Regular);
        assert_eq!(child_ofd.path.len(), LARGE_PATH_LEN);
    }

    #[test]
    fn fork_inherits_udp_binding_owner_before_parent_exit() {
        const PARENT: u32 = 930_001;
        const CHILD: u32 = 930_002;
        const PORT: u16 = 64_905;

        crate::socket::udp_cleanup_process(PARENT);
        crate::socket::udp_cleanup_process(CHILD);
        let mut table = ProcessTable::new();
        table.next_task_id = PARENT;
        assert_eq!(table.create_process().unwrap(), PARENT);
        let sock_idx = install_bound_udp4_socket(&mut table, PARENT, PORT);

        assert_eq!(
            table.fork_process_for_caller(PARENT, PARENT).unwrap(),
            CHILD
        );
        assert_udp_owner(PORT, PARENT, sock_idx, true);
        assert_udp_owner(PORT, CHILD, sock_idx, true);

        table.remove_process(PARENT).unwrap();
        assert_udp_owner(PORT, PARENT, sock_idx, false);
        assert_udp_owner(PORT, CHILD, sock_idx, true);
        assert!(!crate::socket::udp_can_bind(
            930_003,
            0,
            [127, 0, 0, 1],
            PORT,
            false
        ));

        table.remove_process(CHILD).unwrap();
        assert!(crate::socket::udp_lookup([127, 0, 0, 1], PORT).is_empty());
        assert!(crate::socket::udp_can_bind(
            930_003,
            0,
            [127, 0, 0, 1],
            PORT,
            false
        ));
    }

    #[test]
    fn spawn_inherits_udp_binding_owner_before_parent_exit() {
        use crate::process::test_host::NoopHost;
        use crate::spawn::SpawnAttrs;

        const PARENT: u32 = 940_001;
        const PORT: u16 = 64_906;

        crate::socket::udp_cleanup_process(PARENT);
        let mut table = ProcessTable::new();
        table.next_task_id = PARENT;
        assert_eq!(table.create_process().unwrap(), PARENT);
        let sock_idx = install_bound_udp4_socket(&mut table, PARENT, PORT);
        let mut host = NoopHost;

        let child_pid = table
            .spawn_child_for_caller(
                PARENT,
                PARENT,
                &[b"/bin/child".as_slice()],
                &[],
                &[],
                &SpawnAttrs::empty(),
                &mut host,
            )
            .unwrap();
        assert_udp_owner(PORT, PARENT, sock_idx, true);
        assert_udp_owner(PORT, child_pid, sock_idx, true);

        table.remove_process(PARENT).unwrap();
        assert_udp_owner(PORT, PARENT, sock_idx, false);
        assert_udp_owner(PORT, child_pid, sock_idx, true);

        table.remove_process(child_pid).unwrap();
        assert!(crate::socket::udp_lookup([127, 0, 0, 1], PORT).is_empty());
    }

    #[test]
    fn poll_wait_event_selects_and_consumes_exit_status() {
        use wasm_posix_shared::wait::{CLD_EXITED, EVENT_EXITED};

        let mut table = ProcessTable::new();
        let parent_pid = table.create_process().unwrap();
        let child_pid = table.create_process().unwrap();
        let child = table.processes.get_mut(&child_pid).unwrap();
        child.ppid = parent_pid;
        assert!(child.record_normal_exit(7));

        let (pid, event) = table
            .poll_wait_event(parent_pid, -1, EVENT_EXITED, 0)
            .unwrap()
            .unwrap();
        assert_eq!(pid, child_pid);
        assert_eq!(event.wait_status, 7 << 8);
        assert_eq!(event.si_code, CLD_EXITED);
        assert_eq!(event.si_status, 7);
        assert!(table.get(child_pid).unwrap().wait_event.is_none());
        assert_eq!(
            table.poll_wait_event(parent_pid, -1, EVENT_EXITED, 0),
            Ok(None)
        );
    }

    #[test]
    fn poll_wait_event_wnowait_repeats_the_same_signal_exit() {
        use wasm_posix_shared::wait::{CLD_KILLED, EVENT_EXITED, WNOWAIT};

        let mut table = ProcessTable::new();
        let parent_pid = table.create_process().unwrap();
        let child_pid = table.create_process().unwrap();
        table.processes.get_mut(&child_pid).unwrap().ppid = parent_pid;
        table.get_mut(child_pid).unwrap().record_signal_exit(15);

        for _ in 0..2 {
            let (_, event) = table
                .poll_wait_event(parent_pid, child_pid as i32, EVENT_EXITED, WNOWAIT)
                .unwrap()
                .unwrap();
            assert_eq!(event.wait_status, 15);
            assert_eq!(event.si_code, CLD_KILLED);
            assert_eq!(event.si_status, 15);
        }
        assert!(table.get(child_pid).unwrap().wait_event.is_some());
    }

    #[test]
    fn pending_spawn_exit_is_hidden_until_one_parent_bound_publication() {
        use crate::process::test_host::NoopHost;
        use crate::spawn::SpawnAttrs;
        use wasm_posix_shared::signal::SIGTERM;
        use wasm_posix_shared::wait::{CLD_KILLED, EVENT_EXITED};

        let mut table = ProcessTable::new();
        let parent_pid = table.create_process().unwrap();
        let mut host = NoopHost;
        let child_pid = table
            .spawn_child_for_caller(
                parent_pid,
                parent_pid,
                &[b"/bin/child".as_slice()],
                &[],
                &[],
                &SpawnAttrs::empty(),
                &mut host,
            )
            .unwrap();

        assert!(table.get_mut(child_pid).unwrap().record_signal_exit(SIGTERM));
        assert_eq!(
            table.poll_wait_event(parent_pid, -1, EVENT_EXITED, 0),
            Ok(None),
            "a sibling waiter may park but cannot consume an unpublished spawn child",
        );
        assert!(!table.is_exited_child_of(parent_pid, child_pid));

        assert_eq!(
            table.publish_spawn_child(parent_pid, child_pid),
            Ok(SIGTERM as i32),
        );
        let (waited_pid, event) = table
            .poll_wait_event(parent_pid, -1, EVENT_EXITED, 0)
            .unwrap()
            .unwrap();
        assert_eq!(waited_pid, child_pid);
        assert_eq!(event.wait_status, SIGTERM as i32);
        assert_eq!(event.si_code, CLD_KILLED);
        assert!(table.is_exited_child_of(parent_pid, child_pid));
        assert_eq!(
            table.publish_spawn_child(parent_pid, child_pid),
            Err(Errno::EINVAL),
            "publication is a one-shot parent/child transaction",
        );
    }

    #[test]
    fn failed_pending_spawn_removal_releases_the_hidden_wait_relationship() {
        use crate::process::test_host::NoopHost;
        use crate::spawn::SpawnAttrs;
        use wasm_posix_shared::wait::EVENT_EXITED;

        let mut table = ProcessTable::new();
        let parent_pid = table.create_process().unwrap();
        let mut host = NoopHost;
        let child_pid = table
            .spawn_child_for_caller(
                parent_pid,
                parent_pid,
                &[],
                &[],
                &[],
                &SpawnAttrs::empty(),
                &mut host,
            )
            .unwrap();

        assert_eq!(
            table.poll_wait_event(parent_pid, -1, EVENT_EXITED, 0),
            Ok(None),
        );
        assert!(table.remove_process(child_pid).is_some());
        assert_eq!(
            table.poll_wait_event(parent_pid, -1, EVENT_EXITED, 0),
            Err(Errno::ECHILD),
        );
    }

    #[test]
    fn pending_spawn_with_absent_parent_remains_owned_for_one_rollback() {
        use crate::process::test_host::NoopHost;
        use crate::spawn::SpawnAttrs;

        let mut table = ProcessTable::new();
        let parent_pid = table.create_process().unwrap();
        let mut host = NoopHost;
        let child_pid = table
            .spawn_child_for_caller(
                parent_pid,
                parent_pid,
                &[],
                &[],
                &[],
                &SpawnAttrs::empty(),
                &mut host,
            )
            .unwrap();

        assert!(table.remove_process(parent_pid).is_some());
        assert_eq!(
            table.publish_spawn_child(parent_pid, child_pid),
            Err(Errno::ECHILD),
            "ECHILD tells the host that the exact unpublished child still needs rollback",
        );
        assert!(table.remove_process(child_pid).is_some());
        assert!(table.get(child_pid).is_none());
    }

    #[test]
    fn pending_spawn_with_exited_parent_remains_owned_for_one_rollback() {
        use crate::process::test_host::NoopHost;
        use crate::spawn::SpawnAttrs;

        let mut table = ProcessTable::new();
        let parent_pid = table.create_process().unwrap();
        let mut host = NoopHost;
        let child_pid = table
            .spawn_child_for_caller(
                parent_pid,
                parent_pid,
                &[],
                &[],
                &[],
                &SpawnAttrs::empty(),
                &mut host,
            )
            .unwrap();

        assert!(table.get_mut(parent_pid).unwrap().record_normal_exit(0));
        assert_eq!(
            table.publish_spawn_child(parent_pid, child_pid),
            Err(Errno::ECHILD),
            "an exited parent cannot receive the pending spawn result",
        );
        assert!(table.remove_process(child_pid).is_some());
    }

    #[test]
    fn poll_wait_event_nonmatching_mask_preserves_latest_record() {
        use wasm_posix_shared::signal::SIGTSTP;
        use wasm_posix_shared::wait::{EVENT_EXITED, EVENT_STOPPED};

        let mut table = ProcessTable::new();
        let parent_pid = table.create_process().unwrap();
        let child_pid = table.create_process().unwrap();
        let child = table.processes.get_mut(&child_pid).unwrap();
        child.ppid = parent_pid;
        assert!(child.record_stop(SIGTSTP));

        assert_eq!(
            table.poll_wait_event(parent_pid, -1, EVENT_EXITED, 0),
            Ok(None)
        );
        assert_eq!(
            table.get(child_pid).unwrap().wait_event.unwrap().event_mask,
            EVENT_STOPPED
        );
        assert!(
            table
                .poll_wait_event(parent_pid, -1, EVENT_STOPPED, 0)
                .unwrap()
                .is_some()
        );
    }

    #[test]
    fn poll_wait_event_distinguishes_running_from_no_child_and_validates_input() {
        use wasm_posix_shared::wait::{EVENT_EXITED, WNOWAIT};

        let mut table = ProcessTable::new();
        let parent_pid = table.create_process().unwrap();
        let child_pid = table.create_process().unwrap();
        table.processes.get_mut(&child_pid).unwrap().ppid = parent_pid;

        assert_eq!(
            table.poll_wait_event(parent_pid, -1, EVENT_EXITED, 0),
            Ok(None)
        );
        assert_eq!(
            table.poll_wait_event(parent_pid, 999, EVENT_EXITED, 0),
            Err(Errno::ECHILD)
        );
        assert_eq!(
            table.poll_wait_event(parent_pid, -1, 0, 0),
            Err(Errno::EINVAL)
        );
        assert_eq!(
            table.poll_wait_event(parent_pid, -1, EVENT_EXITED, WNOWAIT | 2),
            Err(Errno::EINVAL)
        );
    }

    #[test]
    fn poll_wait_event_matches_process_groups() {
        use wasm_posix_shared::wait::EVENT_EXITED;

        let mut table = ProcessTable::new();
        let parent_pid = table.create_process().unwrap();
        table.processes.get_mut(&parent_pid).unwrap().pgid = 20;
        let same_group_child = table.create_process().unwrap();
        {
            let child = table.processes.get_mut(&same_group_child).unwrap();
            child.ppid = parent_pid;
            child.pgid = 20;
            child.record_normal_exit(0);
        }
        let other_group_child = table.create_process().unwrap();
        {
            let child = table.processes.get_mut(&other_group_child).unwrap();
            child.ppid = parent_pid;
            child.pgid = 30;
            child.record_normal_exit(1);
        }

        assert_eq!(
            table
                .poll_wait_event(parent_pid, 0, EVENT_EXITED, 0)
                .unwrap()
                .unwrap()
                .0,
            same_group_child
        );
        assert_eq!(
            table
                .poll_wait_event(parent_pid, -30, EVENT_EXITED, 0)
                .unwrap()
                .unwrap()
                .0,
            other_group_child
        );
    }

    #[test]
    fn remove_process_releases_process_and_final_ofd_locks() {
        use crate::lock::{AdvisoryLockType, FileId, LockOwner, LockRange, OfdId};

        let mut table = ProcessTable::new();
        let pid = table.create_process().unwrap();
        let file = FileId::Host { dev: 3, ino: 9 };
        let process_range = LockRange::normalize(0, 10).unwrap();
        let ofd_range = LockRange::normalize(20, 10).unwrap();
        let ofd_id = OfdId(80_020);

        table
            .advisory_locks_mut()
            .set_lock(
                file,
                LockOwner::Process(pid),
                Some(AdvisoryLockType::Write),
                process_range,
            )
            .unwrap();
        table
            .advisory_locks_mut()
            .set_lock(
                file,
                LockOwner::OpenFileDescription(ofd_id),
                Some(AdvisoryLockType::Write),
                ofd_range,
            )
            .unwrap();

        let proc = table.processes.get_mut(&pid).unwrap();
        let idx = proc.ofd_table.create(
            FileType::Regular,
            wasm_posix_shared::flags::O_RDWR,
            901,
            b"/locked".to_vec(),
        );
        proc.ofd_table.get_mut(idx).unwrap().ofd_id = ofd_id;
        proc.fd_table
            .alloc(crate::fd::OpenFileDescRef(idx), 0)
            .unwrap();

        table.remove_process(pid).expect("process removed");
        assert!(table.advisory_locks().is_empty());
    }

    #[test]
    fn task_lookup_resolves_unique_leaders_and_excludes_dead_worker_threads() {
        let mut table = ProcessTable::new();
        let first_pid = table.create_process().unwrap();
        let second_pid = table.create_process().unwrap();
        let tid = table.create_thread(first_pid, first_pid, 0, 0, 0).unwrap();

        assert_eq!(
            table.get_process_containing_task(first_pid).unwrap().pid,
            first_pid
        );
        assert_eq!(
            table.get_process_containing_task(second_pid).unwrap().pid,
            second_pid
        );
        assert_eq!(
            table.get_process_containing_task(tid).unwrap().pid,
            first_pid
        );

        table.get_mut(first_pid).unwrap().state = ProcessState::Stopped;
        assert_eq!(
            table.get_process_containing_task(tid).unwrap().pid,
            first_pid
        );
        table.get_mut(first_pid).unwrap().state = ProcessState::Exited;
        assert_eq!(
            table.get_process_containing_task(first_pid).unwrap().pid,
            first_pid
        );
        assert!(table.get_process_containing_task(tid).is_none());

        table.get_mut(second_pid).unwrap().state = ProcessState::Exited;
        assert_eq!(
            table.get_process_containing_task(second_pid).unwrap().pid,
            second_pid
        );
        table.get_mut(second_pid).unwrap().state = ProcessState::Limbo;
        assert!(table.get_process_containing_task(second_pid).is_none());

        assert!(table.get_process_containing_task(9999).is_none());
    }

    #[test]
    fn tcp_listener_target_policy_prefers_fork_children() {
        let mut table = ProcessTable::new();
        let parent = table.create_process().unwrap();
        let first_child = table.create_process().unwrap();
        let second_child = table.create_process().unwrap();
        table.processes.get_mut(&first_child).unwrap().ppid = parent;
        table.processes.get_mut(&second_child).unwrap().ppid = parent;

        add_listening_socket(&mut table, parent, 8080, 3);
        add_listening_socket(&mut table, first_child, 8080, 3);
        add_listening_socket(&mut table, second_child, 8080, 3);

        assert_eq!(
            table.pick_tcp_listener_target(8080, 0),
            Some((first_child, 3))
        );
        assert_eq!(
            table.pick_tcp_listener_target(8080, 0),
            Some((second_child, 3))
        );
        assert_eq!(
            table.pick_tcp_listener_target(8080, 0),
            Some((first_child, 3))
        );
    }

    #[test]
    fn tcp_listener_target_policy_can_exclude_a_process_during_cleanup() {
        let mut table = ProcessTable::new();
        let parent = table.create_process().unwrap();
        let child = table.create_process().unwrap();
        table.processes.get_mut(&child).unwrap().ppid = parent;

        add_listening_socket(&mut table, parent, 8080, 3);
        add_listening_socket(&mut table, child, 8080, 3);

        assert_eq!(
            table.pick_tcp_listener_target(8080, parent),
            Some((child, 3))
        );
        assert_eq!(
            table.pick_tcp_listener_target(8080, child),
            Some((parent, 3))
        );
        assert_eq!(table.pick_tcp_listener_target(9999, 0), None);
    }

    fn add_listening_socket(table: &mut ProcessTable, pid: u32, port: u16, fd: i32) {
        use crate::fd::OpenFileDescRef;
        use crate::socket::{SocketDomain, SocketInfo, SocketState, SocketType};
        use wasm_posix_shared::flags::O_RDWR;

        let proc = table.processes.get_mut(&pid).unwrap();
        let mut sock = SocketInfo::new(SocketDomain::Inet, SocketType::Stream, 0);
        sock.state = SocketState::Listening;
        sock.bind_port = port;
        let sock_idx = proc.sockets.alloc(sock);
        let ofd_idx = proc.ofd_table.create(
            FileType::Socket,
            O_RDWR,
            -((sock_idx as i64) + 1),
            b"socket".to_vec(),
        );
        proc.fd_table
            .alloc_at_min(OpenFileDescRef(ofd_idx), 0, fd)
            .unwrap();
    }

    #[test]
    fn walk_names_every_host_handle_and_remap_round_trips() {
        use crate::fd::OpenFileDescRef;
        use crate::ofd::{OfdTable, host_handle_ref_count};
        use crate::process::PosixTimerState;
        use wasm_posix_shared::flags::O_RDONLY;

        // Unique high values: other tests share the global refcount table
        // while the runner executes in parallel.
        const FILE_HANDLE: i64 = 900_210_001;
        const FILE_HANDLE_NEW: i64 = 900_210_002;
        const DIR_HANDLE: i64 = 900_210_011;
        const DIR_HANDLE_NEW: i64 = 900_210_012;
        const DIR_ITER_HANDLE: i64 = 900_210_021;
        const DIR_ITER_HANDLE_NEW: i64 = 900_210_022;
        const UNKNOWN_HANDLE: i64 = 900_210_099;

        fn walked(table: &ProcessTable) -> Vec<(u32, i32, u32, i64)> {
            let mut records = Vec::new();
            table.enumerate_host_handles(&mut |pid, fd, kind, handle| {
                records.push((pid, fd, kind, handle));
            });
            records.sort_unstable();
            records
        }

        // T2.1's walk: a machine with open files (dup- and fork-shared), an
        // open directory mid-iteration, a kernel pipe, a socket, and an
        // armed POSIX timer. Only the stream and directory-iterator slots
        // hold real (non-negative) host handles. Pipes and sockets store
        // negative kernel-internal encodings, and a timer stores no handle
        // at all — the host re-arms one by (pid, timer slot).
        let mut table = ProcessTable::new();
        let pid_a = table.create_process().unwrap();
        let pid_b = table.create_process().unwrap();

        let proc_a = table.get_mut(pid_a).unwrap();
        proc_a.fd_table = crate::fd::FdTable::new();
        proc_a.ofd_table = OfdTable::new();
        let file_ofd = proc_a.ofd_table.create(
            FileType::Regular,
            O_RDONLY,
            FILE_HANDLE,
            b"/tmp/walk-file".to_vec(),
        );
        let fd_file = proc_a
            .fd_table
            .alloc(OpenFileDescRef(file_ofd), 0)
            .unwrap();
        let fd_dup = proc_a
            .fd_table
            .alloc(OpenFileDescRef(file_ofd), 0)
            .unwrap();
        proc_a.ofd_table.get_mut(file_ofd).unwrap().ref_count += 1;
        let dir_ofd = proc_a.ofd_table.create(
            FileType::Directory,
            O_RDONLY,
            DIR_HANDLE,
            b"/tmp/walk-dir".to_vec(),
        );
        let fd_dir = proc_a.fd_table.alloc(OpenFileDescRef(dir_ofd), 0).unwrap();
        {
            let dir = proc_a.ofd_table.get_mut(dir_ofd).unwrap();
            dir.dir_host_handle = DIR_ITER_HANDLE;
            dir.dir_entry_offset = 5;
        }
        let pipe_ofd = proc_a
            .ofd_table
            .create(FileType::Pipe, O_RDONLY, -7, Vec::new());
        proc_a
            .fd_table
            .alloc(OpenFileDescRef(pipe_ofd), 0)
            .unwrap();
        let sock_ofd = proc_a
            .ofd_table
            .create(FileType::Socket, O_RDONLY, -4, Vec::new());
        proc_a
            .fd_table
            .alloc(OpenFileDescRef(sock_ofd), 0)
            .unwrap();
        proc_a.posix_timers.push(Some(PosixTimerState {
            clock_id: 0,
            sigev_signo: 14,
            sigev_value_bits: 0,
            sigev_notify: 0,
            sigev_tid: 0,
            interval_sec: 0,
            interval_nsec: 0,
            value_sec: 5,
            value_nsec: 0,
            notification_pending: false,
            overrun_current: 0,
            overrun_last: 0,
        }));

        let proc_b = table.get_mut(pid_b).unwrap();
        proc_b.fd_table = crate::fd::FdTable::new();
        proc_b.ofd_table = OfdTable::new();
        let file_ofd_b = proc_b.ofd_table.create(
            FileType::Regular,
            O_RDONLY,
            FILE_HANDLE,
            b"/tmp/walk-file".to_vec(),
        );
        let fd_file_b = proc_b
            .fd_table
            .alloc(OpenFileDescRef(file_ofd_b), 0)
            .unwrap();
        crate::ofd::host_handle_fork_ref(FILE_HANDLE);
        assert_eq!(host_handle_ref_count(FILE_HANDLE), 2);

        // The uncovered class the walk found: the handle values themselves.
        // The enumeration names every real handle, nothing kernel-internal,
        // and shows dup/fork sharing as repeated values.
        let mut expected = alloc::vec![
            (pid_a, fd_file, 0, FILE_HANDLE),
            (pid_a, fd_dup, 0, FILE_HANDLE),
            (pid_a, fd_dir, 0, DIR_HANDLE),
            (pid_a, fd_dir, 1, DIR_ITER_HANDLE),
            (pid_b, fd_file_b, 0, FILE_HANDLE),
        ];
        expected.sort_unstable();
        assert_eq!(walked(&table), expected);

        // The wire round-trips the same records and refuses a short buffer.
        let mut out = [0u8; 4096];
        let written = table.write_host_handle_records(&mut out).unwrap();
        assert_eq!(written, 4 + expected.len() * 20);
        let count = u32::from_le_bytes(out[0..4].try_into().unwrap()) as usize;
        assert_eq!(count, expected.len());
        let mut decoded: Vec<(u32, i32, u32, i64)> = (0..count)
            .map(|i| {
                let off = 4 + i * 20;
                (
                    u32::from_le_bytes(out[off..off + 4].try_into().unwrap()),
                    u32::from_le_bytes(out[off + 4..off + 8].try_into().unwrap()) as i32,
                    u32::from_le_bytes(out[off + 8..off + 12].try_into().unwrap()),
                    i64::from_le_bytes(out[off + 12..off + 20].try_into().unwrap()),
                )
            })
            .collect();
        decoded.sort_unstable();
        assert_eq!(decoded, expected);
        let mut tiny = [0u8; 8];
        assert_eq!(
            table.write_host_handle_records(&mut tiny),
            Err(Errno::ENOSPC),
        );

        // The remap refusals.
        assert_eq!(
            table.remap_host_handles(2, FILE_HANDLE, FILE_HANDLE_NEW),
            Err(Errno::EINVAL),
        );
        assert_eq!(
            table.remap_host_handles(0, -1, FILE_HANDLE_NEW),
            Err(Errno::EINVAL),
        );
        assert_eq!(
            table.remap_host_handles(0, FILE_HANDLE, -1),
            Err(Errno::EINVAL),
        );
        assert_eq!(
            table.remap_host_handles(0, UNKNOWN_HANDLE, FILE_HANDLE_NEW),
            Err(Errno::EBADF),
        );
        assert_eq!(
            table.remap_host_handles(0, FILE_HANDLE, DIR_HANDLE),
            Err(Errno::EEXIST),
        );

        // An identity remap is a legal no-op that still reports its slots: a
        // deterministic receiver can reopen into the same number.
        assert_eq!(table.remap_host_handles(0, FILE_HANDLE, FILE_HANDLE), Ok(2));
        assert_eq!(host_handle_ref_count(FILE_HANDLE), 2);

        // The remap: one call per handle moves every slot naming it, and the
        // shared refcount entry moves with the stream handle.
        assert_eq!(
            table.remap_host_handles(0, FILE_HANDLE, FILE_HANDLE_NEW),
            Ok(2),
        );
        assert_eq!(host_handle_ref_count(FILE_HANDLE), 0);
        assert_eq!(host_handle_ref_count(FILE_HANDLE_NEW), 2);
        assert_eq!(
            table.remap_host_handles(0, DIR_HANDLE, DIR_HANDLE_NEW),
            Ok(1),
        );
        assert_eq!(
            table.remap_host_handles(1, DIR_ITER_HANDLE, DIR_ITER_HANDLE_NEW),
            Ok(1),
        );

        // Reads through the new handles: the same descriptors answer with
        // the new values, dup/fork sharing intact, and the directory keeps
        // its path and iteration position.
        let mut expected_new = alloc::vec![
            (pid_a, fd_file, 0, FILE_HANDLE_NEW),
            (pid_a, fd_dup, 0, FILE_HANDLE_NEW),
            (pid_a, fd_dir, 0, DIR_HANDLE_NEW),
            (pid_a, fd_dir, 1, DIR_ITER_HANDLE_NEW),
            (pid_b, fd_file_b, 0, FILE_HANDLE_NEW),
        ];
        expected_new.sort_unstable();
        assert_eq!(walked(&table), expected_new);
        let dir = table.get(pid_a).unwrap().ofd_table.get(dir_ofd).unwrap();
        assert_eq!(dir.path, b"/tmp/walk-dir");
        assert_eq!(dir.dir_entry_offset, 5);

        table.remove_process(pid_a).unwrap();
        table.remove_process(pid_b).unwrap();
        assert_eq!(host_handle_ref_count(FILE_HANDLE_NEW), 0);
    }

    #[test]
    fn pty_index_for_pid_names_the_lowest_slave_descriptor() {
        use crate::fd::OpenFileDescRef;
        use crate::ofd::OfdTable;
        use wasm_posix_shared::flags::{O_RDONLY, O_RDWR};

        // Unique high value: other tests share the global PTY table while
        // the runner executes in parallel, and this index must name none of
        // theirs.
        const PTY_INDEX: i64 = 900_211_001;

        let mut table = ProcessTable::new();
        let pid = table.create_process().unwrap();
        let bare_pid = table.create_process().unwrap();

        let proc = table.get_mut(pid).unwrap();
        proc.fd_table = crate::fd::FdTable::new();
        proc.ofd_table = OfdTable::new();
        let file_ofd = proc.ofd_table.create(
            FileType::Regular,
            O_RDONLY,
            900_211_101,
            b"/tmp/pty-file".to_vec(),
        );
        proc.fd_table.alloc(OpenFileDescRef(file_ofd), 0).unwrap();
        let slave_ofd = proc.ofd_table.create(
            FileType::PtySlave,
            O_RDWR,
            PTY_INDEX,
            b"/dev/pts/900211001".to_vec(),
        );
        let slave_fd = proc.fd_table.alloc(OpenFileDescRef(slave_ofd), 0).unwrap();
        let dup_fd = proc.fd_table.alloc(OpenFileDescRef(slave_ofd), 0).unwrap();
        assert!(slave_fd < dup_fd);
        let later_ofd = proc.ofd_table.create(
            FileType::PtySlave,
            O_RDWR,
            PTY_INDEX + 1,
            b"/dev/pts/900211002".to_vec(),
        );
        let later_fd = proc.fd_table.alloc(OpenFileDescRef(later_ofd), 0).unwrap();
        assert!(dup_fd < later_fd);

        let bare = table.get_mut(bare_pid).unwrap();
        bare.fd_table = crate::fd::FdTable::new();
        bare.ofd_table = OfdTable::new();

        assert_eq!(table.pty_index_for_pid(pid), Ok(PTY_INDEX as u32));
        assert_eq!(table.pty_index_for_pid(bare_pid), Err(Errno::ENOENT));
        assert_eq!(table.pty_index_for_pid(4_000_000), Err(Errno::ESRCH));
    }
}
