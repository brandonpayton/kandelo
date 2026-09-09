//! Reference RESTORE data-feed (Phase 6 item 3a — minimize host surface).
//!
//! This module ports the seven RESTORE-path reference imports the host JS
//! reference provider used to serve — the ones a fresh fork child's guest codec
//! calls (through the still-JS drive-order `materializeTypedGraph`, via the
//! guest `_gc_allocate`/`_gc_fill` exports) to READ the already-decoded
//! reference graph and WRITE reconstructed scalar/edge bytes into guest linear
//! memory. Where `reference_replay::ReferenceReplayDriver` owns the once-per-
//! value HOST identity drive, this owns the per-recipe DATA feed:
//!
//!   * `vector_get`       (`getReferenceVector`) — read one reference vector's
//!     interned recipe id.
//!   * `gc_route`         (`routeGc`)            — route a GC recipe to a layout.
//!   * `gc_payload_len`   (`gcPayloadLength`)    — the recipe's scalar byte len.
//!   * `gc_load`          (`loadGc`)             — write the GC scalar bytes and
//!     return the interned reference-vector ordinal for the aggregate's edges.
//!   * `exn_route`        (`routeException`)     — route an exnref recipe.
//!   * `exn_load`         (`loadException`)      — write the exnref scalar bytes
//!     and reference-id edges.
//!   * `exn_cache_index`  (`exceptionCacheIndex`)— the exnref's cache index.
//!
//! Each body is a field-for-field port of the corresponding method in
//! `host/src/fork-early-reference-provider.ts`. They are PURE integer/byte reads
//! of the immutable decoded [`SegmentedReferenceTransaction`] plus writes into a
//! caller-supplied guest-memory slice — no host identity, no engine-floor call,
//! no reference value ever crosses the boundary. The one piece of mutable REPLAY
//! state they share (the growing reference-vector directory + its intern index +
//! the per-recipe GC-vector ordinal cache + the exnref cache-index map) lives in
//! [`ReferenceReplayFeed`], reproducing the provider's `referenceVectors` /
//! `referenceVectorIntern` / `replayGcVectors` / `exceptionCacheIndexes` fields.
//!
//! `no_std + alloc`, bounds-checked, panic-free: every consistency violation the
//! JS body threw on yields `Err(Errno)` (the co-resident module turns that into
//! a truthful trap, exactly as `fm_funcref_ordinal` does), and the legitimate
//! routing sentinels the JS body returned (`0` for i31, `-1` for a mismatch) are
//! `Ok(_)` results, never errors.

use wasm_posix_shared::Errno;

use alloc::collections::BTreeMap;
use alloc::vec::Vec;

use crate::reference_recipes::ReferenceRecipeNode;
use crate::reference_transaction::{
    vector_intern_key, SegmentedReferenceTransaction, VectorInternIndex,
};

/// `MAX_REFERENCE_VECTOR_ORDINAL` in `fork-early-reference-provider.ts` (the u32
/// ceiling on the reference-vector directory length).
const MAX_REFERENCE_VECTOR_ORDINAL: u64 = 0xffff_ffff;

/// The GC aggregate kind the guest passes to `gc_load`: `1` for a struct, `2`
/// for an array (mirrors the TS `nodeKind` in `loadGc`).
const GC_KIND_STRUCT: u32 = 1;
const GC_KIND_ARRAY: u32 = 2;

/// The mutable per-fork REPLAY state the data-feed accumulates on top of the
/// immutable decoded transaction. Mirrors the four mutable fields the JS
/// `ForkEarlyChildReferenceProvider` grows while a child's typed-GC codec runs:
///
///   * `extension_vectors`  <- `referenceVectors` overlay EXTENSION (the base is
///     the decoded `transaction.vectors`; new GC aggregate edge-vectors append
///     here, at ordinals `>= transaction.vectors.len()`).
///   * `extension_intern`   <- `referenceVectorIntern` (interns ONLY the
///     appended extension ordinals; `gc_load` searches it alongside the decoded
///     `transaction.vector_intern`).
///   * `gc_vector_cache`    <- `replayGcVectors` (recipe id -> the ordinal a
///     prior `gc_load` assigned that recipe's edge-vector).
///   * `exception_cache_indexes` <- `exceptionCacheIndexes` (exnref recipe id ->
///     its 1-based cache index, assigned in graph-id order at construction).
#[derive(Debug, Clone, Default)]
pub struct ReferenceReplayFeed {
    /// The number of decoded (base) vectors; extension ordinals start here.
    base_vector_count: u32,
    /// Reference vectors appended during the GC replay (the overlay extension).
    extension_vectors: Vec<Vec<u32>>,
    /// Intern index over the appended extension ordinals only.
    extension_intern: VectorInternIndex,
    /// recipe id -> the ordinal a prior `gc_load` assigned its edge vector.
    gc_vector_cache: BTreeMap<u32, u32>,
    /// exnref recipe id -> 1-based exception cache index (graph-id order).
    exception_cache_indexes: BTreeMap<u32, u32>,
}

