# FLOOR-2 grounding: real GC reference CAPTURE across fork (N1-F6)

**Scope.** This is a read-only grounding document. It does not change code,
build anything, or run tests. Every claim below is either a direct citation
(`file:line`, commit SHA) or is explicitly marked as unverified with the
experiment that would settle it.

**Headline finding, stated up front because it revises the plan's own
premise:** `docs/plans/2026-09-05-rust-first-campaign-to-completion.md:54-57`
describes FLOOR-2 as "GC struct=appended-field / array=wrapper-struct
provenance ... the hard whole-program transform (field reindexing under
subtyping)". That description does not match any code in this worktree. The
wasm-side GC capture/replay codec that already exists
(`crates/fork-instrument/src/module_gc_codec.rs`, stable since 2026-07-25,
untouched by the ABI-44 campaign) does **not** append fields to any type and
does **not** reindex any `struct.get`/`struct.set`/`array.get`/`array.set`
immediate. It reads live objects through their **original, unmodified**
types, and it is independently validated end-to-end (cyclic mutable structs,
arrays, i31, externref-via-anyref aliasing, two-generation re-fork) by an
un-ignored Rust test that shells out to real Node.js
(`crates/fork-instrument/tests/module_gc_codec_node.rs:235-741`). A full,
working TypeScript capture-side port of the same design also existed in
`host/src/fork-reference-transaction.ts` and `host/src/fork-activation-
registry.ts` until it was deliberately gutted and then deleted on 2026-09-04
(commits `74c1c373b`, `d8ad27833b`, `fa8add8c50`) — not because it was wrong,
but as a "delete-and-gate" simplification while other pieces caught up. See
§3 and §6 for the full argument and the residual uncertainty.

---

## 1. GC replay (the spec): how a struct/array/i31 is reconstructed today

Replay is split across three layers that together form one pipeline. All
three are shared (not per-host) and were not changed by any 2026-09 F5/F6
commit.

### 1.1 The wire recipe (what a reconstructed node needs)

`crates/fork-codec/src/reference_recipes.rs:117-159` — `ReferenceRecipeNode`
is the canonical decode vocabulary. The GC-relevant variants:

```
I31 { value: i32 }
Struct { module_activation: u32, type_ordinal: u32, layout_id: u32,
         scalars: Vec<u8>, fields: Vec<u32> }
Array  { module_activation: u32, type_ordinal: u32, layout_id: u32,
         scalars: Vec<u8>, elements: Vec<u32> }
StaticRoot { module_activation: u32, static_root_ordinal: u32 }
```

Every aggregate carries: (a) a **type coordinate** (`module_activation` +
`type_ordinal`) naming which module/type constructed it, (b) a **layout id**
naming which of that type's several possible constructor shapes produced it
(see §1.2 — this is the "which Wasm instruction do I replay" selector, not a
type index), (c) a flat **scalar byte buffer** for every non-reference field
in declaration order, and (d) an ordered **edge vector** (`fields`/
`elements`) of recipe ids for every reference-typed field/element, resolved
recursively through the same node table. `I31` only needs its raw signed
31-bit payload — no edges, no scalars buffer, no layout id. `StaticRoot` only
needs a catalog coordinate — no scalars, no edges; it is not reconstructed at
all, it is *looked up* (§4).

### 1.2 The layout descriptor (how to construct that shape)

`crates/fork-instrument/src/module_gc_codec.rs:184-209` — `GcLayout` is the
per-constructor-site descriptor the injected guest codec emits into a custom
Wasm section (`plan()`, `:1893-2145`) and that the host/replay side consumes
via `descriptor()`/`encode_descriptor` (`:227-229`). Each `GcLayout` carries:
`type_id`/`type_ordinal` (which declared type), `constructor` (`GcConstructor
Kind`, `:131-168` — `Struct`, `ArrayGeneric`, `ArrayNew`, `ArrayDefault`,
`ArrayFixed{len}`, `ArrayData{segment_ordinal}`, `ArrayElement{segment_
ordinal}`), `fields` (`GcFieldLayout`, `:170-182`, each field's exact scalar
byte offset XOR reference-vector ordinal), `scalar_len_or_stride`,
`defaultable_shell` (can this shape be `struct.new_default`'d and mutated
in-place, `:1924-1927`), and `requires_provenance` (`:1928-1936`, `:1976-
1980`). Crucially: `plan()` computes `fields`/`scalar_len_or_stride` by
reading `structure.fields`/`array.field` straight off the **original type
declaration** (`:1922-1923`, `:1976-1977`) — it never adds, removes, or
reorders a field.

Why a *constructor*-level (not just type-level) layout id exists: an
immutable array cannot be populated after `array.new*` returns (top-of-file
comment, `module_gc_codec.rs:9-13`), and `array.new_fixed` bakes its arity
into the instruction. So the SAME array type can need several distinct
layouts — one per constructor shape actually used in the module
(`ArrayFixed{len=3}` vs `ArrayData{segment=0}` vs generic mutable
`ArrayNew`) — each with its own `base_layout_id` pointing back at the type's
canonical layout (`:189-191`, `:2072-2129`). Subtype dispatch is handled by
sorting candidate layouts deepest-subtype-first (`dispatch_layouts`,
`:2132-2140`) so `ref.test`-based dispatch (`emit_probe`/`emit_encode_anyref`,
`:774-828`, `:1153-1340`) always matches the most specific concrete type
first — this is what makes subtyping a non-issue for field access: WebAssembly
GC's own `struct.get $ConcreteType n` already resolves field `n` correctly for
whatever concrete (sub)type the RefCast selected; nothing needs to be
"reindexed" for the replay reader to work.

