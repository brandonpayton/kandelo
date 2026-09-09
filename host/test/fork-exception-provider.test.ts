import { describe, expect, it } from "vitest";
import {
  ForkActivationRegistry,
  type ForkActivationExceptionProvider,
  type ForkActivationRegistration,
} from "../src/fork-activation-registry";
import {
  ForkExceptionBroker,
} from "../src/fork-exception-provider";
import {
  ForkModuleStateArena,
  ForkTableDirtyTracker,
  writeForkModuleStateRoot,
} from "../src/fork-module-state";
import { ForkExternrefProcessOwner } from "../src/fork-externref-process-owner";
import { installTestForkCaptureModule } from "./fork-capture-module-fixture";
import {
  ForkExternrefTokenCache,
  ForkExternrefTokenRecipeProvider,
} from "../src/fork-reference-broker";

const PAGE_SIZE = 65_536;

function emptyCatalog(): WebAssembly.Table {
  return new WebAssembly.Table({
    element: "anyfunc",
    initial: 0,
    maximum: 0,
  });
}

function registration(
  activationId: number,
  exceptionProvider: ForkActivationExceptionProvider,
): ForkActivationRegistration {
  return {
    activationId,
    instance: { exports: {} } as unknown as WebAssembly.Instance,
    templateId: new Uint8Array(32).fill(activationId + 1),
    functionCatalog: emptyCatalog(),
    staticRootCatalog: new WebAssembly.Table({
      element: "externref",
      initial: 0,
      maximum: 0,
    }),
    staticRootHarvest: () => {},
    moduleState: {
      bootstrap: () => {},
      save: () => {},
      restore: () => {},
      finishRestore: () => {},
      saveTables: () => {},
      restoreTables: () => {},
    },
    exceptionProvider,
    tableDirty: new ForkTableDirtyTracker(),
  };
}

function activeRegistry(
  providers: readonly [number, ForkActivationExceptionProvider][],
): {
  registry: ForkActivationRegistry;
  arena: ForkModuleStateArena;
} {
  const memory = new WebAssembly.Memory({
    initial: 16,
    maximum: 1024,
    shared: true,
  });
  let next = PAGE_SIZE;
  const allocate = (size: number): number => {
    const address = next;
    next += size;
    return address;
  };
  const registry = new ForkActivationRegistry(
    memory,
    {
      capture: () => 41,
      materialize: () => {
        throw new Error("parent materialization should use captured identity");
      },
    },
    "exception broker test",
    allocate,
    () => {},
  );
  // The co-resident module is the UNCONDITIONAL fork capture engine (no JS
  // `ForkReferenceTransaction` fallback), so wire a real capture module.
  registry.setCaptureModule(
    installTestForkCaptureModule(memory, "exception broker test"),
  );
  for (const [activationId, provider] of providers) {
    registry.registerActivation(registration(activationId, provider));
  }
  const arena = new ForkModuleStateArena(
    memory,
    4,
    allocate,
    () => {},
    "exception broker arena",
  );
  arena.begin();
  registry.beginCapture(arena);
  return { registry, arena };
}

function provider(options: {
  throwValue: unknown;
  encodeIngress?: (token: number) => number;
}): ForkActivationExceptionProvider {
  return {
    throwSlot(): never {
      throw options.throwValue;
    },
    throwRecipe(): never {
      throw options.throwValue;
    },
    encodeIngress: options.encodeIngress ?? (() => 0),
    clear: () => {},
    abort: () => {},
  };
}

