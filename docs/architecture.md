# Architecture

This document describes the internal architecture of Kandelo. It is written for both human developers and AI agents working on the codebase.

## Overview

Kandelo is a shared, multi-process POSIX kernel that runs as WebAssembly. A single kernel Wasm instance manages all processes. The kernel **must** run in a dedicated worker thread (Web Worker in browsers, `worker_thread` in Node.js) — never on the main thread. Each process also runs in its own worker and communicates with the kernel via a SharedArrayBuffer-based channel.

> **Architecture requirement**: All platform hosts MUST run the kernel in a dedicated worker thread. The main thread should only act as a thin proxy for setup, I/O routing, and UI. Running the kernel on the main thread degrades syscall throughput by 3-4x due to event loop overhead from libuv (Node.js) or rendering (browsers).

```
                    ┌──────────────────┐
                    │   Kernel Worker   │
                    │  (single Wasm)    │
                    │                   │
                    │  ProcessTable     │
                    │  ├─ pid 1         │
                    │  │  synthetic init│
                    │  ├─ pid 100       │
                    │  └─ pid N         │
                    │  Task-ID allocator│
                    │                   │
                    │  Fd tables        │
                    │  Advisory locks   │
                    │  Pipe buffers     │
                    │  Signal queues    │
                    │  Socket state     │
                    │  PTY pairs        │
                    └──────┬───────────┘
                           │ Atomics.waitAsync / notify
              ┌────────────┼────────────┐
              │            │            │
     ┌────────┴──┐  ┌─────┴─────┐  ┌──┴────────┐
     │ Worker 100 │  │ Worker 101 │  │ Worker N   │
     │ pid=100    │  │ pid=101    │  │ pid=N      │
     │ User Wasm  │  │ User Wasm  │  │ User Wasm  │
     │ + musl     │  │ + musl     │  │ + musl     │
     │ + glue     │  │ + glue     │  │ + glue     │
     └────────────┘  └───────────┘  └───────────┘
```

## Three Layers

### 1. Kernel (Rust → Wasm)

**Location**: `crates/kernel/`

The kernel is written in Rust, compiled to `wasm32-unknown-unknown` with `no_std` (on wasm32). It exports C-compatible functions that the host calls to handle syscalls.

Key source files:

