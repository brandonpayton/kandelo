//! Reference-reconstruction replay driver (Phase 6 D6.1 — funcref + null).
//!
//! Where `reference_transaction` DECODES the live segmented fork reference
//! transaction (KFRV + KFRS) into a validated `SegmentedReferenceTransaction`,
//! this module DRIVES the per-recipe queries the co-resident fork module needs
//! to reconstruct reference values from that graph. It is the small,
//! portable core the module's `__wpk_fork_ref_decode_funcref` export consults:
//! recipe id -> (activation, function-catalog ordinal), so the module can do a
//! `table.get` on the imported function catalog table.
//!
//! ## Admitted kinds (D6.1)
//!
//! This slice admits FUNCREF and NULL ONLY. A funcref is the one reference kind
//! a Wasm module can reconstruct with ZERO new engine-floor callbacks: its
//! identity lives in an engine `Table` (the guest's `__wpk_fork_function_catalog`
//! funcref table), which the module imports and reads with `table.get`. Null is
//! the reserved empty reference. Every OTHER kind (externref, exnref, i31,
//! struct, array, static-root) needs a host identity provider or the anyref
//! transit and is DEFERRED to a later reference slice; asking this driver for
//! one is a truthful `EINVAL`, never a silent wrong value.
//!
//! The host computes the SAME "every node is funcref or null" predicate before
//! flipping the module's funcref import, but the module re-checks
//! (`all_nodes_funcref_or_null`) so a host that disagrees can never drive an
//! unsupported kind through the funcref path — it fails loudly instead.

use wasm_posix_shared::Errno;

use alloc::vec::Vec;

use crate::reference_recipes::{node_edges, ReferenceRecipeEntry, ReferenceRecipeNode};
use crate::reference_transaction::SegmentedReferenceTransaction;

/// The resolved funcref recipe for one node: the activation whose function
/// catalog holds the target and the ordinal within it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FuncrefTarget {
    pub module_activation: u32,
    pub function_ordinal: u32,
}

/// The resolved static-root recipe for one node: the activation whose
/// instantiation-time static-root catalog holds the target and the ordinal
/// within it. The static-root binder maps this to a merged anyref-catalog slot
/// (`base(module_activation) + static_root_ordinal`) for a wasm `table.get`,
/// mirroring [`FuncrefTarget`] for the funcref path.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StaticRootTarget {
    pub module_activation: u32,
    pub static_root_ordinal: u32,
}

/// The result of one reference-reconstruction bookkeeping pass: how many
/// externref nodes the fork reconstructs. Since M2 this carries NO host
/// identities and NO host generation: externref resolution + transit publish no
/// longer cross a Rust host seam. A directly held externref is decoded lazily by
/// the injected guest import `__wpk_fork_ref_decode_externref`, and a
/// GC/exnref-reachable externref is published into the anyref transit by a
/// [`DRIVE_OP_EXTERNREF_TRANSIT`](crate::drive_plan::DRIVE_OP_EXTERNREF_TRANSIT)
/// drive step (injected wasm, which — unlike this `no_std` Rust — can hold an
/// `externref`). What remains is the proof-of-use count.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReconstructionState {
    reconstructed: u32,
}

impl ReconstructionState {
    /// The number of externref nodes the fork reconstructs. Proof-of-use for
    /// `fm_externrefs_resolved` (the injected wasm bumps the live counter when it
    /// resolves each handle; this is the graph-derived expectation).
    pub fn reconstructed(&self) -> u32 {
        self.reconstructed
    }
}

/// Holds a decoded reference transaction and answers the funcref/null recipe
/// queries the co-resident module needs during reference reconstruction.
#[derive(Debug, Clone)]
pub struct ReferenceReplayDriver {
    transaction: SegmentedReferenceTransaction,
}

impl ReferenceReplayDriver {
    /// Wrap a decoded transaction for replay.
    pub fn new(transaction: SegmentedReferenceTransaction) -> Self {
        Self { transaction }
    }

    /// The wrapped transaction (diagnostics / vector access).
    pub fn transaction(&self) -> &SegmentedReferenceTransaction {
        &self.transaction
    }

    /// Number of canonical recipe nodes in the graph.
    pub fn node_count(&self) -> usize {
        self.transaction.nodes.len()
    }

    /// Resolve a funcref-or-null recipe:
    ///
    /// * `Ok(None)` — the recipe is the canonical Null reference (reconstruct
    ///   `ref.null func`).
    /// * `Ok(Some(target))` — a Funcref naming an `(activation, ordinal)` for a
    ///   `table.get` on that activation's function catalog.
    /// * `Err(EINVAL)` — the recipe id is out of range, the graph is internally
    ///   inconsistent, or the node is a kind D6.1 does not admit (anything other
    ///   than Null / Funcref). The caller must NOT fabricate a value; an
    ///   unsupported kind is a truthful failure until its slice lands.
    pub fn funcref_node(&self, recipe_id: u32) -> Result<Option<FuncrefTarget>, Errno> {
        let entry = self
            .transaction
            .nodes
            .get(recipe_id as usize)
            .ok_or(Errno::EINVAL)?;
        // The decoder guarantees canonical id == index; assert it so a corrupt
        // graph reaching here is a loud failure, not a silent mis-resolution.
        if entry.id != recipe_id {
            return Err(Errno::EINVAL);
        }
        match &entry.node {
            ReferenceRecipeNode::Null => Ok(None),
            ReferenceRecipeNode::Funcref {
                module_activation,
                function_ordinal,
            } => Ok(Some(FuncrefTarget {
                module_activation: *module_activation,
                function_ordinal: *function_ordinal,
            })),
            _ => Err(Errno::EINVAL),
        }
    }

