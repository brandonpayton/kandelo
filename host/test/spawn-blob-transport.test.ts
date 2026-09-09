import { describe, expect, it, vi } from "vitest";

import {
  type CentralizedKernelCallbacks,
  createCentralizedKernelWorkerTestDouble,
  SPAWN_BLOB_MAX_BYTES,
} from "../src/kernel-worker";
import {
  createKernelEntryGatedInstance,
  KernelEntryGate,
  KernelReentrantEntryError,
} from "../src/kernel-entry-gate";
import {
  CHANNEL_STATUS_PENDING,
  CH_DATA_SIZE,
  CH_STATUS,
  CH_TOTAL_SIZE,
  HOST_INTERCEPTED_SYSCALLS,
  POSIX_ARG_MAX_BYTES,
  POSIX_PATH_MAX_BYTES,
  SPAWN_MAX_ACTION_COUNT,
  SPAWN_MAX_ARGV_COUNT,
  SPAWN_MAX_ENVP_COUNT,
  SPAWN_WIRE_ACTION_OP_OFFSET,
  SPAWN_WIRE_ACTION_RECORD_BYTES,
  SPAWN_WIRE_HEADER_ACTION_COUNT_OFFSET,
  SPAWN_WIRE_HEADER_ARGC_OFFSET,
  SPAWN_WIRE_HEADER_BYTES,
  SPAWN_WIRE_HEADER_ENVC_OFFSET,
  SPAWN_WIRE_OP_CLOSE,
  SPAWN_WIRE_STRING_OFFSET_BYTES,
} from "../src/generated/abi";
import { allocateKernelScratchRegion } from "../src/kernel-scratch";
import { createKernelScratchTestInstance } from "./support/kernel-scratch-instance";
import { mockKernelSpawnBlobDecode } from "./support/spawn-blob-decode-mock";

const E2BIG = 7;
const EBUSY = 16;
const EFAULT = 14;
const EINVAL = 22;
const EIO = 5;
const ENOMEM = 12;
const ENAMETOOLONG = 36;

