import {
  WPK_FORK_RESUME_IMPORT_TABLE,
} from "./generated/abi";
import {
  type ForkActivationRegistration,
  ForkActivationRegistry,
} from "./fork-activation-registry";
import {
  ContinuationAllocationError,
  invokeForkContinuationBegin,
  type LinkedFrameFormatDescriptor,
} from "./fork-continuation";
import {
  decodeForkActivationContinuations,
  type ForkModuleStateArena,
  ForkModuleStateRecordKind,
  journalImageForChild,
  writeForkModuleStateRoot,
} from "./fork-module-state";
import type { ForkModuleContinuationBackend } from "./fork-module-backend";
import {
  type ForkResumeTarget,
  ForkResumeTable,
} from "./fork-replay-events";
import type { WasmGuestPointer } from "./wasm-guest-pointer";
import type {
  DecodedSegmentedForkReferenceTransaction,
} from "./fork-reference-segments";

/**
 * The subset of a fork activation the co-resident-module coordinator needs from
 * each registered activation: its linked-frame format descriptor (pointer
 * width, prefix/alignment). The Rust fork-module owns every linked frame, the
 * journal, and the resume slots (Phase 4 point of no return deleted the JS
 * `LinkedForkContinuation` frame storage), so the host no longer holds a
 * per-activation JS frame allocator/validator.
 */
export interface ForkActivationContinuation {
  readonly format: LinkedFrameFormatDescriptor;
}

const WPK_FORK_NORMAL = 0;
const WPK_FORK_UNWINDING = 1;
const WPK_FORK_REWINDING = 2;
const WPK_FORK_ABORT_UNWINDING = 3;

type ProcessContinuationPhase =
  | "idle"
  | "capture"
  | "sealed-parent"
  | "parent-replay"
  | "child-replay"
  | "abort-replay";

type ProcessReplayOwnership = "owned" | "borrowed";

export interface ForkBorrowedReplayPrefixRequest {
  readonly activationId: number;
  readonly byteLength: number;
  readonly alignment: number;
}

export type ForkBorrowedReplayPrefixAllocator = (
  request: ForkBorrowedReplayPrefixRequest,
) => WasmGuestPointer;

export interface ForkBorrowedReplayWorkspaceRequirements {
  readonly prefixBytes: number;
  readonly scratchBytes: number;
}

export interface ForkProcessActivationBinding {
  readonly activationId: number;
  readonly continuation: ForkActivationContinuation;
  /**
   * Publish the process launch root in process-owned copied memory.
   *
   * Only activation zero owns this process-wide anchor. Its value may name
   * any active activation's continuation: a side module can call the fork
   * import without placing a main-module Wasm frame on the captured stack.
   * A vfork child deliberately omits this writer: it may read the suspended
   * parent's root for borrowed replay, but must never clear or replace it.
   */
  readonly publishProcessLaunchRoot?: (address: number) => void;
  /** Read the copied or borrowed process launch root after instantiation. */
  readonly readProcessLaunchRoot?: () => number;
}

interface CompleteForkProcessActivation extends ForkProcessActivationBinding {
  readonly registration: ForkActivationRegistration;
  /** Parent-owned linked continuation prefix. */
  root: number;
  /** Prefix passed to this Worker's replay entry point. */
  replayRoot: number;
}

function assertActivationId(value: number): void {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new RangeError(`invalid fork process activation id ${value}`);
  }
}

function requireExportFunction(
  activation: CompleteForkProcessActivation,
  name: string,
): CallableFunction {
  const value = activation.registration.instance.exports[name];
  if (typeof value !== "function") {
    throw new Error(
      `fork activation ${activation.activationId} is missing export ${name}`,
    );
  }
  return value as CallableFunction;
}

function activationState(activation: CompleteForkProcessActivation): number {
  return Number(requireExportFunction(activation, "wpk_fork_state")());
}

/**
 * One process-worker transaction for linked frames from every module instance.
 *
 * Per-activation continuations still own their bytes because each artifact has
 * its own fixed runtime prefix. The event journal is process-wide: it records
 * the exact order in which frames from main and side modules commit, and
 * replay consumes the reverse order. No module-instance table slot is durable
 * state.
 */
export class ForkProcessContinuationCoordinator {
  readonly resumeTable = new ForkResumeTable();

  private readonly prepared = new Map<number, ForkProcessActivationBinding>();
  private readonly activations = new Map<number, CompleteForkProcessActivation>();
  private phase: ProcessContinuationPhase = "idle";
  private arena: ForkModuleStateArena | null = null;
  private replayOwnership: ProcessReplayOwnership | null = null;
  // F1: the errno recorded when abort-replay began. On the module path the JS
  // `LinkedForkContinuation` is unrooted and cannot hold it, so it is stored
  // here instead (populated on both the module and JS branches). Only cleared
  // on the successful-finish idle resets in `finishModuleTransaction` /
  // `finishTransaction`; a failed `beginCapture` leaves a stale value behind.
  // `abortErrno()` guards against reading that stale value by asserting
  // `phase === "abort-replay"` before returning it.
  #abortErrno: number | null = null;
  // Phase 6 D5 step 4b/5: when set (only by `enableModuleBacking`, only for a
  // QUALIFYING single-activation fork behind `WASM_POSIX_FORK_MODULE`), the
  // journal + frame storage + resume slots live in the co-resident fork-module
  // and the module-backed branches below drive them. Null on the JavaScript
  // default path, so every other fork is byte-identical to today.
  private moduleBackend: ForkModuleContinuationBackend | null = null;
  // Phase 6 D7a.1a: evict a per-activation frame trampoline when its activation
  // is unregistered/cleared. Set alongside `moduleBackend` for a dlopen fork;
  // null on the JS path and for single-activation module forks.
  private evictModuleActivation: ((activationId: number) => void) | null = null;
  // Phase 6 D6.1: when true (only via `enableModuleReferenceReplay`, only for a
  // qualifying FUNCREF-ONLY child fork whose guest `__wpk_fork_ref_decode_funcref`
  // import was flipped to the module), the child seeds the module's reference
  // graph and the module reconstructs funcref/null references during rewind.
  // False on every other fork (references stay on the JS provider), so the
  // reference path is byte-identical to today unless the funcref predicate holds.
  private moduleReferenceReplay = false;

