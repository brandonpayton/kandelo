import { describe, expect, it } from "vitest";
import type { DlopenSupport } from "../src/worker-main";
import {
  __testCreateProcessTableReplicationOwner,
} from "../src/worker-main";
import {
  DylinkForkArchive,
  type DylinkForkTablePatch,
} from "../src/dylink-fork-archive";
import type { ForkActivationRegistry } from "../src/fork-activation-registry";
import type { ForkTableSnapshot } from "../src/fork-table-snapshot";
import type { ForkModuleStateArena } from "../src/fork-module-state";

interface TestTableReplicationOwner {
  beginMutation(): bigint;
  commit(
    activationId: number,
    ownerId: number,
    firstIndex: number | bigint,
    length: number | bigint,
  ): void;
  reconcileNow(): number;
}

function archiveFixture() {
  const memory = new WebAssembly.Memory({ initial: 8, maximum: 8 });
  let head = 0;
  let next = 4_096;
  const archive = new DylinkForkArchive(
    memory,
    4,
    () => head,
    (value) => { head = value; },
    (size) => {
      const address = next;
      next += Math.ceil(size / 8) * 8;
      return { address, size };
    },
    () => {},
    "process table test archive",
  );
  archive.sync({ nextHandle: 2, libraries: [] });
  return { archive, memory };
}

function dlopenFixture(archive: DylinkForkArchive): DlopenSupport {
  let writerDepth = 0;
  let readerDepth = 0;
  let writerObserver = () => {};
  return {
    imports: {},
    readForkState: () => archive.read(),
    replayDlopens: () => {},
    resetForkChildLock: () => {},
    archive,
    acquireArchiveWriter: () => {
      if (writerDepth++ === 0) writerObserver();
    },
    releaseArchiveWriter: () => {
      if (writerDepth <= 0) throw new Error("writer underflow");
      writerDepth--;
    },
    acquireArchiveReader: () => { readerDepth++; },
    releaseArchiveReader: () => {
      if (readerDepth <= 0) throw new Error("reader underflow");
      readerDepth--;
    },
    withArchiveWriter: <T>(operation: () => T): T => {
      if (writerDepth++ === 0) writerObserver();
      try {
        return operation();
      } finally {
        writerDepth--;
      }
    },
    withArchiveReader: <T>(operation: () => T): T => {
      readerDepth++;
      try {
        return operation();
      } finally {
        readerDepth--;
      }
    },
    writerOwned: () => writerDepth > 0,
    setWriterAcquireObserver: (observer) => { writerObserver = observer; },
    setOperationAbortObserver: () => {},
    setCommitObserver: () => {},
  };
}

function arenaFixture(root: number): ForkModuleStateArena {
  let active = false;
  return {
    begin: () => {
      active = true;
      return root;
    },
    attach: () => { active = true; },
    release: () => { active = false; },
    hasActiveArena: () => active,
  } as unknown as ForkModuleStateArena;
}

function patch(generation?: number): DylinkForkTablePatch {
  return {
    ...(generation === undefined ? {} : { generation }),
    activationId: 0,
    ownerId: 1,
    start: 0,
    tableLength: 1,
    runs: [{
      length: 1,
      function: { activationId: 0, ordinal: 0 },
    }],
  };
}

describe("process table replication publication", () => {
  it("uses patches normally and transparently compacts at the journal bound", () => {
    const { archive } = archiveFixture();
    const dlopen = dlopenFixture(archive);
    let checkpoints = 0;
    let typedFallback = false;
    const registry = {
      captureFuncrefTablePatch: () => typedFallback ? null : patch(),
      applyFuncrefTablePatch: () => {},
    } as unknown as ForkActivationRegistry;
    // Path-A A3/A4: the full-checkpoint capture/restore moved to the module-backed
    // `ForkTableSnapshot`; this suite mocks it (it proves the patch-journal /
    // compaction orchestration, NOT the reference engine — see the real-engine
    // round-trip test in fork-table-snapshot-roundtrip.test.ts).
    const tableSnapshot = {
      capture: () => {
        checkpoints++;
        return 512;
      },
      restore: () => {},
    } as unknown as ForkTableSnapshot;
    const owner = __testCreateProcessTableReplicationOwner({
      generationAddress: 64,
      registry,
      tableSnapshot,
      dlopen,
      newArena: () => arenaFixture(512),
      materializeModules: () => {},
      restoreSnapshots: true,
      label: "patch writer",
    }) as TestTableReplicationOwner;

    for (let index = 0; index < 256; index++) {
      owner.beginMutation();
      owner.commit(0, 1, 0, 1);
    }
    expect(archive.read().tablePatches).toHaveLength(256);
    expect(checkpoints).toBe(0);

    owner.beginMutation();
    owner.commit(0, 1, 0, 1);
    expect(checkpoints).toBe(1);
    expect(archive.read()).toMatchObject({
      tableStateRoot: 512,
      tablePatches: [],
    });

    typedFallback = true;
    owner.beginMutation();
    owner.commit(0, 1, 0, 1);
    expect(checkpoints).toBe(2);
    expect(archive.read().tablePatches).toEqual([]);
  });

  it("skips only the fork child's copied baseline and applies later patches", () => {
    const { archive } = archiveFixture();
    archive.publishTablePatch(patch());
    const applied: number[] = [];
    const registry = {
      applyFuncrefTablePatch: (value: DylinkForkTablePatch) => {
        applied.push(value.generation!);
      },
    } as unknown as ForkActivationRegistry;
    const tableSnapshot = {
      capture: () => 512,
      restore: () => {
        throw new Error("fork child must use its normal KFMS capture");
      },
    } as unknown as ForkTableSnapshot;
    const child = __testCreateProcessTableReplicationOwner({
      generationAddress: 64,
      registry,
      tableSnapshot,
      dlopen: dlopenFixture(archive),
      newArena: () => arenaFixture(512),
      materializeModules: () => {},
      restoreSnapshots: false,
      label: "fork child patch reader",
    }) as TestTableReplicationOwner;

    child.reconcileNow();
    expect(applied).toEqual([]);
    archive.publishTablePatch(patch());
    child.reconcileNow();
    expect(applied).toEqual([3]);
  });

  it("observes a borrowed immutable generation without acquiring its writer", () => {
    const { archive } = archiveFixture();
    archive.publishTablePatch(patch());
    const dlopen = dlopenFixture(archive);
    let writerAcquisitions = 0;
    dlopen.withArchiveWriter = <T>(_operation: () => T): T => {
      writerAcquisitions++;
      throw new Error("borrowed snapshot attempted archive mutation");
    };
    dlopen.acquireArchiveWriter = () => {
      writerAcquisitions++;
      throw new Error("borrowed snapshot attempted archive mutation");
    };
    const child = __testCreateProcessTableReplicationOwner({
      generationAddress: 64,
      registry: {
        applyFuncrefTablePatch: () => {},
      } as unknown as ForkActivationRegistry,
      tableSnapshot: {
        capture: () => 512,
        restore: () => {},
      } as unknown as ForkTableSnapshot,
      dlopen,
      newArena: () => arenaFixture(512),
      materializeModules: () => {
        throw new Error("borrowed snapshot was already materialized");
      },
      restoreSnapshots: false,
      borrowedImmutableSnapshot: true,
      label: "borrowed vfork child",
    }) as TestTableReplicationOwner;

    expect(child.reconcileNow()).toBe(archive.generation());
    expect(writerAcquisitions).toBe(0);
    expect(() => child.beginMutation()).toThrow(
      "borrowed snapshot attempted archive mutation",
    );
    expect(writerAcquisitions).toBe(1);
  });
});
