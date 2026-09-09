//! Decoder for the fork imported-globals (KFIG) ownership descriptor.
//!
//! Ported from `readForkImportedGlobals` in `host/src/fork-module-state.ts`. The
//! wire format is emitted by the Rust instrumenter
//! (`fork_instrument::module_state::replace_imported_globals_section`, reached
//! through the full `fork_instrument::instrument` pipeline) into the
//! `kandelo.wpk_fork.imported_globals` custom section; its structural constants
//! live in `crates/shared/src/lib.rs` (`WPK_FORK_IMPORTED_GLOBALS_*`). The host
//! runtime only DECODES this section — there is no TypeScript encoder — so the
//! committed cross-language fixture is emitted by the REAL Rust encoder (see
//! `crates/fork-codec/tests/gen_imported_globals_fixture.rs`) and cross-checked
//! by the real host decoder (`testdata/gen-imported-globals-fixture.mts`).
//!
//! Layout recap (all little-endian):
//!
//! Descriptor header (`WPK_FORK_IMPORTED_GLOBALS_HEADER_SIZE` = 16 bytes): `+0`
//! magic `KFIG`, `+4` version (u16), `+6` header size (u16), `+8` record count
//! (u32), `+12` reserved (u32, 0).
//!
//! Record header (`WPK_FORK_IMPORTED_GLOBALS_RECORD_HEADER_SIZE` = 24 bytes):
//! `+0` record size (u32, `24 + module_len + name_len`), `+4` owner id (nonzero
//! u32), `+8` value type code (u8), `+9` flags (u8: mutable `1<<0`, shared
//! `1<<1`), `+10` reserved (u16, 0), `+12` module-name length (u32), `+16`
//! import-name length (u32), `+20` import-section ordinal (u32). The two UTF-8
//! names follow contiguously: `module` (`module_len` bytes) then `name`
//! (`name_len` bytes). Import ordinals are strictly increasing across records
//! and owner ids are unique.
//!
//! Unlike `linked_frames` and `module_state`, this wire is NOT a linear-memory
//! pointer walk: it is a self-contained catalog of pre-instantiation ownership
//! evidence. This decoder is the pure `&[u8] -> struct` half: given the section
//! bytes it produces the owned, fully validated ownership catalog, exactly what
//! `readForkImportedGlobals` yields. Every framing or consistency violation (bad
//! magic/version/header size, a nonzero reserved field, a truncated or
//! inconsistent record, a zero or duplicated owner id, an unknown value type or
//! flag, invalid UTF-8, or a duplicated/unordered import ordinal) yields
//! `Err(Errno::EINVAL)`; the function never panics.
//!
//! The LIVE half is deferred to the co-resident module (Phase 6 D5+): the parts
//! of `host/src/fork-imported-globals.ts` that are genuinely runtime-instance
//! state rather than a byte format. Specifically the `ForkImportedGlobalCapture`
//! parent recording proxies (which observe raw JavaScript import values at real
//! `WebAssembly.Instance` boundaries), the `ForkImportedGlobalPlanner`
//! child-side planning (topological provider ordering, GOT/base-import cell
//! reconstruction, `WebAssembly.Global`/`WebAssembly.Table` identity resolution
//! from the private `__wpk_fork_global_*`/`__wpk_fork_table_*` catalog exports,
//! and dirty-tracker aliasing), and the sibling KFIT imported-tables descriptor
//! plus the imported-global/table BINDINGS records carried inside the KFMS
//! arena. Those own real instance exports and live GC references, not a pure
//! `&[u8]` decode, exactly as `linked_frames` deferred its live allocator and
//! `gc_codec` deferred its provenance registry.

use wasm_posix_shared::abi;
use wasm_posix_shared::Errno;

use alloc::collections::BTreeSet;
use alloc::string::String;
use alloc::vec::Vec;

