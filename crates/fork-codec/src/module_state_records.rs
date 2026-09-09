//! Per-record-kind payload decoders for the fork module-state (KFMS) arena.
//!
//! The KFMS structural envelope (`module_state::decode_module_state`) parses the
//! sealed chunk chain into record TLVs and exposes each record's kind, ownership
//! coordinates, and payload byte range, but treats the payload itself as opaque.
//! This module is the next layer: it turns the raw payload bytes of the
//! PURE-BYTE record kinds into typed, owned, fully validated structs that match
//! the host TypeScript decoders in `host/src/fork-module-state.ts`
//! field-for-field.
//!
//! Pure-byte record kinds decoded here (each is a self-contained byte layout the
//! child rebuilds without any live instance handle):
//!
//! * `Module` (kind 1) — `decodeModulePayload`: the 32-byte module template id
//!   plus a `u32` flags word (known flags: none) and a reserved `u32`.
//! * `MutableGlobal` (kind 3) — `decodeForkGlobalSnapshot`: an 8-byte header
//!   (value-type code, value size, two reserved fields) plus the raw global
//!   value bytes; reference globals also expose the leading `u32` recipe id.
//! * `Table` descriptor (kind 4) — `decodeTableDescriptor`: index width, page
//!   shift, sparse-override flags, page count, final/baseline lengths, and the
//!   32-byte deterministic baseline fingerprint.
//! * `TablePage` (kind 5) — `validateTablePage`/`decodeTablePage`: a page index
//!   and a run-length list of `u32` recipe-id overrides. This one needs its
//!   owning `Table` descriptor's page shift and final length as decode context;
//!   the recipe ids themselves are plain `u32` indices (their resolution to live
//!   references is the deferred half — see below).
//! * `ElementSegments` (kind 6) and `DataSegments` (kind 7) —
//!   `decodeSegmentBitmap`: a segment count and a dropped-segment bitmap.
//!
//! Every decoder is a bounds-checked, panic-free `&[u8] -> struct`; any framing
//! or consistency violation yields `Err(Errno::EINVAL)`, exactly the failure
//! mode of the corresponding TS decoder's `throw`.
//!
//! DEFERRED to the co-resident module (Phase 6 D5+), exactly as the prior
//! decoders deferred their live halves:
//!
//! * `ReferenceRecipe` (kind 2) and `ReferenceRecipeSegment` (kind 12): the KFRV
//!   reference-recipe graph. The standalone recipe wire is already ported in
//!   `reference_recipes.rs`; wiring the in-arena recipe records into the live
//!   reference broker is runtime-instance state, not a pure byte decode.
//! * `ReplayEvents` (kind 8) and `ReplayEventSegment` (kind 13): the KFRE replay
//!   journal, already ported in `replay_events.rs`; its in-arena records carry
//!   that same wire.
//! * `ImportedGlobalBindings` (kind 9), `ActivationContinuations` (kind 10), and
//!   `ImportedTableBindings` (kind 11): live binding/continuation state that
//!   names `WebAssembly.Global`/`Table` identities, activation roots, and
//!   exception continuations resolved through the reference broker. These are
//!   genuinely instance-bound, not a pure `&[u8]` decode.

use wasm_posix_shared::abi;
use wasm_posix_shared::Errno;

use alloc::vec::Vec;

use crate::module_state::ModuleStateRecord;

const MODULE_TEMPLATE_ID_SIZE: usize =
    abi::WPK_FORK_MODULE_STATE_MODULE_TEMPLATE_ID_SIZE as usize;
const MODULE_RECORD_PAYLOAD_SIZE: usize =
    abi::WPK_FORK_MODULE_STATE_MODULE_RECORD_PAYLOAD_SIZE as usize;
const MODULE_RECORD_KNOWN_FLAGS: u32 = abi::WPK_FORK_MODULE_STATE_MODULE_RECORD_KNOWN_FLAGS;
const GLOBAL_HEADER_SIZE: usize = abi::WPK_FORK_MODULE_STATE_GLOBAL_HEADER_SIZE as usize;
const TABLE_DESCRIPTOR_PAYLOAD_SIZE: usize =
    abi::WPK_FORK_MODULE_STATE_TABLE_DESCRIPTOR_PAYLOAD_SIZE as usize;
const TABLE_BASELINE_FINGERPRINT_SIZE: usize =
    abi::WPK_FORK_MODULE_STATE_TABLE_BASELINE_FINGERPRINT_SIZE as usize;
const TABLE_FLAG_SPARSE_OVERRIDES: u16 =
    abi::WPK_FORK_MODULE_STATE_TABLE_FLAG_SPARSE_OVERRIDES as u16;
const TABLE_KNOWN_FLAGS: u16 = abi::WPK_FORK_MODULE_STATE_TABLE_KNOWN_FLAGS as u16;
const TABLE_PAGE_HEADER_SIZE: usize = abi::WPK_FORK_MODULE_STATE_TABLE_PAGE_HEADER_SIZE as usize;
const TABLE_RUN_HEADER_SIZE: usize = abi::WPK_FORK_MODULE_STATE_TABLE_RUN_HEADER_SIZE as usize;
const ELEMENT_SEGMENT_HEADER_SIZE: usize =
    abi::WPK_FORK_MODULE_STATE_ELEMENT_SEGMENT_HEADER_SIZE as usize;
const DATA_SEGMENT_HEADER_SIZE: usize = abi::WPK_FORK_MODULE_STATE_DATA_SEGMENT_HEADER_SIZE as usize;
const MIN_TABLE_PAGE_SHIFT: u8 = abi::WPK_FORK_MODULE_STATE_MIN_TABLE_PAGE_SHIFT;
const MAX_TABLE_PAGE_SHIFT: u8 = abi::WPK_FORK_MODULE_STATE_MAX_TABLE_PAGE_SHIFT;

// --- Bounds-checked little-endian readers --------------------------------

fn r_u16(bytes: &[u8], off: usize) -> Result<u16, Errno> {
    let end = off.checked_add(2).ok_or(Errno::EINVAL)?;
    let slice = bytes.get(off..end).ok_or(Errno::EINVAL)?;
    Ok(u16::from_le_bytes([slice[0], slice[1]]))
}

