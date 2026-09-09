//! Decoders for the two fork instantiation-catalog descriptors: the static-root
//! catalog (`kandelo.wpk_fork.static_root_catalog`, KFSR) and the resume catalog
//! (`kandelo.wpk_fork.resume_catalog`, KFRC).
//!
//! Both sections are emitted by the Rust instrumenter, and the host runtime only
//! DECODES them; neither has a TypeScript encoder. The committed cross-language
//! fixtures are therefore emitted by the REAL Rust encoders (see
//! `crates/fork-codec/tests/gen_static_root_catalog_fixture.rs` and
//! `gen_resume_catalog_fixture.rs`) and cross-checked by the real host decoders
//! (`testdata/gen-static-root-catalog-fixture.mts`,
//! `testdata/gen-resume-catalog-fixture.mts`).
//!
//! Both descriptors bind DETERMINISTIC INTEGER identities that a fresh fork
//! child re-derives after instantiation; neither serializes a live GC object.
//! This module decodes each descriptor IMAGE. The LIVE/engine-floor half — the
//! `WebAssembly.Table`-identity resolution that pairs each descriptor entry with
//! a fresh-instance object — is deferred to the co-resident module (Phase 6
//! D5+). Concretely:
//!
//! * Static-root catalog: `readForkStaticRootCatalogCount` in
//!   `host/src/fork-static-root-catalog.ts`. The descriptor is HEADER-ONLY — it
//!   carries only the harvest-table entry COUNT. The per-root identities live in
//!   the `__wpk_fork_static_root_catalog` table export and are harvested (weak
//!   object-to-ordinal mappings, then the table is cleared) by
//!   `ForkStaticRootCatalog.register`/`forkStaticRootTableFromInstance`. There
//!   are no per-entry records to serialize, so this decoder yields only the
//!   validated count; recovering the roots is the deferred live half.
//!
//! * Resume catalog: `readForkResumeCatalog` in
//!   `host/src/fork-resume-catalog.ts`. The descriptor is an ordered table of
//!   `(function_ordinal, local_catalog_slot)` records. `functionOrdinal` is
//!   strictly increasing and `localCatalogSlot` is unique. This decoder yields
//!   the validated record table; `forkResumeTargetsFromInstance` — which reads
//!   the live `__wpk_fork_resume_catalog` funcref table and pairs each slot with
//!   a fresh-instance thunk object — is the deferred live half.
//!
//! Layout recap (all little-endian):
//!
//! Static-root header (`WPK_FORK_STATIC_ROOT_CATALOG_HEADER_SIZE` = 12 bytes,
//! and the whole descriptor): `+0` magic `KFSR`, `+4` version (u16, 1), `+6`
//! header size (u16, 12), `+8` entry count (u32).
//!
//! Resume header (12 bytes): `+0` magic `KFRC`, `+4` version (u16, 1), `+6`
//! header size (u16, 12), `+8` record count (u32). Resume record (8 bytes): `+0`
//! function ordinal (u32), `+4` local catalog slot (u32).
//!
//! Every framing or consistency violation yields `Err(Errno::EINVAL)`; neither
//! decoder panics.

use wasm_posix_shared::Errno;
use wasm_posix_shared::abi;

use alloc::collections::BTreeSet;
use alloc::vec::Vec;

// --- Static-root catalog (KFSR) -----------------------------------------

const STATIC_ROOT_MAGIC: [u8; 4] = abi::WPK_FORK_STATIC_ROOT_CATALOG_MAGIC; // "KFSR"
const STATIC_ROOT_VERSION: u16 = abi::WPK_FORK_STATIC_ROOT_CATALOG_VERSION;
const STATIC_ROOT_HEADER_SIZE: u16 = abi::WPK_FORK_STATIC_ROOT_CATALOG_HEADER_SIZE;

// --- Resume catalog (KFRC) ----------------------------------------------
//
// Unlike KFSR, the KFRC framing constants have NO shared-ABI mirror: they live
// only in `host/src/fork-resume-catalog.ts` (`FORK_RESUME_CATALOG_MAGIC`,
// `FORK_RESUME_CATALOG_VERSION = 1`, `FORK_RESUME_CATALOG_HEADER_SIZE = 12`,
// `FORK_RESUME_CATALOG_RECORD_SIZE = 8`) and privately in the instrumenter
// (`fork_instrument::instrument`). This module therefore carries them locally
// and documents their TypeScript origin, exactly as `reference_recipes` carries
// the KFRR constants.
const RESUME_MAGIC: [u8; 4] = *b"KFRC";
const RESUME_VERSION: u16 = 1;
const RESUME_HEADER_SIZE: u16 = 12;
const RESUME_RECORD_SIZE: u16 = 8;

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

