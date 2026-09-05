import { describe, expect, it } from "vitest";
import type { AcceptSelectionTap, GlQueryTap } from "../../src/kernel";
import type { HttpExchangeTap } from "../../src/networking/in-kernel-http";
import type { ReplicationLogEntry } from "../../src/replication/log";
import {
  ReplayedHttpExchanges,
  beginReplicationReplay,
  beginReplicationStream,
} from "../../src/replication/worker";
import type { TimeProvider } from "../../src/vfs/types";

function machineSurface() {
  const installed: {
    provider: TimeProvider | null;
    tap: GlQueryTap | null;
    acceptTap: AcceptSelectionTap | null;
    aheadProbe: ((pid: number) => number | null) | null;
    httpTap: HttpExchangeTap | null;
    pid: number;
  } = {
    provider: null,
    tap: null,
    acceptTap: null,
    aheadProbe: null,
    httpTap: null,
    pid: 102,
  };
  return {
    installed,
    io: {
      setTimeProvider: (provider: TimeProvider) => {
        installed.provider = provider;
      },
    },
    taps: {
      setGlQueryTap: (tap: GlQueryTap | null) => {
        installed.tap = tap;
      },
      setAcceptSelectionTap: (tap: AcceptSelectionTap | null) => {
        installed.acceptTap = tap;
      },
      setReplicationAheadProbe: (
        probe: ((pid: number) => number | null) | null,
      ) => {
        installed.aheadProbe = probe;
      },
      setHttpExchangeTap: (tap: HttpExchangeTap | null) => {
        installed.httpTap = tap;
      },
      currentGuestPid: () => installed.pid,
    },
    clock: {
      clockGettime: () => ({ sec: 1, nsec: 2 }),
      nanosleep: () => {},
    } as TimeProvider,
  };
}

describe("beginReplicationStream", () => {
  it("puts the recorder's hand on every host-produced value", async () => {
    const surface = machineSurface();
    const published: ReplicationLogEntry[] = [];
    beginReplicationStream(
      surface.io,
      surface.clock,
      (entries) => published.push(...entries),
      surface.taps,
    );

    surface.installed.provider!.clockGettime(1);
    expect(surface.installed.tap?.mode).toBe("record");
    if (surface.installed.tap?.mode !== "record") return;
    surface.installed.tap.record(5, 4, new Uint8Array([1, 0, 0, 0]));
    expect(surface.installed.acceptTap?.mode).toBe("record");
    if (surface.installed.acceptTap?.mode !== "record") return;
    surface.installed.acceptTap.record(3, 104);
    expect(surface.installed.httpTap?.mode).toBe("record");
    if (surface.installed.httpTap?.mode !== "record") return;
    surface.installed.httpTap.record({
      port: 80,
      remotePort: 4242,
      request: new Uint8Array([71]),
    });
    await Promise.resolve();

    expect(published.map((entry) => entry.decision.kind)).toEqual([
      "clock",
      "gl",
      "accept",
      "http",
    ]);
  });
});

describe("beginReplicationReplay", () => {
  it("serves the recorded values back through every hand", () => {
    const surface = machineSurface();
    const entries: ReplicationLogEntry[] = [
      {
        seq: 0,
        decision: { kind: "clock", pid: 102, clockId: 1, sec: 7, nsec: 9 },
      },
      {
        seq: 1,
        decision: { kind: "gl", op: 5, rc: 4, bytes: new Uint8Array([1, 0, 0, 0]) },
      },
      { seq: 2, decision: { kind: "accept", listener: 3, pid: 104 } },
    ];
    beginReplicationReplay(
      surface.io,
      surface.clock,
      { entries },
      surface.taps,
    );

    expect(surface.installed.aheadProbe?.(0)).toBe(Number.POSITIVE_INFINITY);
    expect(surface.installed.provider!.clockGettime(1)).toEqual({
      sec: 7,
      nsec: 9,
    });
    expect(surface.installed.tap?.mode).toBe("replay");
    if (surface.installed.tap?.mode !== "replay") return;
    const answer = surface.installed.tap.take(5);
    expect(answer.rc).toBe(4);
    expect(answer.bytes).toEqual(new Uint8Array([1, 0, 0, 0]));
    expect(surface.installed.acceptTap?.mode).toBe("replay");
    if (surface.installed.acceptTap?.mode !== "replay") return;
    expect(surface.installed.acceptTap.select(3, 101)).toBe(false);
    expect(surface.installed.acceptTap.select(3, 104)).toBe(true);
    expect(surface.installed.aheadProbe?.(0)).toBeNull();
    expect(surface.installed.httpTap?.mode).toBe("replay");
  });
});

describe("ReplayedHttpExchanges", () => {
  it("hands a parked fetch the response its replay later computes", async () => {
    const store = new ReplayedHttpExchanges<string>();
    const parked = store.take("GET /");
    store.deliver("GET /", "hello");
    await expect(parked).resolves.toBe("hello");
  });

  it("serves the latest response for a request line delivered twice", async () => {
    const store = new ReplayedHttpExchanges<string>();
    store.deliver("GET /", "first");
    store.deliver("GET /", "second");
    await expect(store.take("GET /")).resolves.toBe("second");
  });

  it("resolves null for a request the primary never made", async () => {
    const store = new ReplayedHttpExchanges<string>(20);
    await expect(store.take("GET /missing")).resolves.toBeNull();
  });

  it("releases every parked fetch with null on drop", async () => {
    const store = new ReplayedHttpExchanges<string>();
    const parked = store.take("GET /");
    store.drop();
    await expect(parked).resolves.toBeNull();
  });
});
