//! Tests for Phase 4a: runtime injection.
//!
//! After instrumentation, every module must expose the seven control
//! exports with the documented ABI. We verify this by:
//!
//! - Re-parsing the instrumented module with walrus.
//! - Checking the named exports are present, point to functions with
//!   the expected signatures.
//! - Checking the two globals are present and mutable with the
//!   correct types.
//! - Independently validating via wasmparser that the emitted module
//!   is well-formed.

use fork_instrument::linked_frames::{
    FrameFormatDescriptor, LINKED_FRAME_FORMAT_SECTION, PointerWidth,
};
use fork_instrument::runtime::names;
use fork_instrument::{Options, UNWIND_TRANSPORT_SECTION, UNWIND_TRANSPORT_VERSION, instrument};
use walrus::{ExportItem, ImportKind, Module, ValType};
use wasm_posix_shared::abi::{
    WPK_FORK_CAP_ACTIVATION_STATE_SAFE, WPK_FORK_CAP_DYLINK_MAIN, WPK_FORK_CAP_SIDE_ENTRY,
    WPK_FORK_CAPABILITIES_SECTION, WPK_FORK_CAPABILITIES_VERSION,
    WPK_FORK_IMPORTED_GLOBALS_SECTION, WPK_FORK_MODULE_STATE_FORMAT_SECTION,
    WPK_FORK_REQUIRED_EXPORTS, WPK_FORK_REQUIRED_IMPORTS, WPK_FORK_REQUIRED_TABLE_IMPORTS,
};
use wasmparser::{Parser, Payload};

fn instrument_wat(wat_src: &str) -> Vec<u8> {
    let bytes = wat::parse_str(wat_src).expect("wat parse");
    instrument(&bytes, &Options::default()).expect("instrument")
}

fn validate(bytes: &[u8]) {
    let mut validator =
        wasmparser::Validator::new_with_features(wasmparser::WasmFeatures::default());
    validator.validate_all(bytes).expect("valid wasm");
}

fn fork_capabilities(bytes: &[u8]) -> Vec<Vec<u8>> {
    Parser::new(0)
        .parse_all(bytes)
        .filter_map(|payload| match payload.expect("parse payload") {
            Payload::CustomSection(section) if section.name() == WPK_FORK_CAPABILITIES_SECTION => {
                Some(section.data().to_vec())
            }
            _ => None,
        })
        .collect()
}

fn export_function_id(module: &Module, name: &str) -> walrus::FunctionId {
    let export = module
        .exports
        .iter()
        .find(|e| e.name == name)
        .unwrap_or_else(|| panic!("export `{name}` not found"));
    match export.item {
        ExportItem::Function(id) => id,
        _ => panic!("export `{name}` is not a function"),
    }
}

fn func_signature(module: &Module, id: walrus::FunctionId) -> (Vec<ValType>, Vec<ValType>) {
    let ty_id = module.funcs.get(id).ty();
    let ty = module.types.get(ty_id);
    (ty.params().to_vec(), ty.results().to_vec())
}

const EMPTY_MODULE_WITH_FORK: &str = r#"
    (module
      (import "kernel" "kernel_fork" (func $fork (result i32)))
      (memory 1))
"#;

#[test]
fn instrumented_module_validates() {
    let bytes = instrument_wat(EMPTY_MODULE_WITH_FORK);
    validate(&bytes);
}

#[test]
fn preinstrumented_artifact_cannot_be_restamped_as_activation_safe() {
    let once = instrument_wat(EMPTY_MODULE_WITH_FORK);
    let error = instrument(&once, &Options::default())
        .expect_err("an existing fork transform must not be restamped");
    let message = error.to_string();
    assert!(
        message.contains("input already contains wasm-fork-instrument"),
        "{message}"
    );
    assert!(message.contains("raw linker output"), "{message}");
}

#[test]
fn source_module_cannot_spoof_private_global_catalog_exports() {
    let bytes = wat::parse_str(
        r#"
        (module
          (global $value (mut i32) (i32.const 0))
          (export "__wpk_fork_global_1" (global $value))
          (memory 1))
        "#,
    )
    .expect("wat parse");
    let error = instrument(&bytes, &Options::default())
        .expect_err("a source export must not collide with the private global catalog");
    let message = error.to_string();
    assert!(
        message.contains("input already contains wasm-fork-instrument"),
        "{message}"
    );
    assert!(message.contains("raw linker output"), "{message}");
}

