# N1-F5 grounding: real externref reference CAPTURE across fork, all hosts

Read-only design map. All paths are relative to
`/Users/brandon/kandelo-abi44-reconcile` (branch
`brandonpayton/rust-first-abi44-reconcile`). No code was changed to produce
this document.

**Scope per the campaign plan**
(`docs/plans/2026-09-05-rust-first-campaign-to-completion.md:37-59`, Decision
2): F5 = FLOOR-1 = "re-instrument funcref/externref provenance → lift
externref gate, all hosts." It is explicitly staged after **I5b** (native
capture parity: funcref/exnref capture in Rust + a real module-state arena;
externref/GC/static-root stay cleanly `EOPNOTSUPP`) and before **F6** = FLOOR-2
(GC struct/array/i31/static-root provenance, "a hard whole-program transform").
I5b is substantially landed on this branch already (see §6) — its gate
machinery is exactly the boundary F5 must lift for externref only.

---

## 1. What externref capture fundamentally requires

**The replay/decode side is already built, shared, and frozen** — this is the
spec capture must satisfy. Concretely, for a fork carrying a live externref,
on EVERY host:

1. **Wire recipe** (`crates/fork-codec/src/reference_recipes.rs:303-317`,
   decoder): a scalar node `ReferenceRecipeNode::Externref { handle: u32 }`.
   On the wire this is `kind = KIND_EXTERNREF`, two scalar words holding the
   handle split across `first`/`second` (`handle = (second << 32) | first`,
   `reference_recipes.rs:308-310`), a zero third/reserved word
   (`reference_recipes.rs:305-306`), and **no aggregate blob/edges**
   (`require_no_aggregate()`, `reference_recipes.rs:304`). The handle domain
   is `1..=0xffff_ffff`; `0` is rejected (`reference_recipes.rs:311-312`,
   confirmed by the `KIND_EXTERNREF` unit tests at
   `reference_recipes.rs:848-867`).
2. **Wire writer** (`crates/fork-codec/src/reference_graph_builder.rs:154-164`,
   `ReferenceGraphBuilder::intern_externref(handle: u32) -> Result<u32, Errno>`):
   already exists, already shared, and is the EXACT mirror of the decoder —
   it rejects a zero handle, dedupes by handle (repeat calls with the same
   handle return the same recipe id, `reference_graph_builder.rs:158-159`,
   mirroring `encodeExternref`'s intern-by-value semantics), and pushes the
   same `ReferenceRecipeNode::Externref { handle }` node the decoder above
   reads. **This function is not new work for F5** — it is already called
   by `fork_codec`'s own test suite; only a HOST CALLER for it is missing on
   the capture path (native has none; Node/browser's caller was deleted, see
   §0 of the companion I5b doc, restated in §5 below).
3. **Decode/materialize** (`fork-module-inject/src/main.rs:263-264,304`,
   the injected `__wpk_fork_ref_decode_externref` body): `resolve_externref(
   fm_externref_handle(recipe))` — DIRECT, no table lookup. `fm_externref_
   handle(recipe_id) -> handle` (`crates/fork-module/src/lib.rs:3287`,
   grounding doc `2026-09-05-n1-i5-references-grounding.md` §1) is a Rust
   helper that reads the `handle` field straight out of the ALREADY-DECODED
   `ReferenceRecipeNode::Externref` produced by step 1's decoder (invoked once
   per fork by `fm_begin_reference_replay`). `resolve_externref(handle) ->
   externref` (native: `crates/host-native/src/guest.rs:2408-2421`,
   `define_resolve_externref` over `ExternrefRegistry`; Node/browser:
   `host/src/fork-module-host-capabilities.ts:56-73` over a
   `ForkExternrefTokenCache`) is the ONE residual host import materializing a
   handle back into a genuine wasm `externref`, idempotently per handle.
