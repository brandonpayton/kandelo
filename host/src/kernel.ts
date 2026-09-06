/**
 * WasmPosixKernel — Loads the kernel Wasm module and provides host
 * import functions that bridge Wasm syscalls to the PlatformIO backend.
 *
 * Host import functions exposed to Wasm:
 *   env.host_open(path_ptr, path_len, flags, mode) -> i64
 *   env.host_close(handle: i64) -> i32
 *   env.host_read(handle: i64, buf_ptr, buf_len) -> i32
 *   env.host_write(handle: i64, buf_ptr, buf_len) -> i32
 *   env.host_append(handle: i64, buf_ptr, buf_len, limit_lo, limit_hi) -> i32
 *   env.host_append_position(handle: i64, written) -> i64
 *   env.host_pread(handle: i64, buf_ptr, buf_len, offset_lo, offset_hi) -> i32
 *   env.host_pwrite(handle: i64, buf_ptr, buf_len, offset_lo, offset_hi) -> i32
 *   env.host_seek(handle: i64, offset_lo, offset_hi, whence) -> i64
 *   env.host_fstat(handle: i64, stat_ptr) -> i32
 *   env.host_statfs(path_ptr, path_len, statfs_ptr) -> i32
 *   env.host_fstatfs(handle, statfs_ptr) -> i32
 *
 * IMPORTANT: Wasm i64 values appear as BigInt in JavaScript.
 */

import type {
  AppendOutcome,
  HostFileOffset,
  KernelConfig,
  PlatformIO,
  StatResult,
  StatfsResult,
} from "./types";
import { checkedHostFileOffset } from "./file-offset";
import { isHostAppendContractError } from "./append-contract";
import { SharedPipeBuffer } from "./shared-pipe-buffer";
import { FramebufferRegistry } from "./framebuffer/registry";
import { GbmBoRegistry } from "./dri/registry";
import { KmsRegistry } from "./dri/kms-registry";
import { GlContextRegistry } from "./webgl/registry";
import { decodeAndDispatch, validateCommandBuffer } from "./webgl/bridge";
import { runGlQuery } from "./webgl/query";
import { SubmitQueue } from "./webgl/submit-queue";
import { GlMuxer } from "./webgl/muxer";
import { drainSubmitQueue } from "./webgl/submit-drain";
import {
  IOCTL_REQUESTS,
  KERNEL_SCRATCH_FD_PAIR_BYTES,
  KERNEL_SCRATCH_SOCKLEN_BYTES,
  SELECT_FD_SET_BYTES,
  SELECT_FD_SETSIZE,
  STRUCT_SIZE_WASM_DIRENT,
  STRUCT_SIZE_WASM_POLL_FD,
  STRUCT_SIZE_WASM_STAT,
  STRUCT_SIZE_WASM_STATFS,
  STRUCT_SIZE_WPK_DRM_MODE_MODEINFO,
  WASM_DIRENT_INO_OFFSET,
  WASM_DIRENT_NAME_LENGTH_OFFSET,
  WASM_DIRENT_TYPE_OFFSET,
  WASM_POLL_FD_EVENTS_OFFSET,
  WASM_POLL_FD_FD_OFFSET,
  WASM_POLL_FD_REVENTS_OFFSET,
} from "./generated/abi";
import { detectPtrWidth } from "./constants";
import {
  allocateKernelScratchRegion,
  checkedMemoryRange,
  checkedWasmImportMemoryRange,
  checkedWasmPointer,
  intrinsicUint8ArrayView,
  KernelScratchError,
  type KernelScratchRegion,
} from "./kernel-scratch";
import {
  createKernelEntryGatedInstance,
  createKernelEntryScopedInstance,
  KernelEntryGate,
} from "./kernel-entry-gate";

export type KernelPointer = number | bigint;

interface WasmPosixKernelRuntimeAccess {
  readonly gate: KernelEntryGate;
  readonly instance: () => WebAssembly.Instance | null;
  readonly memory: () => WebAssembly.Memory | null;
}

// Package-private authority used by kernel-worker.ts. It is intentionally not
// re-exported from the host package entry point.
const wasmPosixKernelRuntimeAccess =
  new WeakMap<WasmPosixKernel, WasmPosixKernelRuntimeAccess>();

/** @internal Dedicated-worker access; never return this from a public API. */
export function getWasmPosixKernelRuntimeAccess(
  kernel: WasmPosixKernel,
): WasmPosixKernelRuntimeAccess {
  const access = intrinsicApply(
    intrinsicWeakMapGet,
    wasmPosixKernelRuntimeAccess,
    [kernel],
  ) as WasmPosixKernelRuntimeAccess | undefined;
  if (access === undefined) {
    throw new Error("unknown WasmPosixKernel runtime");
  }
  return access;
}

const MAX_U64 = (1n << 64n) - 1n;
const intrinsicApply = Reflect.apply;
const intrinsicBigInt = BigInt;
const intrinsicNumber = Number;
const intrinsicNumberIsSafeInteger = Number.isSafeInteger;
const INTRINSIC_NUMBER_MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;
const intrinsicWeakMapGet = WeakMap.prototype.get;
const intrinsicWeakMapSet = WeakMap.prototype.set;
const intrinsicArrayBufferIsView = ArrayBuffer.isView;
const intrinsicArrayBufferByteLength = Object.getOwnPropertyDescriptor(
  ArrayBuffer.prototype,
  "byteLength",
)!.get!;
const intrinsicSharedArrayBufferByteLength =
  typeof SharedArrayBuffer === "undefined"
    ? null
    : Object.getOwnPropertyDescriptor(
      SharedArrayBuffer.prototype,
      "byteLength",
    )!.get!;
const intrinsicDataViewBuffer = Object.getOwnPropertyDescriptor(
  DataView.prototype,
  "buffer",
)!.get!;
const intrinsicDataViewByteOffset = Object.getOwnPropertyDescriptor(
  DataView.prototype,
  "byteOffset",
)!.get!;
const intrinsicDataViewByteLength = Object.getOwnPropertyDescriptor(
  DataView.prototype,
  "byteLength",
)!.get!;
const intrinsicTypedArrayPrototype = Object.getPrototypeOf(
  Uint8Array.prototype,
);
const intrinsicTypedArrayBuffer = Object.getOwnPropertyDescriptor(
  intrinsicTypedArrayPrototype,
  "buffer",
)!.get!;
const intrinsicTypedArrayByteOffset = Object.getOwnPropertyDescriptor(
  intrinsicTypedArrayPrototype,
  "byteOffset",
)!.get!;
const intrinsicTypedArrayByteLength = Object.getOwnPropertyDescriptor(
  intrinsicTypedArrayPrototype,
  "byteLength",
)!.get!;
const IntrinsicUint8Array = Uint8Array;
const IntrinsicInt32Array = Int32Array;
const IntrinsicDataView = DataView;
const IntrinsicWasmMemory = WebAssembly.Memory;
const intrinsicUint8ArraySet = Uint8Array.prototype.set;
const intrinsicUint8ArraySlice = Uint8Array.prototype.slice;
const intrinsicUint8ArraySubarray = Uint8Array.prototype.subarray;
const intrinsicDataViewGetInt16 = DataView.prototype.getInt16;
const intrinsicDataViewGetInt32 = DataView.prototype.getInt32;
const intrinsicDataViewGetUint8 = DataView.prototype.getUint8;
const intrinsicDataViewGetUint32 = DataView.prototype.getUint32;
const intrinsicDataViewSetBigInt64 = DataView.prototype.setBigInt64;
const intrinsicDataViewSetBigUint64 = DataView.prototype.setBigUint64;
const intrinsicDataViewSetInt16 = DataView.prototype.setInt16;
const intrinsicDataViewSetInt32 = DataView.prototype.setInt32;
const intrinsicDataViewSetUint8 = DataView.prototype.setUint8;
const intrinsicDataViewSetUint16 = DataView.prototype.setUint16;
const intrinsicDataViewSetUint32 = DataView.prototype.setUint32;
const intrinsicAtomicsCompareExchange = Atomics.compareExchange;
const intrinsicAtomicsLoad = Atomics.load;
const intrinsicAtomicsNotify = Atomics.notify;
const intrinsicAtomicsStore = Atomics.store;
const intrinsicAtomicsWait = Atomics.wait;
const intrinsicReflectConstruct = Reflect.construct;
const intrinsicObjectCreate = Object.create;
const intrinsicObjectDefineProperty = Object.defineProperty;
const intrinsicObjectFreeze = Object.freeze;
const intrinsicWasmCompile = WebAssembly.compile;
const intrinsicWasmInstantiate = WebAssembly.instantiate;
const intrinsicWasmMemoryBuffer = Object.getOwnPropertyDescriptor(
  WebAssembly.Memory.prototype,
  "buffer",
)!.get!;
const intrinsicWasmInstanceExports = Object.getOwnPropertyDescriptor(
  WebAssembly.Instance.prototype,
  "exports",
)!.get!;
const intrinsicWasmTableGet = WebAssembly.Table.prototype.get;

const wasmPosixKernelTestCapability = {};

interface WasmPosixKernelTestHarnessOptions {
  readonly config?: KernelConfig;
  readonly io?: PlatformIO;
  readonly callbacks?: KernelCallbacks;
  readonly instance?: WebAssembly.Instance | null;
  readonly memory?: WebAssembly.Memory | null;
  readonly pointerWidth?: 4 | 8;
  readonly initialized?: boolean;
  readonly engine?: {
    readonly compile: (
      bytes: BufferSource,
    ) => Promise<WebAssembly.Module>;
    readonly instantiate: (
      module: WebAssembly.Module,
      imports: WebAssembly.Imports,
    ) => Promise<WebAssembly.Instance>;
  };
}

interface WasmPosixKernelTestAuthority {
  buildImportObject(memory: WebAssembly.Memory): WebAssembly.Imports;
  writeKernelBytes(
    pointer: KernelPointer,
    capacity: number | bigint,
    bytes: Uint8Array,
  ): void;
  hostFstat(handle: bigint, statPointer: KernelPointer): number;
  hostOpendir(pathPointer: KernelPointer, pathLength: number): bigint;
  hostReaddir(
    handle: bigint,
    direntPointer: KernelPointer,
    namePointer: KernelPointer,
    nameLength: number,
  ): number;
  hostClosedir(handle: bigint): number;
  hostClose(handle: bigint): number;
}

type WasmPosixKernelTestHarness = WasmPosixKernel & {
  readonly testAuthority: WasmPosixKernelTestAuthority;
};

declare const rustLentKernelDestinationBrand: unique symbol;

/**
 * Opaque proof that one host-import destination belongs to this exact kernel
 * generation and carries an explicit Rust-declared capacity.
 *
 * The pointer and ownership record intentionally live only in the module
 * WeakMap below. Structural objects with the same public capacity cannot be
 * used to authorize a write.
 */
interface RustLentKernelDestination {
  readonly [rustLentKernelDestinationBrand]: never;
  readonly capacity: number;
}

interface RustLentKernelDestinationRecord {
  readonly owner: WasmPosixKernel;
  readonly generation: object;
  readonly memory: WebAssembly.Memory;
  readonly pointer: number;
  readonly capacity: number;
  readonly label: string;
  consumed: boolean;
}

const rustLentKernelDestinationRecords =
  new WeakMap<object, RustLentKernelDestinationRecord>();

/**
 * @internal Build a real private-branded wrapper for focused host unit tests.
 *
 * WHY: scratch tests need deterministic fake Wasm exports, but an
 * `Object.create(WasmPosixKernel.prototype)` double has no JavaScript private
 * field brand. The unexported capability keeps this construction path out of
 * supported package entry points and prevents reflective callers from
 * replacing a live generation's Instance or Memory after construction.
 */
export function createWasmPosixKernelTestHarness(
  options: WasmPosixKernelTestHarnessOptions,
): WasmPosixKernelTestHarness {
  return intrinsicReflectConstruct(
    WasmPosixKernel,
    [
      options.config ?? ({} as KernelConfig),
      options.io ?? ({} as PlatformIO),
      options.callbacks,
      wasmPosixKernelTestCapability,
      options,
    ],
  ) as WasmPosixKernelTestHarness;
}

function wasmMemoryBuffer(memory: WebAssembly.Memory): ArrayBufferLike {
  return intrinsicApply(
    intrinsicWasmMemoryBuffer,
    memory,
    [],
  ) as ArrayBufferLike;
}

function wasmInstanceExports(
  instance: WebAssembly.Instance,
): WebAssembly.Exports {
  return intrinsicApply(
    intrinsicWasmInstanceExports,
    instance,
    [],
  ) as WebAssembly.Exports;
}

function bufferByteLength(buffer: ArrayBufferLike): number {
  try {
    return intrinsicApply(
      intrinsicArrayBufferByteLength,
      buffer,
      [],
    ) as number;
  } catch {
    if (intrinsicSharedArrayBufferByteLength !== null) {
      return intrinsicApply(
        intrinsicSharedArrayBufferByteLength,
        buffer,
        [],
      ) as number;
    }
    throw new TypeError("memory buffer is not a genuine attached buffer");
  }
}

function typedArrayBuffer(view: Uint8Array): ArrayBufferLike {
  return intrinsicApply(
    intrinsicTypedArrayBuffer,
    view,
    [],
  ) as ArrayBufferLike;
}

function typedArrayByteOffset(view: Uint8Array): number {
  return intrinsicApply(
    intrinsicTypedArrayByteOffset,
    view,
    [],
  ) as number;
}

function typedArrayByteLength(view: Uint8Array): number {
  return intrinsicApply(
    intrinsicTypedArrayByteLength,
    view,
    [],
  ) as number;
}

function sliceUint8Array(
  view: Uint8Array,
  start?: number,
  end?: number,
): Uint8Array {
  return intrinsicApply(
    intrinsicUint8ArraySlice,
    view,
    end === undefined
      ? start === undefined ? [] : [start]
      : [start ?? 0, end],
  ) as Uint8Array;
}

function subarrayUint8Array(
  view: Uint8Array,
  start: number,
  end?: number,
): Uint8Array {
  return intrinsicApply(
    intrinsicUint8ArraySubarray,
    view,
    end === undefined ? [start] : [start, end],
  ) as Uint8Array;
}

function dataViewGetInt16(
  view: DataView,
  byteOffset: number,
  littleEndian = false,
): number {
  return intrinsicApply(
    intrinsicDataViewGetInt16,
    view,
    [byteOffset, littleEndian],
  ) as number;
}

function dataViewGetInt32(
  view: DataView,
  byteOffset: number,
  littleEndian = false,
): number {
  return intrinsicApply(
    intrinsicDataViewGetInt32,
    view,
    [byteOffset, littleEndian],
  ) as number;
}

function dataViewGetUint8(view: DataView, byteOffset: number): number {
  return intrinsicApply(
    intrinsicDataViewGetUint8,
    view,
    [byteOffset],
  ) as number;
}

function dataViewGetUint32(
  view: DataView,
  byteOffset: number,
  littleEndian = false,
): number {
  return intrinsicApply(
    intrinsicDataViewGetUint32,
    view,
    [byteOffset, littleEndian],
  ) as number;
}

function dataViewSetBigInt64(
  view: DataView,
  byteOffset: number,
  value: bigint,
  littleEndian = false,
): void {
  intrinsicApply(
    intrinsicDataViewSetBigInt64,
    view,
    [byteOffset, value, littleEndian],
  );
}

function dataViewSetBigUint64(
  view: DataView,
  byteOffset: number,
  value: bigint,
  littleEndian = false,
): void {
  intrinsicApply(
    intrinsicDataViewSetBigUint64,
    view,
    [byteOffset, value, littleEndian],
  );
}

function dataViewSetInt16(
  view: DataView,
  byteOffset: number,
  value: number,
  littleEndian = false,
): void {
  intrinsicApply(
    intrinsicDataViewSetInt16,
    view,
    [byteOffset, value, littleEndian],
  );
}

function dataViewSetInt32(
  view: DataView,
  byteOffset: number,
  value: number,
  littleEndian = false,
): void {
  intrinsicApply(
    intrinsicDataViewSetInt32,
    view,
    [byteOffset, value, littleEndian],
  );
}

function dataViewSetUint8(
  view: DataView,
  byteOffset: number,
  value: number,
): void {
  intrinsicApply(intrinsicDataViewSetUint8, view, [byteOffset, value]);
}

function dataViewSetUint16(
  view: DataView,
  byteOffset: number,
  value: number,
  littleEndian = false,
): void {
  intrinsicApply(
    intrinsicDataViewSetUint16,
    view,
    [byteOffset, value, littleEndian],
  );
}

function dataViewSetUint32(
  view: DataView,
  byteOffset: number,
  value: number,
  littleEndian = false,
): void {
  intrinsicApply(
    intrinsicDataViewSetUint32,
    view,
    [byteOffset, value, littleEndian],
  );
}

function signedI64FromWords(offsetLo: number, offsetHi: number): bigint {
  return (intrinsicBigInt(offsetHi | 0) << 32n)
    | intrinsicBigInt(offsetLo >>> 0);
}

/** Reconstruct an unsigned 64-bit value from two 32-bit words (both treated as
 * unsigned). Used for rootfs `blob_id`/`offset`, which are never negative. */
function u64FromWords(lo: number, hi: number): bigint {
  return (intrinsicBigInt(hi >>> 0) << 32n)
    | intrinsicBigInt(lo >>> 0);
}

interface IntrinsicBufferSourceSpan {
  buffer: ArrayBufferLike;
  byteOffset: number;
  byteLength: number;
}

function exactU64(value: number | bigint, field: string): bigint {
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

function intrinsicBufferSourceSpan(
  source: BufferSource,
): IntrinsicBufferSourceSpan {
  try {
    if (!intrinsicArrayBufferIsView(source)) {
      return {
        buffer: source,
        byteOffset: 0,
        byteLength: intrinsicApply(
          intrinsicArrayBufferByteLength,
          source,
          [],
        ) as number,
      };
    }

    try {
      return {
        buffer: intrinsicApply(
          intrinsicDataViewBuffer,
          source,
          [],
        ) as ArrayBufferLike,
        byteOffset: intrinsicApply(
          intrinsicDataViewByteOffset,
          source,
          [],
        ) as number,
        byteLength: intrinsicApply(
          intrinsicDataViewByteLength,
          source,
          [],
        ) as number,
      };
    } catch {
      return {
        buffer: intrinsicApply(
          intrinsicTypedArrayBuffer,
          source,
          [],
        ) as ArrayBufferLike,
        byteOffset: intrinsicApply(
          intrinsicTypedArrayByteOffset,
          source,
          [],
        ) as number,
        byteLength: intrinsicApply(
          intrinsicTypedArrayByteLength,
          source,
          [],
        ) as number,
      };
    }
  } catch {
    throw new TypeError(
      "kernel WebAssembly bytes must be an attached, genuine BufferSource",
    );
  }
}

function bufferSourceToArrayBuffer(source: BufferSource): ArrayBuffer {
  const span = intrinsicBufferSourceSpan(source);
  let exactView: Uint8Array;
  try {
    exactView = new IntrinsicUint8Array(
      span.buffer,
      span.byteOffset,
      span.byteLength,
    );
  } catch {
    throw new TypeError(
      "kernel WebAssembly bytes must be an attached, genuine BufferSource",
    );
  }

  const snapshot = new IntrinsicUint8Array(span.byteLength);
  intrinsicApply(intrinsicUint8ArraySet, snapshot, [exactView]);
  return intrinsicApply(
    intrinsicTypedArrayBuffer,
    snapshot,
    [],
  ) as ArrayBuffer;
}

const DEFAULT_KMS_MODE_WIDTH = 1920;
const DEFAULT_KMS_MODE_HEIGHT = 1080;
const DEFAULT_KMS_REFRESH_HZ = 60;

function kmsModeInfoBytes(
  width?: number,
  height?: number,
  refreshHz = DEFAULT_KMS_REFRESH_HZ,
): Uint8Array {
  const w = clampModeDim(width, DEFAULT_KMS_MODE_WIDTH);
  const h = clampModeDim(height, DEFAULT_KMS_MODE_HEIGHT);
  const hsyncStart = clampU16(w + 16);
  const hsyncEnd = clampU16(w + 48);
  const htotal = clampU16(w + 160);
  const vsyncStart = clampU16(h + 3);
  const vsyncEnd = clampU16(h + 8);
  const vtotal = clampU16(h + 45);
  const clock = Math.max(1, Math.min(0xffffffff, Math.round(htotal * vtotal * refreshHz / 1000)));
  const out = new IntrinsicUint8Array(STRUCT_SIZE_WPK_DRM_MODE_MODEINFO);
  const dv = new IntrinsicDataView(typedArrayBuffer(out));
  dataViewSetUint32(dv, 0, clock, true);
  dataViewSetUint16(dv, 4, w, true);
  dataViewSetUint16(dv, 6, hsyncStart, true);
  dataViewSetUint16(dv, 8, hsyncEnd, true);
  dataViewSetUint16(dv, 10, htotal, true);
  dataViewSetUint16(dv, 12, 0, true);
  dataViewSetUint16(dv, 14, h, true);
  dataViewSetUint16(dv, 16, vsyncStart, true);
  dataViewSetUint16(dv, 18, vsyncEnd, true);
  dataViewSetUint16(dv, 20, vtotal, true);
  dataViewSetUint16(dv, 22, 0, true);
  dataViewSetUint32(dv, 24, refreshHz, true);
  dataViewSetUint32(dv, 28, 0, true);
  // DRM_MODE_TYPE_DRIVER | DRM_MODE_TYPE_PREFERRED
  dataViewSetUint32(dv, 32, 0x1 | 0x8, true);
  const name = `${w}x${h}`;
  for (let i = 0; i < Math.min(name.length, 31); i++) {
    out[36 + i] = name.charCodeAt(i) & 0xff;
  }
  return out;
}

function clampModeDim(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value) || value < 1) return fallback;
  return clampU16(Math.trunc(value));
}

