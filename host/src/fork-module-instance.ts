// Instantiate the co-resident `fork-module` PIC side module into a
// host-reserved region of the guest's shared linear memory.
//
// Phase 6 D5: the `fork-module` (crates/fork-module) is built as a
// POSITION-INDEPENDENT (`--pie`) wasm SIDE MODULE. It imports the guest's
// single shared `env.memory` plus the placement globals `env.__memory_base`
// (immutable), `env.__stack_pointer` (mutable), `env.__table_base`
// (immutable), and `env.__indirect_function_table`. Its data segments are
// PASSIVE and copied to `__memory_base + offset` by its start function
// (`__wasm_apply_data_relocs`) during instantiation.
//
// Placing the module's static data / BSS heap / shadow stack at a
// host-chosen region — instead of the fixed low offsets a plain cdylib would
// use — is the gating fix: those offsets would otherwise COLLIDE with and
// corrupt live guest data. This mirrors the placement contract `dylink.ts`
// already uses for shared libraries: reserve a region, then hand the module
// `__memory_base` / `__table_base` / `__stack_pointer` pointing into it.
//
// This module ONLY instantiates and asserts the module. It does NOT flip any
// guest fork import: the guest still uses the JavaScript `continuationImports`
// closures. Wiring the import flip is a later D5 step.

import { ForkAnyrefTransitTable } from "./fork-anyref-transit";

