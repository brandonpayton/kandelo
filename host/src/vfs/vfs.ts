import type {
  AppendOutcome,
  HostFileOffset,
  NetworkIO,
  PathconfValue,
  PlatformIO,
  StatResult,
  StatfsResult,
} from "../types";
import {
  ST_NOSUID,
  type FileSystemBackend,
  type MountConfig,
  type TimeProvider,
} from "./types";
import { OPEN_FLAGS } from "../generated/abi";

interface MountEntry {
  prefix: string;
  backend: FileSystemBackend;
  backendId: number;
  nosuid: boolean;
}

interface HandleInfo {
  backend: FileSystemBackend;
  backendId: number;
  localHandle: number;
  statfs?: StatfsResult;
}

const MAX_U64 = (1n << 64n) - 1n;

function exactUnsignedIdentity(value: number | bigint, field: string): bigint {
  if (typeof value === "bigint") {
    if (value >= 0n && value <= MAX_U64) return value;
  } else if (Number.isSafeInteger(value) && value >= 0) {
    return BigInt(value);
  }
  const error = new Error(
    `EOVERFLOW: ${field} is not exactly representable as an unsigned 64-bit value`,
  ) as Error & { code: string };
  error.code = "EOVERFLOW";
  throw error;
}

function normalizeMountPoint(mp: string): string {
  // Remove trailing slash unless it's the root
  if (mp !== "/" && mp.endsWith("/")) {
    return mp.slice(0, -1);
  }
  return mp;
}

function parentPath(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash <= 0 ? "/" : path.slice(0, slash);
}

export class VirtualPlatformIO implements PlatformIO {
  private mounts: MountEntry[];
  private time: TimeProvider;
  private fileHandles = new Map<number, HandleInfo>();
  private dirHandles = new Map<number, HandleInfo>();
  private nextFileHandle = 100;
  private nextDirHandle = 1;
  private readonly qualifiedDeviceIds = new Map<
    FileSystemBackend,
    Map<bigint, bigint>
  >();
  private nextQualifiedDeviceId = 1n;
  network?: NetworkIO;

  constructor(mounts: MountConfig[], time: TimeProvider) {
    // Scope inode numbers to the backend object that owns them. Assigning the
    // id per backend (rather than per mount point) keeps aliases intact when
    // one backend is deliberately exposed at more than one mount point.
    const backendIds = new Map<FileSystemBackend, number>();
    let nextBackendId = 1;
    this.mounts = mounts
      .map((m) => {
        let backendId = backendIds.get(m.backend);
        if (backendId === undefined) {
          backendId = nextBackendId++;
          backendIds.set(m.backend, backendId);
        }
        return {
          prefix: normalizeMountPoint(m.mountPoint),
          backend: m.backend,
          backendId,
          nosuid: m.nosuid === true,
        };
      })
      .sort((a, b) => b.prefix.length - a.prefix.length);
    this.time = time;
    if (this.mounts.length === 0) {
      throw new Error("VirtualPlatformIO requires at least one mount");
    }
    this.publishTimeProvider();
  }

  /** Hand the machine's clock to every mount that stamps its own file times. */
  private publishTimeProvider(): void {
    for (const mount of this.mounts) mount.backend.setTimeProvider?.(this.time);
  }

  /** Whether the mount owning an absolute guest path ignores set-ID bits. */
  getMountNosuid(path: string): boolean {
    return this.resolve(path).nosuid;
  }

  private resolve(path: string): {
    backend: FileSystemBackend;
    backendId: number;
    nosuid: boolean;
    relativePath: string;
  } {
    for (const m of this.mounts) {
      if (m.prefix === "/") {
        return {
          backend: m.backend,
          backendId: m.backendId,
          nosuid: m.nosuid,
          relativePath: path,
        };
      }
      if (path === m.prefix || path.startsWith(m.prefix + "/")) {
        let rel = path.slice(m.prefix.length);
        if (!rel.startsWith("/")) rel = "/" + rel;
        return {
          backend: m.backend,
          backendId: m.backendId,
          nosuid: m.nosuid,
          relativePath: rel,
        };
      }
    }
    throw new Error(`ENOENT: no mount for path: ${path}`);
  }

