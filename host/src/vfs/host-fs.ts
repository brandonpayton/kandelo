/**
 * HostFileSystem — a Node.js passthrough FileSystemBackend.
 *
 * All paths are sandboxed under `rootPath`; any attempt to escape
 * via `../` or symlinks resolving outside the root is rejected.
 */

import * as fs from "node:fs";
import * as nodePath from "node:path";
import {
  HostAppendContractError,
  isHostAppendContractError,
} from "../append-contract";
import type {
  AppendOutcome,
  HostFileOffset,
  PathconfValue,
  StatResult,
  StatfsResult,
} from "../types";
import {
  advanceHostFilePosition,
  checkedHostFilePosition,
  checkedSeekPosition,
  hostFileOffsetFromBigInt,
  hostFilePositionForNodeRead,
  hostFilePositionToSafeNumber,
} from "../file-offset";
import {
  NativePositionedWriteHandles,
  openNativeBackingFile,
} from "../native-positioned-write";
import { NativeMetadataOverlay } from "../platform/native-metadata";
import { filesystemPathconf } from "../pathconf";
import {
  DIRENT_TYPES,
  OPEN_FLAGS,
  SEEK_WHENCE,
} from "../generated/abi";
import { ST_NOSUID, type FileSystemBackend, type DirEntry } from "./types";
import type { CheckpointBytes } from "../migration/checkpoint";
import { DEFAULT_STATFS_BLOCK_SIZE, DEFAULT_STATFS_NAMELEN } from "../statfs";

const UTIME_NOW = 0x3fffffff;
const UTIME_OMIT = 0x3ffffffe;
const MAX_SIGNED_I64 = (1n << 63n) - 1n;
const intrinsicBigInt = BigInt;
const intrinsicNumber = Number;
const intrinsicNumberIsSafeInteger = Number.isSafeInteger;
const intrinsicApply = Reflect.apply;
const intrinsicWeakSetAdd = WeakSet.prototype.add;
const intrinsicWeakSetHas = WeakSet.prototype.has;
const exclusiveNativeWriterHostFileSystems = new WeakSet<object>();

interface HostFileSystemOptions {
  uid?: number;
  gid?: number;
  /** The caller owns every native writer for this directory's lifetime. */
  exclusiveNativeWriters?: boolean;
}

function makeHostFsError(code: string, message: string): Error & { code: string } {
  const error = new Error(`${code}: ${message}`) as Error & { code: string };
  error.code = code;
  return error;
}

/**
 * Construct the backing for a freshly created, lifecycle-owned Node session
 * directory. This factory is intentionally not re-exported from the public VFS
 * entry point; the internal fresh-session resolver is its sole production
 * caller.
 */
export function createSessionOwnedHostFileSystem(
  rootPath: string,
): HostFileSystem {
  const backend = new HostFileSystem(rootPath);
  intrinsicApply(intrinsicWeakSetAdd, exclusiveNativeWriterHostFileSystems, [backend]);
  return backend;
}

/**
 * Translate Linux/POSIX open flags (as used by musl libc) to the
 * platform-native flag values that Node.js `fs.openSync` expects.
 * The numeric values differ between Linux and macOS/BSD.
 */
export function translateOpenFlags(linuxFlags: number): number {
  let native = 0;

  // Access mode (bottom 2 bits)
  if (linuxFlags & OPEN_FLAGS.O_RDWR) native |= fs.constants.O_RDWR;
  else if (linuxFlags & OPEN_FLAGS.O_WRONLY) native |= fs.constants.O_WRONLY;
  // else O_RDONLY = 0

  if (linuxFlags & OPEN_FLAGS.O_CREAT) native |= fs.constants.O_CREAT;
  if (linuxFlags & OPEN_FLAGS.O_EXCL) native |= fs.constants.O_EXCL;
  if (linuxFlags & OPEN_FLAGS.O_TRUNC) native |= fs.constants.O_TRUNC;
  if (linuxFlags & OPEN_FLAGS.O_APPEND) native |= fs.constants.O_APPEND;
  if (linuxFlags & OPEN_FLAGS.O_NONBLOCK) native |= fs.constants.O_NONBLOCK;
  if (linuxFlags & OPEN_FLAGS.O_DIRECTORY && fs.constants.O_DIRECTORY)
    native |= fs.constants.O_DIRECTORY;
  if (linuxFlags & OPEN_FLAGS.O_NOFOLLOW && fs.constants.O_NOFOLLOW)
    native |= fs.constants.O_NOFOLLOW;
  if (linuxFlags & OPEN_FLAGS.O_NOCTTY && fs.constants.O_NOCTTY)
    native |= fs.constants.O_NOCTTY;
  // O_LARGEFILE and O_CLOEXEC have no Node.js equivalent; ignored.

  return native;
}

