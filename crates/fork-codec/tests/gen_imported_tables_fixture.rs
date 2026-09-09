//! Regenerates the committed cross-language imported-tables fixture
//! (`crates/fork-codec/testdata/imported-tables-wasm32.bin`).
//!
//! Like the gc_codec and imported-globals descriptors — and unlike the
//! linked-frame, module-state, and replay-event fixtures whose bytes are
//! produced by TypeScript encoders — the `kandelo.wpk_fork.imported_tables`
//! (KFIT) section has NO TypeScript encoder. It is emitted only by the Rust
//! instrumenter
//! (`fork_instrument::module_state::replace_imported_tables_section`, reached
//! here through the full `fork_instrument::instrument` pipeline); the host
//! runtime merely DECODES that section (`readForkImportedTables` in
//! `host/src/fork-module-state.ts`).
//!
//! To keep the fixture genuine (real encoder output, never hand-authored bytes),
//! this `#[ignore]`d test drives the real instrumenter over a real dylink side
//! module that imports several application tables (two funcref tables and an
//! externref table, plus a preceding function import so the recorded import
//! ordinal is offset from the owner ordinal), then extracts the emitted KFIT
//! custom-section bytes with `wasmparser` — exactly as the fork-instrument test
//! suite reads the section back. The committed bytes are then cross-checked two
//! ways: the Rust `fork-codec` decoder decodes them field-for-field (see
//! `imported_tables.rs` tests), and the real host TypeScript decoder decodes
//! them field-for-field (see `testdata/gen-imported-tables-fixture.mts`).
//! Agreement of both decoders against the same real encoder output is the drift
//! guard.
//!
//! Regenerate with (from repo root):
//!   cargo test -p fork-codec --features gen-fixtures \
//!     --test gen_imported_tables_fixture -- --ignored --nocapture
//! This test only writes `testdata/imported-tables-wasm32.bin`; it changes
//! nothing under `host/` or elsewhere.

use std::path::Path;

use fork_instrument::{instrument, Options};

/// A real dylink-capable side module. The `dylink.0` custom section makes
/// `instrument` treat every cross-module call as a fork boundary and inject the
/// uniform activation-state helpers, so the KFIT section is emitted describing
/// each application-owned imported table. The module imports:
///   - two `funcref` tables (`env.callbacks`, `env.handlers`) — indirect-call
///     tables the child planner reconstructs and re-aliases before
///     instantiation;
///   - one `externref` table (`env.objects`) exercising a non-funcref reference
///     element type code;
/// and a preceding function import so the recorded import ordinal is offset from
/// the owner ordinal. Each table is referenced by a function so the table is a
/// live identity edge, not dead metadata.
const SIDE_MODULE_WAT: &str = r#"
        (module
          (@custom "dylink.0" (before first) "state-only")
          (import "env" "helper" (func $helper (result i32)))
          (import "env" "callbacks" (table $callbacks 2 8 funcref))
          (import "env" "handlers" (table $handlers 1 4 funcref))
          (import "env" "objects" (table $objects 1 externref))
          (memory 1)
          (type $sig (func (result i32)))
          (func (export "call_callback") (param i32) (result i32)
            local.get 0
            call_indirect $callbacks (type $sig))
          (func (export "call_handler") (param i32) (result i32)
            local.get 0
            call_indirect $handlers (type $sig))
          (func (export "load_object") (param i32) (result externref)
            local.get 0
            table.get $objects)
          (func (export "call_helper") (result i32)
            call $helper))
        "#;

const IMPORTED_TABLES_SECTION: &str = "kandelo.wpk_fork.imported_tables";

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
#[ignore = "regenerates the committed testdata/imported-tables-wasm32.bin fixture"]
fn regenerate_imported_tables_fixture() {
    let input = wat::parse_str(SIDE_MODULE_WAT).expect("compile side-module WAT");
    let instrumented = instrument(&input, &Options::default()).expect("instrument side module");
    let section = custom_section(&instrumented, IMPORTED_TABLES_SECTION);

    let out = Path::new(env!("CARGO_MANIFEST_DIR")).join("testdata/imported-tables-wasm32.bin");
    std::fs::write(&out, section).expect("write imported-tables fixture");

    let count = u32::from_le_bytes([section[8], section[9], section[10], section[11]]);
    eprintln!(
        "wrote {} ({} bytes): {} imported-table records",
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