fn r_u32(bytes: &[u8], off: usize) -> Result<u32, Errno> {
    let end = off.checked_add(4).ok_or(Errno::EINVAL)?;
    let slice = bytes.get(off..end).ok_or(Errno::EINVAL)?;
    Ok(u32::from_le_bytes([slice[0], slice[1], slice[2], slice[3]]))
}

fn r_u64(bytes: &[u8], off: usize) -> Result<u64, Errno> {
    let end = off.checked_add(8).ok_or(Errno::EINVAL)?;
    let slice = bytes.get(off..end).ok_or(Errno::EINVAL)?;
    Ok(u64::from_le_bytes([
        slice[0], slice[1], slice[2], slice[3], slice[4], slice[5], slice[6], slice[7],
    ]))
}

/// Whether `type_code` is a reference value type (`funcref`/`externref`/
/// `exnref`/`anyref`, codes 6..=9). Reference globals carry their referent as a
/// leading `u32` recipe id.
fn is_reference_type(type_code: u8) -> bool {
    type_code == abi::WPK_FORK_MODULE_STATE_GLOBAL_TYPE_FUNCREF
        || type_code == abi::WPK_FORK_MODULE_STATE_GLOBAL_TYPE_EXTERNREF
        || type_code == abi::WPK_FORK_MODULE_STATE_GLOBAL_TYPE_EXNREF
        || type_code == abi::WPK_FORK_MODULE_STATE_GLOBAL_TYPE_ANYREF
}

/// The byte width of a mutable-global value for `type_code`, or `None` for an
/// unknown type. Mirrors the TS `valueSizes` map in `decodeForkGlobalSnapshot`.
fn global_value_size(type_code: u8) -> Option<u8> {
    if type_code == abi::WPK_FORK_MODULE_STATE_GLOBAL_TYPE_I32 {
        Some(4)
    } else if type_code == abi::WPK_FORK_MODULE_STATE_GLOBAL_TYPE_I64 {
        Some(8)
    } else if type_code == abi::WPK_FORK_MODULE_STATE_GLOBAL_TYPE_F32 {
        Some(4)
    } else if type_code == abi::WPK_FORK_MODULE_STATE_GLOBAL_TYPE_F64 {
        Some(8)
    } else if type_code == abi::WPK_FORK_MODULE_STATE_GLOBAL_TYPE_V128 {
        Some(16)
    } else if is_reference_type(type_code) {
        Some(4)
    } else {
        None
    }
}

// --- Module descriptor record (kind 1) -----------------------------------

/// Decoded `Module` record payload: the deterministic module identity a child
/// rebinds before instantiation. Mirrors the fields `decodeModulePayload`
/// validates.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModuleDescriptor {
    /// The 32-byte SHA-256 module template id.
    pub template_id: [u8; 32],
    /// Module flags word (currently no flags are defined, so always zero).
    pub flags: u32,
}

/// Decode a `Module` (kind 1) record payload. Mirrors `decodeModulePayload`.
pub fn decode_module_record(payload: &[u8]) -> Result<ModuleDescriptor, Errno> {
    if payload.len() != MODULE_RECORD_PAYLOAD_SIZE {
        return Err(Errno::EINVAL);
    }
    let flags = r_u32(payload, MODULE_TEMPLATE_ID_SIZE)?;
    if flags & !MODULE_RECORD_KNOWN_FLAGS != 0 {
        return Err(Errno::EINVAL); // unknown module flags
    }
    if r_u32(payload, MODULE_TEMPLATE_ID_SIZE + 4)? != 0 {
        return Err(Errno::EINVAL); // reserved field is nonzero
    }
    let mut template_id = [0u8; 32];
    template_id.copy_from_slice(&payload[0..MODULE_TEMPLATE_ID_SIZE]);
    Ok(ModuleDescriptor { template_id, flags })
}

// --- Mutable global record (kind 3) --------------------------------------

/// Decoded `MutableGlobal` record payload: a value-type-tagged snapshot of one
/// mutable global. Mirrors the TS `ForkGlobalSnapshot`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GlobalSnapshot {
    /// The value-type code (`WPK_FORK_MODULE_STATE_GLOBAL_TYPE_*`).
    pub type_code: u8,
    /// The raw stored value bytes (4/8/16 bytes depending on the type).
    pub value: Vec<u8>,
    /// For reference-type globals, the leading `u32` recipe id of the referent;
    /// `None` for numeric/vector globals.
    pub recipe_id: Option<u32>,
}

/// Decode a `MutableGlobal` (kind 3) record payload. Mirrors
/// `decodeForkGlobalSnapshot`.
pub fn decode_mutable_global(payload: &[u8]) -> Result<GlobalSnapshot, Errno> {
    if payload.len() < GLOBAL_HEADER_SIZE {
        return Err(Errno::EINVAL); // truncated header
    }
    let type_code = payload[0];
    let expected_value_size = global_value_size(type_code).ok_or(Errno::EINVAL)?;
    let value_size = payload[1];
    if value_size != expected_value_size
        || payload.len() != GLOBAL_HEADER_SIZE + expected_value_size as usize
    {
        return Err(Errno::EINVAL); // value size inconsistent
    }
    if r_u16(payload, 2)? != 0 || r_u32(payload, 4)? != 0 {
        return Err(Errno::EINVAL); // reserved fields nonzero
    }
    let value = payload[GLOBAL_HEADER_SIZE..].to_vec();
    let recipe_id = if is_reference_type(type_code) {
        Some(r_u32(&value, 0)?)
    } else {
        None
    };
    Ok(GlobalSnapshot {
        type_code,
        value,
        recipe_id,
    })
}

// --- Table descriptor record (kind 4) ------------------------------------

