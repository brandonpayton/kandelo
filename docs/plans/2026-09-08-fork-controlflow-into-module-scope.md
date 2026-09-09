# Pushing fork control flow into the fork-module (Rust): scope + reduction plan

Status: design/scoping only (read-only investigation; no code changed).
Worktree: `/Users/brandon/kandelo-abi44-reconcile`, branch
`brandonpayton/rust-first-abi44-reconcile`.
Author lens: the campaign's minimize-host-surface north star applied to fork —
shrink the TypeScript fork glue toward its irreducible host floor by moving
orchestration into the co-resident Rust `fork-module`.

## Executive summary

The reference/capture ENGINE and the reconstruction DRIVE already live in the
module (Path A/B + P6/A5 deleted ~13k lines of JS reference engine). What
remains in the task's scope is the *continuation orchestration* glue:
`host/src/fork-module-backend.ts` (1068 lines), the module-backed branches of
`host/src/fork-process-continuation.ts` (1775 lines total), plus the fork
sequencing in `host/src/worker-main.ts` (process path ~3520-5450, thread path
~6450-7400).

Realistic verdict: of roughly **~2100 lines of in-scope orchestration glue**
(backend 1068 + the module branches of the coordinator ~900), an estimated
**~1300-1500 lines are movable/deletable** (coarser `fm_*` phase entries,
retiring `ForkFixedFrameArena`, dropping 11 proof-of-use counters + 6 decode
accessors, and deleting the now-vestigial JS continuation twin), leaving a
**~600-800 line irreducible host floor**: worker spawn, the guest run-loop +
fork-unwind exception catch, the real `fork()` syscall + syscall-channel
transport, `resolve_externref` identity materialization, anyref-transit
`Table.grow` sizing, PIC placement, the resume `WebAssembly.Table`, and the
Node/browser worker-message bridges. The `fm_*` surface itself
(**84 exports today**) is the internal host↔module contract, NOT the guest ABI
(5 frozen `__wpk_fork_*` exports), so almost all of this work is **ABI-neutral**
(host↔module only). Headline effort: **L (multi-increment)**, front-loaded by
two low-risk wins (retire `ForkFixedFrameArena`; drop proof-of-use counters)
worth ~350 lines before touching any delicate sequencing.

Major caveat: the single largest reduction (deleting the JS continuation twin in
the coordinator, ~600-900 lines) is gated on a **policy decision** — the JS
frame/journal path is still a live fallback when a fork cannot be module-backed
(`useForkModule` false at `worker-main.ts:3752`: catalog > 16384, ptr-width
mismatch, or an instrumented fork-from-thread child without a resume-thread
export). It is not dead code today. Retiring it means making the module back
*every* fork and failing loud otherwise — the same ruling the campaign already
made for the reference engine but has NOT yet made for the frame continuation.

---

## 1. Inventory of current host-side fork responsibilities

Each item cites the authoritative site. "Backend" =
`host/src/fork-module-backend.ts`; "Coordinator" =
`host/src/fork-process-continuation.ts`; "WM" = `host/src/worker-main.ts`.

1. **Drive-sequencing / ordering of `fm_*` calls.** The backend is a thin 1:1
   wrapper over 84 `fm_*` exports; each method validates args, calls one export,
   and checks `fm_last_errno` (`requireOk`, Backend:1050). The *order* is owned
   by the coordinator's module branches:
   - parent: `beginModuleCapture` (Coordinator:902) → `sealModuleCapture` (:956)
     → `beginModuleParentReplay` (:1003), interleaving `backend.beginUnwind`
     (Backend:671) / `finishUnwindAndSerialize` (:701) / `beginParentReplay`
     (:731) with the guest exports `wpk_fork_unwind_begin/end`,
     `wpk_fork_rewind_begin` (`invokeForkContinuationBegin`).
   - child: `attachModuleChild` (Coordinator:1059) / `attachBorrowedModuleChild`
     (:1235) sequence `backend.attachChild`/`attachBorrowedChild` →
     `restoreModuleState(typedDrive)` → `beginChildReplay` (Backend:755) →
     `addActivationChildReplay` loop → `wpk_fork_rewind_begin` loop.

