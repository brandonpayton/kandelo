//! Pure-Rust KFRV/KFRS SERIALIZER for the LIVE segmented fork reference
//! transaction — the encode-side inverse of `reference_transaction`.
//!
//! Ported field-for-field from `appendSegmentedForkReferenceTransaction` +
//! `SegmentWriter` + `encodeNodeRecordV2` + `encodeManifest` +
//! `computeSectionTotals` in `host/src/fork-reference-segments.ts`. Given a built
//! `ReferenceGraphBuilder`, it streams the five logical sections (nodes / edges /
//! scalars / vector index / vector entries) into an arena as bounded KFRS segment
//! records, then commits a single 96-byte KFRV manifest. The byte layout is
//! exactly what `decode_segmented_reference_transaction` reads, proven in-crate
//! by round-tripping the writer's output back through that decoder.
//!
//! The writer targets an `arena append-record` sink (`ReferenceRecordSink`),
//! mirroring the TS `ForkModuleStateArena.appendRecord`, the same way
//! `linked_frames_writer` targets a `ChunkAllocator`. It is bounds-checked and
//! panic-free: a malformed graph or a u64 total overflow returns
//! `Err(Errno::EINVAL)`, and a sink append failure propagates the sink's own
//! errno unchanged.
//!
//! Wire constants are the shared-ABI mirror in `crates/shared/src/lib.rs`
//! (`WPK_FORK_REFERENCE_*`, `WPK_FORK_MODULE_STATE_RECORD_KIND_REFERENCE_*`);
//! this module never redefines a size or magic that the decoder already reads.

use wasm_posix_shared::abi;
use wasm_posix_shared::Errno;

use alloc::vec::Vec;

use crate::reference_graph_builder::{node_edges, node_scalars, ReferenceGraphBuilder};
use crate::reference_recipes::ReferenceRecipeNode;

/// KFRV manifest magic (`"KFRV"`, little-endian). Mirrors the decoder.
const KFRV_MAGIC: u32 = le_magic(abi::WPK_FORK_REFERENCE_TRANSACTION_MAGIC);
/// KFRS segment magic (`"KFRS"`, little-endian). Mirrors the decoder.
const KFRS_MAGIC: u32 = le_magic(abi::WPK_FORK_REFERENCE_SEGMENT_MAGIC);
/// Transaction/segment version (2).
const VERSION: u16 = abi::WPK_FORK_REFERENCE_TRANSACTION_VERSION;
/// 96-byte KFRV manifest.
const MANIFEST_SIZE: usize = abi::WPK_FORK_REFERENCE_TRANSACTION_MANIFEST_SIZE as usize;
/// 40-byte KFRS segment header.
const SEGMENT_HEADER_SIZE: usize = abi::WPK_FORK_REFERENCE_SEGMENT_HEADER_SIZE as usize;
/// 48-byte node record.
const NODE_RECORD_SIZE: usize = abi::WPK_FORK_REFERENCE_NODE_RECORD_SIZE as usize;
/// 16-byte vector-index record.
const VECTOR_INDEX_SIZE: usize = abi::WPK_FORK_REFERENCE_VECTOR_INDEX_SIZE as usize;
const SEGMENT_KNOWN_FLAGS: u16 = abi::WPK_FORK_REFERENCE_SEGMENT_KNOWN_FLAGS;
const MANIFEST_FLAG_SEALED: u32 = abi::WPK_FORK_REFERENCE_TRANSACTION_FLAG_SEALED;

/// KFMS record kinds carrying the transaction; mirror the decoder's selection.
const RECORD_KIND_REFERENCE_RECIPE: u16 = abi::WPK_FORK_MODULE_STATE_RECORD_KIND_REFERENCE_RECIPE;
const RECORD_KIND_REFERENCE_RECIPE_SEGMENT: u16 =
    abi::WPK_FORK_MODULE_STATE_RECORD_KIND_REFERENCE_RECIPE_SEGMENT;

/// The five section discriminants (1..=5), in canonical emit order.
const SECTION_NODES: u16 = abi::WPK_FORK_REFERENCE_SECTION_NODES;
const SECTION_EDGES: u16 = abi::WPK_FORK_REFERENCE_SECTION_EDGES;
const SECTION_SCALARS: u16 = abi::WPK_FORK_REFERENCE_SECTION_SCALARS;
const SECTION_VECTOR_INDEX: u16 = abi::WPK_FORK_REFERENCE_SECTION_VECTOR_INDEX;
const SECTION_VECTOR_ENTRIES: u16 = abi::WPK_FORK_REFERENCE_SECTION_VECTOR_ENTRIES;

// Node kind discriminants; mirror the TS `WireNodeKind` const enum, exactly as
// the sibling decoder in `reference_transaction` carries them locally.
const KIND_NULL: u8 = 0;
const KIND_FUNCREF: u8 = 1;
const KIND_EXTERNREF: u8 = 2;
const KIND_EXNREF: u8 = 3;
const KIND_I31: u8 = 4;
const KIND_STRUCT: u8 = 5;
const KIND_ARRAY: u8 = 6;
const KIND_STATIC_ROOT: u8 = 7;

/// Compile-time little-endian fold of a four-byte ABI magic. Mirrors the decoder.
const fn le_magic(bytes: [u8; 4]) -> u32 {
    (bytes[0] as u32)
        | ((bytes[1] as u32) << 8)
        | ((bytes[2] as u32) << 16)
        | ((bytes[3] as u32) << 24)
}

