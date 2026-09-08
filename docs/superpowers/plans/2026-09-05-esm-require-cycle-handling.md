# Cyclic `require()` of an ES module (Milestone 2 Phase F) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make synchronous `require()` of an ES module that is mid-evaluation in a dependency cycle return the module's partial live namespace (Node's circular `require(esm)` semantics) instead of throwing `module record has unexpected status: Evaluating`.

**Architecture:** One change in the require(esm) seam patch `0018` (`ModuleLoader::requireModuleNamespace` in the SpiderMonkey shell). After `loadAndParse`, read the module status once: `Evaluating` (a cycle) returns the namespace without evaluating; `Unlinked` links first; everything else evaluates as today. `JS::ModuleEvaluate` is only illegal on an `Evaluating` module — it is idempotent and correct for `EvaluatingAsync` (→ pending → `ERR_REQUIRE_ASYNC_MODULE`) and `Evaluated` (→ settled → namespace or rethrow the stored evaluation error), so no other status needs special handling. Two shared helpers de-duplicate the namespace-return and the async-error synthesis.

**Tech Stack:** SpiderMonkey ESR 140 shell C++ (`js/src/shell/ModuleLoader.cpp` via patch `0018`), compiled into `node.wasm`; node-compat `bootstrap.js` (unchanged this phase); in-kernel Vitest tests (`host/test/esm-probe-guest.test.ts`) via `runCentralizedProgram`.

**Spec:** `docs/superpowers/specs/2026-09-05-esm-require-cycle-handling-design.md`

## Global Constraints

