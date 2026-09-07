import { describe, expect, it, vi } from "vitest";
import {
  ABI_SYSCALLS,
  CH_ARGS,
  CH_ARG_SIZE,
  CH_ERRNO,
  CH_RETURN,
  CH_STATUS,
  CH_SYSCALL,
  CHANNEL_STATUS_COMPLETE,
  CHANNEL_STATUS_PENDING,
} from "../src/generated/abi";
import {
  createWasmPosixKernelTestHarness,
} from "../src/kernel";
import {
  createCentralizedKernelWorkerTestDouble,
} from "../src/kernel-worker";
import { installKernelWorkerTestScratch } from "./kernel-worker-test-scratch";

const MAP_SHARED = 1;
const MAP_PRIVATE = 2;
const MAP_FIXED = 0x10;
const MAP_ANONYMOUS = 0x20;
const PROT_READ = 1;
const PROT_WRITE = 2;
const REGULAR_MODE = 0o100644;
const SYS_COPY_FILE_RANGE = 290;
const SYS_SPLICE = 291;

function memory(): WebAssembly.Memory {
  return new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });
}

function createFileHarness() {
  const pids = [71, 72, 73];
  const memories = new Map(pids.map((pid) => [pid, memory()]));
  const channels = new Map(pids.map((pid) => {
    const processMemory = memories.get(pid)!;
    return [pid, {
      pid,
      memory: processMemory,
      channelOffset: 0,
      i32View: new Int32Array(processMemory.buffer, 0, 1),
      consecutiveSyscalls: 0,
    }];
  }));
  const storage = new Uint8Array(16 * 1024);
  storage.set(Array.from({ length: 64 }, (_, i) => i + 1));
  let logicalSize = storage.length;
  const fdHostHandles = new Map<number, number>([[4, 100], [9, 101]]);
  let nextHandle = 102;
  const liveHandles = new Set<number>(fdHostHandles.values());
  const open = vi.fn((_path: string, _flags: number) => {
    const handle = nextHandle++;
    liveHandles.add(handle);
    return handle;
  });
  const close = vi.fn((handle: number) => {
    liveHandles.delete(handle);
    return 0;
  });
  const io = {
    open,
    close,
    read: vi.fn((handle: number, out: Uint8Array, offset: number | null, len: number) => {
      if (!liveHandles.has(handle)) throw new Error("closed stable handle");
      const start = offset ?? 0;
      if (start >= logicalSize) return 0;
      const count = Math.min(len, logicalSize - start);
      out.set(storage.subarray(start, start + count));
      return count;
    }),
    write: vi.fn((handle: number, input: Uint8Array, offset: number | null, len: number) => {
      if (!liveHandles.has(handle)) throw new Error("closed stable handle");
      const start = offset ?? 0;
      const count = Math.min(len, storage.length - start);
      storage.set(input.subarray(0, count), start);
      logicalSize = Math.max(logicalSize, start + count);
      return count;
    }),
    fstat: vi.fn((handle: number) => {
      if (!liveHandles.has(handle)) throw new Error("closed stable handle");
      return {
        dev: 7,
        ino: 99,
        mode: REGULAR_MODE,
        nlink: 1,
        uid: 0,
        gid: 0,
        size: logicalSize,
        atimeMs: 0,
        mtimeMs: 0,
        ctimeMs: 0,
      };
    }),
    stat: vi.fn((_path: string) => ({
      dev: 7,
      ino: 99,
      mode: REGULAR_MODE,
      nlink: 1,
      uid: 0,
      gid: 0,
      size: logicalSize,
      atimeMs: 0,
      mtimeMs: 0,
      ctimeMs: 0,
    })),
    fileIdentity: vi.fn((_path: string, dev: bigint, ino: bigint) =>
      ino === 0n ? null : `test:${dev}:${ino}`),
    fileHandleIdentity: vi.fn((_handle: number, dev: bigint, ino: bigint) =>
      ino === 0n ? null : `test:${dev}:${ino}`),
  };
  const kernel = createWasmPosixKernelTestHarness({
    config: {
      maxWorkers: 4,
      dataBufferSize: 65536,
      useSharedMemory: true,
    },
    io: io as any,
    initialized: false,
  });
  const retainHostFileHandle = vi.spyOn(kernel, "retainHostFileHandle");
  const releaseHostFileHandle = vi.spyOn(kernel, "releaseHostFileHandle");
  const fdIdentity = new Map<number, string>([
    [4, "/dev/shm/php-cache"],
    [9, "/dev/shm/php-cache"],
  ]);
  const onFork = vi.fn();
  const processes = new Map(pids.map((pid) => [pid, {
    pid,
    memory: memories.get(pid)!,
    channels: [channels.get(pid)!],
  }]));
  const fdSupportsMmapWriteback = vi.fn(() => true);
  const getFdAccessModeForSharedMapping = vi.fn(
    () => ({ kind: "ok" as const, value: 2 }),
  );
  // Kernel-owned (tmpfs/memfd) fd-writeback bridge: dup the guest fd into a
  // stable descriptor (deterministic fd+1000 here) and record closes.
  const dupWritebackFd = vi.fn((_pid: number, fd: number) => fd + 1000);
  const closeWritebackFd = vi.fn();
  const getFdStatForSharedMapping = vi.fn(
    (_channel: unknown, fd: number) => {
      return fdHostHandles.has(fd)
        ? {
            kind: "ok" as const,
            value: {
              dev: 7n,
              ino: 99n,
              size: logicalSize,
              mode: REGULAR_MODE,
              hostHandle: fdHostHandles.get(fd)!,
            },
          }
        : { kind: "error" as const, errno: 9 };
    },
  );
  const getFdPathForSharedMapping = vi.fn(
    (_channel: unknown, fd: number) =>
      fdIdentity.has(fd)
        ? { kind: "ok" as const, value: fdIdentity.get(fd)! }
        : { kind: "error" as const, errno: 9 },
  );
  const kw = Object.assign(createCentralizedKernelWorkerTestDouble({
    io: io as any,
    callbacks: { onFork },
  }), {
    processes,
    activeChannels: Array.from(channels.values()),
    channelTids: new Map(),
    sharedMappings: new Map(),
    anonymousSharedBackings: new Map(),
    sharedMmapBackings: new Map(),
    sharedMmapFdCache: new Map(),
    shmMappings: new Map(),
    shmSegmentVersions: new Map(),
  });
  kw.testAuthority.replaceKernelForScratchBoundaryTest(kernel);
  kw.testAuthority.configureScratchBoundaryHooksForTest({
    fdSupportsMmapWriteback,
    getFdAccessModeForSharedMapping,
    getFdStatForSharedMapping,
    getFdPathForSharedMapping,
    dupWritebackFd,
    closeWritebackFd,
  });
  installKernelWorkerTestScratch(
    kw as unknown as Record<string, unknown>,
    new WebAssembly.Memory({ initial: 2, maximum: 2 }),
    128,
    4,
    { kernelExportNames: [] },
  );

  const mapResult = (
    pid: number,
    fd: number,
    addr: number,
    len = 4096,
    prot = PROT_WRITE,
  ) =>
    (kw as any).mapSharedMmapFromFile(
      channels.get(pid),
      addr,
      [0, len, prot, MAP_SHARED, fd, 0],
      0n,
    ) as { kind: "mapped" | "unsupported" | "error"; errno?: number };
  const map = (
    pid: number,
    fd: number,
    addr: number,
    len = 4096,
    prot = PROT_WRITE,
  ) => mapResult(pid, fd, addr, len, prot).kind === "mapped";

  return {
    channels,
    close,
    dupWritebackFd,
    closeWritebackFd,
    fdHostHandles,
    fdIdentity,
    fdSupportsMmapWriteback,
    getFdAccessModeForSharedMapping,
    getFdPathForSharedMapping,
    getFdStatForSharedMapping,
    io,
    kernel,
    kw,
    logicalSize: () => logicalSize,
    map,
    mapResult,
    memories,
    onFork,
    open,
    pids,
    releaseHostFileHandle,
    retainHostFileHandle,
    setLogicalSize: (size: number) => { logicalSize = size; },
    storage,
  };
}

type FileHarness = ReturnType<typeof createFileHarness>;

function configureKernelSyscallHarness(h: FileHarness, pid: number) {
  const kernelHandle = vi.fn();
  const completeChannel = vi.fn();
  Object.assign(h.kw as any, {
    config: {},
    syscallRing: new Map(),
    syscallTraceEnabled: false,
  });
  h.kw.testAuthority.configureScratchBoundaryHooksForTest({
    synchronizeSharedMemoryForBoundary: () => {},
    completeChannel,
  });
  return { completeChannel, kernelHandle };
}

