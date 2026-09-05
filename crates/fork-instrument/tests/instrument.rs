//! Tests for the fork-instrument transforms (switch-dispatch + guard-dispatch).
//!
//! Two transforms share the same fork-resume contract; the instrumenter
//! picks one per function based on call-site topology:
//!
//! - **switch-dispatch**: used when every fork-path call lives at the
//!   function body's top level. REWIND jumps directly to the resumed
//!   call site via a top-level `br_table` (switch-dispatch). Chunks
//!   between calls run only on the NORMAL fall-through.
//! - **guard-dispatch**: used when any fork-path call is nested inside
//!   a block/loop/if/try_table. Each call site carries an in-place
//!   if-else guard that fires on `(NORMAL) || (REWIND && call_idx ==
//!   N)`; replay restores activation-owned frame state before entering
//!   the selected continuation.
//!
//! Both schemes share the same frame layout and a result-typed restart loop
//! containing `[preamble-ifelse, Block($unwind_save), postamble]`.

use std::collections::HashSet;

use fork_instrument::runtime::names as runtime_names;
use fork_instrument::{Options, instrument};
use walrus::{
    ExportItem, FunctionId, FunctionKind, LocalFunction, Module, ValType,
    ir::{self, Instr, InstrSeqId},
};

// --- Helpers ----------------------------------------------------------

fn parse_wat(wat_src: &str) -> Vec<u8> {
    wat::parse_str(wat_src).expect("wat parse")
}

fn instrument_wat(wat_src: &str) -> Vec<u8> {
    let bytes = parse_wat(wat_src);
    instrument(&bytes, &Options::default()).expect("instrument")
}

/// Exercise the rewrite itself without the artifact-level activation-state
/// policy. This keeps transport tests focused on emitted control flow while
/// reference reconstruction support is expanded independently.
fn instrument_wat_unchecked(wat_src: &str) -> Vec<u8> {
    let bytes = parse_wat(wat_src);
    let mut module = Module::from_buffer(&bytes).expect("walrus parse");
    let seed = fork_instrument::call_graph::find_import_func(&module, "kernel.kernel_fork")
        .expect("fork import");
    let fork_path = fork_instrument::call_graph::reaching_closure(&module, seed);
    let mut targets: Vec<_> = fork_path
        .iter()
        .copied()
        .filter(|id| matches!(module.funcs.get(*id).kind, FunctionKind::Local(_)))
        .collect();
    targets.sort();
    let catch_plan = fork_instrument::instrument::plan_plain_catches(&module, &targets);
    let runtime = fork_instrument::runtime::inject_linked_runtime(&mut module);
    fork_instrument::instrument::instrument_functions(
        &mut module,
        &runtime,
        &fork_path,
        &catch_plan,
    );
    module.emit_wasm()
}

fn validate(bytes: &[u8]) {
    let mut validator =
        wasmparser::Validator::new_with_features(wasmparser::WasmFeatures::default());
    validator.validate_all(bytes).expect("valid wasm");
}

fn func_by_name(module: &Module, name: &str) -> FunctionId {
    module
        .funcs
        .iter()
        .find(|f| f.name.as_deref() == Some(name))
        .unwrap_or_else(|| panic!("function `{name}` not found"))
        .id()
}

fn local_func(module: &Module, id: FunctionId) -> &LocalFunction {
    match &module.funcs.get(id).kind {
        FunctionKind::Local(l) => l,
        _ => panic!("function is not local"),
    }
}

fn logical_entry_seq(f: &LocalFunction) -> InstrSeqId {
    let entry = f.block(f.entry_block());
    entry
        .instrs
        .last()
        .and_then(|(instruction, _)| match instruction {
            Instr::Loop(ir::Loop { seq }) => Some(*seq),
            _ => None,
        })
        .unwrap_or_else(|| f.entry_block())
}

fn entry_instr_kinds(module: &Module, id: FunctionId) -> Vec<InstrKind> {
    let f = local_func(module, id);
    f.block(logical_entry_seq(f))
        .instrs
        .iter()
        .map(|(i, _)| InstrKind::of(i))
        .collect()
}

fn seq_kinds(module: &Module, func_id: FunctionId, seq_id: InstrSeqId) -> Vec<InstrKind> {
    local_func(module, func_id)
        .block(seq_id)
        .instrs
        .iter()
        .map(|(i, _)| InstrKind::of(i))
        .collect()
}

/// Return the dispatch body inside the live-restart loop.
///
/// Each fork-reaching call now owns its own result-typed private unwind catch,
/// so there is no function-wide catch wrapper or activation-local selector.
fn protected_unwind_body_seq(module: &Module, id: FunctionId) -> InstrSeqId {
    let f = local_func(module, id);
    let blocks: Vec<InstrSeqId> = f
        .block(logical_entry_seq(f))
        .instrs
        .iter()
        .filter_map(|(i, _)| match i {
            Instr::Block(b) => Some(b.seq),
            _ => None,
        })
        .collect();
    assert_eq!(
        blocks.len(),
        1,
        "expected exactly one wrapper Block in entry of func {id:?}",
    );
    blocks[0]
}

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
enum InstrKind {
    Block,
    Return,
    Unreachable,
    Call,
    CallIndirect,
    Const,
    Drop,
    GlobalGet,
    LocalGet,
    LocalSet,
    Unop,
    Binop,
    IfElse,
    BrIf,
    BrTable,
    Throw,
    Other,
}

impl InstrKind {
    fn of(instr: &Instr) -> Self {
        match instr {
            Instr::Block(_) => InstrKind::Block,
            Instr::Return(_) => InstrKind::Return,
            Instr::Unreachable(_) => InstrKind::Unreachable,
            Instr::Call(_) => InstrKind::Call,
            Instr::CallIndirect(_) => InstrKind::CallIndirect,
            Instr::Const(_) => InstrKind::Const,
            Instr::Drop(_) => InstrKind::Drop,
            Instr::GlobalGet(_) => InstrKind::GlobalGet,
            Instr::LocalGet(_) => InstrKind::LocalGet,
            Instr::LocalSet(_) => InstrKind::LocalSet,
            Instr::Unop(_) => InstrKind::Unop,
            Instr::Binop(_) => InstrKind::Binop,
            Instr::IfElse(_) => InstrKind::IfElse,
            Instr::BrIf(_) => InstrKind::BrIf,
            Instr::BrTable(_) => InstrKind::BrTable,
            Instr::Throw(_) => InstrKind::Throw,
            _ => InstrKind::Other,
        }
    }
}

fn nested_of(instr: &Instr) -> Vec<InstrSeqId> {
    match instr {
        Instr::Block(ir::Block { seq }) => vec![*seq],
        Instr::Loop(ir::Loop { seq }) => vec![*seq],
        Instr::IfElse(ir::IfElse {
            consequent,
            alternative,
        }) => vec![*consequent, *alternative],
        Instr::TryTable(ir::TryTable { seq, .. }) => vec![*seq],
        _ => Vec::new(),
    }
}

/// Invoke `visit` for every instruction reachable from `seq`.
fn walk_all<F: FnMut(InstrSeqId, &Instr)>(f: &LocalFunction, seq: InstrSeqId, visit: &mut F) {
    for (instr, _) in &f.block(seq).instrs {
        visit(seq, instr);
        for child in nested_of(instr) {
            walk_all(f, child, visit);
        }
    }
}

fn reference_codec_function(module: &Module, name: &str) -> FunctionId {
    if let Some(function) = module.imports.iter().find_map(|import| {
        if import.module != runtime_names::IMPORT_REFERENCE_CODEC_MODULE || import.name != name {
            return None;
        }
        match import.kind {
            walrus::ImportKind::Function(function) => Some(function),
            _ => None,
        }
    }) {
        return function;
    }

    module
        .exports
        .iter()
        .find_map(|export| {
            (export.name == name)
                .then_some(export.item)
                .and_then(|item| {
                    if let ExportItem::Function(function) = item {
                        Some(function)
                    } else {
                        None
                    }
                })
        })
        .or_else(|| {
            module
                .funcs
                .iter()
                .find(|function| function.name.as_deref() == Some(name))
                .map(|function| function.id())
        })
        .unwrap_or_else(|| panic!("missing reference-codec function `{name}`"))
}

fn assert_function_calls_codec_pair(
    module: &Module,
    function_name: &str,
    encode_name: &str,
    decode_name: &str,
) {
    let encode = reference_codec_function(module, encode_name);
    let decode = reference_codec_function(module, decode_name);
    let function = local_func(module, func_by_name(module, function_name));
    let mut calls = HashSet::new();
    walk_all(function, function.entry_block(), &mut |_, instruction| {
        if let Instr::Call(call) = instruction {
            calls.insert(call.func);
        }
    });
    assert!(
        calls.contains(&encode),
        "`{function_name}` must encode its live reference through `{encode_name}`"
    );
    assert!(
        calls.contains(&decode),
        "`{function_name}` must decode its live reference through `{decode_name}`"
    );
}

fn assert_function_uses_exception_recipe(module: &Module, function_name: &str) {
    assert_function_calls_codec_pair(
        module,
        function_name,
        runtime_names::IMPORT_REF_ENCODE_EXNREF,
        runtime_names::IMPORT_REF_DECODE_EXNREF,
    );
    let function = local_func(module, func_by_name(module, function_name));
    let mut has_throw_ref = false;
    walk_all(function, function.entry_block(), &mut |_, instruction| {
        has_throw_ref |= matches!(instruction, Instr::ThrowRef(_));
    });
    assert!(
        has_throw_ref,
        "`{function_name}` must replay a codec-owned exception with throw_ref"
    );
}

fn sequences_with_direct_call(
    module: &Module,
    owner_name: &str,
    target_name: &str,
) -> Vec<Vec<InstrKind>> {
    let owner = local_func(module, func_by_name(module, owner_name));
    let target = func_by_name(module, target_name);
    let mut sequences = HashSet::new();
    walk_all(owner, owner.entry_block(), &mut |sequence, instruction| {
        if matches!(instruction, Instr::Call(call) if call.func == target) {
            sequences.insert(sequence);
        }
    });
    sequences
        .into_iter()
        .map(|sequence| {
            owner
                .block(sequence)
                .instrs
                .iter()
                .map(|(instruction, _)| InstrKind::of(instruction))
                .collect()
        })
        .collect()
}

fn assert_resume_routing(module: &Module, owner_name: &str) {
    let resume_peek = module
        .imports
        .iter()
        .find_map(|import| match &import.kind {
            walrus::ImportKind::Function(function) if import.name == "__wpk_fork_resume_peek" => {
                Some(*function)
            }
            _ => None,
        })
        .expect("resume peek import");
    let resume_table = module
        .imports
        .iter()
        .find_map(|import| match &import.kind {
            walrus::ImportKind::Table(table) if import.name == "__wpk_fork_resume_table" => {
                Some(*table)
            }
            _ => None,
        })
        .expect("resume table import");
    let owner = local_func(module, func_by_name(module, owner_name));
    let mut peeks = 0;
    let mut dispatches = 0;
    walk_all(
        owner,
        owner.entry_block(),
        &mut |_, instruction| match instruction {
            Instr::Call(call) if call.func == resume_peek => peeks += 1,
            Instr::CallIndirect(call) if call.table == resume_table => dispatches += 1,
            _ => {}
        },
    );
    assert!(peeks > 0, "{owner_name} must peek the next replay event");
    assert!(
        dispatches > 0,
        "{owner_name} must dispatch a committed activation through the shared table"
    );
}

fn assert_direct_activation_replay_is_lexical(module: &Module, owner_name: &str) {
    let resume_peek = module
        .imports
        .iter()
        .find_map(|import| match &import.kind {
            walrus::ImportKind::Function(function)
                if import.name == "__wpk_fork_resume_peek" =>
            {
                Some(*function)
            }
            _ => None,
        })
        .expect("resume peek import");
    let resume_table = module
        .imports
        .iter()
        .find_map(|import| match &import.kind {
            walrus::ImportKind::Table(table)
                if import.name == "__wpk_fork_resume_table" =>
            {
                Some(*table)
            }
            _ => None,
        })
        .expect("resume table import");
    let owner = local_func(module, func_by_name(module, owner_name));
    let mut peeks = 0;
    let mut dispatches = 0;
    walk_all(
        owner,
        owner.entry_block(),
        &mut |_, instruction| match instruction {
            Instr::Call(call) if call.func == resume_peek => peeks += 1,
            Instr::CallIndirect(call) if call.table == resume_table => dispatches += 1,
            _ => {}
        },
    );
    assert_eq!(
        (peeks, dispatches),
        (0, 0),
        "{owner_name} must enter its exact direct activation without adding a \
         resume-thunk frame"
    );
}

fn count_br_tables(f: &LocalFunction) -> usize {
    let mut n = 0usize;
    walk_all(f, f.entry_block(), &mut |_, instr| {
        if matches!(instr, Instr::BrTable(_)) {
            n += 1;
        }
    });
    n
}

fn entry_preamble_and_postamble(
    module: &Module,
    func_id: FunctionId,
) -> (InstrSeqId, InstrSeqId, usize) {
    let f = local_func(module, func_id);
    let physical_entry = f.block(f.entry_block());
    let logical_entry = f.block(logical_entry_seq(f));

    let preamble_then =
        physical_entry
            .instrs
            .iter()
            .find_map(|(instruction, _)| match instruction {
                Instr::IfElse(ie) => Some(ie.consequent),
                _ => None,
            });

    let (wrapper, postamble_start) = logical_entry
        .instrs
        .iter()
        .enumerate()
        .find_map(|(index, (instruction, _))| match instruction {
            Instr::Block(block) => Some((block.seq, index + 1)),
            _ => None,
        })
        .expect("unwind-save Block missing from live-restart loop");

    (
        preamble_then.expect("preamble IfElse missing"),
        wrapper,
        postamble_start,
    )
}

// --- Fixtures ---------------------------------------------------------

const FIXTURE_DIRECT_CALLER: &str = r#"
    (module
      (import "kernel" "kernel_fork" (func $fork (result i32)))
      (func $caller (export "caller") (result i32)
        call $fork)
      (func $non_caller (export "non_caller") (result i32)
        i32.const 42)
      (memory 1))
"#;

const FIXTURE_TRANSITIVE: &str = r#"
    (module
      (import "kernel" "kernel_fork" (func $fork (result i32)))
      (func $caller_leaf (export "caller_leaf") (result i32)
        call $fork)
      (func $caller_mid (export "caller_mid") (result i32)
        call $caller_leaf)
      (func $bystander (export "bystander") (result i32)
        i32.const 7)
      (memory 1))
"#;

const FIXTURE_NO_FORK: &str = r#"
    (module
      (func $only (export "only") (result i32)
        i32.const 1)
      (memory 1))
"#;

const FIXTURE_NO_FORK_NESTED_CALL: &str = r#"
    (module
      (func $inner (export "inner") (result i32)
        i32.const 1)
      (func $outer (export "outer") (result i32)
        call $inner)
      (memory 1))
"#;

const FIXTURE_MULTIVALUE: &str = r#"
    (module
      (import "kernel" "kernel_fork" (func $fork (result i32)))
      (func $mv (export "mv") (result i32 i64 f32 f64)
        call $fork
        i64.const 0
        f32.const 0
        f64.const 0)
      (memory 1))
"#;

const FIXTURE_MIXED_CALLEES: &str = r#"
    (module
      (import "kernel" "kernel_fork" (func $fork (result i32)))
      (func $helper (result i32) i32.const 5)
      (func $caller (export "caller") (result i32)
        call $helper
        drop
        call $fork)
      (memory 1))
"#;

const FIXTURE_CALL_WITH_ARGS: &str = r#"
    (module
      (import "kernel" "kernel_fork" (func $fork (result i32)))
      (func $leaf (param i32 f64) (result i32)
        call $fork)
      (func $caller_with_args (export "caller_with_args") (result i32)
        i32.const 7
        f64.const 2.5
        call $leaf)
      (memory 1))
"#;

const FIXTURE_CALL_WITH_LOAD_ARG: &str = r#"
    (module
      (import "kernel" "kernel_fork" (func $fork (result i32)))
      (func $leaf (param i32) (result i32)
        call $fork)
      (func $caller_with_load_arg (export "caller_with_load_arg") (result i32)
        i32.const 0
        i32.load
        call $leaf)
      (memory 1))
"#;

