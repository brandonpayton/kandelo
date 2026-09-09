//! LIVE segmented fork reference transaction decode (KFRV + KFRS).
//!
//! Ported from `decodeSegmentedForkReferenceTransaction` in
//! `host/src/fork-reference-segments.ts` (its `validateReferenceSemantics` +
//! `materializeReferenceGraph` + `materializeReferenceVectors` half), on top of
//! the segment-reassembly framing in `reference_segments`. Together they
//! reproduce the production `DecodedSegmentedForkReferenceTransaction` that a
//! fresh fork child reconstructs from the parent's serialized capture: the whole
//! process reference-recipe graph, the interned reference vectors, and the
//! canonical vector intern index.
//!
//! This is the FOUNDATIONAL, largest slice of Phase 6 D6 (reference/exception/GC
//! forks). Where `reference_recipes` decodes the standalone KFRR recipe image,
//! this module decodes the LIVE transaction: the graph and vectors are streamed
//! into the fork module-state (KFMS) arena as KFRS segment records and committed
//! by a single KFRV manifest. It reuses the `reference_recipes` node types
//! (`ReferenceRecipeNode` / `ReferenceRecipeEntry`) — the same discriminated
//! reference-value description — so the two decoders share one graph vocabulary.
//!
//! Output shape vs the TS `DecodedSegmentedForkReferenceTransaction`:
//!   * `graph.nodes`  -> `nodes`: canonical entries `0..node_count`, node id `i`
//!     at index `i`, each reusing `reference_recipes::ReferenceRecipeNode`.
//!   * `graph.roots`  -> `roots`: always EMPTY. KFRV carries no root vector;
//!     recipe ids are direct roots named by frames/globals/tables, so the
//!     transaction never materializes a redundant all-node root list (mirrors
//!     `materializeReferenceGraph`'s `roots: []`).
//!   * `vectors`      -> `vectors`: index 0 is the canonical empty-vector
//!     sentinel; ordinals `1..=vector_count` are the interned reference vectors.
//!   * `vectorIntern` -> `vector_intern`: the canonical hash-key -> ordinals
//!     index the child's `loadGc` replay consults to dedup codec vectors.
//!   * `identity`     -> (deferred): the TS `Object.freeze({})` adoption token
//!     carries no wire bytes and is a live object-identity proof, not a decode
//!     artifact; the reconstruction drive (D6.1+) owns adoption identity.
//!
//! This slice is the PURE `&[u8] -> graph` decode only. The LIVE materialization
//! half is the reconstruction drive (Phase 6 D6.1+, F5/F6, completed): the
//! injected binder and the pre-existing JS drive-order (`materializeTypedGraph`)
//! walk this graph and mint/publish real reference identities directly — a
//! funcref/static-root resolve is a wasm `table.get`, and the externref round
//! trip collapses into the injected binder calling the single residual host
//! import `resolve_externref(handle) -> externref` (M2). No separate
//! `ForkHostCapabilities` engine-floor trait/import seam was needed for this;
//! an earlier speculative version of that seam existed
//! (`crates/fork-module/src/host_capabilities.rs`) but was never wired to any
//! guest on any host and was deleted (H3, 2026-09-06). Here we only decode the
//! bytes into the validated graph the drive consumes. Every framing or
//! consistency violation yields `Err(Errno::EINVAL)`; the function never
//! panics.

use wasm_posix_shared::Errno;

use alloc::collections::BTreeMap;
use alloc::vec::Vec;

use crate::reference_recipes::{ReferenceRecipeEntry, ReferenceRecipeNode};
use crate::reference_segments::{
    parse, ParsedTransaction, ReferenceTransactionRecord, NODE_RECORD_SIZE, VECTOR_INDEX_SIZE,
};

const MAX_U32: u64 = 0xffff_ffff;

// Node kind discriminants; mirror the TS `WireNodeKind` const enum. Shared with
// `reference_recipes` (same wire vocabulary).
const KIND_NULL: u8 = 0;
const KIND_FUNCREF: u8 = 1;
const KIND_EXTERNREF: u8 = 2;
const KIND_EXNREF: u8 = 3;
const KIND_I31: u8 = 4;
const KIND_STRUCT: u8 = 5;
const KIND_ARRAY: u8 = 6;
const KIND_STATIC_ROOT: u8 = 7;

const MIN_I31: i32 = -0x4000_0000;
const MAX_I31: i32 = 0x3fff_ffff;

/// Canonical intern key for one reference vector. Mirrors the parsed form of the
/// TS `forkReferenceVectorInternKey` string `"${length}:${first}:${second}"`:
/// the vector length plus a two-word FNV-shaped hash of its recipe ids. Two
/// vectors with the same key are candidate duplicates the decoder then compares
/// entry-for-entry.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct VectorInternKey {
    pub length: u32,
    pub first: u32,
    pub second: u32,
}

/// Canonical hash key for one reference vector. Mirrors
/// `forkReferenceVectorInternKey` in `host/src/fork-reference-segments.ts` bit
/// for bit (`Math.imul` -> `wrapping_mul`, `>>> 0` -> `u32`, `>>> 13` ->
/// logical shift, the 16-bit rotate is `rotate_left(16)`).
pub fn vector_intern_key(vector: &[u32]) -> VectorInternKey {
    let length = vector.len() as u32;
    let mut first = 0x811c_9dc5u32 ^ length;
    let mut second = 0x9e37_79b9u32 ^ length;
    for &value in vector {
        first = (first ^ value).wrapping_mul(0x0100_0193);
        let rotated = value.rotate_left(16);
        second = (second ^ rotated).wrapping_mul(0x85eb_ca6b);
        second ^= first >> 13;
    }
    VectorInternKey {
        length,
        first,
        second,
    }
}

/// The canonical vector intern index: hash key -> ordinals (ascending). Mirrors
/// the TS `ForkReferenceVectorInternIndex`. A fresh child's `loadGc` replay
/// consults this to reuse a canonical reference-vector ordinal instead of
/// appending a duplicate.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct VectorInternIndex {
    buckets: BTreeMap<VectorInternKey, Vec<u32>>,
}

impl VectorInternIndex {
    /// Ordinals sharing `key`, ascending; empty if none. Mirrors a TS
    /// `vectorIntern.get(key) ?? []` lookup.
    pub fn ordinals(&self, key: &VectorInternKey) -> &[u32] {
        self.buckets.get(key).map(Vec::as_slice).unwrap_or(&[])
    }

