/**
 * Capacity-carrying views of kernel-owned WebAssembly scratch allocations.
 *
 * A pointer being inside WebAssembly.Memory proves only that the host can
 * address those bytes. It does not prove that the allocator gave those bytes
 * to this caller. Keep the allocation's capacity beside its pointer and check
 * both facts independently for every transfer.
 */

import {
  checkedWasmGuestPointerOffset,
} from "./wasm-guest-pointer";
import {
  invokeKernelEntryScopedOperation,
  type KernelVoidIngressScope,
  validatedKernelEntryCallable,
  validateKernelEntryMemoryOwnership,
  validateKernelEntryGatedInstance,
  validateKernelScratchAllocatorOwnership,
} from "./kernel-entry-gate";

export type WasmPointer = number | bigint;
export type WasmPointerWidth = 4 | 8;

const WASM32_MAX_POINTER = 0xffff_ffff;
const HOST_MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;
// WHY: scratch leases can cross arbitrary host callbacks even though they
// cannot cross an await. Capture every byte-access intrinsic before those
// callbacks can replace a prototype method and turn a detached copy back into
// a live kernel-memory alias.
const IntrinsicUint8Array = Uint8Array;
const IntrinsicDataView = DataView;
const IntrinsicBigInt = BigInt;
const IntrinsicNumber = Number;
const intrinsicApply = Reflect.apply;
const intrinsicMathFloor = Math.floor;
const intrinsicNumberIsInteger = Number.isInteger;
const intrinsicNumberIsSafeInteger = Number.isSafeInteger;
const intrinsicUint8ArraySet = IntrinsicUint8Array.prototype.set;
const intrinsicUint8ArrayFill = IntrinsicUint8Array.prototype.fill;
const intrinsicObjectCreate = Object.create;
const intrinsicObjectDefineProperty = Object.defineProperty;
const intrinsicObjectFreeze = Object.freeze;
const intrinsicObjectGetOwnPropertyDescriptor =
  Object.getOwnPropertyDescriptor;
const intrinsicWeakMapGet = WeakMap.prototype.get;
const intrinsicWeakMapSet = WeakMap.prototype.set;
const intrinsicMemoryBuffer = intrinsicObjectGetOwnPropertyDescriptor(
  WebAssembly.Memory.prototype,
  "buffer",
)!.get!;
const intrinsicArrayBufferByteLength =
  intrinsicObjectGetOwnPropertyDescriptor(
    ArrayBuffer.prototype,
    "byteLength",
  )!.get!;
const intrinsicSharedArrayBufferByteLength =
  typeof SharedArrayBuffer === "undefined"
    ? null
    : intrinsicObjectGetOwnPropertyDescriptor(
      SharedArrayBuffer.prototype,
      "byteLength",
    )!.get!;
type IntrinsicBufferByteLengthGetter = (
  this: ArrayBufferLike,
) => number;
const intrinsicBufferByteLengthGetters = new WeakMap<
  object,
  IntrinsicBufferByteLengthGetter
>();
const intrinsicDataViewPrototype = IntrinsicDataView.prototype;
const intrinsicDataViewByteLength = intrinsicObjectGetOwnPropertyDescriptor(
  intrinsicDataViewPrototype,
  "byteLength",
)!.get!;
const intrinsicDataViewGetBigInt64 = intrinsicDataViewPrototype.getBigInt64;
const intrinsicDataViewGetBigUint64 = intrinsicDataViewPrototype.getBigUint64;
const intrinsicDataViewGetFloat32 = intrinsicDataViewPrototype.getFloat32;
const intrinsicDataViewGetFloat64 = intrinsicDataViewPrototype.getFloat64;
const intrinsicDataViewGetInt8 = intrinsicDataViewPrototype.getInt8;
const intrinsicDataViewGetInt16 = intrinsicDataViewPrototype.getInt16;
const intrinsicDataViewGetInt32 = intrinsicDataViewPrototype.getInt32;
const intrinsicDataViewGetUint8 = intrinsicDataViewPrototype.getUint8;
const intrinsicDataViewGetUint16 = intrinsicDataViewPrototype.getUint16;
const intrinsicDataViewGetUint32 = intrinsicDataViewPrototype.getUint32;
const intrinsicDataViewSetBigInt64 = intrinsicDataViewPrototype.setBigInt64;
const intrinsicDataViewSetBigUint64 = intrinsicDataViewPrototype.setBigUint64;
const intrinsicDataViewSetFloat32 = intrinsicDataViewPrototype.setFloat32;
const intrinsicDataViewSetFloat64 = intrinsicDataViewPrototype.setFloat64;
const intrinsicDataViewSetInt8 = intrinsicDataViewPrototype.setInt8;
const intrinsicDataViewSetInt16 = intrinsicDataViewPrototype.setInt16;
const intrinsicDataViewSetInt32 = intrinsicDataViewPrototype.setInt32;
const intrinsicDataViewSetUint8 = intrinsicDataViewPrototype.setUint8;
const intrinsicDataViewSetUint16 = intrinsicDataViewPrototype.setUint16;
const intrinsicDataViewSetUint32 = intrinsicDataViewPrototype.setUint32;
const typedArrayPrototype = Object.getPrototypeOf(
  IntrinsicUint8Array.prototype,
);
const typedArrayBuffer = intrinsicObjectGetOwnPropertyDescriptor(
  typedArrayPrototype,
  "buffer",
)!.get!;
const typedArrayByteOffset = intrinsicObjectGetOwnPropertyDescriptor(
  typedArrayPrototype,
  "byteOffset",
)!.get!;
const typedArrayByteLength = intrinsicObjectGetOwnPropertyDescriptor(
  typedArrayPrototype,
  "byteLength",
)!.get!;

/**
 * Kernel exports whose execution may borrow one active scratch lease.
 *
 * WHY: this is deliberately a narrow lifetime allowlist, not a list of every
 * kernel export. Each Rust implementation was reviewed to consume or copy its
 * borrowed bytes before returning. `kernel_handle_channel` scopes its raw
 * mailbox view to decoding/publishing and clears the active task binding;
 * `kernel_spawn_process` parses the complete blob into owned Rust values
 * before it enters process-table or host work; and
 * `kernel_process_metadata_stage` copies one complete entry into a token-owned
 * Rust vector before returning; both executable-target prepare exports copy
 * the path before returning. The transfer execute export names no raw pointer,
 * but its token authorizes Rust to borrow the allocation represented by this
 * exact lease. Adding a name requires the same lifetime review and a pointer-
 * position update below.
 */
/** @internal Exported only for the Rust/host semantic-role drift contract. */
export const KERNEL_SCRATCH_EXPORT_NAMES = intrinsicObjectFreeze([
  "kernel_dequeue_signal",
  "kernel_drain_audio",
  "kernel_drain_wakeup_events",
  "kernel_enum_procs",
  "kernel_enumerate_host_handles",
  "kernel_exec_target_prepare",
  "kernel_exec_target_read",
  "kernel_get_cwd",
  "kernel_get_dirfd_path",
  "kernel_get_fd_path",
  "kernel_getrusage",
  "kernel_getsockopt",
  "kernel_handle_channel",
  "kernel_inject_datagram",
  "kernel_ioctl",
  "kernel_ipc_shm_read_chunk",
  "kernel_ipc_shm_write_chunk",
  "kernel_mq_drain_notification",
  "kernel_pipe2",
  "kernel_pipe_read",
  "kernel_pipe_write",
  "kernel_pick_tcp_listener_target",
  "kernel_poll",
  "kernel_process_metadata_stage",
  "kernel_pty_master_read",
  "kernel_pty_master_write",
  "kernel_read_proc_maps",
  "kernel_recv",
  "kernel_select",
  "kernel_send",
  "kernel_set_cwd",
  "kernel_setsockopt",
  "kernel_socketpair",
  "kernel_spawn_exec_target_prepare",
  "kernel_spawn_process",
  "kernel_take_process_timer_cleanup",
  "kernel_tcgetattr",
  "kernel_tcsetattr",
  "kernel_transfer_channel_execute",
  "kernel_transfer_io_execute",
  "kernel_truncate",
  "kernel_uname",
  "kernel_wait_child_poll",
] as const);

export type KernelScratchExportName =
  (typeof KERNEL_SCRATCH_EXPORT_NAMES)[number];

declare const kernelScratchExportPointerBrand: unique symbol;

/**
 * Opaque relative range substituted with a primitive pointer only inside the
 * exact bound WebAssembly export call.
 */
export interface KernelScratchExportPointer {
  readonly [kernelScratchExportPointerBrand]: never;
}

interface KernelScratchExportPointerRecord {
  readonly lease: ActiveKernelScratchLease;
  readonly offset: number;
  readonly length: number;
}

const kernelScratchExportPointers = new WeakMap<
  object,
  KernelScratchExportPointerRecord
>();

type KernelScratchExportFunction = (...args: never[]) => unknown;
interface KernelScratchExportBinding {
  readonly call: KernelScratchExportFunction;
  readonly argumentCount: number;
  readonly instance: WebAssembly.Instance;
}
type KernelScratchExportSnapshot = Readonly<
  Partial<Record<KernelScratchExportName, KernelScratchExportBinding>>
>;

const REQUIRED_POINTER_0 = intrinsicObjectFreeze([0] as const);
const REQUIRED_POINTER_1 = intrinsicObjectFreeze([1] as const);
const REQUIRED_POINTER_2 = intrinsicObjectFreeze([2] as const);
const REQUIRED_POINTER_3 = intrinsicObjectFreeze([3] as const);
const REQUIRED_POINTER_3_5 = intrinsicObjectFreeze([3, 5] as const);
const REQUIRED_POINTER_4 = intrinsicObjectFreeze([4] as const);
const REQUIRED_POINTER_5 = intrinsicObjectFreeze([5] as const);
const REQUIRED_POINTER_11 = intrinsicObjectFreeze([11] as const);
const NULLABLE_POINTER_1_3_5 = intrinsicObjectFreeze([1, 3, 5] as const);

