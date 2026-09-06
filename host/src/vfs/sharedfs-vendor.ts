/**
 * SharedFS — A block-based filesystem on SharedArrayBuffer.
 *
 * All synchronization uses Atomics (wait/notify/compareExchange)
 * so multiple workers can safely share the same buffer with no
 * message passing.
 *
 * Layout (same as the C implementation):
 *   Block 0:
 *     0..255: Superblock
 *     256..4095: FD table (24-byte entries, capacity derived from the
 *                 remaining block-0 space)
 *   Inode bitmap blocks
 *   Block bitmap blocks
 *   Inode table blocks
 *   Data blocks
 */

// ── Constants ────────────────────────────────────────────────────────

export const BLOCK_SIZE = 4096;
export const INODE_SIZE = 128;
export const INODES_PER_BLOCK = BLOCK_SIZE / INODE_SIZE; // 32
export const MAX_NAME = 255;
export const MAX_SYMLINK_HOPS = 8;
export const DIRECT_BLOCKS = 10;
export const PTRS_PER_BLOCK = BLOCK_SIZE / 4; // 1024
export const INLINE_SYMLINK_SIZE = DIRECT_BLOCKS * 4; // 40
export const ROOT_INO = 1;
export const FD_TABLE_OFFSET = 256;
export const FD_ENTRY_SIZE = 24;
export const MAX_FDS = Math.floor(
  (BLOCK_SIZE - FD_TABLE_OFFSET) / FD_ENTRY_SIZE,
);

export const MAGIC = 0x53464653; // "SFFS"
export const VERSION = 1;

// File types
export const S_IFREG = 0x8000;
export const S_IFDIR = 0x4000;
export const S_IFLNK = 0xa000;
export const S_IFMT = 0xf000;
const S_ISUID = 0o4000;
const S_ISGID = 0o2000;
const UID_GID_UNCHANGED = 0xffffffff;

function modeAfterRegularFileMutation(
  mode: number,
  kind: "content" | "ownership",
): number {
  if ((mode & S_IFMT) !== S_IFREG) return mode;
  // WHY: Kandelo does not implement System V mandatory locking for a
  // non-executable S_ISGID bit. Keep the mutation kind explicit for audit
  // call sites while deliberately applying the same clear-both policy.
  switch (kind) {
    case "content":
    case "ownership":
      return mode & ~(S_ISUID | S_ISGID);
  }
}

// Open flags
export const O_RDONLY = 0x0000;
export const O_WRONLY = 0x0001;
export const O_RDWR = 0x0002;
export const O_CREAT = 0x0040;
export const O_EXCL = 0x0080;
export const O_TRUNC = 0x0200;
export const O_APPEND = 0x0400;
export const O_DIRECTORY = 0x010000;
export const O_ACCMODE = 0x0003;

// Seek
export const SEEK_SET = 0;
export const SEEK_CUR = 1;
export const SEEK_END = 2;

// Dirent
const DIRENT_HEADER_SIZE = 8;
const DIR_INDEX_MIN_SIZE = 64 * 1024;

// Error codes
export const EPERM = -1;
export const ENOENT = -2;
export const EIO = -5;
export const EBADF = -9;
export const EBUSY = -16;
export const EEXIST = -17;
export const ENOTDIR = -20;
export const EISDIR = -21;
export const EINVAL = -22;
export const EMFILE = -24;
export const EFBIG = -27;
export const ENOSPC = -28;
export const EROFS = -30;
export const ENAMETOOLONG = -36;
export const ENOTEMPTY = -39;
export const ELOOP = -40;
export const EOVERFLOW = -75;

// Superblock field byte offsets
const SB_MAGIC = 0;
const SB_VERSION = 4;
const SB_BLOCK_SIZE = 8;
const SB_TOTAL_BLOCKS = 12;
const SB_TOTAL_INODES = 16;
const SB_FREE_BLOCKS = 20;
const SB_FREE_INODES = 24;
const SB_INODE_BITMAP_START = 28;
const SB_BLOCK_BITMAP_START = 32;
const SB_INODE_TABLE_START = 36;
const SB_DATA_START = 40;
const SB_INODE_BITMAP_BLOCKS = 44;
const SB_BLOCK_BITMAP_BLOCKS = 48;
const SB_INODE_TABLE_BLOCKS = 52;
const SB_GENERATION = 56;
const SB_GLOBAL_LOCK = 60;
const SB_NAMESPACE_LOCK = 64;
const SB_MAX_SIZE_BLOCKS = 68;
const SB_GROW_CHUNK_BLOCKS = 72;

// Inode field byte offsets (relative to inode start)
const INO_LOCK_STATE = 0;
const INO_MODE = 8;
const INO_LINK_COUNT = 12;
const INO_SIZE = 16; // uint64
const INO_MTIME = 24; // uint64 (milliseconds since epoch)
const INO_CTIME = 32; // uint64 (milliseconds since epoch)
const INO_ATIME = 40; // uint64 (milliseconds since epoch)
const INO_DIRECT = 48; // 10 * 4 bytes
const INO_INDIRECT = 88;
const INO_DOUBLE_INDIRECT = 92;
const INO_UID = 96; // u32
const INO_GID = 100; // u32
const INO_GENERATION = 104; // uint64, incremented when an inode slot is allocated
const INO_OPEN_COUNT = 112; // u32, open fd references
const INO_DIR_SEQUENCE = 116; // u32, incremented after every directory mutation
const INO_DATA_SEQUENCE = 120; // u32, incremented after explicit data mutation
// 124-127 reserved for future fields (flags, xattrs, etc.)

// FD entry layout
const FD_FREE = 0;
const FD_PUBLISHED = 1;
const FD_RESERVED = 2;
const FD_INO = 4;
const FD_OFFSET = 8; // uint64
const FD_FLAGS = 16;
const FD_IS_DIR = 20;

// Lock bits
const WRITER_BIT = 0x80000000 | 0; // -2147483648 as int32
const READER_MASK = 0x7fffffff | 0;
const MAX_FILE_BLOCKS =
  DIRECT_BLOCKS + PTRS_PER_BLOCK + PTRS_PER_BLOCK * PTRS_PER_BLOCK;
const MAX_FILE_SIZE = MAX_FILE_BLOCKS * BLOCK_SIZE;

// ── Types ────────────────────────────────────────────────────────────

export interface StatResult {
  ino: number;
  generation: number;
  dataSequence: number;
  mode: number;
  linkCount: number;
  size: number;
  mtime: number;
  ctime: number;
  atime: number;
  uid: number;
  gid: number;
}

export interface SharedFsAppendOutcome {
  readonly written: number;
  readonly end: number;
}

export interface SharedFsStats {
  blockSize: number;
  totalBlocks: number;
  freeBlocks: number;
  totalInodes: number;
  freeInodes: number;
  maxName: number;
}

export interface SharedFsImageCapacity {
  /** Serialized SharedArrayBuffer length carried by the image. */
  byteLength: number;
  /** Filesystem growth ceiling recorded in the serialized superblock. */
  maxByteLength: number;
}

export interface SharedFsIdentityState {
  ino: number;
  generation: number;
  dataSequence: number;
  mode: number;
  linkCount: number;
  size: number;
  uid: number;
  gid: number;
  /** Present only for symlinks; captured under the same namespace lock. */
  symlinkTarget?: string;
  paths: string[];
}

export interface SharedFsSnapshotOptions {
  /**
   * Replace every allocated inode's atime, mtime, and ctime in the detached
   * snapshot copy. The live filesystem is not modified.
   */
  normalizeTimestampsMs?: number;
}

export interface NamespaceEntryIdentity {
  ino: number;
  generation: number;
  linkCount: number;
  mode: number;
}

export interface RenameIdentityResult {
  source: NamespaceEntryIdentity;
  replaced?: NamespaceEntryIdentity;
}

/**
 * One conditional lazy-file replacement in an all-or-nothing archive commit.
 * Every candidate path is resolved while the namespace lock is held; the
 * first name that still identifies the expected untouched stub is used.
 */
export interface ConditionalFileReplacement {
  paths: readonly string[];
  expectedIno: number;
  expectedGeneration: number;
  expectedDataSequence: number;
  data: Uint8Array;
}

/**
 * Exact namespace state that must still exist when a multi-tree transaction
 * commits. Paths are resolved without following the final symlink.
 */
export interface ConditionalNamespaceIdentity {
  path: string;
  expectedIno: number;
  expectedGeneration: number;
  expectedDataSequence: number;
  expectedMode: number;
  expectedLinkCount: number;
  expectedSize: number;
  expectedUid: number;
  expectedGid: number;
}

interface DirIndexEntry {
  ino: number;
  abs: number;
  recLen: number;
  nameLen: number;
}

interface DirIndex {
  generation: number;
  mutationSequence: number;
  size: number;
  entries: Map<string, DirIndexEntry>;
  free: Array<{ abs: number; recLen: number }>;
}

const ERROR_MESSAGES: Record<number, string> = {
  [ENOENT]: "No such file or directory",
  [EIO]: "I/O error",
  [EBADF]: "Bad file descriptor",
  [EBUSY]: "Device or resource busy",
  [EEXIST]: "File exists",
  [ENOTDIR]: "Not a directory",
  [EISDIR]: "Is a directory",
  [EINVAL]: "Invalid argument",
  [EMFILE]: "Too many open files",
  [EFBIG]: "File too large",
  [ENOSPC]: "No space left on device",
  [EROFS]: "Read-only file system",
  [ENAMETOOLONG]: "File name too long",
  [ENOTEMPTY]: "Directory not empty",
  [ELOOP]: "Too many symbolic links",
  [EOVERFLOW]: "Value too large for data type",
};

export class SFSError extends Error {
  constructor(
    public code: number,
    message?: string,
  ) {
    super(message || ERROR_MESSAGES[code] || `Error ${code}`);
    this.name = "SFSError";
  }
}

// ── Helpers ──────────────────────────────────────────────────────────

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const DOTDOT_BYTES = encoder.encode("..");

function isReservedDirectoryName(name: string): boolean {
  return name === "." || name === "..";
}

/**
 * Safely decode a Uint8Array that may be backed by SharedArrayBuffer.
 * Browsers reject SAB-backed views in TextDecoder.decode().
 */
function safeDecode(view: Uint8Array): string {
  if (view.buffer instanceof SharedArrayBuffer) {
    return decoder.decode(new Uint8Array(view));
  }
  return decoder.decode(view);
}

function align4(x: number): number {
  return (x + 3) & ~3;
}

// ── SharedFS ─────────────────────────────────────────────────────────

export class SharedFS {
  private view: DataView;
  private i32: Int32Array;
  private u8: Uint8Array;
  private dirIndexes = new Map<number, DirIndex>();
  private blockAllocHint = 0;
  private inodeAllocHint = 2;
  private atomicsWaitAllowed: boolean | undefined;
  private clock: () => number = () => Date.now();

  /**
   * Directory operations are stored in ext2-style variable-length entries.
   * Workloads such as PHP's bug36365 test create tens of thousands of files in
   * one directory. Once a directory reaches this threshold, retain validated
   * entry locations so each repeated exact-name lookup does not rescan every
   * preceding variable-length record.
   */
  private constructor(public readonly buffer: SharedArrayBuffer) {
    this.view = new DataView(buffer);
    this.i32 = new Int32Array(buffer);
    this.u8 = new Uint8Array(buffer);
  }

  /**
   * Replace the wall clock that stamps inode atime, mtime and ctime, in
   * milliseconds since the epoch. Inode times are machine state, so a machine
   * replaying a recorded clock must stamp the recorded milliseconds rather
   * than whatever its own host reads.
   */
  setClock(now: () => number): void {
    this.clock = now;
  }

  // ── Factory methods ──────────────────────────────────────────────

  static mkfs(buffer: SharedArrayBuffer, maxSizeBytes?: number): SharedFS {
    const sizeBytes = buffer.byteLength;
    if (sizeBytes < BLOCK_SIZE * 16) throw new SFSError(EINVAL);

    let totalBlocks = Math.floor(sizeBytes / BLOCK_SIZE);
    const maxBlocks = maxSizeBytes
      ? Math.floor(maxSizeBytes / BLOCK_SIZE)
      : totalBlocks * 4;

    // Size inodes for max capacity so we don't run out after growth
    let totalInodes = Math.floor(maxBlocks / 4);
    if (totalInodes < 32) totalInodes = 32;
    totalInodes = Math.ceil(totalInodes / INODES_PER_BLOCK) * INODES_PER_BLOCK;

    const inodeBitmapBlocks = Math.ceil(totalInodes / (BLOCK_SIZE * 8));
    const blockBitmapBlocks = Math.ceil(maxBlocks / (BLOCK_SIZE * 8));
    const inodeTableBlocks = Math.ceil((totalInodes * INODE_SIZE) / BLOCK_SIZE);

    const inodeBitmapStart = 1;
    const blockBitmapStart = inodeBitmapStart + inodeBitmapBlocks;
    const inodeTableStart = blockBitmapStart + blockBitmapBlocks;
    const dataStart = inodeTableStart + inodeTableBlocks;

    if (dataStart >= totalBlocks) {
      // A growable filesystem sizes its inode and block bitmaps for the
      // configured maximum, not just the current buffer length. Large maxima
      // can therefore require more metadata blocks than fit in a deliberately
      // small initial buffer. Grow enough to format the metadata plus the root
      // directory; ordinary data allocation remains lazy after mkfs.
      const minimumBytes = (dataStart + 1) * BLOCK_SIZE;
      try {
        (buffer as SharedArrayBuffer & { grow(size: number): void }).grow(
          minimumBytes,
        );
      } catch {
        throw new SFSError(ENOSPC);
      }
      totalBlocks = Math.floor(buffer.byteLength / BLOCK_SIZE);
      if (dataStart >= totalBlocks) throw new SFSError(ENOSPC);
    }

    // Zero the buffer
    new Uint8Array(buffer).fill(0);

    const fs = new SharedFS(buffer);

    // Write superblock
    fs.w32(SB_MAGIC, MAGIC);
    fs.w32(SB_VERSION, VERSION);
    fs.w32(SB_BLOCK_SIZE, BLOCK_SIZE);
    fs.w32(SB_TOTAL_BLOCKS, totalBlocks);
    fs.w32(SB_TOTAL_INODES, totalInodes);
    fs.w32(SB_INODE_BITMAP_START, inodeBitmapStart);
    fs.w32(SB_BLOCK_BITMAP_START, blockBitmapStart);
    fs.w32(SB_INODE_TABLE_START, inodeTableStart);
    fs.w32(SB_DATA_START, dataStart);
    fs.w32(SB_INODE_BITMAP_BLOCKS, inodeBitmapBlocks);
    fs.w32(SB_BLOCK_BITMAP_BLOCKS, blockBitmapBlocks);
    fs.w32(SB_INODE_TABLE_BLOCKS, inodeTableBlocks);
    fs.w32(SB_MAX_SIZE_BLOCKS, maxBlocks);
    fs.w32(SB_GROW_CHUNK_BLOCKS, 256);

    // Mark metadata blocks as used in block bitmap
    const bbStart = blockBitmapStart * BLOCK_SIZE;
    for (let b = 0; b < dataStart; b++) {
      const wordIdx = (bbStart >> 2) + (b >> 5);
      fs.i32[wordIdx] |= 1 << (b & 31);
    }

    const freeDataBlocks = totalBlocks - dataStart;
    Atomics.store(fs.i32, SB_FREE_BLOCKS >> 2, freeDataBlocks);
    fs.blockAllocHint = dataStart;

    // Mark inodes 0 and 1 as used
    const ibStart = inodeBitmapStart * BLOCK_SIZE;
    fs.i32[ibStart >> 2] |= 0x3;
    Atomics.store(fs.i32, SB_FREE_INODES >> 2, totalInodes - 2);
    fs.inodeAllocHint = 2;

    // Initialize root inode (inode 1) as empty directory
    const rootOff = fs.inodeOffset(ROOT_INO);
    fs.w32(rootOff + INO_MODE, S_IFDIR | 0o755);
    fs.w32(rootOff + INO_LINK_COUNT, 2);
    fs.w64(rootOff + INO_GENERATION, 1);

    // Allocate a data block for root's directory entries
    const rootBlock = fs.blockAlloc();
    if (rootBlock < 0) throw new SFSError(ENOSPC);
    fs.w32(rootOff + INO_DIRECT, rootBlock);

    // Write "." and ".." entries
    const dBase = rootBlock * BLOCK_SIZE;
    const dotRecLen = align4(DIRENT_HEADER_SIZE + 1);
    const dotdotRecLen = align4(DIRENT_HEADER_SIZE + 2);

    // "."
    fs.w32(dBase, ROOT_INO); // ino
    fs.view.setUint16(dBase + 4, dotRecLen, true); // rec_len
    fs.view.setUint16(dBase + 6, 1, true); // name_len
    fs.u8[dBase + DIRENT_HEADER_SIZE] = 0x2e; // '.'

    // ".."
    const ddOff = dBase + dotRecLen;
    fs.w32(ddOff, ROOT_INO);
    fs.view.setUint16(ddOff + 4, dotdotRecLen, true);
    fs.view.setUint16(ddOff + 6, 2, true);
    fs.u8[ddOff + DIRENT_HEADER_SIZE] = 0x2e;
    fs.u8[ddOff + DIRENT_HEADER_SIZE + 1] = 0x2e;

    fs.w64(rootOff + INO_SIZE, dotRecLen + dotdotRecLen);

    Atomics.store(fs.i32, SB_GENERATION >> 2, 1);

    return fs;
  }

