// V8 end-to-end validation harness for the fork-module CAPTURE session
// (Path B P3 — the module-owned encode graph over the shared
// `fork_codec::ReferenceGraphBuilder`).
//
// This proves, in a real production WebAssembly engine (Node's V8 — the same
// engine the Node and browser process workers run), that the `fm_capture_*`
// exports correctly drive the SHARED Rust capture builder from a host: they
// intern each reference kind by resolved COORDINATE, dedup, claim/define GC
// aggregates by reading scalar/edge spans out of linear memory, build reference
// vectors, gate a canonical placeholder for the no-provenance path, validate the
// canonical capture, and serialize the graph into the KFRV/KFRS record stream
// the host drains into its module-state arena. The builder's own round-trip
// against the decoder is proven in-crate (`fork-codec`
// reference_segments_writer tests, 431 passing); this harness proves the WASM
// EXPORT surface + memory reads + record-stream framing + proof-of-use counter
// on the actual engine, which no host-triple Rust test can.
//
// Run: node crates/fork-module/tests/harness-capture.mjs <path-to-fork_module.wasm>

import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

const wasmPath = process.argv[2];
if (!wasmPath) {
  console.error("usage: node harness-capture.mjs <path-to-fork_module.wasm>");
  process.exit(2);
}

const PAGE = 65536;
const EINVAL = 22;

// Shared-ABI constants mirrored from crates/shared/src/lib.rs (the module and
// this harness both read the same authoritative values).
const OWNER_ID = 1; // WPK_FORK_REFERENCE_TRANSACTION_OWNER
const RECORD_KIND_MANIFEST = 2; // ..._RECORD_KIND_REFERENCE_RECIPE (carries KFRV)
const RECORD_KIND_SEGMENT = 12; // ..._RECORD_KIND_REFERENCE_RECIPE_SEGMENT (KFRS)
const SEGMENT_WINDOW = 1 << 16; // per-segment copy window (single segment/section)

// GC aggregate kinds fm_capture_define_gc accepts.
const KIND_STRUCT = 1;
const KIND_ARRAY = 2;

// -- Host memory layout (mirrors the production worker / harness.mjs) ----------
const MODULE_BASE = 32 * 1024 * 1024; // __memory_base
const MODULE_MEM = 16 * 1024 * 1024;
const STACK_LOW = MODULE_BASE + MODULE_MEM;
const STACK_SIZE = 1024 * 1024;
const STACK_TOP = STACK_LOW + STACK_SIZE;
const TABLE_BASE = 0;
// A scratch region in the low (guest-proxied) area for the argument arrays this
// harness hands to fm_capture_define_gc. Well below MODULE_BASE, so it never
// collides with the module's own data / BSS / stack.
const SCRATCH_BASE = 1 * 1024 * 1024;

const INITIAL_PAGES = Math.ceil((STACK_TOP + PAGE) / PAGE);
const memory = new WebAssembly.Memory({
  initial: INITIAL_PAGES,
  maximum: 16384,
  shared: true,
});

const importObject = {
  env: {
    memory,
    __indirect_function_table: new WebAssembly.Table({ element: "anyfunc", initial: 0 }),
    __wpk_fork_function_catalog: new WebAssembly.Table({ element: "anyfunc", initial: 0 }),
    __wpk_fork_drive_table: new WebAssembly.Table({ element: "anyfunc", initial: 0 }),
    __wpk_fork_static_root_catalog: new WebAssembly.Table({ element: "anyref", initial: 0 }),
    __stack_pointer: new WebAssembly.Global({ value: "i32", mutable: true }, STACK_TOP),
    __memory_base: new WebAssembly.Global({ value: "i32", mutable: false }, MODULE_BASE),
    __table_base: new WebAssembly.Global({ value: "i32", mutable: false }, TABLE_BASE),
    resolve_externref: (_handle) => ({}),
  },
};

const bytes = readFileSync(wasmPath);
const module = new WebAssembly.Module(bytes);

const exportNames = new Set(WebAssembly.Module.exports(module).map((e) => e.name));
for (const name of [
  "fm_capture_begin",
  "fm_capture_intern_funcref",
  "fm_capture_intern_externref",
  "fm_capture_intern_i31",
  "fm_capture_intern_static_root",
  "fm_capture_claim_gc",
  "fm_capture_gated_placeholder",
  "fm_capture_define_gc",
  "fm_capture_begin_vector",
  "fm_capture_append_vector",
  "fm_capture_finish_vector",
  "fm_capture_validate",
  "fm_capture_serialize",
  "fm_capture_serialized_len",
  "fm_capture_record_header_size",
  "fm_capture_interned",
  "fm_last_errno",
]) {
  assert.ok(exportNames.has(name), `module must export ${name}`);
}

const instance = new WebAssembly.Instance(module, importObject);
const x = instance.exports;

const u8 = () => new Uint8Array(memory.buffer);
const dv = () => new DataView(memory.buffer);

function writeU32Array(offset, values) {
  const view = dv();
  values.forEach((v, i) => view.setUint32(offset + i * 4, v >>> 0, true));
  return offset;
}
function writeBytes(offset, arr) {
  u8().set(Uint8Array.from(arr), offset);
  return offset;
}
function lastErrno() {
  return x.fm_last_errno();
}

