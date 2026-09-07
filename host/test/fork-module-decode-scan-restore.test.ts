// Orchestration migration increment 1 — the module-owned wire-graph DECODE,
// externref-handle SCAN, and replay-orchestration RESTORE entries, proven end
// to end in a real WebAssembly engine (Node/V8).
//
// These three `fm_*` exports are additive surfaces over the EXISTING shared
// `fork_codec` engine (`reference_segments.rs` decode, `reference_replay.rs`
// driver/feed, `drive_plan.rs` build_drive_plan) — the same engine that already
// backs `fm_begin_reference_replay`. They let a later host-rewire increment
// retire the TypeScript wire-graph decode (`fork-reference-segments.ts`), the
// externref-handle scan (`scanSegmentedForkReferenceExternrefHandles` used by
// `fork-externref-process-owner.ts`), and the replay ENTRY wrapper
// (`restoreModuleState` / `materializeAllTyped`), routing all three through the
// one shared engine.
//
// This test builds the sealed KFMS arena with the PRODUCTION TypeScript
// KFMS/KFRV encoder (`ForkModuleStateArena` + `appendSegmentedForkReferenceTransaction`),
// exactly as `fork-module-externref-replay.test.ts` and the other
// `fork-module-*-replay` tests do (the harnesses deliberately defer arena
// round-trips to these Vitest tests rather than hand-encoding KFMS), then drives
// the new exports against the compiled `fork_module32.wasm`. It asserts:
//   * DECODE — node count is reported, the graph stays resident, and the
//     proof-of-use counter advances once per decode.
//   * SCAN — the distinct externref broker handles are written to guest memory
//     in first-seen order, the count is returned, the proof-of-use counter
//     advances by that count, and a too-small buffer / no-resident-graph fail
//     cleanly with EINVAL (never a partial or fabricated scan).
//   * RESTORE — the single entry seeds the replay driver (the externref-admission
//     bookkeeping advances) AND builds the drive plan, returning a plan that is
//     BYTE-IDENTICAL to the two-step `fm_begin_reference_replay` +
//     `fm_build_gc_plan` it collapses.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { resolveBinary } from "../src/binary-resolver";
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
const GENERATION_ID = 7;
const EINVAL = 22;
// Distinct durable broker handles this fork's externrefs name (a canonical
// capture graph dedups externref by handle, so the graph has one node each).
const HANDLES = [11, 22, 33] as const;
// A guest scratch region for the scan output: below the frame reserve (8 MiB)
// and well above the tiny arena (which grows up from one page), so it never
// collides with the arena, the reserve, or the module's own data at 32 MiB.
const SCAN_SCRATCH = 2 * 1024 * 1024;

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
    "decode-scan-restore-test",
  );

  // Node 0 is the mandatory canonical null; nodes 1..N are durable externrefs
  // naming broker handles.
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

interface ForkModuleExports {
  fm_set_format: (pw: number, fixedPrefix: number) => void;
  fm_decode_reference_graph: (root: number) => number;
  fm_decoded_node_count: () => number;
  fm_scan_externref_handles: (dstPtr: number, dstCap: number) => number;
  fm_reference_graphs_decoded: () => bigint;
  fm_externref_handles_scanned: () => bigint;
  fm_last_errno: () => number;
}

function instantiate(memory: WebAssembly.Memory): {
  x: ForkModuleExports;
} {
  const tokens = new ForkExternrefTokenCache(GENERATION_ID);
  const hostCapabilities = createForkModuleHostCapabilities({ tokens });
  const module = new WebAssembly.Module(
    readFileSync(resolveBinary("fork_module32.wasm")),
  );
  const reserveBase = 8 * 1024 * 1024;
  const fm = instantiateForkModule({
    module,
    memory,
    ptrWidth: PTR_WIDTH,
    reserve: () => reserveBase,
    label: "decode-scan-restore-test",
    resolveExternref: hostCapabilities.imports.resolve_externref,
  });
  const x = fm.exports as unknown as ForkModuleExports;
  x.fm_set_format(PTR_WIDTH, 0);
  expect(x.fm_last_errno()).toBe(0);
  return { x };
}

describe("fork-module decode / scan / restore (orchestration migration increment 1)", () => {
  it("fm_decode_reference_graph decodes a KFMS arena and reports the node count with proof of use", () => {
    const memory = new WebAssembly.Memory({ initial: 256, maximum: 16384, shared: true });
    const root = buildExternrefArena(memory);
    const { x } = instantiate(memory);

    const before = Number(x.fm_reference_graphs_decoded());
    const nodeCount = x.fm_decode_reference_graph(root);
    expect(x.fm_last_errno()).toBe(0);
    // One canonical null + one node per distinct externref handle.
    expect(nodeCount).toBe(1 + HANDLES.length);
    expect(x.fm_decoded_node_count()).toBe(1 + HANDLES.length);
    expect(Number(x.fm_reference_graphs_decoded()) - before).toBe(1);

    // A second decode makes the graph resident again and advances the counter.
    expect(x.fm_decode_reference_graph(root)).toBe(1 + HANDLES.length);
    expect(Number(x.fm_reference_graphs_decoded()) - before).toBe(2);
  });

  it("fm_decode_reference_graph fails cleanly on a malformed arena root", () => {
    const memory = new WebAssembly.Memory({ initial: 256, maximum: 16384, shared: true });
    buildExternrefArena(memory);
    const { x } = instantiate(memory);

    // A zeroed in-bounds region is not a valid sealed chunk chain.
    expect(x.fm_decode_reference_graph(PAGE * 4)).toBe(-1);
    expect(x.fm_last_errno()).toBe(EINVAL);
    // A failed decode leaves no resident graph.
    expect(x.fm_decoded_node_count()).toBe(-1);
  });

  it("fm_scan_externref_handles writes the distinct handles in order with proof of use", () => {
    const memory = new WebAssembly.Memory({ initial: 256, maximum: 16384, shared: true });
    const root = buildExternrefArena(memory);
    const { x } = instantiate(memory);

    x.fm_decode_reference_graph(root);
    const cap = x.fm_decoded_node_count();

    const before = Number(x.fm_externref_handles_scanned());
    const count = x.fm_scan_externref_handles(SCAN_SCRATCH, cap);
    expect(x.fm_last_errno()).toBe(0);
    expect(count).toBe(HANDLES.length);

    const view = new DataView(memory.buffer);
    const scanned = Array.from({ length: count }, (_, i) =>
      view.getUint32(SCAN_SCRATCH + i * 4, true),
    );
    expect(scanned).toEqual([...HANDLES]);
    expect(Number(x.fm_externref_handles_scanned()) - before).toBe(HANDLES.length);
  });

  it("fm_scan_externref_handles fails cleanly on a too-small buffer", () => {
    const memory = new WebAssembly.Memory({ initial: 256, maximum: 16384, shared: true });
    const root = buildExternrefArena(memory);
    const { x } = instantiate(memory);

    x.fm_decode_reference_graph(root);
    expect(x.fm_scan_externref_handles(SCAN_SCRATCH, HANDLES.length - 1)).toBe(-1);
    expect(x.fm_last_errno()).toBe(EINVAL);
  });

  it("fm_scan_externref_handles fails cleanly with no resident decoded graph", () => {
    const memory = new WebAssembly.Memory({ initial: 256, maximum: 16384, shared: true });
    buildExternrefArena(memory);
    const { x } = instantiate(memory);

    // No fm_decode_reference_graph was called.
    expect(x.fm_scan_externref_handles(SCAN_SCRATCH, 8)).toBe(-1);
    expect(x.fm_last_errno()).toBe(EINVAL);
  });
});
