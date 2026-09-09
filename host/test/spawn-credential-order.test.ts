import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

import {
  type CentralizedKernelCallbacks,
  createCentralizedKernelWorkerTestDouble,
  type ResolvedSpawnProgram,
} from "../src/kernel-worker";
import { WASM_PAGE_SIZE } from "../src/constants";
import {
  ABI_SYSCALLS,
  ABI_VERSION,
  CHANNEL_STATUS_PENDING,
  CH_ARGS,
  CH_ARG_SIZE,
  CH_STATUS,
  CH_SYSCALL,
  HOST_INTERCEPTED_SYSCALLS,
  KERNEL_WAIT_RESULT_SI_CODE_OFFSET,
  KERNEL_WAIT_RESULT_SI_STATUS_OFFSET,
  KERNEL_WAIT_RESULT_WAIT_STATUS_OFFSET,
  WAIT_CLD_KILLED,
  WAIT_WNOHANG,
} from "../src/generated/abi";
import { installKernelWorkerTestScratch } from "./kernel-worker-test-scratch";
import { mockKernelSpawnBlobDecode } from "./support/spawn-blob-decode-mock";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const candidateA = new Uint8Array(
  readFileSync(join(repoRoot, "local-binaries/programs/wasm32/exec-child.wasm")),
);
const authoritativeB = new Uint8Array(
  readFileSync(join(repoRoot, "examples/hello.wasm")),
);

