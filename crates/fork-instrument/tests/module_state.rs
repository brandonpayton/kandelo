//! Guest-owned module-state reconstruction for fresh fork children.

use fork_instrument::runtime::names;
use fork_instrument::{FUNCTION_CATALOG_EXPORT, Options, instrument};
use std::{
    fs,
    process::Command,
    time::{SystemTime, UNIX_EPOCH},
};
use walrus::{
    ExportItem, FunctionId, FunctionKind, ImportKind, LocalFunction, Module, ValType,
    ir::{self, Instr, InstrSeqId},
};
use wasm_posix_shared::abi::{
    WPK_FORK_EXPORT_MODULE_BOOTSTRAP, WPK_FORK_EXPORT_MODULE_STATE_FINISH_RESTORE,
    WPK_FORK_EXPORT_MODULE_STATE_RESTORE, WPK_FORK_EXPORT_MODULE_STATE_SAVE,
    WPK_FORK_EXPORT_MODULE_TABLE_STATE_SAVE,
    WPK_FORK_EXPORT_MODULE_THREAD_BOOTSTRAP, WPK_FORK_GLOBAL_CATALOG_EXPORT_PREFIX,
    WPK_FORK_IMPORTED_GLOBALS_HEADER_SIZE, WPK_FORK_IMPORTED_GLOBALS_MAGIC,
    WPK_FORK_IMPORTED_GLOBALS_RECORD_HEADER_SIZE, WPK_FORK_IMPORTED_GLOBALS_SECTION,
    WPK_FORK_IMPORTED_TABLES_HEADER_SIZE, WPK_FORK_IMPORTED_TABLES_MAGIC,
    WPK_FORK_IMPORTED_TABLES_RECORD_HEADER_SIZE, WPK_FORK_IMPORTED_TABLES_SECTION,
    WPK_FORK_MODULE_STATE_IMPORT_RECORD_COMMIT, WPK_FORK_MODULE_STATE_IMPORT_RECORD_FIND,
    WPK_FORK_MODULE_STATE_IMPORT_RECORD_RESERVE, WPK_FORK_MODULE_STATE_IMPORT_TABLE_DIRTY_COUNT,
    WPK_FORK_MODULE_STATE_IMPORT_TABLE_DIRTY_MARK, WPK_FORK_MODULE_STATE_IMPORT_TABLE_DIRTY_PAGE,
    WPK_FORK_MODULE_STATE_IMPORT_TABLE_MUTATION_ABORT,
    WPK_FORK_MODULE_STATE_IMPORT_TABLE_MUTATION_BEGIN,
    WPK_FORK_MODULE_STATE_IMPORT_TABLE_MUTATION_COMMIT,
    WPK_FORK_MODULE_STATE_IMPORT_TABLE_RECONCILE,
    WPK_FORK_MODULE_STATE_IMPORT_TABLE_STATE_OWNED, WPK_FORK_TABLE_CATALOG_EXPORT_PREFIX,
};

fn instrument_wat(wat: &str) -> Vec<u8> {
    let input = wat::parse_str(wat).expect("parse WAT fixture");
    instrument(&input, &Options::default()).expect("instrument fixture")
}

fn validate(bytes: &[u8]) {
    wasmparser::Validator::new_with_features(wasmparser::WasmFeatures::default())
        .validate_all(bytes)
        .expect("instrumented module validates");
}

fn export_function(module: &Module, name: &str) -> FunctionId {
    match module
        .exports
        .iter()
        .find(|export| export.name == name)
        .unwrap_or_else(|| panic!("missing export {name}"))
        .item
    {
        ExportItem::Function(function) => function,
        other => panic!("{name} is not a function: {other:?}"),
    }
}

fn imported_function(module: &Module, name: &str) -> FunctionId {
    module
        .imports
        .iter()
        .find_map(|import| {
            if import.module != "env" || import.name != name {
                return None;
            }
            match &import.kind {
                ImportKind::Function(function) => Some(*function),
                _ => None,
            }
        })
        .unwrap_or_else(|| panic!("missing import env.{name}"))
}

fn signature(module: &Module, function: FunctionId) -> (Vec<ValType>, Vec<ValType>) {
    let ty = module.types.get(module.funcs.get(function).ty());
    (ty.params().to_vec(), ty.results().to_vec())
}

fn local(module: &Module, function: FunctionId) -> &LocalFunction {
    match &module.funcs.get(function).kind {
        FunctionKind::Local(local) => local,
        other => panic!("expected local function, got {other:?}"),
    }
}

fn children(instr: &Instr) -> Vec<InstrSeqId> {
    match instr {
        Instr::Block(ir::Block { seq }) | Instr::Loop(ir::Loop { seq }) => vec![*seq],
        Instr::IfElse(ir::IfElse {
            consequent,
            alternative,
        }) => vec![*consequent, *alternative],
        Instr::TryTable(ir::TryTable { seq, .. }) => vec![*seq],
        Instr::Try(try_) => {
            let mut result = vec![try_.seq];
            for catch in &try_.catches {
                match catch {
                    ir::LegacyCatch::Catch { handler, .. }
                    | ir::LegacyCatch::CatchAll { handler } => result.push(*handler),
                    ir::LegacyCatch::Delegate { .. } => {}
                }
            }
            result
        }
        _ => Vec::new(),
    }
}

fn walk(local: &LocalFunction, seq: InstrSeqId, visit: &mut impl FnMut(&Instr)) {
    for (instr, _) in &local.block(seq).instrs {
        visit(instr);
        for child in children(instr) {
            walk(local, child, visit);
        }
    }
}

fn assert_helper_signature(module: &Module, name: &str) {
    assert_eq!(
        signature(module, export_function(module, name)),
        (vec![ValType::I32], vec![]),
        "{name} must use the ABI activation-id signature",
    );
}

fn custom_section<'a>(bytes: &'a [u8], name: &str) -> &'a [u8] {
    wasmparser::Parser::new(0)
        .parse_all(bytes)
        .find_map(|payload| match payload.expect("parse custom section") {
            wasmparser::Payload::CustomSection(section) if section.name() == name => {
                Some(section.data())
            }
            _ => None,
        })
        .unwrap_or_else(|| panic!("missing custom section {name}"))
}

fn emitted_local_count(bytes: &[u8], export_name: &str) -> u32 {
    let mut imported_functions = 0u32;
    let mut exported_function = None;
    let mut defined_function = 0u32;
    for payload in wasmparser::Parser::new(0).parse_all(bytes) {
        match payload.expect("parse emitted module") {
            wasmparser::Payload::ImportSection(imports) => {
                for import in imports.into_imports() {
                    if matches!(
                        import.expect("parse emitted import").ty,
                        wasmparser::TypeRef::Func(_) | wasmparser::TypeRef::FuncExact(_)
                    ) {
                        imported_functions += 1;
                    }
                }
            }
            wasmparser::Payload::ExportSection(exports) => {
                for export in exports {
                    let export = export.expect("parse emitted export");
                    if export.name == export_name
                        && matches!(
                            export.kind,
                            wasmparser::ExternalKind::Func
                                | wasmparser::ExternalKind::FuncExact
                        )
                    {
                        exported_function = Some(export.index);
                    }
                }
            }
            wasmparser::Payload::CodeSectionEntry(body) => {
                let function_index = imported_functions + defined_function;
                defined_function += 1;
                if Some(function_index) != exported_function {
                    continue;
                }
                return body
                    .get_locals_reader()
                    .expect("read emitted locals")
                    .into_iter()
                    .map(|local| local.expect("parse emitted local").0)
                    .sum();
            }
            _ => {}
        }
    }
    panic!("missing emitted function export {export_name}");
}

fn codec_function(module: &Module, name: &str) -> FunctionId {
    module
        .exports
        .iter()
        .find_map(|export| {
            (export.name == name)
                .then_some(export.item)
                .and_then(|item| match item {
                    ExportItem::Function(function) => Some(function),
                    _ => None,
                })
        })
        .or_else(|| {
            module.imports.iter().find_map(|import| {
                (import.name == name)
                    .then_some(&import.kind)
                    .and_then(|kind| match kind {
                        ImportKind::Function(function) => Some(*function),
                        _ => None,
                    })
            })
        })
        .or_else(|| {
            module
                .funcs
                .iter()
                .find(|function| function.name.as_deref() == Some(name))
                .map(|function| function.id())
        })
        .unwrap_or_else(|| panic!("missing codec function {name}"))
}

