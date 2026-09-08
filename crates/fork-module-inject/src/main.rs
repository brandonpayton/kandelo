//! Inject the fork-module's `__wpk_fork_ref_decode_funcref` export (Phase 6
//! D6.1).
//!
//! WHY THIS TOOL EXISTS. The frozen guest import
//! `__wpk_fork_ref_decode_funcref(recipeId) -> funcref` must RETURN a real
//! `funcref`. A WebAssembly module can only produce a `funcref` by reading an
//! imported funcref `table` with `table.get` — it cannot fabricate one from an
//! integer. Rust, however, has no `funcref` type and its reference-types support
//! cannot emit a function whose result is `(ref func)` reading an imported table.
//! So the fork-module (a Rust cdylib) cannot itself export this function.
//!
//! This tool closes that gap with a single, static, hand-encoded wasm function
//! injected into the compiled fork-module via `walrus` (the same typed-wasm-IR
//! crate the fork-instrument transforms use, which preserves the module's
//! `dylink.0` PIC custom section across the round trip). The injected function
//! is pure plumbing:
//!
//! ```wat
//! (func (export "__wpk_fork_ref_decode_funcref") (param $recipe i32) (result funcref)
//!   (local $ord i32)
//!   (local.set $ord (call $fm_funcref_ordinal (local.get $recipe)))
//!   (if (result funcref) (i32.eq (local.get $ord) (i32.const -1))   ;; NULL_ORDINAL
//!     (then (ref.null func))
//!     (else (table.get $__wpk_fork_function_catalog (local.get $ord)))))
//! ```
//!
//! All the real work — decoding the reference graph, mapping a recipe id to a
//! `(activation, ordinal)`, admitting only funcref/null, trapping on corruption
//! — lives in the module's Rust `fm_funcref_ordinal` helper. This tool only adds
//! the funcref-returning wrapper Rust cannot express and the funcref table
//! import it reads.

use anyhow::{anyhow, bail, Context, Result};
use walrus::ir::{AnyConvertExtern, BinaryOp, Br, CallIndirect, LoadKind, Loop, MemArg, UnaryOp};
use walrus::{
    ExportItem, FunctionBuilder, FunctionId, ImportKind, Module, RefType, ValType,
};

// -- GC drive-shim injection (Phase 6 item 3b) --------------------------------
//
// The second injection this tool performs. The co-resident module cannot IMPORT
// the guest's `__wpk_fork_ref_gc_allocate`/`_gc_fill` exports (it is instantiated
// BEFORE the guest, to supply the frame-flip imports), so it drives them through
// a MUTABLE funcref table the host binds post-instantiation. Rust has no
// `call_indirect` intrinsic, so this tool injects `fm_drive_execute(plan_ptr,
// count)` — a wasm loop that strides the serialized drive PLAN
// (`fork_codec::drive_plan`), `call_indirect`s the table slot for each step, and
// after each ALLOC step verifies — with a wasm-level `table.get` + `ref.is_null`
// — that the guest's `_gc_allocate` published a live GC object into the shared
// Wasm-GC transit table (`env.__wpk_fork_ref_gc_transit`, an `anyref` table) at
// slot `recipe + 1`. That transit table is STORE #2: the ONE store the guest's
// `allocate` export actually publishes every struct/array/i31 into (see
// `crates/fork-instrument/src/module_gc_codec.rs` `emit_allocate_layout` /
// `emit_allocate_i31`) and the one `_gc_fill` consumes. A missing published
// object is real GC corruption, so a null slot branches to `unreachable` (a
// truthful trap). Rust has no `funcref`/`anyref` type and cannot express
// `table.get`, so this integrity guard, like the drive loop itself, must be
// injected wasm rather than a Rust export call.

/// The mutable funcref table the host binds guest `_gc_allocate`/`_gc_fill` into
/// and the injected `fm_drive_execute` `call_indirect`s. Imported (initial size
/// 0; the host provides a table sized to the fork's activations).
const DRIVE_TABLE_IMPORT: &str = "__wpk_fork_drive_table";
/// The injected loop export the host calls to run a serialized plan.
const DRIVE_EXECUTE_EXPORT: &str = "fm_drive_execute";
/// The Rust drive-step proof-of-use counter the injected shim `call`s once per
/// plan step it drives (Phase 6 item 3c). Exported by `crates/fork-module/src/
/// lib.rs`; Rust owns the counter, the injected loop owns the `call_indirect`.
const DRIVE_BUMP_HELPER_EXPORT: &str = "fm_drive_bump";
/// The shared Wasm-GC transit table (`(ref null any)`) the guest's
/// `_gc_allocate` publishes every reconstructed struct/array/i31 into at slot
/// `recipe + 1` (STORE #2). The injected drive loop reads it back with
/// `table.get` + `ref.is_null` after each ALLOC step to assert the guest
/// published a live object.
///
/// M1: the fork-module DEFINES this table as a local table and EXPORTS it
/// under this name — Rust cannot emit an anyref table, so the injector is
/// where the module acquires ownership of it. The guest imports the
/// fork-module's export (`crates/fork-instrument/src/module_gc_codec.rs`)
/// instead of a standalone host-provided table, so this name must still match
/// the guest's import name/element type exactly.
const TRANSIT_TABLE_IMPORT: &str = "__wpk_fork_ref_gc_transit";

/// The merged, host-owned static-root catalog (`anyref`) the injected drive shim
/// reads with `table.get` on a DRIVE_OP_STATIC_ROOT step (the static-root binder).
/// The guest's own `__wpk_fork_static_root_catalog` is a harvest EXPORT cleared
/// after instantiation, so the host supplies a growable mirror populated from the
/// child's live static roots (`decodeStaticRoot`) and bound to this import; the
/// shim `table.get`s the slot `fm_static_root_slot` returns and publishes the
/// value into the transit at `recipe + 1`. Imported (initial size 0; the host
/// grows it to the fork's merged catalog).
const STATIC_ROOT_CATALOG_IMPORT: &str = "__wpk_fork_static_root_catalog";
/// The Rust helper the shim calls to map a DRIVE_OP_STATIC_ROOT recipe to its
/// merged anyref-catalog index (per-activation base + ordinal). Exported by
/// `crates/fork-module/src/lib.rs`; traps on any inconsistency.
const STATIC_ROOT_SLOT_HELPER_EXPORT: &str = "fm_static_root_slot";

