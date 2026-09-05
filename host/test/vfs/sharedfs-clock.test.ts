/**
 * Where the inode times a filesystem writes come from.
 *
 * File times are machine state, so they must be the machine's clock and not
 * whichever host the machine is running on. A replica that replays a recorded
 * clock has to stamp the recorded milliseconds, or two computers running the
 * same machine hold different filesystems.
 *
 * The design is `docs/plans/2026-08-23-state-machine-replication-design.md`
 * § "What the instrument says today".
 */
import { describe, expect, it } from "vitest";
import { MemoryFileSystem } from "../../src/vfs/memory-fs";
import type { TimeProvider } from "../../src/vfs/types";

// O_WRONLY | O_CREAT | O_TRUNC, matching sharedfs-vendor.ts constants.
const O_WRONLY = 0x0001;
const O_CREAT = 0x0040;
const O_TRUNC = 0x0200;

function fixedClock(sec: number, nsec: number): TimeProvider {
  return {
    clockGettime: () => ({ sec, nsec }),
    nanosleep: () => {},
  };
}

function write(fs: MemoryFileSystem, path: string, text: string): void {
  const fd = fs.open(path, O_WRONLY | O_CREAT | O_TRUNC, 0o644);
  fs.write(fd, new TextEncoder().encode(text), null, text.length);
  fs.close(fd);
}

describe("SharedFS clock", () => {
  it("stamps a new file from the host clock by default", () => {
    const fs = MemoryFileSystem.create(new SharedArrayBuffer(1024 * 1024));
    const before = Date.now();
    write(fs, "/foo", "foo");
    const after = Date.now();
    const stat = fs.stat("/foo");
    expect(stat.mtimeMs).toBeGreaterThanOrEqual(before);
    expect(stat.mtimeMs).toBeLessThanOrEqual(after);
  });

  it("stamps a new file from the machine's clock once one is set", () => {
    const fs = MemoryFileSystem.create(new SharedArrayBuffer(1024 * 1024));
    fs.setTimeProvider(fixedClock(1_700_000_000, 0));
    write(fs, "/foo", "foo");
    const stat = fs.stat("/foo");
    expect(stat.mtimeMs).toBe(1_700_000_000_000);
    expect(stat.ctimeMs).toBe(1_700_000_000_000);
    expect(stat.atimeMs).toBe(1_700_000_000_000);
  });

  it("stamps every later write from the clock at the time of the write", () => {
    const fs = MemoryFileSystem.create(new SharedArrayBuffer(1024 * 1024));
    let sec = 1_700_000_000;
    fs.setTimeProvider({
      clockGettime: () => ({ sec, nsec: 0 }),
      nanosleep: () => {},
    });
    write(fs, "/foo", "foo");
    sec = 1_700_000_060;
    write(fs, "/foo", "bar");
    expect(fs.stat("/foo").mtimeMs).toBe(1_700_000_060_000);
  });

  it("truncates a sub-millisecond reading rather than rounding it up", () => {
    // The inode fields hold whole milliseconds. A reading that rounded up
    // could stamp a file one millisecond ahead of the clock the guest read,
    // so a replica and its primary would disagree on a file they both wrote
    // at the same recorded instant.
    const fs = MemoryFileSystem.create(new SharedArrayBuffer(1024 * 1024));
    fs.setTimeProvider(fixedClock(1_700_000_000, 999_999));
    write(fs, "/foo", "foo");
    expect(fs.stat("/foo").mtimeMs).toBe(1_700_000_000_000);
  });

  it("gives two filesystems on one clock the same times for the same writes", () => {
    // The property replication needs: two replicas that stamp one guest
    // operation at two different wall-clock instants hold different
    // filesystems, and a state hash over the mount reports it.
    const clock = fixedClock(1_700_000_000, 250_000_000);
    const left = MemoryFileSystem.create(new SharedArrayBuffer(1024 * 1024));
    const right = MemoryFileSystem.create(new SharedArrayBuffer(1024 * 1024));
    left.setTimeProvider(clock);
    right.setTimeProvider(clock);
    write(left, "/foo", "foo");
    write(right, "/foo", "foo");
    expect(left.stat("/foo").mtimeMs).toBe(right.stat("/foo").mtimeMs);
    expect(left.stat("/foo").mtimeMs).toBe(1_700_000_000_250);
  });

  it("stamps an unlink that leaves other links from the machine's clock", () => {
    // A link count drop writes ctime through a different SharedFS path than a
    // file write does, so the two need separate cover.
    const fs = MemoryFileSystem.create(new SharedArrayBuffer(1024 * 1024));
    fs.setTimeProvider(fixedClock(1_700_000_000, 0));
    write(fs, "/foo", "foo");
    fs.link("/foo", "/bar");
    fs.setTimeProvider(fixedClock(1_700_000_060, 0));
    fs.unlink("/bar");
    expect(fs.stat("/foo").ctimeMs).toBe(1_700_000_060_000);
  });
});
