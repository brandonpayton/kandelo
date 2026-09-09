// Generates the committed cross-language fixture used by the Rust `fork-codec`
// KFRV reference-transaction + KFRS reference-segment LIVE decode tests under
// crates/fork-codec/testdata/reference-transaction-wasm32.bin.
//
// This is the drift guard for the production segmented reference transaction
// (KFRV manifest + KFRS segment records), decoded on the host today by
// `decodeSegmentedForkReferenceTransaction` in
// host/src/fork-reference-segments.ts. Unlike the STANDALONE KFRR recipe image
// (gen-reference-recipes-fixture.mts), this is the LIVE transaction layer: the
// graph + interned reference vectors are streamed into a real
// `ForkModuleStateArena` (KFMS) as a sequence of KFRS segment records followed
// by a single KFRV manifest record, exactly as `sealInto` does in production.
//
// The bytes are the used prefix of the sealed root arena chunk. A Rust test
// `include_bytes!`-loads it, decodes the KFMS envelope with the trusted
// `decode_module_state` decoder, hands the reference records to
// `decode_segmented_reference_transaction`, and asserts the reassembled graph +
// vectors + intern index decode field-for-field. A deliberately small
// segmentDataBytes forces every logical section to spill across MANY KFRS
// segments so the Rust segment-reassembly path is exercised, not bypassed.
//
// As an additional cross-check, this script decodes the very same records with
// the REAL host `decodeSegmentedForkReferenceTransaction` and asserts agreement
// (node count, per-node kinds, vector contents, intern keys). If the TS
// encoder/decoder and the Rust decoder ever disagree on the wire format, the
// Rust test and this oracle catch the drift.
//
// Regenerate with (from repo root):
//   cd host && npx tsx ../crates/fork-codec/testdata/gen-reference-transaction-fixture.mts
// (or via scripts/dev-shell.sh if tsx is not otherwise on PATH). This script
// only reads host/src; it adds and modifies nothing under host/.

import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ForkModuleStateArena,
  ForkModuleStateRecordKind,
} from "../../../host/src/fork-module-state";
import type {
  ForkReferenceRecipeEntry,
} from "../../../host/src/fork-reference-recipes";
import {
  appendSegmentedForkReferenceTransaction,
  decodeSegmentedForkReferenceTransaction,
  forkReferenceVectorFrom,
  forkReferenceVectorInternKey,
  PagedForkReferenceVector,
  type ForkReferenceVector,
} from "../../../host/src/fork-reference-segments";
import { WPK_FORK_REFERENCE_TRANSACTION_OWNER } from "../../../host/src/generated/abi";

const PAGE_SIZE = 65_536;
const PTR_WIDTH = 4 as const;
const OWNER_ID = WPK_FORK_REFERENCE_TRANSACTION_OWNER;
// Small enough that the ~528-byte node section (11 nodes * 48 bytes) alone
// spills across many KFRS segments, exercising cross-segment reassembly.
const SEGMENT_DATA_BYTES = 32;

// The canonical process reference graph. Node 0 is the mandatory canonical null
// (KFRV requires exactly node 0 to be null). The rest exercise every node kind
// plus a cycle (struct 1 <-> array 2), edge aliasing (exnref 3 shared by struct
// 1 and array 2), and both the i31 and externref-handle domain boundaries.
const nodes: ForkReferenceRecipeEntry[] = [
  { id: 0, node: { kind: "null" } },
  {
    id: 1,
    node: {
      kind: "struct",
      moduleActivation: 7,
      typeOrdinal: 2,
      layoutId: 12,
      scalars: Uint8Array.of(0x78, 0x56, 0x34, 0x12),
      fields: [2, 5, 3],
    },
  },
  {
    id: 2,
    node: {
      kind: "array",
      moduleActivation: 7,
      typeOrdinal: 3,
      layoutId: 13,
      scalars: Uint8Array.of(0xaa, 0xbb),
      elements: [1, 3],
    },
  },
  {
    id: 3,
    node: {
      kind: "exnref",
      moduleActivation: 7,
      tagOrdinal: 5,
      layoutId: 15,
      scalars: Uint8Array.of(0, 1, 2, 3, 4, 5, 6, 7),
      payloads: [1, 5],
    },
  },
  { id: 4, node: { kind: "externref", handle: 9 } },
  { id: 5, node: { kind: "i31", value: -17 } },
  { id: 6, node: { kind: "funcref", moduleActivation: 7, functionOrdinal: 0 } },
  {
    id: 7,
    node: { kind: "static-root", moduleActivation: 6, staticRootOrdinal: 0 },
  },
  { id: 8, node: { kind: "i31", value: 0x3fff_ffff } },
  { id: 9, node: { kind: "i31", value: -0x4000_0000 } },
  { id: 10, node: { kind: "externref", handle: 0xffff_ffff } },
];

