// Phase 6 D6.2 / M2 — externref reference reconstruction for a PLAIN, directly
// held externref (no aggregate consumer), proven end to end in a real
// WebAssembly engine (Node/V8).
//
// M2 moved externref decode out of the host: the co-resident module's injected
// `__wpk_fork_ref_decode_externref(recipe) -> externref` export now calls the
// single residual `env.resolve_externref(handle) -> externref` host import
// DIRECTLY (no table, no generation, no PHASE A/B host round-trip) — see the
// design ruling in
// `docs/superpowers/plans/2026-09-03-m2-externref-into-module.md`. A plain
// externref-in-a-local graph (this file's case) has no GC/exnref consumer, so
// `fm_begin_reference_replay`'s bookkeeping pass never calls the host seam
// itself (it is now host-free, see `ReconstructionState`'s doc in
// `crates/fork-codec/src/reference_replay.rs`); resolution only happens when
// something actually DECODES a recipe, i.e. this test must call the module's
// `__wpk_fork_ref_decode_externref` export directly (mirroring what the guest's
// restore path — or the injected DRIVE_OP_EXTERNREF_TRANSIT step for a
// reachable leaf — would do at fork time).
//
// This asserts:
//   (a) PARITY — the value `__wpk_fork_ref_decode_externref(recipe)` returns for
//       a broker handle is `Object.is`-identical to
//       `tokenCache.materialize(handle)` (the same canonical token the JS decode
//       path returns), so module and JS agree on identity.
//   (b) PROOF OF USE — `fm_externrefs_resolved` (the graph-derived bookkeeping
//       count from `fm_begin_reference_replay`) advances by the externref node
//       count, AND the host `resolve_externref` body actually observed one call
//       per decode this test drove.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { resolveBinary } from "../src/binary-resolver";
import { FmStatField } from "../src/fork-module-backend";
import { instantiateForkModule } from "../src/fork-module-instance";
import { createForkModuleHostCapabilities } from "../src/fork-module-host-capabilities";
import { ForkExternrefTokenCache } from "../src/fork-reference-broker";
import { ForkModuleStateArena } from "../src/fork-module-state";
import type { ForkReferenceRecipeEntry } from "../src/fork-reference-recipes";
import {
  appendSegmentedForkReferenceTransaction,
  PagedForkReferenceVector,
  type ForkReferenceVector,
} from "../src/fork-reference-segments";
import { WPK_FORK_REFERENCE_TRANSACTION_OWNER } from "../src/generated/abi";

const PAGE = 65536;
const PTR_WIDTH = 4 as const;
const PID = 4242;
const GENERATION_ID = 7;
// The durable broker handles this fork's externrefs name.
const HANDLES = [11, 22, 33] as const;

/** Build a sealed, externref-only KFMS arena in `memory`; return its root. */
function buildExternrefArena(memory: WebAssembly.Memory): number {
  let next = PAGE;
  const allocate = (size: number): number => {
    const addr = next;
    next += size;
    if (next > memory.buffer.byteLength) {
      memory.grow(Math.ceil((next - memory.buffer.byteLength) / PAGE));
    }
    return addr;
  };
  const arena = new ForkModuleStateArena(
    memory,
    PTR_WIDTH,
    allocate,
    () => {},
    "externref-replay-test",
  );

  // Node 0 is the mandatory canonical null; nodes 1..N are durable externrefs
  // naming broker handles. No aggregate consumer, so nothing is transit-rooted
  // (the plain externref-in-a-local D6.2 case).
  const nodes: ForkReferenceRecipeEntry[] = [
    { id: 0, node: { kind: "null" } },
    ...HANDLES.map((handle, index) => ({
      id: index + 1,
      node: { kind: "externref" as const, handle },
    })),
  ];
  const vectors: ForkReferenceVector[] = [PagedForkReferenceVector.empty];

  const root = arena.begin();
  arena.appendModule({ activationId: 0, templateId: new Uint8Array(32).fill(0xa0) });
  appendSegmentedForkReferenceTransaction(
    arena,
    WPK_FORK_REFERENCE_TRANSACTION_OWNER,
    nodes,
    vectors,
    // Force multi-segment reassembly so the module's decode is exercised.
    { segmentDataBytes: 48 },
  );
  arena.seal();
  return root;
}

