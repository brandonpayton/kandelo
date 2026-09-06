import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VirtualPlatformIO } from "../src/vfs/vfs";
import { HostFileSystem } from "../src/vfs/host-fs";
import { MemoryFileSystem } from "../src/vfs/memory-fs";
import {
  BLOCK_SIZE,
  EMFILE,
  FD_ENTRY_SIZE,
  FD_TABLE_OFFSET,
  MAX_FDS,
  O_CREAT,
  O_RDONLY,
  O_RDWR,
  O_TRUNC,
  SFSError,
} from "../src/vfs/sharedfs-vendor";
import { NodeTimeProvider } from "../src/vfs/time";
import { askMountsForCheckpointBytes } from "../src/migration/checkpoint";
import {
  ST_NOSUID,
  type FileSystemBackend,
  type MountConfig,
  type TimeProvider,
} from "../src/vfs/types";
import type { StatResult, StatfsResult } from "../src/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockBackend(
  statOverrides: Partial<StatResult> = {},
): FileSystemBackend & { calls: string[] } {
  const calls: string[] = [];
  const dummyStat: StatResult = {
    dev: 0,
    ino: 0,
    mode: 0,
    nlink: 0,
    uid: 0,
    gid: 0,
    size: 0,
    atimeMs: 0,
    mtimeMs: 0,
    ctimeMs: 0,
    ...statOverrides,
  };
  const dummyStatfs: StatfsResult = {
    type: 0,
    bsize: 4096,
    blocks: 0,
    bfree: 0,
    bavail: 0,
    files: 0,
    ffree: 0,
    fsid: 0,
    namelen: 255,
    frsize: 4096,
    flags: 0,
  };
  return {
    calls,
    open: (path, flags, mode) => {
      calls.push(`open:${path}`);
      return 1;
    },
    close: (h) => {
      calls.push(`close:${h}`);
      return 0;
    },
    read: (h, buf, off, len) => {
      calls.push(`read:${h}`);
      return 0;
    },
    write: (h, buf, off, len) => {
      calls.push(`write:${h}`);
      return 0;
    },
    seek: (h, off, w) => {
      calls.push(`seek:${h}`);
      return 0;
    },
    fstat: (h) => {
      calls.push(`fstat:${h}`);
      return { ...dummyStat };
    },
    fpathconf: (h, name) => {
      calls.push(`fpathconf:${h}:${name}`);
      return 4096;
    },
    ftruncate: (h, l) => {
      calls.push(`ftruncate:${h}`);
    },
    fsync: (h) => {
      calls.push(`fsync:${h}`);
    },
    fchmod: (h, m) => {
      calls.push(`fchmod:${h}`);
    },
    fchown: (h, u, g) => {
      calls.push(`fchown:${h}`);
    },
    stat: (p) => {
      calls.push(`stat:${p}`);
      return { ...dummyStat };
    },
    lstat: (p) => {
      calls.push(`lstat:${p}`);
      return { ...dummyStat };
    },
    statfs: (p) => {
      calls.push(`statfs:${p}`);
      return { ...dummyStatfs };
    },
    pathconf: (p, name) => {
      calls.push(`pathconf:${p}:${name}`);
      return 4096;
    },
    mkdir: (p, m) => {
      calls.push(`mkdir:${p}`);
    },
    rmdir: (p) => {
      calls.push(`rmdir:${p}`);
    },
    unlink: (p) => {
      calls.push(`unlink:${p}`);
    },
    rename: (o, n) => {
      calls.push(`rename:${o}:${n}`);
    },
    link: (e, n) => {
      calls.push(`link:${e}:${n}`);
    },
    symlink: (t, p) => {
      calls.push(`symlink:${t}:${p}`);
    },
    readlink: (p) => {
      calls.push(`readlink:${p}`);
      return "";
    },
    chmod: (p, m) => {
      calls.push(`chmod:${p}`);
    },
    chown: (p, u, g) => {
      calls.push(`chown:${p}`);
    },
    lchown: (p, u, g) => {
      calls.push(`lchown:${p}`);
    },
    access: (p, m) => {
      calls.push(`access:${p}`);
    },
    utimensat: (p, aSec, aNsec, mSec, mNsec) => {
      calls.push(`utimensat:${p}`);
    },
    opendir: (p) => {
      calls.push(`opendir:${p}`);
      return 1;
    },
    readdir: (h) => {
      calls.push(`readdir:${h}`);
      return null;
    },
    closedir: (h) => {
      calls.push(`closedir:${h}`);
    },
  };
}

// ---------------------------------------------------------------------------
// 1. Mount resolution tests
// ---------------------------------------------------------------------------

describe("VirtualPlatformIO mount resolution", () => {
  it("honors set-ID mode bits when nosuid is omitted", () => {
    const root = createMockBackend();
    const vfs = new VirtualPlatformIO(
      [{ mountPoint: "/", backend: root }],
      new NodeTimeProvider(),
    );

    expect(vfs.statfs("/bin/tool").flags & ST_NOSUID).toBe(0);
  });

  it("routes root-level paths to the / mount", () => {
    const root = createMockBackend();
    const vfs = new VirtualPlatformIO(
      [{ mountPoint: "/", backend: root }],
      new NodeTimeProvider(),
    );
    vfs.stat("/etc/hosts");
    expect(root.calls).toContain("stat:/etc/hosts");
  });

  it("routes /tmp paths to the /tmp mount", () => {
    const root = createMockBackend();
    const tmp = createMockBackend();
    const vfs = new VirtualPlatformIO(
      [
        { mountPoint: "/", backend: root },
        { mountPoint: "/tmp", backend: tmp },
      ],
      new NodeTimeProvider(),
    );
    vfs.stat("/tmp/foo");
    expect(tmp.calls).toContain("stat:/foo");
    expect(root.calls).not.toContain("stat:/tmp/foo");
  });

  it("routes lchown by the final link pathname rather than its target", () => {
    const root = createMockBackend();
    const tmp = createMockBackend();
    const vfs = new VirtualPlatformIO(
      [
        { mountPoint: "/", backend: root },
        { mountPoint: "/tmp", backend: tmp },
      ],
      new NodeTimeProvider(),
    );

    vfs.lchown("/tmp/link-to-root", 123, 456);

    expect(tmp.calls).toContain("lchown:/link-to-root");
    expect(root.calls).not.toContain("lchown:/tmp/link-to-root");
  });

  it("does not route /home/foo to /tmp mount", () => {
    const root = createMockBackend();
    const tmp = createMockBackend();
    const vfs = new VirtualPlatformIO(
      [
        { mountPoint: "/", backend: root },
        { mountPoint: "/tmp", backend: tmp },
      ],
      new NodeTimeProvider(),
    );
    vfs.stat("/home/foo");
    expect(root.calls).toContain("stat:/home/foo");
    expect(tmp.calls.length).toBe(0);
  });

  it("longest prefix wins: /tmp/data beats /tmp", () => {
    const tmp = createMockBackend();
    const tmpData = createMockBackend();
    const vfs = new VirtualPlatformIO(
      [
        { mountPoint: "/", backend: createMockBackend() },
        { mountPoint: "/tmp", backend: tmp },
        { mountPoint: "/tmp/data", backend: tmpData },
      ],
      new NodeTimeProvider(),
    );
    vfs.stat("/tmp/data/file.csv");
    expect(tmpData.calls).toContain("stat:/file.csv");
    expect(tmp.calls.length).toBe(0);
  });

  it("exact mount-point path routes correctly", () => {
    const tmp = createMockBackend();
    const vfs = new VirtualPlatformIO(
      [
        { mountPoint: "/", backend: createMockBackend() },
        { mountPoint: "/tmp", backend: tmp },
      ],
      new NodeTimeProvider(),
    );
    vfs.stat("/tmp");
    expect(tmp.calls).toContain("stat:/");
  });

  it("strips trailing slashes from mount points", () => {
    const tmp = createMockBackend();
    const vfs = new VirtualPlatformIO(
      [
        { mountPoint: "/", backend: createMockBackend() },
        { mountPoint: "/tmp/", backend: tmp },
      ],
      new NodeTimeProvider(),
    );
    vfs.stat("/tmp/abc");
    expect(tmp.calls).toContain("stat:/abc");
  });
});

