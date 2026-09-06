import { describe, expect, it } from "vitest";
import {
  WPK_FORK_IMPORTED_GLOBAL_BINDINGS_OWNER,
  WPK_FORK_MODULE_STATE_GLOBAL_TYPE_ANYREF,
  WPK_FORK_MODULE_STATE_GLOBAL_TYPE_EXNREF,
  WPK_FORK_MODULE_STATE_GLOBAL_TYPE_EXTERNREF,
  WPK_FORK_MODULE_STATE_GLOBAL_TYPE_FUNCREF,
} from "../src/generated/abi";
import {
  ForkEarlyChildReferenceProvider,
  type ForkEarlyChildReferenceProviderOptions,
  type ForkEarlyReferenceActivationDeclaration,
  type ForkEarlyReferenceTransit,
} from "../src/fork-early-reference-provider";
import {
  FORK_GC_FIELD_ALLOCATION_DEPENDENCY,
  FORK_GC_FIELD_MUTABLE,
  FORK_GC_FIELD_NULLABLE,
  FORK_GC_FIELD_REFERENCE,
  FORK_GC_LAYOUT_DEFAULTABLE_SHELL,
  ForkGcCodecDescriptor,
  ForkGcConstructorKind,
  ForkGcLayoutKind,
  type ForkGcCodecProvider,
} from "../src/fork-gc-codec";
import { ForkFunctionCatalog } from "../src/fork-function-catalog";
import {
  encodeForkImportedGlobalBindings,
  ForkImportedGlobalBindingKind,
  ForkModuleStateRecordKind,
  type ForkImportedGlobalBinding,
  type ForkModuleStateRecord,
} from "../src/fork-module-state";
import {
  type ForkReferenceRecipeGraph,
} from "../src/fork-reference-recipes";
import {
  decodeSegmentedForkReferenceTransaction,
  encodeSegmentedForkReferenceRecords,
  forkReferenceVectorFrom,
  PagedForkReferenceVector,
} from "../src/fork-reference-segments";
import {
  FORK_HOST_EXCEPTION_ACTIVATION_ID,
  FORK_REFERENCE_TRANSACTION_OWNER_ID,
  ForkReferenceTransaction,
  type ForkExternrefRecipeProvider,
  type ForkTypedReferenceReplayOwner,
} from "../src/fork-reference-transaction";

function recordsFor(
  graph: ForkReferenceRecipeGraph,
  activationIds: readonly number[],
  bindings: readonly ForkImportedGlobalBinding[] = [],
  vectors: readonly (readonly number[])[] = [],
): ForkModuleStateRecord[] {
  return [
    ...activationIds.map((activationId) => ({
      kind: ForkModuleStateRecordKind.Module,
      activationId,
      ownerId: 0,
      payload: new Uint8Array(32).fill(activationId),
    })),
    ...encodeSegmentedForkReferenceRecords(
      FORK_REFERENCE_TRANSACTION_OWNER_ID,
      graph.nodes,
      [
        PagedForkReferenceVector.empty,
        ...vectors.map((vector) =>
          forkReferenceVectorFrom(vector, vector.length)
        ),
      ],
      { segmentDataBytes: 19 },
    ),
    {
      kind: ForkModuleStateRecordKind.ImportedGlobalBindings,
      activationId: 0,
      ownerId: WPK_FORK_IMPORTED_GLOBAL_BINDINGS_OWNER,
      payload: encodeForkImportedGlobalBindings(bindings),
    },
  ];
}

class TestTransit implements ForkEarlyReferenceTransit {
  readonly values = new Map<number, unknown>();
  prepared: number[] = [];
  aborts = 0;

  prepare(maxRecipeId: number): void {
    this.prepared.push(maxRecipeId);
  }

  read(recipeId: number): unknown {
    return this.values.get(recipeId);
  }

  publish(recipeId: number, value: unknown): void {
    this.values.set(recipeId, value);
  }

