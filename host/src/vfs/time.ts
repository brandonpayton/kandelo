import type { TimeProvider } from "./types";

export class NodeTimeProvider implements TimeProvider {
  // Offset from hrtime (monotonic) to epoch, computed once at startup.
  private readonly _epochOffsetNs: bigint;
  // hrtime at provider creation, used as process start for CPUTIME clocks.
  private readonly _startNs: bigint;
  // Restore-time advance keeping monotonic readings at or above a captured
  // machine's clock. Never affects CLOCK_REALTIME.
  private _monotonicAdvanceNs = 0n;

  constructor() {
    // hrtime.bigint() is monotonic from process start.
    // Compute the offset to convert it to wall-clock (epoch) time.
    const hrt = process.hrtime.bigint();
    const wallNs = BigInt(Date.now()) * 1_000_000n;
    this._epochOffsetNs = wallNs - hrt;
    this._startNs = hrt;
  }

  clockGettime(clockId: number): { sec: number; nsec: number } {
    const ns = process.hrtime.bigint();
    if (clockId === 2 || clockId === 3) {
      // CLOCK_PROCESS_CPUTIME_ID / CLOCK_THREAD_CPUTIME_ID
      // Return time since process start (in Wasm, CPU ≈ elapsed)
      const elapsed = ns - this._startNs;
      return { sec: Number(elapsed / 1000000000n), nsec: Number(elapsed % 1000000000n) };
    }
    if (clockId === 1 || clockId === 7) {
      // CLOCK_MONOTONIC / CLOCK_BOOTTIME
      const advanced = ns + this._monotonicAdvanceNs;
      return {
        sec: Number(advanced / 1000000000n),
        nsec: Number(advanced % 1000000000n),
      };
    }
    // CLOCK_REALTIME — use hrtime + epoch offset for nanosecond resolution
    const realNs = ns + this._epochOffsetNs;
    return { sec: Number(realNs / 1000000000n), nsec: Number(realNs % 1000000000n) };
  }

  advanceMonotonicFloor(floorNs: number): void {
    const now = process.hrtime.bigint() + this._monotonicAdvanceNs;
    const floor = BigInt(Math.trunc(floorNs));
    if (now < floor) this._monotonicAdvanceNs += floor - now;
  }

  nanosleep(sec: number, nsec: number): void {
    const ms = sec * 1000 + Math.floor(nsec / 1_000_000);
    if (ms > 0) {
      const sab = new SharedArrayBuffer(4);
      Atomics.wait(new Int32Array(sab), 0, 0, ms);
    }
  }
}

export class BrowserTimeProvider implements TimeProvider {
  // Restore-time advance keeping monotonic readings at or above a captured
  // machine's clock: a fresh worker's `performance.now()` origin starts near
  // zero. Never affects CLOCK_REALTIME.
  private _monotonicAdvanceMs = 0;

  clockGettime(clockId: number): { sec: number; nsec: number } {
    if (clockId === 1 || clockId === 2 || clockId === 3 || clockId === 7) {
      // CLOCK_MONOTONIC / CPU-time clocks / CLOCK_BOOTTIME
      const ms = performance.now() + this._monotonicAdvanceMs;
      return { sec: Math.floor(ms / 1000), nsec: Math.floor((ms % 1000) * 1_000_000) };
    }
    // CLOCK_REALTIME
    const now = Date.now();
    return { sec: Math.floor(now / 1000), nsec: (now % 1000) * 1_000_000 };
  }

  advanceMonotonicFloor(floorNs: number): void {
    const nowMs = performance.now() + this._monotonicAdvanceMs;
    const floorMs = floorNs / 1_000_000;
    if (nowMs < floorMs) this._monotonicAdvanceMs += floorMs - nowMs;
  }

  nanosleep(sec: number, nsec: number): void {
    const ms = sec * 1000 + Math.floor(nsec / 1_000_000);
    if (ms > 0) {
      const sab = new SharedArrayBuffer(4);
      Atomics.wait(new Int32Array(sab), 0, 0, ms);
    }
  }
}