const MAGIC: [u8; 4] = abi::WPK_FORK_IMPORTED_GLOBALS_MAGIC; // "KFIG"
const VERSION: u16 = abi::WPK_FORK_IMPORTED_GLOBALS_VERSION;
const HEADER_SIZE: u16 = abi::WPK_FORK_IMPORTED_GLOBALS_HEADER_SIZE;
const RECORD_HEADER_SIZE: u16 = abi::WPK_FORK_IMPORTED_GLOBALS_RECORD_HEADER_SIZE;
const FLAG_MUTABLE: u8 = abi::WPK_FORK_IMPORTED_GLOBAL_FLAG_MUTABLE;
const FLAG_SHARED: u8 = abi::WPK_FORK_IMPORTED_GLOBAL_FLAG_SHARED;
const KNOWN_FLAGS: u8 = abi::WPK_FORK_IMPORTED_GLOBAL_KNOWN_FLAGS;

/// One decoded imported-global ownership record. Mirrors the TS
/// `ForkImportedGlobalState`: the pre-instantiation identity (`module`, `name`,
/// `import_ordinal`), the private owner ordinal (`owner_id`), and the declared
/// Wasm value type plus mutability/shared bits.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImportedGlobal {
    pub module: String,
    pub name: String,
    pub import_ordinal: u32,
    pub owner_id: u32,
    pub type_code: u8,
    pub mutable: bool,
    pub shared: bool,
}

/// The fully decoded and validated imported-globals catalog. Mirrors what
/// `readForkImportedGlobals` produces: the ordered list of application-owned
/// imported globals (its per-instance planning is the deferred runtime half;
/// see the module doc comment).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImportedGlobals {
    pub globals: Vec<ImportedGlobal>,
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

/// Whether `type_code` is a value type an imported global may carry. Mirrors the
/// TS `IMPORTED_GLOBAL_TYPE_CODES` set: every numeric/vector/reference code
/// (`WPK_FORK_MODULE_STATE_GLOBAL_TYPE_*`, ordinals 1..=9).
fn is_known_global_type(type_code: u8) -> bool {
    matches!(
        type_code,
        code if code == abi::WPK_FORK_MODULE_STATE_GLOBAL_TYPE_I32
            || code == abi::WPK_FORK_MODULE_STATE_GLOBAL_TYPE_I64
            || code == abi::WPK_FORK_MODULE_STATE_GLOBAL_TYPE_F32
            || code == abi::WPK_FORK_MODULE_STATE_GLOBAL_TYPE_F64
            || code == abi::WPK_FORK_MODULE_STATE_GLOBAL_TYPE_V128
            || code == abi::WPK_FORK_MODULE_STATE_GLOBAL_TYPE_FUNCREF
            || code == abi::WPK_FORK_MODULE_STATE_GLOBAL_TYPE_EXTERNREF
            || code == abi::WPK_FORK_MODULE_STATE_GLOBAL_TYPE_EXNREF
            || code == abi::WPK_FORK_MODULE_STATE_GLOBAL_TYPE_ANYREF
    )
}

/// Read and UTF-8 validate a name slice `[start, start + len)`. Mirrors the
/// TS `TextDecoder("utf-8", { fatal: true })` decode.
fn read_name(bytes: &[u8], start: u64, len: u32) -> Result<String, Errno> {
    let start = usize::try_from(start).map_err(|_| Errno::EINVAL)?;
    let len = usize::try_from(len).map_err(|_| Errno::EINVAL)?;
    let end = start.checked_add(len).ok_or(Errno::EINVAL)?;
    let slice = bytes.get(start..end).ok_or(Errno::EINVAL)?;
    core::str::from_utf8(slice)
        .map(String::from)
        .map_err(|_| Errno::EINVAL)
}

