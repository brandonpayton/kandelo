import { WASM_PAGE_SIZE } from "./constants";
import {
  WPK_FORK_LINKED_FRAME_DESCRIPTOR_SIZE,
  WPK_FORK_LINKED_FRAME_FORMAT_MAGIC,
  WPK_FORK_LINKED_FRAME_FORMAT_SECTION,
  WPK_FORK_LINKED_FRAME_FORMAT_VERSION,
  WPK_FORK_LINKED_FRAME_POINTER_WIDTHS,
  WPK_FORK_LINKED_FRAME_RECORD_ALIGNMENT,
  WPK_FORK_LINKED_FRAME_REQUIRED_FLAGS,
} from "./generated/abi";
import {
  checkedWasmGuestPointerOffset,
  type WasmGuestPointer,
} from "./wasm-guest-pointer";

export const LINKED_FRAME_FORMAT_SECTION = WPK_FORK_LINKED_FRAME_FORMAT_SECTION;
export const LINKED_FRAME_FORMAT_VERSION = WPK_FORK_LINKED_FRAME_FORMAT_VERSION;
export const LINKED_FRAME_RECORD_ALIGNMENT = WPK_FORK_LINKED_FRAME_RECORD_ALIGNMENT;

const DESCRIPTOR_SIZE = WPK_FORK_LINKED_FRAME_DESCRIPTOR_SIZE;
const DESCRIPTOR_REQUIRED_FLAGS = WPK_FORK_LINKED_FRAME_REQUIRED_FLAGS;

export interface LinkedFrameFormatDescriptor {
  version: number;
  ptrWidth: 4 | 8;
  alignment: number;
  flags: number;
  chunkHeaderSize: number;
  nodeHeaderSize: number;
  fixedPrefixSize: number;
}

export type ContinuationAllocate = (size: number) => number;
export type ContinuationDeallocate = (addr: number, size: number) => void;
export type ForkContinuationGuestAddress = WasmGuestPointer;

/**
 * Invoke an instrumented continuation begin export with the module's exact
 * pointer-width calling convention.
 *
 * WHY: WebAssembly i64 parameters require JavaScript BigInt even when the
 * address itself fits in a Number. Keeping this conversion at the shared
 * continuation boundary prevents main, pthread, and side-module paths from
 * silently drifting apart.
 */
export function invokeForkContinuationBegin(
  exported: unknown,
  address: number,
  ptrWidth: 4 | 8,
  context: string,
): void {
  if (typeof exported !== "function") {
    throw new TypeError(`${context}: continuation begin export is not callable`);
  }
  if (!Number.isSafeInteger(address) || address <= 0) {
    throw new RangeError(`${context}: invalid continuation address ${address}`);
  }
  const guestAddress: ForkContinuationGuestAddress = ptrWidth === 8
    ? BigInt(address)
    : address;
  (exported as (value: ForkContinuationGuestAddress) => void)(guestAddress);
}

export class ContinuationAllocationError extends Error {
  constructor(
    readonly errno: number,
    readonly requestedSize: number,
    message: string,
  ) {
    super(message);
    this.name = "ContinuationAllocationError";
  }
}

interface AbortFailure {
  errno: number;
  requestedFrame?: number;
  diagnostic: string;
}

export function writeForkContinuationAnchor(
  memory: WebAssembly.Memory,
  anchorAddr: number,
  ptrWidth: 4 | 8,
  moduleBufferAddr: number,
): void {
  const view = new DataView(memory.buffer);
  if (ptrWidth === 8) view.setBigUint64(anchorAddr, BigInt(moduleBufferAddr), true);
  else view.setUint32(anchorAddr, moduleBufferAddr, true);
}