    /// Resolve a static-root recipe to its `(activation, ordinal)`:
    ///
    /// * `Ok(target)` — a StaticRoot naming the activation whose static-root
    ///   catalog holds the value and the ordinal within it. The static-root
    ///   binder maps this to a merged anyref-catalog slot (`base(activation) +
    ///   ordinal`) via `fm_static_root_slot` for a wasm `table.get`.
    /// * `Err(EINVAL)` — the recipe id is out of range, the graph is internally
    ///   inconsistent, or the node is not a StaticRoot. The caller must NOT
    ///   fabricate a value; a mismatched kind is a truthful failure.
    ///
    /// Unlike a funcref, a static root is NOT decoded on a guest import: it is
    /// published into the anyref transit at slot `recipe_id + 1` by a
    /// [`DRIVE_OP_STATIC_ROOT`](crate::drive_plan::DRIVE_OP_STATIC_ROOT) drive
    /// step before any `_gc_fill` consumes it, so this accessor answers only the
    /// slot query the injected drive shim needs.
    pub fn static_root_node(&self, recipe_id: u32) -> Result<StaticRootTarget, Errno> {
        let entry = self
            .transaction
            .nodes
            .get(recipe_id as usize)
            .ok_or(Errno::EINVAL)?;
        // The decoder guarantees canonical id == index; assert it so a corrupt
        // graph reaching here is a loud failure, not a silent mis-resolution.
        if entry.id != recipe_id {
            return Err(Errno::EINVAL);
        }
        match &entry.node {
            ReferenceRecipeNode::StaticRoot {
                module_activation,
                static_root_ordinal,
            } => Ok(StaticRootTarget {
                module_activation: *module_activation,
                static_root_ordinal: *static_root_ordinal,
            }),
            _ => Err(Errno::EINVAL),
        }
    }

    /// True when EVERY node in the graph is Null or Funcref — the exact kind set
    /// D6.1 reconstructs through the module. The module gates
    /// `begin_reference_replay` on this so a disagreeing host can never drive an
    /// unsupported reference kind through the funcref import.
    pub fn all_nodes_funcref_or_null(&self) -> bool {
        self.transaction.nodes.iter().all(|entry| {
            matches!(
                entry.node,
                ReferenceRecipeNode::Null | ReferenceRecipeNode::Funcref { .. }
            )
        })
    }

    /// True when EVERY node is Null, Funcref, or Externref — the widened kind set
    /// D6.2 reconstructs through the module. Externref adds the host engine-floor
    /// (`resolve_externref` + the anyref transit) on top of D6.1's funcref/null.
    /// The host computes the same predicate before flipping the reference path;
    /// the module re-checks so a disagreeing host can never drive an unadmitted
    /// kind (exnref / GC struct/array / i31 / static-root) through the seam.
    pub fn all_nodes_externref_funcref_or_null(&self) -> bool {
        self.transaction.nodes.iter().all(|entry| {
            matches!(
                entry.node,
                ReferenceRecipeNode::Null
                    | ReferenceRecipeNode::Funcref { .. }
                    | ReferenceRecipeNode::Externref { .. }
            )
        })
    }

    /// True when EVERY node is Null, Funcref, Externref, or Exnref — the widened
    /// kind set D6.3a admits through the module. An exnref adds NO new
    /// engine-floor callback: its program exception tag is guest-module-local, so
    /// the guest export `__wpk_fork_exception_materialize` does the throw /
    /// `catch_ref` against its own tag. The module's only job is to root the
    /// exnref's reachable externref payloads in the anyref transit
    /// (`transit_rooted_recipes` + PHASE B) before the guest codec consumes them.
    /// The still-deferred aggregate kinds (GC struct/array / i31 / static-root)
    /// need a JS drive-order this slice does not move, so they keep the
    /// byte-identical JS reference path. The host computes the same predicate
    /// (plus an exception-descriptor validity check it alone can see) before
    /// flipping the reference path; the module re-checks so a disagreeing host can
    /// never drive an unadmitted kind through the seam.
    pub fn all_nodes_exnref_externref_funcref_or_null(&self) -> bool {
        self.transaction.nodes.iter().all(|entry| {
            matches!(
                entry.node,
                ReferenceRecipeNode::Null
                    | ReferenceRecipeNode::Funcref { .. }
                    | ReferenceRecipeNode::Externref { .. }
                    | ReferenceRecipeNode::Exnref { .. }
            )
        })
    }

    /// The number of Exnref nodes in the graph — the proof-of-use count the
    /// module bumps into `fm_exnrefs_reconstructed` once an exnref-bearing graph
    /// is admitted and driven through the module. The drive itself leaves the
    /// Exnref arm inert (the guest export materializes the exception), so this
    /// count, not `ReconstructionState::reconstructed`, is what proves the module
    /// (not a silent JS fallback) handled an exnref graph.
    pub fn exnref_node_count(&self) -> u32 {
        self.transaction
            .nodes
            .iter()
            .filter(|entry| matches!(entry.node, ReferenceRecipeNode::Exnref { .. }))
            .count() as u32
    }