  /**
   * Inspect the capacity contract stored in a serialized SharedFS buffer.
   * Unlike statfs(), this is independent of the runtime buffer used to restore
   * the image, so callers can recreate its original growth ceiling.
   */
  static inspectImageCapacity(buffer: Uint8Array): SharedFsImageCapacity {
    if (buffer.byteLength < SB_MAX_SIZE_BLOCKS + 4) {
      throw new SFSError(EINVAL, "SharedFS image is too small");
    }
    const view = new DataView(
      buffer.buffer,
      buffer.byteOffset,
      buffer.byteLength,
    );
    if (view.getUint32(SB_MAGIC, true) !== MAGIC) {
      throw new SFSError(EINVAL, "Bad magic");
    }
    if (view.getUint32(SB_VERSION, true) !== VERSION) {
      throw new SFSError(EINVAL, "Bad version");
    }
    const blockSize = view.getUint32(SB_BLOCK_SIZE, true);
    if (blockSize !== BLOCK_SIZE) {
      throw new SFSError(EINVAL, "Bad block size");
    }

    const configuredMaxBytes =
      view.getUint32(SB_MAX_SIZE_BLOCKS, true) * blockSize;
    return {
      byteLength: buffer.byteLength,
      maxByteLength: Math.max(buffer.byteLength, configuredMaxBytes),
    };
  }

  static mount(
    buffer: SharedArrayBuffer,
    options?: { restoreImage?: boolean },
  ): SharedFS {
    const fs = new SharedFS(buffer);
    if (fs.r32(SB_MAGIC) !== MAGIC) throw new SFSError(EINVAL, "Bad magic");
    if (fs.r32(SB_VERSION) !== VERSION)
      throw new SFSError(EINVAL, "Bad version");
    if (fs.r32(SB_BLOCK_SIZE) !== BLOCK_SIZE)
      throw new SFSError(EINVAL, "Bad block size");
    if (options?.restoreImage) fs.resetRestoredRuntimeState();
    fs.resetAllocationHints();
    return fs;
  }

  /**
   * Return a portable, quiescent copy of the filesystem bytes.
   *
   * File descriptors and inode locks are process-runtime state, not VFS image
   * state. Refuse to snapshot while descriptors are live, then clear all lock
   * words in the copy so a restored image cannot inherit a dead worker's lock.
   */
  snapshotBytes(options?: SharedFsSnapshotOptions): Uint8Array {
    return this.withNamespaceLock(() => this.snapshotBytesUnlocked(options));
  }

  snapshotState(options?: SharedFsSnapshotOptions): {
    bytes: Uint8Array;
    identities: Map<string, SharedFsIdentityState>;
  } {
    return this.withNamespaceLock(() => {
      // Validate quiescence and copy first. With the namespace lock held, no
      // new descriptor can appear while the matching path identities are
      // collected for lazy metadata.
      const bytes = this.snapshotBytesUnlocked(options);
      return { bytes, identities: this.collectIdentityStateUnlocked() };
    });
  }

  identityState(): Map<string, SharedFsIdentityState> {
    return this.withNamespaceLock(() => this.collectIdentityStateUnlocked());
  }

  private snapshotBytesUnlocked(options?: SharedFsSnapshotOptions): Uint8Array {
    const normalizeTimestampsMs = options?.normalizeTimestampsMs;
    if (
      normalizeTimestampsMs !== undefined &&
      (!Number.isSafeInteger(normalizeTimestampsMs) ||
        normalizeTimestampsMs < 0)
    ) {
      throw new SFSError(
        EINVAL,
        "Snapshot timestamp must be a non-negative safe integer in milliseconds",
      );
    }
    const normalizedTimestamp =
      normalizeTimestampsMs === undefined
        ? undefined
        : BigInt(normalizeTimestampsMs);

    for (let fd = 0; fd < MAX_FDS; fd++) {
      const base = FD_TABLE_OFFSET + fd * FD_ENTRY_SIZE;
      if (Atomics.load(this.i32, base >> 2) !== 0) {
        throw new SFSError(
          EBUSY,
          "Cannot save a VFS image with open descriptors",
        );
      }
    }

    const totalInodes = this.r32(SB_TOTAL_INODES);
    for (let ino = 0; ino < totalInodes; ino++) {
      const off = this.inodeOffset(ino);
      if (this.r32(off + INO_OPEN_COUNT) !== 0) {
        throw new SFSError(
          EBUSY,
          "Cannot save a VFS image with open inode references",
        );
      }
    }

    const copy = new Uint8Array(this.buffer.byteLength);
    copy.set(this.u8);
    const view = new DataView(copy.buffer);
    view.setUint32(SB_GLOBAL_LOCK, 0, true);
    view.setUint32(SB_NAMESPACE_LOCK, 0, true);
    copy.fill(0, FD_TABLE_OFFSET, BLOCK_SIZE);

    for (let ino = 0; ino < totalInodes; ino++) {
      const off = this.inodeOffset(ino);
      view.setUint32(off + INO_LOCK_STATE, 0, true);
      view.setUint32(off + INO_OPEN_COUNT, 0, true);
      if (normalizedTimestamp !== undefined) {
        // Freed inode slots are not filesystem state, but their old timestamps
        // remain in the table until reuse. Clear those unreachable values so a
        // deterministic create/unlink sequence cannot leak wall-clock bytes.
        const timestamp =
          ino >= ROOT_INO && this.inodeIsAllocated(ino)
            ? normalizedTimestamp
            : 0n;
        view.setBigUint64(off + INO_ATIME, timestamp, true);
        view.setBigUint64(off + INO_MTIME, timestamp, true);
        view.setBigUint64(off + INO_CTIME, timestamp, true);
      }
    }
    return copy;
  }

  private collectIdentityStateUnlocked(): Map<string, SharedFsIdentityState> {
    const identities = new Map<string, SharedFsIdentityState>();
    const rootOff = this.inodeOffset(ROOT_INO);
    const rootGeneration = this.r64(rootOff + INO_GENERATION);
    identities.set(`${ROOT_INO}:${rootGeneration}`, {
      ino: ROOT_INO,
      generation: rootGeneration,
      dataSequence:
        Atomics.load(this.i32, (rootOff + INO_DATA_SEQUENCE) >> 2) >>> 0,
      mode: this.r32(rootOff + INO_MODE),
      linkCount: this.r32(rootOff + INO_LINK_COUNT),
      size: this.r64(rootOff + INO_SIZE),
      uid: this.r32(rootOff + INO_UID),
      gid: this.r32(rootOff + INO_GID),
      paths: ["/"],
    });
    const directories: Array<{ ino: number; path: string }> = [
      { ino: ROOT_INO, path: "/" },
    ];
    const visitedDirectories = new Set<number>();

    while (directories.length > 0) {
      const directory = directories.pop()!;
      if (visitedDirectories.has(directory.ino)) throw new SFSError(EIO);
      visitedDirectories.add(directory.ino);

      const inoOff = this.inodeOffset(directory.ino);
      if ((this.r32(inoOff + INO_MODE) & S_IFMT) !== S_IFDIR) {
        throw new SFSError(EIO);
      }
      const dirSize = this.r64(inoOff + INO_SIZE);
      let pos = 0;
      while (pos < dirSize) {
        const fileBlock = Math.floor(pos / BLOCK_SIZE);
        const blockOff = pos % BLOCK_SIZE;
        const phys = this.inodeBlockMap(directory.ino, fileBlock, false);
        if (phys <= 0) throw new SFSError(EIO);
        const blockBase = phys * BLOCK_SIZE;
        const remain = Math.min(dirSize - pos, BLOCK_SIZE - blockOff);

        let off = blockOff;
        while (off < blockOff + remain) {
          const abs = blockBase + off;
          const entIno = this.r32(abs);
          const recLen = this.view.getUint16(abs + 4, true);
          const nameLen = this.view.getUint16(abs + 6, true);
          if (!this.isValidDirEntry(off, blockOff + remain, recLen, nameLen)) {
            throw new SFSError(EIO);
          }
          if (entIno !== 0) {
            if (!this.inodeIsAllocated(entIno)) throw new SFSError(EIO);
            const name = safeDecode(
              this.u8.subarray(
                abs + DIRENT_HEADER_SIZE,
                abs + DIRENT_HEADER_SIZE + nameLen,
              ),
            );
            if (name !== "." && name !== "..") {
              const childPath =
                directory.path === "/"
                  ? `/${name}`
                  : `${directory.path}/${name}`;
              const childOff = this.inodeOffset(entIno);
              const generation = this.r64(childOff + INO_GENERATION);
              const key = `${entIno}:${generation}`;
              let identity = identities.get(key);
              if (!identity) {
                const mode = this.r32(childOff + INO_MODE);
                identity = {
                  ino: entIno,
                  generation,
                  dataSequence:
                    Atomics.load(
                      this.i32,
                      (childOff + INO_DATA_SEQUENCE) >> 2,
                    ) >>> 0,
                  mode,
                  linkCount: this.r32(childOff + INO_LINK_COUNT),
                  size: this.r64(childOff + INO_SIZE),
                  uid: this.r32(childOff + INO_UID),
                  gid: this.r32(childOff + INO_GID),
                  ...((mode & S_IFMT) === S_IFLNK
                    ? { symlinkTarget: this.readSymlinkInodeUnlocked(entIno) }
                    : {}),
                  paths: [],
                };
                identities.set(key, identity);
              }
              identity.paths.push(childPath);
              if ((this.r32(childOff + INO_MODE) & S_IFMT) === S_IFDIR) {
                directories.push({ ino: entIno, path: childPath });
              }
            }
          }
          off += recLen;
        }
        pos += remain;
      }
    }
    return identities;
  }

  statfs(): SharedFsStats {
    const blockSize = this.r32(SB_BLOCK_SIZE);
    const currentBlocks = this.r32(SB_TOTAL_BLOCKS);
    const configuredMaxBlocks = this.r32(SB_MAX_SIZE_BLOCKS);
    const runtimeMaxByteLength =
      typeof this.buffer.maxByteLength === "number"
        ? this.buffer.maxByteLength
        : this.buffer.byteLength;
    const runtimeMaxBlocks = Math.floor(runtimeMaxByteLength / blockSize);
    const effectiveMaxBlocks = Math.max(
      currentBlocks,
      Math.min(configuredMaxBlocks, runtimeMaxBlocks),
    );
    const currentFreeBlocks = Atomics.load(this.i32, SB_FREE_BLOCKS >> 2);
    const ungrownBlocks = Math.max(0, effectiveMaxBlocks - currentBlocks);

    return {
      blockSize,
      totalBlocks: effectiveMaxBlocks,
      freeBlocks: currentFreeBlocks + ungrownBlocks,
      totalInodes: this.r32(SB_TOTAL_INODES),
      freeInodes: Atomics.load(this.i32, SB_FREE_INODES >> 2),
      maxName: MAX_NAME,
    };
  }

  // ── Low-level read/write helpers ─────────────────────────────────

  private r32(off: number): number {
    return this.view.getUint32(off, true);
  }
  private w32(off: number, v: number): void {
    this.view.setUint32(off, v, true);
  }
  private r64(off: number): number {
    return Number(this.view.getBigUint64(off, true));
  }
  private w64(off: number, v: number): void {
    this.view.setBigUint64(off, BigInt(v), true);
  }

  /**
   * Wait for a shared lock word to change.
   *
   * Browser main threads forbid Atomics.wait(). The legacy shared-filesystem
   * BrowserKernel path still exposes synchronous MemoryFileSystem methods on
   * that thread, so fall back to atomic polling while the independently
   * scheduled kernel worker finishes its short critical section. Preferred
   * kernel-owned browser boots never exercise this fallback.
   */
  private waitForAtomicChange(index: number, expected: number): void {
    if (this.atomicsWaitAllowed !== false) {
      try {
        Atomics.wait(this.i32, index, expected);
        this.atomicsWaitAllowed = true;
        return;
      } catch (error) {
        if (!(error instanceof TypeError)) throw error;
        this.atomicsWaitAllowed = false;
      }
    }
    while (Atomics.load(this.i32, index) === expected) {
      // Synchronous SharedFS cannot yield a Promise here. The lock owner is a
      // different worker, so atomic polling does not prevent its progress.
    }
  }

  private resetAllocationHints(): void {
    this.blockAllocHint = this.findNextFreeBlockHint();
    this.inodeAllocHint = this.findNextFreeInodeHint();
  }

  private findNextFreeBlockHint(): number {
    const totalBlocks = this.r32(SB_TOTAL_BLOCKS);
    const dataStart = this.r32(SB_DATA_START);
    const bbStart = this.r32(SB_BLOCK_BITMAP_START) * BLOCK_SIZE;
    for (let blockNo = dataStart; blockNo < totalBlocks; blockNo++) {
      const idx = (bbStart >> 2) + (blockNo >> 5);
      const bit = blockNo & 31;
      if ((Atomics.load(this.i32, idx) & (1 << bit)) === 0) return blockNo;
    }
    return dataStart;
  }

  private findNextFreeInodeHint(): number {
    const totalInodes = this.r32(SB_TOTAL_INODES);
    const ibStart = this.r32(SB_INODE_BITMAP_START) * BLOCK_SIZE;
    for (let ino = 2; ino < totalInodes; ino++) {
      const idx = (ibStart >> 2) + (ino >> 5);
      const bit = ino & 31;
      if ((Atomics.load(this.i32, idx) & (1 << bit)) === 0) return ino;
    }
    return 2;
  }

  // ── Superblock lock (for grow) ───────────────────────────────────

  private sbLock(): void {
    const idx = SB_GLOBAL_LOCK >> 2;
    for (;;) {
      const old = Atomics.compareExchange(this.i32, idx, 0, 1);
      if (old === 0) return;
      this.waitForAtomicChange(idx, 1);
    }
  }

  private sbUnlock(): void {
    const idx = SB_GLOBAL_LOCK >> 2;
    Atomics.store(this.i32, idx, 0);
    Atomics.notify(this.i32, idx, Infinity);
  }

  // ── Namespace lock (path resolution and mutation) ───────────────

  private namespaceLock(): void {
    const idx = SB_NAMESPACE_LOCK >> 2;
    for (;;) {
      const old = Atomics.compareExchange(this.i32, idx, 0, 1);
      if (old === 0) return;
      this.waitForAtomicChange(idx, 1);
    }
  }

  private namespaceUnlock(): void {
    const idx = SB_NAMESPACE_LOCK >> 2;
    Atomics.store(this.i32, idx, 0);
    Atomics.notify(this.i32, idx, Infinity);
  }

  private withNamespaceLock<T>(operation: () => T): T {
    this.namespaceLock();
    try {
      return operation();
    } finally {
      this.namespaceUnlock();
    }
  }

  /** Reset process-local runtime state after copying a portable image. */
  private resetRestoredRuntimeState(): void {
    // The buffer is private to fromImage(), so stale locks can be cleared
    // directly before any lock-taking operation is attempted.
    Atomics.store(this.i32, SB_GLOBAL_LOCK >> 2, 0);
    Atomics.store(this.i32, SB_NAMESPACE_LOCK >> 2, 0);
    this.u8.fill(0, FD_TABLE_OFFSET, BLOCK_SIZE);

    const totalInodes = this.r32(SB_TOTAL_INODES);
    const ibStart = this.r32(SB_INODE_BITMAP_START) * BLOCK_SIZE;
    for (let ino = 0; ino < totalInodes; ino++) {
      const off = this.inodeOffset(ino);
      this.w32(off + INO_LOCK_STATE, 0);
      this.w32(off + INO_OPEN_COUNT, 0);
      if (ino < 2) continue;
      const word = this.r32(ibStart + (ino >> 5) * 4);
      if ((word & (1 << (ino & 31))) === 0) continue;
      if (this.r32(off + INO_LINK_COUNT) !== 0) continue;

      const mode = this.r32(off + INO_MODE);
      const size = this.r64(off + INO_SIZE);
      if ((mode & S_IFMT) === S_IFLNK && size <= INLINE_SYMLINK_SIZE) {
        this.u8.fill(
          0,
          off + INO_DIRECT,
          off + INO_DIRECT + INLINE_SYMLINK_SIZE,
        );
        this.w64(off + INO_SIZE, 0);
      } else {
        this.inodeTruncate(ino, 0);
      }
      this.inodeFree(ino);
    }
  }

