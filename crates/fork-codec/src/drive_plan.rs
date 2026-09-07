//! GC drive PLAN (Phase 6 item 3b — call_indirect drive-shim mechanism).
//!
//! The co-resident module cannot IMPORT the guest's `__wpk_fork_ref_gc_allocate`
//! / `_gc_fill` exports (the module is instantiated BEFORE the guest, to supply
//! the frame-flip imports). So instead of the JS `materializeTypedGraph`
//! drive-order calling those guest exports, the module drives them through a
//! MUTABLE funcref table (`env.__wpk_fork_drive_table`) the host binds
//! post-instantiation (`table.set(guest _gc_allocate/_gc_fill)`).
//!
//! Since Rust has no `call_indirect` intrinsic, the split is: this pure-Rust
//! code computes an ordered PLAN of [`DriveStep`]s and serializes it into a byte
//! buffer in guest memory; an injected walrus SHIM `fm_drive_execute(plan_ptr,
//! count)` (see `crates/fork-module-inject`) loops the serialized plan and
//! `call_indirect`s the table slot for each step, then — after each ALLOC —
//! reads the guest's shared Wasm-GC transit table (STORE #2) at slot `recipe + 1`
//! with a wasm `table.get` + `ref.is_null` to assert the guest's `_gc_allocate`
//! published a live GC object there (trapping otherwise).
//!
//! Item 3b built ONLY the mechanism, proven on a TRIVIAL single struct (ALLOC
//! then FILL for one recipe): [`trivial_struct_plan`]. Item 3c adds the FULL
//! topological plan-from-graph walk — [`build_drive_plan`] — that reproduces the
//! proven JS `materializeTypedGraph` drive-order (R1 allocate then R2 fill, with
//! dependency-ordered allocation, cycle-breaking, defaultable-shell pre-allocate,
//! exception materialize, and per-activation base seeding) as an ordered
//! [`DriveStep`] sequence.
//!
//! ## Serialized step layout (16 bytes, little-endian) — SHARED with the injected
//! `fm_drive_execute` shim (`crates/fork-module-inject/src/main.rs`) and the host:
//!
//! ```text
//!   +0  op      u32   DRIVE_OP_ALLOC (0) | DRIVE_OP_FILL (1) | DRIVE_OP_EXN (2)
//!                     | DRIVE_OP_STATIC_ROOT (3) | DRIVE_OP_EXTERNREF_TRANSIT (4)
//!   +4  slot    u32   absolute drive-table index = base(activation) + op
//!   +8  recipe  u32   reference recipe id (shim reads GC transit slot recipe+1)
//!   +12 arg     u32   the i32 argument passed to the guest export via call_indirect
//! ```

use wasm_posix_shared::Errno;

/// Bytes per serialized [`DriveStep`]. The injected shim strides the plan by
/// this and reads the four little-endian u32 fields at the offsets above.
pub const DRIVE_STEP_SIZE: usize = 16;

/// Byte offsets of the four u32 step fields (SHARED with the injected shim).
pub const DRIVE_STEP_OFF_OP: usize = 0;
pub const DRIVE_STEP_OFF_SLOT: usize = 4;
pub const DRIVE_STEP_OFF_RECIPE: usize = 8;
pub const DRIVE_STEP_OFF_ARG: usize = 12;

/// `op` value: allocate the aggregate (`_gc_allocate`). After an ALLOC step the
/// shim reads the guest's Wasm-GC transit table (STORE #2) at slot `recipe + 1`
/// with `table.get` + `ref.is_null` to assert the guest published a live object.
pub const DRIVE_OP_ALLOC: u32 = 0;
/// `op` value: fill the aggregate's scalars/edges (`_gc_fill`).
pub const DRIVE_OP_FILL: u32 = 1;
/// `op` value: materialize an exception (`__wpk_fork_exception_materialize`).
/// Like ALLOC/FILL this is a `(i32) -> ()` guest export the shim
/// `call_indirect`s; UNLIKE ALLOC it runs NO store-#2 transit assert (the
/// guest export throws/`catch_ref`s against its own module-local tag and the
/// exnref's reachable externref payloads were already transit-rooted by the
/// Phase 0 DRIVE_OP_EXTERNREF_TRANSIT steps). Mirrors the JS
/// `materializeException` -> `exceptions.materialize(recipeId)` call.
pub const DRIVE_OP_EXN: u32 = 2;
/// `op` value: publish an immutable static-root reference into the anyref transit
/// (the static-root binder). UNLIKE ALLOC/FILL/EXN this drives NO guest export
/// and uses NO drive-table slot (`slot` is 0/unused): the injected shim reads the
/// merged static-root catalog with `table.get(static_root_catalog, fm_static_
/// root_slot(recipe))` and publishes it with `table.set(transit, recipe + 1, v)`,
/// both wasm. `recipe` names the transit slot (`recipe + 1`); the catalog index is
/// computed in the module (per-activation base + ordinal) so it is not carried in
/// the step. Emitted FIRST (before any allocate/fill) so an immutable constructor
/// or a `_gc_fill` edge sees the activation's canonical static-root identity —
/// mirroring the JS `materializeTypedGraph` static-root publish (phase 2).
pub const DRIVE_OP_STATIC_ROOT: u32 = 3;
/// `op` value: publish a reconstructed `externref` into the anyref transit at
/// slot `recipe + 1` (the externref binder — M2). Like DRIVE_OP_STATIC_ROOT it
/// drives NO guest export and uses NO drive-table slot (`slot`/`arg` are
/// 0/unused): the injected shim resolves the externref's live host identity
/// (`resolve_externref(fm_externref_handle(recipe))`), internalizes it
/// (`any.convert_extern`), publishes it with `table.set(anyref_transit, recipe +
/// 1, v)`, and asserts non-null (`ref.is_null` -> truthful trap). `recipe` names
/// the transit slot (`recipe + 1`); the externref handle is looked up in the
/// module (`fm_externref_handle`) so it is not carried in the step.
///
/// WHY this moved out of Rust: `fork-codec` is `no_std` Rust and CANNOT hold an
/// `externref`, so the old path resolved+published externrefs through a u32
/// host seam (`resolve_externref`/`transit_publish`/`transit_read`). Injected
/// wasm CAN hold an `externref`, so — exactly as item 3c moved GC struct/array
/// reconstruction into `fm_drive_execute` — externref transit rooting becomes a
/// drive step executed in wasm, and the host seam methods are deleted. Emitted
/// in Phase 0 (before any allocate/fill), so an immutable constructor (ALLOC) or
/// a `_gc_fill` edge that names the externref reads its rooted identity from the
/// transit. This is the R1 rooting hazard the retired host PHASE-B publish +
/// read-back guarded, now a wasm `table.set` + non-null check. A directly held
/// externref (not reached by a GC/exnref consumer) needs NO step: the guest
/// import `__wpk_fork_ref_decode_externref` resolves it lazily.
pub const DRIVE_OP_EXTERNREF_TRANSIT: u32 = 4;
/// `op` value: run one activation's guest `wpk_fork_module_state_restore(id)`
/// (the child-install first phase). Like ALLOC/FILL/EXN this is a `(i32) -> ()`
/// guest export the shim `call_indirect`s, but it drives NO transit and runs NO
/// store-#2 assert: it reconstructs that activation's GLOBAL/TABLE reference
/// state (funcref/externref/GC) by reading the values the reconstruction steps
/// (Phase 0/0b/3/4/5, above) already rooted in the transit and the module's
/// flipped decode imports. UNLIKE ALLOC/FILL/EXN its op value differs from its
/// drive-table slot offset (`DRIVE_SLOT_RESTORE`), so the plan carries the slot
/// explicitly rather than deriving `slot = base + op`. `arg` is the activation
/// id. Mirrors the JS `restoreModuleState` `activation.moduleState.restore(id)`
/// loop, moving the install SEQUENCING into the module-owned attach plan.
pub const DRIVE_OP_RESTORE: u32 = 5;
/// `op` value: run one activation's guest `wpk_fork_module_state_finish_restore(id)`
/// (the child-install second phase). Same shape as `DRIVE_OP_RESTORE` (a
/// `(i32) -> ()` guest export, no transit/assert, `arg` = activation id, slot
/// carried explicitly via `DRIVE_SLOT_FINISH_RESTORE`). Emitted AFTER every
/// activation's restore step so the two-phase order matches the JS loop
/// (`for act: restore` then `for act: finishRestore`).
pub const DRIVE_OP_FINISH_RESTORE: u32 = 6;