// Serialized drive-step layout — MUST match `fork_codec::drive_plan`
// (`DRIVE_STEP_SIZE`, `DRIVE_STEP_OFF_*`, `DRIVE_OP_*`). Four little-endian
// u32 fields per 16-byte step.
const DRIVE_STEP_SIZE: i32 = 16;
const DRIVE_STEP_OFF_OP: u64 = 0;
const DRIVE_STEP_OFF_SLOT: u64 = 4;
const DRIVE_STEP_OFF_RECIPE: u64 = 8;
const DRIVE_STEP_OFF_ARG: u64 = 12;
const DRIVE_OP_ALLOC: i32 = 0;
/// op == publish an immutable static root into the anyref transit (the
/// static-root binder). MUST match `fork_codec::drive_plan::DRIVE_OP_STATIC_ROOT`.
const DRIVE_OP_STATIC_ROOT: i32 = 3;
/// op == materialize + publish a GC/exnref-reachable externref into the anyref
/// transit at slot `recipe + 1` (the externref binder — M2). Like
/// DRIVE_OP_STATIC_ROOT it drives NO guest export: the injected shim resolves the
/// externref through the residual `env.resolve_externref` host import, internalizes
/// it with `any.convert_extern`, and `table.set`s it into the transit. MUST match
/// `fork_codec::drive_plan::DRIVE_OP_EXTERNREF_TRANSIT`.
const DRIVE_OP_EXTERNREF_TRANSIT: i32 = 4;
/// op == the FIRST child-install op (`fork_codec::drive_plan::DRIVE_OP_RESTORE`).
/// Every op `< DRIVE_OP_RESTORE` is a RECONSTRUCTION step (alloc/fill/exn/static-
/// root/externref-transit) whose drive the `fm_drive_steps_executed` proof
/// counts; ops `>= DRIVE_OP_RESTORE` (RESTORE / FINISH_RESTORE) are the
/// module-owned guest install-sequencing steps, which are NOT reconstruction and
/// must NOT bump that counter (it gates the "reference-free fork stays silent"
/// diagnostic). The shim still `call_indirect`s them; it just skips the bump.
const DRIVE_OP_RESTORE: i32 = 5;
/// op == run one activation's guest `wpk_fork_rewind_begin(root)` — the first
/// POINTER-argument drive op. Every op `>= DRIVE_OP_REWIND_BEGIN` drives a guest
/// export whose single parameter is the continuation `root` pointer (`i32` on
/// wasm32, `i64` on wasm64), NOT the `(i32)` activation id / recipe the RESTORE /
/// ALLOC family passes, so the shim reconstructs the pointer from the step's
/// `recipe` (high 32) / `arg` (low 32) fields and `call_indirect`s it through a
/// `(ptr) -> ()` type. MUST match `fork_codec::drive_plan::DRIVE_OP_REWIND_BEGIN`.
const DRIVE_OP_REWIND_BEGIN: i32 = 7;

/// The Rust helper the injected shim calls to map a recipe id to a catalog
/// ordinal (or the null sentinel). Exported by `crates/fork-module/src/lib.rs`.
const ORDINAL_HELPER_EXPORT: &str = "fm_funcref_ordinal";

/// The frozen guest import this tool makes the module export (see
/// `host/src/generated/abi.ts` `WPK_FORK_REFERENCE_IMPORT_DECODE_FUNCREF`).
const DECODE_FUNCREF_EXPORT: &str = "__wpk_fork_ref_decode_funcref";

/// The guest's function catalog funcref table the shim reads with `table.get`.
/// Injected+exported by fork-instrument as `FUNCTION_CATALOG_EXPORT`; the host
/// supplies a matching funcref table to the fork-module import (a host-owned
/// mirror populated from the guest's catalog — identical funcref identities).
const FUNCTION_CATALOG_IMPORT: &str = "__wpk_fork_function_catalog";
const IMPORT_MODULE: &str = "env";

/// The `NULL_ORDINAL` sentinel `fm_funcref_ordinal` returns for a Null recipe;
/// must stay in sync with `crates/fork-module/src/lib.rs`.
const NULL_ORDINAL: i32 = -1;

/// The single residual externref host import (M2). `resolve_externref(handle:i32)
/// -> externref` materializes a captured broker handle into its canonical host
/// token. It is reference-RETURNING, so Rust cannot declare or call it — both the
/// injected `__wpk_fork_ref_decode_externref` export and the
/// DRIVE_OP_EXTERNREF_TRANSIT branch of `fm_drive_execute` call it from wasm. The
/// host materialize cache is idempotent, so a direct per-reference resolve yields
/// the same canonical token every time (identity at the source, not by compare).
const RESOLVE_EXTERNREF_IMPORT: &str = "resolve_externref";

/// The Rust helper the injected binder calls to map an externref recipe id to its
/// captured broker `handle` (`i32`), which it then feeds to `resolve_externref`.
/// Exported by `crates/fork-module/src/lib.rs`; traps on any inconsistency.
const EXTERNREF_HANDLE_HELPER_EXPORT: &str = "fm_externref_handle";

/// The frozen guest import this tool makes the module export (see
/// `host/src/generated/abi.ts` `WPK_FORK_REFERENCE_IMPORT_DECODE_EXTERNREF`). Its
/// body is a DIRECT `resolve_externref(fm_externref_handle(recipe))` — no table,
/// no null branch: a valid recipe always resolves to the canonical token and the
/// helper traps on any inconsistency.
const DECODE_EXTERNREF_EXPORT: &str = "__wpk_fork_ref_decode_externref";

