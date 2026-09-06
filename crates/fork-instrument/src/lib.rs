//! `fork-instrument` — compile-time instrumentation of wasm binaries
//! to support POSIX `fork()` semantics via stack serialization.
//!
//! See `docs/plans/2026-04-20-fork-instrumentation-design.md` for the
//! full design.
//!
//! The ABI 43 transform discovers the direct/indirect fork closure, assigns
//! every replay value to activation-owned bytes or a versioned reconstruction
//! recipe, and emits the linked-frame state machine. Scalars are serialized in
//! the activation frame; references, complete exceptions, mutable reference
//! globals, and table entries are reconstructed from a process-owned typed
//! recipe graph in each fresh module instance.

use anyhow::{Context, Result, bail, ensure};
use walrus::{
    ElementItems, ElementKind, FunctionBuilder, FunctionId, RawCustomSection, RefType, TableId,
    ValType, ir::Value,
};
use wasm_posix_shared::ABI_VERSION;
use wasm_posix_shared::abi::{
    WPK_FORK_CAP_ACTIVATION_STATE_SAFE, WPK_FORK_CAP_DYLINK_MAIN, WPK_FORK_CAP_SIDE_ENTRY,
    WPK_FORK_CAPABILITIES_SECTION, WPK_FORK_CAPABILITIES_VERSION,
    WPK_FORK_GLOBAL_CATALOG_EXPORT_PREFIX, WPK_FORK_IMPORTED_TABLES_SECTION,
    WPK_FORK_MODULE_STATE_ARENA_VERSION, WPK_FORK_MODULE_STATE_DESCRIPTOR_SIZE,
    WPK_FORK_MODULE_STATE_FORMAT_MAGIC, WPK_FORK_MODULE_STATE_FORMAT_SECTION,
    WPK_FORK_MODULE_STATE_FORMAT_VERSION, WPK_FORK_MODULE_STATE_RECORD_ALIGNMENT,
    WPK_FORK_MODULE_STATE_RECORD_VERSION, WPK_FORK_MODULE_STATE_REQUIRED_FLAGS,
    WPK_FORK_MODULE_STATE_ROOT_POINTER_WORD_OFFSET, WPK_FORK_REQUIRED_EXPORTS,
    WPK_FORK_REQUIRED_IMPORTS, WPK_FORK_TABLE_CATALOG_EXPORT_PREFIX,
    WPK_FORK_UNWIND_TRANSPORT_PAYLOAD_ARITY, WPK_FORK_UNWIND_TRANSPORT_SECTION,
    WPK_FORK_UNWIND_TRANSPORT_VERSION,
};
use wasmparser::{Parser, Payload};

pub mod call_graph;
pub mod contract_inventory;
pub mod instrument;
pub mod legacy_eh;
pub mod legacy_dlopen;
pub mod linked_frames;
pub mod module_exception_codec;
pub mod module_gc_codec;
pub mod module_state;
pub mod reference_analysis;
pub mod runtime;
pub mod static_reference_catalog;

/// Fresh instances rebuild this fixed catalog from the module's static element
/// segment, so a funcref recipe needs only a module activation and ordinal.
pub const FUNCTION_CATALOG_EXPORT: &str = "__wpk_fork_function_catalog";

/// Declares that unwind completion is transported by the private
/// `env.__wpk_fork_unwind` zero-payload tag rather than synthesized function
/// results.
pub const UNWIND_TRANSPORT_SECTION: &str = WPK_FORK_UNWIND_TRANSPORT_SECTION;
pub const UNWIND_TRANSPORT_VERSION: u8 = WPK_FORK_UNWIND_TRANSPORT_VERSION;

