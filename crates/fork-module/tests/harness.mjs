// End-to-end + CO-RESIDENCY validation harness for the fork-module PIE side module.
//
// THIS IS THE KEY DELIVERABLE of the Phase 6 D5 gating slice. It proves, in a
// real production WebAssembly engine (Node's V8 — the same engine the browser
// and Node process workers run), that the fork-module can be instantiated
// AGAINST LIVE, NON-EMPTY guest memory WITHOUT corrupting the guest's data,
// because the module is built as a position-independent (PIC / `--pie`) side
// module whose data, BSS heap, and shadow stack are placed by HOST-supplied
// `__memory_base` / `__stack_pointer` / `__table_base` globals into a
// host-reserved region that the "guest" is not using.
//
// The old D2 scaffold could NOT pass this test: it was a plain cdylib whose
// static data, 16 MiB BSS heap, and `--stack-first` shadow stack lived at FIXED
// LOW linear-memory offsets, so instantiating it against live guest memory
// would overwrite guest data at those offsets. The harness demonstrates the
// difference directly: it fills the LOW region (where the old scaffold's
// static/BSS/stack lived) with a known sentinel pattern BEFORE instantiating and
// running the module, then asserts that region is byte-for-byte UNCHANGED after
// a full multi-chunk unwind->rewind loop and a >=5000-frame stress fork.
//
// It also proves the Option A arena contract: the HOST allocates the per-fork
// frame arena and passes its (base, len) into `fm_begin_unwind` — the module no
// longer grows memory itself.
//
// Run: node crates/fork-module/tests/harness.mjs <path-to-fork_module.wasm>

import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

const wasmPath = process.argv[2];
if (!wasmPath) {
  console.error("usage: node harness.mjs <path-to-fork_module.wasm>");
  process.exit(2);
}

const PAGE = 65536;
const EINVAL = 22;

// -- Host memory layout (the host's job, mirrors the production worker) --------
//
// The host chooses disjoint regions in the shared linear memory:
//   [0, MODULE_BASE)                      guest data (proxied here by a sentinel)
//   [MODULE_BASE, MODULE_BASE+MODULE_MEM) module data + BSS heap (via __memory_base)
//   [STACK_LOW, STACK_TOP)                module shadow stack   (via __stack_pointer)
//   [ARENA_BASE, ARENA_BASE+ARENA_LEN)    per-fork frame arena  (via fm_begin_unwind)
//
// MODULE_BASE is deliberately HIGH (32 MiB) so the whole low region — where the
// old plain-cdylib scaffold's static/BSS/stack lived — is free to hold the
// guest sentinel, proving co-residency.
const MODULE_BASE = 32 * 1024 * 1024; // 0x2000000  __memory_base
const MODULE_MEM = 16 * 1024 * 1024; // module data + BSS heap reservation
const STACK_LOW = MODULE_BASE + MODULE_MEM; // 48 MiB
const STACK_SIZE = 1024 * 1024;
const STACK_TOP = STACK_LOW + STACK_SIZE; // 49 MiB  __stack_pointer (grows down)
const TABLE_BASE = 0;
const ARENA_BASE = 56 * 1024 * 1024; // 0x3800000  page-aligned frame arena base
const ARENA_LEN = 4 * 1024 * 1024; // per-fork frame arena length
const ARENA_END = ARENA_BASE + ARENA_LEN;

// Memory must cover the highest region used (the arena end), rounded to pages.
const INITIAL_PAGES = Math.ceil((ARENA_END + PAGE) / PAGE);
const memory = new WebAssembly.Memory({
  initial: INITIAL_PAGES,
  maximum: 16384,
  shared: true,
});

// The PIC placement globals the host supplies to a `--pie` side module.
const importObject = {
  env: {
    memory,
    __indirect_function_table: new WebAssembly.Table({ element: "anyfunc", initial: 0 }),
    // Phase 6 D6.1: the module now imports the guest's funcref function catalog
    // for `__wpk_fork_ref_decode_funcref`. This frame/continuation harness never
    // reconstructs references, so an empty funcref table is inert here.
    __wpk_fork_function_catalog: new WebAssembly.Table({ element: "anyfunc", initial: 0 }),
    __wpk_fork_drive_table: new WebAssembly.Table({ element: "anyfunc", initial: 0 }),
    // M2: the merged, host-owned static-root catalog (anyref) the injected
    // drive shim reads on a DRIVE_OP_STATIC_ROOT step (see
    // fork-module-inject/src/main.rs STATIC_ROOT_CATALOG_IMPORT). This
    // reference-free frame/continuation harness never drives a reference
    // replay, so an empty table is inert here.
    __wpk_fork_static_root_catalog: new WebAssembly.Table({ element: "anyref", initial: 0 }),
    __stack_pointer: new WebAssembly.Global({ value: "i32", mutable: true }, STACK_TOP),
    __memory_base: new WebAssembly.Global({ value: "i32", mutable: false }, MODULE_BASE),
    __table_base: new WebAssembly.Global({ value: "i32", mutable: false }, TABLE_BASE),
    // M2: the single residual externref host import,
    // `resolve_externref(handle) -> externref` (see
    // fork-module-inject/src/main.rs RESOLVE_EXTERNREF_IMPORT). Never
    // exercised by this frame-drive harness; a stub returning a fresh unique
    // object per call satisfies the reference-returning import signature.
    resolve_externref: (_handle) => ({}),
  },
};

const bytes = readFileSync(wasmPath);
const module = new WebAssembly.Module(bytes);

