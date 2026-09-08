import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runCentralizedProgram } from "./centralized-test-helper";
import { moduleReferenceProof } from "./fork-module-reference-proof";
import {
  RAW_STATIC_ROOT_LOCAL_FORK_FRESH_WORKER_HEX,
} from "./fixtures/static-root-local-fork-fresh-worker-bytes";

const testDir = dirname(fileURLToPath(import.meta.url));
const fixtureSource = resolve(
  testDir,
  "fixtures/static-root-local-fork-fresh-worker.wat",
);
const instrumenter = resolve(
  testDir,
  "../../tools/bin/wasm-fork-instrument",
);

describe("Wasm GC static-root binder in a fresh process Worker", () => {
  let workDir = "";
  let programPath = "";

  beforeAll(() => {
    workDir = mkdtempSync(join(tmpdir(), "kandelo-static-root-worker-"));
    const rawPath = join(workDir, "static-root.raw.wasm");
    programPath = join(workDir, "static-root.wasm");
    // Keep the source path live in the test contract even though the checked
    // byte fixture is required for WABT compatibility.
    expect(fixtureSource).toMatch(/static-root-local-fork-fresh-worker\.wat$/);
    writeFileSync(
      rawPath,
      Buffer.from(RAW_STATIC_ROOT_LOCAL_FORK_FRESH_WORKER_HEX, "hex"),
    );
    execFileSync(instrumenter, [rawPath, "-o", programPath]);
  });

  afterAll(() => {
    if (workDir) rmSync(workDir, { recursive: true, force: true });
  });

  it("reconstructs the immutable static-root fork through the co-resident module", async () => {
    const result = await runCentralizedProgram({
      programPath,
      argv: ["static-root-local-fork-fresh-worker"],
      timeout: 30_000,
      useDefaultRootfs: false,
    });

    expect(
      result.exitCode,
      `static-root fork exited unexpectedly\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    ).toBe(0);
    expect(result.stderr).toBe("");
    const staticRootsPublished = moduleReferenceProof(
      result.forkModuleDiagnostics,
      "static-root",
    );
    expect(
      staticRootsPublished,
      "expected a fork-module static-root proof-of-use diagnostic; the " +
        "module did not publish the static root",
    ).not.toBeNull();
    expect(staticRootsPublished!).toBeGreaterThan(0);
  });
});