impl ReferenceReplayFeed {
    /// Seed the feed from a decoded transaction. Mirrors the provider
    /// constructor's `referenceVectors.reset(transaction.vectors)` (recording
    /// the base length so extension ordinals continue past it) and the id-order
    /// `exceptionCacheIndexes` assignment (each exnref gets `size + 1`).
    pub fn new(transaction: &SegmentedReferenceTransaction) -> Self {
        let base_vector_count = transaction.vectors.len() as u32;
        let mut exception_cache_indexes = BTreeMap::new();
        let mut next_index: u32 = 1;
        for entry in &transaction.nodes {
            if matches!(entry.node, ReferenceRecipeNode::Exnref { .. }) {
                exception_cache_indexes.insert(entry.id, next_index);
                next_index += 1;
            }
        }
        Self {
            base_vector_count,
            extension_vectors: Vec::new(),
            extension_intern: VectorInternIndex::default(),
            gc_vector_cache: BTreeMap::new(),
            exception_cache_indexes,
        }
    }

    /// The combined reference-vector directory length (base + extension), i.e.
    /// the JS `referenceVectors.length`.
    fn combined_len(&self) -> u64 {
        self.base_vector_count as u64 + self.extension_vectors.len() as u64
    }

    /// Resolve one reference vector by ordinal in the combined overlay: the
    /// decoded base vectors first, then the replay-appended extension. Mirrors
    /// `ForkReferenceDirectoryOverlay.get`.
    fn vector_at<'a>(
        &'a self,
        transaction: &'a SegmentedReferenceTransaction,
        ordinal: u32,
    ) -> Option<&'a [u32]> {
        if (ordinal as usize) < transaction.vectors.len() {
            return transaction.vectors.get(ordinal as usize).map(Vec::as_slice);
        }
        let extension_index = (ordinal as usize) - transaction.vectors.len();
        self.extension_vectors
            .get(extension_index)
            .map(Vec::as_slice)
    }

    /// Find the canonical ordinal of `candidate` by searching the decoded
    /// transaction intern index and the replay extension intern index, comparing
    /// each keyed candidate entry-for-entry. Mirrors
    /// `findForkReferenceVectorOrdinal([transaction.vectorIntern,
    /// referenceVectorIntern], referenceVectors, ...)`.
    fn find_vector_ordinal(
        &self,
        transaction: &SegmentedReferenceTransaction,
        candidate: &[u32],
    ) -> Option<u32> {
        let key = vector_intern_key(candidate);
        for ordinals in [
            transaction.vector_intern.ordinals(&key),
            self.extension_intern.ordinals(&key),
        ] {
            for &ordinal in ordinals {
                if let Some(existing) = self.vector_at(transaction, ordinal)
                    && existing == candidate
                {
                    return Some(ordinal);
                }
            }
        }
        None
    }

    // -- getReferenceVector --------------------------------------------------

    /// `__wpk_fork_ref_vector_get(ordinal, index) -> recipe_id`. Read the recipe
    /// id at `index` in reference vector `ordinal`. Mirrors `getReferenceVector`:
    /// an unavailable ordinal or an out-of-bounds index is a truthful `EINVAL`
    /// (the JS `throw`).
    pub fn vector_get(
        &self,
        transaction: &SegmentedReferenceTransaction,
        ordinal: u32,
        index: u32,
    ) -> Result<i32, Errno> {
        let vector = self.vector_at(transaction, ordinal).ok_or(Errno::EINVAL)?;
        let recipe_id = vector.get(index as usize).copied().ok_or(Errno::EINVAL)?;
        Ok(recipe_id as i32)
    }

    // -- routeGc -------------------------------------------------------------

    /// `__wpk_fork_ref_gc_route(recipe_id, expected_activation) -> layout | 0 |
    /// -1`. Mirrors `routeGc`: i31 routes to `0`; a struct/array whose activation
    /// matches routes to its layout id; anything else routes to the `-1`
    /// mismatch sentinel.
    pub fn gc_route(
        &self,
        transaction: &SegmentedReferenceTransaction,
        recipe_id: u32,
        expected_activation: u32,
    ) -> Result<i32, Errno> {
        let node = require_recipe(transaction, recipe_id)?;
        match node {
            ReferenceRecipeNode::I31 { .. } => Ok(0),
            ReferenceRecipeNode::Struct {
                module_activation,
                layout_id,
                ..
            }
            | ReferenceRecipeNode::Array {
                module_activation,
                layout_id,
                ..
            } => {
                if *module_activation != expected_activation {
                    Ok(-1)
                } else {
                    Ok(*layout_id as i32)
                }
            }
            _ => Ok(-1),
        }
    }

    // -- gcPayloadLength -----------------------------------------------------

    /// `__wpk_fork_ref_gc_payload_len(recipe_id, expected_activation,
    /// expected_layout_id) -> scalar_byte_len`. Mirrors `gcPayloadLength`: an
    /// i31 with the reserved layout `0` is 4 bytes; a struct/array whose
    /// activation and layout match is its scalar byte length; any other shape or
    /// mismatch is a truthful `EINVAL`.
    pub fn gc_payload_len(
        &self,
        transaction: &SegmentedReferenceTransaction,
        recipe_id: u32,
        expected_activation: u32,
        expected_layout_id: u32,
    ) -> Result<i32, Errno> {
        let node = require_recipe(transaction, recipe_id)?;
        match node {
            ReferenceRecipeNode::I31 { .. } => {
                if expected_layout_id != 0 {
                    return Err(Errno::EINVAL);
                }
                Ok(4)
            }
            ReferenceRecipeNode::Struct {
                module_activation,
                layout_id,
                scalars,
                ..
            }
            | ReferenceRecipeNode::Array {
                module_activation,
                layout_id,
                scalars,
                ..
            } => {
                if *module_activation != expected_activation || *layout_id != expected_layout_id {
                    return Err(Errno::EINVAL);
                }
                Ok(scalars.len() as i32)
            }
            _ => Err(Errno::EINVAL),
        }
    }

    // -- loadGc --------------------------------------------------------------

    /// `__wpk_fork_ref_gc_load(recipe_id, module_activation, type_ordinal,
    /// layout_id, kind, scalar_destination, scalar_byte_length) -> vector_ordinal
    /// | 0`. Mirrors `loadGc` field-for-field:
    ///
    /// * i31: validate the reserved load coordinate (layout 0, type ordinal
    ///   `0xffff_ffff`, kind 0, 4 scalar bytes), then write the i32 value LE into
    ///   guest memory and return 0.
    /// * struct/array: validate the whole load coordinate against the decoded
    ///   node, write its exact scalar bytes into guest memory, then intern its
    ///   ordered edge vector — returning the recipe's cached ordinal, a canonical
    ///   duplicate's ordinal, or a freshly appended ordinal (0 when the aggregate
    ///   has no edges).
    ///
    /// `mem` is the guest linear memory; `scalar_destination` is an absolute
    /// guest byte offset. Any coordinate mismatch, an out-of-range destination,
    /// or an exhausted ordinal space is a truthful `EINVAL`/`ENOSPC`.
    #[allow(clippy::too_many_arguments)]
    pub fn gc_load(
        &mut self,
        transaction: &SegmentedReferenceTransaction,
        mem: &mut [u8],
        recipe_id: u32,
        module_activation: u32,
        type_ordinal: u32,
        layout_id: u32,
        kind: u32,
        scalar_destination: usize,
        scalar_byte_length: u32,
    ) -> Result<i32, Errno> {
        let node = require_recipe(transaction, recipe_id)?;
        match node {
            ReferenceRecipeNode::I31 { value } => {
                if layout_id != 0
                    || type_ordinal != 0xffff_ffff
                    || kind != 0
                    || scalar_byte_length != 4
                {
                    return Err(Errno::EINVAL);
                }
                write_bytes(mem, scalar_destination, &value.to_le_bytes())?;
                Ok(0)
            }
            ReferenceRecipeNode::Struct {
                module_activation: node_activation,
                type_ordinal: node_type,
                layout_id: node_layout,
                scalars,
                fields,
            } => self.load_gc_aggregate(
                transaction,
                mem,
                recipe_id,
                GC_KIND_STRUCT,
                (module_activation, type_ordinal, layout_id, kind),
                (*node_activation, *node_type, *node_layout),
                scalars,
                fields,
                scalar_destination,
                scalar_byte_length,
            ),
            ReferenceRecipeNode::Array {
                module_activation: node_activation,
                type_ordinal: node_type,
                layout_id: node_layout,
                scalars,
                elements,
            } => self.load_gc_aggregate(
                transaction,
                mem,
                recipe_id,
                GC_KIND_ARRAY,
                (module_activation, type_ordinal, layout_id, kind),
                (*node_activation, *node_type, *node_layout),
                scalars,
                elements,
                scalar_destination,
                scalar_byte_length,
            ),
            _ => Err(Errno::EINVAL),
        }
    }

    /// Shared struct/array arm of `gc_load` (mirrors `loadGc`'s aggregate half).
    #[allow(clippy::too_many_arguments)]
    fn load_gc_aggregate(
        &mut self,
        transaction: &SegmentedReferenceTransaction,
        mem: &mut [u8],
        recipe_id: u32,
        node_kind: u32,
        requested: (u32, u32, u32, u32),
        node_coordinate: (u32, u32, u32),
        scalars: &[u8],
        edges: &[u32],
        scalar_destination: usize,
        scalar_byte_length: u32,
    ) -> Result<i32, Errno> {
        let (req_activation, req_type, req_layout, req_kind) = requested;
        let (node_activation, node_type, node_layout) = node_coordinate;
        if node_activation != req_activation
            || node_type != req_type
            || node_layout != req_layout
            || node_kind != req_kind
            || scalars.len() as u32 != scalar_byte_length
        {
            return Err(Errno::EINVAL);
        }
        write_bytes(mem, scalar_destination, scalars)?;
        if edges.is_empty() {
            return Ok(0);
        }
        if let Some(known) = self.gc_vector_cache.get(&recipe_id) {
            return Ok(*known as i32);
        }
        if let Some(existing) = self.find_vector_ordinal(transaction, edges) {
            self.gc_vector_cache.insert(recipe_id, existing);
            return Ok(existing as i32);
        }
        let combined = self.combined_len();
        if combined > MAX_REFERENCE_VECTOR_ORDINAL {
            return Err(Errno::ENOSPC);
        }
        let ordinal = combined as u32;
        let key = vector_intern_key(edges);
        self.extension_vectors.push(edges.to_vec());
        self.extension_intern.push_ordinal(key, ordinal);
        self.gc_vector_cache.insert(recipe_id, ordinal);
        Ok(ordinal as i32)
    }

    // -- routeException ------------------------------------------------------

    /// `__wpk_fork_ref_exn_route(recipe_id, expected_activation) -> layout | -1`.
    /// Mirrors `routeException`: an exnref whose activation matches routes to its
    /// layout id; anything else routes to the `-1` mismatch sentinel.
    pub fn exn_route(
        &self,
        transaction: &SegmentedReferenceTransaction,
        recipe_id: u32,
        expected_activation: u32,
    ) -> Result<i32, Errno> {
        let node = require_recipe(transaction, recipe_id)?;
        match node {
            ReferenceRecipeNode::Exnref {
                module_activation,
                layout_id,
                ..
            } => {
                if *module_activation != expected_activation {
                    Ok(-1)
                } else {
                    Ok(*layout_id as i32)
                }
            }
            _ => Ok(-1),
        }
    }

    // -- loadException -------------------------------------------------------

    /// `__wpk_fork_ref_exn_load(recipe_id, module_activation, tag_ordinal,
    /// layout_id, scalar_destination, scalar_byte_length, reference_ids_
    /// destination, reference_count) -> 1`. Mirrors `loadException`: validate the
    /// full coordinate against the decoded exnref, write its scalar bytes and its
    /// ordered reference-payload recipe ids (LE u32) into guest memory, and
    /// return 1. Any mismatch or an out-of-range destination is a truthful
    /// `EINVAL`.
    #[allow(clippy::too_many_arguments)]
    pub fn exn_load(
        &self,
        transaction: &SegmentedReferenceTransaction,
        mem: &mut [u8],
        recipe_id: u32,
        module_activation: u32,
        tag_ordinal: u32,
        layout_id: u32,
        scalar_destination: usize,
        scalar_byte_length: u32,
        reference_ids_destination: usize,
        reference_count: u32,
    ) -> Result<i32, Errno> {
        let node = require_recipe(transaction, recipe_id)?;
        match node {
            ReferenceRecipeNode::Exnref {
                module_activation: node_activation,
                tag_ordinal: node_tag,
                layout_id: node_layout,
                scalars,
                payloads,
            } => {
                if *node_activation != module_activation
                    || *node_tag != tag_ordinal
                    || *node_layout != layout_id
                    || scalars.len() as u32 != scalar_byte_length
                    || payloads.len() as u32 != reference_count
                {
                    return Err(Errno::EINVAL);
                }
                write_bytes(mem, scalar_destination, scalars)?;
                write_recipe_ids(mem, reference_ids_destination, payloads)?;
                Ok(1)
            }
            _ => Err(Errno::EINVAL),
        }
    }

    // -- exceptionCacheIndex -------------------------------------------------

    /// `__wpk_fork_ref_exn_cache_index(recipe_id) -> index`. Mirrors
    /// `exceptionCacheIndex`: the exnref's 1-based cache index (assigned in
    /// graph-id order at construction). A recipe with no cache index (not an
    /// exnref) or an out-of-range id is a truthful `EINVAL`.
    pub fn exn_cache_index(
        &self,
        transaction: &SegmentedReferenceTransaction,
        recipe_id: u32,
    ) -> Result<i32, Errno> {
        // `requireRecipe` — the id must name a decoded node.
        require_recipe(transaction, recipe_id)?;
        self.exception_cache_indexes
            .get(&recipe_id)
            .copied()
            .map(|index| index as i32)
            .ok_or(Errno::EINVAL)
    }
}