#[test]
fn table_synchronization_helpers_do_not_add_source_function_locals() {
    let bytes = instrument_wat(
        r#"
        (module
          (type $unary (func (param i32) (result i32)))
          (memory 1)
          (table $callbacks 8 32 funcref)
          (func $identity (type $unary) (param i32) (result i32)
            local.get 0)
          (elem $passive func $identity)
          (func (export "table_get") (param i32) (result funcref)
            local.get 0 table.get $callbacks)
          (func (export "table_set") (param i32 funcref)
            local.get 0 local.get 1 table.set $callbacks)
          (func (export "table_fill") (param i32 funcref i32)
            local.get 0 local.get 1 local.get 2 table.fill $callbacks)
          (func (export "table_copy") (param i32 i32 i32)
            local.get 0 local.get 1 local.get 2
            table.copy $callbacks $callbacks)
          (func (export "table_init") (param i32 i32 i32)
            local.get 0 local.get 1 local.get 2
            table.init $callbacks $passive)
          (func (export "table_grow") (param funcref i32) (result i32)
            local.get 0 local.get 1 table.grow $callbacks)
          (func (export "table_size") (result i32)
            table.size $callbacks)
          (func (export "call_indirect") (param i32 i32) (result i32)
            local.get 0 local.get 1
            call_indirect $callbacks (type $unary))
          (func (export "return_call_indirect") (param i32 i32) (result i32)
            local.get 0 local.get 1
            return_call_indirect $callbacks (type $unary)))
        "#,
    );
    validate(&bytes);
    for name in [
        "table_get",
        "table_set",
        "table_fill",
        "table_copy",
        "table_init",
        "table_grow",
        "table_size",
        "call_indirect",
        "return_call_indirect",
    ] {
        assert_eq!(
            emitted_local_count(&bytes, name),
            0,
            "{name} gained an emitted source local; synchronization operands \
             must live only in generated non-suspendable helpers",
        );
    }
}

#[test]
fn deterministic_static_tables_do_not_pay_the_process_generation_fence() {
    let static_bytes = instrument_wat(
        r#"
        (module
          (@custom "dylink.0" (before first) "state-only")
          (memory 1)
          (table $callbacks (export "__indirect_function_table") 1 funcref)
          (func $callback)
          (elem (i32.const 0) $callback)
          (func (export "read") (param i32) (result funcref)
            local.get 0
            table.get $callbacks))
        "#,
    );
    validate(&static_bytes);
    let static_module =
        Module::from_buffer(&static_bytes).expect("parse static-table module");
    let read = local(&static_module, export_function(&static_module, "read"));
    let mut direct_get = false;
    let mut calls_generation_helper = false;
    walk(read, read.entry_block(), &mut |instr| match instr {
        Instr::TableGet(_) => direct_get = true,
        Instr::Call(call) => {
            calls_generation_helper |= static_module
                .funcs
                .get(call.func)
                .name
                .as_deref()
                .is_some_and(|name| name.starts_with("__wpk_fork_table_get_"));
        }
        _ => {}
    });
    assert!(
        direct_get && !calls_generation_helper,
        "a deterministic local table read must remain a direct Wasm operation",
    );
    let table_save = local(
        &static_module,
        export_function(
            &static_module,
            WPK_FORK_EXPORT_MODULE_TABLE_STATE_SAVE,
        ),
    );
    let mut snapshots_static_table = false;
    walk(table_save, table_save.entry_block(), &mut |instr| {
        snapshots_static_table |= matches!(instr, Instr::TableSize(_) | Instr::TableGet(_));
    });
    assert!(
        !snapshots_static_table,
        "static element initialization is the reconstruction owner; a peer snapshot is redundant",
    );

    let process_bytes = instrument_wat(
        r#"
        (module
          (import "env" "__wasm_dlopen"
            (func (param i32 i32 i32 i32) (result i32)))
          (memory 1)
          (table $callbacks (export "__indirect_function_table") 1 funcref)
          (func (export "read") (param i32) (result funcref)
            local.get 0
            table.get $callbacks))
        "#,
    );
    validate(&process_bytes);
    let process_module =
        Module::from_buffer(&process_bytes).expect("parse process-table module");
    let read = local(&process_module, export_function(&process_module, "read"));
    direct_get = false;
    calls_generation_helper = false;
    walk(read, read.entry_block(), &mut |instr| match instr {
        Instr::TableGet(_) => direct_get = true,
        Instr::Call(call) => {
            calls_generation_helper |= process_module
                .funcs
                .get(call.func)
                .name
                .as_deref()
                .is_some_and(|name| name.starts_with("__wpk_fork_table_get_"));
        }
        _ => {}
    });
    assert!(
        !direct_get && calls_generation_helper,
        "the dynamic linker's process table must reconcile before it is consumed",
    );
}

#[test]
fn module_state_imports_and_exports_use_exact_wasm32_signatures() {
    let bytes = instrument_wat(
        r#"
        (module
          (import "kernel" "kernel_fork" (func $fork (result i32)))
          (memory 1)
          (global $root (mut funcref) (ref.null func))
          (table $callbacks 2 8 funcref)
          (func $caller (result i32) call $fork))
        "#,
    );
    validate(&bytes);
    let module = Module::from_buffer(&bytes).expect("parse instrumented module");

    assert_helper_signature(&module, WPK_FORK_EXPORT_MODULE_STATE_SAVE);
    assert_helper_signature(&module, WPK_FORK_EXPORT_MODULE_STATE_RESTORE);
    assert_helper_signature(&module, WPK_FORK_EXPORT_MODULE_STATE_FINISH_RESTORE);
    assert_eq!(
        signature(
            &module,
            export_function(&module, WPK_FORK_EXPORT_MODULE_BOOTSTRAP)
        ),
        (vec![], vec![]),
    );
    assert_eq!(
        signature(
            &module,
            export_function(&module, WPK_FORK_EXPORT_MODULE_THREAD_BOOTSTRAP),
        ),
        (vec![], vec![]),
    );
    assert_eq!(
        signature(
            &module,
            imported_function(&module, WPK_FORK_MODULE_STATE_IMPORT_RECORD_RESERVE),
        ),
        (
            vec![ValType::I32, ValType::I32, ValType::I32, ValType::I32],
            vec![ValType::I32],
        ),
    );
    assert_eq!(
        signature(
            &module,
            imported_function(&module, WPK_FORK_MODULE_STATE_IMPORT_TABLE_DIRTY_MARK),
        ),
        (vec![ValType::I32, ValType::I64, ValType::I64], vec![]),
    );
    assert_eq!(
        signature(
            &module,
            imported_function(&module, WPK_FORK_MODULE_STATE_IMPORT_TABLE_DIRTY_COUNT),
        ),
        (vec![ValType::I32], vec![ValType::I32]),
    );
    assert_eq!(
        signature(
            &module,
            imported_function(&module, WPK_FORK_MODULE_STATE_IMPORT_TABLE_DIRTY_PAGE),
        ),
        (vec![ValType::I32, ValType::I32], vec![ValType::I64]),
    );
    assert_eq!(
        signature(
            &module,
            imported_function(&module, WPK_FORK_MODULE_STATE_IMPORT_RECORD_COMMIT),
        ),
        (vec![ValType::I32], vec![]),
    );
    assert_eq!(
        signature(
            &module,
            imported_function(&module, WPK_FORK_MODULE_STATE_IMPORT_RECORD_FIND),
        ),
        (
            vec![ValType::I32, ValType::I32, ValType::I32, ValType::I32],
            vec![ValType::I32],
        ),
    );
    assert_eq!(
        signature(
            &module,
            imported_function(
                &module,
                WPK_FORK_MODULE_STATE_IMPORT_TABLE_MUTATION_BEGIN,
            ),
        ),
        (vec![], vec![ValType::I64]),
    );
    assert_eq!(
        signature(
            &module,
            imported_function(
                &module,
                WPK_FORK_MODULE_STATE_IMPORT_TABLE_MUTATION_COMMIT,
            ),
        ),
        (
            vec![ValType::I32, ValType::I64, ValType::I64],
            vec![],
        ),
    );
    assert_eq!(
        signature(
            &module,
            imported_function(
                &module,
                WPK_FORK_MODULE_STATE_IMPORT_TABLE_MUTATION_ABORT,
            ),
        ),
        (vec![], vec![]),
    );
    assert_eq!(
        signature(
            &module,
            imported_function(&module, WPK_FORK_MODULE_STATE_IMPORT_TABLE_RECONCILE),
        ),
        (vec![], vec![ValType::I64]),
    );
}

