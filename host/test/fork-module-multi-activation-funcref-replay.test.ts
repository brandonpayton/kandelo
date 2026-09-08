// Phase 6 D7a.1b — MULTI-ACTIVATION funcref reference reconstruction through the
// co-resident fork module, proven end to end in a real WebAssembly engine.
//
// The single-activation analogue is `fork-module-funcref-replay.test.ts` (D6.1),
// which resolves every funcref against ONE imported catalog table. D7a.1b removes
// that restriction with a MERGED, activation-namespaced catalog: the host lays
// each activation's function catalog at a distinct BASE inside one imported
// table and seeds the module the per-activation base via
// `fm_set_activation_catalog_base`. `fm_funcref_ordinal` then returns the GLOBAL
// slot `base(module_activation) + function_ordinal`, and the injected
// `__wpk_fork_ref_decode_funcref` shim `table.get`s that slot.
//
// THE LOAD-BEARING CASE: a funcref minted in activation A and a funcref minted in
// activation B live in the SAME reference graph. Each must resolve against its
// OWN activation's catalog — never the other's — even though both activations'
// functions share the one merged table. A wrong base would silently return the
// other activation's function; this test calls each reconstructed funcref and
// asserts the value proves the correct catalog. It also asserts per-kind
// proof-of-use (`fm_references_reconstructed` advanced), so a silent JS fallback
// cannot pass.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { resolveBinary } from "../src/binary-resolver";
import { FmStatField } from "../src/fork-module-backend";
import { instantiateForkModule } from "../src/fork-module-instance";
import { ForkFunctionCatalog } from "../src/fork-function-catalog";
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
// The main module (activation 0) and its dlopen'd side module (activation 1),
// each with its OWN function catalog — the exact shape a real dlopen fork's
// reference graph takes (see fork-dlopen-replay-e2e).
const ACTIVATION_A = 0;
const ACTIVATION_B = 1;

/**
 * Instantiate a guest-like `__wpk_fork_function_catalog` funcref table whose
 * functions each return `base + index`, so a reconstructed funcref's call result
 * uniquely identifies WHICH activation's catalog served it.
 */
function catalogTable(base: number, count: number): WebAssembly.Table {
  const dir = mkdtempSync(join(tmpdir(), "kandelo-multi-funcref-"));
  const wat = join(dir, "catalog.wat");
  const wasm = join(dir, "catalog.wasm");
  const funcs = Array.from(
    { length: count },
    (_, i) => `(func $f${i} (result i32) i32.const ${base + i})`,
  ).join("\n      ");
  const elems = Array.from({ length: count }, (_, i) => `$f${i}`).join(" ");
  writeFileSync(
    wat,
    `(module
      (table $catalog (export "__wpk_fork_function_catalog") ${count} ${count} funcref)
      ${funcs}
      (elem (table $catalog) (i32.const 0) func ${elems}))`,
  );
  execFileSync("wat2wasm", [wat, "-o", wasm]);
  const module = new WebAssembly.Module(readFileSync(wasm));
  return new WebAssembly.Instance(module).exports
    .__wpk_fork_function_catalog as WebAssembly.Table;
}

/** Build a sealed KFMS arena whose funcrefs span BOTH activations. */
function buildCrossActivationArena(
  memory: WebAssembly.Memory,
  nodes: ForkReferenceRecipeEntry[],
): number {
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
    "multi-funcref-replay-test",
  );
  const vectors: ForkReferenceVector[] = [PagedForkReferenceVector.empty];
  const root = arena.begin();
  // A real dlopen fork appends ONE module record per activation before the
  // process-wide reference transaction; replicate both records so the module's
  // whole-arena decode is exercised exactly as production.
  arena.appendModule({ activationId: 0, templateId: new Uint8Array(32).fill(0xa0) });
  arena.appendModule({ activationId: 1, templateId: new Uint8Array(32).fill(0xb1) });
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

