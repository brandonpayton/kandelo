// Phase 6 D6.5 — live, reference-carrying funcref fork through a REAL
// centralized worker, with the co-resident fork-module ENABLED.
//
// This closes the validation gap between the module-level funcref proof
// (`host/test/fork-module-funcref-replay.test.ts`, which drives the injected
// module's `__wpk_fork_ref_decode_funcref` directly) and a real guest program:
// here a fork-instrumented guest loads a funcref into a LOCAL that is live
// across `fork()`, and the fresh CHILD calls the reconstructed funcref and
// checks the result. It asserts, for the flag-on worker path:
//
//   (a) CORRECTNESS / PARITY — the child calls the reconstructed funcref and
//       exits 0 exactly as the flag-off (JS reference path) run does. A wrong or
//       absent reconstruction makes the child exit nonzero, which the parent
//       turns into exit 92.
//   (b) PROOF OF USE — the co-resident module reconstructed the carried funcref:
//       the child worker reports `fork_module_references=<n>` with n > 0. A
//       silent JS fallback would leave the module counter at zero, so the flag
//       being on is not enough to pass; the module must actually drive the
//       reference decode.
//
// Before D6.5 the flag-on WORKER reference path was exercised only by `d_01`
// (no references). This is the first end-to-end proof that a real guest's
// funcref survives a fork THROUGH the module.

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runCentralizedProgram } from "./centralized-test-helper";
import type { HostDiagnostic } from "../src/host-diagnostic";

const testDir = dirname(fileURLToPath(import.meta.url));
const fixtureSource = resolve(
  testDir,
  "fixtures/funcref-local-fork-fresh-worker.wat",
);
const instrumenter = resolve(testDir, "../../tools/bin/wasm-fork-instrument");

/**
 * Read the co-resident fork-module's funcref proof-of-use diagnostic. The CHILD
 * worker posts `fork_module_references=<n>` after reconstructing the carried
 * funcref through the flipped `__wpk_fork_ref_decode_funcref` module export; the
 * kernel worker forwards it as a `fork-module` host diagnostic. Returns the
 * reconstructed-reference count, or `null` when the module never drove a
 * reference reconstruction (silent JS fallback / flag off).
 */
function moduleReferencesReconstructed(
  hostDiagnostics: readonly HostDiagnostic[],
): number | null {
  for (const diagnostic of hostDiagnostics) {
    if (diagnostic.source !== "fork-module") continue;
    const match = /fork_module_references=(\d+)/.exec(diagnostic.message);
    if (match) return Number(match[1]);
  }
  return null;
}

describe("funcref fork through the co-resident module (Phase 6 D6.5)", () => {
  let workDir = "";
  let programPath = "";

  beforeAll(() => {
    workDir = mkdtempSync(join(tmpdir(), "kandelo-funcref-fork-"));
    const rawPath = join(workDir, "funcref-local-fork-fresh-worker.raw.wasm");
    programPath = join(workDir, "funcref-local-fork-fresh-worker.wasm");
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

  it("drives the carried funcref reconstruction through the module", async () => {
    const result = await runCentralizedProgram({
      programPath,
      argv: ["funcref-local-fork-fresh-worker"],
      timeout: 30_000,
      useDefaultRootfs: false,
    });
    // (a) CORRECTNESS: child called the reconstructed funcref and exited 0.
    expect(
      result.exitCode,
      `flag-on funcref fork exited unexpectedly\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    ).toBe(0);
    expect(result.stderr).toBe("");
    // (b) PROOF OF USE: the module reconstructed the carried funcref.
    const references = moduleReferencesReconstructed(result.forkModuleDiagnostics);
    expect(
      references,
      "expected a fork-module funcref proof-of-use diagnostic; the module did " +
        "not drive the reference reconstruction",
    ).not.toBeNull();
    expect(references!).toBeGreaterThan(0);
  });
});