/// Decode and validate a `kandelo.wpk_fork.imported_globals` descriptor.
///
/// `bytes` is the raw custom-section payload. Returns the ordered, fully
/// validated ownership catalog. Any framing or consistency violation yields
/// `Err(Errno::EINVAL)`; the function never panics.
///
/// Mirrors `readForkImportedGlobals` in `host/src/fork-module-state.ts`.
pub fn decode_imported_globals(bytes: &[u8]) -> Result<ImportedGlobals, Errno> {
    if bytes.len() < HEADER_SIZE as usize {
        return Err(Errno::EINVAL); // truncated header
    }
    if bytes.get(0..4) != Some(&MAGIC[..]) {
        return Err(Errno::EINVAL); // invalid magic
    }
    if r_u16(bytes, 4)? != VERSION || r_u16(bytes, 6)? != HEADER_SIZE {
        return Err(Errno::EINVAL); // unsupported version/header
    }
    let count = r_u32(bytes, 8)?;
    if r_u32(bytes, 12)? != 0 {
        return Err(Errno::EINVAL); // reserved field is nonzero
    }

    let mut owners: BTreeSet<u32> = BTreeSet::new();
    let mut import_ordinals: BTreeSet<u32> = BTreeSet::new();
    let mut previous_import_ordinal: i64 = -1;
    let mut globals: Vec<ImportedGlobal> = Vec::with_capacity(count as usize);
    let mut offset: u64 = HEADER_SIZE as u64;
    for _ in 0..count {
        // The 24-byte record header must fit before any field is read.
        let header_end = offset
            .checked_add(RECORD_HEADER_SIZE as u64)
            .ok_or(Errno::EINVAL)?;
        if header_end > bytes.len() as u64 {
            return Err(Errno::EINVAL); // record header truncated
        }
        let record_size = r_u32(bytes, offset)?;
        let owner_id = r_u32(bytes, offset + 4)?;
        let type_code = r_u8(bytes, offset + 8)?;
        let flags = r_u8(bytes, offset + 9)?;
        let reserved = r_u16(bytes, offset + 10)?;
        let module_len = r_u32(bytes, offset + 12)?;
        let name_len = r_u32(bytes, offset + 16)?;
        let import_ordinal = r_u32(bytes, offset + 20)?;

        // `record_size == 24 + module_len + name_len`, within bounds. Compute in
        // u64 so a hostile 32-bit sum cannot wrap.
        let expected_size = (RECORD_HEADER_SIZE as u64)
            .checked_add(module_len as u64)
            .and_then(|value| value.checked_add(name_len as u64))
            .ok_or(Errno::EINVAL)?;
        let record_end = offset
            .checked_add(record_size as u64)
            .ok_or(Errno::EINVAL)?;
        if record_size as u64 != expected_size
            || record_size < RECORD_HEADER_SIZE as u32
            || record_end > bytes.len() as u64
        {
            return Err(Errno::EINVAL); // invalid record bounds
        }
        if owner_id == 0 || !owners.insert(owner_id) {
            return Err(Errno::EINVAL); // zero or duplicate owner id
        }
        if !is_known_global_type(type_code) {
            return Err(Errno::EINVAL); // unknown value type
        }
        if flags & !KNOWN_FLAGS != 0 {
            return Err(Errno::EINVAL); // unknown flags
        }
        if reserved != 0 {
            return Err(Errno::EINVAL); // reserved field is nonzero
        }
        let names_offset = offset + RECORD_HEADER_SIZE as u64;
        let module = read_name(bytes, names_offset, module_len)?;
        let name = read_name(bytes, names_offset + module_len as u64, name_len)?;
        // Import ordinals are strictly increasing (which also makes them
        // unique); `import_ordinals` mirrors the TS duplicate guard exactly.
        if import_ordinals.contains(&import_ordinal)
            || (import_ordinal as i64) <= previous_import_ordinal
        {
            return Err(Errno::EINVAL); // duplicated or unordered import ordinal
        }
        import_ordinals.insert(import_ordinal);
        previous_import_ordinal = import_ordinal as i64;

        globals.push(ImportedGlobal {
            module,
            name,
            import_ordinal,
            owner_id,
            type_code,
            mutable: flags & FLAG_MUTABLE != 0,
            shared: flags & FLAG_SHARED != 0,
        });
        offset = record_end;
    }
    if offset != bytes.len() as u64 {
        return Err(Errno::EINVAL); // trailing bytes
    }
    Ok(ImportedGlobals { globals })
}

#[cfg(test)]
mod tests {
    use super::*;

