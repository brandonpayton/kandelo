import { describe, expect, it } from "vitest";
import {
  linkSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { makeHostScratchTempRoot } from "./centralized-test-helper";

import { resolveBinary } from "../src/binary-resolver";
import {
  CAPTURED_STDIO,
  createCentralizedKernelWorkerTestDouble,
} from "../src/kernel-worker";
import { NodePlatformIO } from "../src/platform/node";
import type { PlatformIO } from "../src/types";
import { MemoryFileSystem } from "../src/vfs/memory-fs";
import { NodeTimeProvider } from "../src/vfs/time";
import { VirtualPlatformIO } from "../src/vfs/vfs";
import {
  computeProcessMemoryLayout,
  createProcessMemory,
  type ProcessMemoryLayout,
} from "../src/process-memory";
import { CH_TOTAL_SIZE } from "../src/constants";
import {
  ABI_SYSCALLS,
  CHANNEL_STATUS_PENDING,
  CH_ARGS,
  CH_ARG_SIZE,
  CH_DATA,
  CH_ERRNO,
  CH_RETURN,
  CH_STATUS,
  CH_SYSCALL,
  FCNTL_FLOCK_BYTES,
} from "../src/generated/abi";
// The in-kernel tmpfs owns the scratch prefixes unconditionally, so these
// advisory-lock cases stage their host-backed files outside every scratch
// prefix (`makeHostScratchTempRoot`) and drive them through NodePlatformIO to
// exercise host-file identity (rename/unlink/recreate, fork inheritance).


const O_RDWR = 2;
const O_CREAT = 0o100;
const F_SETLK64 = 13;
const F_SETLKW64 = 14;
const F_OFD_SETLK = 37;
const F_RDLCK = 0;
const F_WRLCK = 1;
const F_UNLCK = 2;
const EAGAIN = 11;
const ENOLCK = 37;
const MAX_LOCK_RECORDS = 4096;

interface ProcessMemory {
  memory: WebAssembly.Memory;
  channelOffset: number;
  layout: ProcessMemoryLayout;
}

interface SyscallResult {
  value: number;
  errno: number;
}

interface ChannelArgument {
  readonly channelOffset: number;
  readonly length: number;
}

function channelArgument(
  channelOffset: number,
  length: number,
): ChannelArgument {
  return { channelOffset, length };
}

type AdvisoryLockTestWorker =
  ReturnType<typeof createCentralizedKernelWorkerTestDouble>;

interface ChannelTransferBuffer {
  copyFrom(source: Uint8Array, targetOffset: number): void;
  fill(value: number, targetOffset: number, length: number): void;
  dataView(targetOffset: number, length: number): DataView;
}

const processMemoryByWorker = new WeakMap<
  AdvisoryLockTestWorker,
  Map<number, ProcessMemory>
>();

function loadKernelWasm(): ArrayBuffer {
  const bytes = readFileSync(resolveBinary("kernel.wasm"));
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  );
}

function makeProcessMemory(): ProcessMemory {
  const layout = computeProcessMemoryLayout({
    ptrWidth: 4,
    heapBase: 0x0012_0000,
    minPages: 18,
    maxPages: 1024,
  });
  const memory = createProcessMemory(4, layout);
  const channelOffset = layout.channelOffset;
  new Uint8Array(memory.buffer, channelOffset, CH_TOTAL_SIZE).fill(0);
  return { memory, channelOffset, layout };
}

function register(
  worker: AdvisoryLockTestWorker,
): number {
  const pid = worker.createProcess(CAPTURED_STDIO);
  registerExistingProcess(worker, pid);
  return pid;
}

function registerExistingProcess(
  worker: AdvisoryLockTestWorker,
  pid: number,
): ProcessMemory {
  const entry = makeProcessMemory();
  worker.registerProcess(pid, entry.memory, [entry.channelOffset], {
    brkBase: entry.layout.brkBase,
    mmapBase: entry.layout.mmapBase,
    maxAddr: entry.layout.maxAddr,
  });
  let processes = processMemoryByWorker.get(worker);
  if (processes === undefined) {
    processes = new Map();
    processMemoryByWorker.set(worker, processes);
  }
  processes.set(pid, entry);
  return entry;
}

