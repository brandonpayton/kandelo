/**
 * Process-independent ownership for opaque `externref` values.
 *
 * WebAssembly treats an externref as an opaque identity. A fork child runs in
 * a fresh Worker, so copying a JavaScript object into that Worker is neither
 * generally possible nor identity preserving. The host instead keeps the real
 * value behind a stable handle and gives every Worker one canonical token for
 * that handle. Host-import adapters can route token-bearing calls back to the
 * owner without putting JavaScript heap objects in the Wasm continuation.
 *
 * This file deliberately owns only identity and lifetime. Dispatching a
 * particular host import remains the responsibility of that import's adapter;
 * the adapter resolves handles through the broker rather than receiving a
 * best-effort structured clone.
 */

const GENERATION_TOKEN = Symbol("kandelo.fork.externref-generation");
const HANDLE_TOKEN = Symbol("kandelo.fork.externref-handle");
const WORKER_GENERATION_TOKEN =
  Symbol("kandelo.fork.externref-worker-generation");
const MAX_WIRE_ID = 0xffff_ffff;

export interface ForkExternrefToken {
  readonly [HANDLE_TOKEN]: number;
  readonly [WORKER_GENERATION_TOKEN]: number;
}

/**
 * Exact lifetime of one process Wasm image.
 *
 * A PID survives exec, so it is not sufficient authority for a host-owned
 * externref. The broker issues a fresh token for every execution generation
 * and rejects a token as soon as that generation is replaced or released.
 */
export interface ForkExternrefGeneration {
  readonly id: number;
  readonly pid: number;
  readonly [GENERATION_TOKEN]: true;
}

export interface ForkExternrefLease {
  readonly generation: ForkExternrefGeneration;
  readonly handleCount: number;
  release(): void;
}

export interface ForkExternrefBrokerOptions {
  /** Test seam; production handles use the complete nonzero-u32 wire space. */
  readonly maxHandle?: number;
  /** Test seam; production generations use the complete nonzero-u32 space. */
  readonly maxGeneration?: number;
}

interface BrokerEntry {
  value: unknown;
  holders: Set<BrokerGenerationState>;
}

interface BrokerForkLeaseState {
  readonly generation: BrokerGenerationState;
  readonly handles: Set<number>;
  released: boolean;
}

interface BrokerGenerationState {
  readonly token: ForkExternrefGeneration;
  readonly directHandles: Set<number>;
  readonly forkHandleCounts: Map<number, number>;
  readonly handles: Set<number>;
  readonly forkLeases: Set<BrokerForkLeaseState>;
  status: "active" | "released" | "replaced";
}

function assertProcessId(pid: number): void {
  if (!Number.isInteger(pid) || pid <= 0 || pid > MAX_WIRE_ID) {
    throw new RangeError(`invalid externref holder pid ${pid}`);
  }
}

function assertHandle(handle: number): void {
  if (!Number.isInteger(handle) || handle <= 0 || handle > MAX_WIRE_ID) {
    throw new RangeError(`invalid externref handle ${handle}`);
  }
}

function assertWireLimit(value: number, name: string): void {
  if (!Number.isInteger(value) || value <= 0 || value > MAX_WIRE_ID) {
    throw new RangeError(`${name} must be a positive unsigned 32-bit integer`);
  }
}

class BrokerForkExternrefLease implements ForkExternrefLease {
  readonly handleCount: number;

  constructor(
    readonly generation: ForkExternrefGeneration,
    state: BrokerForkLeaseState,
    private readonly releaseState: () => void,
  ) {
    // Do not duplicate the potentially large handle set merely for
    // diagnostics; the broker-owned lease state is its sole lifetime owner.
    this.handleCount = state.handles.size;
  }

  release(): void {
    this.releaseState();
  }
}

/**
 * Kernel-side owner for real JavaScript values.
 *
 * Ownership is deliberately generation-scoped and set-valued. Ten globals or
 * graph edges that alias one externref require one strong owner entry, not ten
 * reference counts. Separate successful fork transactions retain independent
 * leases so rolling one transaction back cannot revoke another transaction or
 * a host import's direct registration.
 */
export class ForkExternrefBroker {
  private nextHandle = 1;
  private nextGeneration = 1;
  private readonly entries = new Map<number, BrokerEntry>();
  private readonly objectHandles = new WeakMap<object, number>();
  private readonly primitiveHandles = new Map<unknown, number>();
  private readonly numberHandles = new Map<bigint, number>();
  private readonly generations =
    new WeakMap<ForkExternrefGeneration, BrokerGenerationState>();
  private readonly currentGenerations = new Map<number, BrokerGenerationState>();
  private readonly maxHandle: number;
  private readonly maxGeneration: number;