    /// True when EVERY node is a kind the module admits: Null, Funcref,
    /// Externref, Exnref, a typed-GC value (Struct / Array / I31), or a
    /// StaticRoot. This is the whole set reference reconstruction drives through
    /// the co-resident module — no kind remains on the JS reference path.
    ///
    /// Admitting typed GC adds NO new engine-floor callback and moves NO
    /// drive-order into the module: the fork side module is instantiated BEFORE
    /// the guest exists, so it cannot import the guest's `_gc_allocate`/`_gc_fill`
    /// exports, and the PROVEN JS drive-order (`materializeTypedGraph`) is
    /// reproduced by `build_drive_plan`. The module's only GC job is leaf-identity
    /// + transit rooting: `transit_rooted_recipes` seeds its reachability walk
    /// from Struct/Array edges, so PHASE B roots every struct/array-reachable
    /// externref leaf with the R1 read-back assert before the guest fill consumes
    /// it. An i31 is a scalar leaf (no host call, no transit).
    ///
    /// A StaticRoot is an IMMUTABLE, `ref.eq`-capable WasmGC reference the module
    /// statically initializes; it too adds NO new engine-floor callback. It is
    /// published into the anyref transit at slot `recipe + 1` by a
    /// [`DRIVE_OP_STATIC_ROOT`](crate::drive_plan::DRIVE_OP_STATIC_ROOT) step
    /// (`table.set(transit, recipe+1, table.get(static_root_catalog, base+ord))`,
    /// both wasm) before any consumer reads it — the static-root binder. The host
    /// computes the same KIND predicate (plus a GC-descriptor validity check only
    /// it can see) before flipping the reference path; the module re-checks so a
    /// disagreeing host can never drive an unadmitted kind through the seam.
    pub fn all_nodes_module_admissible(&self) -> bool {
        self.transaction.nodes.iter().all(|entry| {
            matches!(
                entry.node,
                ReferenceRecipeNode::Null
                    | ReferenceRecipeNode::Funcref { .. }
                    | ReferenceRecipeNode::Externref { .. }
                    | ReferenceRecipeNode::Exnref { .. }
                    | ReferenceRecipeNode::Struct { .. }
                    | ReferenceRecipeNode::Array { .. }
                    | ReferenceRecipeNode::I31 { .. }
                    | ReferenceRecipeNode::StaticRoot { .. }
            )
        })
    }

    /// The distinct set of activations any StaticRoot recipe in the graph names,
    /// sorted ascending (empty when the graph has no static root). The static-root
    /// binder seeds a per-activation merged-catalog base for each activation in
    /// this set (mirroring [`funcref_activations`](Self::funcref_activations)); a
    /// StaticRoot naming an activation with no seeded base is a truthful failure,
    /// never a read against the wrong catalog slice.
    pub fn static_root_activations(&self) -> Vec<u32> {
        let mut activations: Vec<u32> = self
            .transaction
            .nodes
            .iter()
            .filter_map(|entry| match entry.node {
                ReferenceRecipeNode::StaticRoot {
                    module_activation, ..
                } => Some(module_activation),
                _ => None,
            })
            .collect();
        activations.sort_unstable();
        activations.dedup();
        activations
    }

    /// The number of typed-GC nodes (Struct + Array + I31) in the graph — the
    /// proof-of-use count the module bumps into `fm_gc_nodes_reconstructed` once a
    /// typed-GC graph is admitted and driven through the module. The Struct/Array/
    /// I31 arms of `drive_reconstruction` stay inert (the guest drives the GC
    /// allocate/fill under the JS order; the module only roots reachable externref
    /// leaves via PHASE B), so this count — not `ReconstructionState::
    /// reconstructed` — is what proves the module (not a silent JS fallback)
    /// admitted a typed-GC graph.
    pub fn gc_node_count(&self) -> u32 {
        self.transaction
            .nodes
            .iter()
            .filter(|entry| {
                matches!(
                    entry.node,
                    ReferenceRecipeNode::Struct { .. }
                        | ReferenceRecipeNode::Array { .. }
                        | ReferenceRecipeNode::I31 { .. }
                )
            })
            .count() as u32
    }

    /// The recipe ids of externrefs that a typed/exnref consumer REACHES — the
    /// subset that MUST be staged in the anyref transit table (at slot
    /// `recipe_id + 1`) before the consumer's GC fill / exception materialize
    /// reads them (the R1 rooting hazard). Mirrors the reachable-externref set
    /// `materializeTypedGraph` publishes into the transit
    /// (`fork-early-reference-provider.ts:1252-1255`).
    ///
    /// EMPTY for a plain externref-in-a-local graph (no aggregate consumer names
    /// it as an edge). Note this is narrower than what
    /// [`build_drive_plan`](crate::drive_plan::build_drive_plan) actually
    /// publishes into the transit today: `build_drive_plan`'s Phase 0b publishes
    /// EVERY `Externref` recipe node unconditionally (a strict superset of this
    /// reachability walk), because a directly-held externref's decode reads the
    /// SAME shared transit table as a reachable one does — there is no separate
    /// lazy per-value host decode path in the built architecture (see the
    /// 2026-09-05 substrate grounding doc, §1). This method remains useful as the
    /// narrower "reachable from an aggregate" predicate in its own right (e.g. for
    /// reasoning about the GC/exnref-only R1 hazard specifically), but it is no
    /// longer the set `build_drive_plan` iterates for Phase 0b.
    pub fn transit_rooted_recipes(&self) -> Vec<u32> {
        transit_rooted_recipes(&self.transaction.nodes)
    }