/// Decoded `Table` descriptor record payload: the geometry of one sparse table
/// snapshot. Mirrors the TS `DecodedTableDescriptor` fields
/// `decodeTableDescriptor` returns (the ownership coordinates
/// `activationId`/`ownerId` live on the record envelope, not this payload).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TableDescriptor {
    /// Table index width in bytes: 4 (table32) or 8 (table64).
    pub index_width: u8,
    /// Sparse page shift; the page holds `1 << page_shift` slots.
    pub page_shift: u8,
    /// Table flags (`SPARSE_OVERRIDES` is required and the only known flag).
    pub flags: u16,
    /// Number of `TablePage` records that follow for this table.
    pub page_count: u32,
    /// Final table length.
    pub length: u64,
    /// Deterministic baseline length (must not exceed `length`).
    pub baseline_length: u64,
    /// 32-byte fingerprint of the deterministic instantiation baseline.
    pub baseline_fingerprint: [u8; 32],
}

/// Decode a `Table` (kind 4) descriptor record payload. Mirrors
/// `decodeTableDescriptor`.
pub fn decode_table_descriptor(payload: &[u8]) -> Result<TableDescriptor, Errno> {
    if payload.len() != TABLE_DESCRIPTOR_PAYLOAD_SIZE {
        return Err(Errno::EINVAL);
    }
    let index_width = payload[0];
    if index_width != 4 && index_width != 8 {
        return Err(Errno::EINVAL); // unsupported index width
    }
    let page_shift = payload[1];
    if !(MIN_TABLE_PAGE_SHIFT..=MAX_TABLE_PAGE_SHIFT).contains(&page_shift) {
        return Err(Errno::EINVAL); // unsupported page shift
    }
    let flags = r_u16(payload, 2)?;
    if flags & !TABLE_KNOWN_FLAGS != 0 || flags & TABLE_FLAG_SPARSE_OVERRIDES == 0 {
        return Err(Errno::EINVAL); // invalid table flags
    }
    let page_count = r_u32(payload, 4)?;
    let length = r_u64(payload, 8)?;
    let baseline_length = r_u64(payload, 16)?;
    if index_width == 4 && length > u32::MAX as u64 {
        return Err(Errno::EINVAL); // table32 length exceeds u32
    }
    if baseline_length > length {
        return Err(Errno::EINVAL); // baseline exceeds final length
    }
    let mut baseline_fingerprint = [0u8; 32];
    baseline_fingerprint
        .copy_from_slice(&payload[24..24 + TABLE_BASELINE_FINGERPRINT_SIZE]);
    Ok(TableDescriptor {
        index_width,
        page_shift,
        flags,
        page_count,
        length,
        baseline_length,
        baseline_fingerprint,
    })
}

// --- Sparse table page record (kind 5) -----------------------------------

/// One decoded run of contiguous recipe-id overrides within a table page.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SparseTableRun {
    /// The page-relative slot index the run starts at.
    pub start: u32,
    /// The recipe ids overriding the deterministic baseline for this run. These
    /// are plain `u32` indices into the reference-recipe graph; resolving them
    /// to live references is the deferred runtime half.
    pub recipe_ids: Vec<u32>,
}

/// Decoded `TablePage` record payload: the sparse overrides for one page of a
/// table. Mirrors the TS `DecodedTablePage` (envelope ownership fields aside).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SparseTablePage {
    /// The page index within the table.
    pub page_index: u64,
    /// The runs of overrides, ordered and non-overlapping within the page.
    pub runs: Vec<SparseTableRun>,
    /// Total override entries across all runs (validated against the header).
    pub entry_count: u32,
}

/// Decode a `TablePage` (kind 5) record payload. Mirrors
/// `validateTablePage` + `decodeTablePage`.
///
/// A table page is only meaningful relative to its owning `Table` descriptor, so
/// the descriptor's `page_shift` and final `length` are decode context (matching
/// the TS decoder, which is handed the `DecodedTableDescriptor`). The recipe ids
/// in each run are plain `u32` indices; this is a pure byte decode. Malformed
/// input yields `Err(Errno::EINVAL)`; the function never panics.
pub fn decode_table_page(
    payload: &[u8],
    page_shift: u8,
    table_length: u64,
) -> Result<SparseTablePage, Errno> {
    // Guard the shift so `1u64 << page_shift` can never overflow, even when a
    // caller passes an out-of-range descriptor.
    if !(MIN_TABLE_PAGE_SHIFT..=MAX_TABLE_PAGE_SHIFT).contains(&page_shift) {
        return Err(Errno::EINVAL);
    }
    if payload.len() < TABLE_PAGE_HEADER_SIZE {
        return Err(Errno::EINVAL); // truncated header
    }
    let page_index = r_u64(payload, 0)?;
    let run_count = r_u32(payload, 8)?;
    let declared_entry_count = r_u32(payload, 12)?;
    let page_size = 1u64 << page_shift;

    let mut previous_end: u64 = 0;
    let mut entry_count: u64 = 0;
    let mut offset = TABLE_PAGE_HEADER_SIZE;
    let mut runs: Vec<SparseTableRun> = Vec::new();
    for _ in 0..run_count {
        let run_header_end = offset.checked_add(TABLE_RUN_HEADER_SIZE).ok_or(Errno::EINVAL)?;
        if run_header_end > payload.len() {
            return Err(Errno::EINVAL); // run header truncated
        }
        let start = r_u32(payload, offset)?;
        let count = r_u32(payload, offset + 4)?;
        offset = run_header_end;
        let start64 = start as u64;
        let count64 = count as u64;
        let run_end = start64 + count64; // both u32, sum fits u64
        if count == 0 || start64 < previous_end || start64 >= page_size || run_end > page_size {
            return Err(Errno::EINVAL); // unordered or out-of-bounds run
        }
        let recipes_bytes = (count as usize).checked_mul(4).ok_or(Errno::EINVAL)?;
        let recipes_end = offset.checked_add(recipes_bytes).ok_or(Errno::EINVAL)?;
        if recipes_end > payload.len() {
            return Err(Errno::EINVAL); // run recipes truncated
        }
        let absolute_end = page_index
            .checked_mul(page_size)
            .and_then(|base| base.checked_add(run_end))
            .ok_or(Errno::EINVAL)?;
        if absolute_end > table_length {
            return Err(Errno::EINVAL); // run exceeds final table length
        }
        let mut recipe_ids: Vec<u32> = Vec::with_capacity(count as usize);
        for _ in 0..count {
            recipe_ids.push(r_u32(payload, offset)?);
            offset += 4;
        }
        previous_end = run_end;
        entry_count += count64;
        runs.push(SparseTableRun { start, recipe_ids });
    }
    if run_count == 0 || entry_count != declared_entry_count as u64 || offset != payload.len() {
        return Err(Errno::EINVAL); // counts or payload size inconsistent
    }
    Ok(SparseTablePage {
        page_index,
        runs,
        entry_count: declared_entry_count,
    })
}