/** @internal Exported only for the Rust/host semantic-role drift contract. */
export function kernelScratchRequiredPointerArguments(
  name: KernelScratchExportName,
): readonly number[] {
  switch (name) {
    case "kernel_drain_audio":
    case "kernel_drain_wakeup_events":
    case "kernel_enum_procs":
    case "kernel_enumerate_host_handles":
    case "kernel_handle_channel":
    case "kernel_mq_drain_notification":
    case "kernel_poll":
    case "kernel_truncate":
    case "kernel_uname":
      return REQUIRED_POINTER_0;
    case "kernel_get_cwd":
    case "kernel_getrusage":
    case "kernel_pipe2":
    case "kernel_pty_master_read":
    case "kernel_pty_master_write":
    case "kernel_read_proc_maps":
    case "kernel_recv":
    case "kernel_send":
    case "kernel_set_cwd":
    case "kernel_take_process_timer_cleanup":
    case "kernel_tcgetattr":
      return REQUIRED_POINTER_1;
    case "kernel_dequeue_signal":
    case "kernel_get_dirfd_path":
    case "kernel_get_fd_path":
    case "kernel_ioctl":
    case "kernel_ipc_shm_read_chunk":
    case "kernel_ipc_shm_write_chunk":
    case "kernel_pipe_read":
    case "kernel_pipe_write":
    case "kernel_pick_tcp_listener_target":
    case "kernel_spawn_exec_target_prepare":
    case "kernel_spawn_process":
    case "kernel_tcsetattr":
      return REQUIRED_POINTER_2;
    case "kernel_process_metadata_stage":
    case "kernel_exec_target_prepare":
    case "kernel_setsockopt":
    case "kernel_socketpair":
      return REQUIRED_POINTER_3;
    case "kernel_exec_target_read":
      return REQUIRED_POINTER_4;
    case "kernel_getsockopt":
      return REQUIRED_POINTER_3_5;
    case "kernel_wait_child_poll":
      return REQUIRED_POINTER_5;
    case "kernel_inject_datagram":
      return REQUIRED_POINTER_11;
    case "kernel_transfer_channel_execute":
    case "kernel_transfer_io_execute":
    case "kernel_select":
      return [];
  }
}

/** @internal Exported only for the Rust/host semantic-role drift contract. */
export function kernelScratchNullablePointerArguments(
  name: KernelScratchExportName,
): readonly number[] {
  return name === "kernel_select" ? NULLABLE_POINTER_1_3_5 : [];
}

function kernelScratchPointerAlignment(
  name: KernelScratchExportName,
  pointerIndex: number,
): number {
  if (
    (name === "kernel_pipe2" && pointerIndex === 1)
    || (name === "kernel_pick_tcp_listener_target" && pointerIndex === 2)
    || (name === "kernel_poll" && pointerIndex === 0)
    || (name === "kernel_socketpair" && pointerIndex === 3)
    || (name === "kernel_take_process_timer_cleanup" && pointerIndex === 1)
  ) {
    return 4;
  }
  return 1;
}

function isKernelScratchExportName(
  value: string,
): value is KernelScratchExportName {
  switch (value) {
    case "kernel_dequeue_signal":
    case "kernel_drain_audio":
    case "kernel_drain_wakeup_events":
    case "kernel_enum_procs":
    case "kernel_enumerate_host_handles":
    case "kernel_exec_target_prepare":
    case "kernel_exec_target_read":
    case "kernel_get_cwd":
    case "kernel_get_dirfd_path":
    case "kernel_get_fd_path":
    case "kernel_getrusage":
    case "kernel_getsockopt":
    case "kernel_handle_channel":
    case "kernel_inject_datagram":
    case "kernel_ioctl":
    case "kernel_ipc_shm_read_chunk":
    case "kernel_ipc_shm_write_chunk":
    case "kernel_mq_drain_notification":
    case "kernel_pipe2":
    case "kernel_pipe_read":
    case "kernel_pipe_write":
    case "kernel_pick_tcp_listener_target":
    case "kernel_poll":
    case "kernel_process_metadata_stage":
    case "kernel_pty_master_read":
    case "kernel_pty_master_write":
    case "kernel_read_proc_maps":
    case "kernel_recv":
    case "kernel_select":
    case "kernel_send":
    case "kernel_set_cwd":
    case "kernel_setsockopt":
    case "kernel_socketpair":
    case "kernel_spawn_exec_target_prepare":
    case "kernel_spawn_process":
    case "kernel_take_process_timer_cleanup":
    case "kernel_tcgetattr":
    case "kernel_tcsetattr":
    case "kernel_transfer_channel_execute":
    case "kernel_transfer_io_execute":
    case "kernel_truncate":
    case "kernel_uname":
    case "kernel_wait_child_poll":
      return true;
    default:
      return false;
  }
}

function snapshotKernelScratchExports(
  instance: WebAssembly.Instance,
  memory: WebAssembly.Memory,
  label: string,
  expectedAllocator?: KernelScratchAllocator,
  allocatorInstance: WebAssembly.Instance = instance,
): KernelScratchExportSnapshot {
  try {
    validateKernelEntryMemoryOwnership(instance, memory);
  } catch {
    throw new KernelScratchError(
      `${label} export binding does not own the supplied WebAssembly.Memory`,
    );
  }
  if (expectedAllocator !== undefined) {
    try {
      validateKernelScratchAllocatorOwnership(
        instance,
        allocatorInstance,
        expectedAllocator,
      );
    } catch {
      throw new KernelScratchError(
        `${label} allocator is not the bound instance's kernel allocator`,
      );
    }
  }
  const snapshot = intrinsicObjectCreate(null) as Partial<
    Record<KernelScratchExportName, KernelScratchExportBinding>
  >;
  for (let index = 0; index < KERNEL_SCRATCH_EXPORT_NAMES.length; index++) {
    const name = KERNEL_SCRATCH_EXPORT_NAMES[index];
    const binding = validatedKernelEntryCallable(instance, name);
    if (binding !== undefined) {
      snapshot[name] = intrinsicObjectFreeze({
        call: binding.call as KernelScratchExportFunction,
        argumentCount: binding.argumentCount,
        instance,
      });
    }
  }
  return intrinsicObjectFreeze(snapshot);
}

export class KernelScratchError extends Error {
  constructor(
    message: string,
    readonly errno = 14,
  ) {
    super(message);
    this.name = "KernelScratchError";
  }
}

function intrinsicWasmMemoryBuffer(
  memory: WebAssembly.Memory,
  field: string,
): ArrayBufferLike {
  try {
    // WHY: `Memory.prototype.buffer` is mutable JavaScript state. Invoke the
    // captured intrinsic getter both to prove that `memory` is genuine and to
    // prevent a callback from substituting a larger fake buffer for the
    // current-memory bound.
    return intrinsicApply(
      intrinsicMemoryBuffer,
      memory,
      [],
    ) as ArrayBufferLike;
  } catch {
    throw new KernelScratchError(
      `${field} does not use a genuine WebAssembly.Memory`,
    );
  }
}

function intrinsicBufferByteLength(
  buffer: ArrayBufferLike,
  field: string,
): number {
  const cachedGetter = intrinsicApply(
    intrinsicWeakMapGet,
    intrinsicBufferByteLengthGetters,
    [buffer],
  ) as IntrinsicBufferByteLengthGetter | undefined;
  if (cachedGetter !== undefined) {
    // WHY: cache only the proven intrinsic, never its result. Growable memory
    // still needs a live length read, while a shared buffer must not throw
    // through the ArrayBuffer getter on every scratch-range check.
    return intrinsicApply(cachedGetter, buffer, []) as number;
  }
  try {
    const byteLength = intrinsicApply(
      intrinsicArrayBufferByteLength,
      buffer,
      [],
    ) as number;
    intrinsicApply(
      intrinsicWeakMapSet,
      intrinsicBufferByteLengthGetters,
      [buffer, intrinsicArrayBufferByteLength],
    );
    return byteLength;
  } catch {
    if (intrinsicSharedArrayBufferByteLength !== null) {
      try {
        const byteLength = intrinsicApply(
          intrinsicSharedArrayBufferByteLength,
          buffer,
          [],
        ) as number;
        intrinsicApply(
          intrinsicWeakMapSet,
          intrinsicBufferByteLengthGetters,
          [buffer, intrinsicSharedArrayBufferByteLength],
        );
        return byteLength;
      } catch {
        // Fall through to the one checked error below.
      }
    }
    throw new KernelScratchError(
      `${field} WebAssembly.Memory has an invalid buffer`,
    );
  }
}

export interface CheckedMemoryRange {
  pointer: number;
  length: number;
  end: number;
}

function intrinsicUint8ArraySpan(
  value: Uint8Array,
  field: string,
): {
  buffer: ArrayBufferLike;
  byteOffset: number;
  byteLength: number;
} {
  try {
    return {
      buffer: intrinsicApply(
        typedArrayBuffer,
        value,
        [],
      ) as ArrayBufferLike,
      byteOffset: intrinsicApply(
        typedArrayByteOffset,
        value,
        [],
      ) as number,
      byteLength: intrinsicApply(
        typedArrayByteLength,
        value,
        [],
      ) as number,
    };
  } catch {
    throw new KernelScratchError(`${field} is not a genuine Uint8Array`);
  }
}

