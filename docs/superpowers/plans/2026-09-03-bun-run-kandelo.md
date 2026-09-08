# bun-run (Run Bun Executables on Kandelo) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run Bun-compiled standalone executables (e.g. the Claude Code native binary) on Kandelo by extracting their embedded JS, caching it, and executing it natively on spidermonkey-node.

**Architecture:** A cache-aware extractor (`bun-extract --prepare`) hashes a binary's `__BUN` section, extracts the module tree once into a volatile cache with `/$bunfs/root/` specifiers remapped to the cache dir, and prints the cache dir + entry. A JS bootstrap (`bun-run.js`) run on spidermonkey-node invokes it, installs a thin `Bun` global shim, and `import()`s the cached entry in-process (native ESM). Enabling platform fixes teach spidermonkey-node's ESM loader to resolve bare specifiers, populate `import.meta`, and parse `using`.

**Tech Stack:** C (guest program, compiled via the SDK/clang to wasm32), JavaScript (node-compat runtime + bootstrap), SpiderMonkey/Firefox ESR 140 build (mozconfig), Vitest + `runCentralizedProgram` in-kernel test harness.

**Spec:** `docs/superpowers/specs/2026-09-03-bun-run-kandelo-design.md`

## Global Constraints

- **Ephemeral cache invariant:** extracted JS is reproducible from the binary and must NEVER be persisted. Cache root is a volatile tmpfs path `/var/cache/kandelo/bun-run/`. Any FS-persistence mechanism must exclude it; never present it as a durable image.
- **Truthful failure:** every gap is a visible boundary — unsupported format, extraction failure, unimplemented `Bun.*` member (named throw), genuinely-missing bare dep (real `MODULE_NOT_FOUND`). Never a silent no-op or faked success.
- **Host parity:** every spidermonkey-node runtime change (Tasks 3–5) must hold on both Node and browser hosts (host-runtime contract). Node-host in-kernel tests are the gate here; note browser validation as follow-up per task.
- **Build commands run under the dev shell:** prefix build/test with `scripts/dev-shell.sh`. Guest programs build via `scripts/build-programs.sh`; the runtime builds via `./run.sh build spidermonkey-node`. A `node.wasm` rebuild is ~long — Tasks 3–5 each rebuild; an executor iterating by hand MAY batch the Task 3+4+5 source edits into a single rebuild, but each task's test must still pass on its own.
- **Build state assumed present** (already provisioned in this worktree): both musl sysroots, `local-binaries/source-only-v1/kernel.wasm`, `local-binaries/programs/wasm32/bun-extract.wasm`, `programs/spidermonkey-node.wasm`, `host/` npm deps. If a fresh worktree, provision first (`scripts/build-musl.sh` + `--arch wasm64posix`, `./run.sh build kernel`, `scripts/build-programs.sh`, `./run.sh build spidermonkey-node`, `npm install` in root and `host/`).
- **Vitest run pattern:** `scripts/dev-shell.sh bash -c 'cd host && npx vitest run test/<file>'`.
- The real Claude ELF for the end-to-end task is not in the repo; that test is gated on `CLAUDE_BUN_ELF` and skips otherwise.

---

### Task 1: `bun-extract --prepare` — hash, cache, remap

Add a cache-aware mode to the existing extractor. `bun-extract --prepare <binary> <cache-root>` computes an FNV-1a-64 hash over the `__BUN`-section bytes (folded with the section length), uses `<cache-root>/<hash>/` as the cache dir, extracts there only on a miss with each module's `/$bunfs/root/` specifiers rewritten to `<cacheDir>/`, writes `manifest.json`, and prints `CACHE=<dir>` and `ENTRY=<abs entry path>`.

**Files:**
- Modify: `programs/bun-extract.c` (add `--prepare` arg handling, hashing, cache-dir logic, specifier remap-on-write, `CACHE=`/`ENTRY=` output)
- Test: `host/test/bun-extract-guest.test.ts` (add cache miss/hit + remap assertions)