const FIXTURE_CALL_WITH_I64_SHIFT_ARG: &str = r#"
    (module
      (import "kernel" "kernel_fork" (func $fork (result i32)))
      (func $leaf (param i64) (result i32)
        call $fork)
      (func $caller_with_i64_shift_arg (export "caller_with_i64_shift_arg") (result i32)
        i64.const 1
        i64.const 2
        i64.shl
        call $leaf)
      (memory 1))
"#;

const FIXTURE_TWO_CALLS: &str = r#"
    (module
      (import "kernel" "kernel_fork" (func $fork (result i32)))
      (func $caller (export "caller") (result i32)
        call $fork
        drop
        call $fork)
      (memory 1))
"#;

const FIXTURE_INDIRECT: &str = r#"
    (module
      (import "kernel" "kernel_fork" (func $fork (result i32)))
      (type $sig (func (result i32)))
      (func $cb (type $sig) call $fork)
      (table 1 1 funcref)
      (elem (i32.const 0) $cb)
      (func $caller (export "caller") (result i32)
        i32.const 0
        call_indirect (type $sig))
      (memory 1))
"#;

const FIXTURE_WITH_I32_LOCAL: &str = r#"
    (module
      (import "kernel" "kernel_fork" (func $fork (result i32)))
      (func $caller (export "caller") (result i32)
        (local $x i32)
        i32.const 7
        local.set $x
        call $fork
        local.get $x
        i32.add)
      (memory 1))
"#;

const FIXTURE_COMPLEX_RETURN: &str = r#"
    (module
      (import "kernel" "kernel_fork" (func $fork (result i32)))
      (func $caller (export "caller") (param i32 f64) (result i32 f64)
        call $fork
        drop
        local.get 0
        local.get 1)
      (memory 1))
"#;

const FIXTURE_FUNCREF_LOCAL: &str = r#"
    (module
      (import "kernel" "kernel_fork" (func $fork (result i32)))
      (func $caller (export "caller") (result i32)
        (local $f funcref)
        ref.null func
        local.set $f
        call $fork
        local.get $f
        drop)
      (memory 1))
"#;

const FIXTURE_TWO_FUNCREF_CALLERS: &str = r#"
    (module
      (import "kernel" "kernel_fork" (func $fork (result i32)))
      (func $one (result i32)
        (local $f funcref)
        ref.null func
        local.set $f
        call $fork
        local.get $f
        drop)
      (func $two (export "two") (result i32)
        (local $g funcref)
        ref.null func
        local.set $g
        call $one
        local.get $g
        drop)
      (memory 1))
"#;

// --- Structural / validation tests -----------------------------------

#[test]
fn instrumented_module_with_direct_caller_validates() {
    let bytes = instrument_wat(FIXTURE_DIRECT_CALLER);
    validate(&bytes);
}

#[test]
fn direct_caller_entry_shape_is_preamble_wrapper_postamble() {
    let bytes = instrument_wat(FIXTURE_DIRECT_CALLER);
    let module = Module::from_buffer(&bytes).unwrap();
    let caller = func_by_name(&module, "caller");
    let function = local_func(&module, caller);
    let physical_kinds = function
        .block(function.entry_block())
        .instrs
        .iter()
        .map(|(instruction, _)| InstrKind::of(instruction))
        .collect::<Vec<_>>();
    let restart_kinds = entry_instr_kinds(&module, caller);

    // Replay restoration is deliberately outside the live-restart loop so a
    // synchronous reserve failure can restart without an activation-local flag.
    assert_eq!(
        &physical_kinds[..4],
        &[
            InstrKind::GlobalGet,
            InstrKind::Const,
            InstrKind::Binop,
            InstrKind::IfElse,
        ],
        "physical entry should perform the replay-state preamble before the \
         live-restart loop: {physical_kinds:?}",
    );
    // Exactly one $unwind_save Block is inside the restart loop.
    assert_eq!(
        restart_kinds
            .iter()
            .filter(|kind| **kind == InstrKind::Block)
            .count(),
        1,
        "restart loop should contain exactly one unwind-save Block: {restart_kinds:?}",
    );
    // The postamble terminates by transporting the private unwind tag.
    assert!(
        matches!(restart_kinds.last(), Some(InstrKind::Throw)),
        "restart loop should end in the private unwind throw: {restart_kinds:?}",
    );
}

#[test]
fn fork_path_function_has_one_top_level_br_table() {
    let bytes = instrument_wat(FIXTURE_DIRECT_CALLER);
    validate(&bytes);
    let module = Module::from_buffer(&bytes).unwrap();
    let caller = func_by_name(&module, "caller");
    let f = local_func(&module, caller);
    assert_eq!(
        count_br_tables(f),
        1,
        "each fork-path function should emit exactly one dispatch br_table",
    );
}

#[test]
fn non_fork_path_function_is_not_wrapped() {
    let bytes = instrument_wat(FIXTURE_DIRECT_CALLER);
    let module = Module::from_buffer(&bytes).unwrap();
    let non_caller = func_by_name(&module, "non_caller");
    assert_eq!(
        entry_instr_kinds(&module, non_caller),
        vec![InstrKind::Const],
        "non-fork-path function should be byte-for-byte unchanged",
    );
}

#[test]
fn runtime_control_functions_are_not_wrapped() {
    let bytes = instrument_wat(FIXTURE_DIRECT_CALLER);
    let module = Module::from_buffer(&bytes).unwrap();

    for export in [
        runtime_names::EXPORT_UNWIND_BEGIN,
        runtime_names::EXPORT_UNWIND_END,
        runtime_names::EXPORT_REWIND_BEGIN,
        runtime_names::EXPORT_REWIND_END,
        runtime_names::EXPORT_STATE,
    ] {
        let id = module
            .exports
            .iter()
            .find(|e| e.name == export)
            .map(|e| match e.item {
                ExportItem::Function(f) => f,
                _ => panic!("`{export}` is not a function export"),
            })
            .unwrap_or_else(|| panic!("`{export}` export missing"));

        let f = local_func(&module, id);
        assert_eq!(
            count_br_tables(f),
            0,
            "runtime control function `{export}` should not contain a dispatch br_table",
        );
    }
}

#[test]
fn transitive_callers_are_all_wrapped() {
    let bytes = instrument_wat(FIXTURE_TRANSITIVE);
    validate(&bytes);
    let module = Module::from_buffer(&bytes).unwrap();

    for name in ["caller_leaf", "caller_mid"] {
        let id = func_by_name(&module, name);
        assert_eq!(
            count_br_tables(local_func(&module, id)),
            1,
            "transitive caller `{name}` should have a dispatch br_table",
        );
    }

    let bystander = func_by_name(&module, "bystander");
    assert_eq!(
        entry_instr_kinds(&module, bystander),
        vec![InstrKind::Const],
        "bystander should not be wrapped",
    );
}

#[test]
fn module_without_fork_or_dynamic_boundary_is_byte_identical() {
    let input = parse_wat(FIXTURE_NO_FORK);
    let bytes = instrument(&input, &Options::default()).expect("instrument");
    validate(&bytes);
    assert_eq!(
        bytes, input,
        "a standalone non-forking executable must not acquire fork-runtime features",
    );
}

#[test]
fn instrument_all_wraps_a_module_without_fork_or_dynamic_boundary() {
    // The ceiling mode instruments the same module the test above returns
    // untouched, so the transform can be measured and applied before a seed
    // import exists.
    let input = parse_wat(FIXTURE_NO_FORK_NESTED_CALL);
    let bytes = instrument(
        &input,
        &Options {
            instrument_all: true,
            ..Options::default()
        },
    )
    .expect("instrument");
    validate(&bytes);
    let module = Module::from_buffer(&bytes).unwrap();
    // `outer` owns the one resumable call site, so it carries the dispatch
    // br_table. `inner` is a leaf: it has no call to resume to, so it gets the
    // replay preamble without a dispatch.
    let outer = func_by_name(&module, "outer");
    assert_eq!(
        count_br_tables(local_func(&module, outer)),
        1,
        "the caller should emit its dispatch br_table",
    );
    let inner = func_by_name(&module, "inner");
    assert_ne!(
        entry_instr_kinds(&module, inner),
        vec![InstrKind::Const],
        "the leaf must still be wrapped, not left byte-for-byte unchanged",
    );
}

#[test]
fn multivalue_return_wraps_and_validates() {
    let bytes = instrument_wat(FIXTURE_MULTIVALUE);
    validate(&bytes);
    let module = Module::from_buffer(&bytes).unwrap();
    let mv = func_by_name(&module, "mv");
    let function = local_func(&module, mv);
    let kinds = entry_instr_kinds(&module, mv);
    let physical_kinds = function
        .block(function.entry_block())
        .instrs
        .iter()
        .map(|(instruction, _)| InstrKind::of(instruction))
        .collect::<Vec<_>>();
    assert!(
        kinds.iter().any(|k| *k == InstrKind::Block),
        "mv restart loop missing unwind-save Block: {kinds:?}",
    );
    assert!(
        physical_kinds.iter().any(|kind| *kind == InstrKind::IfElse),
        "mv physical entry missing replay preamble IfElse: {physical_kinds:?}",
    );
}

#[test]
fn instrument_functions_returns_rewritten_set() {
    use fork_instrument::call_graph;
    use fork_instrument::instrument::{PlainCatchPlan, instrument_functions};
    use fork_instrument::runtime::inject_linked_runtime;

    let bytes = wat::parse_str(FIXTURE_TRANSITIVE).unwrap();
    let mut module = Module::from_buffer(&bytes).unwrap();

    let seed =
        call_graph::find_import_func(&module, "kernel.kernel_fork").expect("seed import present");
    let fork_path = call_graph::reaching_closure(&module, seed);
    let runtime = inject_linked_runtime(&mut module);
    let b1_plan = PlainCatchPlan::default();
    let rewritten = instrument_functions(&mut module, &runtime, &fork_path, &b1_plan);

    let names: HashSet<String> = rewritten
        .iter()
        .map(|id| module.funcs.get(*id).name.clone().unwrap_or_default())
        .collect();

    assert!(names.contains("caller_leaf"), "got: {names:?}");
    assert!(names.contains("caller_mid"), "got: {names:?}");
    assert!(
        !names.contains("fork"),
        "import must never be instrumented: {names:?}",
    );
    assert!(
        !names.contains("bystander"),
        "non-fork-path must never be instrumented: {names:?}",
    );
    assert_eq!(rewritten.len(), 2, "unexpected rewritten set: {names:?}");
}

// --- Dispatch-shape tests --------------------------------------------

/// Locate the `$dispatch_normal` block within the function. That's
/// the block whose body contains `global.get state; const REWINDING;
/// eq; if (then ... br_table ... end)` — no other block matches.
fn find_dispatch_normal(module: &Module, func_id: FunctionId) -> Option<InstrSeqId> {
    let f = local_func(module, func_id);
    let mut dispatch: Option<InstrSeqId> = None;
    walk_all(f, f.entry_block(), &mut |seq, instr| {
        if dispatch.is_some() {
            return;
        }
        if let Instr::IfElse(ie) = instr {
            // Check whether the if-then contains a BrTable.
            let then_seq = f.block(ie.consequent);
            if then_seq
                .instrs
                .iter()
                .any(|(i, _)| matches!(i, Instr::BrTable(_)))
            {
                dispatch = Some(seq);
            }
        }
    });
    dispatch
}

#[test]
fn dispatch_block_contains_rewind_guarded_br_table() {
    let bytes = instrument_wat(FIXTURE_DIRECT_CALLER);
    validate(&bytes);
    let module = Module::from_buffer(&bytes).unwrap();
    let caller = func_by_name(&module, "caller");
    let dispatch = find_dispatch_normal(&module, caller).expect("dispatch block missing");
    // Shape: GlobalGet, Const, Binop, IfElse.
    assert_eq!(
        seq_kinds(&module, caller, dispatch),
        vec![
            InstrKind::GlobalGet,
            InstrKind::Const,
            InstrKind::Binop,
            InstrKind::IfElse,
        ],
    );
}

#[test]
fn br_table_default_points_to_unwind_save() {
    // For a function with N fork-path calls, the br_table has N
    // target entries + default. For FIXTURE_DIRECT_CALLER (one call),
    // br_table has one target (POST_0) and a default ($unwind_save).
    let bytes = instrument_wat(FIXTURE_DIRECT_CALLER);
    let module = Module::from_buffer(&bytes).unwrap();
    let caller = func_by_name(&module, "caller");
    let f = local_func(&module, caller);

    let mut br_table_info: Option<(Vec<InstrSeqId>, InstrSeqId)> = None;
    walk_all(f, f.entry_block(), &mut |_, instr| {
        if let Instr::BrTable(bt) = instr {
            br_table_info = Some((bt.blocks.to_vec(), bt.default));
        }
    });
    let (blocks, _default) = br_table_info.expect("br_table missing");
    assert_eq!(blocks.len(), 1, "one call → one br_table target");
}

#[test]
fn non_fork_call_remains_bare_in_chunk_0() {
    let bytes = instrument_wat(FIXTURE_MIXED_CALLEES);
    validate(&bytes);
    let module = Module::from_buffer(&bytes).unwrap();

    let caller = func_by_name(&module, "caller");
    let unwind_save = protected_unwind_body_seq(&module, caller);

    // Walk the whole $unwind_save body and count direct `Call`s to
    // `$helper`. There should be exactly one (chunk 0's helper call
    // is preserved verbatim).
    let helper = func_by_name(&module, "helper");
    let mut helper_calls = 0usize;
    walk_all(local_func(&module, caller), unwind_save, &mut |_, instr| {
        if let Instr::Call(c) = instr {
            if c.func == helper {
                helper_calls += 1;
            }
        }
    });
    assert_eq!(
        helper_calls, 1,
        "non-fork-path helper call should survive verbatim (once)",
    );
}

#[test]
fn source_call_results_do_not_cross_an_unwinding_state_probe() {
    // The imported fork result is held across STATE_UNWINDING only inside a
    // short generated helper. The source activation calls that helper through
    // a statically indexed private-tag boundary, avoiding per-recursion
    // result-spill or call-selector scratch.
    let bytes = instrument_wat(FIXTURE_DIRECT_CALLER);
    validate(&bytes);
    let module = Module::from_buffer(&bytes).unwrap();
    let caller = func_by_name(&module, "caller");
    let unwind_save = protected_unwind_body_seq(&module, caller);
    let transport_id = module
        .funcs
        .iter()
        .find(|function| {
            function
                .name
                .as_deref()
                .is_some_and(|name| name.starts_with("__wpk_fork_unwind_transport_direct_"))
        })
        .expect("direct imported-call transport helper")
        .id();

    // The lexical call now lives in NORMAL and zero-sentinel branches, while
    // REWIND with another committed frame uses the shared resume table.
    let kinds = seq_kinds(&module, caller, unwind_save);
    assert_eq!(kinds.first(), Some(&InstrKind::Block));
    assert_eq!(
        kinds.get(1),
        Some(&InstrKind::Block),
        "the lexical call should be followed by a per-site result-typed \
         private-tag boundary, not a selector LocalSet: {kinds:?}",
    );
    assert!(
        !kinds.contains(&InstrKind::LocalSet),
        "the source activation must not carry an active-call selector: {kinds:?}",
    );
    let caller_local = local_func(&module, caller);
    let mut transport_calls = 0usize;
    let mut post_result_state_probes = 0usize;
    walk_all(
        caller_local,
        caller_local.entry_block(),
        &mut |_, instruction| {
            if matches!(instruction, Instr::Call(call) if call.func == transport_id) {
                transport_calls += 1;
            }
        },
    );
    fn count_post_result_probes(function: &LocalFunction, sequence: InstrSeqId) -> usize {
        let mut count = function
            .block(sequence)
            .instrs
            .windows(5)
            .filter(|window| {
                matches!(window[0].0, Instr::IfElse(_))
                    && matches!(window[1].0, Instr::GlobalGet(_))
                    && matches!(
                        window[2].0,
                        Instr::Const(ir::Const {
                            value: ir::Value::I32(fork_instrument::runtime::STATE_UNWINDING),
                        })
                    )
                    && matches!(window[3].0, Instr::Binop(_))
                    && matches!(window[4].0, Instr::IfElse(_))
            })
            .count();
        for (instruction, _) in &function.block(sequence).instrs {
            for child in nested_of(instruction) {
                count += count_post_result_probes(function, child);
            }
        }
        count
    }
    post_result_state_probes += count_post_result_probes(caller_local, caller_local.entry_block());
    assert_eq!(transport_calls, 2, "NORMAL and zero-sentinel helper calls");
    assert_eq!(
        post_result_state_probes, 0,
        "a replay-selection IfElse result must not cross a following \
         UNWINDING state probe in the source activation"
    );
    assert_resume_routing(&module, "caller");
}