#[test]
fn module_state_record_pointers_follow_memory64() {
    let bytes = instrument_wat(
        r#"
        (module
          (import "kernel" "kernel_fork" (func $fork (result i32)))
          (memory i64 1)
          (global $root (mut externref) (ref.null extern))
          (func $caller (result i32) call $fork))
        "#,
    );
    validate(&bytes);
    let module = Module::from_buffer(&bytes).expect("parse instrumented memory64 module");
    assert_eq!(
        signature(
            &module,
            imported_function(&module, WPK_FORK_MODULE_STATE_IMPORT_RECORD_RESERVE),
        ),
        (
            vec![ValType::I32, ValType::I32, ValType::I32, ValType::I64],
            vec![ValType::I64],
        ),
    );
    assert_eq!(
        signature(
            &module,
            imported_function(&module, WPK_FORK_MODULE_STATE_IMPORT_RECORD_COMMIT),
        ),
        (vec![ValType::I64], vec![]),
    );
    assert_eq!(
        signature(
            &module,
            imported_function(&module, WPK_FORK_MODULE_STATE_IMPORT_RECORD_FIND),
        ),
        (
            vec![ValType::I32, ValType::I32, ValType::I32, ValType::I32],
            vec![ValType::I64],
        ),
    );
}

#[test]
fn save_and_restore_own_reference_globals_and_dirty_table_state() {
    let bytes = instrument_wat(
        r#"
        (module
          (import "kernel" "kernel_fork" (func $fork (result i32)))
          (import "env" "shared_root" (global $shared_root (mut externref)))
          (memory 1)
          (global $callback (mut funcref) (ref.null func))
          (global $exception (mut exnref) (ref.null exn))
          (global $object (mut anyref) (ref.null any))
          (table $callbacks 2 8 funcref)
          (table $exceptions 1 8 exnref)
          (table $objects 1 8 anyref)
          (func $mutate_tables
            (param $callback funcref)
            (param $exception exnref)
            (param $object anyref)
            i32.const 0
            local.get $callback
            table.set $callbacks
            i32.const 0
            local.get $exception
            table.set $exceptions
            i32.const 0
            local.get $object
            table.set $objects)
          (func $caller (result i32) call $fork))
        "#,
    );
    validate(&bytes);
    let module = Module::from_buffer(&bytes).expect("parse instrumented module");
    let save = local(
        &module,
        export_function(&module, WPK_FORK_EXPORT_MODULE_STATE_SAVE),
    );
    let restore = local(
        &module,
        export_function(&module, WPK_FORK_EXPORT_MODULE_STATE_RESTORE),
    );
    let finish_restore = local(
        &module,
        export_function(&module, WPK_FORK_EXPORT_MODULE_STATE_FINISH_RESTORE),
    );
    let encode_funcref = codec_function(&module, names::IMPORT_REF_ENCODE_FUNCREF);
    let encode_externref = codec_function(&module, names::IMPORT_REF_ENCODE_EXTERNREF);
    let encode_exnref = codec_function(&module, names::IMPORT_REF_ENCODE_EXNREF);
    let encode_anyref = codec_function(&module, names::IMPORT_REF_ENCODE_ANYREF);
    let decode_funcref = codec_function(&module, names::IMPORT_REF_DECODE_FUNCREF);
    let decode_externref = codec_function(&module, names::IMPORT_REF_DECODE_EXTERNREF);
    let decode_exnref = codec_function(&module, names::IMPORT_REF_DECODE_EXNREF);
    let decode_anyref = codec_function(&module, names::IMPORT_REF_DECODE_ANYREF);

    let mut save_has_table_size = false;
    let mut save_has_table_get = false;
    let mut save_codecs = Vec::new();
    walk(save, save.entry_block(), &mut |instr| match instr {
        Instr::TableSize(_) => save_has_table_size = true,
        Instr::TableGet(_) => save_has_table_get = true,
        Instr::Call(call) => save_codecs.push(call.func),
        _ => {}
    });
    assert!(save_has_table_size && save_has_table_get);
    assert!(save_codecs.contains(&encode_funcref));
    assert!(save_codecs.contains(&encode_externref));
    assert!(save_codecs.contains(&encode_exnref));
    assert!(save_codecs.contains(&encode_anyref));

    let mut restore_has_global_set = false;
    let mut restore_has_table_grow = false;
    let mut restore_has_table_set = false;
    let mut restore_codecs = Vec::new();
    walk(
        finish_restore,
        finish_restore.entry_block(),
        &mut |instr| match instr {
            Instr::GlobalSet(_) => restore_has_global_set = true,
            Instr::TableGrow(_) => restore_has_table_grow = true,
            Instr::TableSet(_) => restore_has_table_set = true,
            Instr::Call(call) => restore_codecs.push(call.func),
            _ => {}
        },
    );
    walk(restore, restore.entry_block(), &mut |instr| match instr {
        Instr::GlobalSet(_) => restore_has_global_set = true,
        Instr::Call(call) => restore_codecs.push(call.func),
        _ => {}
    });
    assert!(restore_has_global_set);
    assert!(restore_has_table_grow && restore_has_table_set);
    assert!(restore_codecs.contains(&decode_funcref));
    assert!(restore_codecs.contains(&decode_externref));
    assert!(restore_codecs.contains(&decode_exnref));
    assert!(restore_codecs.contains(&decode_anyref));
}

#[test]
fn save_and_restore_own_every_scalar_global_type() {
    let bytes = instrument_wat(
        r#"
        (module
          (import "kernel" "kernel_fork" (func $fork (result i32)))
          (memory 1)
          (global $i32 (mut i32) (i32.const 1))
          (global $i64 (mut i64) (i64.const 2))
          (global $f32 (mut f32) (f32.const 3))
          (global $f64 (mut f64) (f64.const 4))
          (global $v128 (mut v128) (v128.const i32x4 5 6 7 8))
          (func $caller (result i32) call $fork))
        "#,
    );
    validate(&bytes);
    let module = Module::from_buffer(&bytes).expect("parse instrumented module");
    let save = local(
        &module,
        export_function(&module, WPK_FORK_EXPORT_MODULE_STATE_SAVE),
    );
    let restore = local(
        &module,
        export_function(&module, WPK_FORK_EXPORT_MODULE_STATE_RESTORE),
    );

    let mut stores = [false; 5];
    walk(save, save.entry_block(), &mut |instr| {
        let Instr::Store(store) = instr else { return };
        match store.kind {
            ir::StoreKind::I32 { .. } => stores[0] = true,
            ir::StoreKind::I64 { .. } => stores[1] = true,
            ir::StoreKind::F32 => stores[2] = true,
            ir::StoreKind::F64 => stores[3] = true,
            ir::StoreKind::V128 => stores[4] = true,
            _ => {}
        }
    });
    assert!(stores.into_iter().all(|seen| seen));

    let mut loads = [false; 5];
    walk(restore, restore.entry_block(), &mut |instr| {
        let Instr::Load(load) = instr else { return };
        match load.kind {
            ir::LoadKind::I32 { .. } => loads[0] = true,
            ir::LoadKind::I64 { .. } => loads[1] = true,
            ir::LoadKind::F32 => loads[2] = true,
            ir::LoadKind::F64 => loads[3] = true,
            ir::LoadKind::V128 => loads[4] = true,
            _ => {}
        }
    });
    assert!(loads.into_iter().all(|seen| seen));
}

