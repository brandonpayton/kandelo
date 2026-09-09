//! Externref production-site provenance wrapper pass (N1-F5 Task 1).
//!
//! See `docs/plans/2026-09-05-n1-f5-externref-capture.md` (Task 1) and its
//! grounding, `docs/plans/2026-09-05-n1-f5-externref-capture-grounding.md`
//! (especially §3/§4), for the full design rationale. Restated briefly:
//!
//! Replaying a captured `externref` across `fork()` is a pure function of a
//! `u32` handle (`resolve_externref(handle) -> externref`, already built and
//! shared). Capture needs the inverse relation — given a *live* externref,
//! recover the handle it should have had all along — and that inverse
//! cannot be recovered later by inspection (there is no reverse index over
//! an opaque host reference). It can only be recorded once, at the exact
//! moment the value is minted. This pass makes that moment observable:
//! every call site that invokes a declared host-function import whose
//! result includes `externref` is rewritten to route through a generated
//! wrapper that calls the real import and then immediately calls a new
//! private import, [`IMPORT_PROVENANCE_EXTERNREF`], with the freshly
//! produced value before it reaches the original caller. The host body
//! behind that import (native + Node/browser, landed in later F5 tasks)
//! records `(externref identity -> handle)` at that instant; capture then
//! becomes a guaranteed-present lookup instead of an unsound reverse
//! lookup.
//!
//! This module deliberately mirrors the wrapper TECHNIQUE already used by
//! [`crate::module_gc_codec::inject_provenance_wrappers`] for GC
//! struct/array constructors — collect the pre-existing call targets,
//! build one wrapper function per target, then rewrite every matching
//! `call` instruction across the module's ORIGINAL functions to route
//! through the wrapper instead. It is a distinct pass (not an extension of
//! `module_gc_codec`) because the production site here is a host-*import*
//! call, not a `struct.new`/`array.new` instruction, and needs none of that
//! module's transit-table/layout machinery.
//!
//! # Scope and residual gap (recorded per the campaign's "no silent caps"
//! rule; see the grounding doc §4/§6)
//!
//! This pass only rewrites **direct** `call` instructions whose static
//! target is a declared function import. It does not attempt to prove
//! anything about `call_indirect`/`call_ref` landing on an
//! externref-returning import placed into a `funcref` table — Wasm allows a
//! host import's `FunctionId` to be captured into a table via an element
//! segment or `ref.func`, and dispatched indirectly. Today's fork census
//! (0/113 real packages produce externref at all) means this gap is
//! unexercised by any real package; it is recorded here rather than
//! silently closed over. A guest-internalized externref
//! (`extern.internalize`/`any.convert_extern` on a guest-allocated `anyref`
//! with **no** host call in between) has no call site for this pass to
//! wrap at all — that is explicitly F6's GC-provenance problem, not this
//! pass's, per the F5/F6 scoping ruling in the plan's Global Constraints.

use std::collections::HashMap;

use anyhow::Result;
use walrus::{
    AbstractHeapType, FunctionBuilder, FunctionId, FunctionKind, HeapType, LocalFunction, LocalId,
    Module, RefType, ValType,
    ir::{
        Call, Instr, InstrLocId, LocalGet, LocalSet, VisitorMut, dfs_pre_order_mut,
    },
};

use wasm_posix_shared::abi::{
    WPK_FORK_REFERENCE_CODEC_IMPORT_MODULE, WPK_FORK_REFERENCE_IMPORT_PROVENANCE_EXTERNREF,
};

/// Host import module hosting the provenance import (matches the rest of
/// the reference-codec import surface: `env`).
pub const HOST_IMPORT_MODULE: &str = WPK_FORK_REFERENCE_CODEC_IMPORT_MODULE;
/// `fn(externref) -> externref`, pass-through. See the module doc comment
/// and the constant's own doc comment in `wasm_posix_shared::abi` for why
/// this signature (rather than `fn(externref) -> ()`) was chosen: it
/// composes as a single extra call wrapped around each production-site
/// result, including a hypothetical multi-value import result, with no
/// extra locals needed to thread "the value to return" separately from
/// "the value that was registered".
pub const IMPORT_PROVENANCE_EXTERNREF: &str = WPK_FORK_REFERENCE_IMPORT_PROVENANCE_EXTERNREF;

