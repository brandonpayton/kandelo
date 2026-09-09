//! Decoder for the fork GC codec (KFGC) structural descriptor.
//!
//! Ported from `host/src/fork-gc-codec.ts` (`decodeForkGcCodecDescriptor` plus
//! the `ForkGcCodecDescriptor` constructor validation and `validateLayoutPayload`).
//! The wire format is emitted by the Rust instrumenter
//! (`fork_instrument::module_gc_codec::encode_descriptor`) into the
//! `kandelo.wpk_fork.gc_codec` custom section; its structural constants live in
//! `crates/shared/src/lib.rs` (`WPK_FORK_GC_CODEC_*`).
//!
//! Layout recap (all little-endian):
//!
//! Descriptor header (`WPK_FORK_GC_CODEC_HEADER_SIZE` = 16 bytes): `+0` magic
//! `KFGC`, `+4` version, `+6` header size, `+8` layout count (u32), `+12` field
//! count (u32).
//!
//! Layout record (`WPK_FORK_GC_CODEC_LAYOUT_RECORD_SIZE` = 44 bytes): `+0` id
//! (u31), `+4` type ordinal, `+8` kind (u8), `+9` constructor (u8), `+10` flags
//! (u16), `+12` scalar length/stride, `+16` field start, `+20` field count,
//! `+24` super-type ordinal (`0xffff_ffff` => none), `+28` base layout id,
//! `+32` auxiliary, `+36` provenance scalar length, `+40` provenance reference
//! count.
//!
//! Field record (`WPK_FORK_GC_CODEC_FIELD_RECORD_SIZE` = 12 bytes): `+0` storage
//! (u8), `+1` flags (u8), `+2` reserved (u16, 0), `+4` scalar offset
//! (`0xffff_ffff` => none), `+8` reference ordinal (`0xffff_ffff` => none). All
//! field records are stored contiguously after the layout catalog; each layout
//! owns the slice `[field_start, field_start + field_count)`.
//!
//! Unlike `linked_frames` and `module_state`, this wire is NOT a linear-memory
//! pointer walk: it is a self-contained catalog of structural type evidence
//! (layouts + fields). This decoder is the STRUCTURAL/VALIDATION half: given the
//! section bytes it produces the owned, fully validated layout catalog, exactly
//! what `decodeForkGcCodecDescriptor` yields before it is wrapped in a
//! `ForkGcCodecDescriptor`. Every framing or consistency violation (bad
//! magic/version/sizes, non-canonical ids or field ranges, an inconsistent
//! base/constructor/provenance record, an out-of-order reference ordinal, a
//! scalar field overflow) yields `Err(Errno::EINVAL)`; the function never
//! panics.
//!
//! The LIVE half is deferred to the co-resident module (Phase 6 D5+): those
//! parts of `fork-gc-codec.ts` that are genuinely runtime-instance state rather
//! than a byte format. Specifically the `ForkGcProvenanceRegistry` (weak-keyed
//! constructor evidence keyed by real `WebAssembly.Table` GC objects, with its
//! begin/appendReference/end phase machine and fail-closed slot clearing), the
//! `forkGcCodecProviderFromInstance` binding of the five scalar-callable
//! `__wpk_fork_ref_gc_*` exports to a live `WebAssembly.Instance`, and the
//! `require`/`requireCaptureLayout` dynamic-dispatch lookups the registry drives.
//! Those own real GC references and instance exports, not a pure `&[u8]` decode,
//! exactly as `linked_frames` deferred its live allocator and `module_state`
//! deferred its per-record semantic sub-decoders.

use wasm_posix_shared::abi;
use wasm_posix_shared::Errno;

use alloc::collections::BTreeSet;
use alloc::vec::Vec;

const MAGIC: [u8; 4] = abi::WPK_FORK_GC_CODEC_MAGIC; // "KFGC"
const VERSION: u16 = abi::WPK_FORK_GC_CODEC_VERSION;
const HEADER_SIZE: u16 = abi::WPK_FORK_GC_CODEC_HEADER_SIZE;
const LAYOUT_RECORD_SIZE: u16 = abi::WPK_FORK_GC_CODEC_LAYOUT_RECORD_SIZE;
const FIELD_RECORD_SIZE: u16 = abi::WPK_FORK_GC_CODEC_FIELD_RECORD_SIZE;

/// `ForkGcLayoutKind`. Public so the drive-plan hints adapter
/// (`drive_plan_hints`) can match a recipe's kind against its layout descriptor,
/// exactly as the JS `validateGcRecipe` coordinate check does.
pub const KIND_STRUCT: u8 = 1;
pub const KIND_ARRAY: u8 = 2;

/// `ForkGcConstructorKind`. `CONSTRUCTOR_ARRAY_NEW` / `CONSTRUCTOR_ARRAY_FIXED`
/// are public so the drive-plan hints adapter can reproduce the array-constructor
/// dependency arms of the JS `gcAllocationDependencies`.
pub const CONSTRUCTOR_STRUCT: u8 = 0;
const CONSTRUCTOR_ARRAY_GENERIC: u8 = 1;
pub const CONSTRUCTOR_ARRAY_NEW: u8 = 2;
const CONSTRUCTOR_ARRAY_DEFAULT: u8 = 3;
pub const CONSTRUCTOR_ARRAY_FIXED: u8 = 4;
const CONSTRUCTOR_ARRAY_DATA: u8 = 5;
const CONSTRUCTOR_ARRAY_ELEMENT: u8 = 6;