  // ── Block allocator ──────────────────────────────────────────────

  private blockAlloc(): number {
    const totalBlocks = this.r32(SB_TOTAL_BLOCKS);
    const bbStart = this.r32(SB_BLOCK_BITMAP_START) * BLOCK_SIZE;
    const dataStart = this.r32(SB_DATA_START);
    const start =
      this.blockAllocHint >= dataStart && this.blockAllocHint < totalBlocks
        ? this.blockAllocHint
        : dataStart;
    const allocatableBlocks = totalBlocks - dataStart;

    for (let checked = 0; checked < allocatableBlocks; checked++) {
      const blockNo =
        dataStart + ((start - dataStart + checked) % allocatableBlocks);
      const idx = (bbStart >> 2) + (blockNo >> 5);
      const bit = blockNo & 31;
      const word = Atomics.load(this.i32, idx);
      if (word & (1 << bit)) continue;

      const desired = word | (1 << bit);
      const old = Atomics.compareExchange(this.i32, idx, word, desired);
      if (old === word) {
        Atomics.sub(this.i32, SB_FREE_BLOCKS >> 2, 1);
        this.blockAllocHint =
          blockNo + 1 < totalBlocks ? blockNo + 1 : dataStart;
        // Zero the newly allocated block
        const off = blockNo * BLOCK_SIZE;
        this.u8.fill(0, off, off + BLOCK_SIZE);
        return blockNo;
      }
      // CAS failed — retry this candidate.
      checked--;
    }
    return ENOSPC;
  }

  private blockAllocWithGrow(): number {
    let blk = this.blockAlloc();
    if (blk !== ENOSPC) return blk;
    const grew = this.grow();
    if (grew < 0) return ENOSPC;
    blk = this.blockAlloc();
    return blk;
  }

  private blockFree(blockNo: number): void {
    const bbStart = this.r32(SB_BLOCK_BITMAP_START) * BLOCK_SIZE;
    const idx = (bbStart >> 2) + (blockNo >> 5);
    const bit = blockNo & 31;

    for (;;) {
      const word = Atomics.load(this.i32, idx);
      const desired = word & ~(1 << bit);
      const old = Atomics.compareExchange(this.i32, idx, word, desired);
      if (old === word) break;
    }
    Atomics.add(this.i32, SB_FREE_BLOCKS >> 2, 1);
    if (blockNo >= this.r32(SB_DATA_START) && blockNo < this.blockAllocHint) {
      this.blockAllocHint = blockNo;
    }
  }

  // ── Growth ───────────────────────────────────────────────────────

  private grow(): number {
    this.sbLock();
    try {
      if (Atomics.load(this.i32, SB_FREE_BLOCKS >> 2) > 0) return 0;

      const current = this.r32(SB_TOTAL_BLOCKS);
      const maxBlocks = this.r32(SB_MAX_SIZE_BLOCKS);
      let growBy = this.r32(SB_GROW_CHUNK_BLOCKS);
      let newTotal = current + growBy;

      if (newTotal > maxBlocks) {
        newTotal = maxBlocks;
        growBy = newTotal - current;
        if (growBy === 0) return ENOSPC;
      }

      const neededBytes = newTotal * BLOCK_SIZE;
      if (this.buffer.byteLength < neededBytes) {
        // Try to grow the SharedArrayBuffer
        try {
          (this.buffer as any).grow(neededBytes);
          this.view = new DataView(this.buffer);
          this.i32 = new Int32Array(this.buffer);
          this.u8 = new Uint8Array(this.buffer);
        } catch {
          return ENOSPC;
        }
      }

      this.w32(SB_TOTAL_BLOCKS, newTotal);
      Atomics.add(this.i32, SB_FREE_BLOCKS >> 2, growBy);
      Atomics.add(this.i32, SB_GENERATION >> 2, 1);
      this.blockAllocHint = current;
      return 0;
    } finally {
      this.sbUnlock();
    }
  }

  // ── Inode helpers ────────────────────────────────────────────────

  private inodeOffset(ino: number): number {
    const tableStart = this.r32(SB_INODE_TABLE_START);
    const block = tableStart + Math.floor(ino / INODES_PER_BLOCK);
    const off = (ino % INODES_PER_BLOCK) * INODE_SIZE;
    return block * BLOCK_SIZE + off;
  }

  private inodeAlloc(): number {
    const totalInodes = this.r32(SB_TOTAL_INODES);
    const ibStart = this.r32(SB_INODE_BITMAP_START) * BLOCK_SIZE;
    const start =
      this.inodeAllocHint >= 2 && this.inodeAllocHint < totalInodes
        ? this.inodeAllocHint
        : 2;
    const allocatableInodes = totalInodes - 2;

    for (let checked = 0; checked < allocatableInodes; checked++) {
      const ino = 2 + ((start - 2 + checked) % allocatableInodes);
      const idx = (ibStart >> 2) + (ino >> 5);
      const bit = ino & 31;
      const word = Atomics.load(this.i32, idx);
      if (word & (1 << bit)) continue;

      const desired = word | (1 << bit);
      const old = Atomics.compareExchange(this.i32, idx, word, desired);
      if (old === word) {
        Atomics.sub(this.i32, SB_FREE_INODES >> 2, 1);
        this.inodeAllocHint = ino + 1 < totalInodes ? ino + 1 : 2;
        // Zero the inode
        const off = this.inodeOffset(ino);
        this.u8.fill(0, off, off + INODE_SIZE);
        this.w64(off + INO_GENERATION, this.nextInodeGeneration());
        return ino;
      }
      // CAS failed — retry this candidate.
      checked--;
    }
    return ENOSPC;
  }

  private nextInodeGeneration(): number {
    return Atomics.add(this.i32, SB_GENERATION >> 2, 1) + 1;
  }

  private inodeFree(ino: number): void {
    const ibStart = this.r32(SB_INODE_BITMAP_START) * BLOCK_SIZE;
    const idx = (ibStart >> 2) + (ino >> 5);
    const bit = ino & 31;

    for (;;) {
      const word = Atomics.load(this.i32, idx);
      if ((word & (1 << bit)) === 0) throw new SFSError(EIO);
      const desired = word & ~(1 << bit);
      const old = Atomics.compareExchange(this.i32, idx, word, desired);
      if (old === word) break;
    }
    Atomics.add(this.i32, SB_FREE_INODES >> 2, 1);
    if (ino >= 2 && ino < this.inodeAllocHint) this.inodeAllocHint = ino;
  }

  private inodeAddOpenRef(ino: number): boolean {
    this.inodeWriteLock(ino);
    try {
      const off = this.inodeOffset(ino);
      if (this.r32(off + INO_LINK_COUNT) === 0) return false;
      this.w32(off + INO_OPEN_COUNT, this.r32(off + INO_OPEN_COUNT) + 1);
      return true;
    } finally {
      this.inodeWriteUnlock(ino);
    }
  }

  private inodeDropOpenRef(ino: number): void {
    let shouldFree = false;
    this.inodeWriteLock(ino);
    try {
      const off = this.inodeOffset(ino);
      const openCount = this.r32(off + INO_OPEN_COUNT);
      if (openCount > 0) {
        this.w32(off + INO_OPEN_COUNT, openCount - 1);
      }
      if (openCount <= 1 && this.r32(off + INO_LINK_COUNT) === 0) {
        this.inodeTruncate(ino, 0);
        shouldFree = true;
      }
    } finally {
      this.inodeWriteUnlock(ino);
    }
    if (shouldFree) this.inodeFree(ino);
  }

  private inodeDropLinkRefLocked(ino: number): boolean {
    const off = this.inodeOffset(ino);
    const linkCount = this.r32(off + INO_LINK_COUNT);
    if (linkCount > 1) {
      this.w32(off + INO_LINK_COUNT, linkCount - 1);
      this.w64(off + INO_CTIME, this.clock());
      return false;
    }
    return this.inodeOrphanLocked(ino);
  }

  private inodeOrphanLocked(ino: number): boolean {
    const off = this.inodeOffset(ino);
    this.w32(off + INO_LINK_COUNT, 0);
    this.w64(off + INO_CTIME, this.clock());
    if (this.r32(off + INO_OPEN_COUNT) > 0) return false;
    const mode = this.r32(off + INO_MODE);
    const size = this.r64(off + INO_SIZE);
    if ((mode & S_IFMT) === S_IFLNK && size <= INLINE_SYMLINK_SIZE) {
      // Short symlink targets are stored inline in the inode's direct-pointer
      // area. POSIX unlink removes the symlink inode itself even if the target
      // is dangling; do not interpret inline target bytes as block numbers.
      this.u8.fill(0, off + INO_DIRECT, off + INO_DIRECT + INLINE_SYMLINK_SIZE);
      this.w64(off + INO_SIZE, 0);
    } else {
      this.inodeTruncate(ino, 0);
    }
    return true;
  }

  // ── Inode locking ────────────────────────────────────────────────

  private inodeReadLock(ino: number): void {
    const lockIdx = (this.inodeOffset(ino) + INO_LOCK_STATE) >> 2;
    for (;;) {
      const cur = Atomics.load(this.i32, lockIdx);
      if (cur & WRITER_BIT) {
        this.waitForAtomicChange(lockIdx, cur);
        continue;
      }
      const old = Atomics.compareExchange(this.i32, lockIdx, cur, cur + 1);
      if (old === cur) return;
    }
  }

  private inodeReadUnlock(ino: number): void {
    const lockIdx = (this.inodeOffset(ino) + INO_LOCK_STATE) >> 2;
    const prev = Atomics.sub(this.i32, lockIdx, 1);
    if ((prev & READER_MASK) === 1) {
      Atomics.notify(this.i32, lockIdx, 1);
    }
  }

  private inodeWriteLock(ino: number): void {
    const lockIdx = (this.inodeOffset(ino) + INO_LOCK_STATE) >> 2;
    for (;;) {
      const cur = Atomics.load(this.i32, lockIdx);
      if (cur !== 0) {
        this.waitForAtomicChange(lockIdx, cur);
        continue;
      }
      const old = Atomics.compareExchange(this.i32, lockIdx, 0, WRITER_BIT);
      if (old === 0) return;
    }
  }

  private inodeWriteUnlock(ino: number): void {
    const lockIdx = (this.inodeOffset(ino) + INO_LOCK_STATE) >> 2;
    Atomics.store(this.i32, lockIdx, 0);
    Atomics.notify(this.i32, lockIdx, Infinity);
  }

  // ── Inode block mapping ──────────────────────────────────────────

  private inodeBlockMap(
    ino: number,
    fileBlock: number,
    allocate: boolean,
  ): number {
    const inoOff = this.inodeOffset(ino);

    // Direct blocks: 0..9
    if (fileBlock < DIRECT_BLOCKS) {
      const ptr = this.r32(inoOff + INO_DIRECT + fileBlock * 4);
      if (ptr !== 0) return ptr;
      if (!allocate) return 0;
      const blk = this.blockAllocWithGrow();
      if (blk < 0) return blk;
      this.w32(inoOff + INO_DIRECT + fileBlock * 4, blk);
      return blk;
    }

    // Single indirect: 10..1033
    fileBlock -= DIRECT_BLOCKS;
    if (fileBlock < PTRS_PER_BLOCK) {
      let ind = this.r32(inoOff + INO_INDIRECT);
      let allocatedIndirect = false;
      if (ind === 0) {
        if (!allocate) return 0;
        ind = this.blockAllocWithGrow();
        if (ind < 0) return ind;
        this.w32(inoOff + INO_INDIRECT, ind);
        allocatedIndirect = true;
      }
      const ptrOff = ind * BLOCK_SIZE + fileBlock * 4;
      const ptr = this.r32(ptrOff);
      if (ptr !== 0) return ptr;
      if (!allocate) return 0;
      const blk = this.blockAllocWithGrow();
      if (blk < 0) {
        if (allocatedIndirect) {
          this.w32(inoOff + INO_INDIRECT, 0);
          this.blockFree(ind);
        }
        return blk;
      }
      this.w32(ptrOff, blk);
      return blk;
    }

    // Double indirect: 1034..1024*1024+1033
    fileBlock -= PTRS_PER_BLOCK;
    if (fileBlock < PTRS_PER_BLOCK * PTRS_PER_BLOCK) {
      const idx1 = Math.floor(fileBlock / PTRS_PER_BLOCK);
      const idx2 = fileBlock % PTRS_PER_BLOCK;

      let dind = this.r32(inoOff + INO_DOUBLE_INDIRECT);
      let allocatedDoubleIndirect = false;
      if (dind === 0) {
        if (!allocate) return 0;
        dind = this.blockAllocWithGrow();
        if (dind < 0) return dind;
        this.w32(inoOff + INO_DOUBLE_INDIRECT, dind);
        allocatedDoubleIndirect = true;
      }

      const l1Off = dind * BLOCK_SIZE + idx1 * 4;
      let l1 = this.r32(l1Off);
      let allocatedFirstLevel = false;
      if (l1 === 0) {
        if (!allocate) return 0;
        l1 = this.blockAllocWithGrow();
        if (l1 < 0) {
          if (allocatedDoubleIndirect) {
            this.w32(inoOff + INO_DOUBLE_INDIRECT, 0);
            this.blockFree(dind);
          }
          return l1;
        }
        this.w32(l1Off, l1);
        allocatedFirstLevel = true;
      }

      const l2Off = l1 * BLOCK_SIZE + idx2 * 4;
      const ptr = this.r32(l2Off);
      if (ptr !== 0) return ptr;
      if (!allocate) return 0;
      const blk = this.blockAllocWithGrow();
      if (blk < 0) {
        if (allocatedFirstLevel) {
          this.w32(l1Off, 0);
          this.blockFree(l1);
        }
        if (allocatedDoubleIndirect) {
          this.w32(inoOff + INO_DOUBLE_INDIRECT, 0);
          this.blockFree(dind);
        }
        return blk;
      }
      this.w32(l2Off, blk);
      return blk;
    }

    return EINVAL;
  }

  // ── Inode data I/O ───────────────────────────────────────────────

  private inodeReadData(
    ino: number,
    offset: number,
    dst: Uint8Array,
    count: number,
  ): number {
    const inoOff = this.inodeOffset(ino);
    const size = this.r64(inoOff + INO_SIZE);
    if (offset >= size) return 0;
    if (offset + count > size) count = size - offset;

    let totalRead = 0;
    let dstPos = 0;

    while (count > 0) {
      const fileBlock = Math.floor(offset / BLOCK_SIZE);
      const blockOff = offset % BLOCK_SIZE;
      let chunk = BLOCK_SIZE - blockOff;
      if (chunk > count) chunk = count;

      const phys = this.inodeBlockMap(ino, fileBlock, false);
      if (phys <= 0) {
        dst.fill(0, dstPos, dstPos + chunk);
      } else {
        const src = phys * BLOCK_SIZE + blockOff;
        dst.set(this.u8.subarray(src, src + chunk), dstPos);
      }

      dstPos += chunk;
      offset += chunk;
      count -= chunk;
      totalRead += chunk;
    }
    return totalRead;
  }

  private inodeWriteData(
    ino: number,
    offset: number,
    src: Uint8Array,
    count: number,
  ): number {
    const inoOff = this.inodeOffset(ino);
    const size = this.r64(inoOff + INO_SIZE);
    if (offset > size) {
      this.zeroOldEofTail(ino, size);
    }

    let totalWritten = 0;
    let srcPos = 0;

    while (count > 0) {
      const fileBlock = Math.floor(offset / BLOCK_SIZE);
      const blockOff = offset % BLOCK_SIZE;
      let chunk = BLOCK_SIZE - blockOff;
      if (chunk > count) chunk = count;

      const phys = this.inodeBlockMap(ino, fileBlock, true);
      if (phys < 0) {
        if (totalWritten === 0) return phys;
        break;
      }

      const dstOff = phys * BLOCK_SIZE + blockOff;
      this.u8.set(src.subarray(srcPos, srcPos + chunk), dstOff);

      srcPos += chunk;
      offset += chunk;
      count -= chunk;
      totalWritten += chunk;
    }

    if (totalWritten > 0 && offset > this.r64(inoOff + INO_SIZE)) {
      this.w64(inoOff + INO_SIZE, offset);
    }
    if (totalWritten > 0) {
      const now = this.clock();
      this.w64(inoOff + INO_MTIME, now);
      this.w64(inoOff + INO_CTIME, now);
      Atomics.add(this.i32, (inoOff + INO_DATA_SEQUENCE) >> 2, 1);
    }
    return totalWritten;
  }