  constructor(
    private readonly memory: WebAssembly.Memory,
    private readonly registry: ForkActivationRegistry,
    private readonly label: string,
  ) {}

  /**
   * Route this coordinator's next transaction through the co-resident module.
   *
   * The caller (worker-main) computes the qualifying predicate and passes a
   * fully set-up backend; the coordinator then takes its module-backed branches
   * for capture/seal/replay/finish. The JS journal (`this.events`) is left idle
   * for the module-backed activation — the module owns it, so there is no
   * double-journal — while the JS resume TABLE (`this.resumeTable`) still backs
   * the guest's `__wpk_fork_resume_table` funcref import (the module's
   * `resume_peek` returns slots into it, numbered identically by construction).
   */
  enableModuleBacking(
    backend: ForkModuleContinuationBackend,
    evictModuleActivation?: (activationId: number) => void,
  ): void {
    this.requireIdle("enable fork-module backing");
    if (this.moduleBackend) {
      throw new Error(`${this.label}: fork-module backing already enabled`);
    }
    this.moduleBackend = backend;
    this.evictModuleActivation = evictModuleActivation ?? null;
  }

  /** Whether the module-backed path is active (proof/diagnostics). */
  isModuleBacked(): boolean {
    return this.moduleBackend !== null;
  }

  /**
   * Route this child's funcref/null reference reconstruction through the module
   * (Phase 6 D6.1). The caller (worker-main) enables this ONLY when the child's
   * decoded reference graph is funcref/null AND its guest
   * `__wpk_fork_ref_decode_funcref` import was flipped to the module export.
   * Requires module frame backing to already be enabled.
   */
  enableModuleReferenceReplay(): void {
    this.requireIdle("enable fork-module reference replay");
    if (!this.moduleBackend) {
      throw new Error(
        `${this.label}: fork-module reference replay needs module backing`,
      );
    }
    this.moduleReferenceReplay = true;
  }

  /**
   * Bind frame imports before the Wasm instance exists.
   *
   * Instantiation then calls `registerActivation` with the reflected exports
   * and resume catalog. Splitting these steps avoids a circular dependency
   * between imports and the instance that implements the codecs.
   */
  prepareActivation(binding: ForkProcessActivationBinding): void {
    this.requireIdle("prepare a module activation");
    assertActivationId(binding.activationId);
    if (
      this.prepared.has(binding.activationId)
      || this.activations.has(binding.activationId)
    ) {
      throw new Error(
        `${this.label}: fork activation ${binding.activationId} is already prepared`,
      );
    }
    if (
      binding.activationId !== 0
      && (
        binding.publishProcessLaunchRoot !== undefined
        || binding.readProcessLaunchRoot !== undefined
      )
    ) {
      throw new Error(
        `${this.label}: only activation zero may own the process launch anchor`,
      );
    }
    if (
      binding.publishProcessLaunchRoot !== undefined
      && binding.readProcessLaunchRoot === undefined
    ) {
      throw new Error(
        `${this.label}: a writable process launch anchor must also be readable`,
      );
    }
    this.prepared.set(binding.activationId, binding);
  }

  registerActivation(
    registration: ForkActivationRegistration,
    resumeTargets: readonly ForkResumeTarget[],
  ): void {
    this.requireIdle("register a module activation");
    const binding = this.prepared.get(registration.activationId);
    if (!binding) {
      throw new Error(
        `${this.label}: fork activation ${registration.activationId} was not prepared`,
      );
    }
    this.registry.registerActivation(registration);
    try {
      this.resumeTable.registerActivation(registration.activationId, resumeTargets);
    } catch (error) {
      this.registry.unregisterActivation(registration.activationId);
      throw error;
    }
    this.prepared.delete(registration.activationId);
    this.activations.set(registration.activationId, {
      ...binding,
      registration,
      root: 0,
      replayRoot: 0,
    });
  }

  unregisterActivation(activationId: number): void {
    this.requireIdle("unregister a module activation");
    const activation = this.getActivation(activationId);
    this.resumeTable.unregisterActivation(activationId);
    this.registry.unregisterActivation(activationId);
    this.activations.delete(activationId);
    this.evictModuleActivation?.(activationId);
  }

  discardPreparedActivation(activationId: number): void {
    this.requireIdle("discard a prepared module activation");
    assertActivationId(activationId);
    if (!this.prepared.delete(activationId)) {
      throw new Error(
        `${this.label}: fork activation ${activationId} is not prepared`,
      );
    }
  }

  /**
   * The host-owned import each activation still needs: the guest's
   * `__wpk_fork_resume_table` funcref table.
   *
   * The co-resident Rust module owns the five per-frame/resume operations
   * (`__wpk_fork_frame_{reserve,commit,peek,next}` + `__wpk_fork_resume_peek`);
   * worker-main binds those directly to the module exports (or a per-activation
   * trampoline for a dlopen fork). The resume TABLE itself, however, is a host
   * `WebAssembly.Table` of guest resume thunks that must be an IMPORT (the
   * module's `resume_peek` returns a slot INDEX into it), so it remains the
   * irreducible host floor bound here. This replaced the JS
   * `LinkedForkContinuation` frame closures + `ForkReplayEventJournal` that the
   * Phase 4 point of no return deleted.
   */
  continuationImports(
    activationId: number,
  ): Record<string, WebAssembly.ImportValue> {
    assertActivationId(activationId);
    const binding = this.prepared.get(activationId)
      ?? this.activations.get(activationId);
    if (!binding) {
      throw new Error(
        `${this.label}: fork activation ${activationId} has no continuation binding`,
      );
    }
    return {
      [WPK_FORK_RESUME_IMPORT_TABLE]:
        this.resumeTable.table as unknown as WebAssembly.ImportValue,
    };
  }

  /**
   * Snapshot all activations, allocate their private runtime prefixes, and put
   * every instance in UNWINDING before the private transport crosses modules.
   */
  beginCapture(arena: ForkModuleStateArena): void {
    this.requirePhase("idle", "begin process continuation capture");
    if (arena.ownershipMode() !== "owned" || arena.isSealed()) {
      throw new Error(
        `${this.label}: capture requires a writable owned module-state arena`,
      );
    }
    if (this.prepared.size !== 0) {
      throw new Error(
        `${this.label}: cannot fork with ${this.prepared.size} incomplete activation(s)`,
      );
    }
    this.requireModuleBackend("begin process continuation capture");
    this.beginModuleCapture(arena);
  }

