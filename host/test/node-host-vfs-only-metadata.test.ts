import { afterEach, describe, expect, it } from "vitest";
import {
  chmodSync,
  existsSync,
  fstatSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import type { BigIntStats } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodePlatformIO } from "../src/platform/node";
import { NativeMetadataOverlay } from "../src/platform/native-metadata";
import type { StatResult } from "../src/types";
import {
  createSessionOwnedHostFileSystem,
  HostFileSystem,
} from "../src/vfs/host-fs";
import { VirtualPlatformIO } from "../src/vfs/vfs";
import { NodeTimeProvider } from "../src/vfs/time";
import type { MountSpec } from "../src/vfs/default-mounts";
import { resolveForNode } from "../src/vfs/default-mounts-node";
import { MemoryFileSystem } from "../src/vfs/memory-fs";
// This suite exercises the host-owned scratch-mount machinery (HostFileSystem,
// VirtualPlatformIO metadata, and the Node resolver's scratch-backend creation)
// directly. The in-kernel tmpfs owns its scratch prefixes unconditionally, so
// the resolver always drops them; the one resolver case below uses a spec of
// non-tmpfs scratch paths to exercise the surviving materialisation machinery.
const HOST_SCRATCH_MOUNT_SPEC: MountSpec[] = [
  { path: "/", source: "image", readonly: false },
  { path: "/run", source: "scratch", mode: 0o1777, nosuid: true },
  { path: "/var/spool", source: "scratch", mode: 0o1777, nosuid: true },
  { path: "/var/cache", source: "scratch", mode: 0o755, nosuid: true },
  {
    path: "/home/dev",
    source: "scratch",
    mode: 0o755,
    uid: 1000,
    gid: 1000,
    nosuid: true,
  },
  { path: "/opt/admin", source: "scratch", mode: 0o700, uid: 0, gid: 0, nosuid: true },
];


const O_RDWR = 0o2;
const O_CREAT = 0o100;
const O_TRUNC = 0o1000;
const MODE_MASK = 0o7777;
const PERMISSION_MASK = 0o777;
const UID_GID_UNCHANGED = 0xffffffff;

interface MetadataBackend {
  stat(path: string): StatResult;
  open(path: string, flags: number, mode: number): number;
  close(handle: number): number;
  read(handle: number, buffer: Uint8Array, offset: number | null, length: number): number;
  write(handle: number, buffer: Uint8Array, offset: number | null, length: number): number;
  append(
    handle: number,
    buffer: Uint8Array,
    length: number,
    limit: number | null,
  ): { written: number; end: number | bigint };
  seek(handle: number, offset: number, whence: number): number;
  fstat(handle: number): StatResult;
  chmod(path: string, mode: number): void;
  chown(path: string, uid: number, gid: number): void;
  lchown(path: string, uid: number, gid: number): void;
  fchmod(handle: number, mode: number): void;
  fchown(handle: number, uid: number, gid: number): void;
  ftruncate(handle: number, length: number): void;
  mkdir(path: string, mode: number): void;
  access(path: string, mode: number): void;
  link(existingPath: string, newPath: string): void;
  rename(oldPath: string, newPath: string): void;
  unlink(path: string): void;
}

interface BackendCase {
  root: string;
  backend: MetadataBackend;
  vfsPath(name: string): string;
  nativePath(name: string): string;
  appendSupported: boolean;
}

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    rmSync(tempRoots.pop()!, { recursive: true, force: true });
  }
});

function makeTempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

function nativeMode(path: string): number {
  return statSync(path).mode & MODE_MASK;
}

function expectNativeMetadataUnchanged(path: string, before: ReturnType<typeof statSync>): void {
  const after = statSync(path);
  expect(after.mode & MODE_MASK).toBe(before.mode & MODE_MASK);
  expect(after.uid).toBe(before.uid);
  expect(after.gid).toBe(before.gid);
}

function withUmask<T>(mask: number, fn: () => T): T {
  const previous = process.umask(mask);
  try {
    return fn();
  } finally {
    process.umask(previous);
  }
}

async function withUmaskAsync<T>(
  mask: number,
  fn: () => Promise<T>,
): Promise<T> {
  const previous = process.umask(mask);
  try {
    return await fn();
  } finally {
    process.umask(previous);
  }
}

