import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ReplicationDivergence,
  ReplicationLogReader,
  ReplicationLogRecorder,
  ptsDeviceIndex,
  ptsDevicePath,
  type ReplicationLogEntry,
  type ReplicationPushedDecision,
} from "../../src/replication/log";

// One process reads unless a test says otherwise: the log now names the
// reader of every reading, and a single-process machine is the simple case.
const reading = (clockId: number, sec: number, nsec: number, pid = 1) =>
  ({ kind: "clock", pid, clockId, sec, nsec }) as const;

const input = (device: string, ...bytes: number[]) =>
  ({ kind: "input", device, bytes: new Uint8Array(bytes) }) as const;

const pointer = (dx: number, dy: number, buttons: number) =>
  ({ kind: "pointer", dx, dy, buttons }) as const;

const resize = (device: string, rows: number, cols: number) =>
  ({ kind: "resize", device, rows, cols }) as const;

const glAnswer = (op: number, rc: number, ...bytes: number[]) =>
  ({ kind: "gl", op, rc, bytes: new Uint8Array(bytes) }) as const;

const accepted = (listener: number, pid: number) =>
  ({ kind: "accept", listener, pid }) as const;

describe("replication log recorder", () => {
  it("numbers decisions from the position it was given", () => {
    const recorder = new ReplicationLogRecorder(41);
    expect(recorder.nextSeq).toBe(41);
    expect(recorder.record(reading(1, 7, 0)).seq).toBe(41);
    expect(recorder.record(reading(0, 8, 0)).seq).toBe(42);
    expect(recorder.nextSeq).toBe(43);
  });

  it("starts at zero for a machine with no checkpoint behind it", () => {
    expect(new ReplicationLogRecorder().nextSeq).toBe(0);
  });

  it("refuses a position that is not a sequence number", () => {
    expect(() => new ReplicationLogRecorder(-1)).toThrow(
      "a replication log starts at a non-negative sequence",
    );
    expect(() => new ReplicationLogRecorder(1.5)).toThrow(
      "a replication log starts at a non-negative sequence",
    );
  });

  it("keeps decisions in the order the primary made them", () => {
    const recorder = new ReplicationLogRecorder();
    recorder.record(reading(1, 7, 0));
    recorder.record(reading(1, 7, 500));
    recorder.record(reading(0, 1_700_000_000, 0));
    expect(recorder.entries.map((entry) => entry.decision)).toEqual([
      reading(1, 7, 0),
      reading(1, 7, 500),
      reading(0, 1_700_000_000, 0),
    ]);
  });

  it("hands each decision to a watcher as it is recorded", () => {
    const recorder = new ReplicationLogRecorder(7);
    const seen: ReplicationLogEntry[] = [];
    recorder.onRecord((entry) => seen.push(entry));
    recorder.record(reading(1, 7, 0));
    recorder.record(reading(0, 8, 0));
    expect(seen).toEqual([...recorder.entries]);
    expect(seen.map((entry) => entry.seq)).toEqual([7, 8]);
  });

  it("stops handing decisions over once the watcher unsubscribes", () => {
    const recorder = new ReplicationLogRecorder();
    const seen: ReplicationLogEntry[] = [];
    const stop = recorder.onRecord((entry) => seen.push(entry));
    recorder.record(reading(1, 7, 0));
    stop();
    recorder.record(reading(1, 8, 0));
    expect(seen).toHaveLength(1);
    expect(recorder.entries).toHaveLength(2);
  });

  it("reaches every watcher, including one added after the first decision", () => {
    const recorder = new ReplicationLogRecorder();
    const first: number[] = [];
    const second: number[] = [];
    recorder.onRecord((entry) => first.push(entry.seq));
    recorder.record(reading(1, 7, 0));
    recorder.onRecord((entry) => second.push(entry.seq));
    recorder.record(reading(1, 8, 0));
    expect(first).toEqual([0, 1]);
    expect(second).toEqual([1]);
  });
});