fn inject(module: &mut Module) -> Result<()> {
    // Idempotency / sanity: never double-inject.
    if module
        .exports
        .iter()
        .any(|export| export.name == DECODE_FUNCREF_EXPORT)
    {
        bail!("module already exports {DECODE_FUNCREF_EXPORT}");
    }

    // Locate the Rust helper export the shim will call.
    let helper = module
        .exports
        .iter()
        .find(|export| export.name == ORDINAL_HELPER_EXPORT)
        .ok_or_else(|| anyhow!("module does not export {ORDINAL_HELPER_EXPORT}"))?;
    let helper_fn = match helper.item {
        ExportItem::Function(id) => id,
        _ => bail!("{ORDINAL_HELPER_EXPORT} export is not a function"),
    };

    // Import the guest's function catalog funcref table (initial size 0; the host
    // grows/populates the mirror it supplies before the shim ever reads it).
    let (catalog, _import_id) = module.add_import_table(
        IMPORT_MODULE,
        FUNCTION_CATALOG_IMPORT,
        false,
        0,
        None,
        RefType::FUNCREF,
    );

    // Build `(i32) -> funcref`.
    let funcref = ValType::Ref(RefType::FUNCREF);
    let mut builder = FunctionBuilder::new(&mut module.types, &[ValType::I32], &[funcref]);
    let recipe = module.locals.add(ValType::I32);
    let ordinal = module.locals.add(ValType::I32);
    {
        let mut body = builder.func_body();
        body.local_get(recipe)
            .call(helper_fn)
            .local_set(ordinal)
            .local_get(ordinal)
            .i32_const(NULL_ORDINAL)
            .binop(BinaryOp::I32Eq)
            .if_else(
                Some(funcref),
                |then| {
                    // Null recipe -> ref.null func.
                    then.ref_null(RefType::FUNCREF);
                },
                |els| {
                    // Funcref recipe -> table.get(catalog, ordinal). The helper
                    // has already bounds-checked the recipe and traps on any
                    // inconsistency, so a non-negative ordinal here is valid.
                    els.local_get(ordinal).table_get(catalog);
                },
            );
    }
    let shim = builder.finish(vec![recipe], &mut module.funcs);
    module.exports.add(DECODE_FUNCREF_EXPORT, shim);
    Ok(())
}

/// Find or add the single residual externref host import
/// `env.resolve_externref(handle:i32) -> externref`. Both injection sites — the
/// `__wpk_fork_ref_decode_externref` decode export and the
/// DRIVE_OP_EXTERNREF_TRANSIT branch of `fm_drive_execute` — call it, so this
/// find-or-add (mirroring `fork-instrument/src/legacy_dlopen.rs`) keeps the two
/// passes order-independent and declares the import exactly once. Rust cannot
/// declare a reference-returning import, which is exactly why it lives here.
fn import_resolve_externref(module: &mut Module) -> FunctionId {
    let params = [ValType::I32];
    let results = [ValType::Ref(RefType::EXTERNREF)];
    if let Some(function) = module.imports.iter().find_map(|import| {
        if import.module != IMPORT_MODULE || import.name != RESOLVE_EXTERNREF_IMPORT {
            return None;
        }
        let ImportKind::Function(function) = import.kind else {
            return None;
        };
        let signature = module.types.get(module.funcs.get(function).ty());
        (signature.params() == params && signature.results() == results).then_some(function)
    }) {
        return function;
    }
    let ty = module.types.add(&params, &results);
    module.add_import_func(IMPORT_MODULE, RESOLVE_EXTERNREF_IMPORT, ty).0
}

/// Inject the fork-module's `__wpk_fork_ref_decode_externref` export (M2).
///
/// The frozen guest import `__wpk_fork_ref_decode_externref(recipeId) ->
/// externref` must RETURN a real `externref`. A WebAssembly module can only
/// produce one by reading an imported externref `table` or by CALLING an import
/// whose result is `externref` — it cannot fabricate one from an integer. Rust
/// has no `externref` type, so the fork-module (a Rust cdylib) cannot itself
/// export this function.
///
/// This shim closes that gap. Unlike the funcref decode (which `table.get`s a
/// catalog), the externref decode is a DIRECT call chain — the design ruling
/// removed the module-owned extern table because the host materialize cache is
/// idempotent, so resolving per reference always yields the same canonical token:
///
/// ```wat
/// (func (export "__wpk_fork_ref_decode_externref") (param $recipe i32) (result externref)
///   (call $resolve_externref (call $fm_externref_handle (local.get $recipe))))
/// ```
///
/// The real work — decoding the reference graph, mapping a recipe to a captured
/// broker handle, admitting only externref/null, trapping on corruption — lives
/// in the module's Rust `fm_externref_handle` helper; this tool only adds the
/// externref-returning wrapper Rust cannot express and the residual
/// `env.resolve_externref` import it calls.
fn inject_decode_externref(module: &mut Module) -> Result<()> {
    // Idempotency / sanity: never double-inject.
    if module
        .exports
        .iter()
        .any(|export| export.name == DECODE_EXTERNREF_EXPORT)
    {
        bail!("module already exports {DECODE_EXTERNREF_EXPORT}");
    }

    // Locate the Rust helper export the shim will call to map a recipe to its
    // captured broker handle.
    let helper = module
        .exports
        .iter()
        .find(|export| export.name == EXTERNREF_HANDLE_HELPER_EXPORT)
        .ok_or_else(|| anyhow!("module does not export {EXTERNREF_HANDLE_HELPER_EXPORT}"))?;
    let helper_fn = match helper.item {
        ExportItem::Function(id) => id,
        _ => bail!("{EXTERNREF_HANDLE_HELPER_EXPORT} export is not a function"),
    };

    // The single residual externref host import (find-or-add; the drive-execute
    // pass shares it).
    let resolve_fn = import_resolve_externref(module);

    // Build `(i32) -> externref`.
    let externref = ValType::Ref(RefType::EXTERNREF);
    let mut builder = FunctionBuilder::new(&mut module.types, &[ValType::I32], &[externref]);
    let recipe = module.locals.add(ValType::I32);
    {
        let mut body = builder.func_body();
        // resolve_externref(fm_externref_handle(recipe)): DIRECT, no table, no
        // null branch — a valid recipe resolves to the canonical token and the
        // helper traps on any inconsistency.
        body.local_get(recipe).call(helper_fn).call(resolve_fn);
    }
    let shim = builder.finish(vec![recipe], &mut module.funcs);
    module.exports.add(DECODE_EXTERNREF_EXPORT, shim);
    Ok(())
}