/**
 * Return a base-class view over the exact intrinsic bytes of a Uint8Array.
 *
 * WHY: a subclass can override `byteLength`, `length`, or `subarray` while
 * native TypedArray#set still consumes its real internal span. Producers at a
 * host boundary must therefore be normalized before their size is trusted or
 * their bytes are copied into an owned kernel allocation.
 */
export function intrinsicUint8ArrayView(
  value: Uint8Array,
  field: string,
): Uint8Array {
  const span = intrinsicUint8ArraySpan(value, field);
  return new IntrinsicUint8Array(
    span.buffer,
    span.byteOffset,
    span.byteLength,
  );
}

export interface KernelScratchDataView {
  readonly byteLength: number;
  getBigInt64(byteOffset: number, littleEndian?: boolean): bigint;
  getBigUint64(byteOffset: number, littleEndian?: boolean): bigint;
  getFloat32(byteOffset: number, littleEndian?: boolean): number;
  getFloat64(byteOffset: number, littleEndian?: boolean): number;
  getInt8(byteOffset: number): number;
  getInt16(byteOffset: number, littleEndian?: boolean): number;
  getInt32(byteOffset: number, littleEndian?: boolean): number;
  getUint8(byteOffset: number): number;
  getUint16(byteOffset: number, littleEndian?: boolean): number;
  getUint32(byteOffset: number, littleEndian?: boolean): number;
  setBigInt64(
    byteOffset: number,
    value: bigint,
    littleEndian?: boolean,
  ): void;
  setBigUint64(
    byteOffset: number,
    value: bigint,
    littleEndian?: boolean,
  ): void;
  setFloat32(
    byteOffset: number,
    value: number,
    littleEndian?: boolean,
  ): void;
  setFloat64(
    byteOffset: number,
    value: number,
    littleEndian?: boolean,
  ): void;
  setInt8(byteOffset: number, value: number): void;
  setInt16(
    byteOffset: number,
    value: number,
    littleEndian?: boolean,
  ): void;
  setInt32(
    byteOffset: number,
    value: number,
    littleEndian?: boolean,
  ): void;
  setUint8(byteOffset: number, value: number): void;
  setUint16(
    byteOffset: number,
    value: number,
    littleEndian?: boolean,
  ): void;
  setUint32(
    byteOffset: number,
    value: number,
    littleEndian?: boolean,
  ): void;
}

/**
 * DataView-shaped access that remains tied to one active scratch lease.
 *
 * A native DataView cannot be revoked after it escapes a callback, so it stays
 * private behind methods that assert the lease on every access. Reuse is safe
 * only while WebAssembly.Memory exposes the same buffer; memory.grow() replaces
 * that buffer and forces a checked refresh before the next access.
 */
const activeKernelScratchDataViewConstructorKey =
  intrinsicObjectFreeze(intrinsicObjectCreate(null) as object);

class ActiveKernelScratchDataView implements KernelScratchDataView {
  #activeMemoryBuffer: () => ArrayBufferLike;
  #assertReadable: (byteOffset: number, byteLength: number) => void;
  #assertWritable: (byteOffset: number, byteLength: number) => void;
  #refreshView: () => {
    buffer: ArrayBufferLike;
    view: DataView;
  };
  #cachedBuffer: ArrayBufferLike;
  #cachedView: DataView;

  constructor(
    constructorKey: object,
    activeMemoryBuffer: () => ArrayBufferLike,
    assertReadable: (
      byteOffset: number,
      byteLength: number,
    ) => void,
    assertWritable: (
      byteOffset: number,
      byteLength: number,
    ) => void,
    refreshView: () => {
      buffer: ArrayBufferLike;
      view: DataView;
    },
  ) {
    if (constructorKey !== activeKernelScratchDataViewConstructorKey) {
      throw new KernelScratchError(
        "kernel scratch DataView cannot be constructed outside its lease",
      );
    }
    this.#activeMemoryBuffer = activeMemoryBuffer;
    this.#assertReadable = assertReadable;
    this.#assertWritable = assertWritable;
    this.#refreshView = refreshView;
    const initial = refreshView();
    this.#cachedBuffer = initial.buffer;
    this.#cachedView = initial.view;
    intrinsicObjectFreeze(this);
  }

  #currentView(): DataView {
    // WHY: checking the lease even on a cache hit is what makes an escaped
    // wrapper revocable. Returning the cached native view directly would let
    // callers use scratch bytes after a later operation had replaced them.
    const buffer = this.#activeMemoryBuffer();
    if (buffer !== this.#cachedBuffer) {
      // WHY: WebAssembly memory growth replaces the exposed buffer. Repeat the
      // full allocation-capacity and current-memory proof before caching a view
      // over the replacement instead of assuming total memory size is enough.
      const refreshed = this.#refreshView();
      this.#cachedBuffer = refreshed.buffer;
      this.#cachedView = refreshed.view;
    }
    return this.#cachedView;
  }

  #readableView(byteOffset: number, byteLength: number): DataView {
    this.#assertReadable(byteOffset, byteLength);
    return this.#currentView();
  }

  #writableView(byteOffset: number, byteLength: number): DataView {
    this.#assertWritable(byteOffset, byteLength);
    return this.#currentView();
  }

  get byteLength(): number {
    return intrinsicApply(
      intrinsicDataViewByteLength,
      this.#currentView(),
      [],
    ) as number;
  }

  getBigInt64(byteOffset: number, littleEndian?: boolean): bigint {
    return intrinsicApply(
      intrinsicDataViewGetBigInt64,
      this.#readableView(byteOffset, 8),
      [byteOffset, littleEndian],
    ) as bigint;
  }

  getBigUint64(byteOffset: number, littleEndian?: boolean): bigint {
    return intrinsicApply(
      intrinsicDataViewGetBigUint64,
      this.#readableView(byteOffset, 8),
      [byteOffset, littleEndian],
    ) as bigint;
  }

  getFloat32(byteOffset: number, littleEndian?: boolean): number {
    return intrinsicApply(
      intrinsicDataViewGetFloat32,
      this.#readableView(byteOffset, 4),
      [byteOffset, littleEndian],
    ) as number;
  }

  getFloat64(byteOffset: number, littleEndian?: boolean): number {
    return intrinsicApply(
      intrinsicDataViewGetFloat64,
      this.#readableView(byteOffset, 8),
      [byteOffset, littleEndian],
    ) as number;
  }

  getInt8(byteOffset: number): number {
    return intrinsicApply(
      intrinsicDataViewGetInt8,
      this.#readableView(byteOffset, 1),
      [byteOffset],
    ) as number;
  }

  getInt16(byteOffset: number, littleEndian?: boolean): number {
    return intrinsicApply(
      intrinsicDataViewGetInt16,
      this.#readableView(byteOffset, 2),
      [byteOffset, littleEndian],
    ) as number;
  }

  getInt32(byteOffset: number, littleEndian?: boolean): number {
    return intrinsicApply(
      intrinsicDataViewGetInt32,
      this.#readableView(byteOffset, 4),
      [byteOffset, littleEndian],
    ) as number;
  }

  getUint8(byteOffset: number): number {
    return intrinsicApply(
      intrinsicDataViewGetUint8,
      this.#readableView(byteOffset, 1),
      [byteOffset],
    ) as number;
  }

  getUint16(byteOffset: number, littleEndian?: boolean): number {
    return intrinsicApply(
      intrinsicDataViewGetUint16,
      this.#readableView(byteOffset, 2),
      [byteOffset, littleEndian],
    ) as number;
  }

  getUint32(byteOffset: number, littleEndian?: boolean): number {
    return intrinsicApply(
      intrinsicDataViewGetUint32,
      this.#readableView(byteOffset, 4),
      [byteOffset, littleEndian],
    ) as number;
  }

  setBigInt64(
    byteOffset: number,
    value: bigint,
    littleEndian?: boolean,
  ): void {
    if (typeof value !== "bigint") {
      throw new KernelScratchError(
        "kernel scratch DataView bigint value must be a primitive bigint",
      );
    }
    intrinsicApply(
      intrinsicDataViewSetBigInt64,
      this.#writableView(byteOffset, 8),
      [byteOffset, value, littleEndian],
    );
  }

  setBigUint64(
    byteOffset: number,
    value: bigint,
    littleEndian?: boolean,
  ): void {
    if (typeof value !== "bigint") {
      throw new KernelScratchError(
        "kernel scratch DataView bigint value must be a primitive bigint",
      );
    }
    intrinsicApply(
      intrinsicDataViewSetBigUint64,
      this.#writableView(byteOffset, 8),
      [byteOffset, value, littleEndian],
    );
  }

  setFloat32(
    byteOffset: number,
    value: number,
    littleEndian?: boolean,
  ): void {
    if (typeof value !== "number") {
      throw new KernelScratchError(
        "kernel scratch DataView number value must be a primitive number",
      );
    }
    intrinsicApply(
      intrinsicDataViewSetFloat32,
      this.#writableView(byteOffset, 4),
      [byteOffset, value, littleEndian],
    );
  }

  setFloat64(
    byteOffset: number,
    value: number,
    littleEndian?: boolean,
  ): void {
    if (typeof value !== "number") {
      throw new KernelScratchError(
        "kernel scratch DataView number value must be a primitive number",
      );
    }
    intrinsicApply(
      intrinsicDataViewSetFloat64,
      this.#writableView(byteOffset, 8),
      [byteOffset, value, littleEndian],
    );
  }

  setInt8(byteOffset: number, value: number): void {
    if (typeof value !== "number") {
      throw new KernelScratchError(
        "kernel scratch DataView number value must be a primitive number",
      );
    }
    intrinsicApply(
      intrinsicDataViewSetInt8,
      this.#writableView(byteOffset, 1),
      [byteOffset, value],
    );
  }

  setInt16(
    byteOffset: number,
    value: number,
    littleEndian?: boolean,
  ): void {
    if (typeof value !== "number") {
      throw new KernelScratchError(
        "kernel scratch DataView number value must be a primitive number",
      );
    }
    intrinsicApply(
      intrinsicDataViewSetInt16,
      this.#writableView(byteOffset, 2),
      [byteOffset, value, littleEndian],
    );
  }

  setInt32(
    byteOffset: number,
    value: number,
    littleEndian?: boolean,
  ): void {
    if (typeof value !== "number") {
      throw new KernelScratchError(
        "kernel scratch DataView number value must be a primitive number",
      );
    }
    intrinsicApply(
      intrinsicDataViewSetInt32,
      this.#writableView(byteOffset, 4),
      [byteOffset, value, littleEndian],
    );
  }

  setUint8(byteOffset: number, value: number): void {
    if (typeof value !== "number") {
      throw new KernelScratchError(
        "kernel scratch DataView number value must be a primitive number",
      );
    }
    intrinsicApply(
      intrinsicDataViewSetUint8,
      this.#writableView(byteOffset, 1),
      [byteOffset, value],
    );
  }

  setUint16(
    byteOffset: number,
    value: number,
    littleEndian?: boolean,
  ): void {
    if (typeof value !== "number") {
      throw new KernelScratchError(
        "kernel scratch DataView number value must be a primitive number",
      );
    }
    intrinsicApply(
      intrinsicDataViewSetUint16,
      this.#writableView(byteOffset, 2),
      [byteOffset, value, littleEndian],
    );
  }

  setUint32(
    byteOffset: number,
    value: number,
    littleEndian?: boolean,
  ): void {
    if (typeof value !== "number") {
      throw new KernelScratchError(
        "kernel scratch DataView number value must be a primitive number",
      );
    }
    intrinsicApply(
      intrinsicDataViewSetUint32,
      this.#writableView(byteOffset, 4),
      [byteOffset, value, littleEndian],
    );
  }
}

