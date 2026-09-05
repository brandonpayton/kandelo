# N1-I5b grounding: native fork reference CAPTURE

Read-only design map. All paths are relative to
`/Users/brandon/kandelo-abi44-reconcile`. No code was changed to produce this
document.

---

## 0. Headline finding: I5b's assumed scope conflicts with a same-week platform
decision — read this before anything else

The task framing this document was written against says I5/I5b's scope is
"funcref+externref+anyref-transit; GC struct/array/i31 = M3", and that native's
own `docs/plans/2026-09-05-n1-i5-references-grounding.md` (committed
`6e4a52d03`) describes exactly that: native's landed I5 REPLAY work
(`fm_begin_reference_replay`, `resolve_externref`, the guest import flip) makes
funcref AND externref reconstruction "live" through the module, mirroring what
that grounding doc's §4 describes as Node/browser's guest-import-flip block at
`worker-main.ts:4593-4607`.

That §4 description is **now stale for the CAPTURE side** (it remains
accurate for REPLAY, see §1 below). One day after that grounding doc landed,
four commits on this same branch —
`253867db1c` ("Fork: gut gated capture imports to survivable placeholders"),
`0d5dd28805`/`cf4f238566` ("Fork: externref reference reconstruction driven
through the module... flag-gated" — later reverted/superseded by the gating),
`6f44c7b036` ("Fork: e2e tests for module abort-replay (gated EOPNOTSUPP...)")
— deleted Node/browser's real externref (and typed Wasm-GC / static-root)
**capture-time** reconstruction and replaced it with an unconditional gate.
The authoritative statement of the resulting platform contract is
`docs/fork-reference-support.md` (current HEAD):

> **Supported across fork**: `null` and `funcref`; `exnref` for wasm-tag/C++
> exceptions.
> **Unsupported (gated) across fork**: `externref`, `struct`, `array`, `i31`,
> and static-root references — "A fork that would carry a live value of one
> of these kinds across the boundary fails with `EOPNOTSUPP`
> (`ForkReferenceUnsupportedError`, errno 95)... detected on the **parent**
> side, during capture, not after a child has been spawned."

Concretely, on Node/browser today (`host/src/fork-activation-registry.ts:477-482`):

```ts
[WPK_FORK_REFERENCE_IMPORT_ENCODE_EXTERNREF]: (
  value: unknown,
): number => {
  registry.markUnsupportedReferenceKind("externref");
  return registry.reserveGatedLeafPlaceholder(value);
},
```

`markUnsupportedReferenceKind` causes the run loop (`worker-main.ts:5109-5119`,
quoted in §2) to abort the fork with `-EOPNOTSUPP` right after
`sealCapture()` — **no child is ever spawned** for a fork that captured a live
externref. The one narrow exception (`docs/fork-reference-support.md`'s
"Known gaps and residuals"): "Host-exception externref payloads remain a
narrow, synthetic-only path... reconstructs, ungated, through the retained
exception machinery" — i.e. an externref *carried as a JS host-exception
payload* still round-trips (a different, narrower mechanism than general
externref-in-a-local/global/table), but a plain externref value captured the
way native's `smoke_fork_reconstructs_references` fixture captures one (a
local variable holding a directly-resolved externref) is **exactly** the kind
`docs/fork-reference-support.md` now gates.

**What this means for I5b:** native's own blocked test
(`crates/host-native/src/lib.rs:1925-1949`,
`smoke_fork_reconstructs_references`) asserts that BOTH a funcref AND an
externref reconstruct correctly across a real (new-child) fork. Per the
CURRENT Node/browser platform contract, the externref half of that assertion
describes behavior the platform has explicitly decided NOT to support in
general — only funcref (and exnref, via the separate exception codec) are
"supported across fork" as of `docs/fork-reference-support.md`. Building real
CAPTURE for externref on native (as the pre-gate design intended) would give
native a capability Node/browser deliberately do NOT have, breaking the
Host Runtime Contract's host-parity rule ("A host-runtime behavior change is
incomplete until both hosts have the same platform-observable behavior or the
difference is explicitly justified by a real platform boundary" —
`CLAUDE.md`). This grounding therefore treats **funcref-only real capture**
as I5b's correctness target, and treats matching Node/browser's gate (a fork
that captures a live externref/GC/static-root reference cleanly aborts with
`EOPNOTSUPP`, no child spawned) as the honest disposition for the rest —
not a fabricated success. §5 gives the concrete recommendation and notes the
alternative (re-affirm externref as in-scope and treat the gate commits as
the thing that needs revisiting) so whoever picks this up can make that call
explicitly rather than by accident.

---

## 1. The full capture-side import set + which module EXPORTS each flips to

Every `WPK_FORK_REFERENCE_IMPORT_*` capture-side constant lives at
`crates/shared/src/lib.rs:2407-2438`. Table below: guest import name → the
co-resident fork-module (`crates/fork-module/src/lib.rs`) export it would flip
to, if one existed.