### 1.3 The drive plan (host-orchestrated execution order)

`crates/fork-codec/src/drive_plan.rs:421-527` — `build_drive_plan` walks the
node table and emits a `DriveStep` sequence (`op`, `slot`, `recipe`, `arg`)
that a walrus-injected guest shim, `fm_drive_execute`, strides over
(`crates/fork-module/src/lib.rs:3505` `fm_build_gc_plan`, `:3240`
`fm_drive_execute` doc). Five phases, all id-ordered:

- **Phase 0** (`:435-452`) — `DRIVE_OP_STATIC_ROOT` (const `=3`,
  `drive_plan.rs:74`) for every `StaticRoot` node: re-root the module's own
  static identity into the shared anyref transit table at `recipe+1` before
  anything else can reference it.
- **Phase 0b** (`:454-484`) — `DRIVE_OP_EXTERNREF_TRANSIT` (const `=4`,
  `:97`) for **every** `Externref` node unconditionally (not a reachability
  walk) — this is the fix that unblocked F5 (directly-held externref; see the
  memory note "Fork reference 'engine-floor' is migratable" and commit
  `e923f9724`).
- **Phase 3** (`:486-495`) — pre-allocate every `defaultable_shell` struct/
  array via `struct.new_default`/an all-defaults array, so a later cyclic
  edge has somewhere to point without a forward-reference ordering problem.
- **Phase 4** (`:497-502`, `ensure_identity`, `:280-360`) — allocate every
  remaining (non-shell) node in dependency order, emitting `DRIVE_OP_ALLOC`
  (const `=0`, `:53`) once per node; `I31` nodes go through the same walk but
  need only the scalar payload (no allocation dependency; `i31_owner()` hint,
  `drive_plan.rs:613-615` in the `DrivePlanHints` test double, mirrors the
  production GC-layout-descriptor lookup).
- **Phase 5** (`:504-524`) — `DRIVE_OP_FILL` (const `=1`, `:55`) every
  struct/array once, first recursively re-`ensure_identity`-ing every edge
  (idempotent — deps are already allocated by Phase 4/3), then calling the
  guest's `_gc_fill` export for that recipe.

`DRIVE_OP_EXN` (const `=2`, `:63`) is the sibling op for exception refs, not
GC, but shares the same table-base/slot addressing scheme
(`drive_table_base`, `:100-102`, `DRIVE_SLOTS_PER_ACTIVATION = 3`).

### 1.4 The guest-side allocate/fill emitters

`crates/fork-instrument/src/module_gc_codec.rs` — `finish_declaration`
(`:830-861`) calls, in order, `emit_probe` (RefTest dispatch table),
`emit_encode_anyref`/`emit_decode_anyref` (capture/lookup — §2/§3),
`emit_encode_slot`, `emit_publish_externref`, then **`emit_allocate`
(`:847`) and `emit_fill` (`:848`)** — the two guest exports `fm_drive_execute`
calls per `DRIVE_OP_ALLOC`/`DRIVE_OP_FILL` step. The doc comment at `:844-846`
states the split explicitly: "Allocation/fill are deliberately separate.
Mutable/defaultable shells are allocated for the entire graph before any edge
is filled; immutable and non-defaultable layouts are constructed in
dependency order." (Bodies of `emit_allocate`/`emit_fill` were not read line
by line for this document — their existence, call sites, and the shared
`ReferenceSeeds` placeholder mechanism they consume, `:875-970`, were
confirmed; a full line trace is unnecessary to answer the questions in this
grounding and would not change the verdict in §3.)

### What the recipe needs to carry, summarized