intrinsicObjectFreeze(ActiveKernelScratchDataView.prototype);
intrinsicObjectFreeze(ActiveKernelScratchDataView);

function exactNonNegativeInteger(
  value: number | bigint,
  field: string,
): number {
  if (typeof value === "bigint") {
    if (value < 0n || value > IntrinsicBigInt(HOST_MAX_SAFE_INTEGER)) {
      throw new KernelScratchError(
        `${field} is not losslessly representable as a host memory index`,
      );
    }
    return IntrinsicNumber(value);
  }
  if (!intrinsicNumberIsSafeInteger(value) || value < 0) {
    throw new KernelScratchError(
      `${field} must be a non-negative safe integer`,
    );
  }
  return value;
}

function exactPointer(
  value: WasmPointer,
  pointerWidth: WasmPointerWidth,
  field: string,
): number {
  if (pointerWidth !== 4 && pointerWidth !== 8) {
    throw new KernelScratchError(
      `${field} pointer width must be exactly 4 or 8`,
    );
  }
  const pointer = exactNonNegativeInteger(value, field);
  if (pointerWidth === 4 && pointer > WASM32_MAX_POINTER) {
    throw new KernelScratchError(`${field} does not fit a wasm32 pointer`);
  }
  return pointer;
}

/**
 * Normalize a raw `usize` returned by a kernel Wasm export.
 *
 * WebAssembly exposes an i32 result to JavaScript as a signed number even
 * though a wasm32 pointer uses the same 32 bits as an unsigned address. Keep
 * this normalization confined to allocator/export results: caller-supplied
 * negative pointers remain invalid everywhere else.
 */
export function checkedKernelExportPointer(
  value: WasmPointer,
  pointerWidth: WasmPointerWidth,
  field: string,
): number {
  if (pointerWidth === 4 && typeof value === "number" && value < 0) {
    if (!intrinsicNumberIsInteger(value) || value < -0x8000_0000) {
      throw new KernelScratchError(
        `${field} is not a valid wasm32 export result`,
      );
    }
    return exactPointer(value + 0x1_0000_0000, pointerWidth, field);
  }
  return exactPointer(value, pointerWidth, field);
}

export function checkedWasmPointer(
  value: WasmPointer,
  pointerWidth: WasmPointerWidth,
  field: string,
): number {
  return exactPointer(value, pointerWidth, field);
}

/**
 * Validate a half-open address range against a guest pointer domain.
 *
 * This is deliberately separate from `checkedMemoryRange`: address-space
 * reservations may precede `memory.grow`, while a host byte transfer must
 * additionally fit the current Memory buffer. Length is pointer-sized because
 * the kernel reservation ABI transports it as `usize`.
 */
export function checkedWasmAddressRange(
  pointerValue: WasmPointer,
  lengthValue: WasmPointer,
  pointerWidth: WasmPointerWidth,
  field: string,
): CheckedMemoryRange {
  const pointer = checkedWasmPointer(
    pointerValue,
    pointerWidth,
    `${field} pointer`,
  );
  const length = checkedWasmPointer(
    lengthValue,
    pointerWidth,
    `${field} length`,
  );
  const end = pointer + length;
  const exclusiveLimit = pointerWidth === 4
    ? 0x1_0000_0000
    : HOST_MAX_SAFE_INTEGER;
  if (
    !intrinsicNumberIsSafeInteger(end)
    || end < pointer
    || end > exclusiveLimit
  ) {
    throw new KernelScratchError(
      `${field} is outside the wasm${pointerWidth * 8} address range`,
    );
  }
  return { pointer, length, end };
}

function checkedRange(
  pointer: number,
  length: number,
  limit: number,
  field: string,
): CheckedMemoryRange {
  if (!intrinsicNumberIsSafeInteger(limit) || limit < 0) {
    throw new KernelScratchError(`${field} has an invalid range limit`);
  }
  const end = pointer + length;
  if (!intrinsicNumberIsSafeInteger(end) || end < pointer || end > limit) {
    throw new KernelScratchError(`${field} is outside its owned range`);
  }
  return { pointer, length, end };
}

/**
 * Validate a pointer/length pair against the current WebAssembly.Memory
 * buffer.
 *
 * Wasm linear-memory address zero is caller-addressable, even though a zero
 * returned by a kernel allocator means allocation failure. Keep that
 * distinction explicit at the call site instead of teaching range checks that
 * every address zero is a failed allocation.
 */
export function checkedMemoryRange(
  memory: WebAssembly.Memory,
  pointerValue: WasmPointer,
  lengthValue: number | bigint,
  pointerWidth: WasmPointerWidth,
  field: string,
  allowAddressZero = false,
): CheckedMemoryRange {
  const pointer = exactPointer(pointerValue, pointerWidth, `${field} pointer`);
  const length = exactNonNegativeInteger(lengthValue, `${field} length`);
  if (!allowAddressZero && pointer === 0 && length !== 0) {
    throw new KernelScratchError(`${field} uses a null pointer`);
  }
  const buffer = intrinsicWasmMemoryBuffer(memory, field);
  return checkedRange(
    pointer,
    length,
    intrinsicBufferByteLength(buffer, field),
    field,
  );
}

/**
 * Validate a raw pointer delivered by a WebAssembly import.
 *
 * Unlike already-normalized channel values, a memory32 pointer reaches
 * JavaScript as a signed i32. Normalize those exact bits first, then perform
 * the ordinary null, length, overflow, and current-memory checks.
 */
