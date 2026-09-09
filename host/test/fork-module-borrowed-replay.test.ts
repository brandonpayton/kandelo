// Phase 6 item 4: the module-side vfork BORROWED child replay. A vfork child
// shares the PARKED parent's memory (not a private copy), so it runs its OWN
// fork-module instance at a DISTINCT `__memory_base` and drives a READ-ONLY
// rewind over the parent's borrowed continuation, writing its mutable module
// prefix into a child-private region. The parent must resume byte-identically.
//
// This exercises the module primitive in isolation: two real
// `instantiateForkModule` instances (parent + borrowed child) co-resident in ONE
// shared memory, the parent unwinds over a fixed arena and serializes its
// journal, then the borrowed child replays it. The mandatory campaign guard is
// the assertion that the parent's continuation storage is BYTE-IDENTICAL after
// the child's replay — including after a mid-replay child TRAP (fault injection),
// the highest-risk failure mode (a bug corrupting the parent's address space).
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolveBinary } from "../src/binary-resolver";
import {
  type ForkModuleExports,
  instantiateForkModule,
} from "../src/fork-module-instance";

const PAGE = 65536;
const MiB = 1024 * 1024;
const EINVAL = 22;
const FIXED_PREFIX = 128;
const PTR_WIDTH = 4;

// Layout (single SHARED memory, borrowed — never copied):
//   [64KiB ..)      two fork-module regions, placed by the bump `reserve`
//   [PRIV, +prefix) child-private module prefix (disjoint from the arena)
//   [IMAGE, +cap)   serialized KFRE journal image
//   [ARENA, +len)   the parent's per-fork linked-frame arena (its continuation)
const PRIV_PREFIX_BASE = 30 * MiB;
const IMAGE_BASE = 28 * MiB;
const IMAGE_CAP = 1 * MiB;
const ARENA_BASE = 32 * MiB;
const ARENA_LEN = 8 * MiB;
const ARENA_END = ARENA_BASE + ARENA_LEN;
const MEM_END = ARENA_END;

const ACT = 5; // a single-activation borrowed fork (any activation id)

interface Frame {
  func: number;
  call: number;
  fill: number;
  size: number;
}
const FRAMES: readonly Frame[] = [
  { func: 101, call: 1, fill: 0xa1, size: 40 },
  { func: 202, call: 2, fill: 0xb2, size: 48 },
  { func: 303, call: 3, fill: 0xc3, size: 40 },
];

function loadForkModule32(): WebAssembly.Module {
  return new WebAssembly.Module(readFileSync(resolveBinary("fork_module32.wasm")));
}

/**
 * Assert two byte ranges are identical WITHOUT vitest's element-wise deep equal
 * (which is pathologically slow on multi-MiB typed arrays). Reports the first
 * differing offset so a parent-corruption regression is legible.
 */
function expectBytesEqual(actual: Uint8Array, expected: Uint8Array, label: string): void {
  expect(actual.length).toBe(expected.length);
  const equal = Buffer.from(actual).equals(Buffer.from(expected));
  if (!equal) {
    let firstDiff = -1;
    for (let i = 0; i < actual.length; i++) {
      if (actual[i] !== expected[i]) {
        firstDiff = i;
        break;
      }
    }
    throw new Error(
      `${label}: byte ranges differ at offset ${firstDiff} `
        + `(got 0x${actual[firstDiff]?.toString(16)}, want 0x${expected[firstDiff]?.toString(16)})`,
    );
  }
}

function sharedMemory(): WebAssembly.Memory {
  return new WebAssembly.Memory({
    initial: Math.ceil((MEM_END + PAGE) / PAGE),
    maximum: 16384,
    shared: true,
  });
}

/** A 64KiB-aligned bump allocator for the two co-resident module regions. */
function bumpReserve(start: number): (size: number) => number {
  let next = start;
  return (size: number): number => {
    const base = next;
    next = Math.ceil((base + size) / PAGE) * PAGE;
    return base;
  };
}

/**
 * Drive one unwind → serialize on `x` over a FIXED arena (no channel servicer),
 * returning the module-buffer anchor and the serialized journal image location.
 */