/// Wrap every externref-returning host-import call site in `module` so the
/// new provenance import observes each freshly-minted value.
///
/// The provenance import itself is added unconditionally, even when this
/// particular module declares no externref-returning host-function import:
/// [`crate::WPK_FORK_REQUIRED_IMPORTS`] (mirrored in
/// `wasm_posix_shared::abi::WPK_FORK_REQUIRED_IMPORTS`) is the uniform
/// "every fork-capable artifact declares the same linked import surface"
/// contract every other reference-codec import already follows (e.g.
/// `__wpk_fork_ref_vector_begin` is declared even by a program that holds no
/// GC references) — hosts and validators rely on that surface being
/// complete and artifact-content-independent, not conditionally present.
/// Only the wrapper functions and call-site rewriting are skipped when there
/// is nothing to wrap.
///
/// Must run BEFORE any other pass adds its own imports or local functions:
/// this pass snapshots the module's pre-existing local functions (rewrite
/// targets) and pre-existing externref-returning imports (wrap targets)
/// first, and only then adds its own provenance import and wrapper
/// functions — so neither can be mistaken for a production site or a
/// rewrite target by this same pass.
pub fn inject_provenance_wrappers(module: &mut Module) -> Result<()> {
    let mut source_functions: Vec<FunctionId> = module
        .funcs
        .iter()
        .filter_map(|function| {
            matches!(function.kind, FunctionKind::Local(_)).then_some(function.id())
        })
        .collect();
    source_functions.sort();

    let mut targets: Vec<FunctionId> = module
        .funcs
        .iter()
        .filter_map(|function| match &function.kind {
            FunctionKind::Import(_) => {
                let signature = module.types.get(function.ty());
                returns_externref(signature.results()).then_some(function.id())
            }
            _ => None,
        })
        .collect();
    targets.sort();

    // Always declare the import: it is part of the uniform required-import
    // surface every fork-capable artifact carries, independent of whether
    // THIS module happens to use externref (see the doc comment above).
    let provenance_ty = module.types.add(
        &[ValType::Ref(RefType::EXTERNREF)],
        &[ValType::Ref(RefType::EXTERNREF)],
    );
    let (provenance, _) =
        module.add_import_func(HOST_IMPORT_MODULE, IMPORT_PROVENANCE_EXTERNREF, provenance_ty);

    if targets.is_empty() {
        return Ok(());
    }

    let mut wrappers: HashMap<FunctionId, FunctionId> = HashMap::new();
    for import in targets {
        let wrapper = add_provenance_wrapper(module, import, provenance);
        wrappers.insert(import, wrapper);
    }

    struct Rewrite {
        wrappers: HashMap<FunctionId, FunctionId>,
    }
    impl VisitorMut for Rewrite {
        fn visit_instr_mut(&mut self, instr: &mut Instr, _loc: &mut InstrLocId) {
            if let Instr::Call(Call { func }) = instr {
                if let Some(&wrapper) = self.wrappers.get(func) {
                    *func = wrapper;
                }
            }
        }
    }
    let mut rewrite = Rewrite { wrappers };
    for &function in &source_functions {
        let local = local_mut(module, function);
        let entry = local.entry_block();
        dfs_pre_order_mut(&mut rewrite, local, entry);
    }
    Ok(())
}

fn returns_externref(results: &[ValType]) -> bool {
    results.iter().copied().any(is_externref)
}

fn is_externref(ty: ValType) -> bool {
    matches!(
        ty,
        ValType::Ref(RefType {
            heap_type: HeapType::Abstract(AbstractHeapType::Extern),
            ..
        })
    )
}