export function checkedWasmImportMemoryRange(
  memory: WebAssembly.Memory,
  pointerValue: WasmPointer,
  lengthValue: number | bigint,
  pointerWidth: WasmPointerWidth,
  field: string,
  allowAddressZero = false,
): CheckedMemoryRange {
  let pointer: number;
  try {
    pointer = checkedWasmGuestPointerOffset(
      pointerValue,
      pointerWidth,
      `${field} pointer`,
    );
  } catch (error) {
    throw new KernelScratchError(
      `${field} has an invalid raw WebAssembly pointer: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  return checkedMemoryRange(
    memory,
    pointer,
    lengthValue,
    pointerWidth,
    field,
    allowAddressZero,
  );
}

export type KernelScratchAllocator = (capacity: number) => WasmPointer;
export interface KernelScratchReservation {
  pointer: WasmPointer;
  capacity: number | bigint;
}
export type KernelScratchReserver = (
  minimumCapacity: number,
) => KernelScratchReservation;

export interface KernelScratchLease {
  /**
   * Prove that one range belongs to this allocation without exposing its
   * primitive address.
   */
  assertRange(offset: number, length: number): void;
  /**
   * Describe one owned range for substitution into a reviewed kernel export.
   *
   * The returned token contains no readable address and is valid only for the
   * lease that created it.
   */
  exportPointer(offset: number, length: number): KernelScratchExportPointer;
  /**
   * Invoke one reviewed pointer-borrowing export without exposing a primitive
   * allocation address to caller code.
   */
  invokeKernelExport(
    name: KernelScratchExportName,
    args: readonly (
      | number
      | bigint
      | KernelScratchExportPointer
    )[],
  ): number;
  /**
   * Invoke after validating every argument, then consume one exact opaque
   * void-ingress token immediately before the genuine gated export.
   */
  invokeKernelExportScoped(
    scope: KernelVoidIngressScope,
    name: KernelScratchExportName,
    args: readonly (
      | number
      | bigint
      | KernelScratchExportPointer
    )[],
  ): number;
  /**
   * Encode the checked address of one source range into another owned range.
   *
   * WHY: writing a primitive address through a general readable DataView lets
   * the host read it back and retain it after this lease is revoked. This
   * operation never returns the primitive and marks the encoded bytes
   * unreadable and immutable for the remainder of the lease. Immutability is
   * what prevents later scalar writes from replacing an owned address with an
   * arbitrary pointer before Rust consumes it.
   */
  writeAddress(
    destinationOffset: number,
    sourceOffset: number,
    sourceLength: number,
    encoding: "u32-le" | "u64-le" | "u32-to-u64-le",
  ): void;
  dataView(offset: number, length: number): KernelScratchDataView;
  copyFrom(
    source: Uint8Array,
    destinationOffset?: number,
    sourceOffset?: number,
    length?: number,
  ): void;
  copyTo(
    destination: Uint8Array,
    sourceOffset?: number,
    destinationOffset?: number,
    length?: number,
  ): void;
  copyOut(sourceOffset: number, length: number): Uint8Array;
  fill(value: number, offset: number, length: number): void;
}

/**
 * A synchronous lease is the only way to read or write the allocation.
 * Transfers check both allocation capacity and the current memory buffer.
 * Guarded scalar views retain that proof only while the grow-only memory keeps
 * the same buffer identity, and repeat it when growth replaces the buffer.
 */
const activeKernelScratchLeaseConstructorKey =
  intrinsicObjectFreeze(intrinsicObjectCreate(null) as object);
const activeKernelScratchLeaseInvalidators =
  new WeakMap<object, () => void>();

function invalidateActiveKernelScratchLease(
  lease: ActiveKernelScratchLease,
): void {
  const invalidate = intrinsicApply(
    intrinsicWeakMapGet,
    activeKernelScratchLeaseInvalidators,
    [lease],
  ) as (() => void) | undefined;
  if (invalidate === undefined) {
    throw new KernelScratchError("kernel scratch lease has no revocation state");
  }
  invalidate();
}

class ActiveKernelScratchLease implements KernelScratchLease {
  #valid = true;
  #invokingKernelExport = false;
  readonly #writeOnlyAddressRanges = intrinsicObjectCreate(null) as
    Record<number, {
    start: number;
    end: number;
  }>;
  #writeOnlyAddressRangeCount = 0;
  readonly #label: string;
  readonly #rangeForLease: (
    offset: number,
    length: number,
  ) => CheckedMemoryRange;
  readonly #currentMemoryBuffer: () => ArrayBufferLike;
  readonly #pointerWidth: WasmPointerWidth;
  readonly #kernelExports: KernelScratchExportSnapshot | null;

  constructor(
    constructorKey: object,
    label: string,
    rangeForLease: (
      offset: number,
      length: number,
    ) => CheckedMemoryRange,
    currentMemoryBuffer: () => ArrayBufferLike,
    pointerWidth: WasmPointerWidth,
    kernelExports: KernelScratchExportSnapshot | null,
  ) {
    if (constructorKey !== activeKernelScratchLeaseConstructorKey) {
      throw new KernelScratchError(
        "kernel scratch lease cannot be constructed outside its region",
      );
    }
    this.#label = label;
    this.#rangeForLease = rangeForLease;
    this.#currentMemoryBuffer = currentMemoryBuffer;
    this.#pointerWidth = pointerWidth;
    this.#kernelExports = kernelExports;
    intrinsicApply(
      intrinsicWeakMapSet,
      activeKernelScratchLeaseInvalidators,
      [this, () => this.#invalidate()],
    );
    intrinsicObjectFreeze(this);
  }

  #invalidate(): void {
    try {
      if (this.#writeOnlyAddressRangeCount > 0) {
        const buffer = this.#currentMemoryBuffer();
        for (
          let index = 0;
          index < this.#writeOnlyAddressRangeCount;
          index++
        ) {
          const range = this.#writeOnlyAddressRanges[index];
          const encodedAddress = new IntrinsicUint8Array(
            buffer,
            range.start,
            range.end - range.start,
          );
          intrinsicApply(
            intrinsicUint8ArrayFill,
            encodedAddress,
            [0],
          );
          delete this.#writeOnlyAddressRanges[index];
        }
      }
    } finally {
      // WHY: a later lease must never inherit either a readable primitive
      // address or stale sensitivity state, including when the operation
      // throws. Scrub while this lease still owns the allocation, then revoke
      // every escaped wrapper even if the scrub itself reports an error.
      for (
        let index = 0;
        index < this.#writeOnlyAddressRangeCount;
        index++
      ) {
        delete this.#writeOnlyAddressRanges[index];
      }
      this.#writeOnlyAddressRangeCount = 0;
      this.#valid = false;
    }
  }

  #assertActive(): void {
    if (!this.#valid) {
      throw new KernelScratchError(
        `${this.#label} lease is no longer active`,
      );
    }
  }

  #assertValid(): void {
    this.#assertActive();
    if (this.#invokingKernelExport) {
      // WHY: WebAssembly exports can call back into JavaScript imports before
      // returning. Sealing every escaped lease wrapper prevents reentrant host
      // code from observing or replacing the bytes Rust is currently
      // borrowing.
      throw new KernelScratchError(
        `${this.#label} lease is sealed during its kernel export`,
      );
    }
  }

  #ownedRange(offsetValue: number, lengthValue: number): CheckedMemoryRange {
    this.#assertValid();
    return this.#checkedOwnedRange(offsetValue, lengthValue);
  }

  #ownedRangeForKernelExport(
    offsetValue: number,
    lengthValue: number,
  ): CheckedMemoryRange {
    this.#assertActive();
    return this.#checkedOwnedRange(offsetValue, lengthValue);
  }

  #checkedOwnedRange(
    offsetValue: number,
    lengthValue: number,
  ): CheckedMemoryRange {
    const offset = exactNonNegativeInteger(
      offsetValue,
      `${this.#label} offset`,
    );
    const length = exactNonNegativeInteger(
      lengthValue,
      `${this.#label} length`,
    );
    return this.#rangeForLease(offset, length);
  }

  #readableRange(
    offsetValue: number,
    lengthValue: number,
  ): CheckedMemoryRange {
    const range = this.#ownedRange(offsetValue, lengthValue);
    const insertionIndex = this.#writeOnlyAddressInsertionIndex(range);
    if (this.#writeOnlyAddressRangeOverlaps(range, insertionIndex)) {
      throw new KernelScratchError(
        `${this.#label} address bytes are write-only for this lease`,
      );
    }
    return range;
  }

  #writableRange(
    offsetValue: number,
    lengthValue: number,
  ): CheckedMemoryRange {
    const range = this.#ownedRange(offsetValue, lengthValue);
    const insertionIndex = this.#writeOnlyAddressInsertionIndex(range);
    if (this.#writeOnlyAddressRangeOverlaps(range, insertionIndex)) {
      throw new KernelScratchError(
        `${this.#label} encoded address bytes are immutable for this lease`,
      );
    }
    return range;
  }

  /**
   * Return the sorted insertion point for an encoded-address interval.
   *
   * WHY: one readv/writev lease can contain IOV_MAX encoded pointers. Keeping
   * the non-overlapping intervals sorted lets the neighboring-range check make
   * every scalar/read/write proof O(log IOV_MAX), instead of turning ordinary
   * vector setup into quadratic taint scanning.
   */
  #writeOnlyAddressInsertionIndex(range: CheckedMemoryRange): number {
    let low = 0;
    let high = this.#writeOnlyAddressRangeCount;
    while (low < high) {
      const middle = low + intrinsicMathFloor((high - low) / 2);
      if (this.#writeOnlyAddressRanges[middle].start < range.pointer) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }
    return low;
  }

  #writeOnlyAddressRangeOverlaps(
    range: CheckedMemoryRange,
    insertionIndex: number,
  ): boolean {
    if (range.length === 0) return false;
    const previous = insertionIndex > 0
      ? this.#writeOnlyAddressRanges[insertionIndex - 1]
      : undefined;
    const next = insertionIndex < this.#writeOnlyAddressRangeCount
      ? this.#writeOnlyAddressRanges[insertionIndex]
      : undefined;
    return (
      (previous !== undefined && previous.end > range.pointer)
      || (next !== undefined && next.start < range.end)
    );
  }

  #recordWriteOnlyAddressRange(range: CheckedMemoryRange): void {
    const insertionIndex = this.#writeOnlyAddressInsertionIndex(range);
    if (this.#writeOnlyAddressRangeOverlaps(range, insertionIndex)) {
      throw new KernelScratchError(
        `${this.#label} encoded address bytes are immutable for this lease`,
      );
    }
    for (
      let index = this.#writeOnlyAddressRangeCount;
      index > insertionIndex;
      index--
    ) {
      intrinsicObjectDefineProperty(
        this.#writeOnlyAddressRanges,
        index,
        {
          value: this.#writeOnlyAddressRanges[index - 1],
          configurable: true,
        },
      );
    }
    intrinsicObjectDefineProperty(
      this.#writeOnlyAddressRanges,
      insertionIndex,
      {
        value: {
          start: range.pointer,
          end: range.end,
        },
        configurable: true,
      },
    );
    this.#writeOnlyAddressRangeCount++;
  }

  assertRange(offset: number, length: number): void {
    this.#ownedRange(offset, length);
  }

  exportPointer(
    offset: number,
    length: number,
  ): KernelScratchExportPointer {
    const checkedOffset = exactNonNegativeInteger(
      offset,
      `${this.#label} offset`,
    );
    const range = this.#ownedRange(checkedOffset, length);
    const pointer = intrinsicObjectFreeze(
      intrinsicObjectCreate(null) as object,
    ) as KernelScratchExportPointer;
    intrinsicApply(
      intrinsicWeakMapSet,
      kernelScratchExportPointers,
      [
        pointer,
        {
          lease: this,
          offset: checkedOffset,
          length: range.length,
        },
      ],
    );
    return pointer;
  }

  invokeKernelExport(
    name: KernelScratchExportName,
    args: readonly (
      | number
      | bigint
      | KernelScratchExportPointer
    )[],
  ): number {
    return this.#invokeKernelExport(undefined, name, args);
  }

  invokeKernelExportScoped(
    scope: KernelVoidIngressScope,
    name: KernelScratchExportName,
    args: readonly (
      | number
      | bigint
      | KernelScratchExportPointer
    )[],
  ): number {
    return this.#invokeKernelExport(scope, name, args);
  }

  #invokeKernelExport(
    scope: KernelVoidIngressScope | undefined,
    name: KernelScratchExportName,
    args: readonly (
      | number
      | bigint
      | KernelScratchExportPointer
    )[],
  ): number {
    this.#assertValid();
    if (typeof name !== "string" || !isKernelScratchExportName(name)) {
      throw new KernelScratchError(
        `${this.#label} kernel export is not approved for scratch borrowing`,
      );
    }
    const kernelExport = this.#kernelExports?.[name];
    if (kernelExport === undefined) {
      throw new KernelScratchError(
        `${this.#label} kernel export ${name} is unavailable`,
      );
    }

    const requiredPointers = kernelScratchRequiredPointerArguments(name);
    const nullablePointers = kernelScratchNullablePointerArguments(name);
    // WHY: `args` is caller-owned and can be a Proxy. Seal before its first
    // property read so getters cannot recursively use this lease while pointer
    // primitives are being prepared. All range checks below use a private path
    // that preserves the active-token proof without reopening the public lease.
    this.#invokingKernelExport = true;
    try {
      const argumentCount = exactNonNegativeInteger(
        args.length,
        `${this.#label} kernel export argument count`,
      );
      if (argumentCount !== kernelExport.argumentCount) {
        throw new KernelScratchError(
          `${this.#label} kernel export ${name} expects ` +
            `${kernelExport.argumentCount} arguments, received ${argumentCount}`,
        );
      }
      for (
        let pointerListIndex = 0;
        pointerListIndex < requiredPointers.length;
        pointerListIndex++
      ) {
        const pointerIndex = requiredPointers[pointerListIndex];
        if (pointerIndex + 1 >= argumentCount) {
          throw new KernelScratchError(
            `${this.#label} kernel export ${name} is missing pointer/capacity ` +
              `arguments at ${pointerIndex}/${pointerIndex + 1}`,
          );
        }
      }
      for (
        let pointerListIndex = 0;
        pointerListIndex < nullablePointers.length;
        pointerListIndex++
      ) {
        const pointerIndex = nullablePointers[pointerListIndex];
        if (pointerIndex + 1 >= argumentCount) {
          throw new KernelScratchError(
            `${this.#label} kernel export ${name} is missing pointer/capacity ` +
              `arguments at ${pointerIndex}/${pointerIndex + 1}`,
          );
        }
      }

      const convertedArgs = intrinsicObjectCreate(null) as {
        readonly length: number;
        readonly [index: number]: number | bigint;
      };
      intrinsicObjectDefineProperty(convertedArgs, "length", {
        value: argumentCount,
      });
      const borrowedRanges = intrinsicObjectCreate(null) as
        Record<number, CheckedMemoryRange>;
      const borrowedRangeList = intrinsicObjectCreate(null) as
        Record<number, CheckedMemoryRange>;
      let borrowedRangeCount = 0;
      for (let index = 0; index < argumentCount; index++) {
        const argument = args[index];
        let pointerKind: "required" | "nullable" | null = null;
        for (
          let pointerListIndex = 0;
          pointerListIndex < requiredPointers.length;
          pointerListIndex++
        ) {
          if (requiredPointers[pointerListIndex] === index) {
            pointerKind = "required";
            break;
          }
        }
        if (pointerKind === null) {
          for (
            let pointerListIndex = 0;
            pointerListIndex < nullablePointers.length;
            pointerListIndex++
          ) {
            if (nullablePointers[pointerListIndex] === index) {
              pointerKind = "nullable";
              break;
            }
          }
        }

        let convertedArgument: number | bigint;
        if (pointerKind !== null) {
          const record = (
            typeof argument === "object"
            && argument !== null
          )
            ? intrinsicApply(
              intrinsicWeakMapGet,
              kernelScratchExportPointers,
              [argument],
            ) as KernelScratchExportPointerRecord | undefined
            : undefined;
          if (record !== undefined) {
            if (record.lease !== this) {
              throw new KernelScratchError(
                `${this.#label} kernel export received a pointer from another lease`,
              );
            }
            const range = this.#ownedRangeForKernelExport(
              record.offset,
              record.length,
            );
            const alignment = kernelScratchPointerAlignment(name, index);
            if (range.pointer % alignment !== 0) {
              throw new KernelScratchError(
                `${this.#label} kernel export ${name} pointer argument ${index} ` +
                  `is not ${alignment}-byte aligned`,
              );
            }
            for (
              let borrowedIndex = 0;
              borrowedIndex < borrowedRangeCount;
              borrowedIndex++
            ) {
              const prior = borrowedRangeList[borrowedIndex];
              if (
                range.length > 0
                && prior.length > 0
                && range.pointer < prior.end
                && range.end > prior.pointer
              ) {
                throw new KernelScratchError(
                  `${this.#label} kernel export ${name} has overlapping ` +
                    "borrowed pointer ranges",
                );
              }
            }
            intrinsicObjectDefineProperty(borrowedRanges, index, {
              value: range,
            });
            intrinsicObjectDefineProperty(
              borrowedRangeList,
              borrowedRangeCount,
              { value: range },
            );
            borrowedRangeCount++;
            convertedArgument = this.#pointerWidth === 4
              ? range.pointer
              : IntrinsicBigInt(range.pointer);
          } else {
            const nullPointer = this.#pointerWidth === 4 ? 0 : 0n;
            if (pointerKind !== "nullable" || argument !== nullPointer) {
              throw new KernelScratchError(
                `${this.#label} kernel export ${name} pointer argument ${index} ` +
                  "must be an owned range token" +
                  (pointerKind === "nullable"
                    ? " or an exact null pointer"
                    : ""),
              );
            }
            convertedArgument = nullPointer;
          }
        } else {
          if (typeof argument !== "number" && typeof argument !== "bigint") {
            throw new KernelScratchError(
              `${this.#label} kernel export ${name} argument ${index} ` +
                "must be a primitive scalar",
            );
          }
          convertedArgument = argument;
        }
        intrinsicObjectDefineProperty(convertedArgs, index, {
          value: convertedArgument,
        });
      }

      // WHY: every approved pointer-bearing export places an explicit byte
      // capacity immediately after its pointer. Couple that scalar to the
      // opaque token here so a one-byte borrow can never be paired with a
      // larger Rust slice length. Exact equality also prevents a stale larger
      // token from silently authorizing a different call shape.
      const validatePointerCapacities = (
        pointerIndexes: readonly number[],
      ): void => {
        for (
          let pointerListIndex = 0;
          pointerListIndex < pointerIndexes.length;
          pointerListIndex++
        ) {
          const pointerIndex = pointerIndexes[pointerListIndex];
          const declaredCapacity = exactNonNegativeInteger(
            convertedArgs[pointerIndex + 1],
            `${this.#label} kernel export ${name} pointer ` +
              `${pointerIndex} capacity`,
          );
          const borrowed = borrowedRanges[pointerIndex];
          const ownedCapacity = borrowed?.length ?? 0;
          if (declaredCapacity !== ownedCapacity) {
            throw new KernelScratchError(
              `${this.#label} kernel export ${name} pointer argument ` +
                `${pointerIndex} declares ${declaredCapacity} bytes but ` +
                `borrows ${ownedCapacity}`,
            );
          }
        }
      };
      validatePointerCapacities(requiredPointers);
      validatePointerCapacities(nullablePointers);

      // WHY: the snapshot retains either the genuine raw Wasm function or the
      // exact registered façade wrapper. The latter re-enters through its
      // private gate without exposing that gate or a raw invocation closure
      // to the scratch layer.
      const invoke = () => intrinsicApply(
        kernelExport.call,
        undefined,
        convertedArgs,
      );
      const result = scope === undefined
        ? invoke()
        : invokeKernelEntryScopedOperation(
          scope,
          kernelExport.instance,
          invoke,
        );
      if (typeof result !== "number") {
        throw new KernelScratchError(
          `${this.#label} kernel export ${name} returned a non-number`,
        );
      }
      return result;
    } finally {
      this.#invokingKernelExport = false;
    }
  }

  writeAddress(
    destinationOffset: number,
    sourceOffset: number,
    sourceLength: number,
    encoding: "u32-le" | "u64-le" | "u32-to-u64-le",
  ): void {
    if (
      encoding !== "u32-le"
      && encoding !== "u64-le"
      && encoding !== "u32-to-u64-le"
    ) {
      throw new KernelScratchError(
        `${this.#label} address encoding must be u32-le, u64-le, or u32-to-u64-le`,
      );
    }
    const source = this.#ownedRange(sourceOffset, sourceLength);
    const encodedLength = encoding === "u32-le" ? 4 : 8;
    const destination = this.#ownedRange(
      destinationOffset,
      encodedLength,
    );
    if (
      encoding !== "u64-le"
      && source.pointer > WASM32_MAX_POINTER
    ) {
      throw new KernelScratchError(
        `${this.#label} address does not fit the ${encoding} encoding`,
      );
    }

    // WHY: once an address is materialized as bytes, a general getter or copy
    // could turn it back into an irrevocable primitive, while a later setter
    // could replace the checked owned address with an arbitrary kernel-memory
    // pointer. Record the exact bytes before writing so every overlapping read
    // or later mutation is rejected for this lease.
    this.#recordWriteOnlyAddressRange(destination);
    const destinationView = new IntrinsicDataView(
      this.#currentMemoryBuffer(),
      destination.pointer,
      destination.length,
    );
    if (encoding === "u32-le") {
      intrinsicApply(
        intrinsicDataViewSetUint32,
        destinationView,
        [0, source.pointer, true],
      );
    } else {
      intrinsicApply(
        intrinsicDataViewSetBigUint64,
        destinationView,
        [0, IntrinsicBigInt(source.pointer), true],
      );
    }
  }

  dataView(offset: number, length: number): KernelScratchDataView {
    const refreshView = () => {
      const range = this.#ownedRange(offset, length);
      const buffer = this.#currentMemoryBuffer();
      return {
        buffer,
        view: new IntrinsicDataView(
          buffer,
          range.pointer,
          range.length,
        ),
      };
    };
    return new ActiveKernelScratchDataView(
      activeKernelScratchDataViewConstructorKey,
      () => {
        this.#assertValid();
        return this.#currentMemoryBuffer();
      },
      (viewOffset, viewLength) => {
        const checkedViewOffset = exactNonNegativeInteger(
          viewOffset,
          `${this.#label} DataView offset`,
        );
        this.#readableRange(offset + checkedViewOffset, viewLength);
      },
      (viewOffset, viewLength) => {
        const checkedViewOffset = exactNonNegativeInteger(
          viewOffset,
          `${this.#label} DataView offset`,
        );
        this.#writableRange(offset + checkedViewOffset, viewLength);
      },
      refreshView,
    );
  }

  copyFrom(
    source: Uint8Array,
    destinationOffset = 0,
    sourceOffset = 0,
    length?: number,
  ): void {
    const sourceSpan = intrinsicUint8ArraySpan(
      source,
      `${this.#label} source`,
    );
    const checkedSourceOffset = exactNonNegativeInteger(
      sourceOffset,
      `${this.#label} source offset`,
    );
    const checkedLength = exactNonNegativeInteger(
      length ?? sourceSpan.byteLength - checkedSourceOffset,
      `${this.#label} copy length`,
    );
    checkedRange(
      checkedSourceOffset,
      checkedLength,
      sourceSpan.byteLength,
      `${this.#label} source`,
    );
    const destination = this.#writableRange(
      destinationOffset,
      checkedLength,
    );
    // WHY: calling a subclass-overridable `source.subarray()` could return
    // more bytes than the range just proved. Construct an exact base-class
    // view from the typed array's intrinsic slots instead.
    const exactSource = new IntrinsicUint8Array(
      sourceSpan.buffer,
      sourceSpan.byteOffset + checkedSourceOffset,
      checkedLength,
    );
    // WHY: make the native receiver itself cover only the owned allocation
    // range. The capacity proof is therefore structural even if this helper is
    // later refactored and an absolute full-memory offset is accidentally lost.
    const exactDestination = new IntrinsicUint8Array(
      this.#currentMemoryBuffer(),
      destination.pointer,
      destination.length,
    );
    intrinsicApply(
      intrinsicUint8ArraySet,
      exactDestination,
      [exactSource],
    );
  }

  copyTo(
    destination: Uint8Array,
    sourceOffset = 0,
    destinationOffset = 0,
    length?: number,
  ): void {
    const destinationSpan = intrinsicUint8ArraySpan(
      destination,
      `${this.#label} destination`,
    );
    const checkedDestinationOffset = exactNonNegativeInteger(
      destinationOffset,
      `${this.#label} destination offset`,
    );
    const checkedLength = exactNonNegativeInteger(
      length ?? destinationSpan.byteLength - checkedDestinationOffset,
      `${this.#label} copy length`,
    );
    checkedRange(
      checkedDestinationOffset,
      checkedLength,
      destinationSpan.byteLength,
      `${this.#label} destination`,
    );
    const source = this.#readableRange(sourceOffset, checkedLength);
    const kernelSource = new IntrinsicUint8Array(
      this.#currentMemoryBuffer(),
      source.pointer,
      source.length,
    );
    const detached = new IntrinsicUint8Array(source.length);
    intrinsicApply(
      intrinsicUint8ArraySet,
      detached,
      [kernelSource],
    );
    // WHY: invoke the captured intrinsic rather than a subclass/live
    // prototype method. A caller-owned destination must not reenter while the
    // lease is active or retain a live kernel view.
    intrinsicApply(
      intrinsicUint8ArraySet,
      destination,
      [detached, checkedDestinationOffset],
    );
  }

  copyOut(sourceOffset: number, length: number): Uint8Array {
    const source = this.#readableRange(sourceOffset, length);
    const kernelSource = new IntrinsicUint8Array(
      this.#currentMemoryBuffer(),
      source.pointer,
      source.length,
    );
    const detached = new IntrinsicUint8Array(source.length);
    intrinsicApply(
      intrinsicUint8ArraySet,
      detached,
      [kernelSource],
    );
    return detached;
  }

  fill(value: number, offset: number, length: number): void {
    if (typeof value !== "number") {
      throw new KernelScratchError(
        `${this.#label} fill value must be a primitive number`,
      );
    }
    const destination = this.#writableRange(offset, length);
    const exactDestination = new IntrinsicUint8Array(
      this.#currentMemoryBuffer(),
      destination.pointer,
      destination.length,
    );
    intrinsicApply(
      intrinsicUint8ArrayFill,
      exactDestination,
      [value],
    );
  }
}

