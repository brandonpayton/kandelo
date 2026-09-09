import {
  ForkExternrefBroker,
  type ForkExternrefGeneration,
} from "./fork-reference-broker";
import {
  ForkModuleStateArena,
  ForkModuleStateRecordKind,
  readForkModuleStateRoot,
} from "./fork-module-state";
import {
  FORK_REFERENCE_TRANSACTION_OWNER_ID,
  scanSegmentedForkReferenceExternrefHandles,
} from "./fork-reference-wire";
import {
  unwrapForkWorkerExceptionCapability,
} from "./fork-worker-exception-capability";

export interface ForkExternrefForkGrant {
  readonly generation: ForkExternrefGeneration;
  readonly handleCount: number;
}

/**
 * Kernel-Worker owner for opaque host references across process lifetimes.
 *
 * Process and pthread Workers receive only `generation.id` plus Worker-local
 * handle tokens. Real JavaScript values stay in this owner and are reached by
 * host-import adapters through `registerForWire` / `authorizeForWire`.
 *
 * This is intentionally independent of activation-frame layout: fork leases
 * are acquired from the process-wide reference-recipe record already copied
 * through linear memory, so supporting an externref adds no bytes to each
 * activation frame.
 */
export class ForkExternrefProcessOwner {
  private readonly current = new Map<number, ForkExternrefGeneration>();

  constructor(
    private readonly broker = new ForkExternrefBroker(),
  ) {}

  /** Start a PID that does not already have a live Wasm image. */
  startGeneration(pid: number): ForkExternrefGeneration {
    if (this.current.has(pid)) {
      throw new Error(`externref process pid ${pid} already has a live generation`);
    }
    const generation = this.broker.createGeneration(pid);
    this.current.set(pid, generation);
    return generation;
  }

  /**
   * Replace one exact process image at exec's irreversible commit point.
   *
   * The broker retires the old token before returning the replacement, so an
   * async callback from the discarded Worker cannot authorize a post-exec
   * operation merely because the PID stayed the same.
   */
  replaceGeneration(
    expected: ForkExternrefGeneration,
  ): ForkExternrefGeneration {
    this.requireCurrent(expected);
    const replacement = this.broker.createGeneration(expected.pid);
    this.current.set(expected.pid, replacement);
    return replacement;
  }

  /**
   * Grant a fresh fork child the unique externref handles named by the exact
   * sealed continuation it will replay.
   */
  forkGenerationFromContinuation(
    parent: ForkExternrefGeneration,
    childPid: number,
    memory: WebAssembly.Memory,
    ptrWidth: 4 | 8,
    moduleBufferAddress: number,
    label = `fork child pid=${childPid}: externref owner`,
  ): ForkExternrefForkGrant {
    this.requireCurrent(parent);
    if (this.current.has(childPid)) {
      throw new Error(
        `externref fork child pid ${childPid} already has a live generation`,
      );
    }

    const root = readForkModuleStateRoot(
      memory,
      moduleBufferAddress,
      ptrWidth,
    );
    if (root === 0) {
      throw new Error(`${label}: copied continuation has no module-state arena`);
    }

    // Inspect only the KFRV payload. The scanner validates the sealed chunk
    // chain and every record envelope without copying unrelated table pages;
    // the fresh child performs the full semantic arena validation before
    // execution. Its allocation callbacks remain deliberately impossible:
    // the arena belongs to the blocked parent and cannot be mutated here.
    const arena = new ForkModuleStateArena(
      memory,
      ptrWidth,
      () => {
        throw new Error(`${label}: read-only arena attempted allocation`);
      },
      () => {
        throw new Error(`${label}: read-only arena attempted release`);
      },
      `${label}: copied module state`,
    );
    const records = arena.inspectSealedRecordViews(
      root,
      [
        ForkModuleStateRecordKind.ReferenceRecipeSegment,
        ForkModuleStateRecordKind.ReferenceRecipe,
      ],
    );
    const handles = scanSegmentedForkReferenceExternrefHandles(
      records,
      FORK_REFERENCE_TRANSACTION_OWNER_ID,
    );

    const child = this.broker.createGeneration(childPid);
    try {
      const lease = this.broker.acquireFork(parent, child, handles);
      this.current.set(childPid, child);
      return Object.freeze({
        generation: child,
        handleCount: lease.handleCount,
      });
    } catch (error) {
      // `acquireFork` is transactional, and retiring the provisional
      // generation also clears any lease bookkeeping if a future broker
      // implementation adds a fallible step after publication.
      this.broker.releaseGeneration(child);
      throw error;
    }
  }

  /**
   * Release an exact process image after its process and pthread Workers can no
   * longer execute. Returns false for already-retired generations.
   */
  releaseGeneration(generation: ForkExternrefGeneration): boolean {
    const current = this.current.get(generation.pid);
    if (current === generation) this.current.delete(generation.pid);
    return this.broker.releaseGeneration(generation);
  }

  generationId(generation: ForkExternrefGeneration): number {
    this.requireCurrent(generation);
    return generation.id;
  }

  /**
   * Owner-side endpoint for an externref-producing host import.
   *
   * The adapter executes in this Realm, registers the real value here, and
   * returns only the u32 handle to the process Worker.
   */
  registerForWire(
    pid: number,
    generationId: number,
    value: unknown,
  ): number {
    return this.broker.register(
      this.requireWireGeneration(pid, generationId),
      value,
    );
  }

  /** Resolve an externref-consuming host import under exact image authority. */
  authorizeForWire(
    pid: number,
    generationId: number,
    handle: number,
  ): unknown {
    return unwrapForkWorkerExceptionCapability(
      this.broker.authorize(
        this.requireWireGeneration(pid, generationId),
        handle,
      ),
    );
  }

  /** Permanently close a host resource and invalidate all fork aliases. */
  tombstoneForWire(
    pid: number,
    generationId: number,
    handle: number,
  ): void {
    this.broker.tombstone(
      this.requireWireGeneration(pid, generationId),
      handle,
    );
  }

  private requireCurrent(
    generation: ForkExternrefGeneration,
  ): ForkExternrefGeneration {
    if (this.current.get(generation.pid) !== generation) {
      throw new Error(
        `stale externref process generation ${generation.id} `
        + `for pid ${generation.pid}`,
      );
    }
    return generation;
  }

  private requireWireGeneration(
    pid: number,
    generationId: number,
  ): ForkExternrefGeneration {
    if (
      !Number.isInteger(generationId)
      || generationId <= 0
      || generationId > 0xffff_ffff
    ) {
      throw new RangeError(
        `invalid externref process generation id ${generationId}`,
      );
    }
    const generation = this.current.get(pid);
    if (!generation || generation.id !== generationId) {
      throw new Error(
        `stale externref process generation ${generationId} for pid ${pid}`,
      );
    }
    return generation;
  }
}