fn reject_preinstrumented_artifact(module: &walrus::Module) -> Result<()> {
    let has_control_export = module.exports.iter().any(|export| {
        WPK_FORK_REQUIRED_EXPORTS
            .iter()
            .any(|requirement| requirement.name == export.name)
    });
    let has_frame_import = module.imports.iter().any(|import| {
        WPK_FORK_REQUIRED_IMPORTS.iter().any(|requirement| {
            requirement.module == import.module && requirement.name == import.name
        })
    });
    let has_fork_metadata = module.customs.iter().any(|(_, section)| {
        matches!(
            section.name(),
            WPK_FORK_CAPABILITIES_SECTION
                | linked_frames::LINKED_FRAME_FORMAT_SECTION
                | module_exception_codec::FORMAT_SECTION
                | WPK_FORK_MODULE_STATE_FORMAT_SECTION
                | WPK_FORK_IMPORTED_TABLES_SECTION
                | instrument::RESUME_CATALOG_SECTION
                | static_reference_catalog::FORMAT_SECTION
                | UNWIND_TRANSPORT_SECTION
        )
    }) || module.exports.iter().any(|export| {
        matches!(
            export.name.as_str(),
            FUNCTION_CATALOG_EXPORT
                | instrument::RESUME_CATALOG_EXPORT
                | instrument::RESUME_START_EXPORT
                | instrument::RESUME_THREAD_EXPORT
                | static_reference_catalog::EXPORT
                | static_reference_catalog::HARVEST_EXPORT
        )
    }) || module.exports.iter().any(|export| {
        export
            .name
            .starts_with(WPK_FORK_GLOBAL_CATALOG_EXPORT_PREFIX)
            || export
                .name
                .starts_with(WPK_FORK_TABLE_CATALOG_EXPORT_PREFIX)
    });
    if has_control_export || has_frame_import || has_fork_metadata {
        // WHY: restamping an ABI 42 transform would certify code whose frames
        // may still name parent-instance reference-table slots. Always rebuild
        // from the raw linker output so the ABI 43 validator sees the original
        // activation and table state.
        bail!(
            "fork-instrument: input already contains wasm-fork-instrument \
             imports, exports, or metadata; rebuild and instrument the raw \
             linker output instead of restamping an older artifact"
        );
    }
    Ok(())
}

fn reject_reserved_unwind_import(module: &walrus::Module) -> Result<()> {
    let collides = module.imports.iter().any(|import| {
        if import.module != runtime::names::IMPORT_UNWIND_TAG_MODULE {
            return false;
        }
        module_exception_codec::is_reserved_host_import(&import.name)
            || matches!(
                import.name.as_str(),
                runtime::names::IMPORT_UNWIND_TAG
                    | runtime::names::IMPORT_REF_ENCODE_FUNCREF
                    | runtime::names::IMPORT_REF_DECODE_FUNCREF
                    | runtime::names::IMPORT_REF_ENCODE_EXTERNREF
                    | runtime::names::IMPORT_REF_DECODE_EXTERNREF
                    | runtime::names::IMPORT_REF_ENCODE_EXNREF
                    | runtime::names::IMPORT_REF_DECODE_EXNREF
                    | runtime::names::IMPORT_REF_ENCODE_ANYREF
                    | runtime::names::IMPORT_REF_DECODE_ANYREF
            )
    });
    ensure!(
        !collides,
        "fork-instrument: input already imports a reserved private fork runtime \
         hook from `{}`; the instrumenter must own unwind transport and reference \
         reconstruction imports",
        runtime::names::IMPORT_UNWIND_TAG_MODULE,
    );
    Ok(())
}

/// Options controlling instrumentation. Fields will grow as phases
/// land; a `Default` implementation keeps call sites stable.
#[derive(Debug, Clone)]
pub struct Options {
    /// The fully-qualified name of the import whose callers should be
    /// instrumented. Format: `module.field` (e.g.
    /// `kernel.kernel_fork`). This import seeds call-graph discovery in a
    /// main module. `env.fork` selects complete side-module boundary coverage:
    /// every function import and unresolved reference dispatch becomes a
    /// possible cross-instance fork boundary.
    pub entry_import: String,

    /// A second seed import, added to the closure beside `entry_import` rather
    /// than replacing it. Format: `module.field` (e.g.
    /// `kernel.kernel_checkpoint`).
    ///
    /// A checkpoint unwinds at a syscall return, so this seed discovers every
    /// function that can be live there. A program that never forks imports no
    /// `kernel_fork` and is 0 % instrumented without it.
    ///
    /// It must add to the seeds, never replace them. Discovery walks a seed's
    /// callers and never descends into callees, so an import joins the closure
    /// only by being a seed itself. Naming the checkpoint import through
    /// `entry_import` instead would drop `kernel_fork` from the closure, leave
    /// its call site without unwind transport, and hand the guest the
    /// ignored-during-unwind fork result, which it reads as the child.
    pub checkpoint_import: Option<String>,
}

impl Default for Options {
    fn default() -> Self {
        Self {
            entry_import: "kernel.kernel_fork".into(),
            checkpoint_import: None,
        }
    }
}