intrinsicObjectFreeze(ActiveKernelScratchLease.prototype);
intrinsicObjectFreeze(ActiveKernelScratchLease);

export interface KernelScratchRegion {
  readonly capacity: number;
  withLease<T>(operation: (scratch: KernelScratchLease) => T): T;
  revoke(): void;
}

interface OwnedKernelScratchRegionOwnership {
  readonly memory: WebAssembly.Memory;
  readonly pointerWidth: WasmPointerWidth;
  readonly instance: WebAssembly.Instance | null;
}

const ownedKernelScratchRegionOwnerships =
  new WeakMap<object, OwnedKernelScratchRegionOwnership>();

/**
 * Pointer plus declared capacity for one kernel-owned allocation.
 *
 * The constructor is private: production callers obtain regions only by
 * passing the kernel allocator to allocateKernelScratchRegion.
 */
const ownedKernelScratchRegionConstructorKey =
  intrinsicObjectFreeze(intrinsicObjectCreate(null) as object);

class OwnedKernelScratchRegion implements KernelScratchRegion {
  declare readonly capacity: number;
  #activeLeaseToken: object | null = null;
  #revoked = false;
  #singleUseConsumed = false;
  readonly #memory: WebAssembly.Memory;
  readonly #pointer: number;
  readonly #capacity: number;
  readonly #pointerWidth: WasmPointerWidth;
  readonly #label: string;
  readonly #leaseMode: "reusable" | "single-use";
  readonly #kernelExports: KernelScratchExportSnapshot | null;

