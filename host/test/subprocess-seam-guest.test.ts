/**
 * Guest seam test for the native async subprocess + fd primitives added by
 * spidermonkey-node patch 0022 (M2 Phase K). It calls the raw seam directly —
 * globalThis.__kandeloNodeNative.{__kandeloPipe,__kandeloSpawn,__kandeloFdRead,
 * __kandeloFdClose,__kandeloWaitPid} — to prove the platform can: create a
 * non-blocking pipe, posix_spawn a real staged program (/bin/sh) with dup2
 * file-actions, stream its stdout over the pipe to EOF, reap the child for its
 * exit code, AND fire a real-delay setTimeout (the previously-dead timer wheel
 * the same patch wires into the shell's job-queue poll loop).
 *
 * The child runs `echo hi`, whose captured stdout is "hi\n" (this sh.wasm has
 * only shell builtins staged — no external `printf`/`/bin/printf` — and its
 * `echo` builtin appends the trailing newline). Asserting on the exact bytes
 * "hi\n" keeps the check truthful rather than trimming the shell artifact.
 *
 * This is the durable regression guard for the seam Task 2's async
 * child_process is built on; if the natives regress this fails loudly instead
 * of silently degrading back to the synchronous popen path.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { tryResolveBinary } from "../src/binary-resolver";
import { MemoryFileSystem } from "../src/vfs/memory-fs";
import { ensureDirRecursive, writeVfsBinary } from "../src/vfs/image-helpers";
import { runCentralizedProgram } from "./centralized-test-helper";

const FIXTURES: Record<string, string> = {
  // Drives the seam end-to-end: pipe -> spawn(/bin/sh -c 'printf hi') with the
  // write end dup2'd onto the child's stdout, read to EOF, reap, then a
  // real-delay setTimeout that must fire before the loop exits.
  "mainseam.cjs":
    "(async()=>{try{\n" +
    "  const n=globalThis.__kandeloNodeNative;\n" +
    "  if(!n||typeof n.__kandeloSpawn!=='function'){console.log('SEAM no-native');return;}\n" +
    "  const [r,w]=n.__kandeloPipe();\n" +
    "  const pid=n.__kandeloSpawn('/bin/sh',['sh','-c','echo hi; exit 0'],\n" +
    "    Object.entries(process.env).map(([k,v])=>k+'='+v),\n" +
    "    [{op:'dup2',from:w,to:1},{op:'close',fd:r},{op:'close',fd:w}], {});\n" +
    "  n.__kandeloFdClose(w);\n" +
    "  let out='';\n" +
    "  for(;;){const ab=await n.__kandeloFdRead(r, 65536); if(ab.byteLength===0)break; out+=Buffer.from(ab).toString('utf8');}\n" +
    "  n.__kandeloFdClose(r);\n" +
    "  const st=await n.__kandeloWaitPid(pid);\n" +
    "  const t=await new Promise((res)=>setTimeout(()=>res('T'),50));\n" +
    "  console.log('SEAM',JSON.stringify(out),st.code,st.signal,t);\n" +
    "}catch(e){console.log('SEAMERR',(e&&e.message)||e);}})();\n",
};

function stageFixtures(): string {
  const dir = mkdtempSync(join(tmpdir(), "subprocess-seam-"));
  for (const [name, content] of Object.entries(FIXTURES)) {
    const dest = join(dir, name);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, content, "utf8");
  }
  return dir;
}

const DIR = stageFixtures();

function image(): Uint8Array | Promise<Uint8Array> {
  const fs = MemoryFileSystem.create(new SharedArrayBuffer(8 * 1024 * 1024));
  ensureDirRecursive(fs, "/app");
  for (const f of Object.keys(FIXTURES)) {
    const sub = dirname(f);
    if (sub !== ".") ensureDirRecursive(fs, `/app/${sub}`);
    writeVfsBinary(fs, `/app/${f}`, new Uint8Array(readFileSync(join(DIR, f))), 0o644);
  }
  return fs.saveImage();
}

describe("spidermonkey-node native subprocess seam", () => {
  const envNode = process.env.WASM_POSIX_ESM_PROBE_NODE;
  const nodeWasm =
    (envNode && existsSync(envNode))
      ? envNode
      : (tryResolveBinary("programs/spidermonkey-node.wasm") ??
        (() => {
          const pkg = join(__dirname, "../../packages/registry/spidermonkey/bin/node.wasm");
          return existsSync(pkg) ? pkg : null;
        })());
  const shWasm = tryResolveBinary("programs/sh.wasm");
  const ready = nodeWasm != null && shWasm != null;

  async function runOne(mainPath: string) {
    const img = await image();
    return runCentralizedProgram({
      programPath: nodeWasm!,
      argv: ["node", mainPath],
      rootfsImage: img,
      useDefaultRootfs: false,
      execPrograms: new Map([["/bin/sh", shWasm!]]),
      timeout: 60_000,
    });
  }

  it.runIf(ready)("native subprocess seam: spawn+pipe+read+waitpid+timer", async () => {
    const r = await runOne("/app/mainseam.cjs");
    // eslint-disable-next-line no-console
    console.log("SEAM STDOUT:", JSON.stringify(r.stdout.trim()), "STDERR:", r.stderr.trim().split("\n").slice(-6).join(" | "));
    expect(r.stdout).toContain('SEAM "hi\\n" 0 null T');
  }, 90_000);
});
