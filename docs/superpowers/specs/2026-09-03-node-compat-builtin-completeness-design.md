# Node-compat builtin-export completeness for Claude Code (Milestone 2, Phase A) — Design

**Status:** Approved design; implementation not started
**Date:** 2026-09-03

## Why

Milestone 1 (`bun-run`) proved the newest Claude Code runs on
spidermonkey-node natively for `claude --version`. A spike of headless
`claude -p` found the next blocker is **not** the anticipated runtime
gaps (async `child_process`, TLS egress, CSPRNG). It is earlier and more
mundane: the app's 1819-module ESM graph fails to **instantiate**,
because it statically imports named builtin exports that node-compat
does not provide.

The first observed failure:

```
SyntaxError: The requested module '/__kandelo_bare__/builtin/fs/promises'
  doesn't provide an export named 'link'
```

A `named` import that the module does not export fails at **link time —
even if the code never calls it**, so one missing export halts the whole
graph. `--version` never loaded the offending chunk; `-p` loads far more
of the graph and surfaces it.

Static analysis of the app's builtin named-imports (30 modules, ~180
names) against the current `node.wasm`'s actual `Object.keys(require(m))`
found **40 missing named exports across 16 modules** (14 existing
modules plus 2 whole submodules). Providing them lets the graph
instantiate — the prerequisite for everything Milestone 2 needs next.

This is a reusable platform improvement: it raises node-compat's Node API
completeness for any ESM program, not just Claude Code.

## Goal & non-goals

**Goal:** the Claude Code module graph **instantiates** (links) on
spidermonkey-node. Success = re-running `claude -p` no longer dies at
module linking; it fails *later* (a runtime gap or a called stub), and
we report that new first blocker as the Phase B seed.

**Non-goals:**
- Making `claude -p` actually complete a query — that is Phase B (TLS
  egress, CSPRNG, whichever stubs actually fire, tool subprocesses).
- Adding kernel syscalls. Phase A is **entirely in
  `packages/registry/node-compat/bootstrap.js`**. Any export that would
  require a new kernel syscall is a documented throwing stub for now.
- Full/faithful implementations of the hard builtins (crypto/TLS/zstd).
  Those are stubbed until Phase B shows they are actually called.

## Policy

For each of the 40 missing exports:
- **Real** if it is trivial and reuses primitives node-compat already
  has (an alias, a promisified/callbackified wrapper over an existing
  `*Sync`, a small pure-JS function, a constant).
- **Throwing stub** otherwise — a function/class that throws
  `Error("<module>.<name> is not implemented on spidermonkey-node")`.
  A stub is honest (never silently wrong), satisfies link-time, and is
  recorded as a gap. Phase B graduates the stubs that actually fire.

The classification below is a first pass. The implementer applies the
policy where reality differs — e.g. `fs.fsyncSync` is real **iff** an
`fsync` primitive is reachable in pure JS, otherwise a stub.

## The 40 missing exports

Existing modules — add these keys to their module object in
`bootstrap.js`:

| Module | Export | Real/Stub | Implementation note |
|---|---|---|---|
| `fs` | `fsyncSync` | real-if-primitive | wrap `os.fsync(fd)` if present, else stub |
| `fs` | `ftruncateSync` | real-if-primitive | wrap `os.ftruncate(fd,len)` if present, else stub |
| `fs/promises` | `constants` | real | `= fs.constants` |
| `fs/promises` | `link` | stub | hard link — no kernel syscall available |
| `fs/promises` | `lutimes` | stub | symlink utimes — no primitive |
| `fs/promises` | `opendir` | stub | `Dir` iterator object — defer |
| `fs/promises` | `statfs` | stub | no `statfs` primitive |
| `os` | `availableParallelism` | real | `() => Math.max(1, (os.cpus?.().length)||1)` |
| `os` | `devNull` | real | `'/dev/null'` |
| `os` | `version` | real | best-effort string (e.g. `''` or a uname-like value) |
| `os` | `getPriority` | real | `() => 0` |
| `os` | `setPriority` | real | no-op |
| `crypto` | `timingSafeEqual` | real | constant-time `Buffer` compare |
| `crypto` | `randomFillSync` | stub | CSPRNG — likely graduates in Phase B |
| `crypto` | `X509Certificate` | stub | class stub |
| `crypto` | `createCipheriv` | stub | |
| `crypto` | `createDecipheriv` | stub | |
| `crypto` | `createPrivateKey` | stub | |
| `crypto` | `createPublicKey` | stub | |
| `crypto` | `generateKeyPairSync` | stub | |
| `crypto` | `sign` | stub | |
| `crypto` | `verify` | stub | |
| `zlib` | `deflate` | real | `callbackify(deflateSync)` |
| `zlib` | `inflate` | real | `callbackify(inflateSync)` |
| `zlib` | `inflateRawSync` | stub | raw window — defer unless trivial |
| `zlib` | `createZstdDecompress` | stub | zstd stream — defer |
| `tls` | `rootCertificates` | real | `[]` |
| `tls` | `checkServerIdentity` | real-minimal | return `undefined` (no error); or stub |
| `tls` | `createSecureContext` | stub | |
| `util` | `getSystemErrorName` | real | errno→name via existing errno constants |
| `util` | `stripVTControlCharacters` | real | strip ANSI escape sequences |
| `util/types` | `isProxy` | real | best-effort `() => false` |
| `net` | `BlockList` | stub | minimal class whose methods throw |
| `events` | `setMaxListeners` | real | no-op / set on given emitters |
| `url` | `domainToASCII` | real-minimal | return input unchanged (no punycode) |
| `perf_hooks` | `monitorEventLoopDelay` | stub | object with no-op enable/disable/reset, `percentile→0` |
| `child_process` | `ChildProcess` | real-if-present | export the internal class `spawn` returns, else minimal `EventEmitter` subclass stub |
| `dns` | `promises` | real | `{ lookup: promisified(dns.lookup) }` |

