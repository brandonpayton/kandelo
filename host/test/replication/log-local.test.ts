/**
 * The decision log on a wire.
 *
 * The claim these tests hold is narrow and exact: a peer receives the log, and
 * its entry count matches the sender's. Everything else here exists to make
 * that claim mean something — a late joiner must get the entries recorded
 * before it arrived, a congested wire must delay rather than drop, and a hole
 * in the sequence must be reported instead of passed on.
 *
 * The design is `docs/plans/2026-08-23-state-machine-replication-design.md`
 * § "Core model" and § "How a replica joins a GL machine".
 */
import { describe, expect, it, vi } from "vitest";
import { ChunkedMessageChannel } from "../../src/migration/channel-chunked";
import {
  LocalReplicationLog,
  type ReplicationLogSink,
} from "../../src/replication/log-local";
import {
  ReplicationDivergence,
  ReplicationLogRecorder,
  type ReplicationLogEntry,
} from "../../src/replication/log";
import { FakeDataChannel } from "../support/data-channel-pair";

function fakeSink(): {
  sink: ReplicationLogSink;
  taken: () => ReplicationLogEntry[];
  ended: () => number;
  divergences: () => ReplicationDivergence[];
} {
  const taken: ReplicationLogEntry[] = [];
  const divergences: ReplicationDivergence[] = [];
  let ended = 0;
  return {
    sink: {
      entries: (batch) => void taken.push(...batch),
      ended: () => void (ended += 1),
      diverged: (error) => void divergences.push(error),
    },
    taken: () => taken,
    ended: () => ended,
    divergences: () => divergences,
  };
}

/** A recorder driven the way a machine's clock drives one. */
function recordClocks(recorder: ReplicationLogRecorder, count: number): void {
  for (let at = 0; at < count; at++) {
    recorder.record({ kind: "clock", clockId: 0, sec: 1_700_000 + at, nsec: 0 });
  }
}

