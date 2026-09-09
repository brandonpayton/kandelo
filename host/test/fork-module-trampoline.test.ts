// Phase 6 D7a.1a-host: the production TypeScript port of the per-activation
// frame TRAMPOLINE (`crates/fork-module/tests/fork-trampoline.mjs`) must, in a
// real WebAssembly engine, route N activations' frozen guest-facing frame calls
// to the shared fork-module's activation-parameterized exports without
// cross-activation aliasing. This mirrors the module-side multi-activation
// harness against the STAGED `fork_module32.wasm`.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { resolveBinary } from "../src/binary-resolver";
import {
  type ForkModuleExports,
  instantiateForkModule,
} from "../src/fork-module-instance";
import {
  emitTrampoline,
  ForkModuleTrampolines,
} from "../src/fork-module-trampoline";

const PAGE = 65536;
const MiB = 1024 * 1024;
const EINVAL = 22;

function loadForkModule32(): WebAssembly.Module {
  return new WebAssembly.Module(readFileSync(resolveBinary("fork_module32.wasm")));
}

describe("fork-module trampoline (production TS port)", () => {
  it("emits a valid, correctly-typed trampoline module", () => {
    const bytes = emitTrampoline(1);
    expect(WebAssembly.validate(bytes as unknown as BufferSource)).toBe(true);
    const mod = new WebAssembly.Module(bytes as unknown as BufferSource);
    const imports = WebAssembly.Module.imports(mod).map((i) => `${i.module}.${i.name}`);
    for (const need of [
      "shared.fm_frame_reserve",
      "shared.fm_frame_commit",
      "shared.fm_frame_peek",
      "shared.fm_frame_next",
      "shared.fm_resume_peek",
    ]) {
      expect(imports).toContain(need);
    }
    const exportNames = new Set(WebAssembly.Module.exports(mod).map((e) => e.name));
    for (const need of [
      "__wpk_fork_frame_reserve",
      "__wpk_fork_frame_commit",
      "__wpk_fork_frame_peek",
      "__wpk_fork_frame_next",
      "__wpk_fork_resume_peek",
    ]) {
      expect(exportNames.has(need)).toBe(true);
    }
  });

  it("routes two activations' frames to independent per-activation drivers", () => {
    const module = loadForkModule32();
    const ARENA_END = 32 * MiB;
    const memory = new WebAssembly.Memory({
      initial: Math.ceil((ARENA_END + PAGE) / PAGE),
      maximum: 16384,
      shared: true,
    });
    // Reserve the shared module region low; carve two disjoint frame arenas high.
    let next = 8 * MiB;
    const fm = instantiateForkModule({
      module,
      memory,
      ptrWidth: 4,
      reserve: (size) => {
        const base = next;
        next += size;
        return base;
      },
      label: "trampoline-test",
    });
    const x = fm.exports as ForkModuleExports;
    const call = (fn: keyof ForkModuleExports, ...args: number[]): number =>
      Number((x[fn] as (...a: number[]) => number)(...args));
    const errno = (): number => call("fm_last_errno");

    const ARENA0_BASE = 20 * MiB;
    const ARENA1_BASE = 26 * MiB;
    const ARENA_LEN = 4 * MiB;
    const PREFIX0 = 128;
    const PREFIX1 = 256;

    // Drive the unwind over caller-owned FIXED arenas, NOT the production
    // channel-mmap growing arena: this is a single-threaded in-process harness
    // with no worker to service the module's blocking `memory_atomic_wait32`
    // channel handshake, so the fixed-arena entries bump-allocate within the two
    // disjoint high regions carved above instead. The journal / writer / resume
    // table are byte-identical to the channel path, so this still exercises the
    // exact multi-activation frame routing the production `fm_begin_unwind` does.
    call("fm_set_format", 4, PREFIX0);
    expect(errno()).toBe(0);
    const mb0 = call("fm_begin_unwind_fixed_arena", 0, ARENA0_BASE, ARENA_LEN) >>> 0;
    expect(errno()).toBe(0);
    expect(mb0).toBeGreaterThanOrEqual(ARENA0_BASE);
    const mb1 =
      call("fm_add_activation_unwind_fixed_arena", 1, ARENA1_BASE, ARENA_LEN, PREFIX1) >>> 0;
    expect(errno()).toBe(0);
    expect(mb1).toBeGreaterThanOrEqual(ARENA1_BASE);

    const trampolines = new ForkModuleTrampolines(x);
    const t = (act: number): Record<string, (...a: number[]) => number> =>
      trampolines.instanceFor(act).exports as unknown as Record<
        string,
        (...a: number[]) => number
      >;

    const dv = (): DataView => new DataView(memory.buffer);
    const u8 = (): Uint8Array => new Uint8Array(memory.buffer);
    const writePayload = (
      payload: number,
      func: number,
      fill: number,
      size: number,
    ): void => {
      dv().setUint32(payload + 0, func, true);
      dv().setUint32(payload + 4, 1, true);
      dv().setUint32(payload + 8, 0, true);
      dv().setUint32(payload + 12, 0, true);
      const buf = u8();
      for (let i = 16; i < size; i++) buf[payload + i] = fill;
    };

    const commits = [
      { act: 0, func: 101, fill: 0xa1, size: 40 },
      { act: 1, func: 301, fill: 0xc1, size: 48 },
      { act: 0, func: 202, fill: 0xb2, size: 40 },
      { act: 1, func: 302, fill: 0xc2, size: 56 },
    ];
    for (const c of commits) {
      const payload = t(c.act).__wpk_fork_frame_reserve(c.size) >>> 0;
      expect(errno()).toBe(0);
      const base = c.act === 0 ? ARENA0_BASE : ARENA1_BASE;
      expect(payload).toBeGreaterThanOrEqual(base);
      expect(payload).toBeLessThan(base + ARENA_LEN);
      writePayload(payload, c.func, c.fill, c.size);
      t(c.act).__wpk_fork_frame_commit(payload);
      expect(errno()).toBe(0);
    }

    call("fm_finish_unwind");
    expect(errno()).toBe(0);
    call("fm_begin_replay");
    expect(errno()).toBe(0);

    const replay = [...commits].reverse();
    for (const c of replay) {
      const wrong = c.act === 0 ? 1 : 0;
      // Wrong activation's peek is rejected by the journal activation gate.
      expect(t(wrong).__wpk_fork_frame_peek(c.size) >>> 0).toBe(0);
      expect(errno()).toBe(EINVAL);
      // The correct activation reconstructs its own frame.
      const peeked = t(c.act).__wpk_fork_frame_peek(c.size) >>> 0;
      expect(errno()).toBe(0);
      expect(dv().getUint32(peeked, true)).toBe(c.func);
      const advanced = t(c.act).__wpk_fork_frame_next(c.size) >>> 0;
      expect(errno()).toBe(0);
      expect(advanced).toBe(peeked);
      expect(u8()[advanced + 16]).toBe(c.fill);
    }
    call("fm_finish_replay");
    expect(errno()).toBe(0);
  });

  it("caches one instance per activation id and evicts on request", () => {
    const module = loadForkModule32();
    const memory = new WebAssembly.Memory({ initial: 256, maximum: 16384, shared: true });
    let next = 8 * MiB;
    const fm = instantiateForkModule({
      module,
      memory,
      ptrWidth: 4,
      reserve: (size) => {
        const base = next;
        next += size;
        return base;
      },
      label: "trampoline-cache-test",
    });
    const trampolines = new ForkModuleTrampolines(fm.exports as ForkModuleExports);
    const first = trampolines.instanceFor(2);
    expect(trampolines.instanceFor(2)).toBe(first);
    trampolines.evict(2);
    expect(trampolines.instanceFor(2)).not.toBe(first);
  });
});
