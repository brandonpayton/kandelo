// Phase 6 D5 step 4b/5: the host-side driver that makes a QUALIFYING simple
// fork run its continuation through the co-resident `fork-module` (wasm→wasm
// over the shared memory) instead of the per-frame JavaScript closures in
// `ForkProcessContinuationCoordinator`. This backend owns every `fm_*` call and
// the placement of the serialized replay-event image so the coordinator's
// module-backed branches stay small and structurally parallel to the JS path.
//
// Scope (single-activation, single-thread, no dlopen/references/vfork): the
// coordinator activates these branches only when `enableModuleBacking` was
// called with an instance of this class, which `worker-main` does solely for a
// qualifying fork behind `WASM_POSIX_FORK_MODULE`. Flag-off / non-qualifying
// forks never construct this and are byte-identical to today.

import { WASM_PAGE_SIZE } from "./constants";
import {
  ContinuationAllocationError,
  type LinkedFrameFormatDescriptor,
} from "./fork-continuation";
import type { ForkModuleExports } from "./fork-module-instance";

/** The fork-module's static resume-catalog cap (mirrors `RESUME_CATALOG_CAP`). */
export const FORK_MODULE_RESUME_CATALOG_CAP = 16_384;

/** POSIX `ENOMEM` — the truthful failure mode for fork-frame arena exhaustion. */
const ENOMEM = 12;

/**
 * Per-activation frame-chunk slab handed to `fm_begin_unwind_fixed_arena` /
 * `fm_add_activation_unwind_fixed_arena` for a MULTI-activation (dlopen) fork.
 * The module bump-allocates its linked frame chunks WITHIN this slab on demand.
 * 2 pages (128 KiB) roughly doubles the historical Asyncify-era
 * `FORK_SAVE_BUFFER_SIZE` (60 KiB) and holds far more than the worst observed
 * multi-activation fork stack (lxpanel's ~21.5 KiB GLib double-fork). A frame
 * stack that overflows the slab is a truthful module `ENOMEM`.
 *
 * A SINGLE-activation fork (the common case, and any deep recursive fork) does
 * NOT use this bound: activation 0 is the only frame consumer, so the backend
 * hands it the whole arena minus the journal + module-state reserves
 * (`singleActivationFrameBudget`). This lets a deep linked continuation grow up
 * to the bounded arena — restoring the pre-Fix-X growable behavior WITHIN the
 * bound — instead of tripping a fixed 128 KiB sub-cap that no deep fork could
 * clear. See `singleActivationFrameBudget`.
 */
export const FORK_MODULE_FRAME_SLAB_BYTES = 2 * WASM_PAGE_SIZE;

/**
 * Bytes the single-activation frame budget holds back from the arena for the
 * host-side module-state arena (root chunk + KFMS records). Generous: a
 * single-activation fork's module state is a handful of small records, but the
 * reserve must never be undercut or the post-frame module-state / journal
 * allocation would spuriously ENOMEM inside a fork the arena can hold.
 */
export const FORK_MODULE_MODULE_STATE_RESERVE_BYTES = 8 * WASM_PAGE_SIZE;

/**
 * The journal-image slab handed to `fm_serialize_journal_fixed_arena`. The KFRE
 * image grows with the total committed-frame count across every activation; 4
 * pages (256 KiB) is generous for realistic forks. Too small a region is a
 * truthful `ENOMEM` from the module, never a silent overrun.
 */
export const FORK_MODULE_JOURNAL_SLAB_BYTES = 4 * WASM_PAGE_SIZE;

/**
 * A bounded cursor sub-allocator over the fork-module's pre-reserved in-guest
 * fork-frame arena (Fix X; see `FORK_MODULE_FRAME_ARENA_BYTES` in
 * `fork-module-instance.ts`). All THREE growing fork-time allocations — each
 * activation's frame chunk, the journal image, and the host-side module-state
 * arena chunks — draw page-aligned slabs from this ONE region instead of
 * channel-mmapping fresh, memory-growing regions.
 *
 * The owner (`worker-main`) calls `reset()` once at the START of each parent
 * fork, before any of the three consumers allocate, so sequential forks reuse
 * the region. A COW child is replay-only and allocates nothing, so only one
 * in-flight fork ever uses the arena; nested fork depth does not multiply usage.
 * On exhaustion `allocate` throws `ContinuationAllocationError(ENOMEM)`, which
 * the fork syscall handler turns into a truthful `-ENOMEM` — it NEVER falls back
 * to growing guest memory.
 */
export class ForkFixedFrameArena {
  private cursor: number;

  constructor(
    private readonly base: number,
    private readonly bytes: number,
    private readonly label: string,
  ) {
    if (
      !Number.isSafeInteger(base)
      || base <= 0
      || base % WASM_PAGE_SIZE !== 0
    ) {
      throw new RangeError(
        `${label}: fork-frame arena base must be a positive page multiple`,
      );
    }
    if (
      !Number.isSafeInteger(bytes)
      || bytes <= 0
      || bytes % WASM_PAGE_SIZE !== 0
    ) {
      throw new RangeError(
        `${label}: fork-frame arena size must be a positive page multiple`,
      );
    }
    this.cursor = base;
  }

  /** Reset the cursor to the region base — called once per fork by the owner. */
  reset(): void {
    this.cursor = this.base;
  }

  /** Total byte capacity of the reserved arena (== `FORK_MODULE_FRAME_ARENA_BYTES`). */
  capacity(): number {
    return this.bytes;
  }