- ABI-neutral: patch `0018` is a SpiderMonkey shell C++ change compiled into `node.wasm` — no kernel export, syscall, `repr(C)` struct, or `abi/snapshot.json` change. No `ABI_VERSION` bump.
- The patch must stay build-wired: `build-spidermonkey.sh` applies `patches/*.patch` and fails loudly on a non-applying patch. After editing patch `0018`, the rebuild must apply it cleanly (adjust the hunk's line counts).
- Do **not** change the native `import` / dynamic `import()` paths — only the synchronous `require` seam.
- Dedup through the shared per-path module registry must hold: `require`, `import`, and `import()` of one resolved path stay one instance (existing `DEDUP`/`DEDUPREV` cases stay green).
- The fresh-load `require(esm)` contract is unchanged: returns the module namespace (named exports as props, default as `.default`); pending top-level await ⇒ `ERR_REQUIRE_ASYNC_MODULE`; evaluation rejection ⇒ rethrow.
- Build under the dev shell: `scripts/dev-shell.sh ./run.sh build spidermonkey-node`. One rebuild after the patch edit.
- Throwaway `claude -p` acceptance uses an isolated env (`HOME=/root`, `CLAUDE_CONFIG_DIR=/root/.claude`), a dummy `ANTHROPIC_API_KEY`, `enableTcpNetwork: true`, and `CLAUDE_BUN_ELF=/tmp/cc-inspect/lx259/package/claude`. Never commit the throwaway; never use real credentials.

---

### Task 1: Cyclic `require(esm)` returns the partial live namespace

**Files:**
- Modify: `packages/registry/spidermonkey/patches/0018-kandelo-require-module.patch` (the `ModuleLoader.cpp` hunk: add two file-local helpers and rewrite `requireModuleNamespace`)
- Modify: `host/test/esm-probe-guest.test.ts` (add fixtures + three cases)
- Modify: `docs/posix-status.md` (extend the existing `require(esm)` entry)

**Interfaces:**
- Consumes: the existing seam `_nodeNative.__kandeloRequireModule(pathString)` (patch `0018`) and node-compat `require`'s ESM routing (unchanged); `import.meta.require` (patch `0016`) used by the fixtures.
- Produces: no new JS/TS interface. Behavior change only: cyclic `require(esm)` resolves instead of throwing.

- [ ] **Step 1: Add the three failing test cases + fixtures to `host/test/esm-probe-guest.test.ts`**

Add these fixtures to the `FIXTURES` object (alongside the existing ones). `/app` already has `"package.json": '{"type":"module"}'`, so the `.mjs`/`.js` fixtures are ES modules.

```ts
  // Cyclic require(esm): two type:module files require() each other. Before the
  // fix the second (cyclic) require lands on a still-Evaluating module and the
  // seam re-enters ModuleEvaluate -> "module record has unexpected status:
  // Evaluating". After the fix it returns the partial live namespace and the
  // cycle resolves.
  "cycA.mjs":
    'export const a="A";const B=import.meta.require("/app/cycB.mjs");export function getB(){return B&&B.b;}',
  "cycB.mjs":
    'export const b="B";const A=import.meta.require("/app/cycA.mjs");export function getA(){return A&&A.a;}',
  "maincyc.cjs":
    '(()=>{try{const A=require("/app/cycA.mjs");console.log("CYC",A.a,typeof A.getB==="function"?A.getB():"?");}catch(e){console.log("CYCERR",(e&&e.name)||"",(e&&e.message)||e);}})();',
  // TDZ: the cyclically-required module (tdzB) reads a binding of its requirer
  // (tdzA.late) that is NOT yet initialized at the cyclic edge -> ReferenceError.
  // Proves the returned namespace is the real live module namespace.
  "tdzA.mjs":
    'export const early="EA";const B=import.meta.require("/app/tdzB.mjs");export const late="LA";export function readB(){return B.readLateEarly;}',
  "tdzB.mjs":
    'export const b="B";const A=import.meta.require("/app/tdzA.mjs");export let readLateEarly;try{readLateEarly="V:"+A.late;}catch(e){readLateEarly="TDZ:"+e.name;}',
  "maintdz.cjs":
    '(()=>{try{const A=require("/app/tdzA.mjs");console.log("TDZ",A.early,A.readB());}catch(e){console.log("TDZERR",(e&&e.name)||"",(e&&e.message)||e);}})();',
  // Live binding fills in later: liveB captures liveA's namespace while liveA.late
  // is still uninitialized, then reads it AFTER the cycle settles and sees the
  // value -- proving the namespace is a live view, not a point-in-time copy.
  "liveA.mjs":
    'const B=import.meta.require("/app/liveB.mjs");export const late="LATE";export function getB(){return B;}',
  "liveB.mjs":
    'export const b="B";const A=import.meta.require("/app/liveA.mjs");export function readALate(){return A.late;}',
  "mainlive.cjs":
    '(()=>{try{const nsA=require("/app/liveA.mjs");const nsB=nsA.getB();console.log("LIVE",nsB.readALate());}catch(e){console.log("LIVEERR",(e&&e.name)||"",(e&&e.message)||e);}})();',
```

Add these three `it.runIf(ready)` cases at the end of the `describe` block (after the existing `zlib` case), mirroring the existing `runOne` pattern:

```ts
  it.runIf(ready)("cyclic require(esm) returns the partial namespace (no 'unexpected status')", async () => {
    const r = await runOne("/app/maincyc.cjs");
    // eslint-disable-next-line no-console
    console.log("CYC OUT:", JSON.stringify(r.stdout.trim()), "ERR:", r.stderr.trim().split("\n").slice(-6).join(" | "));
    expect(r.stdout).toContain("CYC A B");
    expect(r.stdout).not.toContain("CYCERR");
  }, 90_000);

  it.runIf(ready)("cyclic require(esm) exposes an uninitialized binding as TDZ", async () => {
    const r = await runOne("/app/maintdz.cjs");
    // eslint-disable-next-line no-console
    console.log("TDZ OUT:", JSON.stringify(r.stdout.trim()), "ERR:", r.stderr.trim().split("\n").slice(-6).join(" | "));
    // tdzB read tdzA.late before it was initialized -> ReferenceError (TDZ).
    expect(r.stdout).toContain("TDZ EA TDZ:ReferenceError");
  }, 90_000);

  it.runIf(ready)("cyclic require(esm) namespace is a live binding (value fills in later)", async () => {
    const r = await runOne("/app/mainlive.cjs");
    // eslint-disable-next-line no-console
    console.log("LIVE OUT:", JSON.stringify(r.stdout.trim()), "ERR:", r.stderr.trim().split("\n").slice(-6).join(" | "));
    // liveB captured liveA's ns while late was TDZ; reads "LATE" after the cycle settles.
    expect(r.stdout).toContain("LIVE LATE");
  }, 90_000);
```

- [ ] **Step 2: Run the new cases against the CURRENT `node.wasm` to verify they FAIL**

Run:
```bash
scripts/dev-shell.sh bash -c 'cd host && npx vitest run test/esm-probe-guest.test.ts -t "cyclic require"'
```
Expected: the three new cases FAIL. The first prints `CYCERR InternalError module record has unexpected status: Evaluating` (the confirmed pre-fix behavior). This proves the tests exercise the bug against the current build. (The TDZ and live cases also fail — they can't resolve until the fix lands.)

- [ ] **Step 3: Edit patch `0018` — add helpers and the status branch**

In `packages/registry/spidermonkey/patches/0018-kandelo-require-module.patch`, in the `js/src/shell/ModuleLoader.cpp` hunk, the added (`+`) region currently defines `requireModuleNamespace`. Replace that added function with the two file-local helpers followed by the rewritten function, so the applied `ModuleLoader.cpp` contains:

```cpp
// Kandelo: return the module namespace of |module| in |rval|.
static bool KandeloReturnModuleNamespace(JSContext* cx, JS::HandleObject module,
                                         JS::MutableHandleValue rval) {
  JS::RootedObject ns(cx, JS::GetModuleNamespace(cx, module));
  if (!ns) {
    return false;
  }
  rval.setObject(*ns);
  return true;
}

// Kandelo: throw an Error for require() of an ES module that cannot complete
// synchronously (pending top-level await), with .code = ERR_REQUIRE_ASYNC_MODULE.
static bool KandeloThrowRequireAsync(JSContext* cx, JS::HandleString path) {
  JS::UniqueChars pathUtf8 = JS_EncodeStringToUTF8(cx, path);
  if (!pathUtf8) {
    return false;
  }
  JS_ReportErrorUTF8(
      cx, "require() of ES Module %s with top-level await is not supported",
      pathUtf8.get());
  JS::RootedValue exn(cx);
  if (JS_GetPendingException(cx, &exn) && exn.isObject()) {
    JS_ClearPendingException(cx);
    JS::RootedObject exnObj(cx, &exn.toObject());
    JS::RootedString codeStr(cx,
                             JS_NewStringCopyZ(cx, "ERR_REQUIRE_ASYNC_MODULE"));
    if (!codeStr) {
      return false;
    }
    JS::RootedValue codeVal(cx, JS::StringValue(codeStr));
    if (!JS_DefineProperty(cx, exnObj, "code", codeVal, JSPROP_ENUMERATE)) {
      return false;
    }
    JS_SetPendingException(cx, exn);
  }
  return false;
}

// Kandelo: synchronous require() of an ES module. See patch header. Drives the
// SAME module load path import/import() use (loadAndParse hits the per-path
// registry), so require/import/import() of one resolved path share one module
// instance and namespace.
bool ModuleLoader::requireModuleNamespace(JSContext* cx, JS::HandleString path,
                                          JS::MutableHandleValue rval) {
  JS::RootedObject module(cx, loadAndParse(cx, path, nullptr));
  if (!module) {
    return false;
  }

  JS::ModuleStatus status = JS::GetModuleStatus(module);

  // Cyclic require(): |module| is an ancestor still on the evaluation stack.
  // ES Evaluate() requires status linked / evaluating-async / evaluated;
  // calling JS::ModuleEvaluate on an `evaluating` module throws
  // "module record has unexpected status: Evaluating". Return the partial live
  // namespace instead (Node circular require(esm) semantics). Not-yet-run
  // exports read as TDZ ReferenceError; they fill in live as evaluation
  // proceeds.
  if (status == JS::ModuleStatus::Evaluating) {
    return KandeloReturnModuleNamespace(cx, module, rval);
  }

  // Link only a fresh (unlinked) module. A module already linked by a prior
  // import, or evaluating-async / evaluated, must not be re-linked.
  if (status == JS::ModuleStatus::Unlinked) {
    if (!JS::ModuleLink(cx, module)) {
      return false;
    }
  }

  // Evaluate. This is idempotent and safe for linked / evaluating-async /
  // evaluated: it returns the module's top-level-capability promise. Only
  // `evaluating` (handled above) is illegal.
  JS::RootedValue evalResult(cx);
  if (!JS::ModuleEvaluate(cx, module, &evalResult)) {
    return false;
  }

  if (!evalResult.isObject()) {
    JS_ReportErrorASCII(cx, "module evaluation did not return a promise");
    return false;
  }

  JS::RootedObject evalPromise(cx, &evalResult.toObject());
  JS::PromiseState pstate = JS::GetPromiseState(evalPromise);

  // Rejected: a synchronous evaluation failure (or a stored evaluation error on
  // an already-evaluated module) -> rethrow the rejection value.
  if (pstate == JS::PromiseState::Rejected) {
    JS::RootedValue reason(cx, JS::GetPromiseResult(evalPromise));
    JS_SetPendingException(cx, reason);
    return false;
  }

  // Pending: unsettled top-level await (fresh, or reached evaluating-async via
  // a cycle) cannot complete synchronously.
  if (pstate == JS::PromiseState::Pending) {
    return KandeloThrowRequireAsync(cx, path);
  }

  return KandeloReturnModuleNamespace(cx, module, rval);
}
```

Notes for the implementer:
- The helpers are new `+` lines; the rewritten function replaces the old `+` lines. Update the hunk's line-count in the `@@ -244,6 +245,NN @@` header so `NN` equals the new number of added-side lines in that hunk (or regenerate the hunk). The rebuild in Step 4 fails loudly if the patch does not apply, so a wrong count is caught immediately.
- `JS::GetModuleStatus` and the `JS::ModuleStatus` enum are declared in `js/Modules.h` (already effectively reachable — the seam already includes `js/Modules.h` via the existing `#include`s; if the build reports it missing, add `#include "js/Modules.h"`). If `JS::GetModuleStatus` is genuinely unavailable in this ESR 140 tree, fall back to the internal accessor `module->as<js::ModuleObject>().status()` (include `vm/ModuleObject.h`) — record in the task report which API was used and why.
- Do not touch `js.cpp` or `ModuleLoader.h` — the `requireModuleNamespace` signature and the `KandeloNativeRequireModule` wiring are unchanged.

- [ ] **Step 4: Rebuild `node.wasm`**

Run:
```bash
scripts/dev-shell.sh ./run.sh build spidermonkey-node
```
Expected: the build applies patch `0018` cleanly and finishes `[OK] Build complete`. If it reports the patch did not apply, fix the hunk line counts and rebuild.

- [ ] **Step 5: Run the full esm-probe suite — all cases pass**

Run:
```bash
scripts/dev-shell.sh bash -c 'cd host && npx vitest run test/esm-probe-guest.test.ts'
```
Expected: every case passes, including `CYC A B`, `TDZ EA TDZ:ReferenceError`, `LIVE LATE`, and the unchanged `DEDUP 1 2 true` / `DEDUPREV 1 2 true` and all Phase A–E cases (bare ESM, import.meta, `using`, `REQ 43 edefault`, `TLACODE ERR_REQUIRE_ASYNC_MODULE`, `WIN32 \ \ true`, `SYM 1 2 true`, `WS function 1 true true true`, `ZLIB 2 1 true true`).

- [ ] **Step 6: Throwaway `claude -p` acceptance — capture the Phase G seed**

Create a temporary `host/test/zz-claude-p-acceptance.throwaway.test.ts` mirroring the harness in `host/test/claude-run-native-guest.test.ts` (stage `/usr/bin/claude` = the ELF, `/usr/bin/bun-extract`, `/usr/lib/kandelo/bun-run.js`, `/bin/sh` via `execPrograms`; empty 460 MB `MemoryFileSystem` image; `argv: ["node","/usr/lib/kandelo/bun-run.js","/usr/bin/claude","-p","say hi"]`; env `HOME=/root`, `CLAUDE_CONFIG_DIR=/root/.claude`, `PATH=/usr/bin:/bin`, `ANTHROPIC_API_KEY=sk-ant-dummy-not-a-real-key`; `enableTcpNetwork: true`; `useDefaultRootfs: false`). Log `EXIT`, last ~30 stdout lines, last ~90 stderr lines.

Run:
```bash
scripts/dev-shell.sh bash -c 'cd host && npx vitest run test/zz-claude-p-acceptance.throwaway.test.ts'
```
Expected: the stderr no longer contains `module record has unexpected status: Evaluating`. Record the new first blocker verbatim (the Phase G seed). Then delete the throwaway:
```bash
rm -f host/test/zz-claude-p-acceptance.throwaway.test.ts
```

- [ ] **Step 7: Update `docs/posix-status.md`**

Extend the existing `spidermonkey-node require() of an ES module (supported)` entry to note that a cyclic `require(esm)` (a module still evaluating when required again through a dependency cycle) returns the module's partial live namespace, matching Node's circular `require(esm)`; not-yet-initialized bindings read as TDZ `ReferenceError` and fill in live. Add that a module reached via a cycle while its top-level await is still settling (`EvaluatingAsync`) throws `ERR_REQUIRE_ASYNC_MODULE`, consistent with a direct `require()` of a pending-TLA module.

- [ ] **Step 8: Commit**

```bash
git add packages/registry/spidermonkey/patches/0018-kandelo-require-module.patch host/test/esm-probe-guest.test.ts docs/posix-status.md
git commit -m "Host: Cyclic require() of an ES module returns the partial namespace on spidermonkey-node

The require(esm) seam (patch 0018) linked and evaluated its target
unconditionally, so require() of a module mid-evaluation in a dependency
cycle re-entered JS::ModuleEvaluate on an already-Evaluating module and the
engine threw 'module record has unexpected status: Evaluating'. Branch on the
module status after loadAndParse: an Evaluating module (cycle) returns its
partial live namespace (Node circular require(esm) semantics) without
re-evaluating; an Unlinked module links first; every other status evaluates as
before (Evaluate is idempotent and safe for linked/evaluating-async/evaluated,
so EvaluatingAsync still yields ERR_REQUIRE_ASYNC_MODULE and an errored
Evaluated module still rethrows). Two shared helpers de-duplicate the
namespace-return and the async-error synthesis. ABI-neutral shell C++.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**1. Spec coverage:**
- Evaluating→partial namespace ✓ (Step 3 `Evaluating` branch; Step 1 `maincyc` → `CYC A B`).
- EvaluatingAsync→`ERR_REQUIRE_ASYNC_MODULE` ✓ (Evaluate idempotency → Pending → `KandeloThrowRequireAsync`; spec's optional test noted as covered by the shared helper + the existing direct-TLA case).
- Evaluated→namespace or rethrow stored error ✓ (Evaluate idempotency → Fulfilled→ns / Rejected→rethrow).
- Fresh load unchanged ✓ (`Unlinked` links; existing promise handling).
- Shared helpers `returnNamespace` / `throwRequireAsync` ✓ (`KandeloReturnModuleNamespace` / `KandeloThrowRequireAsync`).
- TDZ + live-binding tests ✓ (Steps 1/5, spec tests 2 and 3).
- Dedup + Phase A–E regression ✓ (Step 5).
- `-p` acceptance + Phase G seed ✓ (Step 6).
- posix-status.md update ✓ (Step 7).
- ABI-neutral, build-wired, native import paths untouched, one rebuild ✓ (Global Constraints).

**2. Placeholder scan:** none — all code (C++, fixtures, cases, commands) is concrete.

**3. Type/name consistency:** helper names `KandeloReturnModuleNamespace` / `KandeloThrowRequireAsync` are used consistently; `requireModuleNamespace` signature unchanged; test sentinels (`CYC A B`, `TDZ EA TDZ:ReferenceError`, `LIVE LATE`) match their fixtures.

**Deviation from spec noted:** the spec's Design describes an explicit branch for every status (including `GetModuleEvaluationError` for errored-`Evaluated`). The plan realizes the same observable per-status outcomes with a lower-risk mechanism — special-case only `Evaluating`, gate `ModuleLink` to `Unlinked`, and rely on `Evaluate()`'s documented idempotency for `evaluating-async`/`evaluated` (which routes through the existing promise-state handling: Rejected→rethrow covers the stored evaluation error, Pending→`ERR_REQUIRE_ASYNC_MODULE`). This avoids the uncertain `GetModuleEvaluationError` API while satisfying the spec's required behaviors. If, in this SM build, `Evaluate()` is not safe on `evaluating-async`/`evaluated`, fall back to the spec's explicit per-status branch.
