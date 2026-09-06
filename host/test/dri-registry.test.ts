/**
 * Unit tests for the SAB-backed bo store surface added in
 * `host(dri): SAB-backed bo store — closes byte-verify across fork`.
 *
 * These tests exercise `GbmBoRegistry` in isolation, without booting
 * a kernel — they verify the cross-pid sync semantics that the
 * `dumb_roundtrip` end-to-end spec depends on, but at a granularity
 * that pinpoints a regression to one method (bind / unbind / prime
 * / findBindingByAddr / resolver wiring) rather than "the byte-verify
 * failed somewhere in a fork."
 */
import { describe, expect, it } from "vitest";
import { GbmBoRegistry } from "../src/dri/registry.js";

const BO_SIZE = 4096;
const BO_ADDR = 0;

function newMemory(): WebAssembly.Memory {
  return new WebAssembly.Memory({ initial: 1, maximum: 4, shared: true });
}

function fillPattern(mem: WebAssembly.Memory, addr: number, len: number, seed: number): void {
  const view = new Uint8Array(mem.buffer, addr, len);
  for (let i = 0; i < len; i++) view[i] = (seed + i) & 0xff;
}

function readPattern(mem: WebAssembly.Memory, addr: number, len: number): Uint8Array {
  return new Uint8Array(mem.buffer.slice(addr, addr + len));
}

function expectPattern(actual: Uint8Array, seed: number): void {
  for (let i = 0; i < actual.length; i++) {
    if (actual[i] !== ((seed + i) & 0xff)) {
      throw new Error(`pattern mismatch at byte ${i}: got 0x${actual[i].toString(16)}, want 0x${((seed + i) & 0xff).toString(16)}`);
    }
  }
}

