// Generates the committed cross-language round-trip fixture used by the Rust
// `fork-codec` KFMS per-record-kind payload decoder tests under
// crates/fork-codec/testdata/module-state-records-wasm32.bin.
//
// This is the drift guard for the KFMS record PAYLOAD wire formats (the module
// template, mutable-global snapshot, sparse-table descriptor/page, and
// element/data segment bitmaps). It is the payload-layer companion to
// gen-module-state-fixture.mts (which guards only the chunk/record TLV
// envelope).
//
// The fixture is emitted by the REAL host TS arena controller
// (`ForkModuleStateArena` in host/src/fork-module-state.ts) through its public
// append API:
//   * appendModule            -> Module record (encodeModulePayload)
//   * appendRecord            -> MutableGlobal records (i32 + funcref)
//   * appendSparseTable       -> Table descriptor + TablePage records
//                                (internally round-trips through the real
//                                 decodeTableDescriptor + validateSparseTablePage)
//   * appendElementSegmentState -> ElementSegments record (encodeElementSegments)
//   * appendDataSegmentState    -> DataSegments record   (encodeDataSegments)
// then seal(). The used prefix of the sealed root chunk is committed. A Rust
// test `include_bytes!`-loads it, decodes the envelope, and asserts each record
// payload decodes byte-for-byte.
//
// As an additional cross-check, after committing the bytes this script builds a
// FRESH arena over the same memory and re-validates the sealed chunk + record
// envelope with the real host `inspectSealedRecordViews`, then decodes the two
// mutable-global payloads with the real exported `decodeForkGlobalSnapshot`. If
// the TS encoders/decoders and the Rust decoders ever disagree, the Rust test
// and this oracle catch the drift.
//
// Regenerate with (from repo root):
//   cd host && npx tsx ../crates/fork-codec/testdata/gen-module-state-records-fixture.mts
// (or via scripts/dev-shell.sh if tsx is not otherwise on PATH). This script
// only reads host/src; it adds and modifies nothing under host/.

import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ForkModuleStateArena,
  ForkModuleStateRecordKind,
  decodeForkGlobalSnapshot,
} from "../../../host/src/fork-module-state";
import {
  WPK_FORK_MODULE_STATE_GLOBAL_HEADER_SIZE,
  WPK_FORK_MODULE_STATE_GLOBAL_TYPE_FUNCREF,
  WPK_FORK_MODULE_STATE_GLOBAL_TYPE_I32,
} from "../../../host/src/generated/abi";

const PAGE_SIZE = 65_536;
const PTR_WIDTH = 4 as const;

const memory = new WebAssembly.Memory({ initial: 4 });

// Bump allocator over the guest linear memory, matching how the host hands the
// arena page-aligned anonymous mappings. Starts at the first page because
// address 0 is reserved.
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

function filled(size: number, byte: number): Uint8Array {
  return new Uint8Array(size).fill(byte);
}

function mutableI32(value: number): Uint8Array {
  const payload = new Uint8Array(WPK_FORK_MODULE_STATE_GLOBAL_HEADER_SIZE + 4);
  const view = new DataView(payload.buffer);
  view.setUint8(0, WPK_FORK_MODULE_STATE_GLOBAL_TYPE_I32);
  view.setUint8(1, 4);
  view.setInt32(WPK_FORK_MODULE_STATE_GLOBAL_HEADER_SIZE, value, true);
  return payload;
}

function mutableFuncref(recipeId: number): Uint8Array {
  const payload = new Uint8Array(WPK_FORK_MODULE_STATE_GLOBAL_HEADER_SIZE + 4);
  const view = new DataView(payload.buffer);
  view.setUint8(0, WPK_FORK_MODULE_STATE_GLOBAL_TYPE_FUNCREF);
  view.setUint8(1, 4);
  view.setUint32(WPK_FORK_MODULE_STATE_GLOBAL_HEADER_SIZE, recipeId, true);
  return payload;
}

const arena = new ForkModuleStateArena(
  memory,
  PTR_WIDTH,
  allocate,
  deallocate,
  "records-fixture",
);

const root = arena.begin();

// Module record (kind 1): 32-byte template id filled with 0xa0.
arena.appendModule({ activationId: 0, templateId: filled(32, 0xa0) });