  /**
   * Close unwind, discard activations that were not on the captured stack,
   * and seal references, module state, and global frame ordering together.
   */
  sealCapture(): void {
    this.requirePhase("capture", "seal process continuation capture");
    this.requireModuleBackend("seal process continuation capture");
    this.sealModuleCapture();
  }

  beginParentReplay(): void {
    this.requirePhase("sealed-parent", "begin parent process replay");
    this.requireModuleBackend("begin parent process replay");
    this.beginModuleParentReplay();
  }

  /**
   * Attach copied state only after every fresh child activation is registered.
   */
  attachChild(
    arena: ForkModuleStateArena,
    adoptPreinstantiatedReferences?: () => void,
    decodedReferences?: DecodedSegmentedForkReferenceTransaction,
  ): void {
    this.requirePhase("idle", "attach child process replay");
    if (this.prepared.size !== 0) {
      throw new Error(
        `${this.label}: child has ${this.prepared.size} incomplete activation(s)`,
      );
    }
    if (arena.ownershipMode() !== "owned") {
      throw new Error(
        `${this.label}: copied child replay requires an owned module-state arena`,
      );
    }
    this.requireModuleBackend("attach child process replay");
    this.attachModuleChild(arena, adoptPreinstantiatedReferences, decodedReferences);
  }

  /**
   * Attach a fresh vfork child to parent-owned continuation and module state.
   *
   * Every active activation gets a child-owned mutable prefix. Linked frames,
   * replay events, reference recipes, and module-state records remain borrowed
   * from the suspended parent and are detached rather than consumed or freed.
   */
  attachBorrowedChild(
    arena: ForkModuleStateArena,
    reservePrefix: ForkBorrowedReplayPrefixAllocator,
    adoptPreinstantiatedReferences?: () => void,
    decodedReferences?: DecodedSegmentedForkReferenceTransaction,
  ): void {
    this.requireModuleBackend("attach borrowed child process replay");
    // Route the vfork BORROWED replay through the co-resident module (frames +
    // references), exactly as `attachModuleChild` does for a COW child — but
    // reading the parent's borrowed continuation read-only and writing the
    // guest's mutable prefix into a child-private region.
    this.attachBorrowedModuleChild(
      arena,
      reservePrefix,
      adoptPreinstantiatedReferences,
      decodedReferences,
    );
  }

  /**
   * The errno recorded when abort-replay began (module path: the JS
   * continuation is unrooted and cannot hold it). Valid only in the
   * "abort-replay" phase.
   */
  abortErrno(): number {
    this.requirePhase("abort-replay", "read abort errno");
    if (this.#abortErrno === null) {
      throw new Error(`${this.label}: no abort errno recorded`);
    }
    return this.#abortErrno;
  }

  /**
   * Switch a sealed parent transaction to allocation-failure replay.
   *
   * The caller first seals capture so every already-committed frame and
   * reference recipe has one deterministic owner. No child is launched.
   */
  beginAbortReplay(errno: number): void {
    this.requirePhase("sealed-parent", "begin process abort replay");
    if (!Number.isInteger(errno) || errno <= 0) {
      throw new RangeError(`${this.label}: invalid fork abort errno ${errno}`);
    }
    this.#abortErrno = errno;
    this.requireModuleBackend("begin process abort replay");
    this.beginModuleAbortReplay();
  }

  /**
   * Module-mode partial-capture abort — the mid-unwind sibling of the seal-time
   * abort in `sealModuleCapture`.
   *
   * The Phase 6 D5 import flip binds the guest's `__wpk_fork_frame_reserve`
   * straight to the module export, so a mid-unwind frame-allocation failure
   * returns 0 to the guest. The worker-main reserve wrapper reads the module
   * errno and calls this synchronously. The guest's reserve==0 contract
   * (fork-instrument `__wpk_fork_select_unwind_frame`
   * → the abort restart loop) EXPECTS the host to have ALREADY moved to abort
   * replay synchronously inside that reserve call. This makes that true for the
   * module path: seal the partial capture into `sealed-parent` (the module owns
   * the journal), then run the SAME proven module abort-replay `beginAbortReplay`
   * uses for a failed child launch — driving each activation's
   * `wpk_fork_abort_begin` to `ABORT_UNWINDING`. When the guest's abort replay
   * later re-enters `kernel_fork`, the coordinator is in `abort-replay`, the fork
   * returns `-errno`, the parent is fully intact, and no child was launched.
   *
   * Unlike `sealModuleCapture` this does NOT drive the guest `wpk_fork_unwind_end`
   * (the guest is mid-unwind) and does NOT serialize a journal image (no child).
   */
  beginModuleCaptureAbort(errno: number): void {
    this.requirePhase("capture", "begin module partial-capture abort replay");
    if (!this.moduleBackend) {
      throw new Error(
        `${this.label}: module partial-capture abort requires a module backend`,
      );
    }
    if (!Number.isInteger(errno) || errno <= 0) {
      throw new RangeError(`${this.label}: invalid fork abort errno ${errno}`);
    }
    try {
      // Seal the partial capture into "sealed-parent" WITHOUT the guest
      // unwind-end drive or journal serialization. A failed reserve left no
      // pending frame, so the committed chain is complete and seal-able.
      this.moduleBackend.sealForAbort();
      this.registry.sealCapture();
      this.publishProcessLaunchRoot(this.getActivation(0).root);
      this.phase = "sealed-parent";
    } catch (error) {
      this.abort();
      throw error;
    }
    // Reuse the proven module abort-replay path (drives `beginModuleAbortReplay`
    // → `backend.beginAbort()` + `wpk_fork_abort_begin` on each activation).
    this.beginAbortReplay(errno);
  }

  finishReplay(): void {
    if (this.phase !== "parent-replay" && this.phase !== "child-replay") {
      throw new Error(
        `${this.label}: cannot finish process replay while coordinator is ${this.phase}`,
      );
    }
    this.finishTransaction(false);
  }

  finishAbortReplay(): void {
    this.requirePhase("abort-replay", "finish process abort replay");
    this.finishTransaction(true);
  }

  phaseName(): ProcessContinuationPhase {
    return this.phase;
  }