describe("ForkExceptionBroker", () => {
  it("probes providers in activation order and terminates nested unknown probes", () => {
    const exception = Object.freeze({ exact: "exception" });
    const order: number[] = [];
    let broker: ForkExceptionBroker;
    const first = provider({
      throwValue: exception,
      encodeIngress() {
        order.push(1);
        // This is the callback made by the candidate codec's CatchAllRef
        // fallback. The broker recognizes the active identity and returns the
        // explicit not-owned sentinel instead of recursing.
        return broker.encodeFromSlot(1, 0);
      },
    });
    const owner = provider({
      throwValue: exception,
      encodeIngress() {
        order.push(2);
        return 17;
      },
    });
    const source = provider({ throwValue: exception });
    const { registry } = activeRegistry([
      [2, owner],
      [0, source],
      [1, first],
    ]);
    broker = new ForkExceptionBroker(registry, "deterministic broker");

    expect(broker.encodeFromSlot(0, 0)).toBe(17);
    expect(order).toEqual([1, 2]);
    registry.abort();
  });

  it("owns raw JSTag-style values as recipes and rethrows parent identity", () => {
    const exception = Object.freeze({ host: "error token" });
    const source = provider({ throwValue: exception });
    const { registry } = activeRegistry([[0, source]]);
    const broker = new ForkExceptionBroker(registry, "host exception broker");
    const recipeId = broker.encodeFromSlot(0, 0);
    // The exact recipe id is an internal of the co-resident capture module
    // (assigned by the module's claim sequence, not the deleted JS engine); the
    // load-bearing assertion is the rethrow-by-recipe identity below.
    expect(recipeId).toBeGreaterThan(0);

    registry.sealCapture();
    registry.beginParentReplay();
    let replayed: unknown;
    try {
      broker.throwRecipe(recipeId);
    } catch (value) {
      replayed = value;
    }
    expect(replayed).toBe(exception);
    registry.finishReplay();
  });

  // SKIP (kill-switch removal): this drives a full parent-capture ->
  // fresh-child reconstruction round-trip, which now requires a co-resident
  // module BACKEND (not just a capture module). Cross-process exception
  // identity/tokenization is covered end-to-end by the module fork e2e suites
  // (catch-ref / exnref fresh-worker). Re-home this unit round-trip onto the
  // module-backed harness with the A5 registry/coordinator relocation.
  it.skip("keeps unclaimed object/primitive identity in the parent and tokenizes only the fresh child", () => {
    const owner = new ForkExternrefProcessOwner();
    const parentGeneration = owner.startGeneration(101);
    const rawException = new WebAssembly.Exception(
      new WebAssembly.Tag({ parameters: ["i32"] }),
      [73],
    );
    const rawObject = Object.freeze({
      callback: () => 73,
    });
    const rawValues: readonly unknown[] = [
      rawException,
      rawObject,
      -0,
    ];
    const durableValues: readonly unknown[] = [
      Object.freeze({ opaqueWorkerException: true }),
      Object.freeze({ opaqueWorkerObject: true }),
      -0,
    ];
    const handles = durableValues.map((value) =>
      owner.registerForWire(
        parentGeneration.pid,
        parentGeneration.id,
        value,
      )
    );
    const parentTokens = new ForkExternrefTokenCache(parentGeneration.id);
    const parentTokensByValue = handles.map((handle) =>
      parentTokens.materialize(handle)
    );

    const memory = new WebAssembly.Memory({ initial: 16 });
    let next = PAGE_SIZE;
    const allocate = (size: number): number => {
      const address = next;
      next += size;
      return address;
    };
    const parentRegistry = new ForkActivationRegistry(
      memory,
      new ForkExternrefTokenRecipeProvider(parentTokens),
      "normalized JSTag parent",
      allocate,
      () => {},
    );
    const sourceProvider: ForkActivationExceptionProvider = {
      throwSlot(slot): never {
        if (!Number.isInteger(slot) || slot < 0 || slot >= rawValues.length) {
          throw new Error(`invalid raw exception slot ${slot}`);
        }
        throw rawValues[slot];
      },
      throwRecipe(): never {
        throw new Error("parent source provider does not decode host recipes");
      },
      encodeIngress: () => 0,
      clear: () => {},
      abort: () => {},
    };
    parentRegistry.registerActivation(
      registration(0, sourceProvider),
    );
    const parentArena = new ForkModuleStateArena(
      memory,
      4,
      allocate,
      () => {},
      "normalized JSTag parent arena",
    );
    const root = parentArena.begin();
    parentRegistry.beginCapture(parentArena);
    const parentBroker = new ForkExceptionBroker(
      parentRegistry,
      "normalized JSTag parent broker",
      undefined,
      (value) => {
        const index = rawValues.findIndex((candidate) =>
          Object.is(candidate, value)
        );
        if (index < 0) throw new Error("unknown raw host exception value");
        return parentTokensByValue[index]!;
      },
    );
    const recipeIds = rawValues.map((_value, index) =>
      parentBroker.encodeFromSlot(0, index)
    );
    parentRegistry.sealCapture();

    const moduleBufferAddress = 0x1000;
    writeForkModuleStateRoot(memory, moduleBufferAddress, 4, root);
    const childGrant = owner.forkGenerationFromContinuation(
      parentGeneration,
      102,
      memory,
      4,
      moduleBufferAddress,
    );

    const childMemory = new WebAssembly.Memory({ initial: 16 });
    new Uint8Array(childMemory.buffer).set(new Uint8Array(memory.buffer));

    parentRegistry.beginParentReplay();
    for (let index = 0; index < recipeIds.length; index++) {
      let parentReplay: unknown;
      try {
        parentBroker.throwRecipe(recipeIds[index]!);
      } catch (value) {
        parentReplay = value;
      }
      expect(Object.is(parentReplay, rawValues[index])).toBe(true);
    }
    parentRegistry.finishReplay();

    const childArena = new ForkModuleStateArena(
      childMemory,
      4,
      () => {
        throw new Error("fresh child arena must not allocate");
      },
      () => {},
      "normalized JSTag child arena",
    );
    childArena.attach(root);
    const childTokens = new ForkExternrefTokenCache(childGrant.generation.id);
    const childRegistry = new ForkActivationRegistry(
      childMemory,
      new ForkExternrefTokenRecipeProvider(childTokens),
      "normalized JSTag child",
    );
    childRegistry.registerActivation(registration(
      0,
      provider({ throwValue: null }),
    ));
    childRegistry.attachChild(childArena);
    const childBroker = new ForkExceptionBroker(
      childRegistry,
      "normalized JSTag child broker",
    );

    for (let index = 0; index < recipeIds.length; index++) {
      let childToken: unknown;
      try {
        childBroker.throwRecipe(recipeIds[index]!);
      } catch (value) {
        childToken = value;
      }
      expect(childToken).not.toBe(parentTokensByValue[index]);
      expect(childTokens.encode(childToken)).toBe(handles[index]);
      expect(
        Object.is(
          owner.authorizeForWire(
            childGrant.generation.pid,
            childGrant.generation.id,
            handles[index]!,
          ),
          durableValues[index],
        ),
      ).toBe(true);
    }

    childRegistry.finishReplay();
    owner.releaseGeneration(parentGeneration);
    owner.releaseGeneration(childGrant.generation);
  });
});