function assertChannelTransferRange(offset: number, length: number): void {
  if (
    !Number.isSafeInteger(offset)
    || offset < 0
    || !Number.isSafeInteger(length)
    || length < 0
    || offset > CH_TOTAL_SIZE - length
  ) {
    throw new RangeError("test channel transfer is outside its allocation");
  }
}

function issue(
  worker: AdvisoryLockTestWorker,
  pid: number,
  syscall: number,
  args: Array<number | bigint>,
): SyscallResult {
  return issuePrepared(worker, pid, syscall, () => args);
}

function issuePrepared(
  worker: AdvisoryLockTestWorker,
  pid: number,
  syscall: number,
  prepareArgs: (
    transfer: ChannelTransferBuffer,
  ) => Array<number | bigint | ChannelArgument>,
): SyscallResult {
  const entry = processMemoryByWorker.get(worker)?.get(pid);
  if (entry === undefined) {
    throw new Error(`process ${pid} has no test-owned Memory`);
  }
  const channelBytes = new Uint8Array(
    entry.memory.buffer,
    entry.channelOffset,
    CH_TOTAL_SIZE,
  );
  channelBytes.fill(0);
  const transfer: ChannelTransferBuffer = {
    copyFrom(source, targetOffset): void {
      assertChannelTransferRange(targetOffset, source.byteLength);
      channelBytes.set(source, targetOffset);
    },
    fill(value, targetOffset, length): void {
      assertChannelTransferRange(targetOffset, length);
      channelBytes.fill(value, targetOffset, targetOffset + length);
    },
    dataView(targetOffset, length): DataView {
      assertChannelTransferRange(targetOffset, length);
      return new DataView(
        entry.memory.buffer,
        entry.channelOffset + targetOffset,
        length,
      );
    },
  };
  const args = prepareArgs(transfer);
  const channel = new DataView(
    entry.memory.buffer,
    entry.channelOffset,
    CH_TOTAL_SIZE,
  );
  channel.setUint32(CH_SYSCALL, syscall, true);
  channel.setUint32(CH_ERRNO, 0, true);
  channel.setBigInt64(CH_RETURN, 0n, true);
  for (let index = 0; index < 6; index++) {
    const argument = args[index] ?? 0;
    const value = typeof argument === "object"
      ? (() => {
          assertChannelTransferRange(
            argument.channelOffset,
            argument.length,
          );
          return entry.channelOffset + argument.channelOffset;
        })()
      : argument;
    channel.setBigInt64(
      CH_ARGS + index * CH_ARG_SIZE,
      BigInt(value),
      true,
    );
  }
  // Publish the complete caller-owned request last. The exact test companion
  // accepts only this registered main mailbox in PENDING state and never
  // returns the channel or underlying kernel authority.
  Atomics.store(
    new Int32Array(entry.memory.buffer, entry.channelOffset),
    CH_STATUS / Int32Array.BYTES_PER_ELEMENT,
    CHANNEL_STATUS_PENDING,
  );
  worker.testAuthority.dispatchRegisteredMainChannelForAdvisoryLockTest(pid);
  const result = new DataView(
    entry.memory.buffer,
    entry.channelOffset,
    CH_TOTAL_SIZE,
  );
  return {
    value: Number(result.getBigInt64(CH_RETURN, true)),
    errno: result.getUint32(CH_ERRNO, true),
  };
}

function openFile(
  worker: AdvisoryLockTestWorker,
  pid: number,
  path: string,
): number {
  const encoded = new TextEncoder().encode(`${path}\0`);
  const result = issuePrepared(
    worker,
    pid,
    ABI_SYSCALLS.Open,
    (transfer) => {
      transfer.copyFrom(encoded, CH_DATA);
      return [
        channelArgument(CH_DATA, encoded.byteLength),
        O_RDWR,
        0,
      ];
    },
  );
  expect(result.errno).toBe(0);
  expect(result.value).toBeGreaterThanOrEqual(3);
  return result.value;
}

