# Bun loader-dispatch for bun-run assets Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Carry Bun's per-file loader byte through `bun-extract` into a cache manifest and honor it in node-compat `require()`, so headless `claude -p` on spidermonkey-node gets past `SyntaxError: '#' not followed by identifier` when the app `require()`s a Markdown embedded text asset.

**Architecture:** Bun's standalone module graph tags each module with a `loader` byte that `bun-extract` currently discards. Task 1 makes `bun-extract` (a wasm guest program) classify each module by that byte and emit a `loaders` map into `cache/manifest.json`, gating its `/$bunfs/root/`→cachedir remap on class==js. Task 2 makes `bun-run.js` read that map into a `globalThis.__kandeloAssetLoaders` object and node-compat `require()` (baked into `node.wasm`) dispatch on it: text→string, file→on-disk path, json→JSON.parse, js→module (today), napi→honest throw.

**Tech Stack:** C (wasm32 guest, `programs/bun-extract.c`), JavaScript (node-compat `bootstrap.js` baked into `node.wasm`; `runtime/bun-run/bun-run.js`), Vitest in-kernel guest tests (`runCentralizedProgram`).

**Spec:** `docs/superpowers/specs/2026-09-07-bun-run-loader-dispatch-design.md` (read it alongside this plan).

## Global Constraints