describe("SYS_SPAWN blob transport", () => {
  it("reports the Rust-owned retained capacity losslessly", () => {
    const worker = createWorker({
      pointerWidth: 8,
      kernelExports: {
        kernel_spawn_scratch_retained_capacity: vi.fn(() => 84_386n),
      },
    });

    expect(worker.getSpawnScratchCapacity()).toBe(84_386);
  });

  it("grows one Rust-owned reservation to the requested high-water mark", async () => {
    const firstBlob = new Uint8Array(CH_TOTAL_SIZE + 1024).fill(0x31);
    const reusedBlob = new Uint8Array(firstBlob.byteLength + 512).fill(0x32);
    const grownBlob = new Uint8Array(firstBlob.byteLength + 4096).fill(0x33);
    const firstPointer = 2 * CH_TOTAL_SIZE;
    const grownPointer = firstPointer + firstBlob.byteLength + 8192;
    const kernelMemory = new WebAssembly.Memory({
      initial: 8,
      maximum: 8,
    });
    let reservationPointer = firstPointer;
    let reservationCapacity = reusedBlob.byteLength;
    let nextToken = 1n;
    const beginSpawnScratch = vi.fn((minimum: number) => {
      if (minimum > reservationCapacity) {
        reservationPointer = grownPointer;
        reservationCapacity = minimum;
      }
      return nextToken++;
    });
    const spawnScratchPointer = vi.fn(() => reservationPointer);
    const spawnScratchCapacity = vi.fn(() => reservationCapacity);
    const cancelSpawnScratch = vi.fn(() => -EINVAL);
    const kernelReservedSpawn = vi.fn((
      _parentPid: number,
      _callerTid: number,
      token: bigint,
      length: number,
    ) => {
      expect(token).toBe(nextToken - 1n);
      expect(
        new Uint8Array(kernelMemory.buffer).slice(
          reservationPointer,
          reservationPointer + length,
        ),
      ).toEqual(
        length === firstBlob.byteLength
          ? firstBlob
          : length === reusedBlob.byteLength
          ? reusedBlob
          : grownBlob,
      );
      return 42;
    });
    const worker = createWorker({
      callbacks: { onSpawn: vi.fn(() => new Promise<number>(() => {})) },
      kernelMemory,
      scratchPointer: 1024,
      kernelExports: {
        kernel_spawn_scratch_begin: beginSpawnScratch,
        kernel_spawn_scratch_pointer: spawnScratchPointer,
        kernel_spawn_scratch_capacity: spawnScratchCapacity,
        kernel_spawn_scratch_cancel: cancelSpawnScratch,
        kernel_spawn_reserved_process: kernelReservedSpawn,
      },
    });
    const invoke = (blob: Uint8Array) => worker.handleSpawnAfterResolve(
      createChannel(7, sharedMemoryFor(65_536)),
      [0, 0, 0, blob.byteLength, 0, 0],
      7,
      7,
      0,
      blob,
      blob.byteLength,
      resolvedProgram(),
      [],
    );

    invoke(firstBlob);
    await drainSpawnGate();
    expect(beginSpawnScratch).toHaveBeenCalledWith(firstBlob.byteLength);
    expect(kernelReservedSpawn).toHaveBeenLastCalledWith(
      7,
      7,
      1n,
      firstBlob.byteLength,
    );

    invoke(reusedBlob);
    await drainSpawnGate();
    expect(beginSpawnScratch).toHaveBeenCalledTimes(2);
    expect(kernelReservedSpawn).toHaveBeenLastCalledWith(
      7,
      7,
      2n,
      reusedBlob.byteLength,
    );

    invoke(grownBlob);
    await drainSpawnGate();
    expect(beginSpawnScratch).toHaveBeenCalledTimes(3);
    expect(beginSpawnScratch).toHaveBeenLastCalledWith(grownBlob.byteLength);
    expect(kernelReservedSpawn).toHaveBeenLastCalledWith(
      7,
      7,
      3n,
      grownBlob.byteLength,
    );
    expect(spawnScratchPointer).toHaveBeenCalledTimes(3);
    expect(cancelSpawnScratch).toHaveBeenCalledTimes(3);
    expect(cancelSpawnScratch).toHaveBeenNthCalledWith(1, 1n);
    expect(cancelSpawnScratch).toHaveBeenNthCalledWith(2, 2n);
    expect(cancelSpawnScratch).toHaveBeenNthCalledWith(3, 3n);
  });

  it("preserves a lossless wasm64 reservation pointer and capacity", () => {
    const blob = new Uint8Array(CH_TOTAL_SIZE + 1).fill(0x4a);
    const pointer = 8192n;
    const kernelMemory = new WebAssembly.Memory({ initial: 4, maximum: 4 });
    const beginSpawnScratch = vi.fn(() => 77n);
    const kernelReservedSpawn = vi.fn(() => 42);
    const worker = createWorker({
      pointerWidth: 8,
      callbacks: { onSpawn: vi.fn(() => new Promise<number>(() => {})) },
      kernelMemory,
      kernelExports: {
        kernel_spawn_scratch_begin: beginSpawnScratch,
        kernel_spawn_scratch_pointer: vi.fn(() => pointer),
        kernel_spawn_scratch_capacity: vi.fn(() => BigInt(blob.byteLength)),
        kernel_spawn_scratch_cancel: vi.fn(() => -EINVAL),
        kernel_spawn_reserved_process: kernelReservedSpawn,
      },
    });

    worker.handleSpawnAfterResolve(
      createChannel(7, sharedMemoryFor(65_536)),
      [0, 0, 0, blob.byteLength, 0, 0],
      7,
      7,
      0,
      blob,
      blob.byteLength,
      resolvedProgram(),
      [],
    );

    expect(beginSpawnScratch).toHaveBeenCalledWith(BigInt(blob.byteLength));
    expect(kernelReservedSpawn).toHaveBeenCalledWith(
      7,
      7,
      77n,
      BigInt(blob.byteLength),
    );
  });

  it.each([
    {
      name: "allocator failure",
      beginResult: -12n,
      pointer: 0,
      capacity: CH_TOTAL_SIZE + 1,
      errno: ENOMEM,
      expectedCancels: 0,
    },
    {
      name: "capacity below the request",
      beginResult: 1n,
      pointer: 4096,
      capacity: CH_TOTAL_SIZE,
      errno: EIO,
      expectedCancels: 1,
    },
    {
      name: "range beyond kernel memory",
      beginResult: 2n,
      pointer: 65_536,
      capacity: CH_TOTAL_SIZE + 1,
      errno: EIO,
      expectedCancels: 1,
    },
  ])("rejects a growable reservation with $name", ({
    beginResult,
    pointer,
    capacity,
    errno,
    expectedCancels,
  }) => {
    const blob = new Uint8Array(CH_TOTAL_SIZE + 1);
    const completeChannel = vi.fn();
    const kernelReservedSpawn = vi.fn();
    const cancelSpawnScratch = vi.fn(() => 0);
    const worker = createWorker({
      callbacks: { onSpawn: vi.fn() },
      completeChannel,
      kernelMemory: new WebAssembly.Memory({ initial: 2, maximum: 2 }),
      kernelExports: {
        kernel_spawn_scratch_begin: vi.fn(() => beginResult),
        kernel_spawn_scratch_pointer: vi.fn(() => pointer),
        kernel_spawn_scratch_capacity: vi.fn(() => capacity),
        kernel_spawn_scratch_cancel: cancelSpawnScratch,
        kernel_spawn_reserved_process: kernelReservedSpawn,
      },
    });
    const channel = createChannel(7, sharedMemoryFor(65_536));
    const args = [0, 0, 0, blob.byteLength, 0, 0];

    worker.handleSpawnAfterResolve(
      channel,
      args,
      7,
      7,
      0,
      blob,
      blob.byteLength,
      resolvedProgram(),
      [],
    );

    expect(kernelReservedSpawn).not.toHaveBeenCalled();
    expect(cancelSpawnScratch).toHaveBeenCalledTimes(expectedCancels);
    expect(completeChannel).toHaveBeenCalledWith(
      channel,
      HOST_INTERCEPTED_SYSCALLS.SYS_SPAWN,
      args,
      undefined,
      -1,
      errno,
    );
  });

  it("uses one exclusive reservation per large spawn while reusing capacity", async () => {
    const parentPid = 7;
    const childPid = 42;
    const path = new TextEncoder().encode("/bin/child");
    const envp = Array.from(
      { length: 96 },
      (_, index) => `SPAWN_ENV_${index}=${"x".repeat(1024)}`,
    );
    const blob = buildSpawnBlob(["child", "success"], envp);
    expect(blob.byteLength).toBeGreaterThan(CH_TOTAL_SIZE);

    const processMemory = sharedMemoryFor(4096 + blob.byteLength);
    const processBytes = new Uint8Array(processMemory.buffer);
    const pathPtr = 256;
    const blobPtr = 4096;
    const pidOutPtr = 512;
    processBytes.set(path, pathPtr);
    processBytes.set(blob, blobPtr);

    const generalScratchOffset = 1024;
    const largeScratchOffset = 2 * CH_TOTAL_SIZE;
    const kernelPages = Math.ceil(
      (largeScratchOffset + blob.byteLength) / 65_536,
    );
    const kernelMemory = new WebAssembly.Memory({
      initial: kernelPages,
      maximum: kernelPages,
    });
    const kernelBytes = new Uint8Array(kernelMemory.buffer);
    kernelBytes.fill(
      0xa5,
      generalScratchOffset,
      generalScratchOffset + CH_TOTAL_SIZE,
    );
    let token = 0n;
    const beginSpawnScratch = vi.fn(() => ++token);
    const kernelReservedSpawn = vi.fn((
      actualParentPid: number,
      actualCallerTid: number,
      actualToken: bigint,
      actualBlobLen: number,
    ) => {
      expect(actualParentPid).toBe(parentPid);
      expect(actualCallerTid).toBe(parentPid);
      expect(actualToken).toBe(token);
      expect(actualBlobLen).toBe(blob.byteLength);
      expect(
        kernelBytes.slice(
          largeScratchOffset,
          largeScratchOffset + actualBlobLen,
        ),
      ).toEqual(blob);
      return childPid;
    });
    const onSpawn = vi.fn(() => new Promise<number>(() => {}));
    const onResolveSpawn = vi.fn(async () => resolvedProgram());
    const completeChannel = vi.fn();
    const channel = createChannel(parentPid, processMemory);
    const worker = createWorker({
      callbacks: {
        onResolveSpawn,
        onSpawn,
      },
      completeChannel,
      kernelMemory,
      scratchPointer: generalScratchOffset,
      kernelExports: {
        kernel_spawn_scratch_begin: beginSpawnScratch,
        kernel_spawn_scratch_pointer: vi.fn(() => largeScratchOffset),
        kernel_spawn_scratch_capacity: vi.fn(() => blob.byteLength),
        kernel_spawn_scratch_cancel: vi.fn(() => -EINVAL),
        kernel_spawn_reserved_process: kernelReservedSpawn,
      },
    });
    const args = [
      pathPtr,
      path.byteLength,
      blobPtr,
      blob.byteLength,
      pidOutPtr,
      0,
    ];

    worker.handleSpawn(channel, args);
    await drainSpawnGate();

    expect(onResolveSpawn).toHaveBeenCalledOnce();
    expect(completeChannel).not.toHaveBeenCalled();
    // The kernel now owns the blob decode, so a large blob reserves the shared
    // spawn scratch once during the preflight argv/envp decode (begin+cancel)
    // and again for the transport that follows resolution.
    expect(beginSpawnScratch).toHaveBeenCalledTimes(2);
    expect(beginSpawnScratch).toHaveBeenCalledWith(blob.byteLength);
    expect(kernelReservedSpawn).toHaveBeenCalledOnce();
    expect(onSpawn).toHaveBeenCalledWith(
      parentPid,
      childPid,
      expect.any(Object),
      envp,
    );
    // The large blob never occupies main scratch. The mandatory final-target
    // transaction legitimately reuses its bounded prefix for the path/read;
    // bytes beyond both exact transfers must remain untouched.
    const preparedBytes = new Uint8Array(resolvedProgram().programBytes);
    expect(
      kernelBytes.slice(
        generalScratchOffset,
        generalScratchOffset + preparedBytes.byteLength,
      ),
    ).toEqual(preparedBytes);
    expect(
      kernelBytes.slice(
        generalScratchOffset + path.byteLength,
        generalScratchOffset + CH_TOTAL_SIZE,
      ),
    ).toEqual(
      new Uint8Array(CH_TOTAL_SIZE - path.byteLength).fill(0xa5),
    );

    worker.handleSpawnAfterResolve(
      channel,
      args,
      parentPid,
      parentPid,
      pidOutPtr,
      blob,
      blob.byteLength,
      resolvedProgram(),
      envp,
    );
    // The direct after-resolve call performs transport only (no preflight
    // decode), so this is the third reservation overall: preflight decode (1),
    // drained transport (2), and this transport (3).
    expect(beginSpawnScratch).toHaveBeenCalledTimes(3);
    expect(kernelReservedSpawn).toHaveBeenCalledTimes(2);
  });

  it("ignores a resolver module that was not compiled from its candidate bytes", async () => {
    const candidateBytes = moduleWithNamedExport("aaaa");
    const mismatchedModule = new WebAssembly.Module(
      moduleWithNamedExport("bbbb"),
    );

    const launched = await launchCandidateBindingSpawn({
      candidateBytes,
      candidateModule: mismatchedModule,
      authoritativeBytes: candidateBytes,
    });

    expect(WebAssembly.Module.exports(launched.programModule)).toEqual([
      { name: "aaaa", kind: "function" },
    ]);
    expect(launched.programModule).not.toBe(mismatchedModule);
  });

  it("binds the candidate module before resolver bytes mutate after preflight", async () => {
    const candidateBytes = moduleWithNamedExport("aaaa");
    const authoritativeBytes = moduleWithNamedExport("bbbb");
    const resolverModule = new WebAssembly.Module(candidateBytes);

    const launched = await launchCandidateBindingSpawn({
      candidateBytes,
      candidateModule: resolverModule,
      authoritativeBytes,
      afterPreflight: () => candidateBytes.set(authoritativeBytes),
    });

    expect(WebAssembly.Module.exports(launched.programModule)).toEqual([
      { name: "bbbb", kind: "function" },
    ]);
    expect(launched.programModule).not.toBe(resolverModule);
  });

  it("keeps ordinary spawn blobs in the existing channel-sized scratch", () => {
    const blob = buildSpawnBlob(["child"], ["A=B"]);
    const kernelMemory = new WebAssembly.Memory({ initial: 2, maximum: 2 });
    const scratchPointer = 1024;
    const allocScratch = vi.fn();
    const kernelSpawn = vi.fn(() => 42);
    const worker = createWorker({
      callbacks: { onSpawn: vi.fn(() => new Promise<number>(() => {})) },
      kernelMemory,
      scratchPointer,
      kernelExports: {
        kernel_alloc_scratch: allocScratch,
        kernel_spawn_process: kernelSpawn,
      },
    });

    worker.handleSpawnAfterResolve(
      createChannel(7, sharedMemoryFor(65_536)),
      [0, 0, 0, blob.byteLength, 0, 0],
      7,
      7,
      0,
      blob,
      blob.byteLength,
      resolvedProgram(),
      ["A=B"],
    );

    expect(allocScratch).not.toHaveBeenCalled();
    expect(kernelSpawn).toHaveBeenCalledWith(
      7,
      7,
      scratchPointer,
      blob.byteLength,
    );
    expect(
      new Uint8Array(kernelMemory.buffer).slice(
        scratchPointer,
        scratchPointer + blob.byteLength,
      ),
    ).toEqual(blob);
  });

  it.each([
    {
      name: "the exact channel-size boundary",
      blobLen: CH_TOTAL_SIZE,
      expectedOffset: 1024,
      expectedReservations: 0,
    },
    {
      name: "the first byte above the channel-size boundary",
      blobLen: CH_TOTAL_SIZE + 1,
      expectedOffset: 2 * CH_TOTAL_SIZE,
      expectedReservations: 1,
    },
  ])("selects the bounded transport at $name", ({
    blobLen,
    expectedOffset,
    expectedReservations,
  }) => {
    const blob = new Uint8Array(blobLen).fill(0x5a);
    const kernelPages = Math.ceil(
      (2 * CH_TOTAL_SIZE + SPAWN_BLOB_MAX_BYTES) / 65_536,
    );
    const kernelMemory = new WebAssembly.Memory({
      initial: kernelPages,
      maximum: kernelPages,
    });
    const kernelSpawn = vi.fn(() => 42);
    const beginSpawnScratch = vi.fn(() => 1n);
    const kernelReservedSpawn = vi.fn(() => 42);
    const worker = createWorker({
      callbacks: { onSpawn: vi.fn(() => new Promise<number>(() => {})) },
      kernelMemory,
      scratchPointer: 1024,
      kernelExports: {
        kernel_spawn_process: kernelSpawn,
        kernel_spawn_scratch_begin: beginSpawnScratch,
        kernel_spawn_scratch_pointer: vi.fn(() => 2 * CH_TOTAL_SIZE),
        kernel_spawn_scratch_capacity: vi.fn(() => blobLen),
        kernel_spawn_scratch_cancel: vi.fn(() => -EINVAL),
        kernel_spawn_reserved_process: kernelReservedSpawn,
      },
    });

    worker.handleSpawnAfterResolve(
      createChannel(7, sharedMemoryFor(65_536)),
      [0, 0, 0, blobLen, 0, 0],
      7,
      7,
      0,
      blob,
      blobLen,
      resolvedProgram(),
      [],
    );

    expect(beginSpawnScratch).toHaveBeenCalledTimes(expectedReservations);
    if (expectedReservations === 0) {
      expect(kernelSpawn).toHaveBeenCalledWith(
        7,
        7,
        expectedOffset,
        blobLen,
      );
      expect(kernelReservedSpawn).not.toHaveBeenCalled();
    } else {
      expect(kernelSpawn).not.toHaveBeenCalled();
      expect(kernelReservedSpawn).toHaveBeenCalledWith(
        7,
        7,
        1n,
        blobLen,
      );
    }
  });

  it("accepts the exact whole-blob transport maximum", () => {
    const blob = new Uint8Array(SPAWN_BLOB_MAX_BYTES);
    const largeScratchOffset = 1024;
    const requiredBytes = largeScratchOffset + blob.byteLength;
    const pages = Math.ceil(requiredBytes / 65_536);
    const kernelMemory = new WebAssembly.Memory({
      initial: pages,
      maximum: pages,
    });
    const kernelReservedSpawn = vi.fn(() => 42);
    const worker = createWorker({
      callbacks: { onSpawn: vi.fn(() => new Promise<number>(() => {})) },
      kernelMemory,
      kernelExports: {
        kernel_spawn_scratch_begin: vi.fn(() => 99n),
        kernel_spawn_scratch_pointer: vi.fn(() => largeScratchOffset),
        kernel_spawn_scratch_capacity: vi.fn(() => blob.byteLength),
        kernel_spawn_scratch_cancel: vi.fn(() => -EINVAL),
        kernel_spawn_reserved_process: kernelReservedSpawn,
      },
    });

    worker.handleSpawnAfterResolve(
      createChannel(7, sharedMemoryFor(65_536)),
      [0, 0, 0, blob.byteLength, 0, 0],
      7,
      7,
      0,
      blob,
      blob.byteLength,
      resolvedProgram(),
      [],
    );

    expect(kernelReservedSpawn).toHaveBeenCalledWith(
      7,
      7,
      99n,
      SPAWN_BLOB_MAX_BYTES,
    );
  });

  it("retries a transient ENOMEM with a fresh reservation", () => {
    const blob = new Uint8Array(CH_TOTAL_SIZE + 1);
    const completeChannel = vi.fn();
    const kernelReservedSpawn = vi.fn(() => 42);
    const beginSpawnScratch = vi.fn()
      .mockReturnValueOnce(BigInt(-ENOMEM))
      .mockReturnValueOnce(1n);
    const scratchPointer = 4096;
    const worker = createWorker({
      callbacks: { onSpawn: vi.fn(() => new Promise<number>(() => {})) },
      completeChannel,
      kernelMemory: new WebAssembly.Memory({ initial: 2, maximum: 2 }),
      scratchPointer: 1024,
      kernelExports: {
        kernel_spawn_scratch_begin: beginSpawnScratch,
        kernel_spawn_scratch_pointer: vi.fn(() => scratchPointer),
        kernel_spawn_scratch_capacity: vi.fn(() => blob.byteLength),
        kernel_spawn_scratch_cancel: vi.fn(() => -EINVAL),
        kernel_spawn_reserved_process: kernelReservedSpawn,
      },
    });
    const channel = createChannel(7, sharedMemoryFor(65_536));
    const args = [0, 0, 0, blob.byteLength, 0, 0];

    worker.handleSpawnAfterResolve(
      channel,
      args,
      7,
      7,
      0,
      blob,
      blob.byteLength,
      resolvedProgram(),
      [],
    );

    expect(kernelReservedSpawn).not.toHaveBeenCalled();
    expect(completeChannel).toHaveBeenCalledWith(
      channel,
      HOST_INTERCEPTED_SYSCALLS.SYS_SPAWN,
      args,
      undefined,
      -1,
      ENOMEM,
    );

    completeChannel.mockClear();
    worker.handleSpawnAfterResolve(
      channel,
      args,
      7,
      7,
      0,
      blob,
      blob.byteLength,
      resolvedProgram(),
      [],
    );

    expect(beginSpawnScratch).toHaveBeenCalledTimes(2);
    expect(kernelReservedSpawn).toHaveBeenCalledWith(
      7,
      7,
      1n,
      blob.byteLength,
    );
  });

  it("fails closed instead of allocating a fixed legacy fallback", () => {
    const blob = new Uint8Array(CH_TOTAL_SIZE + 1);
    const completeChannel = vi.fn();
    const fixedAllocator = vi.fn(() => 4096);
    const kernelReservedSpawn = vi.fn();
    const worker = createWorker({
      callbacks: { onSpawn: vi.fn() },
      completeChannel,
      kernelMemory: new WebAssembly.Memory({ initial: 2, maximum: 2 }),
      scratchPointer: 1024,
      kernelExports: {
        kernel_alloc_scratch: fixedAllocator,
        kernel_spawn_reserved_process: kernelReservedSpawn,
      },
    });
    const channel = createChannel(7, sharedMemoryFor(65_536));
    const args = [0, 0, 0, blob.byteLength, 0, 0];

    worker.handleSpawnAfterResolve(
      channel,
      args,
      7,
      7,
      0,
      blob,
      blob.byteLength,
      resolvedProgram(),
      [],
    );

    expect(fixedAllocator).not.toHaveBeenCalled();
    expect(kernelReservedSpawn).not.toHaveBeenCalled();
    expect(completeChannel).toHaveBeenCalledWith(
      channel,
      HOST_INTERCEPTED_SYSCALLS.SYS_SPAWN,
      args,
      undefined,
      -1,
      EIO,
    );
  });

  it("cancels a reservation when the host copy fails before commit", () => {
    const blobLength = CH_TOTAL_SIZE + 1;
    // Deliberately pass a structurally compatible but non-genuine producer.
    // The public path always supplies a Uint8Array; this fault seam proves a
    // post-reservation intrinsic copy failure still releases the Rust token
    // without replacing a global prototype method that production captures.
    const blob = { byteLength: blobLength } as Uint8Array;
    const completeChannel = vi.fn();
    const cancelSpawnScratch = vi.fn(() => 0);
    const kernelReservedSpawn = vi.fn();
    const worker = createWorker({
      callbacks: { onSpawn: vi.fn() },
      completeChannel,
      kernelMemory: new WebAssembly.Memory({ initial: 2, maximum: 2 }),
      kernelExports: {
        kernel_spawn_scratch_begin: vi.fn(() => 17n),
        kernel_spawn_scratch_pointer: vi.fn(() => 4096),
        kernel_spawn_scratch_capacity: vi.fn(() => blobLength),
        kernel_spawn_scratch_cancel: cancelSpawnScratch,
        kernel_spawn_reserved_process: kernelReservedSpawn,
      },
    });
    const channel = createChannel(7, sharedMemoryFor(65_536));
    const args = [0, 0, 0, blobLength, 0, 0];
    worker.handleSpawnAfterResolve(
      channel,
      args,
      7,
      7,
      0,
      blob,
      blobLength,
      resolvedProgram(),
      [],
    );

    expect(kernelReservedSpawn).not.toHaveBeenCalled();
    expect(cancelSpawnScratch).toHaveBeenCalledOnce();
    expect(cancelSpawnScratch).toHaveBeenCalledWith(17n);
    expect(completeChannel).toHaveBeenCalledWith(
      channel,
      HOST_INTERCEPTED_SYSCALLS.SYS_SPAWN,
      args,
      undefined,
      -1,
      EIO,
    );
  });

  it("cancels a commit rejection before admitting the next large spawn", async () => {
    const blob = new Uint8Array(CH_TOTAL_SIZE + 1);
    const completeChannel = vi.fn();
    const beginSpawnScratch = vi.fn()
      .mockReturnValueOnce(31n)
      .mockReturnValueOnce(32n);
    const cancelSpawnScratch = vi.fn()
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(-EINVAL);
    const kernelReservedSpawn = vi.fn()
      .mockReturnValueOnce(-EBUSY)
      .mockReturnValueOnce(42);
    const onSpawn = vi.fn(() => new Promise<number>(() => {}));
    const worker = createWorker({
      callbacks: { onSpawn },
      completeChannel,
      kernelMemory: new WebAssembly.Memory({ initial: 2, maximum: 2 }),
      kernelExports: {
        kernel_spawn_scratch_begin: beginSpawnScratch,
        kernel_spawn_scratch_pointer: vi.fn(() => 4096),
        kernel_spawn_scratch_capacity: vi.fn(() => blob.byteLength),
        kernel_spawn_scratch_cancel: cancelSpawnScratch,
        kernel_spawn_reserved_process: kernelReservedSpawn,
      },
    });
    const channel = createChannel(7, sharedMemoryFor(65_536));
    const args = [0, 0, 0, blob.byteLength, 0, 0];
    const invoke = () => worker.handleSpawnAfterResolve(
      channel,
      args,
      7,
      7,
      0,
      blob,
      blob.byteLength,
      resolvedProgram(),
      [],
    );

    invoke();
    expect(cancelSpawnScratch).toHaveBeenNthCalledWith(1, 31n);
    expect(completeChannel).toHaveBeenCalledWith(
      channel,
      HOST_INTERCEPTED_SYSCALLS.SYS_SPAWN,
      args,
      undefined,
      -1,
      EBUSY,
    );

    completeChannel.mockClear();
    invoke();
    await drainSpawnGate();
    expect(beginSpawnScratch).toHaveBeenCalledTimes(2);
    expect(kernelReservedSpawn).toHaveBeenCalledTimes(2);
    expect(cancelSpawnScratch).toHaveBeenNthCalledWith(2, 32n);
    expect(onSpawn).toHaveBeenCalledOnce();
  });

  it("keeps the large-spawn guard closed after cancellation protocol failure", async () => {
    const blob = new Uint8Array(CH_TOTAL_SIZE + 1);
    const completeChannel = vi.fn();
    const beginSpawnScratch = vi.fn(() => 41n);
    const onKernelFatal = vi.fn();
    const worker = createWorker({
      callbacks: {
        onKernelFatal,
        onSpawn: vi.fn(),
      },
      completeChannel,
      kernelMemory: new WebAssembly.Memory({ initial: 2, maximum: 2 }),
      kernelExports: {
        kernel_spawn_scratch_begin: beginSpawnScratch,
        kernel_spawn_scratch_pointer: vi.fn(() => 4096),
        kernel_spawn_scratch_capacity: vi.fn(() => blob.byteLength),
        kernel_spawn_scratch_cancel: vi.fn(() => -EBUSY),
        kernel_spawn_reserved_process: vi.fn(() => -EBUSY),
      },
    });
    const channel = createChannel(7, sharedMemoryFor(65_536));
    const args = [0, 0, 0, blob.byteLength, 0, 0];
    const invoke = () => worker.handleSpawnAfterResolve(
      channel,
      args,
      7,
      7,
      0,
      blob,
      blob.byteLength,
      resolvedProgram(),
      [],
    );

    let firstFailure: unknown;
    try {
      invoke();
    } catch (error) {
      firstFailure = error;
    }
    expect(firstFailure).toMatchObject({
      message: "void kernel ingress resolved spawn transport test failed",
      cause: {
        name: "KernelTransferExecuteTrapError",
        message: "kernel spawn reservation could not be settled",
      },
    });
    await drainSpawnGate();
    expect(onKernelFatal).toHaveBeenCalledOnce();
    expect(onKernelFatal).toHaveBeenCalledWith(firstFailure);
    expect(completeChannel).not.toHaveBeenCalled();

    let secondFailure: unknown;
    try {
      invoke();
    } catch (error) {
      secondFailure = error;
    }
    expect(secondFailure).toBe(firstFailure);
    expect(beginSpawnScratch).toHaveBeenCalledOnce();
    expect(completeChannel).not.toHaveBeenCalled();
  });

  it("rejects reentrant large reservation without replacing outer bytes", async () => {
    const outerBlob = new Uint8Array(CH_TOTAL_SIZE + 1).fill(0x41);
    const nestedBlob = new Uint8Array(CH_TOTAL_SIZE + 2).fill(0x42);
    const kernelMemory = new WebAssembly.Memory({ initial: 3, maximum: 3 });
    const scratchPointer = 4096;
    const kernelBytes = new Uint8Array(kernelMemory.buffer);
    const completeChannel = vi.fn();
    const beginSpawnScratch = vi.fn(() => 23n);
    const cancelSpawnScratch = vi.fn(() => -EINVAL);
    const channel = createChannel(7, sharedMemoryFor(65_536));
    const outerArgs = [0, 0, 0, outerBlob.byteLength, 0, 0];
    const nestedArgs = [0, 0, 0, nestedBlob.byteLength, 0, 0];
    let reentrantError: unknown;
    let worker: any;
    const kernelReservedSpawn = vi.fn(() => {
      expect(
        kernelBytes.slice(
          scratchPointer,
          scratchPointer + outerBlob.byteLength,
        ),
      ).toEqual(outerBlob);
      try {
        worker.handleSpawnAfterResolve(
          channel,
          nestedArgs,
          7,
          7,
          0,
          nestedBlob,
          nestedBlob.byteLength,
          resolvedProgram(),
          [],
        );
      } catch (error) {
        reentrantError = error;
      }
      expect(
        kernelBytes.slice(
          scratchPointer,
          scratchPointer + outerBlob.byteLength,
        ),
      ).toEqual(outerBlob);
      return 42;
    });
    worker = createWorker({
      callbacks: { onSpawn: vi.fn(() => new Promise<number>(() => {})) },
      completeChannel,
      kernelMemory,
      kernelExports: {
        kernel_spawn_scratch_begin: beginSpawnScratch,
        kernel_spawn_scratch_pointer: vi.fn(() => scratchPointer),
        kernel_spawn_scratch_capacity: vi.fn(() => nestedBlob.byteLength),
        kernel_spawn_scratch_cancel: cancelSpawnScratch,
        kernel_spawn_reserved_process: kernelReservedSpawn,
      },
    });

    worker.handleSpawnAfterResolve(
      channel,
      outerArgs,
      7,
      7,
      0,
      outerBlob,
      outerBlob.byteLength,
      resolvedProgram(),
      [],
    );

    expect(beginSpawnScratch).toHaveBeenCalledOnce();
    expect(kernelReservedSpawn).toHaveBeenCalledOnce();
    expect(cancelSpawnScratch).toHaveBeenCalledOnce();
    expect(cancelSpawnScratch).toHaveBeenCalledWith(23n);
    expect(reentrantError).toBeInstanceOf(KernelReentrantEntryError);
    expect(completeChannel).not.toHaveBeenCalledWith(
      channel,
      HOST_INTERCEPTED_SYSCALLS.SYS_SPAWN,
      nestedArgs,
      undefined,
      -1,
      EBUSY,
    );
    await drainSpawnGate();
    expect(beginSpawnScratch).toHaveBeenCalledOnce();
    expect(kernelReservedSpawn).toHaveBeenCalledOnce();
    expect(cancelSpawnScratch).toHaveBeenCalledOnce();
  });

  it("rejects reentrant preflight without retaining caller-owned argv", async () => {
    const blob = new Uint8Array(CH_TOTAL_SIZE + 1).fill(0x41);
    const channel = createChannel(7, sharedMemoryFor(65_536));
    const outerArgs = [0, 0, 0, blob.byteLength, 0, 0];
    const callerRead = vi.fn();
    const callerArgs = new Proxy(
      [0, 0, 0, 0, 0, 0],
      {
        get(target, property, receiver) {
          callerRead(property);
          return Reflect.get(target, property, receiver);
        },
      },
    );
    const onResolveSpawn = vi.fn();
    let reentrantError: unknown;
    let worker!: SpawnWorkerTestHarness;
    const kernelReservedSpawn = vi.fn(() => {
      try {
        worker.handleSpawn(channel, callerArgs);
      } catch (error) {
        reentrantError = error;
      }
      return 42;
    });
    worker = createWorker({
      callbacks: {
        onResolveSpawn,
        onSpawn: vi.fn(() => new Promise<number>(() => {})),
      },
      kernelMemory: new WebAssembly.Memory({ initial: 3, maximum: 3 }),
      scratchPointer: 4096,
      kernelExports: {
        kernel_spawn_scratch_begin: vi.fn(() => 23n),
        kernel_spawn_scratch_pointer: vi.fn(() => 4096),
        kernel_spawn_scratch_capacity: vi.fn(() => blob.byteLength),
        kernel_spawn_scratch_cancel: vi.fn(() => -EINVAL),
        kernel_spawn_reserved_process: kernelReservedSpawn,
      },
    });

    worker.handleSpawnAfterResolve(
      channel,
      outerArgs,
      7,
      7,
      0,
      blob,
      blob.byteLength,
      resolvedProgram(),
      [],
    );

    expect(reentrantError).toBeInstanceOf(KernelReentrantEntryError);
    expect(callerRead).not.toHaveBeenCalled();
    expect(onResolveSpawn).not.toHaveBeenCalled();
    await drainSpawnGate();
    expect(callerRead).not.toHaveBeenCalled();
    expect(onResolveSpawn).not.toHaveBeenCalled();
    expect(kernelReservedSpawn).toHaveBeenCalledOnce();
  });

  it.each([
    {
      name: "path range",
      args: (memoryBytes: number) => [
        memoryBytes - 2,
        4,
        256,
        SPAWN_WIRE_HEADER_BYTES,
        128,
        0,
      ],
      errno: EFAULT,
    },
    {
      name: "null positive-length path",
      args: (_memoryBytes: number) => [
        0,
        1,
        256,
        SPAWN_WIRE_HEADER_BYTES,
        128,
        0,
      ],
      errno: EFAULT,
    },
    {
      name: "blob range",
      args: (memoryBytes: number) => [
        64,
        4,
        memoryBytes - 8,
        SPAWN_WIRE_HEADER_BYTES,
        128,
        0,
      ],
      errno: EFAULT,
    },
    {
      name: "pid output range",
      args: (memoryBytes: number) => [
        64,
        4,
        256,
        SPAWN_WIRE_HEADER_BYTES,
        memoryBytes - 2,
        0,
      ],
      errno: EFAULT,
    },
    {
      name: "fractional blob length",
      args: (_memoryBytes: number) => [
        64,
        4,
        256,
        SPAWN_WIRE_HEADER_BYTES + 0.5,
        128,
        0,
      ],
      errno: EINVAL,
    },
    {
      name: "empty blob",
      args: (_memoryBytes: number) => [64, 4, 256, 0, 128, 0],
      errno: EINVAL,
    },
    {
      name: "truncated blob header",
      args: (_memoryBytes: number) => [
        64,
        4,
        256,
        SPAWN_WIRE_HEADER_BYTES - 1,
        128,
        0,
      ],
      errno: EINVAL,
    },
    {
      name: "PATH_MAX-byte path",
      args: (_memoryBytes: number) => [
        64,
        POSIX_PATH_MAX_BYTES,
        256,
        SPAWN_WIRE_HEADER_BYTES,
        128,
        0,
      ],
      errno: ENAMETOOLONG,
    },
  ])("rejects an invalid $name before resolution", ({ args, errno }) => {
    const memory = sharedMemoryFor(65_536);
    const bytes = new Uint8Array(memory.buffer);
    bytes.set(new TextEncoder().encode("/bin"), 64);
    bytes.fill(0, 256, 296);
    const channel = createChannel(7, memory);
    const completeChannel = vi.fn();
    const onResolveSpawn = vi.fn();
    const worker = createWorker({
      callbacks: { onResolveSpawn, onSpawn: vi.fn() },
      completeChannel,
    });
    const syscallArgs = args(memory.buffer.byteLength);

    worker.handleSpawn(channel, syscallArgs);

    expect(onResolveSpawn).not.toHaveBeenCalled();
    expect(completeChannel).toHaveBeenCalledWith(
      channel,
      HOST_INTERCEPTED_SYSCALLS.SYS_SPAWN,
      syscallArgs,
      undefined,
      -1,
      errno,
    );
  });

  it("rejects a whole spawn representation above its explicit transport bound", () => {
    const memory = sharedMemoryFor(65_536);
    const channel = createChannel(7, memory);
    const completeChannel = vi.fn();
    const onResolveSpawn = vi.fn();
    const worker = createWorker({
      callbacks: { onResolveSpawn, onSpawn: vi.fn() },
      completeChannel,
    });
    const args = [0, 0, 256, SPAWN_BLOB_MAX_BYTES + 1, 0, 0];

    worker.handleSpawn(channel, args);

    expect(onResolveSpawn).not.toHaveBeenCalled();
    expect(completeChannel).toHaveBeenCalledWith(
      channel,
      HOST_INTERCEPTED_SYSCALLS.SYS_SPAWN,
      args,
      undefined,
      -1,
      E2BIG,
    );
  });

  it("enforces the separate per-entry metadata transport limit before resolution", () => {
    const blob = buildSpawnBlob(["child"], [`A=${"x".repeat(CH_DATA_SIZE)}`]);
    const memory = sharedMemoryFor(4096 + blob.byteLength);
    const bytes = new Uint8Array(memory.buffer);
    const path = new TextEncoder().encode("/bin/child");
    const pathPtr = 256;
    const blobPtr = 4096;
    bytes.set(path, pathPtr);
    bytes.set(blob, blobPtr);
    const channel = createChannel(7, memory);
    const completeChannel = vi.fn();
    const onResolveSpawn = vi.fn();
    const worker = createWorker({
      callbacks: { onResolveSpawn, onSpawn: vi.fn() },
      completeChannel,
    });
    const args = [
      pathPtr,
      path.byteLength,
      blobPtr,
      blob.byteLength,
      0,
      0,
    ];

    worker.handleSpawn(channel, args);

    expect(onResolveSpawn).not.toHaveBeenCalled();
    expect(completeChannel).toHaveBeenCalledWith(
      channel,
      HOST_INTERCEPTED_SYSCALLS.SYS_SPAWN,
      args,
      undefined,
      -1,
      E2BIG,
    );
  });

  it.each([
    { name: "argv", argv: ["child"], envp: [], pointerWidth: 4 },
    { name: "argv", argv: ["child"], envp: [], pointerWidth: 8 },
    { name: "environment", argv: [], envp: ["A=value"], pointerWidth: 4 },
    { name: "environment", argv: [], envp: ["A=value"], pointerWidth: 8 },
  ] as const)(
    "rejects an unterminated $name string with $pointerWidth-byte pointers before resolution",
    ({ argv, envp, pointerWidth }) => {
      const blob = buildSpawnBlob(argv, envp);
      blob[blob.byteLength - 1] = 0x61;
      const harness = createSpawnPreflightHarness(blob, pointerWidth);

      harness.worker.handleSpawn(harness.channel, harness.args);

      expect(harness.onResolveSpawn).not.toHaveBeenCalled();
      expect(harness.completeChannel).toHaveBeenCalledWith(
        harness.channel,
        HOST_INTERCEPTED_SYSCALLS.SYS_SPAWN,
        harness.args,
        undefined,
        -1,
        EINVAL,
      );
    },
  );

  it.each([
    {
      name: "argv",
      blob: () => buildCountBoundarySpawnBlob(
        SPAWN_MAX_ARGV_COUNT,
        0,
        0,
      ),
    },
    {
      name: "environment",
      blob: () => buildCountBoundarySpawnBlob(
        0,
        SPAWN_MAX_ENVP_COUNT,
        0,
      ),
    },
    {
      name: "file-action",
      blob: () => buildCountBoundarySpawnBlob(
        0,
        0,
        SPAWN_MAX_ACTION_COUNT,
      ),
    },
  ])("admits the exact $name count cap before resolution", async ({ blob }) => {
    const harness = createSpawnPreflightHarness(blob(), 4);

    harness.worker.handleSpawn(harness.channel, harness.args);
    await drainSpawnGate();

    expect(harness.onResolveSpawn).toHaveBeenCalledOnce();
    expect(harness.completeChannel).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "argv",
      blob: () => buildCountBoundarySpawnBlob(
        SPAWN_MAX_ARGV_COUNT + 1,
        0,
        0,
      ),
    },
    {
      name: "environment",
      blob: () => buildCountBoundarySpawnBlob(
        0,
        SPAWN_MAX_ENVP_COUNT + 1,
        0,
      ),
    },
    {
      name: "file-action",
      blob: () => buildCountBoundarySpawnBlob(
        0,
        0,
        SPAWN_MAX_ACTION_COUNT + 1,
      ),
    },
  ])("rejects the $name count cap plus one before resolution", ({ blob }) => {
    const harness = createSpawnPreflightHarness(blob(), 4);

    harness.worker.handleSpawn(harness.channel, harness.args);

    expect(harness.onResolveSpawn).not.toHaveBeenCalled();
    expect(harness.completeChannel).toHaveBeenCalledWith(
      harness.channel,
      HOST_INTERCEPTED_SYSCALLS.SYS_SPAWN,
      harness.args,
      undefined,
      -1,
      EINVAL,
    );
  });

  it.each([4, 8] as const)(
    "enforces aggregate ARG_MAX exactly for a wasm%s caller",
    async (pointerWidth) => {
      const exact = createSpawnPreflightHarness(
        buildArgMaxBoundarySpawnBlob(pointerWidth, 0),
        pointerWidth,
      );

      exact.worker.handleSpawn(exact.channel, exact.args);
      await drainSpawnGate();

      expect(exact.onResolveSpawn).toHaveBeenCalledOnce();
      expect(exact.completeChannel).not.toHaveBeenCalled();

      const oversized = createSpawnPreflightHarness(
        buildArgMaxBoundarySpawnBlob(pointerWidth, 1),
        pointerWidth,
      );

      oversized.worker.handleSpawn(oversized.channel, oversized.args);

      expect(oversized.onResolveSpawn).not.toHaveBeenCalled();
      expect(oversized.completeChannel).toHaveBeenCalledWith(
        oversized.channel,
        HOST_INTERCEPTED_SYSCALLS.SYS_SPAWN,
        oversized.args,
        undefined,
        -1,
        E2BIG,
      );
    },
  );

  it("rejects duplicate maximum-count offsets before decoding the repeated tail", () => {
    const blob = buildDuplicateOffsetSpawnBlob(
      SPAWN_MAX_ARGV_COUNT,
      POSIX_ARG_MAX_BYTES,
    );
    const memory = sharedMemoryFor(4096 + blob.byteLength);
    const bytes = new Uint8Array(memory.buffer);
    const path = new TextEncoder().encode("/bin/child");
    const pathPtr = 256;
    const blobPtr = 4096;
    bytes.set(path, pathPtr);
    bytes.set(blob, blobPtr);
    const channel = createChannel(7, memory);
    const completeChannel = vi.fn();
    const onResolveSpawn = vi.fn();
    // The oversized blob decodes through the tokenized reservation; the kernel
    // mock rejects it with E2BIG while measuring the first duplicated offset,
    // before the repeated tail is ever copied out.
    const { kernelMemory, scratchExports } = largeSpawnDecodeScratch(
      blob.byteLength,
      4,
    );
    const worker = createWorker({
      callbacks: { onResolveSpawn, onSpawn: vi.fn() },
      completeChannel,
      kernelMemory,
      kernelExports: scratchExports,
    });
    const args = [
      pathPtr,
      path.byteLength,
      blobPtr,
      blob.byteLength,
      0,
      0,
    ];

    worker.handleSpawn(channel, args);

    expect(onResolveSpawn).not.toHaveBeenCalled();
    expect(completeChannel).toHaveBeenCalledWith(
      channel,
      HOST_INTERCEPTED_SYSCALLS.SYS_SPAWN,
      args,
      undefined,
      -1,
      E2BIG,
    );
  });
});