  /**
   * Bump-allocate a page-aligned slab of at least `size` bytes. The base stays
   * page-aligned (the region base is, and every slab is a page multiple), which
   * the module-state arena's chunk validation requires. Exhaustion is a truthful
   * `ENOMEM`, never a fallback to growing guest memory.
   */
  allocate(size: number): number {
    if (!Number.isSafeInteger(size) || size <= 0) {
      throw new RangeError(`${this.label}: invalid fork-frame slab size ${size}`);
    }
    const need = alignUpPage(size);
    const addr = this.cursor;
    const end = addr + need;
    if (end > this.base + this.bytes) {
      throw new ContinuationAllocationError(
        ENOMEM,
        need,
        `${this.label}: fork-frame arena exhausted (need ${need} bytes, ` +
          `${this.base + this.bytes - addr} of ${this.bytes} remaining); ` +
          `the bounded arena is full`,
      );
    }
    this.cursor = end;
    return addr;
  }
}

/**
 * The guest offset + byte length of the serialized replay-event (KFRE) journal
 * image the module channel-mmap'd (Option B). `finishUnwindAndSerialize`
 * returns this; the coordinator records it in a `JournalImage` KFMS record so
 * the forked child finds the inherited image.
 */
export interface ForkModuleJournalImage {
  ptr: number;
  len: number;
}

export interface ForkModuleBackendOptions {
  /** The co-resident module instance's guest-facing + lifecycle exports. */
  readonly exports: ForkModuleExports;
  /** The single shared guest linear memory (the frame data plane). */
  readonly memory: WebAssembly.Memory;
  /** Guest pointer width: 4 for wasm32, 8 for wasm64. */
  readonly ptrWidth: 4 | 8;
  /** The guest's real linked-frame format (from `readLinkedFrameFormat`). */
  readonly format: LinkedFrameFormatDescriptor;
  /**
   * The FULL resume catalog's function ordinals (from `readForkResumeCatalog`),
   * seeded into the module so its resume-slot numbering matches the JS
   * `__wpk_fork_resume_table` by construction. Must be `<= CAP`.
   */
  readonly catalogOrdinals: readonly number[];
  /**
   * The guest syscall channel base. Retained for the small pre-fork catalog
   * scratch fallback only; Fix X moved the per-fork frame/journal allocations
   * off the channel and onto the pre-reserved fork-frame arena (`frameArena`),
   * so the module no longer channel-mmaps growing frame chunks. Must be
   * page-aligned and nonzero.
   */
  readonly channelBase: number;
  /**
   * The bounded, pre-reserved in-guest fork-frame arena (Fix X). The backend
   * bump-allocates each activation's frame slab and the journal-image slab from
   * here (via the module's `fm_*_fixed_arena` exports) instead of growing guest
   * memory per fork. `worker-main` resets its cursor once per fork and shares the
   * SAME instance with the module-state arena so all three fork-time allocations
   * live in this one reserved region.
   */
  readonly frameArena: ForkFixedFrameArena;
  /**
   * Reserve a small page-aligned guest region for PRE-FORK CATALOG SCRATCH only
   * (production: channel `continuationMmap`). This is unrelated to frame
   * allocation — Option B moved that into the module — and stays only to stage
   * the resume-catalog ordinals `setup()`/`setActivationResumeCatalog` copy in.
   */
  readonly reserveRegion: (size: number) => number;
  /** Release a region reserved by `reserveRegion` (production: `continuationMunmap`). */
  readonly releaseRegion: (addr: number, size: number) => void;
  /**
   * The child process PID. Passed to the module's `fm_begin_reference_replay`
   * so its `drive_reconstruction` opens the host root generation
   * (`begin_generation(pid)`) that owns this fork's re-rooted externref
   * identities (Phase 6 D6.2).
   */
  readonly pid: number;
  readonly label: string;
}

/**
 * Drives one process worker's fork continuation through the co-resident module.
 *
 * A parent worker calls `beginUnwind` → `finishUnwindAndSerialize` →
 * `beginParentReplay` → `finishReplay`. A fresh child worker (its own instance
 * at a different `__memory_base`, empty journal) calls only `beginChildReplay`
 * → `finishReplay`, seeding entirely from the copied guest memory.
 */
export class ForkModuleContinuationBackend {
  private readonly exports: ForkModuleExports;
  private readonly memory: WebAssembly.Memory;
  private readonly ptrWidth: 4 | 8;
  private readonly format: LinkedFrameFormatDescriptor;
  private readonly catalogOrdinals: readonly number[];
  private readonly channelBase: number;
  private readonly frameArena: ForkFixedFrameArena;
  private readonly reserveRegion: (size: number) => number;
  private readonly releaseRegion: (addr: number, size: number) => void;
  private readonly pid: number;
  private readonly label: string;

  /** Whether the parent module unwind is active (Option B: no host arena). */
  private unwindActive = false;
  private moduleBuffer = 0;
  private didSetup = false;

  constructor(options: ForkModuleBackendOptions) {
    this.exports = options.exports;
    this.memory = options.memory;
    this.ptrWidth = options.ptrWidth;
    this.format = options.format;
    this.catalogOrdinals = options.catalogOrdinals;
    this.channelBase = options.channelBase;
    this.frameArena = options.frameArena;
    this.reserveRegion = options.reserveRegion;
    this.releaseRegion = options.releaseRegion;
    this.pid = options.pid;
    this.label = options.label;
    if (
      !Number.isSafeInteger(this.channelBase)
      || this.channelBase <= 0
      || this.channelBase % WASM_PAGE_SIZE !== 0
    ) {
      throw new RangeError(
        `${this.label}: fork-module channel base must be a positive page multiple`,
      );
    }
    if (this.catalogOrdinals.length > FORK_MODULE_RESUME_CATALOG_CAP) {
      throw new RangeError(
        `${this.label}: resume catalog of ${this.catalogOrdinals.length} exceeds `
          + `the module cap ${FORK_MODULE_RESUME_CATALOG_CAP}`,
      );
    }
  }

