# Running Bun-compiled executables on Kandelo (`bun-run`) — Design

**Status:** Approved design; implementation not started
**Date:** 2026-09-03

## Why

Modern JavaScript CLIs increasingly ship as **Bun single-file
executables** (`bun build --compile`): a native launcher (Mach-O on
macOS, ELF on Linux, PE on Windows) with the application's JavaScript
embedded as a serialized "module graph" in a container section. Claude
Code is the motivating example — since v2.1.113 its npm package ships
*only* the Bun executable (the last plain-Node `cli.js` was v2.1.112,
2026-04-16, now months stale). Codex and others are moving the same
direction.

Kandelo cannot run the native binary itself — it is compiled machine
code, and the app inside is JSC bytecode plus JS source targeting Bun's
runtime. But Kandelo *does* have a Node-compatible JavaScript runtime
(spidermonkey-node) and, as of this work, a proven in-kernel extractor
for the embedded JS. This design turns those pieces into a platform
capability: **transparently run a Bun-compiled executable by extracting
its embedded JS, caching it, and executing it natively on
spidermonkey-node.**

The goal is Claude-first but general-shaped: build the mechanism
generally, and harden the Bun-API surface, module resolution, and syntax
support only as far as the programs we actually run require. Real
programs drive which gaps we close, not a compatibility spec.

## What already exists (foundation)

- `programs/bun-extract.c` — a container-agnostic guest program that
  locates the Bun module graph without parsing the executable format
  (it anchors on the Bun trailer + `Offsets` struct and validates the
  blob base against `/$bunfs/root/` name pointers), then writes each
  module's plaintext source. Proven in-kernel; scales to the real
  ~207 MB Claude Linux ELF (1819 modules extracted in ~2.8 s). Peak
  memory is one module because reads are positioned (`pread`).
- `spidermonkey-node` — built and running in-kernel
  (`programs/spidermonkey-node.wasm`, ~53 MB; the node-compat bootstrap
  is compiled into the wasm, so running a script needs nothing extra
  staged in the VFS).
- Proof of execution: the extracted app prints `2.1.259 (Claude Code)`
  on spidermonkey-node in-kernel (via a transitional esbuild ESM->CJS
  bundle; this design replaces that with the native path).

## Findings that shape the design

Empirically established (see `host/test/esm-probe-guest.test.ts` and the
native-run attempt):

1. **spidermonkey-node has real, native ESM.** Dynamic `import()` of a
   minified multi-module graph works (`import{x,f}from"…"` + `export` +
   cross-module resolution all succeed via SpiderMonkey's module
   loader). The earlier "no real ESM" reading was wrong.
2. **The `.mjs` *main* runner is the weak point.** `_runEsmMain` in the
   node-compat bootstrap transpiles the entry with a whitespace-
   dependent regex and evaluates it as a wrapped script, so a minified
   `.mjs` run *as main* fails — even though the same modules load fine
   via `import()`. The launcher sidesteps this by loading through
   `import()`.
3. **The native ESM loader does not resolve bare specifiers.** A
   chunk's `import … from "fs"` is resolved as a file path (`//fs`) and
   fails — node-compat installs no custom ESM resolve hook, so native
   ESM uses SpiderMonkey's stock shell ModuleLoader, which knows
   nothing of Node builtins or `node_modules`.
4. **`using` is gated, not missing.** Firefox ESR 140.11 (the pinned
   SpiderMonkey) *contains* Explicit Resource Management, behind the
   compile define `ENABLE_EXPLICIT_RESOURCE_MANAGEMENT` (experimental,
   Nightly-default) plus a runtime pref. Not a version gap; a build-flag
   toggle.

## Non-goals (YAGNI)

- Full `Bun.*` / `bun:*` surface. `Bun.serve`, `bun:sqlite`, `bun:ffi`,
  `Bun.$`, workers, etc. are implemented only when a program we run
  needs them; until then they throw a named "not implemented" error.
- binfmt exec-path integration. This design ships the userland launcher
  and factors the handler so it can later be invoked transparently from
  `exec`, but does not touch exec authority (Phase-6 territory) now.
- Cache garbage collection.
- Codex specifically (same mechanism, a later pass).
- The deeper *runtime* gaps that only bite at real workloads
  (async `child_process`, TLS egress through the runtime event loop,
  CSPRNG, raw-mode PTY). These are tracked separately; this design gets
  a program to *boot and run*, with `--version` as milestone 1 and
  headless `-p` as the next milestone.

