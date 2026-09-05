import type { CheckpointFreezeGateCoordinator } from "../checkpoint-freeze-gate";
import type { ProcessMemoryLayout } from "../process-memory";
import type { ThreadPageAllocatorState } from "../thread-allocator";

/**
 * Freeze a running machine and read it, on either host.
 *
 * The three legs of the freeze, the vfork precondition, and the process bucket
 * all already exist in the two kernel-worker entries as module-level
 * singletons. This module owns the ordering between them and nothing else, so
 * Node and browser run the same protocol rather than two copies of it.
 *
 * The protocol is `DESIGN.md` § "The handover protocol" steps 2 to 7.
 */

/** Continuation root a byte copy of process memory does not carry. */
export interface CheckpointForkReplayContext {
  readonly fnPtr: number;
  readonly argPtr: number;
  readonly forkBufAddr: number;
}

/** One live execution image the freeze can read. */
export interface CheckpointProcessSource {
  readonly pid: number;
  /** Serialisable execution identity; a PID survives exec, this does not. */
  readonly executionGeneration: number;
  readonly ptrWidth: 4 | 8;
  readonly channelOffset: number;
  readonly layout: ProcessMemoryLayout;
  readonly argv: readonly string[];
  readonly memory: WebAssembly.Memory;
  readonly threadAllocatorState: () => ThreadPageAllocatorState;
  readonly forkReplayContext?: CheckpointForkReplayContext;
  readonly checkpointFreeze: CheckpointFreezeGateCoordinator;
}

/** Everything the freeze drives, supplied by the host entry that owns it. */
export interface CheckpointMachine {
  /** Leg 3: `ProcessMemoryCreatorGate.runExclusive`. */
  readonly runWithoutWorkerCreation: <T>(
    operation: string,
    exclusive: () => Promise<T>,
  ) => Promise<T>;
  /** Leg 2: `RootfsSnapshotGate.runSnapshot`. */
  readonly runWithoutRootfsMutation: <T>(operation: () => Promise<T>) => Promise<T>;
  /** Step 2's precondition: `VforkLifetimeCoordinator.settleActiveBorrows`. */
  readonly settleActiveVforkBorrows: () => Promise<void>;
  /** Leg 1: the stopped-process dispatch gate. */
  readonly holdProcessDispatch: () => number[];
  readonly releaseProcessDispatch: () => number[];
  readonly armUnwindRequests: () => number[];
  readonly disarmUnwindRequests: () => void;
  readonly copyKernelMemory: () => Uint8Array;
  readonly filesystemBuffer: () => SharedArrayBuffer;
  readonly liveProcesses: () => readonly CheckpointProcessSource[];
}

export interface CheckpointProcessBucket {
  readonly pid: number;
  readonly executionGeneration: number;
  readonly ptrWidth: 4 | 8;
  readonly channelOffset: number;
  readonly layout: ProcessMemoryLayout;
  readonly argv: readonly string[];
  readonly memory: Uint8Array;
  readonly threadAllocator: ThreadPageAllocatorState;
  readonly forkReplayContext?: CheckpointForkReplayContext;
}

export interface MachineCheckpoint {
  readonly kernelMemory: Uint8Array;
  readonly filesystem: Uint8Array;
  readonly processes: readonly CheckpointProcessBucket[];
}

/**
 * What a checkpoint holds, without the bytes.
 *
 * Nothing sends a checkpoint yet, so nothing needs the buckets outside the
 * kernel worker that read them. This is what crosses the worker port: enough
 * to prove the freeze read a whole machine, and cheap enough to be worth
 * sending. `PLAN.md` § T1.5 is where the bytes acquire a consumer.
 */
export interface MachineCheckpointSummary {
  readonly kernelMemoryBytes: number;
  readonly filesystemBytes: number;
  readonly processes: readonly {
    readonly pid: number;
    readonly executionGeneration: number;
    readonly ptrWidth: 4 | 8;
    readonly channelOffset: number;
    readonly argv: readonly string[];
    readonly memoryBytes: number;
    readonly threadAllocator: ThreadPageAllocatorState;
    readonly forkReplayContext?: CheckpointForkReplayContext;
  }[];
}

export type CheckpointCaptureResponse =
  | { readonly status: "captured"; readonly summary: MachineCheckpointSummary }
  | { readonly status: "timed-out"; readonly reason: string }
  | { readonly status: "failed"; readonly reason: string };

function summarizeMachineCheckpoint(
  checkpoint: MachineCheckpoint,
): MachineCheckpointSummary {
  return {
    kernelMemoryBytes: checkpoint.kernelMemory.byteLength,
    filesystemBytes: checkpoint.filesystem.byteLength,
    processes: checkpoint.processes.map((bucket) => ({
      pid: bucket.pid,
      executionGeneration: bucket.executionGeneration,
      ptrWidth: bucket.ptrWidth,
      channelOffset: bucket.channelOffset,
      argv: bucket.argv,
      memoryBytes: bucket.memory.byteLength,
      threadAllocator: bucket.threadAllocator,
      ...(bucket.forkReplayContext
        ? { forkReplayContext: bucket.forkReplayContext }
        : {}),
    })),
  };
}

export type CheckpointFreezeResult =
  | { readonly status: "captured"; readonly checkpoint: MachineCheckpoint }
  | { readonly status: "timed-out"; readonly reason: string }
  | { readonly status: "failed"; readonly reason: string };