/// Build one wrapper function for `import`: call the real import with the
/// wrapper's arguments, thread every externref-typed result through
/// [`IMPORT_PROVENANCE_EXTERNREF`], and return the (possibly partially
/// rewritten) result tuple unchanged in shape and order. Non-externref
/// results pass straight through.
fn add_provenance_wrapper(module: &mut Module, import: FunctionId, provenance: FunctionId) -> FunctionId {
    let ty_id = module.funcs.get(import).ty();
    let (params, results): (Vec<ValType>, Vec<ValType>) = {
        let signature = module.types.get(ty_id);
        (signature.params().to_vec(), signature.results().to_vec())
    };

    let name = format!(
        "__wpk_fork_ref_provenance_call_{}",
        import.index()
    );
    let (wrapper, args) = add_stub(module, &params, &results, &name);
    let result_locals: Vec<LocalId> = results.iter().map(|&ty| module.locals.add(ty)).collect();

    let entry = entry(wrapper, module);
    let instrs = instrs_mut(module, wrapper, entry);
    for &arg in &args {
        local_get(instrs, arg);
    }
    call(instrs, import);
    // `call` leaves multiple results on the stack in declared order (last
    // result on top). Pop them into locals in reverse so each local holds
    // its corresponding result regardless of arity.
    for &local in result_locals.iter().rev() {
        local_set(instrs, local);
    }
    for (index, &ty) in results.iter().enumerate() {
        if is_externref(ty) {
            local_get(instrs, result_locals[index]);
            call(instrs, provenance);
            local_set(instrs, result_locals[index]);
        }
    }
    for &local in &result_locals {
        local_get(instrs, local);
    }
    wrapper
}

fn add_stub(
    module: &mut Module,
    params: &[ValType],
    results: &[ValType],
    name: &str,
) -> (FunctionId, Vec<LocalId>) {
    let args: Vec<_> = params.iter().copied().map(|ty| module.locals.add(ty)).collect();
    let mut builder = FunctionBuilder::new(&mut module.types, params, results);
    builder.name(name.into());
    let function = builder.finish(args.clone(), &mut module.funcs);
    (function, args)
}

fn entry(function: FunctionId, module: &Module) -> walrus::ir::InstrSeqId {
    local(module, function).entry_block()
}

fn instrs_mut(
    module: &mut Module,
    function: FunctionId,
    seq: walrus::ir::InstrSeqId,
) -> &mut Vec<(Instr, InstrLocId)> {
    &mut local_mut(module, function).block_mut(seq).instrs
}

fn local(module: &Module, function: FunctionId) -> &LocalFunction {
    match &module.funcs.get(function).kind {
        FunctionKind::Local(local) => local,
        _ => unreachable!("injected provenance wrapper function is local"),
    }
}

fn local_mut(module: &mut Module, function: FunctionId) -> &mut LocalFunction {
    match &mut module.funcs.get_mut(function).kind {
        FunctionKind::Local(local) => local,
        _ => unreachable!("injected provenance wrapper function is local"),
    }
}

fn push(instrs: &mut Vec<(Instr, InstrLocId)>, instr: Instr) {
    instrs.push((instr, InstrLocId::default()));
}

fn local_get(instrs: &mut Vec<(Instr, InstrLocId)>, local: LocalId) {
    push(instrs, Instr::LocalGet(LocalGet { local }));
}

fn local_set(instrs: &mut Vec<(Instr, InstrLocId)>, local: LocalId) {
    push(instrs, Instr::LocalSet(LocalSet { local }));
}

fn call(instrs: &mut Vec<(Instr, InstrLocId)>, function: FunctionId) {
    push(instrs, Instr::Call(Call { func: function }));
}

#[cfg(test)]
mod tests {
    use super::*;

    fn find_import(module: &Module, name: &str) -> Option<FunctionId> {
        module.imports.iter().find_map(|import| {
            (import.name == name).then_some(&import.kind).and_then(|kind| match kind {
                walrus::ImportKind::Function(function) => Some(*function),
                _ => None,
            })
        })
    }

    fn find_export(module: &Module, name: &str) -> FunctionId {
        module
            .exports
            .iter()
            .find(|export| export.name == name)
            .and_then(|export| match export.item {
                walrus::ExportItem::Function(function) => Some(function),
                _ => None,
            })
            .unwrap_or_else(|| panic!("export `{name}` exists and is a function"))
    }

    fn direct_call_targets(module: &Module, function: FunctionId) -> Vec<FunctionId> {
        struct Collect {
            targets: Vec<FunctionId>,
        }
        impl<'a> walrus::ir::Visitor<'a> for Collect {
            fn visit_instr(&mut self, instr: &walrus::ir::Instr, _loc: &InstrLocId) {
                if let Instr::Call(Call { func }) = instr {
                    self.targets.push(*func);
                }
            }
        }
        let FunctionKind::Local(local) = &module.funcs.get(function).kind else {
            panic!("expected a local function");
        };
        let mut collector = Collect { targets: Vec::new() };
        walrus::ir::dfs_in_order(&mut collector, local, local.entry_block());
        collector.targets
    }

