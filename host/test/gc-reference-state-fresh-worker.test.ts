import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runCentralizedProgram } from "./centralized-test-helper";
import { moduleReferenceProof } from "./fork-module-reference-proof";
import {
  RAW_GC_REFERENCE_STATE_FRESH_WORKER_HEX,
} from "./fixtures/gc-reference-state-fresh-worker-bytes";

const testDir = dirname(fileURLToPath(import.meta.url));
const fixtureSource = resolve(
  testDir,
  "fixtures/gc-reference-state-fresh-worker.wat",
);
const instrumenter = resolve(
  testDir,
  "../../tools/bin/wasm-fork-instrument",
);

describe("Wasm GC reference state in a fresh process Worker", () => {
  let workDir = "";
  let programPath = "";

  beforeAll(() => {
    workDir = mkdtempSync(join(tmpdir(), "kandelo-gc-reference-worker-"));
    const rawPath = join(workDir, "gc-reference-state.raw.wasm");
    programPath = join(workDir, "gc-reference-state.wasm");
    // Keep the source path live in the test contract even though the checked
    // byte fixture is required for WABT compatibility.
    expect(fixtureSource).toMatch(/gc-reference-state-fresh-worker\.wat$/);
    writeFileSync(
      rawPath,
      Buffer.from(RAW_GC_REFERENCE_STATE_FRESH_WORKER_HEX, "hex"),
    );
    execFileSync(instrumenter, [rawPath, "-o", programPath]);
  });

  afterAll(() => {
    if (workDir) rmSync(workDir, { recursive: true, force: true });
  });

  it("reconstructs a cyclic typed-GC identity fork through a fresh child (flag off)", async () => {
    // N1 Node/browser parity: typed Wasm-GC struct capture is un-gated (see
    // the sibling gc-reference-cycle-fresh-worker.test.ts and
    // docs/plans/2026-09-05-n1-nodebrowser-reference-parity-grounding.md).
    // The fresh child now genuinely reconstructs the self-cyclic struct
    // through the JS reference path (no co-resident module here) and exits 0
    // with empty stderr; the typed-GC proof-of-use (module participation
    // only) stays null.
    const result = await runCentralizedProgram({
      programPath,
      argv: ["gc-reference-state-fresh-worker"],
      timeout: 30_000,
      useDefaultRootfs: false,
    });

    expect(
      result.exitCode,
      `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    ).toBe(0);
    expect(result.stderr).toBe("");
    expect(moduleReferenceProof(result.hostDiagnostics, "gc")).toBeNull();
  });

  it("reconstructs the same cyclic typed-GC identity fork through the co-resident module (flag on)", async () => {
    const result = await runCentralizedProgram({
      programPath,
      argv: ["gc-reference-state-fresh-worker"],
      timeout: 30_000,
      useDefaultRootfs: false,
      forkModuleEnabled: true,
    });

    expect(
      result.exitCode,
      `flag-on GC fork exited unexpectedly\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    ).toBe(0);
    expect(result.stderr).toBe("");
    const gcNodes = moduleReferenceProof(result.hostDiagnostics, "gc");
    expect(
      gcNodes,
      "expected a fork-module typed-GC proof-of-use diagnostic; the module " +
        "did not admit the cyclic GC reconstruction",
    ).not.toBeNull();
    expect(gcNodes!).toBeGreaterThan(0);
  });
});
