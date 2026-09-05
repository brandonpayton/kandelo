import { describe, expect, it, vi } from "vitest";
import { createCentralizedKernelWorkerTestDouble } from "../src/kernel-worker";
import {
  CH_CHECKPOINT_REQUEST,
  CH_CHECKPOINT_REQUEST_UNWIND,
  CH_REQUEST_FLAGS,
  CH_REQUEST_FLAG_DEFER_SIGNAL_DELIVERY,
  CH_TOTAL_SIZE,
  PROCESS_STATE_EXITED,
  PROCESS_STATE_RUNNING,
} from "../src/generated/abi";
import { installKernelWorkerTestScratch } from "./kernel-worker-test-scratch";

const PID = 41;
const KERNEL_MEMORY_PAGES = 2;

function createHarness(
  getProcessState: () => number,
  channelOffsets: readonly number[] = [0],
  usePolling = false,
) {
  const memory = new WebAssembly.Memory({
    initial: 2 * channelOffsets.length,
    maximum: 2 * channelOffsets.length,
    shared: true,
  });
  const kernelMemory = new WebAssembly.Memory({
    initial: KERNEL_MEMORY_PAGES,
    maximum: KERNEL_MEMORY_PAGES,
  });
  const worker = Object.assign(createCentralizedKernelWorkerTestDouble({}), {
    usePolling,
  });
  const { gate } = installKernelWorkerTestScratch(
    worker,
    kernelMemory,
    1024,
    4,
    {
      kernelExports: {
        kernel_dequeue_signal: vi.fn(() => 0),
        kernel_drain_wakeup_events: vi.fn(() => 0),
        kernel_get_parent_pid: vi.fn(() => -1),
        kernel_get_process_exit_signal: vi.fn(() =>
          getProcessState() === PROCESS_STATE_EXITED ? 11 : -1
        ),
        kernel_get_process_state: getProcessState,
        kernel_mark_process_signaled: vi.fn(() => 0),
        kernel_set_current_tid: vi.fn(() => 0),
      },
    },
  );
  const [channel] =
    worker.testAuthority.replaceProcessRegistrationForLifecycleTest({
      pid: PID,
      memory,
      channelOffsets,
    });
  if (channel === undefined) {
    throw new Error("checkpoint harness did not create its main channel");
  }
  return { worker, memory, kernelMemory, channel, gate };
}

/**
 * Park a completion the way a stopped process does, then publish it.
 *
 * Publication is deferred until the kernel-entry scope is revoked, so the
 * request word is only readable after the protocol effects have drained.
 */
async function publishOneCompletion(
  harness: ReturnType<typeof createHarness>,
  requestFlags: number,
): Promise<number> {
  const view = new DataView(harness.memory.buffer, 0);
  view.setUint32(CH_REQUEST_FLAGS, requestFlags, true);
  view.setUint32(CH_CHECKPOINT_REQUEST, 0, true);
  harness.worker.testAuthority.installParkedCloneCompletionForTest({
    channel: harness.channel,
    tid: 99,
    parentTidPointer: 512,
  });
  expect(harness.worker.testAuthority.resumeStoppedProcessForTest(PID)).toBe(true);
  for (let turn = 0; turn < 24; turn++) await Promise.resolve();
  return view.getUint32(CH_CHECKPOINT_REQUEST, true);
}

describe("checkpoint unwind request", () => {
  it("writes nothing until a freeze arms it", async () => {
    const harness = createHarness(() => PROCESS_STATE_RUNNING);
    await expect(publishOneCompletion(harness, 0)).resolves.toBe(0);
  });

  it("rides out on the next completion the guest observes", async () => {
    const harness = createHarness(() => PROCESS_STATE_RUNNING);
    expect(harness.worker.armCheckpointUnwind()).toEqual([PID]);
    await expect(publishOneCompletion(harness, 0))
      .resolves.toBe(CH_CHECKPOINT_REQUEST_UNWIND);
  });

  it("declines a deferred completion, which is ppoll's own timestamp read", async () => {
    const harness = createHarness(() => PROCESS_STATE_RUNNING);
    harness.worker.armCheckpointUnwind();
    await expect(
      publishOneCompletion(harness, CH_REQUEST_FLAG_DEFER_SIGNAL_DELIVERY),
    ).resolves.toBe(0);
    // The request is still armed, so the enclosing ppoll carries it instead.
    await expect(publishOneCompletion(harness, 0))
      .resolves.toBe(CH_CHECKPOINT_REQUEST_UNWIND);
  });

  // Leg 1 of the freeze guards eight dispatch sites, and the legacy polling
  // mode reaches them through a MessageChannel rather than Atomics.waitAsync.
  // The request word must ride out on the same completion under both.
  it("rides out under the polling dispatch mode too", async () => {
    const harness = createHarness(() => PROCESS_STATE_RUNNING, [0], true);
    expect(harness.worker.armCheckpointUnwind()).toEqual([PID]);
    await expect(publishOneCompletion(harness, 0))
      .resolves.toBe(CH_CHECKPOINT_REQUEST_UNWIND);
  });

  it("stops writing once the freeze disarms", async () => {
    const harness = createHarness(() => PROCESS_STATE_RUNNING);
    harness.worker.armCheckpointUnwind();
    harness.worker.disarmCheckpointUnwind();
    await expect(publishOneCompletion(harness, 0)).resolves.toBe(0);
  });
});