    /// Bookkeeping pass over the reference graph: count the externref nodes the
    /// fork reconstructs. Proof-of-use for `fm_externrefs_resolved`.
    ///
    /// Since M2 this NO LONGER resolves externrefs or publishes the anyref
    /// transit through a Rust host seam. `fork-codec` is `no_std` Rust and cannot
    /// hold an `externref`; the old seam (`resolve_externref` -> u32,
    /// `transit_publish`, `transit_read`) existed ONLY to work around that. That
    /// work is now INJECTED WASM (which can hold an `externref`):
    ///
    /// * EVERY `Externref` recipe node — directly held (frame-vector-only) and
    ///   GC/exnref-reachable alike — is published into the anyref transit at
    ///   slot `recipe + 1` by a
    ///   [`DRIVE_OP_EXTERNREF_TRANSIT`](crate::drive_plan::DRIVE_OP_EXTERNREF_TRANSIT)
    ///   step emitted by
    ///   [`build_drive_plan`](crate::drive_plan::build_drive_plan) and executed by
    ///   the injected `fm_drive_execute` shim, which resolves the handle,
    ///   `any.convert_extern`s it, `table.set`s the transit, and asserts non-null
    ///   (the R1 rooting guard the retired host PHASE-B read-back enforced). The
    ///   guest's own `decode_anyref`/`decode_externref` local functions then read
    ///   every externref out of this same transit table unconditionally — there
    ///   is no separate lazy per-value host decode import in the built
    ///   architecture (2026-09-05 substrate grounding doc, §1).
    ///
    /// See the M2 design ruling. So this pass keeps only the graph-derived
    /// externref count; the ordering-and-identity work lives in the drive plan.
    pub fn drive_reconstruction(&self) -> Result<ReconstructionState, Errno> {
        let mut reconstructed: u32 = 0;
        for entry in &self.transaction.nodes {
            if matches!(entry.node, ReferenceRecipeNode::Externref { .. }) {
                reconstructed = reconstructed.checked_add(1).ok_or(Errno::ENOSPC)?;
            }
        }
        Ok(ReconstructionState { reconstructed })
    }

    /// The distinct set of activations any Funcref recipe in the graph names,
    /// sorted ascending (empty for a null-only graph).
    ///
    /// This RETIRES the single-activation `sole_funcref_activation` gate (Phase 6
    /// D7a.1b). A funcref no longer has to belong to one activation: every funcref
    /// resolves against a MERGED, activation-namespaced catalog (the host lays
    /// each activation's function catalog at a distinct base in one imported
    /// table), so funcrefs may span any number of activations. The module seeds a
    /// per-activation catalog base for each activation in this set; a funcref
    /// naming an activation with no seeded base is a truthful failure, never a
    /// read against the wrong catalog. A funcref minted in module A but held by
    /// module B's frame still resolves against A (its `module_activation`), not B
    /// (the caller) — the namespaced catalog is keyed by the recipe's coordinate.
    pub fn funcref_activations(&self) -> Vec<u32> {
        let mut activations: Vec<u32> = self
            .transaction
            .nodes
            .iter()
            .filter_map(|entry| match entry.node {
                ReferenceRecipeNode::Funcref {
                    module_activation, ..
                } => Some(module_activation),
                _ => None,
            })
            .collect();
        activations.sort_unstable();
        activations.dedup();
        activations
    }
}

/// The recipe ids of externrefs a typed/exnref consumer reaches — the externrefs
/// that MUST be staged in the anyref transit table (at slot `recipe_id + 1`)
/// before the consumer's GC fill / exception materialize reads them (the R1
/// rooting hazard). Sorted ascending and deduped, so an aliased leaf reached from
/// several edges is rooted exactly once. This is the set
/// [`build_drive_plan`](crate::drive_plan::build_drive_plan) turns into
/// [`DRIVE_OP_EXTERNREF_TRANSIT`](crate::drive_plan::DRIVE_OP_EXTERNREF_TRANSIT)
/// drive steps for the GC/exnref-reachable subset.
///
/// EMPTY for a plain externref-in-a-local graph (no aggregate consumer reaches
/// it). NOTE: since the 2026-09-05 substrate fix,
/// [`build_drive_plan`](crate::drive_plan::build_drive_plan)'s Phase 0b no
/// longer calls this helper — it publishes EVERY `Externref` recipe node
/// unconditionally (a strict superset), because a directly-held externref's
/// decode reads the same shared transit table a reachable one does. This
/// function remains as the narrower "aggregate-reachable" predicate, still used
/// by [`ReferenceReplayDriver::transit_rooted_recipes`].
pub(crate) fn transit_rooted_recipes(nodes: &[ReferenceRecipeEntry]) -> Vec<u32> {
    // Seed the reachability walk from every aggregate consumer's edges.
    let mut pending: Vec<u32> = Vec::new();
    for entry in nodes {
        if matches!(
            entry.node,
            ReferenceRecipeNode::Exnref { .. }
                | ReferenceRecipeNode::Struct { .. }
                | ReferenceRecipeNode::Array { .. }
        ) {
            pending.extend_from_slice(node_edges(&entry.node));
        }
    }
    let mut seen = alloc::vec![false; nodes.len()];
    let mut rooted: Vec<u32> = Vec::new();
    while let Some(id) = pending.pop() {
        let index = id as usize;
        match seen.get(index) {
            Some(false) => seen[index] = true,
            _ => continue, // out of range (impossible on a decoded graph) or already seen
        }
        let node = &nodes[index].node;
        if matches!(node, ReferenceRecipeNode::Externref { .. }) {
            rooted.push(id);
        }
        pending.extend_from_slice(node_edges(node));
    }
    rooted.sort_unstable();
    rooted.dedup();
    rooted
}

#[cfg(test)]
mod tests {
    use super::*;

    use alloc::vec;
    use alloc::vec::Vec;

    use crate::reference_recipes::ReferenceRecipeEntry;
    use crate::reference_transaction::VectorInternIndex;

    fn entry(id: u32, node: ReferenceRecipeNode) -> ReferenceRecipeEntry {
        ReferenceRecipeEntry { id, node }
    }

    fn transaction(nodes: Vec<ReferenceRecipeEntry>) -> SegmentedReferenceTransaction {
        SegmentedReferenceTransaction {
            roots: Vec::new(),
            nodes,
            vectors: vec![Vec::new()],
            vector_intern: VectorInternIndex::default(),
        }
    }