/// Inject `fm_drive_execute(plan_ptr, count)` (Phase 6 item 3b/3c): a wasm loop
/// that strides a serialized drive PLAN, `call_indirect`s the host-bound
/// `__wpk_fork_drive_table` for each step, and after each ALLOC step asserts the
/// guest's `_gc_allocate` published a live GC object into the shared Wasm-GC
/// transit table (`env.__wpk_fork_ref_gc_transit`, STORE #2) at slot `recipe + 1`
/// by reading it back with `table.get` + `ref.is_null`. Rust cannot emit
/// `call_indirect`, `table.get`, or hold an `anyref`, so this static wasm loop is
/// the mechanism the module's Rust drive planner cannot express itself.
///
/// The store-#2 read replaces the earlier store-#1 read (a `call` into the Rust
/// `fm_after_alloc`, which read the HOST-externref transit the exnref/externref
/// PHASE B publishes into): a struct/array/i31 aggregate never gets a HOST
/// identity, so store #1 was always empty for exactly the recipes the drive
/// ALLOCs, and every typed drive trapped. Store #2 is the table the guest's
/// `allocate` export actually publishes into and `_gc_fill` consumes, so a live
/// slot there is the real post-allocate integrity invariant.
///
/// ```wat
/// (func (export "fm_drive_execute") (param $plan i32) (param $count i32)
///   (local $i i32) (local $step i32) (local $op i32)
///   (loop $lp
///     (if (i32.ge_u (local.get $i) (local.get $count))
///       (then)                                   ;; done -> fall out of the loop
///       (else
///         (local.set $step (i32.add (local.get $plan)
///                                   (i32.mul (local.get $i) (i32.const 16))))
///         (local.set $op (i32.load offset=0 (local.get $step)))
///         ;; call_indirect guest[slot](arg)
///         (call_indirect (type (i32)->())
///           (i32.load offset=12 (local.get $step))          ;; arg
///           (i32.load offset=4  (local.get $step)))          ;; slot
///         (if (i32.eqz (local.get $op))                       ;; ALLOC?
///           (then                                             ;; store-#2 R1 guard
///             (if (ref.is_null
///                   (table.get $__wpk_fork_ref_gc_transit
///                     (i32.add (i32.load offset=8 (local.get $step))
///                              (i32.const 1))))               ;; recipe + 1
///               (then (unreachable)))))                        ;; missing = GC corruption
///         (local.set $i (i32.add (local.get $i) (i32.const 1)))
///         (br $lp)))))
/// ```
fn inject_drive_execute(module: &mut Module) -> Result<()> {
    if module
        .exports
        .iter()
        .any(|export| export.name == DRIVE_EXECUTE_EXPORT)
    {
        bail!("module already exports {DRIVE_EXECUTE_EXPORT}");
    }

    // Locate the Rust drive-step counter the shim `call`s once per driven step
    // (Phase 6 item 3c proof-of-use). Rust owns the counter; the injected loop
    // owns the `call_indirect` it counts.
    let bump = module
        .exports
        .iter()
        .find(|export| export.name == DRIVE_BUMP_HELPER_EXPORT)
        .ok_or_else(|| anyhow!("module does not export {DRIVE_BUMP_HELPER_EXPORT}"))?;
    let bump_fn = match bump.item {
        ExportItem::Function(id) => id,
        _ => bail!("{DRIVE_BUMP_HELPER_EXPORT} export is not a function"),
    };

    // Locate the Rust static-root slot helper the shim `call`s on a
    // DRIVE_OP_STATIC_ROOT step to map a recipe to its merged anyref-catalog index
    // (the static-root binder). Rust owns the recipe decode + per-activation base;
    // the injected shim owns the `table.get`/`table.set` a Rust anyref cannot hold.
    let slot_helper = module
        .exports
        .iter()
        .find(|export| export.name == STATIC_ROOT_SLOT_HELPER_EXPORT)
        .ok_or_else(|| anyhow!("module does not export {STATIC_ROOT_SLOT_HELPER_EXPORT}"))?;
    let slot_helper_fn = match slot_helper.item {
        ExportItem::Function(id) => id,
        _ => bail!("{STATIC_ROOT_SLOT_HELPER_EXPORT} export is not a function"),
    };

    // Locate the Rust externref-handle helper the shim `call`s on a
    // DRIVE_OP_EXTERNREF_TRANSIT step to map a recipe to its captured broker
    // handle. Rust owns the recipe decode; the injected shim owns the
    // `resolve_externref` call + `any.convert_extern` + `table.set` a Rust
    // externref/anyref cannot hold.
    let externref_helper = module
        .exports
        .iter()
        .find(|export| export.name == EXTERNREF_HANDLE_HELPER_EXPORT)
        .ok_or_else(|| anyhow!("module does not export {EXTERNREF_HANDLE_HELPER_EXPORT}"))?;
    let externref_helper_fn = match externref_helper.item {
        ExportItem::Function(id) => id,
        _ => bail!("{EXTERNREF_HANDLE_HELPER_EXPORT} export is not a function"),
    };
    // The single residual externref host import (find-or-add; shared with the
    // decode-export pass).
    let resolve_externref_fn = import_resolve_externref(module);

    // The guest's single (imported) linear memory the plan bytes live in.
    let memory = module
        .memories
        .iter()
        .next()
        .map(|m| m.id())
        .ok_or_else(|| anyhow!("module has no linear memory"))?;
    // A memory64 guest addresses linear memory with i64; the plan pointer and the
    // step address must then be i64, and the loop counter is i64-extended before
    // the address math. A wasm32 guest keeps everything i32.
    let is64 = module.memories.get(memory).memory64;
    let ptr_ty = if is64 { ValType::I64 } else { ValType::I32 };

    // The mutable funcref drive table (initial size 0; the host provides a table
    // sized to the fork's activations and binds the guest exports into it).
    let (drive_table, _drive_import_id) = module.add_import_table(
        IMPORT_MODULE,
        DRIVE_TABLE_IMPORT,
        false,
        0,
        None,
        RefType::FUNCREF,
    );

    // The shared Wasm-GC transit table (STORE #2) the guest's `_gc_allocate`
    // publishes every reconstructed struct/array/i31 into at slot `recipe + 1`.
    // The shim reads it back after each ALLOC to assert a live object survived.
    //
    // M1: the fork-module OWNS the (ref null any) GC transit table and EXPORTS it,
    // so the guest imports the module's table (not a standalone JS provider). Rust
    // cannot emit an anyref table, so define it here in the injector.
    let transit_table = module.tables.add_local(false, 1, None, RefType::ANYREF);
    module.tables.get_mut(transit_table).name = Some(TRANSIT_TABLE_IMPORT.to_string());
    module.exports.add(TRANSIT_TABLE_IMPORT, transit_table);

    // The merged, host-owned static-root catalog (`anyref`) the shim reads with
    // `table.get` on a DRIVE_OP_STATIC_ROOT step. Initial size 0; the host grows
    // + populates it from the child's live static roots before the drive runs.
    let (static_root_catalog, _static_root_import_id) = module.add_import_table(
        IMPORT_MODULE,
        STATIC_ROOT_CATALOG_IMPORT,
        false,
        0,
        None,
        RefType::ANYREF,
    );

    // The guest `_gc_allocate`/`_gc_fill` signature the shim `call_indirect`s:
    // `(i32) -> ()` (see `WPK_FORK_REFERENCE_EXPORT_GC_ALLOCATE` in abi.ts). Also
    // the RESTORE / FINISH_RESTORE guest exports (`(i32 activation) -> ()`).
    let indirect_ty = module.types.add(&[ValType::I32], &[]);
    // The guest `wpk_fork_rewind_begin`/`wpk_fork_abort_begin` signature the shim
    // `call_indirect`s for a REWIND_BEGIN / ABORT_BEGIN step: `(ptr) -> ()`
    // (`i32` on wasm32 — identical to `indirect_ty` there — `i64` on wasm64).
    let ptr_indirect_ty = module.types.add(&[ptr_ty], &[]);

    let mut builder =
        FunctionBuilder::new(&mut module.types, &[ptr_ty, ValType::I32], &[]);
    let plan = module.locals.add(ptr_ty);
    let count = module.locals.add(ValType::I32);
    let i = module.locals.add(ValType::I32);
    let step = module.locals.add(ptr_ty);
    let op = module.locals.add(ValType::I32);
    // Holds the static-root `anyref` between `table.get(catalog)` and the
    // null-check / `table.set(transit)` on a DRIVE_OP_STATIC_ROOT step.
    let sr_val = module.locals.add(ValType::Ref(RefType::ANYREF));

    let mut loop_body = builder.dangling_instr_seq(None);
    let loop_id = loop_body.id();
    loop_body
        .local_get(i)
        .local_get(count)
        .binop(BinaryOp::I32GeU)
        .if_else(
            None,
            // i >= count: done — fall out of the loop (no `br`).
            |_done| {},
            // i < count: drive one step, then re-enter the loop.
            |work| {
                // step = plan + i * DRIVE_STEP_SIZE (pointer-width address math).
                if is64 {
                    work.local_get(i)
                        .unop(UnaryOp::I64ExtendUI32)
                        .i64_const(DRIVE_STEP_SIZE as i64)
                        .binop(BinaryOp::I64Mul)
                        .local_get(plan)
                        .binop(BinaryOp::I64Add)
                        .local_set(step);
                } else {
                    work.local_get(plan)
                        .local_get(i)
                        .i32_const(DRIVE_STEP_SIZE)
                        .binop(BinaryOp::I32Mul)
                        .binop(BinaryOp::I32Add)
                        .local_set(step);
                }
                // op = load[step + OFF_OP]
                work.local_get(step)
                    .load(
                        memory,
                        LoadKind::I32 { atomic: false },
                        MemArg { align: 4, offset: DRIVE_STEP_OFF_OP },
                    )
                    .local_set(op);
                // Proof-of-use (Phase 6 item 3c): count every RECONSTRUCTION step
                // the MODULE drives. A nonzero `fm_drive_steps_executed` after a
                // flag-on fork proves the module drove the typed order, not a JS
                // fallback. The child-install steps (RESTORE / FINISH_RESTORE, op
                // `>= DRIVE_OP_RESTORE`) are NOT reconstruction, so they are excluded
                // from this counter — it gates the "reference-free fork stays
                // silent" diagnostic (a scalar-only fork drives only install steps
                // and must leave every reference proof at zero).
                //   if op < DRIVE_OP_RESTORE { fm_drive_bump() }
                work.local_get(op)
                    .i32_const(DRIVE_OP_RESTORE)
                    .binop(BinaryOp::I32LtU)
                    .if_else(
                        None,
                        |recon| {
                            recon.call(bump_fn);
                        },
                        |_install| {},
                    );
                // Branch on the step op: a DRIVE_OP_STATIC_ROOT step drives NO
                // guest export — it is the static-root binder, a pure `table.get`
                // catalog + `table.set` transit. Every other op drives a guest
                // export via `call_indirect` on the host-bound drive table.
                //   if op == DRIVE_OP_STATIC_ROOT { static-root publish }
                //   else { call_indirect; if op == ALLOC { store-#2 assert } }
                // Table indices are i32 regardless of guest pointer width, so the
                // `recipe + 1` index math stays i32 on both wasm32 and wasm64.
                work.local_get(op)
                    .i32_const(DRIVE_OP_STATIC_ROOT)
                    .binop(BinaryOp::I32Eq);
                work.if_else(
                    None,
                    // STATIC_ROOT: publish the immutable static root into the anyref
                    // transit at slot `recipe + 1`.
                    //   sr_val = table.get(catalog, fm_static_root_slot(recipe))
                    //   if (ref.is_null sr_val) unreachable   ;; missing = corruption
                    //   table.set(transit, recipe + 1, sr_val)
                    |sr| {
                        sr.local_get(step)
                            .load(
                                memory,
                                LoadKind::I32 { atomic: false },
                                MemArg { align: 4, offset: DRIVE_STEP_OFF_RECIPE },
                            )
                            .call(slot_helper_fn)
                            .table_get(static_root_catalog)
                            .local_set(sr_val);
                        // Null slot: the host mirror never held this static root —
                        // real corruption, trap truthfully rather than publish null.
                        sr.local_get(sr_val).ref_is_null().if_else(
                            None,
                            |missing| {
                                missing.unreachable();
                            },
                            |_| {},
                        );
                        // table.set(transit, recipe + 1, sr_val): push index, value.
                        sr.local_get(step)
                            .load(
                                memory,
                                LoadKind::I32 { atomic: false },
                                MemArg { align: 4, offset: DRIVE_STEP_OFF_RECIPE },
                            )
                            .i32_const(1)
                            .binop(BinaryOp::I32Add)
                            .local_get(sr_val)
                            .table_set(transit_table);
                    },
                    // Non-static-root: either a DRIVE_OP_EXTERNREF_TRANSIT publish
                    // (op 4 — the externref binder, which also drives NO guest
                    // export) or a real guest-export drive via `call_indirect`.
                    //   if op == DRIVE_OP_EXTERNREF_TRANSIT { externref publish }
                    //   else { call_indirect; if op == ALLOC { store-#2 assert } }
                    |other| {
                        other
                            .local_get(op)
                            .i32_const(DRIVE_OP_EXTERNREF_TRANSIT)
                            .binop(BinaryOp::I32Eq);
                        other.if_else(
                            None,
                            // EXTERNREF_TRANSIT: materialize the externref through the
                            // residual `resolve_externref` host import, internalize it
                            // with `any.convert_extern`, and publish it into the anyref
                            // transit at slot `recipe + 1`.
                            //   table.set(transit, recipe + 1,
                            //     any.convert_extern(
                            //       resolve_externref(fm_externref_handle(recipe))))
                            //   if (ref.is_null (table.get transit recipe+1)) unreachable
                            // Identity is guaranteed at the SOURCE (idempotent host
                            // materialize); this NON-NULL check only verifies the slot
                            // survived (the M2 R1 guard — an internalized externref is
                            // not `ref.eq`-comparable on any engine).
                            |ext| {
                                // Push the transit index (recipe + 1) first...
                                ext.local_get(step)
                                    .load(
                                        memory,
                                        LoadKind::I32 { atomic: false },
                                        MemArg { align: 4, offset: DRIVE_STEP_OFF_RECIPE },
                                    )
                                    .i32_const(1)
                                    .binop(BinaryOp::I32Add)
                                    // ...then the value: internalize the resolved
                                    // externref into an anyref for the transit table.
                                    .local_get(step)
                                    .load(
                                        memory,
                                        LoadKind::I32 { atomic: false },
                                        MemArg { align: 4, offset: DRIVE_STEP_OFF_RECIPE },
                                    )
                                    .call(externref_helper_fn)
                                    .call(resolve_externref_fn)
                                    .instr(AnyConvertExtern {})
                                    .table_set(transit_table);
                                // NON-NULL structural check: read the slot back and
                                // trap if the publish did not survive.
                                ext.local_get(step)
                                    .load(
                                        memory,
                                        LoadKind::I32 { atomic: false },
                                        MemArg { align: 4, offset: DRIVE_STEP_OFF_RECIPE },
                                    )
                                    .i32_const(1)
                                    .binop(BinaryOp::I32Add)
                                    .table_get(transit_table)
                                    .ref_is_null()
                                    .if_else(
                                        None,
                                        // Empty slot: publish failed — trap truthfully.
                                        |missing| {
                                            missing.unreachable();
                                        },
                                        |_| {},
                                    );
                            },
                            // Real guest drive. Two shapes, split on the op:
                            //   op >= DRIVE_OP_REWIND_BEGIN (REWIND_BEGIN/ABORT_BEGIN):
                            //     the guest export takes the continuation ROOT pointer,
                            //     `call_indirect (ptr)->()`; the root is reconstructed
                            //     from recipe (high 32) / arg (low 32).
                            //   otherwise (ALLOC/FILL/EXN/RESTORE/FINISH_RESTORE):
                            //     `call_indirect (i32)->()` with `arg`, then (if ALLOC)
                            //     the store-#2 published-object assert.
                            |drive| {
                        drive
                            .local_get(op)
                            .i32_const(DRIVE_OP_REWIND_BEGIN)
                            .binop(BinaryOp::I32GeU);
                        drive.if_else(
                            None,
                            // Pointer-argument drive: call_indirect guest[slot](root).
                            |ptr_drive| {
                                if is64 {
                                    // root = (extend_u(recipe) << 32) | extend_u(arg)
                                    ptr_drive
                                        .local_get(step)
                                        .load(
                                            memory,
                                            LoadKind::I32 { atomic: false },
                                            MemArg { align: 4, offset: DRIVE_STEP_OFF_RECIPE },
                                        )
                                        .unop(UnaryOp::I64ExtendUI32)
                                        .i64_const(32)
                                        .binop(BinaryOp::I64Shl)
                                        .local_get(step)
                                        .load(
                                            memory,
                                            LoadKind::I32 { atomic: false },
                                            MemArg { align: 4, offset: DRIVE_STEP_OFF_ARG },
                                        )
                                        .unop(UnaryOp::I64ExtendUI32)
                                        .binop(BinaryOp::I64Or);
                                } else {
                                    // root = arg (whole i32 pointer; recipe is 0)
                                    ptr_drive.local_get(step).load(
                                        memory,
                                        LoadKind::I32 { atomic: false },
                                        MemArg { align: 4, offset: DRIVE_STEP_OFF_ARG },
                                    );
                                }
                                // slot (i32 table index) then call_indirect (ptr)->().
                                ptr_drive
                                    .local_get(step)
                                    .load(
                                        memory,
                                        LoadKind::I32 { atomic: false },
                                        MemArg { align: 4, offset: DRIVE_STEP_OFF_SLOT },
                                    )
                                    .instr(CallIndirect {
                                        ty: ptr_indirect_ty,
                                        table: drive_table,
                                    });
                            },
                            // (i32)-argument drive: the existing family.
                            |drive| {
                        // call_indirect guest[slot](arg): push arg, then slot.
                        drive
                            .local_get(step)
                            .load(
                                memory,
                                LoadKind::I32 { atomic: false },
                                MemArg { align: 4, offset: DRIVE_STEP_OFF_ARG },
                            )
                            .local_get(step)
                            .load(
                                memory,
                                LoadKind::I32 { atomic: false },
                                MemArg { align: 4, offset: DRIVE_STEP_OFF_SLOT },
                            )
                            .instr(CallIndirect { ty: indirect_ty, table: drive_table });
                        // if op == DRIVE_OP_ALLOC: assert the guest published a live
                        // GC object into STORE #2 at slot `recipe + 1`.
                        drive.local_get(op).i32_const(DRIVE_OP_ALLOC).binop(BinaryOp::I32Eq);
                        drive.if_else(
                            None,
                            |alloc| {
                                alloc
                                    .local_get(step)
                                    .load(
                                        memory,
                                        LoadKind::I32 { atomic: false },
                                        MemArg { align: 4, offset: DRIVE_STEP_OFF_RECIPE },
                                    )
                                    .i32_const(1)
                                    .binop(BinaryOp::I32Add)
                                    .table_get(transit_table)
                                    .ref_is_null()
                                    .if_else(
                                        None,
                                        // Null slot: the guest never published this
                                        // aggregate — real GC corruption, trap.
                                        |missing| {
                                            missing.unreachable();
                                        },
                                        |_| {},
                                    );
                            },
                            |_| {},
                        );
                            },
                        );
                            },
                        );
                    },
                );
                // i += 1; br $lp
                work.local_get(i)
                    .i32_const(1)
                    .binop(BinaryOp::I32Add)
                    .local_set(i);
                work.instr(Br { block: loop_id });
            },
        );
    drop(loop_body);

    let mut body = builder.func_body();
    body.instr(Loop { seq: loop_id });
    let shim = builder.finish(vec![plan, count], &mut module.funcs);
    module.exports.add(DRIVE_EXECUTE_EXPORT, shim);
    Ok(())
}