    use abi::{
        WPK_FORK_MODULE_STATE_GLOBAL_TYPE_EXTERNREF, WPK_FORK_MODULE_STATE_GLOBAL_TYPE_I32,
        WPK_FORK_MODULE_STATE_GLOBAL_TYPE_I64,
    };

    // --- Cross-language fixture (emitted by the real Rust encoder) --------

    /// Bytes are the `kandelo.wpk_fork.imported_globals` (KFIG) section emitted
    /// by the REAL Rust instrumenter over a real dylink side module, via
    /// `crates/fork-codec/tests/gen_imported_globals_fixture.rs`. The same
    /// committed bytes are decoded field-for-field by the REAL host TypeScript
    /// decoder in `crates/fork-codec/testdata/gen-imported-globals-fixture.mts`;
    /// if the encoder and either decoder ever disagree on the wire format, that
    /// oracle and this test catch the drift.
    const FIXTURE: &[u8] = include_bytes!("../testdata/imported-globals-wasm32.bin");

    fn global(
        module: &str,
        name: &str,
        import_ordinal: u32,
        owner_id: u32,
        type_code: u8,
        mutable: bool,
        shared: bool,
    ) -> ImportedGlobal {
        ImportedGlobal {
            module: String::from(module),
            name: String::from(name),
            import_ordinal,
            owner_id,
            type_code,
            mutable,
            shared,
        }
    }

    #[test]
    fn decodes_real_encoder_fixture_field_for_field() {
        let decoded = decode_imported_globals(FIXTURE).unwrap();
        assert_eq!(
            decoded.globals,
            alloc::vec![
                // GOT.func mutable i32 cell — the canonical dynamic-linker GOT
                // scalar the child planner restores from its KFMS snapshot.
                global(
                    "GOT.func",
                    "callback",
                    1,
                    1,
                    WPK_FORK_MODULE_STATE_GLOBAL_TYPE_I32,
                    true,
                    false,
                ),
                // GOT.func mutable i64 cell (wide pointer target).
                global(
                    "GOT.func",
                    "wide_callback",
                    2,
                    2,
                    WPK_FORK_MODULE_STATE_GLOBAL_TYPE_I64,
                    true,
                    false,
                ),
                // Immutable GOT.mem base — must be supplied before instantiation.
                global(
                    "GOT.mem",
                    "data_base",
                    3,
                    3,
                    WPK_FORK_MODULE_STATE_GLOBAL_TYPE_I32,
                    false,
                    false,
                ),
                // Reference-typed import exercising a non-scalar KFIG type code.
                global(
                    "env",
                    "token",
                    4,
                    4,
                    WPK_FORK_MODULE_STATE_GLOBAL_TYPE_EXTERNREF,
                    false,
                    false,
                ),
            ]
        );
    }

    #[test]
    fn fixture_is_non_vacuous() {
        // Guard against a fixture that silently collapses to an empty or trivial
        // catalog (which would make the field-for-field test vacuously pass).
        let decoded = decode_imported_globals(FIXTURE).unwrap();
        assert_eq!(decoded.globals.len(), 4);
        // Distinct type codes, both mutability states, and a non-scalar type.
        assert!(decoded.globals.iter().any(|g| g.mutable));
        assert!(decoded.globals.iter().any(|g| !g.mutable));
        assert!(decoded
            .globals
            .iter()
            .any(|g| g.type_code == WPK_FORK_MODULE_STATE_GLOBAL_TYPE_I64));
        assert!(decoded
            .globals
            .iter()
            .any(|g| g.type_code == WPK_FORK_MODULE_STATE_GLOBAL_TYPE_EXTERNREF));
        // Owner ids and import ordinals are unique and increasing.
        assert!(decoded.globals.iter().all(|g| !g.shared));
        assert_eq!(
            decoded.globals.iter().map(|g| g.owner_id).collect::<Vec<_>>(),
            alloc::vec![1, 2, 3, 4],
        );
        // No name is empty; the GOT namespaces survived the round trip.
        assert!(decoded.globals.iter().any(|g| g.module == "GOT.func"));
        assert!(decoded.globals.iter().all(|g| !g.name.is_empty()));
    }