/// The fully decoded static-root catalog descriptor. Mirrors what
/// `readForkStaticRootCatalogCount` yields: the harvest-table entry `count`.
///
/// This is a HEADER-ONLY image: the per-root identities are recovered from the
/// live `__wpk_fork_static_root_catalog` table export (the deferred engine-floor
/// half; see the module doc comment), not from these bytes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StaticRootCatalog {
    pub count: u32,
}

/// Decode and validate a `kandelo.wpk_fork.static_root_catalog` descriptor.
///
/// `bytes` is the raw custom-section payload. The descriptor is exactly
/// `WPK_FORK_STATIC_ROOT_CATALOG_HEADER_SIZE` (12) bytes: magic, version, header
/// size, and the harvest-table entry count. Any framing violation (wrong size,
/// bad magic/version/header size) yields `Err(Errno::EINVAL)`; the function
/// never panics.
///
/// Mirrors `readForkStaticRootCatalogCount` in
/// `host/src/fork-static-root-catalog.ts`.
pub fn decode_static_root_catalog(bytes: &[u8]) -> Result<StaticRootCatalog, Errno> {
    // The TS decoder requires the descriptor to be EXACTLY the header size.
    if bytes.len() != STATIC_ROOT_HEADER_SIZE as usize {
        return Err(Errno::EINVAL);
    }
    if bytes.get(0..4) != Some(&STATIC_ROOT_MAGIC[..]) {
        return Err(Errno::EINVAL); // invalid magic
    }
    if r_u16(bytes, 4)? != STATIC_ROOT_VERSION {
        return Err(Errno::EINVAL); // unsupported version
    }
    if r_u16(bytes, 6)? != STATIC_ROOT_HEADER_SIZE {
        return Err(Errno::EINVAL); // inconsistent header size
    }
    let count = r_u32(bytes, 8)?;
    Ok(StaticRootCatalog { count })
}

/// One decoded resume-catalog record. Mirrors the TS `ForkResumeCatalogRecord`:
/// the deterministic `function_ordinal` and the module-local
/// `local_catalog_slot` that names a fresh-instance thunk in the live catalog
/// table (resolved in the deferred engine-floor half).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ForkResumeCatalogRecord {
    pub function_ordinal: u32,
    pub local_catalog_slot: u32,
}

/// The fully decoded and validated resume catalog descriptor. Mirrors what
/// `readForkResumeCatalog` yields: the ordered record table. The live
/// `WebAssembly.Table`-identity resolution (`forkResumeTargetsFromInstance`) is
/// the deferred engine-floor half; see the module doc comment.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ForkResumeCatalog {
    pub records: Vec<ForkResumeCatalogRecord>,
}

