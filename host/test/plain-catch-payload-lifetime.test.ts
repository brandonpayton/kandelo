import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  LinkedForkContinuation,
  readLinkedFrameFormat,
} from "../src/fork-continuation";
import {
  ForkModuleStateArena,
  readForkModuleStateRoot,
} from "../src/fork-module-state";
import { SingleActivationForkRuntime } from "./fork-instrument-runtime-harness";

const FIRST_PAYLOAD = 0x1234;
const SECOND_PAYLOAD = 0x5678;
// WHY: this fixture has no pre-existing mutable globals, so the old B1
// implementation places its arm id and one i32 payload immediately after the
// two pointer words in the module prefix. These offsets name the bytes whose
// ownership is under test; the activation-local replacement must not touch
// them before a continuation exists or after that continuation is released.
const SCRATCH_ARM_OFFSET = 8;
const SCRATCH_PAYLOAD_OFFSET = 12;
const SENTINEL = 0xa5a5a5a5;

// SKIP (fork-module kill-switch removal): this suite drives fork capture (and
// a fresh-child reconstruction) in-process through `SingleActivationForkRuntime`
// against a NON-shared-memory instrumented guest fixture. The co-resident fork
// module is now the unconditional capture/reconstruct engine (no JS
// `ForkReferenceTransaction` fallback) and imports a SHARED memory, which cannot
// coexist with this non-shared guest in one memory. Plain/catch_ref payload
// lifetime + reconstruction are covered end-to-end by the shared-memory worker
// e2e suites (catch-ref / exnref fresh-worker). Re-home this in-process unit
// coverage onto a shared-memory guest fixture (or the worker harness) with the
// A5 registry/coordinator relocation.
describe.skip("plain-catch payload lifetime", () => {
  it("keeps capture state activation-owned before the first fork and after release", () => {
    const dir = mkdtempSync(join(tmpdir(), "kandelo-plain-catch-lifetime-"));
    try {
      const watPath = join(dir, "plain-catch-lifetime.wat");
      const rawPath = join(dir, "plain-catch-lifetime.wasm");
      const instrumentedPath = join(dir, "plain-catch-lifetime.instrumented.wasm");
      writeFileSync(watPath, `(module
        (import "kernel" "kernel_fork" (func $fork (result i32)))
        (import "env" "memory" (memory 4))
        (tag $payload (param i32))
        (func (export "run") (param $payload i32) (result i32)
          (local $caught i32)
          (block $handler (result i32)
            (try_table (catch $payload $handler)
              local.get $payload
              throw $payload
              unreachable)
            unreachable)
          local.set $caught
          call $fork
          local.get $caught
          i32.add))`);
      execFileSync("wat2wasm", [
        "--enable-exceptions",
        watPath,
        "-o",
        rawPath,
      ]);
      const instrumenterPath = fileURLToPath(
        new URL("../../tools/bin/wasm-fork-instrument", import.meta.url),
      );
      execFileSync(instrumenterPath, [rawPath, "-o", instrumentedPath]);

      const instrumentedBytes = readFileSync(instrumentedPath);
      const module = new WebAssembly.Module(instrumentedBytes);
      const memory = new WebAssembly.Memory({ initial: 4 });
      const view = new DataView(memory.buffer);
      let instance: WebAssembly.Instance;
      let moduleBuffer = 0;
      let firstCaptureKeptLowMemory = false;
      let secondCaptureKeptLowMemory = false;
      let secondCaptureKeptReleasedMemory = false;
      let normalForkCalls = 0;
      const continuation = new LinkedForkContinuation(
        memory,
        readLinkedFrameFormat(module),
        () => 65_536,
        () => {},
        "plain-catch-lifetime",
      );
      let nextArenaAddress = 2 * 65_536;
      const runtime = new SingleActivationForkRuntime({
        module,
        moduleBytes: instrumentedBytes,
        memory,
        continuation,
        newArena: () => new ForkModuleStateArena(
          memory,
          4,
          (size) => {
            const address = nextArenaAddress;
            nextArenaAddress += size;
            return address;
          },
          () => {},
          "plain-catch-lifetime module state",
        ),
        label: "plain-catch-lifetime",
      });

      const scratchIsSentinel = (base: number): boolean =>
        view.getUint32(base + SCRATCH_ARM_OFFSET, true) === SENTINEL &&
        view.getUint32(base + SCRATCH_PAYLOAD_OFFSET, true) === SENTINEL;
      const fillScratch = (base: number): void => {
        view.setUint32(base + SCRATCH_ARM_OFFSET, SENTINEL, true);
        view.setUint32(base + SCRATCH_PAYLOAD_OFFSET, SENTINEL, true);
      };

      instance = new WebAssembly.Instance(module, {
        env: {
          memory,
          ...runtime.envImports,
        },
        kernel: {
          kernel_fork: () => {
            if (runtime.coordinator.phaseName() === "parent-replay") {
              runtime.coordinator.finishReplay();
              return normalForkCalls === 1 ? 7 : 11;
            }

            normalForkCalls++;
            if (normalForkCalls === 1) {
              firstCaptureKeptLowMemory = scratchIsSentinel(0);
            } else {
              secondCaptureKeptLowMemory = scratchIsSentinel(0);
              secondCaptureKeptReleasedMemory = scratchIsSentinel(moduleBuffer);
            }

            runtime.beginCapture();
            moduleBuffer = runtime.coordinator.rootFor(0);
            return 0;
          },
        },
      });
      runtime.register(instance);

      const run = instance.exports.run as (payload: number) => number;
      fillScratch(0);

      // The first pass transports the private unwind to the worker boundary.
      runtime.expectCaptureTransport(() => run(FIRST_PAYLOAD));
      runtime.coordinator.sealCapture();
      runtime.coordinator.beginParentReplay();
      expect(run(FIRST_PAYLOAD)).toBe(FIRST_PAYLOAD + 7);

      // Once replay releases the continuation, its former bytes are no longer
      // storage owned by fork instrumentation. A later plain catch must not
      // mutate either that retired mapping or low memory before its fork call.
      fillScratch(0);
      fillScratch(moduleBuffer);
      runtime.expectCaptureTransport(() => run(SECOND_PAYLOAD));
      runtime.coordinator.sealCapture();
      runtime.coordinator.beginParentReplay();
      expect(run(SECOND_PAYLOAD)).toBe(SECOND_PAYLOAD + 11);

      expect({
        firstCaptureKeptLowMemory,
        secondCaptureKeptLowMemory,
        secondCaptureKeptReleasedMemory,
      }).toEqual({
        firstCaptureKeptLowMemory: true,
        secondCaptureKeptLowMemory: true,
        secondCaptureKeptReleasedMemory: true,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("preserves each recursive activation's caught payload", () => {
    const dir = mkdtempSync(join(tmpdir(), "kandelo-plain-catch-recursion-"));
    try {
      const watPath = join(dir, "plain-catch-recursion.wat");
      const rawPath = join(dir, "plain-catch-recursion.wasm");
      const instrumentedPath = join(
        dir,
        "plain-catch-recursion.instrumented.wasm",
      );
      writeFileSync(watPath, `(module
        (import "kernel" "kernel_fork" (func $fork (result i32)))
        (import "env" "memory" (memory 4))
        (tag $payload (param i32))
        (func $recurse (export "run") (param $depth i32) (result i32)
          (local $caught i32)
          (local $child_result i32)
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
          local.set $child_result
          i32.const 4096
          local.get $depth
          i32.const 2
          i32.shl
          i32.add
          local.get $caught
          i32.store
          local.get $child_result
          local.get $caught
          i32.add))`);
      execFileSync("wat2wasm", [
        "--enable-exceptions",
        watPath,
        "-o",
        rawPath,
      ]);
      const instrumenterPath = fileURLToPath(
        new URL("../../tools/bin/wasm-fork-instrument", import.meta.url),
      );
      execFileSync(instrumenterPath, [rawPath, "-o", instrumentedPath]);

      const instrumentedBytes = readFileSync(instrumentedPath);
      const module = new WebAssembly.Module(instrumentedBytes);
      const memory = new WebAssembly.Memory({ initial: 4 });
      const view = new DataView(memory.buffer);
      let instance: WebAssembly.Instance;
      let normalForkCalls = 0;
      let recursiveCaptureKeptLowMemory = false;
      const continuation = new LinkedForkContinuation(
        memory,
        readLinkedFrameFormat(module),
        () => 65_536,
        () => {},
        "plain-catch-recursion",
      );
      const runtime = new SingleActivationForkRuntime({
        module,
        moduleBytes: instrumentedBytes,
        memory,
        continuation,
        newArena: () => new ForkModuleStateArena(
          memory,
          4,
          () => 2 * 65_536,
          () => {},
          "plain-catch-recursion module state",
        ),
        label: "plain-catch-recursion",
      });

      instance = new WebAssembly.Instance(module, {
        env: {
          memory,
          ...runtime.envImports,
        },
        kernel: {
          kernel_fork: () => {
            if (runtime.coordinator.phaseName() === "parent-replay") {
              runtime.coordinator.finishReplay();
              return 7;
            }
            normalForkCalls++;
            recursiveCaptureKeptLowMemory =
              view.getUint32(SCRATCH_ARM_OFFSET, true) === SENTINEL &&
              view.getUint32(SCRATCH_PAYLOAD_OFFSET, true) === SENTINEL;
            runtime.beginCapture();
            return 0;
          },
        },
      });
      runtime.register(instance);

      const run = instance.exports.run as (depth: number) => number;
      view.setUint32(SCRATCH_ARM_OFFSET, SENTINEL, true);
      view.setUint32(SCRATCH_PAYLOAD_OFFSET, SENTINEL, true);
      runtime.expectCaptureTransport(() => run(2));
      runtime.coordinator.sealCapture();
      runtime.coordinator.beginParentReplay();

      // WHY: all three calls execute the same static catch arm, but each
      // activation owns a distinct payload (102, 101, 100). The result slots
      // prove each restored activation retained its own value; the sentinel
      // proves capture did not borrow low memory before the continuation
      // existed. A module-wide tuple violates that ownership boundary even if
      // other frame locals happen to preserve the final arithmetic result.
      expect(run(2)).toBe(7 + 100 + 101 + 102);
      expect([
        view.getUint32(4096, true),
        view.getUint32(4100, true),
        view.getUint32(4104, true),
      ]).toEqual([100, 101, 102]);
      expect({
        normalForkCalls,
        recursiveCaptureKeptLowMemory,
      }).toEqual({
        normalForkCalls: 1,
        recursiveCaptureKeptLowMemory: true,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reconstructs mixed plain and catch_ref state in a fresh child instance", () => {
    const dir = mkdtempSync(join(tmpdir(), "kandelo-mixed-catch-lifetime-"));
    try {
      const watPath = join(dir, "mixed-catch-lifetime.wat");
      const rawPath = join(dir, "mixed-catch-lifetime.wasm");
      const instrumentedPath = join(dir, "mixed-catch-lifetime.instrumented.wasm");
      writeFileSync(watPath, `(module
        (import "kernel" "kernel_fork" (func $fork (result i32)))
        (import "env" "memory" (memory 4))
        (tag $plain (param i32))
        (tag $with_ref (param i32))
        (func (export "run") (param $take_plain i32) (result i32)
          (local $caught i32)
          (block $done (result i32)
            (block $plain_handler (result i32)
              (block $ref_handler (result i32 exnref)
                (try_table (result i32 exnref)
                    (catch $plain $plain_handler)
                    (catch_ref $with_ref $ref_handler)
                  local.get $take_plain
                  if
                    i32.const 41
                    throw $plain
                  else
                    i32.const 42
                    throw $with_ref
                  end
                  unreachable))
              drop
              local.set $caught
              call $fork
              local.get $caught
              i32.add
              br $done)
            local.set $caught
            call $fork
            local.get $caught
            i32.add
            br $done)))`);
      execFileSync("wat2wasm", [
        "--enable-exceptions",
        watPath,
        "-o",
        rawPath,
      ]);
      const instrumenterPath = fileURLToPath(
        new URL("../../tools/bin/wasm-fork-instrument", import.meta.url),
      );
      execFileSync(instrumenterPath, [rawPath, "-o", instrumentedPath]);
      const instrumentedBytes = readFileSync(instrumentedPath);
      const module = new WebAssembly.Module(instrumentedBytes);

      const runOrder = (modes: readonly number[]): void => {
        const parentMemory = new WebAssembly.Memory({ initial: 4 });
        let parentInstance: WebAssembly.Instance;
        let moduleBuffer = 0;
        let nextParentArenaAddress = 2 * 65_536;
        const parentContinuation = new LinkedForkContinuation(
          parentMemory,
          readLinkedFrameFormat(module),
          () => 65_536,
          () => {},
          "mixed-catch-parent",
        );
        const parentRuntime = new SingleActivationForkRuntime({
          module,
          moduleBytes: instrumentedBytes,
          memory: parentMemory,
          continuation: parentContinuation,
          newArena: () => new ForkModuleStateArena(
            parentMemory,
            4,
            (size) => {
              const address = nextParentArenaAddress;
              nextParentArenaAddress += size;
              return address;
            },
            () => {},
            "mixed-catch-parent module state",
          ),
          label: "mixed-catch-parent",
        });
        parentInstance = new WebAssembly.Instance(module, {
          env: {
            memory: parentMemory,
            ...parentRuntime.envImports,
          },
          kernel: {
            kernel_fork: () => {
              parentRuntime.beginCapture();
              moduleBuffer = parentRuntime.coordinator.rootFor(0);
              return 0;
            },
          },
        });
        parentRuntime.register(parentInstance);
        const parentRun = parentInstance.exports.run as (takePlain: number) => number;

        for (const mode of modes) {
          parentRuntime.expectCaptureTransport(() => parentRun(mode));
          parentRuntime.coordinator.sealCapture();

          // Model the actual worker boundary: the child receives only copied
          // linear memory and instantiates an otherwise fresh Wasm module.
          const childMemory = new WebAssembly.Memory({
            initial: parentMemory.buffer.byteLength / 65_536,
          });
          new Uint8Array(childMemory.buffer).set(
            new Uint8Array(parentMemory.buffer),
          );

          const childContinuation = new LinkedForkContinuation(
            childMemory,
            readLinkedFrameFormat(module),
            () => {
              throw new Error("fresh child replay must not allocate a continuation");
            },
            () => {},
            "mixed-catch-child",
          );
          const childRuntime = new SingleActivationForkRuntime({
            module,
            moduleBytes: instrumentedBytes,
            memory: childMemory,
            continuation: childContinuation,
            newArena: () => {
              throw new Error(
                "fresh child replay must attach copied module state",
              );
            },
            label: "mixed-catch-child",
          });
          let childInstance: WebAssembly.Instance;
          childInstance = new WebAssembly.Instance(module, {
            env: {
              memory: childMemory,
              ...childRuntime.envImports,
            },
            kernel: {
              kernel_fork: () => {
                expect(childRuntime.coordinator.phaseName()).toBe(
                  "child-replay",
                );
                childRuntime.coordinator.finishReplay();
                return 7;
              },
            },
          });
          childRuntime.register(childInstance, { bootstrap: false });
          childRuntime.setCopiedProcessLaunchRoot(moduleBuffer);
          const copiedArena = new ForkModuleStateArena(
            childMemory,
            4,
            () => {
              throw new Error(
                "fresh child replay must not allocate module-state storage",
              );
            },
            () => {},
            "mixed-catch-child module state",
          );
          copiedArena.attach(
            readForkModuleStateRoot(childMemory, moduleBuffer, 4),
          );
          childRuntime.coordinator.attachChild(copiedArena);
          const childRun = childInstance.exports.run as (takePlain: number) => number;
          expect(childRun(mode)).toBe((mode ? 41 : 42) + 7);
          parentRuntime.coordinator.abort();
        }
      };

      // Both arm orders exercise one long-lived parent instance, while every
      // child has empty module globals/tables. CatchRef can pass only if rewind
      // restores the scalar tag payload and rethrows the tag to create a new
      // instance-local exnref.
      runOrder([0, 1]);
      runOrder([1, 0]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
