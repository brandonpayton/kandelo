# Async child_process for spidermonkey-node Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace node-compat's synchronous popen-only `child_process` with a real asynchronous subprocess model (streaming stdio, pid, exit/signal, kill) on a general POSIX primitive surface, so headless `claude -p` gets past the subprocess deadlock where a spawned `/bin/sh` blocks on `read(0)=EAGAIN` with no way to deliver stdin EOF.

**Architecture:** A new SpiderMonkey shell C seam (patch 0022) adds `posix_spawn`/`pipe`/async-fd read/write/close/`waitpid`/`kill` natives by generalizing patch 0012's `KandeloSocketWatch` promise+poll machinery from sockets to arbitrary fds and child reaping, and wires the currently-dead real-delay timer drain into the same job-queue loop. node-compat `bootstrap.js` is then rewritten to orchestrate a real streaming `ChildProcess` in pure JS on those primitives.

**Tech Stack:** C (SpiderMonkey shell `js/src/shell/js.cpp`, authored as a real-diff patch), JavaScript (node-compat `bootstrap.js` + `adapter.js`, baked into node.wasm), musl `posix_spawn`, Vitest in-kernel guest tests (`runCentralizedProgram`).

**Spec:** `docs/superpowers/specs/2026-09-07-async-child-process-design.md` (read it alongside this plan). Primitive map with exact anchors: `.superpowers/notes-phasek-primitives.md`.

## Global Constraints