describe("posix_spawn credential/action/target order", () => {
  it("commits child-state target B after the one reserve/action transaction", async () => {
    const order: string[] = [];
    const kernelMemory = new WebAssembly.Memory({ initial: 4, maximum: 4 });
    const spawnProcess = vi.fn(() => {
      order.push("reserve-resetids-attrs-actions");
      return 100;
    });
    const prepareTarget = vi.fn(() => {
      order.push("prepare-B");
      return 31;
    });
    const commitTarget = vi.fn(() => {
      order.push("commit-B");
      return 0;
    });
    const onSpawn = vi.fn(async (
      _parentPid: number,
      _childPid: number,
      program: ResolvedSpawnProgram,
    ) => {
      order.push("launch-B");
      expect(new Uint8Array(program.programBytes)).toEqual(authoritativeB);
      expect(program.programModule).not.toBe(preflight.programModule);
      return 0;
    });
    const preflight = resolvedProgram(candidateA, ["relative-child"]);
    const harness = createSpawnHarness({
      kernelMemory,
      callbacks: { onSpawn },
      kernelExports: preparedSpawnExports({
        kernelMemory,
        targetBytes: authoritativeB,
        spawnProcess,
        prepareTarget,
        commitTarget,
      }),
    });

    harness.dispatch(preflight, "relative-child");
    await drainSpawnTransaction();

    expect(spawnProcess).toHaveBeenCalledOnce();
    expect(prepareTarget).toHaveBeenCalledOnce();
    expect(commitTarget).toHaveBeenCalledExactlyOnceWith(7, 100, 31);
    expect(onSpawn).toHaveBeenCalledOnce();
    expect(order).toEqual([
      "reserve-resetids-attrs-actions",
      "prepare-B",
      "commit-B",
      "launch-B",
    ]);
  });

  it("cancels the exact target and retires the pending child once on final read failure", async () => {
    const kernelMemory = new WebAssembly.Memory({ initial: 4, maximum: 4 });
    const cancelTarget = vi.fn(() => 0);
    const removeProcess = vi.fn(() => 0);
    const commitTarget = vi.fn(() => 0);
    const onSpawn = vi.fn(async () => 0);
    const exports = preparedSpawnExports({
      kernelMemory,
      targetBytes: authoritativeB,
      spawnProcess: vi.fn(() => 100),
      prepareTarget: vi.fn(() => 41),
      commitTarget,
    });
    exports.kernel_exec_target_read = vi.fn(() => -5);
    exports.kernel_exec_target_cancel = cancelTarget;
    exports.kernel_remove_process = removeProcess;
    const harness = createSpawnHarness({
      kernelMemory,
      callbacks: { onSpawn },
      kernelExports: exports,
    });

    harness.dispatch(resolvedProgram(candidateA, ["relative-child"]), "relative-child");
    await drainSpawnTransaction();

    expect(cancelTarget).toHaveBeenCalledExactlyOnceWith(100, 41);
    expect(removeProcess).toHaveBeenCalledExactlyOnceWith(100);
    expect(commitTarget).not.toHaveBeenCalled();
    expect(onSpawn).not.toHaveBeenCalled();
    expect(harness.completeChannel).toHaveBeenCalledWith(
      harness.channel,
      HOST_INTERCEPTED_SYSCALLS.SYS_SPAWN,
      harness.origArgs,
      undefined,
      -1,
      5,
    );
  });

  it("parses an authoritative shebang from the original spawn argv exactly once", async () => {
    const kernelMemory = new WebAssembly.Memory({ initial: 4, maximum: 4 });
    const scriptBytes = new TextEncoder().encode(
      "#!/bin/interpreter --flag\n",
    );
    const prepareTarget = vi.fn((
      _parentPid: number,
      _childPid: number,
      _pathPtr: number,
      _pathLen: number,
    ) => prepareTarget.mock.calls.length === 1 ? 31 : 32);
    const cancelTarget = vi.fn(() => 0);
    const commitTarget = vi.fn(() => 0);
    let launchedArgv: string[] | undefined;
    const onSpawn = vi.fn(async (
      _parentPid: number,
      _childPid: number,
      program: ResolvedSpawnProgram,
    ) => {
      launchedArgv = program.argv;
      return 0;
    });
    const exports = preparedSpawnExports({
      kernelMemory,
      targetBytes: authoritativeB,
      spawnProcess: vi.fn(() => 100),
      prepareTarget,
      commitTarget,
    });
    const bytesForTarget = (target: number): Uint8Array =>
      target === 31 ? scriptBytes : authoritativeB;
    exports.kernel_exec_target_size = vi.fn((
      _ownerPid: number,
      target: number,
    ) => BigInt(bytesForTarget(target).byteLength));
    exports.kernel_exec_target_read = vi.fn((
      _ownerPid: number,
      target: number,
      offsetLo: number,
      offsetHi: number,
      destination: number,
      capacity: number,
    ) => {
      const bytes = bytesForTarget(target);
      const offset = Number(
        (BigInt(offsetHi >>> 0) << 32n) | BigInt(offsetLo >>> 0),
      );
      const count = Math.min(capacity, bytes.byteLength - offset);
      new Uint8Array(kernelMemory.buffer, destination, count).set(
        bytes.subarray(offset, offset + count),
      );
      return count;
    });
    exports.kernel_exec_target_cancel = cancelTarget;
    // Faithful kernel-owned shebang decode (Phase 6 D3): the script target
    // yields its interpreter line; the interpreter target is a real wasm.
    exports.kernel_exec_target_shebang = vi.fn((
      _ownerPid: number,
      target: number,
      outPtr: number,
      outLen: number,
    ): number => {
      const bytes = bytesForTarget(target);
      if (!(bytes[0] === 0x23 && bytes[1] === 0x21)) return 0; // not `#!`
      let end = 2;
      while (end < bytes.length && bytes[end] !== 0x0a) end++;
      const line = new TextDecoder().decode(bytes.subarray(2, end)).trim();
      const sep = line.indexOf(" ");
      const interpreter = sep === -1 ? line : line.slice(0, sep);
      const argument = sep === -1 ? "" : line.slice(sep + 1).trim();
      const encoder = new TextEncoder();
      const interpreterBytes = encoder.encode(interpreter);
      const argumentBytes = encoder.encode(argument);
      const total = 9 + interpreterBytes.byteLength + argumentBytes.byteLength;
      if (total > outLen) return -75; // -EOVERFLOW
      const view = new DataView(kernelMemory.buffer, outPtr, outLen);
      view.setUint8(0, argument.length > 0 ? 1 : 0);
      view.setUint32(1, interpreterBytes.byteLength, true);
      view.setUint32(5, argumentBytes.byteLength, true);
      new Uint8Array(kernelMemory.buffer, outPtr + 9, interpreterBytes.byteLength)
        .set(interpreterBytes);
      new Uint8Array(
        kernelMemory.buffer,
        outPtr + 9 + interpreterBytes.byteLength,
        argumentBytes.byteLength,
      ).set(argumentBytes);
      return total;
    });
    const harness = createSpawnHarness({
      kernelMemory,
      callbacks: { onSpawn },
      kernelExports: exports,
    });
    const preflightAlreadyRewritten = resolvedProgram(authoritativeB, [
      "/bin/interpreter",
      "--flag",
      "relative-script",
      "argument",
    ]);

    harness.dispatch(
      preflightAlreadyRewritten,
      "relative-script",
      ["relative-script", "argument"],
    );
    await drainSpawnTransaction();

    expect(prepareTarget).toHaveBeenCalledTimes(2);
    expect(cancelTarget).toHaveBeenCalledExactlyOnceWith(100, 31);
    expect(commitTarget).toHaveBeenCalledExactlyOnceWith(7, 100, 32);
    expect(onSpawn).toHaveBeenCalledOnce();
    expect(launchedArgv).toEqual([
      "/bin/interpreter",
      "--flag",
      "/after-actions/relative-script",
      "argument",
    ]);
  });

  it("preserves a child signaled during final-target work as a waitable zombie", async () => {
    const kernelMemory = new WebAssembly.Memory({ initial: 4, maximum: 4 });
    const removeProcess = vi.fn(() => 0);
    const onExit = vi.fn();
    const onSpawn = vi.fn(async () => 0);
    const commitTarget = vi.fn(() => 0);
    const exports = preparedSpawnExports({
      kernelMemory,
      targetBytes: authoritativeB,
      spawnProcess: vi.fn(() => 100),
      prepareTarget: vi.fn(() => 31),
      commitTarget,
    });
    const targetSize = BigInt(authoritativeB.byteLength);
    exports.kernel_exec_target_size = vi.fn()
      .mockReturnValueOnce(targetSize)
      .mockReturnValue(-22n);
    exports.kernel_exec_target_cancel = vi.fn(() => -22);
    exports.kernel_publish_spawn_child = vi.fn(() => 15);
    exports.kernel_get_process_exit_signal = vi.fn((pid: number) =>
      pid === 100 ? 15 : -1
    );
    exports.kernel_remove_process = removeProcess;
    const harness = createSpawnHarness({
      kernelMemory,
      callbacks: { onExit, onSpawn },
      kernelExports: exports,
    });

    harness.dispatch(resolvedProgram(candidateA, ["relative-child"]), "relative-child");
    await drainSpawnTransaction();

    expect(onSpawn).not.toHaveBeenCalled();
    expect(commitTarget).not.toHaveBeenCalled();
    expect(removeProcess).not.toHaveBeenCalled();
    expect(onExit).toHaveBeenCalledExactlyOnceWith(100, 143);
    expect(harness.completeChannel).toHaveBeenCalledWith(
      harness.channel,
      HOST_INTERCEPTED_SYSCALLS.SYS_SPAWN,
      harness.origArgs,
      undefined,
      0,
      0,
    );
  });

  it("publishes spawn success before waking a sibling waiter for the hidden zombie", async () => {
    const kernelMemory = new WebAssembly.Memory({ initial: 4, maximum: 4 });
    let published = false;
    let childSignal = -1;
    let finishLaunch!: (result: number) => void;
    const onSpawn = vi.fn(() => new Promise<number>((resolve) => {
      finishLaunch = resolve;
    }));
    const publishSpawnChild = vi.fn(() => {
      published = true;
      return childSignal;
    });
    const waitChildPoll = vi.fn((
      _parentPid: number,
      _callerTid: number,
      _targetPid: number,
      _eventMask: number,
      _flags: number,
      destination: number,
    ) => {
      if (!published || childSignal <= 0) return 0;
      const result = new DataView(kernelMemory.buffer);
      result.setInt32(
        destination + KERNEL_WAIT_RESULT_WAIT_STATUS_OFFSET,
        childSignal,
        true,
      );
      result.setInt32(
        destination + KERNEL_WAIT_RESULT_SI_CODE_OFFSET,
        WAIT_CLD_KILLED,
        true,
      );
      result.setInt32(
        destination + KERNEL_WAIT_RESULT_SI_STATUS_OFFSET,
        childSignal,
        true,
      );
      return 100;
    });
    const removeProcess = vi.fn(() => 0);
    const exports = preparedSpawnExports({
      kernelMemory,
      targetBytes: authoritativeB,
      spawnProcess: vi.fn(() => 100),
      prepareTarget: vi.fn(() => 31),
      commitTarget: vi.fn(() => 0),
    });
    exports.kernel_publish_spawn_child = publishSpawnChild;
    exports.kernel_wait_child_poll = waitChildPoll;
    exports.kernel_get_process_exit_signal = vi.fn((pid: number) =>
      pid === 100 ? childSignal : -1
    );
    exports.kernel_get_parent_pid = vi.fn((pid: number) =>
      pid === 100 && published ? 7 : -3
    );
    exports.kernel_generate_host_signal = vi.fn(() => 0);
    exports.kernel_pick_signal_target_tid = vi.fn(() => 0);
    exports.kernel_has_sa_nocldwait = vi.fn(() => 0);
    exports.kernel_dequeue_signal = vi.fn(() => 0);
    exports.kernel_remove_process = removeProcess;
    const harness = createSpawnHarness({
      kernelMemory,
      callbacks: { onSpawn },
      kernelExports: exports,
    });

    harness.dispatch(
      resolvedProgram(candidateA, ["relative-child"]),
      "relative-child",
    );
    await drainSpawnTransaction();
    expect(onSpawn).toHaveBeenCalledOnce();

    childSignal = 15;
    harness.dispatchSiblingWait();
    expect(waitChildPoll).toHaveBeenCalledOnce();
    expect(harness.completeChannel).not.toHaveBeenCalled();

    finishLaunch(0);
    await drainSpawnTransaction();

    expect(publishSpawnChild).toHaveBeenCalledExactlyOnceWith(7, 100);
    expect(waitChildPoll).toHaveBeenCalledTimes(2);
    expect(removeProcess).not.toHaveBeenCalled();
    const spawnCompletion = harness.completeChannel.mock.calls.findIndex(
      (call) => call[1] === HOST_INTERCEPTED_SYSCALLS.SYS_SPAWN,
    );
    const waitCompletion = harness.completeChannel.mock.calls.findIndex(
      (call) => call[1] === ABI_SYSCALLS.Wait4,
    );
    expect(spawnCompletion).toBeGreaterThanOrEqual(0);
    expect(waitCompletion).toBeGreaterThan(spawnCompletion);
    expect(harness.completeChannel.mock.calls[waitCompletion]).toEqual([
      harness.siblingWaitChannel,
      ABI_SYSCALLS.Wait4,
      [-1, 0, 0, 0, 0, 0],
      undefined,
      100,
      0,
    ]);
  });

  it("removes a failed pending spawn once and wakes its parked waiter with ECHILD", async () => {
    const kernelMemory = new WebAssembly.Memory({ initial: 4, maximum: 4 });
    let removed = false;
    let finishLaunch!: (result: number) => void;
    const onSpawn = vi.fn(() => new Promise<number>((resolve) => {
      finishLaunch = resolve;
    }));
    const waitChildPoll = vi.fn(() => removed ? -10 : 0);
    const removeProcess = vi.fn(() => {
      removed = true;
      return 0;
    });
    const exports = preparedSpawnExports({
      kernelMemory,
      targetBytes: authoritativeB,
      spawnProcess: vi.fn(() => 100),
      prepareTarget: vi.fn(() => 31),
      commitTarget: vi.fn(() => 0),
    });
    exports.kernel_wait_child_poll = waitChildPoll;
    exports.kernel_dequeue_signal = vi.fn(() => 0);
    exports.kernel_remove_process = removeProcess;
    const harness = createSpawnHarness({
      kernelMemory,
      callbacks: { onSpawn },
      kernelExports: exports,
    });

    harness.dispatch(
      resolvedProgram(candidateA, ["relative-child"]),
      "relative-child",
    );
    await drainSpawnTransaction();
    harness.dispatchSiblingWait();
    expect(waitChildPoll).toHaveBeenCalledOnce();
    expect(harness.completeChannel).not.toHaveBeenCalled();

    finishLaunch(-5);
    await drainSpawnTransaction();

    expect(removeProcess).toHaveBeenCalledExactlyOnceWith(100);
    expect(waitChildPoll).toHaveBeenCalledTimes(2);
    expect(harness.completeChannel).toHaveBeenCalledWith(
      harness.siblingWaitChannel,
      ABI_SYSCALLS.Wait4,
      [-1, 0, 0, 0, 0, 0],
      undefined,
      -1,
      10,
    );
    expect(harness.completeChannel).toHaveBeenCalledWith(
      harness.channel,
      HOST_INTERCEPTED_SYSCALLS.SYS_SPAWN,
      harness.origArgs,
      undefined,
      -1,
      5,
    );
  });

  it("reports WNOHANG while the unpublished spawn child remains hidden", async () => {
    const kernelMemory = new WebAssembly.Memory({ initial: 4, maximum: 4 });
    let finishLaunch!: (result: number) => void;
    const onSpawn = vi.fn(() => new Promise<number>((resolve) => {
      finishLaunch = resolve;
    }));
    const waitChildPoll = vi.fn(() => 0);
    const exports = preparedSpawnExports({
      kernelMemory,
      targetBytes: authoritativeB,
      spawnProcess: vi.fn(() => 100),
      prepareTarget: vi.fn(() => 31),
      commitTarget: vi.fn(() => 0),
    });
    exports.kernel_wait_child_poll = waitChildPoll;
    exports.kernel_dequeue_signal = vi.fn(() => 0);
    const harness = createSpawnHarness({
      kernelMemory,
      callbacks: { onSpawn },
      kernelExports: exports,
    });

    harness.dispatch(
      resolvedProgram(candidateA, ["relative-child"]),
      "relative-child",
    );
    await drainSpawnTransaction();
    harness.dispatchSiblingWait(WAIT_WNOHANG);

    expect(waitChildPoll).toHaveBeenCalledOnce();
    expect(harness.completeChannel).toHaveBeenCalledWith(
      harness.siblingWaitChannel,
      ABI_SYSCALLS.Wait4,
      [-1, 0, WAIT_WNOHANG, 0, 0, 0],
      undefined,
      0,
      0,
    );

    finishLaunch(0);
    await drainSpawnTransaction();
    expect(exports.kernel_publish_spawn_child).toHaveBeenCalledExactlyOnceWith(
      7,
      100,
    );
    expect(exports.kernel_remove_process).not.toHaveBeenCalled();
  });

  it("rolls back an ordinary commit ESRCH while the child remains live", async () => {
    const kernelMemory = new WebAssembly.Memory({ initial: 4, maximum: 4 });
    const removeProcess = vi.fn(() => 0);
    const onExit = vi.fn();
    const onSpawn = vi.fn(async () => 0);
    const exports = preparedSpawnExports({
      kernelMemory,
      targetBytes: authoritativeB,
      spawnProcess: vi.fn(() => 100),
      prepareTarget: vi.fn(() => 31),
      commitTarget: vi.fn(() => -3),
    });
    exports.kernel_get_process_exit_signal = vi.fn(() => -1);
    exports.kernel_remove_process = removeProcess;
    const harness = createSpawnHarness({
      kernelMemory,
      callbacks: { onExit, onSpawn },
      kernelExports: exports,
    });

    harness.dispatch(resolvedProgram(candidateA, ["relative-child"]), "relative-child");
    await drainSpawnTransaction();

    expect(onSpawn).not.toHaveBeenCalled();
    expect(onExit).not.toHaveBeenCalled();
    expect(removeProcess).toHaveBeenCalledExactlyOnceWith(100);
    expect(harness.completeChannel).toHaveBeenCalledWith(
      harness.channel,
      HOST_INTERCEPTED_SYSCALLS.SYS_SPAWN,
      harness.origArgs,
      undefined,
      -1,
      3,
    );
  });

  it("reports an absent child without issuing a second numeric removal", async () => {
    const kernelMemory = new WebAssembly.Memory({ initial: 4, maximum: 4 });
    const removeProcess = vi.fn(() => 0);
    const onSpawn = vi.fn(async () => 0);
    const exports = preparedSpawnExports({
      kernelMemory,
      targetBytes: authoritativeB,
      spawnProcess: vi.fn(() => 100),
      prepareTarget: vi.fn(() => 31),
      commitTarget: vi.fn(() => -3),
    });
    exports.kernel_get_process_exit_signal = vi.fn(() => -3);
    exports.kernel_publish_spawn_child = vi.fn(() => -3);
    exports.kernel_remove_process = removeProcess;
    const harness = createSpawnHarness({
      kernelMemory,
      callbacks: { onSpawn },
      kernelExports: exports,
    });

    harness.dispatch(
      resolvedProgram(candidateA, ["relative-child"]),
      "relative-child",
    );
    await drainSpawnTransaction();

    expect(onSpawn).not.toHaveBeenCalled();
    expect(exports.kernel_publish_spawn_child).toHaveBeenCalledExactlyOnceWith(
      7,
      100,
    );
    expect(removeProcess).not.toHaveBeenCalled();
    expect(harness.completeChannel).toHaveBeenCalledWith(
      harness.channel,
      HOST_INTERCEPTED_SYSCALLS.SYS_SPAWN,
      harness.origArgs,
      undefined,
      -1,
      3,
    );
  });

  it("does not remove an absent child after the parent channel retires", async () => {
    const kernelMemory = new WebAssembly.Memory({ initial: 4, maximum: 4 });
    let childSignal = -1;
    let finishLaunch!: (result: number) => void;
    const removeProcess = vi.fn(() => 0);
    const onSpawn = vi.fn(() => new Promise<number>((resolve) => {
      finishLaunch = resolve;
    }));
    const exports = preparedSpawnExports({
      kernelMemory,
      targetBytes: authoritativeB,
      spawnProcess: vi.fn(() => 100),
      prepareTarget: vi.fn(() => 31),
      commitTarget: vi.fn(() => 0),
    });
    const getProcessExitSignal = vi.fn((pid: number) =>
      pid === 100 ? childSignal : -1
    );
    exports.kernel_get_process_exit_signal = getProcessExitSignal;
    exports.kernel_remove_process = removeProcess;
    const harness = createSpawnHarness({
      kernelMemory,
      callbacks: { onSpawn },
      kernelExports: exports,
    });

    harness.dispatch(
      resolvedProgram(candidateA, ["relative-child"]),
      "relative-child",
    );
    await drainSpawnTransaction();
    expect(onSpawn).toHaveBeenCalledOnce();

    childSignal = -3;
    harness.retireParentChannel();
    finishLaunch(0);
    await drainSpawnTransaction();

    expect(exports.kernel_publish_spawn_child).not.toHaveBeenCalled();
    expect(getProcessExitSignal).toHaveBeenCalledWith(100);
    expect(removeProcess).not.toHaveBeenCalled();
  });

  it("removes a live hidden child once after the parent channel retires", async () => {
    const kernelMemory = new WebAssembly.Memory({ initial: 4, maximum: 4 });
    let finishLaunch!: (result: number) => void;
    const removeProcess = vi.fn(() => 0);
    const onSpawn = vi.fn(() => new Promise<number>((resolve) => {
      finishLaunch = resolve;
    }));
    const exports = preparedSpawnExports({
      kernelMemory,
      targetBytes: authoritativeB,
      spawnProcess: vi.fn(() => 100),
      prepareTarget: vi.fn(() => 31),
      commitTarget: vi.fn(() => 0),
    });
    exports.kernel_remove_process = removeProcess;
    const harness = createSpawnHarness({
      kernelMemory,
      callbacks: { onSpawn },
      kernelExports: exports,
    });

    harness.dispatch(
      resolvedProgram(candidateA, ["relative-child"]),
      "relative-child",
    );
    await drainSpawnTransaction();
    expect(onSpawn).toHaveBeenCalledOnce();

    harness.retireParentChannel();
    finishLaunch(0);
    await drainSpawnTransaction();

    expect(exports.kernel_publish_spawn_child).not.toHaveBeenCalled();
    expect(removeProcess).toHaveBeenCalledExactlyOnceWith(100);
  });

  it("removes the still-owned pending child when its bound parent is absent", async () => {
    const kernelMemory = new WebAssembly.Memory({ initial: 4, maximum: 4 });
    const removeProcess = vi.fn(() => 0);
    const onSpawn = vi.fn(async () => 0);
    const exports = preparedSpawnExports({
      kernelMemory,
      targetBytes: authoritativeB,
      spawnProcess: vi.fn(() => 100),
      prepareTarget: vi.fn(() => 31),
      commitTarget: vi.fn(() => -3),
    });
    exports.kernel_get_process_exit_signal = vi.fn(() => -3);
    exports.kernel_publish_spawn_child = vi.fn(() => -10);
    exports.kernel_remove_process = removeProcess;
    const harness = createSpawnHarness({
      kernelMemory,
      callbacks: { onSpawn },
      kernelExports: exports,
    });

    harness.dispatch(
      resolvedProgram(candidateA, ["relative-child"]),
      "relative-child",
    );
    await drainSpawnTransaction();

    expect(onSpawn).not.toHaveBeenCalled();
    expect(exports.kernel_publish_spawn_child).toHaveBeenCalledExactlyOnceWith(
      7,
      100,
    );
    expect(removeProcess).toHaveBeenCalledExactlyOnceWith(100);
    expect(harness.completeChannel).toHaveBeenCalledWith(
      harness.channel,
      HOST_INTERCEPTED_SYSCALLS.SYS_SPAWN,
      harness.origArgs,
      undefined,
      -1,
      10,
    );
  });
});

