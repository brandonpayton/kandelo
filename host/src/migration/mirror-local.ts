/**
 * Same-origin framebuffer spectating over `BroadcastChannel`.
 *
 * The tab that owns a machine publishes its write-based `/dev/fb0` stream;
 * every other tab replays that stream into a local `FramebufferRegistry`
 * and renders it with the ordinary canvas renderer. Only pixels travel this
 * channel — ownership, input authority, and the machine itself move through
 * `LocalCheckpointHandover` alone, so a watching tab sees the game move but
 * cannot move it. A watcher announces itself and the publisher answers with
 * the binding geometry plus a full-frame snapshot, so a tab opened mid-game
 * starts from the current frame instead of a black canvas. Only write-based
 * bindings can be mirrored: an mmap-based binding has no write stream to
 * forward, and publishing one fails loudly rather than showing a stale
 * frame as live. Node's `BroadcastChannel` implements the same contract, so
 * both hosts share this transport and its tests.
 */
import type { FramebufferRegistry } from "../framebuffer/registry.js";

const LOCAL_MIRROR_CHANNEL = "kandelo-framebuffer-mirror";

type LocalMirrorMessage =
  | { readonly kind: "hello" }
  | {
      readonly kind: "bind";
      readonly pid: number;
      readonly w: number;
      readonly h: number;
      readonly stride: number;
    }
  | {
      readonly kind: "frame";
      readonly pid: number;
      readonly pixels: Uint8Array;
    }
  | {
      readonly kind: "write";
      readonly pid: number;
      readonly offset: number;
      readonly pixels: Uint8Array;
    };

export class LocalFramebufferMirror {
  readonly #channel: BroadcastChannel;

  constructor(channelName = LOCAL_MIRROR_CHANNEL) {
    this.#channel = new BroadcastChannel(channelName);
  }

  /**
   * Publish one pid's write-based framebuffer from `registry`.
   *
   * Announces the binding and a full snapshot immediately, again whenever
   * the binding (re)appears, and again for every watcher that says hello;
   * forwards each pixel write as it lands. Returns a stop function.
   */
  publish(registry: FramebufferRegistry, pid: number): () => void {
    const announce = () => {
      const binding = registry.get(pid);
      if (!binding) return;
      if (!binding.hostBuffer) {
        throw new Error(
          `pid ${pid}: only a write-based framebuffer binding can be mirrored`,
        );
      }
      this.#post({
        kind: "bind",
        pid,
        w: binding.w,
        h: binding.h,
        stride: binding.stride,
      });
      this.#post({ kind: "frame", pid, pixels: new Uint8Array(binding.hostBuffer) });
    };
    const stopChange = registry.onChange((boundPid, event) => {
      if (boundPid === pid && event === "bind") announce();
    });
    const stopWrite = registry.onWrite((writePid, offset, bytes) => {
      if (writePid !== pid) return;
      // slice() compacts the payload: a structured clone copies a view's
      // whole underlying buffer, which for forwarded worker messages can be
      // far larger than the written span.
      this.#post({ kind: "write", pid, offset, pixels: bytes.slice() });
    });
    const listener = (event: MessageEvent) => {
      const message = event.data as LocalMirrorMessage;
      if (message.kind === "hello") announce();
    };
    this.#channel.addEventListener("message", listener);
    announce();
    return () => {
      stopChange();
      stopWrite();
      this.#channel.removeEventListener("message", listener);
    };
  }

  /**
   * Replay every published stream into `registry`.
   *
   * Binds arrive as write-based bindings, snapshots and writes as
   * `fbWrite` pushes, so `registry.onChange` tells the consumer which pid
   * to render and the ordinary canvas renderer draws the rest. Says hello
   * so a running publisher answers with the current frame. Returns a stop
   * function.
   */
  watch(registry: FramebufferRegistry): () => void {
    const listener = (event: MessageEvent) => {
      const message = event.data as LocalMirrorMessage;
      if (message.kind === "bind") {
        registry.bind({
          pid: message.pid,
          addr: 0,
          len: 0,
          w: message.w,
          h: message.h,
          stride: message.stride,
          fmt: "BGRA32",
        });
        return;
      }
      if (message.kind === "frame") {
        registry.fbWrite(message.pid, 0, message.pixels);
        return;
      }
      if (message.kind === "write") {
        registry.fbWrite(message.pid, message.offset, message.pixels);
      }
    };
    this.#channel.addEventListener("message", listener);
    this.#post({ kind: "hello" });
    return () => this.#channel.removeEventListener("message", listener);
  }

  close(): void {
    this.#channel.close();
  }

  #post(message: LocalMirrorMessage): void {
    this.#channel.postMessage(message);
  }
}
