//! Decoder for the fork exact-tag exception codec descriptor
//! (`kandelo.wpk_fork.exception_codec`).
//!
//! Ported from `readForkExceptionCodecDescriptor` in
//! `host/src/fork-exception-provider.ts`. The wire format is emitted by the Rust
//! instrumenter (`fork_instrument::module_exception_codec`, specifically its
//! `replace_descriptor`, reached through `module_exception_codec::inject`) into
//! the `kandelo.wpk_fork.exception_codec` custom section; its structural
//! constants live in `crates/shared/src/lib.rs` (`WPK_FORK_EXCEPTION_CODEC_*`).
//! The host runtime only DECODES this section — there is no TypeScript encoder —
//! so the committed cross-language fixture is emitted by the REAL Rust encoder
//! (see `crates/fork-codec/tests/gen_exception_codec_fixture.rs`) and
//! cross-checked by the real host decoder
//! (`testdata/gen-exception-codec-fixture.mts`).
//!
//! Layout recap (all little-endian):
//!
//! Descriptor header (`WPK_FORK_EXCEPTION_CODEC_HEADER_SIZE` = 8 bytes): `+0`
//! version (u8), `+1` reserved (u8, 0), `+2` reserved (u16, 0), `+4` tag record
//! count (u32).
//!
//! Tag record (`WPK_FORK_EXCEPTION_CODEC_TAG_RECORD_SIZE` = 16 bytes): `+0` tag
//! ordinal (u32, canonical — equals the record index), `+4` layout id (u32, a
//! u31: `<= 0x7fff_ffff`, unique across records), `+8` scalar payload byte
//! length (u32), `+12` reference payload count (u32). The exact concrete tag and
//! payload types are bound by the module template hash; this descriptor binds
//! their deterministic codec ordinals and byte layout.
//!
//! This is the pure `&[u8] -> struct` STRUCTURAL/VALIDATION half: given the
//! section bytes it produces the owned, fully validated tag catalog, exactly
//! what `readForkExceptionCodecDescriptor` yields. Every framing or consistency
//! violation (bad version, a nonzero reserved field, a size that disagrees with
//! the record count, a noncanonical tag ordinal, or a reserved/duplicated layout
//! id) yields `Err(Errno::EINVAL)`; the function never panics.
//!
//! The LIVE/engine-floor half is deferred to the co-resident module (Phase 6
//! D5+): everything in `host/src/fork-exception-provider.ts` and
//! `host/src/fork-worker-import-exceptions.ts` that is genuinely runtime-instance
//! state rather than a byte image. Specifically the per-activation
//! `WebAssembly.Tag` creation and Store-local exact-tag codec resolution
//! (`forkExceptionProviderFromInstance`, which binds live `encode`/`decode`
//! function exports and throws/holds real `exnref` values), the cross-activation
//! `ForkExceptionBroker` (which catches a thrown JavaScript/Wasm value and
//! re-throws it into the selected owner), and the chunked Worker-exception
//! normalization protocol (`ForkWorkerExceptionCapabilityOwner` /
//! `ForkWorkerLocalImportExceptionNormalizer`, which own live thrown values and
//! session state). Those materialize live exceptions; this decoder reproduces
//! only the descriptor IMAGE and its structural invariants.

use wasm_posix_shared::Errno;
use wasm_posix_shared::abi;

use alloc::collections::BTreeSet;
use alloc::vec::Vec;

const VERSION: u8 = abi::WPK_FORK_EXCEPTION_CODEC_VERSION;
const HEADER_SIZE: u16 = abi::WPK_FORK_EXCEPTION_CODEC_HEADER_SIZE;
const TAG_RECORD_SIZE: u16 = abi::WPK_FORK_EXCEPTION_CODEC_TAG_RECORD_SIZE;

/// Upper bound the TS decoder enforces on a layout id (`MAX_ACTIVATION_ID`, a
/// u31). Larger values name a reserved identity and are rejected.
const MAX_LAYOUT_ID: u32 = 0x7fff_ffff;

/// One decoded exact-tag layout record. Mirrors the TS `ForkExceptionTagLayout`:
/// the deterministic codec `tag_ordinal`, the `layout_id` that binds the
/// concrete payload type, and the byte geometry (`scalar_byte_length`,
/// `reference_count`) of a staged exception payload.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ForkExceptionTagLayout {
    pub tag_ordinal: u32,
    pub layout_id: u32,
    pub scalar_byte_length: u32,
    pub reference_count: u32,
}

