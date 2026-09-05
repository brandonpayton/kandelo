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

/**
 * One `clock_gettime` result the host produced for a guest.
 *
 * `pid` is the process the reading was handed to, and it is what makes the
 * reading replayable. A machine with more than one process has more than one
 * guest reading clocks, and which of them reaches its next read first is the
 * host's scheduling of their workers — a decision no log records today. Two
 * computers therefore pull the same readings in different orders, and a
 * replica that consumed one global sequence would refuse the first reading it
 * asked for. Recording the reader means every process replays its own
 * readings, in its own order, whatever order the processes ran in.
 *
 * `pid` is zero for a reading the host took for itself rather than for a
 * guest. Threads of one process share a pid, so a multi-threaded guest that
 * reads clocks from several threads still shares one stream and can still
 * diverge; that is a smaller boundary than the one this closes, and closing
 * it needs the current thread id at the syscall the same way this needed the
 * current process.
 */
export interface ReplicationClockReading {
  readonly kind: "clock";
  readonly pid: number;
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
 * Which process the host let take one connection off a shared accept queue.
 *
 * A pre-fork server — nginx, php-fpm — has every worker blocked in `accept`
 * on one queue, and the connection goes to whichever worker the host runs
 * first. That choice is nowhere in the machine's memory, so two computers
 * make it differently, and a replica that hands the request to a different
 * worker than the primary did is running a different machine from the first
 * request on. Recording the winner is what keeps every worker of a replica
 * doing what its counterpart did.
 *
 * `listener` is the kernel's accept readiness token for the queue, which
 * travels in the checkpoint like every other piece of kernel state, so the
 * two computers name the same listener by it. `pid` is the process the
 * connection went to.
 */
export interface ReplicationAcceptSelection {
  readonly kind: "accept";
  readonly listener: number;
  readonly pid: number;
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
 * One HTTP request the host injected into the machine, as it injected it.
 *
 * A server guest observes an injected connection three ways: the accept that
 * hands it a peer, the peer's port, and the request bytes it reads. All three
 * are host-produced — the primary's bridge even draws the peer port at
 * random — so all three travel. The response is not here: it is the machine's
 * own output, and a replica that runs the same machine computes it again.
 */
export interface ReplicationHttpExchange {
  readonly kind: "http";
  /** The in-kernel listener port the request was dispatched to. */
  readonly port: number;
  /** The synthetic peer port the primary drew for the injected connection. */
  readonly remotePort: number;
  /** The raw HTTP/1.1 request bytes, exactly as written into the pipe. */
  readonly request: Uint8Array;
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
  | ReplicationResizeEvent
  | ReplicationHttpExchange;

/**
 * A value the host produced that the guest could not have derived itself.
 *
 * Two shapes travel together here. A clock reading, a GL answer, and an
 * accept selection are *pulled*: the guest asks and the log answers. A pushed
 * decision arrives between two guest requests, and the log records where.
 */
export type ReplicationDecision =
  | ReplicationClockReading
  | ReplicationGlQueryAnswer
  | ReplicationAcceptSelection
  | ReplicationPushedDecision;

/** Whether `decision` is one the host delivered rather than the guest asked for. */
function isPushedDecision(
  decision: ReplicationDecision,
): decision is ReplicationPushedDecision {
  return (
    decision.kind === "input"
    || decision.kind === "pointer"
    || decision.kind === "resize"
    || decision.kind === "http"
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
 * Wait for the primary to record more, but only for so long.
 *
 * `takeClock` waits here instead of on the unbounded extender: the wait runs
 * on the kernel worker and holds every process of the machine, and a process
 * whose counterpart on the primary stopped reading the clock has no next
 * reading to wait for. `"timedout"` says the budget elapsed with nothing
 * readable; `null` keeps the extender meaning of "the recording ended".
 */
export type ReplicationLogBoundedExtender = (
  budgetMs: number,
) => ReplicationLogEntry | null | "timedout";

/**
 * How long a clock read waits for its own process's next reading before it
 * is served the machine-latest one. Longer than the slowest recorded tick
 * loop, so a process the log still feeds keeps its own stream.
 */
const CLOCK_STREAM_WAIT_MS = 2_000;

/** The shorter wait for a process that has already borrowed once. */
const CLOCK_OFF_STREAM_WAIT_MS = 100;

/**
 * How long an accept waits for the primary to say which worker won it.
 *
 * A replica normally trails the primary, so the selection is already in the
 * log when its own workers reach the queue and no wait happens at all. The
 * budget covers the replica that got there first, and it is shorter than the
 * clock's because every worker of the machine is blocked on this one queue
 * while it runs.
 */
const ACCEPT_SELECTION_WAIT_MS = 1_000;

/**
 * Serve recorded decisions back, in order, and refuse anything else.
 *
 * Every `take` names the decision the caller expects. A mismatch means the
 * replica reached a different point in its execution than the primary did, so
 * the reader reports the position rather than handing back the next value and
 * letting the two machines drift apart unnoticed.
 *
 * Clock readings are the exception to "in order", and
 * {@link ReplicationClockReading} says why: they are served per process, each
 * process taking its own readings from wherever they sit in the log. Every
 * other decision keeps one position, because a GL query belongs to the one
 * process holding the context and a pushed decision has to land where the
 * primary delivered it.
 *
 * A pushed decision is delivered before the reading that follows it, which is
 * where the two shapes meet. `take` for one process passes over readings that
 * belong to other processes on its way, so a pushed decision reaches the
 * replica at the first clock read positioned after it — by any process, not
 * only by the one whose readings surround it.
 */
export class ReplicationLogReader {
  readonly #entries: ReplicationLogEntry[];
  readonly #applyPushed?: (decision: ReplicationPushedDecision) => void;
  readonly #extend?: ReplicationLogExtender;
  readonly #extendReady?: ReplicationLogExtender;
  readonly #extendWithin?: ReplicationLogBoundedExtender;
  readonly #onDiverged?: (error: ReplicationDivergence) => void;
  /** Which entries have been served. Parallel to `#entries`. */
  readonly #taken: boolean[];
  /** Where each process's next clock reading is looked for. */
  readonly #clockAt = new Map<number, number>();
  /** Where each listener's next accept selection is looked for. */
  readonly #acceptAt = new Map<number, number>();
  /** Selections a listener owes, one per accept it took without the log. */
  readonly #acceptDebt = new Map<number, number>();
  #borrowedAcceptSelections = 0;
  /** The reading the log carries last, per clock, for a borrow. */
  readonly #latestReading = new Map<number, { sec: number; nsec: number }>();
  /** The reading each process was last served, per clock, for `aheadMs`. */
  readonly #servedReading = new Map<
    number,
    Map<number, { sec: number; nsec: number }>
  >();
  /** Processes that borrowed: their primary counterpart stopped reading. */
  readonly #offStream = new Set<number>();
  #borrowedClockReadings = 0;
  /** How far pushed decisions have been delivered. */
  #index = 0;
  #firstUnconsumed = 0;
  #consumed = 0;
  #ended = false;

  constructor(
    entries: readonly ReplicationLogEntry[],
    applyPushed?: (decision: ReplicationPushedDecision) => void,
    extend?: ReplicationLogExtender,
    extendReady?: ReplicationLogExtender,
    onDiverged?: (error: ReplicationDivergence) => void,
    extendWithin?: ReplicationLogBoundedExtender,
  ) {
    this.#entries = [...entries];
    this.#taken = this.#entries.map(() => false);
    this.#onDiverged = onDiverged;
    this.#applyPushed = applyPushed;
    this.#extend = extend;
    this.#extendReady = extendReady;
    this.#extendWithin = extendWithin;
    for (const entry of this.#entries) this.#observeClock(entry);
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
    return this.#consumed;
  }

  /** The sequence number of the earliest decision this reader has not served. */
  get nextSeq(): number {
    while (this.#taken[this.#firstUnconsumed] === true) {
      this.#firstUnconsumed += 1;
    }
    return this.#entries[this.#firstUnconsumed]?.seq
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
   * How far past this process's own point the primary already went, in
   * machine milliseconds, or null when it has not gone past it.
   *
   * A guest's timeout is a duration on the machine's clock, and the machine's
   * clock is this log. The primary spent the wait and then read the clock on
   * the far side of it, so the gap between the reading this process was last
   * served and its next recorded one is the wait the primary actually served.
   * A replica that measured the same timeout against its own computer's clock
   * would serve the wait again at its original pace and keep the gap it
   * joined with — and the gap is the whole machine's, because every decision
   * the log carries after that reading waits behind it.
   *
   * The answer is per process because the two differ where it matters. A
   * machine has one process ticking on a one-second timer while others sit
   * idle, and the log grows the whole time; a replica reading the log head
   * alone would shorten a wait the primary has not finished, spend readings
   * the primary has not made, and end up borrowing.
   *
   * Zero names the machine rather than a process, for a host wait that
   * belongs to no guest. The answer is then whether the log carries anything
   * this replica has not reached.
   */
  aheadMs(pid: number): number | null {
    if (pid === 0) {
      return this.entryReady() ? Number.POSITIVE_INFINITY : null;
    }
    const at = this.#findClock(pid);
    if (at === null) return null;
    const next = this.#entries[at]!.decision as ReplicationClockReading;
    const served = this.#servedReading.get(pid)?.get(next.clockId);
    if (served === undefined) return null;
    return (next.sec - served.sec) * 1000 + (next.nsec - served.nsec) / 1e6;
  }

  /** Keep the reading this process was last served, per clock. */
  #serve(reading: ReplicationClockReading): ReplicationClockReading {
    let byClock = this.#servedReading.get(reading.pid);
    if (byClock === undefined) {
      byClock = new Map();
      this.#servedReading.set(reading.pid, byClock);
    }
    byClock.set(reading.clockId, { sec: reading.sec, nsec: reading.nsec });
    return reading;
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
      this.#diverge(
        this.nextSeq,
        this.#ended
          ? `the replica ran GL query ${op} after the primary stopped recording`
          : `the replica ran GL query ${op} past the end of the log`,
      );
    }
    if (entry.decision.kind !== "gl") {
      this.#diverge(
        entry.seq,
        `the replica ran a GL query where the primary recorded `
          + `${entry.decision.kind}`,
      );
    }
    if (entry.decision.op !== op) {
      this.#diverge(
        entry.seq,
        `the replica ran GL query ${op} where the primary ran `
          + `${entry.decision.op}`,
      );
    }
    if (
      entry.decision.rc > 0
      && entry.decision.bytes.byteLength < entry.decision.rc
    ) {
      this.#diverge(
        entry.seq,
        `the log's GL answer claims ${entry.decision.rc} bytes and carries `
          + `${entry.decision.bytes.byteLength}`,
      );
    }
    this.#take(this.#index);
    this.#index += 1;
    return entry.decision;
  }

