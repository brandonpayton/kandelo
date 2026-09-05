import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolveBinary } from "../src/binary-resolver";
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

  it("refuses a checkpoint the host cannot capture", () => {
    const memory = new WebAssembly.Memory({ initial: 2 });
    const imports = buildKernelImportsForTest(memory, 0, 4);
    const checkpoint = imports.kernel_checkpoint as () => number;

    expect(() => checkpoint()).toThrow(/checkpoint capture is not implemented/);
  });
});