const backendFactories: Array<[string, () => BackendCase]> = [
  [
    "HostFileSystem scratch backend",
    () => {
      const root = makeTempRoot("wasm-posix-host-fs-vfs-only-");
      return {
        root,
        backend: createSessionOwnedHostFileSystem(root),
        vfsPath: (name) => `/${name}`,
        nativePath: (name) => join(root, name),
        appendSupported: true,
      };
    },
  ],
  [
    "NodePlatformIO direct host backend",
    () => {
      const root = makeTempRoot("wasm-posix-node-platform-vfs-only-");
      return {
        root,
        backend: new NodePlatformIO() as MetadataBackend,
        vfsPath: (name) => join(root, name),
        nativePath: (name) => join(root, name),
        appendSupported: false,
      };
    },
  ],
];

describe.each(backendFactories)("%s", (_name, makeCase) => {
  it("keeps O_RDONLY | O_TRUNC truncation and descriptor access coherent", () => {
    const c = makeCase();
    const path = c.vfsPath("read-only-truncate");
    const native = c.nativePath("read-only-truncate");
    writeFileSync(native, "truncate through the selected inode");
    c.backend.chmod(path, 0o6755);

    const fd = c.backend.open(path, O_TRUNC, 0);
    try {
      expect(c.backend.stat(path)).toMatchObject({ size: 0 });
      expect(c.backend.fstat(fd)).toMatchObject({ size: 0 });
      expect(c.backend.stat(path).mode & MODE_MASK).toBe(0o755);
      expect(c.backend.fstat(fd).mode & MODE_MASK).toBe(0o755);
      expect(() =>
        c.backend.write(fd, new Uint8Array([0x78]), null, 1)
      ).toThrow();
    } finally {
      c.backend.close(fd);
    }
  });

  it("returns exact bigint identity with checked numeric size and times", () => {
    const c = makeCase();
    const native = c.nativePath("exact-stat");
    writeFileSync(native, "identity");

    const pathStat = c.backend.stat(c.vfsPath("exact-stat"));
    expect(typeof pathStat.dev).toBe("bigint");
    expect(typeof pathStat.ino).toBe("bigint");
    expect(typeof pathStat.size).toBe("number");
    expect(typeof pathStat.atimeMs).toBe("number");
    expect(typeof pathStat.mtimeMs).toBe("number");
    expect(typeof pathStat.ctimeMs).toBe("number");

    const fd = c.backend.open(c.vfsPath("exact-stat"), O_RDWR, 0);
    try {
      const handleStat = c.backend.fstat(fd);
      expect(handleStat.dev).toBe(pathStat.dev);
      expect(handleStat.ino).toBe(pathStat.ino);
    } finally {
      c.backend.close(fd);
    }
  });

  it("rejects negative seek targets without changing the file offset", () => {
    const c = makeCase();
    const native = c.nativePath("seek-file");
    writeFileSync(native, "abcdef");

    const fd = c.backend.open(c.vfsPath("seek-file"), O_RDWR, 0);
    try {
      expect(c.backend.seek(fd, 2, 0 /* SEEK_SET */)).toBe(2);
      expect(() => c.backend.seek(fd, -1, 0 /* SEEK_SET */)).toThrow(/EINVAL/);
      expect(() => c.backend.seek(fd, -5, 1 /* SEEK_CUR */)).toThrow(/EINVAL/);
      expect(() => c.backend.seek(fd, -7, 2 /* SEEK_END */)).toThrow(/EINVAL/);
      expect(() => c.backend.seek(fd, Number.MAX_SAFE_INTEGER, 1 /* SEEK_CUR */))
        .toThrow(/EOVERFLOW/);
      expect(c.backend.seek(fd, 0, 1 /* SEEK_CUR */)).toBe(2);

      const buf = new Uint8Array(1);
      expect(c.backend.read(fd, buf, null, 1)).toBe(1);
      expect(new TextDecoder().decode(buf)).toBe("c");
    } finally {
      c.backend.close(fd);
    }
  });

  it("keeps path chmod/chown changes in VFS metadata only", () => {
    const c = makeCase();
    const native = c.nativePath("path-file");
    writeFileSync(native, "data");
    chmodSync(native, 0o600);
    const before = statSync(native);

    c.backend.chmod(c.vfsPath("path-file"), 0o751);
    c.backend.chown(c.vfsPath("path-file"), 1234, 5678);

    const virtual = c.backend.stat(c.vfsPath("path-file"));
    expect(virtual.mode & MODE_MASK).toBe(0o751);
    expect(virtual.uid).toBe(1234);
    expect(virtual.gid).toBe(5678);
    expectNativeMetadataUnchanged(native, before);
  });

  it("keeps fd fchmod/fchown changes in VFS metadata only", () => {
    const c = makeCase();
    const native = c.nativePath("fd-file");
    writeFileSync(native, "data");
    chmodSync(native, 0o600);

    const fd = c.backend.open(c.vfsPath("fd-file"), O_RDWR, 0);
    try {
      const before = fstatSync(fd);
      c.backend.fchmod(fd, 0o700);
      c.backend.fchown(fd, 2222, 3333);

      const virtual = c.backend.fstat(fd);
      const nativeAfter = fstatSync(fd);
      expect(virtual.mode & MODE_MASK).toBe(0o700);
      expect(virtual.uid).toBe(2222);
      expect(virtual.gid).toBe(3333);
      expect(nativeAfter.mode & MODE_MASK).toBe(before.mode & MODE_MASK);
      expect(nativeAfter.uid).toBe(before.uid);
      expect(nativeAfter.gid).toBe(before.gid);
    } finally {
      c.backend.close(fd);
    }
  });

  it("clears executable regular-file set-ID bits through path and fd chown", () => {
    const c = makeCase();
    const pathNative = c.nativePath("set-id-path");
    const fdNative = c.nativePath("set-id-fd");
    writeFileSync(pathNative, "path");
    writeFileSync(fdNative, "fd");
    chmodSync(pathNative, 0o600);
    chmodSync(fdNative, 0o600);
    const pathBefore = statSync(pathNative);
    const fdBefore = statSync(fdNative);

    c.backend.chmod(c.vfsPath("set-id-path"), 0o6755);
    c.backend.chown(c.vfsPath("set-id-path"), 1234, 5678);
    expect(c.backend.stat(c.vfsPath("set-id-path")).mode & MODE_MASK).toBe(0o755);

    const fd = c.backend.open(c.vfsPath("set-id-fd"), O_RDWR, 0);
    try {
      c.backend.fchmod(fd, 0o6755);
      c.backend.fchown(fd, 1234, 5678);
      expect(c.backend.fstat(fd).mode & MODE_MASK).toBe(0o755);
    } finally {
      c.backend.close(fd);
    }

    expectNativeMetadataUnchanged(pathNative, pathBefore);
    expectNativeMetadataUnchanged(fdNative, fdBefore);
  });

  it("clears set-ID bits on non-executable regular files but not directories", () => {
    const c = makeCase();
    const fileNative = c.nativePath("set-id-data");
    writeFileSync(fileNative, "data");
    c.backend.chmod(c.vfsPath("set-id-data"), 0o6600);
    c.backend.chown(c.vfsPath("set-id-data"), 1234, 5678);
    expect(c.backend.stat(c.vfsPath("set-id-data")).mode & MODE_MASK).toBe(0o600);

    c.backend.mkdir(c.vfsPath("set-id-dir"), 0o770);
    c.backend.chmod(c.vfsPath("set-id-dir"), 0o6770);
    c.backend.chown(c.vfsPath("set-id-dir"), 1234, 5678);
    expect(c.backend.stat(c.vfsPath("set-id-dir")).mode & MODE_MASK).toBe(0o6770);
  });

  it("invalidates set-ID metadata after every qualifying file mutation", () => {
    const c = makeCase();
    const path = c.vfsPath("mutation-matrix");
    const native = c.nativePath("mutation-matrix");
    writeFileSync(native, "seed");
    chmodSync(native, 0o600);

    const fd = c.backend.open(path, O_RDWR, 0);
    const byte = new Uint8Array([0x78]);
    const expectMode = (mode: number): void => {
      expect(c.backend.stat(path).mode & MODE_MASK).toBe(mode);
      expect(c.backend.fstat(fd).mode & MODE_MASK).toBe(mode);
    };
    const arm = (mode = 0o6755): void => {
      c.backend.chmod(path, mode);
      expectMode(mode);
    };

    try {
      arm();
      expect(c.backend.write(fd, byte, null, 1)).toBe(1);
      expectMode(0o755);

      arm();
      expect(c.backend.write(fd, byte, 0, 1)).toBe(1);
      expectMode(0o755);

      arm();
      if (c.appendSupported) {
        expect(c.backend.append(fd, byte, 1, null).written).toBe(1);
        expectMode(0o755);
      } else {
        expect(() => c.backend.append(fd, byte, 1, null)).toThrow(/EOPNOTSUPP/);
        expectMode(0o6755);
      }

      arm();
      const truncateFd = c.backend.open(path, O_RDWR | O_TRUNC, 0);
      c.backend.close(truncateFd);
      expectMode(0o755);

      expect(c.backend.write(fd, byte, 0, 1)).toBe(1);
      arm();
      c.backend.ftruncate(fd, 0);
      expectMode(0o755);

      arm();
      c.backend.chown(path, 1001, 2001);
      expectMode(0o755);

      arm();
      c.backend.fchown(fd, 1002, 2002);
      expectMode(0o755);

      arm();
      c.backend.lchown(path, 1003, 2003);
      expectMode(0o755);

      arm(0o6600);
      expect(c.backend.write(fd, byte, 0, 1)).toBe(1);
      expectMode(0o600);

      arm(0o6600);
      c.backend.chown(path, 1004, 2004);
      expectMode(0o600);

      arm();
      expect(c.backend.write(fd, byte, null, 0)).toBe(0);
      expect(c.backend.write(fd, byte, 0, 0)).toBe(0);
      if (c.appendSupported) {
        expect(c.backend.append(fd, byte, 0, null).written).toBe(0);
      } else {
        expect(() => c.backend.append(fd, byte, 0, null)).toThrow(/EOPNOTSUPP/);
      }
      expectMode(0o6755);

      const unchangedSize = c.backend.fstat(fd).size;
      c.backend.ftruncate(fd, unchangedSize);
      expectMode(0o6755);
      if (unchangedSize !== 0) {
        c.backend.ftruncate(fd, 0);
        arm();
      }
      const emptyTruncateFd = c.backend.open(path, O_RDWR | O_TRUNC, 0);
      c.backend.close(emptyTruncateFd);
      expectMode(0o6755);

      const readOnlyFd = c.backend.open(path, 0, 0);
      try {
        expect(() => c.backend.write(readOnlyFd, byte, null, 1)).toThrow();
        expect(() => c.backend.ftruncate(readOnlyFd, 0)).toThrow();
      } finally {
        c.backend.close(readOnlyFd);
      }
      expectMode(0o6755);
    } finally {
      c.backend.close(fd);
    }

    c.backend.mkdir(c.vfsPath("mutation-directory"), 0o755);
    c.backend.chmod(c.vfsPath("mutation-directory"), 0o6770);
    c.backend.chown(c.vfsPath("mutation-directory"), 3001, 3002);
    expect(c.backend.stat(c.vfsPath("mutation-directory")).mode & MODE_MASK)
      .toBe(0o6770);
  });

  it("keeps mode coherent after positive and failed mutation attempts", () => {
    const c = makeCase();
    const path = c.vfsPath("mutation-failures");
    const native = c.nativePath("mutation-failures");
    writeFileSync(native, "seed");
    chmodSync(native, 0o600);
    const fd = c.backend.open(path, O_RDWR, 0);
    const bytes = new Uint8Array([0x78, 0x79]);
    const expectMode = (mode: number): void => {
      expect(c.backend.stat(path).mode & MODE_MASK).toBe(mode);
      expect(c.backend.fstat(fd).mode & MODE_MASK).toBe(mode);
    };
    const arm = (): void => {
      c.backend.chmod(path, 0o6755);
      expectMode(0o6755);
    };
    const expectFailure = (operation: () => unknown): void => {
      expect(operation).toThrow();
      expectMode(0o6755);
    };

    try {
      arm();
      expect(c.backend.write(fd, bytes, null, 1)).toBe(1);
      expectMode(0o755);

      arm();
      expect(c.backend.write(fd, bytes, 0, 1)).toBe(1);
      expectMode(0o755);

      if (c.appendSupported) {
        arm();
        const limit = c.backend.fstat(fd).size + 1;
        expect(c.backend.append(fd, bytes, bytes.length, limit).written).toBe(1);
        expectMode(0o755);
      }

      arm();
      const readOnlyFd = c.backend.open(path, 0, 0);
      try {
        expectFailure(() => c.backend.write(readOnlyFd, bytes, null, 1));
        expectFailure(() => c.backend.write(readOnlyFd, bytes, 0, 1));
        expectFailure(() => c.backend.append(readOnlyFd, bytes, 1, null));
        expectFailure(() => c.backend.ftruncate(readOnlyFd, 0));
      } finally {
        c.backend.close(readOnlyFd);
      }

      expectFailure(() =>
        c.backend.open(c.vfsPath("missing-truncate"), O_RDWR | O_TRUNC, 0)
      );
      expectFailure(() =>
        c.backend.chown(c.vfsPath("missing-chown"), 1000, 2000)
      );
      expectFailure(() => c.backend.fchown(999_999, 1000, 2000));
      expectFailure(() =>
        c.backend.lchown(c.vfsPath("missing-lchown"), 1000, 2000)
      );
    } finally {
      c.backend.close(fd);
    }
  });

  it("uses a private native create mode and records the requested guest mode", () => {
    const c = makeCase();
    const fd = withUmask(0, () =>
      c.backend.open(c.vfsPath("created-file"), O_RDWR | O_CREAT | O_TRUNC, 0o751),
    );
    try {
      expect(c.backend.fstat(fd).mode & MODE_MASK).toBe(0o751);
      // WHY: creation must not expose a permissive host inode before virtual
      // metadata owns the guest-visible mode. The guest still observes its
      // requested 0751 through the authoritative virtual metadata.
      expect(fstatSync(fd).mode & MODE_MASK).toBe(0o600);
    } finally {
      c.backend.close(fd);
    }

    expect(c.backend.stat(c.vfsPath("created-file")).mode & MODE_MASK).toBe(0o751);
    expect(nativeMode(c.nativePath("created-file"))).toBe(0o600);
  });

  it("relays mkdir mode to native creation and records it virtually", () => {
    const c = makeCase();
    withUmask(0, () => c.backend.mkdir(c.vfsPath("created-dir"), 0o751));

    expect(c.backend.stat(c.vfsPath("created-dir")).mode & MODE_MASK).toBe(0o751);
    expect(nativeMode(c.nativePath("created-dir"))).toBe(0o751);
  });

  it("honors uid/gid -1 as unchanged in virtual metadata only", () => {
    const c = makeCase();
    const native = c.nativePath("partial-chown");
    writeFileSync(native, "data");
    const before = statSync(native);

    c.backend.chown(c.vfsPath("partial-chown"), 1111, UID_GID_UNCHANGED);
    let virtual = c.backend.stat(c.vfsPath("partial-chown"));
    expect(virtual.uid).toBe(1111);
    expect(virtual.gid).toBe(0);

    c.backend.chown(c.vfsPath("partial-chown"), UID_GID_UNCHANGED, 2222);
    virtual = c.backend.stat(c.vfsPath("partial-chown"));
    expect(virtual.uid).toBe(1111);
    expect(virtual.gid).toBe(2222);
    expectNativeMetadataUnchanged(native, before);
  });

  it("answers access from VFS mode metadata instead of native mode", () => {
    const c = makeCase();
    const native = c.nativePath("access-file");
    writeFileSync(native, "data");
    chmodSync(native, 0o777);
    const before = statSync(native);

    c.backend.chmod(c.vfsPath("access-file"), 0o000);
    expect(() => c.backend.access(c.vfsPath("access-file"), 0)).not.toThrow();
    expect(() => c.backend.access(c.vfsPath("access-file"), 0o4)).toThrow(/EACCES/);
    expect(() => c.backend.access(c.vfsPath("access-file"), 0o2)).toThrow(/EACCES/);
    expect(() => c.backend.access(c.vfsPath("access-file"), 0o1)).toThrow(/EACCES/);
    expectNativeMetadataUnchanged(native, before);

    c.backend.chmod(c.vfsPath("access-file"), 0o400);
    expect(() => c.backend.access(c.vfsPath("access-file"), 0o4)).not.toThrow();
    expect(() => c.backend.access(c.vfsPath("access-file"), 0o2)).toThrow(/EACCES/);
  });

  it("shares virtual metadata across hard links without changing native metadata", () => {
    const c = makeCase();
    const source = c.nativePath("source");
    const linked = c.nativePath("linked");
    writeFileSync(source, "data");
    chmodSync(source, 0o600);
    c.backend.link(c.vfsPath("source"), c.vfsPath("linked"));
    const sourceBefore = statSync(source);
    const linkedBefore = statSync(linked);

    c.backend.chmod(c.vfsPath("source"), 0o755);
    c.backend.chown(c.vfsPath("source"), 4444, 5555);

    const linkedVirtual = c.backend.stat(c.vfsPath("linked"));
    expect(linkedVirtual.mode & MODE_MASK).toBe(0o755);
    expect(linkedVirtual.uid).toBe(4444);
    expect(linkedVirtual.gid).toBe(5555);
    expectNativeMetadataUnchanged(source, sourceBefore);
    expectNativeMetadataUnchanged(linked, linkedBefore);
  });

  it("carries virtual metadata across rename without changing native metadata", () => {
    const c = makeCase();
    const beforePath = c.nativePath("before-rename");
    const afterPath = c.nativePath("after-rename");
    writeFileSync(beforePath, "data");
    chmodSync(beforePath, 0o600);
    const before = statSync(beforePath);

    c.backend.chmod(c.vfsPath("before-rename"), 0o711);
    c.backend.chown(c.vfsPath("before-rename"), 7777, 8888);
    c.backend.rename(c.vfsPath("before-rename"), c.vfsPath("after-rename"));

    const virtual = c.backend.stat(c.vfsPath("after-rename"));
    expect(existsSync(beforePath)).toBe(false);
    expect(virtual.mode & MODE_MASK).toBe(0o711);
    expect(virtual.uid).toBe(7777);
    expect(virtual.gid).toBe(8888);
    expectNativeMetadataUnchanged(afterPath, before);
  });

  it("does not leak virtual metadata after unlink and recreate", () => {
    const c = makeCase();
    const native = c.nativePath("recreated");
    writeFileSync(native, "old");

    c.backend.chmod(c.vfsPath("recreated"), 0o711);
    c.backend.chown(c.vfsPath("recreated"), 1212, 3434);
    c.backend.unlink(c.vfsPath("recreated"));
    writeFileSync(native, "new");

    const virtual = c.backend.stat(c.vfsPath("recreated"));
    expect(virtual.mode & MODE_MASK).not.toBe(0o711);
    expect(virtual.uid).toBe(0);
    expect(virtual.gid).toBe(0);
  });
});

