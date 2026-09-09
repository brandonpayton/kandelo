import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

import {
  type CentralizedKernelCallbacks,
  createCentralizedKernelWorkerTestDouble,
  CAPTURED_STDIO,
} from "../src/kernel-worker";
import { KernelReentrantEntryError } from "../src/kernel-entry-gate";
import type { PreparedExecLaunchRequest } from "../src/exec-target";
import { WASM_PAGE_SIZE } from "../src/constants";
import { writeForkContinuationAnchor } from "../src/fork-continuation";
import { FORK_SAVE_BUFFER_SIZE } from "../src/process-memory";
import {
  CHANNEL_STATUS_PENDING,
  CH_ARGS,
  CH_ARGS_COUNT,
  CH_ARG_SIZE,
  CH_STATUS,
  CH_SYSCALL,
  ABI_VERSION,
  HOST_ADAPTER_REQUIRED_KERNEL_EXPORTS,
  HOST_INTERCEPTED_SYSCALLS,
  WPK_FORK_LINKED_FRAME_POINTER_WIDTHS,
} from "../src/generated/abi";
import { installKernelWorkerTestScratch } from "./kernel-worker-test-scratch";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const WASM32_CONTINUATION_HEADER_SIZE =
  WPK_FORK_LINKED_FRAME_POINTER_WIDTHS.find(({ bytes }) => bytes === 4)!
    .chunkHeaderSize;
const TEST_FORK_CONTINUATION =
  2 * WASM_PAGE_SIZE + WASM32_CONTINUATION_HEADER_SIZE;
const UNTRACKED_THREAD_CHANNEL_OFFSET = 2 * WASM_PAGE_SIZE;
const preparedExecFixture = new Uint8Array(
  readFileSync(join(repoRoot, "local-binaries/programs/wasm32/exec-child.wasm")),
);

function publishMainForkContinuation(
  memory: WebAssembly.Memory,
  channelOffset: number,
): void {
  writeForkContinuationAnchor(
    memory,
    channelOffset - FORK_SAVE_BUFFER_SIZE,
    4,
    TEST_FORK_CONTINUATION,
  );
}

