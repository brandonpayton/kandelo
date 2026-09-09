// host/test/multi-worker.test.ts
//
// Tests CentralizedKernelWorker process management and fork flow.
import { describe, it, expect, vi } from "vitest";
import {
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { makeHostScratchTempRoot } from "./centralized-test-helper";
import {
  type CentralizedKernelCallbacks,
  createCentralizedKernelWorkerTestDouble,
  CAPTURED_STDIO,
  CentralizedKernelWorker,
  shouldDeliverPosixTimerSignal,

} from "../src/kernel-worker";
import { KernelReentrantEntryError } from "../src/kernel-entry-gate";
import { resolveBinary } from "../src/binary-resolver";
import { NodePlatformIO } from "../src/platform/node";
import {
  computeProcessMemoryLayout,
  createProcessMemory as createLayoutMemory,
  FORK_SAVE_BUFFER_SIZE,
  ProcessMemoryRetirementBacklogError,
  type ProcessMemoryLayout,
} from "../src/process-memory";
import { writeForkContinuationAnchor } from "../src/fork-continuation";
import { CH_TOTAL_SIZE, DEFAULT_MAX_PAGES, WASM_PAGE_SIZE } from "../src/constants";
import {
  ABI_SYSCALLS,
  CHANNEL_STATUS_COMPLETE,
  CHANNEL_STATUS_PENDING,
  CH_ARGS,
  CH_ARGS_COUNT,
  CH_ARG_SIZE,
  CH_DATA,
  CH_ERRNO,
  CH_RETURN,
  CH_STATUS,
  CH_SYSCALL,
  HOST_INTERCEPTED_SYSCALLS,
  PROCESS_MEMORY_PAGES_PER_THREAD_SLOT,
  PROCESS_MEMORY_THREAD_SLOT_CHANNEL_PRIMARY_PAGE,
  PROCESS_FORK_MODE_VFORK,
  PROCESS_STATE_EXITED,
  PROCESS_STATE_RUNNING,
  WPK_FORK_LINKED_FRAME_POINTER_WIDTHS,
} from "../src/generated/abi";
import {
  emptyProcessTimerCleanup,
  installKernelWorkerTestScratch,
} from "./kernel-worker-test-scratch";
// The in-kernel tmpfs owns the scratch prefixes unconditionally, so the
// mmap-teardown case stages its host-backed file outside every scratch prefix
// (`makeHostScratchTempRoot`) and maps it through NodePlatformIO.


const MAX_PAGES = 1024; // 64 MiB: enough to prove initial < maximum.
const WASM32_CONTINUATION_HEADER_SIZE =
  WPK_FORK_LINKED_FRAME_POINTER_WIDTHS.find(({ bytes }) => bytes === 4)!
    .chunkHeaderSize;
const WASM64_CONTINUATION_HEADER_SIZE =
  WPK_FORK_LINKED_FRAME_POINTER_WIDTHS.find(({ bytes }) => bytes === 8)!
    .chunkHeaderSize;
const TEST_FORK_CONTINUATION =
  3 * WASM_PAGE_SIZE + WASM32_CONTINUATION_HEADER_SIZE;
const TEST_THREAD_FORK_CONTINUATION =
  6 * WASM_PAGE_SIZE + WASM32_CONTINUATION_HEADER_SIZE;

function publishMainForkContinuation(
  memory: WebAssembly.Memory,
  channelOffset: number,
  ptrWidth: 4 | 8 = 4,
  continuationAddress = TEST_FORK_CONTINUATION,
): void {
  writeForkContinuationAnchor(
    memory,
    channelOffset - FORK_SAVE_BUFFER_SIZE,
    ptrWidth,
    continuationAddress,
  );
}

function loadKernelWasm(): ArrayBuffer {
  const buf = readFileSync(resolveBinary("kernel.wasm"));
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

function createProcessMemory(): {
  memory: WebAssembly.Memory;
  channelOffset: number;
  layout: ProcessMemoryLayout;
} {
  const layout = computeProcessMemoryLayout({
    ptrWidth: 4,
    heapBase: 0x00120000,
    minPages: 18,
    maxPages: MAX_PAGES,
  });
  const memory = createLayoutMemory(4, layout);
  const channelOffset = layout.channelOffset;
  new Uint8Array(memory.buffer, channelOffset, CH_TOTAL_SIZE).fill(0);
  return { memory, channelOffset, layout };
}

function createRegistrationTestWorker(
  kernelExports: Readonly<Record<string, unknown>>,
  kernelExportNames: readonly string[],
): CentralizedKernelWorker {
  const worker = createCentralizedKernelWorkerTestDouble();
  const kernelMemory = new WebAssembly.Memory({ initial: 2, maximum: 2 });
  installKernelWorkerTestScratch(
    worker,
    kernelMemory,
    128,
    4,
    {
      kernelExports,
      kernelExportNames,
    },
  );
  return worker;
}

type TestWorker = ReturnType<
  typeof createCentralizedKernelWorkerTestDouble
>;
type TestChannel = ReturnType<
  TestWorker["testAuthority"][
    "replaceProcessRegistrationForLifecycleTest"
  ]
>[number];

interface GatedLifecycleHarness {
  readonly worker: TestWorker;
  readonly kernelMemory: WebAssembly.Memory;
  readonly kernelExports: Record<string, unknown>;
}

function createGatedLifecycleHarness(options: {
  readonly callbacks?: CentralizedKernelCallbacks;
  readonly kernelExports?: Readonly<Record<string, unknown>>;
  readonly pointerWidth?: 4 | 8;
} = {}): GatedLifecycleHarness {
  const kernelMemory = new WebAssembly.Memory({
    initial: 2,
    maximum: 2,
  });
  const kernelExports: Record<string, unknown> = {
    kernel_clear_fork_child: vi.fn(() => 0),
    kernel_drain_wakeup_events: vi.fn(() => 0),
    kernel_get_parent_pid: vi.fn(() => -1),
    kernel_get_process_exit_signal: vi.fn(() => -1),
    kernel_get_process_state: vi.fn(() => PROCESS_STATE_RUNNING),
    kernel_mark_process_signaled: vi.fn(() => 0),
    kernel_remove_process: vi.fn(() => 0),
    kernel_set_current_tid: vi.fn(() => 0),
    kernel_set_max_addr: vi.fn(() => 0),
    kernel_take_process_timer_cleanup: emptyProcessTimerCleanup(kernelMemory),
    kernel_thread_exit: vi.fn(() => 0),
    kernel_validate_task: vi.fn(() => 0),
    ...(options.kernelExports ?? {}),
  };
  const worker = createCentralizedKernelWorkerTestDouble({
    callbacks: options.callbacks,
  });
  installKernelWorkerTestScratch(
    worker,
    kernelMemory,
    128,
    options.pointerWidth ?? 4,
    {
      kernelExports,
      kernelExportNames: Object.keys(kernelExports),
    },
  );
  return { worker, kernelMemory, kernelExports };
}

function registerLifecycleProcess(
  harness: GatedLifecycleHarness,
  pid: number,
  memory: WebAssembly.Memory,
  channelOffset: number,
  pointerWidth: 4 | 8 = 4,
): void {
  harness.worker.registerProcess(pid, memory, [channelOffset], {
    ptrWidth: pointerWidth,
    maxAddr: memory.buffer.byteLength,
  });
}

function writePendingSyscall(
  memory: WebAssembly.Memory,
  channelOffset: number,
  syscall: number,
  args: readonly number[],
): void {
  const view = new DataView(memory.buffer, channelOffset, CH_TOTAL_SIZE);
  view.setUint32(CH_SYSCALL, syscall, true);
  for (let index = 0; index < CH_ARGS_COUNT; index++) {
    view.setBigInt64(
      CH_ARGS + index * CH_ARG_SIZE,
      BigInt(args[index] ?? 0),
      true,
    );
  }
  const statusView = new Int32Array(
    memory.buffer,
    channelOffset,
    CH_TOTAL_SIZE / Int32Array.BYTES_PER_ELEMENT,
  );
  Atomics.store(
    statusView,
    CH_STATUS / Int32Array.BYTES_PER_ELEMENT,
    CHANNEL_STATUS_PENDING,
  );
  Atomics.notify(
    statusView,
    CH_STATUS / Int32Array.BYTES_PER_ELEMENT,
    1,
  );
}

async function waitForCondition(
  condition: () => boolean,
  description: string,
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (condition()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`timed out waiting for ${description}`);
}

async function waitForMailboxCompletion(
  memory: WebAssembly.Memory,
  channelOffset: number,
): Promise<void> {
  const statusView = new Int32Array(
    memory.buffer,
    channelOffset,
    CH_TOTAL_SIZE / Int32Array.BYTES_PER_ELEMENT,
  );
  await waitForCondition(
    () => Atomics.load(
      statusView,
      CH_STATUS / Int32Array.BYTES_PER_ELEMENT,
    ) === CHANNEL_STATUS_COMPLETE,
    `channel ${channelOffset} completion`,
  );
}

function readMailboxResult(
  memory: WebAssembly.Memory,
  channelOffset: number,
): { readonly value: number; readonly errno: number } {
  const view = new DataView(memory.buffer, channelOffset, CH_TOTAL_SIZE);
  return {
    value: Number(view.getBigInt64(CH_RETURN, true)),
    errno: view.getUint32(CH_ERRNO, true),
  };
}

function expectUnexpectedMailboxEio(
  memory: WebAssembly.Memory,
  channelOffset: number,
): void {
  // WHY: the unexpected-handler boundary deliberately publishes -EIO/EIO.
  // CH_ERRNO is authoritative on error: channel_syscall.c returns `-err`,
  // then musl maps that to the POSIX-visible -1 with errno=EIO.
  expect(readMailboxResult(memory, channelOffset)).toEqual({
    value: -5,
    errno: 5,
  });
}

function kernelChannelResult(
  kernelMemory: WebAssembly.Memory,
  result: number,
  errno = 0,
): ReturnType<typeof vi.fn> {
  return vi.fn((rawOffset: number | bigint) => {
    const offset = Number(rawOffset);
    const view = new DataView(
      kernelMemory.buffer,
      offset,
      CH_TOTAL_SIZE,
    );
    view.setBigInt64(CH_RETURN, BigInt(result), true);
    view.setUint32(CH_ERRNO, errno, true);
    return 0;
  });
}

function attachProcess(
  kw: CentralizedKernelWorker,
  pid: number,
  entry: ReturnType<typeof createProcessMemory>,
): void {
  kw.registerProcess(pid, entry.memory, [entry.channelOffset], {
    brkBase: entry.layout.brkBase,
    mmapBase: entry.layout.mmapBase,
    maxAddr: entry.layout.maxAddr,
  });
}

function createAndRegisterProcess(
  kw: CentralizedKernelWorker,
  entry: ReturnType<typeof createProcessMemory>,
): number {
  const pid = kw.createProcess(CAPTURED_STDIO);
  attachProcess(kw, pid, entry);
  return pid;
}

async function issueDirectKernelOpen(
  worker: CentralizedKernelWorker,
  pid: number,
  process: ReturnType<typeof createProcessMemory>,
  path: string,
  flags = 0,
  mode = 0,
): Promise<{ value: number; errno: number }> {
  const pathPointer = 4 * WASM_PAGE_SIZE;
  const encoded = new TextEncoder().encode(`${path}\0`);
  new Uint8Array(process.memory.buffer).set(encoded, pathPointer);
  writePendingSyscall(
    process.memory,
    process.channelOffset,
    ABI_SYSCALLS.Open,
    [pathPointer, flags, mode],
  );
  await waitForMailboxCompletion(
    process.memory,
    process.channelOffset,
  );
  expect(worker.getProcessMemory(pid)).toBe(process.memory);
  return readMailboxResult(process.memory, process.channelOffset);
}

describe("CentralizedKernelWorker Process Management", () => {
  it("does not deliver SIGEV_NONE as a signal-zero wakeup", () => {
    expect(shouldDeliverPosixTimerSignal(0)).toBe(false);
    expect(shouldDeliverPosixTimerSignal(14)).toBe(true);
    expect(shouldDeliverPosixTimerSignal(65)).toBe(false);
  });

  it("uses the kernel-assigned fork PID without host-side retries", async () => {
    const parentPid = 77;
    const memory = new WebAssembly.Memory({ initial: 4, maximum: 4, shared: true });
    const channelOffset = WASM_PAGE_SIZE;
    publishMainForkContinuation(memory, channelOffset);
    const kernelForkProcess = vi.fn(() => 101);
    const onFork = vi.fn(() => Promise.resolve([WASM_PAGE_SIZE]));
    const harness = createGatedLifecycleHarness({
      callbacks: { onFork },
      kernelExports: { kernel_fork_process: kernelForkProcess },
    });
    registerLifecycleProcess(
      harness,
      parentPid,
      memory,
      channelOffset,
    );

    writePendingSyscall(
      memory,
      channelOffset,
      HOST_INTERCEPTED_SYSCALLS.SYS_FORK,
      [0],
    );
    await waitForMailboxCompletion(memory, channelOffset);

    expect(kernelForkProcess).toHaveBeenCalledOnce();
    expect(kernelForkProcess).toHaveBeenCalledWith(parentPid, parentPid, 0);
    expect(onFork).toHaveBeenCalledWith({
      parentPid,
      childPid: 101,
      mode: 0,
      parentMemory: memory,
      continuation: {
        kind: "main",
        forkBufAddr: TEST_FORK_CONTINUATION,
      },
    });
    expect(readMailboxResult(memory, channelOffset)).toEqual({
      value: 101,
      errno: 0,
    });
  });

  it("carries vfork mode through kernel allocation and child launch", async () => {
    const parentPid = 77;
    const childPid = 104;
    const memory = new WebAssembly.Memory({
      initial: 4,
      maximum: 4,
      shared: true,
    });
    const channelOffset = WASM_PAGE_SIZE;
    publishMainForkContinuation(memory, channelOffset);
    const kernelForkProcess = vi.fn(() => childPid);
    const onFork = vi.fn(() => Promise.resolve([WASM_PAGE_SIZE]));
    const harness = createGatedLifecycleHarness({
      callbacks: { onFork },
      kernelExports: { kernel_fork_process: kernelForkProcess },
    });
    registerLifecycleProcess(harness, parentPid, memory, channelOffset);

    writePendingSyscall(
      memory,
      channelOffset,
      HOST_INTERCEPTED_SYSCALLS.SYS_VFORK,
      [128, WASM_PAGE_SIZE],
    );
    await waitForMailboxCompletion(memory, channelOffset);

    expect(kernelForkProcess).toHaveBeenCalledWith(
      parentPid,
      parentPid,
      PROCESS_FORK_MODE_VFORK,
    );
    expect(onFork).toHaveBeenCalledWith({
      parentPid,
      childPid,
      mode: PROCESS_FORK_MODE_VFORK,
      parentMemory: memory,
      continuation: {
        kind: "main",
        forkBufAddr: TEST_FORK_CONTINUATION,
      },
      borrowedReplay: {
        prefixBytes: 128,
        scratchBytes: WASM_PAGE_SIZE,
      },
    });
    expect(readMailboxResult(memory, channelOffset)).toEqual({
      value: childPid,
      errno: 0,
    });
  });

  it("rejects an oversized vfork workspace before allocating a child", async () => {
    const parentPid = 77;
    const memory = new WebAssembly.Memory({
      initial: 4,
      maximum: 4,
      shared: true,
    });
    const channelOffset = WASM_PAGE_SIZE;
    publishMainForkContinuation(memory, channelOffset);
    const kernelForkProcess = vi.fn(() => 105);
    const onFork = vi.fn(() => Promise.resolve([WASM_PAGE_SIZE]));
    const harness = createGatedLifecycleHarness({
      callbacks: { onFork },
      kernelExports: { kernel_fork_process: kernelForkProcess },
    });
    registerLifecycleProcess(harness, parentPid, memory, channelOffset);

    writePendingSyscall(
      memory,
      channelOffset,
      HOST_INTERCEPTED_SYSCALLS.SYS_VFORK,
      [FORK_SAVE_BUFFER_SIZE + 1, 0],
    );
    await waitForMailboxCompletion(memory, channelOffset);

    expect(kernelForkProcess).not.toHaveBeenCalled();
    expect(onFork).not.toHaveBeenCalled();
    expect(readMailboxResult(memory, channelOffset)).toEqual({
      value: -1,
      errno: 11,
    });
  });

  it("carries the exact pthread continuation anchor into the fork launch", async () => {
    const parentPid = 77;
    const childPid = 102;
    const threadTid = 911;
    const fnPtr = 0x1234;
    const argPtr = 0x5678;
    const mainChannelOffset = WASM_PAGE_SIZE;
    const threadChannelOffset = 3 * WASM_PAGE_SIZE;
    const memory = new WebAssembly.Memory({
      initial: 8,
      maximum: 8,
      shared: true,
    });
    writeForkContinuationAnchor(
      memory,
      threadChannelOffset - FORK_SAVE_BUFFER_SIZE,
      4,
      TEST_THREAD_FORK_CONTINUATION,
    );
    const onFork = vi.fn(() => Promise.resolve([threadChannelOffset]));
    const slotStart =
      threadChannelOffset
      - PROCESS_MEMORY_THREAD_SLOT_CHANNEL_PRIMARY_PAGE * WASM_PAGE_SIZE;
    const slotLen =
      PROCESS_MEMORY_PAGES_PER_THREAD_SLOT * WASM_PAGE_SIZE;
    const reserveHostRegionAt = vi.fn(
      (_pid: number, address: number) => address,
    );
    let harness!: GatedLifecycleHarness;
    const onClone = vi.fn((attachment) => {
      harness.worker.attachThreadChannel(
        attachment,
        threadChannelOffset,
      );
      return Promise.resolve();
    });
    const kernelHandleChannel = vi.fn((rawOffset: number | bigint) => {
      const offset = Number(rawOffset);
      const kernelView = new DataView(
        harness.kernelMemory.buffer,
        offset,
        CH_TOTAL_SIZE,
      );
      kernelView.setBigInt64(CH_RETURN, BigInt(threadTid), true);
      kernelView.setUint32(CH_ERRNO, 0, true);
      return 0;
    });
    harness = createGatedLifecycleHarness({
      callbacks: { onClone, onFork },
      kernelExports: {
        kernel_fork_process: vi.fn(() => childPid),
        kernel_handle_channel: kernelHandleChannel,
        kernel_reserve_host_region_at: reserveHostRegionAt,
      },
    });
    registerLifecycleProcess(
      harness,
      parentPid,
      memory,
      mainChannelOffset,
    );
    const mainView = new DataView(
      memory.buffer,
      mainChannelOffset,
      CH_TOTAL_SIZE,
    );
    mainView.setUint32(CH_DATA, fnPtr, true);
    mainView.setUint32(CH_DATA + 4, argPtr, true);
    writePendingSyscall(
      memory,
      mainChannelOffset,
      ABI_SYSCALLS.Clone,
      [0, 5 * WASM_PAGE_SIZE, 0, 0, 0],
    );
    await waitForMailboxCompletion(memory, mainChannelOffset);

    writePendingSyscall(
      memory,
      threadChannelOffset,
      HOST_INTERCEPTED_SYSCALLS.SYS_FORK,
      [0],
    );
    await waitForMailboxCompletion(memory, threadChannelOffset);

    expect(reserveHostRegionAt).toHaveBeenCalledWith(
      childPid,
      slotStart,
      slotLen,
    );
    expect(onFork).toHaveBeenCalledWith({
      parentPid,
      childPid,
      mode: 0,
      parentMemory: memory,
      continuation: {
        kind: "thread",
        fnPtr,
        argPtr,
        forkBufAddr: TEST_THREAD_FORK_CONTINUATION,
        slotStart,
        slotLen,
      },
    });
    expect(readMailboxResult(memory, threadChannelOffset)).toEqual({
      value: childPid,
      errno: 0,
    });
  });

  it("reads and carries an exact wasm64 continuation anchor with i64 representation", async () => {
    const parentPid = 77;
    const childPid = 103;
    const channelOffset = WASM_PAGE_SIZE;
    const memory = new WebAssembly.Memory({
      initial: 8,
      maximum: 8,
      shared: true,
    });
    const continuationAddress =
      5 * WASM_PAGE_SIZE + WASM64_CONTINUATION_HEADER_SIZE;
    publishMainForkContinuation(
      memory,
      channelOffset,
      8,
      continuationAddress,
    );
    const onFork = vi.fn(() => Promise.resolve([WASM_PAGE_SIZE]));
    const harness = createGatedLifecycleHarness({
      callbacks: { onFork },
      pointerWidth: 8,
      kernelExports: {
        kernel_fork_process: vi.fn(() => childPid),
      },
    });
    registerLifecycleProcess(
      harness,
      parentPid,
      memory,
      channelOffset,
      8,
    );
    const readBigUint64 = vi.spyOn(DataView.prototype, "getBigUint64");

    try {
      writePendingSyscall(
        memory,
        channelOffset,
        HOST_INTERCEPTED_SYSCALLS.SYS_FORK,
        [0],
      );
      await waitForMailboxCompletion(memory, channelOffset);

      expect(readBigUint64).toHaveBeenCalledWith(
        channelOffset - FORK_SAVE_BUFFER_SIZE,
        true,
      );
      expect(onFork).toHaveBeenCalledWith({
        parentPid,
        childPid,
        mode: 0,
        parentMemory: memory,
        continuation: {
          kind: "main",
          forkBufAddr: continuationAddress,
        },
      });
      expect(readMailboxResult(memory, channelOffset)).toEqual({
        value: childPid,
        errno: 0,
      });
    } finally {
      readBigUint64.mockRestore();
    }
  });

  it("rejects a missing continuation anchor before allocating a child", async () => {
    const parentPid = 77;
    const channelOffset = WASM_PAGE_SIZE;
    const memory = new WebAssembly.Memory({
      initial: 4,
      maximum: 4,
      shared: true,
    });
    const kernelForkProcess = vi.fn(() => 101);
    const onFork = vi.fn(() => Promise.resolve([WASM_PAGE_SIZE]));
    const harness = createGatedLifecycleHarness({
      callbacks: { onFork },
      kernelExports: { kernel_fork_process: kernelForkProcess },
    });
    registerLifecycleProcess(
      harness,
      parentPid,
      memory,
      channelOffset,
    );
    writePendingSyscall(
      memory,
      channelOffset,
      HOST_INTERCEPTED_SYSCALLS.SYS_FORK,
      [0],
    );
    await waitForMailboxCompletion(memory, channelOffset);

    expectUnexpectedMailboxEio(memory, channelOffset);
    expect(kernelForkProcess).not.toHaveBeenCalled();
    expect(onFork).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "misaligned",
      continuationAddress:
        2 * WASM_PAGE_SIZE + WASM32_CONTINUATION_HEADER_SIZE + 1,
    },
    {
      label: "out-of-range",
      continuationAddress:
        4 * WASM_PAGE_SIZE + WASM32_CONTINUATION_HEADER_SIZE,
    },
  ])(
    "rejects a nonzero $label continuation anchor before allocating a child",
    async ({ continuationAddress }) => {
      const parentPid = 77;
      const channelOffset = WASM_PAGE_SIZE;
      const memory = new WebAssembly.Memory({
        initial: 4,
        maximum: 4,
        shared: true,
      });
      publishMainForkContinuation(
        memory,
        channelOffset,
        4,
        continuationAddress,
      );
      const kernelForkProcess = vi.fn(() => 101);
      const onFork = vi.fn(() => Promise.resolve([WASM_PAGE_SIZE]));
      const harness = createGatedLifecycleHarness({
        callbacks: { onFork },
        kernelExports: { kernel_fork_process: kernelForkProcess },
      });
      registerLifecycleProcess(
        harness,
        parentPid,
        memory,
        channelOffset,
      );
      writePendingSyscall(
        memory,
        channelOffset,
        HOST_INTERCEPTED_SYSCALLS.SYS_FORK,
        [0],
      );
      await waitForMailboxCompletion(memory, channelOffset);

      expectUnexpectedMailboxEio(memory, channelOffset);
      expect(kernelForkProcess).not.toHaveBeenCalled();
      expect(onFork).not.toHaveBeenCalled();
    },
  );

  it("inherits child fd mirrors when the parent channel becomes stale during fork", async () => {
    const parentPid = 77;
    const childPid = 100;
    const listenerFd = 4;
    const listenerPort = 8080;
    const oldChannelOffset = WASM_PAGE_SIZE;
    const replacementChannelOffset = 2 * WASM_PAGE_SIZE;
    const childChannelOffset = WASM_PAGE_SIZE;
    const parentMemory = new WebAssembly.Memory({
      initial: 4,
      maximum: 4,
      shared: true,
    });
    const childMemory = new WebAssembly.Memory({
      initial: 4,
      maximum: 4,
      shared: true,
    });
    publishMainForkContinuation(parentMemory, oldChannelOffset);
    let selectedListenerPid = parentPid;
    let finishFork!: (offsets: number[]) => void;
    const forkLaunch = new Promise<number[]>((resolve) => {
      finishFork = resolve;
    });
    const onFork = vi.fn(() => forkLaunch);
    const harness = createGatedLifecycleHarness({
      callbacks: { onFork },
      kernelExports: {
        kernel_fork_process: vi.fn(() => childPid),
        kernel_get_fd_accept_wake_idx: (
          _pid: number,
          fd: number,
        ) => fd === listenerFd ? 41 : -1,
        kernel_pick_tcp_listener_target: (
          _port: number,
          _excludePid: number,
          outPtr: number,
          outCapacity: number,
        ) => {
          if (outCapacity !== 8) return -22;
          const view = new DataView(
            harness.kernelMemory.buffer,
            outPtr,
            outCapacity,
          );
          view.setUint32(0, selectedListenerPid, true);
          view.setInt32(4, listenerFd, true);
          return 1;
        },
      },
    });
    const [oldChannel] = harness.worker.testAuthority
      .replaceProcessRegistrationForLifecycleTest({
        pid: parentPid,
        memory: parentMemory,
        channelOffsets: [oldChannelOffset],
        tcpListener: {
          fd: listenerFd,
          port: listenerPort,
        },
      });
    if (oldChannel === undefined) {
      throw new Error("fork lifecycle test did not install its parent channel");
    }
    expect(harness.worker.pickListenerTarget(listenerPort)).toEqual({
      pid: parentPid,
      fd: listenerFd,
    });

    writePendingSyscall(
      parentMemory,
      oldChannelOffset,
      HOST_INTERCEPTED_SYSCALLS.SYS_FORK,
      [0],
    );
    harness.worker.testAuthority
      .dispatchScratchBoundarySyscallForTest(oldChannel);
    await waitForCondition(
      () => onFork.mock.calls.length === 1,
      "fork worker launch",
    );
    selectedListenerPid = childPid;

    // The fork path must install child mirrors before the async worker launch.
    // Replace the parent generation while that launch is pending, then remove
    // only the replacement registration. The old channel is now stale, but
    // the public listener lookup must still find the eagerly inherited child.
    harness.worker.testAuthority.replaceProcessRegistrationForLifecycleTest({
      pid: parentPid,
      memory: parentMemory,
      channelOffsets: [replacementChannelOffset],
    });
    registerLifecycleProcess(
      harness,
      childPid,
      childMemory,
      childChannelOffset,
    );
    harness.worker.unregisterProcess(parentPid);
    expect(harness.worker.pickListenerTarget(listenerPort)).toEqual({
      pid: childPid,
      fd: listenerFd,
    });

    finishFork([childChannelOffset]);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(
      Atomics.load(
        new Int32Array(parentMemory.buffer, oldChannelOffset),
        CH_STATUS / Int32Array.BYTES_PER_ELEMENT,
      ),
    ).toBe(CHANNEL_STATUS_PENDING);
    expect(harness.worker.pickListenerTarget(listenerPort)).toEqual({
      pid: childPid,
      fd: listenerFd,
    });
    harness.worker.unregisterProcess(childPid);
  });

  it("removes eager child registrations and mirrors when fork worker launch fails", async () => {
    const parentPid = 77;
    const memory = new WebAssembly.Memory({ initial: 4, maximum: 4, shared: true });
    const channelOffset = WASM_PAGE_SIZE;
    publishMainForkContinuation(memory, channelOffset);
    const removeProcess = vi.fn(() => 0);
    const onFork = vi.fn(() => Promise.reject(new Error("launch failed")));
    const harness = createGatedLifecycleHarness({
      callbacks: { onFork },
      kernelExports: {
        kernel_fork_process: vi.fn(() => 100),
        kernel_remove_process: removeProcess,
      },
    });
    registerLifecycleProcess(harness, parentPid, memory, channelOffset);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      writePendingSyscall(
        memory,
        channelOffset,
        HOST_INTERCEPTED_SYSCALLS.SYS_FORK,
        [0],
      );
      await waitForMailboxCompletion(memory, channelOffset);

      expect(onFork).toHaveBeenCalledOnce();
      expect(removeProcess).toHaveBeenCalledWith(100);
      expect(readMailboxResult(memory, channelOffset)).toEqual({
        value: -1,
        errno: 12,
      });
      expect(error).toHaveBeenCalledWith(
        "[kernel-worker] fork worker launch failed: Error: launch failed",
      );
    } finally {
      error.mockRestore();
    }
  });

  it("reports retired-memory fork admission failure as EAGAIN", async () => {
    const parentPid = 77;
    const memory = new WebAssembly.Memory({
      initial: 4,
      maximum: 4,
      shared: true,
    });
    const channelOffset = WASM_PAGE_SIZE;
    publishMainForkContinuation(memory, channelOffset);
    const removeProcess = vi.fn(() => 0);
    const admissionError = new ProcessMemoryRetirementBacklogError(
      "retired process-memory debt is saturated",
      4 * WASM_PAGE_SIZE,
      1,
      4 * WASM_PAGE_SIZE,
      1,
      4 * WASM_PAGE_SIZE,
    );
    const onFork = vi.fn(() => Promise.reject(admissionError));
    const harness = createGatedLifecycleHarness({
      callbacks: { onFork },
      kernelExports: {
        kernel_fork_process: vi.fn(() => 100),
        kernel_remove_process: removeProcess,
      },
    });
    registerLifecycleProcess(harness, parentPid, memory, channelOffset);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      writePendingSyscall(
        memory,
        channelOffset,
        HOST_INTERCEPTED_SYSCALLS.SYS_FORK,
        [0],
      );
      await waitForMailboxCompletion(memory, channelOffset);

      expect(onFork).toHaveBeenCalledOnce();
      expect(removeProcess).toHaveBeenCalledWith(100);
      expect(readMailboxResult(memory, channelOffset)).toEqual({
        value: -1,
        errno: 11,
      });
    } finally {
      error.mockRestore();
    }
  });

  it("terminates the parent when a failed fork launch cannot remove the child", async () => {
    const parentPid = 77;
    const childPid = 100;
    const memory = new WebAssembly.Memory({ initial: 4, maximum: 4, shared: true });
    const channelOffset = WASM_PAGE_SIZE;
    publishMainForkContinuation(memory, channelOffset);
    const removeProcess = vi.fn(() => -5);
    const markProcessSignaled = vi.fn(() => 0);
    const onExit = vi.fn();
    const harness = createGatedLifecycleHarness({
      callbacks: {
        onFork: vi.fn(() => Promise.reject(new Error("launch failed"))),
        onExit,
      },
      kernelExports: {
        kernel_fork_process: vi.fn(() => childPid),
        kernel_mark_process_signaled: markProcessSignaled,
        kernel_remove_process: removeProcess,
      },
    });
    registerLifecycleProcess(harness, parentPid, memory, channelOffset);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      writePendingSyscall(
        memory,
        channelOffset,
        HOST_INTERCEPTED_SYSCALLS.SYS_FORK,
        [0],
      );
      await waitForCondition(
        () => onExit.mock.calls.length === 1,
        "fatal fork rollback parent termination",
      );

      expect(removeProcess).toHaveBeenCalledWith(childPid);
      expect(markProcessSignaled).toHaveBeenCalledWith(parentPid, 11);
      expect(onExit).toHaveBeenCalledWith(parentPid, 139);
      expect(
        Atomics.load(
          new Int32Array(memory.buffer, channelOffset),
          CH_STATUS / Int32Array.BYTES_PER_ELEMENT,
        ),
      ).toBe(CHANNEL_STATUS_PENDING);
      expect(error).toHaveBeenCalledWith(
        "[handleSyscall] FATAL could not roll back fork child 100: " +
          "Kernel could not remove process 100: errno 5",
      );
    } finally {
      error.mockRestore();
    }
  });

  it("completes pthread SYS_EXIT channels (clearing the exiting guest's atomic-wait waiter) even when the host terminates the worker", async () => {
    // Regression guard for the reused-slot notify-steal deadlock. On thread
    // exit the kernel must flip the channel status word off CH_PENDING
    // (completeChannelRaw) so the exiting guest's in-wasm memory.atomic.wait32
    // returns and its waiter is removed *before* the thread slot / channel
    // offset is freed and reused by a later clone(). This holds even in the
    // browser case where onThreadExit reports the host will terminate the
    // backing Worker: an earlier revision abandoned the channel here (leaving
    // status=PENDING with the guest still parked), and once #830 made worker
    // teardown immediate, that stale waiter could outlive the slot and steal a
    // reused thread's memory.atomic.notify(count=1), so the kernel's
    // Atomics.waitAsync never fired and the new thread wedged forever.
    const pid = 123;
    const mainChannelOffset = WASM_PAGE_SIZE;
    const threadChannelOffset = 2 * WASM_PAGE_SIZE;
    const tid = 77;
    const memory = new WebAssembly.Memory({
      initial: 4,
      maximum: 4,
      shared: true,
    });
    const onThreadExit = vi.fn(() => true);
    let harness!: GatedLifecycleHarness;
    const onClone = vi.fn((attachment) => {
      harness.worker.attachThreadChannel(attachment, threadChannelOffset);
      return Promise.resolve();
    });
    let kernelMemory!: WebAssembly.Memory;
    const handleChannel = vi.fn((rawOffset: number | bigint) => {
      const view = new DataView(
        kernelMemory.buffer,
        Number(rawOffset),
        CH_TOTAL_SIZE,
      );
      view.setBigInt64(CH_RETURN, BigInt(tid), true);
      view.setUint32(CH_ERRNO, 0, true);
      return 0;
    });
    const threadExit = vi.fn(() => 0n);
    harness = createGatedLifecycleHarness({
      callbacks: { onClone, onThreadExit },
      kernelExports: {
        kernel_handle_channel: handleChannel,
        kernel_thread_exit: threadExit,
      },
    });
    kernelMemory = harness.kernelMemory;
    registerLifecycleProcess(
      harness,
      pid,
      memory,
      mainChannelOffset,
    );

    writePendingSyscall(
      memory,
      mainChannelOffset,
      ABI_SYSCALLS.Clone,
      [0, 0, 0, 0, 0, 0],
    );
    await waitForMailboxCompletion(memory, mainChannelOffset);
    expect(readMailboxResult(memory, mainChannelOffset)).toEqual({
      value: tid,
      errno: 0,
    });

    writePendingSyscall(
      memory,
      threadChannelOffset,
      ABI_SYSCALLS.Exit,
      [0],
    );
    await waitForMailboxCompletion(memory, threadChannelOffset);

    // Still asks the host to tear down the backing thread Worker...
    expect(onThreadExit).toHaveBeenCalledWith(pid, tid, threadChannelOffset);
    // ...but now completes the channel so the guest's wait waiter is cleared.
    expect(readMailboxResult(memory, threadChannelOffset)).toEqual({
      value: 0,
      errno: 0,
    });
    expect(threadExit).toHaveBeenCalledWith(pid, tid);
  });

  it("keeps completing pthread SYS_EXIT channels when no host terminator is installed", async () => {
    const pid = 124;
    const mainChannelOffset = WASM_PAGE_SIZE;
    const threadChannelOffset = 2 * WASM_PAGE_SIZE;
    const tid = 78;
    const memory = new WebAssembly.Memory({
      initial: 4,
      maximum: 4,
      shared: true,
    });
    let harness!: GatedLifecycleHarness;
    const onClone = vi.fn((attachment) => {
      harness.worker.attachThreadChannel(attachment, threadChannelOffset);
      return Promise.resolve();
    });
    let kernelMemory!: WebAssembly.Memory;
    const handleChannel = vi.fn((rawOffset: number | bigint) => {
      const view = new DataView(
        kernelMemory.buffer,
        Number(rawOffset),
        CH_TOTAL_SIZE,
      );
      view.setBigInt64(CH_RETURN, BigInt(tid), true);
      view.setUint32(CH_ERRNO, 0, true);
      return 0;
    });
    const threadExit = vi.fn(() => 0n);
    harness = createGatedLifecycleHarness({
      callbacks: { onClone },
      kernelExports: {
        kernel_handle_channel: handleChannel,
        kernel_thread_exit: threadExit,
      },
    });
    kernelMemory = harness.kernelMemory;
    registerLifecycleProcess(
      harness,
      pid,
      memory,
      mainChannelOffset,
    );

    writePendingSyscall(
      memory,
      mainChannelOffset,
      ABI_SYSCALLS.Clone,
      [0, 0, 0, 0, 0, 0],
    );
    await waitForMailboxCompletion(memory, mainChannelOffset);

    writePendingSyscall(
      memory,
      threadChannelOffset,
      ABI_SYSCALLS.Exit,
      [0],
    );
    await waitForMailboxCompletion(memory, threadChannelOffset);

    expect(readMailboxResult(memory, threadChannelOffset)).toEqual({
      value: 0,
      errno: 0,
    });
    expect(threadExit).toHaveBeenCalledWith(pid, tid);
  });

  it("rejects pthread exit when the channel lost its kernel-allocated TID", () => {
    const pid = 124;
    const mainChannelOffset = WASM_PAGE_SIZE;
    const threadChannelOffset = 2 * WASM_PAGE_SIZE;
    const memory = new WebAssembly.Memory({
      initial: 4,
      maximum: 4,
      shared: true,
    });
    const threadExit = vi.fn(() => 0n);
    const onThreadExit = vi.fn();
    const harness = createGatedLifecycleHarness({
      callbacks: { onThreadExit },
      kernelExports: { kernel_thread_exit: threadExit },
    });
    const [registrationWitness] =
      harness.worker.testAuthority
        .replaceProcessRegistrationForLifecycleTest({
          pid,
          memory,
          channelOffsets: [mainChannelOffset],
        });
    const expected =
      `No kernel-validated TID for non-main channel ${threadChannelOffset} ` +
      `of process ${pid}`;

    let failure: unknown;
    try {
      harness.worker.testAuthority
        .dispatchUntrackedThreadExitForTaskAuthorityTest(
          pid,
          registrationWitness!,
          threadChannelOffset,
          0,
        );
    } catch (cause) {
      failure = cause;
    }
    expect(failure).toMatchObject({
      message:
        "void kernel ingress untracked pthread exit task-authority test failed",
      cause: { message: expected },
    });
    expect(threadExit).not.toHaveBeenCalled();
    expect(onThreadExit).not.toHaveBeenCalled();
  });

  it("rejects a stale process-generation witness for untracked pthread exit", () => {
    const pid = 124;
    const mainChannelOffset = WASM_PAGE_SIZE;
    const threadChannelOffset = 2 * WASM_PAGE_SIZE;
    const oldMemory = new WebAssembly.Memory({
      initial: 4,
      maximum: 4,
      shared: true,
    });
    const newMemory = new WebAssembly.Memory({
      initial: 4,
      maximum: 4,
      shared: true,
    });
    const threadExit = vi.fn(() => 0);
    const onThreadExit = vi.fn();
    const createProcess = vi.fn(() => 900);
    const harness = createGatedLifecycleHarness({
      callbacks: { onThreadExit },
      kernelExports: {
        kernel_create_process_with_stdio: createProcess,
        kernel_thread_exit: threadExit,
      },
    });
    const [staleWitness] =
      harness.worker.testAuthority
        .replaceProcessRegistrationForLifecycleTest({
          pid,
          memory: oldMemory,
          channelOffsets: [mainChannelOffset],
        });
    harness.worker.testAuthority
      .replaceProcessRegistrationForLifecycleTest({
        pid,
        memory: newMemory,
        channelOffsets: [mainChannelOffset],
      });

    expect(() =>
      harness.worker.testAuthority
        .dispatchUntrackedThreadExitForTaskAuthorityTest(
          pid,
          staleWitness!,
          threadChannelOffset,
          0,
        )
    ).toThrow(
      "task-authority test requires an untracked channel in the current process Memory generation",
    );
    expect(threadExit).not.toHaveBeenCalled();
    expect(onThreadExit).not.toHaveBeenCalled();

    // The stale capability is rejected without poisoning the selected
    // generation or retaining work for a later entry.
    expect(harness.worker.createProcess(CAPTURED_STDIO)).toBe(900);
    expect(createProcess).toHaveBeenCalledOnce();
  });

  it("rejects busy untracked pthread exit before reading or retaining its witness", async () => {
    const witnessRead = vi.fn();
    const hostileWitness = new Proxy(
      Object.create(null) as TestChannel,
      {
        get() {
          witnessRead();
          throw new Error("busy entry read the caller-owned witness");
        },
      },
    );
    const threadExit = vi.fn(() => 0);
    const onThreadExit = vi.fn();
    let harness!: GatedLifecycleHarness;
    const createProcess = vi.fn(() => {
      expect(() =>
        harness.worker.testAuthority
          .dispatchUntrackedThreadExitForTaskAuthorityTest(
            124,
            hostileWitness,
            2 * WASM_PAGE_SIZE,
            0,
          )
      ).toThrow(KernelReentrantEntryError);
      return 901;
    });
    harness = createGatedLifecycleHarness({
      callbacks: { onThreadExit },
      kernelExports: {
        kernel_create_process_with_stdio: createProcess,
        kernel_thread_exit: threadExit,
      },
    });

    expect(harness.worker.createProcess(CAPTURED_STDIO)).toBe(901);
    await Promise.resolve();

    expect(witnessRead).not.toHaveBeenCalled();
    expect(threadExit).not.toHaveBeenCalled();
    expect(onThreadExit).not.toHaveBeenCalled();
  });

  it("clears pthread child TID when forced thread cleanup skips guest SYS_EXIT", async () => {
    const pid = 125;
    const mainChannelOffset = WASM_PAGE_SIZE;
    const threadChannelOffset = 2 * WASM_PAGE_SIZE;
    const tid = 79;
    const replacementTid = 80;
    const ctidPtr = 0x00040000;
    const memory = new WebAssembly.Memory({
      initial: 16,
      maximum: 16,
      shared: true,
    });
    new DataView(memory.buffer).setInt32(ctidPtr, tid, true);
    let harness!: GatedLifecycleHarness;
    const onClone = vi.fn((attachment) => {
      harness.worker.attachThreadChannel(attachment, threadChannelOffset);
      return Promise.resolve();
    });
    let kernelMemory!: WebAssembly.Memory;
    let cloneCount = 0;
    const handleChannel = vi.fn((rawOffset: number | bigint) => {
      const view = new DataView(
        kernelMemory.buffer,
        Number(rawOffset),
        CH_TOTAL_SIZE,
      );
      view.setBigInt64(
        CH_RETURN,
        BigInt(cloneCount++ === 0 ? tid : replacementTid),
        true,
      );
      view.setUint32(CH_ERRNO, 0, true);
      return 0;
    });
    const threadExit = vi.fn()
      .mockReturnValueOnce(BigInt(ctidPtr))
      .mockReturnValueOnce(0n);
    harness = createGatedLifecycleHarness({
      callbacks: { onClone },
      kernelExports: {
        kernel_handle_channel: handleChannel,
        kernel_thread_exit: threadExit,
      },
    });
    kernelMemory = harness.kernelMemory;
    registerLifecycleProcess(
      harness,
      pid,
      memory,
      mainChannelOffset,
    );

    writePendingSyscall(
      memory,
      mainChannelOffset,
      ABI_SYSCALLS.Clone,
      [0x00200000, 0, 0, 0, ctidPtr, 0],
    );
    await waitForMailboxCompletion(memory, mainChannelOffset);

    harness.worker.finalizeThreadExit(pid, tid, threadChannelOffset);

    expect(new DataView(memory.buffer).getInt32(ctidPtr, true)).toBe(0);
    expect(threadExit).toHaveBeenCalledWith(pid, tid);

    // Reusing the exact channel offset proves forced cleanup released the
    // transport attachment as well as the guest clear-TID word.
    writePendingSyscall(
      memory,
      mainChannelOffset,
      ABI_SYSCALLS.Clone,
      [0, 0, 0, 0, 0, 0],
    );
    await waitForMailboxCompletion(memory, mainChannelOffset);
    expect(readMailboxResult(memory, mainChannelOffset)).toEqual({
      value: replacementTid,
      errno: 0,
    });
    harness.worker.finalizeThreadExit(
      pid,
      replacementTid,
      threadChannelOffset,
    );
  });

  it("registers pthread clear-TID before the host clone callback can complete", async () => {
    const pid = 126;
    const mainChannelOffset = WASM_PAGE_SIZE;
    const tid = 79;
    const stackPtr = 0x00800000;
    const tlsPtr = 0x00900000;
    const ctidPtr = 0x00040000;
    const memory = new WebAssembly.Memory({
      initial: 16,
      maximum: 16,
      shared: true,
    });
    let resolveClone!: () => void;
    let harness!: GatedLifecycleHarness;
    const onClone = vi.fn((attachment) => {
      harness.worker.attachThreadChannel(
        attachment,
        2 * WASM_PAGE_SIZE,
      );
      return new Promise<void>((resolve) => {
        resolveClone = resolve;
      });
    });
    let kernelMemory!: WebAssembly.Memory;
    const handleChannel = vi.fn((rawOffset: number | bigint) => {
      const view = new DataView(
        kernelMemory.buffer,
        Number(rawOffset),
        CH_TOTAL_SIZE,
      );
      view.setBigInt64(CH_RETURN, BigInt(tid), true);
      view.setUint32(CH_ERRNO, 0, true);
      return 0;
    });
    const threadExit = vi.fn(() => BigInt(ctidPtr));
    harness = createGatedLifecycleHarness({
      callbacks: { onClone },
      kernelExports: {
        kernel_handle_channel: handleChannel,
        kernel_thread_exit: threadExit,
      },
    });
    kernelMemory = harness.kernelMemory;
    registerLifecycleProcess(
      harness,
      pid,
      memory,
      mainChannelOffset,
    );

    writePendingSyscall(
      memory,
      mainChannelOffset,
      ABI_SYSCALLS.Clone,
      [0x00200000, stackPtr, 0, tlsPtr, ctidPtr, 0],
    );
    await waitForCondition(
      () => onClone.mock.calls.length === 1,
      "pending clone callback",
    );

    // Forced cleanup can find and clear the word before the callback promise
    // settles, proving the clone path published clear-TID ownership first.
    new DataView(memory.buffer).setInt32(ctidPtr, tid, true);
    harness.worker.finalizeThreadExit(
      pid,
      tid,
      2 * WASM_PAGE_SIZE,
    );
    expect(new DataView(memory.buffer).getInt32(ctidPtr, true)).toBe(0);
    expect(threadExit).toHaveBeenCalledWith(pid, tid);

    resolveClone();
    await waitForMailboxCompletion(memory, mainChannelOffset);
  });

  it("does not erase replacement clear-TID metadata from a stale clone completion", async () => {
    const pid = 126;
    const tid = 79;
    const oldCtidPtr = 0x00040000;
    const newCtidPtr = 0x00050000;
    const oldMemory = new WebAssembly.Memory({
      initial: 16,
      maximum: 16,
      shared: true,
    });
    const newMemory = new WebAssembly.Memory({
      initial: 16,
      maximum: 16,
      shared: true,
    });
    const channelOffset = WASM_PAGE_SIZE;
    const threadChannelOffset = 2 * WASM_PAGE_SIZE;
    new DataView(oldMemory.buffer).setInt32(oldCtidPtr, tid, true);
    new DataView(newMemory.buffer).setInt32(newCtidPtr, tid, true);
    let resolveClone!: () => void;
    let cloneCount = 0;
    let harness!: GatedLifecycleHarness;
    const onClone = vi.fn((attachment) => {
      cloneCount++;
      if (cloneCount === 1) {
        return new Promise<void>((resolve) => {
          resolveClone = resolve;
        });
      }
      harness.worker.attachThreadChannel(
        attachment,
        threadChannelOffset,
      );
      return Promise.resolve();
    });
    let kernelMemory!: WebAssembly.Memory;
    const handleChannel = vi.fn((rawOffset: number | bigint) => {
      const view = new DataView(
        kernelMemory.buffer,
        Number(rawOffset),
        CH_TOTAL_SIZE,
      );
      view.setBigInt64(CH_RETURN, BigInt(tid), true);
      view.setUint32(CH_ERRNO, 0, true);
      return 0;
    });
    const threadExit = vi.fn(() => BigInt(newCtidPtr));
    harness = createGatedLifecycleHarness({
      callbacks: { onClone },
      kernelExports: {
        kernel_handle_channel: handleChannel,
        kernel_thread_exit: threadExit,
      },
    });
    kernelMemory = harness.kernelMemory;
    registerLifecycleProcess(
      harness,
      pid,
      oldMemory,
      channelOffset,
    );

    writePendingSyscall(
      oldMemory,
      channelOffset,
      ABI_SYSCALLS.Clone,
      [0x00200000, 0x00800000, 0, 0x00900000, oldCtidPtr, 0],
    );
    await waitForCondition(
      () => onClone.mock.calls.length === 1,
      "old-generation clone callback",
    );

    const [newChannel] =
      harness.worker.testAuthority
        .replaceProcessRegistrationForLifecycleTest({
          pid,
          memory: newMemory,
          channelOffsets: [channelOffset],
        });
    writePendingSyscall(
      newMemory,
      channelOffset,
      ABI_SYSCALLS.Clone,
      [0x00200000, 0x00800000, 0, 0x00900000, newCtidPtr, 0],
    );
    harness.worker.testAuthority
      .dispatchScratchBoundarySyscallForTest(newChannel!);
    await waitForMailboxCompletion(newMemory, channelOffset);
    expect(readMailboxResult(newMemory, channelOffset)).toEqual({
      value: tid,
      errno: 0,
    });

    resolveClone();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    harness.worker.finalizeThreadExit(
      pid,
      tid,
      threadChannelOffset,
    );
    expect(new DataView(newMemory.buffer).getInt32(newCtidPtr, true)).toBe(0);
    expect(threadExit).toHaveBeenCalledTimes(1);
    expect(threadExit).toHaveBeenCalledWith(pid, tid);
    expect(
      Atomics.load(
        new Int32Array(oldMemory.buffer, channelOffset),
        CH_STATUS / Int32Array.BYTES_PER_ELEMENT,
      ),
    ).toBe(CHANNEL_STATUS_PENDING);
  });

  it("does not lower compact process max_addr when adding dynamic pthread channels", async () => {
    const setMaxAddr = vi.fn(() => 0);
    const highThreadChannelOffset = 0x04000000 + 2 * WASM_PAGE_SIZE;
    let kw!: CentralizedKernelWorker;
    kw = createCentralizedKernelWorkerTestDouble({
      callbacks: {
        onClone: (attachment) => {
          kw.attachThreadChannel(attachment, highThreadChannelOffset);
          return Promise.resolve();
        },
      },
    });
    const kernelMemory = new WebAssembly.Memory({ initial: 2, maximum: 2 });
    installKernelWorkerTestScratch(
      kw,
      kernelMemory,
      128,
      4,
      {
        kernelExports: {
          kernel_drain_wakeup_events: vi.fn(() => 0),
          kernel_get_process_exit_signal: vi.fn(() => -1),
          kernel_get_process_state: vi.fn(() => 0),
          kernel_handle_channel: vi.fn((offset: number) => {
            const kernelView = new DataView(kernelMemory.buffer, offset);
            kernelView.setBigInt64(CH_RETURN, 7n, true);
            kernelView.setUint32(CH_ERRNO, 0, true);
            return 0;
          }),
          kernel_set_brk_base: vi.fn(() => 0),
          kernel_set_current_tid: vi.fn(() => 0),
          kernel_set_max_addr: setMaxAddr,
          kernel_set_mmap_base: vi.fn(() => 0),
          kernel_validate_task: vi.fn(() => 0),
        },
        kernelExportNames: [
          "kernel_drain_wakeup_events",
          "kernel_get_process_exit_signal",
          "kernel_get_process_state",
          "kernel_handle_channel",
          "kernel_set_brk_base",
          "kernel_set_current_tid",
          "kernel_set_max_addr",
          "kernel_set_mmap_base",
          "kernel_validate_task",
        ],
      },
    );
    const memory = new WebAssembly.Memory({
      initial: highThreadChannelOffset / WASM_PAGE_SIZE + 1,
      maximum: DEFAULT_MAX_PAGES,
      shared: true,
    });
    const maxAddr = 0x20000000;
    const mainChannelOffset = 4 * WASM_PAGE_SIZE;

    kw.registerProcess(321, memory, [mainChannelOffset], {
      brkBase: 4 * WASM_PAGE_SIZE,
      mmapBase: 4 * WASM_PAGE_SIZE,
      maxAddr,
    });
    writePendingSyscall(
      memory,
      mainChannelOffset,
      ABI_SYSCALLS.Clone,
      [0, 0, 0, 0, 0, 0],
    );
    await waitForMailboxCompletion(memory, mainChannelOffset);

    expect(setMaxAddr).toHaveBeenCalledTimes(1);
    expect(setMaxAddr).toHaveBeenCalledWith(321, maxAddr);
  });

  it("rejects attaching host state to an unknown kernel process", () => {
    const kw = createRegistrationTestWorker(
      { kernel_get_process_state: vi.fn(() => -3) },
      ["kernel_get_process_state"],
    );
    const memory = new WebAssembly.Memory({
      initial: 16,
      maximum: 16,
      shared: true,
    });

    expect(() => kw.registerProcess(900, memory, [4 * WASM_PAGE_SIZE])).toThrow(
      "Cannot register unknown kernel process 900",
    );
  });

  it("rejects attaching host state to an exited kernel process", () => {
    const kw = createRegistrationTestWorker(
      { kernel_get_process_state: vi.fn(() => PROCESS_STATE_EXITED) },
      ["kernel_get_process_state"],
    );
    const memory = new WebAssembly.Memory({
      initial: 16,
      maximum: 16,
      shared: true,
    });

    expect(() => kw.registerProcess(900, memory, [4 * WASM_PAGE_SIZE])).toThrow(
      "Cannot register inactive kernel process 900",
    );
  });

  it("rejects attaching a host Worker to the kernel-reserved init PID", () => {
    const getProcessState = vi.fn(() => PROCESS_STATE_RUNNING);
    const kw = createRegistrationTestWorker(
      { kernel_get_process_state: getProcessState },
      ["kernel_get_process_state"],
    );
    const memory = new WebAssembly.Memory({
      initial: 16,
      maximum: 16,
      shared: true,
    });

    expect(() => kw.registerProcess(1, memory, [4 * WASM_PAGE_SIZE])).toThrow(
      "Cannot register the kernel-reserved init process",
    );
    expect(getProcessState).not.toHaveBeenCalled();
  });

  it("rejects a thread channel whose TID is not owned by the kernel process", async () => {
    const pid = 321;
    const mainChannelOffset = 4 * WASM_PAGE_SIZE;
    const threadChannelOffset = 8 * WASM_PAGE_SIZE;
    const tid = 999;
    const validateTask = vi.fn(() => -3);
    const memory = new WebAssembly.Memory({
      initial: 16,
      maximum: 16,
      shared: true,
    });
    let attachmentFailure: unknown;
    let harness!: GatedLifecycleHarness;
    const onClone = vi.fn((attachment) => {
      try {
        harness.worker.attachThreadChannel(
          attachment,
          threadChannelOffset,
        );
      } catch (cause) {
        attachmentFailure = cause;
        throw cause;
      }
      throw new Error("kernel-invalid TID was unexpectedly attached");
    });
    let kernelMemory!: WebAssembly.Memory;
    const handleChannel = vi.fn((rawOffset: number | bigint) => {
      const view = new DataView(
        kernelMemory.buffer,
        Number(rawOffset),
        CH_TOTAL_SIZE,
      );
      view.setBigInt64(CH_RETURN, BigInt(tid), true);
      view.setUint32(CH_ERRNO, 0, true);
      return 0;
    });
    const threadExit = vi.fn(() => 0);
    harness = createGatedLifecycleHarness({
      callbacks: { onClone },
      kernelExports: {
        kernel_handle_channel: handleChannel,
        kernel_thread_exit: threadExit,
        kernel_validate_task: validateTask,
      },
    });
    kernelMemory = harness.kernelMemory;
    registerLifecycleProcess(
      harness,
      pid,
      memory,
      mainChannelOffset,
    );

    writePendingSyscall(
      memory,
      mainChannelOffset,
      ABI_SYSCALLS.Clone,
      [0, 0, 0, 0, 0, 0],
    );
    await waitForCondition(
      () => attachmentFailure !== undefined,
      "kernel-invalid thread attachment rejection",
    );

    expect(attachmentFailure).toMatchObject({
      message: "void kernel ingress thread channel attachment failed",
      cause: {
        message: "Kernel rejected tid 999 for process 321: errno 3",
      },
    });
    expect(validateTask).toHaveBeenCalledWith(pid, 999);
    expect(threadExit).not.toHaveBeenCalled();
    expect(harness.worker.getProcessMemory(pid)).toBe(memory);
    expect(
      Atomics.load(
        new Int32Array(memory.buffer, mainChannelOffset),
        CH_STATUS / Int32Array.BYTES_PER_ELEMENT,
      ),
    ).toBe(CHANNEL_STATUS_PENDING);
  });

  it("rejects non-canonical or leader identities before attaching a thread channel", async () => {
    const pid = 321;
    const validateTask = vi.fn(() => 0);
    for (const tid of [pid, 0x8000_0000, 0x1_0000_0001]) {
      const memory = new WebAssembly.Memory({
        initial: 16,
        maximum: 16,
        shared: true,
      });
      const mainChannelOffset = 4 * WASM_PAGE_SIZE;
      const threadChannelOffset = 8 * WASM_PAGE_SIZE;
      let attachmentFailure: unknown;
      let harness!: GatedLifecycleHarness;
      const onClone = vi.fn((attachment) => {
        try {
          harness.worker.attachThreadChannel(
            attachment,
            threadChannelOffset,
          );
        } catch (cause) {
          attachmentFailure = cause;
          throw cause;
        }
        throw new Error("non-canonical TID was unexpectedly attached");
      });
      let kernelMemory!: WebAssembly.Memory;
      const handleChannel = vi.fn((rawOffset: number | bigint) => {
        const view = new DataView(
          kernelMemory.buffer,
          Number(rawOffset),
          CH_TOTAL_SIZE,
        );
        view.setBigInt64(CH_RETURN, BigInt(tid), true);
        view.setUint32(CH_ERRNO, 0, true);
        return 0;
      });
      harness = createGatedLifecycleHarness({
        callbacks: { onClone },
        kernelExports: {
          kernel_handle_channel: handleChannel,
          kernel_validate_task: validateTask,
        },
      });
      kernelMemory = harness.kernelMemory;
      registerLifecycleProcess(
        harness,
        pid,
        memory,
        mainChannelOffset,
      );

      writePendingSyscall(
        memory,
        mainChannelOffset,
        ABI_SYSCALLS.Clone,
        [0, 0, 0, 0, 0, 0],
      );
      await waitForCondition(
        () => attachmentFailure !== undefined,
        `non-canonical thread attachment rejection for ${tid}`,
      );
      expect(attachmentFailure).toMatchObject({
        message: "void kernel ingress thread channel attachment failed",
        cause: {
          message: expect.stringContaining(
            "requires a positive, non-leader kernel TID",
          ),
        },
      });
    }
    expect(validateTask).not.toHaveBeenCalled();
  });

  it("should register and unregister processes", async () => {
    const threadChannelOffsets = new Map<number, number>();
    const threadTids = new Map<number, number>();
    let harness!: GatedLifecycleHarness;
    const onClone = vi.fn((attachment) => {
      const channelOffset = threadChannelOffsets.get(attachment.pid);
      if (channelOffset === undefined) {
        throw new Error(
          `missing test thread channel for process ${attachment.pid}`,
        );
      }
      harness.worker.attachThreadChannel(attachment, channelOffset);
      threadTids.set(attachment.pid, attachment.tid);
      return Promise.resolve();
    });
    let kernelMemory!: WebAssembly.Memory;
    const handleChannel = vi.fn((
      rawOffset: number | bigint,
      _capacity: number,
      pid: number,
    ) => {
      const view = new DataView(
        kernelMemory.buffer,
        Number(rawOffset),
        CH_TOTAL_SIZE,
      );
      view.setBigInt64(CH_RETURN, BigInt(pid + 1000), true);
      view.setUint32(CH_ERRNO, 0, true);
      return 0;
    });
    harness = createGatedLifecycleHarness({
      callbacks: { onClone },
      kernelExports: { kernel_handle_channel: handleChannel },
    });
    kernelMemory = harness.kernelMemory;
    const kw = harness.worker;

    const proc1 = createProcessMemory();
    const proc2 = createProcessMemory();
    expect(proc1.memory.buffer.byteLength).toBeLessThan(MAX_PAGES * WASM_PAGE_SIZE);
    expect(proc2.memory.buffer.byteLength).toBeLessThan(MAX_PAGES * WASM_PAGE_SIZE);

    const firstPid = 500;
    const secondPid = 501;
    registerLifecycleProcess(
      harness,
      firstPid,
      proc1.memory,
      proc1.channelOffset,
    );
    registerLifecycleProcess(
      harness,
      secondPid,
      proc2.memory,
      proc2.channelOffset,
    );

    const firstThreadChannelOffset =
      proc1.channelOffset === WASM_PAGE_SIZE
        ? 2 * WASM_PAGE_SIZE
        : WASM_PAGE_SIZE;
    const secondThreadChannelOffset =
      proc2.channelOffset === WASM_PAGE_SIZE
        ? 2 * WASM_PAGE_SIZE
        : WASM_PAGE_SIZE;
    const firstCtidPtr = 4 * WASM_PAGE_SIZE;
    const secondCtidPtr = 5 * WASM_PAGE_SIZE;
    threadChannelOffsets.set(firstPid, firstThreadChannelOffset);
    threadChannelOffsets.set(secondPid, secondThreadChannelOffset);
    for (const [pid, process, ctidPtr] of [
      [firstPid, proc1, firstCtidPtr],
      [secondPid, proc2, secondCtidPtr],
    ] as const) {
      writePendingSyscall(
        process.memory,
        process.channelOffset,
        ABI_SYSCALLS.Clone,
        [0x00200000, 0, 0, 0, ctidPtr, 0],
      );
      await waitForMailboxCompletion(
        process.memory,
        process.channelOffset,
      );
      const tid = threadTids.get(pid);
      if (tid === undefined) {
        throw new Error(
          `clone did not attach for process ${pid}: ${
            JSON.stringify(readMailboxResult(
              process.memory,
              process.channelOffset,
            ))
          }`,
        );
      }
      new DataView(process.memory.buffer).setInt32(
        ctidPtr,
        tid,
        true,
      );
      expect(
        kw.testAuthority
          .inspectThreadTransportStateForLifecycleTest(pid),
      ).toEqual({
        channelTidEntries: 1,
        forkContextEntries: 1,
        activeThreadChannels: 1,
      });
    }

    // Unregister both without error
    kw.unregisterProcess(firstPid);
    expect(
      kw.testAuthority
        .inspectThreadTransportStateForLifecycleTest(firstPid),
    ).toEqual({
      channelTidEntries: 0,
      forkContextEntries: 0,
      activeThreadChannels: 0,
    });
    expect(
      kw.testAuthority
        .inspectThreadTransportStateForLifecycleTest(secondPid),
    ).toEqual({
      channelTidEntries: 1,
      forkContextEntries: 1,
      activeThreadChannels: 1,
    });
    expect(kw.getProcessMemory(firstPid)).toBeUndefined();
    expect(kw.getProcessMemory(secondPid)).toBe(proc2.memory);

    kw.unregisterProcess(secondPid);
    expect(
      kw.testAuthority
        .inspectThreadTransportStateForLifecycleTest(secondPid),
    ).toEqual({
      channelTidEntries: 0,
      forkContextEntries: 0,
      activeThreadChannels: 0,
    });
    expect(kw.getProcessMemory(secondPid)).toBeUndefined();

    // Unregistering non-existent pid should not throw
    kw.unregisterProcess(999);
  });

  it("closes live host file handles when unregistering a process", async () => {
    const io = new NodePlatformIO();
    const open = vi.spyOn(io, "open");
    const close = vi.spyOn(io, "close");
    const kw = new CentralizedKernelWorker(
      { maxWorkers: 4, dataBufferSize: 65536, useSharedMemory: true },
      io,
    );
    await kw.init(loadKernelWasm());

    const procMemory = createProcessMemory();
    const pid = createAndRegisterProcess(kw, procMemory);

    // Issue open(2) directly through the real kernel export so the Rust
    // Process owns the exact host handle that unregisterProcess must release.
    const opened = await issueDirectKernelOpen(
      kw,
      pid,
      procMemory,
      join(process.cwd(), "../Cargo.toml"),
    );

    expect(opened.errno).toBe(0);
    expect(opened.value).toBeGreaterThanOrEqual(3);
    expect(open).toHaveBeenCalledOnce();
    const hostHandle = open.mock.results[0].value;
    expect(close).not.toHaveBeenCalledWith(hostHandle);

    kw.unregisterProcess(pid);

    expect(close).toHaveBeenCalledWith(hostHandle);
  });

  it("releases a retained mmap handle before forced descriptor teardown", async () => {
    const tempDirectory = makeHostScratchTempRoot("kandelo-mmap-teardown-");
    const filePath = join(tempDirectory, "mapped.bin");
    writeFileSync(filePath, new Uint8Array(4096).fill(0x41));
    const io = new NodePlatformIO();
    const open = vi.spyOn(io, "open");
    const write = vi.spyOn(io, "write");
    const close = vi.spyOn(io, "close");
    const kw = new CentralizedKernelWorker(
      { maxWorkers: 4, dataBufferSize: 65536, useSharedMemory: true },
      io,
    );
    let pid: number | undefined;
    try {
      await kw.init(loadKernelWasm());

      const procMemory = createProcessMemory();
      pid = createAndRegisterProcess(kw, procMemory);
      const opened = await issueDirectKernelOpen(
        kw,
        pid,
        procMemory,
        filePath,
        2, // O_RDWR
      );
      const guestFd = opened.value;
      expect(opened.errno).toBe(0);
      expect(guestFd).toBeGreaterThanOrEqual(3);
      expect(open).toHaveBeenCalledOnce();
      const hostHandle = open.mock.results[0]!.value;

      writePendingSyscall(
        procMemory.memory,
        procMemory.channelOffset,
        ABI_SYSCALLS.Mmap,
        [
          0,
          4096,
          3, // PROT_READ | PROT_WRITE
          1, // MAP_SHARED
          guestFd,
          0,
        ],
      );
      await waitForMailboxCompletion(
        procMemory.memory,
        procMemory.channelOffset,
      );
      const mapped = readMailboxResult(
        procMemory.memory,
        procMemory.channelOffset,
      );
      expect(mapped.errno).toBe(0);
      expect(mapped.value).toBeGreaterThan(0);

      new Uint8Array(procMemory.memory.buffer)[mapped.value] = 0x42;
      kw.unregisterProcess(pid);

      const hostWriteCall = write.mock.calls.findIndex(
        ([handle]) => handle === hostHandle,
      );
      const hostCloseCall = close.mock.calls.findIndex(
        ([handle]) => handle === hostHandle,
      );
      expect(hostWriteCall).toBeGreaterThanOrEqual(0);
      expect(hostCloseCall).toBeGreaterThanOrEqual(0);
      expect(write.mock.invocationCallOrder[hostWriteCall]!).toBeLessThan(
        close.mock.invocationCallOrder[hostCloseCall]!,
      );
      expect(readFileSync(filePath)[0]).toBe(0x42);
      expect(kw.getProcessMemory(pid)).toBeUndefined();
    } finally {
      if (pid !== undefined) kw.unregisterProcess(pid);
      rmSync(tempDirectory, { recursive: true, force: true });
    }
  });

  it("repeated compact-layout launches do not leave process registrations behind", async () => {
    const kw = new CentralizedKernelWorker(
      { maxWorkers: 4, dataBufferSize: 65536, useSharedMemory: true },
      new NodePlatformIO(),
    );
    await kw.init(loadKernelWasm());

    const pids: number[] = [];
    for (let launch = 0; launch < 40; launch++) {
      const proc = createProcessMemory();
      expect(proc.memory.buffer.byteLength).toBeLessThan(MAX_PAGES * WASM_PAGE_SIZE);
      const pid = createAndRegisterProcess(kw, proc);
      pids.push(pid);
      kw.unregisterProcess(pid);
    }

    for (const pid of pids) {
      expect(kw.getProcessMemory(pid)).toBeUndefined();
    }
  });

  it("keeps process allocation monotonic after host unregister", async () => {
    const kw = new CentralizedKernelWorker(
      { maxWorkers: 4, dataBufferSize: 65536, useSharedMemory: true },
      new NodePlatformIO(),
    );
    await kw.init(loadKernelWasm());

    const firstPid = createAndRegisterProcess(kw, createProcessMemory());
    kw.unregisterProcess(firstPid);
    const secondPid = createAndRegisterProcess(kw, createProcessMemory());
    expect(secondPid).toBeGreaterThan(firstPid);
    kw.unregisterProcess(secondPid);
  });

  it("should throw when registering duplicate PID", async () => {
    const kw = new CentralizedKernelWorker(
      { maxWorkers: 4, dataBufferSize: 65536, useSharedMemory: true },
      new NodePlatformIO(),
    );
    await kw.init(loadKernelWasm());

    const proc1 = createProcessMemory();
    const proc2 = createProcessMemory();

    const pid = createAndRegisterProcess(kw, proc1);
    expect(() => attachProcess(kw, pid, proc2)).toThrow(
      `Process ${pid} is already registered with the host`,
    );

    kw.unregisterProcess(pid);
  });

  it("should throw when registering before init", () => {
    const kw = new CentralizedKernelWorker(
      { maxWorkers: 4, dataBufferSize: 65536, useSharedMemory: true },
      new NodePlatformIO(),
    );

    const proc = createProcessMemory();
    expect(() => attachProcess(kw, 100, proc)).toThrow(
      "Kernel not initialized",
    );
  });
});
