// Phase 6 D6.5 — live exnref fork through a REAL centralized worker, with the
// co-resident fork-module ENABLED.
//
// This is the exnref analogue of funcref-fork-module-worker.test.ts. Unlike
// catch-ref-fresh-worker.wat (which DROPS the caught exnref and forks carrying
// only the scalar payload), this fixture keeps the caught `exnref` in a
// reference LOCAL live across `fork()`; the fresh CHILD re-throws it with
// `throw_ref`, re-catches it, and checks the recovered payload. It asserts, for
// the flag-on worker path:
//
//   (a) CORRECTNESS / PARITY — the child re-throws the reconstructed exnref and
//       recovers payload 42, exiting 0 exactly as the flag-off (JS reference
//       path) run does. A wrong or absent reconstruction makes the child exit
//       91 (bad payload) or trap on a null exnref, which the parent turns into
//       exit 92.
//   (b) PROOF OF USE — the co-resident module reconstructed the carried exnref:
//       the child worker reports `exnrefs_reconstructed=<n>` with n > 0. A
//       silent JS fallback would leave the module counter at zero.

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runCentralizedProgram } from "./centralized-test-helper";
import { moduleReferenceProof } from "./fork-module-reference-proof";

const testDir = dirname(fileURLToPath(import.meta.url));
const fixtureSource = resolve(
  testDir,
  "fixtures/exnref-local-fork-fresh-worker.wat",
);
const instrumenter = resolve(testDir, "../../tools/bin/wasm-fork-instrument");

describe("exnref fork through the co-resident module (Phase 6 D6.5)", () => {
  let workDir = "";
  let programPath = "";

  beforeAll(() => {
    workDir = mkdtempSync(join(tmpdir(), "kandelo-exnref-fork-"));
    const rawPath = join(workDir, "exnref-local-fork-fresh-worker.raw.wasm");
    programPath = join(workDir, "exnref-local-fork-fresh-worker.wasm");
    execFileSync("wat2wasm", [
      "--enable-exceptions",
      "--enable-threads",
      fixtureSource,
      "-o",
      rawPath,
    ]);
    execFileSync(instrumenter, [rawPath, "-o", programPath]);
  });

  afterAll(() => {
    if (workDir) rmSync(workDir, { recursive: true, force: true });
  });

  it("drives the carried exnref reconstruction through the module", async () => {
    const result = await runCentralizedProgram({
      programPath,
      argv: ["exnref-local-fork-fresh-worker"],
      timeout: 30_000,
      useDefaultRootfs: false,
    });
    // (a) CORRECTNESS: child re-threw the reconstructed exnref, recovered
    // payload 42, and exited 0.
    expect(
      result.exitCode,
      `exnref fork exited unexpectedly\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    ).toBe(0);
    expect(result.stderr).toBe("");
    // (b) PROOF OF USE: the module reconstructed the carried exnref.
    const exnrefs = moduleReferenceProof(result.forkModuleDiagnostics, "exnref");
    expect(
      exnrefs,
      "expected a fork-module exnref proof-of-use diagnostic; the module did " +
        "not drive the exnref reconstruction",
    ).not.toBeNull();
    expect(exnrefs!).toBeGreaterThan(0);
  });
});