describe("kernel task-ID authority", () => {
  it("does not substitute the process leader for a pthread missing its TID mapping", () => {
    const parentPid = 77;
    const onFork = vi.fn();
    const onResolveSpawn = vi.fn();
    const onSpawn = vi.fn();
    const kernelForkProcess = vi.fn(() => 100);
    const forkHarness = createTaskAuthorityHarness({
      pid: parentPid,
      callbacks: { onFork },
      kernelExports: { kernel_fork_process: kernelForkProcess },
    });
    const expected =
      `No kernel-validated TID for non-main channel ${UNTRACKED_THREAD_CHANNEL_OFFSET} ` +
      `of process ${parentPid}`;

    expectEntryCause(
      () =>
        forkHarness.worker.testAuthority
          .dispatchUntrackedForkForTaskAuthorityTest(
            parentPid,
            forkHarness.channel,
            UNTRACKED_THREAD_CHANNEL_OFFSET,
            [0],
          ),
      expected,
    );
    expect(kernelForkProcess).not.toHaveBeenCalled();
    expect(onFork).not.toHaveBeenCalled();

    const spawnHarness = createTaskAuthorityHarness({
      pid: parentPid,
      callbacks: { onResolveSpawn, onSpawn },
    });
    const spawnThread = untrackedThreadChannel(
      parentPid,
      spawnHarness.processMemory,
    );
    expectEntryCause(
      () =>
        spawnHarness.worker.testAuthority
          .dispatchSpawnPreflightForTest(
            spawnThread,
            [0, 0, 0, 0, 0, 0],
          ),
      expected,
    );
    expect(onResolveSpawn).not.toHaveBeenCalled();
    expect(onSpawn).not.toHaveBeenCalled();
  });

  it("does not let an untracked pthread replace the leader's program image", () => {
    const pid = 77;
    const pathPtr = 16;
    const onExec = vi.fn(async () => 0);
    const execHarness = createTaskAuthorityHarness({
      pid,
      callbacks: { onExec },
    });
    new Uint8Array(execHarness.processMemory.buffer).set(
      new TextEncoder().encode("/bin/program\0"),
      pathPtr,
    );
    const expected =
      `No kernel-validated TID for non-main channel ${UNTRACKED_THREAD_CHANNEL_OFFSET} ` +
      `of process ${pid}`;

    expectEntryCause(
      () =>
        execHarness.worker.testAuthority
          .dispatchUntrackedExecForTaskAuthorityTest(
            pid,
            execHarness.channel,
            UNTRACKED_THREAD_CHANNEL_OFFSET,
            [pathPtr, 0, 0],
          ),
      expected,
    );

    const execveatHarness = createTaskAuthorityHarness({
      pid,
      callbacks: { onExec },
    });
    new Uint8Array(execveatHarness.processMemory.buffer).set(
      new TextEncoder().encode("/bin/program\0"),
      pathPtr,
    );
    expectEntryCause(
      () =>
        execveatHarness.worker.testAuthority
          .dispatchUntrackedExecveatForTaskAuthorityTest(
            pid,
            execveatHarness.channel,
            UNTRACKED_THREAD_CHANNEL_OFFSET,
            [-100, pathPtr, 0, 0, 0],
          ),
      expected,
    );
    expect(onExec).not.toHaveBeenCalled();
  });

  it("distinguishes relative dirfd exec from AT_EMPTY_PATH on a regular fd", async () => {
    const pid = 77;
    const fd = 17;
    const pathPtr = 16;
    const relativePath = new TextEncoder().encode("program\0");
    const onRelativeExec = vi.fn(async () => -2);
    const getDirectoryPath = vi.fn(() => -20);
    const relative = createTaskAuthorityHarness({
      pid,
      callbacks: { onExec: onRelativeExec },
      kernelExports: {
        kernel_get_dirfd_path: getDirectoryPath,
        kernel_get_fd_path: vi.fn(() => {
          throw new Error("relative execveat used a non-directory path getter");
        }),
      },
    });
    new Uint8Array(relative.processMemory.buffer).set(
      relativePath,
      pathPtr,
    );
    const relativeArgs = [fd, pathPtr, 0, 0, 0];
    writeChannelSyscall(
      relative.channel,
      HOST_INTERCEPTED_SYSCALLS.SYS_EXECVEAT,
      relativeArgs,
    );

    relative.worker.testAuthority.dispatchScratchBoundarySyscallForTest(
      relative.channel,
    );

    expect(getDirectoryPath).toHaveBeenCalledOnce();
    expect(onRelativeExec).not.toHaveBeenCalled();
    expect(relative.completeChannel).toHaveBeenCalledWith(
      relative.channel,
      HOST_INTERCEPTED_SYSCALLS.SYS_EXECVEAT,
      [...relativeArgs, 0],
      undefined,
      -1,
      20,
    );

    const executable = new TextEncoder().encode("/bin/program");
    let kernelBytes!: Uint8Array;
    const getRegularPath = vi.fn(
      (
        _pid: number,
        actualFd: number,
        pointer: number,
        capacity: number,
      ) => {
        expect(actualFd).toBe(fd);
        if (capacity === 0) return executable.byteLength;
        if (capacity < executable.byteLength) return -34;
        kernelBytes.set(executable, pointer);
        return executable.byteLength;
      },
    );
    const onEmptyPathExec = vi.fn(async (request: PreparedExecLaunchRequest) => {
      expect(request.pid).toBe(pid);
      expect(Reflect.has(request, "ownerPid")).toBe(false);
      expect(Reflect.has(request, "callerTid")).toBe(false);
      expect(Reflect.has(request, "target")).toBe(false);
      expect(Reflect.has(request, "commit")).toBe(false);
      expect(request.diagnosticPath).toBe("/bin/program");
      expect(request.argv).toEqual([]);
      expect(request.envp).toEqual([]);
      expect(new Uint8Array(request.targetBytes)).toEqual(preparedExecFixture);
      return -2;
    });
    const prepareTarget = vi.fn(() => 31);
    const emptyPath = createTaskAuthorityHarness({
      pid,
      callbacks: { onExec: onEmptyPathExec },
      kernelExports: {
        kernel_get_dirfd_path: vi.fn(() => {
          throw new Error("AT_EMPTY_PATH used a directory-only path getter");
        }),
        kernel_get_fd_path: getRegularPath,
        kernel_exec_target_prepare: prepareTarget,
        kernel_exec_target_size: vi.fn(() => BigInt(preparedExecFixture.byteLength)),
        kernel_exec_target_read: vi.fn((
          _ownerPid: number,
          _target: number,
          offsetLo: number,
          offsetHi: number,
          destination: number,
          capacity: number,
        ) => {
          const offset = Number(
            (BigInt(offsetHi >>> 0) << 32n) | BigInt(offsetLo >>> 0),
          );
          const count = Math.min(
            capacity,
            preparedExecFixture.byteLength - offset,
          );
          new Uint8Array(
            emptyPath.kernelMemory.buffer,
            destination,
            count,
          ).set(preparedExecFixture.subarray(offset, offset + count));
          return count;
        }),
        kernel_exec_target_cancel: vi.fn(() => 0),
        // Kernel-owned shebang decode (Phase 6 D3): a real wasm target is not
        // a script, so the export reports "not a script" with 0.
        kernel_exec_target_shebang: vi.fn(() => 0),
      },
    });
    kernelBytes = new Uint8Array(emptyPath.kernelMemory.buffer);
    new Uint8Array(emptyPath.processMemory.buffer)[pathPtr] = 0;
    const emptyPathArgs = [fd, pathPtr, 0, 0, 0x1000];
    writeChannelSyscall(
      emptyPath.channel,
      HOST_INTERCEPTED_SYSCALLS.SYS_EXECVEAT,
      emptyPathArgs,
    );

    emptyPath.worker.testAuthority.dispatchScratchBoundarySyscallForTest(
      emptyPath.channel,
    );
    await drainTaskAuthorityGate();
    await vi.waitFor(() => expect(onEmptyPathExec).toHaveBeenCalledOnce());

    expect(getRegularPath).toHaveBeenCalledOnce();
    expect(prepareTarget).toHaveBeenCalledWith(
      pid,
      pid,
      fd,
      emptyPath.scratchPointer,
      0,
      0x1000,
    );
  });

  it("rejects a zero fork result before launching a child Worker", () => {
    const parentPid = 77;
    const onFork = vi.fn();
    const kernelForkProcess = vi.fn(() => 0);
    const harness = createTaskAuthorityHarness({
      pid: parentPid,
      callbacks: { onFork },
      kernelExports: { kernel_fork_process: kernelForkProcess },
    });
    publishMainForkContinuation(
      harness.processMemory,
      harness.channel.channelOffset,
    );
    const origArgs = [0, 0, 0, 0, 0, 0];
    writeChannelSyscall(
      harness.channel,
      HOST_INTERCEPTED_SYSCALLS.SYS_FORK,
      origArgs,
    );

    harness.worker.testAuthority.dispatchScratchBoundarySyscallForTest(
      harness.channel,
    );

    expect(onFork).not.toHaveBeenCalled();
    expect(harness.completeChannel).toHaveBeenCalledWith(
      harness.channel,
      HOST_INTERCEPTED_SYSCALLS.SYS_FORK,
      origArgs,
      undefined,
      -1,
      5,
    );
  });

  it("rejects zero before a host callback can attach an unallocated spawn child", () => {
    const parentPid = 77;
    const onSpawn = vi.fn(async () => 0);
    const kernelSpawnProcess = vi.fn(() => 0);
    const harness = createTaskAuthorityHarness({
      pid: parentPid,
      callbacks: { onSpawn },
      kernelExports: { kernel_spawn_process: kernelSpawnProcess },
    });
    const origArgs = [1, 2, 3, 4, 5, 0];

    harness.worker.testAuthority.dispatchSpawnAfterResolveForTest({
      channel: harness.channel,
      origArgs,
      parentPid,
      callerTid: parentPid,
      pidOutPtr: 5,
      blobBytes: new Uint8Array([1]),
      blobLen: 1,
      program: {} as never,
      envp: [],
    });

    expect(kernelSpawnProcess).toHaveBeenCalledWith(
      parentPid,
      parentPid,
      harness.scratchPointer,
      1,
    );
    expect(onSpawn).not.toHaveBeenCalled();
    expect(harness.completeChannel).toHaveBeenCalledWith(
      harness.channel,
      HOST_INTERCEPTED_SYSCALLS.SYS_SPAWN,
      origArgs,
      undefined,
      -1,
      5,
    );
  });

  it("uses the PID returned by Rust while fork registration is pending", async () => {
    const parentPid = 77;
    const childPid = 347;
    let finishForkRegistration!: (offsets: number[]) => void;
    const forkRegistration = new Promise<number[]>((resolve) => {
      finishForkRegistration = resolve;
    });
    const onFork = vi.fn(() => forkRegistration);
    const kernelForkProcess = vi.fn(() => childPid);
    const harness = createTaskAuthorityHarness({
      pid: parentPid,
      callbacks: { onFork },
      kernelExports: {
        kernel_fork_process: kernelForkProcess,
        kernel_clear_fork_child: vi.fn(() => 0),
      },
    });
    publishMainForkContinuation(
      harness.processMemory,
      harness.channel.channelOffset,
    );
    const origArgs = [0, 0, 0, 0, 0, 0];
    writeChannelSyscall(
      harness.channel,
      HOST_INTERCEPTED_SYSCALLS.SYS_FORK,
      origArgs,
    );

    harness.worker.testAuthority.dispatchScratchBoundarySyscallForTest(
      harness.channel,
    );
    await Promise.resolve();

    expect(kernelForkProcess).toHaveBeenCalledOnce();
    expect(kernelForkProcess).toHaveBeenCalledWith(parentPid, parentPid, 0);
    expect(onFork).toHaveBeenCalledWith({
      parentPid,
      childPid,
      mode: 0,
      parentMemory: harness.processMemory,
      continuation: {
        kind: "main",
        forkBufAddr: TEST_FORK_CONTINUATION,
      },
    });
    expect(harness.completeChannel).not.toHaveBeenCalled();
    expect("allocateTopLevelSpawnPid" in harness.worker).toBe(false);

    finishForkRegistration([WASM_PAGE_SIZE]);
    await forkRegistration;
    await drainTaskAuthorityGate();
    expect(harness.completeChannel).toHaveBeenCalledWith(
      harness.channel,
      HOST_INTERCEPTED_SYSCALLS.SYS_FORK,
      origArgs,
      undefined,
      childPid,
      0,
    );
  });

  it("returns the kernel-assigned PID for top-level process creation", () => {
    const createProcess = vi.fn(() => 912);
    const harness = createTaskAuthorityHarness({
      kernelExports: {
        kernel_create_process_with_stdio: createProcess,
      },
    });

    expect(harness.worker.createProcess(CAPTURED_STDIO)).toBe(912);
    expect(createProcess).toHaveBeenCalledWith(0, 0, 0);
  });

  it("accepts ESRCH as idempotent success when Rust already removed a process", () => {
    const removeProcess = vi.fn(() => -3);
    const drainWakeups = vi.fn(() => 0);
    const harness = createTaskAuthorityHarness({
      kernelExports: {
        kernel_remove_process: removeProcess,
        kernel_drain_wakeup_events: drainWakeups,
      },
    });

    expect(() =>
      harness.worker.removeProcessFromKernelTable(912)
    ).not.toThrow();
    expect(removeProcess).toHaveBeenCalledWith(912);
    expect(drainWakeups).toHaveBeenCalledOnce();
  });

  it("fails closed when Rust rejects process removal for any other reason", () => {
    const removeProcess = vi.fn(() => -5);
    const drainWakeups = vi.fn(() => 0);
    const harness = createTaskAuthorityHarness({
      kernelExports: {
        kernel_remove_process: removeProcess,
        kernel_drain_wakeup_events: drainWakeups,
      },
    });

    expectEntryCause(
      () => harness.worker.removeProcessFromKernelTable(913),
      "Kernel could not remove process 913: errno 5",
    );
    expect(removeProcess).toHaveBeenCalledWith(913);
    expect(drainWakeups).not.toHaveBeenCalled();
  });

  it.each(untrackedTaskAuthorityOperations)(
    "does not enqueue reentrant $name test dispatch",
    async ({ args, invoke }) => {
      const callerRead = vi.fn();
      let nestedError: unknown;
      let invokeNested = (): void => {
        throw new Error("nested test dispatch was not installed");
      };
      const createProcess = vi.fn(() => {
        try {
          invokeNested();
        } catch (error) {
          nestedError = error;
        }
        return 912;
      });
      const harness = createTaskAuthorityHarness({
        callbacks: {
          onExec: vi.fn(async () => 0),
          onFork: vi.fn(async () => [WASM_PAGE_SIZE]),
        },
        kernelExports: {
          kernel_create_process_with_stdio: createProcess,
          kernel_fork_process: vi.fn(() => 347),
        },
      });
      const hostileRegistrationWitness = new Proxy(
        harness.channel,
        {
          get(target, property, receiver) {
            callerRead(`channel:${String(property)}`);
            return Reflect.get(target, property, receiver);
          },
        },
      );
      const hostileArgs = new Proxy([...args], {
        get(target, property, receiver) {
          callerRead(`args:${String(property)}`);
          return Reflect.get(target, property, receiver);
        },
      });
      invokeNested = () =>
        invoke(
          harness.worker,
          77,
          hostileRegistrationWitness,
          UNTRACKED_THREAD_CHANNEL_OFFSET,
          hostileArgs,
        );

      expect(harness.worker.createProcess(CAPTURED_STDIO)).toBe(912);
      expect(nestedError).toBeInstanceOf(KernelReentrantEntryError);
      expect(callerRead).not.toHaveBeenCalled();
      await drainTaskAuthorityGate();
      expect(callerRead).not.toHaveBeenCalled();
      expect(createProcess).toHaveBeenCalledOnce();
    },
  );

  it.each(untrackedTaskAuthorityOperations)(
    "rejects a cross-generation channel for $name test dispatch",
    async ({ args, invoke }) => {
      const onExec = vi.fn(async () => 0);
      const onFork = vi.fn(async () => [WASM_PAGE_SIZE]);
      const forkProcess = vi.fn(() => 347);
      const createProcess = vi.fn(() => 912);
      const harness = createTaskAuthorityHarness({
        callbacks: { onExec, onFork },
        kernelExports: {
          kernel_create_process_with_stdio: createProcess,
          kernel_fork_process: forkProcess,
        },
      });
      const staleRegistrationWitness = harness.channel;
      const replacementMemory = new WebAssembly.Memory({
        initial: 4,
        maximum: 4,
        shared: true,
      });
      harness.worker.testAuthority
        .replaceProcessRegistrationForLifecycleTest({
          pid: 77,
          memory: replacementMemory,
          channelOffsets: [WASM_PAGE_SIZE],
        });

      expect(() =>
        invoke(
          harness.worker,
          77,
          staleRegistrationWitness,
          UNTRACKED_THREAD_CHANNEL_OFFSET,
          [...args],
        )
      ).toThrow(/current process Memory generation/);
      expect(onExec).not.toHaveBeenCalled();
      expect(onFork).not.toHaveBeenCalled();
      expect(forkProcess).not.toHaveBeenCalled();
      expect(harness.completeChannel).not.toHaveBeenCalled();
      await drainTaskAuthorityGate();
      expect(harness.worker.createProcess(CAPTURED_STDIO)).toBe(912);
      expect(createProcess).toHaveBeenCalledOnce();
    },
  );

  it("routes Node and browser top-level spawns through Rust creation", () => {
    const nodeEntry = readFileSync(
      join(repoRoot, "host", "src", "node-kernel-worker-entry.ts"),
      "utf8",
    );
    const browserEntry = readFileSync(
      join(repoRoot, "host", "src", "browser-kernel-worker-entry.ts"),
      "utf8",
    );
    const browserProtocol = readFileSync(
      join(repoRoot, "host", "src", "browser-kernel-protocol.ts"),
      "utf8",
    );
    const spawnMessage = browserProtocol.match(
      /export interface SpawnMessage \{[\s\S]*?\n\}/,
    )?.[0];

    expect(nodeEntry).toContain("kernelWorker.createProcess(");
    expect(browserEntry).toContain("kernelWorker.createProcess(");
    expect(nodeEntry).not.toMatch(/next(?:Child|Spawn)Pid/);
    expect(browserEntry).not.toMatch(/next(?:Child|Spawn)Pid/);
    expect(spawnMessage).toBeDefined();
    expect(spawnMessage).not.toMatch(/\bpid\??:/);
  });

  it("requires every kernel child-allocation path at startup and artifact validation", () => {
    const requiredAuthorityExports = [
      "kernel_exec_target_prepare",
      "kernel_spawn_exec_target_prepare",
      "kernel_exec_commit",
      "kernel_spawn_exec_commit",
      "kernel_publish_spawn_child",
      "kernel_fork_process",
      "kernel_spawn_process",
      "kernel_thread_exit",
    ];
    for (const exportName of requiredAuthorityExports) {
      expect(HOST_ADAPTER_REQUIRED_KERNEL_EXPORTS).toContain(exportName);
    }

    const resolverWrapper = readFileSync(
      join(repoRoot, "scripts", "resolve-binary.sh"),
      "utf8",
    );
    // The shell entrypoint deliberately delegates artifact policy to the
    // generated standalone resolver. Check that boundary and inspect the
    // executable bundle instead of requiring a second hard-coded export list.
    expect(resolverWrapper).toContain(
      'exec node "$script_dir/resolve-binary.bundle.mjs" "$1"',
    );

    const artifactGuards = [
      "run.sh",
      "scripts/resolve-binary.bundle.mjs",
      "packages/registry/kernel/build-kernel.sh",
    ].map((path) => readFileSync(join(repoRoot, path), "utf8"));
    for (const source of artifactGuards) {
      for (const exportName of requiredAuthorityExports) {
        expect(source).toContain(exportName);
      }
    }
  });
});