function asSafeInteger(value: number | bigint | undefined): number {
  if (typeof value === "bigint") {
    if (value <= 0n) return 0;
    const max = BigInt(Number.MAX_SAFE_INTEGER);
    return Number(value > max ? max : value);
  }
  if (value === undefined || !Number.isFinite(value) || value <= 0) return 0;
  return Math.min(Math.floor(value), Number.MAX_SAFE_INTEGER);
}

export function nativeStatfs(path: string): StatfsResult {
  const statfs = fs.statfsSync(path, { bigint: false });
  const bsize = asSafeInteger(statfs.bsize) || DEFAULT_STATFS_BLOCK_SIZE;
  return {
    type: statfs.type >>> 0,
    bsize,
    blocks: asSafeInteger(statfs.blocks),
    bfree: asSafeInteger(statfs.bfree),
    bavail: asSafeInteger(statfs.bavail),
    files: asSafeInteger(statfs.files),
    ffree: asSafeInteger(statfs.ffree),
    fsid: 0,
    namelen: DEFAULT_STATFS_NAMELEN,
    frsize: bsize,
    flags: ST_NOSUID,
  };
}

export class HostFileSystem implements FileSystemBackend {
  private rootPath: string;
  private guestMountPoint: string;
  private fdPositions = new Map<number, HostFileOffset>();
  private readonly positionedWrites = new NativePositionedWriteHandles();
  private dirHandles = new Map<number, fs.Dir>();
  private nextDirHandle = 1;
  private metadata: NativeMetadataOverlay;

  constructor(
    rootPath: string,
    guestMountPoint = "/",
    options: HostFileSystemOptions = {},
  ) {
    const resolvedRoot = nodePath.resolve(rootPath);
    this.rootPath = fs.existsSync(resolvedRoot)
      ? fs.realpathSync(resolvedRoot)
      : resolvedRoot;
    this.guestMountPoint = this.normalizeGuestMountPoint(guestMountPoint);
    this.metadata = new NativeMetadataOverlay(
      options.uid ?? 0,
      options.gid ?? 0,
    );
    if (options.exclusiveNativeWriters === true) {
      intrinsicApply(intrinsicWeakSetAdd, exclusiveNativeWriterHostFileSystems, [this]);
    }
  }

  /**
   * The reason names the backing kind and not the path: a checkpoint travels
   * to another computer, and the sandbox root is this computer's business.
   */
  checkpointBytes(): CheckpointBytes {
    return {
      kind: "none",
      reason: "a host directory backs this mount and owns no shared buffer",
    };
  }

