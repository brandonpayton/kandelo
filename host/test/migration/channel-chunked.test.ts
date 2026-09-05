import { describe, expect, it, vi } from "vitest";
import { ChunkedMessageChannel } from "../../src/migration/channel-chunked";
import { FakeDataChannel } from "../support/data-channel-pair";

function connectedPair(options: { auto: boolean }): {
  sender: ChunkedMessageChannel;
  receiver: ChunkedMessageChannel;
  senderWire: FakeDataChannel;
  receiverWire: FakeDataChannel;
  received: unknown[];
} {
  const [senderWire, receiverWire] = FakeDataChannel.pair(options);
  const sender = new ChunkedMessageChannel(senderWire);
  const receiver = new ChunkedMessageChannel(receiverWire);
  const received: unknown[] = [];
  receiver.addEventListener("message", (event) => received.push(event.data));
  return { sender, receiver, senderWire, receiverWire, received };
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
    const bytes = new Uint8Array(200 * 1024);
    bytes[0] = 5;
    bytes[bytes.byteLength - 1] = 7;
    sender.postMessage({ kind: "bar", bytes });
    await vi.waitFor(() => expect(received).toHaveLength(1));
    const message = received[0] as { bytes: Uint8Array };
    expect(message.bytes.byteLength).toBe(bytes.byteLength);
    expect(message.bytes[0]).toBe(5);
    expect(message.bytes[bytes.byteLength - 1]).toBe(7);
  });

  it("keeps message order across sizes", async () => {
    const { sender, received } = connectedPair({ auto: true });
    sender.postMessage({ kind: "first" });
    sender.postMessage({ kind: "second", bytes: new Uint8Array(300 * 1024) });
    sender.postMessage({ kind: "third" });
    await vi.waitFor(() => expect(received).toHaveLength(3));
    expect(received.map((message) => (message as { kind: string }).kind))
      .toEqual(["first", "second", "third"]);
  });

  it("reports congestion under a backed-up wire and drains after a flush", async () => {
    const { sender, senderWire, received } = connectedPair({ auto: false });
    const drained = vi.fn();
    sender.onDrain(drained);
    expect(sender.congested()).toBe(false);

    sender.postMessage({ kind: "big", bytes: new Uint8Array(5 * 1024 * 1024) });
    expect(sender.congested()).toBe(true);
    expect(drained).not.toHaveBeenCalled();

    senderWire.flush();
    expect(sender.congested()).toBe(false);
    expect(drained).toHaveBeenCalledTimes(1);

    senderWire.flush();
    await vi.waitFor(() => expect(received).toHaveLength(1));
    const message = received[0] as { bytes: Uint8Array };
    expect(message.bytes.byteLength).toBe(5 * 1024 * 1024);
  });

  it("close drops the queue and closes the wire", () => {
    const { sender, senderWire, receiver } = connectedPair({ auto: false });
    sender.postMessage({ kind: "big", bytes: new Uint8Array(5 * 1024 * 1024) });
    expect(sender.congested()).toBe(true);
    sender.close();
    receiver.close();
    expect(() => senderWire.send(new ArrayBuffer(1))).toThrow("closed");
  });
});
