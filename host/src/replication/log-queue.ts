/**
 * The decision log on shared memory, so a replica can wait for it.
 *
 * A live replica runs the machine at its own speed and drains the primary's
 * log whenever it gets ahead. The guest read that drains it is
 * `clock_gettime`, which reaches the host synchronously inside the kernel
 * worker, so there is no point there at which a promise can be awaited or a
 * `message` event can be delivered. The replica must either invent a reading,
 * which is the silent divergence `log.ts` exists to prevent, or stop until the
 * primary's next decision arrives.
 *
 * It stops here. The queue is a ring in a `SharedArrayBuffer`: the main
 * thread writes the entries it receives from the wire, and the kernel worker
 * blocks on `Atomics.wait` until one is readable. That is the same primitive
 * `host/src/fork-replay-gate.ts` and `host/src/checkpoint-freeze-gate.ts` use,
 * and for the same reason — a synchronous Wasm-facing path cannot await.
 *
 * Nothing is dropped. A full ring holds the writer's entries in JavaScript
 * until the reader has taken enough bytes to make room, so congestion costs
 * delay and never a decision. The writer never blocks: it runs on the main
 * thread, where `Atomics.wait` is forbidden.
 *
 * Entries are framed `[u32 byteLength][encodeMessage(entry)]`. The codec is
 * `host/src/migration/codec.ts`, already the one this project uses to put a
 * message on a byte wire, so a device's input bytes travel as bytes.
 */
import { decodeMessage, encodeMessage } from "../migration/codec.js";
import type { ReplicationLogEntry } from "./log.js";

/** Words of the ring header, in `Int32Array` indices. */
const STATE = 0;
const AVAILABLE = 1;
const READ_AT = 2;
const WRITE_AT = 3;
const HEADER_BYTES = 4 * Int32Array.BYTES_PER_ELEMENT;

const OPEN = 0;
const ENDED = 1;

const FRAME_HEADER_BYTES = 4;
const DEFAULT_CAPACITY_BYTES = 1024 * 1024;

/**
 * How long a starved reader sleeps before looking again.
 *
 * `end()` notifies, so this bound is not how the normal wake happens. It is
 * what keeps a lost notification from parking a machine forever, the way
 * `host/src/channel.ts` bounds its own wait.
 */
const WAIT_SLICE_MS = 1000;

/** How long the writer waits before retrying a ring that had no room. */
const RETRY_SLICE_MS = 4;

function ringOf(buffer: SharedArrayBuffer): {
  header: Int32Array;
  ring: Uint8Array;
  capacity: number;
} {
  if (!(buffer instanceof SharedArrayBuffer)) {
    throw new TypeError("a replication log queue must be shared memory");
  }
  if (buffer.byteLength <= HEADER_BYTES) {
    throw new TypeError("a replication log queue must have room for a frame");
  }
  return {
    header: new Int32Array(buffer, 0, 4),
    ring: new Uint8Array(buffer, HEADER_BYTES),
    capacity: buffer.byteLength - HEADER_BYTES,
  };
}

export function createReplicationLogQueue(
  capacityBytes = DEFAULT_CAPACITY_BYTES,
): SharedArrayBuffer {
  if (!Number.isSafeInteger(capacityBytes) || capacityBytes <= 0) {
    throw new Error("a replication log queue needs a positive capacity");
  }
  return new SharedArrayBuffer(HEADER_BYTES + capacityBytes);
}

/**
 * Put the primary's decisions where a blocked replica can reach them.
 *
 * Lives on the thread that owns the wire, which is the main thread in both
 * hosts, so it never blocks. Entries that do not fit stay in `pending` and go
 * in as the reader makes room.
 */
export class ReplicationLogQueueWriter {
  readonly #header: Int32Array;
  readonly #ring: Uint8Array;
  readonly #capacity: number;
  readonly #pending: Uint8Array[] = [];
  #retry: ReturnType<typeof setTimeout> | null = null;
  #ended = false;

  constructor(buffer: SharedArrayBuffer) {
    const { header, ring, capacity } = ringOf(buffer);
    this.#header = header;
    this.#ring = ring;
    this.#capacity = capacity;
  }

  /** Entries written but not yet accepted by the ring. */
  get pending(): number {
    return this.#pending.length;
  }

  /**
   * Take entries for the replica, and refuse only what no ring could carry.
   *
   * The refusal happens before anything is queued, so a caller that has to
   * grow its ring still holds every entry it was given. Accepting an entry
   * and then dropping it would be the silent divergence this module exists to
   * prevent.
   */
  push(entries: readonly ReplicationLogEntry[]): void {
    const framed = entries.map(frame);
    for (const frameBytes of framed) {
      if (frameBytes.byteLength > this.#capacity) {
        throw new Error(
          `a replication log entry of ${frameBytes.byteLength} bytes does not `
            + `fit a queue of ${this.#capacity}`,
        );
      }
    }
    this.#pending.push(...framed);
    this.#flush();
  }

