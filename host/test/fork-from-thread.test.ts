/**
 * Tests fork() called from a pthread_create'd worker thread.
 *
 * The host runtime must (a) drive the wpk_fork state machine from the
 * thread worker so the save buffer contains the thread's frames +
 * saved __tls_base/__stack_pointer; (b) route the child Worker into
 * the thread function via `forkChildThreadFnPtr` so the rewind
 * actually reaches the fork() call site (`_start` isn't in the
 * thread's fork-path call chain); and (c) preserve that entry root and buffer
 * when the child forks again before exec.
 *
 * Without those, the child rewinds zero __tls_base/__stack_pointer
 * and crashes on its first shadow-stack frame — and the parent's
 * `waitpid` then deadlocks because the host never tells the kernel
 * the child died (see PR #465 for the orthogonal crash-reap fix).
 */
import { describe, it, expect } from "vitest";
import { runCentralizedProgram } from "./centralized-test-helper";
import { tryResolveBinary } from "../src/binary-resolver";
import type { HostDiagnostic } from "../src/host-diagnostic";

const forkFromThreadBinary = tryResolveBinary("programs/fork-from-thread.wasm");
const hasFork = !!forkFromThreadBinary;
const concurrentForkBinary = tryResolveBinary(
  "programs/fork-from-concurrent-threads.wasm",
);
const hasConcurrentFork = !!concurrentForkBinary;

/**
 * Extract the co-resident fork-module proof-of-use counts (Phase 6 D7b) from
 * the host diagnostics of a run. `parentFrames` is the pthread PARENT worker's
 * committed-frame count (`fork_module_frames=`); `childFrames` is the fork
 * CHILD worker's replayed-frame count (`fork_module_child_frames=`). Both must
 * be positive on a flag-on run to prove BOTH sides of a fork-from-thread ran
 * through the module rather than silently falling back to the JS closures.
 */
function forkModuleProof(hostDiagnostics: readonly HostDiagnostic[]): {
  parentFrames: number[];
  childFrames: number[];
} {
  const parentFrames: number[] = [];
  const childFrames: number[] = [];
  for (const diagnostic of hostDiagnostics) {
    if (diagnostic.source !== "fork-module") continue;
    const child = /fork_module_child_frames=(\d+)/.exec(diagnostic.message);
    if (child) {
      childFrames.push(Number(child[1]));
      continue;
    }
    const parent = /fork_module_frames=(\d+)/.exec(diagnostic.message);
    if (parent) parentFrames.push(Number(parent[1]));
  }
  return { parentFrames, childFrames };
}

describe("fork-from-non-main-thread", () => {
  it.skipIf(!hasFork)(
    "drives BOTH sides of a fork-from-thread through the co-resident module",
    async () => {
      const result = await runCentralizedProgram({
        programPath: forkFromThreadBinary!,
        argv: ["fork-from-thread"],
        timeout: 15_000,
        // This fixture exercises worker/continuation ownership only and never
        // touches the VFS. Keep the pthread fork proof independent of the
        // separately versioned rootfs package rebuild.
        useDefaultRootfs: false,
      });

      // (a) CORRECTNESS: the child resumed inside the thread function, forked
      // again, and the run exited cleanly. A wrong module-driven unwind/rewind
      // would trap or hang.
      expect(
        result.exitCode,
        `stderr=${result.stderr}\nstdout=${result.stdout}`,
      ).toBe(0);
      expect(result.stdout).toContain("GRANDCHILD_THREAD: ok");
      expect(result.stdout).toContain("PASS");

      // (b) PROOF OF USE — BOTH sides. The pthread PARENT worker unwound its
      // frames through the module (committed > 0) and serialized the KFRE
      // journal image the child reads; the fork CHILD worker rewound those
      // frames through the module (replayed > 0). A silent JS fallback on either
      // side would leave that side's counter absent — flag being on is not
      // enough; the module must actually drive both the parent and the child.
      const proof = forkModuleProof(result.hostDiagnostics);
      expect(
        proof.parentFrames.length,
        "expected a pthread-parent fork-module frame proof-of-use diagnostic; " +
          "the parent did not unwind through the module",
      ).toBeGreaterThan(0);
      expect(Math.max(0, ...proof.parentFrames)).toBeGreaterThan(0);
      expect(
        proof.childFrames.length,
        "expected a fork-child fork-module replay proof-of-use diagnostic; the " +
          "child did not rewind through the module",
      ).toBeGreaterThan(0);
      expect(Math.max(0, ...proof.childFrames)).toBeGreaterThan(0);
    },
    20_000,
  );

  it.skipIf(!hasConcurrentFork)(
    "concurrent pthread forks keep their continuation frames isolated",
    async () => {
      const result = await runCentralizedProgram({
        programPath: concurrentForkBinary!,
        argv: ["fork-from-concurrent-threads"],
        timeout: 60_000,
        useDefaultRootfs: false,
      });

      expect(result.exitCode, `stderr=${result.stderr}\nstdout=${result.stdout}`).toBe(0);
      expect(result.stdout).toContain("PASS: 16 concurrent fork pairs");
    },
    70_000,
  );

  it.skipIf(!hasConcurrentFork)(
    "concurrent pthread forks stay isolated through the co-resident module (flag on)",
    async () => {
      const result = await runCentralizedProgram({
        programPath: concurrentForkBinary!,
        argv: ["fork-from-concurrent-threads"],
        timeout: 60_000,
        useDefaultRootfs: false,
      });

      // Correctness/parity: 16 concurrent fork pairs, each pthread parent
      // serializing its own journal and each child replaying it, stay isolated
      // under the module path exactly as under the JS path.
      expect(result.exitCode, `stderr=${result.stderr}\nstdout=${result.stdout}`).toBe(0);
      expect(result.stdout).toContain("PASS: 16 concurrent fork pairs");

      // Proof of use, both sides: the concurrent pthread PARENTS unwound through
      // the module and the fork CHILDREN rewound through it.
      const proof = forkModuleProof(result.hostDiagnostics);
      expect(Math.max(0, ...proof.parentFrames)).toBeGreaterThan(0);
      expect(Math.max(0, ...proof.childFrames)).toBeGreaterThan(0);
    },
    70_000,
  );
});