/// The fully decoded and validated exception codec descriptor. Mirrors the TS
/// `ForkExceptionCodecDescriptor`: the format `version` plus the ordered tag
/// catalog. The live per-activation `WebAssembly.Tag` creation and exact-tag
/// codec resolution are the deferred engine-floor half; see the module doc
/// comment.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ForkExceptionCodec {
    pub version: u8,
    pub tags: Vec<ForkExceptionTagLayout>,
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

/// Decode and validate a `kandelo.wpk_fork.exception_codec` descriptor.
///
/// `bytes` is the raw custom-section payload. Returns the format version and the
/// ordered, fully validated tag catalog. Any framing or consistency violation
/// yields `Err(Errno::EINVAL)`; the function never panics.
///
/// Mirrors `readForkExceptionCodecDescriptor` in
/// `host/src/fork-exception-provider.ts`.
pub fn decode_exception_codec(bytes: &[u8]) -> Result<ForkExceptionCodec, Errno> {
    if bytes.len() < HEADER_SIZE as usize {
        return Err(Errno::EINVAL); // truncated header
    }
    let version = r_u8(bytes, 0)?;
    if version != VERSION {
        return Err(Errno::EINVAL); // unsupported version
    }
    if r_u8(bytes, 1)? != 0 || r_u16(bytes, 2)? != 0 {
        return Err(Errno::EINVAL); // reserved fields are nonzero
    }
    let count = r_u32(bytes, 4)?;

    // `byteLength === HEADER_SIZE + count * TAG_RECORD_SIZE`, computed in u64 so
    // a hostile 32-bit product cannot wrap. Mirrors the TS exact-size check.
    let record_bytes = (count as u64)
        .checked_mul(TAG_RECORD_SIZE as u64)
        .ok_or(Errno::EINVAL)?;
    let expected = (HEADER_SIZE as u64)
        .checked_add(record_bytes)
        .ok_or(Errno::EINVAL)?;
    if bytes.len() as u64 != expected {
        return Err(Errno::EINVAL); // size disagrees with the record count
    }

    let mut layout_ids: BTreeSet<u32> = BTreeSet::new();
    let mut tags: Vec<ForkExceptionTagLayout> = Vec::with_capacity(count as usize);
    for index in 0..count {
        let offset = HEADER_SIZE as u64 + index as u64 * TAG_RECORD_SIZE as u64;
        let tag_ordinal = r_u32(bytes, offset)?;
        let layout_id = r_u32(bytes, offset + 4)?;
        let scalar_byte_length = r_u32(bytes, offset + 8)?;
        let reference_count = r_u32(bytes, offset + 12)?;
        if tag_ordinal != index {
            return Err(Errno::EINVAL); // noncanonical tag ordinal
        }
        if layout_id > MAX_LAYOUT_ID || !layout_ids.insert(layout_id) {
            return Err(Errno::EINVAL); // reserved or duplicated layout id
        }
        tags.push(ForkExceptionTagLayout {
            tag_ordinal,
            layout_id,
            scalar_byte_length,
            reference_count,
        });
    }
    Ok(ForkExceptionCodec { version, tags })
}

#[cfg(test)]
mod tests {
    use super::*;

    // --- Cross-language fixture (emitted by the real Rust encoder) --------

    /// Bytes are the `kandelo.wpk_fork.exception_codec` section emitted by the
    /// REAL Rust instrumenter over a real three-tag module, via
    /// `crates/fork-codec/tests/gen_exception_codec_fixture.rs`. The same
    /// committed bytes are decoded field-for-field by the REAL host TypeScript
    /// decoder in `crates/fork-codec/testdata/gen-exception-codec-fixture.mts`;
    /// if the encoder and either decoder ever disagree on the wire format, that
    /// oracle and this test catch the drift.
    const FIXTURE: &[u8] = include_bytes!("../testdata/exception-codec-wasm32.bin");

    fn tag(
        tag_ordinal: u32,
        layout_id: u32,
        scalar_byte_length: u32,
        reference_count: u32,
    ) -> ForkExceptionTagLayout {
        ForkExceptionTagLayout {
            tag_ordinal,
            layout_id,
            scalar_byte_length,
            reference_count,
        }
    }