/// Drive-table slots reserved per activation, in slot-offset order:
/// `DRIVE_OP_ALLOC` (0) + `DRIVE_OP_FILL` (1) + `DRIVE_OP_EXN` (2) +
/// `DRIVE_SLOT_RESTORE` (3) + `DRIVE_SLOT_FINISH_RESTORE` (4). Each activation
/// `a` binds its `_gc_allocate`/`_gc_fill`/`__wpk_fork_exception_materialize`/
/// `wpk_fork_module_state_restore`/`wpk_fork_module_state_finish_restore` at
/// `base(a)+offset`. The host reads `fm_drive_table_base` and binds the guest
/// exports at these offsets, so bumping this count stays consistent as long as
/// every side derives its slots from `drive_table_base`. This is an EPHEMERAL
/// runtime host<->module table-binding contract (not a wire/ABI format, not
/// serialized), so growing it is additive.
pub const DRIVE_SLOTS_PER_ACTIVATION: u32 = 5;

/// Drive-table slot offset (within an activation's slice) the host binds that
/// activation's `wpk_fork_module_state_restore` into, and a `DRIVE_OP_RESTORE`
/// step's `slot` field points at. Distinct from `DRIVE_OP_RESTORE` (the op tag)
/// because ALLOC/FILL/EXN already occupy offsets 0/1/2.
pub const DRIVE_SLOT_RESTORE: u32 = 3;
/// Drive-table slot offset the host binds `wpk_fork_module_state_finish_restore`
/// into (see `DRIVE_SLOT_RESTORE`).
pub const DRIVE_SLOT_FINISH_RESTORE: u32 = 4;

/// One drive step: which guest export to `call_indirect` (via `slot`) with which
/// `arg`, tagged by `op` so the shim knows whether to run the R1 assert.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DriveStep {
    pub op: u32,
    pub slot: u32,
    pub recipe: u32,
    pub arg: u32,
}

/// The first drive-table slot belonging to `activation`. A single-activation
/// fork uses base 0, so its ALLOC slot is 0 and FILL slot is 1 — the trivial
/// mechanism this slice proves. Multi-activation base seeding is item 3c.
pub fn drive_table_base(activation: u32) -> u32 {
    activation.wrapping_mul(DRIVE_SLOTS_PER_ACTIVATION)
}

/// Serialize `steps` into `out` (a guest-memory scratch region). Returns the
/// number of bytes written. Fails `EINVAL` if `out` is too small rather than
/// truncating — a short plan buffer is a host bug, never a silent partial drive.
pub fn serialize_plan(steps: &[DriveStep], out: &mut [u8]) -> Result<usize, Errno> {
    let need = steps
        .len()
        .checked_mul(DRIVE_STEP_SIZE)
        .ok_or(Errno::EINVAL)?;
    if out.len() < need {
        return Err(Errno::EINVAL);
    }
    for (index, step) in steps.iter().enumerate() {
        let base = index * DRIVE_STEP_SIZE;
        out[base + DRIVE_STEP_OFF_OP..base + DRIVE_STEP_OFF_OP + 4]
            .copy_from_slice(&step.op.to_le_bytes());
        out[base + DRIVE_STEP_OFF_SLOT..base + DRIVE_STEP_OFF_SLOT + 4]
            .copy_from_slice(&step.slot.to_le_bytes());
        out[base + DRIVE_STEP_OFF_RECIPE..base + DRIVE_STEP_OFF_RECIPE + 4]
            .copy_from_slice(&step.recipe.to_le_bytes());
        out[base + DRIVE_STEP_OFF_ARG..base + DRIVE_STEP_OFF_ARG + 4]
            .copy_from_slice(&step.arg.to_le_bytes());
    }
    Ok(need)
}

/// Read step `index` from a serialized plan. Bounds-checked; `EINVAL` past the
/// end. This is the inverse of [`serialize_plan`] used by tests and the host to
/// verify the bytes the shim will read.
pub fn read_step(plan: &[u8], index: usize) -> Result<DriveStep, Errno> {
    let base = index
        .checked_mul(DRIVE_STEP_SIZE)
        .ok_or(Errno::EINVAL)?;
    let end = base.checked_add(DRIVE_STEP_SIZE).ok_or(Errno::EINVAL)?;
    if plan.len() < end {
        return Err(Errno::EINVAL);
    }
    let read_u32 = |offset: usize| -> u32 {
        let start = base + offset;
        let mut bytes = [0u8; 4];
        bytes.copy_from_slice(&plan[start..start + 4]);
        u32::from_le_bytes(bytes)
    };
    Ok(DriveStep {
        op: read_u32(DRIVE_STEP_OFF_OP),
        slot: read_u32(DRIVE_STEP_OFF_SLOT),
        recipe: read_u32(DRIVE_STEP_OFF_RECIPE),
        arg: read_u32(DRIVE_STEP_OFF_ARG),
    })
}