  private constructor(
    constructorKey: object,
    memory: WebAssembly.Memory,
    pointer: number,
    capacity: number,
    pointerWidth: WasmPointerWidth,
    label: string,
    leaseMode: "reusable" | "single-use",
    kernelExports: KernelScratchExportSnapshot | null,
  ) {
    if (constructorKey !== ownedKernelScratchRegionConstructorKey) {
      throw new KernelScratchError(
        "kernel scratch region cannot be constructed outside its factory",
      );
    }
    this.#memory = memory;
    this.#pointer = pointer;
    this.#capacity = capacity;
    this.#pointerWidth = pointerWidth;
    this.#label = label;
    this.#leaseMode = leaseMode;
    this.#kernelExports = kernelExports;
    // WHY: callers need the numeric capacity for planning, but an ordinary
    // TypeScript readonly field is writable at runtime. Publish a frozen own
    // value while all authority-bearing state remains in true private slots.
    intrinsicObjectDefineProperty(this, "capacity", {
      value: capacity,
      enumerable: true,
      writable: false,
      configurable: false,
    });
    intrinsicObjectFreeze(this);
  }

  static allocate(
    constructorKey: object,
    memory: WebAssembly.Memory,
    allocator: KernelScratchAllocator,
    capacityValue: number,
    pointerWidth: WasmPointerWidth,
    label: string,
    kernelInstance?: WebAssembly.Instance,
    allocatorInstance?: WebAssembly.Instance,
  ): OwnedKernelScratchRegion {
    if (constructorKey !== ownedKernelScratchRegionConstructorKey) {
      throw new KernelScratchError(
        "kernel scratch allocation factory is not authorized",
      );
    }
    if (pointerWidth !== 4 && pointerWidth !== 8) {
      throw new KernelScratchError(
        `${label} pointer width must be exactly 4 or 8`,
      );
    }
    const kernelExports = kernelInstance === undefined
      ? null
      : snapshotKernelScratchExports(
        kernelInstance,
        memory,
        label,
        allocator,
        allocatorInstance,
      );
    const capacity = exactNonNegativeInteger(
      capacityValue,
      `${label} capacity`,
    );
    if (capacity === 0) {
      throw new KernelScratchError(`${label} capacity must be positive`);
    }
    if (capacity > 0xffff_ffff) {
      throw new KernelScratchError(
        `${label} capacity does not fit kernel_alloc_scratch's u32 size`,
      );
    }
    const pointer = checkedKernelExportPointer(
      allocator(capacity),
      pointerWidth,
      `${label} allocation`,
    );
    if (pointer === 0) {
      throw new KernelScratchError(`${label} allocation failed`);
    }
    checkedMemoryRange(memory, pointer, capacity, pointerWidth, label);
    const region = new OwnedKernelScratchRegion(
      ownedKernelScratchRegionConstructorKey,
      memory,
      pointer,
      capacity,
      pointerWidth,
      label,
      "reusable",
      kernelExports,
    );
    intrinsicApply(
      intrinsicWeakMapSet,
      ownedKernelScratchRegionOwnerships,
      [
        region,
        intrinsicObjectFreeze({
          memory,
          pointerWidth,
          instance: kernelInstance ?? null,
        }),
      ],
    );
    return region;
  }

