# Fork orchestration migration — the corrected Path-B plan-of-record

**Date:** 2026-09-07
**Worktree:** `/Users/brandon/kandelo-abi44-reconcile`
**Branch:** `brandonpayton/rust-first-abi44-reconcile`
**HEAD verified:** `45488f08b`
**Status:** verify-and-plan (READ-ONLY except this doc). No source edited, no
build run, no cross-host validation run.

**Companion inputs (all read + reconciled against code at HEAD):**
`.superpowers/sdd/2026-09-05-n1-f5-externref-capture/task-P5c-report.md`,
`task-P6-report.md`, `task-19-flip-readiness-audit.md`, and
`docs/plans/2026-09-06-path-b-flip-completion.md`.

---

## 0. What this doc settles

Two independent agents (P5c, P6) tried to execute the tail of the flip — P5c to
sever the JS engine from the module path, P6 to delete the JS twins — and both
returned **BLOCKED** with the same root finding: at HEAD the co-resident Rust
module supplies only **leaf drives**, while the JavaScript engine is still the
live **orchestrator and graph-owner** on the module-on fork path. This doc
verifies that finding with code, states the precise module-owns-vs-JS-owns
boundary, reconciles it with P2/P3's GREEN "no JS reconstruction runs"
assertions, and rewrites the migration plan accordingly.

---

## 1. VERDICT — the finding is correct

**YES.** Despite P2/P3b landing "the module is the sole reconstructor/capturer,"
at HEAD `45488f08b` the JS engine is still the live orchestrator and graph-owner
on the module-on fork path; the module owns only the leaf-drive **algorithm**.

Caveat on the word "default": the flip-readiness audit is also correct that the
fork module is **flag-OFF by default** on both V8 hosts today
(`node-kernel-worker-entry.ts:173`, `browser-kernel-worker-entry.ts:151`), so the
literal runtime default runs JS for *everything*, leaves included. The finding
concerns the **module-on** path — the path the flip makes the default — and it
holds there a fortiori: even with the module on, JS orchestrates. Every claim
below is on the module-on path.

### 1.1 RECONSTRUCTION — the JS registry is the entry, the module is a sub-delegate

`host/src/fork-process-continuation.ts`, module-child branch (`attachModuleChild`):

- `:1096-1100` `const typedDrive = this.moduleReferenceReplay ? () =>
  backend.driveTypedGraph() : undefined;` — the module drive is packaged as a
  **callback**.
- `:1101` `this.registry.restoreModuleState(typedDrive);` — the **JS**
  `ForkActivationRegistry` is the reconstruction ENTRY; the module is passed in
  only as the leaf delegate.
- `:1082` `backend.beginReferenceReplay(arena.rootAddress());` — the arena root
  is read/handed by JS.
- `:1133` `this.registry.currentArena().recordViews()` — JS owns the arena view.
- `:1223` (borrowed / vfork branch, `attachBorrowedModuleChild`)
  `this.registry.attachChild(arena, decodedReferences);` — JS owns child attach.
- The coordinator also holds the live JS `resumeTable`/`events` journal state and
  threads `LinkedForkContinuation` through activation seeding (`:1139`
  `backend.beginChildReplay(...)`, `:1155` `addActivationChildReplay`, `:1163`
  `invokeForkContinuationBegin`).

Inside the registry, `restoreModuleState` (`fork-activation-registry.ts:1719`)
calls `this.currentReferences().materializeAllTyped(typedDrive)` (`:1737`) — the
JS `ForkReferenceTransaction` method is the wrapper; the module callback is the
leaf.

### 1.2 CAPTURE — the JS transaction OWNS the graph; the module is one of ten deps

`host/src/fork-activation-registry.ts`, `beginCapture` (`:1473`):

- `:1484` `const functions = this.buildFunctionCatalog();` — JS builds the funcref
  catalog.