#[test]
fn immutable_imports_keep_their_original_binding_and_preinstantiation_recipe() {
    let bytes = instrument_wat(
        r#"
        (module
          (import "kernel" "kernel_fork" (func $fork (result i32)))
          (import "env" "immutable_callback" (global $callback funcref))
          (memory 1)
          (export "immutable_callback_global" (global $callback))
          (global $callback_alias funcref (global.get $callback))
          (export "immutable_callback_alias" (global $callback_alias))
          (func $read (export "read") (result funcref)
            global.get $callback)
          (func $caller (result i32) call $fork))
        "#,
    );
    validate(&bytes);
    let module = Module::from_buffer(&bytes).expect("parse instrumented module");
    let imported = module
        .imports
        .iter()
        .find_map(|import| {
            if import.module != "env" || import.name != "immutable_callback" {
                return None;
            }
            match import.kind {
                ImportKind::Global(global) => Some(global),
                _ => None,
            }
        })
        .expect("immutable imported global");
    let read = local(&module, export_function(&module, "read"));
    let mut observed = Vec::new();
    walk(read, read.entry_block(), &mut |instr| {
        if let Instr::GlobalGet(get) = instr {
            observed.push(get.global);
        }
    });
    assert_eq!(observed.len(), 1);
    assert_eq!(observed[0], imported);
    assert!(matches!(
        module
            .exports
            .iter()
            .find(|export| export.name == "immutable_callback_global")
            .map(|export| export.item),
        Some(ExportItem::Global(global)) if global == imported
    ));
    let alias = module
        .exports
        .iter()
        .find_map(|export| (export.name == "immutable_callback_alias").then_some(export.item))
        .expect("immutable alias export");
    let ExportItem::Global(alias) = alias else {
        panic!("immutable alias export is not a global")
    };
    assert!(matches!(
        module.globals.get(alias).kind,
        walrus::GlobalKind::Local(walrus::ConstExpr::Global(source)) if source == imported
    ));
    let catalog_globals: Vec<_> = module
        .exports
        .iter()
        .filter_map(|export| {
            if !export
                .name
                .starts_with(WPK_FORK_GLOBAL_CATALOG_EXPORT_PREFIX)
            {
                return None;
            }
            match export.item {
                ExportItem::Global(global) => Some(global),
                _ => panic!("private global catalog entry is not a global"),
            }
        })
        .collect();
    assert_eq!(catalog_globals.len(), 2);
    assert!(
        catalog_globals.contains(&imported),
        "the imported provider cell needs an exact private Global wrapper"
    );
    assert!(
        catalog_globals.contains(&alias),
        "local provider cells need the same deterministic catalog"
    );

    let save = local(
        &module,
        export_function(&module, WPK_FORK_EXPORT_MODULE_STATE_SAVE),
    );
    let encode_funcref = imported_function(&module, names::IMPORT_REF_ENCODE_FUNCREF);
    let mut saves_import = false;
    walk(save, save.entry_block(), &mut |instr| {
        if matches!(instr, Instr::Call(call) if call.func == encode_funcref) {
            saves_import = true;
        }
    });
    assert!(saves_import);

    let restore = local(
        &module,
        export_function(&module, WPK_FORK_EXPORT_MODULE_STATE_RESTORE),
    );
    let mut assigns_import = false;
    walk(restore, restore.entry_block(), &mut |instr| {
        if matches!(instr, Instr::GlobalSet(set) if set.global == imported) {
            assigns_import = true;
        }
    });
    assert!(!assigns_import);

    let descriptor = custom_section(&bytes, WPK_FORK_IMPORTED_GLOBALS_SECTION);
    assert!(descriptor.len() >= usize::from(WPK_FORK_IMPORTED_GLOBALS_HEADER_SIZE));
    assert_eq!(&descriptor[..4], &WPK_FORK_IMPORTED_GLOBALS_MAGIC);
    let record = usize::from(WPK_FORK_IMPORTED_GLOBALS_HEADER_SIZE);
    assert_eq!(u32::from_le_bytes(descriptor[8..12].try_into().unwrap()), 1);
    assert_eq!(
        u32::from_le_bytes(descriptor[record..record + 4].try_into().unwrap()) as usize,
        usize::from(WPK_FORK_IMPORTED_GLOBALS_RECORD_HEADER_SIZE)
            + "env".len()
            + "immutable_callback".len(),
    );
    assert_eq!(
        u32::from_le_bytes(descriptor[record + 20..record + 24].try_into().unwrap()),
        1,
        "KFIG must name the full import-section ordinal, including the preceding function",
    );
}

#[test]
fn imported_global_recipe_preserves_full_wasm_name_lengths() {
    let field = "x".repeat(70_000);
    let bytes = instrument_wat(&format!(
        r#"
        (module
          (@custom "dylink.0" (before first) "state-only")
          (import "env" "{field}" (global $value i32))
          (memory 1)
          (func (export "read") (result i32) global.get $value))
        "#,
    ));
    validate(&bytes);
    let descriptor = custom_section(&bytes, WPK_FORK_IMPORTED_GLOBALS_SECTION);
    let record = usize::from(WPK_FORK_IMPORTED_GLOBALS_HEADER_SIZE);
    assert_eq!(
        u32::from_le_bytes(descriptor[record + 12..record + 16].try_into().unwrap()),
        3,
    );
    assert_eq!(
        u32::from_le_bytes(descriptor[record + 16..record + 20].try_into().unwrap()),
        70_000,
    );
}

#[test]
fn imported_table_identity_has_exact_preinstantiation_recipe_and_catalog() {
    let bytes = instrument_wat(
        r#"
        (module
          (import "kernel" "kernel_fork" (func $fork (result i32)))
          (import "env" "callbacks" (table $callbacks 2 8 funcref))
          (memory 1)
          (func $caller (result i32) call $fork))
        "#,
    );
    validate(&bytes);
    let module = Module::from_buffer(&bytes).expect("parse instrumented module");
    let imported = module
        .imports
        .iter()
        .find_map(|import| {
            if import.module != "env" || import.name != "callbacks" {
                return None;
            }
            match import.kind {
                ImportKind::Table(table) => Some(table),
                _ => None,
            }
        })
        .expect("imported table");
    assert!(module.exports.iter().any(|export| {
        export.name == format!("{WPK_FORK_TABLE_CATALOG_EXPORT_PREFIX}1")
            && matches!(export.item, ExportItem::Table(table) if table == imported)
    }));

    let descriptor = custom_section(&bytes, WPK_FORK_IMPORTED_TABLES_SECTION);
    assert_eq!(&descriptor[..4], &WPK_FORK_IMPORTED_TABLES_MAGIC);
    assert_eq!(u32::from_le_bytes(descriptor[8..12].try_into().unwrap()), 1);
    let record = usize::from(WPK_FORK_IMPORTED_TABLES_HEADER_SIZE);
    assert_eq!(
        u32::from_le_bytes(descriptor[record..record + 4].try_into().unwrap()) as usize,
        usize::from(WPK_FORK_IMPORTED_TABLES_RECORD_HEADER_SIZE) + "env".len() + "callbacks".len(),
    );
    assert_eq!(
        u32::from_le_bytes(descriptor[record + 20..record + 24].try_into().unwrap()),
        1,
        "KFIT must name the full import-section ordinal",
    );
}

#[test]
fn active_segment_offsets_preserve_extended_const_semantics_without_a_shape_gate() {
    let bytes = instrument_wat(
        r#"
        (module
          (@custom "dylink.0" (before first) "state-only")
          (import "env" "base" (global $base i32))
          (memory 1)
          (table 8 funcref)
          (func $target)
          (elem (i32.add (global.get $base) (i32.const 1)) $target)
          (data (i32.mul (global.get $base) (i32.const 2)) "x"))
        "#,
    );
    validate(&bytes);
    let module = Module::from_buffer(&bytes).expect("parse extended-const module");
    let preserved_offsets = module
        .globals
        .iter()
        .filter(|global| {
            matches!(
                global.kind,
                walrus::GlobalKind::Local(walrus::ConstExpr::Extended(_))
            )
        })
        .count();
    assert_eq!(
        preserved_offsets, 2,
        "each converted active segment must retain its original const expression",
    );

    for helper in [
        WPK_FORK_EXPORT_MODULE_BOOTSTRAP,
        WPK_FORK_EXPORT_MODULE_THREAD_BOOTSTRAP,
        WPK_FORK_EXPORT_MODULE_STATE_RESTORE,
    ] {
        let helper = local(&module, export_function(&module, helper));
        let mut reads_preserved_offset = false;
        walk(helper, helper.entry_block(), &mut |instr| {
            if let Instr::GlobalGet(get) = instr
                && matches!(
                    module.globals.get(get.global).kind,
                    walrus::GlobalKind::Local(walrus::ConstExpr::Extended(_))
                )
            {
                reads_preserved_offset = true;
            }
        });
        assert!(
            reads_preserved_offset,
            "segment helper must consume the naturally evaluated offset global",
        );
    }
}

