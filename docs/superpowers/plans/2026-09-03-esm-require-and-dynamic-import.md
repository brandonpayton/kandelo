# ESM via require() and dynamic import() (Milestone 2 Phase B) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make spidermonkey-node load ESM targets as native modules through both the dynamic `import()`/bare-hook path and a new synchronous `require()`-of-ESM capability, deduping all routes through the native per-path module registry.

**Architecture:** Part 1 (Task 1) fixes the `0015` bare-specifier hook in `bootstrap.js` to return the real resolved path for ESM targets (so the native loader compiles them as modules) — this unblocks headless `claude -p`. Part 2 (Task 2) adds a new SpiderMonkey shell C seam (`patch 0018`) `_nodeNative.__kandeloRequireModule(path)` that compiles/links/evaluates a module synchronously via the native loader+registry and returns its namespace (throwing `ERR_REQUIRE_ASYNC_MODULE` on top-level await), plus a `bootstrap.js` `require()` change that detects ESM and uses it.

**Tech Stack:** JavaScript (node-compat/bootstrap.js), C++ SpiderMonkey shell patch (ESR-140), Vitest + in-kernel `runCentralizedProgram`.

**Spec:** `docs/superpowers/specs/2026-09-03-esm-require-and-dynamic-import-design.md`

## Global Constraints

- **ESM detection is one predicate** used everywhere: `p.endsWith('.mjs') || _nearestPackageType(p) === 'module'`. `_nearestPackageType` already exists in `bootstrap.js` (~line 4572).
- **Dedup through the native registry.** Every route (static import, dynamic import, require) of the same resolved path must funnel through SpiderMonkey's native per-path module registry — one compiled+evaluated instance. Never create a second CJS/synthetic copy of an ESM module.
- **`require(esm)` returns the module namespace** (named exports as properties, default as `.default`) — Node semantics. Top-level await in a required graph → throw `Error` with `.code = "ERR_REQUIRE_ASYNC_MODULE"`. CJS targets keep the existing `require`/synthetic-namespace path unchanged.
- **Build/test under the dev shell.** Rebuild the runtime with `scripts/dev-shell.sh ./run.sh build spidermonkey-node` — RUN IN FOREGROUND and WAIT (incremental after a bootstrap.js change ~minutes; a C-patch change may be longer). Run tests: `scripts/dev-shell.sh bash -c 'cd host && npx vitest run test/<file>'`.
- **Foundation present:** patches `0015`/`0016`/`0017` and node-compat (`bootstrap.js`) are committed and in the current `programs/spidermonkey-node.wasm`. The new C seam follows `0012-...patch`'s `evalScriptAsFunction` (`_nodeNative` binding via `KandeloNativeEvalScriptAsFunction`) and `0015`'s `ModuleLoader.cpp` access pattern. The SpiderMonkey source is on disk (`find ~/.cache/kandelo -type d -name "firefox-140.11.0" | head -1`).
- **Two rebuilds (one per implementation task)** — Part 1 and Part 2 are separately reviewable; do NOT rebuild per edit within a task.
- The real Claude ELF for the Task 1 acceptance is at `/tmp/cc-inspect/lx259/package/claude` (`CLAUDE_BUN_ELF`).

---

### Task 1: Bare-hook ESM routing (fixes the `-p` blocker) + acceptance

Make `__kandeloResolveBare` return the real resolved path for ESM targets, so a static/dynamic `import` of a bare ESM specifier goes through the native module loader instead of `require`'s CJS wrapper. Verify with a kept test, then confirm on the real ELF that `claude -p` gets past the dynamic-`import()` `SyntaxError` and report the next (Phase C) seed.

**Files:**
- Modify: `packages/registry/node-compat/bootstrap.js` (`__kandeloResolveBare`, ~lines 4816-4844)
- Test: `host/test/esm-probe-guest.test.ts` (add one case + fixtures)
- Throwaway: `host/test/zz-probe-claude-p.test.ts` (delete before finishing)

