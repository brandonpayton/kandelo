// Orchestration migration increment C — the module-owned decoded-graph
// STRUCTURE readout, proven end to end in a real WebAssembly engine (Node/V8).
//
// `fm_decoded_node_kind` / `fm_decoded_node_module_activation` /
// `fm_decoded_node_ordinal` are additive scalar accessors over the SAME resident
// decoded graph `fm_decode_reference_graph` produces (the shared
// `fork_codec::reference_segments` decode). They expose exactly the decoded
// structure the host's fork wiring (`worker-main.ts`) still consumes from its
// `decodedChildReferences` decode:
//   * the HOST-owned exnref tag-validity admission gate
//     (`assertForkModuleExnrefTagsDeclared`) reads each exnref node's
//     `moduleActivation` + `tagOrdinal`;
//   * the merged static-root catalog mirror seeding reads each static-root
//     node's `moduleActivation` + `staticRootOrdinal` (and the per-activation
//     max ordinal it derives).
// A later capture-session + severance increment can then retire the JS
// `decodeSegmentedForkReferenceTransaction` structural decode on the module path.
//
// This test builds ONE sealed KFMS arena with the PRODUCTION TypeScript encoder
// (`ForkModuleStateArena` + `appendSegmentedForkReferenceTransaction`), decodes
// the SAME wire bytes two ways — the JS `decodeSegmentedForkReferenceTransaction`
// and the module's `fm_decode_reference_graph` + the new accessors — and asserts
// STRUCTURAL PARITY node-for-node (kind discriminant, module activation, kind-
// specific ordinal). Because both decodes read identical bytes, matching output
// proves the module exposes the same structure the JS decode does. It also
// asserts the truthful `EINVAL` boundaries (kinds without an activation/ordinal,
// out-of-range index, no resident graph).

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
  decodeSegmentedForkReferenceTransaction,
  PagedForkReferenceVector,
  type ForkReferenceVector,
} from "../src/fork-reference-segments";
import { WPK_FORK_REFERENCE_TRANSACTION_OWNER } from "../src/generated/abi";

const PAGE = 65536;
const PTR_WIDTH = 4 as const;
const EINVAL = 22;
const GENERATION_ID = 7;
const EXTERNREF_HANDLE = 0xabcd;

// The wire node-kind discriminants, mirroring the TS `WireNodeKind` const enum
// (`fork-reference-recipes.ts`) and the Rust `wire_node_kind` mapping.
const WIRE_KIND: Record<string, number> = {
  null: 0,
  funcref: 1,
  externref: 2,
  exnref: 3,
  i31: 4,
  struct: 5,
  array: 6,
  "static-root": 7,
};

// A graph exercising every accessor arm: the two PRIMARY host consumers (exnref
// with `moduleActivation`+`tagOrdinal`, static-root with
// `moduleActivation`+`staticRootOrdinal`), plus funcref/struct/array (the other
// kinds that carry an activation + ordinal) and the activation/ordinal-free
// kinds (null/externref/i31). Aggregate nodes (exnref/struct/array) name a
// reference edge to the externref (id 1); the encoder appends their shared
// edge/scalar ranges canonically in id order.
const NODES: ForkReferenceRecipeEntry[] = [
  { id: 0, node: { kind: "null" } },
  { id: 1, node: { kind: "externref", handle: EXTERNREF_HANDLE } },
  { id: 2, node: { kind: "funcref", moduleActivation: 3, functionOrdinal: 7 } },
  { id: 3, node: { kind: "i31", value: 42 } },
  {
    id: 4,
    node: {
      kind: "exnref",
      moduleActivation: 5,
      tagOrdinal: 9,
      layoutId: 0,
      scalars: new Uint8Array(0),
      payloads: [1],
    },
  },
  {
    id: 5,
    node: {
      kind: "struct",
      moduleActivation: 2,
      typeOrdinal: 13,
      layoutId: 0,
      scalars: new Uint8Array(0),
      fields: [1],
    },
  },
  {
    id: 6,
    node: {
      kind: "array",
      moduleActivation: 4,
      typeOrdinal: 17,
      layoutId: 0,
      scalars: new Uint8Array(0),
      elements: [1],
    },
  },
  {
    id: 7,
    node: { kind: "static-root", moduleActivation: 6, staticRootOrdinal: 11 },
  },
];

