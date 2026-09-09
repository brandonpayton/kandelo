// Phase 6 D6.1 — funcref reference reconstruction THROUGH the co-resident
// fork module, proven end to end in a real WebAssembly engine (Node/V8).
//
// This is the reference analogue of `crates/fork-module/tests/harness.mjs` (the
// D5 frame/continuation proof): it drives the injected fork-module's
// `fm_begin_reference_replay` + `__wpk_fork_ref_decode_funcref` +
// `fm_references_reconstructed` against a REAL, funcref-only KFMS reference
// transaction built by the production host encoder (`ForkModuleStateArena` +
// `appendSegmentedForkReferenceTransaction`), and asserts:
//
//   (a) PARITY — every funcref the module reconstructs (via `table.get` on the
//       imported `__wpk_fork_function_catalog`) is the SAME funcref identity the
//       JS `ForkFunctionCatalog.decode` returns for the same (activation,
//       ordinal); the null recipe reconstructs `null`.
//   (b) PROOF OF USE — `fm_references_reconstructed` advances by exactly the
//       number of references decoded, so the module (not a silent JS fallback)
//       drove the reconstruction.
//
// The Rust `fm_funcref_ordinal` helper and the walrus-injected funcref shim are
// what make (a) possible: a Rust cdylib cannot itself return a `funcref`, so the
// injector adds the one `(i32) -> funcref` function that reads the imported
// catalog table. Flag-off byte-identity is a worker-level property (the module
// is never instantiated when the flag is off) and is covered by the fork
// regression suites, not this module-mechanism test.

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
// The single activation every funcref in this fork belongs to. D6.1 resolves it
// against one imported catalog table.
const ACTIVATION = 7;

/**
 * A guest-like function catalog module: a `__wpk_fork_function_catalog` funcref
 * table with four distinct functions. Instantiating it yields the real funcref
 * identities the reconstruction must reproduce.
 */
function catalogTable(): WebAssembly.Table {
  const dir = mkdtempSync(join(tmpdir(), "kandelo-funcref-replay-"));
  const wat = join(dir, "catalog.wat");
  const wasm = join(dir, "catalog.wasm");
  writeFileSync(
    wat,
    `(module
      (table $catalog (export "__wpk_fork_function_catalog") 4 4 funcref)
      (func $f0 (result i32) i32.const 100)
      (func $f1 (result i32) i32.const 101)
      (func $f2 (result i32) i32.const 102)
      (func $f3 (result i32) i32.const 103)
      (elem (table $catalog) (i32.const 0) func $f0 $f1 $f2 $f3))`,
  );
  execFileSync("wat2wasm", [wat, "-o", wasm]);
  const module = new WebAssembly.Module(readFileSync(wasm));
  return new WebAssembly.Instance(module).exports
    .__wpk_fork_function_catalog as WebAssembly.Table;
}

/** Build a sealed, funcref-only KFMS arena in `memory`; return its root. */
function buildFuncrefArena(memory: WebAssembly.Memory): number {
  // The arena bump-allocates chunks in the LOW region; the fork-module places
  // its own data/stack HIGH (see the reserve base below), so they never collide.
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
    "funcref-replay-test",
  );

  // Node 0 is the mandatory canonical null; nodes 1..4 are funcrefs naming the
  // four catalog ordinals of one activation.
  const nodes: ForkReferenceRecipeEntry[] = [
    { id: 0, node: { kind: "null" } },
    { id: 1, node: { kind: "funcref", moduleActivation: ACTIVATION, functionOrdinal: 0 } },
    { id: 2, node: { kind: "funcref", moduleActivation: ACTIVATION, functionOrdinal: 1 } },
    { id: 3, node: { kind: "funcref", moduleActivation: ACTIVATION, functionOrdinal: 2 } },
    { id: 4, node: { kind: "funcref", moduleActivation: ACTIVATION, functionOrdinal: 3 } },
  ];
  const vectors: ForkReferenceVector[] = [PagedForkReferenceVector.empty];

  const root = arena.begin();
  arena.appendModule({ activationId: 0, templateId: new Uint8Array(32).fill(0xa0) });
  appendSegmentedForkReferenceTransaction(
    arena,
    WPK_FORK_REFERENCE_TRANSACTION_OWNER,
    nodes,
    vectors,
    // Force multi-segment reassembly so the module's decode is exercised, not
    // a trivial single-segment fast path.
    { segmentDataBytes: 48 },
  );
  arena.seal();
  return root;
}

describe("fork-module funcref reference reconstruction (Phase 6 D6.1)", () => {
  it("reconstructs funcref + null through the module with identity parity and proof of use", () => {
    const memory = new WebAssembly.Memory({ initial: 256, maximum: 16384, shared: true });

    // The guest's real funcref catalog table (identities the module must match).
    const catalog = catalogTable();
    // The JS reference oracle: `ForkFunctionCatalog.decode` returns exactly what
    // the module's `table.get` must return for each (activation, ordinal).
    const oracle = new ForkFunctionCatalog();
    oracle.register(ACTIVATION, catalog);

    const root = buildFuncrefArena(memory);

    // Instantiate the injected fork-module HIGH in the same memory, importing
    // the guest's catalog table so its `__wpk_fork_ref_decode_funcref` reads it.
    const module = new WebAssembly.Module(
      readFileSync(resolveBinary("fork_module32.wasm")),
    );
    const reserveBase = 8 * 1024 * 1024;
    const fm = instantiateForkModule({
      module,
      memory,
      ptrWidth: PTR_WIDTH,
      reserve: () => reserveBase,
      label: "funcref-replay-test",
      functionCatalog: catalog,
    });
    const x = fm.exports as unknown as {
      fm_set_format: (pw: number, fixedPrefix: number) => void;
      fm_begin_reference_replay: (root: number) => void;
      fm_stats: (field: number) => bigint;
      fm_last_errno: () => number;
      __wpk_fork_ref_decode_funcref: (recipeId: number) => unknown;
    };

    x.fm_set_format(PTR_WIDTH, 0);
    expect(x.fm_last_errno()).toBe(0);

    const before = x.fm_stats(FmStatField.ReferencesReconstructed);

    x.fm_begin_reference_replay(root);
    expect(x.fm_last_errno()).toBe(0);

    // Each funcref recipe reconstructs the SAME funcref identity the JS oracle
    // returns; the module's table.get result is that exact function.
    const funcrefRecipes = [
      { recipe: 1, ordinal: 0 },
      { recipe: 2, ordinal: 1 },
      { recipe: 3, ordinal: 2 },
      { recipe: 4, ordinal: 3 },
    ];
    for (const { recipe, ordinal } of funcrefRecipes) {
      const reconstructed = x.__wpk_fork_ref_decode_funcref(recipe);
      const expected = oracle.decode({ moduleActivation: ACTIVATION, ordinal });
      expect(reconstructed).toBe(expected);
      expect(reconstructed).toBe(catalog.get(ordinal));
      // The reconstructed funcref is the real, callable function.
      expect((reconstructed as () => number)()).toBe(100 + ordinal);
    }

    // The canonical null recipe reconstructs null (ref.null func).
    expect(x.__wpk_fork_ref_decode_funcref(0)).toBe(null);

    // Proof of use: the module reconstructed exactly the 5 references decoded
    // (4 funcrefs + 1 null), so this ran through the module, not a JS fallback.
    const after = x.fm_stats(FmStatField.ReferencesReconstructed);
    expect(Number(after - before)).toBe(funcrefRecipes.length + 1);
    expect(Number(after)).toBeGreaterThan(0);
  });
});
