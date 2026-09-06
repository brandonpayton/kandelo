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
 * A message is deflated before it is cut. What crosses this wire is mostly
 * guest memory — a machine checkpoint is kernel memory, a filesystem image
 * and whole process images, and a mirrored frame is one palette-derived
 * screen — and all of it is sparse enough that deflate turns a link that
 * cannot carry the traffic into one that can. Small messages skip it: the
 * handover's own request would pay the round trip for nothing. Deflate is
 * asynchronous on both hosts, so a posted message joins a queue that keeps
 * post order rather than racing the message posted after it.
 *
 * Sending respects the wire's send buffer: chunks queue here while
 * `bufferedAmount` is above the high-water mark and flow again on the
 * wire's `bufferedamountlow`. The queue makes the channel congestible —
 * `congested()` and `onDrain()` let a publisher of droppable traffic (the
 * framebuffer mirror) skip payloads instead of queueing without bound. A
 * message that was accepted is never dropped here; droppable is the
 * publisher's decision.
 *
 * The water marks are the caller's, because the two kinds of traffic want
 * opposite things. Bulk traffic wants a deep queue so the wire never idles.
 * Droppable live traffic wants a shallow one: every byte queued ahead of the
 * next frame is latency the watcher sees, and a deep queue shows a watcher a
 * frame from seconds ago instead of skipping to the current one.
 *
 * Chunk frame, integers little-endian u32:
 * [messageId][chunkIndex][chunkCount][encoding][payload ≤ 64 KiB]
 * where encoding is 0 for the codec's bytes as they are and 1 for deflate.
 */
import { decodeMessage, encodeMessage } from "./codec.js";

const CHUNK_HEADER_BYTES = 16;
const CHUNK_PAYLOAD_BYTES = 64 * 1024;
const DEFAULT_HIGH_WATER_BYTES = 4 * 1024 * 1024;
const DEFAULT_LOW_WATER_BYTES = 512 * 1024;

const ENCODING_PLAIN = 0;
const ENCODING_DEFLATE = 1;
const DEFLATE_FORMAT = "deflate-raw";
/** Below this a message is sent as it is: deflate would cost more than it saves. */
const DEFLATE_THRESHOLD_BYTES = 4 * 1024;

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

export interface ChunkedMessageChannelOptions {
  /** Bytes allowed in the wire's send buffer before sending pauses. */
  readonly highWaterBytes?: number;
  /** Bytes the wire must fall to before it reports a drain. */
  readonly lowWaterBytes?: number;
}

interface IncomingMessage {
  readonly chunks: Uint8Array[];
  readonly chunkCount: number;
  readonly encoding: number;
  received: number;
  byteLength: number;
}

interface ByteTransformStream {
  readonly readable: ReadableStream<Uint8Array>;
  readonly writable: WritableStream<BufferSource>;
}

/**
 * Push `bytes` through `transform` and join what comes out.
 *
 * The write is not awaited before the read starts: a transform stream holds
 * its input until someone drains its output, so awaiting first would park
 * both ends against each other.
 */
async function through(
  bytes: Uint8Array<ArrayBuffer>,
  transform: ByteTransformStream,
): Promise<Uint8Array<ArrayBuffer>> {
  const writer = transform.writable.getWriter();
  // A transform that fails rejects both of its ends. The write's rejection is
  // held as a value rather than left to reject on its own, because the read
  // below throws first and would leave nobody to receive it — which Node
  // treats as a fatal unhandled rejection.
  const pushed = writer
    .write(bytes)
    .then(() => writer.close())
    .then(() => null, (error: unknown) => error);
  const reader = transform.readable.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    total += value.byteLength;
  }
  const failure = await pushed;
  if (failure !== null) throw failure;
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    joined.set(part, offset);
    offset += part.byteLength;
  }
  return joined;
}

/**
 * Deflate `encoded`, or report that it is going out as it is.
 *
 * A message deflate does not shrink — an already-compressed payload, or one
 * too small to pay for the header — is sent plain rather than sent larger.
 */
async function deflate(
  encoded: Uint8Array<ArrayBuffer>,
): Promise<{ encoding: number; body: Uint8Array<ArrayBuffer> }> {
  if (encoded.byteLength < DEFLATE_THRESHOLD_BYTES) {
    return { encoding: ENCODING_PLAIN, body: encoded };
  }
  const body = await through(encoded, new CompressionStream(DEFLATE_FORMAT));
  if (body.byteLength >= encoded.byteLength) {
    return { encoding: ENCODING_PLAIN, body: encoded };
  }
  return { encoding: ENCODING_DEFLATE, body };
}

async function inflate(
  encoding: number,
  body: Uint8Array<ArrayBuffer>,
): Promise<Uint8Array<ArrayBuffer>> {
  if (encoding === ENCODING_PLAIN) return body;
  if (encoding !== ENCODING_DEFLATE) {
    throw new Error(`chunk frame carries unknown encoding ${encoding}`);
  }
  return through(body, new DecompressionStream(DEFLATE_FORMAT));
}