/// Result of analyzing an input module without rewriting it.
#[derive(Debug)]
pub struct Analysis {
    /// Function entries that must be instrumented for fork support.
    /// Sorted by display name; stable across runs.
    pub fork_path: Vec<call_graph::FuncEntry>,
}

/// Analyze `input` to compute the set of functions that need
/// instrumentation, without mutating or re-emitting the module.
///
/// Phase 2 scope: direct-call closure only. Phase 3 extends to
/// indirect calls.
pub fn analyze(input: &[u8], opts: &Options) -> Result<Analysis> {
    let mut module =
        walrus::Module::from_buffer(input).context("failed to parse input wasm module")?;
    legacy_dlopen::lower(&mut module)?;
    let side_boundaries = uses_side_module_boundaries(&module, opts);
    let entry_imports = call_graph::find_import_funcs(&module, &opts.entry_import);
    let boundary_imports = boundary_seed_imports(&module, opts, &entry_imports);

    if boundary_imports.is_empty()
        && !side_boundaries
        && !call_graph::has_dynamic_linker_imports(&module)
    {
        let checkpoint = match opts.checkpoint_import.as_deref() {
            Some(name) => format!(" and checkpoint import `{name}`"),
            None => String::new(),
        };
        bail!(
            "entry import `{}`{checkpoint} not found (or not a function) in \
             the module. If this module does not use fork, there is nothing \
             to instrument.",
            opts.entry_import
        );
    }

    let seeds = fork_boundary_seeds(&module, &boundary_imports, side_boundaries);
    let reaching = prepare_fork_path(
        &module,
        &seeds,
        side_boundaries || call_graph::has_dynamic_linker_imports(&module),
    );
    let fork_path = call_graph::summarize(&module, &reaching.activations);
    Ok(Analysis { fork_path })
}

fn uses_side_module_boundaries(module: &walrus::Module, opts: &Options) -> bool {
    // `--entry env.fork` is the historical side-module invocation. ABI 43
    // broadens that role from one named import to every cross-module call
    // boundary. Auto-detecting dylink.0 also protects side modules that do not
    // import fork themselves but can remain live above a downstream fork.
    opts.entry_import == "env.fork"
        || module
            .customs
            .iter()
            .any(|(_, section)| section.name() == "dylink.0")
}

/// Bind an instrumented dylink artifact to the ABI epoch its capability bits
/// describe. Ordinary Wasm side modules do not carry Kandelo's executable
/// marker, but after instrumentation the host must distinguish the current
/// fork contract from otherwise identical metadata emitted by an older tool.
fn ensure_side_module_abi_version(module: &mut walrus::Module, input: &[u8]) -> Result<()> {
    use contract_inventory::ArtifactAbiVersion;

    match contract_inventory::artifact_identity(input)
        .context("inspect side-module ABI identity before instrumentation")?
        .abi_version
    {
        ArtifactAbiVersion::Present(version) if version == ABI_VERSION => return Ok(()),
        ArtifactAbiVersion::Present(version) => bail!(
            "side module declares stale __abi_version {version}; expected current ABI {ABI_VERSION}"
        ),
        ArtifactAbiVersion::Invalid => bail!(
            "side module has an invalid __abi_version export; expected a constant current ABI marker"
        ),
        ArtifactAbiVersion::Missing => {}
    }

    let mut builder = FunctionBuilder::new(&mut module.types, &[], &[ValType::I32]);
    builder.name("__abi_version".into());
    builder.func_body().i32_const(ABI_VERSION as i32);
    let function = builder.finish(Vec::new(), &mut module.funcs);
    module.exports.add("__abi_version", function);
    Ok(())
}

/// The boundary imports that seed discovery: `entry_import`, plus
/// `checkpoint_import` when one is named.
///
/// `entry_imports` is passed in rather than recomputed because the caller also
/// needs it on its own, to decide the fork capability claim. That claim must
/// describe the fork boundary only, so it must not see the checkpoint seed.
fn boundary_seed_imports(
    module: &walrus::Module,
    opts: &Options,
    entry_imports: &[walrus::FunctionId],
) -> Vec<walrus::FunctionId> {
    let Some(checkpoint) = opts.checkpoint_import.as_deref() else {
        return entry_imports.to_vec();
    };

    let mut imports = entry_imports.to_vec();
    imports.extend(call_graph::find_import_funcs(module, checkpoint));
    imports.sort();
    imports.dedup();
    imports
}