function closeFile(
  worker: AdvisoryLockTestWorker,
  pid: number,
  fd: number,
): void {
  expect(issue(worker, pid, ABI_SYSCALLS.Close, [fd])).toEqual({
    value: 0,
    errno: 0,
  });
}

function lock(
  worker: AdvisoryLockTestWorker,
  pid: number,
  fd: number,
  start: bigint,
  len: bigint,
  type = F_WRLCK,
  command = F_SETLK64,
): SyscallResult {
  return issuePrepared(
    worker,
    pid,
    ABI_SYSCALLS.Fcntl,
    (transfer) => {
      transfer.fill(0, CH_DATA, FCNTL_FLOCK_BYTES);
      const flock = transfer.dataView(CH_DATA, FCNTL_FLOCK_BYTES);
      flock.setInt16(0, type, true);
      flock.setInt16(2, 0, true); // SEEK_SET
      flock.setBigInt64(8, start, true);
      flock.setBigInt64(16, len, true);
      // l_pid remains zero, as required for F_OFD_* commands.
      return [fd, command, channelArgument(CH_DATA, FCNTL_FLOCK_BYTES)];
    },
  );
}

async function makeWorker(
  platform: PlatformIO = new NodePlatformIO(),
): Promise<AdvisoryLockTestWorker> {
  const worker = createCentralizedKernelWorkerTestDouble({
    config: {
      maxWorkers: 4,
      dataBufferSize: 65_536,
      useSharedMemory: true,
    },
    io: platform,
  });
  await worker.init(loadKernelWasm());
  return worker;
}