  constructor(options: ForkExternrefBrokerOptions = {}) {
    this.maxHandle = options.maxHandle ?? MAX_WIRE_ID;
    this.maxGeneration = options.maxGeneration ?? MAX_WIRE_ID;
    assertWireLimit(this.maxHandle, "externref broker maxHandle");
    assertWireLimit(this.maxGeneration, "externref broker maxGeneration");
  }

  /**
   * Begin one exact process-image lifetime.
   *
   * Creating a replacement for the same PID retires the old generation before
   * the new token is returned. WHY: delayed worker teardown must never use an
   * old PID-only capability to resolve values for the post-exec image.
   */
  createGeneration(pid: number): ForkExternrefGeneration {
    assertProcessId(pid);
    if (this.nextGeneration > this.maxGeneration) {
      throw new RangeError("externref generation space exhausted");
    }
    const id = this.nextGeneration++;
    const token: ForkExternrefGeneration = Object.freeze({
      id,
      pid,
      [GENERATION_TOKEN]: true as const,
    });
    const state: BrokerGenerationState = {
      token,
      directHandles: new Set(),
      forkHandleCounts: new Map(),
      handles: new Set(),
      forkLeases: new Set(),
      status: "active",
    };

    const previous = this.currentGenerations.get(pid);
    if (previous) this.closeGeneration(previous, "replaced");
    this.generations.set(token, state);
    this.currentGenerations.set(pid, state);
    return token;
  }

  register(generation: ForkExternrefGeneration, value: unknown): number {
    const state = this.requireActiveGeneration(generation);
    const known = this.lookupValueHandle(value);
    if (known !== undefined) {
      const entry = this.requireEntry(known);
      this.acquireDirect(state, known, entry);
      return known;
    }

    if (this.nextHandle > this.maxHandle) {
      throw new RangeError("externref handle space exhausted");
    }
    // Reserve monotonically before publishing any map entry. Even a failed
    // publication leaves a gap rather than making a stale wire handle alias a
    // future value.
    const handle = this.nextHandle++;
    const entry: BrokerEntry = {
      value,
      holders: new Set(),
    };
    this.entries.set(handle, entry);
    try {
      this.rememberValueHandle(value, handle);
      state.directHandles.add(handle);
      state.handles.add(handle);
      entry.holders.add(state);
    } catch (error) {
      state.directHandles.delete(handle);
      state.handles.delete(handle);
      entry.holders.delete(state);
      this.forget(handle, value);
      throw error;
    }
    return handle;
  }

  /**
   * Grant a directly managed handle to a generation.
   *
   * Repeated acquisition is idempotent because aliases share the generation's
   * one direct lease.
   */
  acquire(generation: ForkExternrefGeneration, handle: number): void {
    const state = this.requireActiveGeneration(generation);
    assertHandle(handle);
    this.acquireDirect(state, handle, this.requireEntry(handle));
  }

