//! Framing layer for the LIVE segmented fork reference transaction (KFRV + KFRS).
//!
//! Ported from the parse half of `decodeSegmentedForkReferenceTransaction` in
//! `host/src/fork-reference-segments.ts` (`parseSegmentedForkReferenceTransaction`,
//! `decodeManifest`, `decodeSegment`). This is the LIVE transaction layer that
//! the standalone KFRR recipe decoder (`reference_recipes`) explicitly deferred:
//! where KFRR is one self-contained `&[u8]` image, the production capture path
//! streams the process reference graph into the fork module-state (KFMS) arena
//! as a run of KFRS segment records — one logical section (nodes, edges,
//! scalars, vector index, vector entries) split across arbitrarily many bounded
//! segments — sealed by a single KFRV manifest record. `sealInto`
//! (`fork-reference-transaction.ts`) is the producer.
//!
//! The KFRV/KFRS framing constants are the shared-ABI mirror in
//! `crates/shared/src/lib.rs` (`WPK_FORK_REFERENCE_TRANSACTION_*` "KFRV",
//! `WPK_FORK_REFERENCE_SEGMENT_*` "KFRS", `WPK_FORK_REFERENCE_NODE_RECORD_SIZE`
//! = 48, `WPK_FORK_REFERENCE_VECTOR_INDEX_SIZE` = 16), unlike the TS-private KFRR
//! constants; this module reads them from `wasm_posix_shared::abi`.
//!
//! This layer validates and reassembles the transaction envelope: it selects the
//! reference records (by kind and process ownership), decodes and cross-checks
//! the single manifest against the observed segment stream, enforces per-section
//! contiguity (no gap, overlap, duplicate, or reordering), and concatenates each
//! section's segment payloads into one contiguous byte run. The graph/vector
//! SEMANTIC layer (node records, edges, scalars, interned vectors) lives in
//! `reference_transaction`, exactly as the TS decoder splits parse from
//! `validateReferenceSemantics`/`materialize*`.
//!
//! Reassembling each section into an owned `Vec<u8>` is the representational
//! (u32-bounded) decode, matching how `reference_recipes` decodes "under its
//! default representational u32 limits": a hostile u64 section total that would
//! not fit an in-memory buffer yields `Err(EINVAL)` rather than being
//! materialized. Every framing or consistency violation yields
//! `Err(Errno::EINVAL)`; the function never panics.

use wasm_posix_shared::abi;
use wasm_posix_shared::Errno;

use alloc::vec::Vec;

/// KFRV transaction manifest magic (`"KFRV"`, little-endian). Mirrors
/// `WPK_FORK_REFERENCE_TRANSACTION_MAGIC`.
const KFRV_MAGIC: u32 = le_magic(abi::WPK_FORK_REFERENCE_TRANSACTION_MAGIC);
/// KFRS segment record magic (`"KFRS"`, little-endian). Mirrors
/// `WPK_FORK_REFERENCE_SEGMENT_MAGIC`.
const KFRS_MAGIC: u32 = le_magic(abi::WPK_FORK_REFERENCE_SEGMENT_MAGIC);
/// Mirrors `WPK_FORK_REFERENCE_TRANSACTION_VERSION` (2). Both the manifest and
/// every segment carry this version.
const VERSION: u16 = abi::WPK_FORK_REFERENCE_TRANSACTION_VERSION;
/// Mirrors `WPK_FORK_REFERENCE_TRANSACTION_MANIFEST_SIZE` (96).
const MANIFEST_SIZE: usize = abi::WPK_FORK_REFERENCE_TRANSACTION_MANIFEST_SIZE as usize;
/// Mirrors `WPK_FORK_REFERENCE_SEGMENT_HEADER_SIZE` (40).
const SEGMENT_HEADER_SIZE: usize = abi::WPK_FORK_REFERENCE_SEGMENT_HEADER_SIZE as usize;
/// Mirrors `WPK_FORK_REFERENCE_NODE_RECORD_SIZE` (48).
pub(crate) const NODE_RECORD_SIZE: usize = abi::WPK_FORK_REFERENCE_NODE_RECORD_SIZE as usize;
/// Mirrors `WPK_FORK_REFERENCE_VECTOR_INDEX_SIZE` (16).
pub(crate) const VECTOR_INDEX_SIZE: usize = abi::WPK_FORK_REFERENCE_VECTOR_INDEX_SIZE as usize;
/// Mirrors `WPK_FORK_REFERENCE_SEGMENT_KNOWN_FLAGS` (0).
const SEGMENT_KNOWN_FLAGS: u16 = abi::WPK_FORK_REFERENCE_SEGMENT_KNOWN_FLAGS;
/// Mirrors `WPK_FORK_REFERENCE_TRANSACTION_FLAG_SEALED` (1).
const MANIFEST_FLAG_SEALED: u32 = abi::WPK_FORK_REFERENCE_TRANSACTION_FLAG_SEALED;
/// Mirrors `WPK_FORK_REFERENCE_TRANSACTION_KNOWN_FLAGS` (1).
const MANIFEST_KNOWN_FLAGS: u32 = abi::WPK_FORK_REFERENCE_TRANSACTION_KNOWN_FLAGS;

