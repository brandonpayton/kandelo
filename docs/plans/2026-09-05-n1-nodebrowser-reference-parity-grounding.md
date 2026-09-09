# N1 grounding: Node/browser fork-reference capture parity (externref + GC + static-root)

Status: investigation only, no code changed. Worktree
`/Users/brandon/kandelo-abi44-reconcile`, branch
`brandonpayton/rust-first-abi44-reconcile`. All paths below are relative to
that worktree unless given as an absolute path.

## Headline correction before anything else

**This branch is currently broken for every freshly fork-instrumented
externref/GC/static-root fixture, independent of any un-gating work.**
Verified live (not from reading):

```
cd host && npx vitest run test/externref-fork-module-worker.test.ts
cd host && npx vitest run test/gc-reference-cycle-fresh-worker.test.ts \
  test/static-root-local-fork-fresh-worker.test.ts \
  test/static-root-bare-local-fork-fresh-worker.test.ts
```

All five `it()` blocks fail. The externref ones throw before capture even
starts:

```
Error: linked fork activation owner is missing env.__wpk_fork_ref_provenance_externref
    at buildImportObject host/src/worker-main.ts:2492
```

The GC/static-root ones fail their `toBe(92)` assertion with `exitCode: -1`
(worker crash) instead of the expected clean EOPNOTSUPP abort, for the same
underlying reason — the fixtures are freshly instrumented in `beforeAll` by
`tools/bin/wasm-fork-instrument`, which was rebuilt after commit `f8bb088ed`
and now unconditionally declares `__wpk_fork_ref_provenance_externref` in
**every** module it instruments. `f8bb088ed`'s own commit message says this
plainly: "Host bodies (native + Node/browser) are NOT implemented here."
`host/src/worker-main.ts:2456-2499` (`buildImportObject`) walks every
`env.__wpk_fork_*` import the module actually declares and throws if
`forkEnvImports[name]` is `undefined`; `buildForkActivationStateImports`
(`host/src/fork-activation-registry.ts:372-660`) has no entry for the new
name, so instantiation throws a `LinkError`-equivalent for any module built
by the current instrumenter. This is a P0, must-fix-first item, separate
from (but a prerequisite for) all six questions below: at minimum, bind
`__wpk_fork_ref_provenance_externref` in `buildForkActivationStateImports` to
*something* (even a no-op pass-through) before any of this work can be
validated.

## Architecture correction that changes the shape of the whole task

Read together, `crates/host-native/src/guest.rs:5356-5539` and an empirical
probe (below) establish that **externref, static-root, and typed
struct/array/i31 do not have independent host-import entry points in the
architecture `wasm-fork-instrument` currently builds.** They all funnel
through the single `__wpk_fork_ref_gc_lookup` import
(`WPK_FORK_REFERENCE_IMPORT_GC_LOOKUP`). The raw
`__wpk_fork_ref_encode_externref` / `__wpk_fork_ref_decode_externref` host
imports that `host/src/fork-activation-registry.ts:463-497` still gates are
**dead code for every module produced today** — proven by instrumenting the
repo's own externref fixture and listing its imports:

```
$ wat2wasm --enable-exceptions --enable-threads \
    host/test/fixtures/externref-local-fork-fresh-worker.wat -o raw.wasm
$ tools/bin/wasm-fork-instrument raw.wasm -o instrumented.wasm
$ node -e 'new WebAssembly.Module(require("fs").readFileSync("instrumented.wasm"))
    |> WebAssembly.Module.imports |> ...'
env __wpk_fork_ref_provenance_externref function
env __wpk_fork_ref_gc_transit table
env __wpk_fork_ref_gc_lookup function
env __wpk_fork_ref_gc_claim function
env __wpk_fork_ref_gc_i31 function
env __wpk_fork_ref_gc_define function
env __wpk_fork_ref_gc_route function
env __wpk_fork_ref_gc_payload_len function
env __wpk_fork_ref_gc_load function
env __wpk_fork_ref_gc_broker_encode function
env __wpk_fork_ref_gc_capture_layout function
env __wpk_fork_ref_gc_provenance_begin function
env __wpk_fork_ref_gc_provenance_ref function
env __wpk_fork_ref_gc_provenance_end function
```

