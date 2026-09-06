//! Write/read named 32-byte identity custom sections on a wasm artifact.
//!
//! Two sibling sections use this machinery, both appended at cache-store time
//! by `build_into_cache`:
//!
//! * `kandelo.build.key` — the cache key a locally-built wasm artifact was
//!   produced under. `verify-fresh` compares this stamp against the freshly
//!   computed expected key so a stale mirror fails loud, independent of the
//!   ABI version.
//! * `kandelo.abi.contract` — the ABI-contract digest
//!   (`hash(abi/snapshot.json + ABI_VERSION)`) the artifact was built against.
//!   The host compares a guest's stamp against the running kernel's own
//!   `kandelo.abi.contract` stamp at exec, so a structural ABI change can't let
//!   a stale guest run against a mismatched kernel even when the ABI version
//!   numbers coincide.
//!
//! Append-only: each section is stamped exactly once, on a fresh build.
//! Appending a custom section to the tail of a valid module is valid and needs
//! no re-encoder; reads use the existing `wasmparser` dependency. The two
//! sections are independent — a module carrying `kandelo.build.key` must still
//! accept a `kandelo.abi.contract` stamp; double-stamp refusal is per name.

use wasmparser::{Parser, Payload};

pub(crate) const BUILD_KEY_SECTION: &str = "kandelo.build.key";
pub(crate) const ABI_CONTRACT_SECTION: &str = "kandelo.abi.contract";

/// Whether these bytes are a wasm module at all (`\0asm` magic).
///
/// A package may declare non-module artifacts -- zip lazy-archives such as
/// `lsof-docs.zip` or a browser bundle's runtime archive -- as program
/// outputs. Only a wasm module can carry the build-key custom section, so
/// stamping and stamp verification both gate on this instead of parsing and
/// failing on bytes that were never wasm.
pub(crate) fn is_wasm_module(bytes: &[u8]) -> bool {
    bytes.starts_with(&[0x00, 0x61, 0x73, 0x6d])
}

/// Read the 32-byte payload of the first custom section named `name`, or
/// `None` if the module carries no such section.
pub(crate) fn read_named_section(wasm: &[u8], name: &str) -> Result<Option<[u8; 32]>, String> {
    for payload in Parser::new(0).parse_all(wasm) {
        let payload = payload.map_err(|e| format!("parse wasm for {name}: {e}"))?;
        if let Payload::CustomSection(section) = payload {
            if section.name() == name {
                let data = section.data();
                if data.len() != 32 {
                    return Err(format!(
                        "{name} custom section is {} bytes, expected 32",
                        data.len()
                    ));
                }
                let mut key = [0u8; 32];
                key.copy_from_slice(data);
                return Ok(Some(key));
            }
        }
    }
    Ok(None)
}

/// Append a 32-byte custom section named `name`. Refuses to double-stamp the
/// SAME name, but a DIFFERENT section name coexists happily.
pub(crate) fn stamp_named_section(
    wasm: &[u8],
    name: &str,
    key: &[u8; 32],
) -> Result<Vec<u8>, String> {
    if read_named_section(wasm, name)?.is_some() {
        return Err(format!(
            "wasm already carries a {name} section; refusing to double-stamp"
        ));
    }
    // Custom section: id(0x00) | uleb size | uleb name-len | name | payload
    let name_bytes = name.as_bytes();
    let mut body = Vec::new();
    write_uleb128(&mut body, name_bytes.len() as u64);
    body.extend_from_slice(name_bytes);
    body.extend_from_slice(key);

    let mut out = wasm.to_vec();
    out.push(0x00);
    write_uleb128(&mut out, body.len() as u64);
    out.extend_from_slice(&body);
    Ok(out)
}

pub(crate) fn read_build_key(wasm: &[u8]) -> Result<Option<[u8; 32]>, String> {
    read_named_section(wasm, BUILD_KEY_SECTION)
}

pub(crate) fn stamp_build_key(wasm: &[u8], key: &[u8; 32]) -> Result<Vec<u8>, String> {
    stamp_named_section(wasm, BUILD_KEY_SECTION, key)
}

fn write_uleb128(out: &mut Vec<u8>, mut value: u64) {
    loop {
        let mut byte = (value & 0x7f) as u8;
        value >>= 7;
        if value != 0 {
            byte |= 0x80;
        }
        out.push(byte);
        if value == 0 {
            break;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Minimal valid wasm module: magic + version, no sections.
    fn empty_module() -> Vec<u8> {
        vec![0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]
    }

    #[test]
    fn stamp_roundtrips() {
        let key = [7u8; 32];
        let stamped = stamp_build_key(&empty_module(), &key).unwrap();
        assert_eq!(read_build_key(&stamped).unwrap(), Some(key));
    }

    #[test]
    fn absent_section_reads_none() {
        assert_eq!(read_build_key(&empty_module()).unwrap(), None);
        assert_eq!(
            read_named_section(&empty_module(), ABI_CONTRACT_SECTION).unwrap(),
            None
        );
    }

    #[test]
    fn zip_bytes_are_not_a_wasm_module() {
        assert!(is_wasm_module(&empty_module()));
        assert!(!is_wasm_module(b"PK\x03\x04qux"));
        assert!(!is_wasm_module(b""));
    }

    #[test]
    fn double_stamp_is_an_error() {
        let once = stamp_build_key(&empty_module(), &[1u8; 32]).unwrap();
        let err = stamp_build_key(&once, &[2u8; 32]).unwrap_err();
        assert!(err.contains("already"), "{err}");
    }

    #[test]
    fn distinct_sections_coexist_and_roundtrip_independently() {
        // A module carrying kandelo.build.key must still accept a
        // kandelo.abi.contract stamp, and both payloads read back independently.
        let build_key = [3u8; 32];
        let abi_digest = [9u8; 32];
        let with_build = stamp_build_key(&empty_module(), &build_key).unwrap();
        let with_both =
            stamp_named_section(&with_build, ABI_CONTRACT_SECTION, &abi_digest).unwrap();
        assert_eq!(read_build_key(&with_both).unwrap(), Some(build_key));
        assert_eq!(
            read_named_section(&with_both, ABI_CONTRACT_SECTION).unwrap(),
            Some(abi_digest)
        );
        // Order-independent: stamping abi.contract first still coexists.
        let with_abi_first =
            stamp_named_section(&empty_module(), ABI_CONTRACT_SECTION, &abi_digest).unwrap();
        let with_both_2 = stamp_build_key(&with_abi_first, &build_key).unwrap();
        assert_eq!(read_build_key(&with_both_2).unwrap(), Some(build_key));
        assert_eq!(
            read_named_section(&with_both_2, ABI_CONTRACT_SECTION).unwrap(),
            Some(abi_digest)
        );
    }

    #[test]
    fn double_stamp_refusal_is_per_name() {
        let abi_digest = [5u8; 32];
        let once = stamp_named_section(&empty_module(), ABI_CONTRACT_SECTION, &abi_digest).unwrap();
        // Re-stamping the SAME name errors.
        let err =
            stamp_named_section(&once, ABI_CONTRACT_SECTION, &[6u8; 32]).unwrap_err();
        assert!(err.contains("already"), "{err}");
        // But a different name is still accepted.
        assert!(stamp_build_key(&once, &[1u8; 32]).is_ok());
    }
}
