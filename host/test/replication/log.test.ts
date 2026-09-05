import { describe, expect, it } from "vitest";
import {
  ReplicationDivergence,
  ReplicationLogReader,
  ReplicationLogRecorder,
  type ReplicationLogEntry,
  type ReplicationPushedDecision,
} from "../../src/replication/log";

const reading = (clockId: number, sec: number, nsec: number) =>
  ({ kind: "clock", clockId, sec, nsec }) as const;

const input = (device: string, ...bytes: number[]) =>
  ({ kind: "input", device, bytes: new Uint8Array(bytes) }) as const;

const pointer = (dx: number, dy: number, buttons: number) =>
  ({ kind: "pointer", dx, dy, buttons }) as const;

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
