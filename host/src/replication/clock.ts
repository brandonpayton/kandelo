import type { TimeProvider } from "../vfs/types";
import type {
  ReplicationLogReader,
  ReplicationLogRecorder,
} from "./log";

/**
 * The guest clock, taken from the log instead of from the host.
 *
 * Time is the largest single source of divergence: two computers never read
 * the same nanosecond, so a replica that reads its own clock stops being the
 * same machine on its first `clock_gettime`. Both wrappers below sit at the
 * one interface every guest clock read already crosses, `TimeProvider`, so no
 * syscall, kernel path, or host adapter has to know which mode it is in.
 *
 * Only the readings come from the log. `nanosleep` stays a real host effect:
 * its duration is a guest argument, already deterministic, and a replica that
 * skipped the wait would run the machine faster than it was recorded rather
 * than differently.
 */

/** Delegate to the real clock, and record what the guest was told. */
export class RecordingTimeProvider implements TimeProvider {
  readonly #source: TimeProvider;
  readonly #recorder: ReplicationLogRecorder;

  constructor(source: TimeProvider, recorder: ReplicationLogRecorder) {
    this.#source = source;
    this.#recorder = recorder;
  }

  clockGettime(clockId: number): { sec: number; nsec: number } {
    const reading = this.#source.clockGettime(clockId);
    this.#recorder.record({
      kind: "clock",
      clockId,
      sec: reading.sec,
      nsec: reading.nsec,
    });
    return reading;
  }

  advanceMonotonicFloor(floorNs: number): void {
    this.#source.advanceMonotonicFloor?.(floorNs);
  }

  nanosleep(sec: number, nsec: number): void {
    this.#source.nanosleep(sec, nsec);
  }
}

/** Serve the recorded clock, and refuse to invent a reading. */
export class ReplayingTimeProvider implements TimeProvider {
  readonly #source: TimeProvider;
  readonly #reader: ReplicationLogReader;

  constructor(source: TimeProvider, reader: ReplicationLogReader) {
    this.#source = source;
    this.#reader = reader;
  }

  clockGettime(clockId: number): { sec: number; nsec: number } {
    const reading = this.#reader.takeClock(clockId);
    return { sec: reading.sec, nsec: reading.nsec };
  }

  advanceMonotonicFloor(_floorNs: number): void {
    // The floor exists so a restored machine's own clock cannot read below the
    // captured machine's. A replayed clock never reads its own host, so there
    // is nothing here to raise: the recorded readings already carry the
    // monotonic order the primary observed.
  }

  nanosleep(sec: number, nsec: number): void {
    this.#source.nanosleep(sec, nsec);
  }
}
