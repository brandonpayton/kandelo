# Faithful `vm` module with real context isolation (Milestone 2 Phase H) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give spidermonkey-node a faithful Node `vm` module with real, isolated contexts (sandbox-backed global, honored `codeGeneration`), so headless `claude -p` gets past `TypeError: Vt.runInContext is not a function`.

**Architecture:** A new SpiderMonkey shell C seam (`js/src/shell/js.cpp`, new sequential patch) exposes real isolated globals backed by a JS sandbox object plus compile/eval-in-realm helpers on `__kandeloNodeNative`; `adapter.js` delegates them through the `_nodeNative` whitelist; `bootstrap.js`'s `vm` module becomes the faithful JS surface over the seam. A throwaway spike (Task 1) first confirms the load-bearing sandbox-backed-global + `codeGeneration` mechanism, since modern `JSClassOps` lacks get/set interceptors and the achievable contextify fidelity must be measured before the real build.

**Tech Stack:** SpiderMonkey ESR 140 shell/engine C++ compiled into `node.wasm`; node-compat `bootstrap.js` + `adapter.js`; in-kernel Vitest (`host/test/esm-probe-guest.test.ts`) via `runCentralizedProgram`.

**Spec:** `docs/superpowers/specs/2026-09-06-vm-context-isolation-design.md`

## Global Constraints

- No app-shaped compromises: implement Node `vm` semantics faithfully; the only permitted divergence is a genuine WebAssembly/SpiderMonkey engine limit, recorded in `docs/posix-status.md` with its reason — never a silent shortcut.
- ABI-neutral: shell/engine C++ compiled into `node.wasm`; no kernel export/syscall/`repr(C)` struct/`abi/snapshot.json` change; no `ABI_VERSION` bump.
- Patches apply **sequentially** after 0015–0019: author hunks against the **post-0019** source and verify by applying 0001..00XX to a fresh pristine copy at `~/.cache/kandelo/source-only/source-only-v1/compiled/programs/.spidermonkey-*/recipe-work/spidermonkey-source` (only the `js/` subtree is needed for the shell patches; non-`js/` patches "fail" file-not-found on a `js/`-only copy — that is expected, not a real failure).
- **Author C++ patches via a real `diff`** (base = post-0019 source, new = edited copy), never hand-authored hunks. Fix hunk counts only if diff didn't produce them.
- SpiderMonkey include-order style check (`check_spidermonkey_style.py`) runs in the `misc` make tier and fails the build: non-`js/` internal headers before `js/` headers, alphabetical within a group.
- A seam added before `DefineKandeloNodeNative` (early in `js.cpp`) must be **self-contained**: `sandbox_class` / `SetStandardRealmOptions` are defined *later* in the file. Use `JS::DefaultGlobalClassOps` and inline `JS::RealmOptions`.
- `_nodeNative` is an **explicit whitelist** in `packages/registry/spidermonkey/node-compat/adapter.js` — every new native MUST be delegated there or it is `undefined` to `bootstrap.js`.
- `run.sh` truncates build logs — redirect builds to a file (`> /tmp/xxx.log 2>&1`) to read the real compiler/style error.
- Build: `scripts/dev-shell.sh ./run.sh build spidermonkey-node` (~35 min). Batch edits into ONE rebuild per implementation task.
- Throwaway `claude -p` acceptance uses isolated env (`HOME=/root`, `CLAUDE_CONFIG_DIR=/root/.claude`, `PATH=/usr/bin:/bin`), a DUMMY `ANTHROPIC_API_KEY`, `enableTcpNetwork: true`, `CLAUDE_BUN_ELF=/tmp/cc-inspect/lx259/package/claude`. Never commit throwaways; never use real credentials.
- Foundation already committed: patch 0012 (`evalScriptAsFunction` pattern), 0015–0019; the core-isolation spike proved `JS_NewGlobalObject` + `JS::InitRealmStandardClasses` + `JS::Evaluate`-in-realm + `cx->compartment()->wrap` works.

---

### Task 1: SPIKE — confirm the sandbox-backed global + `codeGeneration` mechanism (throwaway)

**Files (all throwaway — deleted at task end):**
- Create: `packages/registry/spidermonkey/patches/0097-spike-vm-contextify.patch` (temp)
- Modify (temp, revert with `git checkout` at end): `packages/registry/node-compat/bootstrap.js` (wire `vm.createContext`/`runInContext` to the spike seam), `packages/registry/spidermonkey/node-compat/adapter.js` (delegate the spike natives)
- Create: `host/test/zz-vm-contextify-spike.throwaway.test.ts`