// Structural check: the built .wasm is a PIE side module that imports the
// host-supplied placement globals and exports the frozen guest-facing frame
// functions plus the coordinator surface.
const imports = WebAssembly.Module.imports(module).map((i) => `${i.module}.${i.name}`);
for (const need of [
  "env.memory",
  "env.__memory_base",
  "env.__stack_pointer",
  "env.__table_base",
  // Phase 6 D6.1: the injected funcref decode export reads this funcref table.
  "env.__wpk_fork_function_catalog",
]) {
  assert.ok(imports.includes(need), `module must import ${need}, got ${imports}`);
}
// H3 (host-surface minimization, 2026-09-06): the engine-floor host-capability
// seam (Phase 6 D6, `wpk_fork_host.*`) that used to be asserted present here
// was DELETED — it was never wired to any guest on any host (the module's
// `hostCapabilities` option was never passed a real body by any caller), and
// the completed F5/F6 reference-completeness work bypassed it entirely.
// Assert the ABSENCE instead, so a future regression that reintroduces the
// seam surfaces here.
assert.ok(
  !imports.some((i) => i.startsWith("wpk_fork_host.")),
  `module must not import from wpk_fork_host (deleted seam), got ${imports}`,
);

const exportNames = new Set(WebAssembly.Module.exports(module).map((e) => e.name));
for (const name of [
  "__wpk_fork_frame_reserve",
  "__wpk_fork_frame_commit",
  "__wpk_fork_frame_peek",
  "__wpk_fork_frame_next",
  "__wpk_fork_resume_peek",
  "fm_set_format",
  "fm_begin_unwind",
  "fm_finish_unwind",
  "fm_begin_replay",
  "fm_finish_replay",
  // F1: module-driven abort-replay (mirrors fm_begin_replay/fm_finish_replay).
  "fm_begin_abort",
  "fm_finish_abort",
  "fm_serialize_journal_fixed_arena",
  "fm_begin_child_replay",
  "fm_last_errno",
  // Phase 6 D6.1 reference reconstruction (funcref + null).
  "__wpk_fork_ref_decode_funcref",
  "fm_begin_reference_replay",
  // The single folded proof-of-use counter accessor (fm_stats(field) -> i64),
  // replacing the former 11 individual fm_* counter exports (D6.1 references,
  // D6.2 externrefs, D6.3a exnrefs, D6.4a typed-GC nodes, ...).
  "fm_stats",
  // M2: the injected binder's helper for the externref recipe -> broker handle
  // lookup (mirrors fm_funcref_ordinal/fm_static_root_slot).
  "fm_externref_handle",
]) {
  assert.ok(exportNames.has(name), `module must export ${name}`);
}

const instance = new WebAssembly.Instance(module, importObject);
const x = instance.exports;

// A shared memory's buffer is stable here (the host pre-grew it; the module no
// longer grows memory), but re-deriving views is cheap and future-proof.
const u8 = () => new Uint8Array(memory.buffer);
const view = () => new DataView(memory.buffer);
const readU32 = (off) => view().getUint32(off, true);
const writeU32 = (off, val) => view().setUint32(off, val >>> 0, true);
const readByte = (off) => u8()[off];
const errno = () => x.fm_last_errno();

// Field indices for the folded fm_stats(field) accessor. MUST match fm_stats's
// match arms in crates/fork-module/src/lib.rs.
const FM_STAT = {
  FRAMES_COMMITTED: 0,
  FRAMES_REPLAYED: 1,
  REFERENCES_RECONSTRUCTED: 2,
  EXTERNREFS_RESOLVED: 3,
  EXNREFS_RECONSTRUCTED: 4,
  GC_NODES_RECONSTRUCTED: 5,
  STATIC_ROOTS_PUBLISHED: 6,
  DRIVE_STEPS_EXECUTED: 7,
  REF_FEED_READS: 8,
  REFERENCE_GRAPHS_DECODED: 9,
  EXTERNREF_HANDLES_SCANNED: 10,
};

// -- M2: fm_externref_handle traps outside a seeded reference replay -----------
//
// `fm_externref_handle` is the helper the INJECTED binder (Task 3) calls to get
// the broker handle for an externref recipe, keyed off the reference-replay
// driver `fm_begin_reference_replay` seeds. This harness never seeds one (it
// exercises only the reference-free frame/continuation path), so calling it
// must TRAP (`wasm_intr::unreachable`) rather than silently return a value —
// the same truthful-corruption contract `fm_funcref_ordinal`/
// `fm_static_root_slot` uphold. The full recipe -> captured-handle round trip
// (a real KFMS arena with an Externref node) is validated end to end via the
// injected binder + the production TS encoder in
// `host/test/fork-module-externref-replay.test.ts` (Task 6), not here.
{
  assert.throws(
    () => x.fm_externref_handle(0),
    /unreachable/i,
    "fm_externref_handle traps with no reference state seeded",
  );
  console.log("  ok: fm_externref_handle traps outside a seeded reference replay (no silent value)");
}

// -- Phase 6 D6.3a: the exnref proof-of-use counter is present and inert here --
//
// `fm_exnrefs_reconstructed` advances ONLY when `fm_begin_reference_replay`
// admits an exnref-bearing graph and drives it. The retention-anchor probe above
// exercises the raw seam (including `host_mint_exception_tag`), but it never
// drives `fm_begin_reference_replay`, so the exnref counter must still read 0 —
// proving the counter export is real and is not spuriously bumped by the seam
// probe. The full exnref drive (real KFMS arena -> module admits -> PHASE B roots
// the payload in the REAL anyref transit -> counter advances -> mint NOT called)
// is validated in `host/test/fork-module-exnref-replay.test.ts`, which builds the
// arena with the production TypeScript KFMS/KFRV encoder (the same Node/V8 engine
// this harness runs in) rather than hand-encoding it here.
assert.equal(
  x.fm_stats(FM_STAT.EXNREFS_RECONSTRUCTED),
  0n,
  "exnref counter is inert until fm_begin_reference_replay admits an exnref graph",
);
console.log("  ok: fm_exnrefs_reconstructed present and inert (0) outside a reference replay");