  static reserve(
    constructorKey: object,
    memory: WebAssembly.Memory,
    reserver: KernelScratchReserver,
    minimumCapacityValue: number,
    pointerWidth: WasmPointerWidth,
    label: string,
    kernelInstance?: WebAssembly.Instance,
  ): OwnedKernelScratchRegion {
    if (constructorKey !== ownedKernelScratchRegionConstructorKey) {
      throw new KernelScratchError(
        "kernel scratch reservation factory is not authorized",
      );
    }
    if (pointerWidth !== 4 && pointerWidth !== 8) {
      throw new KernelScratchError(
        `${label} pointer width must be exactly 4 or 8`,
      );
    }
    const kernelExports = kernelInstance === undefined
      ? null
      : snapshotKernelScratchExports(kernelInstance, memory, label);
    const minimumCapacity = exactNonNegativeInteger(
      minimumCapacityValue,
      `${label} minimum capacity`,
    );
    if (minimumCapacity === 0) {
      throw new KernelScratchError(
        `${label} minimum capacity must be positive`,
      );
    }
    if (
      pointerWidth === 4
      && minimumCapacity > WASM32_MAX_POINTER
    ) {
      // WHY: the reservation export consumes a wasm32 usize. Reject before
      // invoking it so JavaScript-to-Wasm i32 coercion cannot silently replace
      // an oversized requested capacity with its low 32 bits.
      throw new KernelScratchError(
        `${label} minimum capacity does not fit a wasm32 usize`,
      );
    }
    const reservation = reserver(minimumCapacity);
    const capacity = exactNonNegativeInteger(
      reservation.capacity,
      `${label} reserved capacity`,
    );
    if (capacity < minimumCapacity) {
      throw new KernelScratchError(
        `${label} reserved capacity ${capacity} is below ${minimumCapacity}`,
      );
    }
    const pointer = checkedKernelExportPointer(
      reservation.pointer,
      pointerWidth,
      `${label} reservation`,
    );
    if (pointer === 0) {
      throw new KernelScratchError(`${label} reservation failed`);
    }
    checkedMemoryRange(memory, pointer, capacity, pointerWidth, label);
    const region = new OwnedKernelScratchRegion(
      ownedKernelScratchRegionConstructorKey,
      memory,
      pointer,
      capacity,
      pointerWidth,
      label,
      "single-use",
      kernelExports,
    );
    intrinsicApply(
      intrinsicWeakMapSet,
      ownedKernelScratchRegionOwnerships,
      [
        region,
        intrinsicObjectFreeze({
          memory,
          pointerWidth,
          instance: kernelInstance ?? null,
        }),
      ],
    );
    return region;
  }

  #assertActiveLease(token: object): void {
    if (this.#activeLeaseToken !== token) {
      throw new KernelScratchError(
        `${this.#label} lease is no longer active`,
      );
    }
  }

  #ownedRangeForLease(
    token: object,
    offset: number,
    length: number,
  ): CheckedMemoryRange {
    this.#assertActiveLease(token);
    checkedRange(offset, length, this.#capacity, this.#label);
    return checkedMemoryRange(
      this.#memory,
      this.#pointer + offset,
      length,
      this.#pointerWidth,
      this.#label,
    );
  }

  withLease<T>(operation: (scratch: KernelScratchLease) => T): T {
    if (this.#revoked) {
      throw new KernelScratchError(`${this.#label} is no longer valid`);
    }
    if (this.#leaseMode === "single-use" && this.#singleUseConsumed) {
      throw new KernelScratchError(
        `${this.#label} reservation is single-use`,
      );
    }
    if (this.#activeLeaseToken !== null) {
      throw new KernelScratchError(`${this.#label} is already in use`);
    }
    // WHY: a reservation-derived pointer can move on the next Rust reserve.
    // Consume its one lease before any fallible range/view work so retrying a
    // partially failed attempt cannot revive a stale pointer.
    if (this.#leaseMode === "single-use") {
      this.#singleUseConsumed = true;
    }
    // Recheck the whole allocation because memory replacement/growth changes
    // the backing buffer independently of the allocator's original result.
    checkedMemoryRange(
      this.#memory,
      this.#pointer,
      this.#capacity,
      this.#pointerWidth,
      this.#label,
    );
    const token = intrinsicObjectFreeze(intrinsicObjectCreate(null) as object);
    this.#activeLeaseToken = token;
    const lease = new ActiveKernelScratchLease(
      activeKernelScratchLeaseConstructorKey,
      this.#label,
      (offset, length) =>
        this.#ownedRangeForLease(token, offset, length),
      () => {
        this.#assertActiveLease(token);
        return intrinsicWasmMemoryBuffer(this.#memory, this.#label);
      },
      this.#pointerWidth,
      this.#kernelExports,
    );
    let result!: T;
    try {
      result = operation(lease);
    } finally {
      // WHY: revoke the lease before inspecting an arbitrary return value.
      // A hostile `then` getter must not retain scratch access for even the
      // property lookup used to reject asynchronous operations.
      try {
        invalidateActiveKernelScratchLease(lease);
      } catch (error) {
        // WHY: if sensitive encoded addresses cannot be scrubbed, no later
        // operation may treat this allocation as clean reusable scratch.
        this.#revoked = true;
        throw error;
      } finally {
        this.#activeLeaseToken = null;
      }
    }
    if (
      (
        typeof result === "object" &&
        result !== null
      ) ||
      typeof result === "function"
    ) {
      if (typeof (result as { then?: unknown }).then === "function") {
        // WHY: a retained view or callback could otherwise resume after a
        // second operation has replaced the shared bytes.
        throw new KernelScratchError(
          `${this.#label} leases must remain synchronous`,
        );
      }
    }
    return result;
  }

  /**
   * Permanently invalidate a reservation-derived region when its matching
   * kernel token is consumed or cancelled.
   */
  revoke(): void {
    if (this.#activeLeaseToken !== null) {
      throw new KernelScratchError(
        `${this.#label} cannot be revoked while in use`,
      );
    }
    this.#revoked = true;
  }
}

intrinsicObjectFreeze(OwnedKernelScratchRegion.prototype);
intrinsicObjectFreeze(OwnedKernelScratchRegion);

export function allocateKernelScratchRegion(
  memory: WebAssembly.Memory,
  allocator: KernelScratchAllocator,
  capacity: number,
  pointerWidth: WasmPointerWidth,
  label: string,
  kernelInstance?: WebAssembly.Instance,
  allocatorInstance?: WebAssembly.Instance,
): KernelScratchRegion {
  return OwnedKernelScratchRegion.allocate(
    ownedKernelScratchRegionConstructorKey,
    memory,
    allocator,
    capacity,
    pointerWidth,
    label,
    kernelInstance,
    allocatorInstance,
  );
}

/**
 * Create a one-shot capacity-carrying region from a kernel-owned reservation.
 * The kernel may move the allocation only while `reserver` runs. The returned
 * region permits exactly one lease and should be revoked when the matching
 * reservation token is consumed or cancelled.
 */
export function reserveKernelScratchRegion(
  memory: WebAssembly.Memory,
  reserver: KernelScratchReserver,
  minimumCapacity: number,
  pointerWidth: WasmPointerWidth,
  label: string,
  kernelInstance?: WebAssembly.Instance,
): KernelScratchRegion {
  return OwnedKernelScratchRegion.reserve(
    ownedKernelScratchRegionConstructorKey,
    memory,
    reserver,
    minimumCapacity,
    pointerWidth,
    label,
    kernelInstance,
  );
}

/**
 * @internal Validate a test-injected region without exposing its pointer.
 *
 * WHY: `KernelScratchRegion` is intentionally structural for callers, so a
 * shape check cannot prove allocator ownership. The module-private WeakMap
 * records the exact genuine instance, Memory, and entry-gate generation at
 * factory time.
 */
export function validateKernelScratchRegionOwnership(
  region: KernelScratchRegion,
  instance: WebAssembly.Instance,
  label: string,
): {
  readonly region: KernelScratchRegion;
  readonly memory: WebAssembly.Memory;
  readonly pointerWidth: WasmPointerWidth;
} {
  const ownership = intrinsicApply(
    intrinsicWeakMapGet,
    ownedKernelScratchRegionOwnerships,
    [region as object],
  ) as OwnedKernelScratchRegionOwnership | undefined;
  if (ownership === undefined) {
    throw new KernelScratchError(
      `${label} is not an allocator-created kernel scratch region`,
    );
  }
  try {
    validateKernelEntryGatedInstance(instance);
  } catch {
    throw new KernelScratchError(
      `${label} instance is not a registered gated kernel generation`,
    );
  }
  if (ownership.instance !== instance) {
    throw new KernelScratchError(
      `${label} belongs to a different kernel generation`,
    );
  }
  // Re-prove the current engine Memory receiver before returning it to the
  // owning worker. A replaced structural value cannot satisfy this getter.
  intrinsicWasmMemoryBuffer(ownership.memory, `${label} memory`);
  return intrinsicObjectFreeze({
    region,
    memory: ownership.memory,
    pointerWidth: ownership.pointerWidth,
  });
}