  /**
   * Measure child-private workspace after the complete process graph seals.
   *
   * Prefixes remain live through inherited-frame rewind, while reference
   * scratch is stack-disciplined and reports its capture high-water. Keeping
   * the two regions separate lets the host use one control slot without
   * allowing either allocator to overwrite the other.
   */
  borrowedReplayWorkspaceRequirements(): ForkBorrowedReplayWorkspaceRequirements {
    this.requirePhase(
      "sealed-parent",
      "measure borrowed replay workspace",
    );
    let prefixBytes = 0;
    for (const activation of this.activeActivations()) {
      const { alignment, fixedPrefixSize } = activation.continuation.format;
      prefixBytes = Math.ceil(prefixBytes / alignment) * alignment;
      prefixBytes += fixedPrefixSize;
      if (!Number.isSafeInteger(prefixBytes)) {
        throw new RangeError(
          `${this.label}: borrowed replay prefix size exceeds JavaScript precision`,
        );
      }
    }
    return {
      prefixBytes,
      scratchBytes: this.registry.borrowedReplayScratchCapacity(),
    };
  }

  rootFor(activationId: number): number {
    return this.getActivation(activationId).root;
  }

  abort(): void {
    let failure: unknown;
    const borrowed = this.replayOwnership === "borrowed";
    // The co-resident module owns all linked frames/journal storage, so the
    // per-activation teardown is `moduleBackend.abort()` below. The host only
    // clears each activation's recorded roots and (for an owned transaction)
    // the process launch anchor.
    for (const activation of this.orderedActivations()) {
      activation.root = 0;
      activation.replayRoot = 0;
    }
    if (!borrowed) {
      try {
        this.publishProcessLaunchRoot(0, false);
      } catch (error) {
        failure ??= error;
      }
    }
    try {
      this.registry.abort();
    } catch (error) {
      failure ??= error;
    }
    if (this.moduleBackend) {
      try {
        this.moduleBackend.abort();
      } catch (error) {
        failure ??= error;
      }
    }
    try {
      this.releaseArena();
    } catch (error) {
      failure ??= error;
    }
    this.replayOwnership = null;
    this.phase = "idle";
    if (failure !== undefined) throw failure;
  }

  clear(): void {
    this.abort();
    this.resumeTable.clear();
    this.activations.clear();
    this.prepared.clear();
    this.registry.clear();
  }

  // -- Module-backed branches (Phase 6 D5 step 4b/5) ---------------------
  //
  // These mirror the JS capture/seal/replay/finish structure but delegate the
  // journal, frame storage, and resume-slot numbering to the co-resident
  // fork-module. They run only for a QUALIFYING single-activation fork; the JS
  // journal `this.events` stays idle (the module owns it) while the JS resume
  // TABLE still backs the guest's `__wpk_fork_resume_table` funcref import.

  private beginModuleCapture(arena: ForkModuleStateArena): void {
    const backend = this.moduleBackend!;
    this.arena = arena;
    this.replayOwnership = "owned";
    try {
      this.publishProcessLaunchRoot(0);
      this.registry.beginCapture(arena);
      this.phase = "capture";
      // Phase 6 D7a.1a: a dlopen fork has N activations. Activation 0 opens the
      // module capture (`beginUnwind`); each side activation is added to the SAME
      // capture with its own prefix (`addActivationUnwind`). Every activation's
      // root is written into ITS module-state prefix and its guest instance is
      // put into UNWINDING, exactly mirroring the JS path. Each activation's
      // linked frame chunks are channel-mmap'd on demand by the module (Option
      // B: dynamic, kernel-tracked `find_gap` placement), so a deep continuation
      // grows without a fork-depth cap and a genuine exhaustion is a truthful
      // `-ENOMEM`.
      for (const activation of this.orderedActivations()) {
        const root =
          activation.activationId === 0
            ? backend.beginUnwind()
            : backend.addActivationUnwind(
                activation.activationId,
                activation.continuation.format.fixedPrefixSize,
              );
        activation.root = root;
        activation.replayRoot = root;
        writeForkModuleStateRoot(
          this.memory,
          root,
          activation.continuation.format.ptrWidth,
          arena.rootAddress(),
        );
        invokeForkContinuationBegin(
          requireExportFunction(activation, "wpk_fork_unwind_begin"),
          root,
          activation.continuation.format.ptrWidth,
          `${this.label}: activation ${activation.activationId} unwind (module)`,
        );
        this.requireActivationState(activation, WPK_FORK_UNWINDING, "unwind");
      }
    } catch (error) {
      this.cancelCapture();
      throw error;
    }
  }

  private sealModuleCapture(): void {
    const backend = this.moduleBackend!;
    try {
      for (const activation of this.orderedActivations()) {
        requireExportFunction(activation, "wpk_fork_unwind_end")();
        this.requireActivationState(activation, WPK_FORK_NORMAL, "end unwind");
      }
      // The module serializes its own journal (every activation's events, tagged)
      // into a chunk it channel-mmaps itself (Option B), inherited verbatim by
      // the child copy. No JS-wire REPLAY-EVENT records are written — the module
      // owns the journal, so `this.events` is idle and there is no double-journal.
      // The image no longer sits at a host-computed arena offset, so record its
      // (ptr, len) in a `JournalImage` KFMS record for the child to find.
      let journalImage;
      try {
        journalImage = backend.finishUnwindAndSerialize();
      } catch (error) {
        if (error instanceof ContinuationAllocationError) {
          // SEAL-TIME TRUTHFUL FAILURE (Phase 2 carry / Phase 4): `fm_finish_unwind`
          // already sealed every activation's frame writer + the process journal
          // and the guest is back at NORMAL, but the module could not channel-mmap
          // the child-inheritable journal-image chunk. Complete the seal to
          // `sealed-parent` WITHOUT an image or manifest — no child will inherit
          // them — so the completion handler can route this fork through the SAME
          // truthful abort-replay path a mid-unwind reserve failure uses (parent
          // preserved, `fork()` returns `-errno`, no child launched). This mirrors
          // `beginModuleCaptureAbort`'s seal exactly. Do NOT tear the capture down;
          // rethrow so the caller drives `beginAbortReplay`.
          this.registry.sealCapture();
          this.publishProcessLaunchRoot(this.getActivation(0).root);
          this.phase = "sealed-parent";
        }
        throw error;
      }
      this.registry.currentArena().appendJournalImage({
        ptr: BigInt(journalImage.ptr),
        len: BigInt(journalImage.len),
      });
      // Phase 6 D7a.1a: a multi-activation (dlopen) fork DOES write the
      // activation-continuation manifest so the child can recover EACH side
      // activation's inherited continuation anchor (activation 0's comes from the
      // launch anchor, but sides have no other authority). The child decodes this
      // record directly (`activationRootsFromChildArena`) — NOT through
      // `activationContinuationsForChild`, which cross-checks the JS replay-event
      // wire the module path deliberately omits. The KFLA dlopen archive stays
      // the activation-order authority (the child's archived-vs-planner order
      // assertion), and the module's own `fm_add_activation_child_replay` rebuilds
      // and re-validates each activation's journal slice. A single-activation
      // fork writes no manifest (the child reads the launch anchor), so it stays
      // byte-identical.
      const activations = this.orderedActivations();
      if (activations.length > 1) {
        const continuations = activations.map(({ activationId, root }) => ({
          activationId,
          root: BigInt(root),
        }));
        this.registry.currentArena().appendActivationContinuations(continuations);
      }
      this.registry.sealCapture();
      this.publishProcessLaunchRoot(this.getActivation(0).root);
      this.phase = "sealed-parent";
    } catch (error) {
      // The seal-time OOM route (above) intentionally completes the seal to
      // `sealed-parent` before rethrowing so the caller can drive truthful
      // abort-replay; do NOT tear that capture down. Every other seal failure
      // leaves the phase pre-seal and must abort.
      if (this.phase !== "sealed-parent") this.abort();
      throw error;
    }
  }