  /**
   * Say the recording will not continue.
   *
   * A replica blocked on a log that has ended would sit there, so the state
   * word carries the end and the waiters are woken to read it. Entries still
   * pending are flushed first: the end is a boundary, not a reason to drop
   * what was already recorded.
   *
   * Retrying stops here. A replica that has not drained the ring by the time
   * the recording ends is not following it any more, and a writer that kept
   * polling for room would poll for as long as the page is open. What never
   * reached it stays readable as `pending` rather than being retried forever.
   */
  end(): void {
    this.#ended = true;
    this.#flush();
    Atomics.store(this.#header, STATE, ENDED);
    Atomics.notify(this.#header, AVAILABLE);
  }

  #flush(): void {
    while (this.#pending.length > 0) {
      const frameBytes = this.#pending[0]!;
      const free = this.#capacity - Atomics.load(this.#header, AVAILABLE);
      if (free < frameBytes.byteLength) break;
      this.#write(frameBytes);
      this.#pending.shift();
    }
    this.#scheduleRetry();
  }

  #write(frameBytes: Uint8Array): void {
    let at = Atomics.load(this.#header, WRITE_AT);
    const head = Math.min(frameBytes.byteLength, this.#capacity - at);
    this.#ring.set(frameBytes.subarray(0, head), at);
    if (head < frameBytes.byteLength) {
      this.#ring.set(frameBytes.subarray(head), 0);
    }
    at = (at + frameBytes.byteLength) % this.#capacity;
    Atomics.store(this.#header, WRITE_AT, at);
    // The bytes are published only now, so a reader never sees a frame the
    // writer has not finished laying down.
    Atomics.add(this.#header, AVAILABLE, frameBytes.byteLength);
    Atomics.notify(this.#header, AVAILABLE);
  }

  #scheduleRetry(): void {
    if (this.#pending.length === 0 || this.#ended) {
      if (this.#retry !== null) clearTimeout(this.#retry);
      this.#retry = null;
      return;
    }
    if (this.#retry !== null) return;
    this.#retry = setTimeout(() => {
      this.#retry = null;
      this.#flush();
    }, RETRY_SLICE_MS);
  }
}

/**
 * Take the primary's decisions, and wait when the machine has caught up.
 *
 * Lives on the kernel worker, which may block. `take` returns `null` only
 * when the writer said the recording ended and the ring is empty.
 */
export class ReplicationLogQueueReader {
  readonly #header: Int32Array;
  readonly #ring: Uint8Array;
  readonly #capacity: number;

  constructor(buffer: SharedArrayBuffer) {
    const { header, ring, capacity } = ringOf(buffer);
    this.#header = header;
    this.#ring = ring;
    this.#capacity = capacity;
  }

  take(): ReplicationLogEntry | null {
    for (;;) {
      if (Atomics.load(this.#header, AVAILABLE) >= FRAME_HEADER_BYTES) {
        return this.#read();
      }
      if (Atomics.load(this.#header, STATE) === ENDED) return null;
      Atomics.wait(this.#header, AVAILABLE, 0, WAIT_SLICE_MS);
    }
  }

  /**
   * Take one entry if the ring already holds one, and never wait.
   *
   * For the drain that runs when the guest is not reading the clock: a
   * keystroke has no guest request behind it, so the kernel worker takes it
   * from its own event loop, where blocking would stall the machine. `null`
   * here means nothing is ready now, not that the recording ended — `take` is
   * where the end is read.
   */
  takeReady(): ReplicationLogEntry | null {
    if (Atomics.load(this.#header, AVAILABLE) < FRAME_HEADER_BYTES) return null;
    return this.#read();
  }

  #read(): ReplicationLogEntry {
    const length = new DataView(this.#copy(FRAME_HEADER_BYTES).buffer)
      .getUint32(0, true);
    const payload = this.#copy(length);
    Atomics.sub(this.#header, AVAILABLE, FRAME_HEADER_BYTES + length);
    return decodeMessage(payload) as ReplicationLogEntry;
  }

  #copy(length: number): Uint8Array<ArrayBuffer> {
    const at = Atomics.load(this.#header, READ_AT);
    const out = new Uint8Array(length);
    const head = Math.min(length, this.#capacity - at);
    out.set(this.#ring.subarray(at, at + head));
    if (head < length) out.set(this.#ring.subarray(0, length - head), head);
    Atomics.store(this.#header, READ_AT, (at + length) % this.#capacity);
    return out;
  }
}

function frame(entry: ReplicationLogEntry): Uint8Array<ArrayBuffer> {
  const payload = encodeMessage(entry);
  const framed = new Uint8Array(FRAME_HEADER_BYTES + payload.byteLength);
  new DataView(framed.buffer).setUint32(0, payload.byteLength, true);
  framed.set(payload, FRAME_HEADER_BYTES);
  return framed;
}
