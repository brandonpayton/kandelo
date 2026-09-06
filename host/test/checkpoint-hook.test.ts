import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { findRepoRoot, resolveBinary } from "../src/binary-resolver";
import { WPK_FORK_EXPORTS } from "../src/constants";
import { buildKernelImportsForTest } from "../src/worker-main";

describe("checkpoint hook", () => {
  it("makes every freshly-built user program import kernel.kernel_checkpoint", async () => {
    const program = readFileSync(resolveBinary("programs/exec-caller.wasm"));
    const module = await WebAssembly.compile(program as BufferSource);
    const kernelFunctionImports = WebAssembly.Module.imports(module)
      .filter((entry) => entry.module === "kernel" && entry.kind === "function")
      .map((entry) => entry.name);

    expect(kernelFunctionImports).toContain("kernel_checkpoint");
  });

  // Importing the hook is not enough. A program that never forks reaches its
  // unwind only through the checkpoint seed, so a build path naming just the
  // fork boundary leaves it with no instrumentation to unwind with.
  it("instruments every freshly-built user program so it can unwind", async () => {
    const program = readFileSync(resolveBinary("programs/exec-caller.wasm"));
    const module = await WebAssembly.compile(program as BufferSource);
    const exported = new Set(
      WebAssembly.Module.exports(module).map((entry) => entry.name),
    );

    expect(WPK_FORK_EXPORTS.filter((name) => !exported.has(name))).toEqual([]);
  });

  // `host/test/global-setup.ts` is a second fixture build path writing into
  // examples/, so a Vitest run can replace a published artifact with its own.
  // What it writes has to be the same artifact, or a test reads one program
  // and the SDK ships another.
  it("instruments the fixtures the test runner builds for itself", async () => {
    const program = readFileSync(
      join(findRepoRoot(), "examples/test-pthread.wasm"),
    );
    const module = await WebAssembly.compile(program as BufferSource);
    const exported = new Set(
      WebAssembly.Module.exports(module).map((entry) => entry.name),
    );

    expect(WPK_FORK_EXPORTS.filter((name) => !exported.has(name))).toEqual([]);
  });

  it("refuses a checkpoint that arrives before the process can unwind", () => {
    const memory = new WebAssembly.Memory({ initial: 2 });
    const imports = buildKernelImportsForTest(memory, 0, 4);
    const checkpoint = imports.kernel_checkpoint as () => void;

    // The capturing implementation replaces this one once the process
    // instance and its continuation exist, exactly as kernel_fork does.
    expect(() => checkpoint()).toThrow(
      /checkpoint reached before the process continuation exists/,
    );
  });
});
