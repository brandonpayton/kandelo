# Fork Instrumentation

`wasm-fork-instrument` is an in-tree Rust tool that rewrites wasm user-program
binaries with save/restore machinery so POSIX `fork()` works. The tool source
lives at [`crates/fork-instrument/`](../crates/fork-instrument/).
Build scripts and tests should invoke
[`scripts/run-wasm-fork-instrument.sh`](../scripts/run-wasm-fork-instrument.sh),
which uses `tools/bin/wasm-fork-instrument` when present and otherwise builds
the tool from Cargo on demand. Every build script that targets a fork-using
program invokes the tool after linking. Asyncify is not an active implementation
path: do not use `wasm-opt --asyncify`, do not accept `asyncify_*` exports, and
do not add Asyncify compatibility fallbacks. This document is the
living reference for the tool's behavior, exported ABI, and save-buffer format.
Some conservative-GC package builds run an additional local-root visibility
pass before fork instrumentation. That pass is not part of the fork ABI; see
[`crates/wasm-local-root-spill/README.md`](../crates/wasm-local-root-spill/README.md)
for its Ruby-focused rationale, risk profile, and extension limits.
For motivation, tradeoffs, and the rollout plan that led here, read
[`plans/2026-04-20-fork-instrumentation-design.md`](plans/2026-04-20-fork-instrumentation-design.md);
for the post-rollout switch-dispatch redesign and non-fork-path-call gating
that fix the kernel-side-effect re-fire bug, read
[`plans/2026-04-22-fork-instrument-switch-dispatch-redesign.md`](plans/2026-04-22-fork-instrument-switch-dispatch-redesign.md).
ABI version: `43` (see
[`crates/shared/src/lib.rs`](../crates/shared/src/lib.rs) — see
[abi-versioning.md](abi-versioning.md) for the policy).

## Policy

- `wasm-fork-instrument` is mandatory for any program that performs `fork()` or
  fork-like operations. That includes `fork()`, `vfork()`, `_Fork()`, shell
  pipelines, command substitution, `system()`, `popen()`, and fork-backed helper
  processes.
- Missing instrumentation is a build/runtime error, not an optional feature
  loss. A fork-using program without complete `wpk_fork_*` exports cannot
  resume the child at the fork call site.
- Every value needed after replay must be either activation-owned bytes in the
  linked continuation or the output of a versioned deterministic
  reconstruction recipe in the fresh child. Module globals and tables are
  instance state, not evidence that a value survived `fork()`.
- ABI 43 fork artifacts must carry the activation-state-safe capability. The
  capability means that activation references, exceptions, mutable reference
  globals, and mutable table state have versioned reconstruction owners. An
  incomplete, malformed, or old-ABI ownership contract fails during
  instrumentation or pre-launch artifact validation; it must not become a
  child-only trap.
- Binaries exporting legacy `asyncify_*` symbols are stale and must be rebuilt.
  Do not add host support for them.
- Do not keep compiler/linker flags solely for the retired legacy path. The
  fork instrumenter does not require preserved function names or onlylists; if
  a build keeps debug-info flags, it should be for a current diagnostic reason.
- On Unix hosts, the CLI preserves the input Wasm file's permission mode on
  its output, including when `--output` names the input file. Package build
  scripts can therefore instrument installed executables in place without
  making them non-executable.

## State machine

Every instrumented module carries a single mutable i32 global, `_wpk_fork_state`,
and one mutable pointer global, `_wpk_fork_buf` (i32 for wasm32 programs, i64
for wasm64). The pointer is zero while the state is `NORMAL` and holds the
address of the active root chunk's module prefix otherwise.

```
                   wpk_fork_unwind_begin(buf)
     ┌─────────────────────────────────────────────────────────┐
     │                                                          ▼
┌────┴──────┐  wpk_fork_unwind_end()   ┌─────────────┐
│  NORMAL   │ ◀──────────────────────  │  UNWINDING  │
│  state=0  │                          │  state=1    │
│  buf=0    │  wpk_fork_rewind_begin   └─────────────┘
│           │  ─────────────────────▶  ┌─────────────┐
│           │  wpk_fork_rewind_end()   │  REWINDING  │
└───────────┘ ◀──────────────────────  │  state=2    │
                                       └─────────────┘
```

- `NORMAL` — ordinary execution. Gated ops and gated calls run normally.
- `UNWINDING` — the stack is being torn down. Each instrumented function runs
  its unwind-only call-site bridge, reserves a complete linked node before the
  first frame write, then runs its postamble to finish the payload, commit the
  node, and return a default value; the runtime-exported
  `wpk_fork_unwind_end` is called once the top of the stack is reached.
- `REWINDING` — the stack is being rebuilt from saved frames. Each
  instrumented function loads its frame and jumps straight to the matching
  call site via switch-dispatch. Body chunks before the chosen post-call
  landing are skipped, so non-fork-path calls and side-effecting operations
  in those chunks do not re-run.

The host drives the state machine externally. User code never writes to
`_wpk_fork_state` directly.

## Exported ABI

The tool injects seven exports into every instrumented module. Names are
exact — they are part of the kernel ABI and tracked by the snapshot check
(see [abi-versioning.md](abi-versioning.md)).

```
wpk_fork_unwind_begin(buf: ptr) -> ()
  Precondition:  state == NORMAL
  Postcondition: state := UNWINDING
                 _wpk_fork_buf := buf
                 *(buf + 0) := buf + frames_start_offset
                 All mutable scalar globals snapshotted into buf.

wpk_fork_unwind_end() -> ()
  Precondition:  state == UNWINDING and all frames have been drained.
  Postcondition: _wpk_fork_buf := 0
                 state := NORMAL

wpk_fork_rewind_begin(buf: ptr) -> ()
  Precondition:  state == NORMAL (in a freshly-instantiated child)
  Postcondition: state := REWINDING
                 _wpk_fork_buf := buf
                 All saved mutable scalar globals restored from buf.

wpk_fork_rewind_end() -> ()
  Precondition:  state == REWINDING and all frames have been reloaded.
  Postcondition: _wpk_fork_buf := 0
                 state := NORMAL

wpk_fork_abort_begin(buf: ptr) -> ()
  Precondition:  state == UNWINDING after a typed frame-allocation failure.
  Postcondition: state := ABORT_UNWINDING
                 _wpk_fork_buf := buf
                 All saved mutable scalar globals restored from buf.

wpk_fork_abort_end() -> ()
  Precondition:  state == ABORT_UNWINDING and all committed inner frames
                 have been reloaded.
  Postcondition: _wpk_fork_buf := 0
                 state := NORMAL

wpk_fork_state() -> i32
  Returns current state. Exported for host-side assertions.
```

ABI 42 and later modules additionally import three exact `env` functions. A module that
imports any one of them must import all three and carry the linked-frame custom
section described below.

```
__wpk_fork_frame_reserve(frame_size: ptr) -> ptr
  Reserves a complete node and returns its payload address before any frame
  bytes are written.

__wpk_fork_frame_commit(payload: ptr) -> ()
  Publishes the pending node after the activation-owned payload is complete.

__wpk_fork_frame_next(expected_frame_size: ptr) -> ptr
  Returns the next committed payload during rewind and rejects size/order
  mismatches before generated code reads it.
```

The control exports identify the state-machine ABI, but they do not prove which
import seeded call-graph discovery. The tool therefore also emits the custom
section `kandelo.wpk_fork.capabilities`. Its two-byte payload is
`[version, flags]`; version 1 defines:

- bit 0 (`0x01`): the module was instrumented with `--entry env.fork`, so an
  `env.fork`-importing side module has complete side-entry coverage;
- bit 1 (`0x02`): a default-entry main module imported Kandelo's dynamic-linker
  functions and conservatively instrumented every `call_indirect` boundary
  plus its direct callers;
- bit 2 (`0x04`, `WPK_FORK_CAP_ACTIVATION_STATE_SAFE`): the instrumenter
  emitted and validated the complete ABI 43 activation, reference, exception,
  module-state, and table-reconstruction contracts required by a fresh module
  instance.

ABI 43 requires exactly one two-byte capability section, version 1, with bit 2
set. Unknown bits, missing/duplicate/malformed sections, or a missing safety bit
fail artifact validation before execution. Role bits retain their existing
meaning and are still required for side-entry and dynamic-linking replay where
applicable. The safety bit is not inferred from the seven control exports:
ABI 42 emitted those exports while still depending on module-instance
reference tables. A copied safety claim also cannot upgrade a normal ABI 42
program because the program ABI marker must match 43.

ABI 16/18 role-marker compatibility remains historical parser-test coverage;
it is not a launch fallback for an ABI 43 kernel. Changing the capability
encoding or meaning requires another ABI bump and regenerated snapshot.

### ABI 43 deployment and rebuild boundary

ABI 43 is an artifact epoch, not a host-only update. All fork-instrumented main
programs and side modules must be rebuilt with the ABI 43 instrumenter, then
the affected package archives, bottles, binary indexes, shell closure, and VFS
images must be regenerated against the new cache keys. Kernel, host, SDK/libc,
and generated ABI constants must ship as one coordinated set.

Do not republish ABI 42 artifacts with edited metadata or a copied capability.
The ABI 43 instrumenter refuses inputs that already contain fork control
exports, linked-frame imports, or fork metadata; builds must start from raw
linker output so the new validation sees the original activation and table
state.
The source package projection may be regenerated while developing this epoch,
but broad bottle/index/VFS publication requires explicit release coordination.
Reference-bearing modern C++ exception output and Dash's fork-reachable
`exnref` cleanup state are reconstruction inputs, not package-specific
exceptions. The ABI 43 source-build path now accepts those shapes through the
typed reference and complete-exception recipes. A development rootfs containing
the configured shell closure can therefore be rebuilt, but it is not a
published release artifact. Existing ABI 42 packages, indexes, shell
closures, and VFS images must still be rebuilt through their normal source
paths and must never be relabeled. Broad publication remains a separately
coordinated release action. See the [ABI 43 activation-state-safe artifact
rebuild plan](plans/2026-07-25-abi-43-activation-state-safe-rebuild-plan.md)
for the exact registry generation count, derived-image order, and ABI 42
package isolation boundary.

