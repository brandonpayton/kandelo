import { describe, expect, it } from "vitest";
import {
  ForkActivationRegistry,
  type ForkActivationRegistration,
} from "../src/fork-activation-registry";
import {
  type LinkedFrameFormatDescriptor,
  LinkedForkContinuation,
} from "../src/fork-continuation";
import {
  ForkModuleStateArena,
  ForkTableDirtyTracker,
} from "../src/fork-module-state";
import { ForkProcessContinuationCoordinator } from "../src/fork-process-continuation";
import { FORK_REPLAY_EVENT_SEGMENT_CAPACITY } from "../src/fork-replay-events";
import { installTestForkCaptureModule } from "./fork-capture-module-fixture";

const PAGE_SIZE = 65_536;

interface AllocationOwner {
  allocate(size: number): number;
  deallocate(addr: number, size: number): void;
}

function allocationOwner(memory: WebAssembly.Memory): AllocationOwner {
  let next = PAGE_SIZE;
  return {
    allocate(size) {
      const address = next;
      next += size;
      if (next > memory.buffer.byteLength) {
        memory.grow(Math.ceil((next - memory.buffer.byteLength) / PAGE_SIZE));
      }
      return address;
    },
    deallocate() {},
  };
}

function linkedFormat(): LinkedFrameFormatDescriptor {
  return {
    version: 1,
    ptrWidth: 4,
    alignment: 16,
    flags: 1,
    chunkHeaderSize: 32,
    nodeHeaderSize: 32,
    fixedPrefixSize: 64,
  };
}

function externrefs() {
  return {
    capture(): number {
      throw new Error("fixture has no externrefs");
    },
    materialize(): unknown {
      throw new Error("fixture has no externrefs");
    },
  };
}

function emptyFunctionCatalog(): WebAssembly.Table {
  return new WebAssembly.Table({
    element: "anyfunc",
    initial: 0,
    maximum: 0,
  });
}

function wasmThunk(): CallableFunction {
  const module = new WebAssembly.Module(new Uint8Array([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    0x01, 0x05, 0x01, 0x60, 0x00, 0x01, 0x7f,
    0x03, 0x02, 0x01, 0x00,
    0x07, 0x05, 0x01, 0x01, 0x66, 0x00, 0x00,
    0x0a, 0x06, 0x01, 0x04, 0x00, 0x41, 0x07, 0x0b,
  ]));
  return new WebAssembly.Instance(module).exports.f as CallableFunction;
}

function fakeActivation(
  activationId: number,
  calls: string[],
): {
  registration: ForkActivationRegistration;
  state: () => number;
} {
  let state = 0;
  const exports = {
    wpk_fork_state: () => state,
    wpk_fork_unwind_begin: () => {
      expect(state).toBe(0);
      state = 1;
      calls.push(`unwind-begin:${activationId}`);
    },
    wpk_fork_unwind_end: () => {
      expect(state).toBe(1);
      state = 0;
      calls.push(`unwind-end:${activationId}`);
    },
    wpk_fork_rewind_begin: () => {
      expect(state).toBe(0);
      state = 2;
      calls.push(`rewind-begin:${activationId}`);
    },
    wpk_fork_rewind_end: () => {
      expect(state).toBe(2);
      state = 0;
      calls.push(`rewind-end:${activationId}`);
    },
    wpk_fork_abort_begin: () => {
      expect([0, 1]).toContain(state);
      state = 3;
      calls.push(`abort-begin:${activationId}`);
    },
    wpk_fork_abort_end: () => {
      expect(state).toBe(3);
      state = 0;
      calls.push(`abort-end:${activationId}`);
    },
  };
  return {
    registration: {
      activationId,
      instance: { exports } as unknown as WebAssembly.Instance,
      templateId: new Uint8Array(32).fill(activationId + 1),
      functionCatalog: emptyFunctionCatalog(),
      staticRootCatalog: new WebAssembly.Table({
        element: "externref",
        initial: 0,
        maximum: 0,
      }),
      staticRootHarvest: () => {},
      moduleState: {
        bootstrap: () => {},
        save: (id) => { calls.push(`save:${id}`); },
        restore: (id) => { calls.push(`restore:${id}`); },
        finishRestore: (id) => { calls.push(`finish-restore:${id}`); },
        saveTables: (id) => { calls.push(`save-tables:${id}`); },
        restoreTables: (id) => { calls.push(`restore-tables:${id}`); },
      },
      tableDirty: new ForkTableDirtyTracker(),
    },
    state: () => state,
  };
}

