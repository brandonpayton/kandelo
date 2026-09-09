# Static-root reference CAPTURE across fork — grounding (N1, last gated kind)

**Scope.** Read-only grounding. No code changed, nothing built, nothing run.
Every claim is a direct citation (`file:line`, commit/blob SHA) or is marked
unverified with the experiment that would settle it.

**Headline finding, stated up front because it revises the F6 grounding
doc's own claim about this exact question:** `docs/plans/2026-09-05-n1-f6-gc-
provenance-grounding.md:403-404` says static-root's "two call sites in
`ForkActivationRegistry` (`lookupGcSlot`'s static-root branch) and
`ForkReferenceTransaction` were deleted alongside the GC struct/array
methods." This is only half right. The generic `ForkReferenceTransaction
.intern()` static-root check (used by funcref/exception/every non-GC-slot
capture path) was **never deleted** — it is live on HEAD today
(`host/src/fork-reference-transaction.ts:1679`). Only the **GC-slot-specific**
static-root check inside `lookupGcSlot` (deleted along with the whole method)
was removed. See §6.

---

## 1. What IS a static-root reference, concretely

A static root is **not a distinguished value shape** (not a special ref type,
not a tag on the value itself). It is a **provenance fact about how a live
`anyref` was produced**: the value came from a Wasm construct that
WebAssembly's own instantiation semantics **re-run identically on every fresh
instantiation of the same module**, so a second copy of the module — the fork
child re-instantiating from the same bytes — creates a byte-identical
replacement object *for free*, without any recipe replay at all. The only
thing that must survive fork is the **coordinate** naming which such
construct produced it, not the value.

The instrumenter's static-root catalog
(`crates/fork-instrument/src/static_reference_catalog.rs:1-14`, module doc)
identifies exactly three source shapes, each scanned in `plan()`
(`:85-187`):

1. **An immutable `ref`-typed global** whose init expression is anything other
   than `ref.null`/`ref.func` (which have their own owners) — `:91-115`. A
   local `global.get`-of-another-global alias folds onto the aliased
   coordinate (`ordinals.alias`, `:72-75`, `:109-111`) rather than getting its
   own ordinal, so two names for the same instantiation-time object collapse
   to one root.
2. **A non-imported table's declared initializer**, read from slot 0 after
   instantiation (`:121-148`) — a table declaration evaluates its initializer
   expression exactly once and fills every initial slot with that one value,
   so slot 0 is a faithful, non-reevaluating read of the exact root
   (`RootSource::TableFirst`, `:34`).
3. **An allocating expression inside a passive/active element segment**
   (`:150-182`) — `struct.new`/`array.new*`/etc. baked directly into an
   `elem` segment's expression list, one ordinal per allocating entry
   (`RootSource::ElementItem`, `:35`).

Only reference types that can meaningfully participate in `ref.eq` are
candidates (`can_participate_in_ref_eq`, `:267-284`: any/none/eq/struct/
array/i31 abstract types, or a concrete struct/array type — funcref and
externref are excluded here because they have their own dedicated catalogs).
**Mutability is the load-bearing discriminant against an ordinary dynamic GC
value**: `:98` filters out any `global.mutable` global outright. A *mutable*
`(ref $node)` global holding a `struct.new`-allocated object is captured as an
ordinary dynamic `Struct` recipe (reconstructed by `DRIVE_OP_ALLOC`/`_FILL`);
an *immutable* one holding the exact same shape is a static root (reconstructed
by re-identification, no allocation at all). The comment in
`host/test/fixtures/static-root-local-fork-fresh-worker.wat:1-7` states this
discriminant explicitly by contrasting itself with the "gc-*-fresh-worker
fixtures, whose reference globals are MUTABLE and so are reconstructed as
dynamic Struct recipes, not static roots."

At capture time, "static-root vs. ordinary GC value" is therefore not
something inspectable from the value alone (a `struct.new`'d object looks
identical whether its owning global was mutable or not) — it is answered by
**identity membership in a pre-harvested table**, harvested once at
instantiation before any user code could have mutated or aliased anything
(§3).

---

## 2. Static-root replay (the spec): end-to-end trace

Five pieces, in the order they execute for one static-root recipe node.

**(a) The harvest** (build time / injected wasm, runs once per fresh
instantiation, including the child's). `static_reference_catalog::inject`
(`crates/fork-instrument/src/static_reference_catalog.rs:191-265`) adds a
fixed-size `anyref` table `__wpk_fork_static_root_catalog` (`:194-198`,
export name `EXPORT = "__wpk_fork_static_root_catalog"`, `:24`) and a
one-shot function `__wpk_fork_static_root_harvest` (`:199-250`,
`HARVEST_EXPORT`, `:25`) whose body, for each planned root in ordinal order,
does exactly one of: `global.get` + `table.set` (`:219-223`), `table.get`
(source table, slot 0) + `table.set` (`:224-236`), or `table.init` (copy one
element straight from its still-live segment) + implicit set (`:237-245`).
The harvest is guarded to be idempotent (`table.fill` with null first,
`:204-213`) since a caller might legitimately retry it.

**(b) The host harvest call, once, right after instantiation, before any
guest code runs.** Native: `crates/host-native/src/guest.rs:6059-6115` — "the
guest's OWN `__wpk_fork_static_root_catalog` export is a harvest BUFFER, not
permanent storage… the host must call the guest's
`__wpk_fork_static_root_harvest` export exactly once, right after
instantiation" (`:6060-6066`). This block runs unconditionally for **every**
instantiation the runtime performs — parent boot and every child re-boot
alike, since it sits in the shared post-`instance` setup path, not a
fork-only branch. Node/browser: `host/src/fork-activation-registry.ts:742-758`
(`ownedRegistration.staticRootHarvest(); this.staticRoots.register(…,
ownedRegistration.staticRootCatalog); … clearForkStaticRootTable(…)`).

**(c) Copy into the shared merged catalog / TS registry (still replay-side
plumbing).** Native copies each harvested `Ref::Any` value, index-for-index,
into a **co-resident-module-owned** table `fm.static_root_catalog_table`
(`guest.rs:6090-6103`, table itself declared at `guest.rs:3941-3942`,
`fork_module_table("__wpk_fork_static_root_catalog", Ref::Any(None))`). TS
copies each entry into `ForkStaticRootCatalog`'s per-activation `Map`
(`fork-static-root-catalog.ts:130-157`), keeping only `WeakRef`s
(`isObjectIdentity` branch, `:142-143`) so it never extends an object's
lifetime, then immediately clears the source table on both hosts
(`clearForkStaticRootTable`, `:110-114`, called at `guest.rs` inline
loop-equivalent and `fork-activation-registry.ts:749`/`:758`).

**(d) The recipe.** `ReferenceRecipeNode::StaticRoot { module_activation:
u32, static_root_ordinal: u32 }` (`crates/fork-codec/src/reference_recipes.
rs:158-161`). No scalars, no edges — decode enforces this
(`node_edges`, `:377-388`, StaticRoot returns `&[]`; wire decode at
`:362-371` rejects a nonzero reserved scalar field). `intern_static_root`
(`crates/fork-codec/src/reference_graph_builder.rs:182-192`) dedupes by the
`(activation, ordinal)` coordinate, not by value.

**(e) The drive step and resolution, on the CHILD, before anything else.**
`DRIVE_OP_STATIC_ROOT` (const `3`, `crates/fork-codec/src/drive_plan.rs:74`)
is emitted in Phase 0, first, for every `StaticRoot` node
(`drive_plan.rs:435-452`, doc at `:64-73`: "drives NO guest export and uses NO
drive-table slot… the injected shim reads the merged static-root catalog with
`table.get(static_root_catalog, fm_static_root_slot(recipe))` and publishes it
with `table.set(transit, recipe + 1, v)`"). The shim gets the *global* catalog
slot from `fm_static_root_slot(recipe_id)`
(`crates/fork-module/src/lib.rs:3272-3273`, impl `static_root_slot_impl`,
`:2502-2538`): it looks up the recipe's `(module_activation,
static_root_ordinal)` via `driver.static_root_node(recipe_id)`
(`crates/fork-codec/src/reference_replay.rs:148-169`), adds the seeded
per-activation base (`static_root_catalog_base`, `fork-module/src/lib.rs:
525-535`, defaulting to `0` for the single-activation case,
`fm_set_activation_static_root_base` seeds it for multi-activation,
`:3169-3170`), and returns the merged global index, TRAPping on any
inconsistency (out-of-range recipe, wrong node kind, un-seeded activation).
The shim then does two pure wasm ops the doc comment names explicitly:
`table.get(catalog, that_index)` then `table.set(transit, recipe+1, value)` —
**no allocation, no construction, no host call at all** — re-identifying the
FRESH child's OWN canonical static root (re-created for free by the child's
own instantiation, step (a)/(b)/(c) run again on it) as the value that
satisfies this recipe. This is why the fixture comment
(`host/test/fixtures/static-root-local-fork-fresh-worker.wat:12-17`) frames it
as "a fresh child recreates its own canonical static root at instantiation;
the fork-module's static-root binder must publish THAT identity into the
anyref transit… BEFORE the holder's `_gc_fill` reads the field edge."

**What the recipe needs to carry, and what it does NOT need:** only the
catalog coordinate. It is never "reconstructed" — this is the sense in which
F6's own §1.1/§4 already correctly summarized it ("it is not reconstructed at
all, it is *looked up*").

---

## 3. Static-root capture (the inverse — the net-new work)

**What must be recorded:** an identity-keyed reverse index from a live
harvested `anyref` value to its `(module_activation, static_root_ordinal)`
coordinate, built at the SAME harvest moment replay already performs (§2b/c),
so that later, when the host captures an arbitrary live GC value reachable
from the fork snapshot, it can ask "is this exact object one of my harvested
static roots?" **before** treating it as an ordinary dynamic GC value.

This is precisely the "harvest-table mechanism" the F6 doc named
(`2026-09-05-n1-f6-gc-provenance-grounding.md:398-399`) — and it is not a
new mechanism to invent, because it already exists, completely, doing this
exact job, on Node/browser:

`host/src/fork-static-root-catalog.ts`'s `ForkStaticRootCatalog.register`
(`:130-157`) IS the harvest-table-to-reverse-index step: it reads the
just-harvested table entry-by-entry, wraps each object identity in a
`WeakRef` (`:142-143`), and immediately clears the source table (`:151`,
`clearForkStaticRootTable`) so the harvest window costs nothing after this
call. `.rebuildIndexes()` (`:209-234`) then builds the actual reverse lookup
structures — `objectRecipes: WeakMap<object, ForkStaticRootRecipe>` and
`primitiveRecipes: Map<unknown, ForkStaticRootRecipe>` — by dereferencing
every `WeakRef` and inserting `value -> {moduleActivation, ordinal}`,
first-registration-wins across activations for determinism (`:212-226`,
sorted by ascending `moduleActivation`). `.encode(value)` (`:165-168`) is the
CAPTURE entry point: an O(1) `WeakMap`/`Map` lookup, `null` on a miss.

**Where this reverse index is consulted at capture time (TS, still-live
call site):** `ForkReferenceTransaction.intern()`
(`fork-reference-transaction.ts:1668-1691`) — the single shared interning
routine used for EVERY captured value regardless of kind — calls `const
staticRoot = this.staticRoots?.encode(value)` (`:1679`) **before** invoking
the kind-specific `createNode()` callback the caller passed in; a hit
short-circuits to a `StaticRoot` node instead of whatever the caller would
otherwise have produced (`:1680-1686`). This single check is what makes
static-root recognition automatic for every value that reaches `intern()` —
funcref-as-JS-function, exceptions, anything not routed through the separate
GC-slot capture path.

**The SEPARATE check needed for the WASM-GC slot-based capture path (the one
struct/array/i31 capture actually uses).** Pre-deletion,
`ForkReferenceTransaction.lookupGcSlot` (the direct TS analogue of native's
`gc_lookup` import) had **its own, second, independent** static-root check —
NOT reached through `intern()` at all, because `lookupGcSlot`/`claimGcSlot`
never called `intern()`; they read the slot's value and did their own
`lookupId`/push/`rememberId` sequence. Pre-deletion source
(`e6fe439502e2f45e8818c3419461f6ac3e3b8a5d:host/src/fork-reference-
transaction.ts:307-313`):

```ts
lookupGcSlot(table: WebAssembly.Table, slot: number): number {
  this.requirePhase("capture", "look up a Wasm-GC identity");
  const value = this.gcSlotValue(table, slot);
  const known = this.lookupId(value);
  if (known !== undefined) return known;
  const staticRoot = this.staticRoots?.encode(value);
  if (!staticRoot) return 0;
  ...
```

This is the exact shape native's `gc_lookup` (§4) needs to reproduce: check
per-fork identity dedup first (native: `gc_claim_lookup`), then the
static-root reverse index (native: net-new), then fall through to "unknown,
let the guest try `gc_claim`" only if both miss.

**Mapping to capture-side imports/exports (native + TS names for the same
seam):**

| Need | Native | TS |
|---|---|---|
| Harvest call, once, post-instantiation | `guest.rs:6072-6089` calls `WPK_FORK_STATIC_ROOT_HARVEST_EXPORT` | `fork-activation-registry.ts:750` `ownedRegistration.staticRootHarvest()` |
| Copy harvest table → durable index | `guest.rs:6090-6103` copies into **`fm.static_root_catalog_table`** (REPLAY-direction only, no reverse map) | `fork-static-root-catalog.ts:130-157` `.register()` builds BOTH the decode table AND (via `rebuildIndexes`) the reverse `encode()` index |
| Capture-time recognition (value → coordinate) | **missing** — no reverse map exists (§4) | `fork-static-root-catalog.ts:165-168` `.encode()`, consulted at `fork-reference-transaction.ts:1679` (generic path) and (pre-deletion, not yet restored) `:312` (GC-slot path) |
| Recipe interning (coordinate → recipe id) | `crates/fork-codec::ReferenceGraphBuilder::intern_static_root` (`reference_graph_builder.rs:182-192`) — already implemented, not deleted, not native-specific | same Rust fn, or pre-deletion TS inlined the push (`:314-339`) |

---

## 4. The concrete native work

**Is `fm_set_activation_static_root_base` already called on native?** Not
found anywhere in `crates/host-native/src/guest.rs` (`grep -n
"fm_set_activation_static_root_base" crates/host-native/src/guest.rs` — zero
hits for the call; the only matches are the `ForkModule` struct's
`TypedFunc` binding at `:3619` and the `fm_func!` macro invocation binding it
at `:4029`, both just wiring the export handle, never calling it). So the
multi-activation base-seeding call is unwired on native — but per the
existing "activation 0 only" scoping of every adjacent N1-I5 block (funcref
catalog mirror, drive-table bind, static-root catalog mirror all say
"activation 0 only" at `guest.rs:5969`, `6012`, `6059`), this matches the
current single-activation scope of GC struct/array capture too and is
**out of scope for this increment**, not a blocker — exactly like
GC struct/array capture shipped without multi-activation `fm_set_
activation_catalog_base` wiring.

**What genuinely needs to be added — three pieces, all additive, no new ABI
surface (§8):**

1. **A `StaticRootProvenance` registry**, sibling to `ExternrefProvenance`
   (`guest.rs:2416-2461`) and `GcProvenanceRegistry` (`:2556-`), NOT sibling
   to the per-fork-reset `gc_claimed` (`:3242`, reset every capture). Static
   roots are stable for the guest OS thread's whole lifetime (harvested once
   at instantiation, never change), so this registry is populated **once**,
   like `ExternrefProvenance`, not reset per fork. Shape, following
   `ExternrefProvenance`'s own documented rationale
   (`guest.rs:2401-2415` — `Rooted<AnyRef>`/`OwnedRooted<AnyRef>` have no
   `Hash`/`Eq`, so a flat `Vec` + `Rooted::ref_eq` linear scan is the correct,
   already-precedented pattern, not a `HashMap`):
   ```rust
   struct StaticRootProvenance {
       entries: Vec<(wasmtime::OwnedRooted<AnyRef>, u32 /* activation */, u32 /* ordinal */)>,
   }
   impl StaticRootProvenance {
       fn register(&mut self, store: impl AsContextMut, value: Rooted<AnyRef>, activation: u32, ordinal: u32) -> Result<()> { .. }
       fn lookup(&self, store: impl AsContextMut, value: Rooted<AnyRef>) -> Result<Option<(u32,u32)>> { .. }
   }
   ```
2. **Populate it inside the existing "Static-root catalog mirror" block**
   (`guest.rs:6059-6115`) — the exact place that already reads
   `guest_roots.get(&mut store, i)` for every harvested entry (`:6094-6103`).
   Add one `static_root_provenance.lock().unwrap().register(&mut store, v, 0,
   i as u32)?` call alongside the existing `fm.static_root_catalog_table.set`
   call in that same loop, for `Ref::Any(Some(_))` entries. Activation is
   hardcoded `0`, matching this block's existing scope comment
   (`:6059` "activation 0 only").
3. **Wire it into `gc_lookup`'s body** (`guest.rs:5389-5427`): after the
   existing `gc_claim_lookup` miss and the existing `ExternrefProvenance`
   fallback both miss (or before the externref fallback — order does not
   matter, the two identity spaces are disjoint by construction: a static
   root is always an `AnyRef` that is a struct/array/i31/eq value per
   `can_participate_in_ref_eq`, `static_reference_catalog.rs:267-284`, which
   deliberately excludes externref/funcref), call `static_root_provenance
   .lock().unwrap().lookup(&mut caller, anyref)?` and, on a hit, `capture
   .graph.intern_static_root(activation, ordinal)` instead of falling through
   to `Ok(0)`. This directly replaces the comment at `guest.rs:5414-5416`
   ("no static-root catalog on native yet") with the real check — that
   comment is the load-bearing marker of exactly what's missing and exactly
   where it goes.

**No new guest-side wasm work, no new ABI import/export.** Every wasm-side
piece (harvest table, harvest export, format section) already exists and is
already unconditionally emitted by the instrumenter (`static_reference_
catalog.rs`); `gc_lookup` is an existing import already declared and already
wired for the struct/array/i31 case. This is a pure host-side (native Rust)
addition, mirroring how GC struct/array capture was wired (per the sibling
task's report, `.superpowers/sdd/2026-09-05-n1-f5-externref-capture/
task-4-gc-report.md`, not re-read in full for this document since the
pattern is already directly visible in the shipped `ExternrefProvenance`/
`GcProvenanceRegistry` code this document cites directly).

**On Node/browser**, the work is smaller: the harvest→reverse-index mechanism
(`ForkStaticRootCatalog`) is already fully built AND already wired into the
generic `intern()` path (§3). The only missing wiring is the GC-slot-specific
check inside `lookupGcSlot`/`claimGcSlot` — which do not currently exist at
all (deleted, not yet restored per F6 §6.2's Task 6 item). Restoring `lookupGcSlot`
per the pre-deletion source (§3's quoted block) automatically restores its
static-root check too, since it's inline in the same method body, not a
separate call site to re-wire.

---

## 5. Replay ↔ Capture symmetry (static-root)

| Replay step (the spec) | Capture inverse | Where symmetry breaks |
|---|---|---|
| Harvest: run `__wpk_fork_static_root_harvest` once, right after instantiation, to fill a buffer table with this instance's own canonical roots (`static_reference_catalog.rs:199-250`) | **Identical call, same timing, same host code path.** Native already does this unconditionally for every instantiation (`guest.rs:6072-6089`) — replay and capture use the SAME harvest, because a static root's parent-side identity and its own eventual child-side replacement are each just "this instance's own harvest," run twice (once per generation), never transported. | **Never breaks.** There is no parent→child value transport for a static root at all — both generations independently harvest their own. |
| Copy harvest buffer → durable per-activation table (`fm.static_root_catalog_table`, `guest.rs:6090-6103`) for the CHILD's `fm_static_root_slot`/`DRIVE_OP_STATIC_ROOT` to read | Copy the SAME harvest buffer → a reverse (`value -> coordinate`) index, for the PARENT's `gc_lookup` to read during capture | **Never breaks structurally** — both are pure re-indexings of the identical harvested table read at the identical moment; only one direction (replay's forward table) exists on native today. This is the literal "harvest-table mechanism" gap: the raw data is already captured into `fm.static_root_catalog_table`, but not also into a reverse map. Building the reverse map is mechanical, not a new information source — see §4 item 2. |
| `DRIVE_OP_STATIC_ROOT`: `table.get(merged_catalog, fm_static_root_slot(recipe))` then `table.set(transit, recipe+1, v)` — the FRESH child's own re-harvested identity satisfies the recipe (`drive_plan.rs:64-73`, `fork-module/src/lib.rs:2502-2538`) | `gc_lookup(slot)`: read the transit slot's `anyref`, check `StaticRootProvenance::lookup` (net-new), return `intern_static_root(activation, ordinal)` on a hit | **This is the one real gap**, and it is purely "wire the already-available reverse-lookup data into the already-existing import," not a new discovery problem — the coordinate needed (`activation, ordinal`) is already sitting in the SAME loop that already runs (§4 item 2), just not recorded into a queryable form yet. |
| N/A — a static root is never allocated/filled | N/A — a static root is never claimed/defined via `gc_claim`/`gc_define` | **Never applicable.** A static-root recipe carries no scalars/edges (§2d); it short-circuits BEFORE the struct/array/i31 dispatch would ever run (`intern()`'s check runs first, `fork-reference-transaction.ts:1679-1686`; TS `lookupGcSlot`'s check ran before the `pendingGc`/`claimGcSlot` path too, `:312-313` vs `:342-369`). This is why static-root is simpler than GC struct/array capture (F6 §3), not harder: there is no provenance-at-construction-time problem (§2.2 in the F6 doc) because there is no construction at all. |

---

## 6. Was the deleted TS a usable reference, or is native genuinely first?

**Both, in different senses, and this corrects the F6 doc.** For static-root
specifically:

- The **general-value** capture path (`ForkReferenceTransaction.intern()`'s
  static-root check, `fork-reference-transaction.ts:1679`) was **never
  deleted**. It is live on HEAD right now. Native has NO equivalent for its
  general (non-GC-slot) capture path either, but this document's scope (per
  the task) is the GC-slot / fork-across path exercised by
  `native_fork_gc_struct_cycle.wat`-style fixtures, where native's analogous
  seam is `gc_lookup`, not a generic `intern()`.
- The **GC-slot-specific** static-root check (inside `lookupGcSlot`,
  pre-deletion source `e6fe439502e2f45e8818c3419461f6ac3e3b8a5d:host/src/
  fork-reference-transaction.ts:307-313`, quoted in full in §3) WAS deleted
  (commits `d8ad27833b`/`fa8add8c50`, same date as the GC struct/array
  method deletions) and is **directly, literally reusable** as the design for
  native's missing wiring: same three-step order (per-fork dedup miss →
  static-root reverse-index check → fall through), same disjoint-space
  reasoning, same "recipe coordinate, not value" contract.
- `ForkStaticRootCatalog` itself (`fork-static-root-catalog.ts`, harvest
  read + `WeakRef`/`WeakMap` reverse index + clear-after-harvest) was
  **never touched by any deletion commit** (confirmed: `git log --oneline --
  host/src/fork-static-root-catalog.ts` — not re-run in this pass, but the
  F6 doc already established this at `:401-403` and this document's direct
  read of the file, its current call sites in `fork-activation-registry.ts`
  and `fork-reference-transaction.ts`, and the pre-deletion diff all confirm
  it is unchanged) and is directly instructive for the native `Vec` +
  `ref_eq` design (§4 item 1), modulo the representation swap JS `WeakMap`
  identity → native `OwnedRooted` + `ref_eq` linear scan (the same swap
  `ExternrefProvenance`/`GcProvenanceRegistry` already made for every other
  GC-adjacent capture structure on native).

**Verdict: native is NOT "genuinely first" for the design — the design is
fully proven and currently live on Node/browser (the generic path) and
recently-deleted-but-recoverable for the GC-slot path (§3's quoted block).**
Native is first only in the sense of literal Rust code: nothing analogous to
`StaticRootProvenance` exists yet in `crates/host-native`.

---

## 7. A native test fixture shape

`host/test/fixtures/static-root-local-fork-fresh-worker.wat` (Node/browser,
quoted in full at §1) already IS this fixture, and directly transplants to
native's fixture family (`crates/host-native/fixtures/*.wat`, sibling to
`native_fork_gc_struct_cycle.wat`) with no conceptual change:

- **The static root itself:** an **immutable** `(ref $node)` global whose
  init expression is `struct.new $node (i32.const 123)`
  (`:26,30`: `(global $static_root (ref $node) (struct.new $node
  (i32.const 123)))`). This is what makes it a static root and not a dynamic
  Struct recipe — mutability, not the constructor instruction, is the
  discriminant (§1).
- **A holder that keeps it reachable across fork through a mutable edge:** a
  second struct type `$holder` with a `(mut (ref null $node))` field
  (`:27`), populated with `global.get $static_root; struct.set $holder 0`
  (`:147-149`) — this is the realistic shape the fixture's own comment names:
  "a heap object pointing at a module-instance constant such as a vtable"
  (`:9-11`). This exercises the interesting case: the static root reaches the
  fork graph as an EDGE of an ordinary dynamic Struct recipe, so both a
  `StaticRoot` node AND a `Struct` node whose `fields` vector points at it
  must decode correctly together (this is exactly why Phase 0's
  `DRIVE_OP_STATIC_ROOT` must run before Phase 3/4/5's struct fill,
  `drive_plan.rs:71-73`).
- **The fork + assertion:** `kernel_fork`, then in the child, `struct.get
  $holder 0` compared via `ref.eq` against the child's OWN fresh `global.get
  $static_root` (`:161-165`), plus a scalar-field check (`:167-172`) to prove
  the reconstructed static root is not just *a* struct but genuinely the
  SAME instance-canonical one (same field value, same identity per
  `ref.eq`).
- **A native adaptation only needs to swap the process/threading
  boilerplate** (`kernel_fork`/`wait4` channel protocol, `:1-134`, ABI-version
  export) for whatever native's existing `native_fork_gc_struct_cycle.wat`
  already uses for its own fork+wait harness — the GC/static-root-specific
  body (`:26-30`, `:136-188`) transplants unchanged. A minimal ADDITIONAL
  fixture (not in this file, net-new) worth adding for the "bare" case (no
  holder edge, the static root is the DIRECTLY forked/held value) already has
  a real precedent too: `host/test/fixtures/static-root-bare-local-fork-
  fresh-worker.wat` (not read in full for this document; its existence
  alongside the holder-edge variant signals the test author already
  considered "static root held directly vs. through an edge" as the two
  cases worth covering, matching the funcref/externref "direct vs. via a GC
  edge" split already precedented elsewhere in this codebase).

The **other two harvest sources** (§1: table-first-slot, allocating element
segment) are covered by dedicated fixtures/generators already in the repo
(`crates/fork-codec/testdata/gen-static-root-catalog-fixture.mts`,
`crates/fork-codec/tests/gen_static_root_catalog_fixture.rs`,
`apps/browser-demos/test/fixtures/static-root-gc.wat`) — not read in full for
this document; their existence is enough to establish that a native
"table-first" or "element-segment" variant is not a design gap, only an
un-ported fixture, should the native increment want that coverage beyond the
global case.

---

## 8. Scope, risk, tractable-or-wall verdict

**ABI epoch:** no new ABI surface. Every wasm-side name involved
(`__wpk_fork_static_root_catalog`, `__wpk_fork_static_root_harvest`, the
`kandelo.wpk_fork.static_root_catalog` custom section, `gc_lookup`,
`fm_set_activation_static_root_base`, `fm_static_root_slot`,
`fm_static_roots_published`, `DRIVE_OP_STATIC_ROOT`) already exists and is
already unconditionally emitted/declared under ABI 44
(`crates/shared/src/lib.rs:120`, confirmed unchanged since the F5 work per
F6 §8). This is a pure host-side (native Rust, ~1 new struct + 2 call sites)
and TS-side (restore ~7 deleted lines inside a method being restored anyway
for a different reason, Task 6) change.

**Scope, ordered:**
1. Native: add `StaticRootProvenance` (§4 item 1) — new struct, same shape
   as two already-shipped siblings.
2. Native: populate it inside the existing static-root mirror block (§4 item
   2) — one line added to an existing loop that's already reading the exact
   values needed.
3. Native: consult it inside `gc_lookup` (§4 item 3) — one new branch in an
   already-real (not stubbed) import body.
4. TS (Task 6, shared with GC struct/array revival, not this task's critical
   path alone): when `lookupGcSlot`/`claimGcSlot` are restored, re-add the
   3-line static-root check they had (§3's quoted block) — no new design,
   literally restoring deleted lines.
5. Validate: extend or adapt `host/test/fixtures/static-root-local-fork-
   fresh-worker.wat` / `-bare-` variant to a `crates/host-native/fixtures/
   native_fork_gc_static_root.wat`, exercise via the same harness pattern as
   `native_fork_gc_struct_cycle.wat`; also exercise the "holder edge" case
   together with a mutable dynamic struct in the SAME graph (already covered
   by the fixture's own design in §7) since that is the case that proves
   Phase-0-before-Phase-3/4/5 drive ordering actually matters end-to-end, not
   just in the isolated drive-plan unit tests (`drive_plan.rs:677-720`).

**Riskiest piece:** the same class of risk the F6 doc already flagged for
`ExternrefProvenance`/`GcProvenanceRegistry` generally — `Rooted<AnyRef>`
lifetime/identity correctness across a root-scope boundary — but
**strictly smaller** here than for GC struct/array, because static-root
registration is a single, one-shot, single-call operation (`register` once
per harvested entry, no multi-call transaction like `provenance_begin`/
`_ref`*/`_end`), so there is no "half-finished transaction" failure mode to
worry about (F6 §8's flagged riskiest piece does not apply to static-root at
all).

