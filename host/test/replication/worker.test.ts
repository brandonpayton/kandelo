import { describe, expect, it } from "vitest";
import type { GlQueryTap } from "../../src/kernel";
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
    behindProbe: (() => boolean) | null;
    httpTap: HttpExchangeTap | null;
  } = {
    provider: null,
    tap: null,
    behindProbe: null,
    httpTap: null,
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
      setReplicationBehindProbe: (probe: (() => boolean) | null) => {
        installed.behindProbe = probe;
      },
      setHttpExchangeTap: (tap: HttpExchangeTap | null) => {
        installed.httpTap = tap;
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
      surface.taps,
    );

    surface.installed.provider!.clockGettime(1);
    expect(surface.installed.tap?.mode).toBe("record");
    if (surface.installed.tap?.mode !== "record") return;
    surface.installed.tap.record(5, 4, new Uint8Array([1, 0, 0, 0]));
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
      "http",
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
      surface.taps,
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
