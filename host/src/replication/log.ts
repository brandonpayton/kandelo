/**
 * The ordered record of what a Kandelo machine could not decide from its own
 * memory.
 *
 * A machine's guest code is a function of its state and of the values the host
 * handed it. State already travels, as `MachineCheckpoint`. This module owns
 * the other half: the values. Two computers that start from the same
 * checkpoint and consume the same decisions in the same order run the same
 * machine, and each one renders its own screen instead of being sent pixels.
 *
 * One replica is the primary and records. Every other replica replays and
 * originates nothing. A replay that is asked for a decision the primary never
 * made has diverged, and says so rather than inventing a value — a wrong value
 * accepted here becomes a machine that is silently no longer the same machine.
 *
 * The design is `docs/plans/2026-08-23-state-machine-replication-design.md`
 * § "Core model: replicate the kernel's decision log".
 */

/** One `clock_gettime` result the host produced for a guest. */
export interface ReplicationClockReading {
  readonly kind: "clock";
  readonly clockId: number;
  readonly sec: number;
  readonly nsec: number;
}

/**
 * Bytes the host delivered to a device, at the position it delivered them.
 *
 * `device` is the path the bytes were appended to, so the log stays
 * surface-agnostic: a keystroke on a terminal and a byte on any other
 * character device are the same decision at different devices. What travels
 * is what the guest reads, not the browser event behind it.
 */
export interface ReplicationInputEvent {
  readonly kind: "input";
  readonly device: string;
  readonly bytes: Uint8Array;
}

/**
 * One pointer movement the host delivered, as the host delivered it.
 *
 * The host hands the kernel a delta and a button mask; the kernel builds the
 * PS/2 frame the guest reads. Recording the delta rather than a frame keeps
 * the log honest — a byte array here would claim to be the device's bytes
 * while being this module's guess at them — and keeps it exact, because no
 * encoding sits between what was recorded and what is replayed.
 *
 * The delta is deliberately not a cursor position. A browser event carries
 * the window's size and pixel ratio, and replaying that on a differently
 * sized window would put the guest's cursor somewhere else.
 */
export interface ReplicationPointerEvent {
  readonly kind: "pointer";
  readonly dx: number;
  readonly dy: number;
  readonly buttons: number;
}

/**
 * A decision the host delivered without the guest asking for it.
 *
 * Nothing consumes one on its own, so a reader applies them as it passes
 * over them rather than waiting for a caller to take them.
 */
export type ReplicationPushedDecision =
  | ReplicationInputEvent
  | ReplicationPointerEvent;

/**
 * A value the host produced that the guest could not have derived itself.
 *
 * Two shapes travel together here. A clock reading is *pulled*: the guest
 * asks and the log answers. A pushed decision arrives between two guest
 * requests, and the log records where.
 */
export type ReplicationDecision =
  | ReplicationClockReading
  | ReplicationPushedDecision;

/** Whether `decision` is one the host delivered rather than the guest asked for. */
function isPushedDecision(
  decision: ReplicationDecision,
): decision is ReplicationPushedDecision {
  return decision.kind === "input" || decision.kind === "pointer";
}

/** One decision at its position in the machine's log. */
export interface ReplicationLogEntry {
  readonly seq: number;
  readonly decision: ReplicationDecision;
}

/**
 * The replay asked for something the recording does not hold.
 *
 * This is a platform defect every time. It names the log position so the
 * divergence can be located rather than merely reported.
 */
export class ReplicationDivergence extends Error {
  readonly seq: number;

  constructor(seq: number, reason: string) {
    super(`replication log diverged at ${seq}: ${reason}`);
    this.name = "ReplicationDivergence";
    this.seq = seq;
  }
}

/**
 * Append every decision the primary makes, in the order it makes them.
 *
 * A recorder starts at the sequence number its checkpoint was taken at, so a
 * replica that joins from that checkpoint reads on from the same position.
 */
export class ReplicationLogRecorder {
  readonly #entries: ReplicationLogEntry[] = [];
  readonly #listeners = new Set<(entry: ReplicationLogEntry) => void>();
  #nextSeq: number;