**Interfaces:**
- Produces (for Task 2, as findings in the report — NOT committed code): the confirmed contextify mechanism (which `JSClassOps` hooks — `resolve`, `newEnumerate`, `addProperty`, `delProperty` — deliver which behaviors), the achievable fidelity (full-live vs. a named engine boundary), and the working `codeGeneration`-disable API.

**Goal of this task:** answer four questions in-kernel, then throw the code away. Modern `JSClassOps` has no `getProperty`/`setProperty`, so full live get/set interception on a global is not guaranteed; measure what IS achievable.

- [ ] **Step 1: Author the spike C seam via real diff.** Build a post-0019 source copy and add a sandbox-backed global to `js.cpp` just before `DefineKandeloNodeNative`.

```bash
cd <repo-root>
SRC="$(find ~/.cache/kandelo -path '*recipe-work/spidermonkey-source' -type d | head -1)"
PDIR="$(pwd)/packages/registry/spidermonkey/patches"
W=$(mktemp -d); mkdir -p "$W/base" "$W/new"
cp -R "$SRC/js" "$W/base/js"; cp -R "$SRC/js" "$W/new/js"
for D in base new; do for pf in "$PDIR"/00[01]*.patch; do patch -p1 -N -d "$W/$D" < "$pf" >/dev/null 2>&1; done; done
# then edit "$W/new/js/src/shell/js.cpp" with the C below, and:
diff -u --label a/js/src/shell/js.cpp --label b/js/src/shell/js.cpp \
  "$W/base/js/src/shell/js.cpp" "$W/new/js/src/shell/js.cpp" \
  > "$PDIR/0097-spike-vm-contextify.patch"
```

The C to add to `"$W/new/js/src/shell/js.cpp"` (immediately before `static bool DefineKandeloNodeNative`). This is the *first mechanism to try*: `resolve` copies a missing global name from the sandbox on first access (reads), `addProperty` mirrors a newly-added global back onto the sandbox (writes/`var`/`function`), `newEnumerate` lists the sandbox's keys, `delProperty` deletes from the sandbox. The sandbox is stored in a reserved slot.

