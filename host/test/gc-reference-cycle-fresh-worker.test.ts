// Phase 6 item 3c equivalence VEHICLE: a real instrumented MULTI-NODE Wasm-GC
// guest forked in a fresh process Worker.
//
// The sibling `gc-reference-state-fresh-worker.test.ts` forks a SINGLE
// self-cyclic `$node` struct. This fixture forks a graph with TWO typed-GC
// aggregate kinds joined in a struct<->array CYCLE — a `$node` struct
// referencing an `$arr` array whose element 0 references the struct back. The
// child self-verifies every alias (reference param carryover, mutable reference
// global, mutated reference table), the struct<->array cycle
// (node.array[0] === node), and the scalar struct field, then exits 0 (stderr
// empty) on success.
//
// This is the graph the co-resident fork-module's `fm_build_gc_plan` /
// `fm_drive_execute` typed-GC drive is built to reconstruct (the same
// struct / array ALLOC-emitting kinds `fork-module-drive-r1-trace.test.ts`
// drives through the module). It is authored here so the production 3c flip has
// a genuine multi-node reconstruction to prove flag-on == flag-off against.

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runCentralizedProgram } from "./centralized-test-helper";
import { moduleReferenceProof } from "./fork-module-reference-proof";
import {
  RAW_GC_REFERENCE_CYCLE_FRESH_WORKER_HEX,
} from "./fixtures/gc-reference-cycle-fresh-worker-bytes";

const testDir = dirname(fileURLToPath(import.meta.url));
const fixtureSource = resolve(
  testDir,
  "fixtures/gc-reference-cycle-fresh-worker.wat",
);
const instrumenter = resolve(
  testDir,
  "../../tools/bin/wasm-fork-instrument",
);

describe("Multi-node Wasm GC reference cycle in a fresh process Worker", () => {
  let workDir = "";
  let programPath = "";

  beforeAll(() => {
    workDir = mkdtempSync(join(tmpdir(), "kandelo-gc-reference-cycle-"));
    const rawPath = join(workDir, "gc-reference-cycle.raw.wasm");
    programPath = join(workDir, "gc-reference-cycle.wasm");
    // Keep the source path live in the test contract even though the checked
    // byte fixture is required for WABT compatibility.
    expect(fixtureSource).toMatch(/gc-reference-cycle-fresh-worker\.wat$/);
    writeFileSync(
      rawPath,
      Buffer.from(RAW_GC_REFERENCE_CYCLE_FRESH_WORKER_HEX, "hex"),
    );
    execFileSync(instrumenter, [rawPath, "-o", programPath]);
  });

  afterAll(() => {
    if (workDir) rmSync(workDir, { recursive: true, force: true });
  });

  it("reconstructs a multi-node Wasm-GC cycle fork through a fresh child (flag off)", async () => {
    // N1 Node/browser parity: typed Wasm-GC struct/array/i31 capture is
    // un-gated (mirrors native's already-shipped `gc_lookup`/`gc_claim`
    // layering). The fresh child now genuinely reconstructs the struct<->array
    // cycle, alias carryover, and scalar field through the JS reference path
    // (this is the flag-off / `forkModuleEnabled: false` run) and exits 0 with
    // empty stderr, instead of the old capture-side EOPNOTSUPP gate.
    const result = await runCentralizedProgram({
      programPath,
      argv: ["gc-reference-cycle-fresh-worker"],
      timeout: 30_000,
      useDefaultRootfs: false,
    });

    expect(
      result.exitCode,
      `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    ).toBe(0);
    expect(result.stderr).toBe("");
  });

  it("reconstructs the same multi-node Wasm-GC cycle fork through the co-resident module (flag on)", async () => {
    // EQUIVALENCE + DRIVE PROOF (Phase 6 item 3c production flip): with the
    // co-resident fork-module ENABLED, the child's ref.eq alias checks + the
    // cyclic array element + the scalar struct field + the i31 leaf value all
    // still hold, so it exits 0 with empty stderr — the SAME child outcome as
    // the flag-off run above (equivalence). PROOF OF USE has two counters:
    //
    //   * `gc` (`fm_gc_nodes_reconstructed`): the graph was ADMITTED through the
    //     module (the item 3a data feed). Advances in `fm_begin_reference_replay`.
    //   * `drive` (`fm_drive_steps_executed`): the module actually DROVE the
    //     typed allocate/fill/exn topological order via `fm_build_gc_plan` +
    //     `fm_drive_execute`, in place of the JS `materializeAllTyped` sub-loop.
    //     Advances once per `call_indirect` into a guest `_gc_allocate`/`_gc_fill`.
    //
    // A nonzero `drive` count is the distinct proof — over and above `gc` — that
    // the MODULE, not the JS fallback, reconstructed the typed graph on this
    // RESTORE path. That the child still exits 0 proves the module-driven order
    // reconstructs the identical references the proven JS order does.
    const result = await runCentralizedProgram({
      programPath,
      argv: ["gc-reference-cycle-fresh-worker"],
      timeout: 30_000,
      useDefaultRootfs: false,
      forkModuleEnabled: true,
    });

    expect(
      result.exitCode,
      `flag-on GC cycle fork exited unexpectedly\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    ).toBe(0);
    expect(result.stderr).toBe("");

    const gcNodes = moduleReferenceProof(result.hostDiagnostics, "gc");
    expect(
      gcNodes,
      "expected a fork-module typed-GC proof-of-use diagnostic; the module did " +
        "not admit the multi-node GC reconstruction",
    ).not.toBeNull();
    expect(gcNodes!).toBeGreaterThan(0);

    // The item 3c DRIVE proof: the module executed the typed-GC drive plan.
    const driveSteps = moduleReferenceProof(result.hostDiagnostics, "drive");
    expect(
      driveSteps,
      "expected a fork-module DRIVE proof-of-use diagnostic; the module admitted " +
        "the graph but did not drive the typed allocate/fill order (item 3c)",
    ).not.toBeNull();
    // struct ALLOC + array ALLOC + i31 ALLOC + struct FILL + array FILL = 5
    // drive steps at minimum; assert the drive ran, not an exact plan shape.
    expect(driveSteps!).toBeGreaterThan(0);
  });
});