4. **Transit publish** (`fork-module-inject/src/main.rs:392-407,561-579`, the
   `DRIVE_OP_EXTERNREF_TRANSIT` branch of the injected `fm_drive_execute`
   loop): for an externref reachable from a GC/struct/array root (not just a
   bare local/global), the SAME `resolve_externref(fm_externref_handle(
   recipe))` call is made and the result is `table.set` into the shared
   anyref transit at slot `recipe + 1`, so the guest's own `_gc_fill`
   consumes it like any other typed field. This is the SAME decode primitive
   as step 3, just invoked from a different call site (the drive loop instead
   of the guest's own frame-restore codec).

**So "what capture fundamentally requires," restated as an obligation on the
CAPTURE side**: for every externref-typed value live at fork time (a local,
global, table entry, or GC-reachable field), capture must (a) obtain the
SAME `u32` handle that `resolve_externref` will later be asked to resolve for
this exact live value, and (b) call `intern_externref(handle)` (or, for the
transit-reachable case, the vector-append family so it becomes a graph node
`finish_vector` publishes) to write the recipe node step 1 already knows how
to encode. Nothing about the WIRE FORMAT, the WRITER, or the DECODE/PUBLISH
side needs to change for F5 — only a way to produce that `handle` from a live
value the guest currently holds. That is the entire crux; see §1a and §2.

---

## 1a. Replay↔Capture symmetry (externref)

Per decode step above, its capture-side inverse, and whether the inverse is
mechanical or breaks:

| # | Replay/decode step | Inverse (capture) | Symmetric? |
|---|---|---|---|
| 1 | Decoder reads `{kind: Externref, handle}` off the wire (`reference_recipes.rs:303-317`) | Writer emits `{kind: Externref, handle}` onto the wire (`ReferenceGraphBuilder::intern_externref`, `reference_graph_builder.rs:154-164`) | **Clean, mechanical, and ALREADY BUILT.** The writer is the literal bit-for-bit inverse of the reader and exists today in shared `fork_codec`, unused by any capture caller. |
| 2 | `fm_externref_handle(recipe_id) -> handle` extracts the handle from the decoded node (`fork-module/src/lib.rs:3287`) | Nothing to invert — this is a pure data-plane accessor over data step 1 already wrote; capture never calls it. | N/A (module-internal to replay only) |
| 3 | `resolve_externref(handle) -> externref` — turns a HANDLE into a LIVE VALUE, idempotently, by lookup-or-mint in a `handle -> externref` map (native: `ExternrefRegistry.map: HashMap<u32, OwnedRooted<ExternRef>>`, `guest.rs:2339-2380`; Node/browser: `ForkExternrefTokenCache`, `fork-reference-broker.ts:590-632`) | **Needs a value → handle map — the OPPOSITE direction of the SAME data structure.** No such reverse map is built or maintained by replay; replay only ever walks handle→value. | **BREAKS HERE.** This is the whole crux (§2). |
| 4 | `DRIVE_OP_EXTERNREF_TRANSIT` calls step 3, then `table.set`s the result | Capture-side equivalent is `vector_begin`/`vector_append`/`vector_finish` around a GC-reachable externref field, which ALSO ultimately needs a handle for that externref value | Same break as step 3, reached from the GC-drive path instead of the local/global path |

**The asymmetry in one sentence**: replay is a *pure function of a handle*
(handle known → value derived, deterministically, idempotently); capture
needs the *inverse relation* (value known → handle recovered), and nothing in
the already-built replay machinery ever needed to compute that inverse,
because replay is never handed a live value to identify — only a handle
already sitting in the wire format. Building capture is therefore NOT "port
the decoder logic to run backwards" (there is no backwards algorithm to
port); it is "invent the one primitive that never had to exist for replay
alone: given a live externref, name the handle it should have had all
along." §2 covers why that invention is hard.

