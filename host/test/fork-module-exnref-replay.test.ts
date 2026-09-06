// Phase 6 D6.3a / M2 — exnref reference reconstruction ORCHESTRATED by the
// co-resident fork module, with the anyref TRANSIT rooting the exnref's
// reachable externref payload through the injected drive plan. Proven end to
// end in a real WebAssembly engine (Node/V8).
//
// This is the exnref analogue of `fork-module-externref-replay.test.ts`. The
// crucial addition over the plain externref (D6.2) case: the graph has an
// EXNREF whose reference payload names an externref, so the externref is
// TRANSIT-REACHABLE. Since M2 this is no longer a host PHASE A/B round-trip:
// `fork_codec::build_drive_plan` emits a `DRIVE_OP_EXTERNREF_TRANSIT` step for
// the reachable payload (Phase 0, before the EXN step), and the injected
// `fm_drive_execute` shim resolves it through the single residual
// `env.resolve_externref` host import, internalizes it (`any.convert_extern`),
// `table.set`s it into the anyref transit at `recipe + 1`, and asserts non-null
// — the M2 replacement for the retired host `Object.is` R1 read-back guard (see
// the design ruling in
// `docs/superpowers/plans/2026-09-03-m2-externref-into-module.md`). The module
// does NOT mint an exception tag or throw: the program exception tag is
// guest-module-local, so the guest export
// `__wpk_fork_exception_materialize` (bound into the drive table, here the
// FAITHFUL guest double) owns the throw/`catch_ref`.
//
// Assertions:
//   (a) TRANSIT IDENTITY (silent-corruption-critical) — the token the injected
//       drive step publishes into the real anyref transit reads back
//       `Object.is`-identical to `tokens.materialize(handle)` (the canonical
//       token the module's lazy externref decode would also return).
//   (b) PROOF OF USE — `fm_exnrefs_reconstructed` advanced by the exnref-node
//       count (bookkeeping, from `fm_begin_reference_replay`) and the drive plan
//       actually resolved the payload exactly once through the host seam.
//   (c) MINT INERT — no exception tag is minted (the deleted `wpk_fork_host.*`
//       `host_mint_exception_tag` seam, H3, is gone — the module no longer
//       even declares the import).
//   (d) R1 GUARD IS LOAD-BEARING — when the host loses the reachable payload's
//       identity (`resolve_externref` returns null for it), the injected
//       non-null check TRAPS the drive rather than silently rooting a null/wrong
//       identity the guest's exception materialize would then throw with.

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
const PID = 5151;
const GENERATION_ID = 9;
// The durable broker handle the exnref's reference payload names.
const PAYLOAD_HANDLE = 44;

const DRIVE_OP_ALLOC = 0;
const DRIVE_OP_FILL = 1;
const DRIVE_OP_EXN = 2;

/**
 * Build a sealed KFMS arena holding an exnref-over-externref graph:
 *   id 0 = canonical null
 *   id 1 = externref naming `PAYLOAD_HANDLE`
 *   id 2 = exnref whose reference payload edge names id 1 (transit-reachable)
 */
function buildExnrefArena(memory: WebAssembly.Memory): number {
  let next = PAGE;
  const allocate = (size: number): number => {
    const addr = next;
    next += size;
    if (next > memory.buffer.byteLength) {
      memory.grow(Math.ceil((next - memory.buffer.byteLength) / PAGE));
    }
    return addr;
  };
  const arena = new ForkModuleStateArena(
    memory,
    PTR_WIDTH,
    allocate,
    () => {},
    "exnref-replay-test",
  );

  const nodes: ForkReferenceRecipeEntry[] = [
    { id: 0, node: { kind: "null" } },
    { id: 1, node: { kind: "externref", handle: PAYLOAD_HANDLE } },
    {
      id: 2,
      node: {
        kind: "exnref",
        moduleActivation: 0,
        tagOrdinal: 0,
        layoutId: 0,
        scalars: new Uint8Array(0),
        payloads: [1],
      },
    },
  ];
  const vectors: ForkReferenceVector[] = [PagedForkReferenceVector.empty];

  const root = arena.begin();
  arena.appendModule({ activationId: 0, templateId: new Uint8Array(32).fill(0xe0) });
  appendSegmentedForkReferenceTransaction(
    arena,
    WPK_FORK_REFERENCE_TRANSACTION_OWNER,
    nodes,
    vectors,
    // Force multi-segment reassembly so the module's decode is exercised.
    { segmentDataBytes: 48 },
  );
  arena.seal();
  return root;
}

