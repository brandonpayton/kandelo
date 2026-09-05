/**
 * The decision log on a wire.
 *
 * A replica runs the machine itself and needs the values the primary's host
 * produced. This module carries them: the computer holding the machine
 * publishes its log, and every replica takes the entries in order and feeds
 * them to its own `ReplicationLogReader`.
 *
 * Nothing here is droppable. A framebuffer mirror skips frames when the wire
 * backs up, because a watcher would rather see the current frame than an old
 * one. A missing decision is not a late frame — it is a replica that quietly
 * stopped being the same machine — so a congested wire costs delay and never
 * entries. The channel is expected to queue, which is why the peer link gives
 * this label the handover's deep-queue defaults rather than the mirror's
 * shallow ones.
 *
 * A replica joins at boot and replays from the machine's first decision, so a
 * publisher sends its whole log to a watcher that says hello and streams from
 * there. The recorder therefore keeps every entry; see
 * `docs/plans/2026-08-23-state-machine-replication-design.md`
 * § "How a replica joins a GL machine".
 *
 * The protocol is channel-agnostic in the same way the migration transports
 * are: the default is a same-origin `BroadcastChannel`, and any injected
 * `MessageChannelLike` carries the same messages to a remote peer.
 */
import type { MessageChannelLike } from "../migration/channel.js";
import type { ReplicationLogEntry } from "./log.js";
import { ReplicationDivergence } from "./log.js";

const LOCAL_REPLICATION_CHANNEL = "kandelo-replication-log";

/** One running recording a publisher can read and follow. */
export interface ReplicationLogSource {
  /** Every entry recorded so far, in order. */
  readonly entries: readonly ReplicationLogEntry[];
  /** Watch entries as they are recorded. Returns an unsubscribe. */
  onRecord(listener: (entry: ReplicationLogEntry) => void): () => void;
}

/** One replica's view of the primary's log. */
export interface ReplicationLogSink {
  /** Take entries the primary recorded, in the order it recorded them. */
  entries(entries: readonly ReplicationLogEntry[]): void;
  /**
   * The publisher stopped recording.
   *
   * A machine that is no longer recording is no longer replicable from this
   * point on, and a replica must be told so rather than waiting on a log that
   * will not continue.
   */
  ended(): void;
  /**
   * The log arrived with a hole or out of order.
   *
   * The channel is ordered and reliable, so this is a defect in the transport
   * or in the publisher rather than an expected condition. It reaches the sink
   * because a listener that threw would report it nowhere a replica can act
   * on.
   */
  diverged(error: ReplicationDivergence): void;
}

type LocalReplicationMessage =
  | { readonly kind: "hello" }
  | { readonly kind: "entries"; readonly entries: readonly ReplicationLogEntry[] }
  | { readonly kind: "ended" };

export class LocalReplicationLog {
  readonly #channel: MessageChannelLike;

  constructor(channel: string | MessageChannelLike = LOCAL_REPLICATION_CHANNEL) {
    this.#channel =
      typeof channel === "string" ? new BroadcastChannel(channel) : channel;
  }

  /**
   * Publish one running recording.
   *
   * Sends the log so far immediately and again for every watcher that says
   * hello, then one message per recorded entry. Returns a stop function, which
   * tells watchers the recording ended.
   */
  publish(source: ReplicationLogSource): () => void {
    const backlog = () => {
      if (source.entries.length === 0) return;
      this.#post({ kind: "entries", entries: [...source.entries] });
    };
    const stopRecord = source.onRecord((entry) => {
      this.#post({ kind: "entries", entries: [entry] });
    });
    const listener = (event: MessageEvent) => {
      const message = event.data as LocalReplicationMessage;
      if (message.kind === "hello") backlog();
    };
    this.#channel.addEventListener("message", listener);
    backlog();
    return () => {
      stopRecord();
      this.#channel.removeEventListener("message", listener);
      this.#post({ kind: "ended" });
    };
  }

  /**
   * Deliver the published log into `sink`, in order and without a hole.
   *
   * Says hello so a running publisher answers with what it has. A watcher that
   * joins twice, or that misses a message, would otherwise hand its replica a
   * log that skips or repeats a decision, so an entry that does not continue
   * the sequence is reported as divergence rather than passed on. Returns a
   * stop function.
   */
  watch(sink: ReplicationLogSink): () => void {
    let nextSeq = -1;
    const listener = (event: MessageEvent) => {
      const message = event.data as LocalReplicationMessage;
      if (message.kind === "ended") {
        sink.ended();
        return;
      }
      if (message.kind !== "entries") return;
      const fresh = message.entries.filter((entry) => entry.seq >= nextSeq);
      if (fresh.length === 0) return;
      const first = nextSeq < 0 ? fresh[0]!.seq : nextSeq;
      for (const [offset, entry] of fresh.entries()) {
        if (entry.seq === first + offset) continue;
        sink.diverged(
          new ReplicationDivergence(
            entry.seq,
            `the log jumped to ${entry.seq} where ${first + offset} was next`,
          ),
        );
        return;
      }
      nextSeq = fresh[fresh.length - 1]!.seq + 1;
      sink.entries(fresh);
    };
    this.#channel.addEventListener("message", listener);
    this.#post({ kind: "hello" });
    return () => this.#channel.removeEventListener("message", listener);
  }

  close(): void {
    this.#channel.close();
  }

  #post(message: LocalReplicationMessage): void {
    this.#channel.postMessage(message);
  }
}