| Guest import (constant, `crates/shared/src/lib.rs`) | String name | Module export? | Module-side reality |
|---|---|---|---|
| `WPK_FORK_REFERENCE_IMPORT_ENCODE_FUNCREF` (2415) | `__wpk_fork_ref_encode_funcref` | **NONE** | No `fm_ref_encode_funcref` anywhere in `crates/fork-module/src/lib.rs` (confirmed exhaustively — every `pub extern "C" fn`/`#[no_mangle]` in that file is listed at the top of this investigation; none matches) or `crates/fork-module-inject/src/main.rs` (only injects `__wpk_fork_ref_decode_funcref`, `__wpk_fork_ref_decode_externref`, `fm_drive_execute` — `main.rs:65,69,96,120,124,149,156,229,272,355`). |
| `WPK_FORK_REFERENCE_IMPORT_ENCODE_EXTERNREF` (2414) | `__wpk_fork_ref_encode_externref` | **NONE** | Same — no `fm_ref_encode_externref` export or injected wrapper exists. |
| `WPK_FORK_REFERENCE_IMPORT_VECTOR_BEGIN` (2436) | `__wpk_fork_ref_vector_begin` | **NONE** | This is the EXACT import native's blocked test traps on (`crates/host-native/src/lib.rs:1893-1898`: "TRAPS during CAPTURE ... on `unknown import: env::__wpk_fork_ref_vector_begin has not been defined`"). |
| `WPK_FORK_REFERENCE_IMPORT_VECTOR_APPEND` (2435) | `__wpk_fork_ref_vector_append` | **NONE** | — |
| `WPK_FORK_REFERENCE_IMPORT_VECTOR_FINISH` (2437) | `__wpk_fork_ref_vector_finish` | **NONE** | — |
| `WPK_FORK_REFERENCE_IMPORT_GC_BROKER_ENCODE` (2416) | `__wpk_fork_ref_gc_broker_encode` | **NONE** | GATED on Node/browser (§0); no module export. |
| `WPK_FORK_REFERENCE_IMPORT_GC_CAPTURE_LAYOUT` (2417-2418) | `__wpk_fork_ref_gc_capture_layout` | **NONE** | GATED; no module export. |
| `WPK_FORK_REFERENCE_IMPORT_GC_CLAIM` (2419) | `__wpk_fork_ref_gc_claim` | **NONE** | GATED; no module export. |
| `WPK_FORK_REFERENCE_IMPORT_GC_DEFINE` (2420) | `__wpk_fork_ref_gc_define` | **NONE** | GATED; no module export (void return). |
| `WPK_FORK_REFERENCE_IMPORT_GC_I31` (2421) | `__wpk_fork_ref_gc_i31` | **NONE** | GATED; no module export. |
| `WPK_FORK_REFERENCE_IMPORT_GC_LOOKUP` (2423) | `__wpk_fork_ref_gc_lookup` | **NONE** | GATED (the anyref-transit dedup entry point — see §0's Node/browser quote); no module export. |
| `WPK_FORK_REFERENCE_IMPORT_GC_PROVENANCE_BEGIN` (2425-2426) | `__wpk_fork_ref_gc_provenance_begin` | **NONE** | GATED; no module export. |
| `WPK_FORK_REFERENCE_IMPORT_GC_PROVENANCE_END` (2427-2428) | `__wpk_fork_ref_gc_provenance_end` | **NONE** | GATED; no module export (void return). |
| `WPK_FORK_REFERENCE_IMPORT_GC_PROVENANCE_REF` (2429-2430) | `__wpk_fork_ref_gc_provenance_ref` | **NONE** | GATED; no module export (void return). |
| `WPK_FORK_REFERENCE_IMPORT_SCRATCH_RESERVE` (2434) | `__wpk_fork_ref_scratch_reserve` | **NONE** | Not gated by kind (it is a generic buffer helper the guest's frame codec uses whenever it needs scratch space during ANY capture, including a plain funcref-only fork) but still has no module export. |
| `WPK_FORK_REFERENCE_IMPORT_SCRATCH_RELEASE` (2433) | `__wpk_fork_ref_scratch_release` | **NONE** | Same as above (void return). |

**Every single capture-side import has NO fork-module export.** This is not a
partial gap — grep across `crates/fork-module/src/lib.rs` (all 71 `pub extern
"C" fn`/`#[no_mangle]` items enumerated, `lib.rs:2594-3550`) and
`crates/fork-module-inject/src/main.rs` (all `EXPORT`/`inject_*` constants,
`main.rs:65-355`) turns up zero matches for `fm_ref_encode_*`,
`fm_ref_vector_begin/append/finish`, `fm_ref_gc_broker_encode`, `fm_ref_gc_
capture_layout`, `fm_ref_gc_provenance_*`, `fm_ref_gc_claim/define/i31/
lookup`, or `fm_ref_scratch_reserve/release`. `crates/host-native/src/
lib.rs:1900-1901` documents this explicitly: "`crates/fork-module/src/lib.rs`
defines `fm_ref_vector_get` for RESTORE but no `fm_ref_vector_begin`/`append`/
`finish`/`encode_*` for CAPTURE — grep confirms."

**Why the mental model in the task framing ("guest import → module export,
mirroring the replay flip") does not hold for capture, on ANY host, including
Node/browser**: capture-side guest imports are never flipped to a co-resident
module export at all — not on native, not on Node, not on browser. On
Node/browser they are bound directly to per-fork HOST JS closures
(`host/src/fork-activation-registry.ts`'s `buildForkActivationStateImports`,
§2 below), which internally call into `ForkReferenceTransaction`
(`host/src/fork-reference-transaction.ts`) — a JS class, not Wasm. The
shared `fork_module32.wasm` (Path B, "the module owns the reconstruction
algorithm") only ever implements the RESTORE/REPLAY half of the reference
protocol. Capture has never been module-owned on any host; there is no
existing Node/browser "flip" pattern for I5b to mirror at the wiring layer —
only a JS *algorithm* to reproduce (in Rust, natively) or a decision to keep
capture off the module-ownership path entirely (see §5).

Two constant pairs the task's context mentions but that turn out to be
**dead/unreachable, not part of this gap**: `WPK_FORK_REFERENCE_IMPORT_
{DECODE,ENCODE}_ANYREF` and `_EXNREF` (`crates/shared/src/lib.rs:2408-2413`).
Grep across every `.rs`/`.ts` file in the repo shows these four names are
declared as `ReferenceCodecClass` dispatch constants in `crates/fork-
instrument/src/runtime.rs:106-113` and enumerated in `tools/xtask/src/dump_
abi.rs:2422-2443`'s ABI dump, but **never appear in `WPK_FORK_REQUIRED_
IMPORTS`** (`crates/shared/src/lib.rs:2488-2759`, the array that determines
what an instrumented guest actually declares) and have zero other references
anywhere in the tree. No fixture, package census entry (`docs/fork-
reference-support.md`: "zero packages... produce these reference kinds"), or
instrumenter code path ever emits an import with these literal names — a
guest's raw `anyref`-typed value routes through `GC_LOOKUP`/`GC_CLAIM`/etc.
(the GC family) and a raw `exnref` routes through the separate exception
codec's `WPK_FORK_EXCEPTION_IMPORT_*` family, so these four ANYREF/EXNREF
codec names have no live call path today. They are out of scope for I5b.

---

## 2. How Node/browser wire the capture side

**Binding (always JS, unconditional, no flag/flip)**:
`buildForkActivationStateImports` (`host/src/fork-activation-registry.ts:372`)
returns a plain object literal binding every capture-side name directly to a
closure — no module export lookup, no `moduleReferenceKindsSupported` gate at
all (contrast with the REPLAY-side decode/feed imports, which ARE
conditionally flipped — see the analogous block quoted below). The
supported-kind bodies:

```ts
// fork-activation-registry.ts:463-465
[WPK_FORK_REFERENCE_IMPORT_ENCODE_FUNCREF]: (
  value: unknown,
): number => references().encodeFuncref(value),
// fork-activation-registry.ts:498-507
[WPK_FORK_REFERENCE_IMPORT_VECTOR_BEGIN]: (
  expectedLength: number,
): number => references().beginReferenceVector(expectedLength >>> 0),
[WPK_FORK_REFERENCE_IMPORT_VECTOR_APPEND]: (
  handle: number,
  recipeId: number,
): void => references().appendReferenceVector(handle >>> 0, recipeId >>> 0),
[WPK_FORK_REFERENCE_IMPORT_VECTOR_FINISH]: (
  handle: number,
): number => references().finishReferenceVector(handle >>> 0),
```

where `references()` (`fork-activation-registry.ts:381`) is
`registry.currentReferences()`, i.e. the ACTIVE `ForkReferenceTransaction`
instance for this fork (`host/src/fork-reference-transaction.ts:187`).
`encodeFuncref`/`beginReferenceVector`/`appendReferenceVector`/
`finishReferenceVector` are real methods on that class
(`fork-reference-transaction.ts:253`, `540`, `560`, `584`) — pure JS
bookkeeping over in-process data structures (`PagedForkReferenceDirectory`,
`WeakMap`/`Map` interning tables), not Wasm calls.

The GATED-kind bodies (`ENCODE_EXTERNREF`, `GC_LOOKUP`, `GC_CLAIM`, `GC_I31`,
`GC_DEFINE`, `GC_BROKER_ENCODE`, `GC_CAPTURE_LAYOUT`, `GC_PROVENANCE_*`;
`fork-activation-registry.ts:477-658`, quoted in full in §0) do NOT call the
real encoder at all — each calls `registry.markUnsupportedReferenceKind(kind)`
(records a string for the run loop to read after seal) and returns a
`registry.reserveGatedLeafPlaceholder(value)` /
`reserveGatedTransitPlaceholder()` sentinel (a valid, non-null `i31` leaf node
that keeps the LIVE value only for the PARENT's own same-worker resume — see
`fork-reference-transaction.ts:270-300`'s `reserveGatedPlaceholder` doc
comment). This is what lets the guest's own save walk complete without
trapping even though the fork will be aborted.

**When capture runs** — driven entirely by `kernel_fork`'s host-side import
body (`worker-main.ts:4143-4176`) plus the guest's own private unwind
exception, NOT a separate host-initiated pass:

1. `kernel_fork` is called (guest, synchronously, still on its normal call
   stack — capture has not started walking frames yet):
   ```ts
   // worker-main.ts:4154-4158
   acquireCurrentProcessForkArchiveReader();
   const arena = newModuleStateArena();
   arena.begin();
   processContinuation.beginCapture(arena);
   ```
   `beginCapture(arena)` (`fork-activation-registry.ts:1190-1231`) creates a
   FRESH `ForkReferenceTransaction`, calls `references.beginCapture()`
   (seeds node 0 = canonical null), then for **every registered activation**
   calls `activation.moduleState.save(activation.activationId)` — this
   invokes the GUEST's own `wpk_fork_module_state_save` export, which walks
   that activation's globals/tables and calls back into the CAPTURE imports
   (`encodeFuncref` for a funcref global/table entry, `beginReferenceVector`/
   `appendReferenceVector`/`finishReferenceVector` for any reference-typed
   vector) for whatever it finds live RIGHT NOW, before any stack unwind.
   `kernel_fork`'s host body then returns `0` ("ignored during unwind" — the
   real fork-vs-child branch is decided later via replay, not this return
   value).
2. The guest's OWN generated fork-unwind code then throws its private
   fork-unwind exception and walks up through every stack frame, committing
   each frame via `wpk_fork_frame_commit` — a frame with a reference-typed
   LOCAL calls the SAME capture imports (`encodeFuncref` /
   `beginReferenceVector`/etc.) again, for that frame's own live values, as
   part of that per-frame commit.
3. The host's run loop catches the transported private exception
   (`worker-main.ts:5085-5100`, `isForkUnwindException`) and, if
   `processContinuation.phaseName() === "capture"`:
   ```ts
   // worker-main.ts:5109-5119
   processContinuation.sealCapture();
   // GATED REFERENCE KIND: ... Abort the fork cleanly with EOPNOTSUPP
   // instead of launching a child ...
   ```
   `sealCapture()` (`fork-activation-registry.ts:1356-1363`) calls
   `references.sealInto(arena)` then `arena.seal()`. `sealInto`
   (`fork-reference-transaction.ts:302-327`) calls
   `appendSegmentedForkReferenceTransaction(arena, FORK_REFERENCE_
   TRANSACTION_OWNER_ID, this.nodes, this.referenceVectors)` — this is the
   ONLY place the captured reference graph is turned into bytes and written
   into the arena, and it happens exactly once, after the ENTIRE unwind
   (both the pre-unwind module-state save AND every frame commit) has
   finished appending nodes/vectors to the in-memory `ForkReferenceTransaction`.
4. If step 1-2 ever called an unsupported-kind body, the run loop (right
   after `sealCapture()`, same `worker-main.ts:5109-5119` block) reads and
   clears the recorded kind and aborts the fork with `-EOPNOTSUPP` — no
   child worker is ever spawned. Otherwise the sealed arena's root address
   becomes the `moduleStateRoot` a fresh child's `attachModuleChild` later
   passes to `fm_begin_reference_replay` (§4 of the companion I5 grounding
   doc; call site `fork-process-continuation.ts:1082,1243`).

**Call order summary**: capture is two INTERLEAVED passes into ONE
`ForkReferenceTransaction`/`ForkModuleStateArena` pair — (a) per-activation
module-state save, triggered synchronously inside `kernel_fork`'s host body,
BEFORE any stack unwind; (b) per-frame commits, triggered by the guest's own
unwind exception propagating up the call stack, AFTER (a). Sealing
(`sealInto`+`arena.seal()`) happens once, after BOTH passes complete, from the
host's post-unwind-exception handler — not from any co-resident module call
(the module plays no role in capture at all today).

---

## 3. The real module-state (KFMS) root

**What it is**: the SAME `ForkModuleStateArena` object (`host/src/fork-
module-state.ts:2929`) that `beginCapture` opens at the very start of capture
(`arena.begin()`, `worker-main.ts:4155-4157` — `newModuleStateArena()` is
defined at `worker-main.ts:3762-3794`, backed by `continuationMmap`/
`continuationMunmap` against the fork's own GUEST linear `memory`, i.e. the
arena's bytes live in guest address space, not a separate host buffer). It
carries TWO kinds of records, both written by GUEST code calling HOST-bound
imports during the SAME capture pass described in §2:

- **Module-state records** (`ForkModuleStateRecordKind`, e.g. `TablePage`) —
  written by the guest's `wpk_fork_module_state_save`/`saveTables` via the
  `__wpk_fork_module_state_record_reserve/commit/find` imports
  (`fork-activation-registry.ts:404-425`, bound to `arena.reserveRecord`/
  `commitRecord`/`findRecord`).
- **The reference transaction itself** (funcref recipes, reference vectors) —
  appended ONCE at seal time via `ForkReferenceTransaction.sealInto(arena)`
  → `appendSegmentedForkReferenceTransaction(...)` (§2 step 3), using the
  SAME record-append machinery, tagged with `FORK_REFERENCE_TRANSACTION_
  OWNER_ID` so the decoder can find it among the other module-state records.

So on Node/browser there is exactly ONE arena per fork carrying BOTH ordinary
module-state (table dirty pages etc.) AND the reference graph — `fork_
codec`'s Rust decoder (used by BOTH native and, via `fork-reference-
transaction.ts`'s use of the shared wire format, conceptually mirrored in JS)
calls this format "KFMS" (the chunk header native's own code references,
`wasm_posix_shared::abi::wpk_fork_module_state_chunk_header_size`).
`arena.rootAddress()` (`fork-module-state.ts:3508`) is the pointer
`fm_begin_reference_replay`'s `module_state_root` parameter expects.

**How it threads from parent capture → child**: the sealed arena's root
address is carried across the fork boundary the same way every other
continuation root is — as part of the process's fork-continuation/journal
image (the mechanism `fm_serialize_journal_alloc`/the KFRE frame journal
already carries for I4's frames-only case; the KFMS module-state root is a
sibling pointer alongside it, not embedded inside the frame journal itself —
confirmed by native's own comment at `guest.rs:4541-4546`: "`module_state_
root` here is NOT the continuation root `fm_begin_child_replay`/`fm_begin_
replay` use... since the continuation root points at the KFRE frame journal,
a different wire format"). On the child side, `attachModuleChild(arena, ...)`
(`fork-process-continuation.ts:1048-1057`) receives an already-reconstructed
`ForkModuleStateArena` (attached via `arena.attach`/`attachBorrowed` against
the inherited root address, `fork-module-state.ts:2961-3008`) and calls
`backend.beginReferenceReplay(arena.rootAddress())` → `fm_begin_reference_
replay` (`fork-module-backend.ts:324-327`).

**What native must replace `write_empty_module_state_arena` with**: native's
`instantiate_fork_module` currently synthesizes, ONCE, a page-aligned,
genuinely-valid-but-canonical-null-only KFMS chunk
(`crates/host-native/src/guest.rs:624-663`, `write_empty_module_state_arena`)
using the module's OWN encoder (`fork_codec::ReferenceSegmentsWriter`,
`fork_codec::ReferenceGraphBuilder::begin()`) — a deliberately honest "this
fork captured no reference" floor, NOT a fabricated success (see that
function's own doc comment, `guest.rs:596-623`). Both `drive_reference_
replay` call sites (`guest.rs:4569-4646`, invoked at `guest.rs:4746` for
child replay and `guest.rs:4989` for the resuming parent's own replay) read
`fm.empty_module_state_root` (`guest.rs:4580`) — the SAME constant address
computed once at instantiation — every single time, for every fork,
regardless of what that fork's guest actually captured.

For I5b, the empty-arena constant must be replaced by an arena that a native
CAPTURE pass actually filled during THIS fork's unwind, mirroring §2's
Node/browser sequence:

1. At `kernel_fork` time (native's SYS_FORK host-import body, wherever N1's
   frame-capture equivalent of `beginCapture` lives — outside this
   document's read scope, but the natural home per the campaign's
   "Path B: module owns the algorithm, host supplies raw capability"
   framing would be a native `NativeReferenceCapture` struct playing the
   same role `ForkReferenceTransaction` plays in JS): allocate a fresh,
   page-aligned KFMS arena in the GUEST's linear memory (native already has
   the primitive for this — `write_empty_module_state_arena` already writes
   a page-aligned chunk into guest memory via `SharedMemory`; the only
   change is writing REAL captured nodes/vectors instead of the canonical
   null-only graph via `fork_codec::ReferenceGraphBuilder`/
   `ReferenceSegmentsWriter`, which are the SAME Rust types already in use).
2. Bind the guest's capture-side imports (§1) to native closures that append
   to that SAME `ReferenceGraphBuilder` (in-memory Rust structure, analogous
   to JS's `ForkReferenceTransaction`) as the guest's `wpk_fork_module_state_
   save` and per-frame unwind commits call them — for a funcref-only guest,
   ONLY `encode_funcref`/`vector_begin`/`vector_append`/`vector_finish` are
   ever actually reached (a program with no reference-typed vector locals
   may not even call the vector family — the fixture `native_fork_refs.wat`
   calls at minimum `encode_funcref` per the fork's own doc comment,
   `crates/host-native/src/lib.rs:1867-1876`).
3. At the point corresponding to `sealCapture()` (after the native
   equivalent of the full unwind completes — again, outside this document's
   read scope, but must be the moment ALL activations' module-state save AND
   all frame commits have finished), call
   `ReferenceSegmentsWriter::write(...)` against the accumulated
   `ReferenceGraphBuilder` and finalize the SAME arena
   `write_empty_module_state_arena` already knows how to construct headers
   for — i.e. this is a data-content change to that function's callers, not
   a new wire-format or new arena-placement mechanism. The RESULT replaces
   `fm.empty_module_state_root` with a per-fork (not per-instantiation)
   address, which both `drive_reference_replay` call sites
   (`guest.rs:4746`, `guest.rs:4989`) must read fresh each fork instead of
   the constant field.
4. For the gated kinds (§0/§5): if a capture import for one of
   `externref`/`struct`/`array`/`i31`/`static-root` is ever reached, native's
   equivalent of `markUnsupportedReferenceKind` + a leaf placeholder (NOT a
   trap — a raw error here "cannot unwind an errno through the Wasm fork
   save walk" per `fork-activation-registry.ts:704-711`'s own doc comment,
   which is exactly as true on native's raw Wasmtime import-call boundary)
   must run, and the native fork syscall path must abort with `EOPNOTSUPP`
   after the (still-honest) seal, mirroring `worker-main.ts:5109-5119`.

---

## 4. What native already has (I5) vs must add

**Bound today** (`crates/host-native/src/guest.rs`), all REPLAY-side:

- `ForkModule` struct fields (`guest.rs:2908-2996`): the frame coordinator
  set (`fm_set_format`, `fm_begin_unwind`, `fm_finish_unwind`, `fm_serialize_
  journal_alloc`, `fm_journal_image_len`, `fm_begin_replay`, `fm_finish_
  replay`, `fm_begin_child_replay`, `fm_last_errno`, `fm_frames_committed`/
  `replayed`) PLUS the full I5 reference-replay set: `fm_begin_reference_
  replay`, `fm_set_activation_catalog_base`, `fm_set_activation_static_root_
  base`, `fm_set_activation_gc_codec`, `fm_set_host_exception_owner`,
  `fm_build_gc_plan`, `fm_gc_plan_count`, `fm_drive_execute`, `fm_drive_
  table_base`, `fm_ref_vector_get`, `fm_ref_gc_route`, `fm_ref_gc_payload_
  len`, `fm_ref_gc_load`, `fm_ref_exn_route`, `fm_ref_exn_load`, `fm_ref_exn_
  cache_index`, `fm_funcref_ordinal`, `fm_static_root_slot`, `fm_externref_
  handle`, plus the `*_reconstructed`/`*_resolved`/`*_published`/`*_executed`
  proof-of-use counters, and `gc_transit_table: Table` (the module's exported
  STORE #2).
- The guest-side REPLAY import flip (`guest.rs:4059-4113`): a 9-entry
  `flips` array binding `WPK_FORK_REFERENCE_IMPORT_{DECODE_FUNCREF,DECODE_
  EXTERNREF,VECTOR_GET,GC_ROUTE,GC_PAYLOAD_LEN,GC_LOAD}` +
  `WPK_FORK_EXCEPTION_IMPORT_{ROUTE,LOAD,CACHE_INDEX}` to the matching
  `fm_ref_*` exports, gated only on `guest_declares(name)` — no flag
  equivalent to Node/browser's `moduleReferenceKindsSupported` exists on
  native (it always flips when the guest declares the import and a fork
  module is present).
- `env.__wpk_fork_ref_gc_transit` binding (`guest.rs:4041-4057`): the
  module's own exported transit table wired into the guest's import, net-new
  relative to I4 (no such wiring existed before I5 Task 1).
- `env.resolve_externref` (`guest.rs:2383-2396`, `define_resolve_externref`):
  a REAL `Func::wrap` closure over `ExternrefRegistry`
  (`guest.rs:2314-2355`, `HashMap<u32, wasmtime::OwnedRooted<ExternRef>>`),
  idempotent per handle — this is the REPLAY-side externref primitive (used
  by the injected `__wpk_fork_ref_decode_externref` shim and the
  `DRIVE_OP_EXTERNREF_TRANSIT` drive step), tested directly at
  `guest.rs:7722-7750` (`resolve_externref_is_idempotent_per_handle`).
- `ForkHostCapabilities` for native (`crates/host-native/src/fork_host_
  capabilities.rs:120-166`, `NativeForkHostCapabilities`): all three methods
  (`mint_exception_tag`, `provide_unwind_transport_tag`, `recognize_unwind_
  transport`) are REAL `Tag::new`/`Tag::eq` implementations, not `ENOSYS` —
  this is DONE, ahead of what the companion I5 grounding doc's §3/§6 framed
  as still-outstanding "Step 2" work when it was written.
- `write_empty_module_state_arena` (`guest.rs:624-663`) + the two `drive_
  reference_replay` call sites (`guest.rs:4746`, `guest.rs:4989`) — the
  synthesized-empty-root floor described in §3.

**Missing for I5b (capture side)** — everything, because (§1) there is no
module export to bind to and (§2/§3) capture has never been a "flip an
import to a module export" operation on ANY host, so there is no existing
wiring pattern to port:

1. **No native capture-time bookkeeping subsystem at all.** Confirmed by
   grep (`crates/host-native/src/lib.rs:1904-1907`: "no host-native Rust
   implementation either (grep for these names in `guest.rs` before this
   task: no hits)") and independently reconfirmed here — zero matches for
   `fm_ref_encode`, `fm_ref_vector_begin`, or any of the gc_* capture names
   anywhere under `crates/host-native/`. Native has nothing playing the role
   of Node/browser's `ForkReferenceTransaction`
   (`host/src/fork-reference-transaction.ts`) or `ForkActivationRegistry`'s
   capture bookkeeping (`host/src/fork-activation-registry.ts:670-1231`).
2. **No native module-state (KFMS) CAPTURE mechanism at all**, not just for
   references — the whole `__wpk_fork_module_state_*` guest-import family
   "stays inert" per I4's own doc comments (`guest.rs`, referenced at
   `guest.rs:593-595`). `write_empty_module_state_arena`'s doc comment says
   this explicitly: "A future task that adds real native module-state
   capture (out of this task's scope — see the N1-I5 grounding doc's
   capture-side gap) replaces this with the guest's own captured arena"
   (`guest.rs:620-623`). I5b's reference-capture work and a hypothetical
   "general native module-state capture" task overlap at exactly this KFMS
   arena — building a reference-only capture subsystem without also solving
   plain module-state (table dirty pages, etc.) capture means I5b's arena
   would still be non-general (a reference-only KFMS chunk with no table-
   state records), which is fine for a funcref/exnref-only fork (the
   REQUIRED_IMPORTS in §1's dead-import discussion shows table-dirty
   tracking is a SEPARATE import family, `WPK_FORK_MODULE_STATE_IMPORT_*`,
   `crates/shared/src/lib.rs:2513-2578`, not part of the reference codec) but
   is a real scope boundary to name explicitly: I5b should scope itself to
   "capture the reference graph into an otherwise-still-empty-of-table-state
   KFMS arena," not "solve general module-state capture."
3. **The two `drive_reference_replay` call sites read a compile-time-
   constant field** (`fm.empty_module_state_root`) instead of a per-fork
   value — this must become plumbing (a per-`ForkCoordState`/per-fork field
   populated by the new capture pass), not just a body-content change.

---

## 5. Feasibility + size verdict

**Can capture be done host-side-only (flip capture imports to module exports
+ thread a real root), no kernel/module/fork-instrument change?** No — for
two independent reasons, not one:

1. **There is no module export to flip to** (§1). "Flip" is the wrong verb
   for capture on any host; the only way to make these 15 imports live is to
   bind each to a NEW native host body performing REAL bookkeeping — this is
   net-new Rust logic, not a rebind of already-compiled module code. This
   part is unavoidable regardless of the funcref-only-vs-full-scope question
   in §0, because even a funcref-only fork's guest declares (per `WPK_FORK_
   REQUIRED_IMPORTS`, `crates/shared/src/lib.rs:2488-2759`) the ENTIRE
   capture-side surface unconditionally (the instrumenter does not
   conditionally omit `vector_begin`/`gc_lookup`/etc. based on whether a
   given program happens to use them) — so `define_unknown_imports_as_
   traps` (`guest.rs:4143`) will keep trapping on ANY of these 15 names the
   first time ANY instrumented guest's capture path reaches them, even a
   guest that only ever captures a funcref. All 15 must get SOME live body
   (a real encoder for the funcref/vector family; a gate-and-placeholder
   stub for the rest) before `smoke_fork_reconstructs_references`-shaped
   fixtures can even begin capturing, regardless of scope.
2. **The module-state (KFMS) root is currently a compile-time-constant
   empty arena** (§3/§4 point 3) — making it real requires new native state
   (a per-fork arena + accumulator) threaded through the SAME two call
   sites the empty root already flows through, which is host-native
   plumbing work, independent of whether any Wasm/kernel/fork-instrument
   bytes change.

Neither of these requires a kernel change, a fork-module (`crates/fork-
module`) change, or a fork-instrument (`crates/fork-instrument`) change —
the wire format (`fork_codec::ReferenceGraphBuilder`/`ReferenceSegmentsWriter`)
and the guest-declared import surface are already exactly what a real capture
pass needs to target; the KFMS chunk header helpers native already calls
(`wasm_posix_shared::abi::wpk_fork_module_state_chunk_header_size`) are
already shared, ABI-level code. **This is a `crates/host-native`-only
addition, with zero ABI/module/kernel change**, matching the "host-side-only"
framing in the task's premise — just not via a "flip to module export"
mechanism, because that mechanism does not exist for capture on any host.

**Pure-flip vs needs-a-real-host-body, per import**:

| Import | Disposition for I5b (funcref-only target, §0) | Kind of work |
|---|---|---|
| `encode_funcref` | REAL body: intern a `wasmtime::Func` into a native funcref-recipe table (mirrors `ForkReferenceTransaction.encodeFuncref`'s `functions.encode(value)` against a `ForkFunctionCatalog`) and append a `funcref` node to the native `ReferenceGraphBuilder`. | New host body (bookkeeping only — no engine-floor issue; Wasmtime funcrefs ARE `Func` handles, straightforward to catalog). |
| `vector_begin`/`append`/`finish` | REAL body: a native equivalent of `PagedForkReferenceDirectory`/handle-based in-progress-vector map (mirrors `beginReferenceVector`/`appendReferenceVector`/`finishReferenceVector`, `fork-reference-transaction.ts:540-596`). Needed even for a funcref-only fork IF the guest ever captures a reference-typed TABLE/vector (not just a scalar local) — the fixture's own doc comment (`crates/host-native/src/lib.rs:1868-1869`, "Loads a sentinel funcref from a table") implies at least `vector_begin`/`append`/`finish` around a table-shaped capture is plausible, though the exact fixture's declared-import list should be checked before assuming all three are reached. | New host body (bookkeeping only). |
| `scratch_reserve`/`scratch_release` | REAL body needed regardless of which reference KINDS are captured — this is a generic buffer helper the guest's frame codec may call during ANY capture (not kind-gated in the Node/browser JS provider either — `fork-reference-transaction.ts`'s own `allocateScratch`/`deallocateScratch` constructor params back it for every phase). Native needs a scratch allocator over guest memory (or can reuse the SAME `reference_scratch_base` region `instantiate_fork_module` already reserves for `write_empty_module_state_arena`, `guest.rs:3140-3170`). | New host body, but likely thin (a bump/free-list allocator over an already-reserved region — no engine-floor issue). |
| `encode_externref` | If §0's recommendation is followed: a GATE-and-placeholder stub (mark unsupported, return a benign non-null sentinel, let the native fork-abort path return `-EOPNOTSUPP` after seal) — mirrors `fork-activation-registry.ts:477-482` exactly, NOT a real encoder. If §0's alternative is chosen instead (treat externref as genuinely in scope, diverging from the current Node/browser gate): a REAL body reusing the SAME `ExternrefRegistry` (`guest.rs:2314-2355`) I5's REPLAY side already built — §5 of the companion I5 grounding doc already worked out the identity discipline (idempotent `handle -> Rooted<ExternRef>`) this would need, so if chosen this is the ONE capture-side import with real prior art to reuse. | Gate stub (cheap) OR real body reusing existing registry (moderate, and a deliberate host-parity divergence — see §0). |
| `gc_broker_encode`, `gc_capture_layout`, `gc_claim`, `gc_define`, `gc_i31`, `gc_lookup`, `gc_provenance_{begin,ref,end}` (9 imports) | GATE-and-placeholder stubs only — these are M3 scope on every host (`docs/fork-reference-support.md`; the companion I5 grounding doc §7's I5/M3 boundary line explicitly excludes "struct/array/i31/GC-derived-externref/full static-root graphs" from I5). Mirrors `fork-activation-registry.ts:528-658` (the GATED bodies quoted in §0/§2) essentially line-for-line — same placeholder values, same "mark kind, don't throw" discipline. | Gate stubs only (no real body ever, until M3). |

**Does the funcref case (the simplest, unproven-on-native kind) work once
capture is wired?** Conditionally yes, with two remaining unknowns this
grounding could not resolve by reading alone (both need code/test, not more
reading):

- Whether the `native_fork_refs.wat`/`.c` fixture's funcref path reaches
  `vector_begin`/`append`/`finish` at all, or only `encode_funcref` (a
  single table-loaded funcref in a LOCAL, per the fixture's own doc comment
  at `crates/host-native/src/lib.rs:1868-1869`, may or may not require the
  vector family depending on how the guest's generated frame codec
  represents "one funcref local" — a scalar field vs. a length-1 vector).
  If the fixture never reaches the vector imports, I5b's REAL minimum
  surface shrinks to `encode_funcref` + `scratch_reserve`/`release` (still
  gate-stubbing the other 11).
- Whether native's SYS_FORK/`kernel_fork` host-import body has an existing
  hook point equivalent to `worker-main.ts:4154-4176`'s `beginCapture`
  call — this document did not trace native's `kernel_fork` host-import
  wiring (outside the read scope given: this grounding focused on `guest.rs`
  per the task's own file pointers), so §3's "at `kernel_fork` time" step is
  a mapped REQUIREMENT, not a confirmed existing seam. A follow-up read of
  native's `SYS_FORK`/`kernel_fork` host-import implementation (likely also
  in `crates/host-native/src/guest.rs`, given `fork_result`/`coord.set_fork_
  result` appear near the `drive_reference_replay` call sites at
  `guest.rs:4968-4969`) is needed before implementation starts.

**Concrete net-new native surface for I5b** (all additive to `crates/host-
native`, no ABI/module/kernel change):

1. A native reference-capture accumulator (the native analogue of
   `ForkReferenceTransaction`'s capture half) wrapping `fork_codec::
   ReferenceGraphBuilder`, with a funcref-recipe interning table (native
   analogue of `ForkFunctionCatalog`).
2. Real `Func::wrap` bodies for `encode_funcref`, `vector_begin`, `vector_
   append`, `vector_finish`, `scratch_reserve`, `scratch_release` — bound
   into the guest's import object at the SAME wiring point §1/§4 point 3's
   REPLAY-side `flips` array lives (`guest.rs:4059-4113`), added as a sixth
   (capture-side) block.
3. Gate-and-placeholder `Func::wrap` bodies for `encode_externref` (unless
   §0's alternative is chosen) and the 9 typed-GC capture imports —
   ports of `fork-activation-registry.ts:477-658`'s bodies, needing a native
   "mark unsupported kind, abort with EOPNOTSUPP after seal" primitive that
   does not exist today (native's fork-abort path, if one exists at all,
   was out of this document's read scope — the companion I5 grounding
   doc's own "Known gaps" analog for native abort-replay was not
   established here and should be checked before implementation).
4. A real (not-hardcoded) KFMS arena root: extend `write_empty_module_
   state_arena`'s call site to, when a native capture pass actually ran,
   serialize the ACCUMULATED `ReferenceGraphBuilder` via `fork_codec::
   ReferenceSegmentsWriter` (same encoder, real content) instead of the
   canonical null-only graph, and thread that per-fork address into BOTH
   `drive_reference_replay` call sites (`guest.rs:4746`, `guest.rs:4989`)
   in place of the `fm.empty_module_state_root` constant.
5. A native fork fixture (extending or replacing `native_fork_refs.wat`)
   whose asserted acceptance bar matches §0's recommended scope: funcref
   correctness + `fm_references_reconstructed>0` for the SUPPORTED half,
   and (if the externref/GC gate is kept, matching Node/browser) an
   assertion that a SEPARATE fixture carrying a live externref/GC value
   returns `-EOPNOTSUPP` from `kernel_fork` with no child spawned, rather
   than either trapping OR silently succeeding.

**Size**: this is genuinely new host logic, not a rebind — comparable in
shape to I5's REPLAY-side `ExternrefRegistry`/`define_resolve_externref`
addition (a self-contained struct + a handful of `Func::wrap` closures) but
broader (6 real bodies + up to 10 gate stubs + arena-threading changes at 2
call sites + resolving the `kernel_fork` capture-hook-point unknown above),
and it depends on `smoke_fork_reconstructs_references`'s own scope being
narrowed per §0 before "done" can be claimed truthfully. If §0's alternative
is chosen instead (real externref capture, diverging from Node/browser's
current gate), add the `ExternrefRegistry`-based real body work item 3's
externref row already scoped, plus a Host Runtime Contract justification
for why native's capability differs from Node/browser's documented
`EOPNOTSUPP` boundary — that justification does not exist today and this
document takes no position on whether one is achievable, only that it would
need to be written down explicitly (`docs/fork-reference-support.md` would
need a native-specific carve-out) rather than left implicit.

---

## Net-new native reference-CAPTURE surface for I5b (one-paragraph summary)

A `crates/host-native`-only addition (no kernel/module/fork-instrument/ABI
change): a native capture accumulator over `fork_codec::ReferenceGraphBuilder`
+ a funcref interning table; 6 real `Func::wrap` bodies
(`encode_funcref`, `vector_begin/append/finish`, `scratch_reserve/release`);
gate-and-placeholder stubs for `encode_externref` (pending the §0 scope
decision) and the 9 typed-GC capture imports; threading the accumulated,
sealed graph into the two existing `drive_reference_replay` call sites in
place of the current compile-time-constant `empty_module_state_root`; and
resolving one open unknown (native's `kernel_fork` host-import capture hook
point) before implementation. I5b's honest acceptance bar, given §0's
finding: **funcref reconstructs correctly across a real native fork with
`fm_references_reconstructed>0`; a fork that captures a live externref or
typed-GC value cleanly returns `-EOPNOTSUPP` with no child spawned**, matching
`docs/fork-reference-support.md`'s current, non-native-specific platform
contract — not "externref reconstructs," which is what native's own blocked
test currently asserts and what would need an explicit, written host-parity
exception to keep asserting.
