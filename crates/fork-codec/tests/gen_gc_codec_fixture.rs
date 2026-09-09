//! Regenerates the committed cross-language gc_codec fixture
//! (`crates/fork-codec/testdata/gc-codec-wasm32.bin`).
//!
//! Unlike the linked-frame, module-state, and replay-event fixtures — whose wire
//! bytes are produced by real TypeScript encoders in `host/src` — the gc_codec
//! `kandelo.wpk_fork.gc_codec` descriptor has NO TypeScript encoder. It is
//! emitted only by the Rust instrumenter
//! (`fork_instrument::module_gc_codec::encode_descriptor`, reached here through
//! `plan(&module).descriptor()`); the host runtime merely DECODES that section
//! (`decodeForkGcCodecDescriptor` in `host/src/fork-gc-codec.ts`).
//!
//! To keep the fixture genuine (real encoder output, never hand-authored
//! bytes), this `#[ignore]`d test drives the real instrumenter over a real
//! GC-typed module — the same module the fork-instrument Node conformance test
//! uses — and writes the emitted descriptor bytes. The committed bytes are then
//! cross-checked two ways: the Rust `fork-codec` decoder decodes them
//! field-for-field (see `gc_codec.rs` tests), and the real host TypeScript
//! decoder decodes them field-for-field (see
//! `testdata/gen-gc-codec-fixture.mts`). Agreement of both decoders against the
//! same real encoder output is the drift guard.
//!
//! Regenerate with (from repo root):
//!   cargo test -p fork-codec --features gen-fixtures \
//!     --test gen_gc_codec_fixture -- --ignored --nocapture
//! This test only writes `crates/fork-codec/testdata/gc-codec-wasm32.bin`; it
//! changes nothing under `host/` or elsewhere.

use std::path::Path;

use fork_instrument::module_gc_codec;
use walrus::Module;

/// The real GC provider module used by the fork-instrument Node conformance
/// suite (`crates/fork-instrument/tests/module_gc_codec_node.rs`). It exercises
/// a struct with mutable/nullable/internal reference fields plus `array.new`,
/// `array.new_fixed`, and `array.new_data` construction sites, so the emitted
/// descriptor carries base struct/array layouts AND specialized array
/// constructor layouts (ArrayNew, ArrayFixed, ArrayData).
const GC_MODULE_WAT: &str = r#"
        (module
          (import "env" "memory" (memory 2))
          (type $node
            (struct
              (field (mut i32))
              (field (mut (ref null $node)))
              (field (mut (ref null any)))))
          (type $fixed (array i16))
          (type $data-bytes (array i8))
          (type $nullable-array (array (ref null $node)))
          (table $objects (export "objects") 5 (ref null any))
          (data $bytes "\0b\16\21")

          (func (export "create_cycle")
            (local $node (ref null $node))
            i32.const 77
            ref.null $node
            ref.null any
            struct.new $node
            local.set $node
            local.get $node
            local.get $node
            struct.set $node 1
            i32.const 0
            local.get $node
            table.set $objects)

          (func (export "create_fixed")
            (local $array (ref null $fixed))
            i32.const 11
            i32.const 22
            array.new_fixed $fixed 2
            local.set $array
            i32.const 2
            local.get $array
            table.set $objects)

          (func (export "create_data")
            (local $array (ref null $data-bytes))
            i32.const 0
            i32.const 3
            array.new_data $data-bytes $bytes
            local.set $array
            i32.const 3
            local.get $array
            table.set $objects)

          (func (export "create_nullable_empty")
            (local $array (ref null $nullable-array))
            ref.null $node
            i32.const 0
            array.new $nullable-array
            local.set $array
            i32.const 4
            local.get $array
            table.set $objects))
        "#;

#[test]
#[ignore = "regenerates the committed testdata/gc-codec-wasm32.bin fixture"]
fn regenerate_gc_codec_fixture() {
    let wasm = wat::parse_str(GC_MODULE_WAT).expect("compile GC provider WAT");
    let module = Module::from_buffer(&wasm).expect("parse GC provider module");
    let plan = module_gc_codec::plan(&module).expect("plan GC codec");
    let descriptor = plan.descriptor();

    let out = Path::new(env!("CARGO_MANIFEST_DIR")).join("testdata/gc-codec-wasm32.bin");
    std::fs::write(&out, &descriptor).expect("write gc-codec fixture");

    // Print a summary so the committed Rust/TS decoder assertions can be built
    // from authoritative encoder output.
    let layout_count = u32::from_le_bytes([descriptor[8], descriptor[9], descriptor[10], descriptor[11]]);
    let field_count = u32::from_le_bytes([descriptor[12], descriptor[13], descriptor[14], descriptor[15]]);
    eprintln!(
        "wrote {} ({} bytes): {} layouts, {} fields",
        out.display(),
        descriptor.len(),
        layout_count,
        field_count,
    );
    for layout in plan.layouts() {
        eprintln!(
            "  layout id={} type_ordinal={} kind={:?} constructor={:?} \
             base={} flags(prov={},shell={}) stride={} fields={} \
             super={:?} prov_scalar={} prov_refs={}",
            layout.id,
            layout.type_ordinal,
            layout.kind,
            layout.constructor,
            layout.base_layout_id,
            layout.requires_provenance || matches!(layout.constructor, module_gc_codec::GcConstructorKind::ArrayNew | module_gc_codec::GcConstructorKind::ArrayDefault | module_gc_codec::GcConstructorKind::ArrayFixed { .. } | module_gc_codec::GcConstructorKind::ArrayData { .. } | module_gc_codec::GcConstructorKind::ArrayElement { .. }),
            layout.defaultable_shell,
            layout.scalar_len_or_stride,
            layout.fields.len(),
            layout.super_type_ordinal,
            layout.provenance_scalar_len,
            layout.provenance_reference_count,
        );
    }
}