    /// A funcref-only graph: Null at id 0, two funcrefs after it.
    fn funcref_only() -> ReferenceReplayDriver {
        ReferenceReplayDriver::new(transaction(vec![
            entry(0, ReferenceRecipeNode::Null),
            entry(
                1,
                ReferenceRecipeNode::Funcref {
                    module_activation: 0,
                    function_ordinal: 3,
                },
            ),
            entry(
                2,
                ReferenceRecipeNode::Funcref {
                    module_activation: 0,
                    function_ordinal: 7,
                },
            ),
        ]))
    }

    #[test]
    fn null_recipe_resolves_to_none() {
        assert_eq!(funcref_only().funcref_node(0), Ok(None));
    }

    #[test]
    fn funcref_recipe_resolves_to_target() {
        let driver = funcref_only();
        assert_eq!(
            driver.funcref_node(1),
            Ok(Some(FuncrefTarget {
                module_activation: 0,
                function_ordinal: 3,
            }))
        );
        assert_eq!(
            driver.funcref_node(2),
            Ok(Some(FuncrefTarget {
                module_activation: 0,
                function_ordinal: 7,
            }))
        );
    }

    #[test]
    fn out_of_range_recipe_is_einval() {
        assert_eq!(funcref_only().funcref_node(3), Err(Errno::EINVAL));
        assert_eq!(funcref_only().funcref_node(u32::MAX), Err(Errno::EINVAL));
    }

    #[test]
    fn non_canonical_id_is_einval() {
        // A graph whose stored id disagrees with its index must fail loudly.
        let driver = ReferenceReplayDriver::new(transaction(vec![entry(
            9,
            ReferenceRecipeNode::Null,
        )]));
        assert_eq!(driver.funcref_node(0), Err(Errno::EINVAL));
    }

    #[test]
    fn unsupported_kind_is_einval() {
        // An externref recipe is a valid graph node but NOT a D6.1 funcref path.
        let driver = ReferenceReplayDriver::new(transaction(vec![
            entry(0, ReferenceRecipeNode::Null),
            entry(1, ReferenceRecipeNode::Externref { handle: 5 }),
        ]));
        assert_eq!(driver.funcref_node(1), Err(Errno::EINVAL));
        assert!(!driver.all_nodes_funcref_or_null());
    }

    #[test]
    fn funcref_only_graph_is_supported() {
        assert!(funcref_only().all_nodes_funcref_or_null());
    }

    #[test]
    fn node_count_and_transaction_accessors() {
        let driver = funcref_only();
        assert_eq!(driver.node_count(), 3);
        assert_eq!(driver.transaction().nodes.len(), 3);
    }

    // --- D7a.1b: multi-activation funcref graphs (merged catalog) -----------

    /// A graph whose funcrefs span TWO activations (5 and 2), plus a null. This
    /// is the case the retired `sole_funcref_activation` gate rejected; D7a.1b
    /// admits it and resolves each funcref against its OWN activation's catalog
    /// via the merged, activation-namespaced catalog.
    fn cross_activation_funcref() -> ReferenceReplayDriver {
        ReferenceReplayDriver::new(transaction(vec![
            entry(0, ReferenceRecipeNode::Null),
            entry(
                1,
                ReferenceRecipeNode::Funcref {
                    module_activation: 5,
                    function_ordinal: 1,
                },
            ),
            entry(
                2,
                ReferenceRecipeNode::Funcref {
                    module_activation: 2,
                    function_ordinal: 4,
                },
            ),
            entry(
                3,
                ReferenceRecipeNode::Funcref {
                    module_activation: 5,
                    function_ordinal: 9,
                },
            ),
        ]))
    }

    #[test]
    fn funcref_activations_lists_distinct_sorted_activations() {
        // Both activations appear once, sorted ascending — the set the module
        // seeds a per-activation catalog base for.
        assert_eq!(cross_activation_funcref().funcref_activations(), vec![2, 5]);
    }

    #[test]
    fn cross_activation_funcrefs_resolve_against_their_own_activation() {
        // A funcref minted in activation 5 stays activation 5 even in a graph
        // that also holds an activation-2 funcref: `funcref_node` resolves each
        // against its OWN `(module_activation, function_ordinal)`, never the
        // caller's. The merged catalog namespaces by exactly this coordinate.
        let driver = cross_activation_funcref();
        assert_eq!(
            driver.funcref_node(1),
            Ok(Some(FuncrefTarget {
                module_activation: 5,
                function_ordinal: 1,
            }))
        );
        assert_eq!(
            driver.funcref_node(2),
            Ok(Some(FuncrefTarget {
                module_activation: 2,
                function_ordinal: 4,
            }))
        );
        assert_eq!(
            driver.funcref_node(3),
            Ok(Some(FuncrefTarget {
                module_activation: 5,
                function_ordinal: 9,
            }))
        );
    }

    #[test]
    fn funcref_activations_empty_for_null_only_graph() {
        let driver = ReferenceReplayDriver::new(transaction(vec![entry(
            0,
            ReferenceRecipeNode::Null,
        )]));
        assert!(driver.funcref_activations().is_empty());
    }

    #[test]
    fn funcref_activations_single_for_one_activation_graph() {
        // The single-activation graph reports exactly its one activation, so the
        // module's byte-identical base-empty path (base 0) still applies.
        assert_eq!(funcref_only().funcref_activations(), vec![0]);
    }

    // --- externref reconstruction as drive-plan steps (M2) -----------------
    //
    // Since M2 the externref resolve + transit publish + R1 read-back no longer
    // cross a Rust host seam (that seam was deleted). So these tests assert the
    // PLAN STRUCTURE `build_drive_plan` emits — a DRIVE_OP_EXTERNREF_TRANSIT step
    // for every GC/exnref-reachable externref, in Phase 0 (before any
    // allocate/fill/materialize that reads it) — plus the graph-derived
    // `drive_reconstruction` proof-of-use count. End-to-end externref IDENTITY
    // reconstruction (resolve the handle, `any.convert_extern`, non-null check)
    // is validated at the wasm level in M2 Tasks 3/6, not here in `no_std` Rust.