/// KFMS record kinds that carry this transaction. Mirrors the two
/// `ForkModuleStateRecordKind` values the TS decoder selects.
const RECORD_KIND_REFERENCE_RECIPE: u16 = abi::WPK_FORK_MODULE_STATE_RECORD_KIND_REFERENCE_RECIPE;
const RECORD_KIND_REFERENCE_RECIPE_SEGMENT: u16 =
    abi::WPK_FORK_MODULE_STATE_RECORD_KIND_REFERENCE_RECIPE_SEGMENT;

/// Section discriminants (`WPK_FORK_REFERENCE_SECTION_*`, 1..=5).
const SECTION_NODES: u16 = abi::WPK_FORK_REFERENCE_SECTION_NODES;
const SECTION_VECTOR_ENTRIES: u16 = abi::WPK_FORK_REFERENCE_SECTION_VECTOR_ENTRIES;
/// The five logical sections, indexed `section - 1`.
pub(crate) const SECTION_COUNT: usize = 5;

const MAX_U32: u64 = 0xffff_ffff;
/// Mirrors the TS `MAX_U32_DIRECTORY_LENGTH` (2^32): the exclusive-of-none upper
/// bound on the node count (a directory addressed by the complete u32 index
/// namespace holds up to 2^32 entries).
const MAX_U32_DIRECTORY_LENGTH: u64 = 0x1_0000_0000;

/// Compile-time little-endian fold of a four-byte ABI magic.
const fn le_magic(bytes: [u8; 4]) -> u32 {
    (bytes[0] as u32)
        | ((bytes[1] as u32) << 8)
        | ((bytes[2] as u32) << 16)
        | ((bytes[3] as u32) << 24)
}

/// One selected KFMS record view handed to the transaction decoder.
///
/// Mirrors the fields the TS `ForkModuleStateRecordView` exposes to
/// `decodeSegmentedForkReferenceTransaction`: the record kind, its process
/// ownership coordinates, and the raw payload bytes. The caller obtains these by
/// decoding the KFMS arena (see `module_state::decode_module_state`) and lending
/// each record's payload slice; the transaction decoder itself never sees the
/// arena framing. Non-reference record kinds may be present and are ignored.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ReferenceTransactionRecord<'a> {
    pub kind: u16,
    pub activation_id: u32,
    pub owner_id: u32,
    pub payload: &'a [u8],
}

/// The decoded KFRV manifest: the transaction commit point. Mirrors the TS
/// `ParsedReferenceManifest`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct ParsedManifest {
    pub segment_count: u64,
    /// `1..=2^32`. Kept as `u64` because the directory bound is 2^32 inclusive.
    pub node_count: u64,
    /// `0..=2^32-1`.
    pub vector_count: u64,
    /// Logical byte totals per section: nodes, edges, scalars, vector index,
    /// vector entries.
    pub totals: [u64; SECTION_COUNT],
}

/// The validated, reassembled transaction envelope: the manifest plus each
/// section's contiguous bytes (`sections[section - 1]`). Mirrors the TS
/// `ParsedSegmentedForkReferenceTransaction` after segment reassembly.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ParsedTransaction {
    pub manifest: ParsedManifest,
    pub sections: [Vec<u8>; SECTION_COUNT],
}

/// Bounds-checked little-endian `u16` read.
fn r_u16(bytes: &[u8], off: usize) -> Result<u16, Errno> {
    let end = off.checked_add(2).ok_or(Errno::EINVAL)?;
    let slice = bytes.get(off..end).ok_or(Errno::EINVAL)?;
    Ok(u16::from_le_bytes([slice[0], slice[1]]))
}