#[test]
fn segment_lifetime_is_activation_owned_and_reapplied() {
    let bytes = instrument_wat(
        r#"
        (module
          (import "kernel" "kernel_fork" (func $fork (result i32)))
          (memory 1)
          (table 1 funcref)
          (func $target)
          (elem $functions funcref (ref.func $target))
          (data $bytes "payload")
          (func $caller (result i32)
            elem.drop $functions
            data.drop $bytes
            call $fork))
        "#,
    );
    validate(&bytes);
    let module = Module::from_buffer(&bytes).expect("parse instrumented module");
    let restore = local(
        &module,
        export_function(&module, WPK_FORK_EXPORT_MODULE_STATE_RESTORE),
    );
    let finish_restore = local(
        &module,
        export_function(&module, WPK_FORK_EXPORT_MODULE_STATE_FINISH_RESTORE),
    );
    let mut elem_drop = false;
    let mut data_drop = false;
    walk(restore, restore.entry_block(), &mut |instr| match instr {
        Instr::ElemDrop(_) => elem_drop = true,
        Instr::DataDrop(_) => data_drop = true,
        _ => {}
    });
    assert!(
        !elem_drop && !data_drop,
        "value/table restore must leave constructor segments live"
    );
    walk(
        finish_restore,
        finish_restore.entry_block(),
        &mut |instr| match instr {
            Instr::ElemDrop(_) => elem_drop = true,
            Instr::DataDrop(_) => data_drop = true,
            _ => {}
        },
    );
    assert!(
        elem_drop,
        "finish restore must reapply element-segment lifetime"
    );
    assert!(
        data_drop,
        "finish restore must reapply data-segment lifetime"
    );

    let caller = module
        .funcs
        .iter()
        .find(|func| func.name.as_deref() == Some("caller"))
        .expect("named caller");
    let caller = local(&module, caller.id());
    let mut caller_drops = 0;
    let mut tracker_updates = 0;
    walk(caller, caller.entry_block(), &mut |instr| match instr {
        Instr::ElemDrop(_) | Instr::DataDrop(_) => caller_drops += 1,
        Instr::GlobalSet(_) => tracker_updates += 1,
        _ => {}
    });
    assert_eq!(caller_drops, 2);
    assert!(
        tracker_updates >= 2,
        "each original segment drop must update its activation-owned bitmap",
    );
}

#[test]
fn modules_outside_the_active_fork_stack_still_expose_reconstructible_state() {
    let bytes = instrument_wat(
        r#"
        (module
          (@custom "dylink.0" (before first) "state-only")
          (global $counter (mut i64) (i64.const 7))
          (global $root (mut funcref) (ref.null func))
          (table 1 funcref))
        "#,
    );
    validate(&bytes);
    let module = Module::from_buffer(&bytes).expect("parse no-seed instrumented module");
    assert_helper_signature(&module, WPK_FORK_EXPORT_MODULE_STATE_SAVE);
    assert_helper_signature(&module, WPK_FORK_EXPORT_MODULE_STATE_RESTORE);
    assert_helper_signature(&module, WPK_FORK_EXPORT_MODULE_STATE_FINISH_RESTORE);
    assert!(
        module
            .exports
            .iter()
            .any(|export| export.name == FUNCTION_CATALOG_EXPORT),
        "every module activation needs a deterministic funcref catalog",
    );
    for reserved in [
        WPK_FORK_MODULE_STATE_IMPORT_RECORD_RESERVE,
        WPK_FORK_MODULE_STATE_IMPORT_RECORD_COMMIT,
        WPK_FORK_MODULE_STATE_IMPORT_RECORD_FIND,
        WPK_FORK_MODULE_STATE_IMPORT_TABLE_DIRTY_COUNT,
        WPK_FORK_MODULE_STATE_IMPORT_TABLE_DIRTY_MARK,
        WPK_FORK_MODULE_STATE_IMPORT_TABLE_DIRTY_PAGE,
        WPK_FORK_MODULE_STATE_IMPORT_TABLE_STATE_OWNED,
        names::IMPORT_REF_ENCODE_FUNCREF,
        names::IMPORT_REF_DECODE_FUNCREF,
    ] {
        assert!(
            module.imports.iter().any(|import| import.name == reserved),
            "no-seed state helper is missing {reserved}",
        );
    }
    assert!(
        module.imports.iter().any(|import| {
            import.module == "env"
                && import.name == "memory"
                && matches!(import.kind, ImportKind::Memory(_))
        }),
        "a no-memory module must stage KFMS records through env.memory",
    );
}

