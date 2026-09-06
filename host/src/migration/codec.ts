/**
 * Binary codec for migration messages crossing a byte-oriented wire.
 *
 * `BroadcastChannel` structured-clones its payloads, so the same-origin
 * transports never serialise. A network wire carries bytes, and a checkpoint
 * is mostly bytes already: whole process memories, kernel memory, frames.
 * Encoding hoists every `Uint8Array` and `ArrayBuffer` out of the message,
 * stringifies the JSON skeleton that remains, and appends the raw bytes —
 * so the memories are copied, never base64'd or walked element by element.
 *
 * Wire layout, all integers little-endian u32:
 * [jsonLength][json][blobLength][blob]... — blob order is visit order, and
 * the skeleton marks each hoisting site with `{"$kandeloBinary": index,
 * "as": "bytes" | "buffer"}` so decode restores the exact view kind.
 */

const BINARY_TAG = "$kandeloBinary";

type BinaryMarker = {
  readonly [BINARY_TAG]: number;
  readonly as: "bytes" | "buffer";
};

function isBinaryMarker(node: unknown): node is BinaryMarker {
  return (
    typeof node === "object"
    && node !== null
    && BINARY_TAG in node
    && typeof (node as BinaryMarker)[BINARY_TAG] === "number"
  );
}

export function encodeMessage(message: unknown): Uint8Array<ArrayBuffer> {
  const blobs: Uint8Array[] = [];
  const json = JSON.stringify(message, (_key, node: unknown) => {
    if (node instanceof Uint8Array) {
      blobs.push(node);
      return { [BINARY_TAG]: blobs.length - 1, as: "bytes" };
    }
    if (node instanceof ArrayBuffer) {
      blobs.push(new Uint8Array(node));
      return { [BINARY_TAG]: blobs.length - 1, as: "buffer" };
    }
    return node;
  });
  if (json === undefined) {
    throw new Error("message is not JSON-serialisable");
  }
  const jsonBytes = new TextEncoder().encode(json);
  let total = 4 + jsonBytes.byteLength;
  for (const blob of blobs) total += 4 + blob.byteLength;

  const encoded = new Uint8Array(total);
  const view = new DataView(encoded.buffer);
  view.setUint32(0, jsonBytes.byteLength, true);
  encoded.set(jsonBytes, 4);
  let offset = 4 + jsonBytes.byteLength;
  for (const blob of blobs) {
    view.setUint32(offset, blob.byteLength, true);
    encoded.set(blob, offset + 4);
    offset += 4 + blob.byteLength;
  }
  return encoded;
}

export function decodeMessage(encoded: Uint8Array): unknown {
  const view = new DataView(
    encoded.buffer,
    encoded.byteOffset,
    encoded.byteLength,
  );
  if (encoded.byteLength < 4) {
    throw new Error("encoded message is shorter than its header");
  }
  const jsonLength = view.getUint32(0, true);
  if (4 + jsonLength > encoded.byteLength) {
    throw new Error("encoded message ends inside its JSON skeleton");
  }
  const json = new TextDecoder().decode(
    encoded.subarray(4, 4 + jsonLength),
  );
  const blobs: Uint8Array[] = [];
  let offset = 4 + jsonLength;
  while (offset < encoded.byteLength) {
    if (offset + 4 > encoded.byteLength) {
      throw new Error("encoded message ends inside a blob header");
    }
    const blobLength = view.getUint32(offset, true);
    if (offset + 4 + blobLength > encoded.byteLength) {
      throw new Error("encoded message ends inside a blob");
    }
    blobs.push(encoded.subarray(offset + 4, offset + 4 + blobLength));
    offset += 4 + blobLength;
  }
  return JSON.parse(json, (_key, node: unknown) => {
    if (!isBinaryMarker(node)) return node;
    const blob = blobs[node[BINARY_TAG]];
    if (blob === undefined) {
      throw new Error(`encoded message references missing blob ${node[BINARY_TAG]}`);
    }
    // Both kinds are sliced out as standalone buffers: a view aliasing the
    // received buffer would drag the whole encoded message along on every
    // structured clone.
    return node.as === "bytes" ? blob.slice() : blob.slice().buffer;
  });
}