type TaskAuthorityWorker = ReturnType<
  typeof createCentralizedKernelWorkerTestDouble
>;
type TaskAuthorityChannel = ReturnType<
  TaskAuthorityWorker["testAuthority"][
    "replaceProcessRegistrationForLifecycleTest"
  ]
>[number];

interface UntrackedTaskAuthorityOperation {
  readonly name: string;
  readonly args: readonly number[];
  readonly invoke: (
    worker: TaskAuthorityWorker,
    pid: number,
    registrationWitness: TaskAuthorityChannel,
    channelOffset: number,
    args: number[],
  ) => void;
}

const untrackedTaskAuthorityOperations:
  readonly UntrackedTaskAuthorityOperation[] = [
    {
      name: "fork",
      args: [0],
      invoke: (
        worker,
        pid,
        registrationWitness,
        channelOffset,
        args,
      ) =>
        worker.testAuthority.dispatchUntrackedForkForTaskAuthorityTest(
          pid,
          registrationWitness,
          channelOffset,
          args,
        ),
    },
    {
      name: "exec",
      args: [16, 0, 0],
      invoke: (
        worker,
        pid,
        registrationWitness,
        channelOffset,
        args,
      ) =>
        worker.testAuthority.dispatchUntrackedExecForTaskAuthorityTest(
          pid,
          registrationWitness,
          channelOffset,
          args,
        ),
    },
    {
      name: "execveat",
      args: [-100, 16, 0, 0, 0],
      invoke: (
        worker,
        pid,
        registrationWitness,
        channelOffset,
        args,
      ) =>
        worker.testAuthority.dispatchUntrackedExecveatForTaskAuthorityTest(
          pid,
          registrationWitness,
          channelOffset,
          args,
        ),
    },
  ];