describe("VirtualPlatformIO file identity", () => {
  it("qualifies stat, lstat, and fstat device IDs by backend object", () => {
    const localDevice = (1n << 60n) + 17n;
    const root = createMockBackend();
    const first = createMockBackend({ dev: localDevice, ino: 2n });
    const second = createMockBackend({ dev: localDevice, ino: 2n });
    const vfs = new VirtualPlatformIO(
      [
        { mountPoint: "/", backend: root },
        { mountPoint: "/first", backend: first },
        { mountPoint: "/second", backend: second },
      ],
      new NodeTimeProvider(),
    );

    const firstStat = vfs.stat("/first/file");
    const secondStat = vfs.stat("/second/file");
    expect(typeof firstStat.dev).toBe("bigint");
    expect(firstStat.dev).not.toBe(secondStat.dev);
    expect(vfs.lstat("/first/file").dev).toBe(firstStat.dev);

    const handle = vfs.open("/first/file", O_RDONLY, 0);
    expect(vfs.fstat(handle).dev).toBe(firstStat.dev);
    vfs.close(handle);
  });

  it("shares qualified device IDs across alias mounts of one backend", () => {
    const root = createMockBackend();
    const shared = createMockBackend({
      dev: (1n << 60n) + 23n,
      ino: 9n,
    });
    const vfs = new VirtualPlatformIO(
      [
        { mountPoint: "/", backend: root },
        { mountPoint: "/one", backend: shared },
        { mountPoint: "/two", backend: shared },
      ],
      new NodeTimeProvider(),
    );

    expect(vfs.stat("/one/alias").dev).toBe(vfs.stat("/two/alias").dev);
  });

  it("keeps distinct backend-local devices distinct within one backend", () => {
    const root = createMockBackend();
    const shared = createMockBackend();
    const stat = shared.stat.bind(shared);
    shared.stat = (path) => ({
      ...stat(path),
      dev: path === "/first" ? (1n << 60n) + 31n : (1n << 60n) + 32n,
    });
    const vfs = new VirtualPlatformIO(
      [
        { mountPoint: "/", backend: root },
        { mountPoint: "/shared", backend: shared },
      ],
      new NodeTimeProvider(),
    );

    expect(vfs.stat("/shared/first").dev).not.toBe(
      vfs.stat("/shared/second").dev,
    );
  });

  it("rejects imprecise numeric inode identities", () => {
    const backend = createMockBackend({
      dev: 1,
      ino: Number.MAX_SAFE_INTEGER + 1,
    });
    const vfs = new VirtualPlatformIO(
      [{ mountPoint: "/", backend }],
      new NodeTimeProvider(),
    );

    expect(() => vfs.stat("/unsafe-inode")).toThrow(/EOVERFLOW: st_ino/);
  });

  it("qualifies colliding inode numbers by backend", () => {
    const root = createMockBackend();
    const first = createMockBackend();
    const second = createMockBackend();
    const vfs = new VirtualPlatformIO(
      [
        { mountPoint: "/", backend: root },
        { mountPoint: "/first", backend: first },
        { mountPoint: "/second", backend: second },
      ],
      new NodeTimeProvider(),
    );

    expect(vfs.fileIdentity("/first/file", 0n, 2n)).not.toBe(
      vfs.fileIdentity("/second/file", 0n, 2n),
    );
  });

  it("uses one namespace when the same backend is mounted twice", () => {
    const root = createMockBackend();
    const shared = createMockBackend();
    const vfs = new VirtualPlatformIO(
      [
        { mountPoint: "/", backend: root },
        { mountPoint: "/one", backend: shared },
        { mountPoint: "/two", backend: shared },
      ],
      new NodeTimeProvider(),
    );

    expect(vfs.fileIdentity("/one/alias", 0n, 7n)).toBe(
      vfs.fileIdentity("/two/alias", 0n, 7n),
    );
  });

  it("rejects a backend that supplies no stable inode", () => {
    const vfs = new VirtualPlatformIO(
      [{ mountPoint: "/", backend: createMockBackend() }],
      new NodeTimeProvider(),
    );

    expect(vfs.fileIdentity("/file", 0n, 0n)).toBeNull();
  });

  it("derives identity from live handles after unlink and rename", () => {
    const backend = MemoryFileSystem.create(
      new SharedArrayBuffer(4 * 1024 * 1024),
    );
    const vfs = new VirtualPlatformIO(
      [{ mountPoint: "/", backend }],
      new NodeTimeProvider(),
    );

    const unlinked = vfs.open("/unlinked", O_CREAT | O_RDWR, 0o600);
    const unlinkedStat = vfs.fstat(unlinked);
    const unlinkedIdentity = vfs.fileHandleIdentity(
      unlinked,
      BigInt(unlinkedStat.dev),
      BigInt(unlinkedStat.ino),
    );
    expect(unlinkedIdentity).not.toBeNull();
    vfs.unlink("/unlinked");
    expect(vfs.fileHandleIdentity(
      unlinked,
      BigInt(unlinkedStat.dev),
      BigInt(unlinkedStat.ino),
    )).toBe(unlinkedIdentity);

    const renamed = vfs.open("/before", O_CREAT | O_RDWR, 0o600);
    const renamedStat = vfs.fstat(renamed);
    const renamedIdentity = vfs.fileHandleIdentity(
      renamed,
      BigInt(renamedStat.dev),
      BigInt(renamedStat.ino),
    );
    expect(renamedIdentity).not.toBeNull();
    vfs.rename("/before", "/after");
    expect(vfs.fileHandleIdentity(
      renamed,
      BigInt(renamedStat.dev),
      BigInt(renamedStat.ino),
    )).toBe(renamedIdentity);

    vfs.close(unlinked);
    vfs.close(renamed);
  });
});

