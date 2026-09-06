/**
 * Terminal sharing over `BroadcastChannel`.
 *
 * The tab that holds a machine publishes one PTY's output stream; every
 * watcher replays it into its own emulator and renders text locally. A
 * watcher that joins late is sent the recent output as one reset, so it
 * starts from the current screen rather than from the next keystroke.
 *
 * Output only, in one direction. Two people typing into one shell interleave
 * their keystrokes inside a single line of input, and neither can tell which
 * characters are theirs, so a watcher watches and the computer holding the
 * machine keeps the keyboard. Typing moves the way the machine does: the
 * watcher takes the machine over, and then it is the one holding the keyboard.
 * See `LocalCheckpointHandover` in `transport-local.ts`.
 *
 * What crosses here is text, not pixels: bytes are proportional to what the
 * machine printed rather than to screen area and frame rate, and the far
 * side renders them sharp at any distance. That is why this is the transport
 * a terminal machine should be shared with.
 *
 * The protocol is channel-agnostic: the default is a same-origin
 * `BroadcastChannel`, and any injected `MessageChannelLike` — a chunked
 * network channel — carries the same messages to a remote peer. On a
 * congestible channel the publisher stops forwarding output while the
 * channel is backed up and resynchronises watchers with a full reset on
 * drain, so a slow wire costs scrollback, never correctness of the screen.
 */
import {
  channelCongestion,
  type MessageChannelLike,
} from "./channel.js";

const LOCAL_TERMINAL_CHANNEL = "kandelo-terminal-mirror";

/**
 * How much output a publisher keeps to seed a joining or resynchronising
 * watcher. Beyond this, scrollback is not replayed; the visible screen still
 * is, because a terminal's screen is a suffix of its output.
 */
const REPLAY_BYTES = 128 * 1024;

export interface TerminalSize {
  readonly cols: number;
  readonly rows: number;
}

/** One live PTY a publisher can read and measure. */
export interface TerminalSource {
  /** Subscribe to output bytes in order. Returns an unsubscribe. */
  onOutput(listener: (bytes: Uint8Array) => void): () => void;
  size(): TerminalSize;
}

/** One terminal a watcher renders. */
export interface TerminalSink {
  /** Discard what is on screen and replay exactly `bytes`. */
  reset(id: string, size: TerminalSize, bytes: Uint8Array): void;
  /** Append output to what is already on screen. */
  output(id: string, bytes: Uint8Array): void;
  /**
   * The publisher stopped sending this terminal.
   *
   * A machine publishes the one surface its holder is presenting, so a
   * publisher that stops is the holder turning to the machine's other surface,
   * or giving the machine away. Silence alone cannot say that: a terminal
   * nobody is typing into is silent too, and a watcher that could not tell the
   * two apart would keep a dead screen up beside the live surface that
   * replaced it.
   */
  ended(id: string): void;
}

type LocalTerminalMessage =
  | { readonly kind: "hello" }
  | {
      readonly kind: "screen";
      readonly id: string;
      readonly cols: number;
      readonly rows: number;
      readonly bytes: Uint8Array;
    }
  | { readonly kind: "output"; readonly id: string; readonly bytes: Uint8Array }
  | { readonly kind: "ended"; readonly id: string };

/**
 * The tail of a terminal's output, capped.
 *
 * Held as the chunks that arrived, trimmed from the front, so appending
 * costs nothing and only a reset pays to join them.
 *
 * Exported because a publisher is not the only thing that needs the recent
 * screen: a computer handing its machine away keeps one so it can go on
 * showing what it had while the machine starts elsewhere.
 */
export class ReplayTail {
  readonly #chunks: Uint8Array[] = [];
  #byteLength = 0;

  append(bytes: Uint8Array): void {
    if (bytes.byteLength === 0) return;
    this.#chunks.push(bytes);
    this.#byteLength += bytes.byteLength;
    while (this.#byteLength > REPLAY_BYTES) {
      const front = this.#chunks[0]!;
      const excess = this.#byteLength - REPLAY_BYTES;
      if (front.byteLength > excess) {
        this.#chunks[0] = front.subarray(excess);
        this.#byteLength -= excess;
        return;
      }
      this.#chunks.shift();
      this.#byteLength -= front.byteLength;
    }
  }

  snapshot(): Uint8Array {
    const joined = new Uint8Array(this.#byteLength);
    let offset = 0;
    for (const chunk of this.#chunks) {
      joined.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return joined;
  }
}

export class LocalTerminalMirror {
  readonly #channel: MessageChannelLike;

  constructor(channel: string | MessageChannelLike = LOCAL_TERMINAL_CHANNEL) {
    this.#channel =
      typeof channel === "string" ? new BroadcastChannel(channel) : channel;
  }

  /**
   * Publish one PTY under `id`.
   *
   * Sends a reset immediately, again for every watcher that says hello, and
   * again on drain after a congested wire made it skip output. Returns a
   * stop function, which tells watchers the terminal ended.
   */
  publish(id: string, source: TerminalSource): () => void {
    const tail = new ReplayTail();
    const congestion = channelCongestion(this.#channel);
    let skipped = false;
    const reset = () => {
      const size = source.size();
      this.#post({
        kind: "screen",
        id,
        cols: size.cols,
        rows: size.rows,
        bytes: tail.snapshot(),
      });
    };
    const stopOutput = source.onOutput((bytes) => {
      // slice() compacts the payload: a structured clone copies a view's
      // whole underlying buffer, which for a forwarded worker message can be
      // far larger than the bytes the terminal produced.
      const own = bytes.slice();
      tail.append(own);
      if (congestion?.congested()) {
        skipped = true;
        return;
      }
      this.#post({ kind: "output", id, bytes: own });
    });
    const stopDrain = congestion?.onDrain(() => {
      if (!skipped) return;
      skipped = false;
      reset();
    });
    const listener = (event: MessageEvent) => {
      const message = event.data as LocalTerminalMessage;
      if (message.kind === "hello") reset();
    };
    this.#channel.addEventListener("message", listener);
    reset();
    return () => {
      stopOutput();
      stopDrain?.();
      this.#channel.removeEventListener("message", listener);
      this.#post({ kind: "ended", id });
    };
  }

  /**
   * Replay every published terminal into `sink`.
   *
   * Says hello so a running publisher answers with the current screen.
   * Returns a stop function.
   */
  watch(sink: TerminalSink): () => void {
    const listener = (event: MessageEvent) => {
      const message = event.data as LocalTerminalMessage;
      if (message.kind === "screen") {
        sink.reset(
          message.id,
          { cols: message.cols, rows: message.rows },
          message.bytes,
        );
        return;
      }
      if (message.kind === "output") {
        sink.output(message.id, message.bytes);
        return;
      }
      if (message.kind === "ended") {
        sink.ended(message.id);
      }
    };
    this.#channel.addEventListener("message", listener);
    this.#post({ kind: "hello" });
    return () => this.#channel.removeEventListener("message", listener);
  }

  close(): void {
    this.#channel.close();
  }

  #post(message: LocalTerminalMessage): void {
    this.#channel.postMessage(message);
  }
}