2. **Capture/replay/abort phase orchestration.** The phase state machine
   (`idle|capture|sealed-parent|parent-replay|child-replay|abort-replay`,
   Coordinator:49-55) + `requirePhase` guards, and the guest run-loop in
   WM:5297-5448 that runs `_start`/`wpk_fork_resume_start`, catches the private
   fork-unwind exception (`isForkUnwindException`, WM:5305), and on
   `phase === "capture"` calls `sealCapture()` then dispatches to
   `beginParentReplay` / `beginAbortReplay` / the gated `beginCaptureAbort`.

3. **Frame-arena / allocator management.** `ForkFixedFrameArena` (Backend:79-143)
   + `FORK_MODULE_FRAME_SLAB_BYTES` / `_JOURNAL_SLAB_BYTES` /
   `_MODULE_STATE_RESERVE_BYTES` / `singleActivationFrameBudget()` (Backend:648),
   the `*_fixed_arena` export calls (`fm_begin_unwind_fixed_arena` Backend:671,
   `fm_serialize_journal_fixed_arena` :701,
   `fm_add_activation_unwind_fixed_arena` :920), and the once-per-fork cursor
   `reset()` (WM:4319). This is the bounded in-guest arena from Fix X.

4. **Child-install sequencing.** Mostly *already collapsed into the module*:
   `fm_attach_child` / `fm_attach_borrowed_child` (lib.rs:4769/4792) append
   `DRIVE_OP_RESTORE`/`DRIVE_OP_FINISH_RESTORE` steps that `call_indirect` the
   guest's `wpk_fork_module_state_restore`. The host still orders
   `registry.attachChild` → `readProcessLaunchRoot` → `backend.attachChild` →
   `restoreModuleState` → manifest decode (`activationRootsFromChildArena`
   Coordinator:1399) → replay seeding (Coordinator:1136-1203).

5. **Custom-section (codec/catalog) seeding timing.** Once-per-worker staging of
   host-decoded custom-section bytes into guest scratch then into the module:
   `setActivationGcCodec` (Backend:381), `setActivationResumeCatalog` (:836),
   `setActivationCatalogBase` (:879), `setActivationStaticRootBase` (:897),
   `setHostExceptionOwner` (:411), and `setup()` (:267, format + resume
   catalog). Called from WM ~4956-5203 and Coordinator via
   `options.forkModuleFrameFlip.backend.setActivationResumeCatalog` (WM:881).

6. **Error → process-lifecycle translation.** The gated-reference EOPNOTSUPP
   abort (WM:5337-5372, `takeUnsupportedReferenceKind`), `childPid < 0` →
   `beginAbortReplay(-childPid)` (WM:5384), the reserve-failure →
   `beginCaptureAbort` path (Coordinator:750, the P-11 gap), and the
   errno→throw/`ContinuationAllocationError(ENOMEM)` translation in the backend
   (Backend:132, :1050).

7. **Worker spawn / lifecycle.** Worker creation, `port.postMessage({ready})`
   (WM:5247), the `for(;;)` entry loop, `kernel_exit`. Host/JS only.

8. **Syscall-channel dispatch + the real `fork()`.** `sendForkSyscall`
   (WM:5376), `continuationMmap`/`continuationMunmap` (WM:4651-4668), channel
   base. The actual `fork()`/`vfork()` kernel syscall.

9. **Node/browser platform bridges.** `resolve_externref(handle)->externref`
   (`createForkModuleHostCapabilities`, WM:3624), anyref-transit `Table.grow`
   sizing (`prepareTransit`, referenced Backend:602), the PIC placement globals
   (`env.__memory_base`/`__stack_pointer`/`__table_base`/
   `__indirect_function_table`, fork-module-instance.ts:5-9), the resume
   `WebAssembly.Table` (`ForkResumeTable`, Coordinator:132), the 5 flipped frame
   imports binding (WM:4709-4721), and worker messages
   (`fork_module_frames`/`fork_module_proof`/`fork_module_region`).