fn fork_boundary_seeds(
    module: &walrus::Module,
    entry_imports: &[walrus::FunctionId],
    side_boundaries: bool,
) -> Vec<walrus::FunctionId> {
    if side_boundaries {
        call_graph::imported_functions(module)
    } else {
        let mut seeds = entry_imports.to_vec();
        // A raw legacy import is a direct boundary when this helper is used
        // before lowering. In the normal ABI 43 pipeline, lowering replaces it
        // with an ordinary driver call_indirect; external dynamic-dispatch
        // discovery then owns that boundary and every surviving caller.
        seeds.extend(call_graph::dynamic_linker_imported_functions(module));
        seeds.sort();
        seeds.dedup();
        seeds
    }
}

/// Compute both the surviving activation set and the full semantic control
/// closure. Tail callers remain transparent and retain their bounded-stack
/// `return_call*` semantics; replay bypasses them when the continuation owns a
/// deeper activation frame.
fn prepare_fork_path(
    module: &walrus::Module,
    seeds: &[walrus::FunctionId],
    external_dynamic_dispatch: bool,
) -> call_graph::ReachingAnalysis {
    call_graph::analyze_reaching_closure_from_seeds(
        module,
        seeds.iter().copied(),
        external_dynamic_dispatch,
    )
}

/// Instruments `input` (a complete wasm binary) according to `opts`
/// and returns the transformed binary.
///
/// The complete transform includes runtime scaffolding, per-function
/// switch-dispatch, linked-frame save/restore, mutable scalar-global
/// save/restore, and activation-owned tagged-catch replay.
///
/// Executable modules that have no configured fork entry, dynamic-loader
/// boundary, or side-module role are returned byte-for-byte unchanged. Such a
/// module cannot participate in a fork transaction, and injecting reference
/// codecs would needlessly require those Wasm features on every host.
///
/// Dynamic-loader-capable mains and side modules still receive the uniform
/// activation-state helpers even when they do not import fork directly. They
/// can remain live beside a fork-capable activation, so their mutable globals,
/// tables, and segment lifetimes remain part of the child process image.
pub fn instrument(input: &[u8], opts: &Options) -> Result<Vec<u8>> {
    let mut module =
        walrus::Module::from_buffer(input).context("failed to parse input wasm module")?;
    reject_preinstrumented_artifact(&module)?;
    legacy_dlopen::lower(&mut module)?;

    // Discover the fork-path closure *before* we mutate the module so
    // the runtime's own injected functions are not mistaken for
    // fork-path callers. (They can't reach the seed anyway, but the
    // earlier-is-simpler ordering keeps the invariant trivially.)
    let side_boundaries = uses_side_module_boundaries(&module, opts);
    if side_boundaries {
        ensure_side_module_abi_version(&mut module, input)?;
    }
    let entry_imports = call_graph::find_import_funcs(&module, &opts.entry_import);
    let boundary_imports = boundary_seed_imports(&module, opts, &entry_imports);
    let seeds = fork_boundary_seeds(&module, &boundary_imports, side_boundaries);
    let has_dynamic_linker_imports = call_graph::has_dynamic_linker_imports(&module);
    let external_dynamic_dispatch = side_boundaries || has_dynamic_linker_imports;
    reject_reserved_unwind_import(&module)?;
    if boundary_imports.is_empty() && !external_dynamic_dispatch {
        // WHY: this is a standalone executable with no route into fork or a
        // process-wide dynamic activation. Keeping the exact linker bytes
        // avoids imposing ABI 43's GC/exnref replay types on non-forking
        // software and preserves the advertised no-op transform boundary.
        return Ok(input.to_vec());
    }
    let initial_fork_path =
        prepare_fork_path(&module, &seeds, external_dynamic_dispatch).activations;
    legacy_eh::normalize_fork_path(&mut module, &initial_fork_path)?;
    // Legacy EH normalization can replace instruction sequences. Recompute
    // the semantic closure afterwards so the exact fork-reaching tail-site
    // coordinates used by private-tag transport name the normalized IR.
    let reaching = prepare_fork_path(&module, &seeds, external_dynamic_dispatch);
    let (fork_path, fork_path_targets, tail_call_sites) = (
        reaching.activations,
        reaching.control_reachable,
        reaching.tail_call_landings,
    );
    instrument::validate_activation_state_with_targets(&module, &fork_path, &fork_path_targets)?;

    // The five wpk_fork_* exports prove only that some instrumentation runtime
    // was injected. They do not prove which import seeded the transformed call
    // graph or whether a dlopen-capable main used the conservative dynamic
    // call_indirect boundary. Emit a separate, versioned claim for exactly the
    // transformations performed in this invocation so the host can reject
    // stale or generically instrumented artifacts instead of mis-resuming.
    let mut fork_capabilities = WPK_FORK_CAP_ACTIVATION_STATE_SAFE;
    if side_boundaries {
        // ABI 43 interprets SIDE_ENTRY as complete side-boundary coverage, not
        // merely proof that one env.fork import was discovered.
        fork_capabilities |= WPK_FORK_CAP_SIDE_ENTRY;
    }
    if !side_boundaries
        && !entry_imports.is_empty()
        && opts.entry_import == "kernel.kernel_fork"
        && call_graph::has_dynamic_linker_imports(&module)
    {
        fork_capabilities |= WPK_FORK_CAP_DYLINK_MAIN;
    }

    // Phase 4a: runtime scaffolding. Every artifact that can participate in a
    // process-wide fork receives the same state contract, regardless of
    // whether a local caller was actually rewritten.
    //
    // Discover supported tagged-catch regions before injecting the runtime.
    // The plan contains only static tag/label/type metadata; activation state
    // is allocated later as ordinary frame-backed function locals. Sort the
    // targets to keep local allocation and emitted bytes deterministic.
    let mut activation_targets: Vec<walrus::FunctionId> = fork_path
        .iter()
        .copied()
        .filter(|id| matches!(module.funcs.get(*id).kind, walrus::FunctionKind::Local(_)))
        .collect();
    activation_targets.sort();
    let plain_catch_plan = instrument::plan_plain_catches(&module, &activation_targets);
    let static_reference_plan = static_reference_catalog::plan(&mut module);
    let module_state_plan = module_state::plan(&mut module);

    // Capture only original module functions. Runtime and transform helpers
    // injected below are implementation details and cannot have appeared in a
    // source-level ref.func. A fixed-size table plus an active element segment
    // is deterministic across fresh instantiation and does not depend on
    // mutable guest table state.
    let function_catalog = inject_function_catalog(&mut module);
    static_reference_catalog::inject(&mut module, static_reference_plan);

    // Every dynamic activation is part of the process image even when none of
    // its functions can be on the active fork stack. Give no-memory modules
    // the shared process-memory staging contract before deriving the pointer
    // ABI, and give each participating artifact the same linked imports and
    // state helpers.
    //
    // WHY: an inactive side module can still own mutated globals, tables, or
    // dropped segments referenced by the main process. Limiting these helpers
    // to the module that imports fork would silently reset that state in a
    // fresh child.
    let staging_memory = module_state::ensure_staging_memory(&mut module);
    let gc_codec = module_gc_codec::declare(&mut module, staging_memory)?;
    let exception_codec = module_exception_codec::inject_with_reference_overrides(
        &mut module,
        staging_memory,
        Some((gc_codec.encode_externref, gc_codec.decode_externref)),
        Some((gc_codec.encode_anyref, gc_codec.decode_anyref)),
    )?;
    let runtime = runtime::inject_linked_runtime_with_reference_overrides(
        &mut module,
        runtime::ReferenceCodecOverrides {
            funcref: Some((
                exception_codec.references.encode_funcref,
                exception_codec.references.decode_funcref,
            )),
            externref: Some((
                exception_codec.references.encode_externref,
                exception_codec.references.decode_externref,
            )),
            exnref: Some((exception_codec.encode, exception_codec.decode)),
            anyref: Some((gc_codec.encode_anyref, gc_codec.decode_anyref)),
            cleanup: Some(exception_codec.clear),
        },
    );
    let _gc_codec =
        module_gc_codec::finish_declaration(&mut module, gc_codec, exception_codec, &runtime)?;
    // Phase 4b: structural wrap of each fork-path function's body.
    // No-op when `fork_path` is empty (module doesn't use fork).
    instrument::instrument_functions_with_targets_and_tail_sites(
        &mut module,
        &runtime,
        &fork_path,
        &fork_path_targets,
        &tail_call_sites,
        &plain_catch_plan,
    );
    // Dirty-page instrumentation uses short-lived scalar/reference
    // temporaries. Add them after continuation frame planning so they neither
    // enlarge saved frames nor survive as stale activation roots.
    let module_bootstrap = module_state::inject(&mut module, &runtime, module_state_plan)?;
    append_function_catalog_entry(&mut module, function_catalog, module_bootstrap);

    loop {
        let existing = module
            .customs
            .iter()
            .find(|(_, section)| section.name() == WPK_FORK_CAPABILITIES_SECTION)
            .map(|(id, _)| id);
        let Some(existing) = existing else { break };
        module.customs.delete(existing);
    }
    module.customs.add(RawCustomSection {
        name: WPK_FORK_CAPABILITIES_SECTION.into(),
        data: vec![WPK_FORK_CAPABILITIES_VERSION, fork_capabilities],
    });

    loop {
        let existing = module
            .customs
            .iter()
            .find(|(_, section)| section.name() == linked_frames::LINKED_FRAME_FORMAT_SECTION)
            .map(|(id, _)| id);
        let Some(existing) = existing else { break };
        module.customs.delete(existing);
    }
    let pointer_width = match runtime.buf_type {
        walrus::ValType::I32 => linked_frames::PointerWidth::Wasm32,
        walrus::ValType::I64 => linked_frames::PointerWidth::Wasm64,
        other => unreachable!("unsupported fork buffer pointer type: {other:?}"),
    };
    module.customs.add(RawCustomSection {
        name: linked_frames::LINKED_FRAME_FORMAT_SECTION.into(),
        data: linked_frames::FrameFormatDescriptor::current(
            pointer_width,
            runtime.fixed_prefix_size,
        )
        .encode()
        .to_vec(),
    });

    replace_custom_section(
        &mut module,
        WPK_FORK_MODULE_STATE_FORMAT_SECTION,
        module_state_descriptor(pointer_width),
    );

    // Every ABI 43 activation imports the private tag as part of its uniform
    // state helpers, including a side module with no local fork entry. Keep
    // the versioned descriptor equally uniform so a state-only activation can
    // be admitted without weakening the host's exact-tag validation.
    module.customs.add(RawCustomSection {
        name: UNWIND_TRANSPORT_SECTION.into(),
        // Byte 1 is the tag payload arity. Version 1 deliberately fixes it
        // at zero so host validation can reject a lookalike tag import.
        data: vec![
            UNWIND_TRANSPORT_VERSION,
            WPK_FORK_UNWIND_TRANSPORT_PAYLOAD_ARITY,
        ],
    });

    // Historical phase list (Phase 4b/4c/4d/4e/4f/5/6) was an artefact
    // of guard-dispatch's body-rewriting approach. Post-commit-4 those
    // phases are folded into `instrument::instrument_functions` itself;
    // see `instrument_one_function_switch` / `instrument_one_function_nested_switch`
    // for the actual transform.

    let output = module.emit_wasm();
    restore_leading_dylink_section(input, output)
}