/// The TRIVIAL single-struct plan the mechanism proof drives: ALLOC then FILL
/// for ONE recipe in `activation`. Enough to prove the shim loops the plan,
/// `call_indirect`s the bound guest exports in order, and runs the R1 assert
/// after ALLOC. The full graph walk is item 3c.
pub fn trivial_struct_plan(activation: u32, recipe: u32) -> [DriveStep; 2] {
    let base = drive_table_base(activation);
    [
        DriveStep {
            op: DRIVE_OP_ALLOC,
            slot: base + DRIVE_OP_ALLOC,
            recipe,
            arg: recipe,
        },
        DriveStep {
            op: DRIVE_OP_FILL,
            slot: base + DRIVE_OP_FILL,
            recipe,
            arg: recipe,
        },
    ]
}

// -- Full topological plan-from-graph walk (Phase 6 item 3c) ------------------

use alloc::collections::BTreeSet;
use alloc::vec::Vec;

use crate::reference_recipes::{node_edges, ReferenceRecipeEntry, ReferenceRecipeNode};

/// The GC-layout facts [`build_drive_plan`] cannot read from the reference graph
/// alone, supplied by the caller (in production, computed from the decoded
/// per-activation `kandelo.wpk_fork.gc_codec` layout catalog, exactly as the JS
/// `ForkEarlyChildReferenceProvider` reads its `ForkGcLayoutDescriptor`s).
///
/// The reference-recipe graph names each struct/array's raw `fields`/`elements`
/// edges but NOT which of them are *constructor* (allocation-time) dependencies
/// versus mutable fields filled later — that split lives in the layout
/// descriptor (`provenanceReferenceCount` + `FORK_GC_FIELD_ALLOCATION_DEPENDENCY`
/// flags), and it is what makes the allocate order topological. It also names
/// the defaultable-shell layouts (pre-allocated before the identity walk) and
/// the i31 / exception OWNER activations (the smallest GC- / exception-declaring
/// activation, and the host-exception remap), none of which are graph-local.
///
/// The trait mirrors the JS drive-order's inputs field-for-field:
///
/// * [`allocation_dependencies`](Self::allocation_dependencies) == the JS
///   `gcAllocationDependencies(node, layout)` result for a struct/array recipe
///   (its constructor-dependency edges, in order). MUST be empty for i31 and for
///   any non-typed recipe.
/// * [`is_defaultable_shell`](Self::is_defaultable_shell) == the JS
///   `(layout.flags & FORK_GC_LAYOUT_DEFAULTABLE_SHELL) !== 0` for a struct/array
///   recipe (pre-allocated with NO dependency walk).
/// * [`i31_owner`](Self::i31_owner) == the JS `i31Owner` (the activation whose
///   `_gc_allocate` mints i31 values); `None` when the graph has no i31 node.
/// * [`exn_owner`](Self::exn_owner) == the JS `directOwner(node)` for an exnref
///   recipe (its `module_activation`, or the host-exception owner for the
///   reserved host activation id); `None` only for a non-exnref recipe.
pub trait DrivePlanHints {
    /// The ordered constructor-dependency edges of struct/array `recipe_id`
    /// (empty for i31 / non-typed recipes). Faithful to `gcAllocationDependencies`.
    fn allocation_dependencies(&self, recipe_id: u32) -> &[u32];
    /// Whether struct/array `recipe_id` is a defaultable-shell layout.
    fn is_defaultable_shell(&self, recipe_id: u32) -> bool;
    /// The activation that owns i31 allocation, if the graph carries any i31.
    fn i31_owner(&self) -> Option<u32>;
    /// The activation that materializes exnref `recipe_id` (its `directOwner`).
    fn exn_owner(&self, recipe_id: u32) -> Option<u32>;
}

/// The mutable walk state for one `build_drive_plan` call. The memo sets mirror
/// the JS provider's `allocatedTypedRecipes` / `filledTypedRecipes` /
/// `materializedExceptionRecipes` (each drive call is issued at most once), and
/// `visiting` mirrors the JS per-walk `visiting` set that detects an
/// unallocatable constructor cycle.
struct PlanWalk<'a, H: DrivePlanHints> {
    nodes: &'a [ReferenceRecipeEntry],
    hints: &'a H,
    allocated: BTreeSet<u32>,
    filled: BTreeSet<u32>,
    materialized_exn: BTreeSet<u32>,
    visiting: BTreeSet<u32>,
    steps: Vec<DriveStep>,
}