  private invalidateSetIdAfterRegularFileMutation(
    ino: number,
    kind: "content" | "ownership",
  ): void {
    const inoOff = this.inodeOffset(ino);
    const mode = this.r32(inoOff + INO_MODE);
    const nextMode = modeAfterRegularFileMutation(mode, kind);
    if (nextMode !== mode) this.w32(inoOff + INO_MODE, nextMode);
  }

  private zeroInodeRange(ino: number, start: number, end: number): void {
    while (start < end) {
      const fileBlock = Math.floor(start / BLOCK_SIZE);
      const blockOff = start % BLOCK_SIZE;
      const chunk = Math.min(BLOCK_SIZE - blockOff, end - start);
      const phys = this.inodeBlockMap(ino, fileBlock, false);
      if (phys > 0) {
        const abs = phys * BLOCK_SIZE + blockOff;
        this.u8.fill(0, abs, abs + chunk);
      }
      start += chunk;
    }
  }

  /**
   * Zero only the allocated tail of the old EOF block. Sparse extension does
   * not need to walk logical holes: absent blocks already read as zero and a
   * newly allocated block is cleared by blockAlloc().
   */
  private zeroOldEofTail(ino: number, oldSize: number): void {
    const blockOff = oldSize % BLOCK_SIZE;
    if (blockOff === 0) return;
    const fileBlock = Math.floor(oldSize / BLOCK_SIZE);
    const phys = this.inodeBlockMap(ino, fileBlock, false);
    if (phys <= 0) return;
    const start = phys * BLOCK_SIZE + blockOff;
    this.u8.fill(0, start, phys * BLOCK_SIZE + BLOCK_SIZE);
  }

  private freeBlocksFrom(ino: number, fromBlock: number): void {
    const inoOff = this.inodeOffset(ino);

    // Direct blocks
    for (let i = fromBlock; i < DIRECT_BLOCKS; i++) {
      const ptr = this.r32(inoOff + INO_DIRECT + i * 4);
      if (ptr) {
        this.blockFree(ptr);
        this.w32(inoOff + INO_DIRECT + i * 4, 0);
      }
    }

    // Single indirect
    const ind = this.r32(inoOff + INO_INDIRECT);
    if (ind) {
      const start = fromBlock > DIRECT_BLOCKS ? fromBlock - DIRECT_BLOCKS : 0;
      for (let i = start; i < PTRS_PER_BLOCK; i++) {
        const ptrOff = ind * BLOCK_SIZE + i * 4;
        const ptr = this.r32(ptrOff);
        if (ptr) {
          this.blockFree(ptr);
          this.w32(ptrOff, 0);
        }
      }
      if (start === 0) {
        this.blockFree(ind);
        this.w32(inoOff + INO_INDIRECT, 0);
      }
    }

    // Double indirect
    const dind = this.r32(inoOff + INO_DOUBLE_INDIRECT);
    if (dind) {
      const absStart =
        fromBlock > DIRECT_BLOCKS + PTRS_PER_BLOCK
          ? fromBlock - DIRECT_BLOCKS - PTRS_PER_BLOCK
          : 0;
      const i1Start = Math.floor(absStart / PTRS_PER_BLOCK);

      for (let i1 = i1Start; i1 < PTRS_PER_BLOCK; i1++) {
        const l1Off = dind * BLOCK_SIZE + i1 * 4;
        const l1 = this.r32(l1Off);
        if (!l1) continue;

        const i2Start = i1 === i1Start ? absStart % PTRS_PER_BLOCK : 0;
        for (let i2 = i2Start; i2 < PTRS_PER_BLOCK; i2++) {
          const l2Off = l1 * BLOCK_SIZE + i2 * 4;
          const ptr = this.r32(l2Off);
          if (ptr) {
            this.blockFree(ptr);
            this.w32(l2Off, 0);
          }
        }
        if (i2Start === 0) {
          this.blockFree(l1);
          this.w32(l1Off, 0);
        }
      }
      if (i1Start === 0) {
        this.blockFree(dind);
        this.w32(inoOff + INO_DOUBLE_INDIRECT, 0);
      }
    }
  }

  private inodeTruncate(
    ino: number,
    newSize: number,
    forceDataMutation = false,
  ): void {
    const inoOff = this.inodeOffset(ino);
    const curSize = this.r64(inoOff + INO_SIZE);
    const sizeChanged = newSize !== curSize;
    if (newSize >= curSize) {
      if (newSize > curSize) {
        this.zeroOldEofTail(ino, curSize);
      }
      this.w64(inoOff + INO_SIZE, newSize);
      if (sizeChanged || forceDataMutation) {
        const now = this.clock();
        this.w64(inoOff + INO_MTIME, now);
        this.w64(inoOff + INO_CTIME, now);
        Atomics.add(this.i32, (inoOff + INO_DATA_SEQUENCE) >> 2, 1);
      }
      return;
    }
    if (newSize % BLOCK_SIZE !== 0) {
      this.zeroInodeRange(
        ino,
        newSize,
        Math.ceil(newSize / BLOCK_SIZE) * BLOCK_SIZE,
      );
    }
    const keepBlocks = Math.ceil(newSize / BLOCK_SIZE);
    this.freeBlocksFrom(ino, keepBlocks);
    this.w64(inoOff + INO_SIZE, newSize);
    if (sizeChanged || forceDataMutation) {
      const now = this.clock();
      this.w64(inoOff + INO_MTIME, now);
      this.w64(inoOff + INO_CTIME, now);
      Atomics.add(this.i32, (inoOff + INO_DATA_SEQUENCE) >> 2, 1);
    }
  }

  private validateFileSize(size: number): void {
    if (!Number.isSafeInteger(size) || size < 0) throw new SFSError(EINVAL);
    if (size > MAX_FILE_SIZE) throw new SFSError(EFBIG);
  }

  private validateSeekPosition(position: number): void {
    if (!Number.isSafeInteger(position)) throw new SFSError(EOVERFLOW);
    if (position < 0) throw new SFSError(EINVAL);
    if (position > MAX_FILE_SIZE) throw new SFSError(EFBIG);
  }

  // ── Directory operations ─────────────────────────────────────────

  private touchDirectoryMutation(dirIno: number): void {
    const inoOff = this.inodeOffset(dirIno);
    const now = this.clock();
    this.w64(inoOff + INO_MTIME, now);
    this.w64(inoOff + INO_CTIME, now);
    const mutationSequence =
      (Atomics.add(this.i32, (inoOff + INO_DIR_SEQUENCE) >> 2, 1) + 1) >>> 0;
    const index = this.dirIndexes.get(dirIno);
    if (index) {
      index.mutationSequence = mutationSequence;
      index.size = this.r64(inoOff + INO_SIZE);
    }
  }

  private dirNameKey(name: Uint8Array): string {
    return safeDecode(name);
  }

  private dirEntryNameMatches(abs: number, name: Uint8Array): boolean {
    const entNameLen = this.view.getUint16(abs + 6, true);
    if (entNameLen !== name.length) return false;
    for (let i = 0; i < name.length; i++) {
      if (this.u8[abs + DIRENT_HEADER_SIZE + i] !== name[i]) return false;
    }
    return true;
  }

  private isValidDirEntry(
    off: number,
    endOff: number,
    recLen: number,
    nameLen: number,
  ): boolean {
    return (
      recLen >= DIRENT_HEADER_SIZE &&
      recLen % 4 === 0 &&
      off + recLen <= endOff &&
      nameLen <= recLen - DIRENT_HEADER_SIZE
    );
  }

  private inodeIsAllocated(ino: number): boolean {
    const totalInodes = this.r32(SB_TOTAL_INODES);
    if (ino <= 0 || ino >= totalInodes) return false;
    const ibStart = this.r32(SB_INODE_BITMAP_START) * BLOCK_SIZE;
    const word = Atomics.load(this.i32, (ibStart >> 2) + (ino >> 5));
    return (word & (1 << (ino & 31))) !== 0;
  }

  private rebuildDirIndex(
    dirIno: number,
    generation: number,
    mutationSequence: number,
    dirSize: number,
  ): DirIndex | number {
    const entries = new Map<string, DirIndexEntry>();
    const free: Array<{ abs: number; recLen: number }> = [];
    let pos = 0;

    while (pos < dirSize) {
      const fileBlock = Math.floor(pos / BLOCK_SIZE);
      const blockOff = pos % BLOCK_SIZE;
      const phys = this.inodeBlockMap(dirIno, fileBlock, false);
      if (phys <= 0) return EIO;

      const blockBase = phys * BLOCK_SIZE;
      let remain = dirSize - pos;
      if (remain > BLOCK_SIZE - blockOff) remain = BLOCK_SIZE - blockOff;

      let off = blockOff;
      while (off < blockOff + remain) {
        const abs = blockBase + off;
        const entIno = this.r32(abs);
        const recLen = this.view.getUint16(abs + 4, true);
        const entNameLen = this.view.getUint16(abs + 6, true);

        if (!this.isValidDirEntry(off, blockOff + remain, recLen, entNameLen))
          return EIO;

        if (entIno !== 0) {
          if (!this.inodeIsAllocated(entIno)) return EIO;
          const name = safeDecode(
            this.u8.subarray(
              abs + DIRENT_HEADER_SIZE,
              abs + DIRENT_HEADER_SIZE + entNameLen,
            ),
          );
          entries.set(name, {
            ino: entIno,
            abs,
            recLen,
            nameLen: entNameLen,
          });
        } else if (recLen >= DIRENT_HEADER_SIZE) {
          free.push({ abs, recLen });
        }

        off += recLen;
      }
      pos += remain;
    }

    const index = {
      generation,
      mutationSequence,
      size: dirSize,
      entries,
      free,
    };
    this.dirIndexes.set(dirIno, index);
    return index;
  }

  private getDirIndex(dirIno: number): DirIndex | null | number {
    const inoOff = this.inodeOffset(dirIno);
    const dirSize = this.r64(inoOff + INO_SIZE);
    const generation = this.r64(inoOff + INO_GENERATION);
    const mutationSequence =
      Atomics.load(this.i32, (inoOff + INO_DIR_SEQUENCE) >> 2) >>> 0;
    const cached = this.dirIndexes.get(dirIno);
    if (
      cached &&
      cached.generation === generation &&
      cached.mutationSequence === mutationSequence &&
      cached.size === dirSize
    ) {
      return cached;
    }
    if (cached) this.dirIndexes.delete(dirIno);

    if (dirSize < DIR_INDEX_MIN_SIZE) return null;
    return this.rebuildDirIndex(dirIno, generation, mutationSequence, dirSize);
  }

  private updateDirIndexAdd(
    dirIno: number,
    name: Uint8Array,
    childIno: number,
    abs: number,
    recLen: number,
  ): void {
    const inoOff = this.inodeOffset(dirIno);
    const dirSize = this.r64(inoOff + INO_SIZE);
    const generation = this.r64(inoOff + INO_GENERATION);
    const index = this.dirIndexes.get(dirIno);
    if (!index) return;
    if (index.generation !== generation) {
      this.dirIndexes.delete(dirIno);
      return;
    }
    index.size = dirSize;
    index.entries.set(this.dirNameKey(name), {
      ino: childIno,
      abs,
      recLen,
      nameLen: name.length,
    });
  }

  private useDirIndexFreeSlot(
    index: DirIndex,
    dirIno: number,
    name: Uint8Array,
    childIno: number,
  ): boolean {
    const needed = align4(DIRENT_HEADER_SIZE + name.length);

    for (let i = index.free.length - 1; i >= 0; i--) {
      const slot = index.free[i];
      if (slot.recLen < needed) continue;
      index.free.splice(i, 1);
      if (
        this.r32(slot.abs) !== 0 ||
        this.view.getUint16(slot.abs + 4, true) !== slot.recLen
      ) {
        continue;
      }

      this.w32(slot.abs, childIno);
      this.view.setUint16(slot.abs + 6, name.length, true);
      this.u8.set(name, slot.abs + DIRENT_HEADER_SIZE);
      this.touchDirectoryMutation(dirIno);
      this.updateDirIndexAdd(dirIno, name, childIno, slot.abs, slot.recLen);
      return true;
    }

    return false;
  }

  private updateDirIndexRemove(dirIno: number, name: Uint8Array): void {
    const inoOff = this.inodeOffset(dirIno);
    const dirSize = this.r64(inoOff + INO_SIZE);
    const generation = this.r64(inoOff + INO_GENERATION);
    const index = this.dirIndexes.get(dirIno);
    if (!index) return;
    if (index.generation !== generation || index.size !== dirSize) {
      this.dirIndexes.delete(dirIno);
      return;
    }
    index.entries.delete(this.dirNameKey(name));
  }

  private updateDirIndexRecLen(
    dirIno: number,
    abs: number,
    recLen: number,
  ): void {
    const index = this.dirIndexes.get(dirIno);
    if (!index) return;
    for (const entry of index.entries.values()) {
      if (entry.abs === abs) {
        entry.recLen = recLen;
        return;
      }
    }
  }

  private dirLookup(dirIno: number, name: Uint8Array): number {
    const index = this.getDirIndex(dirIno);
    if (typeof index === "number") return index;
    if (index) {
      const entry = index.entries.get(this.dirNameKey(name));
      if (!entry) return ENOENT;

      // Validate positive hits against the backing directory entry so stale
      // in-process indexes cannot resurrect an externally removed name.
      if (
        this.r32(entry.abs) === entry.ino &&
        this.inodeIsAllocated(entry.ino) &&
        this.view.getUint16(entry.abs + 4, true) === entry.recLen &&
        this.view.getUint16(entry.abs + 6, true) === entry.nameLen &&
        this.dirEntryNameMatches(entry.abs, name)
      ) {
        return entry.ino;
      }

      index.entries.delete(this.dirNameKey(name));
      return ENOENT;
    }

    const inoOff = this.inodeOffset(dirIno);
    const dirSize = this.r64(inoOff + INO_SIZE);
    let pos = 0;

    while (pos < dirSize) {
      const fileBlock = Math.floor(pos / BLOCK_SIZE);
      const blockOff = pos % BLOCK_SIZE;
      const phys = this.inodeBlockMap(dirIno, fileBlock, false);
      if (phys <= 0) return EIO;

      const blockBase = phys * BLOCK_SIZE;
      let remain = dirSize - pos;
      if (remain > BLOCK_SIZE - blockOff) remain = BLOCK_SIZE - blockOff;

      let off = blockOff;
      while (off < blockOff + remain) {
        const abs = blockBase + off;
        const entIno = this.r32(abs);
        const recLen = this.view.getUint16(abs + 4, true);
        const entNameLen = this.view.getUint16(abs + 6, true);

        if (!this.isValidDirEntry(off, blockOff + remain, recLen, entNameLen))
          return EIO;

        if (entIno !== 0 && entNameLen === name.length) {
          let match = true;
          for (let i = 0; i < name.length; i++) {
            if (this.u8[abs + DIRENT_HEADER_SIZE + i] !== name[i]) {
              match = false;
              break;
            }
          }
          if (match) {
            if (!this.inodeIsAllocated(entIno)) return EIO;
            return entIno;
          }
        }
        off += recLen;
      }
      pos += remain;
    }
    return ENOENT;
  }

  private findLastDirEntryInBlock(
    dirIno: number,
    fileBlock: number,
    endOff: number,
  ): number {
    const phys = this.inodeBlockMap(dirIno, fileBlock, false);
    if (phys <= 0) return -1;
    const blockBase = phys * BLOCK_SIZE;
    let off = 0;
    let lastAbs = -1;
    while (off < endOff) {
      const abs = blockBase + off;
      const recLen = this.view.getUint16(abs + 4, true);
      if (
        recLen < DIRENT_HEADER_SIZE ||
        recLen % 4 !== 0 ||
        off + recLen > endOff
      ) {
        return -1;
      }
      lastAbs = abs;
      off += recLen;
    }
    return off === endOff ? lastAbs : -1;
  }