#[test]
fn source_module_cannot_spoof_private_table_catalog_exports() {
    let bytes = wat::parse_str(
        r#"
        (module
          (table $value 1 funcref)
          (export "__wpk_fork_table_1" (table $value))
          (memory 1))
        "#,
    )
    .expect("wat parse");
    let error = instrument(&bytes, &Options::default())
        .expect_err("a source export must not collide with the private table catalog");
    assert!(
        error
            .to_string()
            .contains("input already contains wasm-fork-instrument")
    );
}

#[test]
fn linked_runtime_imports_transaction_hooks_and_emits_exact_prefix_metadata() {
    let bytes = instrument_wat(EMPTY_MODULE_WITH_FORK);
    let module = Module::from_buffer(&bytes).unwrap();
    for name in [
        names::IMPORT_FRAME_RESERVE,
        names::IMPORT_FRAME_COMMIT,
        names::IMPORT_FRAME_NEXT,
    ] {
        assert!(
            module
                .imports
                .iter()
                .any(|import| import.module == "env" && import.name == name),
            "missing linked continuation import {name}",
        );
    }

    let descriptors: Vec<_> = Parser::new(0)
        .parse_all(&bytes)
        .filter_map(|payload| match payload.expect("parse payload") {
            Payload::CustomSection(section) if section.name() == LINKED_FRAME_FORMAT_SECTION => {
                Some(FrameFormatDescriptor::decode(section.data()).unwrap())
            }
            _ => None,
        })
        .collect();
    assert_eq!(
        descriptors,
        vec![FrameFormatDescriptor::current(PointerWidth::Wasm32, 24)],
    );
}

#[test]
fn linked_runtime_imports_exact_private_unwind_tag_and_metadata() {
    let bytes = instrument_wat(EMPTY_MODULE_WITH_FORK);
    let module = Module::from_buffer(&bytes).unwrap();
    let imports: Vec<_> = module
        .imports
        .iter()
        .filter(|import| {
            import.module == names::IMPORT_UNWIND_TAG_MODULE
                && import.name == names::IMPORT_UNWIND_TAG
        })
        .collect();
    assert_eq!(imports.len(), 1, "private transport must have one owner");
    let tag = match imports[0].kind {
        ImportKind::Tag(tag) => tag,
        ref other => panic!("private unwind transport must be a tag, got {other:?}"),
    };
    let tag_ty = module.types.get(module.tags.get(tag).ty());
    assert!(
        tag_ty.params().is_empty(),
        "unwind tag payload must be empty"
    );
    assert!(tag_ty.results().is_empty(), "tag type cannot return values");

    let metadata: Vec<_> = Parser::new(0)
        .parse_all(&bytes)
        .filter_map(|payload| match payload.expect("parse payload") {
            Payload::CustomSection(section) if section.name() == UNWIND_TRANSPORT_SECTION => {
                Some(section.data().to_vec())
            }
            _ => None,
        })
        .collect();
    assert_eq!(
        metadata,
        vec![vec![UNWIND_TRANSPORT_VERSION, 0]],
        "host must be able to reject a lookalike tag with a different contract",
    );
}

#[test]
fn state_only_side_activation_carries_exact_private_unwind_metadata() {
    let bytes = instrument_wat(
        r#"(module
          (@custom "dylink.0" (before first) "state-only")
          (memory 1))"#,
    );
    let metadata: Vec<_> = Parser::new(0)
        .parse_all(&bytes)
        .filter_map(|payload| match payload.expect("parse payload") {
            Payload::CustomSection(section) if section.name() == UNWIND_TRANSPORT_SECTION => {
                Some(section.data().to_vec())
            }
            _ => None,
        })
        .collect();
    assert_eq!(
        metadata,
        vec![vec![UNWIND_TRANSPORT_VERSION, 0]],
        "uniform ABI 43 state helpers require the same exact-tag descriptor",
    );
}

#[test]
fn raw_module_cannot_preclaim_reserved_unwind_transport() {
    let bytes = wat::parse_str(
        r#"
        (module
          (import "kernel" "kernel_fork" (func $fork (result i32)))
          (import "env" "__wpk_fork_unwind" (tag $unwind))
          (memory 1)
          (func (export "run") (result i32)
            call $fork))
        "#,
    )
    .expect("wat parse");
    let message = instrument(&bytes, &Options::default())
        .expect_err("reserved private tag collision must fail before rewrite")
        .to_string();
    assert!(
        message.contains("reserved private fork runtime hook"),
        "{message}"
    );
    assert!(
        message.contains("instrumenter must own unwind transport"),
        "{message}"
    );
}