Whole missing submodules — make `require()` resolve them:

| Submodule | Real/Stub | Implementation note |
|---|---|---|
| `path/posix` | real | `= path.posix` |
| `dns/promises` | real | `= { lookup: promisified(dns.lookup) }` (same object as `dns.promises`) |

Total: 38 exports on existing modules + 2 submodules = the 40 imports the
app needs to link.

## Where the code goes

`packages/registry/node-compat/bootstrap.js` — each builtin is defined
there as a module object; add the keys. For the two submodules, register
them in whatever table maps builtin names to module objects (so
`require('path/posix')` / `require('dns/promises')` resolve). The 0015
bare-specifier bridge already derives the ESM namespace from
`Object.keys(require(m))`, so a new key becomes importable with no patch
change.

Keep the additions grouped and readable next to each module's existing
definition; do not restructure unrelated code.

## Testing (kept — a durable guard)

`host/test/node-compat-builtin-exports.test.ts`:

1. **Link-surface guard.** A fixture module that named-imports the exact
   40-name surface (grouped by module, matching the table). Run it on
   spidermonkey-node and assert the graph **links** — i.e. it reaches
   its own code and prints a sentinel — proving no missing-export link
   error remains. This is the regression guard for the completeness
   surface.
2. **Real-behavior spot-checks.** `path.posix.join(...)`,
   `zlib.inflate(zlib.deflateSync(buf))` round-trip,
   `crypto.timingSafeEqual`, `os.availableParallelism() >= 1`,
   `util.stripVTControlCharacters`.
3. **Stub honesty.** A representative stub (e.g.
   `crypto.createCipheriv`) **throws** its named "not implemented"
   error when called (not a silent no-op).

Fixtures are inlined/in-process (self-contained, per the esm-probe
pattern) so the guard actually runs in CI.

## Rebuild & acceptance (Phase B seed)

One `node.wasm` rebuild after the edits (`./run.sh build
spidermonkey-node` under the dev shell). Acceptance:
- the new test is green, and
- a throwaway re-run of `claude -p` (isolated config, dummy key,
  `enableTcpNetwork`) no longer dies at module linking — it fails later.
  Report the new first blocker verbatim as the Phase B seed.

Also record the shipped stubs in `docs/posix-status.md` as tracked
platform gaps.

## Risks

- **Rebuild cost.** A `bootstrap.js` change triggers a `node.wasm`
  rebuild (minutes to longer if the build cache is cold). Batch all 40
  edits into one rebuild; do not rebuild per export.
- **A "real" export needs a primitive that isn't there.** Fallback is
  the policy: downgrade to a documented stub (e.g. `fs.fsyncSync`).
- **Hidden second-order link errors.** After the 40 land, the app may
  reveal further named imports that were shadowed by the first failure.
  The acceptance re-run of `-p` catches these; if any remain, they are
  the same class of fix and fold into the same task.
- **Cross-worktree build cache.** `~/.cache/kandelo/programs` is shared;
  a concurrent build in another worktree can cause transient failures —
  rebuild locally and re-run if seen (observed during Milestone 1).