`ptr` is `i32` on wasm32 user programs and `i64` on wasm64 user programs. The
tool picks the pointer width from the module's primary memory — a memory64
memory yields `i64`, anything else yields `i32`.

`wpk_fork_unwind_begin` self-initializes `*(buf + 0)` with
`buf + frames_start_offset` before touching user state. In the linked format,
that initial address is the 16-byte abort selector inside the fixed prefix.
During linked unwind and rewind, generated code overwrites the word with the
payload address returned by the corresponding host hook. The host allocates
the root chunk and passes `root + chunk_header_size` as `buf`; no caller
computes or preallocates a worst-case frame-data footprint.

Every end export clears `_wpk_fork_buf` before publishing `NORMAL`. This
removes the module's stale alias when the host releases or reuses continuation
storage. Address zero is ordinary linear memory, so the clear is an ownership
invariant and defense, not a substitute for correct generated code: no
ordinary-execution path may dereference the buffer global.

## Host Threading Contract

The continuation belongs to the channel that issued `SYS_FORK`. For a
main-thread fork this is the process worker's channel, and the child enters `_start` before
`wpk_fork_rewind_begin` replays to the saved call site.

Each process worker or pthread worker owns a separate host-side continuation
object. This is load-bearing for pthreads: thread instances share linear
memory, but separately allocated mappings and per-worker replay cursors prevent
their unwinds from sharing frame storage.

For `fork()` from a pthread worker, the host must preserve the pthread entry
context as well as the buffer:

- `CentralizedKernelWorker` creates a host-side, one-shot
  `ThreadChannelAttachment` bound to the kernel's exact clone result.
  `attachThreadChannel(attachment, offset)` records that kernel-assigned
  identity, pthread entry table index, and userdata for the thread channel;
  host code cannot provide or substitute a PID/TID.
- `centralizedThreadWorkerMain` overrides `kernel_fork` for instrumented modules
  and drives `wpk_fork_unwind_begin` / `wpk_fork_state` /
  `wpk_fork_rewind_begin` around the pthread function, using
  a dynamically mapped root chunk. `channelOffset - FORK_BUF_SIZE` now stores
  only the active root address used by the kernel-worker fork handoff.
- `handleFork` passes one `ForkLaunchRequest` through the host `onFork`
  callback. Its discriminated continuation context always carries the exact
  linked-frame anchor. For pthread forks it additionally carries `fnPtr`,
  `argPtr`, and the caller's slot range. Node and browser hosts copy that
  authority into the child init message rather than deriving an address from
  the child channel layout.
- The same context carries the caller's exact dynamic pthread slot range
  (`slotStart`, `slotLen`). After the kernel clones the child process state,
  the host calls `kernel_reserve_host_region_at(childPid, slotStart, slotLen)`
  so the child retains only the calling thread's copied TLS/fork-save/channel
  pages.
- A fork child created from a pthread enters the saved pthread function from the
  indirect-function table instead of `_start`, then starts REWIND from the
  thread's copied buffer. `_start` is not in that call chain and cannot reach
  the saved fork site.
- That pthread entry function, argument, and buffer remain the child's
  continuation root until `exec` replaces the process image. If the child
  forks again first, the host propagates the same root and buffer to the
  grandchild; launching the grandchild at `_start` or rewinding the main-thread
  buffer would replay a call chain that was never saved.

The child does not inherit every parent pthread reservation. POSIX fork resumes
only the calling thread, so dead parent pthread slots become ordinary copied
memory bytes in the child and can be reused by later child `brk`, `mmap`, or
`pthread_create()` activity. Retaining the caller's one slot avoids having to
move the saved `__tls_base`, thread-local state, and fork-save buffer during
rewind.

This path is covered by `host/test/fork-from-thread.test.ts` (including a second
fork in the child before exec), `host/test/fork-instrument-coverage.test.ts`
P-06 (`pthread_create` worker calls `fork`), and K-03
(`pthread_cleanup_push` handler calls `fork`).

## Fork from a dlopened side module

Dynamic linking participates in the same process-wide activation protocol as
the main module. The supported stack is not limited to one main-to-side call:
the event journal records arbitrary main-to-side-to-side nesting, including
calls through shared-table function pointers and side-originated
`dlopen`/`dlsym`. Each participating module owns a separate linked
continuation; the journal supplies their exact leaf-to-root
activation/function order.

The ABI 43 POSIX `dlopen()` path deliberately separates host-owned
instantiation from guest initialization:

1. Libc reads the side-module bytes through ordinary file operations and calls
   `__wasm_dlopen_prepare`.
2. The process worker copies and validates the request, claims loader
   ownership, creates a private transaction, and returns its token without
   entering guest Wasm.
3. Each `__wasm_dlopen_next` advances host-only compilation/instantiation of
   the complete `DT_NEEDED` closure as needed, recording provisional module
   identities, memory/table bases, symbol visibility, dependency/provider
   edges, and rollback ownership. ABI 43 instrumentation has removed every
   native start section and converted active segments plus the original start
   function into an explicit bootstrap, so instantiation cannot enter that
   guest path. The call publishes at most one canonical `() -> ()` bootstrap,
   relocation, or constructor entry in a transaction-owned table slot and
   returns its index.
4. Libc calls that entry only after the import has returned. The initializer is
   therefore an ordinary Wasm-to-Wasm activation and may call another side
   module or `fork()`. The next host call acknowledges the completed stage and
   either returns another entry or atomically commits the public handle.

This staged path is non-reentrant: no host import calls back into Wasm before
returning. ABI 43 libc uses only the staged `prepare`/`next` path. Before call
graph discovery, the instrumenter also replaces either historical canonical
two-, four-, or five-argument `env.__wasm_dlopen` import in place with a local
adapter. Retaining the original function identity preserves direct calls,
exports, table elements, and `ref.func` aliases. The adapter prepares the load
and then tail-calls a generated driver; after the import has returned, that
driver invokes each initializer through the process function table and commits
the transaction. The original two-argument form had no pathname and retains
its deterministic historical `dlopen:<buffer-address>:<byte-length>` module
identity. ABI 43 host and publication guards require the legacy import count
and native start-section count to be zero, so stale or forged safety metadata
cannot expose either the monolithic callback or instantiation-time guest
reentry. Source modules may contain a start section; the zero-count rule
applies to the completed instrumented artifact after its start has become an
explicit bootstrap. `DynamicLinker.dlopenSync()` remains a lower-level embedder
API, not an import reachable from an accepted ABI 43 process artifact.

The staged host can issue internal VFS and mapping channel requests while an
import is active. Those completions set the ABI 43
`REQUEST_FLAG_DEFER_SIGNAL_DELIVERY` bit because process-worker JavaScript
cannot run libc's signal trampoline. The kernel leaves a caught signal pending,
and libc performs an ordinary `getpid` checkpoint after each staged import
returns and before it calls a guest initializer. Fork and clone use the same
ownership handoff. This preserves signal delivery without calling back into a
suspended Wasm import frame and adds no continuation or activation-frame
bytes.

Moving preparation behind a kernel syscall would not eliminate the
process-worker portion of loading. Core Wasm cannot compile arbitrary module
bytes or manufacture the fresh Store-local function, exception-tag, and GC
identities needed by the process table. Those JavaScript objects also cannot
be structured-cloned from the kernel Worker. The kernel may own pathname
authorization, process policy, and serialization, but the process Worker must
still instantiate and register each side module. A syscall-based loader would
therefore require a loader request/yield/resume protocol around the same
process-local work. It could replace the named loader import with the generic
syscall import, but it would not remove the host transition. Safety comes from
returning to Wasm before any initializer is called, not from which import
performs the process-local work. ABI 43 uses the smaller staged-import
protocol.

The main fork trampoline is captured before side exports enter the symbol
table, so a later extension cannot interpose the coordinator's `fork` target.
Failed loads may leave non-shrinkable null table gaps. Successful archive
events retain exact parent memory/table bases, handle values,
`RTLD_LOCAL`/`RTLD_GLOBAL` visibility, dependency/provider edges, and nested
transaction rollback state. A fresh child recreates modules in dependency
order, pads to and validates their exact bases, registers their function and
exception catalogs, and only then applies the process table journal and
activation replay.

Mutable Dylink `GOT.func` imports are part of that saved module state.
During fresh-child instantiation, the imported-global planner reads their
existing KFMS mutable-global snapshots and initializes each loader-owned
GOT cell with the exact parent table index. It does not search the
not-yet-restored main table and append a duplicate function. Duplicate
imports of one GOT symbol must carry identical saved values, and later
side-export publication must recreate the same index. A saved self-export
index also identifies any table gap created before the parent's export
publication; replay pads to that slot before installing the fresh export,
then the normal sparse table restore replaces the temporary graph. Missing,
wrong-width, or conflicting state fails before continuation replay. This is
a host reconstruction correction within ABI 43: it does not change the KFMS
wire format or require rebuilt guest artifacts.