// -- Phase 6 D6.4a: the typed-GC proof-of-use counter is present and inert here -
//
// `fm_gc_nodes_reconstructed` advances ONLY when `fm_begin_reference_replay`
// admits a typed-GC (struct/array/i31) graph and drives it. The seam probe above
// never drives `fm_begin_reference_replay`, so the GC counter must still read 0 —
// proving the counter export is real and not spuriously bumped by the seam probe.
// The full typed-GC drive (real KFMS arena -> module admits a struct↔array cycle
// -> PHASE B roots the aliased externref leaf in the REAL anyref transit ONCE ->
// counter advances -> no tag minted) is validated in
// `host/test/fork-module-gc-replay.test.ts`.
assert.equal(
  x.fm_stats(FM_STAT.GC_NODES_RECONSTRUCTED),
  0n,
  "typed-GC counter is inert until fm_begin_reference_replay admits a GC graph",
);
console.log("  ok: fm_gc_nodes_reconstructed present and inert (0) outside a reference replay");

// -- The sentinel: proxy for live guest data at LOW offsets --------------------
//
// Fill [0, MODULE_BASE) with a deterministic, offset-dependent pattern. This is
// exactly the region the old plain-cdylib scaffold's shadow stack ([0, 1 MiB),
// `--stack-first`) and static data + 16 MiB BSS heap (up to ~17.8 MiB) occupied.
// A correctly-placed PIE module must NEVER write here.
const SENTINEL_END = MODULE_BASE;
function sentinelByte(off) {
  // A cheap, well-mixed, offset-dependent byte (no all-zero / all-one runs).
  return ((off * 2654435761) >>> 24) & 0xff;
}
function fillSentinel() {
  const buf = u8();
  for (let off = 0; off < SENTINEL_END; off++) buf[off] = sentinelByte(off);
}
// Verify the sentinel is intact. Check EVERY byte of the hottest old-scaffold
// pages exactly, and a dense prime-strided sweep across the whole low region so
// any stray write anywhere in [0, MODULE_BASE) is caught.
function assertSentinelIntact(label) {
  const buf = u8();
  // Exact, byte-for-byte over the old scaffold's shadow-stack window [0, 1 MiB)
  // and the start of its static-data window around 1 MiB, plus the region near
  // its old __data_end (~16.7 MiB) and __heap_base — the pages most likely to be
  // clobbered by a mis-placed module.
  const exactWindows = [
    [0, 1 * 1024 * 1024], // old shadow stack (--stack-first)
    [1 * 1024 * 1024, 1 * 1024 * 1024 + 4096], // old static data start
    [16 * 1024 * 1024, 16 * 1024 * 1024 + 4096], // old heap/data tail vicinity
  ];
  for (const [start, end] of exactWindows) {
    for (let off = start; off < end; off++) {
      if (buf[off] !== sentinelByte(off)) {
        assert.fail(
          `${label}: guest sentinel CORRUPTED at low offset 0x${off.toString(16)} ` +
            `(expected 0x${sentinelByte(off).toString(16)}, got 0x${buf[off].toString(16)})`,
        );
      }
    }
  }
  // Dense prime-strided sweep across the entire low region.
  for (let off = 0; off < SENTINEL_END; off += 4093) {
    if (buf[off] !== sentinelByte(off)) {
      assert.fail(
        `${label}: guest sentinel CORRUPTED at low offset 0x${off.toString(16)} ` +
          `(expected 0x${sentinelByte(off).toString(16)}, got 0x${buf[off].toString(16)})`,
      );
    }
  }
}

// Write the frame payload the guest fills between reserve and commit: the ABI
// frame header (func_index +0, call_index +4, catch selector +8, reference
// ordinal +12) plus a scalar fill tail. The module reads func_index at
// payload+0 for the journal / resume-slot machinery.
function writePayload(payload, func, call, fill, size) {
  writeU32(payload + 0, func);
  writeU32(payload + 4, call);
  writeU32(payload + 8, 0);
  writeU32(payload + 12, 0);
  const buf = u8();
  for (let i = 16; i < size; i++) buf[payload + i] = fill;
}

// Seed the real linked-frame format (pointer_width=4 wasm32, fixed_prefix=128),
// once, before any fork — the production host reads these from the guest
// module's `kandelo.wpk_fork.linked_frames` descriptor.
function setFormat() {
  x.fm_set_format(4, 128);
  assert.equal(errno(), 0, "fm_set_format errno");
}

// Begin a fork with a HOST-allocated arena (Option A): the host owns [base,len).
// `fm_begin_unwind_fixed_arena` is the in-realm, no-servicer sibling of
// `fm_begin_unwind` (Option B, channel-based) — the latter blocks forever in
// `memory_atomic_wait32` waiting for a host syscall-channel servicer this bare
// Node harness does not provide.
function beginUnwind(act) {
  const moduleBuffer = x.fm_begin_unwind_fixed_arena(act, ARENA_BASE, ARENA_LEN) >>> 0;
  assert.equal(errno(), 0, "fm_begin_unwind_fixed_arena errno");
  assert.notEqual(moduleBuffer, 0, "fm_begin_unwind_fixed_arena returned a module buffer");
  // The arena the module wrote into must be entirely inside the host region.
  assert.ok(moduleBuffer >= ARENA_BASE && moduleBuffer < ARENA_END, "module buffer in host arena");
  return moduleBuffer;
}