- `:1485-1496` `const references = new ForkReferenceTransaction(functions,
  this.externrefs, this.memory, allocate, deallocate, label, this.staticRoots,
  this.typedReplayOwner(), this.externrefProvenance, this.captureModule);` — the
  JS transaction is constructed owning the funcref catalog, `externrefs`, the
  static-root catalog, the externref provenance graph, and (via the registry) the
  GC transit; `this.captureModule` is only the **tenth** constructor argument.
- The encode/intern import bodies (`ENCODE_FUNCREF`, `GC_LOOKUP`, `GC_CLAIM`,
  `GC_I31`, `GC_DEFINE`, vector begin/append/finish) and the
  `reserveGatedPlaceholder` soundness gate live in the JS transaction
  (`fork-reference-transaction.ts:429`, `:1519-1599`, `:2001-2041`). P3b routed the
  intern **leaf-ops** through `this.captureModule` (the `if (this.moduleCapture)`
  branches at `:347/:370/:387/:431/:510/:541/:583/:1519/:1538/:1613` etc.), but
  graph ownership, catalogs, provenance, and the drive/gate sequencing stayed in
  JS. (Comment at `:340`: "the module owns the graph and this class's `nodes`
  table is reads only" — yet the class still constructs, sizes, and sequences the
  whole capture session.)

### 1.3 The unconditional JS-engine construction on the module-on path

`host/src/worker-main.ts` per-process fork setup builds the JS engine with **no
module-enabled guard**:

- `:3754` `new LinkedForkContinuation(...)`, `:3817` `new
  ForkActivationRegistry(...)`, `:3865` `new
  ForkProcessContinuationCoordinator(memory, activationRegistry, ...)` — none
  gated by `forkModuleInstance`. (The gated `? :` twins at `:6341/:6387/:6420` are
  the *thread* path, proving a conditional construction is possible and is the
  target shape for INC-E.)
- `:3617` `forkGcTransit = new ForkAnyrefTransitTable(forkModuleInstance
  .gcTransitTable)` binds the module-owned STORE #2 into the registry.
- `:3889-3890` `activationRegistry.setCaptureModule(new
  ForkReferenceCaptureModule(...))` wires the capture module INTO the JS registry.

The JS registry is wired **into** the module path as its container, not offered
as an alternative to it.

---

## 2. The measurement gap — why P2/P3 GREEN and this finding are both true

