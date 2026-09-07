// Module-on fork CHILD-RECONSTRUCTION floor (child-reconstruction severance).
//
// The module-on fork child path used to construct a `ForkReferenceTransaction`
// purely as a floor wrapper even though the co-resident fork-module is the sole
// reconstructor. This suite proves the replacement `ForkModuleReconstructionFloor`:
//
//   1. sizes the shared anyref transit from the module's resident decoded-graph
//      node count (`fm_decoded_node_count`, supplied here as the getter the
//      registry binds to `ForkModuleContinuationBackend.decodedNodeCount`) and
//      delegates the WHOLE reconstruction to the module drive — no JS engine;
//   2. accepts the pre-instantiation early-provider adoption as VALIDATE-ONLY
//      (coordination is via the shared transit `publishEarlyGcTransit`, so the
//      adopted payload is inert on the module path);
//   3. still owns the scalar-payload scratch arena the guest GC codecs stage
//      through (the `__wpk_fork_ref_scratch_*` imports are NOT flipped);
//   4. is SELECTED by `ForkActivationRegistry.attachChild` when a decoded-node-
//      count source is supplied (module-on child reconstruction) and the JS
//      `ForkReferenceTransaction` is selected otherwise (flag-off) — i.e. the
//      child-reconstruction path constructs NO `ForkReferenceTransaction`.
//
// A real imported-global / dlopen module-fork exercises this floor end-to-end in
// a worker via `fork-from-dlopen-side-module-e2e` + the reference-kind
// fresh-worker suites (module-on default); this suite is the focused unit proof
// the child-reconstruction severance report asked for.

import { describe, expect, it, vi } from "vitest";
import { ForkActivationRegistry } from "../src/fork-activation-registry";
import { ForkFunctionCatalog } from "../src/fork-function-catalog";
import { ForkModuleReconstructionFloor } from "../src/fork-module-reconstruction";
import {
  ForkReferenceTransaction,
  decodeForkReferenceTransactionRecord,
  type ForkExternrefRecipeProvider,
} from "../src/fork-reference-transaction";
import {
  ForkModuleStateArena,
  type ForkModuleStateRecord,
} from "../src/fork-module-state";
import type { ForkReferenceChildReplayAdoption } from "../src/fork-reference-contracts";

function makeExternrefs(): ForkExternrefRecipeProvider {
  return {
    capture(): number {
      throw new Error("externref capture is not expected in this suite");
    },
    materialize(): unknown {
      throw new Error("externref materialize is not expected in this suite");
    },
    tryEncode(): number | undefined {
      return undefined;
    },
  };
}

// A recipe graph carries no live values, so an empty adoption is a faithful
// stand-in for the imported-global prefix the floor treats as validate-only.
function emptyAdoption(): ForkReferenceChildReplayAdoption {
  return {
    transaction: {} as ForkReferenceChildReplayAdoption["transaction"],
    materializedValues: new Map(),
    allocatedTypedRecipes: new Set(),
    filledTypedRecipes: new Set(),
    materializedExceptionRecipes: new Set(),
  };
}

// A bump-allocated scratch region over a real memory, matching the shape the
// registry passes (`memory`, `allocateScratch`, `deallocateScratch`).
function scratchDeps(): {
  memory: WebAssembly.Memory;
  allocateScratch: (size: number) => number;
  deallocateScratch: (addr: number, size: number) => void;
} {
  const memory = new WebAssembly.Memory({ initial: 32 });
  let next = 0x1_0000;
  return {
    memory,
    allocateScratch: (size: number): number => {
      const addr = next;
      next += size;
      return addr;
    },
    deallocateScratch: (): void => {},
  };
}

