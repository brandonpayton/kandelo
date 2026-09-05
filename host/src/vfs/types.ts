import type {
  AppendOutcome,
  HostFileOffset,
  PathconfValue,
  StatResult,
  StatfsResult,
} from "../types";
import type { CheckpointBytes } from "../migration/checkpoint";
import { STATFS_FLAGS } from "../generated/abi";

/** POSIX statfs(2) flag for filesystems that ignore set-ID mode bits. */
export const ST_NOSUID = STATFS_FLAGS.ST_NOSUID;

export type MountSetIdCapability =
  | { kind: "nosuid" }
  | {
      kind: "trusted-root-product";
      guestWritable: false;
      stableExecutableIdentity: true;
    };

export interface DirEntry {
  name: string;
  type: number;
  ino: number;
}

export interface FileSystemBackend {
  /** Materialize deferred path backing before synchronous file I/O. */
  preparePath?(path: string): Promise<boolean>;
  /** Stamp file times from the machine's clock rather than the host's. */
  setTimeProvider?(time: TimeProvider): void;
  /**
   * The bytes a machine checkpoint carries for this mount, or why there are none.
   *
   * A backend that leaves this out is recorded as unreadable, so a checkpoint
   * never omits a mount it could not read.
   */
  checkpointBytes?(): CheckpointBytes;
  // File handle operations
  open(path: string, flags: number, mode: number): number;
  close(handle: number): number;
  read(
    handle: number,
    buffer: Uint8Array,
    offset: HostFileOffset | null,
    length: number,
  ): number;
  write(
    handle: number,
    buffer: Uint8Array,
    offset: HostFileOffset | null,
    length: number,
  ): number;
  /**
   * Atomically resolve EOF, apply an optional exclusive file-size ceiling,
   * and append within one backing-owned operation.
   */
  append(
    handle: number,
    buffer: Uint8Array,
    length: number,
    limit: HostFileOffset | null,
  ): AppendOutcome;
  seek(
    handle: number,
    offset: HostFileOffset,
    whence: number,
  ): HostFileOffset;
  fstat(handle: number): StatResult;
  fpathconf(handle: number, name: number): PathconfValue;
  ftruncate(handle: number, length: number): void;
  fsync(handle: number): void;
  fchmod(handle: number, mode: number): void;
  fchown(handle: number, uid: number, gid: number): void;

  // Path operations (paths are mount-relative, already resolved)
  stat(path: string): StatResult;
  lstat(path: string): StatResult;
  statfs(path: string): StatfsResult;
  pathconf(path: string, name: number): PathconfValue;
  mkdir(path: string, mode: number): void;
  rmdir(path: string): void;
  unlink(path: string): void;
  rename(oldPath: string, newPath: string): void;
  link(existingPath: string, newPath: string): void;
  symlink(target: string, path: string): void;
  readlink(path: string): string;
  chmod(path: string, mode: number): void;
  chown(path: string, uid: number, gid: number): void;
  lchown(path: string, uid: number, gid: number): void;
  access(path: string, mode: number): void;
  utimensat(path: string, atimeSec: number, atimeNsec: number, mtimeSec: number, mtimeNsec: number): void;

  // Directory iteration
  opendir(path: string): number;
  /** A thrown error must leave the next directory entry unconsumed. */
  readdir(handle: number): DirEntry | null;
  closedir(handle: number): void;
}

export interface TimeProvider {
  clockGettime(clockId: number): { sec: number; nsec: number };
  /**
   * Keep every future CLOCK_MONOTONIC reading at or above `floorNs`.
   *
   * A restored machine adopts kernel state whose monotonic deadlines were
   * measured on the captured machine's clock. POSIX also forbids a guest's
   * monotonic clock from running backwards, and a fresh provider (a new
   * worker's `performance.now()` origin) starts near zero. The restore
   * advances this provider to the captured machine's reading, so deadlines
   * keep their remaining time and guest-visible monotonic time continues.
   */
  advanceMonotonicFloor?(floorNs: number): void;
  nanosleep(sec: number, nsec: number): void;
}

export interface MountConfig {
  mountPoint: string;
  backend: FileSystemBackend;
  readonly?: boolean;
  /** Ignore set-user-ID and set-group-ID mode bits on this mount. */
  nosuid?: boolean;
  /** @deprecated Private product authority is not used by the VFS router. */
  setIdCapability?: MountSetIdCapability;
}
