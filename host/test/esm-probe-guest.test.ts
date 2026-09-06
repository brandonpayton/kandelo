/**
 * Probe: does spidermonkey-node support REAL native ESM (minified import + export,
 * multi-module graph) — via dynamic import() and via a .mjs main? Settles whether
 * "spidermonkey-node has no real ESM" is accurate. This is the durable regression
 * guard for the three platform patches it exercises: 0015 (bare-specifier
 * resolution), 0016 (import.meta population), and 0017 (`using` / Explicit
 * Resource Management support).
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { tryResolveBinary } from "../src/binary-resolver";
import { MemoryFileSystem } from "../src/vfs/memory-fs";
import { ensureDirRecursive, symlink, writeVfsBinary } from "../src/vfs/image-helpers";
import { runCentralizedProgram } from "./centralized-test-helper";

// Inlined fixture contents — kept tiny and minified to match the shape of a
// real bundled Bun/esbuild output (no whitespace between tokens). Written to
// a fresh mkdtempSync temp dir per test run so this test is self-contained:
// previously the fixtures lived only at /tmp/cc-inspect/esm_probe, which is
// uncommitted and does not survive a fresh checkout, so every case silently
// skipped instead of running.
const FIXTURES: Record<string, string> = {
  "a.mjs": 'export const x=42;export function f(){return "hi"}',
  "b.mjs": 'import{x,f}from"/app/a.mjs";export const y=x+1;export function g(){return f()+"!"}',
  "main.cjs":
    '(async()=>{try{const m=await import("/app/b.mjs");console.log("ESMOK",m.y,m.g());}catch(e){console.log("ESMERR",(e&&e.message)||e);}})();',
  "mainmod.mjs": 'import{x}from"/app/a.mjs";console.log("MJSMAIN",x);',
  "a2.mjs": 'import{readFileSync}from"fs";export const ok=typeof readFileSync==="function";',
  "main2.cjs":
    '(async()=>{try{const m=await import("/app/a2.mjs");console.log("BARE",m.ok);}catch(e){console.log("BAREERR",(e&&e.message)||e);}})();',
  "meta.mjs": "export const info=[import.meta.url,import.meta.dirname,typeof import.meta.require];",
  "mainmeta.cjs":
    '(async()=>{try{const m=await import("/app/meta.mjs");console.log("META",m.info.join("|"));}catch(e){console.log("METAERR",(e&&e.message)||e);}})();',
  "using.mjs":
    "export function run(){class R{[Symbol.dispose](){globalThis.__d=(globalThis.__d||0)+1;}}{using r=new R();}return globalThis.__d;}",
  "mainusing.cjs":
    '(async()=>{try{const m=await import("/app/using.mjs");console.log("USING",m.run());}catch(e){console.log("USINGERR",(e&&e.message)||e);}})();',
  "dep.mjs": "export const v=41;",
  "node_modules/epkg/package.json": '{"type":"module","main":"index.js"}',
  "node_modules/epkg/index.js": 'import{v}from"/app/dep.mjs";export const w=v+1;export default "epkgdefault";',
  // The bare dynamic import() lives in a genuine native ES module
  // (dynhost.mjs), not directly in the CJS main: only a referrer compiled by
  // the native module loader (CompileModule) carries the script-path private
  // data __kandeloResolveBare needs to walk node_modules from the right
  // directory. A classic/CJS script executed via the shell's
  // evalScriptAsFunction helper never registers that private data (only the
  // shell's own top-level RunFile path does), so a bare specifier dynamically
  // imported directly from CJS always resolves with a null referrer. This
  // mirrors the real Claude Code shape: a lazily-loaded ESM chunk performing
  // `import()` of a bare specifier from within already-native ESM code.
  "dynhost.mjs":
    '(async()=>{try{const m=await import("epkg");console.log("DYN",m.w,m.default);}catch(e){console.log("DYNERR",(e&&e.message)||e);}})();',
  "maindyn.cjs":
    '(async()=>{try{await import("/app/dynhost.mjs");}catch(e){console.log("DYNERR",(e&&e.message)||e);}})();',
  // /app is a type:module package so the bare `.js` fixtures below are ES
  // modules (require() must detect this and route through the native loader
  // instead of CJS-wrapping them).
  "package.json": '{"type":"module"}',
  // require() of an ESM .js: returns the module namespace (named + default).
  "e.js": 'export const y=43;export default "edefault";',
  "maincjs.cjs":
    '(()=>{try{const m=require("/app/e.js");console.log("REQ",m.y,m.default);}catch(e){console.log("REQERR",(e&&e.message)||e);}})();',
  // require() of an ESM with top-level await: must throw ERR_REQUIRE_ASYNC_MODULE.
  "tla.js": 'export const z=await Promise.resolve(7);',
  "maintla.cjs":
    '(()=>{try{require("/app/tla.js");console.log("TLA no throw");}catch(e){console.log("TLACODE",e&&e.code,(e&&e.message)||e);}})();',
  // require() and import() of the same path must share ONE native-registry
  // instance (a===b and a shared, single-evaluated counter).
  "counter.js": 'let n=0;export function inc(){return ++n;}',
  "maindedup.cjs":
    '(async()=>{try{const a=require("/app/counter.js");const b=await import("/app/counter.js");console.log("DEDUP",a.inc(),b.inc(),a===b);}catch(e){console.log("DEDUPERR",(e&&e.message)||e);}})();',
  // Reverse order: import() first, THEN require() the same path. This is the
  // dominant real ordering (import() is the common route, require(esm) rare),
  // so lock the symmetry — both directions must hit the one native-registry
  // instance (shared counter, a===b), not just require-then-import.
  "counter2.js": 'let n=0;export function inc(){return ++n;}',
  "maindedup2.cjs":
    '(async()=>{try{const b=await import("/app/counter2.js");const a=require("/app/counter2.js");console.log("DEDUPREV",b.inc(),a.inc(),a===b);}catch(e){console.log("DEDUPREVERR",(e&&e.message)||e);}})();',
  // `path/win32` builtin subpath resolves (Phase C). Cross-platform apps
  // statically import both path variants; the win32 import must resolve even
  // though its methods are only called under win32 guards. Both routes:
  // require("path/win32") and a static `import ... from "path/win32"` inside a
  // native ES module (the exact shape that failed with `can't open
  // //path/win32`). `sep` is the win32 backslash.
  "win32.mjs":
    'import*as w from"path/win32";export const sep=w.sep;export const hasJoin=typeof w.join==="function";',
  "mainwin32.cjs":
    '(async()=>{try{const r=require("path/win32");const m=await import("/app/win32.mjs");console.log("WIN32",r.sep,m.sep,m.hasJoin);}catch(e){console.log("WIN32ERR",(e&&e.message)||e);}})();',
  // Symlink dedup (Phase C canonicalization fix): the same specifier
  // "/app/lnk/counter3.js" — where /app/lnk is a symlink to /app/real — loaded
  // via require() and import() must share ONE native-registry instance. require
  // now passes the pre-realpath (lexical) path to the seam, matching the key
  // import gives the lexical shell ModuleLoader; before the fix require keyed on
  // the realpath (/app/real/...) and import on /app/lnk/..., double-instancing.
  "real/counter3.js": 'let n=0;export function inc(){return ++n;}',
  "mainsymdedup.cjs":
    '(async()=>{try{const a=require("/app/lnk/counter3.js");const b=await import("/app/lnk/counter3.js");console.log("SYM",a.inc(),b.inc(),a===b);}catch(e){console.log("SYMERR",(e&&e.message)||e);}})();',
  // `ws` compat module (Phase D): resolves via require + ESM default/named
  // import; default IS the WebSocket class (static OPEN constant, works at
  // module scope); constructing a live socket throws (honest stub — real ws
  // is deferred future work). Mirrors how Bun-bundled apps import ws.
  "wsimport.mjs":
    'import W,{WebSocketServer as S}from"ws";export const okDefault=typeof W==="function"&&W.OPEN===1;export const okNamed=typeof S==="function";',
  "mainws.cjs":
    '(async()=>{try{const R=require("ws");const m=await import("/app/wsimport.mjs");let threw=false;try{new R("wss://x")}catch(e){threw=true}console.log("WS",typeof R,R.OPEN,m.okDefault,m.okNamed,threw);}catch(e){console.log("WSERR",(e&&e.message)||e);}})();',
  // zlib completeness (Phase E): constants (Z_* + BROTLI_*), createUnzip (real,
  // backed by the native gunzip auto-detect), and Brotli as an honest
  // fail-loud stream (constructs, errors on data — real Brotli deferred).
  "mainzlib.cjs":
    '(async()=>{try{const z=require("zlib");const c=z.constants;const unz=typeof z.createUnzip==="function"&&!!z.createUnzip();let brThrew=false;try{const br=z.createBrotliDecompress();brThrew=await new Promise((res)=>{br.on("error",()=>res(true));setTimeout(()=>res(false),3000);br.write(Buffer.from([1,2,3]));});}catch(e){brThrew=true;}console.log("ZLIB",c.Z_SYNC_FLUSH,c.BROTLI_OPERATION_FLUSH,unz,brThrew);}catch(e){console.log("ZLIBERR",(e&&e.message)||e);}})();',
  // Cyclic require(esm): two type:module files require() each other. Before the
  // fix the second (cyclic) require lands on a still-Evaluating module and the
  // seam re-enters ModuleEvaluate -> "module record has unexpected status:
  // Evaluating". After the fix it returns the partial live namespace and the
  // cycle resolves.
  "cycA.mjs":
    'export const a="A";const B=import.meta.require("/app/cycB.mjs");export function getB(){return B&&B.b;}',
  "cycB.mjs":
    'export const b="B";const A=import.meta.require("/app/cycA.mjs");export function getA(){return A&&A.a;}',
  "maincyc.cjs":
    '(()=>{try{const A=require("/app/cycA.mjs");console.log("CYC",A.a,typeof A.getB==="function"?A.getB():"?");}catch(e){console.log("CYCERR",(e&&e.name)||"",(e&&e.message)||e);}})();',
  // TDZ: the cyclically-required module (tdzB) reads a binding of its requirer
  // (tdzA.late) that is NOT yet initialized at the cyclic edge -> ReferenceError.
  // Proves the returned namespace is the real live module namespace.
  "tdzA.mjs":
    'export const early="EA";const B=import.meta.require("/app/tdzB.mjs");export const late="LA";export function readB(){return B.readLateEarly;}',
  "tdzB.mjs":
    'export const b="B";const A=import.meta.require("/app/tdzA.mjs");export let readLateEarly;try{readLateEarly="V:"+A.late;}catch(e){readLateEarly="TDZ:"+e.name;}',
  "maintdz.cjs":
    '(()=>{try{const A=require("/app/tdzA.mjs");console.log("TDZ",A.early,A.readB());}catch(e){console.log("TDZERR",(e&&e.name)||"",(e&&e.message)||e);}})();',
  // Live binding fills in later: liveB captures liveA's namespace while liveA.late
  // is still uninitialized, then reads it AFTER the cycle settles and sees the
  // value -- proving the namespace is a live view, not a point-in-time copy.
  "liveA.mjs":
    'const B=import.meta.require("/app/liveB.mjs");export const late="LATE";export function getB(){return B;}',
  "liveB.mjs":
    'export const b="B";const A=import.meta.require("/app/liveA.mjs");export function readALate(){return A.late;}',
  "mainlive.cjs":
    '(()=>{try{const nsA=require("/app/liveA.mjs");const nsB=nsA.getB();console.log("LIVE",nsB.readALate());}catch(e){console.log("LIVEERR",(e&&e.name)||"",(e&&e.message)||e);}})();',
  // Link-time cycle (patch 0019): during alink's evaluation it require()s blink,
  // which STATICALLY imports alink. Linking blink recurses into alink, which is
  // already `Evaluating` -> before the fix InnerModuleLinking threw "module
  // record has unexpected status: Evaluating". Now it early-returns (an
  // evaluating module is already linked), so blink links + evaluates and reads
  // alink.a (already initialized) -> "LINKCYC A A". This is the shape that
  // blocks `claude -p` (incremental require/import during evaluation with a
  // static back-reference to an evaluating module).
  "alink.mjs":
    'export const a="A";const B=import.meta.require("/app/blink.mjs");export function getFromB(){return B.usesA;}',
  "blink.mjs":
    'import{a}from"/app/alink.mjs";export const usesA=a;',
  "mainlinkcyc.cjs":
    '(()=>{try{const A=require("/app/alink.mjs");console.log("LINKCYC",A.a,A.getFromB());}catch(e){console.log("LINKCYCERR",(e&&e.name)||"",(e&&e.message)||e);}})();',
};

function stageFixtures(): string {
  const dir = mkdtempSync(join(tmpdir(), "esm-probe-"));
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
  // /app/lnk -> /app/real, for the symlink-dedup case (mainsymdedup.cjs).
  symlink(fs, "/app/real", "/app/lnk");
  return fs.saveImage();
}

describe("spidermonkey-node ESM probe", () => {
  const envNode = process.env.WASM_POSIX_ESM_PROBE_NODE;
  const nodeWasm =
    (envNode && existsSync(envNode))
      ? envNode
      : (tryResolveBinary("programs/spidermonkey-node.wasm") ??
        (() => {
          const pkg = join(__dirname, "../../packages/registry/spidermonkey/bin/node.wasm");
          return existsSync(pkg) ? pkg : null;
        })());
  const ready = nodeWasm != null;

  async function runOne(mainPath: string) {
    const img = await image();
    return runCentralizedProgram({
      programPath: nodeWasm!,
      argv: ["node", mainPath],
      rootfsImage: img,
      useDefaultRootfs: false,
      timeout: 60_000,
    });
  }

  it.runIf(ready)("dynamic import() of a minified ESM graph", async () => {
    const img = await image();
    const r = await runCentralizedProgram({
      programPath: nodeWasm!,
      argv: ["node", "/app/main.cjs"],
      rootfsImage: img,
      useDefaultRootfs: false,
      timeout: 60_000,
    });
    // eslint-disable-next-line no-console
    console.log("DYN STDOUT:", JSON.stringify(r.stdout.trim()), "STDERR:", r.stderr.trim().split("\n").slice(-6).join(" | "));
    // Path-specifier native ESM must keep working (regression guard).
    expect(r.stdout).toContain("ESMOK 43 hi!");
  }, 90_000);

  it.runIf(ready)("native ESM resolves a bare Node builtin specifier", async () => {
    const img = await image();
    const r = await runCentralizedProgram({
      programPath: nodeWasm!,
      argv: ["node", "/app/main2.cjs"],
      rootfsImage: img,
      useDefaultRootfs: false,
      timeout: 60_000,
    });
    // eslint-disable-next-line no-console
    console.log("BARE STDOUT:", JSON.stringify(r.stdout.trim()), "STDERR:", r.stderr.trim().split("\n").slice(-6).join(" | "));
    expect(r.stdout).toContain("BARE true");
  }, 90_000);

  it.runIf(ready)("native ESM import.meta is populated (url/dirname/require)", async () => {
    const img = await image();
    const r = await runCentralizedProgram({
      programPath: nodeWasm!,
      argv: ["node", "/app/mainmeta.cjs"],
      rootfsImage: img,
      useDefaultRootfs: false,
      timeout: 60_000,
    });
    // eslint-disable-next-line no-console
    console.log("META STDOUT:", JSON.stringify(r.stdout.trim()), "STDERR:", r.stderr.trim().split("\n").slice(-6).join(" | "));
    expect(r.stdout).toMatch(/META file:\/\/\/app\/meta\.mjs\|\/app\|function/);
  }, 90_000);

  it.runIf(ready)(".mjs main with minified import", async () => {
    const img = await image();
    const r = await runCentralizedProgram({
      programPath: nodeWasm!,
      argv: ["node", "/app/mainmod.mjs"],
      rootfsImage: img,
      useDefaultRootfs: false,
      timeout: 60_000,
    });
    // eslint-disable-next-line no-console
    console.log("MJSMAIN STDOUT:", JSON.stringify(r.stdout.trim()), "STDERR:", r.stderr.trim().split("\n").slice(-6).join(" | "));
  }, 90_000);

  it.runIf(ready)("engine parses and runs `using` (Explicit Resource Management)", async () => {
    const img = await image();
    const r = await runCentralizedProgram({
      programPath: nodeWasm!,
      argv: ["node", "/app/mainusing.cjs"],
      rootfsImage: img,
      useDefaultRootfs: false,
      timeout: 60_000,
    });
    // eslint-disable-next-line no-console
    console.log("USING STDOUT:", JSON.stringify(r.stdout.trim()), "STDERR:", r.stderr.trim().split("\n").slice(-6).join(" | "));
    expect(r.stdout).toContain("USING 1");
  }, 90_000);

  it.runIf(ready)("dynamic import() of a bare ESM package loads as a module", async () => {
    const img = await image();
    const r = await runCentralizedProgram({
      programPath: nodeWasm!,
      argv: ["node", "/app/maindyn.cjs"],
      rootfsImage: img,
      useDefaultRootfs: false,
      timeout: 60_000,
    });
    // eslint-disable-next-line no-console
    console.log("DYN OUT:", JSON.stringify(r.stdout.trim()), "ERR:", r.stderr.trim().split("\n").slice(-6).join(" | "));
    expect(r.stdout).toContain("DYN 42 epkgdefault");
    expect(r.stdout).not.toContain("DYNERR");
  }, 90_000);

  it.runIf(ready)("require() of an ESM .js returns its namespace", async () => {
    const r = await runOne("/app/maincjs.cjs");
    // eslint-disable-next-line no-console
    console.log("REQ OUT:", JSON.stringify(r.stdout.trim()), "ERR:", r.stderr.trim().split("\n").slice(-6).join(" | "));
    expect(r.stdout).toContain("REQ 43 edefault");
  }, 90_000);

  it.runIf(ready)("require() of an ESM module with top-level await throws ERR_REQUIRE_ASYNC_MODULE", async () => {
    const r = await runOne("/app/maintla.cjs");
    // eslint-disable-next-line no-console
    console.log("TLA OUT:", JSON.stringify(r.stdout.trim()), "ERR:", r.stderr.trim().split("\n").slice(-6).join(" | "));
    expect(r.stdout).toContain("TLACODE ERR_REQUIRE_ASYNC_MODULE");
  }, 90_000);

  it.runIf(ready)("require() and import() of the same path share one instance", async () => {
    const r = await runOne("/app/maindedup.cjs");
    // eslint-disable-next-line no-console
    console.log("DEDUP OUT:", JSON.stringify(r.stdout.trim()), "ERR:", r.stderr.trim().split("\n").slice(-6).join(" | "));
    expect(r.stdout).toContain("DEDUP 1 2 true");
  }, 90_000);

  it.runIf(ready)("import() then require() of the same path share one instance", async () => {
    const r = await runOne("/app/maindedup2.cjs");
    // eslint-disable-next-line no-console
    console.log("DEDUPREV OUT:", JSON.stringify(r.stdout.trim()), "ERR:", r.stderr.trim().split("\n").slice(-6).join(" | "));
    expect(r.stdout).toContain("DEDUPREV 1 2 true");
  }, 90_000);

  it.runIf(ready)("path/win32 builtin subpath resolves via require and import", async () => {
    const r = await runOne("/app/mainwin32.cjs");
    // eslint-disable-next-line no-console
    console.log("WIN32 OUT:", JSON.stringify(r.stdout.trim()), "ERR:", r.stderr.trim().split("\n").slice(-6).join(" | "));
    // Backslash separator from both routes; join present (approximate win32).
    expect(r.stdout).toContain("WIN32 \\ \\ true");
  }, 90_000);

  it.runIf(ready)("require() and import() through a symlinked dir share one instance", async () => {
    const r = await runOne("/app/mainsymdedup.cjs");
    // eslint-disable-next-line no-console
    console.log("SYM OUT:", JSON.stringify(r.stdout.trim()), "ERR:", r.stderr.trim().split("\n").slice(-6).join(" | "));
    expect(r.stdout).toContain("SYM 1 2 true");
  }, 90_000);

  it.runIf(ready)("ws compat module resolves; default is the WebSocket class; construct throws", async () => {
    const r = await runOne("/app/mainws.cjs");
    // eslint-disable-next-line no-console
    console.log("WS OUT:", JSON.stringify(r.stdout.trim()), "ERR:", r.stderr.trim().split("\n").slice(-6).join(" | "));
    expect(r.stdout).toContain("WS function 1 true true true");
  }, 90_000);

  it.runIf(ready)("zlib has constants + createUnzip; Brotli is a fail-loud stream", async () => {
    const r = await runOne("/app/mainzlib.cjs");
    // eslint-disable-next-line no-console
    console.log("ZLIB OUT:", JSON.stringify(r.stdout.trim()), "ERR:", r.stderr.trim().split("\n").slice(-6).join(" | "));
    // Z_SYNC_FLUSH=2, BROTLI_OPERATION_FLUSH=1, createUnzip works, Brotli errors on data.
    expect(r.stdout).toContain("ZLIB 2 1 true true");
  }, 90_000);

  it.runIf(ready)("cyclic require(esm) returns the partial namespace (no 'unexpected status')", async () => {
    const r = await runOne("/app/maincyc.cjs");
    // eslint-disable-next-line no-console
    console.log("CYC OUT:", JSON.stringify(r.stdout.trim()), "ERR:", r.stderr.trim().split("\n").slice(-6).join(" | "));
    expect(r.stdout).toContain("CYC A B");
    expect(r.stdout).not.toContain("CYCERR");
  }, 90_000);

  it.runIf(ready)("cyclic require(esm) exposes an uninitialized binding as TDZ", async () => {
    const r = await runOne("/app/maintdz.cjs");
    // eslint-disable-next-line no-console
    console.log("TDZ OUT:", JSON.stringify(r.stdout.trim()), "ERR:", r.stderr.trim().split("\n").slice(-6).join(" | "));
    // tdzB read tdzA.late before it was initialized -> ReferenceError (TDZ).
    expect(r.stdout).toContain("TDZ EA TDZ:ReferenceError");
  }, 90_000);

  it.runIf(ready)("cyclic require(esm) namespace is a live binding (value fills in later)", async () => {
    const r = await runOne("/app/mainlive.cjs");
    // eslint-disable-next-line no-console
    console.log("LIVE OUT:", JSON.stringify(r.stdout.trim()), "ERR:", r.stderr.trim().split("\n").slice(-6).join(" | "));
    // liveB captured liveA's ns while late was TDZ; reads "LATE" after the cycle settles.
    expect(r.stdout).toContain("LIVE LATE");
  }, 90_000);

  it.runIf(ready)("link-time cycle: linking a module whose dep is Evaluating does not throw", async () => {
    const r = await runOne("/app/mainlinkcyc.cjs");
    // eslint-disable-next-line no-console
    console.log("LINKCYC OUT:", JSON.stringify(r.stdout.trim()), "ERR:", r.stderr.trim().split("\n").slice(-6).join(" | "));
    expect(r.stdout).toContain("LINKCYC A A");
    expect(r.stdout).not.toContain("LINKCYCERR");
  }, 90_000);
});