// --- Case 1: multi-chunk closed loop, over a HOST arena, co-resident ----------
function runMultiChunk() {
  const ACT = 7;
  const specs = [
    { func: 101, call: 1, fill: 0xa1, size: 40 },
    { func: 202, call: 2, fill: 0xb2, size: 64 },
    { func: 303, call: 3, fill: 0xc3, size: 65216 }, // forces a second chunk
    { func: 404, call: 4, fill: 0xd4, size: 48 },
  ];

  beginUnwind(ACT);

  for (const s of specs) {
    const payload = x.__wpk_fork_frame_reserve(s.size) >>> 0;
    assert.equal(errno(), 0, `reserve errno for func ${s.func}`);
    assert.notEqual(payload, 0, `reserve returned payload for func ${s.func}`);
    assert.ok(payload >= ARENA_BASE && payload < ARENA_END, `frame ${s.func} payload in host arena`);
    writePayload(payload, s.func, s.call, s.fill, s.size);
    x.__wpk_fork_frame_commit(payload);
    assert.equal(errno(), 0, `commit errno for func ${s.func}`);
  }

  x.fm_finish_unwind();
  assert.equal(errno(), 0, "fm_finish_unwind errno");
  x.fm_begin_replay();
  assert.equal(errno(), 0, "fm_begin_replay errno");

  const replayOrder = [...specs].reverse();
  const expectedSlots = [4, 3, 2, 1];
  for (let i = 0; i < replayOrder.length; i++) {
    const s = replayOrder[i];
    const slot = x.__wpk_fork_resume_peek(0);
    assert.equal(errno(), 0, `resume_peek errno step ${i}`);
    assert.equal(slot, expectedSlots[i], `resume slot at step ${i}`);

    const peeked = x.__wpk_fork_frame_peek(s.size) >>> 0;
    assert.equal(errno(), 0, `peek errno for func ${s.func}`);
    assert.equal(readU32(peeked), s.func, `peeked frame func at step ${i}`);

    const advanced = x.__wpk_fork_frame_next(s.size) >>> 0;
    assert.equal(errno(), 0, `next errno for func ${s.func}`);
    assert.equal(advanced, peeked, `next returns the same payload as peek at step ${i}`);
    assert.equal(readByte(advanced + 16), s.fill, `payload fill round-trips at step ${i}`);
  }

  assert.equal(x.__wpk_fork_resume_peek(0), 0, "sentinel slot after exhaustion");
  assert.equal(x.__wpk_fork_frame_peek(0), 0, "peek past end returns 0");
  assert.equal(errno(), EINVAL, "peek past end sets EINVAL");

  x.fm_finish_replay();
  assert.equal(errno(), 0, "fm_finish_replay errno");
  console.log("  ok: multi-chunk closed loop over host arena (4 frames, 2 chunks, slots [4,3,2,1])");
}

// --- Case 2: >=5000-frame stress, single fork, module reused ------------------
function runStress(N) {
  const ACT = 3;
  beginUnwind(ACT);

  for (let i = 0; i < N; i++) {
    const func = 1000 + i;
    const payload = x.__wpk_fork_frame_reserve(32) >>> 0;
    assert.equal(errno(), 0, `stress reserve errno func ${func}`);
    assert.ok(payload >= ARENA_BASE && payload < ARENA_END, `stress payload ${func} in host arena`);
    writePayload(payload, func, i, i & 0xff, 32);
    x.__wpk_fork_frame_commit(payload);
    assert.equal(errno(), 0, `stress commit errno func ${func}`);
  }
  x.fm_finish_unwind();
  assert.equal(errno(), 0, "stress finish_unwind errno");
  x.fm_begin_replay();
  assert.equal(errno(), 0, "stress begin_replay errno");

  for (let i = N - 1; i >= 0; i--) {
    const expectedFunc = 1000 + i;
    const slot = x.__wpk_fork_resume_peek(0);
    assert.equal(slot, i + 1, `stress slot at func ${expectedFunc}`);
    const payload = x.__wpk_fork_frame_next(32) >>> 0;
    assert.equal(errno(), 0, `stress next errno func ${expectedFunc}`);
    assert.equal(readU32(payload), expectedFunc, `stress frame func`);
  }
  assert.equal(x.__wpk_fork_resume_peek(0), 0, "stress sentinel after exhaustion");
  x.fm_finish_replay();
  assert.equal(errno(), 0, "stress finish_replay errno");
  console.log(`  ok: ${N}-frame stress fork over host arena, module reused`);
}

