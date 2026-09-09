// Generates the committed cross-language fixture used by the Rust `fork-codec`
// reference-recipe decoder tests under
// crates/fork-codec/testdata/reference-recipes-wasm32.bin.
//
// This is the drift guard for the standalone KFRR reference-recipe wire image
// (see host/src/fork-reference-recipes.ts, "The wire image contains only
// integers and graph edges"): the fixture is emitted by the REAL TypeScript
// encoder `encodeForkReferenceRecipes`, then the Rust test
// `include_bytes!`-loads it and asserts the graph decodes field-for-field.
//
// Unlike the instrumenter-owned gc_codec / imported_globals sections, KFRR has
// a genuine TypeScript ENCODER, so — like linked_frames / module_state /
// replay_events — the fixture bytes are produced here in TypeScript and there
// is no Rust generator test. The graph below exercises every node kind (null,
// funcref, externref, exnref, i31, struct, array, static-root) plus a cycle
// (struct 0 <-> array 1), edge aliasing (exnref 3 shared by struct 0 and array
// 1), duplicate roots (id 0 twice), and both the i31 and externref-handle
// domain boundaries. Input node ids are already ascending 0..10, so the
// encoder's canonicalization is the identity and decoded ids equal input ids.
//
// Regenerate with (from repo root):
//   cd host && npx tsx ../crates/fork-codec/testdata/gen-reference-recipes-fixture.mts
// (or via scripts/dev-shell.sh if tsx is not otherwise on PATH). This script
// only reads host/src; it adds and modifies nothing under host/.

import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  decodeForkReferenceRecipes,
  encodeForkReferenceRecipes,
  type ForkReferenceRecipeGraph,
} from "../../../host/src/fork-reference-recipes";

const graph: ForkReferenceRecipeGraph = {
  // Duplicate root 0 exercises aliasing at the root level; every node is
  // reachable (0 reaches 1,3,4 through its fields/edges).
  roots: [0, 2, 5, 6, 7, 8, 9, 10, 0],
  nodes: [
    {
      id: 0,
      node: {
        kind: "struct",
        moduleActivation: 7,
        typeOrdinal: 2,
        layoutId: 12,
        scalars: Uint8Array.of(0x78, 0x56, 0x34, 0x12),
        fields: [1, 4, 3],
      },
    },
    {
      id: 1,
      node: {
        kind: "array",
        moduleActivation: 7,
        typeOrdinal: 3,
        layoutId: 13,
        scalars: Uint8Array.of(0xaa, 0xbb),
        elements: [0, 3],
      },
    },
    { id: 2, node: { kind: "externref", handle: 9 } },
    {
      id: 3,
      node: {
        kind: "exnref",
        moduleActivation: 7,
        tagOrdinal: 5,
        layoutId: 15,
        scalars: Uint8Array.of(0, 1, 2, 3, 4, 5, 6, 7),
        payloads: [0, 4],
      },
    },
    { id: 4, node: { kind: "i31", value: -17 } },
    { id: 5, node: { kind: "funcref", moduleActivation: 7, functionOrdinal: 0 } },
    { id: 6, node: { kind: "null" } },
    {
      id: 7,
      node: { kind: "static-root", moduleActivation: 6, staticRootOrdinal: 0 },
    },
    { id: 8, node: { kind: "i31", value: 0x3fff_ffff } },
    { id: 9, node: { kind: "i31", value: -0x4000_0000 } },
    { id: 10, node: { kind: "externref", handle: 0xffff_ffff } },
  ],
};

const fixture = encodeForkReferenceRecipes(graph);

// Round-trip through the real host decoder as an in-generator sanity check so
// the committed bytes are self-consistent before Rust ever reads them.
const decoded = decodeForkReferenceRecipes(fixture);
if (decoded.nodes.length !== graph.nodes.length) {
  throw new Error(
    `round-trip node count mismatch: ${decoded.nodes.length} != ${graph.nodes.length}`,
  );
}

const here = dirname(fileURLToPath(import.meta.url));
const outPath = join(here, "reference-recipes-wasm32.bin");
writeFileSync(outPath, fixture);

console.log(
  JSON.stringify(
    {
      file: outPath,
      byteLength: fixture.byteLength,
      nodeCount: decoded.nodes.length,
      rootCount: decoded.roots.length,
      roots: decoded.roots,
      kinds: decoded.nodes.map(({ node }) => node.kind),
    },
    null,
    2,
  ),
);