#[test]
fn node_fresh_instance_restores_no_seed_module_state_and_segment_lifetime() {
    let module = instrument_wat(
        r#"
        (module
          (@custom "dylink.0" (before first) "state-only")
          (import "env" "memory" (memory 0 65536 shared))
          (import "env" "shared_counter" (global $shared_counter (mut i64)))
          (import "env" "shared_callbacks" (table $shared_callbacks 2 8 funcref))
          (import "env" "imported_callback" (func $imported_callback (result i32)))
          (import "env" "immutable_callback" (global $immutable_callback funcref))
          (import "env" "immutable_token" (global $immutable_token externref))
          (export "immutable_callback_global" (global $immutable_callback))
          (export "immutable_token_global" (global $immutable_token))
          (global $immutable_callback_alias funcref (global.get $immutable_callback))
          (global $immutable_token_alias externref (global.get $immutable_token))
          (export "immutable_callback_alias" (global $immutable_callback_alias))
          (export "immutable_token_alias" (global $immutable_token_alias))

          (global $counter (mut i32) (i32.const 0))
          (global $f32_bits (mut f32) (f32.const 0))
          (global $f64_bits (mut f64) (f64.const 0))
          (global $vector (mut v128) (v128.const i32x4 0 0 0 0))
          (global $callback (mut funcref) (ref.null func))
          (global $token (mut externref) (ref.null extern))
          (global $start_count (mut i32) (i32.const 0))

          (table $callbacks (export "callbacks") 3 10 funcref)
          (table $tokens (export "tokens") 2 10 externref)
          (func $a (result i32) i32.const 11)
          (func $b (result i32) i32.const 22)
          (elem $baseline (table $callbacks) (i32.const 0) func $a $b $a)
          (elem $late func $b $a)
          (data $active_data (i32.const 16) "\31\32\33")
          (data $late_data "xyz")

          (func $module_start
            global.get $start_count
            i32.const 1
            i32.add
            global.set $start_count
            i32.const 16
            i32.const 0x44
            i32.store8)
          (start $module_start)

          (func (export "mutate") (param $owned externref)
            i32.const 0x11223344
            global.set $counter
            i64.const 0x1122334455667788
            global.set $shared_counter
            i32.const 0x7fc12345
            f32.reinterpret_i32
            global.set $f32_bits
            i64.const 0x7ff8123456789abc
            f64.reinterpret_i64
            global.set $f64_bits
            v128.const i32x4 101 202 303 404
            global.set $vector
            ref.func $b
            global.set $callback
            local.get $owned
            global.set $token
            i32.const 16
            i32.const 0x7a
            i32.store8

            ref.func $b
            i32.const 2
            table.grow $callbacks
            drop
            i32.const 0
            ref.func $b
            table.set $callbacks
            i32.const 1
            ref.func $a
            i32.const 2
            table.fill $callbacks
            i32.const 3
            i32.const 0
            i32.const 2
            table.copy $callbacks $callbacks
            i32.const 1
            i32.const 0
            i32.const 2
            table.init $callbacks $late
            elem.drop $late

            local.get $owned
            i32.const 2
            table.grow $tokens
            drop
            i32.const 0
            local.get $owned
            i32.const 4
            table.fill $tokens
            i32.const 1
            i32.const 0
            i32.const 3
            table.copy $tokens $tokens

            ref.func $a
            i32.const 1
            table.grow $shared_callbacks
            drop
            i32.const 0
            ref.func $b
            i32.const 3
            table.fill $shared_callbacks
            data.drop $late_data)

          (func (export "counter") (result i32) global.get $counter)
          (func (export "shared_counter") (result i64) global.get $shared_counter)
          (func (export "f32_bits") (result i32)
            global.get $f32_bits
            i32.reinterpret_f32)
          (func (export "f64_bits") (result i64)
            global.get $f64_bits
            i64.reinterpret_f64)
          (func (export "vector_lane_2") (result i32)
            global.get $vector
            i32x4.extract_lane 2)
          (func (export "callback") (result funcref) global.get $callback)
          (func (export "token") (result externref) global.get $token)
          (func (export "start_count") (result i32) global.get $start_count)
          (func (export "active_data_byte") (result i32)
            i32.const 16
            i32.load8_u)
          (func (export "immutable_callback") (result funcref)
            global.get $immutable_callback)
          (func (export "immutable_token") (result externref)
            global.get $immutable_token)
          (func (export "shared_callback") (param $index i32) (result funcref)
            local.get $index
            table.get $shared_callbacks)
          (func (export "try_late_elem")
            i32.const 0
            i32.const 0
            i32.const 1
            table.init $callbacks $late)
          (func (export "try_late_data")
            i32.const 0
            i32.const 0
            i32.const 1
            memory.init $late_data)
          (func (export "try_active_elem")
            i32.const 0
            i32.const 0
            i32.const 1
            table.init $callbacks $baseline)
          (func (export "try_active_data")
            i32.const 0
            i32.const 0
            i32.const 1
            memory.init $active_data))
        "#,
    );
    let typed_codecs = wat::parse_str(
        r#"
        (module
          (func (export "callback") (result i32) i32.const 31)
          (func (export "__wpk_fork_ref_encode_exnref")
            (param (ref null exn)) (result i32) i32.const 0)
          (func (export "__wpk_fork_ref_decode_exnref")
            (param i32) (result (ref null exn)) ref.null exn)
          (func (export "__wpk_fork_ref_encode_anyref")
            (param (ref null any)) (result i32) i32.const 0)
          (func (export "__wpk_fork_ref_decode_anyref")
            (param i32) (result (ref null any)) ref.null any))
        "#,
    )
    .expect("compile typed reference codec fixture");

    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock after epoch")
        .as_nanos();
    let directory = std::env::temp_dir().join(format!(
        "kandelo-module-state-{}-{nonce}",
        std::process::id(),
    ));
    fs::create_dir(&directory).expect("create module-state engine-test directory");
    let module_path = directory.join("module.wasm");
    let codecs_path = directory.join("typed-codecs.wasm");
    fs::write(&module_path, module).expect("write instrumented module fixture");
    fs::write(&codecs_path, typed_codecs).expect("write typed codec fixture");

    let script = r#"
      const fs = require("node:fs");
      const [modulePath, codecsPath] = process.argv.slice(1);
      const module = new WebAssembly.Module(fs.readFileSync(modulePath));
      const codecModule = new WebAssembly.Module(fs.readFileSync(codecsPath));
      const typed = new WebAssembly.Instance(codecModule).exports;
      const nodes = [{ kind: "null" }];
      const objectIds = new WeakMap();
      const records = [];
      let parent;
      let child;
      let thread;

      function intern(value, node) {
        if (value === null) return 0;
        const known = objectIds.get(value);
        if (known !== undefined) return known;
        const id = nodes.length;
        nodes.push(node());
        objectIds.set(value, id);
        return id;
      }
      function functionOrdinal(instance, value) {
        const catalog = instance.exports.__wpk_fork_function_catalog;
        for (let ordinal = 0; ordinal < catalog.length; ordinal++) {
          if (catalog.get(ordinal) === value) return ordinal;
        }
        throw new Error("funcref absent from function catalog");
      }
      function encodeFuncref(value) {
        return intern(value, () => ({
          kind: "funcref",
          ordinal: functionOrdinal(parent, value),
        }));
      }
      function encodeExternref(value) {
        return intern(value, () => {
          if (typeof value !== "object" || value === null || !Number.isInteger(value.handle)) {
            throw new Error("externref bypassed the test process owner");
          }
          return { kind: "externref", handle: value.handle };
        });
      }
      const childExternrefs = new Map();
      function decodeFuncref(id) {
        if (id === 0) return null;
        const node = nodes[id];
        if (node?.kind !== "funcref") throw new Error(`recipe ${id} is not funcref`);
        return child.exports.__wpk_fork_function_catalog.get(node.ordinal);
      }
      function decodeExternref(id) {
        if (id === 0) return null;
        const node = nodes[id];
        if (node?.kind !== "externref") throw new Error(`recipe ${id} is not externref`);
        let token = childExternrefs.get(node.handle);
        if (!token) {
          token = Object.freeze({ handle: node.handle, child: true });
          childExternrefs.set(node.handle, token);
        }
        return token;
      }

      function instantiate(mode, memory, sharedCounter, sharedCallbacks, imports) {
        let cursor = 65536;
        let pending = null;
        const dirtyPages = new Map();
        let nextReferenceVector = 1;
        const referenceVectors = new Map();
        // The real process owner sizes this typed transit table for the
        // reference recipe transaction. Keep the engine fixture large enough
        // for every scalar/global/table recipe it intentionally captures.
        const gcTransit = new WebAssembly.Table({
          element: "anyref", initial: 1024,
        });
        const beginReferenceVector = (capacity) => {
          const id = nextReferenceVector++;
          referenceVectors.set(id, { capacity, values: [] });
          return id;
        };
        const appendReferenceVector = (id, value) => {
          const vector = referenceVectors.get(id);
          if (!vector || vector.values.length >= vector.capacity) {
            throw new Error(`invalid reference vector append ${id}`);
          }
          vector.values.push(value);
        };
        const finishReferenceVector = (id) => {
          const vector = referenceVectors.get(id);
          if (!vector || vector.values.length !== vector.capacity) {
            throw new Error(`invalid reference vector finish ${id}`);
          }
          return id;
        };
        const getReferenceVector = (id, index) => {
          const vector = referenceVectors.get(id);
          if (!vector || index < 0 || index >= vector.values.length) {
            throw new Error(`invalid reference vector lookup ${id}:${index}`);
          }
          return vector.values[index];
        };
        const dirtyMark = (owner, firstValue, countValue) => {
          const first = BigInt.asUintN(64, firstValue);
          const count = BigInt.asUintN(64, countValue);
          let pages = dirtyPages.get(owner);
          if (!pages) {
            pages = new Set();
            dirtyPages.set(owner, pages);
          }
          for (let offset = 0n; offset < count; offset++) {
            pages.add(first + offset);
          }
        };
        const sortedDirtyPages = (owner) =>
          [...(dirtyPages.get(owner) ?? [])].sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
        const allocate = (size) => {
          const pointer = (cursor + 7) & ~7;
          cursor = pointer + size;
          if (cursor > memory.buffer.byteLength) {
            memory.grow(Math.ceil((cursor - memory.buffer.byteLength) / 65536));
          }
          return pointer;
        };
        const reserve = (kind, activation, owner, size) => {
          if (pending) throw new Error("nested record reservation");
          const pointer = allocate(size);
          pending = { kind, activation, owner, size, pointer };
          return pointer;
        };
        const commit = (pointer) => {
          if (!pending || pending.pointer !== pointer) throw new Error("bad record commit");
          records.push({
            kind: pending.kind,
            activation: pending.activation,
            owner: pending.owner,
            payload: new Uint8Array(memory.buffer, pointer, pending.size).slice(),
          });
          pending = null;
        };
        const find = (kind, activation, owner, ordinal) => {
          const matches = records.filter((record) =>
            record.kind === kind
            && record.activation === activation
            && record.owner === owner
          );
          const record = matches[ordinal];
          if (!record) throw new Error(`missing record ${kind}:${activation}:${owner}:${ordinal}`);
          const pointer = allocate(record.payload.length);
          new Uint8Array(memory.buffer, pointer, record.payload.length).set(record.payload);
          return pointer;
        };
        const unreachableFrame = () => {
          throw new Error("no-seed module unexpectedly used a continuation-frame hook");
        };
        const env = {
          memory,
          shared_counter: sharedCounter,
          shared_callbacks: sharedCallbacks,
          imported_callback: imports.importedCallback,
          immutable_callback: imports.importedCallback,
          immutable_token: imports.immutableToken,
          __wpk_fork_module_activation: new WebAssembly.Global(
            { value: "i32", mutable: false },
            0,
          ),
          __wpk_fork_unwind: new WebAssembly.Tag({ parameters: [] }),
          __wpk_fork_frame_reserve: unreachableFrame,
          __wpk_fork_frame_commit: unreachableFrame,
          __wpk_fork_frame_next: unreachableFrame,
          __wpk_fork_frame_peek: unreachableFrame,
          __wpk_fork_resume_peek: () => 0,
          __wpk_fork_resume_table: new WebAssembly.Table({
            element: "anyfunc", initial: 1,
          }),
          __wpk_fork_ref_gc_transit: gcTransit,
          __wpk_fork_module_state_record_reserve:
            mode === "capture" ? reserve : unreachableFrame,
          __wpk_fork_module_state_record_commit:
            mode === "capture" ? commit : unreachableFrame,
          __wpk_fork_module_state_record_find:
            mode === "restore" ? find : unreachableFrame,
          __wpk_fork_module_state_table_dirty_mark: dirtyMark,
          __wpk_fork_module_state_table_dirty_count:
            (owner) => sortedDirtyPages(owner).length,
          __wpk_fork_module_state_table_dirty_page:
            (owner, ordinal) => BigInt.asIntN(64, sortedDirtyPages(owner)[ordinal]),
          __wpk_fork_module_state_table_state_owned: () => 1,
          __wpk_fork_module_state_table_generation_addr: new WebAssembly.Global(
            { value: "i64", mutable: false },
            0n,
          ),
          __wpk_fork_module_state_table_reconcile: () => 0n,
          __wpk_fork_module_state_table_mutation_begin: () => 0n,
          __wpk_fork_module_state_table_mutation_commit: () => {},
          __wpk_fork_module_state_table_mutation_abort: () => {},
          __wpk_fork_ref_encode_funcref: encodeFuncref,
          __wpk_fork_ref_decode_funcref: decodeFuncref,
          __wpk_fork_ref_encode_externref: encodeExternref,
          __wpk_fork_ref_decode_externref: decodeExternref,
          __wpk_fork_ref_encode_exnref: typed.__wpk_fork_ref_encode_exnref,
          __wpk_fork_ref_decode_exnref: typed.__wpk_fork_ref_decode_exnref,
          __wpk_fork_ref_encode_anyref: typed.__wpk_fork_ref_encode_anyref,
          __wpk_fork_ref_decode_anyref: typed.__wpk_fork_ref_decode_anyref,
          __wpk_fork_ref_vector_begin: beginReferenceVector,
          __wpk_fork_ref_vector_append: appendReferenceVector,
          __wpk_fork_ref_vector_finish: finishReferenceVector,
          __wpk_fork_ref_vector_get: getReferenceVector,
          __wpk_fork_ref_exn_lookup: () => 0,
          __wpk_fork_ref_exn_claim: () => 0,
          __wpk_fork_ref_exn_define: () => {},
          __wpk_fork_ref_exn_load: () => 0,
          __wpk_fork_ref_exn_route: () => 0,
          __wpk_fork_ref_exn_cache_index: () => 1,
          __wpk_fork_ref_exn_broker_encode: () => 0,
          __wpk_fork_ref_exn_broker_throw_recipe: () => {
            throw new Error("unused exception recipe route");
          },
          __wpk_fork_ref_exn_ingress_throw: () => {
            throw new Error("unused exception ingress route");
          },
          __wpk_fork_ref_gc_lookup: () => 0,
          __wpk_fork_ref_gc_claim: () => 0,
          __wpk_fork_ref_gc_i31: () => 0,
          __wpk_fork_ref_gc_define: () => {},
          __wpk_fork_ref_gc_route: () => 0,
          __wpk_fork_ref_gc_payload_len: () => 0,
          __wpk_fork_ref_gc_load: () => 0,
          __wpk_fork_ref_gc_broker_encode:
            (slot) => encodeExternref(gcTransit.get(slot)),
          __wpk_fork_ref_gc_capture_layout: () => 0,
          __wpk_fork_ref_gc_provenance_begin: () => 0,
          __wpk_fork_ref_gc_provenance_ref: () => {},
          __wpk_fork_ref_gc_provenance_end: () => {},
          __wpk_fork_ref_scratch_reserve: (size) => allocate(Number(size)),
          __wpk_fork_ref_scratch_release: () => {},
          // N1-F5 T1: pass-through stub. The real host body (later F5 tasks)
          // records mint-time provenance as a side effect and returns the
          // same externref unchanged; this test only needs link-time
          // callability and identity preservation, not provenance recording.
          __wpk_fork_ref_provenance_externref: (value) => value,
        };
        return new WebAssembly.Instance(module, { env });
      }

      const parentMemory = new WebAssembly.Memory({
        initial: 4, maximum: 65536, shared: true,
      });
      const parentSharedCounter = new WebAssembly.Global(
        { value: "i64", mutable: true }, 0n,
      );
      const parentSharedCallbacks = new WebAssembly.Table({
        element: "anyfunc", initial: 2, maximum: 8,
      });
      const parentImportedCallback =
        new WebAssembly.Instance(codecModule).exports.callback;
      const parentImmutableToken = Object.freeze({ handle: 88, parent: true });
      parent = instantiate(
        "capture",
        parentMemory,
        parentSharedCounter,
        parentSharedCallbacks,
        {
          importedCallback: parentImportedCallback,
          immutableToken: parentImmutableToken,
        },
      );
      if (parent.exports.start_count() !== 0) {
        throw new Error("original start ran during raw instantiation");
      }
      parent.exports.wpk_fork_module_bootstrap();
      if (parent.exports.start_count() !== 1 || parent.exports.active_data_byte() !== 0x44) {
        throw new Error("parent bootstrap did not preserve segment/start ordering");
      }
      const owned = Object.freeze({ handle: 77, parent: true });
      parent.exports.mutate(owned);
      if (parent.exports.token() !== owned) {
        throw new Error("parent mutable externref global was not assigned");
      }
      parent.exports.wpk_fork_module_state_save(7);
      if (records.length === 0) throw new Error("module state emitted no records");

      thread = instantiate(
        "thread",
        parentMemory,
        parentSharedCounter,
        parentSharedCallbacks,
        {
          importedCallback: parentImportedCallback,
          immutableToken: parentImmutableToken,
        },
      );
      thread.exports.wpk_fork_module_thread_bootstrap();
      if (thread.exports.start_count() !== 0) {
        throw new Error("pthread bootstrap reran original start");
      }
      if (thread.exports.active_data_byte() !== 0x7a) {
        throw new Error("pthread bootstrap overwrote shared linear memory");
      }
      [11, 22, 11].forEach((value, index) => {
        if (thread.exports.callbacks.get(index)() !== value) {
          throw new Error(`pthread table baseline entry ${index} is missing`);
        }
      });
      for (const name of ["try_active_elem", "try_active_data"]) {
        let trapped = false;
        try {
          thread.exports[name]();
        } catch (error) {
          trapped = error instanceof WebAssembly.RuntimeError;
        }
        if (!trapped) throw new Error(`${name} stayed live after pthread bootstrap`);
      }

      const childMemory = new WebAssembly.Memory({
        initial: parentMemory.buffer.byteLength / 65536,
        maximum: 65536,
        shared: true,
      });
      new Uint8Array(childMemory.buffer).set(new Uint8Array(parentMemory.buffer));
      const childSharedCounter = new WebAssembly.Global(
        { value: "i64", mutable: true }, 0n,
      );
      const childSharedCallbacks = new WebAssembly.Table({
        element: "anyfunc", initial: 2, maximum: 8,
      });
      const childImportedCallback =
        new WebAssembly.Instance(codecModule).exports.callback;
      const childImmutableToken = Object.freeze({ handle: 88, child: true });
      childExternrefs.set(88, childImmutableToken);
      child = instantiate(
        "restore",
        childMemory,
        childSharedCounter,
        childSharedCallbacks,
        {
          importedCallback: childImportedCallback,
          immutableToken: childImmutableToken,
        },
      );
      nodes.forEach((node, recipeId) => {
        if (node.kind === "externref") {
          child.exports.__wpk_fork_ref_gc_publish_externref(
            recipeId,
            decodeExternref(recipeId),
          );
        }
      });
      child.exports.wpk_fork_module_state_restore(7);
      for (const name of [
        "try_late_elem",
        "try_late_data",
        "try_active_elem",
        "try_active_data",
      ]) {
        try {
          child.exports[name]();
        } catch (error) {
          throw new Error(`${name} was dropped before reference reconstruction`, {
            cause: error,
          });
        }
      }
      // Reapply the exact table/memory-owned state after probes, then cross
      // the global segment-lifetime boundary. Both phases are idempotent.
      child.exports.wpk_fork_module_state_restore(7);
      child.exports.wpk_fork_module_state_finish_restore(7);
      child.exports.wpk_fork_module_state_finish_restore(7);

      if (child.exports.start_count() !== 1) throw new Error("child reran original start");
      if (child.exports.active_data_byte() !== 0x7a) {
        throw new Error("child reran active data initialization over copied memory");
      }
      if (child.exports.counter() !== 0x11223344) throw new Error("i32 global reset");
      if (child.exports.shared_counter() !== 0x1122334455667788n) {
        throw new Error("imported mutable scalar global reset");
      }
      if ((child.exports.f32_bits() >>> 0) !== 0x7fc12345) {
        throw new Error("f32 payload bits changed");
      }
      if (child.exports.f64_bits() !== 0x7ff8123456789abcn) {
        throw new Error("f64 payload bits changed");
      }
      if (child.exports.vector_lane_2() !== 303) throw new Error("v128 global reset");
      if (child.exports.callback()() !== 22) throw new Error("funcref global reset");
      if (child.exports.immutable_callback() !== childImportedCallback) {
        throw new Error("immutable imported funcref retained parent identity");
      }
      if (child.exports.immutable_callback_global.value !== childImportedCallback) {
        throw new Error("exported immutable funcref was not materialized before instantiation");
      }
      if (child.exports.immutable_callback_alias.value !== childImportedCallback) {
        throw new Error("immutable funcref const initializer saw the wrong child binding");
      }
      const token = child.exports.token();
      if (token === owned || token.handle !== 77 || !token.child) {
        throw new Error("externref global was not reconstructed");
      }
      if (child.exports.immutable_token().handle !== 88) {
        throw new Error("immutable imported externref recipe changed");
      }
      if (
        child.exports.immutable_token_global.value !== childImmutableToken
        || child.exports.immutable_token_alias.value !== childImmutableToken
        || child.exports.immutable_token() !== childImmutableToken
      ) {
        throw new Error("immutable externref was not materialized before instantiation");
      }

      const callbackValues = [22, 22, 11, 22, 11];
      if (child.exports.callbacks.length !== callbackValues.length) {
        throw new Error("funcref table length reset");
      }
      callbackValues.forEach((value, index) => {
        if (child.exports.callbacks.get(index)() !== value) {
          throw new Error(`funcref table entry ${index} reset`);
        }
      });
      if (child.exports.tokens.length !== 4) throw new Error("externref table length reset");
      for (let index = 0; index < 4; index++) {
        if (child.exports.tokens.get(index) !== token) {
          throw new Error(`externref alias lost at table entry ${index}`);
        }
      }
      if (childSharedCallbacks.length !== 3) {
        throw new Error("imported table length reset");
      }
      for (let index = 0; index < 3; index++) {
        if (child.exports.shared_callback(index)() !== 22) {
          throw new Error(`imported table entry ${index} reset`);
        }
      }
      for (const name of ["try_late_elem", "try_late_data"]) {
        let trapped = false;
        try {
          child.exports[name]();
        } catch (error) {
          trapped = error instanceof WebAssembly.RuntimeError;
        }
        if (!trapped) throw new Error(`${name} observed a live dropped segment`);
      }
    "#;
    let output = Command::new("node")
        .arg("-e")
        .arg(script)
        .arg(&module_path)
        .arg(&codecs_path)
        .output()
        .expect("run Node module-state fresh-instance test");
    let _ = fs::remove_dir_all(&directory);
    assert!(
        output.status.success(),
        "Node module-state engine test failed:\nstdout:\n{}\nstderr:\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr),
    );
}