/// Decode and validate a `kandelo.wpk_fork.resume_catalog` descriptor.
///
/// `bytes` is the raw custom-section payload. Returns the ordered, fully
/// validated record table. Function ordinals are strictly increasing and local
/// catalog slots are unique. Any framing or consistency violation (bad
/// magic/version/header size, a size that disagrees with the record count, an
/// unordered function ordinal, or a repeated local slot) yields
/// `Err(Errno::EINVAL)`; the function never panics.
///
/// Mirrors `readForkResumeCatalog` in `host/src/fork-resume-catalog.ts`.
pub fn decode_resume_catalog(bytes: &[u8]) -> Result<ForkResumeCatalog, Errno> {
    if bytes.len() < RESUME_HEADER_SIZE as usize {
        return Err(Errno::EINVAL); // truncated header
    }
    if bytes.get(0..4) != Some(&RESUME_MAGIC[..]) {
        return Err(Errno::EINVAL); // invalid magic
    }
    if r_u16(bytes, 4)? != RESUME_VERSION || r_u16(bytes, 6)? != RESUME_HEADER_SIZE {
        return Err(Errno::EINVAL); // unsupported version / inconsistent header
    }
    let count = r_u32(bytes, 8)?;

    // `byteLength === HEADER_SIZE + count * RECORD_SIZE`, computed in u64 so a
    // hostile 32-bit product cannot wrap. Mirrors the TS exact-size check.
    let record_bytes = (count as u64)
        .checked_mul(RESUME_RECORD_SIZE as u64)
        .ok_or(Errno::EINVAL)?;
    let expected = (RESUME_HEADER_SIZE as u64)
        .checked_add(record_bytes)
        .ok_or(Errno::EINVAL)?;
    if bytes.len() as u64 != expected {
        return Err(Errno::EINVAL); // size disagrees with the record count
    }

    let mut slots: BTreeSet<u32> = BTreeSet::new();
    let mut previous_ordinal: i64 = -1;
    let mut records: Vec<ForkResumeCatalogRecord> = Vec::with_capacity(count as usize);
    for index in 0..count {
        let offset = RESUME_HEADER_SIZE as u64 + index as u64 * RESUME_RECORD_SIZE as u64;
        let function_ordinal = r_u32(bytes, offset)?;
        let local_catalog_slot = r_u32(bytes, offset + 4)?;
        // Function ordinals are strictly increasing (which also makes them
        // unique); mirrors the TS ordering guard.
        if (function_ordinal as i64) <= previous_ordinal {
            return Err(Errno::EINVAL); // unordered function ordinal
        }
        previous_ordinal = function_ordinal as i64;
        if !slots.insert(local_catalog_slot) {
            return Err(Errno::EINVAL); // repeated local slot
        }
        records.push(ForkResumeCatalogRecord {
            function_ordinal,
            local_catalog_slot,
        });
    }
    Ok(ForkResumeCatalog { records })
}

#[cfg(test)]
mod tests {
    use super::*;

    // --- Static-root catalog ---------------------------------------------

    /// Bytes are the `kandelo.wpk_fork.static_root_catalog` (KFSR) section
    /// emitted by the REAL Rust instrumenter over a real module with two harvest
    /// roots, via `crates/fork-codec/tests/gen_static_root_catalog_fixture.rs`.
    /// The same committed bytes are decoded by the REAL host TypeScript decoder
    /// in `crates/fork-codec/testdata/gen-static-root-catalog-fixture.mts`.
    const STATIC_ROOT_FIXTURE: &[u8] =
        include_bytes!("../testdata/static-root-catalog-wasm32.bin");

    fn put_u16(bytes: &mut [u8], off: usize, value: u16) {
        bytes[off..off + 2].copy_from_slice(&value.to_le_bytes());
    }

    fn put_u32(bytes: &mut [u8], off: usize, value: u32) {
        bytes[off..off + 4].copy_from_slice(&value.to_le_bytes());
    }

    #[test]
    fn decodes_static_root_fixture_field_for_field() {
        let decoded = decode_static_root_catalog(STATIC_ROOT_FIXTURE).unwrap();
        // The immutable global and its global.get alias share ordinal zero; the
        // independently allocating element root owns ordinal one.
        assert_eq!(decoded, StaticRootCatalog { count: 2 });
    }

    #[test]
    fn static_root_fixture_is_non_vacuous() {
        // The genuine fixture is exactly the 12-byte header and a nonzero count,
        // proving the count field is materialized (not defaulted to zero).
        assert_eq!(STATIC_ROOT_FIXTURE.len(), STATIC_ROOT_HEADER_SIZE as usize);
        assert_eq!(&STATIC_ROOT_FIXTURE[0..4], b"KFSR");
        assert!(decode_static_root_catalog(STATIC_ROOT_FIXTURE).unwrap().count > 0);
    }

    fn decode_mutated_static_root(
        mutate: impl FnOnce(&mut Vec<u8>),
    ) -> Result<StaticRootCatalog, Errno> {
        let mut bytes = STATIC_ROOT_FIXTURE.to_vec();
        mutate(&mut bytes);
        decode_static_root_catalog(&bytes)
    }

    #[test]
    fn rejects_static_root_bad_magic() {
        assert_eq!(decode_mutated_static_root(|b| b[0] ^= 0xff), Err(Errno::EINVAL));
    }

