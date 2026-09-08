# Synchronous `require()` of an ES module in a dependency cycle (Milestone 2 Phase F) — Design

**Status:** Approved design; implementation not started
**Date:** 2026-09-05

## Why

Headless `claude -p` on spidermonkey-node now loads the whole 1819-module
graph and runs deep into main init, but dies with:

```
InternalError: module record has unexpected status: Evaluating
  __kandeloRequireModule@kandelo:spidermonkey-node-bootstrap
  require@... → cli.mjs → _runCommonJsMain
```

A minimal reproduction (confirmed, then removed as throwaway) pins the cause:
two `"type":"module"` files that `require()` each other in a cycle.

```js
// cycA.mjs
export const a = "A";
const B = import.meta.require("/app/cycB.mjs");   // sync require, mid-eval
export function getB() { return B && B.b; }
// cycB.mjs
export const b = "B";
const A = import.meta.require("/app/cycA.mjs");   // back to cycA (Evaluating)
export function getA() { return A && A.a; }
// main.cjs
const A = require("/app/cycA.mjs");
```

`require(cycA)` evaluates cycA; partway through, cycA `require`s cycB; cycB
`require`s cycA — which is still on the evaluation stack (status
`Evaluating`). The result today is
`CYCERR InternalError module record has unexpected status: Evaluating`.

Node handles exactly this: `require()` of an ES module that is mid-evaluation
in a cycle returns that module's **partial namespace** (the exports already
initialized before the cyclic edge), just as circular CommonJS `require`
returns partial exports. Real Claude Code has such a cycle on its `-p` path,
so closing this unblocks `-p` and — more broadly — makes node-compat's
`require(esm)` correct for cyclic ESM graphs, which any real npm dependency
tree can contain.

## Root cause, precisely

The `require(esm)` seam added in Milestone 2 Phase B —
`ModuleLoader::requireModuleNamespace` in
`packages/registry/spidermonkey/patches/0018-kandelo-require-module.patch`,
exposed as `_nodeNative.__kandeloRequireModule(path)` — does, unconditionally:

```
module = loadAndParse(path)     // hits the shared per-path module registry
JS::ModuleLink(module)          // link
JS::ModuleEvaluate(module)      // evaluate  <-- throws if already Evaluating
... inspect the returned top-level promise ...
```

`loadAndParse` returns the module already registered for `path`. On a cyclic
`require`, that module's status is already `Evaluating` (or `EvaluatingAsync`),
and `JS::ModuleEvaluate` on a non-`Linked` module makes the engine throw
`module record has unexpected status: Evaluating`. The seam never checks the
module's status; it assumes every call is a fresh load.

## Goals / non-goals

**Goals:**
- `require()` (and `import.meta.require` / the Bun `__breq` helper) of an ES
  module that is **mid-evaluation in a cycle** returns that module's partial
  namespace instead of throwing — matching Node's circular `require(esm)`.
- `require()` of an ES module that is **already fully evaluated** returns its
  namespace (and, if it evaluated to an error, rethrows that stored error
  rather than handing back a broken namespace).
- The existing fresh-load behavior is unchanged: fresh module → link +
  evaluate → Fulfilled ⇒ namespace, Pending (top-level await) ⇒
  `ERR_REQUIRE_ASYNC_MODULE`, Rejected ⇒ rethrow.
- A module reached via a cycle while its **top-level await is still settling**
  (`EvaluatingAsync`) cannot complete synchronously, so it throws
  `ERR_REQUIRE_ASYNC_MODULE` — the same honest boundary as a direct
  `require()` of a pending-TLA module.
- The confirmed cycle repro becomes a permanent regression guard.