describe("replication log reader", () => {
  it("serves the recorded readings in order", () => {
    const recorder = new ReplicationLogRecorder();
    recorder.record(reading(1, 7, 0));
    recorder.record(reading(1, 7, 500));
    const reader = new ReplicationLogReader(recorder.entries);

    expect(reader.takeClock(1, 1)).toEqual(reading(1, 7, 0));
    expect(reader.takeClock(1, 1)).toEqual(reading(1, 7, 500));
  });

  it("reports the position when the replica reads a different clock", () => {
    const recorder = new ReplicationLogRecorder(9);
    recorder.record(reading(1, 7, 0));
    const reader = new ReplicationLogReader(recorder.entries);

    expect(() => reader.takeClock(0, 1)).toThrow(ReplicationDivergence);
    expect(() => reader.takeClock(0, 1)).toThrow(
      "replication log diverged at 9: the replica read clock 0 where the "
        + "primary read clock 1",
    );
  });

  it("reports the position when the replica reads past the recording", () => {
    const recorder = new ReplicationLogRecorder(9);
    recorder.record(reading(1, 7, 0));
    const reader = new ReplicationLogReader(recorder.entries);
    reader.takeClock(1, 1);

    expect(() => reader.takeClock(1, 1)).toThrow(
      "replication log diverged at 10: the replica read clock 1 past the end "
        + "of the log",
    );
  });

  it("reports position zero when there is nothing recorded at all", () => {
    const reader = new ReplicationLogReader([]);
    expect(() => reader.takeClock(1, 1)).toThrow(
      "replication log diverged at 0:",
    );
  });

  it("leaves the position unconsumed when it refuses", () => {
    const recorder = new ReplicationLogRecorder();
    recorder.record(reading(1, 7, 0));
    const reader = new ReplicationLogReader(recorder.entries);

    expect(() => reader.takeClock(0, 1)).toThrow(ReplicationDivergence);
    // A refused read must not advance the log, or the divergence report and
    // the recovery that follows it would name different positions.
    expect(reader.nextSeq).toBe(0);
    expect(reader.takeClock(1, 1)).toEqual(reading(1, 7, 0));
  });
});

describe("replication log GL query answers", () => {
  it("serves the recorded answers in order, interleaved with the clock", () => {
    const recorder = new ReplicationLogRecorder();
    recorder.record(glAnswer(5, 4, 1, 0, 0, 0));
    recorder.record(reading(1, 7, 0));
    recorder.record(glAnswer(1, 4, 0, 0, 0, 0));
    const reader = new ReplicationLogReader(recorder.entries);

    expect(reader.takeGlQuery(5)).toEqual(glAnswer(5, 4, 1, 0, 0, 0));
    expect(reader.takeClock(1, 1)).toEqual(reading(1, 7, 0));
    expect(reader.takeGlQuery(1)).toEqual(glAnswer(1, 4, 0, 0, 0, 0));
  });

  it("reports the position when the replica runs a different query", () => {
    const recorder = new ReplicationLogRecorder(4);
    recorder.record(glAnswer(5, 4, 1, 0, 0, 0));
    const reader = new ReplicationLogReader(recorder.entries);

    expect(() => reader.takeGlQuery(1)).toThrow(ReplicationDivergence);
    expect(() => reader.takeGlQuery(1)).toThrow(
      "replication log diverged at 4: the replica ran GL query 1 where the "
        + "primary ran 5",
    );
    expect(reader.nextSeq).toBe(4);
  });

  it("reports the position when the replica runs a query at a clock", () => {
    const recorder = new ReplicationLogRecorder();
    recorder.record(reading(1, 7, 0));
    const reader = new ReplicationLogReader(recorder.entries);

    expect(() => reader.takeGlQuery(5)).toThrow(
      "the replica ran a GL query where the primary recorded clock",
    );
    expect(() => reader.takeClock(1, 1)).not.toThrow();
  });

  it("reports the position when the replica runs a query past the end", () => {
    const reader = new ReplicationLogReader([]);
    expect(() => reader.takeGlQuery(5)).toThrow(
      "replication log diverged at 0: the replica ran GL query 5 past the "
        + "end of the log",
    );
  });

  it("refuses an answer whose bytes fall short of its claim", () => {
    const reader = new ReplicationLogReader([
      { seq: 0, decision: { kind: "gl", op: 5, rc: 8, bytes: new Uint8Array(4) } },
    ]);
    expect(() => reader.takeGlQuery(5)).toThrow(
      "the log's GL answer claims 8 bytes and carries 4",
    );
  });

  it("delivers what the primary pushed before an answer, before it", () => {
    const recorder = new ReplicationLogRecorder();
    recorder.record(input("/dev/pts/0", 13));
    recorder.record(glAnswer(5, 4, 1, 0, 0, 0));
    const delivered: ReplicationPushedDecision[] = [];
    const reader = new ReplicationLogReader(
      recorder.entries,
      (decision) => delivered.push(decision),
    );

    expect(reader.takeGlQuery(5)).toEqual(glAnswer(5, 4, 1, 0, 0, 0));
    expect(delivered).toEqual([input("/dev/pts/0", 13)]);
  });
});