/**
 * Build a kernel memory plus tokenized spawn-scratch exports large enough for
 * the kernel to decode a blob of `blobLen` bytes in place. The reserved region
 * must hold both the blob copy and the (slightly larger) argv/envp read-back
 * framing, so it is sized with headroom. Small blobs decode in the shared
 * channel scratch and never touch these exports; supplying them is harmless.
 */
function largeSpawnDecodeScratch(
  blobLen: number,
  pointerWidth: 4 | 8,
): {
  kernelMemory: WebAssembly.Memory;
  scratchExports: Record<string, unknown>;
} {
  const largeScratchOffset = 2 * CH_TOTAL_SIZE;
  // Framing adds a 4-byte length prefix per entry; 64 KiB of slack covers it.
  const reservationCapacity = blobLen + 0x1_0000;
  const kernelPages = Math.ceil(
    (largeScratchOffset + reservationCapacity) / 65_536,
  );
  const kernelMemory = new WebAssembly.Memory({
    initial: kernelPages,
    maximum: kernelPages,
  });
  const asPtr = (value: number): number | bigint =>
    pointerWidth === 8 ? BigInt(value) : value;
  let token = 0n;
  const scratchExports: Record<string, unknown> = {
    kernel_spawn_scratch_begin: vi.fn(() => ++token),
    kernel_spawn_scratch_pointer: vi.fn(() => asPtr(largeScratchOffset)),
    kernel_spawn_scratch_capacity: vi.fn(() => asPtr(reservationCapacity)),
    kernel_spawn_scratch_cancel: vi.fn(() => 0),
  };
  return { kernelMemory, scratchExports };
}