10. **Reference identity floor.** `fork-reference-broker.ts` (resolve_externref),
    `fork-externref-provenance.ts` (WeakMap/`Rooted` value→handle identity),
    `fork-function-catalog.ts` + `fork-static-root-catalog.ts` (catalog
    host-reads), `fork-anyref-transit.ts` (STORE #2 sizing). These were already
    ruled floor by the campaign.

11. **Decode-graph accessors for the host-side exnref gate.**
    `decodeReferenceGraph` (Backend:528) + `decodedNodeKind/…ModuleActivation/
    …Ordinal` (:555/:570/:586), called per-node in WM:4601-4633 solely to feed
    `assertForkModuleExnrefTagsDeclared` (the exnref tag-validity boundary,
    `fork-module-exnref-admission.ts`).

---

## 2. Movable vs. irreducible-floor

### (a) Movable into the Rust module

| Responsibility | Why movable | Mechanism |
|---|---|---|
| Drive-sequencing (item 1) | The module already calls guest exports via `call_indirect` through the host-bound `__wpk_fork_drive_table` (this is exactly how `fm_attach_child`'s `DRIVE_OP_RESTORE` invokes `wpk_fork_module_state_restore`). The same technique can append `wpk_fork_rewind_begin/end` and `wpk_fork_unwind_end` as drive steps, collapsing the host's interleaved call sites into a few coarse `fm_*` phase entries. | New coarse entries `fm_parent_capture` / `fm_parent_replay` / `fm_child_attach` / `fm_abort` that internally sequence today's fine-grained exports + bound guest-export drive steps. |
| Frame-arena management (item 3) | In-flight: a separate effort moves frame allocation to the guest allocator, retiring `ForkFixedFrameArena` and the `*_fixed_arena` exports. | Guest-allocator frame chunks (see §4). Deletes ~230 backend lines + the 3 `_fixed_arena` variants. |
| Proof-of-use counters (item 1, 11 exports) | Pure diagnostics (`fm_frames_committed` … `fm_externref_handles_scanned`). 8 backend methods (Backend:293-372) + `fork_module_frames`/`fork_module_proof` plumbing. | Fold into one `fm_stats` struct read, or drop entirely once the flip is trusted. |
| Decode accessors + host-side exnref gate (item 11) | The 3 per-node accessors + `decodeReferenceGraph` exist only because the module lacks exception-codec seeding, so the host re-checks exnref tag validity. Seeding the exception codec (the GC-codec seeding at Backend:381 proves this is feasible) lets `GcCodecHints`'s exnref arm validate in Rust. | Seed exception codec → move `assertForkModuleExnrefTagsDeclared` into `build_reconstruction_steps` (lib.rs:721). Deletes ~120 backend lines + WM:4601-4633 + 4 `fm_*` exports. |
| Child-install ordering residue (item 4) | Partially already moved. The manifest decode + replay-seed loop can become drive steps appended by `fm_child_attach`. | Extend `fm_attach_child`/`fm_attach_borrowed_child`. |
| JS continuation twin (item 2, non-module coordinator branches) | Vestigial once the module backs every fork. `beginCapture`/`sealCapture`/`beginParentReplay`/`attachChild`/`attachBorrowedChild`/`beginAbortReplay`/`beginCaptureAbort` JS bodies + `this.events` journal (`ForkReplayEventJournal`) + `LinkedForkContinuation` frame storage. | **Deletion, not a move** — gated on the policy decision below. ~600-900 lines across the coordinator + parts of `fork-continuation.ts` (1040) / `fork-replay-events.ts` (738, minus the resume-table half). |

### (b) Irreducible host floor (must stay host-side, with the concrete blocker)

| Floor item | Blocker (why it cannot move to Rust) |
|---|---|
| Worker spawn + lifecycle (item 7) | Only the host can create a `Worker` / spawn the child process worker. No Wasm capability. |
| Guest run-loop + fork-unwind exception catch (item 2) | The private fork-unwind is a thrown JS exception the guest raises; a Wasm module cannot `try/catch` the guest's host-level throw, nor select `_start` vs `wpk_fork_resume_start` entry. This is JS-only control flow (WM:5297-5316). |
| The real `fork()`/`vfork()` syscall + channel transport (item 8) | `sendForkSyscall` is a kernel syscall over the shared channel; the child worker is spawned by the host in response. The module has no syscall-issuing authority for process creation. |
| `resolve_externref(handle)->externref` (item 9/10) | A Wasm module cannot hold a live `externref` in Rust or materialize one from a handle; only the JS engine can (idempotent identity cache). This is the one true engine-floor seam. |
| Anyref-transit `Table.grow` sizing (item 9) | Rust/LLVM does not emit `table.grow` for the host-owned anyref transit table; the module cannot size STORE #2 from Rust (documented Backend:602). Host must `Table.grow` before drive. |
| PIC placement globals (item 9) | `__memory_base`/`__stack_pointer`/`__table_base` are host-chosen at instantiation so the module relocates off the guest's low offsets. Chicken-and-egg: the module cannot place itself. |
| Resume `WebAssembly.Table` (item 9) | The guest's `__wpk_fork_resume_table` is a funcref table of guest thunks; the module returns a slot INDEX (`fm_resume_peek`) but the table itself must be a host-built import. |
| Reference identity provenance (item 10) | externref value→handle identity (WeakMap/`Rooted`) and funcref/static-root catalog host-reads are the live-value→coordinate translation; the module only ever sees resolved i32/i64 coordinates. |
| Node/browser worker-message bridge (item 9) | `fork_module_region` inherit-base, ready signal, diagnostics channel — host transport. |

---

## 3. Target end-state

**`fm_*` surface after the move (84 → ~40-45 exports).** Consolidate the
fine-grained sequencing into ~4 coarse phase entries plus the existing
capture/leaf-feed/reconstruction exports:

- Parent: `fm_parent_capture(arena_root)` (internally: begin_unwind →
  finish_unwind → serialize), `fm_parent_replay()` (begin_replay + appended
  `wpk_fork_rewind_begin/end` drive steps).
- Child: `fm_child_attach(arena_root, pid, borrowed)` (already ~90% here via
  `fm_attach_child`/`fm_attach_borrowed_child`; absorb the seed/replay loop).
- Abort: `fm_abort_replay(errno)` (unifies `fm_begin_abort`/`fm_finish_abort`,
  and — the P-11 fix — a module-mode partial-capture abort, see §4).
- Keep as-is: the 18 `fm_capture_*`, the 10 `fm_ref_*` leaf feeds, the
  reconstruction drive (`fm_build_gc_plan`/`fm_drive_execute`/`fm_gc_plan_count`),
  `fm_set_*` seeding (item 5), `fm_last_errno`.
- Delete: the 11 proof-of-use counters, the 6 decode accessors, the 3
  `*_fixed_arena` variants + their `_alloc` siblings.

**Line reduction (in-scope files):**

- `fork-module-backend.ts` 1068 → **~250-350** (a thin RAII driver: `setup` +
  the 4 coarse phase calls + errno check + `wptr`/`toNum` helpers). Removes
  `ForkFixedFrameArena` (~230), the 8 proof-of-use methods (~90), the 6 decode
  accessors (~120), and collapses ~470 lines of 1:1 wrappers to ~150.
  **Reduction ~750-800 lines.**
- `fork-process-continuation.ts` module branches ~900 → **~350-450** as
  sequencing collapses into coarse entries; the JS twin branches (~600-900,
  spanning this file + `fork-continuation.ts` + `fork-replay-events.ts`) delete
  *if* the JS fallback is retired. **Reduction ~1000-1200 lines (policy-gated).**
- `worker-main.ts` fork paths: the seeding block (WM:4956-5203, ~250) shrinks as
  `fm_set_*` consolidates; the decode/exnref-gate block (WM:4601-4633, ~80)
  deletes with the module-side gate. The completion loop and syscall/spawn floor
  stay. **Reduction ~150-250 lines.**

**Retained host floor: ~600-800 lines** across worker spawn, the run-loop +
exception catch, `sendForkSyscall`/channel, `resolve_externref`, transit
`Table.grow`, PIC placement, the resume table, and worker-message plumbing —
plus the already-ruled floor files (`fork-reference-broker.ts`,
`fork-externref-provenance.ts`, `fork-function-catalog.ts`,
`fork-static-root-catalog.ts`, `fork-anyref-transit.ts`).

---

## 4. Interaction with in-flight work

- **Guest-allocator frame move (retiring `ForkFixedFrameArena`).** Folds in as
  the first movable component (§6 Phase 1). It deletes ~230 lines of backend
  arena code + the 3 `*_fixed_arena` exports and removes the per-fork
  `reset()` coupling (WM:4319). Prerequisite ordering note: this is also what
  makes a forked child's memory match the parent (the Fix-X bounded arena was
  itself a workaround for on-demand channel-mmap growing the clone; see the
  2026-09-08 ledger entries). If frames move to the guest allocator, the whole
  arena-sizing surface (`singleActivationFrameBudget`, the slab constants)
  disappears.

- **Module-mode partial-capture-abort (the P-11 fix).** Today
  `beginCaptureAbort` (Coordinator:750) is JS-engine only; there is no module
  sibling, so a mid-unwind `fm_*_reserve` returning 0 (arena/allocator
  exhaustion) surfaces as a `kernel_fork` capture re-entry that trips the
  `phase !== "idle"` guard and traps ("fork import reached while capture",
  WM:~4303). The correct fix routes the reservation failure through the SAME
  completion path the `childPid < 0` branch uses
  (`sealCapture()` → `beginAbortReplay(errno)` → `fm_begin_abort`), with the
  guest driven to `ABORT_UNWINDING` at the correct point (NOT mid
  `select_unwind_frame` — two naive attempts trapped/hung, see
  task-p10-p11-fix-report.md). This is a **precondition** for a coarse
  `fm_abort_replay` entry and for retiring the JS `onReservationAbort` closure,
  so it folds into Phase 3 (the abort-consolidation increment). It also fixes
  multi-activation (dlopen) arena exhaustion, currently a latent trap.

---

## 5. ABI impact

**This is host↔module only. No guest-ABI bump, no guest re-instrument, for the
core of the work.** The `fm_*` surface (84 exports) is the internal contract
between the host driver and the co-resident module, which ship in lockstep
(rebuilt together by `crates/fork-module/build-wasm.sh` + staged into
`local-binaries/source-only-v1/`). It is NOT the guest ABI. The frozen guest
contract is the 5 `__wpk_fork_*` exports the module re-exports
(`__wpk_fork_frame_{reserve,commit,peek,next}` + `__wpk_fork_resume_peek`,
lib.rs:3165-3224) plus the guest's `wpk_fork_*` drive-target exports and the
`kandelo.wpk_fork.*` custom sections — none of which this refactor touches.
`ABI_VERSION` (44) guards those, plus syscall marshalling, memory layout, and
VFS metadata. Coarsening/deleting `fm_*` exports, dropping proof counters, and
moving the exnref gate all stay inside the module and its host driver.

**Steps that WOULD touch the guest artifact contract (flag + stop):**

1. Appending guest-export calls (`wpk_fork_rewind_begin/end`) as module drive
   steps requires those guest exports to be present in the host-bound
   `__wpk_fork_drive_table`. If any is not already table-eligible in the
   instrumented guest, that is a **fork-instrument change → guest re-instrument
   → package rebuild** (guest-observable), and must be treated as its own
   ABI-considered increment.
2. The guest-allocator frame move: if it changes the linked-frame chunk geometry
   or the `kandelo.wpk_fork.linked_frames` descriptor, that is guest-visible and
   ABI-adjacent even if the structural snapshot is unchanged (per the ABI
   contract's "semantic change" clause). Assess with `check-abi-version.sh` and
   a re-instrument test before claiming ABI-neutral.
3. Retiring the JS continuation fallback removes the `useForkModule=false` path;
   if any instrumented guest relied on the JS resume-thread handling
   (fork-from-thread without a resume-thread export, WM:3753), it now fails loud
   — a behavior change to surface to the user, though not an ABI bump.

Everything else (backend collapse, proof-counter removal, exnref-gate move,
coordinator twin deletion) is ABI-neutral host↔module work.

---

## 6. Phased plan + effort + risks

Ordered by **reduction-per-effort, biggest safe win first.** Each phase is
independently testable (host-native `cargo test -p fork-codec` + Node Vitest
fork suites + `check-abi-version.sh`); the browser Playwright + conformance
battery batches at the end. Every phase rebuilds `fork_module{32,64}.wasm` and
re-syncs `local-binaries/source-only-v1/` (the build-wasm.sh footgun).

**Phase 0 — Drop proof-of-use counters (S, low risk, ~200 line reduction).**
Delete the 11 `fm_*` counter exports + 8 backend methods + the
`fork_module_frames`/`fork_module_proof` worker messages, or fold into one
`fm_stats`. Pure diagnostics; no behavior. Risk: a few tests assert nonzero
counts (the flip proof suites) — convert to a single stats assertion.

**Phase 1 — Retire `ForkFixedFrameArena` via the guest allocator (M, ~250 line
reduction).** Land with the in-flight frame-allocator move. Deletes the arena
class + slab constants + `singleActivationFrameBudget` + the 3 `*_fixed_arena`
exports + the per-fork `reset()`. Risk: fork-memory-clone parity (the Fix-X
fixtures) and deep-fork ENOMEM behavior — must A/B `fork-memory-clone-guest` +
`vfork-production-mechanism` + P-10 on both hosts. ABI: assess frame-geometry
per §5.2.

**Phase 2 — Move the exnref tag-validity gate into the module (M, ~200 line
reduction).** Seed the exception codec (mirror `setActivationGcCodec`), move
`assertForkModuleExnrefTagsDeclared` into `build_reconstruction_steps`, delete
the 6 decode accessors + `decodeReferenceGraph` + WM:4601-4633. Risk: the gate
is a fail-loud boundary — needs a corrupt-exnref-recipe test proving it still
`EINVAL`s in Rust. WebKit re-confirm (the host-exception path was WebKit-fragile).

**Phase 3 — Coarse phase entries + module-mode partial-capture-abort (L, ~400
line reduction, highest risk).** Introduce `fm_parent_capture`/`fm_parent_replay`/
`fm_child_attach`/`fm_abort_replay`; append `wpk_fork_rewind_begin/end` as drive
steps; land the P-11 abort fix (§4). Collapses the coordinator's module branches
+ the backend's fine-grained wrappers. Risks: **reentrancy** (module→guest→module
during drive — the borrow-safety the `ReferenceFeedCell` doc calls out); the
guest unwind state machine (driving abort mid-`select_unwind_frame` traps);
cross-host parity of the reentrant `call_indirect` drive (Chromium nested-fork +
WebKit were both historically fragile here). Fork-instrument change per §5.1 if
any guest export is not table-eligible.

**Phase 4 — Retire the JS continuation twin (L, ~800-1000 line reduction,
policy-gated).** Decision required: make the module back *every* fork (raise/
handle the resume-catalog cap; give the instrumented fork-from-thread child a
module resume path) and fail loud otherwise, mirroring the reference-engine
ruling. Then delete the non-module coordinator branches, `this.events`
(`ForkReplayEventJournal`), and the `LinkedForkContinuation` frame storage
(keeping the resume-table half of `fork-replay-events.ts`). Risk: this removes
the last fork fallback — needs the P-11/Phase-3 abort to be rock-solid and a
full cross-host + dlopen + vfork + fork-from-thread battery. Biggest single
reduction but must come last.

**Phase 5 — Batch validation + M-SHIP.** One cross-host module-only run (Node
Vitest full + browser Playwright fork smoke on Chromium+WebKit + host-native +
libc/posix/sortix), `check-abi-version.sh`, freshness re-sync, then curated
commits for user merge.

**Top risks (cross-cutting).**
- *Reentrancy / borrow-safety*: the module→guest→module drive loop must keep each
  `fm_*` export borrowing its resident cell fresh and returning before re-entry
  (the pattern already documented for `ReferenceFeedCell`/`REFERENCE_STATE`).
  Coarse entries widen the window; audit every appended drive step.
- *Host-capability boundaries*: do NOT try to move `resolve_externref`, transit
  `Table.grow`, worker spawn, or the run-loop exception catch — they are the
  proven floor; a "clever" move here reintroduces a Node/browser divergence.
- *Cross-host parity*: every phase is Node + browser (the campaign repeatedly hit
  Chromium-only nested-fork traps and WebKit-only reflection/OOM issues that Node
  masked). No phase is complete on Node alone.
- *Validation cost*: fork changes are only truthfully validated by the guest
  conformance path (deep fork, dlopen, vfork, fork-from-thread), not unit tests —
  budget the browser battery for each of Phases 1, 3, 4.
- *Freshness*: `build-wasm.sh` does not write `source-only-v1/`; every rebuild
  must `cp host/wasm/*.wasm → local-binaries/source-only-v1/` or the stale module
  runs silently (and a size change 500s the browser projection manifest).
