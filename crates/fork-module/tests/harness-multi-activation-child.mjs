// MULTI-ACTIVATION CHILD-REPLAY round-trip validation for the co-resident
// fork-module (Phase 6 D7a.1a-module). THIS IS THE KEY DELIVERABLE of this
// slice: it proves, in a real production WebAssembly engine (Node's V8), the
// hard core of a dlopen multi-activation fork — a full
//   parent unwind (N activations, interleaved)
//     -> serialize journal
//     -> address-space COPY (simulated) + scrub of the parent module region
//     -> a FRESH CHILD instance at a DIFFERENT __memory_base, empty journal
//     -> child seeds journal + activation 0 + each side activation
//     -> child drives the global reverse rewind across every activation
// reconstructs EACH activation's own frames, byte-for-byte, from COPIED guest
// memory only, in the parent's exact global reverse-commit order, with the
// resume slots resolved PER ACTIVATION from PER-ACTIVATION resume catalogs.
//
// It asserts:
//   (a) each activation reconstructs ITS OWN frames with byte-identical
//       payloads from the COPIED memory at a DIFFERENT module placement;
//   (b) the global reverse-commit (interleaved) order is honored across
//       activations in lockstep with the single process-wide journal;
//   (c) resume slots resolve PER ACTIVATION from the PER-ACTIVATION catalogs
//       (the catalogs are SUPERSETS of the committed ordinals, so the slot
//       numbering is provably catalog-derived, not committed-derived);
//   (d) NO cross-activation aliasing (wrong-activation calls are rejected);
//   (e) the child mirrors the parent oracle exactly (order + slots + payloads).
// The single-activation child round trip is covered by the sibling harness.mjs,
// which this slice leaves byte-identical (regression).
//
// Run: node crates/fork-module/tests/harness-multi-activation-child.mjs <fork_module.wasm>

import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

import { instantiateTrampoline } from "./fork-trampoline.mjs";

const wasmPath = process.argv[2];
if (!wasmPath) {
  console.error("usage: node harness-multi-activation-child.mjs <path-to-fork_module.wasm>");
  process.exit(2);
}

const PAGE = 65536;
const MiB = 1024 * 1024;
const EINVAL = 22;

const bytes = readFileSync(wasmPath);
const module = new WebAssembly.Module(bytes);

// Structural check: the new multi-activation child-replay + per-activation
// resume-catalog exports are present (alongside the D7a.2 surface).
const exportNames = new Set(WebAssembly.Module.exports(module).map((e) => e.name));
for (const need of [
  "fm_set_activation_resume_catalog",
  "fm_add_activation_child_replay",
  // D7a.2 surface these build on.
  "fm_add_activation_unwind",
  "fm_begin_child_replay",
  "fm_serialize_journal_fixed_arena",
  "fm_frame_reserve",
  "fm_frame_commit",
  "fm_frame_peek",
  "fm_frame_next",
  "fm_resume_peek",
]) {
  assert.ok(exportNames.has(need), `module must export ${need}`);
}

// Inert engine-floor stubs (this reference-free frame path never calls them).
const forkHostStubs = {};
for (const imp of WebAssembly.Module.imports(module)) {
  if (imp.module === "wpk_fork_host" && !(imp.name in forkHostStubs)) {
    forkHostStubs[imp.name] = () => 0;
  }
}

function instantiateAt(mem, moduleBase, stackTop) {
  return new WebAssembly.Instance(module, {
    env: {
      memory: mem,
      __indirect_function_table: new WebAssembly.Table({ element: "anyfunc", initial: 0 }),
      __wpk_fork_function_catalog: new WebAssembly.Table({ element: "anyfunc", initial: 0 }),
      __wpk_fork_drive_table: new WebAssembly.Table({ element: "anyfunc", initial: 0 }),
      // M2: the merged, host-owned static-root catalog (anyref) the injected
      // drive shim reads on a DRIVE_OP_STATIC_ROOT step. This reference-free
      // frame-routing harness never drives a reference replay, so an empty
      // table is inert here.
      __wpk_fork_static_root_catalog: new WebAssembly.Table({ element: "anyref", initial: 0 }),
      __stack_pointer: new WebAssembly.Global({ value: "i32", mutable: true }, stackTop),
      __memory_base: new WebAssembly.Global({ value: "i32", mutable: false }, moduleBase),
      __table_base: new WebAssembly.Global({ value: "i32", mutable: false }, 0),
      // M2: the single residual externref host import,
      // `resolve_externref(handle) -> externref`. Never exercised here; a
      // stub returning a fresh unique object per call satisfies the
      // reference-returning import signature.
      resolve_externref: (_handle) => ({}),
    },
    wpk_fork_host: forkHostStubs,
  });
}

