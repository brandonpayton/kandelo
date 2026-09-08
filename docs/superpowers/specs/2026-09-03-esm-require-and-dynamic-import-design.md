# ESM via `require()` and dynamic `import()` on spidermonkey-node (Milestone 2 Phase B) — Design

**Status:** Approved design; implementation not started
**Date:** 2026-09-03

## Why

After Phase A (builtin-export completeness), Claude Code's module graph
instantiates on spidermonkey-node, but headless `claude -p` now dies at:

```
SyntaxError: import declarations may only appear at top level of a module
  (chunk-e6a5hsbm.js:12)   [surfaced as an unhandled rejection]
```

A dynamic `import()` of a lazily-loaded ESM `.js` chunk is being compiled
as a classic **script**, so its top-level `import` is illegal.

Investigation (read-only, evidence in the SDD notes) found the real cause:
SpiderMonkey's native shell ModuleLoader compiles **every** fetched
JavaScript as an ES **module**, unconditionally (`ModuleLoader.cpp`
`loadAndParse` → `JS::CompileModule`, no extension/`package.json` check).
The **only** place a `.js` is compiled as a classic script
(`JS::Evaluate`) is node-compat `require`'s CJS wrapper
(`bootstrap.js` ~4529-4544, via `0012`'s `evalScriptAsFunction`). So an
ESM chunk fails **only when it is diverted into `require`**. Two seams do
that diversion:

1. The `0015` bare-specifier hook: a dynamic `import("chunk-XXXX.js")`
   whose specifier is not `/`, `./`, `../` is treated as *bare* →
   `__kandeloResolveBare` → `_makeRequire(base)(specifier)` → CJS wrap →
   script → `SyntaxError`. (Absolute/relative specifiers return early and
   go native → module → fine; that's why static `.js` imports work.)
2. `require()` / `import.meta.require` / `__breq` directly — node-compat
   `require` has no ESM detection; it CJS-wraps any non-`.json` file.

Fixing (1) unblocks `-p` today. Fixing (2) — synchronous `require()` of an
ESM module — is included now because ESM-only npm packages will force it
imminently (a `require("some-esm-pkg")` from bundled code hits the same
CJS-wrap-an-ESM failure). Both are node-compat/module-loader interop, the
same family as patches `0015`/`0016`.

## Root cause, precisely

- Native loader = always a module, dedups by normalized path in a native
  per-path registry (`ModuleLoader.cpp` `lookupModuleInRegistry` /
  `addModuleToRegistry`).
- node-compat `require` = always a classic script (CJS wrapper), with its
  own cache (`_moduleCache`) and no ESM detection.
- ESM `.js` chunks reach `require` (not the native loader) via the bare
  hook and via `import.meta.require`, and fail.

## Goals / non-goals

**Goals:**
- Dynamic `import()` (and static `import`) of an ESM target (`.mjs`, or a
  `.js` whose nearest `package.json` is `"type":"module"`) loads as an ES
  **module**, whatever the specifier shape (absolute/relative/bare).
- `require()` (hence `import.meta.require` / `__breq`) of an ESM module
  loads it **synchronously** as a module and returns its namespace.
- All three routes (static import, dynamic import, require) of the same
  resolved path share **one** module instance via the native registry.
- `require()` of an ESM module whose graph has unsettled top-level await
  throws a Node-compatible `ERR_REQUIRE_ASYNC_MODULE` (honest boundary).

**Non-goals:**
- Making `claude -p` complete a query (later — TLS egress, CSPRNG, tool
  subprocesses; this phase only gets module loading correct).
- Changing the native loader's own compile policy (it already compiles
  modules correctly; no shell change is needed for the *import* path).
- Full faithful `require(esm)` interop beyond returning the namespace with
  `.default` (Node semantics); no `__esModule` heuristics.

## Design

### Part 1 — bare-hook ESM routing (bootstrap.js only; fixes the `-p` blocker)

In `__kandeloResolveBare` (`bootstrap.js`, the `0015` hook), after
resolving a non-builtin bare specifier to a file path `resolvedPath`:
- **If ESM** (`resolvedPath` ends with `.mjs`, or
  `_nearestPackageType(resolvedPath) === 'module'`): **return
  `resolvedPath`** as the resolve result, so the native loader reads and
  `CompileModule`s the file and registers it in the per-path registry.
  This makes static/dynamic `import` of bare ESM specifiers (ESM npm
  packages and the failing `.js` chunk) load as modules, dedup-safe.
- **Else (CJS):** unchanged — the existing `require` + synthetic-namespace
  path.

`_nearestPackageType` already exists (`bootstrap.js` ~4572). No C change.

### Part 2 — synchronous `require()` of ESM (new C seam + bootstrap change)

**New C seam (patch `0018-kandelo-require-module.patch`)**:
`_nodeNative.__kandeloRequireModule(pathString)` (exposed the same way
`0012` exposes `evalScriptAsFunction`). It:
1. Resolves/loads the module at `pathString` **through the shell
   ModuleLoader's existing load path** (compile-as-module + register in the
   per-path registry, reusing `loadAndParse`/`loadAndExecute`), so it
   shares the identical registry entry any `import` of that path uses.