**Interfaces:**
- Consumes: existing `__kandeloResolveBare` (the `0015` hook), its resolution of a non-builtin bare specifier to an absolute file path (via `_resolveFile`/`_makeRequire`), and `_nearestPackageType(path)`.
- Produces: a dynamic/static `import` of a bare specifier that resolves to an ESM file (`.mjs`, or `.js` under a `type:module` dir) is compiled as a native ES module (dedup-safe), not CJS-wrapped.

- [ ] **Step 1: Write the failing test** — add to `host/test/esm-probe-guest.test.ts`. Extend the `FIXTURES` map with a bare ESM package whose entry has its OWN top-level import (reproducing the chunk that failed at "import declarations may only appear at top level of a module"), and add a case:

```ts
// add to FIXTURES:
"dep.mjs": "export const v=41;",
"node_modules/epkg/package.json": '{"type":"module","main":"index.js"}',
"node_modules/epkg/index.js": 'import{v}from"/app/dep.mjs";export const w=v+1;export default "epkgdefault";',
"maindyn.cjs":
  '(async()=>{try{const m=await import("epkg");console.log("DYN",m.w,m.default);}catch(e){console.log("DYNERR",(e&&e.message)||e);}})();',
```

`stageFixtures()` already writes every `FIXTURES` key to the temp dir, but the `node_modules/epkg/...` keys have a subdir — ensure `stageFixtures()` and `image()` create parent dirs (use `mkdirSync(dirname(p),{recursive:true})` before `writeFileSync`, and `ensureDirRecursive(fs, "/app/"+dirname(name))` before `writeVfsBinary`). Then:

```ts
it.runIf(ready)("dynamic import() of a bare ESM package loads as a module", async () => {
  const img = await image();
  const r = await runCentralizedProgram({
    programPath: nodeWasm!, argv: ["node", "/app/maindyn.cjs"],
    rootfsImage: img, useDefaultRootfs: false, timeout: 60_000,
  });
  // eslint-disable-next-line no-console
  console.log("DYN OUT:", JSON.stringify(r.stdout.trim()), "ERR:", r.stderr.trim().split("\n").slice(-6).join(" | "));
  expect(r.stdout).toContain("DYN 42 epkgdefault");
  expect(r.stdout).not.toContain("DYNERR");
}, 90_000);
```

- [ ] **Step 2: Run test to verify it fails (RED)**

Run: `scripts/dev-shell.sh bash -c 'cd host && npx vitest run test/esm-probe-guest.test.ts'`
Expected: FAIL — `DYNERR ... import declarations may only appear at top level of a module` (the bare ESM package is CJS-wrapped by `require`), no `DYN 42 epkgdefault`.

- [ ] **Step 3: Implement the bare-hook ESM check**

In `bootstrap.js` `__kandeloResolveBare`, find where a non-builtin bare specifier is resolved to a file path and currently routed to `require` (the `obj = _makeRequire(base)(specifier)` / synthetic-namespace path, ~4834). Compute the resolved absolute path first (the function already resolves it — reuse that variable; if it resolves lazily inside `_makeRequire`, resolve it explicitly via the same `_resolveFile(specifier, base)` the require path uses). Then, before the CJS/synthetic path:

```js
// ESM target: hand the real path to the native loader so it CompileModules
// the file (dedup-safe via the native per-path registry) instead of
// CJS-wrapping it as a classic script.
if (resolvedPath && (resolvedPath.endsWith('.mjs') || _nearestPackageType(resolvedPath) === 'module')) {
    return resolvedPath;
}
```

Returning an absolute path from the resolve hook makes the native ModuleLoader read + `CompileModule` the file (absolute paths are handled natively — confirmed in `ModuleLoader.cpp`). Leave the CJS/synthetic-namespace path for non-ESM (CJS) targets unchanged. Match the actual variable name the function uses for the resolved path.

- [ ] **Step 4: Rebuild `node.wasm`**