/** Exports the guest-facing continuation ABI plus the module lifecycle hooks. */
export const FORK_MODULE_REQUIRED_EXPORTS = [
  "__wpk_fork_frame_reserve",
  "__wpk_fork_frame_commit",
  "__wpk_fork_frame_peek",
  "__wpk_fork_frame_next",
  "__wpk_fork_resume_peek",
  // Phase 6 D7a.1a: the activation-parameterized SHARED frame exports the
  // per-activation trampolines (`fork-module-trampoline.ts`) delegate to. A
  // dlopen fork has N activations; the frozen guest-facing `__wpk_fork_frame_*`
  // above are these with `act == primary_activation` (the single-activation
  // degenerate case). Each activation's frames route to its OWN writer/driver in
  // the module map while the journal + resume table stay process-wide.
  "fm_frame_reserve",
  "fm_frame_commit",
  "fm_frame_peek",
  "fm_frame_next",
  "fm_resume_peek",
  "fm_set_format",
  "fm_set_resume_catalog",
  // Phase 6 D7a.1a: seed ONE activation's resume catalog (a dlopen fork loads N
  // modules, each with its own catalog table) so each activation's resume-slot
  // numbering matches ITS JS `__wpk_fork_resume_table` by construction.
  "fm_set_activation_resume_catalog",
  // Phase 6 D7a.1b: seed ONE activation's function-catalog BASE into the merged,
  // activation-namespaced funcref catalog so `fm_funcref_ordinal` returns the
  // global slot `base(module_activation) + function_ordinal`. This is what makes
  // a dlopen fork's multi-activation funcref references reconstruct through the
  // module (a funcref minted in one activation but held by another's frame
  // resolves against its own activation's catalog slice).
  "fm_set_activation_catalog_base",
  "fm_begin_unwind",
  // Phase 6 D7a.1a: add ANOTHER activation (a dlopen fork's side module) to the
  // capture begun by `fm_begin_unwind`, with its own host frame arena + prefix.
  "fm_add_activation_unwind",
  "fm_finish_unwind",
  // Option B (minimize host surface): serialize the sealed journal into a chunk
  // the module channel-mmaps itself, returning its guest offset; the host reads
  // `fm_journal_image_len` and records both in a `JournalImage` KFMS record.
  "fm_serialize_journal_alloc",
  "fm_journal_image_len",
  // Release every channel-mapped frame/image chunk on the host abort path.
  "fm_abort",
  "fm_begin_replay",
  // F1: parent abort-replay begin/finish. Mirror `fm_begin_replay`/
  // `fm_finish_replay` exactly (same frame/journal mechanics), tagging the
  // drive as an abort so `fm_finish_abort` can assert a matching
  // `fm_begin_abort` ran first (a stray call is a loud `EINVAL`, not a
  // silent no-op).
  "fm_begin_abort",
  "fm_finish_abort",
  "fm_begin_child_replay",
  // Phase 6 item 4: seed a vfork BORROWED child's replay from the parked
  // parent's LIVE shared memory (its own instance at a distinct __memory_base),
  // copying the parent's fixed prefix into a child-private region and owning no
  // chunks so finish/abort release nothing.
  "fm_begin_borrowed_child_replay",
  // Phase 6 item 4: add a dlopen-vfork ("mode-1") SIDE activation to a borrowed
  // child replay, with its own child-private prefix (borrowed sibling of
  // fm_add_activation_child_replay).
  "fm_add_activation_borrowed_child_replay",
  // Phase 6 D7a.1a: add a dlopen fork's SIDE activation to the child replay
  // begun by `fm_begin_child_replay`, at its inherited continuation anchor.
  "fm_add_activation_child_replay",
  "fm_finish_replay",
  "fm_frames_committed",
  // Phase 6 D7b: replay-side proof-of-use counter. A replay-only forked child
  // never commits a frame, so this (not `fm_frames_committed`) is what proves a
  // fork-from-thread child drove its rewind through the module.
  "fm_frames_replayed",
  "fm_last_errno",
  // Phase 6 D6.1 reference reconstruction (funcref + null):
  //  - `__wpk_fork_ref_decode_funcref` is the funcref-returning export the
  //    walrus injector adds (Rust cannot emit it); it reads the imported
  //    `__wpk_fork_function_catalog` table with `table.get`.
  //  - `fm_begin_reference_replay` seeds the funcref/null reference graph.
  //  - `fm_references_reconstructed` is the proof-of-use counter.
  "__wpk_fork_ref_decode_funcref",
  "fm_begin_reference_replay",
  "fm_references_reconstructed",
  // Phase 6 D6.2 externref reconstruction proof-of-use counter.
  "fm_externrefs_resolved",
  // M2 task 3: the walrus-injected externref decode export — mirrors
  // `__wpk_fork_ref_decode_funcref` but calls the host `env.resolve_externref`
  // import instead of `table.get` (a Wasm module cannot hold a live
  // `externref`, so it cannot decode one without asking the host for it).
  "__wpk_fork_ref_decode_externref",
  // Phase 6 D6.3a exnref reconstruction proof-of-use counter.
  "fm_exnrefs_reconstructed",
  // Phase 6 D6.4a typed-GC (struct/array/i31) reconstruction proof-of-use counter.
  "fm_gc_nodes_reconstructed",
  // Phase 6 item 3a (minimize host surface): the seven RESTORE data-feed exports
  // the host flips the guest's `__wpk_fork_ref_{vector_get,gc_route,
  // gc_payload_len,gc_load,exn_route,exn_load,exn_cache_index}` imports to
  // (per-activation, like `__wpk_fork_ref_decode_funcref`). They serve the
  // decoded reference graph to the guest's typed-GC/exnref codec during the JS
  // drive-order, moving that data feed out of the JS reference provider. Pure
  // i32/i64 signatures (see `host/src/generated/abi.ts`), so plain Rust exports.
  "fm_ref_vector_get",
  "fm_ref_gc_route",
  "fm_ref_gc_payload_len",
  "fm_ref_gc_load",
  "fm_ref_exn_route",
  "fm_ref_exn_load",
  "fm_ref_exn_cache_index",
  // Proof-of-use counter: advances once per data-feed read the module served, so
  // a test can prove the guest codec read the graph THROUGH the module rather
  // than the JS provider.
  "fm_ref_feed_reads",
  // Phase 6 item 3b (minimize host surface): the call_indirect drive-shim
  // mechanism for driving the guest's typed-GC `_gc_allocate`/`_gc_fill` exports
  // from the module.
  //  - `fm_drive_execute` is the walrus-injected wasm loop (Rust cannot emit
  //    `call_indirect`): it strides a serialized drive PLAN, `call_indirect`s the
  //    host-bound `__wpk_fork_drive_table` slot for each step, and after each
  //    ALLOC step reads STORE #2 (the guest's shared Wasm-GC transit table
  //    `__wpk_fork_ref_gc_transit`) at slot `recipe + 1` with a wasm `table.get` +
  //    `ref.is_null` to assert the guest's `_gc_allocate` published a live GC
  //    object there, trapping (`unreachable`) otherwise. That post-allocate
  //    integrity guard is injected wasm, not a Rust export, because Rust holds no
  //    `anyref`.
  //  - `fm_drive_table_base` gives the host the first drive-table slot for an
  //    activation, so the host binds `_gc_allocate`/`_gc_fill` at the slots the
  //    Rust plan encodes.
  // The full topological plan-from-graph drive (which flips the JS
  // `materializeTypedGraph` order to the module) is item 3c.
  "fm_drive_execute",
  "fm_drive_table_base",
  // Phase 6 item 3c (production typed-GC drive flip): the host seeds each
  // participating activation's raw KFGC codec bytes + the host-exception owner,
  // then builds the topological drive plan from the decoded reference graph and
  // executes it through the module — replacing the JS `materializeAllTyped`
  // typed allocate/fill/exn sub-loop on a flag-on qualifying child.
  //  - `fm_set_activation_gc_codec` seeds ONE activation's layout catalog.
  //  - `fm_set_host_exception_owner` seeds the smallest exception-declaring
  //    activation (the JS `directOwner` for a host exnref).
  //  - `fm_build_gc_plan` serializes the topological plan; `fm_gc_plan_count`
  //    is its step count (the `fm_drive_execute` count argument).
  //  - `fm_drive_bump` / `fm_drive_steps_executed` are the DRIVE proof-of-use
  //    counter (the walrus-injected shim `call`s `fm_drive_bump` once per driven
  //    step), distinct from the item-3a `fm_gc_nodes_reconstructed` feed count.
  "fm_set_activation_gc_codec",
  "fm_set_host_exception_owner",
  "fm_build_gc_plan",
  "fm_gc_plan_count",
  // Phase 6 (reconstruction-orchestration ENTRY): the module-owned entry that
  // collapses `fm_begin_reference_replay` + `fm_build_gc_plan` into ONE call —
  // it seeds the reference driver/feed from the inherited KFMS arena AND builds
  // the whole topological drive plan, returning the plan's guest address for a
  // single `fm_drive_execute`. This moves the reference seeding + drive-order
  // CONSTRUCTION out of the host into the module; the host issues one entry call
  // then one drive, rather than seeding, then rebuilding the plan inside the
  // drive closure. Transit SIZING stays the host floor (`prepareTransit`): the
  // module cannot grow the anyref transit table from Rust.
  "fm_restore_from_arena",
  "fm_drive_bump",
  "fm_drive_steps_executed",
  // Phase 6 (child-install ENTRY): the module-owned attach entries that build the
  // reconstruction drive plan AND append the two-phase guest restore/finish
  // install sequencing (`append_attach_steps` -> DRIVE_OP_RESTORE /
  // DRIVE_OP_FINISH_RESTORE steps). Driving those steps through the existing
  // `fm_drive_execute` shim (a plain `call_indirect` per step on the host-bound
  // drive table, no transit assert) moves the JS `restoreModuleState` two-phase
  // `for act: restore` / `for act: finishRestore` ORDER into the module; the
  // guest's own layout-specific restore exports still place the reconstructed
  // identities into the live child. `fm_attach_child` is the COW entry;
  // `fm_attach_borrowed_child` the byte-identical vfork borrowed entry (its only
  // borrowed-specific work, the child-private replay prefix, stays host floor).
  "fm_attach_child",
  "fm_attach_borrowed_child",
  // Path-A INC-C (module-owned decoded-graph STRUCTURE readout): make the wire
  // reference graph resident and read its per-node kind + coordinates from the
  // module, so the host no longer walks the JS
  // `decodeSegmentedForkReferenceTransaction` structure for the two structural
  // consumers (the exnref tag-validity admission gate + the merged static-root
  // catalog mirror seeding).
  //  - `fm_decode_reference_graph` decodes the KFMS arena into the resident
  //    read-only graph and returns its node count (distinct from the replay
  //    driver `fm_restore_from_arena`/`fm_attach_child` seed; it survives a later
  //    attach, which does not touch this graph).
  //  - `fm_decoded_node_count` re-reads that resident node count.
  //  - `fm_decoded_node_kind` / `fm_decoded_node_module_activation` /
  //    `fm_decoded_node_ordinal` are the per-node structural accessors (node
  //    index == canonical node id).
  "fm_decode_reference_graph",
  "fm_decoded_node_count",
  "fm_decoded_node_kind",
  "fm_decoded_node_module_activation",
  "fm_decoded_node_ordinal",
  // Static-root binder: admit static-root WasmGC graphs through the module. A
  // DRIVE_OP_STATIC_ROOT drive step publishes each immutable static root into the
  // anyref transit at slot `recipe + 1` via a wasm `table.get(static_root_catalog,
  // fm_static_root_slot(recipe))` + `table.set(transit, recipe+1, v)`.
  //  - `fm_static_root_slot` maps a recipe to its merged anyref-catalog index
  //    (per-activation base + ordinal); the injected drive shim `table.get`s it.
  //  - `fm_set_activation_static_root_base` seeds ONE activation's merged-catalog
  //    base (the funcref merged-catalog mechanism, for static roots).
  //  - `fm_static_roots_published` is the DRIVE proof-of-use counter.
  "fm_static_root_slot",
  "fm_set_activation_static_root_base",
  "fm_static_roots_published",
  // M1 task 2: the fork-module now DEFINES and EXPORTS the shared Wasm-GC
  // transit table (STORE #2) instead of importing a host-minted one. The
  // guest still imports `env.__wpk_fork_ref_gc_transit`; the host binds the
  // guest import to THIS export (see `gcTransitTable` below), so the
  // module's own drive-time `table.get` and the guest's `_gc_allocate`
  // publish agree on a single table.
  "__wpk_fork_ref_gc_transit",
  // Path B P3: the module-owned reference CAPTURE session over the shared
  // `fork_codec::ReferenceGraphBuilder`. The host's thin capture-import bodies
  // resolve each live reference to its recipe COORDINATE with the per-host
  // identity floor and intern it here, so the module is the SOLE capture graph
  // on V8 (mirrors native's `guest.rs` capture bodies calling `graph.intern_*`).
  // `fm_capture_serialize` streams the KFRV/KFRS records the host drains into its
  // module-state arena (the child's wire); `fm_capture_vector_get` serves the
  // PARENT's own post-fork replay vector reads from the resident builder.
  "fm_capture_begin",
  "fm_capture_intern_funcref",
  "fm_capture_intern_externref",
  "fm_capture_intern_i31",
  "fm_capture_intern_static_root",
  "fm_capture_claim_gc",
  "fm_capture_gated_placeholder",
  "fm_capture_define_gc",
  "fm_capture_begin_vector",
  "fm_capture_append_vector",
  "fm_capture_finish_vector",
  "fm_capture_validate",
  "fm_capture_serialize",
  "fm_capture_serialized_len",
  "fm_capture_record_header_size",
  "fm_capture_vector_get",
  "fm_capture_interned",
] as const;