Pthread workers have distinct Wasm instances, tables, tags, and Stores; no
JavaScript reference is copied between them. Each pthread therefore owns a
local dynamic-linker replica driven by the process archive's generation
journal. A host-private loader-owner lease serializes staged initialization
across workers, while a shorter archive lock publishes complete records.
Unchanged generations take a fast path. This supports `dlopen`/`dlsym` from a
pthread and `fork()` after dynamic loading; the fork child recreates the
calling thread's local replica and process module/table state.

For TLS-bearing side modules, each archive entry also preserves the live
positive `__tls_base`. Replay restores only that mutable global using the
process pointer type. It does not call `__wasm_init_tls`: the child memory copy
already contains live TLS, and reinitialization would overwrite C++ landing-pad
and application `thread_local` state. TLS-relative exports relocate from that
base, while `__tls_size` and `__tls_align` remain scalar constants.

Every participating module owns an independent linked continuation. Side and
main nodes may occupy several mappings and may contain a frame larger than one
WebAssembly page. The coordinator completes and validates both continuations
before it sends `SYS_FORK`.

### Borrowed vfork replay

A genuine vfork child cannot run ordinary copied activation or side-module
replay over the parent's live `Shared WebAssembly.Memory`. The ABI 43 vfork
path launches a fresh child Worker that validates the parent's process-wide
module-state arena as borrowed, rebuilds the complete activation registry, and
gives every active main or side activation its own child-private fixed prefix.
Replay reads the parent's committed frame nodes and recipe records but never
marks nodes consumed, releases mappings, clears the process launch anchor, or
deallocates the module-state arena. Failure midway through attachment detaches
every child controller so the suspended parent can replay the original
transaction.

Dynamic-linker reconstruction has a matching fail-closed mode. It accepts
only shared Memory, passive data segments, and a complete loader transaction.
For ordinary wasm-ld modules it suppresses only a start function exported as
`__wasm_init_memory`; an arbitrary start or active data segment is rejected
before instantiation. Complete replay does not invoke relocations or
constructors because the borrowed address space already contains the parent's
live initialized bytes. ABI 43 instrumented side modules already lower their
start and active segments into the explicit staged bootstrap described above.
An in-flight bootstrap, relocation, or constructor is rejected because guest
code at that boundary may write arbitrary shared process memory.

The ordinary mode remains copied fork replay and retains independent
address-space ownership. ABI 43 now distinguishes `kernel_fork(FORK)` from
`kernel_fork(VFORK)`, preserves the mode through unwind and replay, maps it to
`SYS_FORK` or `SYS_VFORK`, and carries it through the kernel and child-launch
protocol. Libc `vfork()` therefore no longer aliases the `fork()` wrapper or
runs `pthread_atfork` handlers.

The vfork mode connects those borrowed APIs to the production Node and browser
launch paths. It retains the parent's Memory, parks the calling thread, and
releases that caller only after successful exec commit or exact child
teardown. The child owns private replay, loader, channel, and continuation
control state even though its ordinary guest loads and stores address the
borrowed bytes. Broad conformance, pristine upstream CRuby selection,
and real resident-memory growth remain release gates
rather than properties inferred from component tests. A sibling-delivered
fatal signal against a compute-running borrower is tested separately: because
no browser Worker API provides an exact quiescence fence in that state, every
host contains the complete shared address space instead of resuming the
parent unsafely.

## Save buffer format

All values are little-endian and all records are eight-byte aligned. `P` is
pointer width (4 on wasm32, 8 on wasm64). Instrumented modules carry exactly
one 24-byte `kandelo.wpk_fork.linked_frames` custom section. Version 1 contains
the `KLCF` magic, descriptor size, pointer width, alignment, transactional-node
flag, chunk-header size, node-header size, and module-specific fixed-prefix
size. The host validates every field before instantiation.

Continuation storage consists of page-rounded anonymous process mappings. The
root starts with a chunk header, followed by the module's fixed prefix. Later
chunks contain only a chunk header and nodes. Version-1 chunk headers are:

| Offset | Size | Field | Purpose |
|---|---:|---|---|
| `+0` | 4 | magic | `KFCH` |
| `+4` | 2 | version | Linked format version |
| `+6` | 2 | flags | Zero in version 1 |
| `+8` | `P` | root | Root chunk address |
| `+8+P` | `P` | previous | Previous chunk, or zero |
| `+8+2P` | `P` | next | Next chunk, or zero |
| `+8+3P` | `P` | capacity | Mapped byte length |
| `+8+4P` | `P` | used | First unused byte |
| `+8+5P` | `P` | committed tail | Newest committed node; meaningful on root |

The module prefix retains the runtime's active-frame pointer word, a reserved
pointer word, saved scalar globals, and a 16-byte abort selector.
`frames_start_offset = 2P + N` identifies the selector, while the host-visible
fixed-prefix size is `frames_start_offset + 16`. Frame nodes and
tagged-catch activation state are not stored in that prefix.

The prefix is mutable during rewind. Each generated function preamble stores
the payload returned by `__wpk_fork_frame_next` in its active-frame word at
offset zero. A host controller that borrows another instance's frame chain
must therefore copy all `fixed_prefix_size` bytes to separately reserved
scratch, pass the scratch address to `wpk_fork_rewind_begin`, and keep frame
callbacks pointed at the borrowed nodes. Making only the host replay cursor
read-only is insufficient: passing the owner's prefix would overwrite the
owner's active-frame word. Borrowed replay must leave node states and mappings
untouched so the owner can later replay and release them. This is an internal
host invariant used by the connected ABI 43 `vfork()` path.

This does not introduce a new linked-frame encoding. `fixed_prefix_size` has
always been a module-specific value in the version-1 descriptor, and each node
already declares its function-specific payload size. Existing artifacts retain
and report their larger historical prefix; newly instrumented artifacts report
the prefix they actually use. Import/export names, descriptor fields, and host
parsing semantics are unchanged.

After sealing a vfork capture, the process Worker sums the aligned
`fixed_prefix_size` values for exactly the active activations. The reference
transaction separately reports the page-rounded scratch-capacity high-water
observed while the same generated codecs encoded the graph. Host-intercepted
`SYS_VFORK` carries those values in arguments 0 and 1. The centralized host
accepts at most one control slot: 61,440 prefix bytes and one 65,536-byte
scratch page. It returns `EAGAIN` before `kernel_fork_process` when either does
not fit. This is host transaction metadata, not a new linked-frame field, and
the admitted storage remains host-reserved rather than a copied child address
space.

At the first fork call, the host maps one page-rounded root large enough for
the chunk header and fixed prefix. Each postamble already knows its own exact
frame size and passes it to `reserve`; no extra frame-size-counting
instrumentation or whole-stack prepass is required. When the active chunk does
not fit the next complete node, the host maps another page-rounded chunk. A
single node larger than a WebAssembly page receives a multi-page chunk.

Allocation is transactional: a reserved node is not linked from the committed
tail until all activation-owned bytes are written. If a later chunk allocation
fails, the reserve import records the positive errno, enters
`ABORT_UNWINDING`, and returns a zero pointer. The still-live activation stores
only its call-site selector in the fixed-prefix scratch and restarts; already
committed inner nodes replay back to the original fork import. The import ends
abort replay, unmaps every owned chunk, restores `NORMAL`, and returns the
negative errno. Invalid metadata, impossible transitions, and cleanup failures
remain fatal integrity errors.

A root allocation failure occurs before `wpk_fork_unwind_begin` and therefore
returns its negative errno without replay. A negative `SYS_FORK` result after a
complete unwind uses the ordinary parent rewind and is likewise returned to
the guest; neither case terminates the parent or creates a child.

The child receives the mappings through the normal process-memory copy and the
kernel's inherited mmap metadata, at the same virtual addresses in version 1.
Parent and child independently walk and unmap their copies after rewind. The
linked format makes chunk boundaries explicit, but version 1 does not rebase
internal pointers or relocate the chain in the child.

Mutable reference globals (`funcref`, `externref`, `exnref`, and typed GC
references) are not stored in the scalar linear-memory header. Generated
module-state helpers encode them into the process reference graph during
capture and restore them in the fresh activation before any continuation frame
executes. Immutable imported references use the same activation/template
catalog during early instantiation. A global outside the fork closure remains
ordinary Wasm state and does not pay activation-frame overhead.

## Frame format

Each instrumented function has a statically known payload size. The size
depends on its scalar user locals and instrumenter-owned frame locals, but the
payload header is uniform. Each payload is preceded by a linked-node header:
`KFCN` magic,
format version, transactional state, previous-node pointer, payload size, and
total aligned node size. That header costs 24 bytes on wasm32 and 32 bytes on
wasm64 before alignment.

| Offset | Size | Field                      | Purpose |
|--------|------|----------------------------|---------|
| `+0`   | 4    | `func_index`               | Ordinal assigned at instrument time |
| `+4`   | 4    | `call_index`               | Which call site within the function |
| `+8`   | 4    | exact catch selector       | Zero outside reconstructed catch flow; otherwise the exact region/arm |
| `+12`  | 4    | reference-vector ordinal   | Process-transaction recipe vector for this landing; zero when none |
| `+16`  | var  | `saved_scalars[]`          | User/synthetic scalars and scalar catch payload union, aligned |

References are deliberately not copied into the frame and never name a
module-static stash slot. Existing live reference locals and parameters are
encoded into a call-specific process recipe vector; the frame owns only the
ordinal in its existing header word. Definitely-null values need no recipe.
The child decodes each recipe against its own activation, function/static-root
catalog, imported-global owner, GC layout, exception codec, or durable
externref owner.

