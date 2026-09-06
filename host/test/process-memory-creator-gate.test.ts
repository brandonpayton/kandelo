import { describe, expect, it, vi } from "vitest";

import { ProcessMemoryCreatorGate } from "../src/process-memory-creator-gate";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

describe("process memory creator destroy gate", () => {
  it("drains an admitted creator before running one terminal destroy sweep", async () => {
    const gate = new ProcessMemoryCreatorGate();
    const spawn = deferred();
    const spawnStarted = vi.fn();
    const lateExec = vi.fn();
    const sweep = vi.fn(() => ({ gracefulDetachComplete: true }));
    const duplicateSweep = vi.fn(() => ({ gracefulDetachComplete: false }));
    const errorResponses: string[] = [];
    const admittedSpawn = gate.run("spawn", async () => {
      spawnStarted();
      await spawn.promise;
      return 17;
    });

    const destroy = gate.closeAndRunAfterDrain(sweep);
    const repeatedDestroy = gate.closeAndRunAfterDrain(duplicateSweep);
    await gate
      .run("exec", () => {
        lateExec();
        return 0;
      })
      .catch((error) => {
        // Mirrors the worker-entry request catch: one rejected admission gets
        // one response and never invokes the rejected creator body.
        errorResponses.push(
          error instanceof Error ? error.message : String(error),
        );
      });
    expect(spawnStarted).toHaveBeenCalledOnce();
    expect(lateExec).not.toHaveBeenCalled();
    expect(errorResponses).toEqual([
      "kernel worker is being destroyed; cannot start exec",
    ]);
    expect(repeatedDestroy).toBe(destroy);
    expect(sweep).not.toHaveBeenCalled();
    expect(duplicateSweep).not.toHaveBeenCalled();

    let destroyFinished = false;
    void destroy.then(() => {
      destroyFinished = true;
    });
    await Promise.resolve();
    expect(destroyFinished).toBe(false);

    spawn.resolve();
    await expect(admittedSpawn).resolves.toBe(17);
    await expect(destroy).resolves.toEqual({ gracefulDetachComplete: true });
    await expect(repeatedDestroy).resolves.toEqual({
      gracefulDetachComplete: true,
    });
    expect(sweep).toHaveBeenCalledOnce();
    expect(duplicateSweep).not.toHaveBeenCalled();
  });

  it("drains an admitted exec and rejects a later spawn", async () => {
    const gate = new ProcessMemoryCreatorGate();
    const exec = deferred();
    const lateSpawn = vi.fn();
    const admittedExec = gate.run("exec", async () => {
      await exec.promise;
      return 0;
    });

    const firstDrain = gate.closeAndWait();
    const secondDrain = gate.closeAndWait();
    await expect(
      gate.run("spawn", () => {
        lateSpawn();
        return 23;
      }),
    ).rejects.toThrow("kernel worker is being destroyed; cannot start spawn");
    expect(lateSpawn).not.toHaveBeenCalled();

    exec.resolve();
    await expect(admittedExec).resolves.toBe(0);
    await expect(Promise.all([firstDrain, secondDrain])).resolves.toEqual([
      undefined,
      undefined,
    ]);
  });

  it("keeps transferred exec-plan ownership in the destroy drain until release", async () => {
    const gate = new ProcessMemoryCreatorGate();
    const sweep = vi.fn();
    const admission = await gate.acquire("an exec replacement plan");

    const destroy = gate.closeAndRunAfterDrain(sweep);
    await Promise.resolve();
    expect(sweep).not.toHaveBeenCalled();

    admission.release();
    admission.release();
    await expect(destroy).resolves.toBeUndefined();
    expect(sweep).toHaveBeenCalledOnce();
    await expect(gate.acquire("a late exec replacement plan")).rejects.toThrow(
      "kernel worker is being destroyed; cannot start a late exec replacement plan",
    );
  });

  it("releases admission when a creator throws", async () => {
    const gate = new ProcessMemoryCreatorGate();
    const sweep = vi.fn();
    await expect(
      gate.run("failing creator", () => {
        throw new Error("injected creator failure");
      }),
    ).rejects.toThrow("injected creator failure");
    await expect(
      gate.closeAndRunAfterDrain(sweep),
    ).resolves.toBeUndefined();
    expect(sweep).toHaveBeenCalledOnce();
  });

  it("runs terminal teardown after an admitted creator rejects", async () => {
    const gate = new ProcessMemoryCreatorGate();
    const resume = deferred();
    const sweep = vi.fn();
    const creator = gate.run("failing async creator", async () => {
      await resume.promise;
      throw new Error("injected async creator failure");
    });
    const destroy = gate.closeAndRunAfterDrain(sweep);

    expect(sweep).not.toHaveBeenCalled();
    resume.resolve();
    await expect(creator).rejects.toThrow("injected async creator failure");
    await expect(destroy).resolves.toBeUndefined();
    expect(sweep).toHaveBeenCalledOnce();
  });

  it("lets destroy sweep a committed generation while its syscall stays parked", async () => {
    const gate = new ProcessMemoryCreatorGate();
    const vforkLifetime = deferred();
    const generationPublished = vi.fn();
    const sweep = vi.fn(() => ({ gracefulDetachComplete: true }));
    const vfork = gate.runUntilCommitted(
      "vfork process Worker",
      async (commit) => {
        generationPublished();
        commit();
        await vforkLifetime.promise;
        return 41;
      },
    );

    const destroy = gate.closeAndRunAfterDrain(sweep);
    await expect(destroy).resolves.toEqual({ gracefulDetachComplete: true });
    expect(generationPublished).toHaveBeenCalledOnce();
    expect(sweep).toHaveBeenCalledOnce();

    let vforkFinished = false;
    void vfork.then(() => {
      vforkFinished = true;
    });
    await Promise.resolve();
    expect(vforkFinished).toBe(false);

    vforkLifetime.resolve();
    await expect(vfork).resolves.toBe(41);
  });

  it("queues a launch behind a freeze and runs it when the machine resumes", async () => {
    const gate = new ProcessMemoryCreatorGate();
    const spawn = deferred();
    const capture = deferred();
    const queued = vi.fn();
    const lateExec = vi.fn(() => 0);
    const offQueued = gate.onLaunchQueuedDuringExclusive(queued);
    const admittedSpawn = gate.run("spawn", async () => {
      await spawn.promise;
      return 5;
    });

    const freeze = gate.runExclusive("a checkpoint freeze", () => capture.promise);
    const queuedExec = gate.run("exec", lateExec);
    await Promise.resolve();
    expect(queued).toHaveBeenCalledOnce();
    expect(gate.hasQueuedAdmissions()).toBe(true);
    expect(lateExec).not.toHaveBeenCalled();

    spawn.resolve();
    await expect(admittedSpawn).resolves.toBe(5);
    expect(lateExec).not.toHaveBeenCalled();

    capture.resolve();
    await expect(freeze).resolves.toBeUndefined();
    await expect(queuedExec).resolves.toBe(0);
    expect(gate.hasQueuedAdmissions()).toBe(false);
    offQueued();
  });

  it("reopens admission when a freeze rejects", async () => {
    const gate = new ProcessMemoryCreatorGate();
    await expect(
      gate.runExclusive("a checkpoint freeze", () => {
        throw new Error("injected freeze failure");
      }),
    ).rejects.toThrow("injected freeze failure");

    await expect(gate.run("spawn", () => 3)).resolves.toBe(3);
  });

  it("refuses a second freeze and refuses to freeze during destroy", async () => {
    const gate = new ProcessMemoryCreatorGate();
    const capture = deferred();
    const freeze = gate.runExclusive("a checkpoint freeze", () => capture.promise);
    await expect(
      gate.runExclusive("a second checkpoint freeze", () => undefined),
    ).rejects.toThrow(
      "a checkpoint freeze is in progress; cannot start a second checkpoint freeze",
    );

    capture.resolve();
    await expect(freeze).resolves.toBeUndefined();

    await gate.closeAndWait();
    await expect(
      gate.runExclusive("a late checkpoint freeze", () => undefined),
    ).rejects.toThrow(
      "kernel worker is being destroyed; cannot start a late checkpoint freeze",
    );
  });

  it("keeps pre-commit creation failures in the destroy drain", async () => {
    const gate = new ProcessMemoryCreatorGate();
    const rollback = deferred();
    const sweep = vi.fn();
    const creator = gate.runUntilCommitted(
      "failing vfork setup",
      async (_commit) => {
        await rollback.promise;
        throw new Error("injected pre-commit failure");
      },
    );
    const destroy = gate.closeAndRunAfterDrain(sweep);

    await Promise.resolve();
    expect(sweep).not.toHaveBeenCalled();
    rollback.resolve();
    await expect(creator).rejects.toThrow("injected pre-commit failure");
    await expect(destroy).resolves.toBeUndefined();
    expect(sweep).toHaveBeenCalledOnce();
  });
});