    /// Number of distinct hash keys.
    pub fn key_count(&self) -> usize {
        self.buckets.len()
    }

    /// True when no vector has been interned (only the empty sentinel exists).
    pub fn is_empty(&self) -> bool {
        self.buckets.is_empty()
    }

    /// Iterate the `(key, ordinals)` buckets in key order.
    pub fn iter(&self) -> impl Iterator<Item = (&VectorInternKey, &[u32])> {
        self.buckets.iter().map(|(key, ords)| (key, ords.as_slice()))
    }

    /// Append `ordinal` to `key`'s bucket (creating it if absent). Mirrors
    /// `indexForkReferenceVector` in `host/src/fork-reference-segments.ts`: the
    /// replay data-feed (`reference_feed`) interns a newly appended GC reference
    /// vector under its canonical hash key so a later identical vector dedups to
    /// the same ordinal. Ordinals accumulate in append (ascending) order.
    pub fn push_ordinal(&mut self, key: VectorInternKey, ordinal: u32) {
        self.buckets.entry(key).or_default().push(ordinal);
    }
}

/// The fully decoded LIVE reference transaction. Mirrors the TS
/// `DecodedSegmentedForkReferenceTransaction`; see the module doc comment for the
/// field-by-field correspondence and what is deferred.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SegmentedReferenceTransaction {
    /// Always empty: KFRV carries no root vector (recipe ids are direct roots).
    pub roots: Vec<u32>,
    /// Canonical graph entries, node id `i` at index `i` (`0..node_count`).
    pub nodes: Vec<ReferenceRecipeEntry>,
    /// Interned reference vectors; index 0 is the empty-vector sentinel.
    pub vectors: Vec<Vec<u32>>,
    /// Canonical hash-key -> ordinals intern index.
    pub vector_intern: VectorInternIndex,
}

/// Sequential cursor over one reassembled section's contiguous bytes. Mirrors
/// the read contract of the TS `SegmentedSectionReader` (`readInto` / `readU32`
/// / `requireEnd`) collapsed onto an already-concatenated slice.
struct SectionReader<'a> {
    bytes: &'a [u8],
    pos: usize,
}

impl<'a> SectionReader<'a> {
    fn new(bytes: &'a [u8]) -> Self {
        SectionReader { bytes, pos: 0 }
    }

    fn read_into(&mut self, out: &mut [u8]) -> Result<(), Errno> {
        let end = self.pos.checked_add(out.len()).ok_or(Errno::EINVAL)?;
        let slice = self.bytes.get(self.pos..end).ok_or(Errno::EINVAL)?;
        out.copy_from_slice(slice);
        self.pos = end;
        Ok(())
    }

    fn read_u32(&mut self) -> Result<u32, Errno> {
        let mut word = [0u8; 4];
        self.read_into(&mut word)?;
        Ok(u32::from_le_bytes(word))
    }

    fn require_end(&self) -> Result<(), Errno> {
        if self.pos == self.bytes.len() {
            Ok(())
        } else {
            Err(Errno::EINVAL)
        }
    }
}

/// One decoded 48-byte node header. Mirrors the TS `DecodedNodeHeader`.
struct NodeHeader {
    kind: u8,
    first: u32,
    second: u32,
    third: u32,
    edge_start: u64,
    edge_count: u64,
    scalar_start: u64,
    scalar_length: u64,
}

/// Decode a node header from a 48-byte record. Mirrors the TS `decodeNodeHeader`.
fn decode_node_header(record: &[u8]) -> Result<NodeHeader, Errno> {
    // record is exactly NODE_RECORD_SIZE bytes by construction.
    if record[1] != 0 || u16::from_le_bytes([record[2], record[3]]) != 0 {
        return Err(Errno::EINVAL); // nonzero flags or reserved fields
    }
    let kind = record[0];
    if kind > KIND_STATIC_ROOT {
        return Err(Errno::EINVAL); // unknown kind
    }
    let u32_at = |off: usize| u32::from_le_bytes([record[off], record[off + 1], record[off + 2], record[off + 3]]);
    let u64_at = |off: usize| {
        u64::from_le_bytes([
            record[off],
            record[off + 1],
            record[off + 2],
            record[off + 3],
            record[off + 4],
            record[off + 5],
            record[off + 6],
            record[off + 7],
        ])
    };
    Ok(NodeHeader {
        kind,
        first: u32_at(4),
        second: u32_at(8),
        third: u32_at(12),
        edge_start: u64_at(16),
        edge_count: u64_at(24),
        scalar_start: u64_at(32),
        scalar_length: u64_at(40),
    })
}

/// True for the aggregate kinds that name edge/scalar ranges.
fn is_aggregate(kind: u8) -> bool {
    kind == KIND_EXNREF || kind == KIND_STRUCT || kind == KIND_ARRAY
}

/// Combine the two 32-bit words into an externref broker handle (`1..=2^32-1`).
/// Mirrors the TS `decodeHandle`.
fn decode_handle(first: u32, second: u32) -> Result<u32, Errno> {
    let handle = ((second as u64) << 32) | (first as u64);
    if handle == 0 || handle > MAX_U32 {
        return Err(Errno::EINVAL);
    }
    Ok(handle as u32)
}

