# Faithful `vm` module with real context isolation on spidermonkey-node (Milestone 2 Phase H) — Design

**Status:** Approved design pending user review; implementation not started
**Date:** 2026-09-06

## Why

After Phase G, headless `claude -p` runs past all module loading into
application runtime and dies at:

```
TypeError: Vt.runInContext is not a function
  chunk-zw75zfcp.js:932
```

The Claude Code app uses Node's `vm` module as a genuine **security sandbox**,
pervasively: ~32 `runInContext` sites, ~22 `createContext`, ~17 `isContext`.
Its contexts are built as `createContext({__proto__:null, log})` and
`createContext(sandbox, {codeGeneration:{strings:false, wasm:false}})` — null-
prototype globals with dynamic code generation **disabled** — and it evaluates
code strings inside them.

node-compat's current `vm` shim (`packages/registry/node-compat/bootstrap.js`
~4261) does **no** isolation at all: `createContext(sandbox)` returns the
sandbox unchanged, `runInThisContext(code)` is `eval(code)`, and there is no
`runInContext`. Making `runInContext` an `eval` would unblock the call while
**silently destroying** the very isolation and `codeGeneration:false` control
the app relies on — a silent weakening of a security boundary, which the
platform-values contract forbids.

This phase implements a **faithful** Node `vm` module with real per-context
global isolation, honoring the caller's `codeGeneration` policy. It is a real,
reusable platform capability (any sandboxing consumer benefits), not an
app-specific shim.

## Principle: no app-shaped compromises

We implement Node's documented `vm` semantics. We do **not** special-case
Claude Code, shape behavior to make one call site pass, or silently degrade a
guarantee the API promises. The only acceptable divergence is a genuine
WebAssembly/SpiderMonkey engine limit, and every such limit is recorded in
`docs/posix-status.md` as an explicit boundary with its reason — never a quiet
shortcut. Where SpiderMonkey lacks a public API, we use the internal engine
API (the shell is part of the engine build), as prior patches already do.

## Feasibility already established (spike)

A throwaway spike (removed) exposed a minimal C seam that created a real
isolated global (new compartment/zone, standard classes) via
`JS_NewGlobalObject` + a self-contained global class
(`JS::DefaultGlobalClassOps`), seeded properties from a sandbox object,
evaluated code in the realm, and wrapped the result back. It proved, running
in-kernel: value round-trip, **real isolation** (context code cannot see an
outer node-compat global), and standard classes inside the context. It built
cleanly through the full patch chain and the SpiderMonkey include-order style
check. What the spike did **not** yet prove — and what the plan's first step
must confirm — is the faithful **bidirectional contextify** mechanism and
`codeGeneration` enforcement (below).

## Design

### Component 1 — C seam (new patch, `js/src/shell/js.cpp` + a small helper header if needed)

Expose these on the shell's `__kandeloNodeNative` (registered in
`DefineKandeloNodeNative`, same place as `evalScriptAsFunction` /
`__kandeloRequireModule`), and delegate each through `adapter.js`'s explicit
`_nodeNative` whitelist (the Phase B/spike gotcha — an undelegated native is
`undefined` to bootstrap.js):

