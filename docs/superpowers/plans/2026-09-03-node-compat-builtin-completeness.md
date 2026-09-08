# Node-compat Builtin-Export Completeness (Milestone 2 Phase A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Claude Code's 1819-module ESM graph instantiate on spidermonkey-node by providing the 40 builtin named-exports it statically imports (real where trivial, honest throwing/no-op stubs where hard), entirely in node-compat JS.

**Architecture:** Add the missing keys to each builtin's module object in `packages/registry/node-compat/bootstrap.js` (the 0015 bridge derives ESM namespaces from `Object.keys(require(m))`, so a new key becomes importable with no patch change). Register two missing submodules (`path/posix`, `dns/promises`). One `node.wasm` rebuild. A kept in-kernel link-surface test guards the whole set; a throwaway `claude -p` re-run confirms the app now links and seeds Phase B.

**Tech Stack:** JavaScript (node-compat/bootstrap.js), SpiderMonkey/ESR-140 wasm build, Vitest + in-kernel `runCentralizedProgram` harness.

**Spec:** `docs/superpowers/specs/2026-09-03-node-compat-builtin-completeness-design.md`

## Global Constraints

- **node-compat JS only.** All changes live in `packages/registry/node-compat/bootstrap.js` (+ the two test files + `docs/posix-status.md`). NO kernel syscalls, NO new SpiderMonkey patches, NO `crates/`/`abi/` changes.
- **Policy:** real where trivial (alias / wrapper over an existing primitive / small pure JS / constant); **throwing stub** otherwise — `throw new Error("<module>.<name> is not implemented on spidermonkey-node")` (honest, never silent). Two exceptions are **no-op stubs** (return a benign object/value, do not throw) where the API is called for its return value during init: `perf_hooks.monitorEventLoopDelay` and the class stubs `net.BlockList` / `crypto.X509Certificate` (constructable, methods throw). If a "real" export needs a primitive that isn't reachable in pure JS, downgrade it to a throwing stub.
- **Truthful failure:** stubs throw a clear named error; they are recorded in `docs/posix-status.md`.
- **Build/test under the dev shell:** `scripts/dev-shell.sh`. Rebuild the runtime with `scripts/dev-shell.sh ./run.sh build spidermonkey-node` (incremental after a bootstrap.js change — minutes; run it in the FOREGROUND and wait, do not park on it). Run tests with `scripts/dev-shell.sh bash -c 'cd host && npx vitest run test/<file>'`.
- **Rebuild is the expensive step — batch it.** All 40 edits land before the single rebuild in Task 1. Do not rebuild per export.
- **Foundation present:** the bun-run pipeline + patches 0015/0016/0017 are committed and in the current `node.wasm`; `programs/{spidermonkey-node,bun-extract}.wasm` and the kernel are built; `host/` deps installed. The real Claude ELF is at `/tmp/cc-inspect/lx259/package/claude` (Task 2, gated on `CLAUDE_BUN_ELF`).
- **Cross-worktree cache:** `~/.cache/kandelo/programs` is shared; a concurrent build in another worktree can cause a transient failure — rebuild locally and re-run if seen.

---

### Task 1: Add the 40 builtin exports + link-surface guard + rebuild

Add every missing export to `bootstrap.js`, write the kept link-surface test, document the stubs, rebuild `node.wasm` once, and verify the test is green (plus the esm-probe regression guard still green).

**Files:**
- Modify: `packages/registry/node-compat/bootstrap.js` (add keys to the `fs`, `fs/promises`, `os`, `crypto`, `zlib`, `tls`, `util`, `util/types`, `net`, `events`, `url`, `perf_hooks`, `child_process`, `dns` module objects; register submodules `path/posix`, `dns/promises`)
- Modify: `docs/posix-status.md` (record the throwing stubs as tracked gaps)
- Test: `host/test/node-compat-builtin-exports.test.ts` (create)

**Interfaces:**
- Consumes: existing node-compat internals in `bootstrap.js` — the per-builtin module objects and helpers (`require`, `util`/`os`/`path`/`fs`/`dns`/`events`/`zlib` module objects, `util.promisify`, `Buffer`, and the builtin-name→module registry). The 0015 bridge (`__kandeloResolveBare`) and its `Object.keys(require(m))` namespace generation are already in place.
- Produces: `require("fs/promises").link` etc. exist (40 exports); `require("path/posix")` and `require("dns/promises")` resolve. Task 2 relies on the app being able to link against these.

- [ ] **Step 1: Write the failing link-surface test**

