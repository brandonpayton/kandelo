/**
 * A `MessageChannelLike` over a byte-oriented data channel.
 *
 * An `RTCDataChannel` caps a single message far below a checkpoint's size
 * (Chromium refuses around 256 KiB), so every encoded message is cut into
 * chunks small enough for any browser and reassembled on the far side. The
 * channel is ordered and reliable, so chunks of one message arrive
 * contiguous and whole; the header exists so a receiver can prove that
 * rather than assume it.
 *
 * Sending respects the wire's send buffer: chunks queue here while
 * `bufferedAmount` is above the high-water mark and flow again on the
 * wire's `bufferedamountlow`. The queue makes the channel congestible —
 * `congested()` and `onDrain()` let a publisher of droppable traffic (the
 * framebuffer mirror) skip payloads instead of queueing without bound. A
 * message that was accepted is never dropped here; droppable is the
 * publisher's decision.
 *
 * Chunk frame, integers little-endian u32:
 * [messageId][chunkIndex][chunkCount][payload ≤ 64 KiB]
 */
import { decodeMessage, encodeMessage } from "./codec.js";

const CHUNK_HEADER_BYTES = 12;
const CHUNK_PAYLOAD_BYTES = 64 * 1024;
const HIGH_WATER_BYTES = 4 * 1024 * 1024;
const LOW_WATER_BYTES = 512 * 1024;

export interface DataChannelLike {
  binaryType: string;
  readonly bufferedAmount: number;
  bufferedAmountLowThreshold: number;
  send(data: ArrayBuffer): void;
  addEventListener(
    type: string,
    listener: (event: MessageEvent) => void,
  ): void;
  removeEventListener(
    type: string,
    listener: (event: MessageEvent) => void,
  ): void;
  close(): void;
}

interface IncomingMessage {
  readonly chunks: Uint8Array[];
  readonly chunkCount: number;
  received: number;
  byteLength: number;
}

export class ChunkedMessageChannel {
  readonly #wire: DataChannelLike;
  readonly #listeners = new Set<(event: MessageEvent) => void>();
  readonly #drainListeners = new Set<() => void>();
  readonly #incoming = new Map<number, IncomingMessage>();
  readonly #outgoing: ArrayBuffer[] = [];
  #nextMessageId = 0;
  #wasCongested = false;

  constructor(wire: DataChannelLike) {
    this.#wire = wire;
    this.#wire.binaryType = "arraybuffer";
    this.#wire.bufferedAmountLowThreshold = LOW_WATER_BYTES;
    this.#wire.addEventListener("message", this.#onWireMessage);
    this.#wire.addEventListener("bufferedamountlow", this.#onWireDrain);
    this.#wire.addEventListener("close", this.#onWireClose);
  }

  postMessage(message: unknown): void {
    const encoded = encodeMessage(message);
    const messageId = this.#nextMessageId++;
    const chunkCount = Math.max(
      1,
      Math.ceil(encoded.byteLength / CHUNK_PAYLOAD_BYTES),
    );
    for (let index = 0; index < chunkCount; index++) {
      const payload = encoded.subarray(
        index * CHUNK_PAYLOAD_BYTES,
        Math.min((index + 1) * CHUNK_PAYLOAD_BYTES, encoded.byteLength),
      );
      const frame = new Uint8Array(CHUNK_HEADER_BYTES + payload.byteLength);
      const view = new DataView(frame.buffer);
      view.setUint32(0, messageId, true);
      view.setUint32(4, index, true);
      view.setUint32(8, chunkCount, true);
      frame.set(payload, CHUNK_HEADER_BYTES);
      this.#outgoing.push(frame.buffer);
    }
    this.#pump();
  }

  addEventListener(
    type: "message",
    listener: (event: MessageEvent) => void,
  ): void {
    if (type === "message") this.#listeners.add(listener);
  }

  removeEventListener(
    type: "message",
    listener: (event: MessageEvent) => void,
  ): void {
    if (type === "message") this.#listeners.delete(listener);
  }

  congested(): boolean {
    return (
      this.#outgoing.length > 0
      || this.#wire.bufferedAmount > HIGH_WATER_BYTES
    );
  }

  onDrain(listener: () => void): () => void {
    this.#drainListeners.add(listener);
    return () => this.#drainListeners.delete(listener);
  }

  close(): void {
    this.#outgoing.length = 0;
    this.#wire.removeEventListener("message", this.#onWireMessage);
    this.#wire.removeEventListener("bufferedamountlow", this.#onWireDrain);
    this.#wire.removeEventListener("close", this.#onWireClose);
    this.#wire.close();
  }

  #pump(): void {
    while (
      this.#outgoing.length > 0
      && this.#wire.bufferedAmount <= HIGH_WATER_BYTES
    ) {
      this.#wire.send(this.#outgoing.shift()!);
    }
    if (this.congested()) {
      this.#wasCongested = true;
      return;
    }
    if (!this.#wasCongested) return;
    this.#wasCongested = false;
    for (const listener of [...this.#drainListeners]) listener();
  }

  readonly #onWireDrain = (): void => {
    this.#pump();
  };

  readonly #onWireClose = (): void => {
    this.#outgoing.length = 0;
    this.#incoming.clear();
  };

  readonly #onWireMessage = (event: MessageEvent): void => {
    const frame = new Uint8Array(event.data as ArrayBuffer);
    if (frame.byteLength < CHUNK_HEADER_BYTES) {
      throw new Error("chunk frame is shorter than its header");
    }
    const view = new DataView(frame.buffer, frame.byteOffset);
    const messageId = view.getUint32(0, true);
    const chunkIndex = view.getUint32(4, true);
    const chunkCount = view.getUint32(8, true);
    let incoming = this.#incoming.get(messageId);
    if (!incoming) {
      incoming = {
        chunks: new Array<Uint8Array>(chunkCount),
        chunkCount,
        received: 0,
        byteLength: 0,
      };
      this.#incoming.set(messageId, incoming);
    }
    if (
      chunkCount !== incoming.chunkCount
      || chunkIndex >= incoming.chunkCount
      || incoming.chunks[chunkIndex] !== undefined
    ) {
      this.#incoming.delete(messageId);
      throw new Error(
        `chunk ${chunkIndex}/${chunkCount} does not continue message ${messageId}`,
      );
    }
    const payload = frame.subarray(CHUNK_HEADER_BYTES);
    incoming.chunks[chunkIndex] = payload;
    incoming.received += 1;
    incoming.byteLength += payload.byteLength;
    if (incoming.received < incoming.chunkCount) return;

    this.#incoming.delete(messageId);
    const encoded = new Uint8Array(incoming.byteLength);
    let offset = 0;
    for (const chunk of incoming.chunks) {
      encoded.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const data = decodeMessage(encoded);
    for (const listener of [...this.#listeners]) {
      listener(new MessageEvent("message", { data }));
    }
  };
}
