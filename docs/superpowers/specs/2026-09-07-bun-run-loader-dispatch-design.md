# Bun loader-dispatch for bun-run assets (M2 Phase J) — Design

## Why

Headless `claude -p` on spidermonkey-node now boots, loads its 1819-module
graph, runs `vm`, and decompresses embedded zstd assets (Phase I). It then
aborts at:

```
SyntaxError: '#' not followed by identifier
  at /var/cache/kandelo/bun-run/<hash>/loopAutonomousPreamble-07qcyhv4.md:1
  __kandeloRequireModule -> require -> chunk-grn2cpxb.js:11 -> cli.mjs
```

The Claude Code app `require()`s a Markdown embedded asset
(`loopAutonomousPreamble-…md`, whose content is `"# Autonomous loop check…"`)
and expects the **file contents as a string**. In the original Bun runtime
this works because Bun's standalone module graph tags each module with a
`loader` byte, and Bun's `text` loader returns a string. Our runtime does not
carry that signal: node-compat's `require()` dispatches purely by file
extension and the nearest `package.json` `type`. The bun-run cache dir is
`{"type":"module"}`, so a `.md` is routed into the ESM branch, handed to
SpiderMonkey's `CompileModule`, and parsed as JavaScript — the leading `#`
heading is a syntax error.

This is not a `.md`-only problem. The same graph carries assets under several
loaders the app depends on, and **file extension cannot disambiguate them**
(`.js` and `.mjs` each appear under more than one loader). The faithful fix is
to carry Bun's per-file loader decision through extraction and honor it in
`require()`, rather than guessing from the extension.

## Background: what the real graph contains

Parsing the real 2.1.x Claude Code standalone executable's module table
(`programs/bun-extract.c` already reads these bytes; a throwaway probe dumped
them) gives, for this Bun version, the following loader-byte distribution
across the 1819 modules:

| loader byte | class | count | extensions (examples) | require() must return |
|---|---|---|---|---|
| `1` | js | 1635 | `.js`, entry (`cli`) | the module (ESM or CJS) — today's behavior |
| `13` | text | 74 | `.md` (60), `.txt` (12), `.mjs` (2) | the file contents as a **string** |
| `5` | file | 107 | `.zst` (103), `.js` (3, e.g. `chart.umd.min.js`), `.asset` (1) | the **absolute on-disk path** (string) |
| `10` | napi | 3 | `.node` (native addons) | honest throw (unsupported — see below) |

**On `napi`.** `.node` files are compiled native C/C++ addons. Real support is
not a loader-dispatch concern — it needs a wasm N-API (Node-API) ABI *and* an
in-Kandelo C/C++ toolchain to build the addon against that ABI for wasm32 (see
the tracked in-Kandelo clang toolchain work). That is a large, separate effort
well beyond this phase. Here `napi` is therefore an **honest fail-loud throw**,
documented as tracked future work — never a silent or faked load. The app's 3
`.node` addons (e.g. `image-processor.node`) are feature-gated and not on the
headless `-p` path, so the throw unblocks `-p` without pretending support.

Two facts drive the design:

1. **Extension is not sufficient.** `.js` appears as both `js` (1634) and
   `file` (3); `.mjs` appears as both a module and `text` (2). Only the loader
   byte disambiguates. A pure-extension heuristic would execute a file-loader
   `.js` as code and a text `.mjs` as a module — both wrong.
2. **The app needs `text` now and `file` imminently.** `loopAutonomousPreamble.md`
   (text) is the current blocker. The 103 `.zst` assets are `file`-loader: the
   app takes their path and feeds the bytes to `Bun.zstdDecompressSync`
   (observed in the graph: `"…md.zst"…Bun.zstdDecompr…`) — i.e. the `.zst` wave
   is the next `-p` step, and it ties directly to Phase I. Building the
   mechanism for `text` + `file` together avoids reopening the same code.

How assets are loaded (spike-confirmed): the app calls a require-family helper
`ke("/$bunfs/root/<asset>")` with the **remapped absolute cache path** — there
are no relative `require("./…")` calls for assets, and no static
`import`-of-asset. All asset loads reach node-compat's `require()`
(`__kandeloRequireModule` in the failing stack). Therefore a `require()`-side
fix covers the app; the native ESM loader does not need changing (see
**Scope boundary**).

## Global Constraints

- **ABI-neutral.** No kernel/syscall/`repr(C)`/`ABI_VERSION`/snapshot change.
  Changes are: `programs/bun-extract.c` (a guest wasm program), a JSON manifest
  contract, `runtime/bun-run/bun-run.js`, and node-compat `bootstrap.js` (baked
  into `node.wasm`). Two artifact rebuilds: `bun-extract.wasm`
  (`scripts/build-programs.sh`, fast) and `node.wasm`
  (`scripts/dev-shell.sh ./run.sh build spidermonkey-node`, ~35 min).