  private dirAppendEntry(
    dirIno: number,
    name: Uint8Array,
    childIno: number,
    lastEntAbs = -1,
  ): number {
    const inoOff = this.inodeOffset(dirIno);
    const dirSize = this.r64(inoOff + INO_SIZE);
    const needed = align4(DIRENT_HEADER_SIZE + name.length);

    // No space found — append a new entry at the end.
    // Directory entries must not cross block boundaries (like ext2).
    let appendPos = dirSize;
    let fileBlock = Math.floor(appendPos / BLOCK_SIZE);
    let blockOff = appendPos % BLOCK_SIZE;
    let reservedPhys = 0;

    if (blockOff !== 0 && blockOff + needed > BLOCK_SIZE) {
      // Entry doesn't fit in remaining space — skip to next block.
      const gap = BLOCK_SIZE - blockOff;
      let padPhys = 0;
      if (gap >= DIRENT_HEADER_SIZE) {
        padPhys = this.inodeBlockMap(dirIno, fileBlock, false);
        if (padPhys <= 0) return EIO;
      } else {
        if (lastEntAbs < 0) {
          lastEntAbs = this.findLastDirEntryInBlock(
            dirIno,
            fileBlock,
            blockOff,
          );
        }
        if (lastEntAbs < 0) return EIO;
      }

      // Reserve the destination block before changing the old tail. If the
      // allocation fails, the directory remains byte-for-byte unchanged.
      reservedPhys = this.inodeBlockMap(dirIno, fileBlock + 1, true);
      if (reservedPhys < 0) return reservedPhys;
      if (gap >= DIRENT_HEADER_SIZE) {
        // Write a padding entry (ino=0) to fill the gap
        const padAbs = padPhys * BLOCK_SIZE + blockOff;
        this.w32(padAbs, 0);
        this.view.setUint16(padAbs + 4, gap, true);
        this.view.setUint16(padAbs + 6, 0, true);
      } else {
        // Gap too small for a padding entry — extend last entry's recLen
        const oldRecLen = this.view.getUint16(lastEntAbs + 4, true);
        const newRecLen = oldRecLen + gap;
        this.view.setUint16(lastEntAbs + 4, newRecLen, true);
        this.updateDirIndexRecLen(dirIno, lastEntAbs, newRecLen);
      }
      appendPos = (fileBlock + 1) * BLOCK_SIZE;
      fileBlock++;
      blockOff = 0;
    }

    // Need a new block?
    let phys: number;
    if (blockOff === 0) {
      phys = reservedPhys || this.inodeBlockMap(dirIno, fileBlock, true);
      if (phys < 0) return phys;
    } else {
      phys = this.inodeBlockMap(dirIno, fileBlock, false);
      if (phys <= 0) return EIO;
    }

    const abs = phys * BLOCK_SIZE + blockOff;
    this.w32(abs, childIno);
    this.view.setUint16(abs + 4, needed, true);
    this.view.setUint16(abs + 6, name.length, true);
    this.u8.set(name, abs + DIRENT_HEADER_SIZE);

    this.w64(inoOff + INO_SIZE, appendPos + needed);
    this.touchDirectoryMutation(dirIno);
    this.updateDirIndexAdd(dirIno, name, childIno, abs, needed);
    return 0;
  }

  private dirAddEntry(
    dirIno: number,
    name: Uint8Array,
    childIno: number,
  ): number {
    const index = this.getDirIndex(dirIno);
    if (typeof index === "number") return index;
    if (index) {
      if (this.useDirIndexFreeSlot(index, dirIno, name, childIno)) return 0;

      // When no indexed deleted slot is available, append instead of scanning
      // every existing record again solely to discover internal slack.
      return this.dirAppendEntry(dirIno, name, childIno);
    }

    const inoOff = this.inodeOffset(dirIno);
    const dirSize = this.r64(inoOff + INO_SIZE);
    const needed = align4(DIRENT_HEADER_SIZE + name.length);

    // Track last entry position for potential recLen extension
    let lastEntAbs = -1;

    // Scan existing entries for a deleted slot or slack space
    let pos = 0;
    while (pos < dirSize) {
      const fileBlock = Math.floor(pos / BLOCK_SIZE);
      const blockOff = pos % BLOCK_SIZE;
      const phys = this.inodeBlockMap(dirIno, fileBlock, false);
      if (phys <= 0) return EIO;

      const blockBase = phys * BLOCK_SIZE;
      let remain = dirSize - pos;
      if (remain > BLOCK_SIZE - blockOff) remain = BLOCK_SIZE - blockOff;

      let off = blockOff;
      while (off < blockOff + remain) {
        const abs = blockBase + off;
        const entIno = this.r32(abs);
        const recLen = this.view.getUint16(abs + 4, true);
        const entNameLen = this.view.getUint16(abs + 6, true);

        if (
          recLen < DIRENT_HEADER_SIZE ||
          recLen % 4 !== 0 ||
          off + recLen > blockOff + remain ||
          entNameLen > recLen - DIRENT_HEADER_SIZE
        )
          return EIO;

        if (entIno === 0 && recLen >= needed) {
          // Reuse deleted entry
          this.w32(abs, childIno);
          this.view.setUint16(abs + 6, name.length, true);
          this.u8.set(name, abs + DIRENT_HEADER_SIZE);
          this.touchDirectoryMutation(dirIno);
          this.updateDirIndexAdd(dirIno, name, childIno, abs, recLen);
          return 0;
        }

        // Check for slack space at end of this entry
        const actualLen = align4(DIRENT_HEADER_SIZE + entNameLen);
        const slack = recLen - actualLen;
        if (entIno !== 0 && slack >= needed) {
          // Shrink current entry, insert new one in slack
          this.view.setUint16(abs + 4, actualLen, true);
          const newAbs = abs + actualLen;
          this.w32(newAbs, childIno);
          this.view.setUint16(newAbs + 4, slack, true);
          this.view.setUint16(newAbs + 6, name.length, true);
          this.u8.set(name, newAbs + DIRENT_HEADER_SIZE);
          this.touchDirectoryMutation(dirIno);
          this.updateDirIndexAdd(dirIno, name, childIno, newAbs, slack);
          return 0;
        }

        lastEntAbs = abs;
        off += recLen;
      }
      pos += remain;
    }

    return this.dirAppendEntry(dirIno, name, childIno, lastEntAbs);
  }

  private dirRemoveEntry(dirIno: number, name: Uint8Array): number {
    const index = this.getDirIndex(dirIno);
    if (typeof index === "number") return index;
    if (index) {
      const key = this.dirNameKey(name);
      const entry = index.entries.get(key);
      if (!entry) return ENOENT;

      if (
        this.r32(entry.abs) === entry.ino &&
        this.view.getUint16(entry.abs + 4, true) === entry.recLen &&
        this.view.getUint16(entry.abs + 6, true) === entry.nameLen &&
        this.dirEntryNameMatches(entry.abs, name)
      ) {
        this.w32(entry.abs, 0); // mark as deleted
        index.entries.delete(key);
        index.free.push({ abs: entry.abs, recLen: entry.recLen });
        this.touchDirectoryMutation(dirIno);
        return 0;
      }

      index.entries.delete(key);
      // Fall through to the linear scan below if the cached slot was stale.
    }

    const inoOff = this.inodeOffset(dirIno);
    const dirSize = this.r64(inoOff + INO_SIZE);
    let pos = 0;

    while (pos < dirSize) {
      const fileBlock = Math.floor(pos / BLOCK_SIZE);
      const blockOff = pos % BLOCK_SIZE;
      const phys = this.inodeBlockMap(dirIno, fileBlock, false);
      if (phys <= 0) return EIO;

      const blockBase = phys * BLOCK_SIZE;
      let remain = dirSize - pos;
      if (remain > BLOCK_SIZE - blockOff) remain = BLOCK_SIZE - blockOff;

      let off = blockOff;
      while (off < blockOff + remain) {
        const abs = blockBase + off;
        const entIno = this.r32(abs);
        const recLen = this.view.getUint16(abs + 4, true);
        const entNameLen = this.view.getUint16(abs + 6, true);

        if (!this.isValidDirEntry(off, blockOff + remain, recLen, entNameLen))
          return EIO;

        if (entIno !== 0 && entNameLen === name.length) {
          let match = true;
          for (let i = 0; i < name.length; i++) {
            if (this.u8[abs + DIRENT_HEADER_SIZE + i] !== name[i]) {
              match = false;
              break;
            }
          }
          if (match) {
            this.w32(abs, 0); // mark as deleted
            this.touchDirectoryMutation(dirIno);
            this.updateDirIndexRemove(dirIno, name);
            return 0;
          }
        }
        off += recLen;
      }
      pos += remain;
    }
    return ENOENT;
  }

  private dirReplaceEntryIno(
    dirIno: number,
    name: Uint8Array,
    childIno: number,
  ): number {
    const index = this.getDirIndex(dirIno);
    if (typeof index === "number") return index;
    if (index) {
      const key = this.dirNameKey(name);
      const entry = index.entries.get(key);

      if (
        entry &&
        this.r32(entry.abs) === entry.ino &&
        this.view.getUint16(entry.abs + 4, true) === entry.recLen &&
        this.view.getUint16(entry.abs + 6, true) === entry.nameLen &&
        this.dirEntryNameMatches(entry.abs, name)
      ) {
        this.w32(entry.abs, childIno);
        entry.ino = childIno;
        this.touchDirectoryMutation(dirIno);
        return 0;
      }

      if (entry) index.entries.delete(key);
      // Fall through to the linear scan below if the cached slot was stale.
    }

    const inoOff = this.inodeOffset(dirIno);
    const dirSize = this.r64(inoOff + INO_SIZE);
    let pos = 0;

    while (pos < dirSize) {
      const fileBlock = Math.floor(pos / BLOCK_SIZE);
      const blockOff = pos % BLOCK_SIZE;
      const phys = this.inodeBlockMap(dirIno, fileBlock, false);
      if (phys <= 0) return EIO;

      const blockBase = phys * BLOCK_SIZE;
      let remain = dirSize - pos;
      if (remain > BLOCK_SIZE - blockOff) remain = BLOCK_SIZE - blockOff;

      let off = blockOff;
      while (off < blockOff + remain) {
        const abs = blockBase + off;
        const entIno = this.r32(abs);
        const recLen = this.view.getUint16(abs + 4, true);
        const entNameLen = this.view.getUint16(abs + 6, true);

        if (!this.isValidDirEntry(off, blockOff + remain, recLen, entNameLen))
          return EIO;

        if (entIno !== 0 && entNameLen === name.length) {
          let match = true;
          for (let i = 0; i < name.length; i++) {
            if (this.u8[abs + DIRENT_HEADER_SIZE + i] !== name[i]) {
              match = false;
              break;
            }
          }
          if (match) {
            this.w32(abs, childIno);
            this.touchDirectoryMutation(dirIno);
            this.updateDirIndexAdd(dirIno, name, childIno, abs, recLen);
            return 0;
          }
        }
        off += recLen;
      }
      pos += remain;
    }
    return ENOENT;
  }

  private dirIsEmpty(dirIno: number): boolean {
    const inoOff = this.inodeOffset(dirIno);
    const dirSize = this.r64(inoOff + INO_SIZE);
    let pos = 0;

    while (pos < dirSize) {
      const fileBlock = Math.floor(pos / BLOCK_SIZE);
      const blockOff = pos % BLOCK_SIZE;
      const phys = this.inodeBlockMap(dirIno, fileBlock, false);
      if (phys <= 0) throw new SFSError(EIO);

      const blockBase = phys * BLOCK_SIZE;
      let remain = dirSize - pos;
      if (remain > BLOCK_SIZE - blockOff) remain = BLOCK_SIZE - blockOff;

      let off = blockOff;
      while (off < blockOff + remain) {
        const abs = blockBase + off;
        const entIno = this.r32(abs);
        const recLen = this.view.getUint16(abs + 4, true);
        const entNameLen = this.view.getUint16(abs + 6, true);

        if (
          recLen < DIRENT_HEADER_SIZE ||
          recLen % 4 !== 0 ||
          off + recLen > blockOff + remain ||
          entNameLen > recLen - DIRENT_HEADER_SIZE
        )
          throw new SFSError(EIO);

        if (entIno !== 0) {
          // Skip "." and ".."
          if (entNameLen === 1 && this.u8[abs + DIRENT_HEADER_SIZE] === 0x2e) {
            off += recLen;
            continue;
          }
          if (
            entNameLen === 2 &&
            this.u8[abs + DIRENT_HEADER_SIZE] === 0x2e &&
            this.u8[abs + DIRENT_HEADER_SIZE + 1] === 0x2e
          ) {
            off += recLen;
            continue;
          }
          return false;
        }
        off += recLen;
      }
      pos += remain;
    }
    return true;
  }

  private dirIsAncestor(ancestorIno: number, dirIno: number): boolean {
    let cur = dirIno;

    for (let depth = 0; depth < MAX_SYMLINK_HOPS * 1024; depth++) {
      if (cur === ancestorIno) return true;
      if (cur === ROOT_INO) return false;

      const parent = this.dirLookup(cur, DOTDOT_BYTES);
      if (parent < 0 || parent === cur) throw new SFSError(EIO);
      cur = parent;
    }

    throw new SFSError(EIO);
  }

  // ── Path resolution ──────────────────────────────────────────────

  private pathResolve(path: string, followSymlinks: boolean): number {
    if (!path.startsWith("/")) return ENOENT;

    let ino = ROOT_INO;
    const parts = path.split("/").filter((p) => p.length > 0);

    let symlinkHops = 0;

    for (let pi = 0; pi < parts.length; pi++) {
      const part = parts[pi];
      if (part.length > MAX_NAME) return ENAMETOOLONG;

      const nameBytes = encoder.encode(part);
      let childIno: number;
      this.inodeReadLock(ino);
      try {
        const inoOff = this.inodeOffset(ino);
        const mode = this.r32(inoOff + INO_MODE);
        if ((mode & S_IFMT) !== S_IFDIR) return ENOTDIR;
        childIno = this.dirLookup(ino, nameBytes);
      } finally {
        this.inodeReadUnlock(ino);
      }
      if (childIno < 0) return childIno;

      // Check if child is symlink
      const childOff = this.inodeOffset(childIno);
      const childMode = this.r32(childOff + INO_MODE);

      if ((childMode & S_IFMT) === S_IFLNK) {
        const isLast = pi === parts.length - 1;
        if (!isLast || followSymlinks) {
          if (++symlinkHops > MAX_SYMLINK_HOPS) return ELOOP;

          // Read symlink target
          const linkSize = this.r64(childOff + INO_SIZE);
          let target: string;
          if (linkSize <= INLINE_SYMLINK_SIZE) {
            target = safeDecode(
              this.u8.subarray(
                childOff + INO_DIRECT,
                childOff + INO_DIRECT + linkSize,
              ),
            );
          } else {
            const buf = new Uint8Array(linkSize);
            this.inodeReadData(childIno, 0, buf, linkSize);
            target = decoder.decode(buf);
          }

          // Resolve symlink
          if (target.startsWith("/")) {
            // Absolute symlink — restart from root
            ino = ROOT_INO;
            const targetParts = target.split("/").filter((p) => p.length > 0);
            const remaining = parts.slice(pi + 1);
            parts.length = 0;
            parts.push(...targetParts, ...remaining);
            pi = -1; // will be incremented to 0
          } else {
            // Relative symlink — splice into remaining path
            const targetParts = target.split("/").filter((p) => p.length > 0);
            const remaining = parts.slice(pi + 1);
            parts.length = pi;
            parts.push(...targetParts, ...remaining);
            pi--; // re-process from current position
          }
          continue;
        }
      }

      ino = childIno;
    }

    return ino;
  }

  private pathResolveParent(path: string): {
    parentIno: number;
    name: string;
  } {
    if (!path.startsWith("/"))
      throw new SFSError(EINVAL, "Path must be absolute");

    const parts = path.split("/").filter((p) => p.length > 0);
    if (parts.length === 0) throw new SFSError(EINVAL, "Cannot operate on /");

    const name = parts.pop()!;
    if (name.length > MAX_NAME) throw new SFSError(ENAMETOOLONG);

    const parentPath = "/" + parts.join("/");
    const parentIno = this.pathResolve(parentPath, true);
    if (parentIno < 0) throw new SFSError(parentIno);

    const pOff = this.inodeOffset(parentIno);
    const pMode = this.r32(pOff + INO_MODE);
    if ((pMode & S_IFMT) !== S_IFDIR) throw new SFSError(ENOTDIR);

    return { parentIno, name };
  }

  // ── FD table ─────────────────────────────────────────────────────

  /**
   * Claim the lowest free slot without exposing a usable descriptor.
   * fdGet() recognizes only FD_PUBLISHED, while the atomic reserved state
   * prevents another SharedFS worker from selecting the same number.
   */
  private fdReserve(): number {
    for (let i = 0; i < MAX_FDS; i++) {
      const base = FD_TABLE_OFFSET + i * FD_ENTRY_SIZE;
      const idx = base >> 2;
      const old = Atomics.compareExchange(
        this.i32,
        idx,
        FD_FREE,
        FD_RESERVED,
      );
      if (old === FD_FREE) return i;
    }
    return EMFILE;
  }