describe("NativeMetadataOverlay exact native metadata", () => {
  function withIdentity(
    stat: BigIntStats,
    dev: bigint,
    ino: bigint,
  ): BigIntStats {
    return { ...stat, dev, ino } as BigIntStats;
  }

  it("does not alias dev/inode values that differ beyond number precision", () => {
    const root = makeTempRoot("wasm-posix-native-metadata-bigint-");
    const native = join(root, "file");
    writeFileSync(native, "data");
    const base = statSync(native, { bigint: true });
    const first = withIdentity(
      base,
      (1n << 60n) + 1n,
      (1n << 60n) + 3n,
    );
    const second = withIdentity(
      base,
      (1n << 60n) + 2n,
      (1n << 60n) + 4n,
    );
    const overlay = new NativeMetadataOverlay();

    overlay.chmod(first, 0o700);

    expect(overlay.toStatResult(first).mode & MODE_MASK).toBe(0o700);
    expect(overlay.toStatResult(second).mode & MODE_MASK).not.toBe(0o700);
  });

  it("rejects native sizes that cannot be represented exactly", () => {
    const root = makeTempRoot("wasm-posix-native-metadata-overflow-");
    const native = join(root, "file");
    writeFileSync(native, "data");
    const stat = statSync(native, { bigint: true });
    const oversized = {
      ...stat,
      size: BigInt(Number.MAX_SAFE_INTEGER) + 1n,
    } as BigIntStats;

    expect(() => new NativeMetadataOverlay().toStatResult(oversized)).toThrow(
      /EOVERFLOW: st_size/,
    );
  });
});