    // --- Hand-built minimal descriptor (targeted framing/validation) ------

    fn put_u16(bytes: &mut [u8], off: usize, value: u16) {
        bytes[off..off + 2].copy_from_slice(&value.to_le_bytes());
    }

    fn put_u32(bytes: &mut [u8], off: usize, value: u32) {
        bytes[off..off + 4].copy_from_slice(&value.to_le_bytes());
    }

    /// Build a canonical single-record descriptor: one mutable i32 imported
    /// global `env.g` (owner 1, import ordinal 0).
    fn minimal_descriptor() -> Vec<u8> {
        let module_name = b"env";
        let field_name = b"g";
        let record_size = RECORD_HEADER_SIZE as usize + module_name.len() + field_name.len();
        let mut bytes = alloc::vec![0u8; HEADER_SIZE as usize + record_size];
        bytes[0..4].copy_from_slice(&MAGIC);
        put_u16(&mut bytes, 4, VERSION);
        put_u16(&mut bytes, 6, HEADER_SIZE);
        put_u32(&mut bytes, 8, 1); // record count
        put_u32(&mut bytes, 12, 0); // reserved

        let record = HEADER_SIZE as usize;
        put_u32(&mut bytes, record, record_size as u32);
        put_u32(&mut bytes, record + 4, 1); // owner id
        bytes[record + 8] = WPK_FORK_MODULE_STATE_GLOBAL_TYPE_I32;
        bytes[record + 9] = FLAG_MUTABLE;
        put_u16(&mut bytes, record + 10, 0); // reserved
        put_u32(&mut bytes, record + 12, module_name.len() as u32);
        put_u32(&mut bytes, record + 16, field_name.len() as u32);
        put_u32(&mut bytes, record + 20, 0); // import ordinal
        let names = record + RECORD_HEADER_SIZE as usize;
        bytes[names..names + module_name.len()].copy_from_slice(module_name);
        bytes[names + module_name.len()..names + module_name.len() + field_name.len()]
            .copy_from_slice(field_name);
        bytes
    }

    #[test]
    fn decodes_minimal_descriptor() {
        let decoded = decode_imported_globals(&minimal_descriptor()).unwrap();
        assert_eq!(
            decoded.globals,
            alloc::vec![global(
                "env",
                "g",
                0,
                1,
                WPK_FORK_MODULE_STATE_GLOBAL_TYPE_I32,
                true,
                false,
            )]
        );
    }

    fn decode_mutated(mutate: impl FnOnce(&mut Vec<u8>)) -> Result<ImportedGlobals, Errno> {
        let mut bytes = minimal_descriptor();
        mutate(&mut bytes);
        decode_imported_globals(&bytes)
    }