function createSpawnPreflightHarness(
  blob: Uint8Array,
  pointerWidth: 4 | 8,
): {
  worker: any;
  channel: any;
  args: number[];
  onResolveSpawn: ReturnType<typeof vi.fn>;
  completeChannel: ReturnType<typeof vi.fn>;
} {
  const path = new TextEncoder().encode("/bin/child");
  const pathPtr = 256;
  const blobPtr = 4096;
  const memory = sharedMemoryFor(blobPtr + blob.byteLength);
  const bytes = new Uint8Array(memory.buffer);
  bytes.set(path, pathPtr);
  bytes.set(blob, blobPtr);
  const channel = createChannel(7, memory);
  const completeChannel = vi.fn();
  // Leave accepted preflight pending so these boundary tests exercise only
  // host parsing and never launch a child.
  const onResolveSpawn = vi.fn(() => new Promise<never>(() => {}));
  // The kernel now owns the blob decode. Boundary blobs that exceed the shared
  // channel scratch (aggregate ARG_MAX, duplicate offsets) route the decode
  // through the tokenized reservation, so give the harness a reservation large
  // enough for the blob plus the read-back framing.
  const { kernelMemory, scratchExports } = largeSpawnDecodeScratch(
    blob.byteLength,
    pointerWidth,
  );
  const worker = createWorker({
    callbacks: { onResolveSpawn, onSpawn: vi.fn() },
    pointerWidth,
    completeChannel,
    kernelMemory,
    kernelExports: scratchExports,
  });
  const args = [
    pathPtr,
    path.byteLength,
    blobPtr,
    blob.byteLength,
    0,
    0,
  ];
  return {
    worker,
    channel,
    args,
    onResolveSpawn,
    completeChannel,
  };
}