No `__wpk_fork_ref_encode_externref` / `decode_externref` import appears, for
a fixture whose entire purpose is a plain host externref local. Root cause in
`crates/fork-instrument/src/lib.rs:456-475`: `instrument()` *unconditionally*
calls `module_gc_codec::declare()` and threads its
`encode_externref`/`decode_externref` **local wasm functions** (not host
imports; see `crates/fork-instrument/src/module_gc_codec.rs:113`,
`:1100-1110` `emit_externref_bridge`, which lowers them to
`any.convert_extern` + call into `encode_anyref`/`decode_anyref`) as
`ReferenceCodecOverrides` into `runtime::inject_linked_runtime_with_reference_overrides`
(`crates/fork-instrument/src/lib.rs:462-475`). The raw-host-import fallback in
`crates/fork-instrument/src/runtime.rs:630-657` is only reached via
`overrides.externref.unwrap_or_else(...)`, i.e. only when no override is
supplied — which `instrument()` never does. This is shared Rust
(`crates/fork-instrument`), identical for native and for
`tools/bin/wasm-fork-instrument` (the same binary Node tests use), so the
same is true on Node/browser.

Practical consequence: **do not spend effort reviving
`ENCODE_EXTERNREF`/`DECODE_EXTERNREF` in `fork-activation-registry.ts`.**
The real work for externref, static-root, *and* struct/array/i31 is one
function: `GC_LOOKUP`'s host body. Native's already-shipped, already-comment-
narrated ordering inside that one `gc_lookup` closure
(`crates/host-native/src/guest.rs:5539-5600+`) is the port target:

1. `gc_claim_lookup` — has this exact live anyref already been assigned a
   recipe this capture (dedup / cycle-back)?
2. static-root provenance lookup — is this exact anyref a registered static
   root (`StaticRootProvenance`, i.e. `ForkStaticRootCatalog.encode` on the
   TS side)?
3. `ExternRef::convert_any` + externref-provenance lookup — is this anyref
   actually a plain host externref that was registered by
   `__wpk_fork_ref_provenance_externref` at production time?
4. Miss on all three → return `0` ("unknown"), which is **not** a gate by
   itself; the guest's own bridge code then tries `GC_CLAIM` (real
   struct/array construction), which is where the *actual* gate for a
   genuinely new/unsupported kind still belongs.

This ordering is also why the plan sections below are shorter than the
question list implies: sections 1–3 below all resolve to edits inside the
same `GC_LOOKUP`/`GC_CLAIM`/`GC_DEFINE`/provenance cluster in
`fork-activation-registry.ts` and `fork-reference-transaction.ts`, layered
in the same sequence native already validated.

## 1. externref (Node/browser)

**Do not revive `encodeExternref`/`ENCODE_EXTERNREF` as the primary fix** —
see the architecture correction above; that import is unreachable for any
module the current instrumenter builds. The real edit list:

- **P0 (unblocks everything, do first):** bind
  `__wpk_fork_ref_provenance_externref` in
  `buildForkActivationStateImports` (`host/src/fork-activation-registry.ts:372-660`)
  to at least `(value: unknown) => value` so instantiation stops throwing.
  This alone should make the currently-broken tests fall back to their
  pre-`f8bb088ed` gated (exit 92) behavior instead of crashing (exit -1) —
  worth confirming as an isolated experiment before doing anything else.
- Add the missing named TS constant. `host/src/generated/abi.ts:402` already
  has the raw import descriptor (`{ module: "env", name:
  "__wpk_fork_ref_provenance_externref", params: ["externref"], results:
  ["externref"] }`, added by `f8bb088ed`), but there is **no**
  `WPK_FORK_REFERENCE_IMPORT_PROVENANCE_EXTERNREF` named export — confirmed
  by grep against every other `WPK_FORK_REFERENCE_IMPORT_*` name. The
  generator is `tools/xtask/src/dump_abi.rs` (hand-listed pairs, e.g. lines
  2446-2451 for `ENCODE_EXTERNREF`); it has no entry for
  `PROVENANCE_EXTERNREF`. Add one there and regenerate
  `host/src/generated/abi.ts` (same mechanism `f8bb088ed` used for the raw
  entry — `scripts/check-abi-version.sh update`) before writing TS that
  imports the constant by name.