// ---------------------------------------------------------------------------
// 2. Handle mapping tests
// ---------------------------------------------------------------------------

describe("VirtualPlatformIO handle mapping", () => {
  it("returns unique global handles that map to backend-local handles", () => {
    const backend = createMockBackend();
    const vfs = new VirtualPlatformIO(
      [{ mountPoint: "/", backend }],
      new NodeTimeProvider(),
    );

    const h1 = vfs.open("/a", 0, 0);
    const h2 = vfs.open("/b", 0, 0);

    expect(h1).not.toBe(h2);
    // Both should have delegated to backend.open
    expect(backend.calls.filter((c) => c.startsWith("open:"))).toHaveLength(2);
  });

  it("delegates read/write/seek to the correct backend via handle", () => {
    const root = createMockBackend();
    const tmp = createMockBackend();
    const vfs = new VirtualPlatformIO(
      [
        { mountPoint: "/", backend: root },
        { mountPoint: "/tmp", backend: tmp },
      ],
      new NodeTimeProvider(),
    );

    const hRoot = vfs.open("/etc/file", 0, 0);
    const hTmp = vfs.open("/tmp/file", 0, 0);

    const buf = new Uint8Array(8);
    vfs.read(hRoot, buf, null, 8);
    vfs.write(hTmp, buf, null, 8);

    expect(root.calls).toContain("read:1");
    expect(tmp.calls).toContain("write:1");
    // The other backend should not see cross-traffic
    expect(root.calls.filter((c) => c.startsWith("write:"))).toHaveLength(0);
    expect(tmp.calls.filter((c) => c.startsWith("read:"))).toHaveLength(0);
  });

  it("close removes handle mapping; reuse errors", () => {
    const backend = createMockBackend();
    const vfs = new VirtualPlatformIO(
      [{ mountPoint: "/", backend }],
      new NodeTimeProvider(),
    );

    const h = vfs.open("/file", 0, 0);
    vfs.close(h);

    expect(() => vfs.read(h, new Uint8Array(4), null, 4)).toThrow("EBADF");
  });
});

// ---------------------------------------------------------------------------
// 3. Cross-mount EXDEV test
// ---------------------------------------------------------------------------

describe("VirtualPlatformIO cross-mount rename (EXDEV)", () => {
  it("throws EXDEV when renaming across mounts", () => {
    const root = createMockBackend();
    const tmp = createMockBackend();
    const vfs = new VirtualPlatformIO(
      [
        { mountPoint: "/", backend: root },
        { mountPoint: "/tmp", backend: tmp },
      ],
      new NodeTimeProvider(),
    );

    expect(() => vfs.rename("/tmp/a", "/home/b")).toThrow("EXDEV");
  });

  it("succeeds when renaming within the same mount", () => {
    const tmp = createMockBackend();
    const vfs = new VirtualPlatformIO(
      [
        { mountPoint: "/", backend: createMockBackend() },
        { mountPoint: "/tmp", backend: tmp },
      ],
      new NodeTimeProvider(),
    );

    vfs.rename("/tmp/a", "/tmp/b");
    expect(tmp.calls).toContain("rename:/a:/b");
  });

  it("throws EXDEV for cross-mount link", () => {
    const root = createMockBackend();
    const tmp = createMockBackend();
    const vfs = new VirtualPlatformIO(
      [
        { mountPoint: "/", backend: root },
        { mountPoint: "/tmp", backend: tmp },
      ],
      new NodeTimeProvider(),
    );

    expect(() => vfs.link("/tmp/a", "/home/b")).toThrow("EXDEV");
  });
});

// ---------------------------------------------------------------------------
// 4. Path traversal guard (HostFileSystem)
// ---------------------------------------------------------------------------