Create `host/test/node-compat-builtin-exports.test.ts`. It stages, in-process (self-contained, per the esm-probe pattern), a fixture that named-imports the exact 40-name surface plus a small main that dynamically imports it (native loader), and asserts it LINKS + spot-checks reals + a stub throws:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails (RED)**

Run: `scripts/dev-shell.sh bash -c 'cd host && npx vitest run test/node-compat-builtin-exports.test.ts'`
Expected: FAIL — `LINKERR ... doesn't provide an export named 'fsyncSync'` (or another of the 40); no `LINKED40`. (The current `node.wasm` lacks the exports.)

- [ ] **Step 3: Add a stub helper + the real/no-op/stub exports in `bootstrap.js`**

Locate each builtin's module-definition object (grep, e.g. `grep -n "fsyncSync\|module.exports\|_builtinModules\|promises\b" packages/registry/node-compat/bootstrap.js`; the existing keys from the spec table — `unlinkSync`, `symlinkSync`, `deflateSync`, etc. — anchor where each module object is built). Add a shared stub helper once, near the other helpers:

```js
function _notImpl(mod, name) {
  return function () { throw new Error(mod + "." + name + " is not implemented on spidermonkey-node"); };
}
```

Then add these keys to their module objects. **Real** (concrete code):

```js
// os
os.availableParallelism = function () { try { return Math.max(1, (os.cpus && os.cpus().length) || 1); } catch (_) { return 1; } };
os.devNull = "/dev/null";
os.version = function () { return ""; };
os.getPriority = function () { return 0; };
os.setPriority = function () { /* no-op */ };

// util
util.stripVTControlCharacters = function (s) { return String(s).replace(/\x1b\[[0-9;]*[A-Za-z]/g, ""); };
util.getSystemErrorName = function (err) {
  var e = Math.abs(err | 0);
  try { var t = (os.constants && os.constants.errno) || {}; for (var k in t) if (Math.abs(t[k]) === e) return k; } catch (_) {}
  return "Unknown system error " + err;
};

// util/types
utilTypes.isProxy = function () { return false; };

// events
events.setMaxListeners = function (n) { for (var i = 1; i < arguments.length; i++) { var em = arguments[i]; if (em && typeof em.setMaxListeners === "function") em.setMaxListeners(n); } };

// url
url.domainToASCII = function (d) { return String(d); };

// crypto
crypto.timingSafeEqual = function (a, b) {
  a = Buffer.from(a); b = Buffer.from(b);
  if (a.length !== b.length) throw new RangeError("Input buffers must have the same byte length");
  var d = 0; for (var i = 0; i < a.length; i++) d |= a[i] ^ b[i]; return d === 0;
};

// zlib (async wrappers over existing *Sync)
zlib.deflate = function (buf, opts, cb) { if (typeof opts === "function") { cb = opts; opts = undefined; } try { var o = zlib.deflateSync(buf, opts); queueMicrotask(function () { cb(null, o); }); } catch (e) { queueMicrotask(function () { cb(e); }); } };
zlib.inflate = function (buf, opts, cb) { if (typeof opts === "function") { cb = opts; opts = undefined; } try { var o = zlib.inflateSync(buf, opts); queueMicrotask(function () { cb(null, o); }); } catch (e) { queueMicrotask(function () { cb(e); }); } };

// tls
tls.rootCertificates = [];
tls.checkServerIdentity = function () { return undefined; };

// fs/promises
fsPromises.constants = fs.constants;

// child_process — export a constructable class (used with instanceof/new); minimal EventEmitter subclass if node-compat has no internal one.
childProcess.ChildProcess = childProcess.ChildProcess || (function () { function ChildProcess() { events.EventEmitter.call(this); } ChildProcess.prototype = Object.create(events.EventEmitter.prototype); ChildProcess.prototype.constructor = ChildProcess; return ChildProcess; })();

// dns.promises + dns/promises submodule (same object)
var _dnsPromises = { lookup: util.promisify(dns.lookup) };
dns.promises = _dnsPromises;
```

`fs.fsyncSync`/`fs.ftruncateSync` — **real iff** a sync primitive is reachable (check for `os.fsync`/`os.ftruncate` or an existing fd-sync/truncate helper in `bootstrap.js`); otherwise stub:

```js
// If os.fsync / os.ftruncate exist (grep to confirm):
fs.fsyncSync = function (fd) { var e = os.fsync(fd); if (e) _throwErrno(e < 0 ? -e : e, "fsync"); };
fs.ftruncateSync = function (fd, len) { var e = os.ftruncate(fd, len || 0); if (e) _throwErrno(e < 0 ? -e : e, "ftruncate"); };
// else:
fs.fsyncSync = _notImpl("fs", "fsyncSync");
fs.ftruncateSync = _notImpl("fs", "ftruncateSync");
```

**No-op stubs** (return benign values; do NOT throw — called during init):

```js
perfHooks.monitorEventLoopDelay = function () { return { enable: function () {}, disable: function () {}, reset: function () {}, percentile: function () { return 0; }, get min() { return 0; }, get max() { return 0; }, get mean() { return 0; }, get stddev() { return 0; }, get exceeds() { return 0; } }; };
net.BlockList = net.BlockList || (function () { function BlockList() {} BlockList.prototype.addAddress = function () {}; BlockList.prototype.addRange = function () {}; BlockList.prototype.addSubnet = function () {}; BlockList.prototype.check = function () { return false; }; return BlockList; })();
crypto.X509Certificate = crypto.X509Certificate || (function () { function X509Certificate() { throw new Error("crypto.X509Certificate is not implemented on spidermonkey-node"); } return X509Certificate; })();
```

**Throwing stubs** (via `_notImpl`):

```js
fsPromises.link = _notImpl("fs/promises", "link");
fsPromises.lutimes = _notImpl("fs/promises", "lutimes");
fsPromises.opendir = _notImpl("fs/promises", "opendir");
fsPromises.statfs = _notImpl("fs/promises", "statfs");
crypto.randomFillSync = _notImpl("crypto", "randomFillSync");
crypto.createCipheriv = _notImpl("crypto", "createCipheriv");
crypto.createDecipheriv = _notImpl("crypto", "createDecipheriv");
crypto.createPrivateKey = _notImpl("crypto", "createPrivateKey");
crypto.createPublicKey = _notImpl("crypto", "createPublicKey");
crypto.generateKeyPairSync = _notImpl("crypto", "generateKeyPairSync");
crypto.sign = _notImpl("crypto", "sign");
crypto.verify = _notImpl("crypto", "verify");
zlib.inflateRawSync = _notImpl("zlib", "inflateRawSync");
zlib.createZstdDecompress = _notImpl("zlib", "createZstdDecompress");
tls.createSecureContext = _notImpl("tls", "createSecureContext");
```

Register the two submodules in the builtin-name→module registry (grep for where `"fs/promises"` / `"stream/promises"` / `_builtinModules` maps names to objects; add the same way):

```js
_builtinModules["path/posix"] = path.posix;
_builtinModules["dns/promises"] = _dnsPromises;
```

Use the ACTUAL variable names for each module object as they appear in `bootstrap.js` (they may be locals like `const fs = {...}` / a `promises` object / a `_builtinModules` table — the names above are indicative; match the file). Add each key next to that module's existing definition; do not restructure unrelated code.

- [ ] **Step 4: Record the stubs in `docs/posix-status.md`**

Add a short entry listing the throwing/class stubs shipped (crypto primitives, tls.createSecureContext, zlib zstd/inflateRaw, fs/promises link/lutimes/opendir/statfs, net.BlockList, crypto.X509Certificate, and — if applicable — fs.fsyncSync/ftruncateSync) as node-compat gaps that satisfy link-time and throw when called; note Phase B graduates whichever the app actually calls. Place it near the existing node-compat runtime-gap notes added during Milestone 1.

- [ ] **Step 5: Rebuild `node.wasm`**

Run: `scripts/dev-shell.sh ./run.sh build spidermonkey-node`
Wait for it to finish in the foreground. Expected: build succeeds.

- [ ] **Step 6: Run the link-surface test (GREEN) + esm-probe regression**

Run: `scripts/dev-shell.sh bash -c 'cd host && npx vitest run test/node-compat-builtin-exports.test.ts test/esm-probe-guest.test.ts'`
Expected: the new test PASSES (`LINKED40` + `SPOT a/b true x true true`, no `LINKERR`); esm-probe still 5/5 (no regression to 0015/0016/0017).

- [ ] **Step 7: Commit**

```bash
git add packages/registry/node-compat/bootstrap.js host/test/node-compat-builtin-exports.test.ts docs/posix-status.md
git commit -m "Host: Complete node-compat builtin exports for the Claude Code link surface"
```

---

### Task 2: Acceptance — Claude Code links; seed Phase B

Confirm, on Task 1's rebuilt `node.wasm`, that the real Claude ELF no longer dies at module linking, and report the new first blocker (the Phase B seed). Handle any second-order missing-export link errors the fuller graph reveals.