  private resolveTwoPaths(
    path1: string,
    path2: string,
  ): { backend: FileSystemBackend; rel1: string; rel2: string } {
    const r1 = this.resolve(path1);
    const r2 = this.resolve(path2);
    if (r1.backend !== r2.backend) {
      throw new Error("EXDEV: cross-device link");
    }
    return { backend: r1.backend, rel1: r1.relativePath, rel2: r2.relativePath };
  }

  private getFileHandle(handle: number): HandleInfo {
    const info = this.fileHandles.get(handle);
    if (!info) throw new Error(`EBADF: invalid file handle ${handle}`);
    return info;
  }

  private getDirHandle(handle: number): HandleInfo {
    const info = this.dirHandles.get(handle);
    if (!info) throw new Error(`EBADF: invalid dir handle ${handle}`);
    return info;
  }

  /**
   * Turn a backend-local device number into a machine-visible device number.
   * The backend object, not its mount point, owns the namespace: alias mounts
   * therefore agree, while distinct backend instances can never collide.
   */
  private qualifyStat(backend: FileSystemBackend, stat: StatResult): StatResult {
    const localDevice = exactUnsignedIdentity(stat.dev, "st_dev");
    const inode = exactUnsignedIdentity(stat.ino, "st_ino");
    let devices = this.qualifiedDeviceIds.get(backend);
    if (devices === undefined) {
      devices = new Map();
      this.qualifiedDeviceIds.set(backend, devices);
    }
    let device = devices.get(localDevice);
    if (device === undefined) {
      if (this.nextQualifiedDeviceId > MAX_U64) {
        const error = new Error(
          "EOVERFLOW: exhausted virtual filesystem device identities",
        ) as Error & { code: string };
        error.code = "EOVERFLOW";
        throw error;
      }
      device = this.nextQualifiedDeviceId++;
      devices.set(localDevice, device);
    }
    return { ...stat, dev: device, ino: inode };
  }

  fileIdentity(path: string, dev: bigint, ino: bigint): string | null {
    if (ino <= 0n || dev < 0n) return null;
    const { backendId } = this.resolve(path);
    return `vfs:${backendId}:${dev}:${ino}`;
  }

  fileHandleIdentity(handle: number, dev: bigint, ino: bigint): string | null {
    if (ino <= 0n || dev < 0n) return null;
    const { backendId } = this.getFileHandle(handle);
    return `vfs:${backendId}:${dev}:${ino}`;
  }

  // --- File handle operations ---

  async preparePath(path: string): Promise<boolean> {
    const { backend, relativePath } = this.resolve(path);
    return backend.preparePath?.(relativePath) ?? false;
  }

  reserveHandleFloors(fileFloor: number, dirFloor: number): void {
    if (this.nextFileHandle < fileFloor) this.nextFileHandle = fileFloor;
    if (this.nextDirHandle < dirFloor) this.nextDirHandle = dirFloor;
  }

  advanceMonotonicFloor(floorNs: number): void {
    this.time.advanceMonotonicFloor?.(floorNs);
  }

  open(path: string, flags: number, mode: number): number {
    const { backend, backendId, relativePath, nosuid } = this.resolve(path);
    // O_CREAT may name a missing final component. Its already-resolved backend
    // and existing parent provide the filesystem metadata; the open below
    // remains the sole authority for validating and creating the final path.
    const statfsPath = (flags & OPEN_FLAGS.O_CREAT) !== 0
      ? parentPath(relativePath)
      : relativePath;
    const backendStatfs = backend.statfs(statfsPath);
    const statfs = {
      ...backendStatfs,
      flags: nosuid
        ? backendStatfs.flags | ST_NOSUID
        : backendStatfs.flags & ~ST_NOSUID,
    };
    const localHandle = backend.open(relativePath, flags, mode);
    const globalHandle = this.nextFileHandle++;
    this.fileHandles.set(globalHandle, {
      backend,
      backendId,
      localHandle,
      statfs,
    });
    return globalHandle;
  }