  private fdPrepare(
    fd: number,
    ino: number,
    flags: number,
    isDir: boolean,
  ): void {
    const base = FD_TABLE_OFFSET + fd * FD_ENTRY_SIZE;
    if (Atomics.load(this.i32, base >> 2) !== FD_RESERVED) {
      throw new SFSError(EIO);
    }
    this.w32(base + FD_INO, ino);
    this.w64(base + FD_OFFSET, 0);
    this.w32(base + FD_FLAGS, flags);
    this.w32(base + FD_IS_DIR, isDir ? 1 : 0);
  }

  private fdPublish(fd: number): void {
    const base = FD_TABLE_OFFSET + fd * FD_ENTRY_SIZE;
    Atomics.store(this.i32, base >> 2, FD_PUBLISHED);
  }

  private fdReleaseReservation(fd: number): void {
    const base = FD_TABLE_OFFSET + fd * FD_ENTRY_SIZE;
    const old = Atomics.compareExchange(
      this.i32,
      base >> 2,
      FD_RESERVED,
      FD_FREE,
    );
    if (old !== FD_RESERVED) throw new SFSError(EIO);
  }

  private fdAlloc(ino: number, flags: number, isDir: boolean): number {
    const fd = this.fdReserve();
    if (fd < 0) return fd;
    let referenced = false;
    let published = false;
    try {
      this.fdPrepare(fd, ino, flags, isDir);
      if (!this.inodeAddOpenRef(ino)) return ENOENT;
      referenced = true;
      this.fdPublish(fd);
      published = true;
      return fd;
    } finally {
      if (!published) {
        try {
          if (referenced) this.inodeDropOpenRef(ino);
        } finally {
          this.fdReleaseReservation(fd);
        }
      }
    }
  }

  private fdGet(fd: number): {
    base: number;
    ino: number;
    offset: number;
    flags: number;
    isDir: boolean;
  } | null {
    if (fd < 0 || fd >= MAX_FDS) return null;
    const base = FD_TABLE_OFFSET + fd * FD_ENTRY_SIZE;
    const state = Atomics.load(this.i32, base >> 2);
    if (state !== FD_PUBLISHED) return null;
    return {
      base,
      ino: this.r32(base + FD_INO),
      offset: this.r64(base + FD_OFFSET),
      flags: this.r32(base + FD_FLAGS),
      isDir: this.r32(base + FD_IS_DIR) !== 0,
    };
  }

  private fdFree(fd: number): void {
    if (fd >= 0 && fd < MAX_FDS) {
      const base = FD_TABLE_OFFSET + fd * FD_ENTRY_SIZE;
      Atomics.store(this.i32, base >> 2, FD_FREE);
    }
  }

  // ── Build stat result from inode ─────────────────────────────────

  private buildStat(ino: number): StatResult {
    const off = this.inodeOffset(ino);
    return {
      ino,
      generation: this.r64(off + INO_GENERATION),
      dataSequence: this.r32(off + INO_DATA_SEQUENCE),
      mode: this.r32(off + INO_MODE),
      linkCount: this.r32(off + INO_LINK_COUNT),
      size: this.r64(off + INO_SIZE),
      mtime: this.r64(off + INO_MTIME),
      ctime: this.r64(off + INO_CTIME),
      atime: this.r64(off + INO_ATIME),
      uid: this.r32(off + INO_UID),
      gid: this.r32(off + INO_GID),
    };
  }

  private namespaceEntryIdentity(ino: number): NamespaceEntryIdentity {
    const off = this.inodeOffset(ino);
    return {
      ino,
      generation: this.r64(off + INO_GENERATION),
      linkCount: this.r32(off + INO_LINK_COUNT),
      mode: this.r32(off + INO_MODE),
    };
  }

  // ── Public API: File operations ──────────────────────────────────

  open(path: string, flags: number, createMode: number = 0o644): number {
    return this.withNamespaceLock(() =>
      this.openUnlocked(path, flags, createMode),
    );
  }

  /**
   * Atomically create or truncate an empty lazy-file stub and capture the
   * exact data identity produced by that truncation. Existing callers rely on
   * lazy registration replacing a path, while the inode lock ensures a peer
   * write either precedes the truncation or advances the captured sequence
   * after it.
   */
  createLazyStub(path: string, mode: number): StatResult {
    return this.withNamespaceLock(() => {
      const fd = this.openUnlocked(path, O_WRONLY | O_CREAT, mode);
      try {
        const entry = this.fdGet(fd);
        if (!entry) throw new SFSError(EBADF);
        this.inodeWriteLock(entry.ino);
        try {
          this.inodeTruncate(entry.ino, 0, true);
          return this.buildStat(entry.ino);
        } finally {
          this.inodeWriteUnlock(entry.ino);
        }
      } finally {
        this.closeUnlocked(fd);
      }
    });
  }

  /**
   * Atomically replace a lazy stub only if the path still names the exact
   * inode content generation observed before an asynchronous fetch.
   */
  replaceIfIdentity(
    path: string,
    expectedIno: number,
    expectedGeneration: number,
    expectedDataSequence: number,
    data: Uint8Array,
  ): boolean {
    return this.withNamespaceLock(() => {
      // Lazy access follows symlinks, so conditionally replace the resolved
      // regular target while still validating its exact inode/data identity.
      const ino = this.pathResolve(path, true);
      if (ino < 0 || ino !== expectedIno) return false;
      const off = this.inodeOffset(ino);
      if (
        this.r64(off + INO_GENERATION) !== expectedGeneration ||
        this.r32(off + INO_DATA_SEQUENCE) !== expectedDataSequence
      )
        return false;
      if ((this.r32(off + INO_MODE) & S_IFMT) !== S_IFREG) return false;
      this.validateFileSize(data.byteLength);

      this.inodeWriteLock(ino);
      try {
        // Descriptor-based writes do not take the namespace lock. Revalidate
        // after acquiring the inode lock so a concurrent guest mutation that
        // won the race cannot be overwritten by stale fetched bytes.
        if (
          this.r64(off + INO_GENERATION) !== expectedGeneration ||
          this.r32(off + INO_DATA_SEQUENCE) !== expectedDataSequence
        )
          return false;
        // Lazy backing is attached only to an untouched empty stub. Refuse to
        // replace any concrete content even if malformed metadata happens to
        // carry its current sequence.
        if (this.r64(off + INO_SIZE) !== 0) return false;

        const originalMtime = this.r64(off + INO_MTIME);
        const originalCtime = this.r64(off + INO_CTIME);

        this.inodeTruncate(ino, 0, true);
        const written =
          data.byteLength > 0
            ? this.inodeWriteData(ino, 0, data, data.byteLength)
            : 0;
        if (written !== data.byteLength) {
          this.inodeTruncate(ino, 0, true);
          Atomics.store(
            this.i32,
            (off + INO_DATA_SEQUENCE) >> 2,
            expectedDataSequence,
          );
          this.w64(off + INO_MTIME, originalMtime);
          this.w64(off + INO_CTIME, originalCtime);
          throw new SFSError(written < 0 ? written : ENOSPC);
        }
        return true;
      } finally {
        this.inodeWriteUnlock(ino);
      }
    });
  }

  /**
   * Atomically replace a set of untouched lazy stubs.
   *
   * Archive materialization must not expose a prefix of the archive when a
   * later member cannot be allocated or written. Resolve every name under the
   * namespace lock, acquire all target inode locks in numeric order, validate
   * every identity again, and retain those locks until the complete commit is
   * visible. A write/allocation failure truncates every touched inode back to
   * its original empty state and restores its exact mutation timestamps and
   * data sequence before any target lock is released.
   *
   * `requiredNamespace` strengthens this for a multi-tree transaction: every
   * declared name (including each hard-link alias, directory, and symlink)
   * must retain its complete captured identity while the namespace lock is
   * held. Ordinary single-archive callers may omit it and retain their
   * rename-tolerant "first surviving alias" behavior.
   *
   * Returns false without mutation when any target stopped naming the exact
   * registered stub while an asynchronous archive fetch was in flight.
   */
  replaceManyIfIdentities(
    replacements: readonly ConditionalFileReplacement[],
    requiredNamespace: readonly ConditionalNamespaceIdentity[] = [],
  ): boolean {
    if (replacements.length === 0 && requiredNamespace.length === 0) return true;
    return this.withNamespaceLock(() => {
      const resolved: Array<ConditionalFileReplacement & { ino: number }> = [];
      const seenInodes = new Set<number>();

      const namespaceMatches = (
        identity: ConditionalNamespaceIdentity,
      ): boolean => {
        const ino = this.pathResolve(identity.path, false);
        if (ino < 0 || ino !== identity.expectedIno) return false;
        const off = this.inodeOffset(ino);
        return (
          this.r64(off + INO_GENERATION) === identity.expectedGeneration &&
          this.r32(off + INO_DATA_SEQUENCE) ===
            identity.expectedDataSequence &&
          this.r32(off + INO_MODE) === identity.expectedMode &&
          this.r32(off + INO_LINK_COUNT) === identity.expectedLinkCount &&
          this.r64(off + INO_SIZE) === identity.expectedSize &&
          this.r32(off + INO_UID) === identity.expectedUid &&
          this.r32(off + INO_GID) === identity.expectedGid
        );
      };
      for (const identity of requiredNamespace) {
        if (!namespaceMatches(identity)) return false;
      }

      for (const replacement of replacements) {
        this.validateFileSize(replacement.data.byteLength);
        let matchedIno = -1;
        for (const path of replacement.paths) {
          const ino = this.pathResolve(path, true);
          if (ino !== replacement.expectedIno) continue;
          const off = this.inodeOffset(ino);
          if (
            this.r64(off + INO_GENERATION) ===
                replacement.expectedGeneration &&
            this.r32(off + INO_DATA_SEQUENCE) ===
                replacement.expectedDataSequence &&
            (this.r32(off + INO_MODE) & S_IFMT) === S_IFREG &&
            this.r64(off + INO_SIZE) === 0
          ) {
            matchedIno = ino;
            break;
          }
        }
        if (matchedIno < 0) return false;
        if (seenInodes.has(matchedIno)) {
          // Callers must collapse hard-link aliases to one replacement. Two
          // independent payloads for one inode would make atomic ownership
          // ambiguous.
          throw new SFSError(EINVAL, "duplicate conditional replacement inode");
        }
        seenInodes.add(matchedIno);
        resolved.push({ ...replacement, ino: matchedIno });
      }

      const lockedInodes = [...seenInodes].sort((left, right) => left - right);
      for (const ino of lockedInodes) this.inodeWriteLock(ino);
      try {
        // Descriptor writes do not take the namespace lock. They may have won
        // before we acquired the last inode lock, so validate the complete set
        // again before changing the first byte.
        for (const replacement of resolved) {
          const off = this.inodeOffset(replacement.ino);
          if (
            this.r64(off + INO_GENERATION) !==
                replacement.expectedGeneration ||
            this.r32(off + INO_DATA_SEQUENCE) !==
                replacement.expectedDataSequence ||
            (this.r32(off + INO_MODE) & S_IFMT) !== S_IFREG ||
            this.r64(off + INO_SIZE) !== 0
          ) return false;
        }
        // Namespace operations cannot race while the outer lock is held, but
        // regular-file descriptor writes can. Recheck every guarded regular
        // inode after acquiring all replacement locks and before first write.
        for (const identity of requiredNamespace) {
          if (!namespaceMatches(identity)) return false;
        }

        const originals = resolved.map((replacement) => {
          const off = this.inodeOffset(replacement.ino);
          return {
            ino: replacement.ino,
            dataSequence: this.r32(off + INO_DATA_SEQUENCE),
            mtime: this.r64(off + INO_MTIME),
            ctime: this.r64(off + INO_CTIME),
          };
        });
        let touched = 0;
        try {
          for (const replacement of resolved) {
            touched++;
            this.inodeTruncate(replacement.ino, 0, true);
            const written = replacement.data.byteLength > 0
              ? this.inodeWriteData(
                replacement.ino,
                0,
                replacement.data,
                replacement.data.byteLength,
              )
              : 0;
            if (written !== replacement.data.byteLength) {
              throw new SFSError(written < 0 ? written : ENOSPC);
            }
          }
        } catch (error) {
          for (let index = touched - 1; index >= 0; index--) {
            const original = originals[index];
            const off = this.inodeOffset(original.ino);
            this.inodeTruncate(original.ino, 0, true);
            Atomics.store(
              this.i32,
              (off + INO_DATA_SEQUENCE) >> 2,
              original.dataSequence,
            );
            this.w64(off + INO_MTIME, original.mtime);
            this.w64(off + INO_CTIME, original.ctime);
          }
          throw error;
        }
        return true;
      } finally {
        for (let index = lockedInodes.length - 1; index >= 0; index--) {
          this.inodeWriteUnlock(lockedInodes[index]);
        }
      }
    });
  }

  private openUnlocked(
    path: string,
    flags: number,
    createMode: number = 0o644,
  ): number {
    const accMode = flags & O_ACCMODE;
    const creating = (flags & O_CREAT) !== 0;
    const exclusive = (flags & O_EXCL) !== 0;
    const fd = this.fdReserve();
    if (fd < 0) throw new SFSError(fd);
    let referencedIno: number | null = null;
    let published = false;

    try {
      if (creating && exclusive) {
        const existing = this.pathResolve(path, false);
        if (existing >= 0) throw new SFSError(EEXIST);
        if (existing !== ENOENT) throw new SFSError(existing);
      }

      let ino = this.pathResolve(path, true);
      let created = false;

      if (ino < 0 && ino === ENOENT && creating) {
        // Create the file
        const { parentIno, name } = this.pathResolveParent(path);
        this.inodeWriteLock(parentIno);
        try {
          // Double-check it doesn't exist now
          const nameBytes = encoder.encode(name);
          const existing = this.dirLookup(parentIno, nameBytes);
          if (existing >= 0) {
            if (exclusive) throw new SFSError(EEXIST);
            ino = existing;
          } else {
            const newIno = this.inodeAlloc();
            if (newIno < 0) throw new SFSError(ENOSPC);

            const newOff = this.inodeOffset(newIno);
            this.w32(newOff + INO_MODE, S_IFREG | (createMode & 0o7777));
            this.w32(newOff + INO_LINK_COUNT, 1);
            this.w64(newOff + INO_SIZE, 0);
            const now = this.clock();
            this.w64(newOff + INO_ATIME, now);
            this.w64(newOff + INO_MTIME, now);
            this.w64(newOff + INO_CTIME, now);

            const rc = this.dirAddEntry(parentIno, nameBytes, newIno);
            if (rc < 0) {
              this.inodeFree(newIno);
              throw new SFSError(rc);
            }
            ino = newIno;
            created = true;
          }
        } finally {
          this.inodeWriteUnlock(parentIno);
        }
      }

      if (ino < 0) throw new SFSError(ino);

      const inoOff = this.inodeOffset(ino);
      const mode = this.r32(inoOff + INO_MODE);

      if ((mode & S_IFMT) === S_IFDIR) {
        if (accMode !== O_RDONLY) throw new SFSError(EISDIR);
      }

      // O_DIRECTORY: reject non-directories
      if (flags & O_DIRECTORY && (mode & S_IFMT) !== S_IFDIR) {
        throw new SFSError(ENOTDIR);
      }

      this.fdPrepare(fd, ino, flags, false);
      if (!this.inodeAddOpenRef(ino)) throw new SFSError(ENOENT);
      referencedIno = ino;

      // Truncate if requested
      if (flags & O_TRUNC) {
        if ((mode & S_IFMT) === S_IFDIR) throw new SFSError(EISDIR);
        this.inodeWriteLock(ino);
        try {
          const sizeChanged = this.r64(inoOff + INO_SIZE) !== 0;
          this.inodeTruncate(ino, 0, true);
          if (!created && sizeChanged) {
            this.invalidateSetIdAfterRegularFileMutation(ino, "content");
          }
        } finally {
          this.inodeWriteUnlock(ino);
        }
      }

      this.fdPublish(fd);
      published = true;
      return fd;
    } finally {
      if (!published) {
        try {
          if (referencedIno !== null) {
            this.inodeDropOpenRef(referencedIno);
          }
        } finally {
          this.fdReleaseReservation(fd);
        }
      }
    }
  }

  close(fd: number): void {
    this.withNamespaceLock(() => this.closeUnlocked(fd));
  }

  private closeUnlocked(fd: number): void {
    const entry = this.fdGet(fd);
    if (!entry) throw new SFSError(EBADF);
    this.fdFree(fd);
    this.inodeDropOpenRef(entry.ino);
  }