function memViews(mem) {
  const u8 = () => new Uint8Array(mem.buffer);
  const dv = () => new DataView(mem.buffer);
  return {
    u8,
    dv,
    readU32: (off) => dv().getUint32(off, true),
    writeU32: (off, val) => dv().setUint32(off, val >>> 0, true),
    readByte: (off) => u8()[off],
  };
}

function sentinelByte(off) {
  return ((off * 2654435761) >>> 24) & 0xff;
}

// -- Layout (disjoint, so a whole-memory byte copy is lossless) ----------------
//   [0, MB_A)              low guest data (sentinel proxy)
//   [MB_A, PSTACK_TOP)     PARENT module data + BSS + stack (__memory_base A)
//   [MB_B, CSTACK_TOP)     CHILD  module data + BSS + stack (__memory_base B)
//   [IMAGE_BASE, +CAP)     serialized KFRE journal image
//   [ARENA{0,1,2}_BASE, +LEN)  per-activation linked-frame arenas
const MB_A = 8 * MiB;
const MOD_MEM = 8 * MiB;
const PSTACK_TOP = MB_A + MOD_MEM + 1 * MiB; // 17 MiB
const MB_B = 18 * MiB;
const CSTACK_TOP = MB_B + MOD_MEM + 1 * MiB; // 27 MiB
const IMAGE_BASE = 28 * MiB;
const IMAGE_CAP = 1 * MiB;
const ARENA0_BASE = 32 * MiB;
const ARENA1_BASE = 36 * MiB;
const ARENA2_BASE = 40 * MiB;
const ARENA_LEN = 4 * MiB;
const ARENA2_END = ARENA2_BASE + ARENA_LEN; // 44 MiB
const SENTINEL_END = MB_A;
const PAGES = Math.ceil((ARENA2_END + PAGE) / PAGE);

assert.ok(PSTACK_TOP <= MB_B, "parent region below child base");
assert.ok(CSTACK_TOP <= IMAGE_BASE, "child region below image");
assert.ok(IMAGE_BASE + IMAGE_CAP <= ARENA0_BASE, "image below arenas");
assert.ok(ARENA0_BASE + ARENA_LEN <= ARENA1_BASE, "arena 0 below arena 1");
assert.ok(ARENA1_BASE + ARENA_LEN <= ARENA2_BASE, "arena 1 below arena 2");

// Each activation: its own arena, its own module-buffer fixed prefix (dlopen
// side modules carry their own prefix), and its own resume CATALOG.
const ACTS = [
  { id: 0, arenaBase: ARENA0_BASE, prefix: 128, catalog: [50, 101, 202, 303] },
  { id: 1, arenaBase: ARENA1_BASE, prefix: 256, catalog: [301, 302, 400] },
  { id: 2, arenaBase: ARENA2_BASE, prefix: 192, catalog: [500, 501] },
];
const arenaFor = (id) => ACTS.find((a) => a.id === id).arenaBase;

// The catalogs are SUPERSETS of the committed ordinals (50/400/... are never
// committed), so a catalog-derived slot numbering is provably NOT the
// committed-only numbering. Slots are assigned across activations in
// registration order (act 0, then 1, then 2), each catalog sorted ascending.
const CATALOG_PTR_BASE = 30 * MiB; // scratch for writing catalog arrays into memory
function computeExpectedSlots() {
  const slot = new Map(); // `${act}:${ord}` -> slot
  let next = 1;
  for (const a of ACTS) {
    for (const ord of [...a.catalog].sort((x, y) => x - y)) {
      slot.set(`${a.id}:${ord}`, next++);
    }
  }
  return slot;
}
const EXPECTED_SLOT = computeExpectedSlots();
const slotOf = (act, func) => EXPECTED_SLOT.get(`${act}:${func}`);

