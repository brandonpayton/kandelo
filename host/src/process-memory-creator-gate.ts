/**
 * Worker-realm lifecycle gate for operations that can expose process memory
 * to a newly created process or pthread Worker.
 *
 * Closing the gate is synchronous. Destroy can therefore close admission
 * before its first await, wait for every already-admitted creator, and only
 * then sweep the exact process generations and Worker aliases they installed.
 */
export class ProcessMemoryCreatorGate {
  private open = true;
  private activeCreators = 0;
  private exclusiveOperation: string | undefined;
  private readonly drainWaiters = new Set<() => void>();
  private readonly exclusiveDrainWaiters = new Set<() => void>();
  private readonly queuedAdmissionWaiters = new Set<() => void>();
  private readonly queuedLaunchListeners = new Set<() => void>();
  private destroyOperation: Promise<unknown> | undefined;

  /**
   * Run one admitted creator and release its admission on every terminal path.
   */
  run<T>(operation: string, creator: () => T | PromiseLike<T>): Promise<T> {
    return this.runUntilCommitted(operation, () => creator());
  }

  /**
   * Admit ownership that must transfer out of an async setup callback.
   *
   * The owner must release the admission after either publishing the exact
   * process generation or abandoning it. Release is idempotent so terminal
   * cleanup can share one path with setup failures without double-releasing
   * the gate.
   *
   * A reversible exclusive (a checkpoint freeze) queues this admission rather
   * than refusing it: a guest's fork or exec must never fail because someone
   * chose that moment to read the machine. The launch waits out the freeze
   * and runs when the machine resumes. Only terminal destroy still refuses.
   */
  async acquire(operation: string): Promise<{ release: () => void }> {
    if (this.open && this.exclusiveOperation !== undefined) {
      for (const listener of this.queuedLaunchListeners) listener();
      // Admission is granted inside the exclusive's own release, before any
      // later exclusive can reclaim the gate. Without that synchronous
      // hand-off, a capture retry loop and the queued launch would race the
      // gate on microtask order, and the launch could starve.
      let granted = false;
      await new Promise<void>((resolve) => {
        this.queuedAdmissionWaiters.add(() => {
          if (this.open && this.exclusiveOperation === undefined) {
            this.activeCreators += 1;
            granted = true;
          }
          resolve();
        });
      });
      if (granted) return this.admissionHandle();
      return this.acquire(operation);
    }
    if (!this.open) {
      throw new Error(
        `kernel worker is being destroyed; cannot start ${operation}`,
      );
    }
    this.activeCreators += 1;
    return this.admissionHandle();
  }

  private admissionHandle(): { release: () => void } {
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        this.releaseCreator();
      },
    };
  }

  /**
   * Say when a launch queues behind the running exclusive.
   *
   * A queued launch means its initiating process is parked inside fork, exec,
   * spawn, or clone rather than at a freeze hook, so a freeze that is waiting
   * for every process to park is waiting for something that cannot happen.
   * The freeze listens here to give the machine back at once instead of
   * timing out against it.
   */
  onLaunchQueuedDuringExclusive(listener: () => void): () => void {
    this.queuedLaunchListeners.add(listener);
    return () => this.queuedLaunchListeners.delete(listener);
  }

  /** Whether a launch is already waiting out the running exclusive. */
  hasQueuedAdmissions(): boolean {
    return this.queuedAdmissionWaiters.size > 0;
  }

  /**
   * Admit a creator whose semantic completion can outlive its installation.
   *
   * `commit()` releases destroy admission once the exact generation and all
   * of its ownership handles are published in the host process registry. The
   * returned operation may remain pending afterward. This is required for
   * vfork: its onFork promise parks the caller until child exec/_exit, but a
   * terminal host destroy must be able to sweep that already-visible child
   * instead of waiting for the parked syscall first.
   *
   * If the creator fails or completes before commit, its terminal path releases
   * admission. Calling commit more than once is harmless so a common finally
   * path cannot double-release the gate.
   */
  async runUntilCommitted<T>(
    operation: string,
    creator: (commit: () => void) => T | PromiseLike<T>,
  ): Promise<T> {
    const admission = await this.acquire(operation);
    const commit = admission.release;
    try {
      return await creator(commit);
    } finally {
      commit();
    }
  }

  /**
   * Hold admission closed for one reversible operation, then reopen it.
   *
   * A checkpoint freeze needs the same exclusion `closeAndWait()` provides but
   * must give it back: a machine that resumes after a failed handover has to
   * fork, exec, `posix_spawn`, and start pthreads again. Admission reopens in a
   * `finally`, so a throwing or rejecting operation cannot strand the gate.
   */
  async runExclusive<T>(
    operation: string,
    exclusive: () => T | PromiseLike<T>,
  ): Promise<T> {
    if (!this.open) {
      throw new Error(
        `kernel worker is being destroyed; cannot start ${operation}`,
      );
    }
    if (this.exclusiveOperation !== undefined) {
      throw new Error(
        `${this.exclusiveOperation} is in progress; cannot start ${operation}`,
      );
    }
    this.exclusiveOperation = operation;
    try {
      if (this.activeCreators !== 0) {
        await new Promise<void>((resolve) => {
          this.exclusiveDrainWaiters.add(resolve);
        });
      }
      return await exclusive();
    } finally {
      this.exclusiveOperation = undefined;
      this.releaseQueuedAdmissions();
    }
  }

  /**
   * Permanently close admission and wait for creators that entered first.
   *
   * Repeated calls are idempotent because whole-worker destroy is terminal.
   */
  closeAndWait(): Promise<void> {
    this.open = false;
    this.releaseQueuedAdmissions();
    if (this.activeCreators === 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.drainWaiters.add(resolve);
    });
  }

  /**
   * Close admission, drain admitted creators, then run terminal teardown once.
   *
   * WHY: merely awaiting `closeAndWait()` at two call sites leaves it possible
   * for a future destroy edit to start sweeping process maps before the drain.
   * Keeping the ordering in this shared primitive makes that ownership fence
   * executable and makes repeated destroy messages observe the same teardown.
   */
  closeAndRunAfterDrain<T>(
    destroy: () => T | PromiseLike<T>,
  ): Promise<T> {
    if (this.destroyOperation) {
      return this.destroyOperation as Promise<T>;
    }
    const drained = this.closeAndWait();
    const operation = drained.then(() => destroy());
    // Assign before the first promise continuation can run so a reentrant
    // destroy cannot install a second terminal operation.
    this.destroyOperation = operation;
    return operation;
  }

  private releaseQueuedAdmissions(): void {
    for (const resolve of this.queuedAdmissionWaiters) resolve();
    this.queuedAdmissionWaiters.clear();
  }

  private releaseCreator(): void {
    if (this.activeCreators <= 0) {
      throw new Error("process memory creator admission released twice");
    }
    this.activeCreators -= 1;
    if (this.activeCreators === 0) {
      for (const resolve of this.exclusiveDrainWaiters) resolve();
      this.exclusiveDrainWaiters.clear();
    }
    if (this.open || this.activeCreators !== 0) return;
    for (const resolve of this.drainWaiters) resolve();
    this.drainWaiters.clear();
  }
}