export function readForkContinuationAnchor(
  memory: WebAssembly.Memory,
  anchorAddr: number,
  ptrWidth: 4 | 8,
): number {
  const view = new DataView(memory.buffer);
  const value = ptrWidth === 8
    ? Number(view.getBigUint64(anchorAddr, true))
    : view.getUint32(anchorAddr, true);
  const pointerFormat = linkedFramePointerFormat(ptrWidth);
  if (!pointerFormat) {
    throw new Error(`unsupported fork continuation pointer width ${ptrWidth}`);
  }
  const root = value - pointerFormat.chunkHeaderSize;
  if (
    !Number.isSafeInteger(value)
    || value <= 0
    || !Number.isSafeInteger(root)
    || root <= 0
    || root % WASM_PAGE_SIZE !== 0
    || root + WASM_PAGE_SIZE > memory.buffer.byteLength
  ) {
    throw new Error(`invalid fork continuation anchor ${String(value)}`);
  }
  // WHY: this boundary can prove the outer allocation geometry without
  // executing or compiling the guest module. The child worker later validates
  // the complete linked-frame chain against that module's format descriptor;
  // treating this lightweight check as full chain validation would create a
  // second, incomplete parser in the syscall dispatcher.
  return value;
}

// WHY: descriptor parsing must use the same Rust-generated layout table as
// publication guards; recomputing it here would let a future ABI change pass
// release validation and fail only when the host begins a continuation.
function linkedFramePointerFormat(ptrWidth: number) {
  return WPK_FORK_LINKED_FRAME_POINTER_WIDTHS.find(({ bytes }) => bytes === ptrWidth);
}


export function readLinkedFrameFormat(
  module: WebAssembly.Module,
): LinkedFrameFormatDescriptor {
  const sections = WebAssembly.Module.customSections(module, LINKED_FRAME_FORMAT_SECTION);
  if (sections.length !== 1) {
    throw new Error(
      `expected one ${LINKED_FRAME_FORMAT_SECTION} section, found ${sections.length}`,
    );
  }
  const bytes = new Uint8Array(sections[0]);
  if (bytes.byteLength !== DESCRIPTOR_SIZE) {
    throw new Error(
      `linked continuation metadata has ${bytes.byteLength} bytes, expected ${DESCRIPTOR_SIZE}`,
    );
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (!WPK_FORK_LINKED_FRAME_FORMAT_MAGIC.every((byte, index) => bytes[index] === byte)) {
    throw new Error("linked continuation metadata has invalid magic");
  }
  const version = view.getUint16(4, true);
  if (version !== LINKED_FRAME_FORMAT_VERSION) {
    throw new Error(`unsupported linked continuation metadata version ${version}`);
  }
  if (view.getUint16(6, true) !== DESCRIPTOR_SIZE) {
    throw new Error("linked continuation metadata has an invalid declared size");
  }
  const ptrWidth = view.getUint8(8);
  const pointerFormat = linkedFramePointerFormat(ptrWidth);
  if (!pointerFormat) {
    throw new Error(`unsupported linked continuation pointer width ${ptrWidth}`);
  }
  const alignment = view.getUint8(9);
  if (alignment !== LINKED_FRAME_RECORD_ALIGNMENT) {
    throw new Error(`unsupported linked continuation alignment ${alignment}`);
  }
  const flags = view.getUint16(10, true);
  if (flags !== DESCRIPTOR_REQUIRED_FLAGS) {
    throw new Error(`unsupported linked continuation flags 0x${flags.toString(16)}`);
  }
  const chunkHeaderSize = view.getUint32(12, true);
  const nodeHeaderSize = view.getUint32(16, true);
  const fixedPrefixSize = view.getUint32(20, true);
  if (
    chunkHeaderSize !== pointerFormat.chunkHeaderSize
    || nodeHeaderSize !== pointerFormat.nodeHeaderSize
  ) {
    throw new Error("linked continuation metadata header sizes do not match pointer width");
  }
  return {
    version,
    ptrWidth: pointerFormat.bytes,
    alignment,
    flags,
    chunkHeaderSize,
    nodeHeaderSize,
    fixedPrefixSize,
  };
}