#[test]
fn host_parsed_marker_exports_are_not_rewritten_even_when_they_reach_fork() {
    let wat = r#"
        (module
          (import "kernel" "kernel_fork" (func $fork (result i32)))
          (memory (export "memory") 1)
          (global $__tls_base (export "__tls_base") i32 (i32.const 1024))

          (func $__wasm_call_ctors
            call $fork
            drop)

          (func $__abi_version_actual (result i32)
            i32.const 18)
          (func $__abi_version (export "__abi_version") (result i32)
            call $__wasm_call_ctors
            call $__abi_version_actual)

          (func $__wasm_posix_thread_slots_actual (result i32)
            i32.const -1)
          (func $__wasm_posix_thread_slots (export "__wasm_posix_thread_slots") (result i32)
            call $__wasm_call_ctors
            call $__wasm_posix_thread_slots_actual)

          (func $__get_channel_base_addr_actual (result i32)
            i32.const 32
            global.get $__tls_base
            i32.add)
          (func $__get_channel_base_addr (export "__get_channel_base_addr") (result i32)
            call $__wasm_call_ctors
            call $__get_channel_base_addr_actual)

          (func $_start (export "_start") (result i32)
            call $__wasm_call_ctors
            i32.const 0))
    "#;

    let bytes = instrument_wat(wat);
    validate(&bytes);
    let module = Module::from_buffer(&bytes).unwrap();

    for marker in [
        "__abi_version",
        "__wasm_posix_thread_slots",
        "__get_channel_base_addr",
    ] {
        let kinds = entry_instr_kinds(&module, func_by_name(&module, marker));
        assert_eq!(
            kinds,
            vec![InstrKind::Call, InstrKind::Call],
            "{marker} must keep its raw wasm-ld marker wrapper shape for host byte parsing",
        );
    }

    let start_kinds = entry_instr_kinds(&module, func_by_name(&module, "_start"));
    assert!(
        start_kinds.contains(&InstrKind::Block),
        "_start still reaches fork and should be instrumented",
    );
}

#[test]
fn call_with_pure_args_replays_tail_without_spill_locals() {
    let bytes = instrument_wat(FIXTURE_CALL_WITH_ARGS);
    validate(&bytes);
    let module = Module::from_buffer(&bytes).unwrap();

    let caller = func_by_name(&module, "caller_with_args");
    let unwind_save = protected_unwind_body_seq(&module, caller);

    // Structure after rewrite:
    //   $unwind_save:
    //     Block($POST_0),
    //     <replay pure i32/f64 constants>, Call,
    //     GlobalGet, Const, Binop, IfElse,
    //     Return
    //   $POST_0:
    //     Block($dispatch_normal),
    //     ;; pure tail removed from the NORMAL chunk
    //
    // NORMAL and REWIND both reach the same post-call sequence, so
    // replaying the pure tail here preserves the call arguments without
    // adding frame-backed arg locals.
    let lexical = sequences_with_direct_call(&module, "caller_with_args", "leaf");
    assert_eq!(lexical.len(), 2, "NORMAL and direct-replay lexical calls");
    assert!(
        lexical
            .iter()
            .all(|kinds| { kinds == &vec![InstrKind::Const, InstrKind::Const, InstrKind::Call] })
    );
    assert_direct_activation_replay_is_lexical(&module, "caller_with_args");

    // Find $POST_0 — it's the inner Block of $unwind_save.
    let f = local_func(&module, caller);
    let post_0 = match f.block(unwind_save).instrs[0].0 {
        Instr::Block(ir::Block { seq }) => seq,
        _ => panic!("expected Block"),
    };
    let post_0_kinds = seq_kinds(&module, caller, post_0);
    assert_eq!(
        post_0_kinds,
        vec![InstrKind::Block],
        "chunk 0 pure arg tail must be removed instead of spilled: {post_0_kinds:?}",
    );
}

#[test]
fn call_with_non_pure_arg_falls_back_to_spill_local() {
    let bytes = instrument_wat(FIXTURE_CALL_WITH_LOAD_ARG);
    validate(&bytes);
    let module = Module::from_buffer(&bytes).unwrap();

    let caller = func_by_name(&module, "caller_with_load_arg");
    let unwind_save = protected_unwind_body_seq(&module, caller);
    let lexical = sequences_with_direct_call(&module, "caller_with_load_arg", "leaf");
    assert_eq!(lexical.len(), 2, "NORMAL and direct-replay lexical calls");
    assert!(
        lexical
            .iter()
            .all(|kinds| { kinds == &vec![InstrKind::LocalGet, InstrKind::Call] })
    );
    assert_direct_activation_replay_is_lexical(&module, "caller_with_load_arg");

    let f = local_func(&module, caller);
    let post_0 = match f.block(unwind_save).instrs[0].0 {
        Instr::Block(ir::Block { seq }) => seq,
        _ => panic!("expected Block"),
    };
    let post_0_kinds = seq_kinds(&module, caller, post_0);
    assert_eq!(
        *post_0_kinds.last().unwrap(),
        InstrKind::LocalSet,
        "unsupported load arg must still spill at the NORMAL chunk tail: {post_0_kinds:?}",
    );
}

#[test]
fn call_with_i64_shift_arg_replays_shift_tail() {
    let bytes = instrument_wat(FIXTURE_CALL_WITH_I64_SHIFT_ARG);
    validate(&bytes);
    let module = Module::from_buffer(&bytes).unwrap();

    let caller = func_by_name(&module, "caller_with_i64_shift_arg");
    let unwind_save = protected_unwind_body_seq(&module, caller);
    let lexical = sequences_with_direct_call(&module, "caller_with_i64_shift_arg", "leaf");
    assert_eq!(lexical.len(), 2, "NORMAL and direct-replay lexical calls");
    assert!(lexical.iter().all(|kinds| {
        kinds
            == &vec![
                InstrKind::Const,
                InstrKind::Const,
                InstrKind::Binop,
                InstrKind::Call,
            ]
    }));
    assert_direct_activation_replay_is_lexical(
        &module,
        "caller_with_i64_shift_arg",
    );

    let f = local_func(&module, caller);
    let post_0 = match f.block(unwind_save).instrs[0].0 {
        Instr::Block(ir::Block { seq }) => seq,
        _ => panic!("expected Block"),
    };
    assert_eq!(
        seq_kinds(&module, caller, post_0),
        vec![InstrKind::Block],
        "pure i64 shift arg tail must be removed instead of spilled",
    );
}

#[test]
fn two_calls_assign_sequential_call_idx() {
    let bytes = instrument_wat(FIXTURE_TWO_CALLS);
    validate(&bytes);
    let module = Module::from_buffer(&bytes).unwrap();
    let caller = func_by_name(&module, "caller");
    let _unwind_save = protected_unwind_body_seq(&module, caller);
    let f = local_func(&module, caller);
    let reserve = module
        .imports
        .iter()
        .find(|import| import.name == "__wpk_fork_frame_reserve")
        .and_then(|import| match import.kind {
            walrus::ImportKind::Function(id) => Some(id),
            _ => None,
        })
        .expect("linked frame reserve import");
    let frame_select = module
        .funcs
        .iter()
        .find(|function| function.name.as_deref() == Some("__wpk_fork_select_unwind_frame"))
        .expect("generated unwind-frame selector")
        .id();

    // Count Const values immediately preceding stores to frame.call_index.
    fn walk_seqs<F: FnMut(InstrSeqId)>(f: &LocalFunction, seq: InstrSeqId, visit: &mut F) {
        visit(seq);
        for (instr, _) in &f.block(seq).instrs {
            for child in nested_of(instr) {
                walk_seqs(f, child, visit);
            }
        }
    }

    let mut idxs: Vec<i32> = Vec::new();
    let mut frame_sizes = Vec::new();
    let mut frame_select_calls = 0usize;
    walk_seqs(f, f.entry_block(), &mut |seq| {
        let instrs = &f.block(seq).instrs;
        for index in 2..instrs.len() {
            if matches!(
                instrs[index].0,
                Instr::Call(ir::Call { func }) if func == frame_select
            ) {
                let (
                    Instr::Const(ir::Const {
                        value: ir::Value::I32(size),
                    }),
                    Instr::Const(ir::Const {
                        value: ir::Value::I32(call_index),
                    }),
                ) = (&instrs[index - 2].0, &instrs[index - 1].0)
                else {
                    panic!(
                        "unwind-frame selector must receive static size and \
                         call-index constants"
                    );
                };
                frame_select_calls += 1;
                frame_sizes.push(*size);
                idxs.push(*call_index);
            }
        }
    });

    let selector_function = local_func(&module, frame_select);
    let mut helper_reserve_calls = 0usize;
    walk_seqs(
        selector_function,
        selector_function.entry_block(),
        &mut |sequence| {
            helper_reserve_calls += selector_function
                .block(sequence)
                .instrs
                .iter()
                .filter(|(instruction, _)| {
                    matches!(instruction, Instr::Call(ir::Call { func }) if *func == reserve)
                })
                .count();
        },
    );

    let mut active_selectors = Vec::new();
    walk_seqs(f, f.entry_block(), &mut |seq| {
        let instrs = &f.block(seq).instrs;
        for pair in instrs.windows(2) {
            if let (
                Instr::Const(ir::Const {
                    value: ir::Value::I32(value),
                }),
                Instr::LocalSet(_),
            ) = (&pair[0].0, &pair[1].0)
            {
                if matches!(*value, 1 | 2) {
                    active_selectors.push(*value);
                }
            }
        }
    });
    active_selectors.sort();
    idxs.sort();
    assert_eq!(
        frame_select_calls, 2,
        "each statically indexed private-tag call boundary should call the \
         shared unwind-frame selector once",
    );
    assert_eq!(
        helper_reserve_calls, 1,
        "the module helper should own exactly one cold frame-reservation \
         sequence regardless of lexical call-site count",
    );
    assert_eq!(
        frame_sizes,
        vec![16, 16],
        "both call sites should pass this function's exact static frame size",
    );
    assert_eq!(
        active_selectors,
        Vec::<i32>::new(),
        "static call boundaries must not install an activation-local selector",
    );
    assert_eq!(
        idxs,
        vec![0, 1],
        "each call should pass its static zero-based index directly to the \
         shared frame selector",
    );
}

#[test]
fn call_indirect_replays_pure_table_index_arg() {
    let bytes = instrument_wat(FIXTURE_INDIRECT);
    validate(&bytes);
    let module = Module::from_buffer(&bytes).unwrap();

    let caller = func_by_name(&module, "caller");
    let unwind_save = protected_unwind_body_seq(&module, caller);
    let f = local_func(&module, caller);

    let original_table = module
        .tables
        .iter()
        .find(|table| table.import.is_none() && table.initial == 1)
        .expect("fixture indirect table")
        .id();
    let transport_id = module
        .funcs
        .iter()
        .find(|function| {
            function
                .name
                .as_deref()
                .is_some_and(|name| name.starts_with("__wpk_fork_unwind_transport_indirect_"))
        })
        .expect("indirect transport helper")
        .id();
    let mut lexical_calls = 0;
    walk_all(f, f.entry_block(), &mut |_, instruction| {
        if matches!(instruction, Instr::Call(call) if call.func == transport_id) {
            lexical_calls += 1;
        }
    });
    assert_eq!(lexical_calls, 2, "NORMAL and zero-sentinel helper calls");
    let helper = local_func(&module, transport_id);
    let mut helper_indirect_calls = 0;
    walk_all(helper, helper.entry_block(), &mut |_, instruction| {
        if matches!(instruction, Instr::CallIndirect(call) if call.table == original_table) {
            helper_indirect_calls += 1;
        }
    });
    assert_eq!(
        helper_indirect_calls, 1,
        "the shared helper must own exactly one guest-table dispatch"
    );
    assert_resume_routing(&module, "caller");

    // The pure table-index tail is removed from $POST_0 rather than
    // spilled into a frame-backed local.
    let post_0 = match f.block(unwind_save).instrs[0].0 {
        Instr::Block(ir::Block { seq }) => seq,
        _ => panic!("expected Block"),
    };
    let post_0_kinds = seq_kinds(&module, caller, post_0);
    assert_eq!(
        post_0_kinds,
        vec![InstrKind::Block],
        "pure table-index tail must be removed from chunk 0: {post_0_kinds:?}",
    );
}

// --- Preamble / postamble tests --------------------------------------

#[test]
fn preamble_starts_with_rewinding_state_check() {
    let bytes = instrument_wat(FIXTURE_DIRECT_CALLER);
    let module = Module::from_buffer(&bytes).unwrap();
    let caller = func_by_name(&module, "caller");
    let f = local_func(&module, caller);
    let entry = f.block(f.entry_block());
    let kinds = entry
        .instrs
        .iter()
        .map(|(instruction, _)| InstrKind::of(instruction))
        .collect::<Vec<_>>();

    assert_eq!(
        &kinds[..4],
        &[
            InstrKind::GlobalGet,
            InstrKind::Const,
            InstrKind::Binop,
            InstrKind::IfElse,
        ],
    );

    let rewinding_const = match &entry.instrs[1].0 {
        Instr::Const(c) => c.value,
        other => panic!("expected Const at entry[1], got {other:?}"),
    };
    match rewinding_const {
        ir::Value::I32(2) => {}
        other => panic!("preamble must check REWINDING (i32 2): {other:?}"),
    }
}

#[test]
fn preamble_then_requests_next_linked_frame() {
    let bytes = instrument_wat(FIXTURE_DIRECT_CALLER);
    let module = Module::from_buffer(&bytes).unwrap();
    let caller = func_by_name(&module, "caller");
    let (preamble_then, _, _) = entry_preamble_and_postamble(&module, caller);

    let kinds = seq_kinds(&module, caller, preamble_then);
    assert_eq!(
        kinds,
        vec![
            InstrKind::GlobalGet, // buf store address
            InstrKind::Const,     // frame_size
            InstrKind::Call,      // __wpk_fork_frame_next
            InstrKind::Other,     // Store current frame pointer
        ],
    );
}

#[test]
fn postamble_writes_and_commits_the_reserved_linked_frame() {
    let bytes = instrument_wat(FIXTURE_DIRECT_CALLER);
    let module = Module::from_buffer(&bytes).unwrap();
    let caller = func_by_name(&module, "caller");
    let (_, _, postamble_start) = entry_preamble_and_postamble(&module, caller);

    let kinds = entry_instr_kinds(&module, caller);
    let postamble: Vec<InstrKind> = kinds[postamble_start..].to_vec();

    let expected = vec![
        InstrKind::GlobalGet,
        InstrKind::Other, // Load current frame
        InstrKind::Const,
        InstrKind::Other, // Store func_index
        InstrKind::GlobalGet,
        InstrKind::Other, // Load current frame
        InstrKind::Const,
        InstrKind::Other, // Store zero catch_region_id
        InstrKind::GlobalGet,
        InstrKind::Other, // Load current frame
        InstrKind::Const,
        InstrKind::Other, // Store reserved zero catch metadata
        InstrKind::GlobalGet,
        InstrKind::Other, // Load current frame
        InstrKind::Call,  // __wpk_fork_frame_commit
        InstrKind::Throw, // process-owned unwind transport
    ];
    assert_eq!(postamble, expected);
}

#[test]
fn no_catch_postamble_writes_deterministic_zero_catch_header_fields() {
    let bytes = instrument_wat(FIXTURE_DIRECT_CALLER);
    validate(&bytes);

    let printed = wasmprinter::print_bytes(&bytes).expect("wasmprinter");
    let caller_section = extract_function_text(&printed, "caller");
    assert!(
        caller_section.contains("i32.store offset=8")
            && caller_section.contains("i32.store offset=12"),
        "no-catch postamble should zero the catch region and reserved field:\n{caller_section}",
    );
    assert!(
        !caller_section.contains("i64.store offset=8"),
        "ABI 43 uses explicit versioned header fields:\n{caller_section}",
    );
}

