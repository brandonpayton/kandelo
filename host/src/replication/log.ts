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
 * One GL query result the host produced for a guest.
 *
 * A GL guest asks its GPU questions — `glGetError`, a uniform location, a
 * driver limit, pixels read back — and the answers are host-produced values
 * exactly like a clock reading: two GPUs answer differently, and a guest
 * that branches on its own GPU's answer stops being the same machine. The
 * primary records the bytes its guest was handed; a replica hands its guest
 * those bytes and runs its own query only for the side effects that keep
 * its context following along.
 *
 * `rc` is the raw `host_gl_query` return: bytes written when non-negative,
 * a negative errno otherwise. `bytes` carries exactly the written bytes.
 */
export interface ReplicationGlQueryAnswer {
  readonly kind: "gl";
  readonly op: number;
  readonly rc: number;
  readonly bytes: Uint8Array;
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
 * The device path a PTY's index answers to, which is the name the guest sees.
 *
 * A host writes a keystroke by index because that is what its own tables hold,
 * and the index is kernel state, so a restored machine's is the primary's.
 * Recording the path rather than the index is what keeps the log readable and
 * keeps this module free of any one host's tables — `syscalls.rs` builds the
 * same name for `/proc` and for the slave a `ptsname` returns.
 */
export function ptsDevicePath(ptyIndex: number): string {
  return `/dev/pts/${ptyIndex}`;
}

/** The PTY index `device` names, or undefined when it names something else. */
export function ptsDeviceIndex(device: string): number | undefined {
  const suffix = device.startsWith("/dev/pts/")
    ? device.slice("/dev/pts/".length)
    : "";
  if (!/^\d+$/.test(suffix)) return undefined;
  return Number(suffix);
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
 * One terminal size the host set, at the position it set it.
 *
 * A window change is a decision like a keystroke: it delivers `SIGWINCH` and
 * a new `TIOCGWINSZ`, so a program that redraws on it takes a turn a machine
 * that never heard of it does not take. Left out of the log, the primary's
 * person resizing their window is enough to make every replica a different
 * machine.
 */
export interface ReplicationResizeEvent {
  readonly kind: "resize";
  readonly device: string;
  readonly rows: number;
  readonly cols: number;
}

/**
 * A decision the host delivered without the guest asking for it.
 *
 * Nothing consumes one on its own, so a reader applies them as it passes
 * over them rather than waiting for a caller to take them.
 */
export type ReplicationPushedDecision =
  | ReplicationInputEvent
  | ReplicationPointerEvent
  | ReplicationResizeEvent;

/**
 * A value the host produced that the guest could not have derived itself.
 *
 * Two shapes travel together here. A clock reading is *pulled*: the guest
 * asks and the log answers. A pushed decision arrives between two guest
 * requests, and the log records where.
 */
export type ReplicationDecision =
  | ReplicationClockReading
  | ReplicationGlQueryAnswer
  | ReplicationPushedDecision;

/** Whether `decision` is one the host delivered rather than the guest asked for. */
function isPushedDecision(
  decision: ReplicationDecision,
): decision is ReplicationPushedDecision {
  return (
    decision.kind === "input"
    || decision.kind === "pointer"
    || decision.kind === "resize"
  );
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
 *
 * A recorder retains what it records, because a replica joins at boot and
 * needs the log from sequence 0. That makes the log grow for as long as the
 * machine runs, so exactly one holder should keep it: a recorder whose entries
 * are being published as they are made is built with `retain: false`, and the
 * publisher is then the only copy.
 */
export class ReplicationLogRecorder {
  readonly #entries: ReplicationLogEntry[] = [];
  readonly #listeners = new Set<(entry: ReplicationLogEntry) => void>();
  readonly #retain: boolean;
  #nextSeq: number;

  constructor(firstSeq = 0, options: { retain?: boolean } = {}) {
    if (!Number.isSafeInteger(firstSeq) || firstSeq < 0) {
      throw new Error("a replication log starts at a non-negative sequence");
    }
    this.#nextSeq = firstSeq;
    this.#retain = options.retain ?? true;
  }

  record(decision: ReplicationDecision): ReplicationLogEntry {
    const entry: ReplicationLogEntry = { seq: this.#nextSeq, decision };
    this.#nextSeq += 1;
    if (this.#retain) this.#entries.push(entry);
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

  /** What this recorder kept. Empty when it was built not to retain. */
  get entries(): readonly ReplicationLogEntry[] {
    return this.#entries;
  }
}

/**
 * Wait for the primary to record more, and say whether it did.
 *
 * A replica that runs the machine faster than the primary reaches the end of
 * the log it has been sent, and neither reading its own clock nor reusing the
 * last one keeps it the same machine. A live replay installs this hook so the
 * guest's clock read stops there until the next decision arrives.
 *
 * Returns `null` when the recording ended and nothing will follow, which is
 * the end of the replay rather than a defect.
 */
export type ReplicationLogExtender = () => ReplicationLogEntry | null;

/**
 * Serve recorded decisions back, in order, and refuse anything else.
 *
 * Every `take` names the decision the caller expects. A mismatch means the
 * replica reached a different point in its execution than the primary did, so
 * the reader reports the position rather than handing back the next value and
 * letting the two machines drift apart unnoticed.
 */
export class ReplicationLogReader {
  readonly #entries: ReplicationLogEntry[];
  readonly #applyPushed?: (decision: ReplicationPushedDecision) => void;
  readonly #extend?: ReplicationLogExtender;
  readonly #extendReady?: ReplicationLogExtender;
  #index = 0;
  #ended = false;

  constructor(
    entries: readonly ReplicationLogEntry[],
    applyPushed?: (decision: ReplicationPushedDecision) => void,
    extend?: ReplicationLogExtender,
    extendReady?: ReplicationLogExtender,
  ) {
    this.#entries = [...entries];
    this.#applyPushed = applyPushed;
    this.#extend = extend;
    this.#extendReady = extendReady;
  }

  /**
   * How many entries this reader holds.
   *
   * A live replay is given an empty log and grows it as the primary records,
   * so this is what `consumed` is a position within.
   */
  get known(): number {
    return this.#entries.length;
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
   * Whether the primary's next decision is already here.
   *
   * A replica behind the log head is running the machine later than the
   * primary did. The waits between those decisions already passed once, on
   * the primary; a replica that waits them out again keeps the gap it joined
   * with. The host asks this before serving a sleep or a vblank at its real
   * pace, and pulls the ring so a decision parked there counts as here.
   */
  entryReady(): boolean {
    if (this.#entries[this.#index] !== undefined) return true;
    if (this.#extendReady === undefined || this.#ended) return false;
    const arrived = this.#extendReady();
    if (arrived === null) return false;
    this.#append(arrived);
    return true;
  }

  /**
   * Deliver every pushed decision the log holds at the current position.
   *
   * A pushed decision has no guest request to answer, so nothing would
   * consume it on its own. A driver that has just received new entries calls
   * this so input the primary delivered after its last clock read still
   * reaches the replica — a shell sitting at its prompt makes no clock read,
   * and a keystroke that waited for one would never arrive.
   *
   * `extendReady` is what this pulls from: the entries that are already
   * there, without waiting for more. The blocking `extend` belongs to the
   * guest's own reads, where stopping until the primary decides is the point.
   */
  drainPushed(): void {
    for (;;) {
      this.#drainPushed();
      if (this.#extendReady === undefined || this.#ended) return;
      const arrived = this.#extendReady();
      if (arrived === null) return;
      this.#append(arrived);
    }
  }

  takeGlQuery(op: number): ReplicationGlQueryAnswer {
    const entry = this.#awaitEntry();
    if (entry === undefined) {
      throw new ReplicationDivergence(
        this.nextSeq,
        this.#ended
          ? `the replica ran GL query ${op} after the primary stopped recording`
          : `the replica ran GL query ${op} past the end of the log`,
      );
    }
    if (entry.decision.kind !== "gl") {
      throw new ReplicationDivergence(
        entry.seq,
        `the replica ran a GL query where the primary recorded `
          + `${entry.decision.kind}`,
      );
    }
    if (entry.decision.op !== op) {
      throw new ReplicationDivergence(
        entry.seq,
        `the replica ran GL query ${op} where the primary ran `
          + `${entry.decision.op}`,
      );
    }
    if (
      entry.decision.rc > 0
      && entry.decision.bytes.byteLength < entry.decision.rc
    ) {
      throw new ReplicationDivergence(
        entry.seq,
        `the log's GL answer claims ${entry.decision.rc} bytes and carries `
          + `${entry.decision.bytes.byteLength}`,
      );
    }
    this.#index += 1;
    return entry.decision;
  }

  takeClock(clockId: number): ReplicationClockReading {
    const entry = this.#awaitEntry();
    if (entry === undefined) {
      throw new ReplicationDivergence(
        this.nextSeq,
        this.#ended
          ? `the replica read clock ${clockId} after the primary stopped `
            + `recording`
          : `the replica read clock ${clockId} past the end of the log`,
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
   * The entry the guest's next request must answer to, waiting for it if the
   * replica has caught up with the primary.
   *
   * What the primary delivered before that entry reaches the guest first, on
   * every pass, or the replica applies it against a later state than the
   * primary did. Returns undefined when the log holds no more and none is
   * coming.
   */
  #awaitEntry(): ReplicationLogEntry | undefined {
    for (;;) {
      this.#drainPushed();
      const entry = this.#entries[this.#index];
      if (entry !== undefined) return entry;
      if (this.#extend === undefined || this.#ended) return undefined;
      const arrived = this.#extend();
      if (arrived === null) {
        this.#ended = true;
        return undefined;
      }
      this.#append(arrived);
    }
  }

  /**
   * Take one more entry the primary recorded.
   *
   * The wire that carried it already refuses a hole. Checking again here is
   * what makes the reader's own position trustworthy: it consumes by index,
   * so an entry appended out of sequence would be served as though the
   * primary had made it in that order.
   */
  #append(entry: ReplicationLogEntry): void {
    const last = this.#entries[this.#entries.length - 1];
    if (last !== undefined && entry.seq !== last.seq + 1) {
      throw new ReplicationDivergence(
        entry.seq,
        `the log jumped to ${entry.seq} where ${last.seq + 1} was next`,
      );
    }
    this.#entries.push(entry);
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
  if (decision.kind === "input") return `input for ${decision.device}`;
  if (decision.kind === "resize") return `a resize of ${decision.device}`;
  return "a pointer movement";
}