#[test]
fn plain_catches_do_not_expand_fixed_prefix_metadata() {
    let bytes = instrument_wat(
        r#"
        (module
          (import "kernel" "kernel_fork" (func $fork (result i32)))
          (tag $payload (param i32))
          (memory 1)
          (func (export "run") (param $value i32) (result i32)
            (block $handler (result i32)
              (try_table (catch $payload $handler)
                local.get $value
                throw $payload
                unreachable)
              unreachable)
            drop
            call $fork))
        "#,
    );
    let descriptors: Vec<_> = Parser::new(0)
        .parse_all(&bytes)
        .filter_map(|payload| match payload.expect("parse payload") {
            Payload::CustomSection(section) if section.name() == LINKED_FRAME_FORMAT_SECTION => {
                Some(FrameFormatDescriptor::decode(section.data()).unwrap())
            }
            _ => None,
        })
        .collect();
    assert_eq!(
        descriptors,
        vec![FrameFormatDescriptor::current(PointerWidth::Wasm32, 24)],
        "plain-catch activation state belongs in function frames, not the module prefix",
    );
}

#[test]
fn memory64_plain_catches_do_not_expand_fixed_prefix_metadata() {
    let bytes = instrument_wat(
        r#"
        (module
          (import "kernel" "kernel_fork" (func $fork (result i32)))
          (tag $payload (param i32))
          (memory i64 1)
          (func (export "run") (param $value i32) (result i32)
            (block $handler (result i32)
              (try_table (catch $payload $handler)
                local.get $value
                throw $payload
                unreachable)
              unreachable)
            drop
            call $fork))
        "#,
    );
    let descriptors: Vec<_> = Parser::new(0)
        .parse_all(&bytes)
        .filter_map(|payload| match payload.expect("parse payload") {
            Payload::CustomSection(section) if section.name() == LINKED_FRAME_FORMAT_SECTION => {
                Some(FrameFormatDescriptor::decode(section.data()).unwrap())
            }
            _ => None,
        })
        .collect();
    assert_eq!(
        descriptors,
        vec![FrameFormatDescriptor::current(PointerWidth::Wasm64, 32)],
        "memory64 plain-catch state belongs in function frames",
    );
}

#[test]
fn dylink_module_without_local_fork_seed_has_the_uniform_replay_contract() {
    let bytes = instrument_wat(
        r#"(module
          (@custom "dylink.0" (before first) "side")
          (memory 1)
          (func (export "run")))"#,
    );
    let module = Module::from_buffer(&bytes).unwrap();
    for requirement in WPK_FORK_REQUIRED_IMPORTS {
        assert!(
            module.imports.iter().any(|import| {
                import.module == requirement.module
                    && import.name == requirement.name
                    && matches!(import.kind, ImportKind::Function(_))
            }),
            "state-only side module is missing linked function import {}.{}",
            requirement.module,
            requirement.name,
        );
    }
    for requirement in WPK_FORK_REQUIRED_TABLE_IMPORTS {
        assert!(
            module.imports.iter().any(|import| {
                import.module == requirement.module
                    && import.name == requirement.name
                    && matches!(import.kind, ImportKind::Table(_))
            }),
            "state-only side module is missing linked table import {}.{}",
            requirement.module,
            requirement.name,
        );
    }
    for requirement in WPK_FORK_REQUIRED_EXPORTS {
        assert!(
            module
                .exports
                .iter()
                .any(|export| export.name == requirement.name),
            "state-only side module is missing linked export {}",
            requirement.name,
        );
    }
    for section_name in [
        WPK_FORK_CAPABILITIES_SECTION,
        LINKED_FRAME_FORMAT_SECTION,
        WPK_FORK_MODULE_STATE_FORMAT_SECTION,
        WPK_FORK_IMPORTED_GLOBALS_SECTION,
    ] {
        assert_eq!(
            module
                .customs
                .iter()
                .filter(|(_, section)| section.name() == section_name)
                .count(),
            1,
            "state-only side module must carry exactly one {section_name} descriptor",
        );
    }
}

