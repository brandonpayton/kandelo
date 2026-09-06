import { describe, it, expect } from "vitest";
import { ThreadPageAllocator } from "../src/thread-allocator";
import { WASM_PAGE_SIZE, PAGES_PER_THREAD, CH_TOTAL_SIZE } from "../src/constants";

const MAX_PAGES = 256;
const FIRST_THREAD_SLOT_PAGE = 24;
const THREAD_ARENA_END_PAGE = 64;

function makeAllocator(): ThreadPageAllocator {
  return new ThreadPageAllocator({
    firstSlotStartPage: FIRST_THREAD_SLOT_PAGE,
    maxPageExclusive: THREAD_ARENA_END_PAGE,
  });
}

function makeMemory(initial = FIRST_THREAD_SLOT_PAGE): WebAssembly.Memory {
  return new WebAssembly.Memory({ initial, maximum: MAX_PAGES, shared: true });
}

describe("ThreadPageAllocator", () => {
  it("allocates upward in the process control arena", () => {
    const alloc = makeAllocator();
    const mem = makeMemory();
    const t = alloc.allocate(mem);

    expect(t.slotStartPage).toBe(FIRST_THREAD_SLOT_PAGE);
    expect(t.channelOffset).toBe((FIRST_THREAD_SLOT_PAGE + 2) * WASM_PAGE_SIZE);
    expect(t.tlsOffset).toBe(FIRST_THREAD_SLOT_PAGE * WASM_PAGE_SIZE);
    expect(t.forkSaveOffset).toBe((FIRST_THREAD_SLOT_PAGE + 1) * WASM_PAGE_SIZE);
  });

  it("allocates consecutive threads upward", () => {
    const alloc = makeAllocator();
    const mem = makeMemory();
    const t1 = alloc.allocate(mem);
    const t2 = alloc.allocate(mem);

    expect(t2.slotStartPage).toBe(t1.slotStartPage + PAGES_PER_THREAD);
    expect(t2.channelOffset).toBe((t2.slotStartPage + 2) * WASM_PAGE_SIZE);
  });

  it("reuses freed pages", () => {
    const alloc = makeAllocator();
    const mem = makeMemory();
    const t1 = alloc.allocate(mem);
    const t2 = alloc.allocate(mem);

    alloc.free(t1.slotStartPage);
    const t3 = alloc.allocate(mem);

    // t3 should reuse t1's pages
    expect(t3.slotStartPage).toBe(t1.slotStartPage);
    expect(t3.channelOffset).toBe(t1.channelOffset);
  });

  it("zeros channel and TLS regions on allocate", () => {
    const alloc = makeAllocator();
    const mem = makeMemory(THREAD_ARENA_END_PAGE);

    // Write non-zero data where the allocation will go
    const offset = (FIRST_THREAD_SLOT_PAGE + 2) * WASM_PAGE_SIZE;
    new Uint8Array(mem.buffer, offset, 16).fill(0xff);

    const t = alloc.allocate(mem);

    // Channel region should be zeroed
    const channelBytes = new Uint8Array(mem.buffer, t.channelOffset, CH_TOTAL_SIZE);
    expect(channelBytes.every(b => b === 0)).toBe(true);

    // TLS region should be zeroed
    const tlsBytes = new Uint8Array(mem.buffer, t.tlsOffset, WASM_PAGE_SIZE);
    expect(tlsBytes.every(b => b === 0)).toBe(true);
  });

  it("zeros reused pages", () => {
    const alloc = makeAllocator();
    const mem = makeMemory();
    const t1 = alloc.allocate(mem);

    // Write data into allocated region
    new Uint8Array(mem.buffer, t1.channelOffset, 16).fill(0xab);
    new Uint8Array(mem.buffer, t1.tlsOffset, 16).fill(0xcd);

    alloc.free(t1.slotStartPage);
    const t2 = alloc.allocate(mem);

    // Reused allocation should be zeroed
    const channelBytes = new Uint8Array(mem.buffer, t2.channelOffset, CH_TOTAL_SIZE);
    expect(channelBytes.every(b => b === 0)).toBe(true);
    const tlsBytes = new Uint8Array(mem.buffer, t2.tlsOffset, WASM_PAGE_SIZE);
    expect(tlsBytes.every(b => b === 0)).toBe(true);
  });

  it("free list is LIFO", () => {
    const alloc = makeAllocator();
    const mem = makeMemory();
    const t1 = alloc.allocate(mem);
    const t2 = alloc.allocate(mem);
    const t3 = alloc.allocate(mem);

    alloc.free(t1.slotStartPage);
    alloc.free(t2.slotStartPage);

    // Should get t2 first (LIFO), then t1
    const r1 = alloc.allocate(mem);
    const r2 = alloc.allocate(mem);
    expect(r1.slotStartPage).toBe(t2.slotStartPage);
    expect(r2.slotStartPage).toBe(t1.slotStartPage);

    // Next allocation should continue top-down from where t3 left off
    const r3 = alloc.allocate(mem);
    expect(r3.slotStartPage).toBe(t3.slotStartPage + PAGES_PER_THREAD);
  });

  it("grows memory only far enough to cover the allocated control pages", () => {
    const alloc = makeAllocator();
    const mem = makeMemory(8);

    const t = alloc.allocate(mem);

    expect(mem.buffer.byteLength).toBe((t.slotStartPage + PAGES_PER_THREAD) * WASM_PAGE_SIZE);
    expect(mem.buffer.byteLength).toBeLessThan(MAX_PAGES * WASM_PAGE_SIZE);
  });

  it("throws when the thread control arena is exhausted", () => {
    const alloc = new ThreadPageAllocator({
      firstSlotStartPage: 24,
      maxPageExclusive: 25,
    });
    const mem = makeMemory();

    expect(() => alloc.allocate(mem)).toThrow(/pthread slot limit exhausted/);
  });

  it("dynamically reserves slots when configured", () => {
    let nextPage = 128;
    let reservations = 0;
    const alloc = new ThreadPageAllocator({
      firstSlotStartPage: FIRST_THREAD_SLOT_PAGE,
      maxPageExclusive: FIRST_THREAD_SLOT_PAGE,
      reservedSlots: 2,
      reserveSlotStartPage: () => {
        reservations++;
        const page = nextPage;
        nextPage += PAGES_PER_THREAD;
        return page;
      },
    });
    const mem = makeMemory();

    const t1 = alloc.allocate(mem);
    const t2 = alloc.allocate(mem);

    expect(t1.slotStartPage).toBe(128);
    expect(t2.slotStartPage).toBe(128 + PAGES_PER_THREAD);
    expect(reservations).toBe(2);
    expect(mem.buffer.byteLength).toBe((t2.slotStartPage + PAGES_PER_THREAD) * WASM_PAGE_SIZE);
    expect(() => alloc.allocate(mem)).toThrow(/pthread slot limit exhausted/);
  });

  it("reuses dynamic slots without reserving a new host range", () => {
    let nextPage = 128;
    let reservations = 0;
    const alloc = new ThreadPageAllocator({
      firstSlotStartPage: FIRST_THREAD_SLOT_PAGE,
      maxPageExclusive: FIRST_THREAD_SLOT_PAGE,
      reservedSlots: 2,
      reserveSlotStartPage: () => {
        reservations++;
        const page = nextPage;
        nextPage += PAGES_PER_THREAD;
        return page;
      },
    });
    const mem = makeMemory();

    const t1 = alloc.allocate(mem);
    const t2 = alloc.allocate(mem);
    alloc.free(t1.slotStartPage);

    const reused = alloc.allocate(mem);

    expect(reused.slotStartPage).toBe(t1.slotStartPage);
    expect(t2.slotStartPage).toBe(128 + PAGES_PER_THREAD);
    expect(reservations).toBe(2);
  });

  it("reserves vfork host control for a zero-pthread process", () => {
    let nextPage = 128;
    const alloc = new ThreadPageAllocator({
      firstSlotStartPage: FIRST_THREAD_SLOT_PAGE,
      maxPageExclusive: FIRST_THREAD_SLOT_PAGE,
      reservedSlots: 0,
      reserveSlotStartPage: () => {
        const page = nextPage;
        nextPage += PAGES_PER_THREAD;
        return page;
      },
    });
    const mem = makeMemory();

    const control = alloc.allocateHostControl(mem);

    expect(control.slotStartPage).toBe(128);
    expect(() => alloc.allocate(mem)).toThrow(/pthread slot limit exhausted/);
  });

  it("does not charge host control against the pthread quota", () => {
    let nextPage = 128;
    const alloc = new ThreadPageAllocator({
      firstSlotStartPage: FIRST_THREAD_SLOT_PAGE,
      maxPageExclusive: FIRST_THREAD_SLOT_PAGE,
      reservedSlots: 1,
      reserveSlotStartPage: () => {
        const page = nextPage;
        nextPage += PAGES_PER_THREAD;
        return page;
      },
    });
    const mem = makeMemory();

    const control = alloc.allocateHostControl(mem);
    const pthread = alloc.allocate(mem);
    expect(control.slotStartPage).toBe(128);
    expect(pthread.slotStartPage).toBe(128 + PAGES_PER_THREAD);
    expect(() => alloc.allocate(mem)).toThrow(/pthread slot limit exhausted/);

    alloc.free(control.slotStartPage);
    expect(() => alloc.allocate(mem)).toThrow(/pthread slot limit exhausted/);
    alloc.free(pthread.slotStartPage);
    expect(alloc.allocate(mem).slotStartPage).toBe(pthread.slotStartPage);
  });

  it("snapshots the state a checkpoint carries beside the process memory", () => {
    const alloc = makeAllocator();
    const mem = makeMemory();
    expect(alloc.snapshotState()).toEqual({
      nextPage: FIRST_THREAD_SLOT_PAGE,
      freePages: [],
      activeCount: 0,
      hostControlPages: [],
    });

    const first = alloc.allocate(mem);
    alloc.allocate(mem);
    const control = alloc.allocateHostControl(mem);
    alloc.free(first.slotStartPage);

    expect(alloc.snapshotState()).toEqual({
      nextPage: FIRST_THREAD_SLOT_PAGE + 3 * PAGES_PER_THREAD,
      freePages: [first.slotStartPage],
      activeCount: 1,
      hostControlPages: [control.slotStartPage],
    });
  });

  it("detaches the snapshot from later allocations", () => {
    const alloc = makeAllocator();
    const mem = makeMemory();
    const slot = alloc.allocate(mem);
    alloc.free(slot.slotStartPage);
    const snapshot = alloc.snapshotState();

    alloc.allocate(mem);
    expect(snapshot.freePages).toEqual([slot.slotStartPage]);
    expect(snapshot.activeCount).toBe(0);
  });
});
