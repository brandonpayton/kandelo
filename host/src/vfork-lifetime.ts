const EAGAIN = 11;

export interface VforkProcessGeneration {
  readonly memory: WebAssembly.Memory;
}

export type VforkExactCompletionReason =
  | "exec"
  | "exit"
  | "signal"
  | "trap";

export type VforkLifetimePhase =
  | "starting"
  | "borrowing"
  | "settled";

export type VforkLifetimeDisposition<TGeneration extends object> =
  | {
      readonly kind: "resume-parent";
      readonly parentGeneration: TGeneration;
      readonly childPid: number;
      readonly reason: VforkExactCompletionReason;
    }
  | {
      readonly kind: "return-error";
      readonly parentGeneration: TGeneration;
      readonly childPid: number;
      readonly errno: number;
    }
  | {
      readonly kind: "contain-address-space";
      readonly parentGeneration: TGeneration;
      readonly childPid: number;
      readonly cause: unknown;
    };

export interface VforkLifetime<
  TGeneration extends VforkProcessGeneration,
> {
  readonly parentPid: number;
  readonly childPid: number;
  readonly parentGeneration: TGeneration;
  readonly childGeneration: TGeneration;
  readonly memory: WebAssembly.Memory;
  readonly phase: VforkLifetimePhase;
  readonly failedExecAttempts: number;
  readonly completion: Promise<VforkLifetimeDisposition<TGeneration>>;
}

interface MutableVforkLifetime<
  TGeneration extends VforkProcessGeneration,
> {
  readonly handle: VforkLifetime<TGeneration>;
  readonly parentPid: number;
  readonly childPid: number;
  readonly parentGeneration: TGeneration;
  readonly childGeneration: TGeneration;
  readonly memory: WebAssembly.Memory;
  readonly resolve: (
    disposition: VforkLifetimeDisposition<TGeneration>,
  ) => void;
  phase: VforkLifetimePhase;
  failedExecAttempts: number;
}

export class VforkAddressSpaceBusyError extends Error {
  readonly errno = EAGAIN;

  constructor(
    message = "address space already has an active vfork lifetime",
  ) {
    super(message);
    this.name = "VforkAddressSpaceBusyError";
  }
}

/**
 * Coordinates the host-only lifetime of a child borrowing parent Memory.
 *
 * This class deliberately does not infer exact retirement from a Worker exit
 * event or timeout. Node and browser hosts must first use their existing
 * exec-retirement, Worker-quiescence, and exact-generation detach fences, then
 * call `completeAfterExactTeardown`. A caller that cannot establish that proof
 * must choose `requireAddressSpaceContainment`; that disposition never grants
 * permission to resume the suspended parent.
 *
 * The asynchronous `onFork` callback remains the actual caller-thread parking
 * mechanism. Its consumer must also compare `parentGeneration` with the host's
 * current PID registration before completing the channel, because a sibling
 * pthread may have replaced or exited the parent generation while it waited.
 */
export class VforkLifetimeCoordinator<
  TGeneration extends VforkProcessGeneration,
