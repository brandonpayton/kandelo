// PROBE TEST (Phase 0 growable-arena probe — NOT a production contract test).
//
// Settles whether the fix-y fork-frame/guest-page collision (and thus the
// bounded 2 MiB Fix X arena) is a FIXTURE artifact of `fork-memory-clone.c`'s
// raw `__builtin_wasm_memory_grow` (untracked by the kernel MemoryManager, so
// `find_gap` places frames into live pages it never learned about), or a REAL
// headroom/placement constraint that survives with real, kernel-tracked growth.
//
// Enable the module's growable channel arena with
// KANDELO_FORK_PROBE_GROWABLE_ARENA=1 (probe scaffolding). Delete this file and
// the toggle when the probe question is retired.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { runCentralizedProgram } from "./centralized-test-helper";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixtures = join(__dirname, "fixtures");

function setProbe(on: boolean) {
  if (on) process.env.KANDELO_FORK_PROBE_GROWABLE_ARENA = "1";
  else delete process.env.KANDELO_FORK_PROBE_GROWABLE_ARENA;
}

describe("PROBE: growable channel arena vs. bounded Fix X", () => {
  it("GROWABLE: real malloc-growth deep fork (depth=16000) replays cleanly", async () => {
    setProbe(true);
    const r = await runCentralizedProgram({
      programPath: join(fixtures, "malloc-deep-fork.wasm"),
      argv: ["malloc-deep-fork", "16000"],
      timeout: 90_000,
    });
    // eslint-disable-next-line no-console
    console.log(`[GROWABLE d16000] exit=${r.exitCode} out=${JSON.stringify(r.stdout)} diag=${JSON.stringify(r.forkModuleDiagnostics)}`);
    setProbe(false);
    expect(r.stdout).toMatch(/MALLOC_DEEP_FORK_PASS target=16000/);
    expect(r.exitCode).toBe(0);
  });

  it("FIXED (default Fix X): same depth=16000 fork exhausts the 2 MiB arena", async () => {
    setProbe(false);
    const r = await runCentralizedProgram({
      programPath: join(fixtures, "malloc-deep-fork.wasm"),
      argv: ["malloc-deep-fork", "16000"],
      timeout: 90_000,
    });
    // eslint-disable-next-line no-console
    console.log(`[FIXED d16000] exit=${r.exitCode} out=${JSON.stringify(r.stdout)} hostDiag=${JSON.stringify(r.hostDiagnostics.map((d) => d.message?.split("\n")[0]))}`);
    // The bounded arena cannot hold this fork: it does NOT complete like GROWABLE.
    expect(r.stdout).not.toMatch(/MALLOC_DEEP_FORK_PASS/);
  });

  it("CONTROL: raw memory.grow fixture FAILS under growable (untracked clobber)", async () => {
    setProbe(true);
    const r = await runCentralizedProgram({
      programPath: join(fixtures, "fork-memory-clone.wasm"),
      argv: ["fork-memory-clone"],
      timeout: 30_000,
    });
    // eslint-disable-next-line no-console
    console.log(`[CONTROL raw-grow growable] exit=${r.exitCode} err=${JSON.stringify(r.stderr)}`);
    setProbe(false);
    // The fixture's untracked memory.grow makes find_gap clobber the boundary.
    expect(r.exitCode).not.toBe(0);
  });

  it("GROWABLE OOM: constrained budget → truthful failure, parent survives", async () => {
    setProbe(true);
    const r = await runCentralizedProgram({
      programPath: join(fixtures, "malloc-deep-fork.wasm"),
      argv: ["malloc-deep-fork", "16000"],
      timeout: 60_000,
      maxProcessMemoryBytes: 40 * 1024 * 1024,
    });
    // eslint-disable-next-line no-console
    console.log(`[GROWABLE OOM] exit=${r.exitCode} err=${JSON.stringify(r.stderr)}`);
    setProbe(false);
    // fork() returns -1 to the guest (recurse_and_fork rc=-1) rather than a
    // silent success or a clobber.
    expect(r.exitCode).not.toBe(0);
  });
});