function unwindAndSerialize(
  x: ForkModuleExports,
  memory: WebAssembly.Memory,
): { moduleBuffer: number; imagePtr: number; imageLen: number } {
  const call = (fn: keyof ForkModuleExports, ...a: number[]): number =>
    Number((x[fn] as (...args: number[]) => number)(...a));
  const errno = (): number => call("fm_last_errno");
  const dv = (): DataView => new DataView(memory.buffer);
  const u8 = (): Uint8Array => new Uint8Array(memory.buffer);

  call("fm_set_format", PTR_WIDTH, FIXED_PREFIX);
  expect(errno()).toBe(0);
  const moduleBuffer = call("fm_begin_unwind_fixed_arena", ACT, ARENA_BASE, ARENA_LEN) >>> 0;
  expect(errno()).toBe(0);
  expect(moduleBuffer).toBeGreaterThanOrEqual(ARENA_BASE);
  expect(moduleBuffer).toBeLessThan(ARENA_END);

  for (const f of FRAMES) {
    const payload = call("__wpk_fork_frame_reserve", f.size) >>> 0;
    expect(errno()).toBe(0);
    dv().setUint32(payload + 0, f.func, true);
    dv().setUint32(payload + 4, f.call, true);
    dv().setUint32(payload + 8, 0, true);
    dv().setUint32(payload + 12, 0, true);
    const buf = u8();
    for (let i = 16; i < f.size; i++) buf[payload + i] = f.fill;
    call("__wpk_fork_frame_commit", payload);
    expect(errno()).toBe(0);
  }
  call("fm_finish_unwind");
  expect(errno()).toBe(0);

  const imagePtr = call("fm_serialize_journal_fixed_arena", IMAGE_BASE, IMAGE_CAP) >>> 0;
  expect(errno()).toBe(0);
  const imageLen = call("fm_journal_image_len");
  expect(imageLen).toBeGreaterThan(0);
  expect(imageLen).toBeLessThanOrEqual(IMAGE_CAP);
  return { moduleBuffer, imagePtr, imageLen };
}

