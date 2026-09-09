//! Regenerates the committed cross-language resume-catalog fixture
//! (`crates/fork-codec/testdata/resume-catalog-wasm32.bin`).
//!
//! Like the gc_codec/imported-globals descriptors — and unlike the linked-frame,
//! module-state, and replay-event fixtures whose bytes are produced by
//! TypeScript encoders — the `kandelo.wpk_fork.resume_catalog` (KFRC) section
//! has NO TypeScript encoder. It is emitted only by the Rust instrumenter
//! (`fork_instrument::instrument`'s `emit_resume_catalog`, reached here through
//! the full `instrument` pipeline); the host runtime merely DECODES it
//! (`readForkResumeCatalog` in `host/src/fork-resume-catalog.ts`).
//!
//! To keep the fixture genuine (real encoder output, never hand-authored
//! bytes), this `#[ignore]`d test drives the real instrumenter over a real
//! fork-reaching module — one whose deep function calls `kernel_fork` and whose
//! three roots reach it through direct, indirect, and ref tail calls, so the
//! pipeline emits four resume thunks (the deep activation plus three roots) —
//! then extracts the emitted KFRC section bytes with `wasmparser`, exactly as
//! the fork-instrument test suite reads the section back. The committed bytes
//! are then cross-checked two ways: the Rust `fork-codec` decoder decodes them
//! field-for-field (see `catalogs.rs` tests), and the real host TypeScript
//! decoder decodes them field-for-field (see
//! `testdata/gen-resume-catalog-fixture.mts`). Agreement of both decoders
//! against the same real encoder output is the drift guard.
//!
//! Regenerate with (from repo root):
//!   cargo test -p fork-codec --features gen-fixtures \
//!     --test gen_resume_catalog_fixture -- --ignored --nocapture
//! This test only writes `testdata/resume-catalog-wasm32.bin`; it changes
//! nothing under `host/` or elsewhere.

use std::path::Path;

use fork_instrument::{Options, instrument};

/// A real fork-reaching module. `$deep` calls `kernel_fork`; the three exported
/// roots reach it through direct, indirect, and ref tail calls. The pipeline
/// emits resume thunks for the deep activation and each of the three roots, so
/// the catalog carries four strictly-ordered `(function_ordinal, local_slot)`
/// records. This is the module the fork-instrument `instrument` conformance
/// suite uses for resume routing.
const RESUME_MODULE_WAT: &str = r#"
        (module
          (import "kernel" "kernel_fork" (func $fork (result i32)))
          (type $ft (func (result i32)))
          (table 1 funcref)
          (elem (i32.const 0) $deep)
          (elem declare func $deep)
          (func $deep (type $ft) (result i32)
            call $fork)
          (func $tail_direct (type $ft) (result i32)
            return_call $deep)
          (func $tail_indirect (type $ft) (result i32)
            i32.const 0
            return_call_indirect (type $ft))
          (func $tail_ref (type $ft) (result i32)
            ref.func $deep
            return_call_ref $ft)
          (func $root_direct (export "root_direct") (result i32)
            call $tail_direct)
          (func $root_indirect (export "root_indirect") (result i32)
            call $tail_indirect)
          (func $root_ref (export "root_ref") (result i32)
            call $tail_ref)
          (memory 1))
    "#;

const RESUME_CATALOG_SECTION: &str = "kandelo.wpk_fork.resume_catalog";

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
#[ignore = "regenerates the committed testdata/resume-catalog-wasm32.bin fixture"]
fn regenerate_resume_catalog_fixture() {
    let input = wat::parse_str(RESUME_MODULE_WAT).expect("compile resume module WAT");
    let instrumented = instrument(&input, &Options::default()).expect("instrument resume module");
    let section = custom_section(&instrumented, RESUME_CATALOG_SECTION);

    let out =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("testdata/resume-catalog-wasm32.bin");
    std::fs::write(&out, section).expect("write resume-catalog fixture");

    let count = u32::from_le_bytes([section[8], section[9], section[10], section[11]]);
    eprintln!(
        "wrote {} ({} bytes): {count} resume records",
        out.display(),
        section.len(),
    );
    let header = 12usize;
    let record = 8usize;
    for index in 0..count as usize {
        let offset = header + index * record;
        let function_ordinal =
            u32::from_le_bytes(section[offset..offset + 4].try_into().unwrap());
        let local_slot =
            u32::from_le_bytes(section[offset + 4..offset + 8].try_into().unwrap());
        eprintln!("  record {index}: function_ordinal={function_ordinal} local_slot={local_slot}");
    }
    assert_eq!(
        section.len(),
        header + count as usize * record,
        "records must span the whole section",
    );
}
