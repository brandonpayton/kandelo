import { describe, expect, it, vi } from "vitest";

import {
  createWasmPosixKernelTestHarness,
  WasmPosixKernel,
} from "../src/kernel";
import { createKernelScratchTestInstance } from "./support/kernel-scratch-instance";

const ENOSYS = 38;
const EIO = 5;
const EPERM = 1;

/**
 * Mirrors the `kernelHarness` helper used by the `host_read`/`host_pread`
 * import tests in kernel-public-scratch.test.ts, scoped to what
 * `host_fetch_archive` needs: a real Memory the destination-factory can
 * validate the pointer/capacity pair against.
 */
function kernelHarness(
  exports: Record<string, unknown> = {},
  pointerWidth: 4 | 8 = 4,
): { kernel: WasmPosixKernel & Record<string, any>; memory: WebAssembly.Memory } {
  const memory = new WebAssembly.Memory({ initial: 2, maximum: 2 });
  const kernel = createWasmPosixKernelTestHarness({
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

function importsOf(
  kernel: WasmPosixKernel & Record<string, any>,
  memory: WebAssembly.Memory,
): { env: Record<string, (...args: any[]) => any> } {
  return kernel.testAuthority.buildImportObject(memory) as {
    env: Record<string, (...args: any[]) => any>;
  };
}

describe("host_fetch_archive provider seam (Phase 5 3b-wiring.2)", () => {
  it("reports ENOSYS when no archive provider is installed", () => {
    const { kernel, memory } = kernelHarness();
    const imports = importsOf(kernel, memory);

    expect(imports.env.host_fetch_archive(7, 4096, 4, 0, 0)).toBe(-ENOSYS);
  });

  it("stages installed provider bytes into the destination exactly once", () => {
    const { kernel, memory } = kernelHarness();
    const imports = importsOf(kernel, memory);
    let retained: Uint8Array | undefined;
    const provider = vi.fn((
      archiveId: number,
      offset: bigint,
      dest: Uint8Array,
    ) => {
      expect(archiveId).toBe(7);
      expect(offset).toBe(0n);
      retained = dest;
      dest.set([0x41, 0x42]);
      return 2;
    });
    kernel.setRootfsArchiveProvider(provider);

    expect(imports.env.host_fetch_archive(7, 4096, 4, 0, 0)).toBe(2);
    expect(provider).toHaveBeenCalledOnce();
    expect(new Uint8Array(memory.buffer, 4096, 4))
      .toEqual(new Uint8Array([0x41, 0x42, 0, 0]));

    // Bytes are staged and published once, never lent live: mutating the
    // provider's own buffer after the call must not retroactively change
    // published kernel memory.
    retained![0] = 0x7f;
    expect(new Uint8Array(memory.buffer, 4096, 2))
      .toEqual(new Uint8Array([0x41, 0x42]));
  });

  it("passes a provider-reported negative errno through unchanged", () => {
    const { kernel, memory } = kernelHarness();
    const imports = importsOf(kernel, memory);
    kernel.setRootfsArchiveProvider(() => -EPERM);

    expect(imports.env.host_fetch_archive(7, 4096, 4, 0, 0)).toBe(-EPERM);
  });

  it("rejects a provider result exceeding the destination capacity as EIO without publishing bytes", () => {
    const { kernel, memory } = kernelHarness();
    const imports = importsOf(kernel, memory);
    kernel.setRootfsArchiveProvider((_archiveId, _offset, dest) => {
      dest.fill(0x6b);
      return dest.byteLength + 1;
    });
    new Uint8Array(memory.buffer, 4096, 8).fill(0xa5);

    expect(imports.env.host_fetch_archive(7, 4096, 4, 0, 0)).toBe(-EIO);
    expect(new Uint8Array(memory.buffer, 4096, 8))
      .toEqual(new Uint8Array(8).fill(0xa5));
  });
});
