import { describe, expect, it } from "vitest";
import {
  ReplicationDivergence,
  ReplicationLogReader,
  ReplicationLogRecorder,
  ptsDeviceIndex,
  ptsDevicePath,
  type ReplicationLogEntry,
  type ReplicationPushedDecision,
} from "../../src/replication/log";

const reading = (clockId: number, sec: number, nsec: number) =>
  ({ kind: "clock", clockId, sec, nsec }) as const;

const input = (device: string, ...bytes: number[]) =>
  ({ kind: "input", device, bytes: new Uint8Array(bytes) }) as const;

const pointer = (dx: number, dy: number, buttons: number) =>
  ({ kind: "pointer", dx, dy, buttons }) as const;

const resize = (device: string, rows: number, cols: number) =>
  ({ kind: "resize", device, rows, cols }) as const;

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

    expect(reader.takeClock(1)).toEqual(reading(1, 7, 0));
    expect(reader.takeClock(1)).toEqual(reading(1, 7, 500));
  });

  it("reports the position when the replica reads a different clock", () => {
    const recorder = new ReplicationLogRecorder(9);
    recorder.record(reading(1, 7, 0));
    const reader = new ReplicationLogReader(recorder.entries);

    expect(() => reader.takeClock(0)).toThrow(ReplicationDivergence);
    expect(() => reader.takeClock(0)).toThrow(
      "replication log diverged at 9: the replica read clock 0 where the "
        + "primary read clock 1",
    );
  });

  it("reports the position when the replica reads past the recording", () => {
    const recorder = new ReplicationLogRecorder(9);
    recorder.record(reading(1, 7, 0));
    const reader = new ReplicationLogReader(recorder.entries);
    reader.takeClock(1);

    expect(() => reader.takeClock(1)).toThrow(
      "replication log diverged at 10: the replica read clock 1 past the end "
        + "of the log",
    );
  });

  it("reports position zero when there is nothing recorded at all", () => {
    const reader = new ReplicationLogReader([]);
    expect(() => reader.takeClock(1)).toThrow(
      "replication log diverged at 0:",
    );
  });

  it("leaves the position unconsumed when it refuses", () => {
    const recorder = new ReplicationLogRecorder();
    recorder.record(reading(1, 7, 0));
    const reader = new ReplicationLogReader(recorder.entries);

    expect(() => reader.takeClock(0)).toThrow(ReplicationDivergence);
    // A refused read must not advance the log, or the divergence report and
    // the recovery that follows it would name different positions.
    expect(reader.nextSeq).toBe(0);
    expect(reader.takeClock(1)).toEqual(reading(1, 7, 0));
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

    expect(reader.takeClock(1)).toEqual(reading(1, 7, 0));
    // Nothing asks for a pointer movement, so the next clock read is what
    // pulls it through — and it must arrive before that reading does.
    expect(applied).toEqual([]);
    expect(reader.takeClock(1)).toEqual(reading(1, 7, 500));
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
    reader.takeClock(1);
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
    expect(reader.takeClock(1)).toEqual(reading(1, 7, 0));
  });

  it("refuses to pass over a device write when the replica installed no sink", () => {
    const recorder = new ReplicationLogRecorder(4);
    recorder.record(input("/dev/tty1", 0x41));
    recorder.record(reading(1, 7, 0));
    const reader = new ReplicationLogReader(recorder.entries);

    // Dropping it would leave a replica that is quietly no longer the same
    // machine, so the reader stops instead of serving the clock behind it.
    expect(() => reader.takeClock(1)).toThrow(
      "replication log diverged at 4: the log carries input for /dev/tty1 "
        + "and the replica installed no input sink",
    );
    expect(reader.nextSeq).toBe(4);
  });

  it("names a pointer movement it cannot deliver", () => {
    const recorder = new ReplicationLogRecorder(4);
    recorder.record(pointer(2, 2, 0));
    const reader = new ReplicationLogReader(recorder.entries);

    expect(() => reader.takeClock(1)).toThrow(
      "replication log diverged at 4: the log carries a pointer movement "
        + "and the replica installed no input sink",
    );
  });

  it("reports the position when the replica reads a clock the primary did not", () => {
    const recorder = new ReplicationLogRecorder(2);
    recorder.record(pointer(1, 1, 0));
    const reader = new ReplicationLogReader(recorder.entries, () => {});

    expect(() => reader.takeClock(1)).toThrow(
      "replication log diverged at 3: the replica read clock 1 past the end "
        + "of the log",
    );
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
    expect(reader.takeClock(1)).toEqual(reading(1, 7, 0));
    expect(reader.takeClock(1)).toEqual(reading(1, 7, 900));
    expect(applied).toEqual([pointer(3, 4, 1)]);
    expect(reader.known).toBe(3);
    expect(reader.consumed).toBe(3);
  });

  it("stops the replay when the primary stopped recording", () => {
    const reader = new ReplicationLogReader([], () => {}, () => null);

    // Reaching the end of a recording that ended is the end of the replay.
    // Reading this host's clock instead would make it a different machine.
    expect(() => reader.takeClock(1)).toThrow(
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

    expect(reader.takeClock(1)).toEqual(reading(1, 7, 0));
    // Seq 1 never arrives. Serving what follows it would advance the replica
    // past a decision the primary made.
    expect(() => reader.takeClock(1)).toThrow(
      "replication log diverged at 2: the log jumped to 2 where 1 was next",
    );
  });
});