function clampU16(value: number): number {
  return Math.max(1, Math.min(0xffff, Math.trunc(value)));
}

/**
 * Map filesystem error codes to negative errno values.
 * Handles both Node.js-style string codes ("ENOENT") and
 * numeric codes from SFSError (2, 17, etc.).
 * Returns -EIO for unknown errors.
 */
const NEG_ERRNO_BY_NAME: Readonly<Record<string, number>> = {
  EPERM: -1,
  ENOENT: -2,
  ESRCH: -3,
  EINTR: -4,
  EIO: -5,
  ENXIO: -6,
  E2BIG: -7,
  ENOEXEC: -8,
  EBADF: -9,
  ECHILD: -10,
  EAGAIN: -11,
  EWOULDBLOCK: -11,
  ENOMEM: -12,
  EACCES: -13,
  EFAULT: -14,
  EBUSY: -16,
  EEXIST: -17,
  EXDEV: -18,
  ENODEV: -19,
  ENOTDIR: -20,
  EISDIR: -21,
  EINVAL: -22,
  ENFILE: -23,
  EMFILE: -24,
  ENOTTY: -25,
  ETXTBSY: -26,
  EFBIG: -27,
  ENOSPC: -28,
  ESPIPE: -29,
  EROFS: -30,
  EMLINK: -31,
  EPIPE: -32,
  ERANGE: -34,
  EDEADLK: -35,
  ENAMETOOLONG: -36,
  ENOSYS: -38,
  ENOTEMPTY: -39,
  ELOOP: -40,
  ENOMSG: -42,
  EIDRM: -43,
  ENODATA: -61,
  EOVERFLOW: -75,
  ENOTSOCK: -88,
  EDESTADDRREQ: -89,
  EMSGSIZE: -90,
  EPROTOTYPE: -91,
  ENOPROTOOPT: -92,
  EPROTONOSUPPORT: -93,
  EOPNOTSUPP: -95,
  ENOTSUP: -95,
  EAFNOSUPPORT: -97,
  EADDRINUSE: -98,
  EADDRNOTAVAIL: -99,
  ENETUNREACH: -101,
  ECONNABORTED: -103,
  ECONNRESET: -104,
  EISCONN: -106,
  ENOTCONN: -107,
  ESHUTDOWN: -108,
  ETIMEDOUT: -110,
  ECONNREFUSED: -111,
  EALREADY: -114,
  EINPROGRESS: -115,
};

export function negErrno(err: unknown): number {
  if (err && typeof err === "object" && "code" in err) {
    const code = (err as { code: string | number }).code;
    // Numeric errno (e.g. SFSError from MemoryFileSystem/SharedFS)
    // SharedFS uses negative codes (-2 for ENOENT, -17 for EEXIST, etc.)
    if (typeof code === "number" && code !== 0) {
      return code < 0 ? code : -code;
    }
    if (typeof code === "string") {
      const mapped = NEG_ERRNO_BY_NAME[code];
      if (mapped !== undefined) return mapped;
    }
  }
  if (err && typeof err === "object" && "errno" in err) {
    const errno = (err as { errno: unknown }).errno;
    if (typeof errno === "number" && Number.isInteger(errno) && errno !== 0) {
      return errno < 0 ? errno : -errno;
    }
  }
  // Check error message for errno names (e.g. plain Error("ENOENT") from DeviceFS)
  if (err instanceof Error) {
    const name = /^([A-Z][A-Z0-9_]*)\b/.exec(err.message)?.[1];
    if (name !== undefined) {
      const mapped = NEG_ERRNO_BY_NAME[name];
      if (mapped !== undefined) return mapped;
    }
  }
  return -5; // EIO
}

/** Size of the WasmStat struct in bytes (repr(C) layout). */
const WASM_STAT_SIZE = STRUCT_SIZE_WASM_STAT;

/** Size of the WasmStatfs struct in bytes (repr(C) layout). */
const WASM_STATFS_SIZE = STRUCT_SIZE_WASM_STATFS;

/** Size of the WasmDirent struct: d_ino(u64) + d_type(u32) + d_namlen(u32). */
const WASM_DIRENT_SIZE = STRUCT_SIZE_WASM_DIRENT;

export interface KernelCallbacks {
  onAlarm?: (seconds: number) => number;
  onPosixTimer?: (timerId: number, signo: number, valueMs: number, intervalMs: number) => number;
  onWaitpid?: (targetPid: number, options: number) => void;
  onNetListen?: (fd: number, port: number, addr: [number, number, number, number]) => number;
  onUdpBind?: (handle: number, addr: [number, number, number, number], port: number) => number;
  onUdpUnbind?: (handle: number) => number;
  onStdout?: (data: Uint8Array) => void;
  onStderr?: (data: Uint8Array) => void;
  /** Read up to maxLen bytes from stdin. Return a Uint8Array with available data, or empty/null for EOF. */
  onStdin?: (maxLen: number) => Uint8Array | null;
  /**
   * Resolve the wasm `Memory` for `pid`. The GL bridge reads cmdbuf bytes
   * directly out of the process's Memory SAB on `host_gl_submit` and
   * `host_gl_query`, so the embedder must thread its per-pid memory map
   * through this callback. Returning `undefined` is interpreted as "the
   * process is gone" and turns the GL call into a silent no-op.
   */
  getProcessMemory?: (pid: number) => WebAssembly.Memory | undefined;
  /**
   * Observe a persistent kernel-realm wrapper of process Memory for weak
   * retirement telemetry. This callback must not retain either argument.
   */
  onProcessMemoryTarget?: (
    memory: WebAssembly.Memory,
    target: object,
  ) => void;
  /**
   * Resolve the KMS scanout canvas for `crtcId`, if one is registered.
   * Used by `host_gl_create_context` to auto-attach the canvas to the
   * DRM-master pid's GL binding so user programs that drive the modeset
   * stack (drmModeSetCrtc + eglCreateContext) don't have to call
   * `gl.attachCanvas` separately. Returning `undefined` keeps the
   * legacy "embedder must call attachCanvas manually" path alive.
   */
  getKmsCanvas?: (crtcId: number) => OffscreenCanvas | HTMLCanvasElement | undefined;
  /**
   * Notify the embedder that GL has claimed the canvas for `crtcId`.
   * The KMS vblank pump uses this to skip the CPU `putImageData` blit
   * for canvases now painted directly by WebGL2. Idempotent.
   */
  markKmsCanvasGlOwned?: (crtcId: number) => void;
}

export class WasmPosixKernel {
  private config: KernelConfig;
  private io: PlatformIO;
  private callbacks: KernelCallbacks;
  #instance: WebAssembly.Instance | null = null;
  #memory: WebAssembly.Memory | null = null;
  #memoryGeneration: object = intrinsicObjectFreeze({});
  readonly #kernelEntryGate = new KernelEntryGate();
  #kernelPtrWidth: 4 | 8 = 4;
  #testEngine: WasmPosixKernelTestHarnessOptions["engine"] | undefined;
  /**
   * One wrapper owns exactly one kernel Wasm generation.
   *
   * WHY: allocator-owned scratch regions retain the instance, Memory, pointer,
   * and capacity that created them. Replacing only `instance`/`memory` would
   * leave those regions authorized against the old generation. Rejecting a
   * second initialization before it mutates any state keeps that lifetime
   * invariant structural instead of relying on every cached region being
   * remembered during a future reinitialization.
   */
  #initializationState:
    | "uninitialized"
    | "initializing"
    | "initialized" = "uninitialized";
  private sharedPipes = new Map<number, { pipe: SharedPipeBuffer; end: "read" | "write" }>();
  private signalWakeSab: SharedArrayBuffer | null = null;
  private programFuncTable: WebAssembly.Table | null = null;
  #kernelFuncTable: WebAssembly.Table | null = null;
  /**
   * Rootfs overlay content byte-leaf provider (Phase 5 Increment 2). The Rust
   * kernel owns the `/` tree and asks the host only for a base file's immutable
   * bytes, addressed by a manifest-assigned blob id. The provider fills `dest`
   * from the leaf at `offset` and returns the count (or a negative errno). Wired
   * by the worker from the boot manifest; until set, `host_blob_read` reports
   * ENOSYS so the seam is truthfully unbacked.
   */
  #rootfsBlobProvider:
    | ((blobId: bigint, offset: bigint, dest: Uint8Array) => number)
    | undefined = undefined;
  /**
   * Rootfs raw-archive byte-store provider (Phase 5 Increment 3b). The Rust
   * kernel owns `LazyMember` decode: it asks the host only for whole-archive
   * bytes at `offset`, addressed by a manifest-assigned `archive_id` (a plain
   * `u32`, unsplit at the Wasm boundary). The kernel decodes the zip central
   * directory and extracts members itself; the host is purely a byte
   * transport. The provider fills `dest` from the archive at `offset` and
   * returns the count (or a negative errno). Wired by the worker from the
   * boot manifest; until set, `host_fetch_archive` reports ENOSYS so the
   * seam is truthfully unbacked.
   */
  #rootfsArchiveProvider:
    | ((archiveId: number, offset: bigint, dest: Uint8Array) => number)
    | undefined = undefined;
  private waitpidSab: SharedArrayBuffer | null = null;
  /**
   * A backend directory iterator may already have advanced before the host
   * bridge discovers that it cannot marshal the returned entry into Wasm
   * memory. Keep that entry here until every output write succeeds so the
   * guest can retry without losing it.
   */
  private pendingDirectoryEntries = new Map<
    number,
    { name: string; type: number; ino: number }
  >();
  /**
   * Extra host-handle ownership held by regular-file MAP_SHARED backings.
   * The Rust kernel emits host_close only after the last guest descriptor is
   * gone; a mapping retain defers that physical close until its backing is
   * also released.
   */
  private retainedHostFileHandles = new Map<
    number,
    { mappingRefs: number; descriptorClosePending: boolean }
  >();
  /** Active synchronous host_fstat capture used by mmap preflight. */
  private fstatHandleCapture: {
    token: object;
    handle: number | null;
  } | null = null;
  /**
   * Live `/dev/fb0` mappings the kernel has reported via
   * `host_bind_framebuffer`. Renderers (canvas in browser, no-op in
   * Node) read this on each frame.
   */
  readonly framebuffers = new FramebufferRegistry();
  /**
   * Live GBM buffer objects on `/dev/dri/renderD128` reported by the
   * kernel via `host_gbm_bo_*`. Pixel storage for the v1 CpuShared
   * tier lives in the process's wasm Memory at the bind range;
   * consumers read pixels by projecting that range onto the process
   * Memory SAB (same model as the mmap-based framebuffer binding).
   */
  readonly bos = new GbmBoRegistry();
  readonly kms = new KmsRegistry(this.bos);
  /**
   * Live `/dev/dri/renderD128` GLES sessions. The kernel reports
   * binds/unbinds via `host_gl_*`; the bridge in `webgl/bridge.ts`
   * decodes the cmdbuf TLV stream against a per-pid `WebGL2RenderingContext`
   * once the embedder has attached a canvas.
   */
  readonly gl = new GlContextRegistry();
  /**
   * Worker-side submit lanes. The compositor (current DRM_MASTER on
   * card0) jumps ahead of clients; clients round-robin. Drain runs
   * synchronously inside `host_gl_submit` because the C process is
   * blocked on that syscall — deferring would race the SAB cmdbuf.
   *
   * Muxers keyed by `WebGL2RenderingContext` so pids sharing a canvas
   * share a muxer; `WeakMap` drops the muxer when the context is GC'd.
   */
  private gl_submit_queue = new SubmitQueue((pid) => this.kms.isMasterPid(pid));
  private gl_muxers = new WeakMap<WebGL2RenderingContext, GlMuxer>();

  /**
   * Merge additional callbacks into the existing set.
   * Existing callbacks not specified in the argument are preserved.
   */
  mergeCallbacks(callbacks: Partial<KernelCallbacks>): void {
    this.callbacks = { ...this.callbacks, ...callbacks };
  }

  /**
   * Release every device-side alias owned by one process generation.
   *
   * Normal guest close/unmap paths remain authoritative for device semantics;
   * this idempotent host backstop covers exec, traps, and forced termination
   * where those guest hooks may never run.
   */
  releaseProcessViews(pid: number): void {
    this.gl_submit_queue.removePid(pid);
    this.gl.unbind(pid);
    this.framebuffers.unbind(pid);
    this.bos.releaseProcess(pid);
    if (this.kms.isMasterPid(pid)) this.kms.dropMaster();
  }

  /**
   * Set the user program's indirect function table so signal handlers
   * registered by the program can be called from the kernel.
   */
  setProgramFuncTable(table: WebAssembly.Table): void {
    this.programFuncTable = table;
  }

  /**
   * Install the rootfs overlay content byte-leaf provider (Phase 5 Increment 2).
   * See {@link WasmPosixKernel.prototype} `#rootfsBlobProvider`.
   */
  setRootfsBlobProvider(
    provider: (blobId: bigint, offset: bigint, dest: Uint8Array) => number,
  ): void {
    this.#rootfsBlobProvider = provider;
  }

  /**
   * Install the rootfs raw-archive byte-store provider (Phase 5 Increment 3b).
   * See {@link WasmPosixKernel.prototype} `#rootfsArchiveProvider`.
   */
  setRootfsArchiveProvider(
    provider: (archiveId: number, offset: bigint, dest: Uint8Array) => number,
  ): void {
    this.#rootfsArchiveProvider = provider;
  }

  constructor(
    config: KernelConfig,
    io: PlatformIO,
    callbacks?: KernelCallbacks,
  ) {
    this.config = config;
    this.io = io;
    this.callbacks = callbacks ?? {};
    if (arguments[3] === wasmPosixKernelTestCapability) {
      const testRuntime = arguments[4] as
        | WasmPosixKernelTestHarnessOptions
        | undefined;
      if (testRuntime === undefined) {
        throw new Error("missing WasmPosixKernel test runtime");
      }
      this.#instance = testRuntime.instance ?? null;
      this.#kernelFuncTable = testRuntime.instance === undefined
        || testRuntime.instance === null
        ? null
        : (
            wasmInstanceExports(testRuntime.instance)
              .__indirect_function_table as WebAssembly.Table | undefined
          ) ?? null;
      this.#memory = testRuntime.memory ?? null;
      this.#kernelPtrWidth = testRuntime.pointerWidth ?? 4;
      this.#testEngine = testRuntime.engine;
      if (
        testRuntime.initialized
          ?? (
            testRuntime.instance !== undefined
            || testRuntime.memory !== undefined
          )
      ) {
        this.#initializationState = "initialized";
      }
    }
    intrinsicApply(
      intrinsicWeakMapSet,
      wasmPosixKernelRuntimeAccess,
      [
        this,
        {
          gate: this.#kernelEntryGate,
          instance: () => this.#instance,
          memory: () => this.#memory,
        },
      ],
    );
    // Let the GBM bo registry reach per-pid wasm Memory so the
    // bind/unbind sync (parent writes → SAB → child reads after PRIME
    // export+import) actually moves bytes. The closure follows
    // `mergeCallbacks` because it reads `this.callbacks` at call time.
    this.bos.setProcessMemoryResolver((pid) =>
      this.callbacks.getProcessMemory?.(pid),
    );
    if (arguments[3] === wasmPosixKernelTestCapability) {
      intrinsicObjectDefineProperty(this, "testAuthority", {
        configurable: false,
        enumerable: false,
        writable: false,
        value: this.#createTestAuthority(),
      });
    }
  }

