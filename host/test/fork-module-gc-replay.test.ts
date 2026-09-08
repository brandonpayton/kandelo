// Phase 6 D6.4a / M2 — typed-GC (struct/array/i31) reference reconstruction
// ADMITTED by the co-resident fork module, with the injected drive plan doing
// leaf-identity + transit rooting while the PROVEN topological allocate/fill
// walk (`fork_codec::build_drive_plan`) drives the guest's own
// `_gc_allocate`/`_gc_fill` exports through the drive table. Proven end to end
// in a real WebAssembly engine (Node/V8).
//
// This is the typed-GC analogue of `fork-module-exnref-replay.test.ts`. The
// crucial shape this exercises is a struct↔array CYCLE whose subgraph reaches an
// ALIASED externref leaf (id 0 is the canonical null every capture requires):
//
//   id 0 = null                                        (canonical)
//   id 1 = struct  -> array(2) + externref(3)          (fields [2, 3])
//   id 2 = array   -> struct(1) (back-edge) + externref(3) (alias)  (elements [1, 3])
//   id 3 = externref naming `LEAF_HANDLE`              (reached from BOTH)
//
// Since M2, the module's PHASE-B leaf rooting is no longer a host round-trip:
// `build_drive_plan` emits a `DRIVE_OP_EXTERNREF_TRANSIT` step for the aliased
// leaf in Phase 0 (before any allocate/fill), and the injected `fm_drive_execute`
// shim resolves it through the single residual `env.resolve_externref` host
// import, internalizes it (`any.convert_extern`), `table.set`s it into the
// anyref transit at `recipe + 1`, and asserts non-null — the replacement for the
// retired host `Object.is` R1 read-back guard (see the design ruling in
// `docs/superpowers/plans/2026-09-03-m2-externref-into-module.md`). The
// struct/array ALLOC/FILL steps then drive the REAL guest exports (here, the
// FAITHFUL guest double, which publishes a live identity into STORE #2 on
// ALLOC — see `fork-module-faithful-guest.ts`). Despite the ALIAS (the leaf is
// reached from both the struct field and the array element), it must be rooted
// EXACTLY ONCE (dedup).
//
// Assertions:
//   (a) TRANSIT IDENTITY (silent-corruption-critical) — the token the drive
//       publishes into the real anyref transit reads back `Object.is`-identical
//       to `tokens.materialize(handle)` (the canonical token the module's lazy
//       externref decode would also return), rooted ONCE.
//   (b) PROOF OF USE — `fm_gc_nodes_reconstructed` advanced by the struct+array
//       count (bookkeeping) and the drive plan resolved the reachable leaf
//       exactly once through the host seam.
//   (c) MINT INERT — no exception tag is minted (no exnref; the deleted
//       `wpk_fork_host.*` `host_mint_exception_tag` seam, H3, is gone — the
//       module no longer even declares the import).
//   (d) R1 GUARD IS LOAD-BEARING — when the host loses the reachable leaf's
//       identity (`resolve_externref` returns null for it), the injected
//       non-null check TRAPS the drive rather than silently rooting a null/wrong
//       leaf a struct/array fill would then read.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { resolveBinary } from "../src/binary-resolver";
import { FmStatField } from "../src/fork-module-backend";
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
const PID = 6262;
const GENERATION_ID = 11;
// The durable broker handle the aliased externref leaf names.
const LEAF_HANDLE = 77;

const DRIVE_OP_ALLOC = 0;
const DRIVE_OP_FILL = 1;
const DRIVE_OP_EXN = 2;

// The committed GC-codec (KFGC) fixture the Rust `fork-codec` decoder tests use
// (also used by `fork-module-drive-r1-trace.test.ts`). Its layout 1 is a struct
// (type ordinal 0, DEFAULTABLE_SHELL, two reference fields); its layout 4 is a
// generic array (type ordinal 3, one reference-typed element descriptor, no
// constructor dependencies — so an array recipe may carry any number of
// elements). Both are activation-0 layouts.
const GC_CODEC = new Uint8Array(
  readFileSync(new URL("../../crates/fork-codec/testdata/gc-codec-wasm32.bin", import.meta.url)),
);

/**
 * Build a sealed KFMS arena holding the struct↔array cycle over an aliased
 * externref leaf described in the file header, plus the GC-codec fixture bytes
 * placed just past it so `fm_set_activation_gc_codec` can copy them from guest
 * memory.
 */