  private beginModuleParentReplay(): void {
    const backend = this.moduleBackend!;
    this.registry.beginParentReplay();
    this.phase = "parent-replay";
    try {
      this.registry.restoreModuleState();
      // One `beginParentReplay` registers every activation's driver + resume
      // slots; then each activation's guest instance begins its rewind.
      backend.beginParentReplay();
      for (const activation of this.orderedActivations()) {
        invokeForkContinuationBegin(
          requireExportFunction(activation, "wpk_fork_rewind_begin"),
          activation.replayRoot,
          activation.continuation.format.ptrWidth,
          `${this.label}: activation ${activation.activationId} replay (module)`,
        );
        this.requireActivationState(activation, WPK_FORK_REWINDING, "begin replay");
      }
    } catch (error) {
      this.abort();
      throw error;
    }
  }

  /**
   * Module abort-replay begin (mirror of `beginModuleParentReplay`,
   * abort-tagged). Abort replays the parent's already-committed frames from
   * `activation.root` (not `replayRoot`, which only exists for a fresh
   * child), matching the JS `beginAbortReplay` above.
   */
  private beginModuleAbortReplay(): void {
    const backend = this.moduleBackend!;
    this.registry.beginParentReplay();
    this.phase = "abort-replay";
    try {
      this.registry.restoreModuleState();
      backend.beginAbort();
      for (const activation of this.orderedActivations()) {
        invokeForkContinuationBegin(
          requireExportFunction(activation, "wpk_fork_abort_begin"),
          activation.root,
          activation.continuation.format.ptrWidth,
          `${this.label}: activation ${activation.activationId} abort replay (module)`,
        );
        this.requireActivationState(
          activation,
          WPK_FORK_ABORT_UNWINDING,
          "begin abort replay",
        );
      }
    } catch (error) {
      this.abort();
      throw error;
    }
  }

