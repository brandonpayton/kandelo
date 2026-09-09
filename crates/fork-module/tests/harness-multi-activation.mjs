// MULTI-ACTIVATION frame-routing validation for the co-resident fork-module
// (Phase 6 D7a.2). THIS IS THE KEY DELIVERABLE of this slice: it proves, in a
// real production WebAssembly engine (Node's V8), that a SINGLE shared
// fork-module instance can drive N independent fork ACTIVATIONS — activation 0
// (a dlopen fork's main module) plus activations 1..N (its dlopen'd side
// modules) — each through its OWN per-activation linked-frame writer + rewind
// driver, while the replay JOURNAL and RESUME-SLOT TABLE stay process-wide.
//
// The routing is done by per-activation TRAMPOLINE modules (see
// fork-trampoline.mjs): each activation's "guest" imports a trampoline whose
// frozen guest-facing `__wpk_fork_frame_*` exports fold in a constant
// activation id and delegate to the shared module's activation-parameterized
// `fm_frame_*(act, ...)` exports. The guest ABI names/signatures are UNCHANGED
// (no guest re-instrumentation) — the trampoline absorbs the extra `act` arg.
//
// It asserts:
//   (a) each activation's frames route to the correct per-activation writer /
//       driver — NO cross-activation aliasing (driving the WRONG activation's
//       trampoline for the current journal event fails, the right one succeeds);
//   (b) the process-wide journal correctly tags commits by activation (replay
//       walks the global reverse-commit order across BOTH activations);
//   (c) rewind on each activation reconstructs its OWN frames (payload identity
//       round-trips per activation);
//   (d) an interleaved >=2-activation commit order replays correctly.
// The single-activation regression is covered by the sibling harness.mjs, which
// this slice leaves byte-identical.
//
// Run: node crates/fork-module/tests/harness-multi-activation.mjs <fork_module.wasm>

import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { emitTrampoline, instantiateTrampoline } from "./fork-trampoline.mjs";

const wasmPath = process.argv[2];
if (!wasmPath) {
  console.error("usage: node harness-multi-activation.mjs <path-to-fork_module.wasm>");
  process.exit(2);
}

const PAGE = 65536;
const MiB = 1024 * 1024;
const EINVAL = 22;

// -- Host memory layout: one shared module instance, two disjoint frame arenas -
const MODULE_BASE = 8 * MiB; // __memory_base for the shared module's data + BSS
const MODULE_MEM = 8 * MiB;
const STACK_LOW = MODULE_BASE + MODULE_MEM;
const STACK_TOP = STACK_LOW + 1 * MiB;
const ARENA0_BASE = 20 * MiB; // activation 0 frame arena
const ARENA0_LEN = 4 * MiB;
const ARENA1_BASE = 28 * MiB; // activation 1 frame arena (disjoint)
const ARENA1_LEN = 4 * MiB;
const ARENA_END = ARENA1_BASE + ARENA1_LEN;
const INITIAL_PAGES = Math.ceil((ARENA_END + PAGE) / PAGE);

// Disjointness guarantees.
assert.ok(STACK_TOP <= ARENA0_BASE, "shared module region below arena 0");
assert.ok(ARENA0_BASE + ARENA0_LEN <= ARENA1_BASE, "arena 0 below arena 1");

const memory = new WebAssembly.Memory({ initial: INITIAL_PAGES, maximum: 16384, shared: true });

// Inert engine-floor stubs (this reference-free frame path never calls them).
const forkHostStubs = {};