describe("ForkModuleReconstructionFloor", () => {
  it("sizes the transit from the module node count and delegates reconstruction to the module drive", () => {
    const prepared: number[] = [];
    const order: string[] = [];
    const transit = {
      prepareTransit(maxRecipeId: number): void {
        prepared.push(maxRecipeId);
        order.push("prepareTransit");
      },
    };
    const floor = new ForkModuleReconstructionFloor(transit, () => 5, undefined, undefined, undefined, "floor");
    floor.attachChild();
    const drive = vi.fn(() => order.push("moduleDrive"));
    floor.materializeAllTyped(drive);
    // Transit is sized to the highest recipe id (node count - 1); recipe 0 is
    // the canonical null and gets no slot.
    expect(prepared).toEqual([4]);
    expect(drive).toHaveBeenCalledTimes(1);
    // Sizing happens BEFORE the module drive writes `table.set(recipe+1)`.
    expect(order).toEqual(["prepareTransit", "moduleDrive"]);
  });

  it("refuses a second typed materialization and a missing module drive delegate", () => {
    const transit = { prepareTransit(): void {} };
    const floor = new ForkModuleReconstructionFloor(transit, () => 3, undefined, undefined, undefined, "floor");
    floor.attachChild();
    // No JS fallback: the floor is only used on the module-drive path.
    expect(() => floor.materializeAllTyped()).toThrow(/requires the module drive delegate/);
    floor.materializeAllTyped(() => {});
    expect(() => floor.materializeAllTyped(() => {})).toThrow(/materialized twice/);
  });

  it("accepts the early-provider adoption as validate-only and rejects a double or post-materialization adoption", () => {
    const transit = { prepareTransit(): void {} };
    const floor = new ForkModuleReconstructionFloor(transit, () => 2, undefined, undefined, undefined, "floor");
    floor.attachChild();
    // Validate-only: the module reconstructs the graph; the adopted prefix is
    // coordinated through the shared transit, so this takes no ownership.
    floor.adoptChildReplay(emptyAdoption());
    expect(() => floor.adoptChildReplay(emptyAdoption())).toThrow(/adopted twice/);

    const late = new ForkModuleReconstructionFloor(transit, () => 2, undefined, undefined, undefined, "floor");
    late.attachChild();
    late.materializeAllTyped(() => {});
    expect(() => late.adoptChildReplay(emptyAdoption())).toThrow(
      /after typed materialization/,
    );
  });

  it("stages guest GC-codec scalar payloads through the reconstruction scratch arena", () => {
    const { memory, allocateScratch, deallocateScratch } = scratchDeps();
    const transit = { prepareTransit(): void {} };
    const floor = new ForkModuleReconstructionFloor(
      transit,
      () => 1,
      memory,
      allocateScratch,
      deallocateScratch,
      "floor",
    );
    floor.attachChild();
    const first = floor.reserveScratch(16);
    expect(first).toBeGreaterThan(0);
    const second = floor.reserveScratch(8);
    expect(second).toBeGreaterThan(first);
    // LIFO release, exactly as the guest codec stages/unwinds scalar payloads.
    floor.releaseScratch(second, 8);
    floor.releaseScratch(first, 16);
    // A clean drain finishes without error.
    floor.finishReplay();
    // Scratch is unavailable once reconstruction is done (a stray guest reserve
    // after replay is a broken invariant, not a silent allocation).
    expect(() => floor.reserveScratch(8)).toThrow(/while floor is done/);
  });

  it("throws for every capture and JS-reconstruction-only operation", () => {
    const transit = { prepareTransit(): void {} };
    const floor = new ForkModuleReconstructionFloor(transit, () => 1, undefined, undefined, undefined, "floor");
    // The module owns capture, the fresh-child reference decode, and the RESTORE
    // data feed on this path; these must never run on the floor.
    expect(() => floor.beginCapture()).toThrow(/does not run on the module reconstruction floor/);
    expect(() => floor.encodeFuncref()).toThrow(/does not run on the module reconstruction floor/);
    expect(() => floor.decodeExternref()).toThrow(/does not run on the module reconstruction floor/);
    expect(() => floor.routeGc()).toThrow(/does not run on the module reconstruction floor/);
    expect(() => floor.defineException()).toThrow(/does not run on the module reconstruction floor/);
  });
});

// A sealed module-state arena carrying zero activation module records — the
// registry validation compares its Module records against the (empty) registry.
function emptyReconstructionArena(): ForkModuleStateArena {
  return {
    hasActiveArena: () => true,
    isSealed: () => true,
    recordViews: () => [] as ForkModuleStateRecord[],
  } as unknown as ForkModuleStateArena;
}

// A real, empty decoded reference transaction (only the canonical null node) so
// the flag-off `ForkReferenceTransaction.attachChild` has valid wire to attach.
function emptyDecodedTransaction() {
  const memory = new WebAssembly.Memory({ initial: 16 });
  let next = 0x1_0000;
  const arena = new ForkModuleStateArena(
    memory,
    4,
    (size) => {
      const addr = next;
      next += Number(size);
      return addr;
    },
    () => {},
    "module reconstruction test",
  );
  arena.begin();
  arena.appendModule({ activationId: 0, templateId: new Uint8Array(32) });
  const parent = new ForkReferenceTransaction(
    new ForkFunctionCatalog(),
    makeExternrefs(),
  );
  parent.beginCapture();
  parent.sealInto(arena);
  arena.seal();
  return decodeForkReferenceTransactionRecord(arena.records());
}

describe("ForkActivationRegistry module-on child reconstruction", () => {
  it("selects the module reconstruction floor (no ForkReferenceTransaction) and sizes the transit end-to-end", () => {
    const registry = new ForkActivationRegistry(
      new WebAssembly.Memory({ initial: 16 }),
      makeExternrefs(),
      "test registry",
    );
    // Module-on child reconstruction: the co-resident module reports 5 decoded
    // nodes (`fm_decoded_node_count`), so the child path constructs the floor.
    registry.attachChild(emptyReconstructionArena(), undefined, () => 5);
    const references = registry.currentReferences();
    expect(references).toBeInstanceOf(ForkModuleReconstructionFloor);
    expect(references).not.toBeInstanceOf(ForkReferenceTransaction);

    const drive = vi.fn();
    registry.restoreModuleState(drive, true);
    expect(drive).toHaveBeenCalledTimes(1);
    // The shared transit grew to cover the highest recipe id (node count - 1 =
    // 4), i.e. a slot at index 5 -> table length 6.
    expect(registry.gcTransitTable().length).toBeGreaterThanOrEqual(6);
    registry.finishReplay();
    expect(registry.phaseName()).toBe("idle");
  });

  it("keeps the JS ForkReferenceTransaction on the flag-off child path (no node-count source)", () => {
    const registry = new ForkActivationRegistry(
      new WebAssembly.Memory({ initial: 16 }),
      makeExternrefs(),
      "test registry",
    );
    // No decoded-node-count source => flag-off child reconstruction keeps the JS
    // reference engine, exactly as before this severance.
    registry.attachChild(emptyReconstructionArena(), emptyDecodedTransaction());
    expect(registry.currentReferences()).toBeInstanceOf(ForkReferenceTransaction);
    registry.abort();
  });
});