  /**
   * Duplicate a parent's unique handle set for a fork child.
   *
   * WHY validation and mutation are separate passes: a corrupt recipe must not
   * leave the child holding the valid prefix of an otherwise rejected
   * snapshot. The mutation pass also has an explicit rollback so any future
   * bookkeeping that can fail preserves that all-or-nothing boundary.
   */
  acquireFork(
    parentGeneration: ForkExternrefGeneration,
    childGeneration: ForkExternrefGeneration,
    uniqueHandles: Iterable<number>,
  ): ForkExternrefLease {
    const parent = this.requireActiveGeneration(parentGeneration);
    const child = this.requireActiveGeneration(childGeneration);
    if (parent === child || parent.token.pid === child.token.pid) {
      throw new Error("externref fork requires distinct process generations");
    }

    const handles = new Set<number>();
    for (const handle of uniqueHandles) {
      assertHandle(handle);
      handles.add(handle);
    }

    const validated: Array<[number, BrokerEntry]> = [];
    for (const handle of handles) {
      const entry = this.requireEntry(handle);
      if (!parent.handles.has(handle) || !entry.holders.has(parent)) {
        throw new Error(
          `externref generation ${parent.token.id} for pid ${parent.token.pid} `
          + `does not own handle ${handle}`,
        );
      }
      if (child.handles.has(handle) !== entry.holders.has(child)) {
        throw new Error(
          `externref generation ${child.token.id} has inconsistent ownership `
          + `for handle ${handle}`,
        );
      }
      const childLeaseCount = child.forkHandleCounts.get(handle) ?? 0;
      if (childLeaseCount >= Number.MAX_SAFE_INTEGER) {
        throw new RangeError(
          `externref fork lease count overflow for handle ${handle}`,
        );
      }
      validated.push([handle, entry]);
    }

    const leaseState: BrokerForkLeaseState = {
      generation: child,
      handles: new Set(),
      released: false,
    };
    const applied: Array<[number, BrokerEntry, number, boolean]> = [];
    try {
      for (const [handle, entry] of validated) {
        const previousCount = child.forkHandleCounts.get(handle) ?? 0;
        const addedOwnership = !child.handles.has(handle);
        // Record the old state before the first mutation so every partial step
        // in this iteration is included in rollback.
        applied.push([handle, entry, previousCount, addedOwnership]);
        child.forkHandleCounts.set(handle, previousCount + 1);
        if (addedOwnership) {
          child.handles.add(handle);
          entry.holders.add(child);
        }
        leaseState.handles.add(handle);
      }
      child.forkLeases.add(leaseState);
    } catch (error) {
      for (let index = applied.length - 1; index >= 0; index--) {
        const [handle, entry, previousCount, addedOwnership] = applied[index]!;
        if (previousCount === 0) child.forkHandleCounts.delete(handle);
        else child.forkHandleCounts.set(handle, previousCount);
        if (addedOwnership) {
          child.handles.delete(handle);
          entry.holders.delete(child);
        }
      }
      throw error;
    }
    return new BrokerForkExternrefLease(
      child.token,
      leaseState,
      () => this.releaseForkLease(leaseState),
    );
  }

  /** Release one generation's direct (non-fork-transaction) lease. */
  release(generation: ForkExternrefGeneration, handle: number): void {
    const state = this.requireActiveGeneration(generation);
    assertHandle(handle);
    const entry = this.requireEntry(handle);
    if (!state.directHandles.has(handle)) {
      throw new Error(
        `externref generation ${state.token.id} for pid ${state.token.pid} `
        + `has no direct lease for handle ${handle}`,
      );
    }
    state.directHandles.delete(handle);
    if ((state.forkHandleCounts.get(handle) ?? 0) === 0) {
      this.removeGenerationHandle(state, handle, entry);
    }
  }

  /** Retire every handle and lease owned by one exact execution generation. */
  releaseGeneration(generation: ForkExternrefGeneration): boolean {
    const state = this.generationState(generation);
    if (state.status !== "active") return false;
    this.closeGeneration(state, "released");
    return true;
  }

  /**
   * Validate one generation-scoped capability and return its opaque value.
   *
   * Host adapters must call this at dispatch time; possession of a numeric
   * handle or a PID alone is not authority.
   */
  authorize(generation: ForkExternrefGeneration, handle: number): unknown {
    const state = this.requireActiveGeneration(generation);
    assertHandle(handle);
    const entry = this.requireEntry(handle);
    if (!state.handles.has(handle) || !entry.holders.has(state)) {
      throw new Error(
        `externref generation ${state.token.id} for pid ${state.token.pid} `
        + `is not authorized for handle ${handle}`,
      );
    }
    return entry.value;
  }

  /** Compatibility name for adapters that previously resolved PID ownership. */
  resolve(generation: ForkExternrefGeneration, handle: number): unknown {
    return this.authorize(generation, handle);
  }

  /**
   * Permanently retire a handle after an explicit host-resource close.
   *
   * Every generation loses authorization, and registering the same JS value
   * later receives a fresh monotonically larger handle. The monotonic allocator
   * itself is the tombstone set: any issued-but-absent number is retired.
   */
  tombstone(generation: ForkExternrefGeneration, handle: number): void {
    const owner = this.requireActiveGeneration(generation);
    assertHandle(handle);
    const entry = this.requireEntry(handle);
    if (!owner.handles.has(handle) || !entry.holders.has(owner)) {
      throw new Error(
        `externref generation ${owner.token.id} for pid ${owner.token.pid} `
        + `cannot tombstone unowned handle ${handle}`,
      );
    }

    for (const holder of [...entry.holders]) {
      holder.directHandles.delete(handle);
      holder.forkHandleCounts.delete(handle);
      holder.handles.delete(handle);
      for (const lease of holder.forkLeases) lease.handles.delete(handle);
    }
    entry.holders.clear();
    this.forget(handle, entry.value);
  }