interface ForkModuleRefExports {
  fm_set_format: (pw: number, fixedPrefix: number) => void;
  fm_begin_reference_replay: (root: number, pid: number) => void;
  fm_externrefs_resolved: () => bigint;
  fm_exnrefs_reconstructed: () => bigint;
  fm_last_errno: () => number;
  fm_build_gc_plan: (pid: number) => number;
  fm_gc_plan_count: () => number;
  fm_drive_execute: (ptr: number, count: number) => void;
  fm_drive_table_base: (act: number) => number;
  // Phase 6 item 3a RESTORE data-feed exports.
  fm_ref_feed_reads: () => bigint;
  fm_ref_exn_route: (recipeId: number, expectedActivation: number) => number;
  fm_ref_exn_load: (
    recipeId: number,
    moduleActivation: number,
    tagOrdinal: number,
    layoutId: number,
    scalarDestination: number,
    scalarByteLength: number,
    referenceIdsDestination: number,
    referenceCount: number,
  ) => number;
  fm_ref_exn_cache_index: (recipeId: number) => number;
}

const MODULE = new WebAssembly.Module(
  readFileSync(resolveBinary("fork_module32.wasm")),
);

function instantiate(
  memory: WebAssembly.Memory,
  resolveExternref: (handle: number) => unknown,
) {
  const reserveBase = 8 * 1024 * 1024;
  const fm = instantiateForkModule({
    module: MODULE,
    memory,
    ptrWidth: PTR_WIDTH,
    reserve: () => reserveBase,
    label: "exnref-replay-test",
    resolveExternref,
  });
  return { fm, x: fm.exports as unknown as ForkModuleRefExports };
}

/** Bind the FAITHFUL guest's `exception_materialize` (and, defensively, its
 *  alloc/fill) into the module's drive table at activation 0's slice, so the
 *  drive's DRIVE_OP_EXN `call_indirect` resolves. Also presizes the anyref
 *  transit table for the graph's max recipe id, mirroring the production
 *  `ForkActivationRegistry.ensureRecipeSlot(maxRecipeId)` presize the injected
 *  drive's `table.set` (unlike the retired host PHASE B) does NOT do itself. */
function bindFaithfulGuest(
  fm: ReturnType<typeof instantiateForkModule>,
  x: ForkModuleRefExports,
  maxRecipeId: number,
) {
  const transitTable = new ForkAnyrefTransitTable(fm.gcTransitTable);
  transitTable.ensureRecipeSlot(maxRecipeId);
  const { guest } = instantiateFaithfulGuest(transitTable);
  const base = x.fm_drive_table_base(0);
  if (fm.driveTable.length < base + 3) {
    fm.driveTable.grow(base + 3 - fm.driveTable.length);
  }
  fm.driveTable.set(base + DRIVE_OP_ALLOC, guest.gc_allocate);
  fm.driveTable.set(base + DRIVE_OP_FILL, guest.gc_fill);
  fm.driveTable.set(base + DRIVE_OP_EXN, guest.exception_materialize);
  return { transitTable, guest };
}

