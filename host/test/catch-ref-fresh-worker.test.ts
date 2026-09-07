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
  "fixtures/catch-ref-fresh-worker.wat",
);
const referencePayloadFixtureSource = resolve(
  testDir,
  "fixtures/reference-catch-payload-fresh-worker.wat",
);
const instrumenter = resolve(
  testDir,
  "../../tools/bin/wasm-fork-instrument",
);

describe("CatchRef fresh process worker replay", () => {
  let workDir = "";
  let programPath = "";
  let referencePayloadProgramPath = "";

  beforeAll(() => {
    workDir = mkdtempSync(join(tmpdir(), "kandelo-catch-ref-worker-"));
    const rawPath = join(workDir, "catch-ref-fresh-worker.raw.wasm");
    programPath = join(workDir, "catch-ref-fresh-worker.wasm");
    execFileSync("wat2wasm", [
      "--enable-exceptions",
      "--enable-threads",
      fixtureSource,
      "-o",
      rawPath,
    ]);
    // The committed fixture declares a placeholder sentinel __abi_version, not a
    // real ABI epoch; stamp the current ABI at instrumentation time (test-only
    // flag) so it tracks the running ABI. This unblocks the artifact gate only —
    // the reconstruction assertions below are what prove correctness.
    execFileSync(instrumenter, ["--stamp-abi-version", rawPath, "-o", programPath]);

    const referencePayloadRawPath = join(
      workDir,
      "reference-catch-payload-fresh-worker.raw.wasm",
    );
    referencePayloadProgramPath = join(
      workDir,
      "reference-catch-payload-fresh-worker.wasm",
    );
    execFileSync("wat2wasm", [
      "--enable-exceptions",
      "--enable-threads",
      referencePayloadFixtureSource,
      "-o",
      referencePayloadRawPath,
    ]);
    execFileSync(instrumenter, [
      "--stamp-abi-version",
      referencePayloadRawPath,
      "-o",
      referencePayloadProgramPath,
    ]);
  });

  afterAll(() => {
    if (workDir) rmSync(workDir, { recursive: true, force: true });
  });

  it("reconstructs the caught exception in a fresh Node child worker", async () => {
    // The fixture's parent waits for the fork child. The child exits 91 if
    // CatchRef replay did not restore payload 42; the parent converts any
    // failed wait status into exit 92.
    const result = await runCentralizedProgram({
      programPath,
      argv: ["catch-ref-fresh-worker"],
      timeout: 30_000,
      useDefaultRootfs: false,
    });

    expect(
      result.exitCode,
      `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    ).toBe(0);
    expect(result.stderr).toBe("");
  });

  it("catches, forks, and restores the scalar payload with the module (flag on)", async () => {
    // Phase 6 D6.5: the same catch-then-fork, with the co-resident fork-module
    // ENABLED. NOTE this fixture DROPS the caught exnref and forks carrying only
    // the scalar payload 42 (see `drop` / `local.set $caught` in the `.wat`), so
    // there is no exnref in the fork's reference graph. This asserts (a) PARITY —
    // the child still exits 0 (payload 42 restored) exactly as the flag-off run;
    // and (b) the exnref proof-of-use stays SILENT (null), because a scalar-only
    // fork carries no exnref for the module to reconstruct (the D7b silent-when-
    // zero contract). Live exnref reconstruction is proven separately by
    // `exnref-local-fork-fresh-worker.test.ts`, whose fixture keeps the exnref
    // live across the fork.
    const result = await runCentralizedProgram({
      programPath,
      argv: ["catch-ref-fresh-worker"],
      timeout: 30_000,
      useDefaultRootfs: false,
      forkModuleEnabled: true,
    });

    // (a) PARITY.
    expect(
      result.exitCode,
      `flag-on catch-then-fork exited unexpectedly\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    ).toBe(0);
    expect(result.stderr).toBe("");

    // (b) No exnref is carried across the fork, so the module reconstructs none
    // and the per-kind exnref proof-of-use stays silent.
    expect(moduleReferenceProof(result.hostDiagnostics, "exnref")).toBeNull();
  });

  it("reconstructs reference-bearing catches through the module (default)", async () => {
    // The first child calls a non-null funcref reconstructed from the child's
    // static function catalog. The second verifies a nullable externref
    // payload; both values originated in a caught exception recipe.
    //
    // Path B P5b: this exercises the exception-carried reference-payload path
    // on the MODULE DEFAULT (no `forkModuleEnabled` override — the co-resident
    // module is the flipped default after P5). Previously this was pinned to the
    // JS path because the module-capture branch of
    // `ForkReferenceTransaction.defineException` validated the exception's
    // payload recipe ids against the JS-only `this.nodes` array, which is empty
    // in module-capture mode, so any reference-bearing exception threw "fork
    // exception reference payloads entry N names missing recipe M". P5b sources
    // those ids against the MODULE builder (`readModuleRecipeIds` +
    // `append_vector` validation) so the module reconstructs them. The exnref
    // proof-of-use asserts the module — not a JS twin — drove the exception
    // reconstruction.
    const result = await runCentralizedProgram({
      programPath: referencePayloadProgramPath,
      argv: ["reference-catch-payload-fresh-worker"],
      timeout: 30_000,
      useDefaultRootfs: false,
    });

    expect(
      result.exitCode,
      `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    ).toBe(0);
    expect(result.stderr).toBe("");
    // The module reconstructed the caught exception recipe (payload references
    // are carried by an exnref node), proving the module path — not the deleted-
    // in-P6 JS twin — handled the reference-bearing exception.
    expect(moduleReferenceProof(result.hostDiagnostics, "exnref")).not.toBeNull();
  });
});
