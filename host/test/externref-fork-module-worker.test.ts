// Phase 6 D6.5 — live HOST externref fork through a REAL centralized worker,
// with the co-resident fork-module ENABLED.
//
// This closes the last reference kind not yet proven through a real worker fork
// (funcref, exnref, and typed-GC already are). The fixture obtains a genuine
// host reference from the broker-backed `env.get_ext` import, keeps it in a
// reference LOCAL live across `kernel_fork`, and in the fresh CHILD verifies —
// through `env.check_ext` — that the SAME host identity survived the fork.
//
// A module-instance externref has no linear-memory representation, so copying
// the child's memory byte-for-byte cannot carry it: the fresh child must
// reconstruct the broker-tracked externref from the reference recipe. Because
// the value comes from a host import it is a genuine broker externref (an opaque
// host object, not a GC-internalized value), so the fork codec classifies it as
// an `externref` node — exactly the D6.2 broker seam — rather than a typed-GC
// node. With the fork-module enabled the child re-roots the reference through
// the `wpk_fork_host` engine-floor seam (`host_resolve_externref` over the
// worker's externref token cache).
//
// The test wires `get_ext` / `check_ext` to the process externref owner (broker)
// through `ForkHostImportOwnerRuntime`, so the host value the guest holds really
// does round-trip through the broker's `registerForWire` / `authorizeForWire`
// on both the producing call and the child's identity check. It asserts, for the
// flag-on worker path:
//
//   (a) CORRECTNESS / PARITY — the child's `check_ext` confirms the SAME host
//       identity and the child exits 0 exactly as the flag-off (JS reference
//       path) run does. A lost or wrong reconstruction makes the child exit 91
//       (null) or 94 (identity divergence), which the parent turns into exit 92.
//   (b) PROOF OF USE — the co-resident module re-rooted the carried externref
//       through the broker seam: the child worker reports
//       `externrefs_resolved=<n>` with n > 0. A silent JS fallback would leave
//       the module counter at zero.

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runCentralizedProgram } from "./centralized-test-helper";
import { moduleReferenceProof } from "./fork-module-reference-proof";
import { defineForkExternrefImport } from "../src/fork-externref-import-mailbox";
import type { ForkHostImportOwnerRuntime } from "../src/fork-host-import-runtime";

const testDir = dirname(fileURLToPath(import.meta.url));
const fixtureSource = resolve(
  testDir,
  "fixtures/externref-local-fork-fresh-worker.wat",
);
const instrumenter = resolve(testDir, "../../tools/bin/wasm-fork-instrument");

// The single host reference the fixture obtains from `get_ext` and re-checks in
// the fresh child. Broker identity is by JS reference equality, so a distinct
// object per run is the exact identity the child must recover.
const HOST_REFERENCE: { readonly tag: string } = Object.freeze({
  tag: "externref-fork-fixture-host-reference",
});

/**
 * Register `env.get_ext` (mints the host reference) and `env.check_ext` (returns
 * 1 iff it is the SAME host reference) as broker-backed owner host imports. The
 * owner's endpoint routes the externref result through `registerForWire` and the
 * externref parameter through `authorizeForWire`, so the guest only ever holds a
 * broker token — the real value stays host-side and must be re-rooted through the
 * `host_resolve_externref` seam after the fork.
 */
function registerHostReferenceImports(owner: ForkHostImportOwnerRuntime): void {
  owner.register(
    "env",
    "get_ext",
    defineForkExternrefImport(1, [], ["externref"]),
    () => HOST_REFERENCE,
  );
  owner.register(
    "env",
    "check_ext",
    defineForkExternrefImport(2, ["externref"], ["i32"]),
    (_context, value) => (value === HOST_REFERENCE ? 1 : 0),
  );
}

describe("externref fork through the co-resident module (Phase 6 D6.5)", () => {
  let workDir = "";
  let programPath = "";

  beforeAll(() => {
    workDir = mkdtempSync(join(tmpdir(), "kandelo-externref-fork-"));
    const rawPath = join(workDir, "externref-local-fork-fresh-worker.raw.wasm");
    programPath = join(workDir, "externref-local-fork-fresh-worker.wasm");
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

  it("reconstructs a carried host externref fork through the JS reference path (flag off)", async () => {
    // N1 Node/browser parity: a plain host externref with recorded provenance
    // (this fixture's `get_ext` import, routed through the broker) is un-gated
    // (`GC_LOOKUP`'s third branch, see
    // `docs/plans/2026-09-05-n1-nodebrowser-reference-parity-grounding.md`).
    // The fresh child re-roots the SAME broker identity and its `check_ext`
    // call confirms it, so it exits 0 with empty stderr. No co-resident module
    // is enabled here, so nothing drove the restore THROUGH the module — the
    // externref proof-of-use stays null (that diagnostic specifically proves
    // module participation, not JS-path success; see
    // `fork-module-reference-proof.ts`).
    const result = await runCentralizedProgram({
      programPath,
      argv: ["externref-local-fork-fresh-worker"],
      timeout: 30_000,
      forkModuleEnabled: false,
      forkHostImportRegistrar: registerHostReferenceImports,
    });
    expect(
      result.exitCode,
      `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    ).toBe(0);
    expect(result.stderr).toBe("");
    expect(
      moduleReferenceProof(result.hostDiagnostics, "externref"),
    ).toBeNull();
  });

  // F1 (module abort-replay) + N1 Node/browser parity: with the co-resident
  // fork-module ENABLED, the carried externref is now reconstructed for real
  // (not gated) through the module's `host_resolve_externref` engine-floor
  // seam, exactly as the fixture's own header comment describes. This is the
  // primary end-to-end proof that externref capture/restore work identically
  // under both flags.
  it("reconstructs the same carried host externref fork through the co-resident module (flag on)", async () => {
    const result = await runCentralizedProgram({
      programPath,
      argv: ["externref-local-fork-fresh-worker"],
      timeout: 30_000,
      forkModuleEnabled: true,
      forkHostImportRegistrar: registerHostReferenceImports,
    });
    // (a) CORRECTNESS/PARITY: the child's `check_ext` confirms the SAME host
    // identity survived the fork and it exits 0, exactly as the flag-off (JS
    // reference path) run does.
    expect(
      result.exitCode,
      `flag-on externref fork exited unexpectedly\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    ).toBe(0);
    expect(result.stderr).toBe("");
    // (b) PROOF OF USE: the co-resident module re-rooted the carried externref
    // through the broker seam (`externrefs_resolved` > 0), not a silent JS
    // fallback.
    const externrefsResolved = moduleReferenceProof(
      result.hostDiagnostics,
      "externref",
    );
    expect(
      externrefsResolved,
      "expected a fork-module externref proof-of-use diagnostic; the module " +
        "did not resolve the carried externref",
    ).not.toBeNull();
    expect(externrefsResolved!).toBeGreaterThan(0);
  });
});
