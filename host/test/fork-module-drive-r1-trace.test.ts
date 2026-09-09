// Phase 6 item 3c / M2 — EMPIRICAL trace + regression cover for the GC DRIVE
// post-allocate integrity check AND the M2 R1 externref-transit guard, both
// reading the CORRECT store.
//
// WHAT THIS PINS DOWN
// -------------------
// The co-resident fork module's real topological GC drive plan
// (`fm_build_gc_plan`, crates/fork-codec/src/drive_plan.rs) emits a
// `DRIVE_OP_ALLOC` step for EVERY typed-GC recipe — struct, array, AND i31 —
// carrying that recipe's own id, and (since M2) a `DRIVE_OP_EXTERNREF_TRANSIT`
// step in Phase 0 (before any allocate/fill) for every GC/exnref-reachable
// externref leaf. The injected `fm_drive_execute` shim (crates/fork-module-inject)
// `call_indirect`s the guest's `_gc_allocate` for each ALLOC step and then
// verifies the guest published a live GC object; for a TRANSIT step it resolves
// the leaf through the single residual `env.resolve_externref` host import,
// internalizes it (`any.convert_extern`), `table.set`s it into the anyref
// transit, and asserts non-null.
//
// THE GC-DRIVE FIX this file originally locked in (still true post-M2). The
// shim's post-ALLOC integrity check reads STORE #2 — the shared Wasm-GC transit
// table `__wpk_fork_ref_gc_transit`, the table the guest's `allocate` export
// publishes every struct/array/i31 into at slot `recipe + 1`
// (crates/fork-instrument/src/module_gc_codec.rs) and that `_gc_fill` consumes —
// with a wasm `table.get` + `ref.is_null`, trapping only on a genuinely null
// (never-published) slot.
//
// THE M2 R1 GUARD this file now ALSO locks in. Before M2 the externref R1
// identity guard was a host-side `Object.is` read-back
// (`host_transit_publish`/`host_transit_read`, now DELETED). M2 moved externref
// resolve + transit publish into the injected `fm_drive_execute` shim itself (a
// `DRIVE_OP_EXTERNREF_TRANSIT` step, Phase 0): identity is guaranteed at the
// SOURCE (`ForkExternrefTokenCache.materialize` is idempotent), and the ONLY
// thing expressible on-engine is a wasm non-null structural check — an
// internalized externref is not `ref.eq`-comparable on any engine. See the
// design ruling in
// `docs/superpowers/plans/2026-09-03-m2-externref-into-module.md`. The
// "R1 GUARD" test below proves that check TRAPS a lost/corrupt transit slot
// truthfully — the direct exit criterion for the retired host guard.
//
// VEHICLE: the real `fork_module` + the single real `resolve_externref` host
// import + a FAITHFUL guest double (`fork-module-faithful-guest.ts`) bound into
// the drive table, seeding a REAL multi-node reference graph (arena +
// `fm_begin_reference_replay`, running the REAL Rust bookkeeping pass) plus the
// committed GC-codec fixture, then the REAL `fm_build_gc_plan` +
// `fm_drive_execute`. The faithful double's `gc_allocate` publishes a live
// identity into STORE #2 at `recipe + 1` — the store the shim's wasm check
// reads — mid-drive, mirroring the guest's real `table.set`. The seam is
// INSTRUMENTED by wrapping the `resolve_externref` import in the test only
// (production is byte-identical; no source or ABI change).

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { resolveBinary } from "../src/binary-resolver";
import { instantiateForkModule } from "../src/fork-module-instance";
import { createForkModuleHostCapabilities } from "../src/fork-module-host-capabilities";
import { ForkExternrefTokenCache } from "../src/fork-reference-broker";
import { ForkAnyrefTransitTable } from "../src/fork-anyref-transit";
import { ForkModuleStateArena } from "../src/fork-module-state";
import type { ForkReferenceRecipeEntry } from "../src/fork-reference-recipes";
import {
  appendSegmentedForkReferenceTransaction,
  PagedForkReferenceVector,
  type ForkReferenceVector,
} from "../src/fork-reference-segments";
import { WPK_FORK_REFERENCE_TRANSACTION_OWNER } from "../src/generated/abi";
import { instantiateFaithfulGuest } from "./fork-module-faithful-guest";

