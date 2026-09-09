// Staying glue extracted from `fork-reference-transaction.ts` (Path-A A2).
//
// The scratch-mapping engine and the linear-memory I/O helpers are NOT
// reference-engine logic: they are the host's stack-disciplined transient
// allocator over the one process memory copied by fork, plus bounds-checked
// byte reads/writes into guest memory. Both the (still-live, flag-off +
// peer-table) `ForkReferenceTransaction` and the module-driven fork capture
// session share this infrastructure, so it lives in its own staying module
// rather than inside the deletable JS reference engine. It holds NO reference
// identity and drives no `fm_*` surface — it is pure host memory management.

/** Reserve a page-aligned transient guest region; returns its guest offset. */
export type ForkReferenceScratchAllocate = (size: number) => number;
/** Release a region previously returned by {@link ForkReferenceScratchAllocate}. */
export type ForkReferenceScratchDeallocate = (addr: number, size: number) => void;

interface ScratchChunk {
  readonly addr: number;
  readonly size: number;
  used: number;
}

interface ScratchReservation {
  readonly addr: number;
  readonly requestedSize: number;
  readonly alignedSize: number;
  readonly previousUsed: number;
  readonly chunk: ScratchChunk;
}

/**
 * Stack-disciplined transient allocator + bounds-checked linear-memory I/O over
 * the one process memory a fork copies.
 *
 * Reservations are stack-disciplined because generated codecs recurse while
 * walking reference payloads. A retained page amortizes the common case;
 * unusually large or deeply nested payloads allocate extra page-rounded chunks
 * and release them as soon as their nested scope returns.
 *
 * This class does NOT enforce the owner's transaction phase — the caller guards
 * phase before reserving/releasing, exactly as the original inline methods did.
 */
export class ForkReferenceScratchArena {
  private readonly scratchChunks: ScratchChunk[] = [];
  private readonly scratchReservations: ScratchReservation[] = [];
  private scratchCapacityBytes = 0;
  private scratchCapacityHighWaterBytes = 0;

  constructor(
    private readonly memory: WebAssembly.Memory | undefined,
    private readonly allocateScratch: ForkReferenceScratchAllocate | undefined,
    private readonly deallocateScratch: ForkReferenceScratchDeallocate | undefined,
    private readonly label: string,
  ) {}

  /** Peak simultaneously-mapped scratch capacity in bytes since the last reset. */
  get highWaterBytes(): number {
    return this.scratchCapacityHighWaterBytes;
  }

  /** Count of reservations not yet released (a seal/adopt must see zero). */
  get liveReservationCount(): number {
    return this.scratchReservations.length;
  }

  requireMemory(): WebAssembly.Memory {
    if (!this.memory) {
      throw new Error("fork reference transaction has no staging memory");
    }
    return this.memory;
  }

  reserve(size: number | bigint): number {
    const requestedSize = this.checkedScratchSize(size);
    const alignedSize = this.alignScratch(requestedSize);
    let chunk = this.scratchChunks[this.scratchChunks.length - 1];
    if (!chunk || alignedSize > chunk.size - chunk.used) {
      const allocate = this.allocateScratch;
      if (!allocate || !this.deallocateScratch) {
        throw new Error(`${this.label} has no scratch mapping owner`);
      }
      const chunkSize = this.alignScratch(Math.max(65_536, alignedSize), 65_536);
      const addr = allocate(chunkSize);
      if (
        !Number.isSafeInteger(addr)
        || addr <= 0
        || addr % 16 !== 0
        || addr > this.requireMemory().buffer.byteLength - chunkSize
      ) {
        if (Number.isSafeInteger(addr) && addr > 0) {
          try {
            this.deallocateScratch(addr, chunkSize);
          } catch {
            // Preserve the allocator contract violation.
          }
        }
        throw new RangeError(
          `${this.label} scratch allocator returned an invalid mapping`,
        );
      }
      chunk = { addr, size: chunkSize, used: 0 };
      this.scratchChunks.push(chunk);
      this.scratchCapacityBytes += chunkSize;
      this.scratchCapacityHighWaterBytes = Math.max(
        this.scratchCapacityHighWaterBytes,
        this.scratchCapacityBytes,
      );
    }
    const previousUsed = chunk.used;
    const addr = chunk.addr + previousUsed;
    chunk.used += alignedSize;
    new Uint8Array(this.requireMemory().buffer, addr, alignedSize).fill(0);
    this.scratchReservations.push({
      addr,
      requestedSize,
      alignedSize,
      previousUsed,
      chunk,
    });
    return addr;
  }