const LAYOUT_FLAG_REQUIRES_PROVENANCE: u16 = 1 << 0;
/// A defaultable-shell layout is pre-allocated before the identity walk. Public
/// so the drive-plan hints adapter mirrors the JS `FORK_GC_LAYOUT_DEFAULTABLE_
/// SHELL` shell pre-allocate.
pub const LAYOUT_FLAG_DEFAULTABLE_SHELL: u16 = 1 << 1;
const LAYOUT_KNOWN_FLAGS: u16 = LAYOUT_FLAG_REQUIRES_PROVENANCE | LAYOUT_FLAG_DEFAULTABLE_SHELL;

const FIELD_FLAG_MUTABLE: u8 = 1 << 0;
const FIELD_FLAG_NULLABLE: u8 = 1 << 1;
/// A reference field (storage == `STORAGE_REFERENCE`). Public so the drive-plan
/// hints adapter mirrors the JS `FORK_GC_FIELD_REFERENCE` array-element check.
pub const FIELD_FLAG_REFERENCE: u8 = 1 << 2;
/// A constructor (allocation-time) dependency field. Public so the drive-plan
/// hints adapter mirrors the JS `FORK_GC_FIELD_ALLOCATION_DEPENDENCY` struct arm.
pub const FIELD_FLAG_ALLOCATION_DEPENDENCY: u8 = 1 << 3;
const FIELD_KNOWN_FLAGS: u8 = FIELD_FLAG_MUTABLE
    | FIELD_FLAG_NULLABLE
    | FIELD_FLAG_REFERENCE
    | FIELD_FLAG_ALLOCATION_DEPENDENCY;

const STORAGE_REFERENCE: u8 = 8;
const NO_ORDINAL: u32 = u32::MAX;
const MAX_U31: u32 = 0x7fff_ffff;
const U32_MAX_AS_U64: u64 = 0xffff_ffff;

/// One decoded GC field descriptor. Mirrors the TS `ForkGcFieldDescriptor`:
/// `scalar_offset` and `reference_ordinal` are mutually exclusive (a
/// `0xffff_ffff` sentinel decodes to `None`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct GcFieldDescriptor {
    pub storage: u8,
    pub flags: u8,
    pub scalar_offset: Option<u32>,
    pub reference_ordinal: Option<u32>,
}

/// One decoded GC layout descriptor. Mirrors the TS `ForkGcLayoutDescriptor`.
/// A base layout has `base_layout_id == id`; a specialized constructor layout
/// points `base_layout_id` at its base and carries constructor-only provenance.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GcLayoutDescriptor {
    pub id: u32,
    pub type_ordinal: u32,
    pub kind: u8,
    pub constructor: u8,
    pub flags: u16,
    pub scalar_length_or_stride: u32,
    pub fields: Vec<GcFieldDescriptor>,
    pub super_type_ordinal: Option<u32>,
    pub base_layout_id: u32,
    pub auxiliary: u32,
    pub provenance_scalar_length: u32,
    pub provenance_reference_count: u32,
}

/// The fully decoded and validated GC codec descriptor: the canonical,
/// id-ordered layout catalog. Mirrors what `decodeForkGcCodecDescriptor`
/// produces (before the live `ForkGcCodecDescriptor` wrapper, whose dynamic
/// lookups are the deferred runtime half; see the module doc comment).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GcCodec {
    pub layouts: Vec<GcLayoutDescriptor>,
}

/// Bounds-checked little-endian `u8` read.
fn r_u8(bytes: &[u8], off: u64) -> Result<u8, Errno> {
    let off = usize::try_from(off).map_err(|_| Errno::EINVAL)?;
    bytes.get(off).copied().ok_or(Errno::EINVAL)
}

/// Bounds-checked little-endian `u16` read.
fn r_u16(bytes: &[u8], off: u64) -> Result<u16, Errno> {
    let off = usize::try_from(off).map_err(|_| Errno::EINVAL)?;
    let end = off.checked_add(2).ok_or(Errno::EINVAL)?;
    let slice = bytes.get(off..end).ok_or(Errno::EINVAL)?;
    Ok(u16::from_le_bytes([slice[0], slice[1]]))
}

/// Bounds-checked little-endian `u32` read.
fn r_u32(bytes: &[u8], off: u64) -> Result<u32, Errno> {
    let off = usize::try_from(off).map_err(|_| Errno::EINVAL)?;
    let end = off.checked_add(4).ok_or(Errno::EINVAL)?;
    let slice = bytes.get(off..end).ok_or(Errno::EINVAL)?;
    Ok(u32::from_le_bytes([slice[0], slice[1], slice[2], slice[3]]))
}

/// `left * right` as a `u64`, rejecting a product that overflows the u32 wire
/// format. Mirrors the TS `checkedProduct`.
fn checked_product(left: u32, right: u16) -> Result<u64, Errno> {
    let result = (left as u64) * (right as u64);
    if result > U32_MAX_AS_U64 {
        return Err(Errno::EINVAL);
    }
    Ok(result)
}