/** Build a sealed KFMS arena covering every node kind; return its root. */
function buildArena(memory: WebAssembly.Memory): number {
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
    "decoded-structure-test",
  );
  const vectors: ForkReferenceVector[] = [PagedForkReferenceVector.empty];
  const root = arena.begin();
  arena.appendModule({
    activationId: 0,
    templateId: new Uint8Array(32).fill(0xd0),
  });
  appendSegmentedForkReferenceTransaction(
    arena,
    WPK_FORK_REFERENCE_TRANSACTION_OWNER,
    NODES,
    vectors,
    // Force multi-segment reassembly so the module's decode is exercised.
    { segmentDataBytes: 48 },
  );
  arena.seal();
  return root;
}

interface StructureExports {
  fm_set_format: (pw: number, fixedPrefix: number) => void;
  fm_decode_reference_graph: (root: number) => number;
  fm_decoded_node_count: () => number;
  fm_decoded_node_kind: (index: number) => number;
  fm_decoded_node_module_activation: (index: number) => number;
  fm_decoded_node_ordinal: (index: number) => number;
  fm_last_errno: () => number;
}

function instantiate(memory: WebAssembly.Memory): { x: StructureExports } {
  const tokens = new ForkExternrefTokenCache(GENERATION_ID);
  const hostCapabilities = createForkModuleHostCapabilities({ tokens });
  const module = new WebAssembly.Module(
    readFileSync(resolveBinary("fork_module32.wasm")),
  );
  const fm = instantiateForkModule({
    module,
    memory,
    ptrWidth: PTR_WIDTH,
    reserve: () => 8 * 1024 * 1024,
    label: "decoded-structure-test",
    resolveExternref: hostCapabilities.imports.resolve_externref,
  });
  const x = fm.exports as unknown as StructureExports;
  x.fm_set_format(PTR_WIDTH, 0);
  expect(x.fm_last_errno()).toBe(0);
  return { x };
}

/** The (moduleActivation, ordinal) the accessors must report for a JS node, or
 *  `null` when the kind carries neither (null/externref/i31). */
function expectedFields(
  node: ForkReferenceRecipeEntry["node"],
): { moduleActivation: number; ordinal: number } | null {
  switch (node.kind) {
    case "funcref":
      return { moduleActivation: node.moduleActivation, ordinal: node.functionOrdinal };
    case "exnref":
      return { moduleActivation: node.moduleActivation, ordinal: node.tagOrdinal };
    case "struct":
    case "array":
      return { moduleActivation: node.moduleActivation, ordinal: node.typeOrdinal };
    case "static-root":
      return {
        moduleActivation: node.moduleActivation,
        ordinal: node.staticRootOrdinal,
      };
    default:
      return null;
  }
}