P2's and P3b's assertions ("no JS reconstruction runs", "module is the sole
reconstructor/capturer") are literally true **for the leaf-drive algorithm**, and
this is provable from the same method the coordinator calls.

`fork-reference-transaction.ts:materializeAllTyped(moduleDrive?)` (`:1916`):

```
if (moduleDrive) {
  owner.prepareTransit(Math.max(0, this.decodedNodes.length - 1)); // :1962  JS sizes transit
  moduleDrive();                                                    // :1963  module drives the walk
  this.typedMaterialized = true;                                    // :1964
  return;                                                           // :1965  returns BEFORE the JS reconstruction below
}
// :1967-2200+  PHASE A static-root publish, PHASE B externref publish, the
//              topological allocate/fill/exn sub-loop — the JS RECONSTRUCTION.
//              On the module path this code does NOT execute.
```

So what P2/P3 measured GREEN = the code **below `:1966` does not run**: the JS
PHASE A/B publishes and the JS allocate/fill/identity/cycle sub-loop are genuinely
superseded by the module's `fm_build_gc_plan` + `fm_drive_execute` over
`drive_plan.rs` Phase 0/0b (comment `:1937-1961`). That is a real, correct
result: the reconstruction **leaf algorithm** is module-owned on the module path.

What P2/P3 did **not** measure — and what this finding names — is the
**orchestration wrapper** around that leaf, all still JS:

1. the entry chain itself: coordinator `attachModuleChild` →
   `registry.restoreModuleState` → transaction `materializeAllTyped` → `moduleDrive`
   (three JS methods on two JS engine objects before the module is called);
2. wire-graph decode — `this.decodedNodes` was produced by the JS segment codec
   (`fork-reference-segments.ts` `materializeReferenceGraph` / `parseSegmented...`)
   BEFORE `materializeAllTyped` runs;
3. transit sizing — `owner.prepareTransit(...)` (JS, `:1962`) sizes the anyref
   transit that the module writes into;
4. `attachChild` / `currentArena` / arena `recordViews` (JS owns the inherited
   arena);
5. funcref catalog build/mirror (`worker-main.ts:4803-4824`, `buildFunctionCatalog`);
6. the whole capture graph, catalogs, provenance, and gate (§1.2);
7. resume/events journal state on the coordinator, and `LinkedForkContinuation`
   activation seeding.

**Crisp statement of the gap:** P2/P3's green asserts *the leaf drive algorithm
is module-owned* (no JS allocate/fill/publish runs). The finding asserts *the
orchestration around that leaf is JS-owned* (graph, catalogs, provenance, wire
decode, drive sequencing, replay entry, attachChild, arenas, transit sizing,
resume/events). These are disjoint measurements of disjoint code, so both are
correct. The flip needs the second one closed; P2/P3 only closed the first.

---

## 3. The module-owns-vs-JS-owns boundary at HEAD (the line to move)

**Module owns today (leaves):**
- the typed reconstruction **drive algorithm**: `fm_build_gc_plan` +
  `fm_drive_execute` over `drive_plan.rs::build_drive_plan` (Phase 0 static-root,
  Phase 0b every-externref-transit, Phase 3-5 alloc/fill/cycle);
- frame/journal replay via `fm_frames_*` / `fm_begin_replay` (flag-on frames);
- the 7 `fm_ref_*` leaf reads (data feed);
- funcref/externref **decode** imports (`__wpk_fork_ref_decode_*`, flipped at
  `worker-main.ts:4593`);
- the intern **leaf-ops** during capture (`this.captureModule` /
  `ForkReferenceCaptureModule` — `reference_graph_builder.rs::intern_*`);
- the GC transit anyref table STORE #2 (module-owned/exported;
  `ForkAnyrefTransitTable` wraps `forkModuleInstance.gcTransitTable`).

**JS still owns (orchestration):**
- replay **entry** (`restoreModuleState` / `attachChild` / `currentArena` /
  `materializeAllTyped` wrapper);
- **wire-graph decode** (`fork-reference-segments.ts`,
  `fork-reference-recipes.ts`) and the externref-handle scan
  (`scanSegmentedForkReferenceExternrefHandles`);
- the **capture graph** ownership + funcref catalog + static-root catalog +
  externref provenance + capture **layering + gate sequencing**;
- transit **sizing** (`prepareTransit`);
- funcref catalog **build/mirror** into the module table;
- resume/events **journal** state and `LinkedForkContinuation` activation seeding;
- the unconditional **construction** of the whole JS engine on the fork path.

**Floor that stays on every host (never migrates):**
- `resolve_externref(handle) → externref` (the one reference-returning host func;
  identity holds by idempotent cache, `fork-module-host-capabilities.ts:56-73`,
  `fork-reference-broker.ts:590-606`);
- externref value→handle provenance (`fork-externref-provenance.ts` WeakMap
  identity) + handle mint;
- the three host-provided reference-typed tables + PIC/shared-memory + one `Tag`.

---

## 4. Plan-error corrections (carried forward, verified at HEAD)

