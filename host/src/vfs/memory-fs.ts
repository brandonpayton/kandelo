import { decompress as zstdDecompress } from "fzstd";
import type {
  AppendOutcome,
  HostFileOffset,
  PathconfValue,
  StatResult,
  StatfsResult,
} from "../types";
import {
  hostFileLimitForNumberBackend,
  hostFileOffsetToSafeNumber,
  hostFilePositionToSafeNumber,
} from "../file-offset";
import { filesystemPathconf } from "../pathconf";
import { SFFS_SUPER_MAGIC } from "../statfs";
import {
  ACCESS_MODES,
  DIRENT_TYPES,
  FILE_MODES,
  OPEN_FLAGS,
} from "../generated/abi";
import {
  ST_NOSUID,
  type FileSystemBackend,
  type DirEntry,
  type MountConfig,
  type MountSetIdCapability,
  type TimeProvider,
} from "./types";
import type { CheckpointBytes } from "../migration/checkpoint";
import {
  EROFS,
  O_CREAT,
  O_EXCL,
  O_TRUNC,
  SFSError,
  SharedFS,
  type ConditionalNamespaceIdentity,
  type NamespaceEntryIdentity,
  type SharedFsIdentityState,
  type StatResult as SfsStatResult,
} from "./sharedfs-vendor";
import type { ZipEntry } from "./zip";
import { resolveHardlinkGraph } from "./hardlink-graph";
import {
  assertVfsDeferredTreeCollectionUsage,
  VFS_DEFERRED_TREE_COLLECTION_LIMITS,
  VFS_DEFERRED_TREE_LIMITS,
  type VfsDeferredTreeUsage,
} from "./deferred-tree-limits";
import {
  applyLazyTreeByteTransformRecipe,
  decodeMaterializationBytes,
  validateLazyTreeMaterializationPlan,
  type LazyTreeByteIdentity,
  type LazyTreeMaterializationPlan,
} from "./materialization-plan";
import {
  assertUnicodeScalarText,
  compareUnicodeScalarText,
} from "./canonical-text";

const intrinsicApply = Reflect.apply;
const intrinsicObjectCreate = Object.create;
const intrinsicObjectDefineProperties = Object.defineProperties;
const intrinsicObjectFreeze = Object.freeze;
const intrinsicObjectGetOwnPropertyDescriptors =
  Object.getOwnPropertyDescriptors;
const intrinsicObjectSetPrototypeOf = Object.setPrototypeOf;
const IntrinsicProxy = Proxy;
const IntrinsicSharedArrayBuffer = SharedArrayBuffer;
const IntrinsicUint8Array = Uint8Array;
const intrinsicUint8ArraySet = Uint8Array.prototype.set;
const intrinsicWeakSetAdd = WeakSet.prototype.add;
const intrinsicWeakSetHas = WeakSet.prototype.has;
const intrinsicWeakMapGet = WeakMap.prototype.get;
const intrinsicWeakMapSet = WeakMap.prototype.set;
const intrinsicSetHas = Set.prototype.has;
const intrinsicMapGet = Map.prototype.get;
const IntrinsicNumber = Number;
const intrinsicNumberIsInteger = Number.isInteger;
const IntrinsicTypeError = TypeError;
const intrinsicSharedFsMount = SharedFS.mount;
const intrinsicSharedFsMkfs = SharedFS.mkfs;
const intrinsicSharedFsSnapshotState = SharedFS.prototype.snapshotState;
const memoryFileSystemInstances = new WeakSet<object>();
const memoryFileSystemDeviceIds = new WeakMap<object, number>();
let nextMemoryFileSystemDeviceId = 1;
const immutableProductBackends = new WeakSet<object>();

function capturePrivatePrototype(prototype: object): object {
  const captured = intrinsicObjectCreate(null) as object;
  intrinsicObjectDefineProperties(
    captured,
    intrinsicObjectGetOwnPropertyDescriptors(prototype),
  );
  return intrinsicObjectFreeze(captured);
}

const immutableProductSharedFsPrototype = capturePrivatePrototype(
  SharedFS.prototype,
);

/** The clock whose readings inode atime, mtime and ctime record. */
const CLOCK_REALTIME = 0;

const NOSUID_CAPABILITY: MountSetIdCapability = intrinsicObjectFreeze({
  kind: "nosuid",
});
const TRUSTED_ROOT_PRODUCT_CAPABILITY: MountSetIdCapability =
  intrinsicObjectFreeze({
    kind: "trusted-root-product",
    guestWritable: false,
    stableExecutableIdentity: true,
  });

/** Serializable lazy file entry for transfer between instances. */
export interface LazyFileEntry {
  ino: number;
  /** Inode-slot generation; omitted only by legacy serialized metadata. */
  generation?: number;
  /** Inode data-mutation sequence; omitted only by legacy metadata. */
  dataSequence?: number;
  path: string;
  /** All hard-link names for this inode; omitted by legacy metadata. */
  paths?: string[];
  url: string;
  size: number;
}

export type LazyDownloadKind = "file" | "tree" | "archive";
export type LazyDownloadStatus = "started" | "progress" | "complete" | "error";

export interface LazyDownloadEvent {
  id: string;
  kind: LazyDownloadKind;
  status: LazyDownloadStatus;
  url: string;
  path?: string;
  mountPrefix?: string;
  loadedBytes: number;
  totalBytes?: number;
  error?: string;
  t: number;
}

export type LazyDownloadListener = (event: LazyDownloadEvent) => void;

type LazyFetch = (
  url: string,
  init?: { signal?: AbortSignal },
) => Promise<Response>;

export interface LazyFetcherOptions {
  /**
   * Explicit cancellation provenance shared with the fetcher. MemoryFS passes
   * this exact signal into every attempt and rethrows its reason unchanged.
   */
  signal?: AbortSignal;
}

interface LazyTransport {
  fetcher: LazyFetch;
  signal?: AbortSignal;
}

interface LazyPreparation {
  status: "pending" | "fulfilled" | "rejected";
  promise: Promise<boolean>;
  error?: unknown;
}

interface PreparedLazyArchiveReplacement {
  ino: number;
  generation: number;
  dataSequence: number;
  paths: Set<string>;
  content: Uint8Array;
}

interface LazyBacking {
  token: object;
  path: string;
  /** Metadata-only trees have no pending inode, so prepare the group itself. */
  directGroup?: LazyArchiveGroup;
  /** All members commit together; no member may become concrete alone. */
  atomicGroup?: LazyAtomicGroup;
}

interface LazyAtomicGroup {
  id: string;
  token: object;
  groups: Map<string, LazyArchiveGroup>;
  expectedCount?: number;
  cohortSha256?: string;
  /** One cryptographic proof shared by inspection and first-use activation. */
  sealValidationFlight?: Promise<void>;
  committed: boolean;
}

interface LazyAtomicSnapshotEntry extends LazyArchiveFileEntry {
  vfsPath: string;
}

interface LazyAtomicSnapshotSource {
  id: string;
  member: string;
  descriptorBytes: Uint8Array;
  content: LazyTreeContent;
  inventory: LazyTreeRegistrationEntry[];
  activation: LazyTreeActivation;
  url: string;
  mountPrefix: string;
  integrity: LazyArchiveIntegrity;
  entries: LazyAtomicSnapshotEntry[];
}

interface SealedLazyAtomicSnapshot extends LazyAtomicSnapshotSource {
  descriptorSha256: string;
  expectedCount: number;
  cohortSha256: string;
}

interface SealedLazyAtomicState {
  snapshot: SealedLazyAtomicSnapshot;
  /** Local seals are proven while created; imported seal claims start false. */
  verified: boolean;
}

/** Caller-inaccessible authority for one ordinary pending generic tree. */
interface LazyTreeDefinitionSnapshot {
  content: LazyTreeContent;
  inventory: LazyTreeRegistrationEntry[];
  activation: LazyTreeActivation;
  url: string;
  mountPrefix: string;
  integrity: LazyArchiveIntegrity;
  entries: LazyAtomicSnapshotEntry[];
  materialized: boolean;
}

/** Per-file metadata for a file inside a lazy archive. */
export interface LazyArchiveFileEntry {
  ino: number;
  /** Inode-slot generation; omitted only by legacy serialized metadata. */
  generation?: number;
  /** Inode data-mutation sequence; omitted only by legacy metadata. */
  dataSequence?: number;
  size: number;
  isSymlink: boolean;
  deleted: boolean;
  /** True once this inode's archive backing is no longer pending. */
  materialized?: boolean;
  /** Original path inside the archive (stable across VFS rename/hard-link). */
  archivePath?: string;
  sourcePath?: string;
  type?: "file" | "symlink" | "hardlink";
  inodeGroup?: string;
  target?: string;
}

/** Optional immutable identity for a remotely fetched lazy archive. */
export interface LazyArchiveIntegrity {
  sha256: string;
  bytes: number;
}

/** Closed decoder set for an immutable deferred filesystem tree. */
export type LazyTreeDecoder = "zip-v1" | "tar-gzip-v1";

export interface LazyTreeContent {
  decoder: LazyTreeDecoder;
  mediaType:
    | "application/zip"
    | "application/vnd.oci.image.layer.v1.tar+gzip";
  sha256: string;
  bytes: number;
  /** Exact decoder expansion bound declared by the trusted inventory. */
  expandedBytes: number;
  sourceEntryCount: number;
  /** Byte-identical transport mirrors, tried in declared order. */
  transports: string[];
  /** Closed install-mode normalization for portable package ZIP outputs. */
  modePolicy?: "portable-posix-v1";
  /** Complete source-member truth for the authenticated archive. */
  source?: LazyTreeSourceInventory;
  /** Optional authenticated source assertions and byte transformations. */
  materialization?: LazyTreeMaterializationPlan;
}

export interface LazyTreeSourceEntry {
  sourcePath: string;
  type: "directory" | "file" | "symlink" | "hardlink";
  mode: number;
  size: number;
  target?: string;
}

export interface LazyTreeSourceInventory {
  schema: 1;
  kind: "archive-source-inventory-v1";
  entries: LazyTreeSourceEntry[];
}

export interface LazyTreeRegistrationEntry {
  /** Absolute, canonical VFS path. */
  vfsPath: string;
  /** Canonical member path interpreted by the selected decoder. */
  sourcePath: string;
  /** Explicit only when a complete source inventory permits projections. */
  materialization?:
    | "archive"
    | "archive-copy"
    | "archive-copy-mode"
    | "descriptor";
  type: "directory" | "file" | "symlink" | "hardlink";
  mode: number;
  /** Logical guest size; hard links repeat their canonical file's size. */
  size: number;
  /** Symlink text, or an absolute VFS target for a hard link. */
  target?: string;
  /** Required on files and hardlinks; equal values share one inode. */
  inodeGroup?: string;
}

/** POSIX owner applied before a lazy tree becomes observable as deferred. */
export interface LazyTreeRegistrationOwner {
  uid: number;
  gid: number;
}

export interface LazyTreeActivation {
  mode: "boot-prefetch" | "first-use";
  capabilities: string[];
  roots: string[];
  /**
   * Optional fail-closed activation transaction shared by several trees.
   * Every member is fetched and validated before one namespace commit.
   */
  atomicGroup?: LazyAtomicGroupMembership;
}

/**
 * One member of a fail-closed multi-tree activation cohort.
 *
 * Producers first register `{ id, member }`, then seal the cohort. Sealing
 * binds every member's transport-independent tree descriptor into one digest
 * and adds the remaining fields before the tree may activate or serialize.
 */
export interface LazyAtomicGroupMembership {
  id: string;
  member: string;
  descriptorSha256?: string;
  expectedCount?: number;
  cohortSha256?: string;
}

/**
 * A group of files whose content comes from a single zip archive.
 * Accessing any member materializes the entire archive in one fetch.
 */
export interface LazyArchiveGroup {
  /** Format-neutral immutable content and transport identity. */
  content?: LazyTreeContent;
  /** @deprecated compatibility field for legacy serialized ZIP groups. */
  url: string;
  mountPrefix: string;
  integrity?: LazyArchiveIntegrity;
  materialized: boolean;
  /** Complete trusted source-to-namespace inventory for generic trees. */
  inventory?: LazyTreeRegistrationEntry[];
  activation?: LazyTreeActivation;
  entries: Map<string, LazyArchiveFileEntry>; // keyed by VFS absolute path
}

/** JSON-serializable form of LazyArchiveGroup for cross-worker transfer. */
export interface SerializedLazyArchiveEntry {
  /** Closed wire identity; legacy snapshots without it are migration-only. */
  kind:
    | "kandelo-legacy-zip-v1"
    | "kandelo-deferred-tree-v1"
    | "kandelo-deferred-tree-v2"
    | "kandelo-deferred-tree-v3";
  content?: LazyTreeContent;
  inventory?: LazyTreeRegistrationEntry[];
  activation?: LazyTreeActivation;
  url: string;
  mountPrefix: string;
  integrity?: LazyArchiveIntegrity;
  materialized: boolean;
  entries: Array<{
    vfsPath: string;
    ino: number;
    generation?: number;
    dataSequence?: number;
    size: number;
    isSymlink: boolean;
    deleted: boolean;
    materialized?: boolean;
    archivePath?: string;
    sourcePath?: string;
    type?: "file" | "symlink" | "hardlink";
    inodeGroup?: string;
    target?: string;
  }>;
}

/** Format-neutral names for the runtime and serialized deferred-tree contract. */
export type LazyTreeGroup = LazyArchiveGroup;
export type SerializedLazyTree = SerializedLazyArchiveEntry;

const DEFERRED_TREE_MATERIALIZATION_HANDLE: unique symbol = Symbol(
  "DeferredTreeMaterializationHandle",
);

/** Opaque authority for one typed tree registered on one exact filesystem. */
export interface DeferredTreeMaterializationHandle {
  readonly [DEFERRED_TREE_MATERIALIZATION_HANDLE]: true;
}

/** Options for saving a VFS image. */
export interface VfsImageOptions {
  /**
   * If true, fetch and write all lazy file contents before saving.
   * The resulting image is self-contained with no external URL dependencies.
   * If false (default), lazy file metadata is preserved as-is.
   */
  materializeAll?: boolean;
  /**
   * Optional image-level metadata. `undefined` preserves any metadata loaded
   * from the source image; `null` clears it.
   */
  metadata?: VfsImageMetadata | null;
  /**
   * Replace every allocated inode's atime, mtime, and ctime in the serialized
   * snapshot with this millisecond value. The live filesystem is unchanged.
   * Omit this for ordinary runtime snapshots that must preserve POSIX times.
   */
  normalizeTimestampsMs?: number;
}

/** Options for restoring a VFS image into a live filesystem. */
export interface VfsImageRestoreOptions {
  /**
   * Permit the restored SharedArrayBuffer to grow up to this byte length,
   * without raising the filesystem ceiling encoded in the image superblock.
   */
  maxByteLength?: number;
  /**
   * Reject an image before decompression when its zstd frame bound, or its
   * uncompressed input length, exceeds this caller-owned lifecycle limit.
   * The limit may narrow but never raise the format-wide safety ceiling.
   */
  maxDecompressedBytes?: number;
}

/** Versioned, image-level declarations carried outside the guest file tree. */
export interface VfsImageMetadata {
  version: 1;
  /**
   * Exact kernel ABI this image expects when it carries ABI-bound artifacts
   * such as wasm-posix user programs. Omit for data-only images.
   */
  kernelAbi?: number;
  /** Free-form builder id, e.g. "mkrootfs 0.1.0" or a package script name. */
  createdBy?: string;
  /** Preserve forwards compatibility for future signed/provenance fields. */
  [key: string]: unknown;
}

export interface VfsImageCapacity {
  /** Serialized SharedArrayBuffer length carried by the image. */
  byteLength: number;
  /** Filesystem growth ceiling declared by the image superblock. */
  maxByteLength: number;
}

// zstd frame magic (little-endian on the wire: 28 B5 2F FD).
// fromImage() auto-detects this and decompresses transparently so callers
// don't have to know whether the bytes came from a `.vfs` or `.vfs.zst`.
const ZSTD_MAGIC_BYTES = [0x28, 0xb5, 0x2f, 0xfd];
const ZSTD_FRAME_MAGIC = 0xfd2fb528;
const ZSTD_SKIPPABLE_MAGIC_MIN = 0x184d2a50;
const ZSTD_SKIPPABLE_MAGIC_MAX = 0x184d2a5f;
const ZSTD_MAX_BLOCK_BYTES = 128 * 1024;

// VFS image binary format constants
const VFS_IMAGE_MAGIC = 0x56465349; // "VFSI"
const VFS_IMAGE_VERSION = 1;
const VFS_IMAGE_FLAG_HAS_LAZY = 1 << 0;
const VFS_IMAGE_FLAG_HAS_LAZY_ARCHIVES = 1 << 1;
const VFS_IMAGE_FLAG_HAS_METADATA = 1 << 2;
const VFS_IMAGE_FLAG_HAS_TYPED_LAZY_ARCHIVES = 1 << 3;
const VFS_IMAGE_HEADER_SIZE = 16; // magic(4) + version(4) + flags(4) + sabLen(4)
const { S_IFMT, S_IFREG, S_IFDIR, S_IFLNK } = FILE_MODES;
const { DT_UNKNOWN, DT_REG, DT_DIR, DT_LNK } = DIRENT_TYPES;
const O_RDONLY = OPEN_FLAGS.O_RDONLY;
const IMMUTABLE_PRODUCT_O_ACCMODE = OPEN_FLAGS.O_ACCMODE;
const IMMUTABLE_PRODUCT_O_CREAT = OPEN_FLAGS.O_CREAT;
const IMMUTABLE_PRODUCT_O_TRUNC = OPEN_FLAGS.O_TRUNC;
const IMMUTABLE_PRODUCT_W_OK = ACCESS_MODES.W_OK;
const O_WRONLY_CREAT_TRUNC =
  OPEN_FLAGS.O_WRONLY | OPEN_FLAGS.O_CREAT | OPEN_FLAGS.O_TRUNC;
const COPY_CHUNK_BYTES = 1024 * 1024;
const MIN_REBASE_INITIAL_BYTES = 16 * 1024 * 1024;
const VFS_IMAGE_MAX_METADATA_BYTES = 64 * 1024;
const VFS_IMAGE_MAX_LAZY_METADATA_BYTES = 16 * 1024 * 1024;
const VFS_IMAGE_MAX_LAZY_ARCHIVE_METADATA_BYTES = 16 * 1024 * 1024;
const VFS_IMAGE_MAX_DECOMPRESSED_BYTES =
  1024 * 1024 * 1024
  + VFS_IMAGE_MAX_LAZY_METADATA_BYTES
  + VFS_IMAGE_MAX_LAZY_ARCHIVE_METADATA_BYTES
  + VFS_IMAGE_MAX_METADATA_BYTES
  + VFS_IMAGE_HEADER_SIZE
  + 12;
const MAX_LAZY_ARCHIVE_BYTES = VFS_DEFERRED_TREE_LIMITS.maxArchiveBytes;
const MAX_LAZY_EXPANDED_BYTES = VFS_DEFERRED_TREE_LIMITS.maxExpandedBytes;
const MAX_LAZY_PAYLOAD_BYTES = VFS_DEFERRED_TREE_LIMITS.maxPayloadBytes;
const MAX_BOOT_DEFERRED_TREE_CONCURRENCY = 2;
const MAX_ATOMIC_DEFERRED_TREE_CONCURRENCY = 4;
const MAX_LAZY_TREE_ENTRIES = VFS_DEFERRED_TREE_LIMITS.maxEntries;
const MAX_LAZY_TREE_GROUPS = VFS_DEFERRED_TREE_COLLECTION_LIMITS.maxGroups;
const MAX_LAZY_TREE_PATH_BYTES = VFS_DEFERRED_TREE_LIMITS.maxPathBytes;
const MAX_LAZY_TREE_SYMLINK_TARGET_BYTES =
  VFS_DEFERRED_TREE_LIMITS.maxSymlinkTargetBytes;
const MAX_LAZY_TREE_STRING_BYTES = VFS_DEFERRED_TREE_LIMITS.maxStringBytes;
const MAX_LAZY_TREE_CAPABILITIES =
  VFS_DEFERRED_TREE_LIMITS.maxActivationCapabilities;
const MAX_LAZY_TREE_ACTIVATION_ROOTS =
  VFS_DEFERRED_TREE_LIMITS.maxActivationRoots;
const MAX_LAZY_TREE_ATOMIC_GROUP_BYTES =
  VFS_DEFERRED_TREE_LIMITS.maxActivationCapabilityBytes;
const MAX_LAZY_TREE_OWNER_ID = 0xffff_fffe;
const MAX_LAZY_TRANSPORT_ATTEMPTS = 3;
const LAZY_TRANSPORT_RETRY_BASE_MS = 250;
const MAX_LAZY_TRANSPORT_RETRY_DELAY_MS = 5_000;
const SHA256_RE = /^[0-9a-f]{64}$/;
const SERIALIZED_LEGACY_ARCHIVE_KIND = "kandelo-legacy-zip-v1";
const SERIALIZED_DEFERRED_TREE_V1_KIND = "kandelo-deferred-tree-v1";
const SERIALIZED_DEFERRED_TREE_V2_KIND = "kandelo-deferred-tree-v2";
const SERIALIZED_DEFERRED_TREE_V3_KIND = "kandelo-deferred-tree-v3";

const TRANSIENT_NETWORK_ERROR_CODES = new Set([
  "ECONNABORTED",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETDOWN",
  "ENETRESET",
  "ENETUNREACH",
  "EPIPE",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
]);

class LazyHttpResponseError extends Error {
  constructor(
    readonly status: number,
    readonly retryAfterMs: number | undefined,
  ) {
    super(`HTTP ${status}`);
    this.name = "LazyHttpResponseError";
  }
}

interface PlannedLazyArchiveEntry {
  entry: ZipEntry;
  archivePath: string;
  vfsPath: string;
}

function normalizeLazyArchiveMountPrefix(mountPrefix: unknown): string {
  if (
    typeof mountPrefix !== "string" ||
    !mountPrefix.startsWith("/") ||
    new TextEncoder().encode(mountPrefix).byteLength > MAX_LAZY_TREE_PATH_BYTES ||
    mountPrefix.includes("\0") ||
    mountPrefix.includes("\\")
  ) {
    throw new Error(
      `Lazy archive mount prefix must be an absolute POSIX path: ${JSON.stringify(mountPrefix)}`,
    );
  }
  const normalized = mountPrefix.replace(/\/+$/, "");
  if (normalized === "") return "/";
  const segments = normalized.slice(1).split("/");
  if (
    segments.some(
      (segment) => segment === "" || segment === "." || segment === "..",
    )
  ) {
    throw new Error(
      `Lazy archive mount prefix is not canonical: ${JSON.stringify(mountPrefix)}`,
    );
  }
  return normalized;
}

function planLazyArchiveEntries(
  url: string,
  zipEntries: ZipEntry[],
  mountPrefix: string,
  symlinkTargets?: Map<string, string>,
): PlannedLazyArchiveEntry[] {
  const normalizedPrefix = normalizeLazyArchiveMountPrefix(mountPrefix);
  const seen = new Map<string, ZipEntry>();
  const planned = zipEntries.map((entry): PlannedLazyArchiveEntry => {
    const member = entry.fileName;
    const context = `Lazy archive ${JSON.stringify(url)} member ${JSON.stringify(member)}`;
    if (member.length === 0) {
      throw new Error(`${context} has an empty path`);
    }
    if (member.includes("\0")) {
      throw new Error(`${context} contains a NUL byte`);
    }
    if (member.includes("\\")) {
      throw new Error(`${context} contains a backslash`);
    }
    if (member.startsWith("/") || /^[A-Za-z]:\//.test(member)) {
      throw new Error(`${context} must be relative, not absolute`);
    }
    if (entry.isDirectory && entry.isSymlink) {
      throw new Error(`${context} has conflicting directory and symlink types`);
    }
    if (entry.isDirectory !== member.endsWith("/")) {
      throw new Error(`${context} has inconsistent directory metadata`);
    }

    const archivePath = entry.isDirectory ? member.slice(0, -1) : member;
    const segments = archivePath.split("/");
    if (
      archivePath.length === 0 ||
      segments.some(
        (segment) => segment === "" || segment === "." || segment === "..",
      )
    ) {
      throw new Error(
        `${context} is not a canonical relative POSIX path`,
      );
    }
    if (seen.has(archivePath)) {
      throw new Error(
        `${context} collides with another member at ${JSON.stringify(archivePath)}`,
      );
    }
    if (entry.isSymlink && !symlinkTargets?.has(member)) {
      throw new Error(`Lazy archive symlink target was not provided: ${member}`);
    }
    seen.set(archivePath, entry);
    return {
      entry,
      archivePath,
      vfsPath: normalizedPrefix === "/"
        ? `/${archivePath}`
        : `${normalizedPrefix}/${archivePath}`,
    };
  });

  for (const { archivePath } of planned) {
    const segments = archivePath.split("/");
    for (let length = 1; length < segments.length; length++) {
      const ancestorPath = segments.slice(0, length).join("/");
      const ancestor = seen.get(ancestorPath);
      if (ancestor && !ancestor.isDirectory) {
        throw new Error(
          `Lazy archive member ${JSON.stringify(archivePath)} descends ` +
            `through non-directory ${JSON.stringify(ancestorPath)}`,
        );
      }
    }
  }
  return planned;
}

function cloneMetadata(
  metadata: VfsImageMetadata | null,
): VfsImageMetadata | null {
  return metadata === null ? null : { ...metadata };
}

function validateMetadata(metadata: VfsImageMetadata): VfsImageMetadata {
  if (!metadata || typeof metadata !== "object") {
    throw new Error("VFS image metadata must be an object");
  }
  if (metadata.version !== 1) {
    throw new Error(
      `Unsupported VFS image metadata version: ${String(metadata.version)}`,
    );
  }
  if (
    metadata.kernelAbi !== undefined &&
    (!Number.isInteger(metadata.kernelAbi) || metadata.kernelAbi < 0)
  ) {
    throw new Error(
      `VFS image metadata kernelAbi must be a non-negative integer`,
    );
  }
  if (
    metadata.createdBy !== undefined &&
    typeof metadata.createdBy !== "string"
  ) {
    throw new Error("VFS image metadata createdBy must be a string");
  }
  return { ...metadata };
}

function decodeMetadata(bytes: Uint8Array): VfsImageMetadata {
  if (bytes.byteLength > VFS_IMAGE_MAX_METADATA_BYTES) {
    throw new Error(
      `VFS image metadata exceeds ${VFS_IMAGE_MAX_METADATA_BYTES} bytes`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`Invalid VFS image metadata JSON: ${msg}`);
  }
  return validateMetadata(parsed as VfsImageMetadata);
}

function encodeMetadata(metadata: VfsImageMetadata | null): Uint8Array {
  if (metadata === null) return new Uint8Array(0);
  const normalized = validateMetadata(metadata);
  const bytes = new TextEncoder().encode(JSON.stringify(normalized));
  if (bytes.byteLength > VFS_IMAGE_MAX_METADATA_BYTES) {
    throw new Error(
      `VFS image metadata exceeds ${VFS_IMAGE_MAX_METADATA_BYTES} bytes`,
    );
  }
  return bytes;
}

function maybeDecompressImage(
  image: Uint8Array,
  maximum = VFS_IMAGE_MAX_DECOMPRESSED_BYTES,
): Uint8Array {
  if (
    !Number.isSafeInteger(maximum) || maximum < VFS_IMAGE_HEADER_SIZE ||
    maximum > VFS_IMAGE_MAX_DECOMPRESSED_BYTES
  ) {
    throw new Error("VFS image decompressed byte bound is invalid");
  }
  if (
    image.byteLength >= ZSTD_MAGIC_BYTES.length &&
    image[0] === ZSTD_MAGIC_BYTES[0] &&
    image[1] === ZSTD_MAGIC_BYTES[1] &&
    image[2] === ZSTD_MAGIC_BYTES[2] &&
    image[3] === ZSTD_MAGIC_BYTES[3]
  ) {
    assertBoundedZstdFrames(image, maximum);
    const decompressed = decompressZstd(image);
    if (decompressed.byteLength > maximum) {
      throw new Error("zstd VFS image exceeds its decompressed byte bound");
    }
    return decompressed;
  }
  if (image.byteLength > maximum) {
    throw new Error("VFS image exceeds its decompressed byte bound");
  }
  return image;
}

function assertBoundedZstdFrames(image: Uint8Array, maximum: number): void {
  const view = new DataView(image.buffer, image.byteOffset, image.byteLength);
  let offset = 0;
  let totalBound = 0;
  let frames = 0;
  const requireBytes = (count: number, label: string) => {
    if (count < 0 || offset + count > image.byteLength) {
      throw new Error(`zstd VFS image has a truncated ${label}`);
    }
  };
  const addBound = (count: number) => {
    totalBound += count;
    if (!Number.isSafeInteger(totalBound) || totalBound > maximum) {
      throw new Error("zstd VFS image exceeds its decompressed byte bound");
    }
  };
  const readLittleEndian = (count: number): bigint => {
    requireBytes(count, "frame header");
    let result = 0n;
    for (let index = 0; index < count; index++) {
      result |= BigInt(image[offset + index]!) << BigInt(index * 8);
    }
    offset += count;
    return result;
  };

  while (offset < image.byteLength) {
    requireBytes(4, "frame magic");
    const magic = view.getUint32(offset, true);
    offset += 4;
    if (magic >= ZSTD_SKIPPABLE_MAGIC_MIN && magic <= ZSTD_SKIPPABLE_MAGIC_MAX) {
      requireBytes(4, "skippable frame size");
      const bytes = view.getUint32(offset, true);
      offset += 4;
      requireBytes(bytes, "skippable frame");
      offset += bytes;
      continue;
    }
    if (magic !== ZSTD_FRAME_MAGIC) {
      throw new Error("zstd VFS image contains an invalid frame magic");
    }
    frames++;
    requireBytes(1, "frame descriptor");
    const descriptor = image[offset++]!;
    if ((descriptor & 0x08) !== 0) {
      throw new Error("zstd VFS image uses a reserved frame descriptor bit");
    }
    const singleSegment = (descriptor & 0x20) !== 0;
    const hasChecksum = (descriptor & 0x04) !== 0;
    const dictionaryBytes = [0, 1, 2, 4][descriptor & 0x03]!;
    const contentSizeFlag = descriptor >>> 6;
    let windowBytes: bigint | undefined;
    if (!singleSegment) {
      requireBytes(1, "window descriptor");
      const windowDescriptor = image[offset++]!;
      const exponent = 10 + (windowDescriptor >>> 3);
      const base = 1n << BigInt(exponent);
      windowBytes = base + (base >> 3n) * BigInt(windowDescriptor & 0x07);
    }
    requireBytes(dictionaryBytes, "dictionary identity");
    offset += dictionaryBytes;
    const contentSizeBytes = contentSizeFlag === 0
      ? (singleSegment ? 1 : 0)
      : contentSizeFlag === 1
      ? 2
      : contentSizeFlag === 2
      ? 4
      : 8;
    let contentBytes: bigint | undefined;
    if (contentSizeBytes > 0) {
      contentBytes = readLittleEndian(contentSizeBytes);
      if (contentSizeFlag === 1) contentBytes += 256n;
      if (singleSegment) windowBytes = contentBytes;
    }
    if (windowBytes !== undefined && windowBytes > BigInt(maximum)) {
      throw new Error("zstd VFS image exceeds its decompressed window bound");
    }
    if (contentBytes !== undefined && contentBytes > BigInt(maximum)) {
      throw new Error("zstd VFS image exceeds its decompressed byte bound");
    }

    let frameBound = 0;
    for (;;) {
      requireBytes(3, "block header");
      const header = image[offset]!
        | (image[offset + 1]! << 8)
        | (image[offset + 2]! << 16);
      offset += 3;
      const last = (header & 1) !== 0;
      const type = (header >>> 1) & 0x03;
      const blockBytes = header >>> 3;
      if (type === 3 || blockBytes > ZSTD_MAX_BLOCK_BYTES) {
        throw new Error("zstd VFS image contains an invalid block header");
      }
      frameBound += type === 2 ? ZSTD_MAX_BLOCK_BYTES : blockBytes;
      if (
        !Number.isSafeInteger(frameBound) ||
        (contentBytes === undefined && frameBound > maximum)
      ) {
        throw new Error("zstd VFS image exceeds its decompressed byte bound");
      }
      const encodedBytes = type === 1 ? 1 : blockBytes;
      requireBytes(encodedBytes, "block payload");
      offset += encodedBytes;
      if (last) break;
    }
    if (hasChecksum) {
      requireBytes(4, "content checksum");
      offset += 4;
    }
    if (contentBytes !== undefined && contentBytes > BigInt(frameBound)) {
      throw new Error("zstd VFS image frame content exceeds its block bound");
    }
    // A compressed block may expand to at most 128 KiB, so frameBound is the
    // only safe pre-decompression bound when the frame omits its content
    // size. When zstd carries the exact size, use that stronger declaration:
    // summing the per-block maximum can otherwise reject a valid frame whose
    // declared output remains below the caller-owned lifecycle ceiling.
    addBound(
      contentBytes === undefined ? frameBound : Number(contentBytes),
    );
  }
  if (frames === 0) {
    throw new Error("zstd VFS image contains no data frame");
  }
}

interface ParsedImageHeader {
  image: Uint8Array;
  view: DataView;
  flags: number;
  sabLen: number;
}

function parseImageHeader(
  input: Uint8Array,
  maxDecompressedBytes?: number,
): ParsedImageHeader {
  const image = maybeDecompressImage(input, maxDecompressedBytes);

  if (image.byteLength < VFS_IMAGE_HEADER_SIZE) {
    throw new Error("VFS image too small");
  }

  const view = new DataView(image.buffer, image.byteOffset, image.byteLength);
  const magic = view.getUint32(0, true);
  if (magic !== VFS_IMAGE_MAGIC) {
    throw new Error(
      `Bad VFS image magic: 0x${magic.toString(16)} (expected 0x${VFS_IMAGE_MAGIC.toString(16)})`,
    );
  }
  const version = view.getUint32(4, true);
  if (version !== VFS_IMAGE_VERSION) {
    throw new Error(
      `Unsupported VFS image version: ${version} (expected ${VFS_IMAGE_VERSION})`,
    );
  }
  const flags = view.getUint32(8, true);
  const sabLen = view.getUint32(12, true);

  if (image.byteLength < VFS_IMAGE_HEADER_SIZE + sabLen + 4) {
    throw new Error("VFS image truncated");
  }

  return { image, view, flags, sabLen };
}