interface TaskAuthorityHarnessOptions {
  readonly pid?: number;
  readonly callbacks?: CentralizedKernelCallbacks;
  readonly kernelExports?: Readonly<Record<string, unknown>>;
  readonly processMemory?: WebAssembly.Memory;
}

interface TaskAuthorityHarness {
  readonly worker: TaskAuthorityWorker;
  readonly kernelMemory: WebAssembly.Memory;
  readonly processMemory: WebAssembly.Memory;
  readonly channel: TaskAuthorityChannel;
  readonly completeChannel: ReturnType<typeof vi.fn>;
  readonly scratchPointer: number;
}

function createTaskAuthorityHarness(
  options: TaskAuthorityHarnessOptions = {},
): TaskAuthorityHarness {
  const pid = options.pid ?? 77;
  const processMemory = options.processMemory
    ?? new WebAssembly.Memory({
      initial: 4,
      maximum: 4,
      shared: true,
    });
  const kernelMemory = new WebAssembly.Memory({
    initial: 2,
    maximum: 2,
  });
  const implementations: Record<string, unknown> = {
    kernel_drain_wakeup_events: vi.fn(() => 0),
    kernel_get_parent_pid: vi.fn(() => -1),
    kernel_get_process_exit_signal: vi.fn(() => -1),
    kernel_mark_process_signaled: vi.fn(() => 0),
    kernel_set_current_tid: vi.fn(() => 0),
    ...(options.kernelExports ?? {}),
  };
  const worker = createCentralizedKernelWorkerTestDouble({
    callbacks: options.callbacks,
  });
  Reflect.set(worker, "kernelAbiVersion", ABI_VERSION);
  const scratchPointer = installKernelWorkerTestScratch(
    worker,
    kernelMemory,
    128,
    4,
    {
      kernelExports: implementations,
      kernelExportNames: Object.keys(implementations),
    },
  );
  const [channel] =
    worker.testAuthority.replaceProcessRegistrationForLifecycleTest({
      pid,
      memory: processMemory,
      channelOffsets: [WASM_PAGE_SIZE],
    });
  if (channel === undefined) {
    throw new Error("task-authority harness did not register a channel");
  }
  const completeChannel = vi.fn();
  worker.testAuthority.configureScratchBoundaryHooksForTest({
    completeChannel,
  });
  return {
    worker,
    kernelMemory,
    processMemory,
    channel,
    completeChannel,
    scratchPointer,
  };
}

