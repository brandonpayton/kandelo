//! Decoder for the fork imported-tables (KFIT) ownership descriptor.
//!
//! Ported from `readForkImportedTables` in `host/src/fork-module-state.ts`, the
//! exact sibling of the imported-globals (KFIG) decoder. The wire format is
//! emitted by the Rust instrumenter
//! (`fork_instrument::module_state::replace_imported_tables_section`, reached
//! through the full `fork_instrument::instrument` pipeline) into the
//! `kandelo.wpk_fork.imported_tables` custom section; its structural constants
//! live in `crates/shared/src/lib.rs` (`WPK_FORK_IMPORTED_TABLES_*`). The host
//! runtime only DECODES this section — there is no TypeScript encoder — so the
//! committed cross-language fixture is emitted by the REAL Rust encoder (see
//! `crates/fork-codec/tests/gen_imported_tables_fixture.rs`) and cross-checked
//! by the real host decoder (`testdata/gen-imported-tables-fixture.mts`).
//!
//! Layout recap (all little-endian) — identical framing to KFIG:
//!
//! Descriptor header (`WPK_FORK_IMPORTED_TABLES_HEADER_SIZE` = 16 bytes): `+0`
//! magic `KFIT`, `+4` version (u16), `+6` header size (u16), `+8` record count
//! (u32), `+12` reserved (u32, 0).
//!
//! Record header (`WPK_FORK_IMPORTED_TABLES_RECORD_HEADER_SIZE` = 24 bytes):
//! `+0` record size (u32, `24 + module_len + name_len`), `+4` owner id (nonzero
//! u32), `+8` element type code (u8, a reference type), `+9` flags (u8: table64
//! `1<<0`), `+10` reserved (u16, 0), `+12` module-name length (u32), `+16`
//! import-name length (u32), `+20` import-section ordinal (u32). The two UTF-8
//! names follow contiguously: `module` (`module_len` bytes) then `name`
//! (`name_len` bytes). Import ordinals are strictly increasing across records
//! and owner ids are unique.
//!
//! Where KFIG describes imported globals — every numeric/vector/reference value
//! type with mutable and shared bits — KFIT describes imported TABLES: the
//! element type is always a REFERENCE type (`funcref`, `externref`, `exnref`,
//! `anyref`; codes 6..=9), and the only flag is `table64` (an i64-indexed
//! table). A table import is an identity edge in the module graph, so the fresh
//! child must reconstruct the exact `WebAssembly.Table` and wire that edge
//! before instantiation.
//!
//! Like KFIG this wire is NOT a linear-memory pointer walk: it is a
//! self-contained catalog of pre-instantiation ownership evidence. This decoder
//! is the pure `&[u8] -> struct` half: given the section bytes it produces the
//! owned, fully validated ownership catalog, exactly what `readForkImportedTables`
//! yields. Every framing or consistency violation (bad magic/version/header
//! size, a nonzero reserved field, a truncated or inconsistent record, a zero or
//! duplicated owner id, a non-reference element type, an unknown flag, invalid
//! UTF-8, or a duplicated/unordered import ordinal) yields `Err(Errno::EINVAL)`;
//! the function never panics.
//!
//! The LIVE half is deferred to the co-resident module (Phase 6 D5+): the parts
//! of `host/src/fork-imported-globals.ts` that are genuinely runtime-instance
//! state rather than a byte format. Specifically the child-side
//! `ForkImportedGlobalPlanner` table planning — `WebAssembly.Table` identity
//! resolution from the private `__wpk_fork_table_*` catalog exports, activation
//! vs. base-import binding classification, and the imported-table BINDINGS
//! records carried inside the KFMS arena (the KFBT sub-format) — owns real
//! instance exports and live GC references, not a pure `&[u8]` decode, exactly
//! as KFIG deferred its capture proxies and planner and `linked_frames` deferred
//! its live allocator.

use wasm_posix_shared::abi;
use wasm_posix_shared::Errno;