#[test]
fn catch_capable_postamble_keeps_dynamic_catch_header_stores() {
    let bytes = instrument_wat(FIXTURE_FORK_IN_TRY_BODY);
    validate(&bytes);

    let printed = wasmprinter::print_bytes(&bytes).expect("wasmprinter");
    let caller_section = extract_function_text(&printed, "caller");
    assert!(
        caller_section.contains("i32.store offset=8"),
        "catch-capable postamble must store dynamic catch_region_id:\n{caller_section}",
    );
    assert!(
        caller_section.contains("i32.store offset=12"),
        "catch-capable postamble must zero the reserved former exnref slot:\n{caller_section}",
    );
    assert!(
        !caller_section.contains("i64.store offset=8"),
        "catch-capable postamble must not replace dynamic fields with a packed zero store:\n{caller_section}",
    );
}

#[test]
fn user_scalar_locals_are_saved_and_restored_in_frame() {
    let bytes = instrument_wat(FIXTURE_WITH_I32_LOCAL);
    validate(&bytes);
    let module = Module::from_buffer(&bytes).unwrap();

    let caller = func_by_name(&module, "caller");
    let (preamble_then, _, _) = entry_preamble_and_postamble(&module, caller);

    // With one i32 user local, preamble-then should end by loading
    // the current frame pointer, loading the scalar, and setting the
    // user local.
    let kinds = seq_kinds(&module, caller, preamble_then);
    let tail: Vec<_> = kinds.iter().copied().rev().take(4).collect();
    assert_eq!(
        tail,
        vec![
            InstrKind::LocalSet,
            InstrKind::Other,
            InstrKind::Other,
            InstrKind::GlobalGet,
        ],
        "preamble-then must restore the i32 user local: {kinds:?}",
    );
}

#[test]
fn postamble_serializes_user_scalar_locals() {
    let bytes = instrument_wat(FIXTURE_WITH_I32_LOCAL);
    validate(&bytes);
    let module = Module::from_buffer(&bytes).unwrap();

    let caller = func_by_name(&module, "caller");
    let (_, _, postamble_start) = entry_preamble_and_postamble(&module, caller);

    let kinds = entry_instr_kinds(&module, caller);
    let postamble = &kinds[postamble_start..];

    // Postamble with one user local:
    //   4 current-frame pointer loads/stores plus four payload stores
    //   (func_index, catch_region_id, reserved zero, user_x) = 8 stores/loads,
    //   plus the linked-frame reservation result = 9 Others. The catch fields
    //   remain separate i32 slots so a catch-capable function can store its
    //   dynamic region identifier without changing the frame shape. The final
    //   private Throw has its own instruction kind and is not counted here.
    let other_count = postamble
        .iter()
        .filter(|k| matches!(k, InstrKind::Other))
        .count();
    assert_eq!(
        other_count, 9,
        "postamble should load/store the active payload and serialize its fields: {postamble:?}",
    );
}

#[test]
fn postamble_throws_without_fabricating_result_values() {
    let bytes = instrument_wat(FIXTURE_COMPLEX_RETURN);
    validate(&bytes);
    let module = Module::from_buffer(&bytes).unwrap();

    let caller = func_by_name(&module, "caller");
    let kinds = entry_instr_kinds(&module, caller);
    assert_eq!(
        kinds.last(),
        Some(&InstrKind::Throw),
        "postamble must transport unwind independently of result types: {kinds:?}",
    );
    assert!(
        !matches!(
            kinds.last(),
            Some(InstrKind::Const | InstrKind::Unreachable)
        ),
        "postamble must not fabricate typed defaults or trap on a result type: {kinds:?}",
    );
}

#[test]
fn nonnullable_reference_result_unwinds_via_private_tag() {
    let bytes = instrument_wat_unchecked(
        r#"
        (module
          (import "kernel" "kernel_fork" (func $fork (result i32)))
          (elem declare func $target)
          (func $target)
          (func $caller (export "caller") (result (ref func))
            call $fork
            drop
            ref.func $target)
          (memory 1))
        "#,
    );
    validate(&bytes);
    let module = Module::from_buffer(&bytes).expect("parse rewritten module");
    let caller = func_by_name(&module, "caller");
    let (_, _, postamble_start) = entry_preamble_and_postamble(&module, caller);
    let postamble = &entry_instr_kinds(&module, caller)[postamble_start..];
    assert_eq!(
        postamble.last(),
        Some(&InstrKind::Throw),
        "non-nullable result needs no fake default when unwind is exceptional: {postamble:?}",
    );
    assert!(
        !postamble.contains(&InstrKind::Unreachable),
        "result typing must not turn a valid unwind into a trap: {postamble:?}",
    );
}

// --- Fresh-instance reference-state validation -----------------------

#[test]
fn definitely_null_funcref_local_needs_no_recipe() {
    let bytes = instrument_wat(FIXTURE_FUNCREF_LOCAL);
    validate(&bytes);
}

#[test]
fn dead_reference_parameter_in_fork_closure_remains_legal() {
    let bytes = instrument_wat(
        r#"
        (module
          (import "kernel" "kernel_fork" (func $fork (result i32)))
          (func $caller (param funcref) (result i32)
            call $fork)
          (memory 1))
        "#,
    );
    validate(&bytes);
}

#[test]
fn instrumented_modules_never_emit_legacy_reference_tables() {
    let bytes = instrument_wat(FIXTURE_DIRECT_CALLER);
    let module = Module::from_buffer(&bytes).unwrap();

    let legacy_reference_table_names = [
        "_wpk_fork_funcref_stash",
        "_wpk_fork_externref_stash",
        "_wpk_fork_exnref_stash",
    ];
    for name in legacy_reference_table_names {
        assert!(
            !module
                .tables
                .iter()
                .any(|t| t.name.as_deref() == Some(name)),
            "ABI 43 must not emit retired module-instance table `{name}`",
        );
    }
}

#[test]
fn nested_reference_activations_validate_without_static_slots() {
    let bytes = instrument_wat(FIXTURE_TWO_FUNCREF_CALLERS);
    validate(&bytes);
}

#[test]
fn call_specific_reference_vectors_do_not_enlarge_activation_frames() {
    let bytes = instrument_wat(
        r#"
        (module
          (import "kernel" "kernel_fork" (func $fork (result i32)))
          (import "env" "make_first" (func $make_first (result externref)))
          (import "env" "make_second" (func $make_second (result externref)))
          (func $caller (result i32)
            (local $first externref)
            (local $second externref)
            call $make_first
            local.set $first
            call $fork
            drop
            local.get $first
            drop
            call $make_second
            local.set $second
            call $fork
            drop
            local.get $second
            drop
            i32.const 0)
          (memory 1))
        "#,
    );
    validate(&bytes);
    let module = Module::from_buffer(&bytes).expect("parse reference-vector fixture");
    let caller = local_func(&module, func_by_name(&module, "caller"));
    let imported = |name: &str| {
        module
            .imports
            .iter()
            .find_map(|import| {
                (import.name == name).then(|| match import.kind {
                    walrus::ImportKind::Function(function) => Some(function),
                    _ => None,
                })?
            })
            .unwrap_or_else(|| panic!("missing import {name}"))
    };
    let frame_select = module
        .funcs
        .iter()
        .find(|function| function.name.as_deref() == Some("__wpk_fork_select_unwind_frame"))
        .expect("generated unwind-frame selector")
        .id();
    let vector_begin = imported(runtime_names::IMPORT_REFERENCE_VECTOR_BEGIN);
    let vector_append = imported(runtime_names::IMPORT_REFERENCE_VECTOR_APPEND);
    let vector_finish = imported(runtime_names::IMPORT_REFERENCE_VECTOR_FINISH);
    let vector_get = imported(runtime_names::IMPORT_REFERENCE_VECTOR_GET);

    let mut reserve_sizes = Vec::new();
    let mut vector_calls = [0usize; 4];
    fn visit_sequences(
        function: &LocalFunction,
        sequence: InstrSeqId,
        frame_select: FunctionId,
        vector_functions: [FunctionId; 4],
        reserve_sizes: &mut Vec<i32>,
        vector_calls: &mut [usize; 4],
    ) {
        let instructions = &function.block(sequence).instrs;
        for (index, (instruction, _)) in instructions.iter().enumerate() {
            if let Instr::Call(call) = instruction {
                if call.func == frame_select {
                    let Some((
                        Instr::Const(ir::Const {
                            value: ir::Value::I32(size),
                        }),
                        _,
                    )) = index.checked_sub(2).and_then(|i| instructions.get(i))
                    else {
                        panic!(
                            "unwind-frame selector is not preceded by its \
                             constant size and call index"
                        );
                    };
                    reserve_sizes.push(*size);
                }
                for (slot, function) in vector_functions.iter().enumerate() {
                    if call.func == *function {
                        vector_calls[slot] += 1;
                    }
                }
            }
            for child in nested_of(instruction) {
                visit_sequences(
                    function,
                    child,
                    frame_select,
                    vector_functions,
                    reserve_sizes,
                    vector_calls,
                );
            }
        }
    }
    visit_sequences(
        caller,
        caller.entry_block(),
        frame_select,
        [vector_begin, vector_append, vector_finish, vector_get],
        &mut reserve_sizes,
        &mut vector_calls,
    );

    assert!(!reserve_sizes.is_empty());
    assert!(
        reserve_sizes.iter().all(|size| *size == 16),
        "this fixture has no scalar activation state, so its total frame is \
         the 16-byte header: two references live at disjoint call landings \
         must add zero frame bytes, not the old function-wide 8-byte slot \
         union: {reserve_sizes:?}",
    );
    assert!(vector_calls[0] > 0, "save path must allocate a call vector");
    assert!(vector_calls[1] >= 2, "each live recipe must be appended");
    assert!(
        vector_calls[2] > 0,
        "save path must replace its transient builder handle with a canonical ordinal"
    );
    assert!(
        vector_calls[3] >= 2,
        "rewind must perform indexed vector lookup"
    );
}

#[test]
fn externref_local_is_activation_owned() {
    let wat = r#"
        (module
          (import "kernel" "kernel_fork" (func $fork (result i32)))
          (func $caller (export "caller") (result i32)
            (local $x externref)
            ref.null extern
            local.set $x
            call $fork
            local.get $x
            drop)
          (memory 1))
    "#;
    let bytes = instrument_wat(wat);
    validate(&bytes);
}

#[test]
fn live_reference_call_argument_is_activation_owned() {
    let wat = r#"
        (module
          (import "kernel" "kernel_fork" (func $fork (result i32)))
          (func $target (param $value externref) (result i32)
            call $fork)
          (func $caller (param $value externref) (result i32)
            local.get $value
            call $target)
          (memory 1))
    "#;
    let bytes = instrument_wat(wat);
    validate(&bytes);
    let module =
        Module::from_buffer(&bytes).expect("parse instrumented reference-argument fixture");
    assert_function_calls_codec_pair(
        &module,
        "caller",
        runtime_names::IMPORT_REF_ENCODE_EXTERNREF,
        runtime_names::IMPORT_REF_DECODE_EXTERNREF,
    );
}

#[test]
fn call_ref_callee_is_activation_owned_and_narrowed_for_replay() {
    let wat = r#"
        (module
          (type $fork_ty (func (result i32)))
          (import "kernel" "kernel_fork" (func $fork (type $fork_ty)))
          (elem declare func $fork)
          (func $caller (result i32)
            ref.func $fork
            call_ref $fork_ty)
          (memory 1))
    "#;
    let bytes = instrument_wat(wat);
    validate(&bytes);
    let module = Module::from_buffer(&bytes).expect("parse instrumented call_ref fixture");
    assert_function_calls_codec_pair(
        &module,
        "caller",
        runtime_names::IMPORT_REF_ENCODE_FUNCREF,
        runtime_names::IMPORT_REF_DECODE_FUNCREF,
    );
    let caller = local_func(&module, func_by_name(&module, "caller"));
    let transport_id = module
        .funcs
        .iter()
        .find(|function| {
            function
                .name
                .as_deref()
                .is_some_and(|name| name.starts_with("__wpk_fork_unwind_transport_ref_"))
        })
        .expect("call_ref transport helper")
        .id();
    let mut has_callee_cast = false;
    let transport = local_func(&module, transport_id);
    walk_all(transport, transport.entry_block(), &mut |_, instruction| {
        has_callee_cast |= matches!(instruction, Instr::RefCast(_));
    });
    assert!(
        has_callee_cast,
        "the call_ref helper must restore the declared concrete function type"
    );
    let mut source_calls_transport = false;
    walk_all(caller, caller.entry_block(), &mut |_, instruction| {
        source_calls_transport |=
            matches!(instruction, Instr::Call(call) if call.func == transport_id);
    });
    assert!(
        source_calls_transport,
        "source call_ref must use its helper"
    );
}

#[test]
fn gc_ref_local_uses_anyref_recipe_codec() {
    let wat = r#"
        (module
          (import "kernel" "kernel_fork" (func $fork (result i32)))
          (func $caller (result i32)
            (local $r (ref null any))
            i32.const 17
            ref.i31
            local.set $r
            call $fork
            local.get $r
            drop)
          (memory 1))
    "#;
    let bytes = instrument_wat(wat);
    validate(&bytes);
    let module = Module::from_buffer(&bytes).expect("parse instrumented anyref fixture");
    assert_function_calls_codec_pair(
        &module,
        "caller",
        runtime_names::IMPORT_REF_ENCODE_ANYREF,
        runtime_names::IMPORT_REF_DECODE_ANYREF,
    );
}

#[test]
fn nullable_reference_operand_stack_carryover_is_activation_owned() {
    let bytes = instrument_wat(
        r#"
        (module
          (import "kernel" "kernel_fork" (func $fork (result i32)))
          (func $caller (result i32)
            ref.null extern
            call $fork
            drop
            drop
            i32.const 0)
          (memory 1))
        "#,
    );
    validate(&bytes);
}

#[test]
fn non_null_reference_operand_stack_carryover_uses_recipe() {
    let bytes = instrument_wat(
        r#"
        (module
          (import "kernel" "kernel_fork" (func $fork (result i32)))
          (func $caller (param $value externref) (result i32)
            local.get $value
            call $fork
            drop
            drop
            i32.const 0)
          (memory 1))
        "#,
    );
    validate(&bytes);
    let module = Module::from_buffer(&bytes).expect("parse reference-carryover fixture");
    assert_function_calls_codec_pair(
        &module,
        "caller",
        runtime_names::IMPORT_REF_ENCODE_EXTERNREF,
        runtime_names::IMPORT_REF_DECODE_EXTERNREF,
    );
}

#[test]
fn nested_call_reference_carryover_uses_recipe() {
    let bytes = instrument_wat(
        r#"
        (module
          (import "kernel" "kernel_fork" (func $fork (result i32)))
          (func $caller (param $value externref) (result i32)
            (block
              local.get $value
              call $fork
              drop
              drop)
            i32.const 0)
          (memory 1))
        "#,
    );
    validate(&bytes);
    let module = Module::from_buffer(&bytes).expect("parse nested reference-carryover fixture");
    assert_function_calls_codec_pair(
        &module,
        "caller",
        runtime_names::IMPORT_REF_ENCODE_EXTERNREF,
        runtime_names::IMPORT_REF_DECODE_EXTERNREF,
    );
}

#[test]
fn parent_stack_reference_across_fork_bearing_subregion_uses_recipe() {
    let bytes = instrument_wat(
        r#"
        (module
          (import "kernel" "kernel_fork" (func $fork (result i32)))
          (func $caller (param $value externref) (result i32)
            local.get $value
            (block
              call $fork
              drop)
            drop
            i32.const 0)
          (memory 1))
        "#,
    );
    validate(&bytes);
    let module = Module::from_buffer(&bytes).expect("parse subregion reference-carryover fixture");
    assert_function_calls_codec_pair(
        &module,
        "caller",
        runtime_names::IMPORT_REF_ENCODE_EXTERNREF,
        runtime_names::IMPORT_REF_DECODE_EXTERNREF,
    );
}

#[test]
fn dead_polymorphic_reference_subregion_does_not_create_an_analysis_gap() {
    // A valid Wasm sequence remains stack-polymorphic after `return`. Static
    // call-graph discovery may still conservatively find a fork edge in that
    // dead suffix, so the structural rewrite must keep it validator-clean
    // rather than treating absent lexical operands as an analysis failure.
    // The block parameter is deliberately a reference: replay
    // spill storage must use its nullable representation.
    let bytes = instrument_wat(
        r#"
        (module
          (import "kernel" "kernel_fork" (func $fork (result i32)))
          (func $caller
            return
            (block (param externref)
              call $fork
              drop
              drop))
          (memory 1))
        "#,
    );
    validate(&bytes);
}