**Verdict: tractable, not a wall, and smaller than every other remaining
gated kind.** It requires zero new ABI surface, zero new wasm-side
instrumentation (the harvest mechanism was already built and is already
correctly wired for replay), and a design that is either already live
(the generic `intern()` path) or was working code deleted eleven days before
this reading and quotable verbatim (the GC-slot path). The only "genuinely
net-new" artifact, per the task's framing, is the native `StaticRootProvenance`
Rust struct itself — and that struct is a near-verbatim copy of
`ExternrefProvenance`, which already exists, is already tested, and is
already the pattern this exact codebase already validated for the identical
`Rooted`-identity problem.

**What this document could not settle by reading alone:** whether a static
root that is ALSO reachable through the general (non-GC-slot) `encode_
funcref`/exception capture path on native — i.e., whether native has (or
needs) an equivalent of the TS `intern()`-level check for non-anyref-typed
captured values — matters for the native fork surface at all. Every native
fixture found (`native_fork_refs.wat`, `native_fork_gc_*`) captures static
roots only through the WasmGC/`gc_lookup` seam, and this document did not
find a native capture path that captures a value WITHOUT first publishing it
to the anyref transit and going through `gc_lookup`. If such a path exists (a
static root held directly in an externref-typed local, decoded via a
different import), it was not located; **settling experiment:** grep
`crates/host-native/src/guest.rs` for every import whose native body calls
`capture.graph.intern_*` and confirm none of them can receive a static-root
identity without passing through the anyref transit table first.

