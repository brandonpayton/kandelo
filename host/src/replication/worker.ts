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
export function glQueryReplayTap(reader: ReplicationLogReader): GlQueryTap {
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
export function acceptSelectionReplayTap(
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
  readonly #waiters = new Map<
    string,
    Array<(response: Response | null) => void>
  >();
  readonly #waitMs: number;

  constructor(waitMs = 30_000) {
    this.#waitMs = waitMs;
  }

  deliver(key: string, response: Response): void {
    this.#responses.set(key, response);
    const waiters = this.#waiters.get(key);
    if (!waiters) return;
    this.#waiters.delete(key);
    for (const waiter of waiters) waiter(response);
  }

  /**
   * The response the primary's browsing produced for this request, waiting
   * for the replay to compute it when the viewer's page asks first.
   *
   * Resolves null for a request the primary never made — a cache asymmetry
   * between the two browsers, not a divergence: the machine never saw either
   * copy of it.
   */
  take(key: string): Promise<Response | null> {
    const ready = this.#responses.get(key);
    if (ready !== undefined) return Promise.resolve(ready);
    return new Promise((resolve) => {
      const waiters = this.#waiters.get(key) ?? [];
      waiters.push(resolve);
      this.#waiters.set(key, waiters);
      setTimeout(() => {
        const parked = this.#waiters.get(key);
        if (!parked) return;
        const index = parked.indexOf(resolve);
        if (index < 0) return;
        parked.splice(index, 1);
        if (parked.length === 0) this.#waiters.delete(key);
        resolve(null);
      }, this.#waitMs);
    });
  }

  drop(): void {
    this.#responses.clear();
    for (const waiters of this.#waiters.values()) {
      for (const waiter of waiters) waiter(null);
    }
    this.#waiters.clear();
  }
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