// Interleaved leaf-to-root commit sequence across THREE activations. act 0
// funcs {101,202,303}; act 1 {301,302}; act 2 {500,501} — each a subset of its
// catalog. Frame func 202 is oversized to force a second chunk in arena 0.
const commits = [
  { act: 0, func: 101, call: 1, fill: 0xa1, size: 40 },
  { act: 1, func: 301, call: 1, fill: 0xc1, size: 48 },
  { act: 2, func: 500, call: 1, fill: 0xe1, size: 40 },
  { act: 0, func: 202, call: 2, fill: 0xb2, size: 65216 },
  { act: 1, func: 302, call: 2, fill: 0xc2, size: 56 },
  { act: 2, func: 501, call: 2, fill: 0xe2, size: 44 },
  { act: 0, func: 303, call: 3, fill: 0xb3, size: 40 },
];

function writePayload(mv, payload, func, call, fill, size) {
  mv.writeU32(payload + 0, func);
  mv.writeU32(payload + 4, call);
  mv.writeU32(payload + 8, 0);
  mv.writeU32(payload + 12, 0);
  const buf = mv.u8();
  for (let i = 16; i < size; i++) buf[payload + i] = fill;
}

// Write an activation's catalog as a little-endian u32 array into memory and
// seed it via fm_set_activation_resume_catalog. Distinct scratch region per
// activation so the parent's seeded arrays do not overlap.
function seedCatalog(inst, mv, a) {
  const ptr = CATALOG_PTR_BASE + a.id * 4096;
  for (let i = 0; i < a.catalog.length; i++) mv.writeU32(ptr + i * 4, a.catalog[i]);
  inst.exports.fm_set_activation_resume_catalog(a.id, ptr, a.catalog.length);
  assert.equal(inst.exports.fm_last_errno(), 0, `seed catalog act ${a.id}`);
}

console.log("fork-module MULTI-ACTIVATION CHILD-REPLAY round-trip harness (Node/V8):");

// === PARENT: unwind N interleaved activations, serialize, drive as oracle. ===
const parentMemory = new WebAssembly.Memory({ initial: PAGES, maximum: 16384, shared: true });
const P = instantiateAt(parentMemory, MB_A, PSTACK_TOP);
const pm = memViews(parentMemory);
const perr = () => P.exports.fm_last_errno();

// Low guest sentinel below both module bases (co-residency proxy).
{
  const buf = pm.u8();
  for (let off = 0; off < SENTINEL_END; off++) buf[off] = sentinelByte(off);
}

// Seed format (act 0 = main module prefix) + a catalog per activation.
P.exports.fm_set_format(4, ACTS[0].prefix);
assert.equal(perr(), 0, "parent set_format");
for (const a of ACTS) seedCatalog(P, pm, a);

// Open activation 0, then add activations 1..N (each own arena + prefix).
// fm_begin_unwind_fixed_arena / fm_add_activation_unwind_fixed_arena are the
// in-realm, no-servicer siblings of fm_begin_unwind / fm_add_activation_unwind
// (Option B, channel-based) — the latter block forever in
// memory_atomic_wait32 waiting for a host syscall-channel servicer this bare
// Node harness does not provide.
const mb = {};
mb[0] = P.exports.fm_begin_unwind_fixed_arena(0, ACTS[0].arenaBase, ARENA_LEN) >>> 0;
assert.equal(perr(), 0, "parent begin_unwind act 0");
for (const a of ACTS.slice(1)) {
  mb[a.id] = P.exports.fm_add_activation_unwind_fixed_arena(a.id, a.arenaBase, ARENA_LEN, a.prefix) >>> 0;
  assert.equal(perr(), 0, `parent add_activation_unwind act ${a.id}`);
  assert.ok(mb[a.id] >= a.arenaBase && mb[a.id] < a.arenaBase + ARENA_LEN, `act ${a.id} buffer in arena`);
}

const TP = Object.fromEntries(ACTS.map((a) => [a.id, instantiateTrampoline(P, a.id)]));

