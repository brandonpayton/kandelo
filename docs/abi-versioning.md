# ABI versioning

User programs are compiled against the kernel's binary interface. When the
kernel changes that interface in a way that breaks old binaries, running an
old binary against a new kernel would silently corrupt state. To prevent
this, the project maintains:

1. A single integer [`ABI_VERSION`](../crates/shared/src/lib.rs) that every
   compiled binary carries and the kernel exports.
2. A structural snapshot of the ABI surface at
   [`abi/snapshot.json`](../abi/snapshot.json), regenerated from source.
3. A CI check that refuses to let the snapshot drift from source, and
   refuses no-bump snapshot changes unless they are narrowly additive.

**Agents and humans alike: do not change the kernel ABI incompatibly
without bumping `ABI_VERSION`.** The check is structural, not a
convention — CI enforces it.

## ABI staging rollout status

The checked-in ABI staging foundation is local and inert. It defines strict,
canonical data contracts for VFS products, consumer selection, staging
requests and records, guard policy, builder inputs and reports, and legacy
retirement conditions. The miniature fixture exercises those contracts with
ABI values read from fixture data and requires an exact generic `N` to `N + 1`
transition; the reusable implementation contains no concrete ABI number.

The local proof builds from the exact declared PR-head identity, derives
Formula roots from selected VFS products, preserves embedded and lazy
materialization, publishes into isolated content-addressed fixture
namespaces, verifies through an anonymous reader, promotes unchanged layer
bytes, and recomposes the final VFS with canonical references. It also proves
that prior-ABI history must be protected and verified before successor
promotion and that incomplete Pages inventory retains the last complete
local site.

The next checked-in layer derives a request only from an exact same-repository
pull-request head. Its current identity is the complete tuple of head,
requirements digest, request-policy version and digest, and guard-registry
version and digest. A later policy issuance for the same head appends a new
content-addressed request; it does not overwrite or invalidate the earlier
request. Request assets use
`candidate-request-<full-head-sha>-sha256-<request-digest>.json`.

Request publication and tap reconciliation both remain in `observe` mode.
The Kandelo workflow has no Release write while that mode is active. The tap
workflow anonymously validates public GitHub data and reports deterministic
pull-request lifecycle decisions, but cannot dispatch builds or write package,
branch, or Check state. The local cross-repository fixture proves derivation,
append/no-clobber behavior, policy reissuance, pull-request advance, historical
head completion, close, reopen, and merge handling without using the network.

Neither workflow revision has reached protected `main`, and there is no hosted
canary evidence for this layer. It therefore does not currently issue hosted
requests, execute candidate code, publish candidate or canonical artifacts,
update a GitHub Check, create or protect an ABI branch, or deploy Pages. Those
operations require the later staging layers and their hosted evidence.
Existing ABI release and VFS behavior is unchanged.

## What counts as an ABI change

Anything that could make an old compiled binary misbehave against a new
kernel. Specifically, any of the following requires an `ABI_VERSION` bump:

- Removing, renaming, or reassigning a syscall number.
- Changing an existing syscall argument descriptor used by the host for
  pointer marshalling, including direction, size source, multipliers,
  fixed byte lengths, pointer nullability/requiredness, or return-value copy
  adjustments.
- Changing the channel header layout (field offsets or sizes in
  [`crates/shared/src/lib.rs`](../crates/shared/src/lib.rs)
  `channel` module).
- Changing the data-buffer size or the signal-delivery area layout.
- Adding, removing, or reordering fields of a marshalled `repr(C)` struct
  (`WasmStat`, `WasmDirent`, `WasmFlock`, `WasmTimespec`, `WasmPollFd`,
  `WasmStatfs`), or changing a field's type in a way that shifts offsets
  or span.
- Changing the required `wpk_fork_*` export names or the save-buffer /
  frame format emitted by
  [`wasm-fork-instrument`](fork-instrumentation.md) into every
  fork-using user program. The kernel does not read these exports
  directly, but the host runtime in `host/src/worker-main.ts` does —
  a rename here silently breaks fork for every already-built binary.
- Changing the linked musl/glue syscall function types or argument-slot widths,
  including the wasm32 cancellation-point `__syscall_cp` path. These are not
  currently visible in the structural snapshot, but stale objects and archives
  can otherwise link with incompatible Wasm function signatures.
- Adding or changing a required kernel-Wasm host import. Kernel imports are not
  yet present in the structural snapshot, so reviewers must track this surface
  explicitly and coordinate the host implementation in the same ABI epoch.
- Changing the name, version, encoding, or role semantics of the
  `kandelo.wpk_fork.capabilities` custom section. The host uses these claims to
  decide whether a main/side-module pair can safely coordinate fork replay and,
  in ABI 43, whether the artifact satisfies activation-state ownership.
- Renaming the ABI custom section or the process-expected globals.
- Changing the meaning of a syscall argument, errno, or blocking
  behavior without changing its signature. **This is not caught
  structurally — reviewers must flag it and bump anyway.**

The fork-capability section has an explicit ABI transition rule. ABI 16 accepts
an absent section through the pre-existing five-export fallback, while treating
a present marker as authoritative. ABI 17 was intentionally skipped; ABI 18
was the first epoch above 16 and made the role marker mandatory. ABI 43 adds
`FORK_CAP_ACTIVATION_STATE_SAFE` and requires it on every fork-instrumented
main or side module. An ABI 42 artifact does not become ABI 43-compatible by
copying the new capability byte: the embedded ABI version and the capability
contract are validated together.

ABI 26 also makes `kernel_get_process_exit_signal` a required host-adapter
export. The host uses the query unconditionally to distinguish signal death
from ordinary high exit statuses, so a kernel without it must fail manifest
validation rather than silently treating the process as live.

ABI 31 makes `kernel_prepare_write_operation` required. Host-backed writes use
that preflight unconditionally before splitting one guest operation into
scratch-buffer chunks, so a kernel without it must fail manifest validation
rather than bypassing operation-wide file-size enforcement.

ABI 39 makes `kernel_posix_timer_fire` required. The host uses it for every
host-scheduled POSIX timer expiration so the kernel can preserve exact
`SIGEV_THREAD_ID` targets, `SI_TIMER` metadata, overruns, and signal-wait wake
selection. A kernel without it must fail manifest validation rather than fall
back to process-wide delivery.

ABI 40 moves advisory file-lock authority into the Rust kernel. It removes the
required `host_fcntl_lock` import and the public host-package `SharedLockTable`
API, distinguishes lock conflicts (`EAGAIN`) from bounded-manager exhaustion
(`ENOLCK`), and adds exact `FileId` plus machine-wide `OfdId` state to fork/exec
serialization version 12. Kernels, hosts, libc, guest programs, packages, and
VFS images from ABI 39 must be rebuilt rather than mixed with ABI 40 artifacts.

Pure internal refactors (renaming a kernel-side function, reorganizing
a source file, tightening a bound in a non-ABI type) are *not* ABI
changes and do not require a bump.

The following snapshot changes are backward-compatible additions and do
not require an `ABI_VERSION` bump:

- Adding a new named syscall number while leaving every existing syscall
  entry unchanged.
- Adding a new host-intercepted syscall number while leaving every
  existing host-intercepted entry unchanged.
- Adding a new kernel-wasm export while leaving every existing export's
  kind, signature, type, mutability, and tracked value unchanged.
- Adding a new marshalled struct name while leaving every existing
  marshalled struct layout unchanged.
- Adding a syscall argument descriptor for a syscall that previously had
  no descriptor, while leaving every existing descriptor unchanged.