  private attachModuleChild(
    arena: ForkModuleStateArena,
    adoptPreinstantiatedReferences?: () => void,
    decodedReferences?: DecodedSegmentedForkReferenceTransaction,
  ): void {
    const backend = this.moduleBackend!;
    this.arena = arena;
    this.replayOwnership = "owned";
    try {
      // When the co-resident module owns reference reconstruction, the registry
      // constructs the module-backed reconstruction FLOOR (no JS engine) and
      // sizes the shared transit from the module's resident decoded-graph node
      // count. A module-backed FRAME fork whose references stayed on the JS path
      // (`moduleReferenceReplay` false) keeps the JS reconstruction engine.
      this.registry.attachChild(
        arena,
        decodedReferences,
        this.moduleReferenceReplay ? () => backend.decodedNodeCount() : undefined,
      );
      adoptPreinstantiatedReferences?.();
      // Activation 0's continuation root is the inherited launch anchor. Side
      // activations (a dlopen fork) recover their inherited anchors from the
      // activation-continuation manifest the parent wrote at seal.
      const act0Root = this.readProcessLaunchRoot();
      this.phase = "child-replay";
      // Phase 6 D6.1/D7a.1b: seed the module's reference graph from the inherited
      // KFMS arena BEFORE restoring module state, because `restoreModuleState`
      // drives the guest's `wpk_fork_module_state_restore`, which reconstructs
      // GLOBAL/TABLE funcref (and externref) state through the flipped
      // `__wpk_fork_ref_decode_funcref` import — the module cannot resolve a
      // recipe until its reference state exists, or it traps. (A single-activation
      // program whose only references are frame LOCALS reconstructs them during
      // the later rewind, so it never exercised this order; a dlopen fork whose
      // side module bakes function pointers into its table does.) This one drive
      // covers the WHOLE arena: every activation's KMFS records merge into one
      // `SegmentedReferenceTransaction`, and the merged, activation-namespaced
      // funcref catalog resolves each funcref against its own activation — so it is
      // multi-activation (D7a.1b), whereas D7a.1a kept multi-activation references
      // on the JS path. `enableModuleReferenceReplay` is the single host gate,
      // set once the whole graph is admitted; externref resolution (PHASE A/B)
      // must also precede restore so the still-JS externref decode reads the
      // values the module rooted.
      // Reconstruction-orchestration ENTRY: seed the module's reference graph
      // AND build the whole topological drive plan in ONE module call
      // (`restoreFromArena` = the collapsed `fm_begin_reference_replay` +
      // `fm_build_gc_plan`). This moves the reference SEEDING + drive-order
      // CONSTRUCTION into the module; the host then issues a single
      // `driveRestoredPlan` inside `restoreModuleState`, rather than seeding here
      // and rebuilding the plan inside the drive closure.
      let restoredPlan: number | undefined;
      if (this.moduleReferenceReplay) {
        // Child-install ENTRY: `attachChild` seeds the reference graph, builds the
        // topological reconstruction plan, AND appends the two-phase guest
        // restore/finish install steps — one module call for the whole install.
        restoredPlan = backend.attachChild(arena.rootAddress());
      }
      // P2 (Path B): when the module reference replay is active, the module's
      // reference graph is seeded and its ATTACH drive plan built (`attachChild`
      // above) and every participating activation's KFGC codec + the
      // host-exception owner were seeded at worker init, so hand the WHOLE typed
      // reconstruction AND the guest restore/finish install to the co-resident
      // module. `restoreModuleState` invokes this delegate as the SOLE
      // reconstructor: the module executes the entire pre-built `drive_plan` walk
      // (static-root publish, EVERY externref transit publish, then the typed
      // allocate/fill/exn order) and then the `DRIVE_OP_RESTORE` /
      // `DRIVE_OP_FINISH_RESTORE` install steps, so no JS reconstruction OR JS
      // restore/finish loop runs. A graph with no typed replay owner
      // (funcref/externref-only frame locals) reconstructs through the flipped
      // module decode imports and drives only the install steps. Flag-off children
      // pass no delegate and keep the byte-identical JS drive + JS restore loop.
      const typedDrive = this.moduleReferenceReplay
        ? (): void => {
            backend.driveRestoredPlan(restoredPlan!);
          }
        : undefined;
      this.registry.restoreModuleState(typedDrive, this.moduleReferenceReplay);

      const activations = this.orderedActivations();
      const roots = new Map<number, number>([[0, act0Root]]);
      if (activations.length > 1) {
        for (const continuation of this.activationRootsFromChildArena()) {
          const root = Number(continuation.root);
          if (!Number.isSafeInteger(root) || root <= 0) {
            throw new Error(
              `${this.label}: module child activation ${continuation.activationId} `
                + `manifest root ${continuation.root} is invalid`,
            );
          }
          if (continuation.activationId === 0) {
            if (root !== act0Root) {
              throw new Error(
                `${this.label}: module child activation 0 manifest root ${root} `
                  + `disagrees with launch anchor ${act0Root}`,
              );
            }
            continue;
          }
          roots.set(continuation.activationId, root);
        }
      }

      // Seed activation 0's replay from the copied KFRE journal image, then add
      // each side activation at its inherited continuation anchor. All seeding
      // happens before any guest rewind drives a frame. Option B: the image was
      // channel-mmap'd, so its location comes from the inherited `JournalImage`
      // KFMS record, not a host-computed arena offset.
      const journalImage = journalImageForChild(
        this.registry.currentArena().recordViews(),
        this.getActivation(0).continuation.format.ptrWidth,
      );
      const act0 = this.getActivation(0);
      act0.root = act0Root;
      act0.replayRoot = act0Root;
      backend.beginChildReplay(
        act0Root,
        Number(journalImage.ptr),
        Number(journalImage.len),
      );
      for (const activation of activations) {
        if (activation.activationId === 0) continue;
        const root = roots.get(activation.activationId);
        if (root === undefined) {
          throw new Error(
            `${this.label}: module child activation ${activation.activationId} `
              + "has no inherited continuation root",
          );
        }
        activation.root = root;
        activation.replayRoot = root;
        backend.addActivationChildReplay(
          activation.activationId,
          root,
          activation.continuation.format.fixedPrefixSize,
        );
      }

      for (const activation of activations) {
        invokeForkContinuationBegin(
          requireExportFunction(activation, "wpk_fork_rewind_begin"),
          activation.replayRoot,
          activation.continuation.format.ptrWidth,
          `${this.label}: activation ${activation.activationId} child replay (module)`,
        );
        this.requireActivationState(activation, WPK_FORK_REWINDING, "begin replay");
      }
    } catch (error) {
      this.abort();
      throw error;
    }
  }