/** Required exports whose value is a `WebAssembly.Table`, not a function. */
const FORK_MODULE_TABLE_EXPORTS: ReadonlySet<string> = new Set([
  "__wpk_fork_ref_gc_transit",
]);

export type ForkModuleExportName = (typeof FORK_MODULE_REQUIRED_EXPORTS)[number];

export type ForkModuleExports = Record<
  Exclude<ForkModuleExportName, "__wpk_fork_ref_gc_transit">,
  Function
> &
  Record<"__wpk_fork_ref_gc_transit", WebAssembly.Table> &
  WebAssembly.Exports;

export interface InstantiateForkModuleOptions {
  /** Pre-compiled fork-module (compiled once per kernel host). */
  module: WebAssembly.Module;
  /** The guest's single shared linear memory (the frame data plane). */
  memory: WebAssembly.Memory;
  /** Guest pointer width: 4 for wasm32, 8 for wasm64. */
  ptrWidth: 4 | 8;
  /**
   * Reserve `size` bytes in the shared linear memory and return the base
   * offset. Production supplies the channel `continuationMmap`; tests supply a
   * bump allocator. The base must be at least 16-byte aligned.
   */
  reserve: (size: number) => number;
  /** Diagnostic label (e.g. `pid=NN`). */
  label: string;
  /**
   * The funcref table the module's `__wpk_fork_ref_decode_funcref` reads with
   * `table.get` (Phase 6 D6.1). The guest's own `__wpk_fork_function_catalog` is
   * a guest EXPORT that only exists after the guest instance is created — which
   * is AFTER this module is instantiated (the module must precede the guest to
   * supply the frame-flip imports). So the host passes a growable, host-owned
   * mirror table here and populates it from the guest's catalog (identical
   * funcref identities) once the guest instance exists. When omitted (tests /
   * non-funcref paths) an empty growable table is created; the module never
   * reads it unless `fm_begin_reference_replay` succeeds and a funcref recipe is
   * decoded, so an empty table is inert.
   */
  functionCatalog?: WebAssembly.Table;
  /**
   * The MUTABLE funcref drive table the module's injected `fm_drive_execute`
   * `call_indirect`s (Phase 6 item 3b). The guest's `_gc_allocate`/`_gc_fill`
   * exports only exist AFTER the guest instance is created — which is AFTER this
   * module is instantiated (the module must precede the guest to supply the
   * frame-flip imports). So the host passes a growable, host-owned table here and
   * binds each activation's `_gc_allocate`/`_gc_fill` into it (at
   * `fm_drive_table_base(activation) + {ALLOC, FILL}`) once the guest instance
   * exists. When omitted (tests / forks that never run the module drive) an empty
   * growable table is created; the module never `call_indirect`s it unless the
   * host both binds the exports and calls `fm_drive_execute`, so an empty table
   * is inert and flag-off byte-identical.
   */
  driveTable?: WebAssembly.Table;
  /**
   * @deprecated M1 task 2 moved the shared Wasm-GC transit table (STORE #2)
   * from a host-minted import into a module-DEFINED and EXPORTED table
   * (`__wpk_fork_ref_gc_transit`, see `ForkModuleInstance.gcTransitTable`).
   * The injected module no longer imports this table, so any value supplied
   * here is IGNORED — it is accepted only so existing callers/tests that
   * still pass it keep working unchanged. Bind the guest's own
   * `env.__wpk_fork_ref_gc_transit` import to the returned
   * `gcTransitTable` instead.
   */
  transitTable?: WebAssembly.Table;
  /**
   * The merged, host-owned static-root catalog (`anyref`) the module's injected
   * `fm_drive_execute` reads with `table.get` on a DRIVE_OP_STATIC_ROOT step (the
   * static-root binder). The guest's own `__wpk_fork_static_root_catalog` is a
   * one-shot harvest EXPORT the registry clears after instantiation, so the host
   * passes a growable mirror here and populates it from the child's live static
   * roots (`decodeStaticRoot`) at the fork's merged bases before the drive runs.
   * When omitted (tests / forks with no static root) a fresh host-owned `anyref`
   * table is minted through the ABI-43 Wasm-GC transit provider (JavaScript cannot
   * build an `anyref` table directly on every engine); the module never reads it
   * unless the host both populates it and drives a DRIVE_OP_STATIC_ROOT step, so an
   * empty default is inert and flag-off byte-identical.
   */
  staticRootCatalog?: WebAssembly.Table;
  /**
   * The `env.resolve_externref(handle: i32) -> externref` body (M2). The
   * module DECLARES this as a plain `env` import (not the deleted
   * `wpk_fork_host.*` seam, H3, 2026-09-06) because it returns a live
   * reference. The injected
   * `__wpk_fork_ref_decode_externref` export and the externref-transit drive
   * step both call it directly with `fm_externref_handle(recipe)`; production
   * backs it with `createForkModuleHostCapabilities` (a `ForkExternrefTokenCache`
   * lookup). When omitted (frame-only / funcref-only forks, and tests that never
   * drive externref reconstruction) it defaults to a body that throws loudly if
   * actually called — there is no legitimate "empty" externref resolution, so a
   * silent stub would hide a real gap rather than fail truthfully.
   */
  resolveExternref?: (handle: number) => unknown;
}

