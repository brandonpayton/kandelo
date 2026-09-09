//! Regenerates the committed cross-language exception-codec fixture
//! (`crates/fork-codec/testdata/exception-codec-wasm32.bin`).
//!
//! Like the gc_codec/imported-globals/imported-tables descriptors — and unlike
//! the linked-frame, module-state, and replay-event fixtures whose bytes are
//! produced by TypeScript encoders — the `kandelo.wpk_fork.exception_codec`
//! section has NO TypeScript encoder. It is emitted only by the Rust
//! instrumenter (`fork_instrument::module_exception_codec`, specifically its
//! `replace_descriptor`, reached here through the public
//! `module_exception_codec::inject`); the host runtime merely DECODES that
//! section (`readForkExceptionCodecDescriptor` in
//! `host/src/fork-exception-provider.ts`).
//!
//! To keep the fixture genuine (real encoder output, never hand-authored
//! bytes), this `#[ignore]`d test drives the real injector over a real module
//! carrying three exception tags — an empty tag, an all-scalar tag
//! (i32/i64/f32/f64/v128), and an all-reference tag (extern/func/exn/any) — the
//! same module the fork-instrument conformance test uses, then extracts the
//! emitted descriptor bytes with `wasmparser`, exactly as that suite reads the
//! section back. The committed bytes are then cross-checked two ways: the Rust
//! `fork-codec` decoder decodes them field-for-field (see `exception_codec.rs`
//! tests), and the real host TypeScript decoder decodes them field-for-field
//! (see `testdata/gen-exception-codec-fixture.mts`). Agreement of both decoders
//! against the same real encoder output is the drift guard.
//!
//! Regenerate with (from repo root):
//!   cargo test -p fork-codec --features gen-fixtures \
//!     --test gen_exception_codec_fixture -- --ignored --nocapture
//! This test only writes `testdata/exception-codec-wasm32.bin`; it changes
//! nothing under `host/` or elsewhere.

use std::path::Path;

use fork_instrument::module_exception_codec;
use walrus::Module;

/// A real module with three exception tags exercising every payload shape the
/// descriptor records: an empty tag (scalar_len 0, ref_count 0), an all-scalar
/// tag (i32+i64+f32+f64+v128 = 40 scalar bytes, ref_count 0), and an
/// all-reference tag (extern/func/exn/any = scalar_len 0, ref_count 4). This is
/// the module the fork-instrument `module_exception_codec` conformance suite
/// uses.
const CODEC_MODULE_WAT: &str = r#"
        (module
          (import "env" "memory" (memory 1))
          (tag $empty)
          (tag $scalars (param i32 i64 f32 f64 v128))
          (tag $references
            (param (ref null extern) (ref null func) (ref null exn) (ref null any))))
        "#;

const EXCEPTION_CODEC_SECTION: &str = "kandelo.wpk_fork.exception_codec";

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
#[ignore = "regenerates the committed testdata/exception-codec-wasm32.bin fixture"]
fn regenerate_exception_codec_fixture() {
    let wasm = wat::parse_str(CODEC_MODULE_WAT).expect("compile codec module WAT");
    let mut module = Module::from_buffer(&wasm).expect("parse codec module");
    let memory = module.memories.iter().next().expect("fixture memory").id();
    module_exception_codec::inject(&mut module, memory).expect("inject exception codec");
    let output = module.emit_wasm();
    let section = custom_section(&output, EXCEPTION_CODEC_SECTION);

    let out =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("testdata/exception-codec-wasm32.bin");
    std::fs::write(&out, section).expect("write exception-codec fixture");

    let version = section[0];
    let count = u32::from_le_bytes([section[4], section[5], section[6], section[7]]);
    eprintln!(
        "wrote {} ({} bytes): version {version}, {count} tag records",
        out.display(),
        section.len(),
    );
    let header = 8usize;
    let record = 16usize;
    for index in 0..count as usize {
        let offset = header + index * record;
        let tag_ordinal =
            u32::from_le_bytes(section[offset..offset + 4].try_into().unwrap());
        let layout_id =
            u32::from_le_bytes(section[offset + 4..offset + 8].try_into().unwrap());
        let scalar_len =
            u32::from_le_bytes(section[offset + 8..offset + 12].try_into().unwrap());
        let reference_count =
            u32::from_le_bytes(section[offset + 12..offset + 16].try_into().unwrap());
        eprintln!(
            "  tag {index}: ordinal={tag_ordinal} layout={layout_id} \
             scalar_bytes={scalar_len} references={reference_count}",
        );
    }
    assert_eq!(
        section.len(),
        header + count as usize * record,
        "records must span the whole section",
    );
}