const PAGE = 65536;
const PTR_WIDTH = 4 as const;
const PID = 7373;
const GENERATION_ID = 11;
const LEAF_HANDLE = 77;

// The drive-plan op codes and step layout are the contract shared with the Rust
// `drive_plan` module and the injected shim (16-byte steps: op@0, slot@4,
// recipe@8, arg@12).
const DRIVE_OP_ALLOC = 0;
const DRIVE_OP_FILL = 1;
const DRIVE_OP_EXN = 2;
const DRIVE_OP_EXTERNREF_TRANSIT = 4;
const STEP_SIZE = 16;

// The committed GC-codec (KFGC) fixture the Rust `fork-codec` decoder tests use.
// Its layout 1 is a struct (type ordinal 0, DEFAULTABLE_SHELL, two reference
// fields); its layout 4 is a generic array (type ordinal 3, one reference
// element, no constructor dependencies). Both are activation-0 layouts. Seeding
// it lets `fm_build_gc_plan` resolve the struct/array coordinates and the i31
// owner (the smallest GC-declaring activation = 0).
const GC_CODEC = new Uint8Array(
  readFileSync(new URL("../../crates/fork-codec/testdata/gc-codec-wasm32.bin", import.meta.url)),
);

const MODULE = new WebAssembly.Module(readFileSync(resolveBinary("fork_module32.wasm")));

/** Seed a sealed KFMS arena holding `nodes`, then place the GC-codec fixture
 *  bytes just past it so `fm_set_activation_gc_codec` can copy them from guest
 *  memory. Node 0 MUST be the canonical null (the capture validator requires it). */
function buildArena(memory: WebAssembly.Memory, nodes: ForkReferenceRecipeEntry[]): {
  root: number;
  codecPtr: number;
} {
  let next = PAGE;
  const allocate = (size: number): number => {
    const addr = next;
    next += size;
    if (next > memory.buffer.byteLength) {
      memory.grow(Math.ceil((next - memory.buffer.byteLength) / PAGE));
    }
    return addr;
  };
  const arena = new ForkModuleStateArena(memory, PTR_WIDTH, allocate, () => {}, "r1-trace");
  const vectors: ForkReferenceVector[] = [PagedForkReferenceVector.empty];
  const root = arena.begin();
  arena.appendModule({ activationId: 0, templateId: new Uint8Array(32).fill(0xa0) });
  appendSegmentedForkReferenceTransaction(
    arena,
    WPK_FORK_REFERENCE_TRANSACTION_OWNER,
    nodes,
    vectors,
    { segmentDataBytes: 48 },
  );
  arena.seal();
  const codecPtr = allocate(GC_CODEC.byteLength);
  new Uint8Array(memory.buffer, codecPtr, GC_CODEC.byteLength).set(GC_CODEC);
  return { root, codecPtr };
}

interface ForkDriveExports {
  fm_set_format: (pw: number, fp: number) => void;
  fm_set_activation_gc_codec: (act: number, ptr: number, len: number) => void;
  fm_begin_reference_replay: (root: number, pid: number) => void;
  fm_build_gc_plan: (pid: number) => number;
  fm_gc_plan_count: () => number;
  fm_drive_execute: (ptr: number, count: number) => void;
  fm_drive_table_base: (act: number) => number;
  fm_last_errno: () => number;
}

interface ResolveCall {
  handle: number;
  token: unknown;
}
interface DriveStep {
  op: number;
  slot: number;
  recipe: number;
  arg: number;
}
interface ShapeTrace {
  replayErr: number;
  planErr: number;
  planBuilt: boolean;
  steps: DriveStep[];
  /** Every `resolve_externref(handle)` call made DURING `fm_drive_execute`
   *  (a Phase-0 DRIVE_OP_EXTERNREF_TRANSIT step), in order. Empty when the
   *  graph has no reachable externref leaf: with no `wpk_fork_host` seam left
   *  to call, a plain typed-GC graph never touches the host at all. */
  transitResolves: ResolveCall[];
  /** Recipe ids the guest's `gc_allocate` published into STORE #2, in order. */
  published: number[];
  /** The transit slots (`recipe + 1`) non-null in STORE #2 after the drive. */
  liveSlots: number[];
  threw: boolean;
  guestOrder: number;
  guestSeq: number;
  /** The token cache this shape's drive resolved against — exposed so the
   *  caller can independently assert identity parity via `tokens.materialize`. */
  tokens: ForkExternrefTokenCache;
}