  /**
   * Seed the linked-frame format and the FULL resume catalog once per worker,
   * before any fork. Both are host-known (the guest module's custom sections),
   * so this runs at process init on every worker that may drive a module fork.
   */
  setup(): void {
    if (this.didSetup) {
      throw new Error(`${this.label}: fork-module backend is already set up`);
    }
    this.exports.fm_set_format(this.ptrWidth, this.format.fixedPrefixSize);
    this.requireOk("fm_set_format");
    const count = this.catalogOrdinals.length;
    if (count > 0) {
      const byteLen = count * 4;
      const regionBytes = alignUpPage(byteLen);
      const scratch = this.reserveRegion(regionBytes);
      try {
        const view = new DataView(this.memory.buffer);
        for (let i = 0; i < count; i++) {
          view.setUint32(scratch + i * 4, this.catalogOrdinals[i]! >>> 0, true);
        }
        this.exports.fm_set_resume_catalog(this.wptr(scratch), this.wptr(count));
        this.requireOk("fm_set_resume_catalog");
      } finally {
        this.releaseRegion(scratch, regionBytes);
      }
    }
    this.didSetup = true;
  }

  /** Number of frames the module has committed since worker start (proof-of-use). */
  framesCommitted(): bigint {
    return BigInt(this.exports.fm_frames_committed() as number | bigint);
  }

  /**
   * Number of frames the module has REPLAYED (consuming rewind advances) since
   * worker start (Phase 6 D7b proof-of-use). A replay-only forked child never
   * commits a frame, so `framesCommitted()` stays 0 on the child; this counter
   * advances once per consumed frame and is the child worker's positive proof
   * that its rewind ran through the module, not a silent JS fallback.
   */
  framesReplayed(): bigint {
    return BigInt(this.exports.fm_frames_replayed() as number | bigint);
  }

  /**
   * Number of references (funcref or null) the module has reconstructed since
   * worker start (Phase 6 D6.1 proof-of-use). Advances only when
   * `__wpk_fork_ref_decode_funcref` runs through the module; a silent JS
   * fallback leaves it unchanged.
   */
  referencesReconstructed(): bigint {
    return BigInt(
      this.exports.fm_references_reconstructed() as number | bigint,
    );
  }

  /**
   * Number of externrefs the module has re-rooted through the `wpk_fork_host`
   * engine-floor seam since worker start (Phase 6 D6.2 proof-of-use). Advances
   * only when `fm_begin_reference_replay` drives `resolve_externref` through the
   * module; a silent JS fallback leaves it unchanged.
   */
  externrefsResolved(): bigint {
    return BigInt(this.exports.fm_externrefs_resolved() as number | bigint);
  }

  /**
   * Number of exnref nodes the module has admitted and driven since worker start
   * (Phase 6 D6.3a proof-of-use). Advances only when `fm_begin_reference_replay`
   * drives an exnref-bearing graph through the module; a silent JS fallback
   * leaves it unchanged.
   */
  exnrefsReconstructed(): bigint {
    return BigInt(this.exports.fm_exnrefs_reconstructed() as number | bigint);
  }

  /**
   * Number of typed-GC nodes (struct + array + i31) the module has admitted and
   * driven since worker start (Phase 6 D6.4a proof-of-use). Advances only when
   * `fm_begin_reference_replay` drives a typed-GC graph through the module; a
   * silent JS fallback leaves it unchanged.
   */
  gcNodesReconstructed(): bigint {
    return BigInt(this.exports.fm_gc_nodes_reconstructed() as number | bigint);
  }

  /**
   * Number of static roots the static-root binder has published into the anyref
   * transit since worker start (proof-of-use). Advances only when the module's
   * DRIVE_OP_STATIC_ROOT step resolved + republished an immutable static root
   * (`fm_static_root_slot`); a silent JS `publishTransit` fallback leaves it
   * unchanged.
   */
  staticRootsPublished(): bigint {
    return BigInt(this.exports.fm_static_roots_published() as number | bigint);
  }

  /**
   * Number of typed-GC drive STEPS the module has executed since worker start
   * (Phase 6 item 3c proof-of-use). Distinct from `gcNodesReconstructed`, which
   * `fm_begin_reference_replay` bumps merely by ADMITTING the graph (the item 3a
   * data feed): this advances ONLY when `driveTypedGraph` ran the module's
   * `fm_build_gc_plan` + `fm_drive_execute`, so a nonzero value proves the module
   * — not the JS `materializeAllTyped` fallback — drove the typed allocate/fill/
   * exn topological order. Never resets.
   */
  driveStepsExecuted(): bigint {
    return BigInt(this.exports.fm_drive_steps_executed() as number | bigint);
  }

  /**
   * Seed ONE activation's raw KFGC (`kandelo.wpk_fork.gc_codec`) section bytes
   * for this worker (Phase 6 item 3c). Staged into guest memory the same way
   * `setup()` stages the resume catalog; the module copies them into its own
   * arena, so the scratch is released immediately after. Called ONCE per
   * participating activation per worker, before any fork drives the GC plan.
   */
  setActivationGcCodec(activationId: number, bytes: Uint8Array): void {
    this.requireSetup("seed activation GC codec");
    const byteLen = bytes.byteLength;
    if (byteLen === 0) {
      throw new RangeError(
        `${this.label}: activation ${activationId} GC codec is empty`,
      );
    }
    const regionBytes = alignUpPage(byteLen);
    const scratch = this.reserveRegion(regionBytes);
    try {
      new Uint8Array(this.memory.buffer, scratch, byteLen).set(bytes);
      this.exports.fm_set_activation_gc_codec(
        activationId,
        this.wptr(scratch),
        this.wptr(byteLen),
      );
      this.requireOk("fm_set_activation_gc_codec");
    } finally {
      this.releaseRegion(scratch, regionBytes);
    }
  }