- **The real capture-time registration.** Give
  `buildForkActivationStateImports`'s `[WPK_FORK_REFERENCE_IMPORT_PROVENANCE_EXTERNREF]`
  body a small, NEW, purely-local (single JS realm) provenance table — a
  `WeakMap<object, number>`-shaped registry, analogous to
  `ForkGcProvenanceRegistry` (`host/src/fork-gc-codec.ts:688`) but for
  externref. Populate it *only* from this import's body, at the exact
  moment a host-import call site returns an externref (mirrors native's
  comment at `crates/host-native/src/guest.rs:5356-5367`: "this — not a
  capture-time reverse map — is the sound half of F5's design"). Because
  production and consumption both happen in the **same process worker /
  same JS realm**, this does not need the cross-worker
  `ForkExternrefProcessOwner` (`host/src/fork-externref-process-owner.ts:37`,
  explicitly a "Kernel-Worker owner") at all — a local WeakMap keyed by
  object identity is sound for the same reason native's is: it is recorded
  at production, not inferred later by inspection.
- **`GC_LOOKUP`'s revived body** (`host/src/fork-activation-registry.ts:528-543`,
  currently `registry.markUnsupportedReferenceKind("externref or Wasm-GC
  (anyref)"); return registry.reserveGatedTransitPlaceholder();`) gets a
  third branch: after the existing dedup check and the (to-be-revived)
  static-root check both miss, consult the new provenance table (lookup
  only, **never mint**) and, on a hit, call a revived `encodeExternref`-
  shaped method that interns the value via the existing generic `intern()`
  (`host/src/fork-reference-transaction.ts:1668-1691`) — reusing the exact
  deleted body shape from `74c1c373b^` (see below) but sourcing the
  "known" answer from the new provenance table instead of
  `this.externrefs.capture(value)`.
- **Do not reintroduce `ForkExternrefTokenRecipeProvider.capture()`'s
  `normalizeUnclaimed` fallback** as the backing check. That fallback
  (`host/src/fork-worker-import-exceptions.ts:667-746`,
  `ForkWorkerLocalImportExceptionNormalizer.normalizeUnclaimedForkValue`,
  keyed by `objectTokens = new WeakMap<object, ForkExternrefToken>()` at
  line 668) mints a token for *any* previously-unseen value at **capture**
  time, with no way to distinguish "this crossed a genuine host-import
  production site" from "this is a GC-internalized anyref that reached here
  by accident." That's precisely the unsound half the campaign already
  disavowed for native (`crates/host-native/src/guest.rs:5425-5434`,
  "SOUNDNESS GUARD ... this MUST NOT fabricate a handle"). The mailbox path
  (`host/src/fork-externref-import-mailbox.ts:1229-1266`, `writeResults`)
  already does sound mint-time registration via
  `this.authority.registerForWire(...)` for **cross-worker** host imports,
  and the returned guest-visible value is already a self-describing
  `ForkExternrefToken` (`host/src/fork-reference-broker.ts:590-635`,
  `ForkExternrefTokenCache`) — but that is a different mechanism from what
  `GC_LOOKUP` needs, because `GC_LOOKUP` needs a **local-realm** lookup keyed
  by the exact anyref-converted-to-externref value the guest is asking
  about, not a wire handle.
- **Residual scope boundary, matches native exactly:** a value with no
  recorded provenance (e.g. `call_indirect`/`call_ref` landing on an
  externref-returning import — `f8bb088ed`'s own documented residual gap —
  or a genuinely GC-internalized value) must fall through to the existing
  gate, not be captured. Do not try to generalize beyond what native
  generalized to.