/// Bounds-checked little-endian `u32` read.
fn r_u32(bytes: &[u8], off: usize) -> Result<u32, Errno> {
    let end = off.checked_add(4).ok_or(Errno::EINVAL)?;
    let slice = bytes.get(off..end).ok_or(Errno::EINVAL)?;
    Ok(u32::from_le_bytes([slice[0], slice[1], slice[2], slice[3]]))
}

/// Bounds-checked little-endian `u64` read.
fn r_u64(bytes: &[u8], off: usize) -> Result<u64, Errno> {
    let end = off.checked_add(8).ok_or(Errno::EINVAL)?;
    let slice = bytes.get(off..end).ok_or(Errno::EINVAL)?;
    Ok(u64::from_le_bytes([
        slice[0], slice[1], slice[2], slice[3], slice[4], slice[5], slice[6], slice[7],
    ]))
}

/// Selected, validated, reassembled transaction. Mirrors the TS
/// `parseSegmentedForkReferenceTransaction`.
///
/// `records` is the full KFMS record stream (any kinds); only reference records
/// are selected. `owner_id` is the process reference owner
/// (`WPK_FORK_REFERENCE_TRANSACTION_OWNER`). Any framing or consistency
/// violation yields `Err(Errno::EINVAL)`; never panics.
pub(crate) fn parse(
    records: &[ReferenceTransactionRecord],
    owner_id: u32,
) -> Result<ParsedTransaction, Errno> {
    // Mirrors `assertOwner`: a u32, and never the zero (unowned) sentinel.
    if owner_id == 0 {
        return Err(Errno::EINVAL);
    }

    let mut sections: [Vec<u8>; SECTION_COUNT] = core::array::from_fn(|_| Vec::new());
    let mut observed: [u64; SECTION_COUNT] = [0; SECTION_COUNT];
    let mut selected_count: u64 = 0;
    let mut segment_count: u64 = 0;
    let mut manifest_count: u32 = 0;
    let mut manifest: Option<ParsedManifest> = None;
    let mut previous_section: u16 = 0;

    for record in records {
        if record.kind != RECORD_KIND_REFERENCE_RECIPE_SEGMENT
            && record.kind != RECORD_KIND_REFERENCE_RECIPE
        {
            continue;
        }
        selected_count = selected_count.checked_add(1).ok_or(Errno::EINVAL)?;
        // Every selected record must be process-owned by exactly this owner.
        if record.activation_id != 0 || record.owner_id != owner_id {
            return Err(Errno::EINVAL);
        }

        if record.kind == RECORD_KIND_REFERENCE_RECIPE {
            manifest_count = manifest_count.checked_add(1).ok_or(Errno::EINVAL)?;
            if manifest_count == 1 {
                manifest = Some(decode_manifest(record.payload)?);
            }
            continue;
        }
        // A segment record must precede the final manifest.
        if manifest_count != 0 {
            return Err(Errno::EINVAL);
        }
        let (section, offset, data) = decode_segment(record.payload, segment_count)?;
        let sidx = (section - 1) as usize;
        // Sections appear in non-decreasing order; combined with the per-section
        // offset contiguity below, each section's segments are consecutive.
        if section < previous_section {
            return Err(Errno::EINVAL);
        }
        previous_section = section;
        if offset != observed[sidx] {
            return Err(Errno::EINVAL); // gap, overlap, or duplicate
        }
        observed[sidx] = observed[sidx]
            .checked_add(data.len() as u64)
            .ok_or(Errno::EINVAL)?;
        sections[sidx].extend_from_slice(data);
        segment_count = segment_count.checked_add(1).ok_or(Errno::EINVAL)?;
    }

    if selected_count == 0 {
        return Err(Errno::EINVAL); // no process reference transaction
    }
    let manifest = match (manifest_count, manifest) {
        (1, Some(manifest)) => manifest,
        _ => return Err(Errno::EINVAL), // not exactly one manifest
    };
    if segment_count != manifest.segment_count {
        return Err(Errno::EINVAL);
    }
    for section in 0..SECTION_COUNT {
        if observed[section] != manifest.totals[section] {
            return Err(Errno::EINVAL);
        }
        // Reassembly is exact by construction, but assert the invariant.
        if sections[section].len() as u64 != manifest.totals[section] {
            return Err(Errno::EINVAL);
        }
    }
    Ok(ParsedTransaction { manifest, sections })
}