function untrackedThreadChannel(
  pid: number,
  memory: WebAssembly.Memory,
): TaskAuthorityChannel {
  const channelOffset = UNTRACKED_THREAD_CHANNEL_OFFSET;
  return {
    pid,
    memory,
    channelOffset,
    i32View: new Int32Array(memory.buffer, channelOffset),
    consecutiveSyscalls: 0,
  };
}

function writeChannelSyscall(
  channel: TaskAuthorityChannel,
  syscall: number,
  args: readonly number[],
): void {
  Atomics.store(
    channel.i32View,
    CH_STATUS / Int32Array.BYTES_PER_ELEMENT,
    CHANNEL_STATUS_PENDING,
  );
  const view = new DataView(
    channel.memory.buffer,
    channel.channelOffset,
  );
  view.setUint32(CH_SYSCALL, syscall, true);
  for (let index = 0; index < CH_ARGS_COUNT; index++) {
    view.setBigInt64(
      CH_ARGS + index * CH_ARG_SIZE,
      BigInt(args[index] ?? 0),
      true,
    );
  }
}

function expectEntryCause(
  operation: () => unknown,
  expectedMessage: string,
): void {
  let thrown: unknown;
  try {
    operation();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(Error);
  const cause = (thrown as { cause?: unknown }).cause;
  expect(cause).toBeInstanceOf(Error);
  expect((cause as Error).message).toContain(expectedMessage);
}

async function drainTaskAuthorityGate(): Promise<void> {
  for (let turn = 0; turn < 24; turn++) {
    await Promise.resolve();
  }
}
