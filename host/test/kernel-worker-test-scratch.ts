import { CH_TOTAL_SIZE } from "../src/generated/abi";
import {
  createKernelEntryGatedInstance,
  KernelEntryGate,
} from "../src/kernel-entry-gate";
import { allocateKernelScratchRegion } from "../src/kernel-scratch";
import { createKernelScratchTestInstance } from "./support/kernel-scratch-instance";

interface KernelWorkerTestAuthority {
  initializeKernelForTest(options: {
    readonly instance: WebAssembly.Instance;
    readonly gate: KernelEntryGate;
    readonly mainScratch: ReturnType<typeof allocateKernelScratchRegion>;
  }): void;
}

interface KernelWorkerTestScratchOptions {
  readonly boundInstance?: WebAssembly.Instance;
  readonly gate?: KernelEntryGate;
  readonly kernelExports?: Readonly<Record<string, unknown>>;
  /** Restrict the genuine fixture to these exports for required-export tests. */
  readonly kernelExportNames?: readonly string[];
}

/** Neutral Rust-owned timer teardown result for tests without platform timers. */
export function emptyProcessTimerCleanup(
  memory: WebAssembly.Memory,
): (_pid: number, outPointer: number | bigint, outCapacity: number) => number {
  return (_pid, outPointer, outCapacity) => {
    if (outCapacity < 12 || (outCapacity - 8) % 4 !== 0) return -22;
    const output = new DataView(memory.buffer);
    output.setUint32(Number(outPointer), 0, true);
    output.setUint32(Number(outPointer) + 4, 0, true);
    return 0;
  };
}

/**
 * Install the same gated, capacity-carrying main scratch contract that
 * worker.init() creates.
 *
 * Structural export mocks remain owned by the test. The worker receives only
 * a genuine Wasm instance, its exact gate-bound facade, and an
 * allocator-created region for that same generation.
 *
 * The installed gate comes back so a test can model a busy kernel entry
 * without rebuilding the instance this helper already made.
 */
export function installKernelWorkerTestScratch(
  worker: {
    readonly testAuthority?: KernelWorkerTestAuthority;
  },
  memory: WebAssembly.Memory,
  pointer = 128,
  pointerWidth: 4 | 8 = 4,
  options: KernelWorkerTestScratchOptions = {},
): { readonly pointer: number; readonly gate: KernelEntryGate } {
  const authority = worker.testAuthority;
  if (authority === undefined) {
    throw new Error("worker is not a module-authorized kernel test double");
  }
  if ((options.boundInstance === undefined) !== (options.gate === undefined)) {
    throw new Error(
      "a bound test instance and its exact kernel entry gate must be provided together",
    );
  }
  if (
    options.boundInstance !== undefined &&
    options.kernelExports !== undefined
  ) {
    throw new Error(
      "kernelExports cannot replace exports on an already-bound test instance",
    );
  }
  const gate = options.gate ?? new KernelEntryGate();
  const gatedInstance = options.boundInstance ?? (() => {
    // Most worker tests do not model platform timers. An empty, bounded
    // Rust-owned cleanup record is the neutral production result; timer
    // ownership tests override this implementation explicitly.
    const defaultTimerCleanup = emptyProcessTimerCleanup(memory);
    const rawInstance = createKernelScratchTestInstance(
      pointerWidth,
      memory,
      // WHY: scratch fixtures intentionally resolve mutable test doubles at
      // call time. Rebuilding this shallow view preserves that late binding
      // while still supplying the neutral timer implementation; capturing a
      // one-time spread would silently ignore later fault injection.
      () => ({
        kernel_take_process_timer_cleanup: defaultTimerCleanup,
        ...options.kernelExports,
      }),
      () => pointerWidth === 8 ? BigInt(pointer) : pointer,
      4,
      options.kernelExportNames,
    );
    return createKernelEntryGatedInstance(
      rawInstance,
      gate,
    );
  })();
  const mainScratch = allocateKernelScratchRegion(
    memory,
    gatedInstance.exports.kernel_alloc_scratch as
      (size: number) => number | bigint,
    CH_TOTAL_SIZE,
    pointerWidth,
    "test kernel syscall scratch",
    gatedInstance,
  );
  authority.initializeKernelForTest({
    instance: gatedInstance,
    gate,
    mainScratch,
  });
  return { pointer, gate };
}
