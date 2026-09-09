/**
 * Rootfs overlay image export (Phase 5 cutover).
 *
 * The in-kernel overlay owns `/` unconditionally, so the host's
 * `MemoryFileSystem` is demoted to a frozen byte store for the base image: it no
 * longer reflects runtime mutations (copy-on-written files, files created or
 * deleted at runtime, `chmod`/`chown`/`utimens`). Serializing it directly would
 * export a stale snapshot. The authoritative `/` tree lives in the kernel.
 *
 * This module rebuilds a faithful VFS image by *reconciling* the frozen base
 * image with the overlay's authoritative tree:
 *
 *   1. Clone the base image (`MemoryFileSystem.fromImage`). The clone carries
 *      the whole base tree, its metadata, and — crucially — the lazy per-file
 *      and lazy-archive descriptors, which live only in the base image and are
 *      *not* represented in the overlay (the overlay sees a lazy base file as an
 *      ordinary regular file whose bytes it fetches on demand).
 *   2. Ask the kernel to serialize its overlay-owned tree (`kernel_rootfs_export_tree`
 *      -> `KernelWorker.rootfsExportTree`, an RXPT metadata buffer; the wire
 *      format is defined in `crates/runtime-core/src/rootfs.rs`).
 *   3. Reconcile the clone to match the overlay: delete paths the overlay no
 *      longer has, add runtime-created dirs/files/symlinks, overwrite
 *      copy-on-written file bytes (read back through the overlay), and apply
 *      metadata changes. Base and lazy files that the overlay left unchanged are
 *      left untouched, so a not-yet-materialized lazy file stays lazy in the
 *      exported image instead of being force-fetched.
 *   4. Serialize the reconciled clone with the normal `saveImage()`, so the
 *      exported bytes use the exact same image format and round-trip.
 *
 * Lossy boundary: special nodes (AF_UNIX sockets, FIFOs) created at runtime have
 * no representation in a `/` image (the base-image builder skips them too), so
 * they are reported as `skippedSpecial` rather than fabricated.
 */

import { FILE_MODES } from "../generated/abi";
import { MemoryFileSystem } from "./memory-fs";

const { S_IFMT, S_IFDIR } = FILE_MODES;

/** RXPT export buffer magic ("RXPT" little-endian) and version. */
const EXPORT_MAGIC = 0x5450_5852;
const EXPORT_VERSION = 1;

const KIND_DIR = 1;
const KIND_BASE_REGULAR = 2;
const KIND_COW_REGULAR = 3;
const KIND_SYMLINK = 4;
const KIND_SPECIAL = 5;
const KIND_LAZY_MEMBER = 6;

const O_WRONLY_CREAT_TRUNC = 0o1101; // O_WRONLY | O_CREAT | O_TRUNC

interface ExportRecord {
  readonly kind: number;
  readonly mode: number;
  readonly uid: number;
  readonly gid: number;
  readonly mtimeSec: number;
  readonly mtimeNsec: number;
  readonly size: number;
  readonly path: string;
  readonly target: string;
}

const textDecoder = new TextDecoder();

/** Parse an RXPT overlay-tree export buffer into pre-order records. */
export function parseOverlayExportTree(buf: Uint8Array): ExportRecord[] {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let pos = 0;
  const u32 = (): number => {
    const v = view.getUint32(pos, true);
    pos += 4;
    return v;
  };
  const u64 = (): number => {
    const lo = view.getUint32(pos, true);
    const hi = view.getUint32(pos + 4, true);
    pos += 8;
    return hi * 0x1_0000_0000 + lo;
  };
  if (buf.byteLength < 12 || u32() !== EXPORT_MAGIC) {
    throw new Error("rootfs overlay export: bad magic");
  }
  const version = u32();
  if (version !== EXPORT_VERSION) {
    throw new Error(
      `rootfs overlay export: unsupported version ${version}`,
    );
  }
  const count = u32();
  const records: ExportRecord[] = [];
  for (let i = 0; i < count; i += 1) {
    const kind = buf[pos];
    pos += 1;
    const mode = u32();
    const uid = u32();
    const gid = u32();
    const mtimeSec = u64();
    const mtimeNsec = u32();
    const size = u64();
    const pathLen = u32();
    const path = textDecoder.decode(buf.subarray(pos, pos + pathLen));
    pos += pathLen;
    const targetLen = u32();
    const target = textDecoder.decode(buf.subarray(pos, pos + targetLen));
    pos += targetLen;
    records.push({ kind, mode, uid, gid, mtimeSec, mtimeNsec, size, path, target });
  }
  if (pos !== buf.byteLength) {
    throw new Error("rootfs overlay export: trailing bytes");
  }
  return records;
}