describe("replication log pushed decisions", () => {
  it("delivers what the primary sent before a reading, before that reading", () => {
    const recorder = new ReplicationLogRecorder();
    recorder.record(reading(1, 7, 0));
    recorder.record(pointer(5, -3, 1));
    recorder.record(reading(1, 7, 500));

    const applied: ReplicationPushedDecision[] = [];
    const reader = new ReplicationLogReader(recorder.entries, (decision) =>
      applied.push(decision),
    );

    expect(reader.takeClock(1, 1)).toEqual(reading(1, 7, 0));
    // Nothing asks for a pointer movement, so the next clock read is what
    // pulls it through — and it must arrive before that reading does.
    expect(applied).toEqual([]);
    expect(reader.takeClock(1, 1)).toEqual(reading(1, 7, 500));
    expect(applied).toEqual([pointer(5, -3, 1)]);
  });

  it("delivers what trails the last reading", () => {
    const recorder = new ReplicationLogRecorder();
    recorder.record(reading(1, 7, 0));
    recorder.record(pointer(1, 2, 0));

    const applied: ReplicationPushedDecision[] = [];
    const reader = new ReplicationLogReader(recorder.entries, (decision) =>
      applied.push(decision),
    );
    reader.takeClock(1, 1);
    // A trailing movement has no later reading to pull it through, so a
    // driver that only ever served clock reads would strand it.
    expect(applied).toEqual([]);
    reader.drainPushed();
    expect(applied).toEqual([pointer(1, 2, 0)]);
  });

  it("keeps devices and pointers in the order the primary delivered them", () => {
    const recorder = new ReplicationLogRecorder();
    recorder.record(pointer(1, 0, 0));
    recorder.record(input("/dev/tty1", 0x41));
    recorder.record(pointer(0, 1, 2));

    const applied: ReplicationPushedDecision[] = [];
    new ReplicationLogReader(recorder.entries, (decision) =>
      applied.push(decision),
    ).drainPushed();

    expect(applied).toEqual([
      pointer(1, 0, 0),
      input("/dev/tty1", 0x41),
      pointer(0, 1, 2),
    ]);
  });

  // The guest sitting at a prompt reads no clock, so nothing pulls a
  // keystroke through its own reads. The drain takes what is already there —
  // through the non-blocking hand — applies it, and leaves the next clock
  // reading for the guest that will ask for it.
  it("delivers input the primary sent while the replica read nothing", () => {
    const arriving: ReplicationLogEntry[] = [
      { seq: 0, decision: input("/dev/pts/0", 0x6c, 0x73) },
      { seq: 1, decision: resize("/dev/pts/0", 39, 158) },
      { seq: 2, decision: reading(1, 7, 0) },
    ];
    const applied: ReplicationPushedDecision[] = [];
    const reader = new ReplicationLogReader(
      [],
      (decision) => applied.push(decision),
      () => {
        throw new Error("the drain must not block on the primary");
      },
      () => arriving.shift() ?? null,
    );

    reader.drainPushed();
    expect(applied).toEqual([
      input("/dev/pts/0", 0x6c, 0x73),
      resize("/dev/pts/0", 39, 158),
    ]);
    expect(reader.takeClock(1, 1)).toEqual(reading(1, 7, 0));
  });

  it("refuses to pass over a device write when the replica installed no sink", () => {
    const recorder = new ReplicationLogRecorder(4);
    recorder.record(input("/dev/tty1", 0x41));
    recorder.record(reading(1, 7, 0));
    const reader = new ReplicationLogReader(recorder.entries);

    // Dropping it would leave a replica that is quietly no longer the same
    // machine, so the reader stops instead of serving the clock behind it.
    expect(() => reader.takeClock(1, 1)).toThrow(
      "replication log diverged at 4: the log carries input for /dev/tty1 "
        + "and the replica installed no input sink",
    );
    expect(reader.nextSeq).toBe(4);
  });

  it("names a pointer movement it cannot deliver", () => {
    const recorder = new ReplicationLogRecorder(4);
    recorder.record(pointer(2, 2, 0));
    const reader = new ReplicationLogReader(recorder.entries);

    expect(() => reader.takeClock(1, 1)).toThrow(
      "replication log diverged at 4: the log carries a pointer movement "
        + "and the replica installed no input sink",
    );
  });

  it("reports the position when the replica reads a clock the primary did not", () => {
    const recorder = new ReplicationLogRecorder(2);
    recorder.record(pointer(1, 1, 0));
    const reader = new ReplicationLogReader(recorder.entries, () => {});

    expect(() => reader.takeClock(1, 1)).toThrow(
      "replication log diverged at 3: the replica read clock 1 past the end "
        + "of the log",
    );
  });
});