2. `JS::ModuleInstantiate` (link) then `JS::ModuleEvaluate`. Evaluate
   returns the top-level completion promise.
3. Inspect it (`JS::GetPromiseState`):
   - **Fulfilled** → `JS::GetModuleNamespace` → return the namespace.
   - **Pending** (unsettled top-level await) → throw an `Error` with
     `.code = "ERR_REQUIRE_ASYNC_MODULE"` and a clear message.
   - **Rejected** → rethrow the rejection value.
4. Compile/link errors propagate as thrown exceptions.

**`require` change (`bootstrap.js` ~4508-4544)**: after strip-shebang and
the `.json` check, before the CJS wrapper:
```
if (resolved.endsWith('.mjs') || _nearestPackageType(resolved) === 'module') {
    const ns = _nodeNative.__kandeloRequireModule(resolved);
    _moduleCache[resolved] = { exports: ns };   // cache the namespace ref
    return ns;
}
```
Return value = the module **namespace** (named exports as properties,
default as `.default`) — Node's `require(esm)` semantics. The real instance
lives in the native registry; `_moduleCache` only caches the returned
reference so repeat `require` is cheap and identity-stable. Because
`import.meta.require` and `__breq` are `_makeRequire(...)`, they inherit
this automatically.

### Shared: ESM detection + dedup
- ESM detection is the single predicate `endsWith('.mjs') ||
  _nearestPackageType(path) === 'module'`, used by both parts.
- Dedup: every route funnels the same resolved path through the **native
  per-path registry**, so there is exactly one compiled+evaluated instance
  regardless of how it was first loaded. No second CJS/synthetic copy of an
  ESM module is ever created.

## Testing (kept — extends `host/test/esm-probe-guest.test.ts`)

In-process fixtures + in-kernel run, matching the existing pattern:
1. **`require()` of an ESM `.js`** (in a `type:module` dir) returns its
   named + default exports (e.g. `require("/app/e.js").y === 43`,
   `.default` present).
2. **Dynamic `import()` of a bare ESM `.js`** (the current blocker) —
   `import("chunk.js")`-style bare specifier resolves + runs as a module
   (no `SyntaxError`).
3. **`require()` of an ESM module with top-level await** throws
   `ERR_REQUIRE_ASYNC_MODULE` (assert the `.code`/message).
4. **Dedup / single instance**: a module that mutates a module-level
   counter, loaded once via static `import` and once via `require` (same
   resolved path), is the **same instance** (counter shared) — proving the
   native registry, not a second copy.
5. Regression: the Phase A/0015/0016/0017 esm-probe cases still pass.

## Rebuild & acceptance (Phase-C seed)
One `node.wasm` rebuild after the edits. Acceptance:
- the new esm-probe cases green (+ no regression), and
- a throwaway `claude -p` re-run (isolated config, dummy key,
  `enableTcpNetwork`) gets **past** the dynamic-`import()` `SyntaxError`;
  report the new first blocker verbatim as the next (Phase C) seed.

Record the `require(esm)` support and the `ERR_REQUIRE_ASYNC_MODULE`
boundary in `docs/posix-status.md`.

## Risks

- **Sync-evaluating an ESM graph in `require`.** Works only when the whole
  graph is synchronously resolvable and TLA-free. TLA is handled (throw);
  but a dep that itself needs async resolution (e.g. a bare dep the resolve
  hook can't satisfy synchronously) would surface as a link/evaluate error
  — acceptable (thrown), and discovered by the acceptance run.
- **Double-instantiation** if any route bypasses the native registry. The
  design forbids that; the dedup test (case 4) guards it.
- **Namespace interop.** A CJS consumer expecting `require()` to return a
  callable/default directly gets the namespace instead (with `.default`).
  This matches Node; if a specific consumer breaks, it's a discovered,
  bounded follow-up, not a silent wrong result.
- **Shell-loader reuse from C.** The seam must drive the *same* loader
  instance/registry the import path uses (not a fresh compile) — the
  implementer confirms the wiring (as `0015`/`0016` did) before landing.
- **Rebuild cost / cross-worktree cache** — same as prior phases; batch
  edits into one rebuild.