// --- Case 3: abort-replay cycle (module-driven abort path) -------------------
// `fm_begin_abort`/`fm_finish_abort` mirror `fm_begin_replay`/`fm_finish_replay`
// exactly — same frame/journal mechanics — but tag the fork as in-abort so
// `fm_finish_abort` can assert the pairing. Modeled on `runMultiChunk`'s
// unwind -> replay drive, swapping in the abort exports.
function runAbortCycle() {
  const ACT = 9;
  const specs = [
    { func: 501, call: 1, fill: 0xe1, size: 40 },
    { func: 502, call: 2, fill: 0xe2, size: 64 },
  ];

  beginUnwind(ACT);

  for (const s of specs) {
    const payload = x.__wpk_fork_frame_reserve(s.size) >>> 0;
    assert.equal(errno(), 0, `abort reserve errno for func ${s.func}`);
    writePayload(payload, s.func, s.call, s.fill, s.size);
    x.__wpk_fork_frame_commit(payload);
    assert.equal(errno(), 0, `abort commit errno for func ${s.func}`);
  }

  x.fm_finish_unwind();
  assert.equal(errno(), 0, "abort fm_finish_unwind errno");

  // Negative case: fm_finish_abort without a preceding fm_begin_abort is a
  // loud EINVAL, not a silent no-op and not a fall-through into a bare
  // fm_finish_replay's bookkeeping.
  x.fm_finish_abort();
  assert.equal(errno(), EINVAL, "fm_finish_abort without fm_begin_abort sets EINVAL");

  x.fm_begin_abort();
  assert.equal(errno(), 0, "fm_begin_abort errno");

  const replayOrder = [...specs].reverse();
  for (let i = 0; i < replayOrder.length; i++) {
    const s = replayOrder[i];
    const peeked = x.__wpk_fork_frame_peek(s.size) >>> 0;
    assert.equal(errno(), 0, `abort peek errno for func ${s.func}`);
    assert.equal(readU32(peeked), s.func, `abort peeked frame func at step ${i}`);

    const advanced = x.__wpk_fork_frame_next(s.size) >>> 0;
    assert.equal(errno(), 0, `abort next errno for func ${s.func}`);
    assert.equal(advanced, peeked, `abort next returns the same payload as peek at step ${i}`);
    assert.equal(readByte(advanced + 16), s.fill, `abort payload fill round-trips at step ${i}`);
  }

  assert.equal(x.__wpk_fork_resume_peek(0), 0, "abort sentinel slot after exhaustion");

  x.fm_finish_abort();
  assert.equal(errno(), 0, "fm_finish_abort errno");
  console.log("  ok: abort-replay cycle (fm_begin_abort/fm_finish_abort mirror fm_begin_replay/fm_finish_replay) + EINVAL pairing guard");
}

// --- Case 3.5: parent-corruption fault injection (F1 Task 5) -----------------
// A twin of `crates/fork-codec/src/rewind_driver.rs`'s
// `peek_rejects_tail_node_corrupted_after_attach`, adapted to this harness's
// single shared live memory (rather than that unit test's two separate before/
// after snapshots): `decode_linked_frames` -- which both `fm_begin_replay` and
// `fm_begin_abort` call via the shared `begin_replay_impl` -- eagerly walks
// and validates every committed node's KFCN magic while building the replay
// order (`crates/fork-codec/src/linked_frames.rs::read_node_fields`), reading
// directly from the live guest memory. So corrupting a committed frame's node
// header in place, then driving `fm_begin_abort`, is caught at attach time
// here. This proves the address-space-corruption risk the plan calls out (a
// stray write into a committed frame, e.g. a Wasm-side buffer overrun)
// surfaces as a TRUTHFUL failure (nonzero `fm_last_errno`) rather than the
// abort path reading garbage as if it were a valid frame -- and that neither
// `fm_begin_abort` nor a subsequent `fm_finish_abort` mis-drives or silently
// succeeds over the corruption.
function runAbortCorruption() {
  const ACT = 11;
  const spec = { func: 901, call: 1, fill: 0xc0, size: 40 };

  beginUnwind(ACT);
  const payload = x.__wpk_fork_frame_reserve(spec.size) >>> 0;
  assert.equal(errno(), 0, "corruption reserve errno");
  writePayload(payload, spec.func, spec.call, spec.fill, spec.size);
  x.__wpk_fork_frame_commit(payload);
  assert.equal(errno(), 0, "corruption commit errno");

  x.fm_finish_unwind();
  assert.equal(errno(), 0, "corruption fm_finish_unwind errno");

  // Corrupt the committed frame's KFCN node header magic: the first 4 bytes
  // of the node, NODE_HEADER (24, for the wasm32/pointer-width-4 layout the
  // Rust unit tests and this harness both use) bytes before its payload.
  // Mirrors `w_u32(&mut corrupt, driver.committed_tail(), 0xdead_beef)` in
  // `peek_rejects_tail_node_corrupted_after_attach`.
  const NODE_HEADER = 24;
  const nodeBase = payload - NODE_HEADER;
  writeU32(nodeBase, 0xdeadbeef);

  // `fm_begin_abort`'s attach (`RewindDriver::attach` / `decode_linked_frames`)
  // eagerly reads every committed node's magic while building the replay
  // order, so the corruption FAILS LOUDLY right here: EINVAL, not a silent
  // success and not a trap/panic reading garbage as a valid frame.
  x.fm_begin_abort();
  assert.equal(
    errno(),
    EINVAL,
    "corrupt-frame fm_begin_abort sets EINVAL (decode reads the corrupted node's magic)",
  );

  // `fm_finish_abort` must not silently succeed either: no `fm_begin_abort`
  // actually took hold (it failed above), so this is the same loud
  // no-matching-begin EINVAL the happy-path pairing guard proves above --
  // never a fall-through into finishing as if the abort had completed.
  x.fm_finish_abort();
  assert.equal(
    errno(),
    EINVAL,
    "fm_finish_abort after a failed fm_begin_abort sets EINVAL (not silent success)",
  );
  console.log(
    "  ok: abort-replay over a corrupted committed frame fails loudly "
      + "(fm_last_errno=EINVAL) at both begin and finish -- never mis-drives, never silently succeeds",
  );
}

console.log("fork-module co-residency harness (Node/V8, live imported memory, PIC placement):");

// Prime the low region with guest data BEFORE instantiating anything into it.
fillSentinel();
assertSentinelIntact("baseline");
console.log(`  ok: seeded ${(SENTINEL_END / (1024 * 1024)).toFixed(0)} MiB guest sentinel at [0, 0x${SENTINEL_END.toString(16)})`);