**Files:**
- (Possibly) Modify: `packages/registry/node-compat/bootstrap.js` — only if the `-p` re-run reveals *further* missing named exports (second-order link errors) not in the original 40.
- Test: a THROWAWAY probe (delete before finishing) — do not add a kept test here; `-p` fully working is Phase B.

**Interfaces:**
- Consumes: Task 1's completed exports + rebuilt `node.wasm`; the bun-run pipeline (`bun-run.js`, `bun-extract.wasm`, `sh.wasm`) staged as in `host/test/claude-run-native-guest.test.ts`.
- Produces: a documented acceptance result — the app links — and the verbatim new first blocker recorded as the Phase B seed (goes to the report + ledger, not committed code).

- [ ] **Step 1: Write a throwaway `-p` probe**

Create `host/test/zz-probe-claude-p.test.ts` (throwaway). Mirror the staging in `host/test/claude-run-native-guest.test.ts` (real ELF at `/usr/bin/claude`, `bun-extract.wasm` at `/usr/bin/bun-extract`, `runtime/bun-run/bun-run.js` at `/usr/lib/kandelo/bun-run.js`, `programs/sh.wasm` at `/bin/sh`; `cap = 512 * 1024 * 1024`), gate on `CLAUDE_BUN_ELF` (default `/tmp/cc-inspect/lx259/package/claude`) + `existsSync`, and run:

```ts
argv: ["node", "/usr/lib/kandelo/bun-run.js", "/usr/bin/claude", "-p", "Reply with the single word: hi"],
env: ["HOME=/root","CLAUDE_CONFIG_DIR=/root/.claude","PATH=/usr/bin:/bin","TERM=dumb","CI=1",
      "ANTHROPIC_API_KEY=sk-ant-probe-dummy-not-a-real-key","DISABLE_AUTOUPDATER=1",
      "DISABLE_TELEMETRY=1","DISABLE_ERROR_REPORTING=1","CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1"],
enableTcpNetwork: true,
timeout: 220_000,
```

Assert nothing; `console.log` the exit code + full stdout + last ~120 stderr lines.

- [ ] **Step 2: Run the probe and read the result**

Run: `CLAUDE_BUN_ELF=/tmp/cc-inspect/lx259/package/claude scripts/dev-shell.sh bash -c 'cd host && npx vitest run test/zz-probe-claude-p.test.ts'`
Expected: the previous `fs/promises 'link'` link error is GONE. One of two outcomes:
- (a) A *different* `doesn't provide an export named 'X'` link error → a second-order missing export. Add `X` (and any siblings) to `bootstrap.js` per the Task 1 policy, `scripts/dev-shell.sh ./run.sh build spidermonkey-node`, re-run the probe. Repeat until no link error remains. Add any such exports to the Task 1 test's SURFACE list too, and note them in the report. (If this loops more than ~2 rebuilds, report progress to the controller.)
- (b) A NON-link failure — a called stub throwing (`... is not implemented`), a runtime error (network/TLS, CSPRNG), or a hang/timeout at the network call. This is the Phase B seed — the app linked and started executing.

- [ ] **Step 3: Delete the throwaway probe**

```bash
rm host/test/zz-probe-claude-p.test.ts
```

- [ ] **Step 4: Report + commit any second-order exports**

Write the acceptance outcome and the verbatim Phase B seed into the task report. If Step 2 added second-order exports, commit them:

```bash
git add packages/registry/node-compat/bootstrap.js host/test/node-compat-builtin-exports.test.ts docs/posix-status.md
git commit -m "Host: node-compat exports — second-order link fixes for Claude Code -p"
```

If no code changed (clean case (b)), no commit — the deliverable is the reported Phase B seed.

---

## Notes for the executor

- Task 1 is large (40 exports) but is ONE deliverable because the exports can only be verified together after the single rebuild. Keep the commits as written.
- The variable names in Task 1 Step 3 (`fs`, `fsPromises`, `crypto`, `zlib`, `tls`, `util`, `utilTypes`, `net`, `events`, `url`, `perfHooks`, `childProcess`, `dns`, `_builtinModules`, `_throwErrno`, `path`) are indicative — match whatever `bootstrap.js` actually uses; if a module object is assembled and frozen, add the keys before it is frozen/returned.
- Phase B (making `-p` actually complete a query — TLS egress loop, CSPRNG, whichever stubs fire, tool subprocesses) is out of scope; Task 2 only seeds it.
