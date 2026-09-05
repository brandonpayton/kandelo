/**
 * Restore fidelity, measured region by region.
 *
 * A restore that silently drops part of a machine still boots, still runs, and
 * still looks fine — which is what makes it expensive to find later. These
 * tests are the first consumer of `hashMachineCheckpoint` and
 * `compareMachineStateHashes`: they turn "the same machine" into a claim that
 * fails with the name of the region that broke it.
 *
 * Two properties are pinned here. Capture is idempotent, so a hash measures the
 * machine rather than the act of reading it. And two replicas restored from one
 * checkpoint agree in every region, which is the property replication needs:
 * replicas must match each other, at the same log position.
 *
 * Not asserted, deliberately: that a restored machine equals the machine it was
 * captured from. It does not, and the difference is understood — kernel memory
 * is adopted whole before any kernel call runs
 * (`CentralizedKernelWorker#adoptKernelMemoryImage`), but completing the
 * restore then makes kernel calls of its own, which grow the kernel heap and
 * move its bookkeeping. Both replicas make the same calls, so they stay equal
 * to each other. Whether the restore path should leave the kernel region
 * untouched is open, and it is a separate question from replica agreement.
 *
 * The design is `docs/plans/2026-08-23-state-machine-replication-design.md`
 * § "Divergence detection and resync".
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NodeKernelHost } from "../../src/node-kernel-host";
import { findRepoRoot } from "../../src/binary-resolver";
import type { MachineCheckpoint } from "../../src/migration/checkpoint";
import {
  compareMachineStateHashes,
  hashMachineCheckpoint,
} from "../support/state-hash";

const TIMEOUTS = { unwindTimeoutMs: 10_000, vforkTimeoutMs: 5_000 };

/** The log position both sides are hashed at: neither has consumed an entry. */
const AT_RESTORE = 0;

async function capture(host: NodeKernelHost): Promise<MachineCheckpoint> {
  const response = await host.captureCheckpointBytes(TIMEOUTS);
  if (response.status !== "captured") {
    throw new Error(`capture failed: ${JSON.stringify(response)}`);
  }
  return response.checkpoint;
}

async function restoreAndCapture(
  checkpoint: MachineCheckpoint,
): Promise<MachineCheckpoint> {
  const host = new NodeKernelHost({
    rootfsImage: "default",
    restoreCheckpoint: checkpoint,
  });
  await host.init();
  try {
    return await capture(host);
  } finally {
    await host.destroy();
  }
}

describe("restore fidelity", () => {
  it(
    "hashes one machine the same way twice",
    { timeout: 120_000 },
    async () => {
      // A capture that perturbed the machine would make every later comparison
      // report divergence that the reader cannot act on. This is the baseline
      // the other test depends on.
      const host = new NodeKernelHost({ rootfsImage: "default" });
      await host.init();
      let first: MachineCheckpoint;
      let second: MachineCheckpoint;
      try {
        first = await capture(host);
        second = await capture(host);
      } finally {
        await host.destroy();
      }

      const report = compareMachineStateHashes(
        await hashMachineCheckpoint(first, AT_RESTORE),
        await hashMachineCheckpoint(second, AT_RESTORE),
      );
      expect(report.diverged, report.summary).toBe(false);
      expect(report.regions).toEqual([]);
    },
  );

  it(
    "restores two replicas from one checkpoint that agree region for region",
    { timeout: 180_000 },
    async () => {
      const keeper = new NodeKernelHost({ rootfsImage: "default" });
      await keeper.init();
      let source: MachineCheckpoint;
      try {
        source = await capture(keeper);
      } finally {
        await keeper.destroy();
      }
      // An idle machine is the honest subject: a running process rewrites its
      // own memory, so a mismatch there would measure the guest's progress
      // rather than the restore.
      expect(source.processes).toEqual([]);

      // Each restore consumes its checkpoint, so each replica gets its own.
      const replica = await restoreAndCapture(structuredClone(source));
      const other = await restoreAndCapture(structuredClone(source));

      const report = compareMachineStateHashes(
        await hashMachineCheckpoint(replica, AT_RESTORE),
        await hashMachineCheckpoint(other, AT_RESTORE),
      );
      expect(report.diverged, report.summary).toBe(false);
      expect(report.regions).toEqual([]);
    },
  );

  it(
    "runs a program the captured machine had never run",
    { timeout: 180_000 },
    async () => {
      // Every other restore test relaunches a process the capture had already
      // started, so all of them would still pass if a restored machine could
      // only continue what it arrived with. This one asks the restored machine
      // for something new.
      //
      // The program is installed on the keeper and never run there, so it is
      // not in the rootfs image both hosts load. A restore that quietly fell
      // back to that image would boot, would run, and would fail here with
      // ENOENT rather than looking correct.
      const newcomer = new Uint8Array(
        readFileSync(join(findRepoRoot(), "examples/hello.wasm")),
      );
      const keeper = new NodeKernelHost({ rootfsImage: "default" });
      await keeper.init();
      let source: MachineCheckpoint;
      try {
        await keeper.writeFileToVfs("/bin/newcomer", newcomer);
        source = await capture(keeper);
        expect(source.processes).toEqual([]);
      } finally {
        await keeper.destroy();
      }

      let stdout = "";
      const replica = new NodeKernelHost({
        rootfsImage: "default",
        restoreCheckpoint: source,
        onStdout: (_pid, data) => {
          stdout += new TextDecoder().decode(data);
        },
      });
      await replica.init();
      try {
        const { pid, exit } = await replica.spawnFromVfs(
          "/bin/newcomer",
          ["newcomer"],
        );
        expect(pid).toBeGreaterThan(0);
        await expect(exit).resolves.toBe(0);
        expect(stdout).toContain("Hello");
      } finally {
        await replica.destroy();
      }
    },
  );
});