  /**
   * Decode the activation-continuation manifest a module-backed multi-activation
   * parent wrote at seal, read from the child's inherited KFMS arena. This
   * deliberately decodes the single `ActivationContinuations` record directly
   * rather than going through `activationContinuationsForChild`, whose
   * cross-check against the JS replay-event wire the module path omits (the
   * module owns the journal). The KFLA dlopen archive remains the activation-set
   * / order authority; the module re-validates each activation's journal slice.
   */
  /**
   * The module-backed counterpart of `attachBorrowedChild` (Phase 6 item 4).
   *
   * A vfork BORROWED child shares the PARKED parent's memory, so unlike
   * `attachModuleChild` (which reads a private COPY) it drives a READ-ONLY replay
   * over the parent's live continuation and writes the guest's mutable module
   * prefix into a CHILD-PRIVATE region from `reservePrefix`. The module owns no
   * chunks, so `finishReplay`/`abort` release nothing and the parked parent's
   * storage is never touched or unmapped. References are reconstructed through the
   * module (not JS), exactly as the COW module path does.
   *
   * This slice supports a SINGLE activation (the common vfork case). A
   * multi-activation borrowed child (dlopen-vfork "mode-1") is admitted only when
   * the worker keeps it on the JS borrowed path; if one reaches here it fails
   * loudly rather than silently mis-driving the parent's storage.
   */
  private attachBorrowedModuleChild(
    arena: ForkModuleStateArena,
    reservePrefix: ForkBorrowedReplayPrefixAllocator,
    adoptPreinstantiatedReferences?: () => void,
    decodedReferences?: DecodedSegmentedForkReferenceTransaction,
  ): void {
    const backend = this.moduleBackend!;
    this.requirePhase("idle", "attach borrowed module child process replay");
    if (this.prepared.size !== 0) {
      throw new Error(
        `${this.label}: borrowed child has ${this.prepared.size} incomplete activation(s)`,
      );
    }
    if (arena.ownershipMode() !== "borrowed") {
      throw new Error(
        `${this.label}: borrowed child replay requires a borrowed module-state arena`,
      );
    }
    this.arena = arena;
    this.replayOwnership = "borrowed";
    try {
      // Same module-backed reconstruction floor as the COW module child (see
      // `attachModuleChild`): the module sizes the transit from its resident
      // decoded graph and drives the whole reconstruction. A JS-reference
      // borrowed child (`moduleReferenceReplay` false) keeps the JS engine.
      this.registry.attachChild(
        arena,
        decodedReferences,
        this.moduleReferenceReplay ? () => backend.decodedNodeCount() : undefined,
      );
      adoptPreinstantiatedReferences?.();
      // Activation 0's borrowed continuation anchor is the parent's launch root
      // (the borrowed override returns `forkBufAddr`). Unlike the JS borrowed
      // path, the module path does NOT cross-check against
      // `activationContinuationsForChild`: the module owns the journal and omits
      // the JS replay-event wire that helper reads, so it would find nothing (see
      // `sealModuleCapture`). This mirrors `attachModuleChild`, which likewise
      // trusts `readProcessLaunchRoot` for the single (activation 0) anchor.
      const parentLaunchRoot = this.readProcessLaunchRoot();
      if (!Number.isSafeInteger(parentLaunchRoot) || parentLaunchRoot <= 0) {
        throw new Error(
          `${this.label}: borrowed process launch root ${parentLaunchRoot} is invalid`,
        );
      }
      const records = arena.recordViews();
      this.phase = "child-replay";
      // Reference reconstruction runs through the module (never a JS fallback),
      // mirroring `attachModuleChild`: the child-install ENTRY seeds the reference
      // graph, builds the reconstruction plan, AND appends the two-phase guest
      // restore/finish install steps in ONE module call (`attachBorrowedChild`),
      // then the module executes the whole plan via `driveRestoredPlan`. The
      // install plan is identical to the COW path; only the child-private replay
      // prefix (reserved below) is borrowed-specific.
      let restoredPlan: number | undefined;
      if (this.moduleReferenceReplay) {
        restoredPlan = backend.attachBorrowedChild(arena.rootAddress());
      }
      const typedDrive = this.moduleReferenceReplay
        ? (): void => {
            backend.driveRestoredPlan(restoredPlan!);
          }
        : undefined;
      this.registry.restoreModuleState(typedDrive, this.moduleReferenceReplay);

      const activations = this.orderedActivations();
      const journalImage = journalImageForChild(
        records,
        this.getActivation(0).continuation.format.ptrWidth,
      );
      // Side activations' borrowed anchors come from the manifest the parent
      // wrote at seal (activation 0's is the launch root). A single-activation
      // fork writes no manifest and needs none.
      const roots = new Map<number, number>([[0, parentLaunchRoot]]);
      if (activations.length > 1) {
        for (const continuation of this.activationRootsFromChildArena()) {
          const root = Number(continuation.root);
          if (!Number.isSafeInteger(root) || root <= 0) {
            throw new Error(
              `${this.label}: borrowed module child activation `
                + `${continuation.activationId} manifest root ${continuation.root} is invalid`,
            );
          }
          if (continuation.activationId === 0) {
            if (root !== parentLaunchRoot) {
              throw new Error(
                `${this.label}: borrowed module child activation 0 manifest root `
                  + `${root} disagrees with launch anchor ${parentLaunchRoot}`,
              );
            }
            continue;
          }
          roots.set(continuation.activationId, root);
        }
      }
      // Reserve each activation's child-private mutable prefix. The module copies
      // the parent's fixed prefix into it, so the guest's per-activation rewind
      // writes its active-frame pointer there, never the parked parent's prefix.
      // Reserve over `orderedActivations()` (every registered activation, roots
      // not yet assigned at this point) — the same activation SET the parent
      // sized `borrowedReplayWorkspaceRequirements` over, so the consumed total
      // matches exactly (`assertAttachComplete`).
      const privatePrefixes = new Map<number, number>();
      for (const activation of activations) {
        const prefix = Number(
          reservePrefix({
            activationId: activation.activationId,
            byteLength: activation.continuation.format.fixedPrefixSize,
            alignment: activation.continuation.format.alignment,
          }),
        );
        if (!Number.isSafeInteger(prefix) || prefix <= 0) {
          throw new Error(
            `${this.label}: borrowed activation ${activation.activationId} received `
              + "an invalid private replay prefix",
          );
        }
        privatePrefixes.set(activation.activationId, prefix);
      }
      // Seed activation 0 from the inherited journal image, then add each side
      // activation against the SAME journal, each at its own borrowed anchor and
      // child-private prefix.
      const act0 = this.getActivation(0);
      act0.root = parentLaunchRoot;
      act0.replayRoot = privatePrefixes.get(0)!;
      backend.beginBorrowedChildReplay(
        parentLaunchRoot,
        Number(journalImage.ptr),
        Number(journalImage.len),
        act0.replayRoot,
      );
      for (const activation of activations) {
        if (activation.activationId === 0) continue;
        const root = roots.get(activation.activationId);
        if (root === undefined) {
          throw new Error(
            `${this.label}: borrowed module child activation `
              + `${activation.activationId} has no inherited continuation root`,
          );
        }
        activation.root = root;
        activation.replayRoot = privatePrefixes.get(activation.activationId)!;
        backend.addActivationBorrowedChildReplay(
          activation.activationId,
          root,
          activation.continuation.format.fixedPrefixSize,
          activation.replayRoot,
        );
      }
      // Begin each activation's rewind at its child-private prefix.
      for (const activation of activations) {
        invokeForkContinuationBegin(
          requireExportFunction(activation, "wpk_fork_rewind_begin"),
          activation.replayRoot,
          activation.continuation.format.ptrWidth,
          `${this.label}: activation ${activation.activationId} borrowed child replay (module)`,
        );
        this.requireActivationState(activation, WPK_FORK_REWINDING, "begin replay");
      }
    } catch (error) {
      this.abort();
      throw error;
    }
  }

  private activationRootsFromChildArena(): ReturnType<
    typeof decodeForkActivationContinuations
  > {
    const records = this.registry.currentArena().recordViews();
    const matches = records.filter(
      (record) => record.kind === ForkModuleStateRecordKind.ActivationContinuations,
    );
    if (matches.length !== 1) {
      throw new Error(
        `${this.label}: module child expected one activation-continuation record, `
          + `found ${matches.length}`,
      );
    }
    return decodeForkActivationContinuations(
      matches[0]!.payload,
      `${this.label}: module activation continuations`,
    );
  }