describe("replication log reader, one machine with many processes", () => {
  // Which process reaches its next clock read first is the host's scheduling
  // of their workers, and no log records that. So the replica below reads in
  // the opposite order from the primary and is still the same machine.
  it("serves each process its own readings, in whatever order they run", () => {
    const recorder = new ReplicationLogRecorder();
    recorder.record(reading(1, 7, 0, 102));
    recorder.record(reading(0, 1_700_000_000, 0, 103));
    recorder.record(reading(1, 7, 500, 102));
    const reader = new ReplicationLogReader(recorder.entries);

    expect(reader.takeClock(0, 103)).toEqual(reading(0, 1_700_000_000, 0, 103));
    expect(reader.takeClock(1, 102)).toEqual(reading(1, 7, 0, 102));
    expect(reader.takeClock(1, 102)).toEqual(reading(1, 7, 500, 102));
    expect(reader.consumed).toBe(3);
  });

  it("reports the position when a process reads a clock it was not given", () => {
    const recorder = new ReplicationLogRecorder(9);
    recorder.record(reading(1, 7, 0, 103));
    recorder.record(reading(1, 7, 0, 102));
    const reader = new ReplicationLogReader(recorder.entries);

    // Another process's reading is not this process's, so the log is read
    // past it — and the divergence names this process's own next reading.
    expect(() => reader.takeClock(0, 102)).toThrow(
      "replication log diverged at 10: the replica read clock 0 where the "
        + "primary read clock 1",
    );
  });

  // A reading no process ever takes must not hold the primary's input: the
  // process it belongs to may never read a clock again, and an injected HTTP
  // request stranded behind it is a viewer that never sees the page.
  it("passes over a reading no process took, to deliver what follows it", () => {
    const recorder = new ReplicationLogRecorder();
    recorder.record(reading(1, 7, 0, 102));
    recorder.record(pointer(1, 1, 0));

    const applied: ReplicationPushedDecision[] = [];
    const reader = new ReplicationLogReader(recorder.entries, (decision) =>
      applied.push(decision),
    );

    expect(() => reader.takeClock(1, 103)).toThrow(ReplicationDivergence);
    expect(applied).toEqual([pointer(1, 1, 0)]);
  });

  it("stops a process the primary never gave a reading to", () => {
    const recorder = new ReplicationLogRecorder(4);
    recorder.record(reading(1, 7, 0, 102));
    const reader = new ReplicationLogReader(recorder.entries);

    expect(() => reader.takeClock(1, 103)).toThrow(
      "replication log diverged at 4: the replica read clock 1 past the end "
        + "of the log",
    );
  });

  // A pushed decision has no process of its own, so it is delivered at the
  // first reading positioned after it. Waiting for the process whose readings
  // surround it would strand the primary's input behind a process that may
  // never read a clock again.
  it("delivers a pushed decision at the next reading, from any process", () => {
    const recorder = new ReplicationLogRecorder();
    recorder.record(reading(1, 7, 0, 102));
    recorder.record(pointer(4, 4, 1));
    recorder.record(reading(1, 7, 0, 103));

    const applied: ReplicationPushedDecision[] = [];
    const reader = new ReplicationLogReader(recorder.entries, (decision) =>
      applied.push(decision),
    );

    expect(reader.takeClock(1, 103)).toEqual(reading(1, 7, 0, 103));
    expect(applied).toEqual([pointer(4, 4, 1)]);
    // The reading pid 102 never took is still there for it.
    expect(reader.takeClock(1, 102)).toEqual(reading(1, 7, 0, 102));
  });
});