interface OverlayExportOptions {
  /** The frozen base image (`rootfsMemfs.saveImage()`). */
  readonly baseImage: Uint8Array;
  /** The overlay tree serialized via `KernelWorker.rootfsExportTree()`. */
  readonly overlayTree: Uint8Array;
  /**
   * Read the authoritative bytes of a copy-on-written / runtime-created `/` file
   * through the overlay (`KernelWorker.rootfsReadFile`). Only ever called for
   * `COW` regular files, never for base or lazy files, so it does not force any
   * lazy materialization.
   */
  readonly readCowBytes: (path: string) => Uint8Array;
}

export interface OverlayExportResult {
  readonly image: Uint8Array;
  /** Runtime special nodes (socket/FIFO) that a `/` image cannot represent. */
  readonly skippedSpecial: readonly string[];
}

function pathExists(fs: MemoryFileSystem, path: string): boolean {
  try {
    fs.lstat(path);
    return true;
  } catch {
    return false;
  }
}

function applyMetadata(
  fs: MemoryFileSystem,
  record: ExportRecord,
  isSymlink: boolean,
): void {
  if (isSymlink) {
    fs.lchown(record.path, record.uid, record.gid);
  } else {
    fs.chown(record.path, record.uid, record.gid);
    fs.chmod(record.path, record.mode & FILE_MODES.S_MODE_BITS);
  }
  // The overlay stores a single meaningful timestamp per inode (atime == mtime
  // == ctime, seeded from the image mtime); mirror that on export.
  fs.utimensat(
    record.path,
    record.mtimeSec,
    record.mtimeNsec,
    record.mtimeSec,
    record.mtimeNsec,
  );
}

/** Whether the clone's current metadata already matches the overlay record. */
function metadataMatches(
  fs: MemoryFileSystem,
  record: ExportRecord,
): boolean {
  const st = fs.lstat(record.path);
  if ((st.mode & FILE_MODES.S_MODE_BITS) !== (record.mode & FILE_MODES.S_MODE_BITS)) {
    return false;
  }
  if (st.uid !== record.uid || st.gid !== record.gid) return false;
  const overlayMtimeMs = record.mtimeSec * 1000 + record.mtimeNsec / 1_000_000;
  return Math.abs(st.mtimeMs - overlayMtimeMs) < 1;
}

/** Collect every path in the clone (excluding `/`), with a directory flag. */
function collectClonePaths(
  fs: MemoryFileSystem,
  dir: string,
  out: Array<{ path: string; isDir: boolean }>,
): void {
  const handle = fs.opendir(dir);
  const names: string[] = [];
  try {
    for (;;) {
      const entry = fs.readdir(handle);
      if (!entry) break;
      if (entry.name === "." || entry.name === "..") continue;
      names.push(entry.name);
    }
  } finally {
    fs.closedir(handle);
  }
  for (const name of names) {
    const path = dir === "/" ? `/${name}` : `${dir}/${name}`;
    const isDir = (fs.lstat(path).mode & S_IFMT) === S_IFDIR;
    out.push({ path, isDir });
    if (isDir) collectClonePaths(fs, path, out);
  }
}