**Interfaces:**
- Consumes: existing `find_graph`/module-table parse in `bun-extract.c`; the in-kernel harness `runCentralizedProgram` + `execPrograms` staging (already used by the existing test).
- Produces: CLI contract `bun-extract --prepare <binary> <cache-root>` → stdout lines `CACHE=<absdir>\nENTRY=<abspath>`; on-disk `<cacheDir>/<modules…>` with `/$bunfs/root/` rewritten to `<cacheDir>/`, and `<cacheDir>/manifest.json` = `{"entry":"<rel>","format":<int>}`. Consumed by `bun-run.js` (Task 2).

- [ ] **Step 1: Write the failing test** — extend `host/test/bun-extract-guest.test.ts`. Reuse the existing `buildFixture()` (3-module synthetic graph). Add:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `scripts/dev-shell.sh bash -c 'cd host && npx vitest run test/bun-extract-guest.test.ts'`
Expected: FAIL — `--prepare` unrecognized / no `CACHE=` output.

- [ ] **Step 3: Implement `--prepare` in `programs/bun-extract.c`**

Add near the top:

```c
/* FNV-1a-64 content hash. Content-addressing, not security. */
static uint64_t fnv1a64(const unsigned char *p, size_t n, uint64_t h) {
    for (size_t i = 0; i < n; i++) { h ^= p[i]; h *= 1099511628211ULL; }
    return h;
}
```

In `main`, before the existing positional parse, detect the mode:

```c
int prepare = 0;
const char *cache_root = NULL;
if (argc == 4 && strcmp(argv[1], "--prepare") == 0) {
    prepare = 1; exe = argv[2]; cache_root = argv[3];
} else if (argc == 3) {
    exe = argv[1]; /* outdir set below */
} else { fprintf(stderr, "usage: bun-extract <bun-exe> <out-dir> | bun-extract --prepare <bun-exe> <cache-root>\n"); return 2; }
```

After locating the graph (`findGraph`/`find_graph`) and computing `base`, in prepare mode hash the `__BUN`-section blob and derive the cache dir:

```c
/* Hash the module-graph blob region [base, base+byte_count) streaming in chunks. */
uint64_t h = 1469598103934665603ULL;      /* FNV offset basis */
{
    off_t at = base; off_t end = base + (off_t)byte_count;
    unsigned char hb[1 << 20];
    while (at < end) {
        size_t want = (size_t)((end - at) < (off_t)sizeof(hb) ? (end - at) : (off_t)sizeof(hb));
        if (pread_all(fd, hb, want, at) != 0) { fprintf(stderr, "hash read failed\n"); return 1; }
        h = fnv1a64(hb, want, h); at += (off_t)want;
    }
    h ^= byte_count;                       /* fold in section length */
}
char cachedir[8192];
snprintf(cachedir, sizeof(cachedir), "%s/%016llx", cache_root, (unsigned long long)h);
mkparents(cachedir); mkdir(cache_root, 0755); mkdir(cachedir, 0755);
```

Set `outdir = cachedir` for the write loop. In the module write loop, replace the raw `fwrite(cbuf,...)` for JS modules with a specifier remap: after decoding `body` into a NUL-terminated buffer, replace every occurrence of the literal `"/$bunfs/root/"` with `"<cachedir>/"` before writing. Implement a small in-place-to-new-buffer replace helper:

```c
/* Replace all occurrences of `from` with `to` in text; returns malloc'd result, sets *outlen. */
static char *replace_all(const char *text, size_t tlen, const char *from, const char *to, size_t *outlen) {
    size_t flen = strlen(from), tolen = strlen(to);
    size_t count = 0; const char *s = text;
    while ((s = memmem(s, (size_t)(text + tlen - s), from, flen))) { count++; s += flen; }
    size_t cap = tlen + count * (tolen > flen ? tolen - flen : 0) + 1;
    char *out = malloc(cap); size_t o = 0; s = text; const char *end = text + tlen;
    while (s < end) {
        const char *m = memmem(s, (size_t)(end - s), from, flen);
        if (!m) { memcpy(out + o, s, (size_t)(end - s)); o += (size_t)(end - s); break; }
        memcpy(out + o, s, (size_t)(m - s)); o += (size_t)(m - s);
        memcpy(out + o, to, tolen); o += tolen; s = m + flen;
    }
    *outlen = o; return out;
}
```