export class ChunkedMessageChannel {
  readonly #wire: DataChannelLike;
  readonly #highWaterBytes: number;
  readonly #listeners = new Set<(event: MessageEvent) => void>();
  readonly #drainListeners = new Set<() => void>();
  readonly #incoming = new Map<number, IncomingMessage>();
  readonly #outgoing: ArrayBuffer[] = [];
  #nextMessageId = 0;
  #wasCongested = false;
  #closed = false;
  /** Messages accepted but not yet cut into chunks; they are still owed to the wire. */
  #deflating = 0;
  #sendTail: Promise<void> = Promise.resolve();
  #receiveTail: Promise<void> = Promise.resolve();

  constructor(wire: DataChannelLike, options: ChunkedMessageChannelOptions = {}) {
    this.#wire = wire;
    this.#highWaterBytes = options.highWaterBytes ?? DEFAULT_HIGH_WATER_BYTES;
    this.#wire.binaryType = "arraybuffer";
    this.#wire.bufferedAmountLowThreshold =
      options.lowWaterBytes ?? DEFAULT_LOW_WATER_BYTES;
    this.#wire.addEventListener("message", this.#onWireMessage);
    this.#wire.addEventListener("bufferedamountlow", this.#onWireDrain);
    this.#wire.addEventListener("close", this.#onWireClose);
  }

  postMessage(message: unknown): void {
    // Encoded here rather than on the queue: the caller can retire the state
    // the message describes as soon as this returns, and a machine handover
    // does exactly that.
    const encoded = encodeMessage(message);
    const messageId = this.#nextMessageId++;
    // Counted before the deflate starts: a message owed to the wire is
    // congestion a publisher must see now, not once its deflate finishes,
    // because the next frame arrives before that.
    this.#deflating += 1;
    this.#sendTail = this.#sendTail
      .then(async () => {
        try {
          if (this.#closed) return;
          const { encoding, body } = await deflate(encoded);
          if (this.#closed) return;
          this.#cut(messageId, encoding, body);
        } finally {
          this.#deflating -= 1;
          this.#pump();
        }
      })
      .catch(rethrowLater);
    // `bufferedamountlow` fires only on the way past the low mark, so a wire
    // that fell between the two marks leaves the queue stalled until someone
    // pumps it. A caller posting a message is that someone.
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
      this.#deflating > 0
      || this.#outgoing.length > 0
      || this.#wire.bufferedAmount > this.#highWaterBytes
    );
  }

  onDrain(listener: () => void): () => void {
    this.#drainListeners.add(listener);
    return () => this.#drainListeners.delete(listener);
  }

  close(): void {
    this.#closed = true;
    this.#outgoing.length = 0;
    this.#wire.removeEventListener("message", this.#onWireMessage);
    this.#wire.removeEventListener("bufferedamountlow", this.#onWireDrain);
    this.#wire.removeEventListener("close", this.#onWireClose);
    this.#wire.close();
  }

  #cut(messageId: number, encoding: number, body: Uint8Array<ArrayBuffer>): void {
    const chunkCount = Math.max(
      1,
      Math.ceil(body.byteLength / CHUNK_PAYLOAD_BYTES),
    );
    for (let index = 0; index < chunkCount; index++) {
      const payload = body.subarray(
        index * CHUNK_PAYLOAD_BYTES,
        Math.min((index + 1) * CHUNK_PAYLOAD_BYTES, body.byteLength),
      );
      const frame = new Uint8Array(CHUNK_HEADER_BYTES + payload.byteLength);
      const view = new DataView(frame.buffer);
      view.setUint32(0, messageId, true);
      view.setUint32(4, index, true);
      view.setUint32(8, chunkCount, true);
      view.setUint32(12, encoding, true);
      frame.set(payload, CHUNK_HEADER_BYTES);
      this.#outgoing.push(frame.buffer);
    }
  }

  #pump(): void {
    while (
      this.#outgoing.length > 0
      && this.#wire.bufferedAmount <= this.#highWaterBytes
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
    this.#closed = true;
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
    const encoding = view.getUint32(12, true);
    let incoming = this.#incoming.get(messageId);
    if (!incoming) {
      incoming = {
        chunks: new Array<Uint8Array>(chunkCount),
        chunkCount,
        encoding,
        received: 0,
        byteLength: 0,
      };
      this.#incoming.set(messageId, incoming);
    }
    if (
      chunkCount !== incoming.chunkCount
      || encoding !== incoming.encoding
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
    const body = new Uint8Array(incoming.byteLength);
    let offset = 0;
    for (const chunk of incoming.chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    // Inflating is asynchronous, so delivery joins a queue: two messages
    // whose inflations overlap must still reach the listener in wire order.
    this.#receiveTail = this.#receiveTail.then(async () => {
      const data = decodeMessage(await inflate(incoming.encoding, body));
      for (const listener of [...this.#listeners]) {
        listener(new MessageEvent("message", { data }));
      }
    });
    this.#receiveTail = this.#receiveTail.catch(rethrowLater);
  };
}

/**
 * Report a queue failure without breaking the queue.
 *
 * A rejected send or delivery must not stop the messages behind it, and must
 * not disappear either: the throw reaches the host's unhandled-error path the
 * same way a listener's own throw does.
 */
function rethrowLater(error: unknown): void {
  setTimeout(() => {
    throw error;
  });
}