#[test]
fn node_fresh_instance_reimports_concrete_gc_global_before_const_initializers() {
    let provider = wat::parse_str(
        r#"
        (module
          (type $pair (struct (field i32)))
          (global $root (ref $pair)
            (struct.new $pair (i32.const 91)))
          (export "__wpk_fork_global_1" (global $root))
          (export "root" (global $root)))
        "#,
    )
    .expect("compile concrete-GC provider");
    let consumer = wat::parse_str(
        r#"
        (module
          (type $pair (struct (field i32)))
          (import "provider" "root" (global $root (ref $pair)))
          (global $alias (ref $pair) (global.get $root))
          (export "__wpk_fork_global_1" (global $root))
          (export "root" (global $root))
          (export "alias" (global $alias))
          (func (export "same") (result i32)
            global.get $root
            global.get $alias
            ref.eq)
          (func (export "value") (result i32)
            global.get $alias
            struct.get $pair 0))
        "#,
    )
    .expect("compile concrete-GC consumer");

    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock after epoch")
        .as_nanos();
    let directory = std::env::temp_dir().join(format!(
        "kandelo-imported-gc-global-{}-{nonce}",
        std::process::id(),
    ));
    fs::create_dir(&directory).expect("create concrete-GC test directory");
    let provider_path = directory.join("provider.wasm");
    let consumer_path = directory.join("consumer.wasm");
    fs::write(&provider_path, provider).expect("write concrete-GC provider");
    fs::write(&consumer_path, consumer).expect("write concrete-GC consumer");
    let script = r#"
      const fs = require("node:fs");
      const [providerPath, consumerPath] = process.argv.slice(1);
      const providerModule =
        new WebAssembly.Module(fs.readFileSync(providerPath));
      const consumerModule =
        new WebAssembly.Module(fs.readFileSync(consumerPath));

      const parentProvider = new WebAssembly.Instance(providerModule);
      const parentConsumer = new WebAssembly.Instance(consumerModule, {
        provider: { root: parentProvider.exports.__wpk_fork_global_1 },
      });
      const childProvider = new WebAssembly.Instance(providerModule);
      const childConsumer = new WebAssembly.Instance(consumerModule, {
        provider: { root: childProvider.exports.__wpk_fork_global_1 },
      });

      if (
        childConsumer.exports.root
        !== childProvider.exports.__wpk_fork_global_1
      ) {
        throw new Error("consumer did not bind the provider Global object");
      }
      if (childConsumer.exports.root === parentConsumer.exports.root) {
        throw new Error("fresh child retained the parent provider Global");
      }
      if (childConsumer.exports.root.value === parentConsumer.exports.root.value) {
        throw new Error("fresh child retained the parent concrete GC object");
      }
      if (
        childConsumer.exports.alias.value
        !== childConsumer.exports.root.value
      ) {
        throw new Error("concrete GC const initializer lost provider identity");
      }
      if (childConsumer.exports.same() !== 1 || childConsumer.exports.value() !== 91) {
        throw new Error("concrete GC provider recipe changed guest semantics");
      }
    "#;
    let output = Command::new("node")
        .arg("-e")
        .arg(script)
        .arg(&provider_path)
        .arg(&consumer_path)
        .output()
        .expect("run Node concrete-GC import test");
    let _ = fs::remove_dir_all(&directory);
    assert!(
        output.status.success(),
        "Node concrete-GC import test failed:\nstdout:\n{}\nstderr:\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr),
    );
}