  constructor(firstSeq = 0) {
    if (!Number.isSafeInteger(firstSeq) || firstSeq < 0) {
      throw new Error("a replication log starts at a non-negative sequence");
    }
    this.#nextSeq = firstSeq;
  }

  record(decision: ReplicationDecision): ReplicationLogEntry {
    const entry: ReplicationLogEntry = { seq: this.#nextSeq, decision };
    this.#nextSeq += 1;
    this.#entries.push(entry);
    for (const listener of [...this.#listeners]) listener(entry);
    return entry;
  }

  /**
   * Watch decisions as they are recorded, in order.
   *
   * A replica reads the log as the primary makes it, so something has to
   * observe a recording that is still running. Returns an unsubscribe.
   */
  onRecord(listener: (entry: ReplicationLogEntry) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** The sequence number the next recorded decision will carry. */
  get nextSeq(): number {
    return this.#nextSeq;
  }

  get entries(): readonly ReplicationLogEntry[] {
    return this.#entries;
  }
}

/**
 * Serve recorded decisions back, in order, and refuse anything else.
 *
 * Every `take` names the decision the caller expects. A mismatch means the
 * replica reached a different point in its execution than the primary did, so
 * the reader reports the position rather than handing back the next value and
 * letting the two machines drift apart unnoticed.
 */
export class ReplicationLogReader {
  readonly #entries: readonly ReplicationLogEntry[];
  readonly #applyPushed?: (decision: ReplicationPushedDecision) => void;
  #index = 0;

  constructor(
    entries: readonly ReplicationLogEntry[],
    applyPushed?: (decision: ReplicationPushedDecision) => void,
  ) {
    this.#entries = entries;
    this.#applyPushed = applyPushed;
  }

  /**
   * How many entries this reader has taken, of the log it was given.
   *
   * Two replicas given one log and left at different counts ran different
   * machines. The count is what makes that visible before their state hashes
   * are compared, and it is visible even when a replay ends early.
   */
  get consumed(): number {
    return this.#index;
  }

  /** The sequence number this reader will consume next. */
  get nextSeq(): number {
    return this.#entries[this.#index]?.seq
      ?? (this.#entries[this.#entries.length - 1]?.seq ?? -1) + 1;
  }

  /**
   * Deliver every pushed decision the log holds at the current position.
   *
   * A pushed decision has no guest request to answer, so nothing would
   * consume it on its own. A driver that has just received new entries calls
   * this so input the primary delivered after its last clock read still
   * reaches the replica.
   */
  drainPushed(): void {
    this.#drainPushed();
  }

  takeClock(clockId: number): ReplicationClockReading {
    // What the primary delivered before this reading must reach the guest
    // before the reading does, or the replica applies it against a later
    // state than the primary did.
    this.#drainPushed();
    const entry = this.#entries[this.#index];
    if (entry === undefined) {
      throw new ReplicationDivergence(
        this.nextSeq,
        `the replica read clock ${clockId} past the end of the log`,
      );
    }
    if (entry.decision.kind !== "clock") {
      throw new ReplicationDivergence(
        entry.seq,
        `the replica read a clock where the primary recorded `
          + `${entry.decision.kind}`,
      );
    }
    if (entry.decision.clockId !== clockId) {
      throw new ReplicationDivergence(
        entry.seq,
        `the replica read clock ${clockId} where the primary read clock `
          + `${entry.decision.clockId}`,
      );
    }
    this.#index += 1;
    return entry.decision;
  }

  /**
   * Hand every leading pushed decision to the sink, in order.
   *
   * A reader with no sink refuses rather than passing the entry over: a
   * dropped input is a replica that silently stopped being the same machine,
   * which is the failure this module exists to prevent.
   */
  #drainPushed(): void {
    for (;;) {
      const entry = this.#entries[this.#index];
      if (entry === undefined || !isPushedDecision(entry.decision)) return;
      if (!this.#applyPushed) {
        throw new ReplicationDivergence(
          entry.seq,
          `the log carries ${describePushed(entry.decision)} and the replica `
            + `installed no input sink`,
        );
      }
      this.#index += 1;
      this.#applyPushed(entry.decision);
    }
  }
}

function describePushed(decision: ReplicationPushedDecision): string {
  return decision.kind === "input"
    ? `input for ${decision.device}`
    : "a pointer movement";
}
