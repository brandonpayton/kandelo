import type { DataChannelLike } from "../../src/migration/channel-chunked";

/**
 * A connected pair of synthetic data channels with a controllable send
 * buffer. `auto` delivers on a microtask like a real wire; manual mode holds
 * bytes in the buffer until `flush()`, so a test can hold `bufferedAmount`
 * high and observe backpressure deterministically.
 */
export class FakeDataChannel implements DataChannelLike {
  binaryType = "";
  bufferedAmountLowThreshold = 0;
  #peer: FakeDataChannel | null = null;
  #buffered: ArrayBuffer[] = [];
  #bufferedBytes = 0;
  #flushScheduled = false;
  #closed = false;
  readonly #auto: boolean;
  readonly #listeners = new Map<string, Set<(event: MessageEvent) => void>>();

  constructor(auto: boolean) {
    this.#auto = auto;
  }

  static pair(options: { auto: boolean }): [FakeDataChannel, FakeDataChannel] {
    const a = new FakeDataChannel(options.auto);
    const b = new FakeDataChannel(options.auto);
    a.#peer = b;
    b.#peer = a;
    return [a, b];
  }

  get bufferedAmount(): number {
    return this.#bufferedBytes;
  }

  send(data: ArrayBuffer): void {
    if (this.#closed) throw new Error("send on a closed data channel");
    this.#buffered.push(data);
    this.#bufferedBytes += data.byteLength;
    if (!this.#auto || this.#flushScheduled) return;
    this.#flushScheduled = true;
    queueMicrotask(() => {
      this.#flushScheduled = false;
      this.flush();
    });
  }

  flush(): void {
    const wasAboveThreshold =
      this.#bufferedBytes > this.bufferedAmountLowThreshold;
    const frames = this.#buffered.splice(0);
    this.#bufferedBytes = 0;
    for (const frame of frames) {
      this.#peer?.#dispatch("message", new MessageEvent("message", { data: frame }));
    }
    if (frames.length > 0 && wasAboveThreshold) {
      this.#dispatch("bufferedamountlow", new MessageEvent("bufferedamountlow"));
    }
  }

  addEventListener(
    type: string,
    listener: (event: MessageEvent) => void,
  ): void {
    let listeners = this.#listeners.get(type);
    if (!listeners) {
      listeners = new Set();
      this.#listeners.set(type, listeners);
    }
    listeners.add(listener);
  }

  removeEventListener(
    type: string,
    listener: (event: MessageEvent) => void,
  ): void {
    this.#listeners.get(type)?.delete(listener);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#buffered.length = 0;
    this.#bufferedBytes = 0;
    this.#dispatch("close", new MessageEvent("close"));
    this.#peer?.close();
  }

  #dispatch(type: string, event: MessageEvent): void {
    for (const listener of [...(this.#listeners.get(type) ?? [])]) {
      listener(event);
    }
  }
}
