import {
  WPK_FORK_FRAME_IMPORT_PEEK,
  WPK_FORK_RESUME_IMPORT_PEEK,
  WPK_FORK_RESUME_IMPORT_TABLE,
} from "./generated/abi";
import {
  type ForkActivationRegistration,
  ForkActivationRegistry,
} from "./fork-activation-registry";
import {
  invokeForkContinuationBegin,
  LinkedForkContinuation,
} from "./fork-continuation";
import {
  activationContinuationsForChild,
  decodeForkActivationContinuations,
  type ForkModuleStateArena,
  ForkModuleStateRecordKind,
  journalImageForChild,
  replayEventsForChild,
  writeForkModuleStateRoot,
} from "./fork-module-state";
import type { ForkModuleContinuationBackend } from "./fork-module-backend";
import {
  type ForkReplayEvent,
  ForkReplayEventJournal,
  type ForkResumeTarget,
  ForkResumeTable,
} from "./fork-replay-events";
import {
  checkedWasmGuestPointerOffset,
  type WasmGuestPointer,
} from "./wasm-guest-pointer";
import type {
  DecodedSegmentedForkReferenceTransaction,
} from "./fork-reference-segments";

const WPK_FORK_NORMAL = 0;
const WPK_FORK_UNWINDING = 1;
const WPK_FORK_REWINDING = 2;
const WPK_FORK_ABORT_UNWINDING = 3;
// These names are already part of the Rust ABI table; generated named TS
// exports land with the ABI generator update that also publishes the fixed
// resume-boundary export names.
const WPK_FORK_FRAME_IMPORT_RESERVE = "__wpk_fork_frame_reserve";
const WPK_FORK_FRAME_IMPORT_COMMIT = "__wpk_fork_frame_commit";
const WPK_FORK_FRAME_IMPORT_NEXT = "__wpk_fork_frame_next";

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
  readonly continuation: LinkedForkContinuation;
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
  private readonly events = new ForkReplayEventJournal();
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
   * Imports bound to one activation but coordinated by the process journal.
   */
  continuationImports(
    activationId: number,
    onReservationAbort?: (errno: number) => void,
  ): Record<string, WebAssembly.ImportValue> {
    assertActivationId(activationId);
    const binding = this.prepared.get(activationId)
      ?? this.activations.get(activationId);
    if (!binding) {
      throw new Error(
        `${this.label}: fork activation ${activationId} has no continuation binding`,
      );
    }
    const continuation = binding.continuation;
    return {
      [WPK_FORK_FRAME_IMPORT_RESERVE]: (size: number | bigint) => {
        const payload = continuation.reserveFrame(size);
        if ((payload === 0 || payload === 0n) && onReservationAbort) {
          onReservationAbort(continuation.abortErrno());
        }
        return payload;
      },
      [WPK_FORK_FRAME_IMPORT_COMMIT]: (payload: WasmGuestPointer): void => {
        continuation.commitFrame(payload);
        const functionOrdinal = this.readFunctionOrdinal(
          payload,
          continuation,
          "committed",
        );
        this.events.recordCommit(activationId, functionOrdinal);
      },
      [WPK_FORK_FRAME_IMPORT_PEEK]: (size: number | bigint) => {
        const event = this.requireSelectedEvent(activationId, "peek");
        const payload = continuation.peekFrame(size);
        const functionOrdinal = this.readFunctionOrdinal(
          payload,
          continuation,
          "peeked",
        );
        if (functionOrdinal !== event.functionOrdinal) {
          throw new Error(
            `${this.label}: replay selected ${activationId}:${event.functionOrdinal}, `
            + `but the frame belongs to ${activationId}:${functionOrdinal}`,
          );
        }
        return payload;
      },
      [WPK_FORK_FRAME_IMPORT_NEXT]: (size: number | bigint) => {
        const event = this.requireSelectedEvent(activationId, "consume");
        // WHY: validate identity through the non-consuming path first. A bad
        // activation/function coordinate must not advance the linked cursor
        // and turn a deterministic launch failure into later child corruption.
        const peeked = continuation.peekFrame(size);
        const functionOrdinal = this.readFunctionOrdinal(
          peeked,
          continuation,
          "consumed",
        );
        if (functionOrdinal !== event.functionOrdinal) {
          throw new Error(
            `${this.label}: replay selected ${activationId}:${event.functionOrdinal}, `
            + `but the frame belongs to ${activationId}:${functionOrdinal}`,
          );
        }
        const payload = continuation.nextFrame(size);
        this.events.consume(activationId, functionOrdinal);
        return payload;
      },
      [WPK_FORK_RESUME_IMPORT_PEEK]: (_typeDiagnostic: number): number =>
        this.resumeTable.slotFor(this.events.peek()),
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
    if (this.moduleBackend) {
      this.beginModuleCapture(arena);
      return;
    }
    this.events.beginCapture();
    this.arena = arena;
    this.replayOwnership = "owned";
    try {
      this.publishProcessLaunchRoot(0);
      this.registry.beginCapture(arena);
      this.phase = "capture";
      for (const activation of this.orderedActivations()) {
        const root = Number(activation.continuation.beginUnwind());
        activation.root = root;
        activation.replayRoot = root;
        // WHY: the main Wasm activation need not be on a side-module fork
        // stack. Every activation prefix therefore carries the process arena
        // root, allowing the deterministic launch root chosen after unwind
        // to come from any active module without an archive-private side slot.
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
          `${this.label}: activation ${activation.activationId} unwind`,
        );
        this.requireActivationState(activation, WPK_FORK_UNWINDING, "unwind");
      }
    } catch (error) {
      this.cancelCapture();
      throw error;
    }
  }

  /**
   * Close unwind, discard activations that were not on the captured stack,
   * and seal references, module state, and global frame ordering together.
   */
  sealCapture(): void {
    this.requirePhase("capture", "seal process continuation capture");
    if (this.moduleBackend) {
      this.sealModuleCapture();
      return;
    }
    this.events.sealCapture();
    const active = this.events.capturedActivationIds();
    try {
      for (const activation of this.orderedActivations()) {
        requireExportFunction(activation, "wpk_fork_unwind_end")();
        this.requireActivationState(activation, WPK_FORK_NORMAL, "end unwind");
        if (active.has(activation.activationId)) {
          activation.continuation.finishUnwind();
        } else {
          activation.continuation.cancelUnwindAndRelease();
          activation.root = 0;
          activation.replayRoot = 0;
        }
      }
      if (active.size === 0) {
        throw new Error(`${this.label}: captured fork stack has no continuation frames`);
      }
      const continuations = this.orderedActivations()
        .filter(({ activationId }) => active.has(activationId))
        .map(({ activationId, root }) => ({
          activationId,
          root: BigInt(root),
      }));
      const arena = this.registry.currentArena();
      arena.appendReplayEvents(this.events);
      arena.appendActivationContinuations(continuations);
      this.registry.sealCapture();
      this.publishProcessLaunchRoot(
        this.selectProcessLaunchRoot(continuations),
      );
      this.phase = "sealed-parent";
    } catch (error) {
      this.abort();
      throw error;
    }
  }

  beginParentReplay(): void {
    this.requirePhase("sealed-parent", "begin parent process replay");
    if (this.moduleBackend) {
      this.beginModuleParentReplay();
      return;
    }
    this.registry.beginParentReplay();
    this.events.beginParentReplay();
    this.phase = "parent-replay";
    try {
      this.registry.restoreModuleState();
      this.beginActivationReplay(WPK_FORK_REWINDING);
    } catch (error) {
      this.abort();
      throw error;
    }
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
    if (this.moduleBackend) {
      this.attachModuleChild(arena, adoptPreinstantiatedReferences, decodedReferences);
      return;
    }
    this.arena = arena;
    this.replayOwnership = "owned";
    try {
      this.registry.attachChild(arena, decodedReferences);
      // Imported immutable references may have forced a strict prefix of the
      // recipe graph to be materialized while provider activations were still
      // being instantiated. Adopt those exact identities after the full
      // transaction validates the copied wire, but before module restore can
      // request them again.
      adoptPreinstantiatedReferences?.();
      const records = arena.recordViews();
      this.events.attachChild(replayEventsForChild(records));
      const continuations = activationContinuationsForChild(
        records,
        arena.ptrWidth,
      );
      const copiedLaunchRoot = this.readProcessLaunchRoot();
      const expectedLaunchRoot = this.selectProcessLaunchRoot(continuations);
      if (copiedLaunchRoot !== expectedLaunchRoot) {
        throw new Error(
          `${this.label}: copied process launch root ${copiedLaunchRoot} `
          + `does not match manifest root ${expectedLaunchRoot}`,
        );
      }
      this.phase = "child-replay";
      this.registry.restoreModuleState();
      const roots = new Map(
        continuations.map(({ activationId, root }) => [
          activationId,
          Number(root),
        ]),
      );
      for (const activation of this.orderedActivations()) {
        const root = roots.get(activation.activationId) ?? 0;
        if (root === 0) {
          activation.root = 0;
          activation.replayRoot = 0;
          continue;
        }
        if (!Number.isSafeInteger(root) || root <= 0) {
          throw new Error(
            `${this.label}: active child activation ${activation.activationId} `
            + "has no copied continuation root",
          );
        }
        activation.root = root;
        activation.replayRoot = root;
        activation.continuation.attachForReplay(
          activation.continuation.format.ptrWidth === 8 ? BigInt(root) : root,
        );
      }
      this.beginActivationReplay(WPK_FORK_REWINDING, false);
    } catch (error) {
      this.abort();
      throw error;
    }
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
    if (this.moduleBackend) {
      // Phase 6 item 4: route the vfork BORROWED replay through the co-resident
      // module (frames + references), exactly as `attachModuleChild` does for a
      // COW child — but reading the parent's borrowed continuation read-only and
      // writing the guest's mutable prefix into a child-private region.
      this.attachBorrowedModuleChild(
        arena,
        reservePrefix,
        adoptPreinstantiatedReferences,
        decodedReferences,
      );
      return;
    }
    this.requirePhase("idle", "attach borrowed child process replay");
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
      this.registry.attachChild(arena, decodedReferences);
      adoptPreinstantiatedReferences?.();
      const records = arena.recordViews();
      this.events.attachChild(replayEventsForChild(records));
      const continuations = activationContinuationsForChild(
        records,
        arena.ptrWidth,
      );
      const parentLaunchRoot = this.readProcessLaunchRoot();
      const expectedLaunchRoot = this.selectProcessLaunchRoot(continuations);
      if (parentLaunchRoot !== expectedLaunchRoot) {
        throw new Error(
          `${this.label}: borrowed process launch root ${parentLaunchRoot} `
          + `does not match manifest root ${expectedLaunchRoot}`,
        );
      }
      this.phase = "child-replay";
      this.registry.restoreModuleState();
      const roots = new Map(
        continuations.map(({ activationId, root }) => [
          activationId,
          Number(root),
        ]),
      );
      for (const activation of this.orderedActivations()) {
        const root = roots.get(activation.activationId) ?? 0;
        if (root === 0) {
          activation.root = 0;
          activation.replayRoot = 0;
          continue;
        }
        if (!Number.isSafeInteger(root) || root <= 0) {
          throw new Error(
            `${this.label}: active borrowed activation ${activation.activationId} `
            + "has no parent continuation root",
          );
        }
        const privatePrefix = reservePrefix({
          activationId: activation.activationId,
          byteLength: activation.continuation.format.fixedPrefixSize,
          alignment: activation.continuation.format.alignment,
        });
        const replayRoot = Number(
          activation.continuation.attachForBorrowedReplay(
            activation.continuation.format.ptrWidth === 8 ? BigInt(root) : root,
            privatePrefix,
          ),
        );
        if (!Number.isSafeInteger(replayRoot) || replayRoot <= 0) {
          throw new Error(
            `${this.label}: borrowed activation ${activation.activationId} `
            + "received an invalid private replay prefix",
          );
        }
        activation.root = root;
        activation.replayRoot = replayRoot;
      }
      this.beginActivationReplay(WPK_FORK_REWINDING, false);
    } catch (error) {
      this.abort();
      throw error;
    }
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
    if (this.moduleBackend) {
      this.beginModuleAbortReplay();
      return;
    }
    this.registry.beginParentReplay();
    this.events.beginParentReplay();
    this.phase = "abort-replay";
    try {
      this.registry.restoreModuleState();
      for (const activation of this.activeActivations()) {
        activation.continuation.beginAbortReplay(errno);
        invokeForkContinuationBegin(
          requireExportFunction(activation, "wpk_fork_abort_begin"),
          activation.root,
          activation.continuation.format.ptrWidth,
          `${this.label}: activation ${activation.activationId} abort replay`,
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

  /**
   * Turn a partially committed unwind into deterministic errno replay.
   *
   * A linked-continuation chunk allocation can fail from inside a generated
   * frame postamble. JavaScript cannot return an errno through that postamble,
   * so the null reservation asks the same activation stack to replay the
   * already committed inner frames and return the allocation error from the
   * original fork call. Every activation remains rooted until that replay
   * reaches the leaf: an activation with no committed frame can still be an
   * outer live caller whose runtime state must return to NORMAL.
   */
  beginCaptureAbort(errno: number): void {
    this.requirePhase("capture", "begin partial-capture abort replay");
    if (!Number.isInteger(errno) || errno <= 0) {
      throw new RangeError(`${this.label}: invalid fork abort errno ${errno}`);
    }
    this.#abortErrno = errno;
    try {
      this.events.sealCapture();
      this.registry.currentArena().appendReplayEvents(this.events);
      this.registry.sealCapture();
      this.registry.beginParentReplay();
      this.events.beginParentReplay();
      this.phase = "abort-replay";
      for (const activation of this.orderedActivations()) {
        // reserveFrame has already marked the failing continuation. Repeating
        // the same errno is intentionally idempotent; the other activation
        // owners need the identical replay cursor and failure result.
        activation.continuation.beginAbortReplay(errno);
        invokeForkContinuationBegin(
          requireExportFunction(activation, "wpk_fork_abort_begin"),
          activation.root,
          activation.continuation.format.ptrWidth,
          `${this.label}: activation ${activation.activationId} partial abort replay`,
        );
        this.requireActivationState(
          activation,
          WPK_FORK_ABORT_UNWINDING,
          "begin partial abort replay",
        );
      }
    } catch (error) {
      this.abort();
      throw error;
    }
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
    for (const activation of this.orderedActivations()) {
      if (!activation.continuation.hasActiveContinuation()) continue;
      try {
        if (borrowed) activation.continuation.cancelBorrowedReplay();
        else activation.continuation.cancelUnwindAndRelease();
      } catch (error) {
        failure ??= error;
      }
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
      this.events.abort();
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
      // capture with its own host frame arena + prefix (`addActivationUnwind`).
      // Every activation's root is written into ITS module-state prefix and its
      // guest instance is put into UNWINDING, exactly mirroring the JS path.
      // A single-activation fork (the common case, incl. any deep recursive
      // fork) hands activation 0 the whole arena minus the journal + module-state
      // reserves, so a deep linked continuation grows up to the bounded arena
      // instead of tripping the fixed multi-activation frame sub-cap. A
      // multi-activation (dlopen) fork keeps the per-activation slab so N
      // activations share the arena.
      const singleActivation = this.orderedActivations().length === 1;
      for (const activation of this.orderedActivations()) {
        const root =
          activation.activationId === 0
            ? backend.beginUnwind(
                singleActivation
                  ? backend.singleActivationFrameBudget()
                  : undefined,
              )
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
      const journalImage = backend.finishUnwindAndSerialize();
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
      this.abort();
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

  private beginActivationReplay(
    expectedState: typeof WPK_FORK_REWINDING,
    beginContinuation = true,
  ): void {
    for (const activation of this.activeActivations()) {
      if (beginContinuation) activation.continuation.beginReplay();
      invokeForkContinuationBegin(
        requireExportFunction(activation, "wpk_fork_rewind_begin"),
        activation.replayRoot,
        activation.continuation.format.ptrWidth,
        `${this.label}: activation ${activation.activationId} replay`,
      );
      this.requireActivationState(activation, expectedState, "begin replay");
    }
  }

  private finishTransaction(abortReplay: boolean): void {
    if (this.moduleBackend) {
      this.finishModuleTransaction(abortReplay);
      return;
    }
    let failure: unknown;
    const borrowed = this.replayOwnership === "borrowed";
    if (borrowed && abortReplay) {
      throw new Error(`${this.label}: borrowed child cannot own abort replay`);
    }
    for (const activation of this.activeActivations()) {
      try {
        requireExportFunction(
          activation,
          abortReplay ? "wpk_fork_abort_end" : "wpk_fork_rewind_end",
        )();
        this.requireActivationState(activation, WPK_FORK_NORMAL, "finish replay");
      } catch (error) {
        failure ??= error;
      }
    }
    try {
      this.events.finishReplay();
    } catch (error) {
      failure ??= error;
      // The child journal may retain zero-copy views into the arena. Drop its
      // cursor before the arena mappings are released even when replay ended
      // early, or a later diagnostic could read recycled process memory.
      this.events.abort();
    }
    try {
      this.registry.finishReplay();
    } catch (error) {
      failure ??= error;
    }
    for (const activation of this.activeActivations()) {
      try {
        if (abortReplay) activation.continuation.finishAbortReplayAndRelease();
        else if (borrowed) activation.continuation.finishBorrowedReplay();
        else activation.continuation.finishReplayAndRelease();
      } catch (error) {
        failure ??= error;
        if (borrowed && activation.continuation.hasActiveContinuation()) {
          try {
            activation.continuation.cancelBorrowedReplay();
          } catch (cleanupError) {
            failure ??= cleanupError;
          }
        }
      }
      activation.root = 0;
      activation.replayRoot = 0;
    }
    if (!borrowed) {
      try {
        this.publishProcessLaunchRoot(0);
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
    this.#abortErrno = null;
    if (failure !== undefined) throw failure;
  }

  private cancelCapture(): void {
    let failure: unknown;
    for (const activation of this.orderedActivations()) {
      if (!activation.continuation.hasActiveContinuation()) continue;
      try {
        if (activationState(activation) === WPK_FORK_UNWINDING) {
          requireExportFunction(activation, "wpk_fork_unwind_end")();
        }
      } catch (error) {
        failure ??= error;
      }
      try {
        activation.continuation.cancelUnwindAndRelease();
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
      this.events.abort();
    } catch (error) {
      failure ??= error;
    }
    try {
      this.registry.abort();
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
    if (failure !== undefined) throw failure;
  }

  private activeActivationIds(): Set<number> {
    const ids = new Set<number>();
    const phase = this.events.phaseName();
    if (phase === "capture" || phase === "sealed-parent") {
      return this.events.capturedActivationIds();
    }
    // During replay, selecting every remaining event would mutate the journal.
    // Activation roots came from the exact-set-validated KFMS manifest.
    for (const activation of this.activations.values()) {
      if (activation.root !== 0) {
        ids.add(activation.activationId);
      }
    }
    return ids;
  }

  private selectProcessLaunchRoot(
    continuations: readonly {
      activationId: number;
      root: bigint;
    }[],
  ): number {
    if (continuations.length === 0) {
      throw new Error(`${this.label}: process continuation manifest is empty`);
    }
    const selected = continuations.find(({ activationId }) => activationId === 0)
      ?? continuations[0]!;
    const root = Number(selected.root);
    if (!Number.isSafeInteger(root) || root <= 0) {
      throw new RangeError(
        `${this.label}: activation ${selected.activationId} launch root `
        + `${selected.root} is not a safe guest address`,
      );
    }
    return root;
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

  private requireSelectedEvent(
    activationId: number,
    operation: string,
  ): ForkReplayEvent {
    const event = this.events.peek();
    if (!event) {
      throw new Error(
        `${this.label}: activation ${activationId} cannot ${operation}; `
        + "the replay event stream is exhausted",
      );
    }
    if (event.activationId !== activationId) {
      throw new Error(
        `${this.label}: activation ${activationId} cannot ${operation} frame for `
        + `activation ${event.activationId}`,
      );
    }
    return event;
  }

  private readFunctionOrdinal(
    payload: WasmGuestPointer,
    continuation: LinkedForkContinuation,
    operation: string,
  ): number {
    const offset = checkedWasmGuestPointerOffset(
      payload,
      continuation.format.ptrWidth,
      `${this.label}: ${operation} frame`,
    );
    if (offset > this.memory.buffer.byteLength - 4) {
      throw new RangeError(
        `${this.label}: ${operation} frame header escapes process memory`,
      );
    }
    return new DataView(this.memory.buffer).getUint32(offset, true);
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