```cpp
// SPIKE (throwaway): sandbox-backed global. Reserved slot 0 holds the sandbox.
enum { KandeloVmSandboxSlot = 0 };

static JSObject* KandeloVmSandbox(JSObject* global) {
  Value v = JS::GetReservedSlot(global, KandeloVmSandboxSlot);
  return v.isObject() ? &v.toObject() : nullptr;
}

static bool KandeloVmResolve(JSContext* cx, HandleObject obj, HandleId id,
                             bool* resolved) {
  *resolved = false;
  RootedObject sandbox(cx, KandeloVmSandbox(obj));
  if (!sandbox) return true;
  RootedObject sb(cx, sandbox);
  if (!JS_WrapObject(cx, &sb)) return false;
  bool has = false;
  if (!JS_HasPropertyById(cx, sb, id, &has)) return false;
  if (!has) return true;
  RootedValue v(cx);
  if (!JS_GetPropertyById(cx, sb, id, &v)) return false;
  if (!JS_DefinePropertyById(cx, obj, id, v, JSPROP_ENUMERATE)) return false;
  *resolved = true;
  return true;
}

static bool KandeloVmAddProperty(JSContext* cx, HandleObject obj, HandleId id,
                                 HandleValue v) {
  RootedObject sandbox(cx, KandeloVmSandbox(obj));
  if (!sandbox) return true;
  RootedObject sb(cx, sandbox);
  if (!JS_WrapObject(cx, &sb)) return false;
  RootedValue val(cx, v);
  if (!JS_WrapValue(cx, &val)) return false;
  return JS_SetPropertyById(cx, sb, id, val);
}

static bool KandeloVmDelProperty(JSContext* cx, HandleObject obj, HandleId id,
                                 JS::ObjectOpResult& result) {
  RootedObject sandbox(cx, KandeloVmSandbox(obj));
  if (sandbox) {
    RootedObject sb(cx, sandbox);
    if (!JS_WrapObject(cx, &sb)) return false;
    if (!JS_DeletePropertyById(cx, sb, id)) return false;
  }
  return result.succeed();
}

static bool KandeloVmNewEnumerate(JSContext* cx, HandleObject obj,
                                  JS::MutableHandleIdVector props,
                                  bool enumerableOnly) {
  RootedObject sandbox(cx, KandeloVmSandbox(obj));
  if (!sandbox) return true;
  RootedObject sb(cx, sandbox);
  if (!JS_WrapObject(cx, &sb)) return false;
  return JS_Enumerate(cx, sb, props);
}

static const JSClassOps kandeloVmGlobalClassOps = {
    KandeloVmAddProperty,   // addProperty
    KandeloVmDelProperty,   // delProperty
    nullptr,                // enumerate
    KandeloVmNewEnumerate,  // newEnumerate
    KandeloVmResolve,       // resolve
    nullptr,                // mayResolve
    nullptr,                // finalize
    nullptr,                // call
    nullptr,                // construct
    JS_GlobalObjectTraceHook,  // trace
};
static const JSClass kandeloVmGlobalClass = {
    "KandeloVmGlobal", JSCLASS_GLOBAL_FLAGS | JSCLASS_HAS_RESERVED_SLOTS(1),
    &kandeloVmGlobalClassOps};

// __kandeloVmSpikeMake(sandbox, disableCodegen) -> contextified global.
static bool KandeloVmSpikeMake(JSContext* cx, unsigned argc, Value* vp) {
  CallArgs args = CallArgsFromVp(argc, vp);
  RootedObject sandbox(cx);
  if (args.length() >= 1 && args[0].isObject()) sandbox = &args[0].toObject();
  bool disableCodegen = args.length() >= 2 && ToBoolean(args[1]);

  JS::RealmOptions options;
  options.creationOptions().setNewCompartmentAndZone();
  RootedObject global(cx, JS_NewGlobalObject(cx, &kandeloVmGlobalClass, nullptr,
                                             JS::DontFireOnNewGlobalHook,
                                             options));
  if (!global) return false;
  {
    JSAutoRealm ar(cx, global);
    if (!JS::InitRealmStandardClasses(cx)) return false;
    if (disableCodegen) {
      // Disable eval()/Function() inside this realm.
      JS::SetRealmDynamicCodeGenerationEnabled(cx, false);
    }
    RootedObject sb(cx, sandbox);
    if (sb && !JS_WrapObject(cx, &sb)) return false;
    JS::SetReservedSlot(global, KandeloVmSandboxSlot,
                        sb ? ObjectValue(*sb) : UndefinedValue());
  }
  RootedObject wrapped(cx, global);
  if (!cx->compartment()->wrap(cx, &wrapped)) return false;
  args.rval().setObject(*wrapped);
  return true;
}

// __kandeloVmSpikeRun(code, ctxGlobal) -> eval code in ctxGlobal, wrap result.
static bool KandeloVmSpikeRun(JSContext* cx, unsigned argc, Value* vp) {
  CallArgs args = CallArgsFromVp(argc, vp);
  if (args.length() < 2 || !args[0].isString() || !args[1].isObject()) {
    JS_ReportErrorASCII(cx, "__kandeloVmSpikeRun(code, ctx)");
    return false;
  }
  RootedString codeStr(cx, args[0].toString());
  RootedObject global(cx, UncheckedUnwrap(&args[1].toObject()));
  AutoStableStringChars chars(cx);
  if (!chars.initTwoByte(cx, codeStr)) return false;
  {
    JSAutoRealm ar(cx, global);
    if (!JS_IsGlobalObject(global)) { JS_ReportErrorASCII(cx, "not a context"); return false; }
    JS::CompileOptions opts(cx);
    opts.setFileAndLine("kandelo-vm-spike", 1);
    mozilla::Range<const char16_t> r = chars.twoByteRange();
    JS::SourceText<char16_t> src;
    if (!src.init(cx, r.begin().get(), r.length(), JS::SourceOwnership::Borrowed) ||
        !JS::Evaluate(cx, opts, src, args.rval())) {
      return false;
    }
  }
  return cx->compartment()->wrap(cx, args.rval());
}

static bool DefineKandeloNodeNative
```

And register both in the `DefineKandeloNodeNative` funcs list (add after the `__kandeloRequireModule` line):

```cpp
      JS_FN("__kandeloVmSpikeMake", KandeloVmSpikeMake, 2, 0),
      JS_FN("__kandeloVmSpikeRun", KandeloVmSpikeRun, 2, 0),
```

- [ ] **Step 2: Delegate the spike natives in `adapter.js`** (temp). After the `__kandeloRequireModule` delegate block in the `_nodeNative` object:

```js
        __kandeloVmSpikeMake(sandbox, disableCodegen) { return native.__kandeloVmSpikeMake(sandbox, disableCodegen); },
        __kandeloVmSpikeRun(code, ctx) { return native.__kandeloVmSpikeRun(code, ctx); },
```