describe("HostFileSystem path traversal", () => {
  it("rejects paths that escape rootPath", () => {
    const root = mkdtempSync(join(tmpdir(), "kandelo-host-fs-traversal-"));
    try {
      const hfs = new HostFileSystem(root);
      expect(() => hfs.stat("/../../../etc/passwd")).toThrow("EACCES");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects paths with embedded .. sequences", () => {
    const root = mkdtempSync(join(tmpdir(), "kandelo-host-fs-traversal-"));
    try {
      mkdirSync(join(root, "subdir"));
      const hfs = new HostFileSystem(root);
      expect(() => hfs.stat("/subdir/../../etc/passwd")).toThrow("EACCES");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 5. MemoryFileSystem round-trip
// ---------------------------------------------------------------------------

describe("MemoryFileSystem", () => {
  it("creates, writes, seeks, and reads back a file", () => {
    const sab = new SharedArrayBuffer(4 * 1024 * 1024);
    const mfs = MemoryFileSystem.create(sab);
    const O_CREAT = 0x0040,
      O_RDWR = 0x0002,
      O_TRUNC = 0x0200;
    const fd = mfs.open("/test.txt", O_CREAT | O_RDWR | O_TRUNC, 0o644);
    const data = new TextEncoder().encode("hello world");
    const written = mfs.write(fd, data, null, data.length);
    expect(written).toBe(data.length);
    mfs.seek(fd, 0, 0); // SEEK_SET
    const buf = new Uint8Array(32);
    const bytesRead = mfs.read(fd, buf, null, 32);
    expect(bytesRead).toBe(data.length);
    expect(new TextDecoder().decode(buf.subarray(0, bytesRead))).toBe(
      "hello world",
    );
    mfs.close(fd);
  });

  it("routes complete set-ID invalidation semantics through VirtualPlatformIO", () => {
    const sab = new SharedArrayBuffer(4 * 1024 * 1024);
    const mfs = MemoryFileSystem.create(sab);
    const path = "/mutation-matrix";
    const localFd = mfs.open(path, O_CREAT | O_RDWR | O_TRUNC, 0o6755);
    mfs.close(localFd);
    const vfs = new VirtualPlatformIO(
      [{ mountPoint: "/", backend: mfs }],
      new NodeTimeProvider(),
    );
    const fd = vfs.open(path, O_RDWR, 0);
    const byte = new Uint8Array([0x78]);
    const expectMode = (mode: number): void => {
      expect(vfs.stat(path).mode & 0o7777).toBe(mode);
      expect(vfs.fstat(fd).mode & 0o7777).toBe(mode);
    };
    const arm = (mode = 0o6755): void => {
      vfs.chmod(path, mode);
      expectMode(mode);
    };

    try {
      arm();
      expect(vfs.write(fd, byte, null, 1)).toBe(1);
      expectMode(0o755);

      arm();
      expect(vfs.write(fd, byte, 0, 1)).toBe(1);
      expectMode(0o755);

      arm();
      expect(vfs.append(fd, byte, 1, null).written).toBe(1);
      expectMode(0o755);

      arm();
      const truncateFd = vfs.open(path, O_RDWR | O_TRUNC, 0);
      vfs.close(truncateFd);
      expectMode(0o755);

      expect(vfs.write(fd, byte, 0, 1)).toBe(1);
      arm();
      vfs.ftruncate(fd, 0);
      expectMode(0o755);

      arm();
      vfs.chown(path, 1001, 2001);
      expectMode(0o755);

      arm();
      vfs.fchown(fd, 1002, 2002);
      expectMode(0o755);

      arm();
      vfs.lchown(path, 1003, 2003);
      expectMode(0o755);

      arm(0o6600);
      expect(vfs.write(fd, byte, 0, 1)).toBe(1);
      expectMode(0o600);

      arm(0o6600);
      vfs.chown(path, 1004, 2004);
      expectMode(0o600);

      arm();
      expect(vfs.write(fd, byte, null, 0)).toBe(0);
      expect(vfs.write(fd, byte, 0, 0)).toBe(0);
      expect(vfs.append(fd, byte, 0, null).written).toBe(0);
      expectMode(0o6755);

      const unchangedSize = vfs.fstat(fd).size;
      vfs.ftruncate(fd, unchangedSize);
      expectMode(0o6755);
      if (unchangedSize !== 0) {
        vfs.ftruncate(fd, 0);
        arm();
      }
      const emptyTruncateFd = vfs.open(path, O_RDWR | O_TRUNC, 0);
      vfs.close(emptyTruncateFd);
      expectMode(0o6755);

      const readOnlyFd = vfs.open(path, O_RDONLY, 0);
      try {
        expect(() => vfs.write(readOnlyFd, byte, null, 1)).toThrow();
        expect(() => vfs.ftruncate(readOnlyFd, 0)).toThrow();
      } finally {
        vfs.close(readOnlyFd);
      }
      expectMode(0o6755);
    } finally {
      vfs.close(fd);
    }

    vfs.mkdir("/mutation-directory", 0o6770);
    vfs.chown("/mutation-directory", 3001, 3002);
    expect(vfs.stat("/mutation-directory").mode & 0o7777).toBe(0o6770);
  });

  it("routes positive and failed mutation attempts without changing armed mode", () => {
    const mfs = MemoryFileSystem.create(new SharedArrayBuffer(4 * 1024 * 1024));
    const path = "/mutation-failures";
    const localFd = mfs.open(path, O_CREAT | O_RDWR | O_TRUNC, 0o600);
    mfs.close(localFd);
    const vfs = new VirtualPlatformIO(
      [{ mountPoint: "/", backend: mfs }],
      new NodeTimeProvider(),
    );
    const fd = vfs.open(path, O_RDWR, 0);
    const bytes = new Uint8Array([0x78, 0x79]);
    const expectMode = (mode: number): void => {
      expect(vfs.stat(path).mode & 0o7777).toBe(mode);
      expect(vfs.fstat(fd).mode & 0o7777).toBe(mode);
    };
    const arm = (): void => {
      vfs.chmod(path, 0o6755);
      expectMode(0o6755);
    };
    const expectFailure = (operation: () => unknown): void => {
      expect(operation).toThrow();
      expectMode(0o6755);
    };

    try {
      arm();
      expect(vfs.write(fd, bytes, null, 1)).toBe(1);
      expectMode(0o755);

      arm();
      expect(vfs.write(fd, bytes, 0, 1)).toBe(1);
      expectMode(0o755);

      arm();
      const limit = vfs.fstat(fd).size + 1;
      expect(vfs.append(fd, bytes, bytes.length, limit).written).toBe(1);
      expectMode(0o755);

      arm();
      const readOnlyFd = vfs.open(path, O_RDONLY, 0);
      try {
        expectFailure(() => vfs.write(readOnlyFd, bytes, null, 1));
        expectFailure(() => vfs.write(readOnlyFd, bytes, 0, 1));
        expectFailure(() => vfs.append(readOnlyFd, bytes, 1, null));
        expectFailure(() => vfs.ftruncate(readOnlyFd, 0));
      } finally {
        vfs.close(readOnlyFd);
      }

      expectFailure(() => vfs.open("/missing-truncate", O_RDWR | O_TRUNC, 0));
      expectFailure(() => vfs.chown("/missing-chown", 1000, 2000));
      expectFailure(() => vfs.fchown(999_999, 1000, 2000));
      expectFailure(() => vfs.lchown("/missing-lchown", 1000, 2000));
    } finally {
      vfs.close(fd);
    }
  });

  it("opens more than the old 64-descriptor SharedFS table limit", () => {
    expect(MAX_FDS).toBe(
      Math.floor((BLOCK_SIZE - FD_TABLE_OFFSET) / FD_ENTRY_SIZE),
    );
    expect(MAX_FDS).toBeGreaterThan(64);

    const sab = new SharedArrayBuffer(4 * 1024 * 1024);
    const mfs = MemoryFileSystem.create(sab);
    const createFd = mfs.open(
      "/many-fds.txt",
      O_CREAT | O_RDWR | O_TRUNC,
      0o644,
    );
    mfs.close(createFd);

    const fds: number[] = [];
    try {
      for (let i = 0; i < 65; i++) {
        fds.push(mfs.open("/many-fds.txt", O_RDONLY, 0o644));
      }
      expect(new Set(fds).size).toBe(65);
      expect(Math.max(...fds)).toBeGreaterThanOrEqual(64);
    } finally {
      for (const fd of fds) mfs.close(fd);
    }
  });

  it("throws EMFILE when the derived SharedFS fd table is full", () => {
    expect(MAX_FDS).toBeLessThanOrEqual(160);

    const sab = new SharedArrayBuffer(4 * 1024 * 1024);
    const mfs = MemoryFileSystem.create(sab);
    const createFd = mfs.open(
      "/fd-limit.txt",
      O_CREAT | O_RDWR | O_TRUNC,
      0o644,
    );
    mfs.close(createFd);

    const fds: number[] = [];
    let error: unknown;
    try {
      for (let i = 0; i < MAX_FDS; i++) {
        fds.push(mfs.open("/fd-limit.txt", O_RDONLY, 0o644));
      }
      const unexpectedFd = mfs.open("/fd-limit.txt", O_RDONLY, 0o644);
      fds.push(unexpectedFd);
    } catch (err) {
      error = err;
    } finally {
      for (const fd of fds) mfs.close(fd);
    }

    expect(error).toBeInstanceOf(SFSError);
    expect((error as SFSError).code).toBe(EMFILE);
  });

  it("routes O_TRUNC EMFILE without changing the selected file", () => {
    const mfs = MemoryFileSystem.create(new SharedArrayBuffer(4 * 1024 * 1024));
    const vfs = new VirtualPlatformIO(
      [{ mountPoint: "/", backend: mfs }],
      new NodeTimeProvider(),
    );
    const path = "/routed-emfile-truncate";
    const contents = new TextEncoder().encode("routed bytes remain");
    const fd = vfs.open(path, O_CREAT | O_RDWR, 0o600);
    expect(vfs.write(fd, contents, null, contents.byteLength)).toBe(
      contents.byteLength,
    );
    vfs.chown(path, 2468, 1357);
    vfs.chmod(path, 0o6755);

    const fillers: number[] = [];
    try {
      for (let index = 1; index < MAX_FDS; index++) {
        fillers.push(vfs.open(path, O_RDONLY, 0));
      }

      let failure: unknown;
      try {
        vfs.open(path, O_RDWR | O_TRUNC, 0);
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(SFSError);
      expect((failure as SFSError).code).toBe(EMFILE);

      const pathStat = vfs.stat(path);
      const fdStat = vfs.fstat(fd);
      expect(pathStat).toMatchObject({
        size: contents.byteLength,
        uid: 2468,
        gid: 1357,
      });
      expect(fdStat).toMatchObject({
        size: contents.byteLength,
        uid: 2468,
        gid: 1357,
      });
      expect(pathStat.mode & 0o7777).toBe(0o6755);
      expect(fdStat.mode & 0o7777).toBe(0o6755);
      const observed = new Uint8Array(contents.byteLength);
      expect(vfs.read(fd, observed, 0, observed.byteLength)).toBe(
        contents.byteLength,
      );
      expect(observed).toEqual(contents);
    } finally {
      for (const filler of fillers) vfs.close(filler);
      vfs.close(fd);
    }
  });

  it("routes O_RDONLY | O_TRUNC without granting write access", () => {
    const mfs = MemoryFileSystem.create(new SharedArrayBuffer(1024 * 1024));
    const vfs = new VirtualPlatformIO(
      [{ mountPoint: "/", backend: mfs }],
      new NodeTimeProvider(),
    );
    const path = "/routed-read-only-truncate";
    const seed = vfs.open(path, O_CREAT | O_RDWR, 0o600);
    expect(vfs.write(seed, new TextEncoder().encode("truncate me"), null, 11))
      .toBe(11);
    vfs.close(seed);
    vfs.chmod(path, 0o6755);

    const fd = vfs.open(path, O_RDONLY | O_TRUNC, 0);
    try {
      expect(vfs.stat(path).size).toBe(0);
      expect(vfs.fstat(fd).size).toBe(0);
      expect(vfs.stat(path).mode & 0o7777).toBe(0o755);
      expect(vfs.fstat(fd).mode & 0o7777).toBe(0o755);
      expect(() =>
        vfs.write(fd, new Uint8Array([0x78]), null, 1)
      ).toThrow();
    } finally {
      vfs.close(fd);
    }
  });

  it("creates and lists directories", () => {
    const sab = new SharedArrayBuffer(4 * 1024 * 1024);
    const mfs = MemoryFileSystem.create(sab);
    mfs.mkdir("/mydir", 0o755);
    // Create a file in the dir
    const O_CREAT = 0x0040,
      O_WRONLY = 0x0001;
    const fd = mfs.open("/mydir/file.txt", O_CREAT | O_WRONLY, 0o644);
    mfs.close(fd);
    // List dir
    const dh = mfs.opendir("/mydir");
    const entries: string[] = [];
    let entry;
    while ((entry = mfs.readdir(dh)) !== null) {
      entries.push(entry.name);
    }
    mfs.closedir(dh);
    expect(entries).toContain("file.txt");
  });

  it("reports raw inode numbers that remain representable after inode reuse", () => {
    const sab = new SharedArrayBuffer(4 * 1024 * 1024);
    const mfs = MemoryFileSystem.create(sab);
    const O_CREAT = 0x0040,
      O_RDWR = 0x0002,
      O_TRUNC = 0x0200;

    // SharedFS tracks an internal generation counter for reused inode slots.
    // POSIX st_ino does not need to include that generation, and exposing it
    // can overflow 32-bit guest language APIs while tools like ls(1) print the
    // full kernel value.
    for (let i = 0; i < 2_100; i++) {
      const fd = mfs.open("/reuse.txt", O_CREAT | O_RDWR | O_TRUNC, 0o644);
      mfs.close(fd);
      mfs.unlink("/reuse.txt");
    }

    const fd = mfs.open("/reuse.txt", O_CREAT | O_RDWR | O_TRUNC, 0o644);
    const stat = mfs.fstat(fd);
    expect(stat.ino).toBeGreaterThan(0);
    expect(stat.ino).toBeLessThanOrEqual(0x7fffffff);

    const dh = mfs.opendir("/");
    let entry;
    let dirIno: number | null = null;
    while ((entry = mfs.readdir(dh)) !== null) {
      if (entry.name === "reuse.txt") {
        dirIno = entry.ino;
        break;
      }
    }
    mfs.closedir(dh);
    expect(dirIno).toBe(stat.ino);
    mfs.close(fd);
  });

  it("keeps large-directory indexes coherent across SharedFS instances", () => {
    const sab = new SharedArrayBuffer(8 * 1024 * 1024);
    const first = MemoryFileSystem.create(sab);
    const second = MemoryFileSystem.fromExisting(sab);
    first.mkdir("/bulk", 0o755);

    const names: string[] = [];
    for (let i = 0; i < 340; i++) {
      const name = `/bulk/${String(i).padStart(4, "0")}-${"x".repeat(180)}`;
      names.push(name);
      const fd = first.open(name, O_CREAT | O_RDWR, 0o644);
      first.close(fd);
    }

    // Populate the first mount's index, then reuse a deleted slot through a
    // second mount without changing the directory's byte size.
    expect(first.stat(names.at(-1)!).mode & 0xf000).toBe(0x8000);
    second.unlink(names[100]);
    const replacement = `/bulk/repl-${"y".repeat(180)}`;
    const replacementFd = second.open(replacement, O_CREAT | O_RDWR, 0o644);
    second.close(replacementFd);

    expect(first.stat(replacement).mode & 0xf000).toBe(0x8000);
    expect(() => first.stat(names[100])).toThrow(/No such file/);
  });

  it("honors O_CREAT|O_EXCL by failing when the final path already exists", () => {
    const sab = new SharedArrayBuffer(4 * 1024 * 1024);
    const mfs = MemoryFileSystem.create(sab);
    const O_WRONLY = 0x0001,
      O_CREAT = 0x0040,
      O_EXCL = 0x0080;

    const fd = mfs.open("/exclusive.txt", O_WRONLY | O_CREAT | O_EXCL, 0o600);
    mfs.close(fd);

    expect(() =>
      mfs.open("/exclusive.txt", O_WRONLY | O_CREAT | O_EXCL, 0o600),
    ).toThrow(/File exists/);

    // POSIX open(O_CREAT|O_EXCL) must fail with EEXIST when the final path is
    // a symbolic link, even if the symlink points at an existing regular file.
    mfs.symlink("/exclusive.txt", "/exclusive-link.txt");
    expect(() =>
      mfs.open("/exclusive-link.txt", O_WRONLY | O_CREAT | O_EXCL, 0o600),
    ).toThrow(/File exists/);
  });

  it("stat returns correct size after writing", () => {
    const sab = new SharedArrayBuffer(4 * 1024 * 1024);
    const mfs = MemoryFileSystem.create(sab);
    const O_CREAT = 0x0040,
      O_RDWR = 0x0002,
      O_TRUNC = 0x0200;
    const fd = mfs.open("/sized.txt", O_CREAT | O_RDWR | O_TRUNC, 0o644);
    const data = new TextEncoder().encode("12345");
    mfs.write(fd, data, null, data.length);
    const st = mfs.fstat(fd);
    expect(st.size).toBe(5);
    mfs.close(fd);
  });

  it("updates mtime and ctime after file writes and truncates", () => {
    const now = vi.spyOn(Date, "now");
    try {
      const sab = new SharedArrayBuffer(4 * 1024 * 1024);
      now.mockReturnValue(1_000);
      const mfs = MemoryFileSystem.create(sab);
      const O_CREAT = 0x0040,
        O_RDWR = 0x0002,
        O_TRUNC = 0x0200;
      const fd = mfs.open("/timestamps.txt", O_CREAT | O_RDWR | O_TRUNC, 0o644);
      const initial = mfs.fstat(fd);

      now.mockReturnValue(5_000);
      mfs.write(fd, new TextEncoder().encode("abc"), null, 3);
      const afterWrite = mfs.fstat(fd);
      expect(afterWrite.mtimeMs).toBe(5_000);
      expect(afterWrite.ctimeMs).toBe(5_000);
      expect(afterWrite.mtimeMs).toBeGreaterThan(initial.mtimeMs);

      now.mockReturnValue(9_000);
      mfs.ftruncate(fd, 1);
      const afterTruncate = mfs.fstat(fd);
      expect(afterTruncate.mtimeMs).toBe(9_000);
      expect(afterTruncate.ctimeMs).toBe(9_000);
      expect(afterTruncate.mtimeMs).toBeGreaterThan(afterWrite.mtimeMs);
      mfs.close(fd);
    } finally {
      now.mockRestore();
    }
  });

  it("unlink removes a file", () => {
    const sab = new SharedArrayBuffer(4 * 1024 * 1024);
    const mfs = MemoryFileSystem.create(sab);
    const O_CREAT = 0x0040,
      O_WRONLY = 0x0001;
    const fd = mfs.open("/todelete.txt", O_CREAT | O_WRONLY, 0o644);
    mfs.close(fd);
    mfs.unlink("/todelete.txt");
    expect(() => mfs.stat("/todelete.txt")).toThrow();
  });

  it("rejects unlink paths with a trailing slash on non-directories", () => {
    const sab = new SharedArrayBuffer(4 * 1024 * 1024);
    const mfs = MemoryFileSystem.create(sab);
    const O_CREAT = 0x0040,
      O_WRONLY = 0x0001;

    const fd = mfs.open("/file.txt", O_CREAT | O_WRONLY, 0o644);
    mfs.close(fd);
    mfs.symlink("/file.txt", "/link.txt");

    expect(() => mfs.unlink("/file.txt/")).toThrow(/Not a directory/);
    expect(() => mfs.unlink("/link.txt/")).toThrow(/Not a directory/);
    expect(mfs.stat("/file.txt").mode & 0xf000).toBe(0x8000);
    expect(mfs.readlink("/link.txt")).toBe("/file.txt");
  });

  it("rejects rename source paths that require a non-directory to be a directory", () => {
    const sab = new SharedArrayBuffer(4 * 1024 * 1024);
    const mfs = MemoryFileSystem.create(sab);
    const O_CREAT = 0x0040,
      O_WRONLY = 0x0001;

    const fd = mfs.open("/file.txt", O_CREAT | O_WRONLY, 0o644);
    mfs.close(fd);

    expect(() => mfs.rename("/file.txt/", "/renamed.txt")).toThrow(
      /Not a directory/,
    );
    expect(mfs.stat("/file.txt").size).toBe(0);
    expect(() => mfs.stat("/renamed.txt")).toThrow(/No such file/);
  });

  it("preserves POSIX type checks when renaming directories onto existing paths", () => {
    const sab = new SharedArrayBuffer(4 * 1024 * 1024);
    const mfs = MemoryFileSystem.create(sab);
    const O_CREAT = 0x0040,
      O_WRONLY = 0x0001;

    mfs.mkdir("/dir", 0o755);
    const fd = mfs.open("/file.txt", O_CREAT | O_WRONLY, 0o644);
    mfs.close(fd);
    mfs.symlink("/file.txt", "/link.txt");

    expect(() => mfs.rename("/dir", "/file.txt")).toThrow(/Not a directory/);
    expect(() => mfs.rename("/dir", "/link.txt")).toThrow(/Not a directory/);

    expect(mfs.stat("/dir").mode & 0xf000).toBe(0x4000);
    expect(mfs.stat("/file.txt").mode & 0xf000).toBe(0x8000);
    expect(mfs.readlink("/link.txt")).toBe("/file.txt");
  });

  it("renames directories over empty directories and updates dot-dot", () => {
    const sab = new SharedArrayBuffer(4 * 1024 * 1024);
    const mfs = MemoryFileSystem.create(sab);
    const O_CREAT = 0x0040,
      O_WRONLY = 0x0001;

    mfs.mkdir("/old-parent", 0o755);
    mfs.mkdir("/new-parent", 0o755);
    mfs.mkdir("/old-parent/child", 0o755);
    const siblingFd = mfs.open(
      "/new-parent/sibling.txt",
      O_CREAT | O_WRONLY,
      0o644,
    );
    mfs.close(siblingFd);

    mfs.rename("/old-parent/child", "/new-parent/child");
    expect(mfs.stat("/new-parent/child/../sibling.txt").mode & 0xf000).toBe(
      0x8000,
    );

    mfs.mkdir("/empty-dest", 0o755);
    mfs.rename("/new-parent/child", "/empty-dest");
    expect(mfs.stat("/empty-dest").mode & 0xf000).toBe(0x4000);
    expect(() => mfs.stat("/new-parent/child")).toThrow(/No such file/);
  });

  it("rejects rename and rmdir operands ending in dot or dot-dot", () => {
    const sab = new SharedArrayBuffer(4 * 1024 * 1024);
    const mfs = MemoryFileSystem.create(sab);
    mfs.mkdir("/dir", 0o755);
    mfs.mkdir("/dir/child", 0o755);

    expect(() => mfs.rename("/dir/.", "/moved")).toThrow(/Invalid argument/);
    expect(() => mfs.rename("/dir/child", "/dir/..")).toThrow(/Invalid argument/);
    expect(() => mfs.rmdir("/dir/.")).toThrow(/Invalid argument/);
    expect(() => mfs.rmdir("/dir/child/..")).toThrow(/Invalid argument/);
    expect(mfs.stat("/dir/child").mode & 0xf000).toBe(0x4000);
  });

  it("chmod and fchmod preserve the inode file type", () => {
    const sab = new SharedArrayBuffer(4 * 1024 * 1024);
    const mfs = MemoryFileSystem.create(sab);
    const fd = mfs.open("/regular", O_CREAT | O_RDWR, 0o644);

    mfs.chmod("/regular", 0o040755);
    expect(mfs.stat("/regular").mode & 0xf000).toBe(0x8000);
    mfs.fchmod(fd, 0o040700);
    expect(mfs.fstat(fd).mode & 0xf000).toBe(0x8000);
    mfs.close(fd);
  });

  it("keeps an unlinked open file alive until close", () => {
    const sab = new SharedArrayBuffer(4 * 1024 * 1024);
    const mfs = MemoryFileSystem.create(sab);
    const O_CREAT = 0x0040,
      O_RDWR = 0x0002,
      O_TRUNC = 0x0200;

    const oldFd = mfs.open("/open.txt", O_CREAT | O_RDWR | O_TRUNC, 0o644);
    const oldData = new TextEncoder().encode("old");
    mfs.write(oldFd, oldData, null, oldData.length);
    mfs.unlink("/open.txt");
    expect(() => mfs.stat("/open.txt")).toThrow();

    const newFd = mfs.open("/open.txt", O_CREAT | O_RDWR | O_TRUNC, 0o644);
    const newData = new TextEncoder().encode("newer");
    mfs.write(newFd, newData, null, newData.length);

    mfs.seek(oldFd, 0, 0);
    const oldBuf = new Uint8Array(8);
    const oldRead = mfs.read(oldFd, oldBuf, null, oldBuf.length);
    expect(new TextDecoder().decode(oldBuf.subarray(0, oldRead))).toBe("old");

    mfs.seek(newFd, 0, 0);
    const newBuf = new Uint8Array(8);
    const newRead = mfs.read(newFd, newBuf, null, newBuf.length);
    expect(new TextDecoder().decode(newBuf.subarray(0, newRead))).toBe("newer");

    mfs.close(oldFd);
    mfs.close(newFd);
  });

  it("ftruncate changes file size", () => {
    const sab = new SharedArrayBuffer(4 * 1024 * 1024);
    const mfs = MemoryFileSystem.create(sab);
    const O_CREAT = 0x0040,
      O_RDWR = 0x0002,
      O_TRUNC = 0x0200;
    const fd = mfs.open("/trunc.txt", O_CREAT | O_RDWR | O_TRUNC, 0o644);
    const data = new TextEncoder().encode("abcdefghij");
    mfs.write(fd, data, null, data.length);
    expect(mfs.fstat(fd).size).toBe(10);
    mfs.ftruncate(fd, 5);
    expect(mfs.fstat(fd).size).toBe(5);
    mfs.close(fd);
  });

  it("statfs reports real SharedFS block usage", () => {
    const sab = new SharedArrayBuffer(4 * 1024 * 1024);
    const mfs = MemoryFileSystem.create(sab);
    const before = mfs.statfs("/");
    const fd = mfs.open("/blocks.bin", 0x0040 | 0x0002 | 0x0200, 0o644);
    const data = new Uint8Array(8192);
    mfs.write(fd, data, null, data.length);
    mfs.close(fd);
    const after = mfs.statfs("/");
    expect(after.blocks).toBe(before.blocks);
    expect(after.bfree).toBeLessThan(before.bfree);
    expect(after.bavail).toBe(after.bfree);
  });

  it("statfs reports effective max capacity for growable filesystems", () => {
    const initialBytes = 1 * 1024 * 1024;
    const maxBytes = 8 * 1024 * 1024;
    const sab = new SharedArrayBuffer(initialBytes, {
      maxByteLength: maxBytes,
    });
    const mfs = MemoryFileSystem.create(sab, maxBytes);

    const before = mfs.statfs("/");
    expect(before.blocks * before.bsize).toBe(maxBytes);
    expect(before.bfree).toBeGreaterThan(initialBytes / before.bsize);
    expect(sab.byteLength).toBe(initialBytes);

    const fd = mfs.open("/grow.bin", 0x0040 | 0x0002 | 0x0200, 0o644);
    const data = new Uint8Array(initialBytes);
    expect(mfs.write(fd, data, null, data.length)).toBe(data.length);
    mfs.close(fd);

    const after = mfs.statfs("/");
    expect(sab.byteLength).toBeGreaterThan(initialBytes);
    expect(after.blocks).toBe(before.blocks);
    expect(after.blocks * after.bsize).toBe(maxBytes);
    expect(after.bfree).toBeLessThan(before.bfree);
    expect(after.bavail).toBe(after.bfree);
  });

  it("statfs does not report the internal default growth cap for non-growable buffers", () => {
    const initialBytes = 1 * 1024 * 1024;
    const sab = new SharedArrayBuffer(initialBytes);
    const mfs = MemoryFileSystem.create(sab);
    const stats = mfs.statfs("/");

    expect(stats.blocks * stats.bsize).toBe(initialBytes);
    expect(sab.maxByteLength).toBe(initialBytes);
  });
});

// ---------------------------------------------------------------------------
// 6. Mixed mounts test (HostFileSystem + MemoryFileSystem)
// ---------------------------------------------------------------------------

describe("Mixed mounts: HostFileSystem root + MemoryFileSystem /tmp", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "vfs-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("writes via /tmp (memory) and reads via / (host) independently", () => {
    const hostFs = new HostFileSystem(tmpDir);
    const sab = new SharedArrayBuffer(4 * 1024 * 1024);
    const memFs = MemoryFileSystem.create(sab);

    const vfs = new VirtualPlatformIO(
      [
        { mountPoint: "/", backend: hostFs },
        { mountPoint: "/tmp", backend: memFs },
      ],
      new NodeTimeProvider(),
    );

    // Write a file to /tmp (memory-backed)
    const O_CREAT = 0x0040,
      O_RDWR = 0x0002,
      O_TRUNC = 0x0200;
    const hMem = vfs.open("/tmp/memfile.txt", O_CREAT | O_RDWR | O_TRUNC, 0o644);
    const memData = new TextEncoder().encode("memory data");
    vfs.write(hMem, memData, null, memData.length);
    vfs.close(hMem);

    // Write a file to / (host-backed)
    writeFileSync(join(tmpDir, "hostfile.txt"), "host data");

    // Read back from host via VFS
    const hHost = vfs.open("/hostfile.txt", 0, 0);
    const buf = new Uint8Array(64);
    const n = vfs.read(hHost, buf, null, 64);
    expect(new TextDecoder().decode(buf.subarray(0, n))).toBe("host data");
    vfs.close(hHost);

    // Read back from memory via VFS
    const hMem2 = vfs.open("/tmp/memfile.txt", 0, 0);
    const buf2 = new Uint8Array(64);
    const n2 = vfs.read(hMem2, buf2, null, 64);
    expect(new TextDecoder().decode(buf2.subarray(0, n2))).toBe("memory data");
    vfs.close(hMem2);
  });

  it("directory listing works for host-backed mount", () => {
    writeFileSync(join(tmpDir, "a.txt"), "a");
    writeFileSync(join(tmpDir, "b.txt"), "b");

    const hostFs = new HostFileSystem(tmpDir);
    const vfs = new VirtualPlatformIO(
      [{ mountPoint: "/", backend: hostFs }],
      new NodeTimeProvider(),
    );

    const dh = vfs.opendir("/");
    const names: string[] = [];
    let entry;
    while ((entry = vfs.readdir(dh)) !== null) {
      names.push(entry.name);
    }
    vfs.closedir(dh);

    expect(names).toContain("a.txt");
    expect(names).toContain("b.txt");
  });

  it("routes statfs to the mounted backend", () => {
    const root = createMockBackend();
    const tmp = createMockBackend();
    const vfs = new VirtualPlatformIO(
      [
        { mountPoint: "/", backend: root },
        { mountPoint: "/tmp", backend: tmp },
      ],
      new NodeTimeProvider(),
    );

    vfs.statfs("/tmp/file.txt");

    expect(root.calls).not.toContain("statfs:/tmp/file.txt");
    expect(tmp.calls).toContain("statfs:/file.txt");
  });
});

// ---------------------------------------------------------------------------
// 7. VirtualPlatformIO with no mounts throws
// ---------------------------------------------------------------------------

describe("VirtualPlatformIO constructor validation", () => {
  it("throws if no mounts provided", () => {
    expect(() => new VirtualPlatformIO([], new NodeTimeProvider())).toThrow(
      "at least one mount",
    );
  });
});

describe("VirtualPlatformIO clock routing", () => {
  function clockedBackend(): FileSystemBackend & { adopted: TimeProvider[] } {
    const backend = createMockBackend() as FileSystemBackend & {
      adopted: TimeProvider[];
    };
    backend.adopted = [];
    backend.setTimeProvider = (time) => void backend.adopted.push(time);
    return backend;
  }

  it("hands the machine's clock to every mount that keeps file times", () => {
    const root = clockedBackend();
    const tmp = clockedBackend();
    const time = new NodeTimeProvider();
    new VirtualPlatformIO(
      [
        { mountPoint: "/", backend: root },
        { mountPoint: "/tmp", backend: tmp },
      ],
      time,
    );
    expect(root.adopted).toEqual([time]);
    expect(tmp.adopted).toEqual([time]);
  });

  it("hands every mount the replacement clock too", () => {
    // A restored machine and a replicated one both swap the provider after
    // the mounts exist, so a backend given only the boot clock would go on
    // stamping file times from the host it happens to be running on.
    const backend = clockedBackend();
    const io = new VirtualPlatformIO(
      [{ mountPoint: "/", backend }],
      new NodeTimeProvider(),
    );
    const replacement = new NodeTimeProvider();
    io.setTimeProvider(replacement);
    expect(backend.adopted).toHaveLength(2);
    expect(backend.adopted[1]).toBe(replacement);
  });

  it("skips a mount that keeps no file times of its own", () => {
    const backend = createMockBackend();
    expect(
      () =>
        new VirtualPlatformIO(
          [{ mountPoint: "/", backend }],
          new NodeTimeProvider(),
        ),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 8. Time provider tests
// ---------------------------------------------------------------------------

describe("NodeTimeProvider", () => {
  it("returns realtime clock", () => {
    const tp = new NodeTimeProvider();
    const { sec, nsec } = tp.clockGettime(0);
    expect(sec).toBeGreaterThan(0);
    expect(nsec).toBeGreaterThanOrEqual(0);
    expect(nsec).toBeLessThan(1_000_000_000);
  });

  it("returns monotonic clock", () => {
    const tp = new NodeTimeProvider();
    const { sec, nsec } = tp.clockGettime(1);
    expect(sec).toBeGreaterThanOrEqual(0);
    expect(nsec).toBeGreaterThanOrEqual(0);
  });

  it("monotonic clock is non-decreasing across calls", () => {
    const tp = new NodeTimeProvider();
    const t1 = tp.clockGettime(1);
    const t2 = tp.clockGettime(1);
    const ns1 = BigInt(t1.sec) * 1_000_000_000n + BigInt(t1.nsec);
    const ns2 = BigInt(t2.sec) * 1_000_000_000n + BigInt(t2.nsec);
    expect(ns2).toBeGreaterThanOrEqual(ns1);
  });

  it("treats CLOCK_BOOTTIME as monotonic-equivalent", () => {
    const tp = new NodeTimeProvider();
    const monotonic = tp.clockGettime(1);
    const boottime = tp.clockGettime(7);
    const monotonicNs = BigInt(monotonic.sec) * 1_000_000_000n + BigInt(monotonic.nsec);
    const boottimeNs = BigInt(boottime.sec) * 1_000_000_000n + BigInt(boottime.nsec);
    expect(boottimeNs).toBeGreaterThanOrEqual(monotonicNs);
    expect(boottimeNs - monotonicNs).toBeLessThan(100_000_000n);
  });
});

describe("what a mount answers when a checkpoint asks for its bytes", () => {
  it("gives a MemoryFileSystem's buffer, which the freeze copies", () => {
    const sab = new SharedArrayBuffer(1024 * 1024);
    const mfs = MemoryFileSystem.create(sab);
    expect(mfs.checkpointBytes()).toEqual({ kind: "bytes", buffer: sab });
  });

  it("refuses for a HostFileSystem, naming the backing and not the path", () => {
    const root = mkdtempSync(join(tmpdir(), "kandelo-checkpoint-bytes-"));
    try {
      const answer = new HostFileSystem(root).checkpointBytes();
      expect(answer).toEqual({
        kind: "none",
        reason: "a host directory backs this mount and owns no shared buffer",
      });
      // A checkpoint travels to another computer; the sandbox root does not.
      expect(JSON.stringify(answer)).not.toContain(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses for a backend that does not answer at all", () => {
    expect(
      askMountsForCheckpointBytes([
        { mountPoint: "/proc", backend: createMockBackend() },
      ]),
    ).toEqual([
      {
        mountPoint: "/proc",
        bytes: {
          kind: "none",
          reason: "this mount's backend reports no checkpoint bytes",
        },
      },
    ]);
  });

  it("keeps every mount in mount order, answered or not", () => {
    const root = mkdtempSync(join(tmpdir(), "kandelo-checkpoint-bytes-"));
    try {
      const sab = new SharedArrayBuffer(1024 * 1024);
      const asked = askMountsForCheckpointBytes([
        { mountPoint: "/", backend: MemoryFileSystem.create(sab) },
        { mountPoint: "/tmp", backend: new HostFileSystem(root) },
      ]);
      expect(asked.map((mount) => [mount.mountPoint, mount.bytes.kind]))
        .toEqual([["/", "bytes"], ["/tmp", "none"]]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