- Adding the initial `host_adapter` snapshot section or adding new
  optional host-adapter metadata while leaving required existing fields
  unchanged.
- Adding a new named VFS metadata category, such as `statfs_flags`, while
  leaving every existing VFS metadata category unchanged.

These additions still require regenerating and committing
`abi/snapshot.json`. They do not permit older kernels to run newer
programs that require the new surface; they only permit older programs
to keep running on newer kernels in the same `ABI_VERSION` epoch.

### ABI 41 fork-continuation reserve

ABI 41 increases each fork-continuation save buffer from 16 KiB to 60 KiB.
The reserve occupies the upper part of an existing 64 KiB scratch page and
leaves a 4 KiB prefix for host-owned control metadata. It covers the measured
49,232-byte Bash continuation with 12,208 bytes of headroom while
retaining truthful post-unwind detection for continuations above the fixed
bound.

The host passes the buffer's absolute address to every instrumented main
module, pthread worker, and fork-capable side module; neither that address nor
the capacity is baked into instrumented code. ABI 39 and 40 programs still need
rebuilding because the public process-memory layout belongs to ABI 41. ABI 41
candidate programs created before publication remain mechanically valid when
only this host-supplied reserve grows and the frame format stays unchanged.

### ABI 42 kernel-owned task identities and scalable fork continuations

ABI 42 makes the Rust `ProcessTable` the sole authority for process and thread
identities. One monotonically increasing positive signed task-ID sequence starts
at 100 and serves top-level process creation, fork, non-forking `posix_spawn`,
and thread-style clone. IDs are not reused after process reaping or thread exit;
allocating `i32::MAX` succeeds, and only the following allocation returns
`EAGAIN`. PID 1 is created separately as the synthetic init reservation and
never names a user Wasm worker.

The kernel implementation enforces that ownership with a linear
`AllocatedTaskId`: only `ProcessTable` can mint one, and production `Process` or
`ThreadInfo` construction consumes it. PID, TID, and thread-membership views are
not mutable outside that path. Caller-selected constructors remain test-only,
and fork deserialization restores non-identity state into an already-authorized
child instead of constructing a PID from serialized or host input. These are
internal Rust invariants rather than additional Wasm exports.

The kernel creation exports now return their assigned identities:
`kernel_create_process()` takes no PID, and
`kernel_create_process_with_stdio(stdin_kind, stdout_kind, stderr_kind)` takes
only stdio kinds. `kernel_fork_process(parent_pid, caller_tid)` takes no child
PID and returns the allocated child. The new
`kernel_spawn_process(parent_pid, caller_tid, blob_ptr, blob_len)` signature
likewise names the already-existing calling task, not a proposed child
identity. The kernel validates that `caller_tid` is the parent's live main task
or one of its live kernel-allocated threads before either operation; an unknown,
stale, or cross-process caller returns `ESRCH`. The caller-selected
`kernel_init(pid)` and `kernel_init_from_fork(..., child_pid)` constructors are
removed. Host `createProcess` asks the kernel for an identity, while
`registerProcess` only attaches memory, channels, and worker metadata to
existing kernel state; no host allocator or task-ID watermark remains.
Thread-style clone likewise validates its bound caller against the owning
process before consuming a task ID. The host adapter manifest and kernel
artifact gates require the create, fork, spawn, exact exec, and thread-exit
exports, so a stale kernel cannot defer a missing authority or lifecycle path
until the first child, exec, or thread exit.

Exec is an exact-caller two-step operation. The required
`kernel_exec_prepare(pid, caller_tid)` export validates the live task and
applies deferred file actions before the irreversible transition. The required
`kernel_exec_setup_for_thread(pid, caller_tid)` export performs the in-place
exec reset while preserving the calling task's mask and directed signal state.
The required `kernel_thread_exit(pid, tid)` export removes only that process's
exact live thread; unknown, already-exited, and cross-process TIDs return
`ESRCH` rather than falling back to a host-side lifecycle decision.

Fork and spawn use the validated caller identity to select the calling task's
blocked signal mask. A fork child inherits that mask, and a spawn child inherits
it unless `POSIX_SPAWN_SETSIGMASK` supplies a replacement. The obsolete
`kernel_reset_signal_mask` export is removed; clearing the fork child's mask in
the host would violate pthread-fork semantics. On the child rewind path, libc
refreshes the copied pthread TID from the kernel through `set_tid_address`
before returning from `fork()`.

Channel identity binding is kernel-validated in the same epoch.
`kernel_set_current_tid(pid, tid) -> 0 | -errno` replaces the former unchecked
one-argument setter. It accepts only the process's main task or a thread that
the same `ProcessTable` has already allocated for that process; a host cannot
invent a TID or bind one process's channel to another process's task. The
read-only `kernel_validate_task(pid, tid)` export lets the host validate channel
registration without installing dispatch authority. Clone callbacks attach a
mailbox by consuming a one-shot host transport proof whose immutable PID/TID
pair comes from that exact kernel clone result. The public attachment path does
not accept a numeric TID, and rejects proof replay, duplicate offsets, duplicate
TID ownership, and attempts to substitute a different valid sibling task. A
successful `kernel_set_current_tid` binding authorizes exactly one
`kernel_handle_channel` call and is cleared after every return. Because
the reusable kernel's exit transaction returns through the dispatcher, its
normal epilogue restores the kernel shadow stack and clears that binding. The
separate guest `kernel_exit` import traps only after the host completes the
exit-channel handshake, preserving `_exit`'s non-returning program contract
without trapping the reusable kernel instance. Missing, rejected, stale, or
exited task bindings fail closed with `ESRCH`; no PID-only ambient selector
remains.

ABI 42 host runtimes also accept the deliberate trap emitted by older ABI 42
kernels after a committed exit, but still require authoritative `Exited` state
before publishing success. This preserves old/new host-kernel compatibility
while fixed kernels return through their shadow-stack epilogue.

All host-initiated guest mutations that previously depended on such a selector
now carry their authority explicitly. `kernel_dequeue_signal(pid, tid,
out_ptr, out_capacity)`, `kernel_wait_child_poll(parent_pid, caller_tid,
target_pid, event_mask, flags, out_ptr, out_capacity)`, and
`kernel_prepare_write_operation(pid, tid, fd, offset, len, positioned)`
validate the exact live caller before consuming signal or wait state or
applying write-limit side effects. Guest SysV shared
memory calls use `kernel_ipc_shmat_for_task(pid, tid, ...)` and
`kernel_ipc_shmdt_for_task(pid, tid, ...)`; lifecycle-only inheritance,
rollback, and teardown use the separate explicit-process
`kernel_ipc_shmat_for_process` and `kernel_ipc_shmdt_for_process` exports.
The former `kernel_set_current_pid` export is removed.

ABI 43 also moves host-bridged TCP listener selection into the process table.
`kernel_pick_tcp_listener_target(port, exclude_pid, out_ptr, out_capacity)`
writes one little-endian `{ u32 pid, i32 fd }` record into eight bytes of kernel
scratch when `out_capacity` is exactly eight and returns `1`, returns `0` when
no live listener exists, or returns a negative errno. Rust filters
authoritative process, descriptor, open-file-description, and socket state and
owns the per-port round-robin cursor. The
shared Node/browser host retains only the platform listener objects, stable
accept-wakeup identities, and their lifecycle mirrors.

