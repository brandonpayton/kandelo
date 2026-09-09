# N1 reference-completeness — directly-held externref decode substrate grounding

Read-only investigation. Worktree `/Users/brandon/kandelo-abi44-reconcile`,
branch `brandonpayton/rust-first-abi44-reconcile`. Builds on
`.superpowers/sdd/2026-09-05-n1-f5-externref-capture/task-2-report.md` (base
commit `f8bb088ed`, with `a41d6217d`/`9f361364c` layering the mint-time
`ExternrefProvenance` capture, currently dead-but-forward-compatible).

Goal of this document: ground the SUBSTRATE step of "make a directly-held
(frame-vector-reachable) `externref` decode correctly across a native
`fork()`" and root-cause a separate, pre-existing gate hang. No code was
changed to produce this document.

## 1. Tracing the directly-held externref decode gap

### 1.1 There are two, easily-confused things named `__wpk_fork_ref_decode_externref`/`encode_externref`

**(A) Guest-LOCAL stub functions**, created by
`crates/fork-instrument/src/module_gc_codec.rs::declare()`
(`module_gc_codec.rs:335-346`, via `add_stub`) inside the GUEST's own wasm
module. They are named `__wpk_fork_ref_encode_externref` /
`__wpk_fork_ref_decode_externref` (`LOCAL_ENCODE_EXTERNREF`/
`LOCAL_DECODE_EXTERNREF`, `module_gc_codec.rs:113-114`) purely for debug
clarity — they are never added to `module.exports` (only `probe`,
`encode_slot`, `allocate`, `fill`, `publish_externref` are, at
`module_gc_codec.rs:359-367`) and never imported. Their bodies
(`emit_externref_bridge`, `module_gc_codec.rs:1100-1118`) are:

```
encode_externref(v):  any.convert_extern(v); call encode_anyref
decode_externref(id): call decode_anyref; extern.convert_any
```

They unconditionally delegate to the SAME `encode_anyref`/`decode_anyref`
pair used for real GC values. `decode_anyref`'s body (`module_gc_codec.rs`,
`emit_bridge_from_gc`, ~1060-1098) is: `recipe == 0 → ref.null any`;
otherwise `table.get(codec.transit, recipe + 1)` — a direct read of the
shared anyref transit table (STORE #2).

These two are what the guest's frame-restore codec actually calls. The
per-frame-slot codec dispatch (`crates/fork-instrument/src/runtime.rs:167-183`,
`ReferenceCodecClass::encoder`/`decoder`) maps `Self::Extern` (a frame slot
whose static Wasm type is `externref`) straight to
`codecs.encode_externref`/`decode_externref` — and `codecs` here is always
the GC-bridge pair, because
`crates/fork-instrument/src/lib.rs:472-475` unconditionally sets
`ReferenceCodecOverrides.externref = Some((exception_codec.references.encode_externref, ...))`,
which itself chains to `gc_codec.encode_externref`/`decode_externref`
(`lib.rs:458-464`). The `overrides.externref.unwrap_or_else(...)` branch in
`crates/fork-instrument/src/runtime.rs:630-637` — the ONE place that would
declare a REAL `env.__wpk_fork_ref_encode_externref`/`decode_externref`
import — is consequently dead code in every artifact `wasm-fork-instrument`
actually produces.

**(B) A co-resident fork-module EXPORT** of the identical name, injected by
`crates/fork-module-inject/src/main.rs:248-272`
(`inject_decode_externref`). `host-native`'s `guest.rs:4496-4590` looks this
export up on the fork-module instance and, if the GUEST program declares an
IMPORT of that exact name (`guest_declares(decode_externref_name)`,
`guest.rs:4562-4563`, checking `module.imports()`), wires a wrapped binding
to it. Per (A) above, the guest never declares this import in the
architecture `wasm-fork-instrument` builds today, so this whole wiring block
is dormant/dead — confirmed structurally (not just by the prior report):
`module_gc_codec.rs::declare()` never calls `module.add_import_func` for
either name; it only creates local functions.

**Conclusion**: "a directly held externref decodes lazily via the guest
import `__wpk_fork_ref_decode_externref`" (the claim repeated in
`crates/fork-codec/src/drive_plan.rs:93-96,402-407` and
`crates/fork-codec/src/reference_replay.rs:333-334,352-353,415-417`, and in
`crates/fork-module/src/lib.rs:769,2295,2543,3236,3281`) describes
architecture (B)/a legacy "real host import per externref" design that no
longer exists in the built artifact. The actual decode path a directly-held
externref frame local takes is (A): the SAME `decode_anyref` transit-table
read a GC/exnref-reachable externref uses.