/// Byte width of a GC storage code. Mirrors the TS `storageByteLength`.
fn storage_byte_length(storage: u8) -> Result<u64, Errno> {
    match storage {
        1 => Ok(1),
        2 => Ok(2),
        3 | 5 => Ok(4),
        4 | 6 => Ok(8),
        7 => Ok(16),
        8 => Ok(4),
        _ => Err(Errno::EINVAL),
    }
}

/// A raw layout record before its field slice is resolved.
struct RawLayout {
    id: u32,
    type_ordinal: u32,
    kind: u8,
    constructor: u8,
    flags: u16,
    scalar_length_or_stride: u32,
    field_start: u32,
    field_count: u32,
    super_type_ordinal: Option<u32>,
    base_layout_id: u32,
    auxiliary: u32,
    provenance_scalar_length: u32,
    provenance_reference_count: u32,
}

/// Decode and validate a `kandelo.wpk_fork.gc_codec` descriptor.
///
/// `bytes` is the raw custom-section payload. Returns the canonical, fully
/// validated layout catalog. Any framing or consistency violation yields
/// `Err(Errno::EINVAL)`; the function never panics.
///
/// Mirrors `decodeForkGcCodecDescriptor` plus the `ForkGcCodecDescriptor`
/// constructor validation and `validateLayoutPayload` in
/// `host/src/fork-gc-codec.ts`.
pub fn decode_gc_codec(bytes: &[u8]) -> Result<GcCodec, Errno> {
    if bytes.len() < HEADER_SIZE as usize {
        return Err(Errno::EINVAL); // truncated header
    }
    if bytes.get(0..4) != Some(&MAGIC[..]) {
        return Err(Errno::EINVAL); // invalid magic
    }
    if r_u16(bytes, 4)? != VERSION || r_u16(bytes, 6)? != HEADER_SIZE {
        return Err(Errno::EINVAL); // unsupported version/header
    }
    let layout_count = r_u32(bytes, 8)?;
    let field_count = r_u32(bytes, 12)?;
    let layouts_length = checked_product(layout_count, LAYOUT_RECORD_SIZE)?;
    let fields_length = checked_product(field_count, FIELD_RECORD_SIZE)?;
    let expected_length = (HEADER_SIZE as u64)
        .checked_add(layouts_length)
        .and_then(|value| value.checked_add(fields_length))
        .ok_or(Errno::EINVAL)?;
    if expected_length != bytes.len() as u64 {
        return Err(Errno::EINVAL); // inconsistent bounds
    }

    // --- Layout catalog --------------------------------------------------
    let mut raw_layouts: Vec<RawLayout> = Vec::with_capacity(layout_count as usize);
    let mut expected_field_start: u32 = 0;
    for index in 0..layout_count as u64 {
        let offset = HEADER_SIZE as u64 + index * LAYOUT_RECORD_SIZE as u64;
        let id = r_u32(bytes, offset)?;
        if id == 0 || id > MAX_U31 {
            return Err(Errno::EINVAL); // id is not a nonzero u31
        }
        let kind = r_u8(bytes, offset + 8)?;
        let constructor = r_u8(bytes, offset + 9)?;
        let flags = r_u16(bytes, offset + 10)?;
        let field_start = r_u32(bytes, offset + 16)?;
        let layout_field_count = r_u32(bytes, offset + 20)?;
        // WHY: `field_count - min(field_start, field_count)` is the count of
        // field records still unowned; a layout may not claim more than remain.
        let remaining = field_count - field_start.min(field_count);
        if (kind != KIND_STRUCT && kind != KIND_ARRAY)
            || constructor > CONSTRUCTOR_ARRAY_ELEMENT
            || flags & !LAYOUT_KNOWN_FLAGS != 0
            || field_start != expected_field_start
            || layout_field_count > remaining
        {
            return Err(Errno::EINVAL); // unsupported kind/flags/range
        }
        expected_field_start = expected_field_start
            .checked_add(layout_field_count)
            .ok_or(Errno::EINVAL)?;
        let super_raw = r_u32(bytes, offset + 24)?;
        raw_layouts.push(RawLayout {
            id,
            type_ordinal: r_u32(bytes, offset + 4)?,
            kind,
            constructor,
            flags,
            scalar_length_or_stride: r_u32(bytes, offset + 12)?,
            field_start,
            field_count: layout_field_count,
            super_type_ordinal: (super_raw != NO_ORDINAL).then_some(super_raw),
            base_layout_id: r_u32(bytes, offset + 28)?,
            auxiliary: r_u32(bytes, offset + 32)?,
            provenance_scalar_length: r_u32(bytes, offset + 36)?,
            provenance_reference_count: r_u32(bytes, offset + 40)?,
        });
    }
    if expected_field_start != field_count {
        return Err(Errno::EINVAL); // unowned field records
    }

    // --- Field catalog ---------------------------------------------------
    let mut fields: Vec<GcFieldDescriptor> = Vec::with_capacity(field_count as usize);
    let fields_offset = HEADER_SIZE as u64 + layouts_length;
    for index in 0..field_count as u64 {
        let offset = fields_offset + index * FIELD_RECORD_SIZE as u64;
        let storage = r_u8(bytes, offset)?;
        let flags = r_u8(bytes, offset + 1)?;
        let reserved = r_u16(bytes, offset + 2)?;
        let scalar_offset = r_u32(bytes, offset + 4)?;
        let reference_ordinal = r_u32(bytes, offset + 8)?;
        let is_reference = flags & FIELD_FLAG_REFERENCE != 0;
        if !(1..=STORAGE_REFERENCE).contains(&storage)
            || flags & !FIELD_KNOWN_FLAGS != 0
            || reserved != 0
            || (is_reference && (scalar_offset != NO_ORDINAL || reference_ordinal == NO_ORDINAL))
            || (!is_reference && (scalar_offset == NO_ORDINAL || reference_ordinal != NO_ORDINAL))
        {
            return Err(Errno::EINVAL); // malformed field
        }
        fields.push(GcFieldDescriptor {
            storage,
            flags,
            scalar_offset: (scalar_offset != NO_ORDINAL).then_some(scalar_offset),
            reference_ordinal: (reference_ordinal != NO_ORDINAL).then_some(reference_ordinal),
        });
    }

    // --- Resolve field slices --------------------------------------------
    let mut layouts: Vec<GcLayoutDescriptor> = Vec::with_capacity(raw_layouts.len());
    for raw in raw_layouts {
        if raw.field_start > field_count || raw.field_count > field_count - raw.field_start {
            return Err(Errno::EINVAL); // field range out of bounds
        }
        let start = raw.field_start as usize;
        let end = start + raw.field_count as usize;
        let selected = fields
            .get(start..end)
            .ok_or(Errno::EINVAL)?
            .to_vec();
        if (raw.kind == KIND_ARRAY && selected.len() != 1)
            || (raw.kind == KIND_STRUCT && raw.constructor != CONSTRUCTOR_STRUCT)
        {
            return Err(Errno::EINVAL); // inconsistent shape
        }
        layouts.push(GcLayoutDescriptor {
            id: raw.id,
            type_ordinal: raw.type_ordinal,
            kind: raw.kind,
            constructor: raw.constructor,
            flags: raw.flags,
            scalar_length_or_stride: raw.scalar_length_or_stride,
            fields: selected,
            super_type_ordinal: raw.super_type_ordinal,
            base_layout_id: raw.base_layout_id,
            auxiliary: raw.auxiliary,
            provenance_scalar_length: raw.provenance_scalar_length,
            provenance_reference_count: raw.provenance_reference_count,
        });
    }

    validate_catalog(&layouts)?;
    Ok(GcCodec { layouts })
}