- **ABI-neutral.** No kernel/syscall/`repr(C)`/`ABI_VERSION`/`abi/snapshot.json` change. Only `programs/bun-extract.c` (guest wasm), a JSON manifest contract, `runtime/bun-run/bun-run.js`, and node-compat `bootstrap.js` (baked into `node.wasm`).
- **Faithful/holistic, no app-shaped compromises.** Dispatch on the loader byte, NOT the file extension (`.js` and `.mjs` each appear under multiple loaders).
- **Fail loud.** `napi` require throws. An unrecognized loader byte falls back to js (today's behavior) but is counted to stderr, never silently mis-served.
- **Backward compatible.** With no manifest `loaders` / no `__kandeloAssetLoaders` global, `require()` behaves exactly as today.
- **Loader byte map (this Bun version, Claude Code 2.1.x):** `1`=js, `13`=text, `5`=file, `6`=json, `10`=napi, else unknown. Raw byte at `rec[49]` in the 52-byte record (`enc=rec[48]`, `fmt=rec[50]`, `side=rec[51]`).
- **`text` returns RAW pre-shebang-strip source** (a `.txt`/`.md` may begin `#!`). The loader check runs BEFORE `_stripShebang`, the `.json`-extension check, and the ESM/CJS dispatch, so the loader byte is authoritative; regular `node_modules` `.json` (no loader entry) falls through unchanged.
- **Lookup key parity.** node-compat looks up by `resolved` (the realpath'd absolute path); `bun-run.js` keys the global by `<CACHE>/<relpath>`. The cache has no symlinks, so lexical-absolute == realpath.
- **napi is honest-throw only.** Real `.node` native-addon support is deferred future work needing a wasm N-API ABI + the in-Kandelo C/C++ toolchain — NOT this phase.
- **Build guardrails (Phase F/I lessons).** `bun-extract.wasm` rebuild = `scripts/build-programs.sh` (FAST). `node.wasm` rebuild ~35 min = targeted `scripts/dev-shell.sh ./run.sh build spidermonkey-node` ONLY (never full `local-build`); redirect to a log file and grep `error:`/`check_spidermonkey_style`/`Build complete`. Batch ALL Task-2 edits into ONE `node.wasm` rebuild. In-kernel tests via `runCentralizedProgram`. `claude -p` acceptance uses the 420 MiB `SharedArrayBuffer` capacity trick.

---

### Task 1: bun-extract producer — classify loaders + emit manifest map

**Files:**
- Modify: `programs/bun-extract.c` (module loop ~289-368; manifest write ~379-386; struct reads ~291-294)
- Test: `host/test/bun-extract-guest.test.ts` (extend `buildFixture` + add a prepare-mode loader-manifest test)

**Interfaces:**
- Produces: `cache/manifest.json` gains `"loaders": { "<cache-relpath>": "text"|"file"|"json"|"napi" }` (js/unknown omitted). Prepare-mode stdout gains a self-check line `MANIFEST_LOADERS {<the loaders object body>}`. Task 2 consumes the `loaders` map.
- Consumes: nothing (independently testable; no `node.wasm` rebuild).

- [ ] **Step 1: Write the failing test — extend `buildFixture` to carry loader bytes, add a text `.md` and a file `.zst` module**

In `host/test/bun-extract-guest.test.ts`, replace the `buildFixture` module list and the per-record loader byte so the graph has a js entry, a js chunk, a text `.md`, and a file `.zst`. The `.md` and `.zst` contents embed a `/$bunfs/root/` marker to prove verbatim (non-remapped) writing:

```ts
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
```

Then add a new test asserting the loader manifest + verbatim-vs-remap via the prepare-mode self-check lines (the existing `EXTRACTED count=` test's count changes to 4, update it too):

```ts
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `scripts/dev-shell.sh bash -c 'npx vitest run host/test/bun-extract-guest.test.ts -t "prepare records a per-file loader manifest"'`
Expected: FAIL — `MANIFEST_LOADERS`/`ASSET_VERBATIM` lines absent (bun-extract doesn't emit them yet). (Also the `EXTRACTED count=3` assertion in the first test now fails at count=4 — update it to `count=4 esm=2 entry=cli` in this step.)

- [ ] **Step 3: Add `loader_class()` and read the loader byte in `programs/bun-extract.c`**

Near the top helpers (after `has_json_unsafe_byte`, before the main function), add:

```c
/* Map a Bun standalone-graph loader byte (observed on Claude Code 2.1.x) to a
 * stable class string the runtime honors. Unknown bytes return "" and are
 * treated as js (executed) by the consumer -- a safe, logged fallback. */
static const char *loader_class(unsigned char b) {
  switch (b) {
    case 1:  return "js";
    case 13: return "text";
    case 5:  return "file";
    case 6:  return "json";
    case 10: return "napi";
    default: return "";
  }
}
```

In the per-module loop, read the loader byte alongside the existing `enc`/`fmt` (currently `enc = rec[48]`, `fmt = rec[50]` around line 293-294):

```c
        unsigned char loader = rec[49];
```

- [ ] **Step 4: Gate the remap on class==js and accumulate the loaders map**

Before the loop, declare the accumulator (near the other locals, ~line 284):

```c
    char *loaders = NULL; size_t loaders_len = 0, loaders_cap = 0;
    uint32_t unknown_loaders = 0;
```

Replace the extension-based `is_js` (currently `int is_js = is_entry || ends_with(rel_out, ".js") || ends_with(rel_out, ".mjs") || ends_with(rel_out, ".cjs");` around line 348) with a loader-byte gate, and accumulate the manifest entry for non-js assets. Insert the accumulation on the write path — right AFTER the `if (prepare && is_hit) continue;` at line 319 (so a full cache hit, which skips the manifest rewrite, does not accumulate), still inside the loop:

```c
        int is_js = is_entry || (loader == 1);

        if (prepare && !is_entry && loader != 1) {
            const char *cls = loader_class(loader);
            if (cls[0] == 0) {
                unknown_loaders++;   /* unknown -> omitted; consumer runs as js */
            } else {
                char eb[4400];
                int m = snprintf(eb, sizeof eb, "%s\"%s\":\"%s\"",
                                 loaders_len ? "," : "", rel_out, cls);
                if (m < 0 || m >= (int)sizeof eb) {
                    fprintf(stderr, "bun-extract: loaders entry too long at %u\n", i);
                    free(loaders); return 1;
                }
                if (loaders_len + (size_t)m + 1 > loaders_cap) {
                    loaders_cap = (loaders_len + (size_t)m + 1) * 2;
                    loaders = realloc(loaders, loaders_cap);
                    if (!loaders) { fprintf(stderr, "oom\n"); return 1; }
                }
                memcpy(loaders + loaders_len, eb, (size_t)m);
                loaders_len += (size_t)m; loaders[loaders_len] = 0;
            }
        }
```

Note: `rel_out` is safe to embed in a `"..."` JSON string because module names already pass `has_json_unsafe_byte` (line 298); `rel_out` derives from that validated name. The existing `if (prepare && is_js) { ...remap... } else { fwrite verbatim; }` block (line 349-365) now keys off the new `is_js`, so text/file/json/napi/unknown are written verbatim.

- [ ] **Step 5: Write the `loaders` map into the manifest, add the self-checks, log unknowns**

Change the prepare-mode manifest write (line 381) from:

```c
            if (mf) { fprintf(mf, "{\"entry\":\"%s\",\"format\":%d}\n", entry_rel, entry_fmt); fclose(mf); }
```

to include the loaders object:

```c
            if (mf) { fprintf(mf, "{\"entry\":\"%s\",\"format\":%d,\"loaders\":{%s}}\n",
                              entry_rel, entry_fmt, loaders ? loaders : ""); fclose(mf); }
```

After the `package.json` write (after line 386), emit the stdout self-check + unknown-count log, and free the buffer at the end of prepare handling:

```c
            printf("MANIFEST_LOADERS {%s}\n", loaders ? loaders : "");
            if (unknown_loaders) {
                fprintf(stderr, "bun-extract: %u modules with unrecognized loader byte (treated as js)\n",
                        unknown_loaders);
            }
```

Add per-asset verbatim self-checks in the prepare self-check block (near the existing `REMAP_OK` self-check ~line 392-400): for each non-js asset written, reopen it and report whether `/$bunfs/root/` is still present (verbatim) — accumulate the relpaths during the loop into a small list, or re-derive from the loaders string. Simplest: during the loop, when writing a verbatim non-js asset in prepare mode, immediately print its check:

```c
        /* inside the loop, in the `else { fwrite(text,...) }` verbatim branch,
         * when (prepare && !is_js): prove it was NOT remapped. */
        if (prepare && !is_js) {
            const char *cls = loader_class(loader);
            if (cls[0]) {
                int has = (tlen && memmem(text, tlen, "/$bunfs/root/", 13) != NULL);
                printf("ASSET_VERBATIM %s %s\n", rel_out, has ? "yes" : "no");
            }
        }
```

Free `loaders` before returning from prepare success (near the end of the `if (prepare)` block): `free(loaders); loaders = NULL;`.

- [ ] **Step 6: Rebuild `bun-extract.wasm`**

Run: `scripts/dev-shell.sh scripts/build-programs.sh`
Expected: builds `local-binaries/programs/wasm32/bun-extract.wasm` with no errors. (Fast — this is the guest-program build, not the 35-min spidermonkey build.)

- [ ] **Step 7: Run the test to verify it passes**

Run: `scripts/dev-shell.sh bash -c 'npx vitest run host/test/bun-extract-guest.test.ts'`
Expected: PASS — both the updated extract test (`count=4 esm=2 entry=cli`) and the new loader-manifest test (`preamble.md`→text, `blob.zst`→file, `chunk-a.js` omitted, `ASSET_VERBATIM … yes`, `REMAP_OK`).

- [ ] **Step 8: Commit**

```bash
git add programs/bun-extract.c host/test/bun-extract-guest.test.ts
git commit -m "$(cat <<'EOF'
Bun-run: record per-file loader classes in the extract manifest

## Why

Bun's standalone module graph tags each module with a loader byte
(text/file/json/js/napi). bun-extract dropped it, so the runtime had no
way to tell that a .md is a text asset (return its string) versus a
module to execute. This records that decision so require() can honor it.

## What changed

bun-extract classifies each module by its loader byte, gates the
/$bunfs/root/->cachedir remap on class==js (writing text/file/json/napi
verbatim, fixing a latent bug where a file-loader .js was remapped), and
emits "loaders":{"<relpath>":"text"|"file"|"json"|"napi"} into
cache/manifest.json (js omitted = default; unknown bytes omitted +
counted to stderr). Guest test asserts the manifest and verbatim writes.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: consumer + wiring + acceptance — require() loader dispatch

**Files:**
- Modify: `runtime/bun-run/bun-run.js` (after entry parse ~line 30, before `import(entry)` ~line 54)
- Modify: `packages/registry/node-compat/bootstrap.js` `require()` (insert after the `std.loadFile` null check ~line 4681, BEFORE `_stripShebang` line 4682)
- Test: `host/test/esm-probe-guest.test.ts` (new fixture + case)
- Modify: `docs/posix-status.md` (loader-dispatch contract + boundaries)

**Interfaces:**
- Consumes: Task 1's `cache/manifest.json` `loaders` map (`{ "<relpath>": "text"|"file"|"json"|"napi" }`, js omitted).
- Produces: `globalThis.__kandeloAssetLoaders` — an object keyed by ABSOLUTE cache path (`<CACHE>/<relpath>`) → class string, or unset when no map. node-compat `require()` reads it.

- [ ] **Step 1: Write the failing test — require() honors the loader map**

In `host/test/esm-probe-guest.test.ts`, add asset fixture files and a main fixture to the `FILES` object that sets `globalThis.__kandeloAssetLoaders` (keyed by the staged `/app/...` paths, which require() resolves to unchanged) and requires each asset:

```ts
  // Bun loader-dispatch (M2 Phase J): require() honors __kandeloAssetLoaders —
  // text -> raw string, file -> absolute path, napi -> honest throw, and an
  // unmapped path still loads as a normal CJS module.
  "asset.md": "# heading\nbody line\n",
  "asset.zst": "not-real-zstd-bytes\n",
  "asset.node": " native\n",
  "plain.cjs": "module.exports={ok:42};\n",
  "mainloader.cjs":
    '(()=>{try{' +
    'globalThis.__kandeloAssetLoaders={' +
    '"/app/asset.md":"text","/app/asset.zst":"file","/app/asset.node":"napi"};' +
    'const t=require("/app/asset.md");' +
    'const f=require("/app/asset.zst");' +
    'let n="";try{require("/app/asset.node");n="NOTHROW";}catch(e){n=(e&&e.message||"").indexOf("native Node addons")>=0?"THROW":"WRONG:"+(e&&e.message);}' +
    'const j=require("/app/plain.cjs");' +
    'console.log("LOADER",JSON.stringify(t),f,n,j&&j.ok);' +
    '}catch(e){console.log("LOADERERR",(e&&e.name)||"",(e&&e.message)||e);}})();',
```

And the assertion case:

```ts
  it.runIf(ready)("bun-run loader dispatch: text->string, file->path, napi->throw, unmapped->module", async () => {
    const r = await runOne("/app/mainloader.cjs");
    // eslint-disable-next-line no-console
    console.log("LOADER OUT:", JSON.stringify(r.stdout.trim()), "ERR:", r.stderr.trim().split("\n").slice(-6).join(" | "));
    expect(r.stdout).toContain('LOADER "# heading\\nbody line\\n" /app/asset.zst THROW 42');
  }, 90_000);
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `scripts/dev-shell.sh bash -c 'npx vitest run host/test/esm-probe-guest.test.ts -t "bun-run loader dispatch"'`
Expected: FAIL — without the dispatch, `require("/app/asset.md")` compiles the Markdown (`# heading`) and throws a SyntaxError (`LOADERERR`), so the expected `LOADER "…" … THROW 42` line is absent.

- [ ] **Step 3: Add the loader dispatch to node-compat `require()`**

In `packages/registry/node-compat/bootstrap.js`, insert immediately after the `std.loadFile` null-check block (after line 4681, before `source = _stripShebang(source);` at line 4682):

```js
        // Bun loader dispatch (M2 Phase J). bun-run installs
        // globalThis.__kandeloAssetLoaders (abs cache path -> class) from the
        // extract manifest. Honor it BEFORE shebang-strip, the .json-extension
        // check, and the ESM/CJS dispatch, so the loader byte is authoritative.
        // With no map present this is a no-op and require() behaves as before.
        const _assetLoader = globalThis.__kandeloAssetLoaders &&
            globalThis.__kandeloAssetLoaders[resolved];
        if (_assetLoader === 'text') {
            // Bun text loader: module.exports IS the raw file contents (no
            // shebang strip -- a .txt/.md may legitimately begin "#!").
            _moduleCache[resolved] = { exports: source };
            return source;
        }
        if (_assetLoader === 'file') {
            // Bun file loader: module.exports IS the absolute on-disk path.
            _moduleCache[resolved] = { exports: resolved };
            return resolved;
        }
        if (_assetLoader === 'json') {
            const exports = JSON.parse(source);
            _moduleCache[resolved] = { exports };
            return exports;
        }
        if (_assetLoader === 'napi') {
            throw new Error(`${id}: native Node addons (.node) are not ` +
                `supported on spidermonkey-node`);
        }
        // 'js', 'unknown', or no map -> fall through to the existing behavior.
```

- [ ] **Step 4: Wire the manifest → global in `runtime/bun-run/bun-run.js`**

After the entry is parsed (after line 30 `if (!entry) fail(...)`) and before the Bun-global shim, add the manifest read + global install:

```js
// Install the per-file loader map so node-compat require() returns Bun-correct
// values for embedded assets (text -> string, file -> path, json -> object,
// napi -> honest throw). Keyed by absolute cache path to match require()'s
// realpath'd lookup (the cache has no symlinks). Missing/old manifests are
// tolerated: require() then behaves exactly as before.
const cache = (rStdout.match(/^CACHE=(.+)$/m) || [])[1];
if (cache) {
  try {
    const loaders = (JSON.parse(fs.readFileSync(cache + "/manifest.json", "utf8")) || {}).loaders;
    if (loaders && typeof loaders === "object") {
      const map = Object.create(null);
      for (const rel of Object.keys(loaders)) map[cache + "/" + rel] = loaders[rel];
      globalThis.__kandeloAssetLoaders = map;
    }
  } catch (_) { /* no loaders map: leave require() behavior unchanged */ }
}
```

- [ ] **Step 5: Rebuild `node.wasm` (ONE targeted build)**

Run: `scripts/dev-shell.sh ./run.sh build spidermonkey-node > /tmp/phasej-build.log 2>&1`
Expected: `[OK] Build complete` and `check_spidermonkey_style.py | ok` in the log; `node.wasm` restaged. (No SpiderMonkey C++ patch changed here, so this is a node-compat rebuild; still ~long. Do NOT run a full `local-build`.) Verify: `grep -E 'error:|Error 2|check_spidermonkey_style|Build complete' /tmp/phasej-build.log`.

- [ ] **Step 6: Run the loader-dispatch test + full esm-probe suite**

Run: `scripts/dev-shell.sh bash -c 'npx vitest run host/test/esm-probe-guest.test.ts --testTimeout=300000'`
Expected: PASS — the new `bun-run loader dispatch` case prints `LOADER "# heading\nbody line\n" /app/asset.zst THROW 42`, and all Phase A–I cases stay green. (Note: an unrelated in-kernel case can flake on its inline 90s timeout under heavy host load — re-run to confirm it is load, not regression, per the Phase I ledger.)

- [ ] **Step 7: Throwaway `claude -p` acceptance + capture the Phase K seed**

Create a throwaway probe `host/test/phasej-p-probe.test.ts` mirroring `host/test/claude-run-native-guest.test.ts` but with argv `["node","/usr/lib/kandelo/bun-run.js","/usr/bin/claude","-p","say hi"]`, env adding `ANTHROPIC_API_KEY=sk-ant-dummy-not-a-real-key`, `enableTcpNetwork: true`, the 420 MiB `SharedArrayBuffer` capacity rootfs, and staged `execPrograms` (`/usr/bin/claude`→`CLAUDE_BUN_ELF`, `/usr/bin/bun-extract`→extract wasm, `/usr/lib/kandelo/bun-run.js`, `/bin/sh`→sh wasm). Assert `expect(all).not.toMatch(/'#' not followed by identifier/)` and print the last ~80 stderr lines.

Run: `scripts/dev-shell.sh bash -c 'CLAUDE_BUN_ELF=/tmp/cc-inspect/lx259/package/claude npx vitest run host/test/phasej-p-probe.test.ts --testTimeout=320000'`
Expected: PASS — the `loopAutonomousPreamble.md` SyntaxError is gone; init advances further. Read the stderr tail, record the NEXT `-p` blocker verbatim as the Phase K seed (in the SDD ledger and the `run-claude-code-in-kandelo` memory), then delete the probe: `rm host/test/phasej-p-probe.test.ts`.

- [ ] **Step 8: Update `docs/posix-status.md`**

Add a row/section documenting the bun-run loader-dispatch contract: `require()` of an embedded asset returns per Bun's loader byte — `text`→raw string, `file`→absolute on-disk path, `json`→`JSON.parse`, `js`→module. Document the two boundaries: (1) static `import` of a text/file asset is NOT covered (the app loads assets via `require`/`ke(…)`, not static import — a documented boundary, not a live gap); (2) `napi` (`.node` native addons) throws `"native Node addons (.node) are not supported on spidermonkey-node"` — real support is deferred future work needing a wasm N-API ABI + the in-Kandelo C/C++ toolchain.

- [ ] **Step 9: Commit**

```bash
git add runtime/bun-run/bun-run.js packages/registry/node-compat/bootstrap.js host/test/esm-probe-guest.test.ts docs/posix-status.md
git commit -m "$(cat <<'EOF'
Host: Honor Bun loader classes in bun-run require() (M2 Phase J)

## Why

Headless `claude -p` decompresses its embedded zstd assets (Phase I) then
aborted: the app require()s a Markdown embedded asset
(loopAutonomousPreamble.md) and node-compat compiled it as an ES module
(SyntaxError '#') instead of returning its contents as a string. Bun's
standalone graph records a loader byte per module; the runtime must honor
it, because file extension cannot disambiguate (.js and .mjs each appear
under multiple loaders).

## What changed

bun-run reads the loader map bun-extract now emits and installs
globalThis.__kandeloAssetLoaders (absolute cache path -> class). node-compat
require() consults it before shebang-strip / .json-check / ESM dispatch:
text -> raw string, file -> on-disk path, json -> JSON.parse, js -> module
(unchanged), napi -> honest throw (native addons unsupported; real support
is future work needing the in-Kandelo C/C++ toolchain). Backward compatible:
no map -> require() unchanged. esm-probe covers all four dispatch paths;
`claude -p` now advances past the .md text-asset load.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Notes for the executor

- **Do not push.** The user is sole merger of PR #1371 and gates every push; land commits locally and stop.
- **bun-extract self-check output.** The `MANIFEST_LOADERS` / `ASSET_VERBATIM` lines are permanent diagnostics on prepare-mode stdout; `bun-run.js` greps only `CACHE=`/`ENTRY=`, so extra lines are harmless.
- **Task 1 is independently shippable** (no `node.wasm` rebuild). Task 2 batches all edits into ONE `node.wasm` rebuild.