  /**
   * The reading the primary handed this process for its next clock read.
   *
   * The search runs over this process's own readings, so another process
   * having read a different clock in between is not a divergence — it is the
   * two computers scheduling their workers differently, which every machine
   * with more than one process does.
   *
   * On a live replay the same scheduling difference reaches inside one
   * process: the replica's process can read its two clocks in a different
   * interleaving than its primary counterpart did. Its next recorded reading
   * of the clock it asked for is served instead, and the reading it stepped
   * over stays for its own later read. A finished recording replayed locally
   * keeps the strict order and reports the mismatch as the divergence it is.
   */
  takeClock(clockId: number, pid: number): ReplicationClockReading {
    let deadline: number | null = null;
    for (;;) {
      const at = this.#findClock(pid);
      // Everything the primary pushed before this reading, first — and over
      // the readings other processes have not taken, because a process that
      // may never read again must not hold the primary's input.
      this.#deliverPushed(at ?? this.#entries.length, { over: true });
      if (at !== null) {
        const entry = this.#entries[at]!;
        const decision = entry.decision as ReplicationClockReading;
        if (decision.clockId === clockId) {
          this.#clockAt.set(pid, at + 1);
          this.#take(at);
          if (this.#index <= at) this.#index = at + 1;
          this.#offStream.delete(pid);
          return this.#serve(decision);
        }
        if (this.#extendWithin === undefined) {
          this.#diverge(
            entry.seq,
            `the replica read clock ${clockId} where the primary read clock `
              + `${decision.clockId}`,
          );
        }
        const ahead = this.#findClockAhead(pid, clockId, at + 1);
        if (ahead !== null) {
          const served = this.#entries[ahead]!
            .decision as ReplicationClockReading;
          this.#deliverPushed(ahead, { over: true });
          this.#take(ahead);
          if (this.#index <= ahead) this.#index = ahead + 1;
          this.#offStream.delete(pid);
          return this.#serve(served);
        }
      }
      if (this.#extend === undefined || this.#ended) {
        this.#diverge(
          this.nextSeq,
          this.#ended
            ? `the replica read clock ${clockId} after the primary stopped `
              + `recording`
            : `the replica read clock ${clockId} past the end of the log`,
        );
      }
      if (this.#extendWithin !== undefined) {
        const now = Date.now();
        deadline ??= now + (this.#offStream.has(pid)
          ? CLOCK_OFF_STREAM_WAIT_MS
          : CLOCK_STREAM_WAIT_MS);
        if (now >= deadline) {
          const borrowed = this.#borrow(clockId, pid);
          if (borrowed !== null) return borrowed;
          deadline = null;
          continue;
        }
        const arrived = this.#extendWithin(deadline - now);
        if (arrived === "timedout") continue;
        if (arrived === null) {
          this.#ended = true;
          continue;
        }
        this.#append(arrived);
        continue;
      }
      const arrived = this.#extend();
      if (arrived === null) {
        this.#ended = true;
        continue;
      }
      this.#append(arrived);
    }
  }

