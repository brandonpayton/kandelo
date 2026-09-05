/**
 * Same-origin checkpoint handover over `BroadcastChannel`.
 *
 * T2.4's transport: two tabs of one origin, no signalling server and no
 * lease. A taker broadcasts a request; a keeper answers it with the whole
 * checkpoint. `BroadcastChannel` structured-clones its payload — nothing can
 * be transferred across tabs — so a handover copies the checkpoint once into
 * the channel. Node's `BroadcastChannel` implements the same contract, so
 * both hosts share this transport and its tests.
 */
import type { MachineCheckpoint } from "./checkpoint";

const LOCAL_HANDOVER_CHANNEL = "kandelo-checkpoint-handover";

type LocalHandoverMessage =
  | { readonly kind: "take"; readonly takeId: string }
  | {
      readonly kind: "checkpoint";
      readonly takeId: string;
      readonly checkpoint: MachineCheckpoint;
    }
  | { readonly kind: "refused"; readonly takeId: string; readonly reason: string };

export class LocalCheckpointHandover {
  readonly #channel: BroadcastChannel;

  constructor(channelName = LOCAL_HANDOVER_CHANNEL) {
    this.#channel = new BroadcastChannel(channelName);
  }

  /**
   * Answer every take request with a fresh capture of this machine.
   *
   * `capture` returns null to refuse — the taker hears the refusal instead
   * of waiting out its timeout. `onSent` fires after a checkpoint went out;
   * a T2.4 keeper stops its machine there. Returns a stop function.
   */
  offer(
    capture: () => Promise<MachineCheckpoint | null>,
    onSent?: () => void,
  ): () => void {
    const listener = (event: MessageEvent) => {
      const message = event.data as LocalHandoverMessage;
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
    return () => this.#channel.removeEventListener("message", listener);
  }

  /**
   * Ask any offering keeper for its machine.
   *
   * Resolves with the first checkpoint answering this request, rejects on a
   * keeper's refusal, and rejects after `timeoutMs` when no keeper answers —
   * a silent handover failure would look identical to a slow one.
   */
  take(timeoutMs: number): Promise<MachineCheckpoint> {
    const takeId = crypto.randomUUID();
    return new Promise<MachineCheckpoint>((resolve, reject) => {
      const timer = setTimeout(() => {
        finish();
        reject(
          new Error(`no keeper answered the handover within ${timeoutMs} ms`),
        );
      }, timeoutMs);
      const listener = (event: MessageEvent) => {
        const message = event.data as LocalHandoverMessage;
        if (message.kind === "take" || message.takeId !== takeId) return;
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

  #post(message: LocalHandoverMessage): void {
    this.#channel.postMessage(message);
  }
}