- **`fork-anyref-transit.ts` / `ForkAnyrefTransitTable` — KEEP (module-owned
  STORE #2).** The P6 delete-list in
  `docs/plans/2026-09-06-path-b-flip-completion.md:426` lists it for deletion;
  that is **wrong**. It is live module glue: `worker-main.ts:3617`
  `new ForkAnyrefTransitTable(forkModuleInstance.gcTransitTable)` wraps the
  module-owned GC transit on the module path (`:3716` mints a standalone one on
  flag-off; both live), and `fork-module-instance.ts` imports it. Keep it.
- **`fork-reference-broker.ts` — KEEP the file (the `resolve_externref` floor),
  delete only its capture-graph logic.** It is the M2 handle→externref identity
  floor (`ForkExternrefTokenCache`), imported by eight STAY files including both
  `*-kernel-worker-entry.ts` and `fork-module-host-capabilities.ts`.
- **`fork-externref-provenance.ts` — KEEP the identity primitive (WeakMap),
  delete only capture logic.** It is the V8 externref value→handle floor.
- **Split `fork-continuation.ts` / `fork-replay-events.ts`** into (a) frame/
  journal/resume WIRE-FORMAT staying glue that the module path reads/writes
  (`LinkedFrameFormatDescriptor`, `readForkContinuationAnchor`,
  `invokeForkContinuationBegin`, `validateForkReplayEventWire`,
  `ForkReplayEventWire/CaptureSource`, `ForkResumeTarget`,
  `ContinuationAllocationError`) and (b) the JS engine classes
  (`LinkedForkContinuation`, `ForkReplayEventJournal`, `ForkResumeTable`) that die
  once orchestration moves. This split is INC-D and is the prerequisite for their
  eventual deletion.

---

## 5. The corrected migration — increments A–E, then delete, then validate

The un-done remainder is the **orchestration** migration (not a leaf re-home and
not a from-scratch Rust port). Bucket A of the companion plan established that the
reconstruction/replay/wire/frame engine already exists in `crates/fork-codec`
(23 modules, 437 tests) and is surfaced by `crates/fork-module` — so most of A–C
is **surface new `fm_*` exports over existing Rust + wire the host to them**, with
one genuine Rust authoring item (the capture layering/gate hoist).

### Execution model (coordinator directive — read before scheduling)

INC-A, INC-B, INC-C are all "module owns the orchestration" changes on the same
Rust surface (`fork-codec` / `fork-module` + the `fork-module-inject` seam). They
are **implemented as ONE batched pass** — author all three Rust surfaces + their
new `fm_*` exports together, do a **SINGLE `fork_module32/64.wasm` rebuild +
`verify-fresh`**, then wire the host against that one rebuilt module, and run a
**SINGLE cross-host validation at the end**. Do **not** run three separate heavy
rebuild + cross-host cycles.

Keep A/B/C as **internal checkpoints**: each has its own Rust crate-test gate
(`cargo test -p fork-codec` / `-p fork-module`, no wasm rebuild needed) and its
own host-side Node Vitest gate against the single rebuilt module. The expensive
wasm rebuild and the full cross-host (Node Vitest + browser Playwright + native)
run happen **once**, after A+B+C+D land, folded into P7.

**Hard-ordering note.** There is no ordering that forces an intermediate wasm
rebuild, because the three halves talk only through the **frozen wire format** (the
capture↔replay contract), not through each other's internals: INC-A (capture)
emits the wire graph, INC-C (decode) parses it, INC-B (replay) consumes the
decoded graph — all against the same committed segment format. Author all their
`fm_*` exports into one module build; the only thing that would force a second
rebuild is *changing the wire format mid-batch*, which the plan forbids (if a wire
change proves necessary, that is a separate, ABI-considered increment with its own
snapshot bump — call it out and rebuild once for it). Rust crate tests for each
checkpoint run without any wasm rebuild.

---

### INC-A — module owns the CAPTURE GRAPH  *(Rust-bearing; HIGHEST RISK)*

- **Goal.** Move capture graph ownership out of JS: the funcref catalog,
  static-root catalog, externref provenance graph, GC transit, capture layering
  (dedup → static-root → externref-provenance → GC construction), and the
  `reserveGatedPlaceholder` soundness gate become shared-Rust / module-owned, so
  the JS `ForkReferenceTransaction` capture half + `fork-function-catalog.ts` +
  `fork-static-root-catalog.ts` (capture) + `fork-gc-codec.ts` (capture) +
  `fork-externref-provenance.ts` (capture *logic*) become unreferenced on the
  module path.
- **JS responsibilities moved.** `beginCapture` graph construction
  (`fork-activation-registry.ts:1473`), the encode/intern import bodies
  (`ENCODE_FUNCREF`/`GC_LOOKUP`/`GC_CLAIM`/`GC_I31`/`GC_DEFINE`/vector
  begin/append/finish) and `reserveGatedPlaceholder` in
  `fork-reference-transaction.ts`, `buildFunctionCatalog`.
- **Target Rust home / does the twin exist?** The wire-emission inverse
  `crates/fork-codec/src/reference_graph_builder.rs::intern_*` / `claim_gc` /
  `define_gc` / vector builders **already exists, is unit-proven, and native
  already calls it** (`guest.rs:5933`). What does **not** exist: (a) a **capture
  layering + soundness-gate module** in `fork-codec` behind a small
  identity-primitive trait (host-agnostic decision logic — today duplicated in
  native `guest.rs` and JS transaction); (b) an `fm_*` capture export surfacing
  the builder to V8. So INC-A is **part genuine Rust authoring** (the layering/gate
  hoist — the one real (ii) of the whole plan) **and part export+wiring** (the
  builder already exists).
- **New `fm_*` exports.** `fm_capture_begin` / `fm_capture_intern_*` /
  `fm_capture_seal` (surfacing `reference_graph_builder` + the new layering/gate),
  plus the reference-typed capture seams via `fork-module-inject`.
- **Host-glue wiring.** Flip the V8 **encode** imports (today only *decode* is
  flipped at `worker-main.ts:4593`) to the module/shared builder; thin V8 capture
  bodies feed the two floor primitives (WeakMap externref identity, handle mint).
- **Floor that stays.** externref value→handle provenance (WeakMap), handle mint,
  `resolve_externref`.
- **Validation gate (checkpoint).** `cargo test -p fork-codec` capture-layering +
  gate tests; Node Vitest capture parity incl. the no-provenance case gating
  `EOPNOTSUPP` cleanly with the parent surviving (parity with native
  `smoke_fork_gated_externref_parent_survives`).
- **Rust-bearing:** YES (fork_module rebuild — new exports + inject seams).
- **Size:** M. **Risk:** **Medium-High — the true highest-risk increment.** It
  removes the JS capture path that `283b06917` deliberately revived, with **no JS
  fallback**, at the exact seam where V8 externref identity (an internalized
  externref is not `ref.eq`-comparable; WeakMap keying vs wasmtime `Rooted`+
  `ref_eq`) must match the shared model. The shared-Rust reality shrinks it from
  "invent capture in Rust" to "route V8 through proven shared logic behind two
  floor primitives," but it is still the seam where capture↔replay symmetry breaks.
- **Deps:** none beyond the frozen wire format (parallel to B/C in authoring).

### INC-B — module owns the REPLAY ORCHESTRATION  *(Rust-bearing)*

- **Goal.** Surface an `fm_*` that drives the whole transaction **end-to-end from
  the inherited arena** — drive-order sequencing, transit sizing, arena/journal
  seeding, activation manifest — so `registry.restoreModuleState` /
  `materializeAllTyped` (wrapper) / `attachChild` / `currentArena` /
  `prepareTransit` and `fork-early-reference-provider.ts` become unreferenced on
  the module path.
- **JS responsibilities moved.** The entry chain in
  `fork-process-continuation.ts:1081-1160` (`beginReferenceReplay` seeding,
  `restoreModuleState`, arena `recordViews`, activation seeding) and the
  `materializeAllTyped` wrapper + `prepareTransit` sizing.
- **Target Rust home / does the twin exist?** The **leaf drive** already exists
  and already runs (`fm_build_gc_plan` + `fm_drive_execute` over `drive_plan.rs`,
  P2). `fm_begin_reference_replay` (admits all kinds, `lib.rs:2240-2262`) exists.
  What does **not** exist as an export: the **end-to-end orchestration entry** that
  reads the inherited arena, sizes transit inside Wasm, and sequences the drive +
  activation seeding without the JS wrapper. So INC-B is **mostly wiring of
  existing Rust** plus a new orchestration-entry `fm_*` that internalizes the JS
  wrapper's bookkeeping.
- **New `fm_*` exports.** `fm_restore_from_arena` (entry that reads arena root,
  sizes transit, runs `begin_reference_replay` + the drive), and
  `fm_attach_child` / `fm_attach_borrowed_child` for the COW and vfork/dlopen
  multi-activation seeding paths.
- **Host-glue wiring.** Replace the `restoreModuleState(typedDrive)` /
  `attachChild` calls with the new `fm_*` entry; JS retains only the floor
  hand-off (memory base, arena address).
- **Floor that stays.** raw process-memory addressing on `env.memory`; the
  reference-typed tables.
- **Validation gate (checkpoint).** `cargo test -p fork-module` replay-entry
  tests; Node Vitest reconstruct parity across all kinds + frames + **vfork** +
  **dlopen multi-activation** (the borrowed and multi-activation seeding are the
  subtle cases — `attachBorrowedModuleChild` at `:1202`, multi-activation at
  `:1103-1160`).
- **Rust-bearing:** YES (same single rebuild as A/C).
- **Size:** M. **Risk:** Medium — algorithm exists; risk is moving arena/memory
  addressing + multi-activation/vfork/dlopen seeding into Wasm.
- **Deps:** frozen wire format; INC-C's decode may be consumed here (see batching
  — both land in the one rebuild).