describe("fork-module multi-activation funcref reconstruction (Phase 6 D7a.1b)", () => {
  it("resolves each funcref against its OWN activation's catalog via the merged base map", () => {
    const memory = new WebAssembly.Memory({ initial: 256, maximum: 16384, shared: true });

    // Match a real dlopen fork's catalog sizes: activation 0's main-module
    // catalog is large (80 funcref slots), the side module's is small (6). Return
    // values are base+index so a wrong catalog/slot is loud.
    const catalogA = catalogTable(1000, 80);
    const catalogB = catalogTable(2000, 6);

    // The MERGED, activation-namespaced catalog: A at base 0 (slots 0..1), B at
    // base 2 (slots 2..4). This is what the module's `__wpk_fork_ref_decode_funcref`
    // reads; the host lays it out and seeds the per-activation bases below.
    const BASE_A = 0;
    const BASE_B = catalogA.length; // 2
    const merged = new WebAssembly.Table({
      element: "anyfunc",
      initial: catalogA.length + catalogB.length,
    });
    for (let i = 0; i < catalogA.length; i += 1) merged.set(BASE_A + i, catalogA.get(i));
    for (let i = 0; i < catalogB.length; i += 1) merged.set(BASE_B + i, catalogB.get(i));

    // JS oracle: `ForkFunctionCatalog.decode` returns exactly what the module's
    // `table.get` must return for each (activation, ordinal).
    const oracle = new ForkFunctionCatalog();
    oracle.register(ACTIVATION_A, catalogA);
    oracle.register(ACTIVATION_B, catalogB);

    // The EXACT graph a real fork-from-main dlopen fork produced (observed in
    // fork-dlopen-replay-e2e): seven activation-0 funcrefs with large ordinals
    // plus two activation-1 funcrefs, interleaved, after the canonical null.
    const nodes: ForkReferenceRecipeEntry[] = [
      { id: 0, node: { kind: "null" } },
      { id: 1, node: { kind: "funcref", moduleActivation: ACTIVATION_A, functionOrdinal: 23 } },
      { id: 2, node: { kind: "funcref", moduleActivation: ACTIVATION_A, functionOrdinal: 20 } },
      { id: 3, node: { kind: "funcref", moduleActivation: ACTIVATION_A, functionOrdinal: 40 } },
      { id: 4, node: { kind: "funcref", moduleActivation: ACTIVATION_A, functionOrdinal: 58 } },
      { id: 5, node: { kind: "funcref", moduleActivation: ACTIVATION_A, functionOrdinal: 59 } },
      { id: 6, node: { kind: "funcref", moduleActivation: ACTIVATION_A, functionOrdinal: 60 } },
      { id: 7, node: { kind: "funcref", moduleActivation: ACTIVATION_A, functionOrdinal: 61 } },
      { id: 8, node: { kind: "funcref", moduleActivation: ACTIVATION_B, functionOrdinal: 2 } },
      { id: 9, node: { kind: "funcref", moduleActivation: ACTIVATION_B, functionOrdinal: 3 } },
    ];
    const root = buildCrossActivationArena(memory, nodes);

    const module = new WebAssembly.Module(
      readFileSync(resolveBinary("fork_module32.wasm")),
    );
    const reserveBase = 8 * 1024 * 1024;
    const fm = instantiateForkModule({
      module,
      memory,
      ptrWidth: PTR_WIDTH,
      reserve: () => reserveBase,
      label: "multi-funcref-replay-test",
      functionCatalog: merged,
    });
    const x = fm.exports as unknown as {
      fm_set_format: (pw: number, fixedPrefix: number) => void;
      fm_set_activation_catalog_base: (activationId: number, base: number) => void;
      fm_begin_reference_replay: (root: number) => void;
      fm_stats: (field: number) => bigint;
      fm_last_errno: () => number;
      __wpk_fork_ref_decode_funcref: (recipeId: number) => unknown;
    };

    x.fm_set_format(PTR_WIDTH, 0);
    expect(x.fm_last_errno()).toBe(0);

    // Seed each activation's catalog base (the merged-catalog mechanism).
    x.fm_set_activation_catalog_base(ACTIVATION_A, BASE_A);
    expect(x.fm_last_errno()).toBe(0);
    x.fm_set_activation_catalog_base(ACTIVATION_B, BASE_B);
    expect(x.fm_last_errno()).toBe(0);

    const before = x.fm_stats(FmStatField.ReferencesReconstructed);

    x.fm_begin_reference_replay(root);
    expect(x.fm_last_errno()).toBe(0);

    const cases = [
      { recipe: 1, activation: ACTIVATION_A, ordinal: 23, value: 1023 },
      { recipe: 2, activation: ACTIVATION_A, ordinal: 20, value: 1020 },
      { recipe: 3, activation: ACTIVATION_A, ordinal: 40, value: 1040 },
      { recipe: 4, activation: ACTIVATION_A, ordinal: 58, value: 1058 },
      { recipe: 5, activation: ACTIVATION_A, ordinal: 59, value: 1059 },
      { recipe: 6, activation: ACTIVATION_A, ordinal: 60, value: 1060 },
      { recipe: 7, activation: ACTIVATION_A, ordinal: 61, value: 1061 },
      { recipe: 8, activation: ACTIVATION_B, ordinal: 2, value: 2002 },
      { recipe: 9, activation: ACTIVATION_B, ordinal: 3, value: 2003 },
    ];
    for (const { recipe, activation, ordinal, value } of cases) {
      const reconstructed = x.__wpk_fork_ref_decode_funcref(recipe);
      // Identity parity with the JS oracle for the SAME (activation, ordinal).
      const expected = oracle.decode({ moduleActivation: activation, ordinal });
      expect(reconstructed).toBe(expected);
      // The reconstructed funcref is the correct activation's callable function.
      expect((reconstructed as () => number)()).toBe(value);
    }

    // The canonical null recipe reconstructs null.
    expect(x.__wpk_fork_ref_decode_funcref(0)).toBe(null);

    // Proof of use: exactly the 6 references decoded (5 funcref + 1 null) drove
    // the module, not a silent JS fallback.
    const after = x.fm_stats(FmStatField.ReferencesReconstructed);
    expect(Number(after - before)).toBe(cases.length + 1);
    expect(Number(after)).toBeGreaterThan(0);
  });
});
