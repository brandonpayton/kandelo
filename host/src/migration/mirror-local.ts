/**
 * Same-origin framebuffer spectating over `BroadcastChannel`.
 *
 * The tab that owns a machine publishes its write-based `/dev/fb0` stream;
 * every other tab replays that stream into a local `FramebufferRegistry`
 * and renders it with the ordinary canvas renderer. Only pixels travel this
 * channel — ownership, input authority, and the machine itself move through
 * `LocalCheckpointHandover` alone, so a watching tab sees the game move but
 * cannot move it. A watcher announces itself and the publisher answers with
 * one message carrying the binding geometry and a full frame together, so a
 * tab opened mid-game starts from the current frame and a resynchronising
 * one never shows an empty binding. Only write-based
 * bindings can be mirrored: an mmap-based binding has no write stream to
 * forward, and publishing one fails loudly rather than showing a stale
 * frame as live. Node's `BroadcastChannel` implements the same contract, so
 * both hosts share this transport and its tests.
 *
 * The protocol is channel-agnostic: the default is a same-origin
 * `BroadcastChannel`, and any injected `MessageChannelLike` — a chunked
 * network channel — carries the same messages to a remote peer. On a
 * congestible channel the publisher skips pixel writes while the channel is
 * backed up and resynchronises watchers with a fresh announce on drain, so
 * a slow wire shows a late frame, never an unbounded queue.
 */
import {
  channelCongestion,
  type MessageChannelLike,
} from "./channel.js";
import type { FramebufferRegistry } from "../framebuffer/registry.js";

const LOCAL_MIRROR_CHANNEL = "kandelo-framebuffer-mirror";

/**
 * The read side of a `/dev/fb0` registry a publisher needs.
 *
 * `FramebufferRegistry` satisfies it, and so does a host that re-exposes the
 * live registry for sharing. Naming the read side keeps a publisher from
 * holding a handle that could rebind the machine's framebuffer.
 */
export interface MirrorSource {
  get(pid: number): {
    readonly w: number;
    readonly h: number;
    readonly stride: number;
    readonly hostBuffer: Uint8ClampedArray | null;
  } | undefined;
  onChange(fn: (pid: number, ev: "bind" | "unbind") => void): () => void;
  onWrite(fn: (pid: number, offset: number, bytes: Uint8Array) => void): () => void;
}

type LocalMirrorMessage =
  | { readonly kind: "hello" }
  | {
      readonly kind: "bind";
      readonly pid: number;
      readonly w: number;
      readonly h: number;
      readonly stride: number;
      readonly pixels: Uint8Array;
    }
  | {
      readonly kind: "write";
      readonly pid: number;
      readonly offset: number;
      readonly pixels: Uint8Array;
    }
  /**
   * The publisher stopped sending this screen.
   *
   * Either the process gave `/dev/fb0` up, or the person holding the machine
   * turned to its other surface or gave the machine away. A machine publishes
   * the one surface its holder is presenting, and a watcher cannot read that
   * from the pixels stopping: a still screen sends no writes either.
   */
  | { readonly kind: "unbind"; readonly pid: number };

export class LocalFramebufferMirror {
  readonly #channel: MessageChannelLike;

  constructor(channel: string | MessageChannelLike = LOCAL_MIRROR_CHANNEL) {
    this.#channel =
      typeof channel === "string" ? new BroadcastChannel(channel) : channel;
  }

  /**
   * Publish one pid's write-based framebuffer from `registry`.
   *
   * Announces the binding and a full snapshot immediately, again whenever
   * the binding (re)appears, and again for every watcher that says hello;
   * forwards each pixel write as it lands. Returns a stop function.
   */
  publish(registry: MirrorSource, pid: number): () => void {
    const announce = () => {
      const binding = registry.get(pid);
      if (!binding) return;
      if (!binding.hostBuffer) {
        throw new Error(
          `pid ${pid}: only a write-based framebuffer binding can be mirrored`,
        );
      }
      // Geometry and pixels travel as one message. Sent apart, the watcher
      // holds a bound-but-empty framebuffer for as long as the wire takes to
      // deliver the second one, and renders that emptiness.
      this.#post({
        kind: "bind",
        pid,
        w: binding.w,
        h: binding.h,
        stride: binding.stride,
        pixels: new Uint8Array(binding.hostBuffer),
      });
    };
    const stopChange = registry.onChange((boundPid, event) => {
      if (boundPid !== pid) return;
      if (event === "bind") announce();
      else this.#post({ kind: "unbind", pid });
    });
    const congestion = channelCongestion(this.#channel);
    let starved = false;
    const stopWrite = registry.onWrite((writePid, offset, bytes) => {
      if (writePid !== pid) return;
      if (congestion?.congested()) {
        starved = true;
        return;
      }
      // slice() compacts the payload: a structured clone copies a view's
      // whole underlying buffer, which for forwarded worker messages can be
      // far larger than the written span.
      this.#post({ kind: "write", pid, offset, pixels: bytes.slice() });
    });
    const stopDrain = congestion?.onDrain(() => {
      if (!starved) return;
      starved = false;
      announce();
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
      stopDrain?.();
      this.#channel.removeEventListener("message", listener);
      this.#post({ kind: "unbind", pid });
    };
  }

  /**
   * Replay every published stream into `registry`.
   *
   * A new geometry arrives as a write-based binding, every frame and write
   * as an `fbWrite` push, so `registry.onChange` tells the consumer which
   * pid to render and the ordinary canvas renderer draws the rest. Says
   * hello so a running publisher answers with the current frame. Returns a
   * stop function.
   */
  watch(registry: FramebufferRegistry): () => void {
    const listener = (event: MessageEvent) => {
      const message = event.data as LocalMirrorMessage;
      if (message.kind === "bind") {
        // Only a real geometry change rebinds. `bind` installs a fresh zeroed
        // buffer and reports a "bind" change, which makes a renderer detach
        // and re-attach onto black; a publisher re-announces on every drain,
        // so rebinding each time is a blink for as long as the wire is slow.
        const current = registry.get(message.pid);
        if (
          !current
          || !current.hostBuffer
          || current.w !== message.w
          || current.h !== message.h
          || current.stride !== message.stride
        ) {
          registry.bind({
            pid: message.pid,
            addr: 0,
            len: 0,
            w: message.w,
            h: message.h,
            stride: message.stride,
            fmt: "BGRA32",
          });
        }
        registry.fbWrite(message.pid, 0, message.pixels);
        return;
      }
      if (message.kind === "write") {
        registry.fbWrite(message.pid, message.offset, message.pixels);
        return;
      }
      if (message.kind === "unbind") {
        registry.unbind(message.pid);
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