/// `requireRecipe(recipeId)`: resolve the decoded node whose canonical id equals
/// `recipe_id`. The decoder guarantees `id == index`; a graph reaching here with
/// a disagreeing id is corruption, so it is a loud `EINVAL`, never a silent
/// mis-resolution.
fn require_recipe(
    transaction: &SegmentedReferenceTransaction,
    recipe_id: u32,
) -> Result<&ReferenceRecipeNode, Errno> {
    let entry = transaction
        .nodes
        .get(recipe_id as usize)
        .ok_or(Errno::EINVAL)?;
    if entry.id != recipe_id {
        return Err(Errno::EINVAL);
    }
    Ok(&entry.node)
}

/// Bounds-checked write of `bytes` into guest linear memory at absolute byte
/// offset `dest`. Mirrors `writeBytes` -> `memoryRange` (offset + length must lie
/// within memory); a zero-length write at `dest == mem.len()` is allowed.
fn write_bytes(mem: &mut [u8], dest: usize, bytes: &[u8]) -> Result<(), Errno> {
    let end = dest.checked_add(bytes.len()).ok_or(Errno::EINVAL)?;
    let slice = mem.get_mut(dest..end).ok_or(Errno::EINVAL)?;
    slice.copy_from_slice(bytes);
    Ok(())
}