    /// RED (pre-pass): a fixture module declares an externref-returning
    /// host import and a caller that invokes it once. Before this pass
    /// exists/runs, the caller's only call target is the raw import — there
    /// is no provenance import in the module and no wrapper indirection.
    #[test]
    fn caller_calls_the_raw_import_directly_before_instrumentation() {
        let wat = r#"
            (module
              (import "env" "get_ext" (func $get_ext (result externref)))
              (func (export "caller") (result externref)
                call $get_ext))
        "#;
        let bytes = wat::parse_str(wat).expect("wat parses");
        let module = Module::from_buffer(&bytes).expect("walrus parses");
        let get_ext = find_import(&module, "get_ext").expect("get_ext import exists");
        let caller = find_export(&module, "caller");
        assert_eq!(direct_call_targets(&module, caller), vec![get_ext]);
        assert!(
            find_import(&module, IMPORT_PROVENANCE_EXTERNREF).is_none(),
            "provenance import must not exist before the pass runs"
        );
    }

    /// GREEN: after running the pass, the caller's call site is rewritten to
    /// a generated wrapper, and that wrapper calls the ORIGINAL import
    /// followed immediately by the new provenance import, before the value
    /// reaches the caller.
    #[test]
    fn call_site_is_routed_through_a_provenance_wrapper() {
        let wat = r#"
            (module
              (import "env" "get_ext" (func $get_ext (result externref)))
              (func (export "caller") (result externref)
                call $get_ext))
        "#;
        let bytes = wat::parse_str(wat).expect("wat parses");
        let mut module = Module::from_buffer(&bytes).expect("walrus parses");
        let get_ext = find_import(&module, "get_ext").expect("get_ext import exists");

        inject_provenance_wrappers(&mut module).expect("pass succeeds");

        let provenance =
            find_import(&module, IMPORT_PROVENANCE_EXTERNREF).expect("provenance import injected");
        assert_ne!(provenance, get_ext);

        let caller = find_export(&module, "caller");
        let caller_targets = direct_call_targets(&module, caller);
        assert_eq!(
            caller_targets.len(),
            1,
            "caller must still make exactly one direct call"
        );
        let wrapper = caller_targets[0];
        assert_ne!(
            wrapper, get_ext,
            "the caller's call site must no longer target the raw import directly"
        );

        let wrapper_targets = direct_call_targets(&module, wrapper);
        assert_eq!(
            wrapper_targets,
            vec![get_ext, provenance],
            "the wrapper must call the real import, then the provenance import, in that order"
        );

        // The instrumented module must still validate as well-formed wasm.
        let bytes = module.emit_wasm();
        wasmparser::validate(&bytes).expect("instrumented module is valid wasm");
    }

    /// Multiple call sites to the SAME import (from different functions)
    /// must all route through the SAME wrapper — the pass must not silently
    /// leave a second, third, ... call site on the unwrapped raw import.
    #[test]
    fn multiple_call_sites_to_the_same_import_all_route_through_one_wrapper() {
        let wat = r#"
            (module
              (import "env" "get_ext" (func $get_ext (result externref)))
              (func (export "caller_a") (result externref)
                call $get_ext)
              (func (export "caller_b") (result externref)
                call $get_ext
                call $get_ext
                drop))
        "#;
        let bytes = wat::parse_str(wat).expect("wat parses");
        let mut module = Module::from_buffer(&bytes).expect("walrus parses");
        let get_ext = find_import(&module, "get_ext").expect("get_ext import exists");

        inject_provenance_wrappers(&mut module).expect("pass succeeds");

        let caller_a = find_export(&module, "caller_a");
        let caller_b = find_export(&module, "caller_b");
        let a_targets = direct_call_targets(&module, caller_a);
        let b_targets = direct_call_targets(&module, caller_b);
        assert_eq!(a_targets.len(), 1);
        assert_eq!(b_targets, vec![a_targets[0], a_targets[0]]);
        assert!(!a_targets.contains(&get_ext));
    }

