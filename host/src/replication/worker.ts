/**
 * The kernel worker's half of replication.
 *
 * Both worker entries own the same two jobs — publish the decisions a primary
 * makes, and take the decisions a replica follows — and the host runtime
 * contract says Node and the browser are peers. Keeping the two shapes here
 * is what stops one host from batching, waiting, or ending differently from
 * the other.
 */
import type { AcceptSelectionTap, GlQueryTap } from "../kernel.js";
import type { HttpExchangeTap } from "../networking/in-kernel-http.js";
import type { TimeProvider } from "../vfs/types.js";
import {
  ReplicationLogReader,
  ReplicationLogRecorder,
  type ReplicationDivergence,
  type ReplicationLogEntry,
  type ReplicationLogBoundedExtender,
  type ReplicationLogExtender,
  type ReplicationPushedDecision,
} from "./log.js";
import { RecordingTimeProvider, ReplayingTimeProvider } from "./clock.js";
import { ReplicationLogQueueReader } from "./log-queue.js";

/**
 * The machine surfaces replication swaps, beyond the clock.
 *
 * GL query answers are host-produced values exactly like clock readings —
 * two GPUs answer differently — so a recording or replaying machine puts
 * its hand on `host_gl_query` at the same moment it swaps the guest clock,
 * and takes it off at the same moment too. An injected HTTP request is a
 * host-delivered input exactly like a keystroke, so the same hand goes on
 * `sendHttpRequest`. Which worker of a pre-fork server wins a shared accept
 * queue is host scheduling in the same way, so the same hand goes on
 * `host_accept_select`. Wait pacing is the other host effect a replica swaps:
 * a guest's timeout is a duration on the machine's clock, so a replica reads
 * that duration off the log rather than off its own computer, and the waits
 * the primary already spent complete at once. Without it the replica keeps
 * the gap it joined with. One installer type keeps Node and the browser doing
 * all of it identically.
 */
export interface ReplicationMachineTaps {
  setGlQueryTap(tap: GlQueryTap | null): void;
  setAcceptSelectionTap(tap: AcceptSelectionTap | null): void;
  setReplicationAheadProbe(
    probe: ((pid: number) => number | null) | null,
  ): void;
  setHttpExchangeTap(tap: HttpExchangeTap | null): void;
  /**
   * The process whose syscall this machine is serving, or 0 for work the host
   * does for itself. A clock reading is logged against it, so a replica
   * replays each process's own readings instead of one global order the two
   * computers never share.
   */
  currentGuestPid(): number;
}

/** Record every GL query answer the guest is handed, on the shared log. */
export function glQueryRecordTap(recorder: ReplicationLogRecorder): GlQueryTap {
  return {
    mode: "record",
    record: (op, rc, bytes) => {
      recorder.record({ kind: "gl", op, rc, bytes });
    },
  };
}

/** Serve the recorded GL answers back, and refuse to invent one. */
function glQueryReplayTap(reader: ReplicationLogReader): GlQueryTap {
  return {
    mode: "replay",
    take: (op) => reader.takeGlQuery(op),
  };
}

/** Record which worker won each shared accept queue, on the shared log. */
export function acceptSelectionRecordTap(
  recorder: ReplicationLogRecorder,
): AcceptSelectionTap {
  return {
    mode: "record",
    record: (listener, pid) => {
      recorder.record({ kind: "accept", listener, pid });
    },
  };
}

/** Hold each connection for the worker the primary gave it to. */
function acceptSelectionReplayTap(
  reader: ReplicationLogReader,
): AcceptSelectionTap {
  return {
    mode: "replay",
    select: (listener, pid) => reader.takeAcceptWinner(listener, pid),
  };
}

/** Record every HTTP injection the guest is handed, on the shared log. */
export function httpExchangeRecordTap(
  recorder: ReplicationLogRecorder,
): HttpExchangeTap {
  return {
    mode: "record",
    record: (injection) => {
      recorder.record({ kind: "http", ...injection });
    },
  };
}

