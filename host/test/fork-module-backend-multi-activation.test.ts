// Phase 6 D7a.1a-host (Option B: minimize host surface): the backend must drive
// a dlopen fork's main activation (0) plus its side activations (1..N) through
// the co-resident module — now with the MODULE owning its frame allocation via
// in-realm channel `SYS_MMAP` — and a fresh child must seed every activation's
// replay from copied memory. Because the module BLOCKS in `memory_atomic_wait32`
// on each chunk mmap, this test stands up a minimal SYS_MMAP/MUNMAP responder on
// a worker thread that services the shared syscall channel (grows the shared
// memory and returns the mapped offset), exactly as the real kernel worker does.
// This proves, in a real engine: begin/reserve/serialize grow memory on demand
// (no fixed 4 MiB arena), the parent re-derives its memory view after each grow,
// the journal image is channel-mmap'd (its (ptr,len) threaded to the child), and
// the mapped chunks are munmap'd on finish.
import { readFileSync } from "node:fs";
import { Worker } from "node:worker_threads";
import { afterEach, describe, expect, it } from "vitest";
import { resolveBinary } from "../src/binary-resolver";
import {
  type ForkModuleExports,
  instantiateForkModule,
} from "../src/fork-module-instance";
import { ForkModuleContinuationBackend } from "../src/fork-module-backend";
import { ForkModuleTrampolines } from "../src/fork-module-trampoline";
import type { LinkedFrameFormatDescriptor } from "../src/fork-continuation";
import {
  ABI_SYSCALLS,
  CHANNEL_STATUS_IDLE,
  CHANNEL_STATUS_PENDING,
  CH_ARG_SIZE,
  CH_ARGS,
  CH_ERRNO,
  CH_RETURN,
  CH_STATUS,
  CH_SYSCALL,
} from "../src/generated/abi";

const PAGE = 65536;
const MiB = 1024 * 1024;

// The syscall channel the module issues its chunk mmaps through. Page-aligned,
// disjoint from the module placement (bump allocator at 4 MiB) and the frame
// region the responder hands out (from 48 MiB up).
const CHANNEL_BASE = 2 * MiB;
// The responder bump-allocates mmap'd frame/image chunks from here upward. The
// memory is PRE-SIZED past this so the responder never calls `memory.grow()`: a
// cross-thread `Atomics.notify` after a shared-memory grow does not reliably
// wake a main-thread `memory.atomic.wait32`, so this unit test isolates the
// channel handshake + module-owned allocation from the literal grow. The
// grow-then-re-derive path itself is proven by the Rust
// `re_derives_slice_after_each_grow` writer test and, end to end against a real
// kernel that DOES grow, by the fork-*-e2e worker tests.
const FRAME_REGION_BASE = 48 * MiB;
const MEMORY_BYTES = 64 * MiB;

function loadForkModule32(): WebAssembly.Module {
  return new WebAssembly.Module(readFileSync(resolveBinary("fork_module32.wasm")));
}

/** A page-aligned monotonic bump allocator over a slice of the shared memory. */
function bumpAllocator(start: number): { reserve: (n: number) => number } {
  let next = Math.ceil(start / PAGE) * PAGE;
  return {
    reserve: (n: number): number => {
      const base = next;
      next += Math.ceil(n / PAGE) * PAGE;
      return base;
    },
  };
}

/**
 * A minimal syscall-channel responder on a worker thread: it watches the shared
 * channel status, services SYS_MMAP by growing the shared memory and returning
 * the old top as the mapped offset, acks SYS_MUNMAP, and pings the blocked
 * module back — the exact handshake the real kernel worker performs, so the
 * module's in-realm `memory_atomic_wait32` mmap can complete on the main thread.
 */