interface SpawnWorkerTestOptions {
  readonly callbacks?: CentralizedKernelCallbacks;
  readonly completeChannel?: (...args: any[]) => void;
  readonly kernelExports?: Readonly<Record<string, unknown>>;
  readonly kernelMemory?: WebAssembly.Memory;
  readonly pointerWidth?: 4 | 8;
  readonly scratchPointer?: number;
}

interface SpawnWorkerTestHarness {
  readonly getSpawnScratchCapacity: () => number;
  readonly handleSpawn: (channel: any, origArgs: number[]) => void;
  readonly handleSpawnAfterResolve: (
    channel: any,
    origArgs: number[],
    parentPid: number,
    callerTid: number,
    pidOutPtr: number,
    blobBytes: Uint8Array,
    blobLen: number,
    program: ReturnType<typeof resolvedProgram>,
    envp: string[],
  ) => void;
}

function createWorker(
  options: SpawnWorkerTestOptions,
): SpawnWorkerTestHarness {
  const {
    scratchPointer,
    callbacks,
    completeChannel,
    kernelExports,
    kernelMemory: suppliedKernelMemory,
    pointerWidth = 4,
  } = options;
  const kernelMemory = suppliedKernelMemory
    ?? new WebAssembly.Memory({ initial: 2, maximum: 2 });
  const mainScratchPointer =
    Number.isSafeInteger(scratchPointer) && scratchPointer! > 0
      ? scratchPointer!
      : 1024;
  const defaultTargetBytes = new Uint8Array([
    0x00, 0x61, 0x73, 0x6d,
    0x01, 0x00, 0x00, 0x00,
  ]);
  const implementations: Record<string, unknown> = {
    kernel_drain_wakeup_events: vi.fn(() => 0),
    kernel_exec_target_cancel: vi.fn(() => 0),
    kernel_exec_target_read: vi.fn((
      _ownerPid: number,
      _target: number,
      offsetLo: number,
      offsetHi: number,
      destination: number | bigint,
      capacity: number | bigint,
    ) => {
      const offset = Number(
        (BigInt(offsetHi >>> 0) << 32n) | BigInt(offsetLo >>> 0),
      );
      const count = Math.min(
        Number(capacity),
        defaultTargetBytes.byteLength - offset,
      );
      new Uint8Array(
        kernelMemory.buffer,
        Number(destination),
        count,
      ).set(defaultTargetBytes.subarray(offset, offset + count));
      return count;
    }),
    kernel_exec_target_size: vi.fn(() => BigInt(defaultTargetBytes.byteLength)),
    kernel_exec_target_shebang: vi.fn(() => 0),
    kernel_spawn_blob_decode: mockKernelSpawnBlobDecode(kernelMemory),
    kernel_get_parent_pid: vi.fn(() => -1),
    kernel_get_process_exit_signal: vi.fn(() => -1),
    kernel_mark_process_signaled: vi.fn(() => 0),
    kernel_process_secure_exec: vi.fn(() => 0),
    kernel_remove_process: vi.fn(() => 0),
    kernel_publish_spawn_child: vi.fn(() => -1),
    kernel_spawn_exec_commit: vi.fn(() => 0),
    kernel_spawn_exec_target_prepare: vi.fn(() => 1),
    ...(kernelExports ?? {}),
  };
  const gate = new KernelEntryGate();
  const rawInstance = createKernelScratchTestInstance(
    pointerWidth,
    kernelMemory,
    () => implementations,
    () =>
      pointerWidth === 8
        ? BigInt(mainScratchPointer)
        : mainScratchPointer,
    4,
    Object.keys(implementations),
  );
  const instance = createKernelEntryGatedInstance(rawInstance, gate);
  const mainScratch = allocateKernelScratchRegion(
    kernelMemory,
    instance.exports.kernel_alloc_scratch as
      (size: number) => number | bigint,
    CH_TOTAL_SIZE,
    pointerWidth,
    "spawn transport test main scratch",
    instance,
  );
  const worker = createCentralizedKernelWorkerTestDouble({ callbacks });
  worker.testAuthority.initializeKernelForTest({
    instance,
    gate,
    mainScratch,
  });
  const activeChannels = new Set<object>();
  worker.testAuthority.configureScratchBoundaryHooksForTest({
    completeChannel:
      (completeChannel ?? vi.fn()) as (...args: any[]) => void,
    getPtrWidth: () => pointerWidth,
    guestTidForChannel: (channel) => channel.pid,
    isRegisteredChannel: (channel) => activeChannels.has(channel),
  });

  return Object.freeze({
    getSpawnScratchCapacity: (): number =>
      worker.getSpawnScratchCapacity(),
    handleSpawn: (channel: any, origArgs: number[]): void => {
      activeChannels.add(channel);
      worker.testAuthority.dispatchSpawnPreflightForTest(
        channel,
        origArgs,
      );
    },
    handleSpawnAfterResolve: (
      channel: any,
      origArgs: number[],
      parentPid: number,
      callerTid: number,
      pidOutPtr: number,
      blobBytes: Uint8Array,
      blobLen: number,
      program: ReturnType<typeof resolvedProgram>,
      envp: string[],
    ): void => {
      activeChannels.add(channel);
      worker.testAuthority.dispatchSpawnAfterResolveForTest({
        channel,
        origArgs,
        parentPid,
        callerTid,
        pidOutPtr,
        blobBytes,
        blobLen,
        program,
        envp,
      });
    },
  }) as SpawnWorkerTestHarness;
}