for (const c of commits) {
  const payload = TP[c.act].__wpk_fork_frame_reserve(c.size) >>> 0;
  assert.equal(perr(), 0, `parent reserve act ${c.act} func ${c.func}`);
  const base = arenaFor(c.act);
  assert.ok(payload >= base && payload < base + ARENA_LEN, `act ${c.act} payload in its arena`);
  writePayload(pm, payload, c.func, c.call, c.fill, c.size);
  TP[c.act].__wpk_fork_frame_commit(payload);
  assert.equal(perr(), 0, `parent commit act ${c.act} func ${c.func}`);
}
P.exports.fm_finish_unwind();
assert.equal(perr(), 0, "parent finish_unwind");

// fm_serialize_journal_fixed_arena is the in-realm, no-servicer sibling of
// fm_serialize_journal_alloc; it returns the BASE pointer (not the length —
// read that back separately via fm_journal_image_len, an i64/BigInt export).
const imagePtr = P.exports.fm_serialize_journal_fixed_arena(IMAGE_BASE, IMAGE_CAP) >>> 0;
assert.equal(perr(), 0, "parent serialize_journal");
assert.equal(imagePtr, IMAGE_BASE, "serialize_journal returns the base pointer");
const imageLen = Number(P.exports.fm_journal_image_len());
assert.ok(imageLen <= IMAGE_CAP, "KFRE image fits region");
console.log(`  ok: parent unwound ${commits.length} interleaved frames across ${ACTS.length} activations; serialized ${imageLen}-byte KFRE image`);

// Parent oracle replay: the global reverse-commit order across all activations.
const replayOrder = [...commits].reverse();
P.exports.fm_begin_replay();
assert.equal(perr(), 0, "parent begin_replay");
const parentSeq = [];
for (const c of replayOrder) {
  const slot = TP[c.act].__wpk_fork_resume_peek(0);
  assert.equal(perr(), 0, `parent resume_peek act ${c.act}`);
  const payload = TP[c.act].__wpk_fork_frame_next(c.size) >>> 0;
  assert.equal(perr(), 0, `parent next act ${c.act} func ${c.func}`);
  parentSeq.push({ act: c.act, slot, func: pm.readU32(payload) });
}
assert.equal(TP[0].__wpk_fork_resume_peek(0), 0, "parent sentinel after exhaustion");
P.exports.fm_finish_replay();
assert.equal(perr(), 0, "parent finish_replay");

// The parent's own slots must equal the catalog-derived expectation.
for (let i = 0; i < parentSeq.length; i++) {
  const c = replayOrder[i];
  assert.equal(parentSeq[i].func, c.func, `parent order step ${i}`);
  assert.equal(parentSeq[i].slot, slotOf(c.act, c.func), `parent catalog slot step ${i}`);
}
console.log("  ok: parent oracle replayed the global reverse order; slots are per-activation catalog-derived");

// === Simulate the fork: byte-copy the WHOLE memory, scrub the parent region. ==
const childMemory = new WebAssembly.Memory({ initial: PAGES, maximum: 16384, shared: true });
new Uint8Array(childMemory.buffer).set(new Uint8Array(parentMemory.buffer));
{
  // Scrub the PARENT module data+BSS+stack in the CHILD copy: if the child read
  // anything there, its replay would diverge or fault. It must depend ONLY on
  // the copied arenas + KFRE image.
  const cbuf = new Uint8Array(childMemory.buffer);
  for (let off = MB_A; off < PSTACK_TOP; off++) cbuf[off] = 0x5a;
}

// === CHILD: a FRESH instance at a DIFFERENT __memory_base, empty journal. =====
const C = instantiateAt(childMemory, MB_B, CSTACK_TOP);
const cm = memViews(childMemory);
const cerr = () => C.exports.fm_last_errno();

C.exports.fm_set_format(4, ACTS[0].prefix);
assert.equal(cerr(), 0, "child set_format");
for (const a of ACTS) seedCatalog(C, cm, a);

// Seed the journal + activation 0 from the COPIED KFRE image, then ADD each
// side activation at its inherited module-buffer anchor + own fixed prefix.
C.exports.fm_begin_child_replay(mb[0], IMAGE_BASE, imageLen);
assert.equal(cerr(), 0, "child begin_child_replay");
for (const a of ACTS.slice(1)) {
  C.exports.fm_add_activation_child_replay(a.id, mb[a.id], a.prefix);
  assert.equal(cerr(), 0, `child add_activation_child_replay act ${a.id}`);
}