impl<'a, H: DrivePlanHints> PlanWalk<'a, H> {
    /// The node at canonical id `recipe_id` (the decoder guarantees id == index).
    fn node(&self, recipe_id: u32) -> Result<&'a ReferenceRecipeNode, Errno> {
        let entry = self.nodes.get(recipe_id as usize).ok_or(Errno::EINVAL)?;
        if entry.id != recipe_id {
            return Err(Errno::EINVAL); // non-canonical graph
        }
        Ok(&entry.node)
    }

    /// Push one drive step for guest export `op` in `activation`, driven with the
    /// recipe id as both the transit key (`recipe`) and the guest `arg`.
    fn emit(&mut self, op: u32, activation: u32, recipe_id: u32) {
        let slot = drive_table_base(activation) + op;
        self.steps.push(DriveStep {
            op,
            slot,
            recipe: recipe_id,
            arg: recipe_id,
        });
    }

    /// Mirror the JS `ensureIdentity`: dispatch by kind. Only the typed-GC
    /// (allocate) and exnref (materialize) arms issue a guest drive step; null /
    /// funcref / static-root / externref emit nothing HERE. They are reconstructed
    /// outside the allocate/fill walk: the funcref shim, the lazy guest externref
    /// decode import, and — for a static root or a GC/exnref-reachable externref —
    /// the DRIVE_OP_STATIC_ROOT / DRIVE_OP_EXTERNREF_TRANSIT step emitted in Phase 0
    /// (before this walk), so the reference is already published into the transit
    /// by the time an edge reads it, exactly as the JS `materializeTypedGraph`
    /// publishes them first.
    fn ensure_identity(&mut self, recipe_id: u32) -> Result<(), Errno> {
        match self.node(recipe_id)? {
            ReferenceRecipeNode::Null
            | ReferenceRecipeNode::Funcref { .. }
            | ReferenceRecipeNode::StaticRoot { .. }
            | ReferenceRecipeNode::Externref { .. } => Ok(()),
            ReferenceRecipeNode::Exnref { .. } => self.materialize_exception(recipe_id),
            ReferenceRecipeNode::I31 { .. }
            | ReferenceRecipeNode::Struct { .. }
            | ReferenceRecipeNode::Array { .. } => self.allocate_typed(recipe_id, false),
        }
    }

    /// Mirror the JS `allocateTyped`: allocate a struct/array/i31 recipe (its
    /// `_gc_allocate` ALLOC step) after recursively ensuring its constructor
    /// dependencies (unless a defaultable-shell pre-allocate, which takes no
    /// dependency walk). Idempotent; a re-entry on a recipe still in `visiting`
    /// is an unallocatable constructor cycle -> `EINVAL` (the JS throw).
    fn allocate_typed(&mut self, recipe_id: u32, defaultable_shell: bool) -> Result<(), Errno> {
        if self.allocated.contains(&recipe_id) {
            return Ok(());
        }
        if self.visiting.contains(&recipe_id) {
            return Err(Errno::EINVAL); // unallocatable constructor cycle
        }
        let activation = match self.node(recipe_id)? {
            ReferenceRecipeNode::I31 { .. } => self.hints.i31_owner().ok_or(Errno::EINVAL)?,
            ReferenceRecipeNode::Struct {
                module_activation, ..
            }
            | ReferenceRecipeNode::Array {
                module_activation, ..
            } => *module_activation,
            _ => return Err(Errno::EINVAL), // not a typed recipe
        };
        self.visiting.insert(recipe_id);
        // struct/array constructor dependencies are ensured first so an immutable
        // constructor never reads a not-yet-allocated aggregate; i31 has none, and
        // a defaultable shell is pre-allocated empty (deps come on the later walk).
        if !defaultable_shell {
            // Copy out of the caller's hints before the &mut self recursion.
            let deps: Vec<u32> = self.hints.allocation_dependencies(recipe_id).to_vec();
            for dependency in deps {
                self.ensure_identity(dependency)?;
            }
        }
        self.emit(DRIVE_OP_ALLOC, activation, recipe_id);
        self.allocated.insert(recipe_id);
        self.visiting.remove(&recipe_id);
        Ok(())
    }

    /// Mirror the JS `materializeException`: ensure every reference payload's
    /// identity, then issue the exnref's materialize (EXN) step in its owner
    /// activation. Idempotent; a re-entry while visiting is a cycle -> `EINVAL`.
    fn materialize_exception(&mut self, recipe_id: u32) -> Result<(), Errno> {
        if self.materialized_exn.contains(&recipe_id) {
            return Ok(());
        }
        if self.visiting.contains(&recipe_id) {
            return Err(Errno::EINVAL); // unallocatable exception cycle
        }
        let payloads: Vec<u32> = match self.node(recipe_id)? {
            ReferenceRecipeNode::Exnref { payloads, .. } => payloads.clone(),
            _ => return Err(Errno::EINVAL), // not an exception recipe
        };
        let owner = self.hints.exn_owner(recipe_id).ok_or(Errno::EINVAL)?;
        self.visiting.insert(recipe_id);
        for payload in payloads {
            self.ensure_identity(payload)?;
        }
        self.emit(DRIVE_OP_EXN, owner, recipe_id);
        self.materialized_exn.insert(recipe_id);
        self.visiting.remove(&recipe_id);
        Ok(())
    }
}