async function drainSpawnGate(): Promise<void> {
  // A successful spawn stage publishes host launch only after its exact
  // kernel-entry scope is revoked. Drain the finite queue before beginning a
  // second reservation or asserting on that detached callback.
  // The complete preflight path crosses resolution, a fresh result ingress,
  // and launch publication. Keep a fixed upper bound rather than using a
  // timer-based poll that could hide a permanently stuck gate.
  for (let turn = 0; turn < 12; turn++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
    for (let microtask = 0; microtask < 12; microtask++) {
      await Promise.resolve();
    }
  }
}

function moduleWithNamedExport(name: "aaaa" | "bbbb"): Uint8Array {
  return Uint8Array.from([
    0x00, 0x61, 0x73, 0x6d,
    0x01, 0x00, 0x00, 0x00,
    0x01, 0x04, 0x01, 0x60, 0x00, 0x00,
    0x03, 0x02, 0x01, 0x00,
    0x07, 0x08, 0x01, 0x04,
    ...new TextEncoder().encode(name),
    0x00, 0x00,
    0x0a, 0x04, 0x01, 0x02, 0x00, 0x0b,
  ]);
}

async function launchCandidateBindingSpawn(options: {
  candidateBytes: Uint8Array;
  candidateModule: WebAssembly.Module;
  authoritativeBytes: Uint8Array;
  afterPreflight?: () => void;
}): Promise<{
  programBytes: ArrayBuffer;
  programModule: WebAssembly.Module;
  argv: string[];
}> {
  const parentPid = 7;
  const childPid = 42;
  const path = new TextEncoder().encode("/bin/child");
  const blob = buildSpawnBlob(["/bin/child"], []);
  const processMemory = sharedMemoryFor(4096 + blob.byteLength);
  const processBytes = new Uint8Array(processMemory.buffer);
  const pathPtr = 256;
  const blobPtr = 4096;
  processBytes.set(path, pathPtr);
  processBytes.set(blob, blobPtr);

  const kernelMemory = new WebAssembly.Memory({ initial: 4, maximum: 4 });
  let launched:
    | {
        programBytes: ArrayBuffer;
        programModule: WebAssembly.Module;
        argv: string[];
      }
    | undefined;
  const onSpawn = vi.fn(async (
    _parentPid: number,
    _childPid: number,
    program: {
      programBytes: ArrayBuffer;
      programModule: WebAssembly.Module;
      argv: string[];
    },
  ) => {
    launched = program;
    return 0;
  });
  const worker = createWorker({
    callbacks: {
      onResolveSpawn: vi.fn(async () => ({
        programBytes: options.candidateBytes.buffer as ArrayBuffer,
        programModule: options.candidateModule,
        argv: ["/bin/child"],
      })),
      onSpawn,
    },
    kernelMemory,
    kernelExports: {
      kernel_spawn_process: vi.fn(() => {
        options.afterPreflight?.();
        return childPid;
      }),
      kernel_exec_target_size: vi.fn(() =>
        BigInt(options.authoritativeBytes.byteLength)
      ),
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
          options.authoritativeBytes.byteLength - offset,
        );
        new Uint8Array(kernelMemory.buffer, destination, count).set(
          options.authoritativeBytes.subarray(offset, offset + count),
        );
        return count;
      }),
    },
  });
  const channel = createChannel(parentPid, processMemory);
  worker.handleSpawn(channel, [
    pathPtr,
    path.byteLength,
    blobPtr,
    blob.byteLength,
    0,
    0,
  ]);
  await drainSpawnGate();

  expect(onSpawn).toHaveBeenCalledOnce();
  if (!launched) throw new Error("spawn candidate binding did not launch");
  return launched;
}