fn inject_function_catalog(module: &mut walrus::Module) -> TableId {
    let mut functions: Vec<walrus::FunctionId> =
        module.funcs.iter().map(|func| func.id()).collect();
    functions.sort();
    let size = functions.len() as u64;
    let table = module
        .tables
        .add_local(false, size, Some(size), RefType::FUNCREF);
    module.tables.get_mut(table).name = Some(FUNCTION_CATALOG_EXPORT.into());
    if !functions.is_empty() {
        module.elements.add(
            ElementKind::Active {
                table,
                offset: walrus::ConstExpr::Value(Value::I32(0)),
            },
            ElementItems::Functions(functions),
        );
    }
    // WHY: fixed min/max prevents guest growth. The host treats this export as
    // immutable catalog input and never uses it as mutable replay storage.
    module.exports.add(FUNCTION_CATALOG_EXPORT, table);
    table
}

fn append_function_catalog_entry(
    module: &mut walrus::Module,
    table: TableId,
    function: FunctionId,
) {
    let ordinal = module.tables.get(table).initial;
    let size = ordinal
        .checked_add(1)
        .expect("fork function catalog length fits u64");
    let catalog = module.tables.get_mut(table);
    catalog.initial = size;
    catalog.maximum = Some(size);
    module.elements.add(
        ElementKind::Active {
            table,
            offset: walrus::ConstExpr::Value(Value::I32(
                i32::try_from(ordinal).expect("fork function catalog ordinal fits i32"),
            )),
        },
        ElementItems::Functions(vec![function]),
    );
}