describe("fork-module borrowed (vfork) child replay", () => {
  it("replays a borrowed continuation without touching the parent's storage", () => {
    const module = loadForkModule32();
    const memory = sharedMemory();
    const reserve = bumpReserve(PAGE);
    const parent = instantiateForkModule({
      module,
      memory,
      ptrWidth: PTR_WIDTH,
      reserve,
      label: "borrowed-test-parent",
    });
    // The borrowed child's OWN instance at a DISTINCT __memory_base in the SAME
    // shared memory (step 4: the second co-resident instance).
    const child = instantiateForkModule({
      module,
      memory,
      ptrWidth: PTR_WIDTH,
      reserve,
      label: "borrowed-test-child",
    });

    const P = parent.exports as ForkModuleExports;
    const C = child.exports as ForkModuleExports;
    const { moduleBuffer, imagePtr, imageLen } = unwindAndSerialize(P, memory);

    // Snapshot the parent's ENTIRE continuation storage (arena + module buffer +
    // fixed prefix all live inside the fixed arena). This is the parity oracle.
    const snapshot = new Uint8Array(memory.buffer, ARENA_BASE, ARENA_LEN).slice();
    const parentPrefix = new Uint8Array(memory.buffer, moduleBuffer, FIXED_PREFIX).slice();

    const cCall = (fn: keyof ForkModuleExports, ...a: number[]): number =>
      Number((C[fn] as (...args: number[]) => number)(...a));
    const cErr = (): number => cCall("fm_last_errno");
    const dv = (): DataView => new DataView(memory.buffer);
    const u8 = (): Uint8Array => new Uint8Array(memory.buffer);

    cCall("fm_set_format", PTR_WIDTH, FIXED_PREFIX);
    expect(cErr()).toBe(0);

    // The private prefix region starts as garbage; the module must copy the
    // parent's fixed prefix into it.
    for (let i = 0; i < FIXED_PREFIX; i++) u8()[PRIV_PREFIX_BASE + i] = 0x5a;

    cCall(
      "fm_begin_borrowed_child_replay",
      moduleBuffer,
      imagePtr,
      imageLen,
      PRIV_PREFIX_BASE,
    );
    expect(cErr()).toBe(0);

    // The child-private prefix now holds a COPY of the parent's prefix, so the
    // guest's rewind scribbles there — never the parked parent's prefix.
    const copiedPrefix = new Uint8Array(memory.buffer, PRIV_PREFIX_BASE, FIXED_PREFIX);
    expect([...copiedPrefix]).toEqual([...parentPrefix]);

    // Drive the borrowed replay in reverse commit order; the read-only cursor
    // reconstructs each frame from the PARENT's borrowed nodes.
    const replay = [...FRAMES].reverse();
    for (let i = 0; i < replay.length; i++) {
      const f = replay[i]!;
      const slot = cCall("__wpk_fork_resume_peek", 0);
      expect(cErr()).toBe(0);
      expect(slot).toBe(replay.length - i); // slots [N..1] in reverse
      const peeked = cCall("__wpk_fork_frame_peek", f.size) >>> 0;
      expect(cErr()).toBe(0);
      expect(dv().getUint32(peeked, true)).toBe(f.func);
      const advanced = cCall("__wpk_fork_frame_next", f.size) >>> 0;
      expect(cErr()).toBe(0);
      expect(advanced).toBe(peeked);
      expect(u8()[advanced + 16]).toBe(f.fill);
    }
    expect(cCall("__wpk_fork_resume_peek", 0)).toBe(0); // sentinel after exhaustion
    cCall("fm_finish_replay");
    expect(cErr()).toBe(0);

    // PARENT-CORRUPTION GUARD: the borrowed continuation storage is byte-identical.
    const after = new Uint8Array(memory.buffer, ARENA_BASE, ARENA_LEN);
    expectBytesEqual(after, snapshot, "parent continuation storage after replay");
  });

  it("leaves the parent byte-identical after a mid-replay child trap", () => {
    const module = loadForkModule32();
    const memory = sharedMemory();
    const reserve = bumpReserve(PAGE);
    const parent = instantiateForkModule({
      module,
      memory,
      ptrWidth: PTR_WIDTH,
      reserve,
      label: "fault-parent",
    });
    const child = instantiateForkModule({
      module,
      memory,
      ptrWidth: PTR_WIDTH,
      reserve,
      label: "fault-child",
    });
    const P = parent.exports as ForkModuleExports;
    const C = child.exports as ForkModuleExports;
    const { moduleBuffer, imagePtr, imageLen } = unwindAndSerialize(P, memory);
    const snapshot = new Uint8Array(memory.buffer, ARENA_BASE, ARENA_LEN).slice();

    const cCall = (fn: keyof ForkModuleExports, ...a: number[]): number =>
      Number((C[fn] as (...args: number[]) => number)(...a));
    const cErr = (): number => cCall("fm_last_errno");

    cCall("fm_set_format", PTR_WIDTH, FIXED_PREFIX);
    cCall(
      "fm_begin_borrowed_child_replay",
      moduleBuffer,
      imagePtr,
      imageLen,
      PRIV_PREFIX_BASE,
    );
    expect(cErr()).toBe(0);

    // Consume ONE frame, then inject a fault: peek the next frame with the WRONG
    // size. The read-only driver rejects it (EINVAL) mid-replay — a child trap.
    const replay = [...FRAMES].reverse();
    expect(cCall("__wpk_fork_frame_next", replay[0]!.size) >>> 0).toBeGreaterThan(0);
    expect(cErr()).toBe(0);
    expect(cCall("__wpk_fork_frame_peek", replay[1]!.size + 1) >>> 0).toBe(0);
    expect(cErr()).toBe(EINVAL);
    // The host abort path releases the child's (empty) chunk set — it must not
    // unmap or scrub the parent's borrowed storage.
    cCall("fm_abort");

    const after = new Uint8Array(memory.buffer, ARENA_BASE, ARENA_LEN);
    expectBytesEqual(after, snapshot, "parent continuation storage after mid-replay trap");
  });

  it("rejects a private prefix that overlaps the borrowed continuation", () => {
    const module = loadForkModule32();
    const memory = sharedMemory();
    const reserve = bumpReserve(PAGE);
    const parent = instantiateForkModule({
      module,
      memory,
      ptrWidth: PTR_WIDTH,
      reserve,
      label: "overlap-parent",
    });
    const child = instantiateForkModule({
      module,
      memory,
      ptrWidth: PTR_WIDTH,
      reserve,
      label: "overlap-child",
    });
    const P = parent.exports as ForkModuleExports;
    const C = child.exports as ForkModuleExports;
    const { moduleBuffer, imagePtr, imageLen } = unwindAndSerialize(P, memory);
    const snapshot = new Uint8Array(memory.buffer, ARENA_BASE, ARENA_LEN).slice();

    const cCall = (fn: keyof ForkModuleExports, ...a: number[]): number =>
      Number((C[fn] as (...args: number[]) => number)(...a));
    const cErr = (): number => cCall("fm_last_errno");

    cCall("fm_set_format", PTR_WIDTH, FIXED_PREFIX);
    // A private prefix INSIDE the parent's arena would alias its live storage:
    // the module must refuse it loudly, never copy over the parent's frames.
    cCall(
      "fm_begin_borrowed_child_replay",
      moduleBuffer,
      imagePtr,
      imageLen,
      moduleBuffer, // aliases the parent's own module buffer / prefix source
    );
    expect(cErr()).toBe(EINVAL);
    const after = new Uint8Array(memory.buffer, ARENA_BASE, ARENA_LEN);
    expectBytesEqual(after, snapshot, "parent continuation storage after rejected prefix");
  });
});