**Non-goals:**
- Changing the native `import` / dynamic `import()` paths. They already handle
  cycles correctly (the engine's own module machinery); only the synchronous
  `require` seam re-enters `ModuleEvaluate` incorrectly.
- Making `claude -p` complete a query (later phases — TLS egress, CSPRNG,
  async subprocess). This phase only makes cyclic `require(esm)` correct.
- Full fidelity of partial-namespace timing beyond what SpiderMonkey's module
  records already expose. Uninitialized bindings observed mid-cycle are in the
  temporal dead zone and throw `ReferenceError` on access — this matches Node.

## Design

All changes are in `ModuleLoader::requireModuleNamespace`
(patch `0018`). Between `loadAndParse` and the current
link/evaluate, branch on the module's status. Because patch `0018` bumps no
ABI surface (it is a SpiderMonkey shell C++ change compiled into `node.wasm`,
no kernel export / syscall / struct), this remains ABI-neutral.

### Status branch

Obtain the module status once after `loadAndParse` (before any
`ModuleLink`/`ModuleEvaluate`). The candidate public API is
`JS::GetModuleStatus(module)` returning the `JS::ModuleStatus` enum
(`Unlinked`, `Linking`, `Linked`, `Evaluating`, `EvaluatingAsync`,
`Evaluated`); if that public accessor is not available in this ESR 140 tree,
the shell may read it via the internal `js::ModuleObject` (the shell is part
of the engine build, and `ModuleLoader.cpp` already includes engine-internal
headers). The implementer confirms the exact API before landing and records
which was used.

Behavior per status:

- **`Unlinked`** (fresh, the common case): `JS::ModuleLink` then
  `JS::ModuleEvaluate`, then the existing promise-state handling
  (Fulfilled ⇒ namespace; Pending ⇒ `ERR_REQUIRE_ASYNC_MODULE`; Rejected ⇒
  rethrow the rejection value). Unchanged from today.
- **`Linking`**: should not be observable at seam entry (linking is
  synchronous within `ModuleLink`); treat as fresh — attempt `ModuleLink`
  (which will be a no-op or fail loudly) then evaluate. Do not special-case
  beyond a defensive comment.
- **`Linked`** (linked by a prior `import`/`import()` but not yet evaluated):
  do **not** re-link; go straight to `JS::ModuleEvaluate` + the existing
  promise-state handling.
- **`Evaluating`** (the cycle case — module is an ancestor on the current
  evaluation stack): do **not** link or evaluate. Return
  `JS::GetModuleNamespace(module)` (partial namespace).
- **`EvaluatingAsync`** (reached via a cycle while a top-level await is still
  settling): cannot complete synchronously → throw the same
  `ERR_REQUIRE_ASYNC_MODULE` error the Pending branch already constructs.
  Factor the error-construction into a small helper so the Pending branch and
  this branch share it.
- **`Evaluated`** (already fully evaluated): if the module evaluated to an
  error, rethrow that stored error (candidate API
  `JS::GetModuleEvaluationError(module)`, or the internal
  `ModuleObject::evaluationError()`); otherwise return
  `JS::GetModuleNamespace(module)`. Do not re-evaluate.

### Shared helpers

- A `returnNamespace(cx, module, rval)` helper: `GetModuleNamespace`, null
  check, `rval.setObject`. Used by the `Evaluating`, `Linked`-after-eval,
  `Evaluated`-clean, and existing success paths.
- A `throwRequireAsync(cx, path)` helper: build the
  `"require() of ES Module %s with top-level await is not supported"` error
  and attach `.code = "ERR_REQUIRE_ASYNC_MODULE"` (the exact logic already in
  the Pending branch). Used by the Pending branch and the `EvaluatingAsync`
  branch.

Keeping these as helpers avoids duplicating the (subtle, exception-state)
error-synthesis and namespace logic across branches.

### Why this matches Node

Node's CommonJS loader, on `require()` of an ESM module already on the
evaluation stack, returns the module's namespace object whose not-yet-executed
bindings are uninitialized (TDZ). SpiderMonkey's `GetModuleNamespace` on an
`Evaluating` module yields the same shape: bindings evaluated before the cyclic
edge are live; later ones throw `ReferenceError` on access until initialized.
So returning the namespace for `Evaluating`/`Evaluated` is the faithful
behavior, and the cycle completes: in the repro, cycB sees `A.a === "A"`
(initialized before cycA's cyclic `require`), finishes, and cycA then sees
`B.b === "B"`.

**The returned namespace is a live binding view, not a snapshot.** This is the
key ESM-vs-CJS distinction. A Module Namespace Exotic Object's **keys are fixed
at link time** — every `export`ed name is present from the moment the module is
linked, before any of its code runs — so exports do **not** appear
incrementally the way CJS `exports.x = …` adds properties over time
(`Object.keys(ns)` returns the full export list immediately). Its **values are
live**: reading a key before the module runs that export's initializer throws
`ReferenceError` (TDZ); reading the same key later, after the requiree has run
the initializer, returns the value — through the *same* object. So a cyclic
requirer that captures the namespace and reads a not-yet-initialized export
*later* observes the value fill in. Returning the real `GetModuleNamespace`
(rather than copying it) is what preserves this liveness; node-compat's
`_moduleCache[resolved] = { exports: ns }` caches that same live reference.

## Testing (kept — extends `host/test/esm-probe-guest.test.ts`)

Add self-contained fixtures (inlined, matching the existing pattern) and cases:

1. **Cyclic `require(esm)` returns partial namespaces (the fix).** The
   confirmed repro: `cycA`/`cycB` in a `type:module` dir that
   `import.meta.require` each other, driven by a CJS `require("/app/cycA.mjs")`.
   Assert the cycle resolves — e.g. prints `CYC A B` (cycA.a === "A",
   cycA.getB() === "B") — instead of the pre-fix
   `unexpected status: Evaluating`.
2. **Partial-namespace TDZ.** A cyclic case where the cyclically-required
   module reads a binding of its requirer that is **not yet initialized** at
   the cyclic edge, and observes a `ReferenceError` (TDZ) — proving the
   namespace is the real live module namespace, not a snapshot.
3. **Live binding fills in later (the complement of TDZ).** A cyclic case where
   the cyclically-required module **captures** the requirer's namespace while a
   binding is still uninitialized, then reads that binding **after** the
   requirer has finished initializing it, and observes the **value** (not a
   `ReferenceError`) — proving the returned namespace is a live view whose
   values fill in over time through the same object, not a point-in-time copy.
   For example: cycA captures cycB's namespace mid-cycle; cycB later defines
   `export const late = "L"`; a function on cycA reads `nsB.late` after the
   cycle settles and gets `"L"`.
4. **Dedup still holds.** A module loaded once via `require` and once via
   `import` of the same resolved path is still one instance (the existing
   `DEDUP`/`DEDUPREV` cases must stay green).
5. **Regression:** all existing esm-probe cases (Phase A–E: bare ESM,
   import.meta, `using`, require(esm), TLA ⇒ `ERR_REQUIRE_ASYNC_MODULE`,
   symlink dedup, path/win32, ws, zlib) still pass.

Optionally, if cheaply expressible: a cyclic `require` that reaches an
`EvaluatingAsync` (top-level await) module throws `ERR_REQUIRE_ASYNC_MODULE`.
If a reliable in-fixture trigger is impractical, note it as covered by the
shared helper and the direct-TLA case rather than adding a flaky test.

## Rebuild & acceptance (Phase G seed)

One `node.wasm` rebuild after the patch edit
(`scripts/dev-shell.sh ./run.sh build spidermonkey-node`). Acceptance:
- the new esm-probe cases green and no regression, and
- a throwaway `claude -p` re-run (isolated config, dummy key,
  `enableTcpNetwork`) gets **past** the `unexpected status: Evaluating`
  error; report the new first blocker verbatim as the Phase G seed (expected
  to move toward the deep runtime gaps — TLS egress, CSPRNG, async
  child_process).

Record the cyclic-`require(esm)` support (and the `EvaluatingAsync` ⇒
`ERR_REQUIRE_ASYNC_MODULE` boundary) in `docs/posix-status.md` alongside the
existing `require(esm)` entry.

## Risks

- **Exact SpiderMonkey status/error API.** `JS::GetModuleStatus` /
  `JS::GetModuleEvaluationError` may differ by name/availability in this ESR
  140 tree. Mitigation: the shell can use the internal `ModuleObject`
  accessors (it is part of the engine build); the implementer confirms and
  records which API is used, mirroring how `0015`/`0018` already reach into
  the shell ModuleLoader.
- **`Linked`-but-not-evaluated reached via the seam.** A module linked by a
  prior `import` but not yet evaluated must be evaluated (not skipped) so its
  namespace is populated. The `Linked` branch evaluates; only `Evaluating`/
  `EvaluatingAsync`/`Evaluated` skip evaluation. The dedup tests guard against
  a regression here.
- **Errored-`Evaluated` rethrow.** If the stored-evaluation-error accessor is
  unavailable, the fallback is to return the namespace of an errored module
  (as today a second require would), which is a lesser boundary but not a
  crash; the implementer notes it if the accessor cannot be used.
- **Partial namespace semantics.** Returning a mid-evaluation namespace is
  intended (matches Node); a consumer that reads an uninitialized binding gets
  a `ReferenceError`, which is correct, not a defect to paper over.
- **Rebuild cost / cross-worktree cache** — same as prior phases; a single
  rebuild after the patch edit.