fn module_state_descriptor(pointer_width: linked_frames::PointerWidth) -> Vec<u8> {
    let pointer_width = match pointer_width {
        linked_frames::PointerWidth::Wasm32 => u8::try_from(u32::BITS / u8::BITS).unwrap(),
        linked_frames::PointerWidth::Wasm64 => u8::try_from(u64::BITS / u8::BITS).unwrap(),
    };
    let mut data = Vec::with_capacity(usize::from(WPK_FORK_MODULE_STATE_DESCRIPTOR_SIZE));
    data.extend_from_slice(&WPK_FORK_MODULE_STATE_FORMAT_MAGIC);
    data.extend_from_slice(&WPK_FORK_MODULE_STATE_FORMAT_VERSION.to_le_bytes());
    data.extend_from_slice(&WPK_FORK_MODULE_STATE_DESCRIPTOR_SIZE.to_le_bytes());
    data.push(pointer_width);
    data.push(WPK_FORK_MODULE_STATE_RECORD_ALIGNMENT);
    data.extend_from_slice(&WPK_FORK_MODULE_STATE_REQUIRED_FLAGS.to_le_bytes());
    data.extend_from_slice(&WPK_FORK_MODULE_STATE_ARENA_VERSION.to_le_bytes());
    data.extend_from_slice(&WPK_FORK_MODULE_STATE_RECORD_VERSION.to_le_bytes());
    data.extend_from_slice(&WPK_FORK_MODULE_STATE_ROOT_POINTER_WORD_OFFSET.to_le_bytes());
    data.extend_from_slice(&u32::default().to_le_bytes());
    debug_assert_eq!(
        data.len(),
        usize::from(WPK_FORK_MODULE_STATE_DESCRIPTOR_SIZE)
    );
    data
}