export interface ForkModuleInstance {
  instance: WebAssembly.Instance;
  exports: ForkModuleExports;
  /** First byte of the host-reserved region (== `__memory_base`). */
  memoryBase: number;
  /** Total reserved bytes: static/BSS footprint, staging slab, and shadow stack. */
  regionBytes: number;
  /**
   * First byte of the backend staging slab reserved inside this region (see
   * `FORK_MODULE_STAGING_BYTES`). The backend stages its small pre-fork guest
   * buffers here instead of `mmap`ping a fresh, memory-growing region, keeping a
   * COPIED fork child's `memory.size` equal to the parent's.
   */
  stagingBase: number;
  /** Byte length of the staging slab (== `FORK_MODULE_STAGING_BYTES`). */
  stagingBytes: number;
  /** The module's own (empty) indirect function table. */
  table: WebAssembly.Table;
  /**
   * The funcref catalog table the module's `__wpk_fork_ref_decode_funcref`
   * reads (Phase 6 D6.1). The host populates this from the guest's
   * `__wpk_fork_function_catalog` export after the guest instance exists.
   */
  functionCatalog: WebAssembly.Table;
  /**
   * The MUTABLE funcref drive table the module's injected `fm_drive_execute`
   * `call_indirect`s (Phase 6 item 3b). The host binds each activation's guest
   * `_gc_allocate`/`_gc_fill` exports into it once the guest instances exist.
   */
  driveTable: WebAssembly.Table;
  /**
   * The shared Wasm-GC transit table (`anyref`, STORE #2) the module's
   * injected `fm_drive_execute` reads after each ALLOC step. M1 task 2: the
   * module DEFINES and EXPORTS this table (`__wpk_fork_ref_gc_transit`)
   * instead of importing a host-minted one; this is that export. The guest
   * still imports `env.__wpk_fork_ref_gc_transit` — the host binds the
   * guest's import to THIS table so the drive's integrity check sees what
   * the guest's `_gc_allocate` published.
   */
  gcTransitTable: WebAssembly.Table;
  /**
   * The merged static-root catalog (`anyref`) the module's injected
   * `fm_drive_execute` reads with `table.get` on a DRIVE_OP_STATIC_ROOT step (the
   * static-root binder). The host populates this from the child's live static
   * roots at the fork's merged bases before the drive runs.
   */
  staticRootCatalog: WebAssembly.Table;
}