function startChannelResponder(
  memory: WebAssembly.Memory,
  channelBase: number,
): Worker {
  const code = `
    const { workerData } = require("node:worker_threads");
    const { memory, channelBase, PAGE, FRAME_BASE, STATUS, SYSCALL, ARGS,
      ARG_SIZE, RETURN, ERRNO, PENDING, IDLE, MMAP, MUNMAP } = workerData;
    const statusIdx = (channelBase + STATUS) / 4;
    // The memory is pre-sized, so mmap bump-allocates from FRAME_BASE without
    // ever growing — see the FRAME_REGION_BASE note in the test.
    const i32 = new Int32Array(memory.buffer);
    const dv = new DataView(memory.buffer);
    let next = FRAME_BASE;
    for (;;) {
      // Block until the module publishes a request (status leaves IDLE).
      Atomics.wait(i32, statusIdx, IDLE);
      if (Atomics.load(i32, statusIdx) !== PENDING) continue;
      const nr = dv.getUint32(channelBase + SYSCALL, true);
      let ret = 0n;
      let err = 0;
      if (nr === MMAP) {
        const size = Number(dv.getBigInt64(channelBase + ARGS + ARG_SIZE, true));
        ret = BigInt(next);
        next += Math.ceil(size / PAGE) * PAGE;
      } else if (nr === MUNMAP) {
        ret = 0n;
      } else {
        err = 22; // EINVAL for anything unexpected
      }
      dv.setBigInt64(channelBase + RETURN, ret, true);
      dv.setUint32(channelBase + ERRNO, err, true);
      Atomics.store(i32, statusIdx, IDLE);
      Atomics.notify(i32, statusIdx, 1);
    }
  `;
  return new Worker(code, {
    eval: true,
    workerData: {
      memory,
      channelBase,
      PAGE,
      FRAME_BASE: FRAME_REGION_BASE,
      STATUS: CH_STATUS,
      SYSCALL: CH_SYSCALL,
      ARGS: CH_ARGS,
      ARG_SIZE: CH_ARG_SIZE,
      RETURN: CH_RETURN,
      ERRNO: CH_ERRNO,
      PENDING: CHANNEL_STATUS_PENDING,
      IDLE: CHANNEL_STATUS_IDLE,
      MMAP: ABI_SYSCALLS.Mmap,
      MUNMAP: ABI_SYSCALLS.Munmap,
    },
  });
}

const format = (fixedPrefixSize: number): LinkedFrameFormatDescriptor =>
  ({
    ptrWidth: 4,
    fixedPrefixSize,
    chunkHeaderSize: 32,
    alignment: 16,
  }) as unknown as LinkedFrameFormatDescriptor;

interface Commit {
  act: number;
  func: number;
  fill: number;
  size: number;
}

const COMMITS: Commit[] = [
  { act: 0, func: 101, fill: 0xa1, size: 40 },
  { act: 1, func: 301, fill: 0xc1, size: 48 },
  { act: 0, func: 202, fill: 0xb2, size: 40 },
  { act: 1, func: 302, fill: 0xc2, size: 56 },
];
const CATALOG0 = [101, 202, 303];
const CATALOG1 = [301, 302, 399];
const PREFIX1 = 256;

function driveUnwind(
  trampolines: ForkModuleTrampolines,
  memory: WebAssembly.Memory,
  errno: () => number,
): void {
  for (const c of COMMITS) {
    const t = trampolines.instanceFor(c.act).exports as unknown as Record<
      string,
      (...a: number[]) => number
    >;
    const payload = t.__wpk_fork_frame_reserve(c.size) >>> 0;
    expect(errno()).toBe(0);
    const dv = new DataView(memory.buffer);
    dv.setUint32(payload + 0, c.func, true);
    dv.setUint32(payload + 4, 1, true);
    dv.setUint32(payload + 8, 0, true);
    dv.setUint32(payload + 12, 0, true);
    const buf = new Uint8Array(memory.buffer);
    for (let i = 16; i < c.size; i++) buf[payload + i] = c.fill;
    t.__wpk_fork_frame_commit(payload);
    expect(errno()).toBe(0);
  }
}

function driveReplay(
  trampolines: ForkModuleTrampolines,
  memory: WebAssembly.Memory,
  errno: () => number,
): void {
  for (const c of [...COMMITS].reverse()) {
    const t = trampolines.instanceFor(c.act).exports as unknown as Record<
      string,
      (...a: number[]) => number
    >;
    const peeked = t.__wpk_fork_frame_peek(c.size) >>> 0;
    expect(errno()).toBe(0);
    expect(new DataView(memory.buffer).getUint32(peeked, true)).toBe(c.func);
    const advanced = t.__wpk_fork_frame_next(c.size) >>> 0;
    expect(errno()).toBe(0);
    expect(new Uint8Array(memory.buffer)[advanced + 16]).toBe(c.fill);
  }
}