describe("fork-module decoded-graph structure readout (orchestration migration increment C)", () => {
  it("reports node kind / module activation / ordinal with structural parity to the JS decode", () => {
    const memory = new WebAssembly.Memory({
      initial: 256,
      maximum: 16384,
      shared: true,
    });
    const root = buildArena(memory);
    const { x } = instantiate(memory);

    // JS decode of the SAME wire bytes: the structure the host consumes today.
    const jsDecoded = decodeSegmentedForkReferenceTransaction(
      arenaRecords(memory, root),
      WPK_FORK_REFERENCE_TRANSACTION_OWNER,
    );
    const jsNodes = [...jsDecoded.graph.nodes];
    expect(jsNodes.length).toBe(NODES.length);

    // Module decode of the SAME wire bytes.
    const moduleCount = x.fm_decode_reference_graph(root);
    expect(x.fm_last_errno()).toBe(0);
    expect(moduleCount).toBe(NODES.length);
    expect(x.fm_decoded_node_count()).toBe(NODES.length);

    // Node-for-node structural parity.
    for (const entry of jsNodes) {
      const index = entry.id;
      const expectedKind = WIRE_KIND[entry.node.kind];
      expect(x.fm_decoded_node_kind(index)).toBe(expectedKind);
      expect(x.fm_last_errno()).toBe(0);

      const fields = expectedFields(entry.node);
      if (fields === null) {
        // A kind without an activation/ordinal is a truthful EINVAL.
        expect(x.fm_decoded_node_module_activation(index)).toBe(-1);
        expect(x.fm_last_errno()).toBe(EINVAL);
        expect(x.fm_decoded_node_ordinal(index)).toBe(-1);
        expect(x.fm_last_errno()).toBe(EINVAL);
      } else {
        expect(x.fm_decoded_node_module_activation(index)).toBe(
          fields.moduleActivation,
        );
        expect(x.fm_last_errno()).toBe(0);
        expect(x.fm_decoded_node_ordinal(index)).toBe(fields.ordinal);
        expect(x.fm_last_errno()).toBe(0);
      }
    }
  });

  it("proves the two primary host consumers can source their structure from the module", () => {
    const memory = new WebAssembly.Memory({
      initial: 256,
      maximum: 16384,
      shared: true,
    });
    const root = buildArena(memory);
    const { x } = instantiate(memory);
    expect(x.fm_decode_reference_graph(root)).toBe(NODES.length);

    // The exnref admission gate collects {moduleActivation, tagOrdinal}.
    const exnrefFromModule: { moduleActivation: number; tagOrdinal: number }[] =
      [];
    // The static-root mirror seeding collects {moduleActivation, staticRootOrdinal}.
    const staticRootFromModule: {
      moduleActivation: number;
      staticRootOrdinal: number;
    }[] = [];
    for (let i = 0; i < x.fm_decoded_node_count(); i++) {
      const kind = x.fm_decoded_node_kind(i);
      if (kind === WIRE_KIND.exnref) {
        exnrefFromModule.push({
          moduleActivation: x.fm_decoded_node_module_activation(i),
          tagOrdinal: x.fm_decoded_node_ordinal(i),
        });
      } else if (kind === WIRE_KIND["static-root"]) {
        staticRootFromModule.push({
          moduleActivation: x.fm_decoded_node_module_activation(i),
          staticRootOrdinal: x.fm_decoded_node_ordinal(i),
        });
      }
    }

    expect(exnrefFromModule).toEqual([{ moduleActivation: 5, tagOrdinal: 9 }]);
    expect(staticRootFromModule).toEqual([
      { moduleActivation: 6, staticRootOrdinal: 11 },
    ]);
  });

  it("fails cleanly on an out-of-range index and with no resident graph", () => {
    const memory = new WebAssembly.Memory({
      initial: 256,
      maximum: 16384,
      shared: true,
    });
    const root = buildArena(memory);
    const { x } = instantiate(memory);

    // No resident graph yet.
    expect(x.fm_decoded_node_kind(0)).toBe(-1);
    expect(x.fm_last_errno()).toBe(EINVAL);
    expect(x.fm_decoded_node_module_activation(0)).toBe(-1);
    expect(x.fm_last_errno()).toBe(EINVAL);
    expect(x.fm_decoded_node_ordinal(0)).toBe(-1);
    expect(x.fm_last_errno()).toBe(EINVAL);

    // After decode, an out-of-range index is a truthful EINVAL.
    expect(x.fm_decode_reference_graph(root)).toBe(NODES.length);
    expect(x.fm_decoded_node_kind(NODES.length)).toBe(-1);
    expect(x.fm_last_errno()).toBe(EINVAL);
    expect(x.fm_decoded_node_module_activation(NODES.length)).toBe(-1);
    expect(x.fm_last_errno()).toBe(EINVAL);
    expect(x.fm_decoded_node_ordinal(NODES.length)).toBe(-1);
    expect(x.fm_last_errno()).toBe(EINVAL);
  });
});

/** The sealed arena's record views, read back for the JS decode. Attaches
 *  BORROWED so the read-back never deallocates the arena we still drive the
 *  module against. */
function arenaRecords(memory: WebAssembly.Memory, root: number) {
  const view = new ForkModuleStateArena(
    memory,
    PTR_WIDTH,
    () => {
      throw new Error("read-only");
    },
    () => {},
    "decoded-structure-readback",
  );
  view.attachBorrowed(root);
  return view.recordViews();
}