  /**
   * How many clock reads were served the machine-latest reading because
   * their own process's next reading was not coming. Zero on a replica whose
   * processes all match the primary's scheduling; nonzero is a visible,
   * bounded softening of per-process replay, not a silent one.
   */
  get borrowedClockReadings(): number {
    return this.#borrowedClockReadings;
  }

  /**
   * Whether this process is the one the primary let take the connection at
   * the head of this listener's shared accept queue.
   *
   * Every worker of a pre-fork server asks, and only the recorded one is told
   * yes. A worker told no gets `EAGAIN` and leaves the connection where it
   * is, so the recorded winner still finds it when the host runs that worker;
   * the selection is not consumed by the asks that lose it.
   *
   * The search runs over this listener's own selections, so an accept on
   * another listener in between is not a divergence — it is the two computers
   * scheduling their workers differently, the same thing per-process clock
   * streams exist for.
   */
  takeAcceptWinner(listener: number, pid: number): boolean {
    let deadline: number | null = null;
    for (;;) {
      const at = this.#findAccept(listener);
      // Everything the primary pushed before the selection, first: the
      // request that produced this connection is one of those decisions.
      this.#deliverPushed(at ?? this.#entries.length, { over: true });
      if (at !== null) {
        // A selection the primary recorded for an accept this replica already
        // took without it belongs to nothing, and serving it to the next
        // accept would put this listener one connection behind the log for
        // the rest of the machine's life.
        if (this.#settleAcceptDebt(listener, at)) continue;
        const entry = this.#entries[at]!;
        const decision = entry.decision as ReplicationAcceptSelection;
        if (decision.pid !== pid) return false;
        this.#acceptAt.set(listener, at + 1);
        this.#take(at);
        if (this.#index <= at) this.#index = at + 1;
        return true;
      }
      if (this.#extendWithin === undefined || this.#ended) {
        this.#diverge(
          this.nextSeq,
          this.#ended
            ? `the replica accepted on listener ${listener} after the primary `
              + `stopped recording`
            : `the replica accepted on listener ${listener} past the end of `
              + `the log`,
        );
      }
      const now = Date.now();
      deadline ??= now + ACCEPT_SELECTION_WAIT_MS;
      if (now >= deadline) return this.#borrowAccept(listener);
      const arrived = this.#extendWithin(deadline - now);
      if (arrived === "timedout") continue;
      if (arrived === null) {
        this.#ended = true;
        continue;
      }
      this.#append(arrived);
    }
  }

  /**
   * How many accepts were taken by whichever worker asked because the primary
   * never said which one won. Zero on a replica the log keeps up with;
   * nonzero is the same visible, bounded softening `borrowedClockReadings`
   * reports, and it is where a divergent worker assignment can still enter.
   */
  get borrowedAcceptSelections(): number {
    return this.#borrowedAcceptSelections;
  }

  /**
   * Let the asking process take the connection, and count that it did.
   *
   * The primary may still record a winner for this accept, so the listener
   * owes one selection: {@link #settleAcceptDebt} spends it rather than
   * letting it answer the accept that comes after.
   */
  #borrowAccept(listener: number): boolean {
    this.#acceptDebt.set(listener, (this.#acceptDebt.get(listener) ?? 0) + 1);
    this.#borrowedAcceptSelections += 1;
    return true;
  }