/// Decode and cross-check the 96-byte KFRV manifest. Mirrors the TS
/// `decodeManifest`.
fn decode_manifest(payload: &[u8]) -> Result<ParsedManifest, Errno> {
    if payload.len() != MANIFEST_SIZE {
        return Err(Errno::EINVAL);
    }
    if r_u32(payload, 0)? != KFRV_MAGIC {
        return Err(Errno::EINVAL);
    }
    if r_u16(payload, 4)? != VERSION {
        return Err(Errno::EINVAL);
    }
    if r_u16(payload, 6)? as usize != MANIFEST_SIZE {
        return Err(Errno::EINVAL);
    }
    let flags = r_u32(payload, 8)?;
    if flags != MANIFEST_FLAG_SEALED || (flags & !MANIFEST_KNOWN_FLAGS) != 0 {
        return Err(Errno::EINVAL);
    }
    if r_u32(payload, 12)? as usize != NODE_RECORD_SIZE
        || r_u32(payload, 16)? as usize != VECTOR_INDEX_SIZE
    {
        return Err(Errno::EINVAL);
    }
    if r_u32(payload, 20)? != 0 {
        return Err(Errno::EINVAL); // reserved
    }

    let segment_count = r_u64(payload, 24)?;
    let node_count = r_u64(payload, 32)?;
    let vector_count = r_u64(payload, 40)?;
    if node_count == 0 || node_count > MAX_U32_DIRECTORY_LENGTH {
        return Err(Errno::EINVAL);
    }
    if vector_count > MAX_U32 {
        return Err(Errno::EINVAL);
    }
    let totals: [u64; SECTION_COUNT] = [
        r_u64(payload, 48)?,
        r_u64(payload, 56)?,
        r_u64(payload, 64)?,
        r_u64(payload, 72)?,
        r_u64(payload, 80)?,
    ];
    let expected_node_bytes = node_count
        .checked_mul(NODE_RECORD_SIZE as u64)
        .ok_or(Errno::EINVAL)?;
    let expected_vector_index_bytes = vector_count
        .checked_mul(VECTOR_INDEX_SIZE as u64)
        .ok_or(Errno::EINVAL)?;
    if totals[0] != expected_node_bytes || totals[3] != expected_vector_index_bytes {
        return Err(Errno::EINVAL);
    }
    // The u32 sections (edges, vector entries) are whole recipe-id words.
    if !totals[1].is_multiple_of(4) || !totals[4].is_multiple_of(4) {
        return Err(Errno::EINVAL);
    }
    let mut expected_total: u64 = 0;
    for total in totals {
        expected_total = expected_total.checked_add(total).ok_or(Errno::EINVAL)?;
    }
    if r_u64(payload, 88)? != expected_total {
        return Err(Errno::EINVAL);
    }
    Ok(ParsedManifest {
        segment_count,
        node_count,
        vector_count,
        totals,
    })
}

/// Decode one KFRS segment header, returning its `(section, logical offset,
/// data)`. Mirrors the TS `decodeSegment`.
fn decode_segment(
    payload: &[u8],
    expected_ordinal: u64,
) -> Result<(u16, u64, &[u8]), Errno> {
    if payload.len() < SEGMENT_HEADER_SIZE {
        return Err(Errno::EINVAL);
    }
    if r_u32(payload, 0)? != KFRS_MAGIC {
        return Err(Errno::EINVAL);
    }
    if r_u16(payload, 4)? != VERSION {
        return Err(Errno::EINVAL);
    }
    if r_u16(payload, 6)? as usize != SEGMENT_HEADER_SIZE {
        return Err(Errno::EINVAL);
    }
    let section = r_u16(payload, 8)?;
    if !(SECTION_NODES..=SECTION_VECTOR_ENTRIES).contains(&section) {
        return Err(Errno::EINVAL);
    }
    if r_u16(payload, 10)? != SEGMENT_KNOWN_FLAGS
        || r_u32(payload, 12)? != 0
        || r_u32(payload, 36)? != 0
    {
        return Err(Errno::EINVAL);
    }
    if r_u64(payload, 16)? != expected_ordinal {
        return Err(Errno::EINVAL);
    }
    let data_length = r_u32(payload, 32)? as usize;
    if data_length == 0 || payload.len() != SEGMENT_HEADER_SIZE + data_length {
        return Err(Errno::EINVAL);
    }
    let offset = r_u64(payload, 24)?;
    let data = payload.get(SEGMENT_HEADER_SIZE..).ok_or(Errno::EINVAL)?;
    Ok((section, offset, data))
}