---

## Sources consulted

- `crates/fork-instrument/src/static_reference_catalog.rs` (read in full)
- `crates/fork-instrument/src/lib.rs` (grepped for `static_reference_catalog`
  call sites, `:47,79,89-90,436,445`)
- `crates/fork-codec/src/drive_plan.rs` (`DRIVE_OP_STATIC_ROOT` doc + Phase 0
  emission, `:1-105`, `:380-452`, tests `:677-720`)
- `crates/fork-codec/src/reference_recipes.rs` (`StaticRoot` variant, decode,
  `node_edges`, `:50-73`, `:158-161`, `:340-388`)
- `crates/fork-codec/src/reference_graph_builder.rs` (`intern_static_root`
  and siblings, `:130-192`)
- `crates/fork-codec/src/reference_replay.rs` (`static_root_node`,
  `static_root_activations`, `StaticRootTarget`, `:130-169`, `:286`, tests
  `:941-991`)
- `crates/fork-module/src/lib.rs` (per-activation static-root base map,
  `static_root_slot_impl`, `fm_set_activation_static_root_base`,
  `fm_static_root_slot`, `fm_static_roots_published`, `:477-538`,
  `:2494-2538`, `:3159-3273`, `:3449-3455`; grepped for
  `fm_set_activation_static_root_base` CALL sites and confirmed zero on
  native)