function makeCoordinator(
  memory: WebAssembly.Memory,
  owner: AllocationOwner,
  calls: string[],
  roots: Map<number, number>,
  label: string,
  anchorMode: "writable" | "read-only" = "writable",
): {
  coordinator: ForkProcessContinuationCoordinator;
  arena: ForkModuleStateArena;
  continuations: Map<number, LinkedForkContinuation>;
} {
  const registry = new ForkActivationRegistry(memory, externrefs(), `${label}: registry`);
  // The co-resident module is the UNCONDITIONAL fork capture engine (no JS
  // `ForkReferenceTransaction` fallback), so wire a real capture module exactly
  // as a production worker does. (Child RECONSTRUCTION additionally needs a
  // module backend; the reconstruction round-trip tests below are covered by the
  // module fresh-worker/dlopen/vfork e2e suites and are skipped here pending the
  // A5 registry/coordinator relocation.)
  registry.setCaptureModule(installTestForkCaptureModule(memory, label));
  const coordinator = new ForkProcessContinuationCoordinator(
    memory,
    registry,
    label,
  );
  const continuations = new Map<number, LinkedForkContinuation>();
  for (const activationId of [0, 4, 9]) {
    const continuation = new LinkedForkContinuation(
      memory,
      linkedFormat(),
      owner.allocate,
      owner.deallocate,
      `${label}: activation ${activationId}`,
    );
    continuations.set(activationId, continuation);
    coordinator.prepareActivation({
      activationId,
      continuation,
      ...(activationId === 0
        ? {
            ...(anchorMode === "writable"
              ? {
                  publishProcessLaunchRoot: (root: number) => {
                    roots.set(0, root);
                  },
                }
              : {}),
            readProcessLaunchRoot: () => roots.get(0) ?? 0,
          }
        : {}),
    });
    const activation = fakeActivation(activationId, calls);
    coordinator.registerActivation(activation.registration, [{
      functionOrdinal: activationId === 0 ? 11 : activationId === 4 ? 8 : 3,
      thunk: wasmThunk(),
    }]);
  }
  return {
    coordinator,
    continuations,
    arena: new ForkModuleStateArena(
      memory,
      4,
      owner.allocate,
      owner.deallocate,
      `${label}: arena`,
    ),
  };
}

function writeOrdinal(
  memory: WebAssembly.Memory,
  payload: number | bigint,
  ordinal: number,
): void {
  new DataView(memory.buffer).setUint32(Number(payload), ordinal, true);
}