/// Arena append-record sink: the writer's only egress. Mirrors the TS
/// `ForkModuleStateArena.appendRecord({kind, activationId, ownerId, payload})`.
/// Any `FnMut(...) -> Result<(), Errno>` is a sink, so tests and callers can pass
/// a plain closure that collects records. An append FAILURE propagates the sink's
/// own errno unchanged (an exhausted arena surfaces as `ENOMEM`, never a masked
/// `EINVAL`), matching the `ChunkAllocator` contract in `linked_frames_writer`.
pub trait ReferenceRecordSink {
    /// Append one KFMS record to the arena.
    fn append_record(
        &mut self,
        kind: u16,
        activation_id: u32,
        owner_id: u32,
        payload: &[u8],
    ) -> Result<(), Errno>;
}

impl<F: FnMut(u16, u32, u32, &[u8]) -> Result<(), Errno>> ReferenceRecordSink for F {
    fn append_record(
        &mut self,
        kind: u16,
        activation_id: u32,
        owner_id: u32,
        payload: &[u8],
    ) -> Result<(), Errno> {
        self(kind, activation_id, owner_id, payload)
    }
}

/// Serializer for a built reference graph. Mirrors the parameters of
/// `appendSegmentedForkReferenceTransaction`: the process reference `owner_id`
/// and the bounded per-segment copy window (`segment_data_bytes`).
#[derive(Debug, Clone, Copy)]
pub struct ReferenceSegmentsWriter {
    owner_id: u32,
    segment_data_bytes: usize,
}

impl ReferenceSegmentsWriter {
    /// A writer for `owner_id` with a `segment_data_bytes` copy window. Mirrors
    /// the TS validation: the owner must be nonzero and the window a positive
    /// count that leaves room for the 40-byte segment header within u32.
    pub fn new(owner_id: u32, segment_data_bytes: usize) -> Result<Self, Errno> {
        if owner_id == 0 {
            return Err(Errno::EINVAL); // the zero owner is the unowned sentinel
        }
        if segment_data_bytes == 0
            || (segment_data_bytes as u64) > (u32::MAX as u64 - SEGMENT_HEADER_SIZE as u64)
        {
            return Err(Errno::EINVAL); // invalid segment window
        }
        Ok(ReferenceSegmentsWriter {
            owner_id,
            segment_data_bytes,
        })
    }

    /// Serialize `builder`'s graph into `sink`: five sections of KFRS segment
    /// records followed by the KFRV manifest. Mirrors
    /// `appendSegmentedForkReferenceTransaction`. Validates the graph is a
    /// canonical, sealed capture first; any malformed graph or u64 overflow
    /// yields `Err(Errno::EINVAL)`, and a sink failure propagates unchanged.
    pub fn write<S: ReferenceRecordSink>(
        &self,
        sink: &mut S,
        builder: &ReferenceGraphBuilder,
    ) -> Result<(), Errno> {
        builder.validate()?;
        let nodes = builder.nodes();
        let vectors = builder.vectors();

        let totals = compute_section_totals(nodes, vectors)?;
        let mut ordinal: u64 = 0;

        // Section 1: nodes — one 48-byte record per node, in id order.
        {
            let mut writer = SegmentWriter::new(self, SECTION_NODES, &mut ordinal);
            let mut edge_start: u64 = 0;
            let mut scalar_start: u64 = 0;
            let mut record = [0u8; NODE_RECORD_SIZE];
            for node in nodes {
                record.fill(0);
                let edges = node_edges(node);
                let scalars = node_scalars(node);
                let edge_count = edges.len() as u64;
                let scalar_length = scalars.len() as u64;
                encode_node_record(&mut record, node, edge_start, edge_count, scalar_start, scalar_length);
                writer.write(sink, &record)?;
                edge_start = edge_start.checked_add(edge_count).ok_or(Errno::EINVAL)?;
                scalar_start = scalar_start.checked_add(scalar_length).ok_or(Errno::EINVAL)?;
            }
            writer.finish(sink)?;
        }

        // Section 2: edges — flat u32 LE per node, in id order.
        {
            let mut writer = SegmentWriter::new(self, SECTION_EDGES, &mut ordinal);
            for node in nodes {
                for &edge in node_edges(node) {
                    writer.write(sink, &edge.to_le_bytes())?;
                }
            }
            writer.finish(sink)?;
        }

        // Section 3: scalars — concatenated scalar bytes, in id order.
        {
            let mut writer = SegmentWriter::new(self, SECTION_SCALARS, &mut ordinal);
            for node in nodes {
                writer.write(sink, node_scalars(node))?;
            }
            writer.finish(sink)?;
        }

        // Section 4: vector index — 16-byte {entryStart, length} per ordinal 1..
        {
            let mut writer = SegmentWriter::new(self, SECTION_VECTOR_INDEX, &mut ordinal);
            let mut entry_start: u64 = 0;
            let mut index = [0u8; VECTOR_INDEX_SIZE];
            for vector in vectors.iter().skip(1) {
                let length = vector.len() as u64;
                index[0..8].copy_from_slice(&entry_start.to_le_bytes());
                index[8..16].copy_from_slice(&length.to_le_bytes());
                writer.write(sink, &index)?;
                entry_start = entry_start.checked_add(length).ok_or(Errno::EINVAL)?;
            }
            writer.finish(sink)?;
        }

        // Section 5: vector entries — flat u32 LE per ordinal 1..
        {
            let mut writer = SegmentWriter::new(self, SECTION_VECTOR_ENTRIES, &mut ordinal);
            for vector in vectors.iter().skip(1) {
                for &recipe in vector {
                    writer.write(sink, &recipe.to_le_bytes())?;
                }
            }
            writer.finish(sink)?;
        }

        // The manifest is the transaction commit point, emitted last.
        let vector_count = (vectors.len() as u64).checked_sub(1).ok_or(Errno::EINVAL)?;
        let manifest = encode_manifest(ordinal, nodes.len() as u64, vector_count, &totals)?;
        sink.append_record(RECORD_KIND_REFERENCE_RECIPE, 0, self.owner_id, &manifest)
    }
}

