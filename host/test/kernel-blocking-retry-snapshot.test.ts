import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createCentralizedKernelWorkerTestDouble } from "../src/kernel-worker";
import {
  ABI_SYSCALLS,
  CHANNEL_STATUS_COMPLETE,
  CHANNEL_STATUS_PENDING,
  CH_ARGS,
  CH_ARG_SIZE,
  CH_DATA,
  CH_ERRNO,
  CH_REQUEST_FLAGS,
  CH_RETURN,
  CH_SIG_FLAGS,
  CH_SIG_SIGNUM,
  CH_STATUS,
  CH_SYSCALL,
  CHANNEL_REQUEST_FLAG_CANCELLATION_POINT,
  CHANNEL_REQUEST_FLAG_CANCELLATION_WAKE_ALLOWED,
  FCNTL_FLOCK_BYTES,
  KERNEL_IOVEC_WIRE_BASE_OFFSET,
  KERNEL_IOVEC_WIRE_LEN_OFFSET,
  KERNEL_MSGHDR_WIRE_CONTROLLEN_OFFSET,
  KERNEL_MSGHDR_WIRE_FLAGS_OFFSET,
  KERNEL_MSGHDR_WIRE_IOV_OFFSET,
  KERNEL_MSGHDR_WIRE_IOVLEN_OFFSET,
  KERNEL_MSGHDR_WIRE_NAMELEN_OFFSET,
  PROCESS_MSGHDR_WASM32_CONTROLLEN_OFFSET,
  PROCESS_MSGHDR_WASM32_CONTROL_OFFSET,
  PROCESS_MSGHDR_WASM32_FLAGS_OFFSET,
  PROCESS_MSGHDR_WASM32_IOVLEN_OFFSET,
  PROCESS_MSGHDR_WASM32_IOV_OFFSET,
  PROCESS_MSGHDR_WASM32_NAMELEN_OFFSET,
  PROCESS_MSGHDR_WASM32_NAME_OFFSET,
  PROCESS_MSGHDR_WASM32_SIZE,
  PROCESS_MSGHDR_WASM64_CONTROLLEN_OFFSET,
  PROCESS_MSGHDR_WASM64_CONTROL_OFFSET,
  PROCESS_MSGHDR_WASM64_FLAGS_OFFSET,
  PROCESS_MSGHDR_WASM64_IOVLEN_OFFSET,
  PROCESS_MSGHDR_WASM64_IOV_OFFSET,
  PROCESS_MSGHDR_WASM64_NAMELEN_OFFSET,
  PROCESS_MSGHDR_WASM64_NAME_OFFSET,
  PROCESS_MSGHDR_WASM64_SIZE,
  PROCESS_STATE_EXITED,
  SELECT_FD_SET_BYTES,
  SIGNAL_MASK_BYTES,
  STRUCT_SIZE_WASM_POLL_FD,
  STRUCT_SIZE_WASM_SYSV_MESSAGE_HEADER,
  WASM_POLL_FD_EVENTS_OFFSET,
  WASM_POLL_FD_FD_OFFSET,
  WASM_POLL_FD_REVENTS_OFFSET,
} from "../src/generated/abi";
import { installKernelWorkerTestScratch } from "./kernel-worker-test-scratch";

const EAGAIN = 11;
const EINTR = 4;
const EINPROGRESS = 115;
const ESRCH = 3;
const IPC_NOWAIT = 0x800;
const MSG_DONTWAIT = 0x40;
const SA_RESTART = 0x10000000;
const SIGUSR1 = 10;
const WIDTHS = [
  ["wasm32", 4],
  ["wasm64", 8],
] as const;
const KERNEL_WORKER_SOURCE = readFileSync(
  new URL("../src/kernel-worker.ts", import.meta.url),
  "utf8",
);
const BLOCKED_RETRY_SOURCE = readFileSync(
  new URL("../../crates/runtime-core/src/blocked_retry.rs", import.meta.url),
  "utf8",
);
const CHANNEL_SYSCALL_SOURCE = readFileSync(
  new URL("../../libc/glue/channel_syscall.c", import.meta.url),
  "utf8",
);
const PTHREAD_CANCEL_SOURCE = readFileSync(
  new URL(
    "../../libc/musl-overlay/src/thread/wasm32posix/pthread_cancel.c",
    import.meta.url,
  ),
  "utf8",
);
const RUST_TARGETED_RETRY_OPERATIONS = [
  "Accept",
  "Connect",
  "CopyFileRange",
  "Fcntl",
  "Flock",
  "MqReceive",
  "MqSend",
  "MsgReceive",
  "MsgSend",
  "Pread",
  "Pwrite",
  "Read",
  "Recv",
  "Recvfrom",
  "Recvmsg",
  "Semop",
  "Send",
  "Sendfile",
  "Sendmsg",
  "Sendto",
  "Splice",
  "Write",
] as const;

interface RetryHarness {
  readonly worker: Record<string, any>;
  readonly channel: Record<string, any>;
  readonly channels: readonly Record<string, any>[];
  readonly processMemory: WebAssembly.Memory;
  readonly processBytes: Uint8Array;
  readonly kernelBytes: Uint8Array;
  readonly kernelExports: Record<string, unknown>;
  readonly scratchOffset: number;
  readonly relistenChannel: ReturnType<typeof vi.fn>;
  readonly onKernelFatal: ReturnType<typeof vi.fn>;
}

interface NativeMessageLayout {
  readonly size: number;
  readonly nameOffset: number;
  readonly nameLengthOffset: number;
  readonly iovecOffset: number;
  readonly iovecLengthOffset: number;
  readonly controlOffset: number;
  readonly controlLengthOffset: number;
  readonly flagsOffset: number;
}

function sharedMemory(pages = 8, maximumPages = pages): WebAssembly.Memory {
  return new WebAssembly.Memory({
    initial: pages,
    maximum: maximumPages,
    shared: true,
  });
}

function nativeMessageLayout(pointerWidth: 4 | 8): NativeMessageLayout {
  return pointerWidth === 8
    ? {
        size: PROCESS_MSGHDR_WASM64_SIZE,
        nameOffset: PROCESS_MSGHDR_WASM64_NAME_OFFSET,
        nameLengthOffset: PROCESS_MSGHDR_WASM64_NAMELEN_OFFSET,
        iovecOffset: PROCESS_MSGHDR_WASM64_IOV_OFFSET,
        iovecLengthOffset: PROCESS_MSGHDR_WASM64_IOVLEN_OFFSET,
        controlOffset: PROCESS_MSGHDR_WASM64_CONTROL_OFFSET,
        controlLengthOffset: PROCESS_MSGHDR_WASM64_CONTROLLEN_OFFSET,
        flagsOffset: PROCESS_MSGHDR_WASM64_FLAGS_OFFSET,
      }
    : {
        size: PROCESS_MSGHDR_WASM32_SIZE,
        nameOffset: PROCESS_MSGHDR_WASM32_NAME_OFFSET,
        nameLengthOffset: PROCESS_MSGHDR_WASM32_NAMELEN_OFFSET,
        iovecOffset: PROCESS_MSGHDR_WASM32_IOV_OFFSET,
        iovecLengthOffset: PROCESS_MSGHDR_WASM32_IOVLEN_OFFSET,
        controlOffset: PROCESS_MSGHDR_WASM32_CONTROL_OFFSET,
        controlLengthOffset: PROCESS_MSGHDR_WASM32_CONTROLLEN_OFFSET,
        flagsOffset: PROCESS_MSGHDR_WASM32_FLAGS_OFFSET,
      };
}

function createRetryHarness(
  pointerWidth: 4 | 8,
  options: {
    readonly channelOffsets?: readonly number[];
    readonly maximumProcessPages?: number;
  } = {},
): RetryHarness {
  const pid = 41;
  const scratchOffset = 4096;
  const channelOffsets = options.channelOffsets ?? [6 * 65_536];
  const kernelMemory = new WebAssembly.Memory({
    initial: 4,
    maximum: 4,
  });
  const processMemory = sharedMemory(
    8,
    options.maximumProcessPages ?? 8,
  );
  const kernelBytes = new Uint8Array(kernelMemory.buffer);
  const processBytes = new Uint8Array(processMemory.buffer);
  const hostOnlyRetrySyscalls = new Set<number>([
    ABI_SYSCALLS.Open,
    ABI_SYSCALLS.Openat,
    ABI_SYSCALLS.Poll,
    ABI_SYSCALLS.Ppoll,
    ABI_SYSCALLS.RtSigtimedwait,
    ABI_SYSCALLS.Select,
    ABI_SYSCALLS.Pselect6,
  ]);
  const kernelExports: Record<string, unknown> = {
    kernel_blocking_retry_release: vi.fn(() => 0),
    kernel_blocking_retry_token: vi.fn(
      (_pid: number, _tid: number, syscall: number) =>
        hostOnlyRetrySyscalls.has(syscall) ? 0n : 1n,
    ),
    kernel_dequeue_signal: () => 0,
    kernel_get_fd_accept_wake_idx: vi.fn(() => -1),
    kernel_get_fd_pipe_idx: vi.fn(() => -1),
    kernel_get_process_exit_signal: () => -1,
    kernel_get_process_state: () => 0,
    kernel_get_socket_timeout_ms: vi.fn(() => 0n),
    kernel_generate_host_signal: () => 0,
    kernel_handle_channel: () => 0,
    kernel_is_fd_nonblock: () => 0,
    kernel_mq_descriptor_msgsize: () => 4,
    kernel_pick_signal_target_tid: vi.fn(() => pid),
    kernel_set_current_tid: () => 0,
    kernel_thread_has_deliverable: vi.fn(() => 1),
  };
  const onKernelFatal = vi.fn();
  const worker = createCentralizedKernelWorkerTestDouble({
    callbacks: { onKernelFatal },
  }) as unknown as Record<string, any>;
  installKernelWorkerTestScratch(
    worker,
    kernelMemory,
    scratchOffset,
    pointerWidth,
    {
      kernelExports,
      kernelExportNames: Object.keys(kernelExports),
    },
  );
  const relistenChannel = vi.fn();
  worker.testAuthority.configureScratchBoundaryHooksForTest({
    handleSharedMappingsAfterFileSyscall: vi.fn(),
    relistenChannel,
    synchronizeSharedMemoryForBoundary: vi.fn(),
  });
  const channels =
    worker.testAuthority.replaceProcessRegistrationForLifecycleTest({
      pid,
      memory: processMemory,
      channelOffsets,
      pointerWidth,
    });
  const channel = channels[0]!;

  return {
    worker,
    channel,
    channels,
    processMemory,
    processBytes,
    kernelBytes,
    kernelExports,
    scratchOffset,
    relistenChannel,
    onKernelFatal,
  };
}

function writeRequest(
  harness: RetryHarness,
  syscall: number,
  args: readonly bigint[],
  channel = harness.channel,
  cancellationPoint = false,
  cancellationWakeAllowed = cancellationPoint,
): void {
  const view = new DataView(
    harness.processMemory.buffer,
    channel.channelOffset,
  );
  view.setUint32(CH_STATUS, CHANNEL_STATUS_PENDING, true);
  view.setUint32(CH_SYSCALL, syscall, true);
  view.setUint32(
    CH_REQUEST_FLAGS,
    (cancellationPoint
      ? CHANNEL_REQUEST_FLAG_CANCELLATION_POINT
      : 0)
      | (cancellationWakeAllowed
        ? CHANNEL_REQUEST_FLAG_CANCELLATION_WAKE_ALLOWED
        : 0),
    true,
  );
  view.setBigInt64(CH_RETURN, 0n, true);
  view.setUint32(CH_ERRNO, 0, true);
  for (let index = 0; index < 6; index++) {
    view.setBigInt64(CH_ARGS + index * CH_ARG_SIZE, args[index] ?? 0n, true);
  }
}

function requestStatus(
  harness: RetryHarness,
  channel = harness.channel,
): number {
  return new DataView(
    harness.processMemory.buffer,
    channel.channelOffset,
  ).getUint32(CH_STATUS, true);
}

function requestResult(
  harness: RetryHarness,
  channel = harness.channel,
): {
  readonly status: number;
  readonly returnValue: number;
  readonly errno: number;
} {
  const view = new DataView(
    harness.processMemory.buffer,
    channel.channelOffset,
  );
  return {
    status: view.getUint32(CH_STATUS, true),
    returnValue: Number(view.getBigInt64(CH_RETURN, true)),
    errno: view.getUint32(CH_ERRNO, true),
  };
}

function kernelView(
  harness: RetryHarness,
  rawPointer: number | bigint,
): DataView {
  return new DataView(harness.kernelBytes.buffer, Number(rawPointer));
}

function kernelArg(view: DataView, index: number): bigint {
  return view.getBigInt64(CH_ARGS + index * CH_ARG_SIZE, true);
}

function publishKernelResult(
  view: DataView,
  returnValue: number,
  errno: number,
): void {
  view.setBigInt64(CH_RETURN, BigInt(returnValue), true);
  view.setUint32(CH_ERRNO, errno, true);
}

function writeKernelCaughtSignal(
  harness: RetryHarness,
  rawPointer: number | bigint,
  flags = SA_RESTART,
): number {
  const pointer = Number(rawPointer);
  const view = new DataView(harness.kernelBytes.buffer);
  view.setUint32(pointer, SIGUSR1, true);
  view.setUint32(pointer + 4, 0x1234, true);
  view.setUint32(pointer + 8, flags, true);
  return SIGUSR1;
}

function writeNativeIovec(
  bytes: Uint8Array,
  pointerWidth: 4 | 8,
  tablePointer: number,
  index: number,
  base: number,
  length: number,
): void {
  const view = new DataView(bytes.buffer);
  const entry = tablePointer + index * 2 * pointerWidth;
  if (pointerWidth === 8) {
    view.setBigUint64(entry, BigInt(base), true);
    view.setBigUint64(entry + 8, BigInt(length), true);
  } else {
    view.setUint32(entry, base, true);
    view.setUint32(entry + 4, length, true);
  }
}

function writeNativeMessage(
  bytes: Uint8Array,
  pointerWidth: 4 | 8,
  messagePointer: number,
  iovecPointer: number,
  iovecCount: number,
): void {
  const layout = nativeMessageLayout(pointerWidth);
  bytes.fill(0, messagePointer, messagePointer + layout.size);
  const view = new DataView(bytes.buffer);
  if (pointerWidth === 8) {
    view.setBigUint64(messagePointer + layout.nameOffset, 0n, true);
    view.setBigUint64(
      messagePointer + layout.iovecOffset,
      BigInt(iovecPointer),
      true,
    );
    view.setBigUint64(messagePointer + layout.controlOffset, 0n, true);
  } else {
    view.setUint32(messagePointer + layout.nameOffset, 0, true);
    view.setUint32(messagePointer + layout.iovecOffset, iovecPointer, true);
    view.setUint32(messagePointer + layout.controlOffset, 0, true);
  }
  view.setUint32(messagePointer + layout.nameLengthOffset, 0, true);
  view.setUint32(messagePointer + layout.iovecLengthOffset, iovecCount, true);
  view.setUint32(messagePointer + layout.controlLengthOffset, 0, true);
  view.setUint32(messagePointer + layout.flagsOffset, 0, true);
}

function writeNativeSysvMessage(
  bytes: Uint8Array,
  pointerWidth: 4 | 8,
  pointer: number,
  type: bigint,
  payload: readonly number[],
): void {
  const view = new DataView(bytes.buffer);
  if (pointerWidth === 8) {
    view.setBigInt64(pointer, type, true);
  } else {
    view.setInt32(pointer, Number(type), true);
  }
  bytes.set(payload, pointer + pointerWidth);
}

function writeNativeSemop(
  bytes: Uint8Array,
  pointer: number,
  index: number,
  number: number,
  operation: number,
  flags: number,
): void {
  const view = new DataView(bytes.buffer);
  const offset = pointer + index * 6;
  view.setUint16(offset, number, true);
  view.setInt16(offset + 2, operation, true);
  view.setUint16(offset + 4, flags, true);
}

function writeNativeOffset(
  bytes: Uint8Array,
  pointer: number,
  value: bigint,
): void {
  new DataView(bytes.buffer).setBigInt64(pointer, value, true);
}

function readNativeOffset(bytes: Uint8Array, pointer: number): bigint {
  return new DataView(bytes.buffer).getBigInt64(pointer, true);
}

function readNativeSysvMessage(
  bytes: Uint8Array,
  pointerWidth: 4 | 8,
  pointer: number,
  payloadLength: number,
): { readonly type: bigint; readonly payload: number[] } {
  const view = new DataView(bytes.buffer);
  const type =
    pointerWidth === 8
      ? view.getBigInt64(pointer, true)
      : BigInt(view.getInt32(pointer, true));
  return {
    type,
    payload: Array.from(
      bytes.slice(
        pointer + pointerWidth,
        pointer + pointerWidth + payloadLength,
      ),
    ),
  };
}

async function retryAfterDefaultDelay(
  harness: RetryHarness,
  channel = harness.channel,
): Promise<void> {
  expect(harness.worker.pendingPollRetries.has(channel)).toBe(true);
  await vi.advanceTimersByTimeAsync(10);
  await Promise.resolve();
}

function expectExactRetryBindingLifecycle(
  harness: RetryHarness,
  syscall: number,
  token = 1n,
  channel = harness.channel,
): void {
  const tokenForRetry = harness.kernelExports
    .kernel_blocking_retry_token as ReturnType<typeof vi.fn>;
  const release = harness.kernelExports
    .kernel_blocking_retry_release as ReturnType<typeof vi.fn>;
  const handleChannel = harness.kernelExports
    .kernel_handle_channel as ReturnType<typeof vi.fn>;
  const tid =
    harness.worker.channelTids.get(
      `${channel.pid}:${channel.channelOffset}`,
    ) ?? channel.pid;

  expect(tokenForRetry).toHaveBeenCalledOnce();
  expect(tokenForRetry).toHaveBeenCalledWith(channel.pid, tid, syscall);
  expect(handleChannel.mock.calls.map((call) => call[3])).toEqual([
    0n,
    token,
  ]);
  expect(release).toHaveBeenCalledOnce();
  expect(release).toHaveBeenCalledWith(channel.pid, tid, token);
}

function expectHostOnlyRetryLifecycle(
  harness: RetryHarness,
  syscall: number,
  channel = harness.channel,
): void {
  const tokenForRetry = harness.kernelExports
    .kernel_blocking_retry_token as ReturnType<typeof vi.fn>;
  const release = harness.kernelExports
    .kernel_blocking_retry_release as ReturnType<typeof vi.fn>;
  const handleChannel = harness.kernelExports
    .kernel_handle_channel as ReturnType<typeof vi.fn>;

  const tid =
    harness.worker.channelTids.get(
      `${channel.pid}:${channel.channelOffset}`,
    ) ?? channel.pid;
  expect(tokenForRetry).toHaveBeenCalledOnce();
  expect(tokenForRetry).toHaveBeenCalledWith(channel.pid, tid, syscall);
  expect(handleChannel.mock.calls.map((call) => call[3])).toEqual([0n, 0n]);
  expect(release).not.toHaveBeenCalled();
}