#[test]
fn reference_vector_finish_import_returns_a_canonical_ordinal() {
    let bytes = instrument_wat(EMPTY_MODULE_WITH_FORK);
    let module = Module::from_buffer(&bytes).unwrap();
    let finish = module
        .imports
        .iter()
        .find_map(|import| {
            (import.module == wasm_posix_shared::abi::WPK_FORK_FRAME_IMPORT_MODULE
                && import.name == names::IMPORT_REFERENCE_VECTOR_FINISH)
                .then(|| match import.kind {
                    ImportKind::Function(function) => Some(function),
                    _ => None,
                })
                .flatten()
        })
        .expect("reference-vector finish import");
    assert_eq!(
        func_signature(&module, finish),
        (vec![ValType::I32], vec![ValType::I32]),
        "finish consumes a transient builder handle and returns its canonical wire ordinal",
    );
}

#[test]
fn marks_dlopen_main_indirect_boundary_separately() {
    let wat = r#"
        (module
          (import "kernel" "kernel_fork" (func $fork (result i32)))
          (import "env" "__wasm_dlsym" (func $dlsym (param i32 i32 i32) (result i32)))
          (type $callback (func (result i32)))
          (table 1 funcref)
          (memory 1)
          (func (export "dispatch") (result i32)
            i32.const 0
            call_indirect (type $callback)))
    "#;
    let output = instrument_wat(wat);
    assert_eq!(
        fork_capabilities(&output),
        vec![vec![
            WPK_FORK_CAPABILITIES_VERSION,
            WPK_FORK_CAP_DYLINK_MAIN | WPK_FORK_CAP_ACTIVATION_STATE_SAFE,
        ]],
    );
}

#[test]
fn marks_env_fork_side_entry_separately() {
    let input = wat::parse_str(
        r#"
        (module
          (import "env" "fork" (func $fork (result i32)))
          (memory 1)
          (func (export "side_fork") (result i32) call $fork))
        "#,
    )
    .expect("wat parse");
    let output = instrument(
        &input,
        &Options {
            entry_import: "env.fork".into(),
            ..Options::default()
        },
    )
    .expect("instrument side");
    assert_eq!(
        fork_capabilities(&output),
        vec![vec![
            WPK_FORK_CAPABILITIES_VERSION,
            WPK_FORK_CAP_SIDE_ENTRY | WPK_FORK_CAP_ACTIVATION_STATE_SAFE,
        ]],
    );
}

#[test]
fn dylink_module_without_env_fork_claims_complete_side_boundaries() {
    let input = wat::parse_str(
        r#"
        (module
          (@custom "dylink.0" (before first) "side")
          (import "env" "side_b" (func $side_b (result i32)))
          (memory 1)
          (func (export "side_a") (result i32) call $side_b))
        "#,
    )
    .expect("wat parse");
    let output = instrument(&input, &Options::default()).expect("instrument side boundaries");
    validate(&output);
    assert_eq!(
        fork_capabilities(&output),
        vec![vec![
            WPK_FORK_CAPABILITIES_VERSION,
            WPK_FORK_CAP_SIDE_ENTRY | WPK_FORK_CAP_ACTIVATION_STATE_SAFE,
        ]],
        "SIDE_ENTRY means every cross-module activation boundary is covered, \
         even when fork itself is downstream in another module",
    );
}

#[test]
fn generic_runtime_exports_do_not_claim_side_or_dylink_coverage() {
    let output = instrument_wat(EMPTY_MODULE_WITH_FORK);
    assert_eq!(
        fork_capabilities(&output),
        vec![vec![
            WPK_FORK_CAPABILITIES_VERSION,
            WPK_FORK_CAP_ACTIVATION_STATE_SAFE,
        ]],
    );
}

#[test]
fn injects_state_global_mutable_i32_init_zero() {
    let bytes = instrument_wat(EMPTY_MODULE_WITH_FORK);
    let module = Module::from_buffer(&bytes).unwrap();

    let state_global = module
        .globals
        .iter()
        .find(|g| g.name.as_deref() == Some(names::GLOBAL_STATE))
        .expect("_wpk_fork_state global missing");

    assert_eq!(state_global.ty, ValType::I32);
    assert!(state_global.mutable, "state global must be mutable");
}

#[test]
fn injects_buf_global_matches_memory_ptr_width_wasm32() {
    let bytes = instrument_wat(EMPTY_MODULE_WITH_FORK); // memory 1 => wasm32
    let module = Module::from_buffer(&bytes).unwrap();

    let buf_global = module
        .globals
        .iter()
        .find(|g| g.name.as_deref() == Some(names::GLOBAL_BUF))
        .expect("_wpk_fork_buf global missing");

    assert_eq!(buf_global.ty, ValType::I32, "wasm32 buf should be i32");
    assert!(buf_global.mutable);
}