/** Drive one graph shape through the real module + real seam + faithful guest
 *  and capture the full trace. `resolve_externref` is instrumented by wrapping
 *  it in the test only (production is byte-identical). ONE anyref transit
 *  table backs both the injected drive's Phase-0 externref-transit publish and
 *  the guest/shim's aggregate publish (STORE #2), exactly like production. */
function runShape(nodes: ForkReferenceRecipeEntry[], maxRecipeId: number): ShapeTrace {
  const memory = new WebAssembly.Memory({ initial: 512, maximum: 16384, shared: true });
  const tokens = new ForkExternrefTokenCache(GENERATION_ID);
  const caps = createForkModuleHostCapabilities({ tokens });

  const resolveLog: ResolveCall[] = [];
  const resolveExternref = (handle: number): unknown => {
    const token = caps.imports.resolve_externref(handle);
    resolveLog.push({ handle, token });
    return token;
  };

  const { root, codecPtr } = buildArena(memory, nodes);
  const fm = instantiateForkModule({
    module: MODULE,
    memory,
    ptrWidth: PTR_WIDTH,
    reserve: () => 8 * 1024 * 1024,
    label: "r1-trace",
    resolveExternref,
  });
  // STORE #2: wrap the fork-module's OWN exported transit table (M1) — not a
  // freshly-minted one — so the guest's publish, the shim's post-ALLOC
  // `table.get`/`ref.is_null` check, and the injected drive's Phase-0
  // externref-transit publish all agree on the SAME table object. Presize it
  // for the graph's max recipe id (mirrors production's
  // `ForkActivationRegistry.ensureRecipeSlot`, which the injected drive's
  // `table.set` does not do itself).
  const transitTable = new ForkAnyrefTransitTable(fm.gcTransitTable);
  transitTable.ensureRecipeSlot(maxRecipeId);
  const x = fm.exports as unknown as ForkDriveExports;

  x.fm_set_format(PTR_WIDTH, 0);
  x.fm_set_activation_gc_codec(0, codecPtr, GC_CODEC.byteLength);
  expect(x.fm_last_errno()).toBe(0);

  x.fm_begin_reference_replay(root, PID);
  const replayErr = x.fm_last_errno();

  const planPtr = x.fm_build_gc_plan(PID);
  const planErr = x.fm_last_errno();
  const count = x.fm_gc_plan_count();
  const dv = new DataView(memory.buffer);
  const steps: DriveStep[] = [];
  for (let i = 0; i < count; i++) {
    const b = planPtr + i * STEP_SIZE;
    steps.push({
      op: dv.getUint32(b, true),
      slot: dv.getUint32(b + 4, true),
      recipe: dv.getUint32(b + 8, true),
      arg: dv.getUint32(b + 12, true),
    });
  }

  // Bind the FAITHFUL guest exports into the host-owned drive table so the shim's
  // `call_indirect`s resolve (base+ALLOC, base+FILL, base+EXN). The guest's
  // `gc_allocate` publishes a live identity into STORE #2 (the shared
  // `transitTable`) at `recipe + 1` mid-drive.
  const { guest, published } = instantiateFaithfulGuest(transitTable);
  const base = x.fm_drive_table_base(0);
  if (fm.driveTable.length < base + 3) fm.driveTable.grow(base + 3 - fm.driveTable.length);
  fm.driveTable.set(base + DRIVE_OP_ALLOC, guest.gc_allocate);
  fm.driveTable.set(base + DRIVE_OP_FILL, guest.gc_fill);
  fm.driveTable.set(base + DRIVE_OP_EXN, guest.exception_materialize);

  const preDriveLen = resolveLog.length;
  let threw = false;
  if (planPtr !== 0) {
    try {
      x.fm_drive_execute(planPtr, count);
    } catch {
      threw = true;
    }
  }
  const transitResolves = resolveLog.slice(preDriveLen);

  // Which STORE #2 slots hold a live (non-null) identity after the drive.
  const liveSlots: number[] = [];
  for (let slot = 1; slot < transitTable.table.length; slot++) {
    if (transitTable.get(slot) !== null) liveSlots.push(slot);
  }

  return {
    replayErr,
    planErr,
    planBuilt: planPtr !== 0,
    steps,
    transitResolves,
    published: [...published],
    liveSlots,
    threw,
    guestOrder: guest.order(),
    guestSeq: guest.seq(),
    tokens,
  };
}