function createChannel(pid: number, memory: WebAssembly.Memory): any {
  const i32View = new Int32Array(memory.buffer);
  Atomics.store(
    i32View,
    CH_STATUS / Int32Array.BYTES_PER_ELEMENT,
    CHANNEL_STATUS_PENDING,
  );
  return {
    pid,
    memory,
    channelOffset: 0,
    i32View,
    consecutiveSyscalls: 0,
  };
}

function sharedMemoryFor(requiredBytes: number): WebAssembly.Memory {
  const pages = Math.ceil(requiredBytes / 65_536);
  return new WebAssembly.Memory({
    initial: pages,
    maximum: pages,
    shared: true,
  });
}

function buildSpawnBlob(argv: readonly string[], envp: readonly string[]): Uint8Array {
  const encoder = new TextEncoder();
  const argvBytes = argv.map((value) => encoder.encode(`${value}\0`));
  const envpBytes = envp.map((value) => encoder.encode(`${value}\0`));
  const headerBytes = SPAWN_WIRE_HEADER_BYTES;
  const offsetsBytes = (argv.length + envp.length) * 4;
  const stringsBytes = [...argvBytes, ...envpBytes]
    .reduce((total, value) => total + value.byteLength, 0);
  const blob = new Uint8Array(headerBytes + offsetsBytes + stringsBytes);
  const view = new DataView(blob.buffer);
  view.setUint32(0, argv.length, true);
  view.setUint32(4, envp.length, true);

  let stringsCursor = 0;
  let offsetCursor = headerBytes;
  const stringsStart = headerBytes + offsetsBytes;
  for (const value of [...argvBytes, ...envpBytes]) {
    view.setUint32(offsetCursor, stringsCursor, true);
    offsetCursor += 4;
    blob.set(value, stringsStart + stringsCursor);
    stringsCursor += value.byteLength;
  }
  return blob;
}

