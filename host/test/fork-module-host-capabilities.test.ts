// M2 t4 — the shrunk externref host seam is a SINGLE reference-returning
// import: `resolve_externref(handle) -> externref`. This is a narrow unit
// test of `createForkModuleHostCapabilities` in isolation (no wasm instance);
// the real-module instantiation path is covered by
// `fork-module-instance.test.ts` and the full reference-replay wiring is
// covered by the M2 t6 harness rewire.

import { describe, expect, it } from "vitest";

import { createForkModuleHostCapabilities } from "../src/fork-module-host-capabilities";
import { ForkExternrefTokenCache } from "../src/fork-reference-broker";

describe("createForkModuleHostCapabilities (M2)", () => {
  it("returns exactly one import: resolve_externref", () => {
    const tokens = new ForkExternrefTokenCache(1);
    const caps = createForkModuleHostCapabilities({ tokens });

    expect(Object.keys(caps.imports)).toEqual(["resolve_externref"]);
    expect(typeof caps.imports.resolve_externref).toBe("function");
  });

  it("resolve_externref returns the SAME canonical token materialize() returns for that handle", () => {
    const tokens = new ForkExternrefTokenCache(7);
    const caps = createForkModuleHostCapabilities({ tokens });

    const expected = tokens.materialize(42);
    const resolved = caps.imports.resolve_externref(42);

    expect(resolved).toBe(expected); // identity, not just equality
  });

  it("is idempotent: repeated resolves of the same handle return the identical object", () => {
    const tokens = new ForkExternrefTokenCache(3);
    const caps = createForkModuleHostCapabilities({ tokens });

    const first = caps.imports.resolve_externref(11);
    const second = caps.imports.resolve_externref(11);

    expect(second).toBe(first);
  });

  it("distinct handles resolve to distinct tokens", () => {
    const tokens = new ForkExternrefTokenCache(3);
    const caps = createForkModuleHostCapabilities({ tokens });

    expect(caps.imports.resolve_externref(1)).not.toBe(
      caps.imports.resolve_externref(2),
    );
  });

  it("advances resolvedCount once per resolve (proof-of-use)", () => {
    const tokens = new ForkExternrefTokenCache(1);
    const caps = createForkModuleHostCapabilities({ tokens });

    expect(caps.resolvedCount).toBe(0);
    caps.imports.resolve_externref(5);
    caps.imports.resolve_externref(6);
    expect(caps.resolvedCount).toBe(2);
  });

  it("propagates a truthful RangeError for an invalid handle instead of a soft failure sentinel", () => {
    const tokens = new ForkExternrefTokenCache(1);
    const caps = createForkModuleHostCapabilities({ tokens });

    expect(() => caps.imports.resolve_externref(0)).toThrow(RangeError);
  });
});