// -- Graph shape builders (node 0 is always the canonical null) ---------------
const NULL: ForkReferenceRecipeEntry = { id: 0, node: { kind: "null" } };
const struct = (id: number, fields: number[]): ForkReferenceRecipeEntry => ({
  id,
  // Fixture layout 1: struct, type ordinal 0, defaultable shell, two ref fields.
  node: { kind: "struct", moduleActivation: 0, typeOrdinal: 0, layoutId: 1, scalars: new Uint8Array(4), fields },
});
const array = (id: number, elements: number[]): ForkReferenceRecipeEntry => ({
  id,
  // Fixture layout 4: generic array, type ordinal 3, one ref element, no deps.
  node: { kind: "array", moduleActivation: 0, typeOrdinal: 3, layoutId: 4, scalars: new Uint8Array(0), elements },
});
const i31 = (id: number, value: number): ForkReferenceRecipeEntry => ({ id, node: { kind: "i31", value } });
const externref = (id: number, handle: number): ForkReferenceRecipeEntry => ({ id, node: { kind: "externref", handle } });
const exnref = (id: number): ForkReferenceRecipeEntry => ({
  id,
  node: { kind: "exnref", moduleActivation: 0, tagOrdinal: 0, layoutId: 0, scalars: new Uint8Array(0), payloads: [] },
});