describe("replication log divergence reports", () => {
  // The guest's read fails with an errno either way, and a program handed a
  // failed clock goes wrong quietly. The report is the only thing that says
  // this replica stopped being the machine it follows.
  it("reports the divergence it raises", () => {
    const reported: ReplicationDivergence[] = [];
    const reader = new ReplicationLogReader(
      [{ seq: 5, decision: reading(1, 7, 0) }],
      undefined,
      undefined,
      undefined,
      (error) => reported.push(error),
    );

    expect(() => reader.takeClock(0, 1)).toThrow(ReplicationDivergence);
    expect(reported.map((error) => error.message)).toEqual([
      "replication log diverged at 5: the replica read clock 0 where the "
        + "primary read clock 1",
    ]);
    expect(reported[0]!.seq).toBe(5);
  });
});

// The name a keystroke travels under. A host writes to a PTY by the index its
// own tables hold, and both hosts have to agree on the device that index means
// or a replica applies the primary's keystrokes to a different terminal.
describe("replication log device names", () => {
  it("names a PTY by the path its guest opens", () => {
    expect(ptsDevicePath(0)).toBe("/dev/pts/0");
    expect(ptsDeviceIndex("/dev/pts/0")).toBe(0);
    expect(ptsDeviceIndex(ptsDevicePath(11))).toBe(11);
  });

  it("declines to read a PTY index out of a name that is not one", () => {
    expect(ptsDeviceIndex("/dev/tty1")).toBeUndefined();
    expect(ptsDeviceIndex("/dev/pts/")).toBeUndefined();
    expect(ptsDeviceIndex("/dev/pts/ptmx")).toBeUndefined();
    // A relative name is a different file. Reading an index out of it would
    // send the primary's keystrokes to whatever PTY held that number here.
    expect(ptsDeviceIndex("dev/pts/0")).toBeUndefined();
  });
});

describe("replication log reader, following a primary that is still running", () => {
  it("waits for the next decision instead of reading past the log", () => {
    const arriving: ReplicationLogEntry[] = [
      { seq: 0, decision: reading(1, 7, 0) },
      { seq: 1, decision: pointer(3, 4, 1) },
      { seq: 2, decision: reading(1, 7, 900) },
    ];
    const applied: ReplicationPushedDecision[] = [];
    const reader = new ReplicationLogReader(
      [],
      (decision) => void applied.push(decision),
      () => arriving.shift() ?? null,
    );

    // A live replica is given an empty log and grows it as the primary
    // records. Neither reading below was in the log when the guest asked.
    expect(reader.takeClock(1, 1)).toEqual(reading(1, 7, 0));
    expect(reader.takeClock(1, 1)).toEqual(reading(1, 7, 900));
    expect(applied).toEqual([pointer(3, 4, 1)]);
    expect(reader.known).toBe(3);
    expect(reader.consumed).toBe(3);
  });

  it("stops the replay when the primary stopped recording", () => {
    const reader = new ReplicationLogReader([], () => {}, () => null);

    // Reaching the end of a recording that ended is the end of the replay.
    // Reading this host's clock instead would make it a different machine.
    expect(() => reader.takeClock(1, 1)).toThrow(
      "replication log diverged at 0: the replica read clock 1 after the "
        + "primary stopped recording",
    );
  });

  it("refuses a decision that does not continue the sequence", () => {
    const arriving: ReplicationLogEntry[] = [
      { seq: 0, decision: reading(1, 7, 0) },
      { seq: 2, decision: reading(1, 7, 100) },
    ];
    const reader = new ReplicationLogReader(
      [],
      undefined,
      () => arriving.shift() ?? null,
    );

    expect(reader.takeClock(1, 1)).toEqual(reading(1, 7, 0));
    // Seq 1 never arrives. Serving what follows it would advance the replica
    // past a decision the primary made.
    expect(() => reader.takeClock(1, 1)).toThrow(
      "replication log diverged at 2: the log jumped to 2 where 1 was next",
    );
  });

  it("answers whether the primary's next decision is already here", () => {
    const reader = new ReplicationLogReader([
      { seq: 0, decision: reading(1, 7, 0) },
    ]);

    expect(reader.entryReady()).toBe(true);
    reader.takeClock(1, 1);
    expect(reader.entryReady()).toBe(false);
  });

  it("pulls the ring, so a decision parked there counts as here", () => {
    const arriving: ReplicationLogEntry[] = [
      { seq: 0, decision: reading(1, 7, 0) },
    ];
    const reader = new ReplicationLogReader(
      [],
      undefined,
      () => arriving.shift() ?? null,
      () => arriving.shift() ?? null,
    );

    expect(reader.entryReady()).toBe(true);
    expect(reader.takeClock(1, 1)).toEqual(reading(1, 7, 0));
    expect(reader.entryReady()).toBe(false);
  });
});