describe("fork-module exnref reference reconstruction + transit into production (Phase 6 D6.3a / M2)", () => {
  it("roots the exnref's reachable externref payload in the real anyref transit with identity parity, advances the counters, and never mints a tag", () => {
    const memory = new WebAssembly.Memory({ initial: 256, maximum: 16384, shared: true });

    const tokens = new ForkExternrefTokenCache(GENERATION_ID);
    const hostCapabilities = createForkModuleHostCapabilities({ tokens });

    const root = buildExnrefArena(memory);
    const { fm, x } = instantiate(memory, hostCapabilities.imports.resolve_externref);

    x.fm_set_format(PTR_WIDTH, 0);
    expect(x.fm_last_errno()).toBe(0);

    const externrefsBefore = Number(x.fm_externrefs_resolved());
    const exnrefsBefore = Number(x.fm_exnrefs_reconstructed());

    // Seed the reference graph (bookkeeping only).
    x.fm_begin_reference_replay(root, PID);
    expect(x.fm_last_errno()).toBe(0);

    // (b) PROOF OF USE (graph admission) — one exnref admitted, one externref
    // node counted, purely from bookkeeping.
    expect(Number(x.fm_exnrefs_reconstructed()) - exnrefsBefore).toBe(1);
    expect(Number(x.fm_externrefs_resolved()) - externrefsBefore).toBe(1);

    // Build + execute the real drive plan: PHASE 0 publishes the reachable
    // externref payload into the anyref transit; the EXN step then drives the
    // guest's exception materialize.
    const planPtr = x.fm_build_gc_plan(PID);
    expect(x.fm_last_errno()).toBe(0);
    const count = x.fm_gc_plan_count();

    const { transitTable, guest } = bindFaithfulGuest(fm, x, 2);

    x.fm_drive_execute(planPtr, count);

    // (a) TRANSIT IDENTITY — the token the drive published for the payload is
    // the SAME object `tokens.materialize(handle)` returns (idempotent cache),
    // and it is what actually sits in the real anyref transit slot (recipe_id 1
    // -> slot 2).
    const canonical = tokens.materialize(PAYLOAD_HANDLE);
    expect(transitTable.get(2)).toBe(canonical);
    expect(hostCapabilities.resolvedCount).toBe(1);

    // The EXN step actually ran (the guest's exception_materialize order code).
    expect(guest.order()).toBe(3);

    // (c) MINT INERT — the drive never mints an exception tag: the guest
    // export owns exception materialization. This used to be proven by
    // spying on a `host_mint_exception_tag` stub (`wpk_fork_host.*` seam);
    // that seam was deleted (H3, 2026-09-06) because it was never wired to
    // any guest, so the proof is now structural: the module no longer even
    // declares the import.
  });

  it("R1 GUARD (wasm-level): a resolved-but-lost externref payload TRAPS the drive, never silently mis-roots the exnref's identity", () => {
    // The retired host `Object.is` R1 guard is replaced, in M2, by the injected
    // `fm_drive_execute` shim's non-null structural check on the transit slot
    // (see the design ruling). Simulate the host losing the payload's identity
    // (`resolve_externref` returns null for it): the DRIVE_OP_EXTERNREF_TRANSIT
    // step internalizes null, `table.set`s it, reads it back, and TRAPS —
    // failing loud rather than letting the guest's exception materialize
    // consume a null/wrong payload.
    const memory = new WebAssembly.Memory({ initial: 256, maximum: 16384, shared: true });

    const root = buildExnrefArena(memory);
    const { fm, x } = instantiate(memory, () => null);

    x.fm_set_format(PTR_WIDTH, 0);
    x.fm_begin_reference_replay(root, PID);
    expect(x.fm_last_errno()).toBe(0);

    const planPtr = x.fm_build_gc_plan(PID);
    expect(x.fm_last_errno()).toBe(0);
    const count = x.fm_gc_plan_count();

    // Presize the transit table (mirrors production's `ensureRecipeSlot`) so the
    // trap below is the intended non-null structural check, not an unrelated
    // out-of-bounds `table.set` on a too-small default table.
    new ForkAnyrefTransitTable(fm.gcTransitTable).ensureRecipeSlot(2);

    expect(() => x.fm_drive_execute(planPtr, count)).toThrowError(/unreachable/i);
  });

  it("serves the exnref RESTORE data-feed through the module (item 3a): route, cache index, and scalar/reference loads match the decoded graph", () => {
    // Phase 6 item 3a: the exnref restore imports the guest exception codec used
    // to call on the JS reference provider now resolve to the module's `fm_ref_*`
    // exports. Drive them directly against the seeded feed and prove the MODULE
    // produced JS-identical results, in a real WebAssembly engine. This data
    // feed does not touch the externref transit at all, so a resolver that is
    // never expected to be called is enough.
    const memory = new WebAssembly.Memory({ initial: 256, maximum: 16384, shared: true });
    const root = buildExnrefArena(memory);
    const { x } = instantiate(memory, () => {
      throw new Error("resolve_externref should not be called by the data feed");
    });
    x.fm_set_format(PTR_WIDTH, 0);
    x.fm_begin_reference_replay(root, PID);
    expect(x.fm_last_errno()).toBe(0);

    const readsBefore = Number(x.fm_ref_feed_reads());

    // exnref id 2: activation 0, tag 0, layout 0, no scalars, payload edge [1].
    expect(x.fm_ref_exn_route(2, 0)).toBe(0); // layout id
    expect(x.fm_ref_exn_route(2, 9)).toBe(-1); // wrong activation -> sentinel
    expect(x.fm_ref_exn_cache_index(2)).toBe(1); // first (only) exnref

    // Load the exnref: no scalar bytes, one reference-payload recipe id (LE u32).
    const refIdsDst = 13 * 1024 * 1024;
    expect(x.fm_ref_exn_load(2, 0, 0, 0, refIdsDst, 0, refIdsDst, 1)).toBe(1);
    expect(new Uint32Array(memory.buffer, refIdsDst, 1)[0]).toBe(1);

    // PROOF OF USE: the module served every one of these feed reads.
    expect(Number(x.fm_ref_feed_reads()) - readsBefore).toBeGreaterThan(0);
  });
});