/** What a replica has for one request line the viewer asked for. */
export type ReplayedHttpOutcome<Response> =
  /** This machine computed a response for the request. */
  | { readonly kind: "served"; readonly response: Response }
  /** The replay of the request ended without one, and this is why. */
  | { readonly kind: "failed"; readonly reason: string }
  /** The log carries no such request, so this machine never saw it. */
  | { readonly kind: "unrecorded" };

/**
 * The responses a replica's replayed injections produced, by request line.
 *
 * A viewer's own page asks for the same resources the primary's page did,
 * and the machine must not see those asks — a live injection on a replica
 * diverges it. The pairing happens here instead: each replayed exchange
 * deposits the response this machine computed, and the viewer's fetch takes
 * the copy. Latest wins per request line, because the two browsers cache
 * differently and the primary may have fetched a resource more or fewer
 * times than the viewer asks for it.
 */
export class ReplayedHttpExchanges<Response> {
  readonly #responses = new Map<string, Response>();
  /** Why the last replay of a request line ended without a response. */
  readonly #failures = new Map<string, string>();
  /** How many replays of a request line are running. */
  readonly #inFlight = new Map<string, number>();
  readonly #waiters = new Map<
    string,
    Array<(outcome: ReplayedHttpOutcome<Response>) => void>
  >();
  /** Request lines already reported missing, until something settles them. */
  readonly #missed = new Set<string>();
  readonly #waitMs: number;
  readonly #missAfterMs: number;
  readonly #reportMiss: ((key: string) => void) | null;

  constructor(
    waitMs = 30_000,
    miss?: { report: (key: string) => void; afterMs?: number },
  ) {
    this.#waitMs = waitMs;
    this.#reportMiss = miss?.report ?? null;
    this.#missAfterMs = miss?.afterMs ?? 2_000;
  }

  /**
   * A replay of this request line has started.
   *
   * Said before the machine is asked to serve it, and it is what turns the
   * wait below from a deadline into a wait for this machine's own answer. The
   * replay takes as long as the machine takes — a WordPress page behind
   * php-fpm is not a 30 s request — and a viewer that gave up first would
   * report a request the log plainly carries as one that was never made.
   */
  expect(key: string): void {
    this.#inFlight.set(key, (this.#inFlight.get(key) ?? 0) + 1);
  }

  deliver(key: string, response: Response): void {
    this.#leave(key);
    this.#missed.delete(key);
    this.#responses.set(key, response);
    this.#failures.delete(key);
    this.#settle(key, { kind: "served", response });
  }