> {
  private readonly byMemory = new Map<
    WebAssembly.Memory,
    MutableVforkLifetime<TGeneration>
  >();
  private readonly byChild = new Map<
    TGeneration,
    MutableVforkLifetime<TGeneration>
  >();
  private readonly completedChildren = new WeakSet<TGeneration>();

  get activeCount(): number {
    return this.byMemory.size;
  }

  hasActiveAddressSpace(memory: WebAssembly.Memory): boolean {
    return this.byMemory.has(memory);
  }

  /**
   * Resolve once every borrow live at the time of the call has ended.
   *
   * A checkpoint freeze cannot read process memory while a vfork child still
   * aliases its parent's address space, and a borrowing parent is suspended
   * rather than parked in `__syscall`, so stopping every process does not
   * cover it. The wait is unbounded by construction: `noteFailedExec` caps
   * nothing, so a child looping on a failing `execve` holds its parent for as
   * long as it likes. The caller supplies the timeout.
   */
  async settleActiveBorrows(): Promise<void> {
    await Promise.all(
      [...this.byMemory.values()].map((lifetime) => lifetime.handle.completion),
    );
  }

  isActiveBorrower(generation: TGeneration): boolean {
    const lifetime = this.byChild.get(generation);
    return lifetime?.phase === "borrowing";
  }

  phaseForChild(
    generation: TGeneration,
  ): VforkLifetimePhase | undefined {
    return this.byChild.get(generation)?.phase;
  }

  begin(
    parentPid: number,
    childPid: number,
    parentGeneration: TGeneration,
    childGeneration: TGeneration,
  ): VforkLifetime<TGeneration> {
    this.validatePid(parentPid, "parent");
    this.validatePid(childPid, "child");
    if (parentPid === childPid) {
      throw new Error("vfork parent and child PIDs must differ");
    }
    if (parentGeneration === childGeneration) {
      throw new Error("vfork parent and child generations must differ");
    }
    const memory = parentGeneration.memory;
    if (childGeneration.memory !== memory) {
      throw new Error("vfork child does not alias the parent Memory");
    }
    if (!(memory.buffer instanceof SharedArrayBuffer)) {
      throw new Error("vfork requires Shared WebAssembly.Memory");
    }
    if (this.byMemory.has(memory)) {
      throw new VforkAddressSpaceBusyError();
    }
    if (
      this.byChild.has(childGeneration)
      || this.completedChildren.has(childGeneration)
    ) {
      throw new Error("vfork child generation was already used");
    }

    let resolve!: (
      disposition: VforkLifetimeDisposition<TGeneration>,
    ) => void;
    const completion = new Promise<VforkLifetimeDisposition<TGeneration>>(
      (done) => {
        resolve = done;
      },
    );
    const lifetime = {} as MutableVforkLifetime<TGeneration>;
    const handle: VforkLifetime<TGeneration> = Object.freeze({
      parentPid,
      childPid,
      parentGeneration,
      childGeneration,
      memory,
      get phase() {
        return lifetime.phase;
      },
      get failedExecAttempts() {
        return lifetime.failedExecAttempts;
      },
      completion,
    });
    Object.assign(lifetime, {
      handle,
      parentPid,
      childPid,
      parentGeneration,
      childGeneration,
      memory,
      resolve,
      phase: "starting" as const,
      failedExecAttempts: 0,
    });
    this.byMemory.set(memory, lifetime);
    this.byChild.set(childGeneration, lifetime);
    return handle;
  }

  /**
   * Cross the point after which the child Worker may access shared memory.
   *
   * WHY: call this immediately before starting the Worker, not after a ready
   * message. If start throws after partially launching the realm, ordinary
   * rollback cannot prove quiescence and must contain the whole address space.
   */
  markChildMayAccessMemory(childGeneration: TGeneration): boolean {
    const lifetime = this.requireActive(childGeneration);
    if (lifetime.phase === "borrowing") return false;
    if (lifetime.phase !== "starting") {
      throw new Error("settled vfork lifetime cannot start a child");
    }
    lifetime.phase = "borrowing";
    return true;
  }

  /** Record a truthful child exec failure without releasing the parent. */
  noteFailedExec(childGeneration: TGeneration, errno: number): number {
    this.validateErrno(errno);
    const lifetime = this.requireActive(childGeneration);
    if (lifetime.phase !== "borrowing") {
      throw new Error("vfork exec failure reported before child launch");
    }
    lifetime.failedExecAttempts += 1;
    return lifetime.failedExecAttempts;
  }

  /**
   * Abort launch while it is still proven that no child realm touched Memory.
   */
  abortBeforeChildStart(
    childGeneration: TGeneration,
    errno: number,
  ): boolean {
    this.validateErrno(errno);
    const lifetime = this.activeOrCompleted(childGeneration);
    if (!lifetime) return false;
    if (lifetime.phase !== "starting") {
      throw new Error(
        "cannot return a vfork launch error after the child may access Memory",
      );
    }
    return this.settle(lifetime, {
      kind: "return-error",
      parentGeneration: lifetime.parentGeneration,
      childPid: lifetime.childPid,
      errno,
    });
  }

  /**
   * Complete a kernel child that died before its Worker could be started.
   */
  completeWithoutBorrow(
    childGeneration: TGeneration,
    reason: "exit" | "signal",
  ): boolean {
    const lifetime = this.activeOrCompleted(childGeneration);
    if (!lifetime) return false;
    if (lifetime.phase !== "starting") {
      throw new Error("vfork child already entered the shared address space");
    }
    return this.settle(lifetime, {
      kind: "resume-parent",
      parentGeneration: lifetime.parentGeneration,
      childPid: lifetime.childPid,
      reason,
    });
  }

  /**
   * Authorize parent resumption only after exact old-generation teardown.
   */
  completeAfterExactTeardown(
    childGeneration: TGeneration,
    reason: VforkExactCompletionReason,
  ): boolean {
    const lifetime = this.activeOrCompleted(childGeneration);
    if (!lifetime) return false;
    if (lifetime.phase !== "borrowing") {
      throw new Error("vfork child did not enter the shared address space");
    }
    return this.settle(lifetime, {
      kind: "resume-parent",
      parentGeneration: lifetime.parentGeneration,
      childPid: lifetime.childPid,
      reason,
    });
  }

  /**
   * End bookkeeping without authorizing access to the backing by the parent.
   */
  requireAddressSpaceContainment(
    childGeneration: TGeneration,
    cause: unknown,
  ): boolean {
    const lifetime = this.activeOrCompleted(childGeneration);
    if (!lifetime) return false;
    return this.settle(lifetime, {
      kind: "contain-address-space",
      parentGeneration: lifetime.parentGeneration,
      childPid: lifetime.childPid,
      cause,
    });
  }

  private activeOrCompleted(
    childGeneration: TGeneration,
  ): MutableVforkLifetime<TGeneration> | undefined {
    const lifetime = this.byChild.get(childGeneration);
    if (lifetime) return lifetime;
    if (this.completedChildren.has(childGeneration)) return undefined;
    throw new Error("unknown vfork child generation");
  }

  private requireActive(
    childGeneration: TGeneration,
  ): MutableVforkLifetime<TGeneration> {
    const lifetime = this.activeOrCompleted(childGeneration);
    if (!lifetime) throw new Error("vfork child lifetime is already settled");
    return lifetime;
  }

  private settle(
    lifetime: MutableVforkLifetime<TGeneration>,
    disposition: VforkLifetimeDisposition<TGeneration>,
  ): boolean {
    if (lifetime.phase === "settled") return false;
    lifetime.phase = "settled";
    if (this.byMemory.get(lifetime.memory) === lifetime) {
      this.byMemory.delete(lifetime.memory);
    }
    this.byChild.delete(lifetime.childGeneration);
    this.completedChildren.add(lifetime.childGeneration);
    lifetime.resolve(disposition);
    return true;
  }

  private validatePid(pid: number, role: string): void {
    if (!Number.isSafeInteger(pid) || pid <= 0) {
      throw new Error(`invalid vfork ${role} PID: ${pid}`);
    }
  }

  private validateErrno(errno: number): void {
    if (!Number.isSafeInteger(errno) || errno <= 0) {
      throw new Error(`invalid vfork errno: ${errno}`);
    }
  }
}