  /**
   * Resolve a mount-relative guest path to an absolute host path, ensuring it
   * stays within `rootPath`.
   *
   * This intentionally resolves components one at a time instead of using
   * `path.resolve()`. POSIX pathname resolution must look up an intermediate
   * component before a following `..` can step back out of it:
   * `existing/missing/../file` fails with ENOENT because `missing` is looked
   * up as a directory first. Lexical normalization would incorrectly collapse
   * that to `existing/file`.
   *
   * Resolved prefixes are deliberately not cached. A host-backed tree can be
   * changed externally or through another mount of the same directory; using
   * a stale prefix after a directory-to-symlink replacement would bypass the
   * component checks below.
   *
   * Native symlink targets are stored as guest strings. When following a
   * symlink whose target is absolute and still inside this mount, translate it
   * back to a mount-relative path before continuing. This preserves readlink(2)
   * output while allowing stat/open/chmod to follow absolute in-guest links.
   */
  private safePath(relative: string, followFinal = true): string {
    const hadTrailingSlash = relative.length > 1 && /\/+$/.test(relative);
    let current = this.rootPath;
    let pending = this.pathParts(relative);
    let symlinkDepth = 0;

    while (pending.length > 0) {
      const part = pending.shift()!;
      if (part === ".") continue;
      if (part === "..") {
        if (current === this.rootPath) {
          throw new Error("EACCES: path traversal blocked");
        }
        current = nodePath.dirname(current);
        continue;
      }

      const candidate = nodePath.join(current, part);
      const isFinal = pending.length === 0;
      const shouldFollow = !isFinal || followFinal;

      let lst: fs.Stats | null = null;
      try {
        lst = fs.lstatSync(candidate);
      } catch (err: any) {
        if (isFinal && err?.code === "ENOENT") {
          current = candidate;
          break;
        }
        throw err;
      }

      if (shouldFollow && lst.isSymbolicLink()) {
        if (++symlinkDepth > 40)
          throw new Error("ELOOP: too many symbolic links");
        const target = fs.readlinkSync(candidate, "utf8");
        if (target.startsWith("/")) {
          const mountRelative = this.guestAbsoluteToMountRelative(target);
          if (mountRelative === null) {
            throw new Error("EACCES: absolute symlink target escapes mount");
          }
          current = this.rootPath;
          pending = [...this.pathParts(mountRelative), ...pending];
        } else {
          pending = [...this.pathParts(target), ...pending];
        }
        continue;
      }

      if (!isFinal && !lst.isDirectory()) {
        throw new Error("ENOTDIR: not a directory");
      }

      if (!isFinal) {
        current = fs.realpathSync(candidate);
        this.assertWithinRoot(current);
      } else {
        current = candidate;
      }
    }

    if (
      hadTrailingSlash &&
      current !== this.rootPath &&
      !current.endsWith(nodePath.sep)
    ) {
      // Keep a final separator for native fs calls. POSIX requires a
      // trailing slash to resolve the preceding component as a directory; the
      // native call then returns ENOTDIR for regular files while still
      // permitting operations such as mkdir("new-dir/").
      current += nodePath.sep;
    }
    this.assertWithinRoot(current);
    return current;
  }

  private normalizeGuestMountPoint(mountPoint: string): string {
    if (!mountPoint.startsWith("/")) mountPoint = `/${mountPoint}`;
    return mountPoint !== "/" && mountPoint.endsWith("/")
      ? mountPoint.slice(0, -1)
      : mountPoint;
  }

  private pathParts(path: string): string[] {
    return path
      .replace(/^\/+/, "")
      .split("/")
      .filter((part) => part.length > 0 && part !== ".");
  }

  private guestAbsoluteToMountRelative(path: string): string | null {
    if (this.guestMountPoint === "/") return path;
    if (path === this.guestMountPoint) return "/";
    if (path.startsWith(`${this.guestMountPoint}/`)) {
      return path.slice(this.guestMountPoint.length) || "/";
    }
    return null;
  }

  private assertWithinRoot(path: string): void {
    const rel = nodePath.relative(this.rootPath, path);
    if (rel === "") return;
    if (
      rel === ".." ||
      rel.startsWith(`..${nodePath.sep}`) ||
      nodePath.isAbsolute(rel)
    ) {
      throw new Error("EACCES: path traversal blocked");
    }
  }

  private toStatResult(s: fs.BigIntStats): StatResult {
    // Normalize uid/gid to match Process::new's default euid (0).
    // The real macOS/Linux uid of the user running the kernel is not
    // exposed to guest programs — guest sees the sandbox as
    // self-owned, so tools that compare ownership against their own
    // euid (e.g. git's "dubious ownership" check) see a match.
    // chmod/chown are virtualized through the same overlay so host-backed
    // mounts never mutate native permission or ownership bits.
    return this.metadata.toStatResult(s);
  }

  // ── File handle operations ───────────────────────────────────

  open(path: string, flags: number, mode: number): number {
    const noFollowFinal =
      (flags & OPEN_FLAGS.O_NOFOLLOW) !== 0 ||
      ((flags & OPEN_FLAGS.O_CREAT) !== 0 &&
        (flags & OPEN_FLAGS.O_EXCL) !== 0);
    const nativePath = this.safePath(path, !noFollowFinal);
    const truncate = (flags & OPEN_FLAGS.O_TRUNC) !== 0;
    const nativeFlags = translateOpenFlags(flags);
    const { fd, created } = openNativeBackingFile(
      nativePath,
      truncate ? nativeFlags & ~fs.constants.O_TRUNC : nativeFlags,
      flags,
      mode,
    );
    try {
      if (created) {
        this.metadata.chmod(fs.fstatSync(fd, { bigint: true }), mode);
      }
      this.fdPositions.set(fd, 0);
      this.positionedWrites.register(fd, flags, nativePath);
      if (!created && truncate) {
        const truncateHandle = this.positionedWrites.forTruncate(
          fd,
          flags,
          nativePath,
        );
        const before = fs.fstatSync(fd, { bigint: true });
        const commit = before.size === 0n
          ? null
          : this.metadata.prepareNativeContentChange(before);
        fs.ftruncateSync(truncateHandle, 0);
        commit?.();
      }
      return fd;
    } catch (error) {
      this.fdPositions.delete(fd);
      try {
        this.positionedWrites.close(fd);
      } catch {
        // Preserve the route-establishment failure.
      }
      throw error;
    }
  }

