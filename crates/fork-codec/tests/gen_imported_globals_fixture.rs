//! Regenerates the committed cross-language imported-globals fixture
//! (`crates/fork-codec/testdata/imported-globals-wasm32.bin`).
//!
//! Like the gc_codec descriptor — and unlike the linked-frame, module-state, and
//! replay-event fixtures whose bytes are produced by TypeScript encoders — the
//! `kandelo.wpk_fork.imported_globals` (KFIG) section has NO TypeScript encoder.
//! It is emitted only by the Rust instrumenter
//! (`fork_instrument::module_state::replace_imported_globals_section`, reached
//! here through the full `fork_instrument::instrument` pipeline); the host
//! runtime merely DECODES that section (`readForkImportedGlobals` in
//! `host/src/fork-module-state.ts`).
//!
//! To keep the fixture genuine (real encoder output, never hand-authored bytes),
//! this `#[ignore]`d test drives the real instrumenter over a real dylink side
//! module that imports several application globals (GOT.func mutable scalars, an
//! immutable scalar, and a reference-typed import), then extracts the emitted
//! KFIG custom-section bytes with `wasmparser` — exactly as the fork-instrument
//! test suite reads the section back. The committed bytes are then cross-checked
//! two ways: the Rust `fork-codec` decoder decodes them field-for-field (see
//! `imported_globals.rs` tests), and the real host TypeScript decoder decodes
//! them field-for-field (see `testdata/gen-imported-globals-fixture.mts`).
//! Agreement of both decoders against the same real encoder output is the drift
//! guard.
//!
//! Regenerate with (from repo root):
//!   cargo test -p fork-codec --features gen-fixtures \
//!     --test gen_imported_globals_fixture -- --ignored --nocapture
//! This test only writes `testdata/imported-globals-wasm32.bin`; it changes
//! nothing under `host/` or elsewhere.

use std::path::Path;

use fork_instrument::{instrument, Options};

/// A real dylink-capable side module. The `dylink.0` custom section makes
/// `instrument` treat every cross-module call as a fork boundary and inject the
/// uniform activation-state helpers, so the KFIG section is emitted describing
/// each application-owned imported global. The module imports:
///   - two `GOT.func` mutable scalars (i32 and i64) — the canonical dynamic
///     linker GOT cells whose saved parent table index the child planner
///     restores;
///   - one immutable scalar (`GOT.mem` base) that must be supplied at
///     instantiation because const initializers and immutable re-exports
///     observe it;
///   - one reference-typed import (externref) exercising a non-scalar KFIG
///     type code;
/// and a preceding function import so the recorded import ordinal is offset from
/// the owner ordinal.
const SIDE_MODULE_WAT: &str = r#"
        (module
          (@custom "dylink.0" (before first) "state-only")
          (import "env" "helper" (func $helper (result i32)))
          (import "GOT.func" "callback" (global $callback (mut i32)))
          (import "GOT.func" "wide_callback" (global $wide (mut i64)))
          (import "GOT.mem" "data_base" (global $base i32))
          (import "env" "token" (global $token externref))
          (memory 1)
          (func (export "read_callback") (result i32)
            global.get $callback)
          (func (export "read_base") (result i32)
            global.get $base)
          (func (export "read_token") (result externref)
            global.get $token)
          (func (export "call_helper") (result i32)
            call $helper))
        "#;

const IMPORTED_GLOBALS_SECTION: &str = "kandelo.wpk_fork.imported_globals";

fn custom_section<'a>(bytes: &'a [u8], name: &str) -> &'a [u8] {
    wasmparser::Parser::new(0)
        .parse_all(bytes)
        .find_map(|payload| match payload.expect("parse instrumented module") {
            wasmparser::Payload::CustomSection(section) if section.name() == name => {
                Some(section.data())
            }
            _ => None,
        })
        .unwrap_or_else(|| panic!("missing custom section {name}"))
}

#[test]
#[ignore = "regenerates the committed testdata/imported-globals-wasm32.bin fixture"]
fn regenerate_imported_globals_fixture() {
    let input = wat::parse_str(SIDE_MODULE_WAT).expect("compile side-module WAT");
    let instrumented = instrument(&input, &Options::default()).expect("instrument side module");
    let section = custom_section(&instrumented, IMPORTED_GLOBALS_SECTION);

    let out =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("testdata/imported-globals-wasm32.bin");
    std::fs::write(&out, section).expect("write imported-globals fixture");

    let count = u32::from_le_bytes([section[8], section[9], section[10], section[11]]);
    eprintln!(
        "wrote {} ({} bytes): {} imported-global records",
        out.display(),
        section.len(),
        count,
    );

    // Dump every record so the committed Rust/TS decoder assertions can be built
    // from authoritative encoder output.
    let header = 16usize;
    let mut offset = header;
    for index in 0..count {
        let record_size =
            u32::from_le_bytes(section[offset..offset + 4].try_into().unwrap()) as usize;
        let owner = u32::from_le_bytes(section[offset + 4..offset + 8].try_into().unwrap());
        let type_code = section[offset + 8];
        let flags = section[offset + 9];
        let module_len =
            u32::from_le_bytes(section[offset + 12..offset + 16].try_into().unwrap()) as usize;
        let name_len =
            u32::from_le_bytes(section[offset + 16..offset + 20].try_into().unwrap()) as usize;
        let import_ordinal =
            u32::from_le_bytes(section[offset + 20..offset + 24].try_into().unwrap());
        let names = offset + 24;
        let module_name = std::str::from_utf8(&section[names..names + module_len]).unwrap();
        let field_name =
            std::str::from_utf8(&section[names + module_len..names + module_len + name_len])
                .unwrap();
        eprintln!(
            "  record {index}: owner={owner} type={type_code} flags={flags} \
             import_ordinal={import_ordinal} module={module_name:?} name={field_name:?}",
        );
        offset += record_size;
    }
    assert_eq!(offset, section.len(), "records must span the whole section");
}
