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
  /**
   * The publisher's page walked its web preview to `path`.
   *
   * Presentation, not a decision: the machine's inputs already travel as
   * `http` entries, and this names the page the publisher is looking at so a
   * viewer walks its own preview to the same place. A sink without the
   * callback ignores it — a viewer that cannot follow is stale, not
   * diverged.
   */
  navigated?(path: string): void;
  /**
   * Where the publisher's pointer is over its web preview, or null once it
   * left.
   *
   * Presentation like `navigated`: the clicks already travel as `http`
   * entries, and this is the hand a viewer watches move between them. The
   * position is a fraction of the preview surface, because the two pages
   * size their previews differently and a pixel on one names nothing on the
   * other.
   */
  cursor?(position: PreviewCursor | null): void;
  /**
   * How far the publisher scrolled its web preview.
   *
   * Presentation like `cursor`: scrolling asks the machine for nothing, so it
   * appears in no log entry, and a viewer left at the top of a page the
   * publisher already scrolled is watching a different part of it. The
   * position is a fraction of each axis's scrollable distance, because the
   * two pages size their previews differently and the same page is not as
   * tall in both.
   */
  scrolled?(position: PreviewScroll): void;
}

/**
 * How the computer holding the machine lets the other one follow it.
 *
 * "watch" is the mirror only: pixels cross the wire and nothing else. "join"
 * lets the other computer run a replica, which starts by sending it the
 * machine's whole state. That is the owner's disclosure to make, so the grant
 * is published by the machine's side and a viewer only hears it.
 */
export type ReplicationGrant = "watch" | "join";

/** A pointer position as fractions of the web preview surface, 0..1. */
export interface PreviewCursor {
  readonly x: number;
  readonly y: number;
}

/** A scroll position as fractions of the scrollable distance, 0..1. */
export interface PreviewScroll {
  readonly x: number;
  readonly y: number;
}

