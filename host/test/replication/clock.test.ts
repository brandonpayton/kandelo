import { describe, expect, it } from "vitest";
import {
  RecordingTimeProvider,
  ReplayingTimeProvider,
} from "../../src/replication/clock";
import {
  ReplicationDivergence,
  ReplicationLogReader,
  ReplicationLogRecorder,
} from "../../src/replication/log";
import type { TimeProvider } from "../../src/vfs/types";

/** A host clock that never repeats a reading, the way a real one does not. */
function tickingClock(): TimeProvider & {
  readonly floors: number[];
  readonly sleeps: Array<[number, number]>;
} {
  let nsec = 0;
  const floors: number[] = [];
  const sleeps: Array<[number, number]> = [];
  return {
    floors,
    sleeps,
    clockGettime: (clockId) => {
      nsec += 1;
      return { sec: clockId, nsec };
    },
    advanceMonotonicFloor: (floorNs) => {
      floors.push(floorNs);
    },
    nanosleep: (sec, nsec) => {
      sleeps.push([sec, nsec]);
    },
  };
}

describe("recording time provider", () => {
  it("returns the host reading and records exactly what the guest was told", () => {
    const source = tickingClock();
    const recorder = new ReplicationLogRecorder();
    const provider = new RecordingTimeProvider(source, recorder);

    expect(provider.clockGettime(1)).toEqual({ sec: 1, nsec: 1 });
    expect(provider.clockGettime(0)).toEqual({ sec: 0, nsec: 2 });
    expect(recorder.entries.map((entry) => entry.decision)).toEqual([
      { kind: "clock", clockId: 1, sec: 1, nsec: 1 },
      { kind: "clock", clockId: 0, sec: 0, nsec: 2 },
    ]);
  });

  it("passes the monotonic floor and the sleep through to the host", () => {
    const source = tickingClock();
    const provider = new RecordingTimeProvider(
      source,
      new ReplicationLogRecorder(),
    );

    provider.advanceMonotonicFloor(1_700);
    provider.nanosleep(2, 5);
    expect(source.floors).toEqual([1_700]);
    expect(source.sleeps).toEqual([[2, 5]]);
  });
});

describe("replaying time provider", () => {
  it("gives a second machine the readings the first one saw", () => {
    const source = tickingClock();
    const recorder = new ReplicationLogRecorder();
    const primary = new RecordingTimeProvider(source, recorder);
    const first = primary.clockGettime(1);
    const second = primary.clockGettime(1);

    // A fresh host clock, as a second computer has. Its own readings differ.
    const replica = new ReplayingTimeProvider(
      tickingClock(),
      new ReplicationLogReader(recorder.entries),
    );
    expect(replica.clockGettime(1)).toEqual(first);
    expect(replica.clockGettime(1)).toEqual(second);
  });

  it("refuses to invent a reading the primary never made", () => {
    const recorder = new ReplicationLogRecorder(4);
    new RecordingTimeProvider(tickingClock(), recorder).clockGettime(1);
    const replica = new ReplayingTimeProvider(
      tickingClock(),
      new ReplicationLogReader(recorder.entries),
    );
    replica.clockGettime(1);

    expect(() => replica.clockGettime(1)).toThrow(ReplicationDivergence);
  });

  it("still sleeps on the host, because the duration is the guest's", () => {
    const source = tickingClock();
    const replica = new ReplayingTimeProvider(
      source,
      new ReplicationLogReader([]),
    );

    replica.nanosleep(0, 250);
    expect(source.sleeps).toEqual([[0, 250]]);
  });

  it("skips the sleep while the primary's next reading is already here", () => {
    const recorder = new ReplicationLogRecorder();
    new RecordingTimeProvider(tickingClock(), recorder).clockGettime(1);
    const source = tickingClock();
    const replica = new ReplayingTimeProvider(
      source,
      new ReplicationLogReader(recorder.entries),
    );

    // Behind the head: the primary already served this wait once.
    replica.nanosleep(0, 250);
    expect(source.sleeps).toEqual([]);

    // At the head, the wait is real again.
    replica.clockGettime(1);
    replica.nanosleep(0, 250);
    expect(source.sleeps).toEqual([[0, 250]]);
  });

  it("does not raise a monotonic floor it does not own", () => {
    const source = tickingClock();
    const replica = new ReplayingTimeProvider(
      source,
      new ReplicationLogReader([]),
    );

    replica.advanceMonotonicFloor(1_700);
    expect(source.floors).toEqual([]);
  });
});
