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
    await expect(parked).resolves.toEqual({ kind: "served", response: "hello" });
  });

  it("serves the latest response for a request line delivered twice", async () => {
    const store = new ReplayedHttpExchanges<string>();
    store.deliver("GET /", "first");
    store.deliver("GET /", "second");
    await expect(store.take("GET /")).resolves.toEqual({
      kind: "served",
      response: "second",
    });
  });

  it("calls a request the log never carried unrecorded", async () => {
    const store = new ReplayedHttpExchanges<string>(20);
    await expect(store.take("GET /missing")).resolves.toEqual({
      kind: "unrecorded",
    });
  });

  // The park is for a request the replay has not reached. A replay that is
  // running owns the answer, and a WordPress page behind php-fpm takes as long
  // as it takes — giving up on it would report a request the log plainly
  // carries as one the machine never saw.
  it("waits past the park while a replay of the request is running", async () => {
    const store = new ReplayedHttpExchanges<string>(10);
    store.expect("GET /");
    const parked = store.take("GET /");
    await new Promise((resolve) => setTimeout(resolve, 40));
    store.deliver("GET /", "slow");
    await expect(parked).resolves.toEqual({ kind: "served", response: "slow" });
  });

  it("reports why a replay of the request ended without a response", async () => {
    const store = new ReplayedHttpExchanges<string>(10);
    store.expect("GET /");
    const parked = store.take("GET /");
    store.fail("GET /", "No in-kernel listener for port 8080");
    await expect(parked).resolves.toEqual({
      kind: "failed",
      reason: "No in-kernel listener for port 8080",
    });
  });

  it("keeps waiting while another replay of the same request runs", async () => {
    const store = new ReplayedHttpExchanges<string>(10);
    store.expect("GET /");
    store.expect("GET /");
    const parked = store.take("GET /");
    store.fail("GET /", "first attempt failed");
    store.deliver("GET /", "second attempt");
    await expect(parked).resolves.toEqual({
      kind: "served",
      response: "second attempt",
    });
  });

  it("tells every parked fetch that the replica is gone on drop", async () => {
    const store = new ReplayedHttpExchanges<string>();
    const parked = store.take("GET /");
    store.drop();
    await expect(parked).resolves.toEqual({
      kind: "failed",
      reason: "the replica that was serving GET / is gone",
    });
  });

  it("reports a miss once, before the deadline, while nothing replays", async () => {
    const missed: string[] = [];
    const store = new ReplayedHttpExchanges<string>(60, {
      report: (key) => missed.push(key),
      afterMs: 10,
    });
    const first = store.take("GET /style.css");
    const second = store.take("GET /style.css");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(missed).toEqual(["GET /style.css"]);
    store.expect("GET /style.css");
    store.deliver("GET /style.css", "css");
    await expect(first).resolves.toEqual({ kind: "served", response: "css" });
    await expect(second).resolves.toEqual({ kind: "served", response: "css" });
  });

  it("does not report a miss while a replay of the request runs", async () => {
    const missed: string[] = [];
    const store = new ReplayedHttpExchanges<string>(60, {
      report: (key) => missed.push(key),
      afterMs: 10,
    });
    store.expect("GET /");
    const parked = store.take("GET /");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(missed).toEqual([]);
    store.deliver("GET /", "own");
    await expect(parked).resolves.toEqual({ kind: "served", response: "own" });
  });

  it("reports a request line again once its earlier ask went unrecorded", async () => {
    const missed: string[] = [];
    const store = new ReplayedHttpExchanges<string>(20, {
      report: (key) => missed.push(key),
      afterMs: 5,
    });
    await expect(store.take("GET /")).resolves.toEqual({ kind: "unrecorded" });
    const again = store.take("GET /");
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(missed).toEqual(["GET /", "GET /"]);
    await expect(again).resolves.toEqual({ kind: "unrecorded" });
  });
});