  read(fd: number, buffer: Uint8Array): number {
    const entry = this.fdGet(fd);
    if (!entry) throw new SFSError(EBADF);
    const inoOff = this.inodeOffset(entry.ino);
    const mode = this.r32(inoOff + INO_MODE);
    if ((mode & S_IFMT) === S_IFDIR) throw new SFSError(EISDIR);

    this.inodeReadLock(entry.ino);
    try {
      const nread = this.inodeReadData(
        entry.ino,
        entry.offset,
        buffer,
        buffer.length,
      );
      // Update offset
      const base = FD_TABLE_OFFSET + fd * FD_ENTRY_SIZE;
      this.w64(base + FD_OFFSET, entry.offset + nread);
      return nread;
    } finally {
      this.inodeReadUnlock(entry.ino);
    }
  }

  readAt(fd: number, buffer: Uint8Array, offset: number): number {
    const entry = this.fdGet(fd);
    if (!entry) throw new SFSError(EBADF);
    const inoOff = this.inodeOffset(entry.ino);
    const mode = this.r32(inoOff + INO_MODE);
    if ((mode & S_IFMT) === S_IFDIR) throw new SFSError(EISDIR);
    this.validateSeekPosition(offset);

    this.inodeReadLock(entry.ino);
    try {
      return this.inodeReadData(entry.ino, offset, buffer, buffer.length);
    } finally {
      this.inodeReadUnlock(entry.ino);
    }
  }

  write(fd: number, data: Uint8Array): number {
    const entry = this.fdGet(fd);
    if (!entry) throw new SFSError(EBADF);

    const accMode = entry.flags & O_ACCMODE;
    if (accMode === O_RDONLY) throw new SFSError(EBADF);

    this.inodeWriteLock(entry.ino);
    try {
      let offset = entry.offset;
      if (entry.flags & O_APPEND) {
        const inoOff = this.inodeOffset(entry.ino);
        offset = this.r64(inoOff + INO_SIZE);
      }
      if (!Number.isSafeInteger(offset) || offset < 0) {
        throw new SFSError(EINVAL);
      }
      if (offset > MAX_FILE_SIZE || data.length > MAX_FILE_SIZE - offset) {
        throw new SFSError(EFBIG);
      }

      const nwritten = this.inodeWriteData(
        entry.ino,
        offset,
        data,
        data.length,
      );
      if (nwritten < 0) return nwritten;
      if (nwritten > 0) {
        this.invalidateSetIdAfterRegularFileMutation(entry.ino, "content");
      }
      // Update offset
      const base = FD_TABLE_OFFSET + fd * FD_ENTRY_SIZE;
      this.w64(base + FD_OFFSET, offset + nwritten);
      return nwritten;
    } finally {
      this.inodeWriteUnlock(entry.ino);
    }
  }

  append(
    fd: number,
    data: Uint8Array,
    limit: number | null,
  ): SharedFsAppendOutcome {
    const entry = this.fdGet(fd);
    if (!entry) throw new SFSError(EBADF);

    const accMode = entry.flags & O_ACCMODE;
    if (accMode === O_RDONLY) throw new SFSError(EBADF);
    if (limit !== null && (!Number.isSafeInteger(limit) || limit < 0)) {
      throw new SFSError(EINVAL);
    }

    this.inodeWriteLock(entry.ino);
    try {
      // WHY: resolve EOF and mutate the inode under the same lock. The
      // caller's current O_APPEND bit is Rust-owned, so this operation is
      // deliberately independent of the flags captured by SharedFS.open().
      // The file-size ceiling is applied before releasing this same lock, so
      // another SharedFS actor cannot move EOF between the limit decision and
      // the append.
      const inoOff = this.inodeOffset(entry.ino);
      const offset = this.r64(inoOff + INO_SIZE);
      if (!Number.isSafeInteger(offset) || offset < 0) {
        throw new SFSError(EINVAL);
      }
      if (offset > MAX_FILE_SIZE) {
        throw new SFSError(EFBIG);
      }

      if (limit !== null && offset >= limit) {
        const base = FD_TABLE_OFFSET + fd * FD_ENTRY_SIZE;
        this.w64(base + FD_OFFSET, offset);
        return { written: 0, end: offset };
      }

      const limitAvailable = limit === null
        ? data.length
        : Math.min(data.length, limit - offset);
      const fsAvailable = MAX_FILE_SIZE - offset;
      if (limitAvailable > fsAvailable) {
        throw new SFSError(EFBIG);
      }
      const writable = data.subarray(0, limitAvailable);
      const nwritten = this.inodeWriteData(
        entry.ino,
        offset,
        writable,
        writable.length,
      );
      if (nwritten < 0) throw new SFSError(nwritten);
      if (nwritten > 0) {
        this.invalidateSetIdAfterRegularFileMutation(entry.ino, "content");
      }
      const base = FD_TABLE_OFFSET + fd * FD_ENTRY_SIZE;
      const end = offset + nwritten;
      this.w64(base + FD_OFFSET, end);
      return { written: nwritten, end };
    } finally {
      this.inodeWriteUnlock(entry.ino);
    }
  }

  writeAt(fd: number, data: Uint8Array, offset: number): number {
    const entry = this.fdGet(fd);
    if (!entry) throw new SFSError(EBADF);

    const accMode = entry.flags & O_ACCMODE;
    if (accMode === O_RDONLY) throw new SFSError(EBADF);
    this.validateSeekPosition(offset);

    this.inodeWriteLock(entry.ino);
    try {
      // Positioned writes use their explicit offset even on an O_APPEND fd.
      if (offset > MAX_FILE_SIZE || data.length > MAX_FILE_SIZE - offset) {
        throw new SFSError(EFBIG);
      }
      const nwritten = this.inodeWriteData(
        entry.ino,
        offset,
        data,
        data.length,
      );
      if (nwritten > 0) {
        this.invalidateSetIdAfterRegularFileMutation(entry.ino, "content");
      }
      return nwritten;
    } finally {
      this.inodeWriteUnlock(entry.ino);
    }
  }

  lseek(fd: number, offset: number, whence: number): number {
    const entry = this.fdGet(fd);
    if (!entry) throw new SFSError(EBADF);

    let newOffset: number;
    if (whence === SEEK_SET) {
      newOffset = offset;
    } else if (whence === SEEK_CUR) {
      newOffset = entry.offset + offset;
    } else if (whence === SEEK_END) {
      const inoOff = this.inodeOffset(entry.ino);
      const size = this.r64(inoOff + INO_SIZE);
      newOffset = size + offset;
    } else {
      throw new SFSError(EINVAL);
    }

    this.validateSeekPosition(newOffset);

    const base = FD_TABLE_OFFSET + fd * FD_ENTRY_SIZE;
    this.w64(base + FD_OFFSET, newOffset);
    return newOffset;
  }

  ftruncate(fd: number, length: number): void {
    const entry = this.fdGet(fd);
    if (!entry) throw new SFSError(EBADF);
    if ((entry.flags & O_ACCMODE) === O_RDONLY) throw new SFSError(EBADF);
    this.validateFileSize(length);

    this.inodeWriteLock(entry.ino);
    try {
      const sizeChanged = this.r64(
        this.inodeOffset(entry.ino) + INO_SIZE,
      ) !== length;
      this.inodeTruncate(entry.ino, length, true);
      if (sizeChanged) {
        this.invalidateSetIdAfterRegularFileMutation(entry.ino, "content");
      }
    } finally {
      this.inodeWriteUnlock(entry.ino);
    }
  }

  fstat(fd: number): StatResult {
    const entry = this.fdGet(fd);
    if (!entry) throw new SFSError(EBADF);
    this.inodeReadLock(entry.ino);
    try {
      return this.buildStat(entry.ino);
    } finally {
      this.inodeReadUnlock(entry.ino);
    }
  }

  // ── Public API: Path operations ──────────────────────────────────

  stat(path: string): StatResult {
    return this.withNamespaceLock(() => this.statUnlocked(path));
  }

  private statUnlocked(path: string): StatResult {
    const ino = this.pathResolve(path, true);
    if (ino < 0) throw new SFSError(ino);
    this.inodeReadLock(ino);
    try {
      return this.buildStat(ino);
    } finally {
      this.inodeReadUnlock(ino);
    }
  }

  lstat(path: string): StatResult {
    return this.withNamespaceLock(() => this.lstatUnlocked(path));
  }

  private lstatUnlocked(path: string): StatResult {
    const ino = this.pathResolve(path, false); // don't follow symlinks
    if (ino < 0) throw new SFSError(ino);
    this.inodeReadLock(ino);
    try {
      return this.buildStat(ino);
    } finally {
      this.inodeReadUnlock(ino);
    }
  }

  unlink(path: string): NamespaceEntryIdentity {
    return this.withNamespaceLock(() => this.unlinkUnlocked(path));
  }

  private unlinkUnlocked(path: string): NamespaceEntryIdentity {
    const { parentIno, name } = this.pathResolveParent(path);
    const nameBytes = encoder.encode(name);
    const requiresDirectory = path.length > 1 && path.endsWith("/");

    this.inodeWriteLock(parentIno);
    try {
      const childIno = this.dirLookup(parentIno, nameBytes);
      if (childIno < 0) throw new SFSError(childIno);

      const childOff = this.inodeOffset(childIno);
      const mode = this.r32(childOff + INO_MODE);
      if (requiresDirectory && (mode & S_IFMT) !== S_IFDIR) {
        throw new SFSError(ENOTDIR);
      }
      if ((mode & S_IFMT) === S_IFDIR) throw new SFSError(EISDIR);
      const removed = this.namespaceEntryIdentity(childIno);

      const rc = this.dirRemoveEntry(parentIno, nameBytes);
      if (rc < 0) throw new SFSError(rc);

      let shouldFree = false;
      this.inodeWriteLock(childIno);
      try {
        shouldFree = this.inodeDropLinkRefLocked(childIno);
      } finally {
        this.inodeWriteUnlock(childIno);
      }
      if (shouldFree) this.inodeFree(childIno);
      return removed;
    } finally {
      this.inodeWriteUnlock(parentIno);
    }
  }

  rename(oldPath: string, newPath: string): RenameIdentityResult {
    return this.withNamespaceLock(() => this.renameUnlocked(oldPath, newPath));
  }

  private renameUnlocked(
    oldPath: string,
    newPath: string,
  ): RenameIdentityResult {
    const { parentIno: oldParent, name: oldName } =
      this.pathResolveParent(oldPath);
    const { parentIno: newParent, name: newName } =
      this.pathResolveParent(newPath);
    if (isReservedDirectoryName(oldName) || isReservedDirectoryName(newName)) {
      throw new SFSError(EINVAL);
    }
    const oldNameBytes = encoder.encode(oldName);
    const newNameBytes = encoder.encode(newName);
    const oldRequiresDirectory = oldPath.length > 1 && oldPath.endsWith("/");
    const newRequiresDirectory = newPath.length > 1 && newPath.endsWith("/");

    // Lock both parents (consistent order to avoid deadlock)
    const first = Math.min(oldParent, newParent);
    const second = Math.max(oldParent, newParent);
    this.inodeWriteLock(first);
    if (first !== second) this.inodeWriteLock(second);

    try {
      const srcIno = this.dirLookup(oldParent, oldNameBytes);
      if (srcIno < 0) throw new SFSError(srcIno);
      const srcOff = this.inodeOffset(srcIno);
      const srcMode = this.r32(srcOff + INO_MODE);
      const srcType = srcMode & S_IFMT;
      const source = this.namespaceEntryIdentity(srcIno);

      if (
        (oldRequiresDirectory || newRequiresDirectory) &&
        srcType !== S_IFDIR
      ) {
        throw new SFSError(ENOTDIR);
      }

      if (srcType === S_IFDIR && this.dirIsAncestor(srcIno, newParent)) {
        throw new SFSError(EINVAL);
      }

      // Replace an existing destination entry in place. Removing it before
      // allocating/inserting the source can destroy the destination when the
      // rename later fails with ENOSPC.
      const existingIno = this.dirLookup(newParent, newNameBytes);
      let removedExistingDirectory = false;
      let replaced: NamespaceEntryIdentity | undefined;
      if (existingIno >= 0) {
        if (existingIno === srcIno) {
          return { source, replaced: source };
        }
        replaced = this.namespaceEntryIdentity(existingIno);
        const existOff = this.inodeOffset(existingIno);
        const existMode = this.r32(existOff + INO_MODE);
        const existType = existMode & S_IFMT;

        if (srcType === S_IFDIR && existType !== S_IFDIR) {
          throw new SFSError(ENOTDIR);
        }
        if (srcType !== S_IFDIR && existType === S_IFDIR) {
          throw new SFSError(EISDIR);
        }

        let shouldFreeExisting = false;
        const existingAlreadyLocked =
          existingIno === oldParent || existingIno === newParent;
        if (!existingAlreadyLocked) this.inodeWriteLock(existingIno);
        try {
          if (existType === S_IFDIR && !this.dirIsEmpty(existingIno)) {
            throw new SFSError(ENOTEMPTY);
          }
          const replaceRc = this.dirReplaceEntryIno(
            newParent,
            newNameBytes,
            srcIno,
          );
          if (replaceRc < 0) throw new SFSError(replaceRc);
          shouldFreeExisting =
            existType === S_IFDIR
              ? this.inodeOrphanLocked(existingIno)
              : this.inodeDropLinkRefLocked(existingIno);
        } finally {
          if (!existingAlreadyLocked) this.inodeWriteUnlock(existingIno);
        }
        if (shouldFreeExisting) this.inodeFree(existingIno);
        removedExistingDirectory = existType === S_IFDIR;
      } else {
        const addRc = this.dirAddEntry(newParent, newNameBytes, srcIno);
        if (addRc < 0) throw new SFSError(addRc);
      }

      // Remove entry from old directory
      const removeRc = this.dirRemoveEntry(oldParent, oldNameBytes);
      if (removeRc < 0) throw new SFSError(removeRc);

      // Update link counts for directory renames
      if (srcType === S_IFDIR) {
        if (oldParent !== newParent) {
          const oldPOff = this.inodeOffset(oldParent);
          this.w32(
            oldPOff + INO_LINK_COUNT,
            this.r32(oldPOff + INO_LINK_COUNT) - 1,
          );
          const newPOff = this.inodeOffset(newParent);
          this.w32(
            newPOff + INO_LINK_COUNT,
            this.r32(newPOff + INO_LINK_COUNT) + 1,
          );

          this.inodeWriteLock(srcIno);
          try {
            const dotdotRc = this.dirReplaceEntryIno(
              srcIno,
              DOTDOT_BYTES,
              newParent,
            );
            if (dotdotRc < 0) throw new SFSError(dotdotRc);
            this.w64(srcOff + INO_CTIME, this.clock());
          } finally {
            this.inodeWriteUnlock(srcIno);
          }
        }

        if (removedExistingDirectory) {
          const newPOff = this.inodeOffset(newParent);
          this.w32(
            newPOff + INO_LINK_COUNT,
            this.r32(newPOff + INO_LINK_COUNT) - 1,
          );
        }
      } else if (removedExistingDirectory) {
        const newPOff = this.inodeOffset(newParent);
        this.w32(
          newPOff + INO_LINK_COUNT,
          this.r32(newPOff + INO_LINK_COUNT) - 1,
        );
      }
      return { source, replaced };
    } finally {
      if (first !== second) this.inodeWriteUnlock(second);
      this.inodeWriteUnlock(first);
    }
  }

  mkdir(path: string, mode: number = 0o755): void {
    this.withNamespaceLock(() => this.mkdirUnlocked(path, mode));
  }