    use crate::drive_plan::{
        build_drive_plan, drive_table_base, DrivePlanHints, DriveStep, DRIVE_OP_ALLOC,
        DRIVE_OP_EXN, DRIVE_OP_EXTERNREF_TRANSIT, DRIVE_OP_FILL,
    };

    /// A minimal [`DrivePlanHints`] for these graphs: no constructor
    /// dependencies, no defaultable shells, no i31 owner, and a configurable exn
    /// owner. Enough to drive `build_drive_plan` over the struct/array/exnref
    /// graphs below (whose typed nodes carry no allocation dependencies).
    #[derive(Default)]
    struct TestHints {
        exn_owner: Option<u32>,
    }

    impl DrivePlanHints for TestHints {
        fn allocation_dependencies(&self, _recipe_id: u32) -> &[u32] {
            &[]
        }
        fn is_defaultable_shell(&self, _recipe_id: u32) -> bool {
            false
        }
        fn i31_owner(&self) -> Option<u32> {
            None
        }
        fn exn_owner(&self, _recipe_id: u32) -> Option<u32> {
            self.exn_owner
        }
    }

    /// A step's (op, recipe) — the shape the plan-order assertions care about.
    fn op_recipe(step: &DriveStep) -> (u32, u32) {
        (step.op, step.recipe)
    }

    /// A plain externref-in-a-local graph: Null at id 0, two durable externrefs.
    /// No aggregate consumer, so nothing is transit-rooted (D6.2 case).
    fn plain_externref() -> ReferenceReplayDriver {
        ReferenceReplayDriver::new(transaction(vec![
            entry(0, ReferenceRecipeNode::Null),
            entry(1, ReferenceRecipeNode::Externref { handle: 7 }),
            entry(2, ReferenceRecipeNode::Externref { handle: 42 }),
        ]))
    }

    /// A transit-reachable graph (hand-built): a struct whose field edge names an
    /// externref, so the externref must be published into the anyref transit
    /// before the struct fill consumes it. D6.2 does not admit structs in
    /// production (the gate rejects them), but `drive_reconstruction` walks this
    /// directly to exercise PHASE B without waiting for the aggregate slice.
    fn struct_over_externref() -> ReferenceReplayDriver {
        ReferenceReplayDriver::new(transaction(vec![
            entry(
                0,
                ReferenceRecipeNode::Struct {
                    module_activation: 3,
                    type_ordinal: 1,
                    layout_id: 9,
                    scalars: alloc::vec![0u8; 4],
                    fields: vec![1],
                },
            ),
            entry(1, ReferenceRecipeNode::Externref { handle: 5 }),
        ]))
    }

    #[test]
    fn widened_gate_admits_externref_funcref_null() {
        assert!(plain_externref().all_nodes_externref_funcref_or_null());
        assert!(funcref_only().all_nodes_externref_funcref_or_null());
        // A struct is still not an admitted kind for D6.2.
        assert!(!struct_over_externref().all_nodes_externref_funcref_or_null());
    }

    #[test]
    fn plain_externref_graph_has_no_transit_rooted_recipes() {
        assert!(plain_externref().transit_rooted_recipes().is_empty());
        assert!(funcref_only().transit_rooted_recipes().is_empty());
    }

    #[test]
    fn plain_externref_graph_emits_a_transit_step_per_externref_and_counts_each() {
        // A plain externref graph has no GC/exnref consumer (so
        // `transit_rooted_recipes` — the narrower, aggregate-reachable predicate —
        // is empty for it, per `plain_externref_graph_has_no_transit_rooted_recipes`
        // above). But `build_drive_plan`'s Phase 0b publishes EVERY `Externref`
        // node unconditionally, since a directly-held externref's decode reads the
        // same shared transit table a reachable one does: one
        // DRIVE_OP_EXTERNREF_TRANSIT step per externref (id order), and
        // `drive_reconstruction` reports the graph-derived proof-of-use count (two
        // externrefs).
        let driver = plain_externref();
        let plan = build_drive_plan(&driver.transaction().nodes, &TestHints::default()).unwrap();
        assert_eq!(
            plan.iter().map(op_recipe).collect::<Vec<_>>(),
            vec![
                (DRIVE_OP_EXTERNREF_TRANSIT, 1),
                (DRIVE_OP_EXTERNREF_TRANSIT, 2),
            ]
        );
        assert_eq!(driver.drive_reconstruction().unwrap().reconstructed(), 2);
    }

    #[test]
    fn funcref_only_graph_reconstructs_no_externref() {
        // A funcref/null graph has no externref: zero proof-of-use count and an
        // empty drive plan (the funcref shim + lazy null handle it).
        let driver = funcref_only();
        assert_eq!(driver.drive_reconstruction().unwrap().reconstructed(), 0);
        let plan = build_drive_plan(&driver.transaction().nodes, &TestHints::default()).unwrap();
        assert!(plan.is_empty());
    }