  close(handle: number): number {
    const info = this.getFileHandle(handle);
    const result = info.backend.close(info.localHandle);
    this.fileHandles.delete(handle);
    return result;
  }

  read(
    handle: number,
    buffer: Uint8Array,
    offset: HostFileOffset | null,
    length: number,
  ): number {
    const info = this.getFileHandle(handle);
    return info.backend.read(info.localHandle, buffer, offset, length);
  }

  write(
    handle: number,
    buffer: Uint8Array,
    offset: HostFileOffset | null,
    length: number,
  ): number {
    const info = this.getFileHandle(handle);
    return info.backend.write(info.localHandle, buffer, offset, length);
  }

  append(
    handle: number,
    buffer: Uint8Array,
    length: number,
    limit: HostFileOffset | null,
  ): AppendOutcome {
    const info = this.getFileHandle(handle);
    return info.backend.append(info.localHandle, buffer, length, limit);
  }

  seek(
    handle: number,
    offset: HostFileOffset,
    whence: number,
  ): HostFileOffset {
    const info = this.getFileHandle(handle);
    return info.backend.seek(info.localHandle, offset, whence);
  }

  fstat(handle: number): StatResult {
    const info = this.getFileHandle(handle);
    return this.qualifyStat(info.backend, info.backend.fstat(info.localHandle));
  }

  fstatfs(handle: number): StatfsResult {
    const info = this.getFileHandle(handle);
    if (info.statfs === undefined) {
      throw new Error(`EBADF: file handle ${handle} has no mount route`);
    }
    return { ...info.statfs };
  }

  fpathconf(handle: number, name: number): PathconfValue {
    const info = this.getFileHandle(handle);
    return info.backend.fpathconf(info.localHandle, name);
  }

  ftruncate(handle: number, length: number): void {
    const info = this.getFileHandle(handle);
    info.backend.ftruncate(info.localHandle, length);
  }

  fsync(handle: number): void {
    const info = this.getFileHandle(handle);
    info.backend.fsync(info.localHandle);
  }

  fchmod(handle: number, mode: number): void {
    const info = this.getFileHandle(handle);
    info.backend.fchmod(info.localHandle, mode);
  }

  fchown(handle: number, uid: number, gid: number): void {
    const info = this.getFileHandle(handle);
    info.backend.fchown(info.localHandle, uid, gid);
  }

  // --- Path-based operations ---

  stat(path: string): StatResult {
    const { backend, relativePath } = this.resolve(path);
    return this.qualifyStat(backend, backend.stat(relativePath));
  }

  lstat(path: string): StatResult {
    const { backend, relativePath } = this.resolve(path);
    return this.qualifyStat(backend, backend.lstat(relativePath));
  }

  statfs(path: string): StatfsResult {
    const { backend, relativePath, nosuid } = this.resolve(path);
    const statfs = backend.statfs(relativePath);
    const flags = nosuid
      ? statfs.flags | ST_NOSUID
      : statfs.flags & ~ST_NOSUID;
    return { ...statfs, flags };
  }

  pathconf(path: string, name: number): PathconfValue {
    const { backend, relativePath } = this.resolve(path);
    return backend.pathconf(relativePath, name);
  }

  mkdir(path: string, mode: number): void {
    const { backend, relativePath } = this.resolve(path);
    backend.mkdir(relativePath, mode);
  }

  rmdir(path: string): void {
    const { backend, relativePath } = this.resolve(path);
    backend.rmdir(relativePath);
  }

  unlink(path: string): void {
    const { backend, relativePath } = this.resolve(path);
    backend.unlink(relativePath);
  }

  rename(oldPath: string, newPath: string): void {
    const { backend, rel1, rel2 } = this.resolveTwoPaths(oldPath, newPath);
    backend.rename(rel1, rel2);
  }