/// Validate one node header against the canonical append cursors and per-kind
/// scalar-field rules. Mirrors the TS `validateNodeHeader` (with `decodeHandle`
/// and the i31 range check folded in).
fn validate_node_header(
    header: &NodeHeader,
    id: u64,
    expected_edge_start: u64,
    expected_scalar_start: u64,
) -> Result<(), Errno> {
    if is_aggregate(header.kind) {
        if header.edge_start != expected_edge_start || header.scalar_start != expected_scalar_start {
            return Err(Errno::EINVAL); // noncanonical edge or scalar start
        }
        if header.edge_count > MAX_U32 || header.scalar_length > MAX_U32 {
            return Err(Errno::EINVAL); // aggregate length exceeds u32
        }
    } else if header.edge_start != 0
        || header.edge_count != 0
        || header.scalar_start != 0
        || header.scalar_length != 0
    {
        return Err(Errno::EINVAL); // scalar record declares aggregate data
    }

    match header.kind {
        KIND_NULL => {
            if id != 0 || header.first != 0 || header.second != 0 || header.third != 0 {
                return Err(Errno::EINVAL); // not the canonical null recipe
            }
        }
        KIND_FUNCREF | KIND_STATIC_ROOT => {
            if header.third != 0 {
                return Err(Errno::EINVAL); // reserved scalar field is nonzero
            }
        }
        KIND_EXTERNREF => {
            decode_handle(header.first, header.second)?;
            if header.third != 0 {
                return Err(Errno::EINVAL); // reserved scalar field is nonzero
            }
        }
        KIND_I31 => {
            if header.second != 0 || header.third != 0 {
                return Err(Errno::EINVAL); // reserved scalar field is nonzero
            }
            let value = header.first as i32;
            if !(MIN_I31..=MAX_I31).contains(&value) {
                return Err(Errno::EINVAL); // i31 payload out of domain
            }
        }
        _ => {} // aggregate kinds validated above
    }
    Ok(())
}

/// Build the decoded node from its validated header, edges, and scalar bytes.
/// Mirrors the TS `decodeRecipeNode`.
fn build_recipe_node(
    header: &NodeHeader,
    edges: Vec<u32>,
    scalars: Vec<u8>,
) -> Result<ReferenceRecipeNode, Errno> {
    Ok(match header.kind {
        KIND_NULL => ReferenceRecipeNode::Null,
        KIND_FUNCREF => ReferenceRecipeNode::Funcref {
            module_activation: header.first,
            function_ordinal: header.second,
        },
        KIND_EXTERNREF => ReferenceRecipeNode::Externref {
            handle: decode_handle(header.first, header.second)?,
        },
        KIND_EXNREF => ReferenceRecipeNode::Exnref {
            module_activation: header.first,
            tag_ordinal: header.second,
            layout_id: header.third,
            scalars,
            payloads: edges,
        },
        KIND_I31 => ReferenceRecipeNode::I31 {
            value: header.first as i32,
        },
        KIND_STRUCT => ReferenceRecipeNode::Struct {
            module_activation: header.first,
            type_ordinal: header.second,
            layout_id: header.third,
            scalars,
            fields: edges,
        },
        KIND_ARRAY => ReferenceRecipeNode::Array {
            module_activation: header.first,
            type_ordinal: header.second,
            layout_id: header.third,
            scalars,
            elements: edges,
        },
        KIND_STATIC_ROOT => ReferenceRecipeNode::StaticRoot {
            module_activation: header.first,
            static_root_ordinal: header.second,
        },
        _ => return Err(Errno::EINVAL),
    })
}

/// Validate and materialize the reference graph. Folds the TS
/// `validateNodeSemantics` and `materializeReferenceGraph` into one pass over the
/// node, edge, and scalar sections; the observable result is identical.
fn decode_nodes(parsed: &ParsedTransaction) -> Result<Vec<ReferenceRecipeEntry>, Errno> {
    let node_count = parsed.manifest.node_count;
    let mut node_reader = SectionReader::new(&parsed.sections[0]);
    let mut edge_reader = SectionReader::new(&parsed.sections[1]);
    let mut scalar_reader = SectionReader::new(&parsed.sections[2]);
    let mut record = [0u8; NODE_RECORD_SIZE];
    let mut expected_edge_start: u64 = 0;
    let mut expected_scalar_start: u64 = 0;
    let mut nodes: Vec<ReferenceRecipeEntry> = Vec::new();

    let mut id: u64 = 0;
    while id < node_count {
        node_reader.read_into(&mut record)?;
        let header = decode_node_header(&record)?;
        validate_node_header(&header, id, expected_edge_start, expected_scalar_start)?;

        let edge_count = usize::try_from(header.edge_count).map_err(|_| Errno::EINVAL)?;
        let mut edges: Vec<u32> = Vec::with_capacity(edge_count);
        for _ in 0..edge_count {
            let recipe_id = edge_reader.read_u32()?;
            if recipe_id as u64 >= node_count {
                return Err(Errno::EINVAL); // edge names a missing recipe
            }
            edges.push(recipe_id);
        }

        let scalar_length = usize::try_from(header.scalar_length).map_err(|_| Errno::EINVAL)?;
        let mut scalars: Vec<u8> = alloc::vec![0u8; scalar_length];
        scalar_reader.read_into(&mut scalars)?;

        let node = build_recipe_node(&header, edges, scalars)?;
        // id < node_count <= 2^32, so the cast is lossless.
        nodes.push(ReferenceRecipeEntry {
            id: id as u32,
            node,
        });

        expected_edge_start = expected_edge_start
            .checked_add(header.edge_count)
            .ok_or(Errno::EINVAL)?;
        expected_scalar_start = expected_scalar_start
            .checked_add(header.scalar_length)
            .ok_or(Errno::EINVAL)?;
        id += 1;
    }
    node_reader.require_end()?;
    edge_reader.require_end()?;
    scalar_reader.require_end()?;
    Ok(nodes)
}

