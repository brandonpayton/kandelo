//! Regenerates the committed cross-language static-root-catalog fixture
//! (`crates/fork-codec/testdata/static-root-catalog-wasm32.bin`).
//!
//! Like the gc_codec/imported-globals descriptors — and unlike the linked-frame,
//! module-state, and replay-event fixtures whose bytes are produced by
//! TypeScript encoders — the `kandelo.wpk_fork.static_root_catalog` (KFSR)
//! section has NO TypeScript encoder. It is emitted only by the Rust
//! instrumenter (`fork_instrument::static_reference_catalog::inject`); the host
//! runtime merely DECODES its header (`readForkStaticRootCatalogCount` in
//! `host/src/fork-static-root-catalog.ts`).
//!
//! This descriptor is header-only: it carries the magic, version, header size,
//! and the harvest-table entry COUNT. The per-root identities are recovered
//! from the live `__wpk_fork_static_root_catalog` table export after
//! instantiation (the deferred engine-floor half), not from these bytes. There
//! are no per-entry records to serialize.
//!
//! To keep the fixture genuine (real encoder output, never hand-authored
//! bytes), this `#[ignore]`d test drives the real planner+injector over the
//! module the fork-instrument `static_reference_catalog` conformance test uses
//! (an immutable ref-typed global, a `global.get` alias that folds onto it, and
//! an independently allocating element root — two harvest ordinals total), then
//! extracts the emitted section bytes with `wasmparser`. The committed bytes are
//! cross-checked two ways: the Rust `fork-codec` decoder decodes them
//! field-for-field (see `catalogs.rs` tests) and the real host TypeScript
//! decoder decodes them (see `testdata/gen-static-root-catalog-fixture.mts`).
//!
//! Regenerate with (from repo root):
//!   cargo test -p fork-codec --features gen-fixtures \
//!     --test gen_static_root_catalog_fixture -- --ignored --nocapture
//! This test only writes `testdata/static-root-catalog-wasm32.bin`; it changes
//! nothing under `host/` or elsewhere.

use std::path::Path;

use fork_instrument::static_reference_catalog;
use walrus::Module;

/// The module the fork-instrument `static_reference_catalog` conformance suite
/// uses. The immutable global and its `global.get` alias share ordinal zero;
/// the independently allocating element root owns ordinal one, so the harvest
/// table (and therefore the descriptor count) is 2.
const STATIC_ROOT_MODULE_WAT: &str = r#"
        (module
          (type $pair (struct (field i32)))
          (global $root (ref $pair)
            (struct.new $pair (i32.const 41)))
          (global $alias (ref $pair)
            (global.get $root))
          (table $values (export "values") 3 3 (ref null $pair))
          (elem $roots (ref $pair)
            (global.get $root)
            (global.get $alias)
            (struct.new $pair (i32.const 99)))

          (func (export "initialize_values")
            i32.const 0
            i32.const 0
            i32.const 3
            table.init $values $roots)

          (func (export "matches_root")
            (param (ref null $pair)) (result i32)
            (local.get 0)
            (global.get $root)
            ref.eq)

          (func (export "matches_table")
            (param i32) (param (ref null $pair)) (result i32)
            (local.get 0)
            (table.get $values)
            (local.get 1)
            ref.eq))
        "#;

const STATIC_ROOT_CATALOG_SECTION: &str = "kandelo.wpk_fork.static_root_catalog";

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
#[ignore = "regenerates the committed testdata/static-root-catalog-wasm32.bin fixture"]
fn regenerate_static_root_catalog_fixture() {
    let wasm = wat::parse_str(STATIC_ROOT_MODULE_WAT).expect("compile static-root module WAT");
    let mut module = Module::from_buffer(&wasm).expect("parse static-root module");
    let plan = static_reference_catalog::plan(&mut module);
    let root_count = plan.root_count();
    static_reference_catalog::inject(&mut module, plan);
    let output = module.emit_wasm();
    let section = custom_section(&output, STATIC_ROOT_CATALOG_SECTION);

    let out =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("testdata/static-root-catalog-wasm32.bin");
    std::fs::write(&out, section).expect("write static-root-catalog fixture");

    let count = u32::from_le_bytes([section[8], section[9], section[10], section[11]]);
    eprintln!(
        "wrote {} ({} bytes): count={count} (plan root_count={root_count})",
        out.display(),
        section.len(),
    );
    assert_eq!(
        count as usize, root_count,
        "descriptor count must equal the plan root count",
    );
}