/**
 * Shadow stack for the fork-module's own Rust frames. The dylink `mem_size`
 * covers static data + BSS only; the imported `__stack_pointer` needs a
 * separate host-provided region. 1 MiB is generous for the small continuation
 * codec while staying far below the ~4 MiB static footprint.
 */
const FORK_MODULE_SHADOW_STACK_BYTES = 1 << 20;

/**
 * A dedicated, persistent staging slab reserved INSIDE the fork-module region
 * for the backend's small pre-fork guest buffers (the resume-catalog ordinals
 * `setup()`/`setActivationResumeCatalog` copy in, and per-activation GC-codec
 * bytes). Before this slab existed the backend `mmap`'d each staging buffer
 * from the guest syscall channel and released it after the module copied it
 * into its own arena. That transient `mmap` GROWS the process memory and never
 * shrinks (the kernel does not reclaim on munmap), and — critically — a COPIED
 * fork child re-runs this staging at its INHERITED (higher) mmap cursor, so the
 * child's staging landed at the top of the cloned memory and grew it by a page
 * that the parent had staged lower. That broke the fork memory-clone invariant
 * (child `memory.size` must equal the parent's). Staging into a slab that is
 * part of the single reused fork-module region makes it symmetric: the parent
 * and child reuse the SAME slab (a COPIED child reuses the whole region via
 * `forkModuleInheritedBase`), so no staging `mmap` grows either one. One page
 * holds the full resume catalog (`FORK_MODULE_RESUME_CATALOG_CAP` = 16384
 * ordinals * 4 bytes = 65536). A staging request larger than the slab (a large
 * GC codec) falls back to the growing channel `mmap` — that path never asserts
 * an exact memory size, so its growth is invisible; see `worker-main`'s backend
 * `reserveRegion`.
 */