function resolvedProgram(
  bytes: Uint8Array,
  argv: string[],
): ResolvedSpawnProgram {
  const owned = bytes.slice();
  return {
    programBytes: owned.buffer,
    programModule: new WebAssembly.Module(owned),
    argv,
  };
}

function preparedSpawnExports(options: {
  kernelMemory: WebAssembly.Memory;
  targetBytes: Uint8Array;
  spawnProcess: ReturnType<typeof vi.fn>;
  prepareTarget: ReturnType<typeof vi.fn>;
  commitTarget: ReturnType<typeof vi.fn>;
}): Record<string, any> {
  const cwd = new TextEncoder().encode("/after-actions");
  return {
    kernel_spawn_blob_decode: mockKernelSpawnBlobDecode(options.kernelMemory),
    kernel_spawn_process: options.spawnProcess,
    kernel_spawn_exec_target_prepare: options.prepareTarget,
    kernel_exec_target_size: vi.fn(() => BigInt(options.targetBytes.byteLength)),
    kernel_exec_target_read: vi.fn((
      _ownerPid: number,
      _target: number,
      offsetLo: number,
      offsetHi: number,
      destination: number,
      capacity: number,
    ) => {
      const offset = Number(
        (BigInt(offsetHi >>> 0) << 32n) | BigInt(offsetLo >>> 0),
      );
      const count = Math.min(capacity, options.targetBytes.byteLength - offset);
      new Uint8Array(options.kernelMemory.buffer, destination, count).set(
        options.targetBytes.subarray(offset, offset + count),
      );
      return count;
    }),
    kernel_exec_target_cancel: vi.fn(() => 0),
    // The shared prepared-target launcher (Phase 6 D3) decodes the interpreter
    // line in the kernel; a real wasm program is not a script, so the export
    // reports "not a script" with 0.
    kernel_exec_target_shebang: vi.fn(() => 0),
    kernel_publish_spawn_child: vi.fn(() => -1),
    kernel_spawn_exec_commit: options.commitTarget,
    kernel_get_cwd: vi.fn((_pid: number, destination: number, capacity: number) => {
      if (capacity < cwd.byteLength) return -34;
      new Uint8Array(options.kernelMemory.buffer, destination, cwd.byteLength).set(cwd);
      return cwd.byteLength;
    }),
    kernel_remove_process: vi.fn(() => 0),
  };
}

