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
 * Only the readings come from the log. `nanosleep` stays a real host effect
 * while the replica is at the log head: its duration is a guest argument,
 * already deterministic. Behind the head the wait is skipped — the primary
 * already served it once, and a replica that waits it out again keeps the
 * gap it joined with forever. Running faster than recorded is what catching
 * up is; the guest cannot see the difference, because every reading it gets
 * still comes from the log.
 */

/**
 * Which process is being served, for the reading about to cross the log.
 *
 * A guest clock read reaches the host inside the syscall the kernel worker is
 * serving, so the worker already knows whose read it is. Passing the accessor
 * rather than a value is what keeps that true for every read.
 */
export type ReplicationGuestPid = () => number;

/** Delegate to the real clock, and record what the guest was told. */
export class RecordingTimeProvider implements TimeProvider {
  readonly #source: TimeProvider;
  readonly #recorder: ReplicationLogRecorder;
  readonly #pid: ReplicationGuestPid;

  constructor(
    source: TimeProvider,
    recorder: ReplicationLogRecorder,
    pid: ReplicationGuestPid,
  ) {
    this.#source = source;
    this.#recorder = recorder;
    this.#pid = pid;
  }

  clockGettime(clockId: number): { sec: number; nsec: number } {
    const reading = this.#source.clockGettime(clockId);
    this.#recorder.record({
      kind: "clock",
      pid: this.#pid(),
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
  readonly #pid: ReplicationGuestPid;

  constructor(
    source: TimeProvider,
    reader: ReplicationLogReader,
    pid: ReplicationGuestPid,
  ) {
    this.#source = source;
    this.#reader = reader;
    this.#pid = pid;
  }

  clockGettime(clockId: number): { sec: number; nsec: number } {
    const reading = this.#reader.takeClock(clockId, this.#pid());
    return { sec: reading.sec, nsec: reading.nsec };
  }

  advanceMonotonicFloor(_floorNs: number): void {
    // The floor exists so a restored machine's own clock cannot read below the
    // captured machine's. A replayed clock never reads its own host, so there
    // is nothing here to raise: the recorded readings already carry the
    // monotonic order the primary observed.
  }

  nanosleep(sec: number, nsec: number): void {
    if (this.#reader.entryReady()) return;
    this.#source.nanosleep(sec, nsec);
  }
}