function sectionOffsetAfterArchives(
  image: Uint8Array,
  view: DataView,
  flags: number,
  sabLen: number,
): { lazyLen: number; archiveOffset: number; metadataOffset: number } {
  const lazyOffset = VFS_IMAGE_HEADER_SIZE + sabLen;
  const lazyLen = view.getUint32(lazyOffset, true);
  if (lazyLen > VFS_IMAGE_MAX_LAZY_METADATA_BYTES) {
    throw new Error(
      `VFS image lazy metadata exceeds ${VFS_IMAGE_MAX_LAZY_METADATA_BYTES} bytes`,
    );
  }
  if (image.byteLength < lazyOffset + 4 + lazyLen) {
    throw new Error("VFS image truncated (lazy metadata section)");
  }
  const archiveOffset = lazyOffset + 4 + lazyLen;
  let metadataOffset = archiveOffset;

  if (flags & VFS_IMAGE_FLAG_HAS_LAZY_ARCHIVES) {
    if (image.byteLength < archiveOffset + 4) {
      throw new Error("VFS image truncated (lazy archive section)");
    }
    const archiveLen = view.getUint32(archiveOffset, true);
    if (archiveLen > VFS_IMAGE_MAX_LAZY_ARCHIVE_METADATA_BYTES) {
      throw new Error(
        `VFS image lazy archive metadata exceeds ` +
          `${VFS_IMAGE_MAX_LAZY_ARCHIVE_METADATA_BYTES} bytes`,
      );
    }
    if (image.byteLength < archiveOffset + 4 + archiveLen) {
      throw new Error("VFS image truncated (lazy archive payload)");
    }
    metadataOffset = archiveOffset + 4 + archiveLen;
  }

  return { lazyLen, archiveOffset, metadataOffset };
}

