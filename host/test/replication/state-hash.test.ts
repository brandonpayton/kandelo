import { describe, expect, it } from "vitest";
import {
  MACHINE_STATE_HASH_FORMAT,
  compareMachineStateHashes,
  hashMachineCheckpoint,
} from "../../src/replication/state-hash";
import {
  MACHINE_CHECKPOINT_FORMAT,
  type CheckpointMount,
  type MachineCheckpoint,
  type CheckpointProcessBucket,
} from "../../src/migration/checkpoint";

function bucket(pid: number, fill: number): CheckpointProcessBucket {
  return {
    pid,
    executionGeneration: 1,
    ptrWidth: 4,
    channelOffset: 0,
    layout: { stackTop: 0, heapBase: 0, channelBase: 0 } as never,
    argv: ["foo"],
    memory: new Uint8Array(64).fill(fill),
    programBytes: new ArrayBuffer(0),
    threadAllocator: {} as never,
    threads: [],
  };
}

function mount(mountPoint: string, fill: number): CheckpointMount {
  return { mountPoint, bytes: new Uint8Array(256).fill(fill) };
}

function machine(
  overrides: Partial<MachineCheckpoint> = {},
): MachineCheckpoint {
  return {
    format: MACHINE_CHECKPOINT_FORMAT,
    kernelAbiVersion: 45,
    kernelMemory: new Uint8Array(128).fill(1),
    filesystems: [mount("/", 2), mount("/home/maker", 3)],
    unreadableFilesystems: [],
    framebuffers: [],
    kms: { fbs: [], crtcs: [], masterPid: null, buffers: [] },
    monotonicNs: 0,
    processes: [bucket(41, 3)],
    ...overrides,
  };
}

describe("machine state hash", () => {
  it("names every region and binds the digest to a log position", async () => {
    const hash = await hashMachineCheckpoint(machine(), 7);

    expect(hash.format).toBe(MACHINE_STATE_HASH_FORMAT);
    expect(hash.seq).toBe(7);
    expect(hash.regions.map((region) => region.region)).toEqual([
      "kernel",
      "filesystem:/",
      "filesystem:/home/maker",
      "process:41",
    ]);
    expect(hash.regions[0]).toMatchObject({ bytes: 128 });
    expect(hash.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("orders processes by pid, so two hosts produce comparable lists", async () => {
    const ascending = await hashMachineCheckpoint(
      machine({ processes: [bucket(7, 3), bucket(41, 4)] }),
      0,
    );
    const descending = await hashMachineCheckpoint(
      machine({ processes: [bucket(41, 4), bucket(7, 3)] }),
      0,
    );

    expect(ascending.sha256).toBe(descending.sha256);
    expect(ascending.regions.map((region) => region.region)).toEqual([
      "kernel",
      "filesystem:/",
      "filesystem:/home/maker",
      "process:7",
      "process:41",
    ]);
  });

  it("refuses a position that is not a log position", async () => {
    await expect(hashMachineCheckpoint(machine(), -1)).rejects.toThrow(
      "a machine state hash names a non-negative log position",
    );
  });
});

describe("machine divergence report", () => {
  it("reports agreement without listing regions", async () => {
    const report = compareMachineStateHashes(
      await hashMachineCheckpoint(machine(), 12),
      await hashMachineCheckpoint(machine(), 12),
    );

    expect(report.diverged).toBe(false);
    expect(report.regions).toEqual([]);
    expect(report.summary).toBe("the two machines agree at log position 12");
  });

  it("names only the region that differs", async () => {
    const report = compareMachineStateHashes(
      await hashMachineCheckpoint(machine(), 12),
      await hashMachineCheckpoint(
        machine({ processes: [bucket(41, 9)] }),
        12,
      ),
    );

    expect(report.diverged).toBe(true);
    expect(report.regions.map((region) => region.region))
      .toEqual(["process:41"]);
    expect(report.summary).toContain("log position 12");
    expect(report.summary).toContain("process:41");
  });

  it("names the mount whose files differ, not the machine's files", async () => {
    const report = compareMachineStateHashes(
      await hashMachineCheckpoint(machine(), 5),
      await hashMachineCheckpoint(
        machine({ filesystems: [mount("/", 2), mount("/home/maker", 9)] }),
        5,
      ),
    );

    expect(report.diverged).toBe(true);
    expect(report.regions.map((region) => region.region))
      .toEqual(["filesystem:/home/maker"]);
  });

  it("treats a region present on one side only as divergence", async () => {
    const report = compareMachineStateHashes(
      await hashMachineCheckpoint(machine(), 0),
      await hashMachineCheckpoint(machine({ processes: [] }), 0),
    );

    expect(report.diverged).toBe(true);
    expect(report.regions).toEqual([
      {
        region: "process:41",
        primary: expect.objectContaining({ region: "process:41" }),
        replica: null,
      },
    ]);
    expect(report.summary).toContain("against absent");
  });

  it("refuses two machines hashed at different positions", async () => {
    const primary = await hashMachineCheckpoint(machine(), 3);
    const replica = await hashMachineCheckpoint(machine(), 4);

    expect(() => compareMachineStateHashes(primary, replica)).toThrow(
      "two machines hashed at different log positions cannot be compared: "
        + "3 and 4",
    );
  });

  it("refuses a digest layout it does not know", async () => {
    const primary = await hashMachineCheckpoint(machine(), 0);
    const stale = { ...primary, format: 0 as never };

    expect(() => compareMachineStateHashes(primary, stale)).toThrow(
      "a machine state hash comparison needs format",
    );
  });
});
