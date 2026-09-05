/**
 * The decision log on shared memory.
 *
 * The claim these tests hold is the one the live join rests on: a replica that
 * has caught up with the primary stops, and starts again on the primary's next
 * decision. Everything else here exists to make that claim safe — a congested
 * ring must delay rather than drop, an ended recording must wake a parked
 * replica rather than leave it there, and the bytes a device delivered must
 * arrive as those bytes.
 *
 * The design is `docs/plans/2026-08-23-state-machine-replication-design.md`
 * § "How a replica joins a GL machine".
 */
import { describe, expect, it } from "vitest";
import { Worker } from "node:worker_threads";
import {
  ReplicationLogQueueReader,
  ReplicationLogQueueWriter,
  createReplicationLogQueue,
} from "../../src/replication/log-queue";
import type { ReplicationLogEntry } from "../../src/replication/log";

function clockAt(seq: number): ReplicationLogEntry {
  return {
    seq,
    decision: { kind: "clock", pid: 102, clockId: 0, sec: 1_700_000 + seq, nsec: seq },
  };
}

type ReaderReport = {
  taken: (ReplicationLogEntry | null)[];
  waitedMs: number;
};

/** Run a reader off this thread, because the reader under test blocks. */
function readerWorker(
  queue: SharedArrayBuffer,
  count: number,
): { parked: Promise<void>; done: Promise<ReaderReport> } {
  const worker = new Worker(
    new URL("../fixtures/replication-log-queue-worker.ts", import.meta.url),
    { execArgv: ["--import", "tsx"], workerData: { queue, count } },
  );
  let announceParked!: () => void;
  const parked = new Promise<void>((resolve) => void (announceParked = resolve));
  const done = new Promise<ReaderReport>((resolve, reject) => {
    worker.on("message", (message: { kind: string } & ReaderReport) => {
      if (message.kind === "parked") announceParked();
      else resolve(message);
    });
    worker.once("error", reject);
    worker.once("exit", (code) => {
      if (code !== 0) reject(new Error(`queue reader worker exited ${code}`));
    });
  });
  return { parked, done };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("replication log queue", () => {
  it("carries every decision in order, bytes included", () => {
    const queue = createReplicationLogQueue(64 * 1024);
    const writer = new ReplicationLogQueueWriter(queue);
    const reader = new ReplicationLogQueueReader(queue);
    const typed: ReplicationLogEntry = {
      seq: 1,
      decision: {
        kind: "input",
        device: "/dev/tty0",
        bytes: new Uint8Array([0x6c, 0x73, 0x0a]),
      },
    };
    writer.push([clockAt(0), typed, clockAt(2)]);

    expect(reader.take()).toEqual(clockAt(0));
    // A device's bytes are the guest's bytes. A codec that turned them into a
    // JSON object here would replay a keystroke the primary never delivered.
    expect(reader.take()).toEqual(typed);
    expect(reader.take()).toEqual(clockAt(2));
  });

  // The drain that runs between guest requests must never park the kernel
  // worker: waiting for the primary belongs to the guest's own clock reads.
  it("hands over what is ready without waiting for more", () => {
    const queue = createReplicationLogQueue(64 * 1024);
    const writer = new ReplicationLogQueueWriter(queue);
    const reader = new ReplicationLogQueueReader(queue);

    expect(reader.takeReady()).toBeNull();
    writer.push([clockAt(0), clockAt(1)]);
    expect(reader.takeReady()).toEqual(clockAt(0));
    expect(reader.takeReady()).toEqual(clockAt(1));
    // An empty ring is "nothing now", even after the recording ended: the end
    // belongs to take(), where a parked replica is waiting to hear it.
    writer.end();
    expect(reader.takeReady()).toBeNull();
    expect(reader.take()).toBeNull();
  });

  it("gives a bounded wait back its time, and the meanings take() has", () => {
    const queue = createReplicationLogQueue(64 * 1024);
    const writer = new ReplicationLogQueueWriter(queue);
    const reader = new ReplicationLogQueueReader(queue);

    // The bound is what keeps one starved process from parking the machine:
    // an empty ring answers "timedout" once the budget elapses.
    const before = Date.now();
    expect(reader.takeWithin(50)).toBe("timedout");
    expect(Date.now() - before).toBeGreaterThanOrEqual(50);

    writer.push([clockAt(0)]);
    expect(reader.takeWithin(50)).toEqual(clockAt(0));
    writer.end();
    expect(reader.takeWithin(50)).toBeNull();
  });

  it("holds a replica that caught up until the primary records again", async () => {
    const queue = createReplicationLogQueue(64 * 1024);
    const writer = new ReplicationLogQueueWriter(queue);
    const reading = readerWorker(queue, 1);
    // The replica is parked in take() before this line returns. Nothing it
    // could read exists yet, and the only alternatives to waiting are
    // inventing a reading or reusing the last one — both of which make it a
    // different machine.
    await reading.parked;
    await sleep(100);
    writer.push([clockAt(0)]);

    const report = await reading.done;
    expect(report.taken).toEqual([clockAt(0)]);
    expect(report.waitedMs).toBeGreaterThanOrEqual(100);
  });

  it("wakes a parked replica when the recording ends", async () => {
    const queue = createReplicationLogQueue(64 * 1024);
    const writer = new ReplicationLogQueueWriter(queue);
    const reading = readerWorker(queue, 1);
    await reading.parked;
    // A machine that stopped recording will not continue. A replica told
    // nothing would stay parked for as long as its tab is open.
    writer.end();

    expect((await reading.done).taken).toEqual([null]);
  });

  it("delivers what a full ring could not take, once it drains", () => {
    // Small enough that the third entry has nowhere to go.
    const queue = createReplicationLogQueue(256);
    const writer = new ReplicationLogQueueWriter(queue);
    const reader = new ReplicationLogQueueReader(queue);
    const recorded = [0, 1, 2, 3, 4, 5].map(clockAt);
    writer.push(recorded);
    expect(writer.pending).toBeGreaterThan(0);

    // A mirror drops a frame when the wire backs up. A decision dropped here
    // is a replica that stopped being the same machine, so the writer holds it
    // and the ring takes it as the reader makes room.
    const taken: (ReplicationLogEntry | null)[] = [];
    for (let at = 0; at < recorded.length; at++) {
      if (writer.pending > 0) writer.push([]);
      taken.push(reader.take());
    }

    expect(taken).toEqual(recorded);
    expect(writer.pending).toBe(0);
  });

  it("stops polling for room once the recording has ended", async () => {
    const queue = createReplicationLogQueue(256);
    const writer = new ReplicationLogQueueWriter(queue);
    const reader = new ReplicationLogQueueReader(queue);
    writer.push([0, 1, 2, 3, 4, 5].map(clockAt));
    const stranded = writer.pending;
    expect(stranded).toBeGreaterThan(0);
    writer.end();

    // Room appears, and a writer still polling for it would take it. A replica
    // that had not drained the ring before the recording ended is not
    // following any more, and polling for it would run for as long as the page
    // is open.
    reader.take();
    reader.take();
    await sleep(50);

    expect(writer.pending).toBe(stranded);
  });

  it("refuses a decision no ring of this size could carry", () => {
    const queue = createReplicationLogQueue(64);
    const writer = new ReplicationLogQueueWriter(queue);

    expect(() =>
      writer.push([
        {
          seq: 0,
          decision: {
            kind: "input",
            device: "/dev/tty0",
            bytes: new Uint8Array(256),
          },
        },
      ]),
    ).toThrow(/does not fit a queue of 64/);
  });
});