- [ ] **Step 3: Wire `vm` in `bootstrap.js`** (temp) — replace the `vm` module (~line 4261) so `createContext`/`runInContext` use the spike seam:

```js
    'vm': {
        runInThisContext(code) { return eval(code); },
        createContext(sandbox, opts) {
            const dis = !!(opts && opts.codeGeneration && opts.codeGeneration.strings === false);
            return _nodeNative.__kandeloVmSpikeMake(sandbox || {}, dis);
        },
        runInContext(code, ctx) { return _nodeNative.__kandeloVmSpikeRun(String(code), ctx); },
        Script: class Script { constructor(code) { this.code = code; } runInThisContext() { return eval(this.code); } },
    },
```

- [ ] **Step 4: Write the throwaway spike test** `host/test/zz-vm-contextify-spike.throwaway.test.ts` (mirror the fixture-staging pattern in `esm-probe-guest.test.ts`; a `mainvm.cjs` fixture staged into a MemoryFileSystem image, run via `runCentralizedProgram` with `programPath` = resolved `programs/spidermonkey-node.wasm`, `useDefaultRootfs:false`). The fixture:

```js
'(()=>{try{const vm=require("vm");' +
// (a) read a sandbox prop
'const ctx=vm.createContext({seed:41});const a=vm.runInContext("seed+1",ctx);' +
// (b) global assigned by run code visible on sandbox afterward
'const sb={};const c2=vm.createContext(sb);vm.runInContext("globalThis.made=7",c2);const b=sb.made;' +
// (b-live) a callback from inside sees a global written earlier in the same run
'const sb2={cb:(v)=>{globalThis.__seen=v;}};const c3=vm.createContext(sb2);' +
'vm.runInContext("var x=5; cb(x);",c3);const live=sb2.__seen;' +
// (c) isolation: outer node-compat global not visible
'globalThis.__outer=1;const iso=vm.runInContext("typeof __outer",vm.createContext({}));' +
// (d) codeGeneration:false makes eval throw inside
'const cc=vm.createContext({},{codeGeneration:{strings:false}});' +
'let ce;try{vm.runInContext("eval(\\"1\\")",cc);ce="ALLOWED";}catch(e){ce="BLOCKED:"+e.name;}' +
'console.log("SPIKE",a,b,live,iso,ce);' +
'}catch(e){console.log("SPIKEERR",(e&&e.name)||"",(e&&e.message)||e);}})();'
```
Assert nothing hard yet — log the output; the point is to observe `SPIKE 42 <b> <live> undefined BLOCKED:...`.

- [ ] **Step 5: Build once** (redirect to a file):

```bash
scripts/dev-shell.sh ./run.sh build spidermonkey-node > /tmp/vm-spike.log 2>&1
grep -nE "error:|Error 2|check_spidermonkey_style|Build complete|\[OK\]" /tmp/vm-spike.log | tail
```
If it fails to compile, read `/tmp/vm-spike.log` for the diagnostic. Likely fixes: a hook signature mismatch (match the `JSClassOps` member types exactly for this ESR — check the pristine `js/src/shell/js.cpp` `global_classOps` for reference), or `JS::SetRealmDynamicCodeGenerationEnabled` naming (if absent, grep the source for the realm code-gen-enable API and use the one that exists; record which).

- [ ] **Step 6: Run the spike + record findings.**

```bash
scripts/dev-shell.sh bash -c 'cd host && npx vitest run test/zz-vm-contextify-spike.throwaway.test.ts 2>&1 | grep -E "SPIKE"'
```
Record in the task report, for each of `SPIKE a b live iso ce`:
- `a` should be `42` (read sandbox prop);
- `b` should be `7` (write mirrors to sandbox — confirms `addProperty`);
- `live` should be `5` (callback saw the in-run global — confirms live, not boundary-copy; if `undefined`, live-during-callback is a **boundary** to document);
- `iso` should be `undefined` (isolation);
- `ce` should be `BLOCKED:...` (codeGeneration honored; if `ALLOWED`, record the correct disable API or document as a boundary).

Report which hooks/APIs delivered which behavior and any behavior that is an ESR **boundary**. This is the confirmed mechanism Task 2 productizes.

- [ ] **Step 7: Delete the spike, revert temp edits.**