    #[test]
    fn decodes_real_encoder_fixture_field_for_field() {
        let decoded = decode_exception_codec(FIXTURE).unwrap();
        assert_eq!(decoded.version, 1);
        assert_eq!(
            decoded.tags,
            alloc::vec![
                // Empty tag: no payload.
                tag(0, 0, 0, 0),
                // All-scalar tag (i32+i64+f32+f64+v128 = 4+8+4+8+16 = 40 bytes).
                tag(1, 1, 40, 0),
                // All-reference tag (extern/func/exn/any = four references).
                tag(2, 2, 0, 4),
            ]
        );
    }

    #[test]
    fn fixture_is_non_vacuous() {
        // Guard against a fixture that silently collapses to an empty or trivial
        // catalog (which would make the field-for-field test vacuously pass).
        let decoded = decode_exception_codec(FIXTURE).unwrap();
        assert_eq!(decoded.tags.len(), 3);
        // Canonical, distinct tag ordinals and layout ids.
        assert_eq!(
            decoded.tags.iter().map(|t| t.tag_ordinal).collect::<Vec<_>>(),
            alloc::vec![0, 1, 2],
        );
        assert_eq!(
            decoded.tags.iter().map(|t| t.layout_id).collect::<Vec<_>>(),
            alloc::vec![0, 1, 2],
        );
        // A genuinely non-empty scalar payload AND a genuinely non-empty
        // reference payload survived the round trip.
        assert!(decoded.tags.iter().any(|t| t.scalar_byte_length == 40));
        assert!(decoded.tags.iter().any(|t| t.reference_count == 4));
        // The empty tag carries neither.
        assert!(
            decoded
                .tags
                .iter()
                .any(|t| t.scalar_byte_length == 0 && t.reference_count == 0)
        );
    }

    // --- Hand-built minimal descriptor (targeted framing/validation) ------

    fn put_u16(bytes: &mut [u8], off: usize, value: u16) {
        bytes[off..off + 2].copy_from_slice(&value.to_le_bytes());
    }

    fn put_u32(bytes: &mut [u8], off: usize, value: u32) {
        bytes[off..off + 4].copy_from_slice(&value.to_le_bytes());
    }

    /// Build a canonical two-record descriptor with DISTINCT field values, so a
    /// field-swap regression (e.g. reading scalar length where reference count
    /// belongs) is observable: tag 0 = (layout 5, 12 scalar bytes, 1 reference),
    /// tag 1 = (layout 9, 4 scalar bytes, 3 references).
    fn minimal_descriptor() -> Vec<u8> {
        let count = 2u32;
        let mut bytes =
            alloc::vec![0u8; HEADER_SIZE as usize + count as usize * TAG_RECORD_SIZE as usize];
        bytes[0] = VERSION;
        put_u32(&mut bytes, 4, count);
        // tag 0
        let r0 = HEADER_SIZE as usize;
        put_u32(&mut bytes, r0, 0); // tag_ordinal
        put_u32(&mut bytes, r0 + 4, 5); // layout_id
        put_u32(&mut bytes, r0 + 8, 12); // scalar_byte_length
        put_u32(&mut bytes, r0 + 12, 1); // reference_count
        // tag 1
        let r1 = r0 + TAG_RECORD_SIZE as usize;
        put_u32(&mut bytes, r1, 1); // tag_ordinal
        put_u32(&mut bytes, r1 + 4, 9); // layout_id
        put_u32(&mut bytes, r1 + 8, 4); // scalar_byte_length
        put_u32(&mut bytes, r1 + 12, 3); // reference_count
        bytes
    }

    #[test]
    fn decodes_minimal_descriptor_without_swapping_fields() {
        let decoded = decode_exception_codec(&minimal_descriptor()).unwrap();
        assert_eq!(
            decoded.tags,
            alloc::vec![tag(0, 5, 12, 1), tag(1, 9, 4, 3)]
        );
    }

    fn decode_mutated(mutate: impl FnOnce(&mut Vec<u8>)) -> Result<ForkExceptionCodec, Errno> {
        let mut bytes = minimal_descriptor();
        mutate(&mut bytes);
        decode_exception_codec(&bytes)
    }

    #[test]
    fn rejects_truncated_header() {
        let bytes = minimal_descriptor();
        assert_eq!(
            decode_exception_codec(&bytes[..HEADER_SIZE as usize - 1]),
            Err(Errno::EINVAL)
        );
    }

    #[test]
    fn rejects_bad_version() {
        assert_eq!(decode_mutated(|b| b[0] = VERSION + 1), Err(Errno::EINVAL));
    }

