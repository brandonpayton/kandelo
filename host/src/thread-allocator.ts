import { CH_TOTAL_SIZE, WASM_PAGE_SIZE, PAGES_PER_THREAD } from "./constants";
import { FORK_SAVE_BUFFER_SIZE, growMemoryToCover } from "./process-memory";
import {
  PROCESS_MEMORY_THREAD_SLOT_CHANNEL_PRIMARY_PAGE,
  PROCESS_MEMORY_THREAD_SLOT_FORK_SAVE_PAGE,
  PROCESS_MEMORY_THREAD_SLOT_TLS_PAGE,
} from "./generated/abi";

export interface ThreadAllocation {
  /** Start page of the pthread slot. */
  slotStartPage: number;
  /** @deprecated Use slotStartPage. */
  basePage: number;
  /** Byte offset of the TLS/control page in Memory. */
  tlsOffset: number;
  /** Byte offset of the per-thread fork-save/scratch page in Memory. */
  forkSaveOffset: number;
  /** Byte offset of the channel in Memory */
  channelOffset: number;
  /** @deprecated Use tlsOffset. */
  tlsAllocAddr: number;
}

/**
 * The allocator state a byte copy of process memory does not carry.
 *
 * The slot pages live in linear memory, but which of them are handed out lives
 * in this host object. A process restored without it reallocates a live
 * thread's pages.
 */
export interface ThreadPageAllocatorState {
  /** Next slot start page when neither a free slot nor a reserver supplies one. */
  readonly nextPage: number;
  /** Slot start pages returned by an exited thread, newest last. */
  readonly freePages: readonly number[];
  /** Slots counted against the process pthread quota. */
  readonly activeCount: number;
  /**
   * Slot start pages held outside the pthread quota, so `free` returns them
   * without crediting the quota. A vfork child's control slot is one.
   */
  readonly hostControlPages: readonly number[];
}

export interface ThreadPageAllocatorOptions {
  /** First page whose start address begins a pthread slot. */
  firstSlotStartPage?: number;
  /** @deprecated First page whose start address holds a thread channel. */
  firstBasePage?: number;
  /** Exclusive upper page bound for control-arena allocations. */
  maxPageExclusive: number;
  /** Pointer width of the process memory, used when growing memory64. */
  ptrWidth?: 4 | 8;
  /** Maximum concurrent pthread slots for this process. */
  reservedSlots?: number;
  /** Dynamically reserve a fresh pthread slot start page when no free slot exists. */
  reserveSlotStartPage?: () => number;
}

/**
 * Manages pthread channel/TLS allocation within a process WebAssembly.Memory.
 *
 * New process launches reserve only the main-thread control pages. Pthread
 * slots are either allocated from a fixed compatibility arena or dynamically
 * reserved in the process address space by the kernel worker.
 *
 * Per-thread slot layout:
 *   slotStart+0 - TLS/control page
 *   slotStart+1 - fork-save/scratch page
 *   slotStart+2 - syscall channel primary page
 *   slotStart+3 - syscall channel spill page
 */
export class ThreadPageAllocator {
  private nextPage: number;
  private freePages: number[] = [];
  private readonly maxPageExclusive: number;
  private readonly direction: "up" | "down";
  private readonly ptrWidth: 4 | 8;
  private readonly reservedSlots: number;
  private readonly reserveSlotStartPage?: () => number;
  private activeCount = 0;
  private readonly hostControlPages = new Set<number>();

  constructor(options: ThreadPageAllocatorOptions);
  constructor(maxPages: number);
  constructor(options: ThreadPageAllocatorOptions | number) {
    if (typeof options === "number") {
      // Back-compatibility for existing external users of the old allocator.
      this.nextPage =
        options - 2 - PAGES_PER_THREAD - PROCESS_MEMORY_THREAD_SLOT_CHANNEL_PRIMARY_PAGE;
      this.maxPageExclusive = options;
      this.direction = "down";
      this.ptrWidth = 4;
      this.reservedSlots = Math.max(0, Math.floor(options / PAGES_PER_THREAD));
      this.reserveSlotStartPage = undefined;
    } else {
      if (options.firstSlotStartPage !== undefined) {
        this.nextPage = options.firstSlotStartPage;
      } else if (options.firstBasePage !== undefined) {
        this.nextPage =
          options.firstBasePage - PROCESS_MEMORY_THREAD_SLOT_CHANNEL_PRIMARY_PAGE;
      } else {
        throw new Error("ThreadPageAllocator requires firstSlotStartPage");
      }
      this.maxPageExclusive = options.maxPageExclusive;
      this.direction = "up";
      this.ptrWidth = options.ptrWidth ?? 4;
      this.reservedSlots = options.reservedSlots ?? Math.max(
        0,
        Math.floor((this.maxPageExclusive - this.nextPage) / PAGES_PER_THREAD),
      );
      this.reserveSlotStartPage = options.reserveSlotStartPage;
    }
  }