  /** Set ownership is observable as either zero or one, never graph aliases. */
  holderCount(
    handle: number,
    generation: ForkExternrefGeneration,
  ): 0 | 1 {
    assertHandle(handle);
    const state = this.generationState(generation);
    if (state.status !== "active") return 0;
    const entry = this.entries.get(handle);
    return state.handles.has(handle) && entry?.holders.has(state) ? 1 : 0;
  }

  private releaseForkLease(lease: BrokerForkLeaseState): void {
    if (lease.released) {
      throw new Error("externref fork lease is already released");
    }
    const generation = lease.generation;
    this.requireActiveGeneration(generation.token);

    // Verify the whole lease before removing anything. Lifecycle corruption
    // must not release a valid prefix and retain the rest.
    const entries = new Map<number, BrokerEntry>();
    for (const handle of lease.handles) {
      const entry = this.requireEntry(handle);
      const count = generation.forkHandleCounts.get(handle) ?? 0;
      if (
        count <= 0
        || !generation.handles.has(handle)
        || !entry.holders.has(generation)
      ) {
        throw new Error(
          `externref generation ${generation.token.id} no longer owns `
          + `fork lease handle ${handle}`,
        );
      }
      entries.set(handle, entry);
    }

    for (const handle of lease.handles) {
      const entry = entries.get(handle)!;
      const count = generation.forkHandleCounts.get(handle)!;
      if (count === 1) {
        generation.forkHandleCounts.delete(handle);
        if (!generation.directHandles.has(handle)) {
          this.removeGenerationHandle(generation, handle, entry);
        }
      } else {
        generation.forkHandleCounts.set(handle, count - 1);
      }
    }
    lease.handles.clear();
    lease.released = true;
    generation.forkLeases.delete(lease);
  }

  private acquireDirect(
    generation: BrokerGenerationState,
    handle: number,
    entry: BrokerEntry,
  ): void {
    if (generation.directHandles.has(handle)) return;
    const addedOwnership = !generation.handles.has(handle);
    generation.directHandles.add(handle);
    try {
      if (addedOwnership) {
        generation.handles.add(handle);
        entry.holders.add(generation);
      }
    } catch (error) {
      generation.directHandles.delete(handle);
      if (addedOwnership) {
        generation.handles.delete(handle);
        entry.holders.delete(generation);
      }
      throw error;
    }
  }

  private removeGenerationHandle(
    generation: BrokerGenerationState,
    handle: number,
    entry: BrokerEntry,
  ): void {
    generation.handles.delete(handle);
    entry.holders.delete(generation);
    if (entry.holders.size === 0) this.forget(handle, entry.value);
  }

  private closeGeneration(
    generation: BrokerGenerationState,
    status: "released" | "replaced",
  ): void {
    if (generation.status !== "active") return;
    generation.status = status;
    if (this.currentGenerations.get(generation.token.pid) === generation) {
      this.currentGenerations.delete(generation.token.pid);
    }
    for (const lease of generation.forkLeases) {
      lease.handles.clear();
      lease.released = true;
    }
    generation.forkLeases.clear();
    generation.directHandles.clear();
    generation.forkHandleCounts.clear();
    for (const handle of generation.handles) {
      const entry = this.entries.get(handle);
      if (!entry) continue;
      entry.holders.delete(generation);
      if (entry.holders.size === 0) this.forget(handle, entry.value);
    }
    generation.handles.clear();
  }

  private generationState(
    generation: ForkExternrefGeneration,
  ): BrokerGenerationState {
    if (
      typeof generation !== "object"
      || generation === null
      || generation[GENERATION_TOKEN] !== true
    ) {
      throw new Error("unknown externref generation token");
    }
    const state = this.generations.get(generation);
    if (!state) throw new Error("externref generation belongs to another broker");
    return state;
  }

  private requireActiveGeneration(
    generation: ForkExternrefGeneration,
  ): BrokerGenerationState {
    const state = this.generationState(generation);
    if (
      state.status !== "active"
      || this.currentGenerations.get(state.token.pid) !== state
    ) {
      throw new Error(
        `stale externref generation ${state.token.id} for pid ${state.token.pid}`,
      );
    }
    return state;
  }

  private requireEntry(handle: number): BrokerEntry {
    const entry = this.entries.get(handle);
    if (entry) return entry;
    if (handle < this.nextHandle) {
      throw new Error(`retired externref handle ${handle}`);
    }
    throw new Error(`unknown externref handle ${handle}`);
  }