    #[test]
    fn rejects_nonzero_reserved_fields() {
        assert_eq!(decode_mutated(|b| b[1] = 1), Err(Errno::EINVAL));
        assert_eq!(decode_mutated(|b| put_u16(b, 2, 1)), Err(Errno::EINVAL));
    }

    #[test]
    fn rejects_size_disagreeing_with_count() {
        // Grow the recorded count without adding bytes.
        assert_eq!(decode_mutated(|b| put_u32(b, 4, 3)), Err(Errno::EINVAL));
        // Trailing bytes past the declared records.
        assert_eq!(decode_mutated(|b| b.push(0)), Err(Errno::EINVAL));
    }

    #[test]
    fn rejects_noncanonical_tag_ordinal() {
        // Force tag 1's ordinal (1) to the wrong value.
        assert_eq!(
            decode_mutated(|b| put_u32(b, HEADER_SIZE as usize + TAG_RECORD_SIZE as usize, 7)),
            Err(Errno::EINVAL)
        );
    }

    #[test]
    fn rejects_duplicate_layout_id() {
        // Force tag 1's layout id (9) to equal tag 0's (5).
        assert_eq!(
            decode_mutated(|b| put_u32(b, HEADER_SIZE as usize + TAG_RECORD_SIZE as usize + 4, 5)),
            Err(Errno::EINVAL)
        );
    }

    #[test]
    fn rejects_reserved_layout_id() {
        // 0x8000_0000 is one past MAX_LAYOUT_ID (a u31).
        assert_eq!(
            decode_mutated(|b| put_u32(b, HEADER_SIZE as usize + 4, 0x8000_0000)),
            Err(Errno::EINVAL)
        );
    }

    #[test]
    fn accepts_empty_catalog() {
        let mut bytes = alloc::vec![0u8; HEADER_SIZE as usize];
        bytes[0] = VERSION;
        let decoded = decode_exception_codec(&bytes).unwrap();
        assert!(decoded.tags.is_empty());
        assert_eq!(decoded.version, 1);
    }

    // --- Fixture-based negatives (mutations of the genuine fixture) -------

    fn decode_mutated_fixture(
        mutate: impl FnOnce(&mut Vec<u8>),
    ) -> Result<ForkExceptionCodec, Errno> {
        let mut bytes = FIXTURE.to_vec();
        mutate(&mut bytes);
        decode_exception_codec(&bytes)
    }

    #[test]
    fn rejects_noncanonical_ordinal_in_fixture() {
        // Force record 1's tag ordinal (1) to a noncanonical value.
        let record1 = HEADER_SIZE as usize + TAG_RECORD_SIZE as usize;
        assert_eq!(
            decode_mutated_fixture(|b| put_u32(b, record1, 2)),
            Err(Errno::EINVAL)
        );
    }

    #[test]
    fn rejects_duplicate_layout_in_fixture() {
        // Force record 1's layout id (1) to record 0's layout id (0).
        let record1 = HEADER_SIZE as usize + TAG_RECORD_SIZE as usize;
        assert_eq!(
            decode_mutated_fixture(|b| put_u32(b, record1 + 4, 0)),
            Err(Errno::EINVAL)
        );
    }

    // --- Panic-freedom on arbitrary bytes --------------------------------

    #[test]
    fn arbitrary_truncations_never_panic() {
        for len in 0..=FIXTURE.len() {
            let _ = decode_exception_codec(&FIXTURE[..len]);
        }
        let _ = decode_exception_codec(&[]);
        let _ = decode_exception_codec(&[0u8]);
    }

    #[test]
    fn single_byte_corruptions_never_panic() {
        for offset in 0..FIXTURE.len() {
            let mut bytes = FIXTURE.to_vec();
            bytes[offset] ^= 0xff;
            let _ = decode_exception_codec(&bytes);
        }
        let base = minimal_descriptor();
        for offset in 0..base.len() {
            let mut bytes = base.clone();
            bytes[offset] ^= 0xff;
            let _ = decode_exception_codec(&bytes);
        }
    }

    #[test]
    fn hostile_counts_never_panic() {
        // A huge declared count must fail cleanly (size mismatch / overflow
        // guard), never allocate wildly or panic.
        let mut bytes = minimal_descriptor();
        put_u32(&mut bytes, 4, u32::MAX);
        assert_eq!(decode_exception_codec(&bytes), Err(Errno::EINVAL));
    }
}