```bash
git checkout -- packages/registry/node-compat/bootstrap.js packages/registry/spidermonkey/node-compat/adapter.js
rm -f packages/registry/spidermonkey/patches/0097-spike-vm-contextify.patch host/test/zz-vm-contextify-spike.throwaway.test.ts
```
No commit for this task — its deliverable is the findings in the report.

---

### Task 2: Faithful `vm` module (real patch + JS surface + tests)

**Files:**
- Create: `packages/registry/spidermonkey/patches/0020-kandelo-vm-context.patch` (new sequential patch; `js/src/shell/js.cpp`)
- Modify: `packages/registry/spidermonkey/node-compat/adapter.js` (delegate the new natives)
- Modify: `packages/registry/node-compat/bootstrap.js` (rewrite the `vm` module, ~line 4261)
- Modify: `host/test/esm-probe-guest.test.ts` (durable cases)
- Modify: `docs/posix-status.md` (faithful `vm`; any documented boundary from Task 1)

**Interfaces:**
- Consumes: the mechanism Task 1 confirmed (which hooks deliver contextify, the `codeGeneration` disable API, and any documented boundary).
- Produces: `_nodeNative.__kandeloVmMakeContext(sandbox, {strings, wasm})`, `.__kandeloVmIsContext(obj)`, `.__kandeloVmRunInContext(codeOrScriptHandle, ctx, {filename, lineOffset, columnOffset, displayErrors})`, `.__kandeloVmCompile(code, {filename, lineOffset, columnOffset})`; and the `vm` module surface `createContext`/`isContext`/`runInContext`/`runInNewContext`/`runInThisContext`/`Script`/`compileFunction`.