// --- Element/data segment bitmap records (kinds 6, 7) --------------------

/// Decoded segment-drop bitmap, shared by `ElementSegments` (kind 6) and
/// `DataSegments` (kind 7). Mirrors the fields `decodeSegmentBitmap` validates.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SegmentBitmap {
    /// The number of segments the bitmap covers.
    pub segment_count: u32,
    /// The dropped-segment bitmap, `ceil(segment_count / 8)` bytes; bit `i`
    /// (LSB-first) is set iff segment `i` has been dropped.
    pub dropped: Vec<u8>,
}

/// Shared decoder for the element/data segment-drop bitmap. Mirrors
/// `decodeSegmentBitmap`.
fn decode_segment_bitmap(payload: &[u8], header_size: usize) -> Result<SegmentBitmap, Errno> {
    if payload.len() < header_size {
        return Err(Errno::EINVAL); // truncated header
    }
    let segment_count = r_u32(payload, 0)?;
    let bitmap_bytes = r_u32(payload, 4)?;
    let expected_bytes = segment_count.div_ceil(8);
    if bitmap_bytes != expected_bytes
        || payload.len() as u64 != header_size as u64 + expected_bytes as u64
    {
        return Err(Errno::EINVAL); // bitmap size inconsistent
    }
    if expected_bytes > 0 && segment_count % 8 != 0 {
        // The bits beyond the live segment count in the final byte must be zero.
        let invalid_mask = 0xffu32 << (segment_count % 8);
        let last = payload[payload.len() - 1] as u32;
        if last & invalid_mask != 0 {
            return Err(Errno::EINVAL); // nonzero trailing bits
        }
    }
    let dropped = payload[header_size..].to_vec();
    Ok(SegmentBitmap {
        segment_count,
        dropped,
    })
}

/// Decode an `ElementSegments` (kind 6) record payload. Mirrors
/// `decodeElementSegments`.
pub fn decode_element_segments(payload: &[u8]) -> Result<SegmentBitmap, Errno> {
    decode_segment_bitmap(payload, ELEMENT_SEGMENT_HEADER_SIZE)
}

/// Decode a `DataSegments` (kind 7) record payload. Mirrors
/// `decodeDataSegments`.
pub fn decode_data_segments(payload: &[u8]) -> Result<SegmentBitmap, Errno> {
    decode_segment_bitmap(payload, DATA_SEGMENT_HEADER_SIZE)
}

// --- Envelope resolution -------------------------------------------------

/// A record's payload resolved into its typed form for the pure-byte record
/// kinds this module decodes.
///
/// The raw-TLV path on `ModuleStateRecord` is unchanged; this is an ADDITIVE
/// typed view. Kinds that need cross-record context (a `TablePage` needs its
/// `Table` descriptor's page shift and length) or live instance state (the
/// reference-recipe, replay-event, binding, and continuation records) resolve to
/// [`ModuleStateRecordPayload::Deferred`]; the `TablePage` decoder is exposed
/// directly as [`decode_table_page`] for callers holding the descriptor.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ModuleStateRecordPayload {
    Module(ModuleDescriptor),
    MutableGlobal(GlobalSnapshot),
    Table(TableDescriptor),
    ElementSegments(SegmentBitmap),
    DataSegments(SegmentBitmap),
    /// A record whose payload is not a context-free pure-byte decode (see the
    /// enum doc comment). Carries the record kind for the caller to route.
    Deferred { kind: u16 },
}

/// The payload byte slice of a decoded record within the guest linear memory.
/// Bounds-checked against `memory`; malformed offsets yield `Err(Errno::EINVAL)`.
pub fn record_payload_bytes<'a>(
    memory: &'a [u8],
    record: &ModuleStateRecord,
) -> Result<&'a [u8], Errno> {
    let start = usize::try_from(record.payload_offset).map_err(|_| Errno::EINVAL)?;
    let size = usize::try_from(record.payload_size).map_err(|_| Errno::EINVAL)?;
    let end = start.checked_add(size).ok_or(Errno::EINVAL)?;
    memory.get(start..end).ok_or(Errno::EINVAL)
}