function instantiateShared() {
  const bytes = readFileSync(wasmPath);
  const module = new WebAssembly.Module(bytes);
  for (const imp of WebAssembly.Module.imports(module)) {
    if (imp.module === "wpk_fork_host" && !(imp.name in forkHostStubs)) {
      forkHostStubs[imp.name] = () => 0;
    }
  }
  const exportNames = new Set(WebAssembly.Module.exports(module).map((e) => e.name));
  for (const need of [
    "fm_frame_reserve",
    "fm_frame_commit",
    "fm_frame_peek",
    "fm_frame_next",
    "fm_resume_peek",
    "fm_add_activation_unwind",
  ]) {
    assert.ok(exportNames.has(need), `shared module must export ${need}`);
  }
  return new WebAssembly.Instance(module, {
    env: {
      memory,
      __indirect_function_table: new WebAssembly.Table({ element: "anyfunc", initial: 0 }),
      __wpk_fork_function_catalog: new WebAssembly.Table({ element: "anyfunc", initial: 0 }),
      __wpk_fork_drive_table: new WebAssembly.Table({ element: "anyfunc", initial: 0 }),
      // M2: the merged, host-owned static-root catalog (anyref) the injected
      // drive shim reads on a DRIVE_OP_STATIC_ROOT step. This reference-free
      // frame-routing harness never drives a reference replay, so an empty
      // table is inert here.
      __wpk_fork_static_root_catalog: new WebAssembly.Table({ element: "anyref", initial: 0 }),
      __stack_pointer: new WebAssembly.Global({ value: "i32", mutable: true }, STACK_TOP),
      __memory_base: new WebAssembly.Global({ value: "i32", mutable: false }, MODULE_BASE),
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

const shared = instantiateShared();
const x = shared.exports;

const dv = () => new DataView(memory.buffer);
const u8 = () => new Uint8Array(memory.buffer);
const readU32 = (off) => dv().getUint32(off, true);
const writeU32 = (off, val) => dv().setUint32(off, val >>> 0, true);
const readByte = (off) => u8()[off];
const errno = () => x.fm_last_errno();

function writePayload(payload, func, call, fill, size) {
  writeU32(payload + 0, func);
  writeU32(payload + 4, call);
  writeU32(payload + 8, 0);
  writeU32(payload + 12, 0);
  const buf = u8();
  for (let i = 16; i < size; i++) buf[payload + i] = fill;
}

console.log("fork-module MULTI-ACTIVATION frame-routing harness (Node/V8):");

// Pre-flight: the emitter produces a valid, well-formed trampoline module.
{
  const bytes = emitTrampoline(1);
  assert.ok(WebAssembly.validate(bytes), "emitted trampoline validates");
  const tmod = new WebAssembly.Module(bytes);
  const timports = WebAssembly.Module.imports(tmod).map((i) => `${i.module}.${i.name}`);
  for (const need of [
    "shared.fm_frame_reserve",
    "shared.fm_frame_commit",
    "shared.fm_frame_peek",
    "shared.fm_frame_next",
    "shared.fm_resume_peek",
  ]) {
    assert.ok(timports.includes(need), `trampoline must import ${need}`);
  }
  const texports = new Set(WebAssembly.Module.exports(tmod).map((e) => e.name));
  for (const need of [
    "__wpk_fork_frame_reserve",
    "__wpk_fork_frame_commit",
    "__wpk_fork_frame_peek",
    "__wpk_fork_frame_next",
    "__wpk_fork_resume_peek",
  ]) {
    assert.ok(texports.has(need), `trampoline must export ${need}`);
  }
  console.log("  ok: trampoline synthesizer emits a valid, correctly-typed module");
}

// -- Seed the shared linked-frame format once, then open two activations -------
// Each activation gets its OWN fixed runtime prefix (distinct here to prove the
// per-activation writer/arena really is independent), a hallmark of dlopen side
// modules that carry their own module-buffer prefix.
const PREFIX0 = 128;
const PREFIX1 = 256;
x.fm_set_format(4, PREFIX0);
assert.equal(errno(), 0, "fm_set_format");

// fm_begin_unwind_fixed_arena / fm_add_activation_unwind_fixed_arena are the
// in-realm, no-servicer siblings of fm_begin_unwind / fm_add_activation_unwind
// (Option B, channel-based) — the latter block forever in
// memory_atomic_wait32 waiting for a host syscall-channel servicer this bare
// Node harness does not provide.
const mb0 = x.fm_begin_unwind_fixed_arena(0, ARENA0_BASE, ARENA0_LEN) >>> 0;
assert.equal(errno(), 0, "fm_begin_unwind_fixed_arena(act 0)");
assert.ok(mb0 >= ARENA0_BASE && mb0 < ARENA0_BASE + ARENA0_LEN, "act0 module buffer in arena 0");

const mb1 = x.fm_add_activation_unwind_fixed_arena(1, ARENA1_BASE, ARENA1_LEN, PREFIX1) >>> 0;
assert.equal(errno(), 0, "fm_add_activation_unwind_fixed_arena(act 1)");
assert.ok(mb1 >= ARENA1_BASE && mb1 < ARENA1_BASE + ARENA1_LEN, "act1 module buffer in arena 1");
console.log(`  ok: opened activation 0 (arena 0, prefix ${PREFIX0}) + activation 1 (arena 1, prefix ${PREFIX1})`);

// Per-activation trampolines. Each folds in its activation id and delegates to
// the shared fm_frame_* exports.
const T = {
  0: instantiateTrampoline(shared, 0),
  1: instantiateTrampoline(shared, 1),
};

// -- INTERLEAVED global commit order across the two activations ----------------
// Leaf-to-root commit sequence, interleaving activation 0 and activation 1.
const commits = [
  { act: 0, func: 101, call: 1, fill: 0xa1, size: 40 },
  { act: 1, func: 301, call: 1, fill: 0xc1, size: 48 },
  { act: 0, func: 202, call: 2, fill: 0xb2, size: 65216 }, // forces a 2nd chunk in arena 0
  { act: 1, func: 302, call: 2, fill: 0xc2, size: 56 },
  { act: 0, func: 303, call: 3, fill: 0xb3, size: 40 },
];

// Drive the unwind: each commit routes through ITS activation's trampoline.
for (const c of commits) {
  const t = T[c.act];
  const payload = t.__wpk_fork_frame_reserve(c.size) >>> 0;
  assert.equal(errno(), 0, `reserve errno act ${c.act} func ${c.func}`);
  assert.notEqual(payload, 0, `reserve returned payload act ${c.act} func ${c.func}`);
  const arenaBase = c.act === 0 ? ARENA0_BASE : ARENA1_BASE;
  const arenaEnd = c.act === 0 ? ARENA0_BASE + ARENA0_LEN : ARENA1_BASE + ARENA1_LEN;
  assert.ok(
    payload >= arenaBase && payload < arenaEnd,
    `act ${c.act} payload routed to ITS arena (got 0x${payload.toString(16)})`,
  );
  writePayload(payload, c.func, c.call, c.fill, c.size);
  t.__wpk_fork_frame_commit(payload);
  assert.equal(errno(), 0, `commit errno act ${c.act} func ${c.func}`);
}
console.log("  ok: interleaved unwind — every frame routed to its own per-activation arena (no aliasing on write)");

x.fm_finish_unwind();
assert.equal(errno(), 0, "fm_finish_unwind");
x.fm_begin_replay();
assert.equal(errno(), 0, "fm_begin_replay");

// -- Replay: global reverse-commit order across BOTH activations ---------------
// The process-wide journal tags each commit by activation, so replay walks the
// exact reverse of the interleaved commit order. Each step routes to the
// activation the journal currently selects; driving the WRONG activation's
// trampoline must fail (the journal's activation gate — the anti-aliasing proof)
// while the correct one reconstructs that activation's own frame.
const replay = [...commits].reverse();
let framesReplayed = 0;
for (let i = 0; i < replay.length; i++) {
  const c = replay[i];
  const wrongAct = c.act === 0 ? 1 : 0;

  // Resume-slot is a process-wide journal concern: both trampolines report the
  // SAME slot for the current global event.
  const slot0 = T[0].__wpk_fork_resume_peek(0);
  const slot1 = T[1].__wpk_fork_resume_peek(0);
  assert.equal(errno(), 0, `resume_peek errno step ${i}`);
  assert.equal(slot0, slot1, `resume slot is process-wide (step ${i})`);
  assert.ok(slot0 >= 1, `registered coordinate is not the sentinel (step ${i})`);

  // ANTI-ALIASING: the wrong activation's peek must be rejected by the journal
  // activation gate, WITHOUT consuming anything.
  assert.equal(
    T[wrongAct].__wpk_fork_frame_peek(c.size) >>> 0,
    0,
    `wrong activation ${wrongAct} peek refused at step ${i}`,
  );
  assert.equal(errno(), EINVAL, `wrong activation peek sets EINVAL at step ${i}`);

  // The correct activation reconstructs ITS own frame.
  const peeked = T[c.act].__wpk_fork_frame_peek(c.size) >>> 0;
  assert.equal(errno(), 0, `peek errno act ${c.act} func ${c.func} step ${i}`);
  assert.equal(readU32(peeked), c.func, `peeked func act ${c.act} step ${i}`);

  const advanced = T[c.act].__wpk_fork_frame_next(c.size) >>> 0;
  assert.equal(errno(), 0, `next errno act ${c.act} func ${c.func} step ${i}`);
  assert.equal(advanced, peeked, `next==peek payload act ${c.act} step ${i}`);
  assert.equal(readByte(advanced + 16), c.fill, `payload fill round-trips act ${c.act} step ${i}`);
  framesReplayed += 1;
}

assert.equal(T[0].__wpk_fork_resume_peek(0), 0, "sentinel slot after global exhaustion");
x.fm_finish_replay();
assert.equal(errno(), 0, "fm_finish_replay");
assert.equal(framesReplayed, commits.length, "every interleaved frame replayed exactly once");
console.log(
  `  ok: interleaved replay — ${framesReplayed} frames walked in global reverse-commit order; `
    + "each routed to its own driver; every wrong-activation call rejected (no aliasing)",
);

console.log("");
console.log(
  "ALL PASS: one shared fork-module drove 2 activations through independent per-activation "
    + "writers/drivers with a process-wide journal + resume table — multi-activation routing proven.",
);