  abort(): void {
    this.aborts++;
    this.values.clear();
  }
}

function scratchOwner(memory: WebAssembly.Memory): {
  readonly allocate: (size: number) => number;
  readonly deallocate: (addr: number, size: number) => void;
  readonly deallocated: Array<{ addr: number; size: number }>;
} {
  let next = 65_536;
  const deallocated: Array<{ addr: number; size: number }> = [];
  return {
    allocate(size) {
      const addr = next;
      next += size;
      if (next > memory.buffer.byteLength) {
        throw new Error("test scratch memory exhausted");
      }
      return addr;
    },
    deallocate(addr, size) {
      deallocated.push({ addr, size });
    },
    deallocated,
  };
}

function externrefs(values: ReadonlyMap<number, unknown>): {
  readonly provider: ForkExternrefRecipeProvider;
  readonly materializations: number[];
} {
  const materializations: number[] = [];
  return {
    provider: {
      capture(): number {
        throw new Error("capture is not available in a fresh child");
      },
      materialize(handle): unknown {
        materializations.push(handle);
        if (!values.has(handle)) throw new Error(`unknown externref handle ${handle}`);
        return values.get(handle);
      },
      tryEncode(): number | undefined {
        return undefined;
      },
    },
    materializations,
  };
}

function providerOptions(
  records: readonly ForkModuleStateRecord[],
  declarations: readonly ForkEarlyReferenceActivationDeclaration[],
  provider: ForkExternrefRecipeProvider,
  transit: TestTransit,
): ForkEarlyChildReferenceProviderOptions & {
  readonly scratch: ReturnType<typeof scratchOwner>;
} {
  const memory = new WebAssembly.Memory({ initial: 8 });
  const scratch = scratchOwner(memory);
  return {
    records,
    transaction: decodeSegmentedForkReferenceTransaction(
      records,
      FORK_REFERENCE_TRANSACTION_OWNER_ID,
    ),
    declarations,
    externrefs: provider,
    transit,
    memory,
    allocateScratch: scratch.allocate,
    deallocateScratch: scratch.deallocate,
    label: "test early references",
    scratch,
  };
}

function mutableReferenceStructDescriptor(): ForkGcCodecDescriptor {
  return new ForkGcCodecDescriptor([{
    id: 1,
    typeOrdinal: 0,
    kind: ForkGcLayoutKind.Struct,
    constructor: ForkGcConstructorKind.Struct,
    flags: FORK_GC_LAYOUT_DEFAULTABLE_SHELL,
    scalarLengthOrStride: 0,
    fields: [{
      storage: 8,
      flags:
        FORK_GC_FIELD_REFERENCE
        | FORK_GC_FIELD_MUTABLE
        | FORK_GC_FIELD_NULLABLE,
      scalarOffset: null,
      referenceOrdinal: 0,
    }],
    superTypeOrdinal: null,
    baseLayoutId: 1,
    auxiliary: 0,
    provenanceScalarLength: 0,
    provenanceReferenceCount: 0,
  }]);
}

function immutableReferenceStructDescriptor(): ForkGcCodecDescriptor {
  return new ForkGcCodecDescriptor([{
    id: 1,
    typeOrdinal: 0,
    kind: ForkGcLayoutKind.Struct,
    constructor: ForkGcConstructorKind.Struct,
    flags: 0,
    scalarLengthOrStride: 0,
    fields: [{
      storage: 8,
      flags:
        FORK_GC_FIELD_REFERENCE
        | FORK_GC_FIELD_ALLOCATION_DEPENDENCY,
      scalarOffset: null,
      referenceOrdinal: 0,
    }],
    superTypeOrdinal: null,
    baseLayoutId: 1,
    auxiliary: 0,
    provenanceScalarLength: 0,
    provenanceReferenceCount: 0,
  }]);
}

