// F1 Task 5: end-to-end proof of the `childPid < 0` branch of module
// abort-replay.
//
// `worker-main.ts`'s parent-fork run loop has TWO callers of
// `processContinuation.beginAbortReplay(errno)`: the capture-side gated
// -reference-kind guard (proven end to end by
// `externref-fork-module-worker.test.ts`'s flag-on test), and the
// `childPid < 0` branch below it -- reached when capture succeeds cleanly but
// the REAL kernel/host then rejects launching the child. This test drives
// that second caller with a genuine (not mocked, not injected at the JS
// layer) kernel-worker rejection: `maxProcessMemoryBytes` -- an existing,
// production `RunProgramOptions` knob used by
// `vfork-lifecycle-guest.test.ts` for the same purpose -- caps the live
// aggregate process-memory budget at exactly the root process's own initial
// address space. A plain (non-vfork) `fork()` therefore needs to allocate a
// brand-new child `WebAssembly.Memory`, which the real
// `ProcessMemoryManager.requireAllocationCapacity`
// (`host/src/process-memory.ts`) refuses with `ProcessMemoryCapacityError`.
// `kernel-worker.ts#rollbackForkWithinKernelEntry` maps that to ENOMEM
// (errno 12) on the SYS_FORK channel response, so `sendForkSyscall` returns a
// genuinely negative childPid -- exactly the `childPid < 0` branch -- driving
// `beginAbortReplay(12)` -> `beginModuleAbortReplay` ->
// `finishModuleTransaction(true)` under `WASM_POSIX_FORK_MODULE=1`.
//
// `programs/d_01_single_fork.c` treats a negative `fork()` return as ITS OWN
// failure (`printf("FAIL: fork errno=%d\n", errno); return 1;`), so a clean
// exit code 1 with that exact message -- not a hang, not a thrown error from
// `runCentralizedProgram`, not a nonempty stderr -- is the proof that the
// module's abort-replay returned -ENOMEM to the guest cleanly and the parent
// process kept running (reached its own `printf`/`return`) rather than
// crashing the worker.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { resolveBinary } from "../src/binary-resolver";
import {
  detectPtrWidth,
  extractHeapBase,
  WASM_PAGE_SIZE,
} from "../src/constants";
import { computeProcessMemoryLayout } from "../src/process-memory";
import { runCentralizedProgram } from "./centralized-test-helper";

const program = resolveBinary("programs/d_01_single_fork.wasm");

/**
 * The root process's own initial address-space size in bytes -- the same
 * helper `vfork-lifecycle-guest.test.ts` uses to compute a
 * `maxProcessMemoryBytes` budget that admits exactly the root process and
 * nothing more.
 */
function initialAddressSpaceBytes(programPath: string): number {
  const file = readFileSync(programPath);
  const bytes = file.buffer.slice(
    file.byteOffset,
    file.byteOffset + file.byteLength,
  );
  const ptrWidth = detectPtrWidth(bytes);
  return (
    computeProcessMemoryLayout({
      ptrWidth,
      programBytes: bytes,
      heapBase: extractHeapBase(bytes),
    }).initialPages * WASM_PAGE_SIZE
  );
}

describe("fork-module kernel-rejected fork (childPid < 0) abort-replay", () => {
  it("returns -ENOMEM to a captured module fork and leaves the parent running, not crashed", async () => {
    const result = await runCentralizedProgram({
      programPath: program,
      argv: ["d_01_single_fork"],
      timeout: 10_000,
      useDefaultRootfs: false,
      // Admits exactly the root process's own initial address space, so its
      // fork()'s new child Memory allocation samples an already-exhausted
      // budget and is rejected by the real (non-mocked) host admission gate.
      maxProcessMemoryBytes: initialAddressSpaceBytes(program),
    });

    expect(
      result.exitCode,
      `expected the guest's own fork-failure branch (exit 1), not a crash\n` +
        `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    ).toBe(1);
    // Empty stderr is the load-bearing signal: a `beginModuleAbortReplay`
    // that threw (the pre-F1 "fork-module path does not own abort replay"
    // crash) would surface as a worker error, not a clean guest-level FAIL.
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("PRE_FORK");
    expect(result.stdout).toContain("FAIL: fork errno=12");
    // No child was ever launched, so the program's own success markers, which
    // only a live child or a successful parent wait would print, never
    // appear.
    expect(result.stdout).not.toContain("CHILD: ok");
    expect(result.stdout).not.toContain("PASS: D-01");
  });
});