    #[test]
    fn rejects_static_root_bad_version_and_header_size() {
        assert_eq!(
            decode_mutated_static_root(|b| put_u16(b, 4, STATIC_ROOT_VERSION + 1)),
            Err(Errno::EINVAL)
        );
        assert_eq!(
            decode_mutated_static_root(|b| put_u16(b, 6, STATIC_ROOT_HEADER_SIZE + 1)),
            Err(Errno::EINVAL)
        );
    }

    #[test]
    fn rejects_static_root_wrong_length() {
        // One byte short of the header.
        assert_eq!(
            decode_static_root_catalog(&STATIC_ROOT_FIXTURE[..STATIC_ROOT_HEADER_SIZE as usize - 1]),
            Err(Errno::EINVAL)
        );
        // One trailing byte past the header — the descriptor must be EXACT.
        assert_eq!(decode_mutated_static_root(|b| b.push(0)), Err(Errno::EINVAL));
    }

    #[test]
    fn static_root_truncations_never_panic() {
        for len in 0..=STATIC_ROOT_FIXTURE.len() + 4 {
            let bytes = alloc::vec![0u8; len];
            let _ = decode_static_root_catalog(&bytes);
        }
        for offset in 0..STATIC_ROOT_FIXTURE.len() {
            let mut bytes = STATIC_ROOT_FIXTURE.to_vec();
            bytes[offset] ^= 0xff;
            let _ = decode_static_root_catalog(&bytes);
        }
    }

    // --- Resume catalog --------------------------------------------------

    /// Bytes are the `kandelo.wpk_fork.resume_catalog` (KFRC) section emitted by
    /// the REAL Rust instrumenter over a real fork-reaching module, via
    /// `crates/fork-codec/tests/gen_resume_catalog_fixture.rs`. The same
    /// committed bytes are decoded field-for-field by the REAL host TypeScript
    /// decoder in `crates/fork-codec/testdata/gen-resume-catalog-fixture.mts`.
    const RESUME_FIXTURE: &[u8] = include_bytes!("../testdata/resume-catalog-wasm32.bin");

    fn resume_record(function_ordinal: u32, local_catalog_slot: u32) -> ForkResumeCatalogRecord {
        ForkResumeCatalogRecord {
            function_ordinal,
            local_catalog_slot,
        }
    }

    #[test]
    fn decodes_resume_fixture_field_for_field() {
        let decoded = decode_resume_catalog(RESUME_FIXTURE).unwrap();
        // The deep activation plus three roots receive resume thunks; this
        // instrumenter assigns each function ordinal to its own catalog slot.
        assert_eq!(
            decoded.records,
            alloc::vec![
                resume_record(0, 0),
                resume_record(1, 1),
                resume_record(2, 2),
                resume_record(3, 3),
            ]
        );
    }

    #[test]
    fn resume_fixture_is_non_vacuous() {
        let decoded = decode_resume_catalog(RESUME_FIXTURE).unwrap();
        assert_eq!(decoded.records.len(), 4);
        // Strictly increasing function ordinals and unique slots survived.
        assert_eq!(
            decoded.records.iter().map(|r| r.function_ordinal).collect::<Vec<_>>(),
            alloc::vec![0, 1, 2, 3],
        );
        let mut slots = decoded
            .records
            .iter()
            .map(|r| r.local_catalog_slot)
            .collect::<Vec<_>>();
        slots.sort_unstable();
        slots.dedup();
        assert_eq!(slots.len(), 4, "local catalog slots are unique");
    }

    /// Hand-built two-record descriptor with `function_ordinal != local_slot`,
    /// so a field-swap regression is observable: (ordinal 3, slot 1) then
    /// (ordinal 7, slot 0).
    fn minimal_resume_descriptor() -> Vec<u8> {
        let count = 2u32;
        let mut bytes = alloc::vec![
            0u8;
            RESUME_HEADER_SIZE as usize + count as usize * RESUME_RECORD_SIZE as usize
        ];
        bytes[0..4].copy_from_slice(&RESUME_MAGIC);
        put_u16(&mut bytes, 4, RESUME_VERSION);
        put_u16(&mut bytes, 6, RESUME_HEADER_SIZE);
        put_u32(&mut bytes, 8, count);
        let r0 = RESUME_HEADER_SIZE as usize;
        put_u32(&mut bytes, r0, 3); // function_ordinal
        put_u32(&mut bytes, r0 + 4, 1); // local_catalog_slot
        let r1 = r0 + RESUME_RECORD_SIZE as usize;
        put_u32(&mut bytes, r1, 7); // function_ordinal
        put_u32(&mut bytes, r1 + 4, 0); // local_catalog_slot
        bytes
    }