#[test]
fn injects_buf_global_matches_memory_ptr_width_wasm64() {
    let wat = r#"
        (module
          (import "kernel" "kernel_fork" (func $fork (result i32)))
          (memory i64 1))
    "#;
    let bytes = instrument_wat(wat);
    let module = Module::from_buffer(&bytes).unwrap();

    let buf_global = module
        .globals
        .iter()
        .find(|g| g.name.as_deref() == Some(names::GLOBAL_BUF))
        .expect("_wpk_fork_buf global missing");

    assert_eq!(buf_global.ty, ValType::I64, "wasm64 buf should be i64");
}

#[test]
fn exports_unwind_begin_taking_ptr() {
    let bytes = instrument_wat(EMPTY_MODULE_WITH_FORK);
    let module = Module::from_buffer(&bytes).unwrap();
    let id = export_function_id(&module, names::EXPORT_UNWIND_BEGIN);
    let (params, results) = func_signature(&module, id);
    assert_eq!(params, vec![ValType::I32]);
    assert_eq!(results, Vec::<ValType>::new());
}

#[test]
fn exports_unwind_end_taking_no_args_returning_nothing() {
    let bytes = instrument_wat(EMPTY_MODULE_WITH_FORK);
    let module = Module::from_buffer(&bytes).unwrap();
    let id = export_function_id(&module, names::EXPORT_UNWIND_END);
    let (params, results) = func_signature(&module, id);
    assert_eq!(params, Vec::<ValType>::new());
    assert_eq!(results, Vec::<ValType>::new());
}

#[test]
fn exports_rewind_begin_taking_ptr() {
    let bytes = instrument_wat(EMPTY_MODULE_WITH_FORK);
    let module = Module::from_buffer(&bytes).unwrap();
    let id = export_function_id(&module, names::EXPORT_REWIND_BEGIN);
    let (params, results) = func_signature(&module, id);
    assert_eq!(params, vec![ValType::I32]);
    assert_eq!(results, Vec::<ValType>::new());
}

#[test]
fn exports_abort_begin_taking_ptr_and_abort_end_taking_no_args() {
    let bytes = instrument_wat(EMPTY_MODULE_WITH_FORK);
    let module = Module::from_buffer(&bytes).unwrap();
    let begin = export_function_id(&module, names::EXPORT_ABORT_BEGIN);
    let end = export_function_id(&module, names::EXPORT_ABORT_END);
    assert_eq!(func_signature(&module, begin), (vec![ValType::I32], vec![]));
    assert_eq!(func_signature(&module, end), (vec![], vec![]));
}

#[test]
fn exports_state_returning_i32() {
    let bytes = instrument_wat(EMPTY_MODULE_WITH_FORK);
    let module = Module::from_buffer(&bytes).unwrap();
    let id = export_function_id(&module, names::EXPORT_STATE);
    let (params, results) = func_signature(&module, id);
    assert_eq!(params, Vec::<ValType>::new());
    assert_eq!(results, vec![ValType::I32]);
}

#[test]
fn all_seven_control_exports_present() {
    let bytes = instrument_wat(EMPTY_MODULE_WITH_FORK);
    let module = Module::from_buffer(&bytes).unwrap();

    for name in [
        names::EXPORT_UNWIND_BEGIN,
        names::EXPORT_UNWIND_END,
        names::EXPORT_REWIND_BEGIN,
        names::EXPORT_REWIND_END,
        names::EXPORT_ABORT_BEGIN,
        names::EXPORT_ABORT_END,
        names::EXPORT_STATE,
    ] {
        assert!(
            module.exports.iter().any(|e| e.name == name),
            "export `{name}` missing"
        );
    }
}

// ======================================================================
// Phase 4e — saved-globals area in unwind_begin / rewind_begin
// ======================================================================

use fork_instrument::runtime::inject_runtime;
use walrus::ir::Instr;

/// Helper: count `Store` / `Load` instructions in the body of the
/// named export by re-parsing the instrumented module.
fn export_body_instr_counts(module: &Module, export: &str) -> (usize, usize) {
    let id = match module
        .exports
        .iter()
        .find(|e| e.name == export)
        .expect("export present")
        .item
    {
        walrus::ExportItem::Function(id) => id,
        _ => panic!("export `{export}` is not a function"),
    };
    let local = match &module.funcs.get(id).kind {
        walrus::FunctionKind::Local(l) => l,
        _ => panic!("`{export}` is not a local function"),
    };
    let mut stores = 0;
    let mut loads = 0;
    for (instr, _) in &local.block(local.entry_block()).instrs {
        match instr {
            Instr::Store(_) => stores += 1,
            Instr::Load(_) => loads += 1,
            _ => {}
        }
    }
    (stores, loads)
}