This constant-per-frame reference representation is a stack-depth requirement,
not only a space optimization. The standalone PR #701 V8 reproducer measured
an instrumented recursive function falling from 9,959 surviving calls to 6,639
when its declaration grew from four to twelve locals. PR #713 reduced the
generated-local count to eight and recovered 8,536 calls in the same
measurement context; PR #714 replayed pure scalar inputs and restored the
fixture's original four-local declaration. ABI 43 therefore does not add a
generated local or linked-frame field per live reference, recipe, catch arm, or
catch region. Reference-vector entries live in the process transaction arena,
and catch scratch is pooled by simultaneously live type/width rather than
static source count. Absolute engine limits remain platform- and tier-specific,
so these historical measurements are constraints on generated shape, not a
current performance claim.

Synthetic scalar locals include only call arguments and operand-stack
carryovers that cannot be replayed directly. Catch code uses one exact-arm
selector per function and one typed operand-scratch union sized to the maximum
simultaneously selected payload, not one tuple per static arm or region.
Reference-bearing and untagged exceptions are retained through the complete
exception recipe and do not add linked-frame payload bytes. Rewind either
rethrows a saved scalar tag payload or asks the exception codec to materialize
the complete exception before the original `Catch`, `CatchRef`, `CatchAll`, or
`CatchAllRef` control path resumes.

Rewind also avoids inserting a no-argument resume thunk in front of every
materialized direct activation. When the event journal proves that the next
activation is the direct lexical callee, the caller executes the original call
with its reconstructed arguments; the callee preamble validates the expected
activation and function through `frame_next` before consuming it. A universal
thunk would add a second native engine frame for each recursive Wasm
activation and can exhaust the engine stack well before the continuation
chain is exhausted. Indirect/reference calls, cross-module or
tail-transparent boundaries, and targets whose lexical identity is not proven
still use the process resume catalog. The lexical fast path adds no
ordinary-activation local and no continuation bytes; its second
non-consuming event lookup runs only during replay.

## Dispatch schemes

Every fork-path function uses **one of two dispatch shapes**, chosen by the
tool per-function based on call-site topology:

| Scheme                       | When picked                                                                                                                                                                                                                                                                                                                       | How replay reaches the resumed call                                                                                                                                                                                            |
|------------------------------|-----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| switch-dispatch (top-level)  | Every fork-path call lives at the function's top level. Top-level operand-stack carryovers (values pushed before the call's args and consumed after — common in LLVM `*(sp+K) = call(...)` patterns) are absorbed via per-call spill locals (sub-commit 2.4c). Pure scalar call-argument tails can be replayed instead of spilled. | A top-level `br_table`, gated by `state >= REWINDING`, jumps directly to the matching `$POST_K` label for ordinary or abort replay. The chunks between calls run only on the NORMAL fall-through path; carryover spill locals are reloaded in the post-call, followed by spilled or replayed call args. |
| switch-dispatch (nested)     | Some fork-path calls live inside `Block` / `IfElse` / `Loop` / `TryTable` bodies. Sub-commits 2.5/2.6 made this scheme cover: direct-call carryovers at any nesting depth (2.5c), nested-Loop-with-carryover (2.5c side benefit), multi-value-params SubRegion bodies via body-input-param prespill (2.6c). Pure scalar direct-call args and condition-only `IfElse` carryovers can be replayed instead of spilled. | Cascading `POST_K` blocks plus a per-region `br_table` route ordinary or abort replay through each enclosing instruction's own dispatch — see [Nested per-block switch-dispatch](#nested-per-block-switch-dispatch). For multi-value-params bodies, the body's input params are pre-spilled at body entry and reloaded inside POST_0 to bridge the `Simple(None)` POST_K typing. |

A third path — **guard-dispatch** — existed before commits 3-4 of the
fork-instrument mega-PR (2026-05-14). It wrapped each fork-path call site
in an in-place `state == NORMAL || (state == REWINDING && call_idx == N)`
if-else and gated every side-effect op in the body so it didn't re-fire
during REWIND's linear body replay. After:

- sub-commit 2.5c absorbed direct-call carryovers into nested switch-dispatch,
- sub-commit 2.6c absorbed multi-value-params SubRegion bodies,
- commit 9 (modern wasm-EH SDK flip) removed legacy `try`/`catch` from shipping wasm,
- the post-9 follow-up generalised `compute_carryover_types` to `Option<ValType>`,

all five conditions that previously forced guard-dispatch were closed.
Commit 3 replaced the two `instrument_one_function_guard_dispatch` call
sites in `instrument_one_function` with `panic!()` so any shipping binary
that still triggers the deleted path (e.g., hand-written legacy-EH wasm,
or LLVM output with unknown-type producers in a carryover) fails loudly
with a message naming the function. Commit 4 deleted the
`instrument_one_function_guard_dispatch` implementation and its ~838-line
helper graph.

Both shapes share:

- The state machine, exported ABI, and save-buffer header.
- The per-function frame layout (header + scalar locals).
- Activation-owned tagged-catch arm and scalar payload state.
- Catch-handler reconstruction by throwing the saved static tag.

Switch-dispatch avoids the need for per-call gating: no chunk before the
chosen `POST_K` runs on REWIND, so non-fork-path calls and side-effect ops
in those chunks never re-execute by construction. The previous Phase 4g
side-effect gating and Phase 4c non-fork-path call gating are no longer
needed.

The tool's `instrument_one_function` (in `crates/fork-instrument/src/instrument.rs`)
inspects the original body, runs `classify_nested_pattern` to decide
whether the per-region transform applies, and routes to either
`instrument_one_function_nested_switch` or `instrument_one_function_switch`
accordingly.

Indirect calls (`call_indirect`) are treated as fork-path landings when they
may dispatch to a fork-path-reachable callee in the same table with the same
signature. Discovery is table-aware: active element segments populate their
own table, passive segments count only for tables that can receive them via
`table.init`, and declared segments do not count as table initializers.

To keep dynamic interpreter/function-pointer-heavy runtimes resource-safe,
indirect closure is bounded to two dispatch hops. Direct callers of functions
found through those hops are still included. This covers normal C callback
fork paths and QuickJS's C-function trampoline shape
(`JS_CallInternal -> js_call_c_function -> js_os_exec`) without turning one
generic dispatcher into whole-runtime instrumentation. A program whose only
fork path requires three or more nested function-pointer dispatches is outside
the current static-discovery guarantee and needs a more precise value-flow
analysis before it can be supported safely.

## Per-function transform — before/after WAT

The tool applies a per-function transform that depends on the dispatch
scheme described above. The following pairs show representative fixtures
from `crates/fork-instrument/tests/instrument.rs` and
`crates/fork-instrument/tests/switch_dispatch.rs`. The transformed WAT is
simplified for readability; the actual output includes linked-node hook calls,
default values for result types, and preserved source locations.

> **Note (post-commit-4):** Examples (a) and (c) below describe the
> pre-2.5/2.6 guard-dispatch shape, which was deleted in commit 4 of
> the fork-instrument mega-PR (2026-05-14). Real LLVM-emitted C now
> goes through switch-dispatch (top-level or nested). The historical
> shape is preserved here because (a) some test fixtures still
> describe the wrapping semantics for documentation purposes, (b) the
> state-machine / preamble / postamble structure is shared across all
> dispatch schemes, and (c) the catch-handler resume in §(b) is still
> the live mechanism. For current switch-dispatch examples, see the
> fixtures under `crates/fork-instrument/tests/fixtures/switch_dispatch/`
> and the assertions in
> `crates/fork-instrument/tests/switch_dispatch.rs`.

### (a) Direct call to `fork` with no locals

Fixture: `FIXTURE_DIRECT_CALLER` in `tests/instrument.rs` (see
`wrapper_replaces_call_with_state_gated_if`). Before instrumentation:

```wat
(func $caller (result i32)
  call $fork)
```

After instrumentation (abridged):

```wat
(func $caller (result i32)
  ;; [1] Preamble: if REWINDING, load our frame and jump to matching call.
  (if (i32.eq (global.get $_wpk_fork_state) (i32.const 2 (; REWINDING ;)))
    (then
      ;; Request the next committed payload, then restore frame fields and
      ;; locals. call_index remains in the frame payload header.
      ...))

  ;; [2] Body wrapper: runs on NORMAL; on REWINDING, dispatch jumps to
  ;;     the matching post-call site using frame.call_index.
  (block $unwind_save
    (block $POST_0
      (block $dispatch_normal
        (if (i32.eq (global.get $_wpk_fork_state) (i32.const 2 (; REWINDING ;)))
          (then
            ;; Load frame.call_index from *(buf + 0) + 4.
            ...
            (br_table $POST_0 $unwind_save))))
      ;; chunk 0 would run here on NORMAL only.
    )
    ;; [3] Wrapped call site.
    call $fork
    ;; [4] Post-call unwind check: if callee returned in UNWINDING,
    ;;     write frame.call_index and jump to postamble.
    (if (i32.eq (global.get $_wpk_fork_state) (i32.const 1 (; UNWINDING ;)))
      (then
        ;; *( *(buf + 0) + 4 ) = 0
        ...
        (br $unwind_save)))
    (return))

  ;; [5] Postamble: finish writing the already-reserved node's frame header
  ;;     and serialized locals, commit it, then return a default result.
  ...
  (return (i32.const 0)))
```

Numbered callouts:

1. **Preamble (Phase 4d).** Every instrumented function opens with a state
   test. Under `REWINDING`, the preamble calls
   `__wpk_fork_frame_next(frame_size)`, stores the returned payload in
   `*(buf + 0)`, and deserializes every frame scalar: user locals,
   argument/carryover spills, and tagged-catch activation state. Dispatch reads
   `call_index` directly from that active frame payload.
2. **Body wrapper (Phase 4b/4c).** The original body is wrapped in a `$unwind_save`
   block. On `REWINDING`, a `br_table` keyed by `frame.call_index` jumps to
   the selected post-call landing. On `NORMAL`, dispatch falls through and
   executes the original chunks.