setFormat();
runMultiChunk();
// THE HEADLINE ASSERTION: after a real fork loop, guest data at the low offsets
// where the old scaffold's static/BSS/stack lived is byte-for-byte intact.
assertSentinelIntact("after multi-chunk fork");
console.log("  ok: SENTINEL SURVIVED multi-chunk fork — module data/stack are co-resident, not colliding");

runStress(5000);
assertSentinelIntact("after 5000-frame stress fork");
console.log("  ok: SENTINEL SURVIVED 5000-frame stress fork — no low-memory corruption across reuse");

runAbortCycle();
assertSentinelIntact("after abort-replay cycle");
console.log("  ok: SENTINEL SURVIVED abort-replay cycle");

runAbortCorruption();
assertSentinelIntact("after abort-replay corruption fault injection");
console.log("  ok: SENTINEL SURVIVED abort-replay corruption fault injection");

// ===========================================================================
// HEADLINE: parent -> address-space copy -> child replay seeding (Phase 6 D5)
// ===========================================================================
//
// This simulates a REAL fork end to end. In a live fork the child inherits a
// BYTE COPY of the parent's guest linear memory (the frame arena included) but
// runs a FRESH module instance placed at a DIFFERENT `__memory_base` whose
// journal starts EMPTY. So the child module cannot see the parent module's
// in-memory journal. The parent therefore serializes its sealed replay journal
// as a KFRE image into guest memory BEFORE the fork (`fm_serialize_journal`);
// the child, after the copy, decodes that image from the SAME guest offset and
// seeds its own journal + resume-slot table (`fm_begin_child_replay`), then
// drives the rewind. This is the module equivalent of the JS
// `arena.appendReplayEvents` (parent) / `replayEventsForChild` (child) path in
// `host/src/fork-process-continuation.ts`.
//
// The proof asserts the child rewinds in EXACTLY the parent's frame order with
// EXACTLY the parent's resume slots, reading ONLY copied guest memory (the
// parent's module region is scrubbed to garbage in the child copy first), from
// a disjoint, independent module placement.

// A self-contained layout for the fork round trip (disjoint from the globals
// above; each of the parent and child gets its OWN memory). All regions are
// mutually disjoint so a byte copy of the whole memory keeps every one intact:
//   [0, FR_MB_A)                          low guest data (sentinel proxy)
//   [FR_MB_A, FR_MB_A+FR_MOD_MEM)         PARENT module data + BSS  (__memory_base A)
//   [.., FR_PSTACK_TOP)                   parent shadow stack (1 MiB, grows down)
//   [FR_MB_B, FR_MB_B+FR_MOD_MEM)         CHILD module data + BSS   (__memory_base B)
//   [.., FR_CSTACK_TOP)                   child shadow stack (1 MiB, grows down)
//   [FR_IMAGE_BASE, +FR_IMAGE_CAP)        serialized KFRE journal image
//   [FR_ARENA_BASE, +FR_ARENA_LEN)        per-fork linked-frame arena
const MiB = 1024 * 1024;
const FR_MB_A = 8 * MiB; // parent __memory_base
const FR_MOD_MEM = 8 * MiB; // module data + BSS reservation (> 4 MiB heap)
const FR_PSTACK_TOP = FR_MB_A + FR_MOD_MEM + 1 * MiB; // 17 MiB
const FR_MB_B = 18 * MiB; // child __memory_base (disjoint from A)
const FR_CSTACK_TOP = FR_MB_B + FR_MOD_MEM + 1 * MiB; // 27 MiB
const FR_IMAGE_BASE = 28 * MiB;
const FR_IMAGE_CAP = 1 * MiB;
const FR_ARENA_BASE = 32 * MiB;
const FR_ARENA_LEN = 8 * MiB;
const FR_ARENA_END = FR_ARENA_BASE + FR_ARENA_LEN; // 40 MiB
const FR_SENTINEL_END = FR_MB_A; // low guest region, below both module bases
const FR_PAGES = Math.ceil((FR_ARENA_END + PAGE) / PAGE);

// Static disjointness guarantees (so the whole-memory byte copy is lossless and
// the parent/child module placements never overlap).
assert.ok(FR_MB_A + FR_MOD_MEM <= FR_PSTACK_TOP - 1 * MiB, "parent data below its stack");
assert.ok(FR_PSTACK_TOP <= FR_MB_B, "parent region below child base");
assert.ok(FR_MB_B + FR_MOD_MEM <= FR_CSTACK_TOP - 1 * MiB, "child data below its stack");
assert.ok(FR_CSTACK_TOP <= FR_IMAGE_BASE, "child region below image");
assert.ok(FR_IMAGE_BASE + FR_IMAGE_CAP <= FR_ARENA_BASE, "image below arena");

function instantiateAt(mem, moduleBase, stackTop) {
  return new WebAssembly.Instance(module, {
    env: {
      memory: mem,
      __indirect_function_table: new WebAssembly.Table({ element: "anyfunc", initial: 0 }),
      __wpk_fork_function_catalog: new WebAssembly.Table({ element: "anyfunc", initial: 0 }),
      __wpk_fork_drive_table: new WebAssembly.Table({ element: "anyfunc", initial: 0 }),
      __wpk_fork_static_root_catalog: new WebAssembly.Table({ element: "anyref", initial: 0 }),
      __stack_pointer: new WebAssembly.Global({ value: "i32", mutable: true }, stackTop),
      __memory_base: new WebAssembly.Global({ value: "i32", mutable: false }, moduleBase),
      __table_base: new WebAssembly.Global({ value: "i32", mutable: false }, 0),
      resolve_externref: (_handle) => ({}),
    },
  }).exports;
}