describe("replication log reader, how long the primary spent waiting", () => {
  it("says nothing until the process has been served a reading", () => {
    const reader = new ReplicationLogReader([
      { seq: 0, decision: reading(1, 7, 0, 102) },
    ]);

    // Nothing has been served, so there is no point to measure from.
    expect(reader.aheadMs(102)).toBeNull();
  });

  it("measures to the process's own next recorded reading", () => {
    const reader = new ReplicationLogReader([
      { seq: 0, decision: reading(1, 7, 0, 102) },
      { seq: 1, decision: reading(1, 7, 500_000_000, 103) },
      { seq: 2, decision: reading(1, 8, 0, 102) },
    ]);

    reader.takeClock(1, 102);
    // The primary spent a second between this process's two readings, and
    // another process reading in between says nothing about this one's wait.
    expect(reader.aheadMs(102)).toBe(1000);
  });

  it("says nothing while the process is at the head of its own stream", () => {
    const reader = new ReplicationLogReader([
      { seq: 0, decision: reading(1, 7, 0, 102) },
    ]);

    reader.takeClock(1, 102);
    // The primary has not read this process's clock again, so it has not
    // finished the wait this process is entering. A replica shortening it
    // here would spend readings the primary never made.
    expect(reader.aheadMs(102)).toBeNull();
  });

  it("measures each clock the process reads against its own last reading", () => {
    const reader = new ReplicationLogReader([
      { seq: 0, decision: reading(0, 100, 0, 102) },
      { seq: 1, decision: reading(1, 7, 0, 102) },
      { seq: 2, decision: reading(1, 7, 250_000_000, 102) },
    ]);

    reader.takeClock(0, 102);
    reader.takeClock(1, 102);
    // The next reading is of clock 1, so the answer is the gap since this
    // process's last reading of clock 1 — not since its reading of clock 0.
    expect(reader.aheadMs(102)).toBe(250);
  });

  it("answers for the machine when asked about no process", () => {
    const reader = new ReplicationLogReader([
      { seq: 0, decision: reading(1, 7, 0, 102) },
    ]);

    // Host work belongs to no guest, so it asks whether the log carries
    // anything this replica has not reached.
    expect(reader.aheadMs(0)).toBe(Number.POSITIVE_INFINITY);
    reader.takeClock(1, 102);
    expect(reader.aheadMs(0)).toBeNull();
  });
});