3. **Wrapped call site (Phase 4c).** The original call is kept intact. After
   the call returns in `UNWINDING`, the tool reserves the function's complete
   frame node before its first write, stores the returned payload pointer in
   `*(buf + 0)`, and writes the call site's `call_index` to `frame[+4]`.
4. **Unwind bridge (Phase 4c/4d).** The unwind-only branch writes
   `frame.call_index` and exits `$unwind_save`. If the callee did not begin
   unwinding, execution continues normally.
5. **Postamble (Phase 4d).** Emits the remaining frame header fields
   (`func_index`, `catch_region_id`, and a zero reserved word), writes every
   user and synthetic frame scalar, commits the reserved node, and returns a
   default value of the function's result type. Callers see the default on the
   unwind path but discard it because their own postamble runs next.

### (b) Fork from inside a catch handler

Fixture: `FIXTURE_FORK_FROM_CATCH_HANDLER` (see
`fork_from_inside_catch_handler_full_roundtrip`). Before instrumentation:

```wat
(func $caller (result i32)
  (local $caught i32)
  (block $handler (result i32 exnref)
    (try_table (result i32 exnref) (catch_ref $exn $handler)
      i32.const 7
      throw $exn))
  drop
  local.set $caught
  call $fork)
```

After instrumentation the `CatchRef` clause targets an injected capture block
and the try_table body gets a rewind-throw stub. The exact emitted nesting is
omitted here; the important dataflow is:

```wat
;; Inside the original try_table body:
(if (i32.and
      (i32.ge_u (global.get $_wpk_fork_state) (i32.const 2))
      (i32.eq (local.get $catch_region_id) (i32.const 1)))
  (then
    (if (i32.eq (local.get $active_arm) (i32.const 0))
      (then
        ;; The frame restored 7 (or the actual scalar payload).
        local.get $saved_payload
        throw $exn)
      (else unreachable))))

;; On CatchRef dispatch, stack = (i32 payload, non-null exnref):
local.set $temporary_exnref
local.set $saved_payload
i32.const 0
local.set $active_arm
i32.const 1
local.set $in_catch
i32.const 1
local.set $catch_region_id

;; Forward the original handler values, but retain no synthetic GC root.
local.get $saved_payload
local.get $temporary_exnref
ref.as_non_null
ref.null exn
local.set $temporary_exnref
br $handler
```

Numbered callouts:

- **Rewind-throw stub.** On replay with a matching `catch_region_id`, dispatch
  validates the restored arm index, pushes that arm's restored scalar payload,
  and executes `throw $tag`. The original `CatchRef` clause catches this new
  exception and creates a fresh exnref in the child instance.
- **Capture block.** Every statically tagged `Catch` and `CatchRef` clause is
  retargeted through a per-arm capture. It stores only the arm index and scalar
  payload in frame-backed locals. A `CatchRef` exnref is temporarily forwarded
  to the original handler; the synthetic local is nulled before the branch so
  successful replay and abort paths do not retain a stale GC root.
- **Call-site region writes.** A call inside the handler observes the
  activation-local `$in_catch_K` flag and records the lexical region in the
  frame before unwinding. There is no reference slot or module-global
  reference state.

### (c) Indirect fork through `call_indirect`

Fixture: `FIXTURE_INDIRECT` (see `call_indirect_is_wrapped_with_index_as_top_arg`).
Before instrumentation:

```wat
(func $caller (result i32)
  i32.const 0
  call_indirect (type $sig))
```

After instrumentation the wrapper shape is identical to the direct-call case,
with one addition: the table index is spilled to a synthetic local before the
state-check condition runs, and restored inside the then-branch immediately
before the `call_indirect`.

```wat
(func $caller (result i32)
  ;; ... preamble ...
  (block $unwind_save
    (i32.const 0)                 ;; original table index expression
    (local.set $arg_idx_0)        ;; [3a] spill arg before gate
    (if (<state-gate condition>)
      (then
        (local.get $arg_idx_0)    ;; [3b] restore arg before call
        (call_indirect (type $sig))
        (if (<unwinding check>)
          (then
            ;; frame.call_index = 0
            (br $unwind_save))))
      (else
        (i32.const 0)))           ;; default i32 for the call's result
    (return))
  ;; ... postamble ...)
```

Callouts:

- **Phase 3 closure.** Before instrumentation runs at all, call-graph
  discovery walks every `call_indirect` reachable from the fork seed, looks
  up the call's type signature, and adds every table-reachable function with
  a matching signature to the fork-path set. The wrapper sees indirect calls
  with the same shape as direct calls: one additional top-of-stack i32 arg
  (the table index) on the wasm32 side.
- **3a / 3b — Arg spill.** All call-site arguments (including the indirect
  table index) are spilled to synthetic scalar locals before the gate
  condition runs, so the operand stack is empty at the gate boundary and the
  else-branch can supply typed defaults.

## Nested per-block switch-dispatch

Top-level switch-dispatch only fires when every fork-path call is at the
function's entry-block depth. Real LLVM-emitted C — popen's `__fork`,
`posix_spawn`, FPM's child-spawn, and many libc paths — keeps fork-path
calls inside a `block` / `if` / `loop` / `try_table`, which would force
those functions into guard-dispatch. The popen-class hangs investigated
in `memory/fork-instrument-O2-bug-investigation.md` (external memory)
showed that guard-dispatch's body-replay diverges from NORMAL flow on
LLVM-O2-shaped inputs, even with non-fork-path call gating: the kernel_fork
wrap can be skipped entirely if a control-flow gate reads a different value
on REWIND than on NORMAL.

`instrument_one_function_nested_switch` extends switch-dispatch to nested
fork-bearing regions so those functions never enter guard-dispatch. Two
ideas combine:

### 1. Cascading POST blocks per region

`partition_region_instrs` (in `crates/fork-instrument/src/instrument.rs`)
splits each fork-bearing seq into chunks separated by **landings**. A
landing is one of:

- **DirectCall** — a direct fork-path `Call` or any `CallIndirect` at this
  seq's level. Same shape as classic switch-dispatch.
- **SubRegion** — a `Block` / `Loop` / `TryTable` whose body is
  fork-bearing. The enclosing instruction is preserved verbatim and the
  per-region `br_table` lands the function-level `call_idx` *just before*
  it; the sub-region's own internal dispatch (built bottom-up by recursive
  invocation of the same transform) routes the rest of the way.
- **SubRegionIfElse** — an `IfElse` whose `then` and/or `else` branches are
  fork-bearing. Both branch ranges are recorded so the cond rewrite (below)
  can pick the active branch on REWIND.

The function-level `br_table` maps each `call_idx` to either a direct
`POST_K` (top-level call) or a `POST_J_ENTER` label positioned right before
a sub-region landing. Sub-regions then dispatch internally via their own
`br_table` over the call_idxs that fall in their range.

### 2. IfElse cond rewrite via `select`

The standard top-level `POST_K` block has type `Simple(None)` (0 → 0).
That's incompatible with an `IfElse` landing because the chunk preceding
the IfElse has to leave the original cond on the stack. The default fix:

- At the end of the chunk inside `POST_K`, spill the original cond into a
  freshly-allocated i32 local, `cond_swap_local`.
- After `POST_K` closes, synthesize a replacement cond using a wasm
  `select`:

```wat
;; chunk leaves orig_cond on the stack, then:
local.set $cond_swap         ;; spill — handled by emit_chunk_tail_for_landing.
end                          ;; close POST_K (Simple(None) is satisfied).

;; post-landing sequence — re-create cond for the IfElse:
push force_flag              ;; 1 if active call_idx in THEN's range, else 0.
local.get $cond_swap         ;; re-push orig_cond.
push (state >= REWINDING)    ;; ordinary or abort replay
select                       ;; (is_rewind ? force_flag : orig_cond)
if (then ...) (else ...)     ;; original IfElse, untouched.
```

`force_flag` discrimination:

- only THEN has fork-path calls → `i32.const 1`
- only ELSE → `i32.const 0`
- both branches → range-membership test on THEN's call_idx range
  (`call_idx >= then_lo && call_idx <= then_hi`)

On NORMAL the rewritten cond evaluates to `orig_cond`, preserving the
program's semantics. On REWIND it forces entry into whichever branch
contains the active call_idx, regardless of `orig_cond`. This avoids
re-evaluating the original cond expression during REWIND — important when
that expression has side effects or reads state that may diverge between
parent NORMAL and child/parent REWIND.

When the original condition is produced by a pure scalar suffix such as
`local.get $depth; i32.eqz`, the suffix is removed from the NORMAL chunk and
replayed in the post-landing sequence instead of allocating `cond_swap_local`
or a frame-backed carryover local. If the condition is not pure, or if an
`IfElse` landing also needs extra carryover values below the condition, the
spill-local path above remains the fallback.

### 3. Carryover-spilling at SubRegion + DirectCall landings

LLVM at -O2 inlines `posix_spawn` into `main` (and similar patterns
elsewhere) and emits a single i32 pushed *before* a fork-bearing block
that's consumed *after* it. The
`os-test/basic/spawn/posix_spawnattr_setpgroup` -O2 fixture is the
canonical instance:

```wat
local.get 0           ;; push __errno_location() — the carryover.
block (result i32)    ;; the block contains kernel_fork.
  ... kernel_fork wrap ...
end
local.tee 1
i32.store             ;; consumes both: *errno_location = posix_spawn_rc.
```

`POST_K` is `Simple(None)` (0 → 0), so the chunk before the SubRegion can't
leave anything on the stack. The fix is to spill the carryover into a
fresh **frame-resident** local at the chunk tail, then reload it BEFORE
the enclosing instruction runs (sub-commit 2.6a — push-before order
replaces the earlier push-after + tmp-result-juggle):

