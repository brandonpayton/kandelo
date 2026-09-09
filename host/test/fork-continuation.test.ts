import { describe, expect, it } from "vitest";
import {
  invokeForkContinuationBegin,
  readLinkedFrameFormat,
  type LinkedFrameFormatDescriptor,
} from "../src/fork-continuation";
import {
  WPK_FORK_LINKED_FRAME_DESCRIPTOR_SIZE,
  WPK_FORK_LINKED_FRAME_FORMAT_MAGIC,
  WPK_FORK_LINKED_FRAME_FORMAT_SECTION,
  WPK_FORK_LINKED_FRAME_FORMAT_VERSION,
  WPK_FORK_LINKED_FRAME_POINTER_WIDTHS,
  WPK_FORK_LINKED_FRAME_RECORD_ALIGNMENT,
  WPK_FORK_LINKED_FRAME_REQUIRED_FLAGS,
} from "../src/generated/abi";

function addressBeginExport(pointerType: 0x7f | 0x7e): WebAssembly.ExportValue {
  const module = new WebAssembly.Module(new Uint8Array([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    0x01, 0x05, 0x01, 0x60, 0x01, pointerType, 0x00,
    0x03, 0x02, 0x01, 0x00,
    0x07, 0x09, 0x01, 0x05, 0x62, 0x65, 0x67, 0x69, 0x6e, 0x00, 0x00,
    0x0a, 0x04, 0x01, 0x02, 0x00, 0x0b,
  ]));
  return new WebAssembly.Instance(module).exports.begin!;
}

describe("invokeForkContinuationBegin", () => {
  it("calls wasm32 i32 and wasm64 i64 exports with their native JS types", () => {
    const wasm32Begin = addressBeginExport(0x7f);
    const wasm64Begin = addressBeginExport(0x7e);

    expect(() => invokeForkContinuationBegin(wasm32Begin, 4096, 4, "wasm32"))
      .not.toThrow();
    expect(() => invokeForkContinuationBegin(wasm64Begin, 4096, 8, "wasm64"))
      .not.toThrow();

    // Prove this reaches V8's real i64 boundary rather than a mock function.
    expect(() => (wasm64Begin as (value: number) => void)(4096)).toThrow(TypeError);
  });

  it("rejects missing exports and invalid continuation addresses", () => {
    const wasm32Begin = addressBeginExport(0x7f);
    expect(() => invokeForkContinuationBegin(undefined, 4096, 4, "missing"))
      .toThrow("continuation begin export is not callable");
    expect(() => invokeForkContinuationBegin(wasm32Begin, 0, 4, "zero"))
      .toThrow("invalid continuation address");
    expect(() => invokeForkContinuationBegin(
      wasm32Begin,
      Number.MAX_SAFE_INTEGER + 1,
      4,
      "imprecise",
    )).toThrow("invalid continuation address");
  });
});

function formatFor(ptrWidth: 4 | 8): LinkedFrameFormatDescriptor {
  const pointerFormat = WPK_FORK_LINKED_FRAME_POINTER_WIDTHS.find(
    ({ bytes }) => bytes === ptrWidth,
  )!;
  return {
    version: WPK_FORK_LINKED_FRAME_FORMAT_VERSION,
    ptrWidth,
    alignment: WPK_FORK_LINKED_FRAME_RECORD_ALIGNMENT,
    flags: WPK_FORK_LINKED_FRAME_REQUIRED_FLAGS,
    chunkHeaderSize: pointerFormat.chunkHeaderSize,
    nodeHeaderSize: pointerFormat.nodeHeaderSize,
    fixedPrefixSize: 128,
  };
}

const FORMAT = formatFor(4);

function uleb128(value: number): number[] {
  const out: number[] = [];
  do {
    let byte = value & 0x7f;
    value >>>= 7;
    if (value !== 0) byte |= 0x80;
    out.push(byte);
  } while (value !== 0);
  return out;
}

function moduleWithLinkedDescriptor(data: number[]): WebAssembly.Module {
  const name = [...new TextEncoder().encode(WPK_FORK_LINKED_FRAME_FORMAT_SECTION)];
  const payload = [...uleb128(name.length), ...name, ...data];
  return new WebAssembly.Module(new Uint8Array([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    0x00, ...uleb128(payload.length), ...payload,
  ]));
}

function linkedDescriptorBytes(pointerWidth: 4 | 8 = 4): number[] {
  const pointerFormat = WPK_FORK_LINKED_FRAME_POINTER_WIDTHS.find(
    ({ bytes }) => bytes === pointerWidth,
  )!;
  const bytes = new Uint8Array(WPK_FORK_LINKED_FRAME_DESCRIPTOR_SIZE);
  const view = new DataView(bytes.buffer);
  bytes.set(WPK_FORK_LINKED_FRAME_FORMAT_MAGIC);
  view.setUint16(4, WPK_FORK_LINKED_FRAME_FORMAT_VERSION, true);
  view.setUint16(6, WPK_FORK_LINKED_FRAME_DESCRIPTOR_SIZE, true);
  view.setUint8(8, pointerWidth);
  view.setUint8(9, WPK_FORK_LINKED_FRAME_RECORD_ALIGNMENT);
  view.setUint16(10, WPK_FORK_LINKED_FRAME_REQUIRED_FLAGS, true);
  view.setUint32(12, pointerFormat.chunkHeaderSize, true);
  view.setUint32(16, pointerFormat.nodeHeaderSize, true);
  view.setUint32(20, 128, true);
  return [...bytes];
}

describe("readLinkedFrameFormat", () => {
  it("accepts exact generated wasm32 and wasm64 descriptors", () => {
    expect(readLinkedFrameFormat(moduleWithLinkedDescriptor(linkedDescriptorBytes())))
      .toEqual(FORMAT);
    const wasm64Format = WPK_FORK_LINKED_FRAME_POINTER_WIDTHS.find(({ bytes }) => bytes === 8)!;
    expect(readLinkedFrameFormat(moduleWithLinkedDescriptor(linkedDescriptorBytes(8))))
      .toEqual({
        ...FORMAT,
        ptrWidth: 8,
        chunkHeaderSize: wasm64Format.chunkHeaderSize,
        nodeHeaderSize: wasm64Format.nodeHeaderSize,
      });
  });

  it("rejects unknown flags before instantiation", () => {
    const bytes = linkedDescriptorBytes();
    bytes[10] = 7;
    expect(() => readLinkedFrameFormat(moduleWithLinkedDescriptor(bytes)))
      .toThrow("unsupported linked continuation flags");
  });
});