describe("replication log clock borrowing", () => {
  // The bounded extender is what a live replay installs; each fake call
  // spends its whole budget, on a Date.now the test owns, so the wait
  // windows elapse without the test sleeping through them.
  const timedOutExtenders = (budgets: number[]) => {
    let now = 0;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    return {
      extend: () => null,
      extendWithin: (budgetMs: number) => {
        budgets.push(budgetMs);
        now += budgetMs;
        return "timedout" as const;
      },
    };
  };

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("serves the machine-latest reading to a process the log stops feeding", () => {
    const recorder = new ReplicationLogRecorder();
    recorder.record(reading(1, 7, 0, 102));
    recorder.record(reading(1, 9, 250, 102));
    const budgets: number[] = [];
    const { extend, extendWithin } = timedOutExtenders(budgets);
    const reader = new ReplicationLogReader(
      recorder.entries,
      undefined,
      extend,
      undefined,
      undefined,
      extendWithin,
    );

    expect(reader.takeClock(1, 107)).toEqual(reading(1, 9, 250, 107));
    expect(reader.borrowedClockReadings).toBe(1);
    // The readings pid 102 was given are still its own, untaken.
    expect(reader.consumed).toBe(0);
    // A process that borrowed once is off the stream: its next miss waits
    // the short bound, not the full one.
    expect(reader.takeClock(1, 107)).toEqual(reading(1, 9, 250, 107));
    expect(budgets).toEqual([2_000, 100]);
  });

  it("returns a process to its own stream when its reading arrives", () => {
    const recorder = new ReplicationLogRecorder();
    recorder.record(reading(1, 5, 0, 102));
    const late: ReplicationLogEntry[] = [
      { seq: 1, decision: reading(1, 9, 0, 107) },
    ];
    const budgets: number[] = [];
    let now = 0;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const reader = new ReplicationLogReader(
      recorder.entries,
      undefined,
      () => null,
      undefined,
      undefined,
      (budgetMs) => {
        budgets.push(budgetMs);
        if (budgets.length === 1) {
          now += budgetMs;
          return "timedout";
        }
        return late.shift() ?? (now += budgetMs, "timedout");
      },
    );

    expect(reader.takeClock(1, 107)).toEqual(reading(1, 5, 0, 107));
    expect(reader.borrowedClockReadings).toBe(1);
    // Its own reading arrives inside the short window and is served as
    // recorded, which puts the process back on its stream: the next miss
    // waits the full bound again, and borrows what the log carries last.
    expect(reader.takeClock(1, 107)).toEqual(reading(1, 9, 0, 107));
    expect(reader.takeClock(1, 107)).toEqual(reading(1, 9, 0, 107));
    expect(budgets).toEqual([2_000, 100, 2_000]);
    expect(reader.borrowedClockReadings).toBe(2);
  });

  it("keeps waiting when the log has no reading for that clock yet", () => {
    const late: ReplicationLogEntry[] = [
      { seq: 0, decision: reading(1, 7, 0, 107) },
    ];
    const budgets: number[] = [];
    let now = 0;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const reader = new ReplicationLogReader(
      [],
      undefined,
      () => null,
      undefined,
      undefined,
      (budgetMs) => {
        budgets.push(budgetMs);
        if (budgets.length < 3) {
          now += budgetMs;
          return "timedout";
        }
        return late.shift() ?? "timedout";
      },
    );

    // There is nothing to borrow, so the read waits through two whole
    // windows and takes its own reading when it arrives.
    expect(reader.takeClock(1, 107)).toEqual(reading(1, 7, 0, 107));
    expect(reader.borrowedClockReadings).toBe(0);
  });

  it("serves a process its own next reading of the clock it asked for", () => {
    const recorder = new ReplicationLogRecorder();
    recorder.record(reading(1, 7, 0, 102));
    recorder.record(reading(0, 40, 0, 102));
    const { extend, extendWithin } = timedOutExtenders([]);
    const reader = new ReplicationLogReader(
      recorder.entries,
      undefined,
      extend,
      undefined,
      undefined,
      extendWithin,
    );

    // The replica's process reads its clocks in the other order. Each read
    // is served the process's own next reading of that clock, so no reading
    // is borrowed and none is lost.
    expect(reader.takeClock(0, 102)).toEqual(reading(0, 40, 0, 102));
    expect(reader.takeClock(1, 102)).toEqual(reading(1, 7, 0, 102));
    expect(reader.borrowedClockReadings).toBe(0);
    expect(reader.consumed).toBe(2);
  });

  it("borrows for a clock the process's own stream never carries", () => {
    const recorder = new ReplicationLogRecorder();
    recorder.record(reading(0, 40, 0, 104));
    recorder.record(reading(1, 7, 0, 102));
    const budgets: number[] = [];
    const { extend, extendWithin } = timedOutExtenders(budgets);
    const reader = new ReplicationLogReader(
      recorder.entries,
      undefined,
      extend,
      undefined,
      undefined,
      extendWithin,
    );

    // Pid 102's next reading is clock 1 and no clock-0 reading of its own
    // follows, so after the bounded wait the read is served the
    // machine-latest clock-0 reading, and pid 102's own clock-1 reading
    // stays for its later read.
    expect(reader.takeClock(0, 102)).toEqual(reading(0, 40, 0, 102));
    expect(reader.borrowedClockReadings).toBe(1);
    expect(budgets).toEqual([2_000]);
    expect(reader.takeClock(1, 102)).toEqual(reading(1, 7, 0, 102));
  });

  it("keeps the strict order when replaying a finished recording", () => {
    const reader = new ReplicationLogReader([
      { seq: 0, decision: reading(1, 7, 0, 102) },
      { seq: 1, decision: reading(0, 40, 0, 102) },
    ]);

    expect(() => reader.takeClock(0, 102)).toThrow(
      "replication log diverged at 0: the replica read clock 0 where the "
        + "primary read clock 1",
    );
  });
});