function typedProvider(
  activationId: number,
  descriptor: ForkGcCodecDescriptor,
  transit: TestTransit,
  events: string[],
  beforeAllocate?: (recipeId: number) => void,
): ForkGcCodecProvider {
  return {
    activationId,
    descriptor,
    probe: () => 0n,
    encodeSlot: () => 0,
    allocate(recipeId) {
      beforeAllocate?.(recipeId);
      events.push(`allocate:${recipeId}`);
      transit.publish(recipeId, Object.freeze({ activationId, recipeId }));
    },
    fill(recipeId) {
      events.push(`fill:${recipeId}`);
    },
    publishExternref(recipeId, value) {
      transit.publish(recipeId, value);
    },
  };
}

function nullGraph(): ForkReferenceRecipeGraph {
  return {
    roots: [0],
    nodes: [{ id: 0, node: { kind: "null" } }],
  };
}

describe("early child reference provider", () => {
  it("materializes funcref, externref, and static-root recipes once", () => {
    const callback = (() => 73) as CallableFunction;
    const token = Object.freeze({ token: "child" });
    const staticRoot = Object.freeze({ root: "fresh activation" });
    const graph: ForkReferenceRecipeGraph = {
      roots: [0, 1, 2, 3],
      nodes: [
        { id: 0, node: { kind: "null" } },
        {
          id: 1,
          node: {
            kind: "funcref",
            moduleActivation: 1,
            functionOrdinal: 4,
          },
        },
        { id: 2, node: { kind: "externref", handle: 91 } },
        {
          id: 3,
          node: {
            kind: "static-root",
            moduleActivation: 2,
            staticRootOrdinal: 7,
          },
        },
      ],
    };
    const refs = externrefs(new Map([[91, token]]));
    const transit = new TestTransit();
    const options = providerOptions(
      recordsFor(graph, [1, 2]),
      [{ activationId: 1 }, { activationId: 2 }],
      refs.provider,
      transit,
    );
    const provider = new ForkEarlyChildReferenceProvider(options);
    const functionReads: number[] = [];
    const staticReads: number[] = [];
    provider.registerActivation({
      activationId: 1,
      functions: {
        decode(ordinal) {
          functionReads.push(ordinal);
          return callback;
        },
      },
    });
    provider.registerActivation({
      activationId: 2,
      staticRoots: {
        decode(ordinal) {
          staticReads.push(ordinal);
          return staticRoot;
        },
      },
    });

    expect(provider.ownerActivation(
      1,
      WPK_FORK_MODULE_STATE_GLOBAL_TYPE_FUNCREF,
    )).toBe(1);
    expect(provider.activationDependencies(
      2,
      WPK_FORK_MODULE_STATE_GLOBAL_TYPE_EXTERNREF,
    )).toEqual([]);
    expect(provider.activationDependencies(
      3,
      WPK_FORK_MODULE_STATE_GLOBAL_TYPE_ANYREF,
    )).toEqual([2]);

    expect(provider.materialize(
      1,
      WPK_FORK_MODULE_STATE_GLOBAL_TYPE_FUNCREF,
    )).toBe(callback);
    expect(provider.materialize(
      1,
      WPK_FORK_MODULE_STATE_GLOBAL_TYPE_EXTERNREF,
    )).toBe(callback);
    expect(provider.materialize(
      2,
      WPK_FORK_MODULE_STATE_GLOBAL_TYPE_EXTERNREF,
    )).toBe(token);
    expect(provider.materialize(
      2,
      WPK_FORK_MODULE_STATE_GLOBAL_TYPE_EXTERNREF,
    )).toBe(token);
    expect(provider.materialize(
      3,
      WPK_FORK_MODULE_STATE_GLOBAL_TYPE_ANYREF,
    )).toBe(staticRoot);
    expect(transit.read(3)).toBe(staticRoot);
    expect(transit.prepared).toEqual([3]);
    expect(functionReads).toEqual([4]);
    expect(refs.materializations).toEqual([91]);
    expect(staticReads).toEqual([7]);
  });

  it("publishes a static root before an immutable GC constructor consumes it", () => {
    const descriptor = immutableReferenceStructDescriptor();
    const staticRoot = Object.freeze({ root: "fresh activation" });
    const graph: ForkReferenceRecipeGraph = {
      roots: [0, 1, 2],
      nodes: [
        { id: 0, node: { kind: "null" } },
        {
          id: 1,
          node: {
            kind: "static-root",
            moduleActivation: 1,
            staticRootOrdinal: 0,
          },
        },
        {
          id: 2,
          node: {
            kind: "struct",
            moduleActivation: 2,
            typeOrdinal: 0,
            layoutId: 1,
            scalars: new Uint8Array(),
            fields: [1],
          },
        },
      ],
    };
    const transit = new TestTransit();
    const options = providerOptions(
      recordsFor(graph, [1, 2]),
      [
        { activationId: 1 },
        { activationId: 2, gcDescriptor: descriptor },
      ],
      externrefs(new Map()).provider,
      transit,
    );
    const events: string[] = [];
    const provider = new ForkEarlyChildReferenceProvider(options);
    provider.registerActivation({
      activationId: 1,
      staticRoots: {
        decode: () => staticRoot,
      },
    });
    provider.registerActivation({
      activationId: 2,
      typed: typedProvider(
        2,
        descriptor,
        transit,
        events,
        () => expect(transit.read(1)).toBe(staticRoot),
      ),
    });

    expect(provider.activationDependencies(
      2,
      WPK_FORK_MODULE_STATE_GLOBAL_TYPE_ANYREF,
    )).toEqual([1, 2]);
    expect(provider.materialize(
      2,
      WPK_FORK_MODULE_STATE_GLOBAL_TYPE_ANYREF,
    )).toBe(transit.read(2));
    expect(transit.read(1)).toBe(staticRoot);
    expect(events).toEqual(["allocate:2", "fill:2"]);
  });

  it("publishes an owner token before an immutable GC constructor consumes it", () => {
    const descriptor = immutableReferenceStructDescriptor();
    const token = Object.freeze({ token: "fresh child owner token" });
    const graph: ForkReferenceRecipeGraph = {
      roots: [0, 1, 2],
      nodes: [
        { id: 0, node: { kind: "null" } },
        { id: 1, node: { kind: "externref", handle: 71 } },
        {
          id: 2,
          node: {
            kind: "struct",
            moduleActivation: 2,
            typeOrdinal: 0,
            layoutId: 1,
            scalars: new Uint8Array(),
            fields: [1],
          },
        },
      ],
    };
    const transit = new TestTransit();
    const refs = externrefs(new Map([[71, token]]));
    const options = providerOptions(
      recordsFor(graph, [2]),
      [{ activationId: 2, gcDescriptor: descriptor }],
      refs.provider,
      transit,
    );
    const events: string[] = [];
    const provider = new ForkEarlyChildReferenceProvider(options);
    provider.registerActivation({
      activationId: 2,
      typed: typedProvider(
        2,
        descriptor,
        transit,
        events,
        () => expect(transit.read(1)).toBe(token),
      ),
    });

    expect(provider.materialize(
      2,
      WPK_FORK_MODULE_STATE_GLOBAL_TYPE_ANYREF,
    )).toBe(transit.read(2));
    expect(transit.read(1)).toBe(token);
    expect(refs.materializations).toEqual([71]);
    expect(events).toEqual(["allocate:2", "fill:2"]);
  });

  it("adopts cached undefined and typed identities without reconstructing them twice", () => {
    const descriptor = mutableReferenceStructDescriptor();
    const graph: ForkReferenceRecipeGraph = {
      roots: [0, 1, 2],
      nodes: [
        { id: 0, node: { kind: "null" } },
        { id: 1, node: { kind: "externref", handle: 44 } },
        {
          id: 2,
          node: {
            kind: "struct",
            moduleActivation: 1,
            typeOrdinal: 0,
            layoutId: 1,
            scalars: new Uint8Array(),
            fields: [0],
          },
        },
      ],
    };
    const records = recordsFor(graph, [1]);
    const refs = externrefs(new Map([[44, undefined]]));
    const transit = new TestTransit();
    const options = providerOptions(
      records,
      [{ activationId: 1, gcDescriptor: descriptor }],
      refs.provider,
      transit,
    );
    const events: string[] = [];
    const typed = typedProvider(1, descriptor, transit, events);
    const early = new ForkEarlyChildReferenceProvider(options);
    early.registerActivation({ activationId: 1, typed });

    expect(early.materialize(
      1,
      WPK_FORK_MODULE_STATE_GLOBAL_TYPE_EXTERNREF,
    )).toBeUndefined();
    const typedValue = early.materialize(
      2,
      WPK_FORK_MODULE_STATE_GLOBAL_TYPE_ANYREF,
    );
    expect(events).toEqual(["allocate:2", "fill:2"]);

    const typedOwner: ForkTypedReferenceReplayOwner = {
      prepareTransit: () => {},
      publishTransit: () => {},
      publishExternref: (recipeId, value) => {
        transit.publish(recipeId, value);
        events.push(`publish-externref:${recipeId}`);
      },
      provider: () => typed,
      providers: () => [typed],
      validateExceptionOwner: () => {},
      materializeException: () => {},
    };
    const transaction = new ForkReferenceTransaction(
      new ForkFunctionCatalog(),
      refs.provider,
      options.memory,
      options.allocateScratch,
      options.deallocateScratch,
      "adopted transaction",
      undefined,
      typedOwner,
    );
    transaction.attachChild(options.transaction);
    early.adoptInto(transaction);

    expect(transaction.decodeExternref(1)).toBeUndefined();
    transaction.materializeAllTyped();
    expect(events).toEqual([
      "allocate:2",
      "fill:2",
      "publish-externref:1",
    ]);
    expect(transit.read(2)).toBe(typedValue);
    expect(refs.materializations).toEqual([44]);
    transaction.finishReplay();
    expect(() => early.adoptInto(transaction)).toThrow("was adopted");
  });

  it("allocates defaultable shells before filling cyclic and aliased GC edges", () => {
    const descriptor = mutableReferenceStructDescriptor();
    const graph: ForkReferenceRecipeGraph = {
      roots: [0, 1, 2],
      nodes: [
        { id: 0, node: { kind: "null" } },
        {
          id: 1,
          node: {
            kind: "struct",
            moduleActivation: 1,
            typeOrdinal: 0,
            layoutId: 1,
            scalars: new Uint8Array(),
            fields: [2],
          },
        },
        {
          id: 2,
          node: {
            kind: "struct",
            moduleActivation: 1,
            typeOrdinal: 0,
            layoutId: 1,
            scalars: new Uint8Array(),
            fields: [1],
          },
        },
      ],
    };
    const refs = externrefs(new Map());
    const transit = new TestTransit();
    const options = providerOptions(
      recordsFor(graph, [1]),
      [{ activationId: 1, gcDescriptor: descriptor }],
      refs.provider,
      transit,
    );
    const events: string[] = [];
    const provider = new ForkEarlyChildReferenceProvider(options);
    provider.registerActivation({
      activationId: 1,
      typed: typedProvider(1, descriptor, transit, events),
    });

    const first = provider.materialize(
      1,
      WPK_FORK_MODULE_STATE_GLOBAL_TYPE_ANYREF,
    );
    expect(provider.materialize(
      1,
      WPK_FORK_MODULE_STATE_GLOBAL_TYPE_ANYREF,
    )).toBe(first);
    expect(events).toEqual([
      "allocate:1",
      "allocate:2",
      "fill:1",
      "fill:2",
    ]);
  });

  it("rejects an immutable constructor cycle and cleans partial replay roots", () => {
    const descriptor = immutableReferenceStructDescriptor();
    const graph: ForkReferenceRecipeGraph = {
      roots: [0, 1, 2],
      nodes: [
        { id: 0, node: { kind: "null" } },
        {
          id: 1,
          node: {
            kind: "struct",
            moduleActivation: 1,
            typeOrdinal: 0,
            layoutId: 1,
            scalars: new Uint8Array(),
            fields: [2],
          },
        },
        {
          id: 2,
          node: {
            kind: "struct",
            moduleActivation: 1,
            typeOrdinal: 0,
            layoutId: 1,
            scalars: new Uint8Array(),
            fields: [1],
          },
        },
      ],
    };
    const refs = externrefs(new Map());
    const transit = new TestTransit();
    const options = providerOptions(
      recordsFor(graph, [1]),
      [{ activationId: 1, gcDescriptor: descriptor }],
      refs.provider,
      transit,
    );
    let activationAborts = 0;
    const provider = new ForkEarlyChildReferenceProvider(options);
    provider.registerActivation({
      activationId: 1,
      typed: typedProvider(1, descriptor, transit, []),
      abort: () => { activationAborts++; },
    });

    expect(() => provider.materialize(
      1,
      WPK_FORK_MODULE_STATE_GLOBAL_TYPE_ANYREF,
    )).toThrow("unallocatable constructor cycle");
    expect(transit.aborts).toBe(1);
    expect(activationAborts).toBe(1);
    expect(() => provider.ownerActivation(
      1,
      WPK_FORK_MODULE_STATE_GLOBAL_TYPE_ANYREF,
    )).toThrow("was aborted");
  });

  it("orders GC/exnref dependencies and serves generated replay callbacks", () => {
    const descriptor = mutableReferenceStructDescriptor();
    const graph: ForkReferenceRecipeGraph = {
      roots: [0, 1, 2, 3],
      nodes: [
        { id: 0, node: { kind: "null" } },
        {
          id: 1,
          node: {
            kind: "funcref",
            moduleActivation: 1,
            functionOrdinal: 0,
          },
        },
        {
          id: 2,
          node: {
            kind: "exnref",
            moduleActivation: 2,
            tagOrdinal: 0,
            layoutId: 7,
            scalars: Uint8Array.of(0xaa, 0xbb),
            payloads: [1],
          },
        },
        {
          id: 3,
          node: {
            kind: "struct",
            moduleActivation: 3,
            typeOrdinal: 0,
            layoutId: 1,
            scalars: new Uint8Array(),
            fields: [2],
          },
        },
      ],
    };
    const refs = externrefs(new Map());
    const transit = new TestTransit();
    const options = providerOptions(
      recordsFor(graph, [1, 2, 3], [], [[1]]),
      [
        { activationId: 1 },
        {
          activationId: 2,
          exceptionDescriptor: {
            version: 1,
            tags: [{
              tagOrdinal: 0,
              layoutId: 7,
              scalarByteLength: 2,
              referenceCount: 1,
            }],
          },
        },
        { activationId: 3, gcDescriptor: descriptor },
      ],
      refs.provider,
      transit,
    );
    const events: string[] = [];
    const provider = new ForkEarlyChildReferenceProvider(options);
    const callback = (() => 12) as CallableFunction;
    provider.registerActivation({
      activationId: 1,
      functions: {
        decode(ordinal) {
          events.push(`function:${ordinal}`);
          return callback;
        },
      },
    });
    provider.registerActivation({
      activationId: 2,
      exceptions: {
        throwSlot(): never {
          throw new Error("unused exception slot");
        },
        throwRecipe(): never {
          throw new Error("unused exception throw");
        },
        encodeIngress: () => 0,
        materialize(recipeId) {
          events.push(`exception:${recipeId}`);
          expect(provider.routeException(recipeId, 2)).toBe(7);
          expect(provider.exceptionCacheIndex(recipeId)).toBe(1);
          const scratch = provider.reserveScratch(16);
          new Uint8Array(options.memory.buffer, scratch, 16).fill(0xcc);
          expect(provider.loadException(
            recipeId,
            2,
            0,
            7,
            scratch,
            2,
            scratch + 4,
            1,
          )).toBe(1);
          expect([...new Uint8Array(options.memory.buffer, scratch, 2)])
            .toEqual([0xaa, 0xbb]);
          expect(new DataView(options.memory.buffer).getUint32(scratch + 4, true))
            .toBe(1);
          provider.releaseScratch(scratch, 16);
          expect(new Uint8Array(options.memory.buffer, scratch, 16)
            .every((byte) => byte === 0)).toBe(true);
        },
        clear: () => {},
        abort: () => {},
      },
    });
    provider.registerActivation({
      activationId: 3,
      typed: typedProvider(
        3,
        descriptor,
        transit,
        events,
        (recipeId) => {
          expect(provider.routeGc(recipeId, 3)).toBe(1);
          expect(provider.gcPayloadLength(recipeId, 3, 1)).toBe(0);
          const scratch = provider.reserveScratch(1);
          const vector = provider.loadGc(
            recipeId,
            3,
            0,
            1,
            1,
            scratch,
            0,
          );
          expect(provider.getReferenceVector(vector, 0)).toBe(2);
          provider.releaseScratch(scratch, 1);
        },
      ),
    });

    expect(provider.ownerActivation(
      2,
      WPK_FORK_MODULE_STATE_GLOBAL_TYPE_EXNREF,
    )).toBe(2);
    expect(provider.activationDependencies(
      3,
      WPK_FORK_MODULE_STATE_GLOBAL_TYPE_ANYREF,
    )).toEqual([1, 2, 3]);
    expect(provider.getReferenceVector(1, 0)).toBe(1);
    expect(() => provider.captureUnavailable("encode funcref"))
      .toThrow("unavailable during pre-instantiation child replay");

    provider.materialize(
      3,
      WPK_FORK_MODULE_STATE_GLOBAL_TYPE_ANYREF,
    );
    expect(events).toEqual([
      "allocate:3",
      "function:0",
      "exception:2",
      "fill:3",
    ]);
    provider.abort();
    expect(options.scratch.deallocated).toEqual([
      { addr: 65_536, size: 65_536 },
    ]);
  });

  it("routes host-owned exception recipes through the canonical externref token", () => {
    const hostException = Object.freeze({ host: "fresh child token" });
    const graph: ForkReferenceRecipeGraph = {
      roots: [0, 1, 2],
      nodes: [
        { id: 0, node: { kind: "null" } },
        { id: 1, node: { kind: "externref", handle: 73 } },
        {
          id: 2,
          node: {
            kind: "exnref",
            moduleActivation: FORK_HOST_EXCEPTION_ACTIVATION_ID,
            tagOrdinal: 0,
            layoutId: 0,
            scalars: new Uint8Array(),
            payloads: [1],
          },
        },
      ],
    };
    const refs = externrefs(new Map([[73, hostException]]));
    const transit = new TestTransit();
    const options = providerOptions(
      recordsFor(graph, [5]),
      [{
        activationId: 5,
        exceptionDescriptor: { version: 1, tags: [] },
      }],
      refs.provider,
      transit,
    );
    const provider = new ForkEarlyChildReferenceProvider(options);
    provider.registerActivation({
      activationId: 5,
      exceptions: {
        throwSlot(): never {
          throw new Error("unused exception slot");
        },
        throwRecipe(): never {
          throw new Error("unused exception throw");
        },
        encodeIngress: () => 0,
        materialize: () => {},
        clear: () => {},
        abort: () => {},
      },
    });

    expect(provider.activationDependencies(
      2,
      WPK_FORK_MODULE_STATE_GLOBAL_TYPE_EXNREF,
    )).toEqual([5]);
    expect(provider.exceptionOwner(2)).toBe(
      FORK_HOST_EXCEPTION_ACTIVATION_ID,
    );
    expect(provider.materializeHostException(2)).toBe(hostException);
    expect(provider.materializeHostException(2)).toBe(hostException);
    expect(refs.materializations).toEqual([73]);
    expect(() => provider.materializeHostException(1))
      .toThrow("is not an exception");
  });

  it("rejects malformed recipe ownership and non-null raw exnref provenance", () => {
    const missingOwner: ForkReferenceRecipeGraph = {
      roots: [0, 1],
      nodes: [
        { id: 0, node: { kind: "null" } },
        {
          id: 1,
          node: {
            kind: "funcref",
            moduleActivation: 9,
            functionOrdinal: 0,
          },
        },
      ],
    };
    const refs = externrefs(new Map());
    const transit = new TestTransit();
    expect(() => new ForkEarlyChildReferenceProvider(providerOptions(
      recordsFor(missingOwner, [1]),
      [{ activationId: 1 }],
      refs.provider,
      transit,
    ))).toThrow("names missing activation 9");

    const exnGraph: ForkReferenceRecipeGraph = {
      roots: [0, 1],
      nodes: [
        { id: 0, node: { kind: "null" } },
        {
          id: 1,
          node: {
            kind: "exnref",
            moduleActivation: 1,
            tagOrdinal: 0,
            layoutId: 3,
            scalars: new Uint8Array(),
            payloads: [],
          },
        },
      ],
    };
    const rawExnBinding: ForkImportedGlobalBinding = {
      consumerActivation: 1,
      consumerOwner: 1,
      sourceActivation: 0,
      sourceOwner: 0,
      reserved: 0,
      recipeId: 1,
      rawBits: 0n,
      kind: ForkImportedGlobalBindingKind.RawReference,
      mutable: false,
      shared: false,
      typeCode: WPK_FORK_MODULE_STATE_GLOBAL_TYPE_EXNREF,
    };
    expect(() => new ForkEarlyChildReferenceProvider(providerOptions(
      recordsFor(exnGraph, [1], [rawExnBinding]),
      [{
        activationId: 1,
        exceptionDescriptor: {
          version: 1,
          tags: [{
            tagOrdinal: 0,
            layoutId: 3,
            scalarByteLength: 0,
            referenceCount: 0,
          }],
        },
      }],
      refs.provider,
      new TestTransit(),
    ))).toThrow("non-null raw recipe");
  });

  it("zeros live scratch and releases activation roots on abort", () => {
    const refs = externrefs(new Map());
    const transit = new TestTransit();
    const options = providerOptions(
      recordsFor(nullGraph(), [1]),
      [{ activationId: 1 }],
      refs.provider,
      transit,
    );
    let activationAborts = 0;
    const provider = new ForkEarlyChildReferenceProvider(options);
    provider.registerActivation({
      activationId: 1,
      abort: () => { activationAborts++; },
    });
    const scratch = provider.reserveScratch(32);
    new Uint8Array(options.memory.buffer, scratch, 32).fill(0x5a);
    provider.abort();

    expect(new Uint8Array(options.memory.buffer, scratch, 32)
      .every((byte) => byte === 0)).toBe(true);
    expect(options.scratch.deallocated).toEqual([
      { addr: 65_536, size: 65_536 },
    ]);
    expect(activationAborts).toBe(1);
    expect(transit.aborts).toBe(1);
    provider.abort();
    expect(activationAborts).toBe(1);
    expect(() => provider.materialize(
      0,
      WPK_FORK_MODULE_STATE_GLOBAL_TYPE_EXTERNREF,
    )).toThrow("was aborted");
  });
});