- **i31**: nothing but the 31-bit value. No layout, no edges.
- **Struct/Array**: a type+layout coordinate (which shape to construct), the
  scalar byte buffer (in the type's own field order/offsets), and an edge
  vector of recipe ids for every reference field/element — reference fields
  are represented as *edges*, not scalars, so cycles/aliasing are just graph
  structure, not a special payload case.
- **StaticRoot**: only a catalog coordinate; it is looked up in the fresh
  instance's own static-root table, never constructed.

---

## 2. GC capture gap (the inverse): what capture must record

Per the capture↔replay symmetry lens (campaign plan §2a,
`rust-first-campaign-to-completion.md:86-115`): replay is `recipe → value`
(pure function of already-known data); capture is `live value → recipe`, a
relation the host cannot recover by inspection for two independent reasons
that map to two independent mechanisms already built:

1. **Identity** — "have I already assigned this exact live object a recipe
   id?" Solved by boxing the value into a table slot and treating the
   resulting host-visible reference as a WeakMap/linear-scan key (§2.1).
2. **Constructor-time seed value for mutable non-null internal fields** —
   "what value satisfied this field at `struct.new` time, before any other
   node existed to point to?" This is NOT recoverable by reading the field's
   *current* value in the general cyclic case, because reading the current
   value only tells you what it points to *now* (fine for the recipe's edge
   list), not what a **fresh allocate-then-fill replay** should temporarily
   put there to satisfy the type checker before the real edge is known.
   Solved by constructor-site interposition (§2.2).

### 2.1 Reading current field values: no provenance needed for most fields

`module_gc_codec.rs` `emit_encode_struct_payload` (`:1440-1542`) and
`emit_encode_array_payload` (`:1544-1744`) read **every** field/element's
*current* value unconditionally via `struct.get`/`array.get` on the
**original, untouched type** (`emit_struct_get`, `:1783-1795`; `emit_array_
get`, `:1797-1804`) — mutable or immutable, it does not matter, because
WasmGC lets you `struct.get`/`array.get` any declared field regardless of its
mutability. Reference-typed fields are recursively encoded through
`reference_encoder`/`emit_encode_layout` (`:1775-1781`, `:1342-1438`), which
routes back through the SAME `claim`→recurse→`define` sequence, so cycles and
aliasing terminate the same way funcref/externref graphs already do
elsewhere in this codebase (claim publishes the id *before* recursing into
fields, `:1370-1381`).

Identity/dedup for this claim/lookup step is `gc_claim`/`gc_lookup`
(`IMPORT_CLAIM`/`IMPORT_LOOKUP`, `:94/93`), which the guest reaches by first
publishing the value at "transit slot 0" (a process-owned `anyref` table —
top-of-file doc, `:1-13`) then calling the import with the slot index. The
host side reads `table.get(slot)` to recover the exact live `anyref` and
keys a map on it (§6 for how this is/would-be done on each host).

### 2.2 Constructor provenance: only for mutable non-null internal edges

`inject_provenance_wrappers` (`:397-493`) statically rewrites **constructor
call sites** (not types): every `struct.new $T` / `array.new*` instruction
whose target layout `needs_wrapper` (`:407-411` — true for a struct only if
it has `provenance_reference_count != 0`, i.e. at least one mutable,
non-nullable, internal-GC-typed field, `:928-1949`; true for every
non-generic array constructor, `:1979-1980`) is redirected to a synthesized
wrapper function (`add_provenance_wrapper`, `:495-619`) via a `walrus`
`VisitorMut` pass over every local function's IR (`Rewrite::visit_instr_mut`,
`:447-479`).

The wrapper: (1) runs the **original, unmodified** constructor instruction
(`:537-572`) — same type, same field count, nothing appended; (2) publishes
the freshly constructed object into transit slot 0 and calls `gc_provenance_
begin(slot=0, activation, base_layout_id, layout_id, scalarLo, scalarHi,
reference_count)` (`:582-599`) — the host reads the live object off the
transit slot to key a provenance record, exactly as `claim`/`lookup` do; (3)
for each mutable-non-null-internal-reference **constructor argument**
(`provenance_reference_args`, `:621-658` — e.g. arg index 0 for `ArrayNew`
whose element type is itself an internal GC reference, `:638-645`; every
argument index for `ArrayFixed`, `:646-655`; the filtered subset of struct
constructor args, `:622-637`), publishes that *argument value itself* (not
its recipe id yet — the raw reference) into transit slot 0 and calls
`gc_provenance_ref(token, ordinal, slot=0)` (`:601-612`); (4) calls
`gc_provenance_end(token)` (`:613-615`) and returns the constructed object.

**Why this is needed at all, given §2.1 already reads current values:**
because replay's Phase 4 (§1.3) must allocate a *shell* for a non-
`defaultable_shell` type (i.e. one with a non-nullable reference field) using
`struct.new`/`array.new*` immediately, atomically, before the shell's real
edges are known — that is the only way to break a cycle that runs through a
mutable field (a genuine cycle through *only* immutable fields cannot exist:
constructing it would require the other node to already exist, which is the
classic construction-order impossibility, so the immutable case never needs
provenance — confirmed by `GcFieldLayout::allocation_dependency`,
`:2210-2224`, which is `true` only for *immutable* non-`none`-typed reference
fields, meaning only immutable edges are ever treated as hard allocation
*dependencies* requiring the child to already exist). For the mutable case,
the type checker still requires SOME non-null value of the right static type
at `struct.new`/`array.new*` time. A generic filler (funcref trap stub,
exception — `ReferenceSeeds`, `:875-970`) works when the field's static type
is an *abstract* reference type, but not when it names a *concrete* internal
GC type, because you cannot conjure an arbitrary instance of an
application-defined struct/array type out of nothing. Recording what the
**original program actually used** at that exact call site (which, by
construction, was some value that already existed at that point in the
original execution, and therefore is itself capturable/recipe-able) gives
replay a type-correct, always-available seed to use as the same call's
initial argument, which Phase 5's fill later overwrites with the real
(possibly self-referential) edge.

This is the entirety of "the hard transform." It is a call-site rewrite
(redirect `struct.new $T` at N specific instruction addresses to a wrapper
function), not a type-graph rewrite. See §3 for why this changes the
verdict.

### Mapping to capture-side imports

| Need | Import | File:line |
|---|---|---|
| Identity/dedup for a live GC value | `gc_lookup` / `gc_claim` | `module_gc_codec.rs:93-94` (guest), `guest.rs:4954-5019` (native stub), `fork-activation-registry.ts:528-549` (TS stub) |
| Fresh non-anyref, non-struct/array typed dispatch fallback across module boundaries | `gc_broker_encode` | `:100`, `guest.rs:5039-5055`, `fork-activation-registry.ts:610-615` |
| i31 payload | `gc_i31` | `:95`, `guest.rs:5021-5037`, `:550-554` |
| Concrete constructor-shape selection at capture time | `gc_capture_layout` | `:101`, `guest.rs:5089-5114`, `:616-632` |
| Completing a claimed placeholder into a real aggregate node | `gc_define` | `:96`, `guest.rs:5057-5087`, `:556-567` |
| Constructor-time seed for mutable non-null internal fields | `gc_provenance_begin` / `_ref` / `_end` | `:102-104`, `guest.rs:5116-5177`, `:633-658` |