Process teardown in ABI 43 also consumes platform-timer cleanup from Rust via
`kernel_take_process_timer_cleanup(pid, out_ptr, out_capacity)`. Each bounded
little-endian list begins with `{ u32 cancel_alarm, u32 posix_count }` and is
followed by `posix_count` timer IDs. Rust clears exactly those process-owned
identities before a parent can reap the zombie; the shared Node/browser host
uses the detached list only to cancel its `setTimeout`/`setInterval` handles.
An oversized list returns `ERANGE` without consuming any Rust state. The host
may use its remaining handle maps only at that bounded-output fallback or after
Rust reports `ESRCH`, which is the explicit post-reap worker-detachment
boundary.

ABI 43 publishes the existing kernel wake stream as the generated
`wakeup_event_wire` contract. Each packed record is five bytes: a
little-endian `u32` identity followed by a one-byte reason bitset. Rust owns
the offsets and the readable, writable, accept, datagram-writable,
process-stopped, process-continued, and advisory-lock bits. The shared
Node/browser host decodes the stream only through generated constants before
rescheduling its platform-owned retry queues. This metadata adds no extra
host-to-kernel call; it makes the already-observable stream explicit in the
ABI snapshot.

The pending ABI 43 contract additionally makes the Rust `Process` authoritative
for each System V shared-memory attachment's process address, segment id, and
size. After the host has materialized an attachment and its byte-coherence
mirror, it commits that identity through
`kernel_ipc_shm_record_mapping_for_task(pid, tid, addr, shmid, size)`. Fork
materialization uses the corresponding `for_process` form because the child
does not have a running guest task yet. `shmdt` first calls
`kernel_ipc_shm_lookup_mapping_for_task(pid, tid, addr)`, whose nonnegative
`i64` result packs the size in the upper 32 bits and shmid in the lower 32
bits; negative values are negated errno values. After publishing dirty bytes,
the host calls `kernel_ipc_shmdt_addr_for_task`; lifecycle rollback and teardown
use `kernel_ipc_shmdt_addr_for_process`. The older segment-id detach export is
used only to roll back a `shmat` that acquired `nattch` but failed before an
address record could be committed.

These address records are not serialized in the ordinary fork wire image.
The existing host inheritance transaction records each child attachment only
after `shmat` succeeds and rolls back by exact address before publishing child
bytes. Successful exec drains the records and decrements `nattch` in Rust at
the irreversible image commit; failed exec leaves both records and host byte
mirrors intact. Process removal provides the final Rust-owned cleanup path.
The host mirror remains necessary because separate WebAssembly memories do not
share physical bytes, but it no longer determines attachment identity or
lifetime.

The Rust kernel Wasm's obsolete direct `kernel_fork` export and its
host-supplied `host_fork` and `host_clone` imports are also removed. Guest libc
still imports `kernel_fork` from its process-worker adapter; that adapter routes
the request through the centralized host, which calls
`kernel_fork_process(parent_pid, caller_tid)` and uses the PID returned by
`ProcessTable`.

Exact-thread signal delivery is strict in ABI 42. `tkill` and `tgkill` deliver
only to a retained live task record in the calling process. TID 0 and unknown
or exited TIDs return `ESRCH`; they are not reinterpreted as process-wide
signal requests. Cross-process exact-thread delivery remains unsupported.
Machine-wide `kill` target selection, including process groups and `kill(-1)`,
now runs entirely against `ProcessTable`; the former `host_kill` import and
host-side `DeliverSignalMessage` routing path are removed.

These removals and signature/return-semantics changes, including task
creation, `kernel_set_current_tid`, signal dequeue, child wait, write prepare,
SysV attachment, exact exec, and exact thread exit, are incompatible kernel
Wasm changes. Kernels, hosts, packages, guest binaries, and VFS images from
ABI 41 must be rebuilt rather than mixed with ABI 42 artifacts.
#### Scalable fork continuations

ABI 42 replaces the fixed-capacity contiguous save buffer with dynamically
mapped linked chunks. Instrumented modules carry the strict version-1
`kandelo.wpk_fork.linked_frames` descriptor and import
`env.__wpk_fork_frame_reserve`, `env.__wpk_fork_frame_commit`, and
`env.__wpk_fork_frame_next`. The host validates the descriptor, owns chunk
allocation and cleanup, and rejects incomplete or stale instrumentation.

The transition is incompatible: generated postambles depend on
reserve-before-write and commit-after-write semantics, replay uses a validated
linked-node order, and instrumented modules require the seven-export control
set including `wpk_fork_abort_begin` and `wpk_fork_abort_end`. The old
channel-adjacent area is only an active-root handoff anchor. ABI 41 and older
programs must be rebuilt with the ABI 42 instrumenter, and package/VFS
artifacts must be rebuilt from source for the new ABI epoch.

Version 1 keeps inherited chunks at the parent's virtual addresses in the
child. Relocating and rebasing a serialized continuation is not part of this
ABI. The linked descriptor requires transactional-node and abort-unwinding
flags. A typed allocation failure before unwind returns its errno directly; a
later failure enters `ABORT_UNWINDING`, reconstructs the committed inner
frames, releases the partial continuation, and returns the errno from the
original `fork()` call without terminating the parent.

### ABI 43 activation-owned fork replay

ABI 43 batches two incompatible platform contracts: activation-owned fork
replay and capacity-bound kernel scratch transfers. The replay contract closes
the remaining dependency on mutable state in the parent Wasm instance. A fork
child receives copied linear memory but a newly instantiated module, globals,
tables, exception tags, and host Store. Module-static reference tables
therefore cannot prove that a replay value survived fork.

Every ABI 43 fork artifact carries the version-1
`kandelo.wpk_fork.capabilities` section with
`FORK_CAP_ACTIVATION_STATE_SAFE`. Instrumentation, package guards, Node and
browser executable resolution, worker launch, pthread launch, and side-module
loading treat the capability as part of the artifact contract. Missing,
duplicate, malformed, unknown-version, unknown-bit, or safety-bit-free
capabilities fail before execution.

ABI 43 also gives the process fork import an explicit transaction mode.
`kernel.kernel_fork` changes from `() -> i32` to `(i32) -> i32`, where mode 0
is ordinary fork and mode 1 is vfork. The process Worker maps those modes to
`SYS_FORK` and `SYS_VFORK`, carries the selected mode through capture, parent
replay, abort replay, child launch, and Worker initialization, and rejects a
different mode at the inherited call site. The centralized host passes the
same mode to the incompatible
`kernel_fork_process(parent_pid, caller_tid, mode)` export; Rust rejects any
unknown value with `EINVAL`. Artifact admission requires the exact import
signature, and the ABI snapshot owns both values.

For mode 1, the instrumented process Worker also places the exact aligned
private-prefix bytes in host-intercepted `SYS_VFORK` argument 0 and the
page-rounded reference/exception scratch high-water in argument 1. The host
admits at most 61,440 prefix bytes and 65,536 scratch bytes and returns
`EAGAIN` before the Rust child allocation when either bound is exceeded. This
is an ABI 43 semantic channel contract: it changes no syscall number, linked
frame encoding, kernel import/export signature, or structural snapshot field.
Ordinary `SYS_FORK` keeps all six arguments zero.

Mode 1 now selects the shared-memory vfork lifetime. A separate child Worker
retains the parent's existing `Shared WebAssembly.Memory`; it constructs no
child process Memory and copies no address-space bytes. The child receives a
private syscall channel, bounded replay workspace, Wasm instance, loader, and
continuation controller. The asynchronous import keeps only the calling parent
thread parked until successful exec commit or exact `_exit()`/signal/trap
teardown, while sibling pthreads remain runnable. Failed exec returns to the
child without ending the lifetime. Ambiguous forced termination contains the
whole shared address space rather than publishing an unsafe parent return.
Ordinary fork behavior is unchanged.