- `__kandeloVmMakeContext(sandbox, {strings, wasm})` → create a real isolated
  global (new compartment + zone) **backed by** `sandbox` (see Component 2),
  apply the code-generation policy (Component 3), initialize standard classes,
  and return the context handle (the contextified global, wrapped into the
  caller realm). Idempotent per sandbox: calling it twice on the same sandbox
  returns the same context (Node's `createContext` contextifies once).
- `__kandeloVmIsContext(obj)` → true iff `obj` is a contextified sandbox we
  created.
- `__kandeloVmRunInContext(codeOrScript, ctx, {filename, lineOffset,
  columnOffset, displayErrors})` → enter the context's realm, compile+evaluate
  the code (or run a precompiled script handle) in it, and marshal the result
  (or rethrow the thrown value) back to the caller realm.
- `__kandeloVmCompile(code, {filename, lineOffset, columnOffset})` → compile a
  script once (realm-independent, `JS::Compile`), returning a handle a later
  `runInContext`/`runInNewContext`/`runInThisContext` reuses (backs
  `vm.Script`).

`bootstrap.js`'s `vm` module (Component 4) is the thin JS wrapper over these.

### Component 2 — Faithful bidirectional contextify (the load-bearing mechanism)

Node/V8 semantics: the context's global object's properties **are** the
sandbox object's properties, live. Reading a global in run code reads the
sandbox; assigning a global (or `var`/`function` declaration) writes the
sandbox; deleting/enumerating reflect the sandbox. This must hold **during**
execution (e.g. a callback from inside the context that reads a global set
moments earlier sees it), not only at call boundaries.

The faithful SpiderMonkey mechanism is a **sandbox-backed global**: a global
`JSClass` whose property operations (`getOwnPropertyDescriptor` / lookup,
`defineProperty`, `setProperty`, `deleteProperty`, `has`, `newEnumerate`, and a
`resolve` hook) delegate to the stored sandbox object (held in a reserved
slot). This is the same category of machinery Gecko uses for `Window` and the
`nsXPCComponents`/`Sandbox` objects. The global still carries the standard
built-ins (Object, JSON, etc.) so intrinsic access is fast; only non-intrinsic
names delegate to the sandbox.

Because this is the one mechanism the spike did not prove, **plan step 1 is a
focused spike** that confirms, in-kernel: (a) run code reads a sandbox property;
(b) a global assigned in run code is visible on the sandbox object afterward
*and* to a callback during the same run; (c) `delete`/enumeration reflect the
sandbox. If a specific delegating hook proves infeasible in this ESR, that
exact sub-behavior — and only it — is documented as an engine boundary; the
rest is implemented faithfully. (Cross-realm property values are wrapped via
`JS_WrapValue`/compartment wrap, as the spike already did for results.)

### Component 3 — `codeGeneration` enforcement (security control)

`createContext(sandbox, {codeGeneration:{strings:false, wasm:false}})` must
make `eval` / `new Function` (and, for `wasm:false`, `WebAssembly.compile`
family) **throw** inside the context. Implement via the realm's dynamic code
generation setting when creating the global (the realm/CSP eval-enable state),
so the check fires on the in-context `eval`/`Function` builtins, not on the
host `JS::Evaluate` that `runInContext` itself uses. The plan's step-1 spike
also confirms this (`eval("1")` inside a `strings:false` context throws). If
the ESR's public API for this is insufficient, use the internal realm API;
we implement the guarantee, we do not skip it.

### Component 4 — `bootstrap.js` `vm` module (faithful JS surface)

Replace the current stub with the full surface, each backed by Component 1:

- `createContext(sandbox = {}, options)` → `__kandeloVmMakeContext`; returns the
  contextified sandbox (Node returns the sandbox object itself, now
  contextified). `isContext(obj)` → `__kandeloVmIsContext`.
- `runInContext(code, contextifiedObject, options)` and
  `runInNewContext(code, sandbox?, options)` (the latter = create a fresh
  context then run) → `__kandeloVmRunInContext`.
- `runInThisContext(code, options)` → evaluate in the *current* global
  (this is genuinely the caller's realm; keep it as a real top-level compile+
  evaluate with the given `filename`, not a bare `eval`, so stack frames and
  `displayErrors` are faithful).
- `class Script { constructor(code, options) }` with `runInContext`,
  `runInNewContext`, `runInThisContext` → `__kandeloVmCompile` once, then the
  run seams.
- `compileFunction(code, params, options)` → compile a function with the given
  parameter names in the target context.
- Node options honored where the engine supports them: `filename`,
  `lineOffset`, `columnOffset`, `displayErrors`. `timeout` / `breakOnSigint`:
  implement if SpiderMonkey interrupt callbacks are wired in this build;
  otherwise document as an engine boundary (an unsupported `timeout` throws or
  is documented, never silently ignored).

### Error and value marshalling

Return values and thrown exceptions cross the context realm boundary; wrap
them (`cx->compartment()->wrap`) so the caller receives usable objects/errors,
exactly as `EvalInContext` does. A thrown value inside the context is rethrown
to the caller (not swallowed).

## Testing (durable — extends `host/test/esm-probe-guest.test.ts`)

Self-contained in-kernel cases, matching the existing pattern:

1. **Isolation + round-trip:** code in a context reads a sandbox property and
   returns a value; an outer-only node-compat global is `undefined` inside.
2. **Bidirectional contextify:** a `var`/global assigned by run code appears on
   the sandbox object afterward; a value set on the sandbox before the run is
   readable by run code; a callback invoked *from inside* the context observes a
   global written earlier in the same run (proves live, not boundary-copy).
3. **`codeGeneration:{strings:false}`:** `eval("1")` / `new Function` inside the
   context throw; with codegen enabled they work.
4. **Callback into the sandbox:** run code calls a `log` function supplied on
   the sandbox and it executes in the outer realm.
5. **`vm.Script` reuse:** one compiled `Script` run in two different contexts
   yields context-specific results.
6. **`isContext`** distinguishes contextified from plain objects.
7. **Faithful errors:** a `throw` inside `runInContext` propagates as a catchable
   error to the caller with its message intact.
8. Regression: all Phase A–G esm-probe cases stay green.

## Rebuild & acceptance (Phase I seed)

One `node.wasm` rebuild after the seam + bootstrap changes (batch edits; the
plan's step-1 spike is a separate throwaway build). Acceptance: the new
esm-probe cases green, no regression, and a throwaway `claude -p` (isolated
config, dummy key, `enableTcpNetwork`, `CLAUDE_BUN_ELF`) gets **past**
`Vt.runInContext is not a function`; report the next blocker verbatim as the
Phase I seed. Record the faithful `vm` support (and any documented engine
boundary, e.g. `timeout`) in `docs/posix-status.md`.

## Risks

- **Sandbox-backed global fidelity.** The delegating property ops are the hard
  part; the ESR internal API for a fully custom global may constrain some hook
  (e.g. `newEnumerate` ordering). Mitigation: plan step-1 spike confirms the
  mechanism before the rest is built; any single infeasible sub-behavior is a
  documented boundary, not a silent gap, and the rest stays faithful.
- **`codeGeneration` API surface.** The realm code-gen-enable control may be
  internal-only in this ESR. Mitigation: use the internal API; the spike
  confirms enforcement.
- **Cross-realm wrapping.** Values/functions crossing the boundary must be
  wrapped; unwrapped access crashes. Mitigation: mirror `EvalInContext`'s
  wrapping, covered by the callback and error tests.
- **`timeout`/interruption.** May be unsupported without a wired interrupt
  callback. Mitigation: implement if available, else document as a boundary
  (not silently ignore).
- **Build/patch mechanics.** Sequential patch application (author against the
  post-0019 source; verify 0001..00XX apply to a fresh pristine copy),
  include-order style check, and non-public APIs needing internal accessors —
  all as in prior phases. Author C via real `diff`, not hand-written hunks.
- **Rebuild cost.** ~35 min per build; batch and lean on the step-1 spike to
  de-risk before the full implementation build.