type LocalReplicationMessage<TMachine> =
  | { readonly kind: "hello" }
  | { readonly kind: "entries"; readonly entries: readonly ReplicationLogEntry[] }
  | { readonly kind: "navigated"; readonly path: string }
  | { readonly kind: "cursor"; readonly position: PreviewCursor | null }
  | { readonly kind: "scrolled"; readonly position: PreviewScroll }
  | { readonly kind: "miss"; readonly key: string }
  | { readonly kind: "granted"; readonly grant: ReplicationGrant }
  | { readonly kind: "ended" }
  | { readonly kind: "join"; readonly joinId: string }
  | { readonly kind: "withdrawn"; readonly joinId: string }
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
   *
   * A withdrawn join frees the machine instead of holding it. The asker that
   * withdrew is gone, so a recording claimed in its name would run for nobody
   * while every live join is refused — the machine stops it, and says it is
   * serving again so an asker still waiting re-asks.
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
      if (message.kind === "withdrawn") {
        if (message.joinId !== servingId) return;
        servingId = null;
        // A capture still in flight sees the id moved on and lets the
        // recording go when it resolves; a recording already serving stops
        // now. Either way the machine answers the next asker.
        if (serving !== null) {
          const stopping = serving;
          serving = null;
          void stopping.stop();
          this.#post({ kind: "ended" });
          this.#post({ kind: "serving" });
        }
        return;
      }
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
      // Held back until the join is answered. The recording still starts at
      // the capture instant — the entries go out, in order, right before the
      // `joined` — but a capture whose asker withdraws publishes nothing, so
      // no other watcher absorbs sequence numbers from a recording that
      // never served anyone.
      let held: ReplicationLogEntry[] | null = [];
      void capture((entries) => {
        if (held !== null) {
          held.push(...entries);
          return;
        }
        this.#post({ kind: "entries", entries });
      }).then(
        (joined) => {
          capturing = false;
          if (joined === null) {
            if (servingId !== message.joinId) return;
            servingId = null;
            refuse(message.joinId, "this machine cannot be read right now");
            return;
          }
          if (servingId !== message.joinId) {
            // The asker withdrew while the machine was being read.
            void joined.stop();
            this.#post({ kind: "serving" });
            return;
          }
          serving = joined;
          // After the recorder is running, so nothing the machine decides
          // between the read and this message is lost: the replica is already
          // watching entries by the time it asks.
          const releasing = held;
          held = null;
          if (releasing !== null && releasing.length > 0) {
            this.#post({ kind: "entries", entries: releasing });
          }
          this.#post({
            kind: "joined",
            joinId: message.joinId,
            machine: joined.machine,
          });
        },
        (error: unknown) => {
          capturing = false;
          if (servingId !== message.joinId) return;
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
   *
   * `signal` withdraws the question. The asker re-asks whenever a machine
   * starts answering, so a join outlives the moment it was posted — and an
   * abandoned attempt that cannot withdraw goes on competing with the live
   * one, wins the machine's single recording, and leaves it replicating for
   * nobody while every real join is refused.
   *
   * The signal outlives the answer for the same reason. Once the machine said
   * `joined` it is recording for this asker, and an asker that lets its
   * replica go — the person chose the mirror, the role ended — has to free
   * that recording or every later join is refused. Aborting after the answer
   * posts the same withdrawal, so the attempt's one signal is the whole
   * story: abort it, and the machine serves the next asker whether the answer
   * had arrived or not.
   */
  join(timeoutMs: number, signal?: AbortSignal): Promise<TMachine> {
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
      const abort = () => {
        finish();
        // On the wire as well as here: the question already posted may reach
        // the machine after this, and a machine that never hears the
        // withdrawal records for an asker that is gone.
        this.#post({ kind: "withdrawn", joinId });
        reject(new Error("the request to replicate the machine was withdrawn"));
      };
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
        // Everything but the abort hook. The machine is recording for this
        // asker now, and the hook is how letting the replica go reaches it.
        clearTimeout(timer);
        this.#channel.removeEventListener("message", listener);
        resolve(message.machine);
      };
      const finish = () => {
        clearTimeout(timer);
        this.#channel.removeEventListener("message", listener);
        signal?.removeEventListener("abort", abort);
      };
      if (signal?.aborted) {
        clearTimeout(timer);
        reject(new Error("the request to replicate the machine was withdrawn"));
        return;
      }
      signal?.addEventListener("abort", abort);
      this.#channel.addEventListener("message", listener);
      this.#post({ kind: "join", joinId });
    });
  }

  /**
   * Tell every watcher which page this machine's web preview is on.
   *
   * Sent by the publisher whenever its preview navigates, and once when the
   * recording starts, so a viewer that joined mid-session still learns where
   * the user is.
   */
  publishNavigation(path: string): void {
    this.#post({ kind: "navigated", path });
  }

  /**
   * Tell every watcher where this machine's pointer is over its web preview.
   *
   * Sent by the publisher as its pointer moves, and with null when it leaves
   * the preview, so a viewer stops drawing a hand that is no longer there.
   */
  publishCursor(position: PreviewCursor | null): void {
    this.#post({ kind: "cursor", position });
  }

  /**
   * Tell every watcher how far this machine's web preview is scrolled.
   *
   * Sent by the publisher as it scrolls, and once when a page settles, so a
   * viewer that joined mid-page is looking at the part the publisher is.
   */
  publishScroll(position: PreviewScroll): void {
    this.#post({ kind: "scrolled", position });
  }

  /**
   * Tell the publisher its log has no replay of `key`, a request line this
   * watcher's page asked its replica for.
   *
   * The publisher's browser served it from cache, or served it before this
   * replica joined; either way the publisher can still make the request, and
   * once it does, the log carries it to every replica.
   */
  reportMiss(key: string): void {
    this.#post({ kind: "miss", key });
  }

  /**
   * Publish how this machine may be followed.
   *
   * Posted immediately, on every change, and again for every watcher that
   * says hello — the grant is what parks a viewer's join loop, and a viewer
   * that never heard it would ask a machine that does not serve joins and
   * wait out its whole timeout instead. Returns the grant's controls: `set`
   * to change it, `stop` when this computer no longer holds the machine.
   */
  publishGrant(initial: ReplicationGrant): {
    set: (grant: ReplicationGrant) => void;
    stop: () => void;
  } {
    let grant = initial;
    const post = () => this.#post({ kind: "granted", grant });
    const listener = (event: MessageEvent) => {
      const message = event.data as LocalReplicationMessage<TMachine>;
      if (message.kind === "hello") post();
    };
    this.#channel.addEventListener("message", listener);
    post();
    return {
      set: (next) => {
        if (next === grant) return;
        grant = next;
        post();
      },
      stop: () => this.#channel.removeEventListener("message", listener),
    };
  }

  /**
   * Hear how the machine on this channel may be followed. Returns an
   * unsubscribe.
   */
  onGrant(handler: (grant: ReplicationGrant) => void): () => void {
    const listener = (event: MessageEvent) => {
      const message = event.data as LocalReplicationMessage<TMachine>;
      if (message.kind === "granted") handler(message.grant);
    };
    this.#channel.addEventListener("message", listener);
    return () => this.#channel.removeEventListener("message", listener);
  }

  /**
   * Serve the request lines watchers report missing. Returns an unsubscribe.
   */
  onMiss(handler: (key: string) => void): () => void {
    const listener = (event: MessageEvent) => {
      const message = event.data as LocalReplicationMessage<TMachine>;
      if (message.kind === "miss") handler(message.key);
    };
    this.#channel.addEventListener("message", listener);
    return () => this.#channel.removeEventListener("message", listener);
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
      if (message.kind === "navigated") {
        sink.navigated?.(message.path);
        return;
      }
      if (message.kind === "cursor") {
        sink.cursor?.(message.position);
        return;
      }
      if (message.kind === "scrolled") {
        sink.scrolled?.(message.position);
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