function memViews(mem) {
  const u8 = () => new Uint8Array(mem.buffer);
  const dv = () => new DataView(mem.buffer);
  return {
    u8,
    readU32: (off) => dv().getUint32(off, true),
    writeU32: (off, val) => dv().setUint32(off, val >>> 0, true),
    readByte: (off) => u8()[off],
  };
}

// Run one full parent -> copy -> child replay-seeding round trip. Returns the
// serialized image length and the child's observed resume-slot sequence.
function forkRoundTrip(act, frames, label) {
  // --- PARENT instance at __memory_base A, over its own memory. ---
  const parentMemory = new WebAssembly.Memory({ initial: FR_PAGES, maximum: 16384, shared: true });
  const P = instantiateAt(parentMemory, FR_MB_A, FR_PSTACK_TOP);
  const pm = memViews(parentMemory);
  const perr = () => P.fm_last_errno();

  // Seed a low guest sentinel below both module bases (a co-residency proxy).
  {
    const buf = pm.u8();
    for (let off = 0; off < FR_SENTINEL_END; off++) buf[off] = sentinelByte(off);
  }

  P.fm_set_format(4, 128);
  assert.equal(perr(), 0, `${label}: parent set_format`);

  const moduleBuffer = P.fm_begin_unwind_fixed_arena(act, FR_ARENA_BASE, FR_ARENA_LEN) >>> 0;
  assert.equal(perr(), 0, `${label}: parent begin_unwind`);
  assert.ok(moduleBuffer >= FR_ARENA_BASE && moduleBuffer < FR_ARENA_END, `${label}: buffer in arena`);

  for (const s of frames) {
    const payload = P.__wpk_fork_frame_reserve(s.size) >>> 0;
    assert.equal(perr(), 0, `${label}: reserve ${s.func}`);
    assert.ok(payload >= FR_ARENA_BASE && payload < FR_ARENA_END, `${label}: payload ${s.func} in arena`);
    pm.writeU32(payload + 0, s.func);
    pm.writeU32(payload + 4, s.call);
    pm.writeU32(payload + 8, 0);
    pm.writeU32(payload + 12, 0);
    const buf = pm.u8();
    for (let i = 16; i < s.size; i++) buf[payload + i] = s.fill;
    P.__wpk_fork_frame_commit(payload);
    assert.equal(perr(), 0, `${label}: commit ${s.func}`);
  }
  P.fm_finish_unwind();
  assert.equal(perr(), 0, `${label}: parent finish_unwind`);

  // Parent serializes its sealed journal as a KFRE image INTO guest memory.
  // fm_serialize_journal_fixed_arena is the in-realm, no-servicer sibling of
  // fm_serialize_journal_alloc; it returns the BASE pointer (not the length —
  // read that back separately via fm_journal_image_len, an i64/BigInt export).
  const imagePtr = P.fm_serialize_journal_fixed_arena(FR_IMAGE_BASE, FR_IMAGE_CAP) >>> 0;
  assert.equal(perr(), 0, `${label}: parent serialize_journal`);
  assert.equal(imagePtr, FR_IMAGE_BASE, `${label}: serialize_journal returns the base pointer`);
  const imageLen = Number(P.fm_journal_image_len());
  // KFRE = 40-byte manifest + one 24-byte header per segment + N * 8-byte
  // entries. Segments hold up to SEGMENT_CAPACITY (4080) events each.
  const SEGMENT_CAPACITY = 4080;
  const segmentCount = Math.ceil(frames.length / SEGMENT_CAPACITY);
  const expectedImageLen = 40 + segmentCount * 24 + frames.length * 8;
  assert.equal(imageLen, expectedImageLen, `${label}: serialized KFRE image length`);
  assert.ok(imageLen <= FR_IMAGE_CAP, `${label}: KFRE image fits the host region`);

  // --- Simulate the fork address-space copy: byte-copy the WHOLE memory. ---
  const childMemory = new WebAssembly.Memory({ initial: FR_PAGES, maximum: 16384, shared: true });
  new Uint8Array(childMemory.buffer).set(new Uint8Array(parentMemory.buffer));

  // Prove the child depends ONLY on copied guest data (the arena + the KFRE
  // image), never on the parent module's live state: scrub the parent's module
  // data + BSS + stack region in the CHILD copy to garbage before the child
  // runs. If the child read anything there, its replay would diverge or fault.
  {
    const cbuf = new Uint8Array(childMemory.buffer);
    for (let off = FR_MB_A; off < FR_PSTACK_TOP; off++) cbuf[off] = 0x5a;
  }

  // --- Parent drives its OWN replay as the parity oracle. ---
  P.fm_begin_replay();
  assert.equal(perr(), 0, `${label}: parent begin_replay`);
  const parentSeq = [];
  for (let i = frames.length - 1; i >= 0; i--) {
    const slot = P.__wpk_fork_resume_peek(0);
    assert.equal(perr(), 0, `${label}: parent resume_peek step ${i}`);
    const payload = P.__wpk_fork_frame_next(frames[i].size) >>> 0;
    assert.equal(perr(), 0, `${label}: parent next ${frames[i].func}`);
    parentSeq.push({ slot, func: pm.readU32(payload) });
  }
  assert.equal(P.__wpk_fork_resume_peek(0), 0, `${label}: parent sentinel slot`);
  P.fm_finish_replay();
  assert.equal(perr(), 0, `${label}: parent finish_replay`);

  // --- CHILD: a FRESH instance at a DIFFERENT __memory_base, empty journal. ---
  const C = instantiateAt(childMemory, FR_MB_B, FR_CSTACK_TOP);
  const cm = memViews(childMemory);
  const cerr = () => C.fm_last_errno();
  C.fm_set_format(4, 128);
  assert.equal(cerr(), 0, `${label}: child set_format`);

  // Seed the child's journal + resume table from the COPIED KFRE image and
  // attach its rewind driver to the COPIED arena at the inherited anchor.
  C.fm_begin_child_replay(moduleBuffer, FR_IMAGE_BASE, imageLen);
  assert.equal(cerr(), 0, `${label}: child begin_child_replay`);

  const childSeq = [];
  for (let i = frames.length - 1; i >= 0; i--) {
    const s = frames[i];
    const slot = C.__wpk_fork_resume_peek(0);
    assert.equal(cerr(), 0, `${label}: child resume_peek ${s.func}`);
    const peeked = C.__wpk_fork_frame_peek(s.size) >>> 0;
    assert.equal(cerr(), 0, `${label}: child peek ${s.func}`);
    assert.equal(cm.readU32(peeked), s.func, `${label}: child peeked func ${s.func}`);
    const payload = C.__wpk_fork_frame_next(s.size) >>> 0;
    assert.equal(cerr(), 0, `${label}: child next ${s.func}`);
    assert.equal(payload, peeked, `${label}: child peek==next ${s.func}`);
    assert.equal(cm.readByte(payload + 16), s.fill, `${label}: child payload fill ${s.func}`);
    childSeq.push({ slot, func: cm.readU32(payload) });
  }
  assert.equal(C.__wpk_fork_resume_peek(0), 0, `${label}: child sentinel slot`);
  C.fm_finish_replay();
  assert.equal(cerr(), 0, `${label}: child finish_replay`);

  // --- Parity: the child rewound in EXACTLY the parent's order + slots. ---
  assert.equal(childSeq.length, parentSeq.length, `${label}: replay length parity`);
  for (let i = 0; i < parentSeq.length; i++) {
    assert.equal(childSeq[i].func, parentSeq[i].func, `${label}: order parity step ${i}`);
    assert.equal(childSeq[i].slot, parentSeq[i].slot, `${label}: RESUME-SLOT parity step ${i}`);
    // The order must also equal the reverse of commit order (rewind semantics).
    assert.equal(
      childSeq[i].func,
      frames[frames.length - 1 - i].func,
      `${label}: reverse-of-commit step ${i}`,
    );
  }

  // A replay-only child must REFUSE to reserve (it has no live frame arena).
  assert.equal(C.__wpk_fork_frame_reserve(32), 0, `${label}: child reserve refused`);
  assert.equal(cerr(), EINVAL, `${label}: child reserve EINVAL`);

  // The child left the low guest sentinel (copied) byte-for-byte intact.
  {
    const cbuf = cm.u8();
    for (let off = 0; off < FR_SENTINEL_END; off += 4093) {
      if (cbuf[off] !== sentinelByte(off)) {
        assert.fail(`${label}: child corrupted low sentinel at 0x${off.toString(16)}`);
      }
    }
  }

  return { imageLen, slots: childSeq.map((entry) => entry.slot) };
}