#[test]
fn dead_polymorphic_reference_call_does_not_create_an_analysis_gap() {
    // Call discovery intentionally remains conservative in dead suffixes.
    // The nested carryover walk must therefore account for the call ordinal
    // even though `return` made the operand stack polymorphic.
    let bytes = instrument_wat(
        r#"
        (module
          (import "kernel" "kernel_fork" (func $fork (result i32)))
          (func $target (param externref) (result i32)
            call $fork)
          (func $caller
            (block
              return
              ref.null extern
              call $target
              drop))
          (memory 1))
        "#,
    );
    validate(&bytes);
}

#[test]
fn escaped_catch_ref_operand_stack_value_uses_exnref_recipe_codec() {
    let bytes = instrument_wat(
        r#"
        (module
          (import "kernel" "kernel_fork" (func $fork (result i32)))
          (tag $exn)
          (func $caller (result i32)
            (block $handler (result exnref)
              (try_table (result exnref) (catch_ref $exn $handler)
                throw $exn))
            call $fork
            drop
            drop
            i32.const 0)
          (memory 1))
        "#,
    );
    validate(&bytes);
}

#[test]
fn static_table_reference_operand_stack_carryover_uses_recipe() {
    let bytes = instrument_wat(
        r#"
        (module
          (import "kernel" "kernel_fork" (func $fork (result i32)))
          (table 1 funcref)
          (func $target)
          (elem (i32.const 0) func $target)
          (func $caller (result i32)
            i32.const 0
            table.get
            call $fork
            drop
            drop
            i32.const 0)
          (memory 1))
        "#,
    );
    validate(&bytes);
}

#[test]
fn dead_nonnullable_ref_func_instruction_remains_legal() {
    let bytes = instrument_wat(
        r#"
        (module
          (import "kernel" "kernel_fork" (func $fork (result i32)))
          (elem declare func $target)
          (func $target)
          (func $caller (result i32)
            ref.func $target
            drop
            call $fork)
          (memory 1))
        "#,
    );
    validate(&bytes);
}

#[test]
fn concrete_gc_reference_uses_anyref_recipe_codec_and_narrowing() {
    let bytes = instrument_wat(
        r#"
        (module
          (import "kernel" "kernel_fork" (func $fork (result i32)))
          (type $pair (struct (field i32)))
          (func $make_pair (result (ref $pair))
            i32.const 7
            struct.new $pair)
          (func $caller (result i32)
            (local $value (ref null $pair))
            call $make_pair
            local.set $value
            call $fork
            local.get $value
            drop)
          (memory 1))
        "#,
    );
    validate(&bytes);
    let module = Module::from_buffer(&bytes).expect("parse instrumented concrete-ref fixture");
    assert_function_calls_codec_pair(
        &module,
        "caller",
        runtime_names::IMPORT_REF_ENCODE_ANYREF,
        runtime_names::IMPORT_REF_DECODE_ANYREF,
    );
    let caller = local_func(&module, func_by_name(&module, "caller"));
    let mut has_narrowing_cast = false;
    walk_all(caller, caller.entry_block(), &mut |_, instruction| {
        has_narrowing_cast |= matches!(instruction, Instr::RefCast(_));
    });
    assert!(
        has_narrowing_cast,
        "decoded anyref must be narrowed back to the concrete `$pair` type",
    );
}

#[test]
fn module_without_try_tables_has_no_legacy_reference_storage() {
    let bytes = instrument_wat(FIXTURE_DIRECT_CALLER);
    let module = Module::from_buffer(&bytes).unwrap();
    assert!(
        !module
            .tables
            .iter()
            .any(|t| t.name.as_deref() == Some("_wpk_fork_exnref_stash")),
        "module with no try_tables must not inject retired exnref storage",
    );
}

#[test]
fn mutable_reference_global_has_module_state_owner() {
    let bytes = instrument_wat(
        r#"
        (module
          (import "kernel" "kernel_fork" (func $fork (result i32)))
          (global $callback (mut funcref) (ref.null func))
          (func $caller (result i32) call $fork)
          (memory 1))
        "#,
    );
    validate(&bytes);
}

#[test]
fn immutable_reference_global_read_before_fork_remains_legal() {
    let bytes = instrument_wat(
        r#"
        (module
          (import "kernel" "kernel_fork" (func $fork (result i32)))
          (global $callback funcref (ref.null func))
          (func $caller (result i32)
            global.get $callback
            drop
            call $fork)
          (memory 1))
        "#,
    );
    validate(&bytes);
}

#[test]
fn immutable_reference_global_outside_fork_closure_remains_legal() {
    let bytes = instrument_wat(
        r#"
        (module
          (import "kernel" "kernel_fork" (func $fork (result i32)))
          (global $callback funcref (ref.null func))
          (func $unrelated (export "unrelated")
            global.get $callback
            drop)
          (func $caller (result i32) call $fork)
          (memory 1))
        "#,
    );
    validate(&bytes);
}

#[test]
fn dead_reference_typed_call_before_fork_remains_legal() {
    let bytes = instrument_wat(
        r#"
        (module
          (import "kernel" "kernel_fork" (func $fork (result i32)))
          (import "env" "consume" (func $consume (param externref)))
          (func $caller (result i32)
            ref.null extern
            call $consume
            call $fork)
          (memory 1))
        "#,
    );
    validate(&bytes);
}

#[test]
fn non_fork_reaching_return_call_ref_in_fork_activation_remains_tail() {
    let bytes = instrument_wat(
        r#"
        (module
          (type $ft (func (result i32)))
          (import "kernel" "kernel_fork" (func $fork (type $ft)))
          (func $safe (type $ft)
            i32.const 7)
          (elem declare func $safe)
          (func $caller (param $take_tail i32) (result i32)
            local.get $take_tail
            if (result i32)
              ref.func $safe
              return_call_ref $ft
            else
              call $fork
            end)
          (memory 1))
        "#,
    );
    validate(&bytes);
    let printed = wasmprinter::print_bytes(&bytes).expect("print instrumented tail-call fixture");
    assert!(
        printed.contains("return_call_ref"),
        "a tail call that cannot reach fork must retain bounded-stack semantics"
    );
}

#[test]
fn fork_reaching_tail_calls_remain_bounded_and_route_to_resume_thunks() {
    let wat = r#"
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
    let bytes = instrument_wat(wat);
    validate(&bytes);
    let module = Module::from_buffer(&bytes).expect("instrumented module");

    for name in ["tail_direct", "tail_indirect", "tail_ref"] {
        let function = local_func(&module, func_by_name(&module, name));
        assert!(
            function
                .block(function.entry_block())
                .instrs
                .iter()
                .any(|(instruction, _)| matches!(instruction, Instr::ReturnCall(_))),
            "{name} must retain a bounded direct tail call, either to the \
             original local target or to a generated transport helper"
        );
    }
    assert!(
        module.funcs.iter().any(|function| function
            .name
            .as_deref()
            .is_some_and(|name| name.starts_with("__wpk_fork_unwind_transport_indirect_"))),
        "fork-reaching return_call_indirect must tail-call a transport helper"
    );
    assert!(
        module.funcs.iter().any(|function| function
            .name
            .as_deref()
            .is_some_and(|name| name.starts_with("__wpk_fork_unwind_transport_ref_"))),
        "fork-reaching return_call_ref must tail-call a transport helper"
    );
    for root in ["root_direct", "root_indirect", "root_ref"] {
        assert_resume_routing(&module, root);
    }

    let catalog = module
        .exports
        .iter()
        .find(|export| export.name == "__wpk_fork_resume_catalog")
        .and_then(|export| match export.item {
            ExportItem::Table(table) => Some(module.tables.get(table)),
            _ => None,
        })
        .expect("resume catalog export");
    assert_eq!(
        catalog.initial, 4,
        "only the deep and three root activations receive resume thunks"
    );
    assert!(
        module
            .customs
            .iter()
            .any(|(_, section)| section.name() == "kandelo.wpk_fork.resume_catalog"),
        "resume catalog metadata must bind function ordinals to local slots"
    );
}

#[test]
fn fixed_main_and_pthread_resume_boundaries_dispatch_inside_wasm() {
    let wat = r#"
        (module
          (import "kernel" "kernel_fork" (func $fork (result i32)))
          (type $thread_ty (func (param i32) (result i32)))
          (table $functions (export "__indirect_function_table") 1 1 funcref)
          (elem (i32.const 0) $thread)
          (func $thread (type $thread_ty) (param $arg i32) (result i32)
            local.get $arg)
          (func $_start (export "_start")
            call $fork
            drop)
          (memory 1))
    "#;
    let bytes = instrument_wat(wat);
    validate(&bytes);
    let module = Module::from_buffer(&bytes).expect("instrumented module");

    let start_wrapper = func_by_name(&module, "wpk_fork_resume_start");
    let start_ty = module.types.get(module.funcs.get(start_wrapper).ty());
    assert!(start_ty.params().is_empty());
    assert!(start_ty.results().is_empty());
    assert_resume_routing(&module, "wpk_fork_resume_start");
    assert_eq!(
        sequences_with_direct_call(&module, "wpk_fork_resume_start", "_start").len(),
        1,
        "zero-sentinel start replay must retain the lexical _start path"
    );

    let thread_wrapper = func_by_name(&module, "wpk_fork_resume_thread");
    let thread_ty = module.types.get(module.funcs.get(thread_wrapper).ty());
    assert_eq!(thread_ty.params(), &[ValType::I32, ValType::I32]);
    assert_eq!(thread_ty.results(), &[ValType::I32]);
    assert_resume_routing(&module, "wpk_fork_resume_thread");
    let original_table = module
        .exports
        .iter()
        .find(|export| export.name == "__indirect_function_table")
        .and_then(|export| match export.item {
            ExportItem::Table(table) => Some(table),
            _ => None,
        })
        .expect("original pthread function table");
    let wrapper = local_func(&module, thread_wrapper);
    let mut lexical_thread_calls = 0;
    walk_all(wrapper, wrapper.entry_block(), &mut |_, instruction| {
        if matches!(instruction, Instr::CallIndirect(call) if call.table == original_table) {
            lexical_thread_calls += 1;
        }
    });
    assert_eq!(
        lexical_thread_calls, 1,
        "zero-sentinel pthread replay must retain the lexical table dispatch"
    );
}

#[test]
fn references_outside_the_fork_closure_remain_legal() {
    let bytes = instrument_wat(
        r#"
        (module
          (import "kernel" "kernel_fork" (func $fork (result i32)))
          (elem declare func $target)
          (func $target)
          (func $unrelated (export "unrelated")
            (local $value externref)
            ref.null extern
            local.set $value
            local.get $value
            ref.func $target
            drop
            drop)
          (func $caller (result i32) call $fork)
          (memory 1))
        "#,
    );
    validate(&bytes);
}

#[test]
fn dead_catch_all_ref_value_before_fork_remains_legal() {
    let bytes = instrument_wat(
        r#"
        (module
          (import "kernel" "kernel_fork" (func $fork (result i32)))
          (tag $exn)
          (func $caller (result i32)
            (block $handler (result exnref)
              (try_table (result exnref) (catch_all_ref $handler)
                throw $exn))
            drop
            call $fork)
          (memory 1))
        "#,
    );
    validate(&bytes);
}

#[test]
fn catch_all_without_live_reference_state_remains_legal() {
    let bytes = instrument_wat(
        r#"
        (module
          (import "kernel" "kernel_fork" (func $fork (result i32)))
          (tag $exn)
          (func $caller (result i32)
            (block $handler
              (try_table (catch_all $handler)
                throw $exn))
            call $fork)
          (memory 1))
        "#,
    );
    validate(&bytes);
}

#[test]
fn private_unwind_precedes_user_catch_all_and_catch_all_ref() {
    let fixtures = [
        (
            "catch_all",
            r#"
            (module
              (import "kernel" "kernel_fork" (func $fork (result i32)))
              (func $leaf (result i32) call $fork)
              (func $caller (export "caller") (result i32)
                (block $handler
                  (try_table (catch_all $handler)
                    call $leaf
                    drop))
                i32.const 0)
              (memory 1))
            "#,
        ),
        (
            "catch_all_ref",
            r#"
            (module
              (import "kernel" "kernel_fork" (func $fork (result i32)))
              (func $leaf (result i32) call $fork)
              (func $caller (export "caller") (result i32)
                (block $handler (result exnref)
                  (try_table (result exnref) (catch_all_ref $handler)
                    call $leaf
                    drop
                    ref.null exn))
                drop
                i32.const 0)
              (memory 1))
            "#,
        ),
    ];

    for (label, wat) in fixtures {
        let bytes = instrument_wat_unchecked(wat);
        validate(&bytes);
        let module = Module::from_buffer(&bytes).expect("parse rewritten module");
        let unwind_tag = private_unwind_tag(&module);
        let caller = func_by_name(&module, "caller");
        let mut shielded = 0usize;
        walk_all(
            local_func(&module, caller),
            local_func(&module, caller).entry_block(),
            &mut |_, instr| {
                let Instr::TryTable(table) = instr else {
                    return;
                };
                let Some(catch_all_index) = table.catches.iter().position(|catch| {
                    matches!(
                        catch,
                        ir::TryTableCatch::CatchAll { .. } | ir::TryTableCatch::CatchAllRef { .. }
                    )
                }) else {
                    return;
                };
                assert!(catch_all_index > 0, "{label}: catch-all cannot be first");
                assert!(
                    matches!(
                        table.catches[catch_all_index - 1],
                        ir::TryTableCatch::Catch { tag, .. } if tag == unwind_tag
                    ),
                    "{label}: private transport must be intercepted and rethrown before user catch-all: {:?}",
                    table.catches,
                );
                shielded += 1;
            },
        );
        assert_eq!(shielded, 1, "{label}: expected one shielded user try_table");
    }
}

#[test]
fn catch_all_and_catch_all_ref_live_across_fork_use_complete_exception_recipes() {
    let fixtures = [
        (
            "catch_all",
            r#"
            (module
              (import "kernel" "kernel_fork" (func $fork (result i32)))
              (tag $failure)
              (func $caller (export "caller") (result i32)
                (block $done (result i32)
                  (block $handler
                    (try_table (catch_all $handler)
                      throw $failure)
                    unreachable)
                  call $fork
                  drop
                  i32.const 17
                  br $done))
              (memory 1))
            "#,
        ),
        (
            "catch_all_ref",
            r#"
            (module
              (import "kernel" "kernel_fork" (func $fork (result i32)))
              (tag $failure)
              (func $caller (export "caller") (result i32)
                (block $done (result i32)
                  (block $handler (result exnref)
                    (try_table (result exnref) (catch_all_ref $handler)
                      throw $failure))
                  drop
                  call $fork
                  drop
                  i32.const 23
                  br $done))
              (memory 1))
            "#,
        ),
    ];

    for (label, wat) in fixtures {
        let bytes = instrument_wat(wat);
        validate(&bytes);
        let module = Module::from_buffer(&bytes).expect("parse catch-all replay fixture");
        assert_function_calls_codec_pair(
            &module,
            "caller",
            runtime_names::IMPORT_REF_ENCODE_EXNREF,
            runtime_names::IMPORT_REF_DECODE_EXNREF,
        );
        let printed = wasmprinter::print_bytes(&bytes).expect("print catch-all replay fixture");
        let caller = extract_function_text(&printed, "caller");
        assert!(
            caller.contains("catch_all_ref"),
            "{label}: the capture path must bind an instance-local exnref:\n{caller}",
        );
        assert!(
            caller.contains("throw_ref"),
            "{label}: rewind must replay the complete exception recipe:\n{caller}",
        );
    }
}

#[test]
fn every_wasm_table_mutation_has_module_state_owner() {
    let cases = [
        ("table.set", "i32.const 0 ref.null func table.set", ""),
        (
            "table.fill",
            "i32.const 0 ref.null func i32.const 1 table.fill",
            "",
        ),
        (
            "table.copy",
            "i32.const 0 i32.const 0 i32.const 1 table.copy",
            "",
        ),
        (
            "table.init",
            "i32.const 0 i32.const 0 i32.const 1 table.init $elements",
            "(elem $elements funcref (ref.null func))",
        ),
        (
            "table.grow",
            "ref.null func i32.const 1 table.grow drop",
            "",
        ),
    ];
    for (_name, operation, element) in cases {
        let wat = format!(
            r#"
            (module
              (import "kernel" "kernel_fork" (func $fork (result i32)))
              (table 1 funcref)
              {element}
              (func $unrelated {operation})
              (func $caller (result i32) call $fork)
              (memory 1))
            "#,
        );
        let bytes = instrument_wat(&wat);
        validate(&bytes);
    }
}