const TC = Object.fromEntries(ACTS.map((a) => [a.id, instantiateTrampoline(C, a.id)]));

const childSeq = [];
for (let i = 0; i < replayOrder.length; i++) {
  const c = replayOrder[i];
  const wrongAct = ACTS.find((a) => a.id !== c.act).id;

  // Resume slot is process-wide: every activation's trampoline reports the same.
  const slots = ACTS.map((a) => TC[a.id].__wpk_fork_resume_peek(0));
  assert.equal(cerr(), 0, `child resume_peek step ${i}`);
  for (const s of slots) assert.equal(s, slots[0], `resume slot process-wide step ${i}`);
  assert.equal(slots[0], slotOf(c.act, c.func), `child catalog slot step ${i}`);

  // ANTI-ALIASING: a wrong-activation peek is rejected WITHOUT consuming.
  assert.equal(TC[wrongAct].__wpk_fork_frame_peek(c.size) >>> 0, 0, `wrong act ${wrongAct} peek refused step ${i}`);
  assert.equal(cerr(), EINVAL, `wrong act peek EINVAL step ${i}`);

  // The correct activation reconstructs ITS OWN frame from copied memory.
  const peeked = TC[c.act].__wpk_fork_frame_peek(c.size) >>> 0;
  assert.equal(cerr(), 0, `child peek act ${c.act} func ${c.func} step ${i}`);
  assert.equal(cm.readU32(peeked), c.func, `child peeked func step ${i}`);
  const payload = TC[c.act].__wpk_fork_frame_next(c.size) >>> 0;
  assert.equal(cerr(), 0, `child next act ${c.act} func ${c.func} step ${i}`);
  assert.equal(payload, peeked, `child peek==next step ${i}`);
  assert.equal(cm.readByte(payload + 16), c.fill, `child payload fill round-trips step ${i}`);
  childSeq.push({ act: c.act, slot: slots[0], func: cm.readU32(payload) });
}
assert.equal(TC[0].__wpk_fork_resume_peek(0), 0, "child sentinel after global exhaustion");
C.exports.fm_finish_replay();
assert.equal(cerr(), 0, "child finish_replay");

// Parity: the child rewound in EXACTLY the parent's order + slots + funcs.
assert.equal(childSeq.length, parentSeq.length, "replay length parity");
for (let i = 0; i < parentSeq.length; i++) {
  assert.equal(childSeq[i].act, parentSeq[i].act, `act parity step ${i}`);
  assert.equal(childSeq[i].func, parentSeq[i].func, `func parity step ${i}`);
  assert.equal(childSeq[i].slot, parentSeq[i].slot, `RESUME-SLOT parity step ${i}`);
  // Reverse-of-commit semantics.
  assert.equal(childSeq[i].func, commits[commits.length - 1 - i].func, `reverse-of-commit step ${i}`);
}

// A replay-only child activation must REFUSE to reserve (no live frame arena).
for (const a of ACTS) {
  assert.equal(TC[a.id].__wpk_fork_frame_reserve(32) >>> 0, 0, `child act ${a.id} reserve refused`);
  assert.equal(cerr(), EINVAL, `child act ${a.id} reserve EINVAL`);
}

// The child left the copied low guest sentinel byte-for-byte intact.
{
  const cbuf = cm.u8();
  for (let off = 0; off < SENTINEL_END; off += 4093) {
    if (cbuf[off] !== sentinelByte(off)) {
      assert.fail(`child corrupted low sentinel at 0x${off.toString(16)}`);
    }
  }
}
console.log(`  ok: child (fresh instance, __memory_base ${MB_B / MiB} MiB, empty journal) reconstructed all ${commits.length} frames across ${ACTS.length} activations from COPIED memory`);
console.log("  ok: order + per-activation catalog slots match the parent; no cross-activation aliasing; low sentinel intact");

console.log("");
console.log(
  `ALL PASS: multi-activation child-replay proven — a forked child seeded ${ACTS.length} activations `
    + "from one serialized journal at a different placement, rewound the global reverse order in "
    + "lockstep, and resolved resume slots per-activation from per-activation catalogs.",
);