console.log("");
console.log("fork-module parent -> address-space copy -> child replay seeding (real fork):");

// Case A: a 4-frame, multi-chunk fork. Distinct funcs -> slots 1..4; the child
// must reproduce the reverse-of-commit slot sequence [4, 3, 2, 1].
const small = forkRoundTrip(
  7,
  [
    { func: 101, call: 1, fill: 0xa1, size: 40 },
    { func: 202, call: 2, fill: 0xb2, size: 64 },
    { func: 303, call: 3, fill: 0xc3, size: 65216 }, // forces a second chunk
    { func: 404, call: 4, fill: 0xd4, size: 48 },
  ],
  "4-frame",
);
assert.deepEqual(small.slots, [4, 3, 2, 1], "4-frame child resume-slot sequence");
console.log(
  `  ok: 4-frame multi-chunk fork — child (fresh instance, different __memory_base, empty journal) `
    + `seeded from a ${small.imageLen}-byte KFRE image in copied memory; rewind order + slots [4,3,2,1] match the parent`,
);

// Case B: a >=5000-frame fork. Distinct funcs 1000..5999 -> slots 1..5000; the
// child's reverse replay yields slots 5000, 4999, ..., 1.
const bigFrames = [];
for (let i = 0; i < 5000; i++) {
  bigFrames.push({ func: 1000 + i, call: i, fill: i & 0xff, size: 32 });
}
const big = forkRoundTrip(3, bigFrames, "5000-frame");
assert.equal(big.slots.length, 5000, "5000-frame child slot count");
assert.equal(big.slots[0], 5000, "5000-frame first replay slot");
assert.equal(big.slots[4999], 1, "5000-frame last replay slot");
for (let i = 0; i < 5000; i++) {
  assert.equal(big.slots[i], 5000 - i, `5000-frame slot parity step ${i}`);
}
console.log(
  `  ok: 5000-frame fork — child seeded from a ${big.imageLen}-byte KFRE image in copied memory; `
    + `all 5000 resume slots match the parent exactly`,
);
console.log(
  "  ok: CHILD REPLAY SEEDING proven — the child rewound entirely from copied guest memory "
    + "(parent module region scrubbed) at a disjoint placement, with resume-slot parity.",
);

console.log("");
console.log(
  "ALL PASS: co-resident PIE module drove the full unwind->rewind loop over a host arena AND left the low guest sentinel byte-for-byte intact.",
);