describe("HostFileSystem default virtual ownership", () => {
  it("can present existing host-backed files as owned by a chosen guest uid/gid", () => {
    const root = makeTempRoot("wasm-posix-host-fs-default-owner-");
    const native = join(root, "owned-by-mount");
    writeFileSync(native, "data");
    const before = statSync(native);

    const backend = new HostFileSystem(root, "/", { uid: 65534, gid: 65533 });
    const virtual = backend.stat("/owned-by-mount");
    expect(virtual.uid).toBe(65534);
    expect(virtual.gid).toBe(65533);

    backend.chown("/owned-by-mount", 1000, 1001);
    const changed = backend.stat("/owned-by-mount");
    expect(changed.uid).toBe(1000);
    expect(changed.gid).toBe(1001);
    expectNativeMetadataUnchanged(native, before);
  });
});

describe("VirtualPlatformIO on Node host mounts", () => {
  it("routes metadata operations to HostFileSystem as VFS-only changes", () => {
    const root = makeTempRoot("wasm-posix-virtual-platform-vfs-only-");
    const native = join(root, "file");
    writeFileSync(native, "data");
    chmodSync(native, 0o600);
    const before = statSync(native);

    const io = new VirtualPlatformIO(
      [{ mountPoint: "/", backend: new HostFileSystem(root) }],
      new NodeTimeProvider(),
    );
    io.chmod("/file", 0o751);
    io.chown("/file", 2468, 1357);
    const fd = io.open("/file", O_RDWR, 0);
    try {
      io.fchmod(fd, 0o700);
      io.fchown(fd, 9753, 8642);
      const virtual = io.fstat(fd);
      expect(virtual.mode & MODE_MASK).toBe(0o700);
      expect(virtual.uid).toBe(9753);
      expect(virtual.gid).toBe(8642);
    } finally {
      io.close(fd);
    }
    expectNativeMetadataUnchanged(native, before);
  });

  it("routes access through VFS metadata", () => {
    const root = makeTempRoot("wasm-posix-virtual-platform-access-");
    const native = join(root, "access-file");
    writeFileSync(native, "data");
    chmodSync(native, 0o777);
    const before = statSync(native);

    const io = new VirtualPlatformIO(
      [{ mountPoint: "/", backend: new HostFileSystem(root) }],
      new NodeTimeProvider(),
    );
    io.chmod("/access-file", 0o000);

    expect(() => io.access("/access-file", 0)).not.toThrow();
    expect(() => io.access("/access-file", 0o4)).toThrow(/EACCES/);
    expect(() => io.access("/access-file", 0o2)).toThrow(/EACCES/);
    expect(() => io.access("/access-file", 0o1)).toThrow(/EACCES/);
    expectNativeMetadataUnchanged(native, before);
  });

  it("applies every Node scratch mount mode virtually", async () => {
    const sessionDir = makeTempRoot("wasm-posix-default-node-vfs-only-");
    const image = await buildEmptyImage();
    const mounts = await withUmaskAsync(0, () =>
      resolveForNode(HOST_SCRATCH_MOUNT_SPEC, image, sessionDir)
    );

    for (const spec of HOST_SCRATCH_MOUNT_SPEC) {
      if (spec.source !== "scratch" || spec.mode === undefined) continue;
      const mount = mounts.find((m) => m.mountPoint === spec.path);
      expect(mount, `missing mount ${spec.path}`).toBeDefined();
      expect(mount!.backend.stat("/").mode & MODE_MASK).toBe(spec.mode);

      const native = join(sessionDir, spec.path);
      expect(nativeMode(native) & PERMISSION_MASK).toBe(spec.mode & PERMISSION_MASK);
    }
  });
});

async function buildEmptyImage(): Promise<Uint8Array> {
  const sab = new SharedArrayBuffer(1024 * 1024);
  return await MemoryFileSystem.create(sab).saveImage();
}