function writeChannelSyscall(
  channel: any,
  syscallNr: number,
  args: number[],
): void {
  const view = new DataView(channel.memory.buffer, channel.channelOffset);
  view.setUint32(CH_SYSCALL, syscallNr, true);
  for (let i = 0; i < args.length; i++) {
    view.setBigInt64(CH_ARGS + i * CH_ARG_SIZE, BigInt(args[i]), true);
  }
}

describe("file/POSIX MAP_SHARED page cache", () => {
  it("reuses a prepared backing when registering the successful mmap", () => {
    const h = createFileHarness();
    const pid = h.pids[0];
    const args = [0, 4096, PROT_WRITE, MAP_SHARED, 4, 0];
    const preparation = (h.kw as any).prepareSharedMmapFromFile(
      h.channels.get(pid),
      args,
      0n,
    );
    expect(preparation.kind).toBe("prepared");

    expect((h.kw as any).registerPreparedSharedMmap(
      h.channels.get(pid),
      0x1000,
      preparation.context,
    )).toEqual({ kind: "mapped" });
    expect(h.open).not.toHaveBeenCalled();
    expect(h.retainHostFileHandle).toHaveBeenCalledOnce();
    expect(h.retainHostFileHandle).toHaveBeenCalledWith(100);
    expect(h.getFdStatForSharedMapping).toHaveBeenCalledTimes(1);
    expect(h.getFdPathForSharedMapping).not.toHaveBeenCalled();
    expect(h.getFdAccessModeForSharedMapping).toHaveBeenCalledTimes(1);
  });

  it("reserves a same-file backing across MAP_FIXED replacement cleanup", () => {
    const h = createFileHarness();
    const pid = h.pids[0];
    const addr = 0x1000;
    expect(h.map(pid, 4, addr)).toBe(true);
    const backing = Array.from((h.kw as any).sharedMmapBackings.values())[0];
    const preparation = (h.kw as any).prepareSharedMmapFromFile(
      h.channels.get(pid),
      [addr, 4096, PROT_WRITE, MAP_SHARED | MAP_FIXED, 9, 0],
      0n,
    );
    expect(preparation.kind).toBe("prepared");
    expect(backing.refCount).toBe(2);

    (h.kw as any).cleanupSharedMappings(pid, addr, 4096);
    expect(backing.refCount).toBe(1);
    expect((h.kw as any).sharedMmapBackings.get(backing.key)).toBe(backing);
    expect(h.close).not.toHaveBeenCalledWith(backing.handle);

    expect((h.kw as any).registerPreparedSharedMmap(
      h.channels.get(pid),
      addr,
      preparation.context,
    )).toEqual({ kind: "mapped" });
    expect(backing.refCount).toBe(1);
    expect(h.open).not.toHaveBeenCalled();
    expect(h.retainHostFileHandle).toHaveBeenCalledTimes(1);
  });

  it("fails MAP_FIXED preflight before invoking the destructive kernel mmap", () => {
    const h = createFileHarness();
    const pid = h.pids[0];
    const addr = 0x1000;
    const channel = h.channels.get(pid)!;
    const originalMapping = {
      fd: 9,
      fileOffset: 0,
      len: 4096,
      writable: true,
    };
    const originalMap = new Map([[addr, originalMapping]]);
    (h.kw as any).sharedMappings.set(pid, originalMap);
    h.retainHostFileHandle.mockImplementationOnce(() => {
      throw Object.assign(new Error("handle retain failed"), { code: "EACCES" });
    });

    const { completeChannel, kernelHandle } =
      configureKernelSyscallHarness(h, pid);

    const args = [addr, 4096, PROT_WRITE, MAP_SHARED | MAP_FIXED, 4, 0];
    const view = new DataView(channel.memory.buffer, channel.channelOffset);
    view.setUint32(CH_SYSCALL, ABI_SYSCALLS.Mmap, true);
    for (let i = 0; i < args.length; i++) {
      view.setBigInt64(CH_ARGS + i * CH_ARG_SIZE, BigInt(args[i]), true);
    }

    h.kw.testAuthority.dispatchScratchBoundarySyscallForTest(channel as any);

    expect(kernelHandle).not.toHaveBeenCalled();
    expect(completeChannel).toHaveBeenCalledWith(
      channel,
      ABI_SYSCALLS.Mmap,
      args,
      undefined,
      -1,
      13,
    );
    expect((h.kw as any).sharedMappings.get(pid)).toBe(originalMap);
    expect((h.kw as any).sharedMappings.get(pid).get(addr)).toBe(originalMapping);
    expect((h.kw as any).sharedMmapBackings.size).toBe(0);
  });

  it("keeps MAP_FIXED intact when the old overlapping mapping cannot flush", () => {
    const h = createFileHarness();
    const pid = h.pids[0];
    const addr = 0x1000;
    const channel = h.channels.get(pid)!;
    expect(h.map(pid, 4, addr)).toBe(true);
    const originalMap = (h.kw as any).sharedMappings.get(pid);
    const backing = Array.from((h.kw as any).sharedMmapBackings.values())[0];
    new Uint8Array(h.memories.get(pid)!.buffer)[addr + 7] = 0xc7;
    h.io.write.mockReturnValueOnce(0);
    const { completeChannel, kernelHandle } = configureKernelSyscallHarness(h, pid);
    const args = [addr, 4096, PROT_WRITE, MAP_SHARED | MAP_FIXED, 9, 0];
    writeChannelSyscall(channel, ABI_SYSCALLS.Mmap, args);

    h.kw.testAuthority.dispatchScratchBoundarySyscallForTest(channel as any);

    expect(h.io.write).toHaveBeenCalled();
    expect(kernelHandle).not.toHaveBeenCalled();
    expect(completeChannel).toHaveBeenCalledWith(
      channel, ABI_SYSCALLS.Mmap, args, undefined, -1, 5,
    );
    expect((h.kw as any).sharedMappings.get(pid)).toBe(originalMap);
    expect(backing.refCount).toBe(1);
    expect(h.close).not.toHaveBeenCalledWith(backing.handle);
  });

  it("fails MAP_FIXED before the kernel when process memory cannot cover it", () => {
    const h = createFileHarness();
    const pid = h.pids[0];
    const oldAddr = 0x1000;
    const fixedAddr = 0x10000;
    const channel = h.channels.get(pid)!;
    expect(h.map(pid, 4, oldAddr)).toBe(true);
    const originalMap = (h.kw as any).sharedMappings.get(pid);
    const backing = Array.from((h.kw as any).sharedMmapBackings.values())[0];
    const { completeChannel, kernelHandle } = configureKernelSyscallHarness(h, pid);
    const args = [fixedAddr, 4096, PROT_WRITE, MAP_SHARED | MAP_FIXED, 9, 0];
    writeChannelSyscall(channel, ABI_SYSCALLS.Mmap, args);

    h.kw.testAuthority.dispatchScratchBoundarySyscallForTest(channel as any);

    expect(kernelHandle).not.toHaveBeenCalled();
    expect(h.io.write).not.toHaveBeenCalled();
    expect(completeChannel).toHaveBeenCalledWith(
      channel, ABI_SYSCALLS.Mmap, args, undefined, -1, 12,
    );
    expect((h.kw as any).sharedMappings.get(pid)).toBe(originalMap);
    expect(backing.refCount).toBe(1);
    expect(h.close).not.toHaveBeenCalledWith(backing.handle);
  });

  it("releases a prepared reservation when pre-kernel MAP_FIXED flush fails", () => {
    const h = createFileHarness();
    const pid = h.pids[0];
    const addr = 0x1000;
    const channel = h.channels.get(pid)!;
    expect(h.map(pid, 4, addr)).toBe(true);
    const backing = Array.from((h.kw as any).sharedMmapBackings.values())[0];
    new Uint8Array(h.memories.get(pid)!.buffer)[addr + 9] = 0xd9;
    h.io.write.mockImplementationOnce(
      (_handle, _input, _offset, count) => count + 1,
    );
    const { completeChannel, kernelHandle } =
      configureKernelSyscallHarness(h, pid);
    const args = [
      addr,
      4096,
      PROT_WRITE,
      MAP_SHARED | MAP_FIXED,
      9,
      0,
    ];
    writeChannelSyscall(
      channel,
      ABI_SYSCALLS.Mmap,
      args,
    );

    h.kw.testAuthority.dispatchScratchBoundarySyscallForTest(channel as any);

    expect(kernelHandle).not.toHaveBeenCalled();
    expect(completeChannel).toHaveBeenCalledWith(
      channel,
      ABI_SYSCALLS.Mmap,
      args,
      undefined,
      -1,
      5,
    );
    expect(backing.refCount).toBe(1);
    expect(backing.dirtyPages.has(0)).toBe(true);
    expect(h.close).not.toHaveBeenCalledWith(backing.handle);
  });

  it("fails file mremap expansion before the kernel when a new page cannot load", () => {
    const h = createFileHarness();
    const pid = h.pids[0];
    const addr = 0x1000;
    const channel = h.channels.get(pid)!;
    expect(h.map(pid, 4, addr)).toBe(true);
    const originalMapping = (h.kw as any).sharedMappings.get(pid).get(addr);
    h.io.read.mockImplementationOnce(() => {
      throw new Error("extension read failed");
    });
    const { completeChannel, kernelHandle } = configureKernelSyscallHarness(h, pid);
    const args = [addr, 4096, 8192, 1, 0, 0];
    writeChannelSyscall(channel, ABI_SYSCALLS.Mremap, args);

    h.kw.testAuthority.dispatchScratchBoundarySyscallForTest(channel as any);

    expect(kernelHandle).not.toHaveBeenCalled();
    expect(completeChannel).toHaveBeenCalledWith(
      channel, ABI_SYSCALLS.Mremap, args, undefined, -1, 5,
    );
    expect((h.kw as any).sharedMappings.get(pid).get(addr)).toBe(originalMapping);
    expect(originalMapping.len).toBe(4096);
  });

  it("shares one inode backing across separate fds and preserves disjoint writes", () => {
    const h = createFileHarness();
    const [firstPid, secondPid] = h.pids;
    const firstAddr = 0x1000;
    const secondAddr = 0x3000;
    expect(h.map(firstPid, 4, firstAddr)).toBe(true);
    expect(h.map(secondPid, 9, secondAddr)).toBe(true);
    expect(h.open).not.toHaveBeenCalled();
    expect(h.retainHostFileHandle).toHaveBeenCalledTimes(1);
    expect((h.kw as any).sharedMmapBackings.size).toBe(1);

    const first = new Uint8Array(h.memories.get(firstPid)!.buffer);
    const second = new Uint8Array(h.memories.get(secondPid)!.buffer);
    first[firstAddr + 11] = 0xa1;
    (h.kw as any).syncFileSharedMappingsFromProcess(
      (h.kw as any).processes.get(firstPid),
    );
    second[secondAddr + 29] = 0xb2;
    (h.kw as any).syncFileSharedMappingsFromProcess(
      (h.kw as any).processes.get(secondPid),
    );

    expect(second[secondAddr + 11]).toBe(0xa1);
    expect(second[secondAddr + 29]).toBe(0xb2);
    (h.kw as any).syncFileSharedMappingsFromProcess(
      (h.kw as any).processes.get(firstPid),
    );
    expect(first[firstAddr + 29]).toBe(0xb2);
  });

  it("publishes a sole observer before a second mapping joins its backing", () => {
    const h = createFileHarness();
    const [firstPid, secondPid] = h.pids;
    const firstAddr = 0x1000;
    const secondAddr = 0x3000;
    expect(h.map(firstPid, 4, firstAddr)).toBe(true);
    new Uint8Array(h.memories.get(firstPid)!.buffer)[firstAddr + 37] = 0xd7;

    expect(h.map(secondPid, 9, secondAddr)).toBe(true);

    expect(new Uint8Array(h.memories.get(secondPid)!.buffer)[secondAddr + 37])
      .toBe(0xd7);
  });

  it("converges overlapping aliases after one coherence boundary", () => {
    const h = createFileHarness();
    const pid = h.pids[0];
    const firstAddr = 0x1000;
    const secondAddr = 0x3000;
    expect(h.map(pid, 4, firstAddr)).toBe(true);
    expect(h.map(pid, 9, secondAddr)).toBe(true);
    const process = new Uint8Array(h.memories.get(pid)!.buffer);
    process[firstAddr + 11] = 0xa1;
    process[secondAddr + 29] = 0xb2;

    (h.kw as any).syncFileSharedMappingsFromProcess(
      (h.kw as any).processes.get(pid),
    );

    expect(process[firstAddr + 11]).toBe(0xa1);
    expect(process[firstAddr + 29]).toBe(0xb2);
    expect(process[secondAddr + 11]).toBe(0xa1);
    expect(process[secondAddr + 29]).toBe(0xb2);
  });

  it("inherits file mappings across fork using the same stable backing", () => {
    const h = createFileHarness();
    const [parentPid, , childPid] = h.pids;
    const addr = 0x1800;
    expect(h.map(parentPid, 4, addr)).toBe(true);
    const parent = new Uint8Array(h.memories.get(parentPid)!.buffer);
    parent[addr + 17] = 0x77;
    (h.kw as any).syncFileSharedMappingsFromProcess(
      (h.kw as any).processes.get(parentPid),
      { force: true },
    );

    h.kw.inheritProcessSharedMappings(parentPid, childPid);
    const child = new Uint8Array(h.memories.get(childPid)!.buffer);
    const backing = Array.from((h.kw as any).sharedMmapBackings.values())[0];
    expect(child[addr + 17]).toBe(0x77);
    expect(backing.refCount).toBe(2);
    expect((h.kw as any).sharedMappings.get(childPid).size).toBe(1);
    expect((h.kw as any).sharedMmapFdCache.has(`${childPid}:4`)).toBe(false);
  });

  it("retains an already-unlinked fd through close then munmap", () => {
    const h = createFileHarness();
    const pid = h.pids[0];
    const addr = 0x2000;
    // The pathname is gone before mmap, as in POSIX munmap/3-1 and 9-1.
    h.fdIdentity.delete(4);
    expect(h.map(pid, 4, addr)).toBe(true);
    const stableHandle = Array.from((h.kw as any).sharedMmapBackings.values())[0].handle;

    // close(fd) asks the host to close the original handle, but the mapping's
    // retain keeps it usable until the final munmap releases the backing.
    expect(h.kernel.testAuthority.hostClose(BigInt(stableHandle))).toBe(0);
    h.fdHostHandles.delete(4);
    (h.kw as any).handleSharedMappingsAfterFileSyscall(
      h.channels.get(pid), ABI_SYSCALLS.Close, [4], 0, 0,
    );
    new Uint8Array(h.memories.get(pid)!.buffer)[addr + 23] = 0xc3;
    (h.kw as any).flushSharedMappings(h.channels.get(pid), [addr, 4096]);

    expect(h.storage[23]).toBe(0xc3);
    expect(h.close).not.toHaveBeenCalledWith(stableHandle);
    (h.kw as any).cleanupSharedMappings(pid, addr, 4096);
    expect(h.close).toHaveBeenCalledWith(stableHandle);
  });

  it("releases munmap before a later close of the original fd", () => {
    const h = createFileHarness();
    const pid = h.pids[0];
    const addr = 0x2000;
    expect(h.map(pid, 4, addr)).toBe(true);
    const stableHandle = Array.from((h.kw as any).sharedMmapBackings.values())[0].handle;

    (h.kw as any).cleanupSharedMappings(pid, addr, 4096);
    expect(h.releaseHostFileHandle).toHaveBeenCalledWith(stableHandle);
    expect(h.close).not.toHaveBeenCalledWith(stableHandle);

    expect(h.kernel.testAuthority.hostClose(BigInt(stableHandle))).toBe(0);
    expect(h.close).toHaveBeenCalledWith(stableHandle);
  });

  it("refreshes mappings after direct pwrite and ftruncate", () => {
    const h = createFileHarness();
    const [writerPid, readerPid] = h.pids;
    const writerAddr = 0x1000;
    const readerAddr = 0x3000;
    expect(h.map(writerPid, 4, writerAddr)).toBe(true);
    expect(h.map(readerPid, 9, readerAddr)).toBe(true);
    const writer = new Uint8Array(h.memories.get(writerPid)!.buffer);
    const reader = new Uint8Array(h.memories.get(readerPid)!.buffer);
    const sourcePtr = 0x7000;
    writer.set([0xde, 0xad], sourcePtr);
    h.storage.set([0xde, 0xad], 20); // kernel pwrite already changed the file

    (h.kw as any).handleSharedMappingsAfterFileSyscall(
      h.channels.get(writerPid),
      ABI_SYSCALLS.Pwrite,
      [4, sourcePtr, 2, 20],
      2,
      0,
    );
    (h.kw as any).syncFileSharedMappingsFromProcess(
      (h.kw as any).processes.get(readerPid),
    );
    expect(Array.from(reader.subarray(readerAddr + 20, readerAddr + 22)))
      .toEqual([0xde, 0xad]);

    h.setLogicalSize(16); // kernel ftruncate already changed the file
    (h.kw as any).handleSharedMappingsAfterFileSyscall(
      h.channels.get(writerPid), ABI_SYSCALLS.Ftruncate, [4, 16], 0, 0,
    );
    (h.kw as any).syncFileSharedMappingsFromProcess(
      (h.kw as any).processes.get(readerPid),
    );
    expect(reader[readerAddr + 20]).toBe(0);
  });

  it("flushes mapped bytes before direct reads and reloads after direct writes", () => {
    const h = createFileHarness();
    const [writerPid, readerPid] = h.pids;
    const writerAddr = 0x1000;
    const readerAddr = 0x3000;
    expect(h.map(writerPid, 4, writerAddr)).toBe(true);
    expect(h.map(readerPid, 9, readerAddr)).toBe(true);
    const writer = new Uint8Array(h.memories.get(writerPid)!.buffer);
    const reader = new Uint8Array(h.memories.get(readerPid)!.buffer);

    writer[writerAddr + 35] = 0xd1;
    expect((h.kw as any).flushSharedMappingsBeforeFileSyscall(
      h.channels.get(writerPid), ABI_SYSCALLS.Pread, [4],
    )).toBe(true);
    expect(h.storage[35]).toBe(0xd1);

    h.storage[41] = 0xe2; // the kernel's direct write already completed
    (h.kw as any).handleSharedMappingsAfterFileSyscall(
      h.channels.get(writerPid), ABI_SYSCALLS.Write, [4], 1, 0,
    );
    (h.kw as any).syncFileSharedMappingsFromProcess(
      (h.kw as any).processes.get(readerPid),
    );
    expect(reader[readerAddr + 41]).toBe(0xe2);
  });

  it("publishes dirty shared bytes before a private mmap reads the file", () => {
    const h = createFileHarness();
    const pid = h.pids[0];
    const addr = 0x1000;
    expect(h.map(pid, 4, addr)).toBe(true);
    new Uint8Array(h.memories.get(pid)!.buffer)[addr + 43] = 0xe3;

    expect((h.kw as any).flushSharedMappingsBeforeFileSyscall(
      h.channels.get(pid),
      ABI_SYSCALLS.Mmap,
      [0, 4096, PROT_READ, MAP_PRIVATE, 4, 0],
    )).toBe(true);

    expect(h.storage[43]).toBe(0xe3);
  });

  it("keeps truncate, fallocate, and O_TRUNC coherent with mapped files", () => {
    const path = "/dev/shm/php-cache";
    const pathBytes = new TextEncoder().encode(`${path}\0`);

    const truncate = createFileHarness();
    const truncatePid = truncate.pids[0];
    const truncateAddr = 0x1000;
    const truncatePathPtr = 0x7000;
    expect(truncate.map(truncatePid, 4, truncateAddr)).toBe(true);
    const truncateMemory = new Uint8Array(
      truncate.memories.get(truncatePid)!.buffer,
    );
    truncateMemory.set(pathBytes, truncatePathPtr);
    truncateMemory[truncateAddr + 47] = 0xa7;
    expect((truncate.kw as any).flushSharedMappingsBeforeFileSyscall(
      truncate.channels.get(truncatePid),
      ABI_SYSCALLS.Truncate,
      [truncatePathPtr, 16],
    )).toBe(true);
    expect(truncate.storage[47]).toBe(0xa7);
    truncate.setLogicalSize(16);
    (truncate.kw as any).handleSharedMappingsAfterFileSyscall(
      truncate.channels.get(truncatePid),
      ABI_SYSCALLS.Truncate,
      [truncatePathPtr, 16],
      0,
      0,
    );
    const truncateBacking = Array.from(
      (truncate.kw as any).sharedMmapBackings.values(),
    )[0];
    expect(truncateBacking.size).toBe(16);

    const fallocate = createFileHarness();
    const fallocatePid = fallocate.pids[0];
    expect(fallocate.map(fallocatePid, 4, 0x1000)).toBe(true);
    new Uint8Array(fallocate.memories.get(fallocatePid)!.buffer)[0x1000 + 53]
      = 0xb8;
    expect((fallocate.kw as any).flushSharedMappingsBeforeFileSyscall(
      fallocate.channels.get(fallocatePid),
      ABI_SYSCALLS.Fallocate,
      [4, 0, 0, 20_000],
    )).toBe(true);
    expect(fallocate.storage[53]).toBe(0xb8);
    fallocate.setLogicalSize(20_000);
    (fallocate.kw as any).handleSharedMappingsAfterFileSyscall(
      fallocate.channels.get(fallocatePid),
      ABI_SYSCALLS.Fallocate,
      [4, 0, 0, 20_000],
      0,
      0,
    );
    expect(Array.from((fallocate.kw as any).sharedMmapBackings.values())[0].size)
      .toBe(20_000);

    const openTruncate = createFileHarness();
    const openPid = openTruncate.pids[0];
    const openPathPtr = 0x7000;
    expect(openTruncate.map(openPid, 4, 0x1000)).toBe(true);
    const openMemory = new Uint8Array(openTruncate.memories.get(openPid)!.buffer);
    openMemory.set(pathBytes, openPathPtr);
    openMemory[0x1000 + 59] = 0xc9;
    expect((openTruncate.kw as any).flushSharedMappingsBeforeFileSyscall(
      openTruncate.channels.get(openPid),
      ABI_SYSCALLS.Open,
      [openPathPtr, 0o1002, 0],
    )).toBe(true);
    expect(openTruncate.storage[59]).toBe(0xc9);
    openTruncate.setLogicalSize(0);
    (openTruncate.kw as any).handleSharedMappingsAfterFileSyscall(
      openTruncate.channels.get(openPid),
      ABI_SYSCALLS.Open,
      [openPathPtr, 0o1002, 0],
      9,
      0,
    );
    expect(Array.from(
      (openTruncate.kw as any).sharedMmapBackings.values(),
    )[0].size).toBe(0);
  });

  it("copies shared-memory pathnames before browser TextDecoder decoding", () => {
    const h = createFileHarness();
    const pid = h.pids[0];
    const pathPtr = 0x7000;
    const path = "/dev/shm/php-cache";
    new Uint8Array(h.memories.get(pid)!.buffer).set(
      new TextEncoder().encode(`${path}\0`),
      pathPtr,
    );

    const originalDecode = TextDecoder.prototype.decode;
    const decode = vi.spyOn(TextDecoder.prototype, "decode").mockImplementation(
      function (this: TextDecoder, input?: any, options?: any) {
        if (ArrayBuffer.isView(input)
          && input.buffer instanceof SharedArrayBuffer) {
          throw new TypeError("browser TextDecoder rejects shared views");
        }
        return originalDecode.call(this, input, options);
      },
    );

    try {
      expect((h.kw as any).resolveSharedMmapPath(
        h.channels.get(pid),
        pathPtr,
      )).toEqual({ kind: "ok", value: path });
    } finally {
      decode.mockRestore();
    }
  });

  it("balances backing references across partial unmap splits", () => {
    const h = createFileHarness();
    const pid = h.pids[0];
    const addr = 0x1000;
    expect(h.map(pid, 4, addr, 3 * 4096)).toBe(true);
    const backing = Array.from((h.kw as any).sharedMmapBackings.values())[0];
    expect(backing.refCount).toBe(1);

    (h.kw as any).cleanupSharedMappings(pid, addr + 4096, 4096);
    expect(backing.refCount).toBe(2);
    expect((h.kw as any).sharedMappings.get(pid).size).toBe(2);

    (h.kw as any).cleanupSharedMappings(pid, addr, 3 * 4096);
    expect((h.kw as any).sharedMmapBackings.size).toBe(0);
    expect(h.releaseHostFileHandle).toHaveBeenCalledTimes(1);
    expect(h.close).not.toHaveBeenCalled();
  });

  it("keeps one backing reference while mremap moves and grows a mapping", () => {
    const h = createFileHarness();
    const pid = h.pids[0];
    const oldAddr = 0x1000;
    const newAddr = 0x5000;
    expect(h.map(pid, 4, oldAddr)).toBe(true);
    const backing = Array.from((h.kw as any).sharedMmapBackings.values())[0];

    (h.kw as any).remapSharedMapping(pid, oldAddr, newAddr, 8192);
    expect(backing.refCount).toBe(1);
    expect((h.kw as any).sharedMappings.get(pid).has(oldAddr)).toBe(false);
    expect((h.kw as any).sharedMappings.get(pid).get(newAddr).len).toBe(8192);
    expect(new Uint8Array(h.memories.get(pid)!.buffer)[newAddr]).toBe(1);

    (h.kw as any).cleanupSharedMappings(pid, newAddr, 8192);
    expect((h.kw as any).sharedMmapBackings.size).toBe(0);
  });

  it("rolls back inherited file references when a later mapping is invalid", () => {
    const h = createFileHarness();
    const [parentPid, , childPid] = h.pids;
    const addr = 0x1000;
    expect(h.map(parentPid, 4, addr)).toBe(true);
    const backing = Array.from((h.kw as any).sharedMmapBackings.values())[0];
    (h.kw as any).sharedMappings.get(parentPid).set(addr + 0x2000, {
      fd: 10,
      fileOffset: 0,
      len: 4096,
      writable: true,
      backingKind: "file",
      backingKey: "missing",
      snapshot: new Uint8Array(4096),
      seenVersion: 0,
    });

    expect(() => h.kw.inheritProcessSharedMappings(parentPid, childPid)).toThrow();
    expect(backing.refCount).toBe(1);
    expect((h.kw as any).sharedMappings.has(childPid)).toBe(false);
  });

  it("publishes file mappings before committing a kernel fork child", () => {
    const h = createFileHarness();
    const pid = h.pids[0];
    const channel = h.channels.get(pid)!;
    expect(h.map(pid, 4, 0x1000)).toBe(true);
    const backing = Array.from((h.kw as any).sharedMmapBackings.values())[0];
    (h.kw as any).invalidateSharedMmapBackingPages(backing);
    h.io.read.mockImplementation(() => {
      throw new Error("fork publication failed");
    });

    expect(() => (h.kw as any).handleFork(channel, [])).toThrow(
      /fork publication failed/,
    );
    expect(h.onFork).not.toHaveBeenCalled();
  });

  it("reports handle-retention and initial-read failures without leaking a backing", () => {
    const retainFailure = createFileHarness();
    retainFailure.retainHostFileHandle.mockImplementationOnce(() => {
      throw new Error("retain failed");
    });
    expect(retainFailure.mapResult(retainFailure.pids[0], 4, 0x1000))
      .toEqual({ kind: "error", errno: 5 });
    expect((retainFailure.kw as any).sharedMmapBackings.size).toBe(0);

    const readFailure = createFileHarness();
    readFailure.io.read.mockImplementationOnce(() => {
      throw new Error("read failed");
    });
    expect(readFailure.mapResult(readFailure.pids[0], 4, 0x1000))
      .toEqual({ kind: "error", errno: 5 });
    expect((readFailure.kw as any).sharedMmapBackings.size).toBe(0);
    expect(readFailure.releaseHostFileHandle).toHaveBeenCalledWith(100);
    expect(readFailure.close).not.toHaveBeenCalled();

    const writeOnly = createFileHarness();
    writeOnly.getFdAccessModeForSharedMapping.mockReturnValue({
      kind: "ok",
      value: 1,
    });
    expect(writeOnly.mapResult(writeOnly.pids[0], 4, 0x1000, 4096, PROT_READ))
      .toEqual({ kind: "error", errno: 13 });
    expect(writeOnly.retainHostFileHandle).not.toHaveBeenCalled();
  });

  it("preserves fd metadata errno values", () => {
    const invalidFd = createFileHarness();
    expect(invalidFd.mapResult(invalidFd.pids[0], 77, 0x1000))
      .toEqual({ kind: "error", errno: 9 });
    expect(invalidFd.retainHostFileHandle).not.toHaveBeenCalled();

    for (const errno of [24, 2, 30]) {
      const h = createFileHarness();
      h.getFdStatForSharedMapping.mockReturnValueOnce({
        kind: "error",
        errno,
      });
      expect(h.mapResult(h.pids[0], 4, 0x1000))
        .toEqual({ kind: "error", errno });
      expect((h.kw as any).sharedMmapBackings.size).toBe(0);
      expect(h.retainHostFileHandle).not.toHaveBeenCalled();
    }
  });

  it("assembles backing pages across short positive reads", () => {
    const h = createFileHarness();
    const read = h.io.read.getMockImplementation()!;
    h.io.read.mockImplementation((handle, out, offset, len) =>
      read(handle, out, offset, Math.min(len, 17)));

    expect(h.map(h.pids[0], 4, 0x1000)).toBe(true);

    expect(h.io.read.mock.calls.length).toBeGreaterThan(1);
    expect(Array.from(
      new Uint8Array(h.memories.get(h.pids[0])!.buffer)
        .subarray(0x1000, 0x1040),
    )).toEqual(Array.from({ length: 64 }, (_, i) => i + 1));
  });

  it("guards mprotect write upgrades with a lifetime-stable writable handle", () => {
    const denied = createFileHarness();
    denied.fdSupportsMmapWriteback.mockReturnValue(false);
    expect(denied.map(denied.pids[0], 4, 0x1000, 4096, PROT_READ)).toBe(true);
    expect((denied.kw as any).prepareFileSharedMappingsForWrite(
      denied.pids[0], 0x1000, 4096,
    )).toBe(13);
    expect(denied.retainHostFileHandle).toHaveBeenCalledWith(100);

    const allowed = createFileHarness();
    expect(allowed.map(allowed.pids[0], 4, 0x1000, 4096, PROT_READ)).toBe(true);
    const stableHandle = Array.from(
      (allowed.kw as any).sharedMmapBackings.values(),
    )[0].handle;
    // Simulate close(fd) followed by unlink/rename. The retained O_RDWR host
    // handle must suffice; no pathname lookup or reopen is permitted.
    expect(
      allowed.kernel.testAuthority.hostClose(BigInt(stableHandle)),
    ).toBe(0);
    allowed.fdHostHandles.delete(4);
    (allowed.kw as any).handleSharedMappingsAfterFileSyscall(
      allowed.channels.get(allowed.pids[0]), ABI_SYSCALLS.Close, [4], 0, 0,
    );
    allowed.fdIdentity.delete(4);
    expect((allowed.kw as any).prepareFileSharedMappingsForWrite(
      allowed.pids[0], 0x1000, 4096,
    )).toBe(0);
    const backing = Array.from((allowed.kw as any).sharedMmapBackings.values())[0];
    expect(backing.writable).toBe(true);
    expect(allowed.open).not.toHaveBeenCalled();
    expect(allowed.close).not.toHaveBeenCalledWith(stableHandle);
  });

  it("replaces one retained O_RDONLY handle with a distinct O_RDWR handle", () => {
    const h = createFileHarness();
    const pid = h.pids[0];
    h.getFdAccessModeForSharedMapping.mockImplementation(
      (_channel: unknown, fd: number) => ({ kind: "ok", value: fd === 4 ? 0 : 2 }),
    );

    expect(h.map(pid, 4, 0x1000, 4096, PROT_READ)).toBe(true);
    const backing = Array.from((h.kw as any).sharedMmapBackings.values())[0];
    expect(backing.handle).toBe(100);
    expect(backing.writable).toBe(false);

    expect(h.map(pid, 9, 0x3000, 4096, PROT_READ)).toBe(true);
    expect(backing.handle).toBe(101);
    expect(backing.writable).toBe(true);
    expect(h.retainHostFileHandle.mock.calls.map(([handle]) => handle))
      .toEqual([100, 101]);
    expect(h.releaseHostFileHandle).toHaveBeenCalledWith(100);
    expect(h.close).not.toHaveBeenCalledWith(100);
    expect(h.open).not.toHaveBeenCalled();
  });

  it("does not add a retain when a writable upgrade reports the same handle", () => {
    const h = createFileHarness();
    const pid = h.pids[0];
    let accessMode = 0;
    h.getFdAccessModeForSharedMapping.mockImplementation(
      () => ({ kind: "ok", value: accessMode }),
    );

    expect(h.map(pid, 4, 0x1000, 4096, PROT_READ)).toBe(true);
    accessMode = 2;
    expect(h.mapResult(pid, 4, 0x3000, 4096, PROT_READ))
      .toEqual({ kind: "error", errno: 5 });
    expect(h.retainHostFileHandle).toHaveBeenCalledTimes(1);
    expect(h.releaseHostFileHandle).not.toHaveBeenCalled();
  });

  it("retains negative fd identities until that descriptor is created", () => {
    const h = createFileHarness();
    const pid = h.pids[0];
    expect(h.map(pid, 4, 0x1000)).toBe(true);
    const stat = h.getFdStatForSharedMapping;
    const callsBefore = stat.mock.calls.length;

    expect((h.kw as any).findSharedMmapBackingForFd(h.channels.get(pid), 77))
      .toBeNull();
    expect((h.kw as any).findSharedMmapBackingForFd(h.channels.get(pid), 77))
      .toBeNull();
    expect(stat.mock.calls.length).toBe(callsBefore + 1);

    (h.kw as any).handleSharedMappingsAfterFileSyscall(
      h.channels.get(pid), ABI_SYSCALLS.Getpid, [], pid, 0,
    );
    expect((h.kw as any).findSharedMmapBackingForFd(h.channels.get(pid), 77))
      .toBeNull();
    expect(stat.mock.calls.length).toBe(callsBefore + 1);

    (h.kw as any).handleSharedMappingsAfterFileSyscall(
      h.channels.get(pid), ABI_SYSCALLS.Open, [], 77, 0,
    );
    expect((h.kw as any).findSharedMmapBackingForFd(h.channels.get(pid), 77))
      .toBeNull();
    expect(stat.mock.calls.length).toBe(callsBefore + 2);
  });

  it("preserves an unrelated dirty byte across a sub-page direct pwrite", () => {
    const h = createFileHarness();
    const pid = h.pids[0];
    const addr = 0x1000;
    expect(h.map(pid, 4, addr)).toBe(true);
    const process = new Uint8Array(h.memories.get(pid)!.buffer);
    process[addr + 11] = 0xa1;
    (h.kw as any).syncFileSharedMappingsFromProcess(
      (h.kw as any).processes.get(pid),
      { force: true },
    );
    const backing = Array.from((h.kw as any).sharedMmapBackings.values())[0];
    expect(backing.dirtyPages.has(0)).toBe(true);

    const sourcePtr = 0x7000;
    process[sourcePtr] = 0xb2;
    h.storage[29] = 0xb2;
    (h.kw as any).handleSharedMappingsAfterFileSyscall(
      h.channels.get(pid), ABI_SYSCALLS.Pwrite, [4, sourcePtr, 1, 29], 1, 0,
    );

    expect(backing.dirtyPages.has(0)).toBe(true);
    expect(backing.pages.get(0)[11]).toBe(0xa1);
    expect(backing.pages.get(0)[29]).toBe(0xb2);
    expect((h.kw as any).flushSharedMmapBackingRange(backing, 0, 4096)).toBe(true);
    expect(h.storage[11]).toBe(0xa1);
    expect(h.storage[29]).toBe(0xb2);
  });

  it("clips msync and final unmap writeback to a 100-byte EOF", () => {
    const h = createFileHarness();
    const pid = h.pids[0];
    const addr = 0x1000;
    h.setLogicalSize(100);
    expect(h.map(pid, 4, addr)).toBe(true);
    const process = new Uint8Array(h.memories.get(pid)!.buffer);
    const backing = Array.from((h.kw as any).sharedMmapBackings.values())[0];
    expect(backing.size).toBe(100);

    process[addr + 50] = 0xa5;
    process[addr + 150] = 0xf1;
    expect((h.kw as any).flushSharedMappings(
      h.channels.get(pid), [addr, 4096],
    )).toBe(true);
    expect(h.logicalSize()).toBe(100);
    expect(h.storage[50]).toBe(0xa5);
    expect(h.io.write.mock.calls.at(-1)?.[3]).toBe(100);

    process[addr + 60] = 0xb6;
    process[addr + 160] = 0xf2;
    (h.kw as any).syncFileSharedMappingsFromProcess(
      (h.kw as any).processes.get(pid),
      { force: true },
    );
    (h.kw as any).cleanupSharedMappings(pid, addr, 4096);
    expect(h.logicalSize()).toBe(100);
    expect(h.storage[60]).toBe(0xb6);
    expect((h.kw as any).sharedMmapBackings.size).toBe(0);
  });

  it("refreshes authoritative size after direct extension and truncate", () => {
    const h = createFileHarness();
    const pid = h.pids[0];
    const addr = 0x1000;
    const sourcePtr = 0x7000;
    h.setLogicalSize(100);
    expect(h.map(pid, 4, addr)).toBe(true);
    const process = new Uint8Array(h.memories.get(pid)!.buffer);
    const backing = Array.from((h.kw as any).sharedMmapBackings.values())[0];

    process.set([0xde, 0xad], sourcePtr);
    h.storage.set([0xde, 0xad], 150);
    h.setLogicalSize(152);
    (h.kw as any).handleSharedMappingsAfterFileSyscall(
      h.channels.get(pid), ABI_SYSCALLS.Pwrite, [4, sourcePtr, 2, 150], 2, 0,
    );
    expect(backing.size).toBe(152);

    h.setLogicalSize(50);
    (h.kw as any).handleSharedMappingsAfterFileSyscall(
      h.channels.get(pid), ABI_SYSCALLS.Ftruncate, [4, 50], 0, 0,
    );
    expect(backing.size).toBe(50);
    (h.kw as any).syncFileSharedMappingsFromProcess(
      (h.kw as any).processes.get(pid),
    );
    expect(process[addr + 80]).toBe(0);

    h.setLogicalSize(200);
    (h.kw as any).handleSharedMappingsAfterFileSyscall(
      h.channels.get(pid), ABI_SYSCALLS.Ftruncate, [4, 200], 0, 0,
    );
    expect(backing.size).toBe(200);
  });

  it("refreshes size after direct and in-kernel copy mutations", () => {
    const h = createFileHarness();
    const pid = h.pids[0];
    expect(h.map(pid, 4, 0x1000)).toBe(true);
    const backing = Array.from((h.kw as any).sharedMmapBackings.values())[0];
    const cases = [
      [ABI_SYSCALLS.Write, [4], 120],
      [ABI_SYSCALLS.Writev, [4], 130],
      [ABI_SYSCALLS.Pwritev, [4], 140],
      [ABI_SYSCALLS.Sendfile, [4, 9], 150],
      [SYS_COPY_FILE_RANGE, [4, 0, 9, 0], 160],
      [SYS_SPLICE, [4, 0, 9, 0], 170],
    ] as const;
    for (const [syscallNr, args, size] of cases) {
      h.setLogicalSize(size);
      (h.kw as any).handleSharedMappingsAfterFileSyscall(
        h.channels.get(pid), syscallNr, args, 1, 0,
      );
      expect(backing.size).toBe(size);
    }
  });

  it("publishes mapped input before copy_file_range and splice", () => {
    const h = createFileHarness();
    const pid = h.pids[0];
    const addr = 0x1000;
    expect(h.map(pid, 4, addr)).toBe(true);
    const process = new Uint8Array(h.memories.get(pid)!.buffer);

    for (const [index, syscallNr] of [
      SYS_COPY_FILE_RANGE,
      SYS_SPLICE,
    ].entries()) {
      const offset = 61 + index;
      process[addr + offset] = 0xd0 + index;
      expect((h.kw as any).flushSharedMappingsBeforeFileSyscall(
        h.channels.get(pid),
        syscallNr,
        [4, 0, 9, 0, 1, 0],
      )).toBe(true);
      expect(h.storage[offset]).toBe(0xd0 + index);
    }
  });

  it("invalidates stale pages after reread failure and recovers at completion", () => {
    const h = createFileHarness();
    const pid = h.pids[0];
    const addr = 0x1000;
    expect(h.map(pid, 4, addr)).toBe(true);
    const backing = Array.from((h.kw as any).sharedMmapBackings.values())[0];
    const mapping = (h.kw as any).sharedMappings.get(pid).get(addr);
    h.storage[25] = 0xd5;
    h.io.read.mockImplementationOnce(() => {
      throw new Error("one-shot reread failure");
    });

    (h.kw as any).handleSharedMappingsAfterFileSyscall(
      h.channels.get(pid), ABI_SYSCALLS.Write, [4], 1, 0,
    );
    expect(backing.pages.has(0)).toBe(false);
    expect(mapping.seenVersion).toBeLessThan(backing.version);

    (h.kw as any).syncFileSharedMappingsFromProcess(
      (h.kw as any).processes.get(pid),
    );
    expect(backing.pages.has(0)).toBe(true);
    expect(new Uint8Array(h.memories.get(pid)!.buffer)[addr + 25]).toBe(0xd5);
    expect(mapping.seenVersion).toBe(backing.version);
  });

  it("keeps persistently unreadable direct-write cache pages invalid", () => {
    const h = createFileHarness();
    const pid = h.pids[0];
    const addr = 0x1000;
    expect(h.map(pid, 4, addr)).toBe(true);
    const backing = Array.from((h.kw as any).sharedMmapBackings.values())[0];
    const mapping = (h.kw as any).sharedMappings.get(pid).get(addr);
    h.storage[26] = 0xe6;
    h.io.read.mockImplementation(() => {
      throw new Error("persistent reread failure");
    });

    (h.kw as any).handleSharedMappingsAfterFileSyscall(
      h.channels.get(pid), ABI_SYSCALLS.Write, [4], 1, 0,
    );
    expect(() => (h.kw as any).syncFileSharedMappingsFromProcess(
      (h.kw as any).processes.get(pid),
    )).toThrow(/persistent reread failure/);
    expect(backing.pages.has(0)).toBe(false);
    expect(mapping.seenVersion).toBeLessThan(backing.version);
  });

  it("completes EIO when recovery follows a persistent refresh failure", () => {
    const h = createFileHarness();
    const pid = h.pids[0];
    const addr = 0x1000;
    const channel = h.channels.get(pid)!;
    expect(h.map(pid, 4, addr)).toBe(true);
    const backing = Array.from((h.kw as any).sharedMmapBackings.values())[0];
    (h.kw as any).invalidateSharedMmapBackingPages(backing);
    h.io.read.mockImplementation(() => {
      throw new Error("persistent refresh failure");
    });

    const relistenChannel = vi.fn();
    Object.assign(h.kw as any, {
      config: {},
      syscallRing: new Map(),
      syscallTraceEnabled: false,
      pendingCancels: new Set(),
    });
    h.kw.testAuthority.configureScratchBoundaryHooksForTest({
      relistenChannel,
    });
    writeChannelSyscall(channel, ABI_SYSCALLS.Getpid, []);
    Atomics.store(
      channel.i32View,
      CH_STATUS / Int32Array.BYTES_PER_ELEMENT,
      CHANNEL_STATUS_PENDING,
    );
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    (h.kw as any).handleSyscall(channel);

    consoleError.mockRestore();
    const view = new DataView(channel.memory.buffer, channel.channelOffset);
    expect(Number(view.getBigInt64(CH_RETURN, true))).toBe(-5);
    expect(view.getUint32(CH_ERRNO, true)).toBe(5);
    expect(Atomics.load(channel.i32View, CH_STATUS / 4))
      .toBe(CHANNEL_STATUS_COMPLETE);
    expect(relistenChannel).toHaveBeenCalledWith(channel);
  });

  it("keeps asynchronous normal completion live after coherence failure", () => {
    const h = createFileHarness();
    const channel = h.channels.get(h.pids[0])!;
    const relistenChannel = vi.fn();
    h.kw.testAuthority.configureScratchBoundaryHooksForTest({
      synchronizeSharedMemoryForBoundary: vi.fn(() => {
        throw new Error("asynchronous refresh failure");
      }),
      relistenChannel,
    });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    (h.kw as any).completeChannel(
      channel,
      ABI_SYSCALLS.Getpid,
      [],
      undefined,
      channel.pid,
      0,
    );

    consoleError.mockRestore();
    const view = new DataView(channel.memory.buffer, channel.channelOffset);
    expect(Number(view.getBigInt64(CH_RETURN, true))).toBe(-5);
    expect(view.getUint32(CH_ERRNO, true)).toBe(5);
    expect(Atomics.load(channel.i32View, CH_STATUS / 4))
      .toBe(CHANNEL_STATUS_COMPLETE);
    expect(relistenChannel).toHaveBeenCalledWith(channel);
  });

  it("uses the full safe pwrite offset and rejects invalid negative offsets", () => {
    const h = createFileHarness();
    const pid = h.pids[0];
    const addr = 0x1000;
    const sourcePtr = 0x7000;
    const offset = 0x1_0000_0010;
    h.setLogicalSize(offset + 1);
    expect(h.map(pid, 4, addr)).toBe(true);
    const process = new Uint8Array(h.memories.get(pid)!.buffer);
    process[sourcePtr] = 0x9a;
    const backing = Array.from((h.kw as any).sharedMmapBackings.values())[0];

    (h.kw as any).handleSharedMappingsAfterFileSyscall(
      h.channels.get(pid), ABI_SYSCALLS.Pwrite, [4, sourcePtr, 1, offset], 1, 0,
    );
    const page = Math.floor(offset / 4096);
    expect(backing.pages.get(page)[offset % 4096]).toBe(0x9a);

    const version = backing.version;
    (h.kw as any).handleSharedMappingsAfterFileSyscall(
      h.channels.get(pid), ABI_SYSCALLS.Pwrite, [4, sourcePtr, 1, -1], 1, 0,
    );
    expect(backing.sizeValid).toBe(false);
    expect(backing.version).toBeGreaterThan(version);
  });

  it("does not alias an unsafe exact pwrite offset in shared-mapping state", () => {
    const h = createFileHarness();
    const pid = h.pids[0];
    const addr = 0x1000;
    expect(h.map(pid, 4, addr)).toBe(true);
    const exactOffset = BigInt(Number.MAX_SAFE_INTEGER) + 2n;
    const backing = Array.from(
      (h.kw as any).sharedMmapBackings.values(),
    )[0];
    const version = backing.version;
    h.storage[0] = 0xe4;

    (h.kw as any).handleSharedMappingsAfterFileSyscall(
      h.channels.get(pid),
      ABI_SYSCALLS.Pwrite,
      [4, 0x7000, 1, Number(exactOffset)],
      1,
      0,
      exactOffset,
    );

    expect(backing.version).toBeGreaterThan(version);
    expect(backing.sizeValid).toBe(true);
    expect(backing.pages.get(0)?.[0]).toBe(0xe4);
  });

  it("does not publish a rounded ftruncate length to shared-mapping state", () => {
    const h = createFileHarness();
    const pid = h.pids[0];
    expect(h.map(pid, 4, 0x1000)).toBe(true);
    const backing = Array.from(
      (h.kw as any).sharedMmapBackings.values(),
    )[0];
    const exactLength = BigInt(Number.MAX_SAFE_INTEGER) + 2n;

    // Model the kernel/host file operation having completed at a size that the
    // cache can represent. The lossy Number projection of exactLength must not
    // be installed as if it were authoritative.
    h.setLogicalSize(37);
    (h.kw as any).handleSharedMappingsAfterFileSyscall(
      h.channels.get(pid),
      ABI_SYSCALLS.Ftruncate,
      [4, Number(exactLength)],
      0,
      0,
      undefined,
      exactLength,
    );

    expect(backing.size).toBe(37);
    expect(backing.sizeValid).toBe(true);
  });

  it("maps a writable kernel-owned regular file through the fd-writeback bridge", () => {
    const h = createFileHarness();
    // hostHandle === null models a kernel-owned regular file (in-kernel tmpfs
    // or memfd): fstat completes inside the kernel, so there is no persistent
    // host handle to anchor a host byte-store backing. A *writable* MAP_SHARED
    // of such a file used to be rejected outright with ENOTSUP. It now maps
    // through the fd-writeback bridge: the region is populated via the guest
    // fd (pread) and its writes flush back to the same kernel-owned file via
    // the guest fd (pwrite) at msync/munmap/exec/teardown. The kernel-owned
    // file itself is the shared backing store, so no host handle is retained.
    h.getFdStatForSharedMapping.mockReturnValue({
      kind: "ok",
      value: {
        dev: 0n,
        ino: 1n,
        size: h.logicalSize(),
        mode: REGULAR_MODE,
        hostHandle: null,
      },
    });
    expect(h.mapResult(h.pids[0], 4, 0x1000)).toEqual({ kind: "mapped" });
    // No host handle is retained: writeback rides the guest fd, not host I/O.
    expect(h.retainHostFileHandle).not.toHaveBeenCalled();
    const pidMap = (h.kw as any).sharedMappings.get(h.pids[0]);
    expect(pidMap?.size).toBe(1);
    const mapping = pidMap.get(0x1000);
    expect(mapping.writable).toBe(true);
    expect(mapping.fd).toBe(4);
    // A bare fd-tracked mapping: no host byte-store backing key.
    expect(mapping.backingKey).toBeUndefined();
  });

  it("still rejects a writable kernel-owned mapping without an O_RDWR fd", () => {
    const h = createFileHarness();
    h.getFdStatForSharedMapping.mockReturnValue({
      kind: "ok",
      value: {
        dev: 0n,
        ino: 1n,
        size: h.logicalSize(),
        mode: REGULAR_MODE,
        hostHandle: null,
      },
    });
    // O_RDONLY (0): a writable MAP_SHARED requires a read+write descriptor.
    h.getFdAccessModeForSharedMapping.mockReturnValue({ kind: "ok", value: 0 });
    expect(h.mapResult(h.pids[0], 4, 0x1000))
      .toEqual({ kind: "error", errno: 13 });
    expect((h.kw as any).sharedMappings.size).toBe(0);
  });

  it("read-only MAP_SHARED of a kernel-owned file rejects an O_WRONLY fd", () => {
    const h = createFileHarness();
    h.getFdStatForSharedMapping.mockReturnValue({
      kind: "ok",
      value: {
        dev: 0n, ino: 1n, size: h.logicalSize(), mode: REGULAR_MODE,
        hostHandle: null,
      },
    });
    h.getFdAccessModeForSharedMapping.mockReturnValue({ kind: "ok", value: 1 });
    // PROT_READ only (read-only mapping) still requires a readable descriptor.
    expect(h.mapResult(h.pids[0], 4, 0x1000, 4096, PROT_READ))
      .toEqual({ kind: "error", errno: 13 });
  });

  // Model a kernel-owned (tmpfs/memfd) regular file of a chosen size.
  const asKernelOwnedFile = (h: FileHarness, size: number) =>
    h.getFdStatForSharedMapping.mockReturnValue({
      kind: "ok",
      value: { dev: 0n, ino: 1n, size, mode: REGULAR_MODE, hostHandle: null },
    });

  it("M2: fd-writeback rides a stable dup so it survives close(fd)", () => {
    const h = createFileHarness();
    const pid = h.pids[0];
    const addr = 0x1000;
    asKernelOwnedFile(h, 4096);
    expect(h.map(pid, 4, addr)).toBe(true);
    const mapping = (h.kw as any).sharedMappings.get(pid).get(addr);
    expect(mapping.fdWriteback).toBe(true);
    // The dup (fd+1000) is an independent descriptor, not the guest fd, so a
    // later close(fd) cannot invalidate writeback.
    expect(mapping.writebackFd).toBe(1004);
    expect(h.dupWritebackFd).toHaveBeenCalledWith(pid, 4);

    const pwrite = vi.fn(() => true);
    h.kw.testAuthority.configureScratchBoundaryHooksForTest({
      pwriteFromProcessMemory: pwrite,
    });
    new Uint8Array(h.memories.get(pid)!.buffer)[addr + 5] = 0xab;
    expect((h.kw as any).flushSharedMappings(h.channels.get(pid), [addr, 4096]))
      .toBe(true);
    expect(pwrite).toHaveBeenCalled();
    for (const call of pwrite.mock.calls) expect(call[1]).toBe(1004);

    // munmap closes the owned dup exactly once.
    (h.kw as any).cleanupSharedMappings(pid, addr, 4096);
    expect(h.closeWritebackFd).toHaveBeenCalledWith(pid, 1004);
    expect(h.closeWritebackFd).toHaveBeenCalledTimes(1);
  });

  it("H1: fd-writeback never writes past the file's live EOF", () => {
    const h = createFileHarness();
    const pid = h.pids[0];
    const addr = 0x1000;
    // File is only 100 bytes though the mapping covers a whole 4096 page.
    asKernelOwnedFile(h, 100);
    expect(h.map(pid, 4, addr, 4096)).toBe(true);
    const pwrite = vi.fn(() => true);
    h.kw.testAuthority.configureScratchBoundaryHooksForTest({
      pwriteFromProcessMemory: pwrite,
    });
    const mem = new Uint8Array(h.memories.get(pid)!.buffer);
    mem[addr + 0] = 0x41;    // within EOF
    mem[addr + 200] = 0x42;  // past EOF — must never be written back
    expect((h.kw as any).flushSharedMappings(h.channels.get(pid), [addr, 4096]))
      .toBe(true);
    expect(pwrite).toHaveBeenCalled();
    for (const call of pwrite.mock.calls) {
      const len = call[3] as number;
      const fileOffset = call[4] as number;
      expect(fileOffset + len).toBeLessThanOrEqual(100);
    }
  });

  it("fd-writeback flushes only the bytes this mapping changed", () => {
    const h = createFileHarness();
    const pid = h.pids[0];
    const addr = 0x1000;
    asKernelOwnedFile(h, 4096);
    expect(h.map(pid, 4, addr, 4096)).toBe(true);
    const pwrite = vi.fn(() => true);
    h.kw.testAuthority.configureScratchBoundaryHooksForTest({
      pwriteFromProcessMemory: pwrite,
    });
    new Uint8Array(h.memories.get(pid)!.buffer)[addr + 10] = 0x55;
    expect((h.kw as any).flushSharedMappings(h.channels.get(pid), [addr, 4096]))
      .toBe(true);
    // Exactly one dirty run of length 1 at file offset 10 — a stale peer's
    // whole-mapping flush therefore cannot clobber another mapping's bytes.
    expect(pwrite).toHaveBeenCalledTimes(1);
    expect(pwrite.mock.calls[0][3]).toBe(1);
    expect(pwrite.mock.calls[0][4]).toBe(10);
  });

  it("M3: a writable fd-writeback mapping is inherited across fork", () => {
    const h = createFileHarness();
    const [parentPid, , childPid] = h.pids;
    const addr = 0x1800;
    asKernelOwnedFile(h, 4096);
    expect(h.map(parentPid, 4, addr)).toBe(true);
    h.kw.inheritProcessSharedMappings(parentPid, childPid);
    const childMap = (h.kw as any).sharedMappings.get(childPid);
    expect(childMap.size).toBe(1);
    const childMapping = childMap.get(addr);
    expect(childMapping.fdWriteback).toBe(true);
    // fork copies the fd table: the child inherits the same writeback fd.
    expect(childMapping.writebackFd).toBe(1004);
    expect(childMapping.snapshot).toBeInstanceOf(Uint8Array);
  });

  it("rejects a backend that cannot promise stable file identity", () => {
    const h = createFileHarness();
    h.io.fileHandleIdentity.mockReturnValue(null);
    expect(h.mapResult(h.pids[0], 4, 0x1000))
      .toEqual({ kind: "error", errno: 95 });
    expect(h.retainHostFileHandle).not.toHaveBeenCalled();
  });

  it("fails storage syscalls before the kernel when dirty-page flush fails", () => {
    const h = createFileHarness();
    const pid = h.pids[0];
    const addr = 0x1000;
    expect(h.map(pid, 4, addr)).toBe(true);
    new Uint8Array(h.memories.get(pid)!.buffer)[addr + 9] = 0xcc;
    h.io.write.mockReturnValueOnce(0);

    expect((h.kw as any).flushSharedMappingsBeforeFileSyscall(
      h.channels.get(pid), ABI_SYSCALLS.Pwrite, [4],
    )).toBe(false);
    // close does not need the guest fd for writeback: the stable handle owns
    // the mapping lifetime and is flushed later by msync/munmap/exit.
    expect((h.kw as any).flushSharedMappingsBeforeFileSyscall(
      h.channels.get(pid), ABI_SYSCALLS.Close, [4],
    )).toBe(true);
  });

  it("skips file-coherence hooks when no shared file backing exists", () => {
    const h = createFileHarness();
    const pid = h.pids[0];
    const cache = (h.kw as any).sharedMmapFdCache as Map<string, unknown>;
    const sentinel = { backingKey: "untouched" };
    cache.set(`${pid}:4`, sentinel);

    expect((h.kw as any).flushSharedMappingsBeforeFileSyscall(
      h.channels.get(pid), ABI_SYSCALLS.Pwrite, [4, 0, 1, 0],
    )).toBe(true);
    (h.kw as any).handleSharedMappingsAfterFileSyscall(
      h.channels.get(pid), ABI_SYSCALLS.Open, [0, 0], 4, 0,
    );

    expect(h.getFdStatForSharedMapping).not.toHaveBeenCalled();
    expect(h.getFdPathForSharedMapping).not.toHaveBeenCalled();
    expect(h.io.read).not.toHaveBeenCalled();
    expect(h.io.write).not.toHaveBeenCalled();
    expect(cache.get(`${pid}:4`)).toBe(sentinel);
  });

  it("reaps a retained zero-reference backing after writeback recovers", () => {
    const h = createFileHarness();
    const pid = h.pids[0];
    const addr = 0x1000;
    const write = h.io.write.getMockImplementation()!;
    expect(h.map(pid, 4, addr)).toBe(true);
    new Uint8Array(h.memories.get(pid)!.buffer)[addr + 7] = 0xee;
    (h.kw as any).syncFileSharedMappingsFromProcess(
      (h.kw as any).processes.get(pid),
      { force: true },
    );
    h.io.write.mockReturnValue(0);

    (h.kw as any).cleanupSharedMappings(pid, addr, 4096);
    const backing = Array.from((h.kw as any).sharedMmapBackings.values())[0];
    expect(backing.refCount).toBe(0);
    expect(backing.dirtyPages.has(0)).toBe(true);
    expect(h.close).not.toHaveBeenCalledWith(backing.handle);

    h.io.write.mockImplementation(write);
    expect((h.kw as any).flushSharedMappingsBeforeFileSyscall(
      h.channels.get(pid), ABI_SYSCALLS.Pwrite, [4, 0, 1, 0],
    )).toBe(true);
    expect((h.kw as any).sharedMmapBackings.size).toBe(0);
    expect(h.releaseHostFileHandle).toHaveBeenCalledWith(backing.handle);
    expect(h.close).not.toHaveBeenCalledWith(backing.handle);
  });

  it("releases mixed anonymous and file mappings through their own backings", () => {
    const h = createFileHarness();
    const pid = h.pids[0];
    const fileAddr = 0x1000;
    const anonymousAddr = 0x3000;
    expect(h.map(pid, 4, fileAddr)).toBe(true);
    const fileBacking = Array.from((h.kw as any).sharedMmapBackings.values())[0];
    (h.kw as any).trackAnonymousSharedMapping(
      h.channels.get(pid),
      anonymousAddr,
      [0, 4096, PROT_WRITE, MAP_SHARED | MAP_ANONYMOUS, -1, 0],
    );
    expect((h.kw as any).sharedMappings.get(pid).size).toBe(2);
    expect((h.kw as any).anonymousSharedBackings.size).toBe(1);

    (h.kw as any).releaseAllSharedMemoryForProcess(pid, false);

    expect((h.kw as any).sharedMappings.has(pid)).toBe(false);
    expect((h.kw as any).sharedMmapBackings.size).toBe(0);
    expect((h.kw as any).anonymousSharedBackings.size).toBe(0);
    expect(fileBacking.refCount).toBe(0);
    expect(h.releaseHostFileHandle).toHaveBeenCalledWith(fileBacking.handle);
    expect(h.close).not.toHaveBeenCalledWith(fileBacking.handle);
  });
});