### INC-C — module owns WIRE-GRAPH DECODE + externref-handle scan  *(Rust-bearing)*

- **Goal.** Surface `fm_*` segment decode + externref-handle scan so
  `fork-externref-process-owner.ts` and `worker-main.ts` stop decoding segments /
  calling `scanSegmentedForkReferenceExternrefHandles` in JS, retiring
  `fork-reference-segments.ts` + `fork-reference-recipes.ts`.
- **JS responsibilities moved.** `materializeReferenceGraph` /
  `parseSegmentedForkReferenceTransaction` / `validateReferenceSemantics` /
  `decodeHandle` / `scanSegmentedForkReferenceExternrefHandles`
  (`fork-reference-segments.ts:1109-1126, 1562`),
  `ForkReferenceRecipeCoordinator` (`fork-reference-recipes.ts:363`).
- **Target Rust home / does the twin exist?** The codec **already exists** in
  Rust (`fork-codec/src/reference_segments.rs` +
  `reference_segments_writer.rs`, `reference_recipes.rs`); it is simply **not
  exported as `fm_*`** — the module today consumes a graph JS already decoded. So
  INC-C is **export + wiring only** (no new algorithm).
- **New `fm_*` exports.** `fm_decode_reference_graph` and `fm_scan_externref_handles`.
- **Host-glue wiring.** `fork-externref-process-owner.ts` (imported by both
  `*-kernel-worker-entry.ts`) and `worker-main.ts` call the module scan/decode.