### 1.2 Why `build_drive_plan` excludes it

`crate::fork_codec::drive_plan::build_drive_plan` (`drive_plan.rs:413-506`)
Phase 0b (`drive_plan.rs:446-463`) publishes a `DRIVE_OP_EXTERNREF_TRANSIT`
step only for `transit_rooted_recipes(nodes)` (`reference_replay.rs:418-448`).
That function seeds its reachability walk **only from Struct/Array/Exnref
node edges** (`reference_replay.rs:420-430`: `pending.extend_from_slice(node_edges(...))`
for those three variants only) and then walks outward, collecting every
`Externref` node it reaches. A plain `Externref` recipe that is not named
as an edge by any Struct/Array/Exnref node — i.e. reachable only because
some frame's reference vector names it directly — is never seeded into
`pending`, so it is never added to the returned set, so `build_drive_plan`
never emits a step for it. Its transit slot (`recipe + 1`) is left
completely untouched: no `table.set`, and — critically, see §1.3 — possibly
not even sized into the table at all.

Compare `build_drive_plan`'s OTHER phases: Phase 4 (`drive_plan.rs:479-481`,
`for entry in nodes { walk.ensure_identity(entry.id)?; }`) and Phase 5
(`drive_plan.rs:485-503`) iterate **every node in the graph unconditionally**
— a Struct/Array/I31 recipe gets an ALLOC/FILL step regardless of whether
anything else in the graph points at it (i.e. GC/i31 values are NEVER gapped
for "directly held" — see §5). Externref's Phase 0b is the ONE phase that,
uniquely, was scoped to a reachability walk instead of an unconditional
pass over all nodes of the relevant kind. This asymmetry is the root of the
gap (see the recommendation in §2).

### 1.3 What the guest expects on the decode side, and why it traps

