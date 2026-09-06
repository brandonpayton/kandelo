/**
 * Same-origin checkpoint handover over `BroadcastChannel`.
 *
 * T2.4's transport: two tabs of one origin, no signalling server and no
 * lease. A taker broadcasts a request; a keeper answers it with the whole
 * checkpoint. `BroadcastChannel` structured-clones its payload — nothing can
 * be transferred across tabs — so a handover copies the checkpoint once into
 * the channel. Node's `BroadcastChannel` implements the same contract, so
 * both hosts share this transport and its tests.
 *
 * The protocol is channel-agnostic: the default is a same-origin
 * `BroadcastChannel`, and any injected `MessageChannelLike` — a chunked
 * network channel — carries the same messages to a remote peer.
 *
 * The same protocol says which side holds the machine. Exactly one computer
 * runs it and only that computer can type into it, so both sides have to know
 * which one they are, and the answer moves with the machine: after a handover
 * the keeper is a viewer and the taker can be taken from in turn.
 */
import type { MessageChannelLike } from "./channel.js";
import type { MachineCheckpoint } from "./checkpoint";

const LOCAL_HANDOVER_CHANNEL = "kandelo-checkpoint-handover";

type LocalHandoverMessage<TMachine, TOffer> =
  | { readonly kind: "take"; readonly takeId: string }
  | {
      readonly kind: "checkpoint";
      readonly takeId: string;
      readonly checkpoint: TMachine;
    }
  | { readonly kind: "refused"; readonly takeId: string; readonly reason: string }
  | { readonly kind: "who" }
  | {
      readonly kind: "keeper";
      readonly holding: boolean;
      readonly offered: TOffer | null;
    };

/**
 * `TMachine` is what one handover moves, and this transport never reads
 * inside it: both channels structured-clone whatever they are given. Two
 * peers that already agree on one image move a bare {@link MachineCheckpoint},
 * which is the default. Peers that do not agree — a viewer holding no image
 * of its own — move the checkpoint together with the boot descriptor that
 * names the keeper's image, and that pairing belongs to the layer which knows
 * both schemas rather than here.
 *
 * `TOffer` is what a keeper says about the machine before anyone asks for it,
 * and this transport does not read inside that either. It exists because the
 * expensive part of taking a machine is not moving it: a viewer holds no image
 * of its own, so it has to load the keeper's before the checkpoint it receives
 * has anywhere to go. Told early which image that is, it can have it ready.
 */
export class LocalCheckpointHandover<
  TMachine = MachineCheckpoint,
  TOffer = never,
> {
  readonly #channel: MessageChannelLike;

  constructor(channel: string | MessageChannelLike = LOCAL_HANDOVER_CHANNEL) {
    this.#channel =
      typeof channel === "string" ? new BroadcastChannel(channel) : channel;
  }

  /**
   * Answer every take request with a fresh capture of this machine.
   *
   * `capture` returns null to refuse — the taker hears the refusal instead
   * of waiting out its timeout. `onSent` fires after a checkpoint went out;
   * a T2.4 keeper stops its machine there. Returns a stop function.
   *
   * Offering is also how a computer says it holds a machine. It announces
   * that on start and on every probe, and withdraws it when it stops, so the
   * other side can offer a take only when there is a machine to take. The
   * announcement is part of offering rather than a separate call because the
   * two are the same fact: a computer that answers takes is the one holding
   * the machine.
   *
   * `describe` puts something in that announcement — what the machine is, as
   * against the machine itself. A viewer that knows early what image the
   * keeper runs can load it before it ever asks for the machine, which is the
   * slow half of taking one. It is read on every announcement rather than
   * once, so a keeper that switches demos announces the one it is running now.
   */
  offer(
    capture: () => Promise<TMachine | null>,
    onSent?: () => void,
    describe?: () => TOffer | null,
  ): () => void {
    const announce = () => {
      this.#post({
        kind: "keeper",
        holding: true,
        offered: describe?.() ?? null,
      });
    };
    const listener = (event: MessageEvent) => {
      const message = event.data as LocalHandoverMessage<TMachine, TOffer>;
      if (message.kind === "who") {
        announce();
        return;
      }
      if (message.kind !== "take") return;
      void capture().then(
        (checkpoint) => {
          if (checkpoint === null) {
            this.#post({
              kind: "refused",
              takeId: message.takeId,
              reason: "the keeper has no machine to hand over",
            });
            return;
          }
          this.#post({
            kind: "checkpoint",
            takeId: message.takeId,
            checkpoint,
          });
          onSent?.();
        },
        (error: unknown) => {
          this.#post({
            kind: "refused",
            takeId: message.takeId,
            reason: error instanceof Error ? error.message : String(error),
          });
        },
      );
    };
    this.#channel.addEventListener("message", listener);
    announce();
    return () => {
      this.#channel.removeEventListener("message", listener);
      this.#post({ kind: "keeper", holding: false, offered: null });
    };
  }

  /**
   * Follow whether the other side holds a machine, and what it says it is.
   *
   * Probes once so a keeper that started first still answers, then tracks the
   * announcements `offer` makes. Starts at false: a computer that has said
   * nothing is not one to take a machine from. `offered` is whatever the
   * keeper's `describe` returned, and null when it gave none — it comes from
   * another computer, so the layer that understands it is the layer that must
   * check it. Returns a stop function.
   */
  watchKeeper(
    onKeeper: (holding: boolean, offered: TOffer | null) => void,
  ): () => void {
    const listener = (event: MessageEvent) => {
      const message = event.data as LocalHandoverMessage<TMachine, TOffer>;
      if (message.kind !== "keeper") return;
      onKeeper(message.holding, message.offered);
    };
    this.#channel.addEventListener("message", listener);
    this.#post({ kind: "who" });
    return () => this.#channel.removeEventListener("message", listener);
  }

  /**
   * Ask any offering keeper for its machine.
   *
   * Resolves with the first checkpoint answering this request, rejects on a
   * keeper's refusal, and rejects after `timeoutMs` when no keeper answers —
   * a silent handover failure would look identical to a slow one.
   */
  take(timeoutMs: number): Promise<TMachine> {
    const takeId = crypto.randomUUID();
    return new Promise<TMachine>((resolve, reject) => {
      const timer = setTimeout(() => {
        finish();
        reject(
          new Error(`no keeper answered the handover within ${timeoutMs} ms`),
        );
      }, timeoutMs);
      const listener = (event: MessageEvent) => {
        const message = event.data as LocalHandoverMessage<TMachine, TOffer>;
        if (message.kind !== "checkpoint" && message.kind !== "refused") return;
        if (message.takeId !== takeId) return;
        finish();
        if (message.kind === "refused") {
          reject(new Error(`the keeper refused the handover: ${message.reason}`));
          return;
        }
        resolve(message.checkpoint);
      };
      const finish = () => {
        clearTimeout(timer);
        this.#channel.removeEventListener("message", listener);
      };
      this.#channel.addEventListener("message", listener);
      this.#post({ kind: "take", takeId });
    });
  }

  close(): void {
    this.#channel.close();
  }

  #post(message: LocalHandoverMessage<TMachine, TOffer>): void {
    this.#channel.postMessage(message);
  }
}