- [ ] **Step 1: Author patch 0020 from Task 1's confirmed C, productized.** Same real-`diff` procedure as Task 1 Step 1 but committed: base = post-0019 source (`js/` subtree), new = edited. Productize the spike seam into the four functions above:
  - the sandbox-backed global class (reserved slot for the sandbox) using the hooks Task 1 confirmed;
  - `__kandeloVmMakeContext`: create the isolated global, init standard classes, apply `codeGeneration` (disable dynamic code gen when `strings===false` / `wasm===false`), store the sandbox in the reserved slot, and record the context so `isContext` recognizes it and a repeat `MakeContext` on the same sandbox returns the same context (store a back-pointer on the sandbox, e.g. a non-enumerable reserved association; if the ESR makes idempotency-by-sandbox infeasible, document it and have `createContext` return a fresh context each call only when re-contextifying is harmless — record the choice);
  - `__kandeloVmIsContext`: true iff the arg is one of our contextified globals;
  - `__kandeloVmRunInContext`: accept a code string or a compiled-script handle; enter the realm; compile (if string) with `filename`/`lineOffset`/`columnOffset`; `JS::Evaluate`/`JS::CloneAndExecuteScript`; wrap the result back; on a thrown value, wrap and rethrow to the caller (do not swallow);
  - `__kandeloVmCompile`: `JS::Compile` once, return a handle usable by later runs (store the compiled script keyed by an opaque handle object).
  Register all four in `DefineKandeloNodeNative`. Any Task-1 boundary is implemented as the documented-boundary behavior here (e.g. if live-during-callback was infeasible, the seam still syncs at run boundaries and the boundary is noted in Step 4's docs), never a silent skip.

- [ ] **Step 2: Delegate the four natives in `adapter.js`** (in the `_nodeNative` object, after the `__kandeloRequireModule` block), each guarding for the native's presence like the existing entries:

```js
        __kandeloVmMakeContext(sandbox, opts) {
            if (typeof native.__kandeloVmMakeContext !== 'function') throw new Error('native __kandeloVmMakeContext is unavailable');
            return native.__kandeloVmMakeContext(sandbox, opts);
        },
        __kandeloVmIsContext(obj) { return typeof native.__kandeloVmIsContext === 'function' && native.__kandeloVmIsContext(obj); },
        __kandeloVmRunInContext(codeOrScript, ctx, opts) {
            if (typeof native.__kandeloVmRunInContext !== 'function') throw new Error('native __kandeloVmRunInContext is unavailable');
            return native.__kandeloVmRunInContext(codeOrScript, ctx, opts);
        },
        __kandeloVmCompile(code, opts) {
            if (typeof native.__kandeloVmCompile !== 'function') throw new Error('native __kandeloVmCompile is unavailable');
            return native.__kandeloVmCompile(code, opts);
        },
```

- [ ] **Step 3: Rewrite the `vm` module in `bootstrap.js`** (~line 4261) as the faithful surface over the seam:

```js
    'vm': (() => {
        const N = _nodeNative;
        function normOpts(o) {
            if (typeof o === 'string') o = { filename: o };
            o = o || {};
            return { filename: o.filename, lineOffset: o.lineOffset | 0,
                     columnOffset: o.columnOffset | 0,
                     displayErrors: o.displayErrors !== false };
        }
        function cgFlags(o) {
            const cg = (o && o.codeGeneration) || {};
            return { strings: cg.strings, wasm: cg.wasm };
        }
        function createContext(sandbox, options) {
            return N.__kandeloVmMakeContext(sandbox || {}, cgFlags(options));
        }
        function isContext(obj) { return N.__kandeloVmIsContext(obj); }
        function runInContext(code, ctx, options) {
            return N.__kandeloVmRunInContext(String(code), ctx, normOpts(options));
        }
        function runInNewContext(code, sandbox, options) {
            const ctx = createContext(sandbox, options);
            return runInContext(code, ctx, options);
        }
        function runInThisContext(code, options) {
            // Real top-level compile+eval in the caller realm (not bare eval),
            // so filenames/stack frames are faithful.
            const o = normOpts(options);
            const h = N.__kandeloVmCompile(String(code), o);
            return N.__kandeloVmRunInContext(h, globalThis, o);
        }
        class Script {
            constructor(code, options) { this._h = N.__kandeloVmCompile(String(code), normOpts(options)); }
            runInContext(ctx, options) { return N.__kandeloVmRunInContext(this._h, ctx, normOpts(options)); }
            runInNewContext(sandbox, options) { return this.runInContext(createContext(sandbox, options), options); }
            runInThisContext(options) { return N.__kandeloVmRunInContext(this._h, globalThis, normOpts(options)); }
        }
        function compileFunction(code, params, options) {
            const o = options || {};
            const body = '(function(' + ((params || []).join(',')) + '){' + String(code) + '})';
            const ctx = o.parsingContext && isContext(o.parsingContext) ? o.parsingContext : globalThis;
            return N.__kandeloVmRunInContext(body, ctx, normOpts(o));
        }
        return { createContext, isContext, runInContext, runInNewContext,
                 runInThisContext, Script, compileFunction };
    })(),
```
(If Task 1 found `runInThisContext` in the caller realm needs the pre-existing `eval` path for some edge, keep the seam version — it is strictly more faithful. `timeout`/`breakOnSigint`: if Task 1 confirmed interrupt callbacks are unavailable, do NOT accept them silently — have `runInContext` throw a clear "vm timeout is not supported on spidermonkey-node" when `options.timeout` is set, and document it in Step 4.)

- [ ] **Step 4: Add durable tests to `host/test/esm-probe-guest.test.ts`.** Add fixtures + `it.runIf(ready)` cases (each uses the existing `runOne("/app/<main>.cjs")` helper):

```js
// fixtures (add to FIXTURES)
  "mainvmiso.cjs": '(()=>{try{const vm=require("vm");const ctx=vm.createContext({seed:41});globalThis.__vmOuter=9;const a=vm.runInContext("seed+1",ctx);const b=vm.runInContext("typeof __vmOuter",ctx);console.log("VMISO",a,b);}catch(e){console.log("VMISOERR",(e&&e.name)||"",(e&&e.message)||e);}})();',
  "mainvmctxfy.cjs": '(()=>{try{const vm=require("vm");const sb={};const c=vm.createContext(sb);vm.runInContext("globalThis.made=7",c);console.log("VMCTXFY",sb.made,vm.isContext(c),vm.isContext({}));}catch(e){console.log("VMCTXFYERR",(e&&e.name)||"",(e&&e.message)||e);}})();',
  "mainvmcodegen.cjs": '(()=>{try{const vm=require("vm");const c=vm.createContext({},{codeGeneration:{strings:false}});let r;try{vm.runInContext("eval(\'1\')",c);r="ALLOWED";}catch(e){r="BLOCKED";}console.log("VMCODEGEN",r);}catch(e){console.log("VMCODEGENERR",(e&&e.name)||"",(e&&e.message)||e);}})();',
  "mainvmcb.cjs": '(()=>{try{const vm=require("vm");let got=0;const c=vm.createContext({log:(v)=>{got=v;}});vm.runInContext("log(42)",c);console.log("VMCB",got);}catch(e){console.log("VMCBERR",(e&&e.name)||"",(e&&e.message)||e);}})();',
  "mainvmscript.cjs": '(()=>{try{const vm=require("vm");const s=new vm.Script("base+1");const a=s.runInContext(vm.createContext({base:10}));const b=s.runInContext(vm.createContext({base:20}));console.log("VMSCRIPT",a,b);}catch(e){console.log("VMSCRIPTERR",(e&&e.name)||"",(e&&e.message)||e);}})();',
  "mainvmthrow.cjs": '(()=>{try{const vm=require("vm");let m="";try{vm.runInContext("throw new Error(\'boom\')",vm.createContext({}));}catch(e){m=e.message;}console.log("VMTHROW",m);}catch(e){console.log("VMTHROWERR",(e&&e.name)||"",(e&&e.message)||e);}})();',
```

```js
// cases (add before the closing `});` of the describe block)
  it.runIf(ready)("vm: real isolation + reads sandbox", async () => {
    const r = await runOne("/app/mainvmiso.cjs");
    console.log("VMISO OUT:", JSON.stringify(r.stdout.trim()), "ERR:", r.stderr.trim().split("\n").slice(-6).join(" | "));
    expect(r.stdout).toContain("VMISO 42 undefined");
  }, 90_000);
  it.runIf(ready)("vm: contextify mirrors globals to sandbox + isContext", async () => {
    const r = await runOne("/app/mainvmctxfy.cjs");
    console.log("VMCTXFY OUT:", JSON.stringify(r.stdout.trim()), "ERR:", r.stderr.trim().split("\n").slice(-6).join(" | "));
    expect(r.stdout).toContain("VMCTXFY 7 true false");
  }, 90_000);
  it.runIf(ready)("vm: codeGeneration:false blocks eval inside", async () => {
    const r = await runOne("/app/mainvmcodegen.cjs");
    console.log("VMCODEGEN OUT:", JSON.stringify(r.stdout.trim()), "ERR:", r.stderr.trim().split("\n").slice(-6).join(" | "));
    expect(r.stdout).toContain("VMCODEGEN BLOCKED");
  }, 90_000);
  it.runIf(ready)("vm: run code calls a sandbox callback", async () => {
    const r = await runOne("/app/mainvmcb.cjs");
    console.log("VMCB OUT:", JSON.stringify(r.stdout.trim()), "ERR:", r.stderr.trim().split("\n").slice(-6).join(" | "));
    expect(r.stdout).toContain("VMCB 42");
  }, 90_000);
  it.runIf(ready)("vm: one Script reused across two contexts", async () => {
    const r = await runOne("/app/mainvmscript.cjs");
    console.log("VMSCRIPT OUT:", JSON.stringify(r.stdout.trim()), "ERR:", r.stderr.trim().split("\n").slice(-6).join(" | "));
    expect(r.stdout).toContain("VMSCRIPT 11 21");
  }, 90_000);
  it.runIf(ready)("vm: thrown error propagates to caller", async () => {
    const r = await runOne("/app/mainvmthrow.cjs");
    console.log("VMTHROW OUT:", JSON.stringify(r.stdout.trim()), "ERR:", r.stderr.trim().split("\n").slice(-6).join(" | "));
    expect(r.stdout).toContain("VMTHROW boom");
  }, 90_000);
```
(If Task 1 documented live-during-callback as a boundary, the `VMCTXFY`/`VMCB` assertions still hold — they read the sandbox after the run and call outward; only a mid-run *read-back-of-an-in-run-write via callback* would be the boundary, which none of these require. If any assertion cannot hold because of a Task-1 boundary, adjust that one case to assert the documented boundary behavior and note it.)