/// Cross-layout validation. Mirrors the `ForkGcCodecDescriptor` constructor:
/// canonical id order, unique base layout per type ordinal, and every layout's
/// base/constructor/provenance coherence plus its per-field payload.
fn validate_catalog(layouts: &[GcLayoutDescriptor]) -> Result<(), Errno> {
    let mut base_type_ordinals: BTreeSet<u32> = BTreeSet::new();
    for (index, layout) in layouts.iter().enumerate() {
        if layout.id as usize != index + 1 {
            return Err(Errno::EINVAL); // not in canonical id order
        }
        if layout.base_layout_id == layout.id && !base_type_ordinals.insert(layout.type_ordinal) {
            return Err(Errno::EINVAL); // multiple base layouts for a type ordinal
        }
    }

    for layout in layouts {
        // The base layout is looked up by id; canonical ordering guarantees
        // `layouts[id - 1].id == id`.
        let base = layout
            .base_layout_id
            .checked_sub(1)
            .and_then(|base_index| layouts.get(base_index as usize))
            .ok_or(Errno::EINVAL)?;
        if base.base_layout_id != base.id
            || base.type_ordinal != layout.type_ordinal
            || base.kind != layout.kind
            || (layout.id != base.id && layout.constructor == CONSTRUCTOR_ARRAY_GENERIC)
        {
            return Err(Errno::EINVAL); // invalid base layout
        }

        let constructor_ok = if layout.kind == KIND_STRUCT {
            layout.constructor == CONSTRUCTOR_STRUCT
        } else if layout.fields.len() != 1 {
            false
        } else if layout.id == base.id {
            layout.constructor == CONSTRUCTOR_ARRAY_GENERIC
        } else {
            layout.constructor != CONSTRUCTOR_ARRAY_GENERIC
        };
        if !constructor_ok {
            return Err(Errno::EINVAL); // invalid constructor
        }

        if layout.id != base.id
            && (layout.scalar_length_or_stride != base.scalar_length_or_stride
                || layout.super_type_ordinal != base.super_type_ordinal
                || layout.flags != base.flags | LAYOUT_FLAG_REQUIRES_PROVENANCE
                || !same_fields(&layout.fields, &base.fields))
        {
            return Err(Errno::EINVAL); // constructor does not match base
        }

        if layout.provenance_scalar_length > 16
            || (layout.flags & LAYOUT_FLAG_REQUIRES_PROVENANCE == 0
                && (layout.provenance_scalar_length != 0 || layout.provenance_reference_count != 0))
        {
            return Err(Errno::EINVAL); // invalid provenance
        }

        validate_layout_payload(layout)?;
    }
    Ok(())
}