/// The five section byte totals, in canonical order. Mirrors `SectionTotals`.
struct SectionTotals {
    nodes: u64,
    edges: u64,
    scalars: u64,
    vector_index: u64,
    vector_entries: u64,
}

/// Compute the five section byte totals in u64 so a hostile 32-bit product
/// cannot wrap. Mirrors `computeSectionTotals`.
fn compute_section_totals(
    nodes: &[ReferenceRecipeNode],
    vectors: &[Vec<u32>],
) -> Result<SectionTotals, Errno> {
    let mut edge_count: u64 = 0;
    let mut scalar_bytes: u64 = 0;
    for node in nodes {
        edge_count = edge_count
            .checked_add(node_edges(node).len() as u64)
            .ok_or(Errno::EINVAL)?;
        scalar_bytes = scalar_bytes
            .checked_add(node_scalars(node).len() as u64)
            .ok_or(Errno::EINVAL)?;
    }
    let mut vector_entries: u64 = 0;
    for vector in vectors.iter().skip(1) {
        vector_entries = vector_entries
            .checked_add(vector.len() as u64)
            .ok_or(Errno::EINVAL)?;
    }
    let node_bytes = (nodes.len() as u64)
        .checked_mul(NODE_RECORD_SIZE as u64)
        .ok_or(Errno::EINVAL)?;
    let edge_bytes = edge_count.checked_mul(4).ok_or(Errno::EINVAL)?;
    let vector_index_bytes = (vectors.len() as u64 - 1)
        .checked_mul(VECTOR_INDEX_SIZE as u64)
        .ok_or(Errno::EINVAL)?;
    let vector_entry_bytes = vector_entries.checked_mul(4).ok_or(Errno::EINVAL)?;
    Ok(SectionTotals {
        nodes: node_bytes,
        edges: edge_bytes,
        scalars: scalar_bytes,
        vector_index: vector_index_bytes,
        vector_entries: vector_entry_bytes,
    })
}

/// Encode one 48-byte KFRV v2 node record. Mirrors `encodeNodeRecordV2`: the
/// three coordinate words carry per-kind fields, and only aggregate kinds name a
/// nonzero edge/scalar range. `record` is exactly `NODE_RECORD_SIZE` bytes.
fn encode_node_record(
    record: &mut [u8; NODE_RECORD_SIZE],
    node: &ReferenceRecipeNode,
    edge_start: u64,
    edge_count: u64,
    scalar_start: u64,
    scalar_length: u64,
) {
    let (kind, first, second, third, aggregate) = match node {
        ReferenceRecipeNode::Null => (KIND_NULL, 0, 0, 0, false),
        ReferenceRecipeNode::Funcref {
            module_activation,
            function_ordinal,
        } => (KIND_FUNCREF, *module_activation, *function_ordinal, 0, false),
        ReferenceRecipeNode::Externref { handle } => {
            // The broker handle is `1..=0xffff_ffff`, so the high word is zero;
            // this matches the TS `(handle >>> 0, floor(handle / 2^32))` split.
            (KIND_EXTERNREF, *handle, 0, 0, false)
        }
        ReferenceRecipeNode::Exnref {
            module_activation,
            tag_ordinal,
            layout_id,
            ..
        } => (KIND_EXNREF, *module_activation, *tag_ordinal, *layout_id, true),
        ReferenceRecipeNode::I31 { value } => (KIND_I31, *value as u32, 0, 0, false),
        ReferenceRecipeNode::Struct {
            module_activation,
            type_ordinal,
            layout_id,
            ..
        } => (KIND_STRUCT, *module_activation, *type_ordinal, *layout_id, true),
        ReferenceRecipeNode::Array {
            module_activation,
            type_ordinal,
            layout_id,
            ..
        } => (KIND_ARRAY, *module_activation, *type_ordinal, *layout_id, true),
        ReferenceRecipeNode::StaticRoot {
            module_activation,
            static_root_ordinal,
        } => (KIND_STATIC_ROOT, *module_activation, *static_root_ordinal, 0, false),
    };
    record[0] = kind;
    record[1] = 0;
    record[2..4].copy_from_slice(&0u16.to_le_bytes());
    record[4..8].copy_from_slice(&first.to_le_bytes());
    record[8..12].copy_from_slice(&second.to_le_bytes());
    record[12..16].copy_from_slice(&third.to_le_bytes());
    let (es, ec, ss, sl) = if aggregate {
        (edge_start, edge_count, scalar_start, scalar_length)
    } else {
        (0, 0, 0, 0)
    };
    record[16..24].copy_from_slice(&es.to_le_bytes());
    record[24..32].copy_from_slice(&ec.to_le_bytes());
    record[32..40].copy_from_slice(&ss.to_le_bytes());
    record[40..48].copy_from_slice(&sl.to_le_bytes());
}

