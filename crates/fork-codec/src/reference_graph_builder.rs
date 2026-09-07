//! Capture-side reference-recipe GRAPH BUILDER (the encode-side sibling of the
//! `reference_transaction` decoder).
//!
//! This is the net-new Rust port of the capture half of the TypeScript
//! `ForkReferenceTransaction` in `host/src/fork-reference-transaction.ts`: as the
//! instrumented `wpk_fork_module_state_save` walk discovers Wasm reference values
//! (funcrefs, externrefs, i31refs, static roots, GC structs/arrays, exception
//! references) it interns each into a dense, canonically-ordered recipe graph and
//! interns the per-activation reference vectors. Where the TS builder interns by
//! live JavaScript object/primitive identity (`intern`/`lookupId`), the module
//! path has no live values — only the already-resolved recipe COORDINATES — so
//! this builder interns by coordinate (funcref `(activation, ordinal)`, externref
//! `handle`, i31 `value`, static-root `(activation, ordinal)`), which is a
//! faithful mirror: two equal live values always resolve to equal coordinates.
//!
//! The built graph reuses the shared decoder vocabulary
//! (`reference_recipes::ReferenceRecipeNode`, `reference_transaction::
//! VectorInternIndex` / `vector_intern_key`) so the emitted graph is exactly what
//! `decode_segmented_reference_transaction` reconstructs. Serialization to
//! KFRV/KFRS lives in `reference_segments_writer`; the two together are the
//! round-trip inverse of the decoder, proven in-crate against it.
//!
//! Every method is bounds-checked and panic-free: invalid input (an out-of-domain
//! i31, a zero externref handle, an edge naming a missing recipe, a duplicate GC
//! definition, an exhausted id space) returns `Err(Errno::EINVAL)` rather than
//! panicking, matching the `linked_frames_writer` contract.

use wasm_posix_shared::Errno;

use alloc::collections::{BTreeMap, BTreeSet};
use alloc::vec::Vec;

use crate::reference_recipes::ReferenceRecipeNode;
use crate::reference_transaction::{vector_intern_key, VectorInternIndex};

/// Inclusive i31 payload domain (`-2^30 ..= 2^30-1`); mirrors the decoder.
const MIN_I31: i32 = -0x4000_0000;
const MAX_I31: i32 = 0x3fff_ffff;
/// Inclusive layout-id domain (u31); mirrors the TS `assertU31` on `layoutId`.
const MAX_U31: u32 = 0x7fff_ffff;
/// The recipe-id namespace is the complete u32; ids `0..=0xffff_ffff`.
const MAX_RECIPE_ID: u64 = 0xffff_ffff;

/// Which aggregate wire kind `define_gc` completes a claimed placeholder into.
/// Mirrors the `WireNodeKind` aggregate discriminants the decoder reads.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AggregateKind {
    /// A Wasm exception reference (`exnref`, wire kind 3).
    Exnref,
    /// A Wasm GC struct (wire kind 5).
    Struct,
    /// A Wasm GC array (wire kind 6).
    Array,
}

/// Capture-side constructor provenance for a GC definition.
///
/// The TS `defineGc` validates provenance against the layout descriptor, but
/// provenance is a capture-side CONSISTENCY concept — it is NOT carried in the
/// 48-byte KFRV node record (`encodeNodeRecordV2` writes only the coordinate
/// words plus the edge/scalar ranges). This builder therefore records it for
/// API parity and internal validation (its reference ids must name existing
/// recipes) but never serializes it; the round-trip is unaffected.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GcProvenance {
    /// Recipe ids the constructor provenance references.
    pub reference_ids: Vec<u32>,
}

/// The capture-side reference-recipe graph under construction.
///
/// Holds the dense node table (`nodes[id]` is recipe `id`, `nodes[0]` is the
/// canonical null) and the interned reference vectors (`vectors[0]` is the empty
/// sentinel). Drive it exactly like the TS capture: `begin`, then intern each
/// discovered reference value, `claim_gc` + `define_gc` each GC identity, and
/// `begin_vector`/`append_vector`/`finish_vector` each activation vector.
#[derive(Debug)]
pub struct ReferenceGraphBuilder {
    nodes: Vec<ReferenceRecipeNode>,
    vectors: Vec<Vec<u32>>,
    vector_intern: VectorInternIndex,
    funcref_ids: BTreeMap<(u32, u32), u32>,
    externref_ids: BTreeMap<u32, u32>,
    i31_ids: BTreeMap<i32, u32>,
    static_root_ids: BTreeMap<(u32, u32), u32>,
    pending_gc: BTreeSet<u32>,
    vector_builders: BTreeMap<u32, Vec<u32>>,
    next_vector_handle: u32,
}