  /**
   * Spend one owed selection on the entry at `at`, if this listener owes any.
   *
   * Returns whether the entry was spent, which means the caller must look
   * for the next one rather than answer from this.
   */
  #settleAcceptDebt(listener: number, at: number): boolean {
    const owed = this.#acceptDebt.get(listener) ?? 0;
    if (owed === 0) return false;
    if (owed === 1) this.#acceptDebt.delete(listener);
    else this.#acceptDebt.set(listener, owed - 1);
    this.#acceptAt.set(listener, at + 1);
    this.#take(at);
    if (this.#index <= at) this.#index = at + 1;
    return true;
  }

  /**
   * Where this listener's next unserved selection sits, or null when the log
   * holds none yet.
   *
   * The search resumes from where the last one stopped, so a listener does
   * not rescan the whole log on every accept.
   */
  #findAccept(listener: number): number | null {
    let at = this.#acceptAt.get(listener) ?? 0;
    for (; at < this.#entries.length; at += 1) {
      if (this.#taken[at] === true) continue;
      const decision = this.#entries[at]!.decision;
      if (decision.kind === "accept" && decision.listener === listener) {
        this.#acceptAt.set(listener, at);
        return at;
      }
    }
    this.#acceptAt.set(listener, at);
    return null;
  }

  /**
   * The latest reading the log carries for this clock, when the process's
   * own next reading is not coming.
   *
   * The two computers schedule work differently — the request the primary
   * hands one worker the replica hands another — so a replica process can
   * read a clock whose primary counterpart never reads again. Waiting for
   * that reading holds the kernel worker, and with it the whole machine. The
   * reading served instead is still one the primary observed: the log stays
   * the whole machine's clock. Returns null when the log has not carried a
   * reading for this clock yet, and the read keeps waiting.
   *
   * A borrow cannot step a monotonic clock backward: entries append in the
   * order the primary recorded them, so the machine-latest reading is never
   * ahead of a reading the process's own later entry will carry.
   */
  #borrow(clockId: number, pid: number): ReplicationClockReading | null {
    const latest = this.#latestReading.get(clockId);
    if (latest === undefined) return null;
    this.#offStream.add(pid);
    this.#borrowedClockReadings += 1;
    return this.#serve({
      kind: "clock",
      pid,
      clockId,
      sec: latest.sec,
      nsec: latest.nsec,
    });
  }

  /** Keep the machine-latest reading per clock, as the log grows. */
  #observeClock(entry: ReplicationLogEntry): void {
    const decision = entry.decision;
    if (decision.kind !== "clock") return;
    this.#latestReading.set(decision.clockId, {
      sec: decision.sec,
      nsec: decision.nsec,
    });
  }

  /**
   * Where this process's next unserved reading sits, or null when the log
   * holds none yet.
   *
   * The search resumes from where the last one stopped, so a process does not
   * rescan the whole log on every read.
   */
  #findClock(pid: number): number | null {
    let at = this.#clockAt.get(pid) ?? 0;
    for (; at < this.#entries.length; at += 1) {
      if (this.#taken[at] === true) continue;
      const decision = this.#entries[at]!.decision;
      if (decision.kind === "clock" && decision.pid === pid) {
        this.#clockAt.set(pid, at);
        return at;
      }
    }
    this.#clockAt.set(pid, at);
    return null;
  }

  /**
   * The process's next unserved reading of this one clock, past its next
   * reading overall, or null when the log holds none yet.
   *
   * A live replica's process can interleave its reads of two clocks
   * differently than its primary counterpart did — the request the primary
   * hands one worker the replica hands another. Serving the process its own
   * next reading of the clock it asked for keeps every reading one the
   * primary recorded for this process, in order per clock, while the reading
   * it stepped over stays where its own later read will find it.
   */
  #findClockAhead(pid: number, clockId: number, from: number): number | null {
    for (let at = from; at < this.#entries.length; at += 1) {
      if (this.#taken[at] === true) continue;
      const decision = this.#entries[at]!.decision;
      if (
        decision.kind === "clock"
        && decision.pid === pid
        && decision.clockId === clockId
      ) {
        return at;
      }
    }
    return null;
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
      this.#diverge(
        entry.seq,
        `the log jumped to ${entry.seq} where ${last.seq + 1} was next`,
      );
    }
    this.#entries.push(entry);
    this.#taken.push(false);
    this.#observeClock(entry);
  }

  /**
   * Report the divergence, then raise it.
   *
   * Raising it alone is not enough. The guest's read fails with an errno its
   * program reads as an ordinary failure — a clock that returns `EIO` leaves
   * nginx stamping 1970 and kills the PHP worker behind it — so a replica that
   * only threw would serve a broken machine and say nothing. The report is
   * what makes the divergence visible to the person watching.
   */
  #diverge(seq: number, reason: string): never {
    const error = new ReplicationDivergence(seq, reason);
    this.#onDiverged?.(error);
    throw error;
  }

  /** Count one entry as served. */
  #take(at: number): void {
    this.#taken[at] = true;
    this.#consumed += 1;
  }

  /**
   * Hand every leading pushed decision to the sink, in order.
   *
   * A reader with no sink refuses rather than passing the entry over: a
   * dropped input is a replica that silently stopped being the same machine,
   * which is the failure this module exists to prevent.
   */
  #drainPushed(): void {
    this.#deliverPushed(this.#entries.length, { over: false });
  }

  /**
   * Deliver the pushed decisions that sit before `limit`.
   *
   * `over` says what to do with a reading another process has not taken yet.
   * A clock read passes over one — its own reading sits behind it, and waiting
   * for a process that may never read again would strand the primary's input.
   * A drain stops at one instead, so a decision the primary made after that
   * reading is not applied to a replica that has not reached it.
   */
  #deliverPushed(limit: number, options: { over: boolean }): void {
    for (let at = this.#index; at < limit; at += 1) {
      const entry = this.#entries[at]!;
      if (!isPushedDecision(entry.decision)) {
        if (!options.over && this.#taken[at] !== true) return;
        this.#index = at + 1;
        continue;
      }
      if (!this.#applyPushed) {
        this.#diverge(
          entry.seq,
          `the log carries ${describePushed(entry.decision)} and the replica `
            + `installed no input sink`,
        );
      }
      this.#index = at + 1;
      this.#take(at);
      this.#applyPushed(entry.decision);
    }
  }
}

function describePushed(decision: ReplicationPushedDecision): string {
  if (decision.kind === "input") return `input for ${decision.device}`;
  if (decision.kind === "resize") return `a resize of ${decision.device}`;
  if (decision.kind === "http") {
    return `an HTTP request for port ${decision.port}`;
  }
  return "a pointer movement";
}