/// Bounds-checked write of `ids` as little-endian u32s into guest linear memory
/// at absolute byte offset `dest`. Mirrors `writeRecipeIds`.
fn write_recipe_ids(mem: &mut [u8], dest: usize, ids: &[u32]) -> Result<(), Errno> {
    let byte_len = ids.len().checked_mul(4).ok_or(Errno::EINVAL)?;
    let end = dest.checked_add(byte_len).ok_or(Errno::EINVAL)?;
    let slice = mem.get_mut(dest..end).ok_or(Errno::EINVAL)?;
    for (index, id) in ids.iter().enumerate() {
        slice[index * 4..index * 4 + 4].copy_from_slice(&id.to_le_bytes());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    use alloc::vec;

    use crate::reference_recipes::ReferenceRecipeEntry;

    fn entry(id: u32, node: ReferenceRecipeNode) -> ReferenceRecipeEntry {
        ReferenceRecipeEntry { id, node }
    }

    /// Build a transaction from nodes + interned vectors (index 0 is the empty
    /// sentinel, exactly as the decoder emits). The intern index is populated for
    /// every non-sentinel vector so `find_vector_ordinal` can dedup base vectors.
    fn transaction(
        nodes: Vec<ReferenceRecipeEntry>,
        vectors: Vec<Vec<u32>>,
    ) -> SegmentedReferenceTransaction {
        let mut vector_intern = VectorInternIndex::default();
        for (ordinal, vector) in vectors.iter().enumerate() {
            if ordinal == 0 {
                continue; // empty sentinel is not interned
            }
            vector_intern.push_ordinal(vector_intern_key(vector), ordinal as u32);
        }
        SegmentedReferenceTransaction {
            roots: Vec::new(),
            nodes,
            vectors,
            vector_intern,
        }
    }

    fn struct_node(id: u32, activation: u32, layout: u32, scalars: Vec<u8>, fields: Vec<u32>) -> ReferenceRecipeEntry {
        entry(
            id,
            ReferenceRecipeNode::Struct {
                module_activation: activation,
                type_ordinal: 100 + id,
                layout_id: layout,
                scalars,
                fields,
            },
        )
    }

    // -- getReferenceVector --------------------------------------------------

    #[test]
    fn vector_get_reads_base_vector_entries() {
        let tx = transaction(
            vec![entry(0, ReferenceRecipeNode::Null)],
            vec![vec![], vec![7, 3, 9]],
        );
        let feed = ReferenceReplayFeed::new(&tx);
        assert_eq!(feed.vector_get(&tx, 1, 0), Ok(7));
        assert_eq!(feed.vector_get(&tx, 1, 2), Ok(9));
    }

    #[test]
    fn vector_get_rejects_unavailable_ordinal_and_index() {
        let tx = transaction(
            vec![entry(0, ReferenceRecipeNode::Null)],
            vec![vec![], vec![7]],
        );
        let feed = ReferenceReplayFeed::new(&tx);
        assert_eq!(feed.vector_get(&tx, 2, 0), Err(Errno::EINVAL)); // no such ordinal
        assert_eq!(feed.vector_get(&tx, 1, 1), Err(Errno::EINVAL)); // index OOB
    }

    // -- routeGc / gcPayloadLength -------------------------------------------

    #[test]
    fn gc_route_i31_struct_array_and_mismatch() {
        let tx = transaction(
            vec![
                entry(0, ReferenceRecipeNode::Null),
                entry(1, ReferenceRecipeNode::I31 { value: -5 }),
                struct_node(2, 7, 12, vec![0; 4], vec![]),
                entry(
                    3,
                    ReferenceRecipeNode::Array {
                        module_activation: 7,
                        type_ordinal: 3,
                        layout_id: 13,
                        scalars: vec![0; 2],
                        elements: vec![],
                    },
                ),
            ],
            vec![vec![]],
        );
        let feed = ReferenceReplayFeed::new(&tx);
        assert_eq!(feed.gc_route(&tx, 1, 7), Ok(0)); // i31 -> 0
        assert_eq!(feed.gc_route(&tx, 2, 7), Ok(12)); // struct layout
        assert_eq!(feed.gc_route(&tx, 3, 7), Ok(13)); // array layout
        assert_eq!(feed.gc_route(&tx, 2, 9), Ok(-1)); // wrong activation
        assert_eq!(feed.gc_route(&tx, 0, 7), Ok(-1)); // null -> mismatch
    }

    #[test]
    fn gc_payload_len_i31_and_aggregate() {
        let tx = transaction(
            vec![
                entry(0, ReferenceRecipeNode::I31 { value: 1 }),
                struct_node(1, 7, 12, vec![0xaa, 0xbb, 0xcc], vec![]),
            ],
            vec![vec![]],
        );
        let feed = ReferenceReplayFeed::new(&tx);
        assert_eq!(feed.gc_payload_len(&tx, 0, 0, 0), Ok(4)); // i31 -> 4
        assert_eq!(feed.gc_payload_len(&tx, 0, 0, 1), Err(Errno::EINVAL)); // i31 nonzero layout
        assert_eq!(feed.gc_payload_len(&tx, 1, 7, 12), Ok(3)); // struct scalar len
        assert_eq!(feed.gc_payload_len(&tx, 1, 7, 99), Err(Errno::EINVAL)); // wrong layout
        assert_eq!(feed.gc_payload_len(&tx, 1, 9, 12), Err(Errno::EINVAL)); // wrong activation
    }

    // -- loadGc --------------------------------------------------------------

    #[test]
    fn gc_load_i31_writes_le_value() {
        let tx = transaction(vec![entry(0, ReferenceRecipeNode::I31 { value: -17 })], vec![vec![]]);
        let mut feed = ReferenceReplayFeed::new(&tx);
        let mut mem = vec![0u8; 32];
        // Reserved i31 coordinate: layout 0, type 0xffffffff, kind 0, 4 bytes.
        assert_eq!(
            feed.gc_load(&tx, &mut mem, 0, 0, 0xffff_ffff, 0, 0, 8, 4),
            Ok(0)
        );
        assert_eq!(&mem[8..12], &(-17i32).to_le_bytes());
        // Bad coordinate traps (EINVAL).
        assert_eq!(
            feed.gc_load(&tx, &mut mem, 0, 0, 0, 0, 0, 8, 4),
            Err(Errno::EINVAL)
        );
    }

    #[test]
    fn gc_load_struct_writes_scalars_and_interns_edge_vector() {
        let tx = transaction(
            vec![
                entry(0, ReferenceRecipeNode::Null),
                struct_node(1, 7, 12, vec![0x78, 0x56, 0x34, 0x12], vec![0, 0]),
            ],
            vec![vec![]],
        );
        let mut feed = ReferenceReplayFeed::new(&tx);
        let mut mem = vec![0u8; 32];
        // struct: kind 1, scalar bytes 4, coordinate matches; edges [0, 0].
        let ordinal = feed
            .gc_load(&tx, &mut mem, 1, 7, 101, 12, GC_KIND_STRUCT, 4, 4)
            .expect("gc_load struct");
        // Wrote the 4 scalar bytes.
        assert_eq!(&mem[4..8], &[0x78, 0x56, 0x34, 0x12]);
        // Appended a fresh vector at ordinal 1 (base length is 1: the empty sentinel).
        assert_eq!(ordinal, 1);
        // The appended vector is readable through vector_get.
        assert_eq!(feed.vector_get(&tx, 1, 0), Ok(0));
        assert_eq!(feed.vector_get(&tx, 1, 1), Ok(0));
        // A second gc_load of the SAME recipe returns the cached ordinal (no new append).
        let ordinal2 = feed
            .gc_load(&tx, &mut mem, 1, 7, 101, 12, GC_KIND_STRUCT, 4, 4)
            .expect("gc_load struct repeat");
        assert_eq!(ordinal2, 1);
    }

    #[test]
    fn gc_load_dedups_against_a_base_interned_vector() {
        // A base vector [3, 4] is interned at ordinal 1; a struct whose edges are
        // [3, 4] must dedup to ordinal 1 rather than append a duplicate.
        let tx = transaction(
            vec![
                entry(0, ReferenceRecipeNode::Null),
                struct_node(1, 7, 12, vec![], vec![3, 4]),
                entry(2, ReferenceRecipeNode::I31 { value: 3 }),
                entry(3, ReferenceRecipeNode::I31 { value: 4 }),
                entry(4, ReferenceRecipeNode::I31 { value: 5 }),
            ],
            vec![vec![], vec![3, 4]],
        );
        let mut feed = ReferenceReplayFeed::new(&tx);
        let mut mem = vec![0u8; 16];
        let ordinal = feed
            .gc_load(&tx, &mut mem, 1, 7, 101, 12, GC_KIND_STRUCT, 0, 0)
            .expect("gc_load struct");
        assert_eq!(ordinal, 1); // deduped to the base ordinal
    }

    #[test]
    fn gc_load_empty_edges_returns_zero() {
        let tx = transaction(
            vec![
                entry(0, ReferenceRecipeNode::Null),
                struct_node(1, 7, 12, vec![0xff], vec![]),
            ],
            vec![vec![]],
        );
        let mut feed = ReferenceReplayFeed::new(&tx);
        let mut mem = vec![0u8; 16];
        assert_eq!(
            feed.gc_load(&tx, &mut mem, 1, 7, 101, 12, GC_KIND_STRUCT, 4, 1),
            Ok(0)
        );
        assert_eq!(mem[4], 0xff);
    }

    #[test]
    fn gc_load_rejects_coordinate_mismatch_and_bad_destination() {
        let tx = transaction(
            vec![
                entry(0, ReferenceRecipeNode::Null),
                struct_node(1, 7, 12, vec![1, 2], vec![]),
            ],
            vec![vec![]],
        );
        let mut feed = ReferenceReplayFeed::new(&tx);
        let mut mem = vec![0u8; 16];
        // Wrong scalar byte length.
        assert_eq!(
            feed.gc_load(&tx, &mut mem, 1, 7, 101, 12, GC_KIND_STRUCT, 0, 4),
            Err(Errno::EINVAL)
        );
        // Wrong kind (array kind for a struct node).
        assert_eq!(
            feed.gc_load(&tx, &mut mem, 1, 7, 101, 12, GC_KIND_ARRAY, 0, 2),
            Err(Errno::EINVAL)
        );
        // Destination out of range.
        assert_eq!(
            feed.gc_load(&tx, &mut mem, 1, 7, 101, 12, GC_KIND_STRUCT, 15, 2),
            Err(Errno::EINVAL)
        );
    }

    // -- routeException / loadException / exceptionCacheIndex ----------------

    fn exnref_node(id: u32, activation: u32, tag: u32, layout: u32, scalars: Vec<u8>, payloads: Vec<u32>) -> ReferenceRecipeEntry {
        entry(
            id,
            ReferenceRecipeNode::Exnref {
                module_activation: activation,
                tag_ordinal: tag,
                layout_id: layout,
                scalars,
                payloads,
            },
        )
    }

    #[test]
    fn exn_route_matches_and_mismatches() {
        let tx = transaction(
            vec![
                entry(0, ReferenceRecipeNode::Null),
                exnref_node(1, 7, 5, 15, vec![], vec![]),
            ],
            vec![vec![]],
        );
        let feed = ReferenceReplayFeed::new(&tx);
        assert_eq!(feed.exn_route(&tx, 1, 7), Ok(15));
        assert_eq!(feed.exn_route(&tx, 1, 9), Ok(-1)); // wrong activation
        assert_eq!(feed.exn_route(&tx, 0, 7), Ok(-1)); // not an exnref
    }

    #[test]
    fn exn_load_writes_scalars_and_reference_ids() {
        let tx = transaction(
            vec![
                entry(0, ReferenceRecipeNode::Null),
                entry(1, ReferenceRecipeNode::Externref { handle: 8 }),
                exnref_node(2, 7, 5, 15, vec![0xde, 0xad, 0xbe, 0xef], vec![1, 0]),
            ],
            vec![vec![]],
        );
        let feed = ReferenceReplayFeed::new(&tx);
        let mut mem = vec![0u8; 64];
        assert_eq!(
            feed.exn_load(&tx, &mut mem, 2, 7, 5, 15, 8, 4, 16, 2),
            Ok(1)
        );
        assert_eq!(&mem[8..12], &[0xde, 0xad, 0xbe, 0xef]);
        assert_eq!(&mem[16..20], &1u32.to_le_bytes());
        assert_eq!(&mem[20..24], &0u32.to_le_bytes());
    }

    #[test]
    fn exn_load_rejects_coordinate_and_reference_count_mismatch() {
        let tx = transaction(
            vec![
                entry(0, ReferenceRecipeNode::Null),
                exnref_node(1, 7, 5, 15, vec![1, 2], vec![0]),
            ],
            vec![vec![]],
        );
        let feed = ReferenceReplayFeed::new(&tx);
        let mut mem = vec![0u8; 32];
        // Wrong tag ordinal.
        assert_eq!(feed.exn_load(&tx, &mut mem, 1, 7, 99, 15, 0, 2, 8, 1), Err(Errno::EINVAL));
        // Wrong reference count.
        assert_eq!(feed.exn_load(&tx, &mut mem, 1, 7, 5, 15, 0, 2, 8, 2), Err(Errno::EINVAL));
        // Not an exnref.
        assert_eq!(feed.exn_load(&tx, &mut mem, 0, 0, 0, 0, 0, 0, 0, 0), Err(Errno::EINVAL));
    }

    #[test]
    fn exception_cache_index_is_one_based_in_id_order() {
        let tx = transaction(
            vec![
                entry(0, ReferenceRecipeNode::Null),
                exnref_node(1, 7, 5, 15, vec![], vec![]),
                entry(2, ReferenceRecipeNode::Externref { handle: 9 }),
                exnref_node(3, 7, 6, 16, vec![], vec![]),
            ],
            vec![vec![]],
        );
        let feed = ReferenceReplayFeed::new(&tx);
        assert_eq!(feed.exn_cache_index(&tx, 1), Ok(1)); // first exnref
        assert_eq!(feed.exn_cache_index(&tx, 3), Ok(2)); // second exnref
        assert_eq!(feed.exn_cache_index(&tx, 2), Err(Errno::EINVAL)); // not an exnref
        assert_eq!(feed.exn_cache_index(&tx, 9), Err(Errno::EINVAL)); // out of range
    }

    // -- panic freedom -------------------------------------------------------

    #[test]
    fn out_of_range_recipe_never_panics() {
        let tx = transaction(vec![entry(0, ReferenceRecipeNode::Null)], vec![vec![]]);
        let mut feed = ReferenceReplayFeed::new(&tx);
        let mut mem = vec![0u8; 8];
        assert_eq!(feed.gc_route(&tx, 99, 0), Err(Errno::EINVAL));
        assert_eq!(feed.gc_payload_len(&tx, 99, 0, 0), Err(Errno::EINVAL));
        assert_eq!(feed.gc_load(&tx, &mut mem, 99, 0, 0, 0, 0, 0, 0), Err(Errno::EINVAL));
        assert_eq!(feed.exn_route(&tx, 99, 0), Err(Errno::EINVAL));
        assert_eq!(feed.exn_load(&tx, &mut mem, 99, 0, 0, 0, 0, 0, 0, 0), Err(Errno::EINVAL));
        assert_eq!(feed.exn_cache_index(&tx, 99), Err(Errno::EINVAL));
    }
}
