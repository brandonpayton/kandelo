/**
 * Link-surface guard: the exact 40 Node builtin named-exports Claude Code's
 * extracted ESM app imports but node-compat's bootstrap.js didn't provide
 * (Milestone 2 Phase A, task 1). A named import of a name a module doesn't
 * export fails at ESM LINK time — before any code runs — so this stages a
 * tiny fixture that imports the full 40-name surface and asserts it links.
 */
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tryResolveBinary } from "../src/binary-resolver";
import { MemoryFileSystem } from "../src/vfs/memory-fs";
import { ensureDirRecursive, writeVfsBinary } from "../src/vfs/image-helpers";
import { runCentralizedProgram } from "./centralized-test-helper";

// The exact 40-export link surface Claude Code imports. If any name is not
// exported, this module fails to LINK and never prints LINKED40.
const SURFACE = [
  'import{fsyncSync,ftruncateSync}from"fs";',
  'import{constants as fpc,link,lutimes,opendir,statfs}from"fs/promises";',
  'import{availableParallelism,devNull,version as osv,getPriority,setPriority}from"os";',
  'import{timingSafeEqual,randomFillSync,X509Certificate,createCipheriv,createDecipheriv,createPrivateKey,createPublicKey,generateKeyPairSync,sign,verify}from"crypto";',
  'import{deflate,inflate,inflateRawSync,createZstdDecompress}from"zlib";',
  'import{rootCertificates,checkServerIdentity,createSecureContext}from"tls";',
  'import{getSystemErrorName,stripVTControlCharacters}from"util";',
  'import{isProxy}from"util/types";',
  'import{BlockList}from"net";',
  'import{setMaxListeners}from"events";',
  'import{domainToASCII}from"url";',
  'import{monitorEventLoopDelay}from"perf_hooks";',
  'import{ChildProcess}from"child_process";',
  'import{promises as dnsp}from"dns";',
  'import{lookup as dnsplookup}from"dns/promises";',
  'import{join as pjoin}from"path/posix";',
  'import{Buffer as B}from"buffer";',
  'let stubThrew=false;try{createCipheriv("aes-128-cbc",B.alloc(16),B.alloc(16));}catch(e){stubThrew=true;}',
  'console.log("LINKED40");',
  'console.log("SPOT",pjoin("a","b"),availableParallelism()>=1,stripVTControlCharacters("\\u001b[31mx\\u001b[0m"),timingSafeEqual(B.from("ab"),B.from("ab")),stubThrew);',
].join("\n");
const MAIN = '(async()=>{try{await import("/app/surface.mjs");}catch(e){console.log("LINKERR",(e&&e.message)||e);}})();';

function stage(): Uint8Array | Promise<Uint8Array> {
  const dir = mkdtempSync(join(tmpdir(), "bexp-"));
  writeFileSync(join(dir, "surface.mjs"), SURFACE);
  writeFileSync(join(dir, "main.cjs"), MAIN);
  const fs = MemoryFileSystem.create(new SharedArrayBuffer(8 * 1024 * 1024));
  ensureDirRecursive(fs, "/app");
  writeVfsBinary(fs, "/app/surface.mjs", new Uint8Array(readFileSync(join(dir, "surface.mjs"))), 0o644);
  writeVfsBinary(fs, "/app/main.cjs", new Uint8Array(readFileSync(join(dir, "main.cjs"))), 0o644);
  return fs.saveImage();
}

describe("node-compat builtin export completeness", () => {
  const nodeWasm = tryResolveBinary("programs/spidermonkey-node.wasm");
  it.runIf(nodeWasm != null && existsSync(nodeWasm!))(
    "the 40-export Claude link surface instantiates on spidermonkey-node",
    async () => {
      const img = await stage();
      const r = await runCentralizedProgram({
        programPath: nodeWasm!,
        argv: ["node", "/app/main.cjs"],
        rootfsImage: img,
        useDefaultRootfs: false,
        timeout: 60_000,
      });
      // eslint-disable-next-line no-console
      console.log("OUT:", JSON.stringify(r.stdout.trim()), "ERR:", r.stderr.trim().split("\n").slice(-8).join(" | "));
      expect(r.stdout).toContain("LINKED40");
      expect(r.stdout).toContain("SPOT a/b true x true true");
      expect(r.stdout).not.toContain("LINKERR");
    },
    90_000,
  );
});
