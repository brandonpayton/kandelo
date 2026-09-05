import { describe, expect, it } from "vitest";
import { decodeMessage, encodeMessage } from "../../src/migration/codec";

describe("migration message codec", () => {
  it("round-trips a nested message with binary payloads", () => {
    const message = {
      kind: "qux",
      count: 3,
      ratio: 4.5,
      flag: true,
      nothing: null,
      bytes: new Uint8Array([1, 2, 3]),
      buffer: Uint8Array.from([9, 8]).buffer,
      nested: { list: [new Uint8Array([7]), "waldo", 6] },
    };
    const decoded = decodeMessage(encodeMessage(message)) as typeof message;
    expect(decoded.kind).toBe("qux");
    expect(decoded.count).toBe(3);
    expect(decoded.ratio).toBe(4.5);
    expect(decoded.flag).toBe(true);
    expect(decoded.nothing).toBeNull();
    expect(decoded.bytes).toBeInstanceOf(Uint8Array);
    expect([...decoded.bytes]).toEqual([1, 2, 3]);
    expect(decoded.buffer).toBeInstanceOf(ArrayBuffer);
    expect([...new Uint8Array(decoded.buffer)]).toEqual([9, 8]);
    expect(decoded.nested.list[0]).toBeInstanceOf(Uint8Array);
    expect([...(decoded.nested.list[0] as Uint8Array)]).toEqual([7]);
    expect(decoded.nested.list[1]).toBe("waldo");
    expect(decoded.nested.list[2]).toBe(6);
  });

  it("decodes binary payloads into standalone buffers", () => {
    const decoded = decodeMessage(
      encodeMessage({ bytes: new Uint8Array([1, 2, 3]) }),
    ) as { bytes: Uint8Array };
    expect(decoded.bytes.buffer.byteLength).toBe(decoded.bytes.byteLength);
  });

  it("keeps an empty binary payload empty", () => {
    const decoded = decodeMessage(
      encodeMessage({ bytes: new Uint8Array(0) }),
    ) as { bytes: Uint8Array };
    expect(decoded.bytes).toBeInstanceOf(Uint8Array);
    expect(decoded.bytes.byteLength).toBe(0);
  });

  it("round-trips a large payload without walking its elements", () => {
    const bytes = new Uint8Array(3 * 1024 * 1024);
    bytes[0] = 42;
    bytes[bytes.byteLength - 1] = 24;
    const decoded = decodeMessage(encodeMessage({ bytes })) as {
      bytes: Uint8Array;
    };
    expect(decoded.bytes.byteLength).toBe(bytes.byteLength);
    expect(decoded.bytes[0]).toBe(42);
    expect(decoded.bytes[bytes.byteLength - 1]).toBe(24);
  });

  it("refuses a truncated encoding", () => {
    const encoded = encodeMessage({ bytes: new Uint8Array([1, 2, 3]) });
    expect(() => decodeMessage(encoded.subarray(0, encoded.byteLength - 1)))
      .toThrow("ends inside");
  });

  it("refuses a message that is not JSON-serialisable", () => {
    expect(() => encodeMessage(undefined)).toThrow("not JSON-serialisable");
  });
});