export interface CheckpointFreezeOptions {
  /**
   * Cap on the wait for every process to reach UNWINDING.
   *
   * A process that makes no syscall never reaches the hook, and a process
   * blocked in a syscall the kernel has not completed does not either. Both
   * end here, and the machine resumes.
   */
  readonly unwindTimeoutMs: number;
  /**
   * Cap on the wait for in-flight vforks to resolve.
   *
   * `noteFailedExec` caps nothing, so a child looping on a failing `execve`
   * holds its parent for as long as it likes. T0.6 question 3.
   */
  readonly vforkTimeoutMs: number;
}

class CheckpointTimeout extends Error {}

function withTimeout(
  operation: Promise<unknown>,
  ms: number,
  message: string,
): Promise<void> {
  let handle: ReturnType<typeof setTimeout>;
  const expiry = new Promise<never>((_resolve, reject) => {
    handle = setTimeout(() => reject(new CheckpointTimeout(message)), ms);
  });
  return Promise.race([operation, expiry])
    .then(() => undefined)
    .finally(() => clearTimeout(handle));
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Run the freeze, read the machine, and give the machine back.
 *
 * Every leg is reversible, so a timeout or a failure resumes rather than
 * poisons. The caller is told which happened; nothing here reports a capture
 * it did not take.
 */
export async function captureMachineCheckpoint(
  machine: CheckpointMachine,
  options: CheckpointFreezeOptions,
): Promise<CheckpointFreezeResult> {
  try {
    return await machine.runWithoutWorkerCreation(
      "checkpoint freeze",
      () => machine.runWithoutRootfsMutation(
        () => freezeAndRead(machine, options),
      ),
    );
  } catch (error) {
    if (error instanceof CheckpointTimeout) {
      return { status: "timed-out", reason: error.message };
    }
    return { status: "failed", reason: describe(error) };
  }
}

/**
 * Take a checkpoint and describe it, which is what a host port can carry.
 *
 * Both kernel-worker entries call exactly this, so a checkpoint request means
 * the same thing on Node and in a browser.
 */
export async function captureMachineCheckpointSummary(
  machine: CheckpointMachine,
  options: CheckpointFreezeOptions,
): Promise<CheckpointCaptureResponse> {
  const result = await captureMachineCheckpoint(machine, options);
  if (result.status !== "captured") return result;
  return {
    status: "captured",
    summary: summarizeMachineCheckpoint(result.checkpoint),
  };
}

async function freezeAndRead(
  machine: CheckpointMachine,
  options: CheckpointFreezeOptions,
): Promise<CheckpointFreezeResult> {
  await withTimeout(
    machine.settleActiveVforkBorrows(),
    options.vforkTimeoutMs,
    "a vfork borrow did not resolve before the checkpoint freeze timed out",
  );

  // The borrow set is read after it settles: a vfork child shares its parent's
  // address space, so "one memory per execution generation" only holds here.
  const sources = machine.liveProcesses();
  const armed: CheckpointProcessSource[] = [];
  let unwound = false;
  let held = false;
  let unreleased: number[] = [];
  let checkpoint: MachineCheckpoint | undefined;
  try {
    for (const source of sources) {
      source.checkpointFreeze.arm();
      armed.push(source);
    }
    machine.armUnwindRequests();
    await withTimeout(
      Promise.all(armed.map((source) => source.checkpointFreeze.waitUntilUnwound())),
      options.unwindTimeoutMs,
      "a process did not reach UNWINDING before the checkpoint freeze timed out",
    );
    unwound = true;

    // Every process is parked with its frames in its own linear memory. Leg 1
    // closes the last of the dispatch surface — a straggler mailbox, a
    // completion the kernel prepared meanwhile — before any byte is read.
    machine.holdProcessDispatch();
    held = true;
    checkpoint = readMachine(machine, armed);
  } finally {
    machine.disarmUnwindRequests();
    if (held) unreleased = machine.releaseProcessDispatch();
    for (const source of armed) {
      const freeze = source.checkpointFreeze;
      // A process can die between its unwind report and this line, which
      // abandons its coordinator from the teardown path. Resume only what is
      // still parked; abandoning anything else is idempotent.
      if (unwound && freeze.currentPhase === "unwound") freeze.resume();
      else freeze.abandon();
    }
  }

  if (unreleased.length > 0) {
    // The bytes are real, but the machine they came from is not whole. Report
    // the boundary rather than hand back a checkpoint and a stuck keeper.
    return {
      status: "failed",
      reason:
        "checkpoint freeze could not release dispatch for pids "
        + unreleased.join(", "),
    };
  }
  return { status: "captured", checkpoint: checkpoint! };
}

function readMachine(
  machine: CheckpointMachine,
  sources: readonly CheckpointProcessSource[],
): MachineCheckpoint {
  return {
    kernelMemory: machine.copyKernelMemory(),
    filesystem: new Uint8Array(machine.filesystemBuffer()).slice(),
    processes: sources.map((source) => ({
      pid: source.pid,
      executionGeneration: source.executionGeneration,
      ptrWidth: source.ptrWidth,
      channelOffset: source.channelOffset,
      layout: source.layout,
      argv: [...source.argv],
      memory: new Uint8Array(source.memory.buffer).slice(),
      threadAllocator: source.threadAllocatorState(),
      ...(source.forkReplayContext
        ? { forkReplayContext: source.forkReplayContext }
        : {}),
    })),
  };
}
