const CHECKPOINT_FREEZE_PENDING = 0;
const CHECKPOINT_FREEZE_RESUMED = 1;
const CHECKPOINT_FREEZE_GATE_BYTES = Int32Array.BYTES_PER_ELEMENT;

function gateView(buffer: SharedArrayBuffer): Int32Array {
  if (
    !(buffer instanceof SharedArrayBuffer)
    || buffer.byteLength !== CHECKPOINT_FREEZE_GATE_BYTES
  ) {
    throw new TypeError("checkpoint freeze gate must be one shared i32");
  }
  return new Int32Array(buffer);
}

export function createCheckpointFreezeGate(): SharedArrayBuffer {
  return new SharedArrayBuffer(CHECKPOINT_FREEZE_GATE_BYTES);
}

/**
 * Release an unwound process to rewind back into the syscall it left.
 */
export function resumeCheckpointFreezeGate(buffer: SharedArrayBuffer): void {
  const gate = gateView(buffer);
  if (
    Atomics.compareExchange(
      gate,
      0,
      CHECKPOINT_FREEZE_PENDING,
      CHECKPOINT_FREEZE_RESUMED,
    ) !== CHECKPOINT_FREEZE_PENDING
  ) {
    throw new Error("checkpoint freeze gate is no longer pending");
  }
  Atomics.notify(gate, 0);
}

/**
 * Hold a process with its frames unwound until the keeper has read its memory.
 *
 * WHY this is a blocking shared-memory gate: the captured frames only exist
 * between `sealCapture` and the rewind, so the keeper must read process memory
 * inside that window. A JavaScript promise cannot be awaited there — the window
 * lives in the synchronous entry loop — so the process parks on the same
 * Atomics primitive its syscall channel already uses.
 *
 * WHY the guest restores the pending state: one gate serves every checkpoint
 * this process ever takes, and a machine that survives a failed handover is
 * checkpointed again. If the keeper wrote the pending state back, it could win
 * the race between its own notify and this load, and the process would park on
 * a gate the next freeze has not opened. Only the thread that has already
 * observed the resume can clear it.
 */
export function waitForCheckpointFreezeResume(
  buffer: SharedArrayBuffer,
  context: string,
): void {
  const gate = gateView(buffer);
  for (;;) {
    const state = Atomics.load(gate, 0);
    if (state === CHECKPOINT_FREEZE_RESUMED) {
      Atomics.store(gate, 0, CHECKPOINT_FREEZE_PENDING);
      return;
    }
    if (state !== CHECKPOINT_FREEZE_PENDING) {
      throw new Error(`${context}: invalid checkpoint freeze gate state ${state}`);
    }
    Atomics.wait(gate, 0, CHECKPOINT_FREEZE_PENDING);
  }
}

type CheckpointFreezePhase =
  | "idle"
  | "armed"
  | "unwound"
  | "resumed"
  | "abandoned";

/** Participant key for the process's main thread. */
const MAIN_THREAD = -1;

/**
 * Host-side half of one process's checkpoint freeze, reused for its lifetime.
 *
 * `arm()` opens one freeze attempt. `unwound()` records one worker reporting
 * that its frames are captured and its state global reads UNWINDING; the gates
 * stay closed across those reports so the keeper can read the process memory
 * while the frames are still there. `resume()` reopens them after the read.
 *
 * WHY one gate per worker rather than one per process: a resume is a single
 * compare-and-swap that the woken thread clears again, so two threads parked on
 * one gate would race, and the loser would park on a gate already consumed. A
 * process is only fully unwound once **every** thread has reported, so the
 * freeze must count participants rather than take the first report.
 *
 * `abandon()` is the failure path. A request word is published into the channel
 * and cannot be recalled, so a worker can still unwind after the keeper has
 * given up. An abandoned coordinator resumes such a straggler the moment it
 * reports, which is why the guest is never left parked on a freeze nobody
 * finishes.
 */
export class CheckpointFreezeGateCoordinator {
  readonly gate = createCheckpointFreezeGate();
  private readonly threadGates = new Map<number, SharedArrayBuffer>();
  private phase: CheckpointFreezePhase = "idle";
  private awaited = new Set<number>();
  private parked = new Set<number>();
  private unwoundPromise: Promise<void> | null = null;
  private resolveUnwound: (() => void) | null = null;
  private rejectUnwound: ((reason: Error) => void) | null = null;

