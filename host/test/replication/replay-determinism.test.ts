/**
 * Replay determinism, measured on a real machine before anything trusts it.
 *
 * Replication's whole claim is that a replica which adopts a checkpoint and
 * consumes the same decisions runs the same machine. These tests are the
 * instrument for that claim, and they exist before the log has a network wire
 * on purpose: the first job is to measure how far from deterministic the
 * machine already is, not to assume it.
 *
 * The subject is the guest clock, because it is the only pulled decision the
 * log carries today. A guest that also read randomness or external bytes would
 * produce a log that is complete for its clock and silent about the rest, so
 * these tests use a guest that reads neither.
 *
 * The design is `docs/plans/2026-08-23-state-machine-replication-design.md`
 * § "Core model" and § "Divergence detection and resync", implementation-path
 * steps 7 and 9.
 */
import { describe, expect, it } from "vitest";
import { NodeKernelHost } from "../../src/node-kernel-host";
import type { MachineCheckpoint } from "../../src/migration/checkpoint";
import type { ReplicationLogEntry } from "../../src/replication/log";
import {
  compareMachineStateHashes,
  hashMachineCheckpoint,
} from "../support/state-hash";
import {
  GUEST,
  READS,
  captureWhenIdle,
  collectStdout,
  printedSeconds,
} from "../support/replication-machine";

/** The seconds a log holds, in the order a replica takes them. */
function loggedSeconds(log: readonly ReplicationLogEntry[]): number[] {
  return log.map((entry) =>
    entry.decision.kind === "clock" ? entry.decision.sec : -1
  );
}

/**
 * Whether the guest's readings are the log's readings, taken in log order.
 *
 * The log holds every clock read the machine made, not only the guest's: the
 * filesystem stamps inode times from the same provider, so its reads are
 * interleaved with `date`'s. A guest transcript is therefore a subsequence of
 * the logged seconds rather than the whole of it.
 */
function isSubsequence(inner: number[], outer: number[]): boolean {
  let at = 0;
  for (const value of outer) {
    if (at < inner.length && inner[at] === value) at++;
  }
  return at === inner.length;
}

/** Boot a fresh machine, take its state, then record one guest run. */
async function record(): Promise<{
  checkpoint: MachineCheckpoint;
  log: ReplicationLogEntry[];
  stdout: string;
}> {
  const stdout = collectStdout();
  const keeper = new NodeKernelHost({
    rootfsImage: "default",
    onStdout: stdout.onStdout,
  });
  await keeper.init();
  try {
    // An idle machine is the honest subject: a running process rewrites its own
    // memory, so a later mismatch would measure the guest's progress rather
    // than the replay.
    const checkpoint = await captureWhenIdle(keeper);
    expect(checkpoint.processes).toEqual([]);
    await keeper.startReplicationRecording();
    const { exit } = await keeper.spawnFromVfs("/bin/sh", GUEST);
    await expect(exit).resolves.toBe(0);
    return {
      checkpoint,
      log: await keeper.stopReplicationRecording(),
      stdout: stdout.read(),
    };
  } finally {
    await keeper.destroy();
  }
}

/**
 * Adopt the checkpoint, run the guest, take state.
 *
 * With `log`, the guest clock comes from the log. Without it, the replica
 * reads its own clock — which is how a test tells a divergence the log removes
 * from one it does not. `state` is taken only when a caller asks for it: a
 * capture is expensive, and the log-sourced-clock test needs the transcript
 * rather than the bytes.
 */
async function replay(
  checkpoint: MachineCheckpoint,
  log: readonly ReplicationLogEntry[] | null,
  options: { state?: true } = {},
): Promise<{
  stdout: string;
  state: MachineCheckpoint | null;
  consumed: number;
  total: number;
}> {
  const stdout = collectStdout();
  const replica = new NodeKernelHost({
    rootfsImage: "default",
    restoreCheckpoint: checkpoint,
    onStdout: stdout.onStdout,
  });
  await replica.init();
  try {
    if (log) await replica.startReplicationReplay(log);
    const { exit } = await replica.spawnFromVfs("/bin/sh", GUEST);
    await expect(exit).resolves.toBe(0);
    const progress = log
      ? await replica.stopReplicationReplay()
      : { consumed: 0, total: 0 };
    return {
      stdout: stdout.read(),
      state: options.state ? await captureWhenIdle(replica) : null,
      ...progress,
    };
  } finally {
    await replica.destroy();
  }
}

/**
 * The kernel's `__stack_pointer` origin, from the kernel Wasm's `global[0]`.
 *
 * The module is linked stack-first, so `[0, KERNEL_STACK_TOP)` is call-stack
 * scratch and the data segment and heap follow it. A byte that differs below
 * this line is residue from a call that has already returned; a byte that
 * differs above it is machine state.
 */
const KERNEL_STACK_TOP = 0x100000;

