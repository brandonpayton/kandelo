import { describe, expect, it, vi } from "vitest";
import { CheckpointFreezeGateCoordinator } from "../../src/checkpoint-freeze-gate";
import { ProcessMemoryCreatorGate } from "../../src/process-memory-creator-gate";
import { RootfsSnapshotGate } from "../../src/rootfs-snapshot-gate";
import { ThreadPageAllocator } from "../../src/thread-allocator";
import {
  captureMachineCheckpoint,
  type CheckpointMachine,
  type CheckpointProcessSource,
} from "../../src/migration/checkpoint";
import type { ProcessMemoryLayout } from "../../src/process-memory";

const KERNEL_MEMORY_BYTES = 64;
const FILESYSTEM_BYTES = 128;
const PROCESS_MEMORY_BYTES = 256;
const PROGRAM_BYTES = 32;
const KERNEL_ABI = 977;

const layout = (channelOffset: number): ProcessMemoryLayout => ({
  initialPages: 1,
  maximumPages: 2,
  controlBase: 0,
  controlEnd: 0,
  channelOffset,
  channelPage: 0,
  brkBase: 0,
  mmapBase: 0,
  brkLimit: 0,
  maxAddr: 0,
  firstThreadSlotPage: 1,
  firstThreadBasePage: 1,
  threadArenaEndPage: 2,
  threadSlotCount: 1,
});

function processSource(pid: number, generation: number): CheckpointProcessSource {
  const memory = { buffer: new ArrayBuffer(PROCESS_MEMORY_BYTES) } as
    unknown as WebAssembly.Memory;
  return {
    pid,
    executionGeneration: generation,
    ptrWidth: 4,
    channelOffset: pid * 1024,
    layout: layout(pid * 1024),
    argv: [`/bin/program-${pid}`],
    memory,
    programBytes: () => new Uint8Array(PROGRAM_BYTES).fill(pid).buffer,
    threadAllocatorState: () =>
      new ThreadPageAllocator({
        firstSlotStartPage: 4,
        maxPageExclusive: 64,
      }).snapshotState(),
    checkpointFreeze: new CheckpointFreezeGateCoordinator(`pid=${pid}`),
  };
}

interface TestMachine {
  readonly machine: CheckpointMachine;
  readonly creators: ProcessMemoryCreatorGate;
  readonly rootfs: RootfsSnapshotGate;
  readonly sources: CheckpointProcessSource[];
  readonly held: number[][];
  readonly released: number[][];
  readonly armed: number[][];
  readonly disarmed: { count: number };
  settleVforks: () => Promise<void>;
  unreleasable: number[];
}

function testMachine(sources: CheckpointProcessSource[]): TestMachine {
  const creators = new ProcessMemoryCreatorGate();
  const rootfs = new RootfsSnapshotGate();
  const held: number[][] = [];
  const released: number[][] = [];
  const armed: number[][] = [];
  const disarmed = { count: 0 };
  const state: TestMachine = {
    creators,
    rootfs,
    sources,
    held,
    released,
    armed,
    disarmed,
    settleVforks: () => Promise.resolve(),
    unreleasable: [],
    machine: {
      runWithoutWorkerCreation: (operation, exclusive) =>
        creators.runExclusive(operation, exclusive),
      runWithoutRootfsMutation: (operation) => rootfs.runSnapshot(operation),
      settleActiveVforkBorrows: () => state.settleVforks(),
      holdProcessDispatch: () => {
        const pids = sources.map((source) => source.pid);
        held.push(pids);
        return pids;
      },
      releaseProcessDispatch: () => {
        released.push(sources.map((source) => source.pid));
        return state.unreleasable;
      },
      armUnwindRequests: () => {
        const pids = sources.map((source) => source.pid);
        armed.push(pids);
        return pids;
      },
      disarmUnwindRequests: () => {
        disarmed.count += 1;
      },
      copyKernelMemory: () => new Uint8Array(KERNEL_MEMORY_BYTES).fill(7),
      filesystemBuffer: () => new SharedArrayBuffer(FILESYSTEM_BYTES),
      kernelAbiVersion: () => KERNEL_ABI,
      liveProcesses: () => sources,
    },
  };
  return state;
}

/** Let every already-resolved promise settle without advancing fake time. */
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

const options = { unwindTimeoutMs: 50, vforkTimeoutMs: 50 };