| File | Purpose |
|------|---------|
| `syscalls.rs` | Syscall dispatch — maps syscall numbers to handler functions |
| `fd.rs` | Per-process file descriptor table (fd → OFD index mapping) |
| `ofd.rs` | Open file descriptions (shared state for dup'd/forked fds) |
| `pipe.rs` | Kernel-space pipe ring buffers with cross-process wakeup |
| `pty.rs` | Pseudoterminal pairs with line discipline (canonical/raw mode) |
| `process.rs` | Process struct, HostIO trait, per-process state |
| `process_table.rs` | ProcessTable — maps PIDs to Process structs and owns the machine-wide PID/TID allocator |
| `signal.rs` | Signal subsystem: masks, handlers, RT queuing, delivery |
| `socket.rs` | AF_INET and AF_UNIX socket implementation |
| `fork.rs` | Fork/exec state serialization and deserialization |
| `memory.rs` | Memory management (mmap regions, brk tracking) |
| `terminal.rs` | Termios state and ioctl handling |
| `lock.rs` | Machine-wide advisory file-lock manager and POSIX range semantics |
| `wasm_api.rs` | Wasm export/import boundary (`#[no_mangle] extern "C"`) |

Key kernel exports (called by the host):

```
kernel_create_process() → assigned_pid | -errno
kernel_create_process_with_stdio(stdin_kind, stdout_kind, stderr_kind) → assigned_pid | -errno
kernel_validate_task(pid, tid) → 0 | -errno
kernel_set_current_tid(pid, tid) → 0 | -errno
kernel_fork_process(parent_pid, caller_tid, mode) → assigned_child_pid | -errno
kernel_spawn_process(parent_pid, caller_tid, blob_ptr, blob_len) → assigned_child_pid | -errno
kernel_remove_process(pid) → 0
kernel_handle_channel(channel_offset, channel_capacity, pid, retry_token) → result
kernel_blocking_retry_token(pid, tid, syscall_nr) → opaque_token | -errno
kernel_blocking_retry_release(pid, tid, opaque_token) → 0 | -errno
kernel_exec_target_prepare(pid, caller_tid, dirfd, path_ptr, path_len, flags) → opaque_target | -errno
kernel_spawn_exec_target_prepare(parent_pid, child_pid, path_ptr, path_len) → opaque_target | -errno
kernel_exec_target_size(owner_pid, opaque_target) → byte_length | -errno
kernel_exec_target_read(owner_pid, opaque_target, offset_lo, offset_hi, dst_ptr, dst_capacity) → bytes_read | -errno
kernel_exec_target_cancel(owner_pid, opaque_target) → 0 | -errno
kernel_exec_commit(pid, caller_tid, opaque_target) → 0 | -errno
kernel_spawn_exec_commit(parent_pid, child_pid, opaque_target) → 0 | -errno
kernel_publish_spawn_child(parent_pid, child_pid) → disposition | -errno
kernel_thread_exit(pid, tid) → 0 | -errno
kernel_commit_process_exit(status) → committed_low_8_bits
kernel_dequeue_signal(pid, tid, out_ptr, out_capacity) → 0 | signum | -errno
kernel_wait_child_poll(parent_pid, caller_tid, target_pid, event_mask, flags, out_ptr, out_capacity) → child_pid | 0 | -errno
kernel_pick_tcp_listener_target(port, exclude_pid, out_ptr, out_capacity) → 1 | 0 | -errno
kernel_take_process_timer_cleanup(pid, out_ptr, out_capacity) → posix_count | -errno
kernel_ipc_shmat_for_task(pid, tid, shmid, addr, flags) → segment_size | -errno
kernel_ipc_shm_record_mapping_for_task(pid, tid, addr, shmid, size) → 0 | -errno
kernel_ipc_shm_lookup_mapping_for_task(pid, tid, addr) → packed_size_and_shmid | -errno
kernel_ipc_shmdt_addr_for_task(pid, tid, addr) → 0 | -errno
kernel_ipc_shmat_for_process(pid, shmid, addr, flags) → segment_size | -errno
kernel_ipc_shm_record_mapping_for_process(pid, addr, shmid, size) → 0 | -errno
kernel_ipc_shmdt_addr_for_process(pid, addr) → 0 | -errno
kernel_alloc_scratch(size) → kernel_owned_pointer | 0
kernel_transfer_scratch_begin(minimum_capacity) → reservation_token | -errno
kernel_transfer_scratch_pointer(reservation_token) → kernel_owned_pointer | 0
kernel_transfer_scratch_capacity(reservation_token) → reservation_capacity | 0
kernel_transfer_scratch_cancel(reservation_token) → 0 | -errno
kernel_transfer_io_execute(pid, tid, reservation_token, len, syscall, fd, offset, retry_token) → bytes | -errno
kernel_transfer_channel_execute(pid, tid, reservation_token, retry_token) → 0 | -errno
kernel_spawn_scratch_begin(minimum_capacity) → reservation_token | -errno
kernel_spawn_scratch_pointer(reservation_token) → kernel_owned_pointer | 0
kernel_spawn_scratch_capacity(reservation_token) → reservation_capacity | 0
kernel_spawn_scratch_retained_capacity() → retained_capacity
kernel_spawn_scratch_cancel(reservation_token) → 0 | -errno
kernel_spawn_reserved_process(parent_pid, caller_tid, reservation_token, blob_len) → assigned_child_pid | -errno
kernel_msqid_ds_bytes(process_pointer_width) → bytes | -errno
kernel_semctl_array_bytes(pid, tid, semid, command) → bytes | -errno
kernel_semid_ds_bytes(process_pointer_width) → bytes | -errno
kernel_shmid_ds_bytes(process_pointer_width) → bytes | -errno
kernel_get_cwd(pid, buf, capacity) → required_or_written_bytes | -errno
kernel_get_fd_path(pid, fd, buf, capacity) → required_or_written_bytes | -errno
kernel_get_dirfd_path(pid, fd, buf, capacity) → required_or_written_bytes | -errno
kernel_enum_procs(buf, capacity) → complete_snapshot_bytes | -errno
kernel_process_metadata_begin(pid) → transaction_token | -errno
kernel_process_metadata_stage(pid, transaction_token, kind, buf, len) → 0 | -errno
kernel_process_metadata_commit(pid, transaction_token) → 0 | -errno
kernel_process_metadata_cancel(pid, transaction_token) → 0 | -errno
kernel_set_max_addr(pid, addr) → 0
kernel_set_brk_base(pid, addr) → 0
kernel_set_mmap_base(pid, addr) → 0
kernel_is_fd_nonblock(pid, fd) → 1 | 0 | -1
```

Normal guest exit closes descriptors before the process becomes reapable.
When the host instead removes a live process after explicit termination or a
worker failure, `kernel_remove_process` drops its inherited resource references
and closes its last-owned host file, directory-iteration, and network handles.
Failed spawn setup drains the same close lists during rollback. Node.js and
browser hosts use the common removal path, so forced termination does not
retain those backend descriptors after the worker is gone.

Host imports (provided by TypeScript):

```
host_read(fd, buf, len) → bytes_read
host_write(fd, buf, len) → bytes_written
host_open(path, flags, mode) → handle
host_close(handle) → 0
host_stat(path, buf) → 0
host_fstat(handle, buf) → 0
host_getrandom(buf, len) → bytes
host_connect(addr, port) → handle
host_send(handle, buf, len) → bytes_sent
host_recv(handle, buf, len) → bytes_received
host_getaddrinfo(host, port, buf, len) → count
```

### 2. Host Runtime (TypeScript)

**Location**: `host/src/`

The host runtime loads and manages the kernel and process workers. It has two main classes:

**`CentralizedKernelWorker`** (`kernel-worker.ts`): The primary runtime. Creates the kernel Wasm instance, manages process registration, listens for syscall channel activity via `Atomics.waitAsync`, and dispatches to the kernel's `kernel_handle_channel` export. **Must be instantiated in a dedicated worker thread**, not on the main thread.

**`WasmPosixKernel`** (`kernel.ts`): Lower-level kernel wrapper that instantiates the Wasm module and provides the host import functions.

Key host components:

| Component | File | Purpose |
|-----------|------|---------|
| CentralizedKernelWorker | `kernel-worker.ts` | Manages kernel instance, process channels, blocking retry |
| SyscallChannel | `channel.ts` | Typed view into SharedArrayBuffer channel region |
| NodePlatformIO | `platform/node.ts` | Direct Node.js filesystem, networking, random (legacy host-fs path) |
| VirtualPlatformIO | `vfs/vfs.ts` | Mount-table router — used by both Node and browser hosts |
| MemoryFileSystem | `vfs/memory-fs.ts` | SharedArrayBuffer-backed in-memory filesystem |
| HostFileSystem | `vfs/host-fs.ts` | Backend that proxies to a Node host directory |
| DeviceFileSystem | `vfs/device-fs.ts` | /dev/null, /dev/zero, /dev/urandom, /dev/ptmx |
| OpfsFileSystem | `vfs/opfs.ts` | Origin Private File System (browser persistence) |
| NetworkIO backends | `networking/*.ts` | Host-side external TCP/HTTP bridges and local virtual UDP/TCP networking |
| Default mount spec | `vfs/default-mounts.ts` (+ `default-mounts-node.ts`) | Canonical mount layout + per-host resolvers |
| SharedPipeBuffer | `shared-pipe-buffer.ts` | Cross-worker pipe ring buffers via SharedArrayBuffer |
| SharedIpcTable | `shared-ipc-table.ts` | SysV IPC (msg queues, semaphores, shm) |
| NodeWorkerAdapter | `worker-adapter.ts` | Creates Node.js worker_threads |
| BrowserWorkerAdapter | `worker-adapter-browser.ts` | Creates Web Workers |

`NodeWorkerAdapter` prefers the compiled worker entry distributed with the
host package. In a source checkout without `host/dist`, it bundles the
TypeScript entry once per adapter and reuses that temporary module for later
process workers; if bundling is unavailable, it falls back to the `tsx`
loader. Browser worker entries are bundled by the browser build and do not use
this Node-only source fallback.

Kernel module instantiation snapshots the caller's exact intrinsic
`ArrayBuffer`, typed-array, or `DataView` byte window before inspecting it.
Pointer-width detection and `WebAssembly.compile` consume that same detached
snapshot. This prevents an overridden view getter or a later caller mutation
from making the host configure wasm32 imports for a different wasm64 module,
or vice versa.

A `WasmPosixKernel` wrapper owns exactly one instantiated kernel generation.
`init` and `initWithMemory` are mutually exclusive one-shot entry points:
concurrent or post-success calls reject before changing pointer width, memory,
instance, or cached scratch authority. A failed first attempt clears its
partially published state and may be retried. This matters because a
`KernelScratchRegion` is bound to the exact allocator, instance, memory,
pointer, and capacity that created it; replacing the wrapper generation while
retaining an audio or public-API region would make the old allocation appear
valid under unrelated new state.

### Kernel-owned scratch transfers

The host moves syscall payloads through allocations owned by the Rust kernel.
`host/src/kernel-scratch.ts::KernelScratchRegion` carries each allocation's
pointer and declared capacity together. The exported region, lease, and
guarded-data-view names are structural interfaces; their concrete classes are
module-private. A compiler-backed contract inventories every direct or aliased
factory call, so repository runtime code cannot add a callback that merely
claims an arbitrary pointer/capacity pair without a new exact review entry.
Callers can read or write a region only inside a synchronous
`KernelScratchLease`, which checks:

1. safe-integer and non-negative offsets and lengths;
2. lossless wasm32/wasm64 pointer conversion;
3. the requested range against the allocation capacity; and
4. the resulting address against the current kernel `Memory.buffer`.

This contract is ABI 43 on top of PR #1097's merged ABI-42 result,
`c7d039794a43788acfa0b0aea30a700c257f57cb`. The bump is required by actual
incompatible exports and wires: among them, `kernel_handle_channel`,
`kernel_dequeue_signal`, and `kernel_wait_child_poll` gain capacity arguments,
and the signal-delivery record changes size. Centralizing unchanged constants
alone would not require a bump. Exact final-head validation remains a PR
readiness gate and must be recorded with the commit SHA it actually tested.

The capacity check and memory-buffer check answer different questions. The
second proves that an address exists in linear memory. It does not prove that
the allocator assigned all of those bytes to this scratch region. For example,
a 70 KiB write may fit comfortably in a multi-megabyte `Memory` while crossing
the end of a 65 KiB scratch allocation and corrupting the next Rust heap
object.

The central worker owns separate main-syscall and TCP regions for the kernel
lifetime. Sequential operations reuse them cheaply. A lease rejects nested or
promise-returning work, and a guarded data view is revoked when the lease ends,
so a callback or retry cannot observe bytes replaced by another operation.
The lease is revoked before the callback's return value is inspected for a
promise/thenable, so even an adversarial `then` getter cannot perform one last
scratch access. Bulk copies read intrinsic typed-array slots and detach output;
constructors, slot getters, `set`, `fill`, DataView methods, and
`Reflect.apply` are captured at module initialization. Each bulk write receiver
spans exactly the checked allocation range, so a replaced live prototype or
subclass override cannot widen or intercept the write, reenter the lease, or
retain a live kernel view.
Scalar access checks the lease on every operation. The native `DataView` stays
private and may be reused only while `Memory.buffer` has the same identity; a
`memory.grow()` replaces that buffer and forces the complete capacity and
current-memory proof to run again before the view is refreshed.
Each genuine buffer identity is brand-checked once against captured native
`ArrayBuffer`/`SharedArrayBuffer` getters. The successful getter—not its
result—is cached, so repeated shared-memory proofs avoid an exception while
every proof still observes the live post-growth byte length.
Async syscall preparation detaches caller data into host-owned arrays; the
final stage, Rust call, and output snapshot happen in one lease without an
`await`. Retry, timeout, stopped-process, and signal completion state carries
only those detached writes; `completeChannel` never rereads reusable scratch
after the lease has ended.

An `EAGAIN` retry must preserve more than the copied bytes. The host freezes an
immutable request snapshot, while Rust pins any exact resource selected by the
first attempt and exposes an opaque positive retry token. That token is bound
to the process, task, and normalized operation; it is not an fd, queue id,
pointer, or allocation address. Reentry reconstructs scratch only from the
snapshot and activates the pinned target instead of rereading the live mailbox
or resolving a numeric descriptor that may have been closed and reused.

Normal completion, cancellation, and exact channel retirement consume a
positive token before deleting the matching host snapshot. Exec, thread exit,
process exit, and forced removal consume their Rust-owned bindings before the
corresponding task or image state disappears. A zero token is an explicit
host-only disposition, not a missing binding. This ordering prevents both
leaked kernel references and a later operation observing scratch bytes or a
descriptor identity from the wrong request.

The generated channel `request_flags` word records whether the call entered
through libc's cancellation-point path and whether that point may currently be
woken. The host captures and clears those bits with the initial mailbox
snapshot and carries them through the asynchronous wait. Cancellation or exact
channel retirement settles that frozen request before the mailbox and its
scratch allocation can be reused; neither path infers authority later from a
replacement channel.

The Rust channel dispatcher carries the same ownership boundary numerically as
`ChannelScratchRegion { start, capacity }`. The host passes the complete
channel capacity to `kernel_handle_channel`; Rust rejects any value other than
the canonical allocation size before decoding the header. Generated pointer
descriptors classify every argument as exactly one of required or nullable.
A null pointer with positive extent is accepted only when that shared
descriptor explicitly permits null. An argument-sized null pointer with zero
extent is instead canonicalized to a non-null, allocator-owned empty range, so
an arbitrary process-space address never crosses into the kernel merely
because its byte count is zero.

Before laying out any descriptor, the host captures every `Deref`-derived
`u32` length, such as a `socklen_t`, from the validated caller range. The same
captured value sizes the destination and stages the length record, independent
of generated descriptor order. A non-null outer buffer with no length pointer
fails before dispatch. Rust then validates descriptor order, eight-byte
alignment, non-overlap, and every complete subrange against the same channel
allocation. Bespoke vector, message, polling, System V IPC, message-queue, and
other manual wire layouts have corresponding Rust validators rather than a
raw channel-pointer escape.

The generic aligned wire does not carry a second unpadded suballocation
capacity for each descriptor. Rust therefore recomputes a dynamic range from
the staged length and cannot independently distinguish a hypothetical
post-staging length change that remains within the same eight-byte alignment
bucket. The host's pre-captured value is the exact-capacity authority, and the
stage, Rust call, and output snapshot occur in one non-reentrant synchronous
lease, so repository runtime code has no interval in which to make that
change. A stronger independent cross-check would require an additional ABI
capacity field or a wire layout without alignment slack; the existing Rust
proof should not be described as reconstructing information the wire does not
encode.

`prctl` is kept out of generic pointer metadata because its second argument is
option-sensitive. `PR_SET_NAME` and `PR_GET_NAME` stage one required, exact
16-byte buffer; every other supported option preserves the low 32-bit scalar
value and stages no scratch pointer. The two option numbers, name-buffer size,
fixed Fcntl lock-record size, and fixed signal-mask size live in shared Rust
ABI modules and are generated into the TypeScript host, so the bespoke
validators cannot drift by repeating protocol literals.

A C-string argument is accepted only when its pointer is inside the exact
channel data allocation and a NUL terminator occurs before the allocation
ends. This allocation bound is not a substitute for a syscall's semantic
limit: pathname consumers still apply the generated `PATH_MAX`, while generic
C-string consumers may validly use more than `PATH_MAX` when the complete
string fits channel scratch.

Vector-message syscalls add a width-translation boundary. Musl's native
`iovec`, `msghdr`, and `cmsghdr` layouts differ between wasm32 and wasm64, so
their sizes, offsets, and alignments are generated from the shared Rust ABI
source into TypeScript and a musl contract header. The kernel scratch wire is
deliberately fixed: an eight-byte `KernelIovecWire`, a 28-byte
`KernelMsghdrWire`, and a 12-byte-aligned `KernelCmsghdrWire`. These are
separate contracts; copying a native wasm64 header and hoping the fixed parser
interprets it is invalid even when the bytes fit in linear memory.
Socket-address sizing is likewise generated as two distinct contracts.
The 128-byte `sockaddr_storage` bounds every generic input and output staging
region; the 110-byte `sockaddr_un` bounds family-specific AF_UNIX parsing.
Musl layout assertions bind those totals, the two-byte `sun_path` offset, and
the 108-byte path field to both native data models. The Unix socket registry
owns the canonical namespace key, while `SocketInfo` retains the bounded
original name supplied to `bind()`. This distinction matters for a relative
name in a deep current directory: canonicalization may produce a much longer
lookup key, but it must not enlarge the value returned by `getsockname()`.
An exact 108-byte non-NUL pathname can make Linux-compatible `getsockname()`
report 111 bytes after accounting for its appended terminator, which still
fits the generic 128-byte output region.

For `sendmsg`, the host validates the complete native header and iovec table,
every nested caller range, `IOV_MAX`, and the complete fixed-wire footprint.
It translates each ancillary record, flattens all caller iovecs in order into
one capacity-owned payload, and invokes Rust with a zero-or-one-iovec wire
inside one synchronous lease. Rust validates the complete aligned ancillary
stream and the receiver-reconstructibility of every requested `SCM_RIGHTS`
description before retaining any reference or publishing carrier bytes. Socket
descriptions are not reconstructible from a process-local socket snapshot, so
an ancillary batch containing one fails atomically with `EOPNOTSUPP`; Kandelo
does not pretend that a copied socket record is the original endpoint. The
exact flattened-iovec count is generated from the shared protocol contract,
and a Rust compile-time guard makes changing that count fail until the fixed
parser changes with it.
Nested `sendmsg.msg_name` accepts exactly the same 128-byte input maximum as
`sendto`; it cannot bypass that check by living inside `msghdr`. For
`recvmsg`, the host proves and reserves at most 128 name bytes even when the
caller advertises a larger buffer, derives fixed-wire control capacity from
the caller-native data capacity,
snapshots the result, validates the entire returned record, expands it with
zeroed native padding, and scatters payload bytes across every caller iovec.
A retry or malformed kernel result publishes none of those detached outputs.
This flatten/scatter design preserves the public multi-iovec behavior while
keeping the ordinary transport allocation fixed and cheap.

Guest process memory is a separate owner, not another spelling for kernel
scratch. `CentralizedKernelWorker.registerProcess` rejects the active kernel
`WebAssembly.Memory` object as a process memory before entering any export or
publishing a channel. This identity check keeps later process-memory ranges,
framebuffers, mappings, and worker transport outside the kernel-allocation
model even if an internal caller accidentally passes the wrong memory object.

Scalar and vectored reads or writes at most `CH_DATA_SIZE` use the main
channel region. The host validates the complete caller range or native iovec
table, flattens a vector directly into the data area, and dispatches one scalar
kernel operation. A vector is never split merely to fit scratch; preserving
one logical operation is required for pipe atomicity, datagram boundaries,
short reads, EOF, and operation-wide file-size limits.

Larger operations reserve
`crates/kernel/src/transfer.rs::TransferScratch`. Begin creates a fresh,
initialized Rust-owned allocation and returns a positive token. The host reads
the token's pointer and explicit capacity together, proves the current-memory
range, and copies under one synchronous lease. For widened syscall and channel
execution, execute changes the reservation from `Reserved` to `Executing`
before releasing the mutex and entering exactly one kernel operation. A
normal return, including an errno, changes it to `Ready`; cancellation then
drops the allocation. No pointer-only execute path exists.

Canonical CWD and open-file-description path snapshots use the same allocation
owner with a deliberately different `Reserved`-state lifetime. The host first
tries its ordinary main region. `ERANGE` triggers a zero-capacity required-size
query, followed by an exact `TransferScratch` reservation when necessary.
`kernel_get_cwd`, `kernel_get_fd_path`, or `kernel_get_dirfd_path` then writes
the complete result while that token remains `Reserved`; the host detaches the
bytes, revokes the region, and cancels the token before leaving the same
synchronous kernel entry. No promise, callback, or second reservation can
overlap that snapshot. A positive short capacity writes nothing and returns
`ERANGE`; zero capacity never dereferences its pointer. The directory-only
export additionally returns `ENOTDIR` for a non-directory descriptor, so
relative `execveat` and shared-mapping lookup cannot join a path against an
ordinary file.

These returned canonical paths are not capped by `PATH_MAX`. That limit
constrains one caller-supplied pathname, not the absolute spelling produced by
resolving a short relative name from an already-deep CWD. Treating the
canonical output as a 4,096-byte object would either produce a false failure
or, worse, publish a prefix that names a different executable or mapping
backing. Host admission therefore requires all three complete-copy exports in
ABI 43 and retains only detached bytes across the later spawn, exec, or
mapping callback.

A host-import trap can prevent Rust from leaving `Executing`. Cancellation
must not free or reuse a region whose callback may have observed only a prefix,
so this state poisons the complete kernel generation. `KernelEntryGate`
serializes every export entry, revokes its lexical scope before running
detached callbacks, and discards queued ingress after a fatal latch. This is a
lifetime guarantee: later work cannot overwrite the reservation or publish a
channel completion against an uncertain Rust transition.

Process-launch continuations are different from one synchronous kernel entry.
Compiling a child module, allocating process memory, or constructing a Worker
can yield to the host event loop. When a fork, `vfork`, `posix_spawn`, `exec`,
or pthread `clone` continuation resumes, an unrelated HTTP bridge or process
query may temporarily own the entry gate. Result-bearing lifecycle calls retry
only `KernelReentrantEntryError` on a later host turn. They do not translate
temporary serialization contention into a guest-visible launch failure, and
they do not retry ordinary lifecycle or Worker errors. Browser and Node hosts
share this rule. Generation-sensitive `exec` and pthread `clone` retries also
revalidate the exact host process generation before each PID-only kernel
operation, so an `exec` that reuses the PID cannot receive a stale
continuation's address-space or thread mutation. Child-launch paths use
monotonic task IDs or the expected process memory as their equivalent guard.

Positioned host-backed I/O uses required `host_pread` and `host_pwrite`
imports. Signed 64-bit offsets remain exact across TypeScript routing and are
split and reconstructed losslessly at the Wasm boundary; one positioned
operation leaves the shared open-file-description cursor unchanged. A backend
that cannot represent an offset exactly returns `EOVERFLOW` instead of
rounding it or emulating it with seek/read-or-write/seek.

Host-backed `O_APPEND` uses a separate exact-outcome contract. Rust passes the
complete payload and optional `RLIMIT_FSIZE` ceiling to `host_append`; the
backend owns EOF selection, clipping, mutation, and ending-position
observation as one serialized operation. `host_append_position` consumes the
matching one-shot ending offset, and Rust validates the written prefix and
derived start before publishing the cursor. Backends that cannot prove that
pair return `EOPNOTSUPP` before mutation. They do not infer ownership from a
later `stat`.

For `sendfile`, `copy_file_range`, and `splice` into such an append
destination, the source is staged without publishing its cursor or consuming
pipe bytes. Only the prefix reported by the append is committed. An append
rejection, file-size clip, or short write therefore cannot consume source data
that the destination did not publish.

Large spawn blobs use a different kernel-owned high-water region in
`crates/kernel/src/spawn.rs::SpawnScratchBuffer`. Every large operation calls
`kernel_spawn_scratch_begin`, which may grow the Rust `Vec` only while no
reservation is active and returns a fresh positive token. Begin and the
pointer/capacity queries are nonblocking: mutex contention makes begin return
`EBUSY` and makes query exports return zero. The host then reads the token's
pointer and capacity together, proves that the complete blob fits both that
allocation and the current `Memory.buffer`, and copies under one synchronous
lease. `kernel_spawn_reserved_process` accepts no host-selected pointer: it
consumes the matching token, parses the selected prefix into Rust-owned
vectors, and releases the scratch mutex before entering the process table or
any host import. After every successful begin, including setup or copy failure,
the host invokes cancellation in a `finally` block. Commit and cancellation
wait through mutex contention; neither guarded path can call a host import, so
each returns with a definitive token state. Cancellation success releases an
unconsumed matching token; `EINVAL` means the never-reused token was already
consumed or is stale. For the just-issued in-contract token after commit, the
consumed case is expected.
Stale tokens, overlapping reservations, and reentrant large-spawn attempts
fail without replacing live bytes. The reservation-derived host region is
single-use and is revoked after the attempt, so a later Rust-owned `Vec`
growth cannot revive its old pointer/capacity pair.

The allocation lives until the kernel instance ends and may retain the largest
accepted blob seen. Because WebAssembly memory cannot shrink, freeing or
replacing Rust allocations does not reduce the visible linear-memory
high-water mark. The growable design is selected for its ownership and
lifetime contract, not an unrecorded performance claim. Before/after retained
capacity, peak kernel memory, and timing are mutable validation evidence rather
than architecture: the draft PR ledger must record the exact baseline,
candidate head/tree, workload, runtime-artifact fingerprints, and separate
Node.js and real-Chromium results after the candidate is frozen. ABI 43
requires the complete transactional export set and has no older-kernel
fixed-buffer fallback under the same version.

Rust-lent host-import destinations are deliberately separate. Rust supplies a
pointer and capacity valid for that synchronous import, so
`checkedWasmImportMemoryRange` normalizes the raw wasm32/wasm64 import value
and `WasmPosixKernel.writeKernelBytes` checks that range and the producer's
intrinsic byte span without claiming it came from the scratch allocator.
Process memory,
framebuffers, and explicit shared-memory mappings keep their own ownership
models. A TypeScript-compiler-backed JavaScript/TypeScript repository audit
follows kernel-memory ownership through aliases, parameters, and returns and
reports raw views, writes, escapes, and allocator/reservation calls. Its exact
multiset allowlist names every necessary exception with a reason and fails if
an occurrence is added, duplicated, or removed. This keeps framebuffer,
process-memory, and shared-memory paths explicit without conflating their
ownership with kernel scratch. Because untyped JavaScript can erase a receiver
type, the audit also treats a zero-argument `.getMemory()` call in JavaScript
source as a potential reintroduction of the former raw kernel-memory accessor
and follows its result into aliases, helper parameters, views, and writes.
Same-named non-kernel APIs need an exact reviewed allowance. This narrow
backstop is not a claim of sound general JavaScript taint analysis.

The Rust dispatcher has a separate source-contract test for raw process
addresses. It rejects the former raw-channel-pointer macro, matches every
remaining `process_address!` use against its exact reviewed syscall context,
and also checks the total use count. Those sites represent guest virtual
addresses for memory-management, clone, futex, and related operations; they
are not authority to dereference kernel scratch. A new site, a removed site
paired with an unrelated replacement, or a reintroduced bare channel pointer
therefore requires an explicit review instead of passing a count-only
allowlist.

The former low-level `WasmPosixKernel.getMemory/getInstance` and
`CentralizedKernelWorker.getKernel/getKernelInstance` accessors are no longer
part of the supported host API. The public wrappers expose bounded queries
such as kernel-memory page count, not mutable `WebAssembly.Memory`, a raw
`WebAssembly.Instance`, or its export namespace. A module-private capability
gives only the dedicated kernel worker the exact gate and memory it owns; it is
not re-exported to embedders. This is an intentional host-API incompatibility:
downstream consumers of the former raw accessors must migrate to an
ownership-specific bounded operation. The compiler-backed audit retains the
old method spellings as fail-closed regression seeds so reintroducing an
unreviewed raw accessor becomes a contract failure.

Current host-adapter admission requires `kernel_set_cwd`,
`kernel_get_cwd`, `kernel_get_fd_path`, `kernel_get_dirfd_path`,
`kernel_process_metadata_begin`, `kernel_process_metadata_stage`,
`kernel_process_metadata_commit`, and `kernel_process_metadata_cancel`.
Initial cwd and process argv/environment therefore cannot silently fall back
to an older pointer-only aggregate setter, clear-then-push sequence, or no-op
after the runtime has negotiated the capacity-owned scratch contract. One
positive metadata token stages a complete argv/environment pair in Rust-owned
vectors while the live pair remains unchanged. The host supplies both vectors
or neither; it rejects a partial replacement before entering the kernel so the
aggregate `ARG_MAX` proof can never omit preserved live bytes. A failed stage
makes the token uncommittable, and the host cancels every uncommitted token in
a `finally` path. Commit performs no fallible allocation or host import while
it swaps both vectors, so observers see either the old pair or the complete
replacement, never a staged prefix. Relative spawn/exec and mapping resolution
likewise cannot fall back to a fixed or truncating canonical-path query.

System V control operations use the same capacity-bearing main region, but
their wire sizes also depend on the caller. The required structure-size exports
select musl's target structure from the process pointer width:

| Structure | wasm32 time64 | wasm64 LP64 |
|---|---:|---:|
| `msqid_ds` | 96 bytes | 120 bytes |
| `semid_ds` | 72 bytes | 88 bytes |
| `shmid_ds` | 88 bytes | 112 bytes |

The host stages `msgctl`/`shmctl` `IPC_STAT` and `IPC_SET` according to the
command and passes that process pointer width in the otherwise host-private
sixth dispatch slot. The kernel Wasm's own width is not a valid substitute
because one kernel may serve both guest widths.
`kernel_semctl_array_bytes(pid, tid, semid, command)` separately performs the
permission-aware GETALL/SETALL size preflight. All four sizing exports are
required in ABI 43. There is no `IPC_STAT` sizing fallback for semaphore
arrays: a process may have permission to write a semaphore set without
permission to read its metadata.

Other caller-native records use the generated
`SyscallArgSize::ProcessLayout` descriptor. Encountering that descriptor makes
the host select the exact size from the process width and carry the same width
in the private sixth dispatch slot:

| Record | wasm32 | wasm64 |
|---|---:|---:|
| `stack_t` | 12 bytes | 24 bytes |
| kernel-facing `itimerval` | 16 bytes | 32 bytes |
| `mq_attr` | 32 bytes | 64 bytes |
| `sigevent` | 64 bytes | 64 bytes |
| `statfs` | 88 bytes | 120 bytes |
| `sysinfo` | 312 bytes | 368 bytes |
| `siginfo_t` for `rt_sigqueueinfo` | 128 bytes | 128 bytes |

The timer distinction is intentional: wasm32 musl translates its public
time64 `itimerval` to four native `long` values before entering the kernel.
Rust parses or serializes each complete caller-native record into a
capacity-bounded scratch slice and initializes padding and reserved bytes.
The kernel Wasm's own pointer width is never used to infer the process layout.
The generated fixed-size descriptors separately carry `stat` (112 bytes) and
`sched_param` (48 bytes); those two records do not use width selection or the
private process-width dispatch slot.

`setsockopt` carries the same independent caller-width fact for native IPv4
multicast group records. `group_req` is 132 bytes with its group at offset 4
on wasm32 and 136 bytes with the group at offset 8 on wasm64.
`group_source_req` is 260/264 bytes with its source address at offset 132/136.
The syscall has five public arguments, so the host writes the process width to
the otherwise private sixth channel slot before dispatch. Rust accepts only 4
or 8 and selects these generated layouts from that value. `optlen` is merely a
caller byte extent, and padding is caller data; neither may be used to guess
the process data model. The public five-argument `kernel_setsockopt` export
keeps its signature and uses the kernel's native width for direct calls, while
the channel path uses the calling process's width.

Process enumeration uses a separate complete-output rule on the fixed main
region. `kernel_enum_procs` first computes the entire snapshot with checked
arithmetic: one four-byte count, one exact packed 36-byte header per live
process, and the variable `comm` and command-line bytes. The packed header is
not a native `repr(C)` structure (which would be 40 bytes after alignment);
`wasm_posix_shared::process_snapshot_wire` owns every offset and generates the
TypeScript consumer plus ABI snapshot evidence. If the complete total exceeds
the supplied capacity Rust returns `ENOSPC` before touching the destination.
On success Rust preflights each complete header-plus-payload record and creates
only the exact required output slice. The host rejects an over-reported byte
count or any malformed count, truncated record, unsafe numeric field, or
trailing byte before returning a process list. Total Wasm memory beyond the
supplied allocation is irrelevant, and neither a short buffer nor a malformed
later record exposes a partial list.

### Kernel heap lifetime

The Rust kernel uses a reclaiming `dlmalloc` heap inside its own Wasm linear
memory. Closing a pipe, reaping a process, replacing an image, or dropping
temporary fork serialization state therefore returns that allocation to the
kernel heap for reuse. This is required for ordinary long-running workloads:
a monotonic allocator would make total historical syscall activity determine
whether a later allocation succeeds.

WebAssembly linear memory cannot shrink. Freeing a kernel allocation makes its
chunk reusable, but the kernel's visible page count remains at its high-water
mark. `NodeKernelHost.getKernelMemoryPages()` and
`BrowserKernel.getKernelMemoryPages()` expose that page count for diagnostics
and lifetime tests; it is not guest process memory. The allocator is protected
by an internal lock even though the architecture serializes kernel dispatch in
one dedicated worker, preserving allocator integrity if dispatch concurrency
changes later.

### Advisory file locks

Advisory lock state and semantics live entirely in the Rust kernel. The
machine-wide `ProcessTable` owns one `AdvisoryLockManager`; neither a process
nor the TypeScript host owns a second lock table. The manager starts empty and
retains one high-water `Vec<LockRecord>` sorted by file identity and range.
Binary search selects the contiguous records for a file before range scanning,
so lookup is `O(log n + k)` for `k` records on that file rather than a scan of
unrelated files. The vector grows geometrically, never shrinks, and is bounded
at 4096 normalized records so adversarial lock churn cannot retain unbounded
kernel heap capacity.

Each host-backed regular file is identified by the exact `(st_dev, st_ino)`
returned by `host_fstat` on its live open handle. The open file description
caches that identity; remembered pathnames and pathname hashes are never lock
identity. `VirtualPlatformIO` qualifies device IDs by backend object and
backend-local device, so mounting the same backend object twice preserves
aliases while different backend objects cannot collide. Node obtains device
and inode values from bigint-native stat calls. In-kernel memfds, procfs
regular objects, and read-only synthetic regular files use explicit tagged
kernel-object identities; none derive identity from a pathname hash.

Process locks use the PID owner required by POSIX. OFD locks and `flock()` use
a kernel-global, monotonically allocated open-file-description ID: independent
opens differ, while `dup`, `fork`, and `exec` preserve the ID. `flock()` keeps
Linux-observable OFD-style lifetime in its own namespace, independent of POSIX
and OFD byte-range records. Process locks are not inherited by `fork`; they
survive `exec` under the same PID, except that closing a `FD_CLOEXEC`
descriptor applies the normal close rule. A close removes all process locks
held by that PID on the file; an OFD lock remains until the last machine-wide
reference to its open file description closes. Range
normalization, replacement, splitting, coalescing, conflict selection, and
capacity checks all happen in Rust. Conflicts are reported as `EAGAIN` before
capacity is considered; a mutation that would exceed the record limit or
cannot reserve its final capacity returns `ENOLCK` without partial state.

For a supported `SCM_RIGHTS` description, the queue entry retains the source
description's `OfdId`, `FileId`, and a live reconstructible backing reference.
Transfer validation is repeated before retain and before receiver
installation; stale, non-owning, structurally incomplete, socket, epoll, and
other process-owned descriptions fail with `EOPNOTSUPP` instead of becoming a
lossy snapshot. In particular, a batch containing a socket fails before its
carrier data or rights become visible. Supporting socket transfer requires one
authoritative machine-wide socket backing and is not approximated here with a
copied process-local record.

A valid queued reference participates in final-reference checks even after the
sender closes its descriptor. Successful receipt transfers that retained
reference into the receiver without changing lock ownership; a discarded
message or failed receiver fd allocation releases it and removes
OFD/`flock()` records only if it was the true final reference. Destructors
enqueue fixed cleanup metadata into pre-reserved, high-water storage, and
cleanup runs after pipe-table borrows end. The host schedules the syscall but
never stores or examines lock state. Each process keeps its descriptor and OFD
table shell, but mutable offset, status flags, and async owner live in an
exactly owned `Rc<Cell>` state shared across fork, vfork, spawn, and supported
`SCM_RIGHTS`. A queued descriptor keeps that same state live, so receipt sees
mutations made after send rather than a frozen scalar snapshot.

On an AF_UNIX stream, retained rights are associated with absolute byte ranges
in the stream rather than a separate first-in/first-out side queue. A receive
cannot observe a descriptor before it reaches that record's carrier bytes, and
`MSG_WAITALL` stops at an ancillary boundary instead of consuming bytes beyond
the rights it can return. Ordinary `read()` discards rights only when it
consumes their carrier range. `MSG_PEEK` fallibly duplicates the retained
references without consuming either bytes or rights, so a short control buffer
can report `MSG_CTRUNC` repeatedly and a later full receive still obtains the
descriptors.

An AF_UNIX datagram stores payload, source address, and retained rights in one
queue entry. Publication is atomic: a full queue or failed descriptor retain
publishes neither bytes nor rights. Zero-length datagrams remain real messages,
so `recvmsg()` with no iovecs can consume one and receive its control records;
ordinary `read(fd, ..., 0)` remains a no-op and cannot consume it. Addressed
and connected same-process AF_UNIX datagram sends use this same ownership
path. Cross-process AF_UNIX datagram routing remains unsupported as documented
in the networking section.

ABI 40 removes the required `host_fcntl_lock` import and the public
`SharedLockTable` host-package export. This is an intentional host API break:
embedders must not register or manipulate lock storage. The unchanged guest
`fcntl`, OFD-lock, and `flock` syscall surfaces now reach the Rust manager
directly, which also lets a native Wasm host use the same implementation
without a lock-specific JavaScript binding.

### Cooperative process-runtime interrupts

A process module may import
`env.__wasm_posix_vm_interrupt_after(timed_out_ptr, vm_interrupt_ptr, seconds)`
to request a cooperative runtime deadline. This import is intended for
language runtimes that already poll an interrupt flag at VM safepoints; it is
not a substitute for POSIX signal delivery or a general program-specific
kernel hook.

The process worker forwards each arm or cancellation request to its host's
dedicated kernel worker. The kernel worker owns the JavaScript timer because a
process worker executing a CPU-bound Wasm loop cannot service its own event
loop. At the monotonic deadline the host sets each flag byte with an atomic
store in the process's shared memory. Timer entries retain the exact
process-generation object as well as the PID, so exec or exit cannot redirect
a stale callback into a replacement process image. Deadlines beyond
JavaScript's signed 32-bit timer range are scheduled in bounded chunks.

The imported function and its pointer-width-specific signature are part of
the guest/host ABI. A package that starts importing it must raise its kernel
ABI floor in the same ABI reconciliation that versions and snapshots the new
surface.

Host-runtime failure diagnostics are kept separate from guest file descriptor
2. Worker traps, protocol failures, and failed process or thread transitions
produce typed `host_diagnostic` messages; `NodeKernelHost` and `BrowserKernel`
expose them through `onHostDiagnostic`. An ordinary process exit, including a
nonzero exit used as POSIX control flow, is reported only through its exit
status and is not a host warning. Node records actual host diagnostics on the
embedding process's console, while the browser live-demo consumer records them
in dmesg. Neither path appends host diagnostics to the program's stderr byte
stream, so test harnesses and applications observe only bytes the guest
actually wrote.

### 3. Glue Layer (C)

**Location**: `libc/glue/`

Compiled into every user program. Three main files:

| File | Purpose |
|------|---------|
| `channel_syscall.c` | Channel-based syscall dispatcher. Writes syscall number + args to SharedArrayBuffer, notifies kernel via `Atomics.store` + `Atomics.notify`, waits for response via `Atomics.wait`. Also handles fork (`wasm-fork-instrument` save/restore), clone (thread setup), exec, and signal delivery. |
| `compiler_rt.c` | Compiler runtime: soft-float (`__floatditf`, `__fixunstfdi`, etc.) and 64-bit builtins needed by musl on wasm32. |
| `dlopen.c` | Dynamic loading glue for `dlopen`/`dlsym` via host. |

## Syscall Channel Protocol

Each process has a dedicated channel region in its SharedArrayBuffer memory. The channel is placed in a host-reserved control slab immediately before the guest-managed brk/mmap region, not at the maximum memory address. This lets a process start with a small shared `WebAssembly.Memory` while keeping the channel address stable as guest brk/mmap activity grows memory on demand.

### Channel Layout

```
Offset  Size   Field
0       4      status (Atomics.wait/notify target)
4       4      syscall_number
8       48     arguments (6 × i64)
56      8      return_value (i64)
64      4      errno_value (i32)
68      4      request_flags (u32; cancellation and signal-delivery authority)
72      65536  data_buffer (for path strings, read/write buffers, etc.)
65544   8      checkpoint request area (reserved data_buffer tail)
65552   56     signal delivery area (reserved data_buffer tail)
```

Total: 65,608 bytes (header 72 bytes + data buffer 65,536 bytes).

The last 64 bytes of the data buffer are reserved. The signal delivery area
holds one dequeued caught signal for libc's post-syscall trampoline. The
checkpoint request area holds one `u32` request word directly below it: the
host publishes the word before completing a process's pending syscall, and
the glue clears it and calls `kernel.kernel_checkpoint` from the same
post-syscall hook that delivers signals. Both reservations sit inside the
declared 65,536-byte buffer, so a syscall that transfers the full buffer
writes across them; neither value is expected to survive such a transfer.

Both wasm32 and wasm64 write six 64-bit argument slots. On wasm32, musl's
public variadic `syscall()` entry point still reads 32-bit `long` arguments,
because that is the C calling convention its callers use. The non-variadic
`__syscallN` and cancellation-point `__syscall_cp` paths widen values to 64
bits before calling the glue layer so offsets and lengths are not truncated.
Both paths overwrite `request_flags` before publishing the atomic status.
Plain calls write zero; cancellation-point calls use generated flag constants.
The host captures and clears the field with the request snapshot.

Bits 0 and 1 of `request_flags` identify cancellation points and authorize a
cancellation wake, respectively. A wake is valid only when both bits are set.
Bit 2, `REQUEST_FLAG_DEFER_SIGNAL_DELIVERY`, identifies a completion consumed
by process-worker JavaScript instead of libc's post-syscall signal trampoline.
The kernel leaves caught signals pending on those completions. Fork, clone,
continuation allocation/cleanup, and staged-loader VFS/memory requests set the
bit and clear it before returning control to guest code. Libc then uses an
ordinary side-effect-free `getpid` syscall as the signal-delivery checkpoint
after the owning import returns. Ordinary guest syscalls clear the flags word.

### Status Values

| Value | Name | Meaning |
|-------|------|---------|
| 0 | IDLE | Channel is idle |
| 1 | SYSCALL_READY | Process has written a syscall, kernel should handle it |
| 2 | RESULT_READY | Kernel has written the result, process can read it |
| 3 | RETRY | Kernel needs the host to retry (blocking I/O not ready yet) |

### Syscall Flow

```
Process Worker                          Kernel Worker (host)
─────────────                          ────────────────────
1. Write syscall_number + args + request_flags
   to channel
2. Atomics.store(status, SYSCALL_READY)
3. Atomics.notify(status)
4. Atomics.wait(status, SYSCALL_READY)
   ─── blocks ───                      5. Atomics.waitAsync detects change
                                        6. Read channel: syscall + args;
                                           capture and clear request_flags
                                        7. Call kernel_handle_channel(offset,
                                                                      capacity, pid,
                                                                      retry_token=0)
                                        8. Kernel reads args from process memory
                                        9. Kernel executes syscall logic
                                       10. Kernel writes return_value + errno
                                       11. Atomics.store(status, RESULT_READY)
                                       12. Atomics.notify(status)
13. Atomics.wait returns
14. Read return_value + errno
15. Return to caller
```

Steps 10–15 normally include caught-signal publication and libc handler
dispatch. A request marked `REQUEST_FLAG_DEFER_SIGNAL_DELIVERY` deliberately
omits that publication because JavaScript owns its completion and has no
signal-handler trampoline. The next explicit guest checkpoint performs the
same delivery only after the host import has returned; this avoids both signal
loss and a reentrant host-to-Wasm callback.

### Blocking Syscalls and Retry

Some syscalls (read from an empty pipe, accept on a socket, or poll with a
timeout) cannot complete immediately. The process worker remains blocked in
`Atomics.wait` while the host parks and wakes its pending channel through
`Atomics.waitAsync`.

The retry boundary also owns caught-signal delivery. Once Rust dequeues a
caught signal into `CH_SIG`, that channel is the signal record's sole owner
until libc runs the handler and clears it. If the syscall would otherwise
remain blocked, the host captures and releases its exact retry authority, then
completes the channel with `EINTR` before it can park again. Public nonblocking
`EAGAIN` outcomes remain `EAGAIN`. After the handler, libc resubmits only its
reviewed zero-progress `SA_RESTART` allowlist, including `accept`, `accept4`,
and `ppoll`. POSIX does not give `ppoll` the `pselect`
restart-versus-`EINTR` exception, so it remains on that list; Kandelo
deliberately selects `EINTR` for `pselect`, whose `SA_RESTART` outcome POSIX
makes implementation-defined. Other timeout-bearing operations remain out
when a new submission would reset their deadline. The shared
`CentralizedKernelWorker` state machine provides the same behavior in Node.js
and browser hosts.

For a signal-mask-swapping `ppoll` or `pselect`, each TID owns a LIFO stack of
wait contexts. Each context records both the caller's saved mask and the
replacement mask. An active frame accepts repeated kernel attempts. Once a
signal interrupts it, reuse additionally requires the current caught-handler
depth to have fallen below the handler depth recorded by that frame. A wait
entered by a catcher is therefore distinct from the interrupted outer wait
even if the catcher explicitly restores the replacement mask and reuses
identical syscall arguments. The signal record restores the mask current at
delivery, so a restarted `ppoll` keeps its replacement mask continuously
installed between attempts. Terminal success restores the top context in the
normal syscall path; final `EINTR` uses the existing exact-task host-wait
cancellation after the catcher returns. That cancellation also finalizes
`sigsuspend` and `pause` after their catcher.

The Wasm setjmp runtime records caught-handler depth in every jump environment.
Both `longjmp` and `siglongjmp` first retire every abandoned handler and its
paired wait context through the existing `rt_sigreturn` and exact-task
cancellation operations. `siglongjmp` then applies the jump environment's
saved mask when requested; an application using `longjmp` from a catcher must
restore its signal mask as POSIX requires. An ordinary jump outside a catcher
has no handler context to retire. A finite restarted `ppoll`
keeps its absolute deadline in the libc call frame rather than host channel
state. Nested calls and later same-argument calls therefore have independent
deadlines, while catcher time is still charged to the interrupted call. The
internal timestamp request defers caught-signal publication so a signal
already pending at ppoll entry still interrupts ppoll itself.

For a represented retry, the initial call uses token zero. Before returning
`EAGAIN`, Rust pins any exact target required by that operation. The host
detaches the complete request, queries the authoritative token, and either
completes a nonblocking call or parks the immutable snapshot. A later wake
rebuilds scratch from that snapshot and calls the kernel with the same token;
it does not reread caller memory or follow a reused fd. Terminal completion or
cancellation consumes the token before the host drops its snapshot.

This mechanism is critical: asynchronous scheduling never owns a live scratch
view, while Rust retains the resource identity and lifetime needed by the next
synchronous entry.

Rust serializes readiness and lifecycle changes through one packed wake-event
stream. `crates/shared::wakeup_event_wire` owns its five-byte record layout and
every reason bit; generated bindings give the shared Node/browser host the
same offsets and values. The host owns a complete copied batch before acting
on any event, because process stop/continue handling can synchronously reenter
kernel operations that reuse scratch. The same generated ABI surface owns the
`poll` and `epoll` event bits and `fd_set` sizing used by host-side readiness
marshalling, so the host does not restate those values.

For pipe-readable and pipe-writable records, the host first retries ordinary
`poll()` and `ppoll()` channels whose captured kernel pipe index matches the
event. A signal-mask-swapping `ppoll()` remains parked for the existing
signal-safe grace period, and the broad fallback still covers wait classes
without an exact pipe identity, including `select()` and `pselect6()`.
Host-originated pipe bridge notifications use the same target-before-fallback
order in the shared Node.js/browser runtime.

Finite `poll()`/`ppoll()` and `select()`/`pselect6()` waits retain one absolute
deadline from their first attempt. Targeted readiness events, broad wakeups,
and safety retries use the remaining duration instead of restarting the
caller's timeout. Except for descriptor-free `select()` used only as a sleep,
expiry performs one zero-time kernel pass. That pass makes the final readiness
decision, clears readiness outputs, and restores any temporary `ppoll()` or
`pselect6()` signal mask. The host rebuilds the pass from its immutable request
snapshot; it does not overwrite the caller's original timeout or arguments.

`F_SETLKW` uses the same parking mechanism with a narrower wake contract. A
conflict returns the internal retry result, and the host parks only that lock
request. Unlock, conversion, close, exit, and other Rust-side changes that may
unblock a waiter publish an advisory-lock event through the kernel wake stream;
the host only reschedules parked `F_SETLKW` channels and never reads lock state.
A short retry timer remains a scheduling safety net. `ENOLCK` is a completed
guest-visible failure, not a retry result. Native runtimes can consume the same
generic wake event without implementing advisory-lock storage.

## Multi-Process Model

### Task identity allocation

The Rust `ProcessTable` is the sole authority for every process ID (PID) and
pthread thread ID (TID) in a kernel instance. One monotonically increasing,
positive signed task-ID sequence serves top-level process creation, `fork()`,
non-forking `posix_spawn()`, and thread-style `clone()`. It starts at 100 and
never reuses an identity, even after a process is reaped or a thread exits. If
the sequence assigns `i32::MAX`, that allocation succeeds; the next allocation
fails with `EAGAIN` instead of wrapping.

This ownership is enforced inside the Rust type boundary, not only by call-site
convention. Each allocation produces an opaque, non-cloneable `AllocatedTaskId`
that production process or thread construction must consume. Process IDs,
thread IDs, and thread membership are read-only outside that path. Raw numeric
constructors exist only for isolated `cfg(test)` fixtures, and fork
deserialization fills a child record whose identity `ProcessTable` has already
allocated rather than accepting a second PID source.

PID 1 is outside that sequence. The kernel creates it as a synthetic root-owned
init reservation with no user Wasm worker, so PID-addressed existence and
permission checks have a real kernel target. The first user process is therefore
PID 100, not PID 1. This synthetic record is not a user-space init program or
an active wait-loop reaper.

Callers never choose an ID or advance a watermark. The host helper
`CentralizedKernelWorker.createProcess(...)` asks the Rust kernel to create a
top-level process and returns the assigned PID. `registerProcess(pid, ...)`
only attaches host memory, syscall channels, and worker metadata to an existing
running or stopped kernel process; it rejects unknown, exited, and synthetic
PID 1 records and cannot create or reserve one. Adding a syscall channel calls
the read-only `kernel_validate_task(pid, tid)`, which accepts only that
process's main task or one of its kernel-allocated threads before the host
records the channel. For a cloned pthread, the callback receives a one-shot
transport proof bound to the exact clone result; `attachThreadChannel` derives
the PID and TID from that proof, rejects replay and duplicate mailbox ownership,
and never accepts a caller-selected numeric identity. Validation does not
install dispatch authority. Immediately before each mailbox call, the host
calls `kernel_set_current_tid(pid, tid)`;
`kernel_handle_channel` consumes and clears that exact pair on every returning
path, including the kernel-side exit transaction. Returning is required here
because a trapped WebAssembly export skips the compiler's shadow-stack
epilogue; repeatedly trapping the reusable kernel would permanently consume
stack. The process worker's separate `kernel_exit` import traps after the
mailbox completes, so guest `_exit` remains non-returning without leaking the
kernel's stack. Transport misrouting or earlier validation therefore cannot
authorize a later dispatch.
During the ABI 42 transition, the host also accepts the deliberate post-commit
exit trap from an older ABI 42 kernel, then applies the same authoritative
`Exited` state check. The compatibility path does not treat a trap alone as
successful exit.
Signal dequeue, child-wait polling, write-limit preparation, and guest SysV
shared-memory attachment also carry the exact live caller TID explicitly.
Rust owns each attachment's address, segment id, size, and lifetime; the shared
host retains versioned snapshots only to reconcile bytes between distinct
process memories. Fork-child materialization and lifecycle cleanup use
separately named process-level SysV exports.
Fork and spawn carry the channel's caller TID to the kernel, which validates it
as a live task belonging to the parent. That value selects caller-specific
state; it is never a candidate child identity. Clone validates the bound caller
against the same live task records before allocating its new thread ID. Fork,
spawn, and clone callbacks likewise receive identities that the Rust kernel has
already allocated.
`exec()` preserves the calling process identity.

A task-binding rejection while the Process is live is a fatal host/kernel
protocol failure: the host marks the process crashed and terminates its Workers
without returning a synthetic guest error. Rust must accept that signal-death
transition before the host records the process as reaped or wakes its parent;
a missing or rejected transition remains a loud protocol failure. Neither a
normal return nor a legacy compatibility trap from the kernel exit transaction
is sufficient by itself: the host verifies the Process is actually `Exited`
before publishing a clean exit.
During process exit, Node and browser may briefly retain exact channel objects
until Worker termination completes.
Once Rust has made that Process Exited, those channels can finish only musl's
`exit_group`/`exit` transport handshake; every other late syscall stays parked
and never re-enters kernel state. Final teardown removes all PID-prefixed thread
channel, fork-context, and clear-TID metadata.

### fork()

Fork uses the in-tree `wasm-fork-instrument` tool to snapshot the Wasm call stack (details in [fork-instrumentation.md](fork-instrumentation.md)):
Before compilation or worker launch, Node and browser hosts validate the
embedded ABI version, linked-frame contract, control exports, and ABI 43
`FORK_CAP_ACTIVATION_STATE_SAFE` claim. Pthread and side-module entry points
apply the same policy.

1. User calls `fork()` → musl → `kernel_fork(FORK)`; the process adapter
   validates the ABI-owned mode.
2. The host's `kernel_fork(mode)` override begins one process continuation
   transaction. It captures activation catalogs and module state, maps each
   participating activation's root continuation chunk, and calls
   `wpk_fork_unwind_begin(root + chunk_header_size)`. The tool-injected export
   sets state to UNWINDING and snapshots every mutable scalar global (including
   `__tls_base` and `__stack_pointer`) into that activation's fixed prefix.
3. The return-to-caller chain unwinds. After each fork-path call returns in the
   unwinding state, the caller asks the host to reserve a complete node before
   its first frame write; its postamble commits the node only after all
   activation-owned scalar state has been saved. Live references are interned
   into one process recipe graph and the frame stores only its reference-vector
   ordinal. The host maps additional page-rounded chunks when necessary. No
   accepted frame names a module-instance reference-table slot.
4. Once `_start` returns (top-of-stack), the host sends `SYS_FORK` through the
   channel for the captured ordinary-fork mode.
5. Kernel's `kernel_fork_process(parent_pid, caller_tid, mode)` validates the caller,
   allocates the child PID from the global task-ID sequence, and copies process
   metadata and the fd/OFD tables. The child receives the calling task's blocked
   signal mask, while inherited stateful descriptors retain references to their
   existing kernel-global backings.
6. Host copies the parent's linear memory, including continuation mappings, to
   a new `WebAssembly.Memory` and spawns a child worker. Kernel mmap metadata is
   inherited with the process state. The worker creates a fresh Wasm instance:
   mutable globals, tables, exception references, and Store-owned references
   are not copied and are not evidence that replay state survived.
7. The child validates the copied KFRV/KFMS arena, instantiates every required
   main/side activation, materializes static roots, typed GC objects, opaque
   owner tokens, and complete exceptions, then restores reference globals,
   table contents/length, and segment lifetime. Only after those owners are
   ready does it call `wpk_fork_rewind_begin(buf)` to restore scalar globals.
   Typed object allocation also installs the child's own weak constructor
   provenance, so a later nested fork encodes child-local objects rather than
   depending on identities retained from the original parent.
   The host then calls `setupChannelBase(...)` (which reads the now-correct
   `__tls_base`) and invokes the selected main or pthread resume root.
8. Each instrumented function's preamble requests and validates the next committed frame, then re-enters the call site where the parent was interrupted. Eventually it reaches the `kernel_fork` call site in the leaf function, which returns 0. Libc then refreshes the copied pthread TID from the kernel through `set_tid_address` before returning to user code.
9. `wpk_fork_rewind_end` resets state; parent and child independently unmap their continuation chunks; fork returns 0 in child and the child PID in the parent.

ABI 43 also lets libc call `kernel_fork(VFORK)`, which remains the same exact
mode through unwind/replay and reaches `SYS_VFORK`, the kernel export, and the
child Worker initialization record. After admission and kernel child creation,
that mode branches away from ordinary step 6: the host retains an exact alias
to the parent's existing `Shared WebAssembly.Memory` and launches a separate
child Worker without constructing or copying a child process Memory. The child
receives its own syscall channel, host-reserved replay workspace, Wasm
instance, loader, and continuation controller. Only the calling parent thread
stays parked in the asynchronous fork import; sibling pthreads continue to
run.

The kernel marks the vfork child's independent Process record. Nested fork,
vfork, spawn, and pthread clone fail with `EAGAIN`; failed exec preserves the
marker and returns to the child. Successful exec commit, `_exit()`, and exact
signal/trap teardown quiesce the borrowing Worker, release its alias and
workspace, and resume the exact parked caller once. An ambiguous forced Worker
termination cannot prove that shared-memory access stopped, so the host
contains the complete address-space owner group rather than resuming the
parent unsafely. Ordinary fork continues to use only the ordinary mode and the
independent-memory path above.

After vfork capture seals, its process Worker reports two exact workspace
requirements in host-intercepted syscall arguments: all active activation
prefixes after alignment and the reference/exception codec scratch high-water.
The centralized host accepts one four-page control slot and returns `EAGAIN`
before allocating the kernel child when the 61,440-byte prefix region or
65,536-byte scratch page would be exceeded. This preflight is connected, but
the workspace belongs to host-reserved control storage rather than a second
process address space.

Step 6 is materially different from native virtual-memory fork. Native
kernels normally map the parent's pages into the child with copy-on-write
ownership, so unchanged pages are not copied. Browser WebAssembly exposes no
equivalent operation for cloning a `WebAssembly.Memory`. Kandelo must allocate
a fresh memory and copy the parent's complete current address space before an
ordinary fork child runs. An ordinary fork child that immediately calls
`exec()` therefore pays for both the discarded fork copy and the replacement
program memory. Kandelo's
non-forking `posix_spawn()` path avoids that copy when the caller can describe
the requested child entirely with spawn actions and attributes.

Kandelo releases its references to an exited or replaced process generation
only after the exact Worker, channel, thread, and framebuffer ownership fences
complete. JavaScript engines still decide when the unreachable shared backing
returns physical memory to the host. A burst of large fork/exec children can
therefore allocate faster than a browser reclaims retired generations even
when ownership teardown is correct. Temporary package compatibility
exceptions and their removal criteria belong in the active migration plan;
they do not redefine ordinary `fork()` semantics.

If the root continuation mapping cannot be allocated, `kernel_fork` returns the
negative mmap errno before unwind starts. If a later node allocation fails,
the owning module enters `ABORT_UNWINDING`: the live failing activation
restarts at its call site, committed inner nodes replay to the original fork
import, and the host releases the partial chain before returning the negative
errno. A negative `SYS_FORK` result after step 4 instead uses the complete
parent rewind. These resource failures create no child and leave the parent in
`NORMAL`, able to continue or retry `fork()`.

ABI 43 reconstructs reference locals/parameters/carryovers, concrete and
abstract GC objects, mutable reference globals, and complete exception state.
Statically tagged scalar `Catch`/`CatchRef` arms keep their exact selector and
maximum live operand tuple in activation-owned bytes; rewind rethrows the tag
so the original clause creates a fresh instance-local exnref.
Reference/vector payloads, `CatchAll`/`CatchAllRef`, JSTag ingress, and modern
C++ cleanup exnrefs use the complete-exception recipe and likewise re-enter the
original Wasm handler without parent-instance scratch. See
[fork-instrumentation.md](fork-instrumentation.md) for the ownership formats
and cleanup ordering.

A fork reached inside instrumented dlopened side modules uses one process-wide
event journal plus one linked continuation per active module. Unwind records
the exact leaf-to-root activation/function order; fresh-child replay consumes
the reverse order. This supports nested main-to-side-to-side stacks without
assuming that the main activation is present at the leaf. Versioned
fork-instrument capability metadata lets
marker-present artifacts prove their role, and ABI 43 additionally requires
`FORK_CAP_ACTIVATION_STATE_SAFE` before launch. ABI 16 defines the historical
five-export fallback, while ABI 18 and later require role claims and reject
stale call-graph artifacts. The ABI 36 epoch combines that contract with
side-module replay state and concurrent pthread-fork arbitration. Dlopen replay
records both the parent's memory base and exact table base, including null gaps
left by failed loads, then re-instantiates each side module's static element
initialization at that exact base in the child. The process table journal then
applies later loader and guest `table.set`/`fill`/`copy`/`init`/`grow` effects
through typed recipes after every referenced activation catalog is present.
TLS-bearing side modules additionally record their live,
positive `__tls_base`. A child restores the pointer-width-correct mutable
global without calling `__wasm_init_tls`, because copied memory already holds
the parent's live TLS bytes and reinitialization would reset C++ unwinder state
and application `thread_local` values. C++ exceptions and longjmp use one
canonical pointer-width tag identity across the main image and all side
modules; a main-exported tag wins over the host-created fallback.

ABI 43 libc drives dynamic initialization as a non-reentrant transaction.
`__wasm_dlopen_prepare` validates and owns a private transaction without
entering guest code. Each `__wasm_dlopen_next` advances host-only compilation
and instantiation of the `DT_NEEDED` closure as needed. Instrumentation has
removed the native start section and converted active segments plus the
original start function into an explicit bootstrap, so
`new WebAssembly.Instance(...)` cannot run that guest path inside `next`.
The call publishes one canonical initializer table entry and returns; libc
then calls that entry as ordinary Wasm before requesting the next stage. A
constructor that calls `fork()` thus has a normal instrumentable Wasm call
chain rather than a suspended host import beneath it. Before reachability
analysis, the instrumenter turns the
historical two-, four-, and five-argument private `__wasm_dlopen` function
imports into in-place local adapters that prepare the transaction and
tail-call an ordinary Wasm driver for their initializers. This retains all
aliases of the old function without retaining the reentrant host boundary.
The two-argument form retains its original
`dlopen:<buffer-address>:<byte-length>` identity. ABI 43 artifact and launch
validation require both the legacy import and the completed artifact's native
start section to be absent. Valid source modules may contain a start section;
instrumentation transfers it to `wpk_fork_module_bootstrap` before admission.
The lower-level `DynamicLinker.dlopenSync()` driver remains available to
standalone embedders, but it is not a process import.

The kernel cannot replace the process-local half of this protocol. It can own
path authorization, loader scheduling, and replay policy, but the kernel
Worker cannot inject Store-local functions, exception tags, or GC identities
into the process Worker's tables. Core Wasm cannot instantiate arbitrary
runtime module bytes itself, and those JavaScript references are not
structured-clonable between Workers. A kernel syscall would therefore need a
request/yield/resume protocol that still delegates instantiation and catalog
registration to the process Worker; it would relocate, rather than remove, the
boundary. In particular, using the generic syscall import instead of a named
loader import would not itself change reentrancy. The contract is that every
process-local host operation returns before guest initialization begins.

The process worker can issue VFS and mapping requests while a staged loader
import is active, but those JavaScript-owned channel completions cannot invoke
libc's signal trampoline. They set
`REQUEST_FLAG_DEFER_SIGNAL_DELIVERY`, leaving any caught signal in the kernel,
and libc performs an ordinary checkpoint after every `prepare`/`next` return
and after `dlclose`. Constructors still begin only after both the import and
checkpoint return, so signal delivery and dynamic initialization add no
host-to-Wasm reentrancy.

The dlopen replay list and its atomic pthread-fork lock live in a transient,
host-private control record. The same host build writes and reads that record
during one process lifetime; guest code and persisted artifacts never
interpret it. Changing that record's size is therefore not a guest ABI change,
while the public ABI snapshot/classifier remains authoritative.

Pthread workers have separate Wasm instances, tables, and exception tags, so
no JavaScript reference is structured-cloned from the process worker. Each
pthread owns a local dynamic-linker replica. Under the process archive lock it
compares a shared generation, instantiates missing side modules at their exact
bases, registers fresh function/exception catalogs, and applies the typed table
journal. The same mechanism supports `dlopen`/`dlsym` from a pthread and fork
from a pthread after dynamic loading; the fork child reconstructs only the
calling thread but receives the process module/table recipe state. The
generation fast path avoids reparsing or reinstantiating unchanged state.

Fork and non-forking spawn copy each process's descriptor-table shell while
retaining one exact mutable OFD state object. Offset, status flags, and async
owner therefore remain shared across the copies. Directory host iterators are
process-local because their handles and pending records cannot be owned by two
processes safely; a shared position generation makes a stale iterator close,
reopen, and replay at the authoritative cookie before its next read. Stateful
objects additionally retain their kernel-global backings: eventfd counters,
timerfd timers, signalfd masks, memfd contents and cursors, procfs snapshots,
pipes, sockets, PTYs, terminal devices, and listener queues.

### exec()

1. A process calls `execve()` or `execveat()`. The centralized kernel worker
   reads the pathname arguments and derives a `diagnosticPath`. For
   `AT_EMPTY_PATH` and relative `execveat()`, path getters may help produce that
   display string. The host may pass it to `preparePath()` as a lazy VFS
   materialization hint. Both uses are diagnostic-only: neither the string, a
   path getter, nor a host program map authorizes the executable.
2. While the old image is live, the same kernel-worker entry calls
   `kernel_exec_target_prepare(pid, caller_tid, dirfd, path, flags)`. Rust
   validates the exact caller and `execveat()` lookup rules, resolves the
   executable from authoritative process/VFS state, checks execute capability,
   and returns an owner-bound one-shot token retaining the exact open file
   description (OFD), bytes, and security metadata.
3. The host queries `kernel_exec_target_size` and copies the retained target
   through bounded `kernel_exec_target_read` calls into only the explicitly
   lent destination. A precommit failure calls `kernel_exec_target_cancel`
   exactly once. For a shebang, the script token is canceled, `argv` is
   rewritten once, and a separately prepared interpreter becomes the sole
   final target; script set-ID state is never applied.
4. The host validates the exact bytes' ABI marker and fork-artifact policy,
   compiles those same bytes, validates the 4 MiB combined argv/environment
   representation and generated vector caps, and completes replacement
   `WebAssembly.Memory` allocation/layout preflight before the irreversible
   transition. Each metadata string must also fit the current 64 KiB transfer.
   Any failure here cancels the token and returns to the old image.
5. Still before commit, the host publishes and flushes writable tracked
   mappings. A failed flush leaves the old mapping trackers and SysV
   attachments in place. Tracked shared mappings retain a lifetime-stable host
   handle independent of the guest fd, so closing that fd does not prevent
   writeback.
6. The asynchronous host callback receives target-derived data but no token or
   commit closure, and returns a bounded replacement-memory launch plan. The
   shared launcher then invokes
   `kernel_exec_commit(pid, caller_tid, opaque_target)` synchronously through
   the same centralized entry and starts the returned postcommit action before
   yielding. Rust consumes the token,
   revalidates the final retained target's exact handle, byte length, bytes,
   metadata, and execute capability, then atomically commits the in-place
   process transition. Commit closes CLOEXEC fds and directory streams, resets
   image-specific state including the program break, and preserves the exact
   kernel objects behind surviving descriptors without pathname re-resolution.
   The diagnostic-only path and caller-provided bytes are never commit
   authority.
7. After commit, the host retires the old process and sibling-thread workers,
   detaches old SysV mappings, installs the preflighted replacement memory, and
   starts the replacement Worker. Failure to construct or initialize that
   Worker is fatal because the committed old image cannot return. The host
   parses the replacement's `__heap_base` and registers it so `brk(0)` starts
   above the new data and stack layout. `alarm()`/`ITIMER_REAL` survives, while
   `timer_create()` timers are deleted. The remaining descriptor, signal, and
   mapping gaps are tracked in [posix-status.md](posix-status.md).
8. The new program starts from `_start` with the given argv/envp. The process
   worker holds one immutable UTF-8 snapshot for the complete launch. The CRT
   first queries every entry length with zero destination capacity, verifies
   the generated count, per-entry, and caller-width aggregate limits, and then
   obtains an exact-lifetime anonymous mapping through the ordinary syscall
   channel. Each second call carries that entry's exact capacity and must
   either copy the complete unchanged bytes or return `ERANGE`; allocation
   failure, an invalid guest pointer/range, or a query/copy mismatch traps
   before `_start_c` publishes any argv or environment pointer. The mapping
   remains live because libc's `argv` and `environ` retain those pointers.
   This is guest-process memory, not kernel scratch, and it avoids reserving a
   4 MiB worst-case static buffer in every program.

The `__heap_base` registration in step 7 is required: without it,
`MemoryManager` falls back to a hardcoded 16MB `INITIAL_BRK`, which can land
*inside* the stack region of programs whose data section pushes `__heap_base`
above 16MB (mariadbd's `__heap_base ≈ 16.32MB`). Heap allocations there collide
with shadow-stack frames during C++ static initialization, corrupting memory
and hanging in `__wasm_call_ctors`.

### posix_spawn() (non-forking)

POSIX `posix_spawn` is normally fork+exec done atomically. Our kernel
ships a custom syscall (`SYS_SPAWN = 500`, host-intercepted in
`host/src/kernel-worker.ts`) that builds the child directly — no fork,
no `wpk_fork_*` rewind, no exec replay. This is the fast path popen,
`system`, shell pipelines, nginx-FastCGI, and any direct posix_spawn
caller now take.

1. Glue (`libc/musl-overlay/src/process/wasm32posix/posix_spawn.c`) marshals
   argv + envp + file actions + spawn attrs into a contiguous blob and
   issues `__syscall6(SYS_SPAWN, path, path_len, blob, blob_len,
   &pid_out, 0)`. Wire format documented in
   `docs/plans/2026-05-04-non-forking-posix-spawn-design.md` Section 1.
2. Host (`handleSpawn` in `kernel-worker.ts`) reads the blob from
   caller memory, validates argv + envp against the same 4 MiB `ARG_MAX`
   contract as `execve`, and performs a side-effect-free candidate lookup and
   compilation. Shared trusted code immediately snapshots the resolver bytes
   and compiles the candidate module from that exact isolated snapshot; a
   separately callback-supplied module is ignored. That preflight prevents
   failed PATH probes from creating a child, but it is never executable
   authority. The host then copies the blob to bounded kernel-owned scratch.
   Each argv/environment entry also has the separate 64 KiB
   process-metadata transport limit described for `execve`; this
   implementation ceiling is not `ARG_MAX`.
   Ordinary blobs reuse the channel-sized syscall region and call
   `kernel_spawn_process(parent_pid, caller_tid, blob_ptr, blob_len)` while its
   lease is active. A blob above that size begins an exclusive tokenized
   reservation in the Rust-owned reusable region, reads its pointer and
   capacity, copies under a lease, and commits with
   `kernel_spawn_reserved_process(parent_pid, caller_tid, token, blob_len)`.
   Begin and the pointer/capacity queries are nonblocking and report
   contention as `EBUSY` or zero. Commit consumes the token before parsing.
   After every successful begin, the host unconditionally calls cancellation
   from a `finally` block, including setup and copy failures. Cancellation
   success releases an unconsumed matching token; `EINVAL` means the
   never-reused token was already consumed or is stale. For the just-issued
   in-contract token after commit, consumption is expected. Commit and
   cancellation use a blocking critical section that performs no host imports,
   so both return with a definitive token state.
   Host-side reentry protection rejects a second large spawn while the first
   reservation is active. Keeping both paths kernel-owned prevents a
   large environment or file-action list from overwriting adjacent Rust heap
   state. Merely fitting within the total kernel `Memory` would not establish
   this allocation-ownership fact. The explicit 8,417,320-byte whole-blob
   ceiling also bounds file-action data that `ARG_MAX` does not count. The
   advertised 4 MiB `ARG_MAX`,
   4,096-byte `PATH_MAX`, and 1,024-entry `IOV_MAX` live in
   `crates/shared/src/lib.rs::platform_limits` and generate the Rust,
   TypeScript, and musl consumers. The same platform module owns the defensive
   4,096-entry process-startup caps; the spawn parser aliases them rather than
   repeating the values. The separate authoritative spawn wire
   contract generates the four-byte string-offset width; every offset in the
   40-byte header and 28-byte action record; the `OPEN`, `CLOSE`, `DUP2`,
   `CHDIR`, and `FCHDIR` opcodes; musl's complete transported spawn-attribute
   byte; the shared argv and environment entry caps; 1,024 actions; and the
   complete ceiling. Transporting an attribute bit does not claim its
   behavior is implemented: the kernel currently interprets `RESETIDS`,
   `SETPGROUP`, `SETSIGDEF`, `SETSIGMASK`, and `SETSID`; `SETSCHEDPARAM`,
   `SETSCHEDULER`, and `USEVFORK` remain unimplemented. The
   argv/environment count caps defend the admitted process representation and
   are not additional POSIX `ARG_MAX` promises. The action count remains a
   spawn-parser limit.
3. Kernel parses the blob (`crates/kernel/src/spawn.rs::parse_blob` —
   the trust boundary; bails with EINVAL on any malformed offset), validates
   `caller_tid` as a live task belonging to the parent, and calls
   `ProcessTable::spawn_child_for_caller`.
4. `spawn_child_for_caller` allocates the child PID from the same global task-ID sequence
   used by top-level creation, fork, and clone, then consumes that opaque
   allocation token to build the child Process plus selective inheritance from the
   parent (the complete real/effective/saved uid/gid and supplementary-group
   record, pgid/sid/cwd/umask/rlimits, the calling task's blocked
   signal mask, fd_table + ofd_table +
   sockets via the `bump_inherited_resource_refcounts` helper that
   fork also uses), applies attrs in POSIX order (RESETIDS → SETSID →
   SETPGROUP → SETSIGMASK → SETSIGDEF), so `POSIX_SPAWN_RESETIDS` changes only
   effective IDs to the inherited real IDs and `POSIX_SPAWN_SETSIGMASK`
   replaces the inherited caller mask, then applies file actions once in
   forward order. Failure on any action rolls back via `remove_process`.
5. In the resulting child CWD, descriptor, and credential state, the host asks
   Rust to prepare an exact executable target. The host reads those retained
   bytes and reuses only the module compiled from the isolated preflight
   snapshot, and only when every byte is identical; otherwise it recompiles
   the final bytes. The opaque child-bound token is
   committed with `kernel_spawn_exec_commit`, which evaluates set-ID and
   trusted-mount/nosuid policy and closes remaining `FD_CLOEXEC` descriptors.
   Any prepare, read, policy, compile, or commit failure cancels the exact
   target and removes the pending child and its host mirrors without replaying
   file actions or mutating the parent.
6. Only after exact commit does the host's `onSpawn` callback (Node:
   `host/src/node-kernel-worker-entry.ts::handlePosixSpawn`; Browser:
   `host/src/browser-kernel-worker-entry.ts::handlePosixSpawn`)
   receive the target-derived bytes and module and instantiate a fresh Worker
   for the child. Until that callback succeeds, the kernel marks the child as
   an unpublished spawn transaction: it remains signalable and retains real
   exit status, but sibling `waitpid()` calls cannot select or reap it.
   Completion calls the parent-bound `kernel_publish_spawn_child` exactly once
   in the same serialized kernel entry that publishes the spawn result, then
   wakes queued waiters. A child that died during asynchronous target work is
   therefore returned successfully to `posix_spawn()` and becomes a waitable
   zombie only after its PID is published. Ordinary failure removes the hidden
   child and wakes parked waiters to observe `ECHILD`. Existing target commit
   cannot provide this seam because it runs before Worker launch, while
   `kernel_remove_process` is failure-only; neither can atomically change wait
   visibility and return the final disposition after host launch.
   If the parent exits before publication, Rust returns `ECHILD` while retaining
   exact ownership of the hidden child so the same rollback seam removes it
   once; an absent child instead returns `ESRCH` and is never removed again.
   The detached completion enters the serialized kernel directly rather than
   through the parent's mailbox registration, so parent Worker teardown cannot
   drop that final removal. Parent memory is written only after the completion
   separately proves that the exact channel registration is still active.
   The host registers the Worker's memory and channels against the Process the
   kernel already inserted; registration does not create or select the child
   identity. The kernel returns the allocated pid via `pid_out_ptr` only after
   this launch and publication succeed. A parented `proc_event` spawn
   notification remains a separate observer effect.

PATH search lives in libc (`posix_spawnp.c`); the kernel never sees
PATH-relative names.

The implementation is regression-guarded by a per-process counter:
`kernel_get_fork_count(pid)` returns the number of times that pid has
called `kernel_fork_process`. The vitest harness snapshots this monotonic
counter after each guest child-creation event, while the parent still exists,
and asserts every sample is 0. Any non-zero value means the path silently fell
back to fork. Sampling before parent exit is required because the host reaps a
completed top-level process after consuming its exit status.

**Browser parity:**

* `BrowserKernel.getForkCount(pid)` mirrors `NodeKernelHost.getForkCount`
  — round-trips a `get_fork_count` message to the kernel-worker entry,
  which calls `kernel_get_fork_count`. Exposed via the public
  `BrowserKernel` API.
* `BrowserKernel.spawn(...)` accepts an `onStarted(pid)` option for
  capturing the spawned pid before awaiting exit (same shape as
  `NodeKernelHost.spawn`).
* End-to-end Playwright coverage lives in
  `apps/browser-demos/test/demos.spec.ts` ("simple: spawn-smoke uses
  non-forking SYS_SPAWN on browser host"). The simple browser page
  registers `/usr/bin/hello` as a lazy file pointing at `hello.wasm`
  via `BrowserKernel.registerLazyFiles`, then spawns spawn-smoke. The
  test asserts stdout contains `OK` + `Hello from`, exit code 0, and
  `data-fork-count=0` on the page (guardrail mirroring the Node
  vitest assertion).
* The structural source-text test (`host/test/spawn-host-parity.test.ts`)
  remains as a fast-CI tripwire for someone removing one of the
  parallel wires.

### Host-owned top-level process lifecycle

Processes launched directly by the Node or browser host, rather than by a guest
parent, are registered as children of the host-parent `ppid=0` sentinel. Their
exit status is consumed by the host's spawn result or exit promise, so there is
no guest process that can call `waitpid()` for them. After the process and
thread workers have terminated and their syscall channels are deactivated, the
host asks Rust to reap the exited `(parent=0, child=pid)` entry. Rust verifies
both the parent relationship and exited state before releasing the executable
process record and wait status. If the process is a group leader with live
members, Rust retains only its resource-free `Limbo` group identity until the
group empties.

This cleanup is intentionally narrower than hiding zombies or reaping every
process during host teardown. A process with a guest parent does not satisfy the
`ppid=0` check and remains an exited zombie until that parent consumes its
status through `wait()`/`waitpid()`.

This cleanup also does not implement orphan adoption. Kandelo does not yet
reparent a guest descendant when its parent exits, so such a descendant can
still become an unreapable zombie after it exits. That existing process-
lifecycle gap is separate from reaping direct host-owned launches.

### clone() (threads)

1. User calls `clone(CLONE_VM | CLONE_THREAD, ...)` → kernel returns clone request
2. Host asks the kernel to reserve one dynamic pthread control slot in the same process address space
3. Host grows the process `WebAssembly.Memory` only far enough to cover that slot
4. Host spawns a new worker that shares the parent's `WebAssembly.Memory`
5. Thread worker runs `centralizedThreadWorkerMain`, calls `__wasm_thread_init` to set up TLS
6. Thread starts executing the given function pointer with the given argument

Threads share memory with the parent (CLONE_VM) but have their own channel, fork-save scratch page, and TLS/control page.

## Memory Layout

Each process has a WebAssembly linear memory (shared, up to 1GB by default). The host does not instantiate that memory at the maximum size. It creates the memory large enough for the wasm import minimum plus the main-thread control pages, then grows it after successful guest allocation syscalls or after dynamically reserving a pthread control slot.

```
Address           Region
0x00000000        Wasm data segment (globals, static data)
0x00110000        Global base (--global-base=1114112)
__heap_base       First linker-free byte exported by the program
control_base      Host-owned low control slab
                  - main page 0: fork-save/scratch
                  - main page 1: syscall channel primary page
                  - main page 2: syscall channel spill page
control_end       End of host-owned control slab
brk_base          Initial brk; brk(0) returns this address
mmap_base         First automatic mmap address; normally equals brk_base
...               Guest-managed brk/mmap address space, with dynamic
                  host-reserved pthread slots interleaved as needed
                  - slot page 0: TLS/control
                  - slot page 1: fork-save/scratch
                  - slot page 2: syscall channel primary page
                  - slot page 3: syscall channel spill page
...
MAX_PAGES         End of memory (1GB default)
```

For current binaries, `control_base` is page-aligned from the larger of the imported-memory minimum and the program's `__heap_base`. The host installs only the main control pages before `_start` can run, then calls `kernel_set_brk_base(pid, control_end)` and `kernel_set_mmap_base(pid, control_end)`. `__heap_base` is therefore treated as "first byte available to the host layout" rather than the value returned by guest `brk(0)`.

The Rust ABI declaration in `crates/shared/src/lib.rs` is the source of truth for this layout and is mirrored into `abi/snapshot.json` plus generated TypeScript constants. The main control area uses three Wasm pages: fork-save/scratch, syscall channel primary, and syscall channel spill. Each pthread slot is four Wasm pages addressed from the slot start: TLS/control, per-thread fork-save/scratch, syscall channel primary, and syscall channel spill. Pthread workers share the process `WebAssembly.Memory`; the host gives each worker a distinct dynamically reserved slot and returns the slot to that process's allocator after thread exit.

Processes may export `__wasm_posix_thread_slots` to declare their maximum concurrent pthread count. A value of `-1` uses the host default, `0` allows no pthreads, and a positive value sets the exact per-process limit. The kernel worker creation options expose `defaultThreadSlots` for the `-1`/missing-export case. The built-in default is 1024: an intentionally arbitrary high limit meant to avoid pthread availability problems for most programs now that slots are reserved on demand. Hosts can lower or raise it with `defaultThreadSlots` when they need a different resource policy. This limit is a resource-control guard, not a static memory reservation.

`mmap` remains coherent because the kernel has one per-process address-space model for brk, mmap, and host-reserved dynamic control ranges. Automatic `mmap` starts at the process's `mmap_base`, not at the legacy fixed 64MB floor. A usable non-fixed address hint is preferred after rounding it down to the 64KB Wasm page boundary; an occupied or invalid hint falls back to the ordinary first-fit search. `brk` growth succeeds only when the adjacent range is free; if an mmap region or host-reserved pthread slot occupies the next pages, `brk` fails by returning the old break. `MAP_FIXED`, `munmap`, and `mremap` growth are rejected when they would overlap the reserved prefix, legacy host-control range, or a host-reserved pthread slot. `munmap` rounds its length up to a Wasm page before updating both kernel mappings and host-owned bindings. The host grows the process `WebAssembly.Memory` after successful brk/mmap/mremap syscalls and after dynamic pthread-slot reservations so returned guest addresses are backed before user code touches them.

### Shared mapping coherence

Different processes have different WebAssembly memories, so a pointer store in
one process cannot immediately mutate another process's linear memory. Kandelo
coordinates anonymous `MAP_SHARED`, SysV SHM attachments, and regular-file
`MAP_SHARED` mappings at guest-to-kernel syscall boundaries. For each mapping,
the host compares process memory with the snapshot that process last observed,
merges only changed byte runs into one authoritative backing, and then imports
peer updates into every stale alias in the calling process. Fork force-publishes
the parent before the child inherits the same backing; `exec`, exit, crash,
`munmap`, `mremap`, and `MAP_FIXED` update backing ownership explicitly.

Regular-file mappings add a backend-qualified stable identity and retain the
original fd's host handle for the mapping lifetime. Identity is derived and
revalidated through that live handle, never by reopening its remembered path.
Node uses native device/inode identity; VFS backends scope device/inode identity
to the handle's backend object, so hard links and the same backend mounted at
more than one path alias correctly without colliding with a different backend.
OPFS assigns session-scoped inode tokens in its worker and uses
`FileSystemHandle.isSameEntry()` to unify simultaneous opens. The token remains
attached to a live file object across rename and unlink, while unlink followed
by recreation receives a different token. OPFS stat transport carries device
and inode as integer `u64` values rather than JavaScript `number`/float64.
Dirty mapped data is published before
direct file reads or writes and before a private mapping takes its snapshot;
successful direct writes, truncation, allocation, splice, and copy operations
invalidate or refresh mapped cache pages. `msync`, replacement, unmap, exec,
and process teardown persist dirty pages through the stable handle, including
after the original guest fd is closed or its pathname is unlinked or renamed.

This is syscall-boundary coherence, not shared physical memory. A process that
only performs direct loads/stores does not publish or import peer changes until
it crosses into the kernel. Futex waits and wakes also target the caller's own
process `SharedArrayBuffer`, so process-shared pthread mutexes/futexes remain
unsupported across PIDs. Shared mappings of in-kernel memfds return `ENOTSUP`,
as do file mappings on any backend that cannot provide stable identity;
`MAP_PRIVATE` is unaffected. File bytes past
the current EOF are zero-filled or discarded on refresh/writeback rather than
raising Linux's `SIGBUS`, and writes made outside Kandelo's file syscall paths
are not detected. The boundary scans are on the syscall hot path; no performance
claim is made without before/after Node and browser benchmarks.

Every spawn or exec computes a fresh layout from the target binary's memory
import and `__heap_base`; the brk, mmap, control-channel, allocator, and kernel
metadata state is per-process and is reset when ownership changes. Each
generation receives a newly constructed, exactly sized
`WebAssembly.Memory`. Retired process memories are never zeroed and handed to a
later process: shared Wasm memory cannot shrink, engines retain native backing
stores differently, and `Worker.terminate()` is not a portable ownership
fence.

Normal exit and exec wait for an exact `memory_quiescent` message from every
process Worker and pthread Worker before dropping host aliases. Forced
termination drops the kernel realm's aliases but never makes the backing
eligible for reuse. Whole-host destroy synchronously closes process/pthread
Worker creation admission, waits for every already-admitted async creator to
finish or roll back, then terminates every nested process and pthread Worker.
It finally terminates the containing kernel Worker even if that bounded
graceful detach attempt fails or times out. That realm boundary is the final
release fallback; a false graceful result never asks the main thread to keep a
partially detached kernel Worker alive.

The allocator applies a hard live-address-space count and samples a live-byte
admission budget before each new allocation. Uninstrumented
`WebAssembly.Memory.grow()` does not call JavaScript, so simultaneous live
memories can grow past the aggregate byte budget until the next allocation
observes their current lengths; each memory's configured maximum remains its
hard growth cap. A truly hard aggregate cap would require reserving every
memory's theoretical maximum or mediating/instrumenting growth.

Recently retired generations contribute to a separate short admission
threshold. Crossing that count or byte threshold pauses later allocations, but
does not reject retirement: one already-grown backing or several already-live
generations exiting together may overshoot it. JavaScript cannot hard-bound
engine-native backing that an engine has not reclaimed. `FinalizationRegistry`
and a coalesced 4 MiB ordinary-allocation pressure hook provide telemetry and
an engine-reclamation nudge only; neither is correctness or capacity
authority. The pressure hook stays enabled because the controlled Node churn
negative control has intermittently retained history-proportional resident
memory when disabled, while enabled runs have reclaimed consistently. Other
disabled runs collected in a later large step. These observations are
engine-specific evidence for the default, not a collection guarantee. The
dated Node, Chromium, Firefox, and WebKit measurements and their limitations
are recorded in
[`docs/measurements/2026-07-28-process-memory-retirement-rss.md`](measurements/2026-07-28-process-memory-retirement-rss.md).

Fork first checks live-memory capacity and the retired-generation count and
byte thresholds synchronously. If retired debt is already saturated, fork
returns `EAGAIN` before constructing or copying another address space. It
cannot wait asynchronously at that point: a sibling thread could mutate the
parent memory while the caller yielded, changing the purported syscall-time
snapshot.

Once admitted, the host synchronously acquires an exactly sized fresh backing
and copies the parent's current memory length before the first asynchronous
host operation. This preserves the syscall-time snapshot even if a sibling
thread execs while the child Worker is prepared. The child copies the current
length, not the configured maximum, because `memory.size()` and the accessible
address-space boundary are part of the state fork duplicates. Pthread workers
share the owning process memory plus that process's thread allocator. A fork
child does not inherit dead parent pthread slot reservations. Correctness must
not depend on page reloads, context resets, periodic kernel resets, or garbage
collection reclaiming retired shared memories.

### Pthread slots and fork

POSIX `fork()` from a multithreaded process creates a child with exactly one live thread: the caller. The child copies the parent's memory bytes, but the host must not restart or retain every parent pthread worker.

The dynamic slot rules follow that POSIX shape:

- fork from the main thread copies memory and kernel process state but inherits no dynamic pthread slot reservations;
- every fork resolves the caller's linked-frame anchor before allocating the
  child and carries it in a `ForkLaunchRequest`; pthread requests additionally
  carry `fnPtr`, `argPtr`, and the caller's exact slot range;
- after `kernel_fork_process` creates the child kernel process, the host calls `kernel_reserve_host_region_at(childPid, slotStart, slotLen)` to retain only the caller's copied pthread slot;
- the child worker uses the copied pthread fork-save buffer and enters the saved pthread function before `wpk_fork_rewind_begin` replays to the fork call site;
- all other parent pthread slots become ordinary copied memory bytes in the child and may be reused later by child `brk`, `mmap`, or new pthread slots.

Retaining the caller slot instead of migrating its TLS into the main control prefix keeps fork replay simple: `wpk_fork_rewind_begin` restores the saved `__tls_base`, `__stack_pointer`, and other mutable globals exactly as the calling thread wrote them. The cost is one retained 256 KiB address-space reservation for fork-from-pthread children.

### Heap initialization (brk)

The kernel's `MemoryManager` tracks `program_break` per process. On every `spawn` and `exec`, the host parses `__heap_base` from the new program's exports (`extractHeapBase` in `host/src/constants.ts`), computes the low control slab, and calls `kernel_set_brk_base(pid, control_end)` *before* the new worker can issue its first syscall. The new program's first `brk(0)` returns the first guest-managed byte after host control memory, so musl's malloc places the heap above the data, shadow-stack, and host control regions.

The kernel's hardcoded `INITIAL_BRK` (16MB) is a fallback for binaries that don't export `__heap_base`. Programs built with our SDK always export it, so the fallback is rarely used in normal operation. `fork` correctly inherits the parent's brk, mmap base, max address, reserved prefix, and mappings via the kernel's process-state serialization; `exec` resets them (POSIX-correct) and the host installs the new program's computed layout.

## Filesystem

### Mount table model

`VirtualPlatformIO` (`host/src/vfs/vfs.ts`) is the kernel's filesystem router
on both hosts. It is configured with a list of
`MountConfig { mountPoint, backend, readonly?, nosuid? }` entries and
dispatches every path-based syscall to the backend whose mount prefix is the
longest match. Cross-mount operations (`rename`, `link`) are rejected with
`EXDEV`. A path that matches no mount returns `ENOENT`.

Set-ID follows the ordinary POSIX mount model. A mount honors set-user-ID and
set-group-ID mode bits unless `nosuid: true` is explicit. `VirtualPlatformIO`
authoritatively clears or sets `ST_NOSUID` in `statfs()` and `fstatfs()` from
that resolved mount option instead of trusting a backend's raw flags. VFS image
origin, mutability, and first-party status do not grant or remove authority:
root ownership, inode mode, and the mount flag are authoritative. A custom
image's guest root can therefore install, replace, or create set-ID programs
without acquiring any host privilege.

`FileSystemBackend` (`host/src/vfs/types.ts`) is the per-mount interface (open/read/write/stat/readdir/symlink/...). Two backends are in use today:

Guest-visible VFS numbers come from `crates/shared` and are recorded under
`vfs_metadata` in `abi/snapshot.json`. The generated
`host/src/generated/abi.ts` bindings supply open and `*at` flags, descriptor
and `fcntl` values, access modes, statfs flags, file modes, directory-entry
types, and seek constants to shared Node/browser host adapters. This records Kandelo's existing
guest ABI; it does not establish a general Linux-compatibility contract. The
standalone OPFS worker and the vendored SharedFS implementation retain local
copies at their explicit entry-point and vendor boundaries.

- **`MemoryFileSystem`** (`vfs/memory-fs.ts`) — SAB-backed in-memory FS. Used for the rootfs image mount and for browser scratch mounts. Honours uid/gid/mode stored on each inode.
- **`HostFileSystem`** (`vfs/host-fs.ts`) — proxies a Node host directory. Used for Node scratch mounts. Normalises stat uid/gid to `0/0` so the user's macOS/Linux uid does not leak into the kernel. Native creation receives the requested file/directory mode, but later guest `chmod`/`chown` updates are held in VFS metadata only; the Node host never applies native ownership changes.
- **`OpfsFileSystem`** (`vfs/opfs.ts`) — browser-persistent Origin Private File
  System storage. Its dedicated worker assigns exact session-scoped regular-file
  inode tokens and preserves open-file identity through supported moves and
  unlink. Browsers without `FileSystemHandle.isSameEntry()` cannot prove this
  identity and report the unsupported boundary instead of substituting a path.

### Default mount layout

The canonical layout lives in `host/src/vfs/default-mounts.ts` as
`DEFAULT_MOUNT_SPEC: MountSpec[]`. `resolveForBrowser` and `resolveForNode`
(the latter in `default-mounts-node.ts` so `node:fs`/`node:path` stay out of
browser bundles) validate the spec synchronously, then return
`Promise<MountConfig[]>`. Before either promise resolves, the shared resolver
restores every image-backed mount and asynchronously authenticates all imported
atomic lazy-tree seals. Only after every image passes does it normalize legacy
image state and allocate browser scratch filesystems or create Node scratch
directories. A forged later image therefore cannot leave an earlier mount
normalized or a host scratch directory published as a partial boot.

Node may also seed a strict descendant of an existing scratch mount through
`NodeKernelHost.sessionSeedTrees`. The worker authenticates the complete root
image first, copies every quiescent source tree into opaque staging paths using
new regular-file inodes, and renames all completed trees into the private
session before constructing any session-owned `HostFileSystem` backend or
publishing `ready`. Symlinks, special files, overlapping destinations, image
destinations, and destinations shadowed by another mount are rejected. Guest
changes are never written back to the source. This copy boundary matters
because access to a path somewhere inside a Node process is not proof that
Kandelo exclusively owns the inode; exact append and related stateful
operations require a lifecycle-owned backing, not merely a reachable one.

| Mount point | Source | Browser backend | Node backend |
|-------------|--------|-----------------|--------------|
| `/`         | writable image | awaited verified `MemoryFileSystem` restore | awaited verified `MemoryFileSystem` restore |
| `/tmp`      | scratch (ephemeral) | empty `MemoryFileSystem` SAB | `HostFileSystem` under sessionDir |
| `/var/tmp`  | scratch | empty `MemoryFileSystem` SAB | `HostFileSystem` under sessionDir |
| `/var/log`  | scratch | empty `MemoryFileSystem` SAB | `HostFileSystem` under sessionDir |
| `/var/run`  | scratch (ephemeral) | empty `MemoryFileSystem` SAB | `HostFileSystem` under sessionDir |
| `/home/maker` | scratch | empty `MemoryFileSystem` SAB | `HostFileSystem` under sessionDir |
| `/root`     | scratch | empty `MemoryFileSystem` SAB | `HostFileSystem` under sessionDir |
| `/srv`      | scratch | empty `MemoryFileSystem` SAB | `HostFileSystem` under sessionDir |

The writable root image honors set-ID on both hosts. Default scratch mounts,
`/dev`, and `/dev/shm` explicitly use `nosuid`; this is an ordinary mount
choice, not a trust classification for the image. Custom mount specifications
may make the same choice. The browser and Node hosts apply the same rules.

The browser host layers two additional, host-specific mounts on top: `/dev/shm` (the POSIX-semaphore SAB shared with main-thread surfaces) and `/dev` (`DeviceFileSystem` for `/dev/null`, `/dev/zero`, `/dev/urandom`, `/dev/ptmx`, `/dev/pts/N`). Sticky bits, the uid 1000 owner on `/home/maker`, mode `0700` on `/root`, etc. are baked into the rootfs image at build time per the canonical `MANIFEST` and reflected honestly through the `MemoryFileSystem` inode metadata. Scratch mounts on Node start owned by uid/gid 0 because `HostFileSystem` synthesises them.

### rootfs image as the source of truth

`/etc/passwd`, `/etc/group`, `/etc/hosts`, `/etc/nsswitch.conf`,
`/etc/resolv.conf`, and static OpenSSL policy/trust files under `/etc/ssl` are
real files inside `host/wasm/rootfs.vfs`, served through the `/` mount. Any
program that calls `getpwnam`, `gethostbyname`, `getservbyname`, or OpenSSL's
default configuration/trust lookup reads the same image bytes that `cat` would.
The kernel synthesizes `/etc/mtab` because it reports live mount state; it does
not synthesize static `/etc` policy or trust data.

The rootfs data defines the canonical interactive image account as
`maker` at uid/gid 1000 with home `/home/maker`. Its password hash, wheel
membership, sudoers policy, and login messages are ordinary rootfs files.
The package-built `login`, `sudo-lite`, and `sudo` executables are ordinary
root-owned files in that same image. `login` is embedded because terminal boot
requires it immediately; the two sudo implementations remain lazy and are
materialized on first execution. Their mode is `04755`, so execution on the
root image applies the normal set-user-ID transition. Guest root may replace
those files, just as it may replace any other system executable.

The reusable browser session layer owns one lifecycle record per logical PTY.
Its program selection comes from the image's strict experimental
`/etc/kandelo/experimental-terminal-session.json` declaration. First-party and
custom images use the same parser and supervisor; the browser does not infer a
login policy from image origin, account contents, or a compiled product
profile.

For an eligible image/product pair, the first process is root-authorized
`login -p -f maker`; every later process is ordinary `login -p`. UI handles
only attach listeners to that record, while the terminal tab's explicit close
action, kernel detach, reboot, and destruction invalidate its process
generation, terminate the active process, and cancel pending restart. Short
processes back off from 250 milliseconds to a five-second cap, a process that
survives two seconds resets the delay, and a replacement launch failure remains
visible in the terminal without automatic retry. Password authentication stays
in the guest program and final VFS credentials rather than React.

VFS images can also carry image-level metadata outside the guest file tree. The first declaration is `kernelAbi`, an exact `ABI_VERSION` requirement for images that carry ABI-bound Wasm programs. `MemoryFileSystem.readImageMetadata(image)` reads this declaration without materialising the filesystem, and `MemoryFileSystem.assertImageKernelAbi(image, abi)` validates it for callers that already know the running kernel ABI. Legacy/data-only images may omit the field.

### Node host

`NodeKernelHost` accepts
`rootfsImage: "default" | ArrayBuffer | Uint8Array | undefined`. With
`"default"` (the path used by the vitest suite), the worker reads
`host/wasm/rootfs.vfs`, applies `DEFAULT_MOUNT_SPEC` via the private-session
Node resolver, and constructs a `VirtualPlatformIO` for the kernel. The image
supplies both `/etc/ssl/cert.pem` and
`/etc/ssl/certs/ca-certificates.crt`; Node does not silently add them to
caller-supplied images. Optional `sessionSeedTrees` require a rootfs image and
absolute host source paths; each source must remain quiescent until `init()`
resolves. Graceful destroy, initialization failure, and fatal worker paths
attempt to remove the complete session tree; abrupt process termination
cannot run that best-effort hook, so cleanup is not the ownership proof. New
private inodes and publication-before-`ready` establish ownership.

`execPrograms` and `execProgramBytes` are spawn-preflight inputs only. They
cannot authorize `execve` or `execveat`, whose executable bytes and metadata
come exclusively from the exact retained target prepared through the calling
process's kernel VFS state. Tests that name an exec fixture stage it into an
explicit test rootfs before boot. A virtual spawn-preflight path cannot use
both mapping sources. Without a rootfs image, the worker falls back to raw
`NodePlatformIO` (every host path reachable) — kept for legacy callers that
have not migrated.

### Browser host

`BrowserKernel.boot({ vfsImage, ... })` is the kernel-owned VFS path. The worker restores the supplied image (per-demo `.vfs.zst`, typically built on top of the canonical rootfs as a base layer) into a `MemoryFileSystem`, applies `DEFAULT_MOUNT_SPEC` via `resolveForBrowser` (the image becomes the `/` mount; the seven scratch mounts come up empty), and layers `/dev/shm` + `/dev` on top. Browser networking then replaces `/etc/ssl/certs/ca-certificates.crt` with its generated per-session MITM root; the image-owned OpenSSL configuration and compiled-in `/etc/ssl/cert.pem` trust path remain unchanged.

The browser test runner and Git test assemble small kernel-owned VFS images with
`createBuildFsWithEtc` in `apps/browser-demos/lib/kernel-owned-boot.ts`, then
serialize them with `finalizeKernelOwnedImage` and boot them through
`BrowserKernel.boot`. Before serialization, the shared host helper
`overlayEtcFromRootfs` in `host/src/vfs/rootfs-overlay.ts` recursively merges
`/etc/**` from the canonical `rootfs.vfs`. Existing leaves and directory
metadata remain caller-owned, while missing canonical descendants such as
`/etc/ssl/openssl.cnf` retain their source modes and ownership. Missing
canonical `/etc` state, short reads, and target capacity failures abort image
assembly instead of producing an incomplete filesystem.

### Lazy Files

`MemoryFileSystem` supports **lazy files** — files registered with a URL and declared size that are only fetched on first access. This enables loading large binaries (e.g., nginx, PHP-FPM, coreutils) without fetching everything upfront — they are only fetched when a process exec's them.

```typescript
// Register a lazy file (creates empty stub, fetches on demand)
const ino = mfs.registerLazyFile("/usr/bin/php", "https://cdn.example.com/php.wasm", 8_500_000);

// Later, materialize before sync access (avoids sync XHR deadlock with service workers)
await mfs.ensureMaterialized("/usr/bin/php");
```

Lazy file metadata (`path`, hard-link aliases, `url`, `size`, `ino`, inode
generation, and data-mutation sequence) can be transferred between instances
via `exportLazyEntries()` / `importLazyEntries()` — used when workers share the
same SharedArrayBuffer. The generation prevents an unlinked lazy inode from
transferring its URL or declared size to a later file that reuses the same
guest-visible inode number. The data sequence prevents an asynchronous fetch
from overwriting guest data written through another worker while the request
was in flight. Live cross-worker imports require both identity fields; only a
legacy image whose filesystem bytes and lazy JSON form one trusted artifact can
adopt older metadata, and only for an untouched empty stub. Filesystem rebasing
preserves hard-link identity for lazy and
concrete files rather than copying aliases into independent inodes. A rebase
walks one quiescent source snapshot, so a peer rename cannot mix lazy paths
from one namespace state with bytes from another.

`registerLazyTree` is the format-neutral grouped form used by package layers
and other archive-backed consumers. Its serialized metadata adds a closed
decoder/media type, immutable
digest and byte count, transport locations, activation policy, complete source
and guest inventory, and regular-inode groups. Existing
`registerLazyArchiveFromEntries` ZIP consumers remain supported. Registration
and `stat` expose declared logical sizes without fetching content. The first
ordinary open/read or executable resolution starts one asynchronous preparation
for the group; guest syscall retries keep its internal `EAGAIN` sentinel out of
the POSIX result. Every member is decoded and checked before an
identity-guarded batch replacement, so failure leaves all pending regular
inodes unchanged. Hard-link aliases use one SharedFS inode and retain that
identity when the lazy metadata is transferred or saved in an image.

Generic TAR+gzip trees use the closed `tar-gzip-v1` decoder. A tree may carry
a bounded `archive-byte-transforms-v1` plan containing exact source-byte
assertions, ordered literal byte-replacement recipes, and declared input and
output SHA-256/length identities. The VFS interprets no producer callbacks,
regular expressions, scripts, or package policy. It applies the same plan to
eager and lazy decoding, verifies both identities, and publishes only after
the complete transformed tree passes validation. Plan fields participate in
atomic-tree identity and survive image restore and filesystem rebase.

Several first-use trees can opt into one fail-closed activation cohort. Each
tree registers a producer-stable member name, and the producer must explicitly
seal the exact expected member set before the cohort can activate or serialize.
Sealing hashes each member's transport-independent content, mount, activation,
and complete guest/source inventory, then hashes the canonical member set.
Every serialized member carries its descriptor digest, expected cohort count,
and cohort digest, so omitting one tree record or one regular alias makes image
restore fail rather than turning an unbacked zero-byte stub into a concrete
file. Deployment URLs are deliberately outside this identity because an image
may rewrite byte-identical mirrors.

Activation snapshots every declared directory, symlink, regular name, and
hard-link alias before I/O. At most four cohort archives fetch/decode at once;
after the first failure no new work starts, and all already-running workers are
awaited before the attempt rejects, so an immediate retry cannot overlap
abandoned downloads or retain duplicate decoded trees. One SharedFS commit
revalidates the complete namespace while holding its namespace and target-inode
locks. Capacity failure restores every touched stub's empty data, sequence, and
timestamps; directory, symlink, ownership, mode, or alias races reject the
whole cohort. All allocating and potentially throwing publication bookkeeping
is prepared before that commit; afterward one bounded linear pass only retires
the proven lazy identities.

For each declared transport, materialization permits three total GET attempts:
only HTTP 408, 429, and 5xx responses or recognized fetch/body network
interruptions repeat the same URL. The two retry waits default to 250 and 500
milliseconds; a valid `Retry-After` value replaces that wait up to a five-second
cap. A lazy fetcher may register an optional `AbortSignal`; the VFS passes it
to each fetch, aborts a pending retry wait, and checks its exact `reason`
before mirror fallback and namespace commit. That explicit signal preserves
arbitrary `Error` and `TypeError` reasons. Standard `AbortError` and
`ABORT_ERR` shapes remain a compatibility fallback for existing one-argument
fetchers. Permanent HTTP responses and size, digest, decode, inventory, and
commit failures remain truthful failures rather than retry signals.

The generic-tree schema is revalidated through one closed, bounded path at
live registration, cross-worker import, image restore, and filesystem rebase.
Content, activation, mount prefix, inventory, and pending inode metadata reject
unknown fields, unsafe or oversized strings, count/size disagreement, and
missing, cyclic, or cross-inode hard-link targets before a group is installed.
Serialized groups carry an explicit `kandelo-deferred-tree-v1` (derived ZIP),
`kandelo-deferred-tree-v2` (complete source inventory), or
`kandelo-legacy-zip-v1` kind. A sealed multi-tree cohort uses
`kandelo-deferred-tree-v3`, regardless of decoder, because its atomic membership
is an additional closed wire contract; v1/v2 records cannot quietly acquire
those fields. Sealing or importing v3 retains a private immutable snapshot of
the byte identity, decoder bounds, source truth, complete inventory, runtime
inode mapping, integrity, and activation policy. Fetch, decode, preflight,
commit, export, save, and rebase consume that snapshot; the caller-reachable
group remains a compatibility view that may invalidate an operation but cannot
redirect it. Mirror locations remain outside the descriptor digest so image
composition may rewrite them, but that explicit rewrite replaces the private
transport snapshot without changing the sealed byte hash or mapping.

An imported seal claim is structurally valid but untrusted until an asynchronous
SHA-256 pass during save, activation, explicit resealing, or
`verifyImportedLazyAtomicGroupSeals()` verifies every member and the cohort
digest. Synchronous export, pending-resource inspection, and rebase reject a
pending imported cohort before that proof. Image consumers that need those
synchronous operations can await the explicit verifier without fetching or
materializing a tree, snapshotting the filesystem, exporting metadata, or
rebasing storage. Repeated verification is safe; a rejected digest leaves the
cohort untrusted and therefore blocked. This strengthens the existing v3
behavior without changing its serialized fields or digest schema. Concurrent
explicit verification, image save, resealing, and first-use activation join one
per-cohort seal-validation flight instead of hashing the same descriptors
independently. Seal verification remains separate from transport and decode:
once the seal proof linearizes successfully, a later download failure can leave
inspection authenticated while activation stays deferred and retryable.

Newly saved images declare that every group is typed. A deferred tree therefore
cannot enter the less expressive legacy ZIP path by dropping its inventory or
activation fields. Untyped legacy ZIP groups remain a restore-only migration
path for historical images that predate the typed-image flag; restoration
normalizes them to the explicit legacy kind.
Cross-worker imports stage and identity-check the complete batch before
publishing any group, so rejection of a later group cannot leave earlier lazy
metadata active.
Hard-link chains are resolved once with cycle state and path compression, so
validation is linear in the inventory size. VFS lazy-file and lazy-archive JSON
sections are each capped at 16 MiB and checked for truncation before JSON
decoding; deferred-tree imports additionally allow at most 512 groups and
100,000 entries per group. A pending metadata-only tree remains valid and must
still verify its immutable payload through its activation policy.

Build tooling can derive a package-owned deferred ZIP tree from one exact
declared package output. The reviewable spec names the output, its distribution
role (`source-tree` or `runtime-tree`), mount prefix, owner, and first-use
activation roots. The builder reads the exact ZIP once and derives a canonical
typed-tree descriptor containing its digest, byte counts, decoder, and complete
inventory. A lazy image registers that descriptor and keeps the relative
package-output URL; an eager derivative directly materializes the same
descriptor from the same bytes. The eager path is therefore a consumption
choice, not a second package recipe or artifact identity.

Package ZIP trees declare the closed `portable-posix-v1` mode policy. It
normalizes directories to `0755`, symbolic links to `0777`, and regular files
to `0755` when the ZIP member carries any execute bit or `0644` otherwise.
This prevents host-specific archive modes from changing the installed tree,
and the lazy and eager paths validate and install the same normalized modes.
`host/test/package-deferred-tree.test.ts`, in “derives one canonical descriptor
from the exact package output,” covers the policy with deliberately
non-portable input modes.

Relative lazy asset URLs are resolved inside the dedicated kernel worker on
both hosts. Browser boots use `BrowserKernel`'s `lazyUrlBase`; Node boots use
the peer `NodeKernelHost.rootfsLazyUrlBase` option. Closed/offline acceptance
can bind the resolved URL to exact caller-owned bytes through the existing
closed-lazy-asset transport. Before kernel boot, that acceptance-only loader
eagerly fetches bounded source URLs, verifies each complete decoded response
against its declared byte count and SHA-256, and only then associates the
bytes with the separate immutable HTTPS URL stored in the deferred tree. A
source URL is transport input, never VFS authority: absolute cleartext HTTP is
limited to loopback acceptance servers, requests omit credentials and
referrers and reject redirects, and source URLs must not contain bearer
secrets. This eager pre-publication proof is not the product tree's first-use
transport. Metadata inspection and directory enumeration do not fetch a
deferred tree. The first prepared open or executable resolution fetches the
whole declared archive once, verifies it, and atomically materializes the
complete group; later accesses do not fetch it again.

### VFS Images

A `MemoryFileSystem` can be serialized to a portable binary image and restored later to boot a new kernel with a pre-populated filesystem. This enables snapshotting an initialized VFS (with all files, directories, symlinks, and permissions) and restoring it without repeating the setup work.

**Save an image:**

```typescript
// Preserve lazy files as URL references (smaller image, requires URLs at restore time)
const image: Uint8Array = await mfs.saveImage();

// Or materialize all lazy files first (self-contained image, no URL dependencies)
const fullImage: Uint8Array = await mfs.saveImage({ materializeAll: true });
```

Image creation is a quiescent filesystem operation. `saveImage()` rejects a
filesystem with live file or directory descriptors rather than serializing FD
tables, inode open-reference counts, or lock words as durable state. The
resulting bytes contain only filesystem state. Restore also clears those
runtime-only fields in legacy images, so a new machine never inherits handles
or locks from the image builder. Lazy-file and lazy-archive paths are collected
under the same namespace transaction as the filesystem bytes, including names
changed by another worker. `materializeAll: true` resolves both standalone and
archive-backed entries and fails instead of emitting an image that still
depends on a deferred URL.

Kernel-owned machines expose that same durable boundary through
`NodeKernelHost.exportRootfsImage()` and
`BrowserKernel.exportRootfsImage()`. Export is available only after a
VFS-backed kernel has initialized and every guest process and worker teardown
has completed. The owning worker closes a snapshot gate before its first
asynchronous wait, drains host-side mutations that started earlier, and rejects
later spawns, lazy registration, materializing reads, writes, unlinks, and
concurrent exports until serialization settles. The returned image contains
only the `/` image backend; boot-scoped scratch, device, and shared-memory
mounts are recreated on the next boot. Lazy descriptors and image metadata
remain part of the root image, so a deferred package that was never opened
stays deferred after export and restore. Callers must await the export before
destroying the host.

**Restore from an image:**

```typescript
// Creates an independent filesystem and authenticates imported atomic seals
// before the caller may inspect, mutate, rewrite, or boot it.
const restored = await restoreVerifiedVfsImage(image);
```

The restored filesystem is fully independent — modifications to the original or restored instance don't affect each other. Multiple independent instances can be created from the same image.

When restoring for use in a browser, pass `maxByteLength` to create a growable `SharedArrayBuffer` so the filesystem can expand beyond the image's original size:

```typescript
const restored = await restoreVerifiedVfsImage(image, {
  maxByteLength: 1024 * 1024 * 1024,
});
```

The image must also have been built with a large enough filesystem maximum, for example `MemoryFileSystem.create(sab, 1024 * 1024 * 1024)`. `restoreVerifiedVfsImage(..., { maxByteLength })` only controls the restored buffer's runtime growth ceiling; `statfs`/`df` and allocation remain capped by the image superblock maximum.
Call `MemoryFileSystem.readImageCapacity(image)` when build tooling needs the
serialized buffer length and superblock ceiling without restoring the image.
Await `restoreVerifiedVfsImagePreservingCapacity(image)` to restore and
authenticate a growable buffer with the same ceiling the image builder
recorded.

A consumer that must stage files larger than the image's recorded allocation
ceiling first calls `rebaseToNewFileSystem(requiredMaxBytes)`. Shared image
helpers never treat a partial file as complete: `writeVfsBinary` advances over
positive short writes and throws on zero/negative progress or an underlying
filesystem error, while still closing the descriptor.

Kandelo browser UI presets use this approach. Each image builder pre-populates a VFS with runtime files, directory structure, configs, and symlinks, then saves it as a `.vfs.zst` file (zstd-compressed; `saveImage()` compresses on write). At runtime, the UI fetches the file and `restoreVerifiedVfsImage` decompresses it transparently and authenticates imported atomic lazy-tree seals before returning it. Restoring the image replaces thousands of individual file writes with a single buffer copy. The empty regions of the SharedFS allocator compress to almost nothing, so a 32 MB filesystem with a few MB of real content typically ships as a 1-3 MB download.

There are two consumption patterns for VFS images, depending on whether the demo wants the kernel worker to fully own the filesystem:

**Kernel-owned VFS (`kernelOwnedFs: true` + `kernel.boot()`).** The main thread never instantiates the `MemoryFileSystem`. Instead, the demo fetches the `.vfs.zst` bytes and hands them to `BrowserKernel.boot({ kernelWasm, vfsImage, argv, env })`. The kernel worker restores the filesystem internally (auto-detecting zstd magic), exec()s `argv[0]` as the first user process, and the main thread becomes a thin client — only routing stdin/stdout, network backend messages, framebuffer events, and HTTP-bridge messages. Service-supervised demos run dinit (`/sbin/dinit --container`) as that service supervisor; dinit reads `/etc/dinit.d/*` from the image and brings up the service tree. Single-program demos (python, perl, php, ruby) exec the language interpreter directly. This is the path new demos should use.

**Legacy main-thread-owned VFS (`memfs:` constructor option + `kernel.spawn()`).** The main thread restores the image into its own `MemoryFileSystem`, hands the SAB to a fresh `BrowserKernel`, and then calls `kernel.spawn(programBytes, argv)` to launch transient binaries. Useful for demos that fetch additional binaries at runtime (test runners, REPLs that load arbitrary code), but the main thread is in the syscall hot path for FS operations. Still used by `benchmark`, `erlang`, and `shell`.

| Demo | VFS Image | Build Script | Boot pattern |
|------|-----------|-------------|--------------|
| Python (legacy opt-in) | `python-vfs.vfs.zst` | `packages/registry/python-vfs/build-python-vfs.sh` | `kernel.boot` → `python3` |
| Perl | `perl.vfs.zst` | `build-perl-vfs-image.sh` | `kernel.boot` → `perl` |
| PHP | `php.vfs.zst` | `build-php-vfs-image.sh` | `kernel.boot` → `php` |
| Ruby | `ruby.vfs.zst` | `build-ruby-vfs-image.sh` | `kernel.boot` → `ruby` |
| nginx | `nginx-vfs.vfs.zst` | `build-nginx-vfs-image.sh` | `kernel.boot` → dinit → nginx |
| nginx-php | `nginx-php-vfs.vfs.zst` | `build-nginx-php-vfs-image.sh` | `kernel.boot` → dinit → php-fpm + nginx |
| Redis | `redis.vfs.zst` | `build-redis-vfs-image.sh` | `kernel.boot` → dinit → redis-server |
| MariaDB | `mariadb.vfs.zst` | `build-mariadb-vfs-image.sh` | `kernel.boot` → dinit → mariadb-bootstrap → mariadbd |
| WordPress | `wordpress.vfs.zst` | `build-wp-vfs-image.sh` | `kernel.boot` → dinit → php-fpm + nginx (SQLite WP) |
| LAMP | `lamp.vfs.zst` | `build-lamp-vfs-image.sh` | `kernel.boot` → dinit → mariadb + php-fpm + nginx |
| MariaDB test | `mariadb-test.vfs.zst` | `build-mariadb-test-vfs-image.sh` | `kernel.boot` → dinit → mariadb; mysqltest via `kernel.spawn` |
| Erlang (legacy opt-in) | `erlang-vfs.vfs.zst` | `packages/registry/erlang-vfs/build-erlang-vfs.sh` | legacy `kernel.spawn` → BEAM |
| Shell | `shell.vfs.zst` | resolver-owned `packages/registry/shell/build-shell.sh` from the reviewed package closure | `kernel.spawnFromVfs` → image-owned Bash |
| Benchmark | (multiple) | (per-suite) | legacy `kernel.spawn` |

Build scripts are in `images/vfs/scripts/` and share common helpers (`vfs-image-helpers.ts` for VFS write primitives, `dinit-image-helpers.ts` for the dinit binary + standard rootfs files + service-file rendering). To build all VFS images, use the per-demo scripts above or the convenience targets in `run.sh` (e.g., `./run.sh build python-vfs`). The repaired Python and Erlang recipes remain disabled legacy compatibility paths: staging does not publish them.

The Node counterparts for the service-supervised demos consume these same
images. They authenticate imported lazy-tree seals, apply transient runtime
configuration to a private restored image, give the resulting root filesystem
to `NodeKernelHost`, and start `/sbin/dinit` with `spawnFromVfs()`. They do not
reconstruct the browser service graph by launching loose package binaries from
the host filesystem.

**Binary format:**

`MemoryFileSystem.saveImage()` returns the raw VFS image below. The image
builder helper wraps it in one zstd frame for `.vfs.zst` artifacts;
The low-level `MemoryFileSystem.fromImage()` parser accepts either form and
auto-detects the zstd magic (`28 B5 2F FD`) at offset 0. Imported consumers use
`restoreVerifiedVfsImage()` (or its capacity-preserving peer) so parsing is
followed by cryptographic authentication before the filesystem is published.

Runtime snapshots preserve the filesystem's POSIX atime, mtime, and ctime by
default. Reproducible image builders may request a fixed timestamp in the
detached snapshot copy without mutating the live filesystem. `mkrootfs build`
uses this facility for every allocated inode, taking whole Unix seconds from
`SOURCE_DATE_EPOCH` and defaulting to epoch zero when it is unset.

Decompressed layout:

```
Offset   Size   Field
0        4      Magic: 0x56465349 ("VFSI")
4        4      Version: 1
8        4      Flags: bit 0 = lazy files, bit 1 = lazy archives, bit 2 = metadata
12       4      SharedArrayBuffer data length (N)
16       N      Raw SharedArrayBuffer bytes (block filesystem)
16+N     4      Lazy entries JSON length (M)
20+N     M      Lazy-file JSON (identity, aliases, URL, declared size)
...      4+L    Optional lazy-archive/deferred-tree JSON length and bytes (when bit 1 is set)
...      4+P    Optional image-metadata JSON length and bytes (when bit 2 is set)
```

## Networking

User-visible networking is POSIX-first. Guest programs call normal AF_UNIX, AF_INET, and partial AF_INET6 socket syscalls (`socket`, `bind`, `connect`, `listen`, `accept`, `send`, `recv`, `sendto`, `recvfrom`, `poll`, and `select`). The Rust kernel owns the socket file descriptors, datagram queues, stream listener state, loopback routing, and errno behavior. Host transports plug in below that layer through `NetworkIO`; they are backends, not the userspace-visible abstraction.

AF_INET and AF_INET6 receive queues are currently bounded at 128 datagrams per
socket. Once that fixed internal queue is full, a newly arriving UDP datagram
is dropped and the already-queued datagrams retain their order. `SO_RCVBUF`
requests are stored but do not size this queue; `getsockopt` continues to report
the fixed default capacity. AF_UNIX datagrams use the same bounded storage but
are reliable: a full receive queue makes the send enter the host's blocking
retry path, or returns `EAGAIN` immediately for an `O_NONBLOCK` or
`MSG_DONTWAIT` send, without discarding queued messages. Queue-capacity,
association, shutdown, close, and pathname changes wake blocked writers and
writable readiness waiters so they can observe either capacity or the new
immediate error.

IPv4 limited broadcast (`255.255.255.255`) is permission-gated: a datagram
send without `SO_BROADCAST` fails with `EACCES`. Kandelo does not provide raw
broadcast delivery, so enabling the option only passes that gate; the send then
reaches the active routing/backend boundary. Directed broadcast addresses are
not modeled.

For AF_INET, AF_INET6, and AF_UNIX datagrams, Linux's input `MSG_TRUNC`
extension reports the original datagram length while copying no more than the
supplied buffer. Without `MSG_PEEK`, the datagram is consumed and any uncopied
suffix is discarded; with `MSG_PEEK`, it remains queued. This receive-side
truncation does not weaken AF_UNIX send reliability or its full-queue
backpressure contract above. `recvmsg()` independently reports output
`MSG_TRUNC` whenever the datagram was longer than the supplied payload
capacity; the input flag controls only whether its return value is the copied
prefix length or the full datagram length. `MSG_CMSG_CLOEXEC` installs every
received descriptor with `FD_CLOEXEC`, and that reflected flag is published
atomically with the returned control data.

Loopback addresses are scoped to one Kandelo machine, but not every socket path is machine-wide yet. IPv4 and IPv6 loopback TCP and AF_UNIX streams have explicit cross-process paths. Current in-kernel IPv4/IPv6 loopback datagrams, AF_UNIX datagrams, and IPv4 multicast delivery are confined to the sending process. Forked sockets retain their kernel-local bind reservations and local lookup targets, but host-backed UDP endpoint registrations are not yet shared or transferred between processes. AF_INET6 represents `sockaddr_in6`, supports `::`/`::1`, and models dual-stack wildcard stream-port reservation, but it has no external or virtual-network IPv6 transport and no IPv6 multicast delivery. AF_INET6 datagrams therefore report `IPV6_V6ONLY=1`; disabling it fails until dual-stack datagram routing exists.

Routed virtual IPv4 addresses are explicit backend addresses. For example, the browser network lab attaches separate machines to addresses such as `10.88.0.2`, `10.88.0.3`, and `10.88.0.4`; traffic to `127.0.0.1` stays inside one machine, while traffic to those virtual addresses can cross machines through the backend.

### Local Virtual Network

`LocalVirtualNetwork` (`host/src/networking/virtual-network.ts`) is an in-memory `NetworkIO` backend for multiple Kandelo machines in the same JS session. Each machine receives a `VirtualNetworkBackend` with a stable virtual IPv4 address and optional hostnames. The backend delivers UDP datagrams as bounded message queues and creates paired TCP streams for accepted connections. When a machine detaches, its listeners and endpoints are removed. Direct virtual endpoints observe an explicit connection reset; an accepted pipe-bridged endpoint currently maps that reset to EOF/EPIPE because the pipe ABI has no pending-socket-error channel.

Normal TCP close is distinct from that abort path. Bytes queued by the closing endpoint drain before its FIN, and the peer drains those bytes before `recv` reports EOF. The in-kernel loopback and local virtual transports retain an orphaned receive sink that discards later peer sends until the peer closes its own write half; they do not invent a fixed number of successful writes after FIN. The Node backend uses `net.Socket` half-open state and `destroySoon()` so the operating system determines later reset timing after queued bytes and FIN. Explicit receive shutdown remains a refusal path. Enabled `SO_LINGER` is rejected until reset and timed-close modes can be carried coherently through every transport.

This backend is used by `apps/browser-demos/pages/network/`, which boots multiple local machines and verifies UDP datagram delivery with `nc -u`, TCP stream delivery with `nc`, and HTTP over virtual TCP with `curl`.

### Node.js

`TcpNetworkBackend` uses Node.js `net.Socket` for external raw TCP. DNS uses `dns.lookup`. Node can therefore provide real socket-level TCP behavior for destinations outside the Kandelo process.

### Browser

Browsers cannot create external raw TCP or UDP sockets. Local loopback and `LocalVirtualNetwork` sockets work because they are virtual sockets behind the POSIX layer. External browser networking currently uses HTTP-oriented backends:

1. **FetchNetworkBackend**: Buffers an entire HTTP request from the Wasm process, sends it via `fetch()`, and returns the raw HTTP response bytes. Works for simple HTTP clients.

2. **TlsNetworkBackend**: Terminates the guest's TLS connection with a generated, in-VFS CA and sends the decoded HTTP request through browser `fetch()`. Service-worker-controlled apps may proxy cross-origin fetches transparently. Other embedders set `BrowserKernelOptions.corsProxyUrl`; the option crosses the main-thread/worker protocol and routes backend fetches through the application's CORS proxy.

   The browser bridge deliberately declines TLS 1.2 session resumption.
   TLS 1.3-capable clients can send a nonempty legacy session ID even without
   an existing Kandelo session. Echoing it after selecting TLS 1.2 would
   falsely claim that the bridge found and resumed a cached session. The
   bridge retains no such master secrets or bounded session cache, so every
   guest connection completes a fresh local handshake. That handshake adds
   no network round trip. Browser `fetch()` owns the separate upstream TLS
   connection and may reuse it independently. Node's direct TCP backend is
   unaffected.

3. **Service Worker HTTP Bridge**: For server demos (nginx, WordPress), a service worker intercepts browser `fetch()` requests to a configurable URL prefix (e.g., `/app/`) and forwards them to the kernel via a MessagePort connection pump. The kernel injects the request as a TCP connection to nginx's listening socket, and nginx's response flows back through the pipe to the service worker.

`TcpNetworkBackend`, `FetchNetworkBackend`, `TlsNetworkBackend`, and `LocalVirtualNetwork` share one numeric-address and hostname validator. It accepts decimal one-, two-, three-, and four-component IPv4 forms within their component widths, rejects malformed or overflowing numeric forms, enforces ASCII host-label syntax and DNS length limits, and preserves one trailing root dot. The Node TCP backend resolves validated names through the host resolver. The browser HTTP fetch/TLS bridges synthesize IPv4 mappings for syntactically acceptable DNS names; `LocalVirtualNetwork` resolves only aliases registered by attached machines. None of the browser paths adds browser DNS resolution or AF_INET6 transport.

WebRTC or proxy-based external transports should attach as additional `NetworkIO` backends behind the same POSIX socket layer rather than adding host-specific socket APIs visible to guest programs.

## Framebuffer (`/dev/fb0`)

The kernel exposes a Linux fbdev surface so unmodified fbdev software (fbDOOM, mplayer-fbdev, etc.) runs without source-level changes.

```
   user process                       kernel                            host
   ─────────────────                  ───────────────                   ────────────
   open("/dev/fb0")     ─────────►   match_virtual_device              (no host call)
                                     CAS FB0_OWNER (single-open)
   ioctl(FBIOGET_*)     ─────────►   fill fb_var_screeninfo /          (no host call)
                                     fb_fix_screeninfo, 640×400 BGRA32
   mmap(fd, len)        ─────────►   memory.mmap_anonymous(len)
                                     record FbBinding(addr,len,w,h)
                                     host.bind_framebuffer(...)  ───►  registry.bind(pid,...)
   *(uint32_t*)px = ... (writes pixels into process Memory SAB —
                         host sees them through the same SAB)
   ioctl(FBIOPAN_DISPLAY) ───────►   no-op success                     (no-op)
```

The pixel buffer lives **inside the process's wasm `Memory`** — a `SharedArrayBuffer`. The host (browser canvas, Node test, etc.) is told `(pid, addr, len, w, h, stride, fmt)` via the `bind_framebuffer` HostIO callback; it builds a typed-array view directly over that range. There is no separate framebuffer SAB, no per-frame syscall, no copy. The host drives presentation via `requestAnimationFrame`.

Cleanup paths (`munmap`, last `close` once unmapped, process exit, `exec`) clear
the binding and call `unbind_framebuffer(pid)`. In the browser, every
framebuffer message carries the process execution generation. Exit and exec
wait for `BrowserKernel` to acknowledge removal of its generation-specific
`WebAssembly.Memory` wrapper and framebuffer-registry typed-array views; a
delayed message from the old image cannot unbind or replace the successor
image's surface. This acknowledgement does not claim that arbitrary consumers
have released a wrapper previously returned by `getProcessMemory()`.

This generation fence makes the current process-memory-backed fbdev path safe
to retire, but it intentionally does not make the process's raw
`WebAssembly.Memory` the long-term graphics ownership model. A follow-up should
move scanout storage to a device/CRTC-owned, dynamically sized bounded shared
surface with per-handle access rights and serialized presentation. That is the
appropriate foundation for multiple writers and compositor ownership without
keeping process address-space wrappers in the presentation realm. `fork` does
not auto-bind the child (one mapping per process; documented limitation).

ABI version bumped 5 → 6 to capture the new `repr(C)` structs `FbBitfield`, `FbVarScreenInfo`, `FbFixScreenInfo`. See `crates/shared/src/lib.rs::fbdev` and `abi/snapshot.json`.

## Mouse input (`/dev/input/mice`)

The kernel exposes a Linux `mousedev` PS/2 surface so unmodified fbdev software (fbDOOM, etc.) gets mouse input from the browser canvas. Direction is reversed vs. fbdev: events flow **host → kernel → process**.

```
   browser main thread                kernel-worker / kernel              user process
   ─────────────────────              ──────────────────────             ─────────────────
   canvas mousemove   ────►  postMessage("mouse_inject")
                             kernel_inject_mouse_event(dx,dy,btn)
                                                   ─────►  mouse::inject_event
                                                           encode 3-byte PS/2 frame
                                                           push to global VecDeque (4096 cap)
                                                                                   ◄────  open("/dev/input/mice", O_RDONLY|O_NONBLOCK)
                                                                                          single-owner via MICE_OWNER (second open from another pid → EBUSY)
                                                                                   ◄────  read(fd, pkt, 3)
                                                           drain bytes from queue
                                                                                   ─────►  decode + apply (e.g. ev_mouse for fbDOOM)
```

The kernel buffers raw 3-byte packets — there is no userspace queue until the process allocates one and tells us about it, and a kernel-side queue lets `read()` complete synchronously without a host round-trip. The buffer is bounded at 4096 packets with whole-packet drop on overflow (≈10s at 400Hz). `poll()` returns `POLLIN` only when bytes are queued; `O_NONBLOCK` reads return `EAGAIN` when empty.

Single-open semantics match real Linux mousedev exclusive-grab. The host inverts browser `deltaY` (browser positive-down → PS/2 positive-up) before injecting, so the kernel queue holds canonical PS/2 sign convention. ABI version bumped 6 → 7 to register the new `kernel_inject_mouse_event(i32, i32, u32) -> ()` export.

## Audio output (`/dev/dsp`)

Kandelo separates the Unix compatibility API from its physical audio
transport. OSS is the first frontend; the state below it is an
implementation-neutral, playback-only PCM stream rather than an ALSA or Web
Audio model.

```text
 SDL2 / SDL3 / Unix application
       open, ioctl, write, poll
                 |
          OSS /dev/dsp frontend
                 |
        Kandelo PCM stream core
   format + geometry + monotonic cursors
                 |
       shared bounded PCM transport
          /                    \
 Browser AudioWorklet      Node clocked sink
```

The PCM core owns requested and actual format, sample rate and channel count;
fragment geometry; 64-bit monotonic producer, consumer, and discard positions;
started, stopped, and draining state; reset generation; underrun count; and
write/drain waiters. The OSS frontend translates fixed-width `soundcard.h`
arguments into that model. No Web Audio concept appears in the guest ABI.
Configuration fields are published under a configuring flag and become visible
as one generation. Finishing a drain also advances the generation, so host
resamplers reset their phase before the next logical playback stream.

There is one physical/default playback device and, initially, one exclusive
stream. Ownership belongs to the open file description (OFD): `dup()` and
descriptors inherited through `fork()` share the stream, while a distinct
`open()` returns `EBUSY`. A surviving non-`CLOEXEC` descriptor keeps the same
stream across `exec`. There is no kernel mixer, routing policy, capture stream,
or concatenation of data from unrelated writers.

The transport reserves one 64 KiB PCM ring plus a 128-byte fixed-width control
header in the kernel's shared Wasm memory: 65,664 bytes total. The active queue is latency-sized:
four 1024-byte fragments (4096 bytes) by default, and `SETFRAGMENT` may select
another geometry up to the 64 KiB physical bound. At the default 48 kHz,
stereo S16 configuration, 4096 bytes are about 21.3 ms of queued audio. The
host receives a descriptor for this same memory; it does not allocate a second
persistent PCM ring. Browser-engine Float32 render buffers are transient.

Writes form one continuous byte stream and never discard previously queued
audio. Bytes from an incomplete PCM frame remain queued across later writes.
`SYNC` or final OFD close pads only a terminal incomplete frame with format
silence (`0x80` for U8 and zero for S16_LE/S16_BE) before draining; `POST` does
not fabricate padding. A frame-aligned blocking request no larger than the
active capacity waits until the entire request can be accepted, which covers
normal SDL periods. If an earlier unaligned write has left the ring ending in
an incomplete frame, a later blocking write may return the prefix that
completes that frame rather than deadlocking behind bytes the audio clock
cannot yet consume. Larger requests and nonblocking requests may likewise
report partial progress; a nonblocking write with no capacity returns
`EAGAIN`.
`poll(POLLOUT)` becomes ready only when at least one fragment is free. When the
host audio clock advances the consumer position, the kernel reconciles the
monotonic cursors and wakes writers, poll waiters, and drain waiters. Running
out of queued frames is an underrun and produces silence; it does not move the
producer or overwrite old frames.

An explicit final `close()` drains to the audio clock before releasing the
exclusive device. `SNDCTL_DSP_RESET` is the explicit discard operation for an
application that does not want to drain. Exit, `CLOEXEC`, and forced teardown
cannot keep a syscall alive, so a queued tail becomes an orphan drain: the
device remains exclusive until the host consumes that tail, then releases
automatically. This prevents a final buffer from being truncated or joined to
the next opener's stream. Caught signals interrupt a blocked write, `SYNC`, or
explicit final close through the ordinary `EINTR` path. `SA_RESTART` restarts
write and `SYNC`; an interrupted close leaves the descriptor valid for an
explicit caller retry.

In browsers an `AudioWorkletProcessor` consumes and converts PCM in render
quanta (normally 128 output frames), advances the shared consumer cursor, and
emits silence on underrun. The main thread only creates/resumes the
`AudioContext` and connects the node; it is not the audio clock and does not
drain through a timer. At 48 kHz one render quantum is about 2.7 ms; browser
device `baseLatency`/`outputLatency` is additional and platform-dependent.
After machine teardown drains the shared ring, a running browser context is
suspended to hand already-rendered blocks to the output device, then retained
for a bounded base/output-latency-plus-quantum settlement interval before it is
closed. Teardown never resumes a suspended or interrupted context, preserving
the browser's user-activation boundary.
Node uses the same cursor and wakeup contract with a wall-clock-paced null sink
for headless execution, so callbacks cannot run at CPU speed. Its running tick
follows the negotiated fragment duration, preserves fractional-frame drift,
and falls back to 10 ms polling while idle.

A permanent sink failure is distinct from recoverable browser suspension. The
host latches a shared fatal flag and wakes the kernel: writes and drains fail
with `EIO`, polling reports `POLLERR`, and final close discards the unplayable
tail, releases ownership, and returns `EIO`. If the failure arrives after an
implicit close has orphaned a tail, reconciliation discards that unplayable
tail and releases ownership; no descriptor remains to receive `EIO`. A
suspended or interrupted `AudioContext` does not set that flag; it stops the
consumer clock and applies normal queue backpressure until resume.

The AudioWorklet/shared-ring transport builds on the exploration in PR #698,
while deliberately omitting that experiment's ALSA state machine and
`/dev/snd` ABI. OSS command details are documented in
[POSIX status](posix-status.md#oss-playback-compatibility).

### Measured PCM footprint

The following historical measurements were recorded for the original PR #947
implementation. They compare its clean starting commit
`92d5940f7e0107514ea12ab813d395257678377e` with that branch's ABI 40 result.
They establish the footprint of the audio architecture in that source branch;
they are not a current ABI 43 artifact-size claim. The ABI 43 integration must
be remeasured after its package artifacts are finalized. Compressed sizes use
`zstd -19`; JavaScript totals cover the same ten existing ESM entry files on
both sides, with the new worklet shown separately.

| Artifact | Before raw / compressed | After raw / compressed | Delta |
|---|---:|---:|---:|
| Kernel Wasm | 532,311 / 143,233 B | 612,569 / 147,554 B | +80,258 / +4,321 B |
| Host ESM entries | 3,711,675 / 634,586 B | 3,771,682 / 644,709 B | +60,007 / +10,123 B |
| PCM AudioWorklet | absent | 8,863 / 2,462 B | new |
| `audiotest.wasm` | 30,180 / 13,092 B | 30,365 / 13,183 B | +185 / +91 B |
| `dsp_signal_test.wasm` | absent | 32,355 / 13,890 B | new |

The upstream integration artifacts measure as follows:

| Artifact | Raw / compressed (`zstd -19`) |
|---|---:|
| SDL2 2.32.10 `libSDL2.a` | 1,192,694 / 322,705 B |
| SDL3 3.4.10 `libSDL3.a` | 1,970,446 / 513,937 B |
| SDL2 DSP fixture Wasm | 1,573,606 / 391,329 B |
| SDL3 DSP fixture Wasm | 2,470,559 / 521,937 B |
| SDL_mixer 2.8.2 `playwave` Wasm | 1,800,045 / 434,029 B |

The installed regular-file totals are 3,864,113 bytes for the SDL2 package,
5,545,678 bytes for SDL3, and approximately 4.04 MB for the combined fixture
package. Deterministically staged package archives measured approximately
0.66 MB, 0.95 MB, and 0.70 MB respectively after `zstd -19`; exact published
archives vary slightly with provenance strings. The test-only `playwave`
package contains one 1,800,045-byte regular file; its compressed size is the
434,029-byte value above.

Steady-state transport memory is the fixed 65,664-byte allocation described
above, versus a growable old queue whose maximum occupancy was 262,144 PCM
bytes. The default active queue is 21.333 ms. A normal 128-frame browser
quantum adds 2.667 ms at 48 kHz, for 24 ms of configured software buffering
before platform-specific `baseLatency` and `outputLatency`. Node advances in
the default 256-frame (5.333 ms) fragment cadence against the same 21.333 ms
bounded queue. These are footprint and configured-buffer measurements, not a
throughput or performance claim.

## Signal Subsystem

Signals are delivered at syscall boundaries. When a process has a pending signal:

1. `kernel_handle_channel` checks for pending signals after each syscall
2. If a signal handler is registered (SA_SIGINFO), the kernel writes signal info to the channel's data buffer
3. The glue reads the signal info and calls the handler on the process's stack
   (or alternate signal stack if SA_ONSTACK). For a ppoll/pselect replacement
   mask, handler setup starts from that current replacement mask, then adds
   sa_mask and the delivered signal.
4. After the handler returns, the glue calls `SYS_RT_SIGRETURN` for
   handler-frame state and applies the signal record's exact old mask with
   `SYS_SIGPROCMASK`. For ppoll/pselect, the record contains the mask current
   at delivery while Rust retains a per-TID LIFO wait context. A restarted
   ppoll therefore preserves its replacement mask through resubmission;
   terminal completion or exact post-handler cancellation restores the
   pre-wait mask once. Nested ppoll, pselect, sigsuspend, and pause calls own
   separate contexts. `sigsuspend` and `pause` use that same exact
   post-handler cancellation to restore their pre-wait mask before returning
   `EINTR`. `longjmp` and `siglongjmp` retire abandoned handler/wait contexts;
   `siglongjmp` then applies the jump buffer's saved mask when requested.
5. If the signal interrupted a blocking syscall, EINTR is returned

The host distinguishes the kernel's internal `EAGAIN` retry sentinel from a
completed nonblocking `EAGAIN`. When a caught signal is prepared while an
internal retry is still blocked, the host publishes `EINTR` without discarding
the prepared `CH_SIG` record. Libc runs the handler before deciding whether
`SA_RESTART` permits resubmitting that syscall.

Features: RT signal queuing with `si_value`, cross-process `kill`/`killpg`, `sigaltstack` with shadow stack swap, `sigsuspend`, `sigtimedwait`, `setitimer`/`alarm` via host timers.

The exception is a channel request whose completion is owned by
process-worker JavaScript. Its ABI 43 request flag tells the kernel not to
dequeue a caught signal into a record that JavaScript cannot consume. The
signal remains pending until libc makes the explicit ordinary-channel
checkpoint after `fork`, `clone`, or a staged-loader import. Handler invocation
and `rt_sigreturn` therefore still occur on the guest side after the host
import has returned.

Exact-thread delivery never degrades into process-wide delivery. `tkill` and
`tgkill` resolve their target against retained live task records in the calling
process; TID 0 and unknown or exited TIDs return `ESRCH`. Cross-process
exact-thread delivery is not yet supported.

POSIX timer scheduling is split at an explicit ownership boundary. The shared
Node/browser host owns wall-clock `setTimeout`/`setInterval` scheduling, while
the kernel owns the timer object, notification-pending state, exact
`SIGEV_THREAD_ID` target, `SI_TIMER` metadata, overrun accounting, and queued
signal lifetime. At each expiration the host calls the ABI-required
`kernel_posix_timer_fire` export and wakes only the thread selected by the
kernel (or the eligible process-wide waiters for `SIGEV_SIGNAL`). The host does
not synthesize timer signals or fall back to a process-wide notification.

Musl implements POSIX `SIGEV_THREAD` with a detached helper pthread and an
exact-thread kernel notification. The helper retains the callback and native
`union sigval` locally. Other timer notifications stage the complete generated
caller-native 64-byte `sigevent`; the process pointer width selects the union
width, and Rust retains its raw bits in a `u64`. The fixed channel delivery
record also carries eight raw value bytes. A wasm64 recipient therefore
receives the complete `sival_ptr`; a wasm32 recipient receives the
target-native low 32 bits. The glue reconstructs the recipient's native union
with `memcpy` so it does not select the wrong union member.

POSIX message-queue notification uses the same Rust-owned signal metadata.
Registration accepts a `SIGEV_SIGNAL` notification only when
`1 <= signo < NSIG`; the first message sent to an empty queue queues one
`SI_MESGQ` record with the registering process's complete `union sigval` and
authoritative sender credentials. The small host drain record is only a wake
instruction—the host does not synthesize a second signal or replace the queued
metadata.

Normal exit status and signal termination are stored separately. `_exit()` and
`exit_group()` retain the low eight status bits, including values 128 through
255; a default terminating signal records its signal number independently.
`waitpid()` therefore emits the POSIX wait encoding without guessing that a
high normal exit code was a signal, while host lifecycle callbacks may still
present the conventional shell-style `128 + signal` value.

Child status is a Rust-owned, per-process record covering stop, continue, and
termination. POSIX replacement semantics apply: a new transition replaces
older unconsumed status, ordinary waits consume it, and `waitid(WNOWAIT)` only
peeks. Stopped and continued reports never reap; consuming termination status
does. The host validates every guest output range before asking the kernel to
consume a record, so an `EFAULT` cannot lose child status or reap a zombie.

Default stop actions park execution cooperatively at the syscall boundary. The
kernel emits a process-transition event, and the shared Node/browser host holds
prepared completions by exact channel identity, including every pthread
channel, until SIGCONT. SIGCONT changes state immediately even when blocked,
ignored, or caught; SIGKILL can terminate a stopped process. Current Wasm
workers do not provide arbitrary-instruction preemption, so CPU-bound code that
never reaches a syscall cannot be suspended immediately; that boundary is
documented in `posix-status.md` rather than hidden behind host-specific behavior.

## Browser-Specific Architecture

In the browser, an additional layer wraps the kernel:

```
Main Thread                              Kernel Worker
├── BrowserKernel (thin proxy)           ├── CentralizedKernelWorker
├── UI code (HTML/JS)                    ├── MemoryFileSystem (kernel-owned)
├── App clients (MySQL, Redis)           ├── Kernel Wasm instance
├── HTTP bridge / TCP injection          ├── Process sub-workers
├── Local virtual network                ├── POSIX socket routing
└── PTY terminal (xterm.js)              └── Connection pump, blocking retries
```

**`BrowserKernel`** (`host/src/browser-kernel-host.ts`): Main-thread proxy that communicates with the browser kernel worker via `postMessage`. This is host/runtime code, maintained beside the Node.js host (`host/src/node-kernel-host.ts`). Browser apps and demos consume it; they do not own it. The current API has two boot paths:

- `kernel.boot({ kernelWasm, vfsImage, argv, env, ... })` — preferred. Combined with `kernelOwnedFs: true`, the main thread never holds a `MemoryFileSystem` reference. The kernel worker restores the image and exec()s `argv[0]` as the first user process. All FS operations stay inside the worker, off the syscall hot path.
- `kernel.spawn(programBytes, argv, opts)` — legacy. Posts the wasm bytes to the kernel worker; the Rust `ProcessTable` allocates the PID, then the worker attaches host state, starts the process worker, and returns the assigned PID. Kept for transient binary launches (REPLs, test runners, benchmarks) that the kernel can't currently load via fork+exec from a baked binary.

The remaining methods (`pipeRead`/`pipeWrite`, `injectConnection`, stdin/PTY routing, framebuffer registry mirroring, HTTP bridge handoff) are pid-addressed and work the same in both boot paths.

**Browser kernel worker** (`host/src/browser-kernel-worker-entry.ts`): Dedicated web worker that hosts `CentralizedKernelWorker`, following the standard architecture requirement. Process workers are sub-workers created by the kernel worker. Syscall notification remains event-driven through `Atomics.waitAsync`, not channel polling. The browser config uses batch size 1 so every relisten and already-`PENDING` dispatch is deferred through the MessageChannel-backed `setImmediate` queue; this keeps syscall handling and worker messages progressing together under multi-process bridge load. Node.js retains its native/default batching unchanged.

**dinit service supervisor** (`packages/registry/dinit/`): Service-supervised demos boot dinit v0.19.4 (cross-compiled to wasm32) as the first user process via `kernel.boot({ argv: ["/sbin/dinit", "--container", ...] })`. It receives the first kernel-allocated user PID (100); PID 1 remains the kernel's synthetic init reservation. The service tree is baked into `/etc/dinit.d/*` at image-build time via `addDinitInit()` in `dinit-image-helpers.ts`. Service types in use: `process` (long-running daemons), `scripted` (one-shot bootstraps that exit cleanly), and `internal` (dependency-only nodes used to express "boot the whole tree" or "pick this engine"). dinit reaps its directly supervised children, leaves reparented-orphan reaping unsupported because synthetic PID 1 has no wait loop, disables restarts by default, and enforces inter-service `depends-on` ordering.

**Service Worker** (`apps/browser-demos/public/service-worker.js`): Dual-mode file that acts as both a page bootstrap script (registers itself, enables cross-origin isolation) and a service worker (adds COOP/COEP headers, handles HTTP bridge routing).

### Linux-compatible graphics devices

Kandelo exposes a small Linux-shaped graphics stack through virtual character
devices:

- `/dev/dri/renderD128` accepts the render-node subset used by `libdrm`,
  `libgbm`, EGL, and GLES userspace shims.
- `/dev/dri/card0` adds the KMS subset used for one virtual connector, encoder,
  CRTC, dumb buffers, framebuffer objects, `SET_MASTER`, `SET_CRTC`, and
  `PAGE_FLIP` events.
- `/dev/fb0` remains the simpler framebuffer path for software that writes a
  linear BGRA buffer directly.

The kernel owns the device ABI, fd-local GEM handles, DRM-master ownership,
KMS framebuffer refcounts, BO mmap authorization, and process lifecycle
cleanup. User programs cannot mmap an arbitrary BO id: the mmap offset must
come from `DRM_IOCTL_MODE_MAP_DUMB` on the same open file description. On
`munmap`, `exec`, `exit`, or final fd close, the kernel unbinds BO and GL
memory from the host before those Wasm memory ranges can be reused.

Pixel and GL execution are host responsibilities. The TypeScript host keeps
GBM BO metadata/SAB snapshots, KMS scanout state, and WebGL contexts. GLIO
command buffers live in the user process's Wasm memory; `libGLESv2.a` appends
TLV commands, the kernel validates the submitted range, and the host decodes
the commands against a browser `WebGL2RenderingContext` or a test double in
Node.js. The kernel does not contain GL rendering code.

The user-space libraries are sysroot libraries, not kernel build outputs:
`scripts/build-musl.sh` installs the headers and builds `sysroot/lib/libdrm.a`,
`libgbm.a`, `libEGL.a`, and `libGLESv2.a`, plus matching pkg-config files.
Packages that depend on these APIs link through `wasm32posix-pkg-config` and
declare their resulting program artifacts as packages. The `modeset` demo is
one such package: its VFS image installs `/usr/local/bin/modeset`, and
`/etc/kandelo/demo.json` selects the KMS surface and `autoCommand` that starts
it. The browser loader stays generic; it does not special-case `modeset.wasm`.

## Performance Architecture

### The dedicated worker thread is the optimization

The single most impactful performance decision is running the kernel in a dedicated worker thread (`NodeKernelHost` on Node.js, `BrowserKernel` on browsers). Benchmarked gains from the worker thread architecture vs. running the kernel on the main thread:

| Metric | Main thread | Worker thread | Change |
|--------|------------|---------------|--------|
| pipe_mbps | 10.9 | 24.1 | **+121%** |
| clone_ms | 94.1 | 36.7 | **-61%** |
| fork_ms | 243.8 | 176.9 | **-27%** |
| exec_ms | 186.9 | 171.5 | -8% |
| hello_start_ms | 88.2 | 139.6 | +58% (kernel thread startup cost) |
| file_read_mbps | 236.0 | 188.4 | -20% |

The `hello_start` regression is a fixed one-time cost: spinning up the kernel worker thread (~50ms). For any workload that runs more than a trivial number of syscalls, the dedicated thread wins.

### Do not micro-optimize the syscall hot path

The following "optimizations" in `kernel-worker.ts` were benchmarked and **all made performance worse**:

1. **Syscall argument count tables** (`SYSCALL_ARG_COUNTS`): Reading fewer BigInt args per syscall based on a lookup table. Saved ~nanoseconds per syscall but added branch overhead and a critical correctness risk — if the table uses wrong syscall numbers, args are silently zeroed, breaking networking and other subsystems.

2. **I/O syscall classification** (`IO_SYSCALLS`): Skipping `drainAndProcessWakeupEvents()` for non-I/O syscalls. The drain is cheap when there are no events, and skipping it risks missing wakeups in edge cases.

3. **Cached TypedArray views**: Caching `DataView` and `Int32Array` on channel structs to avoid re-creation. V8 already optimizes `new DataView()` to near-zero cost; the cache adds memory overhead and invalidation complexity for no measurable gain.

4. **Conditional debug ring logging**: Skipping syscall ring buffer entries for 0-arg syscalls. The ring buffer is a fixed-size array push — negligible cost, but valuable for crash diagnostics.

**Why they fail**: The Wasm kernel execution (calling `kernel_handle_channel` which dispatches into Rust-compiled syscall logic) dominates each syscall's wall time. The TypeScript overhead around it — reading 6 args, creating views, draining events, logging — is noise. Micro-optimizing noise adds complexity and risk for no throughput gain.

**What to optimize instead**: If syscall throughput needs improvement, focus on the kernel Wasm code (`crates/kernel/`), the channel protocol, or the worker thread scheduling. The TypeScript host path is not the bottleneck.

## Build System

### Repository Setup

`./run.sh setup` is the single entry point for a working repo, not just
a kernel build. It delegates to xtask's bootstrap step plan
(`tools/xtask/src/local_build.rs::bootstrap_step_plan`), which runs, in
order:

1. `fork-instrument-tool` — builds the Wasm fork continuation instrumentation tool
2. `sysroot` — provisions the wasm32 musl sysroot: builds it from source the first time, or just re-syncs overlay headers if it already exists
3. `sysroot64` — provisions the wasm64 musl sysroot the same way
4. `sdk` — verifies the `wasm32posix-cc` toolchain wrappers resolve against `sysroot`
5. `engine` — builds every package in the local-build graph, including the kernel: `cargo build` with `-Z build-std=core,alloc` targeting `wasm32-unknown-unknown`, then copies `kandelo-kernel.wasm` to `host/wasm/`
6. `rootfs` — builds the canonical rootfs image via `scripts/build-rootfs.sh`, which invokes the `mkrootfs` CLI (`tools/mkrootfs/`) against the top-level `MANIFEST` + `images/rootfs/` source tree, stamps the current `ABI_VERSION` into image metadata, and writes `host/wasm/rootfs.vfs`
7. `host-dist` — builds the TypeScript host via `npm run build` (tsup → ESM + CJS)

```bash
./run.sh setup
```

(`bash build.sh` still works as a deprecated delegator to the same command.)

Building the example/test C programs under `programs/*.c` is a separate
step that `./run.sh setup` does not run: use `./run.sh build programs`
(`scripts/build-programs.sh`) when you need them, e.g. for the wasm64
Vitest cases or benchmark suites.

`host/wasm/` is gitignored — `rootfs.vfs`, `kernel.wasm`, and the rest are built artifacts. `tools/mkrootfs/` is the source of the image-builder CLI; the canonical owners/modes/sticky-bits live in `MANIFEST`, the file content under `images/rootfs/`.

Manifest node paths and archive mount points use canonical absolute POSIX
paths. ZIP archives ingested by `mkrootfs` require byte-exact UTF-8 canonical
relative member paths; unsafe aliases or type-conflicting path graphs fail
before VFS mutation. Unix ZIP symlinks retain their validated target payload
and archive-declared ownership, including relative targets with parent
components.

### User Program Compilation

The SDK (`sdk/`) provides `wasm32posix-cc` which wraps clang with:
- `--target=wasm32-unknown-unknown`
- `-matomics -mbulk-memory -mexception-handling` (Wasm features)
- `--sysroot=<path to musl sysroot>`
- Links: `channel_syscall.c` + `compiler_rt.c` + `crt1.o` + `libc.a`
- Linker flags: `--import-memory --shared-memory --max-memory=1073741824`

For programs that use `fork()` or fork-like helpers, the in-tree
`wasm-fork-instrument` tool (see
[fork-instrumentation.md](fork-instrumentation.md)) must be the **last**
post-link pass — after any `wasm-opt -O2`. Build scripts call
`scripts/run-wasm-fork-instrument.sh`, which builds the tool on demand if the
prebuilt `tools/bin/wasm-fork-instrument` is absent. The tool auto-discovers
fork-path functions via call-graph analysis from the `kernel.kernel_fork`
import; no onlylist is needed. Legacy Asyncify artifacts are not supported.

### Package system

Every artifact under `packages/registry/<name>/` is a **package**. Each ships two TOML files:

- **`package.toml`** — the **recipe**: name, version, upstream source pin, license, dependencies, `[build].script_path`. Identity-and-constraints. Project-agnostic; same content across any project that depends on this package.
- **`build.toml`** — the **project view**: `script_path` (this project's actual build), `repo_url` + `commit` (where the recipe lives in this project), `revision` (a cache-key input), declared build `inputs`, and any `[[git_inputs]]`. Differs per project.

Package resolution is **local-first**: every package is source-built through the SDK/libc/resolver and cached locally by content hash. There is no remote prebuilt-binary channel. See `docs/package-management.md` for the reference manual.

**Resolver flow** (`xtask build-deps resolve`, called from build scripts):

1. Read `packages/registry/<name>/package.toml` for the recipe and `packages/registry/<name>/build.toml` for the project view (`revision`, build inputs).
2. Return a hand-patched override under `local-libs/<name>/build/` (libraries) or `local-binaries/programs/<arch>/...` (programs) if present.
3. Otherwise return the canonical content-addressed cache entry `<cache_root>/libs/<name>-<ver>-rev<N>-<arch>-<cache-key-sha>/` if it exists.
4. On a cache miss, **build from source**: fetch the upstream source archive from `[source].url`, verify it against `[source].sha256`, run `build-<name>.sh` via the SDK, validate the declared outputs, and atomically install the result into the canonical cache.

The cache key is computed over the recipe identity, `revision`, source pin, target arch, `ABI_VERSION`, declared outputs, declared build inputs, `[[git_inputs]]`, the global toolchain/sysroot fingerprint, and the transitive dependency cache keys. Any change to those inputs invalidates the entry and triggers a source rebuild of that package and its dependents.

The `[binary]` block that once declared a remote publish/fetch location was removed with the remote binary channel; `validate_source` rejects it in `package.toml` or `build.toml`.

For schema, cache-key hashing, resolver ordering, and the build-script contract see [docs/package-management.md](package-management.md).

## Test Suites

Validation always runs through `scripts/dev-shell.sh`. Kernel, host, ABI,
libc, Open POSIX, Sortix, fork-instrument, and real-browser suites prove
different contracts; there is no fixed short list whose success establishes
every change. Use the CI-shaped commands and change-to-suite matrix in
[`docs/agent-guidance/validation.md`](agent-guidance/validation.md), including
generated-file/snapshot checks for ABI-adjacent work and real Chromium
evidence for shared browser runtime changes. Report exact commands, counts,
unexpected failures, skipped suites, and environmental blocks rather than
using a narrow passing suite as a broad readiness claim.