describe("GbmBoRegistry — SAB-backed bo store", () => {
  it("bind alone does NOT touch the binding's Memory (timing-fix invariant)", () => {
    // Regression guard for the postmortem in the PR commit message:
    // writing SAB → Memory inside bind() gets clobbered by
    // ensureProcessMemoryCovers's anonymous-mmap zero-fill that runs
    // AFTER the syscall returns. The contract is: bind() is metadata
    // only; the SAB → Memory prime is deferred to primeBindFromSab,
    // which the kernel-worker calls post-zero-fill.
    const memA = newMemory();
    const memB = newMemory();
    const reg = new GbmBoRegistry({
      getProcessMemory: (pid) => (pid === 100 ? memA : pid === 200 ? memB : undefined),
    });
    reg.create({ pid: 100, bo_id: 1, size: BO_SIZE, w: 16, h: 16, stride: 64 });
    reg.bind(100, 1, BO_ADDR, BO_SIZE);
    fillPattern(memA, BO_ADDR, BO_SIZE, 0x10);
    reg.unbind(100, 1, BO_ADDR, BO_SIZE); // flushes memA → SAB

    // Sentinel value that bind() must NOT overwrite.
    fillPattern(memB, BO_ADDR, BO_SIZE, 0x7e);
    reg.bind(200, 1, BO_ADDR, BO_SIZE);
    expectPattern(readPattern(memB, BO_ADDR, BO_SIZE), 0x7e);
  });

  it("primeBindFromSab copies the SAB into the bound pid's Memory at [addr, len)", () => {
    const memA = newMemory();
    const memB = newMemory();
    const reg = new GbmBoRegistry({
      getProcessMemory: (pid) => (pid === 100 ? memA : pid === 200 ? memB : undefined),
    });
    reg.create({ pid: 100, bo_id: 1, size: BO_SIZE, w: 16, h: 16, stride: 64 });
    reg.bind(100, 1, BO_ADDR, BO_SIZE);
    fillPattern(memA, BO_ADDR, BO_SIZE, 0x21);
    reg.unbind(100, 1, BO_ADDR, BO_SIZE);

    reg.bind(200, 1, BO_ADDR, BO_SIZE);
    reg.primeBindFromSab(200, 1, memB);
    expectPattern(readPattern(memB, BO_ADDR, BO_SIZE), 0x21);
  });

  it("unbind flushes the unbinding pid's bytes into the SAB", () => {
    // A subsequent prime in a DIFFERENT pid sees the bytes the
    // unbinding pid wrote. This is the only path that gets bytes
    // into the SAB when the writer never overlaps a reader's bind.
    const memA = newMemory();
    const memB = newMemory();
    const reg = new GbmBoRegistry({
      getProcessMemory: (pid) => (pid === 100 ? memA : pid === 200 ? memB : undefined),
    });
    reg.create({ pid: 100, bo_id: 1, size: BO_SIZE, w: 16, h: 16, stride: 64 });
    reg.bind(100, 1, BO_ADDR, BO_SIZE);
    fillPattern(memA, BO_ADDR, BO_SIZE, 0x42);
    reg.unbind(100, 1, BO_ADDR, BO_SIZE);

    reg.bind(200, 1, BO_ADDR, BO_SIZE);
    reg.primeBindFromSab(200, 1, memB);
    expectPattern(readPattern(memB, BO_ADDR, BO_SIZE), 0x42);
  });

  it("primeBindFromSab flushes OTHER currently-bound pids before priming", () => {
    // The dumb_roundtrip flow: parent never unbinds before fork.
    // The cross-pid flush inside primeBindFromSab is what sources
    // the SAB from the writer's still-live Memory.
    const memParent = newMemory();
    const memChild = newMemory();
    const reg = new GbmBoRegistry({
      getProcessMemory: (pid) => (pid === 100 ? memParent : pid === 200 ? memChild : undefined),
    });
    reg.create({ pid: 100, bo_id: 1, size: BO_SIZE, w: 16, h: 16, stride: 64 });
    reg.bind(100, 1, BO_ADDR, BO_SIZE);
    fillPattern(memParent, BO_ADDR, BO_SIZE, 0xa5);

    // Parent has NOT unbound. Child binds + primes.
    reg.bind(200, 1, BO_ADDR, BO_SIZE);
    reg.primeBindFromSab(200, 1, memChild);

    expectPattern(readPattern(memChild, BO_ADDR, BO_SIZE), 0xa5);
  });

  it("findBindingByAddr returns the bo_id for a live (pid, addr) and undefined otherwise", () => {
    const reg = new GbmBoRegistry();
    reg.create({ pid: 100, bo_id: 7, size: BO_SIZE, w: 16, h: 16, stride: 64 });
    reg.bind(100, 7, 0x2000, BO_SIZE);

    expect(reg.findBindingByAddr(100, 0x2000)).toBe(7);
    expect(reg.findBindingByAddr(100, 0x1000)).toBeUndefined(); // wrong addr
    expect(reg.findBindingByAddr(999, 0x2000)).toBeUndefined(); // wrong pid

    reg.unbind(100, 7, 0x2000, BO_SIZE);
    expect(reg.findBindingByAddr(100, 0x2000)).toBeUndefined(); // post-unbind
  });

  it("pure-metadata mode (no resolver) records bindings without touching any Memory", () => {
    // The browser main-thread mirror constructs GbmBoRegistry with
    // no resolver. bind/unbind/primeBindFromSab MUST be safe in that
    // mode — they just skip the Memory-side work.
    const memB = newMemory();
    fillPattern(memB, BO_ADDR, BO_SIZE, 0xee); // sentinel

    const reg = new GbmBoRegistry(); // no resolver
    reg.create({ pid: 100, bo_id: 1, size: BO_SIZE, w: 16, h: 16, stride: 64 });
    reg.bind(100, 1, BO_ADDR, BO_SIZE);
    expect(() => reg.unbind(100, 1, BO_ADDR, BO_SIZE)).not.toThrow();

    reg.bind(200, 1, BO_ADDR, BO_SIZE);
    // primeBindFromSab does SAB → memB copy regardless of resolver
    // (resolver only gates the cross-pid flush in the OTHER-pids
    // loop). With no resolver and no prior unbind reaching memB,
    // the SAB is all zeros — primeBindFromSab overwrites memB's
    // sentinel with zeros.
    expect(() => reg.primeBindFromSab(200, 1, memB)).not.toThrow();
    const view = readPattern(memB, BO_ADDR, BO_SIZE);
    for (let i = 0; i < view.length; i++) expect(view[i]).toBe(0);
  });

  it("resolver returning undefined for a pid silently skips that pid's flush", () => {
    // The contract documented on ProcessMemoryResolver: returning
    // undefined for a bound pid signals "process has gone away,
    // skip the sync." The bind-prime path on a peer pid must NOT
    // throw and must continue with whatever the SAB already holds.
    const memChild = newMemory();
    fillPattern(memChild, BO_ADDR, BO_SIZE, 0xcd);
    const reg = new GbmBoRegistry({
      // Pid 100 (the writer) is unreachable — simulate "parent exited
      // before child's bind reached the prime hook." Pid 200 (child)
      // is reachable but only as a self-flush target, which the
      // primeBindFromSab loop excludes.
      getProcessMemory: (_pid) => undefined,
    });
    reg.create({ pid: 100, bo_id: 1, size: BO_SIZE, w: 16, h: 16, stride: 64 });
    reg.bind(100, 1, BO_ADDR, BO_SIZE);
    reg.bind(200, 1, BO_ADDR, BO_SIZE);

    expect(() => reg.primeBindFromSab(200, 1, memChild)).not.toThrow();
    // SAB is zero (no flush ever succeeded); primeBindFromSab
    // overwrites memChild's 0xcd sentinel with zeros.
    const view = readPattern(memChild, BO_ADDR, BO_SIZE);
    for (let i = 0; i < view.length; i++) expect(view[i]).toBe(0);
  });

  it("setProcessMemoryResolver wires the resolver after construction", () => {
    // CentralizedKernelWorker uses this setter from its constructor
    // (the registry is built before the worker's process map exists).
    // A resolver set this way must drive the same flush path that a
    // constructor-injected resolver does.
    const memA = newMemory();
    const memB = newMemory();
    const reg = new GbmBoRegistry(); // constructed with no resolver
    reg.setProcessMemoryResolver((pid) =>
      pid === 100 ? memA : pid === 200 ? memB : undefined,
    );

    reg.create({ pid: 100, bo_id: 1, size: BO_SIZE, w: 16, h: 16, stride: 64 });
    reg.bind(100, 1, BO_ADDR, BO_SIZE);
    fillPattern(memA, BO_ADDR, BO_SIZE, 0x33);
    reg.unbind(100, 1, BO_ADDR, BO_SIZE);

    reg.bind(200, 1, BO_ADDR, BO_SIZE);
    reg.primeBindFromSab(200, 1, memB);
    expectPattern(readPattern(memB, BO_ADDR, BO_SIZE), 0x33);
  });

  it("syncFromMemory flushes every bound pid's Memory into the SAB", () => {
    const memA = newMemory();
    const memB = newMemory();
    const reg = new GbmBoRegistry({
      getProcessMemory: (pid) => (pid === 100 ? memA : pid === 200 ? memB : undefined),
    });
    reg.create({ pid: 100, bo_id: 1, size: BO_SIZE, w: 16, h: 16, stride: 64 });
    reg.bind(100, 1, BO_ADDR, BO_SIZE);
    reg.bind(200, 1, BO_ADDR, BO_SIZE);

    fillPattern(memA, BO_ADDR, BO_SIZE, 0x42);
    fillPattern(memB, BO_ADDR, BO_SIZE, 0x42); // both writers agree
    reg.syncFromMemory(1);
    expectPattern(reg.pixelView(1)!.slice(0, BO_SIZE), 0x42);

    fillPattern(memA, BO_ADDR, BO_SIZE, 0x91);
    fillPattern(memB, BO_ADDR, BO_SIZE, 0x91);
    reg.syncFromMemory(1);
    expectPattern(reg.pixelView(1)!.slice(0, BO_SIZE), 0x91);
  });

  it("syncFromMemory is a no-op for unknown bo_id", () => {
    const reg = new GbmBoRegistry();
    expect(() => reg.syncFromMemory(999)).not.toThrow();
  });

  it("releases only one process ownership while preserving shared bo bytes", () => {
    const memParent = newMemory();
    const memChild = newMemory();
    const events: string[] = [];
    const reg = new GbmBoRegistry({
      getProcessMemory: (pid) =>
        pid === 100 ? memParent : pid === 200 ? memChild : undefined,
    });
    reg.onChange((pid, bo, event) => events.push(`${pid}:${bo}:${event}`));
    reg.create({
      pid: 100,
      bo_id: 1,
      size: BO_SIZE,
      w: 16,
      h: 16,
      stride: 64,
    });
    reg.bind(100, 1, BO_ADDR, BO_SIZE);
    reg.bind(200, 1, BO_ADDR, BO_SIZE);
    fillPattern(memParent, BO_ADDR, BO_SIZE, 0x61);

    reg.releaseProcess(100);

    expect(reg.get(100, 1)).toBeUndefined();
    expect(reg.get(200, 1)?.binding).toEqual({
      addr: BO_ADDR,
      len: BO_SIZE,
    });
    reg.primeBindFromSab(200, 1, memChild);
    expectPattern(readPattern(memChild, BO_ADDR, BO_SIZE), 0x61);
    expect(events).toContain("100:1:unbind");
    expect(events).not.toContain("100:1:destroy");
  });

  it("drops the bo when process teardown releases its final handle", () => {
    const mem = newMemory();
    const events: string[] = [];
    const reg = new GbmBoRegistry({
      getProcessMemory: (pid) => pid === 100 ? mem : undefined,
    });
    reg.onChange((pid, bo, event) => events.push(`${pid}:${bo}:${event}`));
    reg.create({
      pid: 100,
      bo_id: 1,
      size: BO_SIZE,
      w: 16,
      h: 16,
      stride: 64,
    });
    reg.bind(100, 1, BO_ADDR, BO_SIZE);

    reg.releaseProcess(100);

    expect(reg.get(100, 1)).toBeUndefined();
    expect(events.slice(-2)).toEqual([
      "100:1:unbind",
      "100:1:destroy",
    ]);
  });

  it("snapshot flushes the writer's memory before copying the pixels out", () => {
    const mem = newMemory();
    const reg = new GbmBoRegistry({
      getProcessMemory: (pid) => pid === 100 ? mem : undefined,
    });
    reg.create({ pid: 100, bo_id: 1, size: BO_SIZE, w: 16, h: 16, stride: 64 });
    reg.bind(100, 1, BO_ADDR, BO_SIZE);
    new Uint8Array(mem.buffer, BO_ADDR, BO_SIZE).fill(0xab);

    const [snapshot] = reg.snapshot();

    expect(snapshot!.bo_id).toBe(1);
    expect(snapshot!.pids).toEqual([100]);
    expect(snapshot!.bindings).toEqual([{ pid: 100, addr: BO_ADDR, len: BO_SIZE }]);
    expect(snapshot!.pixels.byteLength).toBe(BO_SIZE);
    expect(snapshot!.pixels[0]).toBe(0xab);

    // The copy leaves the running machine's canonical storage in place.
    new Uint8Array(mem.buffer, BO_ADDR, BO_SIZE).fill(0xcd);
    expect(snapshot!.pixels[0]).toBe(0xab);
    expect(reg.pixelView(1)![0]).toBe(0xab);
  });

  it("restore rebuilds the bo, its binding, and its pixels", () => {
    const mem = newMemory();
    const source = new GbmBoRegistry({
      getProcessMemory: (pid) => pid === 100 ? mem : undefined,
    });
    source.create({ pid: 100, bo_id: 1, size: BO_SIZE, w: 16, h: 16, stride: 64 });
    source.bind(100, 1, BO_ADDR, BO_SIZE);
    new Uint8Array(mem.buffer, BO_ADDR, BO_SIZE).fill(0xab);

    const target = new GbmBoRegistry();
    target.restore(source.snapshot());

    expect(target.get(100, 1)).toEqual({
      pid: 100,
      bo_id: 1,
      size: BO_SIZE,
      w: 16,
      h: 16,
      stride: 64,
      binding: { addr: BO_ADDR, len: BO_SIZE },
    });
    expect(target.pixelView(1)![0]).toBe(0xab);
  });

  it("restore replaces every bo the target already held", () => {
    const target = new GbmBoRegistry();
    target.create({ pid: 7, bo_id: 9, size: BO_SIZE, w: 16, h: 16, stride: 64 });

    target.restore([]);

    expect(target.get(7, 9)).toBeUndefined();
    expect(target.pixelView(9)).toBeUndefined();
  });

  it("restore gives each bo its own storage, unshared with the snapshot", () => {
    const source = new GbmBoRegistry();
    source.create({ pid: 100, bo_id: 1, size: BO_SIZE, w: 16, h: 16, stride: 64 });
    const snapshot = source.snapshot();

    const target = new GbmBoRegistry();
    target.restore(snapshot);
    target.pixelView(1)!.fill(0xab);

    expect(snapshot[0]!.pixels[0]).toBe(0);
    expect(source.pixelView(1)![0]).toBe(0);
  });
});