/// Encode the 96-byte KFRV manifest. Mirrors `encodeManifest`.
fn encode_manifest(
    segment_count: u64,
    node_count: u64,
    vector_count: u64,
    totals: &SectionTotals,
) -> Result<Vec<u8>, Errno> {
    let mut total_logical: u64 = 0;
    for total in [
        totals.nodes,
        totals.edges,
        totals.scalars,
        totals.vector_index,
        totals.vector_entries,
    ] {
        total_logical = total_logical.checked_add(total).ok_or(Errno::EINVAL)?;
    }
    let mut manifest = alloc::vec![0u8; MANIFEST_SIZE];
    manifest[0..4].copy_from_slice(&KFRV_MAGIC.to_le_bytes());
    manifest[4..6].copy_from_slice(&VERSION.to_le_bytes());
    manifest[6..8].copy_from_slice(&(MANIFEST_SIZE as u16).to_le_bytes());
    manifest[8..12].copy_from_slice(&MANIFEST_FLAG_SEALED.to_le_bytes());
    manifest[12..16].copy_from_slice(&(NODE_RECORD_SIZE as u32).to_le_bytes());
    manifest[16..20].copy_from_slice(&(VECTOR_INDEX_SIZE as u32).to_le_bytes());
    manifest[20..24].copy_from_slice(&0u32.to_le_bytes());
    manifest[24..32].copy_from_slice(&segment_count.to_le_bytes());
    manifest[32..40].copy_from_slice(&node_count.to_le_bytes());
    manifest[40..48].copy_from_slice(&vector_count.to_le_bytes());
    manifest[48..56].copy_from_slice(&totals.nodes.to_le_bytes());
    manifest[56..64].copy_from_slice(&totals.edges.to_le_bytes());
    manifest[64..72].copy_from_slice(&totals.scalars.to_le_bytes());
    manifest[72..80].copy_from_slice(&totals.vector_index.to_le_bytes());
    manifest[80..88].copy_from_slice(&totals.vector_entries.to_le_bytes());
    manifest[88..96].copy_from_slice(&total_logical.to_le_bytes());
    Ok(manifest)
}

/// One section's bounded copy window over the arena. Mirrors the TS
/// `SegmentWriter`: it buffers up to `segment_data_bytes`, flushing a KFRS
/// segment record whenever the window fills or the section finishes. The `u64`
/// segment ordinal is shared across all five sections (threaded by `&mut`), while
/// the logical offset is per-section (reset by constructing a fresh writer).
struct SegmentWriter<'a> {
    owner_id: u32,
    section: u16,
    buffer: Vec<u8>,
    used: usize,
    capacity: usize,
    logical_offset: u64,
    ordinal: &'a mut u64,
}

impl<'a> SegmentWriter<'a> {
    fn new(writer: &ReferenceSegmentsWriter, section: u16, ordinal: &'a mut u64) -> Self {
        SegmentWriter {
            owner_id: writer.owner_id,
            section,
            buffer: alloc::vec![0u8; writer.segment_data_bytes],
            used: 0,
            capacity: writer.segment_data_bytes,
            logical_offset: 0,
            ordinal,
        }
    }

    /// Copy `bytes` into the window, flushing whenever it fills. Mirrors
    /// `SegmentWriter.write`.
    fn write<S: ReferenceRecordSink>(&mut self, sink: &mut S, bytes: &[u8]) -> Result<(), Errno> {
        let mut source = 0;
        while source < bytes.len() {
            let count = core::cmp::min(bytes.len() - source, self.capacity - self.used);
            self.buffer[self.used..self.used + count].copy_from_slice(&bytes[source..source + count]);
            self.used += count;
            source += count;
            if self.used == self.capacity {
                self.flush(sink)?;
            }
        }
        Ok(())
    }

    /// Flush any buffered tail. Mirrors `SegmentWriter.finish`.
    fn finish<S: ReferenceRecordSink>(&mut self, sink: &mut S) -> Result<(), Errno> {
        self.flush(sink)
    }

