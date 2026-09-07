// P2 fix-round (MEDIUM) — host-owned exnref tag-validity boundary.
//
// The co-resident fork-module has NO exception-codec seeding, and
// `crates/fork-codec/src/reference_replay.rs:210-212` assigns the
// exception-descriptor validity check to the HOST ("a check it alone can see").
// P2 removed the old host `exceptionDescriptorAdmitsExnref` gate (which routed a
// wrong-tag exnref onto the JS engine); with the module now the sole
// reconstructor, a corrupt / mismatched exnref recipe would be `call_indirect`-
// driven blindly through the guest materialize export. This test proves the
// restored host boundary fails LOUD (EINVAL) on a wrong-tag exnref rather than
// silently mis-reconstructing an exception value — parity in concept with the
// gated-externref boundary (`smoke_fork_gated_externref_parent_survives`), where
// an unsupported reference makes the fork fail loud instead of succeeding wrong.

import { describe, expect, it } from "vitest";
import {
  assertForkModuleExnrefTagsDeclared,
  forkModuleExnrefTagDeclared,
  ForkModuleExnrefTagError,
  type ForkExnrefTagRegistry,
} from "../src/fork-module-exnref-admission";

// Two activations: activation 0 declares tags {0,1}; activation 3 declares {0}.
const registry: ForkExnrefTagRegistry = new Map<number, ReadonlySet<number>>([
  [0, new Set([0, 1])],
  [3, new Set([0])],
]);

describe("fork-module exnref tag-validity boundary", () => {
  it("admits an exnref whose owning activation declares the named tag", () => {
    expect(
      forkModuleExnrefTagDeclared(registry, { moduleActivation: 0, tagOrdinal: 1 }),
    ).toBe(true);
    expect(
      forkModuleExnrefTagDeclared(registry, { moduleActivation: 3, tagOrdinal: 0 }),
    ).toBe(true);
    // A well-formed multi-node graph (every exnref names a declared tag) passes
    // without throwing — the normal-operation path.
    expect(() =>
      assertForkModuleExnrefTagsDeclared(
        registry,
        [
          { moduleActivation: 0, tagOrdinal: 0 },
          { moduleActivation: 0, tagOrdinal: 1 },
          { moduleActivation: 3, tagOrdinal: 0 },
        ],
        "test: well-formed",
      ),
    ).not.toThrow();
  });

  it("rejects a wrong-tag exnref (tag the activation never declared) with a fail-loud EINVAL", () => {
    // Activation 0 declares {0,1}; tag 7 is not declared — corrupt/mismatched recipe.
    expect(
      forkModuleExnrefTagDeclared(registry, { moduleActivation: 0, tagOrdinal: 7 }),
    ).toBe(false);
    let thrown: unknown;
    try {
      assertForkModuleExnrefTagsDeclared(
        registry,
        [
          { moduleActivation: 0, tagOrdinal: 0 }, // fine
          { moduleActivation: 0, tagOrdinal: 7 }, // corrupt — must fail loud
        ],
        "test: wrong-tag",
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ForkModuleExnrefTagError);
    const error = thrown as ForkModuleExnrefTagError;
    // EINVAL (22), NOT EOPNOTSUPP (95): the exnref KIND is supported; THIS recipe
    // is invalid.
    expect(error.errno).toBe(22);
    expect(error.moduleActivation).toBe(0);
    expect(error.tagOrdinal).toBe(7);
    expect(error.message).toContain("0:7");
    expect(error.message).toContain("EINVAL");
  });

  it("rejects an exnref whose owning activation has no exception codec at all", () => {
    // Activation 9 is absent from the registry (no exception codec section) — a
    // recipe naming it is corrupt and must fail loud, not silently admit.
    expect(
      forkModuleExnrefTagDeclared(registry, { moduleActivation: 9, tagOrdinal: 0 }),
    ).toBe(false);
    expect(() =>
      assertForkModuleExnrefTagsDeclared(
        registry,
        [{ moduleActivation: 9, tagOrdinal: 0 }],
        "test: missing-activation",
      ),
    ).toThrow(ForkModuleExnrefTagError);
  });
});