impl ReferenceGraphBuilder {
    /// Seed a fresh graph: recipe 0 is the canonical null reference and vector 0
    /// is the canonical empty-vector sentinel. Mirrors `beginCapture`.
    pub fn begin() -> Self {
        // Recipe 0 is the canonical null; vector 0 is the empty sentinel.
        let nodes = alloc::vec![ReferenceRecipeNode::Null];
        let vectors = alloc::vec![Vec::new()];
        ReferenceGraphBuilder {
            nodes,
            vectors,
            vector_intern: VectorInternIndex::default(),
            funcref_ids: BTreeMap::new(),
            externref_ids: BTreeMap::new(),
            i31_ids: BTreeMap::new(),
            static_root_ids: BTreeMap::new(),
            pending_gc: BTreeSet::new(),
            vector_builders: BTreeMap::new(),
            next_vector_handle: 0,
        }
    }

    /// The dense node table; `nodes()[id]` is recipe `id`.
    pub fn nodes(&self) -> &[ReferenceRecipeNode] {
        &self.nodes
    }

    /// The interned reference vectors; index 0 is the empty sentinel.
    pub fn vectors(&self) -> &[Vec<u32>] {
        &self.vectors
    }

    /// The canonical vector intern index (hash key -> ascending ordinals).
    pub fn vector_intern(&self) -> &VectorInternIndex {
        &self.vector_intern
    }

    /// Append a fresh node, returning its recipe id. Rejects an exhausted id
    /// namespace (`> 0xffff_ffff`), mirroring the TS `id > 0xffff_ffff` guard.
    fn push_node(&mut self, node: ReferenceRecipeNode) -> Result<u32, Errno> {
        let id = self.nodes.len() as u64;
        if id > MAX_RECIPE_ID {
            return Err(Errno::EINVAL); // recipe id space exhausted
        }
        self.nodes.push(node);
        Ok(id as u32)
    }

    /// Intern a function reference by its catalog coordinate. Mirrors
    /// `encodeFuncref` (deduped by resolved recipe rather than JS identity).
    pub fn intern_funcref(&mut self, activation: u32, ordinal: u32) -> Result<u32, Errno> {
        if let Some(&id) = self.funcref_ids.get(&(activation, ordinal)) {
            return Ok(id);
        }
        let id = self.push_node(ReferenceRecipeNode::Funcref {
            module_activation: activation,
            function_ordinal: ordinal,
        })?;
        self.funcref_ids.insert((activation, ordinal), id);
        Ok(id)
    }

    /// Intern a durable host externref by broker handle (`1..=0xffff_ffff`).
    /// Mirrors `encodeExternref`; rejects the zero (unowned) handle.
    pub fn intern_externref(&mut self, handle: u32) -> Result<u32, Errno> {
        if handle == 0 {
            return Err(Errno::EINVAL); // zero handle is not a durable externref
        }
        if let Some(&id) = self.externref_ids.get(&handle) {
            return Ok(id);
        }
        let id = self.push_node(ReferenceRecipeNode::Externref { handle })?;
        self.externref_ids.insert(handle, id);
        Ok(id)
    }

    /// Intern an `i31ref` by its signed 31-bit payload. Mirrors `encodeI31`;
    /// rejects an out-of-domain value.
    pub fn intern_i31(&mut self, value: i32) -> Result<u32, Errno> {
        if !(MIN_I31..=MAX_I31).contains(&value) {
            return Err(Errno::EINVAL); // i31 payload out of domain
        }
        if let Some(&id) = self.i31_ids.get(&value) {
            return Ok(id);
        }
        let id = self.push_node(ReferenceRecipeNode::I31 { value })?;
        self.i31_ids.insert(value, id);
        Ok(id)
    }

    /// Intern a statically-rooted reference by its catalog coordinate. Mirrors
    /// the static-root branch of `lookupGcSlot`/`intern`.
    pub fn intern_static_root(&mut self, activation: u32, ordinal: u32) -> Result<u32, Errno> {
        if let Some(&id) = self.static_root_ids.get(&(activation, ordinal)) {
            return Ok(id);
        }
        let id = self.push_node(ReferenceRecipeNode::StaticRoot {
            module_activation: activation,
            static_root_ordinal: ordinal,
        })?;
        self.static_root_ids.insert((activation, ordinal), id);
        Ok(id)
    }