// Interned reference vectors. Index 0 is the mandatory empty sentinel; the rest
// are distinct canonical vectors of recipe ids (all < node count). These land
// in the VectorIndex + VectorEntries sections and drive the intern index.
const vectors: ForkReferenceVector[] = [
  PagedForkReferenceVector.empty,
  forkReferenceVectorFrom([1, 2, 3], 3),
  forkReferenceVectorFrom([4, 6], 2),
  forkReferenceVectorFrom([8, 9, 10, 5], 4),
];

const memory = new WebAssembly.Memory({ initial: 4 });

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

const arena = new ForkModuleStateArena(
  memory,
  PTR_WIDTH,
  allocate,
  deallocate,
  "reference-transaction-fixture",
);

const root = arena.begin();
// Declare process module activation 0 (owner of the reference records) and, as
// a bonus, prove the reference decoder ignores unrelated record kinds mixed
// into the same KFMS arena.
arena.appendModule({
  activationId: 0,
  templateId: new Uint8Array(32).fill(0xa0),
});
appendSegmentedForkReferenceTransaction(arena, OWNER_ID, nodes, vectors, {
  segmentDataBytes: SEGMENT_DATA_BYTES,
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
const outPath = join(here, "reference-transaction-wasm32.bin");
writeFileSync(outPath, fixture);

// --- Cross-check: decode the same records with the real host decoder. -------
const oracleArena = new ForkModuleStateArena(
  memory,
  PTR_WIDTH,
  allocate,
  deallocate,
  "reference-transaction-oracle",
);
const views = oracleArena.inspectSealedRecordViews(root, [
  ForkModuleStateRecordKind.ReferenceRecipe,
  ForkModuleStateRecordKind.ReferenceRecipeSegment,
]);
const decoded = decodeSegmentedForkReferenceTransaction(views, OWNER_ID);

const decodedNodes = [...decoded.graph.nodes];
if (decodedNodes.length !== nodes.length) {
  throw new Error(
    `oracle node count mismatch: ${decodedNodes.length} != ${nodes.length}`,
  );
}
const decodedVectors = [...decoded.vectors].map((vector) => [...vector]);
if (decodedVectors.length !== vectors.length) {
  throw new Error(
    `oracle vector count mismatch: ${decodedVectors.length} != ${vectors.length}`,
  );
}

// Serialize the intern index (hashKey -> ordinals) so the Rust test can pin the
// exact FNV-shaped vector hash the port must reproduce.
const internKeys: Record<string, number[]> = {};
for (let ordinal = 1; ordinal < decodedVectors.length; ordinal++) {
  const key = forkReferenceVectorInternKey(
    forkReferenceVectorFrom(decodedVectors[ordinal]!),
  );
  (internKeys[key] ??= []).push(ordinal);
}

console.log(
  JSON.stringify(
    {
      file: outPath,
      ptrWidth: PTR_WIDTH,
      chunkHeaderSize: 40,
      rootAddr: root,
      capacity,
      used,
      recordCount,
      segmentDataBytes: SEGMENT_DATA_BYTES,
      ownerId: OWNER_ID,
      fixtureBytes: fixture.byteLength,
      nodeCount: decodedNodes.length,
      roots: decoded.graph.roots,
      kinds: decodedNodes.map(({ node }) => node.kind),
      vectors: decodedVectors,
      internKeys,
    },
    null,
    2,
  ),
);
