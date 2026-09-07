import { describe, it, expect } from "vitest";
import { runCentralizedProgram } from "./centralized-test-helper";
import { resolveBinary } from "../src/binary-resolver";
import { NodePlatformIO } from "../src/platform/node";

describe("MAP_SHARED mmap + msync", () => {
  it("writes through MAP_SHARED mapping and flushes with msync", async () => {
    const result = await runCentralizedProgram({
      programPath: resolveBinary("programs/mmap_shared_test.wasm"),
      io: new NodePlatformIO(),
      timeout: 10000,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("mmap ok");
    expect(result.stdout).toContain("msync ok");
    expect(result.stdout).toContain("read back: xyz");
    expect(result.stdout).toContain("read after munmap: xyzw");
    // H1: a whole-page MAP_SHARED of a 100-byte tmpfs file must not grow it.
    expect(result.stdout).toContain("H1 no-grow ok");
    // M2: writeback must survive close(fd) taken after mmap.
    expect(result.stdout).toContain("M2 close-survives ok");
    expect(result.stdout).toContain("mremap ok");
    expect(result.stdout).toContain("PASS");
  }, 60000);
});
// The explicit 60s timeout covers the heavier kernel this branch compiles and
// runs under Vitest's `forks` pool. The identical program is ~150ms of actual
// guest work standalone, but end-to-end Vitest kernel compile+run on this
// branch is ~9s solo — and materially longer under parallel file execution,
// where CPU contention from other kernel-compiling integration files inflates
// the wall-clock wait. The generous bound avoids flaky timeouts unrelated to
// the mmap path being exercised here.