describe("checkpoint dispatch hold", () => {
  it("holds every registered process and releases exactly those", async () => {
    const harness = createHarness(() => PROCESS_STATE_RUNNING);
    expect(harness.worker.holdProcessDispatchForCheckpoint()).toEqual([PID]);
    // A second hold adds nothing: the pid is already off dispatch.
    expect(harness.worker.holdProcessDispatchForCheckpoint()).toEqual([]);
    await expect(harness.worker.releaseProcessDispatchForCheckpoint())
      .resolves.toEqual([]);
    // The release consumed the hold, so there is nothing left to give back.
    await expect(harness.worker.releaseProcessDispatchForCheckpoint())
      .resolves.toEqual([]);
  });

  it("reports a process whose resume barrier did not complete", async () => {
    let state = PROCESS_STATE_RUNNING;
    const harness = createHarness(() => state);
    harness.worker.holdProcessDispatchForCheckpoint();
    state = PROCESS_STATE_EXITED;
    await expect(harness.worker.releaseProcessDispatchForCheckpoint())
      .resolves.toEqual([PID]);
  });

  it("releases after work the read left queued in the kernel entry gate", async () => {
    const harness = createHarness(() => PROCESS_STATE_RUNNING);
    harness.worker.holdProcessDispatchForCheckpoint();

    // Reproduce what a machine with a display leaves behind. A vblank tick
    // reached during the read queues behind the entry that is running, so the
    // gate still has work waiting when the freeze reaches its release. The
    // release used to demand an idle gate and refused here, which failed the
    // whole capture.
    const order: string[] = [];
    let released: Promise<number[]> | undefined;
    harness.gate.runOrDeferVoidIngress("the read", () => {
      harness.gate.runOrDeferVoidIngress("a tick the read left queued", () => {
        order.push("queued");
        return undefined;
      });
      released = harness.worker.releaseProcessDispatchForCheckpoint();
      return undefined;
    });

    await expect(released).resolves.toEqual([]);
    order.push("released");
    expect(order).toEqual(["queued", "released"]);
  });

  it("reports a poisoned generation instead of waiting for a discarded release", async () => {
    const harness = createHarness(() => PROCESS_STATE_RUNNING);
    harness.worker.holdProcessDispatchForCheckpoint();

    // A queued entry that poisons the generation discards the rest of the
    // FIFO, the release included. The freeze must be told, or it waits for a
    // machine that no longer exists.
    let released: Promise<number[]> | undefined;
    harness.gate.runOrDeferVoidIngress("the read", () => {
      harness.gate.runOrDeferVoidIngress("a tick that fails", () => {
        throw new Error("kernel_vblank trapped");
      });
      released = harness.worker.releaseProcessDispatchForCheckpoint();
      return undefined;
    });

    await expect(released).rejects.toThrow(
      "void kernel ingress a tick that fails failed",
    );
  });
});

describe("kernel bucket copy", () => {
  it("reads the whole kernel memory and detaches it from the live backing", () => {
    const harness = createHarness(() => PROCESS_STATE_RUNNING);
    const live = new Uint8Array(harness.kernelMemory.buffer);
    live[64] = 0xab;

    const copy = harness.worker.copyKernelMemoryForCheckpoint();
    expect(copy.byteLength).toBe(harness.kernelMemory.buffer.byteLength);
    expect(copy[64]).toBe(0xab);

    live[64] = 0xcd;
    expect(copy[64]).toBe(0xab);
  });
});