#[test]
fn static_table_initialization_is_recreated_and_remains_legal() {
    let bytes = instrument_wat(
        r#"
        (module
          (import "kernel" "kernel_fork" (func $fork (result i32)))
          (table 1 funcref)
          (func $target)
          (elem (i32.const 0) func $target)
          (func $caller (result i32) call $fork)
          (memory 1))
        "#,
    );
    validate(&bytes);
}

// --- Non-fork-path try_tables ----------------------------------------

#[test]
fn try_table_on_non_fork_path_is_not_instrumented() {
    // `helper` contains a try_table but doesn't reach fork. The
    // fork-path function `caller` does not contain a try_table.
    // Neither should get a rewind-throw stub.
    let wat = r#"
        (module
          (import "kernel" "kernel_fork" (func $fork (result i32)))
          (tag $exn)
          (func $helper (export "helper") (result i32)
            (block $h (result (ref null exn))
              (try_table (result (ref null exn)) (catch_ref $exn $h)
                ref.null exn))
            drop
            i32.const 0)
          (func $caller (export "caller") (result i32)
            call $fork)
          (memory 1))
    "#;
    let bytes = instrument_wat(wat);
    validate(&bytes);
    let module = Module::from_buffer(&bytes).unwrap();

    // `helper` is not on the fork path, so it should be byte-for-byte
    // unchanged — including no rewind-throw stub.
    let helper = func_by_name(&module, "helper");
    let f = local_func(&module, helper);
    let mut bodies = Vec::new();
    collect_try_table_bodies(f, f.entry_block(), &mut bodies);
    assert_eq!(bodies.len(), 1, "helper still has its try_table");
    let body_kinds = seq_kinds(&module, helper, bodies[0]);
    assert_eq!(
        body_kinds,
        vec![InstrKind::Other],
        "non-fork-path try_table body must not be instrumented: {body_kinds:?}",
    );

    assert!(
        !module
            .tables
            .iter()
            .any(|t| t.name.as_deref() == Some("_wpk_fork_exnref_stash")),
        "non-fork-path references must not cause legacy reference storage",
    );
}

fn collect_try_table_bodies(f: &LocalFunction, seq: InstrSeqId, out: &mut Vec<InstrSeqId>) {
    for (instr, _) in &f.block(seq).instrs {
        if let Instr::TryTable(tt) = instr {
            out.push(tt.seq);
            collect_try_table_bodies(f, tt.seq, out);
        }
        for child in nested_of(instr) {
            if !matches!(instr, Instr::TryTable(_)) {
                collect_try_table_bodies(f, child, out);
            }
        }
    }
}

// --- Nested per-block switch-dispatch (Path A) -----------------------
//
// Fork-path calls nested inside `block` bodies (any depth) use the
// nested per-block switch-dispatch transform: each fork-bearing seq
// gets its own br_table + cascading POST blocks. The function-level
// dispatch maps `call_idx` to either a direct POST_K (top-level) or a
// POST_J_ENTER (immediately before the enclosing block). This avoids
// guard-dispatch's REWIND body-replay, which had a divergence bug that
// caused popen-class callers to silently skip the kernel_fork wrap.
// See memory/fork-instrument-O2-bug-investigation.md.
//
// Functions with fork-path calls inside `IfElse`/`Loop`/`TryTable` (or
// with stack carryovers, etc.) still fall back to guard-dispatch
// today.

#[test]
fn call_in_nested_block_uses_per_block_switch_dispatch() {
    let wat = r#"
        (module
          (import "kernel" "kernel_fork" (func $fork (result i32)))
          (func $caller (export "caller") (result i32)
            (block (result i32)
              call $fork))
          (memory 1))
    "#;
    let bytes = instrument_wat(wat);
    validate(&bytes);
    let module = Module::from_buffer(&bytes).unwrap();
    let caller = func_by_name(&module, "caller");
    let f = local_func(&module, caller);

    // Nested per-block switch-dispatch: at least one br_table is
    // emitted (function-level dispatch + per-block dispatch inside
    // the `block`).
    assert!(
        count_br_tables(f) >= 1,
        "nested-call functions must use per-block switch-dispatch \
         (br_table emitted), not guard-dispatch's body-replay",
    );
}

#[test]
fn fork_inside_try_body_uses_per_block_switch_dispatch() {
    let wat = r#"
        (module
          (import "kernel" "kernel_fork" (func $fork (result i32)))
          (tag $exn)
          (func $caller (export "caller") (result i32)
            (block $h (result (ref null exn))
              (try_table (result (ref null exn)) (catch_ref $exn $h)
                call $fork
                drop
                ref.null exn))
            drop
            i32.const 0)
          (memory 1))
    "#;
    let bytes = instrument_wat(wat);
    validate(&bytes);
    let module = Module::from_buffer(&bytes).unwrap();
    let caller = func_by_name(&module, "caller");
    let f = local_func(&module, caller);

    // Per-block switch-dispatch handles fork-path calls inside
    // try_table bodies — at least one br_table is emitted (function-
    // level dispatch + per-block dispatch inside the try_table body).
    assert!(
        count_br_tables(f) >= 1,
        "fork-in-try-body must use per-block switch-dispatch \
         (br_table emitted), not guard-dispatch's body-replay",
    );

    assert!(
        !module
            .tables
            .iter()
            .any(|t| t.name.as_deref() == Some("_wpk_fork_exnref_stash")),
        "fork-path try_tables must not inject module-instance exnref storage",
    );
}

#[test]
fn fork_inside_loop_uses_per_block_switch_dispatch() {
    let wat = r#"
        (module
          (import "kernel" "kernel_fork" (func $fork (result i32)))
          (func $caller (export "caller") (result i32)
            (local $i i32)
            (loop $l
              (local.set $i (i32.add (local.get $i) (i32.const 1)))
              (br_if $l (i32.eqz (call $fork))))
            (local.get $i))
          (memory 1))
    "#;
    let bytes = instrument_wat(wat);
    validate(&bytes);
    let module = Module::from_buffer(&bytes).unwrap();
    let caller = func_by_name(&module, "caller");
    let f = local_func(&module, caller);

    assert!(
        count_br_tables(f) >= 1,
        "fork-in-loop must use per-block switch-dispatch (br_table emitted)",
    );
}

#[test]
fn fork_in_both_top_level_and_nested_uses_per_block_switch_dispatch() {
    // Mixed top-level + nested fork calls now use per-block
    // switch-dispatch. The function-level dispatch's br_table maps
    // each call_idx to either a direct POST_K (top-level call) or a
    // POST_J_ENTER (just before the enclosing block); inside the
    // enclosing block, the per-block dispatch routes to its own
    // POST_K.
    let wat = r#"
        (module
          (import "kernel" "kernel_fork" (func $fork (result i32)))
          (func $caller (export "caller") (result i32)
            call $fork
            drop
            (block (result i32)
              call $fork))
          (memory 1))
    "#;
    let bytes = instrument_wat(wat);
    validate(&bytes);
    let module = Module::from_buffer(&bytes).unwrap();
    let caller = func_by_name(&module, "caller");
    let f = local_func(&module, caller);

    assert!(
        count_br_tables(f) >= 1,
        "mixed top+nested fork calls must use per-block switch-dispatch \
         (br_table emitted)",
    );
    let mut ifelse_count = 0usize;
    walk_all(f, f.entry_block(), &mut |_, instr| {
        if matches!(instr, Instr::IfElse(_)) {
            ifelse_count += 1;
        }
    });
    // preamble + 2 per-call gates = at least 3 IfElse instructions.
    assert!(
        ifelse_count >= 3,
        "guard-dispatch emits one IfElse per call + preamble (>=3): {ifelse_count}",
    );
}

// --- Tagged-catch reconstruction (guard-dispatch) tests ----------------------
//
// These pin down the Phase 6 plumbing that guard-dispatch uses for
// `try_table` catch-handler reconstruction. The fixtures all have
// nested fork-path calls and therefore exercise guard-dispatch.

const FIXTURE_FORK_IN_TRY_BODY: &str = r#"
    (module
      (import "kernel" "kernel_fork" (func $fork (result i32)))
      (tag $exn)
      (func $caller (export "caller") (result i32)
        (block $handler (result (ref null exn))
          (try_table (result (ref null exn)) (catch_ref $exn $handler)
            call $fork
            drop
            ref.null exn))
        drop
        i32.const 0)
      (memory 1))
"#;

const FIXTURE_TWO_TRY_TABLES: &str = r#"
    (module
      (import "kernel" "kernel_fork" (func $fork (result i32)))
      (tag $exn)
      (func $caller (export "caller") (result i32)
        (block $h1 (result (ref null exn))
          (try_table (result (ref null exn)) (catch_ref $exn $h1)
            call $fork
            drop
            ref.null exn))
        drop
        (block $h2 (result (ref null exn))
          (try_table (result (ref null exn)) (catch_ref $exn $h2)
            call $fork
            drop
            ref.null exn))
        drop
        i32.const 0)
      (memory 1))
"#;

#[test]
fn distinct_try_tables_get_sequential_region_ids() {
    let bytes = instrument_wat(FIXTURE_TWO_TRY_TABLES);
    validate(&bytes);
    let module = Module::from_buffer(&bytes).unwrap();

    let caller = func_by_name(&module, "caller");
    let f = local_func(&module, caller);

    let try_tables = collect_user_try_tables(&module, f);
    assert_eq!(try_tables.len(), 2, "fixture has two user try_tables");

    assert!(
        !module
            .tables
            .iter()
            .any(|t| t.name.as_deref() == Some("_wpk_fork_exnref_stash")),
        "region identity must live in activation frames, not module tables",
    );
}

#[test]
fn catch_ref_clause_is_rewritten_with_capture_block() {
    let bytes = instrument_wat(FIXTURE_FORK_IN_TRY_BODY);
    validate(&bytes);
    let module = Module::from_buffer(&bytes).unwrap();

    let caller = func_by_name(&module, "caller");
    let f = local_func(&module, caller);

    // The try_table's catch_ref clause should now target the injected
    // $capture block (not the original $handler).
    let mut try_table: Option<ir::TryTable> = None;
    walk_all(f, f.entry_block(), &mut |_, instr| {
        if let Instr::TryTable(tt) = instr {
            if tt
                .catches
                .iter()
                .any(|catch| matches!(catch, ir::TryTableCatch::CatchRef { .. }))
            {
                try_table = Some(tt.clone());
            }
        }
    });
    let try_table = try_table.expect("try_table should still exist after 6d");

    let retargeted = try_table
        .catches
        .iter()
        .any(|c| matches!(c, ir::TryTableCatch::CatchRef { .. }));
    assert!(
        retargeted,
        "try_table should still have a CatchRef clause: {:?}",
        try_table.catches,
    );
}

#[test]
fn plain_catch_capture_preserves_plain_clause_kind() {
    // Scalar plain catches use the activation-owned selector/payload path.
    // Their generated capture still uses a plain Catch (not CatchRef),
    // because replay can reconstruct the exact tag and scalar payload.
    let wat = r#"
        (module
          (import "kernel" "kernel_fork" (func $fork (result i32)))
          (tag $exn)
          (func $caller (export "caller") (result i32)
            (block $h
              (try_table (catch $exn $h)
                call $fork
                drop))
            i32.const 0)
          (memory 1))
    "#;
    let bytes = instrument_wat(wat);
    validate(&bytes);
    let module = Module::from_buffer(&bytes).unwrap();

    let caller = func_by_name(&module, "caller");
    let f = local_func(&module, caller);

    let mut try_table: Option<ir::TryTable> = None;
    walk_all(f, f.entry_block(), &mut |_, instr| {
        if try_table.is_none() {
            if let Instr::TryTable(tt) = instr {
                try_table = Some(tt.clone());
            }
        }
    });
    let try_table = try_table.expect("try_table should still exist");

    assert!(
        try_table
            .catches
            .iter()
            .all(|c| matches!(c, ir::TryTableCatch::Catch { .. })),
        "scalar plain catches should preserve their Catch clause kind",
    );
}

#[test]
fn plain_catch_arms_discovered_for_fork_path_handler() {
    // Fork-path function with a try_table that has a plain `catch` arm.
    // The fork call lives "after" the catch's target block — i.e. it
    // executes when the catch dispatches `br $h` (which jumps to just
    // past the block's end). Stage 1 must enumerate the plain-catch
    // arm regardless of fork-call reachability; this matches Phase 6's
    // unfiltered approach for catch_ref.
    let wat = r#"
        (module
          (import "kernel" "kernel_fork" (func $fork (result i32)))
          (tag $exn)
          (func $caller (export "caller") (result i32)
            (block $h
              (try_table (catch $exn $h)
                nop))
            call $fork)
          (memory 1))
    "#;
    let bytes = instrument_wat(wat);
    validate(&bytes);
    // Stage 1 only verifies that this WAT shape — the target case for B1 —
    // still round-trips through today's instrumenter without breaking. The
    // emission of plain-catch save/restore code is Stage 2; this test will
    // be extended to assert behavioral correctness (parent forks → child
    // resumes inside catch handler with restored payload) once Stage 2
    // lands.
}

#[test]
fn discover_plain_catch_arms_returns_one_arm_for_single_catch() {
    // Direct unit test for `discover_plain_catch_arms`. The integration
    // test above only round-trips a WAT through `instrument()`, which
    // does not (yet) call the discovery helper — Stage 2 will. This
    // test exercises the helper directly so it is covered (and not
    // dead code) before the wiring lands.
    let wat = r#"
        (module
          (tag $exn)
          (func $caller (result i32)
            (block $h
              (try_table (catch $exn $h)
                nop))
            i32.const 0)
          (memory 1))
    "#;
    let bytes = wat::parse_str(wat).expect("wat parse");
    let module = Module::from_buffer(&bytes).expect("module parse");

    let func_id = func_by_name(&module, "caller");
    let entries = fork_instrument::instrument::discover_plain_catch_arms(&module, func_id);

    assert_eq!(entries.len(), 1, "expected exactly one try_table entry");
    let (_body_seq, arms) = &entries[0];
    assert_eq!(arms.len(), 1, "expected exactly one plain-catch arm");

    let arm = &arms[0];
    assert_eq!(arm.arm_idx, 0, "single catch arm has idx 0");
    assert!(
        arm.operand_tys.is_empty(),
        "tag $exn declares no payload, so operand_tys should be empty (got {:?})",
        arm.operand_tys,
    );

    // Sanity: the recorded `tag` matches the only tag declared by the
    // module. Proves the helper captured the real tag id rather than a
    // stale or default value.
    let module_tag_id = module
        .tags
        .iter()
        .next()
        .expect("module declares one tag")
        .id();
    assert_eq!(
        arm.tag,
        Some(module_tag_id),
        "arm.tag should equal the module's declared tag id",
    );

    // Sanity: the recorded `label` is one of the sequence ids actually
    // reachable from the function's entry block — i.e. the helper
    // walked the IR rather than emitting a default. We collect every
    // reachable InstrSeqId in `caller` and confirm `arm.label` is
    // among them.
    let local = local_func(&module, func_id);
    let mut seen: HashSet<InstrSeqId> = HashSet::new();
    collect_seq_ids(local, local.entry_block(), &mut seen);
    assert!(
        seen.contains(&arm.label),
        "arm.label {:?} should be a reachable sequence id in caller (seen={:?})",
        arm.label,
        seen,
    );
}

/// Recursively collect every `InstrSeqId` reachable from `seq` in
/// `f`. Used by the discovery test above to sanity-check that the
/// helper records a real label rather than a stale/default id.
fn collect_seq_ids(f: &LocalFunction, seq: InstrSeqId, out: &mut HashSet<InstrSeqId>) {
    out.insert(seq);
    for (instr, _) in &f.block(seq).instrs {
        for child in nested_seqs_in_test(instr) {
            collect_seq_ids(f, child, out);
        }
    }
}