- `CarryoverPlan` holds `spill_locals: Vec<(LocalId, ValType)>`, ordered
  deepest-stack-first. All locals are appended to the function's frame so
  they get serialized on UNWIND and restored on REWIND, matching every
  other scalar user local.
- `emit_chunk_tail_for_landing` pops each value off the operand stack via
  `local.set`, top-of-stack-first, into the spill locals. Net stack effect
  of the chunk inside `POST_K`: 0 → 0, satisfying `POST_K`'s type.
- The post-landing sequence pushes spill_locals[0..] back onto the stack
  in order BEFORE emitting the enclosing instruction. The SubRegion's
  type-params (at the top of the post-push stack) are consumed by the
  instruction; any extra carryover beneath stays intact and ends up below
  the SubRegion's result on exit — matching the original semantics WITHOUT
  needing a tmp_result_local juggle.

The same machinery applies to **DirectCall landings inside nested seqs**
(sub-commit 2.5b/c). At each fork-path call site inside a non-entry seq,
per-call carryover spill locals (allocated from
`compute_nested_carryover_types`, keyed by call_idx) round-trip the
carryover values across UNWIND/REWIND.

The SubRegion spill list is computed by `analyze_subregion_spill_types`
(sub-commit 2.6a; replaces the older `analyze_carryover_depths`), which
tracks the typed operand stack as `Vec<Option<ValType>>` and reports the
full list of values to spill per landing — covering both the SubRegion's
declared type-params AND any extra carryover above them on the parent
stack. The current analyser covers scalar, vector, reference/GC, direct,
indirect, and `call_ref` producers as well as multi-value structured-control
parameters and results. Scalar/vector spill locals join the linked payload;
reference spills join the landing's process recipe vector.

**Multi-value-params bodies (sub-commit 2.6c).** When a SubRegion is a
multi-value `Block`/`Loop`/`TryTable` whose body uses its declared input
params, the cascading POST_K blocks can't expose those params to inner
chunks (POST_K is `Simple(None)`, so the wasm validator forbids reading
from outside its scope). The fix: at body entry, pre-spill the params to
fresh function-local locals; in POST_0's body (just before chunks[0]
runs), reload them via prepended `local.get`s. On NORMAL flow the body
params are saved and reloaded; on REWIND the dispatch br_tables past
chunks[0], so the LocalGets are skipped — exactly the cases where the
params would otherwise be needed.

### 4. Pure scalar materialization

Before allocating call-argument or sub-region carryover locals, the transform
checks whether the values at the landing are produced by a suffix that can be
replayed from an empty stack. The whitelist is deliberately small:

- scalar constants and scalar `local.get`;
- non-trapping i32/i64 unary ops such as `eqz`, `clz`, `ctz`, `popcnt`, and
  integer extends;
- non-trapping i32/i64 binary arithmetic, bit operations, shifts, rotates, and
  integer comparisons.

The materialization whitelist excludes calls, memory/table operations, globals,
reference operations, integer div/rem, floating-point operators,
`local.set`/`local.tee`, and any instruction that needs stack input from before
the suffix. A suffix outside that replay-safe optimization is still supported:
the typed spill/recipe path preserves it instead. This keeps REWIND behavior
tied to the same post-call/post-landing sequence while avoiding frame locals
for common compiler shapes like recursive `walk(depth - 1)` arguments and
`eqz(depth)` branch conditions.

**Function-level analyser invariant.** `walk_seq_for_carryovers`,
`compute_carryover_types`, and `compute_nested_carryover_types` must determine
the exact pushed types for every valid producer that reaches a fork landing.
An unknown slot consumed earlier is irrelevant; an unknown live carryover is an
instrumenter typing defect to fix, not an accepted source-program limitation.
There is no guard-dispatch fallback after the mega-PR cleanup.

## Reference and table-state ownership

ABI 43 retires `_wpk_fork_funcref_stash`,
`_wpk_fork_externref_stash`, and `_wpk_fork_exnref_stash`. The tool never
emits them. Static slots were unsafe twice over: recursive/reentrant
activations could alias, and every fork child starts from a fresh module
instance whose tables are empty. JavaScript cannot generically transfer
`funcref`/`externref` across workers or Stores, and the Table API cannot copy
`exnref`.

Closure and liveness analysis runs before rewriting so functions wholly outside
the fork closure remain untouched. Within a live activation, the generated
representation is selected by value class:

- scalar locals, parameters, arguments, and carryovers use the linked frame;
- `funcref` values use an activation-scoped immutable function catalog;
- static references use the fresh instance's static-root catalog;
- concrete and abstract GC references use versioned typed struct/array/i31
  recipes with graph identity established before recursive fields, preserving
  cycles and aliases;
- externalized GC values pass through Wasm's `any.convert_extern` /
  `extern.convert_any` bridge so their typed identity is not mistaken for an
  opaque host object;
- opaque `externref` values use a process-image owner handle. Each Worker has a
  generation-branded canonical token; imports resolve the token at the owner
  boundary rather than transferring the JavaScript object;
- complete Wasm/JSTag exceptions use an exception recipe whose payload
  references the same process graph.

Reference-bearing function signatures, `call_ref`/`return_call_ref`, nullable
and non-null concrete types, reference arguments/results, and reference
operand-stack carryovers all use those same recipes. A fresh child materializes
providers first, restores module state second, then consumes continuation
frames. Capture, successful replay, abort replay, process-image replacement,
and worker teardown clear transaction-local tables and leases so
instrumentation does not retain stale GC roots.

Constructor provenance is recreated as part of typed GC materialization.
Immutable arrays and mutable aggregates with non-defaultable reference seeds
cannot always be allocated from their final field snapshot alone, so the
recipe records the exact constructor layout, up to sixteen scalar operand
bytes, and typed seed edges. The generated allocate helper registers that same
weak provenance for the fresh child object before releasing its staging
record. Consequently a child can fork again and reconstruct an equivalent
grandchild; it never needs a weak-map entry keyed by the parent's Store-local
object. Nullable constructor seeds, including the unobservable seed of a
zero-length array, remain canonical recipe zero.

Mutable reference globals and tables are module-state, not activation-frame
fields. Generated KFMS helpers save mutable globals, table length, sparse dirty
pages, element/data segment lifetime, and typed entries. Static initialization
is recreated by instantiation; runtime `table.set`, `table.fill`, `table.copy`,
`table.init`, and `table.grow` effects are restored from the process-owned
state. A generation-published table journal brings pthread replicas to the
same state before indirect/table-reference use. The dynamic-link archive first
recreates side modules at their exact memory/table bases and registers their
function catalogs; table-state replay then resolves entries against those
fresh functions. Publication writes records before the generation fence, so a
reader can never treat a partially initialized recipe as current.

## Catch-handler resume

Catch-handler resume saves a reconstruction recipe, never a parent-instance
exception reference. Normal handler entry records one function-wide exact
region/arm selector. A statically tagged scalar arm stores its tag payload in a
typed scratch union that overlays the maximum active tuple in the linked frame.
Rewind dispatches inside the same `try_table` body, restores the selected tuple,
and executes the selected arm's `throw $tag`. Normal Wasm exception dispatch
reaches the original clause; `CatchRef` receives a new exnref owned by the child
instance.

Reference-bearing tag payloads, vector payloads, `CatchAll`, `CatchAllRef`, and
legacy-EH cleanup handlers use the complete-exception codec. The codec retains
the caught value only for the activation lifetime needed to encode its recipe,
then reconstructs and throws it inside Wasm during replay. It never asks
JavaScript to return an `exnref`.

```
┌────────────────────────────────────────────────────────────────────┐
│ Parent execution (before fork)                                     │
│                                                                    │
│   try_table (catch_ref $tag $handler):                             │
│     callee_that_throws()                   ← throws tag X          │
│   → $handler                                                       │
│     handler_code                                                   │
│       fork()                               ← unwind begins here    │
│       more_handler_code                                            │
└────────────────────────────────────────────────────────────────────┘
                        │
                        │  unwind: save region K, arm A,
                        │          and scalar tag payload in this frame,
                        │          drain frames to top.
                        ▼
┌────────────────────────────────────────────────────────────────────┐
│ Child instance created, memory copied, rewind begins               │
│                                                                    │
│   main() preamble:                                                 │
│     state == REWINDING, load our frame                             │
│                                                                    │
│   try_table body rewind-throw stub:                                │
│     state == REWINDING && catch_selector == (K, A) →               │
│       validate arm A; push saved scalar payload; throw $tag_A      │
│     ← caught by the original Catch/CatchRef clause; CatchRef       │
│       creates a fresh child-instance exnref.                       │
│                                                                    │
│   handler-level preamble (state still REWINDING):                  │
│     resume at the fork() call site with return value = child pid 0 │
│                                                                    │
│   state := NORMAL, execution continues                             │
└────────────────────────────────────────────────────────────────────┘
```