/** Every offset at which two kernel memories hold a different byte. */
function differingOffsets(left: Uint8Array, right: Uint8Array): number[] {
  const offsets: number[] = [];
  const length = Math.min(left.length, right.length);
  for (let at = 0; at < length; at++) {
    if (left[at] !== right[at]) offsets.push(at);
  }
  return offsets;
}

/** The regions two machines at the same log position do not agree on. */
async function divergedRegions(
  left: MachineCheckpoint,
  right: MachineCheckpoint,
  position: number,
): Promise<string[]> {
  const report = compareMachineStateHashes(
    await hashMachineCheckpoint(left, position),
    await hashMachineCheckpoint(right, position),
  );
  return report.regions.map((region) => region.region).sort();
}

describe("replay determinism", () => {
  it(
    "gives a replica the recorded clock instead of its own",
    { timeout: 180_000 },
    async () => {
      const recorded = await record();
      // The machine's clock reads are the guest's `date` calls plus the
      // filesystem's inode stamps, which cross the same provider.
      expect(recorded.log.length).toBeGreaterThanOrEqual(READS);
      expect(recorded.log.every((e) => e.decision.kind === "clock")).toBe(true);

      // The replica reads a clock that has moved on. Without the log it would
      // print later seconds, so matching the recording cannot be a coincidence
      // of two runs landing in the same second.
      await new Promise((resolve) => setTimeout(resolve, 2_000));

      const replayed = await replay(recorded.checkpoint, recorded.log);
      // The replica asked for exactly the readings the recording made. A
      // shortfall or an overrun would mean the two runs took different paths.
      expect(replayed.consumed).toBe(recorded.log.length);
      expect(replayed.total).toBe(recorded.log.length);
      expect(printedSeconds(replayed.stdout))
        .toEqual(printedSeconds(recorded.stdout));

      // And the values came from the log, not from a clock that happened to
      // agree: the guest's transcript is the log's readings, in log order.
      expect(
        isSubsequence(
          printedSeconds(replayed.stdout),
          loggedSeconds(recorded.log),
        ),
      ).toBe(true);
    },
  );

  it(
    "reproduces what two replicas of one log print, and names what still differs",
    { timeout: 600_000 },
    async () => {
      // Replicas must agree with each other at the same log position. They do
      // not yet, and this is the measurement of how far off they are. The
      // comparison is replica against replica, not replica against the machine
      // the checkpoint came from: completing a restore makes kernel calls of
      // its own, so the two are never equal. See
      // `migration/restore-fidelity.test.ts`.
      const recorded = await record();

      // Each restore consumes its checkpoint, so each replica gets its own.
      const clone = (): MachineCheckpoint =>
        structuredClone(recorded.checkpoint);
      const replica = await replay(clone(), recorded.log, { state: true });
      const other = await replay(clone(), recorded.log, { state: true });

      // What the machine did is reproduced: both replicas take the whole log
      // and print the recorded transcript.
      expect(replica.consumed).toBe(recorded.log.length);
      expect(other.consumed).toBe(recorded.log.length);
      expect(printedSeconds(replica.stdout))
        .toEqual(printedSeconds(recorded.stdout));
      expect(printedSeconds(other.stdout))
        .toEqual(printedSeconds(recorded.stdout));

      // What the machine holds is reproduced too, everywhere it is state.
      // Every filesystem matches: inode atime, mtime and ctime cross the
      // machine's `TimeProvider`, so both replicas stamp the recorded
      // milliseconds.
      const position = recorded.log.length;
      const replayedApart = await divergedRegions(
        replica.state!,
        other.state!,
        position,
      );
      expect(replayedApart.filter((region) => region !== "kernel")).toEqual([]);

      // And `kernel` differs only where it is not state. Twelve of thirteen
      // measured pairs held all 14 MB byte for byte; the one that did not
      // differed by three bytes at 0xffffc, four below the stack top, which is
      // scratch from a call that had already returned. Bounding the difference
      // by the stack line says that without asserting a byte count that a
      // scheduling accident can move.
      expect(
        differingOffsets(replica.state!.kernelMemory, other.state!.kernelMemory)
          .filter((at) => at >= KERNEL_STACK_TOP),
      ).toEqual([]);

      // A replica on its own clock diverges in the filesystem again, which is
      // what says the log — not luck — is why the pair above agrees on it.
      const live = await replay(clone(), null, { state: true });
      const otherLive = await replay(clone(), null, { state: true });
      expect(await divergedRegions(live.state!, otherLive.state!, position))
        .toContain("filesystem:/");
    },
  );

  it(
    "refuses to record a machine with no swappable guest clock",
    { timeout: 120_000 },
    async () => {
      // A machine booted without a rootfs image runs on `NodePlatformIO`, whose
      // clock replication cannot swap. Handing back an empty log there would
      // read as "this machine made no decisions", which is the convenient
      // illusion the platform contract forbids.
      const host = new NodeKernelHost({});
      await host.init();
      try {
        await expect(host.startReplicationRecording()).rejects.toThrow(
          /no swappable guest clock/,
        );
      } finally {
        await host.destroy();
      }
    },
  );
});
