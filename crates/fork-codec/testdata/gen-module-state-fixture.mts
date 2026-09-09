// Generates the committed cross-language round-trip fixture used by the
// Rust `fork-codec` module-state (KFMS) decoder tests under
// crates/fork-codec/testdata/module-state-wasm32.bin.
//
// This is the drift guard for the KFMS arena wire format (see
// docs/fork-instrumentation.md "Module-state arena" and the mirrored
// constants in crates/shared/src/lib.rs): the fixture is emitted by the REAL
// TS arena controller (`ForkModuleStateArena` in host/src/fork-module-state.ts)
// via begin/appendModule/appendRecord/seal, then a Rust test
// `include_bytes!`-loads it and asserts the sealed chunk + record TLV chain
// decodes byte-for-byte.
//
// The emitted bytes are exactly the used prefix of the sealed root arena chunk
// (the page-rounded anonymous mapping the guest fork path fills). The Rust test
// reconstitutes the guest linear memory by placing these bytes at the chunk's
// page-aligned base and padding to the chunk capacity.
//
// Regenerate with (from repo root):
//   cd host && npx tsx ../crates/fork-codec/testdata/gen-module-state-fixture.mts
// (or via scripts/dev-shell.sh if tsx is not otherwise on PATH). This script
// only reads host/src; it adds and modifies nothing under host/.

import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ForkModuleStateArena,
  ForkModuleStateRecordKind,
} from "../../../host/src/fork-module-state";
import {
  WPK_FORK_MODULE_STATE_GLOBAL_HEADER_SIZE,
  WPK_FORK_MODULE_STATE_GLOBAL_TYPE_I32,
} from "../../../host/src/generated/abi";

const PAGE_SIZE = 65_536;
const PTR_WIDTH = 4 as const;

const memory = new WebAssembly.Memory({ initial: 4 });

// Simple bump allocator over the guest linear memory, matching how the host
// hands the arena ordinary page-aligned anonymous mappings. Starts at the
// first page because address 0 is reserved.
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

function templateId(byte: number): Uint8Array {
  return new Uint8Array(32).fill(byte);
}

function mutableI32(value: number): Uint8Array {
  const payload = new Uint8Array(WPK_FORK_MODULE_STATE_GLOBAL_HEADER_SIZE + 4);
  const view = new DataView(payload.buffer);
  view.setUint8(0, WPK_FORK_MODULE_STATE_GLOBAL_TYPE_I32);
  view.setUint8(1, 4);
  view.setInt32(WPK_FORK_MODULE_STATE_GLOBAL_HEADER_SIZE, value, true);
  return payload;
}

const arena = new ForkModuleStateArena(
  memory,
  PTR_WIDTH,
  allocate,
  deallocate,
  "fixture",
);

const root = arena.begin();
arena.appendModule({ activationId: 0, templateId: templateId(0xa0) });
arena.appendRecord({
  kind: ForkModuleStateRecordKind.MutableGlobal,
  activationId: 0,
  ownerId: 2,
  payload: mutableI32(0x0908_0706),
});
arena.seal();

if (allocations.length !== 1) {
  throw new Error(
    `fixture expected a single root chunk, got ${allocations.length}`,
  );
}
const capacity = allocations[0]!.size;
const view = new DataView(memory.buffer);
// Chunk used-bytes field is the fifth pointer word (chunkOffset field 4).
const used = view.getUint32(root + 8 + 4 * PTR_WIDTH, true);
const recordCount = view.getUint32(root + 8 + 5 * PTR_WIDTH, true);

const fixture = new Uint8Array(memory.buffer, root, used).slice();

const here = dirname(fileURLToPath(import.meta.url));
const outPath = join(here, "module-state-wasm32.bin");
writeFileSync(outPath, fixture);

// Decode the record framing so the Rust test can assert exact offsets/values.
const CHUNK_HEADER_SIZE = 40; // wasm32
const RECORD_HEADER_SIZE = 24;
const records: Array<Record<string, number>> = [];
let offset = CHUNK_HEADER_SIZE;
while (offset < used) {
  const addr = root + offset;
  const kind = view.getUint16(addr + 6, true);
  const totalSize = view.getUint32(addr + 8, true);
  const payloadSize = view.getUint32(addr + 12, true);
  const activationId = view.getUint32(addr + 16, true);
  const ownerId = view.getUint32(addr + 20, true);
  records.push({
    offset,
    kind,
    totalSize,
    payloadSize,
    activationId,
    ownerId,
    firstPayloadByte: view.getUint8(addr + RECORD_HEADER_SIZE),
  });
  offset += totalSize;
}

const expected = {
  file: outPath,
  ptrWidth: PTR_WIDTH,
  chunkHeaderSize: CHUNK_HEADER_SIZE,
  recordHeaderSize: RECORD_HEADER_SIZE,
  rootAddr: root,
  capacity,
  used,
  recordCount,
  fixtureBytes: fixture.byteLength,
  records,
};
console.log(JSON.stringify(expected, null, 2));