describe("Rust advisory locks through the real kernel Wasm", () => {
  it("qualifies file identity by backend object, not mount path", async () => {
    const root = MemoryFileSystem.create(new SharedArrayBuffer(1024 * 1024));
    const first = MemoryFileSystem.create(new SharedArrayBuffer(1024 * 1024));
    const second = MemoryFileSystem.create(new SharedArrayBuffer(1024 * 1024));
    for (const backend of [first, second]) {
      const handle = backend.open("/file", O_CREAT | O_RDWR, 0o600);
      backend.close(handle);
    }
    // Both independent backends allocate the same first regular-file inode.
    expect(first.stat("/file").ino).toBe(second.stat("/file").ino);

    const platform = new VirtualPlatformIO(
      [
        { mountPoint: "/", backend: root },
        { mountPoint: "/first", backend: first },
        { mountPoint: "/second", backend: second },
        { mountPoint: "/first-alias", backend: first },
      ],
      new NodeTimeProvider(),
    );
    const worker = await makeWorker(platform);
    const firstPid = register(worker);
    const secondPid = register(worker);
    const aliasPid = register(worker);

    try {
      const firstFd = openFile(worker, firstPid, "/first/file");
      const secondFd = openFile(worker, secondPid, "/second/file");
      const aliasFd = openFile(worker, aliasPid, "/first-alias/file");

      expect(lock(worker, firstPid, firstFd, 0n, 1n)).toEqual({
        value: 0,
        errno: 0,
      });
      // Equal backend-local inode values from distinct backend objects do not
      // alias after VirtualPlatformIO qualifies their device namespaces.
      expect(lock(worker, secondPid, secondFd, 0n, 1n)).toEqual({
        value: 0,
        errno: 0,
      });
      // Two mount points of the same backend still name the same file object.
      expect(lock(worker, aliasPid, aliasFd, 0n, 1n)).toEqual({
        value: -1,
        errno: EAGAIN,
      });

      closeFile(worker, firstPid, firstFd);
      closeFile(worker, secondPid, secondFd);
      closeFile(worker, aliasPid, aliasFd);
    } finally {
      worker.unregisterProcess(firstPid);
      worker.unregisterProcess(secondPid);
      worker.unregisterProcess(aliasPid);
    }
  });

  it("uses live file identity across aliases, rename, unlink, and recreate", async () => {
    const root = makeHostScratchTempRoot("kandelo-advisory-identity-");
    const original = join(root, "database");
    const alias = join(root, "database-link");
    const renamed = join(root, "database-renamed");
    writeFileSync(original, "old");
    linkSync(original, alias);

    const worker = await makeWorker();
    const ownerPid = register(worker);
    const peerPid = register(worker);
    const recreatedPid = register(worker);

    try {
      const ownerFd = openFile(worker, ownerPid, original);
      // This independent descriptor is deliberately the one closed below:
      // POSIX requires closing any descriptor for the file to drop all of the
      // process's locks, not only the descriptor used to set the lock.
      const ownerAliasFd = openFile(worker, ownerPid, alias);
      const peerFd = openFile(worker, peerPid, alias);

      expect(lock(worker, ownerPid, ownerFd, 0n, 1n)).toEqual({
        value: 0,
        errno: 0,
      });
      expect(lock(worker, peerPid, peerFd, 0n, 1n)).toEqual({
        value: -1,
        errno: EAGAIN,
      });

      renameSync(original, renamed);
      unlinkSync(alias);
      unlinkSync(renamed);
      // Both live handles still identify the unlinked object.
      expect(lock(worker, peerPid, peerFd, 0n, 1n)).toEqual({
        value: -1,
        errno: EAGAIN,
      });

      writeFileSync(original, "new");
      const recreatedFd = openFile(worker, recreatedPid, original);
      // A recreated pathname is a different object even while the old inode
      // remains open and locked.
      expect(lock(worker, recreatedPid, recreatedFd, 0n, 1n)).toEqual({
        value: 0,
        errno: 0,
      });

      closeFile(worker, ownerPid, ownerAliasFd);
      expect(lock(worker, peerPid, peerFd, 0n, 1n)).toEqual({
        value: 0,
        errno: 0,
      });

      // Forced process removal is the process-worker crash path.
      worker.unregisterProcess(peerPid);
      expect(lock(worker, ownerPid, ownerFd, 0n, 1n)).toEqual({
        value: 0,
        errno: 0,
      });

      closeFile(worker, ownerPid, ownerFd);
      closeFile(worker, recreatedPid, recreatedFd);
    } finally {
      worker.unregisterProcess(ownerPid);
      worker.unregisterProcess(peerPid);
      worker.unregisterProcess(recreatedPid);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not inherit POSIX process locks across fork", async () => {
    const root = makeHostScratchTempRoot("kandelo-advisory-process-fork-");
    const path = join(root, "file");
    writeFileSync(path, "data");
    const worker = await makeWorker();
    const parentPid = register(worker);
    const peerPid = register(worker);
    let childPid: number | undefined;

    try {
      const parentFd = openFile(worker, parentPid, path);
      const peerFd = openFile(worker, peerPid, path);
      expect(lock(worker, parentPid, parentFd, 0n, 1n)).toEqual({
        value: 0,
        errno: 0,
      });

      childPid = worker.testAuthority.forkKernelProcessForAdvisoryLockTest(
        parentPid,
        parentPid,
      );
      expect(childPid).toBeGreaterThan(0);
      registerExistingProcess(worker, childPid);
      expect(lock(worker, peerPid, peerFd, 0n, 1n)).toEqual({
        value: -1,
        errno: EAGAIN,
      });

      // Only the parent owns the POSIX record. Closing its descriptor removes
      // the record; the child inherited the fd, but not the process lock.
      closeFile(worker, parentPid, parentFd);
      expect(lock(worker, peerPid, peerFd, 0n, 1n)).toEqual({
        value: 0,
        errno: 0,
      });

      closeFile(worker, childPid, parentFd);
      closeFile(worker, peerPid, peerFd);
    } finally {
      if (childPid !== undefined) worker.unregisterProcess(childPid);
      worker.unregisterProcess(parentPid);
      worker.unregisterProcess(peerPid);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps OFD locks through dup and fork until the last machine reference", async () => {
    const root = makeHostScratchTempRoot("kandelo-advisory-ofd-");
    const path = join(root, "file");
    writeFileSync(path, "data");
    const worker = await makeWorker();
    const ownerPid = register(worker);
    const peerPid = register(worker);
    let childPid: number | undefined;

    try {
      const ownerFd = openFile(worker, ownerPid, path);
      const duplicate = issue(worker, ownerPid, ABI_SYSCALLS.Dup, [ownerFd]);
      expect(duplicate.errno).toBe(0);
      const peerFd = openFile(worker, peerPid, path);

      expect(lock(worker, ownerPid, ownerFd, 0n, 1n, F_WRLCK, F_OFD_SETLK))
        .toEqual({ value: 0, errno: 0 });
      expect(lock(worker, peerPid, peerFd, 0n, 1n, F_WRLCK, F_OFD_SETLK))
        .toEqual({ value: -1, errno: EAGAIN });

      childPid = worker.testAuthority.forkKernelProcessForAdvisoryLockTest(
        ownerPid,
        ownerPid,
      );
      expect(childPid).toBeGreaterThan(0);
      registerExistingProcess(worker, childPid);

      closeFile(worker, ownerPid, ownerFd);
      closeFile(worker, ownerPid, duplicate.value);
      // The child inherited the same OfdId, so the lock is still live.
      expect(lock(worker, peerPid, peerFd, 0n, 1n, F_WRLCK, F_OFD_SETLK))
        .toEqual({ value: -1, errno: EAGAIN });

      closeFile(worker, childPid, ownerFd);
      closeFile(worker, childPid, duplicate.value);
      expect(lock(worker, peerPid, peerFd, 0n, 1n, F_WRLCK, F_OFD_SETLK))
        .toEqual({ value: 0, errno: 0 });

      closeFile(worker, peerPid, peerFd);
    } finally {
      if (childPid !== undefined) worker.unregisterProcess(childPid);
      worker.unregisterProcess(ownerPid);
      worker.unregisterProcess(peerPid);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("stores 4096 separated ranges and reports conflict before exhaustion", async () => {
    const root = makeHostScratchTempRoot("kandelo-advisory-capacity-");
    const path = join(root, "file");
    writeFileSync(path, "capacity");
    const worker = await makeWorker();
    const ownerPid = register(worker);
    const peerPid = register(worker);

    try {
      const fd = openFile(worker, ownerPid, path);
      const peerFd = openFile(worker, peerPid, path);
      for (let index = 0; index < MAX_LOCK_RECORDS; index++) {
        expect(lock(worker, ownerPid, fd, BigInt(index * 2), 1n)).toEqual({
          value: 0,
          errno: 0,
        });
      }

      expect(lock(
        worker,
        ownerPid,
        fd,
        BigInt(MAX_LOCK_RECORDS * 2),
        1n,
        F_WRLCK,
        F_SETLKW64,
      ))
        .toEqual({ value: -1, errno: ENOLCK });
      expect(lock(worker, peerPid, peerFd, 0n, 1n)).toEqual({
        value: -1,
        errno: EAGAIN,
      });

      // Unlock and reuse one normalized-record slot without shrinking the
      // manager's high-water allocation.
      expect(lock(worker, ownerPid, fd, 0n, 1n, F_UNLCK)).toEqual({
        value: 0,
        errno: 0,
      });
      expect(lock(worker, ownerPid, fd, BigInt(MAX_LOCK_RECORDS * 2), 1n))
        .toEqual({ value: 0, errno: 0 });

      // A same-owner conversion is non-growing and still succeeds at capacity.
      expect(lock(worker, ownerPid, fd, 2n, 1n, F_RDLCK)).toEqual({
        value: 0,
        errno: 0,
      });

      closeFile(worker, ownerPid, fd);
      closeFile(worker, peerPid, peerFd);
    } finally {
      worker.unregisterProcess(ownerPid);
      worker.unregisterProcess(peerPid);
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
});
