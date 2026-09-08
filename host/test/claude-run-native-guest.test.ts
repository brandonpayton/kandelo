/**
 * End-to-end proof: the real Claude Code Bun standalone executable runs
 * through the whole `bun-run` pipeline on spidermonkey-node inside the
 * kernel. `bun-run.js` (Task 2) spawns `bun-extract --prepare` (Task 1) to
 * extract the plaintext ESM module graph from the real ~207 MB Claude ELF,
 * installs a thin `Bun` global shim, and natively `import()`s the cached
 * entry point. The platform fixes (Tasks 3-5 — bare-specifier ESM
 * resolution, `import.meta.{url,dirname,require}`, and `using` declaration
 * support) let the full ~1819-module graph load with no esbuild and no CJS
 * bundling.
 *
 * Skips unless CLAUDE_BUN_ELF points at a real Claude Code Bun executable
 * (the ~207 MB binary is not in the repo).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tryResolveBinary } from "../src/binary-resolver";
import { MemoryFileSystem } from "../src/vfs/memory-fs";
import { runCentralizedProgram } from "./centralized-test-helper";

const ELF = process.env.CLAUDE_BUN_ELF ?? "/tmp/cc-inspect/lx259/package/claude";

describe("bun-run: real Claude Code ELF end-to-end on spidermonkey-node", () => {
  const nodeWasm = tryResolveBinary("programs/spidermonkey-node.wasm");
  const extractWasm = tryResolveBinary("programs/bun-extract.wasm");
  const shWasm = tryResolveBinary("programs/sh.wasm");
  const ready = nodeWasm != null && existsSync(nodeWasm)
    && extractWasm != null && existsSync(extractWasm)
    && shWasm != null && existsSync(shWasm)
    && existsSync(ELF);

  it.runIf(ready)(
    "bun-run /usr/bin/claude --version prints the real Claude Code version",
    async () => {
      const elfBytes = readFileSync(ELF);

      // Empty rootfs with capacity for the ELF input + ~1819 extracted JS
      // modules + bun-extract's cache/manifest bookkeeping + the small
      // staged programs + slack. Mirrors the 360MB budget proven sufficient
      // for extraction alone in bun-extract-real-guest.test.ts, with
      // headroom for the additional staged files and bun-run.js's own
      // bookkeeping under /var/cache/kandelo/bun-run.
      const cap = 420 * 1024 * 1024;
      const fs = MemoryFileSystem.create(new SharedArrayBuffer(cap));
      const emptyImage = await fs.saveImage();

      const result = await runCentralizedProgram({
        programPath: nodeWasm!,
        argv: ["node", "/usr/lib/kandelo/bun-run.js", "/usr/bin/claude", "--version"],
        env: ["HOME=/root", "CLAUDE_CONFIG_DIR=/root/.claude", "PATH=/usr/bin:/bin"],
        rootfsImage: emptyImage, // preserves the 420MB capacity
        execPrograms: new Map([
          ["/usr/bin/claude", ELF],
          ["/usr/bin/bun-extract", extractWasm!],
          ["/usr/lib/kandelo/bun-run.js", join(__dirname, "../../runtime/bun-run/bun-run.js")],
          // spidermonkey-node's child_process.spawnSync shim runs commands
          // via libc popen(), which execs /bin/sh; bun-run.js uses it to
          // spawn bun-extract (see Task 2). A full rootfs image already
          // carries /bin/sh; this minimal (non-default) test rootfs needs
          // it staged explicitly.
          ["/bin/sh", shWasm!],
        ]),
        useDefaultRootfs: false,
        timeout: 240_000,
      });

      // eslint-disable-next-line no-console
      console.log("STDOUT:", result.stdout.trim());
      // eslint-disable-next-line no-console
      console.log("STDERR:", result.stderr.trim().split("\n").slice(-60).join("\n"));
      // eslint-disable-next-line no-console
      console.log("input bytes:", elfBytes.byteLength);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toMatch(/2\.1\.\d+ \(Claude Code\)/);
    },
    260_000,
  );
});