fn replace_custom_section(module: &mut walrus::Module, name: &str, data: Vec<u8>) {
    loop {
        let existing = module
            .customs
            .iter()
            .find(|(_, section)| section.name() == name)
            .map(|(id, _)| id);
        let Some(existing) = existing else { break };
        module.customs.delete(existing);
    }
    module.customs.add(RawCustomSection {
        name: name.into(),
        data,
    });
}

/// Walrus emits raw custom sections after the standard sections. That is
/// normally valid, but the WebAssembly dynamic-linking convention requires a
/// shared module's `dylink.0` custom section to be first. Preserve that input
/// contract after instrumentation so Kandelo's dynamic loader can still
/// recognize fork-capable side modules.
fn restore_leading_dylink_section(input: &[u8], output: Vec<u8>) -> Result<Vec<u8>> {
    let mut input_payloads = Parser::new(0).parse_all(input);
    let _version = input_payloads
        .next()
        .transpose()
        .context("parsing input wasm header")?;
    let input_starts_with_dylink = matches!(
        input_payloads.next().transpose()?,
        Some(Payload::CustomSection(section)) if section.name() == "dylink.0"
    );
    if !input_starts_with_dylink {
        return Ok(output);
    }

    let mut dylink_range = None;
    for payload in Parser::new(0).parse_all(&output) {
        if let Payload::CustomSection(section) = payload? {
            if section.name() != "dylink.0" {
                continue;
            }
            ensure!(
                dylink_range.is_none(),
                "instrumented module contains more than one dylink.0 section"
            );
            dylink_range = Some(section.range());
        }
    }

    let payload_range = dylink_range.context(
        "input shared module started with dylink.0, but the instrumented output lost it",
    )?;
    let payload_len = u32::try_from(payload_range.len())
        .context("dylink.0 section is too large for a wasm section")?;
    let section_header_len = 1 + u32_leb_len(payload_len);
    let section_start = payload_range
        .start
        .checked_sub(section_header_len)
        .context("dylink.0 section range does not include a valid header")?;
    ensure!(
        section_start >= 8 && output.get(section_start) == Some(&0),
        "dylink.0 section does not have a valid custom-section header"
    );
    if section_start == 8 {
        return Ok(output);
    }

    let mut reordered = Vec::with_capacity(output.len());
    reordered.extend_from_slice(&output[..8]);
    reordered.extend_from_slice(&output[section_start..payload_range.end]);
    reordered.extend_from_slice(&output[8..section_start]);
    reordered.extend_from_slice(&output[payload_range.end..]);
    Ok(reordered)
}

fn u32_leb_len(mut value: u32) -> usize {
    let mut len = 1;
    while value >= 0x80 {
        value >>= 7;
        len += 1;
    }
    len
}