    #[test]
    fn struct_over_externref_publishes_the_reachable_externref_before_the_fill() {
        // The struct-field externref (recipe 1) is reachable, so `build_drive_plan`
        // emits a DRIVE_OP_EXTERNREF_TRANSIT step for it in Phase 0, BEFORE the
        // struct's ALLOC and FILL that read it out of the transit. `recipe` names
        // the transit slot (recipe + 1); `slot`/`arg` are unused for the step.
        let driver = struct_over_externref();
        assert_eq!(driver.transit_rooted_recipes(), vec![1]);
        let plan = build_drive_plan(&driver.transaction().nodes, &TestHints::default()).unwrap();
        assert_eq!(
            plan.iter().map(op_recipe).collect::<Vec<_>>(),
            vec![
                (DRIVE_OP_EXTERNREF_TRANSIT, 1),
                (DRIVE_OP_ALLOC, 0),
                (DRIVE_OP_FILL, 0),
            ]
        );
        // The transit step drives no guest export / drive-table slot.
        let transit = &plan[0];
        assert_eq!(transit.slot, 0);
        assert_eq!(transit.arg, 0);
        // Proof-of-use: one externref reconstructed.
        assert_eq!(driver.drive_reconstruction().unwrap().reconstructed(), 1);
    }

    // --- D6.3a: exnref admission + transit into production ------------------

    /// An exnref whose reference payload names an externref: the externref must
    /// be published into the anyref transit before the guest codec's
    /// `__wpk_fork_exception_materialize` throws/catch_refs it. The MODULE does
    /// not mint the exception tag or throw (that is the guest export's job); it
    /// only re-roots the reachable externref payload, so `drive_reconstruction`'s
    /// Exnref arm stays a no-op while PHASE B still roots the payload.
    fn exnref_over_externref() -> ReferenceReplayDriver {
        ReferenceReplayDriver::new(transaction(vec![
            entry(0, ReferenceRecipeNode::Null),
            entry(1, ReferenceRecipeNode::Externref { handle: 8 }),
            entry(
                2,
                ReferenceRecipeNode::Exnref {
                    module_activation: 0,
                    tag_ordinal: 0,
                    layout_id: 0,
                    scalars: alloc::vec![0u8; 0],
                    payloads: vec![1],
                },
            ),
        ]))
    }

    #[test]
    fn widened_gate_admits_exnref_but_d6_2_predicate_does_not() {
        let driver = exnref_over_externref();
        // The D6.3a predicate admits exnref; the D6.2 predicate rejects it.
        assert!(driver.all_nodes_exnref_externref_funcref_or_null());
        assert!(!driver.all_nodes_externref_funcref_or_null());
        // The widened gate still admits every previously-admitted graph.
        assert!(plain_externref().all_nodes_exnref_externref_funcref_or_null());
        assert!(funcref_only().all_nodes_exnref_externref_funcref_or_null());
        // A struct is still not an admitted kind (deferred to D6.4).
        assert!(!struct_over_externref().all_nodes_exnref_externref_funcref_or_null());
    }

    #[test]
    fn exnref_reachable_externref_is_published_before_the_materialize() {
        // The exnref payload externref (recipe 1) is reachable, so it is published
        // into the transit (Phase 0) BEFORE the exnref's EXN materialize step that
        // reads it. The materialize runs against the guest's own module-local tag
        // (the EXN step drives `__wpk_fork_exception_materialize`); no host tag is
        // minted anywhere in the plan.
        let driver = exnref_over_externref();
        assert_eq!(driver.transit_rooted_recipes(), vec![1]);
        let hints = TestHints { exn_owner: Some(3) };
        let plan = build_drive_plan(&driver.transaction().nodes, &hints).unwrap();
        assert_eq!(
            plan.iter().map(op_recipe).collect::<Vec<_>>(),
            vec![
                (DRIVE_OP_EXTERNREF_TRANSIT, 1),
                (DRIVE_OP_EXN, 2),
            ]
        );
        // The EXN step lands in the exnref's owner activation's drive slice.
        let exn = plan.iter().find(|s| s.op == DRIVE_OP_EXN).unwrap();
        assert_eq!(exn.slot, drive_table_base(3) + DRIVE_OP_EXN);
        // Proof-of-use: the reachable externref payload counts once, and the
        // exnref node is admitted.
        assert_eq!(driver.drive_reconstruction().unwrap().reconstructed(), 1);
        assert_eq!(driver.exnref_node_count(), 1);
    }

    // --- D6.4a: typed-GC (struct/array/i31) admission + leaf rooting ---------

    /// A struct↔array CYCLE whose subgraph reaches an ALIASED externref leaf:
    ///   id 0 = struct  -> array(1) + externref(2)
    ///   id 1 = array   -> struct(0) (back-edge, the cycle) + externref(2) (alias)
    ///   id 2 = externref (reached from BOTH the struct field and the array element)
    /// The module admits this graph (typed GC) and roots the reachable externref
    /// leaf through PHASE B, but the guest still DRIVES the allocate/fill under the
    /// JS order, so the Struct/Array arms of `drive_reconstruction` stay inert. The
    /// externref must be rooted EXACTLY ONCE despite the alias (dedup).
    fn struct_array_cycle_over_externref() -> ReferenceReplayDriver {
        ReferenceReplayDriver::new(transaction(vec![
            entry(
                0,
                ReferenceRecipeNode::Struct {
                    module_activation: 0,
                    type_ordinal: 1,
                    layout_id: 1,
                    scalars: alloc::vec![0u8; 4],
                    fields: vec![1, 2],
                },
            ),
            entry(
                1,
                ReferenceRecipeNode::Array {
                    module_activation: 0,
                    type_ordinal: 2,
                    layout_id: 2,
                    scalars: alloc::vec![0u8; 2],
                    elements: vec![0, 2],
                },
            ),
            entry(2, ReferenceRecipeNode::Externref { handle: 12 }),
        ]))
    }