  close(handle: number): number {
    try {
      this.positionedWrites.close(handle);
    } finally {
      this.fdPositions.delete(handle);
    }
    return 0;
  }

  read(
    handle: number,
    buffer: Uint8Array,
    offset: HostFileOffset | null,
    length: number,
  ): number {
    const pos = hostFilePositionForNodeRead(
      offset ?? this.fdPositions.get(handle) ?? 0,
      length,
    );
    const bytesRead = fs.readSync(handle, buffer, 0, length, pos);
    if (offset === null) {
      this.fdPositions.set(
        handle,
        advanceHostFilePosition(pos, bytesRead),
      );
    }
    return bytesRead;
  }

  write(
    handle: number,
    buffer: Uint8Array,
    offset: HostFileOffset | null,
    length: number,
  ): number {
    const pos = offset ?? this.fdPositions.get(handle) ?? 0;
    // Node's synchronous write API cannot represent a bigint position.
    const nativePos = hostFilePositionToSafeNumber(pos);
    const writeHandle = this.positionedWrites.forWrite(
      handle,
      offset !== null,
    );
    const bytesWritten = fs.writeSync(
      writeHandle,
      buffer,
      0,
      length,
      nativePos,
    );
    if (bytesWritten > 0) {
      this.metadata.noteNativeContentChange(
        fs.fstatSync(handle, { bigint: true }),
      );
    }
    if (offset === null) {
      this.fdPositions.set(
        handle,
        advanceHostFilePosition(pos, bytesWritten),
      );
    }
    return bytesWritten;
  }

  append(
    handle: number,
    buffer: Uint8Array,
    length: number,
    limit: HostFileOffset | null,
  ): AppendOutcome {
    if (
      !intrinsicApply(
        intrinsicWeakSetHas,
        exclusiveNativeWriterHostFileSystems,
        [this],
      )
    ) {
      // A later fstat cannot identify where this append ended if an unrelated
      // native writer may run before or after it. Do not fabricate an exact
      // outcome even when no file-size limit is active.
      throw makeHostFsError(
        "EOPNOTSUPP",
        "exact append outcomes require exclusive native-writer ownership",
      );
    }
    const appendHandle = this.positionedWrites.forAppend(handle);
    if (
      !intrinsicNumberIsSafeInteger(length)
      || length < 0
      || length > buffer.byteLength
    ) {
      throw makeHostFsError("EINVAL", "invalid append length");
    }
    const before = fs.fstatSync(appendHandle, { bigint: true });
    const start = before.size;
    const startOffset = hostFileOffsetFromBigInt(start);
    const exactLimit = limit === null
      ? null
      : intrinsicBigInt(checkedHostFilePosition(limit));
    if (exactLimit !== null && start >= exactLimit) {
      this.fdPositions.set(handle, startOffset);
      return { written: 0, end: startOffset };
    }

    const offsetCapacity = MAX_SIGNED_I64 - start;
    if (offsetCapacity < 0n) {
      throw makeHostFsError("EOVERFLOW", "append start is outside signed i64");
    }
    const limitedCapacity = exactLimit === null
      ? offsetCapacity
      : exactLimit - start < offsetCapacity
        ? exactLimit - start
        : offsetCapacity;
    const writableLength = limitedCapacity < intrinsicBigInt(length)
      ? intrinsicNumber(limitedCapacity)
      : length;
    if (length > 0 && writableLength === 0 && exactLimit === null) {
      throw makeHostFsError("EOVERFLOW", "append end would exceed signed i64");
    }
    const bytesWritten = writableLength === 0
      ? 0
      : fs.writeSync(
        appendHandle,
        buffer,
        0,
        writableLength,
        null,
      );
    if (
      !intrinsicNumberIsSafeInteger(bytesWritten)
      || bytesWritten < 0
      || bytesWritten > writableLength
    ) {
      throw new HostAppendContractError(
        "native append returned an invalid byte count",
      );
    }
    try {
      const exactEnd = start + intrinsicBigInt(bytesWritten);
      const stat = fs.fstatSync(handle, { bigint: true });
      if (stat.size !== exactEnd) {
        throw new HostAppendContractError(
          "session-owned append observed an unexpected native file size",
        );
      }
      if (bytesWritten > 0) {
        this.metadata.noteNativeContentChange(stat);
      }
      const end = hostFileOffsetFromBigInt(exactEnd);
      this.fdPositions.set(handle, end);
      return { written: bytesWritten, end };
    } catch (error) {
      if (isHostAppendContractError(error)) throw error;
      // The native write already returned success. Any failure to verify and
      // publish its exact end must poison the kernel generation rather than
      // masquerade as an ordinary retryable filesystem errno.
      throw new HostAppendContractError(
        "session-owned append could not verify its post-write outcome",
      );
    }
  }