/// Resolve a decoded record envelope into its typed payload for the pure-byte
/// record kinds. `memory` is the guest linear memory the envelope was decoded
/// from. Malformed input yields `Err(Errno::EINVAL)`; the function never panics.
pub fn decode_record_payload(
    memory: &[u8],
    record: &ModuleStateRecord,
) -> Result<ModuleStateRecordPayload, Errno> {
    let payload = record_payload_bytes(memory, record)?;
    let kind = record.kind;
    if kind == abi::WPK_FORK_MODULE_STATE_RECORD_KIND_MODULE {
        Ok(ModuleStateRecordPayload::Module(decode_module_record(payload)?))
    } else if kind == abi::WPK_FORK_MODULE_STATE_RECORD_KIND_MUTABLE_GLOBAL {
        Ok(ModuleStateRecordPayload::MutableGlobal(decode_mutable_global(
            payload,
        )?))
    } else if kind == abi::WPK_FORK_MODULE_STATE_RECORD_KIND_TABLE {
        Ok(ModuleStateRecordPayload::Table(decode_table_descriptor(
            payload,
        )?))
    } else if kind == abi::WPK_FORK_MODULE_STATE_RECORD_KIND_ELEMENT_SEGMENTS {
        Ok(ModuleStateRecordPayload::ElementSegments(
            decode_element_segments(payload)?,
        ))
    } else if kind == abi::WPK_FORK_MODULE_STATE_RECORD_KIND_DATA_SEGMENTS {
        Ok(ModuleStateRecordPayload::DataSegments(decode_data_segments(
            payload,
        )?))
    } else {
        Ok(ModuleStateRecordPayload::Deferred { kind })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::module_state::{decode_module_state, ModuleStateFormat};

    const PW: u8 = 4;
    const CHUNK_HEADER: u32 = 40;

    fn wasm32_format() -> ModuleStateFormat {
        ModuleStateFormat {
            pointer_width: PW,
            chunk_header_size: CHUNK_HEADER,
        }
    }

    // --- Cross-language fixture (emitted by the real TS arena encoders) ----

    /// Bytes are the used prefix of a sealed root arena chunk emitted by the
    /// REAL host `ForkModuleStateArena` (the same encoder the guest fork path
    /// mirrors), via `crates/fork-codec/testdata/gen-module-state-records-fixture.mts`.
    /// That generator drives `appendModule` / `appendRecord(MutableGlobal)` /
    /// `appendSparseTable` (which itself round-trips through the real
    /// `decodeTableDescriptor` + `validateSparseTablePage`) /
    /// `appendElementSegmentState` / `appendDataSegmentState`, then re-decodes
    /// the committed bytes with the real host decoders as a cross-check. If the
    /// TS encoders/decoders and these Rust decoders ever disagree on a payload
    /// layout, this test catches the drift.
    const FIXTURE: &[u8] = include_bytes!("../testdata/module-state-records-wasm32.bin");
    const FIXTURE_ROOT: u64 = 65_536;
    const FIXTURE_CAPACITY: u64 = 65_536;

    fn fixture_memory() -> Vec<u8> {
        let mut mem = alloc::vec![0u8; FIXTURE_ROOT as usize];
        mem.extend_from_slice(FIXTURE);
        mem.resize((FIXTURE_ROOT + FIXTURE_CAPACITY) as usize, 0);
        mem
    }

    /// Decode the fixture envelope and return every record's typed payload plus
    /// the raw envelope record (for the `TablePage`, which needs descriptor
    /// context resolved by the caller).
    fn decoded_fixture() -> (Vec<u8>, Vec<ModuleStateRecord>) {
        let mem = fixture_memory();
        let state = decode_module_state(&mem, FIXTURE_ROOT, &wasm32_format()).unwrap();
        (mem, state.records)
    }

    #[test]
    fn decodes_every_pure_byte_record_field_for_field() {
        let (mem, records) = decoded_fixture();

        // The fixture carries one record of each pure-byte kind, in this order:
        // Module, MutableGlobal(i32), MutableGlobal(funcref), Table, TablePage,
        // ElementSegments, DataSegments.
        assert_eq!(records.len(), 7);

        // Module (kind 1): template id filled with 0xa0, no flags.
        let module = match decode_record_payload(&mem, &records[0]).unwrap() {
            ModuleStateRecordPayload::Module(m) => m,
            other => panic!("expected Module, got {other:?}"),
        };
        assert_eq!(module.template_id, [0xa0u8; 32]);
        assert_eq!(module.flags, 0);

        // MutableGlobal i32 (kind 3): value 0x0908_0706, no recipe id.
        let global_i32 = match decode_record_payload(&mem, &records[1]).unwrap() {
            ModuleStateRecordPayload::MutableGlobal(g) => g,
            other => panic!("expected MutableGlobal, got {other:?}"),
        };
        assert_eq!(
            global_i32.type_code,
            abi::WPK_FORK_MODULE_STATE_GLOBAL_TYPE_I32
        );
        assert_eq!(global_i32.value, alloc::vec![0x06, 0x07, 0x08, 0x09]);
        assert_eq!(global_i32.recipe_id, None);

        // MutableGlobal funcref (kind 3): reference type exposes the recipe id.
        let global_ref = match decode_record_payload(&mem, &records[2]).unwrap() {
            ModuleStateRecordPayload::MutableGlobal(g) => g,
            other => panic!("expected MutableGlobal, got {other:?}"),
        };
        assert_eq!(
            global_ref.type_code,
            abi::WPK_FORK_MODULE_STATE_GLOBAL_TYPE_FUNCREF
        );
        assert_eq!(global_ref.value, alloc::vec![0x44, 0x33, 0x22, 0x11]);
        assert_eq!(global_ref.recipe_id, Some(0x1122_3344));

        // Table descriptor (kind 4).
        let table = match decode_record_payload(&mem, &records[3]).unwrap() {
            ModuleStateRecordPayload::Table(t) => t,
            other => panic!("expected Table, got {other:?}"),
        };
        assert_eq!(table.index_width, 4);
        assert_eq!(table.page_shift, 10);
        assert_eq!(table.flags, TABLE_FLAG_SPARSE_OVERRIDES);
        assert_eq!(table.page_count, 1);
        assert_eq!(table.length, 4096);
        assert_eq!(table.baseline_length, 16);
        assert_eq!(table.baseline_fingerprint, [0xbbu8; 32]);

        // TablePage (kind 5): needs the descriptor's page shift + length. The
        // envelope auto-resolver defers it; decode it directly.
        assert_eq!(
            decode_record_payload(&mem, &records[4]).unwrap(),
            ModuleStateRecordPayload::Deferred {
                kind: abi::WPK_FORK_MODULE_STATE_RECORD_KIND_TABLE_PAGE,
            }
        );
        let page_bytes = record_payload_bytes(&mem, &records[4]).unwrap();
        let page = decode_table_page(page_bytes, table.page_shift, table.length).unwrap();
        assert_eq!(page.page_index, 0);
        assert_eq!(page.entry_count, 4);
        assert_eq!(
            page.runs,
            alloc::vec![
                SparseTableRun {
                    start: 2,
                    recipe_ids: alloc::vec![7, 8, 9],
                },
                SparseTableRun {
                    start: 10,
                    recipe_ids: alloc::vec![42],
                },
            ]
        );

        // ElementSegments (kind 6): 12 segments, 2-byte bitmap.
        let elements = match decode_record_payload(&mem, &records[5]).unwrap() {
            ModuleStateRecordPayload::ElementSegments(s) => s,
            other => panic!("expected ElementSegments, got {other:?}"),
        };
        assert_eq!(elements.segment_count, 12);
        assert_eq!(elements.dropped, alloc::vec![0xb5, 0x0a]);

        // DataSegments (kind 7): 8 segments, 1-byte bitmap.
        let data = match decode_record_payload(&mem, &records[6]).unwrap() {
            ModuleStateRecordPayload::DataSegments(s) => s,
            other => panic!("expected DataSegments, got {other:?}"),
        };
        assert_eq!(data.segment_count, 8);
        assert_eq!(data.dropped, alloc::vec![0xc3]);
    }

    #[test]
    fn fixture_is_non_vacuous() {
        // Guard against a fixture that collapses to a trivial shape which would
        // make the field-for-field test vacuously pass.
        let (mem, records) = decoded_fixture();
        let kinds: Vec<u16> = records.iter().map(|r| r.kind).collect();
        assert_eq!(kinds, alloc::vec![1, 3, 3, 4, 5, 6, 7]);
        // A reference global with a recipe id and a numeric global without one
        // both survived the round trip.
        let ref_global = decode_mutable_global(record_payload_bytes(&mem, &records[2]).unwrap())
            .unwrap();
        assert!(ref_global.recipe_id.is_some());
        // The sparse table carries more than one run and more than one entry.
        let table = decode_table_descriptor(record_payload_bytes(&mem, &records[3]).unwrap())
            .unwrap();
        let page = decode_table_page(
            record_payload_bytes(&mem, &records[4]).unwrap(),
            table.page_shift,
            table.length,
        )
        .unwrap();
        assert!(page.runs.len() >= 2);
        assert!(page.entry_count >= 2);
        // The element bitmap has at least one dropped segment.
        let elements =
            decode_element_segments(record_payload_bytes(&mem, &records[5]).unwrap()).unwrap();
        assert!(elements.dropped.iter().any(|&b| b != 0));
    }

    // --- Module record negatives ------------------------------------------

    fn module_payload() -> Vec<u8> {
        let mut p = alloc::vec![0u8; MODULE_RECORD_PAYLOAD_SIZE];
        for byte in p.iter_mut().take(MODULE_TEMPLATE_ID_SIZE) {
            *byte = 0x5a;
        }
        p
    }

    #[test]
    fn decodes_minimal_module_record() {
        let decoded = decode_module_record(&module_payload()).unwrap();
        assert_eq!(decoded.template_id, [0x5au8; 32]);
        assert_eq!(decoded.flags, 0);
    }

    #[test]
    fn rejects_module_wrong_size() {
        assert_eq!(
            decode_module_record(&module_payload()[..MODULE_RECORD_PAYLOAD_SIZE - 1]),
            Err(Errno::EINVAL)
        );
        let mut too_long = module_payload();
        too_long.push(0);
        assert_eq!(decode_module_record(&too_long), Err(Errno::EINVAL));
    }

    #[test]
    fn rejects_module_unknown_flags() {
        let mut p = module_payload();
        p[MODULE_TEMPLATE_ID_SIZE] = 1; // any flag bit is unknown (known == none)
        assert_eq!(decode_module_record(&p), Err(Errno::EINVAL));
    }

    #[test]
    fn rejects_module_nonzero_reserved() {
        let mut p = module_payload();
        p[MODULE_TEMPLATE_ID_SIZE + 4] = 1;
        assert_eq!(decode_module_record(&p), Err(Errno::EINVAL));
    }

    // --- Mutable global negatives -----------------------------------------

    fn global_payload(type_code: u8, value: &[u8]) -> Vec<u8> {
        let mut p = alloc::vec![0u8; GLOBAL_HEADER_SIZE + value.len()];
        p[0] = type_code;
        p[1] = value.len() as u8;
        p[GLOBAL_HEADER_SIZE..].copy_from_slice(value);
        p
    }

    #[test]
    fn decodes_i64_and_v128_and_ref_globals() {
        let i64_global =
            decode_mutable_global(&global_payload(2, &[1, 2, 3, 4, 5, 6, 7, 8])).unwrap();
        assert_eq!(i64_global.value.len(), 8);
        assert_eq!(i64_global.recipe_id, None);

        let v128 = decode_mutable_global(&global_payload(5, &[9u8; 16])).unwrap();
        assert_eq!(v128.value.len(), 16);
        assert_eq!(v128.recipe_id, None);

        let externref =
            decode_mutable_global(&global_payload(7, &[0x21, 0x43, 0x65, 0x87])).unwrap();
        assert_eq!(externref.recipe_id, Some(0x8765_4321));
    }

    #[test]
    fn rejects_global_unknown_type() {
        assert_eq!(
            decode_mutable_global(&global_payload(0, &[1, 2, 3, 4])),
            Err(Errno::EINVAL)
        );
        assert_eq!(
            decode_mutable_global(&global_payload(10, &[1, 2, 3, 4])),
            Err(Errno::EINVAL)
        );
    }

    #[test]
    fn rejects_global_wrong_value_size() {
        // i32 wants 4 value bytes; give it 8.
        let mut p = global_payload(1, &[1, 2, 3, 4]);
        p[1] = 8; // claim 8 while payload holds 4
        assert_eq!(decode_mutable_global(&p), Err(Errno::EINVAL));
        // Correct declared size but wrong payload length.
        let mut short = global_payload(1, &[1, 2, 3, 4]);
        short.pop();
        assert_eq!(decode_mutable_global(&short), Err(Errno::EINVAL));
    }

    #[test]
    fn rejects_global_nonzero_reserved() {
        let mut p = global_payload(1, &[1, 2, 3, 4]);
        p[2] = 1; // u16 reserved
        assert_eq!(decode_mutable_global(&p), Err(Errno::EINVAL));
        let mut q = global_payload(1, &[1, 2, 3, 4]);
        q[4] = 1; // u32 reserved
        assert_eq!(decode_mutable_global(&q), Err(Errno::EINVAL));
    }

    #[test]
    fn rejects_global_truncated_header() {
        assert_eq!(decode_mutable_global(&[1, 4, 0]), Err(Errno::EINVAL));
    }

    // --- Table descriptor negatives ---------------------------------------

    fn table_payload() -> Vec<u8> {
        let mut p = alloc::vec![0u8; TABLE_DESCRIPTOR_PAYLOAD_SIZE];
        p[0] = 4; // index width
        p[1] = 10; // page shift
        p[2..4].copy_from_slice(&TABLE_FLAG_SPARSE_OVERRIDES.to_le_bytes());
        p[4..8].copy_from_slice(&1u32.to_le_bytes()); // page count
        p[8..16].copy_from_slice(&4096u64.to_le_bytes()); // length
        p[16..24].copy_from_slice(&16u64.to_le_bytes()); // baseline length
        for byte in p.iter_mut().skip(24) {
            *byte = 0xbb;
        }
        p
    }

    #[test]
    fn decodes_minimal_table_descriptor() {
        let decoded = decode_table_descriptor(&table_payload()).unwrap();
        assert_eq!(decoded.index_width, 4);
        assert_eq!(decoded.page_shift, 10);
        assert_eq!(decoded.length, 4096);
        assert_eq!(decoded.baseline_length, 16);
        assert_eq!(decoded.baseline_fingerprint, [0xbbu8; 32]);
    }

    #[test]
    fn rejects_table_bad_index_width_and_shift() {
        let mut bad_width = table_payload();
        bad_width[0] = 2;
        assert_eq!(decode_table_descriptor(&bad_width), Err(Errno::EINVAL));
        let mut low_shift = table_payload();
        low_shift[1] = MIN_TABLE_PAGE_SHIFT - 1;
        assert_eq!(decode_table_descriptor(&low_shift), Err(Errno::EINVAL));
        let mut high_shift = table_payload();
        high_shift[1] = MAX_TABLE_PAGE_SHIFT + 1;
        assert_eq!(decode_table_descriptor(&high_shift), Err(Errno::EINVAL));
    }

    #[test]
    fn rejects_table_bad_flags() {
        let mut no_sparse = table_payload();
        no_sparse[2] = 0; // clear the required SPARSE_OVERRIDES bit
        assert_eq!(decode_table_descriptor(&no_sparse), Err(Errno::EINVAL));
        let mut unknown = table_payload();
        unknown[3] = 0x80; // set a high, unknown flag bit
        assert_eq!(decode_table_descriptor(&unknown), Err(Errno::EINVAL));
    }

    #[test]
    fn rejects_table_baseline_exceeds_length() {
        let mut p = table_payload();
        p[16..24].copy_from_slice(&5000u64.to_le_bytes()); // baseline > length(4096)
        assert_eq!(decode_table_descriptor(&p), Err(Errno::EINVAL));
    }

    #[test]
    fn rejects_table32_length_over_u32() {
        let mut p = table_payload();
        p[8..16].copy_from_slice(&(u32::MAX as u64 + 1).to_le_bytes());
        // baseline must not exceed length; set it to something small already ok.
        assert_eq!(decode_table_descriptor(&p), Err(Errno::EINVAL));
    }

    #[test]
    fn accepts_table64_large_length() {
        let mut p = table_payload();
        p[0] = 8; // table64
        p[8..16].copy_from_slice(&(u32::MAX as u64 + 100).to_le_bytes());
        let decoded = decode_table_descriptor(&p).unwrap();
        assert_eq!(decoded.index_width, 8);
        assert_eq!(decoded.length, u32::MAX as u64 + 100);
    }

    #[test]
    fn rejects_table_wrong_size() {
        assert_eq!(
            decode_table_descriptor(&table_payload()[..TABLE_DESCRIPTOR_PAYLOAD_SIZE - 1]),
            Err(Errno::EINVAL)
        );
    }

    // --- Table page negatives ---------------------------------------------

    /// Build a valid single-page payload with two runs `[start2:3][start10:1]`
    /// for a `page_shift=10` (page size 1024), table length 4096, page 0.
    fn table_page_payload() -> Vec<u8> {
        let mut p = alloc::vec![0u8; TABLE_PAGE_HEADER_SIZE];
        p[0..8].copy_from_slice(&0u64.to_le_bytes()); // page index
        p[8..12].copy_from_slice(&2u32.to_le_bytes()); // run count
        p[12..16].copy_from_slice(&4u32.to_le_bytes()); // entry count
        // Run 0: start 2, count 3, recipes [7,8,9].
        p.extend_from_slice(&2u32.to_le_bytes());
        p.extend_from_slice(&3u32.to_le_bytes());
        for recipe in [7u32, 8, 9] {
            p.extend_from_slice(&recipe.to_le_bytes());
        }
        // Run 1: start 10, count 1, recipes [42].
        p.extend_from_slice(&10u32.to_le_bytes());
        p.extend_from_slice(&1u32.to_le_bytes());
        p.extend_from_slice(&42u32.to_le_bytes());
        p
    }

    #[test]
    fn decodes_minimal_table_page() {
        let decoded = decode_table_page(&table_page_payload(), 10, 4096).unwrap();
        assert_eq!(decoded.page_index, 0);
        assert_eq!(decoded.entry_count, 4);
        assert_eq!(decoded.runs.len(), 2);
        assert_eq!(decoded.runs[0].recipe_ids, alloc::vec![7, 8, 9]);
    }

    #[test]
    fn rejects_table_page_bad_shift() {
        assert_eq!(
            decode_table_page(&table_page_payload(), MIN_TABLE_PAGE_SHIFT - 1, 4096),
            Err(Errno::EINVAL)
        );
        assert_eq!(
            decode_table_page(&table_page_payload(), 63, 4096),
            Err(Errno::EINVAL)
        );
    }

    #[test]
    fn rejects_table_page_overlapping_runs() {
        let mut p = table_page_payload();
        // Move run 1's start to 3, overlapping run 0 (which ends at 5).
        let run1 = TABLE_PAGE_HEADER_SIZE + TABLE_RUN_HEADER_SIZE + 3 * 4;
        p[run1..run1 + 4].copy_from_slice(&3u32.to_le_bytes());
        assert_eq!(decode_table_page(&p, 10, 4096), Err(Errno::EINVAL));
    }

    #[test]
    fn rejects_table_page_run_out_of_page() {
        // start 2, count 3 -> end 5; page size for shift 4 is 16, still fine, so
        // instead use a shift where the run exceeds the page.
        let mut p = table_page_payload();
        // Run 0 start 2 count 3 ends at 5; with page size 4 (shift 2) it would be
        // out of bounds, but shift 2 < MIN. Use run exceeding table length via
        // a large page index instead.
        p[0..8].copy_from_slice(&100u64.to_le_bytes()); // page index 100
        // absoluteEnd = 100 * 1024 + 5 = 102405 > 4096 -> reject.
        assert_eq!(decode_table_page(&p, 10, 4096), Err(Errno::EINVAL));
    }

    #[test]
    fn rejects_table_page_entry_count_mismatch() {
        let mut p = table_page_payload();
        p[12..16].copy_from_slice(&3u32.to_le_bytes()); // claim 3, actually 4
        assert_eq!(decode_table_page(&p, 10, 4096), Err(Errno::EINVAL));
    }

    #[test]
    fn rejects_table_page_zero_run_count() {
        let mut p = alloc::vec![0u8; TABLE_PAGE_HEADER_SIZE];
        p[8..12].copy_from_slice(&0u32.to_le_bytes()); // run count 0
        p[12..16].copy_from_slice(&0u32.to_le_bytes());
        assert_eq!(decode_table_page(&p, 10, 4096), Err(Errno::EINVAL));
    }

    #[test]
    fn rejects_table_page_trailing_bytes() {
        let mut p = table_page_payload();
        p.push(0);
        assert_eq!(decode_table_page(&p, 10, 4096), Err(Errno::EINVAL));
    }

    #[test]
    fn rejects_table_page_truncated_run() {
        let mut p = table_page_payload();
        p.truncate(p.len() - 1); // drop the last recipe byte
        assert_eq!(decode_table_page(&p, 10, 4096), Err(Errno::EINVAL));
    }

    // --- Segment bitmap negatives -----------------------------------------

    fn segment_payload(segment_count: u32, bitmap: &[u8]) -> Vec<u8> {
        let mut p = alloc::vec![0u8; ELEMENT_SEGMENT_HEADER_SIZE + bitmap.len()];
        p[0..4].copy_from_slice(&segment_count.to_le_bytes());
        p[4..8].copy_from_slice(&(bitmap.len() as u32).to_le_bytes());
        p[ELEMENT_SEGMENT_HEADER_SIZE..].copy_from_slice(bitmap);
        p
    }

    #[test]
    fn decodes_segment_bitmaps() {
        let elements = decode_element_segments(&segment_payload(12, &[0xff, 0x0f])).unwrap();
        assert_eq!(elements.segment_count, 12);
        assert_eq!(elements.dropped, alloc::vec![0xff, 0x0f]);
        // A zero-segment bitmap has no bytes.
        let empty = decode_data_segments(&segment_payload(0, &[])).unwrap();
        assert_eq!(empty.segment_count, 0);
        assert!(empty.dropped.is_empty());
    }

    #[test]
    fn rejects_segment_bitmap_wrong_byte_count() {
        // 12 segments need 2 bytes; declare/provide only 1.
        assert_eq!(
            decode_element_segments(&segment_payload(12, &[0xff])),
            Err(Errno::EINVAL)
        );
    }

    #[test]
    fn rejects_segment_bitmap_nonzero_trailing_bits() {
        // 12 segments: last byte may only use its low 4 bits; set bit 4.
        assert_eq!(
            decode_element_segments(&segment_payload(12, &[0xff, 0x10])),
            Err(Errno::EINVAL)
        );
    }

    #[test]
    fn rejects_segment_bitmap_inconsistent_declared_bytes() {
        let mut p = segment_payload(8, &[0xff]);
        p[4..8].copy_from_slice(&2u32.to_le_bytes()); // claim 2 bytes, hold 1
        assert_eq!(decode_data_segments(&p), Err(Errno::EINVAL));
    }

    #[test]
    fn rejects_segment_bitmap_truncated_header() {
        assert_eq!(decode_element_segments(&[0, 0, 0]), Err(Errno::EINVAL));
    }

    // --- Panic-freedom sweeps ---------------------------------------------

    #[test]
    fn arbitrary_bytes_never_panic() {
        // Every prefix of the genuine fixture and each per-kind payload builder,
        // plus a corruption sweep, must decode to Ok or Err, never panic.
        for len in 0..=FIXTURE.len() {
            let slice = &FIXTURE[..len];
            let _ = decode_module_record(slice);
            let _ = decode_mutable_global(slice);
            let _ = decode_table_descriptor(slice);
            let _ = decode_table_page(slice, 10, 4096);
            let _ = decode_element_segments(slice);
            let _ = decode_data_segments(slice);
        }
    }

    #[test]
    fn single_byte_corruptions_never_panic() {
        let builders: [Vec<u8>; 5] = [
            module_payload(),
            global_payload(6, &[1, 2, 3, 4]),
            table_payload(),
            table_page_payload(),
            segment_payload(12, &[0xff, 0x0f]),
        ];
        for base in &builders {
            for offset in 0..base.len() {
                let mut bytes = base.clone();
                bytes[offset] ^= 0xff;
                let _ = decode_module_record(&bytes);
                let _ = decode_mutable_global(&bytes);
                let _ = decode_table_descriptor(&bytes);
                let _ = decode_table_page(&bytes, 10, 4096);
                let _ = decode_element_segments(&bytes);
                let _ = decode_data_segments(&bytes);
            }
        }
    }

    #[test]
    fn table_page_shift_sweep_never_panics() {
        // Sweep every possible shift (including out-of-range) against the fixture
        // page bytes to prove `1 << shift` and the bounds math never panic.
        let (mem, records) = decoded_fixture();
        let page_bytes = record_payload_bytes(&mem, &records[4]).unwrap();
        for shift in 0u8..=64 {
            let _ = decode_table_page(page_bytes, shift, 4096);
        }
    }
}