- **ABI-neutral.** Uses ONLY existing kernel syscalls via libc from the node.wasm guest: `posix_spawn`, `pipe`/`pipe2`, `wait4`, `kill` (`Syscall::Kill = 35`, `crates/shared/src/lib.rs:471`), `read`/`write`, `chdir`. No new syscall number, no marshalling change, no `ABI_VERSION`/`abi/snapshot.json` bump. C changes are the SpiderMonkey shell layer + patch-0012 generalization; JS changes bake into node.wasm.
- **Faithful/holistic, no app-shaped compromises.** Real Node `ChildProcess` semantics. Genuine kernel boundaries — `detached`/`setsid`/`setpgroup`/`uid`/`gid` (`SpawnAttrs` flags parsed but behavior unimplemented, `crates/runtime-core/src/spawn.rs:219`) — are documented in `posix-status.md`, never faked or silently swallowed.
- **Fail loud.** `posix_spawn` failure (ENOENT/EACCES) → a real async `'error'` event / thrown error carrying `err.code`/errno (Node semantics), never a silent hang.
- **Reuse the proven pattern.** The async-fd + child-reap watches extend patch 0012's `KandeloSocketWatch`/`KandeloSocketDispatch` job-queue-integrated `poll(...,0)` list (`0012-...patch:1380-1546`, loop at `2072-2085`, export table at `2054-2061`). Do NOT invent a new event loop.
- **Author C patches via REAL diff.** Base = post-0021 source. Reconstruct it by applying the js.cpp-touching patches `0012,0013,0017,0018,0020,0021` (in order) to the pristine `js/src/shell/js.cpp` from a `source-inputs/primary-source` tree under `~/.cache/kandelo/source-only/.../` (the Phase I/J method), then edit + `diff -u` to regenerate. Never hand-author hunk headers. The new patch is `packages/registry/spidermonkey/patches/0022-kandelo-async-subprocess.patch`; verify it applies clean in the 0012..0022 chain.
- **Every new native MUST be delegated** through adapter.js's `_nodeNative` whitelist (`packages/registry/spidermonkey/node-compat/adapter.js:363-409`, e.g. `socketRead(fd,length){return native.socketRead(fd,length);}` at :407) — otherwise it is `undefined` to bootstrap.js.
- **Build guardrails.** node.wasm rebuild ≈ 35 min: targeted `scripts/dev-shell.sh ./run.sh build spidermonkey-node > /tmp/LOG 2>&1` ONLY (NEVER a full `local-build`); grep `error:`/`Error 2`/`check_spidermonkey_style`/`does not apply`/`Build complete`. `check_spidermonkey_style.py` include-order check runs in the misc make tier. NEVER return control to wait on a build — run it in the FOREGROUND or poll to completion in a foreground loop: `nohup … & while pgrep -f 'run.sh build spidermonkey-node' >/dev/null; do sleep 30; done; echo DONE`. In-kernel tests via `runCentralizedProgram`; the real-ELF `-p` acceptance uses the 420 MiB `SharedArrayBuffer` capacity trick.
- **Do NOT push** (the controller pushes after the phase per the user's standing directive; the implementer lands commits locally).

---

### Task 1: Native subprocess + async-fd seam (patch 0022) + timer drain

**Files:**
- Create: `packages/registry/spidermonkey/patches/0022-kandelo-async-subprocess.patch` (real diff vs `js/src/shell/js.cpp`)
- Modify: `packages/registry/spidermonkey/node-compat/adapter.js` (delegate new natives ~after line 409; wire timer drain — but the loop wiring is in C)
- Test: `host/test/subprocess-seam-guest.test.ts` (new; calls the seam directly)

**Interfaces:**
- Produces (all reached from JS via `globalThis.__kandeloNodeNative.<name>` and delegated in adapter's `_nodeNative`):
  - `__kandeloPipe() → [readFd:number, writeFd:number]` — both ends `O_NONBLOCK`.
  - `__kandeloSpawn(file:string, argv:string[], env:string[], actions:Array<{op:'dup2',from:number,to:number}|{op:'close',fd:number}|{op:'open',fd:number,path:string,flags:number,mode:number}|{op:'chdir',path:string}>, attrs:{flags?:number,pgroup?:number}) → pid:number` — throws `Error` with `.errno`/`.code` on `posix_spawn` failure.
  - `__kandeloFdRead(fd:number, maxBytes:number) → Promise<ArrayBuffer>` — resolves bytes; **empty ArrayBuffer means EOF**; rejects with errno on error.
  - `__kandeloFdWrite(fd:number, bytes:Uint8Array|ArrayBuffer) → Promise<number>` — resolves bytes written.
  - `__kandeloFdClose(fd:number) → void`.
  - `__kandeloWaitPid(pid:number) → Promise<{code:number|null, signal:string|null}>` — resolves when the child is reaped.
  - `__kandeloKill(pid:number, sig:number) → number` — 0 on success; throws errno (e.g. `ESRCH`) on failure.
- Consumes: nothing (Task 2 consumes all of the above).

- [ ] **Step 1: Reconstruct the post-0021 base `js.cpp` for real-diff authoring**

Find a pristine primary-source tree and apply the js.cpp-touching patches in order (Phase I/J method). Run:
```bash
cd /Users/brandon/conductor/workspaces/kandelo/louisville-v1
PRIST=$(ls -d ~/.cache/kandelo/source-only/*/compiled/programs/.spidermonkey-*/source-inputs/primary-source 2>/dev/null | head -1)
# locate js.cpp (may be under firefox-140.11.0/ or directly)
JS=$(find "$PRIST" -path '*js/src/shell/js.cpp' | head -1)
rm -rf /tmp/sp-base && mkdir -p /tmp/sp-base/b/js/src/shell && cp "$JS" /tmp/sp-base/b/js/src/shell/js.cpp
cd /tmp/sp-base/b
for p in 0012-kandelo-node-compat-shell-entry 0013-kandelo-join-shell-workers 0017-kandelo-default-explicit-resource-management 0018-kandelo-require-module 0020-kandelo-vm-context 0021-kandelo-zstd-decompress; do
  patch -p1 --no-backup-if-mismatch < /Users/brandon/conductor/workspaces/kandelo/louisville-v1/packages/registry/spidermonkey/patches/$p.patch >/tmp/sp-base/$p.log 2>&1
  echo "$p applied js.cpp=$(grep -c 'patching file .*js/src/shell/js.cpp' /tmp/sp-base/$p.log)"
done
cp js/src/shell/js.cpp /tmp/sp-base/base-post21.cpp
grep -c 'KandeloSocketDispatch\|DefineKandeloNodeNative\|KandeloNativeZstdDecompress' /tmp/sp-base/base-post21.cpp
```
Expected: each patch reports `js.cpp=1` (the js.cpp hunk applied; other-file hunks harmlessly fail), and the final grep shows the socket dispatch + node-native + zstd anchors present. `/tmp/sp-base/base-post21.cpp` is your authoritative base; `/tmp/sp-base/b/js/src/shell/js.cpp` is your working copy to edit.

- [ ] **Step 2: Write the failing seam test**

Create `host/test/subprocess-seam-guest.test.ts` mirroring the shape of `host/test/esm-probe-guest.test.ts` (temp-dir fixtures mounted at `/app`, `runCentralizedProgram` with `programPath = spidermonkey-node.wasm`, `argv = ["node","/app/mainX.cjs"]`). Stage `/bin/echo`-style output via a fixture that shells to a real staged program. Because a raw `echo` binary may not be present, use `/bin/sh` (staged via `execPrograms`, resolved from `tryResolveBinary("programs/sh.wasm")`) as the spawn target running `sh -c 'printf hi; exit 0'`. Fixture `mainseam.cjs`:
```js
(async()=>{try{
  const n=globalThis.__kandeloNodeNative;
  if(!n||typeof n.__kandeloSpawn!=='function'){console.log('SEAM no-native');return;}
  const [r,w]=n.__kandeloPipe();
  const pid=n.__kandeloSpawn('/bin/sh',['sh','-c','printf hi; exit 0'],
    Object.entries(process.env).map(([k,v])=>k+'='+v),
    [{op:'dup2',from:w,to:1},{op:'close',fd:r},{op:'close',fd:w}], {});
  n.__kandeloFdClose(w);
  let out='';
  for(;;){const ab=await n.__kandeloFdRead(r, 65536); if(ab.byteLength===0)break; out+=Buffer.from(ab).toString('utf8');}
  n.__kandeloFdClose(r);
  const st=await n.__kandeloWaitPid(pid);
  // real-delay timer must fire (dead-timer-drain fix):
  const t=await new Promise((res)=>setTimeout(()=>res('T'),50));
  console.log('SEAM',JSON.stringify(out),st.code,st.signal,t);
}catch(e){console.log('SEAMERR',(e&&e.message)||e);}})();
```
Assertion:
```ts
it.runIf(ready)("native subprocess seam: spawn+pipe+read+waitpid+timer", async () => {
  const r = await runOne("/app/mainseam.cjs");
  expect(r.stdout).toContain('SEAM "hi" 0 null T');
}, 90_000);
```
(The `runOne`/`ready`/staging helpers: copy the harness scaffolding from `esm-probe-guest.test.ts`; stage `/bin/sh` via `execPrograms: new Map([["/bin/sh", tryResolveBinary("programs/sh.wasm")!]])` and mount the fixture dir.)

- [ ] **Step 3: Run the test to verify it fails**

Run: `scripts/dev-shell.sh bash -c 'npx vitest run host/test/subprocess-seam-guest.test.ts'`
Expected: FAIL — the current node.wasm has no `__kandeloSpawn`, so the fixture prints `SEAM no-native` (or the assertion simply doesn't match). This confirms the test exercises the new seam.

- [ ] **Step 4: Add the C natives to the working `js.cpp` (mirror the socket seam)**

Edit `/tmp/sp-base/b/js/src/shell/js.cpp`. Study the existing `KandeloSocketWatch` machinery (`KandeloNativeSocketRead`/`Write`/`Close`, the `KandeloSocketWatch` struct + `gKandeloSocketWatches` list, `KandeloSocketDispatch`, `KandeloSocketHasWatches`) — these were added by patch 0012 and are in this base. Implement the new natives by generalizing that pattern:

- **Generalize the read/write watch to arbitrary fds.** The socket read/write watch already does `read(fd,…)`/`write(fd,…)` and links a watch on `EAGAIN`. Add `KandeloNativeFdRead(fd,max)`, `KandeloNativeFdWrite(fd,bytes)`, `KandeloNativeFdClose(fd)` that reuse the SAME watch struct/list and dispatch (either by calling the existing socket read/write internals with the given fd, or by adding a `WatchKind::Fd` alongside the socket kind). `KandeloNativeFdRead` MUST resolve with an **empty ArrayBuffer on `read()==0` (EOF)** rather than treating it as error.
- **`KandeloNativePipe()`**: `int fds[2]; pipe(fds); fcntl(fds[0],F_SETFL,O_NONBLOCK); fcntl(fds[1],F_SETFL,O_NONBLOCK);` return a JS `[fds[0],fds[1]]` array.
- **`KandeloNativeSpawn(file,argv,env,actions,attrs)`**: build a `posix_spawn_file_actions_t` via `posix_spawn_file_actions_init` then, per `actions` element, `posix_spawn_file_actions_adddup2(&fa,from,to)` / `addclose(&fa,fd)` / `addopen(&fa,fd,path,flags,mode)` / `addchdir_np(&fa,path)`; build a `posix_spawnattr_t` (set `POSIX_SPAWN_SETPGROUP`/pgroup from `attrs.flags`/`attrs.pgroup` if provided). Marshal `argv`/`env` JS arrays to `char* const[]` (NULL-terminated). `pid_t pid; int rc = posix_spawn(&pid,file,&fa,&at,argv,env);` destroy fa/at; if `rc!=0` `JS_ReportErrorUTF8(cx,"spawn %s: %s",file,strerror(rc))` and set an `.errno` — return false. Else return `pid`.
- **`KandeloNativeWaitPid(pid)`**: register a child-reap watch (add a `WatchKind::Child` node holding the pid + a `PersistentRootedObject promise`). In `KandeloSocketDispatch` (renamed conceptually to the general dispatch), for each child watch do `int status; pid_t r = waitpid(watch->pid, &status, WNOHANG);` — if `r==watch->pid`: resolve the promise with `{code: WIFEXITED(status)?WEXITSTATUS(status):null, signal: WIFSIGNALED(status)?<signal-name-string>:null}`, mark done; if `r==-1 && errno==ECHILD` resolve as already-reaped `{code:0,signal:null}`; else leave pending.
- **`KandeloNativeKill(pid,sig)`**: `int rc = kill(pid,sig); if(rc!=0){report errno; return false;} return 0;`
- **Keep-alive:** extend `KandeloSocketHasWatches()` (or the loop's break condition at the patch-2072 site) so the loop stays alive while there is ANY pending fd/child watch (not only socket watches).
- **Timer drain (dead-timer fix):** in the same job-queue poll loop body (the patched loop near original js.cpp ~1415), each pass call the JS global `__kandeloRunDueTimers` and factor `__kandeloNextTimerDelay` into the keep-alive + idle backoff. Implement by resolving the globals from the global object and calling them: e.g. get `globalThis.__kandeloRunDueTimers` (a `JSFunction`) and `JS_CallFunctionValue` it once per pass; treat a non-null `__kandeloNextTimerDelay()` as "work pending" for keep-alive and clamp the `usleep` to at most that delay. (These globals are defined in adapter.js:262-263.)
- **Register** every new native in the `DefineKandeloNodeNative` `funcs[]` array (where `__kandeloZstdDecompress` etc. are registered): `JS_FN("__kandeloPipe",KandeloNativePipe,0,0)`, `JS_FN("__kandeloSpawn",KandeloNativeSpawn,5,0)`, `JS_FN("__kandeloFdRead",KandeloNativeFdRead,2,0)`, `JS_FN("__kandeloFdWrite",KandeloNativeFdWrite,2,0)`, `JS_FN("__kandeloFdClose",KandeloNativeFdClose,1,0)`, `JS_FN("__kandeloWaitPid",KandeloNativeWaitPid,1,0)`, `JS_FN("__kandeloKill",KandeloNativeKill,2,0)`.
- Add `#include <spawn.h>` and `#include <sys/wait.h>` in the system-include group (mirror the `<zstd.h>` include-order placement from patch 0021 to satisfy `check_spidermonkey_style.py`).

- [ ] **Step 5: Regenerate patch 0022 as a real diff and install it**

```bash
cd /tmp/sp-base
diff -u base-post21.cpp b/js/src/shell/js.cpp > raw.diff
{ echo "--- a/js/src/shell/js.cpp"; echo "+++ b/js/src/shell/js.cpp"; sed '1,2d' raw.diff; } \
  > /Users/brandon/conductor/workspaces/kandelo/louisville-v1/packages/registry/spidermonkey/patches/0022-kandelo-async-subprocess.patch
# validate it applies to a fresh post-21 base:
rm -rf v && mkdir -p v/js/src/shell && cp base-post21.cpp v/js/src/shell/js.cpp
( cd v && patch -p1 --dry-run < /Users/brandon/conductor/workspaces/kandelo/louisville-v1/packages/registry/spidermonkey/patches/0022-kandelo-async-subprocess.patch )
```
Expected: `patching file 'js/src/shell/js.cpp'` with NO "hunks failed".

- [ ] **Step 6: Delegate the new natives through adapter.js**

In `packages/registry/spidermonkey/node-compat/adapter.js`, after the `socketClose` delegate (line 409), add (mirroring the `socketRead` style):
```js
        __kandeloPipe() { return native.__kandeloPipe(); },
        __kandeloSpawn(file, argv, env, actions, attrs) { return native.__kandeloSpawn(file, argv, env, actions, attrs); },
        __kandeloFdRead(fd, max) { return native.__kandeloFdRead(fd, max); },
        __kandeloFdWrite(fd, bytes) { return native.__kandeloFdWrite(fd, bytes); },
        __kandeloFdClose(fd) { return native.__kandeloFdClose(fd); },
        __kandeloWaitPid(pid) { return native.__kandeloWaitPid(pid); },
        __kandeloKill(pid, sig) { return native.__kandeloKill(pid, sig); },
```
(The seam test accesses `globalThis.__kandeloNodeNative` directly, but Task 2's bootstrap.js reads `_nodeNative`, so the delegation is required now.)

- [ ] **Step 7: Rebuild node.wasm (ONE targeted build, foreground/polled)**

Run:
```bash
cd /Users/brandon/conductor/workspaces/kandelo/louisville-v1
nohup scripts/dev-shell.sh ./run.sh build spidermonkey-node > /tmp/phasek-build1.log 2>&1 &
while pgrep -f 'run.sh build spidermonkey-node' >/dev/null 2>&1; do sleep 30; done; echo DONE
grep -nE 'error:|Error 2|check_spidermonkey_style|does not apply|Build complete' /tmp/phasek-build1.log | tail
```
Expected: `[OK] Build complete` and `check_spidermonkey_style.py | ok`; no `error:`/`does not apply`. Debug the log and re-run if it fails; a failing build is not "done".

- [ ] **Step 8: Run the seam test to verify it passes**

Run: `scripts/dev-shell.sh bash -c 'npx vitest run host/test/subprocess-seam-guest.test.ts'`
Expected: PASS — `SEAM "hi" 0 null T` (spawn ran `/bin/sh`, stdout captured over a pipe, child reaped with code 0, and the 50 ms `setTimeout` fired = timer-drain works).

- [ ] **Step 9: Commit**

```bash
git add packages/registry/spidermonkey/patches/0022-kandelo-async-subprocess.patch \
        packages/registry/spidermonkey/node-compat/adapter.js \
        host/test/subprocess-seam-guest.test.ts
git commit -m "$(cat <<'EOF'
Host: Native async subprocess + fd seam on spidermonkey-node (M2 Phase K)

## Why

node-compat had no real subprocess primitives — only synchronous popen.
The Claude Code agent loop needs to spawn tools with streaming stdio,
deliver stdin EOF, learn exit codes, and kill children. This adds the
POSIX seam those require, and fixes real-delay timers (which were dead).

## What changed

SpiderMonkey shell patch 0022 adds __kandeloSpawn (posix_spawn with
dup2/close/open/chdir file-actions), __kandeloPipe, async
__kandeloFdRead/Write/Close, __kandeloWaitPid (WNOHANG reap), and
__kandeloKill, by generalizing patch 0012's socket watch-list + job-queue
poll loop to arbitrary fds and child reaping. Wires the previously-dead
__kandeloRunDueTimers into that loop so real-delay setTimeout fires.
All natives delegated through adapter.js. ABI-neutral (existing syscalls).
Guest seam test proves spawn+pipe+read+reap+timer.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: node-compat `child_process` rewrite + `-p` acceptance

**Files:**
- Modify: `packages/registry/node-compat/bootstrap.js` (child_process module 2712-2823; keep sync path on popen)
- Modify: `docs/posix-status.md`
- Test: `host/test/child-process-guest.test.ts` (new)

**Interfaces:**
- Consumes (from Task 1, via `_nodeNative`): `__kandeloPipe`, `__kandeloSpawn`, `__kandeloFdRead`, `__kandeloFdWrite`, `__kandeloFdClose`, `__kandeloWaitPid`, `__kandeloKill` (signatures in Task 1's Produces).
- Produces: a real `child_process.spawn(command, args?, options?) → ChildProcess` (EventEmitter with `pid`, `stdin`/`stdout`/`stderr` streams, `'exit'(code,signal)`, `'close'`, `'error'`, `kill(sig?)`); `exec`/`execFile` layered on it. `spawnSync`/`execSync`/`execFileSync` unchanged (popen).

- [ ] **Step 1: Write the failing child_process tests**

Create `host/test/child-process-guest.test.ts` (harness scaffolding copied from `esm-probe-guest.test.ts`; stage `/bin/sh` via `execPrograms`). Fixtures + cases:
```js
// FIXTURES:
"mainspawn.cjs":
  '(()=>{const cp=require("child_process");const c=cp.spawn("/bin/sh",["-c","printf out; printf err 1>&2; exit 0"]);' +
  'let o="",e="";c.stdout.on("data",d=>o+=d);c.stderr.on("data",d=>e+=d);' +
  'c.on("exit",(code,sig)=>console.log("SPAWN",JSON.stringify(o),JSON.stringify(e),code,sig,c.pid>0));})();',
"maincat.cjs":  // THE deadlock regression guard: stdin.write+end -> child echoes + EOF-exits
  '(()=>{const cp=require("child_process");const c=cp.spawn("/bin/sh",["-c","cat"]);' +
  'let o="";c.stdout.on("data",d=>o+=d);c.on("exit",(code)=>console.log("CAT",JSON.stringify(o),code));' +
  'c.stdin.write("hello");c.stdin.end();})();',
"mainexit.cjs":
  '(()=>{const cp=require("child_process");cp.spawn("/bin/sh",["-c","exit 3"]).on("exit",(code,sig)=>console.log("EXIT",code,sig));})();',
"mainkill.cjs":
  '(()=>{const cp=require("child_process");const c=cp.spawn("/bin/sh",["-c","sleep 30"]);' +
  'c.on("exit",(code,sig)=>console.log("KILL",code,sig));setTimeout(()=>c.kill("SIGKILL"),100);})();',
"maincwd.cjs":
  '(()=>{const cp=require("child_process");const c=cp.spawn("/bin/sh",["-c","pwd"],{cwd:"/tmp"});' +
  'let o="";c.stdout.on("data",d=>o+=d);c.on("exit",()=>console.log("CWD",o.trim()));})();',
```
Cases (assert exact stdout):
```ts
it.runIf(ready)("spawn: streams stdout+stderr, exit code, real pid", async () => {
  expect((await runOne("/app/mainspawn.cjs")).stdout).toContain('SPAWN "out" "err" 0 null true');
}, 90_000);
it.runIf(ready)("spawn: stdin.write+end echoes through cat and the child EOF-exits (deadlock guard)", async () => {
  expect((await runOne("/app/maincat.cjs")).stdout).toContain('CAT "hello" 0');
}, 90_000);
it.runIf(ready)("spawn: non-zero exit code", async () => {
  expect((await runOne("/app/mainexit.cjs")).stdout).toContain('EXIT 3 null');
}, 90_000);
it.runIf(ready)("spawn: kill(SIGKILL) reports terminating signal", async () => {
  expect((await runOne("/app/mainkill.cjs")).stdout).toContain('KILL null SIGKILL');
}, 90_000);
it.runIf(ready)("spawn: cwd option", async () => {
  expect((await runOne("/app/maincwd.cjs")).stdout).toContain('CWD /tmp');
}, 90_000);
```

- [ ] **Step 2: Run to verify it fails**

Run: `scripts/dev-shell.sh bash -c 'npx vitest run host/test/child-process-guest.test.ts'`
Expected: FAIL — today's `spawn` runs synchronously via popen: `mainspawn` gets empty stderr and `c.pid>0` is false (`pid:0`); `maincat` hangs/echoes nothing (stdin goes nowhere); `mainkill` never exits. (Note: with the current build these may hang to the test timeout — that failure still confirms the gap.)

- [ ] **Step 3: Rewrite the async `child_process` on the primitives**

In `packages/registry/node-compat/bootstrap.js`, inside the `child_process` IIFE (2712-2813), replace `exec`/`execFile`/`spawn` (keep `execSync`/`execFileSync`/`spawnSync` as-is) with a real implementation. Add a helper that builds the pipe/action plan and returns a real ChildProcess:
```js
const _nn = _nodeNative;
function _spawn(command, args, options) {
    // Node signature: spawn(cmd, [args], [options]) — args may be omitted and
    // options passed in its place. Extract options BEFORE normalizing args.
    if (args && !Array.isArray(args)) { options = args; args = []; }
    args = Array.isArray(args) ? args : [];
    options = options || {};
    let file = command, argv;
    if (options.shell) { file = '/bin/sh'; argv = ['/bin/sh', '-c', [command].concat(args).join(' ')]; }
    else { argv = [command].concat(args); }
    const env = options.env
        ? Object.keys(options.env).map(k => k + '=' + options.env[k])
        : Object.keys(process.env).map(k => k + '=' + process.env[k]);

    // Normalize stdio to a 3-entry array of 'pipe'|'ignore'|'inherit'|<int fd>.
    let stdio = options.stdio;
    if (stdio === 'inherit' || stdio === 'ignore' || stdio === 'pipe') stdio = [stdio, stdio, stdio];
    if (!Array.isArray(stdio)) stdio = ['pipe', 'pipe', 'pipe'];
    while (stdio.length < 3) stdio.push('pipe');

    const actions = [];
    const parentClose = [];         // fds to close in the parent after spawn
    const legs = [null, null, null]; // parent-side fd per stdio index (for 'pipe')
    for (let i = 0; i < 3; i++) {
        const s = stdio[i];
        if (s === 'pipe') {
            const [r, w] = _nn.__kandeloPipe();
            // fd 0: child reads r, parent writes w. fds 1/2: child writes w, parent reads r.
            const childEnd = (i === 0) ? r : w;
            const parentEnd = (i === 0) ? w : r;
            legs[i] = parentEnd;
            actions.push({ op: 'dup2', from: childEnd, to: i });
            actions.push({ op: 'close', fd: r });
            actions.push({ op: 'close', fd: w });
            parentClose.push(childEnd);
        } else if (s === 'ignore') {
            actions.push({ op: 'open', fd: i, path: '/dev/null', flags: (i === 0 ? 0 : 1), mode: 0 });
        } else if (s === 'inherit') {
            actions.push({ op: 'dup2', from: i, to: i });
        } else if (typeof s === 'number') {
            actions.push({ op: 'dup2', from: s, to: i });
        }
    }
    if (options.cwd) actions.push({ op: 'chdir', path: String(options.cwd) });

    const child = new events.EventEmitter();
    child.stdin = null; child.stdout = null; child.stderr = null; child.pid = 0;

    let pid;
    try { pid = _nn.__kandeloSpawn(file, argv, env, actions, {}); }
    catch (err) {
        // Node: spawn error is delivered asynchronously as an 'error' event.
        queueMicrotask(() => child.emit('error', err));
        // still provide stream objects so consumers don't crash
        child.stdin = new stream.Writable({ write(c, e, cb) { cb(); } });
        child.stdout = new stream.Readable({ read() {} }); child.stdout.push(null);
        child.stderr = new stream.Readable({ read() {} }); child.stderr.push(null);
        return child;
    }
    child.pid = pid;
    for (const fd of parentClose) { try { _nn.__kandeloFdClose(fd); } catch (_) {} }

    // stdin (fd 0 pipe): Writable -> fdWrite; end -> fdClose delivers EOF.
    if (legs[0] != null) {
        const wfd = legs[0];
        child.stdin = new stream.Writable({
            write(chunk, enc, cb) {
                const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, enc);
                _nn.__kandeloFdWrite(wfd, buf).then(() => cb(null), cb);
            },
            final(cb) { try { _nn.__kandeloFdClose(wfd); } catch (_) {} cb(); },
        });
    } else { child.stdin = null; }

    // stdout/stderr: Readable pumped by an fdRead loop; empty ArrayBuffer = EOF.
    // 'close' fires once, after the process has exited AND every opened
    // stdout/stderr read stream has reached its terminal state. openReads is
    // incremented once per opened read stream and decremented exactly once
    // (in that stream's EOF or error branch); _maybeClose is the single gate.
    let openReads = 0, exited = false, exitInfo = null;
    function _maybeClose() { if (exited && openReads === 0) child.emit('close', exitInfo.code, exitInfo.signal); }
    function _pumpReadable(fd) {
        const rs = new stream.Readable({ read() {} });
        openReads++;
        let counted = false;
        const finish = () => { try { _nn.__kandeloFdClose(fd); } catch (_) {} if (!counted) { counted = true; openReads--; _maybeClose(); } };
        (function loop() {
            _nn.__kandeloFdRead(fd, 65536).then((ab) => {
                if (ab.byteLength === 0) { rs.push(null); finish(); return; }
                rs.push(Buffer.from(ab)); loop();
            }, (err) => { rs.destroy(err); finish(); });
        })();
        return rs;
    }
    child.stdout = legs[1] != null ? _pumpReadable(legs[1]) : null;
    child.stderr = legs[2] != null ? _pumpReadable(legs[2]) : null;

    _nn.__kandeloWaitPid(pid).then((st) => {
        exited = true; exitInfo = st;
        child.emit('exit', st.code, st.signal);
        _maybeClose();
    });

    child.kill = function (sig) {
        const signum = typeof sig === 'number' ? sig : (nodeOs.constants.signals[sig || 'SIGTERM'] | 0);
        try { _nn.__kandeloKill(pid, signum || 15); return true; } catch (_) { return false; }
    };
    return child;
}
```
Then wire `spawn = _spawn;` and rewrite `exec`/`execFile` to collect the child's stdout/stderr and call back on `'exit'`/`'error'`:
```js
function exec(command, options, cb) {
    if (typeof options === 'function') { cb = options; options = {}; }
    const child = _spawn(command, [], { ...(options || {}), shell: true });
    let out = '', err = '';
    if (child.stdout) child.stdout.on('data', d => out += d);
    if (child.stderr) child.stderr.on('data', d => err += d);
    child.on('error', e => cb && cb(e, out, err));
    child.on('exit', (code) => cb && cb(code ? Object.assign(new Error('Command failed: ' + command), { code }) : null, out, err));
    return child;
}
function execFile(file, args, options, cb) {
    if (typeof args === 'function') { cb = args; args = []; options = {}; }
    else if (typeof options === 'function') { cb = options; options = {}; }
    const child = _spawn(file, args || [], options || {});
    let out = '', err = '';
    if (child.stdout) child.stdout.on('data', d => out += d);
    if (child.stderr) child.stderr.on('data', d => err += d);
    child.on('error', e => cb && cb(e, out, err));
    child.on('exit', (code) => cb && cb(code ? Object.assign(new Error('Command failed: ' + file), { code }) : null, out, err));
    return child;
}
```
**Implementer note:** transcribe the code above as-is; the `openReads`/`_maybeClose`/`finish` mechanism is complete (each read stream decrements `openReads` exactly once via the `counted` guard, and `'close'` fires once after `exited && openReads === 0`). Preserve the existing `stream`, `events`, `nodeOs`, and `_nodeNative` references already in bootstrap.js scope; do not rename them.

- [ ] **Step 4: Rebuild node.wasm (ONE targeted build, foreground/polled)**

Run:
```bash
nohup scripts/dev-shell.sh ./run.sh build spidermonkey-node > /tmp/phasek-build2.log 2>&1 &
while pgrep -f 'run.sh build spidermonkey-node' >/dev/null 2>&1; do sleep 30; done; echo DONE
grep -nE 'error:|check_spidermonkey_style|Build complete' /tmp/phasek-build2.log | tail
```
Expected: `[OK] Build complete`, style ok.

- [ ] **Step 5: Run the child_process tests + the full esm-probe suite**

Run:
```bash
scripts/dev-shell.sh bash -c 'npx vitest run host/test/child-process-guest.test.ts host/test/esm-probe-guest.test.ts --testTimeout=300000'
```
Expected: PASS — `SPAWN "out" "err" 0 null true`, `CAT "hello" 0` (stdin EOF delivered → cat exits), `EXIT 3 null`, `KILL null SIGKILL`, `CWD /tmp`; and all Phase A–J esm-probe cases green (one may flake on its inline 90 s timeout under load — re-run once to confirm load, not regression).

- [ ] **Step 6: Throwaway `claude -p` acceptance + capture the Phase L seed**

Create a throwaway `host/test/phasel-p-probe.test.ts` (model on the deleted Phase J/K probes / `host/test/claude-run-native-guest.test.ts`): argv `["node","/usr/lib/kandelo/bun-run.js","/usr/bin/claude","-p","say hi"]`, env adds `ANTHROPIC_API_KEY=sk-ant-dummy-not-a-real-key`, `enableTcpNetwork:true`, 420 MiB `SharedArrayBuffer` capacity rootfs, `execPrograms` staging `/usr/bin/claude`→`CLAUDE_BUN_ELF`, `/usr/bin/bun-extract`→extract wasm, `/usr/lib/kandelo/bun-run.js`, `/bin/sh`→sh wasm. Assert the output does NOT contain the old hang signature and that init advances; print the stderr tail.

Run: `scripts/dev-shell.sh bash -c 'CLAUDE_BUN_ELF=/tmp/cc-inspect/lx259/package/claude npx vitest run host/test/phasel-p-probe.test.ts --testTimeout=320000'`
Expected: the subprocess `read(0)=EAGAIN` deadlock is gone; `-p` advances past the shell-out. Read the stderr tail, record the NEXT `-p` blocker verbatim as the **Phase L seed** (in the SDD ledger + the `run-claude-code-in-kandelo` memory), then delete the probe: `rm host/test/phasel-p-probe.test.ts`.

- [ ] **Step 7: Update `docs/posix-status.md`**

Add/expand a row documenting async `child_process`: `spawn`/`exec`/`execFile` are real async subprocesses with streaming `stdin`/`stdout`/`stderr`, real `pid`, `'exit'(code,signal)`/`'close'`, `child.kill(sig)`, `cwd`, and the full `stdio` matrix — over `posix_spawn` + async pipe fds. Document the boundaries: `detached`/`setsid`/`setpgroup` and `uid`/`gid` are `posix_spawnattr` flags the kernel parses but does not implement (`runtime-core/src/spawn.rs:219`) — the child spawns but gets no new session/pgroup/id (a tracked runtime-core gap); `spawnSync`/`execSync`/`execFileSync` remain synchronous `popen`-based (a follow-up); real-delay `setTimeout`/`setInterval` now fire (previously the drain had no caller).

- [ ] **Step 8: Commit**

```bash
git add packages/registry/node-compat/bootstrap.js docs/posix-status.md host/test/child-process-guest.test.ts
git commit -m "$(cat <<'EOF'
Host: Real async child_process on spidermonkey-node (M2 Phase K)

## Why

Headless claude -p deadlocked: node-compat's child_process ran every
command through synchronous popen (pid:0, no stdin, no streaming), so a
spawned shell blocked on read(0)=EAGAIN with no way to deliver stdin EOF.

## What changed

Rewrote child_process spawn/exec/execFile on the Task-1 POSIX seam:
a real streaming ChildProcess (async stdin/stdout/stderr, real pid,
'exit'(code,signal)/'close'/'error', kill(), full stdio matrix, cwd,
shell). child.stdin.end() closes the write pipe -> sticky EOF, which
dissolves the -p deadlock. spawnSync/execSync stay popen-based (follow-up).
Guest tests cover streaming, the stdin-EOF regression, exit codes, kill,
and cwd. Boundaries (detached/uid/gid) documented in posix-status.md.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Notes for the executor

- **Two 35-min rebuilds** (one per task) is intentional: it verifies the C primitive layer (Task 1) in isolation before the JS layer (Task 2) depends on it — the highest-risk C is proven by a direct-seam test first. Do not merge the tasks to save a build; the isolation is the point.
- **Never return control to wait on a build.** Poll it in the foreground (`while pgrep …; do sleep 30; done`). A background build does not re-wake a subagent.
- **Do NOT push** — the controller handles the push after the phase.