Run: `scripts/dev-shell.sh ./run.sh build spidermonkey-node` (foreground, wait). Expected: success.

- [ ] **Step 5: Run the test (GREEN) + esm-probe regression**

Run: `scripts/dev-shell.sh bash -c 'cd host && npx vitest run test/esm-probe-guest.test.ts'`
Expected: the new case PASSES (`DYN 42 epkgdefault`, no `DYNERR`); all prior esm-probe cases still pass.

- [ ] **Step 6: Commit**

```bash
git add packages/registry/node-compat/bootstrap.js host/test/esm-probe-guest.test.ts
git commit -m "Host: Load bare ESM specifiers as native modules in spidermonkey-node (dynamic import fix)"
```

- [ ] **Step 7: Throwaway `-p` acceptance + Phase C seed**

Create `host/test/zz-probe-claude-p.test.ts` mirroring the staging in `host/test/claude-run-native-guest.test.ts` (real ELF at `/usr/bin/claude`, `bun-extract.wasm` at `/usr/bin/bun-extract`, `runtime/bun-run/bun-run.js` at `/usr/lib/kandelo/bun-run.js`, `programs/sh.wasm` at `/bin/sh`, `cap = 512*1024*1024`), gate on `CLAUDE_BUN_ELF` + `existsSync`, argv `["node","/usr/lib/kandelo/bun-run.js","/usr/bin/claude","-p","Reply with the single word: hi"]`, env `["HOME=/root","CLAUDE_CONFIG_DIR=/root/.claude","PATH=/usr/bin:/bin","TERM=dumb","CI=1","ANTHROPIC_API_KEY=sk-ant-probe-dummy-not-a-real-key","DISABLE_AUTOUPDATER=1","DISABLE_TELEMETRY=1","DISABLE_ERROR_REPORTING=1","CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1"]`, `enableTcpNetwork: true`, `timeout: 220_000`; assert nothing, `console.log` exit + stdout + last ~120 stderr lines.

Run: `CLAUDE_BUN_ELF=/tmp/cc-inspect/lx259/package/claude scripts/dev-shell.sh bash -c 'cd host && npx vitest run test/zz-probe-claude-p.test.ts'`
Expected: the `import declarations may only appear at top level of a module` error is GONE. Capture the NEW first blocker verbatim (a called stub, a runtime/network error, or another loader edge) as the **Phase C seed**. If instead a *different* `doesn't provide an export named` or `import declarations` link error appears, note it in the report (it may need a Part-1 tweak or fold into Task 2). Then delete the probe:

```bash
rm host/test/zz-probe-claude-p.test.ts
```

Put the Phase C seed in the task report. No commit for the throwaway.

---

### Task 2: Synchronous `require()` of ESM (C seam `0018` + `require` change)

Add the native `__kandeloRequireModule(path)` seam and make node-compat `require` use it for ESM targets, so `require()`/`import.meta.require`/`__breq` of an ESM module loads it synchronously via the native loader+registry and returns its namespace.

**Files:**
- Create: `packages/registry/spidermonkey/patches/0018-kandelo-require-module.patch`
- Modify: `packages/registry/node-compat/bootstrap.js` (the `require` loader, ~lines 4508-4544)
- Modify: `docs/posix-status.md` (record `require(esm)` support + the `ERR_REQUIRE_ASYNC_MODULE` boundary)
- Test: `host/test/esm-probe-guest.test.ts` (add 3 cases)

**Interfaces:**
- Consumes: the shell `ModuleLoader` load/link/evaluate + per-path registry (`loadAndParse`/`loadAndExecute`, `JS::ModuleInstantiate`, `JS::ModuleEvaluate`, `JS::GetModuleNamespace`, `JS::GetPromiseState`); the `_nodeNative` binding mechanism from `0012` (`KandeloNativeEvalScriptAsFunction`); `bootstrap.js`'s `require` loader, `_moduleCache`, `_nearestPackageType`.
- Produces: `_nodeNative.__kandeloRequireModule(pathString)` → the module namespace, or throws (`ERR_REQUIRE_ASYNC_MODULE` on pending TLA, or the rejection/compile error). `require(esmPath)` returns that namespace and caches it in `_moduleCache`.

