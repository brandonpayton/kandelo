import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runCentralizedProgram } from "./centralized-test-helper";
import { moduleReferenceProof } from "./fork-module-reference-proof";
import {
  RAW_STATIC_ROOT_BARE_LOCAL_FORK_FRESH_WORKER_HEX,
} from "./fixtures/static-root-bare-local-fork-fresh-worker-bytes";

const testDir = dirname(fileURLToPath(import.meta.url));
const fixtureSource = resolve(
  testDir,
  "fixtures/static-root-bare-local-fork-fresh-worker.wat",
);
const instrumenter = resolve(
  testDir,
  "../../tools/bin/wasm-fork-instrument",
);

// N1 Node/browser parity: a static root captured as a BARE local value across
// fork (not behind a GC struct field) is un-gated (`GC_LOOKUP`'s static-root
// branch, `ForkReferenceTransaction.lookupGcSlot`), the same as a static root
// reached through a struct field. This fixture exists to prove the BARE case
// specifically — the pre-existing bare-local parent-replay trap it used to
// regress (the parent's transit slot must be sized/published even when no
// struct field ever recurses into the value) is exercised directly.
describe("Wasm GC bare static-root fork in a fresh process Worker", () => {
  let workDir = "";
  let programPath = "";

  beforeAll(() => {
    workDir = mkdtempSync(join(tmpdir(), "kandelo-static-root-bare-"));
    const rawPath = join(workDir, "static-root-bare.raw.wasm");
    programPath = join(workDir, "static-root-bare.wasm");
    expect(fixtureSource).toMatch(
      /static-root-bare-local-fork-fresh-worker\.wat$/,
    );
    writeFileSync(
      rawPath,
      Buffer.from(RAW_STATIC_ROOT_BARE_LOCAL_FORK_FRESH_WORKER_HEX, "hex"),
    );
    execFileSync(instrumenter, [rawPath, "-o", programPath]);
  });

  afterAll(() => {
    if (workDir) rmSync(workDir, { recursive: true, force: true });
  });

  it("reconstructs the bare static-root fork through the co-resident module", async () => {
    const result = await runCentralizedProgram({
      programPath,
      argv: ["static-root-bare-local-fork-fresh-worker"],
      timeout: 30_000,
      useDefaultRootfs: false,
    });

    expect(
      result.exitCode,
      `bare static-root fork exited unexpectedly\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
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
