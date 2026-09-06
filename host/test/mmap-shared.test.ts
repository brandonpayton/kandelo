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
    expect(result.stdout).toContain("mremap ok");
    expect(result.stdout).toContain("PASS");
  }, 30000);
});
// The explicit 30s timeout covers the heavier kernel this branch compiles and
// runs under Vitest's `forks` pool (the identical program runs in ~150ms of
// actual guest work standalone, but end-to-end Vitest kernel compile+run on
// this branch is ~9s — well over the 5s default and unrelated to the mmap
// path being exercised here).