  private mkdirUnlocked(path: string, mode: number = 0o755): void {
    const { parentIno, name } = this.pathResolveParent(path);
    const nameBytes = encoder.encode(name);

    this.inodeWriteLock(parentIno);
    try {
      const existing = this.dirLookup(parentIno, nameBytes);
      if (existing >= 0) throw new SFSError(EEXIST);

      const newIno = this.inodeAlloc();
      if (newIno < 0) throw new SFSError(ENOSPC);

      const newOff = this.inodeOffset(newIno);
      this.w32(newOff + INO_MODE, S_IFDIR | mode);
      this.w32(newOff + INO_LINK_COUNT, 2);
      this.w64(newOff + INO_SIZE, 0);
      const now = this.clock();
      this.w64(newOff + INO_ATIME, now);
      this.w64(newOff + INO_MTIME, now);
      this.w64(newOff + INO_CTIME, now);

      // Allocate data block for . and ..
      const blk = this.blockAllocWithGrow();
      if (blk < 0) {
        this.inodeFree(newIno);
        throw new SFSError(ENOSPC);
      }
      this.w32(newOff + INO_DIRECT, blk);

      const dBase = blk * BLOCK_SIZE;
      const dotRecLen = align4(DIRENT_HEADER_SIZE + 1);
      const dotdotRecLen = align4(DIRENT_HEADER_SIZE + 2);

      // "."
      this.w32(dBase, newIno);
      this.view.setUint16(dBase + 4, dotRecLen, true);
      this.view.setUint16(dBase + 6, 1, true);
      this.u8[dBase + DIRENT_HEADER_SIZE] = 0x2e;

      // ".."
      const ddOff = dBase + dotRecLen;
      this.w32(ddOff, parentIno);
      this.view.setUint16(ddOff + 4, dotdotRecLen, true);
      this.view.setUint16(ddOff + 6, 2, true);
      this.u8[ddOff + DIRENT_HEADER_SIZE] = 0x2e;
      this.u8[ddOff + DIRENT_HEADER_SIZE + 1] = 0x2e;

      this.w64(newOff + INO_SIZE, dotRecLen + dotdotRecLen);

      // Add entry in parent
      const rc = this.dirAddEntry(parentIno, nameBytes, newIno);
      if (rc < 0) {
        this.blockFree(blk);
        this.inodeFree(newIno);
        throw new SFSError(rc);
      }

      // Increment parent link count (for "..")
      const pOff = this.inodeOffset(parentIno);
      this.w32(pOff + INO_LINK_COUNT, this.r32(pOff + INO_LINK_COUNT) + 1);
    } finally {
      this.inodeWriteUnlock(parentIno);
    }
  }

  rmdir(path: string): void {
    this.withNamespaceLock(() => this.rmdirUnlocked(path));
  }

  private rmdirUnlocked(path: string): void {
    const { parentIno, name } = this.pathResolveParent(path);
    if (isReservedDirectoryName(name)) throw new SFSError(EINVAL);
    const nameBytes = encoder.encode(name);

    this.inodeWriteLock(parentIno);
    try {
      const childIno = this.dirLookup(parentIno, nameBytes);
      if (childIno < 0) throw new SFSError(childIno);

      const childOff = this.inodeOffset(childIno);
      const mode = this.r32(childOff + INO_MODE);
      if ((mode & S_IFMT) !== S_IFDIR) throw new SFSError(ENOTDIR);

      let shouldFree = false;
      this.inodeWriteLock(childIno);
      try {
        if (!this.dirIsEmpty(childIno)) throw new SFSError(ENOTEMPTY);

        const removeRc = this.dirRemoveEntry(parentIno, nameBytes);
        if (removeRc < 0) throw new SFSError(removeRc);
        shouldFree = this.inodeOrphanLocked(childIno);
      } finally {
        this.inodeWriteUnlock(childIno);
      }
      if (shouldFree) this.inodeFree(childIno);

      // Decrement parent link count
      const pOff = this.inodeOffset(parentIno);
      this.w32(pOff + INO_LINK_COUNT, this.r32(pOff + INO_LINK_COUNT) - 1);
    } finally {
      this.inodeWriteUnlock(parentIno);
    }
  }

  symlink(target: string, linkPath: string): void {
    this.withNamespaceLock(() => this.symlinkUnlocked(target, linkPath));
  }

  private symlinkUnlocked(target: string, linkPath: string): void {
    const { parentIno, name } = this.pathResolveParent(linkPath);
    const nameBytes = encoder.encode(name);
    const targetBytes = encoder.encode(target);

    this.inodeWriteLock(parentIno);
    try {
      const existing = this.dirLookup(parentIno, nameBytes);
      if (existing >= 0) throw new SFSError(EEXIST);

      const newIno = this.inodeAlloc();
      if (newIno < 0) throw new SFSError(ENOSPC);

      const newOff = this.inodeOffset(newIno);
      this.w32(newOff + INO_MODE, S_IFLNK | 0o777);
      this.w32(newOff + INO_LINK_COUNT, 1);

      if (targetBytes.length <= INLINE_SYMLINK_SIZE) {
        // Store inline in direct block pointers area
        this.u8.set(targetBytes, newOff + INO_DIRECT);
        this.w64(newOff + INO_SIZE, targetBytes.length);
      } else {
        this.w64(newOff + INO_SIZE, 0);
        const written = this.inodeWriteData(
          newIno,
          0,
          targetBytes,
          targetBytes.length,
        );
        if (written !== targetBytes.length) {
          if (written > 0) this.inodeTruncate(newIno, 0);
          this.inodeFree(newIno);
          throw new SFSError(written < 0 ? written : ENOSPC);
        }
      }

      const rc = this.dirAddEntry(parentIno, nameBytes, newIno);
      if (rc < 0) {
        if (targetBytes.length <= INLINE_SYMLINK_SIZE) {
          this.u8.fill(
            0,
            newOff + INO_DIRECT,
            newOff + INO_DIRECT + INLINE_SYMLINK_SIZE,
          );
          this.w64(newOff + INO_SIZE, 0);
        } else {
          this.inodeTruncate(newIno, 0);
        }
        this.inodeFree(newIno);
        throw new SFSError(rc);
      }
    } finally {
      this.inodeWriteUnlock(parentIno);
    }
  }

  chmod(path: string, mode: number): void {
    this.withNamespaceLock(() => this.chmodUnlocked(path, mode));
  }

  private chmodUnlocked(path: string, mode: number): void {
    const ino = this.pathResolve(path, true);
    if (ino < 0) throw new SFSError(ino);
    this.inodeWriteLock(ino);
    try {
      const off = this.inodeOffset(ino);
      const oldMode = this.r32(off + INO_MODE);
      this.w32(off + INO_MODE, (oldMode & S_IFMT) | (mode & 0o7777));
      this.w64(off + INO_CTIME, this.clock());
    } finally {
      this.inodeWriteUnlock(ino);
    }
  }

  fchmod(fd: number, mode: number): void {
    const entry = this.fdGet(fd);
    if (!entry) throw new SFSError(EBADF);
    this.inodeWriteLock(entry.ino);
    try {
      const off = this.inodeOffset(entry.ino);
      const oldMode = this.r32(off + INO_MODE);
      this.w32(off + INO_MODE, (oldMode & S_IFMT) | (mode & 0o7777));
      this.w64(off + INO_CTIME, this.clock());
    } finally {
      this.inodeWriteUnlock(entry.ino);
    }
  }

  chown(path: string, uid: number, gid: number): void {
    this.withNamespaceLock(() => this.chownUnlocked(path, uid, gid));
  }

  private chownUnlocked(path: string, uid: number, gid: number): void {
    const ino = this.pathResolve(path, true); // POSIX chown follows symlinks
    if (ino < 0) throw new SFSError(ino);
    this.inodeWriteLock(ino);
    try {
      this.chownInodeUnlocked(ino, uid, gid);
    } finally {
      this.inodeWriteUnlock(ino);
    }
  }

  fchown(fd: number, uid: number, gid: number): void {
    const entry = this.fdGet(fd);
    if (!entry) throw new SFSError(EBADF);
    this.inodeWriteLock(entry.ino);
    try {
      this.chownInodeUnlocked(entry.ino, uid, gid);
    } finally {
      this.inodeWriteUnlock(entry.ino);
    }
  }

  lchown(path: string, uid: number, gid: number): void {
    this.withNamespaceLock(() => this.lchownUnlocked(path, uid, gid));
  }

  private lchownUnlocked(path: string, uid: number, gid: number): void {
    const ino = this.pathResolve(path, false); // no-follow: chowns the symlink itself
    if (ino < 0) throw new SFSError(ino);
    this.inodeWriteLock(ino);
    try {
      this.chownInodeUnlocked(ino, uid, gid);
    } finally {
      this.inodeWriteUnlock(ino);
    }
  }

  /** Update ownership and the POSIX security-sensitive mode bits atomically
   * while the caller holds the inode write lock. */
  private chownInodeUnlocked(ino: number, uid: number, gid: number): void {
    const off = this.inodeOffset(ino);
    if (uid !== UID_GID_UNCHANGED) this.w32(off + INO_UID, uid);
    if (gid !== UID_GID_UNCHANGED) this.w32(off + INO_GID, gid);

    this.invalidateSetIdAfterRegularFileMutation(ino, "ownership");
    this.w64(off + INO_CTIME, this.clock());
  }

  utimens(
    path: string,
    atimeSec: number,
    atimeNsec: number,
    mtimeSec: number,
    mtimeNsec: number,
  ): void {
    this.withNamespaceLock(() =>
      this.utimensUnlocked(path, atimeSec, atimeNsec, mtimeSec, mtimeNsec),
    );
  }

  private utimensUnlocked(
    path: string,
    atimeSec: number,
    atimeNsec: number,
    mtimeSec: number,
    mtimeNsec: number,
  ): void {
    const ino = this.pathResolve(path, true);
    if (ino < 0) throw new SFSError(ino);
    this.inodeWriteLock(ino);
    try {
      const off = this.inodeOffset(ino);
      const UTIME_NOW = 0x3fffffff;
      const UTIME_OMIT = 0x3ffffffe;
      const now = this.clock();
      if (atimeNsec !== UTIME_OMIT) {
        const atimeMs =
          atimeNsec === UTIME_NOW
            ? now
            : atimeSec * 1000 + Math.floor(atimeNsec / 1_000_000);
        this.w64(off + INO_ATIME, atimeMs);
      }
      if (mtimeNsec !== UTIME_OMIT) {
        const mtimeMs =
          mtimeNsec === UTIME_NOW
            ? now
            : mtimeSec * 1000 + Math.floor(mtimeNsec / 1_000_000);
        this.w64(off + INO_MTIME, mtimeMs);
      }
      this.w64(off + INO_CTIME, now);
    } finally {
      this.inodeWriteUnlock(ino);
    }
  }

  link(existingPath: string, newPath: string): NamespaceEntryIdentity {
    return this.withNamespaceLock(() =>
      this.linkUnlocked(existingPath, newPath),
    );
  }

  private linkUnlocked(
    existingPath: string,
    newPath: string,
  ): NamespaceEntryIdentity {
    // Select POSIX link(2)'s permitted no-follow behavior for a final
    // symlink, which also matches linkat() when AT_SYMLINK_FOLLOW is clear.
    const srcIno = this.pathResolve(existingPath, false);
    if (srcIno < 0) throw new SFSError(srcIno);
    const srcOff = this.inodeOffset(srcIno);
    const srcMode = this.r32(srcOff + INO_MODE);
    if ((srcMode & S_IFMT) === S_IFDIR) throw new SFSError(EPERM);

    const { parentIno, name } = this.pathResolveParent(newPath);
    const nameBytes = encoder.encode(name);

    this.inodeWriteLock(parentIno);
    try {
      const existing = this.dirLookup(parentIno, nameBytes);
      if (existing >= 0) throw new SFSError(EEXIST);
      const rc = this.dirAddEntry(parentIno, nameBytes, srcIno);
      if (rc < 0) throw new SFSError(rc);
      this.inodeWriteLock(srcIno);
      try {
        const linkCount = this.r32(srcOff + INO_LINK_COUNT);
        this.w32(srcOff + INO_LINK_COUNT, linkCount + 1);
        this.w64(srcOff + INO_CTIME, this.clock());
      } finally {
        this.inodeWriteUnlock(srcIno);
      }
      return {
        ...this.namespaceEntryIdentity(srcIno),
        linkCount: this.r32(srcOff + INO_LINK_COUNT),
      };
    } finally {
      this.inodeWriteUnlock(parentIno);
    }
  }

  readlink(path: string): string {
    return this.withNamespaceLock(() => this.readlinkUnlocked(path));
  }

  private readlinkUnlocked(path: string): string {
    const ino = this.pathResolve(path, false);
    if (ino < 0) throw new SFSError(ino);
    return this.readSymlinkInodeUnlocked(ino);
  }

  private readSymlinkInodeUnlocked(ino: number): string {
    const inoOff = this.inodeOffset(ino);
    const mode = this.r32(inoOff + INO_MODE);
    if ((mode & S_IFMT) !== S_IFLNK) throw new SFSError(EINVAL);

    const size = this.r64(inoOff + INO_SIZE);
    if (size <= INLINE_SYMLINK_SIZE) {
      return safeDecode(
        this.u8.subarray(inoOff + INO_DIRECT, inoOff + INO_DIRECT + size),
      );
    }

    this.inodeReadLock(ino);
    try {
      const buf = new Uint8Array(size);
      this.inodeReadData(ino, 0, buf, size);
      return decoder.decode(buf);
    } finally {
      this.inodeReadUnlock(ino);
    }
  }

  // ── Public API: Directory reading ────────────────────────────────

  opendir(path: string): number {
    return this.withNamespaceLock(() => this.opendirUnlocked(path));
  }

  private opendirUnlocked(path: string): number {
    const ino = this.pathResolve(path, true);
    if (ino < 0) throw new SFSError(ino);

    const inoOff = this.inodeOffset(ino);
    const mode = this.r32(inoOff + INO_MODE);
    if ((mode & S_IFMT) !== S_IFDIR) throw new SFSError(ENOTDIR);

    const dd = this.fdAlloc(ino, O_RDONLY, true);
    if (dd < 0) throw new SFSError(dd);
    return dd;
  }

  readdirEntry(dd: number): { name: string; stat: StatResult } | null {
    return this.withNamespaceLock(() => this.readdirEntryUnlocked(dd));
  }

  private readdirEntryUnlocked(
    dd: number,
  ): { name: string; stat: StatResult } | null {
    const entry = this.fdGet(dd);
    if (!entry || !entry.isDir) throw new SFSError(EBADF);

    const inoOff = this.inodeOffset(entry.ino);
    const dirSize = this.r64(inoOff + INO_SIZE);

    while (entry.offset < dirSize) {
      const pos = entry.offset;
      const fileBlock = Math.floor(pos / BLOCK_SIZE);
      const blockOff = pos % BLOCK_SIZE;
      const phys = this.inodeBlockMap(entry.ino, fileBlock, false);
      if (phys <= 0) throw new SFSError(EIO);

      const abs = phys * BLOCK_SIZE + blockOff;
      const entIno = this.r32(abs);
      const recLen = this.view.getUint16(abs + 4, true);
      const entNameLen = this.view.getUint16(abs + 6, true);

      if (
        !this.isValidDirEntry(
          blockOff,
          Math.min(BLOCK_SIZE, blockOff + dirSize - pos),
          recLen,
          entNameLen,
        )
      )
        throw new SFSError(EIO);

      const nextOffset = pos + recLen;
      const base = FD_TABLE_OFFSET + dd * FD_ENTRY_SIZE;

      if (entIno === 0) {
        // A structurally valid deleted slot has no entry to return, but its
        // cursor still has to advance so the loop can reach the next slot.
        this.w64(base + FD_OFFSET, nextOffset);
        entry.offset = nextOffset;
        continue;
      }

      // Validate and construct the complete live result before committing
      // the shared cursor. Any failure must leave this record retryable.
      if (entIno >= this.r32(SB_TOTAL_INODES)) throw new SFSError(EIO);
      const ibStart = this.r32(SB_INODE_BITMAP_START) * BLOCK_SIZE;
      const word = this.r32(ibStart + (entIno >> 5) * 4);
      if ((word & (1 << (entIno & 31))) === 0) throw new SFSError(EIO);
      const nameStr = safeDecode(
        this.u8.subarray(
          abs + DIRENT_HEADER_SIZE,
          abs + DIRENT_HEADER_SIZE + entNameLen,
        ),
      );
      const stat = this.buildStat(entIno);

      this.w64(base + FD_OFFSET, nextOffset);
      entry.offset = nextOffset;
      return { name: nameStr, stat };
    }

    return null;
  }

  closedir(dd: number): void {
    this.close(dd);
  }

  readdir(path: string): string[] {
    const dd = this.opendir(path);
    const entries: string[] = [];
    try {
      let entry;
      while ((entry = this.readdirEntry(dd)) !== null) {
        if (entry.name !== "." && entry.name !== "..") {
          entries.push(entry.name);
        }
      }
    } finally {
      this.closedir(dd);
    }
    return entries;
  }

  // ── High-level helpers ───────────────────────────────────────────

  writeFile(path: string, data: string | Uint8Array): void {
    const bytes = typeof data === "string" ? encoder.encode(data) : data;
    const fd = this.open(path, O_WRONLY | O_CREAT | O_TRUNC);
    try {
      this.write(fd, bytes);
    } finally {
      this.close(fd);
    }
  }

  readFile(path: string): Uint8Array {
    const fd = this.open(path, O_RDONLY);
    try {
      const st = this.fstat(fd);
      const buf = new Uint8Array(st.size);
      this.read(fd, buf);
      return buf;
    } finally {
      this.close(fd);
    }
  }

  readFileText(path: string): string {
    return decoder.decode(this.readFile(path));
  }
}
