import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ContinuationAllocationError,
  LinkedForkContinuation,
  readLinkedFrameFormat,
} from "../src/fork-continuation";
import { ForkModuleStateArena } from "../src/fork-module-state";
import { installTestForkCaptureModule } from "./fork-capture-module-fixture";
import { SingleActivationForkRuntime } from "./fork-instrument-runtime-harness";

// A5 re-home: the co-resident fork module is now the unconditional capture
// engine (no JS `ForkReferenceTransaction` fallback), and it imports a SHARED
// memory. These reference-free abort/unwind forks therefore run against a
// shared guest memory with a real capture module wired exactly as a production
// worker does (`setCaptureModule`). The module reference graph is empty for
// these forks; the assertions below exercise continuation frame reconstruction,
// abort recovery, and payload ownership, which are independent of the (empty)
// reference graph.
describe("instrumented ABORT_UNWINDING", () => {
  it("reconstructs committed inner frames and permits a later successful fork", () => {
    const dir = mkdtempSync(join(tmpdir(), "kandelo-fork-abort-"));
    try {
      const rawPath = join(dir, "abort.wasm");
      const instrumentedPath = join(dir, "abort.instrumented.wasm");
      // The outer function has a roughly 72 KiB scalar payload. Its caller
      // (run) first commits a small frame into the root chunk, then outer's
      // reservation requires a second mapping where failure is injected.
      const outerLocalCount = 9_000;
      const outerLocalInit = Array.from(
        { length: outerLocalCount },
        (_, index) => `i64.const ${index} local.set ${index}`,
      ).join("\n");
      const wat = `(module
        (import "kernel" "kernel_fork" (func $fork (result i32)))
        (import "env" "memory" (memory 8 1024 shared))
        (func $leaf (result i32) call $fork)
        (func $outer (result i32) (local ${"i64 ".repeat(outerLocalCount)})
          ${outerLocalInit}
          call $leaf)
        (func (export "run") (result i32) (local $saved i32)
          i32.const 7
          local.set $saved
          call $outer
          local.get $saved
          i32.add))`;
      const watPath = join(dir, "abort.wat");
      writeFileSync(watPath, wat);
      execFileSync("wat2wasm", ["--enable-threads", watPath, "-o", rawPath]);
      execFileSync(fileURLToPath(new URL(
        "../../tools/bin/wasm-fork-instrument",
        import.meta.url,
      )), [
        rawPath,
        "-o",
        instrumentedPath,
      ]);

      const bytes = readFileSync(instrumentedPath);
      const module = new WebAssembly.Module(bytes);
      const memory = new WebAssembly.Memory({ initial: 8, maximum: 1024, shared: true });
      let instance: WebAssembly.Instance;
      let forkResult = 0;
      let failGrowth = true;
      let nextAddress = 65_536;
      let nextArenaAddress = 5 * 65_536;
      const released: Array<{ addr: number; size: number }> = [];
      const continuation = new LinkedForkContinuation(
        memory,
        readLinkedFrameFormat(module),
        (size) => {
          if (failGrowth && nextAddress !== 65_536) {
            throw new ContinuationAllocationError(12, size, "injected ENOMEM");
          }
          const addr = nextAddress;
          nextAddress += size;
          return addr;
        },
        (addr, size) => released.push({ addr, size }),
        "abort-e2e",
      );
      const runtime = new SingleActivationForkRuntime({
        module,
        moduleBytes: bytes,
        memory,
        continuation,
        newArena: () => new ForkModuleStateArena(
          memory,
          4,
          (size) => {
            const address = nextArenaAddress;
            nextArenaAddress += size;
            const missing = nextArenaAddress - memory.buffer.byteLength;
            if (missing > 0) memory.grow(Math.ceil(missing / 65_536));
            return address;
          },
          () => {},
          "abort-e2e module state",
        ),
        label: "abort-e2e",
      });
      runtime.registry.setCaptureModule(
        installTestForkCaptureModule(memory, "abort-e2e"),
      );

      const imports = {
        env: {
          memory,
          ...runtime.envImports,
        },
        kernel: {
          kernel_fork: () => {
            const phase = runtime.coordinator.phaseName();
            if (phase === "parent-replay") {
              runtime.coordinator.finishReplay();
              return forkResult;
            }
            if (phase === "abort-replay") {
              const errno = continuation.abortErrno();
              runtime.coordinator.finishAbortReplay();
              return -errno;
            }
            runtime.beginCapture();
            return 0;
          },
        },
      };
      instance = new WebAssembly.Instance(module, imports);
      runtime.register(instance);
      const run = instance.exports.run as () => number;
      const state = instance.exports.wpk_fork_state as () => number;

      expect(run()).toBe(-5); // raw -ENOMEM plus the preserved caller local 7
      expect(state()).toBe(0);
      expect(continuation.hasActiveContinuation()).toBe(false);
      expect(released).toEqual([{ addr: 65_536, size: 65_536 }]);

      // Reuse the released root and allow the large second chunk. A negative
      // SYS_FORK result after a complete unwind must replay to the guest.
      failGrowth = false;
      nextAddress = 65_536;
      runtime.expectCaptureTransport(run);
      expect(state()).toBe(1);
      runtime.coordinator.sealCapture();
      forkResult = -11;
      runtime.coordinator.beginParentReplay();
      expect(run()).toBe(-4);
      expect(state()).toBe(0);
      expect(continuation.hasActiveContinuation()).toBe(false);

      // A later independent fork can still complete successfully.
      nextAddress = 65_536;
      runtime.expectCaptureTransport(run);
      runtime.coordinator.sealCapture();
      forkResult = 123;
      runtime.coordinator.beginParentReplay();
      expect(run()).toBe(130);
      expect(state()).toBe(0);
      expect(continuation.hasActiveContinuation()).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("preserves recursive plain-catch ownership across abort recovery", () => {
    const dir = mkdtempSync(join(tmpdir(), "kandelo-fork-abort-catch-"));
    try {
      const rawPath = join(dir, "abort-catch.wasm");
      const instrumentedPath = join(dir, "abort-catch.instrumented.wasm");
      const outerLocalCount = 9_000;
      const outerLocalInit = Array.from(
        { length: outerLocalCount },
        (_, index) => `i64.const ${index} local.set ${index}`,
      ).join("\n");
      const wat = `(module
        (import "kernel" "kernel_fork" (func $fork (result i32)))
        (import "env" "memory" (memory 8 1024 shared))
        (tag $payload (param i32))
        (func $recurse (param $depth i32) (result i32)
          (local $caught i32)
          (block $handler (result i32)
            (try_table (catch $payload $handler)
              local.get $depth
              i32.const 100
              i32.add
              throw $payload
              unreachable)
            unreachable)
          local.set $caught
          local.get $depth
          if (result i32)
            local.get $depth
            i32.const 1
            i32.sub
            call $recurse
          else
            call $fork
          end
          local.get $caught
          i32.add)
        (func (export "run") (result i32)
          (local ${"i64 ".repeat(outerLocalCount)})
          (local $guard i32)
          ${outerLocalInit}
          i32.const 7
          local.set $guard
          i32.const 2
          call $recurse
          local.get $guard
          i32.add))`;
      const watPath = join(dir, "abort-catch.wat");
      writeFileSync(watPath, wat);
      execFileSync("wat2wasm", [
        "--enable-exceptions",
        "--enable-threads",
        watPath,
        "-o",
        rawPath,
      ]);
      execFileSync(fileURLToPath(new URL(
        "../../tools/bin/wasm-fork-instrument",
        import.meta.url,
      )), [
        rawPath,
        "-o",
        instrumentedPath,
      ]);

      const bytes = readFileSync(instrumentedPath);
      const module = new WebAssembly.Module(bytes);
      const memory = new WebAssembly.Memory({ initial: 8, maximum: 1024, shared: true });
      const view = new DataView(memory.buffer);
      let instance: WebAssembly.Instance;
      let moduleBuffer = 0;
      let failGrowth = true;
      let nextAddress = 65_536;
      let nextArenaAddress = 5 * 65_536;
      let abortCommits = 0;
      let successfulCommits = 0;
      let lowMemoryUntouched = false;
      let retiredStorageUntouched = false;
      const allocationSizes: number[] = [];
      const released: Array<{ addr: number; size: number }> = [];

      // WHY: this fixture has no mutable guest globals. In the retired
      // module-wide design, the plain-catch arm and payload occupied these
      // two words after the linked prefix's pointer words. They let the test
      // distinguish a stale-buffer write from merely clearing the buffer
      // global and redirecting the same invalid write to address zero.
      const scratchArmOffset = 8;
      const scratchPayloadOffset = 12;
      const sentinel = 0xa5a5a5a5;
      const fillScratchWords = (base: number): void => {
        view.setUint32(base + scratchArmOffset, sentinel, true);
        view.setUint32(base + scratchPayloadOffset, sentinel, true);
      };
      const scratchWordsAreUntouched = (base: number): boolean =>
        view.getUint32(base + scratchArmOffset, true) === sentinel
        && view.getUint32(base + scratchPayloadOffset, true) === sentinel;

      const continuation = new LinkedForkContinuation(
        memory,
        readLinkedFrameFormat(module),
        (size) => {
          allocationSizes.push(size);
          if (failGrowth && nextAddress !== 65_536) {
            throw new ContinuationAllocationError(12, size, "injected ENOMEM");
          }
          const addr = nextAddress;
          nextAddress += size;
          return addr;
        },
        (addr, size) => released.push({ addr, size }),
        "abort-catch-e2e",
      );
      const runtime = new SingleActivationForkRuntime({
        module,
        moduleBytes: bytes,
        memory,
        continuation,
        newArena: () => new ForkModuleStateArena(
          memory,
          4,
          (size) => {
            const address = nextArenaAddress;
            nextArenaAddress += size;
            const missing = nextArenaAddress - memory.buffer.byteLength;
            if (missing > 0) memory.grow(Math.ceil(missing / 65_536));
            return address;
          },
          () => {},
          "abort-catch-e2e module state",
        ),
        label: "abort-catch-e2e",
      });
      runtime.registry.setCaptureModule(
        installTestForkCaptureModule(memory, "abort-catch-e2e"),
      );
      const coordinatedCommit = runtime.envImports.__wpk_fork_frame_commit as
        (payload: number) => void;

      const imports = {
        env: {
          memory,
          ...runtime.envImports,
          __wpk_fork_frame_commit: (payload: number) => {
            coordinatedCommit(payload);
            if (failGrowth) {
              abortCommits++;
            } else {
              successfulCommits++;
            }
          },
        },
        kernel: {
          kernel_fork: () => {
            const phase = runtime.coordinator.phaseName();
            if (phase === "parent-replay") {
              runtime.coordinator.finishReplay();
              return 17;
            }
            if (phase === "abort-replay") {
              const errno = continuation.abortErrno();
              runtime.coordinator.finishAbortReplay();
              return -errno;
            }

            if (!failGrowth) {
              // Check before beginUnwind legitimately reclaims and initializes
              // the same mapping. All three recursive catches have run by now.
              lowMemoryUntouched = scratchWordsAreUntouched(0);
              retiredStorageUntouched = scratchWordsAreUntouched(moduleBuffer);
            }
            runtime.beginCapture();
            moduleBuffer = runtime.coordinator.rootFor(0);
            return 0;
          },
        },
      };
      instance = new WebAssembly.Instance(module, imports);
      runtime.register(instance);
      const run = instance.exports.run as () => number;
      const state = instance.exports.wpk_fork_state as () => number;

      // The three recursive activations commit distinct payloads (102, 101,
      // 100) into the root chunk. The roughly 72 KiB outer activation then
      // needs a second mapping, where allocation failure is injected.
      const abortResult = run();
      expect(state()).toBe(0);
      expect(continuation.hasActiveContinuation()).toBe(false);
      expect(released).toEqual([{ addr: 65_536, size: 65_536 }]);

      // Once abort replay releases the root, later catch capture must own its
      // state in activation locals rather than either retired storage or low
      // memory. Reuse the same root address for the successful fork so this
      // also covers the real allocator-reuse lifecycle.
      fillScratchWords(0);
      fillScratchWords(moduleBuffer);
      failGrowth = false;
      nextAddress = 65_536;
      runtime.expectCaptureTransport(run);
      expect(state()).toBe(1);
      runtime.coordinator.sealCapture();
      runtime.coordinator.beginParentReplay();
      const successfulResult = run();

      expect({
        abortResult,
        abortCommits,
        allocationSizes,
        lowMemoryUntouched,
        retiredStorageUntouched,
        successfulCommits,
        successfulResult,
      }).toEqual({
        abortResult: 298, // -ENOMEM + 100 + 101 + 102 + the outer guard 7
        abortCommits: 3,
        allocationSizes: [65_536, 131_072, 65_536, 131_072],
        lowMemoryUntouched: true,
        retiredStorageUntouched: true,
        successfulCommits: 4,
        successfulResult: 327, // fork result 17 + payloads + outer guard
      });
      expect(state()).toBe(0);
      expect(continuation.hasActiveContinuation()).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