function buildGcCycleArena(memory: WebAssembly.Memory): { root: number; codecPtr: number } {
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
    "gc-replay-test",
  );

  const nodes: ForkReferenceRecipeEntry[] = [
    { id: 0, node: { kind: "null" } },
    {
      id: 1,
      node: {
        kind: "struct",
        moduleActivation: 0,
        typeOrdinal: 0,
        layoutId: 1,
        scalars: new Uint8Array([0x78, 0x56, 0x34, 0x12]),
        fields: [2, 3],
      },
    },
    {
      id: 2,
      node: {
        kind: "array",
        moduleActivation: 0,
        typeOrdinal: 3,
        layoutId: 4,
        scalars: new Uint8Array(0),
        elements: [1, 3],
      },
    },
    { id: 3, node: { kind: "externref", handle: LEAF_HANDLE } },
  ];
  const vectors: ForkReferenceVector[] = [PagedForkReferenceVector.empty];

  const root = arena.begin();
  arena.appendModule({ activationId: 0, templateId: new Uint8Array(32).fill(0xa0) });
  appendSegmentedForkReferenceTransaction(
    arena,
    WPK_FORK_REFERENCE_TRANSACTION_OWNER,
    nodes,
    vectors,
    // Force multi-segment reassembly so the module's decode is exercised.
    { segmentDataBytes: 48 },
  );
  arena.seal();
  const codecPtr = allocate(GC_CODEC.byteLength);
  new Uint8Array(memory.buffer, codecPtr, GC_CODEC.byteLength).set(GC_CODEC);
  return { root, codecPtr };
}

interface ForkModuleRefExports {
  fm_set_format: (pw: number, fixedPrefix: number) => void;
  fm_set_activation_gc_codec: (act: number, ptr: number, len: number) => void;
  fm_begin_reference_replay: (root: number, pid: number) => void;
  // The single folded proof-of-use counter accessor (replaced the former 11
  // individual counter exports); read via the `FmStatField` enum.
  fm_stats: (field: number) => bigint;
  fm_last_errno: () => number;
  fm_build_gc_plan: (pid: number) => number;
  fm_gc_plan_count: () => number;
  fm_drive_execute: (ptr: number, count: number) => void;
  fm_drive_table_base: (act: number) => number;
  fm_ref_gc_route: (recipeId: number, expectedActivation: number) => number;
  fm_ref_gc_payload_len: (
    recipeId: number,
    expectedActivation: number,
    expectedLayoutId: number,
  ) => number;
  fm_ref_gc_load: (
    recipeId: number,
    moduleActivation: number,
    typeOrdinal: number,
    layoutId: number,
    kind: number,
    scalarDestination: number,
    scalarByteLength: number,
  ) => number;
  fm_ref_vector_get: (ordinal: number, index: number) => number;
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
    label: "gc-replay-test",
    resolveExternref,
  });
  return { fm, x: fm.exports as unknown as ForkModuleRefExports };
}

/** Bind the FAITHFUL guest's alloc/fill/exception_materialize into activation
 *  0's drive-table slice and presize the anyref transit for the graph's max
 *  recipe id (mirrors production's `ForkActivationRegistry.ensureRecipeSlot`,
 *  which the injected drive's `table.set` no longer does itself). */
function bindFaithfulGuest(
  fm: ReturnType<typeof instantiateForkModule>,
  x: ForkModuleRefExports,
  maxRecipeId: number,
) {
  const transitTable = new ForkAnyrefTransitTable(fm.gcTransitTable);
  transitTable.ensureRecipeSlot(maxRecipeId);
  const { guest, published } = instantiateFaithfulGuest(transitTable);
  const base = x.fm_drive_table_base(0);
  if (fm.driveTable.length < base + 3) {
    fm.driveTable.grow(base + 3 - fm.driveTable.length);
  }
  fm.driveTable.set(base + DRIVE_OP_ALLOC, guest.gc_allocate);
  fm.driveTable.set(base + DRIVE_OP_FILL, guest.gc_fill);
  fm.driveTable.set(base + DRIVE_OP_EXN, guest.exception_materialize);
  return { transitTable, guest, published };
}