function createSpawnHarness(options: {
  kernelMemory: WebAssembly.Memory;
  callbacks: CentralizedKernelCallbacks;
  kernelExports: Record<string, any>;
}) {
  const processMemory = new WebAssembly.Memory({
    initial: 4,
    maximum: 4,
    shared: true,
  });
  const completeChannel = vi.fn();
  const worker = createCentralizedKernelWorkerTestDouble({
    callbacks: options.callbacks,
  });
  let parentChannelActive = true;
  Reflect.set(worker, "kernelAbiVersion", ABI_VERSION);
  installKernelWorkerTestScratch(worker, options.kernelMemory, 4096, 4, {
    kernelExports: {
      kernel_drain_wakeup_events: vi.fn(() => 0),
      kernel_get_parent_pid: vi.fn(() => -1),
      kernel_get_process_exit_signal: vi.fn(() => -1),
      kernel_process_secure_exec: vi.fn(() => 0),
      kernel_mark_process_signaled: vi.fn(() => 0),
      kernel_set_current_tid: vi.fn(() => 0),
      ...options.kernelExports,
    },
  });
  const [channel, siblingWaitChannel] =
    worker.testAuthority.replaceProcessRegistrationForLifecycleTest({
      pid: 7,
      memory: processMemory,
      channelOffsets: [WASM_PAGE_SIZE, 2 * WASM_PAGE_SIZE],
    });
  if (!channel || !siblingWaitChannel) {
    throw new Error("spawn harness did not register both parent channels");
  }
  Atomics.store(
    new Int32Array(processMemory.buffer, channel.channelOffset),
    CH_STATUS / Int32Array.BYTES_PER_ELEMENT,
    CHANNEL_STATUS_PENDING,
  );
  worker.testAuthority.configureScratchBoundaryHooksForTest({
    completeChannel,
    isRegisteredChannel: (candidate) =>
      candidate.pid !== 7 || parentChannelActive,
  });
  const origArgs = [0, 0, 0, 1, 0, 0];
  return {
    channel,
    completeChannel,
    origArgs,
    siblingWaitChannel,
    retireParentChannel(): void {
      parentChannelActive = false;
    },
    dispatch(
      program: ResolvedSpawnProgram,
      authorityPath: string,
      originalArgv: string[] = program.argv,
    ): void {
      worker.testAuthority.dispatchSpawnAfterResolveForTest({
        channel,
        origArgs,
        parentPid: 7,
        callerTid: 7,
        pidOutPtr: 0,
        blobBytes: new Uint8Array([1]),
        blobLen: 1,
        program,
        envp: [],
        authorityPath,
        originalArgv,
      } as Parameters<
        typeof worker.testAuthority.dispatchSpawnAfterResolveForTest
      >[0]);
    },
    dispatchSiblingWait(options = 0): void {
      const waitArgs = [-1, 0, options, 0, 0, 0];
      const waitView = new DataView(
        siblingWaitChannel.memory.buffer,
        siblingWaitChannel.channelOffset,
      );
      Atomics.store(
        new Int32Array(
          siblingWaitChannel.memory.buffer,
          siblingWaitChannel.channelOffset,
        ),
        CH_STATUS / Int32Array.BYTES_PER_ELEMENT,
        CHANNEL_STATUS_PENDING,
      );
      waitView.setUint32(CH_SYSCALL, ABI_SYSCALLS.Wait4, true);
      for (let index = 0; index < waitArgs.length; index++) {
        waitView.setBigInt64(
          CH_ARGS + index * CH_ARG_SIZE,
          BigInt(waitArgs[index]!),
          true,
        );
      }
      worker.testAuthority.dispatchScratchBoundarySyscallForTest(
        siblingWaitChannel,
      );
    },
  };
}

async function drainSpawnTransaction(): Promise<void> {
  // Compiling divergent authoritative bytes uses the host's async Wasm
  // compiler. Give concurrent Vitest files enough event-loop turns for that
  // real detached phase and its fresh completion ingress to settle.
  for (let turn = 0; turn < 12; turn++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
    for (let microtask = 0; microtask < 12; microtask++) {
      await Promise.resolve();
    }
  }
}