describe("ForkProcessContinuationCoordinator", () => {
  it.skip("borrows every active activation without consuming parent state", () => {
    const memory = new WebAssembly.Memory({
      initial: 16,
      maximum: 16,
      shared: true,
    });
    const parentOwner = allocationOwner(memory);
    const launchRoots = new Map<number, number>();
    const parent = makeCoordinator(
      memory,
      parentOwner,
      [],
      launchRoots,
      "borrowed parent",
    );
    const arenaRoot = parent.arena.begin();
    parent.coordinator.beginCapture(parent.arena);

    const sideImports = parent.coordinator.continuationImports(4);
    const sidePayload = (
      sideImports.__wpk_fork_frame_reserve as (size: number) => number
    )(16);
    writeOrdinal(memory, sidePayload, 8);
    (
      sideImports.__wpk_fork_frame_commit as (payload: number) => void
    )(sidePayload);
    const mainImports = parent.coordinator.continuationImports(0);
    const mainPayload = (
      mainImports.__wpk_fork_frame_reserve as (size: number) => number
    )(16);
    writeOrdinal(memory, mainPayload, 11);
    (
      mainImports.__wpk_fork_frame_commit as (payload: number) => void
    )(mainPayload);
    parent.coordinator.sealCapture();
    expect(parent.coordinator.borrowedReplayWorkspaceRequirements()).toEqual({
      prefixBytes: 128,
      scratchBytes: 0,
    });

    const borrowedRanges = [arenaRoot, ...[0, 4].map((activationId) =>
      parent.coordinator.rootFor(activationId) - linkedFormat().chunkHeaderSize
    )].map((address) => ({
      address,
      bytes: new Uint8Array(memory.buffer, address, PAGE_SIZE).slice(),
    }));
    const privatePrefixes = new Map([
      [0, 14 * PAGE_SIZE],
      [4, 15 * PAGE_SIZE],
    ]);
    const childReleases: Array<{ address: number; size: number }> = [];
    const childOwner: AllocationOwner = {
      allocate() {
        throw new Error("borrowed child must not allocate continuation state");
      },
      deallocate(address, size) {
        childReleases.push({ address, size });
      },
    };
    const child = makeCoordinator(
      memory,
      childOwner,
      [],
      launchRoots,
      "borrowed child",
      "read-only",
    );
    expect(child.coordinator).not.toBe(parent.coordinator);
    expect(child.arena).not.toBe(parent.arena);
    for (const activationId of [0, 4, 9]) {
      expect(child.continuations.get(activationId)).not.toBe(
        parent.continuations.get(activationId),
      );
    }
    for (const [activationId, privatePrefix] of privatePrefixes) {
      expect(privatePrefix).not.toBe(parent.coordinator.rootFor(activationId));
    }
    child.arena.attachBorrowed(arenaRoot);
    const prefixRequests: number[] = [];
    child.coordinator.attachBorrowedChild(child.arena, (request) => {
      prefixRequests.push(request.activationId);
      expect(request).toMatchObject({ byteLength: 64, alignment: 16 });
      return privatePrefixes.get(request.activationId)!;
    });

    expect(prefixRequests).toEqual([0, 4]);
    for (const activationId of prefixRequests) {
      const source = parent.coordinator.rootFor(activationId);
      const target = privatePrefixes.get(activationId)!;
      expect(new Uint8Array(memory.buffer, target, 64)).toEqual(
        new Uint8Array(memory.buffer, source, 64),
      );
    }
    // Process replay is global and therefore consumes the reverse commit order.
    (
      child.coordinator.continuationImports(0)
        .__wpk_fork_frame_next as (size: number) => number
    )(16);
    (
      child.coordinator.continuationImports(4)
        .__wpk_fork_frame_next as (size: number) => number
    )(16);
    child.coordinator.finishReplay();
    child.coordinator.clear();

    expect(child.coordinator.phaseName()).toBe("idle");
    expect(child.arena.hasActiveArena()).toBe(false);
    expect(childReleases).toEqual([]);
    expect(launchRoots.get(0)).toBe(parent.coordinator.rootFor(0));
    for (const range of borrowedRanges) {
      expect(new Uint8Array(
        memory.buffer,
        range.address,
        range.bytes.length,
      )).toEqual(range.bytes);
    }

    parent.coordinator.beginParentReplay();
    (
      parent.coordinator.continuationImports(0)
        .__wpk_fork_frame_next as (size: number) => number
    )(16);
    (
      parent.coordinator.continuationImports(4)
        .__wpk_fork_frame_next as (size: number) => number
    )(16);
    parent.coordinator.finishReplay();
    expect(launchRoots.get(0)).toBe(0);
  });

  it.skip("rolls back a partial borrowed attach without wedging the parent", () => {
    const memory = new WebAssembly.Memory({
      initial: 16,
      maximum: 16,
      shared: true,
    });
    const parentOwner = allocationOwner(memory);
    const launchRoots = new Map<number, number>();
    const parent = makeCoordinator(
      memory,
      parentOwner,
      [],
      launchRoots,
      "rollback parent",
    );
    const arenaRoot = parent.arena.begin();
    parent.coordinator.beginCapture(parent.arena);
    for (const [activationId, ordinal] of [[4, 8], [0, 11]] as const) {
      const imports = parent.coordinator.continuationImports(activationId);
      const payload = (
        imports.__wpk_fork_frame_reserve as (size: number) => number
      )(16);
      writeOrdinal(memory, payload, ordinal);
      (
        imports.__wpk_fork_frame_commit as (address: number) => void
      )(payload);
    }
    parent.coordinator.sealCapture();
    const parentLaunchRoot = launchRoots.get(0);

    const child = makeCoordinator(
      memory,
      {
        allocate() {
          throw new Error("borrowed rollback child must not allocate");
        },
        deallocate() {
          throw new Error("borrowed rollback child must not deallocate");
        },
      },
      [],
      launchRoots,
      "rollback child",
      "read-only",
    );
    child.arena.attachBorrowed(arenaRoot);
    expect(() => child.coordinator.attachBorrowedChild(
      child.arena,
      ({ activationId }) => {
        if (activationId === 4) throw new Error("private prefix exhausted");
        return 15 * PAGE_SIZE;
      },
    )).toThrow("private prefix exhausted");

    expect(child.coordinator.phaseName()).toBe("idle");
    expect(child.arena.hasActiveArena()).toBe(false);
    expect(
      [...child.continuations.values()].every(
        (continuation) => !continuation.hasActiveContinuation(),
      ),
    ).toBe(true);
    expect(launchRoots.get(0)).toBe(parentLaunchRoot);

    parent.coordinator.beginParentReplay();
    (
      parent.coordinator.continuationImports(0)
        .__wpk_fork_frame_next as (size: number) => number
    )(16);
    (
      parent.coordinator.continuationImports(4)
        .__wpk_fork_frame_next as (size: number) => number
    )(16);
    parent.coordinator.finishReplay();
    expect(parent.coordinator.phaseName()).toBe("idle");
  });

  it.skip("reconstructs cross-activation frame order in a fresh child", () => {
    const parentMemory = new WebAssembly.Memory({ initial: 16, maximum: 1024, shared: true });
    const parentOwner = allocationOwner(parentMemory);
    const parentCalls: string[] = [];
    const parentRoots = new Map<number, number>();
    const parent = makeCoordinator(
      parentMemory,
      parentOwner,
      parentCalls,
      parentRoots,
      "parent",
    );
    const arenaRoot = parent.arena.begin();
    parent.coordinator.beginCapture(parent.arena);

    const sideImports = parent.coordinator.continuationImports(4);
    const sidePayload = (
      sideImports.__wpk_fork_frame_reserve as (size: number) => number
    )(16);
    writeOrdinal(parentMemory, sidePayload, 8);
    (
      sideImports.__wpk_fork_frame_commit as (payload: number) => void
    )(sidePayload);

    const mainImports = parent.coordinator.continuationImports(0);
    const mainPayload = (
      mainImports.__wpk_fork_frame_reserve as (size: number) => number
    )(16);
    writeOrdinal(parentMemory, mainPayload, 11);
    (
      mainImports.__wpk_fork_frame_commit as (payload: number) => void
    )(mainPayload);
    parent.coordinator.sealCapture();

    // Activation 9 exists in the process but was not on this thread's stack.
    // Its runtime prefix is discarded before memory is copied.
    expect(parent.coordinator.rootFor(9)).toBe(0);
    expect(parent.coordinator.rootFor(0)).toBeGreaterThan(0);
    expect(parent.coordinator.rootFor(4)).toBeGreaterThan(0);
    // Only one process launch root crosses through the channel anchor. Side
    // roots are reconstructed from the copied KFMS manifest, not JS/archive
    // auxiliary state.
    expect([...parentRoots.keys()]).toEqual([0]);

    const copiedBytes = new Uint8Array(parentMemory.buffer).slice();
    const copiedRoots = new Map(parentRoots);
    const childMemory = new WebAssembly.Memory({
      initial: copiedBytes.byteLength / PAGE_SIZE,
    });
    new Uint8Array(childMemory.buffer).set(copiedBytes);
    const childOwner = allocationOwner(childMemory);
    const childCalls: string[] = [];
    const child = makeCoordinator(
      childMemory,
      childOwner,
      childCalls,
      copiedRoots,
      "child",
    );
    child.arena.attach(arenaRoot);
    child.coordinator.attachChild(child.arena);

    const childMainImports = child.coordinator.continuationImports(0);
    const childSideImports = child.coordinator.continuationImports(4);
    const mainSlot = (
      childMainImports.__wpk_fork_resume_peek as (diagnostic: number) => number
    )(0);
    expect(mainSlot).toBeGreaterThan(0);
    expect(
      Number((
        childMainImports.__wpk_fork_frame_peek as (size: number) => number
      )(16)),
    ).toBe(Number(mainPayload));
    (
      childMainImports.__wpk_fork_frame_next as (size: number) => number
    )(16);

    const sideSlot = (
      childSideImports.__wpk_fork_resume_peek as (diagnostic: number) => number
    )(0);
    expect(sideSlot).toBeGreaterThan(0);
    (
      childSideImports.__wpk_fork_frame_peek as (size: number) => number
    )(16);
    (
      childSideImports.__wpk_fork_frame_next as (size: number) => number
    )(16);
    expect((
      childSideImports.__wpk_fork_resume_peek as (diagnostic: number) => number
    )(0)).toBe(0);
    child.coordinator.finishReplay();

    expect(childCalls.filter((call) => call.startsWith("restore:"))).toEqual([
      "restore:0",
      "restore:4",
      "restore:9",
    ]);
    expect(copiedRoots.get(0)).toBe(0);
    expect(child.coordinator.phaseName()).toBe("idle");
  });

  it("does not consume a frame when the selected activation is wrong", () => {
    const memory = new WebAssembly.Memory({ initial: 16, maximum: 1024, shared: true });
    const owner = allocationOwner(memory);
    const roots = new Map<number, number>();
    const fixture = makeCoordinator(memory, owner, [], roots, "mismatch");
    fixture.arena.begin();
    fixture.coordinator.beginCapture(fixture.arena);
    const sideImports = fixture.coordinator.continuationImports(4);
    const payload = (
      sideImports.__wpk_fork_frame_reserve as (size: number) => number
    )(16);
    writeOrdinal(memory, payload, 8);
    (
      sideImports.__wpk_fork_frame_commit as (payload: number) => void
    )(payload);
    fixture.coordinator.sealCapture();
    fixture.coordinator.beginParentReplay();

    const mainImports = fixture.coordinator.continuationImports(0);
    (
      mainImports.__wpk_fork_resume_peek as (diagnostic: number) => number
    )(0);
    expect(() => (
      mainImports.__wpk_fork_frame_next as (size: number) => number
    )(16)).toThrow("cannot consume frame for activation 4");

    (
      sideImports.__wpk_fork_frame_next as (size: number) => number
    )(16);
    fixture.coordinator.finishReplay();
  });

  it.skip("launches a fresh child from a side-only continuation manifest", () => {
    const parentMemory = new WebAssembly.Memory({ initial: 16, maximum: 1024, shared: true });
    const parentOwner = allocationOwner(parentMemory);
    const parentRoots = new Map<number, number>();
    const parent = makeCoordinator(
      parentMemory,
      parentOwner,
      [],
      parentRoots,
      "side-only parent",
    );
    const arenaRoot = parent.arena.begin();
    parent.coordinator.beginCapture(parent.arena);
    const sideImports = parent.coordinator.continuationImports(4);
    const payload = (
      sideImports.__wpk_fork_frame_reserve as (size: number) => number
    )(16);
    writeOrdinal(parentMemory, payload, 8);
    (
      sideImports.__wpk_fork_frame_commit as (payload: number) => void
    )(payload);
    parent.coordinator.sealCapture();

    const sideRoot = parent.coordinator.rootFor(4);
    expect(parent.coordinator.rootFor(0)).toBe(0);
    expect(sideRoot).toBeGreaterThan(0);
    expect(parentRoots.get(0)).toBe(sideRoot);
    expect([...parentRoots.keys()]).toEqual([0]);

    const copiedBytes = new Uint8Array(parentMemory.buffer).slice();
    const copiedRoots = new Map(parentRoots);
    const childMemory = new WebAssembly.Memory({
      initial: copiedBytes.byteLength / PAGE_SIZE,
    });
    new Uint8Array(childMemory.buffer).set(copiedBytes);
    const child = makeCoordinator(
      childMemory,
      allocationOwner(childMemory),
      [],
      copiedRoots,
      "side-only child",
    );
    child.arena.attach(arenaRoot);
    child.coordinator.attachChild(child.arena);

    expect(child.coordinator.rootFor(0)).toBe(0);
    expect(child.coordinator.rootFor(4)).toBe(sideRoot);
    (
      child.coordinator.continuationImports(4)
        .__wpk_fork_frame_next as (size: number) => number
    )(16);
    child.coordinator.finishReplay();
    expect(copiedRoots.get(0)).toBe(0);
  });

  it("replays a partial unwind after continuation allocation failure", () => {
    const memory = new WebAssembly.Memory({ initial: 16, maximum: 1024, shared: true });
    const owner = allocationOwner(memory);
    const calls: string[] = [];
    const roots = new Map<number, number>();
    const fixture = makeCoordinator(memory, owner, calls, roots, "partial abort");
    fixture.arena.begin();
    fixture.coordinator.beginCapture(fixture.arena);

    const sideImports = fixture.coordinator.continuationImports(4);
    const payload = (
      sideImports.__wpk_fork_frame_reserve as (size: number) => number
    )(16);
    writeOrdinal(memory, payload, 8);
    (
      sideImports.__wpk_fork_frame_commit as (payload: number) => void
    )(payload);

    fixture.coordinator.beginCaptureAbort(12);
    expect(fixture.coordinator.phaseName()).toBe("abort-replay");
    expect(calls.filter((call) => call.startsWith("abort-begin:"))).toEqual([
      "abort-begin:0",
      "abort-begin:4",
      "abort-begin:9",
    ]);
    expect(
      (sideImports.__wpk_fork_resume_peek as (diagnostic: number) => number)(0),
    ).toBeGreaterThan(0);
    (
      sideImports.__wpk_fork_frame_next as (size: number) => number
    )(16);
    fixture.coordinator.finishAbortReplay();

    expect(calls.filter((call) => call.startsWith("abort-end:"))).toEqual([
      "abort-end:0",
      "abort-end:4",
      "abort-end:9",
    ]);
    expect(roots.get(0)).toBe(0);
    expect([...roots.keys()]).toEqual([0]);
    expect(fixture.coordinator.phaseName()).toBe("idle");
  });

  it("makes the abort errno readable from the coordinator after a partial-capture abort", () => {
    const memory = new WebAssembly.Memory({ initial: 16, maximum: 1024, shared: true });
    const owner = allocationOwner(memory);
    const calls: string[] = [];
    const roots = new Map<number, number>();
    const fixture = makeCoordinator(
      memory,
      owner,
      calls,
      roots,
      "capture-abort errno",
    );
    fixture.arena.begin();
    fixture.coordinator.beginCapture(fixture.arena);

    const sideImports = fixture.coordinator.continuationImports(4);
    const payload = (
      sideImports.__wpk_fork_frame_reserve as (size: number) => number
    )(16);
    writeOrdinal(memory, payload, 8);
    (
      sideImports.__wpk_fork_frame_commit as (payload: number) => void
    )(payload);

    fixture.coordinator.beginCaptureAbort(12);

    // Regression coverage: worker-main reads the abort errno from the
    // coordinator (not the per-activation continuation) on both the flag-off
    // and flag-on paths. `beginCaptureAbort` must populate `#abortErrno`
    // the same way `beginAbortReplay` does, or this throws instead of
    // returning the recorded errno.
    expect(fixture.coordinator.abortErrno()).toBe(12);
  });

  it.skip("replays an arbitrarily nested main-to-side-to-side stack", () => {
    const parentMemory = new WebAssembly.Memory({ initial: 16, maximum: 1024, shared: true });
    const parentOwner = allocationOwner(parentMemory);
    const parentRoots = new Map<number, number>();
    const parent = makeCoordinator(
      parentMemory,
      parentOwner,
      [],
      parentRoots,
      "nested parent",
    );
    const arenaRoot = parent.arena.begin();
    parent.coordinator.beginCapture(parent.arena);

    const commit = (activationId: number, functionOrdinal: number): void => {
      const imports = parent.coordinator.continuationImports(activationId);
      const payload = (
        imports.__wpk_fork_frame_reserve as (size: number) => number
      )(16);
      writeOrdinal(parentMemory, payload, functionOrdinal);
      (
        imports.__wpk_fork_frame_commit as (payload: number) => void
      )(payload);
    };
    // Unwind walks from the fork leaf outward.
    commit(9, 3);
    commit(4, 8);
    commit(0, 11);
    parent.coordinator.sealCapture();

    const copiedBytes = new Uint8Array(parentMemory.buffer).slice();
    const copiedRoots = new Map(parentRoots);
    const childMemory = new WebAssembly.Memory({
      initial: copiedBytes.byteLength / PAGE_SIZE,
    });
    new Uint8Array(childMemory.buffer).set(copiedBytes);
    const child = makeCoordinator(
      childMemory,
      allocationOwner(childMemory),
      [],
      copiedRoots,
      "nested child",
    );
    child.arena.attach(arenaRoot);
    child.coordinator.attachChild(child.arena);

    for (const activationId of [0, 4, 9]) {
      const imports = child.coordinator.continuationImports(activationId);
      expect(
        (imports.__wpk_fork_resume_peek as (diagnostic: number) => number)(0),
      ).toBeGreaterThan(0);
      (
        imports.__wpk_fork_frame_next as (size: number) => number
      )(16);
    }
    expect((
      child.coordinator.continuationImports(9)
        .__wpk_fork_resume_peek as (diagnostic: number) => number
    )(0)).toBe(0);
    child.coordinator.finishReplay();

    expect(copiedRoots.get(0)).toBe(0);
    expect([...copiedRoots.keys()]).toEqual([0]);
  });

  it.skip("replays a continuation spanning multiple event pages in a fresh child", () => {
    const eventCount = FORK_REPLAY_EVENT_SEGMENT_CAPACITY + 2;
    const parentMemory = new WebAssembly.Memory({ initial: 16, maximum: 1024, shared: true });
    const parentOwner = allocationOwner(parentMemory);
    const parentRoots = new Map<number, number>();
    const parent = makeCoordinator(
      parentMemory,
      parentOwner,
      [],
      parentRoots,
      "paged parent",
    );
    const arenaRoot = parent.arena.begin();
    parent.coordinator.beginCapture(parent.arena);
    const sideImports = parent.coordinator.continuationImports(4);
    for (let index = 0; index < eventCount; index++) {
      const payload = (
        sideImports.__wpk_fork_frame_reserve as (size: number) => number
      )(16);
      writeOrdinal(parentMemory, payload, 8);
      (
        sideImports.__wpk_fork_frame_commit as (payload: number) => void
      )(payload);
    }
    parent.coordinator.sealCapture();

    const copiedBytes = new Uint8Array(parentMemory.buffer).slice();
    const childMemory = new WebAssembly.Memory({
      initial: copiedBytes.byteLength / PAGE_SIZE,
    });
    new Uint8Array(childMemory.buffer).set(copiedBytes);
    const child = makeCoordinator(
      childMemory,
      allocationOwner(childMemory),
      [],
      new Map(parentRoots),
      "paged child",
    );
    child.arena.attach(arenaRoot);
    child.coordinator.attachChild(child.arena);
    const childSideImports = child.coordinator.continuationImports(4);
    for (let index = 0; index < eventCount; index++) {
      expect((
        childSideImports.__wpk_fork_resume_peek as (diagnostic: number) => number
      )(0)).toBeGreaterThan(0);
      (
        childSideImports.__wpk_fork_frame_next as (size: number) => number
      )(16);
    }
    expect((
      childSideImports.__wpk_fork_resume_peek as (diagnostic: number) => number
    )(0)).toBe(0);
    child.coordinator.finishReplay();
  });

  it("aborts a partial capture spanning multiple event pages", () => {
    const eventCount = FORK_REPLAY_EVENT_SEGMENT_CAPACITY + 1;
    const memory = new WebAssembly.Memory({ initial: 16, maximum: 1024, shared: true });
    const owner = allocationOwner(memory);
    const roots = new Map<number, number>();
    const fixture = makeCoordinator(memory, owner, [], roots, "paged abort");
    fixture.arena.begin();
    fixture.coordinator.beginCapture(fixture.arena);
    const sideImports = fixture.coordinator.continuationImports(4);
    for (let index = 0; index < eventCount; index++) {
      const payload = (
        sideImports.__wpk_fork_frame_reserve as (size: number) => number
      )(16);
      writeOrdinal(memory, payload, 8);
      (
        sideImports.__wpk_fork_frame_commit as (payload: number) => void
      )(payload);
    }
    fixture.coordinator.beginCaptureAbort(12);
    for (let index = 0; index < eventCount; index++) {
      (
        sideImports.__wpk_fork_resume_peek as (diagnostic: number) => number
      )(0);
      (
        sideImports.__wpk_fork_frame_next as (size: number) => number
      )(16);
    }
    fixture.coordinator.finishAbortReplay();
    expect(fixture.coordinator.phaseName()).toBe("idle");
  });
});