  link(existingPath: string, newPath: string): void {
    const { backend, rel1, rel2 } = this.resolveTwoPaths(existingPath, newPath);
    backend.link(rel1, rel2);
  }

  symlink(target: string, path: string): void {
    const { backend, relativePath } = this.resolve(path);
    backend.symlink(target, relativePath);
  }

  readlink(path: string): string {
    const { backend, relativePath } = this.resolve(path);
    return backend.readlink(relativePath);
  }

  chmod(path: string, mode: number): void {
    const { backend, relativePath } = this.resolve(path);
    backend.chmod(relativePath, mode);
  }

  chown(path: string, uid: number, gid: number): void {
    const { backend, relativePath } = this.resolve(path);
    backend.chown(relativePath, uid, gid);
  }

  lchown(path: string, uid: number, gid: number): void {
    const { backend, relativePath } = this.resolve(path);
    backend.lchown(relativePath, uid, gid);
  }

  access(path: string, mode: number): void {
    const { backend, relativePath } = this.resolve(path);
    backend.access(relativePath, mode);
  }

  utimensat(path: string, atimeSec: number, atimeNsec: number, mtimeSec: number, mtimeNsec: number): void {
    const { backend, relativePath } = this.resolve(path);
    backend.utimensat(relativePath, atimeSec, atimeNsec, mtimeSec, mtimeNsec);
  }

  // --- Directory operations ---

  opendir(path: string): number {
    const { backend, backendId, relativePath } = this.resolve(path);
    const localHandle = backend.opendir(relativePath);
    const globalHandle = this.nextDirHandle++;
    this.dirHandles.set(globalHandle, { backend, backendId, localHandle });
    return globalHandle;
  }

  readdir(
    handle: number,
  ): { name: string; type: number; ino: number } | null {
    const info = this.getDirHandle(handle);
    return info.backend.readdir(info.localHandle);
  }

  closedir(handle: number): void {
    const info = this.getDirHandle(handle);
    info.backend.closedir(info.localHandle);
    this.dirHandles.delete(handle);
  }

  // --- Time operations ---

  /**
   * Replace the clock this machine reads.
   *
   * The guest clock belongs to the platform, not to the host it happens to
   * run on: a restored machine already carries a monotonic floor, and a
   * replicated one takes its readings from a log rather than from its own
   * host. Swapping the provider is how a machine changes which of those it
   * is without every syscall path having to know.
   */
  setTimeProvider(time: TimeProvider): void {
    this.time = time;
    this.publishTimeProvider();
  }

  clockGettime(clockId: number): { sec: number; nsec: number } {
    return this.time.clockGettime(clockId);
  }

  nanosleep(sec: number, nsec: number): void {
    this.time.nanosleep(sec, nsec);
  }
}

export interface PreparedPlatformFile {
  data: Uint8Array;
  stat: StatResult;
}

/**
 * Read a complete regular file through its owning PlatformIO mount.
 * Deferred backing is prepared before the synchronous descriptor operations,
 * so API reads and executable resolution share the same lazy-file semantics.
 */
export async function readPreparedPlatformFile(
  io: PlatformIO,
  path: string,
): Promise<PreparedPlatformFile> {
  await io.preparePath?.(path);
  const stat = io.stat(path);
  if (!Number.isSafeInteger(stat.size) || stat.size < 0) {
    const error = new Error(`EOVERFLOW: invalid file size for ${path}`) as
      Error & { code: string };
    error.code = "EOVERFLOW";
    throw error;
  }
  const handle = io.open(path, 0, 0);
  try {
    const data = new Uint8Array(stat.size);
    let offset = 0;
    while (offset < data.byteLength) {
      const count = io.read(
        handle,
        data.subarray(offset),
        null,
        data.byteLength - offset,
      );
      if (count <= 0) break;
      offset += count;
    }
    return {
      data: offset === data.byteLength ? data : data.slice(0, offset),
      stat,
    };
  } finally {
    io.close(handle);
  }
}