    /// Reserve a self-contained placeholder leaf for a GATED capture kind
    /// (externref / typed Wasm-GC / static-root with no recoverable
    /// production-site provenance), returning its recipe id. Mirrors the TS
    /// `reserveGatedPlaceholder` and native's `NativeReferenceCapture::
    /// gated_placeholder`: it pushes a fresh, canonical `i31(0)` leaf — the
    /// cheapest node that passes `validate` without real backing — WITHOUT the
    /// `intern_i31` value dedup, so each gated live value gets its own distinct
    /// recipe id (the host keeps the live value beside it for the parent's own
    /// abort-replay). The sealed graph of a gated fork is discarded unread; this
    /// only has to keep the graph canonical and the id space one-to-one with the
    /// host's captured-value side table.
    pub fn push_gated_placeholder(&mut self) -> Result<u32, Errno> {
        self.push_node(ReferenceRecipeNode::I31 { value: 0 })
    }

    /// Claim a fresh graph identity for a GC value before its fields are known,
    /// returning the placeholder recipe id. Mirrors `claimGcSlot`: publishing the
    /// id first lets a field edge close a cycle back onto this node. The
    /// placeholder is not serializable until `define_gc` completes it.
    pub fn claim_gc(&mut self) -> Result<u32, Errno> {
        let id = self.push_node(ReferenceRecipeNode::Struct {
            module_activation: 0,
            type_ordinal: 0,
            layout_id: 0,
            scalars: Vec::new(),
            fields: Vec::new(),
        })?;
        self.pending_gc.insert(id);
        Ok(id)
    }

    /// Complete a claimed GC placeholder into its final aggregate node. Mirrors
    /// `defineGc`: the recipe must be pending, the layout id a u31, and every
    /// edge (and any provenance reference) must name an existing recipe. Edges
    /// may name the claimed node itself or later nodes (cycles are allowed).
    #[allow(clippy::too_many_arguments)]
    pub fn define_gc(
        &mut self,
        recipe_id: u32,
        activation: u32,
        type_ordinal: u32,
        layout_id: u32,
        kind: AggregateKind,
        scalar_bytes: &[u8],
        edges: &[u32],
        provenance: Option<GcProvenance>,
    ) -> Result<(), Errno> {
        if !self.pending_gc.remove(&recipe_id) {
            return Err(Errno::EINVAL); // not a pending GC placeholder
        }
        if layout_id > MAX_U31 {
            return Err(Errno::EINVAL); // layout id exceeds u31
        }
        // Edges and provenance references must name existing recipes. Cycles are
        // permitted, so the bound is the CURRENT node count (which includes this
        // node); a forward edge to a not-yet-claimed node is rejected here, as in
        // the TS capture's final `validateCanonicalCapture` pass.
        let node_count = self.nodes.len() as u64;
        for &edge in edges {
            if edge as u64 >= node_count {
                return Err(Errno::EINVAL); // edge names a missing recipe
            }
        }
        if let Some(prov) = &provenance {
            for &reference in &prov.reference_ids {
                if reference as u64 >= node_count {
                    return Err(Errno::EINVAL); // provenance names a missing recipe
                }
            }
        }
        let scalars = scalar_bytes.to_vec();
        let edges = edges.to_vec();
        let index = recipe_id as usize;
        let slot = self.nodes.get_mut(index).ok_or(Errno::EINVAL)?;
        *slot = match kind {
            AggregateKind::Exnref => ReferenceRecipeNode::Exnref {
                module_activation: activation,
                tag_ordinal: type_ordinal,
                layout_id,
                scalars,
                payloads: edges,
            },
            AggregateKind::Struct => ReferenceRecipeNode::Struct {
                module_activation: activation,
                type_ordinal,
                layout_id,
                scalars,
                fields: edges,
            },
            AggregateKind::Array => ReferenceRecipeNode::Array {
                module_activation: activation,
                type_ordinal,
                layout_id,
                scalars,
                elements: edges,
            },
        };
        Ok(())
    }

    /// Open a reference-vector builder, returning its handle. Mirrors
    /// `beginReferenceVector` (without the pre-declared expected length).
    pub fn begin_vector(&mut self) -> Result<u32, Errno> {
        let handle = self.next_vector_handle;
        self.next_vector_handle = handle.checked_add(1).ok_or(Errno::EINVAL)?;
        self.vector_builders.insert(handle, Vec::new());
        Ok(handle)
    }

