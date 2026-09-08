/**
 * Guest tests for the async `child_process` rewrite (M2 Phase K, Task 2) on
 * top of the native subprocess seam added in patch 0022 (M2 Phase K, Task 1):
 * `spawn()` is now a real `posix_spawn` + async pipe fd child, not the old
 * synchronous `popen()` shim. `maincat.cjs` is THE deadlock regression guard:
 * before this change a spawned child blocking on `read(0)` had no way to
 * observe EOF (the synchronous popen path never delivered one), which is
 * exactly the shape that deadlocked headless `claude -p`.
 *
 * `/bin/sh` here is a freshly built real `dash` (`packages/registry/dash`),
 * not the legacy `local-binaries/programs/wasm32/sh.wasm` stub used by other
 * older fixtures in this suite: that legacy binary predates the
 * ABI-contract-digest rollout and its builtins are unreliable (its `read`
 * builtin silently drops fed stdin, `pwd`/`type` are unrecognized, and exit
 * status for missing commands is wrong). Real dash was verified directly
 * (throwaway probe, not committed) to run `printf`, `pwd`, and `read`
 * correctly, so `mainspawn.cjs`/`maincwd.cjs` use the brief's exact fixture
 * text. `cat` is not staged in this minimal test rootfs (no coreutils
 * package built here), so `maincat.cjs` substitutes dash's own `read -r`
 * builtin (verified working) — still a genuine child blocked in `read(0)`
 * on its stdin fd, which is the exact regression shape. `mainkill.cjs`
 * substitutes a `while :; do :; done` busy loop for `sleep 30` (no `sleep`
 * binary staged either); it is killed after 100ms regardless.
 *
 * Fixtures that assert on accumulated `stdout`/`stderr` content listen on
 * `'close'`, not `'exit'`: `'exit'` fires as soon as the child is reaped,
 * independently of whether the async pipe-read promises that fill `stdout`/
 * `stderr` have settled yet, so reading accumulated output from an `'exit'`
 * handler is a real race (confirmed directly: `printf` to fd1 then fd2
 * followed immediately by `'exit'` non-deterministically observed fd2's
 * data as not-yet-delivered). This is standard Node.js semantics, not a
 * Kandelo gap — `'close'` is documented to fire only once the process has
 * exited *and* its stdio streams have ended, which is exactly what
 * `_spawn`'s `_maybeClose` gate implements.
 *
 * `exec()`/`execFile()` had the exact same 'exit'-vs-'close' race baked into
 * their callback (they read the accumulated `stdout`/`stderr` when the
 * child exits, before the pipe reads necessarily finish) plus a second bug:
 * `code ? error : null` treats a `null` exit code — which is what a
 * signal-killed child reports — as success. `mainexecbig.cjs`/
 * `mainexecfail.cjs` guard the first fix (full, non-truncated stdout) and
 * the exit-code error path; the signal-kill path is exercised indirectly by
 * the `kill(SIGKILL)` `spawn()` test above proving `_spawn` reports signals
 * correctly on `'close'`, which `exec`'s shared `_runWithCallback` consumes.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { tryResolveBinary } from "../src/binary-resolver";
import { MemoryFileSystem } from "../src/vfs/memory-fs";
import { ensureDirRecursive, writeVfsBinary } from "../src/vfs/image-helpers";
import { runCentralizedProgram } from "./centralized-test-helper";

// `'exit'` fires as soon as the child is reaped; it is NOT guaranteed to
// follow full stdout/stderr drain (the async pipe-read promises and the
// waitpid promise settle independently). This is a real Node.js semantic
// (see the Node docs on 'exit' vs 'close'), not a Kandelo-specific gap — it
// is exactly why Node has a *separate* 'close' event ("emitted after the
// child process ends AND its stdio streams have been closed"), and exactly
// why `_spawn`'s `_maybeClose` gate exists. Any fixture that reads the
// accumulated stdout/stderr must listen on 'close', not 'exit'.
const FIXTURES: Record<string, string> = {
  "mainspawn.cjs":
    '(()=>{const cp=require("child_process");const c=cp.spawn("/bin/sh",["-c","printf out; printf err 1>&2; exit 0"]);' +
    'let o="",e="";c.stdout.on("data",d=>o+=d);c.stderr.on("data",d=>e+=d);' +
    'c.on("close",(code,sig)=>console.log("SPAWN",JSON.stringify(o),JSON.stringify(e),code,sig,c.pid>0));})();',
  // THE deadlock regression guard: stdin.write+end -> child echoes + EOF-exits.
  // `cat` is not staged in this minimal rootfs; dash's own `read -r` builtin
  // (verified against a freshly built real dash) blocks in read(0) on its
  // stdin fd exactly like `cat` would, so the EOF-delivery path under test
  // is identical.
  "maincat.cjs":
    '(()=>{const cp=require("child_process");const c=cp.spawn("/bin/sh",["-c",\'read -r line; echo "$line"\']);' +
    'let o="";c.stdout.on("data",d=>o+=d);c.on("close",(code)=>console.log("CAT",JSON.stringify(o),code));' +
    'c.stdin.write("hello");c.stdin.end();})();',
  "mainexit.cjs":
    '(()=>{const cp=require("child_process");cp.spawn("/bin/sh",["-c","exit 3"]).on("exit",(code,sig)=>console.log("EXIT",code,sig));})();',
  // `sleep` is not staged either; a busy loop of shell builtins (`:`, `while`)
  // is a real long-running child that only a signal can terminate.
  "mainkill.cjs":
    '(()=>{const cp=require("child_process");const c=cp.spawn("/bin/sh",["-c","while :; do :; done"]);' +
    'c.on("exit",(code,sig)=>console.log("KILL",code,sig));setTimeout(()=>c.kill("SIGKILL"),100);})();',
  "maincwd.cjs":
    '(()=>{const cp=require("child_process");const c=cp.spawn("/bin/sh",["-c","pwd"],{cwd:"/tmp"});' +
    'let o="";c.stdout.on("data",d=>o+=d);c.on("close",()=>console.log("CWD",o.trim()));})();',
  // exec() must deliver FULL (non-truncated) stdout to its callback. Before
  // this fix exec/execFile invoked their callback on 'exit', which races the
  // async stdout/stderr drain the same way the raw 'exit'-vs-'close' fixtures
  // above do — a callback firing before the pipe-read promises settle would
  // see a truncated (or empty) `stdout` string. 5000 bytes (500x "0123456789")
  // is big enough that a truncation would be visible either as a short
  // length or a wrong tail slice.
  "mainexecbig.cjs":
    '(()=>{const cp=require("child_process");' +
    'cp.exec("i=0; while [ $i -lt 500 ]; do printf 0123456789; i=$((i+1)); done",' +
    '(err,stdout,stderr)=>{console.log("EXECBIG",err?String(err):"OK",stdout.length,stdout.slice(0,10),stdout.slice(-10));});})();',
  // exec() of a command that exits non-zero must yield an Error with `.code`
  // set to the real exit code (not report success). `code` alone (not
  // `code || signal`) is asserted here; the null-code/non-null-signal case
  // (killed by a signal) is covered by _runWithCallback's `code !== 0 ||
  // signal !== null` check, exercised indirectly by the kill() test above
  // proving `_spawn` reports signals correctly on 'close'.
  "mainexecfail.cjs":
    '(()=>{const cp=require("child_process");' +
    'cp.exec("exit 7",(err,stdout,stderr)=>{console.log("EXECFAIL",err&&err.code,err&&err.signal,typeof stdout,typeof stderr);});})();',
};

function stageFixtures(): string {
  const dir = mkdtempSync(join(tmpdir(), "child-process-guest-"));
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
  ensureDirRecursive(fs, "/tmp");
  for (const f of Object.keys(FIXTURES)) {
    const sub = dirname(f);
    if (sub !== ".") ensureDirRecursive(fs, `/app/${sub}`);
    writeVfsBinary(fs, `/app/${f}`, new Uint8Array(readFileSync(join(DIR, f))), 0o644);
  }
  return fs.saveImage();
}

// `tryResolveBinary` throws (rather than returning null) when a candidate
// tier has a policy-rejected artifact instead of a clean miss (e.g. a
// source-only-v1 package tree left as a plain file by an interrupted
// install transaction, instead of the expected symlink into an immutable
// generation store). That is a pre-existing local-provisioning wrinkle, not
// something these tests assert on, so fall through to a direct package
// output path exactly like `esm-probe-guest.test.ts`'s own node.wasm
// fallback already does for the same reason.
function safeResolve(relPath: string): string | null {
  try {
    return tryResolveBinary(relPath);
  } catch {
    return null;
  }
}

describe("spidermonkey-node child_process (real async spawn)", () => {
  const envNode = process.env.WASM_POSIX_ESM_PROBE_NODE;
  const nodeWasm =
    (envNode && existsSync(envNode))
      ? envNode
      : (safeResolve("programs/spidermonkey-node.wasm") ??
        (() => {
          const pkg = join(__dirname, "../../packages/registry/spidermonkey/bin/node.wasm");
          return existsSync(pkg) ? pkg : null;
        })());
  const dashWasm = safeResolve("programs/dash.wasm") ??
    (() => {
      const pkg = join(__dirname, "../../packages/registry/dash/bin/dash.wasm");
      return existsSync(pkg) ? pkg : null;
    })();
  const ready = nodeWasm != null && dashWasm != null;

  async function runOne(mainPath: string) {
    const img = await image();
    return runCentralizedProgram({
      programPath: nodeWasm!,
      argv: ["node", mainPath],
      rootfsImage: img,
      useDefaultRootfs: false,
      execPrograms: new Map([["/bin/sh", dashWasm!]]),
      timeout: 60_000,
    });
  }

  it.runIf(ready)("spawn: streams stdout+stderr, exit code, real pid", async () => {
    const r = await runOne("/app/mainspawn.cjs");
    // eslint-disable-next-line no-console
    console.log("SPAWN STDOUT:", JSON.stringify(r.stdout.trim()), "STDERR:", r.stderr.trim().split("\n").slice(-6).join(" | "));
    expect(r.stdout).toContain('SPAWN "out" "err" 0 null true');
  }, 90_000);

  it.runIf(ready)("spawn: stdin.write+end echoes through and the child EOF-exits (deadlock guard)", async () => {
    const r = await runOne("/app/maincat.cjs");
    // eslint-disable-next-line no-console
    console.log("CAT STDOUT:", JSON.stringify(r.stdout.trim()), "STDERR:", r.stderr.trim().split("\n").slice(-6).join(" | "));
    expect(r.stdout).toContain('CAT "hello\\n" 0');
  }, 90_000);

  it.runIf(ready)("spawn: non-zero exit code", async () => {
    const r = await runOne("/app/mainexit.cjs");
    // eslint-disable-next-line no-console
    console.log("EXIT STDOUT:", JSON.stringify(r.stdout.trim()), "STDERR:", r.stderr.trim().split("\n").slice(-6).join(" | "));
    expect(r.stdout).toContain("EXIT 3 null");
  }, 90_000);

  it.runIf(ready)("spawn: kill(SIGKILL) reports terminating signal", async () => {
    const r = await runOne("/app/mainkill.cjs");
    // eslint-disable-next-line no-console
    console.log("KILL STDOUT:", JSON.stringify(r.stdout.trim()), "STDERR:", r.stderr.trim().split("\n").slice(-6).join(" | "));
    expect(r.stdout).toContain("KILL null SIGKILL");
  }, 90_000);

  it.runIf(ready)("spawn: cwd option", async () => {
    const r = await runOne("/app/maincwd.cjs");
    // eslint-disable-next-line no-console
    console.log("CWD STDOUT:", JSON.stringify(r.stdout.trim()), "STDERR:", r.stderr.trim().split("\n").slice(-6).join(" | "));
    expect(r.stdout).toContain("CWD /tmp");
  }, 90_000);

  it.runIf(ready)("exec: callback gets the FULL stdout, not truncated by an 'exit'/'close' race", async () => {
    const r = await runOne("/app/mainexecbig.cjs");
    // eslint-disable-next-line no-console
    console.log("EXECBIG STDOUT:", JSON.stringify(r.stdout.trim()), "STDERR:", r.stderr.trim().split("\n").slice(-6).join(" | "));
    expect(r.stdout).toContain("EXECBIG OK 5000 0123456789 0123456789");
  }, 90_000);

  it.runIf(ready)("exec: non-zero exit yields an Error with .code, not a false success", async () => {
    const r = await runOne("/app/mainexecfail.cjs");
    // eslint-disable-next-line no-console
    console.log("EXECFAIL STDOUT:", JSON.stringify(r.stdout.trim()), "STDERR:", r.stderr.trim().split("\n").slice(-6).join(" | "));
    expect(r.stdout).toContain("EXECFAIL 7 null string string");
  }, 90_000);
});
