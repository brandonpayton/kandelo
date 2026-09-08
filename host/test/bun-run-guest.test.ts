/**
 * Proves the `bun-run.js` bootstrap runs an extracted Bun app end-to-end on
 * spidermonkey-node inside the real kernel: it spawns `bun-extract --prepare`,
 * installs the `Bun` global shim, sets the app's argv, and natively `import()`s
 * the cached entry. Uses a synthetic Bun fixture whose entry is reached only
 * via a path-specifier import (no bare specifiers, no import.meta, no `using`)
 * so this test does not depend on later platform-fix tasks.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { tryResolveBinary } from "../src/binary-resolver";
import { runCentralizedProgram } from "./centralized-test-helper";

// Build the same minimal graph shape as bun-extract-guest.test.ts: entry "cli"
// imports "chunk-a.js" (a path specifier) and prints proof lines.
function buildFixture(): Uint8Array {
  const TRAILER = Buffer.from("\n---- Bun! ----\n", "latin1");
  const mods: Array<[string, string]> = [
    ["/$bunfs/root/cli",
      'import{tag}from"/$bunfs/root/chunk-a.js";' +
      'console.log("BUNRUN tag="+tag+" ver="+(typeof Bun!=="undefined"?Bun.version:"NO")+" args="+process.argv.slice(2).join(","));'],
    ["/$bunfs/root/chunk-a.js", 'export const tag="ok";'],
  ];
  const parts: Buffer[] = [];
  let len = 0;
  const sp: Array<{ no: number; nl: number; co: number; cl: number }> = [];
  for (const [name, cont] of mods) {
    const nb = Buffer.from(name, "latin1");
    const cb = Buffer.from(cont, "latin1");
    const no = len; parts.push(nb); len += nb.length;
    const co = len; parts.push(cb); len += cb.length;
    sp.push({ no, nl: nb.length, co, cl: cb.length });
  }
  const modOff = len;
  for (const s of sp) {
    const rec = Buffer.alloc(52);
    rec.writeUInt32LE(s.no, 0); rec.writeUInt32LE(s.nl, 4);
    rec.writeUInt32LE(s.co, 8); rec.writeUInt32LE(s.cl, 12);
    // sourcemap/bytecode/module_info/bytecode_origin_path = 0
    rec[48] = 1; // encoding Latin1
    rec[49] = 0; // loader
    rec[50] = 1; // module_format Esm
    rec[51] = 0; // side
    parts.push(rec); len += 52;
  }
  const modLen = len - modOff;
  const byteCount = len; // Offsets sits at base+byteCount
  const off = Buffer.alloc(32);
  off.writeUInt32LE(byteCount, 0); off.writeUInt32LE(0, 4); // u64 byte_count
  off.writeUInt32LE(modOff, 8); off.writeUInt32LE(modLen, 12);
  off.writeUInt32LE(0, 16); // entry_point_id = 0 ("cli")
  // compile_exec_argv_ptr (8) + flags (4) = 0
  parts.push(off); parts.push(TRAILER);
  return Buffer.concat(parts);
}

describe("bun-run bootstrap (extract -> run) on spidermonkey-node", () => {
  const extractWasm = tryResolveBinary("programs/bun-extract.wasm");
  const nodeWasm = tryResolveBinary("programs/spidermonkey-node.wasm");
  const ready = extractWasm != null && existsSync(extractWasm!)
    && nodeWasm != null && existsSync(nodeWasm!);

  it.runIf(ready)(
    "extracts and runs a Bun executable, installing Bun + passing argv",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "bun-run-"));
      const fixture = join(dir, "fixture.bin");
      writeFileSync(fixture, buildFixture());

      const result = await runCentralizedProgram({
        programPath: nodeWasm!,
        argv: ["node", "/usr/lib/kandelo/bun-run.js", "/prog.bun", "hello", "--flag"],
        env: ["PATH=/usr/bin:/bin", "HOME=/root"],
        execPrograms: new Map([
          ["/usr/lib/kandelo/bun-run.js", join(__dirname, "../../runtime/bun-run/bun-run.js")],
          ["/usr/bin/bun-extract", extractWasm!],
          ["/prog.bun", fixture],
          // spidermonkey-node's child_process.spawnSync shim runs commands via
          // libc popen(), which execs /bin/sh; stage it so bun-run.js can
          // spawn bun-extract in this minimal (non-default) test rootfs. A
          // full rootfs image already carries /bin/sh.
          ["/bin/sh", tryResolveBinary("programs/sh.wasm")!],
        ]),
        useDefaultRootfs: false,
        timeout: 60_000,
      });

      // eslint-disable-next-line no-console
      console.log("STDOUT:", result.stdout.trim());
      // eslint-disable-next-line no-console
      console.log("STDERR:", result.stderr.trim().split("\n").slice(-40).join("\n"));

      expect(result.stdout).toContain("BUNRUN tag=ok ver=");
      expect(result.stdout).toContain("args=hello,--flag");
    },
    75_000,
  );
});