The exact-generation lifetime records and Node/browser Worker messages used to
coordinate launch and teardown are host-private protocol, not persisted guest
ABI. No new linked-frame field, marker getter, or public kernel export was
needed beyond the ABI 43 mode-aware import/export and bounded workspace
arguments described above. Release still requires the broader conformance,
upstream CRuby, and resident-memory proofs; those gates do not alter
the structural ABI decision.

The instrumenter also rejects any input that already carries fork control
exports, linked-frame imports, or fork metadata. This prevents a transformed
ABI 42 module from being run through the ABI 43 tool merely to acquire the new
safety claim; package builds must instrument raw linker output.

The frame contract remains version 1 and keeps its existing 16-byte header.
Offset `+8` carries the exact dynamic catch selector and the formerly
reference-stash-related word at `+12` carries a process reference-vector
ordinal. The instrumenter no longer creates
`_wpk_fork_funcref_stash`, `_wpk_fork_externref_stash`, or
`_wpk_fork_exnref_stash`.

Live reference locals, parameters, call operands/results, `call_ref` callees,
mutable reference globals, typed table entries, and complete exceptions use
one process-owned KFRV (Kandelo Fork Reference Vectors) recipe transaction
inside the KFMS (Kandelo Fork Module State) arena copied through linear memory.
Function/static-root catalogs reconstruct fresh instance-local identities;
typed GC recipes preserve concrete layout, cycles, aliases, and externalized
views. Materialization also re-registers weak constructor provenance for the
new object, including packed segment operands and nullable recipe-zero seeds,
so that the child can itself become the parent of a later fork. Durable
process-image handles represent opaque `externref` values.
Generated module-state helpers restore globals, table length/content, and
segment lifetime before frame replay. A generation-published sparse table
journal keeps pthread and late-dlopen replicas coherent without copying
WebAssembly functions or `exnref` values through JavaScript.

ABI 43's POSIX dynamic-loader path is staged and non-reentrant.
`__wasm_dlopen_prepare` validates and owns a private transaction without
entering Wasm. Each `__wasm_dlopen_next` advances host-only
compilation/instantiation as needed and returns one initializer table entry.
Instrumentation removes the native start section and exposes its initialization
as an explicit bootstrap stage, so instance construction cannot run that guest
path; libc invokes each returned entry only after the import returns.
Instrumentation lowers the historical canonical two-, four-, and five-argument
`__wasm_dlopen` imports to the same protocol before computing fork
reachability. The two-argument form retains its historical
`dlopen:<buffer-address>:<byte-length>` identity. The original imported
function identity becomes a local tail adapter, preserving table and `ref.func`
aliases without leaving a host callback under initialization.
Artifact publication and host launch reject an ABI 43 safety claim if the
legacy import or a native start section remains. Input modules may use a start
section, but an accepted completed transform must expose it only through
`wpk_fork_module_bootstrap`. The lower-level `DynamicLinker.dlopenSync()`
driver is an embedder API, not an accepted process import. The process Worker
must perform final instantiation and Store-local function/tag registration
even when kernel policy coordinates the load, because those identities cannot
be cloned from the kernel Worker.

ABI 43 also assigns channel-header offset 68 to `request_flags`.
`REQUEST_FLAG_DEFER_SIGNAL_DELIVERY` marks a request whose completion is
consumed by process-worker JavaScript rather than libc's ordinary post-syscall
signal trampoline. The kernel leaves a caught signal pending for such a
completion instead of dequeuing it into a channel record that JavaScript
cannot deliver. After `fork`, `clone`, or a staged-loader import returns, libc
issues a side-effect-free `getpid` checkpoint through the ordinary channel
path; that completion owns normal handler delivery and signal-mask restoration.
The flag occupies bit 2. Bits 0 and 1 independently record cancellation-point
membership and cancellation-wake authority, so all three meanings can be
preserved in one captured request snapshot. The flag changes neither the
continuation encoding nor any activation's frame size.

Statically tagged scalar `Catch`/`CatchRef` arms serialize their exact selector
and maximum live scalar tag tuple. During rewind the tool executes `throw` with
that reconstructed payload; the original clause creates a fresh
child-instance exnref. Reference/vector payloads, `CatchAll`, `CatchAllRef`,
JSTag ingress, and normalized legacy-EH cleanup paths use the
complete-exception recipe and likewise throw inside Wasm. Transaction cleanup
clears temporary tables, roots, and owner leases after replay or abort.

The capability therefore attests to present reconstruction machinery, not a
conservative source-shape rejection pass. Valid reference-bearing code outside
the fork closure remains unmodified; valid reference-bearing code inside the
closure receives the typed ownership path. Artifact validation still rejects
malformed/version-mismatched contracts and pre-instrumented ABI 42 input before
execution.

This is an incompatible artifact epoch even though the linked-frame descriptor
version is unchanged. All fork-instrumented programs, side modules, package
archives, binary indexes, shell closures, and VFS images must be rebuilt from
source. Existing C++ modern-EH outputs that retain exnref locals or use
`CatchAllRef`, and the Dash `expandstr` cleanup path, are supported rebuild
inputs through those recipes; they are not candidates for metadata relabeling
or package-specific bypasses. The ABI 43 development shell/rootfs closure can
be rebuilt from source. Broad package, index, shell, and image publication still
requires explicit release coordination. The exact archive-generation,
rootfs/image, and package sequencing and isolation boundary is recorded in
the [ABI 43 activation-state-safe artifact rebuild
plan](plans/2026-07-25-abi-43-activation-state-safe-rebuild-plan.md).

### ABI 43 capacity-bound kernel scratch transfers

PR #1097 merged as
`c7d039794a43788acfa0b0aea30a700c257f57cb` with ABI 42, and this work is
based on that exact merged result. ABI 43 is therefore required for the actual
incompatible export and wire changes below, including the added
`kernel_wait_child_poll` output-capacity argument. The version change is not
bookkeeping for generated constants. Exact final-head validation is a PR
readiness gate recorded with the commit SHA it actually exercised; this section
records the durable ABI contract rather than a mutable readiness claim.

ABI 43 makes variable-size host writes into reusable kernel scratch an
explicit ownership protocol. A host write is valid only after it
independently proves the caller source range, the kernel-owned destination
allocation, the allocation's declared capacity, the current kernel-memory
range, the allocation lifetime, exclusion of overlapping replacement, and
lossless wasm32/wasm64 pointer conversion. The fact that a destination range
fits somewhere in the kernel's total WebAssembly linear memory does not prove
that the Rust allocator assigned those bytes to the destination object.

Ordinary channel-sized transfers carry the kernel pointer and capacity
together in a host-side `KernelScratchRegion` and can be accessed only through
a synchronous lease. The `kernel_handle_channel` export now takes
`(channel_offset, channel_capacity, pid, retry_token)`; Rust rejects a capacity
other than the canonical complete channel allocation before decoding it. Token
zero starts an operation, while a positive token reactivates the exact
Rust-owned target retained for a represented retry. This signature change is
incompatible with an ABI-42 host or kernel.

ABI 43 also assigns the channel header's former four-byte reservation at offset
68 to generated `request_flags`. The cancellation-point and wake-authority
bits occupy bits 0 and 1. The deferred signal-delivery authority occupies bit
2. They are written before status publication, captured and cleared once by
the host, and retained with every asynchronous request snapshot. Unknown bits
and wake-without-cancellation-point fail closed. This is observable wire state,
not a host-only implementation detail.