describe("blocking retry snapshot contract", () => {
  it("publishes call-site cancellation identity before PENDING and consumes it once", () => {
    const requestPublish = CHANNEL_SYSCALL_SOURCE.match(
      /restart_wait_syscall:[\s\S]*?__c11_atomic_store\([\s\S]*?CH_PENDING,[\s\S]*?\);/,
    )?.[0];
    expect(requestPublish, "libc request publication").toBeDefined();
    const flagWrite = requestPublish!.indexOf(
      "*(uint32_t *)(uintptr_t)(base + CH_REQUEST_FLAGS) = request_flags",
    );
    const wakeAuthority = requestPublish!.indexOf(
      "__syscall_cp_cancel_wake_allowed()",
    );
    const pendingWrite = requestPublish!.indexOf("CH_PENDING");
    expect(wakeAuthority).toBeGreaterThanOrEqual(0);
    expect(flagWrite).toBeGreaterThanOrEqual(0);
    expect(flagWrite).toBeGreaterThan(wakeAuthority);
    expect(pendingWrite).toBeGreaterThan(flagWrite);
    expect(CHANNEL_SYSCALL_SOURCE).toContain(
      "return __do_syscall_impl(n, a1, a2, a3, a4, a5, a6, 0, 0u);",
    );
    expect(CHANNEL_SYSCALL_SOURCE).toContain(
      "long r = __do_syscall_impl(n, a1, a2, a3, a4, a5, a6, 1, 0u);",
    );
    expect(CHANNEL_SYSCALL_SOURCE).toContain(
      "CH_REQUEST_FLAG_DEFER_SIGNAL_DELIVERY",
    );
    expect(CHANNEL_SYSCALL_SOURCE).toContain(
      "request_flags |= CH_REQUEST_FLAG_CANCELLATION_WAKE_ALLOWED",
    );
    expect(CHANNEL_SYSCALL_SOURCE).not.toContain(
      "__syscall_cp_cancel_pending_disabled",
    );
    expect(CHANNEL_SYSCALL_SOURCE).not.toMatch(
      /n == SYS_OPEN\s*\|\|\s*n == SYS_OPENAT/,
    );
    expect(PTHREAD_CANCEL_SOURCE).toContain(
      "hidden int __syscall_cp_cancel_wake_allowed(void)",
    );
    expect(PTHREAD_CANCEL_SOURCE).toContain(
      "self->canceldisable != PTHREAD_CANCEL_DISABLE",
    );

    const hostCaptureStart = KERNEL_WORKER_SOURCE.indexOf(
      "  #captureChannelRequest(\n    channel: ChannelInfo,",
    );
    const hostCaptureEnd = KERNEL_WORKER_SOURCE.indexOf(
      "\n  /** Fail closed",
      hostCaptureStart,
    );
    expect(hostCaptureStart, "host request-identity capture start")
      .toBeGreaterThanOrEqual(0);
    expect(hostCaptureEnd, "host request-identity capture end")
      .toBeGreaterThan(hostCaptureStart);
    const hostCapture = KERNEL_WORKER_SOURCE.slice(
      hostCaptureStart,
      hostCaptureEnd,
    );
    const read = hostCapture.indexOf(
      "processView.getUint32(CH_REQUEST_FLAGS, true)",
    );
    const clear = hostCapture.indexOf(
      "processView.setUint32(CH_REQUEST_FLAGS, 0, true)",
    );
    const freeze = hostCapture.indexOf(
      "const request = kernelEntryIntrinsicObjectFreeze",
    );
    expect(read).toBeGreaterThanOrEqual(0);
    expect(clear).toBeGreaterThan(read);
    expect(freeze).toBeGreaterThan(clear);
    expect(hostCapture).toMatch(
      /requestFlags\s*& CHANNEL_REQUEST_FLAG_CANCELLATION_POINT/,
    );
    expect(hostCapture).toMatch(
      /requestFlags\s*& CHANNEL_REQUEST_FLAG_CANCELLATION_WAKE_ALLOWED/,
    );
    expect(hostCapture).toContain(
      "requestFlags & ~CHANNEL_REQUEST_FLAGS_KNOWN_MASK",
    );
    expect(hostCapture).toContain(
      "cancellationWakeAllowed && !cancellationPoint",
    );
  });

  it("keeps Rust retry-operation families on the reviewed host snapshot allowlist", () => {
    const operationEnum = BLOCKED_RETRY_SOURCE.match(
      /enum BlockingRetryOperation\s*\{([\s\S]*?)\n\}/,
    )?.[1];
    expect(operationEnum, "BlockingRetryOperation enum").toBeDefined();
    const operations = Array.from(
      operationEnum!.matchAll(/^\s{4}([A-Z][A-Za-z0-9]*),\s*$/gm),
      (match) => match[1],
    ).sort();
    expect(operations).toEqual(RUST_TARGETED_RETRY_OPERATIONS);

    const genericSet = KERNEL_WORKER_SOURCE.match(
      /const GENERIC_BLOCKING_SNAPSHOT_SYSCALLS = new Set<number>\(\[([\s\S]*?)\]\);/,
    )?.[1];
    expect(genericSet, "generic blocking snapshot set").toBeDefined();
    for (const syscall of [
      "Read",
      "Write",
      "Pread",
      "Pwrite",
      "Recv",
      "Send",
      "Recvfrom",
      "Sendto",
      "MqTimedsend",
      "MqTimedreceive",
      "Semop",
      "Sendfile",
      "CopyFileRange",
      "Splice",
    ]) {
      expect(genericSet).toContain(`ABI_SYSCALLS.${syscall}`);
    }
    // These families need nested-layout-specific plans and are deliberately
    // reviewed outside the generic channel abstraction.
    for (const kind of [
      "flattened-transfer",
      "sendmsg",
      "recvmsg",
      "sysv-message",
    ]) {
      expect(KERNEL_WORKER_SOURCE).toContain(`kind: "${kind}"`);
    }
  });

  it("keeps token zero exclusive to seven reviewed host-only snapshot families", () => {
    const hostOnlyClassifier = BLOCKED_RETRY_SOURCE.match(
      /fn is_explicit_host_only_snapshot_syscall\(syscall: u32\) -> bool \{([\s\S]*?)\n\}/,
    )?.[1];
    expect(
      hostOnlyClassifier,
      "explicit host-only snapshot classifier",
    ).toBeDefined();
    const hostOnlyFamilies = Array.from(
      hostOnlyClassifier!.matchAll(
        /syscall == ((?:Syscall::[A-Za-z0-9_]+ as u32)|(?:extended_syscalls::SYS_[A-Z0-9_]+))/g,
      ),
      (match) => match[1],
    ).sort();
    expect(hostOnlyFamilies).toEqual([
      "Syscall::Open as u32",
      "Syscall::Openat as u32",
      "Syscall::Poll as u32",
      "Syscall::Select as u32",
      "extended_syscalls::SYS_PPOLL",
      "extended_syscalls::SYS_PSELECT6",
      "extended_syscalls::SYS_RT_SIGTIMEDWAIT",
    ]);

    const fromSyscall = BLOCKED_RETRY_SOURCE.match(
      /pub fn from_syscall\(syscall: u32\) -> Result<Self, Errno> \{([\s\S]*?)\n    \}/,
    )?.[1];
    expect(fromSyscall, "BlockingRetryOperation::from_syscall").toBeDefined();
    const targetedFamilies = Array.from(
      fromSyscall!.matchAll(/Ok\(Self::([A-Z][A-Za-z0-9]*)\)/g),
      (match) => match[1],
    ).sort();
    expect(Array.from(new Set(targetedFamilies))).toEqual(
      RUST_TARGETED_RETRY_OPERATIONS,
    );
    expect(fromSyscall).toContain("_ => Err(Errno::EINVAL)");
  });

  it("keeps defensive scalar guards beyond the genuine Wasm value boundary", () => {
    // Genuine i32/i64 exports coerce or reject fractional, unsafe, and
    // non-BigInt JavaScript fixture values before these helpers run. Dynamic
    // tests below cover representable values and export traps; this narrow
    // source contract prevents removal of the remaining defense-in-depth.
    const signalTargetValidator = KERNEL_WORKER_SOURCE.match(
      /#validateKernelSignalTargetTid\(targetTid: number\): number \{([\s\S]*?)\n  \}/,
    )?.[1];
    expect(signalTargetValidator, "signal target validator").toBeDefined();
    expect(signalTargetValidator).toContain(
      "!Number.isSafeInteger(targetTid)",
    );
    expect(signalTargetValidator).toContain("targetTid < 0");

    const timeoutValidator = KERNEL_WORKER_SOURCE.match(
      /const rawTimeout = getTimeout\([\s\S]*?return \{\n      \.\.\.cancellationIdentity,\n      retryForbiddenByCallFlags:/,
    )?.[0];
    expect(timeoutValidator, "socket-timeout validator").toBeDefined();
    expect(timeoutValidator).toContain(
      'typeof rawTimeout !== "bigint"',
    );
    expect(timeoutValidator).toContain("rawTimeout < -1n");
    expect(timeoutValidator).toContain(
      "rawTimeout > BigInt(Number.MAX_SAFE_INTEGER)",
    );
  });

  it("keeps caught-handler restart policy on the reviewed syscall allowlist", () => {
    const classifier = CHANNEL_SYSCALL_SOURCE.match(
      /static int kandelo_should_restart_after_handler\([\s\S]*?\n\}\n\n\/\* The kernel ABI/,
    )?.[0];
    expect(
      classifier,
      "kandelo_should_restart_after_handler classifier",
    ).toBeDefined();

    const restartCases = Array.from(
      classifier!.matchAll(/case __NR_([a-z0-9_]+):/g),
      (match) => match[1],
    ).sort();
    expect(restartCases).toEqual([
      "accept",
      "accept4",
      "connect",
      "fcntl",
      "flock",
      "futex",
      "ioctl",
      "mq_timedreceive",
      "mq_timedsend",
      "open",
      "openat",
      "ppoll",
      "pread",
      "preadv",
      "preadv2",
      "pwrite",
      "pwritev",
      "pwritev2",
      "read",
      "readv",
      "recv",
      "recvfrom",
      "recvmsg",
      "send",
      "sendmsg",
      "sendto",
      "wait4",
      "waitid",
      "write",
      "writev",
    ]);

    // WHY: these operations expose EINTR after a caught handler even when the
    // action has SA_RESTART. An accidental broad case would reset a deadline,
    // hide an interrupted readiness wait, or repeat an operation whose partial
    // progress cannot be reconstructed by the host.
    for (const syscall of [
      "poll",
      "select",
      "pselect6",
      "epoll_wait",
      "epoll_pwait",
      "rt_sigtimedwait",
      "sigsuspend",
      "pause",
      "nanosleep",
      "clock_nanosleep",
      "msgrcv",
      "msgsnd",
      "semop",
      "sendfile",
      "copy_file_range",
      "splice",
    ]) {
      expect(classifier).not.toContain(`case __NR_${syscall}:`);
    }

    expect(classifier).toContain("a2 == F_SETLKW");
    expect(classifier).toContain("a2 == F_OFD_SETLKW");
    expect(classifier).toContain("(a2 & LOCK_NB) == 0");
    expect(classifier).toContain("a4 == 0");
    expect(CHANNEL_SYSCALL_SOURCE).toContain(
      "#define KANDELO_FUTEX_WAIT 0",
    );
    expect(CHANNEL_SYSCALL_SOURCE).toContain(
      "#define KANDELO_FUTEX_WAIT_BITSET 9",
    );
    expect(CHANNEL_SYSCALL_SOURCE).toContain(
      "#define KANDELO_FUTEX_CMD_MASK 0x7f",
    );
    expect(classifier).toContain(
      "command == KANDELO_FUTEX_WAIT",
    );
    expect(classifier).toContain(
      "command == KANDELO_FUTEX_WAIT_BITSET",
    );
  });
});

afterEach(() => {
  vi.clearAllTimers();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("blocking retry request snapshots", () => {
  it.each(WIDTHS)(
    "%s retains a scalar write's fd, source range, length, and payload",
    async (_name, pointerWidth) => {
      vi.useFakeTimers();
      const harness = createRetryHarness(pointerWidth);
      const originalSource = 0x1000;
      const replacementSource = 0x2000;
      const originalPayload = [0x11, 0x22, 0x33, 0x44];
      const replacementPayload = [0xaa, 0xbb, 0xcc, 0xdd];
      harness.processBytes.set(originalPayload, originalSource);
      harness.processBytes.set(replacementPayload, replacementSource);
      writeRequest(harness, ABI_SYSCALLS.Write, [
        7n,
        BigInt(originalSource),
        BigInt(originalPayload.length),
      ]);

      const attempts: Array<{
        fd: number;
        length: number;
        payload: number[];
      }> = [];
      harness.kernelExports.kernel_handle_channel = vi.fn(
        (rawPointer: number | bigint) => {
          const view = kernelView(harness, rawPointer);
          const length = Number(kernelArg(view, 2));
          const dataPointer = Number(kernelArg(view, 1));
          attempts.push({
            fd: Number(kernelArg(view, 0)),
            length,
            payload: Array.from(
              harness.kernelBytes.slice(dataPointer, dataPointer + length),
            ),
          });
          if (attempts.length === 1) {
            publishKernelResult(view, -1, EAGAIN);
          } else {
            publishKernelResult(view, length, 0);
          }
          return 0;
        },
      );

      harness.worker.handleSyscall(harness.channel);
      expect(requestStatus(harness)).toBe(CHANNEL_STATUS_PENDING);

      writeRequest(harness, ABI_SYSCALLS.Write, [
        88n,
        BigInt(replacementSource),
        BigInt(replacementPayload.length),
      ]);
      harness.processBytes.fill(
        0xee,
        originalSource,
        originalSource + originalPayload.length,
      );
      await retryAfterDefaultDelay(harness);

      expect(attempts).toEqual([
        {
          fd: 7,
          length: originalPayload.length,
          payload: originalPayload,
        },
        {
          fd: 7,
          length: originalPayload.length,
          payload: originalPayload,
        },
      ]);
      expect(requestResult(harness)).toEqual({
        status: CHANNEL_STATUS_COMPLETE,
        returnValue: originalPayload.length,
        errno: 0,
      });
      expectExactRetryBindingLifecycle(harness, ABI_SYSCALLS.Write);
    },
  );

  it.each(WIDTHS)(
    "%s retains a scalar read's fd and original destination",
    async (_name, pointerWidth) => {
      vi.useFakeTimers();
      const harness = createRetryHarness(pointerWidth);
      const originalDestination = 0x1000;
      const replacementDestination = 0x2000;
      const payload = [0x41, 0x42, 0x43];
      harness.processBytes.fill(
        0x10,
        originalDestination,
        originalDestination + payload.length,
      );
      harness.processBytes.fill(
        0x20,
        replacementDestination,
        replacementDestination + payload.length,
      );
      writeRequest(harness, ABI_SYSCALLS.Read, [
        7n,
        BigInt(originalDestination),
        BigInt(payload.length),
      ]);

      const attempts: Array<{ fd: number; length: number }> = [];
      harness.kernelExports.kernel_handle_channel = vi.fn(
        (rawPointer: number | bigint) => {
          const view = kernelView(harness, rawPointer);
          const length = Number(kernelArg(view, 2));
          attempts.push({
            fd: Number(kernelArg(view, 0)),
            length,
          });
          if (attempts.length === 1) {
            publishKernelResult(view, -1, EAGAIN);
          } else {
            const dataPointer = Number(kernelArg(view, 1));
            harness.kernelBytes.set(payload, dataPointer);
            publishKernelResult(view, payload.length, 0);
          }
          return 0;
        },
      );

      harness.worker.handleSyscall(harness.channel);
      writeRequest(harness, ABI_SYSCALLS.Read, [
        88n,
        BigInt(replacementDestination),
        BigInt(payload.length),
      ]);
      await retryAfterDefaultDelay(harness);

      expect(attempts).toEqual([
        { fd: 7, length: payload.length },
        { fd: 7, length: payload.length },
      ]);
      expect(
        Array.from(
          harness.processBytes.slice(
            originalDestination,
            originalDestination + payload.length,
          ),
        ),
      ).toEqual(payload);
      expect(
        Array.from(
          harness.processBytes.slice(
            replacementDestination,
            replacementDestination + payload.length,
          ),
        ),
      ).toEqual([0x20, 0x20, 0x20]);
      expectExactRetryBindingLifecycle(harness, ABI_SYSCALLS.Read);
    },
  );

  it.each(WIDTHS)(
    "%s returns MSG_DONTWAIT EAGAIN without descriptor-policy queries",
    (_name, pointerWidth) => {
      const harness = createRetryHarness(pointerWidth);
      const destination = 0x1000;
      writeRequest(harness, ABI_SYSCALLS.Recv, [
        7n,
        BigInt(destination),
        1n,
        BigInt(MSG_DONTWAIT),
      ]);
      const isFdNonblock = vi.fn(() => {
        throw new Error("MSG_DONTWAIT must short-circuit O_NONBLOCK");
      });
      const getTimeout = vi.fn(() => {
        throw new Error("MSG_DONTWAIT must short-circuit socket timeout");
      });
      harness.kernelExports.kernel_is_fd_nonblock = isFdNonblock;
      harness.kernelExports.kernel_get_socket_timeout_ms = getTimeout;
      harness.kernelExports.kernel_blocking_retry_token = vi.fn(() => 51n);
      harness.kernelExports.kernel_handle_channel = vi.fn(
        (rawPointer: number | bigint) => {
          publishKernelResult(
            kernelView(harness, rawPointer),
            -1,
            EAGAIN,
          );
          return 0;
        },
      );

      harness.worker.handleSyscall(harness.channel);

      expect(requestResult(harness)).toEqual({
        status: CHANNEL_STATUS_COMPLETE,
        returnValue: -1,
        errno: EAGAIN,
      });
      expect(isFdNonblock).not.toHaveBeenCalled();
      expect(getTimeout).not.toHaveBeenCalled();
      expect(
        harness.kernelExports.kernel_blocking_retry_token,
      ).toHaveBeenCalledWith(
        harness.channel.pid,
        harness.channel.pid,
        ABI_SYSCALLS.Recv,
      );
      expect(
        harness.kernelExports.kernel_blocking_retry_release,
      ).toHaveBeenCalledWith(
        harness.channel.pid,
        harness.channel.pid,
        51n,
      );
      expect(harness.worker.pendingPollRetries.has(harness.channel)).toBe(
        false,
      );
    },
  );

  it.each(WIDTHS)(
    "%s returns O_NONBLOCK EAGAIN without a socket-timeout query",
    (_name, pointerWidth) => {
      const harness = createRetryHarness(pointerWidth);
      const destination = 0x1000;
      writeRequest(harness, ABI_SYSCALLS.Read, [
        7n,
        BigInt(destination),
        1n,
      ]);
      const isFdNonblock = vi.fn(() => 1);
      const getTimeout = vi.fn(() => {
        throw new Error("O_NONBLOCK must short-circuit socket timeout");
      });
      harness.kernelExports.kernel_is_fd_nonblock = isFdNonblock;
      harness.kernelExports.kernel_get_socket_timeout_ms = getTimeout;
      harness.kernelExports.kernel_blocking_retry_token = vi.fn(() => 52n);
      harness.kernelExports.kernel_handle_channel = vi.fn(
        (rawPointer: number | bigint) => {
          publishKernelResult(
            kernelView(harness, rawPointer),
            -1,
            EAGAIN,
          );
          return 0;
        },
      );

      harness.worker.handleSyscall(harness.channel);

      expect(requestResult(harness)).toEqual({
        status: CHANNEL_STATUS_COMPLETE,
        returnValue: -1,
        errno: EAGAIN,
      });
      expect(isFdNonblock).toHaveBeenCalledOnce();
      expect(isFdNonblock).toHaveBeenCalledWith(harness.channel.pid, 7);
      expect(getTimeout).not.toHaveBeenCalled();
      expect(
        harness.kernelExports.kernel_blocking_retry_token,
      ).toHaveBeenCalledWith(
        harness.channel.pid,
        harness.channel.pid,
        ABI_SYSCALLS.Read,
      );
      expect(
        harness.kernelExports.kernel_blocking_retry_release,
      ).toHaveBeenCalledWith(
        harness.channel.pid,
        harness.channel.pid,
        52n,
      );
      expect(harness.worker.pendingPollRetries.has(harness.channel)).toBe(
        false,
      );
    },
  );

  it.each([
    ["wasm32 sendmsg", 4, ABI_SYSCALLS.Sendmsg],
    ["wasm64 sendmsg", 8, ABI_SYSCALLS.Sendmsg],
    ["wasm32 recvmsg", 4, ABI_SYSCALLS.Recvmsg],
    ["wasm64 recvmsg", 8, ABI_SYSCALLS.Recvmsg],
  ] as const)(
    "%s success does not query retry-only descriptor policy",
    (_name, pointerWidth, syscall) => {
      const harness = createRetryHarness(pointerWidth);
      const messagePointer = 0x1000;
      writeNativeMessage(
        harness.processBytes,
        pointerWidth,
        messagePointer,
        0,
        0,
      );
      writeRequest(harness, syscall, [7n, BigInt(messagePointer), 0n]);
      const isFdNonblock = vi.fn(() => {
        throw new Error("success must not query O_NONBLOCK");
      });
      const getTimeout = vi.fn(() => {
        throw new Error("success must not query socket timeout");
      });
      harness.kernelExports.kernel_is_fd_nonblock = isFdNonblock;
      harness.kernelExports.kernel_get_socket_timeout_ms = getTimeout;
      harness.kernelExports.kernel_handle_channel = vi.fn(
        (rawPointer: number | bigint) => {
          publishKernelResult(kernelView(harness, rawPointer), 0, 0);
          return 0;
        },
      );

      harness.worker.handleSyscall(harness.channel);

      expect(requestResult(harness)).toEqual({
        status: CHANNEL_STATUS_COMPLETE,
        returnValue: 0,
        errno: 0,
      });
      expect(isFdNonblock).not.toHaveBeenCalled();
      expect(getTimeout).not.toHaveBeenCalled();
      expect(
        harness.kernelExports.kernel_blocking_retry_token,
      ).not.toHaveBeenCalled();
      expect(
        harness.kernelExports.kernel_blocking_retry_release,
      ).not.toHaveBeenCalled();
    },
  );

  it.each([
    [
      "missing descriptor nonblocking export",
      (harness: RetryHarness) => {
        harness.kernelExports.kernel_is_fd_nonblock = undefined;
      },
      "kernel export kernel_is_fd_nonblock failed",
    ],
    [
      "invalid descriptor nonblocking state",
      (harness: RetryHarness) => {
        harness.kernelExports.kernel_is_fd_nonblock = vi.fn(() => 2);
      },
      "kernel returned invalid nonblocking state 2 for fd 7",
    ],
    [
      "missing socket-timeout export",
      (harness: RetryHarness) => {
        harness.kernelExports.kernel_is_fd_nonblock = vi.fn(() => 0);
        harness.kernelExports.kernel_get_socket_timeout_ms = undefined;
      },
      "kernel export kernel_get_socket_timeout_ms failed",
    ],
    [
      "invalid socket-timeout state",
      (harness: RetryHarness) => {
        harness.kernelExports.kernel_is_fd_nonblock = vi.fn(() => 0);
        harness.kernelExports.kernel_get_socket_timeout_ms = vi.fn(
          () => -2n,
        );
      },
      "kernel returned invalid socket timeout -2",
    ],
    [
      "non-coercible socket-timeout state",
      (harness: RetryHarness) => {
        harness.kernelExports.kernel_is_fd_nonblock = vi.fn(() => 0);
        harness.kernelExports.kernel_get_socket_timeout_ms = vi.fn(
          () => Symbol("not-an-i64"),
        );
      },
      "kernel export kernel_get_socket_timeout_ms failed",
    ],
    [
      "unsafe-integer socket-timeout state",
      (harness: RetryHarness) => {
        harness.kernelExports.kernel_is_fd_nonblock = vi.fn(() => 0);
        harness.kernelExports.kernel_get_socket_timeout_ms = vi.fn(
          () => BigInt(Number.MAX_SAFE_INTEGER) + 1n,
        );
      },
      "kernel returned invalid socket timeout 9007199254740992",
    ],
  ] as const)(
    "fails the kernel generation for %s",
    async (_description, configure, expectedMessage) => {
      const harness = createRetryHarness(4);
      const destination = 0x1000;
      writeRequest(harness, ABI_SYSCALLS.Read, [
        7n,
        BigInt(destination),
        1n,
      ]);
      configure(harness);
      harness.kernelExports.kernel_handle_channel = vi.fn(
        (rawPointer: number | bigint) => {
          publishKernelResult(
            kernelView(harness, rawPointer),
            -1,
            EAGAIN,
          );
          return 0;
        },
      );

      expect(() => harness.worker.handleSyscall(harness.channel)).toThrow(
        expectedMessage,
      );
      await Promise.resolve();

      expect(harness.onKernelFatal).toHaveBeenCalledOnce();
      expect(requestStatus(harness)).toBe(CHANNEL_STATUS_PENDING);
      expect(
        harness.kernelExports.kernel_blocking_retry_token,
      ).not.toHaveBeenCalled();
      expect(
        harness.kernelExports.kernel_blocking_retry_release,
      ).not.toHaveBeenCalled();
      expect(
        harness.worker.blockingRetrySnapshots.has(harness.channel),
      ).toBe(false);
    },
  );

  it.each(WIDTHS)(
    "%s retains a writev request after its mailbox, iovec table, and data change",
    async (_name, pointerWidth) => {
      vi.useFakeTimers();
      const harness = createRetryHarness(pointerWidth);
      const originalTable = 0x1000;
      const replacementTable = 0x1400;
      const originalFirst = 0x2000;
      const originalSecond = 0x2100;
      const replacementData = 0x2200;
      writeNativeIovec(
        harness.processBytes,
        pointerWidth,
        originalTable,
        0,
        originalFirst,
        2,
      );
      writeNativeIovec(
        harness.processBytes,
        pointerWidth,
        originalTable,
        1,
        originalSecond,
        3,
      );
      writeNativeIovec(
        harness.processBytes,
        pointerWidth,
        replacementTable,
        0,
        replacementData,
        4,
      );
      harness.processBytes.set([1, 2], originalFirst);
      harness.processBytes.set([3, 4, 5], originalSecond);
      harness.processBytes.set([9, 9, 9, 9], replacementData);
      writeRequest(harness, ABI_SYSCALLS.Writev, [
        7n,
        BigInt(originalTable),
        2n,
      ]);

      const attempts: Array<{
        syscall: number;
        fd: number;
        payload: number[];
      }> = [];
      harness.kernelExports.kernel_handle_channel = vi.fn(
        (rawPointer: number | bigint) => {
          const view = kernelView(harness, rawPointer);
          const length = Number(kernelArg(view, 2));
          const dataPointer = Number(kernelArg(view, 1));
          attempts.push({
            syscall: view.getUint32(CH_SYSCALL, true),
            fd: Number(kernelArg(view, 0)),
            payload: Array.from(
              harness.kernelBytes.slice(dataPointer, dataPointer + length),
            ),
          });
          if (attempts.length === 1) {
            publishKernelResult(view, -1, EAGAIN);
          } else {
            publishKernelResult(view, length, 0);
          }
          return 0;
        },
      );

      harness.worker.handleSyscall(harness.channel);
      writeRequest(harness, ABI_SYSCALLS.Writev, [
        88n,
        BigInt(replacementTable),
        1n,
      ]);
      writeNativeIovec(
        harness.processBytes,
        pointerWidth,
        originalTable,
        0,
        replacementData,
        4,
      );
      harness.processBytes.fill(0xee, originalFirst, originalFirst + 2);
      harness.processBytes.fill(0xee, originalSecond, originalSecond + 3);
      await retryAfterDefaultDelay(harness);

      expect(attempts).toEqual([
        {
          syscall: ABI_SYSCALLS.Write,
          fd: 7,
          payload: [1, 2, 3, 4, 5],
        },
        {
          syscall: ABI_SYSCALLS.Write,
          fd: 7,
          payload: [1, 2, 3, 4, 5],
        },
      ]);
      expectExactRetryBindingLifecycle(harness, ABI_SYSCALLS.Writev);
    },
  );

  it.each(WIDTHS)(
    "%s retains sendmsg's native header, iovec table, and payload",
    async (_name, pointerWidth) => {
      vi.useFakeTimers();
      const harness = createRetryHarness(pointerWidth);
      const originalMessage = 0x1000;
      const originalTable = 0x1100;
      const replacementMessage = 0x1400;
      const replacementTable = 0x1500;
      const originalPayloadPointer = 0x2000;
      const replacementPayloadPointer = 0x2200;
      const originalPayload = [0x31, 0x32, 0x33, 0x34];
      const replacementPayload = [0x91, 0x92, 0x93];
      writeNativeIovec(
        harness.processBytes,
        pointerWidth,
        originalTable,
        0,
        originalPayloadPointer,
        originalPayload.length,
      );
      writeNativeMessage(
        harness.processBytes,
        pointerWidth,
        originalMessage,
        originalTable,
        1,
      );
      writeNativeIovec(
        harness.processBytes,
        pointerWidth,
        replacementTable,
        0,
        replacementPayloadPointer,
        replacementPayload.length,
      );
      writeNativeMessage(
        harness.processBytes,
        pointerWidth,
        replacementMessage,
        replacementTable,
        1,
      );
      harness.processBytes.set(originalPayload, originalPayloadPointer);
      harness.processBytes.set(replacementPayload, replacementPayloadPointer);
      writeRequest(harness, ABI_SYSCALLS.Sendmsg, [
        7n,
        BigInt(originalMessage),
        0n,
      ]);

      const attempts: Array<{ fd: number; payload: number[] }> = [];
      harness.kernelExports.kernel_handle_channel = vi.fn(
        (rawPointer: number | bigint) => {
          const view = kernelView(harness, rawPointer);
          const messagePointer = Number(kernelArg(view, 1));
          const messageView = new DataView(
            harness.kernelBytes.buffer,
            messagePointer,
          );
          const iovecPointer = messageView.getUint32(
            KERNEL_MSGHDR_WIRE_IOV_OFFSET,
            true,
          );
          const iovecView = new DataView(
            harness.kernelBytes.buffer,
            iovecPointer,
          );
          const dataPointer = iovecView.getUint32(
            KERNEL_IOVEC_WIRE_BASE_OFFSET,
            true,
          );
          const length = iovecView.getUint32(
            KERNEL_IOVEC_WIRE_LEN_OFFSET,
            true,
          );
          attempts.push({
            fd: Number(kernelArg(view, 0)),
            payload: Array.from(
              harness.kernelBytes.slice(dataPointer, dataPointer + length),
            ),
          });
          if (attempts.length === 1) {
            publishKernelResult(view, -1, EAGAIN);
          } else {
            publishKernelResult(view, length, 0);
          }
          return 0;
        },
      );

      harness.worker.handleSyscall(harness.channel);
      writeRequest(harness, ABI_SYSCALLS.Sendmsg, [
        88n,
        BigInt(replacementMessage),
        0n,
      ]);
      writeNativeIovec(
        harness.processBytes,
        pointerWidth,
        originalTable,
        0,
        replacementPayloadPointer,
        replacementPayload.length,
      );
      harness.processBytes.fill(
        0xee,
        originalPayloadPointer,
        originalPayloadPointer + originalPayload.length,
      );
      await retryAfterDefaultDelay(harness);

      expect(attempts).toEqual([
        { fd: 7, payload: originalPayload },
        { fd: 7, payload: originalPayload },
      ]);
      expectExactRetryBindingLifecycle(harness, ABI_SYSCALLS.Sendmsg);
    },
  );

  it.each(WIDTHS)(
    "%s retains recvmsg's native header, iovec table, and destinations",
    async (_name, pointerWidth) => {
      vi.useFakeTimers();
      const harness = createRetryHarness(pointerWidth);
      const originalMessage = 0x1000;
      const originalTable = 0x1100;
      const replacementMessage = 0x1400;
      const replacementTable = 0x1500;
      const originalDestination = 0x2000;
      const replacementDestination = 0x2200;
      const payload = [0x51, 0x52, 0x53, 0x54];
      writeNativeIovec(
        harness.processBytes,
        pointerWidth,
        originalTable,
        0,
        originalDestination,
        payload.length,
      );
      writeNativeMessage(
        harness.processBytes,
        pointerWidth,
        originalMessage,
        originalTable,
        1,
      );
      writeNativeIovec(
        harness.processBytes,
        pointerWidth,
        replacementTable,
        0,
        replacementDestination,
        payload.length,
      );
      writeNativeMessage(
        harness.processBytes,
        pointerWidth,
        replacementMessage,
        replacementTable,
        1,
      );
      harness.processBytes.fill(
        0x10,
        originalDestination,
        originalDestination + payload.length,
      );
      harness.processBytes.fill(
        0x20,
        replacementDestination,
        replacementDestination + payload.length,
      );
      writeRequest(harness, ABI_SYSCALLS.Recvmsg, [
        7n,
        BigInt(originalMessage),
        0n,
      ]);

      let attempts = 0;
      harness.kernelExports.kernel_handle_channel = vi.fn(
        (rawPointer: number | bigint) => {
          attempts++;
          const view = kernelView(harness, rawPointer);
          const messagePointer = Number(kernelArg(view, 1));
          const messageView = new DataView(
            harness.kernelBytes.buffer,
            messagePointer,
          );
          if (attempts === 1) {
            publishKernelResult(view, -1, EAGAIN);
          } else {
            const iovecPointer = messageView.getUint32(
              KERNEL_MSGHDR_WIRE_IOV_OFFSET,
              true,
            );
            const iovecView = new DataView(
              harness.kernelBytes.buffer,
              iovecPointer,
            );
            const dataPointer = iovecView.getUint32(
              KERNEL_IOVEC_WIRE_BASE_OFFSET,
              true,
            );
            harness.kernelBytes.set(payload, dataPointer);
            messageView.setUint32(KERNEL_MSGHDR_WIRE_NAMELEN_OFFSET, 0, true);
            messageView.setUint32(
              KERNEL_MSGHDR_WIRE_CONTROLLEN_OFFSET,
              0,
              true,
            );
            messageView.setUint32(KERNEL_MSGHDR_WIRE_FLAGS_OFFSET, 0x20, true);
            publishKernelResult(view, payload.length, 0);
          }
          return 0;
        },
      );

      harness.worker.handleSyscall(harness.channel);
      writeRequest(harness, ABI_SYSCALLS.Recvmsg, [
        88n,
        BigInt(replacementMessage),
        0n,
      ]);
      writeNativeIovec(
        harness.processBytes,
        pointerWidth,
        originalTable,
        0,
        replacementDestination,
        payload.length,
      );
      await retryAfterDefaultDelay(harness);

      expect(
        Array.from(
          harness.processBytes.slice(
            originalDestination,
            originalDestination + payload.length,
          ),
        ),
      ).toEqual(payload);
      expect(
        Array.from(
          harness.processBytes.slice(
            replacementDestination,
            replacementDestination + payload.length,
          ),
        ),
      ).toEqual([0x20, 0x20, 0x20, 0x20]);
      const layout = nativeMessageLayout(pointerWidth);
      expect(
        new DataView(harness.processBytes.buffer).getUint32(
          originalMessage + layout.flagsOffset,
          true,
        ),
      ).toBe(0x20);
      expect(
        new DataView(harness.processBytes.buffer).getUint32(
          replacementMessage + layout.flagsOffset,
          true,
        ),
      ).toBe(0);
      expectExactRetryBindingLifecycle(harness, ABI_SYSCALLS.Recvmsg);
    },
  );

  it.each(WIDTHS)(
    "%s retains mq_timedsend's descriptor, priority, and message bytes",
    async (_name, pointerWidth) => {
      vi.useFakeTimers();
      const harness = createRetryHarness(pointerWidth);
      const originalMessage = 0x1000;
      const replacementMessage = 0x2000;
      const originalPayload = [0x61, 0x62, 0x63, 0x64];
      const replacementPayload = [0x91, 0x92, 0x93, 0x94];
      harness.processBytes.set(originalPayload, originalMessage);
      harness.processBytes.set(replacementPayload, replacementMessage);
      writeRequest(harness, ABI_SYSCALLS.MqTimedsend, [
        7n,
        BigInt(originalMessage),
        4n,
        3n,
        0n,
      ]);

      const attempts: Array<{
        descriptor: number;
        priority: number;
        payload: number[];
      }> = [];
      harness.kernelExports.kernel_handle_channel = vi.fn(
        (rawPointer: number | bigint) => {
          const view = kernelView(harness, rawPointer);
          const length = Number(kernelArg(view, 2));
          const dataPointer = Number(kernelArg(view, 1));
          attempts.push({
            descriptor: Number(kernelArg(view, 0)),
            priority: Number(kernelArg(view, 3)),
            payload: Array.from(
              harness.kernelBytes.slice(dataPointer, dataPointer + length),
            ),
          });
          if (attempts.length === 1) {
            publishKernelResult(view, -1, EAGAIN);
          } else {
            publishKernelResult(view, 0, 0);
          }
          return 0;
        },
      );

      harness.worker.handleSyscall(harness.channel);
      writeRequest(harness, ABI_SYSCALLS.MqTimedsend, [
        88n,
        BigInt(replacementMessage),
        4n,
        9n,
        0n,
      ]);
      harness.processBytes.fill(
        0xee,
        originalMessage,
        originalMessage + originalPayload.length,
      );
      await retryAfterDefaultDelay(harness);

      expect(attempts).toEqual([
        {
          descriptor: 7,
          priority: 3,
          payload: originalPayload,
        },
        {
          descriptor: 7,
          priority: 3,
          payload: originalPayload,
        },
      ]);
      expectExactRetryBindingLifecycle(harness, ABI_SYSCALLS.MqTimedsend);
    },
  );

  it.each(WIDTHS)(
    "%s retains mq_timedreceive's descriptor and output destinations",
    async (_name, pointerWidth) => {
      vi.useFakeTimers();
      const harness = createRetryHarness(pointerWidth);
      const originalDestination = 0x1000;
      const originalPriority = 0x1100;
      const replacementDestination = 0x2000;
      const replacementPriority = 0x2100;
      const payload = [0x71, 0x72, 0x73, 0x74];
      harness.processBytes.fill(
        0x10,
        originalDestination,
        originalDestination + payload.length,
      );
      harness.processBytes.fill(
        0x20,
        replacementDestination,
        replacementDestination + payload.length,
      );
      writeRequest(harness, ABI_SYSCALLS.MqTimedreceive, [
        7n,
        BigInt(originalDestination),
        4n,
        BigInt(originalPriority),
        0n,
      ]);

      const descriptors: number[] = [];
      harness.kernelExports.kernel_handle_channel = vi.fn(
        (rawPointer: number | bigint) => {
          const view = kernelView(harness, rawPointer);
          descriptors.push(Number(kernelArg(view, 0)));
          if (descriptors.length === 1) {
            publishKernelResult(view, -1, EAGAIN);
          } else {
            harness.kernelBytes.set(payload, Number(kernelArg(view, 1)));
            new DataView(harness.kernelBytes.buffer).setUint32(
              Number(kernelArg(view, 3)),
              17,
              true,
            );
            publishKernelResult(view, payload.length, 0);
          }
          return 0;
        },
      );

      harness.worker.handleSyscall(harness.channel);
      writeRequest(harness, ABI_SYSCALLS.MqTimedreceive, [
        88n,
        BigInt(replacementDestination),
        4n,
        BigInt(replacementPriority),
        0n,
      ]);
      await retryAfterDefaultDelay(harness);

      expect(descriptors).toEqual([7, 7]);
      expect(
        Array.from(
          harness.processBytes.slice(
            originalDestination,
            originalDestination + payload.length,
          ),
        ),
      ).toEqual(payload);
      expect(
        Array.from(
          harness.processBytes.slice(
            replacementDestination,
            replacementDestination + payload.length,
          ),
        ),
      ).toEqual([0x20, 0x20, 0x20, 0x20]);
      const processView = new DataView(harness.processBytes.buffer);
      expect(processView.getUint32(originalPriority, true)).toBe(17);
      expect(processView.getUint32(replacementPriority, true)).toBe(0);
      expectExactRetryBindingLifecycle(
        harness,
        ABI_SYSCALLS.MqTimedreceive,
      );
    },
  );

  it.each(WIDTHS)(
    "%s retains msgsnd's queue, native type, flags, and payload",
    async (_name, pointerWidth) => {
      vi.useFakeTimers();
      const harness = createRetryHarness(pointerWidth);
      const originalMessage = 0x1000;
      const replacementMessage = 0x2000;
      const originalPayload = [0x21, 0x22, 0x23];
      const replacementPayload = [0x81, 0x82, 0x83];
      writeNativeSysvMessage(
        harness.processBytes,
        pointerWidth,
        originalMessage,
        5n,
        originalPayload,
      );
      writeNativeSysvMessage(
        harness.processBytes,
        pointerWidth,
        replacementMessage,
        9n,
        replacementPayload,
      );
      writeRequest(harness, ABI_SYSCALLS.Msgsnd, [
        7n,
        BigInt(originalMessage),
        BigInt(originalPayload.length),
        0n,
      ]);

      const attempts: Array<{
        queue: number;
        type: bigint;
        payload: number[];
      }> = [];
      harness.kernelExports.kernel_handle_channel = vi.fn(
        (rawPointer: number | bigint) => {
          const view = kernelView(harness, rawPointer);
          const dataPointer = Number(kernelArg(view, 1));
          const length = Number(kernelArg(view, 2));
          const dataView = new DataView(
            harness.kernelBytes.buffer,
            dataPointer,
          );
          attempts.push({
            queue: Number(kernelArg(view, 0)),
            type: dataView.getBigInt64(0, true),
            payload: Array.from(
              harness.kernelBytes.slice(
                dataPointer + STRUCT_SIZE_WASM_SYSV_MESSAGE_HEADER,
                dataPointer + STRUCT_SIZE_WASM_SYSV_MESSAGE_HEADER + length,
              ),
            ),
          });
          if (attempts.length === 1) {
            publishKernelResult(view, -1, EAGAIN);
          } else {
            publishKernelResult(view, 0, 0);
          }
          return 0;
        },
      );

      harness.worker.handleSyscall(harness.channel);
      writeRequest(harness, ABI_SYSCALLS.Msgsnd, [
        88n,
        BigInt(replacementMessage),
        BigInt(replacementPayload.length),
        0n,
      ]);
      writeNativeSysvMessage(
        harness.processBytes,
        pointerWidth,
        originalMessage,
        11n,
        [0xee, 0xee, 0xee],
      );
      await retryAfterDefaultDelay(harness);

      expect(attempts).toEqual([
        {
          queue: 7,
          type: 5n,
          payload: originalPayload,
        },
        {
          queue: 7,
          type: 5n,
          payload: originalPayload,
        },
      ]);
      expectExactRetryBindingLifecycle(harness, ABI_SYSCALLS.Msgsnd);
    },
  );

  it.each(WIDTHS)(
    "%s retains msgrcv's queue, type selector, flags, and destination",
    async (_name, pointerWidth) => {
      vi.useFakeTimers();
      const harness = createRetryHarness(pointerWidth);
      const originalDestination = 0x1000;
      const replacementDestination = 0x2000;
      const payload = [0x31, 0x32, 0x33];
      writeNativeSysvMessage(
        harness.processBytes,
        pointerWidth,
        originalDestination,
        0n,
        [0x10, 0x10, 0x10],
      );
      writeNativeSysvMessage(
        harness.processBytes,
        pointerWidth,
        replacementDestination,
        0n,
        [0x20, 0x20, 0x20],
      );
      writeRequest(harness, ABI_SYSCALLS.Msgrcv, [
        7n,
        BigInt(originalDestination),
        BigInt(payload.length),
        5n,
        0n,
      ]);

      const attempts: Array<{
        queue: number;
        typeSelector: bigint;
        flags: number;
      }> = [];
      harness.kernelExports.kernel_handle_channel = vi.fn(
        (rawPointer: number | bigint) => {
          const view = kernelView(harness, rawPointer);
          attempts.push({
            queue: Number(kernelArg(view, 0)),
            typeSelector: kernelArg(view, 3),
            flags: Number(kernelArg(view, 4)),
          });
          if (attempts.length === 1) {
            publishKernelResult(view, -1, EAGAIN);
          } else {
            const dataPointer = Number(kernelArg(view, 1));
            const dataView = new DataView(
              harness.kernelBytes.buffer,
              dataPointer,
            );
            dataView.setBigInt64(0, 9n, true);
            harness.kernelBytes.set(
              payload,
              dataPointer + STRUCT_SIZE_WASM_SYSV_MESSAGE_HEADER,
            );
            publishKernelResult(view, payload.length, 0);
          }
          return 0;
        },
      );

      harness.worker.handleSyscall(harness.channel);
      writeRequest(harness, ABI_SYSCALLS.Msgrcv, [
        88n,
        BigInt(replacementDestination),
        BigInt(payload.length),
        12n,
        0x800n,
      ]);
      await retryAfterDefaultDelay(harness);

      expect(attempts).toEqual([
        { queue: 7, typeSelector: 5n, flags: 0 },
        { queue: 7, typeSelector: 5n, flags: 0 },
      ]);
      expect(
        readNativeSysvMessage(
          harness.processBytes,
          pointerWidth,
          originalDestination,
          payload.length,
        ),
      ).toEqual({
        type: 9n,
        payload,
      });
      expect(
        readNativeSysvMessage(
          harness.processBytes,
          pointerWidth,
          replacementDestination,
          payload.length,
        ),
      ).toEqual({
        type: 0n,
        payload: [0x20, 0x20, 0x20],
      });
      expectExactRetryBindingLifecycle(harness, ABI_SYSCALLS.Msgrcv);
    },
  );

  describe.each([
    ["msgsnd", ABI_SYSCALLS.Msgsnd, [7n, 0x1000n, 3n, 0x800n]],
    [
      "msgrcv",
      ABI_SYSCALLS.Msgrcv,
      [7n, 0x1000n, 3n, 5n, 0x800n],
    ],
  ] as const)("%s IPC_NOWAIT", (_syscallName, syscall, args) => {
    it.each(WIDTHS)(
      "%s publishes EAGAIN only after releasing the exact queue pin",
      (_name, pointerWidth) => {
        const harness = createRetryHarness(pointerWidth);
        writeNativeSysvMessage(
          harness.processBytes,
          pointerWidth,
          0x1000,
          3n,
          [1, 2, 3],
        );
        writeRequest(harness, syscall, args);
        harness.kernelExports.kernel_blocking_retry_token = vi.fn(() => 78n);
        harness.kernelExports.kernel_handle_channel = vi.fn(
          (rawPointer: number | bigint) => {
            publishKernelResult(
              kernelView(harness, rawPointer),
              -1,
              EAGAIN,
            );
            return 0;
          },
        );

        harness.worker.handleSyscall(harness.channel);

        expect(requestResult(harness)).toEqual({
          status: CHANNEL_STATUS_COMPLETE,
          returnValue: -1,
          errno: EAGAIN,
        });
        expect(harness.worker.pendingPollRetries.has(harness.channel)).toBe(
          false,
        );
        expect(
          harness.kernelExports.kernel_blocking_retry_token,
        ).toHaveBeenCalledWith(
          harness.channel.pid,
          harness.channel.pid,
          syscall,
        );
        expect(
          harness.kernelExports.kernel_blocking_retry_release,
        ).toHaveBeenCalledWith(
          harness.channel.pid,
          harness.channel.pid,
          78n,
        );
        expect(
          (
            harness.kernelExports.kernel_handle_channel as ReturnType<
              typeof vi.fn
            >
          ).mock.calls.map((call) => call[3]),
        ).toEqual([0n]);
      },
    );
  });

  it.each(WIDTHS)(
    "%s retains semop's semid and detached sembuf array across ID reuse",
    async (_name, pointerWidth) => {
      vi.useFakeTimers();
      const harness = createRetryHarness(pointerWidth);
      const originalOperations = 0x1000;
      const replacementOperations = 0x1100;
      writeNativeSemop(
        harness.processBytes,
        originalOperations,
        0,
        2,
        -1,
        0,
      );
      writeNativeSemop(
        harness.processBytes,
        replacementOperations,
        0,
        9,
        1,
        IPC_NOWAIT,
      );
      writeRequest(harness, ABI_SYSCALLS.Semop, [
        7n,
        BigInt(originalOperations),
        1n,
      ]);
      harness.kernelExports.kernel_blocking_retry_token = vi.fn(() => 77n);

      const attempts: Array<{
        semid: number;
        number: number;
        operation: number;
        flags: number;
      }> = [];
      harness.kernelExports.kernel_handle_channel = vi.fn(
        (rawPointer: number | bigint) => {
          const view = kernelView(harness, rawPointer);
          const operations = Number(kernelArg(view, 1));
          const operationView = new DataView(
            harness.kernelBytes.buffer,
            operations,
            6,
          );
          attempts.push({
            semid: Number(kernelArg(view, 0)),
            number: operationView.getUint16(0, true),
            operation: operationView.getInt16(2, true),
            flags: operationView.getUint16(4, true),
          });
          publishKernelResult(
            view,
            attempts.length === 1 ? -1 : 0,
            attempts.length === 1 ? EAGAIN : 0,
          );
          return 0;
        },
      );

      harness.worker.handleSyscall(harness.channel);
      // Model IPC_RMID plus reuse of numeric semid 7: the mailbox and both
      // guest arrays now describe a different logical operation. Only the
      // detached plan plus Rust's exact retry token may survive this point.
      writeRequest(harness, ABI_SYSCALLS.Semop, [
        7n,
        BigInt(replacementOperations),
        1n,
      ]);
      writeNativeSemop(
        harness.processBytes,
        originalOperations,
        0,
        12,
        3,
        IPC_NOWAIT,
      );
      await retryAfterDefaultDelay(harness);

      expect(attempts).toEqual([
        { semid: 7, number: 2, operation: -1, flags: 0 },
        { semid: 7, number: 2, operation: -1, flags: 0 },
      ]);
      expect(requestResult(harness)).toEqual({
        status: CHANNEL_STATUS_COMPLETE,
        returnValue: 0,
        errno: 0,
      });
      expectExactRetryBindingLifecycle(
        harness,
        ABI_SYSCALLS.Semop,
        77n,
      );
    },
  );

  it.each(WIDTHS)(
    "%s preserves valid zero-operation semop without inventing policy bytes",
    (_name, pointerWidth) => {
      const harness = createRetryHarness(pointerWidth);
      writeRequest(harness, ABI_SYSCALLS.Semop, [7n, 0n, 0n]);
      harness.kernelExports.kernel_handle_channel = vi.fn(
        (rawPointer: number | bigint) => {
          const view = kernelView(harness, rawPointer);
          expect(Number(kernelArg(view, 0))).toBe(7);
          expect(Number(kernelArg(view, 2))).toBe(0);
          publishKernelResult(view, 0, 0);
          return 0;
        },
      );

      harness.worker.handleSyscall(harness.channel);

      expect(requestResult(harness)).toEqual({
        status: CHANNEL_STATUS_COMPLETE,
        returnValue: 0,
        errno: 0,
      });
      expect(
        harness.kernelExports.kernel_blocking_retry_token,
      ).not.toHaveBeenCalled();
    },
  );

  it.each(WIDTHS)(
    "%s returns semop IPC_NOWAIT EAGAIN and releases its exact target pin",
    (_name, pointerWidth) => {
      const harness = createRetryHarness(pointerWidth);
      const operations = 0x1000;
      writeNativeSemop(
        harness.processBytes,
        operations,
        0,
        2,
        -1,
        IPC_NOWAIT,
      );
      writeRequest(harness, ABI_SYSCALLS.Semop, [
        7n,
        BigInt(operations),
        1n,
      ]);
      harness.kernelExports.kernel_blocking_retry_token = vi.fn(() => 88n);
      harness.kernelExports.kernel_handle_channel = vi.fn(
        (rawPointer: number | bigint) => {
          publishKernelResult(
            kernelView(harness, rawPointer),
            -1,
            EAGAIN,
          );
          return 0;
        },
      );

      harness.worker.handleSyscall(harness.channel);

      expect(requestResult(harness)).toEqual({
        status: CHANNEL_STATUS_COMPLETE,
        returnValue: -1,
        errno: EAGAIN,
      });
      expect(harness.worker.pendingPollRetries.has(harness.channel)).toBe(
        false,
      );
      const token = harness.kernelExports
        .kernel_blocking_retry_token as ReturnType<typeof vi.fn>;
      const release = harness.kernelExports
        .kernel_blocking_retry_release as ReturnType<typeof vi.fn>;
      expect(token).toHaveBeenCalledWith(
        harness.channel.pid,
        harness.channel.pid,
        ABI_SYSCALLS.Semop,
      );
      expect(release).toHaveBeenCalledWith(
        harness.channel.pid,
        harness.channel.pid,
        88n,
      );
      expect(
        (
          harness.kernelExports.kernel_handle_channel as ReturnType<
            typeof vi.fn
          >
        ).mock.calls.map((call) => call[3]),
      ).toEqual([0n]);
    },
  );

  it.each(WIDTHS)(
    "%s returns splice SPLICE_F_NONBLOCK EAGAIN and releases both targets",
    (_name, pointerWidth) => {
      const harness = createRetryHarness(pointerWidth);
      writeRequest(harness, ABI_SYSCALLS.Splice, [
        7n,
        0n,
        8n,
        0n,
        4n,
        0x02n,
      ]);
      harness.kernelExports.kernel_blocking_retry_token = vi.fn(() => 89n);
      harness.kernelExports.kernel_handle_channel = vi.fn(
        (rawPointer: number | bigint) => {
          publishKernelResult(
            kernelView(harness, rawPointer),
            -1,
            EAGAIN,
          );
          return 0;
        },
      );

      harness.worker.handleSyscall(harness.channel);

      expect(requestResult(harness)).toEqual({
        status: CHANNEL_STATUS_COMPLETE,
        returnValue: -1,
        errno: EAGAIN,
      });
      expect(harness.worker.pendingPollRetries.has(harness.channel)).toBe(
        false,
      );
      expect(
        harness.kernelExports.kernel_blocking_retry_token,
      ).toHaveBeenCalledWith(
        harness.channel.pid,
        harness.channel.pid,
        ABI_SYSCALLS.Splice,
      );
      expect(
        harness.kernelExports.kernel_blocking_retry_release,
      ).toHaveBeenCalledWith(
        harness.channel.pid,
        harness.channel.pid,
        89n,
      );
      expect(
        (
          harness.kernelExports.kernel_handle_channel as ReturnType<
            typeof vi.fn
          >
        ).mock.calls.map((call) => call[3]),
      ).toEqual([0n]);
    },
  );

  it.each(WIDTHS)(
    "%s returns sendfile input O_NONBLOCK EAGAIN without parking",
    (_name, pointerWidth) => {
      const harness = createRetryHarness(pointerWidth);
      writeRequest(harness, ABI_SYSCALLS.Sendfile, [
        7n,
        8n,
        0n,
        4n,
      ]);
      harness.kernelExports.kernel_blocking_retry_token = vi.fn(() => 90n);
      const isFdNonblock = vi.fn(
        (_pid: number, fd: number) => fd === 8 ? 1 : 0,
      );
      const getTimeout = vi.fn(() => {
        throw new Error("O_NONBLOCK input must short-circuit socket timeout");
      });
      harness.kernelExports.kernel_is_fd_nonblock = isFdNonblock;
      harness.kernelExports.kernel_get_socket_timeout_ms = getTimeout;
      harness.kernelExports.kernel_handle_channel = vi.fn(
        (rawPointer: number | bigint) => {
          publishKernelResult(
            kernelView(harness, rawPointer),
            -1,
            EAGAIN,
          );
          return 0;
        },
      );

      harness.worker.handleSyscall(harness.channel);

      expect(requestResult(harness)).toEqual({
        status: CHANNEL_STATUS_COMPLETE,
        returnValue: -1,
        errno: EAGAIN,
      });
      expect(isFdNonblock.mock.calls).toEqual([
        [harness.channel.pid, 7],
        [harness.channel.pid, 8],
      ]);
      expect(getTimeout).not.toHaveBeenCalled();
      expect(harness.worker.pendingPollRetries.has(harness.channel)).toBe(
        false,
      );
      expect(
        harness.kernelExports.kernel_blocking_retry_token,
      ).toHaveBeenCalledWith(
        harness.channel.pid,
        harness.channel.pid,
        ABI_SYSCALLS.Sendfile,
      );
      expect(
        harness.kernelExports.kernel_blocking_retry_release,
      ).toHaveBeenCalledWith(
        harness.channel.pid,
        harness.channel.pid,
        90n,
      );
      expect(
        (
          harness.kernelExports.kernel_handle_channel as ReturnType<
            typeof vi.fn
          >
        ).mock.calls.map((call) => call[3]),
      ).toEqual([0n]);
    },
  );

  it.each(WIDTHS)(
    "%s parks sendfile only after both endpoints prove blocking",
    async (_name, pointerWidth) => {
      vi.useFakeTimers();
      const harness = createRetryHarness(pointerWidth);
      writeRequest(harness, ABI_SYSCALLS.Sendfile, [
        7n,
        8n,
        0n,
        4n,
      ]);
      harness.kernelExports.kernel_blocking_retry_token = vi.fn(() => 91n);
      const isFdNonblock = vi.fn(() => 0);
      const getTimeout = vi.fn(() => 0n);
      harness.kernelExports.kernel_is_fd_nonblock = isFdNonblock;
      harness.kernelExports.kernel_get_socket_timeout_ms = getTimeout;
      let attempts = 0;
      harness.kernelExports.kernel_handle_channel = vi.fn(
        (rawPointer: number | bigint) => {
          attempts++;
          publishKernelResult(
            kernelView(harness, rawPointer),
            attempts === 1 ? -1 : 4,
            attempts === 1 ? EAGAIN : 0,
          );
          return 0;
        },
      );

      harness.worker.handleSyscall(harness.channel);

      expect(requestStatus(harness)).toBe(CHANNEL_STATUS_PENDING);
      expect(isFdNonblock.mock.calls).toEqual([
        [harness.channel.pid, 7],
        [harness.channel.pid, 8],
      ]);
      expect(getTimeout).toHaveBeenCalledOnce();
      expect(getTimeout).toHaveBeenCalledWith(
        harness.channel.pid,
        7,
        0,
      );

      await retryAfterDefaultDelay(harness);

      expect(requestResult(harness)).toEqual({
        status: CHANNEL_STATUS_COMPLETE,
        returnValue: 4,
        errno: 0,
      });
      expect(isFdNonblock.mock.calls).toEqual([
        [harness.channel.pid, 7],
        [harness.channel.pid, 8],
      ]);
      expect(getTimeout).toHaveBeenCalledOnce();
      expectExactRetryBindingLifecycle(
        harness,
        ABI_SYSCALLS.Sendfile,
        91n,
      );
    },
  );

  it.each(WIDTHS)(
    "%s retains sendfile's two fds and offset bytes across numeric fd reuse",
    async (_name, pointerWidth) => {
      vi.useFakeTimers();
      const harness = createRetryHarness(pointerWidth);
      const originalOffset = 0x1000;
      const replacementOffset = 0x1100;
      writeNativeOffset(harness.processBytes, originalOffset, 123n);
      writeNativeOffset(harness.processBytes, replacementOffset, 999n);
      writeRequest(harness, ABI_SYSCALLS.Sendfile, [
        7n,
        8n,
        BigInt(originalOffset),
        4n,
      ]);
      harness.kernelExports.kernel_blocking_retry_token = vi.fn(() => 31n);

      let numericFdsWereReused = false;
      const attempts: Array<{
        outputFd: number;
        inputFd: number;
        offset: bigint;
        count: number;
        target: string;
      }> = [];
      harness.kernelExports.kernel_handle_channel = vi.fn(
        (
          rawPointer: number | bigint,
          _capacity: number,
          _pid: number,
          retryToken: bigint,
        ) => {
          const view = kernelView(harness, rawPointer);
          const offsetPointer = Number(kernelArg(view, 2));
          attempts.push({
            outputFd: Number(kernelArg(view, 0)),
            inputFd: Number(kernelArg(view, 1)),
            offset: new DataView(
              harness.kernelBytes.buffer,
              offsetPointer,
              8,
            ).getBigInt64(0, true),
            count: Number(kernelArg(view, 3)),
            target: numericFdsWereReused
              ? retryToken === 31n
                ? "original-pinned"
                : "reused-numeric"
              : "original-lookup",
          });
          if (attempts.length === 1) {
            publishKernelResult(view, -1, EAGAIN);
          } else {
            new DataView(
              harness.kernelBytes.buffer,
              offsetPointer,
              8,
            ).setBigInt64(0, 127n, true);
            publishKernelResult(view, 4, 0);
          }
          return 0;
        },
      );

      harness.worker.handleSyscall(harness.channel);
      numericFdsWereReused = true;
      writeRequest(harness, ABI_SYSCALLS.Sendfile, [
        7n,
        8n,
        BigInt(replacementOffset),
        99n,
      ]);
      writeNativeOffset(harness.processBytes, originalOffset, 555n);
      await retryAfterDefaultDelay(harness);

      expect(attempts).toEqual([
        {
          outputFd: 7,
          inputFd: 8,
          offset: 123n,
          count: 4,
          target: "original-lookup",
        },
        {
          outputFd: 7,
          inputFd: 8,
          offset: 123n,
          count: 4,
          target: "original-pinned",
        },
      ]);
      expect(readNativeOffset(harness.processBytes, originalOffset)).toBe(
        127n,
      );
      expect(readNativeOffset(harness.processBytes, replacementOffset)).toBe(
        999n,
      );
      expectExactRetryBindingLifecycle(
        harness,
        ABI_SYSCALLS.Sendfile,
        31n,
      );
    },
  );

  describe.each([
    ["copy_file_range", ABI_SYSCALLS.CopyFileRange],
    ["splice", ABI_SYSCALLS.Splice],
  ] as const)("%s retry snapshot", (_syscallName, syscall) => {
    it.each(WIDTHS)(
      "%s retains both fds, both offsets, count, and flags across fd reuse",
      async (_name, pointerWidth) => {
        vi.useFakeTimers();
        const harness = createRetryHarness(pointerWidth);
        const originalInputOffset = 0x1000;
        const originalOutputOffset = 0x1010;
        const replacementInputOffset = 0x1100;
        const replacementOutputOffset = 0x1110;
        writeNativeOffset(harness.processBytes, originalInputOffset, 100n);
        writeNativeOffset(harness.processBytes, originalOutputOffset, 200n);
        writeNativeOffset(harness.processBytes, replacementInputOffset, 900n);
        writeNativeOffset(harness.processBytes, replacementOutputOffset, 950n);
        writeRequest(harness, syscall, [
          7n,
          BigInt(originalInputOffset),
          8n,
          BigInt(originalOutputOffset),
          4n,
          0x20n,
        ]);
        harness.kernelExports.kernel_blocking_retry_token = vi.fn(() => 32n);

        let numericFdsWereReused = false;
        const attempts: Array<{
          inputFd: number;
          inputOffset: bigint;
          outputFd: number;
          outputOffset: bigint;
          count: number;
          flags: number;
          target: string;
        }> = [];
        harness.kernelExports.kernel_handle_channel = vi.fn(
          (
            rawPointer: number | bigint,
            _capacity: number,
            _pid: number,
            retryToken: bigint,
          ) => {
            const view = kernelView(harness, rawPointer);
            const inputOffsetPointer = Number(kernelArg(view, 1));
            const outputOffsetPointer = Number(kernelArg(view, 3));
            attempts.push({
              inputFd: Number(kernelArg(view, 0)),
              inputOffset: new DataView(
                harness.kernelBytes.buffer,
                inputOffsetPointer,
                8,
              ).getBigInt64(0, true),
              outputFd: Number(kernelArg(view, 2)),
              outputOffset: new DataView(
                harness.kernelBytes.buffer,
                outputOffsetPointer,
                8,
              ).getBigInt64(0, true),
              count: Number(kernelArg(view, 4)),
              flags: Number(kernelArg(view, 5)),
              target: numericFdsWereReused
                ? retryToken === 32n
                  ? "original-pinned"
                  : "reused-numeric"
                : "original-lookup",
            });
            if (attempts.length === 1) {
              publishKernelResult(view, -1, EAGAIN);
            } else {
              const kernelViewBytes = new DataView(
                harness.kernelBytes.buffer,
              );
              kernelViewBytes.setBigInt64(
                inputOffsetPointer,
                104n,
                true,
              );
              kernelViewBytes.setBigInt64(
                outputOffsetPointer,
                204n,
                true,
              );
              publishKernelResult(view, 4, 0);
            }
            return 0;
          },
        );

        harness.worker.handleSyscall(harness.channel);
        numericFdsWereReused = true;
        writeRequest(harness, syscall, [
          7n,
          BigInt(replacementInputOffset),
          8n,
          BigInt(replacementOutputOffset),
          99n,
          0x40n,
        ]);
        writeNativeOffset(harness.processBytes, originalInputOffset, 500n);
        writeNativeOffset(harness.processBytes, originalOutputOffset, 600n);
        await retryAfterDefaultDelay(harness);

        expect(attempts).toEqual([
          {
            inputFd: 7,
            inputOffset: 100n,
            outputFd: 8,
            outputOffset: 200n,
            count: 4,
            flags: 0x20,
            target: "original-lookup",
          },
          {
            inputFd: 7,
            inputOffset: 100n,
            outputFd: 8,
            outputOffset: 200n,
            count: 4,
            flags: 0x20,
            target: "original-pinned",
          },
        ]);
        expect(
          readNativeOffset(harness.processBytes, originalInputOffset),
        ).toBe(104n);
        expect(
          readNativeOffset(harness.processBytes, originalOutputOffset),
        ).toBe(204n);
        expect(
          readNativeOffset(harness.processBytes, replacementInputOffset),
        ).toBe(900n);
        expect(
          readNativeOffset(harness.processBytes, replacementOutputOffset),
        ).toBe(950n);
        expectExactRetryBindingLifecycle(harness, syscall, 32n);
      },
    );
  });

  it.each(WIDTHS)(
    "%s accepts ESRCH token loss only after authoritative Exited state",
    async (_name, pointerWidth) => {
      const harness = createRetryHarness(pointerWidth);
      const source = 0x1000;
      harness.processBytes.set([1, 2, 3], source);
      writeRequest(harness, ABI_SYSCALLS.Write, [
        7n,
        BigInt(source),
        3n,
      ]);
      harness.kernelExports.kernel_blocking_retry_token = vi.fn(
        () => -BigInt(ESRCH),
      );
      harness.kernelExports.kernel_get_process_state = vi.fn(
        () => PROCESS_STATE_EXITED,
      );
      harness.kernelExports.kernel_handle_channel = vi.fn(
        (rawPointer: number | bigint) => {
          publishKernelResult(
            kernelView(harness, rawPointer),
            -1,
            EAGAIN,
          );
          return 0;
        },
      );

      harness.worker.handleSyscall(harness.channel);
      await Promise.resolve();

      expect(harness.onKernelFatal).not.toHaveBeenCalled();
      expect(requestStatus(harness)).toBe(CHANNEL_STATUS_PENDING);
      expect(harness.worker.pendingPollRetries.has(harness.channel)).toBe(
        false,
      );
      expect(
        harness.worker.blockingRetrySnapshots.has(harness.channel),
      ).toBe(false);
      expect(
        harness.kernelExports.kernel_get_process_state,
      ).toHaveBeenCalledWith(harness.channel.pid);
      expect(
        harness.kernelExports.kernel_blocking_retry_release,
      ).not.toHaveBeenCalled();
    },
  );

  it.each(WIDTHS)(
    "%s treats ESRCH token loss for a live process as generation-fatal",
    async (_name, pointerWidth) => {
      const harness = createRetryHarness(pointerWidth);
      const source = 0x1000;
      harness.processBytes.set([1, 2, 3], source);
      writeRequest(harness, ABI_SYSCALLS.Write, [
        7n,
        BigInt(source),
        3n,
      ]);
      harness.kernelExports.kernel_blocking_retry_token = vi.fn(
        () => -BigInt(ESRCH),
      );
      harness.kernelExports.kernel_get_process_state = vi.fn(() => 0);
      harness.kernelExports.kernel_handle_channel = vi.fn(
        (rawPointer: number | bigint) => {
          publishKernelResult(
            kernelView(harness, rawPointer),
            -1,
            EAGAIN,
          );
          return 0;
        },
      );

      expect(() => harness.worker.handleSyscall(harness.channel)).toThrow(
        "invalid blocking-retry token",
      );
      await Promise.resolve();

      expect(harness.onKernelFatal).toHaveBeenCalledOnce();
      expect(requestStatus(harness)).toBe(CHANNEL_STATUS_PENDING);
      expect(harness.worker.pendingPollRetries.has(harness.channel)).toBe(
        false,
      );
      expect(
        harness.kernelExports.kernel_blocking_retry_release,
      ).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["missing implementation", "missing"],
    ["throwing implementation", "throw"],
  ] as const)(
    "treats a %s from blocking-retry token query as generation-fatal",
    async (_description, mode) => {
      const harness = createRetryHarness(4);
      const source = 0x1000;
      harness.processBytes.set([1], source);
      writeRequest(harness, ABI_SYSCALLS.Write, [7n, BigInt(source), 1n]);
      if (mode === "missing") {
        harness.kernelExports.kernel_blocking_retry_token = undefined;
      } else {
        harness.kernelExports.kernel_blocking_retry_token = vi.fn(() => {
          throw new Error("token query trap");
        });
      }
      harness.kernelExports.kernel_handle_channel = vi.fn(
        (rawPointer: number | bigint) => {
          publishKernelResult(
            kernelView(harness, rawPointer),
            -1,
            EAGAIN,
          );
          return 0;
        },
      );

      expect(() => harness.worker.handleSyscall(harness.channel)).toThrow();
      await Promise.resolve();

      expect(harness.onKernelFatal).toHaveBeenCalledOnce();
      expect(requestStatus(harness)).toBe(CHANNEL_STATUS_PENDING);
      expect(harness.worker.pendingPollRetries.has(harness.channel)).toBe(
        false,
      );
      expect(
        harness.kernelExports.kernel_blocking_retry_release,
      ).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["missing implementation", "missing"],
    ["throwing implementation", "throw"],
    ["nonzero result", "nonzero"],
  ] as const)(
    "treats a %s from exact blocking-retry release as generation-fatal",
    async (_description, mode) => {
      vi.useFakeTimers();
      const harness = createRetryHarness(4);
      const source = 0x1000;
      harness.processBytes.set([1], source);
      writeRequest(harness, ABI_SYSCALLS.Write, [7n, BigInt(source), 1n]);
      harness.kernelExports.kernel_blocking_retry_token = vi.fn(() => 91n);
      let attempts = 0;
      harness.kernelExports.kernel_handle_channel = vi.fn(
        (rawPointer: number | bigint) => {
          attempts++;
          publishKernelResult(
            kernelView(harness, rawPointer),
            attempts === 1 ? -1 : 1,
            attempts === 1 ? EAGAIN : 0,
          );
          return 0;
        },
      );

      harness.worker.handleSyscall(harness.channel);
      if (mode === "missing") {
        harness.kernelExports.kernel_blocking_retry_release = undefined;
      } else if (mode === "throw") {
        harness.kernelExports.kernel_blocking_retry_release = vi.fn(() => {
          throw new Error("release trap");
        });
      } else {
        harness.kernelExports.kernel_blocking_retry_release = vi.fn(
          () => -1,
        );
      }
      await expect(retryAfterDefaultDelay(harness)).rejects.toThrow();
      await Promise.resolve();

      expect(attempts).toBe(2);
      expect(harness.onKernelFatal).toHaveBeenCalledOnce();
      // Release precedes all guest publication. A failed ownership handoff
      // must leave this generation parked, never report the successful retry.
      expect(requestStatus(harness)).toBe(CHANNEL_STATUS_PENDING);
      expect(harness.worker.pendingPollRetries.has(harness.channel)).toBe(
        false,
      );
    },
  );

  it.each(WIDTHS)(
    "%s releases a retry token when its exact channel is retired",
    (_name, pointerWidth) => {
      vi.useFakeTimers();
      const harness = createRetryHarness(pointerWidth);
      const source = 0x1000;
      harness.processBytes.set([1], source);
      writeRequest(harness, ABI_SYSCALLS.Write, [7n, BigInt(source), 1n]);
      harness.kernelExports.kernel_blocking_retry_token = vi.fn(() => 92n);
      harness.kernelExports.kernel_handle_channel = vi.fn(
        (rawPointer: number | bigint) => {
          publishKernelResult(
            kernelView(harness, rawPointer),
            -1,
            EAGAIN,
          );
          return 0;
        },
      );

      harness.worker.handleSyscall(harness.channel);
      harness.worker.removeChannel(
        harness.channel.pid,
        harness.channel.channelOffset,
      );

      expect(
        harness.kernelExports.kernel_blocking_retry_release,
      ).toHaveBeenCalledWith(
        harness.channel.pid,
        harness.channel.pid,
        92n,
      );
      expect(harness.worker.pendingPollRetries.has(harness.channel)).toBe(
        false,
      );
      expect(
        harness.worker.blockingRetrySnapshots.has(harness.channel),
      ).toBe(false);
      expect(requestStatus(harness)).toBe(CHANNEL_STATUS_PENDING);
    },
  );

  it.each(WIDTHS)(
    "%s releases retry authority before teardown publishes EINTR",
    async (_name, pointerWidth) => {
      vi.useFakeTimers();
      const harness = createRetryHarness(pointerWidth);
      const source = 0x1000;
      harness.processBytes.set([1], source);
      writeRequest(harness, ABI_SYSCALLS.Write, [7n, BigInt(source), 1n]);
      harness.kernelExports.kernel_blocking_retry_token = vi.fn(() => 93n);
      harness.kernelExports.kernel_handle_channel = vi.fn(
        (rawPointer: number | bigint) => {
          publishKernelResult(
            kernelView(harness, rawPointer),
            -1,
            EAGAIN,
          );
          return 0;
        },
      );

      harness.worker.handleSyscall(harness.channel);
      const woken = await harness.worker.killAllBlockedForTeardown();

      expect(woken).toEqual(new Set([harness.channel.pid]));
      expect(
        harness.kernelExports.kernel_blocking_retry_release,
      ).toHaveBeenCalledWith(
        harness.channel.pid,
        harness.channel.pid,
        93n,
      );
      expect(requestResult(harness)).toEqual({
        status: CHANNEL_STATUS_COMPLETE,
        returnValue: -1,
        errno: 4,
      });
    },
  );

  it.each(WIDTHS)(
    "%s reacquires process memory after memory.grow before retry copyback",
    async (_name, pointerWidth) => {
      vi.useFakeTimers();
      const harness = createRetryHarness(pointerWidth, {
        maximumProcessPages: 9,
      });
      const destination = 0x1000;
      const payload = [0x41, 0x42, 0x43];
      writeRequest(harness, ABI_SYSCALLS.Read, [
        7n,
        BigInt(destination),
        BigInt(payload.length),
      ]);
      let attempts = 0;
      harness.kernelExports.kernel_handle_channel = vi.fn(
        (rawPointer: number | bigint) => {
          attempts++;
          const view = kernelView(harness, rawPointer);
          if (attempts === 1) {
            publishKernelResult(view, -1, EAGAIN);
          } else {
            harness.kernelBytes.set(
              payload,
              Number(kernelArg(view, 1)),
            );
            publishKernelResult(view, payload.length, 0);
          }
          return 0;
        },
      );

      harness.worker.handleSyscall(harness.channel);
      harness.processMemory.grow(1);
      await retryAfterDefaultDelay(harness);

      expect(
        Array.from(
          new Uint8Array(harness.processMemory.buffer).slice(
            destination,
            destination + payload.length,
          ),
        ),
      ).toEqual(payload);
      expectExactRetryBindingLifecycle(harness, ABI_SYSCALLS.Read);
    },
  );

  it.each(WIDTHS)(
    "%s releases and replaces tokens across sequential requests on one channel",
    async (_name, pointerWidth) => {
      vi.useFakeTimers();
      const harness = createRetryHarness(pointerWidth);
      const firstSource = 0x1000;
      const secondSource = 0x1100;
      harness.processBytes.set([1], firstSource);
      harness.processBytes.set([2], secondSource);
      const tokenForRetry = vi.fn()
        .mockReturnValueOnce(101n)
        .mockReturnValueOnce(102n);
      harness.kernelExports.kernel_blocking_retry_token = tokenForRetry;
      const attemptsByFd = new Map<number, number>();
      harness.kernelExports.kernel_handle_channel = vi.fn(
        (rawPointer: number | bigint) => {
          const view = kernelView(harness, rawPointer);
          const fd = Number(kernelArg(view, 0));
          const count = (attemptsByFd.get(fd) ?? 0) + 1;
          attemptsByFd.set(fd, count);
          publishKernelResult(
            view,
            count === 1 ? -1 : 1,
            count === 1 ? EAGAIN : 0,
          );
          return 0;
        },
      );

      writeRequest(harness, ABI_SYSCALLS.Write, [
        7n,
        BigInt(firstSource),
        1n,
      ]);
      harness.worker.handleSyscall(harness.channel);
      await retryAfterDefaultDelay(harness);
      writeRequest(harness, ABI_SYSCALLS.Write, [
        8n,
        BigInt(secondSource),
        1n,
      ]);
      harness.worker.handleSyscall(harness.channel);
      await retryAfterDefaultDelay(harness);

      expect(requestResult(harness)).toEqual({
        status: CHANNEL_STATUS_COMPLETE,
        returnValue: 1,
        errno: 0,
      });
      expect(tokenForRetry.mock.calls).toEqual([
        [
          harness.channel.pid,
          harness.channel.pid,
          ABI_SYSCALLS.Write,
        ],
        [
          harness.channel.pid,
          harness.channel.pid,
          ABI_SYSCALLS.Write,
        ],
      ]);
      expect(
        (
          harness.kernelExports.kernel_blocking_retry_release as ReturnType<
            typeof vi.fn
          >
        ).mock.calls,
      ).toEqual([
        [harness.channel.pid, harness.channel.pid, 101n],
        [harness.channel.pid, harness.channel.pid, 102n],
      ]);
    },
  );

  it.each(WIDTHS)(
    "%s keeps interleaved channel generations and tokens disjoint",
    async (_name, pointerWidth) => {
      vi.useFakeTimers();
      const harness = createRetryHarness(pointerWidth, {
        channelOffsets: [6 * 65_536, 4 * 65_536],
      });
      const [first, second] = harness.channels;
      harness.worker.channelTids.set(
        `${first.pid}:${first.channelOffset}`,
        41,
      );
      harness.worker.channelTids.set(
        `${second.pid}:${second.channelOffset}`,
        42,
      );
      const firstSource = 0x1000;
      const secondSource = 0x1100;
      harness.processBytes.set([1], firstSource);
      harness.processBytes.set([2], secondSource);
      writeRequest(
        harness,
        ABI_SYSCALLS.Write,
        [7n, BigInt(firstSource), 1n],
        first,
      );
      writeRequest(
        harness,
        ABI_SYSCALLS.Write,
        [8n, BigInt(secondSource), 1n],
        second,
      );
      harness.kernelExports.kernel_blocking_retry_token = vi.fn(
        (_pid: number, tid: number) => tid === 41 ? 111n : 112n,
      );
      const attemptsByFd = new Map<number, number>();
      harness.kernelExports.kernel_handle_channel = vi.fn(
        (rawPointer: number | bigint) => {
          const view = kernelView(harness, rawPointer);
          const fd = Number(kernelArg(view, 0));
          const count = (attemptsByFd.get(fd) ?? 0) + 1;
          attemptsByFd.set(fd, count);
          publishKernelResult(
            view,
            count === 1 ? -1 : 1,
            count === 1 ? EAGAIN : 0,
          );
          return 0;
        },
      );

      harness.worker.handleSyscall(first);
      harness.worker.handleSyscall(second);
      expect(harness.worker.pendingPollRetries.has(first)).toBe(true);
      expect(harness.worker.pendingPollRetries.has(second)).toBe(true);
      await vi.advanceTimersByTimeAsync(10);
      await Promise.resolve();

      expect(requestResult(harness, first)).toEqual({
        status: CHANNEL_STATUS_COMPLETE,
        returnValue: 1,
        errno: 0,
      });
      expect(requestResult(harness, second)).toEqual({
        status: CHANNEL_STATUS_COMPLETE,
        returnValue: 1,
        errno: 0,
      });
      expect(
        (
          harness.kernelExports.kernel_blocking_retry_release as ReturnType<
            typeof vi.fn
          >
        ).mock.calls,
      ).toEqual(
        expect.arrayContaining([
          [first.pid, 41, 111n],
          [second.pid, 42, 112n],
        ]),
      );
    },
  );

  it.each(WIDTHS)(
    "%s forgets an old-image retry only after the exec lifecycle consumes it",
    async (_name, pointerWidth) => {
      vi.useFakeTimers();
      const harness = createRetryHarness(pointerWidth);
      const source = 0x1000;
      harness.processBytes.set([1, 2, 3], source);
      writeRequest(harness, ABI_SYSCALLS.Write, [7n, BigInt(source), 3n]);
      const handleChannel = vi.fn((rawPointer: number | bigint) => {
        publishKernelResult(kernelView(harness, rawPointer), -1, EAGAIN);
        return 0;
      });
      harness.kernelExports.kernel_handle_channel = handleChannel;

      harness.worker.handleSyscall(harness.channel);
      expect(handleChannel).toHaveBeenCalledOnce();
      expect(harness.worker.pendingPollRetries.has(harness.channel)).toBe(true);

      const release = harness.kernelExports
        .kernel_blocking_retry_release as ReturnType<typeof vi.fn>;
      harness.worker.prepareProcessForExec(harness.channel.pid);
      // prepareProcessForExec is invoked only after Rust's irreversible exec
      // commit consumed every old-image pin. A numeric release here would be a
      // second, ambiguous ownership transition.
      expect(release).not.toHaveBeenCalled();
      expect(
        harness.worker.blockingRetrySnapshots.has(harness.channel),
      ).toBe(false);

      const replacementMemory = sharedMemory();
      const [replacementChannel] =
        harness.worker.testAuthority.replaceProcessRegistrationForLifecycleTest(
          {
            pid: harness.channel.pid,
            memory: replacementMemory,
            channelOffsets: [6 * 65_536],
            pointerWidth,
          },
        );
      const replacementView = new DataView(
        replacementMemory.buffer,
        replacementChannel.channelOffset,
      );
      replacementView.setUint32(CH_STATUS, CHANNEL_STATUS_PENDING, true);
      replacementView.setUint32(CH_SYSCALL, ABI_SYSCALLS.Getpid, true);

      await vi.advanceTimersByTimeAsync(10);
      await Promise.resolve();

      expect(handleChannel).toHaveBeenCalledOnce();
      expect(harness.worker.pendingPollRetries.has(harness.channel)).toBe(
        false,
      );
      expect(replacementView.getUint32(CH_STATUS, true)).toBe(
        CHANNEL_STATUS_PENDING,
      );
    },
  );
});

describe("remaining pointer-bearing blocking retry snapshots", () => {
  it.each(WIDTHS)(
    "%s retains pollfd bytes, nfds, timeout, and the original output range",
    async (_name, pointerWidth) => {
      vi.useFakeTimers();
      const harness = createRetryHarness(pointerWidth);
      const originalPollfds = 0x1000;
      const replacementPollfds = 0x2000;
      const original = new DataView(
        harness.processMemory.buffer,
        originalPollfds,
        STRUCT_SIZE_WASM_POLL_FD,
      );
      original.setInt32(WASM_POLL_FD_FD_OFFSET, 7, true);
      original.setInt16(WASM_POLL_FD_EVENTS_OFFSET, 1, true);
      const replacement = new DataView(
        harness.processMemory.buffer,
        replacementPollfds,
        STRUCT_SIZE_WASM_POLL_FD,
      );
      replacement.setInt32(WASM_POLL_FD_FD_OFFSET, 88, true);
      replacement.setInt16(WASM_POLL_FD_EVENTS_OFFSET, 4, true);
      writeRequest(harness, ABI_SYSCALLS.Poll, [
        BigInt(originalPollfds),
        1n,
        1_000n,
      ]);
      harness.kernelExports.kernel_get_fd_pipe_idx = vi.fn(() => 17);

      const attempts: Array<{
        fd: number;
        events: number;
        nfds: number;
        timeout: number;
      }> = [];
      harness.kernelExports.kernel_handle_channel = vi.fn(
        (rawPointer: number | bigint) => {
          const view = kernelView(harness, rawPointer);
          const pollfdPointer = Number(kernelArg(view, 0));
          const pollfd = new DataView(
            harness.kernelBytes.buffer,
            pollfdPointer,
            STRUCT_SIZE_WASM_POLL_FD,
          );
          attempts.push({
            fd: pollfd.getInt32(WASM_POLL_FD_FD_OFFSET, true),
            events: pollfd.getInt16(WASM_POLL_FD_EVENTS_OFFSET, true),
            nfds: Number(kernelArg(view, 1)),
            timeout: Number(kernelArg(view, 2)),
          });
          if (attempts.length === 1) {
            publishKernelResult(view, -1, EAGAIN);
          } else {
            pollfd.setInt16(WASM_POLL_FD_REVENTS_OFFSET, 1, true);
            publishKernelResult(view, 1, 0);
          }
          return 0;
        },
      );

      harness.worker.handleSyscall(harness.channel);
      writeRequest(harness, ABI_SYSCALLS.Poll, [
        BigInt(replacementPollfds),
        1n,
        0n,
      ]);
      original.setInt32(WASM_POLL_FD_FD_OFFSET, 99, true);
      original.setInt16(WASM_POLL_FD_EVENTS_OFFSET, 8, true);
      await retryAfterDefaultDelay(harness);

      expect(attempts).toEqual([
        { fd: 7, events: 1, nfds: 1, timeout: 1_000 },
        { fd: 7, events: 1, nfds: 1, timeout: 1_000 },
      ]);
      expect(
        new DataView(
          harness.processMemory.buffer,
          originalPollfds,
          STRUCT_SIZE_WASM_POLL_FD,
        ).getInt16(WASM_POLL_FD_REVENTS_OFFSET, true),
      ).toBe(1);
      expect(
        new DataView(
          harness.processMemory.buffer,
          replacementPollfds,
          STRUCT_SIZE_WASM_POLL_FD,
        ).getInt16(WASM_POLL_FD_REVENTS_OFFSET, true),
      ).toBe(0);
      expectHostOnlyRetryLifecycle(harness, ABI_SYSCALLS.Poll);
    },
  );

  it.each(WIDTHS)(
    "%s retains ppoll's pollfd, timeout, and signal mask values",
    async (_name, pointerWidth) => {
      vi.useFakeTimers();
      const harness = createRetryHarness(pointerWidth);
      const pollfds = 0x1000;
      const timeout = 0x1800;
      const mask = 0x1900;
      const pollfd = new DataView(
        harness.processMemory.buffer,
        pollfds,
        STRUCT_SIZE_WASM_POLL_FD,
      );
      pollfd.setInt32(WASM_POLL_FD_FD_OFFSET, 9, true);
      pollfd.setInt16(WASM_POLL_FD_EVENTS_OFFSET, 1, true);
      const processView = new DataView(harness.processMemory.buffer);
      processView.setBigInt64(timeout, 1n, true);
      processView.setBigInt64(timeout + 8, 0n, true);
      processView.setUint32(mask, 0x11223344, true);
      processView.setUint32(mask + 4, 0x55667788, true);
      writeRequest(harness, ABI_SYSCALLS.Ppoll, [
        BigInt(pollfds),
        1n,
        BigInt(timeout),
        BigInt(mask),
        BigInt(SIGNAL_MASK_BYTES),
      ]);
      harness.kernelExports.kernel_get_fd_pipe_idx = vi.fn(() => 19);

      const attempts: Array<{
        fd: number;
        timeout: number;
        hasMask: number;
        maskLow: number;
        maskHigh: number;
      }> = [];
      harness.kernelExports.kernel_handle_channel = vi.fn(
        (rawPointer: number | bigint) => {
          const view = kernelView(harness, rawPointer);
          const stagedPollfd = new DataView(
            harness.kernelBytes.buffer,
            Number(kernelArg(view, 0)),
            STRUCT_SIZE_WASM_POLL_FD,
          );
          attempts.push({
            fd: stagedPollfd.getInt32(WASM_POLL_FD_FD_OFFSET, true),
            timeout: Number(kernelArg(view, 2)),
            hasMask: Number(kernelArg(view, 3)),
            maskLow: Number(kernelArg(view, 4)),
            maskHigh: Number(kernelArg(view, 5)),
          });
          publishKernelResult(
            view,
            attempts.length === 1 ? -1 : 1,
            attempts.length === 1 ? EAGAIN : 0,
          );
          return 0;
        },
      );

      harness.worker.handleSyscall(harness.channel);
      pollfd.setInt32(WASM_POLL_FD_FD_OFFSET, 77, true);
      processView.setBigInt64(timeout, 0n, true);
      processView.setUint32(mask, 0xaabbccdd, true);
      processView.setUint32(mask + 4, 0xeeff0011, true);
      writeRequest(harness, ABI_SYSCALLS.Ppoll, [0n, 0n, 0n, 0n, 0n]);
      await retryAfterDefaultDelay(harness);

      expect(attempts).toEqual([
        {
          fd: 9,
          timeout: 1_000,
          hasMask: 1,
          maskLow: 0x11223344,
          maskHigh: 0x55667788,
        },
        {
          fd: 9,
          timeout: 1_000,
          hasMask: 1,
          maskLow: 0x11223344,
          maskHigh: 0x55667788,
        },
      ]);
      expectHostOnlyRetryLifecycle(harness, ABI_SYSCALLS.Ppoll);
    },
  );

  it.each(WIDTHS)(
    "%s retains a blocking connect's fd and sockaddr through EINPROGRESS",
    async (_name, pointerWidth) => {
      vi.useFakeTimers();
      const harness = createRetryHarness(pointerWidth);
      const originalAddress = 0x1000;
      const replacementAddress = 0x2000;
      const originalBytes = [2, 0, 0, 80, 203, 0, 113, 9];
      const replacementBytes = [2, 0, 1, 187, 198, 51, 100, 7];
      harness.processBytes.set(originalBytes, originalAddress);
      harness.processBytes.set(replacementBytes, replacementAddress);
      writeRequest(harness, ABI_SYSCALLS.Connect, [
        7n,
        BigInt(originalAddress),
        BigInt(originalBytes.length),
      ]);
      harness.kernelExports.kernel_blocking_retry_token = vi.fn(() => 41n);

      const attempts: Array<{ fd: number; address: number[] }> = [];
      harness.kernelExports.kernel_handle_channel = vi.fn(
        (rawPointer: number | bigint) => {
          const view = kernelView(harness, rawPointer);
          const addressPointer = Number(kernelArg(view, 1));
          const addressLength = Number(kernelArg(view, 2));
          attempts.push({
            fd: Number(kernelArg(view, 0)),
            address: Array.from(
              harness.kernelBytes.slice(
                addressPointer,
                addressPointer + addressLength,
              ),
            ),
          });
          publishKernelResult(
            view,
            attempts.length === 1 ? -1 : 0,
            attempts.length === 1 ? EINPROGRESS : 0,
          );
          return 0;
        },
      );

      harness.worker.handleSyscall(harness.channel);
      harness.processBytes.fill(
        0xee,
        originalAddress,
        originalAddress + originalBytes.length,
      );
      writeRequest(harness, ABI_SYSCALLS.Connect, [
        88n,
        BigInt(replacementAddress),
        BigInt(replacementBytes.length),
      ]);
      await retryAfterDefaultDelay(harness);

      expect(attempts).toEqual([
        { fd: 7, address: originalBytes },
        { fd: 7, address: originalBytes },
      ]);
      expectExactRetryBindingLifecycle(
        harness,
        ABI_SYSCALLS.Connect,
        41n,
      );
    },
  );

  it.each(WIDTHS)(
    "%s retains accept's listener and original peer-address outputs",
    async (_name, pointerWidth) => {
      vi.useFakeTimers();
      const harness = createRetryHarness(pointerWidth);
      const originalAddress = 0x1000;
      const originalLength = 0x1100;
      const replacementAddress = 0x2000;
      const replacementLength = 0x2100;
      const processView = new DataView(harness.processMemory.buffer);
      processView.setUint32(originalLength, 16, true);
      processView.setUint32(replacementLength, 16, true);
      writeRequest(harness, ABI_SYSCALLS.Accept, [
        7n,
        BigInt(originalAddress),
        BigInt(originalLength),
      ]);
      harness.kernelExports.kernel_blocking_retry_token = vi.fn(() => 42n);
      harness.kernelExports.kernel_get_fd_accept_wake_idx = vi.fn(() => 23);

      const attempts: number[] = [];
      const peer = [2, 0, 0, 80, 203, 0, 113, 11];
      harness.kernelExports.kernel_handle_channel = vi.fn(
        (rawPointer: number | bigint) => {
          const view = kernelView(harness, rawPointer);
          attempts.push(Number(kernelArg(view, 0)));
          if (attempts.length === 1) {
            publishKernelResult(view, -1, EAGAIN);
          } else {
            const addressPointer = Number(kernelArg(view, 1));
            const lengthPointer = Number(kernelArg(view, 2));
            harness.kernelBytes.set(peer, addressPointer);
            new DataView(harness.kernelBytes.buffer).setUint32(
              lengthPointer,
              peer.length,
              true,
            );
            publishKernelResult(view, 12, 0);
          }
          return 0;
        },
      );

      harness.worker.handleSyscall(harness.channel);
      writeRequest(harness, ABI_SYSCALLS.Accept, [
        88n,
        BigInt(replacementAddress),
        BigInt(replacementLength),
      ]);
      processView.setUint32(originalLength, 1, true);
      await retryAfterDefaultDelay(harness);

      expect(attempts).toEqual([7, 7]);
      expect(
        Array.from(
          harness.processBytes.slice(
            originalAddress,
            originalAddress + peer.length,
          ),
        ),
      ).toEqual(peer);
      expect(processView.getUint32(originalLength, true)).toBe(peer.length);
      expect(
        Array.from(
          harness.processBytes.slice(
            replacementAddress,
            replacementAddress + peer.length,
          ),
        ),
      ).toEqual(new Array(peer.length).fill(0));
      expect(processView.getUint32(replacementLength, true)).toBe(16);
      expectExactRetryBindingLifecycle(
        harness,
        ABI_SYSCALLS.Accept,
        42n,
      );
    },
  );

  it.each(WIDTHS)(
    "%s retains rt_sigtimedwait's mask, output destination, and timeout",
    async (_name, pointerWidth) => {
      vi.useFakeTimers();
      const harness = createRetryHarness(pointerWidth);
      const mask = 0x1000;
      const info = 0x1200;
      const timeout = 0x1400;
      const replacementInfo = 0x2200;
      const processView = new DataView(harness.processMemory.buffer);
      processView.setBigUint64(mask, 0x0102030405060708n, true);
      processView.setBigInt64(timeout, 5n, true);
      processView.setBigInt64(timeout + 8, 0n, true);
      writeRequest(harness, ABI_SYSCALLS.RtSigtimedwait, [
        BigInt(mask),
        BigInt(info),
        BigInt(timeout),
        BigInt(SIGNAL_MASK_BYTES),
      ]);

      const attempts: Array<{ mask: bigint; timeoutSeconds: bigint }> = [];
      harness.kernelExports.kernel_handle_channel = vi.fn(
        (rawPointer: number | bigint) => {
          const view = kernelView(harness, rawPointer);
          const stagedMask = new DataView(
            harness.kernelBytes.buffer,
            Number(kernelArg(view, 0)),
            SIGNAL_MASK_BYTES,
          );
          const stagedTimeout = new DataView(
            harness.kernelBytes.buffer,
            Number(kernelArg(view, 2)),
            16,
          );
          attempts.push({
            mask: stagedMask.getBigUint64(0, true),
            timeoutSeconds: stagedTimeout.getBigInt64(0, true),
          });
          if (attempts.length === 1) {
            publishKernelResult(view, -1, EAGAIN);
          } else {
            const infoPointer = Number(kernelArg(view, 1));
            harness.kernelBytes.fill(0x5a, infoPointer, infoPointer + 128);
            publishKernelResult(view, 10, 0);
          }
          return 0;
        },
      );

      harness.worker.handleSyscall(harness.channel);
      processView.setBigUint64(mask, 0xffffffffffffffffn, true);
      processView.setBigInt64(timeout, 0n, true);
      writeRequest(harness, ABI_SYSCALLS.RtSigtimedwait, [
        BigInt(mask),
        BigInt(replacementInfo),
        0n,
        BigInt(SIGNAL_MASK_BYTES),
      ]);
      harness.worker.retrySyscall(harness.channel);
      await Promise.resolve();

      expect(attempts).toEqual([
        { mask: 0x0102030405060708n, timeoutSeconds: 5n },
        { mask: 0x0102030405060708n, timeoutSeconds: 5n },
      ]);
      expect(
        Array.from(harness.processBytes.slice(info, info + 128)),
      ).toEqual(new Array(128).fill(0x5a));
      expect(
        Array.from(
          harness.processBytes.slice(replacementInfo, replacementInfo + 128),
        ),
      ).toEqual(new Array(128).fill(0));
      expectHostOnlyRetryLifecycle(
        harness,
        ABI_SYSCALLS.RtSigtimedwait,
      );
    },
  );

  it.each(WIDTHS)(
    "%s retains a FIFO open pathname and flags while parked",
    async (_name, pointerWidth) => {
      vi.useFakeTimers();
      const harness = createRetryHarness(pointerWidth);
      const originalPath = 0x1000;
      const replacementPath = 0x2000;
      const original = Array.from(new TextEncoder().encode("/fifo/original\0"));
      const replacement = Array.from(
        new TextEncoder().encode("/fifo/replacement\0"),
      );
      harness.processBytes.set(original, originalPath);
      harness.processBytes.set(replacement, replacementPath);
      writeRequest(harness, ABI_SYSCALLS.Open, [
        BigInt(originalPath),
        0n,
        0n,
      ]);

      const attempts: Array<{ path: number[]; flags: number }> = [];
      harness.kernelExports.kernel_handle_channel = vi.fn(
        (rawPointer: number | bigint) => {
          const view = kernelView(harness, rawPointer);
          const pathPointer = Number(kernelArg(view, 0));
          attempts.push({
            path: Array.from(
              harness.kernelBytes.slice(
                pathPointer,
                pathPointer + original.length,
              ),
            ),
            flags: Number(kernelArg(view, 1)),
          });
          publishKernelResult(
            view,
            attempts.length === 1 ? -1 : 14,
            attempts.length === 1 ? EAGAIN : 0,
          );
          return 0;
        },
      );

      harness.worker.handleSyscall(harness.channel);
      harness.processBytes.fill(
        0xee,
        originalPath,
        originalPath + original.length,
      );
      writeRequest(harness, ABI_SYSCALLS.Open, [
        BigInt(replacementPath),
        0x800n,
        0n,
      ]);
      await retryAfterDefaultDelay(harness);

      expect(attempts).toEqual([
        { path: original, flags: 0 },
        { path: original, flags: 0 },
      ]);
      expectHostOnlyRetryLifecycle(harness, ABI_SYSCALLS.Open);
    },
  );

  it.each(WIDTHS)(
    "%s retains F_SETLKW's flock wire and acquires an exact target token",
    async (_name, pointerWidth) => {
      vi.useFakeTimers();
      const harness = createRetryHarness(pointerWidth);
      const flockPointer = 0x1000;
      const replacementPointer = 0x2000;
      const original = Array.from(
        { length: FCNTL_FLOCK_BYTES },
        (_, index) => (index * 7 + 3) & 0xff,
      );
      const replacement = new Array(FCNTL_FLOCK_BYTES).fill(0xee);
      harness.processBytes.set(original, flockPointer);
      harness.processBytes.set(replacement, replacementPointer);
      writeRequest(harness, ABI_SYSCALLS.Fcntl, [
        7n,
        7n,
        BigInt(flockPointer),
      ]);
      harness.kernelExports.kernel_blocking_retry_token = vi.fn(() => 43n);

      const attempts: Array<{ fd: number; flock: number[] }> = [];
      harness.kernelExports.kernel_handle_channel = vi.fn(
        (rawPointer: number | bigint) => {
          const view = kernelView(harness, rawPointer);
          const stagedPointer = Number(kernelArg(view, 2));
          attempts.push({
            fd: Number(kernelArg(view, 0)),
            flock: Array.from(
              harness.kernelBytes.slice(
                stagedPointer,
                stagedPointer + FCNTL_FLOCK_BYTES,
              ),
            ),
          });
          publishKernelResult(
            view,
            attempts.length === 1 ? -1 : 0,
            attempts.length === 1 ? EAGAIN : 0,
          );
          return 0;
        },
      );

      harness.worker.handleSyscall(harness.channel);
      harness.processBytes.fill(
        0xaa,
        flockPointer,
        flockPointer + FCNTL_FLOCK_BYTES,
      );
      writeRequest(harness, ABI_SYSCALLS.Fcntl, [
        88n,
        7n,
        BigInt(replacementPointer),
      ]);
      await vi.advanceTimersByTimeAsync(10);
      await Promise.resolve();

      expect(attempts).toEqual([
        { fd: 7, flock: original },
        { fd: 7, flock: original },
      ]);
      expectExactRetryBindingLifecycle(
        harness,
        ABI_SYSCALLS.Fcntl,
        43n,
      );
    },
  );

  it.each(WIDTHS)(
    "%s retains blocking flock scalars and its exact OFD token",
    async (_name, pointerWidth) => {
      vi.useFakeTimers();
      const harness = createRetryHarness(pointerWidth);
      writeRequest(harness, ABI_SYSCALLS.Flock, [7n, 2n]);
      harness.kernelExports.kernel_blocking_retry_token = vi.fn(() => 44n);

      const attempts: Array<{ fd: number; operation: number }> = [];
      harness.kernelExports.kernel_handle_channel = vi.fn(
        (rawPointer: number | bigint) => {
          const view = kernelView(harness, rawPointer);
          attempts.push({
            fd: Number(kernelArg(view, 0)),
            operation: Number(kernelArg(view, 1)),
          });
          publishKernelResult(
            view,
            attempts.length === 1 ? -1 : 0,
            attempts.length === 1 ? EAGAIN : 0,
          );
          return 0;
        },
      );

      harness.worker.handleSyscall(harness.channel);
      writeRequest(harness, ABI_SYSCALLS.Flock, [88n, 8n]);
      await vi.advanceTimersByTimeAsync(10);
      await Promise.resolve();

      expect(attempts).toEqual([
        { fd: 7, operation: 2 },
        { fd: 7, operation: 2 },
      ]);
      expectExactRetryBindingLifecycle(
        harness,
        ABI_SYSCALLS.Flock,
        44n,
      );
    },
  );

  it.each([
    ["wasm32 F_SETLK", 4, 6],
    ["wasm64 F_SETLK", 8, 6],
    ["wasm32 F_OFD_SETLK", 4, 37],
    ["wasm64 F_OFD_SETLK", 8, 37],
  ] as const)(
    "%s releases its Rust target pin before returning EAGAIN",
    (_name, pointerWidth, command) => {
      const harness = createRetryHarness(pointerWidth);
      const flockPointer = 0x1000;
      harness.processBytes.fill(
        0x3c,
        flockPointer,
        flockPointer + FCNTL_FLOCK_BYTES,
      );
      writeRequest(harness, ABI_SYSCALLS.Fcntl, [
        7n,
        BigInt(command),
        BigInt(flockPointer),
      ]);
      harness.kernelExports.kernel_blocking_retry_token = vi.fn(() => 45n);
      harness.kernelExports.kernel_handle_channel = vi.fn(
        (rawPointer: number | bigint) => {
          publishKernelResult(kernelView(harness, rawPointer), -1, EAGAIN);
          return 0;
        },
      );

      harness.worker.handleSyscall(harness.channel);

      expect(requestResult(harness)).toEqual({
        status: CHANNEL_STATUS_COMPLETE,
        returnValue: -1,
        errno: EAGAIN,
      });
      expect(harness.worker.pendingAdvisoryLockRetries.size).toBe(0);
      expect(
        harness.kernelExports.kernel_blocking_retry_token,
      ).toHaveBeenCalledWith(
        harness.channel.pid,
        harness.channel.pid,
        ABI_SYSCALLS.Fcntl,
      );
      expect(
        harness.kernelExports.kernel_blocking_retry_release,
      ).toHaveBeenCalledWith(
        harness.channel.pid,
        harness.channel.pid,
        45n,
      );
    },
  );

  it.each(WIDTHS)(
    "%s retains select fd_sets, timeout, and original output pointers",
    async (_name, pointerWidth) => {
      vi.useFakeTimers();
      const harness = createRetryHarness(pointerWidth);
      const readPointer = 0x1000;
      const replacementReadPointer = 0x2000;
      const timeoutPointer = 0x1800;
      const processView = new DataView(harness.processMemory.buffer);
      harness.processBytes[readPointer] = 0x01;
      harness.processBytes[replacementReadPointer] = 0x80;
      if (pointerWidth === 8) {
        processView.setBigInt64(timeoutPointer, 1n, true);
        processView.setBigInt64(timeoutPointer + 8, 0n, true);
      } else {
        processView.setInt32(timeoutPointer, 1, true);
        processView.setInt32(timeoutPointer + 4, 0, true);
      }
      writeRequest(harness, ABI_SYSCALLS.Select, [
        8n,
        BigInt(readPointer),
        0n,
        0n,
        BigInt(timeoutPointer),
      ]);

      const attempts: Array<{ firstByte: number; timeout: number }> = [];
      harness.kernelExports.kernel_handle_channel = vi.fn(
        (rawPointer: number | bigint) => {
          const view = kernelView(harness, rawPointer);
          const stagedReadPointer = Number(kernelArg(view, 1));
          attempts.push({
            firstByte: harness.kernelBytes[stagedReadPointer]!,
            timeout: Number(kernelArg(view, 4)),
          });
          if (attempts.length === 1) {
            publishKernelResult(view, -1, EAGAIN);
          } else {
            harness.kernelBytes[stagedReadPointer] = 0x04;
            publishKernelResult(view, 1, 0);
          }
          return 0;
        },
      );

      harness.worker.handleSyscall(harness.channel);
      harness.processBytes[readPointer] = 0xff;
      if (pointerWidth === 8) {
        processView.setBigInt64(timeoutPointer, 0n, true);
      } else {
        processView.setInt32(timeoutPointer, 0, true);
      }
      writeRequest(harness, ABI_SYSCALLS.Select, [
        64n,
        BigInt(replacementReadPointer),
        0n,
        0n,
        0n,
      ]);
      await vi.advanceTimersByTimeAsync(50);
      await Promise.resolve();

      expect(attempts).toEqual([
        { firstByte: 0x01, timeout: 1_000 },
        { firstByte: 0x01, timeout: 1_000 },
      ]);
      expect(harness.processBytes[readPointer]).toBe(0x04);
      expect(harness.processBytes[replacementReadPointer]).toBe(0x80);
      expectHostOnlyRetryLifecycle(harness, ABI_SYSCALLS.Select);
    },
  );

  it.each(WIDTHS)(
    "%s retains pselect6 fd_sets, timeout, mask descriptor, and outputs",
    async (_name, pointerWidth) => {
      vi.useFakeTimers();
      const harness = createRetryHarness(pointerWidth);
      const readPointer = 0x1000;
      const replacementReadPointer = 0x2000;
      const timeoutPointer = 0x1800;
      const maskDescriptorPointer = 0x1900;
      const maskPointer = 0x1a00;
      const replacementMaskPointer = 0x2a00;
      const processView = new DataView(harness.processMemory.buffer);
      harness.processBytes[readPointer] = 0x02;
      harness.processBytes[replacementReadPointer] = 0x40;
      processView.setBigInt64(timeoutPointer, 1n, true);
      processView.setBigInt64(timeoutPointer + 8, 0n, true);
      processView.setBigUint64(maskPointer, 0x1122334455667788n, true);
      processView.setBigUint64(
        replacementMaskPointer,
        0xaabbccddeeff0011n,
        true,
      );
      if (pointerWidth === 8) {
        processView.setBigUint64(
          maskDescriptorPointer,
          BigInt(maskPointer),
          true,
        );
        processView.setBigUint64(
          maskDescriptorPointer + 8,
          BigInt(SIGNAL_MASK_BYTES),
          true,
        );
      } else {
        processView.setUint32(maskDescriptorPointer, maskPointer, true);
        processView.setUint32(
          maskDescriptorPointer + 4,
          SIGNAL_MASK_BYTES,
          true,
        );
      }
      writeRequest(harness, ABI_SYSCALLS.Pselect6, [
        8n,
        BigInt(readPointer),
        0n,
        0n,
        BigInt(timeoutPointer),
        BigInt(maskDescriptorPointer),
      ]);

      const attempts: Array<{
        firstByte: number;
        timeout: number;
        mask: bigint;
      }> = [];
      harness.kernelExports.kernel_handle_channel = vi.fn(
        (rawPointer: number | bigint) => {
          const view = kernelView(harness, rawPointer);
          const stagedReadPointer = Number(kernelArg(view, 1));
          const stagedMaskPointer = Number(kernelArg(view, 5));
          attempts.push({
            firstByte: harness.kernelBytes[stagedReadPointer]!,
            timeout: Number(kernelArg(view, 4)),
            mask: new DataView(
              harness.kernelBytes.buffer,
              stagedMaskPointer,
              SIGNAL_MASK_BYTES,
            ).getBigUint64(0, true),
          });
          if (attempts.length === 1) {
            publishKernelResult(view, -1, EAGAIN);
          } else {
            harness.kernelBytes[stagedReadPointer] = 0x08;
            publishKernelResult(view, 1, 0);
          }
          return 0;
        },
      );

      harness.worker.handleSyscall(harness.channel);
      harness.processBytes[readPointer] = 0xff;
      processView.setBigInt64(timeoutPointer, 0n, true);
      processView.setBigUint64(maskPointer, 0xffffffffffffffffn, true);
      if (pointerWidth === 8) {
        processView.setBigUint64(
          maskDescriptorPointer,
          BigInt(replacementMaskPointer),
          true,
        );
      } else {
        processView.setUint32(
          maskDescriptorPointer,
          replacementMaskPointer,
          true,
        );
      }
      writeRequest(harness, ABI_SYSCALLS.Pselect6, [
        64n,
        BigInt(replacementReadPointer),
        0n,
        0n,
        0n,
        0n,
      ]);
      await vi.advanceTimersByTimeAsync(50);
      await Promise.resolve();

      expect(attempts).toEqual([
        {
          firstByte: 0x02,
          timeout: 1_000,
          mask: 0x1122334455667788n,
        },
        {
          firstByte: 0x02,
          timeout: 1_000,
          mask: 0x1122334455667788n,
        },
      ]);
      expect(harness.processBytes[readPointer]).toBe(0x08);
      expect(harness.processBytes[replacementReadPointer]).toBe(0x40);
      expectHostOnlyRetryLifecycle(harness, ABI_SYSCALLS.Pselect6);
    },
  );

  it.each(WIDTHS)(
    "%s restores ppoll's temporary mask before a zero-time EAGAIN completes",
    (_name, pointerWidth) => {
      const harness = createRetryHarness(pointerWidth);
      const pollfds = 0x1000;
      const timeout = 0x1800;
      const mask = 0x1900;
      const pollfd = new DataView(
        harness.processMemory.buffer,
        pollfds,
        STRUCT_SIZE_WASM_POLL_FD,
      );
      pollfd.setInt32(WASM_POLL_FD_FD_OFFSET, 7, true);
      pollfd.setInt16(WASM_POLL_FD_EVENTS_OFFSET, 1, true);
      new DataView(harness.processMemory.buffer).setBigUint64(
        mask,
        0x1122334455667788n,
        true,
      );
      writeRequest(harness, ABI_SYSCALLS.Ppoll, [
        BigInt(pollfds),
        1n,
        BigInt(timeout),
        BigInt(mask),
        BigInt(SIGNAL_MASK_BYTES),
      ]);

      const syscalls: number[] = [];
      harness.kernelExports.kernel_handle_channel = vi.fn(
        (rawPointer: number | bigint) => {
          const view = kernelView(harness, rawPointer);
          const syscall = view.getUint32(CH_SYSCALL, true);
          syscalls.push(syscall);
          publishKernelResult(
            view,
            syscall === ABI_SYSCALLS.Ppoll ? -1 : 0,
            syscall === ABI_SYSCALLS.Ppoll ? EAGAIN : 0,
          );
          return 0;
        },
      );

      harness.worker.handleSyscall(harness.channel);

      expect(syscalls).toEqual([
        ABI_SYSCALLS.Ppoll,
        ABI_SYSCALLS.ThreadCancel,
      ]);
      expect(requestResult(harness)).toEqual({
        status: CHANNEL_STATUS_COMPLETE,
        returnValue: 0,
        errno: 0,
      });
      expect(
        harness.worker.blockingRetrySnapshots.has(harness.channel),
      ).toBe(false);
    },
  );

  it.each(WIDTHS)(
    "%s restores pselect6's temporary mask before a zero-time EAGAIN completes",
    (_name, pointerWidth) => {
      const harness = createRetryHarness(pointerWidth);
      const readPointer = 0x1000;
      const timeoutPointer = 0x1800;
      const descriptorPointer = 0x1900;
      const maskPointer = 0x1a00;
      const processView = new DataView(harness.processMemory.buffer);
      harness.processBytes[readPointer] = 1;
      processView.setBigUint64(maskPointer, 0x80n, true);
      if (pointerWidth === 8) {
        processView.setBigUint64(
          descriptorPointer,
          BigInt(maskPointer),
          true,
        );
        processView.setBigUint64(
          descriptorPointer + 8,
          BigInt(SIGNAL_MASK_BYTES),
          true,
        );
      } else {
        processView.setUint32(descriptorPointer, maskPointer, true);
        processView.setUint32(
          descriptorPointer + 4,
          SIGNAL_MASK_BYTES,
          true,
        );
      }
      writeRequest(harness, ABI_SYSCALLS.Pselect6, [
        8n,
        BigInt(readPointer),
        0n,
        0n,
        BigInt(timeoutPointer),
        BigInt(descriptorPointer),
      ]);

      const syscalls: number[] = [];
      harness.kernelExports.kernel_handle_channel = vi.fn(
        (rawPointer: number | bigint) => {
          const view = kernelView(harness, rawPointer);
          const syscall = view.getUint32(CH_SYSCALL, true);
          syscalls.push(syscall);
          publishKernelResult(
            view,
            syscall === ABI_SYSCALLS.Pselect6 ? -1 : 0,
            syscall === ABI_SYSCALLS.Pselect6 ? EAGAIN : 0,
          );
          return 0;
        },
      );

      harness.worker.handleSyscall(harness.channel);

      expect(syscalls).toEqual([
        ABI_SYSCALLS.Pselect6,
        ABI_SYSCALLS.ThreadCancel,
      ]);
      expect(requestResult(harness)).toEqual({
        status: CHANNEL_STATUS_COMPLETE,
        returnValue: 0,
        errno: 0,
      });
      expect(
        harness.worker.blockingRetrySnapshots.has(harness.channel),
      ).toBe(false);
    },
  );

  it.each(WIDTHS)(
    "%s completes zero-time select without synthetic mask cleanup",
    (_name, pointerWidth) => {
      const harness = createRetryHarness(pointerWidth);
      const readPointer = 0x1000;
      const timeoutPointer = 0x1800;
      harness.processBytes[readPointer] = 1;
      writeRequest(harness, ABI_SYSCALLS.Select, [
        8n,
        BigInt(readPointer),
        0n,
        0n,
        BigInt(timeoutPointer),
      ]);

      const syscalls: number[] = [];
      harness.kernelExports.kernel_handle_channel = vi.fn(
        (rawPointer: number | bigint) => {
          const view = kernelView(harness, rawPointer);
          syscalls.push(view.getUint32(CH_SYSCALL, true));
          publishKernelResult(view, -1, EAGAIN);
          return 0;
        },
      );

      harness.worker.handleSyscall(harness.channel);

      expect(syscalls).toEqual([ABI_SYSCALLS.Select]);
      expect(requestResult(harness)).toEqual({
        status: CHANNEL_STATUS_COMPLETE,
        returnValue: 0,
        errno: 0,
      });
      expect(
        harness.worker.blockingRetrySnapshots.has(harness.channel),
      ).toBe(false);
    },
  );

  it.each(WIDTHS)(
    "%s publishes EINTR instead of re-parking a caught signal on accept",
    (_name, pointerWidth) => {
      const harness = createRetryHarness(pointerWidth);
      writeRequest(harness, ABI_SYSCALLS.Accept, [7n, 0n, 0n]);
      harness.kernelExports.kernel_blocking_retry_token = vi.fn(() => 74n);
      harness.kernelExports.kernel_handle_channel = vi.fn(
        (rawPointer: number | bigint) => {
          publishKernelResult(
            kernelView(harness, rawPointer),
            -1,
            EAGAIN,
          );
          return 0;
        },
      );
      harness.kernelExports.kernel_dequeue_signal = vi.fn(
        (
          _pid: number,
          _tid: number,
          rawPointer: number | bigint,
        ) => writeKernelCaughtSignal(harness, rawPointer),
      );

      harness.worker.handleSyscall(harness.channel);

      expect(requestResult(harness)).toEqual({
        status: CHANNEL_STATUS_COMPLETE,
        returnValue: -1,
        errno: EINTR,
      });
      const channelView = new DataView(
        harness.processMemory.buffer,
        harness.channel.channelOffset,
      );
      expect(channelView.getUint32(CH_SIG_SIGNUM, true)).toBe(SIGUSR1);
      expect(channelView.getUint32(CH_SIG_FLAGS, true)).toBe(SA_RESTART);
      expect(
        harness.kernelExports.kernel_blocking_retry_token,
      ).toHaveBeenCalledWith(
        harness.channel.pid,
        harness.channel.pid,
        ABI_SYSCALLS.Accept,
      );
      expect(
        harness.kernelExports.kernel_handle_channel.mock.calls.map(
          (call) => call[3],
        ),
      ).toEqual([0n]);
      expect(
        harness.kernelExports.kernel_blocking_retry_release,
      ).toHaveBeenCalledWith(
        harness.channel.pid,
        harness.channel.pid,
        74n,
      );
      expect(harness.worker.pendingPollRetries.has(harness.channel)).toBe(
        false,
      );
    },
  );

  it.each(WIDTHS)(
    "%s publishes EINTR instead of parking a caught signal on nanosleep",
    (_name, pointerWidth) => {
      const harness = createRetryHarness(pointerWidth);
      const requestPointer = 0x1000;
      const processView = new DataView(harness.processMemory.buffer);
      processView.setBigInt64(requestPointer, 5n, true);
      processView.setBigInt64(requestPointer + 8, 0n, true);
      writeRequest(
        harness,
        ABI_SYSCALLS.Nanosleep,
        [BigInt(requestPointer), 0n],
      );
      harness.kernelExports.kernel_handle_channel = vi.fn(
        (rawPointer: number | bigint) => {
          publishKernelResult(kernelView(harness, rawPointer), 0, 0);
          return 0;
        },
      );
      harness.kernelExports.kernel_dequeue_signal = vi.fn(
        (
          _pid: number,
          _tid: number,
          rawPointer: number | bigint,
        ) => writeKernelCaughtSignal(harness, rawPointer),
      );

      harness.worker.handleSyscall(harness.channel);

      // The signal record must survive for the glue: a parked sleep would
      // publish no completion, and the sleep's own later completion would
      // find nothing pending and clear the record — losing the signal.
      expect(requestResult(harness)).toEqual({
        status: CHANNEL_STATUS_COMPLETE,
        returnValue: -1,
        errno: EINTR,
      });
      expect(harness.worker.pendingSleeps.has(harness.channel)).toBe(false);
      const channelView = new DataView(
        harness.processMemory.buffer,
        harness.channel.channelOffset,
      );
      expect(channelView.getUint32(CH_SIG_SIGNUM, true)).toBe(SIGUSR1);
    },
  );

  it.each(WIDTHS)(
    "%s preserves public accept EAGAIN while attaching a caught signal",
    (_name, pointerWidth) => {
      const harness = createRetryHarness(pointerWidth);
      writeRequest(harness, ABI_SYSCALLS.Accept, [7n, 0n, 0n]);
      const isFdNonblock = vi.fn(() => 1);
      harness.kernelExports.kernel_is_fd_nonblock = isFdNonblock;
      harness.kernelExports.kernel_blocking_retry_token = vi.fn(() => 75n);
      harness.kernelExports.kernel_handle_channel = vi.fn(
        (rawPointer: number | bigint) => {
          publishKernelResult(
            kernelView(harness, rawPointer),
            -1,
            EAGAIN,
          );
          return 0;
        },
      );
      harness.kernelExports.kernel_dequeue_signal = vi.fn(
        (
          _pid: number,
          _tid: number,
          rawPointer: number | bigint,
        ) => writeKernelCaughtSignal(harness, rawPointer),
      );

      harness.worker.handleSyscall(harness.channel);

      expect(requestResult(harness)).toEqual({
        status: CHANNEL_STATUS_COMPLETE,
        returnValue: -1,
        errno: EAGAIN,
      });
      expect(isFdNonblock).toHaveBeenCalledWith(
        harness.channel.pid,
        7,
      );
      const channelView = new DataView(
        harness.processMemory.buffer,
        harness.channel.channelOffset,
      );
      expect(channelView.getUint32(CH_SIG_SIGNUM, true)).toBe(SIGUSR1);
      expect(channelView.getUint32(CH_SIG_FLAGS, true)).toBe(SA_RESTART);
      expect(
        harness.kernelExports.kernel_blocking_retry_token,
      ).toHaveBeenCalledWith(
        harness.channel.pid,
        harness.channel.pid,
        ABI_SYSCALLS.Accept,
      );
      expect(
        harness.kernelExports.kernel_handle_channel.mock.calls.map(
          (call) => call[3],
        ),
      ).toEqual([0n]);
      expect(
        harness.kernelExports.kernel_blocking_retry_release,
      ).toHaveBeenCalledWith(
        harness.channel.pid,
        harness.channel.pid,
        75n,
      );
      expect(harness.worker.pendingPollRetries.has(harness.channel)).toBe(
        false,
      );
    },
  );

  it.each(WIDTHS)(
    "%s releases exact retry authority before a first-attempt caught-signal EINTR",
    (_name, pointerWidth) => {
      const harness = createRetryHarness(pointerWidth);
      const destination = 0x1000;
      writeRequest(harness, ABI_SYSCALLS.Read, [
        7n,
        BigInt(destination),
        1n,
      ]);
      harness.kernelExports.kernel_blocking_retry_token = vi.fn(() => 71n);
      harness.kernelExports.kernel_handle_channel = vi.fn(
        (rawPointer: number | bigint) => {
          publishKernelResult(
            kernelView(harness, rawPointer),
            -1,
            EAGAIN,
          );
          return 0;
        },
      );
      harness.kernelExports.kernel_dequeue_signal = vi.fn(
        (
          _pid: number,
          _tid: number,
          rawPointer: number | bigint,
        ) => writeKernelCaughtSignal(harness, rawPointer),
      );

      harness.worker.handleSyscall(harness.channel);

      expect(requestResult(harness)).toEqual({
        status: CHANNEL_STATUS_COMPLETE,
        returnValue: -1,
        errno: EINTR,
      });
      expect(
        harness.kernelExports.kernel_blocking_retry_token,
      ).toHaveBeenCalledOnce();
      expect(
        harness.kernelExports.kernel_blocking_retry_release,
      ).toHaveBeenCalledWith(
        harness.channel.pid,
        harness.channel.pid,
        71n,
      );
      const channelView = new DataView(
        harness.processMemory.buffer,
        harness.channel.channelOffset,
      );
      expect(channelView.getUint32(CH_SIG_SIGNUM, true)).toBe(SIGUSR1);
      expect(channelView.getUint32(CH_SIG_FLAGS, true)).toBe(SA_RESTART);
      expect(harness.worker.pendingPollRetries.has(harness.channel)).toBe(
        false,
      );
    },
  );

  it.each(WIDTHS)(
    "%s preserves a replay-dequeued caught signal while releasing the original retry token",
    async (_name, pointerWidth) => {
      vi.useFakeTimers();
      const harness = createRetryHarness(pointerWidth);
      const destination = 0x1000;
      writeRequest(harness, ABI_SYSCALLS.Read, [
        7n,
        BigInt(destination),
        1n,
      ]);
      harness.kernelExports.kernel_blocking_retry_token = vi.fn(() => 72n);
      harness.kernelExports.kernel_handle_channel = vi.fn(
        (rawPointer: number | bigint) => {
          publishKernelResult(
            kernelView(harness, rawPointer),
            -1,
            EAGAIN,
          );
          return 0;
        },
      );
      let dequeues = 0;
      harness.kernelExports.kernel_dequeue_signal = vi.fn(
        (
          _pid: number,
          _tid: number,
          rawPointer: number | bigint,
        ) => {
          dequeues++;
          return dequeues === 2
            ? writeKernelCaughtSignal(harness, rawPointer)
            : 0;
        },
      );

      harness.worker.handleSyscall(harness.channel);
      expect(requestStatus(harness)).toBe(CHANNEL_STATUS_PENDING);
      await retryAfterDefaultDelay(harness);

      expect(requestResult(harness)).toEqual({
        status: CHANNEL_STATUS_COMPLETE,
        returnValue: -1,
        errno: EINTR,
      });
      const channelView = new DataView(
        harness.processMemory.buffer,
        harness.channel.channelOffset,
      );
      expect(channelView.getUint32(CH_SIG_SIGNUM, true)).toBe(SIGUSR1);
      expect(channelView.getUint32(CH_SIG_FLAGS, true)).toBe(SA_RESTART);
      expectExactRetryBindingLifecycle(
        harness,
        ABI_SYSCALLS.Read,
        72n,
      );
      expect(harness.worker.pendingPollRetries.has(harness.channel)).toBe(
        false,
      );
    },
  );

  it.each(WIDTHS)(
    "%s ignores guest-forged signal bytes while replaying a blocked read",
    async (_name, pointerWidth) => {
      vi.useFakeTimers();
      const harness = createRetryHarness(pointerWidth);
      const destination = 0x1000;
      writeRequest(harness, ABI_SYSCALLS.Read, [
        7n,
        BigInt(destination),
        1n,
      ]);
      harness.kernelExports.kernel_blocking_retry_token = vi.fn(() => 73n);
      let attempts = 0;
      harness.kernelExports.kernel_handle_channel = vi.fn(
        (rawPointer: number | bigint) => {
          attempts++;
          const view = kernelView(harness, rawPointer);
          publishKernelResult(
            view,
            attempts === 1 ? -1 : 1,
            attempts === 1 ? EAGAIN : 0,
          );
          return 0;
        },
      );
      harness.kernelExports.kernel_dequeue_signal = vi.fn(() => 0);

      harness.worker.handleSyscall(harness.channel);
      const channelView = new DataView(
        harness.processMemory.buffer,
        harness.channel.channelOffset,
      );
      channelView.setUint32(CH_SIG_SIGNUM, SIGUSR1, true);
      channelView.setUint32(CH_SIG_FLAGS, SA_RESTART, true);
      await retryAfterDefaultDelay(harness);

      expect(requestResult(harness)).toEqual({
        status: CHANNEL_STATUS_COMPLETE,
        returnValue: 1,
        errno: 0,
      });
      expect(channelView.getUint32(CH_SIG_SIGNUM, true)).toBe(0);
      expect(channelView.getUint32(CH_SIG_FLAGS, true)).toBe(0);
      expectExactRetryBindingLifecycle(
        harness,
        ABI_SYSCALLS.Read,
        73n,
      );
    },
  );

  it.each(WIDTHS)(
    "%s freezes timed-socket restart policy across a blocked-read replay",
    async (_name, pointerWidth) => {
      vi.useFakeTimers();
      const harness = createRetryHarness(pointerWidth);
      const destination = 0x1000;
      writeRequest(harness, ABI_SYSCALLS.Read, [
        7n,
        BigInt(destination),
        1n,
      ]);
      harness.kernelExports.kernel_blocking_retry_token = vi.fn(() => 74n);
      const isFdNonblock = vi.fn(() => 0);
      const getTimeout = vi.fn(() => 5_000n);
      harness.kernelExports.kernel_is_fd_nonblock = isFdNonblock;
      harness.kernelExports.kernel_get_socket_timeout_ms = getTimeout;
      harness.kernelExports.kernel_handle_channel = vi.fn(
        (rawPointer: number | bigint) => {
          publishKernelResult(
            kernelView(harness, rawPointer),
            -1,
            EAGAIN,
          );
          return 0;
        },
      );
      let dequeues = 0;
      harness.kernelExports.kernel_dequeue_signal = vi.fn(
        (
          _pid: number,
          _tid: number,
          rawPointer: number | bigint,
        ) => {
          dequeues++;
          return dequeues === 2
            ? writeKernelCaughtSignal(harness, rawPointer)
            : 0;
        },
      );

      harness.worker.handleSyscall(harness.channel);
      const firstAttemptTimeoutQueries = getTimeout.mock.calls.length;
      expect(isFdNonblock).toHaveBeenCalledOnce();
      expect(firstAttemptTimeoutQueries).toBe(1);

      // Model close/reuse before the retry. The retained policy belongs to
      // the original pinned OFD, so the replacement numeric fd's zero timeout
      // must not re-enable SA_RESTART.
      getTimeout.mockReturnValue(0n);
      await retryAfterDefaultDelay(harness);

      expect(requestResult(harness)).toEqual({
        status: CHANNEL_STATUS_COMPLETE,
        returnValue: -1,
        errno: EINTR,
      });
      expect(getTimeout).toHaveBeenCalledTimes(
        firstAttemptTimeoutQueries,
      );
      expect(isFdNonblock).toHaveBeenCalledOnce();
      const channelView = new DataView(
        harness.processMemory.buffer,
        harness.channel.channelOffset,
      );
      expect(channelView.getUint32(CH_SIG_SIGNUM, true)).toBe(SIGUSR1);
      expect(channelView.getUint32(CH_SIG_FLAGS, true)).toBe(0);
      expectExactRetryBindingLifecycle(
        harness,
        ABI_SYSCALLS.Read,
        74n,
      );
    },
  );

  it.each([
    [
      "missing signal-target selector",
      (harness: RetryHarness) => {
        harness.kernelExports.kernel_pick_signal_target_tid = undefined;
      },
      "kernel export kernel_pick_signal_target_tid failed",
    ],
    [
      "throwing signal-target selector",
      (harness: RetryHarness) => {
        harness.kernelExports.kernel_pick_signal_target_tid = vi.fn(
          () => {
            throw new Error("selector trap");
          },
        );
      },
      "kernel export kernel_pick_signal_target_tid failed",
    ],
    [
      "negative signal-target selector result",
      (harness: RetryHarness) => {
        harness.kernelExports.kernel_pick_signal_target_tid = vi.fn(
          () => -1,
        );
      },
      "kernel returned invalid signal target TID -1",
    ],
    [
      "missing deliverable-signal query",
      (harness: RetryHarness) => {
        harness.kernelExports.kernel_thread_has_deliverable = undefined;
      },
      "kernel export kernel_thread_has_deliverable failed",
    ],
    [
      "throwing deliverable-signal query",
      (harness: RetryHarness) => {
        harness.kernelExports.kernel_thread_has_deliverable = vi.fn(
          () => {
            throw new Error("deliverability trap");
          },
        );
      },
      "kernel export kernel_thread_has_deliverable failed",
    ],
    [
      "invalid deliverable-signal query result",
      (harness: RetryHarness) => {
        harness.kernelExports.kernel_thread_has_deliverable = vi.fn(
          () => 2,
        );
      },
      "kernel returned invalid deliverable-signal state 2",
    ],
    [
      "negative deliverable-signal query result",
      (harness: RetryHarness) => {
        harness.kernelExports.kernel_thread_has_deliverable = vi.fn(
          () => -1,
        );
      },
      "kernel returned invalid deliverable-signal state -1",
    ],
  ] as const)(
    "fails the kernel generation for a %s",
    async (_description, configure, expectedMessage) => {
      const harness = createRetryHarness(4);
      configure(harness);

      expect(() => {
        harness.worker.testAuthority.sendSignalForTest(
          harness.channel.pid,
          SIGUSR1,
        );
      }).toThrow(expectedMessage);
      await Promise.resolve();

      expect(harness.onKernelFatal).toHaveBeenCalledOnce();
    },
  );

  it.each([
    [
      "SYS_KILL missing signal-target selector",
      ABI_SYSCALLS.Kill,
      (harness: RetryHarness) => {
        harness.kernelExports.kernel_pick_signal_target_tid = undefined;
      },
      "kernel export kernel_pick_signal_target_tid failed",
    ],
    [
      "SYS_KILL negative signal-target selector",
      ABI_SYSCALLS.Kill,
      (harness: RetryHarness) => {
        harness.kernelExports.kernel_pick_signal_target_tid = vi.fn(
          () => -1,
        );
      },
      "kernel returned invalid signal target TID -1",
    ],
    [
      "SYS_TKILL missing deliverable-signal query",
      ABI_SYSCALLS.Tkill,
      (harness: RetryHarness) => {
        harness.kernelExports.kernel_thread_has_deliverable = undefined;
      },
      "kernel export kernel_thread_has_deliverable failed",
    ],
    [
      "SYS_TKILL invalid deliverable-signal query",
      ABI_SYSCALLS.Tkill,
      (harness: RetryHarness) => {
        harness.kernelExports.kernel_thread_has_deliverable = vi.fn(
          () => 2,
        );
      },
      "kernel returned invalid deliverable-signal state 2",
    ],
  ] as const)(
    "fails the kernel generation for guest %s",
    async (_description, syscall, configure, expectedMessage) => {
      const harness = createRetryHarness(4);
      configure(harness);
      writeRequest(harness, syscall, [
        BigInt(harness.channel.pid),
        BigInt(SIGUSR1),
      ]);
      harness.kernelExports.kernel_handle_channel = vi.fn(
        (rawPointer: number | bigint) => {
          publishKernelResult(kernelView(harness, rawPointer), 0, 0);
          return 0;
        },
      );

      expect(() => harness.worker.handleSyscall(harness.channel)).toThrow(
        expectedMessage,
      );
      await Promise.resolve();

      expect(harness.onKernelFatal).toHaveBeenCalledOnce();
      expect(requestStatus(harness)).toBe(CHANNEL_STATUS_PENDING);
    },
  );

  it.each(WIDTHS)(
    "%s interrupts only the exact caught-signal futex target",
    async (_name, pointerWidth) => {
      const harness = createRetryHarness(pointerWidth, {
        channelOffsets: [4 * 65_536, 6 * 65_536],
      });
      const [mainChannel, threadChannel] = harness.channels;
      const threadTid = 77;
      harness.worker.channelTids.set(
        `${threadChannel.pid}:${threadChannel.channelOffset}`,
        threadTid,
      );
      const mainFutex = 0x1000;
      const threadFutex = 0x1100;
      new Int32Array(harness.processMemory.buffer)[mainFutex / 4] = 0;
      new Int32Array(harness.processMemory.buffer)[threadFutex / 4] = 0;
      writeRequest(
        harness,
        ABI_SYSCALLS.Futex,
        [BigInt(mainFutex), 0n, 0n, 0n, 0n, 0n],
        mainChannel,
      );
      writeRequest(
        harness,
        ABI_SYSCALLS.Futex,
        [BigInt(threadFutex), 0n, 0n, 0n, 0n, 0n],
        threadChannel,
      );
      harness.kernelExports.kernel_pick_signal_target_tid = vi.fn(
        () => threadTid,
      );
      harness.kernelExports.kernel_thread_has_deliverable = vi.fn(() => 1);
      harness.kernelExports.kernel_handle_channel = vi.fn(
        (rawPointer: number | bigint) => {
          publishKernelResult(kernelView(harness, rawPointer), 0, 0);
          return 0;
        },
      );
      harness.kernelExports.kernel_dequeue_signal = vi.fn(
        (
          _pid: number,
          _tid: number,
          rawPointer: number | bigint,
        ) => writeKernelCaughtSignal(harness, rawPointer),
      );

      harness.worker.handleSyscall(mainChannel);
      harness.worker.handleSyscall(threadChannel);
      expect(harness.worker.pendingFutexWaits.has(mainChannel)).toBe(true);
      expect(harness.worker.pendingFutexWaits.has(threadChannel)).toBe(true);

      harness.worker.testAuthority.sendSignalForTest(
        harness.channel.pid,
        SIGUSR1,
      );
      await Promise.resolve();
      await Promise.resolve();

      expect(requestStatus(harness, mainChannel)).toBe(
        CHANNEL_STATUS_PENDING,
      );
      expect(requestResult(harness, threadChannel)).toEqual({
        status: CHANNEL_STATUS_COMPLETE,
        returnValue: -EINTR,
        errno: EINTR,
      });
      expect(harness.worker.pendingFutexWaits.has(mainChannel)).toBe(true);
      expect(harness.worker.pendingFutexWaits.has(threadChannel)).toBe(false);
      expect(
        harness.kernelExports.kernel_dequeue_signal,
      ).toHaveBeenCalledWith(
        harness.channel.pid,
        threadTid,
        expect.anything(),
        expect.any(Number),
      );
      const threadView = new DataView(
        harness.processMemory.buffer,
        threadChannel.channelOffset,
      );
      expect(threadView.getUint32(CH_SIG_SIGNUM, true)).toBe(SIGUSR1);
      expect(threadView.getUint32(CH_SIG_FLAGS, true)).toBe(SA_RESTART);

      harness.worker.removeChannel(
        mainChannel.pid,
        mainChannel.channelOffset,
      );
    },
  );

  it.each([
    ["wasm32 SYS_TKILL", 4, ABI_SYSCALLS.Tkill],
    ["wasm64 SYS_TKILL", 8, ABI_SYSCALLS.Tkill],
    ["wasm32 SYS_KILL", 4, ABI_SYSCALLS.Kill],
    ["wasm64 SYS_KILL", 8, ABI_SYSCALLS.Kill],
  ] as const)(
    "%s interrupts the exact pending futex after successful guest dispatch",
    async (_name, pointerWidth, signalSyscall) => {
      const harness = createRetryHarness(pointerWidth, {
        channelOffsets: [4 * 65_536, 6 * 65_536],
      });
      const [senderChannel, targetChannel] = harness.channels;
      const targetTid = 77;
      harness.worker.channelTids.set(
        `${targetChannel.pid}:${targetChannel.channelOffset}`,
        targetTid,
      );
      const futexPointer = 0x1000;
      new Int32Array(harness.processMemory.buffer)[futexPointer / 4] = 0;
      writeRequest(
        harness,
        ABI_SYSCALLS.Futex,
        [BigInt(futexPointer), 0n, 0n, 0n, 0n, 0n],
        targetChannel,
      );
      harness.kernelExports.kernel_pick_signal_target_tid = vi.fn(
        () => targetTid,
      );
      harness.kernelExports.kernel_thread_has_deliverable = vi.fn(
        (_pid: number, tid: number) => tid === targetTid ? 1 : 0,
      );
      harness.kernelExports.kernel_dequeue_signal = vi.fn(
        (
          _pid: number,
          tid: number,
          rawPointer: number | bigint,
        ) => tid === targetTid
          ? writeKernelCaughtSignal(harness, rawPointer)
          : 0,
      );
      harness.kernelExports.kernel_handle_channel = vi.fn(
        (rawPointer: number | bigint) => {
          publishKernelResult(kernelView(harness, rawPointer), 0, 0);
          return 0;
        },
      );

      harness.worker.handleSyscall(targetChannel);
      expect(harness.worker.pendingFutexWaits.has(targetChannel)).toBe(true);
      const signalArgs = signalSyscall === ABI_SYSCALLS.Tkill
        ? [BigInt(targetTid), BigInt(SIGUSR1)]
        : [BigInt(senderChannel.pid), BigInt(SIGUSR1)];
      writeRequest(harness, signalSyscall, signalArgs, senderChannel);
      harness.worker.handleSyscall(senderChannel);
      // Target publication enters only after the sender's kernel-entry token
      // is revoked; the signal dequeue itself still happened synchronously
      // under the authoritative sender transition.
      await Promise.resolve();
      await Promise.resolve();

      expect(requestResult(harness, senderChannel)).toEqual({
        status: CHANNEL_STATUS_COMPLETE,
        returnValue: 0,
        errno: 0,
      });
      expect(
        harness.kernelExports.kernel_thread_has_deliverable,
      ).toHaveBeenCalledWith(senderChannel.pid, targetTid);
      expect(requestResult(harness, targetChannel)).toEqual({
        status: CHANNEL_STATUS_COMPLETE,
        returnValue: -EINTR,
        errno: EINTR,
      });
      expect(harness.worker.pendingFutexWaits.has(targetChannel)).toBe(false);
      expect(
        harness.kernelExports.kernel_dequeue_signal,
      ).toHaveBeenCalledWith(
        senderChannel.pid,
        targetTid,
        expect.anything(),
        expect.any(Number),
      );
      const targetView = new DataView(
        harness.processMemory.buffer,
        targetChannel.channelOffset,
      );
      expect(targetView.getUint32(CH_SIG_SIGNUM, true)).toBe(SIGUSR1);
      expect(targetView.getUint32(CH_SIG_FLAGS, true)).toBe(SA_RESTART);
    },
  );

  it.each(WIDTHS)(
    "%s clears effective SA_RESTART when a finite futex wait is interrupted",
    async (_name, pointerWidth) => {
      const harness = createRetryHarness(pointerWidth);
      const futexPointer = 0x1000;
      const timeoutPointer = 0x1800;
      new Int32Array(harness.processMemory.buffer)[futexPointer / 4] = 0;
      const processView = new DataView(harness.processMemory.buffer);
      processView.setBigInt64(timeoutPointer, 10n, true);
      processView.setBigInt64(timeoutPointer + 8, 0n, true);
      writeRequest(harness, ABI_SYSCALLS.Futex, [
        BigInt(futexPointer),
        0n,
        0n,
        BigInt(timeoutPointer),
        0n,
        0n,
      ]);
      harness.kernelExports.kernel_handle_channel = vi.fn(
        (rawPointer: number | bigint) => {
          publishKernelResult(kernelView(harness, rawPointer), 0, 0);
          return 0;
        },
      );
      harness.kernelExports.kernel_dequeue_signal = vi.fn(
        (
          _pid: number,
          _tid: number,
          rawPointer: number | bigint,
        ) => writeKernelCaughtSignal(harness, rawPointer),
      );

      harness.worker.handleSyscall(harness.channel);
      expect(
        harness.worker.pendingFutexWaits.get(harness.channel)?.hasTimeout,
      ).toBe(true);
      harness.worker.testAuthority.sendSignalForTest(
        harness.channel.pid,
        SIGUSR1,
      );
      await Promise.resolve();
      await Promise.resolve();

      expect(requestResult(harness)).toEqual({
        status: CHANNEL_STATUS_COMPLETE,
        returnValue: -EINTR,
        errno: EINTR,
      });
      const channelView = new DataView(
        harness.processMemory.buffer,
        harness.channel.channelOffset,
      );
      expect(channelView.getUint32(CH_SIG_SIGNUM, true)).toBe(SIGUSR1);
      expect(channelView.getUint32(CH_SIG_FLAGS, true)).toBe(0);
    },
  );

  it.each(WIDTHS)(
    "%s consumes a pending cancel immediately before every host wait registry",
    (_name, pointerWidth) => {
      vi.useFakeTimers();

      const exactCleanupCalls = new WeakMap<RetryHarness, number>();
      const publishRetryOrExactCleanup = (
        harness: RetryHarness,
        rawPointer: number | bigint,
        retryReturnValue: number,
        retryErrno: number,
      ): number => {
        const view = kernelView(harness, rawPointer);
        const syscall = view.getUint32(CH_SYSCALL, true);
        if (syscall === ABI_SYSCALLS.ThreadCancel) {
          exactCleanupCalls.set(
            harness,
            (exactCleanupCalls.get(harness) ?? 0) + 1,
          );
          publishKernelResult(view, 0, 0);
        } else {
          publishKernelResult(view, retryReturnValue, retryErrno);
        }
        return 0;
      };
      const expectInterrupted = (
        harness: RetryHarness,
        label: string,
      ): void => {
        expect(requestResult(harness), label).toEqual({
          status: CHANNEL_STATUS_COMPLETE,
          returnValue: -EINTR,
          errno: EINTR,
        });
        expect(
          harness.worker.pendingCancels.has(harness.channel),
          `${label} pending marker`,
        ).toBe(false);
        expect(
          new DataView(
            harness.processMemory.buffer,
            harness.channel.channelOffset,
          ).getUint32(CH_REQUEST_FLAGS, true),
          `${label} request flags`,
        ).toBe(0);
        expect(
          exactCleanupCalls.get(harness),
          `${label} exact live-task cleanup`,
        ).toBe(1);
      };
      const armCancellationPoint = (
        harness: RetryHarness,
        syscall: number,
        args: readonly bigint[],
      ): void => {
        writeRequest(
          harness,
          syscall,
          args,
          harness.channel,
          true,
        );
        harness.worker.pendingCancels.add(harness.channel);
      };

      {
        const harness = createRetryHarness(pointerWidth);
        const requestPointer = 0x1000;
        const view = new DataView(harness.processMemory.buffer);
        view.setBigInt64(requestPointer, 5n, true);
        view.setBigInt64(requestPointer + 8, 0n, true);
        armCancellationPoint(harness, ABI_SYSCALLS.Nanosleep, [
          BigInt(requestPointer),
          0n,
        ]);
        harness.kernelExports.kernel_handle_channel = vi.fn(
          (rawPointer: number | bigint) =>
            publishRetryOrExactCleanup(harness, rawPointer, 0, 0),
        );

        harness.worker.handleSyscall(harness.channel);

        expectInterrupted(harness, "sleep");
        expect(harness.worker.pendingSleeps.has(harness.channel)).toBe(false);
      }

      {
        const harness = createRetryHarness(pointerWidth);
        const maskPointer = 0x1000;
        const infoPointer = 0x1200;
        const timeoutPointer = 0x1400;
        const view = new DataView(harness.processMemory.buffer);
        view.setBigUint64(maskPointer, 1n, true);
        view.setBigInt64(timeoutPointer, 5n, true);
        view.setBigInt64(timeoutPointer + 8, 0n, true);
        armCancellationPoint(harness, ABI_SYSCALLS.RtSigtimedwait, [
          BigInt(maskPointer),
          BigInt(infoPointer),
          BigInt(timeoutPointer),
          BigInt(SIGNAL_MASK_BYTES),
        ]);
        harness.kernelExports.kernel_handle_channel = vi.fn(
          (rawPointer: number | bigint) =>
            publishRetryOrExactCleanup(harness, rawPointer, -1, EAGAIN),
        );

        harness.worker.handleSyscall(harness.channel);

        expectInterrupted(harness, "sigtimedwait");
        const key =
          `${harness.channel.pid}:${harness.channel.channelOffset}`;
        expect(harness.worker.pendingSignalWaits.has(key)).toBe(false);
        expect(harness.worker.signalWaitDeadlines.has(key)).toBe(false);
      }

      {
        const harness = createRetryHarness(pointerWidth);
        armCancellationPoint(harness, ABI_SYSCALLS.Poll, [
          0n,
          0n,
          5_000n,
        ]);
        harness.kernelExports.kernel_handle_channel = vi.fn(
          (rawPointer: number | bigint) =>
            publishRetryOrExactCleanup(harness, rawPointer, -1, EAGAIN),
        );

        harness.worker.handleSyscall(harness.channel);

        expectInterrupted(harness, "poll");
        expect(
          harness.worker.pendingPollRetries.has(harness.channel),
        ).toBe(false);
      }

      {
        const harness = createRetryHarness(pointerWidth);
        const timeoutPointer = 0x1800;
        const view = new DataView(harness.processMemory.buffer);
        if (pointerWidth === 8) {
          view.setBigInt64(timeoutPointer, 5n, true);
          view.setBigInt64(timeoutPointer + 8, 0n, true);
        } else {
          view.setInt32(timeoutPointer, 5, true);
          view.setInt32(timeoutPointer + 4, 0, true);
        }
        armCancellationPoint(harness, ABI_SYSCALLS.Select, [
          0n,
          0n,
          0n,
          0n,
          BigInt(timeoutPointer),
        ]);
        harness.kernelExports.kernel_handle_channel = vi.fn(
          (rawPointer: number | bigint) =>
            publishRetryOrExactCleanup(harness, rawPointer, 0, 0),
        );

        harness.worker.handleSyscall(harness.channel);

        expectInterrupted(harness, "select");
        expect(
          harness.worker.pendingSelectRetries.has(harness.channel),
        ).toBe(false);
      }

      {
        const harness = createRetryHarness(pointerWidth);
        armCancellationPoint(
          harness,
          ABI_SYSCALLS.Flock,
          [7n, 2n],
        );
        harness.kernelExports.kernel_handle_channel = vi.fn(
          (rawPointer: number | bigint) =>
            publishRetryOrExactCleanup(harness, rawPointer, -1, EAGAIN),
        );

        harness.worker.handleSyscall(harness.channel);

        expectInterrupted(harness, "advisory lock");
        expect(
          harness.worker.pendingAdvisoryLockRetries.has(harness.channel),
        ).toBe(false);
      }

      {
        const harness = createRetryHarness(pointerWidth);
        const outputPointer = 0x1000;
        armCancellationPoint(harness, ABI_SYSCALLS.Read, [
          7n,
          BigInt(outputPointer),
          1n,
        ]);
        harness.kernelExports.kernel_get_fd_pipe_idx = vi.fn(() => 31);
        harness.kernelExports.kernel_handle_channel = vi.fn(
          (rawPointer: number | bigint) =>
            publishRetryOrExactCleanup(harness, rawPointer, -1, EAGAIN),
        );

        harness.worker.handleSyscall(harness.channel);

        expectInterrupted(harness, "pipe reader");
        expect(harness.worker.pendingPipeReaders.size).toBe(0);
      }

      {
        const harness = createRetryHarness(pointerWidth);
        const pathPointer = 0x1000;
        harness.processBytes.set(
          new TextEncoder().encode("/fifo/pre-cancel\0"),
          pathPointer,
        );
        armCancellationPoint(harness, ABI_SYSCALLS.Open, [
          BigInt(pathPointer),
          0n,
          0n,
        ]);
        const syscalls: number[] = [];
        harness.kernelExports.kernel_handle_channel = vi.fn(
          (rawPointer: number | bigint) => {
            const view = kernelView(harness, rawPointer);
            const syscall = view.getUint32(CH_SYSCALL, true);
            syscalls.push(syscall);
            if (syscall === ABI_SYSCALLS.ThreadCancel) {
              exactCleanupCalls.set(
                harness,
                (exactCleanupCalls.get(harness) ?? 0) + 1,
              );
            }
            publishKernelResult(
              view,
              syscall === ABI_SYSCALLS.Open ? -1 : 0,
              syscall === ABI_SYSCALLS.Open ? EAGAIN : 0,
            );
            return 0;
          },
        );

        harness.worker.handleSyscall(harness.channel);

        expectInterrupted(harness, "FIFO open");
        expect(
          harness.worker.pendingPollRetries.has(harness.channel),
        ).toBe(false);
        expect(syscalls).toEqual([
          ABI_SYSCALLS.Open,
          ABI_SYSCALLS.ThreadCancel,
        ]);
      }

      {
        const harness = createRetryHarness(pointerWidth);
        const futexPointer = 0x1000;
        new Int32Array(
          harness.processMemory.buffer,
        )[futexPointer >>> 2] = 0;
        armCancellationPoint(harness, ABI_SYSCALLS.Futex, [
          BigInt(futexPointer),
          0n,
          0n,
          0n,
          0n,
          0n,
        ]);
        harness.kernelExports.kernel_handle_channel = vi.fn(
          (rawPointer: number | bigint) =>
            publishRetryOrExactCleanup(harness, rawPointer, 0, 0),
        );

        harness.worker.handleSyscall(harness.channel);

        expectInterrupted(harness, "futex");
        expect(
          harness.worker.pendingFutexWaits.has(harness.channel),
        ).toBe(false);
      }
    },
  );


  it.each(WIDTHS)(
    "%s preserves disabled sleep and poll registrations while cancellation stays pending",
    async (_name, pointerWidth) => {
      vi.useFakeTimers();

      {
        const harness = createRetryHarness(pointerWidth, {
          channelOffsets: [4 * 65_536, 6 * 65_536],
        });
        const [callerChannel, targetChannel] = harness.channels;
        const targetTid = 81;
        harness.worker.channelTids.set(
          `${targetChannel.pid}:${targetChannel.channelOffset}`,
          targetTid,
        );
        const requestPointer = 0x1000;
        const processView = new DataView(harness.processMemory.buffer);
        processView.setBigInt64(requestPointer, 5n, true);
        processView.setBigInt64(requestPointer + 8, 0n, true);
        writeRequest(
          harness,
          ABI_SYSCALLS.Nanosleep,
          [BigInt(requestPointer), 0n],
          targetChannel,
          true,
          false,
        );
        harness.kernelExports.kernel_handle_channel = vi.fn(
          (rawPointer: number | bigint) => {
            publishKernelResult(kernelView(harness, rawPointer), 0, 0);
            return 0;
          },
        );

        harness.worker.handleSyscall(targetChannel);
        const originalSleep = harness.worker.pendingSleeps.get(targetChannel);
        expect(originalSleep).toMatchObject({
          cancellationPoint: true,
          cancellationWakeAllowed: false,
        });

        writeRequest(
          harness,
          ABI_SYSCALLS.ThreadCancel,
          [BigInt(targetTid)],
          callerChannel,
        );
        harness.worker.handleSyscall(callerChannel);

        expect(harness.worker.pendingSleeps.get(targetChannel)).toBe(
          originalSleep,
        );
        expect(harness.worker.pendingCancels.has(targetChannel)).toBe(true);
        expect(requestStatus(harness, targetChannel)).toBe(
          CHANNEL_STATUS_PENDING,
        );
        await vi.advanceTimersByTimeAsync(4_999);
        expect(requestStatus(harness, targetChannel)).toBe(
          CHANNEL_STATUS_PENDING,
        );
        await vi.advanceTimersByTimeAsync(1);
        expect(requestResult(harness, targetChannel)).toEqual({
          status: CHANNEL_STATUS_COMPLETE,
          returnValue: 0,
          errno: 0,
        });
        expect(harness.worker.pendingCancels.has(targetChannel)).toBe(true);
      }

      {
        const harness = createRetryHarness(pointerWidth, {
          channelOffsets: [4 * 65_536, 6 * 65_536],
        });
        const [callerChannel, targetChannel] = harness.channels;
        const targetTid = 82;
        harness.worker.channelTids.set(
          `${targetChannel.pid}:${targetChannel.channelOffset}`,
          targetTid,
        );
        writeRequest(
          harness,
          ABI_SYSCALLS.Poll,
          [0n, 0n, 5_000n],
          targetChannel,
          true,
          false,
        );
        let pollAttempts = 0;
        harness.kernelExports.kernel_handle_channel = vi.fn(
          (rawPointer: number | bigint) => {
            const view = kernelView(harness, rawPointer);
            const syscall = view.getUint32(CH_SYSCALL, true);
            if (syscall === ABI_SYSCALLS.Poll) {
              pollAttempts++;
              publishKernelResult(
                view,
                pollAttempts === 1 ? -1 : 0,
                pollAttempts === 1 ? EAGAIN : 0,
              );
            } else {
              publishKernelResult(view, 0, 0);
            }
            return 0;
          },
        );

        harness.worker.handleSyscall(targetChannel);
        const originalPoll =
          harness.worker.pendingPollRetries.get(targetChannel);
        expect(originalPoll).toMatchObject({
          cancellationPoint: true,
          cancellationWakeAllowed: false,
        });
        const originalDeadline = originalPoll.deadline;

        writeRequest(
          harness,
          ABI_SYSCALLS.ThreadCancel,
          [BigInt(targetTid)],
          callerChannel,
        );
        harness.worker.handleSyscall(callerChannel);

        expect(harness.worker.pendingPollRetries.get(targetChannel)).toBe(
          originalPoll,
        );
        expect(
          harness.worker.pendingPollRetries.get(targetChannel)?.deadline,
        ).toBe(originalDeadline);
        expect(harness.worker.pendingCancels.has(targetChannel)).toBe(true);
        expect(requestStatus(harness, targetChannel)).toBe(
          CHANNEL_STATUS_PENDING,
        );

        await vi.advanceTimersByTimeAsync(4_999);
        expect(requestStatus(harness, targetChannel)).toBe(
          CHANNEL_STATUS_PENDING,
        );
        await vi.advanceTimersByTimeAsync(1);
        await Promise.resolve();
        expect(requestResult(harness, targetChannel)).toEqual({
          status: CHANNEL_STATUS_COMPLETE,
          returnValue: 0,
          errno: 0,
        });
        expect(pollAttempts).toBe(2);
        expect(harness.worker.pendingCancels.has(targetChannel)).toBe(true);
      }
    },
  );

  it.each(WIDTHS)(
    "%s cancellation retires an exact sleep before mailbox reuse",
    async (_name, pointerWidth) => {
      vi.useFakeTimers();
      const harness = createRetryHarness(pointerWidth, {
        channelOffsets: [4 * 65_536, 6 * 65_536],
      });
      const [callerChannel, targetChannel] = harness.channels;
      const targetTid = 77;
      harness.worker.channelTids.set(
        `${targetChannel.pid}:${targetChannel.channelOffset}`,
        targetTid,
      );
      const requestPointer = 0x1000;
      const remainderPointer = 0x1100;
      const processView = new DataView(harness.processMemory.buffer);
      processView.setBigInt64(requestPointer, 5n, true);
      processView.setBigInt64(requestPointer + 8, 0n, true);
      harness.processBytes.fill(
        0x5a,
        remainderPointer,
        remainderPointer + 16,
      );
      writeRequest(
        harness,
        ABI_SYSCALLS.Nanosleep,
        [BigInt(requestPointer), BigInt(remainderPointer)],
        targetChannel,
        true,
      );
      const syscalls: number[] = [];
      harness.kernelExports.kernel_handle_channel = vi.fn(
        (rawPointer: number | bigint) => {
          const view = kernelView(harness, rawPointer);
          syscalls.push(view.getUint32(CH_SYSCALL, true));
          publishKernelResult(view, 0, 0);
          return 0;
        },
      );

      harness.worker.handleSyscall(targetChannel);
      expect(harness.worker.pendingSleeps.has(targetChannel)).toBe(true);

      writeRequest(
        harness,
        ABI_SYSCALLS.ThreadCancel,
        [BigInt(targetTid)],
        callerChannel,
      );
      harness.worker.handleSyscall(callerChannel);

      expect(requestResult(harness, callerChannel)).toEqual({
        status: CHANNEL_STATUS_COMPLETE,
        returnValue: 0,
        errno: 0,
      });
      expect(requestResult(harness, targetChannel)).toEqual({
        status: CHANNEL_STATUS_COMPLETE,
        returnValue: -EINTR,
        errno: EINTR,
      });
      expect(harness.worker.pendingSleeps.has(targetChannel)).toBe(false);
      expect(harness.worker.pendingCancels.has(targetChannel)).toBe(false);
      expect(
        Array.from(
          harness.processBytes.slice(
            remainderPointer,
            remainderPointer + 16,
          ),
        ),
      ).toEqual(new Array(16).fill(0x5a));
      expect(syscalls).toEqual([
        ABI_SYSCALLS.Nanosleep,
        ABI_SYSCALLS.ThreadCancel,
      ]);

      writeRequest(
        harness,
        ABI_SYSCALLS.Getpid,
        [],
        targetChannel,
      );
      await vi.advanceTimersByTimeAsync(5_000);
      await Promise.resolve();
      expect(requestStatus(harness, targetChannel)).toBe(
        CHANNEL_STATUS_PENDING,
      );
    },
  );

  it.each(WIDTHS)(
    "%s cancellation retires an exact sigtimedwait deadline before mailbox reuse",
    async (_name, pointerWidth) => {
      vi.useFakeTimers();
      const harness = createRetryHarness(pointerWidth, {
        channelOffsets: [4 * 65_536, 6 * 65_536],
      });
      const [callerChannel, targetChannel] = harness.channels;
      const targetTid = 78;
      harness.worker.channelTids.set(
        `${targetChannel.pid}:${targetChannel.channelOffset}`,
        targetTid,
      );
      const maskPointer = 0x1000;
      const infoPointer = 0x1200;
      const timeoutPointer = 0x1400;
      const processView = new DataView(harness.processMemory.buffer);
      processView.setBigUint64(maskPointer, 1n, true);
      processView.setBigInt64(timeoutPointer, 5n, true);
      processView.setBigInt64(timeoutPointer + 8, 0n, true);
      harness.processBytes.fill(0x6b, infoPointer, infoPointer + 128);
      writeRequest(
        harness,
        ABI_SYSCALLS.RtSigtimedwait,
        [
          BigInt(maskPointer),
          BigInt(infoPointer),
          BigInt(timeoutPointer),
          BigInt(SIGNAL_MASK_BYTES),
        ],
        targetChannel,
        true,
      );
      const syscalls: number[] = [];
      harness.kernelExports.kernel_handle_channel = vi.fn(
        (rawPointer: number | bigint) => {
          const view = kernelView(harness, rawPointer);
          const syscall = view.getUint32(CH_SYSCALL, true);
          syscalls.push(syscall);
          publishKernelResult(
            view,
            syscall === ABI_SYSCALLS.RtSigtimedwait ? -1 : 0,
            syscall === ABI_SYSCALLS.RtSigtimedwait ? EAGAIN : 0,
          );
          return 0;
        },
      );

      harness.worker.handleSyscall(targetChannel);
      const signalWaitKey =
        `${targetChannel.pid}:${targetChannel.channelOffset}`;
      expect(harness.worker.pendingSignalWaits.has(signalWaitKey)).toBe(true);
      expect(harness.worker.signalWaitDeadlines.has(signalWaitKey)).toBe(true);

      writeRequest(
        harness,
        ABI_SYSCALLS.ThreadCancel,
        [BigInt(targetTid)],
        callerChannel,
      );
      harness.worker.handleSyscall(callerChannel);

      expect(requestResult(harness, callerChannel)).toEqual({
        status: CHANNEL_STATUS_COMPLETE,
        returnValue: 0,
        errno: 0,
      });
      expect(requestResult(harness, targetChannel)).toEqual({
        status: CHANNEL_STATUS_COMPLETE,
        returnValue: -EINTR,
        errno: EINTR,
      });
      expect(harness.worker.pendingSignalWaits.has(signalWaitKey)).toBe(false);
      expect(harness.worker.signalWaitDeadlines.has(signalWaitKey)).toBe(false);
      expect(harness.worker.pendingCancels.has(targetChannel)).toBe(false);
      expect(
        Array.from(
          harness.processBytes.slice(infoPointer, infoPointer + 128),
        ),
      ).toEqual(new Array(128).fill(0x6b));
      expect(
        harness.worker.blockingRetrySnapshots.has(targetChannel),
      ).toBe(false);
      expect(syscalls).toEqual([
        ABI_SYSCALLS.RtSigtimedwait,
        ABI_SYSCALLS.ThreadCancel,
      ]);

      writeRequest(
        harness,
        ABI_SYSCALLS.Getpid,
        [],
        targetChannel,
      );
      await vi.advanceTimersByTimeAsync(5_000);
      await Promise.resolve();
      expect(requestStatus(harness, targetChannel)).toBe(
        CHANNEL_STATUS_PENDING,
      );
    },
  );

  it.each(WIDTHS)(
    "%s cancels an exact FIFO reservation before terminal retry-preflight EIO",
    async (_name, pointerWidth) => {
      vi.useFakeTimers();
      const harness = createRetryHarness(pointerWidth);
      const pathPointer = 0x1000;
      harness.processBytes.set(
        new TextEncoder().encode("/fifo/preflight\0"),
        pathPointer,
      );
      writeRequest(harness, ABI_SYSCALLS.Open, [BigInt(pathPointer), 0n, 0n]);

      const syscalls: number[] = [];
      harness.kernelExports.kernel_handle_channel = vi.fn(
        (rawPointer: number | bigint) => {
          const view = kernelView(harness, rawPointer);
          const syscall = view.getUint32(CH_SYSCALL, true);
          syscalls.push(syscall);
          publishKernelResult(
            view,
            syscall === ABI_SYSCALLS.Open ? -1 : 0,
            syscall === ABI_SYSCALLS.Open ? EAGAIN : 0,
          );
          return 0;
        },
      );

      harness.worker.handleSyscall(harness.channel);
      const snapshot = harness.worker.blockingRetrySnapshots.get(
        harness.channel,
      );
      const firstWrite = snapshot.dispatch.plannedScratchWrites[0];
      harness.worker.blockingRetrySnapshots.set(harness.channel, {
        ...snapshot,
        dispatch: {
          ...snapshot.dispatch,
          plannedScratchWrites: [{
            ...firstWrite,
            inputBytes: new Uint8Array(0),
          }],
        },
      });
      writeRequest(harness, ABI_SYSCALLS.Getpid, []);
      await vi.advanceTimersByTimeAsync(10);
      await Promise.resolve();

      expect(syscalls).toEqual([
        ABI_SYSCALLS.Open,
        ABI_SYSCALLS.ThreadCancel,
      ]);
      expect(requestResult(harness)).toEqual({
        status: CHANNEL_STATUS_COMPLETE,
        returnValue: -1,
        errno: 5,
      });
      expect(
        harness.worker.blockingRetrySnapshots.has(harness.channel),
      ).toBe(false);
    },
  );

  it.each(WIDTHS)(
    "%s fails the kernel generation when FIFO retry cleanup cannot be proven",
    async (_name, pointerWidth) => {
      vi.useFakeTimers();
      const harness = createRetryHarness(pointerWidth);
      const pathPointer = 0x1000;
      harness.processBytes.set(
        new TextEncoder().encode("/fifo/cleanup-failure\0"),
        pathPointer,
      );
      writeRequest(harness, ABI_SYSCALLS.Open, [BigInt(pathPointer), 0n, 0n]);

      const syscalls: number[] = [];
      harness.kernelExports.kernel_handle_channel = vi.fn(
        (rawPointer: number | bigint) => {
          const view = kernelView(harness, rawPointer);
          const syscall = view.getUint32(CH_SYSCALL, true);
          syscalls.push(syscall);
          publishKernelResult(
            view,
            -1,
            syscall === ABI_SYSCALLS.Open ? EAGAIN : 5,
          );
          return 0;
        },
      );

      harness.worker.handleSyscall(harness.channel);
      const snapshot = harness.worker.blockingRetrySnapshots.get(
        harness.channel,
      );
      const firstWrite = snapshot.dispatch.plannedScratchWrites[0];
      harness.worker.blockingRetrySnapshots.set(harness.channel, {
        ...snapshot,
        dispatch: {
          ...snapshot.dispatch,
          plannedScratchWrites: [{
            ...firstWrite,
            inputBytes: new Uint8Array(0),
          }],
        },
      });
      // A poisoned generation must not publish a synthetic EIO into whatever
      // request now occupies the guest-controlled mailbox.
      writeRequest(harness, ABI_SYSCALLS.Getpid, []);

      await expect(retryAfterDefaultDelay(harness)).rejects.toThrow(
        "kernel wait cleanup failed",
      );
      await Promise.resolve();

      expect(syscalls).toEqual([
        ABI_SYSCALLS.Open,
        ABI_SYSCALLS.ThreadCancel,
      ]);
      expect(harness.onKernelFatal).toHaveBeenCalledOnce();
      expect(requestStatus(harness)).toBe(CHANNEL_STATUS_PENDING);
      expect(
        harness.worker.blockingRetrySnapshots.has(harness.channel),
      ).toBe(false);
    },
  );

  it.each(WIDTHS)(
    "%s restores pselect6's temporary mask before terminal retry-preflight EIO",
    async (_name, pointerWidth) => {
      vi.useFakeTimers();
      const harness = createRetryHarness(pointerWidth);
      const readPointer = 0x1000;
      const timeoutPointer = 0x1800;
      const descriptorPointer = 0x1900;
      const maskPointer = 0x1a00;
      const processView = new DataView(harness.processMemory.buffer);
      harness.processBytes[readPointer] = 1;
      processView.setBigInt64(timeoutPointer, 1n, true);
      processView.setBigInt64(timeoutPointer + 8, 0n, true);
      processView.setBigUint64(maskPointer, 0x80n, true);
      if (pointerWidth === 8) {
        processView.setBigUint64(
          descriptorPointer,
          BigInt(maskPointer),
          true,
        );
        processView.setBigUint64(
          descriptorPointer + 8,
          BigInt(SIGNAL_MASK_BYTES),
          true,
        );
      } else {
        processView.setUint32(descriptorPointer, maskPointer, true);
        processView.setUint32(
          descriptorPointer + 4,
          SIGNAL_MASK_BYTES,
          true,
        );
      }
      writeRequest(harness, ABI_SYSCALLS.Pselect6, [
        8n,
        BigInt(readPointer),
        0n,
        0n,
        BigInt(timeoutPointer),
        BigInt(descriptorPointer),
      ]);

      const syscalls: number[] = [];
      harness.kernelExports.kernel_handle_channel = vi.fn(
        (rawPointer: number | bigint) => {
          const view = kernelView(harness, rawPointer);
          const syscall = view.getUint32(CH_SYSCALL, true);
          syscalls.push(syscall);
          publishKernelResult(
            view,
            syscall === ABI_SYSCALLS.Pselect6 ? -1 : 0,
            syscall === ABI_SYSCALLS.Pselect6 ? EAGAIN : 0,
          );
          return 0;
        },
      );

      harness.worker.handleSyscall(harness.channel);
      const snapshot = harness.worker.blockingRetrySnapshots.get(
        harness.channel,
      );
      harness.worker.blockingRetrySnapshots.set(harness.channel, {
        ...snapshot,
        readBytes: new Uint8Array(0),
      });
      await vi.advanceTimersByTimeAsync(50);
      await Promise.resolve();

      expect(syscalls).toEqual([
        ABI_SYSCALLS.Pselect6,
        ABI_SYSCALLS.ThreadCancel,
      ]);
      expect(requestResult(harness)).toEqual({
        status: CHANNEL_STATUS_COMPLETE,
        returnValue: -1,
        errno: 14,
      });
      expect(
        harness.worker.blockingRetrySnapshots.has(harness.channel),
      ).toBe(false);
    },
  );
});