  release(pointer: number | bigint, size: number | bigint): void {
    const addr = this.checkedScratchPointer(pointer);
    const requestedSize = this.checkedScratchSize(size);
    const reservation = this.scratchReservations.pop();
    if (
      !reservation
      || reservation.addr !== addr
      || reservation.requestedSize !== requestedSize
    ) {
      if (reservation) this.scratchReservations.push(reservation);
      throw new Error(
        `${this.label} scratch release is not the most recent reservation`,
      );
    }
    new Uint8Array(
      this.requireMemory().buffer,
      reservation.addr,
      reservation.alignedSize,
    ).fill(0);
    reservation.chunk.used = reservation.previousUsed;

    const tail = this.scratchChunks[this.scratchChunks.length - 1];
    if (
      tail === reservation.chunk
      && tail.used === 0
      && this.scratchChunks.length > 1
    ) {
      this.scratchChunks.pop();
      this.scratchCapacityBytes -= tail.size;
      this.deallocateScratch!(tail.addr, tail.size);
    }
  }

  readBytes(
    pointer: number | bigint,
    byteLength: number,
    context: string,
  ): Uint8Array {
    const { offset, length } = this.memoryRange(pointer, byteLength, context);
    return new Uint8Array(
      new Uint8Array(this.requireMemory().buffer, offset, length),
    );
  }

  writeBytes(
    pointer: number | bigint,
    bytes: Uint8Array,
    context: string,
  ): void {
    const { offset } = this.memoryRange(pointer, bytes.byteLength, context);
    new Uint8Array(this.requireMemory().buffer, offset, bytes.byteLength).set(bytes);
  }

  memoryRange(
    pointer: number | bigint,
    byteLength: number,
    context: string,
  ): { offset: number; length: number } {
    this.assertU32(byteLength, `${context} byte length`);
    const offset = typeof pointer === "bigint" ? Number(pointer) : pointer;
    if (
      !Number.isSafeInteger(offset)
      || offset < 0
      || (typeof pointer === "bigint" && BigInt(offset) !== pointer)
    ) {
      throw new RangeError(`${context} has an invalid guest pointer`);
    }
    const memoryLength = this.requireMemory().buffer.byteLength;
    if (offset > memoryLength || byteLength > memoryLength - offset) {
      throw new RangeError(`${context} exceeds WebAssembly memory`);
    }
    return { offset, length: byteLength };
  }

  /**
   * Zero and release every mapping this arena owns and reset its bookkeeping.
   *
   * Best-effort dealloc: every chunk is attempted even if one throws. Returns
   * the first dealloc error (or `undefined`) so the owner can finish its own
   * teardown before rethrowing — preserving the original `clear()` ordering.
   */
  reset(): unknown {
    // An exception or host callback may have aborted between reserve/release.
    // Zero every arena-owned byte before returning its mappings.
    for (const chunk of this.scratchChunks) {
      new Uint8Array(this.requireMemory().buffer, chunk.addr, chunk.size).fill(0);
    }
    this.scratchReservations.length = 0;
    const chunks = this.scratchChunks.splice(0).reverse();
    this.scratchCapacityBytes = 0;
    this.scratchCapacityHighWaterBytes = 0;
    let firstScratchError: unknown;
    for (const chunk of chunks) {
      try {
        this.deallocateScratch?.(chunk.addr, chunk.size);
      } catch (error) {
        firstScratchError ??= error;
      }
    }
    return firstScratchError;
  }

  private assertU32(value: number, context: string): void {
    if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) {
      throw new RangeError(`${context} is not a u32`);
    }
  }

  private checkedScratchPointer(value: number | bigint): number {
    const result = typeof value === "bigint" ? Number(value) : value;
    if (
      !Number.isSafeInteger(result)
      || result <= 0
      || (typeof value === "bigint" && BigInt(result) !== value)
    ) {
      throw new RangeError(`${this.label} scratch pointer is invalid`);
    }
    return result;
  }

  private checkedScratchSize(value: number | bigint): number {
    const result = typeof value === "bigint" ? Number(value) : value;
    if (
      !Number.isSafeInteger(result)
      || result <= 0
      || result > 0xffff_ffff
      || (typeof value === "bigint" && BigInt(result) !== value)
    ) {
      throw new RangeError(`${this.label} scratch size is not a nonzero u32`);
    }
    return result;
  }

  private alignScratch(value: number, alignment = 16): number {
    const result = Math.ceil(value / alignment) * alignment;
    if (!Number.isSafeInteger(result) || result < value) {
      throw new RangeError(`${this.label} scratch alignment overflow`);
    }
    return result;
  }
}