    #[test]
    fn module_gate_admits_struct_array_i31_but_d6_3a_predicate_does_not() {
        let driver = struct_array_cycle_over_externref();
        // The module-admissibility predicate admits the typed-GC cycle; the D6.3a
        // predicate does not (struct/array are not exnref/externref/funcref/null).
        assert!(driver.all_nodes_module_admissible());
        assert!(!driver.all_nodes_exnref_externref_funcref_or_null());

        // i31 is a scalar leaf admitted by the module gate.
        let i31_graph = ReferenceReplayDriver::new(transaction(vec![
            entry(0, ReferenceRecipeNode::I31 { value: -17 }),
            entry(1, ReferenceRecipeNode::I31 { value: 42 }),
        ]));
        assert!(i31_graph.all_nodes_module_admissible());
        assert!(!i31_graph.all_nodes_exnref_externref_funcref_or_null());

        // The gate still admits every previously-admitted graph.
        assert!(exnref_over_externref().all_nodes_module_admissible());
        assert!(plain_externref().all_nodes_module_admissible());
        assert!(funcref_only().all_nodes_module_admissible());

        // static-root is NOW ADMITTED (the static-root binder publishes it into the
        // anyref transit via a DRIVE_OP_STATIC_ROOT step — no host seam).
        let static_root = ReferenceReplayDriver::new(transaction(vec![entry(
            0,
            ReferenceRecipeNode::StaticRoot {
                module_activation: 0,
                static_root_ordinal: 0,
            },
        )]));
        assert!(static_root.all_nodes_module_admissible());
        assert!(!static_root.all_nodes_exnref_externref_funcref_or_null());
    }

    #[test]
    fn static_root_node_resolves_target_and_activations() {
        // A mixed graph: null, a static root in activation 3, a static root in
        // activation 1, and a funcref (a non-static kind) — the accessor resolves
        // only the static roots and lists their distinct activations sorted.
        let driver = ReferenceReplayDriver::new(transaction(vec![
            entry(0, ReferenceRecipeNode::Null),
            entry(
                1,
                ReferenceRecipeNode::StaticRoot {
                    module_activation: 3,
                    static_root_ordinal: 5,
                },
            ),
            entry(
                2,
                ReferenceRecipeNode::StaticRoot {
                    module_activation: 1,
                    static_root_ordinal: 2,
                },
            ),
            entry(
                3,
                ReferenceRecipeNode::Funcref {
                    module_activation: 0,
                    function_ordinal: 0,
                },
            ),
        ]));
        assert_eq!(
            driver.static_root_node(1),
            Ok(StaticRootTarget {
                module_activation: 3,
                static_root_ordinal: 5,
            })
        );
        assert_eq!(
            driver.static_root_node(2),
            Ok(StaticRootTarget {
                module_activation: 1,
                static_root_ordinal: 2,
            })
        );
        // A non-static kind, an out-of-range id, and the null node are truthful
        // EINVALs — the accessor never fabricates a slot.
        assert_eq!(driver.static_root_node(0), Err(Errno::EINVAL));
        assert_eq!(driver.static_root_node(3), Err(Errno::EINVAL));
        assert_eq!(driver.static_root_node(99), Err(Errno::EINVAL));
        // Distinct activations, sorted ascending (the base-seed set).
        assert_eq!(driver.static_root_activations(), vec![1, 3]);
        // A graph with no static root reports an empty activation set.
        assert!(funcref_only().static_root_activations().is_empty());
    }

    #[test]
    fn gc_node_count_counts_struct_array_and_i31_nodes() {
        // struct + array (the externref leaf is not a GC node).
        assert_eq!(struct_array_cycle_over_externref().gc_node_count(), 2);
        // A pure i31 pair.
        let i31_graph = ReferenceReplayDriver::new(transaction(vec![
            entry(0, ReferenceRecipeNode::I31 { value: 1 }),
            entry(1, ReferenceRecipeNode::I31 { value: 2 }),
            entry(2, ReferenceRecipeNode::Null),
        ]));
        assert_eq!(i31_graph.gc_node_count(), 2);
        // Graphs with no GC nodes count zero.
        assert_eq!(plain_externref().gc_node_count(), 0);
        assert_eq!(exnref_over_externref().gc_node_count(), 0);
    }

    #[test]
    fn typed_gc_cycle_publishes_the_aliased_externref_leaf_once_before_any_alloc() {
        // The aliased externref leaf (recipe 2, reached from BOTH the struct field
        // and the array element) is published into the transit EXACTLY ONCE
        // (deduped), in Phase 0 before any ALLOC/FILL. Allocate-all-first breaks
        // the struct<->array cycle: TRANSIT 2, ALLOC 0, ALLOC 1, FILL 0, FILL 1.
        let driver = struct_array_cycle_over_externref();
        assert_eq!(driver.transit_rooted_recipes(), vec![2]);
        let plan = build_drive_plan(&driver.transaction().nodes, &TestHints::default()).unwrap();
        assert_eq!(
            plan.iter().map(op_recipe).collect::<Vec<_>>(),
            vec![
                (DRIVE_OP_EXTERNREF_TRANSIT, 2),
                (DRIVE_OP_ALLOC, 0),
                (DRIVE_OP_ALLOC, 1),
                (DRIVE_OP_FILL, 0),
                (DRIVE_OP_FILL, 1),
            ]
        );
        // Exactly one transit step for the aliased leaf, and it precedes every
        // ALLOC (the R1 rooting order).
        assert_eq!(
            plan.iter()
                .filter(|s| s.op == DRIVE_OP_EXTERNREF_TRANSIT)
                .count(),
            1
        );
        let first_alloc = plan.iter().position(|s| s.op == DRIVE_OP_ALLOC).unwrap();
        assert!(plan[0].op == DRIVE_OP_EXTERNREF_TRANSIT && first_alloc > 0);
        // Proof-of-use: one externref, two typed-GC nodes admitted.
        assert_eq!(driver.drive_reconstruction().unwrap().reconstructed(), 1);
        assert_eq!(driver.gc_node_count(), 2);
    }
}