fn main() -> Result<()> {
    let mut args = std::env::args().skip(1);
    let input = args
        .next()
        .ok_or_else(|| anyhow!("usage: fork-module-inject <input.wasm> <output.wasm>"))?;
    let output = args
        .next()
        .ok_or_else(|| anyhow!("usage: fork-module-inject <input.wasm> <output.wasm>"))?;

    let bytes = std::fs::read(&input).with_context(|| format!("reading {input}"))?;
    let mut module = Module::from_buffer(&bytes).context("parsing fork-module wasm")?;
    inject(&mut module).context("injecting __wpk_fork_ref_decode_funcref")?;
    inject_decode_externref(&mut module).context("injecting __wpk_fork_ref_decode_externref")?;
    inject_drive_execute(&mut module).context("injecting fm_drive_execute")?;
    let out_bytes = module.emit_wasm();
    std::fs::write(&output, &out_bytes).with_context(|| format!("writing {output}"))?;
    eprintln!(
        "fork-module-inject: {input} -> {output} ({} bytes, added {DECODE_FUNCREF_EXPORT} + \
         {DECODE_EXTERNREF_EXPORT} + {DRIVE_EXECUTE_EXPORT} + exported {TRANSIT_TABLE_IMPORT} \
         (module-owned, M1) + imported {IMPORT_MODULE}.{{{FUNCTION_CATALOG_IMPORT}, \
         {DRIVE_TABLE_IMPORT}, {STATIC_ROOT_CATALOG_IMPORT}, {RESOLVE_EXTERNREF_IMPORT}}})",
        out_bytes.len()
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    //! M1 task 2: the injector must make the fork-module OWN + EXPORT the
    //! `(ref null any)` GC transit table (`__wpk_fork_ref_gc_transit`) rather
    //! than import it from a standalone JS-supplied table. This test builds a
    //! minimal fixture module exposing just the Rust helper exports the two
    //! `inject*` passes look up (`fm_funcref_ordinal`, `fm_drive_bump`,
    //! `fm_static_root_slot`) plus a linear memory, runs both injection passes
    //! against it exactly as `main` does, and re-parses the emitted bytes to
    //! assert on the resulting import/export sections. A real compiled
    //! `fork_module.wasm` isn't needed: the fixture only has to satisfy the
    //! lookups `inject`/`inject_drive_execute` perform.

    use super::*;

    /// Add a stub export `name: (params) -> results` whose body pushes a zero
    /// constant per result type. The injector never calls into these bodies in
    /// this test (it only needs the export *shape* to resolve `call`/
    /// `call_indirect` targets it wires up), so the bodies are placeholders.
    fn add_stub_export(
        module: &mut Module,
        name: &str,
        params: &[ValType],
        results: &[ValType],
    ) {
        let mut builder = FunctionBuilder::new(&mut module.types, params, results);
        let args: Vec<_> = params.iter().map(|ty| module.locals.add(*ty)).collect();
        {
            let mut body = builder.func_body();
            for result_ty in results {
                match result_ty {
                    ValType::I32 => {
                        body.i32_const(0);
                    }
                    other => panic!("add_stub_export: unsupported result type {other:?}"),
                }
            }
        }
        let f = builder.finish(args, &mut module.funcs);
        module.exports.add(name, f);
    }

    /// A minimal module exposing exactly the surface `inject` and
    /// `inject_drive_execute` require: the three Rust helper exports they look
    /// up by name, and a linear memory for `fm_drive_execute`'s address math.
    fn fixture_module() -> Module {
        let mut module = Module::default();
        module.memories.add_local(false, false, 1, None, None);

        add_stub_export(&mut module, ORDINAL_HELPER_EXPORT, &[ValType::I32], &[ValType::I32]);
        add_stub_export(&mut module, DRIVE_BUMP_HELPER_EXPORT, &[], &[]);
        add_stub_export(
            &mut module,
            STATIC_ROOT_SLOT_HELPER_EXPORT,
            &[ValType::I32],
            &[ValType::I32],
        );
        // M2: the externref decode export + the DRIVE_OP_EXTERNREF_TRANSIT branch
        // both look up the guest `fm_externref_handle(recipe) -> handle` helper.
        add_stub_export(
            &mut module,
            EXTERNREF_HANDLE_HELPER_EXPORT,
            &[ValType::I32],
            &[ValType::I32],
        );

        module
    }

    /// Count every `any.convert_extern` instruction in a local function body.
    /// The externref-transit drive branch is the only place the injector emits
    /// one (the funcref/externref decode exports never do), so a nonzero count in
    /// `fm_drive_execute` is proof the DRIVE_OP_EXTERNREF_TRANSIT path was built.
    #[derive(Default)]
    struct AnyConvertExternCounter {
        count: usize,
    }
    impl<'instr> walrus::ir::Visitor<'instr> for AnyConvertExternCounter {
        fn visit_instr(
            &mut self,
            instr: &'instr walrus::ir::Instr,
            _loc: &'instr walrus::InstrLocId,
        ) {
            if matches!(instr, walrus::ir::Instr::AnyConvertExtern(_)) {
                self.count += 1;
            }
        }
    }

    fn any_convert_extern_count(module: &Module, export_name: &str) -> usize {
        let export = module
            .exports
            .iter()
            .find(|export| export.name == export_name)
            .expect("export present");
        let ExportItem::Function(id) = export.item else {
            panic!("{export_name} is not a function export");
        };
        let local = module.funcs.get(id).kind.unwrap_local();
        let mut counter = AnyConvertExternCounter::default();
        walrus::ir::dfs_in_order(&mut counter, local, local.entry_block());
        counter.count
    }

    #[test]
    fn injects_externref_decode_export_and_resolve_import() {
        let mut module = fixture_module();
        inject(&mut module).expect("inject __wpk_fork_ref_decode_funcref");
        inject_decode_externref(&mut module).expect("inject __wpk_fork_ref_decode_externref");
        inject_drive_execute(&mut module).expect("inject fm_drive_execute");

        let out_bytes = module.emit_wasm();
        let reparsed = Module::from_buffer(&out_bytes).expect("reparse injected module");

        // (a) The output IMPORTS env.resolve_externref : (i32) -> externref.
        let resolve_import = reparsed
            .imports
            .iter()
            .find(|import| {
                import.module == IMPORT_MODULE && import.name == RESOLVE_EXTERNREF_IMPORT
            })
            .expect("resolve_externref must be imported after injection");
        let ImportKind::Function(resolve_fn) = resolve_import.kind else {
            panic!("resolve_externref import must be a function");
        };
        let resolve_sig = reparsed.types.get(reparsed.funcs.get(resolve_fn).ty());
        assert_eq!(resolve_sig.params(), &[ValType::I32]);
        assert_eq!(
            resolve_sig.results(),
            &[ValType::Ref(RefType::EXTERNREF)],
            "resolve_externref must return an externref"
        );
        // find-or-add must never double-declare the import.
        assert_eq!(
            reparsed
                .imports
                .iter()
                .filter(|import| import.module == IMPORT_MODULE
                    && import.name == RESOLVE_EXTERNREF_IMPORT)
                .count(),
            1,
            "resolve_externref must be imported exactly once"
        );

        // (b) The output EXPORTS __wpk_fork_ref_decode_externref : (i32) -> externref.
        let decode = reparsed
            .exports
            .iter()
            .find(|export| export.name == DECODE_EXTERNREF_EXPORT)
            .expect("must export the externref decode shim");
        let ExportItem::Function(decode_fn) = decode.item else {
            panic!("{DECODE_EXTERNREF_EXPORT} export must be a function");
        };
        let decode_sig = reparsed.types.get(reparsed.funcs.get(decode_fn).ty());
        assert_eq!(decode_sig.params(), &[ValType::I32]);
        assert_eq!(
            decode_sig.results(),
            &[ValType::Ref(RefType::EXTERNREF)],
            "the decode export must return an externref"
        );

        // (c) The fm_drive_execute body contains the op-4 externref-transit path:
        // exactly one `any.convert_extern` (extern -> any) lives in the drive loop;
        // the decode export never emits one. Re-parse above already re-validated the
        // whole module, so a live count here proves the branch encodes correctly.
        assert!(
            reparsed
                .exports
                .iter()
                .any(|export| export.name == DRIVE_EXECUTE_EXPORT),
            "fm_drive_execute must still be exported"
        );
        assert_eq!(
            any_convert_extern_count(&reparsed, DRIVE_EXECUTE_EXPORT),
            1,
            "fm_drive_execute must contain exactly one any.convert_extern (the op-4 branch)"
        );
        assert_eq!(
            any_convert_extern_count(&reparsed, DECODE_EXTERNREF_EXPORT),
            0,
            "the externref decode shim must be a direct resolve call, no any.convert_extern"
        );
    }

    #[test]
    fn transit_table_is_module_owned_export_not_import() {
        let mut module = fixture_module();
        inject(&mut module).expect("inject __wpk_fork_ref_decode_funcref");
        inject_drive_execute(&mut module).expect("inject fm_drive_execute");

        // Round-trip through bytes and re-parse with a fresh walrus `Module`,
        // so the assertion reflects what actually lands in the wasm binary's
        // import/export sections, not just in-memory IR state.
        let out_bytes = module.emit_wasm();
        let reparsed = Module::from_buffer(&out_bytes).expect("reparse injected module");

        let still_imported = reparsed
            .imports
            .iter()
            .any(|import| import.name == TRANSIT_TABLE_IMPORT);
        assert!(
            !still_imported,
            "{TRANSIT_TABLE_IMPORT} must no longer be an import after injection (M1)"
        );

        let exported_as_table = reparsed.exports.iter().any(|export| {
            export.name == TRANSIT_TABLE_IMPORT && matches!(export.item, ExportItem::Table(_))
        });
        assert!(
            exported_as_table,
            "{TRANSIT_TABLE_IMPORT} must be exported as a table after injection (M1)"
        );

        // The other imported tables (function catalog, drive table, static-root
        // catalog) are unaffected by this change and must still be imports.
        for still_import_name in [
            FUNCTION_CATALOG_IMPORT,
            DRIVE_TABLE_IMPORT,
            STATIC_ROOT_CATALOG_IMPORT,
        ] {
            assert!(
                reparsed
                    .imports
                    .iter()
                    .any(|import| import.name == still_import_name),
                "{still_import_name} should remain imported"
            );
        }
    }
}