- [ ] **Step 5: Verify the full patch chain applies, then build once.**

```bash
# verify 0001..0020 apply to a fresh js/ copy (non-js patches "fail" file-not-found; that's fine)
SRC="$(find ~/.cache/kandelo -path '*recipe-work/spidermonkey-source' -type d | head -1)"
TMP=$(mktemp -d); cp -R "$SRC/js" "$TMP/js"
for pn in 0012 0015 0016 0017 0018 0019 0020; do pf=$(ls packages/registry/spidermonkey/patches/$pn*.patch|head -1); patch -p1 -N -d "$TMP" < "$pf" >/dev/null 2>&1 && echo "$pn OK" || echo "$pn CHECK"; done; rm -rf "$TMP"
scripts/dev-shell.sh ./run.sh build spidermonkey-node > /tmp/vm-build.log 2>&1
grep -nE "error:|Error 2|check_spidermonkey_style|does not apply|Build complete|\[OK\]" /tmp/vm-build.log | tail
```

- [ ] **Step 6: Run the full esm-probe suite — all cases pass.**

```bash
scripts/dev-shell.sh bash -c 'cd host && npx vitest run test/esm-probe-guest.test.ts 2>&1 | tail -30'
```
Expected: every case passes, including `VMISO 42 undefined`, `VMCTXFY 7 true false`, `VMCODEGEN BLOCKED`, `VMCB 42`, `VMSCRIPT 11 21`, `VMTHROW boom`, and all Phase A–G cases.