  constructor(readonly context: string) {}

  get currentPhase(): CheckpointFreezePhase {
    return this.phase;
  }

  /**
   * Give one pthread of this process its own gate.
   *
   * The gate must exist before any freeze can ask the thread to unwind, so it
   * is created at thread launch and travels in the thread's init message.
   */
  registerThread(tid: number): SharedArrayBuffer {
    if (this.threadGates.has(tid)) {
      throw new Error(`${this.context}: tid=${tid} already has a freeze gate`);
    }
    const gate = createCheckpointFreezeGate();
    this.threadGates.set(tid, gate);
    return gate;
  }

  /**
   * Drop an exited thread, releasing a freeze that is still waiting for it.
   */
  unregisterThread(tid: number): void {
    if (!this.threadGates.delete(tid)) return;
    this.parked.delete(tid);
    if (this.awaited.delete(tid) && this.awaited.size === 0) {
      this.settleUnwound();
    }
  }

  private gateFor(tid: number): SharedArrayBuffer {
    if (tid === MAIN_THREAD) return this.gate;
    const gate = this.threadGates.get(tid);
    if (!gate) {
      throw new Error(`${this.context}: tid=${tid} has no freeze gate`);
    }
    return gate;
  }

  private settleUnwound(): void {
    this.phase = "unwound";
    this.resolveUnwound?.();
  }

  arm(): void {
    if (this.phase === "armed" || this.phase === "unwound") {
      throw new Error(
        `${this.context}: a checkpoint freeze is already ${this.phase}`,
      );
    }
    const participants = [MAIN_THREAD, ...this.threadGates.keys()];
    for (const tid of participants) {
      const state = Atomics.load(gateView(this.gateFor(tid)), 0);
      if (state !== CHECKPOINT_FREEZE_PENDING) {
        throw new Error(
          `${this.context}: checkpoint freeze gate was left at state ${state}`,
        );
      }
    }
    this.phase = "armed";
    this.awaited = new Set(participants);
    this.parked = new Set();
    this.unwoundPromise = new Promise<void>((resolve, reject) => {
      this.resolveUnwound = resolve;
      this.rejectUnwound = reject;
    });
    // An abandon can settle this attempt before the freeze reaches its await,
    // and a rejection nobody has subscribed to yet is still a rejection this
    // realm reports.
    void this.unwoundPromise.catch(() => {});
  }

  unwound(tid: number = MAIN_THREAD): void {
    if (this.phase === "armed") {
      if (!this.awaited.delete(tid)) return;
      this.parked.add(tid);
      if (this.awaited.size === 0) this.settleUnwound();
      return;
    }
    if (this.phase === "idle" || this.phase === "abandoned") {
      // The keeper gave up after publishing the request word. Rewind the
      // worker immediately rather than hold frames no one will read.
      resumeCheckpointFreezeGate(this.gateFor(tid));
    }
  }

  waitUntilUnwound(): Promise<void> {
    if (!this.unwoundPromise) {
      throw new Error(`${this.context}: no checkpoint freeze is armed`);
    }
    return this.unwoundPromise;
  }

  resume(): void {
    if (this.phase !== "unwound") {
      throw new Error(
        `${this.context}: cannot resume a checkpoint freeze while ${this.phase}`,
      );
    }
    for (const tid of this.parked) {
      resumeCheckpointFreezeGate(this.gateFor(tid));
    }
    this.parked.clear();
    this.phase = "resumed";
  }

  abandon(reason?: unknown): void {
    if (this.phase === "abandoned") return;
    const settled = this.phase === "armed" ? this.rejectUnwound : null;
    this.phase = "abandoned";
    for (const tid of this.parked) {
      resumeCheckpointFreezeGate(this.gateFor(tid));
    }
    this.parked.clear();
    this.awaited.clear();
    settled?.(abandonedError(this.context, reason));
    this.resolveUnwound = null;
    this.rejectUnwound = null;
    this.unwoundPromise = null;
  }
}

function abandonedError(context: string, reason: unknown): Error {
  if (reason instanceof Error) return reason;
  return new Error(
    `${context}: ${reason === undefined ? "checkpoint freeze was abandoned" : String(reason)}`,
  );
}
