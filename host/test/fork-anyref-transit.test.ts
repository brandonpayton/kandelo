import { describe, expect, it } from "vitest";
import {
  FORK_ANYREF_TRANSIT_IMPORT,
  ForkAnyrefTransitTable,
  forkAnyrefTransitProviderBytes,
} from "../src/fork-anyref-transit";

describe("ForkAnyrefTransitTable", () => {
  it("uses a closed audited Wasm provider with the exact table type", () => {
    const bytes = forkAnyrefTransitProviderBytes();
    const module = new WebAssembly.Module(bytes as BufferSource);

    expect(WebAssembly.Module.imports(module)).toEqual([]);
    expect(WebAssembly.Module.exports(module)).toEqual([
      {
        name: FORK_ANYREF_TRANSIT_IMPORT,
        kind: "table",
      },
      {
        name: `${FORK_ANYREF_TRANSIT_IMPORT}_clear`,
        kind: "function",
      },
    ]);
  });

  it("clears every grown slot and isolates workers", () => {
    const first = new ForkAnyrefTransitTable();
    const second = new ForkAnyrefTransitTable();

    expect(first.table).not.toBe(second.table);
    expect(first.table.length).toBe(1);
    first.table.grow(3);
    expect(first.table.length).toBe(4);

    first.clear();
    expect(
      Array.from(
        { length: first.table.length },
        (_, index) => first.table.get(index),
      ),
    ).toEqual([null, null, null, null]);
    expect(second.table.length).toBe(1);
  });

  it("does not expose mutable provider bytes", () => {
    const first = forkAnyrefTransitProviderBytes();
    first[0] = 0xff;
    expect(forkAnyrefTransitProviderBytes()[0]).toBe(0x00);
  });

  it("adopts an externally supplied table", () => {
    const bytes = forkAnyrefTransitProviderBytes();
    const module = new WebAssembly.Module(bytes as BufferSource);
    const instance = new WebAssembly.Instance(module);
    const table = instance.exports[FORK_ANYREF_TRANSIT_IMPORT];
    expect(table).toBeInstanceOf(WebAssembly.Table);

    const wrapper = new ForkAnyrefTransitTable(table as WebAssembly.Table);
    expect(wrapper.table).toBe(table);

    const value = {};
    wrapper.set(0, value);
    expect(wrapper.get(0)).toBe(value);

    wrapper.ensureRecipeSlot(5);
    expect(wrapper.table.length).toBeGreaterThanOrEqual(7);

    wrapper.clear();
    expect(
      Array.from(
        { length: wrapper.table.length },
        (_, index) => wrapper.table.get(index),
      ),
    ).toEqual(Array.from({ length: wrapper.table.length }, () => null));
  });

  it("mints its own when not adopted", () => {
    const wrapper = new ForkAnyrefTransitTable();
    expect(wrapper.table.length).toBe(1);
    wrapper.table.grow(2);
    wrapper.clear();
    expect(
      Array.from(
        { length: wrapper.table.length },
        (_, index) => wrapper.table.get(index),
      ),
    ).toEqual([null, null, null]);
  });
});