- [ ] **Step 1: Investigate the shell loader wiring**

Run and read:
```bash
SN=$(find ~/.cache/kandelo -type d -name "firefox-140.11.0" | head -1)
grep -nE "loadAndExecute|loadAndParse|ModuleEvaluate|ModuleInstantiate|ModuleLink|GetModuleNamespace|GetPromiseState|lookupModuleInRegistry|dynamicImport" "$SN/js/src/shell/ModuleLoader.cpp" | head -40
grep -nE "KandeloNativeEvalScriptAsFunction|evalScriptAsFunction|_nodeNative|JS_DefineFunction|JS_DefineProperty" packages/registry/spidermonkey/patches/0012-*.patch
sed -n '/mod = JS::CompileModule/,/addModuleToRegistry/p' "$SN/js/src/shell/ModuleLoader.cpp" | head -60
```
Confirm: how a `ModuleLoader` instance is reached from the shell context (as `0015`/`0016` do); how `loadAndExecute`/`loadAndParse` register in and dedup via the registry; that `JS::ModuleEvaluate` returns a top-level Promise; and how `0012` registers a `_nodeNative` C function. Record the exact call sequence you will use in your report.

- [ ] **Step 2: Write the failing tests** — add to `host/test/esm-probe-guest.test.ts`:

```ts
// FIXTURES additions:
"e.js": 'export const y=43;export default "edefault";',                 // dir has package.json type:module (the test writes one)
"maincjs.cjs": '(()=>{try{const m=require("/app/e.js");console.log("REQ",m.y,m.default);}catch(e){console.log("REQERR",(e&&e.message)||e);}})();',
"tla.js": 'export const z=await Promise.resolve(7);',
"maintla.cjs": '(()=>{try{require("/app/tla.js");console.log("TLA no throw");}catch(e){console.log("TLACODE",e&&e.code,(e&&e.message)||e);}})();',
"counter.js": 'let n=0;export function inc(){return ++n;}',
"maindedup.cjs": '(async()=>{try{const a=require("/app/counter.js");const b=await import("/app/counter.js");console.log("DEDUP",a.inc(),b.inc(),a===b);}catch(e){console.log("DEDUPERR",(e&&e.message)||e);}})();',
```
The staging must put a `package.json {"type":"module"}` at `/app/package.json` (already implied for the `.js` fixtures to be ESM) so `e.js`/`tla.js`/`counter.js` are ESM. Add three cases:

```ts
it.runIf(ready)("require() of an ESM .js returns its namespace", async () => {
  const r = await runOne("/app/maincjs.cjs");
  expect(r.stdout).toContain("REQ 43 edefault");
}, 90_000);
it.runIf(ready)("require() of an ESM module with top-level await throws ERR_REQUIRE_ASYNC_MODULE", async () => {
  const r = await runOne("/app/maintla.cjs");
  expect(r.stdout).toContain("TLACODE ERR_REQUIRE_ASYNC_MODULE");
}, 90_000);
it.runIf(ready)("require() and import() of the same path share one instance", async () => {
  const r = await runOne("/app/maindedup.cjs");
  expect(r.stdout).toContain("DEDUP 1 2 true");   // shared counter + identical namespace
}, 90_000);
```
Factor a small `runOne(mainPath)` helper (build `image()`, `runCentralizedProgram` with that argv) if not already present.

- [ ] **Step 3: Run tests to verify they fail (RED)**

Run: `scripts/dev-shell.sh bash -c 'cd host && npx vitest run test/esm-probe-guest.test.ts'`
Expected: FAIL — `REQERR ... import declarations may only appear at top level of a module` (require CJS-wraps the ESM `.js`); the TLA and dedup cases likewise fail (require path).

