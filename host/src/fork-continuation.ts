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
const CHUNK_MAGIC = 0x4843464b; // "KFCH", little-endian
const NODE_MAGIC = 0x4e43464b; // "KFCN", little-endian
const NODE_RESERVED = 1;
const NODE_COMMITTED = 2;
const NODE_CONSUMED = 3;

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
  memory: { readonly buffer: ArrayBufferLike },
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

function alignUp(value: number, alignment: number): number {
  const result = Math.ceil(value / alignment) * alignment;
  if (!Number.isSafeInteger(result)) {
    throw new Error(`linked continuation alignment overflow: ${value}`);
  }
  return result;
}

function checkedEnd(addr: number, size: number): number {
  const end = addr + size;
  if (
    !Number.isSafeInteger(addr)
    || !Number.isSafeInteger(size)
    || addr < 0
    || size < 0
    || !Number.isSafeInteger(end)
  ) {
    throw new Error(`invalid linked continuation range addr=${addr} size=${size}`);
  }
  return end;
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

interface PendingNode {
  chunk: number;
  node: number;
  payload: number;
  nextUsed: number;
}

interface ContinuationChunk {
  addr: number;
  size: number;
  nodeStart: number;
  used: number;
}

interface ValidatedReplayNode {
  node: number;
  payload: number;
  previous: number;
  nextReplay: {
    chunkIndex: number;
    expectedEnd: number;
  };
}

type ReplayOwnership = "owned" | "borrowed";

/**
 * Host-side owner and validator for one module instance's linked fork frames.
 * Allocations are ordinary anonymous process mappings, so kernel brk/mmap
 * ownership, fork inheritance, and memory growth remain authoritative.
 */
export class LinkedForkContinuation {
  private root = 0;
  private activeChunk = 0;
  private replayNode = 0;
  private replayChunkIndex = -1;
  private replayExpectedEnd = 0;
  private pending: PendingNode | null = null;
  private chunks: ContinuationChunk[] = [];
  // Diagnostics must not become the first precision ceiling in a wasm64
  // continuation. The linked list is allocator-bounded, not Number-bounded.
  private committedFrames = 0n;
  private committedBytes = 0n;
  private abortFailure: AbortFailure | null = null;
  private replayOwnership: ReplayOwnership | null = null;

  constructor(
    private readonly memory: WebAssembly.Memory,
    readonly format: LinkedFrameFormatDescriptor,
    private readonly allocate: ContinuationAllocate,
    private readonly deallocate: ContinuationDeallocate,
    private readonly label: string,
  ) {}

  beginUnwind(): number | bigint {
    if (this.root !== 0) {
      throw new Error(`${this.label}: linked continuation already active`);
    }
    const initialUsed = alignUp(
      this.format.chunkHeaderSize + this.format.fixedPrefixSize,
      this.format.alignment,
    );
    const capacity = alignUp(Math.max(initialUsed, WASM_PAGE_SIZE), WASM_PAGE_SIZE);
    this.committedFrames = 0n;
    this.committedBytes = 0n;
    this.abortFailure = null;
    this.replayOwnership = "owned";
    let root: number;
    try {
      root = this.allocateChunk(capacity, 0, 0);
    } catch (error) {
      if (error instanceof ContinuationAllocationError) {
        this.releaseAfterFailure(error);
      }
      this.abortAndRelease(undefined, error);
    }
    this.root = root;
    this.activeChunk = root;
    this.writePtr(root + 8 + 4 * this.format.ptrWidth, initialUsed);
    this.chunks[0]!.nodeStart = initialUsed;
    this.chunks[0]!.used = initialUsed;
    return this.asGuestPtr(root + this.format.chunkHeaderSize);
  }

  attachForReplay(moduleBuffer: number | bigint): void {
    this.attachForReplayWithOwnership(moduleBuffer, "owned");
  }

  /**
   * Attach a read-only replay cursor to continuation storage owned elsewhere
   * and copy its mutable module prefix into caller-owned scratch memory.
   *
   * WHY: a vfork child shares the parent's Memory and may reconstruct its
   * Wasm stack from the saved frames, but consuming nodes or unmapping chunks
   * would destroy the only continuation from which the parent can resume.
   * Generated replay code also writes the active-frame pointer at offset zero
   * of the module prefix, so passing the parent's prefix to rewind would still
   * corrupt the parent even with a read-only JavaScript cursor. The returned
   * address is the private prefix that must be passed to
   * `wpk_fork_rewind_begin`; frame imports continue reading the borrowed
   * linked nodes. The caller must retain both the Memory backing and the
   * scratch reservation independently for the complete borrow.
   */
  attachForBorrowedReplay(
    moduleBuffer: number | bigint,
    privateModuleBuffer: number | bigint,
  ): number | bigint {
    this.attachForReplayWithOwnership(moduleBuffer, "borrowed");
    try {
      const source = this.fromGuestPtr(moduleBuffer);
      const target = this.fromGuestPtr(privateModuleBuffer);
      const targetEnd = checkedEnd(target, this.format.fixedPrefixSize);
      if (
        target <= 0
        || target % this.format.alignment !== 0
        || targetEnd > this.memory.buffer.byteLength
      ) {
        throw new Error(`${this.label}: invalid borrowed replay prefix range`);
      }
      for (const chunk of this.chunks) {
        if (target < chunk.addr + chunk.size && targetEnd > chunk.addr) {
          throw new Error(`${this.label}: borrowed replay prefix overlaps continuation storage`);
        }
      }

      // Slice first so an accidental future relaxation of the overlap guard
      // cannot turn this into a partially self-overwriting copy.
      const prefix = new Uint8Array(
        this.memory.buffer,
        source,
        this.format.fixedPrefixSize,
      ).slice();
      new Uint8Array(
        this.memory.buffer,
        target,
        this.format.fixedPrefixSize,
      ).set(prefix);
      return this.asGuestPtr(target);
    } catch (error) {
      // Attachment is transactional. The scratch reservation still belongs to
      // the caller, but no failed validation may leave this controller active.
      this.clearControllerState();
      throw error;
    }
  }

  private attachForReplayWithOwnership(
    moduleBuffer: number | bigint,
    ownership: ReplayOwnership,
  ): void {
    if (this.root !== 0) {
      throw new Error(`${this.label}: linked continuation already active`);
    }
    const moduleBufferNumber = this.fromGuestPtr(moduleBuffer);
    const root = moduleBufferNumber - this.format.chunkHeaderSize;
    const chunks: ContinuationChunk[] = [];
    const seen = new Set<number>();
    // WHY: address zero is reserved and each continuation mapping starts on a
    // Wasm page and occupies at least one page. The current memory therefore
    // supplies a hard upper bound without trusting a guest-controlled link.
    const maxChunks = Math.max(
      0,
      Math.floor(this.memory.buffer.byteLength / WASM_PAGE_SIZE) - 1,
    );
    let chunk = root;
    let previous = 0;
    for (;;) {
      // Check identity before dereferencing the repeated node. This rejects a
      // corrupt self- or multi-node cycle at its first repeated address.
      if (seen.has(chunk)) {
        throw new Error(`${this.label}: linked continuation chunk cycle`);
      }
      if (seen.size >= maxChunks) {
        throw new Error(`${this.label}: linked continuation chunk chain exceeds memory`);
      }
      seen.add(chunk);
      const { capacity, used } = this.validateChunk(chunk, root, previous);
      const nodeStart = chunks.length === 0
        ? alignUp(
          this.format.chunkHeaderSize + this.format.fixedPrefixSize,
          this.format.alignment,
        )
        : this.format.chunkHeaderSize;
      if (
        used < nodeStart
        || (chunks.length > 0 && used === nodeStart)
      ) {
        throw new Error(`${this.label}: invalid linked continuation chunk contents`);
      }
      chunks.push({ addr: chunk, size: capacity, nodeStart, used });
      const next = this.readPtr(chunk + 8 + 2 * this.format.ptrWidth);
      if (next === 0) {
        break;
      }
      previous = chunk;
      chunk = next;
    }
    const replayNode = this.readPtr(root + 8 + 5 * this.format.ptrWidth);
    // WHY: release() issues one munmap for every declared chunk. Distinct
    // page-aligned starts are not enough: a forged header can sit inside a
    // multi-page chunk and otherwise make us release overlapping mappings.
    const chunksByAddress = [...chunks].sort((left, right) => left.addr - right.addr);
    for (let index = 1; index < chunksByAddress.length; index++) {
      const prior = chunksByAddress[index - 1]!;
      const current = chunksByAddress[index]!;
      if (checkedEnd(prior.addr, prior.size) > current.addr) {
        throw new Error(`${this.label}: linked continuation chunk ranges overlap`);
      }
    }
    this.validateReplayTail(chunks, replayNode);
    // Publish the reconstructed owner state only after the complete guest
    // chain is valid, so a failed attachment cannot leave a partial owner.
    this.root = root;
    this.chunks = chunks;
    this.activeChunk = chunks[chunks.length - 1]!.addr;
    this.replayOwnership = ownership;
    this.setReplayCursor(replayNode);
  }

  beginReplay(): void {
    if (
      this.root === 0
      || this.pending
      || this.abortFailure
      || this.replayOwnership !== "owned"
    ) {
      throw new Error(`${this.label}: cannot begin replay from incomplete continuation`);
    }
    this.resetReplay(this.readPtr(this.root + 8 + 5 * this.format.ptrWidth));
  }

  reserveFrame(payloadSize: number | bigint): number | bigint {
    const size = this.fromGuestPtr(payloadSize);
    if (
      this.root === 0
      || this.activeChunk === 0
      || this.replayOwnership !== "owned"
    ) {
      throw new Error(`${this.label}: frame reservation outside unwind`);
    }
    if (this.pending) {
      throw new Error(`${this.label}: a frame reservation is already pending`);
    }
    if (this.abortFailure) {
      throw new Error(`${this.label}: frame reservation after abort began`);
    }
    const nodeSize = alignUp(
      this.format.nodeHeaderSize + size,
      this.format.alignment,
    );
    let chunk = this.activeChunk;
    let used = this.readPtr(chunk + 8 + 4 * this.format.ptrWidth);
    let capacity = this.readPtr(chunk + 8 + 3 * this.format.ptrWidth);
    if (nodeSize > capacity - used) {
      const nextCapacity = alignUp(
        Math.max(WASM_PAGE_SIZE, this.format.chunkHeaderSize + nodeSize),
        WASM_PAGE_SIZE,
      );
      let next: number;
      try {
        next = this.allocateChunk(nextCapacity, this.root, chunk);
      } catch (error) {
        if (error instanceof ContinuationAllocationError) {
          // WHY: a Wasm save callback cannot unwind through JavaScript with an
          // errno. The null reservation asks the instrumented guest to replay
          // and discard committed frames before the original fork returns it.
          this.beginAbortReplay(error.errno, size, error.message);
          return this.asGuestPtr(0);
        }
        this.abortAndRelease(size, error);
      }
      this.writePtr(chunk + 8 + 2 * this.format.ptrWidth, next);
      this.activeChunk = next;
      chunk = next;
      used = this.format.chunkHeaderSize;
      capacity = nextCapacity;
    }
    if (nodeSize > capacity - used) {
      throw new Error(`${this.label}: allocator returned an undersized continuation chunk`);
    }
    const node = chunk + used;
    const payload = node + this.format.nodeHeaderSize;
    const previous = this.readPtr(this.root + 8 + 5 * this.format.ptrWidth);
    const view = this.view();
    view.setUint32(node, NODE_MAGIC, true);
    view.setUint16(node + 4, LINKED_FRAME_FORMAT_VERSION, true);
    view.setUint16(node + 6, NODE_RESERVED, true);
    this.writePtr(node + 8, previous);
    this.writePtr(node + 8 + this.format.ptrWidth, size);
    this.writePtr(node + 8 + 2 * this.format.ptrWidth, nodeSize);
    this.pending = { chunk, node, payload, nextUsed: used + nodeSize };
    return this.asGuestPtr(payload);
  }

  commitFrame(payload: number | bigint): void {
    if (this.replayOwnership !== "owned") {
      throw new Error(`${this.label}: frame commit outside owned unwind`);
    }
    if (this.abortFailure) {
      throw new Error(`${this.label}: frame commit after abort began`);
    }
    const payloadNumber = this.fromGuestPtr(payload);
    const pending = this.pending;
    if (!pending || pending.payload !== payloadNumber) {
      throw new Error(`${this.label}: frame commit does not match the pending reservation`);
    }
    const active = this.chunks[this.chunks.length - 1];
    if (active?.addr !== pending.chunk) {
      throw new Error(`${this.label}: pending frame belongs to an inactive chunk`);
    }
    this.writePtr(pending.chunk + 8 + 4 * this.format.ptrWidth, pending.nextUsed);
    active.used = pending.nextUsed;
    this.view().setUint16(pending.node + 6, NODE_COMMITTED, true);
    // Publishing the new tail is the final write: replay can never observe a
    // reserved or partially populated node through the committed chain.
    this.writePtr(this.root + 8 + 5 * this.format.ptrWidth, pending.node);
    const payloadSize = this.readPtr(pending.node + 8 + this.format.ptrWidth);
    this.committedFrames++;
    this.committedBytes += BigInt(payloadSize);
    this.pending = null;
  }

  /**
   * Validate and expose the next frame without advancing the replay cursor.
   *
   * Tail-call replay selects an activation-specific resume thunk from the
   * common frame header before entering the original function. That function's
   * ordinary preamble remains the sole consumer through `nextFrame`.
   */
  peekFrame(expectedSize: number | bigint): number | bigint {
    const expected = this.fromGuestPtr(expectedSize);
    const validated = this.validateNextFrame(expected);
    return this.asGuestPtr(validated.payload);
  }

  nextFrame(expectedSize: number | bigint): number | bigint {
    const expected = this.fromGuestPtr(expectedSize);
    const validated = this.validateNextFrame(expected);
    const { node, payload, previous, nextReplay } = validated;
    this.replayNode = previous;
    this.replayChunkIndex = nextReplay.chunkIndex;
    this.replayExpectedEnd = nextReplay.expectedEnd;
    if (this.replayOwnership === "owned") {
      this.view().setUint16(node + 6, NODE_CONSUMED, true);
    }
    return this.asGuestPtr(payload);
  }

  private validateNextFrame(expected: number): ValidatedReplayNode {
    const node = this.replayNode;
    if (this.root === 0 || node === 0 || this.replayOwnership === null) {
      throw new Error(`${this.label}: linked continuation replay exhausted early`);
    }
    const chunk = this.replayChunk(node);
    const view = this.view();
    if (
      view.getUint32(node, true) !== NODE_MAGIC
      || view.getUint16(node + 4, true) !== LINKED_FRAME_FORMAT_VERSION
      || view.getUint16(node + 6, true) !== NODE_COMMITTED
    ) {
      throw new Error(`${this.label}: invalid or uncommitted linked continuation node`);
    }
    const payloadSize = this.readPtr(node + 8 + this.format.ptrWidth);
    const nodeSize = this.readPtr(node + 8 + 2 * this.format.ptrWidth);
    if (payloadSize !== expected) {
      throw new Error(
        `${this.label}: linked continuation frame size ${payloadSize} does not match ${expected}`,
      );
    }
    const nodeEnd = checkedEnd(node, nodeSize);
    if (
      nodeSize !== alignUp(this.format.nodeHeaderSize + payloadSize, this.format.alignment)
      || nodeEnd !== this.replayExpectedEnd
    ) {
      throw new Error(`${this.label}: invalid linked continuation node bounds`);
    }
    const previous = this.readPtr(node + 8);
    const nextReplay = this.previousReplayPosition(previous, node);
    return {
      node,
      payload: node + this.format.nodeHeaderSize,
      previous,
      nextReplay,
    };
  }

  finishUnwind(): void {
    if (this.pending) {
      throw new Error(`${this.label}: unwind ended with an uncommitted frame`);
    }
    if (this.root === 0 || this.replayOwnership !== "owned") {
      throw new Error(`${this.label}: unwind ended without a continuation`);
    }
  }

  finishReplayAndRelease(): void {
    if (this.replayOwnership !== "owned") {
      throw new Error(`${this.label}: borrowed replay cannot release continuation storage`);
    }
    if (this.abortFailure) {
      throw new Error(`${this.label}: normal replay ended during abort recovery`);
    }
    if (this.replayNode !== 0) {
      throw new Error(`${this.label}: rewind ended before all linked frames were consumed`);
    }
    this.release();
  }

  /** Finish a complete borrowed replay without writing or releasing storage. */
  finishBorrowedReplay(): void {
    if (this.replayOwnership !== "borrowed") {
      throw new Error(`${this.label}: no borrowed continuation replay is active`);
    }
    if (this.abortFailure) {
      throw new Error(`${this.label}: borrowed replay cannot own abort recovery`);
    }
    if (this.replayNode !== 0) {
      throw new Error(`${this.label}: rewind ended before all linked frames were read`);
    }
    this.clearControllerState();
  }

  /**
   * Drop a failed borrowed cursor without touching its owner's bytes.
   *
   * WHY: fresh-child activation or module reconstruction can trap after one
   * continuation has attached but before replay starts. The parent still owns
   * every linked node, so rollback may clear only this Worker's controller
   * state; consuming or releasing the chain would make the suspended parent
   * impossible to resume.
   */
  cancelBorrowedReplay(): void {
    if (this.replayOwnership !== "borrowed") {
      throw new Error(`${this.label}: no borrowed continuation replay is active`);
    }
    this.clearControllerState();
  }

  beginAbortReplay(
    errno: number,
    requestedFrame?: number,
    diagnostic = `fork continuation allocation failed with errno=${errno}`,
  ): void {
    if (!Number.isInteger(errno) || errno <= 0) {
      throw new Error(`${this.label}: invalid abort errno ${errno}`);
    }
    if (
      this.root === 0
      || this.pending
      || this.replayOwnership !== "owned"
    ) {
      throw new Error(`${this.label}: cannot abort-replay an incomplete continuation`);
    }
    if (this.abortFailure && this.abortFailure.errno !== errno) {
      throw new Error(`${this.label}: conflicting continuation abort failures`);
    }
    this.resetReplay(this.readPtr(this.root + 8 + 5 * this.format.ptrWidth));
    this.abortFailure ??= { errno, requestedFrame, diagnostic };
  }

  abortErrno(): number {
    if (!this.abortFailure) {
      throw new Error(`${this.label}: no continuation abort is active`);
    }
    return this.abortFailure.errno;
  }

  finishAbortReplayAndRelease(): void {
    if (this.replayOwnership !== "owned") {
      throw new Error(`${this.label}: borrowed replay cannot release abort storage`);
    }
    if (!this.abortFailure) {
      throw new Error(`${this.label}: abort replay ended without an allocation failure`);
    }
    if (this.replayNode !== 0) {
      throw new Error(`${this.label}: abort replay ended before all linked frames were consumed`);
    }
    this.release();
  }

  cancelUnwindAndRelease(): void {
    if (this.pending) {
      throw new Error(`${this.label}: cannot cancel an unwind with a pending frame`);
    }
    if (this.root === 0 || this.replayOwnership !== "owned") {
      throw new Error(`${this.label}: cannot cancel an inactive unwind`);
    }
    this.release();
  }

  abortAndRelease(requestedNextFrame?: number, cause?: unknown): never {
    if (this.replayOwnership !== "owned") {
      throw new Error(`${this.label}: borrowed replay cannot abort owned storage`);
    }
    const details = `committed_frames=${this.committedFrames} committed_bytes=${this.committedBytes}`
      + (requestedNextFrame === undefined ? "" : ` requested_next_frame=${requestedNextFrame}`)
      + (cause === undefined
        ? ""
        : ` allocator_error=${cause instanceof Error ? cause.message : String(cause)}`);
    try {
      this.release();
    } finally {
      throw new Error(`${this.label}: continuation allocation failed (${details})`);
    }
  }

  moduleBufferAddress(): number {
    if (this.root === 0) throw new Error(`${this.label}: no active linked continuation`);
    return this.root + this.format.chunkHeaderSize;
  }

  hasActiveContinuation(): boolean {
    return this.root !== 0;
  }

  private allocateChunk(capacity: number, root: number, previous: number): number {
    let addr: number;
    try {
      addr = this.allocate(capacity);
    } catch (error) {
      if (error instanceof ContinuationAllocationError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `${this.label}: continuation allocation of ${capacity} bytes failed: ${message}`,
      );
    }
    if (
      !Number.isSafeInteger(addr)
      || addr <= 0
      || addr % WASM_PAGE_SIZE !== 0
      || checkedEnd(addr, capacity) > this.memory.buffer.byteLength
    ) {
      if (Number.isSafeInteger(addr) && addr > 0) {
        try { this.deallocate(addr, capacity); } catch { /* preserve allocator diagnosis */ }
      }
      throw new Error(`${this.label}: allocator returned invalid continuation chunk 0x${addr.toString(16)}`);
    }
    const view = this.view();
    view.setUint32(addr, CHUNK_MAGIC, true);
    view.setUint16(addr + 4, LINKED_FRAME_FORMAT_VERSION, true);
    view.setUint16(addr + 6, 0, true);
    this.writePtr(addr + 8, root || addr);
    this.writePtr(addr + 8 + this.format.ptrWidth, previous);
    this.writePtr(addr + 8 + 2 * this.format.ptrWidth, 0);
    this.writePtr(addr + 8 + 3 * this.format.ptrWidth, capacity);
    this.writePtr(addr + 8 + 4 * this.format.ptrWidth, this.format.chunkHeaderSize);
    this.writePtr(addr + 8 + 5 * this.format.ptrWidth, 0);
    this.chunks.push({
      addr,
      size: capacity,
      nodeStart: this.format.chunkHeaderSize,
      used: this.format.chunkHeaderSize,
    });
    return addr;
  }

  private validateChunk(
    addr: number,
    root: number,
    previous: number,
  ): { capacity: number; used: number } {
    const view = this.view();
    if (
      !Number.isSafeInteger(addr)
      || addr <= 0
      || addr % WASM_PAGE_SIZE !== 0
      || checkedEnd(addr, this.format.chunkHeaderSize) > this.memory.buffer.byteLength
      || view.getUint32(addr, true) !== CHUNK_MAGIC
      || view.getUint16(addr + 4, true) !== LINKED_FRAME_FORMAT_VERSION
      || view.getUint16(addr + 6, true) !== 0
      || this.readPtr(addr + 8) !== root
      || this.readPtr(addr + 8 + this.format.ptrWidth) !== previous
    ) {
      throw new Error(`${this.label}: invalid linked continuation chunk at 0x${addr.toString(16)}`);
    }
    const capacity = this.readPtr(addr + 8 + 3 * this.format.ptrWidth);
    const used = this.readPtr(addr + 8 + 4 * this.format.ptrWidth);
    if (
      capacity < WASM_PAGE_SIZE
      || capacity % WASM_PAGE_SIZE !== 0
      || checkedEnd(addr, capacity) > this.memory.buffer.byteLength
      || used < this.format.chunkHeaderSize
      || used > capacity
    ) {
      throw new Error(`${this.label}: invalid linked continuation chunk bounds`);
    }
    return { capacity, used };
  }

  private validateReplayTail(
    chunks: readonly ContinuationChunk[],
    node: number,
  ): void {
    const containsFrames = chunks.some(({ nodeStart, used }) => used > nodeStart);
    // WHY: zero is the complete empty-continuation representation. Accepting a
    // zero tail for stored nodes would let replay finish and release them
    // without proving that the reverse chain covered every committed frame.
    if (node === 0) {
      if (containsFrames) {
        throw new Error(`${this.label}: nonempty linked continuation has no replay tail`);
      }
      return;
    }
    if (!containsFrames) {
      throw new Error(`${this.label}: empty linked continuation has a replay tail`);
    }

    const chunk = chunks[chunks.length - 1]!;
    const view = this.view();
    if (
      node % this.format.alignment !== 0
      || node < chunk.addr + chunk.nodeStart
      || checkedEnd(node, this.format.nodeHeaderSize) > chunk.addr + chunk.used
      || view.getUint32(node, true) !== NODE_MAGIC
      || view.getUint16(node + 4, true) !== LINKED_FRAME_FORMAT_VERSION
      || view.getUint16(node + 6, true) !== NODE_COMMITTED
    ) {
      throw new Error(`${this.label}: invalid linked continuation replay tail`);
    }
    const payloadSize = this.readPtr(node + 8 + this.format.ptrWidth);
    const nodeSize = this.readPtr(node + 8 + 2 * this.format.ptrWidth);
    if (
      nodeSize !== alignUp(this.format.nodeHeaderSize + payloadSize, this.format.alignment)
      || checkedEnd(node, nodeSize) !== chunk.addr + chunk.used
    ) {
      throw new Error(`${this.label}: invalid linked continuation replay tail bounds`);
    }
  }

  private resetReplay(node: number): void {
    // Parent and abort replay read the same guest-owned header as child
    // attachment, so they must enforce the same tail/used invariant.
    this.validateReplayTail(this.chunks, node);
    this.setReplayCursor(node);
  }

  private setReplayCursor(node: number): void {
    this.replayNode = node;
    if (node === 0) {
      this.replayChunkIndex = -1;
      this.replayExpectedEnd = 0;
      return;
    }
    this.replayChunkIndex = this.chunks.length - 1;
    const chunk = this.chunks[this.replayChunkIndex]!;
    this.replayExpectedEnd = chunk.addr + chunk.used;
  }

  private replayChunk(node: number): ContinuationChunk {
    const chunk = this.chunks[this.replayChunkIndex];
    if (
      !chunk
      || node % this.format.alignment !== 0
      || node < chunk.addr + chunk.nodeStart
      || checkedEnd(node, this.format.nodeHeaderSize) > chunk.addr + chunk.used
    ) {
      throw new Error(
        `${this.label}: frame pointer is outside the expected continuation chunk`,
      );
    }
    return chunk;
  }

  private previousReplayPosition(
    previous: number,
    node: number,
  ): { chunkIndex: number; expectedEnd: number } {
    const chunkIndex = this.replayChunkIndex;
    const chunk = this.chunks[chunkIndex]!;
    if (previous === 0) {
      // Every non-root chunk is created for, and must contain, a frame. Only
      // the root can be empty when the first frame needs a larger chunk.
      const earlierChunkHasFrames = chunkIndex > 1 || (
        chunkIndex === 1
        && this.chunks[0]!.used > this.chunks[0]!.nodeStart
      );
      if (node !== chunk.addr + chunk.nodeStart || earlierChunkHasFrames) {
        throw new Error(`${this.label}: linked continuation replay ended before its first frame`);
      }
      return { chunkIndex: -1, expectedEnd: 0 };
    }
    if (
      previous >= chunk.addr + chunk.nodeStart
      && checkedEnd(previous, this.format.nodeHeaderSize) <= chunk.addr + chunk.used
    ) {
      if (previous >= node) {
        throw new Error(`${this.label}: linked continuation nodes are not reverse ordered`);
      }
      this.validateReplayPredecessor(previous, chunk, node);
      return { chunkIndex, expectedEnd: node };
    }

    const priorChunk = this.chunks[chunkIndex - 1];
    if (
      priorChunk
      && previous >= priorChunk.addr + priorChunk.nodeStart
      && checkedEnd(previous, this.format.nodeHeaderSize) <=
        priorChunk.addr + priorChunk.used
    ) {
      // WHY: chunks are appended only when the active chunk cannot fit the
      // next frame. Reverse replay can therefore cross only from the first
      // node of one chunk to the immediately preceding chunk. This cursor
      // makes replay O(frames + chunks), independent of total chunk count.
      if (node !== chunk.addr + chunk.nodeStart) {
        throw new Error(`${this.label}: linked continuation replay skipped a frame`);
      }
      this.validateReplayPredecessor(
        previous,
        priorChunk,
        priorChunk.addr + priorChunk.used,
      );
      return {
        chunkIndex: chunkIndex - 1,
        expectedEnd: priorChunk.addr + priorChunk.used,
      };
    }
    throw new Error(
      `${this.label}: frame pointer is outside the expected continuation chunk`,
    );
  }

  private validateReplayPredecessor(
    node: number,
    chunk: ContinuationChunk,
    expectedEnd: number,
  ): void {
    const view = this.view();
    if (
      node % this.format.alignment !== 0
      || node < chunk.addr + chunk.nodeStart
      || checkedEnd(node, this.format.nodeHeaderSize) > chunk.addr + chunk.used
      || view.getUint32(node, true) !== NODE_MAGIC
      || view.getUint16(node + 4, true) !== LINKED_FRAME_FORMAT_VERSION
      || view.getUint16(node + 6, true) !== NODE_COMMITTED
    ) {
      throw new Error(`${this.label}: invalid linked continuation replay predecessor`);
    }
    const payloadSize = this.readPtr(node + 8 + this.format.ptrWidth);
    const nodeSize = this.readPtr(node + 8 + 2 * this.format.ptrWidth);
    // WHY: proving the predecessor ends exactly where the current node starts
    // detects a skipped or aliased frame before the current payload is exposed.
    if (
      nodeSize !== alignUp(this.format.nodeHeaderSize + payloadSize, this.format.alignment)
      || checkedEnd(node, nodeSize) !== expectedEnd
    ) {
      throw new Error(`${this.label}: linked continuation replay skipped a frame`);
    }
  }

  private release(): void {
    if (this.replayOwnership === "borrowed") {
      throw new Error(`${this.label}: borrowed replay cannot release continuation storage`);
    }
    const chunks = this.clearControllerState().reverse();
    let firstError: unknown;
    for (const chunk of chunks) {
      try {
        this.deallocate(chunk.addr, chunk.size);
      } catch (error) {
        firstError ??= error;
      }
    }
    if (firstError !== undefined) throw firstError;
  }

  private clearControllerState(): ContinuationChunk[] {
    const chunks = this.chunks.splice(0);
    this.pending = null;
    this.root = 0;
    this.activeChunk = 0;
    this.replayNode = 0;
    this.replayChunkIndex = -1;
    this.replayExpectedEnd = 0;
    this.abortFailure = null;
    this.replayOwnership = null;
    return chunks;
  }

  private releaseAfterFailure(error: unknown): never {
    try {
      this.release();
    } catch (releaseError) {
      throw new Error(
        `${this.label}: continuation cleanup after allocation failure failed: ` +
          `${releaseError instanceof Error ? releaseError.message : String(releaseError)}`,
      );
    }
    throw error;
  }

  private view(): DataView {
    return new DataView(this.memory.buffer);
  }

  private readPtr(addr: number): number {
    const value = this.format.ptrWidth === 8
      ? Number(this.view().getBigUint64(addr, true))
      : this.view().getUint32(addr, true);
    if (!Number.isSafeInteger(value)) {
      throw new Error(`${this.label}: continuation pointer exceeds JavaScript addressability`);
    }
    return value;
  }

  private writePtr(addr: number, value: number): void {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`${this.label}: invalid continuation pointer value ${value}`);
    }
    if (this.format.ptrWidth === 8) this.view().setBigUint64(addr, BigInt(value), true);
    else this.view().setUint32(addr, value, true);
  }

  private fromGuestPtr(value: number | bigint): number {
    return checkedWasmGuestPointerOffset(
      value,
      this.format.ptrWidth,
      `${this.label}: linked continuation`,
    );
  }

  private asGuestPtr(value: number): number | bigint {
    return this.format.ptrWidth === 8 ? BigInt(value) : value;
  }
}