const MODULE_WITH_EXTRA_GLOBAL: &str = r#"
    (module
      (import "kernel" "kernel_fork" (func $fork (result i32)))
      (global $user_stack (mut i32) (i32.const 0))
      (global $user_tls (mut i32) (i32.const 0))
      (global $user_const i32 (i32.const 42))  ;; immutable — skipped
      (memory 1))
"#;

#[test]
fn unwind_begin_stores_one_per_saved_global() {
    let bytes = instrument_wat(MODULE_WITH_EXTRA_GLOBAL);
    let module = Module::from_buffer(&bytes).unwrap();

    // Two mutable scalar globals pre-exist (`$user_stack`, `$user_tls`).
    // The immutable `$user_const` is excluded. The runtime's own
    // state+buf globals are added *after* the scan so they are also
    // excluded. Plus Phase 7 Task 1 adds one store for `current_pos` at
    // buf+0. Expected: 1 (current_pos) + 2 (saved globals) = 3 stores.
    let (stores, loads) = export_body_instr_counts(&module, names::EXPORT_UNWIND_BEGIN);
    assert_eq!(
        stores, 3,
        "unwind_begin should store current_pos + one per saved global",
    );
    assert_eq!(loads, 0, "unwind_begin never reads the save buffer");
}

#[test]
fn rewind_begin_loads_one_per_saved_global() {
    let bytes = instrument_wat(MODULE_WITH_EXTRA_GLOBAL);
    let module = Module::from_buffer(&bytes).unwrap();

    let (stores, loads) = export_body_instr_counts(&module, names::EXPORT_REWIND_BEGIN);
    assert_eq!(loads, 2, "rewind_begin should load each saved global");
    assert_eq!(stores, 0, "rewind_begin never writes the save buffer");
}

#[test]
fn saved_globals_metadata_reports_declared_order() {
    // Directly invoke inject_runtime so we can inspect the resulting
    // metadata — the high-level `instrument` fn hides it.
    let bytes = wat::parse_str(MODULE_WITH_EXTRA_GLOBAL).unwrap();
    let mut module = Module::from_buffer(&bytes).unwrap();
    let runtime = inject_runtime(&mut module);

    // Exactly two saved globals, in declaration order: user_stack, then user_tls.
    assert_eq!(runtime.saved_globals.len(), 2);

    // Offsets: wasm32 → header 8 bytes, then 4 bytes each.
    assert_eq!(runtime.saved_globals[0].offset, 8);
    assert_eq!(runtime.saved_globals[1].offset, 12);
    // frames_start_offset = end of saved_globals area.
    assert_eq!(runtime.frames_start_offset, 16);
}

#[test]
fn module_with_no_extra_globals_has_empty_saved_globals() {
    let bytes = wat::parse_str(EMPTY_MODULE_WITH_FORK).unwrap();
    let mut module = Module::from_buffer(&bytes).unwrap();
    let runtime = inject_runtime(&mut module);

    assert!(
        runtime.saved_globals.is_empty(),
        "no pre-existing mutable globals → saved_globals empty",
    );
    // frames_start_offset should equal the header size alone.
    // For wasm32 that's 2 * 4 = 8 bytes.
    assert_eq!(runtime.frames_start_offset, 8);
}

#[test]
fn wasm64_saved_globals_use_16_byte_header() {
    let wat = r#"
        (module
          (import "kernel" "kernel_fork" (func $fork (result i32)))
          (global $g (mut i64) (i64.const 0))
          (memory i64 1))
    "#;
    let bytes = wat::parse_str(wat).unwrap();
    let mut module = Module::from_buffer(&bytes).unwrap();
    let runtime = inject_runtime(&mut module);

    // wasm64 → header 2 * 8 = 16 bytes.
    assert_eq!(runtime.saved_globals.len(), 1);
    assert_eq!(runtime.saved_globals[0].offset, 16);
    // The i64 global consumes 8 bytes.
    assert_eq!(runtime.frames_start_offset, 16 + 8);
}