  /**
   * Expose only the six white-box operations used by focused tests.
   *
   * WHY: a Proxy would retain the kernel object as its mutation target and
   * bind every otherwise-unhandled method to that target. The frozen
   * method-only companion exposes no raw Instance, Memory, gate, scratch
   * region, getter, or arbitrary property dispatch. Its six retained closures
   * are intentional test-generation authority and exist only on an object
   * produced with the module-secret constructor capability.
   */
  #createTestAuthority(): WasmPosixKernelTestAuthority {
    const authority = intrinsicObjectCreate(
      null,
    ) as WasmPosixKernelTestAuthority;
    const defineMethod = (
      name: keyof WasmPosixKernelTestAuthority,
      value: Function,
    ): void => {
      intrinsicObjectDefineProperty(authority, name, {
        configurable: false,
        enumerable: true,
        writable: false,
        value,
      });
    };
    defineMethod(
      "buildImportObject",
      (memory: WebAssembly.Memory) => this.#buildImportObject(memory),
    );
    defineMethod(
      "writeKernelBytes",
      (
        pointer: KernelPointer,
        capacity: number | bigint,
        bytes: Uint8Array,
      ) => this.#writeKernelBytes(
        this.#rustLentKernelDestination(
          pointer,
          capacity,
          "test kernel destination",
        ),
        bytes,
      ),
    );
    defineMethod(
      "hostFstat",
      (handle: bigint, statPointer: KernelPointer) => {
        try {
          return this.#hostFstat(
            handle,
            this.#rustLentKernelDestination(
              statPointer,
              WASM_STAT_SIZE,
              "test host_fstat destination",
            ),
          );
        } catch {
          return -14; // EFAULT
        }
      },
    );
    defineMethod(
      "hostOpendir",
      (pathPointer: KernelPointer, pathLength: number) =>
        this.#hostOpendir(pathPointer, pathLength),
    );
    defineMethod(
      "hostReaddir",
      (
        handle: bigint,
        direntPointer: KernelPointer,
        namePointer: KernelPointer,
        nameLength: number,
      ) => {
        try {
          return this.#hostReaddir(
            handle,
            this.#rustLentKernelDestination(
              direntPointer,
              WASM_DIRENT_SIZE,
              "test host_readdir dirent destination",
            ),
            this.#rustLentKernelDestination(
              namePointer,
              nameLength,
              "test host_readdir name destination",
            ),
          );
        } catch {
          return -14; // EFAULT
        }
      },
    );
    defineMethod(
      "hostClosedir",
      (handle: bigint) => this.#hostClosedir(handle),
    );
    defineMethod(
      "hostClose",
      (handle: bigint) => this.#hostClose(handle),
    );
    return intrinsicObjectFreeze(authority);
  }

  getKernelPtrWidth(): 4 | 8 {
    return this.#kernelPtrWidth;
  }

  toKernelPtr(value: number | bigint): KernelPointer {
    const numberValue = checkedWasmPointer(
      value,
      this.#kernelPtrWidth,
      "kernel export pointer",
    );
    return this.#kernelPtrWidth === 8 ? BigInt(numberValue) : numberValue;
  }

  /**
   * Losslessly convert one kernel `usize` value for a host API that stores an
   * address, offset, or length as a JavaScript number.
   *
   * WHY: `Number(bigint)` silently rounds above MAX_SAFE_INTEGER and bitwise
   * operators silently discard every bit above bit 31. Device metadata is not
   * scratch, but it still must not alias a different process-memory range.
   */
  #checkedKernelIndex(value: KernelPointer, field: string): number {
    return checkedWasmPointer(value, this.#kernelPtrWidth, field);
  }

  #checkedKernelSpan(
    offsetValue: KernelPointer,
    lengthValue: KernelPointer,
    limit: number,
    field: string,
  ): { offset: number; length: number; end: number } {
    const offset = this.#checkedKernelIndex(offsetValue, `${field} offset`);
    const length = this.#checkedKernelIndex(lengthValue, `${field} length`);
    if (!Number.isSafeInteger(limit) || limit < 0) {
      throw new KernelScratchError(`${field} has an invalid capacity`);
    }
    const end = offset + length;
    if (!Number.isSafeInteger(end) || end < offset || end > limit) {
      throw new KernelScratchError(`${field} exceeds its declared capacity`);
    }
    return { offset, length, end };
  }

  /**
   * Begin capturing the concrete host handle used by one synchronous fstat.
   *
   * WHY: the worker must invoke the kernel export directly inside its active
   * scratch lease; accepting an opaque callback here would let a primitive
   * scratch address cross a boundary that cannot revoke it. The token makes
   * the begin/finish pair exact while a `finally` at the caller preserves the
   * synchronous capture lifetime.
   */
  beginFstatHandleCapture(): object {
    if (this.fstatHandleCapture) {
      throw new Error("nested host fstat handle capture");
    }
    const token = {};
    this.fstatHandleCapture = { token, handle: null };
    return token;
  }

  /**
   * Finish the exact synchronous fstat capture started by the matching token.
   */
  finishFstatHandleCapture(token: object): number | null {
    const capture = this.fstatHandleCapture;
    if (!capture || capture.token !== token) {
      throw new Error("mismatched host fstat handle capture");
    }
    this.fstatHandleCapture = null;
    return capture.handle;
  }

  /** Retain one mapping-owned reference to an existing host file handle. */
  retainHostFileHandle(handle: number): void {
    if (!Number.isSafeInteger(handle) || handle < 0) {
      throw new Error(`invalid host file handle ${handle}`);
    }
    const retained = this.retainedHostFileHandles.get(handle);
    if (retained) {
      if (retained.descriptorClosePending) {
        throw new Error(`cannot retain closed host file handle ${handle}`);
      }
      retained.mappingRefs++;
      return;
    }
    this.retainedHostFileHandles.set(handle, {
      mappingRefs: 1,
      descriptorClosePending: false,
    });
  }

  /**
   * Release one mapping-owned reference. If the guest descriptor lifetime
   * ended first, this performs the deferred physical backend close.
   */
  releaseHostFileHandle(handle: number): number {
    const retained = this.retainedHostFileHandles.get(handle);
    if (!retained || retained.mappingRefs <= 0) return -9; // EBADF
    retained.mappingRefs--;
    if (retained.mappingRefs > 0) return 0;
    this.retainedHostFileHandles.delete(handle);
    if (!retained.descriptorClosePending) return 0;
    try {
      return this.io.close(handle);
    } catch (e) {
      return negErrno(e);
    }
  }

  #createKernelMemory(pointerWidth: 4 | 8): WebAssembly.Memory {
    if (pointerWidth === 8) {
      return new IntrinsicWasmMemory({
        initial: 24n,
        maximum: 16384n,
        shared: true,
        address: "i64",
      } as unknown as WebAssembly.MemoryDescriptor);
    }
    return new IntrinsicWasmMemory({
      // 24 pages = 1.5 MiB of initial address space. This must remain above
      // the kernel Wasm's linker-derived minimum and leaves headroom for
      // future static data without re-tuning host construction each time.
      initial: 24,
      maximum: 16384,
      shared: true,
    });
  }

  /**
   * Push one PS/2 mouse packet into the kernel's `/dev/input/mice`
   * queue. Silently dropped if the kernel module hasn't been
   * instantiated yet — a canvas can fire `mousemove` before the program
   * registers the device. `dy` is in PS/2 sense (positive-up); the
   * caller must invert browser deltaY before calling.
   */
  injectMouseEvent(dx: number, dy: number, buttons: number): void {
    this.#kernelEntryGate.runOrDeferVoidIngress(
      "mouse input",
      (scope) => {
        if (!this.#instance) return;
        const scoped = createKernelEntryScopedInstance(
          this.#instance,
          scope,
        );
        const inject = scoped.exports.kernel_inject_mouse_event as
          | ((dx: number, dy: number, buttons: number) => void)
          | undefined;
        if (!inject) return;
        inject(dx, dy, buttons);
      },
    );
  }

  // ---------------------------------------------------------------------------
  // /dev/dsp — host-drained PCM audio
  // ---------------------------------------------------------------------------

  /**
   * Lazily-allocated kernel-memory scratch region for audio drains. We
   * allocate on first use so the kernel module doesn't reserve audio
   * memory in processes that never play sound. ~64 KiB is comfortably
   * larger than any single drain call would ask for.
   */
  #audioScratchRegion: KernelScratchRegion | null = null;
  private static readonly AUDIO_SCRATCH_SIZE = 65536;
  #apiScratchRegion: KernelScratchRegion | null = null;
  private static readonly API_SCRATCH_SIZE = 65536;

  #requireApiScratch(): KernelScratchRegion {
    if (this.#apiScratchRegion) return this.#apiScratchRegion;
    if (!this.#memory) {
      throw new Error("kernel memory is not initialized");
    }
    const allocator = this.#instance?.exports.kernel_alloc_scratch as
      | ((size: number) => KernelPointer)
      | undefined;
    if (!allocator) {
      throw new Error("kernel is missing its scratch allocator");
    }
    this.#apiScratchRegion = allocateKernelScratchRegion(
      this.#memory,
      allocator,
      WasmPosixKernel.API_SCRATCH_SIZE,
      this.#kernelPtrWidth,
      "kernel public API scratch",
      this.#instance!,
    );
    return this.#apiScratchRegion;
  }

  #ensureAudioScratch(): boolean {
    if (this.#audioScratchRegion) return true;
    if (!this.#memory) return false;
    const exports = this.#instance?.exports as Record<string, unknown> | undefined;
    const alloc = exports?.kernel_alloc_scratch as
      | ((size: number) => bigint | number)
      | undefined;
    if (!alloc) return false;
    try {
      this.#audioScratchRegion = allocateKernelScratchRegion(
        this.#memory,
        alloc,
        WasmPosixKernel.AUDIO_SCRATCH_SIZE,
        this.#kernelPtrWidth,
        "kernel audio scratch",
        this.#instance!,
      );
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Drain up to `out.byteLength` bytes of PCM audio buffered in
   * `/dev/dsp` into the host-provided buffer. Returns the number of
   * bytes copied. Reads stop at whole-frame boundaries so the host
   * never receives a torn L/R pair.
   *
   * Returns 0 if the kernel hasn't been instantiated, no scratch
   * buffer can be allocated, or the ring is empty — the caller doesn't
   * have to special-case any of those.
   */
  drainAudio(out: Uint8Array): number {
    const exports = this.#instance?.exports as Record<string, unknown> | undefined;
    if (
      typeof exports?.kernel_drain_audio !== "function"
      || !this.#memory
      || !this.#ensureAudioScratch()
    ) return 0;
    // Cap the request at our scratch size. Typical drain rates
    // (~22 ms of stereo S16 @ 44.1 kHz = ~7.7 KiB per call) are well
    // under the cap; callers needing more invoke drainAudio in a loop.
    const region = this.#audioScratchRegion!;
    const want = Math.min(typedArrayByteLength(out), region.capacity);
    return region.withLease((scratch) => {
      const n = scratch.invokeKernelExport("kernel_drain_audio", [
        scratch.exportPointer(0, want),
        want,
      ]);
      if (!Number.isSafeInteger(n) || n < 0 || n > want) return 0;
      if (n > 0) scratch.copyTo(out, 0, 0, n);
      return n;
    });
  }

  /**
   * Currently-configured `/dev/dsp` sample rate (Hz). 0 if the kernel
   * isn't instantiated yet.
   */
  audioSampleRate(): number {
    const exports = this.#instance?.exports as Record<string, unknown> | undefined;
    const fn = exports?.kernel_audio_sample_rate as (() => number) | undefined;
    return fn ? fn() : 0;
  }

  /**
   * Currently-configured `/dev/dsp` channel count (1 = mono, 2 = stereo).
   * 0 if the kernel isn't instantiated yet.
   */
  audioChannels(): number {
    const exports = this.#instance?.exports as Record<string, unknown> | undefined;
    const fn = exports?.kernel_audio_channels as (() => number) | undefined;
    return fn ? fn() : 0;
  }

  /**
   * Bytes currently buffered in the `/dev/dsp` ring. Lets the host
   * estimate how much audio is queued ahead of the AudioContext clock.
   */
  audioPending(): number {
    const exports = this.#instance?.exports as Record<string, unknown> | undefined;
    const fn = exports?.kernel_audio_pending as (() => number) | undefined;
    return fn ? fn() : 0;
  }

  registerSharedPipe(handle: number, sab: SharedArrayBuffer, end: "read" | "write"): void {
    this.sharedPipes.set(handle, { pipe: SharedPipeBuffer.fromSharedBuffer(sab), end });
  }

  unregisterSharedPipe(handle: number): void {
    this.sharedPipes.delete(handle);
  }

  /** Returns all registered shared pipes (for transferring during exec). */
  getSharedPipes(): Map<number, { pipe: SharedPipeBuffer; end: "read" | "write" }> {
    return this.sharedPipes;
  }

  registerSignalWakeSab(sab: SharedArrayBuffer): void {
    this.signalWakeSab = sab;
  }

  registerWaitpidSab(sab: SharedArrayBuffer): void {
    this.waitpidSab = sab;
  }

  /**
   * Load and instantiate the kernel Wasm module exactly once.
   *
   * @param wasmBytes - The compiled kernel Wasm binary
   */
  async init(wasmBytes: BufferSource): Promise<void> {
    this.#beginInitialization();
    try {
      const { module, pointerWidth } =
        await this.#compileKernelModule(wasmBytes);
      this.#kernelPtrWidth = pointerWidth;
      const memory = this.#createKernelMemory(pointerWidth);
      this.#memoryGeneration = intrinsicObjectFreeze({});
      this.#memory = memory;
      const importObject = this.#buildImportObject(memory);
      const rawInstance =
        this.#testEngine === undefined
          ? await intrinsicApply(
              intrinsicWasmInstantiate,
              WebAssembly,
              [module, importObject],
            ) as WebAssembly.Instance
          : await this.#testEngine.instantiate(module, importObject);
      this.#kernelFuncTable = (
        wasmInstanceExports(rawInstance)
          .__indirect_function_table as WebAssembly.Table | undefined
      ) ?? null;
      this.#instance = createKernelEntryGatedInstance(
        rawInstance,
        this.#kernelEntryGate,
      );
      this.#initializationState = "initialized";
    } catch (error) {
      this.#abortInitialization(error);
    }
  }

  #beginInitialization(): void {
    if (this.#initializationState === "initializing") {
      throw new Error("kernel initialization is already in progress");
    }
    if (this.#initializationState === "initialized") {
      throw new Error(
        "kernel is already initialized; create a new WasmPosixKernel " +
          "for a different kernel generation",
      );
    }
    this.#initializationState = "initializing";
  }

  async #compileKernelModule(
    wasmBytes: BufferSource,
  ): Promise<{ module: WebAssembly.Module; pointerWidth: 4 | 8 }> {
    // WHY: view subclasses can spoof public span getters. Pointer-width
    // parsing and engine compilation must consume one identical immutable
    // snapshot or imports can normalize every pointer for the wrong Wasm ABI.
    const wasmSnapshot = bufferSourceToArrayBuffer(wasmBytes);
    const pointerWidth = detectPtrWidth(wasmSnapshot);
    const module = this.#testEngine === undefined
      ? await intrinsicApply(
          intrinsicWasmCompile,
          WebAssembly,
          [wasmSnapshot],
        ) as WebAssembly.Module
      : await this.#testEngine.compile(wasmSnapshot);
    return { module, pointerWidth };
  }

  #abortInitialization(error: unknown): never {
    // A failed first attempt has created no usable kernel generation. Clear
    // the partially published import state so callers may retry cleanly.
    this.#instance = null;
    this.#kernelFuncTable = null;
    this.#memoryGeneration = intrinsicObjectFreeze({});
    this.#memory = null;
    this.#kernelPtrWidth = 4;
    this.#initializationState = "uninitialized";
    throw error;
  }

  #buildImportObject(memory: WebAssembly.Memory): WebAssembly.Imports {
    return {
      env: {
        memory,
        // Raw byte sink to this host's stderr: no added prefix, no added
        // newline. Any prefix/newline is the Rust caller's responsibility
        // (baked into the `&str` passed to `runtime_core::debug_log`), so
        // Node/browser and native produce byte-for-byte identical output.
        // Reuses the same callback/process/console fallback chain as the
        // fd=2 (stderr) path in `#hostWriteAt`.
        host_debug_log: (ptr: KernelPointer, len: number): void => {
          const data = this.#readKernelBytes(ptr, len);
          if (this.callbacks.onStderr) {
            this.callbacks.onStderr(data);
          } else if (typeof process !== "undefined" && process.stderr) {
            process.stderr.write(data);
          } else {
            console.error(new TextDecoder().decode(data));
          }
        },
        host_open: (pathPtr: KernelPointer, pathLen: number, flags: number, mode: number): bigint => {
          return this.#hostOpen(pathPtr, pathLen, flags, mode);
        },
        host_close: (handle: bigint): number => {
          return this.#hostClose(handle);
        },
        host_read: (handle: bigint, bufPtr: KernelPointer, bufLen: number): number => {
          try {
            return this.#hostRead(
              handle,
              this.#rustLentKernelDestination(
                bufPtr,
                bufLen,
                "host_read destination",
              ),
            );
          } catch {
            return -14; // EFAULT
          }
        },
        host_write: (handle: bigint, bufPtr: KernelPointer, bufLen: number): number => {
          return this.#hostWrite(handle, bufPtr, bufLen);
        },
        host_append: (
          handle: bigint,
          bufPtr: KernelPointer,
          bufLen: number,
          limitLo: number,
          limitHi: number,
        ): number => {
          return this.#hostAppend(
            handle,
            bufPtr,
            bufLen,
            limitLo,
            limitHi,
          );
        },
        host_append_position: (
          handle: bigint,
          written: number,
        ): bigint => {
          return this.#hostAppendPosition(handle, written);
        },
        host_pread: (
          handle: bigint,
          bufPtr: KernelPointer,
          bufLen: number,
          offsetLo: number,
          offsetHi: number,
        ): number => {
          try {
            return this.#hostPread(
              handle,
              this.#rustLentKernelDestination(
                bufPtr,
                bufLen,
                "host_pread destination",
              ),
              offsetLo,
              offsetHi,
            );
          } catch {
            return -14; // EFAULT
          }
        },
        host_blob_read: (
          blobIdLo: number,
          blobIdHi: number,
          bufPtr: KernelPointer,
          bufLen: number,
          offsetLo: number,
          offsetHi: number,
        ): number => {
          try {
            return this.#hostBlobRead(
              u64FromWords(blobIdLo, blobIdHi),
              u64FromWords(offsetLo, offsetHi),
              this.#rustLentKernelDestination(
                bufPtr,
                bufLen,
                "host_blob_read destination",
              ),
            );
          } catch {
            return -14; // EFAULT
          }
        },
        host_fetch_archive: (
          archiveId: number,
          bufPtr: KernelPointer,
          bufLen: number,
          offsetLo: number,
          offsetHi: number,
        ): number => {
          try {
            return this.#hostFetchArchive(
              archiveId,
              u64FromWords(offsetLo, offsetHi),
              this.#rustLentKernelDestination(
                bufPtr,
                bufLen,
                "host_fetch_archive destination",
              ),
            );
          } catch {
            return -14; // EFAULT
          }
        },
        host_pwrite: (
          handle: bigint,
          bufPtr: KernelPointer,
          bufLen: number,
          offsetLo: number,
          offsetHi: number,
        ): number => {
          return this.#hostPwrite(
            handle,
            bufPtr,
            bufLen,
            offsetLo,
            offsetHi,
          );
        },
        host_seek: (handle: bigint, offsetLo: number, offsetHi: number, whence: number): bigint => {
          return this.#hostSeek(handle, offsetLo, offsetHi, whence);
        },
        host_fstat: (handle: bigint, statPtr: KernelPointer): number => {
          try {
            return this.#hostFstat(
              handle,
              this.#rustLentKernelDestination(
                statPtr,
                WASM_STAT_SIZE,
                "host_fstat destination",
              ),
            );
          } catch {
            return -14; // EFAULT
          }
        },
        host_stat: (pathPtr: KernelPointer, pathLen: number, statPtr: KernelPointer): number => {
          try {
            return this.#hostStat(
              pathPtr,
              pathLen,
              this.#rustLentKernelDestination(
                statPtr,
                WASM_STAT_SIZE,
                "host_stat destination",
              ),
            );
          } catch {
            return -14; // EFAULT
          }
        },
        host_lstat: (pathPtr: KernelPointer, pathLen: number, statPtr: KernelPointer): number => {
          try {
            return this.#hostLstat(
              pathPtr,
              pathLen,
              this.#rustLentKernelDestination(
                statPtr,
                WASM_STAT_SIZE,
                "host_lstat destination",
              ),
            );
          } catch {
            return -14; // EFAULT
          }
        },
        host_statfs: (pathPtr: KernelPointer, pathLen: number, statfsPtr: KernelPointer): number => {
          try {
            return this.#hostStatfs(
              pathPtr,
              pathLen,
              this.#rustLentKernelDestination(
                statfsPtr,
                WASM_STATFS_SIZE,
                "host_statfs destination",
              ),
            );
          } catch {
            return -14; // EFAULT
          }
        },
        host_fstatfs: (handle: bigint, statfsPtr: KernelPointer): number => {
          try {
            return this.#hostFstatfs(
              handle,
              this.#rustLentKernelDestination(
                statfsPtr,
                WASM_STATFS_SIZE,
                "host_fstatfs destination",
              ),
            );
          } catch {
            return -14; // EFAULT
          }
        },
        host_pathconf: (pathPtr: KernelPointer, pathLen: number, name: number, valuePtr: KernelPointer): number => {
          try {
            return this.#hostPathconf(
              pathPtr,
              pathLen,
              name,
              this.#rustLentKernelDestination(
                valuePtr,
                8,
                "host_pathconf destination",
              ),
            );
          } catch {
            return -14; // EFAULT
          }
        },
        host_fpathconf: (handle: bigint, name: number, valuePtr: KernelPointer): number => {
          try {
            return this.#hostFpathconf(
              handle,
              name,
              this.#rustLentKernelDestination(
                valuePtr,
                8,
                "host_fpathconf destination",
              ),
            );
          } catch {
            return -14; // EFAULT
          }
        },
        host_mkdir: (pathPtr: KernelPointer, pathLen: number, mode: number): number => {
          return this.#hostMkdir(pathPtr, pathLen, mode);
        },
        host_rmdir: (pathPtr: KernelPointer, pathLen: number): number => {
          return this.#hostRmdir(pathPtr, pathLen);
        },
        host_unlink: (pathPtr: KernelPointer, pathLen: number): number => {
          return this.#hostUnlink(pathPtr, pathLen);
        },
        host_rename: (oldPtr: KernelPointer, oldLen: number, newPtr: KernelPointer, newLen: number): number => {
          return this.#hostRename(oldPtr, oldLen, newPtr, newLen);
        },
        host_link: (oldPtr: KernelPointer, oldLen: number, newPtr: KernelPointer, newLen: number): number => {
          return this.#hostLink(oldPtr, oldLen, newPtr, newLen);
        },
        host_symlink: (targetPtr: KernelPointer, targetLen: number, linkPtr: KernelPointer, linkLen: number): number => {
          return this.#hostSymlink(targetPtr, targetLen, linkPtr, linkLen);
        },
        host_readlink: (pathPtr: KernelPointer, pathLen: number, bufPtr: KernelPointer, bufLen: number): number => {
          try {
            return this.#hostReadlink(
              pathPtr,
              pathLen,
              this.#rustLentKernelDestination(
                bufPtr,
                bufLen,
                "host_readlink destination",
              ),
            );
          } catch {
            return -14; // EFAULT
          }
        },
        host_chmod: (pathPtr: KernelPointer, pathLen: number, mode: number): number => {
          return this.#hostChmod(pathPtr, pathLen, mode);
        },
        host_chown: (pathPtr: KernelPointer, pathLen: number, uid: number, gid: number): number => {
          return this.#hostChown(pathPtr, pathLen, uid, gid);
        },
        host_lchown: (pathPtr: KernelPointer, pathLen: number, uid: number, gid: number): number => {
          return this.#hostLchown(pathPtr, pathLen, uid, gid);
        },
        host_access: (pathPtr: KernelPointer, pathLen: number, amode: number): number => {
          return this.#hostAccess(pathPtr, pathLen, amode);
        },
        host_opendir: (pathPtr: KernelPointer, pathLen: number): bigint => {
          return this.#hostOpendir(pathPtr, pathLen);
        },
        host_readdir: (dirHandle: bigint, direntPtr: KernelPointer, namePtr: KernelPointer, nameLen: number): number => {
          try {
            return this.#hostReaddir(
              dirHandle,
              this.#rustLentKernelDestination(
                direntPtr,
                WASM_DIRENT_SIZE,
                "host_readdir dirent destination",
              ),
              this.#rustLentKernelDestination(
                namePtr,
                nameLen,
                "host_readdir name destination",
              ),
            );
          } catch {
            return -14; // EFAULT
          }
        },
        host_closedir: (dirHandle: bigint): number => {
          return this.#hostClosedir(dirHandle);
        },
        host_clock_gettime: (clockId: number, secPtr: KernelPointer, nsecPtr: KernelPointer): number => {
          try {
            return this.#hostClockGettime(
              clockId,
              this.#rustLentKernelDestination(
                secPtr,
                8,
                "host_clock_gettime seconds destination",
              ),
              this.#rustLentKernelDestination(
                nsecPtr,
                8,
                "host_clock_gettime nanoseconds destination",
              ),
            );
          } catch {
            return -14; // EFAULT
          }
        },
        host_nanosleep: (sec: bigint, nsec: bigint): number => {
          return this.#hostNanosleep(sec, nsec);
        },
        host_ftruncate: (handle: bigint, length: bigint): number => {
          return this.#hostFtruncate(handle, length);
        },
        host_fsync: (handle: bigint): number => {
          return this.#hostFsync(handle);
        },
        host_fchmod: (handle: bigint, mode: number): number => {
          return this.#hostFchmod(handle, mode);
        },
        host_fchown: (handle: bigint, uid: number, gid: number): number => {
          return this.#hostFchown(handle, uid, gid);
        },
        host_set_alarm: (seconds: number): number => {
          return this.#hostSetAlarm(seconds);
        },
        host_set_posix_timer: (timerId: number, signo: number, valueMsLo: number, valueMsHi: number, intervalMsLo: number, intervalMsHi: number): number => {
          const valueMs = (valueMsHi >>> 0) * 0x100000000 + (valueMsLo >>> 0);
          const intervalMs = (intervalMsHi >>> 0) * 0x100000000 + (intervalMsLo >>> 0);
          return this.#hostSetPosixTimer(timerId, signo, valueMs, intervalMs);
        },
        host_sigsuspend_wait: (): number => {
          return this.#hostSigsuspendWait();
        },
        host_call_signal_handler: (handler_index: number, signum: number, sa_flags: number): number => {
          const SA_SIGINFO = 4;
          const table = this.programFuncTable
            ?? this.#kernelFuncTable;
          if (!table) {
            return -22; // EINVAL
          }
          const handler = intrinsicApply(
            intrinsicWasmTableGet,
            table,
            [handler_index],
          );
          if (handler) {
            try {
              if (sa_flags & SA_SIGINFO) {
                // SA_SIGINFO: call handler(signum, siginfo_ptr, ucontext_ptr)
                // siginfo_ptr=0 and ucontext_ptr=0 for now (no siginfo written to memory yet)
                (handler as Function)(signum, 0, 0);
              } else {
                (handler as Function)(signum);
              }
              return 0;
            } catch (e) {
              return -5; // EIO
            }
          }
          return -22; // EINVAL
        },
        host_getrandom: (bufPtr: KernelPointer, bufLen: number): number => {
          try {
            const destination = this.#rustLentKernelDestination(
              bufPtr,
              bufLen,
              "host_getrandom destination",
            );
            const random = new IntrinsicUint8Array(destination.capacity);
            if (typeof globalThis.crypto !== "undefined" && globalThis.crypto.getRandomValues) {
              // crypto.getRandomValues rejects SharedArrayBuffer-backed views
              // in browsers. The owned temporary also ensures no host callback
              // retains a live view of kernel memory.
              globalThis.crypto.getRandomValues(random);
            } else {
              for (let i = 0; i < destination.capacity; i++) {
                random[i] = (Math.random() * 256) | 0;
              }
            }
            this.#writeKernelBytes(destination, random);
            return destination.capacity;
          } catch (error) {
            return negErrno(error);
          }
        },
        host_utimensat: (
          pathPtr: KernelPointer, pathLen: number,
          atimeSec: bigint, atimeNsec: bigint, mtimeSec: bigint, mtimeNsec: bigint,
        ): number => {
          return this.#hostUtimensat(pathPtr, pathLen, atimeSec, atimeNsec, mtimeSec, mtimeNsec);
        },
        host_waitpid: (pid: number, options: number, statusPtr: KernelPointer): number => {
          const hasStatus = typeof statusPtr === "bigint"
            ? statusPtr !== 0n
            : statusPtr !== 0;
          try {
            return this.#hostWaitpid(
              pid,
              options,
              hasStatus
                ? this.#rustLentKernelDestination(
                    statusPtr,
                    4,
                    "host_waitpid status destination",
                  )
                : null,
            );
          } catch {
            return -14; // EFAULT
          }
        },
        host_net_connect: (handle: number, addrPtr: KernelPointer, addrLen: number, port: number): number => {
          return this.#hostNetConnect(handle, addrPtr, addrLen, port);
        },
        host_net_send: (handle: number, bufPtr: KernelPointer, bufLen: number, flags: number): number => {
          return this.#hostNetSend(handle, bufPtr, bufLen, flags);
        },
        host_net_recv: (handle: number, bufPtr: KernelPointer, bufLen: number, flags: number): number => {
          if (!this.io.network) return -107; // -ENOTCONN
          try {
            return this.#hostNetRecv(
              handle,
              this.#rustLentKernelDestination(
                bufPtr,
                bufLen,
                "host_net_recv destination",
              ),
              flags,
            );
          } catch {
            return -14; // EFAULT
          }
        },
        host_net_poll: (handle: number, events: number): number => {
          return this.#hostNetPoll(handle, events);
        },
        host_net_connect_status: (handle: number): number => {
          return this.#hostNetConnectStatus(handle);
        },
        host_net_close: (handle: number): number => {
          return this.#hostNetClose(handle);
        },
        host_net_listen: (fd: number, port: number, addrA: number, addrB: number, addrC: number, addrD: number): number => {
          return this.#hostNetListen(fd, port, addrA, addrB, addrC, addrD);
        },
        host_udp_bind: (handle: number, addrA: number, addrB: number, addrC: number, addrD: number, port: number): number => {
          return this.#hostUdpBind(handle, addrA, addrB, addrC, addrD, port);
        },
        host_udp_unbind: (handle: number): number => {
          return this.#hostUdpUnbind(handle);
        },
        host_udp_send: (
          srcA: number, srcB: number, srcC: number, srcD: number, srcPort: number,
          dstA: number, dstB: number, dstC: number, dstD: number, dstPort: number,
          dataPtr: KernelPointer, dataLen: number,
        ): number => {
          return this.#hostUdpSend(
            srcA, srcB, srcC, srcD, srcPort,
            dstA, dstB, dstC, dstD, dstPort,
            dataPtr, dataLen,
          );
        },
        host_getaddrinfo: (namePtr: KernelPointer, nameLen: number, resultPtr: KernelPointer, resultLen: number): number => {
          if (!this.io.network) return -2; // -ENOENT
          try {
            return this.#hostGetaddrinfo(
              namePtr,
              nameLen,
              this.#rustLentKernelDestination(
                resultPtr,
                resultLen,
                "host_getaddrinfo destination",
              ),
            );
          } catch {
            return -14; // EFAULT
          }
        },
        host_futex_wait: (addr: KernelPointer, expected: number, timeoutLo: number, timeoutHi: number): number => {
          return this.#hostFutexWait(addr, expected, timeoutLo, timeoutHi);
        },
        host_futex_wake: (addr: KernelPointer, count: number): number => {
          return this.#hostFutexWake(addr, count);
        },
        // /dev/fb0 hooks: the kernel notifies the host when a process
        // maps or unmaps the framebuffer. The registry is purely
        // metadata; whether anything renders is the consuming app's
        // choice (canvas in browser, no-op in Node tests).
        host_bind_framebuffer: (
          pid: number, addr: KernelPointer, len: KernelPointer,
          w: number, h: number, stride: number, fmt: number,
        ): void => {
          const binding = this.#checkedKernelSpan(
            addr,
            len,
            Number.MAX_SAFE_INTEGER,
            "host_bind_framebuffer process range",
          );
          this.framebuffers.bind({
            pid,
            addr: binding.offset,
            len: binding.length,
            w,
            h,
            stride,
            // Only BGRA32 is defined today (fmt=0). If we ever add
            // formats we'll branch on the tag here.
            fmt: fmt === 0 ? "BGRA32" : "BGRA32",
          });
        },
        host_unbind_framebuffer: (pid: number): void => {
          this.framebuffers.unbind(pid);
        },
        host_fb_write: (
          pid: number,
          offset: KernelPointer,
          srcPtr: KernelPointer,
          len: KernelPointer,
        ): void => {
          this.framebuffers.fbWrite(
            pid,
            this.#checkedKernelIndex(offset, "host_fb_write offset"),
            this.#readKernelBytes(srcPtr, len),
          );
        },
        // /dev/dri/renderD128 hooks. v1 CpuShared tier: pixel storage
        // for a bo lives in the owning process's wasm Memory at the
        // bind range. The registry is pure metadata.
        host_gbm_bo_create: (
          pid: number,
          bo_id: number,
          size: bigint,
          w: number,
          h: number,
          stride: number,
        ): number => {
          let checkedSize: number;
          try {
            checkedSize = this.#checkedKernelIndex(
              size,
              "host_gbm_bo_create size",
            );
          } catch {
            return -75; // EOVERFLOW
          }
          try {
            this.bos.create({ pid, bo_id, size: checkedSize, w, h, stride });
            return 0;
          } catch {
            return -12; // ENOMEM
          }
        },
        host_gbm_bo_destroy: (pid: number, bo_id: number): void => {
          this.bos.destroy(pid, bo_id);
        },
        host_gbm_bo_bind: (
          pid: number,
          bo_id: number,
          addr: KernelPointer,
          len: KernelPointer,
        ): number => {
          try {
            // The worker grows and primes process memory after this callback,
            // so current process-memory bounds are not yet meaningful. The
            // Rust BO owns this mapping contract; the registry caps later
            // copies to the BO's size and rechecks current memory bounds.
            const binding = this.#checkedKernelSpan(
              addr,
              len,
              Number.MAX_SAFE_INTEGER,
              "host_gbm_bo_bind BO range",
            );
            return this.bos.bind(
              pid,
              bo_id,
              binding.offset,
              binding.length,
            );
          } catch {
            return -75; // EOVERFLOW
          }
        },
        host_gbm_bo_unbind: (
          pid: number,
          bo_id: number,
          _addr: KernelPointer,
          _len: KernelPointer,
        ): void => {
          this.bos.unbind(pid, bo_id);
        },
        // /dev/dri/renderD128 GL hooks. The cmdbuf lives in the process's
        // wasm Memory SAB; submit/query reach into it via the embedder-
        // supplied `getProcessMemory` callback. Without an attached
        // canvas the create-context call leaves `b.gl = null` and
        // submit/query become silent no-ops, so kernels that haven't
        // wired a renderer (Node tests, headless smoke runs) stay safe.
        host_gl_bind: (pid: number, addr: KernelPointer, len: KernelPointer): void => {
          const binding = this.#checkedKernelSpan(
            addr,
            len,
            Number.MAX_SAFE_INTEGER,
            "host_gl_bind process range",
          );
          this.gl.bind({
            pid,
            cmdbufAddr: binding.offset,
            cmdbufLen: binding.length,
          });
        },
        host_gl_unbind: (pid: number): void => {
          this.gl.unbind(pid);
        },
        host_gl_create_context: (
          pid: number, ctxId: number,
          _attrsPtr: KernelPointer, _attrsLen: KernelPointer,
        ): void => {
          const b = this.gl.get(pid);
          if (!b) return;
          b.contextId = ctxId;
          if (b.forward) {
            b.forward.onCreateContext();
            return;
          }
          if (!b.canvas) {
            // Auto-attach the KMS scanout canvas if this pid holds DRM
            // master on a CRTC the embedder has registered with
            // `kmsAttachCanvas`. Without this, a libdrm/libgbm/EGL
            // program (e.g. modeset.c) that drove drmModeSetCrtc and
            // is about to call eglCreateContext would silently no-op
            // every shader compile/link/draw because `b.canvas` stays
            // null and `b.gl` is never built.
            const crtc = this.kms.masterCrtcForPid(pid);
            if (crtc != null) {
              const canvas = this.callbacks.getKmsCanvas?.(crtc);
              if (canvas) {
                // Resize the OffscreenCanvas's drawing buffer to match
                // the kernel-side FB before WebGL2 binds, so glViewport
                // and gl_FragCoord operate on the full surface rather
                // than the default 300×150 corner. Modeset programs set
                // their viewport from CANVAS_W/H (the FB they registered
                // via drmModeAddFB2) and would otherwise render into a
                // tiny clipped region of a default-sized canvas.
                const fb = this.kms.currentFb(crtc);
                if (fb && (canvas.width !== fb.width || canvas.height !== fb.height)) {
                  canvas.width = fb.width;
                  canvas.height = fb.height;
                }
                this.gl.attachCanvas(pid, canvas);
                b.canvas = canvas;
                this.callbacks.markKmsCanvasGlOwned?.(crtc);
              }
            }
            if (!b.canvas) return;
          }
          const ctx = b.canvas.getContext("webgl2", {
            antialias: false,
            premultipliedAlpha: false,
            preserveDrawingBuffer: true,
          }) as WebGL2RenderingContext | null;
          if (ctx) {
            // Mirror main-forward.ts: enable the WebGL2 float extensions
            // so RGBA16F framebuffers are renderable and float textures
            // accept LINEAR filtering. Without these, ping-pong sims
            // (Pavel-style fluid, GPU-side image processing) hit
            // GL_FRAMEBUFFER_INCOMPLETE_ATTACHMENT silently.
            ctx.getExtension("EXT_color_buffer_float");
            ctx.getExtension("OES_texture_float_linear");
            ctx.getExtension("EXT_float_blend");
          }
          b.gl = ctx;
        },
        host_gl_destroy_context: (pid: number, _ctxId: number): void => {
          const b = this.gl.get(pid);
          if (!b) return;
          b.gl = null;
          b.contextId = null;
          b.currentProgram = null;
          if (b.forward) b.forward.onDestroyContext();
        },
        host_gl_create_surface: (
          pid: number, surfaceId: number,
          _attrsPtr: KernelPointer, _attrsLen: KernelPointer,
        ): void => {
          const b = this.gl.get(pid);
          if (b) b.surfaceId = surfaceId;
        },
        host_gl_destroy_surface: (pid: number, _surfaceId: number): void => {
          const b = this.gl.get(pid);
          if (b) b.surfaceId = null;
        },
        host_gl_make_current: (
          _pid: number, _ctxId: number, _surfaceId: number,
        ): void => {
          // No-op: WebGL2 binds context per `getContext()`; we already
          // track ctx + surface ids on the binding.
        },
        host_gl_submit: (
          pid: number, offset: KernelPointer, length: KernelPointer,
        ): number => {
          const b = this.gl.get(pid);
          if (!b) return -5; // EIO: kernel/host GL state diverged.
          if (!b.forward && !b.gl) return 0;
          let submission: { offset: number; length: number; end: number };
          try {
            submission = this.#checkedKernelSpan(
              offset,
              length,
              b.cmdbufLen,
              "host_gl_submit command range",
            );
          } catch {
            return -22; // EINVAL
          }
          if (!b.cmdbufView) {
            const memory = this.callbacks.getProcessMemory?.(pid);
            if (!memory) return -5; // EIO
            try {
              b.cmdbufView = new IntrinsicUint8Array(
                wasmMemoryBuffer(memory),
                b.cmdbufAddr,
                b.cmdbufLen,
              );
              this.callbacks.onProcessMemoryTarget?.(
                memory,
                memory.buffer,
              );
              this.callbacks.onProcessMemoryTarget?.(
                memory,
                b.cmdbufView,
              );
              this.callbacks.onProcessMemoryTarget?.(memory, b);
            } catch {
              return -5; // EIO
            }
          }
          if (b.forward) {
            const rc = validateCommandBuffer(
              b.cmdbufView,
              submission.offset,
              submission.length,
            );
            if (rc < 0) return rc;
            b.forward.onSubmit(
              sliceUint8Array(
                b.cmdbufView,
                submission.offset,
                submission.end,
              ),
            );
            return 0;
          }
          this.gl_submit_queue.enqueue(b, {
            memorySab: typedArrayBuffer(b.cmdbufView),
            off: submission.offset,
            len: submission.length,
          });
          return drainSubmitQueue(
            this.gl_submit_queue,
            (bb) => {
              if (!bb.gl) return null;
              let mux = this.gl_muxers.get(bb.gl);
              if (!mux) {
                mux = new GlMuxer(bb.gl);
                this.gl_muxers.set(bb.gl, mux);
              }
              return mux;
            },
            (bb, off, len) => decodeAndDispatch(bb, off, len),
          );
        },
        host_gl_present: (_pid: number): void => {
          // RAF-driven canvas presentation handles itself in v1. Hook
          // is here for explicit-swap / pbuffer paths in v2.
        },
        host_gl_query: (
          pid: number, op: number,
          inPtr: KernelPointer, inLen: KernelPointer,
          outPtr: KernelPointer, outLen: KernelPointer,
        ): number => {
          const b = this.gl.get(pid);
          if (!b || !b.gl) return -1;
          let inputLength: number;
          let outputLength: number;
          let outputDestination: RustLentKernelDestination | null = null;
          try {
            inputLength = this.#checkedKernelIndex(
              inLen,
              "host_gl_query input length",
            );
            outputLength = this.#checkedKernelIndex(
              outLen,
              "host_gl_query output length",
            );
            if (outputLength > 0) {
              // Preflight before touching WebGL state. A bad Rust destination
              // must not execute a query and only then discover EFAULT.
              outputDestination = this.#rustLentKernelDestination(
                outPtr,
                outLen,
                "host_gl_query destination",
              );
            }
          } catch {
            return -14; // EFAULT
          }
          let inBuf: Uint8Array;
          try {
            inBuf = inputLength > 0
              ? this.#readKernelBytes(inPtr, inputLength)
              : new IntrinsicUint8Array(0);
          } catch {
            return -14; // EFAULT
          }
          const outBuf = new IntrinsicUint8Array(outputLength);
          const written = runGlQuery(b, op, inBuf, outBuf);
          if (!Number.isSafeInteger(written)) return -5;
          if (written < 0) return written;
          if (written > outputLength) return -5;
          if (written > 0) {
            if (outputDestination === null) return -5;
            this.#writeKernelBytes(
              outputDestination,
              subarrayUint8Array(outBuf, 0, written),
            );
          }
          return written;
        },
        host_kms_set_master: (pid: number): void => { this.kms.setMasterPid(pid); },
        host_kms_drop_master: (_pid: number): void => { this.kms.dropMaster(); },
        host_proc_write_bytes: (
          pid: number,
          addr: number,
          src_ptr: KernelPointer,
          len: number,
        ): number => {
          const procMem = this.callbacks.getProcessMemory?.(pid);
          if (!procMem) return -14;
          try {
            checkedWasmImportMemoryRange(
              procMem,
              addr,
              len,
              4,
              "host_proc_write_bytes process destination",
            );
            const src = this.#readKernelBytes(src_ptr, len);
            // Reacquire the process buffer after copying the kernel source:
            // another process worker may have grown it in the meantime.
            const destination = checkedWasmImportMemoryRange(
              procMem,
              addr,
              len,
              4,
              "host_proc_write_bytes process destination",
            );
            intrinsicApply(
              intrinsicUint8ArraySet,
              new IntrinsicUint8Array(wasmMemoryBuffer(procMem)),
              [src, destination.pointer],
            );
            return 0;
          } catch {
            return -14;
          }
        },
        host_proc_read_bytes: (
          pid: number,
          addr: number,
          dst_ptr: KernelPointer,
          len: number,
        ): number => {
          try {
            // Prove the Rust-owned destination before reading caller bytes so
            // an invalid kernel range cannot consume a source operation.
            const destination = this.#rustLentKernelDestination(
              dst_ptr,
              len,
              "host_proc_read_bytes destination",
            );
            const procMem = this.callbacks.getProcessMemory?.(pid);
            if (!procMem) return -14;
            const source = checkedWasmImportMemoryRange(
              procMem,
              addr,
              len,
              4,
              "host_proc_read_bytes process source",
            );
            const processView = new IntrinsicUint8Array(
              wasmMemoryBuffer(procMem),
              source.pointer,
              source.length,
            );
            const copy = sliceUint8Array(processView);
            this.#writeKernelBytes(destination, copy);
            return 0;
          } catch {
            return -14;
          }
        },
        host_kms_mode_info: (
          connector_id: number,
          out_ptr: KernelPointer,
        ): void => {
          const destination = this.#rustLentKernelDestination(
            out_ptr,
            STRUCT_SIZE_WPK_DRM_MODE_MODEINFO,
            "host_kms_mode_info destination",
          );
          const canvas = this.callbacks.getKmsCanvas?.(connector_id);
          const bytes = kmsModeInfoBytes(canvas?.width, canvas?.height);
          this.#writeKernelBytes(destination, bytes);
        },
        host_kms_addfb: (
          _pid: number,
          fb_id: number,
          bo_id: number,
          width: number,
          height: number,
          pixel_format: number,
          pitch: number,
        ): number => {
          this.kms.addFb({ fb_id, bo_id, width, height, pixel_format, pitch });
          return 0;
        },
        host_kms_rmfb: (_pid: number, fb_id: number): void => { this.kms.rmFb(fb_id); },
        host_kms_set_fb: (_pid: number, crtc_id: number, fb_id: number): void => {
          this.kms.setFb(crtc_id, fb_id);
        },
      },
    };
  }

  /** Current kernel-memory size without exposing its mutable backing buffer. */
  getMemoryPageCount(): number | null {
    return this.#memory === null
      ? null
      : bufferByteLength(wasmMemoryBuffer(this.#memory)) / 65536;
  }

  // ---- Host import implementations ----

  #getMemoryBuffer(): Uint8Array {
    if (!this.#memory) {
      throw new Error("Kernel not initialized");
    }
    return new IntrinsicUint8Array(wasmMemoryBuffer(this.#memory));
  }

  /** Copy `len` bytes from kernel memory at `ptr` into a non-shared
   *  Uint8Array. Used by host imports that consume kernel-scratch
   *  payloads (e.g. host_fb_write).
   */
  #readKernelBytes(
    ptr: KernelPointer,
    len: number | bigint,
  ): Uint8Array {
    if (!this.#memory) throw new Error("Kernel not initialized");
    const range = checkedWasmImportMemoryRange(
      this.#memory,
      ptr,
      len,
      this.#kernelPtrWidth,
      "kernel import source",
    );
    return sliceUint8Array(
      this.#getMemoryBuffer(),
      range.pointer,
      range.end,
    );
  }

  /**
   * Bind one Rust-lent pointer/capacity pair to this exact Memory generation.
   *
   * WHY: fitting in the current WebAssembly Memory proves only addressability,
   * not ownership. The Rust import arguments name the allocation and its
   * capacity; keeping both in an authenticated token prevents a later caller
   * from substituting total Memory length for the allocation bound.
   */
  #rustLentKernelDestination(
    ptr: KernelPointer,
    capacity: number | bigint,
    label: string,
  ): RustLentKernelDestination {
    if (!this.#memory) throw new Error("Kernel not initialized");
    const range = checkedWasmImportMemoryRange(
      this.#memory,
      ptr,
      capacity,
      this.#kernelPtrWidth,
      label,
    );
    const destination = intrinsicObjectFreeze({
      capacity: range.length,
    }) as RustLentKernelDestination;
    intrinsicApply(
      intrinsicWeakMapSet,
      rustLentKernelDestinationRecords,
      [
        destination,
        {
          owner: this,
          generation: this.#memoryGeneration,
          memory: this.#memory,
          pointer: range.pointer,
          capacity: range.length,
          label,
          consumed: false,
        },
      ],
    );
    return destination;
  }

  /**
   * Publish bytes once through an authenticated Rust-lent destination.
   *
   * No live view survives this synchronous method. The current Memory range is
   * checked again because `memory.grow()` may replace its backing buffer after
   * an asynchronous backend operation staged the bytes.
   */
  #writeKernelBytes(
    destination: RustLentKernelDestination,
    bytes: Uint8Array,
  ): void {
    const record = intrinsicApply(
      intrinsicWeakMapGet,
      rustLentKernelDestinationRecords,
      [destination],
    ) as RustLentKernelDestinationRecord | undefined;
    if (
      record === undefined
      || record.owner !== this
      || record.generation !== this.#memoryGeneration
      || record.memory !== this.#memory
      || record.consumed
    ) {
      throw new Error("invalid or stale Rust-lent kernel destination");
    }
    if (!this.#memory) throw new Error("Kernel not initialized");
    const range = checkedMemoryRange(
      this.#memory,
      record.pointer,
      record.capacity,
      this.#kernelPtrWidth,
      record.label,
    );
    const exactBytes = intrinsicUint8ArrayView(
      bytes,
      `${record.label} output`,
    );
    const exactLength = typedArrayByteLength(exactBytes);
    if (exactLength > range.length) {
      throw new Error(
        `${record.label} output ${exactLength} exceeds capacity ${range.length}`,
      );
    }
    // WHY: one destination represents one Rust borrow. Consuming before the
    // intrinsic copy prevents nested/retried host code from partially replacing
    // bytes that a completed import may already expose to the kernel.
    record.consumed = true;
    intrinsicApply(
      intrinsicUint8ArraySet,
      this.#getMemoryBuffer(),
      [exactBytes, range.pointer],
    );
  }

  /**
   * host_open(path_ptr, path_len, flags, mode) -> i64
   *
   * Reads the path from Wasm memory and delegates to PlatformIO.
   * For the initial synchronous implementation, we cannot truly await
   * the async PlatformIO.open — so we use a synchronous fallback that
   * blocks on the promise. In practice, NodePlatformIO uses sync fs
   * operations internally, so the promise resolves immediately.
   */
  #hostOpen(
    pathPtr: KernelPointer,
    pathLen: number,
    flags: number,
    mode: number,
  ): bigint {
    try {
      const pathBytes = this.#readKernelBytes(pathPtr, pathLen);
      const path = new TextDecoder().decode(pathBytes);
      return BigInt(this.io.open(path, flags, mode));
    } catch (e) {
      return BigInt(negErrno(e));
    }
  }

  /**
   * host_close(handle: i64) -> i32
   */
  #hostClose(handle: bigint): number {
    const h = intrinsicNumber(handle);

    // Check shared pipe registry
    const entry = this.sharedPipes.get(h);
    if (entry) {
      if (entry.end === "read") {
        entry.pipe.closeRead();
      } else {
        entry.pipe.closeWrite();
      }
      this.sharedPipes.delete(h);
      return 0;
    }

    // Handles 0, 1, 2 are pre-opened stdio (stdin, stdout, stderr).
    // These map to the host process's real fds and must NOT be closed
    // by the guest — doing so would close the host's own stdio streams
    // and can cause hangs (e.g., Node.js blocking on fs.closeSync(2)
    // when called from within a Wasm host import callback with shared memory).
    if (h >= 0 && h <= 2) {
      return 0;
    }

    const retained = this.retainedHostFileHandles.get(h);
    if (retained) {
      retained.descriptorClosePending = true;
      return 0;
    }

    try {
      return this.io.close(h);
    } catch (e) {
      return negErrno(e);
    }
  }

  /**
   * host_read(handle: i64, buf_ptr, buf_len) -> i32
   *
   * For handle 0 (stdin): return 0 (no stdin support yet).
   * Other handles: delegate to PlatformIO.
   */
  #hostRead(
    handle: bigint,
    destination: RustLentKernelDestination,
  ): number {
    return this.#hostReadAt(handle, destination, null);
  }

  #hostPread(
    handle: bigint,
    destination: RustLentKernelDestination,
    offsetLo: number,
    offsetHi: number,
  ): number {
    return this.#hostReadAt(
      handle,
      destination,
      signedI64FromWords(offsetLo, offsetHi),
    );
  }

  /**
   * host_blob_read(blob_id, buf_ptr, buf_len, offset) -> i32
   *
   * Serve a rootfs base file's immutable bytes from the installed blob provider.
   * Bytes are staged outside kernel memory and published once (never lend a live
   * view of Rust-owned memory to the provider), mirroring `#hostReadAt`. Reports
   * ENOSYS when no provider is installed (the seam is truthfully unbacked until
   * the boot manifest wires it).
   */
  #hostBlobRead(
    blobId: bigint,
    offset: bigint,
    destination: RustLentKernelDestination,
  ): number {
    const provider = this.#rootfsBlobProvider;
    if (provider === undefined) {
      return -38; // ENOSYS
    }
    const destinationCapacity = destination.capacity;
    let staged: Uint8Array;
    try {
      staged = new IntrinsicUint8Array(destinationCapacity);
    } catch {
      return -12; // ENOMEM
    }
    let result: number;
    try {
      result = provider(blobId, offset, staged);
    } catch {
      return -5; // EIO: the provider violated its byte-source contract.
    }
    if (!Number.isSafeInteger(result) || result > destinationCapacity) {
      return -5; // EIO
    }
    if (result < 0) {
      return result; // provider-reported negative errno
    }
    if (result > 0) {
      try {
        this.#writeKernelBytes(
          destination,
          subarrayUint8Array(staged, 0, result),
        );
      } catch {
        return -14; // EFAULT
      }
    }
    return result;
  }

  /**
   * host_fetch_archive(archive_id, buf_ptr, buf_len, offset) -> i32
   *
   * Serve raw whole-archive bytes from the installed archive provider. The
   * host is a byte transport only: the Rust kernel decodes the zip central
   * directory and extracts `LazyMember` bytes itself. `archiveId` is a plain
   * `u32` (unsplit at the Wasm boundary, unlike `blobId`'s lo/hi split).
   * Bytes are staged outside kernel memory and published once (never lend a
   * live view of Rust-owned memory to the provider), mirroring
   * `#hostBlobRead`. Reports ENOSYS when no provider is installed (the seam
   * is truthfully unbacked until the boot manifest wires it).
   */
  #hostFetchArchive(
    archiveId: number,
    offset: bigint,
    destination: RustLentKernelDestination,
  ): number {
    const provider = this.#rootfsArchiveProvider;
    if (provider === undefined) {
      return -38; // ENOSYS
    }
    const destinationCapacity = destination.capacity;
    let staged: Uint8Array;
    try {
      staged = new IntrinsicUint8Array(destinationCapacity);
    } catch {
      return -12; // ENOMEM
    }
    let result: number;
    try {
      result = provider(archiveId, offset, staged);
    } catch {
      return -5; // EIO: the provider violated its byte-source contract.
    }
    if (!Number.isSafeInteger(result) || result > destinationCapacity) {
      return -5; // EIO
    }
    if (result < 0) {
      return result; // provider-reported negative errno
    }
    if (result > 0) {
      try {
        this.#writeKernelBytes(
          destination,
          subarrayUint8Array(staged, 0, result),
        );
      } catch {
        return -14; // EFAULT
      }
    }
    return result;
  }

  /**
   * Stage one scalar read outside kernel memory, then publish its validated
   * prefix once. A non-null offset is a true positioned operation and must
   * bypass stream-only stdin/shared-pipe behavior.
   */
  #hostReadAt(
    handle: bigint,
    destination: RustLentKernelDestination,
    offset: HostFileOffset | null,
  ): number {
    const h = Number(handle);
    const destinationCapacity = destination.capacity;
    // WHY: never lend a live view of Rust-owned memory to PlatformIO. A
    // backend can accidentally retain that view or reenter the kernel. Stage
    // into host memory, validate the producer count, then publish once through
    // the generation-bound pointer-plus-capacity token.
    let staged: Uint8Array;
    try {
      staged = new IntrinsicUint8Array(destinationCapacity);
    } catch {
      // WHY: one-operation transfers can legitimately exceed the ordinary
      // channel size. Expected host allocation failure is ENOMEM, not a
      // JavaScript exception allowed to trap Wasm while Rust owns an
      // Executing reservation that can no longer be recovered.
      return -12; // ENOMEM
    }
    const publish = (result: number): number => {
      if (
        !Number.isSafeInteger(result)
        || result < 0
        || result > destinationCapacity
      ) {
        return -5;
      }
      if (result > 0) {
        try {
          this.#writeKernelBytes(
            destination,
            subarrayUint8Array(staged, 0, result),
          );
        } catch {
          return -14;
        }
      }
      return result;
    };

    if (offset === null) {
      // Check shared pipe registry
      const readEntry = this.sharedPipes.get(h);
      if (readEntry) {
        return publish(readEntry.pipe.read(staged));
      }

      // stdin
      if (h === 0) {
        if (this.callbacks.onStdin) {
          const data = this.callbacks.onStdin(destinationCapacity);
          if (data === null) return 0; // EOF
          let exactData: Uint8Array;
          try {
            exactData = intrinsicUint8ArrayView(data, "stdin callback output");
          } catch {
            return -5; // EIO: the callback violated its byte-source contract.
          }
          const exactLength = typedArrayByteLength(exactData);
          if (exactLength === 0) {
            return -11; // EAGAIN — no data yet, retry later
          }
          const n = Math.min(exactLength, destinationCapacity);
          intrinsicApply(
            intrinsicUint8ArraySet,
            staged,
            [
            new IntrinsicUint8Array(
              typedArrayBuffer(exactData),
              typedArrayByteOffset(exactData),
              n,
            ),
            ],
          );
          return publish(n);
        }
        return 0; // EOF when no stdin callback
      }
    }

    try {
      return publish(
        this.io.read(h, staged, offset, destinationCapacity),
      );
    } catch (e) {
      return negErrno(e);
    }
  }

  /**
   * host_write(handle: i64, buf_ptr, buf_len) -> i32
   *
   * For handles 1 (stdout) and 2 (stderr): uses callback if provided,
   * falls back to process.stdout/stderr (Node.js), then console (browser).
   * Other handles: delegate to PlatformIO.
   */
  #hostWrite(
    handle: bigint,
    bufPtr: KernelPointer,
    bufLen: number,
  ): number {
    return this.#hostWriteAt(handle, bufPtr, bufLen, null);
  }

  #hostPwrite(
    handle: bigint,
    bufPtr: KernelPointer,
    bufLen: number,
    offsetLo: number,
    offsetHi: number,
  ): number {
    return this.#hostWriteAt(
      handle,
      bufPtr,
      bufLen,
      signedI64FromWords(offsetLo, offsetHi),
    );
  }

  /**
   * Append to a regular backing in one backend operation. Rust owns the live
   * O_APPEND bit and chooses this import per write; no persistent host flag is
   * changed when F_SETFL toggles.
   */
  #appendOutcomeLatch: {
    readonly handle: bigint;
    readonly written: number;
    readonly end: bigint;
  } | null = null;

  #hostAppend(
    handle: bigint,
    bufPtr: KernelPointer,
    bufLen: number,
    limitLo: number,
    limitHi: number,
  ): number {
    // WHY: a failed append attempt must invalidate any abandoned result from
    // an earlier call before Rust can ask for a position.
    this.#appendOutcomeLatch = null;
    const h = intrinsicNumber(handle);
    let data: Uint8Array;
    try {
      data = this.#readKernelBytes(bufPtr, bufLen);
    } catch (error) {
      return negErrno(error);
    }

    const encodedLimit = signedI64FromWords(limitLo, limitHi);
    if (encodedLimit < -1n) {
      throw new Error("kernel append limit is not -1 or a file position");
    }
    const limit: HostFileOffset | null = encodedLimit === -1n
      ? null
      : encodedLimit <= intrinsicBigInt(INTRINSIC_NUMBER_MAX_SAFE_INTEGER)
        ? intrinsicNumber(encodedLimit)
        : encodedLimit;

    let outcome: AppendOutcome;
    try {
      outcome = this.io.append(
        h,
        data,
        typedArrayByteLength(data),
        limit,
      );
    } catch (error) {
      if (isHostAppendContractError(error)) throw error;
      return negErrno(error);
    }

    // Backend contract violations are not ordinary I/O failures: the backing
    // may already have mutated. Throwing through the active Wasm export lets
    // the kernel entry gate poison this generation instead of returning EIO
    // and continuing with an unknowable cursor.
    const written = outcome.written;
    if (
      !intrinsicNumberIsSafeInteger(written)
      || written < 0
      || written > typedArrayByteLength(data)
    ) {
      throw new Error("backend returned an invalid append byte count");
    }
    const checkedEnd = checkedHostFileOffset(outcome.end);
    const end = intrinsicBigInt(checkedEnd);
    if (end < intrinsicBigInt(written)) {
      throw new Error("backend returned an append end before its written bytes");
    }
    if (encodedLimit >= 0n) {
      const start = end - intrinsicBigInt(written);
      if (start >= encodedLimit) {
        if (written !== 0) {
          throw new Error(
            "backend mutated an append that began at its size limit",
          );
        }
      } else if (end > encodedLimit) {
        throw new Error("backend append exceeded its exclusive size limit");
      }
    }

    this.#appendOutcomeLatch = { handle, written, end };
    return written;
  }

  /**
   * Consume the exact end paired with the immediately preceding append.
   *
   * A scalar one-shot latch avoids adding another host-to-kernel memory write
   * while still binding the result to the handle and byte count Rust saw.
   */
  #hostAppendPosition(handle: bigint, written: number): bigint {
    const outcome = this.#appendOutcomeLatch;
    this.#appendOutcomeLatch = null;
    if (
      outcome === null
      || outcome.handle !== handle
      || !intrinsicNumberIsSafeInteger(written)
      || written < 0
      || outcome.written !== written
    ) {
      throw new Error("missing or mismatched append outcome");
    }
    return outcome.end;
  }

  /**
   * Read one allocation-proved source and issue one scalar write. Positioned
   * writes bypass stream-only stdout/shared-pipe behavior and preserve the
   * open file description's current offset.
   */
  #hostWriteAt(
    handle: bigint,
    bufPtr: KernelPointer,
    bufLen: number,
    offset: HostFileOffset | null,
  ): number {
    const h = Number(handle);
    let data: Uint8Array;
    try {
      data = this.#readKernelBytes(bufPtr, bufLen);
    } catch (error) {
      return negErrno(error);
    }

    if (offset === null) {
      // Check shared pipe registry
      const writeEntry = this.sharedPipes.get(h);
      if (writeEntry) {
        return writeEntry.pipe.write(data);
      }

      // stdout / stderr — callback → process → console fallback chain
      if (h === 1) {
        if (this.callbacks.onStdout) {
          this.callbacks.onStdout(data);
        } else if (typeof process !== "undefined" && process.stdout) {
          process.stdout.write(data);
        } else {
          console.log(new TextDecoder().decode(data));
        }
        return bufLen;
      }
      if (h === 2) {
        if (this.callbacks.onStderr) {
          this.callbacks.onStderr(data);
        } else if (typeof process !== "undefined" && process.stderr) {
          process.stderr.write(data);
        } else {
          console.error(new TextDecoder().decode(data));
        }
        return bufLen;
      }
    }

    try {
      const dataLength = typedArrayByteLength(data);
      const written = this.io.write(h, data, offset, dataLength);
      return Number.isSafeInteger(written)
        && written >= 0
        && written <= dataLength
        ? written
        : -5;
    } catch (e) {
      return negErrno(e);
    }
  }

  /**
   * host_seek(handle: i64, offset_lo, offset_hi, whence) -> i64
   *
   * Combines the low and high 32-bit parts into a 64-bit offset.
   */
  #hostSeek(
    handle: bigint,
    offsetLo: number,
    offsetHi: number,
    whence: number,
  ): bigint {
    const h = Number(handle);
    const offset = signedI64FromWords(offsetLo, offsetHi);

    try {
      const result = checkedHostFileOffset(this.io.seek(h, offset, whence));
      const exactResult = BigInt(result);
      // WHY: negative i64 values on this import encode errno for Rust. A
      // backend seek result is a file position, so accepting one would let a
      // malformed backend forge an errno (and i64::MIN cannot be negated in
      // Rust). Collapse the broken backend contract to EIO.
      return exactResult < 0n ? -5n : exactResult;
    } catch (e) {
      return BigInt(negErrno(e));
    }
  }

  /**
   * host_fstat(handle: i64, stat_ptr) -> i32
   *
   * Writes a WasmStat structure into Wasm memory at stat_ptr.
   *
   * WasmStat layout (repr(C), 88 bytes total):
   *   0:  st_dev        u64
   *   8:  st_ino        u64
   *   16: st_mode       u32
   *   20: st_nlink      u32
   *   24: st_uid        u32
   *   28: st_gid        u32
   *   32: st_size       u64
   *   40: st_atime_sec  u64
   *   48: st_atime_nsec u32
   *   52: (pad)         u32
   *   56: st_mtime_sec  u64
   *   64: st_mtime_nsec u32
   *   68: (pad)         u32
   *   72: st_ctime_sec  u64
   *   80: st_ctime_nsec u32
   *   84: _pad          u32
   */
  #hostFstat(
    handle: bigint,
    destination: RustLentKernelDestination,
  ): number {
    const h = Number(handle);

    try {
      const stat = this.io.fstat(h);
      this.#writeStatToMemory(destination, stat);
      if (this.fstatHandleCapture) this.fstatHandleCapture.handle = h;
      return 0;
    } catch (e) {
      return negErrno(e);
    }
  }

  /**
   * Write a StatResult into the WasmStat struct at the given Wasm memory offset.
   */
  #writeStatToMemory(
    destination: RustLentKernelDestination,
    stat: StatResult,
  ): void {
    // Build the complete structure in host-owned memory, then publish it only
    // after the pointer and Rust-declared fixed capacity have both passed.
    const bytes = new IntrinsicUint8Array(WASM_STAT_SIZE);
    const dv = new IntrinsicDataView(typedArrayBuffer(bytes));

    dataViewSetBigUint64(dv, 0, exactU64(stat.dev, "st_dev"), true);
    dataViewSetBigUint64(dv, 8, exactU64(stat.ino, "st_ino"), true);
    dataViewSetUint32(dv, 16, stat.mode, true);
    dataViewSetUint32(dv, 20, stat.nlink, true);
    dataViewSetUint32(dv, 24, stat.uid, true);
    dataViewSetUint32(dv, 28, stat.gid, true);
    dataViewSetBigUint64(dv, 32, BigInt(stat.size), true);

    // Convert millisecond timestamps to seconds + nanoseconds.
    const atimeSec = Math.floor(stat.atimeMs / 1000);
    const atimeNsec = Math.floor((stat.atimeMs % 1000) * 1_000_000);
    dataViewSetBigUint64(dv, 40, BigInt(atimeSec), true);
    dataViewSetUint32(dv, 48, atimeNsec, true);

    const mtimeSec = Math.floor(stat.mtimeMs / 1000);
    const mtimeNsec = Math.floor((stat.mtimeMs % 1000) * 1_000_000);
    dataViewSetBigUint64(dv, 56, BigInt(mtimeSec), true);
    dataViewSetUint32(dv, 64, mtimeNsec, true);

    const ctimeSec = Math.floor(stat.ctimeMs / 1000);
    const ctimeNsec = Math.floor((stat.ctimeMs % 1000) * 1_000_000);
    dataViewSetBigUint64(dv, 72, BigInt(ctimeSec), true);
    dataViewSetUint32(dv, 80, ctimeNsec, true);
    // _pad at offset 84 already zeroed
    this.#writeKernelBytes(destination, bytes);
  }

  #writeStatfsToMemory(
    destination: RustLentKernelDestination,
    statfs: StatfsResult,
  ): void {
    const bytes = new IntrinsicUint8Array(WASM_STATFS_SIZE);
    const dv = new IntrinsicDataView(typedArrayBuffer(bytes));

    const u32 = (value: number): number => {
      if (!Number.isFinite(value)) return 0;
      return Math.max(0, Math.floor(value)) >>> 0;
    };
    const u64 = (value: number): bigint => {
      if (!Number.isFinite(value) || value <= 0) return 0n;
      return BigInt(Math.min(Math.floor(value), Number.MAX_SAFE_INTEGER));
    };

    dataViewSetUint32(dv, 0, u32(statfs.type), true);
    dataViewSetUint32(dv, 4, u32(statfs.bsize), true);
    dataViewSetBigUint64(dv, 8, u64(statfs.blocks), true);
    dataViewSetBigUint64(dv, 16, u64(statfs.bfree), true);
    dataViewSetBigUint64(dv, 24, u64(statfs.bavail), true);
    dataViewSetBigUint64(dv, 32, u64(statfs.files), true);
    dataViewSetBigUint64(dv, 40, u64(statfs.ffree), true);
    dataViewSetBigUint64(dv, 48, u64(statfs.fsid), true);
    dataViewSetUint32(dv, 56, u32(statfs.namelen), true);
    dataViewSetUint32(dv, 60, u32(statfs.frsize), true);
    dataViewSetUint32(dv, 64, u32(statfs.flags), true);
    this.#writeKernelBytes(destination, bytes);
  }

  // ---- Phase 2: Path-based and directory host imports ----

  /**
   * Read a UTF-8 path string from Wasm memory.
   */
  #readPathFromMemory(ptr: KernelPointer, len: number): string {
    const pathBytes = this.#readKernelBytes(ptr, len);
    return new TextDecoder().decode(pathBytes);
  }

  /**
   * host_stat(path_ptr, path_len, stat_ptr) -> i32
   */
  #hostStat(
    pathPtr: KernelPointer,
    pathLen: number,
    destination: RustLentKernelDestination,
  ): number {
    try {
      const path = this.#readPathFromMemory(pathPtr, pathLen);
      const stat = this.io.stat(path);
      this.#writeStatToMemory(destination, stat);
      return 0;
    } catch (e) {
      return negErrno(e);
    }
  }

  /**
   * host_lstat(path_ptr, path_len, stat_ptr) -> i32
   */
  #hostLstat(
    pathPtr: KernelPointer,
    pathLen: number,
    destination: RustLentKernelDestination,
  ): number {
    try {
      const path = this.#readPathFromMemory(pathPtr, pathLen);
      const stat = this.io.lstat(path);
      this.#writeStatToMemory(destination, stat);
      return 0;
    } catch (e) {
      return negErrno(e);
    }
  }

  #hostStatfs(
    pathPtr: KernelPointer,
    pathLen: number,
    destination: RustLentKernelDestination,
  ): number {
    try {
      const path = this.#readPathFromMemory(pathPtr, pathLen);
      const statfs = this.io.statfs(path);
      this.#writeStatfsToMemory(destination, statfs);
      return 0;
    } catch (e) {
      return negErrno(e);
    }
  }

  #hostFstatfs(
    handle: bigint,
    destination: RustLentKernelDestination,
  ): number {
    if (!this.io.fstatfs) return -38; // ENOSYS
    try {
      const statfs = this.io.fstatfs(Number(handle));
      this.#writeStatfsToMemory(destination, statfs);
      return 0;
    } catch (e) {
      return negErrno(e);
    }
  }

  #hostPathconf(
    pathPtr: KernelPointer,
    pathLen: number,
    name: number,
    destination: RustLentKernelDestination,
  ): number {
    try {
      const path = this.#readPathFromMemory(pathPtr, pathLen);
      const value = this.io.pathconf(path, name);
      const bytes = new IntrinsicUint8Array(8);
      dataViewSetBigInt64(
        new IntrinsicDataView(typedArrayBuffer(bytes)),
        0,
        BigInt(value ?? -1),
        true,
      );
      this.#writeKernelBytes(destination, bytes);
      return 0;
    } catch (e) {
      return negErrno(e);
    }
  }

  #hostFpathconf(
    handle: bigint,
    name: number,
    destination: RustLentKernelDestination,
  ): number {
    try {
      const value = this.io.fpathconf(Number(handle), name);
      const bytes = new IntrinsicUint8Array(8);
      dataViewSetBigInt64(
        new IntrinsicDataView(typedArrayBuffer(bytes)),
        0,
        BigInt(value ?? -1),
        true,
      );
      this.#writeKernelBytes(destination, bytes);
      return 0;
    } catch (e) {
      return negErrno(e);
    }
  }

  /**
   * host_mkdir(path_ptr, path_len, mode) -> i32
   */
  #hostMkdir(
    pathPtr: KernelPointer,
    pathLen: number,
    mode: number,
  ): number {
    try {
      const path = this.#readPathFromMemory(pathPtr, pathLen);
      this.io.mkdir(path, mode);
      return 0;
    } catch (e) {
      return negErrno(e);
    }
  }

  /**
   * host_rmdir(path_ptr, path_len) -> i32
   */
  #hostRmdir(pathPtr: KernelPointer, pathLen: number): number {
    try {
      const path = this.#readPathFromMemory(pathPtr, pathLen);
      this.io.rmdir(path);
      return 0;
    } catch (e) {
      return negErrno(e);
    }
  }

  /**
   * host_unlink(path_ptr, path_len) -> i32
   */
  #hostUnlink(pathPtr: KernelPointer, pathLen: number): number {
    try {
      const path = this.#readPathFromMemory(pathPtr, pathLen);
      this.io.unlink(path);
      return 0;
    } catch (e) {
      return negErrno(e);
    }
  }

  /**
   * host_rename(old_ptr, old_len, new_ptr, new_len) -> i32
   */
  #hostRename(
    oldPtr: KernelPointer,
    oldLen: number,
    newPtr: KernelPointer,
    newLen: number,
  ): number {
    try {
      const oldPath = this.#readPathFromMemory(oldPtr, oldLen);
      const newPath = this.#readPathFromMemory(newPtr, newLen);
      this.io.rename(oldPath, newPath);
      return 0;
    } catch (e) {
      return negErrno(e);
    }
  }

  /**
   * host_link(old_ptr, old_len, new_ptr, new_len) -> i32
   */
  #hostLink(
    oldPtr: KernelPointer,
    oldLen: number,
    newPtr: KernelPointer,
    newLen: number,
  ): number {
    try {
      const existingPath = this.#readPathFromMemory(oldPtr, oldLen);
      const newPath = this.#readPathFromMemory(newPtr, newLen);
      this.io.link(existingPath, newPath);
      return 0;
    } catch (e) {
      return negErrno(e);
    }
  }

  /**
   * host_symlink(target_ptr, target_len, link_ptr, link_len) -> i32
   */
  #hostSymlink(
    targetPtr: KernelPointer,
    targetLen: number,
    linkPtr: KernelPointer,
    linkLen: number,
  ): number {
    try {
      const target = this.#readPathFromMemory(targetPtr, targetLen);
      const linkPath = this.#readPathFromMemory(linkPtr, linkLen);
      this.io.symlink(target, linkPath);
      return 0;
    } catch (e) {
      return negErrno(e);
    }
  }

  /**
   * host_readlink(path_ptr, path_len, buf_ptr, buf_len) -> i32
   *
   * Returns the number of bytes written to the buffer, or -1 on error.
   */
  #hostReadlink(
    pathPtr: KernelPointer,
    pathLen: number,
    destination: RustLentKernelDestination,
  ): number {
    try {
      const path = this.#readPathFromMemory(pathPtr, pathLen);
      const target = this.io.readlink(path);
      const encoded = new TextEncoder().encode(target);
      const n = Math.min(encoded.length, destination.capacity);
      this.#writeKernelBytes(
        destination,
        subarrayUint8Array(encoded, 0, n),
      );
      return n;
    } catch (e) {
      return negErrno(e);
    }
  }

  /**
   * host_chmod(path_ptr, path_len, mode) -> i32
   */
  #hostChmod(
    pathPtr: KernelPointer,
    pathLen: number,
    mode: number,
  ): number {
    try {
      const path = this.#readPathFromMemory(pathPtr, pathLen);
      this.io.chmod(path, mode);
      return 0;
    } catch (e) {
      return negErrno(e);
    }
  }

  /**
   * host_chown(path_ptr, path_len, uid, gid) -> i32
   */
  #hostChown(
    pathPtr: KernelPointer,
    pathLen: number,
    uid: number,
    gid: number,
  ): number {
    try {
      const path = this.#readPathFromMemory(pathPtr, pathLen);
      this.io.chown(path, uid, gid);
      return 0;
    } catch (e) {
      return negErrno(e);
    }
  }

  /**
   * host_lchown(path_ptr, path_len, uid, gid) -> i32
   */
  #hostLchown(
    pathPtr: KernelPointer,
    pathLen: number,
    uid: number,
    gid: number,
  ): number {
    try {
      const path = this.#readPathFromMemory(pathPtr, pathLen);
      this.io.lchown(path, uid, gid);
      return 0;
    } catch (e) {
      return negErrno(e);
    }
  }

  /**
   * host_access(path_ptr, path_len, amode) -> i32
   */
  #hostAccess(
    pathPtr: KernelPointer,
    pathLen: number,
    amode: number,
  ): number {
    try {
      const path = this.#readPathFromMemory(pathPtr, pathLen);
      this.io.access(path, amode);
      return 0;
    } catch (e) {
      return negErrno(e);
    }
  }

  /**
   * host_utimensat(path_ptr, path_len, atime_sec, atime_nsec, mtime_sec, mtime_nsec) -> i32
   */
  #hostUtimensat(
    pathPtr: KernelPointer,
    pathLen: number,
    atimeSec: bigint,
    atimeNsec: bigint,
    mtimeSec: bigint,
    mtimeNsec: bigint,
  ): number {
    try {
      const path = this.#readPathFromMemory(pathPtr, pathLen);
      this.io.utimensat(path, Number(atimeSec), Number(atimeNsec), Number(mtimeSec), Number(mtimeNsec));
      return 0;
    } catch {
      return -1;
    }
  }

  /**
   * host_waitpid(pid, options, status_ptr) -> i32
   * Returns child pid on success, negative errno on error.
   * Writes wait status to status_ptr.
   */
  #hostWaitpid(
    pid: number,
    options: number,
    statusDestination: RustLentKernelDestination | null,
  ): number {
    // The import boundary mints this token before either wait backend can
    // consume child state. Publication rechecks the current Memory generation.
    // If we have a waitpid callback + SAB, use blocking host delegation
    if (this.waitpidSab && this.callbacks.onWaitpid) {
      const view = new IntrinsicInt32Array(this.waitpidSab);
      intrinsicApply(intrinsicAtomicsStore, Atomics, [view, 0, 0]);
      intrinsicApply(intrinsicAtomicsStore, Atomics, [view, 1, 0]);
      intrinsicApply(intrinsicAtomicsStore, Atomics, [view, 2, 0]);

      this.callbacks.onWaitpid(pid, options);

      // Block until host signals completion
      intrinsicApply(intrinsicAtomicsWait, Atomics, [view, 0, 0]);

      const resultPid = intrinsicApply(
        intrinsicAtomicsLoad,
        Atomics,
        [view, 1],
      ) as number;
      const resultStatus = intrinsicApply(
        intrinsicAtomicsLoad,
        Atomics,
        [view, 2],
      ) as number;

      if (resultPid < 0) {
        return resultPid; // negative errno
      }

      if (statusDestination !== null) {
        const bytes = new IntrinsicUint8Array(4);
        dataViewSetInt32(
          new IntrinsicDataView(typedArrayBuffer(bytes)),
          0,
          resultStatus,
          true,
        );
        try {
          this.#writeKernelBytes(
            statusDestination,
            bytes,
          );
        } catch {
          return -14; // EFAULT
        }
      }
      return resultPid;
    }

    // Fallback to PlatformIO
    if (!this.io.waitpid) {
      return -10; // -ECHILD
    }
    let result: { pid: number; status: number };
    try {
      result = this.io.waitpid(pid, options);
    } catch {
      return -10; // -ECHILD
    }
    if (statusDestination !== null) {
      const bytes = new IntrinsicUint8Array(4);
      dataViewSetInt32(
        new IntrinsicDataView(typedArrayBuffer(bytes)),
        0,
        result.status,
        true,
      );
      try {
        this.#writeKernelBytes(
          statusDestination,
          bytes,
        );
      } catch {
        return -14; // EFAULT
      }
    }
    return result.pid;
  }

  /**
   * host_opendir(path_ptr, path_len) -> i64
   *
   * Returns a directory handle as i64, or -1 on error.
   */
  #hostOpendir(pathPtr: KernelPointer, pathLen: number): bigint {
    try {
      const path = this.#readPathFromMemory(pathPtr, pathLen);
      const handle = this.io.opendir(path);
      // Backends may reuse numeric handles after close. Never let an entry
      // staged for an older iterator leak into the new one.
      this.pendingDirectoryEntries.delete(handle);
      return BigInt(handle);
    } catch (e) {
      return BigInt(negErrno(e));
    }
  }

  /**
   * host_readdir(dir_handle: i64, dirent_ptr, name_ptr, name_len) -> i32
   *
   * Writes a WasmDirent struct and the entry name to Wasm memory.
   * Returns 1 if an entry was written, 0 at end-of-directory, -1 on error.
   */
  #hostReaddir(
    dirHandle: bigint,
    direntDestination: RustLentKernelDestination,
    nameDestination: RustLentKernelDestination,
  ): number {
    try {
      const h = Number(dirHandle);
      let dirEntry = this.pendingDirectoryEntries.get(h);
      if (dirEntry === undefined) {
        const next = this.io.readdir(h);
        if (next === null) return 0; // end of directory
        this.pendingDirectoryEntries.set(h, next);
        dirEntry = next;
      }

      // Write the generated WasmDirent layout. Rust owns these offsets so a
      // future layout change cannot silently desynchronize host copy-back.
      const encoded = new TextEncoder().encode(dirEntry.name);
      if (encoded.length > nameDestination.capacity) {
        // WHY: this legacy iterator consumes one complete entry per success.
        // Truncating the name would both publish a false result and lose the
        // entry. Leave it pending so an exact-capacity retry sees the same
        // bytes, and mutate neither caller-visible destination on failure.
        return NEG_ERRNO_BY_NAME.ERANGE;
      }
      const n = encoded.length;
      const dirent = new IntrinsicUint8Array(WASM_DIRENT_SIZE);
      const view = new IntrinsicDataView(typedArrayBuffer(dirent));
      dataViewSetBigUint64(
        view,
        WASM_DIRENT_INO_OFFSET,
        BigInt(dirEntry.ino),
        true,
      );
      dataViewSetUint32(view, WASM_DIRENT_TYPE_OFFSET, dirEntry.type, true);
      dataViewSetUint32(view, WASM_DIRENT_NAME_LENGTH_OFFSET, n, true);
      this.#writeKernelBytes(
        direntDestination,
        dirent,
      );
      this.#writeKernelBytes(
        nameDestination,
        subarrayUint8Array(encoded, 0, n),
      );

      this.pendingDirectoryEntries.delete(h);
      return 1;
    } catch (e) {
      return negErrno(e);
    }
  }

  /**
   * host_closedir(dir_handle: i64) -> i32
   */
  #hostClosedir(dirHandle: bigint): number {
    const h = Number(dirHandle);
    try {
      this.io.closedir(h);
      return 0;
    } catch {
      return -1;
    } finally {
      this.pendingDirectoryEntries.delete(h);
    }
  }

  // ---- Phase 7: Time host imports ----

  /**
   * host_clock_gettime(clock_id, sec_ptr, nsec_ptr) -> i32
   *
   * Writes the current time (seconds and nanoseconds) to Wasm memory
   * at the given pointers.
   */
  #hostClockGettime(
    clockId: number,
    secondsDestination: RustLentKernelDestination,
    nanosecondsDestination: RustLentKernelDestination,
  ): number {
    try {
      const result = this.io.clockGettime(clockId);
      const seconds = new IntrinsicUint8Array(8);
      const nanoseconds = new IntrinsicUint8Array(8);
      dataViewSetBigInt64(
        new IntrinsicDataView(typedArrayBuffer(seconds)),
        0,
        BigInt(result.sec),
        true,
      );
      dataViewSetBigInt64(
        new IntrinsicDataView(typedArrayBuffer(nanoseconds)),
        0,
        BigInt(result.nsec),
        true,
      );
      this.#writeKernelBytes(
        secondsDestination,
        seconds,
      );
      this.#writeKernelBytes(
        nanosecondsDestination,
        nanoseconds,
      );
      return 0;
    } catch (error) {
      return negErrno(error);
    }
  }

  /**
   * host_nanosleep(sec: i64, nsec: i64) -> i32
   *
   * Sleep for the specified duration. The i64 parameters appear as
   * BigInt in JavaScript.
   */
  #hostNanosleep(sec: bigint, nsec: bigint): number {
    try {
      this.io.nanosleep(Number(sec), Number(nsec));
      return 0;
    } catch {
      return -1;
    }
  }

  // ---- Phase 11: ftruncate/fsync/fchmod/fchown host imports ----

  #hostFtruncate(handle: bigint, length: bigint): number {
    if (length < 0n) return -22; // EINVAL
    if (length > BigInt(Number.MAX_SAFE_INTEGER)) return -75; // EOVERFLOW
    try {
      this.io.ftruncate(Number(handle), Number(length));
      return 0;
    } catch {
      return -1;
    }
  }

  #hostFsync(handle: bigint): number {
    try {
      this.io.fsync(Number(handle));
      return 0;
    } catch {
      return -1;
    }
  }

  /**
   * host_fchmod(handle: i64, mode: u32) -> i32
   */
  #hostFchmod(handle: bigint, mode: number): number {
    try {
      this.io.fchmod(Number(handle), mode);
      return 0;
    } catch {
      return -1;
    }
  }

  /**
   * host_fchown(handle: i64, uid: u32, gid: u32) -> i32
   */
  #hostFchown(handle: bigint, uid: number, gid: number): number {
    try {
      this.io.fchown(Number(handle), uid, gid);
      return 0;
    } catch {
      return -1;
    }
  }

  // ---- Phase 14: Alarm ----

  #hostSetAlarm(seconds: number): number {
    if (this.callbacks.onAlarm) {
      return this.callbacks.onAlarm(seconds);
    }
    return 0;
  }

  #hostSetPosixTimer(timerId: number, signo: number, valueMs: number, intervalMs: number): number {
    if (this.callbacks.onPosixTimer) {
      return this.callbacks.onPosixTimer(timerId, signo, valueMs, intervalMs);
    }
    return 0;
  }

  #hostSigsuspendWait(): number {
    if (!this.signalWakeSab) {
      return -(4); // -EINTR, no SAB available
    }
    const view = new IntrinsicInt32Array(this.signalWakeSab);

    // Check if already signaled (race-safe via CAS)
    const old = intrinsicApply(
      intrinsicAtomicsCompareExchange,
      Atomics,
      [view, 0, 1, 0],
    ) as number;
    if (old === 1) {
      const sig = intrinsicApply(
        intrinsicAtomicsLoad,
        Atomics,
        [view, 1],
      ) as number;
      intrinsicApply(intrinsicAtomicsStore, Atomics, [view, 1, 0]);
      return sig;
    }

    // Block until notified
    intrinsicApply(intrinsicAtomicsWait, Atomics, [view, 0, 0]);

    // Read signal and reset
    const sig = intrinsicApply(
      intrinsicAtomicsLoad,
      Atomics,
      [view, 1],
    ) as number;
    intrinsicApply(intrinsicAtomicsStore, Atomics, [view, 0, 0]);
    intrinsicApply(intrinsicAtomicsStore, Atomics, [view, 1, 0]);
    return sig;
  }

  // ---- Public API: Socket & Poll operations ----

  /**
   * Create a socket. Returns the fd or throws on error.
   */
  socket(domain: number, type: number, protocol: number): number {
    const fn = this.#instance!.exports.kernel_socket as (
      domain: number,
      type: number,
      protocol: number,
    ) => number;
    const result = fn(domain, type, protocol);
    if (result < 0) throw new Error(`socket failed: errno ${-result}`);
    return result;
  }

  /**
   * Create a connected pair of Unix domain stream sockets.
   * Returns [fd0, fd1].
   */
  socketpair(domain: number, type: number, protocol: number): [number, number] {
    return this.#requireApiScratch().withLease((scratch) => {
      const result = scratch.invokeKernelExport("kernel_socketpair", [
        domain,
        type,
        protocol,
        scratch.exportPointer(0, KERNEL_SCRATCH_FD_PAIR_BYTES),
        KERNEL_SCRATCH_FD_PAIR_BYTES,
      ]);
      if (result < 0) throw new Error(`socketpair failed: errno ${-result}`);
      const output = scratch.dataView(0, KERNEL_SCRATCH_FD_PAIR_BYTES);
      return [output.getInt32(0, true), output.getInt32(4, true)];
    });
  }

  /**
   * Shut down part of a full-duplex socket connection.
   */
  shutdown(fd: number, how: number): void {
    const fn = this.#instance!.exports.kernel_shutdown as (
      fd: number,
      how: number,
    ) => number;
    const result = fn(fd, how);
    if (result < 0) throw new Error(`shutdown failed: errno ${-result}`);
  }

  /**
   * Send data on a connected socket. Returns bytes sent.
   */
  send(fd: number, data: Uint8Array, flags: number = 0): number {
    const exactData = intrinsicUint8ArrayView(data, "socket send input");
    const exactLength = typedArrayByteLength(exactData);
    return this.#requireApiScratch().withLease((scratch) => {
      scratch.copyFrom(exactData);
      const result = scratch.invokeKernelExport("kernel_send", [
        fd,
        scratch.exportPointer(0, exactLength),
        exactLength,
        flags,
      ]);
      if (result < 0) throw new Error(`send failed: errno ${-result}`);
      if (!Number.isSafeInteger(result) || result > exactLength) {
        throw new Error(`send returned invalid byte count ${result}`);
      }
      return result;
    });
  }

  /**
   * Receive data from a connected socket. Returns the received data.
   */
  recv(fd: number, maxLen: number, flags: number = 0): Uint8Array {
    if (!Number.isSafeInteger(maxLen) || maxLen < 0) {
      throw new Error("recv length must be a non-negative safe integer");
    }
    return this.#requireApiScratch().withLease((scratch) => {
      const result = scratch.invokeKernelExport("kernel_recv", [
        fd,
        scratch.exportPointer(0, maxLen),
        maxLen,
        flags,
      ]);
      if (result < 0) throw new Error(`recv failed: errno ${-result}`);
      if (!Number.isSafeInteger(result) || result > maxLen) {
        throw new Error(`recv returned invalid byte count ${result}`);
      }
      return scratch.copyOut(0, result);
    });
  }

  /**
   * Poll file descriptors for I/O readiness.
   * Returns array of {fd, events, revents} with revents filled in.
   */
  poll(
    fds: Array<{ fd: number; events: number }>,
    timeout: number,
  ): Array<{ fd: number; events: number; revents: number }> {
    const nfds = fds.length;
    if (!Number.isSafeInteger(nfds) || nfds < 0) {
      throw new Error("poll descriptor count must be a non-negative safe integer");
    }
    const scratchRegion = this.#requireApiScratch();
    const descriptorCapacity = Math.floor(
      scratchRegion.capacity / STRUCT_SIZE_WASM_POLL_FD,
    );
    if (nfds > descriptorCapacity) {
      throw new Error(
        `poll descriptor count ${nfds} exceeds owned scratch capacity ` +
          String(descriptorCapacity),
      );
    }
    return scratchRegion.withLease((scratch) => {
      const byteLength = nfds * STRUCT_SIZE_WASM_POLL_FD;
      const view = scratch.dataView(0, byteLength);
      for (let index = 0; index < nfds; index++) {
        const offset = index * STRUCT_SIZE_WASM_POLL_FD;
        view.setInt32(
          offset + WASM_POLL_FD_FD_OFFSET,
          fds[index].fd,
          true,
        );
        view.setInt16(
          offset + WASM_POLL_FD_EVENTS_OFFSET,
          fds[index].events,
          true,
        );
        view.setInt16(offset + WASM_POLL_FD_REVENTS_OFFSET, 0, true);
      }
      const result = scratch.invokeKernelExport("kernel_poll", [
        scratch.exportPointer(0, byteLength),
        byteLength,
        nfds,
        timeout,
      ]);
      if (result < 0) throw new Error(`poll failed: errno ${-result}`);
      if (!Number.isSafeInteger(result) || result > nfds) {
        throw new Error(`poll returned invalid ready count ${result}`);
      }
      const resultView = scratch.dataView(0, byteLength);
      return fds.map((entry, index) => ({
        fd: entry.fd,
        events: entry.events,
        revents: resultView.getInt16(
          index * STRUCT_SIZE_WASM_POLL_FD
            + WASM_POLL_FD_REVENTS_OFFSET,
          true,
        ),
      }));
    });
  }

  /**
   * Get a socket option value.
   */
  getsockopt(fd: number, level: number, optname: number): number {
    return this.#requireApiScratch().withLease((scratch) => {
      const output = scratch.dataView(
        0,
        KERNEL_SCRATCH_SOCKLEN_BYTES * 2,
      );
      output.setUint32(
        KERNEL_SCRATCH_SOCKLEN_BYTES,
        KERNEL_SCRATCH_SOCKLEN_BYTES,
        true,
      );
      const result = scratch.invokeKernelExport("kernel_getsockopt", [
        fd,
        level,
        optname,
        scratch.exportPointer(0, KERNEL_SCRATCH_SOCKLEN_BYTES),
        KERNEL_SCRATCH_SOCKLEN_BYTES,
        scratch.exportPointer(
          KERNEL_SCRATCH_SOCKLEN_BYTES,
          KERNEL_SCRATCH_SOCKLEN_BYTES,
        ),
        KERNEL_SCRATCH_SOCKLEN_BYTES,
      ]);
      if (result < 0) throw new Error(`getsockopt failed: errno ${-result}`);
      const returnedLength = output.getUint32(
        KERNEL_SCRATCH_SOCKLEN_BYTES,
        true,
      );
      if (returnedLength !== KERNEL_SCRATCH_SOCKLEN_BYTES) {
        throw new Error(
          `getsockopt returned invalid scalar option length ${returnedLength}`,
        );
      }
      return output.getUint32(0, true);
    });
  }

  /**
   * Set a socket option value.
   */
  setsockopt(fd: number, level: number, optname: number, value: number): void {
    this.#requireApiScratch().withLease((scratch) => {
      // WHY: `value` is data, not a kernel address. Stage its complete scalar
      // representation in an allocator-owned region and pass the exact extent;
      // total Wasm memory size says nothing about this allocation's capacity.
      scratch.dataView(0, KERNEL_SCRATCH_SOCKLEN_BYTES).setUint32(
        0,
        value,
        true,
      );
      const result = scratch.invokeKernelExport("kernel_setsockopt", [
        fd,
        level,
        optname,
        scratch.exportPointer(0, KERNEL_SCRATCH_SOCKLEN_BYTES),
        KERNEL_SCRATCH_SOCKLEN_BYTES,
      ]);
      if (result < 0) throw new Error(`setsockopt failed: errno ${-result}`);
    });
  }

  // ---- Public API: Terminal operations ----

  /**
   * Get terminal attributes in musl's exact 60-byte struct termios layout.
   */
  tcgetattr(fd: number): Uint8Array {
    return this.#requireApiScratch().withLease((scratch) => {
      const result = scratch.invokeKernelExport("kernel_tcgetattr", [
        fd,
        scratch.exportPointer(0, 60),
        60,
      ]);
      if (result < 0) throw new Error(`tcgetattr failed: errno ${-result}`);
      return scratch.copyOut(0, 60);
    });
  }

  /**
   * Set terminal attributes.
   * action: 0=TCSANOW, 1=TCSADRAIN, 2=TCSAFLUSH
   */
  tcsetattr(fd: number, action: number, attrs: Uint8Array): void {
    const exactAttrs = intrinsicUint8ArrayView(
      attrs,
      "terminal attributes input",
    );
    this.#requireApiScratch().withLease((scratch) => {
      scratch.copyFrom(exactAttrs);
      const result = scratch.invokeKernelExport("kernel_tcsetattr", [
        fd,
        action,
        scratch.exportPointer(0, typedArrayByteLength(exactAttrs)),
        typedArrayByteLength(exactAttrs),
      ]);
      if (result < 0) throw new Error(`tcsetattr failed: errno ${-result}`);
    });
  }

  /**
   * Perform an ioctl operation.
   * For TIOCGWINSZ (0x5413): returns 8-byte buffer (ws_row, ws_col, ws_xpixel, ws_ypixel as u16 LE)
   * For TIOCSWINSZ (0x5414): pass 8-byte buffer to set window size
   */
  ioctl(
    fd: number,
    request: number,
    arg?: Uint8Array | number,
  ): Uint8Array {
    const fn = this.#instance!.exports.kernel_ioctl as (
      fd: number,
      request: number,
      bufPtr: KernelPointer,
      bufLen: number,
      processPointerWidth: number,
    ) => number;
    const contract = IOCTL_REQUESTS[request >>> 0];
    const wasm32Size = contract?.wasm32Size;
    if (contract && wasm32Size === null) {
      throw new Error(
        `ioctl 0x${(request >>> 0).toString(16)} has no wasm32 layout`,
      );
    }
    const expectedSize = wasm32Size ?? 0;
    return this.#requireApiScratch().withLease((scratch) => {
      let bufLen = 0;
      let scalarArgument = 0;
      if (contract?.argKind === "pointer") {
        if (typeof arg === "number") {
          throw new Error("pointer ioctl requires a byte buffer");
        }
        bufLen = expectedSize;
        if (arg && typedArrayByteLength(arg) !== bufLen) {
          throw new Error(
            `ioctl buffer is ${typedArrayByteLength(arg)} bytes; expected ${bufLen}`,
          );
        }
        if (!arg && contract.direction !== "out") {
          throw new Error("input ioctl requires a byte buffer");
        }
        if (arg) scratch.copyFrom(arg, 0, 0, bufLen);
        else scratch.fill(0, 0, bufLen);
      } else if (contract?.argKind === "scalar-i32") {
        if (!Number.isInteger(arg) || (arg as number) < -0x8000_0000 ||
            (arg as number) > 0xffff_ffff) {
          throw new Error("scalar ioctl argument must fit in 32 bits");
        }
        scalarArgument = (arg as number) >>> 0;
      }
      const result = contract?.argKind === "pointer"
        ? scratch.invokeKernelExport("kernel_ioctl", [
          fd,
          request,
          scratch.exportPointer(0, bufLen),
          bufLen,
          4,
        ])
        : fn(
          fd,
          request,
          this.toKernelPtr(scalarArgument),
          bufLen,
          4,
        );
      if (result < 0) throw new Error(`ioctl failed: errno ${-result}`);
      return bufLen === 0 ? new IntrinsicUint8Array(0) : scratch.copyOut(0, bufLen);
    });
  }

  /**
   * Set signal handler (legacy API). Returns previous handler value.
   * handler: 0=SIG_DFL, 1=SIG_IGN, or function pointer index
   */
  signal(signum: number, handler: number): number {
    const fn = this.#instance!.exports.kernel_signal as (
      signum: number,
      handler: number,
    ) => number;
    const result = fn(signum, handler);
    if (result < 0) throw new Error(`signal failed: errno ${-result}`);
    return result;
  }

  // ---- Public API: Phase 10 Extended POSIX ----

  /**
   * Set file creation mask. Returns previous mask.
   */
  umask(mask: number): number {
    const fn = this.#instance!.exports.kernel_umask as (mask: number) => number;
    return fn(mask);
  }

  /**
   * Get system identification. Returns object with sysname, nodename, release, version, machine.
   */
  uname(): { sysname: string; nodename: string; release: string; version: string; machine: string } {
    return this.#requireApiScratch().withLease((scratch) => {
      const result = scratch.invokeKernelExport("kernel_uname", [
        scratch.exportPointer(0, 325),
        325,
      ]);
      if (result < 0) throw new Error(`uname failed: errno ${-result}`);
      const bytes = scratch.copyOut(0, 325);
      const decoder = new TextDecoder();
      const readField = (offset: number): string => {
        let end = offset;
        while (end < offset + 65 && bytes[end] !== 0) end++;
        return decoder.decode(subarrayUint8Array(bytes, offset, end));
      };
      return {
        sysname: readField(0),
        nodename: readField(65),
        release: readField(130),
        version: readField(195),
        machine: readField(260),
      };
    });
  }

  /**
   * Get configurable system variable value.
   */
  sysconf(name: number): number {
    const fn = this.#instance!.exports.kernel_sysconf as (name: number) => bigint;
    const result = fn(name);
    return Number(result);
  }

  /**
   * Duplicate fd with flags. Unlike dup2, returns error if oldfd == newfd.
   */
  dup3(oldfd: number, newfd: number, flags: number): number {
    const fn = this.#instance!.exports.kernel_dup3 as (
      oldfd: number, newfd: number, flags: number
    ) => number;
    const result = fn(oldfd, newfd, flags);
    if (result < 0) throw new Error(`dup3 failed: errno ${-result}`);
    return result;
  }

  /**
   * Create pipe with flags (O_NONBLOCK, O_CLOEXEC). Returns [readFd, writeFd].
   */
  pipe2(flags: number): [number, number] {
    return this.#requireApiScratch().withLease((scratch) => {
      const result = scratch.invokeKernelExport("kernel_pipe2", [
        flags,
        scratch.exportPointer(0, KERNEL_SCRATCH_FD_PAIR_BYTES),
        KERNEL_SCRATCH_FD_PAIR_BYTES,
      ]);
      if (result < 0) throw new Error(`pipe2 failed: errno ${-result}`);
      const output = scratch.dataView(0, KERNEL_SCRATCH_FD_PAIR_BYTES);
      return [output.getInt32(0, true), output.getInt32(4, true)];
    });
  }

  /**
   * Truncate file to specified length.
   */
  ftruncate(fd: number, length: number): void {
    if (!Number.isSafeInteger(length) || length < 0) {
      throw new Error("ftruncate length must be a non-negative safe integer");
    }
    const fn = this.#instance!.exports.kernel_ftruncate as (
      fd: number, length: bigint
    ) => number;
    // WHY: direct Wasm i64 parameters are JavaScript BigInt values. Splitting
    // this scalar into i32 words changes the call shape and traps before Rust.
    const result = fn(fd, BigInt(length));
    if (result < 0) throw new Error(`ftruncate failed: errno ${-result}`);
  }

  /**
   * Synchronize file state to storage.
   */
  fsync(fd: number): void {
    const fn = this.#instance!.exports.kernel_fsync as (fd: number) => number;
    const result = fn(fd);
    if (result < 0) throw new Error(`fsync failed: errno ${-result}`);
  }

  // ---- Public API: Phase 11 Final Gaps ----

  /**
   * Truncate a file by path to specified length.
   */
  truncate(path: string, length: number): void {
    if (!Number.isSafeInteger(length) || length < 0) {
      throw new Error("truncate length must be a non-negative safe integer");
    }
    const encodedPath = new TextEncoder().encode(path);
    this.#requireApiScratch().withLease((scratch) => {
      scratch.copyFrom(encodedPath);
      const result = scratch.invokeKernelExport("kernel_truncate", [
        scratch.exportPointer(0, typedArrayByteLength(encodedPath)),
        typedArrayByteLength(encodedPath),
        BigInt(length),
      ]);
      if (result < 0) throw new Error(`truncate failed: errno ${-result}`);
    });
  }

  /**
   * Synchronize file data to storage (alias for fsync in Wasm).
   */
  fdatasync(fd: number): void {
    const fn = this.#instance!.exports.kernel_fdatasync as (fd: number) => number;
    const result = fn(fd);
    if (result < 0) throw new Error(`fdatasync failed: errno ${-result}`);
  }

  /**
   * Change file mode via fd.
   */
  fchmod(fd: number, mode: number): void {
    const fn = this.#instance!.exports.kernel_fchmod as (fd: number, mode: number) => number;
    const result = fn(fd, mode);
    if (result < 0) throw new Error(`fchmod failed: errno ${-result}`);
  }

  /**
   * Change file owner/group via fd.
   */
  fchown(fd: number, uid: number, gid: number): void {
    const fn = this.#instance!.exports.kernel_fchown as (
      fd: number, uid: number, gid: number
    ) => number;
    const result = fn(fd, uid, gid);
    if (result < 0) throw new Error(`fchown failed: errno ${-result}`);
  }

  /**
   * Get process group ID.
   */
  getpgrp(): number {
    const fn = this.#instance!.exports.kernel_getpgrp as () => number;
    return fn();
  }

  /**
   * Set process group ID.
   */
  setpgid(pid: number, pgid: number): void {
    const fn = this.#instance!.exports.kernel_setpgid as (
      pid: number, pgid: number
    ) => number;
    const result = fn(pid, pgid);
    if (result < 0) throw new Error(`setpgid failed: errno ${-result}`);
  }

  /**
   * Get session ID.
   */
  getsid(pid: number): number {
    const fn = this.#instance!.exports.kernel_getsid as (pid: number) => number;
    const result = fn(pid);
    if (result < 0) throw new Error(`getsid failed: errno ${-result}`);
    return result;
  }

  /**
   * Create new session.
   */
  setsid(): number {
    const fn = this.#instance!.exports.kernel_setsid as () => number;
    const result = fn();
    if (result < 0) throw new Error(`setsid failed: errno ${-result}`);
    return result;
  }

  // ---- Public API: Phase 12 Remaining Tractable ----

  /**
   * Set real and effective user ID.
   */
  setuid(uid: number): void {
    const fn = this.#instance!.exports.kernel_setuid as (uid: number) => number;
    const result = fn(uid);
    if (result < 0) throw new Error(`setuid failed: errno ${-result}`);
  }

  /**
   * Set real and effective group ID.
   */
  setgid(gid: number): void {
    const fn = this.#instance!.exports.kernel_setgid as (gid: number) => number;
    const result = fn(gid);
    if (result < 0) throw new Error(`setgid failed: errno ${-result}`);
  }

  /**
   * Set effective user ID.
   */
  seteuid(euid: number): void {
    const fn = this.#instance!.exports.kernel_seteuid as (euid: number) => number;
    const result = fn(euid);
    if (result < 0) throw new Error(`seteuid failed: errno ${-result}`);
  }

  /**
   * Set effective group ID.
   */
  setegid(egid: number): void {
    const fn = this.#instance!.exports.kernel_setegid as (egid: number) => number;
    const result = fn(egid);
    if (result < 0) throw new Error(`setegid failed: errno ${-result}`);
  }

  /**
   * Get resource usage. Returns 144-byte rusage struct.
   */
  getrusage(who: number): Uint8Array {
    return this.#requireApiScratch().withLease((scratch) => {
      const result = scratch.invokeKernelExport("kernel_getrusage", [
        who,
        scratch.exportPointer(0, 144),
        144,
      ]);
      if (result < 0) throw new Error(`getrusage failed: errno ${-result}`);
      return scratch.copyOut(0, 144);
    });
  }

  /**
   * select() — synchronous I/O multiplexing.
   * Takes fd arrays for read/write/except monitoring, returns arrays of ready fds.
   */
  select(
    nfds: number,
    readfds: number[] | null,
    writefds: number[] | null,
    exceptfds: number[] | null,
  ): { readReady: number[]; writeReady: number[]; exceptReady: number[] } {
    if (
      !Number.isSafeInteger(nfds) ||
      nfds < 0 ||
      nfds > SELECT_FD_SETSIZE
    ) {
      throw new Error(
        `select nfds must be between 0 and ${SELECT_FD_SETSIZE}`,
      );
    }
    const validateSet = (set: number[] | null): void => {
      for (const fd of set ?? []) {
        if (!Number.isSafeInteger(fd) || fd < 0 || fd >= nfds) {
          throw new Error(`select fd ${fd} is outside nfds ${nfds}`);
        }
      }
    };
    validateSet(readfds);
    validateSet(writefds);
    validateSet(exceptfds);

    return this.#requireApiScratch().withLease((scratch) => {
      const totalSetBytes = 3 * SELECT_FD_SET_BYTES;
      scratch.fill(0, 0, totalSetBytes);
      const readOffset = 0;
      const writeOffset = SELECT_FD_SET_BYTES;
      const exceptOffset = 2 * SELECT_FD_SET_BYTES;
      // WHY: keep every lease operation visibly inside withLease. A local
      // helper that closes over scratch could be retained during a refactor and
      // resume after another select has replaced the shared allocation bytes.
      if (readfds) {
        const bytes = scratch.dataView(readOffset, SELECT_FD_SET_BYTES);
        for (const fd of readfds) {
          const byteOffset = Math.floor(fd / 8);
          bytes.setUint8(
            byteOffset,
            bytes.getUint8(byteOffset) | (1 << (fd % 8)),
          );
        }
      }
      if (writefds) {
        const bytes = scratch.dataView(writeOffset, SELECT_FD_SET_BYTES);
        for (const fd of writefds) {
          const byteOffset = Math.floor(fd / 8);
          bytes.setUint8(
            byteOffset,
            bytes.getUint8(byteOffset) | (1 << (fd % 8)),
          );
        }
      }
      if (exceptfds) {
        const bytes = scratch.dataView(exceptOffset, SELECT_FD_SET_BYTES);
        for (const fd of exceptfds) {
          const byteOffset = Math.floor(fd / 8);
          bytes.setUint8(
            byteOffset,
            bytes.getUint8(byteOffset) | (1 << (fd % 8)),
          );
        }
      }
      const nullPointer = this.toKernelPtr(0);
      // WHY: each nullable pointer is immediately followed by the exact extent
      // Rust may access. This keeps capacity proof coupled to the pointer across
      // the host/kernel boundary and avoids eight subtly different call shapes.
      const result = scratch.invokeKernelExport("kernel_select", [
        nfds,
        readfds
          ? scratch.exportPointer(readOffset, SELECT_FD_SET_BYTES)
          : nullPointer,
        readfds ? SELECT_FD_SET_BYTES : 0,
        writefds
          ? scratch.exportPointer(writeOffset, SELECT_FD_SET_BYTES)
          : nullPointer,
        writefds ? SELECT_FD_SET_BYTES : 0,
        exceptfds
          ? scratch.exportPointer(exceptOffset, SELECT_FD_SET_BYTES)
          : nullPointer,
        exceptfds ? SELECT_FD_SET_BYTES : 0,
        0,
      ]);
      if (result < 0) throw new Error(`select failed: errno ${-result}`);
      const readReady: number[] = [];
      if (readfds) {
        const bytes = scratch.dataView(readOffset, SELECT_FD_SET_BYTES);
        for (const fd of readfds) {
          if (
            ((bytes.getUint8(Math.floor(fd / 8)) >> (fd % 8)) & 1) !== 0
          ) {
            readReady.push(fd);
          }
        }
      }
      const writeReady: number[] = [];
      if (writefds) {
        const bytes = scratch.dataView(writeOffset, SELECT_FD_SET_BYTES);
        for (const fd of writefds) {
          if (
            ((bytes.getUint8(Math.floor(fd / 8)) >> (fd % 8)) & 1) !== 0
          ) {
            writeReady.push(fd);
          }
        }
      }
      const exceptReady: number[] = [];
      if (exceptfds) {
        const bytes = scratch.dataView(exceptOffset, SELECT_FD_SET_BYTES);
        for (const fd of exceptfds) {
          if (
            ((bytes.getUint8(Math.floor(fd / 8)) >> (fd % 8)) & 1) !== 0
          ) {
            exceptReady.push(fd);
          }
        }
      }
      return {
        readReady,
        writeReady,
        exceptReady,
      };
    });
  }

  // ---- Networking host imports ----

  #hostNetConnect(
    handle: number,
    addrPtr: KernelPointer,
    addrLen: number,
    port: number,
  ): number {
    if (!this.io.network) return -111; // -ECONNREFUSED
    let addr: Uint8Array;
    try {
      addr = this.#readKernelBytes(addrPtr, addrLen);
    } catch {
      return -14; // EFAULT
    }
    try {
      this.io.network.connect(handle, addr, port);
      return 0;
    } catch {
      return -111; // -ECONNREFUSED
    }
  }

  #hostNetConnectStatus(handle: number): number {
    if (!this.io.network) return -107; // -ENOTCONN
    try {
      // Backend returns positive errno on failure; kernel expects negative.
      const status = this.io.network.connectStatus(handle);
      return status > 0 ? -status : status;
    } catch {
      return -107; // -ENOTCONN
    }
  }

  #hostNetSend(
    handle: number,
    bufPtr: KernelPointer,
    bufLen: number,
    flags: number,
  ): number {
    if (!this.io.network) return -107; // -ENOTCONN
    let data: Uint8Array;
    try {
      data = this.#readKernelBytes(bufPtr, bufLen);
    } catch {
      return -14; // EFAULT
    }
    try {
      const sent = this.io.network.send(handle, data, flags);
      const dataLength = typedArrayByteLength(data);
      return Number.isSafeInteger(sent)
        && sent >= 0
        && sent <= dataLength
        ? sent
        : -5;
    } catch (e: any) {
      if (e?.errno === 11) return -11; // -EAGAIN
      return -32; // -EPIPE
    }
  }

  #hostNetRecv(
    handle: number,
    destination: RustLentKernelDestination,
    flags: number,
  ): number {
    if (!this.io.network) return -107; // -ENOTCONN
    try {
      const produced = this.io.network.recv(
        handle,
        destination.capacity,
        flags,
      );
      let data: Uint8Array;
      try {
        data = intrinsicUint8ArrayView(
          produced,
          "network receive output",
        );
      } catch {
        return -5; // EIO: the backend violated its byte-source contract.
      }
      const dataLength = typedArrayByteLength(data);
      if (dataLength > destination.capacity) {
        return -5; // EIO: backend violated the supplied capacity
      }
      if (dataLength > 0) {
        // Recheck after the backend callback in case memory grew while the
        // Rust import was suspended in host code.
        this.#writeKernelBytes(destination, data);
      }
      return dataLength;
    } catch (e: any) {
      if (e?.errno === 11) return -11; // -EAGAIN
      return -104; // -ECONNRESET
    }
  }

  #hostNetPoll(handle: number, events: number): number {
    const POLLIN = 0x0001;
    const POLLOUT = 0x0004;
    if (!this.io.network) return -107; // -ENOTCONN
    try {
      if (this.io.network.poll) {
        return this.io.network.poll(handle, events);
      }
      return events & (POLLIN | POLLOUT);
    } catch (e: any) {
      if (typeof e?.errno === "number") return -Math.abs(e.errno);
      return -104; // -ECONNRESET
    }
  }

  #hostNetClose(handle: number): number {
    if (!this.io.network) return 0;
    try {
      this.io.network.close(handle);
      return 0;
    } catch {
      return 0;
    }
  }

  #hostNetListen(fd: number, port: number, addrA: number, addrB: number, addrC: number, addrD: number): number {
    if (this.callbacks.onNetListen) {
      return this.callbacks.onNetListen(fd, port, [addrA, addrB, addrC, addrD]);
    }
    return 0;
  }

  #hostUdpBind(handle: number, addrA: number, addrB: number, addrC: number, addrD: number, port: number): number {
    if (!this.callbacks.onUdpBind) return 0;
    return this.callbacks.onUdpBind(handle, [addrA, addrB, addrC, addrD], port);
  }

  #hostUdpUnbind(handle: number): number {
    if (!this.callbacks.onUdpUnbind) return 0;
    return this.callbacks.onUdpUnbind(handle);
  }

  #hostUdpSend(
    srcA: number,
    srcB: number,
    srcC: number,
    srcD: number,
    srcPort: number,
    dstA: number,
    dstB: number,
    dstC: number,
    dstD: number,
    dstPort: number,
    dataPtr: KernelPointer,
    dataLen: number,
  ): number {
    if (!this.io.network?.sendDatagram) return -101; // -ENETUNREACH
    let data: Uint8Array;
    try {
      data = this.#readKernelBytes(dataPtr, dataLen);
    } catch {
      return -14; // EFAULT
    }
    try {
      let srcAddr: Uint8Array<ArrayBufferLike> =
        new IntrinsicUint8Array([srcA, srcB, srcC, srcD]);
      if (
        srcAddr[0] === 0 &&
        srcAddr[1] === 0 &&
        srcAddr[2] === 0 &&
        srcAddr[3] === 0 &&
        this.io.network.localAddress
      ) {
        srcAddr = sliceUint8Array(this.io.network.localAddress);
      }
      const result = this.io.network.sendDatagram({
        srcAddr,
        srcPort,
        dstAddr: new IntrinsicUint8Array([dstA, dstB, dstC, dstD]),
        dstPort,
        data,
      });
      return result === 0 ? dataLen : -result;
    } catch (e: any) {
      if (typeof e?.errno === "number") return -Math.abs(e.errno);
      return -101; // -ENETUNREACH
    }
  }

  #hostGetaddrinfo(
    namePtr: KernelPointer,
    nameLen: number,
    destination: RustLentKernelDestination,
  ): number {
    if (!this.io.network) return -2; // -ENOENT
    try {
      const name = new TextDecoder().decode(
        this.#readKernelBytes(namePtr, nameLen),
      );
      // WHY: EAGAIN is the backend's asynchronous DNS handoff to the kernel
      // retry loop. Keep backend exceptions outside the producer-validation
      // catch so a valid retry signal is not mistaken for hostile bytes.
      const backendAddr = this.io.network.getaddrinfo(name);
      let addr: Uint8Array;
      try {
        addr = intrinsicUint8ArrayView(
          backendAddr,
          "getaddrinfo backend output",
        );
      } catch {
        return -5; // EIO: the backend violated its byte-source contract.
      }
      const addressLength = typedArrayByteLength(addr);
      if (addressLength > destination.capacity) return -22; // -EINVAL
      this.#writeKernelBytes(destination, addr);
      return addressLength;
    } catch (e: any) {
      if (e?.errno === 11) return -11; // -EAGAIN — kernel-worker retries
      return negErrno(e);
    }
  }

  #hostFutexWait(
    addr: KernelPointer,
    expected: number,
    timeoutLo: number,
    timeoutHi: number,
  ): number {
    if (!this.#memory) return -22; // -EINVAL

    let index: number;
    try {
      const range = checkedWasmImportMemoryRange(
        this.#memory,
        addr,
        4,
        this.#kernelPtrWidth,
        "host_futex_wait word",
      );
      if (range.pointer % 4 !== 0) return -22; // EINVAL
      index = range.pointer / 4;
    } catch {
      return -14; // EFAULT
    }
    const i32view = new IntrinsicInt32Array(wasmMemoryBuffer(this.#memory));

    // Reconstruct 64-bit timeout_ns from lo/hi
    const timeoutNs = BigInt(timeoutHi >>> 0) * 0x100000000n + BigInt(timeoutLo >>> 0);
    // Convert to signed
    const signed = BigInt.asIntN(64, timeoutNs);

    let timeoutMs: number | undefined;
    if (signed >= 0n) {
      // Convert ns → ms (rounding up to at least 1ms if nonzero)
      timeoutMs = Number(signed / 1_000_000n);
      if (timeoutMs === 0 && signed > 0n) timeoutMs = 1;
    }
    // signed < 0 → infinite wait (undefined timeout)

    let result: "ok" | "not-equal" | "timed-out";
    try {
      result = intrinsicApply(
        intrinsicAtomicsWait,
        Atomics,
        [i32view, index, expected, timeoutMs],
      ) as "ok" | "not-equal" | "timed-out";
    } catch {
      return -22; // EINVAL: memory was not shared or became unusable
    }
    if (result === "timed-out") {
      return -110; // -ETIMEDOUT
    }
    if (result === "not-equal") return -11;  // -EAGAIN
    return 0; // "ok"
  }

  #hostFutexWake(addr: KernelPointer, count: number): number {
    if (!this.#memory) return 0;
    let index: number;
    try {
      const range = checkedWasmImportMemoryRange(
        this.#memory,
        addr,
        4,
        this.#kernelPtrWidth,
        "host_futex_wake word",
      );
      if (range.pointer % 4 !== 0) return -22; // EINVAL
      index = range.pointer / 4;
    } catch {
      return -14; // EFAULT
    }
    const i32view = new IntrinsicInt32Array(wasmMemoryBuffer(this.#memory));
    try {
      return intrinsicApply(
        intrinsicAtomicsNotify,
        Atomics,
        [i32view, index, count],
      ) as number;
    } catch {
      return -22; // EINVAL
    }
  }

}
