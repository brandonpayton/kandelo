import { describe, expect, it, vi } from "vitest";

import {
  IOCTL_REQUESTS,
  SELECT_FD_SET_BYTES,
  SELECT_FD_SETSIZE,
  STRUCT_SIZE_WASM_POLL_FD,
  STRUCT_SIZE_WPK_DRM_MODE_MODEINFO,
} from "../src/generated/abi";
import {
  createWasmPosixKernelTestHarness,
  WasmPosixKernel,
} from "../src/kernel";
import { QOP_GET_ERROR } from "../src/webgl/ops";
import { createKernelScratchTestInstance } from "./support/kernel-scratch-instance";

function hostileBytes(length: number, reportedLength = 1): Uint8Array {
  class HostileBytes extends Uint8Array {}
  const bytes = new HostileBytes(length);
  Object.defineProperties(bytes, {
    buffer: { get: () => new ArrayBuffer(reportedLength) },
    byteOffset: { get: () => 0 },
    byteLength: { get: () => reportedLength },
    length: { get: () => reportedLength },
    subarray: { value: () => bytes },
  });
  return bytes;
}

function kernelHarness(
  exports: Record<string, unknown>,
  pointerWidth: 4 | 8 = 4,
  io: Record<string, unknown> = {},
  callbacks: Record<string, unknown> = {},
): {
  kernel: WasmPosixKernel & Record<string, any>;
  memory: WebAssembly.Memory;
} {
  const memory = new WebAssembly.Memory({ initial: 2, maximum: 2 });
  const kernel = createWasmPosixKernelTestHarness({
    io: io as any,
    callbacks: callbacks as any,
    memory,
    pointerWidth,
    instance: createKernelScratchTestInstance(
      pointerWidth,
      memory,
      () => exports,
      (capacity) => {
        const allocator = exports.kernel_alloc_scratch;
        if (typeof allocator !== "function") {
          throw new Error("missing test implementation for kernel_alloc_scratch");
        }
        return Reflect.apply(allocator, undefined, [capacity]) as number | bigint;
      },
    ),
  }) as WasmPosixKernel & Record<string, any>;
  return { kernel, memory };
}

function fullKernelHarness(
  io: Record<string, unknown> = {},
  callbacks: Record<string, unknown> = {},
  pointerWidth: 4 | 8 = 4,
  suppliedMemory?: WebAssembly.Memory,
): {
  kernel: WasmPosixKernel & Record<string, any>;
  memory: WebAssembly.Memory;
} {
  const memory = suppliedMemory
    ?? new WebAssembly.Memory({ initial: 2, maximum: 2 });
  const kernel = createWasmPosixKernelTestHarness({
    io: io as any,
    callbacks: callbacks as any,
    memory,
    instance: createKernelScratchTestInstance(
      pointerWidth,
      memory,
      () => ({}),
      () => pointerWidth === 8 ? 4096n : 4096,
    ),
    pointerWidth,
  }) as WasmPosixKernel & Record<string, any>;
  return { kernel, memory };
}