/// Structural equality of two field slices. Mirrors the TS `sameFields`.
fn same_fields(left: &[GcFieldDescriptor], right: &[GcFieldDescriptor]) -> bool {
    left == right
}

/// Per-field payload validation. Mirrors the TS `validateLayoutPayload`.
fn validate_layout_payload(layout: &GcLayoutDescriptor) -> Result<(), Errno> {
    let mut expected_reference_ordinal: u32 = 0;
    let mut minimum_scalar_length: u64 = 0;
    for field in &layout.fields {
        let is_reference = field.flags & FIELD_FLAG_REFERENCE != 0;
        let is_mutable = field.flags & FIELD_FLAG_MUTABLE != 0;
        let is_nullable = field.flags & FIELD_FLAG_NULLABLE != 0;
        let is_dependency = field.flags & FIELD_FLAG_ALLOCATION_DEPENDENCY != 0;
        if is_reference != (field.storage == STORAGE_REFERENCE)
            || (!is_reference && (is_nullable || is_dependency))
            || (is_dependency && is_mutable)
        {
            return Err(Errno::EINVAL); // inconsistent flags
        }
        if is_reference {
            if field.reference_ordinal != Some(expected_reference_ordinal) {
                return Err(Errno::EINVAL); // noncanonical reference ordinal
            }
            expected_reference_ordinal += 1;
            continue;
        }
        let scalar_offset = field.scalar_offset.ok_or(Errno::EINVAL)?;
        let end = (scalar_offset as u64)
            .checked_add(storage_byte_length(field.storage)?)
            .ok_or(Errno::EINVAL)?;
        if end > U32_MAX_AS_U64 || (scalar_offset as u64) < minimum_scalar_length {
            return Err(Errno::EINVAL); // invalid scalar offset
        }
        minimum_scalar_length = end;
    }

    if layout.kind == KIND_STRUCT
        && minimum_scalar_length > layout.scalar_length_or_stride as u64
    {
        return Err(Errno::EINVAL); // struct scalar fields overflow
    }
    if layout.kind == KIND_ARRAY {
        let element = layout.fields.first().ok_or(Errno::EINVAL)?;
        if element.storage != STORAGE_REFERENCE
            && layout.scalar_length_or_stride as u64 != storage_byte_length(element.storage)?
        {
            return Err(Errno::EINVAL); // invalid array stride
        }
    }

    let scalar = layout.provenance_scalar_length;
    let refs = layout.provenance_reference_count;
    let malformed = match layout.constructor {
        CONSTRUCTOR_STRUCT => scalar != 0,
        CONSTRUCTOR_ARRAY_GENERIC | CONSTRUCTOR_ARRAY_DEFAULT => scalar != 0 || refs != 0,
        CONSTRUCTOR_ARRAY_FIXED => scalar != 0 || (refs != 0 && refs != layout.auxiliary),
        CONSTRUCTOR_ARRAY_NEW => refs > 1 || (refs != 0 && scalar != 0),
        CONSTRUCTOR_ARRAY_DATA => {
            layout.fields[0].storage == STORAGE_REFERENCE || scalar != 8 || refs != 0
        }
        CONSTRUCTOR_ARRAY_ELEMENT => {
            layout.fields[0].storage != STORAGE_REFERENCE || scalar != 8 || refs != 0
        }
        _ => true,
    };
    if malformed {
        return Err(Errno::EINVAL);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    // --- Cross-language fixture (emitted by the real Rust encoder) --------

    /// Bytes are the `kandelo.wpk_fork.gc_codec` descriptor emitted by the REAL
    /// Rust instrumenter (`fork_instrument::module_gc_codec::encode_descriptor`)
    /// over a real GC-typed module, via
    /// `crates/fork-codec/tests/gen_gc_codec_fixture.rs`. The same committed
    /// bytes are decoded field-for-field by the REAL host TypeScript decoder in
    /// `crates/fork-codec/testdata/gen-gc-codec-fixture.mts`; if the encoder and
    /// either decoder ever disagree on the wire format, that oracle and this
    /// test catch the drift.
    const TS_FIXTURE: &[u8] = include_bytes!("../testdata/gc-codec-wasm32.bin");

    fn field(
        storage: u8,
        flags: u8,
        scalar_offset: Option<u32>,
        reference_ordinal: Option<u32>,
    ) -> GcFieldDescriptor {
        GcFieldDescriptor {
            storage,
            flags,
            scalar_offset,
            reference_ordinal,
        }
    }

    #[test]
    fn decodes_real_encoder_fixture_field_for_field() {
        let decoded = decode_gc_codec(TS_FIXTURE).unwrap();
        assert_eq!(decoded.layouts.len(), 7);

        // Layout 1: the $node struct — one mutable i32 scalar and two mutable
        // nullable internal reference fields.
        let l1 = &decoded.layouts[0];
        assert_eq!(l1.id, 1);
        assert_eq!(l1.type_ordinal, 0);
        assert_eq!(l1.kind, KIND_STRUCT);
        assert_eq!(l1.constructor, CONSTRUCTOR_STRUCT);
        assert_eq!(l1.flags, LAYOUT_FLAG_DEFAULTABLE_SHELL);
        assert_eq!(l1.scalar_length_or_stride, 4);
        assert_eq!(l1.super_type_ordinal, None);
        assert_eq!(l1.base_layout_id, 1);
        assert_eq!(l1.auxiliary, 0);
        assert_eq!(l1.provenance_scalar_length, 0);
        assert_eq!(l1.provenance_reference_count, 0);
        assert_eq!(
            l1.fields,
            alloc::vec![
                field(3, FIELD_FLAG_MUTABLE, Some(0), None),
                field(8, 7, None, Some(0)),
                field(8, 7, None, Some(1)),
            ]
        );

        // Layouts 2-4: the base array layouts (ArrayGeneric, requires provenance).
        let l2 = &decoded.layouts[1];
        assert_eq!(l2.id, 2);
        assert_eq!(l2.type_ordinal, 1);
        assert_eq!(l2.kind, KIND_ARRAY);
        assert_eq!(l2.constructor, CONSTRUCTOR_ARRAY_GENERIC);
        assert_eq!(l2.flags, LAYOUT_FLAG_REQUIRES_PROVENANCE);
        assert_eq!(l2.scalar_length_or_stride, 2);
        assert_eq!(l2.base_layout_id, 2);
        assert_eq!(l2.fields, alloc::vec![field(2, 0, Some(0), None)]);

        let l3 = &decoded.layouts[2];
        assert_eq!(l3.id, 3);
        assert_eq!(l3.scalar_length_or_stride, 1);
        assert_eq!(l3.base_layout_id, 3);
        assert_eq!(l3.fields, alloc::vec![field(1, 0, Some(0), None)]);

        let l4 = &decoded.layouts[3];
        assert_eq!(l4.id, 4);
        assert_eq!(l4.type_ordinal, 3);
        assert_eq!(l4.constructor, CONSTRUCTOR_ARRAY_GENERIC);
        assert_eq!(l4.scalar_length_or_stride, 0);
        assert_eq!(l4.base_layout_id, 4);
        // The nullable-array element reference is a nullable allocation
        // dependency (flags NULLABLE|REFERENCE|ALLOCATION_DEPENDENCY = 14).
        assert_eq!(l4.fields, alloc::vec![field(8, 14, None, Some(0))]);

        // Layout 5: array.new_fixed specialization of layout 2 (auxiliary = len).
        let l5 = &decoded.layouts[4];
        assert_eq!(l5.id, 5);
        assert_eq!(l5.type_ordinal, 1);
        assert_eq!(l5.constructor, CONSTRUCTOR_ARRAY_FIXED);
        assert_eq!(l5.flags, LAYOUT_FLAG_REQUIRES_PROVENANCE);
        assert_eq!(l5.base_layout_id, 2);
        assert_eq!(l5.auxiliary, 2);
        assert_eq!(l5.provenance_scalar_length, 0);
        assert_eq!(l5.provenance_reference_count, 0);
        assert_eq!(l5.fields, l2.fields);

        // Layout 6: array.new_data specialization of layout 3 (8 scalar seed bytes).
        let l6 = &decoded.layouts[5];
        assert_eq!(l6.id, 6);
        assert_eq!(l6.constructor, CONSTRUCTOR_ARRAY_DATA);
        assert_eq!(l6.base_layout_id, 3);
        assert_eq!(l6.provenance_scalar_length, 8);
        assert_eq!(l6.provenance_reference_count, 0);

        // Layout 7: array.new specialization of layout 4 (one seed reference).
        let l7 = &decoded.layouts[6];
        assert_eq!(l7.id, 7);
        assert_eq!(l7.constructor, CONSTRUCTOR_ARRAY_NEW);
        assert_eq!(l7.base_layout_id, 4);
        assert_eq!(l7.provenance_scalar_length, 0);
        assert_eq!(l7.provenance_reference_count, 1);
        assert_eq!(l7.fields, l4.fields);
    }

    #[test]
    fn fixture_is_non_vacuous() {
        // Guard against a fixture that silently collapses to an empty or trivial
        // catalog (which would make the field-for-field test vacuously pass).
        let decoded = decode_gc_codec(TS_FIXTURE).unwrap();
        assert!(decoded.layouts.len() >= 2);
        let total_fields: usize = decoded.layouts.iter().map(|l| l.fields.len()).sum();
        assert_eq!(total_fields, 9);
        // Distinct kinds, constructors, and a specialized (non-base) layout.
        assert!(decoded.layouts.iter().any(|l| l.kind == KIND_STRUCT));
        assert!(decoded.layouts.iter().any(|l| l.kind == KIND_ARRAY));
        assert!(decoded.layouts.iter().any(|l| l.id != l.base_layout_id));
        assert!(decoded
            .layouts
            .iter()
            .any(|l| l.fields.iter().any(|f| f.storage == STORAGE_REFERENCE)));
        assert!(decoded
            .layouts
            .iter()
            .any(|l| l.fields.iter().any(|f| f.reference_ordinal.is_none())));
    }

    // --- Hand-built minimal descriptor (targeted framing/validation) ------

    fn put_u16(bytes: &mut [u8], off: usize, value: u16) {
        bytes[off..off + 2].copy_from_slice(&value.to_le_bytes());
    }

    fn put_u32(bytes: &mut [u8], off: usize, value: u32) {
        bytes[off..off + 4].copy_from_slice(&value.to_le_bytes());
    }

    /// Build the canonical single-struct-layout descriptor the host vitest suite
    /// hand-assembles (`descriptorBytes()` in host/test/fork-gc-codec.test.ts):
    /// one struct layout with a single mutable reference field and one required
    /// provenance reference.
    fn minimal_descriptor() -> Vec<u8> {
        let mut bytes = alloc::vec![
            0u8;
            HEADER_SIZE as usize + LAYOUT_RECORD_SIZE as usize + FIELD_RECORD_SIZE as usize
        ];
        bytes[0..4].copy_from_slice(&MAGIC);
        put_u16(&mut bytes, 4, VERSION);
        put_u16(&mut bytes, 6, HEADER_SIZE);
        put_u32(&mut bytes, 8, 1); // layout count
        put_u32(&mut bytes, 12, 1); // field count

        let layout = HEADER_SIZE as usize;
        put_u32(&mut bytes, layout, 1); // id
        put_u32(&mut bytes, layout + 4, 0); // type ordinal
        bytes[layout + 8] = KIND_STRUCT;
        bytes[layout + 9] = CONSTRUCTOR_STRUCT;
        put_u16(&mut bytes, layout + 10, LAYOUT_FLAG_REQUIRES_PROVENANCE);
        put_u32(&mut bytes, layout + 12, 0); // scalar length/stride
        put_u32(&mut bytes, layout + 16, 0); // field start
        put_u32(&mut bytes, layout + 20, 1); // field count
        put_u32(&mut bytes, layout + 24, NO_ORDINAL); // super-type ordinal
        put_u32(&mut bytes, layout + 28, 1); // base layout id
        put_u32(&mut bytes, layout + 32, 0); // auxiliary
        put_u32(&mut bytes, layout + 36, 0); // provenance scalar length
        put_u32(&mut bytes, layout + 40, 1); // provenance reference count

        let f = layout + LAYOUT_RECORD_SIZE as usize;
        bytes[f] = STORAGE_REFERENCE;
        bytes[f + 1] = FIELD_FLAG_MUTABLE | FIELD_FLAG_REFERENCE;
        put_u32(&mut bytes, f + 4, NO_ORDINAL); // scalar offset
        put_u32(&mut bytes, f + 8, 0); // reference ordinal
        bytes
    }

    #[test]
    fn decodes_minimal_descriptor() {
        let decoded = decode_gc_codec(&minimal_descriptor()).unwrap();
        assert_eq!(decoded.layouts.len(), 1);
        let layout = &decoded.layouts[0];
        assert_eq!(layout.id, 1);
        assert_eq!(layout.kind, KIND_STRUCT);
        assert_eq!(layout.provenance_reference_count, 1);
        assert_eq!(
            layout.fields,
            alloc::vec![field(
                8,
                FIELD_FLAG_MUTABLE | FIELD_FLAG_REFERENCE,
                None,
                Some(0)
            )]
        );
    }

    fn decode_mutated(mutate: impl FnOnce(&mut Vec<u8>)) -> Result<GcCodec, Errno> {
        let mut bytes = minimal_descriptor();
        mutate(&mut bytes);
        decode_gc_codec(&bytes)
    }

    #[test]
    fn rejects_truncated_header() {
        let bytes = minimal_descriptor();
        assert_eq!(
            decode_gc_codec(&bytes[..HEADER_SIZE as usize - 1]),
            Err(Errno::EINVAL)
        );
    }

    #[test]
    fn rejects_bad_magic() {
        assert_eq!(decode_mutated(|b| b[0] ^= 0xff), Err(Errno::EINVAL));
    }

    #[test]
    fn rejects_bad_version_and_header_size() {
        assert_eq!(
            decode_mutated(|b| put_u16(b, 4, VERSION + 1)),
            Err(Errno::EINVAL)
        );
        assert_eq!(
            decode_mutated(|b| put_u16(b, 6, HEADER_SIZE + 1)),
            Err(Errno::EINVAL)
        );
    }

    #[test]
    fn rejects_length_disagreeing_with_counts() {
        // A field count that no longer matches the byte length.
        assert_eq!(decode_mutated(|b| put_u32(b, 12, 2)), Err(Errno::EINVAL));
        // A trailing byte the header does not account for.
        assert_eq!(decode_mutated(|b| b.push(0)), Err(Errno::EINVAL));
    }

    #[test]
    fn rejects_zero_layout_id() {
        assert_eq!(
            decode_mutated(|b| put_u32(b, HEADER_SIZE as usize, 0)),
            Err(Errno::EINVAL)
        );
    }

    #[test]
    fn rejects_noncanonical_layout_id() {
        assert_eq!(
            decode_mutated(|b| put_u32(b, HEADER_SIZE as usize, 2)),
            Err(Errno::EINVAL)
        );
    }

    #[test]
    fn rejects_unknown_kind_and_constructor_and_flags() {
        let layout = HEADER_SIZE as usize;
        assert_eq!(decode_mutated(|b| b[layout + 8] = 3), Err(Errno::EINVAL));
        assert_eq!(decode_mutated(|b| b[layout + 9] = 7), Err(Errno::EINVAL));
        assert_eq!(
            decode_mutated(|b| put_u16(b, layout + 10, 0x8000)),
            Err(Errno::EINVAL)
        );
    }

    #[test]
    fn rejects_noncanonical_field_start() {
        assert_eq!(
            decode_mutated(|b| put_u32(b, HEADER_SIZE as usize + 16, 1)),
            Err(Errno::EINVAL)
        );
    }

    #[test]
    fn rejects_field_reserved_nonzero() {
        let f = HEADER_SIZE as usize + LAYOUT_RECORD_SIZE as usize;
        assert_eq!(
            decode_mutated(|b| put_u16(b, f + 2, 1)),
            Err(Errno::EINVAL)
        );
    }

    #[test]
    fn rejects_reference_field_with_scalar_offset() {
        // A reference field must carry no scalar offset and a real ordinal.
        let f = HEADER_SIZE as usize + LAYOUT_RECORD_SIZE as usize;
        assert_eq!(decode_mutated(|b| put_u32(b, f + 4, 0)), Err(Errno::EINVAL));
        assert_eq!(
            decode_mutated(|b| put_u32(b, f + 8, NO_ORDINAL)),
            Err(Errno::EINVAL)
        );
    }

    #[test]
    fn rejects_unknown_field_flag() {
        let f = HEADER_SIZE as usize + LAYOUT_RECORD_SIZE as usize;
        assert_eq!(decode_mutated(|b| b[f + 1] |= 0x80), Err(Errno::EINVAL));
    }

    #[test]
    fn rejects_inconsistent_base_flags() {
        // Drop the REQUIRES_PROVENANCE bit while keeping a nonzero provenance
        // reference count: `validateLayoutPayload`'s provenance guard rejects it.
        assert_eq!(
            decode_mutated(|b| put_u16(b, HEADER_SIZE as usize + 10, 0)),
            Err(Errno::EINVAL)
        );
    }

    #[test]
    fn rejects_oversized_provenance_scalar_length() {
        assert_eq!(
            decode_mutated(|b| put_u32(b, HEADER_SIZE as usize + 36, 17)),
            Err(Errno::EINVAL)
        );
    }

    #[test]
    fn rejects_struct_with_nonstruct_constructor() {
        assert_eq!(
            decode_mutated(|b| b[HEADER_SIZE as usize + 9] = CONSTRUCTOR_ARRAY_GENERIC),
            Err(Errno::EINVAL)
        );
    }

    // --- Fixture-based negatives (mutations of the genuine fixture) -------

    fn decode_mutated_fixture(mutate: impl FnOnce(&mut Vec<u8>)) -> Result<GcCodec, Errno> {
        let mut bytes = TS_FIXTURE.to_vec();
        mutate(&mut bytes);
        decode_gc_codec(&bytes)
    }

    #[test]
    fn rejects_noncanonical_reference_ordinal_in_fixture() {
        // Layout 1's second field is reference ordinal 0; forcing it to 1 breaks
        // the canonical ordinal walk in `validateLayoutPayload`.
        let field_base = HEADER_SIZE as usize + 7 * LAYOUT_RECORD_SIZE as usize;
        let second_field = field_base + FIELD_RECORD_SIZE as usize;
        assert_eq!(
            decode_mutated_fixture(|b| put_u32(b, second_field + 8, 1)),
            Err(Errno::EINVAL)
        );
    }

    #[test]
    fn rejects_specialized_layout_flag_mismatch_in_fixture() {
        // Layout 5 (a specialization of layout 2) must carry exactly the base
        // flags | REQUIRES_PROVENANCE; adding DEFAULTABLE_SHELL diverges from the
        // base and is rejected.
        let layout5 = HEADER_SIZE as usize + 4 * LAYOUT_RECORD_SIZE as usize;
        assert_eq!(
            decode_mutated_fixture(|b| put_u16(b, layout5 + 10, LAYOUT_KNOWN_FLAGS)),
            Err(Errno::EINVAL)
        );
    }

    // --- Panic-freedom on arbitrary bytes --------------------------------

    #[test]
    fn arbitrary_truncations_never_panic() {
        // Every prefix of the genuine fixture must decode to Ok or Err, no panic.
        for len in 0..=TS_FIXTURE.len() {
            let _ = decode_gc_codec(&TS_FIXTURE[..len]);
        }
        let _ = decode_gc_codec(&[]);
        let _ = decode_gc_codec(&[0u8]);
    }

    #[test]
    fn single_byte_corruptions_never_panic() {
        // Corrupt each byte of the genuine fixture and confirm the decoder stays
        // panic-free (Ok or Err, either is fine).
        for offset in 0..TS_FIXTURE.len() {
            let mut bytes = TS_FIXTURE.to_vec();
            bytes[offset] ^= 0xff;
            let _ = decode_gc_codec(&bytes);
        }
        // Also sweep the hand-built minimal descriptor.
        let base = minimal_descriptor();
        for offset in 0..base.len() {
            let mut bytes = base.clone();
            bytes[offset] ^= 0xff;
            let _ = decode_gc_codec(&bytes);
        }
    }
}