#[test]
fn linked_runtime_prefix_defers_reference_globals_to_kfms() {
    // The fixed continuation prefix owns scalar control globals. KFMS owns
    // reference-global recipes because it can reconstruct them in a fresh
    // module instance without putting references in linear memory.
    let wat = r#"
        (module
          (import "kernel" "kernel_fork" (func $fork (result i32)))
          (global $scalar (mut i32) (i32.const 0))
          (global $refg   (mut funcref) (ref.null func))
          (memory 1))
    "#;
    let bytes = wat::parse_str(wat).unwrap();
    let mut module = Module::from_buffer(&bytes).unwrap();
    let runtime = inject_runtime(&mut module);

    // Only the scalar is part of the fixed runtime prefix.
    assert_eq!(runtime.saved_globals.len(), 1);
    assert_eq!(runtime.saved_globals[0].ty, walrus::ValType::I32);
}

// ======================================================================
// Phase 7 Task 1 — wpk_fork_unwind_begin self-initializes current_pos
// ======================================================================

/// Helper: return the entry-block instructions of the named export
/// as a cloned Vec<Instr>, so tests can pattern-match over them.
fn export_entry_instrs(module: &Module, export: &str) -> Vec<Instr> {
    let id = match module
        .exports
        .iter()
        .find(|e| e.name == export)
        .expect("export present")
        .item
    {
        walrus::ExportItem::Function(id) => id,
        _ => panic!("export `{export}` is not a function"),
    };
    let local = match &module.funcs.get(id).kind {
        walrus::FunctionKind::Local(l) => l,
        _ => panic!("`{export}` is not a local function"),
    };
    local
        .block(local.entry_block())
        .instrs
        .iter()
        .map(|(instr, _)| instr.clone())
        .collect()
}

#[test]
fn unwind_begin_writes_absolute_frames_start_wasm32() {
    // wpk_fork_unwind_begin must write `buf + frames_start_offset` to
    // `*(buf + 0)` as its first memory store.
    // For EMPTY_MODULE_WITH_FORK (no pre-existing mutable scalar
    // globals), frames_start_offset == 2 * sizeof(ptr) == 8 for wasm32.
    let bytes = instrument_wat(EMPTY_MODULE_WITH_FORK);
    let module = Module::from_buffer(&bytes).unwrap();

    let instrs = export_entry_instrs(&module, names::EXPORT_UNWIND_BEGIN);

    // Find the first Store instruction. Its value must be the buffer
    // parameter plus frames_start_offset (8).
    let store_idx = instrs
        .iter()
        .position(|i| matches!(i, Instr::Store(_)))
        .expect("unwind_begin must contain at least one store");

    let store = match &instrs[store_idx] {
        Instr::Store(s) => s,
        _ => unreachable!(),
    };

    assert!(
        matches!(store.kind, walrus::ir::StoreKind::I32 { atomic: false }),
        "wasm32 current_pos store must be i32 non-atomic, got {:?}",
        store.kind,
    );
    assert_eq!(store.arg.offset, 0, "store to buf + 0");
    assert_eq!(store.arg.align, 4, "natural alignment for i32 pointer");

    assert!(
        matches!(
            &instrs[store_idx - 1],
            Instr::Binop(walrus::ir::Binop {
                op: walrus::ir::BinaryOp::I32Add,
            })
        ),
        "wasm32 current_pos must add the buffer base",
    );
    let offset_instr = &instrs[store_idx - 2];
    match offset_instr {
        Instr::Const(c) => match c.value {
            walrus::ir::Value::I32(v) => {
                assert_eq!(v, 8, "wasm32 empty-globals frames_start_offset is 2*4 = 8",)
            }
            other => panic!("expected I32 const, got {other:?}"),
        },
        other => panic!("expected frame offset const before add, got {other:?}"),
    }
    let value_base = match &instrs[store_idx - 3] {
        Instr::LocalGet(get) => get.local,
        other => panic!("expected buffer base before frame offset, got {other:?}"),
    };
    let store_base = match &instrs[store_idx - 4] {
        Instr::LocalGet(get) => get.local,
        other => panic!("expected store address before value, got {other:?}"),
    };
    assert_eq!(
        store_base, value_base,
        "store and cursor use the same buffer base",
    );
}