  /** Allocate pages for a new thread. Zeros the channel and TLS regions. */
  allocate(memory: WebAssembly.Memory): ThreadAllocation {
    return this.allocateSlot(memory, false);
  }

  /**
   * Allocate a host-owned control slot outside the guest pthread quota.
   *
   * WHY: a single-threaded executable can truthfully declare zero pthread
   * slots and still call vfork. Its borrowing child needs an independent
   * syscall channel, replay prefix, and scratch page, but that platform state
   * must neither require nor consume capacity promised to pthread_create.
   */
  allocateHostControl(memory: WebAssembly.Memory): ThreadAllocation {
    return this.allocateSlot(memory, true);
  }

  private allocateSlot(
    memory: WebAssembly.Memory,
    hostControl: boolean,
  ): ThreadAllocation {
    if (!hostControl && this.activeCount >= this.reservedSlots) {
      throw new Error(
        `process pthread slot limit exhausted (limit=${this.reservedSlots}, ` +
          `active=${this.activeCount}). Rebuild with --kandelo-thread-slots=N ` +
          "or increase the host defaultThreadSlots setting.",
      );
    }

    let slotStartPage: number;
    if (this.freePages.length > 0) {
      slotStartPage = this.freePages.pop()!;
    } else if (this.reserveSlotStartPage) {
      slotStartPage = this.reserveSlotStartPage();
    } else {
      slotStartPage = this.nextPage;
      if (this.direction === "up") {
        this.nextPage += PAGES_PER_THREAD;
      } else {
        this.nextPage -= PAGES_PER_THREAD;
      }
    }

    if (!this.reserveSlotStartPage && (
      slotStartPage < 0 ||
      slotStartPage + PAGES_PER_THREAD > this.maxPageExclusive
    )) {
      throw new Error(
        `process pthread slot limit exhausted (limit=${this.reservedSlots}, ` +
          `active=${this.activeCount}). Rebuild with --kandelo-thread-slots=N ` +
          "or increase the host defaultThreadSlots setting.",
      );
    }

    const tlsOffset =
      (slotStartPage + PROCESS_MEMORY_THREAD_SLOT_TLS_PAGE) * WASM_PAGE_SIZE;
    const forkSaveOffset =
      (slotStartPage + PROCESS_MEMORY_THREAD_SLOT_FORK_SAVE_PAGE) * WASM_PAGE_SIZE;
    const channelOffset =
      (slotStartPage + PROCESS_MEMORY_THREAD_SLOT_CHANNEL_PRIMARY_PAGE) * WASM_PAGE_SIZE;
    growMemoryToCover(
      memory,
      (slotStartPage + PAGES_PER_THREAD) * WASM_PAGE_SIZE,
      this.ptrWidth,
    );

    // Zero channel, TLS, and the per-thread fork save buffer.
    new Uint8Array(memory.buffer, channelOffset, CH_TOTAL_SIZE).fill(0);
    new Uint8Array(memory.buffer, tlsOffset, WASM_PAGE_SIZE).fill(0);
    new Uint8Array(memory.buffer, forkSaveOffset, WASM_PAGE_SIZE).fill(0);
    new Uint8Array(memory.buffer, forkSaveOffset, FORK_SAVE_BUFFER_SIZE).fill(0);

    if (hostControl) this.hostControlPages.add(slotStartPage);
    else this.activeCount++;
    return {
      slotStartPage,
      basePage: slotStartPage,
      tlsOffset,
      forkSaveOffset,
      channelOffset,
      tlsAllocAddr: tlsOffset,
    };
  }

  /** Copy the state a checkpoint must carry alongside the process memory. */
  snapshotState(): ThreadPageAllocatorState {
    return {
      nextPage: this.nextPage,
      freePages: [...this.freePages],
      activeCount: this.activeCount,
      hostControlPages: [...this.hostControlPages],
    };
  }

  /** Return pages to the free list after thread exit. */
  free(slotStartPage: number): void {
    this.freePages.push(slotStartPage);
    if (!this.hostControlPages.delete(slotStartPage)) {
      this.activeCount = Math.max(0, this.activeCount - 1);
    }
  }
}