// -- Parse the record stream fm_capture_serialize produced --------------------
//
// Each record is a 16-byte header (u16 kind, u16 reserved, u32 activationId,
// u32 ownerId, u32 payloadLen) followed by payloadLen bytes. The header size is
// self-reported by the module so this stays in lockstep with it.
function drainRecords() {
  const ptr = x.fm_capture_serialize(OWNER_ID, SEGMENT_WINDOW);
  assert.ok(ptr !== 0, `fm_capture_serialize failed, errno=${lastErrno()}`);
  assert.equal(lastErrno(), 0, "serialize sets errno OK");
  const len = x.fm_capture_serialized_len();
  assert.ok(len > 0, "serialized stream is non-empty");
  const header = x.fm_capture_record_header_size();
  assert.equal(header, 16, "record header is 16 bytes");
  const view = dv();
  const bytesOut = [];
  const records = [];
  let off = ptr;
  const end = ptr + len;
  while (off < end) {
    const kind = view.getUint16(off, true);
    const activationId = view.getUint32(off + 4, true);
    const ownerId = view.getUint32(off + 8, true);
    const payloadLen = view.getUint32(off + 12, true);
    const payloadStart = off + header;
    const payload = u8().slice(payloadStart, payloadStart + payloadLen);
    records.push({ kind, activationId, ownerId, payloadLen, payload });
    off = payloadStart + payloadLen;
  }
  assert.equal(off, end, "record stream is exactly consumed");
  // Serialize once more into a raw copy for determinism comparison.
  const raw = u8().slice(ptr, ptr + len);
  bytesOut.push(...raw);
  return { records, raw };
}

function ascii(bytes) {
  return String.fromCharCode(...bytes.slice(0, 4));
}

// ============================================================================
// 1. A comprehensive graph: every intern kind, a struct<->array cycle sharing an
//    aliased externref leaf, i31/static-root leaves, and a shared/deduped vector.
// ============================================================================
x.fm_capture_begin();
assert.equal(lastErrno(), 0, "begin sets errno OK");
const before = x.fm_capture_interned();

// Claim the two aggregates first so a field edge can close the cycle.
const sId = x.fm_capture_claim_gc(); // 1: struct
const aId = x.fm_capture_claim_gc(); // 2: array
const fId = x.fm_capture_intern_funcref(10, 20); // 3
const xId = x.fm_capture_intern_externref(99); // 4
const iId = x.fm_capture_intern_i31(-5); // 5
const rId = x.fm_capture_intern_static_root(3, 7); // 6
const leafId = x.fm_capture_intern_externref(0xffffffff >>> 0); // 7 aliased leaf
assert.deepEqual([sId, aId, fId, xId, iId, rId, leafId], [1, 2, 3, 4, 5, 6, 7]);

// Dedup by coordinate: the same externref handle / funcref coordinate / i31
// value / static-root coordinate resolve to the SAME recipe id.
assert.equal(x.fm_capture_intern_externref(99), xId, "externref dedups by handle");
assert.equal(x.fm_capture_intern_funcref(10, 20), fId, "funcref dedups by coord");
assert.equal(x.fm_capture_intern_i31(-5), iId, "i31 dedups by value");
assert.equal(x.fm_capture_intern_static_root(3, 7), rId, "static root dedups");

// struct 1 -> array 2 (cycle), leaf 7 (alias); scalars read from memory.
writeBytes(SCRATCH_BASE, [0x78, 0x56, 0x34, 0x12]);
writeU32Array(SCRATCH_BASE + 16, [aId, leafId]);
assert.equal(
  x.fm_capture_define_gc(
    sId, 7 /*act*/, 2 /*type*/, 12 /*layout*/, KIND_STRUCT,
    SCRATCH_BASE, 4, SCRATCH_BASE + 16, 2, 0 /*no prov*/, 0, 0,
  ),
  0,
  `define struct failed errno=${lastErrno()}`,
);
// array 2 -> struct 1 (cycle), leaf 7 (alias).
writeBytes(SCRATCH_BASE + 64, [0xaa, 0xbb]);
writeU32Array(SCRATCH_BASE + 80, [sId, leafId]);
assert.equal(
  x.fm_capture_define_gc(
    aId, 7, 3, 13, KIND_ARRAY, SCRATCH_BASE + 64, 2, SCRATCH_BASE + 80, 2, 0, 0, 0,
  ),
  0,
  `define array failed errno=${lastErrno()}`,
);

// A shared/deduped vector: two identical builds return the same ordinal.
function buildVector(ids) {
  const h = x.fm_capture_begin_vector();
  assert.ok(h >= 0, "begin_vector");
  for (const id of ids) {
    assert.equal(x.fm_capture_append_vector(h, id), 0, "append_vector");
  }
  return x.fm_capture_finish_vector(h);
}
const o1 = buildVector([fId, xId, iId]);
const o2 = buildVector([fId, xId, iId]);
assert.equal(o1, o2, "identical vectors dedup to one ordinal");
const o3 = buildVector([sId, aId]);
assert.deepEqual([o1, o3], [1, 2], "distinct vectors take ascending ordinals");

