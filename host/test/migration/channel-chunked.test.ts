import { describe, expect, it, vi } from "vitest";
import { ChunkedMessageChannel } from "../../src/migration/channel-chunked";
import { FakeDataChannel } from "../support/data-channel-pair";

function connectedPair(options: {
  auto: boolean;
  highWaterBytes?: number;
  lowWaterBytes?: number;
}): {
  sender: ChunkedMessageChannel;
  receiver: ChunkedMessageChannel;
  senderWire: FakeDataChannel;
  receiverWire: FakeDataChannel;
  received: unknown[];
} {
  const [senderWire, receiverWire] = FakeDataChannel.pair({
    auto: options.auto,
  });
  const sender = new ChunkedMessageChannel(senderWire, options);
  const receiver = new ChunkedMessageChannel(receiverWire);
  const received: unknown[] = [];
  receiver.addEventListener("message", (event) => received.push(event.data));
  return { sender, receiver, senderWire, receiverWire, received };
}

/** Bytes deflate cannot shrink, so a test can fill a send buffer on purpose. */
function incompressible(byteLength: number): Uint8Array {
  const bytes = new Uint8Array(byteLength);
  for (let offset = 0; offset < byteLength; offset += 65536) {
    crypto.getRandomValues(
      bytes.subarray(offset, Math.min(offset + 65536, byteLength)),
    );
  }
  return bytes;
}

/** One chunk frame, built by hand so a test can malform it. */
function chunkFrame(header: {
  messageId: number;
  chunkIndex: number;
  chunkCount: number;
  encoding: number;
  payload: Uint8Array;
}): ArrayBuffer {
  const frame = new Uint8Array(16 + header.payload.byteLength);
  const view = new DataView(frame.buffer);
  view.setUint32(0, header.messageId, true);
  view.setUint32(4, header.chunkIndex, true);
  view.setUint32(8, header.chunkCount, true);
  view.setUint32(12, header.encoding, true);
  frame.set(header.payload, 16);
  return frame.buffer;
}

describe("chunked message channel", () => {
  it("delivers a message across the pair", async () => {
    const { sender, received } = connectedPair({ auto: true });
    sender.postMessage({ kind: "foo", bytes: new Uint8Array([1, 2]) });
    await vi.waitFor(() => expect(received).toHaveLength(1));
    const message = received[0] as { kind: string; bytes: Uint8Array };
    expect(message.kind).toBe("foo");
    expect([...message.bytes]).toEqual([1, 2]);
  });

  it("reassembles a message larger than one chunk", async () => {
    const { sender, received } = connectedPair({ auto: true });
    const bytes = incompressible(200 * 1024);
    sender.postMessage({ kind: "bar", bytes });
    await vi.waitFor(() => expect(received).toHaveLength(1));
    const message = received[0] as { bytes: Uint8Array };
    expect(message.bytes).toEqual(bytes);
  });

  it("keeps message order across sizes", async () => {
    const { sender, received } = connectedPair({ auto: true });
    sender.postMessage({ kind: "first" });
    sender.postMessage({ kind: "second", bytes: incompressible(300 * 1024) });
    sender.postMessage({ kind: "third" });
    await vi.waitFor(() => expect(received).toHaveLength(3));
    expect(received.map((message) => (message as { kind: string }).kind))
      .toEqual(["first", "second", "third"]);
  });

  it("sends a sparse message as a fraction of its encoded size", async () => {
    // What this wire really carries: guest memory and palette-derived frames,
    // both sparse. A link that cannot carry the bytes can carry the message.
    const { sender, received, senderWire } = connectedPair({ auto: false });
    const bytes = new Uint8Array(1024 * 1024);
    bytes[0] = 5;
    bytes[bytes.byteLength - 1] = 7;

    sender.postMessage({ kind: "sparse", bytes });
    await vi.waitFor(() => expect(senderWire.bufferedAmount).toBeGreaterThan(0));
    expect(senderWire.bufferedAmount).toBeLessThan(bytes.byteLength / 10);

    senderWire.flush();
    await vi.waitFor(() => expect(received).toHaveLength(1));
    expect((received[0] as { bytes: Uint8Array }).bytes).toEqual(bytes);
  });

  it("reports congestion under a backed-up wire and drains after a flush", async () => {
    const { sender, senderWire, received } = connectedPair({
      auto: false,
      highWaterBytes: 256 * 1024,
      lowWaterBytes: 64 * 1024,
    });
    const drained = vi.fn();
    sender.onDrain(drained);
    expect(sender.congested()).toBe(false);

    const bytes = incompressible(384 * 1024);
    sender.postMessage({ kind: "big", bytes });
    // Congested from the moment the message is accepted: a publisher of
    // droppable traffic decides on the next frame before this one is cut.
    expect(sender.congested()).toBe(true);
    await vi.waitFor(() =>
      expect(senderWire.bufferedAmount).toBeGreaterThan(256 * 1024),
    );
    expect(sender.congested()).toBe(true);
    expect(drained).not.toHaveBeenCalled();

    senderWire.flush();
    expect(sender.congested()).toBe(false);
    expect(drained).toHaveBeenCalledTimes(1);

    senderWire.flush();
    await vi.waitFor(() => expect(received).toHaveLength(1));
    expect((received[0] as { bytes: Uint8Array }).bytes).toEqual(bytes);
  });

  it("holds a shallow queue to the caller's water marks", async () => {
    const { sender, senderWire, received } = connectedPair({
      auto: false,
      highWaterBytes: 128 * 1024,
      lowWaterBytes: 32 * 1024,
    });
    expect(senderWire.bufferedAmountLowThreshold).toBe(32 * 1024);

    sender.postMessage({ kind: "frame", bytes: incompressible(1024 * 1024) });
    await vi.waitFor(() =>
      expect(senderWire.bufferedAmount).toBeGreaterThan(128 * 1024),
    );
    // The wire holds barely more than the mark, not the whole message: the
    // rest waits here, where the next frame can overtake it by being skipped.
    expect(senderWire.bufferedAmount).toBeLessThan(256 * 1024);
    expect(sender.congested()).toBe(true);

    await vi.waitFor(() => {
      senderWire.flush();
      expect(received).toHaveLength(1);
    });
    expect(sender.congested()).toBe(false);
  });

  it("refuses a message whose chunks disagree on encoding", () => {
    // The encoding is decided once per message and repeated on every chunk.
    // A run that changes it mid-message would inflate the wrong half of a
    // body, so the receiver drops the message rather than decode a guess.
    const { senderWire, received } = connectedPair({ auto: false });
    senderWire.send(chunkFrame({
      messageId: 1,
      chunkIndex: 0,
      chunkCount: 2,
      encoding: 0,
      payload: new Uint8Array([1]),
    }));
    senderWire.flush();

    senderWire.send(chunkFrame({
      messageId: 1,
      chunkIndex: 1,
      chunkCount: 2,
      encoding: 1,
      payload: new Uint8Array([2]),
    }));
    expect(() => senderWire.flush()).toThrow("does not continue message 1");
    expect(received).toHaveLength(0);
  });

  it("close drops the queue and closes the wire", () => {
    const { sender, senderWire, receiver } = connectedPair({ auto: false });
    sender.postMessage({ kind: "big", bytes: incompressible(512 * 1024) });
    expect(sender.congested()).toBe(true);
    sender.close();
    receiver.close();
    expect(() => senderWire.send(new ArrayBuffer(1))).toThrow("closed");
  });
});
