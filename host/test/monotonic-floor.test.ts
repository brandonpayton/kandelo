import { describe, expect, it } from "vitest";
import { BrowserTimeProvider, NodeTimeProvider } from "../src/vfs/time";

const CLOCK_REALTIME = 0;
const CLOCK_MONOTONIC = 1;

function toNs(reading: { sec: number; nsec: number }): number {
  return reading.sec * 1_000_000_000 + reading.nsec;
}

describe.each([
  ["NodeTimeProvider", () => new NodeTimeProvider()],
  ["BrowserTimeProvider", () => new BrowserTimeProvider()],
])("%s monotonic floor", (_name, create) => {
  it("advances a clock running behind the floor to at least it", () => {
    const provider = create();
    const floor = toNs(provider.clockGettime(CLOCK_MONOTONIC))
      + 3_600_000_000_000;
    provider.advanceMonotonicFloor!(floor);
    expect(toNs(provider.clockGettime(CLOCK_MONOTONIC)))
      .toBeGreaterThanOrEqual(floor);
  });

  it("leaves a clock already past the floor alone", () => {
    const provider = create();
    const before = toNs(provider.clockGettime(CLOCK_MONOTONIC));
    provider.advanceMonotonicFloor!(0);
    const after = toNs(provider.clockGettime(CLOCK_MONOTONIC));
    expect(after).toBeGreaterThanOrEqual(before);
    // A floor at zero cannot have added the hour-scale advance the
    // running-behind case proves; the clock keeps its own pace.
    expect(after - before).toBeLessThan(1_000_000_000);
  });

  it("never moves CLOCK_REALTIME", () => {
    const provider = create();
    const before = toNs(provider.clockGettime(CLOCK_REALTIME));
    provider.advanceMonotonicFloor!(
      toNs(provider.clockGettime(CLOCK_MONOTONIC)) + 3_600_000_000_000,
    );
    const after = toNs(provider.clockGettime(CLOCK_REALTIME));
    expect(Math.abs(after - before)).toBeLessThan(1_000_000_000);
  });

  it("stays monotonic across repeated advances", () => {
    const provider = create();
    let previous = toNs(provider.clockGettime(CLOCK_MONOTONIC));
    for (const floor of [previous + 5_000_000_000, 0, previous]) {
      provider.advanceMonotonicFloor!(floor);
      const reading = toNs(provider.clockGettime(CLOCK_MONOTONIC));
      expect(reading).toBeGreaterThanOrEqual(previous);
      previous = reading;
    }
  });
});
