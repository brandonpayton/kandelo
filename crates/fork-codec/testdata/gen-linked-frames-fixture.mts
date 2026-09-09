// Generates the committed cross-language round-trip fixture used by the
// Rust `fork-codec` linked continuation-frame decoder tests under
// crates/fork-codec/testdata/linked-frames-wasm32.bin.
//
// This is the drift guard for the linked-frame wire format (see
// docs/fork-instrumentation.md "Save buffer format" / "Frame format" and the
// mirrored constants in crates/shared/src/lib.rs): the fixture is emitted by
// the REAL TS allocator/validator (`LinkedForkContinuation` in
// host/src/fork-continuation.ts), then a Rust test `include_bytes!`-loads it
// and asserts the chunk/node chain decodes byte-for-byte.
//
// The emitted bytes are exactly the used prefix of the root continuation
// chunk (the page-rounded anonymous mapping the guest fork path fills). The
// Rust test reconstitutes the guest linear memory by placing these bytes at
// the chunk's page-aligned base and padding to the chunk capacity.
//
// Regenerate with (from repo root):
//   cd host && npx tsx ../crates/fork-codec/testdata/gen-linked-frames-fixture.mts
// (or via scripts/dev-shell.sh if tsx is not otherwise on PATH). This script
// only reads host/src; it adds and modifies nothing under host/.

import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  LinkedForkContinuation,
  type LinkedFrameFormatDescriptor,
} from "../../../host/src/fork-continuation";
import {
  WPK_FORK_LINKED_FRAME_FORMAT_VERSION,
  WPK_FORK_LINKED_FRAME_POINTER_WIDTHS,
  WPK_FORK_LINKED_FRAME_RECORD_ALIGNMENT,
  WPK_FORK_LINKED_FRAME_REQUIRED_FLAGS,
} from "../../../host/src/generated/abi";

const PAGE_SIZE = 65_536;
const PTR_WIDTH = 4 as const;
const FIXED_PREFIX_SIZE = 128;

const pointerFormat = WPK_FORK_LINKED_FRAME_POINTER_WIDTHS.find(
  ({ bytes }) => bytes === PTR_WIDTH,
)!;

const format: LinkedFrameFormatDescriptor = {
  version: WPK_FORK_LINKED_FRAME_FORMAT_VERSION,
  ptrWidth: PTR_WIDTH,
  alignment: WPK_FORK_LINKED_FRAME_RECORD_ALIGNMENT,
  flags: WPK_FORK_LINKED_FRAME_REQUIRED_FLAGS,
  chunkHeaderSize: pointerFormat.chunkHeaderSize,
  nodeHeaderSize: pointerFormat.nodeHeaderSize,
  fixedPrefixSize: FIXED_PREFIX_SIZE,
};

const memory = new WebAssembly.Memory({ initial: 8 });

// Simple bump allocator over the guest linear memory, matching how the host
// hands the continuation ordinary page-aligned anonymous mappings. Starts at
// the first page because address 0 is reserved.
let next = PAGE_SIZE;
const allocations: Array<{ addr: number; size: number }> = [];
function allocate(size: number): number {
  const addr = next;
  next += size;
  if (next > memory.buffer.byteLength) {
    memory.grow(Math.ceil((next - memory.buffer.byteLength) / PAGE_SIZE));
  }
  allocations.push({ addr, size });
  return addr;
}
function deallocate(): void {}

const controller = new LinkedForkContinuation(
  memory,
  format,
  allocate,
  deallocate,
  "fixture",
);

// Innermost activation reserves first during unwind; the outermost reserves
// last and becomes the committed tail. Each payload begins with the ABI frame
// header (func_index, call_index, catch selector, reference-vector ordinal)
// documented in docs/fork-instrumentation.md, followed by filler scalars.
interface FrameSpec {
  funcIndex: number;
  callIndex: number;
  scalarFill: number;
  scalarBytes: number;
}
const frames: FrameSpec[] = [
  { funcIndex: 101, callIndex: 1, scalarFill: 0xa1, scalarBytes: 8 },
  { funcIndex: 202, callIndex: 2, scalarFill: 0xb2, scalarBytes: 16 },
  { funcIndex: 303, callIndex: 3, scalarFill: 0xc3, scalarBytes: 24 },
];

const moduleBuffer = Number(controller.beginUnwind());
const root = moduleBuffer - format.chunkHeaderSize;

const nodeAddrs: number[] = [];
for (const frame of frames) {
  const payloadSize = 16 + frame.scalarBytes;
  const payload = Number(controller.reserveFrame(payloadSize));
  nodeAddrs.push(payload - format.nodeHeaderSize);
  const view = new DataView(memory.buffer);
  view.setUint32(payload + 0, frame.funcIndex, true);
  view.setUint32(payload + 4, frame.callIndex, true);
  view.setUint32(payload + 8, 0, true); // exact catch selector
  view.setUint32(payload + 12, 0, true); // reference-vector ordinal
  new Uint8Array(memory.buffer, payload + 16, frame.scalarBytes).fill(
    frame.scalarFill,
  );
  controller.commitFrame(payload);
}
controller.finishUnwind();

if (allocations.length !== 1) {
  throw new Error(
    `fixture expected a single root chunk, got ${allocations.length}`,
  );
}
const capacity = allocations[0]!.size;
const view = new DataView(memory.buffer);
const used = view.getUint32(root + 8 + 4 * PTR_WIDTH, true);

const fixture = new Uint8Array(memory.buffer, root, used).slice();

const here = dirname(fileURLToPath(import.meta.url));
const outPath = join(here, "linked-frames-wasm32.bin");
writeFileSync(outPath, fixture);

const expected = {
  file: outPath,
  ptrWidth: PTR_WIDTH,
  chunkHeaderSize: format.chunkHeaderSize,
  nodeHeaderSize: format.nodeHeaderSize,
  fixedPrefixSize: FIXED_PREFIX_SIZE,
  rootAddr: root,
  moduleBuffer,
  capacity,
  used,
  fixtureBytes: fixture.byteLength,
  // Decoded replay order is tail-first (outermost committed to innermost).
  replayOrder: [...frames]
    .reverse()
    .map((frame, index) => ({
      funcIndex: frame.funcIndex,
      callIndex: frame.callIndex,
      payloadSize: 16 + frame.scalarBytes,
      nodeAddr: [...nodeAddrs].reverse()[index],
    })),
};
console.log(JSON.stringify(expected, null, 2));
