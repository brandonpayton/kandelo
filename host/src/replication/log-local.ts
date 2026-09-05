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
 * A replica can also join a machine that is already running, and that join
 * starts here too: the replica asks, and the answer is the machine's state
 * together with the first decision it made after that state was read. Which
 * makes this channel the whole join — state and log — rather than the log
 * alone. See § "How a replica joins a machine that is already running".
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

type LocalReplicationMessage<TMachine> =
  | { readonly kind: "hello" }
  | { readonly kind: "entries"; readonly entries: readonly ReplicationLogEntry[] }
  | { readonly kind: "ended" }
  | { readonly kind: "join"; readonly joinId: string }
  | { readonly kind: "serving" }
  | {
      readonly kind: "joined";
      readonly joinId: string;
      readonly machine: TMachine;
    }
  | {
      readonly kind: "refused";
      readonly joinId: string;
      readonly reason: string;
    };

/**
 * `TMachine` is the state a replica starts from, and this class never reads
 * inside it: the channel structured-clones whatever it is given. What travels
 * is the same value a handover moves, because a replica and a taker both need
 * an image to restore into and processes to restore — the difference is that
 * the machine keeps running here.
 */
export class LocalReplicationLog<TMachine = never> {
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
      const message = event.data as LocalReplicationMessage<TMachine>;
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
   * Answer a replica that asks to join this machine while it is running.
   *
   * `capture` reads the machine and starts its recording at that one instant —
   * it is a single operation for that reason, and this class does not split it
   * into a read and a start. Everything the machine then decides goes to the
   * `publish` it is handed, and out on this channel to the replica.
   *
   * `capture` returns null to refuse, and the asker hears the refusal instead
   * of waiting out its timeout. Returns a stop function, which stops the
   * recording and tells the replica it ended.
   *
   * One machine records for one replica. A second join arriving while a
   * recording is live is refused rather than restarting the log, because a
   * restart would begin a new sequence 0 under a replica that is midway
   * through the old one.
   */
  serve(
    capture: (
      publish: (entries: readonly ReplicationLogEntry[]) => void,
    ) => Promise<{ machine: TMachine; stop: () => Promise<void> } | null>,
  ): () => void {
    let serving: { stop: () => Promise<void> } | null = null;
    let capturing = false;
    let servingId: string | null = null;
    const refuse = (joinId: string, reason: string) => {
      this.#post({ kind: "refused", joinId, reason });
    };
    const listener = (event: MessageEvent) => {
      const message = event.data as LocalReplicationMessage<TMachine>;
      if (message.kind !== "join") return;
      // One asker asks more than once: it repeats the question when it hears
      // this machine start answering, because it cannot tell whether the first
      // one arrived before there was anything listening. A repeat is the same
      // join, not a second replica.
      if (message.joinId === servingId) return;
      if (serving !== null || capturing) {
        refuse(message.joinId, "this machine is already being replicated");
        return;
      }
      capturing = true;
      servingId = message.joinId;
      void capture((entries) => this.#post({ kind: "entries", entries })).then(
        (joined) => {
          capturing = false;
          if (joined === null) {
            servingId = null;
            refuse(message.joinId, "this machine cannot be read right now");
            return;
          }
          serving = joined;
          // After the recorder is running, so nothing the machine decides
          // between the read and this message is lost: the replica is already
          // watching entries by the time it asks.
          this.#post({
            kind: "joined",
            joinId: message.joinId,
            machine: joined.machine,
          });
        },
        (error: unknown) => {
          capturing = false;
          servingId = null;
          refuse(
            message.joinId,
            error instanceof Error ? error.message : String(error),
          );
        },
      );
    };
    this.#channel.addEventListener("message", listener);
    // Says a machine is here now. Which computer holds the machine changes —
    // a take-over swaps the two — so a replica can be waiting before the
    // machine it is waiting for starts answering, and a single unanswered
    // question would leave it waiting out its whole timeout.
    this.#post({ kind: "serving" });
    return () => {
      this.#channel.removeEventListener("message", listener);
      const stopping = serving;
      serving = null;
      servingId = null;
      if (stopping === null) return;
      void stopping.stop();
      this.#post({ kind: "ended" });
    };
  }

  /**
   * Ask the machine on this channel for the state to start replicating from.
   *
   * Call {@link watch} first. The publisher starts recording inside the read
   * and sends entries from that instant, so a replica that asks before it is
   * watching would miss the decisions its own state does not yet cover.
   */
  join(timeoutMs: number): Promise<TMachine> {
    const joinId = crypto.randomUUID();
    return new Promise<TMachine>((resolve, reject) => {
      const timer = setTimeout(() => {
        finish();
        reject(
          new Error(
            `no machine answered the request to replicate it within `
              + `${timeoutMs} ms`,
          ),
        );
      }, timeoutMs);
      const listener = (event: MessageEvent) => {
        const message = event.data as LocalReplicationMessage<TMachine>;
        // A machine that started answering after the question was asked never
        // heard it. Ask again rather than wait for a reply to a message that
        // reached nobody.
        if (message.kind === "serving") {
          this.#post({ kind: "join", joinId });
          return;
        }
        if (message.kind === "refused" && message.joinId === joinId) {
          finish();
          reject(new Error(`the machine refused to be replicated: ${message.reason}`));
          return;
        }
        if (message.kind !== "joined" || message.joinId !== joinId) return;
        finish();
        resolve(message.machine);
      };
      const finish = () => {
        clearTimeout(timer);
        this.#channel.removeEventListener("message", listener);
      };
      this.#channel.addEventListener("message", listener);
      this.#post({ kind: "join", joinId });
    });
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
      const message = event.data as LocalReplicationMessage<TMachine>;
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

  #post(message: LocalReplicationMessage<TMachine>): void {
    this.#channel.postMessage(message);
  }
}