function decodeJsonSection(bytes: Uint8Array, label: string): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${label} is not valid UTF-8 JSON: ${detail}`);
  }
}

function monotonicNow(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

function parseContentLength(headers: Headers | undefined): number | undefined {
  const encoding = headers?.get("content-encoding")?.trim().toLowerCase();
  if (encoding && encoding !== "identity") return undefined;
  const raw = headers?.get("content-length");
  if (!raw) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

function isTransientHttpStatus(status: number): boolean {
  return status === 408 || status === 429 || (status >= 500 && status <= 599);
}

function parseRetryAfterMs(
  headers: Headers | undefined,
  now = Date.now(),
): number | undefined {
  const raw = headers?.get("retry-after")?.trim();
  if (!raw) return undefined;
  let delayMs: number;
  if (/^\d+$/.test(raw)) {
    delayMs = Number(raw) * 1_000;
  } else {
    const retryAt = Date.parse(raw);
    if (!Number.isFinite(retryAt)) return undefined;
    delayMs = Math.max(0, retryAt - now);
  }
  if (!Number.isSafeInteger(delayMs) || delayMs < 0) return undefined;
  // WHY: Retry-After is advisory input from a remote server. Capping it keeps
  // one deferred open from parking a guest process for an attacker-chosen time.
  return Math.min(delayMs, MAX_LAZY_TRANSPORT_RETRY_DELAY_MS);
}

function errorCause(error: unknown): unknown {
  if (typeof error !== "object" || error === null || !("cause" in error)) {
    return undefined;
  }
  return (error as { cause?: unknown }).cause;
}

function errorName(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("name" in error)) {
    return undefined;
  }
  return typeof (error as { name?: unknown }).name === "string"
    ? (error as { name: string }).name
    : undefined;
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  return typeof (error as { code?: unknown }).code === "string"
    ? (error as { code: string }).code
    : undefined;
}

function errorChainSome(
  error: unknown,
  predicate: (candidate: unknown) => boolean,
): boolean {
  const seen = new Set<unknown>();
  let candidate: unknown = error;
  for (let depth = 0; candidate !== undefined && depth < 8; depth += 1) {
    if (seen.has(candidate)) return false;
    seen.add(candidate);
    if (predicate(candidate)) return true;
    candidate = errorCause(candidate);
  }
  return false;
}

function isAbortFailure(error: unknown): boolean {
  return errorChainSome(error, (candidate) =>
    errorName(candidate) === "AbortError" ||
    errorCode(candidate) === "ABORT_ERR"
  );
}

function isTransientNetworkFailure(error: unknown): boolean {
  if (isAbortFailure(error)) return false;
  // Fetch intentionally exposes network failures as TypeError in browsers.
  // Node's fetch adds transport codes on its bounded `cause` chain, while
  // DOM-backed streams may use NetworkError or TimeoutError instead.
  return errorChainSome(error, (candidate) => {
    const name = errorName(candidate);
    const code = errorCode(candidate);
    return candidate instanceof TypeError ||
      name === "NetworkError" ||
      name === "TimeoutError" ||
      (code !== undefined && TRANSIENT_NETWORK_ERROR_CODES.has(code));
  });
}

function lazyTransportRetryDelayMs(
  error: unknown,
  failedAttempt: number,
): number | null {
  if (error instanceof LazyHttpResponseError) {
    if (!isTransientHttpStatus(error.status)) return null;
    if (error.retryAfterMs !== undefined) return error.retryAfterMs;
  } else if (!isTransientNetworkFailure(error)) {
    return null;
  }
  return Math.min(
    LAZY_TRANSPORT_RETRY_BASE_MS * (2 ** failedAttempt),
    MAX_LAZY_TRANSPORT_RETRY_DELAY_MS,
  );
}

function throwIfLazyTransportAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw signal.reason;
}

function waitForLazyTransportRetry(
  delayMs: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  throwIfLazyTransportAborted(signal);
  if (delayMs === 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(false), delayMs);
    const onAbort = (): void => finish(true, signal!.reason);
    let settled = false;
    function finish(aborted: boolean, reason?: unknown): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (aborted) {
        reject(reason);
      } else {
        resolve();
      }
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    // The signal can abort between the initial check and listener install.
    if (signal?.aborted) onAbort();
  });
}

async function cancelResponseBody(
  response: Response,
  reason: unknown,
): Promise<void> {
  try {
    await response.body?.cancel(reason);
  } catch {
    // A failed transport may already have errored its stream. Cancellation is
    // resource cleanup and must not replace the diagnostic that caused it.
  }
}

function concatChunks(chunks: Uint8Array[], total: number): Uint8Array {
  if (chunks.length === 1) return chunks[0];
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function validateLazyArchiveIntegrity(
  value: unknown,
): LazyArchiveIntegrity | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Lazy archive integrity must be an object");
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !== 2 ||
    !("sha256" in record) ||
    !("bytes" in record)
  ) {
    throw new Error("Lazy archive integrity has unexpected fields");
  }
  if (typeof record.sha256 !== "string" || !SHA256_RE.test(record.sha256)) {
    throw new Error("Lazy archive integrity has an invalid SHA-256 digest");
  }
  if (
    !Number.isSafeInteger(record.bytes) ||
    Number(record.bytes) <= 0 ||
    Number(record.bytes) > MAX_LAZY_ARCHIVE_BYTES
  ) {
    throw new Error(
      `Lazy archive integrity byte count must be between 1 and ` +
        `${MAX_LAZY_ARCHIVE_BYTES}`,
    );
  }
  return { sha256: record.sha256, bytes: Number(record.bytes) };
}

function exactLazyTreeRecord(
  value: unknown,
  keys: readonly string[],
  label: string,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record);
  if (
    actual.length !== keys.length ||
    keys.some((key) => !Object.prototype.hasOwnProperty.call(record, key))
  ) {
    throw new Error(`${label} has unexpected or missing fields`);
  }
  return record;
}

function boundedLazyTreeRecord(
  value: unknown,
  allowedKeys: readonly string[],
  requiredKeys: readonly string[],
  label: string,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set(allowedKeys);
  if (
    Object.keys(record).some((key) => !allowed.has(key)) ||
    requiredKeys.some((key) => !Object.prototype.hasOwnProperty.call(record, key))
  ) {
    throw new Error(`${label} has unexpected or missing fields`);
  }
  return record;
}

function requireLazyTreeArray(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): unknown[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) {
    throw new Error(`${label} must contain ${minimum} to ${maximum} items`);
  }
  return value;
}

function requireLazyTreeString(
  value: unknown,
  label: string,
  maximumBytes: number,
): string {
  if (typeof value !== "string") {
    throw new Error(`${label} is invalid or exceeds ${maximumBytes} bytes`);
  }
  assertUnicodeScalarText(value, label);
  if (
    value.length === 0 || value.includes("\0") ||
    new TextEncoder().encode(value).byteLength > maximumBytes
  ) {
    throw new Error(`${label} is invalid or exceeds ${maximumBytes} bytes`);
  }
  return value;
}

function requireLazyTreeInteger(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new Error(`${label} must be an integer between ${minimum} and ${maximum}`);
  }
  return Number(value);
}

function validateLazyTreeContent(
  value: unknown,
  minimumTransports = 1,
): LazyTreeContent {
  const initial = value as Record<string, unknown> | null;
  const hasSource = typeof initial === "object" && initial !== null &&
    !Array.isArray(initial) && initial.source !== undefined;
  const hasModePolicy = typeof initial === "object" && initial !== null &&
    !Array.isArray(initial) && initial.modePolicy !== undefined;
  const hasMaterialization = typeof initial === "object" && initial !== null &&
    !Array.isArray(initial) && initial.materialization !== undefined;
  const record = exactLazyTreeRecord(value, [
    "decoder",
    "mediaType",
    "sha256",
    "bytes",
    "expandedBytes",
    "sourceEntryCount",
    "transports",
    ...(hasModePolicy ? ["modePolicy"] : []),
    ...(hasSource ? ["source"] : []),
    ...(hasMaterialization ? ["materialization"] : []),
  ], "Lazy tree content");
  const expectedMediaType = record.decoder === "zip-v1"
    ? "application/zip"
    : record.decoder === "tar-gzip-v1"
      ? "application/vnd.oci.image.layer.v1.tar+gzip"
      : null;
  if (expectedMediaType === null || record.mediaType !== expectedMediaType) {
    throw new Error("Lazy tree decoder and media type are inconsistent");
  }
  const integrity = validateLazyArchiveIntegrity({
    sha256: record.sha256,
    bytes: record.bytes,
  });
  if (!integrity) throw new Error("Lazy tree integrity is required");
  const transports = requireLazyTreeArray(
    record.transports,
    "Lazy tree transports",
    minimumTransports,
    VFS_DEFERRED_TREE_LIMITS.maxTransportsPerTree,
  ).map((url, index) =>
    requireLazyTreeString(
      url,
      `Lazy tree transport ${index}`,
      MAX_LAZY_TREE_STRING_BYTES,
    )
  );
  if (new Set(transports).size !== transports.length) {
    throw new Error("Lazy tree transports contain duplicates");
  }
  const expandedBytes = requireLazyTreeInteger(
    record.expandedBytes,
    "Lazy tree expanded byte count",
    0,
    MAX_LAZY_EXPANDED_BYTES,
  );
  const sourceEntryCount = requireLazyTreeInteger(
    record.sourceEntryCount,
    "Lazy tree source entry count",
    1,
    MAX_LAZY_TREE_ENTRIES,
  );
  const source = hasSource
    ? validateLazyTreeSourceInventory(record.source, record.decoder)
    : undefined;
  const materialization = hasMaterialization
    ? validateLazyTreeMaterializationPlan(record.materialization, source!)
    : undefined;
  const modePolicy = hasModePolicy ? record.modePolicy : undefined;
  if (
    modePolicy !== undefined &&
    (modePolicy !== "portable-posix-v1" || record.decoder !== "zip-v1" || hasSource)
  ) {
    throw new Error("Lazy tree mode policy is invalid for its decoder");
  }
  if (source !== undefined && source.entries.length !== sourceEntryCount) {
    throw new Error("Lazy tree source inventory count differs from its content");
  }
  return {
    decoder: record.decoder as LazyTreeDecoder,
    mediaType: expectedMediaType,
    sha256: integrity.sha256,
    bytes: integrity.bytes,
    expandedBytes,
    sourceEntryCount,
    transports,
    ...(modePolicy === undefined ? {} : { modePolicy }),
    ...(source === undefined ? {} : { source }),
    ...(materialization === undefined ? {} : { materialization }),
  };
}

function summarizeSerializedDeferredTreeCollection(
  serialized: readonly SerializedLazyArchiveEntry[],
): VfsDeferredTreeUsage {
  const usage: VfsDeferredTreeUsage = {
    groups: serialized.length,
    archiveBytes: 0,
    expandedBytes: 0,
    payloadBytes: 0,
    entries: 0,
  };
  for (const group of serialized) {
    if (group.content === undefined || group.inventory === undefined) continue;
    usage.archiveBytes += group.content.bytes;
    usage.expandedBytes += group.content.expandedBytes;
    usage.payloadBytes += group.inventory
      .filter((entry) => entry.type === "file")
      .reduce((total, entry) => total + entry.size, 0);
    usage.entries += group.inventory.length +
      (group.content.source?.entries.length ?? 0);
  }
  return usage;
}

function validateDeferredTreeUsage(usage: VfsDeferredTreeUsage): void {
  assertVfsDeferredTreeCollectionUsage(
    usage,
    "Serialized lazy tree collection",
  );
}

function validateSerializedDeferredTreeCollection(
  serialized: readonly SerializedLazyArchiveEntry[],
): void {
  validateDeferredTreeUsage(summarizeSerializedDeferredTreeCollection(serialized));
}

function validateSerializedLazyAtomicCohorts(
  serialized: readonly SerializedLazyArchiveEntry[],
): void {
  const cohorts = new Map<string, {
    expectedCount: number;
    cohortSha256: string;
    members: Set<string>;
    descriptors: Set<string>;
  }>();
  for (const tree of serialized) {
    const membership = tree.activation?.atomicGroup;
    if (membership === undefined) continue;
    if (!isSealedLazyAtomicMembership(membership)) {
      throw new Error(
        `Serialized lazy atomic activation group ${membership.id} is unsealed`,
      );
    }
    let cohort = cohorts.get(membership.id);
    if (cohort === undefined) {
      cohort = {
        expectedCount: membership.expectedCount,
        cohortSha256: membership.cohortSha256,
        members: new Set(),
        descriptors: new Set(),
      };
      cohorts.set(membership.id, cohort);
    } else if (
      cohort.expectedCount !== membership.expectedCount ||
      cohort.cohortSha256 !== membership.cohortSha256
    ) {
      throw new Error(
        `Serialized lazy atomic activation group ${membership.id} has inconsistent seals`,
      );
    }
    if (
      cohort.members.has(membership.member) ||
      cohort.descriptors.has(membership.descriptorSha256)
    ) {
      throw new Error(
        `Serialized lazy atomic activation group ${membership.id} duplicates a member`,
      );
    }
    cohort.members.add(membership.member);
    cohort.descriptors.add(membership.descriptorSha256);
  }
  for (const [id, cohort] of cohorts) {
    if (cohort.members.size !== cohort.expectedCount) {
      throw new Error(
        `Serialized lazy atomic activation group ${id} has ` +
          `${cohort.members.size} of ${cohort.expectedCount} members`,
      );
    }
  }
}

/**
 * Revalidate producer-owned records after reconciling them with SharedFS.
 *
 * WHY: another mounted worker can replace or unlink a registered stub without
 * updating this instance's JavaScript metadata. Reconciliation intentionally
 * drops those stale identities. A sealed cohort must then fail closed instead
 * of exporting a syntactically valid but incomplete image that cannot restore.
 */
function validateCompleteSerializedLazyArchiveCollection(
  serialized: readonly SerializedLazyArchiveEntry[],
): void {
  for (const [index, tree] of serialized.entries()) {
    if (
      tree.kind === SERIALIZED_DEFERRED_TREE_V1_KIND ||
      tree.kind === SERIALIZED_DEFERRED_TREE_V2_KIND ||
      tree.kind === SERIALIZED_DEFERRED_TREE_V3_KIND
    ) {
      validateSerializedGenericTree(tree, tree.kind);
    } else if (tree.kind === SERIALIZED_LEGACY_ARCHIVE_KIND) {
      validateSerializedLegacyArchive(tree, false);
    } else {
      throw new Error(
        `Serialized lazy archive group ${index} has an unsupported kind`,
      );
    }
  }
  validateSerializedDeferredTreeCollection(serialized);
  validateSerializedLazyAtomicCohorts(serialized);
}

function validateLazyTreeSourceInventory(
  value: unknown,
  decoder: unknown,
): LazyTreeSourceInventory {
  if (decoder !== "zip-v1" && decoder !== "tar-gzip-v1") {
    throw new Error("Lazy tree source inventory requires a supported archive decoder");
  }
  const record = exactLazyTreeRecord(
    value,
    ["schema", "kind", "entries"],
    "Lazy tree source inventory",
  );
  if (record.schema !== 1 || record.kind !== "archive-source-inventory-v1") {
    throw new Error("Lazy tree source inventory has an unsupported identity");
  }
  const byPath = new Map<string, LazyTreeSourceEntry>();
  const entries = requireLazyTreeArray(
    record.entries,
    "Lazy tree source entries",
    1,
    MAX_LAZY_TREE_ENTRIES,
  ).map((value, index) => {
    const initial = value as Record<string, unknown> | null;
    const type = typeof initial === "object" && initial !== null && !Array.isArray(initial)
      ? initial.type
      : undefined;
    const keys = type === "directory" || type === "file"
      ? ["sourcePath", "type", "mode", "size"]
      : type === "symlink" || type === "hardlink"
        ? ["sourcePath", "type", "mode", "size", "target"]
        : null;
    if (keys === null) throw new Error(`Lazy tree source entry ${index} has invalid type`);
    const entry = exactLazyTreeRecord(value, keys, `Lazy tree source entry ${index}`);
    const sourcePath = requireCanonicalTreePath(
      entry.sourcePath,
      false,
      `Lazy tree source entry ${index} path`,
    );
    if (byPath.has(sourcePath)) {
      throw new Error(`Lazy tree source inventory duplicates ${sourcePath}`);
    }
    const mode = requireLazyTreeInteger(
      entry.mode,
      `Lazy tree source entry ${sourcePath} mode`,
      0,
      FILE_MODES.S_MODE_BITS,
    );
    const size = requireLazyTreeInteger(
      entry.size,
      `Lazy tree source entry ${sourcePath} size`,
      0,
      MAX_LAZY_PAYLOAD_BYTES,
    );
    let target: string | undefined;
    if (type === "directory" || type === "symlink" || type === "hardlink") {
      if (size !== 0) {
        throw new Error(`Lazy tree source ${sourcePath} has payload for ${String(type)}`);
      }
    }
    if (type === "symlink") {
      target = requireLazyTreeString(
        entry.target,
        `Lazy tree source symlink ${sourcePath} target`,
        MAX_LAZY_TREE_SYMLINK_TARGET_BYTES,
      );
    } else if (type === "hardlink") {
      target = requireCanonicalTreePath(
        entry.target,
        false,
        `Lazy tree source hardlink ${sourcePath} target`,
      );
    }
    const result: LazyTreeSourceEntry = {
      sourcePath,
      type: type as LazyTreeSourceEntry["type"],
      mode,
      size,
      ...(target === undefined ? {} : { target }),
    };
    byPath.set(sourcePath, result);
    return result;
  });
  const paths = entries.map((entry) => entry.sourcePath);
  if (paths.some((path, index) =>
    index > 0 && compareUnicodeScalarText(paths[index - 1]!, path) >= 0
  )) {
    throw new Error("Lazy tree source inventory is not in canonical path order");
  }
  return { schema: 1, kind: "archive-source-inventory-v1", entries };
}

function resolveLazyTreeSourceHardlinks(
  entries: readonly LazyTreeSourceEntry[],
): Map<string, LazyTreeSourceEntry> {
  const byPath = new Map(entries.map((entry) => [entry.sourcePath, entry]));
  const canonicalByPath = new Map<string, LazyTreeSourceEntry>();
  for (const start of entries) {
    if (start.type !== "hardlink" || canonicalByPath.has(start.sourcePath)) continue;
    const chain: LazyTreeSourceEntry[] = [];
    const seen = new Set<string>();
    let current = start;
    let canonical: LazyTreeSourceEntry | undefined;
    while (current.type === "hardlink") {
      canonical = canonicalByPath.get(current.sourcePath);
      if (canonical !== undefined) break;
      if (seen.has(current.sourcePath)) {
        throw new Error(`Lazy tree source hardlink cycle includes ${current.sourcePath}`);
      }
      seen.add(current.sourcePath);
      chain.push(current);
      const target = byPath.get(current.target!);
      if (target === undefined) {
        throw new Error(`Lazy tree source hardlink ${current.sourcePath} target is absent`);
      }
      if (target.type !== "file" && target.type !== "hardlink") {
        throw new Error(`Lazy tree source hardlink ${current.sourcePath} target is not regular`);
      }
      current = target;
    }
    if (canonical === undefined) canonical = current;
    for (const link of chain) canonicalByPath.set(link.sourcePath, canonical);
  }
  return canonicalByPath;
}

function requireCanonicalTreePath(
  path: unknown,
  absolute: boolean,
  label: string,
  allowAbsoluteRoot = false,
): string {
  if (
    typeof path !== "string" ||
    path.length === 0 ||
    new TextEncoder().encode(path).byteLength > MAX_LAZY_TREE_PATH_BYTES ||
    path.includes("\0") ||
    path.includes("\\") ||
    path.startsWith("/") !== absolute
  ) {
    throw new Error(`${label} is not a canonical ${absolute ? "absolute" : "relative"} path`);
  }
  if (allowAbsoluteRoot && absolute && path === "/") return path;
  const segments = path.slice(absolute ? 1 : 0).split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error(`${label} has an unsafe path segment`);
  }
  return path;
}

interface ValidatedLazyTreeDefinition {
  content: LazyTreeContent;
  entries: LazyTreeRegistrationEntry[];
  mountPrefix: string;
  activation: LazyTreeActivation;
  canonicalByGroup: Map<string, LazyTreeRegistrationEntry>;
}

function validateLazyAtomicGroupMembership(
  value: unknown,
): LazyAtomicGroupMembership {
  const initial = typeof value === "object" && value !== null &&
      !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
  const hasSeal = initial !== null &&
    (
      Object.hasOwn(initial, "descriptorSha256") ||
      Object.hasOwn(initial, "expectedCount") ||
      Object.hasOwn(initial, "cohortSha256")
    );
  const record = exactLazyTreeRecord(
    value,
    hasSeal
      ? [
          "id",
          "member",
          "descriptorSha256",
          "expectedCount",
          "cohortSha256",
        ]
      : ["id", "member"],
    "Lazy tree atomic activation membership",
  );
  const id = requireLazyTreeString(
    record.id,
    "Lazy tree atomic activation group",
    MAX_LAZY_TREE_ATOMIC_GROUP_BYTES,
  );
  const member = requireLazyTreeString(
    record.member,
    "Lazy tree atomic activation member",
    MAX_LAZY_TREE_ATOMIC_GROUP_BYTES,
  );
  if (
    !/^[a-z0-9][a-z0-9:._-]*$/.test(id) ||
    !/^[a-z0-9][a-z0-9:+._/-]*$/.test(member) ||
    member.includes("//") ||
    member.endsWith("/")
  ) {
    throw new Error("Lazy tree atomic activation membership is invalid");
  }
  if (!hasSeal) return { id, member };
  const descriptorSha256 = requireLazyTreeString(
    record.descriptorSha256,
    "Lazy tree atomic member descriptor digest",
    64,
  );
  const cohortSha256 = requireLazyTreeString(
    record.cohortSha256,
    "Lazy tree atomic cohort digest",
    64,
  );
  if (!SHA256_RE.test(descriptorSha256) || !SHA256_RE.test(cohortSha256)) {
    throw new Error("Lazy tree atomic activation digest is invalid");
  }
  return {
    id,
    member,
    descriptorSha256,
    expectedCount: requireLazyTreeInteger(
      record.expectedCount,
      "Lazy tree atomic activation expected member count",
      1,
      MAX_LAZY_TREE_GROUPS,
    ),
    cohortSha256,
  };
}

function isSealedLazyAtomicMembership(
  membership: LazyAtomicGroupMembership,
): membership is Required<LazyAtomicGroupMembership> {
  return membership.descriptorSha256 !== undefined &&
    membership.expectedCount !== undefined &&
    membership.cohortSha256 !== undefined;
}

function validateLazyTreeRegistrationOwner(
  value: unknown,
): LazyTreeRegistrationOwner {
  const record = exactLazyTreeRecord(
    value,
    ["uid", "gid"],
    "Lazy tree registration owner",
  );
  return {
    uid: requireLazyTreeInteger(
      record.uid,
      "Lazy tree registration owner uid",
      0,
      MAX_LAZY_TREE_OWNER_ID,
    ),
    gid: requireLazyTreeInteger(
      record.gid,
      "Lazy tree registration owner gid",
      0,
      MAX_LAZY_TREE_OWNER_ID,
    ),
  };
}

function validateLazyTreeDefinition(
  contentValue: unknown,
  entriesValue: unknown,
  mountPrefixValue: unknown,
  activationValue: unknown,
  minimumTransports = 1,
): ValidatedLazyTreeDefinition {
  const content = validateLazyTreeContent(contentValue, minimumTransports);
  const mountPrefix = normalizeLazyArchiveMountPrefix(mountPrefixValue);
  const activationFields = [
    "mode",
    "capabilities",
    "roots",
    ...(typeof activationValue === "object" &&
        activationValue !== null &&
        !Array.isArray(activationValue) &&
        Object.hasOwn(activationValue, "atomicGroup")
      ? ["atomicGroup"]
      : []),
  ];
  const activationRecord = exactLazyTreeRecord(
    activationValue,
    activationFields,
    "Lazy tree activation",
  );
  if (
    activationRecord.mode !== "boot-prefetch" &&
    activationRecord.mode !== "first-use"
  ) {
    throw new Error("Lazy tree activation mode is invalid");
  }
  const capabilities = requireLazyTreeArray(
    activationRecord.capabilities,
    "Lazy tree activation capabilities",
    1,
    MAX_LAZY_TREE_CAPABILITIES,
  ).map((capability, index) => {
    const text = requireLazyTreeString(
      capability,
      `Lazy tree activation capability ${index}`,
      VFS_DEFERRED_TREE_LIMITS.maxActivationCapabilityBytes,
    );
    if (!/^[a-z0-9][a-z0-9:._-]*$/.test(text)) {
      throw new Error(`Lazy tree activation capability ${index} is invalid`);
    }
    return text;
  });
  const roots = requireLazyTreeArray(
    activationRecord.roots,
    "Lazy tree activation roots",
    1,
    MAX_LAZY_TREE_ACTIVATION_ROOTS,
  ).map((root, index) =>
    requireCanonicalTreePath(
      root,
      true,
      `Lazy tree activation root ${index}`,
      true,
    )
  );
  if (
    new Set(capabilities).size !== capabilities.length ||
    new Set(roots).size !== roots.length
  ) {
    throw new Error("Lazy tree activation contains duplicates");
  }
  const atomicGroup = activationRecord.atomicGroup === undefined
    ? undefined
    : validateLazyAtomicGroupMembership(activationRecord.atomicGroup);
  if (
    atomicGroup !== undefined &&
    activationRecord.mode !== "first-use"
  ) {
    throw new Error(
      "Lazy tree atomic activation group requires a valid first-use identity",
    );
  }
  const activation: LazyTreeActivation = {
    mode: activationRecord.mode,
    capabilities,
    roots,
    ...(atomicGroup === undefined ? {} : { atomicGroup }),
  };

  const rawEntries = requireLazyTreeArray(
    entriesValue,
    "Lazy tree inventory",
    1,
    MAX_LAZY_TREE_ENTRIES,
  );
  const entries: LazyTreeRegistrationEntry[] = [];
  const byPath = new Map<string, LazyTreeRegistrationEntry>();
  const sourceEntries = new Map<string, LazyTreeRegistrationEntry>();
  const completeSources = content.source === undefined
    ? undefined
    : new Map(content.source.entries.map((entry) => [entry.sourcePath, entry]));
  const canonicalSourceByPath = content.source === undefined
    ? undefined
    : resolveLazyTreeSourceHardlinks(content.source.entries);
  const transformByCanonicalSource = new Map(
    content.materialization?.transforms.map((transform) => [
      transform.sourcePath,
      transform,
    ]) ?? [],
  );
  let decodedPayloadBytes = 0;
  for (const [index, value] of rawEntries.entries()) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error(`Lazy tree entry ${index} must be an object`);
    }
    const type = (value as Record<string, unknown>).type;
    const keys = type === "directory"
      ? ["vfsPath", "sourcePath", "type", "mode", "size"]
      : type === "file"
        ? ["vfsPath", "sourcePath", "type", "mode", "size", "inodeGroup"]
        : type === "symlink"
          ? ["vfsPath", "sourcePath", "type", "mode", "size", "target"]
          : type === "hardlink"
            ? [
              "vfsPath",
              "sourcePath",
              "type",
              "mode",
              "size",
              "target",
              "inodeGroup",
            ]
            : null;
    if (!keys) throw new Error(`Lazy tree entry ${index} has an invalid type`);
    const record = exactLazyTreeRecord(
      value,
      [...keys, ...(completeSources === undefined ? [] : ["materialization"])],
      `Lazy tree entry ${index}`,
    );
    const vfsPath = requireCanonicalTreePath(
      record.vfsPath,
      true,
      `Lazy tree entry ${index} VFS path`,
    );
    const sourcePath = requireCanonicalTreePath(
      record.sourcePath,
      false,
      `Lazy tree entry ${index} source path`,
    );
    const materialization = completeSources === undefined
      ? undefined
      : record.materialization;
    if (
      completeSources !== undefined &&
      materialization !== "archive" &&
      materialization !== "archive-copy" &&
      materialization !== "archive-copy-mode" &&
      materialization !== "descriptor"
    ) {
      throw new Error(`Lazy tree entry ${vfsPath} has invalid materialization provenance`);
    }
    if (
      mountPrefix !== "/" && vfsPath !== mountPrefix &&
      !vfsPath.startsWith(`${mountPrefix}/`)
    ) {
      throw new Error(`Lazy tree entry ${vfsPath} escapes its mount prefix`);
    }
    if (byPath.has(vfsPath)) {
      throw new Error(`Lazy tree duplicates VFS path ${vfsPath}`);
    }
    const mode = requireLazyTreeInteger(
      record.mode,
      `Lazy tree entry ${vfsPath} mode`,
      0,
      FILE_MODES.S_MODE_BITS,
    );
    const size = requireLazyTreeInteger(
      record.size,
      `Lazy tree entry ${vfsPath} size`,
      0,
      MAX_LAZY_PAYLOAD_BYTES,
    );
    let target: string | undefined;
    let inodeGroup: string | undefined;
    if (type === "directory") {
      if (size !== 0) {
        throw new Error(`Lazy tree directory ${vfsPath} has nonzero size`);
      }
    } else if (type === "symlink") {
      target = requireLazyTreeString(
        record.target,
        `Lazy tree symlink ${vfsPath} target`,
        MAX_LAZY_TREE_SYMLINK_TARGET_BYTES,
      );
      if (new TextEncoder().encode(target).byteLength !== size) {
        throw new Error(`Lazy tree symlink ${vfsPath} size differs from its target`);
      }
    } else {
      inodeGroup = requireLazyTreeString(
        record.inodeGroup,
        `Lazy tree entry ${vfsPath} inode group`,
        MAX_LAZY_TREE_PATH_BYTES,
      );
      if (type === "hardlink") {
        target = requireCanonicalTreePath(
          record.target,
          true,
          `Lazy tree hardlink ${vfsPath} target`,
        );
      }
    }
    if (type !== "hardlink") {
      decodedPayloadBytes += size;
      if (decodedPayloadBytes > MAX_LAZY_PAYLOAD_BYTES) {
        throw new Error("Lazy tree inventory exceeds the expansion limit");
      }
    }
    const entry: LazyTreeRegistrationEntry = {
      vfsPath,
      sourcePath,
      ...(materialization === undefined ? {} : {
        materialization: materialization as LazyTreeRegistrationEntry["materialization"],
      }),
      type: type as LazyTreeRegistrationEntry["type"],
      mode,
      size,
      ...(target === undefined ? {} : { target }),
      ...(inodeGroup === undefined ? {} : { inodeGroup }),
    };
    if (completeSources === undefined) {
      const priorSource = sourceEntries.get(sourcePath);
      if (priorSource) {
        if (
          content.decoder !== "zip-v1" || entry.type !== "hardlink" ||
          priorSource.inodeGroup !== entry.inodeGroup
        ) {
          throw new Error(`Lazy tree duplicates source path ${sourcePath}`);
        }
      } else {
        if (content.decoder === "zip-v1" && entry.type === "hardlink") {
          throw new Error(
            `Lazy ZIP hardlink ${vfsPath} does not reuse a canonical source path`,
          );
        }
        sourceEntries.set(sourcePath, entry);
      }
    } else if (entry.materialization === "descriptor") {
      if (entry.type !== "directory" && entry.type !== "symlink") {
        throw new Error(`Lazy tree descriptor entry ${vfsPath} is not structural`);
      }
      if (completeSources.has(sourcePath)) {
        throw new Error(`Lazy tree descriptor entry ${vfsPath} impersonates a source member`);
      }
    } else {
      const source = completeSources.get(sourcePath);
      if (source === undefined) {
        throw new Error(`Lazy tree entry ${vfsPath} names absent source ${sourcePath}`);
      }
      if (
        entry.materialization === "archive-copy" ||
        entry.materialization === "archive-copy-mode"
      ) {
        if (
          entry.type !== "file" || source.type !== "file" ||
          (entry.materialization === "archive-copy" && entry.mode !== source.mode)
        ) {
          throw new Error(`Lazy tree archive copy ${vfsPath} differs from its source`);
        }
      } else if (
        source.type !== entry.type ||
        (entry.type === "symlink" && source.target !== entry.target) ||
        (entry.type !== "hardlink" && source.mode !== entry.mode)
      ) {
        throw new Error(`Lazy tree archive entry ${vfsPath} differs from its source`);
      }
    }
    entries.push(entry);
    byPath.set(vfsPath, entry);
  }

  for (const entry of entries) {
    const components = entry.vfsPath.split("/").filter(Boolean);
    for (let length = 1; length < components.length; length += 1) {
      const ancestorPath = `/${components.slice(0, length).join("/")}`;
      const ancestor = byPath.get(ancestorPath);
      if (ancestor && ancestor.type !== "directory") {
        throw new Error(
          `Lazy tree entry ${entry.vfsPath} descends through non-directory ${ancestorPath}`,
        );
      }
    }
  }
  const graph = resolveHardlinkGraph(
    entries.map((entry) => ({
      path: entry.vfsPath,
      type: entry.type,
      mode: entry.mode,
      size: entry.size,
      target: entry.target,
      inodeGroup: entry.inodeGroup,
    })),
    "Lazy tree",
  );
  if (completeSources !== undefined) {
    const referencedCanonicalSources = new Set<string>();
    for (const entry of entries) {
      if (
        entry.materialization === "descriptor" ||
        (entry.type !== "file" && entry.type !== "hardlink")
      ) continue;
      const source = completeSources.get(entry.sourcePath)!;
      const canonical = source.type === "file"
        ? source
        : canonicalSourceByPath!.get(source.sourcePath);
      if (canonical?.type === "file") {
        referencedCanonicalSources.add(canonical.sourcePath);
      }
      const transform = canonical?.type === "file"
        ? transformByCanonicalSource.get(canonical.sourcePath)
        : undefined;
      if (
        canonical?.type !== "file" ||
        entry.size !== (transform?.output.bytes ?? canonical.size)
      ) {
        throw new Error(`Lazy tree archive entry ${entry.vfsPath} differs from its source`);
      }
    }
    for (const sourcePath of transformByCanonicalSource.keys()) {
      if (!referencedCanonicalSources.has(sourcePath)) {
        throw new Error(
          `Lazy tree materialization transform ${sourcePath} has no destination`,
        );
      }
    }
    for (const entry of entries) {
      if (
        entry.type !== "hardlink" ||
        entry.materialization !== "archive"
      ) continue;
      const source = completeSources.get(entry.sourcePath)!;
      const target = byPath.get(entry.target!);
      const regularSource = canonicalSourceByPath!.get(source.sourcePath);
      if (
        source.target !== target?.sourcePath ||
        regularSource?.type !== "file" ||
        regularSource.mode !== entry.mode ||
        target?.mode !== entry.mode
      ) {
        throw new Error(`Lazy tree hardlink ${entry.vfsPath} differs from its source`);
      }
    }
  }
  if (
    content.sourceEntryCount !==
      (completeSources === undefined ? sourceEntries.size : completeSources.size)
  ) {
    throw new Error("Lazy tree source entry count differs from its inventory");
  }
  if (
    (content.source === undefined && content.expandedBytes < decodedPayloadBytes) ||
    (content.decoder === "zip-v1" && content.expandedBytes !== decodedPayloadBytes)
  ) {
    throw new Error("Lazy tree expanded byte count differs from its inventory");
  }
  for (const root of activation.roots) {
    if (
      root !== "/" &&
      !entries.some((entry) =>
        entry.vfsPath === root || entry.vfsPath.startsWith(`${root}/`)
      )
    ) {
      throw new Error(`Lazy tree activation root ${root} is not owned by its inventory`);
    }
  }
  const canonicalByGroup = new Map<string, LazyTreeRegistrationEntry>();
  for (const entry of entries) {
    if (entry.type === "file") canonicalByGroup.set(entry.inodeGroup!, entry);
  }
  if (canonicalByGroup.size !== graph.canonicalByGroup.size) {
    throw new Error("Lazy tree regular inode inventory is inconsistent");
  }
  return { content, entries, mountPrefix, activation, canonicalByGroup };
}

function lazyTreeInventoryIdentityKey(value: {
  sourcePath?: string;
  type?: string;
  inodeGroup?: string;
  target?: string;
}): string {
  return JSON.stringify([
    value.sourcePath,
    value.type,
    value.inodeGroup,
    value.target,
  ]);
}

function validateSerializedLegacyArchive(
  value: unknown,
  allowUntaggedSnapshot: boolean,
): SerializedLazyArchiveEntry {
  const record = boundedLazyTreeRecord(value, [
    "kind",
    "content",
    "url",
    "mountPrefix",
    "integrity",
    "materialized",
    "entries",
  ], [
    "url",
    "mountPrefix",
    "materialized",
    "entries",
  ], "Serialized legacy lazy archive");
  if (record.kind === undefined) {
    if (!allowUntaggedSnapshot) {
      throw new Error("Serialized lazy archive is missing its kind discriminator");
    }
  } else if (record.kind !== SERIALIZED_LEGACY_ARCHIVE_KIND) {
    throw new Error("Serialized legacy lazy archive has an unsupported kind");
  }
  const url = requireLazyTreeString(
    record.url,
    "Serialized legacy lazy archive URL",
    MAX_LAZY_TREE_STRING_BYTES,
  );
  const mountPrefix = normalizeLazyArchiveMountPrefix(record.mountPrefix);
  const integrity = validateLazyArchiveIntegrity(record.integrity);
  if (record.content !== undefined) {
    if (!allowUntaggedSnapshot || record.kind !== undefined) {
      throw new Error("Typed legacy lazy archives cannot carry generic content");
    }
    const legacyContent = validateLazyTreeContent(record.content);
    if (
      legacyContent.decoder !== "zip-v1" ||
      legacyContent.transports.length !== 1 ||
      legacyContent.transports[0] !== url ||
      !integrity || legacyContent.sha256 !== integrity.sha256 ||
      legacyContent.bytes !== integrity.bytes
    ) {
      throw new Error("Untagged legacy ZIP content identity is inconsistent");
    }
  }
  if (record.materialized !== false) {
    throw new Error("Serialized legacy lazy archive must describe pending content");
  }

  const paths = new Set<string>();
  const entries = requireLazyTreeArray(
    record.entries,
    "Serialized legacy lazy archive entries",
    1,
    MAX_LAZY_TREE_ENTRIES,
  ).map((value, index): SerializedLazyArchiveEntry["entries"][number] => {
    const entry = boundedLazyTreeRecord(value, [
      "vfsPath",
      "ino",
      "generation",
      "dataSequence",
      "size",
      "isSymlink",
      "deleted",
      "materialized",
      "archivePath",
      "sourcePath",
      "type",
      "inodeGroup",
      "target",
    ], [
      "vfsPath",
      "ino",
      "size",
      "isSymlink",
      "deleted",
    ], `Serialized legacy lazy archive entry ${index}`);
    const vfsPath = requireCanonicalTreePath(
      entry.vfsPath,
      true,
      `Serialized legacy lazy archive entry ${index} VFS path`,
    );
    if (paths.has(vfsPath)) {
      throw new Error(`Serialized legacy lazy archive duplicates path ${vfsPath}`);
    }
    paths.add(vfsPath);
    const ino = requireLazyTreeInteger(
      entry.ino,
      `Serialized legacy lazy archive entry ${vfsPath} inode`,
      1,
      Number.MAX_SAFE_INTEGER,
    );
    const generation = entry.generation === undefined
      ? undefined
      : requireLazyTreeInteger(
        entry.generation,
        `Serialized legacy lazy archive entry ${vfsPath} generation`,
        0,
        Number.MAX_SAFE_INTEGER,
      );
    const dataSequence = entry.dataSequence === undefined
      ? undefined
      : requireLazyTreeInteger(
        entry.dataSequence,
        `Serialized legacy lazy archive entry ${vfsPath} data sequence`,
        0,
        Number.MAX_SAFE_INTEGER,
      );
    const size = requireLazyTreeInteger(
      entry.size,
      `Serialized legacy lazy archive entry ${vfsPath} size`,
      0,
      MAX_LAZY_PAYLOAD_BYTES,
    );
    if (
      entry.isSymlink !== false || entry.deleted !== false ||
      (entry.materialized !== undefined && entry.materialized !== false)
    ) {
      throw new Error(
        `Serialized legacy lazy archive entry ${vfsPath} is not pending`,
      );
    }
    if (entry.type !== undefined && entry.type !== "file") {
      throw new Error(
        `Serialized legacy lazy archive entry ${vfsPath} has an invalid type`,
      );
    }
    const archivePath = entry.archivePath === undefined
      ? undefined
      : requireCanonicalTreePath(
        entry.archivePath,
        false,
        `Serialized legacy lazy archive entry ${vfsPath} archive path`,
      );
    const sourcePath = entry.sourcePath === undefined
      ? undefined
      : requireCanonicalTreePath(
        entry.sourcePath,
        false,
        `Serialized legacy lazy archive entry ${vfsPath} source path`,
      );
    const inodeGroup = entry.inodeGroup === undefined
      ? undefined
      : requireLazyTreeString(
        entry.inodeGroup,
        `Serialized legacy lazy archive entry ${vfsPath} inode group`,
        MAX_LAZY_TREE_PATH_BYTES,
      );
    if (entry.target !== undefined) {
      throw new Error(
        `Serialized legacy lazy archive entry ${vfsPath} has a link target`,
      );
    }
    return {
      vfsPath,
      ino,
      ...(generation === undefined ? {} : { generation }),
      ...(dataSequence === undefined ? {} : { dataSequence }),
      size,
      isSymlink: false,
      deleted: false,
      materialized: false,
      ...(archivePath === undefined ? {} : { archivePath }),
      ...(sourcePath === undefined ? {} : { sourcePath }),
      type: "file",
      ...(inodeGroup === undefined ? {} : { inodeGroup }),
    };
  });
  return {
    kind: SERIALIZED_LEGACY_ARCHIVE_KIND,
    url,
    mountPrefix,
    ...(integrity === undefined ? {} : { integrity }),
    materialized: false,
    entries,
  };
}

function validateSerializedGenericTree(
  value: unknown,
  expectedKind:
    | typeof SERIALIZED_DEFERRED_TREE_V1_KIND
    | typeof SERIALIZED_DEFERRED_TREE_V2_KIND
    | typeof SERIALIZED_DEFERRED_TREE_V3_KIND,
): SerializedLazyArchiveEntry {
  const record = exactLazyTreeRecord(value, [
    "kind",
    "content",
    "inventory",
    "activation",
    "url",
    "mountPrefix",
    "integrity",
    "materialized",
    "entries",
  ], "Serialized lazy tree");
  if (record.kind !== expectedKind) {
    throw new Error("Serialized lazy tree has an unsupported kind");
  }
  const definition = validateLazyTreeDefinition(
    record.content,
    record.inventory,
    record.mountPrefix,
    record.activation,
  );
  if (
    expectedKind !== SERIALIZED_DEFERRED_TREE_V3_KIND &&
    (
      (expectedKind === SERIALIZED_DEFERRED_TREE_V1_KIND) !==
        (definition.content.source === undefined)
    )
  ) {
    throw new Error(
      expectedKind === SERIALIZED_DEFERRED_TREE_V1_KIND
        ? "Serialized deferred-tree-v1 cannot contain complete source metadata"
        : "Serialized deferred-tree-v2 requires complete source metadata",
    );
  }
  const atomicMembership = definition.activation.atomicGroup;
  if (
    expectedKind === SERIALIZED_DEFERRED_TREE_V3_KIND
      ? atomicMembership === undefined ||
        !isSealedLazyAtomicMembership(atomicMembership)
      : atomicMembership !== undefined
  ) {
    throw new Error(
      expectedKind === SERIALIZED_DEFERRED_TREE_V3_KIND
        ? "Serialized deferred-tree-v3 requires a sealed atomic activation"
        : "Atomic activation requires serialized deferred-tree-v3",
    );
  }
  const url = requireLazyTreeString(
    record.url,
    "Serialized lazy tree URL",
    MAX_LAZY_TREE_STRING_BYTES,
  );
  if (url !== definition.content.transports[0]) {
    throw new Error("Serialized lazy tree URL differs from its primary transport");
  }
  const integrity = validateLazyArchiveIntegrity(record.integrity);
  if (
    !integrity || integrity.sha256 !== definition.content.sha256 ||
    integrity.bytes !== definition.content.bytes
  ) {
    throw new Error("Serialized lazy tree integrity differs from its content");
  }
  if (record.materialized !== false) {
    throw new Error("Serialized lazy tree must describe pending content");
  }

  const inventoryByPath = new Map(
    definition.entries.map((entry) => [entry.vfsPath, entry]),
  );
  const inventoryByIdentity = new Map(
    definition.entries.map((entry) => [
      lazyTreeInventoryIdentityKey(entry),
      entry,
    ]),
  );
  const pendingValues = requireLazyTreeArray(
    record.entries,
    "Serialized lazy tree entries",
    0,
    MAX_LAZY_TREE_ENTRIES,
  );
  const pendingPaths = new Set<string>();
  const pending = pendingValues.map((value, index) => {
    const entry = boundedLazyTreeRecord(value, [
      "vfsPath",
      "ino",
      "generation",
      "dataSequence",
      "size",
      "isSymlink",
      "deleted",
      "materialized",
      "archivePath",
      "sourcePath",
      "type",
      "inodeGroup",
      "target",
    ], [
      "vfsPath",
      "ino",
      "generation",
      "dataSequence",
      "size",
      "isSymlink",
      "deleted",
      "materialized",
      "archivePath",
      "sourcePath",
      "type",
      "inodeGroup",
    ], `Serialized lazy tree entry ${index}`);
    const vfsPath = requireCanonicalTreePath(
      entry.vfsPath,
      true,
      `Serialized lazy tree entry ${index} VFS path`,
    );
    if (pendingPaths.has(vfsPath)) {
      throw new Error(`Serialized lazy tree duplicates pending path ${vfsPath}`);
    }
    pendingPaths.add(vfsPath);
    const sourcePath = requireCanonicalTreePath(
      entry.sourcePath,
      false,
      `Serialized lazy tree entry ${index} source path`,
    );
    const archivePath = requireCanonicalTreePath(
      entry.archivePath,
      false,
      `Serialized lazy tree entry ${index} archive path`,
    );
    const inventoryAtPath = inventoryByPath.get(vfsPath);
    const inventoryEntry = inventoryByIdentity.get(lazyTreeInventoryIdentityKey({
      sourcePath,
      type: typeof entry.type === "string" ? entry.type : undefined,
      inodeGroup: typeof entry.inodeGroup === "string"
        ? entry.inodeGroup
        : undefined,
      target: typeof entry.target === "string" ? entry.target : undefined,
    })) ?? inventoryAtPath;
    if (
      !inventoryEntry ||
      (inventoryEntry.type !== "file" && inventoryEntry.type !== "hardlink") ||
      (inventoryAtPath?.inodeGroup !== undefined &&
        inventoryAtPath.inodeGroup !== inventoryEntry.inodeGroup)
    ) {
      throw new Error(
        `Serialized lazy tree entry ${vfsPath} is absent from its inventory`,
      );
    }
    const canonical = definition.canonicalByGroup.get(inventoryEntry.inodeGroup!);
    if (
      entry.type !== inventoryEntry.type ||
      entry.inodeGroup !== inventoryEntry.inodeGroup ||
      entry.size !== inventoryEntry.size ||
      archivePath !== canonical?.sourcePath ||
      entry.target !== inventoryEntry.target ||
      entry.isSymlink !== false || entry.deleted !== false ||
      entry.materialized !== false
    ) {
      throw new Error(
        `Serialized lazy tree entry ${vfsPath} disagrees with its inventory`,
      );
    }
    const ino = requireLazyTreeInteger(
      entry.ino,
      `Serialized lazy tree entry ${vfsPath} inode`,
      1,
      Number.MAX_SAFE_INTEGER,
    );
    const generation = requireLazyTreeInteger(
      entry.generation,
      `Serialized lazy tree entry ${vfsPath} generation`,
      0,
      Number.MAX_SAFE_INTEGER,
    );
    const dataSequence = requireLazyTreeInteger(
      entry.dataSequence,
      `Serialized lazy tree entry ${vfsPath} data sequence`,
      0,
      Number.MAX_SAFE_INTEGER,
    );
    return {
      vfsPath,
      ino,
      generation,
      dataSequence,
      size: inventoryEntry.size,
      isSymlink: false,
      deleted: false,
      materialized: false,
      archivePath,
      sourcePath,
      type: inventoryEntry.type,
      inodeGroup: inventoryEntry.inodeGroup,
      ...(inventoryEntry.target === undefined
        ? {}
        : { target: inventoryEntry.target }),
    };
  });
  for (const inventoryEntry of definition.entries) {
    if (
      definition.activation.atomicGroup !== undefined &&
      (inventoryEntry.type === "file" ||
        inventoryEntry.type === "hardlink") &&
      !pendingPaths.has(inventoryEntry.vfsPath)
    ) {
      throw new Error(
        `Serialized lazy tree omits pending path ${inventoryEntry.vfsPath}`,
      );
    }
  }
  return {
    kind: expectedKind,
    content: definition.content,
    inventory: definition.entries,
    activation: definition.activation,
    url,
    mountPrefix: definition.mountPrefix,
    integrity,
    materialized: false,
    entries: pending,
  };
}

async function sha256Hex(data: Uint8Array, label: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error(`${label} SHA-256 verification is unavailable`);
  }
  const copy = new Uint8Array(data.byteLength);
  copy.set(data);
  const digest = new Uint8Array(await subtle.digest("SHA-256", copy));
  return Array.from(digest, (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

async function assertLazyIntegrity(
  data: Uint8Array,
  kind: LazyDownloadKind,
  expected: LazyArchiveIntegrity | undefined,
): Promise<void> {
  if (expected === undefined) return;
  if (data.byteLength !== expected.bytes) {
    throw new Error(
      `Lazy ${kind} byte count ${data.byteLength} does not match ` +
        `expected ${expected.bytes}`,
    );
  }
  const actual = await sha256Hex(data, `Lazy ${kind}`);
  if (actual !== expected.sha256) {
    throw new Error(
      `Lazy ${kind} SHA-256 ${actual} does not match expected ${expected.sha256}`,
    );
  }
}

async function assertLazyTreeByteIdentity(
  data: Uint8Array,
  expected: LazyTreeByteIdentity,
  label: string,
): Promise<void> {
  if (data.byteLength !== expected.bytes) {
    throw new Error(
      `${label} byte count ${data.byteLength} does not match expected ` +
        `${expected.bytes}`,
    );
  }
  const actual = await sha256Hex(data, label);
  if (actual !== expected.sha256) {
    throw new Error(
      `${label} SHA-256 ${actual} does not match expected ${expected.sha256}`,
    );
  }
}

function lazyAtomicDescriptorIdentityBytesFromValues(
  content: LazyTreeContent,
  inventory: readonly LazyTreeRegistrationEntry[],
  mountPrefix: string,
  activation: LazyTreeActivation,
): Uint8Array {
  const membership = activation.atomicGroup;
  if (membership === undefined) {
    throw new Error("Lazy atomic member is missing its typed tree descriptor");
  }
  // WHY: V3 deliberately excludes transport locations from descriptor
  // identity because image composition rewrites mirrors after sealing. The
  // digest still binds the exact byte hash/size, decoder bounds, complete
  // source-to-namespace projection, and producer-assigned member identity.
  const descriptor = {
    schema: 1,
    content: {
      decoder: content.decoder,
      mediaType: content.mediaType,
      sha256: content.sha256,
      bytes: content.bytes,
      expandedBytes: content.expandedBytes,
      sourceEntryCount: content.sourceEntryCount,
      ...(content.modePolicy === undefined
        ? {}
        : { modePolicy: content.modePolicy }),
      ...(content.source === undefined ? {} : { source: content.source }),
      ...(content.materialization === undefined
        ? {}
        : { materialization: content.materialization }),
    },
    mountPrefix,
    inventory: [...inventory].sort((left, right) =>
      compareUnicodeScalarText(left.vfsPath, right.vfsPath)
    ),
    activation: {
      mode: activation.mode,
      capabilities: activation.capabilities,
      roots: activation.roots,
      atomicGroup: {
        id: membership.id,
        member: membership.member,
      },
    },
  };
  return new TextEncoder().encode(JSON.stringify(descriptor));
}

function lazyAtomicCohortIdentityBytes(
  id: string,
  members: readonly { member: string; descriptorSha256: string }[],
): Uint8Array {
  const canonicalMembers = members.map(({ member, descriptorSha256 }) => ({
    member,
    descriptorSha256,
  }));
  return new TextEncoder().encode(JSON.stringify({
    schema: 1,
    id,
    members: canonicalMembers.sort((left, right) =>
      left.member < right.member ? -1 : left.member > right.member ? 1 : 0
    ),
  }));
}

function equalLazyAtomicDescriptorBytes(
  left: Uint8Array,
  right: Uint8Array,
): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index++) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function immutableLazyTreeContent(
  content: LazyTreeContent,
  transportsValue: readonly string[] = content.transports,
): LazyTreeContent {
  const transports = [...transportsValue];
  Object.freeze(transports);
  const source = content.source === undefined
    ? undefined
    : {
      schema: 1 as const,
      kind: "archive-source-inventory-v1" as const,
      entries: content.source.entries.map((entry) =>
        Object.freeze({ ...entry })
      ),
    };
  if (source !== undefined) {
    Object.freeze(source.entries);
    Object.freeze(source);
  }
  const materialization = content.materialization === undefined
    ? undefined
    : immutableLazyTreeMaterializationPlan(content.materialization);
  return Object.freeze({
    decoder: content.decoder,
    mediaType: content.mediaType,
    sha256: content.sha256,
    bytes: content.bytes,
    expandedBytes: content.expandedBytes,
    sourceEntryCount: content.sourceEntryCount,
    transports,
    ...(content.modePolicy === undefined
      ? {}
      : { modePolicy: content.modePolicy }),
    ...(source === undefined ? {} : { source }),
    ...(materialization === undefined ? {} : { materialization }),
  });
}

function cloneLazyTreeMaterializationPlan(
  plan: LazyTreeMaterializationPlan,
): LazyTreeMaterializationPlan {
  return {
    schema: 1,
    kind: "archive-byte-transforms-v1",
    assertions: plan.assertions.map((assertion) => ({ ...assertion })),
    recipes: plan.recipes.map((recipe) => ({
      id: recipe.id,
      replacements: recipe.replacements.map((replacement) => ({ ...replacement })),
      rejectHex: [...recipe.rejectHex],
    })),
    transforms: plan.transforms.map((transform) => ({
      sourcePath: transform.sourcePath,
      recipe: transform.recipe,
      input: { ...transform.input },
      output: { ...transform.output },
    })),
  };
}

function immutableLazyTreeMaterializationPlan(
  plan: LazyTreeMaterializationPlan,
): LazyTreeMaterializationPlan {
  const copy = cloneLazyTreeMaterializationPlan(plan);
  for (const assertion of copy.assertions) Object.freeze(assertion);
  Object.freeze(copy.assertions);
  for (const recipe of copy.recipes) {
    for (const replacement of recipe.replacements) Object.freeze(replacement);
    Object.freeze(recipe.replacements);
    Object.freeze(recipe.rejectHex);
    Object.freeze(recipe);
  }
  Object.freeze(copy.recipes);
  for (const transform of copy.transforms) {
    Object.freeze(transform.input);
    Object.freeze(transform.output);
    Object.freeze(transform);
  }
  Object.freeze(copy.transforms);
  return Object.freeze(copy);
}

function cloneLazyTreeContent(content: LazyTreeContent): LazyTreeContent {
  return {
    decoder: content.decoder,
    mediaType: content.mediaType,
    sha256: content.sha256,
    bytes: content.bytes,
    expandedBytes: content.expandedBytes,
    sourceEntryCount: content.sourceEntryCount,
    transports: [...content.transports],
    ...(content.modePolicy === undefined
      ? {}
      : { modePolicy: content.modePolicy }),
    ...(content.source === undefined
      ? {}
      : {
        source: {
          schema: 1,
          kind: "archive-source-inventory-v1",
          entries: content.source.entries.map((entry) => ({ ...entry })),
        },
      }),
    ...(content.materialization === undefined
      ? {}
      : {
        materialization: cloneLazyTreeMaterializationPlan(
          content.materialization,
        ),
      }),
  };
}

function immutableLazyTreeInventory(
  inventory: readonly LazyTreeRegistrationEntry[],
): LazyTreeRegistrationEntry[] {
  const copy = inventory.map((entry) => Object.freeze({ ...entry }));
  Object.freeze(copy);
  return copy;
}

function immutableLazyTreeActivation(
  activation: LazyTreeActivation,
  id: string,
  member: string,
): LazyTreeActivation {
  const capabilities = [...activation.capabilities];
  const roots = [...activation.roots];
  Object.freeze(capabilities);
  Object.freeze(roots);
  return Object.freeze({
    mode: activation.mode,
    capabilities,
    roots,
    atomicGroup: Object.freeze({ id, member }),
  });
}

function immutableOrdinaryLazyTreeActivation(
  activation: LazyTreeActivation,
): LazyTreeActivation {
  const capabilities = [...activation.capabilities];
  const roots = [...activation.roots];
  Object.freeze(capabilities);
  Object.freeze(roots);
  return Object.freeze({
    mode: activation.mode,
    capabilities,
    roots,
  });
}

function immutableLazyTreeDefinitionSnapshot(
  content: LazyTreeContent,
  inventory: readonly LazyTreeRegistrationEntry[],
  activation: LazyTreeActivation,
  url: string,
  mountPrefix: string,
  integrity: LazyArchiveIntegrity,
  entries: readonly LazyAtomicSnapshotEntry[],
  materialized: boolean,
): LazyTreeDefinitionSnapshot {
  const immutableEntries = entries.map((entry) =>
    Object.freeze({ ...entry })
  );
  Object.freeze(immutableEntries);
  return Object.freeze({
    content: immutableLazyTreeContent(content),
    inventory: immutableLazyTreeInventory(inventory),
    activation: immutableOrdinaryLazyTreeActivation(activation),
    url,
    mountPrefix,
    integrity: Object.freeze({ ...integrity }),
    entries: immutableEntries,
    materialized,
  });
}

function replaceImmutableLazyTreeRuntimeState(
  definition: LazyTreeDefinitionSnapshot,
  entries: readonly LazyAtomicSnapshotEntry[],
  materialized: boolean,
): LazyTreeDefinitionSnapshot {
  const immutableEntries = entries.map((entry) =>
    Object.freeze({ ...entry })
  );
  Object.freeze(immutableEntries);
  return Object.freeze({
    ...definition,
    entries: immutableEntries,
    materialized,
  });
}

function lazyTreeSnapshotEntries(
  entries: ReadonlyMap<string, LazyArchiveFileEntry>,
): LazyAtomicSnapshotEntry[] {
  return Array.from(entries, ([vfsPath, entry]) => ({
    vfsPath,
    ...entry,
  }));
}

function cloneLazyTreeSnapshotEntryMap(
  entries: readonly LazyAtomicSnapshotEntry[],
): Map<string, LazyArchiveFileEntry> {
  return new Map(entries.map(({ vfsPath, ...entry }) => [vfsPath, entry]));
}

function sealedLazyTreeActivation(
  snapshot: SealedLazyAtomicSnapshot,
): LazyTreeActivation {
  return {
    mode: snapshot.activation.mode,
    capabilities: [...snapshot.activation.capabilities],
    roots: [...snapshot.activation.roots],
    atomicGroup: {
      id: snapshot.id,
      member: snapshot.member,
      descriptorSha256: snapshot.descriptorSha256,
      expectedCount: snapshot.expectedCount,
      cohortSha256: snapshot.cohortSha256,
    },
  };
}

function equalLazyAtomicEntry(
  left: LazyArchiveFileEntry,
  right: LazyArchiveFileEntry,
): boolean {
  return left.ino === right.ino &&
    left.generation === right.generation &&
    left.dataSequence === right.dataSequence &&
    left.size === right.size &&
    left.isSymlink === right.isSymlink &&
    left.deleted === right.deleted &&
    left.materialized === right.materialized &&
    left.archivePath === right.archivePath &&
    left.sourcePath === right.sourcePath &&
    left.type === right.type &&
    left.inodeGroup === right.inodeGroup &&
    left.target === right.target;
}

function captureLazyAtomicSnapshotSource(
  group: LazyArchiveGroup,
  id: string,
  member: string,
): LazyAtomicSnapshotSource {
  const contentValue = group.content;
  const inventoryValue = group.inventory;
  const activationValue = group.activation;
  const integrityValue = group.integrity;
  const entriesValue = group.entries;
  const urlValue = group.url;
  const mountPrefixValue = group.mountPrefix;
  const materializedValue = group.materialized;
  const membership = activationValue?.atomicGroup;
  if (
    contentValue === undefined ||
    inventoryValue === undefined ||
    activationValue === undefined ||
    membership === undefined ||
    activationValue.mode !== "first-use" ||
    membership.id !== id ||
    membership.member !== member ||
    materializedValue
  ) {
    throw new Error(
      `Lazy atomic activation member ${member} changed before snapshot`,
    );
  }
  if (
    integrityValue?.sha256 !== contentValue.sha256 ||
    integrityValue?.bytes !== contentValue.bytes ||
    urlValue !== (contentValue.transports[0] ?? "")
  ) {
    throw new Error(
      `Lazy atomic activation member ${member} has inconsistent integrity`,
    );
  }

  const content = immutableLazyTreeContent(contentValue);
  const inventory = immutableLazyTreeInventory(inventoryValue);
  const activation = immutableLazyTreeActivation(
    activationValue,
    id,
    member,
  );
  const canonicalSourceByGroup = new Map<string, string>();
  for (const entry of inventory) {
    if (entry.type === "file") {
      canonicalSourceByGroup.set(entry.inodeGroup!, entry.sourcePath);
    }
  }
  const runtimeInventory = inventory.filter((entry) =>
    entry.type !== "directory"
  );
  if (entriesValue.size !== runtimeInventory.length) {
    throw new Error(
      `Lazy atomic activation member ${member} has inconsistent runtime entries`,
    );
  }
  const entries = runtimeInventory.map((inventoryEntry) => {
    const actual = entriesValue.get(inventoryEntry.vfsPath);
    const isSymlink = inventoryEntry.type === "symlink";
    const archivePath = isSymlink
      ? inventoryEntry.sourcePath
      : canonicalSourceByGroup.get(inventoryEntry.inodeGroup!);
    const hasExpectedSemanticMapping = actual !== undefined && (
      (
        actual.sourcePath === inventoryEntry.sourcePath &&
        actual.type === inventoryEntry.type &&
        actual.target === inventoryEntry.target
      ) ||
      (
        // SharedFS reconciliation represents every hard-link name with the
        // canonical regular-file record for its inode. That is the same byte
        // mapping; retain the descriptor's per-path hard-link semantics in
        // the private snapshot instead of letting this process-local form
        // redefine them.
        inventoryEntry.type === "hardlink" &&
        actual.sourcePath === archivePath &&
        actual.type === "file" &&
        actual.target === undefined
      )
    );
    const mismatches = actual === undefined
      ? ["missing"]
      : [
        archivePath === undefined ? "archivePath source" : undefined,
        actual.generation === undefined ? "generation" : undefined,
        actual.dataSequence === undefined ? "dataSequence" : undefined,
        actual.size !== inventoryEntry.size ? "size" : undefined,
        actual.isSymlink !== isSymlink ? "symlink kind" : undefined,
        actual.deleted ? "deletion state" : undefined,
        actual.materialized !== isSymlink ? "materialization state" : undefined,
        actual.archivePath !== archivePath ? "archivePath" : undefined,
        !hasExpectedSemanticMapping ? "descriptor mapping" : undefined,
        actual.inodeGroup !== inventoryEntry.inodeGroup ? "inode group" : undefined,
      ].filter((value): value is string => value !== undefined);
    if (mismatches.length > 0) {
      throw new Error(
        `Lazy atomic activation member ${member} has inconsistent mapping at ` +
          `${inventoryEntry.vfsPath}: ${mismatches.join(", ")}`,
      );
    }
    // The mismatch guard above establishes that this entry is present.
    const captured = actual!;
    return Object.freeze({
      vfsPath: inventoryEntry.vfsPath,
      ino: captured.ino,
      generation: captured.generation,
      dataSequence: captured.dataSequence,
      size: captured.size,
      isSymlink: captured.isSymlink,
      deleted: false,
      materialized: captured.materialized,
      archivePath,
      sourcePath: inventoryEntry.sourcePath,
      type: inventoryEntry.type,
      ...(inventoryEntry.inodeGroup === undefined
        ? {}
        : { inodeGroup: inventoryEntry.inodeGroup }),
      ...(inventoryEntry.target === undefined
        ? {}
        : { target: inventoryEntry.target }),
    }) as LazyAtomicSnapshotEntry;
  });
  Object.freeze(entries);
  const integrity = Object.freeze({
    sha256: content.sha256,
    bytes: content.bytes,
  });
  const descriptorBytes = lazyAtomicDescriptorIdentityBytesFromValues(
    content,
    inventory,
    mountPrefixValue,
    activation,
  );
  return Object.freeze({
    id,
    member,
    descriptorBytes,
    content,
    inventory,
    activation,
    url: content.transports[0] ?? "",
    mountPrefix: mountPrefixValue,
    integrity,
    entries,
  });
}

function sealLazyAtomicSnapshot(
  source: LazyAtomicSnapshotSource,
  descriptorSha256: string,
  expectedCount: number,
  cohortSha256: string,
): SealedLazyAtomicSnapshot {
  return Object.freeze({
    ...source,
    descriptorSha256,
    expectedCount,
    cohortSha256,
  });
}

function equalLazyAtomicSnapshotSources(
  left: LazyAtomicSnapshotSource,
  right: LazyAtomicSnapshotSource,
): boolean {
  if (
    left.id !== right.id ||
    left.member !== right.member ||
    left.url !== right.url ||
    left.mountPrefix !== right.mountPrefix ||
    left.integrity.sha256 !== right.integrity.sha256 ||
    left.integrity.bytes !== right.integrity.bytes ||
    left.content.transports.length !== right.content.transports.length ||
    left.content.transports.some(
      (transport, index) => transport !== right.content.transports[index],
    ) ||
    !equalLazyAtomicDescriptorBytes(
      left.descriptorBytes,
      right.descriptorBytes,
    ) ||
    left.entries.length !== right.entries.length
  ) {
    return false;
  }
  return left.entries.every((entry, index) => {
    const candidate = right.entries[index];
    return candidate !== undefined &&
      entry.vfsPath === candidate.vfsPath &&
      equalLazyAtomicEntry(entry, candidate);
  });
}

function rewriteSealedLazyAtomicSnapshotTransports(
  snapshot: SealedLazyAtomicSnapshot,
  transform: (url: string) => string,
): SealedLazyAtomicSnapshot {
  const content = immutableLazyTreeContent(
    snapshot.content,
    snapshot.content.transports.map(transform),
  );
  return Object.freeze({
    ...snapshot,
    content,
    url: content.transports[0] ?? "",
  });
}

function conditionalFileReplacement(
  replacement: PreparedLazyArchiveReplacement,
) {
  return {
    paths: Array.from(replacement.paths),
    expectedIno: replacement.ino,
    expectedGeneration: replacement.generation,
    expectedDataSequence: replacement.dataSequence,
    data: replacement.content,
  };
}

function memoryFileSystemInodeKey(ino: number, generation: number): string {
  return `${ino}:${generation}`;
}

export class MemoryFileSystem implements FileSystemBackend {
  private fs: SharedFS;
  private imageMetadata: VfsImageMetadata | null;
  /** Lazy files keyed by inode slot + generation (raw inode numbers are reused). */
  private lazyFiles = new Map<
    string,
    {
      ino: number;
      generation: number;
      dataSequence: number;
      path: string;
      paths: Set<string>;
      url: string;
      size: number;
    }
  >();
  /** Lazy archive groups (bundle of files backed by one zip URL). */
  private lazyArchiveGroups: LazyArchiveGroup[] = [];
  /** Build-time direct-materialization authority; handles never serialize. */
  private deferredTreeMaterializationHandles = new WeakMap<
    DeferredTreeMaterializationHandle,
    LazyArchiveGroup
  >();
  /** Fast lookup keyed by inode slot + generation. */
  private lazyArchiveInodes = new Map<string, LazyArchiveGroup>();
  /** Activation transactions reconstructed from typed tree metadata. */
  private lazyAtomicGroups = new Map<string, LazyAtomicGroup>();
  private lazyAtomicGroupByTree = new WeakMap<LazyArchiveGroup, LazyAtomicGroup>();
  /**
   * Canonical activation state captured at the seal/import boundary.
   *
   * WHY: registerLazyTree() returns its group for existing callers, so nested
   * arrays remain reachable even after sealing. Retaining an internal copy
   * makes every later export/save/activation prove that public mutable state
   * still describes the exact member whose digest was sealed; authorized
   * mirror rewrites replace only the private transport portion.
   */
  private sealedLazyAtomicStates = new WeakMap<
    LazyArchiveGroup,
    SealedLazyAtomicState
  >();
  /**
   * Validated ordinary-tree definitions are private immutable authority.
   *
   * WHY: registerLazyTree() and higher-level adapters expose their group for
   * diagnostics. Callers may mutate that compatibility object after validation;
   * decode, export, restore, and rebase must continue from the exact accepted
   * source inventory and materialization plan rather than re-reading it.
   */
  private ordinaryLazyTreeDefinitions = new WeakMap<
    LazyArchiveGroup,
    LazyTreeDefinitionSnapshot
  >();
  private lazyDownloadListeners = new Set<LazyDownloadListener>();
  /** One in-flight fetch/commit per lazy file or archive group. */
  private lazyPreparations = new Map<object, LazyPreparation>();
  private lazyTransport: LazyTransport = {
    // WHY: the no-signal transport contract is observably one argument.
    // Forwarding an explicit `undefined` breaks embedders and tests that use
    // callback arity to distinguish an ordinary fetch from an initialized one.
    fetcher: (url, init) =>
      init === undefined ? globalThis.fetch(url) : globalThis.fetch(url, init),
  };

  private constructor(fs: SharedFS, metadata: VfsImageMetadata | null = null) {
    this.fs = fs;
    this.imageMetadata = metadata;
    intrinsicApply(intrinsicWeakSetAdd, memoryFileSystemInstances, [this]);
  }

  /** Stamp inode times from the machine's clock, in the milliseconds they hold. */
  setTimeProvider(time: TimeProvider): void {
    this.fs.setClock(() => {
      const { sec, nsec } = time.clockGettime(CLOCK_REALTIME);
      return sec * 1_000 + Math.floor(nsec / 1_000_000);
    });
  }

  /** Capture one self-contained product tree without retaining producer state. */
  private snapshotForImmutableProduct(): MemoryFileSystem {
    if (this.lazyFiles.size !== 0 || this.lazyArchiveInodes.size !== 0) {
      throw new Error(
        "immutable product source must be completely materialized",
      );
    }
    const { bytes } = intrinsicApply(
      intrinsicSharedFsSnapshotState,
      this.fs,
      [],
    ) as ReturnType<SharedFS["snapshotState"]>;
    const sab = new IntrinsicSharedArrayBuffer(bytes.byteLength);
    intrinsicApply(
      intrinsicUint8ArraySet,
      new IntrinsicUint8Array(sab),
      [bytes],
    );
    const fs = intrinsicApply(
      intrinsicSharedFsMount,
      SharedFS,
      [sab, { restoreImage: true }],
    ) as SharedFS;
    intrinsicObjectSetPrototypeOf(fs, immutableProductSharedFsPrototype);
    return new MemoryFileSystem(fs, cloneMetadata(this.imageMetadata));
  }

  /** Capture one exact backend-qualified inode identity. */
  private qualifiedInodeIdentity(path: string): MemoryFileSystemInodeIdentity {
    const stat = this.fs.lstat(path);
    let dev = intrinsicApply(
      intrinsicWeakMapGet,
      memoryFileSystemDeviceIds,
      [this.fs.buffer],
    ) as number | undefined;
    if (dev === undefined) {
      dev = nextMemoryFileSystemDeviceId++;
      intrinsicApply(
        intrinsicWeakMapSet,
        memoryFileSystemDeviceIds,
        [this.fs.buffer, dev],
      );
    }
    return {
      dev,
      ino: stat.ino,
      generation: stat.generation,
    };
  }

  private static canAdoptLegacyLazyStub(st: SfsStatResult): boolean {
    // Images from before data-sequence tracking stored regular lazy entries as
    // untouched zero-length stubs. Current registration performs one initial
    // O_TRUNC, so any later mutation sequence (or concrete bytes) is unsafe to
    // associate with metadata that cannot name the content version it saw.
    return (
      (st.mode & S_IFMT) === S_IFREG && st.size === 0 && st.dataSequence <= 1
    );
  }

  private replaceOrdinaryLazyTreeRuntimeState(
    group: LazyArchiveGroup,
    entries: readonly LazyAtomicSnapshotEntry[],
    materialized: boolean,
  ): LazyTreeDefinitionSnapshot | undefined {
    const definition = this.ordinaryLazyTreeDefinitions.get(group);
    if (definition === undefined) return undefined;
    const next = replaceImmutableLazyTreeRuntimeState(
      definition,
      entries,
      materialized,
    );
    this.ordinaryLazyTreeDefinitions.set(group, next);
    // WHY: these fields remain caller-visible compatibility diagnostics. The
    // private replacement above commits authority first, so a hostile public
    // map cannot affect the operation and a frozen mirror cannot roll it back.
    try {
      group.entries = cloneLazyTreeSnapshotEntryMap(next.entries);
      group.materialized = next.materialized;
    } catch {
      // Private authority remains complete even if a caller froze its mirror.
    }
    return next;
  }

  /**
   * Reconcile process-local lazy metadata with authoritative SharedFS names.
   * The identity map may come from the same transaction as a filesystem
   * snapshot, so callers can serialize matching bytes and lazy paths.
   */
  private reconcileLazyIdentityState(
    identities: Map<string, SharedFsIdentityState>,
  ): void {
    for (const [key, entry] of this.lazyFiles) {
      const identity = identities.get(key);
      if (
        !identity ||
        identity.dataSequence !== entry.dataSequence ||
        identity.paths.length === 0
      ) {
        this.lazyFiles.delete(key);
        continue;
      }
      entry.paths = new Set(identity.paths);
      if (!entry.paths.has(entry.path)) {
        entry.path = identity.paths[0];
      }
    }

    this.lazyArchiveInodes.clear();
    for (const group of this.lazyArchiveGroups) {
      const atomicGroup = this.lazyAtomicGroupByTree.get(group);
      const atomicState = this.sealedLazyAtomicStates.get(group);
      if (atomicState !== undefined) {
        if (!atomicGroup?.committed) {
          // WHY: peer reconciliation may update private inode lookup, but it
          // must never rewrite the sealed namespace/mapping from public state.
          // Exact SharedFS namespace checks below decide whether it is usable.
          for (const entry of atomicState.snapshot.entries) {
            if (
              entry.isSymlink ||
              entry.materialized ||
              entry.generation === undefined
            ) continue;
            const key = memoryFileSystemInodeKey(
              entry.ino,
              entry.generation,
            );
            const identity = identities.get(key);
            if (
              identity !== undefined &&
              identity.dataSequence === entry.dataSequence &&
              identity.paths.length > 0
            ) {
              this.lazyArchiveInodes.set(key, group);
            }
          }
        }
        continue;
      }
      const ordinaryDefinition = this.ordinaryLazyTreeDefinitions.get(group);
      if (ordinaryDefinition !== undefined) {
        if (ordinaryDefinition.materialized) {
          this.replaceOrdinaryLazyTreeRuntimeState(
            group,
            ordinaryDefinition.entries,
            true,
          );
          continue;
        }
        const pendingByIdentity = new Map<
          string,
          LazyAtomicSnapshotEntry[]
        >();
        const reconciledEntries = ordinaryDefinition.entries
          .filter((entry) =>
            entry.deleted || entry.materialized || entry.isSymlink
          )
          .map((entry) => ({ ...entry }));
        for (const entry of ordinaryDefinition.entries) {
          if (
            entry.deleted || entry.materialized || entry.isSymlink ||
            entry.generation === undefined
          ) continue;
          const key = memoryFileSystemInodeKey(entry.ino, entry.generation);
          const aliases = pendingByIdentity.get(key) ?? [];
          aliases.push(entry);
          pendingByIdentity.set(key, aliases);
        }
        for (const [key, aliases] of pendingByIdentity) {
          const identity = identities.get(key);
          if (
            identity === undefined ||
            identity.dataSequence !== (aliases[0]!.dataSequence ?? 0)
          ) {
            if (identity !== undefined) {
              // A concrete write legitimately retired this deferred inode.
              // Preserve that transition privately without adopting any
              // caller-visible mapping fields.
              for (const entry of aliases) {
                reconciledEntries.push({ ...entry, materialized: true });
              }
            }
            continue;
          }
          const byPath = new Map(
            aliases.map((entry) => [entry.vfsPath, entry]),
          );
          const canonical = aliases.find((entry) => entry.type === "file") ??
            aliases[0]!;
          for (const path of identity.paths) {
            const semantic = byPath.get(path) ?? canonical;
            reconciledEntries.push({
              ...semantic,
              vfsPath: path,
              ino: identity.ino,
              generation: identity.generation,
              dataSequence: identity.dataSequence,
              deleted: false,
              materialized: false,
            });
          }
          if (identity.paths.length > 0) {
            this.lazyArchiveInodes.set(key, group);
          }
        }
        this.replaceOrdinaryLazyTreeRuntimeState(
          group,
          reconciledEntries,
          false,
        );
        continue;
      }
      const pendingByIdentity = new Map<string, LazyArchiveFileEntry>();
      for (const entry of group.entries.values()) {
        if (
          entry.deleted ||
          entry.materialized ||
          entry.generation === undefined
        )
          continue;
        const key = memoryFileSystemInodeKey(entry.ino, entry.generation);
        if (!pendingByIdentity.has(key)) pendingByIdentity.set(key, entry);
      }

      // Structural symlinks are materialized when the descriptor is
      // registered, so they do not participate in pending-inode lookup.
      // Keep their exact registered identity for sealed-cohort namespace
      // guards. Keep local deletion tombstones as well: once every alias in
      // an inode group is intentionally removed, that is the only distinction
      // between a supported metadata-only tree and an unobserved peer unlink.
      const reconciled = new Map<string, LazyArchiveFileEntry>(
        Array.from(group.entries.entries()).filter(([, entry]) =>
          entry.deleted || (entry.isSymlink && !entry.deleted)
        ),
      );
      for (const [key, entry] of pendingByIdentity) {
        const identity = identities.get(key);
        if (!identity || identity.dataSequence !== (entry.dataSequence ?? 0))
          continue;
        for (const path of identity.paths) {
          reconciled.set(path, {
            ...entry,
            ino: identity.ino,
            generation: identity.generation,
            dataSequence: identity.dataSequence,
            deleted: false,
            materialized: false,
          });
        }
        if (identity.paths.length > 0) {
          this.lazyArchiveInodes.set(key, group);
        }
      }
      group.entries = reconciled;
      group.materialized =
        !Array.from(reconciled.values()).some((entry) =>
          !entry.isSymlink && !entry.materialized
        ) &&
        (atomicGroup === undefined || atomicGroup.committed);
    }
  }

  /**
   * Validate every pending generic-tree namespace member against the exact
   * SharedFS state captured for export, rebase, or image serialization.
   *
   * WHY: producer metadata lives in this JavaScript instance, while another
   * worker can mutate the shared namespace without updating it. Record-only
   * validation cannot see a peer chmod, a removed structural symlink, or an
   * undeclared hard-link alias. Using the same lock-captured state as the
   * filesystem snapshot prevents a later live repair from blessing bytes that
   * were already inconsistent when copied.
   */
  private validatePendingLazyTreeNamespaceState(
    identities: Map<string, SharedFsIdentityState>,
  ): void {
    const identityByPath = new Map<string, SharedFsIdentityState>();
    for (const identity of identities.values()) {
      for (const path of identity.paths) {
        if (identityByPath.has(path)) {
          throw new Error(
            `SharedFS namespace identity is ambiguous at ${path}`,
          );
        }
        identityByPath.set(path, identity);
      }
    }

    for (const group of this.lazyArchiveGroups) {
      const atomicGroup = this.lazyAtomicGroupByTree.get(group);
      const atomicState = this.sealedLazyAtomicStates.get(group);
      const snapshot = atomicState?.snapshot;
      const ordinaryDefinition = this.ordinaryLazyTreeDefinitions.get(group);
      if (
        atomicGroup?.committed ||
        (snapshot === undefined &&
          (ordinaryDefinition?.materialized ?? group.materialized)) ||
        (snapshot === undefined &&
          ordinaryDefinition === undefined)
      ) {
        continue;
      }
      const inventory = snapshot?.inventory ?? ordinaryDefinition!.inventory;
      const registeredEntries = new Map(
        (snapshot?.entries ?? ordinaryDefinition!.entries).map((entry) => [
          entry.vfsPath,
          entry,
        ]),
      );
      const aliasesByInodeGroup = new Map<string, number>();
      const pathsByInodeGroup = new Map<string, string[]>();
      const locallyDeletedInodeGroups = new Set<string>();
      for (const entry of registeredEntries.values()) {
        if (entry.deleted && entry.inodeGroup !== undefined) {
          locallyDeletedInodeGroups.add(entry.inodeGroup);
        }
      }
      for (const entry of inventory) {
        if (entry.type !== "file" && entry.type !== "hardlink") continue;
        aliasesByInodeGroup.set(
          entry.inodeGroup!,
          (aliasesByInodeGroup.get(entry.inodeGroup!) ?? 0) + 1,
        );
        const paths = pathsByInodeGroup.get(entry.inodeGroup!) ?? [];
        paths.push(entry.vfsPath);
        pathsByInodeGroup.set(entry.inodeGroup!, paths);
      }
      const intentionallyRemovedInodeGroups = new Set(
        [...locallyDeletedInodeGroups].filter((inodeGroup) =>
          pathsByInodeGroup.get(inodeGroup)?.every(
            (path) => !identityByPath.has(path),
          )
        ),
      );

      for (const inventoryEntry of inventory) {
        const identity = identityByPath.get(inventoryEntry.vfsPath);
        if (identity === undefined) {
          const intentionallyRemovedInodeGroup =
            inventoryEntry.inodeGroup !== undefined &&
            intentionallyRemovedInodeGroups.has(inventoryEntry.inodeGroup);
          if (intentionallyRemovedInodeGroup) continue;
          throw new Error(
            `Lazy tree namespace entry ${inventoryEntry.vfsPath} ` +
              "is missing from the captured filesystem state",
          );
        }
        const expectedType = inventoryEntry.type === "directory"
          ? S_IFDIR
          : inventoryEntry.type === "symlink"
            ? S_IFLNK
            : S_IFREG;
        if (
          (identity.mode & S_IFMT) !== expectedType ||
          (identity.mode & FILE_MODES.S_MODE_BITS) !== inventoryEntry.mode
        ) {
          throw new Error(
            `Lazy tree namespace entry ${inventoryEntry.vfsPath} ` +
              "disagrees with its captured type or mode",
          );
        }

        if (inventoryEntry.type === "directory") continue;
        const registered = registeredEntries.get(inventoryEntry.vfsPath);
        if (
          registered === undefined ||
          registered.ino !== identity.ino ||
          registered.generation !== identity.generation ||
          registered.dataSequence !== identity.dataSequence
        ) {
          throw new Error(
            `Lazy tree namespace entry ${inventoryEntry.vfsPath} ` +
              "changed identity before serialization",
          );
        }

        if (inventoryEntry.type === "symlink") {
          const targetBytes =
            new TextEncoder().encode(inventoryEntry.target!).byteLength;
          if (
            identity.linkCount !== 1 ||
            identity.size !== inventoryEntry.size ||
            identity.size !== targetBytes ||
            identity.symlinkTarget !== inventoryEntry.target
          ) {
            throw new Error(
              `Lazy tree symlink ${inventoryEntry.vfsPath} ` +
                "disagrees with its captured inventory",
            );
          }
          continue;
        }

        if (
          identity.size !== 0 ||
          identity.linkCount !==
            aliasesByInodeGroup.get(inventoryEntry.inodeGroup!)!
        ) {
          throw new Error(
            `Lazy tree stub ${inventoryEntry.vfsPath} ` +
              "has changed data or undeclared aliases",
          );
        }
      }
    }
  }

  private lazyFileForStat(st: SfsStatResult) {
    const key = memoryFileSystemInodeKey(st.ino, st.generation);
    const entry = this.lazyFiles.get(key);
    if (entry && entry.dataSequence !== st.dataSequence) {
      this.lazyFiles.delete(key);
      return undefined;
    }
    return entry;
  }

  private lazyArchiveEntriesForRead(
    group: LazyArchiveGroup,
  ): LazyAtomicSnapshotEntry[] {
    const atomicGroup = this.lazyAtomicGroupByTree.get(group);
    const atomicState = this.sealedLazyAtomicStates.get(group);
    if (atomicState !== undefined && !atomicGroup?.committed) {
      return atomicState.snapshot.entries;
    }
    const ordinaryDefinition = this.ordinaryLazyTreeDefinitions.get(group);
    if (ordinaryDefinition !== undefined) return ordinaryDefinition.entries;
    return Array.from(group.entries, ([vfsPath, entry]) => ({
      vfsPath,
      ...entry,
    }));
  }

  private lazyArchiveForStat(st: SfsStatResult) {
    const key = memoryFileSystemInodeKey(st.ino, st.generation);
    const group = this.lazyArchiveInodes.get(key);
    if (!group) return undefined;
    const entries = this.lazyArchiveEntriesForRead(group).filter(
      (entry) =>
        entry.ino === st.ino &&
        entry.generation === st.generation &&
        !entry.deleted &&
        !entry.materialized,
    );
    if (entries.some((entry) => entry.dataSequence === st.dataSequence)) {
      return group;
    }
    this.lazyArchiveInodes.delete(key);
    const atomicState = this.sealedLazyAtomicStates.get(group);
    if (atomicState === undefined) {
      const ordinaryDefinition = this.ordinaryLazyTreeDefinitions.get(group);
      if (ordinaryDefinition !== undefined) {
        this.replaceOrdinaryLazyTreeRuntimeState(
          group,
          ordinaryDefinition.entries.map((entry) =>
            entry.ino === st.ino && entry.generation === st.generation
              ? { ...entry, materialized: true }
              : entry
          ),
          ordinaryDefinition.materialized,
        );
      } else {
        for (const entry of entries) entry.materialized = true;
      }
    }
    return undefined;
  }

  private lazyBackingForStat(st: SfsStatResult): LazyBacking | null {
    const key = memoryFileSystemInodeKey(st.ino, st.generation);
    // Preparation deliberately observes the registered identity even when a
    // peer advanced its data sequence. The identity-guarded commit will then
    // reconcile and preserve the peer's bytes, while callers still learn that
    // the deferred backing was conclusively resolved.
    const file = this.lazyFiles.get(key);
    if (file) return { token: file, path: file.path };
    const archive = this.lazyArchiveInodes.get(key);
    if (!archive) return null;
    const path = this.lazyArchiveEntriesForRead(archive).find((entry) =>
      entry.ino === st.ino &&
      entry.generation === st.generation &&
      !entry.deleted &&
      !entry.materialized
    )?.vfsPath;
    if (path === undefined) return null;
    const atomicGroup = this.lazyAtomicGroupByTree.get(archive);
    return atomicGroup === undefined
      ? { token: archive, path }
      : { token: atomicGroup.token, path, atomicGroup };
  }

  private lazyBackingForPath(path: string): LazyBacking | null {
    // A directory/symlink-only tree has no empty regular inode to carry its
    // deferred identity. Preserve first-use semantics through the declared
    // activation roots instead of silently treating the tree as concrete.
    const metadataOnlyGroup = this.lazyArchiveGroups.find((group) => {
      const atomicGroup = this.lazyAtomicGroupByTree.get(group);
      const snapshot = this.sealedLazyAtomicStates.get(group)?.snapshot;
      const ordinaryDefinition = this.ordinaryLazyTreeDefinitions.get(group);
      const pending = snapshot === undefined
        ? !(ordinaryDefinition?.materialized ?? group.materialized)
        : !atomicGroup?.committed;
      const content = snapshot?.content ?? ordinaryDefinition?.content;
      const inventory = snapshot?.inventory ?? ordinaryDefinition?.inventory;
      const activation = snapshot?.activation ?? ordinaryDefinition?.activation;
      const entries = snapshot?.entries ?? ordinaryDefinition?.entries ??
        Array.from(group.entries.values());
      return pending &&
        content !== undefined &&
        inventory !== undefined &&
        activation !== undefined &&
        entries.every(
          (entry) => entry.deleted || entry.materialized || entry.isSymlink,
        ) &&
        activation.roots.some((root) =>
          root === "/" || path === root || path.startsWith(`${root}/`)
        );
    });
    if (metadataOnlyGroup) {
      const atomicGroup = this.lazyAtomicGroupByTree.get(metadataOnlyGroup);
      return {
        token: atomicGroup?.token ?? metadataOnlyGroup,
        path,
        directGroup: metadataOnlyGroup,
        ...(atomicGroup === undefined ? {} : { atomicGroup }),
      };
    }
    try {
      const st = this.fs.stat(path);
      const backing = this.lazyBackingForStat(st);
      return backing ? { ...backing, path } : null;
    } catch {
      return null;
    }
  }

  private startLazyPreparation(backing: LazyBacking): LazyPreparation {
    const { path, token } = backing;
    const preparation = {
      status: "pending",
      promise: Promise.resolve(false),
    } as LazyPreparation;
    const materialization = backing.atomicGroup
      ? this.ensureAtomicLazyGroupMaterialized(backing.atomicGroup).then(() => true)
      : backing.directGroup
      ? this.ensureArchiveMaterialized(backing.directGroup).then(() => true)
      : this.materializePath(path);
    preparation.promise = materialization.then(
      (materialized) => {
        preparation.status = "fulfilled";
        if (this.lazyPreparations.get(token) === preparation) {
          this.lazyPreparations.delete(token);
        }
        return materialized;
      },
      (error) => {
        preparation.status = "rejected";
        preparation.error = error;
        throw error;
      },
    );
    // A synchronous guest open starts the work and returns internal EAGAIN;
    // retain the rejection for its retry without creating an unhandled
    // promise rejection in the worker.
    void preparation.promise.catch(() => {});
    this.lazyPreparations.set(token, preparation);
    return preparation;
  }

  private registerLazyAtomicGroupMembership(
    group: LazyArchiveGroup,
    importedSealVerified = false,
  ): void {
    const membership = group.activation?.atomicGroup;
    if (membership === undefined) return;
    const { id, member } = membership;
    if (
      group.content === undefined ||
      group.inventory === undefined ||
      group.activation?.mode !== "first-use"
    ) {
      throw new Error(
        `Lazy atomic activation group ${id} accepts only typed first-use trees`,
      );
    }
    let atomicGroup = this.lazyAtomicGroups.get(id);
    if (atomicGroup === undefined) {
      atomicGroup = {
        id,
        token: Object.freeze({ id }),
        groups: new Map(),
        committed: false,
      };
      this.lazyAtomicGroups.set(id, atomicGroup);
    } else if (atomicGroup.committed) {
      throw new Error(
        `Lazy atomic activation group ${id} is already materialized`,
      );
    }
    if (atomicGroup.groups.has(member)) {
      throw new Error(
        `Lazy atomic activation group ${id} duplicates member ${member}`,
      );
    }
    if (isSealedLazyAtomicMembership(membership)) {
      if (
        atomicGroup.expectedCount !== undefined &&
        (
          atomicGroup.expectedCount !== membership.expectedCount ||
          atomicGroup.cohortSha256 !== membership.cohortSha256
        )
      ) {
        throw new Error(
          `Lazy atomic activation group ${id} has inconsistent seals`,
        );
      }
      atomicGroup.expectedCount = membership.expectedCount;
      atomicGroup.cohortSha256 = membership.cohortSha256;
      const source = captureLazyAtomicSnapshotSource(group, id, member);
      this.sealedLazyAtomicStates.set(group, {
        snapshot: sealLazyAtomicSnapshot(
          source,
          membership.descriptorSha256,
          membership.expectedCount,
          membership.cohortSha256,
        ),
        verified: importedSealVerified,
      });
    } else if (atomicGroup.expectedCount !== undefined) {
      throw new Error(
        `Lazy atomic activation group ${id} mixes sealed and unsealed members`,
      );
    }
    atomicGroup.groups.set(member, group);
    this.lazyAtomicGroupByTree.set(group, atomicGroup);
  }

  /**
   * Finalize one exact multi-tree activation cohort.
   *
   * The caller supplies the producer-known member names so forgetting a tree
   * cannot silently redefine the transaction. The resulting per-member and
   * cohort digests are retained in every serialized tree record.
   */
  async sealLazyAtomicGroup(
    id: string,
    expectedMembersValue: readonly string[],
  ): Promise<void> {
    const expectedMembers = expectedMembersValue.map((member) =>
      validateLazyAtomicGroupMembership({ id, member }).member
    ).sort();
    if (
      expectedMembers.length === 0 ||
      new Set(expectedMembers).size !== expectedMembers.length
    ) {
      throw new Error(
        `Lazy atomic activation group ${id} expected members are invalid`,
      );
    }
    const atomicGroup = this.lazyAtomicGroups.get(id);
    if (atomicGroup === undefined || atomicGroup.committed) {
      throw new Error(
        `Lazy atomic activation group ${id} is not pending`,
      );
    }
    const actualMembers = [...atomicGroup.groups.keys()].sort();
    if (JSON.stringify(actualMembers) !== JSON.stringify(expectedMembers)) {
      throw new Error(
        `Lazy atomic activation group ${id} members differ from its seal`,
      );
    }
    if (atomicGroup.expectedCount !== undefined) {
      if (
        atomicGroup.expectedCount !== expectedMembers.length ||
        atomicGroup.cohortSha256 === undefined
      ) {
        throw new Error(
          `Lazy atomic activation group ${id} has an invalid existing seal`,
        );
      }
      await this.ensureLazyAtomicGroupSealValidated(
        atomicGroup,
        expectedMembers.map((member) => atomicGroup.groups.get(member)!),
        true,
      );
      return;
    }

    const sources = expectedMembers.map((member) =>
      captureLazyAtomicSnapshotSource(
        atomicGroup.groups.get(member)!,
        id,
        member,
      )
    );
    const descriptors: Array<{
      member: string;
      descriptorSha256: string;
      source: LazyAtomicSnapshotSource;
    }> = [];
    // Hash sequentially so a large descriptor set never creates one encoded
    // copy per tree at the same time merely to establish the cohort identity.
    for (const source of sources) {
      descriptors.push({
        member: source.member,
        descriptorSha256: await sha256Hex(
          source.descriptorBytes,
          `Lazy atomic member ${source.member}`,
        ),
        source,
      });
    }
    const cohortSha256 = await sha256Hex(
      lazyAtomicCohortIdentityBytes(id, descriptors),
      `Lazy atomic activation group ${id}`,
    );
    for (const descriptor of descriptors) {
      const group = atomicGroup.groups.get(descriptor.member)!;
      const current = captureLazyAtomicSnapshotSource(
        group,
        id,
        descriptor.member,
      );
      if (!equalLazyAtomicSnapshotSources(descriptor.source, current)) {
        throw new Error(
          `Lazy atomic activation member ${descriptor.member} changed while sealing`,
        );
      }
    }
    for (const descriptor of descriptors) {
      const group = atomicGroup.groups.get(descriptor.member)!;
      group.activation!.atomicGroup = {
        id,
        member: descriptor.member,
        descriptorSha256: descriptor.descriptorSha256,
        expectedCount: descriptors.length,
        cohortSha256,
      };
      this.sealedLazyAtomicStates.set(group, {
        snapshot: sealLazyAtomicSnapshot(
          descriptor.source,
          descriptor.descriptorSha256,
          descriptors.length,
          cohortSha256,
        ),
        verified: true,
      });
    }
    atomicGroup.expectedCount = descriptors.length;
    atomicGroup.cohortSha256 = cohortSha256;
  }

  /**
   * Cryptographically authenticate every pending sealed atomic cohort.
   *
   * Image restore validates the closed v3 structure synchronously, but its
   * SHA-256 claims remain untrusted until an asynchronous host digest pass.
   * Await this before a caller needs synchronous metadata inspection or
   * filesystem rebasing. This check does not fetch or materialize deferred
   * trees, snapshot the filesystem, export metadata, or rebase storage.
   *
   * Locally sealed cohorts are already authenticated; explicitly verifying
   * them again is safe and idempotent.
   */
  async verifyImportedLazyAtomicGroupSeals(): Promise<void> {
    // WHY: synchronous export and rebase cannot invoke browser SubtleCrypto.
    // Keep their fail-closed guard while giving image consumers a cheap,
    // explicit trust boundary that does not serialize the whole VFS.
    await this.validatePendingLazyAtomicGroupSeals(true);
  }

  private guardSynchronousLazyAccess(path: string): void {
    const backing = this.lazyBackingForPath(path);
    if (!backing) return;
    let preparation = this.lazyPreparations.get(backing.token);
    if (preparation?.status === "fulfilled") {
      this.lazyPreparations.delete(backing.token);
      const remaining = this.lazyBackingForPath(path);
      if (!remaining) return;
      preparation = this.lazyPreparations.get(remaining.token) ??
        this.startLazyPreparation(remaining);
    } else if (preparation?.status === "rejected") {
      this.lazyPreparations.delete(backing.token);
      const detail = preparation.error instanceof Error
        ? preparation.error.message
        : String(preparation.error);
      const error = new Error(`EIO: lazy backing for ${path} failed: ${detail}`) as
        Error & { code: string; cause?: unknown };
      error.code = "EIO";
      error.cause = preparation.error;
      throw error;
    } else if (!preparation) {
      preparation = this.startLazyPreparation(backing);
    }
    const error = new Error(`EAGAIN: lazy backing for ${path} is being prepared`) as
      Error & { code: string };
    error.code = "EAGAIN";
    throw error;
  }

  /** A successful guest data mutation makes any deferred backing obsolete. */
  private invalidateLazyData(st: SfsStatResult): void {
    const key = memoryFileSystemInodeKey(st.ino, st.generation);
    this.lazyFiles.delete(key);

    const group = this.lazyArchiveInodes.get(key);
    if (!group) return;
    this.lazyArchiveInodes.delete(key);
    const ordinaryDefinition = this.ordinaryLazyTreeDefinitions.get(group);
    if (ordinaryDefinition !== undefined) {
      this.replaceOrdinaryLazyTreeRuntimeState(
        group,
        ordinaryDefinition.entries.map((entry) =>
          entry.ino === st.ino && entry.generation === st.generation
            ? { ...entry, materialized: true }
            : entry
        ),
        ordinaryDefinition.materialized,
      );
      return;
    }
    for (const entry of group.entries.values()) {
      if (entry.ino !== st.ino || entry.generation !== st.generation) continue;
      // Keep the concrete inode in the image, but prevent a later archive
      // fetch from overwriting data the guest supplied through any alias.
      entry.materialized = true;
    }
  }

  private rewriteLazyNamespacePaths(
    source: NamespaceEntryIdentity,
    oldPath: string,
    newPath: string,
  ): void {
    const oldBase = oldPath.length > 1 ? oldPath.replace(/\/+$/, "") : oldPath;
    const newBase = newPath.length > 1 ? newPath.replace(/\/+$/, "") : newPath;
    const oldPrefix = `${oldBase}/`;
    const newPrefix = `${newBase}/`;
    const sourceKey = memoryFileSystemInodeKey(source.ino, source.generation);
    const directory = (source.mode & S_IFMT) === S_IFDIR;
    const rewrite = (candidate: string): string =>
      candidate === oldBase
        ? newBase
        : directory && candidate.startsWith(oldPrefix)
          ? newPrefix + candidate.slice(oldPrefix.length)
          : candidate;

    for (const [key, lazy] of this.lazyFiles) {
      if (!directory && key !== sourceKey) continue;
      lazy.paths = new Set(Array.from(lazy.paths, rewrite));
      lazy.path = rewrite(lazy.path);
    }

    for (const group of this.lazyArchiveGroups) {
      const ordinaryDefinition = this.ordinaryLazyTreeDefinitions.get(group);
      if (ordinaryDefinition !== undefined) {
        const entries = ordinaryDefinition.entries.map((entry) => {
          const entryKey = entry.generation === undefined
            ? null
            : memoryFileSystemInodeKey(entry.ino, entry.generation);
          const vfsPath = directory || entryKey === sourceKey
            ? rewrite(entry.vfsPath)
            : entry.vfsPath;
          return {
            ...entry,
            vfsPath,
            ...(entry.type === "hardlink" && entry.target !== undefined
              ? { target: rewrite(entry.target) }
              : {}),
          };
        });
        const inventory = ordinaryDefinition.inventory.map((entry) => ({
          ...entry,
          vfsPath: rewrite(entry.vfsPath),
          ...(entry.type === "hardlink" && entry.target !== undefined
            ? { target: rewrite(entry.target) }
            : {}),
        }));
        const activation = {
          ...ordinaryDefinition.activation,
          capabilities: [...ordinaryDefinition.activation.capabilities],
          roots: ordinaryDefinition.activation.roots.map(rewrite),
        };
        const next = immutableLazyTreeDefinitionSnapshot(
          ordinaryDefinition.content,
          inventory,
          activation,
          ordinaryDefinition.url,
          ordinaryDefinition.mountPrefix,
          ordinaryDefinition.integrity,
          entries,
          ordinaryDefinition.materialized,
        );
        this.ordinaryLazyTreeDefinitions.set(group, next);
        try {
          group.entries = cloneLazyTreeSnapshotEntryMap(next.entries);
          group.materialized = next.materialized;
          group.inventory = next.inventory.map((entry) => ({ ...entry }));
          group.activation = {
            ...next.activation,
            capabilities: [...next.activation.capabilities],
            roots: [...next.activation.roots],
          };
        } catch {
          // Authorized private namespace state does not depend on its mirror.
        }
        continue;
      }
      const rewritten = new Map<string, LazyArchiveFileEntry>();
      for (const [candidate, entry] of group.entries) {
        const entryKey =
          entry.generation === undefined
            ? null
            : memoryFileSystemInodeKey(entry.ino, entry.generation);
        rewritten.set(
          directory || entryKey === sourceKey ? rewrite(candidate) : candidate,
          entry,
        );
      }
      group.entries = rewritten;
      if (group.inventory) {
        group.inventory = group.inventory.map((entry) => ({
          ...entry,
          vfsPath: rewrite(entry.vfsPath),
          ...(entry.type === "hardlink" && entry.target !== undefined
            ? { target: rewrite(entry.target) }
            : {}),
        }));
      }
      if (group.activation) {
        group.activation = {
          ...group.activation,
          roots: group.activation.roots.map(rewrite),
        };
      }
    }
  }

  /** Return the underlying SharedArrayBuffer (for sharing with workers). */
  get sharedBuffer(): SharedArrayBuffer {
    return this.fs.buffer as SharedArrayBuffer;
  }

  checkpointBytes(): CheckpointBytes {
    return { kind: "bytes", buffer: this.sharedBuffer };
  }

  static create(
    sab: SharedArrayBuffer,
    maxSizeBytes?: number,
  ): MemoryFileSystem {
    return new MemoryFileSystem(SharedFS.mkfs(sab, maxSizeBytes));
  }

  /** Construct a fresh MemoryFS without accepting caller-owned backing. */
  static createFresh(byteLength: number): MemoryFileSystem {
    if (
      typeof byteLength !== "number" ||
      !intrinsicNumberIsInteger(byteLength) ||
      byteLength <= 0
    ) {
      throw new IntrinsicTypeError(
        "fresh MemoryFileSystem byte length must be a positive integer",
      );
    }
    const buffer = new IntrinsicSharedArrayBuffer(byteLength);
    const fs = intrinsicApply(
      intrinsicSharedFsMkfs,
      SharedFS,
      [buffer],
    ) as SharedFS;
    return new MemoryFileSystem(fs);
  }

  static fromExisting(sab: SharedArrayBuffer): MemoryFileSystem {
    return new MemoryFileSystem(SharedFS.mount(sab));
  }

  /**
   * Mount captured bytes while keeping the deferred content this image knows.
   *
   * Which files are still deferred, and where their bytes come from, lives in
   * the image's own sections rather than in the SharedFS buffer, so a
   * filesystem mounted on captured bytes alone reports every deferred path as
   * an existing file and reads none of them.
   *
   * The registry comes from this image and never from the capture. A capture
   * crosses the network from another computer, and one that carried fetch URLs
   * would let the sending computer choose what the receiving one downloads.
   *
   * Each entry is adopted only where the captured inode, its generation and
   * its data sequence all still match, so a file the captured machine already
   * materialized keeps its captured bytes.
   */
  mountCapturedBytes(sab: SharedArrayBuffer): MemoryFileSystem {
    const captured = new MemoryFileSystem(
      SharedFS.mount(sab),
      cloneMetadata(this.imageMetadata),
    );
    captured.importLazyEntries(this.exportLazyEntries());
    // The export refuses to serialize a sealed group this instance has not
    // authenticated, so everything that reaches here is already verified and
    // stays verified. Re-admitting these groups as pending would leave the
    // mounted filesystem unable to hand the machine on again.
    captured.importLazyArchiveEntriesInternal(
      this.exportLazyArchiveEntries(),
      false,
      true,
      "verified",
    );
    return captured;
  }

  /**
   * Copy this filesystem into a freshly formatted SharedFS whose superblock
   * records `maxByteLength` as its growth ceiling. Lazy file/archive metadata
   * is rebuilt from paths so the destination carries the new inode numbers.
   */
  rebaseToNewFileSystem(maxByteLength: number): MemoryFileSystem {
    if (!Number.isSafeInteger(maxByteLength) || maxByteLength <= 0) {
      throw new Error(
        `Invalid MemoryFileSystem maxByteLength: ${maxByteLength}`,
      );
    }

    const SharedArrayBufferCtor = SharedArrayBuffer as new (
      byteLength: number,
      options?: { maxByteLength?: number },
    ) => SharedArrayBuffer;

    // Copy from one quiescent source image. Exporting lazy paths and then
    // walking the live SAB would let a peer rename an entry between those two
    // operations, making the logical lazy size disagree with the copied path.
    const { bytes: sourceBytes, identities } = this.fs.snapshotState();
    this.reconcileLazyIdentityState(identities);
    const lazyEntries = this.serializeLazyEntries();
    const lazyArchiveEntries =
      this.serializeValidatedLazyArchiveEntries(identities);
    const sourceSab = new SharedArrayBufferCtor(sourceBytes.byteLength);
    new Uint8Array(sourceSab).set(sourceBytes);
    const source = new MemoryFileSystem(
      SharedFS.mount(sourceSab, { restoreImage: true }),
      this.imageMetadata,
    );
    source.importLazyEntries(lazyEntries);
    source.importLazyArchiveEntriesInternal(
      lazyArchiveEntries,
      false,
      true,
      "verified",
    );

    const initialByteLength = Math.min(
      maxByteLength,
      Math.max(sourceBytes.byteLength, MIN_REBASE_INITIAL_BYTES),
    );
    const sab = new SharedArrayBufferCtor(initialByteLength, { maxByteLength });
    const target = MemoryFileSystem.create(sab, maxByteLength);
    target.setImageMetadata(this.imageMetadata);

    const lazyFilePaths = new Set(
      lazyEntries.flatMap((entry) => entry.paths ?? [entry.path]),
    );
    const lazyArchiveStubPaths = new Set<string>();
    for (const group of lazyArchiveEntries) {
      if (group.materialized) continue;
      for (const entry of group.entries) {
        if (!entry.deleted && !entry.isSymlink) {
          lazyArchiveStubPaths.add(entry.vfsPath);
        }
      }
    }

    source.copyPathToFreshFileSystem(
      "/",
      target,
      lazyFilePaths,
      lazyArchiveStubPaths,
      new Map(),
    );

    target.importLazyEntries(
      lazyEntries.map((entry) => {
        const st = target.fs.lstat(entry.path);
        return {
          ...entry,
          ino: st.ino,
          generation: st.generation,
          dataSequence: st.dataSequence,
        };
      }),
    );
    target.importLazyArchiveEntriesInternal(
      lazyArchiveEntries.map((group) => ({
        ...group,
        entries: group.entries.map((entry) => {
          if (entry.deleted) return { ...entry, ino: 0, generation: undefined };
          const st = target.fs.lstat(entry.vfsPath);
          return {
            ...entry,
            ino: st.ino,
            generation: st.generation,
            dataSequence: st.dataSequence,
          };
        }),
      })),
      false,
      true,
      "verified",
    );

    return target;
  }

  /** Return a copy of image-level metadata, or null if the image did not declare any. */
  getImageMetadata(): VfsImageMetadata | null {
    return cloneMetadata(this.imageMetadata);
  }

  /** Set or clear image-level metadata for the next saveImage() call. */
  setImageMetadata(metadata: VfsImageMetadata | null): void {
    this.imageMetadata = metadata === null ? null : validateMetadata(metadata);
  }

  subscribeLazyDownloads(listener: LazyDownloadListener): () => void {
    this.lazyDownloadListeners.add(listener);
    return () => this.lazyDownloadListeners.delete(listener);
  }

  /**
   * Install the host-specific transport used for lazy file and archive URLs.
   * Register a signal here rather than closing over one invisibly: Fetch
   * rejects with `AbortSignal.reason` unchanged, which may otherwise look like
   * a retryable TypeError or an ordinary mirror failure.
   */
  setLazyFetcher(
    fetcher: LazyFetch,
    options: LazyFetcherOptions = {},
  ): void {
    this.lazyTransport = {
      fetcher,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    };
  }

  private emitLazyDownload(event: Omit<LazyDownloadEvent, "t">): void {
    if (this.lazyDownloadListeners.size === 0) return;
    const stamped: LazyDownloadEvent = { ...event, t: monotonicNow() };
    for (const listener of this.lazyDownloadListeners) {
      try {
        listener(stamped);
      } catch {
        /* listener errors must not break VFS I/O */
      }
    }
  }

  private async fetchLazyBytes(details: {
    id: string;
    kind: LazyDownloadKind;
    url: string;
    path?: string;
    mountPrefix?: string;
    fallbackTotalBytes?: number;
    integrity?: LazyArchiveIntegrity;
  }, transport: LazyTransport): Promise<Uint8Array> {
    let loadedBytes = 0;
    let totalBytes = details.integrity?.bytes ?? details.fallbackTotalBytes;
    const base = {
      id: details.id,
      kind: details.kind,
      url: details.url,
      path: details.path,
      mountPrefix: details.mountPrefix,
    };

    for (let attempt = 0; attempt < MAX_LAZY_TRANSPORT_ATTEMPTS; attempt += 1) {
      loadedBytes = 0;
      this.emitLazyDownload({
        ...base,
        status: "started",
        loadedBytes,
        totalBytes,
      });
      try {
        throwIfLazyTransportAborted(transport.signal);
        // WHY: preserve the historical one-argument callback shape unless the
        // caller explicitly opted into signal forwarding.
        const resp = transport.signal === undefined
          ? await transport.fetcher(details.url)
          : await transport.fetcher(details.url, { signal: transport.signal });
        if (transport.signal?.aborted) {
          await cancelResponseBody(resp, transport.signal.reason);
          throw transport.signal.reason;
        }
        if (!resp.ok) {
          const error = new LazyHttpResponseError(
            resp.status,
            parseRetryAfterMs(resp.headers),
          );
          await cancelResponseBody(resp, error);
          throw error;
        }

        totalBytes = parseContentLength(resp.headers) ?? totalBytes;
        if (
          details.integrity &&
          totalBytes !== undefined &&
          totalBytes !== details.integrity.bytes
        ) {
          const error = new Error(
            `Lazy ${details.kind} byte count ${totalBytes} does not match ` +
              `expected ${details.integrity.bytes}`,
          );
          await cancelResponseBody(resp, error);
          throw error;
        }
        if (!resp.body) {
          const data = new Uint8Array(await resp.arrayBuffer());
          throwIfLazyTransportAborted(transport.signal);
          loadedBytes = data.byteLength;
          await assertLazyIntegrity(data, details.kind, details.integrity);
          throwIfLazyTransportAborted(transport.signal);
          this.emitLazyDownload({
            ...base,
            status: "progress",
            loadedBytes,
            totalBytes: totalBytes ?? loadedBytes,
          });
          this.emitLazyDownload({
            ...base,
            status: "complete",
            loadedBytes,
            totalBytes: totalBytes ?? loadedBytes,
          });
          return data;
        }

        const reader = resp.body.getReader();
        const chunks: Uint8Array[] = [];
        try {
          try {
            while (true) {
              const { done, value } = await reader.read();
              throwIfLazyTransportAborted(transport.signal);
              if (done) break;
              if (!value) continue;
              chunks.push(value);
              loadedBytes += value.byteLength;
              if (details.integrity && loadedBytes > details.integrity.bytes) {
                // WHY: throw the authoritative bound violation first. The
                // enclosing catch cancels best-effort; a rejecting stream
                // cleanup must never turn integrity failure into a retry.
                throw new Error(
                  `Lazy ${details.kind} exceeded expected byte count ` +
                    `${details.integrity.bytes}`,
                );
              }
              this.emitLazyDownload({
                ...base,
                status: "progress",
                loadedBytes,
                totalBytes,
              });
            }
          } catch (error) {
            try {
              await reader.cancel(error);
            } catch {
              // Preserve the read failure; the stream may already be errored.
            }
            throw error;
          }
        } finally {
          reader.releaseLock();
        }

        const data = concatChunks(chunks, loadedBytes);
        throwIfLazyTransportAborted(transport.signal);
        await assertLazyIntegrity(data, details.kind, details.integrity);
        throwIfLazyTransportAborted(transport.signal);
        this.emitLazyDownload({
          ...base,
          status: "complete",
          loadedBytes,
          totalBytes: totalBytes ?? loadedBytes,
        });
        return data;
      } catch (err) {
        if (transport.signal?.aborted) {
          const reason = transport.signal.reason;
          const message = reason instanceof Error ? reason.message : String(reason);
          this.emitLazyDownload({
            ...base,
            status: "error",
            loadedBytes,
            totalBytes,
            error: message,
          });
          throw reason;
        }
        const retryDelay = attempt + 1 < MAX_LAZY_TRANSPORT_ATTEMPTS
          ? lazyTransportRetryDelayMs(err, attempt)
          : null;
        if (retryDelay !== null) {
          // WHY: a failed attempt never supplies bytes to the decoder or VFS.
          // Retrying only closed transport failures preserves truthful
          // integrity/decode errors while surviving an ephemeral CDN edge.
          try {
            await waitForLazyTransportRetry(retryDelay, transport.signal);
          } catch (waitError) {
            const reason = transport.signal?.aborted
              ? transport.signal.reason
              : waitError;
            const message = reason instanceof Error
              ? reason.message
              : String(reason);
            this.emitLazyDownload({
              ...base,
              status: "error",
              loadedBytes,
              totalBytes,
              error: message,
            });
            throw reason;
          }
          continue;
        }
        const message = err instanceof Error ? err.message : String(err);
        this.emitLazyDownload({
          ...base,
          status: "error",
          loadedBytes,
          totalBytes,
          error: message,
        });
        throw err;
      }
    }
    throw new Error("Lazy transport retry state became unreachable");
  }

  /**
   * Register a lazy file: creates an empty stub in SharedFS and records
   * metadata for ensureMaterialized() to fetch asynchronously before a
   * synchronous read or exec path consumes the file.
   * Returns the inode number (useful for forwarding to other instances).
   */
  registerLazyFile(
    path: string,
    url: string,
    size: number,
    mode = 0o755,
  ): number {
    // Ensure parent directories exist
    const parts = path.split("/").filter(Boolean);
    let current = "";
    for (let i = 0; i < parts.length - 1; i++) {
      current += "/" + parts[i];
      try {
        this.fs.mkdir(current, 0o755);
      } catch {
        /* exists */
      }
    }
    const st = this.fs.createLazyStub(path, mode);
    this.invalidateLazyData(st);
    this.lazyFiles.set(memoryFileSystemInodeKey(st.ino, st.generation), {
      ino: st.ino,
      generation: st.generation,
      dataSequence: st.dataSequence,
      path,
      paths: new Set([path]),
      url,
      size,
    });
    return st.ino;
  }

  /**
   * Import lazy file entries from another instance (e.g., main thread → worker).
   * Does not create files — assumes the files already exist in the SharedArrayBuffer.
   */
  importLazyEntries(entries: LazyFileEntry[]): void {
    this.importLazyEntriesInternal(entries, false);
  }

  private importLazyEntriesInternal(
    entries: LazyFileEntry[],
    trustedLegacySnapshot: boolean,
  ): void {
    for (const e of entries) {
      const isLegacy =
        e.generation === undefined || e.dataSequence === undefined;
      if (isLegacy && !trustedLegacySnapshot) {
        throw new Error(
          "Live lazy-file metadata requires inode generation and data sequence",
        );
      }
      const validPaths = new Set<string>();
      let identity: SfsStatResult | null = null;
      for (const path of new Set([e.path, ...(e.paths ?? [])])) {
        let st: SfsStatResult;
        try {
          st = this.fs.stat(path);
        } catch {
          continue;
        }
        if (st.ino !== e.ino) continue;
        if (e.generation !== undefined && st.generation !== e.generation) {
          continue;
        }
        if (e.dataSequence === undefined) {
          if (!MemoryFileSystem.canAdoptLegacyLazyStub(st)) continue;
        } else if (st.dataSequence !== e.dataSequence) continue;
        identity ??= st;
        validPaths.add(path);
      }
      if (!identity || validPaths.size === 0) continue;
      const primaryPath = validPaths.has(e.path)
        ? e.path
        : validPaths.values().next().value!;
      this.lazyFiles.set(
        memoryFileSystemInodeKey(identity.ino, identity.generation),
        {
          ino: identity.ino,
          generation: identity.generation,
          dataSequence: identity.dataSequence,
          path: primaryPath,
          paths: validPaths,
          url: e.url,
          size: e.size,
        },
      );
    }
  }

  private serializeLazyEntries(): LazyFileEntry[] {
    const entries: LazyFileEntry[] = [];
    for (const {
      ino,
      generation,
      dataSequence,
      path,
      paths,
      url,
      size,
    } of this.lazyFiles.values()) {
      entries.push({
        ino,
        generation,
        dataSequence,
        path,
        paths: Array.from(paths),
        url,
        size,
      });
    }
    return entries;
  }

  /** Export all pending lazy entries for transfer to another instance. */
  exportLazyEntries(): LazyFileEntry[] {
    this.reconcileLazyIdentityState(this.fs.identityState());
    return this.serializeLazyEntries();
  }

  /** Return lazy metadata for `path`, following symlinks through stat(). */
  getLazyEntry(path: string): LazyFileEntry | null {
    try {
      const st = this.fs.stat(path);
      const entry = this.lazyFileForStat(st);
      return entry
        ? {
            ino: st.ino,
            generation: st.generation,
            dataSequence: st.dataSequence,
            path: entry.path,
            paths: Array.from(entry.paths),
            url: entry.url,
            size: entry.size,
          }
        : null;
    } catch {
      return null;
    }
  }

  /**
   * Report whether `path` currently resolves to any deferred backing without
   * starting I/O. This follows symlinks and covers both legacy lazy files and
   * typed archive/tree registrations.
   */
  isPathDeferred(path: string): boolean {
    return this.lazyBackingForPath(path) !== null;
  }

  /**
   * Rewrite the URL of every registered lazy file. Useful when a VFS image
   * was built with placeholder URLs and the browser runtime needs to replace
   * them with bundler-produced asset URLs.
   */
  rewriteLazyFileUrls(transform: (url: string, path: string) => string): void {
    for (const entry of this.lazyFiles.values()) {
      entry.url = transform(entry.url, entry.path);
    }
  }

  /**
   * Register a format-neutral immutable filesystem tree. The complete
   * inventory is validated before namespace mutation. One stub is created per
   * inode group and hard-link names are attached to that same SharedFS inode.
   */
  registerLazyTree(
    contentValue: LazyTreeContent,
    entriesValue: readonly LazyTreeRegistrationEntry[],
    mountPrefix = "/",
    activationValue?: LazyTreeActivation,
    ownerValue?: LazyTreeRegistrationOwner,
  ): LazyTreeGroup {
    return this.registerLazyTreeInternal(
      contentValue,
      entriesValue,
      mountPrefix,
      activationValue,
      false,
      ownerValue,
    );
  }

  private registerLazyTreeInternal(
    contentValue: LazyTreeContent,
    entriesValue: readonly LazyTreeRegistrationEntry[],
    mountPrefix: string,
    activationValue: LazyTreeActivation | undefined,
    allowTransportlessDirectMaterialization: boolean,
    ownerValue: LazyTreeRegistrationOwner | undefined,
  ): LazyTreeGroup {
    this.assertCanRegisterPendingLazyArchiveGroup();
    const canonicalMountPrefix = normalizeLazyArchiveMountPrefix(mountPrefix);
    const {
      content,
      entries,
      mountPrefix: validatedMountPrefix,
      activation,
      canonicalByGroup,
    } = validateLazyTreeDefinition(
      contentValue,
      entriesValue,
      canonicalMountPrefix,
      activationValue ?? {
        mode: "first-use",
        capabilities: ["deferred-tree"],
        roots: [canonicalMountPrefix],
      },
      allowTransportlessDirectMaterialization ? 0 : 1,
    );
    const owner = ownerValue === undefined
      ? undefined
      : validateLazyTreeRegistrationOwner(ownerValue);
    const existingAtomicGroup = activation.atomicGroup === undefined
      ? undefined
      : this.lazyAtomicGroups.get(activation.atomicGroup.id);
    if (
      existingAtomicGroup?.committed ||
      (
        existingAtomicGroup !== undefined &&
        (
          existingAtomicGroup.expectedCount !== undefined ||
          existingAtomicGroup.groups.has(activation.atomicGroup!.member)
        )
      )
    ) {
      // WHY: registration mutates the namespace. Rejecting a late cohort
      // member after creating its stubs would itself expose a partial tree.
      throw new Error(
        `Lazy atomic activation group ${activation.atomicGroup?.id} ` +
          "cannot accept this member",
      );
    }

    const group: LazyTreeGroup = {
      content,
      url: content.transports[0] ?? "",
      mountPrefix: validatedMountPrefix,
      integrity: { sha256: content.sha256, bytes: content.bytes },
      materialized: false,
      inventory: entries.map((entry) => ({ ...entry })),
      activation,
      entries: new Map(),
    };
    const ensureParents = (path: string): void => {
      const parts = path.split("/").filter(Boolean);
      let current = "";
      for (let index = 0; index < parts.length - 1; index++) {
        current += `/${parts[index]}`;
        try {
          this.fs.mkdir(current, 0o755);
        } catch {
          const existing = this.fs.lstat(current);
          if ((existing.mode & S_IFMT) !== S_IFDIR) {
            throw new Error(`Lazy tree ancestor ${current} is not a directory`);
          }
        }
      }
    };

    for (const entry of [...entries].sort((left, right) =>
      left.vfsPath.split("/").length - right.vfsPath.split("/").length
    )) {
      if (entry.type !== "directory") continue;
      ensureParents(entry.vfsPath);
      try {
        this.fs.mkdir(entry.vfsPath, entry.mode);
        this.fs.chmod(entry.vfsPath, entry.mode);
      } catch {
        const existing = this.fs.lstat(entry.vfsPath);
        if ((existing.mode & S_IFMT) !== S_IFDIR) {
          throw new Error(`Lazy tree directory collides at ${entry.vfsPath}`);
        }
      }
    }

    for (const entry of entries) {
      if (entry.type !== "symlink") continue;
      ensureParents(entry.vfsPath);
      this.fs.symlink(entry.target!, entry.vfsPath);
      const st = this.fs.lstat(entry.vfsPath);
      group.entries.set(entry.vfsPath, {
        ino: st.ino,
        generation: st.generation,
        dataSequence: st.dataSequence,
        size: entry.size,
        isSymlink: true,
        deleted: false,
        materialized: true,
        archivePath: entry.sourcePath,
        sourcePath: entry.sourcePath,
        type: "symlink",
        target: entry.target,
      });
    }

    const stateByGroup = new Map<string, SfsStatResult>();
    for (const entry of entries) {
      if (entry.type !== "file") continue;
      ensureParents(entry.vfsPath);
      const st = this.fs.createLazyStub(entry.vfsPath, entry.mode);
      this.invalidateLazyData(st);
      stateByGroup.set(entry.inodeGroup!, st);
      const metadata: LazyArchiveFileEntry = {
        ino: st.ino,
        generation: st.generation,
        dataSequence: st.dataSequence,
        size: entry.size,
        isSymlink: false,
        deleted: false,
        materialized: false,
        archivePath: entry.sourcePath,
        sourcePath: entry.sourcePath,
        type: "file",
        inodeGroup: entry.inodeGroup,
      };
      group.entries.set(entry.vfsPath, metadata);
    }

    for (const entry of entries) {
      if (entry.type !== "hardlink") continue;
      const canonical = canonicalByGroup.get(entry.inodeGroup!)!;
      ensureParents(entry.vfsPath);
      this.fs.link(canonical.vfsPath, entry.vfsPath);
      const st = this.fs.lstat(entry.vfsPath);
      const expected = stateByGroup.get(entry.inodeGroup!)!;
      if (st.ino !== expected.ino || st.generation !== expected.generation) {
        throw new Error(`Lazy tree hardlink ${entry.vfsPath} did not share its inode`);
      }
      group.entries.set(entry.vfsPath, {
        ino: st.ino,
        generation: st.generation,
        dataSequence: st.dataSequence,
        size: entry.size,
        isSymlink: false,
        deleted: false,
        materialized: false,
        archivePath: canonical.sourcePath,
        sourcePath: entry.sourcePath,
        type: "hardlink",
        inodeGroup: entry.inodeGroup,
        target: entry.target,
      });
    }

    if (owner !== undefined) {
      // WHY: ownership is part of the package namespace contract. Apply it
      // before publishing any lazy-inode metadata or returning a direct
      // materialization handle, so callers cannot observe a registered tree
      // whose stubs still carry SharedFS's default owner.
      for (const entry of entries) {
        this.lchown(entry.vfsPath, owner.uid, owner.gid);
      }
    }
    for (const entry of group.entries.values()) {
      if (entry.isSymlink || entry.generation === undefined) continue;
      this.lazyArchiveInodes.set(
        memoryFileSystemInodeKey(entry.ino, entry.generation),
        group,
      );
    }
    this.lazyArchiveGroups.push(group);
    this.registerLazyAtomicGroupMembership(group);
    if (activation.atomicGroup === undefined) {
      this.ordinaryLazyTreeDefinitions.set(
        group,
        immutableLazyTreeDefinitionSnapshot(
          content,
          entries,
          activation,
          group.url,
          validatedMountPrefix,
          group.integrity!,
          lazyTreeSnapshotEntries(group.entries),
          false,
        ),
      );
    }
    return group;
  }

  /**
   * Register one typed tree and return only an opaque direct-materialization
   * authority. The mutable internal group is deliberately not exposed.
   */
  registerLazyTreeWithMaterializationHandle(
    contentValue: LazyTreeContent,
    entriesValue: readonly LazyTreeRegistrationEntry[],
    mountPrefix = "/",
    activationValue?: LazyTreeActivation,
    ownerValue?: LazyTreeRegistrationOwner,
  ): DeferredTreeMaterializationHandle {
    const group = this.registerLazyTreeInternal(
      contentValue,
      entriesValue,
      mountPrefix,
      activationValue,
      true,
      ownerValue,
    );
    const handle = Object.freeze({
      [DEFERRED_TREE_MATERIALIZATION_HANDLE]: true as const,
    });
    this.deferredTreeMaterializationHandles.set(handle, group);
    return handle;
  }

  /**
   * Register a lazy archive group: creates stubs in SharedFS for every file
   * entry and records metadata so that accessing any one of them triggers a
   * single archive fetch that materializes all files in the group.
   *
   * Parse the zip's central directory (via host/src/vfs/zip.ts) and pass the
   * resulting ZipEntry[] in `zipEntries`. `mountPrefix` maps the zip's
   * internal paths into the VFS (e.g. prefix "/usr/" turns "bin/vim" into
   * "/usr/bin/vim").
   */
  registerLazyArchiveFromEntries(
    url: string,
    zipEntries: ZipEntry[],
    mountPrefix: string,
    symlinkTargets?: Map<string, string>,
    integrity?: LazyArchiveIntegrity,
  ): LazyArchiveGroup {
    // Validate and plan the entire archive before creating even one directory,
    // stub, symlink, inode mapping, or group. SharedFS resolves `..`, so
    // validating only while registering would allow an archive member to
    // escape its mount prefix or leave partial state after a later failure.
    const canonicalMountPrefix = normalizeLazyArchiveMountPrefix(mountPrefix);
    const plannedEntries = planLazyArchiveEntries(
      url,
      zipEntries,
      canonicalMountPrefix,
      symlinkTargets,
    );
    if (plannedEntries.some(({ entry }) => !entry.isDirectory && !entry.isSymlink)) {
      this.assertCanRegisterPendingLazyArchiveGroup();
    }
    const group: LazyArchiveGroup = {
      ...(integrity
        ? {
          content: validateLazyTreeContent({
            decoder: "zip-v1",
            mediaType: "application/zip",
            sha256: integrity.sha256,
            bytes: integrity.bytes,
            expandedBytes: plannedEntries.reduce(
              (total, planned) => total + planned.entry.uncompressedSize,
              0,
            ),
            sourceEntryCount: plannedEntries.length,
            transports: [url],
          }),
        }
        : {}),
      url,
      mountPrefix: canonicalMountPrefix,
      integrity: validateLazyArchiveIntegrity(integrity),
      materialized: false,
      entries: new Map(),
    };

    for (const { entry: ze, vfsPath } of plannedEntries) {
      if (ze.isDirectory) continue;

      const parts = vfsPath.split("/").filter(Boolean);
      let current = "";
      for (let i = 0; i < parts.length - 1; i++) {
        current += "/" + parts[i];
        try {
          this.fs.mkdir(current, 0o755);
        } catch {
          /* exists */
        }
      }

      if (ze.isSymlink) {
        const target = symlinkTargets!.get(ze.fileName)!;
        this.fs.symlink(target, vfsPath);
        const st = this.fs.lstat(vfsPath);
        const entry: LazyArchiveFileEntry = {
          ino: st.ino,
          generation: st.generation,
          dataSequence: st.dataSequence,
          size: ze.uncompressedSize,
          isSymlink: true,
          deleted: false,
          materialized: true,
          archivePath: ze.fileName,
          sourcePath: ze.fileName,
          type: "symlink",
        };
        group.entries.set(vfsPath, entry);
      } else {
        const st = this.fs.createLazyStub(vfsPath, ze.mode);
        this.invalidateLazyData(st);
        const entry: LazyArchiveFileEntry = {
          ino: st.ino,
          generation: st.generation,
          dataSequence: st.dataSequence,
          size: ze.uncompressedSize,
          isSymlink: false,
          deleted: false,
          materialized: false,
          archivePath: ze.fileName,
          sourcePath: ze.fileName,
          type: "file",
          inodeGroup: ze.fileName,
        };
        group.entries.set(vfsPath, entry);
        this.lazyArchiveInodes.set(
          memoryFileSystemInodeKey(st.ino, st.generation),
          group,
        );
      }
    }

    group.materialized = Array.from(group.entries.values()).every(
      (entry) => entry.deleted || entry.materialized,
    );
    this.lazyArchiveGroups.push(group);
    return group;
  }

  /** Import lazy archive groups from another instance. Assumes stubs already exist. */
  importLazyArchiveEntries(serialized: SerializedLazyArchiveEntry[]): void {
    this.importLazyArchiveEntriesInternal(serialized, false, true, "reject");
  }

  /**
   * Authenticate sealed archive metadata before publishing it into this live
   * filesystem. The caller must keep the underlying namespace quiescent while
   * this asynchronous trust check runs.
   */
  async importVerifiedLazyArchiveEntries(
    serialized: SerializedLazyArchiveEntry[],
  ): Promise<void> {
    // Keep one exact value across the asynchronous hash boundary. The caller
    // retains its input array and must not be able to swap in different claims
    // after verification but before live publication.
    const snapshot = structuredClone(serialized);
    const current = this.exportLazyArchiveEntries();
    const verifier = MemoryFileSystem.fromExisting(this.sharedBuffer);
    // WHY: import into an isolated metadata view first. Verification is async;
    // mutating this instance before it completes would leave forged groups
    // visible even though the registration request reports failure.
    verifier.importLazyArchiveEntriesInternal(
      [...current, ...snapshot],
      false,
      true,
      "pending",
    );
    await verifier.verifyImportedLazyAtomicGroupSeals();

    // Re-run structural and live-namespace checks against the current state,
    // then record that this exact serialized collection passed authentication.
    this.importLazyArchiveEntriesInternal(snapshot, false, true, "verified");
  }

  private importLazyArchiveEntriesInternal(
    serializedValue: unknown,
    trustedLegacySnapshot: boolean,
    requireDiscriminator: boolean,
    sealedImportTrust: "reject" | "pending" | "verified",
  ): void {
    const serialized = requireLazyTreeArray(
      serializedValue,
      "Serialized lazy archive groups",
      0,
      MAX_LAZY_TREE_GROUPS,
    ).map((value, index) => {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error(`Serialized lazy archive group ${index} must be an object`);
      }
      const kind = (value as Record<string, unknown>).kind;
      if (
        kind === SERIALIZED_DEFERRED_TREE_V1_KIND ||
        kind === SERIALIZED_DEFERRED_TREE_V2_KIND ||
        kind === SERIALIZED_DEFERRED_TREE_V3_KIND
      ) {
        return validateSerializedGenericTree(value, kind);
      }
      if (kind === SERIALIZED_LEGACY_ARCHIVE_KIND) {
        return validateSerializedLegacyArchive(value, false);
      }
      if (kind !== undefined) {
        throw new Error(`Serialized lazy archive group ${index} has an unsupported kind`);
      }
      if (requireDiscriminator) {
        throw new Error(
          `Serialized lazy archive group ${index} is missing its kind discriminator`,
        );
      }
      return validateSerializedLegacyArchive(value, true);
    });
    const currentIdentities = this.fs.identityState();
    this.reconcileLazyIdentityState(currentIdentities);
    const combinedSerialized = [
      ...this.serializeValidatedLazyArchiveEntries(currentIdentities),
      ...serialized,
    ];
    validateCompleteSerializedLazyArchiveCollection(combinedSerialized);
    const plannedGroups: LazyArchiveGroup[] = [];
    const plannedInodes = new Map<string, LazyArchiveGroup>();
    for (const s of serialized) {
      const entries = new Map<string, LazyArchiveFileEntry>();
      const normalizedPrefix = s.mountPrefix.replace(/\/+$/, "");
      const genericTree = s.content !== undefined && s.inventory !== undefined &&
        s.activation !== undefined;
      const inventoryByPath = genericTree
        ? new Map(s.inventory!.map((entry) => [entry.vfsPath, entry]))
        : null;
      const inventoryByIdentity = genericTree
        ? new Map(s.inventory!.map((entry) => [
          lazyTreeInventoryIdentityKey(entry),
          entry,
        ]))
        : null;
      const identityByGroup = new Map<string, string>();
      const groupByIdentity = new Map<string, string>();
      const regularStatByPath = new Map<string, SfsStatResult>();
      for (const e of s.entries) {
        let st: SfsStatResult | null = null;
        const materialized =
          s.materialized || e.materialized === true || e.isSymlink;
        if (!e.deleted && !materialized) {
          const isLegacy =
            e.generation === undefined || e.dataSequence === undefined;
          if (isLegacy && !trustedLegacySnapshot) {
            throw new Error(
              "Live lazy-archive metadata requires inode generation and data sequence",
            );
          }
          try {
            st = this.fs.lstat(e.vfsPath);
          } catch {
            if (genericTree) {
              throw new Error(
                `Serialized lazy tree stub ${e.vfsPath} is missing from the filesystem`,
              );
            }
            continue;
          }
          if (st.ino !== e.ino) {
            if (genericTree) {
              throw new Error(
                `Serialized lazy tree stub ${e.vfsPath} has a different inode`,
              );
            }
            continue;
          }
          if (e.generation !== undefined && st.generation !== e.generation) {
            if (genericTree) {
              throw new Error(
                `Serialized lazy tree stub ${e.vfsPath} has a different generation`,
              );
            }
            continue;
          }
          if (e.dataSequence === undefined) {
            if (!MemoryFileSystem.canAdoptLegacyLazyStub(st)) {
              if (genericTree) {
                throw new Error(
                  `Serialized lazy tree stub ${e.vfsPath} is not pristine`,
                );
              }
              continue;
            }
          } else if (st.dataSequence !== e.dataSequence) {
            if (genericTree) {
              throw new Error(
                `Serialized lazy tree stub ${e.vfsPath} has a different data sequence`,
              );
            }
            continue;
          }
          if (genericTree) {
            regularStatByPath.set(e.vfsPath, st);
            const inventoryAtPath = inventoryByPath!.get(e.vfsPath);
            const inventoryEntry =
              inventoryByIdentity!.get(lazyTreeInventoryIdentityKey(e)) ??
              inventoryAtPath;
            if (
              !inventoryEntry || (st.mode & S_IFMT) !== S_IFREG || st.size !== 0 ||
              (st.mode & FILE_MODES.S_MODE_BITS) !== inventoryEntry.mode ||
              (inventoryAtPath?.inodeGroup !== undefined &&
                inventoryAtPath.inodeGroup !== inventoryEntry.inodeGroup)
            ) {
              throw new Error(
                `Serialized lazy tree stub ${e.vfsPath} disagrees with its inventory`,
              );
            }
            const identity = memoryFileSystemInodeKey(st.ino, st.generation);
            const group = e.inodeGroup!;
            const priorIdentity = identityByGroup.get(group);
            const priorGroup = groupByIdentity.get(identity);
            if (
              (priorIdentity !== undefined && priorIdentity !== identity) ||
              (priorGroup !== undefined && priorGroup !== group)
            ) {
              throw new Error(
                `Serialized lazy tree inode group ${group} disagrees with the filesystem`,
              );
            }
            identityByGroup.set(group, identity);
            groupByIdentity.set(identity, group);
          }
        }
        entries.set(e.vfsPath, {
          ino: e.ino,
          generation: st?.generation ?? e.generation,
          dataSequence: st?.dataSequence ?? e.dataSequence,
          size: e.size,
          isSymlink: e.isSymlink,
          deleted: e.deleted,
          materialized,
          archivePath:
            e.archivePath ?? e.vfsPath.slice(normalizedPrefix.length + 1),
          sourcePath:
            e.sourcePath ?? e.archivePath ??
              e.vfsPath.slice(normalizedPrefix.length + 1),
          type: e.type ?? (e.isSymlink ? "symlink" : "file"),
          inodeGroup: e.inodeGroup,
          target: e.target,
        });
      }
      if (genericTree) {
        const declaredAliasesByGroup = new Map<string, number>();
        for (const inventoryEntry of s.inventory!) {
          if (
            inventoryEntry.type === "file" ||
            inventoryEntry.type === "hardlink"
          ) {
            declaredAliasesByGroup.set(
              inventoryEntry.inodeGroup!,
              (declaredAliasesByGroup.get(inventoryEntry.inodeGroup!) ?? 0) + 1,
            );
            continue;
          }
          let st: SfsStatResult;
          try {
            st = this.fs.lstat(inventoryEntry.vfsPath);
          } catch {
            throw new Error(
              `Serialized lazy tree namespace entry ${inventoryEntry.vfsPath} ` +
                "is missing from the filesystem",
            );
          }
          const expectedType = inventoryEntry.type === "directory"
            ? S_IFDIR
            : S_IFLNK;
          if (
            (st.mode & S_IFMT) !== expectedType ||
            (st.mode & FILE_MODES.S_MODE_BITS) !== inventoryEntry.mode ||
            (
              inventoryEntry.type === "symlink" &&
              (
                st.size !== new TextEncoder().encode(inventoryEntry.target!).byteLength ||
                this.fs.readlink(inventoryEntry.vfsPath) !== inventoryEntry.target
              )
            )
          ) {
            throw new Error(
              `Serialized lazy tree namespace entry ${inventoryEntry.vfsPath} ` +
                "disagrees with its inventory",
            );
          }
          if (inventoryEntry.type === "symlink") {
            entries.set(inventoryEntry.vfsPath, {
              ino: st.ino,
              generation: st.generation,
              dataSequence: st.dataSequence,
              size: inventoryEntry.size,
              isSymlink: true,
              deleted: false,
              materialized: true,
              archivePath: inventoryEntry.sourcePath,
              sourcePath: inventoryEntry.sourcePath,
              type: "symlink",
              target: inventoryEntry.target,
            });
          }
        }
        if (s.activation?.atomicGroup !== undefined) {
          for (const inventoryEntry of s.inventory!) {
            if (
              inventoryEntry.type !== "file" &&
              inventoryEntry.type !== "hardlink"
            ) continue;
            const st = regularStatByPath.get(inventoryEntry.vfsPath)!;
            if (
              st.linkCount !==
                declaredAliasesByGroup.get(inventoryEntry.inodeGroup!)!
            ) {
              throw new Error(
                `Serialized lazy atomic tree inode group ` +
                  `${inventoryEntry.inodeGroup} has undeclared aliases`,
              );
            }
          }
        }
      }
      const content = s.content === undefined
        ? undefined
        : validateLazyTreeContent(s.content);
      const group: LazyArchiveGroup = {
        content,
        url: content?.transports[0] ?? s.url,
        mountPrefix: s.mountPrefix,
        integrity: content
          ? { sha256: content.sha256, bytes: content.bytes }
          : validateLazyArchiveIntegrity(s.integrity),
        materialized: s.materialized || (
          !(content && s.inventory) &&
          Array.from(entries.values()).every(
            (entry) => entry.deleted || entry.materialized,
          )
        ),
        inventory: s.inventory?.map((entry) => ({ ...entry })),
        activation: s.activation
          ? {
            mode: s.activation.mode,
            capabilities: [...s.activation.capabilities],
            roots: [...s.activation.roots],
            ...(s.activation.atomicGroup === undefined
              ? {}
              : { atomicGroup: { ...s.activation.atomicGroup } }),
          }
          : undefined,
        entries,
      };
      plannedGroups.push(group);
      if (!group.materialized) {
        for (const [, entry] of entries) {
          if (
            !entry.deleted &&
            !entry.materialized &&
            entry.generation !== undefined
          ) {
            const key = memoryFileSystemInodeKey(entry.ino, entry.generation);
            const planned = plannedInodes.get(key);
            if (planned !== undefined && planned !== group) {
              throw new Error(
                `Serialized lazy archive groups share pending inode ${key}`,
              );
            }
            if (this.lazyArchiveInodes.has(key)) {
              throw new Error(
                `Serialized lazy archive group collides with pending inode ${key}`,
              );
            }
            plannedInodes.set(key, group);
          }
        }
      }
    }
    for (const group of plannedGroups) {
      const membership = group.activation?.atomicGroup;
      if (
        membership !== undefined &&
        this.lazyAtomicGroups.get(membership.id)?.committed
      ) {
        throw new Error(
          `Lazy atomic activation group ${membership.id} is already materialized`,
        );
      }
    }
    if (
      sealedImportTrust === "reject" &&
      plannedGroups.some((group) => {
        const membership = group.activation?.atomicGroup;
        return membership !== undefined &&
          isSealedLazyAtomicMembership(membership);
      })
    ) {
      // WHY: this synchronous API cannot authenticate SHA-256 claims. Letting
      // it publish sealed v3 metadata would make the unsafe path look trusted
      // merely because the caller chose the older import method.
      throw new Error(
        "Sealed lazy archive registrations require " +
          "importVerifiedLazyArchiveEntries()",
      );
    }
    this.lazyArchiveGroups.push(...plannedGroups);
    for (const group of plannedGroups) {
      this.registerLazyAtomicGroupMembership(
        group,
        sealedImportTrust === "verified",
      );
      if (
        group.content !== undefined && group.inventory !== undefined &&
        group.activation !== undefined &&
        group.activation.atomicGroup === undefined
      ) {
        this.ordinaryLazyTreeDefinitions.set(
          group,
          immutableLazyTreeDefinitionSnapshot(
            group.content,
            group.inventory,
            group.activation,
            group.url,
            group.mountPrefix,
            group.integrity!,
            lazyTreeSnapshotEntries(group.entries),
            group.materialized,
          ),
        );
      }
    }
    for (const [key, group] of plannedInodes) {
      this.lazyArchiveInodes.set(key, group);
    }
  }

  /**
   * Rewrite the URL of every registered lazy archive group. Useful when the
   * VFS image was built with relative URLs (e.g. "vim.zip") and the runtime
   * needs to resolve them against a deployment base URL.
   */
  rewriteLazyArchiveUrls(transform: (url: string) => string): void {
    for (const group of this.lazyArchiveGroups) {
      const atomicGroup = this.lazyAtomicGroupByTree.get(group);
      const atomicState = this.sealedLazyAtomicStates.get(group);
      if (atomicState !== undefined && !atomicGroup?.committed) {
        this.assertLazyAtomicSnapshotMatchesPublic(group);
        const snapshot = rewriteSealedLazyAtomicSnapshotTransports(
          atomicState.snapshot,
          transform,
        );
        // WHY: URL rewriting is the one authorized post-seal deployment
        // mutation. Replace both private and public values from the private
        // snapshot so arbitrary public edits never become transport authority.
        group.content = cloneLazyTreeContent(snapshot.content);
        group.url = snapshot.url;
        group.integrity = { ...snapshot.integrity };
        atomicState.snapshot = snapshot;
        continue;
      }
      const ordinaryDefinition = this.ordinaryLazyTreeDefinitions.get(group);
      if (ordinaryDefinition !== undefined) {
        const content = immutableLazyTreeContent(
          ordinaryDefinition.content,
          ordinaryDefinition.content.transports.map(transform),
        );
        const next = immutableLazyTreeDefinitionSnapshot(
          content,
          ordinaryDefinition.inventory,
          ordinaryDefinition.activation,
          content.transports[0]!,
          ordinaryDefinition.mountPrefix,
          ordinaryDefinition.integrity,
          ordinaryDefinition.entries,
          ordinaryDefinition.materialized,
        );
        this.ordinaryLazyTreeDefinitions.set(group, next);
        group.content = cloneLazyTreeContent(next.content);
        group.url = next.url;
        group.integrity = { ...next.integrity };
      } else if (group.content) {
        group.content = {
          ...group.content,
          transports: group.content.transports.map(transform),
        };
        group.url = group.content.transports[0];
      } else {
        group.url = transform(group.url);
      }
    }
  }

  private serializeLazyArchiveEntries(): SerializedLazyArchiveEntry[] {
    const serialized: SerializedLazyArchiveEntry[] = [];
    for (const group of this.lazyArchiveGroups) {
      const atomicGroup = this.lazyAtomicGroupByTree.get(group);
      const atomicState = this.sealedLazyAtomicStates.get(group);
      if (atomicState !== undefined) {
        if (atomicGroup?.committed) continue;
        const snapshot = atomicState.snapshot;
        if (snapshot.content.transports.length === 0) {
          throw new Error(
            "Direct-materialization tree must be materialized before serialization",
          );
        }
        serialized.push({
          kind: SERIALIZED_DEFERRED_TREE_V3_KIND,
          content: cloneLazyTreeContent(snapshot.content),
          inventory: snapshot.inventory.map((entry) => ({ ...entry })),
          activation: sealedLazyTreeActivation(snapshot),
          url: snapshot.url,
          mountPrefix: snapshot.mountPrefix,
          integrity: { ...snapshot.integrity },
          materialized: false,
          entries: snapshot.entries
            .filter((entry) => !entry.deleted && !entry.materialized)
            .map(({ vfsPath, ...entry }) => ({ vfsPath, ...entry })),
        });
        continue;
      }
      const ordinaryDefinition = this.ordinaryLazyTreeDefinitions.get(group);
      const materialized = ordinaryDefinition?.materialized ?? group.materialized;
      const entries = (
        ordinaryDefinition?.entries ?? lazyTreeSnapshotEntries(group.entries)
      ).map((entry) => ({ ...entry }))
        .filter((entry) => !entry.deleted && !entry.materialized);
      const content = ordinaryDefinition?.content ?? group.content;
      const inventory = ordinaryDefinition?.inventory ?? group.inventory;
      const activation = ordinaryDefinition?.activation ?? group.activation;
      const url = ordinaryDefinition?.url ?? group.url;
      const mountPrefix = ordinaryDefinition?.mountPrefix ?? group.mountPrefix;
      const integrity = ordinaryDefinition?.integrity ?? group.integrity;
      if (
        entries.length === 0 &&
        !(content !== undefined && inventory !== undefined && !materialized)
      ) continue;
      const genericTree = content !== undefined && inventory !== undefined &&
        activation !== undefined;
      if (genericTree && content.transports.length === 0) {
        throw new Error(
          "Direct-materialization tree must be materialized before serialization",
        );
      }
      const atomicMembership = activation?.atomicGroup;
      if (
        atomicMembership !== undefined &&
        !isSealedLazyAtomicMembership(atomicMembership)
      ) {
        throw new Error(
          `Lazy atomic activation group ${atomicMembership.id} must be sealed ` +
            "before serialization",
        );
      }
      serialized.push(genericTree
        ? {
          kind: atomicMembership !== undefined
            ? SERIALIZED_DEFERRED_TREE_V3_KIND
            : content.source === undefined
              ? SERIALIZED_DEFERRED_TREE_V1_KIND
              : SERIALIZED_DEFERRED_TREE_V2_KIND,
          content: cloneLazyTreeContent(content),
          inventory: inventory.map((entry) => ({ ...entry })),
          activation: {
            ...activation,
            capabilities: [...activation.capabilities],
            roots: [...activation.roots],
          },
          url,
          mountPrefix,
          integrity: { ...integrity! },
          materialized: false,
          entries,
        }
        : {
          kind: SERIALIZED_LEGACY_ARCHIVE_KIND,
          url: group.url,
          mountPrefix: group.mountPrefix,
          integrity: group.integrity,
          materialized: false,
          entries,
        });
    }
    return serialized;
  }

  private serializeValidatedLazyArchiveEntries(
    identities: Map<string, SharedFsIdentityState>,
  ): SerializedLazyArchiveEntry[] {
    this.assertPendingLazyAtomicSnapshotsReadyForSerialization();
    const serialized = this.serializeLazyArchiveEntries();
    validateCompleteSerializedLazyArchiveCollection(serialized);
    this.validatePendingLazyTreeNamespaceState(identities);
    return serialized;
  }

  /** Export all pending lazy archive groups for transfer to another instance. */
  exportLazyArchiveEntries(): SerializedLazyArchiveEntry[] {
    const identities = this.fs.identityState();
    this.reconcileLazyIdentityState(identities);
    return this.serializeValidatedLazyArchiveEntries(identities);
  }

  /** Return aggregate resources that a saved image would retain lazily. */
  pendingDeferredTreeUsage(): VfsDeferredTreeUsage {
    const identities = this.fs.identityState();
    this.reconcileLazyIdentityState(identities);
    return summarizeSerializedDeferredTreeCollection(
      this.serializeValidatedLazyArchiveEntries(identities),
    );
  }

  /**
   * Prove that additional deferred-tree metadata can still be serialized and
   * restored together with the groups already pending in this filesystem.
   */
  assertCanAppendDeferredTreeUsage(additional: VfsDeferredTreeUsage): void {
    validateDeferredTreeUsage(additional);
    const pending = this.pendingDeferredTreeUsage();
    validateDeferredTreeUsage({
      groups: pending.groups + additional.groups,
      archiveBytes: pending.archiveBytes + additional.archiveBytes,
      expandedBytes: pending.expandedBytes + additional.expandedBytes,
      payloadBytes: pending.payloadBytes + additional.payloadBytes,
      entries: pending.entries + additional.entries,
    });
  }

  private assertCanRegisterPendingLazyArchiveGroup(): void {
    this.reconcileLazyIdentityState(this.fs.identityState());
    const pendingGroups = this.lazyArchiveGroups.filter((group) => {
      const atomicGroup = this.lazyAtomicGroupByTree.get(group);
      const snapshot = this.sealedLazyAtomicStates.get(group)?.snapshot;
      if (snapshot !== undefined) return !atomicGroup?.committed;
      const ordinaryDefinition = this.ordinaryLazyTreeDefinitions.get(group);
      return !(ordinaryDefinition?.materialized ?? group.materialized) && (
        ordinaryDefinition !== undefined ||
        Array.from(group.entries.values()).some((entry) =>
          !entry.deleted && !entry.materialized
        )
      );
    }).length;
    if (pendingGroups >= VFS_DEFERRED_TREE_COLLECTION_LIMITS.maxGroups) {
      throw new Error(
        `Cannot register another lazy archive group: ` +
          `${VFS_DEFERRED_TREE_COLLECTION_LIMITS.maxGroups} pending groups already exist`,
      );
    }
  }

  /**
   * Async-materialize a lazy file or archive-backed file if the given path
   * resolves to one. Call this before any synchronous read (e.g. in
   * handleExec) to avoid sync XHR which deadlocks with COOP/COEP.
   * Returns true if something was materialized, false if already concrete.
   */
  async preparePath(path: string): Promise<boolean> {
    let materialized = false;
    const maximumAttempts = Math.max(3, this.lazyArchiveGroups.length + 1);
    for (let attempt = 0; attempt < maximumAttempts; attempt++) {
      const backing = this.lazyBackingForPath(path);
      if (!backing) return materialized;
      const preparation = this.lazyPreparations.get(backing.token) ??
        this.startLazyPreparation(backing);
      try {
        materialized = (await preparation.promise) || materialized;
      } finally {
        if (this.lazyPreparations.get(backing.token) === preparation) {
          this.lazyPreparations.delete(backing.token);
        }
      }
    }
    if (this.lazyBackingForPath(path)) {
      throw new Error(`Lazy backing kept changing identity while preparing: ${path}`);
    }
    return materialized;
  }

  /**
   * Resolve every tree whose capability policy requires bytes before boot.
   * Registration/stat remain inert; callers choose the boot boundary and any
   * failure aborts that boundary instead of exposing zero-byte stubs.
   */
  async prepareBootDeferredTrees(): Promise<number> {
    const groups = this.lazyArchiveGroups.filter(
      (group) => {
        const definition = this.ordinaryLazyTreeDefinitions.get(group);
        return !(definition?.materialized ?? group.materialized) &&
          (definition?.activation ?? group.activation)?.mode === "boot-prefetch";
      },
    );
    let next = 0;
    let failure: unknown;
    const workers = Array.from(
      { length: Math.min(groups.length, MAX_BOOT_DEFERRED_TREE_CONCURRENCY) },
      async () => {
        while (failure === undefined) {
          const index = next;
          next += 1;
          if (index >= groups.length) return;
          try {
            await this.prepareLazyTreeGroup(groups[index]);
          } catch (error) {
            failure ??= error;
          }
        }
      },
    );
    await Promise.all(workers);
    if (failure !== undefined) throw failure;
    return groups.length;
  }

  /**
   * Materialize one exact typed tree authorized by this filesystem's opaque
   * registration wrapper. Build-time composers use this to embed a reviewed
   * package subset without re-pouring a smaller closure and thereby changing
   * global path/conflict ownership.
   */
  async materializeRegisteredDeferredTree(
    handle: DeferredTreeMaterializationHandle,
    exactBytes: Uint8Array,
  ): Promise<boolean> {
    const group = this.deferredTreeMaterializationHandles.get(handle);
    if (group === undefined) {
      throw new Error(
        "Deferred-tree handle was not issued by this filesystem",
      );
    }
    const atomicGroup = this.lazyAtomicGroupByTree.get(group);
    if (atomicGroup !== undefined) {
      throw new Error(
        `Deferred tree belongs to atomic activation group ${atomicGroup.id}; ` +
          "materialize the complete group instead",
      );
    }
    const ordinaryDefinition = this.ordinaryLazyTreeDefinitions.get(group);
    if (ordinaryDefinition?.materialized ?? group.materialized) return false;
    const existing = this.lazyPreparations.get(group);
    if (existing !== undefined) return existing.promise;
    const bytes = new Uint8Array(exactBytes.byteLength);
    bytes.set(exactBytes);
    const preparation = {
      status: "pending",
      promise: Promise.resolve(false),
    } as LazyPreparation;
    // Defer the first await until after the shared preparation slot is owned,
    // so a concurrent guest preparePath() joins this exact-byte operation
    // instead of starting a transport fetch for the same group.
    preparation.promise = Promise.resolve().then(async () => {
      const integrity = this.ordinaryLazyTreeDefinitions.get(group)?.integrity ??
        group.integrity;
      await assertLazyIntegrity(bytes, "tree", integrity);
      await this.materializeArchiveBytes(group, bytes);
      return true;
    }).then(
      (materialized) => {
        preparation.status = "fulfilled";
        return materialized;
      },
      (error) => {
        preparation.status = "rejected";
        preparation.error = error;
        throw error;
      },
    );
    void preparation.promise.catch(() => {});
    this.lazyPreparations.set(group, preparation);
    try {
      return await preparation.promise;
    } finally {
      if (this.lazyPreparations.get(group) === preparation) {
        this.lazyPreparations.delete(group);
      }
    }
  }

  private async prepareLazyTreeGroup(group: LazyTreeGroup): Promise<boolean> {
    const atomicGroup = this.lazyAtomicGroupByTree.get(group);
    const ordinaryDefinition = this.ordinaryLazyTreeDefinitions.get(group);
    if (
      atomicGroup?.committed ||
      (atomicGroup === undefined &&
        (ordinaryDefinition?.materialized ?? group.materialized))
    ) {
      return false;
    }
    const snapshot = this.sealedLazyAtomicStates.get(group)?.snapshot;
    const backing: LazyBacking = {
      token: atomicGroup?.token ?? group,
      path: snapshot?.activation.roots[0] ??
        ordinaryDefinition?.activation.roots[0] ??
        ordinaryDefinition?.mountPrefix ??
        group.activation?.roots[0] ?? group.mountPrefix,
      directGroup: group,
      ...(atomicGroup === undefined ? {} : { atomicGroup }),
    };
    const preparation = this.lazyPreparations.get(backing.token) ??
      this.startLazyPreparation(backing);
    try {
      return await preparation.promise;
    } finally {
      if (this.lazyPreparations.get(backing.token) === preparation) {
        this.lazyPreparations.delete(backing.token);
      }
    }
  }

  /** Backward-compatible explicit preparation entrypoint. */
  async ensureMaterialized(path: string): Promise<boolean> {
    return this.preparePath(path);
  }

  private async materializePath(path: string): Promise<boolean> {
    if (this.lazyFiles.size === 0 && this.lazyArchiveInodes.size === 0)
      return false;
    let st: SfsStatResult;
    try {
      st = this.fs.stat(path); // follows symlinks
    } catch {
      return false;
    }
    const key = memoryFileSystemInodeKey(st.ino, st.generation);
    const entry = this.lazyFiles.get(key);
    if (entry) {
      const transport = this.lazyTransport;
      const data = await this.fetchLazyBytes({
        id: `file:${st.ino}`,
        kind: "file",
        url: entry.url,
        path: entry.path,
        fallbackTotalBytes: entry.size,
      }, transport);
      for (let attempt = 0; attempt < 3; attempt++) {
        if (this.lazyFiles.get(key) !== entry) return false;
        for (const candidate of new Set([path, ...entry.paths])) {
          throwIfLazyTransportAborted(transport.signal);
          const materialized = this.fs.replaceIfIdentity(
            candidate,
            entry.ino,
            entry.generation,
            entry.dataSequence,
            data,
          );
          if (materialized) {
            entry.path = candidate;
            this.lazyFiles.delete(key);
            return true;
          }
        }
        // A peer may have renamed the inode while the fetch was in flight.
        // Refresh aliases and retry immediately with the bytes already read.
        this.reconcileLazyIdentityState(this.fs.identityState());
      }
      throw new Error(
        `Lazy file kept changing names while materializing: ${path}`,
      );
    }
    const group = this.lazyArchiveInodes.get(key);
    if (group) {
      await this.ensureArchiveMaterialized(group, {
        path,
        ino: st.ino,
        generation: st.generation,
      });
      return !this.lazyArchiveInodes.has(key);
    }
    return false;
  }

  private async decodeAndValidateLazyTree(
    group: LazyTreeGroup,
    data: Uint8Array,
    atomicSnapshot?: SealedLazyAtomicSnapshot,
  ): Promise<Map<string, Uint8Array>> {
    const ordinaryDefinition = this.ordinaryLazyTreeDefinitions.get(group);
    const content = atomicSnapshot?.content ?? ordinaryDefinition?.content ??
      group.content;
    const inventory = atomicSnapshot?.inventory ?? ordinaryDefinition?.inventory ??
      group.inventory;
    if (!content || !inventory) {
      throw new Error("Lazy tree is missing its decoder or complete inventory");
    }
    const expectedBySource = new Map<string, LazyTreeSourceEntry>();
    const inventoryByPath = new Map(inventory.map((entry) => [entry.vfsPath, entry]));
    if (content.source !== undefined) {
      for (const entry of content.source.entries) {
        expectedBySource.set(entry.sourcePath, entry);
      }
    } else {
      for (const entry of inventory) {
        if (entry.type === "hardlink") {
          const target = inventoryByPath.get(entry.target!);
          if (!target) throw new Error(`Lazy tree hardlink target disappeared: ${entry.target}`);
          // The derived ZIP scaffold stores one source member per inode and
          // reconstructs aliases from inventory. Native TAR hardlinks retain a
          // distinct source member and are validated below.
          if (entry.sourcePath === target.sourcePath) continue;
        }
        const prior = expectedBySource.get(entry.sourcePath);
        if (prior) {
          throw new Error(`Lazy tree inventory duplicates source member ${entry.sourcePath}`);
        }
        expectedBySource.set(entry.sourcePath, {
          sourcePath: entry.sourcePath,
          type: entry.type,
          mode: entry.mode,
          size: entry.size,
          ...(entry.type === "symlink" ? { target: entry.target } : {}),
          ...(entry.type === "hardlink"
            ? { target: inventoryByPath.get(entry.target!)?.sourcePath }
            : {}),
        });
      }
    }

    const decoded = new Map<string, {
      type: "directory" | "file" | "symlink" | "hardlink";
      mode: number;
      data?: Uint8Array;
      target?: string;
    }>();
    let expandedBytes = 0;
    if (content.decoder === "zip-v1") {
      const { parseZipCentralDirectory, extractZipEntryBounded } =
        await import("./zip");
      const zipEntries = parseZipCentralDirectory(data);
      if (
        zipEntries.length !== content.sourceEntryCount ||
        zipEntries.length !== expectedBySource.size
      ) {
        throw new Error("Lazy ZIP tree decoded inventory counts differ from its descriptor");
      }
      for (const entry of zipEntries) {
        const sourcePath = entry.isDirectory
          ? entry.fileName.replace(/\/$/, "")
          : entry.fileName;
        if (decoded.has(sourcePath)) {
          throw new Error(`Lazy ZIP tree duplicates source member ${sourcePath}`);
        }
        const expected = expectedBySource.get(sourcePath);
        if (!expected) {
          throw new Error(`Lazy ZIP tree has undeclared source member ${sourcePath}`);
        }
        expandedBytes += entry.uncompressedSize;
        if (expandedBytes > content.expandedBytes || entry.uncompressedSize !== expected.size) {
          throw new Error(`Lazy ZIP tree member ${sourcePath} exceeds its inventory`);
        }
        const actualType = entry.isDirectory
          ? "directory"
          : entry.isSymlink
            ? "symlink"
            : "file";
        const actualMode = content.modePolicy === "portable-posix-v1"
          ? actualType === "directory"
            ? 0o755
            : actualType === "symlink"
              ? 0o777
              : (entry.mode & 0o111) !== 0
                ? 0o755
                : 0o644
          : entry.mode & FILE_MODES.S_MODE_BITS;
        if (
          actualType !== expected.type ||
          actualMode !== expected.mode
        ) {
          throw new Error(`Lazy ZIP tree member ${sourcePath} differs from inventory`);
        }
        if (entry.isDirectory) {
          decoded.set(sourcePath, { type: "directory", mode: actualMode });
        } else {
          const member = extractZipEntryBounded(data, entry, expected.size);
          if (entry.isSymlink) {
            let target: string;
            try {
              target = new TextDecoder("utf-8", { fatal: true }).decode(member);
            } catch {
              throw new Error(`Lazy ZIP tree symlink ${sourcePath} is not UTF-8`);
            }
            decoded.set(sourcePath, {
              type: "symlink",
              mode: actualMode,
              target,
            });
          } else {
            decoded.set(sourcePath, {
              type: "file",
              mode: actualMode,
              data: member,
            });
          }
        }
      }
    } else {
      const { parseTarGzip } = await import("./tar");
      const parsed = parseTarGzip(data, {
        label: `Lazy tree ${content.sha256}`,
        limits: {
          maxCompressedBytes: content.bytes,
          maxUncompressedBytes: content.expandedBytes,
          maxEntries: content.sourceEntryCount,
        },
      });
      expandedBytes = new DataView(
        data.buffer,
        data.byteOffset,
        data.byteLength,
      ).getUint32(data.byteLength - 4, true);
      for (const entry of parsed) {
        if (decoded.has(entry.path)) {
          throw new Error(`Lazy TAR tree duplicates source member ${entry.path}`);
        }
        if (entry.type === "file") {
          decoded.set(entry.path, {
            type: "file",
            mode: entry.mode,
            data: entry.data,
          });
        } else if (entry.type === "directory") {
          decoded.set(entry.path, { type: "directory", mode: entry.mode });
        } else {
          decoded.set(entry.path, {
            type: entry.type,
            mode: entry.mode,
            target: entry.linkName,
          });
        }
      }
    }
    if (
      decoded.size !== content.sourceEntryCount ||
      decoded.size !== expectedBySource.size ||
      expandedBytes !== content.expandedBytes
    ) {
      throw new Error("Lazy tree decoded inventory counts differ from its descriptor");
    }

    for (const [sourcePath, expected] of expectedBySource) {
      const actual = decoded.get(sourcePath);
      if (!actual) throw new Error(`Lazy tree is missing source member ${sourcePath}`);
      const expectedType = expected.type;
      if (actual.type !== expectedType) {
        throw new Error(
          `Lazy tree member ${sourcePath} is ${actual.type}, expected ${expectedType}`,
        );
      }
      if ((actual.mode & FILE_MODES.S_MODE_BITS) !== expected.mode) {
        throw new Error(`Lazy tree member ${sourcePath} mode differs from inventory`);
      }
      if (expectedType === "file" && actual.data?.byteLength !== expected.size) {
        throw new Error(`Lazy tree member ${sourcePath} size differs from inventory`);
      }
      if (expectedType === "symlink" && actual.target !== expected.target) {
        throw new Error(`Lazy tree symlink ${sourcePath} target differs from inventory`);
      }
      if (expectedType === "hardlink") {
        if (actual.target !== expected.target) {
          throw new Error(`Lazy tree hardlink ${sourcePath} target differs from inventory`);
        }
      }
    }

    const materialization = content.materialization;
    if (materialization !== undefined) {
      for (const assertion of materialization.assertions) {
        const actual = decoded.get(assertion.sourcePath);
        const expected = decodeMaterializationBytes(assertion.bytesHex);
        if (
          actual?.type !== "file" || actual.data === undefined ||
          actual.data.byteLength !== expected.byteLength ||
          actual.data.some((byte, index) => byte !== expected[index])
        ) {
          throw new Error(
            `Lazy tree source assertion ${assertion.sourcePath} differs from archive bytes`,
          );
        }
      }
      const recipes = new Map(
        materialization.recipes.map((recipe) => [recipe.id, recipe]),
      );
      for (const transform of materialization.transforms) {
        const actual = decoded.get(transform.sourcePath);
        if (actual?.type !== "file" || actual.data === undefined) {
          throw new Error(
            `Lazy tree transform ${transform.sourcePath} is not a regular source`,
          );
        }
        await assertLazyTreeByteIdentity(
          actual.data,
          transform.input,
          `Lazy tree transform ${transform.sourcePath} input`,
        );
        const transformed = applyLazyTreeByteTransformRecipe(
          actual.data,
          recipes.get(transform.recipe)!,
        );
        await assertLazyTreeByteIdentity(
          transformed,
          transform.output,
          `Lazy tree transform ${transform.sourcePath} output`,
        );
        actual.data = transformed;
      }
    }

    const files = new Map<string, Uint8Array>();
    for (const entry of inventory) {
      if (entry.type !== "file") continue;
      if (entry.materialization === "descriptor") continue;
      const decodedEntry = decoded.get(entry.sourcePath);
      if (decodedEntry?.type !== "file" || !decodedEntry.data) {
        throw new Error(`Lazy tree has no file content for ${entry.sourcePath}`);
      }
      files.set(entry.sourcePath, decodedEntry.data);
    }
    return files;
  }

  /**
   * Materialize a full lazy archive group: fetch the zip once, parse its
   * central directory, and write every non-deleted entry into its stub.
   * Subsequent calls are no-ops.
   */
  async ensureArchiveMaterialized(
    group: LazyArchiveGroup,
    requested?: { path: string; ino: number; generation: number },
  ): Promise<void> {
    const atomicGroup = this.lazyAtomicGroupByTree.get(group);
    if (atomicGroup !== undefined) {
      if (atomicGroup.committed) return;
      const snapshot = this.sealedLazyAtomicStates.get(group)?.snapshot;
      const preparation = this.lazyPreparations.get(atomicGroup.token) ??
        this.startLazyPreparation({
          token: atomicGroup.token,
          path: snapshot?.activation.roots[0] ??
            group.activation?.roots[0] ??
            group.mountPrefix,
          atomicGroup,
        });
      try {
        await preparation.promise;
      } finally {
        if (this.lazyPreparations.get(atomicGroup.token) === preparation) {
          this.lazyPreparations.delete(atomicGroup.token);
        }
      }
      return;
    }
    const ordinaryDefinition = this.ordinaryLazyTreeDefinitions.get(group);
    if (ordinaryDefinition?.materialized ?? group.materialized) return;
    const transport = this.lazyTransport;
    const archiveData = await this.fetchLazyArchiveData(group, transport);
    throwIfLazyTransportAborted(transport.signal);
    await this.materializeArchiveBytes(
      group,
      archiveData,
      requested,
      transport.signal,
    );
  }

  private async fetchLazyArchiveData(
    group: LazyArchiveGroup,
    transport: LazyTransport,
    atomicSnapshot?: SealedLazyAtomicSnapshot,
  ): Promise<Uint8Array> {
    const ordinaryDefinition = this.ordinaryLazyTreeDefinitions.get(group);
    const content = atomicSnapshot?.content ?? ordinaryDefinition?.content ??
      group.content;
    const inventory = atomicSnapshot?.inventory ?? ordinaryDefinition?.inventory ??
      group.inventory;
    const genericTree = content !== undefined && inventory !== undefined;
    const mountPrefix = atomicSnapshot?.mountPrefix ??
      ordinaryDefinition?.mountPrefix ?? group.mountPrefix;
    const integrity = atomicSnapshot?.integrity ?? ordinaryDefinition?.integrity ??
      group.integrity;

    const transports = genericTree
      ? content!.transports
      : [atomicSnapshot?.url ?? ordinaryDefinition?.url ?? group.url];
    const failures: string[] = [];
    let archiveData: Uint8Array | null = null;
    for (const [index, url] of transports.entries()) {
      try {
        archiveData = await this.fetchLazyBytes({
          id: `archive:${mountPrefix}:${content?.sha256 ?? url}:${index}`,
          kind: genericTree ? "tree" : "archive",
          url,
          mountPrefix,
          integrity,
        }, transport);
        break;
      } catch (error) {
        // WHY: explicit cancellation belongs to the caller/worker lifecycle,
        // not to one mirror. Check its exact reason before compatibility
        // fallbacks inspect the error's shape.
        throwIfLazyTransportAborted(transport.signal);
        if (isAbortFailure(error)) throw error;
        failures.push(error instanceof Error ? error.message : String(error));
      }
    }
    throwIfLazyTransportAborted(transport.signal);
    if (archiveData === null) {
      throw new Error(
        `All ${transports.length} lazy ${genericTree ? "tree" : "archive"} ` +
          `transports failed: ${failures.join("; ")}`,
      );
    }
    return archiveData;
  }

  private async materializeArchiveBytes(
    group: LazyArchiveGroup,
    archiveData: Uint8Array,
    requested?: { path: string; ino: number; generation: number },
    signal?: AbortSignal,
  ): Promise<void> {
    throwIfLazyTransportAborted(signal);
    const definition = this.ordinaryLazyTreeDefinitions.get(group);
    if (definition?.materialized ?? group.materialized) return;
    const extractedByIdentity = await this.prepareLazyArchiveContents(
      group,
      archiveData,
      signal,
    );
    const requestedKey = requested
      ? memoryFileSystemInodeKey(requested.ino, requested.generation)
      : null;
    for (let attempt = 0; attempt < 3; attempt++) {
      const pending = this.collectLazyArchiveReplacements(
        group,
        extractedByIdentity,
        requested,
      );

      if (pending.size > 0) {
        throwIfLazyTransportAborted(signal);
        const committed = this.fs.replaceManyIfIdentities(
          Array.from(pending.values(), conditionalFileReplacement),
        );
        if (!committed) {
          this.reconcileLazyIdentityState(this.fs.identityState());
          if (requestedKey && !this.lazyArchiveInodes.has(requestedKey)) return;
          continue;
        }
      }

      // Metadata-only groups have no regular replacement above, so retain the
      // same last cancellation boundary before publishing materialized state.
      throwIfLazyTransportAborted(signal);
      this.publishLazyArchiveReplacements(group, pending);
      if (
        this.ordinaryLazyTreeDefinitions.get(group)?.materialized ??
          group.materialized
      ) return;
      this.reconcileLazyIdentityState(this.fs.identityState());
      if (requestedKey && !this.lazyArchiveInodes.has(requestedKey)) return;
    }

    if (requestedKey && this.lazyArchiveInodes.has(requestedKey)) {
      throw new Error(
        `Lazy archive member kept changing names while materializing: ${requested?.path}`,
      );
    }
  }

  private async prepareLazyArchiveContents(
    group: LazyArchiveGroup,
    archiveData: Uint8Array,
    signal?: AbortSignal,
    atomicSnapshot?: SealedLazyAtomicSnapshot,
  ): Promise<Map<string, {
    archivePath: string;
    content: Uint8Array;
  }>> {
    throwIfLazyTransportAborted(signal);
    const ordinaryDefinition = this.ordinaryLazyTreeDefinitions.get(group);
    const content = atomicSnapshot?.content ?? ordinaryDefinition?.content ??
      group.content;
    const inventory = atomicSnapshot?.inventory ?? ordinaryDefinition?.inventory ??
      group.inventory;
    const genericTree = content !== undefined && inventory !== undefined;
    const decodedTreeFiles = genericTree
      ? await this.decodeAndValidateLazyTree(
        group,
        archiveData,
        atomicSnapshot,
      )
      : null;
    throwIfLazyTransportAborted(signal);
    const { parseZipCentralDirectory, extractZipEntry } = await import("./zip");
    throwIfLazyTransportAborted(signal);
    const zipEntries = decodedTreeFiles ? [] : parseZipCentralDirectory(archiveData);
    const zipLookup = new Map<string, ZipEntry>();
    for (const ze of zipEntries) {
      if (zipLookup.has(ze.fileName)) {
        throw new Error(`Lazy archive contains duplicate member: ${ze.fileName}`);
      }
      zipLookup.set(ze.fileName, ze);
    }

    const mountPrefix = atomicSnapshot?.mountPrefix ??
      ordinaryDefinition?.mountPrefix ?? group.mountPrefix;
    const normalizedPrefix = mountPrefix.replace(/\/+$/, "");
    const extractedByIdentity = new Map<string, {
      archivePath: string;
      content: Uint8Array;
    }>();
    const authoritativeEntries = atomicSnapshot?.entries ??
      ordinaryDefinition?.entries;
    const runtimeEntries: Array<[string, LazyArchiveFileEntry]> =
      authoritativeEntries === undefined
        ? Array.from(group.entries)
        : authoritativeEntries.map((entry) => [entry.vfsPath, entry]);
    for (const [vfsPath, archiveEntry] of runtimeEntries) {
      if (archiveEntry.deleted || archiveEntry.materialized) continue;
      const zipFileName =
        archiveEntry.archivePath ??
        vfsPath.slice(normalizedPrefix.length + 1);
      const ze = decodedTreeFiles ? undefined : zipLookup.get(zipFileName);
      const treeContent = decodedTreeFiles?.get(zipFileName);
      if (decodedTreeFiles) {
        if (treeContent === undefined || treeContent.byteLength !== archiveEntry.size) {
          throw new Error(
            `Lazy tree member ${zipFileName} does not match its registered metadata`,
          );
        }
      } else if (
        ze === undefined || ze.isDirectory || ze.isSymlink ||
        ze.uncompressedSize !== archiveEntry.size
      ) {
        throw new Error(
          `Lazy archive member ${zipFileName} does not match its registered metadata`,
        );
      }
      if (archiveEntry.generation === undefined) continue;
      const key = memoryFileSystemInodeKey(
        archiveEntry.ino,
        archiveEntry.generation,
      );
      const prior = extractedByIdentity.get(key);
      if (prior && prior.archivePath !== zipFileName) {
        throw new Error(
          `Lazy archive aliases for inode ${key} name different members`,
        );
      }
      if (!prior) {
        // Extraction (including compression/CRC/size validation) is part of
        // preflight. Do not mutate the first stub until every pending member
        // has been successfully decoded into ordinary memory.
        const content = treeContent ?? extractZipEntry(archiveData, ze!);
        if (content.byteLength !== archiveEntry.size) {
          throw new Error(
            `Lazy archive member ${zipFileName} extracted ${content.byteLength} ` +
              `bytes, expected ${archiveEntry.size}`,
          );
        }
        extractedByIdentity.set(key, { archivePath: zipFileName, content });
      }
    }
    return extractedByIdentity;
  }

  private collectLazyArchiveReplacements(
    group: LazyArchiveGroup,
    extractedByIdentity: ReadonlyMap<string, {
      archivePath: string;
      content: Uint8Array;
    }>,
    requested?: { path: string; ino: number; generation: number },
    atomicSnapshot?: SealedLazyAtomicSnapshot,
  ): Map<string, PreparedLazyArchiveReplacement> {
    const pending = new Map<string, PreparedLazyArchiveReplacement>();
    const ordinaryDefinition = this.ordinaryLazyTreeDefinitions.get(group);
    const authoritativeEntries = atomicSnapshot?.entries ??
      ordinaryDefinition?.entries;
    const runtimeEntries: Array<[string, LazyArchiveFileEntry]> =
      authoritativeEntries === undefined
        ? Array.from(group.entries)
        : authoritativeEntries.map((entry) => [entry.vfsPath, entry]);
    for (const [vfsPath, archiveEntry] of runtimeEntries) {
      if (
        archiveEntry.deleted ||
        archiveEntry.materialized ||
        archiveEntry.generation === undefined
      ) continue;
      const key = memoryFileSystemInodeKey(
        archiveEntry.ino,
        archiveEntry.generation,
      );
      if (this.lazyArchiveInodes.get(key) !== group) continue;
      const extracted = extractedByIdentity.get(key);
      if (!extracted) {
        throw new Error(`Lazy archive has no extracted content for inode ${key}`);
      }
      let replacement = pending.get(key);
      if (!replacement) {
        replacement = {
          ino: archiveEntry.ino,
          generation: archiveEntry.generation,
          dataSequence: archiveEntry.dataSequence ?? 0,
          paths: new Set(),
          content: extracted.content,
        };
        pending.set(key, replacement);
      }
      replacement.paths.add(vfsPath);
      if (
        requested &&
        requested.ino === archiveEntry.ino &&
        requested.generation === archiveEntry.generation
      ) {
        replacement.paths.add(requested.path);
      }
    }
    return pending;
  }

  private publishLazyArchiveReplacements(
    group: LazyArchiveGroup,
    pending: ReadonlyMap<string, PreparedLazyArchiveReplacement>,
  ): void {
    const ordinaryDefinition = this.ordinaryLazyTreeDefinitions.get(group);
    if (ordinaryDefinition !== undefined) {
      const entries = ordinaryDefinition.entries.map((entry) => {
        const key = entry.generation === undefined
          ? undefined
          : memoryFileSystemInodeKey(entry.ino, entry.generation);
        if (key === undefined || !pending.has(key)) return entry;
        this.lazyArchiveInodes.delete(key);
        return { ...entry, materialized: true };
      });
      this.replaceOrdinaryLazyTreeRuntimeState(
        group,
        entries,
        entries.every((entry) => entry.deleted || entry.materialized),
      );
      return;
    }
    for (const [key, replacement] of pending) {
      this.lazyArchiveInodes.delete(key);
      for (const alias of group.entries.values()) {
        if (
          alias.ino === replacement.ino &&
          alias.generation === replacement.generation
        ) alias.materialized = true;
      }
    }
    group.materialized = Array.from(group.entries.values()).every(
      (entry) => entry.deleted || entry.materialized,
    );
  }

  private collectAtomicTreeNamespace(
    group: LazyArchiveGroup,
    snapshot: SealedLazyAtomicSnapshot,
  ): {
    guards: ConditionalNamespaceIdentity[];
    pendingIdentities: number;
  } {
    const pendingIdentities = new Set<string>();
    const identityByInodeGroup = new Map<string, string>();
    const declaredAliasCount = new Map<string, number>();
    const entriesByPath = new Map(
      snapshot.entries.map((entry) => [entry.vfsPath, entry]),
    );
    for (const entry of snapshot.inventory) {
      if (entry.type === "file" || entry.type === "hardlink") {
        declaredAliasCount.set(
          entry.inodeGroup!,
          (declaredAliasCount.get(entry.inodeGroup!) ?? 0) + 1,
        );
      }
    }
    const guards: ConditionalNamespaceIdentity[] = [];
    for (const inventoryEntry of snapshot.inventory) {
      let st: SfsStatResult;
      try {
        st = this.fs.lstat(inventoryEntry.vfsPath);
      } catch {
        throw new Error(
          `Lazy atomic tree changed at ${inventoryEntry.vfsPath}`,
        );
      }
      const expectedType = inventoryEntry.type === "directory"
        ? S_IFDIR
        : inventoryEntry.type === "symlink"
          ? S_IFLNK
          : S_IFREG;
      if (
        (st.mode & S_IFMT) !== expectedType ||
        (st.mode & FILE_MODES.S_MODE_BITS) !== inventoryEntry.mode
      ) {
        throw new Error(
          `Lazy atomic tree changed at ${inventoryEntry.vfsPath}`,
        );
      }
      if (inventoryEntry.type === "symlink") {
        const entry = entriesByPath.get(inventoryEntry.vfsPath);
        if (
          entry === undefined ||
          !entry.isSymlink ||
          entry.deleted ||
          entry.ino !== st.ino ||
          entry.generation !== st.generation ||
          entry.dataSequence !== st.dataSequence ||
          this.fs.readlink(inventoryEntry.vfsPath) !== inventoryEntry.target
        ) {
          throw new Error(
            `Lazy atomic tree changed at ${inventoryEntry.vfsPath}`,
          );
        }
      } else if (
        inventoryEntry.type === "file" ||
        inventoryEntry.type === "hardlink"
      ) {
        const entry = entriesByPath.get(inventoryEntry.vfsPath);
        if (
          entry === undefined ||
          entry.deleted ||
          entry.materialized ||
          entry.isSymlink ||
          entry.generation === undefined ||
          entry.inodeGroup !== inventoryEntry.inodeGroup ||
          entry.ino !== st.ino ||
          entry.generation !== st.generation ||
          entry.dataSequence !== st.dataSequence ||
          st.size !== 0 ||
          st.linkCount !== declaredAliasCount.get(inventoryEntry.inodeGroup!)!
        ) {
          throw new Error(
            `Lazy atomic tree changed at ${inventoryEntry.vfsPath}`,
          );
        }
        const key = memoryFileSystemInodeKey(entry.ino, entry.generation);
        if (this.lazyArchiveInodes.get(key) !== group) {
          throw new Error(
            `Lazy atomic tree lost deferred ownership of ${inventoryEntry.vfsPath}`,
          );
        }
        const priorIdentity = identityByInodeGroup.get(
          inventoryEntry.inodeGroup!,
        );
        if (priorIdentity !== undefined && priorIdentity !== key) {
          throw new Error(
            `Lazy atomic tree split hard links at ${inventoryEntry.vfsPath}`,
          );
        }
        identityByInodeGroup.set(inventoryEntry.inodeGroup!, key);
        pendingIdentities.add(key);
      }
      guards.push({
        path: inventoryEntry.vfsPath,
        expectedIno: st.ino,
        expectedGeneration: st.generation,
        expectedDataSequence: st.dataSequence,
        expectedMode: st.mode,
        expectedLinkCount: st.linkCount,
        expectedSize: st.size,
        expectedUid: st.uid,
        expectedGid: st.gid,
      });
    }
    return { guards, pendingIdentities: pendingIdentities.size };
  }

  private assertLazyAtomicSnapshotMatchesPublic(
    group: LazyArchiveGroup,
  ): SealedLazyAtomicState {
    const state = this.sealedLazyAtomicStates.get(group);
    const sealed = state?.snapshot;
    const membership = group.activation?.atomicGroup;
    const member = sealed?.member ?? membership?.member ?? "unknown";
    let current: LazyAtomicSnapshotSource | undefined;
    if (sealed !== undefined) {
      try {
        current = captureLazyAtomicSnapshotSource(
          group,
          sealed.id,
          sealed.member,
        );
      } catch {
        current = undefined;
      }
    }
    if (
      state === undefined ||
      sealed === undefined ||
      membership === undefined ||
      !isSealedLazyAtomicMembership(membership) ||
      membership.id !== sealed.id ||
      membership.member !== sealed.member ||
      membership.descriptorSha256 !== sealed.descriptorSha256 ||
      membership.expectedCount !== sealed.expectedCount ||
      membership.cohortSha256 !== sealed.cohortSha256 ||
      current === undefined ||
      !equalLazyAtomicSnapshotSources(sealed, current)
    ) {
      throw new Error(
        `Lazy atomic activation member ${member} changed after sealing`,
      );
    }
    return state;
  }

  private assertPendingLazyAtomicSnapshotsReadyForSerialization(): void {
    for (const group of this.lazyArchiveGroups) {
      if (!this.sealedLazyAtomicStates.has(group)) continue;
      const atomicGroup = this.lazyAtomicGroupByTree.get(group);
      if (atomicGroup?.committed) continue;
      const state = this.assertLazyAtomicSnapshotMatchesPublic(group);
      if (!state.verified) {
        throw new Error(
          `Lazy atomic activation group ${state.snapshot.id} has not been ` +
            "cryptographically verified after import",
        );
      }
    }
  }

  private async validatePendingLazyAtomicGroupSeals(
    requireLiveNamespace: boolean,
  ): Promise<void> {
    for (const atomicGroup of this.lazyAtomicGroups.values()) {
      if (
        atomicGroup.committed ||
        atomicGroup.expectedCount === undefined ||
        atomicGroup.cohortSha256 === undefined
      ) {
        continue;
      }
      const groups = [...atomicGroup.groups.entries()]
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
        .map(([, group]) => group);
      await this.ensureLazyAtomicGroupSealValidated(
        atomicGroup,
        groups,
        requireLiveNamespace,
      );
    }
  }

  /**
   * Join or establish the one cryptographic proof for a pending cohort.
   *
   * A waiter may resume after activation committed and updated the public
   * compatibility objects. That is successful only because `committed` is set
   * after the exact identity-guarded SharedFS transaction. Otherwise every
   * waiter must linearize against the still-pending public snapshot.
   */
  private async ensureLazyAtomicGroupSealValidated(
    atomicGroup: LazyAtomicGroup,
    groups: readonly LazyArchiveGroup[],
    requireLiveNamespace: boolean,
  ): Promise<void> {
    if (this.assertLazyAtomicGroupSealValidatedAtLinearization(
      atomicGroup,
      groups,
      requireLiveNamespace,
    )) {
      return;
    }

    let flight = atomicGroup.sealValidationFlight;
    if (flight === undefined) {
      flight = this.validateLazyAtomicGroupSealOnce(atomicGroup, groups);
      atomicGroup.sealValidationFlight = flight;
      // WHY: transport-free seal hashing is shared per group, but a failed
      // public-state check may become valid again after the caller restores
      // an allowed compatibility view. Clear only the settled flight so one
      // later retry can establish a fresh proof without overlapping this one.
      void flight.then(
        () => {
          if (atomicGroup.sealValidationFlight === flight) {
            atomicGroup.sealValidationFlight = undefined;
          }
        },
        () => {
          if (atomicGroup.sealValidationFlight === flight) {
            atomicGroup.sealValidationFlight = undefined;
          }
        },
      );
    }

    await flight;
    if (!this.assertLazyAtomicGroupSealValidatedAtLinearization(
      atomicGroup,
      groups,
      requireLiveNamespace,
    )) {
      throw new Error(
        `Lazy atomic activation group ${atomicGroup.id} seal verification ` +
          "did not authenticate every member",
      );
    }
  }

  /**
   * Return true only at a safe seal-validation linearization point.
   *
   * No await occurs here. A JavaScript activation can therefore either commit
   * before this check or after it, while SharedFS peer mutations are still
   * detected by the public-snapshot and later namespace guards.
   */
  private assertLazyAtomicGroupSealValidatedAtLinearization(
    atomicGroup: LazyAtomicGroup,
    groups: readonly LazyArchiveGroup[],
    requireLiveNamespace: boolean,
  ): boolean {
    if (atomicGroup.committed) return true;
    if (
      atomicGroup.expectedCount === undefined ||
      atomicGroup.cohortSha256 === undefined ||
      groups.length !== atomicGroup.expectedCount
    ) {
      throw new Error(
        `Lazy atomic activation group ${atomicGroup.id} is not completely sealed`,
      );
    }
    let everyMemberVerified = true;
    const states: SealedLazyAtomicState[] = [];
    for (const group of groups) {
      const state = this.assertLazyAtomicSnapshotMatchesPublic(group);
      const sealed = state.snapshot;
      if (
        sealed.id !== atomicGroup.id ||
        sealed.expectedCount !== atomicGroup.expectedCount ||
        sealed.cohortSha256 !== atomicGroup.cohortSha256 ||
        atomicGroup.groups.get(sealed.member) !== group
      ) {
        throw new Error(
          `Lazy atomic activation group ${atomicGroup.id} has an inconsistent member`,
        );
      }
      everyMemberVerified &&= state.verified;
      states.push(state);
    }
    if (everyMemberVerified && requireLiveNamespace) {
      // WHY: a peer can unlink or replace SharedFS names without touching this
      // instance's compatibility objects. Verification must not report a
      // reusable pending seal unless its complete live namespace still matches
      // the private snapshot at the same synchronous linearization point.
      for (let index = 0; index < groups.length; index++) {
        this.collectAtomicTreeNamespace(groups[index]!, states[index]!.snapshot);
      }
    }
    return everyMemberVerified;
  }

  /** Perform one transport-free cryptographic proof for a complete cohort. */
  private async validateLazyAtomicGroupSealOnce(
    atomicGroup: LazyAtomicGroup,
    groups: readonly LazyArchiveGroup[],
  ): Promise<void> {
    const descriptors: Array<{
      member: string;
      descriptorSha256: string;
    }> = [];
    const states: SealedLazyAtomicState[] = [];
    for (const group of groups) {
      const state = this.assertLazyAtomicSnapshotMatchesPublic(group);
      const sealed = state.snapshot;
      if (
        sealed.id !== atomicGroup.id ||
        sealed.expectedCount !== atomicGroup.expectedCount ||
        sealed.cohortSha256 !== atomicGroup.cohortSha256 ||
        atomicGroup.groups.get(sealed.member) !== group
      ) {
        throw new Error(
          `Lazy atomic activation group ${atomicGroup.id} has an inconsistent member`,
        );
      }
      const actualDescriptorSha256 = await sha256Hex(
        sealed.descriptorBytes,
        `Lazy atomic member ${sealed.member}`,
      );
      if (actualDescriptorSha256 !== sealed.descriptorSha256) {
        throw new Error(
          `Lazy atomic activation member ${sealed.member} changed after sealing`,
        );
      }
      descriptors.push({
        member: sealed.member,
        descriptorSha256: actualDescriptorSha256,
      });
      states.push(state);
    }
    const actualCohortSha256 = await sha256Hex(
      lazyAtomicCohortIdentityBytes(atomicGroup.id, descriptors),
      `Lazy atomic activation group ${atomicGroup.id}`,
    );
    if (actualCohortSha256 !== atomicGroup.cohortSha256) {
      throw new Error(
        `Lazy atomic activation group ${atomicGroup.id} differs from its seal`,
      );
    }
    // WHY: hashing yields to host code. Persistent public mutation is rejected,
    // while all security-sensitive work above used only the private snapshots.
    for (const group of groups) {
      this.assertLazyAtomicSnapshotMatchesPublic(group);
    }
    for (const state of states) state.verified = true;
  }

  private async ensureAtomicLazyGroupMaterialized(
    atomicGroup: LazyAtomicGroup,
  ): Promise<void> {
    if (atomicGroup.committed) return;
    const groups = [...atomicGroup.groups.entries()]
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([, group]) => group);
    if (groups.length === 0) {
      throw new Error(
        `Lazy atomic activation group ${atomicGroup.id} has no trees`,
      );
    }

    await this.ensureLazyAtomicGroupSealValidated(atomicGroup, groups, true);
    if (atomicGroup.committed) return;
    const snapshots = groups.map((group) =>
      this.sealedLazyAtomicStates.get(group)!.snapshot
    );
    const namespace = groups.map((group, index) => ({
      group,
      ...this.collectAtomicTreeNamespace(group, snapshots[index]),
    }));
    const transport = this.lazyTransport;
    // WHY: dependent deferred trees are one transaction. Bound concurrent
    // archive buffers, stop scheduling after the first error, and await every
    // in-flight worker so a retry cannot overlap abandoned I/O or decoding.
    const prepared = new Array<{
      group: LazyArchiveGroup;
      snapshot: SealedLazyAtomicSnapshot;
      contents: Map<string, { archivePath: string; content: Uint8Array }>;
    } | undefined>(groups.length);
    let cursor = 0;
    let failed = false;
    let firstError: unknown;
    const workers = Array.from({
      length: Math.min(MAX_ATOMIC_DEFERRED_TREE_CONCURRENCY, groups.length),
    }, async () => {
      while (!failed) {
        const index = cursor++;
        if (index >= groups.length) return;
        const group = groups[index];
        const snapshot = snapshots[index];
        try {
          const bytes = await this.fetchLazyArchiveData(
            group,
            transport,
            snapshot,
          );
          throwIfLazyTransportAborted(transport.signal);
          prepared[index] = {
            group,
            snapshot,
            contents: await this.prepareLazyArchiveContents(
              group,
              bytes,
              transport.signal,
              snapshot,
            ),
          };
        } catch (error) {
          if (!failed) {
            failed = true;
            firstError = error;
          }
        }
      }
    });
    await Promise.all(workers);
    if (failed) {
      prepared.fill(undefined);
      throw firstError;
    }
    throwIfLazyTransportAborted(transport.signal);
    // Persistent public edits are observable API misuse and fail closed.
    // Transient mutate/use/restore attempts are harmless because every awaited
    // operation above consumed only the captured immutable snapshots.
    for (const group of groups) {
      this.assertLazyAtomicSnapshotMatchesPublic(group);
    }

    const conditionalReplacements: ReturnType<
      typeof conditionalFileReplacement
    >[] = [];
    const requiredNamespace: ConditionalNamespaceIdentity[] = [];
    const publication: Array<{
      group: LazyArchiveGroup;
      snapshot: SealedLazyAtomicSnapshot;
      inodeKeys: string[];
    }> = [];
    for (let index = 0; index < prepared.length; index++) {
      const complete = prepared[index]!;
      const pending = this.collectLazyArchiveReplacements(
        complete.group,
        complete.contents,
        undefined,
        complete.snapshot,
      );
      const expected = namespace[index];
      if (pending.size !== expected.pendingIdentities) {
        throw new Error(
          `Lazy atomic activation group ${atomicGroup.id} changed before commit`,
        );
      }
      const inodeKeys: string[] = [];
      for (const [key, replacement] of pending) {
        inodeKeys.push(key);
        conditionalReplacements.push(conditionalFileReplacement(replacement));
      }
      for (const entry of complete.snapshot.entries) {
        if (
          entry.deleted ||
          entry.materialized ||
          entry.generation === undefined
        ) continue;
        const key = memoryFileSystemInodeKey(entry.ino, entry.generation);
        if (!pending.has(key)) {
          throw new Error(
            `Lazy atomic activation group ${atomicGroup.id} has an incomplete publication`,
          );
        }
      }
      publication.push({
        group: complete.group,
        snapshot: complete.snapshot,
        inodeKeys,
      });
      for (const guard of expected.guards) requiredNamespace.push(guard);
    }

    // WHY: SharedFS holds the namespace and every target inode lock across
    // this call. One capacity/identity failure rolls every file back, while
    // every declared directory, symlink, and hard-link name is also guarded.
    if (
      !this.fs.replaceManyIfIdentities(
        conditionalReplacements,
        requiredNamespace,
      )
    ) {
      throw new Error(
        `Lazy atomic activation group ${atomicGroup.id} changed before commit`,
      );
    }

    // Everything that can validate, allocate, iterate the namespace, or throw
    // was completed above. Publish authoritative private state before touching
    // caller-reachable compatibility objects, which are best-effort only.
    for (const state of publication) {
      for (const key of state.inodeKeys) this.lazyArchiveInodes.delete(key);
    }
    atomicGroup.committed = true;
    for (const state of publication) {
      try {
        for (const entry of state.snapshot.entries) {
          if (entry.isSymlink || entry.generation === undefined) continue;
          const publicEntry = state.group.entries.get(entry.vfsPath);
          if (publicEntry !== undefined) publicEntry.materialized = true;
        }
        state.group.materialized = true;
      } catch {
        // Public compatibility state cannot roll back an already atomic commit.
      }
    }
  }

  private async materializeAllLazyEntries(): Promise<void> {
    // A peer can rename an inode while an asynchronous fetch is in flight.
    // Refresh and retry a bounded number of times; a continuously mutating
    // filesystem is not a stable source for a self-contained image.
    for (let attempt = 0; attempt < 3; attempt++) {
      this.reconcileLazyIdentityState(this.fs.identityState());
      const genericGroups = this.lazyArchiveGroups.filter((group) => {
        const atomicGroup = this.lazyAtomicGroupByTree.get(group);
        const snapshot = this.sealedLazyAtomicStates.get(group)?.snapshot;
        const definition = this.ordinaryLazyTreeDefinitions.get(group);
        return snapshot === undefined
          ? definition !== undefined && !definition.materialized
          : !atomicGroup?.committed;
      });
      if (
        this.lazyFiles.size === 0 &&
        this.lazyArchiveInodes.size === 0 &&
        genericGroups.length === 0
      )
        return;

      const filePaths = Array.from(
        this.lazyFiles.values(),
        (entry) => entry.path,
      );
      for (const path of filePaths) await this.ensureMaterialized(path);

      const archiveGroups = new Set(this.lazyArchiveInodes.values());
      for (const group of genericGroups) archiveGroups.add(group);
      for (const group of archiveGroups) {
        await this.prepareLazyTreeGroup(group);
      }
    }

    this.reconcileLazyIdentityState(this.fs.identityState());
    const pendingGenericTree = this.lazyArchiveGroups.some((group) => {
      const atomicGroup = this.lazyAtomicGroupByTree.get(group);
      const snapshot = this.sealedLazyAtomicStates.get(group)?.snapshot;
      const definition = this.ordinaryLazyTreeDefinitions.get(group);
      return snapshot === undefined
        ? definition !== undefined && !definition.materialized
        : !atomicGroup?.committed;
    });
    if (
      this.lazyFiles.size !== 0 ||
      this.lazyArchiveInodes.size !== 0 ||
      pendingGenericTree
    ) {
      throw new Error(
        "Cannot create a self-contained VFS image while lazy entries remain pending",
      );
    }
  }

  /**
   * Save the current filesystem state as a portable binary image.
   *
   * With `materializeAll: true`, all lazy files are fetched and written
   * into the filesystem before saving, producing a self-contained image.
   * Otherwise, lazy file metadata (path/URL/size) is preserved in the
   * image and restored on load.
   */
  async saveImage(options?: VfsImageOptions): Promise<Uint8Array> {
    if (options?.materializeAll) {
      await this.materializeAllLazyEntries();
    }
    // Validate imported seal digests before entering the synchronous snapshot
    // section. No await is permitted after SharedFS bytes are captured: a lazy
    // activation could otherwise commit while metadata still described the
    // earlier filesystem image.
    // WHY: the identity snapshot and serialization immediately below perform
    // save's live-namespace check and retain their path-specific diagnostics.
    // This await needs only the shared cryptographic proof before that point.
    await this.validatePendingLazyAtomicGroupSeals(false);

    const { bytes: sabBytes, identities } = this.fs.snapshotState({
      normalizeTimestampsMs: options?.normalizeTimestampsMs,
    });
    this.reconcileLazyIdentityState(identities);
    const lazyEntries = this.serializeLazyEntries();
    const hasLazy = lazyEntries.length > 0;
    const lazyJson = hasLazy
      ? new TextEncoder().encode(JSON.stringify(lazyEntries))
      : new Uint8Array(0);
    if (lazyJson.byteLength > VFS_IMAGE_MAX_LAZY_METADATA_BYTES) {
      throw new Error(
        `VFS image lazy metadata exceeds ${VFS_IMAGE_MAX_LAZY_METADATA_BYTES} bytes`,
      );
    }

    const archiveEntries = this.serializeValidatedLazyArchiveEntries(identities);
    const hasArchives = archiveEntries.length > 0;
    const archiveJson = hasArchives
      ? new TextEncoder().encode(JSON.stringify(archiveEntries))
      : new Uint8Array(0);
    if (archiveJson.byteLength > VFS_IMAGE_MAX_LAZY_ARCHIVE_METADATA_BYTES) {
      throw new Error(
        `VFS image lazy archive metadata exceeds ` +
          `${VFS_IMAGE_MAX_LAZY_ARCHIVE_METADATA_BYTES} bytes`,
      );
    }

    const metadata =
      options?.metadata === undefined ? this.imageMetadata : options.metadata;
    const metadataJson = encodeMetadata(metadata);
    const hasMetadata = metadataJson.byteLength > 0;

    // Layout: header | sab | u32 lazyLen | lazyJson | u32 archiveLen | archiveJson | u32 metadataLen | metadataJson
    // Archive and metadata sections are only appended when their flags are set.
    const archiveSectionSize = hasArchives ? 4 + archiveJson.byteLength : 0;
    const metadataSectionSize = hasMetadata ? 4 + metadataJson.byteLength : 0;
    const totalSize =
      VFS_IMAGE_HEADER_SIZE +
      sabBytes.byteLength +
      4 +
      lazyJson.byteLength +
      archiveSectionSize +
      metadataSectionSize;
    const image = new Uint8Array(totalSize);
    const view = new DataView(image.buffer);

    // Header
    view.setUint32(0, VFS_IMAGE_MAGIC, true);
    view.setUint32(4, VFS_IMAGE_VERSION, true);
    view.setUint32(
      8,
      (hasLazy ? VFS_IMAGE_FLAG_HAS_LAZY : 0) |
        (hasArchives ? VFS_IMAGE_FLAG_HAS_LAZY_ARCHIVES : 0) |
        (hasArchives ? VFS_IMAGE_FLAG_HAS_TYPED_LAZY_ARCHIVES : 0) |
        (hasMetadata ? VFS_IMAGE_FLAG_HAS_METADATA : 0),
      true,
    );
    view.setUint32(12, sabBytes.byteLength, true);

    // SAB data is already a detached, runtime-state-free snapshot.
    image.set(sabBytes, VFS_IMAGE_HEADER_SIZE);

    // Lazy entries
    const lazyOffset = VFS_IMAGE_HEADER_SIZE + sabBytes.byteLength;
    view.setUint32(lazyOffset, lazyJson.byteLength, true);
    if (lazyJson.byteLength > 0) {
      image.set(lazyJson, lazyOffset + 4);
    }

    // Archive entries
    if (hasArchives) {
      const archiveOffset = lazyOffset + 4 + lazyJson.byteLength;
      view.setUint32(archiveOffset, archiveJson.byteLength, true);
      image.set(archiveJson, archiveOffset + 4);
    }

    // Metadata
    if (hasMetadata) {
      const metadataOffset =
        lazyOffset + 4 + lazyJson.byteLength + archiveSectionSize;
      view.setUint32(metadataOffset, metadataJson.byteLength, true);
      image.set(metadataJson, metadataOffset + 4);
    }

    return image;
  }

  /** Read image-level metadata without materializing the filesystem SAB. */
  static readImageMetadata(image: Uint8Array): VfsImageMetadata | null {
    const parsed = parseImageHeader(image);
    if (!(parsed.flags & VFS_IMAGE_FLAG_HAS_METADATA)) return null;
    const { metadataOffset } = sectionOffsetAfterArchives(
      parsed.image,
      parsed.view,
      parsed.flags,
      parsed.sabLen,
    );
    if (parsed.image.byteLength < metadataOffset + 4) {
      throw new Error("VFS image truncated (metadata section)");
    }
    const metadataLen = parsed.view.getUint32(metadataOffset, true);
    if (metadataLen > VFS_IMAGE_MAX_METADATA_BYTES) {
      throw new Error(
        `VFS image metadata exceeds ${VFS_IMAGE_MAX_METADATA_BYTES} bytes`,
      );
    }
    if (parsed.image.byteLength < metadataOffset + 4 + metadataLen) {
      throw new Error("VFS image truncated (metadata payload)");
    }
    if (metadataLen === 0) return null;
    return decodeMetadata(
      parsed.image.subarray(
        metadataOffset + 4,
        metadataOffset + 4 + metadataLen,
      ),
    );
  }

  /**
   * Validate an image's optional kernel ABI declaration. Images without a
   * `kernelAbi` declaration are accepted so legacy/data-only images keep
   * loading; callers that require an explicit declaration should check
   * `readImageMetadata(image)?.kernelAbi` first.
   */
  static assertImageKernelAbi(
    image: Uint8Array,
    kernelAbi: number,
    label = "VFS image",
  ): void {
    const metadata = MemoryFileSystem.readImageMetadata(image);
    const declared = metadata?.kernelAbi;
    if (declared === undefined) return;
    if (declared !== kernelAbi) {
      throw new Error(
        `${label} requires kernel ABI ${declared}, but the running kernel is ABI ${kernelAbi}`,
      );
    }
  }

  /** Read the current and maximum filesystem sizes encoded in an image. */
  static readImageCapacity(image: Uint8Array): VfsImageCapacity {
    const parsed = parseImageHeader(image);
    return SharedFS.inspectImageCapacity(
      parsed.image.subarray(
        VFS_IMAGE_HEADER_SIZE,
        VFS_IMAGE_HEADER_SIZE + parsed.sabLen,
      ),
    );
  }

  /**
   * Restore an image with the growth ceiling recorded in its SharedFS
   * superblock. This is the low-level synchronous parser; imported v3 atomic
   * seals remain unverified. Before inspecting, mutating, or booting imported
   * state, use `restoreVerifiedVfsImagePreservingCapacity()` or explicitly
   * await `verifyImportedLazyAtomicGroupSeals()`.
   *
   * Use fromImage() when a caller intentionally supplies a different runtime
   * ceiling.
   */
  static fromImagePreservingCapacity(image: Uint8Array): MemoryFileSystem {
    const parsed = parseImageHeader(image);
    const capacity = SharedFS.inspectImageCapacity(
      parsed.image.subarray(
        VFS_IMAGE_HEADER_SIZE,
        VFS_IMAGE_HEADER_SIZE + parsed.sabLen,
      ),
    );
    return MemoryFileSystem.restoreParsedImage(parsed, {
      maxByteLength: capacity.maxByteLength,
    });
  }

  /**
   * Restore a MemoryFileSystem from a previously saved VFS image.
   * Allocates a new SharedArrayBuffer and populates it from the image.
   *
   * This low-level synchronous parser cannot authenticate imported v3 atomic
   * seals. Normal imported-image consumers should await
   * `restoreVerifiedVfsImage()` instead; private format code must explicitly
   * await `verifyImportedLazyAtomicGroupSeals()` before it inspects, mutates,
   * or boots the restored filesystem.
   *
   * When `maxByteLength` is specified, creates a growable SharedArrayBuffer
   * so the filesystem can expand beyond the image's original size, up to the
   * maximum already recorded in the image superblock.
   */
  static fromImage(
    image: Uint8Array,
    options?: VfsImageRestoreOptions,
  ): MemoryFileSystem {
    const parsed = parseImageHeader(image, options?.maxDecompressedBytes);
    return MemoryFileSystem.restoreParsedImage(parsed, options);
  }

  private static restoreParsedImage(
    parsed: ParsedImageHeader,
    options?: VfsImageRestoreOptions,
  ): MemoryFileSystem {
    const image = parsed.image;
    const view = parsed.view;
    const flags = parsed.flags;
    const sabLen = parsed.sabLen;
    const sections = sectionOffsetAfterArchives(image, view, flags, sabLen);
    if (!(flags & VFS_IMAGE_FLAG_HAS_LAZY) && sections.lazyLen !== 0) {
      throw new Error("VFS image has lazy metadata without its format flag");
    }
    if (
      (flags & VFS_IMAGE_FLAG_HAS_TYPED_LAZY_ARCHIVES) &&
      !(flags & VFS_IMAGE_FLAG_HAS_LAZY_ARCHIVES)
    ) {
      throw new Error(
        "VFS image has typed lazy-archive metadata without its archive flag",
      );
    }

    // Restore SharedArrayBuffer (optionally growable). Some TypeScript lib
    // versions still expose only the 1-arg constructor even on runtimes that
    // support the options object.
    const sabOptions = options?.maxByteLength
      ? { maxByteLength: options.maxByteLength }
      : undefined;
    const SharedArrayBufferCtor = SharedArrayBuffer as new (
      byteLength: number,
      options?: { maxByteLength?: number },
    ) => SharedArrayBuffer;
    const sab = new SharedArrayBufferCtor(sabLen, sabOptions);
    const sabView = new Uint8Array(sab);
    sabView.set(
      image.subarray(VFS_IMAGE_HEADER_SIZE, VFS_IMAGE_HEADER_SIZE + sabLen),
    );

    let metadata: VfsImageMetadata | null = null;
    if (flags & VFS_IMAGE_FLAG_HAS_METADATA) {
      metadata = MemoryFileSystem.readImageMetadata(image);
    }

    const mfs = new MemoryFileSystem(
      SharedFS.mount(sab, { restoreImage: true }),
      metadata,
    );

    // Restore lazy entries
    const lazyOffset = VFS_IMAGE_HEADER_SIZE + sabLen;
    const lazyLen = sections.lazyLen;
    if (flags & VFS_IMAGE_FLAG_HAS_LAZY) {
      if (lazyLen > 0) {
        const lazyBytes = image.subarray(
          lazyOffset + 4,
          lazyOffset + 4 + lazyLen,
        );
        const entries = requireLazyTreeArray(
          decodeJsonSection(lazyBytes, "VFS image lazy metadata"),
          "VFS image lazy entries",
          0,
          MAX_LAZY_TREE_ENTRIES,
        ) as LazyFileEntry[];
        mfs.importLazyEntriesInternal(entries, true);
      }
    }

    // Restore lazy archive groups
    if (flags & VFS_IMAGE_FLAG_HAS_LAZY_ARCHIVES) {
      const archiveOffset = sections.archiveOffset;
      const archiveLen = view.getUint32(archiveOffset, true);
      if (archiveLen > 0) {
        const archiveBytes = image.subarray(
          archiveOffset + 4,
          archiveOffset + 4 + archiveLen,
        );
        const entries = decodeJsonSection(
          archiveBytes,
          "VFS image lazy archive metadata",
        );
        mfs.importLazyArchiveEntriesInternal(
          entries,
          true,
          Boolean(flags & VFS_IMAGE_FLAG_HAS_TYPED_LAZY_ARCHIVES),
          "pending",
        );
      }
    }

    return mfs;
  }

  private adaptStat(s: SfsStatResult): StatResult {
    return {
      dev: 0,
      ino: s.ino,
      mode: s.mode,
      nlink: s.linkCount,
      uid: s.uid,
      gid: s.gid,
      size: s.size,
      atimeMs: s.atime,
      mtimeMs: s.mtime,
      ctimeMs: s.ctime,
    };
  }

  private adaptStatWithLazySize(s: SfsStatResult): StatResult {
    const result = this.adaptStat(s);
    const entry = this.lazyFileForStat(s);
    if (entry) {
      result.size = entry.size;
      return result;
    }

    const group = this.lazyArchiveForStat(s);
    if (group) {
      for (const archiveEntry of this.lazyArchiveEntriesForRead(group)) {
        if (
          archiveEntry.ino === s.ino &&
          archiveEntry.generation === s.generation &&
          !archiveEntry.deleted
        ) {
          result.size = archiveEntry.size;
          break;
        }
      }
    }
    return result;
  }

  open(path: string, flags: number, mode: number): number {
    if (
      (flags & O_TRUNC) === 0 &&
      !((flags & O_CREAT) !== 0 && (flags & O_EXCL) !== 0)
    ) {
      this.guardSynchronousLazyAccess(path);
    }
    const handle = this.fs.open(path, flags, mode);
    if ((flags & O_TRUNC) !== 0) {
      // O_TRUNC
      this.invalidateLazyData(this.fs.fstat(handle));
    }
    return handle;
  }

  close(handle: number): number {
    this.fs.close(handle);
    return 0;
  }

  read(
    handle: number,
    buffer: Uint8Array,
    offset: HostFileOffset | null,
    length: number,
  ): number {
    if (length > 0) {
      let backing = this.lazyBackingForStat(this.fs.fstat(handle));
      if (backing) {
        // Another SharedFS peer can rename a still-open lazy inode. Refresh
        // its surviving name before starting the asynchronous preparation.
        this.reconcileLazyIdentityState(this.fs.identityState());
        backing = this.lazyBackingForStat(this.fs.fstat(handle));
        if (backing) this.guardSynchronousLazyAccess(backing.path);
      }
    }
    if (offset !== null) {
      return this.fs.readAt(
        handle,
        buffer.subarray(0, length),
        typeof offset === "bigint"
          ? hostFilePositionToSafeNumber(offset)
          : offset,
      );
    }
    return this.fs.read(handle, buffer.subarray(0, length));
  }

  write(
    handle: number,
    buffer: Uint8Array,
    offset: HostFileOffset | null,
    length: number,
  ): number {
    if (offset !== null) {
      const n = this.fs.writeAt(
        handle,
        buffer.subarray(0, length),
        typeof offset === "bigint"
          ? hostFilePositionToSafeNumber(offset)
          : offset,
      );
      if (n > 0) this.invalidateLazyData(this.fs.fstat(handle));
      return n;
    }
    const n = this.fs.write(handle, buffer.subarray(0, length));
    if (n > 0) this.invalidateLazyData(this.fs.fstat(handle));
    return n;
  }

  append(
    handle: number,
    buffer: Uint8Array,
    length: number,
    limit: HostFileOffset | null,
  ): AppendOutcome {
    const outcome = this.fs.append(
      handle,
      buffer.subarray(0, length),
      hostFileLimitForNumberBackend(limit),
    );
    if (outcome.written > 0) {
      this.invalidateLazyData(this.fs.fstat(handle));
    }
    return outcome;
  }

  seek(
    handle: number,
    offset: HostFileOffset,
    whence: number,
  ): HostFileOffset {
    return this.fs.lseek(
      handle,
      typeof offset === "bigint"
        ? hostFileOffsetToSafeNumber(offset)
        : offset,
      whence,
    );
  }

  fstat(handle: number): StatResult {
    return this.adaptStatWithLazySize(this.fs.fstat(handle));
  }

  fpathconf(handle: number, name: number): PathconfValue {
    const stat = this.fstat(handle);
    return filesystemPathconf(stat, name, {
      supportsSymlinks: true,
      timestampResolutionNs: 1_000_000,
    });
  }

  ftruncate(handle: number, length: number): void {
    this.fs.ftruncate(handle, length);
    this.invalidateLazyData(this.fs.fstat(handle));
  }

  // SharedFS is memory-backed, fsync is a no-op
  fsync(_handle: number): void {}

  fchmod(handle: number, mode: number): void {
    this.fs.fchmod(handle, mode);
  }
  fchown(handle: number, uid: number, gid: number): void {
    this.fs.fchown(handle, uid, gid);
  }

  stat(path: string): StatResult {
    return this.adaptStatWithLazySize(this.fs.stat(path));
  }

  lstat(path: string): StatResult {
    return this.adaptStatWithLazySize(this.fs.lstat(path));
  }

  statfs(path: string): StatfsResult {
    this.fs.stat(path);
    const stats = this.fs.statfs();
    return {
      type: SFFS_SUPER_MAGIC,
      bsize: stats.blockSize,
      blocks: stats.totalBlocks,
      bfree: stats.freeBlocks,
      bavail: stats.freeBlocks,
      files: stats.totalInodes,
      ffree: stats.freeInodes,
      fsid: 0,
      namelen: stats.maxName,
      frsize: stats.blockSize,
      flags: ST_NOSUID,
    };
  }

  pathconf(path: string, name: number): PathconfValue {
    const stat = this.stat(path);
    return filesystemPathconf(stat, name, {
      supportsSymlinks: true,
      timestampResolutionNs: 1_000_000,
    });
  }

  mkdir(path: string, mode: number): void {
    this.fs.mkdir(path, mode);
  }

  rmdir(path: string): void {
    this.fs.rmdir(path);
  }

  unlink(path: string): void {
    const removed = this.fs.unlink(path);
    const key = memoryFileSystemInodeKey(removed.ino, removed.generation);
    if (
      removed.linkCount > 1 &&
      (this.lazyFiles.has(key) || this.lazyArchiveInodes.has(key))
    ) {
      // A peer may have added hard-link names this instance never observed.
      // Rebuild aliases from SharedFS instead of treating an empty local path
      // set as proof that the inode disappeared.
      this.reconcileLazyIdentityState(this.fs.identityState());
      return;
    }

    const lazy = this.lazyFiles.get(key);
    if (lazy) {
      lazy.paths.delete(path);
      if (removed.linkCount <= 1) {
        this.lazyFiles.delete(key);
      } else if (lazy.path === path) {
        lazy.path = lazy.paths.values().next().value!;
      }
    }

    const group = this.lazyArchiveInodes.get(key);
    if (group) {
      const ordinaryDefinition = this.ordinaryLazyTreeDefinitions.get(group);
      if (ordinaryDefinition !== undefined) {
        const entries = removed.linkCount <= 1
          ? ordinaryDefinition.entries.map((candidate) =>
            candidate.ino === removed.ino &&
              candidate.generation === removed.generation
              ? { ...candidate, deleted: true }
              : candidate
          )
          : ordinaryDefinition.entries.filter((candidate) =>
            candidate.vfsPath !== path
          );
        this.replaceOrdinaryLazyTreeRuntimeState(
          group,
          entries,
          ordinaryDefinition.materialized,
        );
        if (removed.linkCount <= 1) this.lazyArchiveInodes.delete(key);
      } else {
        const entry = group.entries.get(path);
        if (removed.linkCount <= 1) {
          for (const candidate of group.entries.values()) {
            if (
              candidate.ino === removed.ino &&
              candidate.generation === removed.generation
            )
              candidate.deleted = true;
          }
          this.lazyArchiveInodes.delete(key);
        } else if (entry) {
          group.entries.delete(path);
        }
      }
    }
  }

  rename(oldPath: string, newPath: string): void {
    const { source, replaced } = this.fs.rename(oldPath, newPath);

    if (
      replaced &&
      replaced.ino === source.ino &&
      replaced.generation === source.generation
    )
      return;

    let reconciledNamespace = false;
    if (replaced) {
      const replacedKey = memoryFileSystemInodeKey(
        replaced.ino,
        replaced.generation,
      );
      if (
        replaced.linkCount > 1 &&
        (this.lazyFiles.has(replacedKey) ||
          this.lazyArchiveInodes.has(replacedKey))
      ) {
        // The replaced inode survived through a hard link that may have been
        // created by a peer. One authoritative reconciliation updates both
        // that alias and the source paths changed by rename().
        this.reconcileLazyIdentityState(this.fs.identityState());
        reconciledNamespace = true;
      }

      const replacedLazy = this.lazyFiles.get(replacedKey);
      if (!reconciledNamespace && replacedLazy) {
        replacedLazy.paths.delete(newPath);
        if (replaced.linkCount <= 1) {
          this.lazyFiles.delete(replacedKey);
        } else if (replacedLazy.path === newPath) {
          replacedLazy.path = replacedLazy.paths.values().next().value!;
        }
      }
      const replacedGroup = this.lazyArchiveInodes.get(replacedKey);
      if (!reconciledNamespace && replacedGroup) {
        const ordinaryDefinition =
          this.ordinaryLazyTreeDefinitions.get(replacedGroup);
        if (ordinaryDefinition !== undefined) {
          const entries = replaced.linkCount <= 1
            ? ordinaryDefinition.entries.map((candidate) =>
              candidate.ino === replaced.ino &&
                candidate.generation === replaced.generation
                ? { ...candidate, deleted: true }
                : candidate
            )
            : ordinaryDefinition.entries.filter((candidate) =>
              candidate.vfsPath !== newPath
            );
          this.replaceOrdinaryLazyTreeRuntimeState(
            replacedGroup,
            entries,
            ordinaryDefinition.materialized,
          );
          if (replaced.linkCount <= 1) {
            this.lazyArchiveInodes.delete(replacedKey);
          }
        } else {
          const entry = replacedGroup.entries.get(newPath);
          if (replaced.linkCount <= 1) {
            if (entry) entry.deleted = true;
            this.lazyArchiveInodes.delete(replacedKey);
          } else if (entry) {
            replacedGroup.entries.delete(newPath);
          }
        }
      }
    }

    if (!reconciledNamespace) {
      this.rewriteLazyNamespacePaths(source, oldPath, newPath);
    }
  }

  link(existingPath: string, newPath: string): void {
    const sourceIdentity = this.fs.link(existingPath, newPath);
    const key = memoryFileSystemInodeKey(
      sourceIdentity.ino,
      sourceIdentity.generation,
    );
    const lazy = this.lazyFiles.get(key);
    if (lazy) lazy.paths.add(newPath);

    const group = this.lazyArchiveInodes.get(key);
    if (group) {
      const ordinaryDefinition = this.ordinaryLazyTreeDefinitions.get(group);
      if (ordinaryDefinition !== undefined) {
        const source = ordinaryDefinition.entries.find((entry) =>
          entry.ino === sourceIdentity.ino &&
          entry.generation === sourceIdentity.generation
        );
        if (source !== undefined) {
          this.replaceOrdinaryLazyTreeRuntimeState(
            group,
            [...ordinaryDefinition.entries, { ...source, vfsPath: newPath }],
            ordinaryDefinition.materialized,
          );
        }
      } else {
        const source = Array.from(group.entries.values()).find(
          (entry) =>
            entry.ino === sourceIdentity.ino &&
            entry.generation === sourceIdentity.generation,
        );
        if (source) group.entries.set(newPath, { ...source });
      }
    }
  }

  symlink(target: string, path: string): void {
    this.fs.symlink(target, path);
  }

  readlink(path: string): string {
    return this.fs.readlink(path);
  }

  chmod(path: string, mode: number): void {
    this.fs.chmod(path, mode);
  }
  chown(path: string, uid: number, gid: number): void {
    this.fs.chown(path, uid, gid);
  }
  lchown(path: string, uid: number, gid: number): void {
    this.fs.lchown(path, uid, gid);
  }

  createFileWithOwner(
    path: string,
    mode: number,
    uid: number,
    gid: number,
    content: Uint8Array,
  ): void {
    const fd = this.open(path, O_WRONLY_CREAT_TRUNC, mode);
    if (content.length > 0) this.write(fd, content, null, content.length);
    this.close(fd);
    this.chown(path, uid, gid);
    this.chmod(path, mode);
  }

  mkdirWithOwner(path: string, mode: number, uid: number, gid: number): void {
    this.mkdir(path, mode);
    this.chown(path, uid, gid);
    this.chmod(path, mode);
  }

  symlinkWithOwner(
    target: string,
    path: string,
    uid: number,
    gid: number,
  ): void {
    this.symlink(target, path);
    this.lchown(path, uid, gid);
  }

  private copyPathToFreshFileSystem(
    path: string,
    target: MemoryFileSystem,
    lazyFilePaths: Set<string>,
    lazyArchiveStubPaths: Set<string>,
    hardLinks: Map<string, string>,
  ): void {
    const st = this.lstat(path);
    const kind = st.mode & S_IFMT;
    const mode = st.mode & FILE_MODES.S_MODE_BITS;

    if (kind === S_IFDIR) {
      if (path === "/") {
        target.chown(path, st.uid, st.gid);
        target.chmod(path, mode);
      } else {
        target.mkdirWithOwner(path, mode, st.uid, st.gid);
      }

      const dh = this.opendir(path);
      try {
        for (;;) {
          const entry = this.readdir(dh);
          if (!entry) break;
          if (entry.name === "." || entry.name === "..") continue;
          this.copyPathToFreshFileSystem(
            path === "/" ? `/${entry.name}` : `${path}/${entry.name}`,
            target,
            lazyFilePaths,
            lazyArchiveStubPaths,
            hardLinks,
          );
        }
      } finally {
        this.closedir(dh);
      }
      MemoryFileSystem.applyTimes(target, path, st);
      return;
    }

    const identity = st.nlink > 1 ? `${st.dev}:${st.ino}` : null;
    const existingHardLink = identity ? hardLinks.get(identity) : undefined;
    if (existingHardLink) {
      target.link(existingHardLink, path);
      return;
    }

    if (kind === S_IFLNK) {
      target.symlinkWithOwner(this.readlink(path), path, st.uid, st.gid);
      if (identity) hardLinks.set(identity, path);
      return;
    }

    if (kind !== S_IFREG) {
      throw new Error(`Unsupported file type while rebasing VFS: ${path}`);
    }

    const isLazyStub =
      lazyFilePaths.has(path) || lazyArchiveStubPaths.has(path);
    if (isLazyStub) {
      target.createFileWithOwner(path, mode, st.uid, st.gid, new Uint8Array(0));
      MemoryFileSystem.applyTimes(target, path, st);
      if (identity) hardLinks.set(identity, path);
      return;
    }

    this.copyRegularFileToFreshFileSystem(path, target, st, mode);
    if (identity) hardLinks.set(identity, path);
  }

  private copyRegularFileToFreshFileSystem(
    path: string,
    target: MemoryFileSystem,
    st: StatResult,
    mode: number,
  ): void {
    const inFd = this.open(path, O_RDONLY, 0);
    let outFd: number | null = null;
    try {
      outFd = target.open(path, O_WRONLY_CREAT_TRUNC, mode);
      const chunk = new Uint8Array(
        Math.min(COPY_CHUNK_BYTES, Math.max(1, st.size)),
      );
      let remaining = st.size;
      while (remaining > 0) {
        const wanted = Math.min(chunk.byteLength, remaining);
        const nread = this.read(inFd, chunk, null, wanted);
        if (nread <= 0) {
          throw new Error(`Unexpected EOF while rebasing VFS file: ${path}`);
        }
        let written = 0;
        while (written < nread) {
          const nwritten = target.write(
            outFd,
            chunk.subarray(written, nread),
            null,
            nread - written,
          );
          if (nwritten <= 0) {
            throw new Error(`Short write while rebasing VFS file: ${path}`);
          }
          written += nwritten;
        }
        remaining -= nread;
      }
    } finally {
      if (outFd !== null) target.close(outFd);
      this.close(inFd);
    }
    target.chown(path, st.uid, st.gid);
    target.chmod(path, mode);
    MemoryFileSystem.applyTimes(target, path, st);
  }

  private static applyTimes(
    fs: MemoryFileSystem,
    path: string,
    st: StatResult,
  ): void {
    const atimeSec = Math.floor(st.atimeMs / 1000);
    const atimeNsec = Math.floor((st.atimeMs - atimeSec * 1000) * 1_000_000);
    const mtimeSec = Math.floor(st.mtimeMs / 1000);
    const mtimeNsec = Math.floor((st.mtimeMs - mtimeSec * 1000) * 1_000_000);
    fs.utimensat(path, atimeSec, atimeNsec, mtimeSec, mtimeNsec);
  }

  // access: check if path exists by stat'ing it (stat throws on error)
  access(path: string, _mode: number): void {
    this.fs.stat(path);
  }

  utimensat(
    path: string,
    atimeSec: number,
    atimeNsec: number,
    mtimeSec: number,
    mtimeNsec: number,
  ): void {
    this.fs.utimens(path, atimeSec, atimeNsec, mtimeSec, mtimeNsec);
  }

  opendir(path: string): number {
    return this.fs.opendir(path);
  }

  readdir(handle: number): DirEntry | null {
    const entry = this.fs.readdirEntry(handle);
    if (!entry) return null;
    // Determine d_type from mode
    const mode = entry.stat.mode;
    let dtype: number = DT_UNKNOWN;
    if ((mode & S_IFMT) === S_IFREG) dtype = DT_REG;
    else if ((mode & S_IFMT) === S_IFDIR) dtype = DT_DIR;
    else if ((mode & S_IFMT) === S_IFLNK) dtype = DT_LNK;
    return { name: entry.name, type: dtype, ino: entry.stat.ino };
  }

  closedir(handle: number): void {
    this.fs.closedir(handle);
  }
}

const intrinsicCreateFreshMemoryFileSystem = MemoryFileSystem.createFresh;

/** Invoke the captured fresh-backing constructor. */
export function createFreshMemoryFileSystem(
  byteLength: number,
): MemoryFileSystem {
  return intrinsicApply(
    intrinsicCreateFreshMemoryFileSystem,
    MemoryFileSystem,
    [byteLength],
  ) as MemoryFileSystem;
}

export interface MemoryFileSystemInodeIdentity {
  dev: number;
  ino: number;
  generation: number;
}

interface MemoryFileSystemIdentitySource {
  qualifiedInodeIdentity(path: string): MemoryFileSystemInodeIdentity;
}

const intrinsicQualifiedInodeIdentity = (
  MemoryFileSystem.prototype as unknown as MemoryFileSystemIdentitySource
).qualifiedInodeIdentity;

/**
 * Capture one wrapper-qualified MemoryFS inode identity. JavaScript exposes no
 * primitive for comparing distinct SharedArrayBuffer wrappers' backing data,
 * so cross-wrapper security also requires fresh private construction.
 *
 * This read-only, single-path helper is deliberately absent from the public
 * VFS entry point. It cannot mint the immutable-product brand.
 */
export function captureMemoryFileSystemInodeIdentity(
  source: MemoryFileSystem,
  path: string,
): MemoryFileSystemInodeIdentity {
  if (
    !intrinsicApply(
      intrinsicWeakSetHas,
      memoryFileSystemInstances,
      [source],
    )
  ) {
    throw new Error("inode identity source must be a genuine MemoryFileSystem");
  }
  return intrinsicApply(
    intrinsicQualifiedInodeIdentity,
    source,
    [path],
  ) as MemoryFileSystemInodeIdentity;
}

const immutableProductMemoryFileSystemPrototype = capturePrivatePrototype(
  MemoryFileSystem.prototype,
);

const IMMUTABLE_PRODUCT_MUTATORS = new Set<PropertyKey>([
  "write",
  "append",
  "ftruncate",
  "fchmod",
  "fchown",
  "mkdir",
  "rmdir",
  "unlink",
  "rename",
  "link",
  "symlink",
  "chmod",
  "chown",
  "lchown",
  "utimensat",
]);

const IMMUTABLE_PRODUCT_READ_OPERATIONS = new Map<PropertyKey, unknown>([
  ["preparePath", MemoryFileSystem.prototype.preparePath],
  ["close", MemoryFileSystem.prototype.close],
  ["read", MemoryFileSystem.prototype.read],
  ["seek", MemoryFileSystem.prototype.seek],
  ["fstat", MemoryFileSystem.prototype.fstat],
  ["fpathconf", MemoryFileSystem.prototype.fpathconf],
  ["fsync", MemoryFileSystem.prototype.fsync],
  ["stat", MemoryFileSystem.prototype.stat],
  ["lstat", MemoryFileSystem.prototype.lstat],
  ["statfs", MemoryFileSystem.prototype.statfs],
  ["pathconf", MemoryFileSystem.prototype.pathconf],
  ["readlink", MemoryFileSystem.prototype.readlink],
  ["opendir", MemoryFileSystem.prototype.opendir],
  ["readdir", MemoryFileSystem.prototype.readdir],
  ["closedir", MemoryFileSystem.prototype.closedir],
]);

interface ImmutableProductSnapshotSource {
  snapshotForImmutableProduct(): MemoryFileSystem;
}

const intrinsicImmutableProductSnapshot = (
  MemoryFileSystem.prototype as unknown as ImmutableProductSnapshotSource
).snapshotForImmutableProduct;
const intrinsicMemoryFileSystemOpen = MemoryFileSystem.prototype.open;
const intrinsicMemoryFileSystemAccess = MemoryFileSystem.prototype.access;

function immutableProductReadonlyFailure(): never {
  throw new SFSError(EROFS, "EROFS: Read-only file system");
}

function normalizeImmutableProductInteger(
  value: unknown,
  label: string,
): number {
  const normalized = IntrinsicNumber(value);
  if (!intrinsicNumberIsInteger(normalized)) {
    throw new IntrinsicTypeError(`${label} must be an integer`);
  }
  return normalized;
}

/**
 * Create the internal backend used for reviewed, immutable product binaries.
 *
 * This factory is deliberately not re-exported by the public VFS entry point.
 * The wrapper preserves MemoryFS's open inode-generation lease while denying
 * every guest-visible content, namespace, ownership, and mode mutation.
 */
export function createImmutableProductBackend(
  source: MemoryFileSystem,
): FileSystemBackend {
  if (
    !intrinsicApply(
      intrinsicWeakSetHas,
      memoryFileSystemInstances,
      [source],
    )
  ) {
    throw new Error(
      "immutable product source must be a genuine MemoryFileSystem",
    );
  }
  const snapshot = intrinsicApply(
    intrinsicImmutableProductSnapshot,
    source,
    [],
  ) as MemoryFileSystem;
  if (
    snapshot === source ||
    !intrinsicApply(
      intrinsicWeakSetHas,
      memoryFileSystemInstances,
      [snapshot],
    )
  ) {
    throw new Error("immutable product source snapshot was not isolated");
  }
  intrinsicObjectSetPrototypeOf(
    snapshot,
    immutableProductMemoryFileSystemPrototype,
  );

  const facade = intrinsicObjectCreate(null) as FileSystemBackend;
  const backend = new IntrinsicProxy(facade, {
    get(_target, property) {
      if (
        intrinsicApply(
          intrinsicSetHas,
          IMMUTABLE_PRODUCT_MUTATORS,
          [property],
        )
      ) {
        return immutableProductReadonlyFailure;
      }
      if (property === "open") {
        return (path: string, flags: number, mode: number): number => {
          const normalizedFlags = normalizeImmutableProductInteger(
            flags,
            "immutable product open flags",
          );
          const accessMode = normalizedFlags & IMMUTABLE_PRODUCT_O_ACCMODE;
          const mutates =
            (normalizedFlags &
              (IMMUTABLE_PRODUCT_O_CREAT | IMMUTABLE_PRODUCT_O_TRUNC)) !== 0;
          if (accessMode !== O_RDONLY || mutates) {
            return immutableProductReadonlyFailure();
          }
          return intrinsicApply(
            intrinsicMemoryFileSystemOpen,
            snapshot,
            [path, normalizedFlags, mode],
          ) as number;
        };
      }
      if (property === "access") {
        return (path: string, mode: number): void => {
          const normalizedMode = normalizeImmutableProductInteger(
            mode,
            "immutable product access mode",
          );
          if ((normalizedMode & IMMUTABLE_PRODUCT_W_OK) !== 0) {
            immutableProductReadonlyFailure();
          }
          intrinsicApply(
            intrinsicMemoryFileSystemAccess,
            snapshot,
            [path, normalizedMode],
          );
        };
      }
      const operation = intrinsicApply(
        intrinsicMapGet,
        IMMUTABLE_PRODUCT_READ_OPERATIONS,
        [property],
      ) as unknown;
      if (typeof operation === "function") {
        return (...args: unknown[]): unknown =>
          intrinsicApply(operation, snapshot, args);
      }
      // Do not leak MemoryFileSystem's producer-only helpers or private state
      // through the narrower FileSystemBackend wrapper.
      return undefined;
    },
    set: () => false,
    defineProperty: () => false,
    deleteProperty: () => false,
  });
  intrinsicApply(intrinsicWeakSetAdd, immutableProductBackends, [backend]);
  return backend;
}

/** Resolve one mount's set-ID policy from private backend provenance. */
export function resolveMountSetIdCapability(
  config: Pick<MountConfig, "backend" | "readonly" | "setIdCapability">,
): MountSetIdCapability {
  const requested = config.setIdCapability;
  if (requested === undefined) {
    return NOSUID_CAPABILITY;
  }
  if (
    typeof requested !== "object" || requested === null ||
    Array.isArray(requested)
  ) {
    throw new Error("unknown set-ID mount capability");
  }
  if (requested.kind === "nosuid") return NOSUID_CAPABILITY;
  if (requested.kind !== "trusted-root-product") {
    throw new Error("unknown set-ID mount capability");
  }
  if (requested.guestWritable !== false) {
    throw new Error("trusted root product mount must not be guest-writable");
  }
  if (config.readonly !== true) {
    throw new Error("trusted root product mount must be read-only");
  }
  if (requested.stableExecutableIdentity !== true) {
    throw new Error(
      "trusted root product mount must require stable executable identity",
    );
  }
  if (
    !intrinsicApply(
      intrinsicWeakSetHas,
      immutableProductBackends,
      [config.backend],
    )
  ) {
    throw new Error(
      "trusted root product mount requires an admitted immutable product backend with immutable handle generation identity",
    );
  }
  return TRUSTED_ROOT_PRODUCT_CAPABILITY;
}

// fzstd is a regular sync static import (see top of file). Earlier we
// tried lazy-loading it via top-level `await import("fzstd")`, but a
// top-level await turns this module — and every consumer, including
// the kernel worker entry — into an async module. `BrowserKernel.boot
// Worker()` posts its `init` message immediately after `new Worker(url)`,
// before the worker's async load completes; the message was being
// dropped before the worker's onmessage handler became reachable. A
// static import is bundled by Vite for browser pages and resolved by
// Node for tests + build scripts (host/package.json + apps/browser-demos/
// package.json both declare fzstd, so it's always installed).
function decompressZstd(image: Uint8Array): Uint8Array {
  return zstdDecompress(image);
}