/// Build the ordered drive plan for a fork's whole reference graph, reproducing
/// the proven JS `materializeTypedGraph` drive-order as a serializable
/// [`DriveStep`] sequence for `fm_drive_execute`.
///
/// `nodes` is the decoded, canonical (`id == index`) reference-recipe graph;
/// `hints` supplies the per-recipe GC-layout facts the graph does not carry (see
/// [`DrivePlanHints`]). The host gate keeps only admitted graphs (null / funcref
/// / externref / exnref / typed-GC — no static-root) on this path, so a
/// static-root recipe here is a caller error, but it simply emits no step (it is
/// not a drive kind), exactly as `ensureIdentity` treats it.
///
/// The plan issues, in order:
///
/// 0. **Reference transit publish** (Phase 0): a DRIVE_OP_STATIC_ROOT step for
///    every immutable static root, then a DRIVE_OP_EXTERNREF_TRANSIT step for
///    EVERY `Externref` recipe node in the graph — GC/exnref-reachable ones and
///    directly-held (frame-vector-only) ones alike — each publishing into the
///    anyref transit at slot `recipe + 1` BEFORE any allocate/fill so an
///    immutable constructor, a `_gc_fill` edge, or the guest's own per-frame
///    decode reads the canonical rooted identity. This replaces the retired
///    Rust host PHASE B (externref publish + read-back) with an in-wasm
///    `table.set` + non-null check. `fork_codec::ReferenceGraphBuilder::
///    intern_externref` already guarantees one canonical recipe id per
///    distinct externref identity, so iterating every `Externref` node is
///    already deduped by construction — no reachability walk is needed (see
///    `reference_replay::transit_rooted_recipes`'s doc comment for why an
///    earlier version of this phase was scoped to a GC/exnref-only
///    reachability walk, and the substrate grounding doc for the root cause
///    and fix rationale).
/// 1. **Defaultable-shell pre-allocate** (JS phase 3): an ALLOC step for every
///    reachable struct/array whose layout is a defaultable shell, in id order,
///    with NO dependency walk — so a shell exists before the identity walk fills
///    a cycle through it.
/// 2. **Allocate / identity walk** (JS phase 4): `ensureIdentity` over every node
///    in id order, which post-order-allocates each typed recipe after its
///    constructor dependencies (topological with cycle-breaking) and materializes
///    each exnref after its payloads. Emits ALLOC (`_gc_allocate`) and EXN
///    (`__wpk_fork_exception_materialize`) steps.
/// 3. **Fill walk** (JS phase 5): a FILL (`_gc_fill`) step for every struct/array
///    not yet filled, in id order, after re-ensuring its edges' identity (already
///    satisfied, so no new steps).
///
/// The null/funcref reconstruction is NOT in this plan: null/funcref stay the
/// injected funcref shim. EVERY `Externref` recipe node — GC/exnref-reachable
/// or directly held (frame-vector-only) — enters the plan (Phase 0b
/// DRIVE_OP_EXTERNREF_TRANSIT), because the guest's own `decode_anyref`/
/// `decode_externref` local functions read every externref out of the shared
/// anyref transit table unconditionally (there is no separate lazy per-value
/// host decode import in the architecture `wasm-fork-instrument` actually
/// builds — see the substrate grounding doc, §1.1).
///
/// Returns `Err(Errno::EINVAL)` on a non-canonical graph, a missing i31/exn
/// owner, or an unallocatable constructor/exception cycle (the JS throw); it
/// never panics.
pub fn build_drive_plan<H: DrivePlanHints>(
    nodes: &[ReferenceRecipeEntry],
    hints: &H,
) -> Result<Vec<DriveStep>, Errno> {
    let mut walk = PlanWalk {
        nodes,
        hints,
        allocated: BTreeSet::new(),
        filled: BTreeSet::new(),
        materialized_exn: BTreeSet::new(),
        visiting: BTreeSet::new(),
        steps: Vec::new(),
    };

    // Phase 0 — static-root publish (id order): the static-root binder publishes
    // every immutable static root into the anyref transit at slot `recipe + 1`
    // BEFORE any allocate/fill, so an immutable constructor or a `_gc_fill` edge
    // that names a static root reads the activation's canonical identity. Mirrors
    // the JS `materializeTypedGraph` static-root publish (phase 2, before the
    // allocate walk). A DRIVE_OP_STATIC_ROOT step drives no guest export (slot 0)
    // and takes no dependency walk — the identity already exists in the guest's
    // fresh instance; the shim only re-roots it in the transit.
    for entry in nodes {
        if matches!(entry.node, ReferenceRecipeNode::StaticRoot { .. }) {
            walk.steps.push(DriveStep {
                op: DRIVE_OP_STATIC_ROOT,
                slot: 0,
                recipe: entry.id,
                arg: 0,
            });
        }
    }

    // Phase 0b — externref transit publish (id order): EVERY `Externref` recipe
    // node in the graph is published into the anyref transit at slot `recipe + 1`
    // BEFORE any allocate/fill, so an immutable constructor (ALLOC), a `_gc_fill`
    // edge, or the guest's own per-frame decode reads its rooted identity.
    // Mirrors the static-root publish above (and the retired host PHASE B).
    //
    // This is an UNCONDITIONAL pass over all nodes, not a reachability walk —
    // matching Phase 4/5's treatment of Struct/Array/I31 below. A directly held
    // (frame-vector-only) externref is NOT reachable from any Struct/Array/Exnref
    // edge, but its decode still reads the SAME shared transit table via the
    // guest's local `decode_anyref`/`decode_externref` functions (there is no
    // separate lazy per-value host decode import in the built architecture — see
    // the substrate grounding doc, §1.1/§1.2), so it must be published here too or
    // its transit slot is left unset and the guest's `table.get` traps
    // out-of-bounds. `fork_codec::ReferenceGraphBuilder::intern_externref`
    // guarantees one canonical recipe id per distinct externref identity, so this
    // pass is already deduped by construction; the previous GC/exnref-only
    // reachability walk's output is a strict subset of this one. Like a
    // static-root step this drives no guest export and uses no drive-table slot
    // (`slot`/`arg` unused); the injected shim resolves the handle,
    // `any.convert_extern`s it, `table.set`s the transit, and asserts non-null.
    for entry in nodes {
        if matches!(entry.node, ReferenceRecipeNode::Externref { .. }) {
            walk.steps.push(DriveStep {
                op: DRIVE_OP_EXTERNREF_TRANSIT,
                slot: 0,
                recipe: entry.id,
                arg: 0,
            });
        }
    }

    // Phase 3 — defaultable-shell pre-allocate (id order, no dependency walk).
    for entry in nodes {
        let is_shell = matches!(
            entry.node,
            ReferenceRecipeNode::Struct { .. } | ReferenceRecipeNode::Array { .. }
        ) && hints.is_defaultable_shell(entry.id);
        if is_shell && !walk.allocated.contains(&entry.id) {
            walk.allocate_typed(entry.id, true)?;
        }
    }

    // Phase 4 — allocate / identity walk (id order). `visiting` is empty between
    // top-level calls (each completes and removes itself), matching the JS shared
    // per-walk set.
    for entry in nodes {
        walk.ensure_identity(entry.id)?;
    }

    // Phase 5 — fill walk (id order): FILL every struct/array once, after
    // re-ensuring edge identity (idempotent; deps are already allocated).
    for entry in nodes {
        let (activation, edges) = match &entry.node {
            ReferenceRecipeNode::Struct {
                module_activation, ..
            }
            | ReferenceRecipeNode::Array {
                module_activation, ..
            } => (*module_activation, node_edges(&entry.node)),
            _ => continue,
        };
        if walk.filled.contains(&entry.id) {
            continue;
        }
        for &edge in edges {
            walk.ensure_identity(edge)?;
        }
        walk.emit(DRIVE_OP_FILL, activation, entry.id);
        walk.filled.insert(entry.id);
    }

    Ok(walk.steps)
}

