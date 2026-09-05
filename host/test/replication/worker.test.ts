import { describe, expect, it } from "vitest";
import type { GlQueryTap } from "../../src/kernel";
import type { ReplicationLogEntry } from "../../src/replication/log";
import {
  beginReplicationReplay,
  beginReplicationStream,
} from "../../src/replication/worker";
import type { TimeProvider } from "../../src/vfs/types";

function machineSurface() {
  const installed: {
    provider: TimeProvider | null;
    tap: GlQueryTap | null;
    behindProbe: (() => boolean) | null;
  } = {
    provider: null,
    tap: null,
    behindProbe: null,
  };
  return {
    installed,
    io: {
      setTimeProvider: (provider: TimeProvider) => {
        installed.provider = provider;
      },
    },
    glQueries: {
      setGlQueryTap: (tap: GlQueryTap | null) => {
        installed.tap = tap;
      },
      setReplicationBehindProbe: (probe: (() => boolean) | null) => {
        installed.behindProbe = probe;
      },
    },
    clock: {
      clockGettime: () => ({ sec: 1, nsec: 2 }),
      nanosleep: () => {},
    } as TimeProvider,
  };
}

describe("beginReplicationStream", () => {
  it("puts the recorder's hand on the clock and on GL queries", async () => {
    const surface = machineSurface();
    const published: ReplicationLogEntry[] = [];
    beginReplicationStream(
      surface.io,
      surface.clock,
      (entries) => published.push(...entries),
      surface.glQueries,
    );

    surface.installed.provider!.clockGettime(1);
    expect(surface.installed.tap?.mode).toBe("record");
    if (surface.installed.tap?.mode !== "record") return;
    surface.installed.tap.record(5, 4, new Uint8Array([1, 0, 0, 0]));
    await Promise.resolve();

    expect(published.map((entry) => entry.decision.kind)).toEqual([
      "clock",
      "gl",
    ]);
  });
});

describe("beginReplicationReplay", () => {
  it("serves the recorded clock and GL answers back through both hands", () => {
    const surface = machineSurface();
    const entries: ReplicationLogEntry[] = [
      { seq: 0, decision: { kind: "clock", clockId: 1, sec: 7, nsec: 9 } },
      {
        seq: 1,
        decision: { kind: "gl", op: 5, rc: 4, bytes: new Uint8Array([1, 0, 0, 0]) },
      },
    ];
    beginReplicationReplay(
      surface.io,
      surface.clock,
      { entries },
      surface.glQueries,
    );

    expect(surface.installed.behindProbe?.()).toBe(true);
    expect(surface.installed.provider!.clockGettime(1)).toEqual({
      sec: 7,
      nsec: 9,
    });
    expect(surface.installed.tap?.mode).toBe("replay");
    if (surface.installed.tap?.mode !== "replay") return;
    const answer = surface.installed.tap.take(5);
    expect(answer.rc).toBe(4);
    expect(answer.bytes).toEqual(new Uint8Array([1, 0, 0, 0]));
    expect(surface.installed.behindProbe?.()).toBe(false);
  });
});