## Components

### 1. `bun-extract` — add a cache-aware `--prepare` mode

New invocation alongside the existing `bun-extract <binary> <outdir>`:

```
bun-extract --prepare <binary> <cache-root>
```

Behavior:

1. Locate the `__BUN` module graph (existing logic).
2. Compute a **content hash** over the `__BUN`-section bytes plus its
   length. A fast non-cryptographic hash (e.g. FNV-1a-64 or a small
   xxhash) is sufficient — this is content-addressing for a handful of
   binaries, not a security boundary. The section length is folded in
   to further reduce collision risk.
3. `cacheDir = <cache-root>/<hash>/`. If it already exists and holds a
   valid manifest, do nothing (cache hit).
4. On a miss, extract the module tree into `cacheDir`, **remapping the
   baked-in `/$bunfs/root/` absolute specifiers to `<cacheDir>/`** as
   each JS module is written. This is a literal fixed-prefix string
   replace — mechanical and complete, not a semantic/syntax transform —
   so the app's `import"/$bunfs/root/chunk-X.js"` becomes
   `import"<cacheDir>/chunk-X.js"`, which the native loader already
   resolves (absolute path specifiers work today).
5. Write `manifest.json` `{ entry, format }`.
6. Print machine-readable `CACHE=<cacheDir>` and `ENTRY=<abs entry
   path>` to stdout.

Rationale: the file-touching work (reading ~200 MB, hashing,
extracting, writing ~48 MB) stays in the fast native program that
already streams the binary. The remap is done here because this code
already rewrites every JS byte on the way out.

### 2. `bun-run.js` — run-orchestration bootstrap (runs on spidermonkey-node)

Installed at `/usr/lib/kandelo/bun-run.js`. Invoked as
`node /usr/lib/kandelo/bun-run.js <binary> [app args…]`.

1. `spawnSync bun-extract --prepare <binary> <cache-root>` — a one-shot
   that writes files and exits, so it works even with today's
   synchronous `child_process`. Parse `CACHE` / `ENTRY`.
2. Install the **Bun-global shim** (see §5) and, if the platform fix in
   §4(c) is not yet in place, `globalThis.__breq` for
   `import.meta.require`.
3. Set `process.argv` to `[argv0, ENTRY, …app args]` so the app's own
   argument parsing sees the right values.
4. `await import(ENTRY)` — native ESM loads the whole graph in this
   process. Await job-queue drain; propagate the exit code.
5. On any failure, emit a truthful error (see §5) and a non-zero exit.

### 3. `bun-run` — thin entrypoint

A minimal wrapper (thin shell script or tiny C program) installed at
`/usr/bin/bun-run` that execs
`spidermonkey-node /usr/lib/kandelo/bun-run.js "$@"`. This is the
user-facing launcher today and the exact call a future binfmt handler
makes.

### 4. spidermonkey-node platform fixes (node-compat / spidermonkey package)

The enabling platform work, each a legitimate reusable improvement:

- **(a) Bare-specifier ESM resolution.** Install a module resolve/load
  hook so the native ESM loader routes bare specifiers — Node builtins
  (`fs`, `path`, …) and `node_modules` packages — through the existing
  `require` resolver, instead of treating them as file paths. This is
  the core fix; without it no real Node ESM app loads.
- **(c) `import.meta` for native modules.** Populate
  `import.meta.{url,dirname,require}` on native ES modules
  (`import.meta.require` mapping to the node-compat require). This lets
  the extracted app run with **no** `import.meta.*` source rewriting.
  If this proves involved, the documented fallback is a trivial
  fixed-string `import.meta.require` -> `globalThis.__breq` replace done
  by `bun-extract --prepare` (same mechanical class as the path remap).
- **(d) Enable `using`.** Turn on `ENABLE_EXPLICIT_RESOURCE_MANAGEMENT`
  in `packages/registry/spidermonkey/build-spidermonkey.sh`'s mozconfig
  and rebuild. If ESR 140's implementation proves buggy in practice,
  the documented last resort is a *targeted `using`-only* lowering (not
  full bundling).
- **(b) (optional/later) native `.mjs` main.** Route `_runEsmMain`
  through the native module loader so `node app.mjs` works directly.
  Not required by the launcher (which uses `import()`), so deferred.