/**
 * Build a faithful VFS image from the overlay's authoritative `/` tree. See the
 * module doc for the reconciliation contract.
 */
export async function exportRootfsImageFromOverlay(
  options: OverlayExportOptions,
): Promise<OverlayExportResult> {
  const records = parseOverlayExportTree(options.overlayTree);
  const overlayPaths = new Set(records.map((r) => r.path));

  const capacity = MemoryFileSystem.readImageCapacity(options.baseImage);
  // Reserve growth headroom: runtime-created / copy-on-written bytes are new
  // data not in the frozen base image, so a non-growable base ceiling would
  // reject them. maxByteLength is an address-space reservation, not committed.
  const maxByteLength = Math.max(
    capacity.maxByteLength,
    capacity.byteLength + 64 * 1024 * 1024,
  );
  const clone = MemoryFileSystem.fromImage(options.baseImage, { maxByteLength });

  // 1. Deletions: any clone path the overlay no longer has. Remove deepest
  //    first (children before parents) so directory removal sees them empty.
  const clonePaths: Array<{ path: string; isDir: boolean }> = [];
  collectClonePaths(clone, "/", clonePaths);
  const deletions = clonePaths
    .filter((entry) => !overlayPaths.has(entry.path))
    .sort((a, b) => b.path.length - a.path.length);
  for (const entry of deletions) {
    if (entry.isDir) clone.rmdir(entry.path);
    else clone.unlink(entry.path);
  }

  // 2. Apply the overlay tree pre-order (parents before children).
  const skippedSpecial: string[] = [];
  for (const record of records) {
    if (record.path === "/") {
      // Root always exists in the clone; only its metadata can change.
      applyMetadata(clone, record, false);
      continue;
    }
    switch (record.kind) {
      case KIND_DIR: {
        if (!pathExists(clone, record.path)) {
          clone.mkdirWithOwner(
            record.path,
            record.mode & FILE_MODES.S_MODE_BITS,
            record.uid,
            record.gid,
          );
        }
        applyMetadata(clone, record, false);
        break;
      }
      case KIND_SYMLINK: {
        if (
          pathExists(clone, record.path) &&
          clone.readlink(record.path) !== record.target
        ) {
          clone.unlink(record.path);
        }
        if (!pathExists(clone, record.path)) {
          clone.symlinkWithOwner(record.target, record.path, record.uid, record.gid);
        }
        applyMetadata(clone, record, true);
        break;
      }
      case KIND_COW_REGULAR: {
        const bytes = options.readCowBytes(record.path);
        // Replace any existing clone entry (possibly a lazy/base stub) so the
        // overlay's authoritative bytes win without a lazy read.
        if (pathExists(clone, record.path)) clone.unlink(record.path);
        clone.createFileWithOwner(
          record.path,
          record.mode & FILE_MODES.S_MODE_BITS,
          record.uid,
          record.gid,
          bytes,
        );
        applyMetadata(clone, record, false);
        break;
      }
      case KIND_BASE_REGULAR:
      case KIND_LAZY_MEMBER: {
        // Bytes (and any lazy descriptor) are already correct in the clone from
        // the base image. Touch metadata only when the overlay actually changed
        // it, to avoid perturbing an unmaterialized lazy entry.
        if (!pathExists(clone, record.path)) {
          // A base/lazy file the clone lacks would need bytes we deliberately
          // do not read here; surface it rather than fabricate an empty file.
          throw new Error(
            `rootfs overlay export: base file ${record.path} absent from base image`,
          );
        }
        if (!metadataMatches(clone, record)) {
          applyMetadata(clone, record, false);
        }
        break;
      }
      case KIND_SPECIAL: {
        skippedSpecial.push(record.path);
        break;
      }
      default:
        throw new Error(
          `rootfs overlay export: unknown record kind ${record.kind}`,
        );
    }
  }

  const image = await clone.saveImage();
  return { image, skippedSpecial };
}
