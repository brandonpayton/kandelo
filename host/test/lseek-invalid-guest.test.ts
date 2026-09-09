import { existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { NodePlatformIO } from "../src/platform/node";
import {
  makeHostScratchTempRoot,
  runCentralizedProgram,
} from "./centralized-test-helper";
// The in-kernel tmpfs owns the scratch prefixes unconditionally, so this suite
// stages its host-backed file outside them (`makeHostScratchTempRoot`) to drive
// a real host file through NodePlatformIO rather than the empty kernel tmpfs.


const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
const programs = [
  ["wasm32", join(repoRoot, "examples/lseek_invalid_test.wasm")],
  ["wasm64", join(repoRoot, "examples/lseek_invalid_test.wasm64.wasm")],
] as const;

describe("invalid lseek guest", () => {
  it.each(programs.filter(([, program]) => existsSync(program)))(
    "%s keeps the host-file offset unchanged",
    async (_arch, program) => {
    const tempRoot = makeHostScratchTempRoot("kandelo-lseek-");
    try {
      const result = await runCentralizedProgram({
        programPath: program,
        argv: ["lseek_invalid_test", join(tempRoot, "seek.bin")],
        io: new NodePlatformIO(),
        useDefaultRootfs: false,
        timeout: 10_000,
      });

      expect(result.exitCode, result.stderr).toBe(0);
      expect(result.stdout).toContain("PASS invalid lseek preserves offset");
      expect(result.stderr).toBe("");
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
    },
  );
});
