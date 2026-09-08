/**
 * Proves the `bun-extract` guest program (programs/bun-extract.c) runs under the
 * real kernel: it parses a Bun standalone module-graph blob and writes the
 * extracted JS modules into the guest VFS. Uses a tiny synthetic graph so the
 * test stays fast and container-independent (the parser anchors on the Bun
 * trailer + Offsets struct, not on Mach-O/ELF headers).
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { tryResolveBinary } from "../src/binary-resolver";
import { runCentralizedProgram } from "./centralized-test-helper";

// Build a graph exercising multiple loaders: js entry + js chunk + text .md +
// file .zst. The .md/.zst contents embed "/$bunfs/root/" to prove they are
// written VERBATIM (only js-class modules get the specifier remap).
function buildFixture(): Uint8Array {
  const TRAILER = Buffer.from("\n---- Bun! ----\n", "latin1");
  // [name, contents, loaderByte, moduleFormat]
  const mods: Array<[string, string, number, number]> = [
    ["/$bunfs/root/cli", '// entry\nimport "/$bunfs/root/chunk-a.js";\n', 1, 1],
    ["/$bunfs/root/chunk-a.js", 'export const a="/$bunfs/root/chunk-a.js";\n', 1, 1],
    ["/$bunfs/root/preamble.md", "# heading\nsee /$bunfs/root/preamble.md\n", 13, 0],
    ["/$bunfs/root/blob.zst", "ZSTDBYTES /$bunfs/root/blob.zst\n", 5, 0],
  ];
  const parts: Buffer[] = [];
  let len = 0;
  const sp: Array<{ no: number; nl: number; co: number; cl: number; ld: number; fmt: number }> = [];
  for (const [name, cont, ld, fmt] of mods) {
    const nb = Buffer.from(name, "latin1");
    const cb = Buffer.from(cont, "latin1");
    const no = len; parts.push(nb); len += nb.length;
    const co = len; parts.push(cb); len += cb.length;
    sp.push({ no, nl: nb.length, co, cl: cb.length, ld, fmt });
  }
  const modOff = len;
  for (const s of sp) {
    const rec = Buffer.alloc(52);
    rec.writeUInt32LE(s.no, 0); rec.writeUInt32LE(s.nl, 4);
    rec.writeUInt32LE(s.co, 8); rec.writeUInt32LE(s.cl, 12);
    rec[48] = 1;      // encoding Latin1
    rec[49] = s.ld;   // loader
    rec[50] = s.fmt;  // module_format
    rec[51] = 0;      // side
    parts.push(rec); len += 52;
  }
  const modLen = len - modOff;
  const byteCount = len;
  const off = Buffer.alloc(32);
  off.writeUInt32LE(byteCount, 0); off.writeUInt32LE(0, 4);
  off.writeUInt32LE(modOff, 8); off.writeUInt32LE(modLen, 12);
  off.writeUInt32LE(0, 16); // entry_point_id = 0
  parts.push(off); parts.push(TRAILER);
  return Buffer.concat(parts);
}

describe("bun-extract guest program", () => {
  const wasm = tryResolveBinary("programs/bun-extract.wasm");
  it.runIf(wasm != null && existsSync(wasm!))(
    "extracts a Bun module graph into the guest VFS",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "bun-extract-"));
      const fixture = join(dir, "fixture.bin");
      writeFileSync(fixture, buildFixture());

      const result = await runCentralizedProgram({
        programPath: wasm!,
        argv: ["bun-extract", "/fixture.bin", "/out"],
        execPrograms: new Map([["/fixture.bin", fixture]]),
        useDefaultRootfs: false,
        timeout: 30_000,
      });

      expect(result.exitCode).toBe(0);
      // Parsed the graph in-guest:
      expect(result.stdout).toContain("EXTRACTED count=4 esm=2 entry=cli");
      // Wrote the tree and read the entry file back inside the guest VFS:
      expect(result.stdout).toContain("ENTRY_HEAD // entry");
    },
    45_000,
  );

  it.runIf(wasm != null && existsSync(wasm!))(
    "prepare records a per-file loader manifest and writes non-js assets verbatim",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "bun-loaders-"));
      const fixture = join(dir, "fixture.bin");
      writeFileSync(fixture, buildFixture());
      const r = await runCentralizedProgram({
        programPath: wasm!,
        argv: ["bun-extract", "--prepare", "/fixture.bin", "/cache"],
        execPrograms: new Map([["/fixture.bin", fixture]]),
        useDefaultRootfs: false,
        timeout: 30_000,
      });
      expect(r.exitCode).toBe(0);
      // Manifest loaders map: text + file recorded; js entry/chunk omitted.
      const m = r.stdout.match(/^MANIFEST_LOADERS (.+)$/m)?.[1];
      expect(m).toBeTruthy();
      const loaders = JSON.parse(m!);
      expect(loaders["preamble.md"]).toBe("text");
      expect(loaders["blob.zst"]).toBe("file");
      expect(loaders["chunk-a.js"]).toBeUndefined(); // js omitted (default)
      // Verbatim proof: the .md/.zst self-checks still contain /$bunfs/root/,
      // while the js entry was remapped (REMAP_OK = no /$bunfs/root/ left).
      expect(r.stdout).toMatch(/^ASSET_VERBATIM preamble\.md yes$/m);
      expect(r.stdout).toMatch(/^ASSET_VERBATIM blob\.zst yes$/m);
      expect(r.stdout).toContain("REMAP_OK");
    },
    45_000,
  );

  it.runIf(wasm != null && existsSync(wasm!))(
    "prepare mode caches, remaps specifiers, and is a no-op on hit",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "bun-prepare-"));
      const fixture = join(dir, "fixture.bin");
      writeFileSync(fixture, buildFixture());

      // First run: miss -> extracts, prints CACHE=/ENTRY=, remaps specifiers.
      const r1 = await runCentralizedProgram({
        programPath: wasm!,
        argv: ["bun-extract", "--prepare", "/fixture.bin", "/cache"],
        execPrograms: new Map([["/fixture.bin", fixture]]),
        useDefaultRootfs: false,
        timeout: 30_000,
      });
      expect(r1.exitCode).toBe(0);
      const cache = r1.stdout.match(/^CACHE=(.+)$/m)?.[1];
      const entry = r1.stdout.match(/^ENTRY=(.+)$/m)?.[1];
      expect(cache).toBeTruthy();
      expect(entry).toBeTruthy();
      // Entry lives under the cache dir and its specifiers are remapped.
      expect(entry!.startsWith(cache!)).toBe(true);
      // Entry is renamed to .mjs so spidermonkey-node loads it as ESM.
      expect(entry!.endsWith(".mjs")).toBe(true);
      // Prove remap by having the program cat the entry back (self-check line):
      expect(r1.stdout).toContain(`REMAP_OK ${cache}`);

      // Second run in the same rootfs would need a persistent FS; instead assert
      // the printed hash is stable across two prepare runs on identical input.
      const r2 = await runCentralizedProgram({
        programPath: wasm!,
        argv: ["bun-extract", "--prepare", "/fixture.bin", "/cache"],
        execPrograms: new Map([["/fixture.bin", fixture]]),
        useDefaultRootfs: false,
        timeout: 30_000,
      });
      expect(r2.stdout.match(/^CACHE=(.+)$/m)?.[1]).toBe(cache);
    },
    45_000,
  );
});
