import { describe, expect, it } from "vitest";
import {
  CheckpointFreezeGateCoordinator,
  createCheckpointFreezeGate,
  resumeCheckpointFreezeGate,
  waitForCheckpointFreezeResume,
} from "../src/checkpoint-freeze-gate";

const stateOf = (gate: SharedArrayBuffer): number =>
  Atomics.load(new Int32Array(gate), 0);

describe("checkpoint freeze gate", () => {
  it("resumes a parked process exactly once", () => {
    const gate = createCheckpointFreezeGate();
    expect(stateOf(gate)).toBe(0);
    resumeCheckpointFreezeGate(gate);
    expect(stateOf(gate)).toBe(1);
    expect(() => resumeCheckpointFreezeGate(gate)).toThrow(/no longer pending/);
  });

  it("rejects a buffer that is not one shared i32", () => {
    expect(() => resumeCheckpointFreezeGate(new SharedArrayBuffer(8))).toThrow(
      /one shared i32/,
    );
    expect(() =>
      waitForCheckpointFreezeResume(
        new ArrayBuffer(4) as unknown as SharedArrayBuffer,
        "pid=1",
      )
    ).toThrow(/one shared i32/);
  });

  it("clears the resume so the same gate serves the next freeze", () => {
    const gate = createCheckpointFreezeGate();
    resumeCheckpointFreezeGate(gate);
    expect(() => waitForCheckpointFreezeResume(gate, "pid=1")).not.toThrow();
    expect(stateOf(gate)).toBe(0);
    expect(() => resumeCheckpointFreezeGate(gate)).not.toThrow();
  });

  it("rejects an out-of-range gate state", () => {
    const gate = createCheckpointFreezeGate();
    Atomics.store(new Int32Array(gate), 0, 42);
    expect(() => waitForCheckpointFreezeResume(gate, "pid=3")).toThrow(
      "pid=3: invalid checkpoint freeze gate state 42",
    );
  });

  it("keeps the gate closed across the unwound report, then reopens it", async () => {
    const coordinator = new CheckpointFreezeGateCoordinator("pid=11");
    expect(coordinator.currentPhase).toBe("idle");

    coordinator.arm();
    coordinator.unwound();
    coordinator.unwound();
    await expect(coordinator.waitUntilUnwound()).resolves.toBeUndefined();
    expect(coordinator.currentPhase).toBe("unwound");
    expect(stateOf(coordinator.gate)).toBe(0);

    coordinator.resume();
    expect(coordinator.currentPhase).toBe("resumed");
    expect(stateOf(coordinator.gate)).toBe(1);
  });

  it("arms again once the guest has cleared the previous resume", () => {
    const coordinator = new CheckpointFreezeGateCoordinator("pid=15");
    coordinator.arm();
    coordinator.unwound();
    coordinator.resume();

    expect(() => coordinator.arm()).toThrow("left at state 1");
    waitForCheckpointFreezeResume(coordinator.gate, "pid=15");
    expect(() => coordinator.arm()).not.toThrow();
    expect(coordinator.currentPhase).toBe("armed");
  });

  it("refuses a second freeze while one is in flight", () => {
    const coordinator = new CheckpointFreezeGateCoordinator("pid=16");
    coordinator.arm();
    expect(() => coordinator.arm()).toThrow(
      "pid=16: a checkpoint freeze is already armed",
    );
    coordinator.unwound();
    expect(() => coordinator.arm()).toThrow(
      "pid=16: a checkpoint freeze is already unwound",
    );
  });

  it("refuses to resume a process that has not reported unwinding", () => {
    const coordinator = new CheckpointFreezeGateCoordinator("pid=12");
    coordinator.arm();
    expect(() => coordinator.resume()).toThrow(
      "pid=12: cannot resume a checkpoint freeze while armed",
    );
  });

  it("has nothing to wait on before a freeze is armed", () => {
    const coordinator = new CheckpointFreezeGateCoordinator("pid=17");
    expect(() => coordinator.waitUntilUnwound()).toThrow(
      "pid=17: no checkpoint freeze is armed",
    );
  });

  it("abandons an armed freeze and rewinds the process that reports late", async () => {
    const coordinator = new CheckpointFreezeGateCoordinator("pid=18");
    coordinator.arm();
    const waiter = coordinator.waitUntilUnwound();
    coordinator.abandon("the freeze timed out");
    coordinator.abandon("a second reason");

    expect(coordinator.currentPhase).toBe("abandoned");
    await expect(waiter).rejects.toThrow("pid=18: the freeze timed out");

    // The request word was already published, so this unwind still happens.
    coordinator.unwound();
    expect(stateOf(coordinator.gate)).toBe(1);
  });

  it("abandoning after the unwind report rewinds the parked process", () => {
    const coordinator = new CheckpointFreezeGateCoordinator("pid=19");
    coordinator.arm();
    coordinator.unwound();
    coordinator.abandon();
    expect(stateOf(coordinator.gate)).toBe(1);
  });

  it("gives each thread its own gate", () => {
    const coordinator = new CheckpointFreezeGateCoordinator("pid=20");
    const first = coordinator.registerThread(2);
    const second = coordinator.registerThread(3);

    expect(first).not.toBe(second);
    expect(first).not.toBe(coordinator.gate);
    expect(() => coordinator.registerThread(2)).toThrow(
      "pid=20: tid=2 already has a freeze gate",
    );
  });

  it("stays armed until every thread has reported", async () => {
    const coordinator = new CheckpointFreezeGateCoordinator("pid=21");
    coordinator.registerThread(2);
    coordinator.registerThread(3);
    coordinator.arm();
    let settled = false;
    void coordinator.waitUntilUnwound().then(() => { settled = true; });

    coordinator.unwound();
    coordinator.unwound(2);
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(coordinator.currentPhase).toBe("armed");

    coordinator.unwound(3);
    await coordinator.waitUntilUnwound();
    expect(coordinator.currentPhase).toBe("unwound");
  });

  it("resumes every parked thread, not only the first", () => {
    const coordinator = new CheckpointFreezeGateCoordinator("pid=22");
    const thread = coordinator.registerThread(2);
    coordinator.arm();
    coordinator.unwound();
    coordinator.unwound(2);
    coordinator.resume();

    expect(stateOf(coordinator.gate)).toBe(1);
    expect(stateOf(thread)).toBe(1);
  });

  it("counts a repeated report from one thread only once", async () => {
    const coordinator = new CheckpointFreezeGateCoordinator("pid=23");
    coordinator.registerThread(2);
    coordinator.arm();
    coordinator.unwound(2);
    coordinator.unwound(2);
    let settled = false;
    void coordinator.waitUntilUnwound().then(() => { settled = true; });
    await Promise.resolve();

    expect(settled).toBe(false);
    coordinator.unwound();
    await coordinator.waitUntilUnwound();
    expect(coordinator.currentPhase).toBe("unwound");
  });

  it("fails a freeze that is still waiting on a thread that exits", async () => {
    const coordinator = new CheckpointFreezeGateCoordinator("pid=24");
    coordinator.registerThread(2);
    coordinator.arm();
    const waiter = coordinator.waitUntilUnwound();
    coordinator.unwound();
    coordinator.unregisterThread(2);

    await expect(waiter).rejects.toThrow(
      "pid=24: tid=2 ended during the checkpoint freeze",
    );
    expect(coordinator.currentPhase).toBe("abandoned");
  });

  it("fails a freeze when a thread that already parked exits", () => {
    const coordinator = new CheckpointFreezeGateCoordinator("pid=26");
    coordinator.registerThread(2);
    coordinator.arm();
    coordinator.unwound();
    coordinator.unwound(2);
    expect(coordinator.currentPhase).toBe("unwound");

    coordinator.unregisterThread(2);
    expect(coordinator.currentPhase).toBe("abandoned");
    expect(coordinator.abandonReason?.message).toBe(
      "pid=26: tid=2 ended during the checkpoint freeze",
    );
    // The thread that stayed alive is rewound rather than left parked.
    expect(stateOf(coordinator.gate)).toBe(1);
  });

  it("lets a thread exit outside a freeze without spoiling the next one", () => {
    const coordinator = new CheckpointFreezeGateCoordinator("pid=27");
    const second = coordinator.registerThread(2);
    const third = coordinator.registerThread(3);
    coordinator.arm();
    coordinator.unwound();
    coordinator.unwound(2);
    coordinator.unwound(3);
    coordinator.resume();
    for (const gate of [coordinator.gate, second, third]) {
      waitForCheckpointFreezeResume(gate, "pid=27");
    }

    coordinator.unregisterThread(3);
    expect(coordinator.currentPhase).toBe("resumed");
    coordinator.arm();
    expect(coordinator.currentPhase).toBe("armed");
    expect(coordinator.abandonReason).toBeNull();
  });

  it("abandoning rewinds every parked thread", () => {
    const coordinator = new CheckpointFreezeGateCoordinator("pid=25");
    const thread = coordinator.registerThread(2);
    coordinator.arm();
    coordinator.unwound(2);
    coordinator.abandon();

    expect(stateOf(thread)).toBe(1);
    // The main thread never parked, so its late report self-rewinds.
    coordinator.unwound();
    expect(stateOf(coordinator.gate)).toBe(1);
  });

});
