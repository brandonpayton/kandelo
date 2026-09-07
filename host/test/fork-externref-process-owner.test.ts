import { describe, expect, it, vi } from "vitest";
import { ForkExternrefProcessOwner } from "../src/fork-externref-process-owner";
import {
  ForkModuleStateArena,
  ForkModuleStateRecordKind,
  writeForkModuleStateRoot,
} from "../src/fork-module-state";
import {
  type ForkReferenceRecipeGraph,
} from "../src/fork-reference-recipes";
import { FORK_REFERENCE_TRANSACTION_OWNER_ID } from "../src/fork-reference-wire";
import {
  encodeSegmentedForkReferenceRecords,
  PagedForkReferenceVector,
} from "../src/fork-reference-segments";

function copiedContinuation(
  graph: ForkReferenceRecipeGraph,
): {
  memory: WebAssembly.Memory;
  moduleBufferAddress: number;
} {
  const memory = new WebAssembly.Memory({ initial: 8 });
  let next = 0x2_0000;
  const arena = new ForkModuleStateArena(
    memory,
    4,
    (size) => {
      const address = next;
      next += Math.ceil(Number(size) / 0x1_0000) * 0x1_0000;
      return address;
    },
    () => {},
    "externref owner test arena",
  );
  const root = arena.begin();
  arena.appendModule({
    activationId: 0,
    templateId: new Uint8Array(32).fill(0x71),
  });
  for (const record of encodeSegmentedForkReferenceRecords(
    FORK_REFERENCE_TRANSACTION_OWNER_ID,
    graph.nodes,
    [PagedForkReferenceVector.empty],
    { segmentDataBytes: 17 },
  )) {
    arena.appendRecord(record);
  }
  arena.seal();

  const moduleBufferAddress = 0x1_0000;
  writeForkModuleStateRoot(memory, moduleBufferAddress, 4, root);
  return { memory, moduleBufferAddress };
}

function graphForHandles(handles: readonly number[]): ForkReferenceRecipeGraph {
  return {
    roots: [0, ...handles.map((_, index) => index + 1)],
    nodes: [
      { id: 0, node: { kind: "null" } },
      ...handles.map((handle, index) => ({
        id: index + 1,
        node: { kind: "externref" as const, handle },
      })),
    ],
  };
}

describe("ForkExternrefProcessOwner", () => {
  it("leases each aliased handle once before a fresh child starts", () => {
    const owner = new ForkExternrefProcessOwner();
    const parent = owner.startGeneration(41);
    const value = { opaque: true };
    const handle = owner.registerForWire(
      41,
      owner.generationId(parent),
      value,
    );
    const copied = copiedContinuation(
      graphForHandles([handle, handle, handle]),
    );

    const grant = owner.forkGenerationFromContinuation(
      parent,
      42,
      copied.memory,
      4,
      copied.moduleBufferAddress,
    );
    expect(grant.handleCount).toBe(1);
    expect(
      owner.authorizeForWire(42, grant.generation.id, handle),
    ).toBe(value);

    owner.releaseGeneration(parent);
    expect(
      owner.authorizeForWire(42, grant.generation.id, handle),
    ).toBe(value);
    owner.releaseGeneration(grant.generation);
    expect(() =>
      owner.authorizeForWire(42, grant.generation.id, handle)
    ).toThrow("stale");
  });

  it("retires PID-stable authority exactly when exec replaces an image", () => {
    const owner = new ForkExternrefProcessOwner();
    const beforeExec = owner.startGeneration(51);
    const beforeId = owner.generationId(beforeExec);
    const handle = owner.registerForWire(51, beforeId, Symbol("old image"));

    const afterExec = owner.replaceGeneration(beforeExec);
    expect(afterExec.pid).toBe(51);
    expect(afterExec.id).not.toBe(beforeId);
    expect(() => owner.authorizeForWire(51, beforeId, handle)).toThrow(
      "stale",
    );
    expect(() =>
      owner.authorizeForWire(51, afterExec.id, handle)
    ).toThrow("retired");
  });

  it("rolls back a provisional child generation when its graph is not owned", () => {
    const owner = new ForkExternrefProcessOwner();
    const parent = owner.startGeneration(61);
    const copied = copiedContinuation(graphForHandles([900]));

    expect(() =>
      owner.forkGenerationFromContinuation(
        parent,
        62,
        copied.memory,
        4,
        copied.moduleBufferAddress,
      )
    ).toThrow("unknown externref handle");

    // A failed grant leaves no hidden child generation behind.
    expect(owner.startGeneration(62).pid).toBe(62);
  });

  it("uses one process generation for main and pthread import adapters", () => {
    const owner = new ForkExternrefProcessOwner();
    const generation = owner.startGeneration(71);
    const idForMainWorker = owner.generationId(generation);
    const idForPthreadWorker = owner.generationId(generation);
    const handle = owner.registerForWire(71, idForMainWorker, "shared");

    expect(
      owner.authorizeForWire(71, idForPthreadWorker, handle),
    ).toBe("shared");
  });

  it("does not adopt or copy the complete module-state arena to grant a lease", () => {
    const owner = new ForkExternrefProcessOwner();
    const parent = owner.startGeneration(81);
    const handle = owner.registerForWire(81, parent.id, { opaque: true });
    const copied = copiedContinuation(graphForHandles([handle]));
    const attach = vi.spyOn(ForkModuleStateArena.prototype, "attach")
      .mockImplementation(() => {
        throw new Error("full arena attachment is not allowed in the grant path");
      });
    const records = vi.spyOn(ForkModuleStateArena.prototype, "records")
      .mockImplementation(() => {
        throw new Error("full arena copying is not allowed in the grant path");
      });
    try {
      const grant = owner.forkGenerationFromContinuation(
        parent,
        82,
        copied.memory,
        4,
        copied.moduleBufferAddress,
      );
      expect(grant.handleCount).toBe(1);
      owner.releaseGeneration(grant.generation);
    } finally {
      attach.mockRestore();
      records.mockRestore();
      owner.releaseGeneration(parent);
    }
  });
});
