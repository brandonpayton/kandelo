import { describe, expect, it } from "vitest";
import { resolveBinary } from "../src/binary-resolver";
import { runCentralizedProgram } from "./centralized-test-helper";

// Phase 6 D5: prove the co-resident `fork-module` — the UNCONDITIONAL fork
// engine — instantiates at process init inside a REAL centralized worker
// (parent + fork child), and that a real single-parent fork completes
// end-to-end. `fork-module-instance.test.ts` separately asserts the required
// exports at the unit level.

const FIXTURE = "programs/d_01_single_fork.wasm";
const EXPECT = ["PRE_FORK", "CHILD: ok", "PASS: D-01"];

async function runSingleFork() {
  const binary = resolveBinary(FIXTURE);
  const result = await runCentralizedProgram({
    programPath: binary,
    argv: [FIXTURE],
    timeout: 10_000,
  });
  return result;
}

/**
 * Read the co-resident fork-module's proof-of-use diagnostic. The parent worker
 * posts `fork_module_frames=<n>` after a qualifying fork; the host forwards it
 * as a `fork-module` host diagnostic. Returns the committed frame count, or
 * `null` when the module never drove a fork (silent JS fallback).
 */
function moduleFramesCommitted(
  hostDiagnostics: readonly { source: string; message: string }[],
): number | null {
  for (const diagnostic of hostDiagnostics) {
    if (diagnostic.source !== "fork-module") continue;
    const match = /fork_module_frames=(\d+)/.exec(diagnostic.message);
    if (match) return Number(match[1]);
  }
  return null;
}

describe("fork-module worker instantiation", () => {
  it("drives a qualifying fork through the co-resident module", async () => {
    const result = await runSingleFork();
    expect(
      result.exitCode,
      `fork exited unexpectedly\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    ).toBe(0);
    for (const fragment of EXPECT) {
      expect(result.stdout).toContain(fragment);
    }
    // PROOF the module actually served the fork: the parent worker reported a
    // nonzero committed-frame count. The child's own module use is proven by
    // "CHILD: ok" — a replay-only child that never reached the module's driver
    // would crash instead of printing it. Resume slots are proven by
    // construction (the module registers the SAME full resume catalog the JS
    // `__wpk_fork_resume_table` uses): a wrong slot would dispatch the wrong
    // resume thunk and diverge from "PASS: D-01".
    const frames = moduleFramesCommitted(result.hostDiagnostics);
    expect(
      frames,
      "expected a fork-module proof-of-use diagnostic; the module did not drive the fork",
    ).not.toBeNull();
    expect(frames!).toBeGreaterThan(0);
  });
});