- **Open, unresolved by reading — name the experiment:** JS externref values
  are not restricted to objects (unlike native's boxed `Any`); a host import
  could in principle return a primitive (number/string/boolean) as an
  externref, which a `WeakMap`-keyed provenance table cannot key. Native
  has the identical limitation and punts on it explicitly (`crates/host-native/src/guest.rs:5390-5397`,
  "a future externref-producing host import with no self-describing `u32`
  payload simply has no handle to register here"). Recommend the same
  documented boundary on Node/browser rather than solving it now; confirm
  by grep that no current or near-term host import returns a
  primitive-typed externref (the `defineForkExternrefImport` /
  `ForkHostImportOwnerRuntime` descriptor shapes in
  `host/src/fork-externref-import-mailbox.ts` would be the place to check
  if this becomes live).

## 2. GC struct/array/i31 (Node/browser)

The deleted capture-side methods are fully recoverable verbatim from two
commits, and the decode-side counterpart they fed is untouched and already
Node-validated:

- `git show 74c1c373b^:host/src/fork-reference-transaction.ts` and
  `git show 74c1c373b^:host/src/fork-activation-registry.ts` have the
  pre-gate real bodies.
- The exact diffs that need reverting (with rationale) are commits
  `d8ad27833b` / `fa8add8c50` (identical content, likely a duplicate from a
  rebase) touching both files — full diffs captured during this
  investigation; the commit message itself is an accurate, itemized
  deletion manifest: `lookupGcSlot`, `claimGcSlot`, `encodeI31`,
  `capturedGcValue`, `defineGc`, the private `gcSlotValue` helper, and the
  `i31Ids` map in `ForkReferenceTransaction`; `lookupGcSlot`, `claimGcSlot`,
  `encodeI31`, `captureGcLayout`, `defineGc`, `encodeGcFromSlot`, the
  private `encodeGcObject` helper, and `beginGcProvenance` /
  `appendGcProvenanceReference` / `endGcProvenance` in
  `ForkActivationRegistry`. Also restore the `FORK_GC_LAYOUT_REQUIRES_PROVENANCE`
  and `ForkGcDefinitionProvenance` imports/interface those methods used.
- **The provenance registry these call into is not gone and not inert-by-
  omission — it is fully implemented and already wired for lifecycle safety,
  just never populated.** `ForkGcProvenanceRegistry`
  (`host/src/fork-gc-codec.ts:688-900+`, predates the 2026-09-04 deletion
  commits, untouched by them) has complete `begin` / `appendReference` /
  `end` / `lookup` / `find` methods. `ForkActivationRegistry` already
  constructs one (`host/src/fork-activation-registry.ts:700`,
  `private readonly gcProvenance = new ForkGcProvenanceRegistry();`) and
  calls its lifecycle methods (`abortPending()` at lines 1196, 1249, 1300,
  1391; `clear()` at 1525) — but `begin`/`appendReference`/`end`/`lookup`/
  `find` have zero callers anywhere in `host/src`. Reviving `beginGcProvenance`
  / `appendGcProvenanceReference` / `endGcProvenance` /
  `captureGcLayout`'s `gcProvenance.lookup(...)` call (all present verbatim
  in the `d8ad27833b` diff) is exactly "re-wire the already-built machine,"
  not new design. `crates/host-native/src/guest.rs:2683` explicitly
  documents native's `GcProvenanceRegistry` as ported *from*
  `ForkGcProvenanceRegistry::begin` — i.e. native and TS already agree on
  the design; this is the TS side catching back up to its own port.
- **The one real design gap:** the deleted `lookupGcSlot` body (pre-dating
  `__wpk_fork_ref_provenance_externref`, which landed a day later in
  `f8bb088ed`) only had two branches — dedup (`this.lookupId(value)`) and
  static-root (`this.staticRoots?.encode(value)`). It needs a third branch
  inserted (the externref-provenance lookup from section 1) to match
  native's current `gc_lookup`, which does not exist in the pre-deletion
  history verbatim — this one branch has to be written fresh, in the same
  function, following native's already-shipped ordering
  (`crates/host-native/src/guest.rs:5548-5600+`).
- **The one deliberately out-of-scope loose end:** the deleted
  `encodeGcFromSlot`'s final fallback (`fork-activation-registry.ts`,
  `d8ad27833b` diff, the "no module codec recognized the internal value... a
  hostref made by `any.convert_extern`" branch) called
  `this.currentReferences().encodeExternref(this.gcTransit.get(slot))` — the
  now-dead-code externref encoder. This is the "GC-internalized externref"
  case the commit that introduced `f8bb088ed` explicitly assigned to F6, not
  F5. Recommend reviving `encodeGcFromSlot` with this branch **still
  gated** (call `markUnsupportedReferenceKind` and keep the placeholder)
  rather than trying to route it through the new provenance mechanism —
  that keeps F6 honestly unimplemented instead of silently misclassifying
  it.

## 3. static-root (Node/browser)

`ForkStaticRootCatalog` (`host/src/fork-static-root-catalog.ts:125-236`) was
never touched by the deletion commits and is complete: `register` (harvest
at instantiation time, per its own doc comment), `encode(value)` (already a
value→recipe reverse lookup built at harvest time — the direct TS analog of
native's newly-added `StaticRootProvenance` "harvest-time reverse index"),
and `decode`. The generic `intern()` helper
(`host/src/fork-reference-transaction.ts:1668-1691`) already calls
`this.staticRoots?.encode(value)` unconditionally for *any* value flowing
through it — confirmed live today for `encodeFuncref` (a still-supported
capture path); `host/test/fork-activation-registry.test.ts:265-268`
documents this exact fact ("Probes the static-root catalog through
`encodeFuncref` ... which shares the `intern()` static-root check").

But that is not the primary static-root path. Both dedicated static-root
fixtures (`host/test/static-root-local-fork-fresh-worker.test.ts:45-67`,
`host/test/static-root-bare-local-fork-fresh-worker.test.ts:53-70`) assert
exit 92 (gated) today, and empirically (see the P0 section) currently crash
instead — because a real static root is an `anyref`-typed Wasm-GC global/
local, which reaches capture through `GC_LOOKUP`, not through any
`intern()`-based path. Un-gating static-root is therefore **the same edit as
the "static-root" branch of `GC_LOOKUP`'s revival in section 2** — restore
`lookupGcSlot`'s `this.staticRoots?.encode(value)` branch (present verbatim
in the pre-deletion diff) and remove the
`registry.markUnsupportedReferenceKind(...)` call that currently fires
before it. No new class or design work is needed; this is the smallest of
the three revivals, and — because it needs neither the externref-provenance
branch nor `claimGcSlot`/`defineGc` — **it can land before full
struct/array/i31 support**, as a strict subset of the `GC_LOOKUP` body (see
section 6).

## 4. Shared-module + artifact propagation

Two independently-propagating artifacts, with different (and asymmetric)
staleness risk:

- **`tools/bin/wasm-fork-instrument`** (from `crates/fork-instrument`,
  gitignored, not committed — confirmed via `.gitignore:8` `/tools/bin/`).
  Node's Vitest suite rebuilds this **automatically**:
  `host/test/global-setup.ts:236-248` runs
  `scripts/build-fork-instrument-tool.sh` (which itself uses a source input-
  hash gate, `scripts/fork-instrument-tool-input-hash.sh`) before any test
  file executes. So the T1 externref-provenance wrapper pass
  (`crates/fork-instrument/src/externref_provenance.rs`) and any future
  `fork-instrument` change reach every Node test transparently — no manual
  step. (Confirmed by direct observation: the binary at
  `tools/bin/wasm-fork-instrument` in this worktree is timestamped after
  `f8bb088ed` and already emits `__wpk_fork_ref_provenance_externref`.)
- **`fork_module32.wasm` / `fork_module64.wasm`** (from `crates/fork-module`,
  which statically depends on `crates/fork-codec` for `build_drive_plan` and
  friends) is **not** rebuilt by Vitest at all. It is resolved via
  `host/src/binary-resolver.ts`'s `resolveBinary("fork_module32.wasm")` from
  `local-binaries/fork_module32.wasm` (a real, present, gitignored file in
  this worktree, `.gitignore:17`) or `binaries/` (fetched release
  artifacts). The only build path found is the in-crate script
  `crates/fork-module/build-wasm.sh`, documented in
  `crates/fork-module/README.md:86-98` and invoked manually via
  `scripts/dev-shell.sh bash crates/fork-module/build-wasm.sh`, which copies
  its `target/wasm32-unknown-unknown/release/fork_module.wasm` output to
  both `local-binaries/fork_module32.wasm` and `host/wasm/fork_module32.wasm`
  (`crates/fork-module/build-wasm.sh:95-98`). **This means the shared
  decode-side substrate fix (`crates/fork-codec::drive_plan::build_drive_plan`
  Phase 0b, commit `a4fc9599f`, `crates/fork-codec/src/drive_plan.rs:454-475`)
  reaches native automatically via ordinary `cargo build`/`cargo test`, but
  reaches Node/browser only after an explicit, manual
  `crates/fork-module/build-wasm.sh` rerun.** No global-setup or CI hook
  found that does this automatically; grepped `host/test/global-setup.ts`
  and every `scripts/*.sh`/`*.ts`/`*.mjs` for `fork_module32` and
  `crates/fork-module` and found nothing that rebuilds it. Flag this
  explicitly as a required manual step in any implementation plan, and as a
  strong candidate for the same class of staleness bug documented in the
  "Kernel build cache-key omits runtime-core" incident — a stale
  `fork_module32.wasm` would silently keep failing (or silently keep the OLD
  decode behavior) with no build error.
- **Browser propagation.** `apps/browser-demos/vite.config.ts:1-45` resolves
  `fork_module32.wasm` (aliased as `@fork-module32-wasm`, contract in
  `apps/browser-demos/browser-module-contract.mjs:26-32`) through the same
  `tryResolveBinary`/`tryResolveBinaries` from `host/src/binary-resolver.ts`
  — i.e. the **same** `local-binaries/` tree Node uses, so the same manual
  `build-wasm.sh` step covers both hosts; there is no separate browser-only
  rebuild path for this artifact. What *is* browser-specific: real fork-
  using **packages** (not Node test fixtures) get instrumented via
  `scripts/run-wasm-fork-instrument.sh` as part of their package build
  (per the packages-and-builds contract), and those cached package
  artifacts are keyed by declared `build.toml` `inputs`. This investigation
  did not find or verify that fork-instrument-consuming packages declare
  `crates/fork-instrument` (or its transitive `crates/fork-codec`/`crates/shared`)
  in their `inputs`, which the "Kernel-build cache-key omits runtime-core"
  precedent shows is an easy thing to miss — **name this as an explicit
  pre-browser-validation check**: confirm at least one real fork-using
  package's `build.toml` rebuilds when `crates/fork-instrument` changes,
  before trusting a browser Playwright run to reflect the new code path.
  Per the campaign's own batching decision, browser Playwright validation is
  explicitly deferred to campaign end, so this does not block Node-level
  work, only the eventual browser validation step.

## 5. Test story

- `host/test/externref-fork-module-worker.test.ts:105-140` (flag off) and
  `:149-170` (flag on) currently assert `exitCode === 92`, empty stderr, and
  `moduleReferenceProof(result.hostDiagnostics, "externref")` is `null`.
  Post-un-gate, both should invert to `exitCode === 0`, empty stderr, and
  the externref proof-of-use `not.toBeNull()` / `toBeGreaterThan(0)` —
  mirroring the pattern already written (and currently `.skip`'d) for GC at
  `host/test/gc-reference-cycle-fresh-worker.test.ts:96-146`.
- `host/test/gc-reference-cycle-fresh-worker.test.ts:63-87` (flag off,
  currently gated/exit-92) needs the same inversion once struct/array/i31 is
  revived. Its flag-on counterpart at `:96-146` is **already written** for
  the post-revival state (asserts `exitCode === 0`, `gc` and `drive`
  proof-of-use both `> 0`) but is `it.skip`'d for a *different*, module-
  abort-replay-specific reason (`:89-95`: "module-mode fork abort-replay is
  a known gap deferred to M8 ... the module owns its own continuation
  journal ... has no abort-replay path"). This comment may be **stale** —
  other evidence on this branch (`host/test/externref-fork-module-worker.test.ts:142-148`,
  citing "F1 (module abort-replay)") indicates module-mode abort-replay was
  since fixed. Re-verify this skip's continued validity as its own small
  step; do not assume it must stay skipped.
- `host/test/static-root-local-fork-fresh-worker.test.ts:45-67` and
  `host/test/static-root-bare-local-fork-fresh-worker.test.ts:53-70` (flag
  off, currently gated/exit-92) need the same inversion; both already have
  `it.skip`'d flag-on counterparts (`:81`, `:84`) with the same M8-style
  skip note to re-verify.
- `host/test/fork-activation-registry.test.ts` has white-box unit coverage
  that was rewritten around the deletion (commit message in `d8ad27833b`
  describes exactly which assertions changed, e.g. the `GC_CAPTURE_LAYOUT`
  test at `:148-154` currently asserts the *gated* import body's behavior
  and will need to assert the *real* `captureGcLayout` call again once
  revived).
- New coverage likely needed: a primitive-valued or `call_indirect`-produced
  externref fixture that intentionally stays gated post-revival (proving the
  soundness-guard fallback still fires rather than mis-capturing) — native
  does not appear to have this as an explicit test either (not confirmed;
  worth checking `crates/host-native`'s own test suite before writing a new
  one from scratch).
- Confirmed: nothing in this section requires a browser run. All the above
  are Node/Vitest (`runCentralizedProgram`/`centralized-test-helper.ts`).
  Per the campaign's stated batching, Playwright validation stays deferred
  to campaign end; this grounding did not find anything that forces an
  earlier browser run.

## 6. Scope breakdown, riskiest piece, and independence

**Ordered edit list** (all in `host/src/`, all shared Node+browser TS, no
crate/ABI changes needed beyond the `dump_abi.rs` constant-generation gap in
section 1):

1. P0: bind `__wpk_fork_ref_provenance_externref` to a real body in
   `buildForkActivationStateImports` (`fork-activation-registry.ts`) — even
   a no-op unblocks every currently-broken test back to gated/green.
2. Add `WPK_FORK_REFERENCE_IMPORT_PROVENANCE_EXTERNREF` to
   `tools/xtask/src/dump_abi.rs` and regenerate `generated/abi.ts`.
3. Build the new local (same-realm) externref provenance table and make the
   provenance-import body populate it (section 1).
4. Revive `ForkReferenceTransaction`: `lookupGcSlot`, `claimGcSlot`,
   `encodeI31`, `capturedGcValue`, `defineGc`, `gcSlotValue`, `i31Ids`
   (verbatim from `74c1c373b^`/`d8ad27833b`'s diff), plus the
   `ForkGcDefinitionProvenance` interface and its imports.
5. Revive `ForkActivationRegistry`: `lookupGcSlot`, `claimGcSlot`,
   `encodeI31`, `captureGcLayout`, `defineGc`, `encodeGcFromSlot` (fallback
   branch **kept gated**, section 2), `encodeGcObject`,
   `beginGcProvenance`/`appendGcProvenanceReference`/`endGcProvenance`
   (verbatim, re-wiring the already-complete `ForkGcProvenanceRegistry`).
6. Add the new externref-provenance branch to the revived `lookupGcSlot`
   body (the one genuinely new piece, section 2).
7. Restore the real `GC_LOOKUP`/`GC_CLAIM`/`GC_I31`/`GC_DEFINE`/
   `GC_BROKER_ENCODE`/`GC_CAPTURE_LAYOUT`/`GC_PROVENANCE_BEGIN`/`_REF`/`_END`
   bodies in `buildForkActivationStateImports`, removing their
   `markUnsupportedReferenceKind` calls (verbatim from the `74c1c373b`
   diff).
8. Leave `ENCODE_EXTERNREF`/`DECODE_EXTERNREF` gate bodies alone (dead code
   for now; touching them is not required and risks confusing a future
   reader about which path is live).
9. Rebuild `fork_module32.wasm`/`fork_module64.wasm` via
   `crates/fork-module/build-wasm.sh` (needed if `crates/fork-codec`'s
   decode side changed at all since the artifact was last built — check
   `a4fc9599f` is already reflected, since that fix predates this session).
10. Invert the five gated-assertion tests, re-verify the two M8-labeled
    skips independently.

**Riskiest piece:** step 6 — the new externref-provenance branch inside
`lookupGcSlot`. It is the only piece with no pre-existing TS implementation
to copy verbatim (unlike GC-provenance and static-root, which are ports of
already-working code), it is the piece where a mistake most directly
reintroduces the disavowed "reverse lookup" failure mode, and it is the
piece most likely to need a follow-up primitive-externref decision (section
1's open question). Second riskiest: confirming the `it.skip` module-abort-
replay reason at `gc-reference-cycle-fresh-worker.test.ts:89-95` (and its
static-root twins) is actually stale — if it is *not* stale, un-gating
GC/static-root capture alone is not enough to flip those tests green, and a
second, unrelated module-abort-replay fix would block full completion.

**Independence:** corrected from the original framing. At the ABI/dispatch
level, externref, static-root, and struct/array/i31 are **not** independent
today — they share the single `GC_LOOKUP` host import as their common
capture-time entry point (architecture correction above). They *are*
independently deliverable as **branches within that one function body**, in
the exact order native already shipped and documented:
static-root-only (branch 2, section 3) is the smallest, safest increment and
needs neither the externref-provenance table nor `claimGcSlot`/`defineGc`;
externref (branch 3, section 1) needs the new provenance table but not
`claimGcSlot`/`defineGc`; full struct/array/i31 (the `GC_CLAIM` miss path,
section 2) needs everything. The run-loop's single
`unsupportedReferenceKind` slot (`worker-main.ts:5108-5119`,
`ForkActivationRegistry.markUnsupportedReferenceKind`/
`takeUnsupportedReferenceKind`) is a last-write-wins aggregate flag, not a
per-kind gate, so it does not force all-or-nothing either — a fork that
still triggers `GC_CLAIM`'s gate (real construction, not yet revived) will
still abort cleanly with EOPNOTSUPP even after static-root and externref are
both un-gated, exactly as designed.