#[test]
fn unwind_begin_writes_absolute_frames_start_wasm64() {
    // Same as above but for a memory64 module. Store kind must be I64,
    // align 8, value 16 (2 * 8 with no saved globals).
    let wat = r#"
        (module
          (import "kernel" "kernel_fork" (func $fork (result i32)))
          (memory i64 1))
    "#;
    let bytes = instrument_wat(wat);
    let module = Module::from_buffer(&bytes).unwrap();

    let instrs = export_entry_instrs(&module, names::EXPORT_UNWIND_BEGIN);

    let store_idx = instrs
        .iter()
        .position(|i| matches!(i, Instr::Store(_)))
        .expect("unwind_begin must contain at least one store");

    let store = match &instrs[store_idx] {
        Instr::Store(s) => s,
        _ => unreachable!(),
    };

    assert!(
        matches!(store.kind, walrus::ir::StoreKind::I64 { atomic: false }),
        "wasm64 current_pos store must be i64 non-atomic, got {:?}",
        store.kind,
    );
    assert_eq!(store.arg.offset, 0, "store to buf + 0");
    assert_eq!(store.arg.align, 8, "natural alignment for i64 pointer");

    assert!(
        matches!(
            &instrs[store_idx - 1],
            Instr::Binop(walrus::ir::Binop {
                op: walrus::ir::BinaryOp::I64Add,
            })
        ),
        "wasm64 current_pos must add the buffer base",
    );
    let offset_instr = &instrs[store_idx - 2];
    match offset_instr {
        Instr::Const(c) => match c.value {
            walrus::ir::Value::I64(v) => assert_eq!(
                v, 16,
                "wasm64 empty-globals frames_start_offset is 2*8 = 16",
            ),
            other => panic!("expected I64 const, got {other:?}"),
        },
        other => panic!("expected frame offset const before add, got {other:?}"),
    }
    let value_base = match &instrs[store_idx - 3] {
        Instr::LocalGet(get) => get.local,
        other => panic!("expected buffer base before frame offset, got {other:?}"),
    };
    let store_base = match &instrs[store_idx - 4] {
        Instr::LocalGet(get) => get.local,
        other => panic!("expected store address before value, got {other:?}"),
    };
    assert_eq!(
        store_base, value_base,
        "store and cursor use the same buffer base",
    );
}

// ======================================================================
// Runtime buffer ownership
// ======================================================================

fn assert_end_functions_clear_buffer_before_normal(wat_src: &str, ptr_ty: ValType) {
    let bytes = wat::parse_str(wat_src).unwrap();
    let mut module = Module::from_buffer(&bytes).unwrap();
    let runtime = inject_runtime(&mut module);

    for (name, id) in [
        (names::EXPORT_UNWIND_END, runtime.unwind_end),
        (names::EXPORT_REWIND_END, runtime.rewind_end),
        (names::EXPORT_ABORT_END, runtime.abort_end),
    ] {
        let local = match &module.funcs.get(id).kind {
            walrus::FunctionKind::Local(local) => local,
            _ => panic!("{name} is not local"),
        };
        let instrs: Vec<_> = local
            .block(local.entry_block())
            .instrs
            .iter()
            .map(|(instr, _)| instr)
            .collect();
        assert_eq!(instrs.len(), 4, "{name} must contain two exact stores");
        assert!(
            matches!(
                (ptr_ty, instrs[0]),
                (
                    ValType::I32,
                    Instr::Const(walrus::ir::Const {
                        value: walrus::ir::Value::I32(0),
                    })
                ) | (
                    ValType::I64,
                    Instr::Const(walrus::ir::Const {
                        value: walrus::ir::Value::I64(0),
                    })
                )
            ),
            "{name} must first materialize the pointer-width zero",
        );
        assert!(
            matches!(instrs[1], Instr::GlobalSet(set) if set.global == runtime.buf_global),
            "{name} must clear _wpk_fork_buf before publishing NORMAL",
        );
        assert!(
            matches!(
                instrs[2],
                Instr::Const(walrus::ir::Const {
                    value: walrus::ir::Value::I32(0),
                })
            ),
            "{name} must materialize STATE_NORMAL",
        );
        assert!(
            matches!(instrs[3], Instr::GlobalSet(set) if set.global == runtime.state_global),
            "{name} must publish STATE_NORMAL last",
        );
    }
}

#[test]
fn wasm32_end_functions_release_buffer_before_normal() {
    assert_end_functions_clear_buffer_before_normal("(module (memory 1))", ValType::I32);
}

#[test]
fn wasm64_end_functions_release_buffer_before_normal() {
    assert_end_functions_clear_buffer_before_normal("(module (memory i64 1))", ValType::I64);
}