const FORK_MODULE_STAGING_BYTES = 1 << 16;

const WASM_DYLINK_MEM_INFO = 1;

interface ForkModuleMemInfo {
  memorySize: number;
  memoryAlignBytes: number;
}

function readVarUint(data: Uint8Array, cursor: { value: number }): number {
  let result = 0;
  let shift = 0;
  let byte: number;
  do {
    byte = data[cursor.value++]!;
    result |= (byte & 0x7f) << shift;
    shift += 7;
  } while (byte & 0x80);
  return result >>> 0;
}

/**
 * Read the `dylink.0` `mem_info` subsection from the compiled module. The
 * WebAssembly JS API hands back the section payload (the subsections) directly,
 * so no whole-file scan is needed.
 */
function readForkModuleMemInfo(
  module: WebAssembly.Module,
  label: string,
): ForkModuleMemInfo {
  const sections = WebAssembly.Module.customSections(module, "dylink.0");
  if (sections.length === 0) {
    throw new Error(
      `${label}: fork-module is not a PIC side module (no dylink.0 section)`,
    );
  }
  const payload = new Uint8Array(sections[0]!);
  const cursor = { value: 0 };
  while (cursor.value < payload.length) {
    const subType = readVarUint(payload, cursor);
    const subSize = readVarUint(payload, cursor);
    const subEnd = cursor.value + subSize;
    if (subType === WASM_DYLINK_MEM_INFO) {
      const memorySize = readVarUint(payload, cursor);
      const memoryAlignLog2 = readVarUint(payload, cursor);
      return { memorySize, memoryAlignBytes: 1 << memoryAlignLog2 };
    }
    cursor.value = subEnd;
  }
  throw new Error(`${label}: fork-module dylink.0 has no mem_info subsection`);
}