- **Floor that stays.** none new (pure decode).
- **Validation gate (checkpoint).** `cargo test -p fork-codec` segment round-trip
  (already 437-test covered); Node Vitest decode parity + externref-handle scan
  parity.
- **Rust-bearing:** YES (same single rebuild), but the lowest-authoring of A/B/C.
- **Size:** S-M. **Risk:** Medium (wide but mechanical). **Deps:** frozen wire
  format.

### INC-D — wire-format re-home + leaf constants  *(host glue; NOT Rust-bearing)*

- **Goal.** Extract the frame/journal/replay-event **wire-format** primitives and
  two leaf constants into a small **staying** TS module so the KEEP module glue
  stops importing them from soon-to-be-deleted engine files. This is the closest
  thing to the "re-home" P5c imagined, but it is a **supporting** step — it
  unblocks no engine file on its own.
- **JS responsibilities moved.** `LinkedFrameFormatDescriptor`,
  `readForkContinuationAnchor`, `invokeForkContinuationBegin`,
  `validateForkReplayEventWire`, `ForkReplayEventWire/CaptureSource`,
  `ForkResumeTarget`, `ContinuationAllocationError`, and the constants
  `FORK_REFERENCE_TRANSACTION_OWNER_ID` (= `WPK_FORK_REFERENCE_TRANSACTION_OWNER`),
  `FORK_HOST_EXCEPTION_ACTIVATION_ID` (= `0xffff_ffff`) → new `fork-*-wire.ts`.