Mixed `Catch`/`CatchRef` lists, multiple arms, distinct target labels,
`CatchAll`/`CatchAllRef`, reference-bearing payloads, recursion, loop re-entry,
and catches followed by an ordinary merged fork all use the same exact
activation selector and process recipe graph. An unknown selector, malformed
recipe, stale process generation, or catalog mismatch traps before child code
can consume partial state; replay cannot fall back to old instance state. See
[Fork from a tagged catch](#fork-from-a-tagged-catch) under "Maintainer notes"
for the implementation.

## Call-graph discovery

Instrumentation only rewrites functions that can transitively reach a seed
import. There are two seeds. `--entry` names the fork boundary and defaults to
`kernel.kernel_fork`. `--checkpoint-entry` names a second boundary and adds to
the first rather than replacing it; `scripts/install-local-binary.sh` passes
`kernel.kernel_checkpoint` for every package it instruments, so a program that
never forks is still covered at its syscall returns. The discovery algorithm in
`crates/fork-instrument/src/call_graph.rs`:

1. Seed set `S` = { each named seed import present in the module }.
2. **Direct reverse closure.** For every newly discovered callee `g`, add
   every local function that directly calls `g`.
3. **Indirect reverse closure.** If `g` can be dispatched from a function
   table, add every local function that performs `call_indirect` or
   `return_call_indirect` against the same table with a structurally matching
   function type.
4. Repeat steps 2–3 until the worklist is empty.

The output is a function-set `S` that gets instrumented. All other functions
pass through unmodified.

The host-parsed marker exports `__abi_version`,
`__wasm_posix_thread_slots`, and `__get_channel_base_addr` also remain
unmodified even if call-graph discovery includes them in `S`. The host reads
their wasm-ld wrapper bodies directly and does not use them as fork
continuation roots.

The indirect-call step is a may-analysis, but it is slot-sensitive when the
Wasm proves enough facts. Active element segments with constant offsets
populate known table slots. A `call_indirect` whose table index is a literal
`i32.const` or a folded constant `i32.add`/`i32.sub` expression can dispatch
only to that slot, so a same-signature fork-path target in a different slot
does not pull in the caller. Dynamic indexes remain conservative: if the table
contains a matching fork-path target anywhere, the caller stays in `S`.

Unknown table state also remains conservative. Passive segments count only for
tables that can receive them via `table.init`; because the destination range is
not modeled, their functions are table-wide. Declared segments do not populate
a table. Dynamic table writes (`table.set`, `table.fill`, `table.grow`) make
the table unknown, so any matching-signature fork-path target may be reachable.
`table.copy` propagates known and unknown source-table state to the
destination.

This is enough for registered callback paths such as signal handlers, pthread
cleanup handlers, `atexit` handlers, and qsort-style comparators in the current
libc output. The broader "instrument every address-taken function" rule from
the original C3 plan was not needed for this PR and was not added; K-01, K-02,
K-04, and K-07 cover the current behavior.

## Guarantees and non-guarantees

### Guaranteed

- **Call stack.** Every fork-path function's call stack position is
  serialized as a frame (func_index + call_index) and reconstructed during
  rewind. The child resumes at the exact call site from which the parent
  invoked `fork()`.
- **Scalar user locals.** All i32, i64, f32, f64, and v128 locals on the
  fork-path are saved to linear memory at unwind and restored at rewind.
- **Fresh-instance ownership.** Every accepted replay value is either scalar
  activation state in the linked continuation or state rebuilt by an explicit,
  versioned reconstruction owner. Instrumented modules carry
  `FORK_CAP_ACTIVATION_STATE_SAFE`; ABI 43 hosts and artifact guards reject a
  fork-shaped artifact without that capability before execution.
- **Byte-reproducible instrumentation.** Given the same input bytes, CLI
  options, and built tool, separate processes emit byte-identical Wasm.
  Synthetic locals and nested regions are assigned in canonical sequence-ID
  order rather than randomized hash-map iteration order.
- **Mutable scalar globals.** Snapshotted in
  `wpk_fork_unwind_begin` and restored in `wpk_fork_rewind_begin`.
  Includes `__stack_pointer`, `__tls_base`, and any program-declared
  mutable globals.
- **Reference activation state.** Live reference locals, parameters,
  reference call arguments/results, call-ref callees, and operand-stack
  carryovers are represented by typed process recipes and decoded into the
  fresh activation. Definitely-null references consume no recipe entry.
- **Mutable reference globals and tables.** KFMS module-state helpers restore
  reference globals, sparse table contents and length, and passive-segment
  lifetime before frame replay. Process generation fencing keeps pthread
  replicas and late dynamic-link consumers coherent.
- **Exception context.** Frames captured inside a catch handler carry the
  exact dynamic region/arm selector. Scalar tagged payloads occupy an overlaid
  maximum-size tuple; reference/vector payloads and untagged catches use a
  complete-exception recipe. Replay throws inside Wasm so `CatchRef` and
  `CatchAllRef` receive fresh child-instance exnrefs.
- **No stale replay roots.** The instrumenter emits none of the historical
  `_wpk_fork_*ref_stash` tables. Temporary codec slots, retained caught
  exceptions, anyref transit entries, and externref handle leases are cleared
  on normal completion, successful replay, abort, process-image replacement,
  and worker teardown.
- **Frame-pressure bounds.** Ordinary reference recipes add no source-function
  local and no bytes beyond the existing 16-byte linked-frame header:
  catch selector and vector ordinal reuse `+8` and `+12`. Catch operand storage
  is colored by maximum simultaneously live type tuple rather than static arm
  count. Generated helper-function locals and the process recipe arena are
  outside every ordinary native activation.
- **Kernel-side-effect calls don't re-fire during REWIND.** Switch-dispatch
  (the only live scheme post-commit-4) skips the body chunks before the
  matching `POST_K` entirely on REWIND, so non-fork-path direct calls
  (`setpgid`, `dup3`, `kill`, `open`, `pipe`, …) and all observable
  side-effect ops in those chunks run exactly once, on the parent's NORMAL
  pass. No per-call or per-op gating is needed.

### Boundaries outside activation replay

- **`makecontext` / `swapcontext` / `getcontext` / `setcontext`.** Userspace
  stack-switching primitives are unsupported and not on any roadmap. See
  [posix-status.md](posix-status.md) for rationale.
- **Host engine proposal support.** The input must be a valid module for both
  the transform's parser and the target Node/browser engine. The ABI does not
  emulate a WebAssembly proposal that the selected engine itself cannot
  instantiate.
- **Stale or incomplete artifacts.** ABI 42 fork artifacts, copied capability
  bytes, malformed recipe metadata, and mixed-version host/module contracts
  fail before execution. They are rebuild inputs, not compatibility modes.

#### Closed since the mega-PR's 2.5/2.6 sub-commits

These were "Not guaranteed" pre-2.5/2.6 but are now absorbed by switch-
dispatch (top-level or nested):

- ~~**Operand-stack carryovers at DirectCall landings**~~ — sub-commit 2.5c
  added per-call carryover spilling at direct fork-path call landings.
- ~~**Multi-value-params Block/Loop/TryTable bodies containing fork-path
  calls**~~ — sub-commit 2.6c added body-input-param prespill so the
  cascading POST_K blocks can re-expose params to inner chunks.
- ~~**Wider carryover shapes at sub-region landings (multi-typed, multi-
  value)**~~ — sub-commit 2.6a's `CarryoverPlan::spill_locals` Vec
  generalised the single-i32 MVP to any number of typed slots.
- ~~**Top-level carryovers with unknown-type producers consumed before the
  fork call**~~ — sub-commit 9-followup generalised the top-level
  analyser to `Vec<Option<ValType>>`, mirroring 2.5c's nested policy.

### Side effects during REWIND — no gating needed

Post-commit-4 (2026-05-14), switch-dispatch is the only live dispatch
scheme. By construction, the body chunks before the chosen `POST_K`
**never re-execute on REWIND** — the function-level `br_table` jumps
directly to the matching post-call block, bypassing every preceding
instruction. This means:

- **Non-fork-path direct calls** in those chunks (libc wrappers for
  `setpgid` / `dup3` / `open` / `kill` / `pipe`, etc.) never re-fire.
  Their kernel side effects happen exactly once, on the parent's
  NORMAL pass. The pre-2.5/2.6 guard-dispatch's `state == NORMAL`
  gate + frame-saved result locals are no longer needed.
- **Observable side-effect ops** (`local.set`, `local.tee`,
  `global.set`, `store` of all widths, `memory.grow` / `memory.fill`
  / `memory.copy` / `memory.init`, `data.drop` / `elem.drop`,
  `table.set` / `table.grow` / `table.fill` / `table.init` /
  `table.copy`, atomic RMW, `atomic.notify`, `throw` / `throw_ref`)
  in those chunks similarly run only on NORMAL.

The pre-2.5/2.6 Phase 4g side-effect-gating machinery
(`emit_gated_side_effect`, `side_effect_shape`,
`emit_gated_non_fork_call`) was deleted alongside guard-dispatch in
commit 4. The historical context — including the
`local.tee` identity-passthrough bug from the popen-class divergence
investigation — is preserved in
`memory/fork-instrument-O2-bug-investigation.md` (external memory).

## Performance envelope

Linked continuations add three imported host calls per saved activation over a
complete fork cycle: reserve and commit while unwinding, then next while
replaying. Each saved activation also carries a 24-byte node header on wasm32
or a 32-byte node header on wasm64, rounded together with the payload to an
8-byte boundary. Each active module continuation uses at least one 64 KiB
page-rounded anonymous mapping; another mapping is added only when the current
chunk cannot hold the next complete node. An individual frame larger than a
Wasm page is allocated in a correspondingly larger page-rounded chunk.

ABORT_UNWINDING adds one i32 local and a result-typed restart-loop guard to each
transformed function, a zero-reservation branch at each fork-path call site,
two control exports, and a 16-byte root-prefix selector. This code executes
only on replay checks or allocation failure; ordinary execution adds the local
and loop structure but does not allocate continuation memory.

The module-format fixed cost is three imports, two abort exports, plus the
24-byte `kandelo.wpk_fork.linked_frames` descriptor and normal Wasm section/name
encoding. The fixed 60 KiB host-reserved control-region geometry remains in
place from ABI 42, but it is no longer continuation capacity: only its anchor
word is used to find the dynamically allocated root chunk.

The ABI 43 deferred-signal request flag occupies the channel header, and the
post-import checkpoint is an ordinary syscall. Neither adds bytes to the
linked continuation, its 16-byte frame header, or an activation payload.

A function with tagged catches uses one function-wide exact-arm selector and
one typed scalar operand union colored to the maximum simultaneously live
payload. The fixed frame header remains 16 bytes, references add no frame
bytes, and additional catch arms do not each allocate a tuple. A scalar catch
payload can still enlarge that function's frame by the maximum live tuple;
activation-owned storage is required for recursion and reentrancy correctness
and replaces the unsafe module-global tuple.

As a narrow size check, instrumenting the P-10 deep-recursion fixture from the
same 27,886-byte raw Wasm produced 50,873 bytes with the ABI 41 instrumenter
and 52,330 bytes with the ABI 42 linked-frame instrumenter: 1,457 additional
bytes (2.86%). This is one small fixture, not a general application-size
claim; the fixed import/metadata cost and the number of transformed call sites
change the percentage substantially between programs.

Using the same dev-shell compiler invocation on 2026-07-21, the current P-10
source produced a 27,608-byte raw module. Commit `a4789e2c6` (linked frames
before abort recovery) instrumented it to 52,052 bytes; ABORT_UNWINDING
instrumented the identical raw input to 58,370 bytes. The recovery state
machine therefore added 6,318 bytes (12.14%) to this instrumented fixture.
P-10 deliberately creates a very large conservative fork-path closure, so this
is a stress-fixture result rather than a general package-size estimate.

Performance comparisons must use the fork-heavy benchmark suites with
`npx tsx benchmarks/run.ts --rounds=3` on both the Node.js and browser hosts.
The suites that exercise fork meaningfully are `wordpress`, `erlang-ring`,
and `process-lifecycle`. Do not infer a regression percentage from the
structural costs above.

For the concrete numbers landed by the Phase 7 rollout PR, see Task 15 of
`docs/plans/2026-04-21-fork-instrument-phase-7-rollout-plan.md`. Binary size
for fork-heavy programs is expected to be equal or smaller than under the
prior full-module fork-continuation carve-out (most notably git), since the tool instruments
a tighter reachable set.

## Maintainer notes

### Reasoning about which scheme a function uses

When a real-world program misbehaves during fork, the first triage step is
to identify which switch-dispatch shape the offending function uses:

```bash
wasm-tools print "$BIN" | awk '/^\s+\(func [^;]*main/{found=1} found{print}' | head -200
```

A leading `loop ... block ... block ... if (state >= REWINDING) ... br_table ...`
shape at the function's entry means switch-dispatch is active. A historical
`block $unwind_save` followed by per-call `(state == NORMAL || (REWINDING &&
call_idx == K))` if-elses means an old guard-dispatch binary is being
inspected, not current PR output.

To distinguish top-level switch-dispatch from nested switch-dispatch,
look inside the enclosing instructions: nested switch-dispatch emits the
same `if (state >= REWINDING) ... br_table ...` shape inside any
fork-bearing `block` / `loop` / `if` / `try_table`, plus a `select`
rewriting any fork-bearing IfElse's condition afterwards. Impure IfElse
conditions also show a `local.set $cond_swap_local` at the end of the
preceding chunk; pure condition suffixes are replayed at the post-landing
instead. Top-level switch-dispatch has only the function-level dispatch and
never touches a sub-region's body.

Carryover-spilling at a SubRegion landing shows up as a pair of fresh
i32 locals (recorded in the function's frame): the chunk inside `POST_K`
ends with `local.set $spill_local`, and after the enclosing instruction
the post-landing sequence emits `local.get $spill_local` (and, when the
enclosing instr returns an i32, a brief juggle through `tmp_result_local`).

Nested switch-dispatch coverage lives in
`tests/switch_dispatch.rs::nested_fork_call_uses_per_block_switch_dispatch`
and the carryover-spilling / pure-materialization fixtures alongside it. Add
new regressions there or in `host/test/fork-instrument-coverage.test.ts`
depending on whether the bug is a tool-level transform issue or an end-to-end
host/runtime issue.

### Running tests

Unit tests live in `crates/fork-instrument/tests/`. The default cargo target
in this workspace is `wasm64-unknown-unknown` (from `.cargo/config.toml`),
which cannot build host tests — always pass the explicit host target:

```bash
HOST_TARGET="$(rustc -vV | awk '/^host/ {print $2}')"
cargo test -p fork-instrument --target "$HOST_TARGET"
```

### Running the fuzz gate

Phase 6 catch-handler resume was validated with a random-WAT fuzzer that
generates try_table programs on a fork path and asserts both walrus and
wasmparser accept the instrumented output.

```bash
scripts/run-fork-instrument-fuzz.sh                 # default 10 000 iters
FUZZ_RUNS=50000 scripts/run-fork-instrument-fuzz.sh # longer run
```

The script passes `--sanitizer=none` to `cargo fuzz`. On macOS arm64,
cargo-fuzz's default AddressSanitizer deadlocks during init (the malloc
interceptor recurses into ASAN init which holds a spin mutex). The fuzzer
targets validator/semantic divergence rather than memory-safety, so ASAN is
not load-bearing.

### Supporting additional reference state

Do not add a module-static reference stash. A fresh fork child has a new Wasm
instance, table, Store, and exception-tag identity, so a slot number is not a
transferable value even if it happens to fix same-instance recursion.

Support for a new reference shape extends one of two complete designs:

1. Encode every value needed by replay as versioned activation-owned bytes in
   the linked continuation, then reconstruct the reference deterministically
   in the child.
2. Name an explicit host reconstruction owner, version its recipe, and prove
   Node, browser, pthread, and side-module parity.

Add a positive fresh-instance replay test that would fail if the parent
module's globals or tables were consulted, plus malformed/version-mismatch
tests for the ownership contract. A valid source shape is not converted into
an instrumentation rejection merely because its reconstruction provider is
new work. Update the capability contract and bump the ABI if the accepted
artifact surface or reconstruction format changes.

### Extending side-effect coverage

There is no live side-effect gating path after guard-dispatch removal. If a
new wasm opcode can appear before a fork-path call, add coverage that proves
the containing switch-dispatch shape skips that opcode on REWIND. Existing
examples are the S-01..S-08 host fixtures plus the WAT-level table-operation
tests in `crates/fork-instrument/tests/coverage_wat.rs`.

### Fork from a tagged catch

`Catch` arms unwrap the thrown exception's operand tuple at handler entry.
`CatchRef` arms additionally push an instance-local exnref. Neither reference
identity nor module scratch is available in a fresh child, so both forms replay
from activation-owned selectors and typed recipes.

The implementation adds that path without accessing continuation memory during
ordinary catch execution:

1. **Static discovery (`plan_plain_catches`).** Walk each fork-path function
   and collect every `Catch`, `CatchRef`, `CatchAll`, and `CatchAllRef` arm's
   tag when present, target label, exact catch-list index, kind, and operand
   types. Legacy `try` handlers are normalized to the same modern-EH control
   representation. This plan has no runtime addresses or activation state.
2. **Activation allocation.** Allocate one function-wide exact-arm selector
   and a typed operand-scratch union sized by maximum simultaneous use.
   Scalar `CatchRef` forwarding uses one short-lived nullable exnref scratch;
   complete-exception arms retain only the liveness-colored recipe roots
   required at a fork landing.
3. **Frame ownership.** Header word `+8` stores the selector. Scalar payload
   types overlay one maximum-size frame range; reference/vector payloads are
   edges in the process recipe graph. Each recursive or reentrant activation
   therefore owns a distinct recipe without cost proportional to static arm
   count.
4. **Capture.** A generated block records the incoming tuple or complete
   exception and exact selector, then restores the original handler stack.
   Short-lived forwarding scratch is cleared before user code; retained recipe
   roots are cleared by transaction completion or abort.
5. **Replay.** `inject_rewind_throw_stubs` dispatches on the restored selector.
   Scalar arms push their tuple and execute `throw` with the original tag.
   Complete-exception arms materialize and throw inside Wasm. The original
   clause then reconstructs its payload and, for reference clauses, a fresh
   child-local exnref. An unknown selector traps instead of consulting old
   instance state.

The lifetime boundary is load-bearing: a catch can run before any fork or
after a prior continuation has been released. Its normal capture path must
therefore never dereference `_wpk_fork_buf`.

C-08/C-09 verify the transformed funcref/externref catch shapes. The Node
`catch-ref-fresh-worker` test and Chromium continuation gate additionally
execute non-null funcref and nullable externref payloads through `CatchRef` in
new process Workers; the child calls the reconstructed funcref and receives a
fresh child-local exnref. The module-exception, GC-codec, process-owner, and
mailbox suites separately cover vector payloads and non-null opaque externref
ownership. Together these gates prove that catch operands use typed recipes
rather than being misclassified as scalars or placed in a module-static table.

## See also

- [architecture.md](architecture.md) — overall kernel / host / user-program
  separation.
- [abi-versioning.md](abi-versioning.md) — why the `wpk_fork_*` export names
  and save-buffer layout are covered by `ABI_VERSION`.
- [posix-status.md](posix-status.md) — per-syscall support, including the
  `ucontext` family's unsupported status.
- [porting-guide.md](porting-guide.md) — how to compile programs against the
  SDK; `wasm-fork-instrument` is invoked automatically by build scripts.
- [`plans/2026-04-20-fork-instrumentation-design.md`](plans/2026-04-20-fork-instrumentation-design.md)
  — the originating design discussion, including alternatives considered.