    /// Append a recipe id to an open vector builder. Mirrors
    /// `appendReferenceVector`; the recipe must already exist.
    pub fn append_vector(&mut self, handle: u32, recipe_id: u32) -> Result<(), Errno> {
        if recipe_id as u64 >= self.nodes.len() as u64 {
            return Err(Errno::EINVAL); // vector names a missing recipe
        }
        let builder = self.vector_builders.get_mut(&handle).ok_or(Errno::EINVAL)?;
        builder.push(recipe_id);
        Ok(())
    }

    /// Finish an open vector builder, interning it and returning its stable
    /// ordinal. Mirrors `finishReferenceVector`: an identical vector already
    /// interned reuses its ordinal (deduped via the SAME two-word hash the
    /// decoder validates); a new vector appends at the next ordinal. Rejects the
    /// empty vector — ordinal 0 is the only empty vector.
    pub fn finish_vector(&mut self, handle: u32) -> Result<u32, Errno> {
        let values = self.vector_builders.remove(&handle).ok_or(Errno::EINVAL)?;
        if values.is_empty() {
            return Err(Errno::EINVAL); // ordinal zero is the canonical empty vector
        }
        let key = vector_intern_key(&values);
        for &previous in self.vector_intern.ordinals(&key) {
            if self.vectors[previous as usize] == values {
                return Ok(previous); // reuse the canonical ordinal
            }
        }
        let ordinal = self.vectors.len() as u64;
        if ordinal > MAX_RECIPE_ID {
            return Err(Errno::EINVAL); // vector ordinal space exhausted
        }
        let ordinal = ordinal as u32;
        self.vectors.push(values);
        self.vector_intern.push_ordinal(key, ordinal);
        Ok(ordinal)
    }

    /// Validate the built graph as a canonical, sealable capture. Mirrors
    /// `validateCanonicalCapture`: node 0 is the only null, no GC placeholder is
    /// still pending, no vector builder is still open, and every edge and vector
    /// entry names an existing recipe. Called by the serializer before emitting.
    pub fn validate(&self) -> Result<(), Errno> {
        if !self.pending_gc.is_empty() {
            return Err(Errno::EINVAL); // a claimed GC identity was never defined
        }
        if !self.vector_builders.is_empty() {
            return Err(Errno::EINVAL); // a reference vector was never finished
        }
        let node_count = self.nodes.len() as u64;
        if node_count == 0 || node_count > MAX_RECIPE_ID + 1 {
            return Err(Errno::EINVAL);
        }
        for (id, node) in self.nodes.iter().enumerate() {
            let is_null = matches!(node, ReferenceRecipeNode::Null);
            if (id == 0) != is_null {
                return Err(Errno::EINVAL); // null only at id 0, and required there
            }
            for &edge in node_edges(node) {
                if edge as u64 >= node_count {
                    return Err(Errno::EINVAL); // edge names a missing recipe
                }
            }
        }
        for vector in self.vectors.iter().skip(1) {
            if vector.is_empty() {
                return Err(Errno::EINVAL); // duplicates the empty sentinel
            }
            for &entry in vector {
                if entry as u64 >= node_count {
                    return Err(Errno::EINVAL); // vector names a missing recipe
                }
            }
        }
        Ok(())
    }
}

/// The ordered reference edges a node contributes to the flat edge section.
/// Mirrors the TS `nodeEdges`.
pub(crate) fn node_edges(node: &ReferenceRecipeNode) -> &[u32] {
    match node {
        ReferenceRecipeNode::Exnref { payloads, .. } => payloads,
        ReferenceRecipeNode::Struct { fields, .. } => fields,
        ReferenceRecipeNode::Array { elements, .. } => elements,
        _ => &[],
    }
}

/// The exact scalar payload bytes a node contributes to the flat scalar section.
/// Mirrors the TS `nodeScalars`.
pub(crate) fn node_scalars(node: &ReferenceRecipeNode) -> &[u8] {
    match node {
        ReferenceRecipeNode::Exnref { scalars, .. } => scalars,
        ReferenceRecipeNode::Struct { scalars, .. } => scalars,
        ReferenceRecipeNode::Array { scalars, .. } => scalars,
        _ => &[],
    }
}