---

## 3. THE HARD TRANSFORM — feasibility assessment

**(a) What "append a provenance field to each struct type" would mean.**
It would mean widening every GC struct type's field list by one synthetic
trailing (or leading) field — e.g. an `i32` provenance tag or a reference
slot — so that reading it back later at CAPTURE time could recover
construction metadata directly from the object itself, without any
out-of-band host-side registry. This is the "self-describing object"
strategy, as opposed to the "external side-table" strategy.

**(b) Why it would force reindexing, and why that's hard under subtyping.**
If field 0 is reserved for a provenance tag, then application field `k`
(formerly index `k`) becomes index `k+1` everywhere: every `struct.new`,
`struct.get`, `struct.get_u`, and `struct.set` instruction in the ENTIRE
module (not just fork-adjacent code — this touches ordinary application
logic, since the type is used for both) must have its field-index immediate
rewritten. WasmGC subtyping additionally requires a subtype's field
sequence to be a length-preserving-or-extending, type-compatible PREFIX
extension of its supertype's sequence (structural subtyping rule); inserting
a field at any position other than "append at the very end of the deepest
supertype" would break every subtype relationship in the module's rec
groups, and even append-at-end still means: every subtype in a hierarchy
must get the SAME provenance field at the SAME trailing index, so a change
to one type in a rec group ripples to validate/re-lay-out every subtype
transitively. This is a real, nontrivial whole-module type-graph
transformation with a correctness-critical invariant (index and subtype-
order preservation) that a mistake in would silently corrupt unrelated field
reads — i.e., genuinely the shape of transform the campaign plan worried
about.

**(c) Is `array=wrapper-struct` required, and what would it cost?** Under
the append-field strategy, arrays cannot receive an extra field (array types
have exactly one element type), so the natural analog is wrapping every
array instance in a synthetic 2-field struct (`{ provenance, array }`) at
every allocation site and rewriting every direct use of the array type
(locals, globals, struct/array fields elsewhere that hold `(ref $Array)`, the
`array.len`/`array.get`/`array.set` call sites) to unwrap through the new
struct first. This is strictly more invasive than the struct case: it
changes not just field indices but every static TYPE that names the array
type, transitively.

**(d) Is (b)/(c) implementable with today's tooling? Contradicted by what
already exists.** `crates/fork-instrument` already does real, working,
whole-module `walrus`-based IR rewriting — constructor-CALL-SITE redirection
(`inject_provenance_wrappers`, §2.2) and function-level IR visitation
(`Rewrite::visit_instr_mut`, `module_gc_codec.rs:447-479`) are both
implemented and tested. What it does **not** do, and would need to newly
build, is: (i) mutate the type section itself (add a field to a
`CompositeType::Struct`/rewrite a `RefType` target across the whole module),
(ii) walk rec groups and subtype chains to propagate that change downward,
and (iii) rewrite every `struct.get`/`struct.set`/`array.get`/`array.set`
immediate operand module-wide (not just at constructor sites — this is a
much larger blast radius than the ~4 instruction kinds `inject_provenance_
wrappers` currently touches). `walrus` (the crate `fork-instrument` is built
on) exposes low-level type/field mutation primitives, so it is not
*impossible* — but it is unbuilt, high-blast-radius, and would duplicate
machinery for a problem the already-shipped design (§2) does not have.

**(e) The risk if reindexing were wrong.** A single off-by-one in the
downward rec-group propagation, or a missed use site (a `call_indirect`
through a function-typed field, an `array.copy`/`array.fill` of a wrapped
array, a `ref.test`/`br_on_cast` against the un-wrapped array type baked into
some other module's imported type), would silently read or write the wrong
struct field or trap on a type mismatch that only reproduces for specific
programs — exactly the class of defect that is hardest to catch with unit
tests and easiest to ship, because a subset of programs (any that never use
the affected type in the affected way) would look fine.

**Verdict: NOT tractable as separately re-derived from scratch, and NOT
necessary — because a different, already-largely-built design (§2) already
achieves FLOOR-2's goal without touching a single type or reindexing a
single field.** The append-field/wrapper-struct approach the plan describes
is a genuine "hard whole-program transform" if it were the only option, and
this document does not claim that class of transform is generally easy. But
it is not what the code in this worktree implements, and nothing in the
existing, independently-tested implementation (§2, validated end-to-end by
`module_gc_codec_node.rs`) requires it. The correct framing for the
remaining FLOOR-2 work is **"finish wiring an already-designed and already-
validated capture mechanism to the still-stubbed host imports on native, and
revive equivalent, already-once-shipped TypeScript on Node/browser"** — see
§6 for exactly what remains.

**What this document could not settle by reading alone:** whether the
side-channel design has a correctness gap in some case NOT exercised by
`module_gc_codec_node.rs`'s fixtures (e.g., a struct with two OR MORE
mutually-cyclic mutable non-null fields across two DIFFERENT objects, rather
than the single self-referential node the existing test covers; or a
provenance-seed value that is itself not yet capturable — e.g. names a
not-yet-visited forward node during the SAME encode pass). The architecture
(claim-before-recurse, `:1370-1381`) is the same pattern already relied on
for ordinary funcref/externref graph cycles, so there is no structural reason
to expect a different outcome, but this was not proven by execution here.
**Settling experiment:** temporarily wire the native `gc_claim`/`gc_i31`/
`gc_define`/`gc_provenance_*` stubs in `crates/host-native/src/guest.rs`
(§6) to call `crates/fork-codec::ReferenceGraphBuilder` for real, and run
the existing but currently-gated fixtures (`programs/f_04_wasm_gc_struct.c`,
`host/test/gc-reference-cycle-fresh-worker.test.ts`, `host/test/gc-
reference-state-fresh-worker.test.ts`) plus a new two-object mutual-cycle
fixture, on all three hosts, before lifting the gate for real.