`kernel_blocking_retry_token(pid, tid, syscall_nr)` returns the exact positive
token for a classified Rust target, zero for an authoritative host-only
snapshot, or a negated errno. `kernel_blocking_retry_release` consumes a
positive token. The trailing retry token on
`kernel_transfer_io_execute`, `kernel_transfer_channel_execute`,
`kernel_sendmsg`, and `kernel_recvmsg` prevents replay from resolving a numeric
fd, queue descriptor, or System V id that may have been closed and reused.
Completion and cancellation consume the token before the host deletes its
immutable snapshot.

Every generated pointer descriptor is explicitly and exclusively `required`
or `nullable`. Positive-extent null pointers fail unless the shared descriptor
permits null; an argument-sized null pointer with zero extent is canonicalized
to an allocator-owned empty range. The host pre-captures every caller-owned
`u32` used by a `Deref` size before planning any suballocation, then uses that
one value for both the dynamic buffer and its staged length record. Rust
validates the canonical ordered, aligned, non-overlapping descriptor layout
and the complete allocation range before dispatch. Because the generic wire
does not encode an unpadded capacity beside every descriptor, Rust cannot
independently detect a hypothetical staged-length change that stays within one
eight-byte alignment bucket; the exact capacity comes from the host's
pre-captured value under the single synchronous, non-reentrant lease. Adding a
second per-descriptor capacity would itself be a future ABI design change.

ABI 43 describes `getgroups` and `setgroups` through that generic pointer
table. Their count is a caller-native process-size scalar and their vector is
exactly `count * sizeof(gid_t)` bytes, bounded by `NGROUPS_MAX` before scratch
allocation. `getgroups` adds a generated return-value copy-out rule: the host
copies `return_value * sizeof(gid_t)` bytes, so a count-only query lends no
destination and a larger caller buffer keeps its unused tail. The public
`kernel_getgroups` export consequently takes only `(size, list)`; the former
host-selected capacity argument and special one-group handler are removed.

The same unpublished ABI 43 batch advances the exact fork and test-only exec
state record to version 15. After the parent identity it stores real,
effective, and saved UID; real, effective, and saved GID; an ordered bounded
supplementary-group vector; and the kernel-owned `secure_exec` bit. Versions
14 and 16, malformed counts, truncation, and trailing bytes are rejected
instead of reconstructed through a compatibility fallback. The complete
record is validated before the credential value or `secure_exec` is installed.

`prctl` deliberately has no generic pointer descriptor. Only `PR_SET_NAME` and
`PR_GET_NAME` interpret argument 1 as a required exact 16-byte scratch buffer;
other options preserve its low 32-bit scalar value. Treating that slot as one
shape for every option would either dereference a scalar or replace it with an
unrelated scratch pointer.

Large scalar and vector I/O uses a separate Rust-owned, single-use
reservation. `kernel_transfer_scratch_begin`,
`kernel_transfer_scratch_pointer`, and
`kernel_transfer_scratch_capacity` publish one initialized allocation only
while its positive token is `Reserved`. `kernel_transfer_io_execute` or
`kernel_transfer_channel_execute` consumes that token and enters
`Executing` before releasing the reservation mutex and calling any host
import. A normal return makes it `Ready`; `kernel_transfer_scratch_cancel`
then drops the allocation. The execute exports accept no host-selected
pointer, so allocation capacity cannot be separated from ownership.

ABI 43 also permits a narrower, read-only use while a transfer token remains
`Reserved`. `kernel_get_cwd`, `kernel_get_fd_path`, and
`kernel_get_dirfd_path` produce complete canonical path snapshots before an
asynchronous spawn, exec, or shared-mapping callback. A zero destination
capacity queries the exact byte length without dereferencing the pointer; a
positive short capacity returns `ERANGE` without writing. The host first tries
the ordinary region, reserves the exact required transfer capacity only when
needed, invokes the producer synchronously, detaches every byte, revokes the
region, and cancels the still-`Reserved` token. It does not call an execute
export for this case: the getter itself is the one Rust operation, and the
`Reserved` state already prevents another reservation from moving or replacing
the allocation.

Canonical CWD and descriptor paths are not limited to `PATH_MAX`. `PATH_MAX`
bounds one caller-supplied pathname; resolving that input against an
already-deep directory can create a longer internal absolute spelling.
Publishing a truncated prefix could select a different executable or mapping
backing. `kernel_get_dirfd_path` additionally requires the descriptor to name
a directory and returns `ENOTDIR` otherwise, while `kernel_get_fd_path`
retains the ordinary descriptor behavior required by `AT_EMPTY_PATH`.

A host-import trap can strand a reservation in `Executing`, where cancellation
must reject rather than free memory that a callback may still have partially
observed. The host therefore treats such a trap as a fatal kernel-generation
failure and admits no later ingress. This fail-closed lifetime rule, the
removed public raw scalar/vector exports, and the new required transactional
exports are incompatible ABI changes folded into the still-unreleased ABI 43;
they are not an additive ABI-42 extension.

Large `SYS_SPAWN` blobs use a Rust-owned reusable
`Vec<u8>` with a tokenized transaction:

1. `kernel_spawn_scratch_begin(minimum_capacity)` returns a fresh positive
   reservation token or a negated errno. Begin is nonblocking; mutex
   contention returns `EBUSY`.
2. `kernel_spawn_scratch_pointer(token)` and
   `kernel_spawn_scratch_capacity(token)` are read after begin; both return
   zero for a stale or non-current token or for mutex contention. The separate
   pointer-free
   `kernel_spawn_scratch_retained_capacity()` export reports the retained
   high-water allocation for diagnostics without granting write authority and
   likewise returns zero on contention.
3. The host proves the complete pointer-plus-capacity range and copies without
   yielding.
4. `kernel_spawn_reserved_process(parent_pid, caller_tid, token, blob_len)`
   consumes that exact token, parses into Rust-owned data, and releases the
   scratch lock before process-table work or host imports.
5. After every successful begin, the host calls
   `kernel_spawn_scratch_cancel(token)` in a `finally` block, including setup
   and copy failures. Success releases an unconsumed matching token; `EINVAL`
   means the never-reused token was already consumed or is stale. For the
   just-issued in-contract token after commit, the consumed case is expected.
   Commit and cancellation wait on the same no-host-import critical section,
   so both return with a definitive token state instead of stranding authority
   on transient contention.

Every large operation begins a new reservation even when the retained vector
already has enough capacity. Stale tokens, concurrent reservations, and
reentrant host operations cannot replace bytes being consumed. The previous
pointer-returning `kernel_spawn_scratch_reserve` interface and fixed
worst-case compatibility fallback are not part of ABI 43.

The same ABI 43 spawn transaction requires
`kernel_publish_spawn_child(parent_pid, child_pid)`. Rust marks a newly
reserved spawn child as unpublished, so wait selection cannot consume it while
the host performs asynchronous exact-target read, validation, compilation,
commit, and Worker launch. Publication verifies the exact parent/child pair,
clears that state once, and returns `-1` for a live child, zero for ordinary
exit, or the positive terminating signal. `-ESRCH` remains authoritative
child absence and is not a live sentinel; `-ECHILD` means the exact hidden
child remains owned but its bound parent is absent or has already exited, so
rollback must remove it.
The host publishes the successful spawn
result in the same serialized entry before waking queued waiters; failure uses
the existing exact removal path and also wakes them. That detached completion
does not depend on the parent mailbox registration remaining live, while every
parent-memory write still requires the exact active channel. No older export can own
that atomic boundary: target commit necessarily precedes a fallible Worker
launch, and process removal is the opposite, failure-only transition. This is
an additive structural change to the still-unpublished ABI 43 export set, so
the ABI snapshot and generated host manifest carry it without inventing ABI
44 or permitting a fallback.