  private lookupValueHandle(value: unknown): number | undefined {
    if ((typeof value === "object" && value !== null) || typeof value === "function") {
      return this.objectHandles.get(value as object);
    }
    if (typeof value === "number") {
      return this.numberHandles.get(exactNumberBits(value));
    }
    return this.primitiveHandles.get(value);
  }

  private rememberValueHandle(value: unknown, handle: number): void {
    if ((typeof value === "object" && value !== null) || typeof value === "function") {
      this.objectHandles.set(value as object, handle);
    } else if (typeof value === "number") {
      this.numberHandles.set(exactNumberBits(value), handle);
    } else {
      this.primitiveHandles.set(value, handle);
    }
  }

  private forget(handle: number, value: unknown): void {
    this.entries.delete(handle);
    if ((typeof value === "object" && value !== null) || typeof value === "function") {
      // WeakMap has no conditional delete. Deleting is safe because a handle
      // is removed only after every process holder released the strong entry.
      this.objectHandles.delete(value as object);
    } else if (typeof value === "number") {
      const bits = exactNumberBits(value);
      if (this.numberHandles.get(bits) === handle) {
        this.numberHandles.delete(bits);
      }
    } else if (this.primitiveHandles.get(value) === handle) {
      this.primitiveHandles.delete(value);
    }
  }
}

function exactNumberBits(value: number): bigint {
  const bytes = new ArrayBuffer(Float64Array.BYTES_PER_ELEMENT);
  const view = new DataView(bytes);
  view.setFloat64(0, value, true);
  return view.getBigUint64(0, true);
}

/**
 * Worker-local canonical tokens for broker handles.
 *
 * A child never receives the parent's token object. It recreates exactly one
 * local token per handle, which preserves all identity observations available
 * to Wasm while keeping the actual object under broker ownership.
 */
export class ForkExternrefTokenCache {
  private readonly tokens = new Map<number, WeakRef<ForkExternrefToken>>();

  constructor(readonly generationId: number) {
    assertWireLimit(generationId, "externref worker generation");
  }

  materialize(handle: number): ForkExternrefToken {
    assertHandle(handle);
    let token = this.tokens.get(handle)?.deref();
    if (!token) {
      token = Object.freeze({
        [HANDLE_TOKEN]: handle,
        [WORKER_GENERATION_TOKEN]: this.generationId,
      });
      this.tokens.set(handle, new WeakRef(token));
    }
    return token;
  }

  encode(value: unknown): number | null {
    if (
      typeof value !== "object"
      || value === null
      || !(HANDLE_TOKEN in value)
      || !(WORKER_GENERATION_TOKEN in value)
    ) {
      return null;
    }
    if (
      (value as ForkExternrefToken)[WORKER_GENERATION_TOKEN]
        !== this.generationId
    ) {
      return null;
    }
    const handle = (value as ForkExternrefToken)[HANDLE_TOKEN];
    assertHandle(handle);
    return handle;
  }

  clear(): void {
    // Weak references do not own the tokens; clearing merely forgets canonical
    // lookup entries at exec/process teardown.
    this.tokens.clear();
  }
}

/**
 * Worker-facing recipe provider for externrefs already adapted by the process
 * owner.
 *
 * Host imports that create opaque values must register them with the
 * process-wide owner and return this Worker's canonical token. Consequently
 * the continuation encoder never needs to clone or inspect the real value.
 */
export class ForkExternrefTokenRecipeProvider {
  constructor(
    private readonly tokens: ForkExternrefTokenCache,
    /**
     * Late owner adoption for an exact Worker-local value that has never
     * needed to cross a process boundary before this fork.
     */
    private readonly normalizeUnclaimed?: (
      value: unknown,
    ) => ForkExternrefToken,
  ) {}

  capture(value: unknown): number {
    let handle = this.tokens.encode(value);
    if (handle === null && this.normalizeUnclaimed) {
      // WHY: the transaction separately retains `value` for parent replay.
      // Only the fresh-child recipe uses this canonical owner token.
      handle = this.tokens.encode(this.normalizeUnclaimed(value));
    }
    if (handle === null) {
      throw new Error(
        "externref reached fork without passing through the process reference owner",
      );
    }
    return handle;
  }

  materialize(handle: number): ForkExternrefToken {
    return this.tokens.materialize(handle);
  }

  tryEncode(value: unknown): number | undefined {
    const handle = this.tokens.encode(value);
    return handle === null ? undefined : handle;
  }
}