describe("machine checkpoint freeze", () => {
  it("reads every bucket once each process has unwound", async () => {
    const state = testMachine([processSource(4, 1), processSource(9, 2)]);
    const capture = captureMachineCheckpoint(state.machine, options);
    await flush();
    for (const source of state.sources) source.checkpointFreeze.unwound();

    const result = await capture;
    expect(result.status).toBe("captured");
    if (result.status !== "captured") return;
    expect(result.checkpoint.kernelMemory.byteLength).toBe(KERNEL_MEMORY_BYTES);
    expect(result.checkpoint.filesystem.byteLength).toBe(FILESYSTEM_BYTES);
    expect(result.checkpoint.processes.map((bucket) => bucket.pid)).toEqual([4, 9]);
    expect(
      result.checkpoint.processes.map((bucket) => bucket.executionGeneration),
    ).toEqual([1, 2]);
    expect(result.checkpoint.processes[0]!.memory.byteLength)
      .toBe(PROCESS_MEMORY_BYTES);
    expect(result.checkpoint.processes[0]!.argv).toEqual(["/bin/program-4"]);
    expect(result.checkpoint.format).toBe(1);
    expect(result.checkpoint.kernelAbiVersion).toBe(KERNEL_ABI);
    expect(
      new Uint8Array(result.checkpoint.processes[0]!.programBytes),
    ).toEqual(new Uint8Array(PROGRAM_BYTES).fill(4));
    expect(result.checkpoint.processes[0]!.threadAllocator).toEqual({
      nextPage: 4,
      freePages: [],
      activeCount: 0,
      hostControlPages: [],
    });
  });

  it("holds dispatch only while it reads, and gives it back", async () => {
    const state = testMachine([processSource(4, 1)]);
    const capture = captureMachineCheckpoint(state.machine, options);
    await flush();
    expect(state.held).toEqual([]);

    state.sources[0]!.checkpointFreeze.unwound();
    await capture;
    expect(state.held).toEqual([[4]]);
    expect(state.released).toEqual([[4]]);
    expect(state.disarmed.count).toBe(1);
  });

  it("keeps every process parked until the read finishes", async () => {
    const state = testMachine([processSource(4, 1)]);
    const freeze = state.sources[0]!.checkpointFreeze;
    const gateDuringRead: number[] = [];
    const machine: CheckpointMachine = {
      ...state.machine,
      copyKernelMemory: () => {
        gateDuringRead.push(Atomics.load(new Int32Array(freeze.gate), 0));
        return new Uint8Array(KERNEL_MEMORY_BYTES);
      },
    };
    const capture = captureMachineCheckpoint(machine, options);
    await flush();
    freeze.unwound();
    await capture;

    // Zero is the pending state: the frames were still in linear memory.
    expect(gateDuringRead).toEqual([0]);
    expect(Atomics.load(new Int32Array(freeze.gate), 0)).toBe(1);
  });

  it("admits no worker creation and no rootfs mutation while it runs", async () => {
    const state = testMachine([processSource(4, 1)]);
    const capture = captureMachineCheckpoint(state.machine, options);
    await flush();

    const spawn = vi.fn();
    await expect(state.creators.run("spawn", spawn)).rejects.toThrow(
      "checkpoint freeze is in progress; cannot start spawn",
    );
    expect(spawn).not.toHaveBeenCalled();
    expect(() => state.rootfs.beginMutation("write /etc/passwd")).toThrow(
      "rootfs export is in progress",
    );

    state.sources[0]!.checkpointFreeze.unwound();
    await capture;
  });

  it("resumes the machine when a process never reaches UNWINDING", async () => {
    const state = testMachine([processSource(4, 1), processSource(9, 2)]);
    const capture = captureMachineCheckpoint(state.machine, {
      unwindTimeoutMs: 5,
      vforkTimeoutMs: 50,
    });
    await flush();
    state.sources[0]!.checkpointFreeze.unwound();

    const result = await capture;
    expect(result).toEqual({
      status: "timed-out",
      reason:
        "a process did not reach UNWINDING before the checkpoint freeze timed out",
    });
    // Nothing was read, so dispatch was never held, and the process that did
    // unwind is rewound rather than left parked.
    expect(state.held).toEqual([]);
    expect(state.disarmed.count).toBe(1);
    expect(Atomics.load(new Int32Array(state.sources[0]!.checkpointFreeze.gate), 0))
      .toBe(1);
  });

  it("rewinds a process that unwinds after the freeze gave up", async () => {
    const state = testMachine([processSource(4, 1)]);
    const result = await captureMachineCheckpoint(state.machine, {
      unwindTimeoutMs: 5,
      vforkTimeoutMs: 50,
    });
    expect(result.status).toBe("timed-out");

    // The request word was published and cannot be recalled.
    state.sources[0]!.checkpointFreeze.unwound();
    expect(Atomics.load(new Int32Array(state.sources[0]!.checkpointFreeze.gate), 0))
      .toBe(1);
  });

  it("fails before arming when a vfork borrow does not resolve", async () => {
    const state = testMachine([processSource(4, 1)]);
    state.settleVforks = () => new Promise<void>(() => {});
    const result = await captureMachineCheckpoint(state.machine, {
      unwindTimeoutMs: 50,
      vforkTimeoutMs: 5,
    });

    expect(result).toEqual({
      status: "timed-out",
      reason:
        "a vfork borrow did not resolve before the checkpoint freeze timed out",
    });
    expect(state.armed).toEqual([]);
    expect(state.sources[0]!.checkpointFreeze.currentPhase).toBe("idle");
  });

  it("reports a dispatch release that did not complete", async () => {
    const state = testMachine([processSource(4, 1)]);
    state.unreleasable = [4];
    const capture = captureMachineCheckpoint(state.machine, options);
    await flush();
    state.sources[0]!.checkpointFreeze.unwound();

    await expect(capture).resolves.toEqual({
      status: "failed",
      reason: "checkpoint freeze could not release dispatch for pids 4",
    });
  });

  it("fails without freezing when a process ends mid-capture", async () => {
    const state = testMachine([processSource(4, 1)]);
    const capture = captureMachineCheckpoint(state.machine, options);
    await flush();
    state.sources[0]!.checkpointFreeze.abandon(
      "the process ended during the checkpoint freeze",
    );

    await expect(capture).resolves.toEqual({
      status: "failed",
      reason: "pid=4: the process ended during the checkpoint freeze",
    });
    expect(state.held).toEqual([]);
  });

  it("fails without freezing when a thread dies before the read", async () => {
    const state = testMachine([processSource(4, 1)]);
    const freeze = state.sources[0]!.checkpointFreeze;
    freeze.registerThread(7);
    const capture = captureMachineCheckpoint(state.machine, options);
    await flush();
    freeze.unwound();
    freeze.unregisterThread(7);

    await expect(capture).resolves.toEqual({
      status: "failed",
      reason: "pid=4: tid=7 ended during the checkpoint freeze",
    });
    expect(state.held).toEqual([]);
  });

  it("fails after reading when a thread dies during the read", async () => {
    const state = testMachine([processSource(4, 1)]);
    const freeze = state.sources[0]!.checkpointFreeze;
    freeze.registerThread(7);
    const machine: CheckpointMachine = {
      ...state.machine,
      copyKernelMemory: () => {
        freeze.unregisterThread(7);
        return new Uint8Array(KERNEL_MEMORY_BYTES);
      },
    };
    const capture = captureMachineCheckpoint(machine, options);
    await flush();
    freeze.unwound();
    freeze.unwound(7);

    // Nothing rejects in this window, so the bytes were read. They describe a
    // machine that lost a thread while they were being copied.
    await expect(capture).resolves.toEqual({
      status: "failed",
      reason:
        "checkpoint freeze read a machine that stopped being whole: "
        + "pid=4: tid=7 ended during the checkpoint freeze",
    });
    expect(state.held).toEqual([[4]]);
  });

  it("checkpoints again after a failed attempt", async () => {
    const state = testMachine([processSource(4, 1)]);
    const freeze = state.sources[0]!.checkpointFreeze;
    const timedOut = await captureMachineCheckpoint(state.machine, {
      unwindTimeoutMs: 5,
      vforkTimeoutMs: 50,
    });
    expect(timedOut.status).toBe("timed-out");

    // The machine still forks, execs, spawns, and writes its rootfs.
    await expect(state.creators.run("spawn", () => 11)).resolves.toBe(11);
    state.rootfs.beginMutation("write /etc/passwd")();

    const capture = captureMachineCheckpoint(state.machine, options);
    await flush();
    freeze.unwound();
    await expect(capture).resolves.toMatchObject({ status: "captured" });
  });
});