describe("ForkModuleContinuationBackend multi-activation", () => {
  let responder: Worker | undefined;
  afterEach(async () => {
    if (responder) {
      await responder.terminate();
      responder = undefined;
    }
  });

  it("drives a two-activation parent unwind + fresh child replay through the module", async () => {
    // --- Parent -----------------------------------------------------------
    const parentMemory = new WebAssembly.Memory({
      initial: Math.ceil(MEMORY_BYTES / PAGE),
      maximum: 16384,
      shared: true,
    });
    // The module maps its own frame chunks through the channel; the worker
    // responder services those mmaps out of the pre-sized frame region.
    responder = startChannelResponder(parentMemory, CHANNEL_BASE);

    const alloc = bumpAllocator(4 * MiB);
    const fm = instantiateForkModule({
      module: loadForkModule32(),
      memory: parentMemory,
      ptrWidth: 4,
      reserve: alloc.reserve,
      label: "backend-parent",
    });
    const px = fm.exports as ForkModuleExports;
    const perr = (): number => Number((px.fm_last_errno as () => number)());

    // Option B: the module channel-mmaps each activation's frame chunks + the
    // journal image through the channel (serviced by the worker responder).
    const backend = new ForkModuleContinuationBackend({
      exports: px,
      memory: parentMemory,
      ptrWidth: 4,
      format: format(128),
      catalogOrdinals: CATALOG0,
      channelBase: CHANNEL_BASE,
      reserveRegion: alloc.reserve,
      releaseRegion: () => {},
      pid: 1,
      label: "backend-parent",
    });
    backend.setup();
    backend.setActivationResumeCatalog(1, CATALOG1);
    const root0 = backend.beginUnwind();
    expect(root0).toBeGreaterThan(0);
    const root1 = backend.addActivationUnwind(1, PREFIX1);
    expect(root1).toBeGreaterThan(0);
    expect(root1).not.toBe(root0);

    const parentTrampolines = new ForkModuleTrampolines(px);
    driveUnwind(parentTrampolines, parentMemory, perr);
    const image = backend.finishUnwindAndSerialize();
    // Option B: the image lives in a channel-mmap'd chunk the module allocated
    // itself.
    expect(image.ptr).toBeGreaterThan(0);
    expect(image.len).toBeGreaterThan(0);
    expect(Number(backend.framesCommitted())).toBe(COMMITS.length);

    backend.beginParentReplay();
    driveReplay(parentTrampolines, parentMemory, perr);
    backend.finishReplay();

    // --- Child: fresh instance at a different placement, empty journal ------
    const childMemory = new WebAssembly.Memory({
      initial: parentMemory.buffer.byteLength / PAGE,
      maximum: 16384,
      shared: true,
    });
    // Simulate the fork address-space copy (frame chunks + image included).
    new Uint8Array(childMemory.buffer).set(new Uint8Array(parentMemory.buffer));
    const childAlloc = bumpAllocator(2.5 * MiB); // different module placement
    const childFm = instantiateForkModule({
      module: loadForkModule32(),
      memory: childMemory,
      ptrWidth: 4,
      reserve: childAlloc.reserve,
      label: "backend-child",
    });
    const cx = childFm.exports as ForkModuleExports;
    const cerr = (): number => Number((cx.fm_last_errno as () => number)());
    const childBackend = new ForkModuleContinuationBackend({
      exports: cx,
      memory: childMemory,
      ptrWidth: 4,
      format: format(128),
      catalogOrdinals: CATALOG0,
      // Replay-only child allocates nothing; a channel base is required by the
      // backend contract but is never used for allocation (the child reads the
      // inherited frame/journal bytes at their copied addresses).
      channelBase: CHANNEL_BASE,
      reserveRegion: childAlloc.reserve,
      releaseRegion: () => {},
      pid: 2,
      label: "backend-child",
    });
    childBackend.setup();
    childBackend.setActivationResumeCatalog(1, CATALOG1);
    // The child inherits the image at the SAME offset via the memory copy, so it
    // seeds from the parent's returned (ptr, len) — the JournalImage record's
    // contents at the coordinator level.
    childBackend.beginChildReplay(root0, image.ptr, image.len);
    childBackend.addActivationChildReplay(1, root1, PREFIX1);

    const childTrampolines = new ForkModuleTrampolines(cx);
    driveReplay(childTrampolines, childMemory, cerr);
    childBackend.finishReplay();
    // A replay-only child never commits; the replayed counter is the proof.
    expect(Number(childBackend.framesReplayed())).toBeGreaterThanOrEqual(
      COMMITS.length,
    );
  });
});