/// Append the child-install steps (the module-owned `fm_attach_child` /
/// `fm_attach_borrowed_child` tail) to a drive plan: one `DRIVE_OP_RESTORE` step
/// per activation, THEN one `DRIVE_OP_FINISH_RESTORE` step per activation, in the
/// caller's activation order. This reproduces the JS
/// `ForkActivationRegistry.restoreModuleState` sequencing —
/// `for act: moduleState.restore(id)` then `for act: moduleState.finishRestore(id)`
/// — as module-driven `call_indirect`s over the host-bound drive table, so the
/// guest's own layout-specific global/table restore exports place the
/// reconstructed reference identities into the live child while the MODULE owns
/// the two-phase order.
///
/// `activations` is the full ordered activation set (every `Module`-record
/// activation, not only reference-bearing ones — a reference-free activation in a
/// multi-activation dlopen fork still restores its globals/tables). The steps are
/// appended AFTER the reconstruction steps so every restore reads identities the
/// Phase 0/0b/3/4/5 steps already rooted.
pub fn append_attach_steps(steps: &mut Vec<DriveStep>, activations: &[u32]) {
    for &activation in activations {
        steps.push(DriveStep {
            op: DRIVE_OP_RESTORE,
            slot: drive_table_base(activation) + DRIVE_SLOT_RESTORE,
            recipe: 0,
            arg: activation,
        });
    }
    for &activation in activations {
        steps.push(DriveStep {
            op: DRIVE_OP_FINISH_RESTORE,
            slot: drive_table_base(activation) + DRIVE_SLOT_FINISH_RESTORE,
            recipe: 0,
            arg: activation,
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloc::vec;

    #[test]
    fn drive_table_base_reserves_slots_per_activation() {
        // Five slots per activation (ALLOC, FILL, EXN, RESTORE, FINISH_RESTORE).
        assert_eq!(DRIVE_SLOTS_PER_ACTIVATION, 5);
        assert_eq!(drive_table_base(0), 0);
        assert_eq!(drive_table_base(1), 5);
        assert_eq!(drive_table_base(3), 15);
    }

    #[test]
    fn append_attach_steps_emits_restore_then_finish_per_activation() {
        let mut steps = Vec::new();
        append_attach_steps(&mut steps, &[0, 2]);
        // Phase 1: restore for every activation, in order.
        assert_eq!(
            steps[0],
            DriveStep {
                op: DRIVE_OP_RESTORE,
                slot: drive_table_base(0) + DRIVE_SLOT_RESTORE,
                recipe: 0,
                arg: 0,
            }
        );
        assert_eq!(
            steps[1],
            DriveStep {
                op: DRIVE_OP_RESTORE,
                slot: drive_table_base(2) + DRIVE_SLOT_RESTORE,
                recipe: 0,
                arg: 2,
            }
        );
        // Phase 2: finish-restore for every activation, in order.
        assert_eq!(
            steps[2],
            DriveStep {
                op: DRIVE_OP_FINISH_RESTORE,
                slot: drive_table_base(0) + DRIVE_SLOT_FINISH_RESTORE,
                recipe: 0,
                arg: 0,
            }
        );
        assert_eq!(
            steps[3],
            DriveStep {
                op: DRIVE_OP_FINISH_RESTORE,
                slot: drive_table_base(2) + DRIVE_SLOT_FINISH_RESTORE,
                recipe: 0,
                arg: 2,
            }
        );
        assert_eq!(steps.len(), 4);
    }

    #[test]
    fn trivial_struct_plan_is_alloc_then_fill_for_activation_zero() {
        let plan = trivial_struct_plan(0, 5);
        assert_eq!(
            plan[0],
            DriveStep { op: DRIVE_OP_ALLOC, slot: 0, recipe: 5, arg: 5 }
        );
        assert_eq!(
            plan[1],
            DriveStep { op: DRIVE_OP_FILL, slot: 1, recipe: 5, arg: 5 }
        );
    }

    #[test]
    fn trivial_struct_plan_uses_the_activation_base_slots() {
        // Activation 2 -> base 10 (5 slots/activation): ALLOC slot 10, FILL slot 11.
        let plan = trivial_struct_plan(2, 9);
        assert_eq!(plan[0].slot, 10);
        assert_eq!(plan[1].slot, 11);
    }

    #[test]
    fn serialize_then_read_round_trips_every_field() {
        let plan = trivial_struct_plan(0, 42);
        let mut bytes = vec![0u8; DRIVE_STEP_SIZE * plan.len()];
        let written = serialize_plan(&plan, &mut bytes).unwrap();
        assert_eq!(written, DRIVE_STEP_SIZE * 2);
        assert_eq!(read_step(&bytes, 0).unwrap(), plan[0]);
        assert_eq!(read_step(&bytes, 1).unwrap(), plan[1]);
    }

    #[test]
    fn serialize_rejects_a_short_buffer() {
        let plan = trivial_struct_plan(0, 1);
        let mut bytes = vec![0u8; DRIVE_STEP_SIZE]; // room for one step, need two
        assert_eq!(serialize_plan(&plan, &mut bytes), Err(Errno::EINVAL));
    }

    #[test]
    fn read_step_past_the_end_is_einval() {
        let plan = trivial_struct_plan(0, 1);
        let mut bytes = vec![0u8; DRIVE_STEP_SIZE * plan.len()];
        serialize_plan(&plan, &mut bytes).unwrap();
        assert_eq!(read_step(&bytes, 2), Err(Errno::EINVAL));
    }

    // --- item 3c: build_drive_plan graph-walk ------------------------------

    // `BTreeSet`, `Vec`, `ReferenceRecipeEntry`/`Node`, `node_edges`, and the
    // builder API all arrive via `use super::*`; only `BTreeMap` is new here.
    use alloc::collections::BTreeMap;

    /// A test double for [`DrivePlanHints`]: per-recipe allocation dependencies +
    /// defaultable-shell flags, plus the i31 / exn owner activations. Faithful
    /// stand-in for the production GC-layout-descriptor lookups.
    #[derive(Default)]
    struct MockHints {
        deps: BTreeMap<u32, Vec<u32>>,
        shells: BTreeSet<u32>,
        i31_owner: Option<u32>,
        exn_owner: Option<u32>,
    }

    impl DrivePlanHints for MockHints {
        fn allocation_dependencies(&self, recipe_id: u32) -> &[u32] {
            self.deps.get(&recipe_id).map(|v| v.as_slice()).unwrap_or(&[])
        }
        fn is_defaultable_shell(&self, recipe_id: u32) -> bool {
            self.shells.contains(&recipe_id)
        }
        fn i31_owner(&self) -> Option<u32> {
            self.i31_owner
        }
        fn exn_owner(&self, _recipe_id: u32) -> Option<u32> {
            self.exn_owner
        }
    }

    fn entry(id: u32, node: ReferenceRecipeNode) -> ReferenceRecipeEntry {
        ReferenceRecipeEntry { id, node }
    }

    fn struct_node(id: u32, activation: u32, fields: Vec<u32>) -> ReferenceRecipeEntry {
        entry(
            id,
            ReferenceRecipeNode::Struct {
                module_activation: activation,
                type_ordinal: 1,
                layout_id: 1,
                scalars: vec![0u8; 4],
                fields,
            },
        )
    }

    fn array_node(id: u32, activation: u32, elements: Vec<u32>) -> ReferenceRecipeEntry {
        entry(
            id,
            ReferenceRecipeNode::Array {
                module_activation: activation,
                type_ordinal: 2,
                layout_id: 2,
                scalars: vec![0u8; 2],
                elements,
            },
        )
    }

    /// A step's (op, slot, recipe) — the shape assertions care about.
    fn triple(step: &DriveStep) -> (u32, u32, u32) {
        (step.op, step.slot, step.recipe)
    }

    #[test]
    fn plain_struct_over_externref_publishes_then_allocs_then_fills() {
        // struct(0) -> externref(1). The reachable externref is published into the
        // transit FIRST (Phase 0, DRIVE_OP_EXTERNREF_TRANSIT with slot 0, recipe 1),
        // THEN the struct allocate + fill read it out of the transit.
        let nodes = vec![
            struct_node(0, 0, vec![1]),
            entry(1, ReferenceRecipeNode::Externref { handle: 9 }),
        ];
        let plan = build_drive_plan(&nodes, &MockHints::default()).unwrap();
        assert_eq!(
            plan.iter().map(triple).collect::<Vec<_>>(),
            vec![
                (DRIVE_OP_EXTERNREF_TRANSIT, 0, 1),
                (DRIVE_OP_ALLOC, drive_table_base(0) + DRIVE_OP_ALLOC, 0),
                (DRIVE_OP_FILL, drive_table_base(0) + DRIVE_OP_FILL, 0),
            ]
        );
    }

    #[test]
    fn static_root_steps_are_emitted_first_before_any_allocate() {
        // A struct(0) whose field is a static root(1). The static-root publish MUST
        // precede the struct allocate/fill so an immutable constructor / fill edge
        // reads the activation's canonical static-root identity from the transit.
        let nodes = vec![
            struct_node(0, 0, vec![1]),
            entry(
                1,
                ReferenceRecipeNode::StaticRoot {
                    module_activation: 0,
                    static_root_ordinal: 7,
                },
            ),
        ];
        let plan = build_drive_plan(&nodes, &MockHints::default()).unwrap();
        assert_eq!(
            plan.iter().map(triple).collect::<Vec<_>>(),
            vec![
                // Phase 0: static-root publish (slot 0, no drive-table slot).
                (DRIVE_OP_STATIC_ROOT, 0, 1),
                // Then the struct allocate + fill.
                (DRIVE_OP_ALLOC, drive_table_base(0) + DRIVE_OP_ALLOC, 0),
                (DRIVE_OP_FILL, drive_table_base(0) + DRIVE_OP_FILL, 0),
            ]
        );
    }

    #[test]
    fn static_root_only_graph_emits_just_the_publish_step() {
        // A lone static root (a captured local holds it directly, no aggregate):
        // one DRIVE_OP_STATIC_ROOT step, nothing else. `recipe` names the transit
        // slot (recipe + 1); `slot`/`arg` are unused for a static-root step.
        let nodes = vec![entry(
            0,
            ReferenceRecipeNode::StaticRoot {
                module_activation: 2,
                static_root_ordinal: 0,
            },
        )];
        let plan = build_drive_plan(&nodes, &MockHints::default()).unwrap();
        assert_eq!(plan.len(), 1);
        assert_eq!(plan[0].op, DRIVE_OP_STATIC_ROOT);
        assert_eq!(plan[0].recipe, 0);
        assert_eq!(plan[0].slot, 0);
    }

    #[test]
    fn allocation_dependency_orders_alloc_before_the_dependent() {
        // struct(0) names array(1) as a CONSTRUCTOR dependency (immutable), so the
        // array must be allocated BEFORE the struct even though the struct has the
        // lower id. Mutation guard: if the builder allocated in id order instead,
        // ALLOC 0 would precede ALLOC 1 and this test fails.
        let nodes = vec![struct_node(0, 0, vec![1]), array_node(1, 0, vec![])];
        let mut hints = MockHints::default();
        hints.deps.insert(0, vec![1]); // struct 0 depends on array 1
        let plan = build_drive_plan(&nodes, &hints).unwrap();
        let allocs: Vec<u32> = plan
            .iter()
            .filter(|s| s.op == DRIVE_OP_ALLOC)
            .map(|s| s.recipe)
            .collect();
        assert_eq!(allocs, vec![1, 0]); // dependency first, then the dependent
        // The full order: ALLOC 1, ALLOC 0, FILL 0, FILL 1 (fill is id order).
        assert_eq!(
            plan.iter().map(|s| (s.op, s.recipe)).collect::<Vec<_>>(),
            vec![
                (DRIVE_OP_ALLOC, 1),
                (DRIVE_OP_ALLOC, 0),
                (DRIVE_OP_FILL, 0),
                (DRIVE_OP_FILL, 1),
            ]
        );
    }

    #[test]
    fn every_alloc_precedes_every_fill() {
        // The R1-then-R2 invariant across a multi-node graph: no FILL may appear
        // before the last ALLOC. Mutation guard against interleaving fill into the
        // allocate walk.
        let nodes = vec![
            struct_node(0, 0, vec![1]),
            array_node(1, 0, vec![2]),
            struct_node(2, 0, vec![]),
        ];
        let plan = build_drive_plan(&nodes, &MockHints::default()).unwrap();
        let last_alloc = plan.iter().rposition(|s| s.op == DRIVE_OP_ALLOC).unwrap();
        let first_fill = plan.iter().position(|s| s.op == DRIVE_OP_FILL).unwrap();
        assert!(last_alloc < first_fill, "all ALLOC steps must precede all FILL");
        // Three struct/array nodes -> three ALLOC + three FILL.
        assert_eq!(plan.iter().filter(|s| s.op == DRIVE_OP_ALLOC).count(), 3);
        assert_eq!(plan.iter().filter(|s| s.op == DRIVE_OP_FILL).count(), 3);
    }

    #[test]
    fn struct_array_cycle_over_externref_publishes_then_allocates_all_then_fills() {
        // The CYCLIC graph from reference_replay's tests, with MUTABLE fields (no
        // constructor deps): struct(0) <-> array(1), both reaching externref(2).
        // The aliased externref leaf is published into the transit ONCE (Phase 0)
        // before any allocate; allocate-all-first then breaks the cycle: TRANSIT 2,
        // ALLOC 0, ALLOC 1, FILL 0, FILL 1.
        let nodes = vec![
            struct_node(0, 0, vec![1, 2]),
            array_node(1, 0, vec![0, 2]),
            entry(2, ReferenceRecipeNode::Externref { handle: 12 }),
        ];
        let plan = build_drive_plan(&nodes, &MockHints::default()).unwrap();
        assert_eq!(
            plan.iter().map(|s| (s.op, s.recipe)).collect::<Vec<_>>(),
            vec![
                (DRIVE_OP_EXTERNREF_TRANSIT, 2),
                (DRIVE_OP_ALLOC, 0),
                (DRIVE_OP_ALLOC, 1),
                (DRIVE_OP_FILL, 0),
                (DRIVE_OP_FILL, 1),
            ]
        );
    }

    #[test]
    fn immutable_constructor_cycle_is_einval() {
        // struct(0) and array(1) each name the OTHER as a constructor dependency:
        // an unbreakable allocation cycle. The JS `allocateTyped` throws; the
        // builder is a truthful EINVAL, never a wrong order.
        let nodes = vec![struct_node(0, 0, vec![1]), array_node(1, 0, vec![0])];
        let mut hints = MockHints::default();
        hints.deps.insert(0, vec![1]);
        hints.deps.insert(1, vec![0]);
        assert_eq!(build_drive_plan(&nodes, &hints), Err(Errno::EINVAL));
    }

    #[test]
    fn defaultable_shell_preallocates_before_the_dependency_walk() {
        // struct(0) is a defaultable shell that (as a mutable field) points at
        // array(1); array(1) names struct(0) as a CONSTRUCTOR dependency. Without
        // the shell pre-allocate, allocating array 1 would recurse into struct 0
        // which depends (transitively) back — the shell pass allocates struct 0
        // FIRST with no dependency walk, so the whole graph allocates. The shell's
        // ALLOC must be the very first step.
        let nodes = vec![struct_node(0, 0, vec![1]), array_node(1, 0, vec![0])];
        let mut hints = MockHints::default();
        hints.shells.insert(0); // struct 0 is a defaultable shell
        hints.deps.insert(1, vec![0]); // array 1 constructor-depends on struct 0
        let plan = build_drive_plan(&nodes, &hints).unwrap();
        let allocs: Vec<u32> = plan
            .iter()
            .filter(|s| s.op == DRIVE_OP_ALLOC)
            .map(|s| s.recipe)
            .collect();
        assert_eq!(allocs, vec![0, 1]); // shell 0 pre-allocated, then array 1
        // Each aggregate allocated exactly once despite the shell + walk passes.
        assert_eq!(plan.iter().filter(|s| s.op == DRIVE_OP_ALLOC).count(), 2);
    }

    #[test]
    fn i31_allocates_in_its_owner_activation_with_no_fill() {
        // An i31 is a scalar leaf: one ALLOC in the i31-owner activation, no fill.
        let nodes = vec![entry(0, ReferenceRecipeNode::I31 { value: -17 })];
        let mut hints = MockHints::default();
        hints.i31_owner = Some(4);
        let plan = build_drive_plan(&nodes, &hints).unwrap();
        assert_eq!(
            plan.iter().map(triple).collect::<Vec<_>>(),
            vec![(DRIVE_OP_ALLOC, drive_table_base(4) + DRIVE_OP_ALLOC, 0)]
        );
    }

    #[test]
    fn i31_without_a_seeded_owner_is_einval() {
        let nodes = vec![entry(0, ReferenceRecipeNode::I31 { value: 1 })];
        assert_eq!(build_drive_plan(&nodes, &MockHints::default()), Err(Errno::EINVAL));
    }

    #[test]
    fn exnref_over_externref_publishes_payload_then_materializes() {
        // exnref(1) whose payload is externref(0). The reachable payload externref
        // is published into the transit FIRST (Phase 0, DRIVE_OP_EXTERNREF_TRANSIT
        // recipe 0), THEN the exnref emits ONE EXN step in its owner activation.
        let nodes = vec![
            entry(0, ReferenceRecipeNode::Externref { handle: 8 }),
            entry(
                1,
                ReferenceRecipeNode::Exnref {
                    module_activation: 0,
                    tag_ordinal: 0,
                    layout_id: 0,
                    scalars: Vec::new(),
                    payloads: vec![0],
                },
            ),
        ];
        let mut hints = MockHints::default();
        hints.exn_owner = Some(3);
        let plan = build_drive_plan(&nodes, &hints).unwrap();
        assert_eq!(
            plan.iter().map(triple).collect::<Vec<_>>(),
            vec![
                (DRIVE_OP_EXTERNREF_TRANSIT, 0, 0),
                (DRIVE_OP_EXN, drive_table_base(3) + DRIVE_OP_EXN, 1),
            ]
        );
    }

    #[test]
    fn multi_activation_uses_each_nodes_own_activation_base() {
        // A struct in activation 5 and an array in activation 2, independent. Each
        // ALLOC/FILL must land in ITS OWN activation's drive-table slice, never the
        // other's. Mutation guard for the per-activation base seeding.
        let nodes = vec![struct_node(0, 5, vec![]), array_node(1, 2, vec![])];
        let plan = build_drive_plan(&nodes, &MockHints::default()).unwrap();
        assert_eq!(
            plan.iter().map(triple).collect::<Vec<_>>(),
            vec![
                (DRIVE_OP_ALLOC, drive_table_base(5) + DRIVE_OP_ALLOC, 0),
                (DRIVE_OP_ALLOC, drive_table_base(2) + DRIVE_OP_ALLOC, 1),
                (DRIVE_OP_FILL, drive_table_base(5) + DRIVE_OP_FILL, 0),
                (DRIVE_OP_FILL, drive_table_base(2) + DRIVE_OP_FILL, 1),
            ]
        );
        // Activation 5's base (25) and activation 2's base (10) do not overlap
        // (five slots per activation).
        assert_eq!(drive_table_base(5), 25);
        assert_eq!(drive_table_base(2), 10);
    }

    #[test]
    fn funcref_and_null_only_graph_drives_nothing() {
        // A graph with no typed-GC / exnref nodes issues no guest drive step (the
        // funcref shim + Rust reconstruction handle it entirely).
        let nodes = vec![
            entry(0, ReferenceRecipeNode::Null),
            entry(
                1,
                ReferenceRecipeNode::Funcref {
                    module_activation: 0,
                    function_ordinal: 3,
                },
            ),
        ];
        let plan = build_drive_plan(&nodes, &MockHints::default()).unwrap();
        assert!(plan.is_empty());
    }

    #[test]
    fn non_canonical_graph_is_einval() {
        // A stored id that disagrees with its index must fail loudly.
        let nodes = vec![struct_node(9, 0, vec![])];
        assert_eq!(build_drive_plan(&nodes, &MockHints::default()), Err(Errno::EINVAL));
    }

    #[test]
    fn plan_round_trips_through_serialize() {
        // The real plan serializes/reads back field-for-field, so `fm_drive_execute`
        // reads exactly what the builder emitted.
        let nodes = vec![
            struct_node(0, 0, vec![1]),
            entry(1, ReferenceRecipeNode::Externref { handle: 9 }),
        ];
        let plan = build_drive_plan(&nodes, &MockHints::default()).unwrap();
        let mut bytes = vec![0u8; DRIVE_STEP_SIZE * plan.len()];
        serialize_plan(&plan, &mut bytes).unwrap();
        for (index, step) in plan.iter().enumerate() {
            assert_eq!(read_step(&bytes, index).unwrap(), *step);
        }
    }
}