ABI 43 requires `host_pread` and `host_pwrite` so positioned regular-file I/O
keeps a signed 64-bit offset lossless and does not mutate a shared
open-file-description cursor through seek emulation. It also requires the
paired append imports. `host_append(handle, pointer, length, limit_lo,
limit_hi)` performs one EOF/limit/write transaction, and
`host_append_position(handle, written)` consumes the matching one-shot ending
offset. Rust validates the returned prefix and ending position before
publishing its cursor. A backend that cannot provide this exact outcome must
return `EOPNOTSUPP` before mutation.

ABI 43 also makes System V IPC control-structure sizing explicit. Required
pointer-width queries report the target musl layouts: `msqid_ds` is 96 bytes
on wasm32 time64 and 120 bytes on wasm64 LP64, `semid_ds` is 72/88 bytes, and
`shmid_ds` is 88/112 bytes. The process width is authoritative even when it
differs from the kernel Wasm width. The host stages `msgctl`/`shmctl`
`IPC_STAT` and `IPC_SET` according to the command and carries that width in its
private sixth kernel-dispatch slot. The required
`kernel_semctl_array_bytes(pid, tid, semid, command)` export performs the
permission-aware GETALL/SETALL size preflight; the host does not substitute a
read-only `IPC_STAT` query for a write-only SETALL operation.

Generated process-layout descriptors apply the same caller-width rule to
`stack_t` (12/24 bytes), the kernel-facing four-native-`long` `itimerval`
(16/32), `mq_attr` (32/64), `sigevent` (64/64), `statfs` (88/120), and
`sysinfo` (312/368), and `siginfo_t` for `rt_sigqueueinfo` (128/128). The host
stages exactly the selected record and carries the process width in its
private sixth dispatch slot. Rust rejects any other width and parses or
serializes the exact bounded slice; padding and reserved output bytes are
initialized. This prevents the kernel Wasm's own wasm32 data model from
truncating a wasm64 process record. Fixed generated descriptors separately
carry `stat` (112 bytes) and `sched_param` (48 bytes); those records do not use
width selection or the private process-width slot.

The channel `setsockopt` path uses the otherwise private sixth dispatch slot
for the same independently known caller width. The generated native
`group_req` layout is 132 bytes with its group at offset 4 on wasm32 and 136
bytes with its group at offset 8 on wasm64; `group_source_req` is 260/264
bytes with its source at offset 132/136. Rust accepts only widths 4 and 8.
Neither `optlen` nor padding bytes may select a data model. The public
five-argument `kernel_setsockopt` export is structurally unchanged and uses
the kernel's native width for direct calls; only channel dispatch consumes the
host-private width. Adding the generated layout constants and correcting this
interpretation remain part of unpublished ABI 43 and do not create ABI 44.

Signal and timer transport also change incompatibly in ABI 43. The
`kernel_timer_create` export grows from three arguments to
`(clock_id, sigevent_ptr, timerid_ptr, process_pointer_width)`, and its second
argument names the complete generated caller-native 64-byte `sigevent` instead
of a private four-`i32` prefix. The channel signal-delivery record grows from
44 to 56 bytes, while its reserved area grows from 48 to 56 bytes. Its
`si_value` slot is an unaligned eight-byte raw `union sigval`; wasm64 delivery
preserves all bits and wasm32 delivery uses the target-native low 32 bits.
`kernel_dequeue_signal` and `kernel_wait_child_poll` each gain an explicit
output-capacity argument so validation happens before either operation consumes
kernel state. POSIX message-queue notification now queues the authoritative
`SI_MESGQ` record in Rust, including the full raw value and sender credentials;
the eight-byte host record only tells the host which task to wake. These are
observable export and wire changes, not generation-only bookkeeping.

The ABI 43 required host-adapter export set retains the ABI 42-required
`kernel_spawn_process` and adds
`kernel_blocking_retry_release`,
`kernel_blocking_retry_token`,
`kernel_commit_process_exit`,
`kernel_get_cwd`, `kernel_get_dirfd_path`, `kernel_get_fd_path`,
`kernel_msqid_ds_bytes`, `kernel_semctl_array_bytes`,
`kernel_semid_ds_bytes`, `kernel_shmid_ds_bytes`,
`kernel_process_metadata_begin`, `kernel_process_metadata_cancel`,
`kernel_process_metadata_commit`, `kernel_process_metadata_stage`,
`kernel_set_cwd`,
`kernel_spawn_reserved_process`,
`kernel_spawn_scratch_begin`,
`kernel_spawn_scratch_cancel`, `kernel_spawn_scratch_capacity`,
`kernel_spawn_scratch_pointer`, and
`kernel_spawn_scratch_retained_capacity`, plus
`kernel_transfer_channel_execute`, `kernel_transfer_io_execute`, and the four
`kernel_transfer_scratch_*` exports described above. The required capabilities
and synchronization semantics changed, so this is incompatible rather than
bookkeeping around additive constants. Kernels, hosts, packages, guest
binaries, and VFS images from ABI 42 must be rebuilt rather than mixed with
ABI 43 artifacts.

`kernel_enum_procs` keeps its existing two-argument export signature, but its
producer contract is now atomic and capacity-derived. Rust computes the
complete snapshot with checked arithmetic using the packed 36-byte
per-process header defined by
`wasm_posix_shared::process_snapshot_wire`, returns `ENOSPC` before any write
when the supplied allocation is short, and constructs only the exact required
output slice on success. Generated TypeScript constants and the ABI snapshot
pin the same count/header sizes and every field offset; the host fails closed
on a malformed later record instead of returning a valid prefix. This corrects
the former 40-versus-36-byte accounting mismatch and removes cross-language
layout duplication without granting authority from the remainder of linear
memory or introducing another ABI epoch.

ABI 43 has not been published as a compatibility epoch. The retry-token,
large-transfer, fatal-lifetime, positioned-I/O, and append corrections amend
that same pending ABI-43 contract and snapshot. They do not justify inventing
ABI 44 merely to preserve an unreleased draft, and they must not be hidden
under released ABI 42.

The pending epoch also makes ordinary mount state authoritative for set-ID
execution. A retained executable's owner and `S_ISUID`/`S_ISGID` bits produce
the effective-credential transition on every mount that does not report
`ST_NOSUID`, including a writable VFS image. There is no private product
capability, immutable-image exception, or first-party executable allowlist in
that decision. The host retains and revalidates the executable handle, bytes,
metadata, mount flags, and inode identity before the kernel commits the
transition. Existing ABI-43 binaries must be rebuilt with this final
unpublished execution contract; preserving the earlier draft would not justify
creating ABI 44.

The same pending epoch also makes process-startup argv/environment reads
complete-or-`ERANGE`. A zero destination capacity queries the exact immutable
entry length; a positive short capacity writes nothing, and an exact-capacity
retry must return the same complete length. The signed C/Rust result still has
the same Wasm `i32` function type, but the error semantics and rebuilt CRT are
an observable contract change. The CRT validates the generated 4,096/4,096
entry caps and pointer-width-aware 4 MiB representation before allocating
guest-process memory through ordinary `mmap`; it never clamps a count or
copies a prefix into fixed 64/128 KiB buffers. This semantic correction belongs
in unpublished ABI 43 rather than being hidden under released ABI 42 or
creating an ABI 44 for an unreleased intermediate draft.