  /**
   * The replay of this request line ended without a response.
   *
   * The reason is the machine's, so it belongs to whoever asked for the page
   * rather than to a console line no viewer reads.
   */
  fail(key: string, reason: string): void {
    this.#leave(key);
    this.#missed.delete(key);
    this.#failures.set(key, reason);
    if (this.#running(key) || this.#responses.has(key)) return;
    this.#settle(key, { kind: "failed", reason });
  }

  /**
   * What this machine produced for the request, waiting for a replay that is
   * still running and parking briefly for one that has not started.
   *
   * The short park is for the request the log has not reached yet. Once the
   * park expires with nothing in flight, `unrecorded` is the true answer:
   * neither browser's copy of that request reached this machine, which is a
   * cache asymmetry between the two and not a divergence.
   */
  take(key: string): Promise<ReplayedHttpOutcome<Response>> {
    const ready = this.#ready(key);
    if (ready !== null) return Promise.resolve(ready);
    return new Promise((resolve) => {
      const waiters = this.#waiters.get(key) ?? [];
      waiters.push(resolve);
      this.#waiters.set(key, waiters);
      if (this.#running(key)) return;
      // Report the miss well before the deadline. The primary can still make
      // the request this machine has no replay of — that is what a report is
      // for — and a report held until the deadline arrives with the 502.
      if (this.#reportMiss !== null) {
        setTimeout(() => {
          if (this.#running(key) || this.#missed.has(key)) return;
          if (!this.#waiters.has(key)) return;
          this.#missed.add(key);
          this.#reportMiss?.(key);
        }, this.#missAfterMs);
      }
      setTimeout(() => {
        // A replay may have started while this fetch waited. Its answer is
        // this machine's, and it is worth more than a deadline.
        if (this.#running(key)) return;
        this.#missed.delete(key);
        this.#release(key, resolve, { kind: "unrecorded" });
      }, this.#waitMs);
    });
  }

  drop(): void {
    this.#responses.clear();
    this.#failures.clear();
    this.#inFlight.clear();
    this.#missed.clear();
    for (const [key, waiters] of this.#waiters) {
      for (const waiter of waiters) {
        waiter({
          kind: "failed",
          reason: `the replica that was serving ${key} is gone`,
        });
      }
    }
    this.#waiters.clear();
  }

  #ready(key: string): ReplayedHttpOutcome<Response> | null {
    const response = this.#responses.get(key);
    if (response !== undefined) return { kind: "served", response };
    const reason = this.#failures.get(key);
    if (reason !== undefined && !this.#running(key)) {
      return { kind: "failed", reason };
    }
    return null;
  }

  #running(key: string): boolean {
    return (this.#inFlight.get(key) ?? 0) > 0;
  }

  #leave(key: string): void {
    const running = this.#inFlight.get(key) ?? 0;
    if (running <= 1) this.#inFlight.delete(key);
    else this.#inFlight.set(key, running - 1);
  }

  #settle(key: string, outcome: ReplayedHttpOutcome<Response>): void {
    const waiters = this.#waiters.get(key);
    if (!waiters) return;
    this.#waiters.delete(key);
    for (const waiter of waiters) waiter(outcome);
  }

  #release(
    key: string,
    waiter: (outcome: ReplayedHttpOutcome<Response>) => void,
    outcome: ReplayedHttpOutcome<Response>,
  ): void {
    const parked = this.#waiters.get(key);
    if (!parked) return;
    const index = parked.indexOf(waiter);
    if (index < 0) return;
    parked.splice(index, 1);
    if (parked.length === 0) this.#waiters.delete(key);
    waiter(outcome);
  }
}

/**
 * What to tell a viewer whose fetch this machine did not answer.
 *
 * "Never served" is a claim about the log, so it is only made when the log
 * really carries no such request. A replay that ran and failed reports its own
 * reason instead, because that reason is the machine's state and the person
 * looking at a blank page is owed it. Both hosts say it here so a viewer reads
 * the same sentence whichever one is running its replica.
 */
export function describeReplayedHttp(
  key: string,
  outcome: { kind: "failed"; reason: string } | { kind: "unrecorded" },
): string {
  return outcome.kind === "failed"
    ? `the machine being viewed failed to serve ${key}: ${outcome.reason}`
    : `the machine being viewed never served ${key}`;
}

/**
 * Record the machine's decisions and hand each one to the main thread.
 *
 * The recorder keeps nothing. A live replica joins at boot and needs the log
 * from sequence 0, so one holder must keep all of it; streaming makes that
 * holder the main thread, which is where the wire is, instead of leaving a
 * second copy here for as long as the machine runs.
 *
 * Decisions are batched to the microtask that follows them. A guest can read
 * the clock many times inside one syscall burst, and each `postMessage` is a
 * structured clone on a path the guest is waiting on.
 */
function createStreamingRecorder(
  publish: (entries: readonly ReplicationLogEntry[]) => void,
): ReplicationLogRecorder {
  const recorder = new ReplicationLogRecorder(0, { retain: false });
  let batch: ReplicationLogEntry[] = [];
  recorder.onRecord((entry) => {
    batch.push(entry);
    if (batch.length > 1) return;
    queueMicrotask(() => {
      const sending = batch;
      batch = [];
      publish(sending);
    });
  });
  return recorder;
}

/**
 * Put the machine's guest clock on a streaming recorder, and hand it back.
 *
 * A machine starts streaming from two places — a caller asking it to, and a
 * checkpoint capture starting the log at the state it just read — and Node and
 * the browser have to do it identically in both.
 */
export function beginReplicationStream(
  io: { setTimeProvider(provider: TimeProvider): void },
  clock: TimeProvider,
  publish: (entries: readonly ReplicationLogEntry[]) => void,
  taps: ReplicationMachineTaps,
): ReplicationLogRecorder {
  const recorder = createStreamingRecorder(publish);
  io.setTimeProvider(
    new RecordingTimeProvider(clock, recorder, () => taps.currentGuestPid()),
  );
  taps.setGlQueryTap(glQueryRecordTap(recorder));
  taps.setAcceptSelectionTap(acceptSelectionRecordTap(recorder));
  taps.setHttpExchangeTap(httpExchangeRecordTap(recorder));
  return recorder;
}

/**
 * Follow a primary that is still running, blocking when the replica catches up.
 *
 * One queue reader behind both hands: the guest's clock read blocks on `take`,
 * and the drain that runs between guest reads pulls with `takeReady`. They must
 * share the reader because the ring has one read position — two readers would
 * each take the other's frames. Both undefined for a replay of a recording that
 * is already complete: that replica has the whole log in hand and reaching its
 * end is the end of the replay, not something to wait for.
 */
function createQueueExtenders(
  queue: SharedArrayBuffer | undefined,
): {
  extend?: ReplicationLogExtender;
  extendReady?: ReplicationLogExtender;
  extendWithin?: ReplicationLogBoundedExtender;
} {
  if (queue === undefined) return {};
  const reader = new ReplicationLogQueueReader(queue);
  return {
    extend: () => reader.take(),
    extendReady: () => reader.takeReady(),
    extendWithin: (budgetMs) => reader.takeWithin(budgetMs),
  };
}

/**
 * The log a replica is to run on, as one value both hosts' protocols carry.
 *
 * A replica is told to replay from two places — a caller asking it to, and an
 * `init` that restores a checkpoint — and both places say the same two things,
 * so they say them in the same shape.
 */
export interface ReplicationReplaySpec {
  /** The decisions the primary had already recorded when the replica joined. */
  readonly entries: readonly ReplicationLogEntry[];
  /**
   * Where the primary's later decisions arrive, for a replica following a
   * machine that is still running.
   *
   * A guest clock read reaches the kernel worker synchronously, so a replica
   * that has caught up cannot await one and cannot receive a `message`. It
   * blocks on this shared ring instead. See `log-queue.ts`. Without it the log
   * is taken as complete, and reaching its end is the end of the replay.
   */
  readonly queue?: SharedArrayBuffer;
}

/**
 * Take the machine's decisions from a primary's log instead of from this host.
 *
 * A machine starts replaying from the two places {@link ReplicationReplaySpec}
 * names, and Node and the browser have to do it identically in both, exactly as
 * they do for `beginReplicationStream`.
 *
 * The `init` place is what lets a replica join a machine whose processes are
 * already running. A restored process resumes inside `init`, so a replay
 * installed after `init` returns is installed after that process has already
 * read this computer's clock, and a replica whose first reading came from its
 * own host is not the same machine.
 */
export function beginReplicationReplay(
  io: { setTimeProvider(provider: TimeProvider): void },
  clock: TimeProvider,
  spec: ReplicationReplaySpec,
  taps: ReplicationMachineTaps,
  applyPushed?: (decision: ReplicationPushedDecision) => void,
  onDiverged?: (error: ReplicationDivergence) => void,
): ReplicationLogReader {
  const { extend, extendReady, extendWithin } = createQueueExtenders(
    spec.queue,
  );
  const reader = new ReplicationLogReader(
    spec.entries,
    applyPushed,
    extend,
    extendReady,
    onDiverged,
    extendWithin,
  );
  io.setTimeProvider(
    new ReplayingTimeProvider(clock, reader, () => taps.currentGuestPid()),
  );
  taps.setGlQueryTap(glQueryReplayTap(reader));
  taps.setAcceptSelectionTap(acceptSelectionReplayTap(reader));
  taps.setReplicationAheadProbe((pid) => reader.aheadMs(pid));
  taps.setHttpExchangeTap({ mode: "replay" });
  return reader;
}
