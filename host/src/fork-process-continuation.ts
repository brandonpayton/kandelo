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
  type ForkModuleStateArena,
  replayEventsForChild,
  writeForkModuleStateRoot,
} from "./fork-module-state";
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

  constructor(
    private readonly memory: WebAssembly.Memory,
    private readonly registry: ForkActivationRegistry,
    private readonly label: string,
  ) {}

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
   * Retire this worker as owner of the process-owned sparse table state.
   *
   * Only a checkpoint needs this: its threads share one process image, so one
   * of them must write the shared tables and the rest must not.
   */
  releaseProcessTableStateOwnership(): void {
    this.requirePhase("idle", "release process table state ownership");
    this.registry.releaseProcessTableStateOwnership();
  }

  /**
   * Re-elect this worker as owner of the process-owned sparse table state.
   *
   * A checkpoint retires the coordinates for the length of one capture only. A
   * later fork on the same worker needs them back, because a fork child gets
   * its own process image and must carry the physical table state.
   */
  restoreProcessTableStateOwnership(): void {
    this.requirePhase("idle", "restore process table state ownership");
    this.registry.restoreProcessTableStateOwnership();
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