/// Validate and materialize the interned reference vectors and their intern
/// index. Folds the TS `validateVectorSemantics` and `materializeReferenceVectors`
/// into one pass over the vector-index and vector-entry sections.
fn decode_vectors(
    parsed: &ParsedTransaction,
) -> Result<(Vec<Vec<u32>>, VectorInternIndex), Errno> {
    let node_count = parsed.manifest.node_count;
    let vector_count = parsed.manifest.vector_count;
    let mut index_reader = SectionReader::new(&parsed.sections[3]);
    let mut entry_reader = SectionReader::new(&parsed.sections[4]);

    // Index 0 is the canonical empty-vector sentinel.
    let mut vectors: Vec<Vec<u32>> = Vec::new();
    vectors.push(Vec::new());
    let mut intern = VectorInternIndex::default();
    let mut expected_start: u64 = 0;
    let mut index_bytes = [0u8; VECTOR_INDEX_SIZE];

    let mut ordinal: u64 = 1;
    while ordinal <= vector_count {
        index_reader.read_into(&mut index_bytes)?;
        let start = u64::from_le_bytes([
            index_bytes[0],
            index_bytes[1],
            index_bytes[2],
            index_bytes[3],
            index_bytes[4],
            index_bytes[5],
            index_bytes[6],
            index_bytes[7],
        ]);
        let length64 = u64::from_le_bytes([
            index_bytes[8],
            index_bytes[9],
            index_bytes[10],
            index_bytes[11],
            index_bytes[12],
            index_bytes[13],
            index_bytes[14],
            index_bytes[15],
        ]);
        if start != expected_start {
            return Err(Errno::EINVAL); // noncanonical vector start
        }
        if length64 == 0 || length64 > MAX_U32 {
            return Err(Errno::EINVAL); // invalid vector length
        }
        let length = length64 as usize;
        let mut vector: Vec<u32> = Vec::with_capacity(length);
        for _ in 0..length {
            let recipe_id = entry_reader.read_u32()?;
            if recipe_id as u64 >= node_count {
                return Err(Errno::EINVAL); // entry names a missing recipe
            }
            vector.push(recipe_id);
        }

        let key = vector_intern_key(&vector);
        // Dedup: a same-hash predecessor with identical entries is a canonical
        // duplicate, which the encoder must never emit.
        for &previous in intern.ordinals(&key) {
            if vectors[previous as usize] == vector {
                return Err(Errno::EINVAL); // duplicates a canonical vector
            }
        }
        // ordinal <= vector_count <= 2^32-1, so the cast is lossless.
        intern
            .buckets
            .entry(key)
            .or_default()
            .push(ordinal as u32);
        vectors.push(vector);

        expected_start = expected_start.checked_add(length64).ok_or(Errno::EINVAL)?;
        ordinal += 1;
    }
    index_reader.require_end()?;
    entry_reader.require_end()?;
    Ok((vectors, intern))
}