Apply remap only for JS modules (`loader`/name ends with `.js/.mjs/.cjs` or is the entry). For non-JS assets write raw. Write `manifest.json` in the cache dir: `{"entry":"<entry_rel>","format":<fmt>}`. Then in prepare mode print:

```c
printf("CACHE=%s\n", cachedir);
printf("ENTRY=%s/%s\n", cachedir, entry_rel);
/* self-check: reopen the entry, confirm remap applied (no /$bunfs/root/ left) */
{
    char ep[8192]; snprintf(ep, sizeof(ep), "%s/%s", cachedir, entry_rel);
    FILE *rf = fopen(ep, "rb");
    if (rf) { char buf[4096]; size_t n = fread(buf,1,sizeof(buf)-1,rf); buf[n]=0; fclose(rf);
        printf("REMAP_OK %s\n", strstr(buf, "/$bunfs/root/") ? "FAIL" : cachedir); }
}
```

Keep the existing non-`--prepare` behavior (write to `outdir`, no remap) unchanged so `bun-extract <bin> <dir>` and its tests still work.

- [ ] **Step 4: Rebuild the program and run the test**

Run: `scripts/dev-shell.sh scripts/build-programs.sh` then `scripts/dev-shell.sh bash -c 'cd host && npx vitest run test/bun-extract-guest.test.ts'`
Expected: PASS (both the original extraction test and the new prepare test).

- [ ] **Step 5: Commit**

```bash
git add programs/bun-extract.c host/test/bun-extract-guest.test.ts
git commit -m "Packages: Add bun-extract --prepare (hash + cache + specifier remap)"
```

---

### Task 2: `bun-run.js` bootstrap + `Bun` shim + entrypoint

The run orchestrator: a JS bootstrap that spawns `bun-extract --prepare`, installs a thin `Bun` global, sets `process.argv` to the app's view, and `import()`s the cached entry. Tested against a synthetic runnable Bun fixture whose app uses only path-specifier imports (so it does not depend on the Task 3–5 platform fixes) and reads `Bun.version` + argv.