  seek(
    handle: number,
    offset: HostFileOffset,
    whence: number,
  ): HostFileOffset {
    let newPos: HostFileOffset;
    switch (whence) {
      case SEEK_WHENCE.SEEK_SET:
        newPos = checkedSeekPosition(0, offset);
        break;
      case SEEK_WHENCE.SEEK_CUR:
        newPos = checkedSeekPosition(this.fdPositions.get(handle) ?? 0, offset);
        break;
      case SEEK_WHENCE.SEEK_END:
        newPos = checkedSeekPosition(
          hostFileOffsetFromBigInt(
            fs.fstatSync(handle, { bigint: true }).size,
          ),
          offset,
        );
        break;
      default:
        throw makeHostFsError("EINVAL", `invalid whence value: ${whence}`);
    }
    this.fdPositions.set(handle, newPos);
    return newPos;
  }

  fstat(handle: number): StatResult {
    return this.toStatResult(fs.fstatSync(handle, { bigint: true }));
  }

  fpathconf(handle: number, name: number): PathconfValue {
    // Validate the live descriptor. The remaining values are Kandelo
    // namespace/backend capabilities and do not depend on a remembered path,
    // so this remains valid after the opened file is renamed or unlinked.
    const stat = this.fstat(handle);
    return filesystemPathconf(
      stat,
      name,
      {
        supportsSymlinks: true,
        timestampResolutionNs: 1_000_000,
      },
    );
  }

  ftruncate(handle: number, length: number): void {
    const before = fs.fstatSync(handle, { bigint: true });
    const commit = before.size === BigInt(length)
      ? null
      : this.metadata.prepareNativeContentChange(before);
    fs.ftruncateSync(handle, length);
    commit?.();
  }

  fsync(handle: number): void {
    fs.fsyncSync(handle);
  }

  fchmod(handle: number, mode: number): void {
    this.metadata.chmod(fs.fstatSync(handle, { bigint: true }), mode);
  }

  fchown(handle: number, uid: number, gid: number): void {
    this.metadata.chown(fs.fstatSync(handle, { bigint: true }), uid, gid);
  }

  // ── Path-based operations ───────────────────────────────────

  stat(path: string): StatResult {
    return this.toStatResult(
      fs.statSync(this.safePath(path), { bigint: true }),
    );
  }

  lstat(path: string): StatResult {
    return this.toStatResult(
      fs.lstatSync(this.safePath(path, false), { bigint: true }),
    );
  }

  statfs(path: string): StatfsResult {
    return nativeStatfs(this.safePath(path));
  }

  pathconf(path: string, name: number): PathconfValue {
    const nativePath = this.safePath(path);
    const stat = this.toStatResult(fs.statSync(nativePath, { bigint: true }));
    return filesystemPathconf(
      stat,
      name,
      {
        supportsSymlinks: true,
        timestampResolutionNs: 1_000_000,
      },
    );
  }

  mkdir(path: string, mode: number): void {
    const nativePath = this.safePath(path, false);
    fs.mkdirSync(nativePath, { mode });
    this.metadata.chmod(fs.statSync(nativePath, { bigint: true }), mode);
  }

  rmdir(path: string): void {
    const nativePath = this.safePath(path, false);
    const stat = fs.lstatSync(nativePath, { bigint: true });
    fs.rmdirSync(nativePath);
    this.metadata.forget(stat);
  }

  unlink(path: string): void {
    const nativePath = this.safePath(path, false);
    const stat = fs.lstatSync(nativePath, { bigint: true });
    fs.unlinkSync(nativePath);
    if (stat.nlink <= 1n) this.metadata.forget(stat);
  }