The four metadata-transaction exports and cwd setter are required because
process registration uses them unconditionally. Begin returns a positive
process-bound token; each stage synchronously copies one capacity-checked
scratch entry into Rust-owned storage; commit swaps the complete argv and
environment pair without a fallible allocation or host import; and cancel
drops an uncommitted token without changing live metadata. A failed stage
permanently makes its token uncommittable. Partial replacement is not part of
the contract: the host supplies both vectors or neither, so its generated
count and aggregate `ARG_MAX` validation never ignores bytes preserved from
an earlier pair. This prevents both an allocation overflow and the subtler
clear-then-push failure in which a later `ENOMEM` exposed a live prefix. The
complete CWD, fd-path, and directory-fd-path getters are required
because relative spawn/exec and shared-mapping resolution cannot safely fall
back to a fixed or truncating query. A same-version kernel may not use the
historical aggregate argv setter or clear/push metadata exports, silently
ignore initial cwd, or omit one of those path queries: each fallback would
accept boot while losing the bounded, capacity-owned transfer and atomic
replacement contracts that ABI 43 advertises.

The authoritative platform and spawn-wire constants remain generated from the
Rust ABI sources. Moving identical constants to that generation path would not
by itself require a bump; the required transactional exports and semantics do.
Making each `WasmPosixKernel` wrapper a one-generation, one-shot initializer is
host-side lifetime hardening for cached scratch allocations. It changes no
kernel export, wire layout, manifest capability, or accepted guest limit, so it
does not require an additional ABI epoch beyond 43.
The option-sensitive `prctl` operation values and the fixed scratch widths for
thread names, Fcntl lock records, and signal masks likewise have one shared
Rust authority and generated TypeScript consumers. Centralizing those
unchanged values is bookkeeping, not another ABI change.
The channel-handler signature, exhaustive pointer-nullability semantics, and
option-sensitive `prctl` marshalling are also incompatible contract changes
within ABI 43, not bookkeeping-only generation changes. Buffer sizing was
selected first for ownership and lifetime correctness. Retained-capacity,
peak-memory, and timing comparisons are not ABI facts: exact baseline and
candidate source identities, runtime-artifact fingerprints, workloads, and
separate Node.js/real-Chromium results belong in the draft PR evidence ledger
after the candidate is frozen. No latency improvement or broad performance
no-regression is claimed here.

### ABI 44 machine checkpoint and restore

ABI 44 versions the machine-migration contract: a running machine can be
frozen into a checkpoint, torn down, and restored — in the same tab, in
another tab, or on another host.

The syscall channel reserves an 8-byte checkpoint request area directly
below the 56-byte signal delivery area, at the tail of the 65,536-byte
data buffer. It holds one `u32` request word. The host publishes the word
before completing a process's pending syscall; libc's post-syscall
trampoline clears it and calls the new process import
`kernel.kernel_checkpoint`. The import takes nothing and returns nothing:
the capture pass unwinds the call stack into linear memory instead of
returning, and a rewind resumes the guest after the syscall that carried
the request. Every freshly built main program imports the hook, and hosts
validate its signature the way they validate `kernel.kernel_fork`. The
import is also the instrumenter's checkpoint seed, so programs that never
fork still carry the unwind machinery.

Restore adds four kernel exports. `kernel_enumerate_host_handles` and
`kernel_remap_host_handles` let a receiver read the host handles held
inside restored kernel memory and rewrite them to its own.
`kernel_rearm_host_timers` re-arms a restored process's armed interval
timer with its remaining time (POSIX timer slots store no deadline, so
their remaining time stays a documented gap). `kernel_pty_index_for_pid`
lets the receiver re-seed the host maps that route terminal input to a
restored process's PTY.

## The snapshot

`abi/snapshot.json` is generated by `cargo xtask dump-abi` from the
authoritative Rust sources and the freshly-built kernel `.wasm`. It
captures:

- `abi_version` — the integer [`ABI_VERSION`](../crates/shared/src/lib.rs).
- `platform_limits` — the advertised `ARG_MAX`, `PATH_MAX`, and `IOV_MAX`
  values plus defensive process-startup argv/environment count caps generated
  into the TypeScript host and public musl headers.
- `process_metadata_contract` — generated argv/environment kind selectors
  consumed by the replace-both token-bound host/kernel transaction.
- `process_snapshot_wire` — the packed process-table count prefix, 36-byte
  header, and every field offset shared by the Rust producer and TypeScript
  parser.
- `spawn_contract` — the complete non-forking spawn wire contract: syscall
  number, header and action layouts, opcodes, transported attribute bits,
  defensive count caps, public-limit aliases, and derived whole-blob ceiling.
  Any change to either this section or `platform_limits` is classified as
  breaking unless the ABI epoch changes.
- `channel_header` — field offsets and sizes in the channel header,
  read from `shared::channel::*` constants, including the generated
  request-flags word and known-bit mask.
- `channel_scalar_contract` — syscall arguments and results that must preserve
  signed or unsigned 64-bit values rather than taking the default 32-bit
  scalar path.
- `channel_signal_area` — signal-delivery slot offsets in the trailing
  bytes of the channel data buffer.
- `channel_buffers` — data buffer offset/size and minimum channel size.
- `channel_status_codes` — numeric values of `ChannelStatus` variants.
- `marshalled_structs` — per-struct layout (`size`, then `fields[]`
  with `name`, `offset`, `span`). `span` is bytes until the next field
  (or end of struct), so it includes alignment padding and catches any
  layout shift.
- `process_native_layouts` — the generated wasm32/wasm64 musl layouts used
  when the host reads native process records, including `iovec`, `msghdr`,
  `cmsghdr`, `siginfo_t`, `sigevent`, `group_req`, and
  `group_source_req`, plus the shared socket constants needed to interpret
  `SCM_RIGHTS`.
- `syscalls` — every syscall number named by the shared ABI metadata:
  the core `Syscall::from_u32` table plus `abi::extended_syscalls`
  entries for host-visible kernel/control syscalls that are not yet in
  the core enum.
- `syscall_arg_descriptors` — host marshalling descriptors for pointer
  arguments, including direction, size source, size multipliers/additions,
  fixed byte lengths, pointer nullability/requiredness, and any
  return-value-based copy-back adjustment. Generation tests require every
  pointer descriptor to select exactly one of nullable or required, compare
  the complete reviewed nullable set, and keep option-sensitive `prctl` out of
  this generic table.
- `pathconf_names` — the shared numeric `_PC_*` vocabulary consumed by the
  kernel, generated host bindings, and libc wrappers.
- `host_adapter` — Rust-owned boot manifest metadata consumed by host
  adapters: manifest layout, host adapter protocol version, required
  worker feature bits, and required/optional kernel exports.
- `process_memory_layout` — Rust-owned process memory layout metadata:
  Wasm page size, default process memory settings, main control pages,
  pthread slot page offsets, and the process-wasm thread-slot declaration
  contract.
- `custom_sections` — names of wasm custom sections that participate in
  the ABI: `wasm-posix-abi` for the per-binary version and
  `kandelo.wpk_fork.linked_frames` for the linked-continuation layout, and
  `kandelo.wpk_fork.capabilities` for fork role and activation-safety claims.
- `process_expected_globals` — globals every user process instance is
  expected to expose for the host to thread through fork/exec.