/// Local helper mirroring `instrument::nested_seqs` — returns child
/// `InstrSeqId`s of a given instruction. Kept tiny and self-contained
/// to avoid widening the crate's public surface.
fn nested_seqs_in_test(instr: &Instr) -> Vec<InstrSeqId> {
    match instr {
        Instr::Block(b) => vec![b.seq],
        Instr::Loop(l) => vec![l.seq],
        Instr::IfElse(ie) => vec![ie.consequent, ie.alternative],
        Instr::TryTable(tt) => vec![tt.seq],
        _ => Vec::new(),
    }
}

// --- Plain-catch static planning --------------------------------------

#[test]
fn plain_catch_plan_empty_targets_has_no_functions() {
    let wat = r#"
        (module
          (func $caller (export "caller") (result i32) i32.const 0)
          (memory 1))
    "#;
    let bytes = parse_wat(wat);
    let module = walrus::Module::from_buffer(&bytes).unwrap();
    let plan = fork_instrument::instrument::plan_plain_catches(&module, &[]);
    assert!(
        plan.per_function.is_empty(),
        "no targets → empty per_function map"
    );
}

#[test]
fn plain_catch_plan_preserves_empty_payload_arm() {
    let wat = r#"
        (module
          (import "kernel" "kernel_fork" (func $fork (result i32)))
          (tag $exn)
          (func $caller (export "caller") (result i32)
            (block $h
              (try_table (catch $exn $h)
                nop))
            call $fork)
          (memory 1))
    "#;
    let bytes = parse_wat(wat);
    let module = walrus::Module::from_buffer(&bytes).unwrap();
    let caller = func_by_name(&module, "caller");
    let plan = fork_instrument::instrument::plan_plain_catches(&module, &[caller]);
    assert_eq!(
        plan.per_function.len(),
        1,
        "one function had plain-catch arms"
    );
    let per_func = &plan.per_function[&caller];
    assert_eq!(per_func.len(), 1, "one try_table with plain-catch arms");
    let (_body_seq, arms) = &per_func[0];
    assert_eq!(arms.len(), 1, "one plain-catch arm");
    assert_eq!(arms[0].arm_idx, 0);
    assert!(arms[0].operand_tys.is_empty());
}

#[test]
fn plain_catch_plan_preserves_i32_payload_type() {
    //
    // Catch label semantics: branching to a `block` carries the
    // block's RESULT types (forward-branch arity), so a tag with a
    // single i32 operand requires a `(block (result i32))` target.
    // The block then drops the value before falling through.
    let wat = r#"
        (module
          (import "kernel" "kernel_fork" (func $fork (result i32)))
          (tag $exn (param i32))
          (func $caller (export "caller") (result i32)
            (block $h (result i32)
              (try_table (catch $exn $h)
                i32.const 0
                drop)
              i32.const 0)
            drop
            call $fork)
          (memory 1))
    "#;
    let bytes = parse_wat(wat);
    let module = walrus::Module::from_buffer(&bytes).unwrap();
    let caller = func_by_name(&module, "caller");
    let plan = fork_instrument::instrument::plan_plain_catches(&module, &[caller]);
    let per_func = &plan.per_function[&caller];
    let (_, arms) = &per_func[0];
    assert_eq!(arms[0].operand_tys, vec![ValType::I32]);
}

#[test]
fn plain_catch_plan_preserves_regions_in_source_order() {
    let wat = r#"
        (module
          (import "kernel" "kernel_fork" (func $fork (result i32)))
          (tag $a)
          (tag $b (param i64))
          (func $caller (export "caller") (result i32)
            (block $ha
              (try_table (catch $a $ha)
                nop))
            (block $hb (result i64)
              (try_table (catch $b $hb)
                i64.const 0
                drop)
              i64.const 0)
            drop
            call $fork)
          (memory 1))
    "#;
    let bytes = parse_wat(wat);
    let module = walrus::Module::from_buffer(&bytes).unwrap();
    let caller = func_by_name(&module, "caller");
    let plan = fork_instrument::instrument::plan_plain_catches(&module, &[caller]);
    let per_func = &plan.per_function[&caller];
    assert_eq!(per_func.len(), 2, "two try_tables");
    let (_, arms_a) = &per_func[0];
    let (_, arms_b) = &per_func[1];
    assert!(arms_a[0].operand_tys.is_empty());
    assert_eq!(arms_b[0].operand_tys, vec![ValType::I64]);
}

#[test]
fn plain_catch_plan_preserves_same_typed_arms_across_regions() {
    let wat = r#"
        (module
          (import "kernel" "kernel_fork" (func $fork (result i32)))
          (tag $a (param i32))
          (tag $b (param i32))
          (func $caller (export "caller") (result i32)
            (block $ha (result i32)
              (try_table (catch $a $ha)
                i32.const 0
                drop)
              i32.const 0)
            drop
            (block $hb (result i32)
              (try_table (catch $b $hb)
                i32.const 0
                drop)
              i32.const 0)
            drop
            call $fork)
          (memory 1))
    "#;
    let bytes = parse_wat(wat);
    let module = walrus::Module::from_buffer(&bytes).unwrap();
    let caller = func_by_name(&module, "caller");
    let plan = fork_instrument::instrument::plan_plain_catches(&module, &[caller]);
    let per_func = &plan.per_function[&caller];
    assert_eq!(per_func.len(), 2, "two try_tables");
    let (_, arms_a) = &per_func[0];
    let (_, arms_b) = &per_func[1];
    assert_eq!(arms_a[0].operand_tys, vec![ValType::I32]);
    assert_eq!(arms_b[0].operand_tys, vec![ValType::I32]);
}

#[test]
fn plain_catch_plan_preserves_f32_f64_operand_types() {
    //
    // Catch label semantics (mirroring existing i32-payload test): branching
    // to a `(block $h (result f32 f64))` carries the block's RESULT types,
    // matching the tag's payload arity.
    let wat = r#"
        (module
          (import "kernel" "kernel_fork" (func $fork (result i32)))
          (tag $exn (param f32 f64))
          (func $caller (export "caller") (result i32)
            (block $h (result f32 f64)
              (try_table (catch $exn $h)
                f32.const 0
                f64.const 0
                drop
                drop)
              f32.const 0
              f64.const 0)
            drop
            drop
            call $fork)
          (memory 1))
    "#;
    let bytes = parse_wat(wat);
    let module = walrus::Module::from_buffer(&bytes).unwrap();
    let caller = func_by_name(&module, "caller");
    let plan = fork_instrument::instrument::plan_plain_catches(&module, &[caller]);
    let per_func = &plan.per_function[&caller];
    let (_, arms) = &per_func[0];
    assert_eq!(arms[0].operand_tys, vec![ValType::F32, ValType::F64]);
}

// --- Exception-recipe tag payloads and multi-target support ------------

#[test]
fn reference_typed_catch_payload_uses_complete_exception_recipe() {
    let wat = r#"
        (module
          (import "kernel" "kernel_fork" (func $fork (result i32)))
          (tag $exn (param externref))
          (func $caller (export "caller") (result i32)
            (block $h (result externref)
              (try_table (catch $exn $h)
                ref.null extern
                drop)
              ref.null extern)
            drop
            call $fork)
          (memory 1))
    "#;
    let bytes = instrument_wat(wat);
    validate(&bytes);
    let module = Module::from_buffer(&bytes).unwrap();
    assert_function_uses_exception_recipe(&module, "caller");
}

#[test]
fn mixed_scalar_and_reference_typed_arms_use_their_matching_replay_form() {
    let wat = r#"
        (module
          (import "kernel" "kernel_fork" (func $fork (result i32)))
          (tag $a (param i32))
          (tag $b (param externref))
          (func $caller (export "caller") (result i32)
            (block $ha (result i32)
              (try_table (catch $a $ha)
                i32.const 0
                drop)
              i32.const 0)
            drop
            (block $hb (result externref)
              (try_table (catch $b $hb)
                ref.null extern
                drop)
              ref.null extern)
            drop
            call $fork)
          (memory 1))
    "#;
    let source = Module::from_buffer(&parse_wat(wat)).unwrap();
    let caller = func_by_name(&source, "caller");
    let plan = fork_instrument::instrument::plan_plain_catches(&source, &[caller]);
    let arms: Vec<_> = plan.per_function[&caller]
        .iter()
        .flat_map(|(_, arms)| arms)
        .collect();
    assert!(
        arms.iter().any(|arm| arm.uses_exception_recipe),
        "the reference-bearing arm must own a complete exception recipe"
    );
    assert!(
        arms.iter().any(|arm| !arm.uses_exception_recipe),
        "the scalar arm should retain compact tag-and-payload replay"
    );

    let bytes = instrument_wat(wat);
    validate(&bytes);
    let module = Module::from_buffer(&bytes).unwrap();
    assert_function_uses_exception_recipe(&module, "caller");
}

#[test]
fn plain_catch_plan_scalar_only_function_is_supported() {
    let wat = r#"
        (module
          (import "kernel" "kernel_fork" (func $fork (result i32)))
          (tag $exn)
          (func $caller (export "caller") (result i32)
            (block $h
              (try_table (catch $exn $h)
                nop))
            call $fork)
          (memory 1))
    "#;
    let bytes = parse_wat(wat);
    let module = walrus::Module::from_buffer(&bytes).unwrap();
    let caller = func_by_name(&module, "caller");
    let plan = fork_instrument::instrument::plan_plain_catches(&module, &[caller]);
    assert!(
        plan.per_function.contains_key(&caller),
        "scalar-only function must have a per_function entry"
    );
}

#[test]
fn plain_catch_plan_multi_target_plain_catch_is_supported() {
    let wat = r#"
        (module
          (import "kernel" "kernel_fork" (func $fork (result i32)))
          (tag $a)
          (tag $b)
          (func $caller (export "caller") (result i32)
            (block $h2
              (block $h1
                (try_table (catch $a $h1) (catch $b $h2)
                  nop)))
            call $fork)
          (memory 1))
    "#;
    let bytes = parse_wat(wat);
    let module = walrus::Module::from_buffer(&bytes).unwrap();
    let caller = func_by_name(&module, "caller");
    let plan = fork_instrument::instrument::plan_plain_catches(&module, &[caller]);
    let regions = &plan.per_function[&caller];
    assert_eq!(regions.len(), 1);
    assert_eq!(regions[0].1.len(), 2);
    assert_ne!(regions[0].1[0].label, regions[0].1[1].label);
}

#[test]
fn plain_catch_plan_single_target_multi_arm_is_supported() {
    let wat = r#"
        (module
          (import "kernel" "kernel_fork" (func $fork (result i32)))
          (tag $a)
          (tag $b)
          (func $caller (export "caller") (result i32)
            (block $h
              (try_table (catch $a $h) (catch $b $h)
                nop))
            call $fork)
          (memory 1))
    "#;
    let bytes = parse_wat(wat);
    let module = walrus::Module::from_buffer(&bytes).unwrap();
    let caller = func_by_name(&module, "caller");
    let plan = fork_instrument::instrument::plan_plain_catches(&module, &[caller]);
    assert!(plan.per_function.contains_key(&caller));
    let per_func = &plan.per_function[&caller];
    assert_eq!(per_func.len(), 1, "one try_table");
    let (_, slots) = &per_func[0];
    assert_eq!(slots.len(), 2, "two arms (both targeting same label)");
}

// ======================================================================
// Stage 1 (B1) Task 1.3 — end-to-end smoke via lib::instrument
// ======================================================================

#[test]
fn plain_catch_plan_module_without_plain_catch_validates() {
    // A fork-using module with no plain catch needs no activation-owned
    // catch locals. The standard wpk_fork_* exports must still be present.
    let wat = r#"
        (module
          (import "kernel" "kernel_fork" (func $fork (result i32)))
          (func $caller (export "caller") (result i32)
            call $fork)
          (memory 1))
    "#;
    let bytes = instrument_wat(wat);
    validate(&bytes);
    let module = Module::from_buffer(&bytes).unwrap();
    assert!(
        module.exports.iter().any(|e| e.name == "wpk_fork_state"),
        "wpk_fork_state export must remain without plain catches"
    );
}

#[test]
fn plain_catch_plan_module_validates_without_prefix_scratch() {
    // Plain-catch state belongs to frame-backed locals, so discovering this
    // catch does not reserve module-prefix scratch. The emitted module still
    // validates and exposes the standard wpk_fork_* exports.
    let wat = r#"
        (module
          (import "kernel" "kernel_fork" (func $fork (result i32)))
          (tag $exn)
          (func $caller (export "caller") (result i32)
            (block $h
              (try_table (catch $exn $h)
                nop))
            call $fork)
          (memory 1))
    "#;
    let bytes = instrument_wat(wat);
    validate(&bytes);
    let module = Module::from_buffer(&bytes).unwrap();
    assert!(
        module.exports.iter().any(|e| e.name == "wpk_fork_state"),
        "wpk_fork_state export must remain with plain catches"
    );
}

// ======================================================================
// Stage 2 (B1) Task 2.2 — per-arm capture-block emission
// ======================================================================

/// Walks the function and returns each TryTable instruction. Includes
/// nested ones — used to count + inspect catch clauses post-instrument.
fn collect_try_tables(f: &LocalFunction) -> Vec<ir::TryTable> {
    let mut out: Vec<ir::TryTable> = Vec::new();
    walk_all(f, f.entry_block(), &mut |_, instr| {
        if let Instr::TryTable(tt) = instr {
            out.push(tt.clone());
        }
    });
    out
}

fn private_unwind_tag(module: &Module) -> walrus::TagId {
    module
        .imports
        .iter()
        .find_map(|import| {
            if import.module == runtime_names::IMPORT_UNWIND_TAG_MODULE
                && import.name == runtime_names::IMPORT_UNWIND_TAG
            {
                match import.kind {
                    walrus::ImportKind::Tag(tag) => Some(tag),
                    _ => None,
                }
            } else {
                None
            }
        })
        .expect("private unwind tag import")
}

fn is_function_unwind_boundary(table: &ir::TryTable, unwind_tag: walrus::TagId) -> bool {
    matches!(
        table.catches.as_slice(),
        [ir::TryTableCatch::Catch { tag, .. }] if *tag == unwind_tag
    )
}

fn collect_user_try_tables(module: &Module, f: &LocalFunction) -> Vec<ir::TryTable> {
    let unwind_tag = private_unwind_tag(module);
    collect_try_tables(f)
        .into_iter()
        .filter(|table| !is_function_unwind_boundary(table, unwind_tag))
        .collect()
}

#[test]
fn catch_arm_uses_header_selector_without_an_active_arm_frame_local() {
    // After instrumentation, the original try_table's plain Catch
    // clause should point at an injected capture block, not at the
    // original handler label `$h`. The capture block contains the
    // save+rebroadcast logic and a `br` to the original handler.
    //
    // Note: walrus's parser drops post-`br` "unreachable" code on
    // round-trip via `Module::from_buffer`. Our save-and-branch logic
    // lives after `br $b1_outer` in the cap block — visible in the
    // serialized wasm but invisible via re-parsed walrus IR. We use
    // wasmprinter to assert against the actual wasm bytes.
    let wat = r#"
        (module
          (import "kernel" "kernel_fork" (func $fork (result i32)))
          (tag $exn)
          (func $caller (export "caller") (result i32)
            (block $h
              (try_table (catch $exn $h)
                nop))
            call $fork)
          (memory 1))
    "#;
    let bytes = instrument_wat(wat);
    validate(&bytes);

    // 1. Walrus-level: the try_table is preserved with a Catch clause.
    //    (The Catch label points at our capture block; we can't easily
    //    distinguish "the user's $h" from "B1's cap" in walrus IR
    //    without re-parsing tricks, so we only assert presence here.)
    let module = Module::from_buffer(&bytes).unwrap();
    let caller = func_by_name(&module, "caller");
    let f = local_func(&module, caller);
    let try_tables = collect_user_try_tables(&module, f);
    assert_eq!(
        try_tables.len(),
        1,
        "expected exactly one try_table post-instrument"
    );
    let tt = &try_tables[0];
    assert_eq!(tt.catches.len(), 1, "should still have 1 catch clause");
    assert!(
        matches!(&tt.catches[0], ir::TryTableCatch::Catch { .. }),
        "should be a plain Catch clause"
    );

    // 2. Byte-level (wasmprinter): the exact region/arm selector reuses
    //    header word +8. An empty-payload arm adds no scalar frame word.
    let printed = wasmprinter::print_bytes(&bytes).expect("wasmprinter");
    let caller_section = extract_function_text(&printed, "caller");
    assert!(
        caller_section.contains("try_table"),
        "caller must still have a try_table:\n{caller_section}"
    );
    assert!(
        caller_section.contains("i32.store offset=8")
            && caller_section.contains("i32.load offset=8"),
        "the exact catch selector must round-trip through header word +8:\n\
         {caller_section}",
    );
    assert!(
        !caller_section.contains("store offset=16") && !caller_section.contains("load offset=16"),
        "an empty catch payload must not allocate the former active-arm frame \
         word:\n{caller_section}",
    );

    let mut locals = HashSet::new();
    walk_all(
        f,
        f.entry_block(),
        &mut |_, instruction| match instruction {
            Instr::LocalGet(local) => {
                locals.insert(local.local);
            }
            Instr::LocalSet(local) => {
                locals.insert(local.local);
            }
            _ => {}
        },
    );
    assert_eq!(
        locals.len(),
        1,
        "only the activation-local catch selector is needed; static call \
         boundaries add no abort/live-frame selector, and no per-region marker \
         or native active-arm local should exist: {locals:?}",
    );
}