interface ForkModuleRefExports {
  fm_set_format: (pw: number, fixedPrefix: number) => void;
  fm_begin_reference_replay: (root: number, pid: number) => void;
  fm_stats: (field: number) => bigint;
  fm_last_errno: () => number;
  __wpk_fork_ref_decode_externref: (recipeId: number) => unknown;
}

describe("fork-module externref reference reconstruction (Phase 6 D6.2 / M2)", () => {
  it("decodes a directly-held externref through the module with identity parity and proof of use", () => {
    const memory = new WebAssembly.Memory({ initial: 256, maximum: 16384, shared: true });

    // The child worker's externref token cache — the SAME cache the still-JS
    // reference path would use, so the value the module's decode returns is
    // byte-for-byte the canonical identity JS returns.
    const tokens = new ForkExternrefTokenCache(GENERATION_ID);
    let resolveCalls = 0;
    const hostCapabilities = createForkModuleHostCapabilities({ tokens });
    // Wrap the single residual import to count invocations independent of the
    // module's own `fm_externrefs_resolved` bookkeeping (which — since M2 — is a
    // host-free, graph-derived count, not a live per-call tally; see
    // `ReconstructionState`'s doc).
    const resolveExternref = (handle: number): unknown => {
      resolveCalls += 1;
      return hostCapabilities.imports.resolve_externref(handle);
    };

    const root = buildExternrefArena(memory);

    const module = new WebAssembly.Module(
      readFileSync(resolveBinary("fork_module32.wasm")),
    );
    const reserveBase = 8 * 1024 * 1024;
    const fm = instantiateForkModule({
      module,
      memory,
      ptrWidth: PTR_WIDTH,
      reserve: () => reserveBase,
      label: "externref-replay-test",
      resolveExternref,
    });
    const x = fm.exports as unknown as ForkModuleRefExports;

    x.fm_set_format(PTR_WIDTH, 0);
    expect(x.fm_last_errno()).toBe(0);

    const before = Number(x.fm_stats(FmStatField.ExternrefsResolved));

    // Seed the reference graph (bookkeeping only — since M2 this does NOT call
    // the host seam; see `fm_begin_reference_replay`'s doc).
    x.fm_begin_reference_replay(root, PID);
    expect(x.fm_last_errno()).toBe(0);

    // (b) PROOF OF USE (graph admission) — the module's bookkeeping counter
    // advanced by the externref node count purely from admitting the graph.
    const after = Number(x.fm_stats(FmStatField.ExternrefsResolved));
    expect(after - before).toBe(HANDLES.length);
    // Admission alone calls the host seam zero times (M2: host-free bookkeeping).
    expect(resolveCalls).toBe(0);

    // (a) PARITY + (b) PROOF OF USE (actual decode) — decoding each recipe
    // through the module's injected `__wpk_fork_ref_decode_externref` export
    // calls `resolve_externref` exactly once per decode and returns the SAME
    // canonical token `tokenCache.materialize(handle)` returns.
    HANDLES.forEach((handle, index) => {
      const recipeId = index + 1;
      const decoded = x.__wpk_fork_ref_decode_externref(recipeId);
      expect(decoded).toBe(tokens.materialize(handle));
    });
    expect(resolveCalls).toBe(HANDLES.length);

    // The decoded tokens are the canonical, worker-generation-tagged identities.
    expect(x.__wpk_fork_ref_decode_externref(1)).not.toBe(
      x.__wpk_fork_ref_decode_externref(2),
    );
  });
});