    /// An import that does not return externref must have its call sites
    /// left completely untouched. The provenance import is still declared
    /// (it is part of the uniform required-import surface every
    /// fork-capable artifact carries regardless of content — see the
    /// `inject_provenance_wrappers` doc comment) but is never called.
    #[test]
    fn imports_not_returning_externref_are_left_alone() {
        let wat = r#"
            (module
              (import "env" "get_int" (func $get_int (result i32)))
              (func (export "caller") (result i32)
                call $get_int))
        "#;
        let bytes = wat::parse_str(wat).expect("wat parses");
        let mut module = Module::from_buffer(&bytes).expect("walrus parses");
        let get_int = find_import(&module, "get_int").expect("get_int import exists");

        inject_provenance_wrappers(&mut module).expect("pass succeeds");

        assert!(find_import(&module, IMPORT_PROVENANCE_EXTERNREF).is_some());
        let caller = find_export(&module, "caller");
        assert_eq!(direct_call_targets(&module, caller), vec![get_int]);
    }

    /// A multi-value import mixing an externref result with a scalar result
    /// must only route the externref-typed component through provenance,
    /// and must preserve declared result order.
    #[test]
    fn multi_value_import_only_wraps_the_externref_result() {
        let wat = r#"
            (module
              (import "env" "get_pair" (func $get_pair (result externref i32)))
              (func (export "caller") (result externref i32)
                call $get_pair))
        "#;
        let bytes = wat::parse_str(wat).expect("wat parses");
        let mut module = Module::from_buffer(&bytes).expect("walrus parses");
        let get_pair = find_import(&module, "get_pair").expect("get_pair import exists");

        inject_provenance_wrappers(&mut module).expect("pass succeeds");
        let provenance =
            find_import(&module, IMPORT_PROVENANCE_EXTERNREF).expect("provenance import injected");

        let caller = find_export(&module, "caller");
        let wrapper = direct_call_targets(&module, caller)[0];
        assert_eq!(
            direct_call_targets(&module, wrapper),
            vec![get_pair, provenance]
        );

        let bytes = module.emit_wasm();
        wasmparser::validate(&bytes).expect("instrumented module is valid wasm");
    }

    /// The full pipeline entry point (`fork_instrument::instrument`) must
    /// declare the new provenance import as part of an instrumented
    /// fork-capable program's required import surface, and must route a
    /// real fork-path externref production call site through it end to end.
    #[test]
    fn instrument_pipeline_wraps_externref_import_call_site() {
        let wat = r#"
            (module
              (import "kernel" "kernel_fork" (func $fork (result i32)))
              (import "env" "get_ext" (func $get_ext (result externref)))
              (func (export "use_fork") (result externref)
                call $fork
                drop
                call $get_ext))
        "#;
        let bytes = wat::parse_str(wat).expect("wat parses");
        let output = crate::instrument(&bytes, &crate::Options::default())
            .expect("fork-instrument pipeline succeeds");
        let module = Module::from_buffer(&output).expect("instrumented module parses");

        let provenance = find_import(&module, IMPORT_PROVENANCE_EXTERNREF)
            .expect("instrumented module declares the provenance import");
        let get_ext = find_import(&module, "get_ext").expect("get_ext import survives");
        assert_ne!(provenance, get_ext);

        // Guard the value import assertion is meaningful even after the
        // switch-dispatch transform rewrites `use_fork`'s body: search every
        // surviving local function for a direct call to `get_ext` (there
        // must be none left — every call site was rewritten to the wrapper)
        // and confirm the wrapper (reachable from SOME surviving function)
        // still calls `get_ext` immediately followed by `provenance`.
        let mut any_calls_get_ext_directly = false;
        let mut wrapper_found = false;
        for function in module.funcs.iter() {
            let FunctionKind::Local(_) = &function.kind else {
                continue;
            };
            let targets = direct_call_targets(&module, function.id());
            if targets.contains(&get_ext) {
                if targets == vec![get_ext, provenance] {
                    wrapper_found = true;
                } else {
                    any_calls_get_ext_directly = true;
                }
            }
        }
        assert!(
            !any_calls_get_ext_directly,
            "no surviving function may call get_ext without immediately following with provenance"
        );
        assert!(wrapper_found, "the generated wrapper must survive the full pipeline");

        wasmparser::validate(&output).expect("fully instrumented module is valid wasm");
    }
}