---

## 4. i31 and static-root: simpler cases

**i31.** Confirmed simplest possible case. `ReferenceRecipeNode::I31 { value:
i32 }` (`reference_recipes.rs:130-131`) carries only the signed 31-bit
payload — no layout id, no scalars buffer, no edges. Capture is `gc_i31
(value) -> recipe`, deduped by raw value (`fork-reference-transaction.ts`
`i31Ids: Map<number, number>`, confirmed present pre-deletion at commit
`74c1c373b^:host/src/fork-reference-transaction.ts:371-392`; Rust
equivalent `intern_i31`, `crates/fork-codec/src/reference_graph_builder.rs:
166-178`, already implemented and NOT deleted). Replay is `i31.new` of the
stored payload — no dependency ordering, no shells, nothing else needed
(§1.3's Phase 4 treats it as a leaf).

**static-root.** A module-defined immutable identity (an imported/exported
global, a table element, a data-segment-adjacent constant) that every fresh
instantiation re-creates identically by construction — it is never
"reconstructed" from a recipe, it is *re-identified* by coordinate.
`host/src/fork-static-root-catalog.ts:1-11` states this directly: "A
structurally cloned child object is not interchangeable with an immutable
global or static element root ... Recipes name roots by `(activationId,
ordinal)`." `ForkStaticRootCatalog` (`:125-`) records `WeakMap<object,
{moduleActivation, ordinal}>` + a primitive map, harvested once per
instantiation via an injected harvest table
(`WPK_FORK_STATIC_ROOT_HARVEST_EXPORT`) and immediately cleared
(`clearForkStaticRootTable`, `:110-114`) so it does not extend any object's
lifetime. This file was **not** touched by the 2026-09-04 deletion commits
(`git log --oneline -- host/src/fork-static-root-catalog.ts` shows no hits in
that range) — it is intact, only its two call sites in `ForkActivationRegistry`
(`lookupGcSlot`'s static-root branch) and `ForkReferenceTransaction` were
deleted alongside the GC struct/array methods. Reviving it is a matter of
re-wiring the intact catalog to the (revived) capture entry point, not
rebuilding the catalog itself. Native has no static-root wiring yet at all
(no `ForkStaticRootCatalog`-equivalent Rust type was found in `crates/host-
native`) — this is net-new work on the native host, though architecturally
trivial (a coordinate-keyed map, no field capture, no identity-by-boxing
trick needed beyond what `gc_lookup`'s harvest-table read already requires).

---

## 5. `extern.internalize`-derived externref (folded in from F5)

`emit_externref_bridge` (`module_gc_codec.rs:1100-1118`) is unconditional and
was not part of the 2026-09 gating churn: `encode_externref`/`decode_
externref` (the LOCAL wasm functions with these names — the raw host imports
of those names are never declared, confirmed by the N1 refcomplete substrate
comment at `guest.rs:4914-4925`) unconditionally run `any.convert_extern`
(`:1108`) then delegate straight into `encode_anyref`/`decode_anyref`
(`:1109`, `:1115`). So a guest anyref that was internalized to externref via
`extern.convert_any` with no host call in between is, by construction,
captured through the exact same struct/array/i31/broker dispatch as any other
anyref — there is no separate "externref that used to be GC" code path to
build. `guest.rs:4930-4937`'s comment confirms the mechanism at the native
`gc_lookup` stub: `ExternRef::convert_any` performs the identity-preserving
cast back, and a real struct/array/i31 anyref that took this route "converts
too" but correctly misses the externref-provenance WeakMap (§6.1) and falls
through to the general (currently gated) anyref path. **This case resolves
automatically once §3's general struct/array/i31 capture is wired up — it
needs zero bespoke code.** This matches the campaign plan's own conclusion
(`rust-first-campaign-to-completion.md:83`: "The `extern.internalize`
externref case resolves naturally in (2) [FLOOR-2] (it is a GC value)").

---

## 6. Capture-side gate lift + all-host status

### 6.1 Native (`crates/host-native/src/guest.rs`)

Current state (read `:4900-5178` in full): every GC-structural import is a
`mark_unsupported` stub returning a survivable placeholder — `gc_claim`
(`:5003-5019`), `gc_i31` (`:5021-5037`), `gc_broker_encode` (`:5039-5055`),
`gc_define` (`:5057-5087`, a void no-op), `gc_capture_layout` (`:5089-5114`,
returns the base layout id unchanged as a survivable value), `gc_provenance_
begin/ref/end` (`:5116-5177`, all no-ops). Only `gc_lookup` (`:4954-5001`)
does real work, and only for the F5 sub-case: it reads the transit-slot
value, converts it to an `ExternRef` via `ExternRef::convert_any`, and checks
it against `externref_provenance` (`ExternrefProvenance`, `:2416-2461`) — a
mint-time-registered map for plain host externrefs, not GC values — falling
through to the gate for everything else, by design (soundness guard,
`:4946-4949`).

**What "real" requires:** an identity-keyed map from live `Rooted<AnyRef>` to
`(recipe, defined?)`, mirroring `ExternrefProvenance` exactly.
`ExternrefProvenance`'s own doc comment (`:2401-2415`) already establishes
and justifies the pattern this needs: `wasmtime::Rooted<T>`/`OwnedRooted<T>`
have **no `Hash`/`Eq`** usable as a map key (confirmed — this is the one
place a naive "just use a `HashMap`" instinct fails), and `to_raw()`'s raw
`u32` is explicitly documented by wasmtime as unstable across a GC, so the
shipped answer is a flat `Vec<(OwnedRooted<T>, u32)>` with a linear scan
comparing `Rooted::ref_eq` (`:2449-2460`) — sound (every entry is kept alive
as `OwnedRooted` so identity stays meaningful) and "cheap enough for the
bounded number of [values] actually live during one fork generation"
(`:2406-2411`). This exact pattern generalizes to `Rooted<AnyRef>` (wasmtime's
GC-rooting API is uniform across `ExternRef`/`AnyRef`/`StructRef`/`ArrayRef`);
building a `GcProvenance` sibling struct and wiring the six stub imports to
call `crates/fork-codec::ReferenceGraphBuilder`'s already-implemented
`claim_gc`/`define_gc`/`intern_i31`/`intern_static_root` (§6.3) is the
concrete remaining task — not a new research problem, but real, unstarted
Rust work with one thing to double check (that `AnyRef`/`StructRef`/
`ArrayRef` expose the same `Rooted`/`OwnedRooted`/`ref_eq` surface
`ExternRef` does in the pinned wasmtime version — not verified in this
read-only pass; a five-minute `cargo doc` check, not a design risk).

### 6.2 Node/browser (`host/src/fork-activation-registry.ts`, `host/src/
fork-reference-transaction.ts`)

**Deleted, and revivable — not "never built."** Direct evidence:

- Commit `74c1c373b` ("Fork: gut gated capture imports to survivable
  placeholders (enables reconstruction deletion)", 2026-09-04) shows the
  **removed** comments stating "The real body still runs (it grows the
  shared transit table and returns canonical recipes/layout ids the injected
  codec publishes and recurses on...)" — i.e., immediately before this
  commit, `gc_lookup`/`gc_claim`/`gc_i31`/`gc_define`/`gc_broker_encode`
  called real, working encoder methods (`registry.lookupGcSlot`, `.claimGc
  Slot`, `.encodeI31`, `.defineGc`, `.encodeGcFromSlot`).
- Commits `d8ad27833b`/`fa8add8c50` ("Fork: delete now-uncalled capture-side
  reference encoders", same date) then physically deleted those now-unused
  methods from both files, explicitly itemized in the commit message:
  `lookupGcSlot`, `claimGcSlot`, `encodeI31`, `captureGcLayout`, `defineGc`,
  `encodeGcFromSlot`, `encodeGcObject`, `beginGcProvenance`, `appendGcProvenance
  Reference`, `endGcProvenance` (registry), and `encodeExternref`, `encodeI31`,
  `lookupGcSlot`, `claimGcSlot`, `capturedGcValue`, `defineGc`, `gcSlotValue`,
  `i31Ids` (transaction).
- The parent commit `74c1c373b^` = `e6fe439502e2f45e8818c3419461f6ac3e3b8a5d`
  has the full, complete implementations. `git show
  e6fe439502e2f45e8818c3419461f6ac3e3b8a5d:host/src/fork-reference-
  transaction.ts` (read in full for this document, lines ~100-470) shows a
  complete, well-formed implementation: `lookupGcSlot`/`claimGcSlot`
  (`:307-369`) key off `gcSlotValue(table, slot)` (a table read, mirroring the
  transit-slot pattern §2.1 describes) through `WeakMap`-backed `objectIds`/
  `lookupId`/`rememberId` (the class's general-purpose interning helpers,
  used identically for funcref/externref elsewhere in the same file);
  `defineGc` (`:403-`) validates the layout/provenance contract against the
  descriptor exactly as `ReferenceGraphBuilder::define_gc` does today
  (compare `reference_graph_builder.rs:215-277`, written LATER as the
  explicitly-labeled "net-new Rust port of the capture half of the
  TypeScript `ForkReferenceTransaction`" per its own module doc comment,
  `reference_graph_builder.rs:1-21`).
- The commit message is explicit that this was a **simplification, not a
  correctness retreat**: "That left the capture-side encoder methods with
  zero remaining callers in production code. Delete them." The RESTORE-side
  decode methods and the codec files were explicitly left untouched and
  deferred to a "Task 6" not reached in this worktree's history.

**What reviving requires:** port/restore the ~330 changed lines (per the
diff stat on `74c1c373b`: `163` in registry, `32`-ish net in transaction, plus
the full method bodies removed by the two delete commits) back in, this time
keeping them in lockstep with the now-canonical Rust `ReferenceGraphBuilder`
semantics (built after the TS was deleted, so it is the more authoritative
source of truth for exact validation rules going forward) rather than
independently re-deriving them. Given `ReferenceGraphBuilder` already exists
as a working, tested, panic-free Rust reference, the lowest-risk path is
likely a thin TS wrapper that mirrors its validation exactly, not a bespoke
re-implementation — but this document does not have a token budget to design
that; it only establishes that the deleted code exists, is retrievable, and
is not a research problem.

### 6.3 Shared Rust capture graph (not deleted — already built)

`crates/fork-codec/src/reference_graph_builder.rs` (386 lines, read in full)
is intact, general-purpose, and NOT gated by anything host-specific:
`begin()` (`:94-110`), `intern_funcref`/`intern_externref`/`intern_i31`/
`intern_static_root` (`:140-192`), `claim_gc`/`define_gc` (`:198-277`),
`begin_vector`/`append_vector`/`finish_vector` (`:281-323`), `validate`
(`:329-362`). Its own module doc (`:1-27`) states it is "the net-new Rust
port of the capture half of the TypeScript `ForkReferenceTransaction`" and
that "two equal live values always resolve to equal coordinates" for the
module (no-live-JS-objects) capture path. This builder currently has no
production caller wiring it to `crates/host-native/src/guest.rs`'s stub
imports — that wiring (§6.1) is the concrete remaining native-side task.

---

## 7. Replay ↔ Capture symmetry table (GC struct/array/i31/static-root)

| Replay step (the spec) | Capture inverse | Where symmetry breaks (introspection-impossible; needs construction-time provenance) |
|---|---|---|
| `DRIVE_OP_ALLOC`: `struct.new`/`array.new*` from `(type, layout, scalars)` (`drive_plan.rs` Phase 3/4; `module_gc_codec.rs` `emit_allocate`) | `gc_claim` publishes a placeholder id for a not-yet-fully-known object (`:1366-1381`; `reference_graph_builder.rs:198-208`) | **Never breaks for allocation itself** — claim only needs identity, not content, and identity is solved by transit-slot boxing (§2.1). |
| `DRIVE_OP_FILL`: `struct.set`/write each mutable field from its recipe edge (`emit_fill`) | `gc_define` reads EVERY field's *current* value via `struct.get`/`array.get` on the unmodified type (`emit_encode_struct_payload`/`emit_encode_array_payload`) | **Never breaks** — any live field is directly readable regardless of mutability; this is the "mechanical, often-already-built" half of the symmetry lens. |
| Non-`defaultable_shell` allocate must supply a real, type-correct non-null value for a mutable internal-reference field **at construction time**, before the true edge target may even exist yet | `gc_provenance_begin`/`_ref`/`_end`, recorded at the **original constructor call site** via `inject_provenance_wrappers` (`:397-619`) | **This is the one real break.** Replay's allocate step is a pure function of "what value was in this recipe's provenance slot"; capture cannot recover that value by inspecting the CURRENT object (it may have been mutated since, or may not be re-derivable from current state at all for a non-defaultable shape) — it can only be recovered by having recorded it at the exact moment the original `struct.new`/`array.new*` executed. This is the provenance-wrapper mechanism, and it is call-site-scoped, not type-scoped. |
| `DRIVE_OP_STATIC_ROOT`: re-root an activation's own static identity by coordinate (no construction at all) | `gc_lookup`'s static-root branch / harvest-table read (`ForkStaticRootCatalog.register`, harvested once per instantiation) | **Never breaks** — a static root is never "constructed" on either side; both directions are the same coordinate lookup. Only genuinely new work is per-host wiring, not a symmetry gap. |
| i31: `i31.new(value)` (`emit_allocate`'s leaf case) | `gc_i31(value)` interns by raw payload (`reference_graph_builder.rs:168-178`) | **Never breaks** — the payload IS the full identity; no construction-time state is lost because there is no allocation, only a value. |

---

## 8. ABI epoch, scope breakdown, riskiest piece, test fixtures

### ABI epoch

**No new ABI epoch is required to lift the FLOOR-2 gate.** `ABI_VERSION` is
`44` (`crates/shared/src/lib.rs:120`), unchanged since the F5 externref-
provenance work (`f8bb088ed`, "Fork-instrument: externref production-site
provenance wrapper + ABI import"). Every GC-structural import/export named in
this document (`gc_lookup`, `gc_claim`, `gc_i31`, `gc_define`, `gc_capture_
layout`, `gc_provenance_begin/ref/end`, `gc_broker_encode`, the static-root
harvest export, the `fm_build_gc_plan`/`fm_drive_execute`/`DRIVE_OP_*`
machinery) is **already declared and unconditionally emitted** by `fork-
instrument` under ABI 44 — the gate is pure host-side behavior (a stub body
vs. a real body), confirmed explicitly by the commit that introduced the
gate: `74c1c373b`'s message states "ABI 44 unchanged (host TS only)." Lifting
it is symmetric: host-side behavior only, no wasm-side ABI surface changes,
no snapshot regen needed unless an unrelated change also touches the type/
import section shape.

### Scope breakdown (ordered by dependency, not necessarily by effort)

1. **Native wiring** (`crates/host-native/src/guest.rs`): build `GcProvenance`
   (sibling of `ExternrefProvenance`, §6.1) and rewrite the 7 stub import
   bodies (`gc_claim`, `gc_i31`, `gc_define`, `gc_capture_layout`,
   `gc_provenance_begin/ref/end`, `gc_broker_encode`) to call into
   `crates/fork-codec::ReferenceGraphBuilder` (already implemented, §6.3).
   `gc_lookup` needs extending from "externref-only" to "check GcProvenance
   too, THEN fall back to the externref map."
2. **Native static-root**: no existing Rust catalog; build a coordinate-keyed
   map + harvest-table read, mirroring `ForkStaticRootCatalog` (§4). Smallest
   net-new surface, but genuinely net-new (not a revival).
3. **TS revival** (`host/src/fork-activation-registry.ts`, `host/src/fork-
   reference-transaction.ts`): restore the methods deleted in `d8ad27833b`/
   `fa8add8c50` from their last-known-good state (`74c1c373b^` =
   `e6fe439502e2f45e8818c3419461f6ac3e3b8a5d`), reconciled against
   `ReferenceGraphBuilder`'s now-canonical validation rules. Re-wire the six
   TS import stubs (`fork-activation-registry.ts:528-658`) to call them,
   exactly reversing the `74c1c373b` diff. `ForkStaticRootCatalog` (§4) is
   already intact and just needs its call site restored.
4. **Validate the FULL fork path** (not just the codec-only Node harness) on
   all three hosts against the fixtures in §"Test fixtures" below, plus a
   new two-object mutual-cycle fixture the existing tests do not cover (§3's
   flagged uncertainty).
5. **Lift the gate**: remove the `markUnsupportedReferenceKind`/
   `mark_unsupported` calls for `gc`/`i31`/`struct/array`/`static-root`/
   `externref or Wasm-GC (anyref)` kinds once (4) is green.

### Riskiest piece

**Not** a type-graph transform (§3 shows this is not needed). The riskiest
piece is **native GC-object identity/lifetime correctness**: `Rooted<AnyRef>`
values are only valid within a bounded root scope, and the existing
`ExternrefProvenance` design had to specifically solve "cache as
`OwnedRooted`, compare via `ref_eq`, never hash the raw `u32`" to avoid
silent aliasing (`guest.rs:2401-2415`). Generalizing this to `AnyRef` needs
the same care applied correctly across `claim`/`define`/`provenance_*`'s
more complex call sequence (a `provenance_begin`...`provenance_ref`*...
`provenance_end` transaction spanning multiple host calls, versus
`ExternrefProvenance`'s single-call `register`/`lookup`) — a
half-finished/aborted provenance transaction (e.g. a trap between
`provenance_begin` and `provenance_end`) rooting a value forever or dropping
it prematurely is the most plausible failure mode, and is the thing the
settling experiment in §3 should specifically stress (a trap injected
mid-provenance-sequence).

### Test fixtures per host

- **Wasm-instrumentation-level (already exists, already green, host-
  independent):** `crates/fork-instrument/tests/module_gc_codec.rs` (module-
  shape/layout unit tests) and `crates/fork-instrument/tests/module_gc_codec_
  node.rs::fresh_node_instance_reconstructs_gc_cycle_and_identity` (real
  Node.js round-trip: cyclic mutable struct, fixed/data/nullable-empty
  arrays, i31-adjacent identity via `verify_cycle`, externalized-anyref
  aliasing, two-generation re-fork).
- **Node/browser fork-path fixtures (exist, currently exercise the GATE, not
  real capture):** `host/test/fork-gc-codec.test.ts`, `host/test/fork-
  module-gc-replay.test.ts`, `host/test/gc-reference-cycle-fresh-worker.
  test.ts` + `host/test/fixtures/gc-reference-cycle-fresh-worker.wat`,
  `host/test/gc-reference-state-fresh-worker.test.ts` + `.wat`, `host/test/
  fixtures/gc-transit-object.wat`, `host/test/patch-wasm-for-thread-gc.
  test.ts`, `host/test/fork-artifact-gc-types.test.ts`.
- **Browser (Playwright):** `apps/browser-demos/test/wasm-gc-reference-
  transport.spec.ts`, `apps/browser-demos/test/gc-reference-cycle-fork-
  module-worker.spec.ts`, `apps/browser-demos/test/fixtures/static-root-gc.
  wat`.
- **Native/end-to-end C fixtures:** `programs/f_04_wasm_gc_struct.c` (built
  artifact present at `local-binaries/programs/wasm32/f_04_wasm_gc_struct.
  wasm`), `programs/f_03_wasm_gc_anyref.c`.
- **New fixture needed** (per §3): a two-object mutual-cycle case (`A.field
  -> B`, `B.field -> A`, both mutable non-null internal references on
  DIFFERENT objects) — not covered by the existing single-object self-cycle
  fixture (`create_cycle`/`verify_cycle` in `module_gc_codec_node.rs:26-58`).

---

## Sources consulted (not exhaustive; token-bounded)

- `crates/fork-instrument/src/module_gc_codec.rs` (read in full, 3837 lines)
- `crates/fork-instrument/tests/module_gc_codec.rs`,
  `module_gc_codec_node.rs` (read substantially)
- `crates/fork-codec/src/reference_graph_builder.rs` (read in full)
- `crates/fork-codec/src/drive_plan.rs` (read Phase-plan section + op
  constants)
- `crates/fork-codec/src/reference_recipes.rs` (`ReferenceRecipeNode` read
  in full)
- `crates/fork-module/src/lib.rs` (grepped for `fm_build_gc_plan`/
  `fm_drive_execute` call sites; not read in full)
- `crates/host-native/src/guest.rs` (read GC import wiring `:4900-5178`,
  `ExternrefProvenance` `:2395-2461`)
- `host/src/fork-activation-registry.ts` (read GC import stubs `:480-659`)
- `host/src/fork-static-root-catalog.ts` (read `:1-130`)
- `host/src/fork-reference-transaction.ts` at commit
  `e6fe439502e2f45e8818c3419461f6ac3e3b8a5d` (`74c1c373b^`) (read capture
  methods `:100-470`)
- Commits: `74c1c373b`, `d8ad27833b`, `fa8add8c50`, `f8bb088ed`, `e923f9724`
- `docs/plans/2026-09-05-rust-first-campaign-to-completion.md` (read
  Decision 1/2/2a, `:1-115`)