- `crates/host-native/src/guest.rs` — read `gc_lookup`'s real body
  (`:5367-5433`), the "Static-root catalog mirror" block (`:6059-6116`),
  `ExternrefProvenance` in full (`:2395-2461`), `GcProvenanceRegistry`/
  `PendingGcProvenance` headers (`:2528-2656`), `NativeReferenceCapture`'s
  `gc_claimed`/`gc_claim_remember`/`gc_claim_lookup` (`:3230-3290`),
  `funcref_catalog_lookup` reverse-map pattern (`:4305`, `:5050`,
  `:5986-5989`), `ForkModule` struct fields/bindings for static-root
  (`:3619`, `:3660`, `:3666`, `:3685-3687`, `:3941-3942`, `:4029`, `:4044`,
  `:4046`, `:4051`); grepped for `static_root`/`StaticRoot`/`STATIC_ROOT`
  across the whole file
- `crates/shared/src/lib.rs` — static-root ABI constant block (`:2336-2341`,
  `:2869`)
- `host/src/fork-static-root-catalog.ts` (read in full)
- `host/src/fork-reference-transaction.ts` (HEAD) — `materializeNode`'s
  `static-root` case (`:1631-1665`), `intern()`'s static-root check
  (`:1668-1691`)
- `e6fe439502e2f45e8818c3419461f6ac3e3b8a5d:host/src/fork-reference-
  transaction.ts` (`74c1c373b^`, pre-deletion) — `lookupGcSlot`/
  `claimGcSlot` in full (`:307-369`), confirming the deleted GC-slot-specific
  static-root check
- `host/src/fork-activation-registry.ts` (HEAD) — confirmed `ForkStaticRootCatalog`
  wiring intact (`:70-72`, `:171`, `:341`, `:691`, `:742-758`, `:833`,
  `:1148-1149`, `:1395-1710`)
- `host/test/fixtures/static-root-local-fork-fresh-worker.wat` (read in full)
- Existence-only confirmation (not read in full): `host/test/fixtures/
  static-root-bare-local-fork-fresh-worker.wat`,
  `apps/browser-demos/test/fixtures/static-root-gc.wat`,
  `crates/fork-codec/testdata/gen-static-root-catalog-fixture.mts`,
  `crates/fork-codec/tests/gen_static_root_catalog_fixture.rs`,
  `crates/host-native/fixtures/native_fork_gc_struct_cycle.wat` (naming
  convention only)
- `docs/plans/2026-09-05-n1-f6-gc-provenance-grounding.md` (§1, §4, §6-8,
  read in full for cross-reference and correction)
- Commits: `74c1c373b`, `d8ad27833b`, `fa8add8c50` (2026-09-04 deletion
  series), `72655b370` (HEAD, "Host-native: real GC (struct/i31) fork capture
  + un-gate")