- [ ] **Step 7: Update `docs/posix-status.md`.** Add a node-compat `vm` entry describing faithful `vm` context support (real isolated contexts, contextify, honored `codeGeneration`, `Script`/`runInContext`/`runInNewContext`/`runInThisContext`/`compileFunction`), and record any Task-1 engine boundary (e.g. `timeout` unsupported, or live-during-callback limits) explicitly as a documented boundary.

- [ ] **Step 8: Throwaway `claude -p` acceptance — capture the Phase I seed.** Create `host/test/zz-claude-p-acceptance.throwaway.test.ts` (mirror `host/test/claude-run-native-guest.test.ts`: stage `/usr/bin/claude`=ELF, `/usr/bin/bun-extract`, `/usr/lib/kandelo/bun-run.js`, `/bin/sh` via `execPrograms`; empty 460 MB image; argv `["node","/usr/lib/kandelo/bun-run.js","/usr/bin/claude","-p","say hi"]`; env `HOME=/root`,`CLAUDE_CONFIG_DIR=/root/.claude`,`PATH=/usr/bin:/bin`,`ANTHROPIC_API_KEY=sk-ant-dummy-not-a-real-key`; `enableTcpNetwork:true`; `useDefaultRootfs:false`; log EXIT + last stderr). Run it, confirm `Vt.runInContext is not a function` is gone, record the new first blocker verbatim as the Phase I seed, then delete the throwaway.

- [ ] **Step 9: Commit.**

```bash
git add packages/registry/spidermonkey/patches/0020-kandelo-vm-context.patch \
        packages/registry/spidermonkey/node-compat/adapter.js \
        packages/registry/node-compat/bootstrap.js \
        host/test/esm-probe-guest.test.ts docs/posix-status.md
git commit -m "Host: Faithful vm module with real context isolation on spidermonkey-node

Implement Node's vm with real isolated contexts: a sandbox-backed global
(property ops delegate to the sandbox) gives faithful bidirectional contextify,
codeGeneration:{strings:false} disables eval/Function inside a context, and the
full createContext/isContext/runInContext/runInNewContext/runInThisContext/
Script/compileFunction surface marshals values and thrown errors across the
realm boundary. Backs the Claude Code sandbox (previously TypeError:
runInContext is not a function). C seam in the SpiderMonkey shell (patch 0020),
delegated through adapter.js, wrapped by node-compat's vm module. ABI-neutral.
<record any documented engine boundary here>.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**1. Spec coverage:** C seam (Task 2 Step 1) ✓; sandbox-backed bidirectional contextify (Task 1 confirms, Task 2 Step 1 implements) ✓; codeGeneration enforcement (Task 1 (d), Task 2 Steps 1/4) ✓; full surface createContext/isContext/runInContext/runInNewContext/runInThisContext/Script/compileFunction (Task 2 Step 3) ✓; cross-realm value+error marshalling (Task 2 Step 1, tested Step 4 VMTHROW) ✓; adapter.js delegation (Task 2 Step 2) ✓; tests incl. isolation/contextify/codegen/callback/Script/throw (Step 4) ✓; posix-status boundary recording (Step 7) ✓; -p acceptance + Phase I seed (Step 8) ✓; "no silent compromise — document boundaries" (Global Constraints + Steps 1/3/7) ✓.

**2. Placeholder scan:** Task 1 is an explicit spike (exploration is its purpose); its C is a concrete first mechanism with measured success criteria, not a placeholder. Task 2's code is concrete; the only conditionals ("if Task 1 found X") are honest dependencies on the spike's measured result, each with a defined action (implement faithfully or document a boundary) — not "TBD".

**3. Type/name consistency:** seam names (`__kandeloVmMakeContext`/`__kandeloVmIsContext`/`__kandeloVmRunInContext`/`__kandeloVmCompile`) are consistent across Task 2 Steps 1–3; the `vm` surface names match Node; test sentinels (`VMISO`/`VMCTXFY`/`VMCODEGEN`/`VMCB`/`VMSCRIPT`/`VMTHROW`) match their fixtures.