use alloc::collections::BTreeSet;
use alloc::string::String;
use alloc::vec::Vec;

const MAGIC: [u8; 4] = abi::WPK_FORK_IMPORTED_TABLES_MAGIC; // "KFIT"
const VERSION: u16 = abi::WPK_FORK_IMPORTED_TABLES_VERSION;
const HEADER_SIZE: u16 = abi::WPK_FORK_IMPORTED_TABLES_HEADER_SIZE;
const RECORD_HEADER_SIZE: u16 = abi::WPK_FORK_IMPORTED_TABLES_RECORD_HEADER_SIZE;
const FLAG_TABLE64: u8 = abi::WPK_FORK_IMPORTED_TABLE_FLAG_TABLE64;
const KNOWN_FLAGS: u8 = abi::WPK_FORK_IMPORTED_TABLE_KNOWN_FLAGS;

/// One decoded imported-table ownership record. Mirrors the TS
/// `ForkImportedTableState`: the pre-instantiation identity (`module`, `name`,
/// `import_ordinal`), the private owner ordinal (`owner_id`), the declared
/// reference element type (`type_code`), and whether the table is i64-indexed
/// (`table64`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImportedTable {
    pub module: String,
    pub name: String,
    pub import_ordinal: u32,
    pub owner_id: u32,
    pub type_code: u8,
    pub table64: bool,
}

/// The fully decoded and validated imported-tables catalog. Mirrors what
/// `readForkImportedTables` produces: the ordered list of application-owned
/// imported tables (its per-instance planning is the deferred runtime half; see
/// the module doc comment).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImportedTables {
    pub tables: Vec<ImportedTable>,
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