// MutableGlobal i32 (kind 3): value 0x0908_0706 (little-endian bytes 06 07 08 09).
arena.appendRecord({
  kind: ForkModuleStateRecordKind.MutableGlobal,
  activationId: 0,
  ownerId: 2,
  payload: mutableI32(0x0908_0706),
});

// MutableGlobal funcref (kind 3): reference type carrying recipe id 0x1122_3344.
arena.appendRecord({
  kind: ForkModuleStateRecordKind.MutableGlobal,
  activationId: 0,
  ownerId: 3,
  payload: mutableFuncref(0x1122_3344),
});

// Sparse table (kind 4 descriptor + kind 5 page): page shift 10 (page size
// 1024), final length 4096, baseline length 16, one page with two override runs
// [start2: recipes 7,8,9] and [start10: recipe 42].
arena.appendSparseTable({
  activationId: 0,
  ownerId: 5,
  indexWidth: 4,
  pageShift: 10,
  length: 4096,
  baselineLength: 16,
  baselineFingerprint: filled(32, 0xbb),
  pages: [
    {
      pageIndex: 0,
      runs: [
        { start: 2, recipeIds: [7, 8, 9] },
        { start: 10, recipeIds: [42] },
      ],
    },
  ],
});

// ElementSegments (kind 6): 12 segments, 2-byte bitmap. The final byte may only
// use its low 4 bits (12 % 8 == 4), so 0x0a is valid and 0xb5/0x0a exercises a
// mix of dropped and live segments.
arena.appendElementSegmentState({
  activationId: 0,
  ownerId: 6,
  segmentCount: 12,
  dropped: new Uint8Array([0xb5, 0x0a]),
});

// DataSegments (kind 7): 8 segments, 1-byte bitmap (no trailing-bit constraint).
arena.appendDataSegmentState({
  activationId: 0,
  ownerId: 7,
  segmentCount: 8,
  dropped: new Uint8Array([0xc3]),
});

arena.seal();

if (allocations.length !== 1) {
  throw new Error(
    `fixture expected a single root chunk, got ${allocations.length}`,
  );
}
const capacity = allocations[0]!.size;
const view = new DataView(memory.buffer);
const used = view.getUint32(root + 8 + 4 * PTR_WIDTH, true);
const recordCount = view.getUint32(root + 8 + 5 * PTR_WIDTH, true);

const fixture = new Uint8Array(memory.buffer, root, used).slice();

const here = dirname(fileURLToPath(import.meta.url));
const outPath = join(here, "module-state-records-wasm32.bin");
writeFileSync(outPath, fixture);

// --- Cross-check: re-validate the committed bytes with the real host decoders.
const CHUNK_HEADER_SIZE = 40; // wasm32
const RECORD_HEADER_SIZE = 24;

const oracle = new ForkModuleStateArena(
  memory,
  PTR_WIDTH,
  allocate,
  deallocate,
  "records-fixture-oracle",
);
const views = oracle.inspectSealedRecordViews(root, [
  ForkModuleStateRecordKind.Module,
  ForkModuleStateRecordKind.MutableGlobal,
  ForkModuleStateRecordKind.Table,
  ForkModuleStateRecordKind.TablePage,
  ForkModuleStateRecordKind.ElementSegments,
  ForkModuleStateRecordKind.DataSegments,
]);

const globals = views
  .filter((record) => record.kind === ForkModuleStateRecordKind.MutableGlobal)
  .map((record) => {
    const snapshot = decodeForkGlobalSnapshot(record.payload, "oracle global");
    return {
      ownerId: record.ownerId,
      typeCode: snapshot.typeCode,
      valueBytes: Array.from(snapshot.value),
      recipeId: snapshot.recipeId ?? null,
    };
  });

// Decode the record framing so the Rust test can assert exact offsets/values.
const records: Array<Record<string, number>> = [];
let offset = CHUNK_HEADER_SIZE;
while (offset < used) {
  const addr = root + offset;
  const kind = view.getUint16(addr + 6, true);
  const totalSize = view.getUint32(addr + 8, true);
  const payloadSize = view.getUint32(addr + 12, true);
  const activationId = view.getUint32(addr + 16, true);
  const ownerId = view.getUint32(addr + 20, true);
  records.push({ offset, kind, totalSize, payloadSize, activationId, ownerId });
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
  recordKindsInOrder: records.map((record) => record.kind),
  records,
  oracleGlobals: globals,
};
console.log(JSON.stringify(expected, null, 2));