describe("fork-module GC drive store-#2 integrity check + M2 externref-transit R1 guard (Phase 6 item 3c)", () => {
  it("Shape 1 — single struct over i31 leaves (typed, NO externref): every ALLOC publishes store #2 and the drive COMPLETES", () => {
    // struct(1) [layout 1] fields -> i31(2); no externref anywhere.
    const t = runShape([NULL, struct(1, [2, 2]), i31(2, 7)], 2);

    expect(t.replayErr).toBe(0); // reconstruction admits a typed-only graph
    expect(t.planBuilt).toBe(true); // the real plan builds
    // The plan ALLOCs the struct (recipe 1) AND the i31 (recipe 2) — proving i31
    // is an ALLOC-emitting recipe too, then FILLs the struct. No externref -> no
    // TRANSIT step.
    expect(t.steps.map((s) => [s.op, s.recipe])).toEqual([
      [DRIVE_OP_ALLOC, 1],
      [DRIVE_OP_ALLOC, 2],
      [DRIVE_OP_FILL, 1],
    ]);
    // The guest's gc_allocate published a live identity into STORE #2 for EACH
    // ALLOC recipe (struct 1, i31 2), at slots recipe+1 = 2 and 3.
    expect(t.published).toEqual([1, 2]);
    expect(t.liveSlots).toEqual([2, 3]);
    // No externref leaf -> the drive never touches the host seam.
    expect(t.transitResolves).toHaveLength(0);
    // Guest ran alloc, alloc, fill (order 1,1,2 -> 112) and did not trap.
    expect(t.guestSeq).toBe(3);
    expect(t.guestOrder).toBe(112);
    expect(t.threw).toBe(false);
  });

  it("Shape 2 — struct<->array cycle (NO externref leaf): allocate-all-first, both aggregates publish store #2, the drive COMPLETES", () => {
    // struct(1) <-> array(2), no externref leaf.
    const t = runShape([NULL, struct(1, [2, 2]), array(2, [1])], 2);

    expect(t.replayErr).toBe(0);
    expect(t.planBuilt).toBe(true);
    // Allocate-all-first breaks the cycle: ALLOC struct(1), ALLOC array(2), then
    // FILL both.
    expect(t.steps.map((s) => [s.op, s.recipe])).toEqual([
      [DRIVE_OP_ALLOC, 1],
      [DRIVE_OP_ALLOC, 2],
      [DRIVE_OP_FILL, 1],
      [DRIVE_OP_FILL, 2],
    ]);
    expect(t.published).toEqual([1, 2]);
    expect(t.liveSlots).toEqual([2, 3]);
    expect(t.transitResolves).toHaveLength(0);
    expect(t.guestSeq).toBe(4);
    expect(t.guestOrder).toBe(1122); // alloc,alloc,fill,fill
    expect(t.threw).toBe(false);
  });

  it("Shape 3 — struct with ONE externref-leaf field (MIXED): the injected drive publishes the LEAF into the anyref transit in Phase 0, BEFORE the struct's ALLOC/FILL, with identity parity", () => {
    // struct(1) [layout 1] fields -> externref(2). Since M2 this is ONE unified
    // plan: a DRIVE_OP_EXTERNREF_TRANSIT step roots the leaf (slot recipe+1 = 3)
    // BEFORE the struct allocates/fills (slot recipe+1 = 2) — the R1 rooting
    // order the retired host PHASE A/B enforced.
    const t = runShape([NULL, struct(1, [2, 2]), externref(2, LEAF_HANDLE)], 2);

    expect(t.replayErr).toBe(0);
    expect(t.planBuilt).toBe(true);
    expect(t.steps.map((s) => [s.op, s.recipe])).toEqual([
      [DRIVE_OP_EXTERNREF_TRANSIT, 2],
      [DRIVE_OP_ALLOC, 1],
      [DRIVE_OP_FILL, 1],
    ]);
    // The TRANSIT step drives no guest export / drive-table slot.
    const transit = t.steps[0];
    expect(transit.slot).toBe(0);
    expect(transit.arg).toBe(0);

    // The drive resolved the leaf's handle EXACTLY ONCE, and the value it
    // resolved is the SAME canonical token `tokens.materialize(handle)` returns
    // (idempotent cache) — identity parity, the M2 replacement for the retired
    // host `Object.is` guard.
    expect(t.transitResolves).toHaveLength(1);
    expect(t.transitResolves[0].handle).toBe(LEAF_HANDLE);
    expect(t.transitResolves[0].token).toBe(t.tokens.materialize(LEAF_HANDLE));

    // The guest published the struct aggregate into store #2 at slot 2.
    expect(t.published).toEqual([1]);
    // Both the aggregate (slot 2) and the Phase-0 externref-transit leaf (slot 3)
    // are live in the SAME table.
    expect(t.liveSlots).toEqual([2, 3]);
    expect(t.threw).toBe(false);
  });

  it("Shape 4 — a bare i31 leaf: even a scalar i31 ALLOC publishes store #2 and the drive COMPLETES", () => {
    // A pure i31 needs no host identity, yet it still gets an ALLOC step; the
    // guest's gc_allocate publishes its store-#2 slot so the shim's check passes.
    const t = runShape([NULL, i31(1, -17)], 1);

    expect(t.replayErr).toBe(0);
    expect(t.planBuilt).toBe(true);
    expect(t.steps.map((s) => [s.op, s.recipe])).toEqual([[DRIVE_OP_ALLOC, 1]]);
    expect(t.published).toEqual([1]);
    expect(t.liveSlots).toEqual([2]);
    expect(t.transitResolves).toHaveLength(0);
    expect(t.guestSeq).toBe(1);
    expect(t.guestOrder).toBe(1);
    expect(t.threw).toBe(false);
  });

  it("Shape 5 — a program exnref (no externref payload): emits an EXN step, runs NO store-#2 check, and the drive COMPLETES", () => {
    // An exnref materialize is `DRIVE_OP_EXN`, which the shim does NOT follow with
    // the store-#2 integrity check. So an exnref-only graph drives cleanly and
    // publishes nothing — the check is specific to ALLOC-emitting recipes.
    const t = runShape([NULL, exnref(1)], 1);

    expect(t.replayErr).toBe(0);
    expect(t.planBuilt).toBe(true);
    expect(t.steps.map((s) => [s.op, s.recipe])).toEqual([[DRIVE_OP_EXN, 1]]);
    // No store-#2 publish (no ALLOC) and no host seam call during the drive
    // (this exnref carries no reference payload).
    expect(t.published).toHaveLength(0);
    expect(t.transitResolves).toHaveLength(0);
    expect(t.threw).toBe(false);
    // The guest exception_materialize (order code 3) actually ran.
    expect(t.guestOrder).toBe(3);
  });

  // POSITIVE store-#2 invariant. The repoint depends on the guest's `allocate`
  // publishing a live GC object into the transit table at `recipe + 1` for EVERY
  // ALLOC-emitting recipe kind (struct, array, i31). A multi-kind graph driven
  // through the module must leave all three aggregate slots non-null AND complete.
  // Asserting it here means a future guest-glue change that stops publishing
  // re-breaks THIS test (the shim would trap), not silently the whole drive.
  it("POSITIVE — struct, array, and i31 each publish a live store-#2 slot; the module drive completes reading them", () => {
    // struct(1) -> array(2) -> i31(3): one of each ALLOC-emitting kind.
    const t = runShape([NULL, struct(1, [2, 2]), array(2, [3]), i31(3, 9)], 3);

    expect(t.replayErr).toBe(0);
    expect(t.planBuilt).toBe(true);
    const allocRecipes = t.steps.filter((s) => s.op === DRIVE_OP_ALLOC).map((s) => s.recipe);
    // All three kinds allocate.
    expect(new Set(allocRecipes)).toEqual(new Set([1, 2, 3]));
    // The guest published a live store-#2 identity for each ALLOC recipe.
    expect(new Set(t.published)).toEqual(new Set([1, 2, 3]));
    // Every ALLOC recipe's slot (recipe + 1) is non-null in the transit table.
    for (const recipe of allocRecipes) {
      expect(t.liveSlots).toContain(recipe + 1);
    }
    // No externref anywhere -> the drive never touches the host seam.
    expect(t.transitResolves).toHaveLength(0);
    expect(t.threw).toBe(false);
    // Every plan step ran through a guest export (proof the drive completed).
    expect(t.guestSeq).toBe(t.steps.length);
  });

  // EQUIVALENCE GATE for the 3c PRODUCTION FLIP — now GREEN. The flip landed:
  //
  //   1. The typed drive-ORDER for a forked child (the JS
  //      `ForkReferenceTransaction.materializeAllTyped`, invoked from
  //      `ForkActivationRegistry.restoreModuleState` at the coordinator seam
  //      `ForkProcessContinuationCoordinator.attachModuleChild`) is now handed to
  //      the module (`backend.driveTypedGraph()`), which SUPPRESSES only the typed
  //      allocate/fill/exn sub-loop of `materializeAllTyped`.
  //   2. Production wiring: each activation's KFGC bytes are seeded via
  //      `setActivationGcCodec` + `setHostExceptionOwner` (worker-main), then the
  //      coordinator calls `fm_build_gc_plan(pid)` + `fm_drive_execute(ptr,
  //      fm_gc_plan_count())`.
  //   3. A distinct DRIVE proof counter (`fm_drive_steps_executed`, bumped by the
  //      walrus-injected shim's `fm_drive_bump`) rides the `fork_module_references`
  //      diagnostic.
  //
  // The cross-flag EQUIVALENCE is proven end-to-end by
  // `host/test/gc-reference-cycle-fresh-worker.test.ts`: a REAL instrumented
  // multi-node guest (struct<->array cycle + i31 leaf) forked in a fresh worker
  // exits 0 with the SAME child outcome flag-off and flag-on, and the flag-on run
  // records `drive_steps_executed > 0` — the module drove the typed order. THIS
  // in-file gate asserts the underlying invariant the equivalence rests on: the
  // REAL module drive (`fm_build_gc_plan` + `fm_drive_execute`) reconstructs a
  // MULTI-NODE typed graph (a struct<->array cycle plus an i31 leaf) to
  // completion — every ALLOC-emitting kind publishes a live store-#2 identity and
  // no step traps — so the plan the production flip executes is a complete,
  // correct drive.
  it("EQUIVALENCE GATE (3c prod flip): the real module drive reconstructs a multi-node typed graph (struct<->array cycle + i31)", () => {
    // struct(1) <-> array(2) cycle, plus a bare i31(3) leaf.
    const t = runShape([NULL, struct(1, [2, 2]), array(2, [1]), i31(3, 42)], 3);

    expect(t.replayErr).toBe(0);
    expect(t.planBuilt).toBe(true);
    // Allocate-all-first breaks the cycle: ALLOC 1, ALLOC 2, ALLOC 3 (i31), then
    // FILL the two aggregates. i31 is a scalar leaf with an ALLOC step and no
    // FILL. The exact order is the same topological walk the JS drive produces.
    const allocRecipes = t.steps
      .filter((s) => s.op === DRIVE_OP_ALLOC)
      .map((s) => s.recipe);
    expect(new Set(allocRecipes)).toEqual(new Set([1, 2, 3]));
    const fillRecipes = t.steps
      .filter((s) => s.op === DRIVE_OP_FILL)
      .map((s) => s.recipe);
    expect(new Set(fillRecipes)).toEqual(new Set([1, 2]));
    // The guest published a live store-#2 identity for every ALLOC recipe.
    expect(new Set(t.published)).toEqual(new Set([1, 2, 3]));
    for (const recipe of allocRecipes) {
      expect(t.liveSlots).toContain(recipe + 1);
    }
    // The drive ran every step through a guest export and never trapped — the
    // whole multi-node plan reconstructs to completion.
    expect(t.threw).toBe(false);
    expect(t.guestSeq).toBe(t.steps.length);
    // No externref anywhere -> the drive never touches the host seam.
    expect(t.transitResolves).toHaveLength(0);
  });

  // -- M2 R1 EXIT CRITERION -----------------------------------------------
  //
  // The pre-M2 Rust `Object.is` R1 identity guard (a host-side read-back
  // comparing the value PHASE B published against the value PHASE A resolved)
  // was REMOVED with the rest of the host transit seam. Its replacement is the
  // injected op-4 (DRIVE_OP_EXTERNREF_TRANSIT) wasm NON-NULL check: after
  // `table.set(transit, recipe+1, any.convert_extern(resolve_externref(...)))`,
  // the shim reads the slot back with `table.get` + `ref.is_null` and TRAPS
  // (`unreachable`) if it is null — the only identity assertion expressible
  // on-engine once the value is an opaque, non-`ref.eq`-comparable internalized
  // externref. This is the load-bearing exit criterion from the T1 review: a
  // lost/corrupt transit slot for a reachable externref must fail LOUD, not
  // silently reconstruct a null or wrong leaf.
  it("R1 GUARD (wasm-level): a resolved-but-lost externref transit slot TRAPS the drive, never silently succeeds", () => {
    // Reuse Shape 3's struct-with-externref-leaf graph, but make
    // `resolve_externref` return null for every handle — simulating a broker
    // handle the host lost / never rooted. The DRIVE_OP_EXTERNREF_TRANSIT step
    // internalizes null (`any.convert_extern(null externref)` = null anyref),
    // `table.set`s it into the transit, reads it back, and TRAPS — BEFORE the
    // struct's ALLOC/FILL ever runs (Phase 0 precedes every allocate/fill).
    const memory = new WebAssembly.Memory({ initial: 512, maximum: 16384, shared: true });
    const { root, codecPtr } = buildArena(memory, [NULL, struct(1, [2, 2]), externref(2, LEAF_HANDLE)]);
    const fm = instantiateForkModule({
      module: MODULE,
      memory,
      ptrWidth: PTR_WIDTH,
      reserve: () => 8 * 1024 * 1024,
      label: "r1-trap-test",
      resolveExternref: () => null,
    });
    // Presize the transit table (mirrors production's `ensureRecipeSlot`) so the
    // trap is the intended non-null structural check, not an unrelated
    // out-of-bounds `table.set` on a too-small default table.
    new ForkAnyrefTransitTable(fm.gcTransitTable).ensureRecipeSlot(2);
    const x = fm.exports as unknown as ForkDriveExports;

    x.fm_set_format(PTR_WIDTH, 0);
    x.fm_set_activation_gc_codec(0, codecPtr, GC_CODEC.byteLength);
    x.fm_begin_reference_replay(root, PID);
    expect(x.fm_last_errno()).toBe(0);

    const planPtr = x.fm_build_gc_plan(PID);
    expect(x.fm_last_errno()).toBe(0);
    const count = x.fm_gc_plan_count();

    // No drive-table binding: the trap fires in Phase 0, before any
    // `call_indirect` would reach the (empty) drive table.
    expect(() => x.fm_drive_execute(planPtr, count)).toThrowError(/unreachable/i);
  });
});