- `program_artifact` — requirements checked on instrumented user programs
  before they can be published: the linked-frame descriptor schema, its
  wasm32/wasm64 header sizes, the three transactional frame imports, and
  the seven `wpk_fork_*` control exports with pointer-width-aware signatures,
  plus the capability-section version, known bits, and required safety bit.
  The descriptor width, function signatures, capability claims, and the
  module's single memory address width are validated as one contract.
  WHY this is snapshot-owned: a program can otherwise pass kernel ABI checks
  yet fail only when its first `fork()` reaches a newer host.
- `kernel_exports` — every non-toolchain export in the built kernel
  `.wasm`: function signatures (`(params) -> (results)`), global
  types/mutability, memory + table entries. Toolchain-internal
  symbols (`__wasm_call_ctors`, `__data_end`, `__llvm_*`, etc.) are
  filtered out by `shared::abi::export_is_tracked`. For immutable
  globals whose name matches `ABI_VALUE_CAPTURE_PREFIXES` (today
  `__abi_*`), the initial value is captured as well — so a change to
  an ABI-flag constant moves the snapshot directly.
- `export_deny` — the filter lists themselves (`deny_prefixes`,
  `deny_exact`, `value_capture_prefixes`). Making the filter part of
  the snapshot means adding or removing a pattern is itself an
  ABI-relevant change, tracked by the normal diff.

Fields are sorted alphabetically at every level, and the generator
writes the same bytes for the same input — the snapshot is a pure
function of the checked-in source.

The same generator also owns the cross-language consumers of these snapshotted
constants. Advertised `ARG_MAX`, `PATH_MAX`, and `IOV_MAX`, plus the
process-startup argv/environment count caps, live in
`crates/shared/src/lib.rs::platform_limits`; `cargo xtask dump-abi` writes
their TypeScript consumer and the public musl
`bits/kandelo_limits.h`. The non-forking spawn wire contract lives separately
in `crates/shared/src/lib.rs::spawn_contract`; the generator writes its C
consumer to
`libc/musl-overlay/src/process/wasm32posix/spawn_contract.h`. The private spawn
header aliases the public generated limits—including the startup count
caps—and adds the four-byte string-offset
width; all field offsets in the 40-byte header and 28-byte action record; the
five action opcodes; musl's complete transported attribute byte; the
spawn-only action count cap; and the derived 8,417,320-byte whole-blob
ceiling. Rust, TypeScript, and C therefore consume the same numeric wire
contract. Transporting all eight attribute bits is distinct from implementing
them: the kernel currently acts on `RESETIDS`, `SETPGROUP`, `SETSIGDEF`,
`SETSIGMASK`, and `SETSID`, while `SETSCHEDPARAM`, `SETSCHEDULER`, and
`USEVFORK` remain uninterpreted. The shared startup counts and spawn-only
action/complete wire caps are defensive representation limits, not new POSIX
promises.

Channel scalar widths are likewise Rust-owned. The generator writes
`host/src/generated/abi.ts` and
`libc/musl-overlay/include/bits/kandelo_channel_scalars.h` from
`crates/shared/src/channel_scalar.rs`; the ABI snapshot records the same
contract. Generated freshness tests fail if TypeScript, C, and Rust disagree
about a signed/unsigned 64-bit argument or result.

Native process layouts and fixed kernel wires follow the same ownership rule.
`crates/shared/src/process_layout.rs` owns the wasm32/wasm64 native
`iovec`/`msghdr`/`cmsghdr`, `pollfd`, and `fd_set` values; the generator writes
TypeScript plus `bits/kandelo_process_layouts.h`, and the dual-width C layout
test checks the installed musl sysroots. The fixed `KernelIovecWire`,
`KernelMsghdrWire`, and `KernelCmsghdrWire` structures remain snapshotted
`repr(C)` ABI records. The same generated/snapshotted contract carries the
one-record flattened kernel-iovec count and socket-message constants consumed
by the host, including `MSG_TRUNC`; Rust refuses a different flattened count
until its parser is changed in lockstep. Generating identical native constants
is bookkeeping and does not itself require a bump; changing an existing fixed
wire or observable accepted layout is evaluated under the normal
incompatible-change rules.

## Developer workflow

On a change:

```bash
# 1. Make your change to kernel / shared / glue as needed.
# 2. Regenerate the snapshot. This rebuilds the kernel wasm first so
#    a stale binary can't defeat the check.
scripts/dev-shell.sh bash scripts/check-abi-version.sh update
# 3. Inspect the diff. If it's empty, the change didn't touch the ABI.
#    If it is only an additive-compatible change, commit the snapshot
#    without bumping ABI_VERSION. If it changes existing ABI surface,
#    bump ABI_VERSION in crates/shared/src/lib.rs in the same commit.
# 4. Verify.
scripts/dev-shell.sh bash scripts/check-abi-version.sh
```

In CI:

```bash
scripts/dev-shell.sh bash scripts/check-abi-version.sh
```

Fails if the committed snapshot drifts from the source. If the snapshot
changed versus `origin/main` without a matching `ABI_VERSION` bump, CI
classifies the diff and accepts only the additive cases listed above.

## What the check does **not** catch

- **Semantic changes with the same signature.** Reinterpreting a
  syscall argument, changing blocking behavior, or changing an errno
  value will not show up in the snapshot. Reviewers must catch these.
- **Things not in the generator's coverage list.** Whatever
  `xtask dump-abi` doesn't inspect isn't tracked. Treat the coverage
  list as itself ABI-critical: adding or removing an entry from
  `tools/xtask/src/dump_abi.rs` is an ABI-relevant change. (The export
  filter lists in `shared::abi::EXPORT_DENY_*` are themselves in the
  snapshot, so at least those are self-tracking.)
- **Host-side assumptions not reflected in Rust-owned ABI metadata.**
  Process memory layout constants should live in `wasm-posix-shared`,
  flow through generated TypeScript, and appear in
  `process_memory_layout`. Host-only constants outside that path are not
  protected by the ABI check.

## ABI bumps and package rebuilds

Every built binary carries the ABI version it was compiled against in a
wasm custom section (`wasm-posix-abi`). The host refuses to launch a
binary whose custom-section version does not match the kernel's
`__abi_version` export.

`ABI_VERSION` is one of the inputs to every package's cache key. When the
ABI is bumped, every package's cache key changes, so the next resolve
misses the local cache and rebuilds the package from source under the new
key. There is no remote binary release to cut or index to publish: the
local content-addressed cache and the source-build path handle the
transition automatically. Artifacts built under the old ABI remain in the
cache under their old keys and stay valid for old kernel revisions.

### Additive changes within an ABI epoch

Pure additions do not bump `ABI_VERSION`. Existing binaries still carry
the same ABI number, and the host-side `verifyProgramAbi` check remains
strict equality (`actual !== expected`). This is intentional: we keep a
single breaking-compatibility epoch rather than accepting arbitrary
older binaries against newer kernels.

The package cache key remains keyed by `ABI_VERSION`,
so additive kernel API growth does not force every package to rebuild.
Packages built after an additive change may depend on the new syscall or
export; those packages should be resolved with the matching current
kernel, even though the ABI epoch did not change.

An additive export is compatible only while existing required capabilities and
existing semantics remain unchanged. ABI 43's scratch work is deliberately not
such an addition: it expands the required host-adapter export set, removes the
older large-spawn reservation/fallback contract, and changes the synchronization
semantics of reusable storage. By contrast, identical generated spawn/native
layout constants and an internal TypeScript pointer-plus-capacity value would
not by themselves require an ABI version bump.
