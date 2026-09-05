/**
 * The kernel worker's half of replication.
 *
 * Both worker entries own the same two jobs — publish the decisions a primary
 * makes, and take the decisions a replica follows — and the host runtime
 * contract says Node and the browser are peers. Keeping the two shapes here
 * is what stops one host from batching, waiting, or ending differently from
 * the other.
 */
import type { TimeProvider } from "../vfs/types.js";
import {
  ReplicationLogReader,
  ReplicationLogRecorder,
  type ReplicationLogEntry,
  type ReplicationLogExtender,
  type ReplicationPushedDecision,
} from "./log.js";
import { RecordingTimeProvider, ReplayingTimeProvider } from "./clock.js";
import { ReplicationLogQueueReader } from "./log-queue.js";

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
): ReplicationLogRecorder {
  const recorder = createStreamingRecorder(publish);
  io.setTimeProvider(new RecordingTimeProvider(clock, recorder));
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
): { extend?: ReplicationLogExtender; extendReady?: ReplicationLogExtender } {
  if (queue === undefined) return {};
  const reader = new ReplicationLogQueueReader(queue);
  return {
    extend: () => reader.take(),
    extendReady: () => reader.takeReady(),
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
  applyPushed?: (decision: ReplicationPushedDecision) => void,
): ReplicationLogReader {
  const { extend, extendReady } = createQueueExtenders(spec.queue);
  const reader = new ReplicationLogReader(
    spec.entries,
    applyPushed,
    extend,
    extendReady,
  );
  io.setTimeProvider(new ReplayingTimeProvider(clock, reader));
  return reader;
}