    /// Emit one KFRS segment record for the buffered bytes, advancing the shared
    /// ordinal and this section's logical offset. Mirrors `SegmentWriter.flush`:
    /// an empty buffer emits nothing.
    fn flush<S: ReferenceRecordSink>(&mut self, sink: &mut S) -> Result<(), Errno> {
        if self.used == 0 {
            return Ok(());
        }
        let mut payload = alloc::vec![0u8; SEGMENT_HEADER_SIZE + self.used];
        payload[0..4].copy_from_slice(&KFRS_MAGIC.to_le_bytes());
        payload[4..6].copy_from_slice(&VERSION.to_le_bytes());
        payload[6..8].copy_from_slice(&(SEGMENT_HEADER_SIZE as u16).to_le_bytes());
        payload[8..10].copy_from_slice(&self.section.to_le_bytes());
        payload[10..12].copy_from_slice(&SEGMENT_KNOWN_FLAGS.to_le_bytes());
        payload[12..16].copy_from_slice(&0u32.to_le_bytes());
        payload[16..24].copy_from_slice(&self.ordinal.to_le_bytes());
        payload[24..32].copy_from_slice(&self.logical_offset.to_le_bytes());
        payload[32..36].copy_from_slice(&(self.used as u32).to_le_bytes());
        payload[36..40].copy_from_slice(&0u32.to_le_bytes());
        payload[SEGMENT_HEADER_SIZE..].copy_from_slice(&self.buffer[..self.used]);
        sink.append_record(
            RECORD_KIND_REFERENCE_RECIPE_SEGMENT,
            0,
            self.owner_id,
            &payload,
        )?;
        self.logical_offset = self
            .logical_offset
            .checked_add(self.used as u64)
            .ok_or(Errno::EINVAL)?;
        *self.ordinal = self.ordinal.checked_add(1).ok_or(Errno::EINVAL)?;
        self.used = 0;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::reference_graph_builder::{AggregateKind, GcProvenance, ReferenceGraphBuilder};
    use crate::reference_recipes::ReferenceRecipeEntry;
    use crate::reference_transaction::{
        decode_segmented_reference_transaction, vector_intern_key, SegmentedReferenceTransaction,
    };
    use crate::ReferenceTransactionRecord;
    use alloc::vec;
    use alloc::vec::Vec;

    /// `WPK_FORK_REFERENCE_TRANSACTION_OWNER`.
    const OWNER: u32 = 1;
    const MIN_I31: i32 = -0x4000_0000;
    const MAX_I31: i32 = 0x3fff_ffff;

    type OwnedRecord = (u16, u32, u32, Vec<u8>);

    /// Serialize `builder` into an in-memory arena sink at the given segment
    /// window, returning the owned KFMS record stream.
    fn serialize(builder: &ReferenceGraphBuilder, window: usize) -> Result<Vec<OwnedRecord>, Errno> {
        let writer = ReferenceSegmentsWriter::new(OWNER, window)?;
        let mut records: Vec<OwnedRecord> = Vec::new();
        {
            let mut sink = |kind: u16, activation: u32, owner: u32, payload: &[u8]| {
                records.push((kind, activation, owner, payload.to_vec()));
                Ok(())
            };
            writer.write(&mut sink, builder)?;
        }
        Ok(records)
    }

    /// Decode an owned record stream through the EXISTING decoder — the oracle.
    fn decode(records: &[OwnedRecord]) -> Result<SegmentedReferenceTransaction, Errno> {
        let views: Vec<ReferenceTransactionRecord> = records
            .iter()
            .map(|(kind, activation, owner, payload)| ReferenceTransactionRecord {
                kind: *kind,
                activation_id: *activation,
                owner_id: *owner,
                payload,
            })
            .collect();
        decode_segmented_reference_transaction(&views, OWNER)
    }

    /// The graph the decoder must reconstruct from the builder's own state:
    /// canonical entries `id == index`, the interned vectors, and intern index.
    fn expected(builder: &ReferenceGraphBuilder) -> SegmentedReferenceTransaction {
        SegmentedReferenceTransaction {
            roots: Vec::new(),
            nodes: builder
                .nodes()
                .iter()
                .enumerate()
                .map(|(id, node)| ReferenceRecipeEntry {
                    id: id as u32,
                    node: node.clone(),
                })
                .collect(),
            vectors: builder.vectors().to_vec(),
            vector_intern: builder.vector_intern().clone(),
        }
    }

    /// The writer's output round-trips through the decoder back to the builder's
    /// own graph, at the given segment window.
    fn assert_round_trips(builder: &ReferenceGraphBuilder, window: usize) {
        let records = serialize(builder, window).expect("serialize");
        let decoded = decode(&records).expect("decode");
        assert_eq!(decoded, expected(builder));
    }

    /// A graph exercising every node kind, a struct<->array cycle sharing an
    /// aliased leaf, and a shared (deduped) vector.
    fn comprehensive() -> ReferenceGraphBuilder {
        let mut b = ReferenceGraphBuilder::begin();
        // Claim the three aggregates first so a field can close a cycle.
        let s = b.claim_gc().unwrap(); // 1: struct
        let a = b.claim_gc().unwrap(); // 2: array
        let e = b.claim_gc().unwrap(); // 3: exnref
        let f = b.intern_funcref(10, 20).unwrap(); // 4
        let x = b.intern_externref(99).unwrap(); // 5
        let i = b.intern_i31(-5).unwrap(); // 6
        let sr = b.intern_static_root(3, 7).unwrap(); // 7
        let leaf = b.intern_externref(0xffff_ffff).unwrap(); // 8: aliased leaf
        assert_eq!((s, a, e, f, x, i, sr, leaf), (1, 2, 3, 4, 5, 6, 7, 8));

        // struct 1 -> array 2 (cycle), leaf 8 (alias), exnref 3.
        b.define_gc(s, 7, 2, 12, AggregateKind::Struct, &[0x78, 0x56, 0x34, 0x12], &[a, leaf, e], None)
            .unwrap();
        // array 2 -> struct 1 (cycle), leaf 8 (alias).
        b.define_gc(a, 7, 3, 13, AggregateKind::Array, &[0xaa, 0xbb], &[s, leaf], None)
            .unwrap();
        // exnref 3 with scalars + reference payloads.
        b.define_gc(e, 7, 5, 15, AggregateKind::Exnref, &[1, 2, 3], &[f, i], None)
            .unwrap();

        // A shared/deduped vector: two identical builds return the same ordinal.
        let v1 = b.begin_vector().unwrap();
        for id in [f, x, i] {
            b.append_vector(v1, id).unwrap();
        }
        let o1 = b.finish_vector(v1).unwrap();
        let v2 = b.begin_vector().unwrap();
        for id in [f, x, i] {
            b.append_vector(v2, id).unwrap();
        }
        let o2 = b.finish_vector(v2).unwrap();
        assert_eq!(o1, o2, "identical vectors dedup to one ordinal");

        let v3 = b.begin_vector().unwrap();
        for id in [s, a] {
            b.append_vector(v3, id).unwrap();
        }
        let o3 = b.finish_vector(v3).unwrap();
        assert_eq!((o1, o3), (1, 2));
        b
    }

    #[test]
    fn round_trips_every_node_kind_and_shared_vector() {
        let b = comprehensive();
        // Large window (single segment per section) and a tiny window that spills
        // every section across many bounded segments both round-trip.
        assert_round_trips(&b, 1 << 16);
        assert_round_trips(&b, 32);
        assert_round_trips(&b, 1);
    }

    #[test]
    fn round_trips_minimal_null_only_graph() {
        let b = ReferenceGraphBuilder::begin();
        assert_round_trips(&b, 1 << 16);
        // The null-only graph has one node record, no edges/scalars/vectors.
        let records = serialize(&b, 1 << 16).unwrap();
        // Exactly one node segment + the manifest.
        assert_eq!(records.len(), 2);
    }

    #[test]
    fn i31_domain_boundaries_round_trip() {
        let mut b = ReferenceGraphBuilder::begin();
        b.intern_i31(MIN_I31).unwrap();
        b.intern_i31(MAX_I31).unwrap();
        b.intern_i31(0).unwrap();
        assert_round_trips(&b, 1 << 16);
    }

    #[test]
    fn gated_placeholders_are_distinct_canonical_leaves() {
        // Each gated placeholder is its own recipe id (no i31 dedup), so the
        // host's captured-value side table stays one-to-one with the graph even
        // when several gated live values collapse to the same wire shape.
        let mut b = ReferenceGraphBuilder::begin();
        let g1 = b.push_gated_placeholder().unwrap();
        let g2 = b.push_gated_placeholder().unwrap();
        // A real interned i31(0) still dedups against itself, but NOT against the
        // gated placeholders — they are independent nodes.
        let z1 = b.intern_i31(0).unwrap();
        let z2 = b.intern_i31(0).unwrap();
        assert_eq!((g1, g2), (1, 2), "gated placeholders take fresh ids");
        assert_eq!(z1, z2, "intern_i31 still dedups by value");
        assert_eq!(z1, 3, "the interned i31 is a fourth distinct node");
        assert_eq!(b.nodes().len(), 4);
        b.validate().expect("a graph of gated leaves is canonical");
        assert_round_trips(&b, 1 << 16);
    }

    #[test]
    fn interns_dedup_by_coordinate() {
        let mut b = ReferenceGraphBuilder::begin();
        let a1 = b.intern_funcref(1, 2).unwrap();
        let a2 = b.intern_funcref(1, 2).unwrap();
        let x1 = b.intern_externref(7).unwrap();
        let x2 = b.intern_externref(7).unwrap();
        let i1 = b.intern_i31(42).unwrap();
        let i2 = b.intern_i31(42).unwrap();
        let r1 = b.intern_static_root(3, 4).unwrap();
        let r2 = b.intern_static_root(3, 4).unwrap();
        assert_eq!((a1, x1, i1, r1), (a2, x2, i2, r2));
        // Four distinct nodes plus the null: ids 0..=4.
        assert_eq!(b.nodes().len(), 5);
        assert_round_trips(&b, 1 << 16);
    }

    // --- Emitted record/segment/manifest sizes ---------------------------

    #[test]
    fn emitted_record_sizes_match_the_wire_geometry() {
        let b = comprehensive();
        // A window larger than any section keeps each section in one segment, so
        // the payload sizes are exactly header + section bytes.
        let records = serialize(&b, 1 << 16).unwrap();
        let node_count = b.nodes().len() as u64;
        let vector_count = (b.vectors().len() - 1) as u64;

        // The manifest is the single 96-byte KFRV record.
        let manifests: Vec<&OwnedRecord> = records
            .iter()
            .filter(|(kind, ..)| *kind == RECORD_KIND_REFERENCE_RECIPE)
            .collect();
        assert_eq!(manifests.len(), 1);
        assert_eq!(manifests[0].3.len(), MANIFEST_SIZE);
        assert_eq!(MANIFEST_SIZE, 96);

        // Every segment record carries the 40-byte KFRS header.
        for (kind, _, _, payload) in &records {
            if *kind == RECORD_KIND_REFERENCE_RECIPE_SEGMENT {
                assert!(payload.len() > SEGMENT_HEADER_SIZE);
                assert_eq!(&payload[0..4], b"KFRS");
            }
        }
        assert_eq!(SEGMENT_HEADER_SIZE, 40);
        assert_eq!(NODE_RECORD_SIZE, 48);
        assert_eq!(VECTOR_INDEX_SIZE, 16);

        // The single nodes segment holds one 48-byte record per node; the single
        // vector-index segment holds one 16-byte entry per vector.
        let section_len = |section: u16| -> usize {
            records
                .iter()
                .filter(|(kind, _, _, payload)| {
                    *kind == RECORD_KIND_REFERENCE_RECIPE_SEGMENT
                        && u16::from_le_bytes([payload[8], payload[9]]) == section
                })
                .map(|(_, _, _, payload)| payload.len() - SEGMENT_HEADER_SIZE)
                .sum()
        };
        assert_eq!(section_len(SECTION_NODES) as u64, node_count * NODE_RECORD_SIZE as u64);
        assert_eq!(section_len(SECTION_VECTOR_INDEX) as u64, vector_count * VECTOR_INDEX_SIZE as u64);
    }

    #[test]
    fn tiny_window_spills_into_many_segments() {
        let b = comprehensive();
        // A one-byte window forces one segment per byte of every section.
        let records = serialize(&b, 1).unwrap();
        let segments = records
            .iter()
            .filter(|(kind, ..)| *kind == RECORD_KIND_REFERENCE_RECIPE_SEGMENT)
            .count();
        // Far more than the five-section minimum; every segment is header+1 byte.
        assert!(segments > 5);
        for (kind, _, _, payload) in &records {
            if *kind == RECORD_KIND_REFERENCE_RECIPE_SEGMENT {
                assert_eq!(payload.len(), SEGMENT_HEADER_SIZE + 1);
            }
        }
        assert_round_trips(&b, 1);
    }

    // --- Bidirectional cross-language fixture contract -------------------

    /// The exact graph the committed TS-encoded fixture
    /// (`reference-transaction-wasm32.bin`, proven in `reference_transaction`'s
    /// `decodes_real_encoder_fixture_field_for_field`) reconstructs. Building it
    /// here, serializing with the RUST encoder, and decoding to the SAME graph
    /// proves the Rust encoder and the real TS encoder are contract-equivalent
    /// through the shared decoder — the bidirectional wire contract.
    fn fixture_builder() -> ReferenceGraphBuilder {
        let mut b = ReferenceGraphBuilder::begin();
        let s = b.claim_gc().unwrap(); // 1
        let a = b.claim_gc().unwrap(); // 2
        let e = b.claim_gc().unwrap(); // 3
        assert_eq!(b.intern_externref(9).unwrap(), 4);
        assert_eq!(b.intern_i31(-17).unwrap(), 5);
        assert_eq!(b.intern_funcref(7, 0).unwrap(), 6);
        assert_eq!(b.intern_static_root(6, 0).unwrap(), 7);
        assert_eq!(b.intern_i31(MAX_I31).unwrap(), 8);
        assert_eq!(b.intern_i31(MIN_I31).unwrap(), 9);
        assert_eq!(b.intern_externref(0xffff_ffff).unwrap(), 10);

        b.define_gc(s, 7, 2, 12, AggregateKind::Struct, &[0x78, 0x56, 0x34, 0x12], &[2, 5, 3], None)
            .unwrap();
        b.define_gc(a, 7, 3, 13, AggregateKind::Array, &[0xaa, 0xbb], &[1, 3], None)
            .unwrap();
        b.define_gc(e, 7, 5, 15, AggregateKind::Exnref, &[0, 1, 2, 3, 4, 5, 6, 7], &[1, 5], None)
            .unwrap();

        for entries in [vec![1u32, 2, 3], vec![4, 6], vec![8, 9, 10, 5]] {
            let h = b.begin_vector().unwrap();
            for id in entries {
                b.append_vector(h, id).unwrap();
            }
            b.finish_vector(h).unwrap();
        }
        b
    }

    #[test]
    fn rust_encoder_output_matches_the_ts_fixture_graph() {
        let b = fixture_builder();
        let decoded = decode(&serialize(&b, 32).unwrap()).unwrap();
        // Field-for-field: the same 11 nodes, 3 vectors, and intern index the TS
        // fixture decodes to.
        assert_eq!(decoded.nodes.len(), 11);
        assert_eq!(decoded.vectors, vec![vec![], vec![1, 2, 3], vec![4, 6], vec![8, 9, 10, 5]]);
        assert_eq!(decoded.vector_intern.ordinals(&vector_intern_key(&[1, 2, 3])), &[1]);
        assert_eq!(decoded.vector_intern.ordinals(&vector_intern_key(&[4, 6])), &[2]);
        assert_eq!(decoded.vector_intern.ordinals(&vector_intern_key(&[8, 9, 10, 5])), &[3]);
        assert_eq!(decoded, expected(&b));
        // The tiny 32-byte window and a single-segment window agree.
        assert_eq!(decoded, decode(&serialize(&b, 1 << 16).unwrap()).unwrap());
    }

    // --- Adversarial: reject bad input without panicking -----------------

    #[test]
    fn rejects_zero_owner() {
        assert_eq!(ReferenceSegmentsWriter::new(0, 64).map(|_| ()), Err(Errno::EINVAL));
    }

    #[test]
    fn rejects_invalid_segment_window() {
        assert_eq!(ReferenceSegmentsWriter::new(OWNER, 0).map(|_| ()), Err(Errno::EINVAL));
    }

    #[test]
    fn rejects_serializing_a_pending_gc_graph() {
        let mut b = ReferenceGraphBuilder::begin();
        b.claim_gc().unwrap(); // never defined
        assert_eq!(serialize(&b, 64).map(|_| ()), Err(Errno::EINVAL));
    }

    #[test]
    fn rejects_out_of_domain_i31() {
        let mut b = ReferenceGraphBuilder::begin();
        assert_eq!(b.intern_i31(0x4000_0000).map(|_| ()), Err(Errno::EINVAL));
        assert_eq!(b.intern_i31(-0x4000_0001).map(|_| ()), Err(Errno::EINVAL));
    }

    #[test]
    fn rejects_zero_externref_handle() {
        let mut b = ReferenceGraphBuilder::begin();
        assert_eq!(b.intern_externref(0).map(|_| ()), Err(Errno::EINVAL));
    }

    #[test]
    fn rejects_gc_edge_naming_missing_recipe() {
        let mut b = ReferenceGraphBuilder::begin();
        let s = b.claim_gc().unwrap();
        // Edge 99 names a recipe that does not exist.
        assert_eq!(
            b.define_gc(s, 0, 0, 0, AggregateKind::Struct, &[], &[99], None).map(|_| ()),
            Err(Errno::EINVAL)
        );
    }

    #[test]
    fn rejects_empty_vector() {
        let mut b = ReferenceGraphBuilder::begin();
        let h = b.begin_vector().unwrap();
        assert_eq!(b.finish_vector(h).map(|_| ()), Err(Errno::EINVAL));
    }

    #[test]
    fn provenance_is_validated_but_not_serialized() {
        // Provenance references must name existing recipes, but they never change
        // the wire node record, so the graph round-trips identically with it.
        let mut b = ReferenceGraphBuilder::begin();
        let f = b.intern_funcref(1, 1).unwrap();
        let s = b.claim_gc().unwrap();
        b.define_gc(
            s,
            2,
            3,
            4,
            AggregateKind::Struct,
            &[9, 9],
            &[f],
            Some(GcProvenance { reference_ids: vec![f] }),
        )
        .unwrap();
        assert_round_trips(&b, 1 << 16);

        // A provenance reference to a missing recipe is rejected.
        let mut bad = ReferenceGraphBuilder::begin();
        let g = bad.claim_gc().unwrap();
        assert_eq!(
            bad.define_gc(
                g,
                0,
                0,
                0,
                AggregateKind::Struct,
                &[],
                &[],
                Some(GcProvenance { reference_ids: vec![42] }),
            )
            .map(|_| ()),
            Err(Errno::EINVAL)
        );
    }

    #[test]
    fn sink_failure_propagates_its_own_errno() {
        let b = comprehensive();
        let writer = ReferenceSegmentsWriter::new(OWNER, 1 << 16).unwrap();
        // A sink that fails on the first record must surface ENOMEM, not EINVAL.
        let mut sink = |_k: u16, _a: u32, _o: u32, _p: &[u8]| Err(Errno::ENOMEM);
        assert_eq!(writer.write(&mut sink, &b), Err(Errno::ENOMEM));
    }

    // --- Fuzz: random small graphs never panic and always round-trip -----

    /// A tiny xorshift PRNG (no external crate), mirroring the deterministic
    /// sweep style of `fuzz_sweep_over_minimal_encode_never_panics`.
    struct Rng(u64);
    impl Rng {
        fn next(&mut self) -> u64 {
            let mut x = self.0;
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            self.0 = x;
            x
        }
        fn below(&mut self, bound: u32) -> u32 {
            if bound == 0 {
                0
            } else {
                (self.next() % bound as u64) as u32
            }
        }
    }

    fn random_graph(rng: &mut Rng) -> ReferenceGraphBuilder {
        let mut b = ReferenceGraphBuilder::begin();
        let mut claimed: Vec<u32> = Vec::new();
        let node_ops = 1 + rng.below(12);
        for _ in 0..node_ops {
            match rng.below(6) {
                0 => {
                    b.intern_funcref(rng.below(8), rng.below(8)).unwrap();
                }
                1 => {
                    b.intern_externref(1 + rng.below(1000)).unwrap();
                }
                2 => {
                    let v = (rng.below(0x8000_0000) as i32).clamp(MIN_I31, MAX_I31);
                    b.intern_i31(v).unwrap();
                }
                3 => {
                    b.intern_static_root(rng.below(8), rng.below(8)).unwrap();
                }
                _ => {
                    claimed.push(b.claim_gc().unwrap());
                }
            }
        }
        // Define every claimed GC with edges into existing recipes.
        let node_count = b.nodes().len() as u32;
        for &id in &claimed {
            let kind = match rng.below(3) {
                0 => AggregateKind::Struct,
                1 => AggregateKind::Array,
                _ => AggregateKind::Exnref,
            };
            let edge_n = rng.below(4);
            let edges: Vec<u32> = (0..edge_n).map(|_| rng.below(node_count)).collect();
            let scalar_n = rng.below(6);
            let scalars: Vec<u8> = (0..scalar_n).map(|_| rng.below(256) as u8).collect();
            b.define_gc(id, rng.below(8), rng.below(8), rng.below(8), kind, &scalars, &edges, None)
                .unwrap();
        }
        // A few random non-empty vectors.
        let node_count = b.nodes().len() as u32;
        for _ in 0..rng.below(4) {
            let h = b.begin_vector().unwrap();
            let len = 1 + rng.below(4);
            for _ in 0..len {
                b.append_vector(h, rng.below(node_count)).unwrap();
            }
            b.finish_vector(h).unwrap();
        }
        b
    }

    #[test]
    fn fuzz_random_graphs_never_panic_and_round_trip() {
        let mut rng = Rng(0x1234_5678_9abc_def0);
        for _ in 0..400 {
            let b = random_graph(&mut rng);
            // Vary the segment window across trials, including tiny windows.
            let window = 1 + (rng.below(80) as usize);
            let records = serialize(&b, window).expect("serialize");
            let decoded = decode(&records).expect("decode");
            assert_eq!(decoded, expected(&b));
        }
    }
}
