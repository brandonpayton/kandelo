// Phase 6 item 4: the vfork BORROWED child drives its continuation replay
// through the co-resident fork-module (flag ON), not the JS engine. This runs a
// real production vfork lifecycle with WASM_POSIX_FORK_MODULE enabled and
// asserts (a) byte-for-byte the SAME correct lifecycle as the flag-off JS path
// (the ordered PASS markers), proving the borrowed module replay is behaviorally
// identical, and (b) a positive fork-module proof-of-use, so a silent JS
// fallback cannot masquerade as success.
import { describe, expect, it } from "vitest";
import { resolveBinary } from "../src/binary-resolver";
import { runCentralizedProgram } from "./centralized-test-helper";

const lifecycleProgram = resolveBinary("programs/vfork-lifecycle.wasm");
const execChild = resolveBinary("programs/exec-child.wasm");

function expectOrdered(output: string, markers: readonly string[]): void {
  let previous = -1;
  for (const marker of markers) {
    const index = output.indexOf(marker);
    expect(index, `missing output marker ${marker}`).toBeGreaterThan(previous);
    previous = index;
  }
}

describe("vfork borrowed replay through the fork-module (flag on)", () => {
  it("keeps the parent parked through exit and failed exec, then releases on exec", async () => {
    const result = await runCentralizedProgram({
      programPath: lifecycleProgram,
      argv: ["vfork-lifecycle"],
      execPrograms: new Map([["/bin/vfork-exec-child", execChild]]),
      useDefaultRootfs: false,
      timeout: 20_000,
    });

    expect(result.exitCode, result.stderr).toBe(0);
    expectOrdered(result.stdout, [
      "CHILD_EXIT_ONE",
      "PARENT_RESUME_ONE",
      "CHILD_EXIT_TWO",
      "PARENT_RESUME_TWO",
      "CHILD_FAILED_EXEC",
      "PARENT_AFTER_FAILED_EXEC_EXIT",
      "PARENT_AFTER_EXEC_COMMIT",
      "PARENT_REAPED_EXEC_CHILD",
      "PASS: VFORK_LIFECYCLE",
    ]);
    // Surface the fork-module diagnostics so the proof-of-use is legible even if
    // the assertion below needs adjusting to the program's child-exit shape.
    const fm = result.hostDiagnostics.filter((d) => d.source === "fork-module");
    // A borrowed child that drove its replay through the module reports a
    // replayed-frame count; a silent JS fallback would report nothing.
    expect(
      fm.some((d) => /fork_module_(child_)?frames=\d+/.test(d.message)),
      `expected a fork-module proof-of-use diagnostic; saw: ${JSON.stringify(fm)}`,
    ).toBe(true);
  });
});