  /**
   * Seed the host-exception owner for this worker (Phase 6 item 3c): the smallest
   * activation that declared an exception codec descriptor, which the drive plan
   * uses to remap a HOST-exception exnref's owner exactly as the JS `directOwner`.
   * Pass `0xffff_ffff` when there is no such owner (the JS `null`). Called ONCE
   * per worker, before any fork drives the GC plan.
   */
  setHostExceptionOwner(owner: number): void {
    this.requireSetup("set host exception owner");
    this.exports.fm_set_host_exception_owner(owner >>> 0);
    this.requireOk("fm_set_host_exception_owner");
  }

  /**
   * Build the topological typed-GC drive plan for this fork's reference graph and
   * execute it through the module (Phase 6 item 3c). Requires
   * `beginReferenceReplay` to have seeded the driver and every participating GC
   * activation's `setActivationGcCodec` to have seeded its layout catalog. The
   * injected `fm_drive_execute` shim `call_indirect`s the guest's
   * `_gc_allocate`/`_gc_fill`/`_exception_materialize` exports (host-bound into
   * the drive table) in the plan order, and traps on a post-allocate integrity
   * violation rather than reconstructing a wrong object. Returns the executed
   * step count (0 when the graph has no typed-GC nodes). A failed plan build is a
   * truthful throw, never a silent wrong drive.
   */
  driveTypedGraph(): number {
    this.requireSetup("drive typed graph");
    const planPtr = this.toNum(this.exports.fm_build_gc_plan(this.pid));
    this.requireOk("fm_build_gc_plan");
    const count = Number(this.exports.fm_gc_plan_count() as number | bigint);
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new Error(
        `${this.label}: fm_gc_plan_count returned invalid count ${count}`,
      );
    }
    if (count === 0) return 0;
    if (!Number.isSafeInteger(planPtr) || planPtr <= 0) {
      throw new Error(
        `${this.label}: fm_build_gc_plan returned invalid plan ptr ${planPtr}`,
      );
    }
    // The injected shim owns its own truthful failure (a post-allocate integrity
    // violation traps with `unreachable`); it sets no errno, so there is nothing
    // to `requireOk` after it — completion IS success.
    this.exports.fm_drive_execute(this.wptr(planPtr), count);
    return count;
  }

  /**
   * Reconstruction-orchestration ENTRY (Phase 6). Seed the reference replay
   * driver/feed from the inherited KFMS arena rooted at `moduleStateRoot` AND
   * build the whole topological drive plan in ONE module call
   * (`fm_restore_from_arena` = the collapsed `fm_begin_reference_replay` +
   * `fm_build_gc_plan`), returning the plan's guest address for
   * `driveRestoredPlan`. This moves the reference SEEDING + drive-order
   * CONSTRUCTION into the module: the host no longer issues a separate
   * `beginReferenceReplay` and then rebuilds the plan inside the drive closure.
   * GC graphs still require each participating activation's `setActivationGcCodec`
   * to have run at worker init (exactly as `driveTypedGraph` does). A missing
   * driver, un-seeded GC activation, malformed arena, or an unadmitted reference
   * kind (`EOPNOTSUPP`, host keeps the JS path) is a truthful throw, never a
   * wrong plan.
   */
  restoreFromArena(moduleStateRoot: number): number {
    this.requireSetup("restore from arena");
    const planPtr = this.toNum(
      this.exports.fm_restore_from_arena(this.wptr(moduleStateRoot), this.pid),
    );
    this.requireOk("fm_restore_from_arena");
    return planPtr;
  }

  /**
   * Child-install ENTRY for a COW module-backed child (Phase 6). Seeds the
   * reference replay driver from the inherited KFMS arena AND builds ONE drive
   * plan whose tail drives every activation's guest
   * `wpk_fork_module_state_restore` / `wpk_fork_module_state_finish_restore`
   * through the host-bound drive table — moving the JS `restoreModuleState`
   * two-phase install SEQUENCING into the module. Supersedes `restoreFromArena`
   * on the module-on child attach path: same reconstruction seed + plan build,
   * plus the appended restore/finish steps. Returns the plan's guest address for
   * `driveRestoredPlan` (the step count includes the restore/finish steps and is
   * read from `fm_gc_plan_count`). A missing driver, un-seeded GC activation, or
   * malformed arena is a truthful throw.
   */
  attachChild(moduleStateRoot: number): number {
    this.requireSetup("attach child");
    const planPtr = this.toNum(
      this.exports.fm_attach_child(this.wptr(moduleStateRoot), this.pid),
    );
    this.requireOk("fm_attach_child");
    return planPtr;
  }

  /**
   * Child-install ENTRY for a vfork BORROWED module-backed child. The install
   * plan is byte-identical to `attachChild`; the only borrowed-specific work (the
   * child-private replay-prefix reservation) is raw host memory management handled
   * by the coordinator, not this module call. Kept as a distinct entry so the
   * borrowed path is explicit and future borrowed-specific install divergence has
   * a home.
   */
  attachBorrowedChild(moduleStateRoot: number): number {
    this.requireSetup("attach borrowed child");
    const planPtr = this.toNum(
      this.exports.fm_attach_borrowed_child(this.wptr(moduleStateRoot), this.pid),
    );
    this.requireOk("fm_attach_borrowed_child");
    return planPtr;
  }

  /**
   * Path-A INC-C: decode the inherited KFMS module-state arena rooted at
   * `moduleStateRoot` into the module's RESIDENT read-only reference graph and
   * return its node count. Distinct from `restoreFromArena`/`attachChild` (which
   * seed the replay DRIVER): this seeds ONLY the read-only decoded graph so the
   * host can read node kinds + coordinates from the module (`decodedNodeKind` /
   * `decodedNodeModuleActivation` / `decodedNodeOrdinal`) instead of walking the
   * JS `decodeSegmentedForkReferenceTransaction` structure. Reuses the SAME
   * shared arena decode as the replay entry, so the resident structure is
   * byte-identical to the JS decode. Reclaims any prior resident graph and
   * survives a later `attachChild` (which does not touch it), so a pre-instance
   * decode stays readable across the post-instance attach.
   */
  decodeReferenceGraph(moduleStateRoot: number): number {
    this.requireSetup("decode reference graph");
    const count = this.toNum(
      this.exports.fm_decode_reference_graph(this.wptr(moduleStateRoot)),
    );
    this.requireOk("fm_decode_reference_graph");
    return count;
  }

  /**
   * The node count of the module's resident decoded reference graph (the
   * `decodeReferenceGraph` result). Fails loudly (`fm_last_errno`) if no graph is
   * resident.
   */
  decodedNodeCount(): number {
    this.requireSetup("decoded node count");
    const count = this.toNum(this.exports.fm_decoded_node_count());
    this.requireOk("fm_decoded_node_count");
    return count;
  }

  /**
   * The wire node-kind discriminant (`0..=7`: null 0, funcref 1, externref 2,
   * exnref 3, i31 4, struct 5, array 6, static-root 7) of the resident decoded
   * graph node at `index` (== canonical node id). Fails loudly if no graph is
   * resident or `index` is out of range.
   */
  decodedNodeKind(index: number): number {
    this.requireSetup("decoded node kind");
    // `index` is a `usize` module argument, so it takes the same guest-word
    // conversion as a pointer (i64 on wasm64, i32 on wasm32).
    const kind = this.toNum(this.exports.fm_decoded_node_kind(this.wptr(index)));
    this.requireOk("fm_decoded_node_kind");
    return kind;
  }

  /**
   * The `module_activation` coordinate of the resident decoded graph node at
   * `index` (funcref/exnref/struct/array/static-root). Fails loudly if no graph
   * is resident, `index` is out of range, or the node's kind carries no
   * activation (null/externref/i31) — callers must gate on `decodedNodeKind`.
   */
  decodedNodeModuleActivation(index: number): number {
    this.requireSetup("decoded node module activation");
    const value = this.toNum(
      this.exports.fm_decoded_node_module_activation(this.wptr(index)),
    );
    this.requireOk("fm_decoded_node_module_activation");
    return value;
  }

  /**
   * The kind-specific ordinal ("second word") of the resident decoded graph node
   * at `index`: funcref function ordinal, exnref tag ordinal, struct/array type
   * ordinal, static-root static-root ordinal. Fails loudly if no graph is
   * resident, `index` is out of range, or the node's kind carries no ordinal
   * (null/externref/i31) — callers must gate on `decodedNodeKind`.
   */
  decodedNodeOrdinal(index: number): number {
    this.requireSetup("decoded node ordinal");
    const value = this.toNum(
      this.exports.fm_decoded_node_ordinal(this.wptr(index)),
    );
    this.requireOk("fm_decoded_node_ordinal");
    return value;
  }

  /**
   * Execute a drive plan previously built by `restoreFromArena` through the
   * injected `fm_drive_execute` shim. Mirrors `driveTypedGraph`'s count/ptr
   * validation but consumes the PRE-BUILT plan rather than rebuilding it — the
   * plan-BUILD moved to the `restoreFromArena` entry. The shared anyref transit
   * must already be sized by the caller's `prepareTransit` (the host-side floor
   * the module cannot size from Rust). Returns the executed step count (0 for a
   * graph with no drivable node, e.g. funcref/null-only).
   */
  driveRestoredPlan(planPtr: number): number {
    this.requireSetup("drive restored plan");
    const count = Number(this.exports.fm_gc_plan_count() as number | bigint);
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new Error(
        `${this.label}: fm_gc_plan_count returned invalid count ${count}`,
      );
    }
    if (count === 0) return 0;
    if (!Number.isSafeInteger(planPtr) || planPtr <= 0) {
      throw new Error(
        `${this.label}: fm_restore_from_arena returned invalid plan ptr ${planPtr}`,
      );
    }
    // The injected shim owns its own truthful failure (a post-allocate integrity
    // violation traps with `unreachable`); it sets no errno, so completion IS
    // success.
    this.exports.fm_drive_execute(this.wptr(planPtr), count);
    return count;
  }

  /**
   * Seed the module's funcref/null reference graph for this fork from the KFMS
   * module-state arena rooted at `moduleStateRoot` (Phase 6 D6.1). The caller
   * gates this on the funcref-only reference predicate; the module re-checks and
   * fails loudly (`EOPNOTSUPP`) if the graph is not funcref/null, so an
   * unsupported reference can never be driven through the flipped funcref import.
   * Must run before the guest rewind that reconstructs references.
   */
  beginReferenceReplay(moduleStateRoot: number): void {
    this.requireSetup("begin reference replay");
    this.exports.fm_begin_reference_replay(this.wptr(moduleStateRoot), this.pid);
    this.requireOk("fm_begin_reference_replay");
  }

  /**
   * The frame-region byte budget for the ONLY activation of a single-activation
   * fork: the whole arena minus the journal-image slab and the module-state
   * reserve. Activation 0 is the sole frame consumer, so it may bump-allocate
   * its linked frame chunks up to this budget — a deep linked continuation grows
   * within the bounded arena (the pre-Fix-X growable behavior, re-expressed as a
   * bound) rather than tripping the fixed 128 KiB multi-activation sub-cap. Past
   * the budget the module's `ChunkAllocator` fails with a truthful `ENOMEM`.
   */
  singleActivationFrameBudget(): number {
    const budget =
      this.frameArena.capacity()
      - FORK_MODULE_JOURNAL_SLAB_BYTES
      - FORK_MODULE_MODULE_STATE_RESERVE_BYTES;
    // Never hand out less than the multi-activation slab, and stay page-aligned
    // (the module-state arena validates page-aligned chunk bases).
    const floored = Math.max(budget, FORK_MODULE_FRAME_SLAB_BYTES);
    return floored - (floored % WASM_PAGE_SIZE);
  }

  /**
   * Parent: begin the module unwind over a slab of the pre-reserved fork-frame
   * arena (Fix X). The module bump-allocates its linked frame chunks WITHIN this
   * slab, so the unwind never grows guest memory. `frameSlabBytes` is the slab
   * size — `FORK_MODULE_FRAME_SLAB_BYTES` for one activation of a multi-activation
   * fork, or `singleActivationFrameBudget()` for the sole activation of a
   * single-activation fork (so a deep continuation can grow up to the arena
   * bound). Returns the module-buffer anchor (the continuation root) the
   * coordinator writes into the module-state prefix and passes to
   * `wpk_fork_unwind_begin`. The caller (`worker-main`) resets the arena cursor
   * once, before this fork's first allocation.
   */
  beginUnwind(frameSlabBytes: number = FORK_MODULE_FRAME_SLAB_BYTES): number {
    this.requireSetup("begin unwind");
    if (this.unwindActive) {
      throw new Error(`${this.label}: fork-module unwind already active`);
    }
    const slab = this.frameArena.allocate(frameSlabBytes);
    const moduleBuffer = this.toNum(
      this.exports.fm_begin_unwind_fixed_arena(
        0,
        this.wptr(slab),
        this.wptr(frameSlabBytes),
      ),
    );
    this.requireOk("fm_begin_unwind_fixed_arena");
    if (!Number.isSafeInteger(moduleBuffer) || moduleBuffer <= 0) {
      throw new Error(`${this.label}: fm_begin_unwind_fixed_arena returned invalid anchor`);
    }
    this.unwindActive = true;
    this.moduleBuffer = moduleBuffer;
    return moduleBuffer;
  }

  /**
   * Parent: close the unwind and serialize the sealed journal as a KFRE image
   * into a FRESH chunk the module channel-mmaps itself (Option B). Returns the
   * image chunk's guest offset and byte length; the coordinator records both in
   * a `JournalImage` KFMS record so the forked child finds the inherited image
   * (it no longer sits at a host-computed arena offset). The chunk is released
   * with the frame chunks on `finishReplay`/`abort`.
   */
  finishUnwindAndSerialize(): ForkModuleJournalImage {
    this.exports.fm_finish_unwind();
    this.requireOk("fm_finish_unwind");
    // Fix X: serialize the journal into a slab of the pre-reserved fork-frame
    // arena (the fixed-arena unwind left the module's `channel_base = 0`, so the
    // channel serializer is unusable), so the journal image does not grow guest
    // memory. An image larger than the slab is a truthful module `ENOMEM`.
    const journalSlab = this.frameArena.allocate(FORK_MODULE_JOURNAL_SLAB_BYTES);
    const ptr = this.toNum(
      this.exports.fm_serialize_journal_fixed_arena(
        this.wptr(journalSlab),
        this.wptr(FORK_MODULE_JOURNAL_SLAB_BYTES),
      ),
    );
    this.requireOk("fm_serialize_journal_fixed_arena");
    const len = this.toNum(this.exports.fm_journal_image_len());
    if (!Number.isSafeInteger(ptr) || ptr <= 0) {
      throw new Error(
        `${this.label}: fm_serialize_journal_fixed_arena returned invalid image ptr ${ptr}`,
      );
    }
    if (!Number.isSafeInteger(len) || len <= 0) {
      throw new Error(
        `${this.label}: fm_journal_image_len returned invalid length ${len}`,
      );
    }
    return { ptr, len };
  }

  /** Parent: begin the rewind (attach the driver + register resume slots). */
  beginParentReplay(): void {
    this.exports.fm_begin_replay();
    this.requireOk("fm_begin_replay");
  }

  /**
   * Parent abort-replay: begin (mirror of `beginParentReplay`, abort-tagged).
   * Drives the exact same frame/journal mechanics as `beginParentReplay` —
   * the module records the drive as an abort internally so `finishAbort` can
   * assert the pairing (F1).
   */
  beginAbort(): void {
    this.exports.fm_begin_abort();
    this.requireOk("fm_begin_abort");
  }

  /**
   * Child: seed replay from the copied guest memory (Option B). `root` is the
   * inherited continuation anchor (the parent's module buffer at the same guest
   * offset); `imagePtr`/`imageLen` come from the inherited `JournalImage` KFMS
   * record the parent wrote (the image was channel-mmap'd, so there is no
   * host-computed arena offset to derive it from). Both are inherited verbatim
   * by the fork memory copy.
   */
  beginChildReplay(root: number, imagePtr: number, imageLen: number): void {
    this.requireSetup("begin child replay");
    if (!Number.isSafeInteger(root) || root <= 0) {
      throw new Error(`${this.label}: inherited continuation root ${root} is invalid`);
    }
    if (!Number.isSafeInteger(imagePtr) || imagePtr <= 0) {
      throw new Error(`${this.label}: inherited journal image ptr ${imagePtr} is invalid`);
    }
    if (!Number.isSafeInteger(imageLen) || imageLen <= 0) {
      throw new Error(`${this.label}: inherited journal image length ${imageLen} is invalid`);
    }
    if (imagePtr + imageLen > this.memory.buffer.byteLength) {
      throw new Error(`${this.label}: inherited journal image escapes guest memory`);
    }
    this.moduleBuffer = root;
    this.exports.fm_begin_child_replay(
      this.wptr(root),
      this.wptr(imagePtr),
      this.wptr(imageLen),
    );
    this.requireOk("fm_begin_child_replay");
  }

  /**
   * vfork BORROWED child: seed replay from the parked parent's LIVE (shared)
   * memory rather than a private copy. `root` is the parent's continuation anchor
   * (borrowed, read-only); `imagePtr`/`imageLen` locate the KFRE image the parent
   * serialized (still live in shared memory); `privatePrefix` is a child-private,
   * pre-reserved region the module copies the parent's fixed runtime prefix into,
   * so the guest's rewind writes its active-frame pointer THERE and never touches
   * the parent's prefix. The built replay owns no chunks, so this backend's
   * `finishReplay`/`abort` (`fm_finish_replay`/`fm_abort`) munmap nothing — the
   * parent's storage is never released. On success the host hands the guest
   * `privatePrefix` as the rewind root.
   */
  beginBorrowedChildReplay(
    root: number,
    imagePtr: number,
    imageLen: number,
    privatePrefix: number,
  ): void {
    this.requireSetup("begin borrowed child replay");
    if (!Number.isSafeInteger(root) || root <= 0) {
      throw new Error(`${this.label}: borrowed continuation root ${root} is invalid`);
    }
    if (!Number.isSafeInteger(imagePtr) || imagePtr <= 0) {
      throw new Error(`${this.label}: borrowed journal image ptr ${imagePtr} is invalid`);
    }
    if (!Number.isSafeInteger(imageLen) || imageLen <= 0) {
      throw new Error(`${this.label}: borrowed journal image length ${imageLen} is invalid`);
    }
    if (imagePtr + imageLen > this.memory.buffer.byteLength) {
      throw new Error(`${this.label}: borrowed journal image escapes guest memory`);
    }
    if (!Number.isSafeInteger(privatePrefix) || privatePrefix <= 0) {
      throw new Error(`${this.label}: borrowed private prefix ${privatePrefix} is invalid`);
    }
    if (privatePrefix + this.format.fixedPrefixSize > this.memory.buffer.byteLength) {
      throw new Error(`${this.label}: borrowed private prefix escapes guest memory`);
    }
    this.moduleBuffer = root;
    this.exports.fm_begin_borrowed_child_replay(
      this.wptr(root),
      this.wptr(imagePtr),
      this.wptr(imageLen),
      this.wptr(privatePrefix),
    );
    this.requireOk("fm_begin_borrowed_child_replay");
  }

  /**
   * Phase 6 D7a.1a: seed ONE side activation's resume catalog once per worker,
   * before any fork (mirrors `setup()`'s global catalog seed for activation 0).
   * A dlopen fork loads N modules, each with its own fork-instrumented function
   * catalog; the module numbers each activation's resume slots from ITS catalog
   * so the slot numbering matches THAT activation's JS `__wpk_fork_resume_table`
   * by construction. Activation 0 stays on the GLOBAL catalog (`setup()`), so a
   * single-activation fork is byte-identical. A catalog that overflows the
   * module's per-activation arena fails loudly (`E2BIG`); the caller then keeps
   * the JavaScript continuation for that program.
   */
  setActivationResumeCatalog(
    activationId: number,
    ordinals: readonly number[],
  ): void {
    this.requireSetup("seed activation resume catalog");
    const count = ordinals.length;
    if (count === 0) return;
    if (count > FORK_MODULE_RESUME_CATALOG_CAP) {
      throw new RangeError(
        `${this.label}: activation ${activationId} resume catalog of ${count} `
          + `exceeds the module cap ${FORK_MODULE_RESUME_CATALOG_CAP}`,
      );
    }
    const byteLen = count * 4;
    const regionBytes = alignUpPage(byteLen);
    const scratch = this.reserveRegion(regionBytes);
    try {
      const view = new DataView(this.memory.buffer);
      for (let i = 0; i < count; i++) {
        view.setUint32(scratch + i * 4, ordinals[i]! >>> 0, true);
      }
      this.exports.fm_set_activation_resume_catalog(
        this.wptr(activationId),
        this.wptr(scratch),
        this.wptr(count),
      );
      this.requireOk("fm_set_activation_resume_catalog");
    } finally {
      this.releaseRegion(scratch, regionBytes);
    }
  }

  /**
   * Phase 6 D7a.1b: seed ONE activation's function-catalog BASE into the module,
   * once per worker, before any fork drives reference reconstruction. The host
   * lays every activation's funcref catalog into ONE merged
   * `__wpk_fork_function_catalog` table (activation `activationId`'s catalog at
   * slots `[base, base + len)`); the module's `fm_funcref_ordinal` then returns
   * the global slot `base(module_activation) + function_ordinal`, so a funcref
   * minted in one activation but held by another's frame resolves against its own
   * activation's slice. A single-activation fork seeds NO base (the module
   * defaults `base = 0`, byte-identical to the D6.1 raw-ordinal mapping).
   */
  setActivationCatalogBase(activationId: number, base: number): void {
    this.requireSetup("set activation catalog base");
    this.exports.fm_set_activation_catalog_base(activationId, base);
    this.requireOk("fm_set_activation_catalog_base");
  }

  /**
   * Seed ONE activation's static-root catalog BASE for this worker (the
   * static-root binder — the funcref merged-catalog mechanism, for static roots).
   * Called once per activation, before any fork drives reference reconstruction.
   * The host lays every activation's instantiation-time static-root catalog into
   * ONE merged `env.__wpk_fork_static_root_catalog` anyref table (activation
   * `activationId`'s catalog at slots `[base, base + len)`); the module's
   * `fm_static_root_slot` then returns the global index `base(module_activation) +
   * static_root_ordinal` the injected drive shim `table.get`s. A single-activation
   * fork seeds NO base (the module defaults `base = 0`, byte-identical to the
   * raw-ordinal mapping).
   */
  setActivationStaticRootBase(activationId: number, base: number): void {
    this.requireSetup("set activation static-root base");
    this.exports.fm_set_activation_static_root_base(activationId, base);
    this.requireOk("fm_set_activation_static_root_base");
  }

  /**
   * Parent: add a dlopen fork's SIDE activation to the capture begun by
   * `beginUnwind`. Reserves ITS own host frame arena and calls
   * `fm_add_activation_unwind(act, base, len, fixedPrefix)`. Returns the
   * activation's module-buffer anchor (the continuation root the coordinator
   * writes into its module-state prefix and passes to `wpk_fork_unwind_begin`).
   */
  addActivationUnwind(activationId: number, fixedPrefix: number): number {
    this.requireSetup("add activation unwind");
    if (activationId === 0) {
      throw new Error(`${this.label}: activation 0 uses beginUnwind, not addActivationUnwind`);
    }
    // Fix X: this activation bump-allocates its frame chunks within its OWN slab
    // of the pre-reserved fork-frame arena — disjoint from activation 0's slab
    // and every other activation's, since the shared cursor only advances. No
    // channel mmap, so a multi-activation (dlopen) fork does not grow guest
    // memory either.
    const slab = this.frameArena.allocate(FORK_MODULE_FRAME_SLAB_BYTES);
    const moduleBuffer = this.toNum(
      this.exports.fm_add_activation_unwind_fixed_arena(
        this.wptr(activationId),
        this.wptr(slab),
        this.wptr(FORK_MODULE_FRAME_SLAB_BYTES),
        this.wptr(fixedPrefix),
      ),
    );
    this.requireOk("fm_add_activation_unwind_fixed_arena");
    if (!Number.isSafeInteger(moduleBuffer) || moduleBuffer <= 0) {
      throw new Error(
        `${this.label}: fm_add_activation_unwind_fixed_arena returned invalid anchor for `
          + `activation ${activationId}`,
      );
    }
    return moduleBuffer;
  }

  /**
   * Child: add a dlopen fork's SIDE activation to the replay begun by
   * `beginChildReplay`. `root` is the activation's inherited continuation anchor
   * (its parent module buffer at the same guest offset), `fixedPrefix` its own
   * module-buffer fixed runtime prefix. The process-wide journal is not reseeded:
   * this attaches the activation's replay-only frame state against the SAME
   * journal + table `beginChildReplay` created.
   */
  addActivationChildReplay(
    activationId: number,
    root: number,
    fixedPrefix: number,
  ): void {
    this.requireSetup("add activation child replay");
    if (!Number.isSafeInteger(root) || root <= 0) {
      throw new Error(
        `${this.label}: activation ${activationId} inherited continuation root `
          + `${root} is invalid`,
      );
    }
    this.exports.fm_add_activation_child_replay(
      this.wptr(activationId),
      this.wptr(root),
      this.wptr(fixedPrefix),
    );
    this.requireOk("fm_add_activation_child_replay");
  }

  /**
   * vfork BORROWED child: add a dlopen-vfork ("mode-1") SIDE activation to the
   * replay begun by `beginBorrowedChildReplay`. Like `addActivationChildReplay`,
   * but reads the parent's borrowed continuation read-only and copies this side's
   * fixed prefix into its own child-private `privatePrefix`. Owns no chunks.
   */
  addActivationBorrowedChildReplay(
    activationId: number,
    root: number,
    fixedPrefix: number,
    privatePrefix: number,
  ): void {
    this.requireSetup("add activation borrowed child replay");
    if (!Number.isSafeInteger(root) || root <= 0) {
      throw new Error(
        `${this.label}: borrowed activation ${activationId} continuation root `
          + `${root} is invalid`,
      );
    }
    if (!Number.isSafeInteger(privatePrefix) || privatePrefix <= 0) {
      throw new Error(
        `${this.label}: borrowed activation ${activationId} private prefix `
          + `${privatePrefix} is invalid`,
      );
    }
    if (privatePrefix + fixedPrefix > this.memory.buffer.byteLength) {
      throw new Error(
        `${this.label}: borrowed activation ${activationId} private prefix escapes `
          + "guest memory",
      );
    }
    this.exports.fm_add_activation_borrowed_child_replay(
      this.wptr(activationId),
      this.wptr(root),
      this.wptr(fixedPrefix),
      this.wptr(privatePrefix),
    );
    this.requireOk("fm_add_activation_borrowed_child_replay");
  }

  /**
   * Finish the rewind. Option B: the MODULE owns the frame + image chunks it
   * mmap'd and releases them itself inside `fm_finish_replay` (a replay-only
   * child mapped nothing, so it releases nothing).
   */
  finishReplay(): void {
    this.exports.fm_finish_replay();
    this.requireOk("fm_finish_replay");
    this.unwindActive = false;
    this.moduleBuffer = 0;
  }

  /**
   * Finish an abort-replay (mirror of `finishReplay`). A stray call without a
   * matching `beginAbort()` is a loud throw (`requireOk` surfaces the
   * module's `EINVAL` pairing guard), never a silent no-op (F1).
   */
  finishAbort(): void {
    this.exports.fm_finish_abort();
    this.requireOk("fm_finish_abort");
    this.unwindActive = false;
    this.moduleBuffer = 0;
  }

  /**
   * Release every channel-mapped frame/image chunk on the error/abort path
   * (Option B: the module owns them, so `fm_abort` munmaps them). Best-effort —
   * does not assert module success. A replay-only child mapped nothing.
   */
  abort(): void {
    this.exports.fm_abort();
    this.unwindActive = false;
    this.moduleBuffer = 0;
  }

  private requireSetup(operation: string): void {
    if (!this.didSetup) {
      throw new Error(
        `${this.label}: cannot ${operation}; fork-module backend is not set up`,
      );
    }
  }

  private requireOk(call: string): void {
    const errno = Number(this.exports.fm_last_errno() as number | bigint);
    if (errno !== 0) {
      throw new Error(`${this.label}: ${call} failed with errno=${errno}`);
    }
  }

  private wptr(value: number): number | bigint {
    return this.ptrWidth === 8 ? BigInt(value) : value;
  }

  private toNum(value: number | bigint): number {
    return typeof value === "bigint" ? Number(value) : value;
  }
}

function alignUpPage(value: number): number {
  return Math.ceil(value / WASM_PAGE_SIZE) * WASM_PAGE_SIZE;
}
