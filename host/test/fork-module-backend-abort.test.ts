// F1 Task 2: `ForkModuleContinuationBackend.beginAbort()` / `finishAbort()` —
// thin wrappers around the module's `fm_begin_abort`/`fm_finish_abort`
// exports (F1 Task 1), which mirror `fm_begin_replay`/`fm_finish_replay`
// exactly but tag the drive as an abort so a stray `finishAbort()` without a
// matching `beginAbort()` is a loud throw (EINVAL surfaced by `requireOk`),
// never a silent no-op. Modeled on
// `fork-module-backend-multi-activation.test.ts`'s real module instance +
// channel-responder setup (Option B: the module owns its frame allocation via
// in-realm channel `SYS_MMAP`, so a worker-thread responder services the
// blocking mmap exactly as the real kernel worker does).
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

// See `fork-module-backend-multi-activation.test.ts` for the full rationale
// behind these placements; this test reuses the same layout.
const CHANNEL_BASE = 2 * MiB;
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
 * A minimal syscall-channel responder on a worker thread: it watches the
 * shared channel status, services SYS_MMAP by bump-allocating out of the
 * pre-sized frame region and returning the mapped offset, acks SYS_MUNMAP,
 * and pings the blocked module back — the exact handshake the real kernel
 * worker performs, so the module's in-realm `memory_atomic_wait32` mmap can
 * complete on the main thread. Copied from
 * `fork-module-backend-multi-activation.test.ts`.
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
    const i32 = new Int32Array(memory.buffer);
    const dv = new DataView(memory.buffer);
    let next = FRAME_BASE;
    for (;;) {
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

// One frame per activation — enough to prove the abort-replay path drains a
// real committed frame through `beginAbort`/`finishAbort`, not just an empty
// journal.
const COMMITS: Commit[] = [
  { act: 0, func: 601, fill: 0xd1, size: 40 },
  { act: 1, func: 701, fill: 0xd2, size: 48 },
];
const CATALOG0 = [601, 602];
const CATALOG1 = [701, 702];
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

function driveAbortReplay(
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

describe("ForkModuleContinuationBackend abort-replay (beginAbort/finishAbort)", () => {
  let responder: Worker | undefined;
  afterEach(async () => {
    if (responder) {
      await responder.terminate();
      responder = undefined;
    }
  });

  it("drives beginUnwind -> addActivationUnwind -> finishUnwindAndSerialize -> beginAbort -> finishAbort with no throw", async () => {
    const memory = new WebAssembly.Memory({
      initial: Math.ceil(MEMORY_BYTES / PAGE),
      maximum: 16384,
      shared: true,
    });
    responder = startChannelResponder(memory, CHANNEL_BASE);

    const alloc = bumpAllocator(4 * MiB);
    const fm = instantiateForkModule({
      module: loadForkModule32(),
      memory,
      ptrWidth: 4,
      reserve: alloc.reserve,
      label: "backend-abort",
    });
    const px = fm.exports as ForkModuleExports;
    const errno = (): number => Number((px.fm_last_errno as () => number)());

    // Option B: the module channel-mmaps its frame chunks + journal image
    // through the channel (serviced by the worker responder).
    const backend = new ForkModuleContinuationBackend({
      exports: px,
      memory,
      ptrWidth: 4,
      format: format(128),
      catalogOrdinals: CATALOG0,
      channelBase: CHANNEL_BASE,
      reserveRegion: alloc.reserve,
      releaseRegion: () => {},
      pid: 1,
      label: "backend-abort",
    });
    backend.setup();
    backend.setActivationResumeCatalog(1, CATALOG1);

    const root0 = backend.beginUnwind();
    expect(root0).toBeGreaterThan(0);
    const root1 = backend.addActivationUnwind(1, PREFIX1);
    expect(root1).toBeGreaterThan(0);
    expect(root1).not.toBe(root0);

    const trampolines = new ForkModuleTrampolines(px);
    driveUnwind(trampolines, memory, errno);

    const image = backend.finishUnwindAndSerialize();
    // Option B: the image lives in a channel-mmap'd chunk the module allocated
    // itself.
    expect(image.ptr).toBeGreaterThan(0);
    expect(image.len).toBeGreaterThan(0);
    expect(Number(backend.framesCommitted())).toBe(COMMITS.length);

    // Negative case FIRST (mirrors the Rust harness's `runAbortCycle`):
    // `finishAbort()` without a preceding `beginAbort()` is a loud EINVAL
    // throw, not a silent no-op and not a fall-through into
    // `finishReplay`'s bookkeeping.
    expect(() => backend.finishAbort()).toThrow(/errno=22/);

    // The wrappers under test: `beginAbort` mirrors `beginParentReplay`
    // (abort-tagged); `finishAbort` mirrors `finishReplay`.
    expect(() => backend.beginAbort()).not.toThrow();

    driveAbortReplay(trampolines, memory, errno);

    expect(() => backend.finishAbort()).not.toThrow();
  });
});