function alignUp(value: number, alignBytes: number): number {
  return Math.ceil(value / alignBytes) * alignBytes;
}

function alignDown(value: number, alignBytes: number): number {
  return value - (value % alignBytes);
}

function wasmAddress(value: number, ptrWidth: 4 | 8): number | bigint {
  return ptrWidth === 8 ? BigInt(value) : value;
}

export function instantiateForkModule(
  options: InstantiateForkModuleOptions,
): ForkModuleInstance {
  const { module, memory, ptrWidth, reserve, label } = options;
  const memInfo = readForkModuleMemInfo(module, label);

  const staticBytes = alignUp(memInfo.memorySize, memInfo.memoryAlignBytes);
  // Layout of the reserved region (low -> high):
  //   [memoryBase, +staticBytes)                     static data + BSS
  //   [+staticBytes, +stagingBytes)                  backend staging slab
  //   [.., +FORK_MODULE_SHADOW_STACK_BYTES)          shadow stack (grows down)
  const stagingBytes = FORK_MODULE_STAGING_BYTES;
  const regionBytes =
    staticBytes + stagingBytes + FORK_MODULE_SHADOW_STACK_BYTES;

  const memoryBase = reserve(regionBytes);
  if (!Number.isSafeInteger(memoryBase) || memoryBase < 0) {
    throw new Error(
      `${label}: fork-module reserve returned an invalid base ${memoryBase}`,
    );
  }
  if (memoryBase % memInfo.memoryAlignBytes !== 0) {
    throw new Error(
      `${label}: fork-module base 0x${memoryBase.toString(16)} is not aligned ` +
        `to ${memInfo.memoryAlignBytes}`,
    );
  }
  if (memoryBase + regionBytes > memory.buffer.byteLength) {
    throw new Error(
      `${label}: fork-module region [0x${memoryBase.toString(16)}, +${regionBytes}) ` +
        `exceeds shared memory of ${memory.buffer.byteLength} bytes`,
    );
  }

  // Shadow stack lives above the static footprint and grows down from the top.
  const stackTop = alignDown(memoryBase + regionBytes, 16);
  const pointerType = ptrWidth === 8 ? "i64" : "i32";

  const memoryBaseGlobal = new WebAssembly.Global(
    { value: pointerType, mutable: false },
    wasmAddress(memoryBase, ptrWidth),
  );
  const tableBaseGlobal = new WebAssembly.Global(
    { value: pointerType, mutable: false },
    wasmAddress(0, ptrWidth),
  );
  const stackPointerGlobal = new WebAssembly.Global(
    { value: pointerType, mutable: true },
    wasmAddress(stackTop, ptrWidth),
  );
  // The module declares table_size = 0, so it never adds entries. Give it its
  // own empty table rather than coupling to any guest table this step.
  const table = new WebAssembly.Table({ element: "anyfunc", initial: 0 });
  // The funcref catalog the module's `__wpk_fork_ref_decode_funcref` reads
  // (Phase 6 D6.1). Default to an empty GROWABLE table (no maximum) the host can
  // grow + populate from the guest's catalog once the guest instance exists.
  const functionCatalog =
    options.functionCatalog ??
    new WebAssembly.Table({ element: "anyfunc", initial: 0 });
  // The mutable funcref drive table the module's injected `fm_drive_execute`
  // `call_indirect`s (Phase 6 item 3b). Default to an empty GROWABLE table the
  // host grows + binds the guest `_gc_allocate`/`_gc_fill` exports into once the
  // guest instances exist; inert until the host both binds and drives.
  const driveTable =
    options.driveTable ??
    new WebAssembly.Table({ element: "anyfunc", initial: 0 });
  // The shared Wasm-GC transit table (`anyref`, STORE #2) is now DEFINED and
  // EXPORTED by the module itself (M1 task 2) rather than imported, so there
  // is no import to bind or default to mint here. `options.transitTable` is
  // accepted for backward compatibility but ignored — see the `@deprecated`
  // note on that option. The module's export is read below, after
  // instantiation.
  // The merged static-root catalog (`anyref`) the module's injected
  // `fm_drive_execute` reads on a DRIVE_OP_STATIC_ROOT step (the static-root
  // binder). Default to a fresh host-owned `anyref` table minted through the
  // ABI-43 Wasm-GC transit provider (JavaScript cannot build an `anyref` table
  // directly on every engine); the host grows + populates it from the child's live
  // static roots before the drive runs. Inert until the host both populates it and
  // drives a static-root step, so an empty default is flag-off byte-identical.
  const staticRootCatalog =
    options.staticRootCatalog ?? new ForkAnyrefTransitTable().table;

  // `env.resolve_externref` (M2): a plain `env` import, not the deleted
  // `wpk_fork_host.*` seam (H3, 2026-09-06), because it returns a live
  // reference. Default to a body that
  // fails loud if actually invoked — a funcref/null-only fork never decodes an
  // externref, so the default is inert (never called) on that path, and any
  // path that DOES reach it without a real body is a genuine caller bug, not a
  // "nothing to resolve" case.
  const resolveExternref: (handle: number) => unknown =
    options.resolveExternref ??
    ((handle: number) => {
      throw new Error(
        `${label}: fork-module called resolve_externref(${handle}) but no ` +
          `resolveExternref body was supplied`,
      );
    });

  const imports: WebAssembly.Imports = {
    env: {
      memory,
      __indirect_function_table: table,
      __wpk_fork_function_catalog: functionCatalog,
      __wpk_fork_drive_table: driveTable,
      __wpk_fork_static_root_catalog: staticRootCatalog,
      __memory_base: memoryBaseGlobal,
      __table_base: tableBaseGlobal,
      __stack_pointer: stackPointerGlobal,
      resolve_externref: resolveExternref,
    },
  };

  // Synchronous instantiation runs the module's start (data-reloc / passive
  // segment copy into `__memory_base + offset`). Fail loud here, never later.
  let instance: WebAssembly.Instance;
  try {
    instance = new WebAssembly.Instance(module, imports);
  } catch (error) {
    throw new Error(
      `${label}: fork-module instantiation failed: ${String(error)}`,
    );
  }

  // The staging slab sits directly above the module's static/BSS footprint and
  // below the shadow stack. Its base inherits `staticBytes`' alignment (>= 8),
  // which satisfies the 4-byte alignment `fm_set_resume_catalog` needs.
  const stagingBase = memoryBase + staticBytes;

  const exports = instance.exports as ForkModuleExports;
  const missing = FORK_MODULE_REQUIRED_EXPORTS.filter((name) =>
    FORK_MODULE_TABLE_EXPORTS.has(name)
      ? !(exports[name] instanceof WebAssembly.Table)
      : typeof exports[name] !== "function",
  );
  if (missing.length > 0) {
    throw new Error(
      `${label}: fork-module is missing required exports: ${missing.join(", ")}`,
    );
  }

  // The shared Wasm-GC transit table (STORE #2) is now module-owned (M1 task
  // 2): read it back from the export instead of binding an import.
  const gcTransitTable = exports.__wpk_fork_ref_gc_transit;

  return {
    instance,
    exports,
    memoryBase,
    regionBytes,
    stagingBase,
    stagingBytes,
    table,
    functionCatalog,
    driveTable,
    gcTransitTable,
    staticRootCatalog,
  };
}