**Was the deleted D6.2 capture code structured as this inverse?** Only
partially, and it demonstrates exactly this break. The deleted
`ForkReferenceTransaction.encodeExternref` (pre-deletion source recovered via
`git show d8ad27833^:host/src/fork-reference-transaction.ts`, lines 283-305)
was:
```ts
encodeExternref(value: unknown): number {
  ...
  return this.intern(value, () => ({
    kind: "externref",
    handle: this.externrefs.capture(value),
  }));
}
```
`this.intern(value, ...)` is JS-identity-keyed deduplication (a `WeakMap`
front-end analogous to `intern_externref`'s handle-keyed dedup) — that part
IS the same shape as the sound, mechanical half. But `this.externrefs.capture
(value)` (`ForkExternrefBroker.capture`, `fork-reference-broker.ts:657-670`)
is exactly the broken half: `this.tokens.encode(value)` is a `WeakMap`-based
REVERSE lookup from a live JS value back to a handle, and when it fails
(`handle === null`) the code **throws** `"externref reached fork without
passing through the process reference owner"` — an unrecoverable JS
exception with no errno, thrown from inside the guest's own unwind walk. So
yes: reviving D6.2's capture side literally means reviving this exact reverse
lookup, unchanged in shape — which is why the campaign plan calls it "the
deleted unsound host reverse-lookup" (`...campaign-to-completion.md:47`) and
why F5 is framed as replacing it with FLOOR-1 provenance recording rather
than restoring it as-is. See §2 for why the reverse lookup is unsound rather
than merely incomplete.

---

## 2. Can native capture externref via `ExternrefRegistry` alone? No — and here is exactly why

**`ExternrefRegistry` cannot do reverse lookup at all, structurally.** It is
declared as `map: HashMap<u32, wasmtime::OwnedRooted<ExternRef>>`
(`guest.rs:2339-2341`) — handle is the KEY, externref is the VALUE. There is
no secondary index from externref back to handle; adding one would require
either (a) iterating the whole map comparing `Rooted::ref_eq` against every
entry (works, but only for handles ALREADY resolved once in this generation —
an externref the guest obtained WITHOUT ever calling `resolve_externref`,
e.g. from some other native host import, has no entry to find), or (b) a
genuine reverse map keyed by some derived identity of the `ExternRef`'s
backing data.

**The one shortcut that works TODAY, and exactly why it does not generalize.**
Because `define_resolve_externref`'s bodies mint every externref via
`ExternRef::new(&mut store, handle: u32)` — the backing Rust data IS the raw
handle integer, by construction (`guest.rs:2376`, and the test-only probe
`define_externref_payload_probe` at `guest.rs:2440-2458` reads it straight
back via `v.data(&caller)?.downcast_ref::<u32>()`) — a native capture body
COULD read the handle directly out of any externref that was minted this
way, with no map at all: `value.data(&store)?.downcast_ref::<u32>()`. This is
forward decoding of self-describing data, not reverse lookup, and it is
sound for exactly the closed set of values `ExternrefRegistry`/the test probe
convention produces. **It does not generalize** because it depends on an
implementation accident specific to this one test-only registry (that its
backing data happens to equal the wire handle) — a REAL native host import
that mints an `ExternRef` wrapping some other Rust value (a file handle
object, a socket, anything with actual payload) has no such embedded handle
to read back, and neither does a guest-synthesized externref (see below).
This shortcut proves nothing about the general capture problem; it only
proves native's own synthetic test fixture is self-inverting by accident.

**Two structurally different provenances, and why only one is even
theoretically closeable without re-instrumentation:**

- **Host-materialized externrefs** (obtained via `resolve_externref` or any
  future externref-returning host import): the HOST controls the moment of
  minting. A sound design COULD record `(backing identity) -> handle` in a
  side table AT THAT MOMENT (mint-time registration), not at capture time.
  This is precisely what Node/browser's `ForkExternrefProcessOwner.
  registerForWire` / `ForkExternrefImportMailbox`
  (`host/src/fork-externref-import-mailbox.ts:1076,1214,1260`) already do for
  every externref-typed host import that is routed through that mailbox —
  register the value with the broker (which DOES build the WeakMap reverse
  index, `objectHandles`/`primitiveHandles`/`numberHandles`,
  `fork-reference-broker.ts:123-125`) at the exact point the value crosses
  into the guest, not later. **If — and only if — every externref-producing
  import is required to route through this registration point, the reverse
  lookup over that WeakMap is sound and total**, because there is no other
  way for a genuine host-owned externref to enter the guest.
- **Guest-obtained/guest-synthesized externrefs**: a guest holding the
  Wasm-GC proposal can execute `extern.internalize`/`any.convert_extern` on
  an `anyref` it already produced ITSELF (e.g., a struct/array/i31 the guest
  allocated with no host involvement at all), converting it to an
  `externref`-typed value with **no host call in between** — nothing to
  intercept, nothing to register, no mailbox to route through. This is the
  hard case FLOOR-1 explicitly names ("host-imported externrefs" as one of
  "the hard cases" in `docs/fork-reference-support.md`'s "Future work"
  section — read together with `crates/fork-instrument/src/reference_
  analysis.rs`'s reference classification, this externref-from-internalize
  path is exactly why a HOST-SIDE reverse map, however complete its
  import-mailbox coverage, can never be proven total by construction: totality
  would require statically proving no `extern.internalize`/`any.convert_
  extern` opcode in the compiled program can ever reach a value that
  bypassed registration, which is a whole-program property, not a host
  runtime property).

**Was the deleted approach a host reverse-lookup, and was it deleted because
it was unsound or merely to minimize host surface?** It was a host
reverse-lookup (§1a, confirmed from source), and the campaign plan's own
Decision 2 states the reason explicitly and is unambiguous that it is a
soundness judgment, not a surface-minimization judgment:
`docs/plans/2026-09-05-rust-first-campaign-to-completion.md:44-47`:
> "only the CAPTURE side + production-site PROVENANCE is missing, and
> re-instrumentation (the doc's 'E1 floors') supplies it SOUNDLY (replacing
> the deleted **unsound** host reverse-lookup)."

This is corroborated by the code itself: `ForkExternrefBroker.capture`
(`fork-reference-broker.ts:657-670`) throws an unhandled JS `Error` — not a
result the fork's own unwind machinery can turn into an errno — the instant
`tokens.encode(value)` misses, i.e. the instant it meets a live externref
that did not pass through mint-time registration. `253867db1c`'s own commit
message calls this out directly: "a throw here cannot carry an errno through
the Wasm fork save walk," which is why the gate-and-placeholder replacement
(returning a survivable sentinel + `markUnsupportedReferenceKind`, not the
real encoder) was necessary regardless of whether the reverse lookup
happened to succeed for the fixtures actually exercised. So: NOT deleted
purely for host-surface minimization (though that IS separately named as a
benefit — the M2 "minimize host surface" commits, e.g. `bb8b44cda`, are a
different, later, REPLAY-side simplification) — deleted because the capture
reverse-lookup could not be made total and its failure mode was a crash
vector inside the one code path (fork unwind) that must never crash.

**Verdict**: native cannot soundly capture externref via `ExternrefRegistry`
or any capture-time reverse map, for the identical structural reason
Node/browser's deleted design could not — this is an engine-agnostic
argument about WHEN identity can be recovered (at production, or never
soundly), not a wasmtime-specific limitation. FLOOR-1 (production-site
provenance recording, re-instrumenting every fork-capable program so a
handle/ordinal is stamped the moment a reference is minted, never recovered
later by inspection) is required to close this soundly. FLOOR-1 is tractable
for the host-imported-externref case (a per-import wrapper, analogous to
Node/browser's existing mailbox-registration pattern, ported into the
instrumenter) but explicitly does NOT close the guest-internalized-from-anyref
case without also handling the FLOOR-2/GC provenance work — this needs
resolving explicitly during F5 scoping (see §6's open question).

---

## 3. Does F5 require an ABI epoch? YES — new required capture-site instrumentation

**Direct campaign-plan statement**
(`...campaign-to-completion.md:56-57`): "Both floors are ABI epochs (rebuild
fork packages)." This is stated as a decision, not left implicit; the
grounding below explains the concrete ABI-surface reason so the claim is
falsifiable rather than asserted.

**What does NOT need an epoch (already-in-ABI, unchanged surface)**: the
CURRENT capture-side import names — `__wpk_fork_ref_encode_externref`,
`__wpk_fork_ref_vector_begin/append/finish`, `__wpk_fork_ref_scratch_reserve/
release` — are already part of `WPK_FORK_REQUIRED_IMPORTS`
(`crates/shared/src/lib.rs:2488-2759`, asserted at exactly 45 entries,
`lib.rs:3874`) and already unconditionally declared by every fork-capable
instrumented program today (per the companion I5b doc §1: "the instrumenter
does not conditionally omit `vector_begin`/`gc_lookup`/etc. based on whether
a given program happens to use them"). Simply changing the HOST-SIDE BODY
behind an already-declared import (gate-stub → real encoder) is,
structurally, the same kind of change the `253867db1c`/`0d5dd28805` commits
made in the other direction, and those were explicitly host-TS/host-Rust-only,
non-ABI changes ("ABI 44 unchanged (host TS only)", `253867db1c`'s own
message). If a *sound* handle could somehow be obtained from data already
crossing these same existing imports, lifting the gate alone would not need
an epoch.

**What DOES need an epoch, per §2's conclusion**: FLOOR-1 requires recording
provenance AT THE PRODUCTION SITE of a reference (the moment a
host-imported-externref-returning call returns, not the moment some LATER
unwind/save-walk visits a local holding it). No such production-site hook
exists in the instrumenter today for externref — the current capture imports
only ever fire reactively, from `wpk_fork_module_state_save`/frame-unwind
commits walking ALREADY-LIVE locals/globals/tables
(`docs/plans/2026-09-05-n1-i5b-reference-capture-grounding.md` §2). Adding a
NEW call — wrapping every externref-returning host-import call site with a
"record provenance now" import, analogous to the wrapper technique
`crates/fork-instrument/src/module_gc_codec.rs:397-495`
(`inject_provenance_wrappers`/`add_provenance_wrapper`) already uses for GC
struct/array constructors (a DIFFERENT, FLOOR-2 case, but the identical
wrapping TECHNIQUE) — means:

- A **new required import name** enters `WPK_FORK_REQUIRED_IMPORTS` (or an
  existing import's SIGNATURE changes to also thread a provenance token) —
  this is explicitly one of `docs/abi-versioning.md`'s "what counts as an ABI
  change" bullets: "Adding or changing a required kernel-Wasm host import.
  Kernel imports are not yet present in the structural snapshot, so reviewers
  must track this surface explicitly and coordinate the host implementation
  in the same ABI epoch" (`docs/abi-versioning.md:88-90`), and separately:
  "Changing the required `wpk_fork_*` export names or the save-buffer / frame
  format emitted by wasm-fork-instrument into every fork-using user program
  ... a rename here silently breaks fork for every already-built binary"
  (`docs/abi-versioning.md:75-79`).
- Every already-built fork-instrumented binary in the package registry
  DECLARES the OLD import set and does not call the new provenance-recording
  import at its externref production sites — an old binary run against a
  kernel/host that now REQUIRES that call for sound externref capture would
  silently keep hitting the unsound path (or the gate) for a reference kind
  it does not even use today (per the census: 0/113 packages), so this is a
  forward-compatible-looking but semantically load-bearing change exactly of
  the kind the ABI contract requires bumping for.
- `docs/abi-versioning.md`'s current stated epoch is `ABI_VERSION = 44`
  (`crates/shared/src/lib.rs:120`), and per the campaign's own Decision 1
  (`...campaign-to-completion.md:26`): "ABI 44 is in-dev/unreleased — shape
  it freely; regenerate the snapshot; additive changes need no version bump;
  fold semantic changes into 44." So concretely: **F5 does not necessarily
  need to bump PAST 44** (44 is still open) but DOES need `abi/snapshot.json`
  regenerated to reflect the new/changed capture-side import(s), and every
  already-built fork-capable package re-instrumented and rebuilt against the
  new instrumenter before its fork behavior for externref can be trusted —
  functionally the same "rebuild fork packages" consequence an epoch bump
  produces, whether or not the integer itself increments before this ships.
  This grounding does not attempt to determine 44-vs-45 (that is an
  implementation-time call for whoever lands F5, dependent on the exact
  shape chosen), only that the SURFACE change is real and ABI-epoch-shaped.

**Verdict: YES, F5 needs an ABI epoch** (at minimum, `abi/snapshot.json`
regeneration + universal fork-package re-instrumentation/rebuild under the
CLAUDE.md ABI Contract's own "necessary but not sufficient" snapshot-check
language), for the concrete reason that lifting the externref gate soundly
requires a NEW production-site provenance-recording call the current
instrumented-import surface does not have, not merely a host-side behavior
change behind an already-declared import.

---

## 4. Does F5 require a fork-instrument change? YES — a new production-site wrapper for externref

**Existing precedent for the TECHNIQUE, but for a different kind (FLOOR-2, not
FLOOR-1).** `crates/fork-instrument/src/module_gc_codec.rs` already
instruments GC struct/array CONSTRUCTOR call sites with "provenance"
wrappers (`inject_provenance_wrappers`, `main_gc_codec.rs:397-495`,
`add_provenance_wrapper`) that capture scalar/reference constructor arguments
at the moment of construction, precisely because GC provenance cannot be
recovered later by inspection either (per that file's own doc comment,
`module_gc_codec.rs:9`: "Immutable arrays need constructor provenance...").
**This is FLOOR-2's mechanism, already partially built, for a DIFFERENT
reference family (struct/array), not externref.** No equivalent wrapper
exists for externref-returning host-import call sites today — confirmed by
the companion I5b doc's exhaustive grep (§1: "Every single capture-side
import has NO fork-module export" — a different but related finding; the
absence here is of an INSTRUMENTER-side production-site wrapper, checked
directly: no `encode_externref`-adjacent provenance-wrapper function exists
in `crates/fork-instrument/src/*.rs` — only the struct/array family does).

**What FLOOR-1 for externref concretely needs, by analogy to
`add_provenance_wrapper`**:
1. A new instrumenter pass that identifies every host-import call site
   declared with an `externref` RESULT type (the "production site" — this is
   a syntactic property of the compiled module's import section + call
   graph, discoverable statically, unlike GC provenance which needs runtime
   constructor-argument scalars).
2. Rewrite each such call site to route through a generated wrapper: call the
   real import, then immediately call a NEW import (e.g.
   `__wpk_fork_ref_provenance_externref` or similar — exact naming is an
   implementation decision, not determined by this grounding) handing it the
   freshly-returned externref value, before returning it to the caller. The
   new import's HOST body is what performs the (now sound, because it runs
   AT THE PRODUCTION SITE with the value in hand) mint-time registration —
   the Node/browser shape for this already exists as
   `ForkExternrefProcessOwner.registerForWire`
   (`host/src/fork-externref-process-owner.ts:164-173`) /
   `ForkExternrefImportMailbox` call sites
   (`host/src/fork-externref-import-mailbox.ts:1076,1260`); native would need
   an analogous Rust registration point, likely inside a widened
   `ExternrefRegistry` (or a sibling structure) that indexes by the backing
   `ExternRef`'s identity rather than only by handle.
3. `encode_externref`'s CAPTURE-time host body then changes from "gate +
   placeholder" to: look up the ALREADY-RECORDED provenance for this exact
   value (recorded at step 2, not derived now) and call `intern_externref
   (handle)` (§1) — capture-time work shrinks to a lookup against data that
   is guaranteed to exist, not an attempt to derive it from nothing.

**The explicitly named hard case FLOOR-1 does NOT close by itself**: a guest
that internalizes an `anyref` into an `externref` via
`extern.internalize`/`any.convert_extern` with no host call involved (§2)
has no call site for step 1-2 to wrap — that value's provenance would need
to be recorded when the underlying GC value was FIRST produced (a FLOOR-2/GC
provenance problem, since the anyref side already needs constructor
provenance for structs/arrays) or accepted as a residual gap explicitly
scoped out of F5 and left for F6/a documented boundary. This grounding could
not determine from reading alone whether any real or plausible test fixture
actually reaches `extern.internalize` without a host call (`docs/fork-
reference-support.md`'s census says 0/113 real packages produce externref at
all, so this is presently synthetic-fixture territory only) — resolving that
scoping question explicitly (does F5 claim to close ONLY the
host-imported-externref case, leaving guest-internalized externref formally
`EOPNOTSUPP` still?) is implementation-time work for whoever picks up F5, not
something this read-only pass can settle.

**Verdict: YES**, F5 needs a fork-instrument change: a NEW production-site
wrapper pass for externref-returning host-import call sites, modeled on the
existing GC-constructor provenance-wrapper technique
(`module_gc_codec.rs:397-495`) but targeting a different or new import name
than any current `WPK_FORK_REFERENCE_IMPORT_*` constant provides.

---

## 5. All-host parity work

**Node/browser must regain, not merely un-delete, mint-time registration.**
Per §1a/§2, simply reverting `253867db1c`/`d8ad27833` (restoring
`encodeExternref`'s call to `this.externrefs.capture(value)`) would restore
the UNSOUND reverse lookup, not a FLOOR-1-sound capture — that is explicitly
what the campaign plan says NOT to do (`...campaign-to-completion.md:47`:
"replacing the deleted unsound host reverse-lookup"). The correct Node/
browser-side change is:

1. **`host/src/fork-instrument`-generated import surface** (out of `host/`
   proper — the instrumenter is a Rust tool in `crates/fork-instrument`, §4)
   changes what a freshly-rebuilt fork-capable `.wasm` DECLARES: a new
   production-site provenance import alongside (or replacing the role of)
   `__wpk_fork_ref_encode_externref`.
2. **`host/src/worker-main.ts`** binds the new production-site import to a
   closure that calls `ForkExternrefProcessOwner.registerForWire`
   (`fork-externref-process-owner.ts:164-173`) — or a closely related new
   method — at MINT time, mirroring what
   `fork-externref-import-mailbox.ts:1076,1214,1260` already does for
   ordinary (non-fork) externref-typed host imports today. This is new
   binding code, not a revert.
3. **`host/src/fork-activation-registry.ts`**'s `WPK_FORK_REFERENCE_IMPORT_
   ENCODE_EXTERNREF` body changes from the current gate-and-placeholder
   (`fork-activation-registry.ts:477-482`, quoted in the companion I5b doc
   §0) to: look up the handle the new production-site import already
   recorded for this exact value (a sound lookup, because it is populated at
   mint time by step 2, not derived now) and call the REAL
   `references().encodeExternref(value)` (or an updated equivalent) — this
   is the "lift the gate" edit, applied ONLY once step 1/2 exist, never
   before (lifting it without the provenance recording in place would
   silently reintroduce the same throw-in-the-unwind hazard §2 describes).
4. **`host/src/fork-reference-transaction.ts`** needs `encodeExternref`
   restored (it was deleted in `d8ad27833`) but changed to consume the
   pre-recorded handle rather than calling `ForkExternrefBroker.capture`'s
   reverse lookup.
5. **`docs/fork-reference-support.md`** must be rewritten to move externref
   (or the specific host-imported-externref subset, if guest-internalized
   externref stays gated per §4's open scoping question) from "Unsupported
   (gated)" to "Supported," and its "Future work" FLOOR-1 section becomes a
   completed-work record instead of a plan.

**Was this the deleted D6.2 code, and can it be reverted-in?** Partially. The
REPLAY-side D6.2 code (`crates/fork-codec/src/reference_replay.rs`,
`crates/fork-module/src/lib.rs`, `host/src/fork-module-host-capabilities.ts`,
`host/src/fork-module-instance.ts`, `host/src/worker-main.ts`'s replay-flip
block) was **never deleted** — `git log --oneline -- crates/fork-codec/src/
reference_replay.rs` shows it evolving FORWARD through `1c7e55576` (exnref),
`9b6f48a2d` (typed-GC), `848994bbc` (dlopen multi-activation), `ca287f31b`
(static-root), and `b115caf96` (M2 t1, "drop host transit trait methods")
all the way to `bb8b44cda` (M2 t4, "shrink externref host seam to one
resolve_externref import") — this is exactly the machinery §1 cites as
already built and unchanged by F5. Only the CAPTURE-side pieces
(`ForkActivationRegistry`'s real encoder bodies,
`ForkReferenceTransaction.encodeExternref`/`ForkExternrefBroker.capture`'s
consumption by fork) were deleted, and per §1a/§2 those specific deleted
lines should NOT be reverted verbatim — they encode the unsound reverse
lookup. What IS directly reusable, unchanged, from the deleted commits: the
WIRE-LEVEL shape (`{kind: "externref", handle}`) and the intern/dedup
pattern — both already survive independently in `fork_codec`'s still-live
`ReferenceGraphBuilder::intern_externref` (§1).

---

## 6. Concrete F5 work breakdown

Ordered; "cross-host" means the change is shared/must land in parity per the
Host Runtime Contract, "native-only"/"Node+browser-only" means the change is
host-specific plumbing implementing a shared design.

1. **[cross-host, fork-instrument] New externref production-site wrapper
   pass** — `crates/fork-instrument/src/` (new pass or extension of
   `module_gc_codec.rs`'s wrapper technique): identify externref-returning
   host-import call sites, inject a wrapper that also calls a new
   provenance-recording import. Emits the ABI-surface change (§3/§4).
   **RISKIEST PIECE**: this is whole-program bytecode transformation of every
   fork-capable program, on a reference kind with zero real-package usage
   today (so it is unvalidated against any real workload — only synthetic
   fixtures exist to prove it against), and it must correctly enumerate EVERY
   externref production site including ones the current census never
   exercises. A design mistake here (missing a production site, or
   mis-handling a re-exported/aliased import) reintroduces exactly the
   silent-unsoundness failure mode §2 describes, but now hidden behind a
   passing gate instead of a loud one.
2. **[cross-host, ABI] Regenerate `abi/snapshot.json`; decide 44-vs-epoch-bump**
   (`crates/shared/src/lib.rs`, `scripts/check-abi-version.sh`) — per §3, the
   integer may stay 44 (open epoch) but the snapshot and every fork-capable
   package's build/re-instrumentation must be redone.
3. **[Node+browser] `host/src/worker-main.ts` + `host/src/fork-externref-
   process-owner.ts` (or a new sibling)**: bind the new production-site
   import to a mint-time registration call (§5 point 2).
4. **[Node+browser] `host/src/fork-activation-registry.ts` +
   `host/src/fork-reference-transaction.ts`**: replace the gate-and-
   placeholder `ENCODE_EXTERNREF` body with a real encoder consuming the
   pre-recorded handle (§5 points 3-4); remove the corresponding
   `markUnsupportedReferenceKind("externref")` call and its cooperative-abort
   path for this ONE kind (leave the GC/static-root gates untouched — that is
   F6).
5. **[native-only] `crates/host-native/src/guest.rs`**: widen
   `ExternrefRegistry` (or add a sibling structure) to record provenance at
   the SAME new production-site wrapper's host-import call, so
   `encode_externref`'s host body (currently the gate stub at
   `guest.rs:4724-...`, §I5b landed) becomes a real lookup+`intern_externref`
   call instead of `mark_unsupported`+`gated_placeholder`. This is native's
   side of item 3/4, and per §2 must NOT be built as a capture-time reverse
   map over `ExternrefRegistry`'s existing handle-keyed map.
6. **[cross-host, docs] `docs/fork-reference-support.md`**: move externref
   (or the host-imported-externref subset) from "Unsupported (gated)" to
   "Supported"; update the "Future work" FLOOR-1 section (§5 point 5).
7. **[per-host, tests] Fixtures + suites** (§7): extend/replace the existing
   gate fixtures (`native_fork_externref_gate.wat`,
   `externref-local-fork-fresh-worker.wat`) with success-path variants
   proving real cross-fork reconstruction + identity, on all three hosts,
   plus a REMAINING negative fixture proving the guest-internalized-anyref
   case (if left gated per §4) still cleanly `EOPNOTSUPP`s rather than
   silently mis-capturing.

**Second-riskiest piece, distinct from #1**: the scoping decision in §4 (does
F5 claim ALL externref production, or only host-imported externref, leaving
guest-internalized-from-anyref formally gated pending F6?) is presently
UNRESOLVED by any doc this grounding found. Shipping F5 without an explicit,
written answer to that question risks the exact "documentation promising more
than the implementation supports" failure `CLAUDE.md`'s Build/Docs/PR
Contract calls out — this should be settled and written into `docs/fork-
reference-support.md` BEFORE `docs/fork-reference-support.md`'s "Unsupported"
section is edited, not after.

---

## 7. Externref-carrying test fixtures per host

**Native**: `crates/host-native/fixtures/native_fork_externref_gate.wat`
(187 lines, currently UNTRACKED — `git status --short` shows `??` — i.e. this
is in-progress, uncommitted work on this branch) is the CURRENT gate-proof
fixture: mints a live externref via the guest's own `env.resolve_externref`
import into a local, forks, and asserts the fork call itself returns exactly
`-95` (`-EOPNOTSUPP`) with no child spawned, then confirms the PARENT's own
resume completes without trapping (touching the still-gated local through
`native_test_externref_payload`, without asserting identity — the fixture's
own comment states `NativeReferenceCapture` "does NOT attempt to preserve the
gated value's identity ... that is F5/F6"). **F5 needs the INVERSE fixture**:
same shape (mint via `resolve_externref` or a new production-site-wrapped
import into a local, fork), but asserting the fork call returns `0`
(parent)/pid, a CHILD is spawned, and the child's own
`native_test_externref_payload` (or an identity-check import
mirroring `check_ext` below) reports the SAME handle the parent minted —
i.e., promote today's `-95` assertion to a `0`+identity assertion, exactly
mirroring how `native_fork_refs.wat` (the funcref-only success fixture,
373 lines) already proves funcref reconstruction. This is a rewrite/new
fixture, not a small edit, since the whole point of the CURRENT file is
proving the gate, and F5's fixture must prove the opposite outcome.

**Node/browser**: `host/test/fixtures/externref-local-fork-fresh-worker.wat`
(244 lines, read in full above) is the exact `.wat` twin of native's
gate fixture, ALREADY present and already used by
`host/test/externref-fork-module-worker.test.ts` — it mints a real host
externref via `env.get_ext` (wired by the test harness to the process
externref owner/broker), keeps it live across `kernel_fork`, and its own doc
comment (lines 196-206) documents the CURRENT expected outcome as "the parent
run loop aborts the fork with -EOPNOTSUPP after seal... The headline claim is
that the PARENT continues unaffected." The child-success branch (`ref.is_null`
→ exit 91; identity check → exit 94; success → exit 0) is ALREADY WRITTEN
into this fixture (lines 172-194) but is presently UNREACHABLE dead code on
the gated path, since no child is ever spawned to reach it — this is the
"deleted-then-superseded-by-gating" history in fixture form: the fixture
still declares the success-path shape D6.2 was built to prove, it simply
cannot be reached today. **F5's Node/browser test work is therefore
primarily REMOVING the gate** (`worker-main.ts`'s abort-after-seal branch for
this ONE fixture's reference kind) rather than writing a new fixture — the
existing `.wat` file's child branch becomes live again once capture stops
marking externref unsupported. `host/test/externref-fork-module-worker.test.ts`
would need its assertions inverted (expect exit 0 + no-abort, not exit 92)
to match, and `host/test/gc-reference-cycle-fresh-worker.test.ts`
(touched by the same `d20c15cce` gating commit) should be checked for a
similar externref-adjacent assertion that would need the same inversion.

---

## Open questions this grounding could not resolve by reading alone

1. **Exact new import name/signature for the production-site provenance
   wrapper** (§4) — an implementation decision, not discoverable by reading;
   needs a design pass modeled on, but not identical to, `add_provenance_
   wrapper`'s GC-constructor shape (externref production sites are import
   call sites, not `struct.new`/`array.new` instructions, so the wrapper
   mechanics differ).
2. **Whether F5 claims to close the guest-internalized-from-anyref case or
   explicitly leaves it gated** (§4, §6) — this is a scoping decision the
   campaign plan does not make explicitly for F5 specifically (it only says
   FLOOR-1 handles "funcref/externref provenance" and separately flags
   "dynamically created funcrefs and host-imported externrefs" as the named
   hard cases in `docs/fork-reference-support.md`, which reads as scoping F5
   to the host-imported case only, but this grounding did not find an
   explicit line saying so). Resolve by writing the answer into `docs/fork-
   reference-support.md` before editing its "Unsupported" section, not by
   inferring it during implementation.
3. **Whether any native host import today produces a genuine (non-test)
   externref at all** — if none does, F5 on native may be provable ONLY via
   the same `resolve_externref`/`native_test_externref_payload` synthetic
   convention the existing gate fixture already uses, which would need to be
   called out explicitly as a synthetic-only proof (matching the honest
   framing `docs/fork-reference-support.md` already uses for the current
   census). This grounding did not exhaustively enumerate every native host
   import's return type to confirm; a grep for `Option<wasmtime::Rooted<
   ExternRef>>`/`Option<wasmtime::OwnedRooted<ExternRef>>` as a RETURN type
   (not parameter) across `crates/host-native/src/*.rs` would resolve it.