describe("WasmPosixKernel public API scratch ownership", () => {
  it("converts public export pointers losslessly for each Wasm width", () => {
    const { kernel } = kernelHarness({});

    expect(kernel.toKernelPtr(0xffff_ffff)).toBe(0xffff_ffff);
    expect(() => kernel.toKernelPtr(0x1_0000_0000))
      .toThrow(/wasm32/i);
    expect(() => kernel.toKernelPtr(-1)).toThrow(/non-negative/i);
    expect(() => kernel.toKernelPtr(1.5)).toThrow(/integer/i);

    const { kernel: kernel64 } = kernelHarness({}, 8);
    expect(kernel64.toKernelPtr(0x1_0000_0000)).toBe(0x1_0000_0000n);
    expect(() =>
      kernel64.toKernelPtr(BigInt(Number.MAX_SAFE_INTEGER) + 1n)
    ).toThrow(/representable/i);
  });

  it("sends from an allocator-owned region without touching low kernel memory", () => {
    const scratchPointer = 4096;
    const allocate = vi.fn(() => scratchPointer);
    let memory!: WebAssembly.Memory;
    const send = vi.fn((
      _fd: number,
      pointer: number,
      length: number,
      _flags: number,
    ) => {
      expect(pointer).toBe(scratchPointer);
      expect(
        new Uint8Array(memory.buffer, pointer, length),
      ).toEqual(new Uint8Array([1, 2, 3, 4]));
      return length;
    });
    const harness = kernelHarness({
      kernel_alloc_scratch: allocate,
      kernel_send: send,
    });
    memory = harness.memory;
    new Uint8Array(memory.buffer).fill(0xa5, 0, 64);

    expect(harness.kernel.send(7, new Uint8Array([1, 2, 3, 4]))).toBe(4);

    expect(allocate).toHaveBeenCalledTimes(1);
    expect(new Uint8Array(memory.buffer, 0, 64))
      .toEqual(new Uint8Array(64).fill(0xa5));
  });

  it.each([
    ["wasm32", 4],
    ["wasm64", 8],
  ] as const)(
    "%s stages scalar socket options in an allocator-owned exact range",
    (_name, pointerWidth) => {
      const scratchPointer = 4096;
      const exportedPointer = pointerWidth === 8
        ? BigInt(scratchPointer)
        : scratchPointer;
      const allocate = vi.fn(() => exportedPointer);
      let memory!: WebAssembly.Memory;
      const setsockopt = vi.fn((
        fd: number,
        level: number,
        optname: number,
        pointer: number | bigint,
        length: number,
      ) => {
        expect([fd, level, optname]).toEqual([7, 1, 2]);
        expect(pointer).toBe(exportedPointer);
        expect(length).toBe(4);
        expect(
          new DataView(
            memory.buffer,
            Number(pointer),
            length,
          ).getUint32(0, true),
        ).toBe(0x89ab_cdef);
        return 0;
      });
      const harness = kernelHarness({
        kernel_alloc_scratch: allocate,
        kernel_setsockopt: setsockopt,
      }, pointerWidth);
      memory = harness.memory;
      new Uint8Array(memory.buffer).fill(0xa5, 0, 64);
      new Uint8Array(memory.buffer).fill(
        0x5a,
        scratchPointer + 4,
        scratchPointer + 20,
      );

      harness.kernel.setsockopt(7, 1, 2, 0x89ab_cdef);

      expect(allocate).toHaveBeenCalledTimes(1);
      expect(setsockopt).toHaveBeenCalledTimes(1);
      expect(new Uint8Array(memory.buffer, 0, 64))
        .toEqual(new Uint8Array(64).fill(0xa5));
      expect(new Uint8Array(memory.buffer, scratchPointer + 4, 16))
        .toEqual(new Uint8Array(16).fill(0x5a));
    },
  );

  it("never lends stale scratch bytes when public inputs spoof their length", () => {
    const scratchPointer = 4096;
    const source = hostileBytes(1, 4);
    Uint8Array.prototype.set.call(source, [0x5a]);
    let memory!: WebAssembly.Memory;
    const inspectExactInput = vi.fn((
      _first: number,
      _second: number,
      pointer: number,
      length: number,
    ) => {
      expect(pointer).toBe(scratchPointer);
      expect(length).toBe(1);
      expect(new Uint8Array(memory.buffer, pointer, length))
        .toEqual(new Uint8Array([0x5a]));
      return 1;
    });
    const harness = kernelHarness({
      kernel_alloc_scratch: () => scratchPointer,
      kernel_send: (
        fd: number,
        pointer: number,
        length: number,
        flags: number,
      ) => inspectExactInput(fd, flags, pointer, length),
      kernel_tcsetattr: inspectExactInput,
    });
    memory = harness.memory;
    new Uint8Array(memory.buffer).fill(
      0xa5,
      scratchPointer,
      scratchPointer + 8,
    );

    expect(harness.kernel.send(7, source)).toBe(1);
    harness.kernel.tcsetattr(7, 0, source);

    expect(inspectExactInput).toHaveBeenCalledTimes(2);
    expect(new Uint8Array(memory.buffer, scratchPointer, 4))
      .toEqual(new Uint8Array([0x5a, 0xa5, 0xa5, 0xa5]));
  });

  it("rejects an allocator range outside current kernel memory", () => {
    const send = vi.fn();
    const { kernel } = kernelHarness({
      kernel_alloc_scratch: () => 131_056,
      kernel_send: send,
    });

    expect(() => kernel.send(7, new Uint8Array(32)))
      .toThrow(/outside|scratch|range/i);
    expect(send).not.toHaveBeenCalled();
  });

  it("accepts exact public API capacity and rejects capacity plus one", () => {
    const scratchPointer = 4096;
    let memory!: WebAssembly.Memory;
    const send = vi.fn((
      _fd: number,
      pointer: number,
      length: number,
    ) => {
      expect(pointer).toBe(scratchPointer);
      expect(length).toBe(65_536);
      const bytes = new Uint8Array(memory.buffer);
      expect(bytes[pointer]).toBe(0x4d);
      expect(bytes[pointer + length - 1]).toBe(0x4d);
      return length;
    });
    const harness = kernelHarness({
      kernel_alloc_scratch: () => scratchPointer,
      kernel_send: send,
    });
    memory = harness.memory;
    const kernelBytes = new Uint8Array(memory.buffer);
    kernelBytes.fill(0xa5, scratchPointer + 65_536, scratchPointer + 65_552);

    expect(harness.kernel.send(7, new Uint8Array(65_536).fill(0x4d)))
      .toBe(65_536);
    expect(() => harness.kernel.send(7, new Uint8Array(65_537)))
      .toThrow(/capacity|owned range|scratch/i);
    expect(send).toHaveBeenCalledOnce();
    expect(kernelBytes.subarray(scratchPointer + 65_536, scratchPointer + 65_552))
      .toEqual(new Uint8Array(16).fill(0xa5));
  });

  it("derives poll admission from exact owned capacity, not IOV_MAX", () => {
    const scratchPointer = 4096;
    const scratchCapacity = 65_536;
    const exactCount = scratchCapacity / STRUCT_SIZE_WASM_POLL_FD;
    let memory!: WebAssembly.Memory;
    const poll = vi.fn((
      pointer: number,
      capacity: number,
      count: number,
      timeout: number,
    ) => {
      expect(pointer).toBe(scratchPointer);
      expect(capacity).toBe(scratchCapacity);
      expect(count).toBe(exactCount);
      expect(count).toBeGreaterThan(1024);
      expect(timeout).toBe(17);
      const view = new DataView(
        memory.buffer,
        pointer,
        count * STRUCT_SIZE_WASM_POLL_FD,
      );
      expect(view.getInt32(0, true)).toBe(0);
      expect(
        view.getInt32(
          (count - 1) * STRUCT_SIZE_WASM_POLL_FD,
          true,
        ),
      ).toBe(count - 1);
      view.setInt16(6, 1, true);
      view.setInt16(
        (count - 1) * STRUCT_SIZE_WASM_POLL_FD + 6,
        4,
        true,
      );
      return 2;
    });
    const harness = kernelHarness({
      kernel_alloc_scratch: () => scratchPointer,
      kernel_poll: poll,
    });
    memory = harness.memory;
    const exact = Array.from(
      { length: exactCount },
      (_, fd) => ({ fd, events: 1 }),
    );

    const ready = harness.kernel.poll(exact, 17);
    expect(ready).toHaveLength(exactCount);
    expect(ready[0]?.revents).toBe(1);
    expect(ready.at(-1)?.revents).toBe(4);
    expect(() =>
      harness.kernel.poll(
        Array.from(
          { length: exactCount + 1 },
          (_, fd) => ({ fd, events: 1 }),
        ),
        17,
      )
    ).toThrow(/owned scratch capacity 8192/i);
    expect(poll).toHaveBeenCalledOnce();
  });

  it("rejects an impossible poll producer count", () => {
    const poll = vi.fn(() => 2);
    const { kernel } = kernelHarness({
      kernel_alloc_scratch: () => 4096,
      kernel_poll: poll,
    });

    expect(() =>
      kernel.poll([{ fd: 7, events: 1 }], 0)
    ).toThrow(/invalid ready count 2/i);
  });

  it("uses the generated fd_set contract for public select", () => {
    const scratchPointer = 4096;
    let memory!: WebAssembly.Memory;
    const select = vi.fn((
      count: number,
      readPointer: number,
      readCapacity: number,
      writePointer: number,
      writeCapacity: number,
      exceptPointer: number,
      exceptCapacity: number,
      timeout: number,
    ) => {
      expect(count).toBe(SELECT_FD_SETSIZE);
      expect(timeout).toBe(0);
      expect(readPointer).toBe(scratchPointer);
      expect(readCapacity).toBe(SELECT_FD_SET_BYTES);
      expect(writePointer).toBe(scratchPointer + SELECT_FD_SET_BYTES);
      expect(writeCapacity).toBe(SELECT_FD_SET_BYTES);
      expect(exceptPointer).toBe(
        scratchPointer + 2 * SELECT_FD_SET_BYTES,
      );
      expect(exceptCapacity).toBe(SELECT_FD_SET_BYTES);
      new Uint8Array(memory.buffer).fill(
        0,
        readPointer,
        exceptPointer + SELECT_FD_SET_BYTES,
      );
      return 0;
    });
    const harness = kernelHarness({
      kernel_alloc_scratch: () => scratchPointer,
      kernel_select: select,
    });
    memory = harness.memory;

    expect(harness.kernel.select(
      SELECT_FD_SETSIZE,
      [SELECT_FD_SETSIZE - 1],
      [0],
      [1],
    )).toEqual({
      readReady: [],
      writeReady: [],
      exceptReady: [],
    });
    expect(() =>
      harness.kernel.select(SELECT_FD_SETSIZE + 1, [], [], [])
    ).toThrow(new RegExp(String(SELECT_FD_SETSIZE)));
    expect(select).toHaveBeenCalledOnce();
  });

  it.each(Array.from({ length: 8 }, (_, mask) => mask))(
    "passes wasm64 public select presence mask %i without pointer coercion",
    (mask) => {
      const scratchPointer = 4096;
      const select = vi.fn((
        count: number,
        readPointer: bigint,
        readCapacity: number,
        writePointer: bigint,
        writeCapacity: number,
        exceptPointer: bigint,
        exceptCapacity: number,
        timeout: number,
      ) => {
        expect(count).toBe(0);
        expect(timeout).toBe(0);
        expect([
          readCapacity,
          writeCapacity,
          exceptCapacity,
        ]).toEqual([
          (mask & 1) !== 0 ? SELECT_FD_SET_BYTES : 0,
          (mask & 2) !== 0 ? SELECT_FD_SET_BYTES : 0,
          (mask & 4) !== 0 ? SELECT_FD_SET_BYTES : 0,
        ]);
        expect([readPointer, writePointer, exceptPointer]).toEqual([
          (mask & 1) !== 0 ? BigInt(scratchPointer) : 0n,
          (mask & 2) !== 0
            ? BigInt(scratchPointer + SELECT_FD_SET_BYTES)
            : 0n,
          (mask & 4) !== 0
            ? BigInt(scratchPointer + 2 * SELECT_FD_SET_BYTES)
            : 0n,
        ]);
        return 0;
      });
      const { kernel } = kernelHarness({
        kernel_alloc_scratch: () => BigInt(scratchPointer),
        kernel_select: select,
      }, 8);

      expect(kernel.select(
        0,
        (mask & 1) !== 0 ? [] : null,
        (mask & 2) !== 0 ? [] : null,
        (mask & 4) !== 0 ? [] : null,
      )).toEqual({
        readReady: [],
        writeReady: [],
        exceptReady: [],
      });
      expect(select).toHaveBeenCalledOnce();
    },
  );

  it("converts public wasm64 scalar and no-argument ioctl values", () => {
    const scratchPointer = 4096;
    const scalarRequest = 0x540b;
    const noArgumentRequest = 0x41;
    expect(IOCTL_REQUESTS[scalarRequest]?.argKind).toBe("scalar-i32");
    expect(IOCTL_REQUESTS[noArgumentRequest]?.argKind).toBe("none");
    const ioctl = vi.fn(() => 0);
    const { kernel } = kernelHarness({
      kernel_alloc_scratch: () => BigInt(scratchPointer),
      kernel_ioctl: ioctl,
    }, 8);

    expect(kernel.ioctl(7, scalarRequest, -1)).toEqual(new Uint8Array(0));
    expect(kernel.ioctl(8, noArgumentRequest)).toEqual(new Uint8Array(0));

    expect(ioctl).toHaveBeenNthCalledWith(
      1,
      7,
      scalarRequest,
      0xffff_ffffn,
      0,
      4,
    );
    expect(ioctl).toHaveBeenNthCalledWith(
      2,
      8,
      noArgumentRequest,
      0n,
      0,
      4,
    );
  });

  it("does not drain audio through an allocator range it does not own", () => {
    const drain = vi.fn(() => 1);
    const { kernel } = kernelHarness({
      kernel_alloc_scratch: () => 131_056,
      kernel_drain_audio: drain,
    });

    expect(kernel.drainAudio(new Uint8Array(32))).toBe(0);
    expect(drain).not.toHaveBeenCalled();
  });

  it("bounds exact and capacity-plus-one audio drains to the audio region", () => {
    const scratchPointer = 4096;
    let memory!: WebAssembly.Memory;
    const drain = vi.fn((pointer: number, length: number) => {
      expect(pointer).toBe(scratchPointer);
      expect(length).toBe(65_536);
      new Uint8Array(memory.buffer, pointer, length).fill(0x6d);
      return length;
    });
    const harness = kernelHarness({
      kernel_alloc_scratch: () => scratchPointer,
      kernel_drain_audio: drain,
    });
    memory = harness.memory;
    const kernelBytes = new Uint8Array(memory.buffer);
    kernelBytes.fill(0xa5, scratchPointer + 65_536, scratchPointer + 65_552);

    const exact = new Uint8Array(65_536);
    expect(harness.kernel.drainAudio(exact)).toBe(65_536);
    expect(exact.every((byte) => byte === 0x6d)).toBe(true);

    const plusOne = new Uint8Array(65_537).fill(0xa5);
    expect(harness.kernel.drainAudio(plusOne)).toBe(65_536);
    expect(plusOne.subarray(0, 65_536).every((byte) => byte === 0x6d))
      .toBe(true);
    expect(plusOne[65_536]).toBe(0xa5);
    expect(drain).toHaveBeenCalledTimes(2);
    expect(kernelBytes.subarray(scratchPointer + 65_536, scratchPointer + 65_552))
      .toEqual(new Uint8Array(16).fill(0xa5));
  });

  it("stages truncate paths through allocator-owned scratch", () => {
    const scratchPointer = 4096;
    const allocate = vi.fn(() => scratchPointer);
    let memory!: WebAssembly.Memory;
    const truncate = vi.fn((
      pointer: number,
      length: number,
      truncateLength: bigint,
    ) => {
      expect(pointer).toBe(scratchPointer);
      expect(new TextDecoder().decode(
        new Uint8Array(memory.buffer, pointer, length),
      )).toBe("/tmp/example");
      expect(truncateLength).toBe(7n);
      return 0;
    });
    const harness = kernelHarness({
      kernel_alloc_scratch: allocate,
      kernel_truncate: truncate,
    });
    memory = harness.memory;

    harness.kernel.truncate("/tmp/example", 7);

    expect(allocate).toHaveBeenCalledTimes(1);
    expect(truncate).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["wasm32", 4],
    ["wasm64", 8],
  ] as const)(
    "%s passes the public ftruncate length through the direct i64 ABI",
    (_name, pointerWidth) => {
      const length = 0x1_0000_0001;
      const ftruncate = vi.fn((fd: number, wasmLength: bigint) => {
        if (typeof wasmLength !== "bigint") {
          throw new TypeError("Wasm i64 arguments require BigInt");
        }
        expect(fd).toBe(7);
        expect(wasmLength).toBe(BigInt(length));
        return 0;
      });
      const { kernel } = kernelHarness(
        { kernel_ftruncate: ftruncate },
        pointerWidth,
      );

      kernel.ftruncate(7, length);

      expect(ftruncate).toHaveBeenCalledWith(7, BigInt(length));
    },
  );

  it.each([
    ["wasm32 negative", 4, -1],
    ["wasm32 fractional", 4, 1.5],
    ["wasm32 unsafe", 4, Number.MAX_SAFE_INTEGER + 1],
    ["wasm64 negative", 8, -1],
    ["wasm64 fractional", 8, 1.5],
    ["wasm64 unsafe", 8, Number.MAX_SAFE_INTEGER + 1],
  ] as const)(
    "rejects a %s public ftruncate length before entering Wasm",
    (_name, pointerWidth, length) => {
      const ftruncate = vi.fn(() => 0);
      const { kernel } = kernelHarness(
        { kernel_ftruncate: ftruncate },
        pointerWidth,
      );

      expect(() => kernel.ftruncate(7, length)).toThrow(
        /non-negative safe integer/,
      );
      expect(ftruncate).not.toHaveBeenCalled();
    },
  );
});