    #[test]
    fn rejects_truncated_header() {
        let bytes = minimal_descriptor();
        assert_eq!(
            decode_imported_globals(&bytes[..HEADER_SIZE as usize - 1]),
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
    fn rejects_nonzero_header_reserved() {
        assert_eq!(decode_mutated(|b| put_u32(b, 12, 1)), Err(Errno::EINVAL));
    }

    #[test]
    fn rejects_zero_owner_id() {
        assert_eq!(
            decode_mutated(|b| put_u32(b, HEADER_SIZE as usize + 4, 0)),
            Err(Errno::EINVAL)
        );
    }

    #[test]
    fn rejects_unknown_type_code() {
        // 10 is one past ANYREF (9); 0 is below I32 (1).
        assert_eq!(
            decode_mutated(|b| b[HEADER_SIZE as usize + 8] = 10),
            Err(Errno::EINVAL)
        );
        assert_eq!(
            decode_mutated(|b| b[HEADER_SIZE as usize + 8] = 0),
            Err(Errno::EINVAL)
        );
    }

    #[test]
    fn rejects_unknown_flags() {
        assert_eq!(
            decode_mutated(|b| b[HEADER_SIZE as usize + 9] = KNOWN_FLAGS + 1),
            Err(Errno::EINVAL)
        );
    }

    #[test]
    fn accepts_shared_flag() {
        let decoded =
            decode_mutated(|b| b[HEADER_SIZE as usize + 9] = FLAG_MUTABLE | FLAG_SHARED).unwrap();
        assert!(decoded.globals[0].mutable);
        assert!(decoded.globals[0].shared);
    }

    #[test]
    fn rejects_nonzero_record_reserved() {
        assert_eq!(
            decode_mutated(|b| put_u16(b, HEADER_SIZE as usize + 10, 1)),
            Err(Errno::EINVAL)
        );
    }

    #[test]
    fn rejects_record_size_disagreeing_with_name_lengths() {
        // Grow the recorded module length without adding bytes.
        assert_eq!(
            decode_mutated(|b| put_u32(b, HEADER_SIZE as usize + 12, 4)),
            Err(Errno::EINVAL)
        );
        // A record_size that no longer matches 24 + module_len + name_len.
        assert_eq!(
            decode_mutated(|b| put_u32(b, HEADER_SIZE as usize, 999)),
            Err(Errno::EINVAL)
        );
    }

    #[test]
    fn rejects_trailing_bytes() {
        assert_eq!(decode_mutated(|b| b.push(0)), Err(Errno::EINVAL));
    }

    #[test]
    fn rejects_invalid_utf8_name() {
        // Overwrite the module name byte with a lone continuation byte.
        let names = HEADER_SIZE as usize + RECORD_HEADER_SIZE as usize;
        assert_eq!(decode_mutated(|b| b[names] = 0x80), Err(Errno::EINVAL));
    }

    // --- Fixture-based negatives (mutations of the genuine fixture) -------

    fn decode_mutated_fixture(
        mutate: impl FnOnce(&mut Vec<u8>),
    ) -> Result<ImportedGlobals, Errno> {
        let mut bytes = FIXTURE.to_vec();
        mutate(&mut bytes);
        decode_imported_globals(&bytes)
    }

    #[test]
    fn rejects_duplicate_owner_in_fixture() {
        // Force record 1's owner (2) to record 0's owner (1).
        let record1 = HEADER_SIZE as usize + 40; // record 0 is 40 bytes
        assert_eq!(
            decode_mutated_fixture(|b| put_u32(b, record1 + 4, 1)),
            Err(Errno::EINVAL)
        );
    }

    #[test]
    fn rejects_unordered_import_ordinal_in_fixture() {
        // Force record 1's import ordinal (2) below record 0's (1).
        let record1 = HEADER_SIZE as usize + 40;
        assert_eq!(
            decode_mutated_fixture(|b| put_u32(b, record1 + 20, 0)),
            Err(Errno::EINVAL)
        );
        // Equal to record 0's ordinal is also rejected (strictly increasing).
        assert_eq!(
            decode_mutated_fixture(|b| put_u32(b, record1 + 20, 1)),
            Err(Errno::EINVAL)
        );
    }

    // --- Panic-freedom on arbitrary bytes --------------------------------

    #[test]
    fn arbitrary_truncations_never_panic() {
        // Every prefix of the genuine fixture must decode to Ok or Err, no panic.
        for len in 0..=FIXTURE.len() {
            let _ = decode_imported_globals(&FIXTURE[..len]);
        }
        let _ = decode_imported_globals(&[]);
        let _ = decode_imported_globals(&[0u8]);
    }

    #[test]
    fn single_byte_corruptions_never_panic() {
        // Corrupt each byte of the genuine fixture and confirm the decoder stays
        // panic-free (Ok or Err, either is fine).
        for offset in 0..FIXTURE.len() {
            let mut bytes = FIXTURE.to_vec();
            bytes[offset] ^= 0xff;
            let _ = decode_imported_globals(&bytes);
        }
        // Also sweep the hand-built minimal descriptor.
        let base = minimal_descriptor();
        for offset in 0..base.len() {
            let mut bytes = base.clone();
            bytes[offset] ^= 0xff;
            let _ = decode_imported_globals(&bytes);
        }
    }
}
