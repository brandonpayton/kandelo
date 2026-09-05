/**
 * One Kandelo machine, shaped for a replication test.
 *
 * The guest below reads the clock and nothing else, which is what makes it a
 * fair subject: randomness and external bytes are not routed through the log
 * yet, so a guest that read either would produce a log complete for its clock
 * and silent about the rest.
 */
import { expect } from "vitest";
import type { NodeKernelHost } from "../../src/node-kernel-host";
import type { MachineCheckpoint } from "../../src/migration/checkpoint";

const TIMEOUTS = { unwindTimeoutMs: 10_000, vforkTimeoutMs: 5_000 };

/** How many times the guest reads the clock. */
export const READS = 5;

/** Five `date` runs: five guest clock reads, no randomness, no external bytes. */
export const GUEST = [
  "sh",
  "-c",
  `i=0; while [ $i -lt ${READS} ]; do date +%s; i=$((i+1)); done`,
];

export const pause = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Take the machine once its last guest is gone.
 *
 * A guest's exit promise resolves before the kernel has finished reaping it,
 * and a freeze that arms a process which then leaves reports that rather than
 * capturing. Both waits below are for that same departure: `enumProcs` stops
 * naming the guest first, and the freeze stops finding it a moment later. The
 * refusal is transient by definition — it names a process that has just ended —
 * so it is retried, and every other refusal is reported.
 *
 * Hashing an idle machine is also what makes a comparison measure the replay:
 * a live process rewrites its own memory while it is being read.
 */
export async function captureWhenIdle(
  host: NodeKernelHost,
): Promise<MachineCheckpoint> {
  for (let attempt = 0; attempt < 200; attempt++) {
    // pid 1 is the machine's init, which is always listed and never leaves.
    if ((await host.enumProcs()).every((proc) => proc.pid <= 1)) break;
    await pause(25);
  }
  for (let attempt = 0; ; attempt++) {
    const response = await host.captureCheckpointBytes(TIMEOUTS);
    if (response.status === "captured") return response.checkpoint;
    const ending = response.status === "failed"
      && /ended during the checkpoint freeze/.test(response.reason);
    if (!ending || attempt >= 40) {
      throw new Error(`capture failed: ${JSON.stringify(response)}`);
    }
    await pause(25);
  }
}

export function collectStdout(): {
  onStdout: (pid: number, data: Uint8Array) => void;
  read: () => string;
} {
  let text = "";
  const decoder = new TextDecoder();
  return {
    onStdout: (_pid, data) => {
      text += decoder.decode(data);
    },
    read: () => text,
  };
}

/** The seconds a `date +%s` transcript printed, in order. */
export function printedSeconds(stdout: string): number[] {
  return stdout.trim().split("\n").map((line) => Number(line.trim()));
}

/** Run the clock-reading guest to completion. */
export async function runGuest(host: NodeKernelHost): Promise<void> {
  const { exit } = await host.spawnFromVfs("/bin/sh", GUEST);
  await expect(exit).resolves.toBe(0);
}