  rename(oldPath: string, newPath: string): void {
    const nativeNewPath = this.safePath(newPath, false);
    let replaced: fs.BigIntStats | undefined;
    try {
      replaced = fs.lstatSync(nativeNewPath, { bigint: true });
    } catch {}
    fs.renameSync(this.safePath(oldPath, false), nativeNewPath);
    if (replaced !== undefined && replaced.nlink <= 1n)
      this.metadata.forget(replaced);
  }

  link(existingPath: string, newPath: string): void {
    // Resolve intermediate components ourselves, but leave the final source
    // component to native link(2). POSIX permits link() either to follow a
    // final symlink or to link the symlink inode; native hosts differ here.
    fs.linkSync(
      this.safePath(existingPath, false),
      this.safePath(newPath, false),
    );
  }

  symlink(target: string, path: string): void {
    fs.symlinkSync(target, this.safePath(path, false));
  }

  readlink(path: string): string {
    return fs.readlinkSync(this.safePath(path, false), "utf8");
  }

  chmod(path: string, mode: number): void {
    this.metadata.chmod(
      fs.statSync(this.safePath(path), { bigint: true }),
      mode,
    );
  }

  chown(path: string, uid: number, gid: number): void {
    this.metadata.chown(
      fs.statSync(this.safePath(path), { bigint: true }),
      uid,
      gid,
    );
  }

  lchown(path: string, uid: number, gid: number): void {
    this.metadata.chown(
      fs.lstatSync(this.safePath(path, false), { bigint: true }),
      uid,
      gid,
    );
  }

  access(path: string, mode: number): void {
    this.metadata.access(
      fs.statSync(this.safePath(path), { bigint: true }),
      mode,
    );
  }

  utimensat(
    path: string,
    atimeSec: number,
    atimeNsec: number,
    mtimeSec: number,
    mtimeNsec: number,
  ): void {
    const nativePath = this.safePath(path);
    if (atimeNsec === UTIME_OMIT && mtimeNsec === UTIME_OMIT) return;

    const stat = fs.statSync(nativePath, { bigint: true });
    const current = this.metadata.toStatResult(stat);
    const nowMs = Date.now();
    const atimeMs =
      atimeNsec === UTIME_OMIT
        ? current.atimeMs
        : atimeNsec === UTIME_NOW
          ? nowMs
          : atimeSec * 1000 + Math.floor(atimeNsec / 1_000_000);
    const mtimeMs =
      mtimeNsec === UTIME_OMIT
        ? current.mtimeMs
        : mtimeNsec === UTIME_NOW
          ? nowMs
          : mtimeSec * 1000 + Math.floor(mtimeNsec / 1_000_000);
    fs.utimesSync(nativePath, atimeMs / 1000, mtimeMs / 1000);
    this.metadata.utimens(
      stat,
      atimeMs,
      mtimeMs,
      fs.statSync(nativePath, { bigint: true }),
    );
  }

  // ── Directory iteration ─────────────────────────────────────

  opendir(path: string): number {
    const dir = fs.opendirSync(this.safePath(path));
    const handle = this.nextDirHandle++;
    this.dirHandles.set(handle, dir);
    return handle;
  }

  readdir(handle: number): DirEntry | null {
    const dir = this.dirHandles.get(handle);
    if (!dir) throw new Error("Invalid dir handle");
    const entry = dir.readSync();
    if (!entry) return null;

    let dtype: number = DIRENT_TYPES.DT_UNKNOWN;
    if (entry.isFile())
      dtype = DIRENT_TYPES.DT_REG;
    else if (entry.isDirectory())
      dtype = DIRENT_TYPES.DT_DIR;
    else if (entry.isSymbolicLink())
      dtype = DIRENT_TYPES.DT_LNK;
    else if (entry.isFIFO())
      dtype = DIRENT_TYPES.DT_FIFO;
    else if (entry.isSocket())
      dtype = DIRENT_TYPES.DT_SOCK;
    else if (entry.isCharacterDevice())
      dtype = DIRENT_TYPES.DT_CHR;
    else if (entry.isBlockDevice()) dtype = DIRENT_TYPES.DT_BLK;

    return { name: entry.name, type: dtype, ino: 0 };
  }

  closedir(handle: number): void {
    const dir = this.dirHandles.get(handle);
    if (!dir) throw new Error("Invalid dir handle");
    dir.closeSync();
    this.dirHandles.delete(handle);
  }
}