/// Decode and validate a LIVE segmented fork reference transaction.
///
/// `records` is the full KFMS record stream (any kinds; only the reference
/// records are selected); `owner_id` is the process reference owner
/// (`WPK_FORK_REFERENCE_TRANSACTION_OWNER`). Returns the reassembled graph,
/// interned reference vectors, and canonical intern index — exactly what
/// `decodeSegmentedForkReferenceTransaction` produces, minus the runtime
/// `identity` adoption token (see the module doc comment). Any framing or
/// consistency violation yields `Err(Errno::EINVAL)`; the function never panics.
pub fn decode_segmented_reference_transaction(
    records: &[ReferenceTransactionRecord],
    owner_id: u32,
) -> Result<SegmentedReferenceTransaction, Errno> {
    let parsed = parse(records, owner_id)?;
    let nodes = decode_nodes(&parsed)?;
    let (vectors, vector_intern) = decode_vectors(&parsed)?;
    Ok(SegmentedReferenceTransaction {
        roots: Vec::new(),
        nodes,
        vectors,
        vector_intern,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::module_state::{decode_module_state, ModuleStateFormat};
    use alloc::vec;

    /// `WPK_FORK_REFERENCE_TRANSACTION_OWNER`.
    const OWNER: u32 = 1;
    /// KFMS record kinds carrying the transaction (mirrors the shared ABI).
    const KIND_REFERENCE_RECIPE: u16 = 2;
    const KIND_REFERENCE_RECIPE_SEGMENT: u16 = 12;

    // --- Cross-language fixture (emitted by the real TS arena + encoder) ---

    /// Bytes are the used prefix of the sealed KFMS root chunk that the REAL
    /// host arena (`ForkModuleStateArena`) produced after streaming the process
    /// reference graph through `appendSegmentedForkReferenceTransaction` with a
    /// deliberately tiny 32-byte segment window (so every section spills across
    /// many KFRS segments). Emitted by
    /// `crates/fork-codec/testdata/gen-reference-transaction-fixture.mts`. If the
    /// TS encoder and this decoder ever disagree on the KFRV/KFRS wire format,
    /// the field-for-field test below catches the drift.
    const FIXTURE: &[u8] = include_bytes!("../testdata/reference-transaction-wasm32.bin");
    const FIXTURE_ROOT: u64 = 65_536;
    const FIXTURE_CAPACITY: u64 = 65_536;

    fn wasm32_format() -> ModuleStateFormat {
        ModuleStateFormat {
            pointer_width: 4,
            chunk_header_size: 40,
        }
    }

    fn fixture_memory() -> Vec<u8> {
        let mut mem = vec![0u8; FIXTURE_ROOT as usize];
        mem.extend_from_slice(FIXTURE);
        mem.resize((FIXTURE_ROOT + FIXTURE_CAPACITY) as usize, 0);
        mem
    }

    /// Decode the KFMS envelope and lift every record into an owned
    /// `(kind, activation, owner, payload)` tuple, exactly the shape the TS
    /// decoder consumes. Includes the unrelated `Module` record so the reference
    /// decoder's kind filtering is exercised.
    fn owned_fixture_records() -> Vec<(u16, u32, u32, Vec<u8>)> {
        let mem = fixture_memory();
        let decoded = decode_module_state(&mem, FIXTURE_ROOT, &wasm32_format()).unwrap();
        decoded
            .records
            .iter()
            .map(|record| {
                let start = record.payload_offset as usize;
                let end = start + record.payload_size as usize;
                (
                    record.kind,
                    record.activation_id,
                    record.owner_id,
                    mem[start..end].to_vec(),
                )
            })
            .collect()
    }

    fn decode_owned(
        records: &[(u16, u32, u32, Vec<u8>)],
        owner: u32,
    ) -> Result<SegmentedReferenceTransaction, Errno> {
        let views: Vec<ReferenceTransactionRecord> = records
            .iter()
            .map(|(kind, activation, owner_id, payload)| ReferenceTransactionRecord {
                kind: *kind,
                activation_id: *activation,
                owner_id: *owner_id,
                payload,
            })
            .collect();
        decode_segmented_reference_transaction(&views, owner)
    }

    fn expected_fixture() -> SegmentedReferenceTransaction {
        let mut vector_intern = VectorInternIndex::default();
        vector_intern
            .buckets
            .insert(vector_intern_key(&[1, 2, 3]), vec![1]);
        vector_intern
            .buckets
            .insert(vector_intern_key(&[4, 6]), vec![2]);
        vector_intern
            .buckets
            .insert(vector_intern_key(&[8, 9, 10, 5]), vec![3]);
        SegmentedReferenceTransaction {
            roots: vec![],
            nodes: vec![
                ReferenceRecipeEntry {
                    id: 0,
                    node: ReferenceRecipeNode::Null,
                },
                ReferenceRecipeEntry {
                    id: 1,
                    node: ReferenceRecipeNode::Struct {
                        module_activation: 7,
                        type_ordinal: 2,
                        layout_id: 12,
                        scalars: vec![0x78, 0x56, 0x34, 0x12],
                        fields: vec![2, 5, 3],
                    },
                },
                ReferenceRecipeEntry {
                    id: 2,
                    node: ReferenceRecipeNode::Array {
                        module_activation: 7,
                        type_ordinal: 3,
                        layout_id: 13,
                        scalars: vec![0xaa, 0xbb],
                        elements: vec![1, 3],
                    },
                },
                ReferenceRecipeEntry {
                    id: 3,
                    node: ReferenceRecipeNode::Exnref {
                        module_activation: 7,
                        tag_ordinal: 5,
                        layout_id: 15,
                        scalars: vec![0, 1, 2, 3, 4, 5, 6, 7],
                        payloads: vec![1, 5],
                    },
                },
                ReferenceRecipeEntry {
                    id: 4,
                    node: ReferenceRecipeNode::Externref { handle: 9 },
                },
                ReferenceRecipeEntry {
                    id: 5,
                    node: ReferenceRecipeNode::I31 { value: -17 },
                },
                ReferenceRecipeEntry {
                    id: 6,
                    node: ReferenceRecipeNode::Funcref {
                        module_activation: 7,
                        function_ordinal: 0,
                    },
                },
                ReferenceRecipeEntry {
                    id: 7,
                    node: ReferenceRecipeNode::StaticRoot {
                        module_activation: 6,
                        static_root_ordinal: 0,
                    },
                },
                ReferenceRecipeEntry {
                    id: 8,
                    node: ReferenceRecipeNode::I31 { value: MAX_I31 },
                },
                ReferenceRecipeEntry {
                    id: 9,
                    node: ReferenceRecipeNode::I31 { value: MIN_I31 },
                },
                ReferenceRecipeEntry {
                    id: 10,
                    node: ReferenceRecipeNode::Externref {
                        handle: 0xffff_ffff,
                    },
                },
            ],
            vectors: vec![vec![], vec![1, 2, 3], vec![4, 6], vec![8, 9, 10, 5]],
            vector_intern,
        }
    }

    #[test]
    fn decodes_real_encoder_fixture_field_for_field() {
        let decoded = decode_owned(&owned_fixture_records(), OWNER).unwrap();
        assert_eq!(decoded, expected_fixture());
    }

    #[test]
    fn fixture_is_non_vacuous() {
        let decoded = decode_owned(&owned_fixture_records(), OWNER).unwrap();
        assert_eq!(decoded.nodes.len(), 11);
        assert!(decoded.roots.is_empty());
        assert_eq!(decoded.vectors.len(), 4);
        assert!(decoded.vectors[0].is_empty()); // empty sentinel
        assert_eq!(decoded.vector_intern.key_count(), 3);

        let has = |pred: fn(&ReferenceRecipeNode) -> bool| {
            decoded.nodes.iter().any(|entry| pred(&entry.node))
        };
        assert!(has(|node| matches!(node, ReferenceRecipeNode::Null)));
        assert!(has(|node| matches!(node, ReferenceRecipeNode::Funcref { .. })));
        assert!(has(|node| matches!(node, ReferenceRecipeNode::Externref { .. })));
        assert!(has(|node| matches!(node, ReferenceRecipeNode::Exnref { .. })));
        assert!(has(|node| matches!(node, ReferenceRecipeNode::I31 { .. })));
        assert!(has(|node| matches!(node, ReferenceRecipeNode::Struct { .. })));
        assert!(has(|node| matches!(node, ReferenceRecipeNode::Array { .. })));
        assert!(has(|node| matches!(node, ReferenceRecipeNode::StaticRoot { .. })));

        // Cycle: struct 1 -> array 2 -> struct 1.
        assert!(matches!(
            &decoded.nodes[1].node,
            ReferenceRecipeNode::Struct { fields, .. } if fields.contains(&2)
        ));
        assert!(matches!(
            &decoded.nodes[2].node,
            ReferenceRecipeNode::Array { elements, .. } if elements.contains(&1)
        ));
        // Alias: exnref 3 is shared by struct 1 and array 2.
        assert!(matches!(
            &decoded.nodes[1].node,
            ReferenceRecipeNode::Struct { fields, .. } if fields.contains(&3)
        ));
        assert!(matches!(
            &decoded.nodes[2].node,
            ReferenceRecipeNode::Array { elements, .. } if elements.contains(&3)
        ));
        // Domain boundaries survived.
        assert!(has(
            |node| matches!(node, ReferenceRecipeNode::I31 { value } if *value == MAX_I31)
        ));
        assert!(has(
            |node| matches!(node, ReferenceRecipeNode::I31 { value } if *value == MIN_I31)
        ));
        assert!(has(
            |node| matches!(node, ReferenceRecipeNode::Externref { handle } if *handle == 0xffff_ffff)
        ));

        // Every interned vector resolves to its ordinal.
        assert_eq!(decoded.vector_intern.ordinals(&vector_intern_key(&[1, 2, 3])), &[1]);
        assert_eq!(decoded.vector_intern.ordinals(&vector_intern_key(&[4, 6])), &[2]);
        assert_eq!(
            decoded.vector_intern.ordinals(&vector_intern_key(&[8, 9, 10, 5])),
            &[3]
        );
    }

    #[test]
    fn vector_intern_key_matches_ts_oracle() {
        // Exact numbers printed by the real TS `forkReferenceVectorInternKey`
        // in gen-reference-transaction-fixture.mts; this pins the FNV-shaped
        // port bit for bit across languages.
        assert_eq!(
            vector_intern_key(&[1, 2, 3]),
            VectorInternKey {
                length: 3,
                first: 360_928_434,
                second: 2_791_504_859,
            }
        );
        assert_eq!(
            vector_intern_key(&[4, 6]),
            VectorInternKey {
                length: 2,
                first: 3_413_224_557,
                second: 1_766_216_148,
            }
        );
        assert_eq!(
            vector_intern_key(&[8, 9, 10, 5]),
            VectorInternKey {
                length: 4,
                first: 926_514_547,
                second: 3_360_872_720,
            }
        );
    }

    #[test]
    fn ignores_unrelated_record_kinds() {
        // The fixture arena carries a Module record (kind 1) the decoder must
        // skip; a clean decode proves the kind filter works.
        let records = owned_fixture_records();
        assert!(records.iter().any(|(kind, ..)| *kind == 1));
        assert!(decode_owned(&records, OWNER).is_ok());
    }

    // --- Fixture-based ownership/framing negatives ------------------------

    #[test]
    fn rejects_wrong_owner() {
        assert_eq!(decode_owned(&owned_fixture_records(), 2), Err(Errno::EINVAL));
    }

    #[test]
    fn rejects_zero_owner() {
        assert_eq!(decode_owned(&owned_fixture_records(), 0), Err(Errno::EINVAL));
    }

    #[test]
    fn rejects_corrupt_manifest_magic() {
        let mut records = owned_fixture_records();
        let manifest = records
            .iter_mut()
            .find(|(kind, ..)| *kind == KIND_REFERENCE_RECIPE)
            .unwrap();
        manifest.3[0] ^= 0xff;
        assert_eq!(decode_owned(&records, OWNER), Err(Errno::EINVAL));
    }

    #[test]
    fn rejects_corrupt_segment_magic() {
        let mut records = owned_fixture_records();
        let segment = records
            .iter_mut()
            .find(|(kind, ..)| *kind == KIND_REFERENCE_RECIPE_SEGMENT)
            .unwrap();
        segment.3[0] ^= 0xff;
        assert_eq!(decode_owned(&records, OWNER), Err(Errno::EINVAL));
    }

    #[test]
    fn rejects_missing_manifest() {
        let records: Vec<_> = owned_fixture_records()
            .into_iter()
            .filter(|(kind, ..)| *kind != KIND_REFERENCE_RECIPE)
            .collect();
        assert_eq!(decode_owned(&records, OWNER), Err(Errno::EINVAL));
    }

    #[test]
    fn rejects_duplicate_manifest() {
        let mut records = owned_fixture_records();
        let manifest = records
            .iter()
            .find(|(kind, ..)| *kind == KIND_REFERENCE_RECIPE)
            .unwrap()
            .clone();
        records.push(manifest);
        assert_eq!(decode_owned(&records, OWNER), Err(Errno::EINVAL));
    }

    #[test]
    fn rejects_segment_after_manifest() {
        // Move the manifest ahead of the segments: the first segment then
        // follows the final manifest.
        let mut records = owned_fixture_records();
        let manifest_pos = records
            .iter()
            .position(|(kind, ..)| *kind == KIND_REFERENCE_RECIPE)
            .unwrap();
        let manifest = records.remove(manifest_pos);
        // Insert the manifest before the first reference segment.
        let first_segment = records
            .iter()
            .position(|(kind, ..)| *kind == KIND_REFERENCE_RECIPE_SEGMENT)
            .unwrap();
        records.insert(first_segment, manifest);
        assert_eq!(decode_owned(&records, OWNER), Err(Errno::EINVAL));
    }

    #[test]
    fn rejects_truncated_segment_payload() {
        let mut records = owned_fixture_records();
        let segment = records
            .iter_mut()
            .find(|(kind, ..)| *kind == KIND_REFERENCE_RECIPE_SEGMENT)
            .unwrap();
        segment.3.pop(); // one byte short of the declared data length
        assert_eq!(decode_owned(&records, OWNER), Err(Errno::EINVAL));
    }

    // --- Hand-built minimal transactions (targeted node/vector validation) -

    /// Build one 48-byte scalar (non-aggregate) node record.
    fn scalar_node(kind: u8, first: u32, second: u32, third: u32) -> [u8; NODE_RECORD_SIZE] {
        let mut record = [0u8; NODE_RECORD_SIZE];
        record[0] = kind;
        record[4..8].copy_from_slice(&first.to_le_bytes());
        record[8..12].copy_from_slice(&second.to_le_bytes());
        record[12..16].copy_from_slice(&third.to_le_bytes());
        record
    }

    /// Build one 48-byte aggregate node record naming an edge/scalar range.
    #[allow(clippy::too_many_arguments)]
    fn aggregate_node(
        kind: u8,
        first: u32,
        second: u32,
        third: u32,
        edge_start: u64,
        edge_count: u64,
        scalar_start: u64,
        scalar_length: u64,
    ) -> [u8; NODE_RECORD_SIZE] {
        let mut record = [0u8; NODE_RECORD_SIZE];
        record[0] = kind;
        record[4..8].copy_from_slice(&first.to_le_bytes());
        record[8..12].copy_from_slice(&second.to_le_bytes());
        record[12..16].copy_from_slice(&third.to_le_bytes());
        record[16..24].copy_from_slice(&edge_start.to_le_bytes());
        record[24..32].copy_from_slice(&edge_count.to_le_bytes());
        record[32..40].copy_from_slice(&scalar_start.to_le_bytes());
        record[40..48].copy_from_slice(&scalar_length.to_le_bytes());
        record
    }

    fn segment_record(section: u16, ordinal: u64, offset: u64, data: &[u8]) -> (u16, u32, u32, Vec<u8>) {
        let mut payload = vec![0u8; 40 + data.len()];
        payload[0..4].copy_from_slice(b"KFRS");
        payload[4..6].copy_from_slice(&2u16.to_le_bytes());
        payload[6..8].copy_from_slice(&40u16.to_le_bytes());
        payload[8..10].copy_from_slice(&section.to_le_bytes());
        payload[16..24].copy_from_slice(&ordinal.to_le_bytes());
        payload[24..32].copy_from_slice(&offset.to_le_bytes());
        payload[32..36].copy_from_slice(&(data.len() as u32).to_le_bytes());
        payload[40..].copy_from_slice(data);
        (KIND_REFERENCE_RECIPE_SEGMENT, 0, OWNER, payload)
    }

    fn manifest_record(
        segment_count: u64,
        node_count: u64,
        vector_count: u64,
        totals: [u64; 5],
    ) -> (u16, u32, u32, Vec<u8>) {
        let mut payload = vec![0u8; 96];
        payload[0..4].copy_from_slice(b"KFRV");
        payload[4..6].copy_from_slice(&2u16.to_le_bytes());
        payload[6..8].copy_from_slice(&96u16.to_le_bytes());
        payload[8..12].copy_from_slice(&1u32.to_le_bytes()); // sealed flag
        payload[12..16].copy_from_slice(&48u32.to_le_bytes()); // node record size
        payload[16..20].copy_from_slice(&16u32.to_le_bytes()); // vector index size
        payload[24..32].copy_from_slice(&segment_count.to_le_bytes());
        payload[32..40].copy_from_slice(&node_count.to_le_bytes());
        payload[40..48].copy_from_slice(&vector_count.to_le_bytes());
        let mut total_logical: u64 = 0;
        for (index, total) in totals.iter().enumerate() {
            payload[48 + index * 8..56 + index * 8].copy_from_slice(&total.to_le_bytes());
            total_logical += total;
        }
        payload[88..96].copy_from_slice(&total_logical.to_le_bytes());
        (KIND_REFERENCE_RECIPE, 0, OWNER, payload)
    }

    /// Encode a whole minimal transaction as owned records: one segment per
    /// non-empty section, then the manifest. `vectors` are the non-sentinel
    /// reference vectors.
    fn encode(
        node_records: &[[u8; NODE_RECORD_SIZE]],
        edges: &[u32],
        scalars: &[u8],
        vectors: &[&[u32]],
    ) -> Vec<(u16, u32, u32, Vec<u8>)> {
        let mut nodes_bytes = Vec::new();
        for record in node_records {
            nodes_bytes.extend_from_slice(record);
        }
        let mut edge_bytes = Vec::new();
        for edge in edges {
            edge_bytes.extend_from_slice(&edge.to_le_bytes());
        }
        let mut vector_index = Vec::new();
        let mut vector_entries = Vec::new();
        let mut start: u64 = 0;
        for vector in vectors {
            vector_index.extend_from_slice(&start.to_le_bytes());
            vector_index.extend_from_slice(&(vector.len() as u64).to_le_bytes());
            for recipe in *vector {
                vector_entries.extend_from_slice(&recipe.to_le_bytes());
            }
            start += vector.len() as u64;
        }
        let sections: [(u16, &[u8]); 5] = [
            (1, &nodes_bytes),
            (2, &edge_bytes),
            (3, scalars),
            (4, &vector_index),
            (5, &vector_entries),
        ];
        let mut records = Vec::new();
        let mut ordinal: u64 = 0;
        for (section, data) in sections {
            if !data.is_empty() {
                records.push(segment_record(section, ordinal, 0, data));
                ordinal += 1;
            }
        }
        let totals = [
            nodes_bytes.len() as u64,
            edge_bytes.len() as u64,
            scalars.len() as u64,
            vector_index.len() as u64,
            vector_entries.len() as u64,
        ];
        records.push(manifest_record(
            ordinal,
            node_records.len() as u64,
            vectors.len() as u64,
            totals,
        ));
        records
    }

    fn null_only() -> Vec<(u16, u32, u32, Vec<u8>)> {
        encode(&[scalar_node(KIND_NULL, 0, 0, 0)], &[], &[], &[])
    }

    #[test]
    fn decodes_minimal_null_transaction() {
        let decoded = decode_owned(&null_only(), OWNER).unwrap();
        assert_eq!(
            decoded,
            SegmentedReferenceTransaction {
                roots: vec![],
                nodes: vec![ReferenceRecipeEntry {
                    id: 0,
                    node: ReferenceRecipeNode::Null,
                }],
                vectors: vec![vec![]],
                vector_intern: VectorInternIndex::default(),
            }
        );
    }

    #[test]
    fn decodes_interned_vectors() {
        // node 0 null, node 1 a funcref so recipe id 1 is a valid vector entry.
        let records = encode(
            &[
                scalar_node(KIND_NULL, 0, 0, 0),
                scalar_node(KIND_FUNCREF, 7, 0, 0),
            ],
            &[],
            &[],
            &[&[1], &[0, 1]],
        );
        let decoded = decode_owned(&records, OWNER).unwrap();
        assert_eq!(decoded.vectors, vec![vec![], vec![1], vec![0, 1]]);
        assert_eq!(decoded.vector_intern.ordinals(&vector_intern_key(&[1])), &[1]);
        assert_eq!(decoded.vector_intern.ordinals(&vector_intern_key(&[0, 1])), &[2]);
    }

    #[test]
    fn rejects_unknown_node_kind() {
        let records = encode(&[scalar_node(99, 0, 0, 0)], &[], &[], &[]);
        assert_eq!(decode_owned(&records, OWNER), Err(Errno::EINVAL));
    }

    #[test]
    fn rejects_null_at_nonzero_id() {
        let records = encode(
            &[scalar_node(KIND_FUNCREF, 1, 0, 0), scalar_node(KIND_NULL, 0, 0, 0)],
            &[],
            &[],
            &[],
        );
        assert_eq!(decode_owned(&records, OWNER), Err(Errno::EINVAL));
    }

    #[test]
    fn rejects_zero_externref_handle() {
        let records = encode(&[scalar_node(KIND_EXTERNREF, 0, 0, 0)], &[], &[], &[]);
        assert_eq!(decode_owned(&records, OWNER), Err(Errno::EINVAL));
    }

    #[test]
    fn rejects_externref_handle_above_u32() {
        // A nonzero high word forces the combined handle past 2^32-1.
        let records = encode(&[scalar_node(KIND_EXTERNREF, 1, 1, 0)], &[], &[], &[]);
        assert_eq!(decode_owned(&records, OWNER), Err(Errno::EINVAL));
    }

    #[test]
    fn rejects_out_of_domain_i31() {
        let records = encode(&[scalar_node(KIND_I31, 0x4000_0000, 0, 0)], &[], &[], &[]);
        assert_eq!(decode_owned(&records, OWNER), Err(Errno::EINVAL));
    }

    #[test]
    fn rejects_nonzero_scalar_reserved_word() {
        // funcref third word must be zero.
        let records = encode(&[scalar_node(KIND_FUNCREF, 0, 0, 1)], &[], &[], &[]);
        assert_eq!(decode_owned(&records, OWNER), Err(Errno::EINVAL));
    }

    #[test]
    fn rejects_scalar_record_declaring_aggregate_data() {
        // A funcref with a nonzero edge count.
        let record = aggregate_node(KIND_FUNCREF, 0, 0, 0, 0, 1, 0, 0);
        let records = encode(&[record], &[0], &[], &[]);
        assert_eq!(decode_owned(&records, OWNER), Err(Errno::EINVAL));
    }

    #[test]
    fn rejects_edge_naming_missing_recipe() {
        // Struct at id 0 with one field edge to recipe 1, but only node 0 exists.
        let record = aggregate_node(KIND_STRUCT, 7, 2, 12, 0, 1, 0, 0);
        let records = encode(&[record], &[1], &[], &[]);
        assert_eq!(decode_owned(&records, OWNER), Err(Errno::EINVAL));
    }

    #[test]
    fn rejects_noncanonical_edge_start() {
        // Struct aggregate whose edge start (5) does not equal the append cursor.
        let record = aggregate_node(KIND_STRUCT, 7, 2, 12, 5, 1, 0, 0);
        let records = encode(&[record], &[0], &[], &[]);
        assert_eq!(decode_owned(&records, OWNER), Err(Errno::EINVAL));
    }

    #[test]
    fn rejects_noncanonical_vector_start() {
        let mut records = encode(
            &[scalar_node(KIND_NULL, 0, 0, 0)],
            &[],
            &[],
            &[&[0]],
        );
        // Corrupt the vector-index start word (section 4 segment) to 5.
        let index = records
            .iter_mut()
            .find(|(_, _, _, payload)| {
                payload.len() > 8 && &payload[0..4] == b"KFRS" && payload[8] == 4
            })
            .unwrap();
        index.3[40..48].copy_from_slice(&5u64.to_le_bytes());
        assert_eq!(decode_owned(&records, OWNER), Err(Errno::EINVAL));
    }

    #[test]
    fn rejects_zero_length_vector() {
        // Hand-emit a vector index entry declaring length 0.
        let mut vector_index = Vec::new();
        vector_index.extend_from_slice(&0u64.to_le_bytes()); // start
        vector_index.extend_from_slice(&0u64.to_le_bytes()); // length 0
        let node = scalar_node(KIND_NULL, 0, 0, 0);
        let mut records = vec![segment_record(1, 0, 0, &node)];
        records.push(segment_record(4, 1, 0, &vector_index));
        records.push(manifest_record(2, 1, 1, [48, 0, 0, 16, 0]));
        assert_eq!(decode_owned(&records, OWNER), Err(Errno::EINVAL));
    }

    #[test]
    fn rejects_vector_entry_naming_missing_recipe() {
        let records = encode(
            &[scalar_node(KIND_NULL, 0, 0, 0)],
            &[],
            &[],
            &[&[1]], // recipe 1 does not exist (only node 0)
        );
        assert_eq!(decode_owned(&records, OWNER), Err(Errno::EINVAL));
    }

    #[test]
    fn rejects_duplicate_canonical_vector() {
        let records = encode(
            &[scalar_node(KIND_NULL, 0, 0, 0)],
            &[],
            &[],
            &[&[0], &[0]], // two identical canonical vectors
        );
        assert_eq!(decode_owned(&records, OWNER), Err(Errno::EINVAL));
    }

    #[test]
    fn rejects_bad_segment_ordinal() {
        let mut records = null_only();
        let node_segment = records
            .iter_mut()
            .find(|(kind, ..)| *kind == KIND_REFERENCE_RECIPE_SEGMENT)
            .unwrap();
        node_segment.3[16..24].copy_from_slice(&9u64.to_le_bytes()); // wrong ordinal
        assert_eq!(decode_owned(&records, OWNER), Err(Errno::EINVAL));
    }

    #[test]
    fn rejects_manifest_total_mismatch() {
        let mut records = null_only();
        let manifest = records
            .iter_mut()
            .find(|(kind, ..)| *kind == KIND_REFERENCE_RECIPE)
            .unwrap();
        // Inflate the node-section total (offset 48) without changing the data.
        manifest.3[48..56].copy_from_slice(&96u64.to_le_bytes());
        assert_eq!(decode_owned(&records, OWNER), Err(Errno::EINVAL));
    }

    #[test]
    fn rejects_section_reordering() {
        // Emit the edges section (2) before the nodes section (1).
        let node = aggregate_node(KIND_STRUCT, 7, 2, 12, 0, 1, 0, 0);
        let edges = 0u32.to_le_bytes();
        let mut records = vec![
            segment_record(2, 0, 0, &edges),
            segment_record(1, 1, 0, &node),
        ];
        records.push(manifest_record(2, 1, 0, [48, 4, 0, 0, 0]));
        assert_eq!(decode_owned(&records, OWNER), Err(Errno::EINVAL));
    }

    // --- Panic-freedom on arbitrary bytes --------------------------------

    #[test]
    fn single_byte_corruptions_never_panic() {
        let base = owned_fixture_records();
        for record_index in 0..base.len() {
            for byte_index in 0..base[record_index].3.len() {
                let mut records = base.clone();
                records[record_index].3[byte_index] ^= 0xff;
                let _ = decode_owned(&records, OWNER);
            }
        }
    }

    #[test]
    fn arbitrary_payload_truncations_never_panic() {
        let base = owned_fixture_records();
        for record_index in 0..base.len() {
            let full = base[record_index].3.len();
            for len in 0..=full {
                let mut records = base.clone();
                records[record_index].3.truncate(len);
                let _ = decode_owned(&records, OWNER);
            }
        }
    }

    #[test]
    fn fuzz_sweep_over_minimal_encode_never_panics() {
        // Sweep node kind/first/second/third permutations plus a couple of
        // vectors; most are rejected, none may panic.
        for kind in 0u8..10 {
            for first in [0u32, 1, 0x4000_0000, 0xffff_ffff] {
                for second in [0u32, 1] {
                    let records = encode(
                        &[scalar_node(kind, first, second, 0)],
                        &[],
                        &[],
                        &[&[0]],
                    );
                    let _ = decode_owned(&records, OWNER);
                    // Also corrupt the whole record stream byte-wise lightly.
                    let mut corrupt = records.clone();
                    if let Some(last) = corrupt.last_mut()
                        && let Some(byte) = last.3.get_mut(4)
                    {
                        *byte = kind.wrapping_mul(31);
                    }
                    let _ = decode_owned(&corrupt, OWNER);
                }
            }
        }
    }
}