- **Consumers fixed.** `fork-module-state.ts`, `fork-module-backend.ts`,
  `kernel-worker.ts`, `fork-resume-catalog.ts`, `fork-exception-provider.ts`,
  `fork-externref-process-owner.ts`.
- **Target home.** staying TS glue (no Rust twin needed — these are the host's
  read/write view of the module-owned wire format).
- **Validation gate (checkpoint).** `tsc` clean; no engine import remains in the
  KEEP glue; Node Vitest unaffected.
- **Rust-bearing:** NO.
- **Size:** S-M. **Risk:** Low-Medium (delicate frame/wire area, but mechanical).
  **Deps:** independent of A-C; do it **within** the batch so it is not churn.

### INC-E — detach the unconditional JS-engine constructions + gate flag-off  *(host glue; NOT Rust-bearing)*

- **Goal.** After A-D leave the registry/transaction/coordinator-JS-branch
  unreferenced on the module path, replace the unconditional constructions with
  the module-owned container + minimal staying glue, and construct the JS engine
  (if kept at all) **only** on the flag-off branch — mirroring the
  already-conditional thread path at `worker-main.ts:6341/6387/6420`.
- **JS responsibilities moved.** `worker-main.ts:3754/3817/3865` (the
  `new LinkedForkContinuation` / `new ForkActivationRegistry` /
  `new ForkProcessContinuationCoordinator` trio), the `:3617/:3843` transit
  binding, and `:3889-3890` `setCaptureModule`, all made conditional on flag-off.
- **Target home.** host glue only.
- **Floor that stays.** the module container + the Bucket C floor behind it.
- **Validation gate.** the instrumentation P5c asked for: **assert the JS engine
  is not constructed on the default (module-on) fork path**. This is the sever's
  completion gate.
- **Rust-bearing:** NO.
- **Size:** M. **Risk:** Medium (the actual sever; combined with the default-ON
  flip it is the irreversible product-default change — HELD for user dogfood per
  M7/B8).
- **Deps:** A + B + C + D all green.

### P6 — delete the JS twins  *(deletion only)*

- Once INC-E leaves the engine files imported **only by tests**, delete
  `fork-activation-registry.ts`, `fork-reference-transaction.ts`,
  `fork-reference-recipes.ts`, `fork-reference-segments.ts`,
  `fork-early-reference-provider.ts`, `fork-gc-codec.ts`,
  `fork-function-catalog.ts`, `fork-static-root-catalog.ts`, and the JS **engine
  classes** split out of `fork-continuation.ts` / `fork-replay-events.ts`
  (`LinkedForkContinuation`, `ForkReplayEventJournal`, `ForkResumeTable`), plus the
  **capture logic** of `fork-externref-provenance.ts` / `fork-reference-broker.ts`.
