import { describe, expect, it } from "vitest";

import {
  createWasmPosixKernelTestHarness,
  WasmPosixKernel,
} from "../src/kernel";
import { createKernelScratchTestInstance } from "./support/kernel-scratch-instance";

/**
 * H1 (host-surface minimization): `host_debug_log` must be a raw byte sink
 * to stderr on every host, with no added prefix and no added newline. Any
 * prefix/newline is the Rust caller's responsibility, so the exact same
 * bytes cross the host boundary identically on Node/browser and native
 * (`crates/host-native/src/guest.rs`'s `host_debug_log` writes the bytes
 * verbatim to stderr with no `write_all(b"[kernel] ")`/`write_all(b"\n")`
 * calls).
 */
function kernelHarness(
  callbacks: Record<string, unknown> = {},
): { kernel: WasmPosixKernel & Record<string, any>; memory: WebAssembly.Memory } {
  const exports: Record<string, unknown> = {};
  const memory = new WebAssembly.Memory({ initial: 2, maximum: 2 });
  const kernel = createWasmPosixKernelTestHarness({
    io: {} as any,
    callbacks: callbacks as any,
    memory,
    pointerWidth: 4,
    instance: createKernelScratchTestInstance(
      4,
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

describe("host_debug_log raw passthrough (H1 cross-host parity)", () => {
  it("writes the guest's bytes to stderr verbatim, with no [KERNEL] prefix and no added newline", () => {
    const stderrChunks: Uint8Array[] = [];
    const { kernel, memory } = kernelHarness({
      onStderr: (data: Uint8Array) => stderrChunks.push(data.slice()),
    });
    const imports = kernel.testAuthority.buildImportObject(memory) as {
      env: Record<string, (...args: any[]) => any>;
    };

    const message = "boot: mounted /dev";
    const bytes = new TextEncoder().encode(message);
    const pointer = 64;
    new Uint8Array(memory.buffer, pointer, bytes.length).set(bytes);

    const result = imports.env.host_debug_log(pointer, bytes.length);

    expect(result).toBeUndefined();
    expect(stderrChunks).toHaveLength(1);
    expect(new TextDecoder().decode(stderrChunks[0])).toBe(message);
    // No [KERNEL] prefix, no trailing newline: byte-for-byte identical to
    // what native's host_debug_log writes for the same input.
    expect(stderrChunks[0]).toEqual(bytes);
  });

  it("falls back to process.stderr, then console.error, matching the fd=2 host_write fallback chain", () => {
    const { kernel, memory } = kernelHarness({});
    const imports = kernel.testAuthority.buildImportObject(memory) as {
      env: Record<string, (...args: any[]) => any>;
    };

    const message = "no callback registered";
    const bytes = new TextEncoder().encode(message);
    const pointer = 64;
    new Uint8Array(memory.buffer, pointer, bytes.length).set(bytes);

    const writes: Uint8Array[] = [];
    const originalStderr = (globalThis as any).process?.stderr;
    const fakeProcess = {
      stderr: { write: (data: Uint8Array) => writes.push(data) },
    };
    const hadProcess = "process" in globalThis;
    const originalProcess = (globalThis as any).process;
    (globalThis as any).process = fakeProcess;
    try {
      imports.env.host_debug_log(pointer, bytes.length);
    } finally {
      if (hadProcess) {
        (globalThis as any).process = originalProcess;
      } else {
        delete (globalThis as any).process;
      }
    }

    expect(writes).toHaveLength(1);
    expect(new TextDecoder().decode(writes[0])).toBe(message);
    void originalStderr;
  });
});