function buildCountBoundarySpawnBlob(
  argc: number,
  envc: number,
  actionCount: number,
): Uint8Array {
  const offsetsBytes =
    (argc + envc) * SPAWN_WIRE_STRING_OFFSET_BYTES;
  const actionsBytes =
    actionCount * SPAWN_WIRE_ACTION_RECORD_BYTES;
  const stringsBytes = argc + envc > 0 ? 1 : 0;
  const blob = new Uint8Array(
    SPAWN_WIRE_HEADER_BYTES
      + offsetsBytes
      + actionsBytes
      + stringsBytes,
  );
  const view = new DataView(blob.buffer);
  view.setUint32(SPAWN_WIRE_HEADER_ARGC_OFFSET, argc, true);
  view.setUint32(SPAWN_WIRE_HEADER_ENVC_OFFSET, envc, true);
  view.setUint32(
    SPAWN_WIRE_HEADER_ACTION_COUNT_OFFSET,
    actionCount,
    true,
  );

  const actionsAt = SPAWN_WIRE_HEADER_BYTES + offsetsBytes;
  for (let index = 0; index < actionCount; index++) {
    view.setUint32(
      actionsAt
        + index * SPAWN_WIRE_ACTION_RECORD_BYTES
        + SPAWN_WIRE_ACTION_OP_OFFSET,
      SPAWN_WIRE_OP_CLOSE,
      true,
    );
  }
  // Zero-filled offsets share one empty string. Offset aliasing is valid and
  // keeps this test focused on the exact count boundary.
  return blob;
}

function buildArgMaxBoundarySpawnBlob(
  pointerWidth: 4 | 8,
  delta: 0 | 1,
): Uint8Array {
  // Split the aggregate across both vectors and keep every individual entry
  // within the separate process-metadata transport limit.
  const argc = 32;
  const envc = 32;
  const entryCount = argc + envc;
  const pointerBytes = (entryCount + 2) * pointerWidth;
  const stringsBytes = POSIX_ARG_MAX_BYTES - pointerBytes + delta;
  const offsetsBytes =
    entryCount * SPAWN_WIRE_STRING_OFFSET_BYTES;
  const stringsAt = SPAWN_WIRE_HEADER_BYTES + offsetsBytes;
  const blob = new Uint8Array(stringsAt + stringsBytes);
  const view = new DataView(blob.buffer);
  view.setUint32(SPAWN_WIRE_HEADER_ARGC_OFFSET, argc, true);
  view.setUint32(SPAWN_WIRE_HEADER_ENVC_OFFSET, envc, true);

  let stringsCursor = 0;
  let remaining = stringsBytes;
  for (let index = 0; index < entryCount; index++) {
    view.setUint32(
      SPAWN_WIRE_HEADER_BYTES
        + index * SPAWN_WIRE_STRING_OFFSET_BYTES,
      stringsCursor,
      true,
    );
    const entriesRemaining = entryCount - index;
    const entryBytes = Math.min(
      CH_DATA_SIZE + 1,
      remaining - (entriesRemaining - 1),
    );
    blob.fill(
      0x61,
      stringsAt + stringsCursor,
      stringsAt + stringsCursor + entryBytes - 1,
    );
    stringsCursor += entryBytes;
    remaining -= entryBytes;
  }
  if (remaining !== 0 || stringsCursor !== stringsBytes) {
    throw new Error("failed to construct the requested ARG_MAX boundary");
  }
  return blob;
}

function buildDuplicateOffsetSpawnBlob(
  argc: number,
  stringBytes: number,
): Uint8Array {
  const offsetsBytes = argc * 4;
  const blob = new Uint8Array(
    SPAWN_WIRE_HEADER_BYTES + offsetsBytes + stringBytes,
  );
  const view = new DataView(blob.buffer);
  view.setUint32(0, argc, true);
  // Every zero-filled offset names the same tail. Keep its final byte NUL.
  blob.fill(
    0x61,
    SPAWN_WIRE_HEADER_BYTES + offsetsBytes,
    blob.byteLength - 1,
  );
  return blob;
}

function resolvedProgram() {
  const bytes = Uint8Array.from([
    0x00, 0x61, 0x73, 0x6d,
    0x01, 0x00, 0x00, 0x00,
  ]);
  return {
    programBytes: bytes.buffer,
    programModule: new WebAssembly.Module(bytes),
    argv: [],
  };
}