- **KEEP:** `fork-anyref-transit.ts` (STORE #2, §4), `fork-reference-broker.ts`
  file (resolve_externref floor), `fork-externref-provenance.ts` identity
  primitive, the `fork-module-*.ts` glue, `fork-reference-unsupported.ts`, and the
  new `fork-*-wire.ts` from INC-D.
- **Gate.** `tsc` clean; no import of a deleted symbol; the code is physically
  gone, not merely unreferenced.
- **Risk:** Low once A-E are green. **Size:** M (wide but mechanical).

### P7 — the SINGLE post-flip cross-host validation gate

- The **one** heavy validation for the whole batch: the single
  `fork_module32/64.wasm` rebuild + `verify-fresh`, then Node Vitest full +
  browser Playwright (`./run.sh browser` with fork exercised — the module-on
  browser config that has never run in CI) + libc/posix/sortix conformance +
  native `host-native`, on the SAME `kernel.wasm` + `fork_module*.wasm`.
- This is where the batching lands: **one** rebuild, **one** cross-host run —
  not one per increment.
- **Risk:** Medium (first true cross-host module-on run; browser least-exercised).

---

## 6. Sequence, critical path, and highest-risk call

```
              ┌─────────────── ONE batched Rust pass, ONE fork_module rebuild ───────────────┐
  INC-A capture graph   (Rust: layering/gate authoring + intern export)   ── HIGHEST RISK
  INC-B replay orchestration   (Rust: wiring existing engine + entry export)
  INC-C wire decode + handle scan   (Rust: export existing codec)
  INC-D wire-format re-home + constants   (host glue, no rebuild)
              └──────────────────────────────────────────────────────────────────────────────┘
                                   ▼
  INC-E detach constructions + gate flag-off   (host glue)   ── HELD for user dogfood
                                   ▼
  P6 delete JS twins   (deletion)
                                   ▼
  P7 single cross-host validation   (one rebuild, one run)
```

- **Critical path:** INC-A → INC-E → P6 → P7. A/B/C author in parallel against
  the frozen wire format and land in one rebuild; **E cannot start until A+B+C+D
  leave the JS engine unreferenced on the module path**; P6 needs E; P7 needs P6.
- **Highest-risk increment:** **INC-A (capture graph)** — it is the one genuine
  Rust authoring item (capture layering + soundness gate), it removes the JS
  capture with no fallback, and it is the exact seam where V8 externref identity
  must match the shared model (capture↔replay symmetry, campaign Decision 2a).
  INC-B/C are wiring of Rust that already exists and is native-proven.

## 7. Honest total-remaining-work assessment

- **Rust authoring is small and localized:** essentially the INC-A capture
  layering + soundness-gate hoist behind an identity-primitive trait, plus the new
  `fm_*` **export surfaces** for capture (A), the replay-from-arena entry (B), and
  segment decode/scan (C). The reconstruction/replay/wire/frame **engine itself is
  already written and tested** (`fork-codec` 437 tests) and native has already
  walked the whole thin-capture → shared-replay shape.
- **The bulk of the remaining work is V8 host wiring + deletion:** flip encode
  imports, replace the JS entry chain with the new `fm_*` entries, re-home the
  wire-format primitives, make the constructions conditional, then delete ~12k
  lines of JS engine.
- **The floor is tiny and closed:** `resolve_externref` + externref WeakMap
  identity + three reference-typed tables + PIC/shared-memory + one `Tag`.
- **Net:** the flip is a **wiring-and-delete finish with one real capture-layering
  hoist**, not the 24k-line Rust port the pre-audit framing implied — but it is
  gated behind INC-A's identity-floor seam and a single, first-ever cross-host
  module-on validation, both of which carry genuine runtime risk that only P7 can
  discharge.

### Ambiguities / where to re-inspect before coding

- **Two coexisting JS drive engines.** `materializeTypedGraph`
  (`fork-early-reference-provider.ts:1249`) vs `materializeAllTyped`
  (`fork-reference-transaction.ts:1916`). The live module-on restore uses
  `materializeAllTyped`; confirm `materializeTypedGraph` is off every live path
  before scoping INC-B's deletions.
- **`fm_drive_execute` is an injected Wasm shim, not a Rust export** (per Bucket A
  — `fork-module-inject`). INC-A/B/C's new reference-typed `fm_*` seams likely
  need matching `fork-module-inject` (walrus) work; scope the injector changes as
  part of the single rebuild.
- **Whether the capture layering hoist should be full (option b: shared
  `fork-codec` trait) or minimal (option a: thin V8 body mirroring native).** The
  companion plan §3-note recommends (b) as the fullest expression of the
  minimize-host-surface north star; (a) is the minimum for the flip. Decide at
  INC-A start; (b) is preferred but larger.