describe("local replication log", () => {
  it("gives a peer the whole log, and the counts match", async () => {
    const channel = `replication-test-${crypto.randomUUID()}`;
    const publisher = new LocalReplicationLog(channel);
    const watcher = new LocalReplicationLog(channel);
    const recorder = new ReplicationLogRecorder();
    const stopPublish = publisher.publish(recorder);
    const sink = fakeSink();
    const stopWatch = watcher.watch(sink.sink);
    try {
      recordClocks(recorder, 5);
      await vi.waitFor(() => expect(sink.taken()).toHaveLength(5));
      expect(sink.taken()).toHaveLength(recorder.entries.length);
      expect(sink.taken()).toEqual([...recorder.entries]);
    } finally {
      stopPublish();
      stopWatch();
      publisher.close();
      watcher.close();
    }
  });

  it("seeds a peer that joins after the recording started", async () => {
    const channel = `replication-test-${crypto.randomUUID()}`;
    const publisher = new LocalReplicationLog(channel);
    const watcher = new LocalReplicationLog(channel);
    const recorder = new ReplicationLogRecorder();
    const stopPublish = publisher.publish(recorder);
    // A replica joins at boot and replays from the machine's first decision,
    // so what was recorded before it arrived is exactly what it needs most.
    recordClocks(recorder, 3);
    const sink = fakeSink();
    const stopWatch = watcher.watch(sink.sink);
    try {
      await vi.waitFor(() => expect(sink.taken()).toHaveLength(3));
      recordClocks(recorder, 2);
      await vi.waitFor(() => expect(sink.taken()).toHaveLength(5));
      expect(sink.taken().map((entry) => entry.seq)).toEqual([0, 1, 2, 3, 4]);
    } finally {
      stopPublish();
      stopWatch();
      publisher.close();
      watcher.close();
    }
  });

  it("gives a peer that joins mid-recording each entry exactly once", async () => {
    const channel = `replication-test-${crypto.randomUUID()}`;
    const publisher = new LocalReplicationLog(channel);
    const watcher = new LocalReplicationLog(channel);
    const recorder = new ReplicationLogRecorder();
    const stopPublish = publisher.publish(recorder);
    recordClocks(recorder, 2);
    const sink = fakeSink();
    const stopWatch = watcher.watch(sink.sink);
    // The seeding backlog and this decision cross on the wire: the machine
    // goes on recording while the watcher's hello is still travelling. A
    // replica that took the overlap twice would consume the log at a position
    // the primary never reached.
    recordClocks(recorder, 1);
    try {
      await vi.waitFor(() => expect(sink.taken()).toHaveLength(3));
      expect(sink.taken().map((entry) => entry.seq)).toEqual([0, 1, 2]);
      expect(sink.divergences()).toEqual([]);
    } finally {
      stopPublish();
      stopWatch();
      publisher.close();
      watcher.close();
    }
  });

  it("tells a peer the recording ended when the publisher stops", async () => {
    const channel = `replication-test-${crypto.randomUUID()}`;
    const publisher = new LocalReplicationLog(channel);
    const watcher = new LocalReplicationLog(channel);
    const recorder = new ReplicationLogRecorder();
    const stopPublish = publisher.publish(recorder);
    const sink = fakeSink();
    const stopWatch = watcher.watch(sink.sink);
    try {
      recordClocks(recorder, 1);
      await vi.waitFor(() => expect(sink.taken()).toHaveLength(1));
      expect(sink.ended()).toBe(0);
      // A machine that stopped recording will not continue, and a replica
      // waiting on a log that has ended would sit there.
      stopPublish();
      await vi.waitFor(() => expect(sink.ended()).toBe(1));
    } finally {
      stopWatch();
      publisher.close();
      watcher.close();
    }
  });

  it("reports a hole in the sequence rather than passing it on", async () => {
    const channel = `replication-test-${crypto.randomUUID()}`;
    const watcher = new LocalReplicationLog(channel);
    const injector = new BroadcastChannel(channel);
    const sink = fakeSink();
    const stopWatch = watcher.watch(sink.sink);
    try {
      const clock = { kind: "clock", clockId: 0, sec: 1, nsec: 0 } as const;
      injector.postMessage({ kind: "entries", entries: [{ seq: 0, decision: clock }] });
      await vi.waitFor(() => expect(sink.taken()).toHaveLength(1));
      // Seq 1 never arrives. Handing seq 2 to a replica would advance it past
      // a decision the primary made, which is the silent drift this module
      // exists to prevent.
      injector.postMessage({ kind: "entries", entries: [{ seq: 2, decision: clock }] });
      await vi.waitFor(() => expect(sink.divergences()).toHaveLength(1));
      expect(sink.divergences()[0]).toBeInstanceOf(ReplicationDivergence);
      expect(sink.divergences()[0]!.seq).toBe(2);
      expect(sink.taken()).toHaveLength(1);
    } finally {
      stopWatch();
      injector.close();
      watcher.close();
    }
  });

  it("ends one machine's recording, and serves the next one to the same peer", async () => {
    const channel = `replication-test-${crypto.randomUUID()}`;
    const computer = new LocalReplicationLog<string>(channel);
    const replica = new LocalReplicationLog<string>(channel);
    const first = new ReplicationLogRecorder();
    const second = new ReplicationLogRecorder();
    const serveFrom = (recorder: ReplicationLogRecorder, name: string) =>
      computer.serve(async (publish) => {
        const stopRecord = recorder.onRecord((entry) => publish([entry]));
        return { machine: name, stop: async () => stopRecord() };
      });

    const stale = fakeSink();
    const stopStale = replica.watch(stale.sink);
    let stopServing = serveFrom(first, "the machine that was running");
    try {
      await expect(replica.join(5_000)).resolves
        .toBe("the machine that was running");
      recordClocks(first, 2);
      await vi.waitFor(() => expect(stale.taken()).toHaveLength(2));

      // Launching a demo destroys the machine a replica is a copy of and boots
      // a different one. The replica has to be told, because its own computer
      // shows nothing: it holds a machine before and after.
      stopServing();
      await vi.waitFor(() => expect(stale.ended()).toBe(1));

      // And it has to join the replacement rather than follow along on the
      // subscription it already has. A machine numbers its decisions from
      // zero, so the watcher that counted the first one's discards every one
      // of the second's as already seen.
      stopServing = serveFrom(second, "the machine that replaced it");
      const fresh = fakeSink();
      const stopFresh = replica.watch(fresh.sink);
      await expect(replica.join(5_000)).resolves
        .toBe("the machine that replaced it");
      recordClocks(second, 2);
      await vi.waitFor(() => expect(fresh.taken()).toHaveLength(2));
      expect(fresh.taken().map((entry) => entry.seq)).toEqual([0, 1]);
      expect(stale.taken()).toHaveLength(2);
      stopFresh();
    } finally {
      stopStale();
      stopServing();
      computer.close();
      replica.close();
    }
  });

  it("withdraws an abandoned join instead of letting it win the recording", async () => {
    const channel = `replication-test-${crypto.randomUUID()}`;
    const computer = new LocalReplicationLog<string>(channel);
    const replica = new LocalReplicationLog<string>(channel);
    const recorder = new ReplicationLogRecorder();

    // Asked while no machine answers — the window a viewer attempt lives in
    // during a take-over — then withdrawn, as an ended attempt withdraws it.
    const withdraw = new AbortController();
    const abandoned = replica.join(5_000, withdraw.signal);
    withdraw.abort();
    await expect(abandoned).rejects.toThrow(
      "the request to replicate the machine was withdrawn",
    );

    // A machine starts answering afterwards. Its serving broadcast re-posts
    // every question still standing, so the withdrawn one must not stand: it
    // would win the machine's one recording for an attempt that no longer
    // watches, and the live join would be refused.
    const live = replica.join(5_000);
    const stopServing = computer.serve(async (publish) => {
      const stopRecord = recorder.onRecord((entry) => publish([entry]));
      return { machine: "the machine", stop: async () => stopRecord() };
    });
    try {
      await expect(live).resolves.toBe("the machine");
    } finally {
      stopServing();
      computer.close();
      replica.close();
    }
  });

  it("loses no entry to a wire that holds its bytes", async () => {
    const [near, far] = FakeDataChannel.pair({ auto: false });
    const publisher = new LocalReplicationLog(new ChunkedMessageChannel(near));
    const watcher = new LocalReplicationLog(new ChunkedMessageChannel(far));
    const recorder = new ReplicationLogRecorder();
    const sink = fakeSink();
    const stopWatch = watcher.watch(sink.sink);
    const stopPublish = publisher.publish(recorder);
    try {
      // The wire delivers nothing until it is released, so every entry is
      // recorded while the far side is behind. A mirror would skip frames
      // here and resynchronise; the log may not, because the entry it skipped
      // is a decision the replica then never makes.
      recordClocks(recorder, 20);
      expect(sink.taken()).toHaveLength(0);
      await vi.waitFor(() => {
        near.flush();
        far.flush();
        expect(sink.taken()).toHaveLength(20);
      });
      expect(sink.taken()).toEqual([...recorder.entries]);
      expect(sink.divergences()).toEqual([]);
    } finally {
      stopPublish();
      stopWatch();
    }
  });
});