`crates/fork-module-inject/src/main.rs:50-51,318-348` documents the shared
transit table `env.__wpk_fork_ref_gc_transit` (STORE #2) that both the
drive-plan's `DRIVE_OP_ALLOC`/`FILL`/`EXTERNREF_TRANSIT` steps and the
guest's own local `decode_anyref` read/write. `fork-instrument/src/
module_gc_codec.rs:1369` ("Claim grows the process-owned transit table
through recipe+1 before ...") shows the table is grown on demand at
CAPTURE time when a real `gc_claim` publish happens — i.e. table growth is
driven by which recipes actually get a claim/publish, not by total recipe
count. For a directly-held externref, capture never claims/grows the
transit table for its recipe id at all (see §3: capture for this kind is
gated), and REPLAY's `build_drive_plan` (per §1.2) never emits a step that
would grow-and-publish it either. So when the guest's own
`decode_anyref`/`decode_externref` local function executes `table.get(transit,
recipe + 1)` for this recipe during the parent's/child's frame restore, the
index is past the table's current size — a genuine wasm **table
access-out-of-bounds trap**, matching the exact trap text the grounding
brief and the T2 report record ("undefined element: out of bounds table
access"), not merely "reads null."

**Evidence chain for §1**: `module_gc_codec.rs:113-114,335-346,359-367,
1100-1118` (local stubs, no import/export); `fork-instrument/src/lib.rs:
458-475` (unconditional override); `fork-instrument/src/runtime.rs:167-183,
622-664` (dispatch + dead `add_pair` branch); `fork-module-inject/src/
main.rs:248-272` (the real but unreached export); `host-native/src/guest.rs:
4496-4502,4562-4587` (dead wiring, gated on an import the guest never
declares); `drive_plan.rs:413-506` (the plan builder, Phase 0b at 446-463 vs.
Phase 4/5 at 479-503); `reference_replay.rs:418-448` (`transit_rooted_recipes`'s
reachability seed).

## 2. The minimal, sound fix

### Candidate (a): widen `build_drive_plan`'s Phase 0b to cover every Externref node, not just aggregate-reachable ones

Concretely: replace the `for recipe_id in transit_rooted_recipes(nodes)`
loop body at `drive_plan.rs:456-463` with a pass over every node whose
variant is `ReferenceRecipeNode::Externref { .. }`, unconditionally —
i.e. drop the reachability walk for this phase entirely (the walk becomes
unnecessary: `fork_codec::ReferenceGraphBuilder::intern_externref` already
guarantees one canonical recipe id per distinct externref identity, so
"every Externref node" is already deduped by construction; no BFS is
needed). Concretely this could be:

```rust
for entry in nodes {
    if matches!(entry.node, ReferenceRecipeNode::Externref { .. }) {
        walk.steps.push(DriveStep { op: DRIVE_OP_EXTERNREF_TRANSIT, slot: 0, recipe: entry.id, arg: 0 });
    }
}
```

(id order, same as every other phase in this function — no new sort/dedup
pass required since node ids are already canonical/unique).

**Ordering / R1 rooting-hazard check** (the hazard at `drive_plan.rs:85-96`:
"a genuine `externref` *value* obtained via a host resolve must be published
into the shared anyref transit — via a wasm `table.set` (fork-codec is
`no_std` and cannot hold an `externref` itself) — with a non-null read-back
assert, BEFORE anything reads it, because a stale/unset slot is
silently null rather than a loud failure without that assert"). Widening
Phase 0b doesn't change the mechanism at all: the SAME injected
`fm_drive_execute` shim step (`table.set` + `ref.is_null` trap-on-miss) now
just also runs for more recipe ids. Ordering is preserved by construction:
`drive_fork_capture_seal_and_launch_child` calls `drive_reference_replay`
(which runs the WHOLE drive plan via `fm_drive_execute`, `guest.rs:5596-
5675`, step 4 of its own doc at `guest.rs:5586-5590`) and only AFTER that
completes does it call `wpk_fork_rewind_begin` (`guest.rs:6019-6032`), which
is what starts the guest's own per-frame local-decode walk. So every
Phase-0b step — new or old — is guaranteed to finish before any frame's
`decode_externref`/`decode_anyref` call ever runs, for BOTH the
GC/exnref-reachable case (already true today) and the newly-covered
directly-held case. No race is introduced.

**Does it touch the GC/exnref-reachable path?** No: that set
(`transit_rooted_recipes`'s current output) becomes a strict subset of "all
Externref nodes." Every existing step for that subset is still emitted, in
the same relative (id-sorted) order (Phase 0b's ordering only matters
relative to Phase 3/4/5, which strictly follow it regardless of the set's
size). The 5 existing `build_drive_plan` tests that assert an aggregate
scenario (`drive_plan.rs:636-653,750-772,829-856`, plus the
`drive_plan_hints.rs` `struct_allocation_dependency_orders_dep_before_
the_dependent` test) are unaffected. Two things WOULD need updating as
part of implementing this: (1) the public
`ReferenceReplayDriver::transit_rooted_recipes()` method
(`reference_replay.rs:339-341`) and its doc comment (`reference_replay.rs:
326-338`, which explicitly claims "EMPTY for a plain externref-in-a-local
graph") — its own test `plain_externref_graph_has_no_transit_rooted_recipes`
(`reference_replay.rs:727-730`) currently PINS the gap as if it were
intended behavior and would need to change to assert non-empty for that
case (or the helper is renamed/repurposed since "widen Phase 0b" no longer
needs a reachability walk at all — it could become a thin `nodes.iter()
.filter_map(Externref)` helper, or `build_drive_plan` could inline it and
the standalone helper could be deleted); (2) every doc comment cited in
§1.1 that describes the "lazy guest import" architecture needs correcting
to describe the widened Phase 0b instead.

### Candidate (b): genuinely wire the lazy direct-decode import

This would mean either (i) making the instrumenter emit a REAL
`env.__wpk_fork_ref_encode_externref`/`decode_externref` import for
frame-local externref slots specifically (while keeping the GC-bridge path
for GC/exnref-reachable ones) — which requires a static, whole-program
reachability classification per externref-typed local at instrument time
(is this local EVER also reachable from an aggregate, anywhere in the
program?) that the instrumenter does not currently do and that is fragile
by construction (a local's reachability can depend on runtime data flow, not
just static typing); or (ii) reviving fork-module-inject's already-built
`__wpk_fork_ref_decode_externref` EXPORT (architecture (B), §1.1) as a real,
wired host-round-trip import for every externref decode. Either shape adds
a NEW or newly-load-bearing host/module import surface for a case (a) covers
with zero new imports, working entirely inside the already-proven,
already-ordered Phase-0/`fm_drive_execute` wasm mechanism. (ii) in
particular re-introduces a per-externref-decode host callback that the
project's own M2 design ruling (`drive_plan.rs:85-96`'s "WHY this moved out
of Rust") deliberately retired in favor of doing the work in wasm.

### Recommendation

**Candidate (a)**, evidenced above: it is a small, local change
(`drive_plan.rs:446-463` plus the doc/test fallout named above), reuses the
existing, already-safety-proven R1 mechanism unmodified, provably preserves
Phase-0-before-any-frame-decode ordering, leaves the GC/exnref-reachable
path's behavior byte-for-byte unchanged (strict superset), and needs no new
host or module import. It also directly matches how Phase 4/5 already treat
GC nodes (unconditional pass over all matching nodes, §1.2/§5) — i.e. it
makes externref's Phase 0b consistent with the rest of the function's own
existing design, rather than introducing a second decode architecture.

## 3. Root-causing the pre-existing gate hang

Symptom (per the brief): a gated externref fork
(`crates/host-native/fixtures/native_fork_externref_gate.wat`, untouched)
produces `fm_build_gc_plan failed: errno 22` and then hangs for ~30s instead
of a clean `-EOPNOTSUPP` return with the parent surviving.

### 3.1 Why `fm_build_gc_plan` returns EINVAL (22)

The capture-time gate a plain externref local reaches is `gc_lookup`
(`guest.rs:4951-4973`), which calls `NativeReferenceCapture::mark_unsupported`
+ `gated_placeholder()` (`guest.rs:3041-3072`). `gated_placeholder` does NOT
leave a hole in the graph — it **synthesizes a real, self-contained i31
node** (`self.graph.intern_i31(0)`, `guest.rs:3065-3072`) as a
generic stand-in for ANY still-gated kind, and records its id in
`gated_ids` so the (currently-dead, per §1.1(B)) decode bypass can
short-circuit it later.

`drive_fork_capture_seal_and_launch_child`'s gated-abort branch
(`guest.rs:5961-6018`) seals this placeholder-bearing graph
(`write_module_state_arena`, `guest.rs:5953-5959`, running BEFORE the
gate check) and, per its own doc comment (`guest.rs:6002-6015`), still
drives "the SAME reference-replay sub-sequence a supported fork uses
(`fm_begin_reference_replay` + the GC drive plan) against the sealed
placeholder-only graph" via `drive_reference_replay` (`guest.rs:6016-6018`)
— because the PARENT's own call stack was already unwound and must still be
rewound/resumed regardless of whether the fork was gated.

`drive_reference_replay` (`guest.rs:5596-5675`) calls `fm_build_gc_plan`
(`guest.rs:5625`), which runs `build_gc_plan_impl`
(`fork-module/src/lib.rs:681-701`):

```rust
let gc_codecs = decoded_gc_codecs()?;                                   // (1)
let hints = fork_codec::GcCodecHints::new(nodes, &gc_codecs, ...)?;      // (2)
let steps = drive_plan::build_drive_plan(nodes, &hints)?;                // (3)
```

`GcCodecHints::new` derives `i31_owner` as "the smallest activation that
declared a GC descriptor" — literally `gc_codecs.keys().min().copied()`
(`crates/fork-codec/src/drive_plan_hints.rs:98-100`). `build_drive_plan`'s
`allocate_typed` (`drive_plan.rs:308-340`), on the synthetic `I31` node
(`ensure_identity`'s `I31 | Struct | Array` arm, `drive_plan.rs:296-300`),
does `self.hints.i31_owner().ok_or(Errno::EINVAL)?` (`drive_plan.rs:316`) —
**this is confirmed by the crate's own test**
(`drive_plan_hints.rs:644-652`, `i31_owner_is_none_without_a_gc_activation`:
an empty `gc_codecs` map ⇒ `i31_owner() == None` ⇒
`build_drive_plan(...) == Err(Errno::EINVAL)`).

The `gc_codecs` map (1) comes from `decoded_gc_codecs()`
(`fork-module/src/lib.rs:638-652`), which only contains activations that
were explicitly seeded via `fm_set_activation_gc_codec` at host-driven
setup time (`fork-module/src/lib.rs:592-632`). Host-native's own
`drive_reference_replay` doc comment states, in plain language, that this
seeding is **skipped unconditionally on native today**:

> "Native has no GC-codec-byte capture and no host-exception-owner tracking
> yet ... both seed calls are skipped here: there is no data to seed them
> with" — `guest.rs:5552-5560`.

So on host-native, `gc_codecs` is **always the empty map**, for every fork,
gated or not — meaning `i31_owner()` is unconditionally `None` on native.
`build_gc_plan_impl` therefore fails with `Errno::EINVAL` (22) on **any**
graph containing an I31 node, and `gated_placeholder`'s synthetic i31 node
is exactly such a node. This is what produces the observed
`fm_build_gc_plan failed: errno 22`.

(Side note, not this task's fix target: this also means a genuinely
supported native fork carrying a REAL typed-GC/i31 value would hit the same
EINVAL today — native's GC-codec seeding gap is a documented, separate,
pre-existing limitation, not something this investigation's fix should try
to close.)

### 3.2 Why EINVAL becomes a hang instead of a clean abort

`drive_reference_replay` treats any non-zero `fm_last_errno` as a truthful
failure and returns `false` (`guest.rs:5625-5639`). Back in
`drive_fork_capture_seal_and_launch_child`, `if !drive_reference_replay(...)
{ return false; }` (`guest.rs:6016-6018`) — the gated-abort branch bails out
**before ever calling `wpk_fork_rewind_begin`** (`guest.rs:6019-6032`,
never reached). `drive_fork_capture_seal_and_launch_child`'s own doc
comment states the caller's contract for this return value explicitly:
"Returns `false` ... the caller then ends this OS thread without ever
calling `wpk_fork_resume_start`" (`guest.rs:5910-5913`).

That caller is `run_fork_capable_entry`'s trampoline loop
(`guest.rs:5675...5793-5857`): on `drive_fork_capture_seal_and_launch_child`
returning `false` it does a bare `return;` (`guest.rs:5846-5848`), ending
the entire native OS thread that is running this guest process's main
control flow. Because the guest's original wasm call stack was already
discarded by the unwind (that is the whole point of the
capture-via-unwind design), and `wpk_fork_resume_start` is never called
again, the guest program **never executes another instruction on this
thread** — in particular it never reaches its own `_start`'s trailing
`call $exit_group` (`native_fork_externref_gate.wat:196-200`), so no
`SYS_EXIT_GROUP` is ever posted on the process's syscall channel.

The channel-servicing event loop, `run_pump` (`guest.rs:6699-6858`), is
waiting for exactly that channel activity to make progress; it has its own
explicit `hard_cap = Instant::now() + Duration::from_secs(30)`
(`guest.rs:6737`) and bails with an error once that elapses
(`guest.rs:6746-6750`). This IS the observed "~30s pump timeout": a truthful
timeout mechanism firing because the guest OS thread silently stopped, not
a livelock inside any single call.

### 3.3 Is the gate/abort path itself buggy? Minimal fix

Yes — the bug is that `drive_fork_capture_seal_and_launch_child`'s
gated-abort branch treats the GATED case identically to a real fork's
rewind for the purpose of driving `fm_build_gc_plan`/`fm_drive_execute`,
but the placeholder graph the gate manufactures (`gated_placeholder`'s
synthetic i31 node) is not actually reconstructable through that machinery
on a host (native) that never seeds GC codecs — an entirely foreseeable
combination the gated-abort path does not special-case.

Minimal, sound fix candidates (not implemented here; grounding only):

1. **Make `gated_placeholder` not require GC-plan participation at all.**
   Its own doc comment already says the graph is "sealed graph is
   discarded unread" (`guest.rs:3052-3064`) for a gated fork — i.e. nothing
   downstream is supposed to need the placeholder's *content* to be a real,
   drivable typed-GC recipe; it only needs SOME node to exist in the
   sealed graph. Have the gated-abort branch (`guest.rs:5961-6018`) skip
   `drive_reference_replay`/`fm_build_gc_plan` entirely for this branch,
   going straight from `fm_begin_replay` to `wpk_fork_rewind_begin` — since
   the parent's OWN resume does not actually need any reference DATA
   reconstructed for a value the platform contract already says is not
   preserved across a gated fork (only that decoding it doesn't trap, which
   the existing `is_gated_id`-checked decode bypass at `guest.rs:4562-4587`
   already handles for the (dead-on-native, §1.1(B)) import path — the
   REAL per-frame decode path (§1.1(A)) has no equivalent bypass yet, which
   is presumably why the plan is still driven at all today). This is the
   narrowest fix: it only changes the gated-abort branch, never touches the
   supported-fork path, and directly matches the "sealed graph is discarded
   unread" invariant already documented.
2. Alternatively, fix root: seed `decoded_gc_codecs()` with SOMETHING for
   native (even a minimal always-i31-capable placeholder catalog) so
   `i31_owner()` is never spuriously `None`. This is a bigger, more
   invasive change (native GC-codec seeding is a whole separate,
   documented gap — §3.1's side note) and risks masking the real native
   GC-seeding gap rather than fixing the gate-hang specifically; (1) above
   is preferred as the minimal, scoped fix.

Either way, the concrete symptom to verify against is: a wired test against
the untouched `native_fork_externref_gate.wat` should observe
`exit_code == 0` (not a hang), matching the fixture's own documented
contract (`native_fork_externref_gate.wat:1-58`).

## 4. Replay↔Capture symmetry (directly-held externref)

The decode step's inverse is the CAPTURE-time `intern_externref` call
already committed and working: `guest.rs:4876-4912`'s `encode_externref`
body, backed by `ExternrefProvenance` (`guest.rs`, N1-F5 T2, commit
`9f361364c`) — looking up a live externref's mint-time-recorded handle and
calling `fork_codec::ReferenceGraphBuilder::intern_externref(handle)`,
"the wire-writer that already exists and is the byte-for-byte inverse of
the decoder" (`guest.rs:4862-4864`). That half of the round trip is done
and sound (per the T2 report): it produces a canonical `Externref` recipe
node in the graph for a directly-held value exactly as it would for an
aggregate-reachable one — capture does not distinguish the two cases at
all, and does not need to.

The missing half is entirely on the REPLAY/decode side, and it is
localized to exactly one place: **the drive-plan's Phase 0b schedule**
(`drive_plan.rs:446-463`), which decides which `Externref` recipe ids get a
`table.set` into the transit before any consumer reads it. Every other
piece of the inverse — the wire encoding (`intern_externref`), the
transit-table mechanism itself (`fm_drive_execute`'s injected shim,
`fork-module-inject/src/main.rs:248-348`), the R1 rooting assert, and the
guest's own decode call (`decode_anyref`/`decode_externref`,
`module_gc_codec.rs:1100-1118`) — already exists, is already exercised
daily by the GC/exnref-reachable case, and needs no change. Landing §2's
recommended fix (widen Phase 0b to cover every `Externref` node) is
therefore not "adding a new capability" so much as **completing an inverse
whose other three-quarters were already built and proven** — exactly the
capture↔replay symmetry framing the standing campaign note asks to keep:
the encode side's production-site provenance work (F5 T1/T2) already
exists; this fix is the one remaining, precisely-scoped piece that makes
its decode-side inverse total over the whole reachability domain, not just
the GC/exnref-reachable subset.

## 5. Generalization to FLOOR-2 GC

The GC struct/array/i31 reconstruction path shares essentially all of this
substrate already, and — importantly — is **not** subject to the same gap
today, which is itself informative about the right shape for §2's fix.

Shared pieces: the anyref transit table (STORE #2, `env.__wpk_fork_ref_
gc_transit`); the `DRIVE_OP_*` step vocabulary and `fm_drive_execute`'s
single injected wasm shim that drives ALL of ALLOC/FILL/EXN/STATIC_ROOT/
EXTERNREF_TRANSIT (`fork-module-inject/src/main.rs`); `build_drive_plan`
itself, which interleaves externref-transit publish, GC allocate, and GC
fill into one ordered plan (`drive_plan.rs:413-506`); and `GcCodecHints`
(`drive_plan_hints.rs`), which supplies allocation-dependency/defaultable-
shell/owner facts for structs/arrays/i31 the same way a future
GC-constructor-provenance capture fix would need to.

**Why GC struct/array/i31 does NOT have this gap today**: `build_drive_plan`'s
Phase 4 (allocate/identity walk, `drive_plan.rs:479-481`) and Phase 5 (fill
walk, `drive_plan.rs:485-503`) both iterate `for entry in nodes` —
**every node in the whole recipe graph, unconditionally** — not a
reachability walk from some other kind's edges. A directly-held (frame-
vector-only) Struct/Array/I31 recipe already gets its ALLOC/FILL step today,
with no gap, because these phases were never scoped down to "only if some
other aggregate points at it." Externref's Phase 0b is the ONE phase in
this function that, uniquely, was written as a reachability walk instead of
an unconditional pass — almost certainly because it is a faithful, narrow
port of the JS `materializeTypedGraph`'s own externref-publish step, which
in the pre-wasm-module JS architecture only ever ran for GC/exnref graphs to
begin with (a bare/directly-held externref took an entirely separate JS
code path — a real per-value host decode call, architecture (B) in §1.1 —
that was never carried into the wasm co-resident module). The Rust/wasm
port correctly reproduced the JS function it was mirroring; it just never
inherited the JS SIBLING code path that used to cover the directly-held
case, because that sibling doesn't exist in this architecture anymore.

**Does fixing directly-held externref decode help FLOOR-2 GC-constructor-
provenance work (F6)?** Only indirectly, and asymmetrically:

- It does **not** touch or unblock F6's CAPTURE-side problem (mint-time
  provenance recording analogous to `ExternrefProvenance`, for
  struct/array/i31/static-root construction sites) — that is a completely
  separate, capture-side gate (`gc_claim`/`gc_i31`/`gc_broker_encode`/
  `gc_define`, all still `mark_unsupported` at `guest.rs:4975-5150+`), on
  the opposite half of the capture↔replay symmetry from this fix.
- It **does** fully re-validate, for one more reachability class, the exact
  Phase-0/`fm_drive_execute`/R1-assert substrate that ANY future
  GC-reachable-externref-from-a-directly-held-struct scenario would also
  need — i.e. it is not wasted or throwaway work, but it is validation of
  already-shared machinery, not new machinery F6 would otherwise have to
  build.
- The one substantive, transferable lesson for F6: when F6's own capture
  fix eventually lifts `gc_claim`'s gate for real struct/array construction,
  its own reconstruction will land on Phase 4/5 (already unconditional,
  already correct for "directly held") — F6 will NOT need an equivalent
  "widen from reachability to unconditional" fix, because that asymmetry is
  unique to externref's Phase 0b. F6's actual open problem is entirely on
  the capture side (recording enough provenance at a `struct.new`/
  `array.new` call site to re-derive/re-encode the value later), which this
  investigation did not touch and is out of scope here.