describe("replication log accept selection", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("holds a connection for the worker the primary gave it to", () => {
    const reader = new ReplicationLogReader([
      { seq: 0, decision: accepted(3, 104) },
      { seq: 1, decision: accepted(3, 101) },
    ]);

    // Every worker of the pre-fork server asks. The two that lose leave the
    // selection where it is, so the recorded winner still finds it.
    expect(reader.takeAcceptWinner(3, 101)).toBe(false);
    expect(reader.takeAcceptWinner(3, 102)).toBe(false);
    expect(reader.consumed).toBe(0);
    expect(reader.takeAcceptWinner(3, 104)).toBe(true);
    expect(reader.consumed).toBe(1);
    // The queue's next connection belongs to the worker that just lost.
    expect(reader.takeAcceptWinner(3, 101)).toBe(true);
    expect(reader.consumed).toBe(2);
  });

  it("keeps each listener's selections on its own stream", () => {
    const reader = new ReplicationLogReader([
      { seq: 0, decision: accepted(3, 104) },
      { seq: 1, decision: accepted(9, 101) },
    ]);

    // nginx accepting on its own listener is not the php-fpm listener's
    // turn coming around, so neither accept waits on the other.
    expect(reader.takeAcceptWinner(9, 101)).toBe(true);
    expect(reader.takeAcceptWinner(3, 104)).toBe(true);
    expect(reader.consumed).toBe(2);
  });

  it("delivers what the primary pushed before the accept", () => {
    const applied: ReplicationPushedDecision[] = [];
    const reader = new ReplicationLogReader(
      [
        { seq: 0, decision: input("/dev/pts/0", 7) },
        { seq: 1, decision: accepted(3, 104) },
      ],
      (decision) => applied.push(decision),
    );

    expect(reader.takeAcceptWinner(3, 104)).toBe(true);
    expect(applied).toEqual([input("/dev/pts/0", 7)]);
  });

  it("lets a worker take a connection the primary never assigned", () => {
    // A live replica that reached the queue first waits the bound out, then
    // runs rather than stranding every worker of the machine on it.
    let now = 0;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const budgets: number[] = [];
    const reader = new ReplicationLogReader(
      [],
      undefined,
      () => null,
      undefined,
      undefined,
      (budgetMs) => {
        budgets.push(budgetMs);
        now += budgetMs;
        return "timedout";
      },
    );

    expect(reader.takeAcceptWinner(3, 104)).toBe(true);
    expect(budgets).toEqual([1_000]);
    expect(reader.borrowedAcceptSelections).toBe(1);
  });

  it("spends the late selection for an accept it already borrowed", () => {
    let now = 0;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    // The first selection arrives only after the borrow, so it answers an
    // accept that already happened. Serving it to the next accept would put
    // this listener one connection behind the log for good.
    const late: ReplicationLogEntry[] = [
      { seq: 0, decision: accepted(3, 104) },
      { seq: 1, decision: accepted(3, 101) },
    ];
    const reader = new ReplicationLogReader(
      [],
      undefined,
      () => null,
      undefined,
      undefined,
      (budgetMs) => {
        if (now === 0) {
          now += budgetMs;
          return "timedout";
        }
        return late.shift() ?? "timedout";
      },
    );

    expect(reader.takeAcceptWinner(3, 101)).toBe(true);
    expect(reader.borrowedAcceptSelections).toBe(1);
    // The next accept is answered by the second selection, not the first.
    expect(reader.takeAcceptWinner(3, 104)).toBe(false);
    expect(reader.takeAcceptWinner(3, 101)).toBe(true);
    expect(reader.borrowedAcceptSelections).toBe(1);
  });

  it("takes the selection that arrives inside the wait", () => {
    let now = 0;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const late: ReplicationLogEntry[] = [
      { seq: 0, decision: accepted(3, 104) },
    ];
    const reader = new ReplicationLogReader(
      [],
      undefined,
      () => null,
      undefined,
      undefined,
      () => late.shift() ?? "timedout",
    );

    expect(reader.takeAcceptWinner(3, 101)).toBe(false);
    expect(reader.borrowedAcceptSelections).toBe(0);
  });

  it("reports an accept the recording does not carry", () => {
    const reader = new ReplicationLogReader([
      { seq: 0, decision: accepted(3, 104) },
    ]);

    expect(reader.takeAcceptWinner(3, 104)).toBe(true);
    expect(() => reader.takeAcceptWinner(3, 104)).toThrow(
      "replication log diverged at 1: the replica accepted on listener 3 "
        + "past the end of the log",
    );
  });
});