/// Whether `type_code` is a reference type a table may carry as its element
/// type. Mirrors the TS `IMPORTED_TABLE_ELEMENT_TYPE_CODES` set: the reference
/// codes only (`WPK_FORK_MODULE_STATE_GLOBAL_TYPE_{FUNCREF,EXTERNREF,EXNREF,
/// ANYREF}`, ordinals 6..=9). Unlike KFIG globals, the numeric/vector value
/// types (i32/i64/f32/f64/v128) are NOT valid table element types.
fn is_known_element_type(type_code: u8) -> bool {
    matches!(
        type_code,
        code if code == abi::WPK_FORK_MODULE_STATE_GLOBAL_TYPE_FUNCREF
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

/// Decode and validate a `kandelo.wpk_fork.imported_tables` descriptor.
///
/// `bytes` is the raw custom-section payload. Returns the ordered, fully
/// validated ownership catalog. Any framing or consistency violation yields
/// `Err(Errno::EINVAL)`; the function never panics.
///
/// Mirrors `readForkImportedTables` in `host/src/fork-module-state.ts`.
pub fn decode_imported_tables(bytes: &[u8]) -> Result<ImportedTables, Errno> {
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
    let mut tables: Vec<ImportedTable> = Vec::with_capacity(count as usize);
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
        if !is_known_element_type(type_code) {
            return Err(Errno::EINVAL); // non-reference element type
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

        tables.push(ImportedTable {
            module,
            name,
            import_ordinal,
            owner_id,
            type_code,
            table64: flags & FLAG_TABLE64 != 0,
        });
        offset = record_end;
    }
    if offset != bytes.len() as u64 {
        return Err(Errno::EINVAL); // trailing bytes
    }
    Ok(ImportedTables { tables })
}

#[cfg(test)]
mod tests {
    use super::*;

    use abi::{
        WPK_FORK_MODULE_STATE_GLOBAL_TYPE_EXTERNREF, WPK_FORK_MODULE_STATE_GLOBAL_TYPE_FUNCREF,
        WPK_FORK_MODULE_STATE_GLOBAL_TYPE_I32,
    };

    // --- Cross-language fixture (emitted by the real Rust encoder) --------

    /// Bytes are the `kandelo.wpk_fork.imported_tables` (KFIT) section emitted by
    /// the REAL Rust instrumenter over a real dylink side module, via
    /// `crates/fork-codec/tests/gen_imported_tables_fixture.rs`. The same
    /// committed bytes are decoded field-for-field by the REAL host TypeScript
    /// decoder in `crates/fork-codec/testdata/gen-imported-tables-fixture.mts`;
    /// if the encoder and either decoder ever disagree on the wire format, that
    /// oracle and this test catch the drift.
    const FIXTURE: &[u8] = include_bytes!("../testdata/imported-tables-wasm32.bin");

    fn table(
        module: &str,
        name: &str,
        import_ordinal: u32,
        owner_id: u32,
        type_code: u8,
        table64: bool,
    ) -> ImportedTable {
        ImportedTable {
            module: String::from(module),
            name: String::from(name),
            import_ordinal,
            owner_id,
            type_code,
            table64,
        }
    }

    #[test]
    fn decodes_real_encoder_fixture_field_for_field() {
        let decoded = decode_imported_tables(FIXTURE).unwrap();
        assert_eq!(
            decoded.tables,
            alloc::vec![
                // The canonical dynamic-linker indirect-function table: a
                // funcref table the child planner reconstructs and re-aliases
                // before instantiation.
                table(
                    "env",
                    "callbacks",
                    1,
                    1,
                    WPK_FORK_MODULE_STATE_GLOBAL_TYPE_FUNCREF,
                    false,
                ),
                // A second funcref table with distinct limits — exercises more
                // than a single record.
                table(
                    "env",
                    "handlers",
                    2,
                    2,
                    WPK_FORK_MODULE_STATE_GLOBAL_TYPE_FUNCREF,
                    false,
                ),
                // An externref table exercising a non-funcref reference element
                // type code.
                table(
                    "env",
                    "objects",
                    3,
                    3,
                    WPK_FORK_MODULE_STATE_GLOBAL_TYPE_EXTERNREF,
                    false,
                ),
            ]
        );
    }

    #[test]
    fn fixture_is_non_vacuous() {
        // Guard against a fixture that silently collapses to an empty or trivial
        // catalog (which would make the field-for-field test vacuously pass).
        let decoded = decode_imported_tables(FIXTURE).unwrap();
        assert_eq!(decoded.tables.len(), 3);
        // A non-funcref reference element type survived the round trip.
        assert!(decoded
            .tables
            .iter()
            .any(|t| t.type_code == WPK_FORK_MODULE_STATE_GLOBAL_TYPE_FUNCREF));
        assert!(decoded
            .tables
            .iter()
            .any(|t| t.type_code == WPK_FORK_MODULE_STATE_GLOBAL_TYPE_EXTERNREF));
        // Owner ids and import ordinals are unique and increasing.
        assert_eq!(
            decoded.tables.iter().map(|t| t.owner_id).collect::<Vec<_>>(),
            alloc::vec![1, 2, 3],
        );
        assert_eq!(
            decoded
                .tables
                .iter()
                .map(|t| t.import_ordinal)
                .collect::<Vec<_>>(),
            alloc::vec![1, 2, 3],
        );
        // No name is empty; the import identities survived the round trip.
        assert!(decoded.tables.iter().all(|t| !t.name.is_empty()));
        assert!(decoded.tables.iter().all(|t| t.module == "env"));
    }

    // --- Hand-built minimal descriptor (targeted framing/validation) ------

    fn put_u16(bytes: &mut [u8], off: usize, value: u16) {
        bytes[off..off + 2].copy_from_slice(&value.to_le_bytes());
    }

    fn put_u32(bytes: &mut [u8], off: usize, value: u32) {
        bytes[off..off + 4].copy_from_slice(&value.to_le_bytes());
    }

    /// Build a canonical single-record descriptor: one funcref imported table
    /// `env.t` (owner 1, import ordinal 0), not table64.
    fn minimal_descriptor() -> Vec<u8> {
        let module_name = b"env";
        let field_name = b"t";
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
        bytes[record + 8] = WPK_FORK_MODULE_STATE_GLOBAL_TYPE_FUNCREF;
        bytes[record + 9] = 0; // flags (not table64)
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
        let decoded = decode_imported_tables(&minimal_descriptor()).unwrap();
        assert_eq!(
            decoded.tables,
            alloc::vec![table(
                "env",
                "t",
                0,
                1,
                WPK_FORK_MODULE_STATE_GLOBAL_TYPE_FUNCREF,
                false,
            )]
        );
    }

    fn decode_mutated(mutate: impl FnOnce(&mut Vec<u8>)) -> Result<ImportedTables, Errno> {
        let mut bytes = minimal_descriptor();
        mutate(&mut bytes);
        decode_imported_tables(&bytes)
    }

    #[test]
    fn rejects_truncated_header() {
        let bytes = minimal_descriptor();
        assert_eq!(
            decode_imported_tables(&bytes[..HEADER_SIZE as usize - 1]),
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
    fn rejects_non_reference_element_type() {
        // i32 (code 1) is a valid KFIG global type but NOT a valid table element
        // type; 5 (v128) and 10 (one past ANYREF) are likewise invalid.
        assert_eq!(
            decode_mutated(|b| b[HEADER_SIZE as usize + 8] = WPK_FORK_MODULE_STATE_GLOBAL_TYPE_I32),
            Err(Errno::EINVAL)
        );
        assert_eq!(
            decode_mutated(|b| b[HEADER_SIZE as usize + 8] = 5),
            Err(Errno::EINVAL)
        );
        assert_eq!(
            decode_mutated(|b| b[HEADER_SIZE as usize + 8] = 10),
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
    fn accepts_table64_flag() {
        let decoded = decode_mutated(|b| b[HEADER_SIZE as usize + 9] = FLAG_TABLE64).unwrap();
        assert!(decoded.tables[0].table64);
    }

    #[test]
    fn accepts_externref_element_type() {
        let decoded = decode_mutated(|b| {
            b[HEADER_SIZE as usize + 8] = WPK_FORK_MODULE_STATE_GLOBAL_TYPE_EXTERNREF
        })
        .unwrap();
        assert_eq!(
            decoded.tables[0].type_code,
            WPK_FORK_MODULE_STATE_GLOBAL_TYPE_EXTERNREF
        );
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

    fn decode_mutated_fixture(mutate: impl FnOnce(&mut Vec<u8>)) -> Result<ImportedTables, Errno> {
        let mut bytes = FIXTURE.to_vec();
        mutate(&mut bytes);
        decode_imported_tables(&bytes)
    }

    #[test]
    fn rejects_duplicate_owner_in_fixture() {
        // Force record 1's owner (2) to record 0's owner (1). Record 0 is
        // 24 + "env"(3) + "callbacks"(9) = 36 bytes.
        let record1 = HEADER_SIZE as usize + 36;
        assert_eq!(
            decode_mutated_fixture(|b| put_u32(b, record1 + 4, 1)),
            Err(Errno::EINVAL)
        );
    }

    #[test]
    fn rejects_unordered_import_ordinal_in_fixture() {
        // Force record 1's import ordinal (2) below record 0's (1).
        let record1 = HEADER_SIZE as usize + 36;
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
            let _ = decode_imported_tables(&FIXTURE[..len]);
        }
        let _ = decode_imported_tables(&[]);
        let _ = decode_imported_tables(&[0u8]);
    }

    #[test]
    fn single_byte_corruptions_never_panic() {
        // Corrupt each byte of the genuine fixture and confirm the decoder stays
        // panic-free (Ok or Err, either is fine).
        for offset in 0..FIXTURE.len() {
            let mut bytes = FIXTURE.to_vec();
            bytes[offset] ^= 0xff;
            let _ = decode_imported_tables(&bytes);
        }
        // Also sweep the hand-built minimal descriptor.
        let base = minimal_descriptor();
        for offset in 0..base.len() {
            let mut bytes = base.clone();
            bytes[offset] ^= 0xff;
            let _ = decode_imported_tables(&bytes);
        }
    }
}