**Files:**
- Create: `runtime/bun-run/bun-run.js` (bootstrap, staged into VFS at `/usr/lib/kandelo/bun-run.js` in tests)
- Create: `runtime/bun-run/README.md` (one paragraph: what it is, how it's invoked)
- Test: `host/test/bun-run-guest.test.ts`

**Interfaces:**
- Consumes: `bun-extract --prepare` stdout contract from Task 1 (`CACHE=`/`ENTRY=`); `programs/bun-extract.wasm`; spidermonkey-node's `child_process.spawnSync` and dynamic `import()`.
- Produces: `bun-run.js` invoked as `node /usr/lib/kandelo/bun-run.js <binary> [app args…]`; sets `globalThis.Bun` and `globalThis.__breq`, runs the app in-process. Consumed by the end-to-end task and (later) the `bun-run` entrypoint.

- [ ] **Step 1: Write the failing test** — `host/test/bun-run-guest.test.ts`. Build a synthetic Bun fixture whose entry uses a path-specifier import and prints `Bun` + argv. Reuse the fixture-builder shape from `bun-extract-guest.test.ts` but with this module set:

```ts
// entry "cli": imports a chunk (path specifier) and prints proof lines.
const mods: Array<[string, string]> = [
  ["/$bunfs/root/cli",
    'import{tag}from"/$bunfs/root/chunk-a.js";' +
    'console.log("BUNRUN tag="+tag+" ver="+(typeof Bun!=="undefined"?Bun.version:"NO")+" args="+process.argv.slice(2).join(","));'],
  ["/$bunfs/root/chunk-a.js", 'export const tag="ok";'],
];
```

The bootstrap and `bun-extract.wasm` are staged via `execPrograms`; the fixture binary is staged too. Run node with the bootstrap:

```ts
const r = await runCentralizedProgram({
  programPath: nodeWasm!,
  argv: ["node", "/usr/lib/kandelo/bun-run.js", "/prog.bun", "hello", "--flag"],
  env: ["PATH=/usr/bin:/bin", "HOME=/root"],
  execPrograms: new Map([
    ["/usr/lib/kandelo/bun-run.js", join(__dirname, "../../runtime/bun-run/bun-run.js")],
    ["/usr/bin/bun-extract", tryResolveBinary("programs/bun-extract.wasm")!],
    ["/prog.bun", fixture],
  ]),
  useDefaultRootfs: false,
  timeout: 60_000,
});
expect(r.stdout).toContain("BUNRUN tag=ok ver=");
expect(r.stdout).toContain("args=hello,--flag");
```

(Note: `execPrograms` stages `bun-extract.wasm` at `/usr/bin/bun-extract`; the bootstrap spawns it by that path.)

- [ ] **Step 2: Run test to verify it fails**

Run: `scripts/dev-shell.sh bash -c 'cd host && npx vitest run test/bun-run-guest.test.ts'`
Expected: FAIL — `runtime/bun-run/bun-run.js` does not exist.

- [ ] **Step 3: Implement `runtime/bun-run/bun-run.js`**

```js
"use strict";
// Kandelo bun-run bootstrap: extract (cached) + run a Bun executable on spidermonkey-node.
const cp = require("child_process");
const fs = require("fs");

const CACHE_ROOT = "/var/cache/kandelo/bun-run"; // volatile; never persisted (see spec)

function fail(msg, code) { process.stderr.write("bun-run: " + msg + "\n"); process.exit(code || 1); }

const binary = process.argv[2];
if (!binary) fail("usage: bun-run <bun-executable> [args...]", 2);
const appArgs = process.argv.slice(3);

// 1. Extract (cache-aware). One-shot; works with synchronous child_process today.
const r = cp.spawnSync("/usr/bin/bun-extract", ["--prepare", binary, CACHE_ROOT], { encoding: "utf8" });
if (r.status !== 0) fail("extract failed: " + ((r.stderr || "").trim() || ("exit " + r.status)), 1);
const entry = (r.stdout.match(/^ENTRY=(.+)$/m) || [])[1];
if (!entry) fail("could not determine entry point (not a Bun executable?)", 1);

// 2. Thin Bun-global shim. Unimplemented members throw named errors (never silent).
const ni = (name) => () => { throw new Error("Bun." + name + " not implemented (Kandelo bun-run shim)"); };
globalThis.__breq = (id) =>
  require(typeof id === "string" && id.indexOf("file://") === 0 ? require("url").fileURLToPath(id) : id);
globalThis.Bun = {
  version: (process.versions && process.versions.node) || "0",
  isStandaloneExecutable: false,
  which(cmd) { try { const o = cp.spawnSync("sh", ["-lc", "command -v " + cmd], { encoding: "utf8" }); return (o.stdout || "").trim() || null; } catch (_) { return null; } },
  file(p) { return { text: () => fs.promises.readFile(p, "utf8"), arrayBuffer: () => fs.promises.readFile(p), exists: () => Promise.resolve(fs.existsSync(p)) }; },
  write() { return ni("write")(); },
  spawn: ni("spawn"), serve: ni("serve"),
  stringWidth: (s) => String(s).length,
  stripANSI: (s) => String(s).replace(/\x1b\[[0-9;]*m/g, ""),
  gc() {}, deepEquals: (a, b) => JSON.stringify(a) === JSON.stringify(b),
};

// 3. Present the app with its own argv, then load it natively.
process.argv = [process.argv[0], entry].concat(appArgs);
import(entry).catch((e) => fail((e && (e.stack || e.message)) || String(e), 1));
```

Create `runtime/bun-run/README.md` with a short paragraph describing the file and its invocation.

- [ ] **Step 4: Run test to verify it passes**

Run: `scripts/dev-shell.sh bash -c 'cd host && npx vitest run test/bun-run-guest.test.ts'`
Expected: PASS — stdout contains `BUNRUN tag=ok ver=` and `args=hello,--flag`.

- [ ] **Step 5: Commit**

```bash
git add runtime/bun-run/bun-run.js runtime/bun-run/README.md host/test/bun-run-guest.test.ts
git commit -m "Host: Add bun-run.js bootstrap (extract+cache, Bun shim, native import)"
```

---

### Task 3: spidermonkey-node — resolve bare specifiers in native ESM

Teach the native ESM loader to resolve bare specifiers (Node builtins + `node_modules`) via the existing node-compat `require` resolver, instead of resolving them as file paths (`fs` → `//fs`). This is the core platform fix that lets a real Node ESM app load natively.

**Files:**
- Modify: `packages/registry/node-compat/bootstrap.js` (and/or `packages/registry/spidermonkey/patches/0012-kandelo-node-compat-shell-entry.patch` / the shell ModuleLoader — confirmed in Step 1)
- Test: `host/test/esm-probe-guest.test.ts` (extend with a bare-specifier import)

**Interfaces:**
- Consumes: existing `_builtinModules`, `_makeRequire`/`require`, `_resolveFile` in `bootstrap.js`; the module load path that dynamic `import()` uses.
- Produces: native ESM modules can `import … from "fs"` (builtin) and `import … from "<pkg>"` (node_modules) and receive the same object `require()` returns.

- [ ] **Step 1: Locate the ESM resolve/load hook**

Run these and read the results to identify where a bare specifier becomes a file open:

```bash
SN=$(find ~/.cache/kandelo -type d -name "firefox-140.11.0" | head -1)
grep -rn "can't open" "$SN/js/src/shell/" | head
sed -n '1,80p' "$SN/js/src/shell/ModuleLoader.js" 2>/dev/null | grep -nE "resolve|Resolve|normalize|import" 
grep -nE "moduleLoad|ModuleLoad|Resolve|import\(|dynamicImport" packages/registry/spidermonkey/patches/0012-kandelo-node-compat-shell-entry.patch
grep -nE "_builtinModules|_resolveFile|_makeRequire|moduleLoadList" packages/registry/node-compat/bootstrap.js | head
```

Determine whether the hook is best added in `bootstrap.js` (install a JS-level module resolve hook via the shell's API) or in the shell `ModuleLoader.js` (patched via 0012). Record the decision in the commit message.

- [ ] **Step 2: Write the failing test** — extend `host/test/esm-probe-guest.test.ts`. Add fixtures and a case for a builtin bare import:

```ts
// a2.mjs (add to the DIR fixtures): pulls a Node builtin via native ESM.
// printf 'import{readFileSync}from"fs";export const ok=typeof readFileSync==="function";' > a2.mjs
// main2.cjs: printf '(async()=>{try{const m=await import("/app/a2.mjs");console.log("BARE",m.ok);}catch(e){console.log("BAREERR",(e&&e.message)||e);}})();'
it.runIf(ready)("native ESM resolves a bare Node builtin specifier", async () => {
  const img = await image(); // extend image() to also stage a2.mjs + main2.cjs
  const r = await runCentralizedProgram({
    programPath: nodeWasm!, argv: ["node", "/app/main2.cjs"],
    rootfsImage: img, useDefaultRootfs: false, timeout: 60_000,
  });
  expect(r.stdout).toContain("BARE true");
}, 90_000);
```

Create the two fixture files under `/tmp/cc-inspect/esm_probe` (or the `ESM_PROBE_DIR`), and add `a2.mjs`/`main2.cjs` to the `image()` staging list.

- [ ] **Step 3: Run test to verify it fails**

Run: `scripts/dev-shell.sh bash -c 'cd host && npx vitest run test/esm-probe-guest.test.ts'`
Expected: FAIL — `BAREERR can't open //fs` (or similar), not `BARE true`.

- [ ] **Step 4: Implement the resolve bridge**

Based on Step 1, add a bare-specifier branch to the ESM resolve hook so that, when a specifier is not relative (`./`, `../`) and not absolute (`/`), it is routed through the existing node-compat resolution:
- If `_builtinModules[name]` (or `node:`-prefixed) exists, return that builtin module object (the same one `require(name)` yields), wrapped as an ES module namespace with a `default` export plus its own enumerable keys as named exports.
- Otherwise resolve via the existing `node_modules` walk (`_resolveFile`) relative to the importing module's path, and load that file through the module system.

Implement in `bootstrap.js` if a JS-level hook is available; otherwise patch `ModuleLoader.js` via `0012` to call a bootstrap-exposed `globalThis.__kandeloResolveBare(specifier, referrerPath)` that returns a synthetic module source (`export default X; export const {…} = X;`) backed by `require`. Keep the synthetic-namespace generation in JS (reuse `_makeRequire`).

- [ ] **Step 5: Rebuild spidermonkey-node and run the test**

Run: `scripts/dev-shell.sh ./run.sh build spidermonkey-node` then `scripts/dev-shell.sh bash -c 'cd host && npx vitest run test/esm-probe-guest.test.ts'`
Expected: PASS — `BARE true`, and the existing `ESMOK 43 hi!` case still passes.

- [ ] **Step 6: Commit** (note browser-host validation as follow-up)

```bash
git add packages/registry/node-compat/bootstrap.js packages/registry/spidermonkey/patches/ host/test/esm-probe-guest.test.ts
git commit -m "Host: Resolve bare specifiers in spidermonkey-node native ESM (builtins + node_modules)

Browser-host parity validation: follow-up."
```

---

### Task 4: spidermonkey-node — populate `import.meta` for native modules

Populate `import.meta.url`, `import.meta.dirname`, and `import.meta.require` on native ES modules, so extracted Bun apps (which use `import.meta.require`) run without any source rewriting.

**Files:**
- Modify: `packages/registry/node-compat/bootstrap.js` (and/or the `0012` patch / shell module-metadata hook — confirmed in Step 1)
- Test: `host/test/esm-probe-guest.test.ts` (extend)

**Interfaces:**
- Consumes: the module-load path from Task 3; `_makeRequire`; `url.pathToFileURL`.
- Produces: within any native ES module, `import.meta.url` (file URL), `import.meta.dirname` (dir path), and `import.meta.require(spec)` (the node-compat require bound to that module's dir) are defined.

- [ ] **Step 1: Locate the module-metadata hook**

```bash
SN=$(find ~/.cache/kandelo -type d -name "firefox-140.11.0" | head -1)
grep -rniE "SetModuleMetadata|MetadataHook|import.meta|setModulePrivate|GetModulePrivate" "$SN/js/src/shell/" | head
grep -nE "import.meta|metadata|MetaObject" packages/registry/spidermonkey/patches/0012-kandelo-node-compat-shell-entry.patch
```

Identify where the shell sets `import.meta` (the metadata callback) and how to reach the module's resolved path there.

- [ ] **Step 2: Write the failing test** — extend `esm-probe-guest.test.ts`:

```ts
// meta.mjs: printf 'export const info=[import.meta.url,import.meta.dirname,typeof import.meta.require];' > meta.mjs
// mainmeta.cjs: printf '(async()=>{const m=await import("/app/meta.mjs");console.log("META",m.info.join("|"));})();'
it.runIf(ready)("native ESM import.meta is populated", async () => {
  const img = await image(); // stage meta.mjs + mainmeta.cjs
  const r = await runCentralizedProgram({
    programPath: nodeWasm!, argv: ["node", "/app/mainmeta.cjs"],
    rootfsImage: img, useDefaultRootfs: false, timeout: 60_000,
  });
  expect(r.stdout).toMatch(/META file:\/\/\/app\/meta\.mjs\|\/app\|function/);
}, 90_000);
```

- [ ] **Step 3: Run test to verify it fails**

Run: `scripts/dev-shell.sh bash -c 'cd host && npx vitest run test/esm-probe-guest.test.ts'`
Expected: FAIL — `import.meta.url` empty / `import.meta.require` is `undefined`.

- [ ] **Step 4: Implement**

In the module-metadata callback (identified in Step 1), set `metaObject.url = pathToFileURL(resolvedPath)`, `metaObject.dirname = dirname(resolvedPath)`, and `metaObject.require = _makeRequire(resolvedPath)`. Keep the value construction in JS (call a bootstrap-exposed helper `globalThis.__kandeloModuleMeta(resolvedPath)` returning `{url, dirname, require}`) if the hook is C-side.

- [ ] **Step 5: Rebuild and run the test**

Run: `scripts/dev-shell.sh ./run.sh build spidermonkey-node` then the esbuild-probe vitest above.
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/registry/node-compat/bootstrap.js packages/registry/spidermonkey/patches/ host/test/esm-probe-guest.test.ts
git commit -m "Host: Populate import.meta (url/dirname/require) for spidermonkey-node native modules

Browser-host parity validation: follow-up."
```

---

### Task 5: Enable `using` in the SpiderMonkey build

Turn on Explicit Resource Management so the engine parses `using` declarations, removing the need for any `using`-lowering transform.

**Files:**
- Modify: `packages/registry/spidermonkey/build-spidermonkey.sh` (mozconfig section)
- Test: `host/test/esm-probe-guest.test.ts` (extend)

**Interfaces:**
- Consumes: the SpiderMonkey configure/mozconfig for the wasm32 build.
- Produces: `node.wasm` that parses and runs `using` declarations.

- [ ] **Step 1: Find the enabling knob**

```bash
SN=$(find ~/.cache/kandelo -type d -name "firefox-140.11.0" | head -1)
grep -rniE "explicit.resource|EXPLICIT_RESOURCE" "$SN/js/moz.configure" "$SN/build/moz.configure" "$SN/js/src/js.configure" 2>/dev/null | head
grep -nE "ac_add_options|MOZ_|mk_add_options|--enable" packages/registry/spidermonkey/build-spidermonkey.sh | head
```

Determine the exact configure/define (`--enable-explicit-resource-management`, or `export JS_ENABLE_EXPLICIT_RESOURCE_MANAGEMENT=1`, or a `MOZ_*` define) that sets `ENABLE_EXPLICIT_RESOURCE_MANAGEMENT`. If ESR 140 exposes only the pref (not a configure flag), set the compile define directly in the mozconfig (`ac_add_options --enable-explicit-resource-management` if present; else add `-DENABLE_EXPLICIT_RESOURCE_MANAGEMENT=1` via the build's CFLAGS/DEFINES path used by the package).

- [ ] **Step 2: Write the failing test** — extend `esm-probe-guest.test.ts`:

```ts
// using.mjs: printf 'export function run(){class R{[Symbol.dispose](){globalThis.__d=(globalThis.__d||0)+1;}}{using r=new R();}return globalThis.__d;}' > using.mjs
// mainusing.cjs: printf '(async()=>{try{const m=await import("/app/using.mjs");console.log("USING",m.run());}catch(e){console.log("USINGERR",(e&&e.message)||e);}})();'
it.runIf(ready)("engine parses and runs `using`", async () => {
  const img = await image(); // stage using.mjs + mainusing.cjs
  const r = await runCentralizedProgram({
    programPath: nodeWasm!, argv: ["node", "/app/mainusing.cjs"],
    rootfsImage: img, useDefaultRootfs: false, timeout: 60_000,
  });
  expect(r.stdout).toContain("USING 1");
}, 90_000);
```

- [ ] **Step 3: Run test to verify it fails**

Run: `scripts/dev-shell.sh bash -c 'cd host && npx vitest run test/esm-probe-guest.test.ts'`
Expected: FAIL — `USINGERR` with a parse error on `using`.

- [ ] **Step 4: Enable the flag** in `build-spidermonkey.sh` per Step 1 (add the configure option / define in the mozconfig heredoc).

- [ ] **Step 5: Rebuild and run the test**

Run: `scripts/dev-shell.sh ./run.sh build spidermonkey-node` then the vitest above.
Expected: PASS — `USING 1`. If ESR 140's implementation misbehaves, STOP and report; the documented fallback (targeted `using`-only lowering) is a scope change, not part of this task.

- [ ] **Step 6: Commit**

```bash
git add packages/registry/spidermonkey/build-spidermonkey.sh host/test/esm-probe-guest.test.ts
git commit -m "Packages: Enable Explicit Resource Management (using) in spidermonkey-node build"
```

---

### Task 6: End-to-end — `bun-run` the real Claude ELF (`--version`)

Prove the whole pipeline on the real binary: `bun-run /usr/bin/claude --version` → `2.1.259 (Claude Code)`, natively (no esbuild). Gated on the real ELF being available.

**Files:**
- Create: `programs/bun-run.c` (thin entrypoint: exec `spidermonkey-node /usr/lib/kandelo/bun-run.js` with argv passthrough)
- Test: `host/test/claude-run-native-guest.test.ts` (repurpose to drive through `bun-run.js` end-to-end)

**Interfaces:**
- Consumes: `bun-run.js` (Task 2), `bun-extract --prepare` (Task 1), the platform fixes (Tasks 3–5), `programs/spidermonkey-node.wasm`.
- Produces: `/usr/bin/bun-run` that runs a Bun executable; the milestone-1 proof.

- [ ] **Step 1: Write the failing/gated test** — rewrite `host/test/claude-run-native-guest.test.ts` to stage `bun-extract.wasm` at `/usr/bin/bun-extract`, `bun-run.js` at `/usr/lib/kandelo/bun-run.js`, and the real ELF (from `CLAUDE_BUN_ELF`) at `/usr/bin/claude`, then:

```ts
const r = await runCentralizedProgram({
  programPath: nodeWasm!,
  argv: ["node", "/usr/lib/kandelo/bun-run.js", "/usr/bin/claude", "--version"],
  env: ["HOME=/root", "CLAUDE_CONFIG_DIR=/root/.claude", "PATH=/usr/bin:/bin"],
  rootfsImage: bigCapacityImageStagingTheElf, // ~360MB cap, ELF + extracted output
  useDefaultRootfs: false,
  timeout: 240_000,
});
expect(r.stdout).toMatch(/2\.1\.\d+ \(Claude Code\)/);
```

Reuse the 360 MB capacity + `execPrograms` staging pattern from the existing `bun-extract-real-guest.test.ts`.

- [ ] **Step 2: Run to verify it fails/skips** (skips if `CLAUDE_BUN_ELF` unset; with it set, fails until the pipeline is wired)

Run: `CLAUDE_BUN_ELF=/tmp/cc-inspect/lx259/package/claude scripts/dev-shell.sh bash -c 'cd host && npx vitest run test/claude-run-native-guest.test.ts'`
Expected: prior to Tasks 3–5 landing, FAIL on a bare-specifier/`using`/`import.meta` error; skip if the ELF is absent.

- [ ] **Step 3: Implement `programs/bun-run.c`**

```c
#include <unistd.h>
#include <string.h>
int main(int argc, char **argv) {
    /* bun-run <binary> [args...] -> spidermonkey-node /usr/lib/kandelo/bun-run.js <binary> [args...] */
    char *nargv[argc + 3];
    nargv[0] = "spidermonkey-node";
    nargv[1] = "/usr/lib/kandelo/bun-run.js";
    for (int i = 1; i < argc; i++) nargv[i + 1] = argv[i];
    nargv[argc + 1] = 0;
    execv("/usr/bin/spidermonkey-node", nargv);
    return 127;
}
```

Build via `scripts/dev-shell.sh scripts/build-programs.sh`. (The entrypoint is not exercised by the in-kernel test above, which invokes `bun-run.js` directly; it is the convenience wrapper and the future binfmt call target. A follow-up test may stage `spidermonkey-node.wasm` at `/usr/bin/spidermonkey-node` to exercise it.)

- [ ] **Step 4: Run the end-to-end test**

Run: `CLAUDE_BUN_ELF=/tmp/cc-inspect/lx259/package/claude scripts/dev-shell.sh bash -c 'cd host && npx vitest run test/claude-run-native-guest.test.ts'`
Expected: PASS — `2.1.259 (Claude Code)`, produced natively via `import()` (no esbuild).

- [ ] **Step 5: Commit**

```bash
git add programs/bun-run.c host/test/claude-run-native-guest.test.ts
git commit -m "Packages: Add bun-run entrypoint; end-to-end claude --version on spidermonkey-node"
```

---

## Notes for the executor

- Tasks 3–5 each require a `node.wasm` rebuild (~long). If iterating by hand, you may make all three source edits first and rebuild once, then run the three added `esm-probe` cases together — but keep the commits split as written so each is independently reviewable.
- The transitional esbuild-CJS path (`host/test/claude-run-cjs-guest.test.ts`) and the pre-native `.mjs`/CJS run tests are throwaway bring-up artifacts; once Task 6 passes, delete `claude-run-cjs-guest.test.ts` and `claude-run-guest.test.ts` (the esbuild path) in a cleanup commit, keeping `esm-probe-guest.test.ts`, `bun-extract-*guest.test.ts`, `bun-run-guest.test.ts`, and the native end-to-end.
- Milestone 2 (headless `claude -p`) and binfmt exec-path integration are out of scope here (see spec Non-goals); expect the deeper runtime gaps (async `child_process`, TLS egress, CSPRNG, raw-mode PTY) to surface there.
```