describe("Rust-owned host import ranges", () => {
  it("rejects a truncated kernel source instead of invoking the backend", () => {
    const open = vi.fn(() => 7);
    const { kernel, memory } = kernelHarness({});
    Object.assign(kernel, { io: { open } });
    const imports = kernel.testAuthority.buildImportObject(memory) as {
      env: Record<string, (...args: any[]) => any>;
    };
    const pointer = memory.buffer.byteLength - 2;

    expect(imports.env.host_open(pointer, 4, 0, 0)).toBe(-14n);
    expect(open).not.toHaveBeenCalled();
  });

  it("accepts an exact-end source and rejects capacity plus one", () => {
    const write = vi.fn(() => 4);
    const { kernel, memory } = kernelHarness({});
    Object.assign(kernel, { io: { write } });
    const imports = kernel.testAuthority.buildImportObject(memory) as {
      env: Record<string, (...args: any[]) => any>;
    };
    const pointer = memory.buffer.byteLength - 4;
    new Uint8Array(memory.buffer, pointer, 4).set([1, 2, 3, 4]);

    expect(imports.env.host_write(9n, pointer, 4)).toBe(4);
    expect(write).toHaveBeenCalledWith(
      9,
      new Uint8Array([1, 2, 3, 4]),
      null,
      4,
    );
    write.mockClear();
    expect(imports.env.host_write(9n, pointer, 5)).toBe(-14);
    expect(write).not.toHaveBeenCalled();
  });

  it.each([
    ["null pointer", 0, 1],
    ["negative length", 4096, -1],
    ["fractional length", 4096, 1.5],
    ["unsafe length", 4096, Number.MAX_SAFE_INTEGER + 1],
  ])("rejects a %s before a kernel-source callback", (_name, pointer, length) => {
    const write = vi.fn(() => 0);
    const { kernel, memory } = kernelHarness({});
    Object.assign(kernel, { io: { write } });
    const imports = kernel.testAuthority.buildImportObject(memory) as {
      env: Record<string, (...args: any[]) => any>;
    };

    expect(imports.env.host_write(9n, pointer, length)).toBe(-14);
    expect(write).not.toHaveBeenCalled();
  });

  it("rejects an unrepresentable wasm64 network source without aliasing", () => {
    const send = vi.fn(() => 1);
    const { kernel, memory } = kernelHarness({}, 8);
    Object.assign(kernel, {
      io: { network: { send } },
    });
    const imports = kernel.testAuthority.buildImportObject(memory) as {
      env: Record<string, (...args: any[]) => any>;
    };

    expect(imports.env.host_net_send(
      1,
      BigInt(Number.MAX_SAFE_INTEGER) + 1n,
      1,
      0,
    )).toBe(-14);
    expect(send).not.toHaveBeenCalled();
  });

  it("rejects a lossy file-length conversion before PlatformIO", () => {
    const ftruncate = vi.fn();
    const { kernel, memory } = kernelHarness({});
    Object.assign(kernel, { io: { ftruncate } });
    const imports = kernel.testAuthority.buildImportObject(memory) as {
      env: Record<string, (...args: any[]) => any>;
    };

    expect(imports.env.host_ftruncate(
      9n,
      BigInt(Number.MAX_SAFE_INTEGER) + 1n,
    )).toBe(-75);
    expect(ftruncate).not.toHaveBeenCalled();
  });

  it("publishes a staged read without lending kernel memory to PlatformIO", () => {
    let retained: Uint8Array | undefined;
    const read = vi.fn((
      _handle: number,
      destination: Uint8Array,
    ) => {
      retained = destination;
      destination.set([0x41, 0x42]);
      return 2;
    });
    const { kernel, memory } = kernelHarness({});
    Object.assign(kernel, { io: { read } });
    const imports = kernel.testAuthority.buildImportObject(memory) as {
      env: Record<string, (...args: any[]) => any>;
    };

    expect(imports.env.host_read(8n, 4096, 4)).toBe(2);
    expect(new Uint8Array(memory.buffer, 4096, 4))
      .toEqual(new Uint8Array([0x41, 0x42, 0, 0]));
    retained![0] = 0x7f;
    expect(new Uint8Array(memory.buffer, 4096, 2))
      .toEqual(new Uint8Array([0x41, 0x42]));
  });

  it.each([4, 8] as const)(
    "publishes a positioned wasm%d read at the exact memory boundary",
    (pointerWidth) => {
      const exactOffset = (1n << 53n) + 1n;
      let retained: Uint8Array | undefined;
      const read = vi.fn((
        _handle: number,
        destination: Uint8Array,
        offset: number | bigint | null,
      ) => {
        retained = destination;
        expect(offset).toBe(exactOffset);
        destination.set([0x31, 0x32, 0x33, 0x34]);
        return 4;
      });
      const { kernel, memory } = kernelHarness({}, pointerWidth);
      Object.assign(kernel, { io: { read } });
      const imports = kernel.testAuthority.buildImportObject(memory) as {
        env: Record<string, (...args: any[]) => any>;
      };
      const destination = memory.buffer.byteLength - 4;
      const pointer = pointerWidth === 4
        ? destination
        : BigInt(destination);

      expect(imports.env.host_pread(
        8n,
        pointer,
        4,
        1,
        0x20_0000,
      )).toBe(4);
      expect(read).toHaveBeenCalledWith(
        8,
        expect.any(Uint8Array),
        exactOffset,
        4,
      );
      expect(new Uint8Array(memory.buffer, destination, 4))
        .toEqual(new Uint8Array([0x31, 0x32, 0x33, 0x34]));

      retained![0] = 0x7f;
      expect(new Uint8Array(memory.buffer, destination, 4))
        .toEqual(new Uint8Array([0x31, 0x32, 0x33, 0x34]));

      read.mockClear();
      expect(imports.env.host_pread(
        8n,
        pointer,
        5,
        1,
        0x20_0000,
      )).toBe(-14);
      expect(read).not.toHaveBeenCalled();
    },
  );

  it("rejects an oversized positioned-read result without publishing bytes", () => {
    const read = vi.fn((
      _handle: number,
      destination: Uint8Array,
    ) => {
      destination.fill(0x6b);
      return destination.byteLength + 1;
    });
    const { kernel, memory } = kernelHarness({});
    Object.assign(kernel, { io: { read } });
    const imports = kernel.testAuthority.buildImportObject(memory) as {
      env: Record<string, (...args: any[]) => any>;
    };
    new Uint8Array(memory.buffer, 4096, 8).fill(0xa5);

    expect(imports.env.host_pread(8n, 4096, 4, 0, 0)).toBe(-5);
    expect(new Uint8Array(memory.buffer, 4096, 8))
      .toEqual(new Uint8Array(8).fill(0xa5));
  });

  it.each([4, 8] as const)(
    "passes an exact positioned wasm%d write without stream callbacks",
    (pointerWidth) => {
      const exactOffset = (1n << 53n) + 1n;
      const write = vi.fn(() => 4);
      const onStdout = vi.fn();
      const { kernel, memory } = kernelHarness({}, pointerWidth);
      Object.assign(kernel, {
        io: { write },
        callbacks: { onStdout },
      });
      const imports = kernel.testAuthority.buildImportObject(memory) as {
        env: Record<string, (...args: any[]) => any>;
      };
      const source = memory.buffer.byteLength - 4;
      new Uint8Array(memory.buffer, source, 4).set([1, 2, 3, 4]);
      const pointer = pointerWidth === 4 ? source : BigInt(source);

      expect(imports.env.host_pwrite(
        1n,
        pointer,
        4,
        1,
        0x20_0000,
      )).toBe(4);
      expect(write).toHaveBeenCalledWith(
        1,
        new Uint8Array([1, 2, 3, 4]),
        exactOffset,
        4,
      );
      expect(onStdout).not.toHaveBeenCalled();

      write.mockClear();
      expect(imports.env.host_pwrite(
        1n,
        pointer,
        5,
        1,
        0x20_0000,
      )).toBe(-14);
      expect(write).not.toHaveBeenCalled();
    },
  );

  it.each([4, 8] as const)(
    "passes a bounded wasm%d append through the explicit backend operation",
    (pointerWidth) => {
      const append = vi.fn(() => ({ written: 4, end: 19 }));
      const write = vi.fn();
      const onStdout = vi.fn();
      const { kernel, memory } = kernelHarness(
        {},
        pointerWidth,
        { append, write },
        { onStdout },
      );
      const imports = kernel.testAuthority.buildImportObject(memory) as {
        env: Record<string, (...args: any[]) => any>;
      };
      const source = memory.buffer.byteLength - 4;
      new Uint8Array(memory.buffer, source, 4).set([4, 3, 2, 1]);
      const pointer = pointerWidth === 4 ? source : BigInt(source);

      expect(imports.env.host_append(1n, pointer, 4, -1, -1)).toBe(4);
      expect(append).toHaveBeenCalledWith(
        1,
        new Uint8Array([4, 3, 2, 1]),
        4,
        null,
      );
      expect(imports.env.host_append_position(1n, 4)).toBe(19n);
      expect(write).not.toHaveBeenCalled();
      expect(onStdout).not.toHaveBeenCalled();

      append.mockClear();
      expect(imports.env.host_append(1n, pointer, 5, -1, -1)).toBe(-14);
      expect(append).not.toHaveBeenCalled();
    },
  );

  it("throws on an impossible append count returned by a backend", () => {
    const append = vi.fn(() => ({ written: 2, end: 2 }));
    const { kernel, memory } = kernelHarness({}, 4, { append });
    const imports = kernel.testAuthority.buildImportObject(memory) as {
      env: Record<string, (...args: any[]) => any>;
    };
    new Uint8Array(memory.buffer, 4096, 1)[0] = 0x41;

    expect(() => imports.env.host_append(8n, 4096, 1, -1, -1))
      .toThrow(/invalid append byte count/i);
  });

  it("reconstructs signed i64 seek words without Number precision loss", () => {
    const seek = vi.fn((
      _handle: number,
      offset: number | bigint,
    ) => offset < 0 ? 17 : offset);
    const { kernel, memory } = kernelHarness({});
    Object.assign(kernel, { io: { seek } });
    const imports = kernel.testAuthority.buildImportObject(memory) as {
      env: Record<string, (...args: any[]) => any>;
    };

    expect(imports.env.host_seek(8n, 1, 0x20_0000, 0))
      .toBe((1n << 53n) + 1n);
    expect(imports.env.host_seek(8n, 0xffff_ffff, -1, 0)).toBe(17n);
    expect(seek.mock.calls.map((call) => call[1]))
      .toEqual([(1n << 53n) + 1n, -1n]);
  });

  it.each([-1n, -(1n << 63n)])(
    "maps malformed negative backend seek result %s to EIO",
    (backendResult) => {
      const { kernel, memory } = kernelHarness({});
      Object.assign(kernel, {
        io: { seek: vi.fn(() => backendResult) },
      });
      const imports = kernel.testAuthority.buildImportObject(memory) as {
        env: Record<string, (...args: any[]) => any>;
      };

      expect(imports.env.host_seek(8n, 0, 0, 0)).toBe(-5n);
    },
  );

  it("rejects an invalid read destination before consuming backend data", () => {
    const read = vi.fn(() => 1);
    const { kernel, memory } = kernelHarness({});
    Object.assign(kernel, { io: { read } });
    const imports = kernel.testAuthority.buildImportObject(memory) as {
      env: Record<string, (...args: any[]) => any>;
    };

    expect(imports.env.host_read(
      8n,
      memory.buffer.byteLength - 2,
      4,
    )).toBe(-14);
    expect(read).not.toHaveBeenCalled();
  });

  it("rejects an invalid wait status destination before reaping", () => {
    const waitpid = vi.fn(() => ({ pid: 42, status: 0 }));
    const { kernel, memory } = kernelHarness({});
    Object.assign(kernel, { io: { waitpid } });
    const imports = kernel.testAuthority.buildImportObject(memory) as {
      env: Record<string, (...args: any[]) => any>;
    };

    expect(imports.env.host_waitpid(
      42,
      0,
      memory.buffer.byteLength - 2,
    )).toBe(-14);
    expect(waitpid).not.toHaveBeenCalled();
  });

  it("rejects network output larger than the Rust-provided capacity", () => {
    const { kernel, memory } = kernelHarness({});
    Object.assign(kernel, {
      io: {
        network: {
          recv: () => new Uint8Array(8).fill(0x6b),
        },
      },
    });
    const imports = kernel.testAuthority.buildImportObject(memory) as {
      env: Record<string, (...args: any[]) => any>;
    };
    new Uint8Array(memory.buffer).fill(0xa5, 4096, 4112);

    expect(imports.env.host_net_recv(1, 4096, 4, 0)).toBe(-5);
    expect(new Uint8Array(memory.buffer, 4096, 16))
      .toEqual(new Uint8Array(16).fill(0xa5));
  });

  it("uses a producer's intrinsic byte span instead of overridable length properties", () => {
    const output = hostileBytes(20);
    output.fill(0x6b);
    const { kernel, memory } = kernelHarness({});
    Object.assign(kernel, {
      io: {
        network: {
          recv: () => output,
        },
      },
    });
    const imports = kernel.testAuthority.buildImportObject(memory) as {
      env: Record<string, (...args: any[]) => any>;
    };
    new Uint8Array(memory.buffer).fill(0xa5, 4096, 4120);

    expect(imports.env.host_net_recv(1, 4096, 4, 0)).toBe(-5);
    expect(new Uint8Array(memory.buffer, 4096, 24))
      .toEqual(new Uint8Array(24).fill(0xa5));
    expect(() => kernel.testAuthority.writeKernelBytes(4096, 4, output))
      .toThrow(/20 exceeds capacity 4/i);
    expect(new Uint8Array(memory.buffer, 4096, 24))
      .toEqual(new Uint8Array(24).fill(0xa5));
  });

  it("rejects a non-typed-array address producer without touching kernel memory", () => {
    const { kernel, memory } = kernelHarness({});
    Object.assign(kernel, {
      io: {
        network: {
          getaddrinfo: () => ({
            byteLength: 1,
            length: 20,
            0: 127,
          }),
        },
      },
    });
    const imports = kernel.testAuthority.buildImportObject(memory) as {
      env: Record<string, (...args: any[]) => any>;
    };
    new Uint8Array(memory.buffer, 2048, 2).set([0x78, 0]);
    new Uint8Array(memory.buffer).fill(0xa5, 4096, 4112);

    expect(imports.env.host_getaddrinfo(2048, 1, 4096, 4)).toBe(-5);
    expect(new Uint8Array(memory.buffer, 4096, 16))
      .toEqual(new Uint8Array(16).fill(0xa5));
  });

  it("preserves an asynchronous DNS EAGAIN before producer validation", () => {
    const { kernel, memory } = kernelHarness({});
    Object.assign(kernel, {
      io: {
        network: {
          getaddrinfo: () => {
            throw Object.assign(new Error("DNS pending"), { errno: 11 });
          },
        },
      },
    });
    const imports = kernel.testAuthority.buildImportObject(memory) as {
      env: Record<string, (...args: any[]) => any>;
    };
    new Uint8Array(memory.buffer, 2048, 2).set([0x78, 0]);
    new Uint8Array(memory.buffer).fill(0xa5, 4096, 4112);

    expect(imports.env.host_getaddrinfo(2048, 1, 4096, 4)).toBe(-11);
    expect(new Uint8Array(memory.buffer, 4096, 16))
      .toEqual(new Uint8Array(16).fill(0xa5));
  });

  it("clips hostile stdin bytes through a plain exact view and preserves the canary", () => {
    const output = hostileBytes(20);
    Uint8Array.prototype.set.call(output, [1, 2, 3, 4, 5]);
    const { kernel, memory } = kernelHarness({});
    Object.assign(kernel, {
      callbacks: {
        onStdin: () => output,
      },
    });
    const imports = kernel.testAuthority.buildImportObject(memory) as {
      env: Record<string, (...args: any[]) => any>;
    };
    new Uint8Array(memory.buffer).fill(0xa5, 4096, 4104);

    expect(imports.env.host_read(0n, 4096, 4)).toBe(4);
    expect(new Uint8Array(memory.buffer, 4096, 8))
      .toEqual(new Uint8Array([1, 2, 3, 4, 0xa5, 0xa5, 0xa5, 0xa5]));
  });

  it("rejects a null positive-length getrandom pointer", () => {
    const { kernel, memory } = kernelHarness({});
    const imports = kernel.testAuthority.buildImportObject(memory) as {
      env: Record<string, (...args: any[]) => any>;
    };

    expect(imports.env.host_getrandom(0, 1)).toBe(-14);
  });

  it("rejects an unrepresentable wasm64 process-copy destination before a kernel write", () => {
    const processMemory = new WebAssembly.Memory({ initial: 1 });
    const { kernel, memory } = kernelHarness({}, 8);
    Object.assign(kernel, {
      callbacks: {
        getProcessMemory: () => processMemory,
      },
    });
    const imports = kernel.testAuthority.buildImportObject(memory) as {
      env: Record<string, (...args: any[]) => any>;
    };
    new Uint8Array(memory.buffer).fill(0xa5, 4096, 4100);

    expect(imports.env.host_proc_read_bytes(
      7,
      1024,
      BigInt(Number.MAX_SAFE_INTEGER) + 1n,
      4,
    )).toBe(-14);
    expect(new Uint8Array(memory.buffer, 4096, 4))
      .toEqual(new Uint8Array(4).fill(0xa5));
  });

  it("rejects null positive-length process transfer ranges", () => {
    const processMemory = new WebAssembly.Memory({ initial: 1 });
    const { kernel, memory } = kernelHarness({});
    Object.assign(kernel, {
      callbacks: {
        getProcessMemory: () => processMemory,
      },
    });
    const imports = kernel.testAuthority.buildImportObject(memory) as {
      env: Record<string, (...args: any[]) => any>;
    };
    new Uint8Array(memory.buffer, 4096, 4).set([1, 2, 3, 4]);
    new Uint8Array(processMemory.buffer, 0, 4).fill(0xa5);

    expect(imports.env.host_proc_write_bytes(7, 0, 4096, 4)).toBe(-14);
    expect(new Uint8Array(processMemory.buffer, 0, 4))
      .toEqual(new Uint8Array(4).fill(0xa5));
    expect(imports.env.host_proc_read_bytes(7, 0, 4096, 4)).toBe(-14);
    expect(new Uint8Array(memory.buffer, 4096, 4))
      .toEqual(new Uint8Array([1, 2, 3, 4]));
  });

  it("enforces exact process-memory transfer boundaries", () => {
    const processMemory = new WebAssembly.Memory({ initial: 1 });
    const { kernel, memory } = kernelHarness({});
    Object.assign(kernel, {
      callbacks: {
        getProcessMemory: () => processMemory,
      },
    });
    const imports = kernel.testAuthority.buildImportObject(memory) as {
      env: Record<string, (...args: any[]) => any>;
    };
    const processEnd = processMemory.buffer.byteLength;
    new Uint8Array(memory.buffer, 4096, 4).set([1, 2, 3, 4]);

    expect(imports.env.host_proc_write_bytes(
      7,
      processEnd - 4,
      4096,
      4,
    )).toBe(0);
    expect(new Uint8Array(processMemory.buffer, processEnd - 4, 4))
      .toEqual(new Uint8Array([1, 2, 3, 4]));
    expect(imports.env.host_proc_write_bytes(
      7,
      processEnd - 4,
      4096,
      5,
    )).toBe(-14);

    new Uint8Array(processMemory.buffer, processEnd - 4, 4)
      .set([5, 6, 7, 8]);
    expect(imports.env.host_proc_read_bytes(
      7,
      processEnd - 4,
      8192,
      4,
    )).toBe(0);
    expect(new Uint8Array(memory.buffer, 8192, 4))
      .toEqual(new Uint8Array([5, 6, 7, 8]));
    expect(imports.env.host_proc_read_bytes(
      7,
      processEnd - 4,
      8192,
      5,
    )).toBe(-14);
  });

  it("does not wrap a wasm64 futex address onto a low kernel word", () => {
    const { kernel, memory } = kernelHarness({}, 8);
    const imports = kernel.testAuthority.buildImportObject(memory) as {
      env: Record<string, (...args: any[]) => any>;
    };
    const notify = vi.spyOn(Atomics, "notify");

    expect(imports.env.host_futex_wake(0x1_0000_1000n, 1)).toBe(-14);
    expect(notify).not.toHaveBeenCalled();
    notify.mockRestore();
  });

  it("rejects unaligned and end-crossing futex words", () => {
    const { kernel, memory } = kernelHarness({});
    const imports = kernel.testAuthority.buildImportObject(memory) as {
      env: Record<string, (...args: any[]) => any>;
    };

    expect(imports.env.host_futex_wake(4097, 1)).toBe(-22);
    expect(imports.env.host_futex_wake(
      memory.buffer.byteLength - 2,
      1,
    )).toBe(-14);
  });

  it("rejects lossy device metadata conversions before registration", () => {
    const { kernel, memory } = fullKernelHarness({}, {}, 8);
    const imports = kernel.testAuthority.buildImportObject(memory) as {
      env: Record<string, (...args: any[]) => any>;
    };
    const invalid = BigInt(Number.MAX_SAFE_INTEGER) + 1n;

    expect(() =>
      imports.env.host_bind_framebuffer(7, invalid, 4096n, 1, 1, 4, 0)
    ).toThrow(/representable|safe/i);
    expect(kernel.framebuffers.get(7)).toBeUndefined();
    expect(imports.env.host_gbm_bo_create(
      7,
      1,
      invalid,
      1,
      1,
      4,
    )).toBe(-75);
    expect(() => imports.env.host_gl_bind(7, invalid, 4096n))
      .toThrow(/representable|safe/i);
    expect(kernel.gl.get(7)).toBeUndefined();
  });

  it("reports a host BO allocation failure without publishing an entry", () => {
    const { kernel, memory } = fullKernelHarness();
    const create = vi.spyOn(kernel.bos, "create").mockImplementation(() => {
      throw new RangeError("allocation failed");
    });
    const imports = kernel.testAuthority.buildImportObject(memory) as {
      env: Record<string, (...args: any[]) => any>;
    };

    expect(imports.env.host_gbm_bo_create(7, 1, 4096n, 1, 1, 4))
      .toBe(-12);
    expect(create).toHaveBeenCalledTimes(1);
    expect(kernel.bos.get(7, 1)).toBeUndefined();
  });

  it("preflights GL output before executing a query", () => {
    const { kernel, memory } = fullKernelHarness();
    kernel.gl.bind({ pid: 7, cmdbufAddr: 4096, cmdbufLen: 4096 });
    const getError = vi.fn(() => 0x1234);
    kernel.gl.get(7)!.gl = {
      getError,
    } as unknown as WebGL2RenderingContext;
    const imports = kernel.testAuthority.buildImportObject(memory) as {
      env: Record<string, (...args: any[]) => any>;
    };

    expect(imports.env.host_gl_query(
      7,
      QOP_GET_ERROR,
      0,
      0,
      memory.buffer.byteLength - 2,
      4,
    )).toBe(-14);
    expect(getError).not.toHaveBeenCalled();

    expect(imports.env.host_gl_query(
      7,
      QOP_GET_ERROR,
      0,
      0,
      memory.buffer.byteLength - 4,
      4,
    )).toBe(4);
    expect(getError).toHaveBeenCalledTimes(1);
    expect(
      new DataView(memory.buffer).getUint32(
        memory.buffer.byteLength - 4,
        true,
      ),
    ).toBe(0x1234);
  });

  it("records the GL query answer the guest was handed", () => {
    const { kernel, memory } = fullKernelHarness();
    kernel.gl.bind({ pid: 7, cmdbufAddr: 4096, cmdbufLen: 4096 });
    kernel.gl.get(7)!.gl = {
      getError: () => 0x1234,
    } as unknown as WebGL2RenderingContext;
    const recorded: { op: number; rc: number; bytes: Uint8Array }[] = [];
    kernel.setGlQueryTap({
      mode: "record",
      record: (op, rc, bytes) => recorded.push({ op, rc, bytes }),
    });
    const imports = kernel.testAuthority.buildImportObject(memory) as {
      env: Record<string, (...args: any[]) => any>;
    };

    const out = memory.buffer.byteLength - 4;
    expect(imports.env.host_gl_query(7, QOP_GET_ERROR, 0, 0, out, 4)).toBe(4);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.op).toBe(QOP_GET_ERROR);
    expect(recorded[0]!.rc).toBe(4);
    expect(new DataView(
      recorded[0]!.bytes.buffer,
      recorded[0]!.bytes.byteOffset,
    ).getUint32(0, true)).toBe(0x1234);
  });

  it("records the -1 a context-less machine answers", () => {
    const { kernel, memory } = fullKernelHarness();
    kernel.gl.bind({ pid: 7, cmdbufAddr: 4096, cmdbufLen: 4096 });
    const recorded: { rc: number }[] = [];
    kernel.setGlQueryTap({
      mode: "record",
      record: (_op, rc) => recorded.push({ rc }),
    });
    const imports = kernel.testAuthority.buildImportObject(memory) as {
      env: Record<string, (...args: any[]) => any>;
    };

    const out = memory.buffer.byteLength - 4;
    expect(imports.env.host_gl_query(7, QOP_GET_ERROR, 0, 0, out, 4)).toBe(-1);
    expect(recorded).toEqual([{ rc: -1 }]);
  });

  it("serves the logged GL answer over the local GPU's on replay", () => {
    const { kernel, memory } = fullKernelHarness();
    kernel.gl.bind({ pid: 7, cmdbufAddr: 4096, cmdbufLen: 4096 });
    const getError = vi.fn(() => 0x9999);
    kernel.gl.get(7)!.gl = {
      getError,
    } as unknown as WebGL2RenderingContext;
    const logged = new Uint8Array(4);
    new DataView(logged.buffer).setUint32(0, 0x1234, true);
    kernel.setGlQueryTap({
      mode: "replay",
      take: (op) => {
        expect(op).toBe(QOP_GET_ERROR);
        return { rc: 4, bytes: logged };
      },
    });
    const imports = kernel.testAuthority.buildImportObject(memory) as {
      env: Record<string, (...args: any[]) => any>;
    };

    const out = memory.buffer.byteLength - 4;
    expect(imports.env.host_gl_query(7, QOP_GET_ERROR, 0, 0, out, 4)).toBe(4);
    // The local query still ran, for its side effects; the guest never saw
    // its answer.
    expect(getError).toHaveBeenCalledTimes(1);
    expect(new DataView(memory.buffer).getUint32(out, true)).toBe(0x1234);
  });

  it("serves the logged GL answer on a replica with no context yet", () => {
    const { kernel, memory } = fullKernelHarness();
    kernel.gl.bind({ pid: 7, cmdbufAddr: 4096, cmdbufLen: 4096 });
    const logged = new Uint8Array(4);
    new DataView(logged.buffer).setUint32(0, 0x1234, true);
    kernel.setGlQueryTap({
      mode: "replay",
      take: () => ({ rc: 4, bytes: logged }),
    });
    const imports = kernel.testAuthority.buildImportObject(memory) as {
      env: Record<string, (...args: any[]) => any>;
    };

    const out = memory.buffer.byteLength - 4;
    expect(imports.env.host_gl_query(7, QOP_GET_ERROR, 0, 0, out, 4)).toBe(4);
    expect(new DataView(memory.buffer).getUint32(out, true)).toBe(0x1234);
  });

  it("lets a replay divergence out of host_gl_query", () => {
    const { kernel, memory } = fullKernelHarness();
    kernel.gl.bind({ pid: 7, cmdbufAddr: 4096, cmdbufLen: 4096 });
    kernel.setGlQueryTap({
      mode: "replay",
      take: () => {
        throw new Error("replication log diverged at 3");
      },
    });
    const imports = kernel.testAuthority.buildImportObject(memory) as {
      env: Record<string, (...args: any[]) => any>;
    };

    const out = memory.buffer.byteLength - 4;
    expect(() => imports.env.host_gl_query(7, QOP_GET_ERROR, 0, 0, out, 4))
      .toThrow("replication log diverged at 3");
  });

  it("lets every worker take a connection on an unreplicated machine", () => {
    const { kernel, memory } = fullKernelHarness();
    const imports = kernel.testAuthority.buildImportObject(memory) as {
      env: Record<string, (...args: any[]) => any>;
    };

    expect(imports.env.host_accept_select(3, 101)).toBe(1);
    expect(imports.env.host_accept_select(3, 104)).toBe(1);
  });

  it("records which worker won the accept queue", () => {
    const { kernel, memory } = fullKernelHarness();
    const recorded: { listener: number; pid: number }[] = [];
    kernel.setAcceptSelectionTap({
      mode: "record",
      record: (listener, pid) => recorded.push({ listener, pid }),
    });
    const imports = kernel.testAuthority.buildImportObject(memory) as {
      env: Record<string, (...args: any[]) => any>;
    };

    expect(imports.env.host_accept_select(3, 104)).toBe(1);
    expect(recorded).toEqual([{ listener: 3, pid: 104 }]);
  });

  it("holds the connection for the logged worker on replay", () => {
    const { kernel, memory } = fullKernelHarness();
    kernel.setAcceptSelectionTap({
      mode: "replay",
      select: (listener, pid) => {
        expect(listener).toBe(3);
        return pid === 104;
      },
    });
    const imports = kernel.testAuthority.buildImportObject(memory) as {
      env: Record<string, (...args: any[]) => any>;
    };

    expect(imports.env.host_accept_select(3, 101)).toBe(0);
    expect(imports.env.host_accept_select(3, 104)).toBe(1);
  });

  it("lets a replay divergence out of host_accept_select", () => {
    const { kernel, memory } = fullKernelHarness();
    kernel.setAcceptSelectionTap({
      mode: "replay",
      select: () => {
        throw new Error("replication log diverged at 3");
      },
    });
    const imports = kernel.testAuthority.buildImportObject(memory) as {
      env: Record<string, (...args: any[]) => any>;
    };

    expect(() => imports.env.host_accept_select(3, 104))
      .toThrow("replication log diverged at 3");
  });

  it.each([4, 8] as const)(
    "writes the generated KMS mode size at the exact wasm%d memory boundary",
    (pointerWidth) => {
    const { kernel, memory } = fullKernelHarness({}, {}, pointerWidth);
    const imports = kernel.testAuthority.buildImportObject(memory) as {
      env: Record<string, (...args: any[]) => any>;
    };
    const exactPointer =
      memory.buffer.byteLength - STRUCT_SIZE_WPK_DRM_MODE_MODEINFO;
    const pointer = (value: number): number | bigint =>
      pointerWidth === 4 ? value : BigInt(value);

    expect(() =>
      imports.env.host_kms_mode_info(1, pointer(exactPointer))
    ).not.toThrow();
    expect(
      new Uint8Array(
        memory.buffer,
        exactPointer,
        STRUCT_SIZE_WPK_DRM_MODE_MODEINFO,
      ).some((byte) => byte !== 0),
    ).toBe(true);
    expect(() =>
      imports.env.host_kms_mode_info(1, pointer(exactPointer + 1))
    ).toThrow(/outside|range/i);
    },
  );

  it("restores the unsigned high bit of a raw wasm32 import pointer", () => {
    const highMemory = new WebAssembly.Memory({
      initial: 32_769,
      maximum: 32_769,
    });
    const { kernel } = fullKernelHarness({}, {}, 4, highMemory);
    const imports = kernel.testAuthority.buildImportObject(highMemory) as {
      env: Record<string, (...args: any[]) => any>;
    };
    const unsignedPointer = 0x8000_0020;
    const signedImportPointer = unsignedPointer | 0;

    expect(signedImportPointer).toBeLessThan(0);
    expect(() =>
      imports.env.host_kms_mode_info(1, signedImportPointer)
    ).not.toThrow();
    expect(
      new Uint8Array(
        highMemory.buffer,
        unsignedPointer,
        STRUCT_SIZE_WPK_DRM_MODE_MODEINFO,
      ).some((byte) => byte !== 0),
    ).toBe(true);
  });
});