All runtime changes must hold on **both Node and browser hosts**
(host-runtime parity contract).

### 5. Bun-global shim (thin, Claude-driven)

A small `globalThis.Bun` provided by `bun-run.js`, covering only what
the programs we run touch: `which`, `file`, `write`, `spawn`,
`stringWidth`, `stripANSI`, `gc`, `deepEquals`, `version`,
`isStandaloneExecutable`, and similar. **Every unimplemented member is a
getter/function that throws `Bun.<name> not implemented` — never a
silent no-op.** The surface grows only when a real program needs more.

## Data flow

```
bun-run /usr/bin/claude --version
  -> spidermonkey-node /usr/lib/kandelo/bun-run.js /usr/bin/claude --version
     -> bun-extract --prepare /usr/bin/claude /var/cache/kandelo/bun-run
        (hit: instant;  miss: hash, extract 1819 modules, remap, cache)
     -> CACHE=/var/cache/kandelo/bun-run/<hash>  ENTRY=<dir>/cli.mjs
     -> install Bun shim; process.argv = [node, ENTRY, --version]
     -> import(ENTRY)   # native ESM loads the graph
  -> "2.1.259 (Claude Code)"
```

## Caching + ephemerality invariant (hard rule)

- Cache root is a **volatile tmpfs region** (`/var/cache/kandelo/bun-run/`).
- Keyed by `__BUN`-section hash; a cheap `(path, size)` probe precedes
  hashing on repeat runs.
- **The extracted JS is always reproducible from the binary and must
  NEVER be persisted.** Any future FS-persistence mechanism must
  explicitly exclude this tree, and it must never be presented as a
  durable/verified image (browser-and-user persistence contract).
- GC of stale `<hash>` dirs is deferred until it matters.

## Error handling — truthful boundaries

Per the platform-values and debugging-and-POSIX contracts, every gap is
a visible boundary, never a faked success:

- Input is not a Bun executable (no `__BUN`/trailer) -> clear
  "unsupported format" error, non-zero exit.
- Extraction fails -> surfaced, no silent fallback.
- A `Bun.*` member the program calls is unimplemented -> named throw.
- A bare dependency is genuinely absent (e.g. `ws`) -> real
  `MODULE_NOT_FOUND`.
- A missing runtime capability (async subprocess, TLS, raw-mode) that a
  later milestone needs -> surfaced as the real platform gap it is.

## Testing

- **`bun-extract --prepare`**: extend `host/test/bun-extract-guest.test.ts`
  with cache miss then hit (second run is instant / does not re-extract)
  and remap correctness (extracted specifiers point at `<cacheDir>`) on
  the synthetic fixture, in-kernel.
- **spidermonkey-node fixes**: targeted in-kernel tests — a native ESM
  module doing `import … from "fs"` and from a staged `node_modules`
  package resolves; `import.meta.require`/`url`/`dirname` are populated;
  a `using` declaration parses and runs. Run on **both Node and browser
  hosts**.
- **End-to-end**: `bun-run <real 207 MB Claude ELF> --version` in-kernel
  returns the version string (milestone 1). Headless `-p` is the next
  milestone and is expected to surface the deeper runtime gaps.
- Existing `bun-extract` in-kernel + scaling tests continue to pass.

## Phasing

1. `bun-extract --prepare` (hash + cache + remap) and its tests.
2. spidermonkey-node fix (a) bare-specifier resolution + (c)
   `import.meta`, with targeted tests, on both hosts.
3. `using` build flag (d) + rebuild; verify a `using` program parses.
4. `bun-run.js` bootstrap + `bun-run` entrypoint + Bun-global shim.
5. End-to-end `bun-run claude --version` in-kernel (milestone 1).
6. (Later) headless `-p`; then hoist the handler into the exec path
   (binfmt, Phase-6-dependent); then Codex.

## Open risks

- **`using` flag stability** in ESR 140 (experimental) — fallback is
  targeted lowering.
- **Browser-host parity** for the ESM-resolver and `import.meta` fixes —
  must be validated on both hosts, not Node-only.
- **ABI/rebuild cost** — node-compat changes require a spidermonkey-node
  rebuild per iteration; batch the (a)+(c)+(d) changes into as few
  rebuilds as possible.
- **Cache path safety** — the `__BUN`-section hash must be stable across
  runs and independent of the binary's VFS path.