    #[test]
    fn decodes_minimal_resume_without_swapping_fields() {
        let decoded = decode_resume_catalog(&minimal_resume_descriptor()).unwrap();
        assert_eq!(
            decoded.records,
            alloc::vec![resume_record(3, 1), resume_record(7, 0)]
        );
    }

    fn decode_mutated_resume(
        mutate: impl FnOnce(&mut Vec<u8>),
    ) -> Result<ForkResumeCatalog, Errno> {
        let mut bytes = minimal_resume_descriptor();
        mutate(&mut bytes);
        decode_resume_catalog(&bytes)
    }

    #[test]
    fn rejects_resume_truncated_header() {
        let bytes = minimal_resume_descriptor();
        assert_eq!(
            decode_resume_catalog(&bytes[..RESUME_HEADER_SIZE as usize - 1]),
            Err(Errno::EINVAL)
        );
    }

    #[test]
    fn rejects_resume_bad_magic_version_header() {
        assert_eq!(decode_mutated_resume(|b| b[0] ^= 0xff), Err(Errno::EINVAL));
        assert_eq!(
            decode_mutated_resume(|b| put_u16(b, 4, RESUME_VERSION + 1)),
            Err(Errno::EINVAL)
        );
        assert_eq!(
            decode_mutated_resume(|b| put_u16(b, 6, RESUME_HEADER_SIZE + 1)),
            Err(Errno::EINVAL)
        );
    }

    #[test]
    fn rejects_resume_size_disagreeing_with_count() {
        assert_eq!(decode_mutated_resume(|b| put_u32(b, 8, 3)), Err(Errno::EINVAL));
        assert_eq!(decode_mutated_resume(|b| b.push(0)), Err(Errno::EINVAL));
    }

    #[test]
    fn rejects_resume_unordered_function_ordinal() {
        // Force record 1's ordinal (7) below record 0's (3).
        assert_eq!(
            decode_mutated_resume(|b| put_u32(b, RESUME_HEADER_SIZE as usize + RESUME_RECORD_SIZE as usize, 2)),
            Err(Errno::EINVAL)
        );
        // Equal to record 0's ordinal is also rejected (strictly increasing).
        assert_eq!(
            decode_mutated_resume(|b| put_u32(b, RESUME_HEADER_SIZE as usize + RESUME_RECORD_SIZE as usize, 3)),
            Err(Errno::EINVAL)
        );
    }

    #[test]
    fn rejects_resume_repeated_local_slot() {
        // Force record 1's slot (0) to record 0's slot (1).
        assert_eq!(
            decode_mutated_resume(|b| put_u32(b, RESUME_HEADER_SIZE as usize + RESUME_RECORD_SIZE as usize + 4, 1)),
            Err(Errno::EINVAL)
        );
    }

    #[test]
    fn accepts_empty_resume_catalog() {
        let mut bytes = alloc::vec![0u8; RESUME_HEADER_SIZE as usize];
        bytes[0..4].copy_from_slice(&RESUME_MAGIC);
        put_u16(&mut bytes, 4, RESUME_VERSION);
        put_u16(&mut bytes, 6, RESUME_HEADER_SIZE);
        let decoded = decode_resume_catalog(&bytes).unwrap();
        assert!(decoded.records.is_empty());
    }

    #[test]
    fn resume_arbitrary_bytes_never_panic() {
        for len in 0..=RESUME_FIXTURE.len() {
            let _ = decode_resume_catalog(&RESUME_FIXTURE[..len]);
        }
        for offset in 0..RESUME_FIXTURE.len() {
            let mut bytes = RESUME_FIXTURE.to_vec();
            bytes[offset] ^= 0xff;
            let _ = decode_resume_catalog(&bytes);
        }
        // A hostile count must fail cleanly, never allocate wildly or panic.
        let mut bytes = minimal_resume_descriptor();
        put_u32(&mut bytes, 8, u32::MAX);
        assert_eq!(decode_resume_catalog(&bytes), Err(Errno::EINVAL));
    }
}