- [ ] **Step 4: Implement the C seam (`patch 0018`)**

Create `packages/registry/spidermonkey/patches/0018-kandelo-require-module.patch` adding a shell C function `__kandeloRequireModule(pathString)`, registered on the same `_nodeNative` object `0012` uses. Using the call sequence confirmed in Step 1, it must:
1. Reach the shell `ModuleLoader` instance and load the module at the given absolute path **through the existing native load path** (`loadAndParse`/`loadAndExecute` — so it hits and dedups in the per-path registry), producing a linked module.
2. `JS::ModuleEvaluate(cx, module, &evalPromise)`.
3. Inspect `evalPromise` with `JS::GetPromiseState`:
   - `Fulfilled` → `JS::GetModuleNamespace(cx, module)` → set the return value to the namespace.
   - `Pending` → build an `Error`, set its `code` property to the string `"ERR_REQUIRE_ASYNC_MODULE"` and a message like `require() of ES Module <path> with top-level await is not supported`, and throw it (report `false`/pending to the caller).
   - `Rejected` → get the rejection reason (`JS::GetPromiseResult`) and throw it.
4. Any compile/link failure propagates as a thrown exception.

Keep the patch minimal and in the `0015`/`0016` C-seam style (no new includes if the existing ones suffice); it must apply cleanly after `0015`/`0016`/`0017` (lexical `*.patch` order — `0018` sorts last).

- [ ] **Step 5: Implement the `require` change + posix-status note**

In `bootstrap.js`'s `require` loader (after strip-shebang and the `.json` check, before the CJS wrapper ~4508-4544):

```js
if (resolved.endsWith('.mjs') || _nearestPackageType(resolved) === 'module') {
    const ns = _nodeNative.__kandeloRequireModule(resolved);
    _moduleCache[resolved] = { exports: ns };
    return ns;
}
```
(Place it so a cache hit for `resolved` still returns early as today; the ESM branch runs on a cache miss.) Add a `docs/posix-status.md` entry: `require()`/`import.meta.require` of an ES module is supported (loads via the native module registry, returns the namespace); a required ES module with top-level await throws `ERR_REQUIRE_ASYNC_MODULE`.

- [ ] **Step 6: Rebuild `node.wasm`**

Run: `scripts/dev-shell.sh ./run.sh build spidermonkey-node` (foreground, wait). Expected: success (the C patch applies + compiles).

- [ ] **Step 7: Run tests (GREEN) + regression**

Run: `scripts/dev-shell.sh bash -c 'cd host && npx vitest run test/esm-probe-guest.test.ts'`
Expected: `REQ 43 edefault`, `TLACODE ERR_REQUIRE_ASYNC_MODULE`, `DEDUP 1 2 true`, and all prior cases (incl. Task 1's `DYN 42 epkgdefault`) still pass.

- [ ] **Step 8: Commit**

```bash
git add packages/registry/spidermonkey/patches/0018-kandelo-require-module.patch packages/registry/node-compat/bootstrap.js docs/posix-status.md host/test/esm-probe-guest.test.ts
git commit -m "Host: Synchronous require() of ES modules on spidermonkey-node (native load + dedup, ERR_REQUIRE_ASYNC_MODULE on TLA)"
```

---

## Notes for the executor

- Task 1 lands the actual `-p` blocker fix (bootstrap-only) and reports the Phase C seed; Task 2 adds sync `require(esm)` (proactive for ESM npm packages), unit-tested (it may not be exercised by `-p` yet).
- The `dedup` case (Task 2) is the correctness crux: `a === b` and the shared counter prove `require` and `import` collapse onto one native registry instance. If it fails, the C seam is loading outside the native registry — fix that before anything else.
- Variable names in the bootstrap snippets (`resolvedPath`, `resolved`, `_moduleCache`, `_nearestPackageType`, `_nodeNative`) are indicative — match `bootstrap.js` actuals.
- Phase C (whatever Task 1's `-p` acceptance reports) is out of scope.