// Proof-of-use: the module interned every one of the above through the shared
// builder (each successful op bumps the counter).
assert.ok(
  x.fm_capture_interned() > before,
  "capture proof-of-use counter advanced through the shared builder",
);

assert.equal(x.fm_capture_validate(), 0, `validate failed errno=${lastErrno()}`);

const first = drainRecords();
// The stream ends with the KFRV manifest record; the preceding records are KFRS
// segments, one section each at this window (nodes/edges/scalars/vec-index/vec).
const manifest = first.records[first.records.length - 1];
assert.equal(manifest.kind, RECORD_KIND_MANIFEST, "last record is the manifest");
assert.equal(manifest.ownerId, OWNER_ID, "manifest carries the transaction owner");
assert.equal(ascii(manifest.payload), "KFRV", "manifest payload is KFRV");
const segments = first.records.filter((r) => r.kind === RECORD_KIND_SEGMENT);
assert.ok(segments.length >= 1, "at least one KFRS segment emitted");
for (const seg of segments) {
  assert.equal(ascii(seg.payload), "KFRS", "segment payload is KFRS");
}
// The struct scalar bytes we wrote into memory must appear in the serialized
// SCALARS section — direct proof fm_capture_define_gc read guest memory.
const streamBytes = Buffer.from(first.raw);
assert.ok(
  streamBytes.includes(Buffer.from([0x78, 0x56, 0x34, 0x12])),
  "struct scalar payload read from memory reached the serialized stream",
);

// Determinism: rebuilding the identical graph serializes byte-for-byte the same.
x.fm_capture_begin();
x.fm_capture_claim_gc();
x.fm_capture_claim_gc();
x.fm_capture_intern_funcref(10, 20);
x.fm_capture_intern_externref(99);
x.fm_capture_intern_i31(-5);
x.fm_capture_intern_static_root(3, 7);
x.fm_capture_intern_externref(0xffffffff >>> 0);
writeBytes(SCRATCH_BASE, [0x78, 0x56, 0x34, 0x12]);
writeU32Array(SCRATCH_BASE + 16, [2, 7]);
x.fm_capture_define_gc(1, 7, 2, 12, KIND_STRUCT, SCRATCH_BASE, 4, SCRATCH_BASE + 16, 2, 0, 0, 0);
writeBytes(SCRATCH_BASE + 64, [0xaa, 0xbb]);
writeU32Array(SCRATCH_BASE + 80, [1, 7]);
x.fm_capture_define_gc(2, 7, 3, 13, KIND_ARRAY, SCRATCH_BASE + 64, 2, SCRATCH_BASE + 80, 2, 0, 0, 0);
buildVector([3, 4, 5]);
buildVector([3, 4, 5]);
buildVector([1, 2]);
assert.equal(x.fm_capture_validate(), 0, "second build validates");
const second = drainRecords();
assert.deepEqual(second.raw, first.raw, "capture serialization is deterministic");

// ============================================================================
// 2. The GATED path (soundness gate parity): a value with no recoverable
//    production-site provenance reserves a DISTINCT canonical placeholder leaf,
//    keeping the graph canonical and one-to-one with the host's captured-value
//    side table. Each gated placeholder is its own recipe id.
// ============================================================================
x.fm_capture_begin();
const g1 = x.fm_capture_gated_placeholder();
const g2 = x.fm_capture_gated_placeholder();
assert.deepEqual([g1, g2], [1, 2], "each gated value gets a distinct recipe id");
assert.equal(x.fm_capture_validate(), 0, "a graph of gated leaves is canonical");
const gated = drainRecords();
assert.equal(
  gated.records[gated.records.length - 1].kind,
  RECORD_KIND_MANIFEST,
  "gated capture still seals a manifest (discarded unread by the aborting fork)",
);

// ============================================================================
// 3. Truthful failure: a session with an un-completed GC claim is NOT canonical;
//    validate and serialize must fail cleanly with EINVAL, never a wrong graph.
// ============================================================================
x.fm_capture_begin();
x.fm_capture_claim_gc(); // 1: claimed but never defined
assert.equal(x.fm_capture_validate(), -1, "pending GC claim is not canonical");
assert.equal(lastErrno(), EINVAL, "validate reports EINVAL for a pending claim");
assert.equal(
  x.fm_capture_serialize(OWNER_ID, SEGMENT_WINDOW),
  0,
  "serialize refuses a non-canonical graph",
);
assert.equal(lastErrno(), EINVAL, "serialize reports EINVAL for a pending claim");

// ============================================================================
// 4. Truthful failure: an invalid coordinate (zero externref handle) is EINVAL,
//    not a fabricated recipe.
// ============================================================================
x.fm_capture_begin();
assert.equal(x.fm_capture_intern_externref(0), -1, "zero handle is rejected");
assert.equal(lastErrno(), EINVAL, "zero externref handle reports EINVAL");

console.log("fork-module capture harness: all assertions passed");