- **Faithful / holistic, no app-shaped compromises.** Dispatch on Bun's actual
  per-file loader byte, not on the extension. Genuine limits (napi native
  addons; static-import-of-asset) are documented boundaries, never silent
  success.
- **Fail loud.** A `napi` require throws. An unrecognized loader byte falls
  back to js-class (today's behavior — no regression) but is counted/logged,
  never silently mis-served.
- **Backward compatible.** With no loader manifest / no `__kandeloAssetLoaders`
  global present, `require()` behaves exactly as it does today.

## Architecture

One new contract — a per-file **loader map** — flows producer → wiring →
consumer:

```
bun-extract.c  --(manifest.json "loaders")-->  bun-run.js  --(__kandeloAssetLoaders global)-->  node-compat require()
   (producer)                                   (wiring)                                          (consumer)
```

### Component 1 — `programs/bun-extract.c` (producer)

Current behavior: writes every module's contents to the cache; remaps
`/$bunfs/root/`→cachedir only for files whose **extension** is
`.js`/`.mjs`/`.cjs` (`is_js`); writes `cache/manifest.json = {"entry","format"}`.

Changes:

1. **Classify by loader byte, not extension.** Add a mapping from the raw
   `loader` byte to a stable class string, anchored to the observed Bun version:

   ```
   1  -> "js"
   13 -> "text"
   5  -> "file"
   6  -> "json"
   10 -> "napi"
   (anything else) -> "unknown"
   ```

   The raw byte is already parsed (it sits at struct offset +49 in each 52-byte
   `CompiledModuleGraphFile`). Keep the table in one function
   (`loader_class(uint8_t)`).

2. **Gate the remap on class, not extension.** Replace the `is_js` extension
   check that guards the `/$bunfs/root/`→cachedir `replace_all` with
   `class == js` (js also covers the entry, which is always a module). All
   non-js classes are written **verbatim** (they already are for non-`.js`
   extensions; this also stops remapping a file-loader `.js`).

3. **Emit the loader map.** In prepare mode, extend the written
   `cache/manifest.json` from `{"entry","format"}` to:

   ```json
   { "entry": "<rel>", "format": <0|1>,
     "loaders": { "<cache-relpath>": "text" | "file" | "json" | "napi" } }
   ```

   `js`-class files are **omitted** (js is the runtime default), keeping the map
   to the ~184 non-js entries. Keys are the cache-relative output path
   (`rel_out`), the same name the file is written under. `unknown`-class files
   are omitted (they get js-fallback at the consumer) but increment a counter
   printed to stderr: `"bun-extract: N modules with unrecognized loader byte
   (treated as js)"` so an enum drift is visible.

   The map must be written with correctly JSON-escaped keys (reuse/extend the
   existing JSON-unsafe-name guarding already applied to names).

Non-prepare (`--extract`, no cache) mode's `_manifest.json` gains the same
`loaders` object for parity, though bun-run only uses prepare mode.

### Component 2 — `runtime/bun-run/bun-run.js` (wiring)

After `bun-extract --prepare` returns `CACHE=<dir>`, and before importing the
entry:

1. Read `<CACHE>/manifest.json`; parse `loaders` (tolerate its absence — older
   caches).
2. Build `globalThis.__kandeloAssetLoaders`, an object keyed by **absolute**
   path (`<CACHE> + "/" + relpath`) → class string. Absolute keying matches how
   `require()` looks paths up (it resolves specifiers to absolute paths). The
   cache dir contains no symlinks, so lexical-absolute equals realpath.
3. If `loaders` is absent/empty, leave the global unset (consumer no-ops).

node-compat stays generic: it reads an optional global and has no knowledge of
bun-run.

### Component 3 — `packages/registry/node-compat/bootstrap.js` `require()` (consumer)

In `require()`, consult the loader for the resolved path **immediately after
the raw file is loaded (`source = std.loadFile(resolved)` and its null check)
and BEFORE `_stripShebang`, the `.json`-by-extension check, and the ESM/CJS
dispatch**:

```js
// (right after the std.loadFile null check, before _stripShebang)
const _assetLoader = globalThis.__kandeloAssetLoaders &&
    globalThis.__kandeloAssetLoaders[resolved];
if (_assetLoader === 'text') {
    // Bun text loader: module.exports IS the RAW file contents string.
    // Use the pre-shebang-strip source — Bun returns the file bytes verbatim.
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
    throw new Error(
        `${id}: native Node addons (.node) are not supported on ` +
        `spidermonkey-node`);
}
// 'js', 'unknown', or no global -> continue: _stripShebang, then the existing
// .json-extension check and ESM/CJS dispatch, unchanged.
```

Placement rationale:
- **Before `_stripShebang`:** the `text` loader must return the file bytes
  verbatim; a `.txt`/`.md` beginning `#!…` must not be truncated. Shebang
  stripping stays scoped to executable JS.
- **Before the `.json`-extension check:** makes the loader byte authoritative.
  A regular `node_modules` `.json` (no `__kandeloAssetLoaders` entry) falls
  through to the unchanged `.json`-extension `JSON.parse`, so nothing regresses;
  an asset with an explicit `json` loader is handled here identically.
- The lookup key is `resolved` (the realpath'd absolute path require() already
  computes); Component 2 keys the global identically (lexical-absolute cache
  paths, which equal realpath since the cache has no symlinks).
- `text`/`file`/`json` results are cached in `_moduleCache` like any other
  require result, so repeat requires are deduped and identity-stable.
- A text `.md`/`.mjs` in a `type:module` cache dir therefore never reaches the
  ESM branch / `__kandeloRequireModule`.

## Scope boundary (documented, not silent)

The spike confirmed every asset load reaches node-compat `require()` via the
app's `ke(…)` helper; there are no static `import`-of-asset statements. This
design therefore covers the `require()` path only. A hypothetical static
`import preamble from "./x.md"` would route through the native ESM ModuleLoader
(patch 0015 resolution + SpiderMonkey `CompileModule`) and still mis-compile a
text/file asset. Because the app does not do this, it is a **documented
boundary** in `docs/posix-status.md`, not a live gap. If a future app version
static-imports an asset, the fix would extend to make the native module loader
loader-aware (a larger, C-side change) — out of scope here.

## Error handling

| Situation | Behavior |
|---|---|
| `napi` asset required | Loud throw naming the module; native addons unsupported on wasm |
| Unrecognized loader byte (Bun enum drift) | Producer omits it from the map + logs a count; consumer treats it as `js` (today's behavior) — no silent mis-serve |
| Manifest missing / no `loaders` key | Consumer global unset → `require()` unchanged; fully backward compatible |
| `text` asset that is UTF-16 in the graph | bun-extract already decodes per the `encoding` byte to UTF-8 on write, so `source` is UTF-8 text |

## Testing

1. **bun-extract producer (guest test, extend `host/test/bun-extract-guest.test.ts`).**
   Stage a synthetic graph with three modules: a `js`-loader `.js`, a
   `text`-loader `.md`, and a `file`-loader `.zst` (construct the 52-byte
   records with the specific loader bytes). Run `bun-extract --prepare` under
   the kernel and assert: `manifest.json.loaders` records `{"…md":"text",
   "…zst":"file"}` and omits the js module; the js module was `/$bunfs/root/`-
   remapped; the text and file modules were written **verbatim** (byte-identical
   to input, no remap).

2. **require() consumer (extend `host/test/esm-probe-guest.test.ts`).**
   With `globalThis.__kandeloAssetLoaders` set to a small map, assert:
   `require(textPath)` returns the exact file string; `require(filePath)`
   returns the absolute path; `require(napiPath)` throws the unsupported error;
   an unmapped path still loads as a module. Confirm all Phase A–I cases stay
   green.

3. **End-to-end acceptance (throwaway `claude -p`).** Isolated
   HOME/CLAUDE_CONFIG_DIR, dummy `ANTHROPIC_API_KEY`, TCP egress. Confirm the
   `loopAutonomousPreamble.md` SyntaxError is gone and init advances past the
   text-asset load (ideally into the `.zst` file-loader wave or a later seed).
   Capture the next `-p` blocker as the Phase K seed. Delete the probe.

4. **Docs.** `docs/posix-status.md`: document the bun-run loader-dispatch
   contract (text→string, file→path, json→JSON, napi→throw), the static-
   import-of-asset boundary, and native-addon-unsupported.

## Components / files touched

| File | Change |
|---|---|
| `programs/bun-extract.c` | `loader_class()`; remap gated on class==js; emit `manifest.json` `loaders` map + unknown-count log |
| `runtime/bun-run/bun-run.js` | read `manifest.loaders` → install `globalThis.__kandeloAssetLoaders` (absolute-path keys) |
| `packages/registry/node-compat/bootstrap.js` | `require()` loader dispatch (text/file/json/napi) before the ESM branch |
| `host/test/bun-extract-guest.test.ts` | synthetic text/file/js loader-manifest + verbatim/remap assertions |
| `host/test/esm-probe-guest.test.ts` | require() loader-dispatch cases |
| `docs/posix-status.md` | loader-dispatch contract + boundaries |

## Task decomposition (for the plan)

- **Task 1 — bun-extract producer.** `loader_class()`, class-gated remap,
  `loaders` manifest map, unknown-count log; rebuild `bun-extract.wasm`; guest
  test asserting manifest + verbatim/remap. Independently testable (no node.wasm
  rebuild).
- **Task 2 — consumer + wiring + acceptance.** node-compat `require()` dispatch,
  bun-run global install, esm-probe cases, ONE `node.wasm` rebuild, `-p`
  acceptance, docs, capture Phase K seed. Consumes Task 1's manifest contract.