  private finishModuleTransaction(abortReplay: boolean): void {
    // vfork/borrowed abort stays unsupported on the module path too (mirrors
    // the JS-path guard in `finishTransaction`, which never reaches this
    // method's body because it dispatches here first).
    if (abortReplay && this.replayOwnership === "borrowed") {
      throw new Error(`${this.label}: borrowed child cannot own abort replay`);
    }
    let failure: unknown;
    const backend = this.moduleBackend!;
    const activations = this.orderedActivations();
    const endExport = abortReplay ? "wpk_fork_abort_end" : "wpk_fork_rewind_end";
    for (const activation of activations) {
      try {
        requireExportFunction(activation, endExport)();
        this.requireActivationState(activation, WPK_FORK_NORMAL, "finish replay");
      } catch (error) {
        failure ??= error;
      }
    }
    try {
      if (abortReplay) backend.finishAbort();
      else backend.finishReplay();
    } catch (error) {
      failure ??= error;
    }
    try {
      this.registry.finishReplay();
    } catch (error) {
      failure ??= error;
    }
    for (const activation of activations) {
      activation.root = 0;
      activation.replayRoot = 0;
    }
    try {
      // A BORROWED (vfork) module child must NEVER write the process launch-root
      // word: that word lives in the PARKED parent's memory (the borrowed child
      // shares it), so publishing 0 here would corrupt the parent's continuation
      // anchor. The JS borrowed path guards this the same way (`finishTransaction`
      // and `abort`); the module path must too.
      if (this.replayOwnership !== "borrowed") {
        this.publishProcessLaunchRoot(0);
      }
    } catch (error) {
      failure ??= error;
    }
    try {
      this.releaseArena();
    } catch (error) {
      failure ??= error;
    }
    this.replayOwnership = null;
    this.phase = "idle";
    this.#abortErrno = null;
    if (failure !== undefined) throw failure;
  }

  private finishTransaction(abortReplay: boolean): void {
    this.requireModuleBackend("finish process replay");
    this.finishModuleTransaction(abortReplay);
  }

  private cancelCapture(): void {
    // Module-backed teardown of a capture that failed before seal. The co-resident
    // module owns all frame/journal storage, so `moduleBackend.abort()` reclaims
    // it; the host drives each guest instance still in UNWINDING back to NORMAL,
    // clears the launch anchor, and releases the arena.
    let failure: unknown;
    for (const activation of this.orderedActivations()) {
      try {
        if (activationState(activation) === WPK_FORK_UNWINDING) {
          requireExportFunction(activation, "wpk_fork_unwind_end")();
        }
      } catch (error) {
        failure ??= error;
      }
      activation.root = 0;
      activation.replayRoot = 0;
    }
    try {
      this.publishProcessLaunchRoot(0);
    } catch (error) {
      failure ??= error;
    }
    try {
      this.registry.abort();
    } catch (error) {
      failure ??= error;
    }
    if (this.moduleBackend) {
      try {
        this.moduleBackend.abort();
      } catch (error) {
        failure ??= error;
      }
    }
    try {
      this.releaseArena();
    } catch (error) {
      failure ??= error;
    }
    this.replayOwnership = null;
    this.phase = "idle";
    if (failure !== undefined) throw failure;
  }

  private activeActivationIds(): Set<number> {
    // The co-resident module owns the journal, so the active set is every
    // activation whose continuation root was assigned (capture/seal writes
    // roots; replay reads them from the KFMS manifest).
    const ids = new Set<number>();
    for (const activation of this.activations.values()) {
      if (activation.root !== 0) {
        ids.add(activation.activationId);
      }
    }
    return ids;
  }

  private publishProcessLaunchRoot(
    root: number,
    required = true,
  ): void {
    const owner = this.activations.get(0);
    const publish = owner?.publishProcessLaunchRoot;
    const read = owner?.readProcessLaunchRoot;
    if (!owner || !publish || !read) {
      if (!required) return;
      throw new Error(
        `${this.label}: activation zero has no process launch anchor`,
      );
    }
    publish(root);
  }

  private readProcessLaunchRoot(): number {
    const owner = this.activations.get(0);
    const read = owner?.readProcessLaunchRoot;
    if (!owner || !read) {
      throw new Error(
        `${this.label}: activation zero has no process launch anchor`,
      );
    }
    const root = read();
    if (!Number.isSafeInteger(root) || root <= 0) {
      throw new Error(`${this.label}: copied process launch root is invalid`);
    }
    return root;
  }

  private releaseArena(): void {
    const arena = this.arena;
    if (!arena) return;
    // Clear ownership first so a failing deallocator cannot make stale KFMS
    // bytes look reusable by a later fork transaction.
    this.arena = null;
    if (arena.ownershipMode() === "borrowed") arena.detachBorrowed();
    else arena.release();
  }

  private activeActivations(): CompleteForkProcessActivation[] {
    const active = this.activeActivationIds();
    return this.orderedActivations().filter(({ activationId }) =>
      active.has(activationId)
    );
  }

  private getActivation(activationId: number): CompleteForkProcessActivation {
    assertActivationId(activationId);
    const activation = this.activations.get(activationId);
    if (!activation) {
      throw new Error(
        `${this.label}: fork activation ${activationId} is not registered`,
      );
    }
    return activation;
  }

  private orderedActivations(): CompleteForkProcessActivation[] {
    return [...this.activations.values()].sort(
      (left, right) => left.activationId - right.activationId,
    );
  }

  private requireActivationState(
    activation: CompleteForkProcessActivation,
    expected: number,
    operation: string,
  ): void {
    const actual = activationState(activation);
    if (actual !== expected) {
      throw new Error(
        `${this.label}: activation ${activation.activationId} ${operation} `
        + `ended in state ${actual}, expected ${expected}`,
      );
    }
  }

  private requireIdle(operation: string): void {
    this.requirePhase("idle", operation);
  }

  /**
   * Assert the co-resident fork-module backs this fork (Phase 4 point of no
   * return: the module is the ONLY capture/replay implementation — there is no
   * JS continuation fallback). A missing backend is a loud programming error,
   * never a silent JS route.
   */
  private requireModuleBackend(
    operation: string,
  ): ForkModuleContinuationBackend {
    if (!this.moduleBackend) {
      throw new Error(
        `${this.label}: cannot ${operation}; the co-resident fork-module ` +
          "backend is required (there is no JS continuation fallback)",
      );
    }
    return this.moduleBackend;
  }

  private requirePhase(
    expected: ProcessContinuationPhase,
    operation: string,
  ): void {
    if (this.phase !== expected) {
      throw new Error(
        `${this.label}: cannot ${operation} while process continuation is ${this.phase}; `
        + `expected ${expected}`,
      );
    }
  }
}