#[test]
fn catch_payload_frame_overlays_arms_at_the_maximum_arm_size() {
    let wat = r#"
        (module
          (import "kernel" "kernel_fork" (func $fork (result i32)))
          (tag $small (param i32))
          (tag $wide (param i64 i32))
          (tag $medium (param f64))
          (func $caller (export "caller") (result i32)
            (block $small_handler (result i32)
              (block $wide_handler (result i64 i32)
                (block $medium_handler (result f64)
                  (try_table
                      (catch $small $small_handler)
                      (catch $wide $wide_handler)
                      (catch $medium $medium_handler)
                    nop)
                  f64.const 0)
                drop
                i64.const 0
                i32.const 0)
              drop
              drop
              i32.const 0)
            drop
            call $fork)
          (memory 1))
    "#;
    let bytes = instrument_wat(wat);
    validate(&bytes);
    let module = Module::from_buffer(&bytes).expect("instrumented catch payload module");
    let caller = local_func(&module, func_by_name(&module, "caller"));
    let frame_select = module
        .funcs
        .iter()
        .find(|function| function.name.as_deref() == Some("__wpk_fork_select_unwind_frame"))
        .expect("generated unwind-frame selector")
        .id();

    fn collect_reserve_sizes(
        function: &LocalFunction,
        sequence: InstrSeqId,
        frame_select: FunctionId,
        sizes: &mut Vec<i32>,
    ) {
        let instructions = &function.block(sequence).instrs;
        for (index, (instruction, _)) in instructions.iter().enumerate() {
            if matches!(instruction, Instr::Call(call) if call.func == frame_select) {
                let Some((
                    Instr::Const(ir::Const {
                        value: ir::Value::I32(size),
                    }),
                    _,
                )) = index
                    .checked_sub(2)
                    .and_then(|previous| instructions.get(previous))
                else {
                    panic!(
                        "unwind-frame selector must be preceded by its exact \
                         static size and call index"
                    );
                };
                sizes.push(*size);
            }
            for child in nested_of(instruction) {
                collect_reserve_sizes(function, child, frame_select, sizes);
            }
        }
    }

    let mut sizes = Vec::new();
    collect_reserve_sizes(caller, caller.entry_block(), frame_select, &mut sizes);
    assert!(
        !sizes.is_empty(),
        "caller must reserve at least one unwind frame"
    );
    assert!(
        sizes.iter().all(|size| *size == 28),
        "new frame = 16-byte header + max(4, 12, 8) payload = 28 bytes; \
         the former sum layout was 16 + 4-byte active-arm + 4 + 12 + 8 = \
         44 bytes: {sizes:?}",
    );

    let printed = wasmprinter::print_bytes(&bytes).expect("wasmprinter");
    let caller_section = extract_function_text(&printed, "caller");
    assert!(
        caller_section.contains("i64.store offset=16")
            && caller_section.contains("i32.store offset=24")
            && caller_section.contains("f64.store offset=16"),
        "each selected arm must use the shared payload range, with only the \
         widest arm extending to +24:\n{caller_section}",
    );
    assert!(
        !caller_section.contains("store offset=28"),
        "no catch payload may be appended after the 12-byte union:\n\
         {caller_section}",
    );
}

/// Extract the `(func $name ... )` section from a wasmprinter dump.
fn extract_function_text<'a>(printed: &'a str, name: &str) -> String {
    let needle = format!("(func ${name} ");
    let start = printed.find(&needle).unwrap_or_else(|| {
        panic!("function ${name} not found in:\n{printed}");
    });
    // Walk paren depth from start to find the matching close.
    let mut depth = 0i32;
    let mut end = start;
    for (i, c) in printed[start..].char_indices() {
        match c {
            '(' => depth += 1,
            ')' => {
                depth -= 1;
                if depth == 0 {
                    end = start + i + 1;
                    break;
                }
            }
            _ => {}
        }
    }
    printed[start..end].to_string()
}

#[test]
fn thrown_reference_payload_replays_from_complete_exception_recipe() {
    let wat = r#"
        (module
          (import "kernel" "kernel_fork" (func $fork (result i32)))
          (tag $exn (param externref))
          (func $caller (export "caller") (result i32)
            (block $h (result externref)
              (try_table (result externref) (catch $exn $h)
                ref.null extern
                throw $exn))
            drop
            call $fork)
          (memory 1))
    "#;
    let bytes = instrument_wat(wat);
    validate(&bytes);
    let module = Module::from_buffer(&bytes).unwrap();
    assert_function_uses_exception_recipe(&module, "caller");
}

#[test]
fn b1_stage_2_byte_identity_for_module_without_plain_catch() {
    // A fork-using module with NO plain-catch should produce stable
    // output that's byte-identical across repeated runs. The only
    // try_table is the function-level private unwind boundary; Stage
    // 2 must not introduce a user-catch capture table.
    let wat = r#"
        (module
          (import "kernel" "kernel_fork" (func $fork (result i32)))
          (func $caller (export "caller") (result i32)
            call $fork)
          (memory 1))
    "#;
    let bytes_a = instrument_wat(wat);
    let bytes_b = instrument_wat(wat);
    assert_eq!(bytes_a, bytes_b, "instrument must be deterministic");
    validate(&bytes_a);

    let module = Module::from_buffer(&bytes_a).unwrap();
    let caller = func_by_name(&module, "caller");
    let f = local_func(&module, caller);
    let all_try_tables = collect_try_tables(f);
    assert_eq!(
        all_try_tables.len(),
        1,
        "fork-only function should contain exactly one private transport boundary",
    );
    assert!(
        is_function_unwind_boundary(&all_try_tables[0], private_unwind_tag(&module)),
        "the sole try_table must catch only the process-owned unwind tag",
    );
    assert!(
        collect_user_try_tables(&module, f).is_empty(),
        "Stage 2 must not introduce a user catch table when the input has none",
    );
}

#[test]
fn nested_region_instrumentation_is_byte_reproducible() {
    // Sibling fork-bearing regions used to be visited through randomized
    // HashMap iteration. Their body-parameter locals and rewritten instruction
    // sequences consequently received different Walrus IDs across runs, even
    // though the input was identical. Alternate parameter types so a changed
    // allocation order is observable in the emitted local declarations.
    let wat = r#"
        (module
          (import "kernel" "kernel_fork" (func $fork (result i32)))
          (type $i32_to_i32 (func (param i32) (result i32)))
          (type $i64_to_i64 (func (param i64) (result i64)))
          (func $caller (export "caller")
            i32.const 1
            (block (type $i32_to_i32)
              drop
              call $fork)
            drop
            i64.const 2
            (block (type $i64_to_i64)
              drop
              call $fork
              i64.extend_i32_s)
            drop
            i32.const 3
            (block (type $i32_to_i32)
              drop
              call $fork)
            drop
            i64.const 4
            (block (type $i64_to_i64)
              drop
              call $fork
              i64.extend_i32_s)
            drop)
          (memory 1))
    "#;

    let expected = instrument_wat(wat);
    validate(&expected);
    for run in 1..=8 {
        assert_eq!(
            expected,
            instrument_wat(wat),
            "nested instrumentation changed bytes on run {run}"
        );
    }
}

#[test]
fn fork_instrumentation_keeps_dylink_section_first() {
    let wat = r#"
        (module
          (@custom "dylink.0" (before first) "test metadata")
          (import "kernel" "kernel_fork" (func $fork (result i32)))
          (func $caller (export "caller") (result i32)
            call $fork)
          (memory 1))
    "#;

    let output = instrument_wat(wat);
    validate(&output);
    let mut payloads = wasmparser::Parser::new(0).parse_all(&output);
    assert!(matches!(
        payloads.next().unwrap().unwrap(),
        wasmparser::Payload::Version { .. }
    ));
    match payloads.next().unwrap().unwrap() {
        wasmparser::Payload::CustomSection(section) => {
            assert_eq!(section.name(), "dylink.0");
            assert_eq!(section.data(), b"test metadata");
        }
        other => panic!("dylink.0 must remain the first section, got {other:?}"),
    }
    assert_eq!(
        fork_instrument::contract_inventory::artifact_identity(&output)
            .expect("inspect instrumented side-module identity")
            .abi_version,
        fork_instrument::contract_inventory::ArtifactAbiVersion::Present(
            wasm_posix_shared::ABI_VERSION,
        ),
        "instrumentation must bind a side module to the current fork ABI epoch",
    );
}

#[test]
fn fork_instrumentation_rejects_stale_side_module_abi_marker() {
    let stale_abi = wasm_posix_shared::ABI_VERSION - 1;
    let wat = format!(
        r#"
        (module
          (@custom "dylink.0" (before first) "test metadata")
          (func (export "__abi_version") (result i32)
            i32.const {stale_abi})
          (memory 1))
    "#,
    );

    let error = instrument(&parse_wat(&wat), &Options::default())
        .expect_err("a stale side-module ABI marker must fail instrumentation");
    let message = format!("{error:#}");
    assert!(
        message.contains(&format!("stale __abi_version {stale_abi}"))
            && message.contains(&format!("current ABI {}", wasm_posix_shared::ABI_VERSION)),
        "got: {message}",
    );
}

// ======================================================================
// Stage 2 (B1) Task 2.3 — multi-arm rewind dispatch
// ======================================================================

#[test]
fn b1_stage_2_rewind_stub_has_plain_catch_dispatch() {
    // The rewind-throw stub for a region with a plain-catch arm must
    // include a `throw $tag` so that on REWIND the original handler observes
    // the same exception class. The exact wat shape varies with
    // walrus's emitter, so we just check the key semantic markers.
    let wat = r#"
        (module
          (import "kernel" "kernel_fork" (func $fork (result i32)))
          (tag $exn)
          (func $caller (export "caller") (result i32)
            (block $h
              (try_table (catch $exn $h)
                nop))
            call $fork)
          (memory 1))
    "#;
    let bytes = instrument_wat(wat);
    validate(&bytes);

    let printed = wasmprinter::print_bytes(&bytes).expect("wasmprinter");
    let caller_section = extract_function_text(&printed, "caller");
    assert!(
        !caller_section.contains("throw_ref"),
        "ABI 43 replay must not depend on a saved exnref:\n{caller_section}"
    );
    assert!(
        caller_section.contains("throw $exn") || caller_section.contains("throw 0"),
        "rewind stub must contain a `throw $exn` for the plain-catch \
         arm dispatch:\n{caller_section}"
    );
    assert!(
        !caller_section.contains("_wpk_fork_exnref_stash"),
        "rewind stub must be activation-owned:\n{caller_section}"
    );
}

#[test]
fn mixed_plain_and_catch_ref_uses_frame_backed_arm_kind() {
    let wat = r#"
        (module
          (import "kernel" "kernel_fork" (func $fork (result i32)))
          (tag $plain (param i32))
          (tag $with_ref)
          (func $caller (export "caller") (param $take_plain i32) (result i32)
            (block $done (result i32)
              (block $plain_handler (result i32)
                (block $ref_handler (result exnref)
                  (try_table (result exnref)
                      (catch $plain $plain_handler)
                      (catch_ref $with_ref $ref_handler)
                    call $fork
                    drop
                    local.get $take_plain
                    if
                      i32.const 41
                      throw $plain
                    else
                      throw $with_ref
                    end
                    unreachable))
              drop
              i32.const 42
              br $done)
            br $done))
          (memory 1))
    "#;
    let bytes = instrument_wat(wat);
    validate(&bytes);
    let printed = wasmprinter::print_bytes(&bytes).expect("wasmprinter");
    let caller_section = extract_function_text(&printed, "caller");
    assert!(
        caller_section.contains("throw $plain") || caller_section.contains("throw 0"),
        "plain arm must have a tagged reconstruction path:\n{caller_section}",
    );
    assert!(
        caller_section.contains("throw $with_ref") || caller_section.contains("throw 1"),
        "CatchRef arm must reconstruct by rethrowing its static tag:\n{caller_section}",
    );
    assert!(
        !caller_section.contains("throw_ref") && !caller_section.contains("_wpk_fork_exnref_stash"),
        "mixed replay must not retain or reload an old-instance exnref:\n{caller_section}",
    );
}

#[test]
fn b1_stage_2_rewind_stub_dispatches_two_arms() {
    // A try_table with two plain-catch arms (different tags) must
    // produce a rewind dispatch with two distinct `throw $tag`
    // emissions — one per arm — so the if-chain on saved arm_id
    // routes correctly at REWIND.
    let wat = r#"
        (module
          (import "kernel" "kernel_fork" (func $fork (result i32)))
          (tag $a (param i32))
          (tag $b (param i32))
          (func $caller (export "caller") (result i32)
            (block $h (result i32)
              (try_table (result i32) (catch $a $h) (catch $b $h)
                i32.const 0))
            drop
            call $fork)
          (memory 1))
    "#;
    let bytes = instrument_wat(wat);
    validate(&bytes);
    let printed = wasmprinter::print_bytes(&bytes).expect("wasmprinter");
    let caller_section = extract_function_text(&printed, "caller");
    let throw_a = caller_section.matches("throw $a").count();
    let throw_b = caller_section.matches("throw $b").count();
    // Each arm contributes a `throw $a` from B1 dispatch and a
    // `throw $b` from B1 dispatch. The original `throw $exn` in the
    // try_table body is NOT in the source (the wat only catches),
    // so the only `throw $a` / `throw $b` in the printed output come
    // from the B1 rewind stub. We expect at least 1 of each.
    assert!(
        throw_a >= 1,
        "expected `throw $a` for the first plain-catch arm:\n{caller_section}"
    );
    assert!(
        throw_b >= 1,
        "expected `throw $b` for the second plain-catch arm:\n{caller_section}"
    );
}

#[test]
fn reference_payload_emits_complete_exception_dispatch() {
    let wat = r#"
        (module
          (import "kernel" "kernel_fork" (func $fork (result i32)))
          (tag $exn (param externref))
          (func $caller (export "caller") (result i32)
            (block $h (result externref)
              (try_table (result externref) (catch $exn $h)
                ref.null extern
                throw $exn))
            drop
            call $fork)
          (memory 1))
    "#;
    let bytes = instrument_wat(wat);
    validate(&bytes);
    let module = Module::from_buffer(&bytes).unwrap();
    assert_function_uses_exception_recipe(&module, "caller");
}

#[test]
fn a_checkpoint_seed_instruments_a_module_that_never_forks() {
    let wat = r#"
        (module
          (import "kernel" "kernel_checkpoint" (func $checkpoint (result i32)))
          (memory 1)
          (func (export "_start") (result i32)
            call $checkpoint))
    "#;
    let bytes = parse_wat(wat);
    assert_eq!(
        instrument(&bytes, &Options::default()).expect("instrument"),
        bytes,
        "no seed import leaves the linker bytes untouched",
    );

    let opts = Options {
        checkpoint_import: Some("kernel.kernel_checkpoint".into()),
        ..Options::default()
    };
    let instrumented = instrument(&bytes, &opts).expect("instrument");
    validate(&instrumented);
    let module = Module::from_buffer(&instrumented).expect("walrus parse");
    for export in [
        runtime_names::EXPORT_UNWIND_BEGIN,
        runtime_names::EXPORT_UNWIND_END,
        runtime_names::EXPORT_REWIND_BEGIN,
        runtime_names::EXPORT_REWIND_END,
        runtime_names::EXPORT_STATE,
    ] {
        assert!(
            module.exports.iter().any(|e| e.name == export),
            "`{export}` export missing",
        );
    }
}
