import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { resolveBinary } from "../src/binary-resolver";
import {
  FORK_MODULE_REQUIRED_EXPORTS,
  instantiateForkModule,
} from "../src/fork-module-instance";

const PAGE = 65536;

function loadForkModule32(): WebAssembly.Module {
  const buf = readFileSync(resolveBinary("fork_module32.wasm"));
  return new WebAssembly.Module(buf);
}

function sharedMemory(pages: number): WebAssembly.Memory {
  return new WebAssembly.Memory({ initial: pages, maximum: 16384, shared: true });
}

describe("instantiateForkModule", () => {
  it("places the PIC fork-module into a host-reserved region and exposes its continuation exports", () => {
    const module = loadForkModule32();
    const memory = sharedMemory(256); // 16 MiB
    // A live-guest sentinel at a low offset must survive co-residency: the
    // module's static/BSS/stack live in the host-reserved region only.
    const sentinelAddr = 4096;
    new DataView(memory.buffer).setUint32(sentinelAddr, 0xdeadbeef, true);

    // Bump allocator standing in for the channel mmap: a page-aligned base
    // well above the sentinel.
    const reserveBase = 8 * 1024 * 1024;
    let reserved: { base: number; size: number } | null = null;
    const reserve = (size: number): number => {
      reserved = { base: reserveBase, size };
      return reserveBase;
    };

    const fm = instantiateForkModule({
      module,
      memory,
      ptrWidth: 4,
      reserve,
      label: "test",
    });

    expect(fm.memoryBase).toBe(reserveBase);
    expect(reserved).not.toBeNull();
    // The reserved region covers the module's ~4 MiB static footprint plus the
    // shadow stack, and fits inside the provided memory.
    expect(reserved!.size).toBeGreaterThan(4 * 1024 * 1024);
    expect(fm.memoryBase + fm.regionBytes).toBeLessThanOrEqual(
      memory.buffer.byteLength,
    );

    for (const name of FORK_MODULE_REQUIRED_EXPORTS) {
      // `__wpk_fork_ref_gc_transit` (M1 task 2) is a module-owned
      // `WebAssembly.Table` export, not a function; every other required
      // export is a function.
      if (name === "__wpk_fork_ref_gc_transit") {
        expect(fm.exports[name]).toBeInstanceOf(WebAssembly.Table);
      } else {
        expect(typeof fm.exports[name]).toBe("function");
      }
    }

    // The instance is live: a trivial exported query runs without trapping.
    expect(() => (fm.exports.fm_last_errno as () => number)()).not.toThrow();

    // Co-residency: instantiating (which ran the module's data-reloc start)
    // did not clobber the guest sentinel below the reserved region.
    expect(new DataView(memory.buffer).getUint32(sentinelAddr, true)).toBe(
      0xdeadbeef,
    );
  });

  it("registers a resume catalog larger than the old 16384 cap and fails loud past the new cap", () => {
    // Phase 3 proof: the resume-catalog cap is raised (RESUME_CATALOG_CAP =
    // 65536) so the co-resident module backs EVERY real fork — php-fpm (19190),
    // php (19026), and node/spidermonkey (16555) all previously EXCEEDED the old
    // 16384 cap and silently fell to the JS continuation twin. A catalog past
    // the raised cap fails loud (`E2BIG`), never silently drops to JS.
    const module = loadForkModule32();
    const memory = sharedMemory(256); // 16 MiB
    const reserveBase = 8 * 1024 * 1024;
    const fm = instantiateForkModule({
      module,
      memory,
      ptrWidth: 4,
      reserve: () => reserveBase,
      label: "test",
    });
    const setFormat = fm.exports.fm_set_format as (
      ptrWidth: number,
      fixedPrefix: number,
    ) => void;
    const setCatalog = fm.exports.fm_set_resume_catalog as (
      ptr: number,
      count: number,
    ) => void;
    const lastErrno = fm.exports.fm_last_errno as () => number;
    setFormat(4, 0);
    // Stage the ordinals well below the host-reserved region at `reserveBase`.
    const catalogAddr = 1 * 1024 * 1024; // 1 MiB
    const seed = (count: number): void => {
      const view = new DataView(memory.buffer);
      for (let i = 0; i < count; i++) {
        view.setUint32(catalogAddr + i * 4, i, true);
      }
      setCatalog(catalogAddr, count);
    };
    const E2BIG = 7;
    const CAP = 65_536;
    // A catalog exceeding the OLD 16384 cap now registers cleanly.
    seed(20_000);
    expect(lastErrno()).toBe(0);
    // Exactly at the raised cap: still accepted.
    seed(CAP);
    expect(lastErrno()).toBe(0);
    // One past the raised cap: a truthful E2BIG (fail-loud module-capacity
    // boundary), not a silent JS fallback.
    seed(CAP + 1);
    expect(lastErrno()).toBe(E2BIG);
  });

  it("exposes the module-owned GC transit table without minting a provider", () => {
    const module = loadForkModule32();
    const memory = sharedMemory(256); // 16 MiB
    const reserveBase = 8 * 1024 * 1024;
    const reserve = (size: number): number => {
      void size;
      return reserveBase;
    };

    const fm = instantiateForkModule({
      module,
      memory,
      ptrWidth: 4,
      reserve,
      label: "test",
    });

    expect(fm.gcTransitTable).toBeInstanceOf(WebAssembly.Table);
  });

  it("ignores a supplied transitTable option as a harmless no-op (deprecated)", () => {
    const module = loadForkModule32();
    const memory = sharedMemory(256); // 16 MiB
    const reserveBase = 8 * 1024 * 1024;
    const reserve = (size: number): number => {
      void size;
      return reserveBase;
    };
    const unusedProvidedTable = new WebAssembly.Table({
      element: "anyfunc",
      initial: 0,
    });

    expect(() =>
      instantiateForkModule({
        module,
        memory,
        ptrWidth: 4,
        reserve,
        label: "test",
        // Deprecated option; must not throw or otherwise change behavior.
        transitTable: unusedProvidedTable,
      }),
    ).not.toThrow();
  });

  it("fails loudly when the module is not a PIC side module", () => {
    // Minimal valid wasm module with no dylink.0 section.
    const trivial = new WebAssembly.Module(
      new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]),
    );
    expect(() =>
      instantiateForkModule({
        module: trivial,
        memory: sharedMemory(4),
        ptrWidth: 4,
        reserve: () => 0,
        label: "test",
      })
    ).toThrow(/side module|dylink/i);
  });

  it("fails loudly when the reserved region exceeds the provided memory", () => {
    const module = loadForkModule32();
    const memory = sharedMemory(80); // ~5.24 MiB, too small for base + region
    expect(() =>
      instantiateForkModule({
        module,
        memory,
        ptrWidth: 4,
        reserve: () => 4 * 1024 * 1024,
        label: "test",
      })
    ).toThrow(/region|memory/i);
  });
});

// Silence unused-import lint if PAGE is not otherwise referenced.
void PAGE;