describe("fork-module typed-GC (struct/array/i31) admission + leaf rooting through the module (Phase 6 D6.4a / M2)", () => {
  it("roots the aliased externref leaf of a struct↔array cycle in the real anyref transit ONCE with identity parity, advances the counters, and never mints a tag", () => {
    const memory = new WebAssembly.Memory({ initial: 256, maximum: 16384, shared: true });

    const tokens = new ForkExternrefTokenCache(GENERATION_ID);
    const hostCapabilities = createForkModuleHostCapabilities({ tokens });

    const { root, codecPtr } = buildGcCycleArena(memory);
    const { fm, x } = instantiate(memory, hostCapabilities.imports.resolve_externref);

    x.fm_set_format(PTR_WIDTH, 0);
    x.fm_set_activation_gc_codec(0, codecPtr, GC_CODEC.byteLength);
    expect(x.fm_last_errno()).toBe(0);

    const externrefsBefore = Number(x.fm_stats(FmStatField.ExternrefsResolved));
    const gcNodesBefore = Number(x.fm_stats(FmStatField.GcNodesReconstructed));
    const exnrefsBefore = Number(x.fm_stats(FmStatField.ExnrefsReconstructed));

    // Seed the reference graph (bookkeeping only).
    x.fm_begin_reference_replay(root, PID);
    expect(x.fm_last_errno()).toBe(0);

    // (b) PROOF OF USE (graph admission) — two typed-GC nodes admitted (struct +
    // array), one externref leaf counted, and NO exnref.
    expect(Number(x.fm_stats(FmStatField.GcNodesReconstructed)) - gcNodesBefore).toBe(2);
    expect(Number(x.fm_stats(FmStatField.ExternrefsResolved)) - externrefsBefore).toBe(1);
    expect(Number(x.fm_stats(FmStatField.ExnrefsReconstructed)) - exnrefsBefore).toBe(0);

    // Build + execute the real drive plan: Phase 0 publishes the aliased
    // externref leaf into the REAL anyref transit ONCE (dedup) with the
    // non-null R1 assert, then the struct/array ALLOC/FILL steps drive the
    // guest's own exports (here, the faithful double) to completion.
    const planPtr = x.fm_build_gc_plan(PID);
    expect(x.fm_last_errno()).toBe(0);
    const count = x.fm_gc_plan_count();

    const { transitTable, published } = bindFaithfulGuest(fm, x, 3);

    x.fm_drive_execute(planPtr, count);

    // (a) TRANSIT IDENTITY — the token the drive rooted for the leaf is the SAME
    // object `tokens.materialize(handle)` returns (idempotent cache), and it is
    // what actually sits in the real anyref transit slot (recipe_id 3 -> slot 4),
    // rooted EXACTLY ONCE despite the alias.
    const canonical = tokens.materialize(LEAF_HANDLE);
    expect(transitTable.get(4)).toBe(canonical);
    // Dedup: exactly one externref was re-rooted through the seam despite two
    // aggregate edges naming it.
    expect(hostCapabilities.resolvedCount).toBe(1);

    // The guest published a live store-#2 identity for both aggregates (struct
    // recipe 1, array recipe 2).
    expect(new Set(published)).toEqual(new Set([1, 2]));

    // (c) MINT INERT — the typed-GC drive never mints an exception tag. This
    // used to be proven by spying on a `host_mint_exception_tag` stub
    // (`wpk_fork_host.*` seam); that seam was deleted (H3, 2026-09-06) because
    // it was never wired to any guest, so the proof is now structural: the
    // module no longer even declares the import, so there is nothing to call.
  });

  it("R1 GUARD (wasm-level): a resolved-but-lost externref leaf TRAPS the drive, never silently mis-roots the cycle's identity", () => {
    // The retired host `Object.is` R1 guard is replaced, in M2, by the injected
    // `fm_drive_execute` shim's non-null structural check on the transit slot
    // (see the design ruling). Simulate the host losing the leaf's identity
    // (`resolve_externref` returns null for it): the DRIVE_OP_EXTERNREF_TRANSIT
    // step internalizes null, `table.set`s it, reads it back, and TRAPS — before
    // any ALLOC/FILL runs (Phase 0 precedes every allocate/fill) — failing loud
    // rather than letting the struct/array fill consume a null/wrong leaf.
    const memory = new WebAssembly.Memory({ initial: 256, maximum: 16384, shared: true });

    const { root, codecPtr } = buildGcCycleArena(memory);
    const { fm, x } = instantiate(memory, () => null);

    x.fm_set_format(PTR_WIDTH, 0);
    x.fm_set_activation_gc_codec(0, codecPtr, GC_CODEC.byteLength);
    expect(x.fm_last_errno()).toBe(0);

    x.fm_begin_reference_replay(root, PID);
    expect(x.fm_last_errno()).toBe(0);

    const planPtr = x.fm_build_gc_plan(PID);
    expect(x.fm_last_errno()).toBe(0);
    const count = x.fm_gc_plan_count();

    // Presize the transit table (mirrors production's `ensureRecipeSlot`) so the
    // trap below is the intended non-null structural check, not an unrelated
    // out-of-bounds `table.set` on a too-small default table. Bind the guest
    // double too — the trap must fire in Phase 0, BEFORE any `call_indirect`
    // reaches it, proving the leaf rooting genuinely gates the aggregate drive.
    bindFaithfulGuest(fm, x, 3);

    expect(() => x.fm_drive_execute(planPtr, count)).toThrowError(/unreachable/i);
  });

  it("serves the typed-GC RESTORE data-feed through the module (item 3a): routes, payload lengths, scalar loads, and edge-vector reads match the decoded graph", () => {
    // Phase 6 item 3a: the SEVEN restore imports the guest's typed-GC codec used
    // to call on the JS reference provider now resolve to the module's `fm_ref_*`
    // exports. Drive them directly against the module's seeded feed (the guest
    // `_gc_allocate`/`_gc_fill` walk does exactly this at runtime) and prove the
    // MODULE (not the JS provider) produced JS-identical results, in a real
    // WebAssembly engine. This data feed does not touch the externref transit at
    // all, so a resolver that is never expected to be called is enough.
    const memory = new WebAssembly.Memory({ initial: 256, maximum: 16384, shared: true });
    const { root, codecPtr } = buildGcCycleArena(memory);
    const { x } = instantiate(memory, () => {
      throw new Error("resolve_externref should not be called by the data feed");
    });
    x.fm_set_format(PTR_WIDTH, 0);
    x.fm_set_activation_gc_codec(0, codecPtr, GC_CODEC.byteLength);
    x.fm_begin_reference_replay(root, PID);
    expect(x.fm_last_errno()).toBe(0);

    const readsBefore = Number(x.fm_stats(FmStatField.RefFeedReads));

    // struct id 1: activation 0, type 0, layout 1, scalars [0x78,0x56,0x34,0x12],
    // fields [2, 3]. array id 2: activation 0, type 3, layout 4, no scalars,
    // elements [1, 3].
    expect(x.fm_ref_gc_route(1, 0)).toBe(1); // struct layout id
    expect(x.fm_ref_gc_payload_len(1, 0, 1)).toBe(4);
    expect(x.fm_ref_gc_route(2, 0)).toBe(4); // array layout id
    expect(x.fm_ref_gc_payload_len(2, 0, 4)).toBe(0);
    // A mismatched activation routes to the -1 sentinel (a value, not a trap).
    expect(x.fm_ref_gc_route(1, 9)).toBe(-1);

    // Load the struct scalars into guest memory (well above the module's 4 MiB
    // heap at the 8 MiB reserve base) and read back its interned edge vector.
    const structDst = 13 * 1024 * 1024;
    const structVec = x.fm_ref_gc_load(1, 0, 0, 1, 1 /* struct */, structDst, 4);
    expect([...new Uint8Array(memory.buffer, structDst, 4)]).toEqual([
      0x78, 0x56, 0x34, 0x12,
    ]);
    // Base vectors = [empty sentinel] (length 1), so the first appended edge
    // vector takes ordinal 1.
    expect(structVec).toBe(1);
    expect(x.fm_ref_vector_get(structVec, 0)).toBe(2); // field -> array
    expect(x.fm_ref_vector_get(structVec, 1)).toBe(3); // field -> externref

    const arrayDst = structDst + PAGE;
    const arrayVec = x.fm_ref_gc_load(2, 0, 3, 4, 2 /* array */, arrayDst, 0);
    expect(arrayVec).toBe(2);
    expect(x.fm_ref_vector_get(arrayVec, 0)).toBe(1); // element -> struct (back-edge)
    expect(x.fm_ref_vector_get(arrayVec, 1)).toBe(3); // element -> externref (alias)

    // A repeated struct load returns the SAME cached ordinal (no duplicate append).
    expect(x.fm_ref_gc_load(1, 0, 0, 1, 1, structDst, 4)).toBe(1);

    // PROOF OF USE: the module served every one of these feed reads. A silent JS
    // fallback (imports left on the reference provider) would leave this at 0.
    expect(Number(x.fm_stats(FmStatField.RefFeedReads)) - readsBefore).toBeGreaterThan(0);
  });
});
