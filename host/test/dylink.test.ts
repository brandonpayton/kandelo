/**
 * Tests for WebAssembly dynamic linking support (dylink.0 parsing + loading).
 */

import { describe, it, expect } from "vitest";
import {
  createCppExceptionTag,
  createLongjmpTag,
  parseDylinkSection,
  loadSharedLibrary,
  loadSharedLibrarySync,
  DynamicLinker,
  FORK_CAP_ACTIVATION_STATE_SAFE,
  FORK_CAP_DYLINK_MAIN,
  FORK_CAP_SIDE_ENTRY,
  FORK_CAPABILITIES_SECTION,
  FORK_CAPABILITIES_VERSION,
  forkInstrumentRoleAvailable,
  readForkInstrumentCapabilityClaim,
  readForkInstrumentCapabilities,
  SIDE_MODULE_FORK_EXPORTS,
  type DylinkForkActivationOwner,
  type DylinkForkActivationRequest,
  type LoadSharedLibraryOptions,
} from "../src/dylink.ts";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { LINKED_FRAME_FORMAT_SECTION } from "../src/fork-continuation";
import { ABI_VERSION } from "../src/generated/abi";
import { ForkAnyrefTransitTable } from "../src/fork-anyref-transit";
import {
  createForkUnwindTag,
  FORK_UNWIND_TAG_IMPORT_NAME,
} from "../src/fork-unwind-transport";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
const forkInstrument = join(repoRoot, "scripts", "run-wasm-fork-instrument.sh");

function hasCompiler(compiler = "wasm32posix-cc"): boolean {
  try {
    execFileSync(compiler, ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** Build a shared Wasm library from C source. */
function buildSharedLib(
  source: string,
  name: string,
  compiler = "wasm32posix-cc",
): Uint8Array {
  const dir = join(tmpdir(), "wasm-dylink-test");
  mkdirSync(dir, { recursive: true });
  const srcPath = join(dir, `${name}.c`);
  const soPath = join(dir, `${name}.so`);
  writeFileSync(srcPath, source);
  execFileSync(compiler,
    ["-shared", "-fPIC", "-O2", srcPath, "-o", soPath],
    { stdio: "pipe" });
  return new Uint8Array(readFileSync(soPath));
}

/** Compile a tiny side module and prepend the required first dylink.0 section. */
function appendCustomSection(module: Uint8Array, name: string, data: Uint8Array): Uint8Array {
  const nameBytes = new TextEncoder().encode(name);
  const payloadSize = 1 + nameBytes.length + data.length;
  if (nameBytes.length >= 128 || payloadSize >= 128) {
    throw new Error("test custom section helper only supports one-byte LEB lengths");
  }
  const section = new Uint8Array(2 + payloadSize);
  section[0] = 0;
  section[1] = payloadSize;
  section[2] = nameBytes.length;
  section.set(nameBytes, 3);
  section.set(data, 3 + nameBytes.length);
  const out = new Uint8Array(module.length + section.length);
  out.set(module);
  out.set(section, module.length);
  return out;
}

function buildDylinkWat(
  wat: string,
  name: string,
  forkCapabilities?: number,
  tableSize = 0,
  memorySize = 0,
  wat2wasmFlags: string[] = [],
  tlsExports: string[] = [],
  abiVersion: number | null = ABI_VERSION,
  neededDynlibs: string[] = [],
): Uint8Array {
  const dir = join(tmpdir(), "wasm-dylink-wat-test");
  mkdirSync(dir, { recursive: true });
  const watPath = join(dir, `${name}.wat`);
  const wasmPath = join(dir, `${name}.wasm`);
  let linkedWat = forkCapabilities !== undefined
      && (forkCapabilities & FORK_CAP_SIDE_ENTRY) !== 0
    ? wat.replace("(module", `(module
          (import "env" "__wpk_fork_frame_reserve" (func (param i32) (result i32)))
          (import "env" "__wpk_fork_frame_commit" (func (param i32)))
          (import "env" "__wpk_fork_frame_next" (func (param i32) (result i32)))`)
    : wat;
  if (forkCapabilities !== undefined && abiVersion !== null) {
    const moduleEnd = linkedWat.lastIndexOf(")");
    if (moduleEnd < 0) throw new Error("test WAT has no module terminator");
    linkedWat = `${linkedWat.slice(0, moduleEnd)}
          (func (export "__abi_version") (result i32) i32.const ${abiVersion})
        ${linkedWat.slice(moduleEnd)}`;
  }
  writeFileSync(watPath, linkedWat);
  execFileSync("wat2wasm", ["--enable-threads", ...wat2wasmFlags, watPath, "-o", wasmPath], {
    stdio: "pipe",
  });
  const module = new Uint8Array(readFileSync(wasmPath));
  const dylinkName = new TextEncoder().encode("dylink.0");
  // Memory-info subsection: size, align=0, table size, table align=0.
  // Optional export-info entries pin TLS-relative relocation behavior.
  const exportInfoBody = tlsExports.flatMap((exportName) => {
    const bytes = [...new TextEncoder().encode(exportName)];
    if (bytes.length >= 128) throw new Error("test TLS export name is too long");
    return [bytes.length, ...bytes, 1]; // WASM_DYLINK_FLAG_TLS
  });
  const exportInfo = tlsExports.length > 0
    ? [3, 1 + exportInfoBody.length, tlsExports.length, ...exportInfoBody]
    : [];
  const neededBody = neededDynlibs.flatMap((libraryName) => {
    const bytes = [...new TextEncoder().encode(libraryName)];
    if (bytes.length >= 128) throw new Error("test dependency name is too long");
    return [bytes.length, ...bytes];
  });
  const neededInfo = neededDynlibs.length > 0
    ? [2, 1 + neededBody.length, neededDynlibs.length, ...neededBody]
    : [];
  const payload = new Uint8Array(
    1 + dylinkName.length + 6 + neededInfo.length + exportInfo.length,
  );
  if (payload.length >= 128) {
    throw new Error("test dylink section helper only supports one-byte LEB lengths");
  }
  payload[0] = dylinkName.length;
  payload.set(dylinkName, 1);
  payload.set([1, 4, memorySize, 0, tableSize, 0], 1 + dylinkName.length);
  payload.set(neededInfo, 1 + dylinkName.length + 6);
  payload.set(exportInfo, 1 + dylinkName.length + 6 + neededInfo.length);
  const section = new Uint8Array(2 + payload.length);
  section[0] = 0;
  section[1] = payload.length;
  section.set(payload, 2);
  const out = new Uint8Array(module.length + section.length);
  out.set(module.subarray(0, 8), 0);
  out.set(section, 8);
  out.set(module.subarray(8), 8 + section.length);
  if (forkCapabilities === undefined) return out;
  let marked = appendCustomSection(
        out,
        FORK_CAPABILITIES_SECTION,
        new Uint8Array([
          FORK_CAPABILITIES_VERSION,
          forkCapabilities | FORK_CAP_ACTIVATION_STATE_SAFE,
        ]),
      );
  if ((forkCapabilities & FORK_CAP_SIDE_ENTRY) !== 0) {
    marked = appendCustomSection(
      marked,
      LINKED_FRAME_FORMAT_SECTION,
      new Uint8Array([
        0x4b, 0x4c, 0x43, 0x46,
        1, 0, 24, 0, 4, 8, 3, 0,
        32, 0, 0, 0,
        24, 0, 0, 0,
        8, 0, 0, 0,
      ]),
    );
  }
  return marked;
}

/** Build a real ABI-43 side artifact instead of hand-maintaining its contract. */
function buildInstrumentedDylinkWat(
  wat: string,
  name: string,
  neededDynlibs: string[] = [],
): Uint8Array {
  const dir = join(tmpdir(), "wasm-dylink-instrumented-test");
  mkdirSync(dir, { recursive: true });
  const inputPath = join(dir, `${name}.input.wasm`);
  const outputPath = join(dir, `${name}.instrumented.wasm`);
  const moduleEnd = wat.lastIndexOf(")");
  if (moduleEnd < 0) throw new Error("instrumented test WAT has no module terminator");
  const versionedWat = `${wat.slice(0, moduleEnd)}
    (func (export "__abi_version") (result i32) i32.const ${ABI_VERSION})
  ${wat.slice(moduleEnd)}`;
  writeFileSync(
    inputPath,
    buildDylinkWat(
      versionedWat,
      `${name}-raw`,
      undefined,
      0,
      0,
      [],
      [],
      null,
      neededDynlibs,
    ),
  );
  execFileSync(
    "bash",
    [forkInstrument, inputPath, "-o", outputPath, "--entry", "env.fork"],
    { cwd: repoRoot, stdio: "pipe" },
  );
  return new Uint8Array(readFileSync(outputPath));
}

interface TestForkActivationOwner {
  readonly owner: DylinkForkActivationOwner;
  readonly prepares: DylinkForkActivationRequest[];
  readonly registered: Array<{ activationId: number; instance: WebAssembly.Instance }>;
  readonly unregistered: number[];
  readonly active: ReadonlySet<number>;
  readonly forkImport: () => number;
  readonly wrappedImports: WebAssembly.Imports[];
}

/**
 * Minimal process owner for loader contract tests.
 *
 * The real worker binds state arenas and typed codecs. These fixtures never
 * execute a continuation, so inert functions are sufficient; tables and the
 * private exception tag still use their exact WebAssembly types.
 */
function createTestForkActivationOwner(
  firstActivationId = 1,
): TestForkActivationOwner {
  const prepares: DylinkForkActivationRequest[] = [];
  const registered: Array<{
    activationId: number;
    instance: WebAssembly.Instance;
  }> = [];
  const unregistered: number[] = [];
  const wrappedImports: WebAssembly.Imports[] = [];
  const active = new Set<number>();
  const gcTransit = new ForkAnyrefTransitTable();
  const resumeTable = new WebAssembly.Table({ initial: 1, element: "anyfunc" });
  const unwindTag = createForkUnwindTag();
  const forkImport = () => -12;
  let nextActivationId = firstActivationId;

  const owner: DylinkForkActivationOwner = {
    prepare(request) {
      const activationId = request.replayActivationId ?? nextActivationId++;
      prepares.push(request);
      if (active.has(activationId)) {
        throw new Error(`duplicate test activation id ${activationId}`);
      }
      active.add(activationId);

      const env: Record<string, WebAssembly.ImportValue> = {};
      for (const imported of WebAssembly.Module.imports(request.module)) {
        if (imported.module !== "env") continue;
        if (imported.name === "fork") {
          env[imported.name] = forkImport;
        } else if (imported.name === "__wpk_fork_ref_gc_transit") {
          env[imported.name] = gcTransit.table;
        } else if (imported.name === "__wpk_fork_resume_table") {
          env[imported.name] = resumeTable;
        } else if (
          imported.name === FORK_UNWIND_TAG_IMPORT_NAME
          && (imported.kind as string) === "tag"
        ) {
          env[imported.name] =
            unwindTag as unknown as WebAssembly.ImportValue;
        } else if (
          imported.name.startsWith("__wpk_fork_")
          && imported.kind === "function"
        ) {
          env[imported.name] = () => 0;
        } else if (
          imported.name.startsWith("__wpk_fork_")
          && imported.kind === "global"
        ) {
          env[imported.name] =
            imported.name === "__wpk_fork_module_state_table_generation_addr"
              ? new WebAssembly.Global(
                  { value: "i64", mutable: false },
                  0n,
                )
              : new WebAssembly.Global(
                  { value: "i32", mutable: false },
                  activationId,
                );
        }
      }

      let released = false;
      return {
        activationId,
        env,
        savedMutableGlobalImport: () => undefined,
        wrapImports(imports) {
          wrappedImports.push(imports);
          return imports;
        },
        register(instance) {
          registered.push({ activationId, instance });
        },
        unregister() {
          if (released) throw new Error(`test activation ${activationId} released twice`);
          released = true;
          active.delete(activationId);
          unregistered.push(activationId);
        },
      };
    },
  };

  return {
    owner,
    prepares,
    registered,
    unregistered,
    active,
    forkImport,
    wrappedImports,
  };
}

describe.skipIf(typeof WebAssembly.Tag !== "function")("longjmp tag identity", () => {
  const cases = [
    { ptrWidth: 4 as const, wasmType: "i32", value: 37 },
    { ptrWidth: 8 as const, wasmType: "i64", value: 37n },
  ];

  it.each(cases)(
    "shares one process-owned $wasmType tag with a side module",
    ({ ptrWidth, wasmType, value }) => {
      const wasmBytes = buildDylinkWat(`
        (module
          (import "env" "memory" (memory 1 100 shared))
          (tag $longjmp (import "env" "__c_longjmp") (param ${wasmType}))
          (func (export "throw_longjmp") (param $value ${wasmType})
            local.get $value
            throw $longjmp))
      `, `longjmp-${wasmType}`, undefined, 0, 0, ["--enable-exceptions"]);
      const options = createSideForkLoadOptions();
      const longjmpTag = createLongjmpTag(ptrWidth)!;
      options.ptrWidth = ptrWidth;
      options.longjmpTag = longjmpTag;
      // A same-named main export is not authoritative for this reserved tag.
      options.globalSymbols.set("__c_longjmp", () => 0);

      const lib = loadSharedLibrarySync(`liblongjmp-${wasmType}.so`, wasmBytes, options);
      const throwLongjmp = lib.exports.throw_longjmp as (arg: number | bigint) => void;
      let caught: unknown;
      try {
        throwLongjmp(value);
      } catch (error) {
        caught = error;
      }

      const WasmException = (WebAssembly as typeof WebAssembly & {
        Exception: new (...args: unknown[]) => Error;
      }).Exception;
      expect(caught).toBeInstanceOf(WasmException);
      const exception = caught as Error & {
        is: (tag: WebAssembly.Tag) => boolean;
        getArg: (tag: WebAssembly.Tag, index: number) => unknown;
      };
      expect(exception.is(longjmpTag)).toBe(true);
      expect(exception.getArg(longjmpTag, 0)).toBe(value);
    },
  );

  it.each(cases)(
    "creates one pointer-width-aware $wasmType fallback for standalone linkers",
    ({ ptrWidth, wasmType, value }) => {
      const wasmBytes = buildDylinkWat(`
        (module
          (import "env" "memory" (memory 1 100 shared))
          (tag $longjmp (import "env" "__c_longjmp") (param ${wasmType}))
          (func (export "throw_longjmp") (param $value ${wasmType})
            local.get $value
            throw $longjmp))
      `, `fallback-longjmp-${wasmType}`, undefined, 0, 0, ["--enable-exceptions"]);
      const options = createSideForkLoadOptions();
      options.ptrWidth = ptrWidth;

      const first = loadSharedLibrarySync(`libfallback-${wasmType}-one.so`, wasmBytes, options);
      const fallbackTag = options.longjmpTag!;
      expect(fallbackTag).toBeInstanceOf(WebAssembly.Tag);
      const second = loadSharedLibrarySync(`libfallback-${wasmType}-two.so`, wasmBytes, options);
      expect(options.longjmpTag).toBe(fallbackTag);

      for (const lib of [first, second]) {
        let caught: unknown;
        try {
          (lib.exports.throw_longjmp as (arg: number | bigint) => void)(value);
        } catch (error) {
          caught = error;
        }
        const exception = caught as {
          is: (tag: WebAssembly.Tag) => boolean;
          getArg: (tag: WebAssembly.Tag, index: number) => unknown;
        };
        expect(exception.is(fallbackTag)).toBe(true);
        expect(exception.getArg(fallbackTag, 0)).toBe(value);
      }
    },
  );

  it("rejects a lookalike tag before side-module instantiation", () => {
    const wasmBytes = buildDylinkWat(`
      (module
        (import "env" "memory" (memory 1 100 shared))
        (tag $longjmp (import "env" "__c_longjmp") (param i32)))
    `, "invalid-longjmp-tag", undefined, 0, 0, ["--enable-exceptions"]);
    const options = createSideForkLoadOptions();
    options.longjmpTag = {} as WebAssembly.Tag;

    expect(() => loadSharedLibrarySync("libinvalid-longjmp.so", wasmBytes, options))
      .toThrow(/__c_longjmp must be an actual WebAssembly\.Tag/);
  });
});

describe.skipIf(typeof WebAssembly.Tag !== "function")("C++ exception tag identity", () => {
  const cases = [
    { ptrWidth: 4 as const, wasmType: "i32", value: 42 },
    { ptrWidth: 8 as const, wasmType: "i64", value: 42n },
  ];

  it.each(cases)(
    "shares one process-owned $wasmType tag across throwing and catching side modules",
    ({ ptrWidth, wasmType, value }) => {
      const throwerBytes = buildDylinkWat(`
        (module
          (import "env" "memory" (memory 1 100 shared))
          (tag $cpp (import "env" "__cpp_exception") (param ${wasmType}))
          (func (export "throw_cpp") (param $value ${wasmType})
            local.get $value
            throw $cpp))
      `, `cpp-thrower-${wasmType}`, undefined, 0, 0, ["--enable-exceptions"]);
      const catcherBytes = buildDylinkWat(`
        (module
          (import "env" "memory" (memory 1 100 shared))
          (import "env" "throw_cpp" (func $throw_cpp (param ${wasmType})))
          (tag $cpp (import "env" "__cpp_exception") (param ${wasmType}))
          (func (export "catch_cpp") (param $value ${wasmType}) (result ${wasmType})
            (try (result ${wasmType})
              (do
                local.get $value
                call $throw_cpp
                unreachable)
              (catch $cpp))))
      `, `cpp-catcher-${wasmType}`, undefined, 0, 0, ["--enable-exceptions"]);
      const options = createSideForkLoadOptions();
      options.ptrWidth = ptrWidth;
      options.cppExceptionTag = createCppExceptionTag(ptrWidth)!;

      loadSharedLibrarySync(`libcpp-thrower-${wasmType}.so`, throwerBytes, options);
      const processTag = options.cppExceptionTag;
      const catcher = loadSharedLibrarySync(
        `libcpp-catcher-${wasmType}.so`,
        catcherBytes,
        options,
      );

      expect(options.cppExceptionTag).toBe(processTag);
      expect((catcher.exports.catch_cpp as Function)(value)).toBe(value);
    },
  );

  it("rejects a lookalike process C++ tag before instantiation", () => {
    const wasmBytes = buildDylinkWat(`
      (module
        (import "env" "memory" (memory 1 100 shared))
        (tag $cpp (import "env" "__cpp_exception") (param i32)))
    `, "invalid-cpp-tag", undefined, 0, 0, ["--enable-exceptions"]);
    const options = createSideForkLoadOptions();
    options.cppExceptionTag = {} as WebAssembly.Tag;

    expect(() => loadSharedLibrarySync("libinvalid-cpp-tag.so", wasmBytes, options))
      .toThrow(/__cpp_exception must be an actual WebAssembly\.Tag/);
  });
});

describe.skipIf(!hasCompiler())("dylink.0 parser", () => {
  it("parses a simple shared library", () => {
    const wasmBytes = buildSharedLib(
      `int add(int a, int b) { return a + b; }`,
      "simple",
    );
    const metadata = parseDylinkSection(wasmBytes);
    expect(metadata).not.toBeNull();
    expect(metadata!.memorySize).toBe(0); // No static data
    expect(metadata!.tableSize).toBe(0);  // No indirect calls
    expect(metadata!.neededDynlibs).toEqual([]);
  });

  it("parses a library with static data", () => {
    const wasmBytes = buildSharedLib(
      `
      static int counter = 42;
      int get_counter(void) { return counter; }
      void inc_counter(void) { counter++; }
      `,
      "with-data",
    );
    const metadata = parseDylinkSection(wasmBytes);
    expect(metadata).not.toBeNull();
    expect(metadata!.memorySize).toBeGreaterThan(0); // Has static data
  });

  it("returns null for non-shared-library Wasm", () => {
    // A minimal valid Wasm module (magic + version + empty)
    const normalWasm = new Uint8Array([
      0x00, 0x61, 0x73, 0x6d, // magic
      0x01, 0x00, 0x00, 0x00, // version
      0x01, 0x04, 0x01, 0x60, 0x00, 0x00, // type section
    ]);
    const metadata = parseDylinkSection(normalWasm);
    expect(metadata).toBeNull();
  });

  it("returns null for non-Wasm data", () => {
    expect(parseDylinkSection(new Uint8Array([1, 2, 3]))).toBeNull();
  });
});

describe.skipIf(!hasCompiler())("shared library loading", () => {
  function createLoadOptions(): LoadSharedLibraryOptions {
    const memory = new WebAssembly.Memory({ initial: 1, maximum: 100, shared: true });
    const table = new WebAssembly.Table({ initial: 1, element: "anyfunc" });
    const stackPointer = new WebAssembly.Global(
      { value: "i32", mutable: true },
      65536, // Stack at end of first page
    );
    return {
      memory,
      table,
      stackPointer,
      heapPointer: { value: 1024 }, // Start heap at 1KB
      globalSymbols: new Map(),
      got: new Map(),
      loadedLibraries: new Map(),
    };
  }

  it("loads a simple shared library and calls exported functions", async () => {
    const wasmBytes = buildSharedLib(
      `
      int add(int a, int b) { return a + b; }
      int multiply(int a, int b) { return a * b; }
      `,
      "math",
    );

    const options = createLoadOptions();
    const lib = await loadSharedLibrary("libmath.so", wasmBytes, options);

    expect(lib.name).toBe("libmath.so");
    expect(lib.exports.add).toBeTypeOf("function");
    expect(lib.exports.multiply).toBeTypeOf("function");

    const add = lib.exports.add as Function;
    const multiply = lib.exports.multiply as Function;
    expect(add(3, 4)).toBe(7);
    expect(multiply(5, 6)).toBe(30);
  });

  it("loads a library with mutable static data", async () => {
    const wasmBytes = buildSharedLib(
      `
      static int counter = 10;
      int get_counter(void) { return counter; }
      void inc_counter(void) { counter++; }
      `,
      "counter",
    );

    const options = createLoadOptions();
    const lib = await loadSharedLibrary("libcounter.so", wasmBytes, options);

    const get = lib.exports.get_counter as Function;
    const inc = lib.exports.inc_counter as Function;

    expect(get()).toBe(10);
    inc();
    expect(get()).toBe(11);
    inc();
    inc();
    expect(get()).toBe(13);
  });

  it("deduplicates already-loaded libraries", async () => {
    const wasmBytes = buildSharedLib(
      `int foo(void) { return 42; }`,
      "dedup",
    );

    const options = createLoadOptions();
    const lib1 = await loadSharedLibrary("libdedup.so", wasmBytes, options);
    const lib2 = await loadSharedLibrary("libdedup.so", wasmBytes, options);

    expect(lib1).toBe(lib2); // Same object reference
  });

  it("allocates separate memory regions for multiple libraries", async () => {
    const lib1Bytes = buildSharedLib(
      `static int data1[256] = {1}; int get1(void) { return data1[0]; }`,
      "region1",
    );
    const lib2Bytes = buildSharedLib(
      `static int data2[256] = {2}; int get2(void) { return data2[0]; }`,
      "region2",
    );

    const options = createLoadOptions();
    const lib1 = await loadSharedLibrary("lib1.so", lib1Bytes, options);
    const lib2 = await loadSharedLibrary("lib2.so", lib2Bytes, options);

    // Memory regions should not overlap
    const end1 = lib1.memoryBase + lib1.metadata.memorySize;
    expect(lib2.memoryBase).toBeGreaterThanOrEqual(end1);

    // Both should work independently
    expect((lib1.exports.get1 as Function)()).toBe(1);
    expect((lib2.exports.get2 as Function)()).toBe(2);
  });

  it("handles function pointers (indirect calls through the table)", async () => {
    // Use a function pointer array to force table entries (prevents inlining)
    const wasmBytes = buildSharedLib(
      `
      typedef int (*op_fn)(int, int);
      static int add(int a, int b) { return a + b; }
      static int sub(int a, int b) { return a - b; }
      static op_fn ops[] = {add, sub};
      int apply(int which, int a, int b) { return ops[which](a, b); }
      `,
      "funcptr",
    );

    const metadata = parseDylinkSection(wasmBytes);
    expect(metadata).not.toBeNull();
    expect(metadata!.tableSize).toBeGreaterThan(0); // Function pointer array needs table slots

    const options = createLoadOptions();
    const lib = await loadSharedLibrary("libfuncptr.so", wasmBytes, options);

    const apply = lib.exports.apply as Function;
    expect(apply(0, 10, 3)).toBe(13); // add
    expect(apply(1, 10, 3)).toBe(7);  // sub
  });

  it("resolves cross-library symbols through globalSymbols", async () => {
    // First library provides a function
    const providerBytes = buildSharedLib(
      `int provided_value(void) { return 42; }`,
      "provider",
    );

    // Second library imports and uses it via extern declaration.
    const consumerBytes = buildSharedLib(
      `
      extern int provided_value(void);
      int doubled_value(void) { return provided_value() * 2; }
      `,
      "consumer",
    );

    const options = createLoadOptions();

    // Load provider first — its exports get registered in globalSymbols
    const provider = await loadSharedLibrary("libprovider.so", providerBytes, options);
    expect((provider.exports.provided_value as Function)()).toBe(42);

    // Load consumer — should resolve provided_value from globalSymbols
    const consumer = await loadSharedLibrary("libconsumer.so", consumerBytes, options);
    expect((consumer.exports.doubled_value as Function)()).toBe(84);
  });
});

function hasMemory64Runtime(): boolean {
  try {
    new WebAssembly.Memory({
      initial: 1n,
      maximum: 2n,
      shared: true,
      address: "i64",
    } as unknown as WebAssembly.MemoryDescriptor);
    new WebAssembly.Table({
      initial: 1n,
      element: "anyfunc",
      address: "i64",
    } as unknown as WebAssembly.TableDescriptor);
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(!hasCompiler("wasm64posix-cc") || !hasMemory64Runtime())(
  "memory64 shared library loading",
  () => {
    function createLoadOptions(): LoadSharedLibraryOptions {
      const memory = new WebAssembly.Memory({
        initial: 1n,
        maximum: 100n,
        shared: true,
        address: "i64",
      } as unknown as WebAssembly.MemoryDescriptor);
      const table = new WebAssembly.Table({
        initial: 1n,
        element: "anyfunc",
        address: "i64",
      } as unknown as WebAssembly.TableDescriptor);
      return {
        memory,
        table,
        stackPointer: new WebAssembly.Global(
          { value: "i64", mutable: true },
          65536n,
        ),
        // Force the standalone-linker fallback across a memory64 page boundary.
        heapPointer: { value: 65535 },
        globalSymbols: new Map(),
        got: new Map(),
        loadedLibraries: new Map(),
        ptrWidth: 8,
      };
    }

    it("uses i64 bases, GOT entries, table indices, and memory growth", () => {
      const providerBytes = buildSharedLib(
        `
        long external_data = 41;
        long external_function(long value) { return value + 1; }
        `,
        "memory64-provider",
        "wasm64posix-cc",
      );
      const consumerBytes = buildSharedLib(
        `
        extern long external_data;
        extern long external_function(long value);

        static long increment(long value) { return value + 1; }
        static long double_value(long value) { return value * 2; }
        typedef long (*operation)(long);
        static operation operations[] = { increment, double_value };

        long read_external(void) { return external_data; }
        long call_external(void) { return external_function(external_data); }
        operation external_pointer(void) { return external_function; }
        long call_local_pointer(unsigned index, long value) {
          return operations[index & 1](value);
        }
        `,
        "memory64-consumer",
        "wasm64posix-cc",
      );

      const options = createLoadOptions();
      const linker = new DynamicLinker(options);
      const providerHandle = linker.dlopenSync("libmemory64-provider.so", providerBytes);
      expect(providerHandle, linker.dlerror() ?? "provider failed without dlerror").toBeGreaterThan(0);
      const consumerHandle = linker.dlopenSync("libmemory64-consumer.so", consumerBytes);
      expect(consumerHandle, linker.dlerror() ?? "consumer failed without dlerror").toBeGreaterThan(0);

      const consumer = options.loadedLibraries.get("libmemory64-consumer.so");
      expect(consumer).toBeDefined();
      expect((consumer!.exports.read_external as Function)()).toBe(41n);
      expect((consumer!.exports.call_external as Function)()).toBe(42n);
      expect((consumer!.exports.call_local_pointer as Function)(0, 10n)).toBe(11n);
      expect((consumer!.exports.call_local_pointer as Function)(1, 10n)).toBe(20n);
      expect((consumer!.exports.external_pointer as Function)()).toBeTypeOf("bigint");

      const symbol = linker.dlsym(consumerHandle, "call_external");
      expect(symbol).toBeTypeOf("number");
      expect(symbol).toBeGreaterThan(0);
      expect(options.memory.buffer.byteLength).toBeGreaterThan(65536);
      expect((options.table as unknown as { length: bigint }).length).toBeGreaterThan(1n);
    });
  },
);

describe.skipIf(!hasCompiler())("synchronous loading (loadSharedLibrarySync)", () => {
  function createLoadOptions(): LoadSharedLibraryOptions {
    const memory = new WebAssembly.Memory({ initial: 1, maximum: 100, shared: true });
    const table = new WebAssembly.Table({ initial: 1, element: "anyfunc" });
    const stackPointer = new WebAssembly.Global(
      { value: "i32", mutable: true },
      65536,
    );
    return {
      memory,
      table,
      stackPointer,
      heapPointer: { value: 1024 },
      globalSymbols: new Map(),
      got: new Map(),
      loadedLibraries: new Map(),
    };
  }

  it("loads and calls a shared library synchronously", () => {
    const wasmBytes = buildSharedLib(
      `int square(int x) { return x * x; }`,
      "sync-test",
    );

    const options = createLoadOptions();
    const lib = loadSharedLibrarySync("libsync.so", wasmBytes, options);

    const square = lib.exports.square as Function;
    expect(square(7)).toBe(49);
  });

});

function createSideForkLoadOptions(): LoadSharedLibraryOptions {
  return {
    memory: new WebAssembly.Memory({ initial: 1, maximum: 100, shared: true }),
    table: new WebAssembly.Table({ initial: 1, element: "anyfunc" }),
    stackPointer: new WebAssembly.Global({ value: "i32", mutable: true }, 65536),
    heapPointer: { value: 1024 },
    globalSymbols: new Map(),
    got: new Map(),
    loadedLibraries: new Map(),
  };
}

describe("DynamicLinker deterministic replay events", () => {
  it("loads dependencies without handles and replays exact open/close state", () => {
    const dependencyBytes = buildDylinkWat(`
      (module
        (import "env" "memory" (memory 1 100 shared))
        (func (export "dependency_value") (result i32) i32.const 5))
    `, "replay-event-dependency");
    const consumerBytes = buildDylinkWat(`
      (module
        (import "env" "memory" (memory 1 100 shared))
        (import "env" "dependency_value" (func $dependency_value (result i32)))
        (func (export "consumer_value") (result i32) call $dependency_value))
    `, "replay-event-consumer", undefined, 0, 0, [], [], null, [
      "libevent-dependency.so",
    ]);
    const options = createSideForkLoadOptions();
    options.resolveLibrarySync = (name) =>
      name === "libevent-dependency.so" ? dependencyBytes : null;
    const linker = new DynamicLinker(options);

    const consumer = linker.loadModuleSync(
      "libevent-consumer.so",
      consumerBytes,
    );
    expect(Array.from(options.loadedLibraries.keys())).toEqual([
      "libevent-dependency.so",
      "libevent-consumer.so",
    ]);
    const dependency = options.loadedLibraries.get("libevent-dependency.so")!;
    expect(dependency.moduleBytes).toEqual(dependencyBytes);
    expect(dependency.moduleBytes).not.toBe(dependencyBytes);
    expect(consumer.moduleBytes).toEqual(consumerBytes);
    expect(linker.forkState()).toMatchObject({
      nextHandle: 2,
      libraries: [
        { name: "libevent-dependency.so" },
        { name: "libevent-consumer.so" },
      ],
    });
    expect(linker.forkLibraryState("libevent-dependency.so")).not.toHaveProperty("handle");
    expect(linker.forkLibraryState("libevent-consumer.so")).not.toHaveProperty("handle");
    expect((consumer.exports.consumer_value as () => number)()).toBe(5);
    expect(linker.dlsym(2, "consumer_value")).toBeNull();
    expect(linker.dlerror()).toContain("invalid handle");

    expect(() => linker.replayOpen("libevent-consumer.so", 3))
      .toThrow(/does not match next handle 2/);
    expect(linker.replayOpen("libevent-consumer.so", 2)).toBe(2);
    expect(linker.replayOpen("libevent-consumer.so", 2)).toBe(2);
    expect(linker.forkLibraryState("libevent-consumer.so")).toMatchObject({
      handle: 2,
      refCount: 2,
    });
    expect(linker.forkState().nextHandle).toBe(3);
    expect(() => linker.replayOpen("libevent-dependency.so", 2))
      .toThrow(/does not match next handle 3/);
    expect(linker.replayOpen("libevent-dependency.so", 3)).toBe(3);

    linker.replayClose(2);
    expect(linker.forkLibraryState("libevent-consumer.so")).toMatchObject({
      handle: 2,
      refCount: 1,
    });
    expect(options.loadedLibraries.has("libevent-consumer.so")).toBe(true);
    linker.replayClose(2);
    expect(options.loadedLibraries.has("libevent-consumer.so")).toBe(false);
    expect(options.loadedLibraries.has("libevent-dependency.so")).toBe(true);
    expect(() => linker.replayClose(2)).toThrow(/invalid dlopen handle 2/);

    expect(linker.forkState()).toMatchObject({
      nextHandle: 4,
      libraries: [
        {
          name: "libevent-dependency.so",
          handle: 3,
          refCount: 1,
        },
      ],
    });
  });

  it("retains NEEDED providers until both dependency and handle owners release", () => {
    const dependencyBytes = buildDylinkWat(`
      (module
        (import "env" "memory" (memory 1 100 shared))
        (func (export "dependency_value") (result i32) i32.const 5))
    `, "dependency-retain-provider");
    const consumerBytes = buildDylinkWat(`
      (module
        (import "env" "memory" (memory 1 100 shared))
        (import "env" "dependency_value" (func $dependency_value (result i32)))
        (func (export "consumer_value") (result i32) call $dependency_value))
    `, "dependency-retain-consumer", undefined, 0, 0, [], [], null, [
      "libretain-provider.so",
    ]);
    const options = createSideForkLoadOptions();
    options.resolveLibrarySync = (name) =>
      name === "libretain-provider.so" ? dependencyBytes : null;
    const linker = new DynamicLinker(options);

    const consumerHandle = linker.dlopenSync("libretain-consumer.so", consumerBytes);
    const providerHandle = linker.dlopenSync("libretain-provider.so", dependencyBytes);
    expect(consumerHandle).toBe(2);
    expect(providerHandle).toBe(3);

    expect(linker.dlclose(providerHandle)).toBe(0);
    expect(options.loadedLibraries.has("libretain-provider.so")).toBe(true);
    expect(linker.forkLibraryState("libretain-provider.so")).not.toHaveProperty("handle");
    expect(linker.dlclose(consumerHandle)).toBe(0);
    expect(options.loadedLibraries.size).toBe(0);
    expect(linker.forkState()).toMatchObject({
      nextHandle: 4,
      libraries: [],
    });
  });

  it("retains a side-module provider captured by a direct relocation", () => {
    const providerBytes = buildDylinkWat(`
      (module
        (import "env" "memory" (memory 1 100 shared))
        (func (export "runtime_provider") (result i32) i32.const 41))
    `, "runtime-provider-retain-provider");
    const consumerBytes = buildDylinkWat(`
      (module
        (import "env" "memory" (memory 1 100 shared))
        (import "env" "runtime_provider"
          (func $runtime_provider (result i32)))
        (func (export "runtime_consumer") (result i32)
          call $runtime_provider
          i32.const 1
          i32.add))
    `, "runtime-provider-retain-consumer");
    const options = createSideForkLoadOptions();
    const linker = new DynamicLinker(options);
    const providerHandle = linker.dlopenSync(
      "libruntime-provider.so",
      providerBytes,
    );
    const consumerHandle = linker.dlopenSync(
      "libruntime-consumer.so",
      consumerBytes,
    );
    expect(
      linker.forkLibraryState("libruntime-consumer.so")
        ?.providerDependencies,
    ).toEqual(["libruntime-provider.so"]);

    expect(linker.dlclose(providerHandle)).toBe(0);
    expect(options.loadedLibraries.has("libruntime-provider.so")).toBe(true);
    const consumer = linker.dlsym(consumerHandle, "runtime_consumer");
    expect((options.table.get(consumer!) as () => number)()).toBe(42);

    expect(linker.dlclose(consumerHandle)).toBe(0);
    expect(options.loadedLibraries.size).toBe(0);
  });

  it("keeps RTLD_LOCAL exports private and archives their later promotion", () => {
    const wasmBytes = buildDylinkWat(`
      (module
        (import "env" "memory" (memory 1 100 shared))
        (func (export "local_then_global") (result i32) i32.const 37))
    `, "staged-local-visibility");
    const options = createSideForkLoadOptions();
    const linker = new DynamicLinker(options);

    const localHandle = linker.dlopenSync(
      "liblocal-visibility.so",
      wasmBytes,
      undefined,
      false,
    );
    const explicit = linker.dlsym(localHandle, "local_then_global");
    expect(explicit).not.toBeNull();
    expect(linker.dlsym(0, "local_then_global")).toBeNull();
    expect(linker.forkState().libraries[0]).toMatchObject({
      globalVisibility: false,
    });
    expect(linker.forkState().libraries[0]).not.toHaveProperty(
      "committedGlobalRoot",
    );

    const promotedHandle = linker.dlopenSync(
      "liblocal-visibility.so",
      wasmBytes,
      undefined,
      true,
    );
    expect(promotedHandle).toBe(localHandle);
    expect(linker.dlsym(0, "local_then_global")).toBe(explicit);
    expect(linker.forkState().libraries[0]).toMatchObject({
      globalVisibility: true,
      committedGlobalRoot: true,
    });
  });

  it("binds an RTLD_LOCAL root through its private NEEDED scope", () => {
    const dependency = buildDylinkWat(`
      (module
        (import "env" "memory" (memory 1 100 shared))
        (func (export "dependency_value") (result i32) i32.const 29))
    `, "staged-local-needed-dependency");
    const root = buildDylinkWat(`
      (module
        (import "env" "memory" (memory 1 100 shared))
        (import "env" "dependency_value" (func $dependency_value (result i32)))
        (func (export "root_value") (result i32)
          call $dependency_value
          i32.const 8
          i32.add))
    `, "staged-local-needed-root", undefined, 0, 0, [], [], null, [
      "libscope-dep.so",
    ]);
    const options = createSideForkLoadOptions();
    options.resolveLibrarySync = (name) =>
      name === "libscope-dep.so" ? dependency : null;
    const linker = new DynamicLinker(options);

    const localHandle = linker.dlopenSync(
      "libscope-root.so",
      root,
      undefined,
      false,
    );
    const rootIndex = linker.dlsym(localHandle, "root_value");
    expect(rootIndex).not.toBeNull();
    expect((options.table.get(rootIndex!) as () => number)()).toBe(37);
    expect(
      options.loadedLibraries.get("libscope-dep.so")?.globalVisibility,
    ).toBe(false);
    expect(linker.dlsym(0, "root_value")).toBeNull();
    expect(linker.dlsym(0, "dependency_value")).toBeNull();

    expect(linker.dlopenSync(
      "libscope-root.so",
      root,
      undefined,
      true,
    )).toBe(localHandle);
    expect(
      options.loadedLibraries.get("libscope-dep.so")?.globalVisibility,
    ).toBe(true);
    expect(linker.dlsym(0, "root_value")).toBe(rootIndex);
    expect(linker.dlsym(0, "dependency_value")).not.toBeNull();
  });

  it("restores compact handle/refcount state with closed-handle gaps", () => {
    const firstBytes = buildDylinkWat(`
      (module
        (import "env" "memory" (memory 1 100 shared))
        (func (export "first_value") (result i32) i32.const 1))
    `, "fork-handle-first");
    const secondBytes = buildDylinkWat(`
      (module
        (import "env" "memory" (memory 1 100 shared))
        (func (export "second_value") (result i32) i32.const 2))
    `, "fork-handle-second");
    const parentOptions = createSideForkLoadOptions();
    const parent = new DynamicLinker(parentOptions);

    expect(parent.dlopenSync("libfirst.so", firstBytes)).toBe(2);
    expect(parent.dlopenSync("libsecond.so", secondBytes)).toBe(3);
    expect(parent.dlopenSync("libsecond.so", secondBytes)).toBe(3);
    expect(parent.dlclose(2)).toBe(0);
    const archived = parent.forkState();
    expect(archived).toMatchObject({
      nextHandle: 4,
      libraries: [{
        name: "libsecond.so",
        handle: 3,
        refCount: 2,
      }],
    });

    const childOptions = createSideForkLoadOptions();
    const child = new DynamicLinker(childOptions);
    for (const library of archived.libraries) {
      child.loadModuleSync(
        library.name,
        new Uint8Array(library.moduleBytes),
        {
          memoryBase: library.memoryBase,
          tableBase: library.tableBase,
          activationId: library.activationId,
          tlsBase: library.tlsBase,
          globalVisibility: library.globalVisibility,
          committedGlobalRoot: library.committedGlobalRoot,
        },
      );
    }
    child.restoreForkHandleState(archived);
    expect(child.forkState()).toEqual(archived);

    // The duplicate open keeps the inherited handle and reference count.
    expect(child.dlopenSync("libsecond.so", secondBytes)).toBe(3);
    expect(child.forkLibraryState("libsecond.so")).toMatchObject({
      handle: 3,
      refCount: 3,
    });
    // The next new module must not reuse the parent's closed handle 2.
    expect(child.dlopenSync("libfirst.so", firstBytes)).toBe(4);
  });

  it("reconciles dlopen function recipes to fresh Worker-local table entries", () => {
    const sideBytes = buildDylinkWat(`
      (module
        (import "env" "memory" (memory 1 100 shared))
        (import "env" "__indirect_function_table" (table 1 funcref))
        (import "env" "__table_base" (global $table_base i32))
        (func $side_value (export "side_value") (result i32) i32.const 73)
        (elem (global.get $table_base) func $side_value))
    `, "fork-table-replica", undefined, 1);
    const parentOptions = createSideForkLoadOptions();
    const parentMutations: Array<[number, number]> = [];
    parentOptions.onTableMutation = (_table, firstIndex, length) => {
      parentMutations.push([firstIndex, length]);
    };
    const parent = new DynamicLinker(parentOptions);
    expect(parent.dlopenSync("libtable-replica.so", sideBytes)).toBe(2);
    const archived = parent.forkState();
    const parentLibrary = archived.libraries[0]!;
    const parentFunction = parentOptions.table.get(parentLibrary.tableBase);
    expect(typeof parentFunction).toBe("function");
    expect((parentFunction as () => number)()).toBe(73);
    expect(parentMutations).toContainEqual([
      parentOptions.table.length - 1,
      1,
    ]);

    const replicaOptions = createSideForkLoadOptions();
    const replicaMutations: Array<[number, number]> = [];
    replicaOptions.onTableMutation = (_table, firstIndex, length) => {
      replicaMutations.push([firstIndex, length]);
    };
    const replica = new DynamicLinker(replicaOptions);
    replica.reconcileForkModules(archived);
    const freshFunction = replicaOptions.table.get(parentLibrary.tableBase);
    expect(typeof freshFunction).toBe("function");
    expect(freshFunction).not.toBe(parentFunction);
    expect((freshFunction as () => number)()).toBe(73);
    expect(replicaMutations).toContainEqual([
      replicaOptions.table.length - 1,
      1,
    ]);

    const length = replicaOptions.table.length;
    replica.reconcileForkModules(archived);
    expect(replicaOptions.table.length).toBe(length);
    expect(replicaOptions.table.get(parentLibrary.tableBase)).toBe(freshFunction);

    const parentOwnedEntries = [
      ...parentOptions.loadedLibraries.get("libtable-replica.so")!
        .ownedTableEntries,
    ];
    const replicaOwnedEntries = [
      ...replicaOptions.loadedLibraries.get("libtable-replica.so")!
        .ownedTableEntries,
    ];
    expect(parent.dlclose(2)).toBe(0);
    for (const index of parentOwnedEntries) {
      expect(parentOptions.table.get(index)).toBeNull();
    }
    expect(parentOptions.globalSymbols.has("side_value")).toBe(false);
    expect(parent.dlsym(0, "side_value")).toBeNull();
    const closed = parent.forkState();
    expect(closed.libraries).toEqual([]);

    replica.reconcileForkModules(closed);
    expect(replicaOptions.loadedLibraries.size).toBe(0);
    for (const index of replicaOwnedEntries) {
      expect(replicaOptions.table.get(index)).toBeNull();
    }
  });

  it("rejects non-pristine or inconsistent compact handle snapshots", () => {
    const wasmBytes = buildDylinkWat(`
      (module
        (import "env" "memory" (memory 1 100 shared))
        (func (export "value") (result i32) i32.const 1))
    `, "fork-handle-validation");
    const options = createSideForkLoadOptions();
    const linker = new DynamicLinker(options);
    const live = linker.loadModuleSync("libvalidation.so", wasmBytes);
    const baseState = {
      nextHandle: 4,
      libraries: [{
        name: live.name,
        moduleBytes: live.moduleBytes,
        memoryBase: live.memoryBase,
        tableBase: live.tableBase,
        globalVisibility: live.globalVisibility,
        handle: 3,
        refCount: 1,
      }],
    };

    expect(() => linker.restoreForkHandleState({
      ...baseState,
      libraries: [
        ...baseState.libraries,
        { ...baseState.libraries[0]!, handle: 2 },
      ],
    })).toThrow(/exact live module closure/);
    expect(() => linker.restoreForkHandleState({
      ...baseState,
      libraries: [{ ...baseState.libraries[0]!, handle: 4 }],
    })).toThrow(/fork handle 4 is invalid/);
    linker.restoreForkHandleState(baseState);
    expect(() => linker.restoreForkHandleState(baseState))
      .toThrow(/requires a pristine child handle index/);
  });

  it("rejects replay of the same module-load record twice", () => {
    const wasmBytes = buildDylinkWat(`
      (module
        (import "env" "memory" (memory 1 100 shared))
        (func (export "value") (result i32) i32.const 1))
    `, "duplicate-replay-load");
    const options = createSideForkLoadOptions();
    const linker = new DynamicLinker(options);
    const loaded = linker.loadModuleSync("libduplicate-replay.so", wasmBytes, {
      memoryBase: 0,
      tableBase: 1,
    });
    expect(loaded.name).toBe("libduplicate-replay.so");

    expect(() => linker.loadModuleSync("libduplicate-replay.so", wasmBytes, {
      memoryBase: 0,
      tableBase: 1,
    })).toThrow(/archive entries must be unique/);
  });
});

describe("side-module fork contract", () => {
  it("keeps raw side modules legal when the process has no fork activation owner", () => {
    const wasmBytes = buildDylinkWat(`
      (module
        (import "env" "memory" (memory 1 100 shared))
        (func (export "raw_value") (result i32) i32.const 17))
    `, "raw-side-without-fork-owner");
    const options = createSideForkLoadOptions();

    const loaded = loadSharedLibrarySync(
      "libraw-nonfork.so",
      wasmBytes,
      options,
    );

    expect((loaded.exports.raw_value as () => number)()).toBe(17);
    expect(loaded.activationId).toBeUndefined();
  });

  it("rejects a raw side module before instantiation in a fork-capable process", () => {
    const wasmBytes = buildDylinkWat(`
      (module
        (import "env" "memory" (memory 1 100 shared))
        (func (export "raw_value") (result i32) i32.const 17))
    `, "raw-side-with-fork-owner");
    const testOwner = createTestForkActivationOwner();
    const options = createSideForkLoadOptions();
    options.forkActivationOwner = testOwner.owner;

    expect(() => loadSharedLibrarySync(
      "libraw-fork-process.so",
      wasmBytes,
      options,
    )).toThrow(/requires complete ABI 43 side-boundary instrumentation/);
    expect(testOwner.prepares).toEqual([]);
    expect(options.loadedLibraries.size).toBe(0);
  });

  it("accepts a complete side-boundary artifact without an env.fork import", () => {
    const wasmBytes = buildInstrumentedDylinkWat(`
      (module
        (import "env" "memory" (memory 1 100 shared))
        (import "env" "host_value" (func $host_value (result i32)))
        (func (export "side_value") (result i32)
          call $host_value
          i32.const 1
          i32.add))
    `, "side-boundary-without-fork-import");
    const module = new WebAssembly.Module(
      wasmBytes as unknown as BufferSource,
    );
    expect(WebAssembly.Module.imports(module).some(
      (entry) =>
        entry.module === "env"
        && entry.name === "fork"
        && entry.kind === "function",
    )).toBe(false);
    expect(readForkInstrumentCapabilities(module) & FORK_CAP_SIDE_ENTRY)
      .toBe(FORK_CAP_SIDE_ENTRY);

    const testOwner = createTestForkActivationOwner(21);
    const options = createSideForkLoadOptions();
    options.globalSymbols.set("host_value", () => 16);
    options.forkActivationOwner = testOwner.owner;

    const loaded = loadSharedLibrarySync(
      "libside-boundary.so",
      wasmBytes,
      options,
    );

    expect(loaded.activationId).toBe(21);
    expect((loaded.exports.side_value as () => number)()).toBe(17);
    expect(testOwner.registered).toEqual([
      { activationId: 21, instance: loaded.instance },
    ]);
  });

  it("validates ABI 43 reconstruction metadata before side-module instantiation", () => {
    // Export every reserved function name so the loader takes the complete
    // ABI-43 path. Deliberately give the stubs the wrong signatures and omit
    // reconstruction descriptors/imports: none of this module may execute.
    const reservedStubs = SIDE_MODULE_FORK_EXPORTS
      .map((name) => `(func (export "${name}"))`)
      .join("\n");
    const wasmBytes = buildDylinkWat(`
      (module
        (import "env" "memory" (memory 1 100 shared))
        ${reservedStubs})
    `, "side-fork-invalid-reconstruction-contract", 0);
    const options = createSideForkLoadOptions();
    let prepareCalls = 0;
    options.forkActivationOwner = {
      prepare() {
        prepareCalls++;
        throw new Error("must not prepare an invalid artifact");
      },
    };

    expect(() => loadSharedLibrarySync("libinvalidfork.so", wasmBytes, options))
      .toThrow(
        /invalid ABI 43 fork reconstruction contract: .*exception_codec.*imported_globals/,
      );
    expect(prepareCalls).toBe(0);
    expect(options.loadedLibraries.has("libinvalidfork.so")).toBe(false);
  });

  it("rejects an uninstrumented side module that imports fork", () => {
    const wasmBytes = buildDylinkWat(`
      (module
        (import "env" "memory" (memory 1 100 shared))
        (import "env" "fork" (func $fork (result i32)))
        (func (export "side_fork") (result i32) call $fork))
    `, "side-fork-uninstrumented");
    const options = createSideForkLoadOptions();

    expect(() => loadSharedLibrarySync("libbadfork.so", wasmBytes, options))
      .toThrow(/requires complete side-module instrumentation/);
  });

  it("makes missing side and main role claims mandatory at ABI 17", () => {
    const wasmBytes = buildDylinkWat(`
      (module (import "env" "memory" (memory 1 100 shared)))
    `, "legacy-capability-absence");
    const module = new WebAssembly.Module(wasmBytes as unknown as BufferSource);
    const claim = readForkInstrumentCapabilityClaim(module);

    expect(claim).toEqual({ present: false, flags: 0 });
    expect(forkInstrumentRoleAvailable(claim, FORK_CAP_SIDE_ENTRY, 16)).toBe(true);
    expect(forkInstrumentRoleAvailable(claim, FORK_CAP_DYLINK_MAIN, 16)).toBe(true);
    expect(forkInstrumentRoleAvailable(claim, FORK_CAP_SIDE_ENTRY, 17)).toBe(false);
    expect(forkInstrumentRoleAvailable(claim, FORK_CAP_DYLINK_MAIN, 17)).toBe(false);
    expect(forkInstrumentRoleAvailable(
      { present: true, flags: FORK_CAP_SIDE_ENTRY },
      FORK_CAP_DYLINK_MAIN,
      16,
    )).toBe(false);
  });

  it("binds a side module's activation-safety claim to the host ABI", () => {
    const reservedStubs = SIDE_MODULE_FORK_EXPORTS
      .map((name) => `(func (export "${name}"))`)
      .join("\n");
    const sideWat = `
      (module
        (import "env" "memory" (memory 1 100 shared))
        ${reservedStubs})
    `;
    const options = createSideForkLoadOptions();
    let prepareCalls = 0;
    options.forkActivationOwner = {
      prepare() {
        prepareCalls++;
        throw new Error("must not prepare an ABI-mismatched artifact");
      },
    };
    const stale = buildDylinkWat(
      sideWat,
      "side-fork-stale-abi",
      0,
      0,
      0,
      [],
      [],
      ABI_VERSION - 1,
    );
    expect(() => loadSharedLibrarySync("libstale.so", stale, options))
      .toThrow(
        new RegExp(
          `declares ABI ${ABI_VERSION - 1}, but the host requires ABI ${ABI_VERSION}`,
        ),
      );

    const missing = buildDylinkWat(
      sideWat,
      "side-fork-missing-abi",
      0,
      0,
      0,
      [],
      [],
      null,
    );
    expect(() => loadSharedLibrarySync("libmissing.so", missing, options))
      .toThrow(/missing __abi_version/);
    expect(prepareCalls).toBe(0);
  });

  it("reads the versioned side-entry capability independently", () => {
    const wasmBytes = buildDylinkWat(`
      (module (import "env" "memory" (memory 1 100 shared)))
    `, "side-capability-marker", FORK_CAP_SIDE_ENTRY);
    const module = new WebAssembly.Module(wasmBytes as unknown as BufferSource);
    expect(readForkInstrumentCapabilityClaim(module)).toEqual({
      present: true,
      flags: FORK_CAP_SIDE_ENTRY | FORK_CAP_ACTIVATION_STATE_SAFE,
    });
    expect(readForkInstrumentCapabilities(module)).toBe(
      FORK_CAP_SIDE_ENTRY | FORK_CAP_ACTIVATION_STATE_SAFE,
    );
  });

  it("rejects a malformed marker even during the ABI-16 compatibility window", () => {
    const base = buildDylinkWat(`
      (module (import "env" "memory" (memory 1 100 shared)))
    `, "malformed-capability-marker");
    const wasmBytes = appendCustomSection(
      base,
      FORK_CAPABILITIES_SECTION,
      new Uint8Array([FORK_CAPABILITIES_VERSION]),
    );
    const module = new WebAssembly.Module(wasmBytes as unknown as BufferSource);

    expect(() => readForkInstrumentCapabilityClaim(module))
      .toThrow(/malformed kandelo\.wpk_fork\.capabilities custom section/);
  });

  it("requires a process activation owner for a valid ABI-43 side module", () => {
    const wasmBytes = buildInstrumentedDylinkWat(`
      (module
        (import "env" "memory" (memory 1 100 shared))
        (import "env" "fork" (func $fork (result i32)))
        (func (export "side_fork") (result i32) call $fork))
    `, "side-fork-owner-required");
    const options = createSideForkLoadOptions();
    options.forkActivationOwnerUnavailableReason =
      "main activation registry is unavailable; rebuild or relaunch the process";

    expect(() => loadSharedLibrarySync("libowner-required.so", wasmBytes, options))
      .toThrow(/main activation registry is unavailable/);
  });

  it("registers multiple linked side activations without module-static fork roots", () => {
    const providerBytes = buildInstrumentedDylinkWat(`
      (module
        (import "env" "memory" (memory 1 100 shared))
        (import "env" "fork" (func $fork (result i32)))
        (export "raw_fork_import" (func $fork))
        (func (export "provider_value") (result i32) i32.const 7))
    `, "side-fork-provider");
    const consumerBytes = buildInstrumentedDylinkWat(`
      (module
        (import "env" "memory" (memory 1 100 shared))
        (import "env" "fork" (func $fork (result i32)))
        (import "env" "provider_value" (func $provider_value (result i32)))
        (func (export "nested_value") (result i32)
          call $provider_value
          i32.const 1
          i32.add)
        (func (export "consumer_fork") (result i32) call $fork))
    `, "side-fork-consumer");
    const testOwner = createTestForkActivationOwner();
    const options = createSideForkLoadOptions();
    options.forkActivationOwner = testOwner.owner;

    const provider = loadSharedLibrarySync(
      "libfork-provider.so",
      providerBytes,
      options,
    );
    const consumer = loadSharedLibrarySync(
      "libfork-consumer.so",
      consumerBytes,
      options,
    );

    expect(provider.activationId).toBe(1);
    expect(consumer.activationId).toBe(2);
    expect(testOwner.registered).toEqual([
      { activationId: 1, instance: provider.instance },
      { activationId: 2, instance: consumer.instance },
    ]);
    expect((consumer.exports.nested_value as () => number)()).toBe(8);
    // Engines expose a Wasm wrapper when an imported JS function is
    // re-exported, so behavior—not JS object identity—proves the exact owner
    // callback reached the module.
    expect((provider.instance.exports.raw_fork_import as () => number)()).toBe(-12);
    expect("forkBufAddr" in provider).toBe(false);
    expect("forkContinuation" in provider).toBe(false);
    expect(typeof provider.activationId).toBe("number");
  });

  it("wraps the final lazy imports before instantiation without collapsing duplicates", () => {
    const wasmBytes = buildInstrumentedDylinkWat(`
      (module
        (import "env" "memory" (memory 1 100 shared))
        (import "env" "__indirect_function_table" (table 1 funcref))
        (import "env" "shared_counter" (global $first_counter (mut i32)))
        (import "env" "shared_counter" (global $second_counter (mut i32)))
        (import "env" "fork" (func $fork (result i32)))
        (func (export "counter_sum") (result i32)
          global.get $first_counter
          global.get $second_counter
          i32.add)
        (func (export "side_fork") (result i32) call $fork))
    `, "side-fork-lazy-import-capture");
    const testOwner = createTestForkActivationOwner(31);
    const options = createSideForkLoadOptions();
    const sharedCounter = new WebAssembly.Global(
      { value: "i32", mutable: true },
      6,
    );
    options.globalSymbols.set("shared_counter", sharedCounter);
    const observedGlobals: unknown[] = [];
    const observedTables: unknown[] = [];
    options.forkActivationOwner = {
      prepare(request) {
        const prepared = testOwner.owner.prepare(request);
        return {
          ...prepared,
          wrapImports(imports) {
            const baseImports = prepared.wrapImports(imports);
            return new Proxy(baseImports as object, {
              get(target, moduleName, receiver) {
                const namespace = Reflect.get(target, moduleName, receiver);
                if (moduleName !== "env" || typeof namespace !== "object") {
                  return namespace;
                }
                return new Proxy(namespace as object, {
                  get(namespaceTarget, importName, namespaceReceiver) {
                    const value = Reflect.get(
                      namespaceTarget,
                      importName,
                      namespaceReceiver,
                    );
                    if (importName === "shared_counter") {
                      observedGlobals.push(value);
                    } else if (importName === "__indirect_function_table") {
                      observedTables.push(value);
                    }
                    return value;
                  },
                });
              },
            }) as WebAssembly.Imports;
          },
        };
      },
    };

    const loaded = loadSharedLibrarySync(
      "libfork-lazy-import-capture.so",
      wasmBytes,
      options,
    );

    expect(observedGlobals).toEqual([sharedCounter, sharedCounter]);
    expect(observedTables).toEqual([options.table]);
    expect(testOwner.wrappedImports).toHaveLength(1);
    expect(testOwner.registered).toEqual([
      { activationId: 31, instance: loaded.instance },
    ]);
    expect((loaded.exports.counter_sum as () => number)()).toBe(12);
  });

  it("reuses the saved GOT.func index during replay without growing the table", () => {
    const callbackModule = new WebAssembly.Module(buildDylinkWat(`
      (module
        (func (export "callback") (result i32) i32.const 73))
    `, "saved-got-callback"));
    const callback = new WebAssembly.Instance(callbackModule).exports.callback as Function;
    const wasmBytes = buildInstrumentedDylinkWat(`
      (module
        (import "env" "memory" (memory 1 100 shared))
        (import "GOT.func" "main_callback" (global (mut i32))))
    `, "side-fork-saved-got-function");
    const testOwner = createTestForkActivationOwner(61);
    const options = createSideForkLoadOptions();
    options.table.grow(1);
    options.globalSymbols.set("main_callback", callback);
    options.forkActivationOwner = {
      prepare(request) {
        const prepared = testOwner.owner.prepare(request);
        return {
          ...prepared,
          savedMutableGlobalImport(moduleName, importName) {
            expect([moduleName, importName]).toEqual([
              "GOT.func",
              "main_callback",
            ]);
            return 1;
          },
        };
      },
    };
    const baselineLength = options.table.length;

    loadSharedLibrarySync(
      "libfork-saved-got-function.so",
      wasmBytes,
      options,
      {
        memoryBase: 0,
        tableBase: baselineLength,
        activationId: 61,
      },
    );

    expect(options.table.length).toBe(baselineLength);
    expect(options.got.get("main_callback")?.value).toBe(1);
  });

  it("reconstructs a pre-export table gap from a saved self GOT.func index", () => {
    const wasmBytes = buildInstrumentedDylinkWat(`
      (module
        (import "env" "memory" (memory 1 100 shared))
        (import "GOT.func" "side_callback" (global (mut i32)))
        (func (export "side_callback") (result i32) i32.const 73))
    `, "side-fork-saved-self-got-function");
    const testOwner = createTestForkActivationOwner(62);
    const options = createSideForkLoadOptions();
    options.forkActivationOwner = {
      prepare(request) {
        const prepared = testOwner.owner.prepare(request);
        return {
          ...prepared,
          savedMutableGlobalImport: () => 3,
        };
      },
    };

    const loaded = loadSharedLibrarySync(
      "libfork-saved-self-got-function.so",
      wasmBytes,
      options,
      {
        memoryBase: 0,
        tableBase: options.table.length,
        activationId: 62,
      },
    );

    expect(options.table.length).toBe(4);
    expect(options.table.get(1)).toBeNull();
    expect(options.table.get(2)).toBeNull();
    expect(options.table.get(3)).toBe(loaded.exports.side_callback);
  });

  it("rejects a replayed self GOT.func index that disagrees with its table slot", () => {
    const wasmBytes = buildInstrumentedDylinkWat(`
      (module
        (import "env" "memory" (memory 1 100 shared))
        (import "GOT.func" "side_callback" (global (mut i32)))
        (func (export "side_callback") (result i32) i32.const 73))
    `, "side-fork-conflicting-self-got-function");
    const testOwner = createTestForkActivationOwner(62);
    const options = createSideForkLoadOptions();
    options.table.grow(1);
    options.forkActivationOwner = {
      prepare(request) {
        const prepared = testOwner.owner.prepare(request);
        return {
          ...prepared,
          savedMutableGlobalImport: () => 0,
        };
      },
    };

    expect(() => loadSharedLibrarySync(
      "libfork-conflicting-self-got-function.so",
      wasmBytes,
      options,
      {
        memoryBase: 0,
        tableBase: options.table.length,
        activationId: 62,
      },
    )).toThrow(/saved GOT\.func\.side_callback.*replayed table index/);
  });

  it("replays dependency-first with the parent's exact activation ids", () => {
    const dependencyBytes = buildInstrumentedDylinkWat(`
      (module
        (import "env" "memory" (memory 1 100 shared))
        (import "env" "fork" (func $fork (result i32)))
        (func (export "dependency_value") (result i32) i32.const 19)
        (func (export "dependency_fork") (result i32) call $fork))
    `, "side-fork-needed-dependency");
    const consumerBytes = buildInstrumentedDylinkWat(`
      (module
        (import "env" "memory" (memory 1 100 shared))
        (import "env" "fork" (func $fork (result i32)))
        (import "env" "dependency_value" (func $dependency_value (result i32)))
        (func (export "needed_value") (result i32) call $dependency_value)
        (func (export "needed_fork") (result i32) call $fork))
    `, "side-fork-needed-consumer", ["libfork-dependency.so"]);
    const parentOwner = createTestForkActivationOwner(41);
    const parent = createSideForkLoadOptions();
    parent.forkActivationOwner = parentOwner.owner;
    parent.resolveLibrarySync = (name) =>
      name === "libfork-dependency.so" ? dependencyBytes : null;

    const parentConsumer = loadSharedLibrarySync(
      "libfork-consumer.so",
      consumerBytes,
      parent,
    );
    const parentDependency = parent.loadedLibraries.get("libfork-dependency.so")!;
    expect(Array.from(parent.loadedLibraries)).toEqual([
      ["libfork-dependency.so", parentDependency],
      ["libfork-consumer.so", parentConsumer],
    ]);
    expect(parentDependency.activationId).toBe(41);
    expect(parentConsumer.activationId).toBe(42);

    const childOwner = createTestForkActivationOwner(100);
    const child = createSideForkLoadOptions();
    child.forkActivationOwner = childOwner.owner;
    expect(() => loadSharedLibrarySync(
      "libfork-consumer.so",
      consumerBytes,
      child,
      {
        memoryBase: parentConsumer.memoryBase,
        tableBase: parentConsumer.tableBase,
        activationId: parentConsumer.activationId,
      },
    )).toThrow(/archive entries must be replayed in dependency order/);
    expect(childOwner.prepares).toHaveLength(0);

    const childDependency = loadSharedLibrarySync(
      "libfork-dependency.so",
      dependencyBytes,
      child,
      {
        memoryBase: parentDependency.memoryBase,
        tableBase: parentDependency.tableBase,
        activationId: parentDependency.activationId,
      },
    );
    const childConsumer = loadSharedLibrarySync(
      "libfork-consumer.so",
      consumerBytes,
      child,
      {
        memoryBase: parentConsumer.memoryBase,
        tableBase: parentConsumer.tableBase,
        activationId: parentConsumer.activationId,
      },
    );

    expect(childDependency.activationId).toBe(41);
    expect(childConsumer.activationId).toBe(42);
    expect(childOwner.prepares.map((request) => request.replayActivationId))
      .toEqual([41, 42]);
    expect((childConsumer.exports.needed_value as () => number)()).toBe(19);
  });

  it("unregisters exactly once when post-instantiation startup rolls back", () => {
    const wasmBytes = buildInstrumentedDylinkWat(`
      (module
        (import "env" "memory" (memory 1 100 shared))
        (import "env" "fork" (func $fork (result i32)))
        (func (export "__wasm_call_ctors") unreachable)
        (func (export "side_fork") (result i32) call $fork))
    `, "side-fork-rollback");
    const testOwner = createTestForkActivationOwner(9);
    const options = createSideForkLoadOptions();
    options.forkActivationOwner = testOwner.owner;

    expect(() => loadSharedLibrarySync("libfork-rollback.so", wasmBytes, options))
      .toThrow();
    expect(testOwner.registered).toHaveLength(1);
    expect(testOwner.unregistered).toEqual([9]);
    expect(testOwner.active.size).toBe(0);
    expect(options.loadedLibraries.size).toBe(0);
  });

  it("does not fall back to process symbols for owner-controlled fork imports", () => {
    const wasmBytes = buildInstrumentedDylinkWat(`
      (module
        (import "env" "memory" (memory 1 100 shared))
        (import "env" "fork" (func $fork (result i32)))
        (func (export "side_fork") (result i32) call $fork))
    `, "side-fork-owner-import");
    const testOwner = createTestForkActivationOwner(15);
    const options = createSideForkLoadOptions();
    options.globalSymbols.set("fork", () => 123);
    options.forkActivationOwner = {
      prepare(request) {
        const prepared = testOwner.owner.prepare(request);
        const { fork: _fork, ...envWithoutFork } = prepared.env;
        return { ...prepared, env: envWithoutFork };
      },
    };

    expect(() => loadSharedLibrarySync("libfork-owner-import.so", wasmBytes, options))
      .toThrow(/function import requires a callable/);
    expect(testOwner.unregistered).toEqual([15]);
    expect(testOwner.active.size).toBe(0);
  });

  it("keeps a shared activation until the final dlclose reference", () => {
    const wasmBytes = buildInstrumentedDylinkWat(`
      (module
        (import "env" "memory" (memory 1 100 shared))
        (import "env" "fork" (func $fork (result i32)))
        (func (export "side_fork") (result i32) call $fork))
    `, "side-fork-refcount");
    const testOwner = createTestForkActivationOwner(27);
    const options = createSideForkLoadOptions();
    options.forkActivationOwner = testOwner.owner;
    const linker = new DynamicLinker(options);

    const firstHandle = linker.dlopenSync("libfork-refcount.so", wasmBytes);
    const secondHandle = linker.dlopenSync("libfork-refcount.so", wasmBytes);
    expect(firstHandle).toBeGreaterThan(0);
    expect(secondHandle).toBe(firstHandle);
    expect(testOwner.prepares).toHaveLength(1);

    expect(linker.dlclose(firstHandle)).toBe(0);
    expect(testOwner.unregistered).toEqual([]);
    expect(options.loadedLibraries.has("libfork-refcount.so")).toBe(true);

    expect(linker.dlclose(secondHandle)).toBe(0);
    expect(testOwner.unregistered).toEqual([27]);
    expect(testOwner.active.size).toBe(0);
    expect(options.loadedLibraries.has("libfork-refcount.so")).toBe(false);
  });
});

describe("dylink symbol interposition", () => {
  it("preserves first-definition GOT bindings for duplicate function and data exports", () => {
    const firstBytes = buildDylinkWat(`
      (module
        (import "env" "memory" (memory 1 100 shared))
        (func (export "duplicate_function") (result i32) i32.const 1)
        (global (export "duplicate_data") i32 (i32.const 12)))
    `, "first-duplicate-exports", undefined, 0, 16);
    const secondBytes = buildDylinkWat(`
      (module
        (import "env" "memory" (memory 1 100 shared))
        (func (export "duplicate_function") (result i32) i32.const 2)
        (global (export "duplicate_data") i32 (i32.const 28)))
    `, "second-duplicate-exports", undefined, 0, 16);
    const options = createSideForkLoadOptions();
    const functionGot = new WebAssembly.Global({ value: "i32", mutable: true }, 0);
    const dataGot = new WebAssembly.Global({ value: "i32", mutable: true }, 0);
    options.got.set("duplicate_function", functionGot);
    options.got.set("duplicate_data", dataGot);

    const first = loadSharedLibrarySync("libfirst.so", firstBytes, options);
    const firstFunctionBinding = options.globalSymbols.get("duplicate_function");
    const firstDataBinding = options.globalSymbols.get("duplicate_data");
    const firstFunctionGot = functionGot.value;
    const firstDataGot = dataGot.value;
    const tableLengthAfterFirst = options.table.length;

    const second = loadSharedLibrarySync("libsecond.so", secondBytes, options);

    expect(options.globalSymbols.get("duplicate_function")).toBe(firstFunctionBinding);
    expect(options.globalSymbols.get("duplicate_data")).toBe(firstDataBinding);
    expect(functionGot.value).toBe(firstFunctionGot);
    expect(dataGot.value).toBe(firstDataGot);
    expect((first.exports.duplicate_function as () => number)()).toBe(1);
    expect((second.exports.duplicate_function as () => number)()).toBe(2);
    expect((second.exports.duplicate_data as WebAssembly.Global).value)
      .not.toBe((first.exports.duplicate_data as WebAssembly.Global).value);
    expect(options.table.length).toBe(tableLengthAfterFirst + 1);
    expect(options.table.get(options.table.length - 1))
      .toBe(second.exports.duplicate_function);
  });
});

describe("dylink replay layout and rollback", () => {
  it("rebuilds borrowed instances without running start or data relocations", () => {
    const wasmBytes = buildDylinkWat(`
      (module
        (import "env" "memory" (memory 1 100 shared))
        (import "env" "__memory_base" (global $memory_base i32))
        (func $write (param $value i32)
          global.get $memory_base
          local.get $value
          i32.store)
        (func $start (export "__wasm_init_memory")
          i32.const 91
          call $write)
        (start $start)
        (func (export "__wasm_apply_data_relocs")
          i32.const 92
          call $write)
        (func (export "read_value") (result i32)
          global.get $memory_base
          i32.load))
    `, "borrowed-no-loader-writes", undefined, 0, 4);
    const options = createSideForkLoadOptions();
    const memoryBase = 4_096;
    new DataView(options.memory.buffer).setInt32(memoryBase, 77, true);

    const library = loadSharedLibrarySync(
      "libborrowed-no-loader-writes.so",
      wasmBytes,
      options,
      {
        memoryBase,
        tableBase: options.table.length,
        memoryOwnership: "borrowed",
      },
    );

    expect((library.exports.read_value as () => number)()).toBe(77);
    expect(new DataView(options.memory.buffer).getInt32(memoryBase, true))
      .toBe(77);
  });

  it("rejects active data before borrowed instantiation can write", () => {
    const wasmBytes = buildDylinkWat(`
      (module
        (import "env" "memory" (memory 1 100 shared))
        (data (i32.const 4096) "\\01\\00\\00\\00"))
    `, "borrowed-active-data", undefined, 0, 4);
    const options = createSideForkLoadOptions();
    const memoryBase = 4_096;
    new DataView(options.memory.buffer).setInt32(memoryBase, 77, true);

    expect(() => loadSharedLibrarySync(
      "libborrowed-active-data.so",
      wasmBytes,
      options,
      {
        memoryBase,
        tableBase: options.table.length,
        memoryOwnership: "borrowed",
      },
    )).toThrow(/borrowed replay requires passive data segments/);
    expect(new DataView(options.memory.buffer).getInt32(memoryBase, true))
      .toBe(77);
  });

  it("rejects an unrecognized start instead of silently skipping it", () => {
    const wasmBytes = buildDylinkWat(`
      (module
        (import "env" "memory" (memory 1 100 shared))
        (import "env" "__memory_base" (global $memory_base i32))
        (func $start
          global.get $memory_base
          i32.const 93
          i32.store)
        (start $start))
    `, "borrowed-unknown-start", undefined, 0, 4);
    const options = createSideForkLoadOptions();
    const memoryBase = 4_096;
    new DataView(options.memory.buffer).setInt32(memoryBase, 77, true);

    expect(() => loadSharedLibrarySync(
      "libborrowed-unknown-start.so",
      wasmBytes,
      options,
      {
        memoryBase,
        tableBase: options.table.length,
        memoryOwnership: "borrowed",
      },
    )).toThrow(/cannot suppress unrecognized start function/);
    expect(new DataView(options.memory.buffer).getInt32(memoryBase, true))
      .toBe(77);
  });

  it("rejects in-flight loader transactions at the borrowed boundary", () => {
    const linker = new DynamicLinker(createSideForkLoadOptions());
    expect(() => linker.reconcileForkModules({
      nextHandle: 2,
      libraries: [],
      transactions: [{
        token: 1,
        name: "libpending.so",
        moduleBytes: new Uint8Array(),
        globalVisibility: false,
      }],
    }, {
      memoryOwnership: "borrowed",
    })).toThrow(/cannot restore an in-flight dlopen transaction/);
  });

  it("does not apply data relocations twice to copied child memory", () => {
    const wasmBytes = buildDylinkWat(`
      (module
        (import "env" "memory" (memory 1 100 shared))
        (func (export "__wasm_apply_data_relocs")
          i32.const 32
          i32.const 32
          i32.load
          i32.const 1
          i32.add
          i32.store))
    `, "replay-does-not-relocate-twice");
    const parent = createSideForkLoadOptions();
    const loaded = loadSharedLibrarySync(
      "librelocate-once.so",
      wasmBytes,
      parent,
    );
    expect(new DataView(parent.memory.buffer).getInt32(32, true)).toBe(1);

    const child = createSideForkLoadOptions();
    new Uint8Array(child.memory.buffer).set(
      new Uint8Array(parent.memory.buffer),
    );
    loadSharedLibrarySync("librelocate-once.so", wasmBytes, child, {
      memoryBase: loaded.memoryBase,
      tableBase: loaded.tableBase,
    });
    expect(new DataView(child.memory.buffer).getInt32(32, true)).toBe(1);
  });

  it("restores copied live TLS without re-running side-module TLS initialization", () => {
    const tlsSide = buildDylinkWat(`
      (module
        (import "env" "memory" (memory 1 100 shared))
        (import "env" "__memory_base" (global $memory_base i32))
        (global $tls_base (export "__tls_base") (mut i32) (i32.const 0))
        (global (export "__tls_size") i32 (i32.const 4))
        (global (export "__tls_align") i32 (i32.const 4))
        (global (export "__wasm_lpad_context") i32 (i32.const 8))
        (func $init_tls (export "__wasm_init_tls") (param $base i32)
          local.get $base
          global.set $tls_base
          local.get $base
          i32.const 42
          i32.store)
        (func $start
          global.get $memory_base
          i32.load
          i32.eqz
          if
            global.get $memory_base
            i32.const 2
            i32.store
            global.get $memory_base
            i32.const 8
            i32.add
            call $init_tls
          end)
        (start $start)
        (func (export "get_tls") (result i32)
          global.get $tls_base
          i32.load)
        (func (export "set_tls") (param $value i32)
          global.get $tls_base
          local.get $value
          i32.store))
    `, "replay-live-tls", undefined, 0, 16, [], ["__wasm_lpad_context"]);
    const parent = createSideForkLoadOptions();
    const loaded = loadSharedLibrarySync("libtls.so", tlsSide, parent);
    expect(loaded.tlsBase).toBe(1032);
    expect((loaded.exports.__wasm_lpad_context as WebAssembly.Global).value)
      .toBe(loaded.tlsBase! + 8);
    expect((loaded.exports.__tls_size as WebAssembly.Global).value).toBe(4);
    expect((loaded.exports.__tls_align as WebAssembly.Global).value).toBe(4);
    expect((loaded.exports.get_tls as Function)()).toBe(42);
    (loaded.exports.set_tls as Function)(99);

    const child = createSideForkLoadOptions();
    new Uint8Array(child.memory.buffer).set(new Uint8Array(parent.memory.buffer));
    const replayed = loadSharedLibrarySync("libtls.so", tlsSide, child, {
      memoryBase: loaded.memoryBase,
      tableBase: loaded.tableBase,
      tlsBase: loaded.tlsBase,
    });

    expect(replayed.tlsBase).toBe(loaded.tlsBase);
    expect((replayed.exports.__wasm_lpad_context as WebAssembly.Global).value)
      .toBe(replayed.tlsBase! + 8);
    expect((replayed.exports.get_tls as Function)()).toBe(99);

    const ambiguous = createSideForkLoadOptions();
    new Uint8Array(ambiguous.memory.buffer).set(new Uint8Array(parent.memory.buffer));
    expect(() => loadSharedLibrarySync("libtls.so", tlsSide, ambiguous, {
      memoryBase: loaded.memoryBase,
      tableBase: loaded.tableBase,
      tlsBase: 0,
    })).toThrow(/missing a valid side-module TLS base/);
  });

  it("restores an i64 TLS-base global for the 64-bit pointer contract", () => {
    const tlsSide = buildDylinkWat(`
      (module
        (import "env" "memory" (memory i64 1 100 shared))
        (import "env" "__memory_base" (global $memory_base i64))
        (global $tls_base (export "__tls_base") (mut i64) (i64.const 0))
        (global (export "__tls_size") i64 (i64.const 4))
        (global (export "__tls_align") i64 (i64.const 4))
        (func $init_tls (param $base i64)
          local.get $base
          global.set $tls_base
          local.get $base
          i32.const 17
          i32.store)
        (func $start
          global.get $memory_base
          i32.load
          i32.eqz
          if
            global.get $memory_base
            i32.const 2
            i32.store
            global.get $memory_base
            i64.const 8
            i64.add
            call $init_tls
          end)
        (start $start)
        (func (export "get_tls") (result i32)
          global.get $tls_base
          i32.load)
        (func (export "set_tls") (param $value i32)
          global.get $tls_base
          local.get $value
          i32.store))
    `, "replay-live-tls-i64", undefined, 0, 16, ["--enable-memory64"]);
    const memory64Options = (): LoadSharedLibraryOptions => ({
      memory: new WebAssembly.Memory({
        initial: 1n,
        maximum: 100n,
        shared: true,
        address: "i64",
      } as unknown as WebAssembly.MemoryDescriptor),
      table: new WebAssembly.Table({
        initial: 1n,
        element: "anyfunc",
        address: "i64",
      } as unknown as WebAssembly.TableDescriptor),
      stackPointer: new WebAssembly.Global({ value: "i64", mutable: true }, 65536n),
      heapPointer: { value: 1024 },
      globalSymbols: new Map(),
      got: new Map(),
      loadedLibraries: new Map(),
      ptrWidth: 8,
    });
    const parent = memory64Options();
    const loaded = loadSharedLibrarySync("libtls64.so", tlsSide, parent);
    (loaded.exports.set_tls as Function)(71);

    const child = memory64Options();
    new Uint8Array(child.memory.buffer).set(new Uint8Array(parent.memory.buffer));
    const replayed = loadSharedLibrarySync("libtls64.so", tlsSide, child, {
      memoryBase: loaded.memoryBase,
      tableBase: loaded.tableBase,
      tlsBase: loaded.tlsBase,
    });

    expect(replayed.tlsBase).toBe(loaded.tlsBase);
    expect((replayed.exports.__tls_base as WebAssembly.Global).value)
      .toBe(BigInt(loaded.tlsBase!));
    expect((replayed.exports.get_tls as Function)()).toBe(71);
  });

  it("rejects incomplete, immutable, and out-of-reservation TLS state", () => {
    const missingBase = buildDylinkWat(`
      (module
        (import "env" "memory" (memory 1 100 shared))
        (global (export "__tls_size") i32 (i32.const 4))
        (global (export "__tls_align") i32 (i32.const 4)))
    `, "tls-missing-base", undefined, 0, 16);
    expect(() => loadSharedLibrarySync(
      "libtls-missing-base.so",
      missingBase,
      createSideForkLoadOptions(),
    )).toThrow(/must export mutable __tls_base/);

    const immutableBase = buildDylinkWat(`
      (module
        (import "env" "memory" (memory 1 100 shared))
        (global (export "__tls_base") i32 (i32.const 1032))
        (global (export "__tls_size") i32 (i32.const 4))
        (global (export "__tls_align") i32 (i32.const 4)))
    `, "tls-immutable-base", undefined, 0, 16);
    expect(() => loadSharedLibrarySync(
      "libtls-immutable-base.so",
      immutableBase,
      createSideForkLoadOptions(),
    )).toThrow(/must be mutable/);

    const live = buildDylinkWat(`
      (module
        (import "env" "memory" (memory 1 100 shared))
        (import "env" "__memory_base" (global $memory_base i32))
        (global $tls_base (export "__tls_base") (mut i32) (i32.const 0))
        (global (export "__tls_size") i32 (i32.const 4))
        (global (export "__tls_align") i32 (i32.const 4))
        (func $start
          global.get $memory_base
          i32.const 8
          i32.add
          global.set $tls_base)
        (start $start))
    `, "tls-outside-reservation", undefined, 0, 16);
    const parent = createSideForkLoadOptions();
    const loaded = loadSharedLibrarySync("libtls-outside.so", live, parent);
    const child = createSideForkLoadOptions();
    new Uint8Array(child.memory.buffer).set(new Uint8Array(parent.memory.buffer));
    expect(() => loadSharedLibrarySync("libtls-outside.so", live, child, {
      memoryBase: loaded.memoryBase,
      tableBase: loaded.tableBase,
      tlsBase: loaded.memoryBase + 16,
    })).toThrow(/escapes module reservation/);
  });

  it("pads replay to the exact parent table base and rejects overshoot", () => {
    const wasmBytes = buildDylinkWat(`
      (module
        (import "env" "memory" (memory 1 100 shared))
        (func (export "value") (result i32) i32.const 9))
    `, "replay-table-base");
    const parent = createSideForkLoadOptions();
    parent.table.grow(4);
    const parentLib = loadSharedLibrarySync("liblayout.so", wasmBytes, parent);
    expect(parentLib.tableBase).toBe(5);

    const child = createSideForkLoadOptions();
    const childLib = loadSharedLibrarySync("liblayout.so", wasmBytes, child, {
      memoryBase: parentLib.memoryBase,
      tableBase: parentLib.tableBase,
    });
    expect(childLib.tableBase).toBe(parentLib.tableBase);
    expect(child.table.length).toBe(parent.table.length);

    const overshot = createSideForkLoadOptions();
    overshot.table.grow(parentLib.tableBase);
    expect(() => loadSharedLibrarySync("liblayout.so", wasmBytes, overshot, {
      memoryBase: parentLib.memoryBase,
      tableBase: parentLib.tableBase,
    })).toThrow(/past parent base/);
  });

  it("clears failed-load table entries and records the surviving gap", () => {
    const options = createSideForkLoadOptions();
    const deallocated: Array<{ addr: number; size: number }> = [];
    options.allocateMemory = () => 0x2000;
    options.deallocateMemory = (addr, size) => deallocated.push({ addr, size });
    const invalid = buildDylinkWat(`
      (module
        (import "env" "memory" (memory 1 100 shared))
        (import "env" "missing" (func $missing))
        (func (export "never") call $missing))
    `, "failed-table-growth", undefined, 2, 16);
    expect(() => loadSharedLibrarySync("libfailed.so", invalid, options)).toThrow();
    expect(options.table.length).toBe(3);
    expect(options.table.get(1)).toBeNull();
    expect(options.table.get(2)).toBeNull();
    expect(options.loadedLibraries.size).toBe(0);
    expect(deallocated).toEqual([{ addr: 0x2000, size: 16 }]);

    const valid = buildDylinkWat(`
      (module
        (import "env" "memory" (memory 1 100 shared))
        (func (export "survivor") (result i32) i32.const 1))
    `, "surviving-after-failure");
    const survivor = loadSharedLibrarySync("libsurvivor.so", valid, options);
    expect(survivor.tableBase).toBe(3);

    const child = createSideForkLoadOptions();
    const replayed = loadSharedLibrarySync("libsurvivor.so", valid, child, {
      memoryBase: survivor.memoryBase,
      tableBase: survivor.tableBase,
    });
    expect(replayed.tableBase).toBe(3);
    expect(child.table.length).toBe(options.table.length);
  });
});

describe.skipIf(!hasCompiler())("borrowed wasm-ld replay", () => {
  it("reconstructs passive-data state in shared Memory without writes", () => {
    const wasmBytes = buildSharedLib(
      `
      static int counter = 41;
      int get_counter(void) { return counter; }
      void inc_counter(void) { counter++; }
      `,
      "borrowed-standard-side",
    );
    const parentOptions = createSideForkLoadOptions();
    const parent = new DynamicLinker(parentOptions);
    expect(parent.dlopenSync("libborrowed-standard-side.so", wasmBytes)).toBe(2);
    const parentLibrary = parentOptions.loadedLibraries.get(
      "libborrowed-standard-side.so",
    )!;
    (parentLibrary.exports.inc_counter as () => void)();
    expect((parentLibrary.exports.get_counter as () => number)()).toBe(42);
    const archived = parent.forkState();
    const savedData = new Uint8Array(
      parentOptions.memory.buffer,
      parentLibrary.memoryBase,
      parentLibrary.metadata.memorySize,
    ).slice();

    const childOptions = createSideForkLoadOptions();
    childOptions.memory = parentOptions.memory;
    childOptions.allocateMemory = () => {
      throw new Error("borrowed side replay must not allocate process memory");
    };
    childOptions.deallocateMemory = () => {
      throw new Error("borrowed side replay must not release process memory");
    };
    const child = new DynamicLinker(childOptions);
    child.reconcileForkModules(archived, { memoryOwnership: "borrowed" });
    const childLibrary = childOptions.loadedLibraries.get(
      "libborrowed-standard-side.so",
    )!;

    expect((childLibrary.exports.get_counter as () => number)()).toBe(42);
    expect(new Uint8Array(
      parentOptions.memory.buffer,
      parentLibrary.memoryBase,
      parentLibrary.metadata.memorySize,
    )).toEqual(savedData);
    expect((parentLibrary.exports.get_counter as () => number)()).toBe(42);
  });
});

describe.skipIf(!hasCompiler())("DynamicLinker", () => {
  function createLinker(): DynamicLinker {
    const memory = new WebAssembly.Memory({ initial: 1, maximum: 100, shared: true });
    const table = new WebAssembly.Table({ initial: 1, element: "anyfunc" });
    const stackPointer = new WebAssembly.Global(
      { value: "i32", mutable: true },
      65536,
    );
    return new DynamicLinker({
      memory,
      table,
      stackPointer,
      heapPointer: { value: 1024 },
      globalSymbols: new Map(),
      got: new Map(),
      loadedLibraries: new Map(),
    });
  }

  it("dlopen + dlsym + dlclose lifecycle", () => {
    const linker = createLinker();
    const wasmBytes = buildSharedLib(
      `int triple(int x) { return x * 3; }`,
      "dl-lifecycle",
    );

    // dlopen
    const handle = linker.dlopenSync("libtriple.so", wasmBytes);
    expect(handle).toBeGreaterThan(0);
    expect(linker.dlerror()).toBeNull();

    // dlsym returns a table index for functions
    const tripleIdx = linker.dlsym(handle, "triple");
    expect(tripleIdx).not.toBeNull();
    expect(typeof tripleIdx).toBe("number");

    // dlclose
    expect(linker.dlclose(handle)).toBe(0);
  });

  it("lets libc drive initialization without a host-to-Wasm callback", () => {
    const memory = new WebAssembly.Memory({ initial: 1 });
    const table = new WebAssembly.Table({ initial: 1, element: "anyfunc" });
    const stackPointer = new WebAssembly.Global(
      { value: "i32", mutable: true },
      65536,
    );
    const linker = new DynamicLinker({
      memory,
      table,
      stackPointer,
      heapPointer: { value: 1024 },
      globalSymbols: new Map(),
      got: new Map(),
      loadedLibraries: new Map(),
    });
    const wasmBytes = buildDylinkWat(`
      (module
        (global $state (mut i32) (i32.const 0))
        (func (export "__wasm_apply_data_relocs")
          global.get $state
          i32.const 1
          i32.add
          global.set $state)
        (func (export "__wasm_call_ctors")
          global.get $state
          i32.const 10
          i32.add
          global.set $state)
        (func (export "initialization_state") (result i32)
          global.get $state))
    `, "process-driven-initialization");

    const token = linker.beginDlopenSync(
      "libprocess-driven-initialization.so",
      wasmBytes,
      false,
    );
    expect(token).toBeGreaterThan(0);

    const relocations = linker.nextDlopenInitialization(token);
    expect(relocations).toBeGreaterThan(0);
    expect(linker.forkState()).toMatchObject({
      libraries: [{ globalVisibility: false }],
      transactions: [{ token, globalVisibility: false }],
    });
    const relocationEntry = table.get(relocations);
    expect(typeof relocationEntry).toBe("function");
    (relocationEntry as () => void)();

    const constructors = linker.nextDlopenInitialization(token);
    expect(constructors).toBe(relocations);
    const constructorEntry = table.get(constructors);
    expect(typeof constructorEntry).toBe("function");
    (constructorEntry as () => void)();

    expect(linker.nextDlopenInitialization(token)).toBe(0);
    expect(table.get(relocations)).toBeNull();
    const handle = linker.commitDlopenSync(token);
    expect(handle).toBeGreaterThan(0);
    const stateIndex = linker.dlsym(handle, "initialization_state");
    expect(stateIndex).not.toBeNull();
    expect((table.get(stateIndex!) as () => number)()).toBe(11);
    expect(linker.dlsym(0, "initialization_state")).toBeNull();
  });

  it("reconstructs an issued initialization entry in a fresh instance", () => {
    const wasmBytes = buildDylinkWat(`
      (module
        (import "env" "memory" (memory 1))
        (func (export "__wasm_apply_data_relocs")
          i32.const 32
          i32.const 32
          i32.load
          i32.const 1
          i32.add
          i32.store)
        (func (export "__wasm_call_ctors")
          i32.const 32
          i32.const 32
          i32.load
          i32.const 10
          i32.add
          i32.store)
        (func (export "initialization_state") (result i32)
          i32.const 32
          i32.load))
    `, "fresh-process-driven-initialization");
    const parentMemory = new WebAssembly.Memory({ initial: 1 });
    const parentTable = new WebAssembly.Table({ initial: 1, element: "anyfunc" });
    const parent = new DynamicLinker({
      memory: parentMemory,
      table: parentTable,
      stackPointer: new WebAssembly.Global(
        { value: "i32", mutable: true },
        65536,
      ),
      heapPointer: { value: 1024 },
      globalSymbols: new Map(),
      got: new Map(),
      loadedLibraries: new Map(),
    });
    const token = parent.beginDlopenSync(
      "libfresh-process-driven.so",
      wasmBytes,
      false,
    );
    const relocations = parent.nextDlopenInitialization(token);
    (parentTable.get(relocations) as () => void)();
    const constructors = parent.nextDlopenInitialization(token);
    expect(constructors).toBe(relocations);
    const archived = parent.forkState();
    expect(archived.transactions).toHaveLength(1);
    expect(archived.transactions![0]).toMatchObject({
      globalVisibility: false,
    });
    expect(archived.libraries[0]!.initialization).toMatchObject({
      transactionToken: token,
      stage: "constructors",
      tableIndex: constructors,
    });

    const childMemory = new WebAssembly.Memory({ initial: 1 });
    new Uint8Array(childMemory.buffer).set(
      new Uint8Array(parentMemory.buffer),
    );
    const childTable = new WebAssembly.Table({ initial: 1, element: "anyfunc" });
    const child = new DynamicLinker({
      memory: childMemory,
      table: childTable,
      stackPointer: new WebAssembly.Global(
        { value: "i32", mutable: true },
        65536,
      ),
      heapPointer: { value: 1024 },
      globalSymbols: new Map(),
      got: new Map(),
      loadedLibraries: new Map(),
    });
    child.reconcileForkModules(archived);
    child.reconcileForkHandleState(archived);

    const childConstructor = childTable.get(constructors);
    expect(typeof childConstructor).toBe("function");
    (childConstructor as () => void)();
    expect(child.nextDlopenInitialization(token)).toBe(0);
    const handle = child.commitDlopenSync(token);
    expect(handle).toBe(2);
    const stateIndex = child.dlsym(handle, "initialization_state");
    expect(stateIndex).not.toBeNull();
    expect((childTable.get(stateIndex!) as () => number)()).toBe(11);
    expect(child.dlsym(0, "initialization_state")).toBeNull();
  });

  it("archives constructor dlsym ownership across a fresh staged replay", () => {
    const providerBytes = buildDylinkWat(`
      (module
        (func (export "runtime_provider") (result i32) i32.const 61))
    `, "fresh-constructor-provider");
    const consumerBytes = buildDylinkWat(`
      (module
        (import "env" "lookup_provider"
          (func $lookup_provider (result i32)))
        (func (export "__wasm_call_ctors")
          call $lookup_provider
          drop)
        (func (export "consumer_value") (result i32) i32.const 17))
    `, "fresh-constructor-provider-consumer");
    const parentOptions = createSideForkLoadOptions();
    let parent!: DynamicLinker;
    let providerHandle = 0;
    parentOptions.globalSymbols.set("lookup_provider", () => {
      return parent.dlsym(providerHandle, "runtime_provider") ?? 0;
    });
    parent = new DynamicLinker(parentOptions);
    providerHandle = parent.dlopenSync(
      "libconstructor-provider.so",
      providerBytes,
    );
    const token = parent.beginDlopenSync(
      "libconstructor-consumer.so",
      consumerBytes,
    );
    const constructor = parent.nextDlopenInitialization(token);
    (parentOptions.table.get(constructor) as () => void)();
    const archived = parent.forkState();
    expect(
      archived.libraries.find(
        (library) => library.name === "libconstructor-consumer.so",
      )?.providerDependencies,
    ).toEqual(["libconstructor-provider.so"]);

    const childOptions = createSideForkLoadOptions();
    childOptions.globalSymbols.set("lookup_provider", () => 0);
    const child = new DynamicLinker(childOptions);
    child.reconcileForkModules(archived);
    child.reconcileForkHandleState(archived);
    expect(child.nextDlopenInitialization(token)).toBe(0);
    const consumerHandle = child.commitDlopenSync(token);
    expect(consumerHandle).toBe(3);

    expect(child.dlclose(providerHandle)).toBe(0);
    expect(
      childOptions.loadedLibraries.has("libconstructor-provider.so"),
    ).toBe(true);
    expect(child.dlclose(consumerHandle)).toBe(0);
    expect(Array.from(childOptions.loadedLibraries.keys())).toEqual([]);
  });

  it("reconciles staged initializer generations without repeating guest calls", () => {
    const wasmBytes = buildDylinkWat(`
      (module
        (import "env" "memory" (memory 1))
        (func (export "__wasm_apply_data_relocs")
          i32.const 32
          i32.const 32
          i32.load
          i32.const 1
          i32.add
          i32.store)
        (func (export "__wasm_call_ctors")
          i32.const 32
          i32.const 32
          i32.load
          i32.const 10
          i32.add
          i32.store)
        (func (export "initialization_state") (result i32)
          i32.const 32
          i32.load))
    `, "replicated-process-driven-initialization");
    const memory = new WebAssembly.Memory({ initial: 1 });
    const parentTable = new WebAssembly.Table({ initial: 1, element: "anyfunc" });
    const replicaTable = new WebAssembly.Table({ initial: 1, element: "anyfunc" });
    const makeLinker = (table: WebAssembly.Table): DynamicLinker =>
      new DynamicLinker({
        memory,
        table,
        stackPointer: new WebAssembly.Global(
          { value: "i32", mutable: true },
          65536,
        ),
        heapPointer: { value: 1024 },
        globalSymbols: new Map(),
        got: new Map(),
        loadedLibraries: new Map(),
      });
    const parent = makeLinker(parentTable);
    const replica = makeLinker(replicaTable);

    const token = parent.beginDlopenSync("libreplicated-stages.so", wasmBytes);
    const relocations = parent.nextDlopenInitialization(token);
    const relocationState = parent.forkState();
    replica.reconcileForkModules(relocationState);
    replica.reconcileForkHandleState(relocationState);
    expect(typeof replicaTable.get(relocations)).toBe("function");

    (parentTable.get(relocations) as () => void)();
    const constructors = parent.nextDlopenInitialization(token);
    expect(constructors).toBe(relocations);
    const constructorState = parent.forkState();
    replica.reconcileForkModules(constructorState);
    replica.reconcileForkHandleState(constructorState);
    expect(typeof replicaTable.get(constructors)).toBe("function");
    // Only the source Worker called the relocation entry.
    expect(new DataView(memory.buffer).getInt32(32, true)).toBe(1);

    (parentTable.get(constructors) as () => void)();
    expect(parent.nextDlopenInitialization(token)).toBe(0);
    expect(parent.commitDlopenSync(token)).toBe(2);
    const committedState = parent.forkState();
    replica.reconcileForkModules(committedState);
    replica.reconcileForkHandleState(committedState);
    expect(replicaTable.get(constructors)).toBeNull();
    expect(new DataView(memory.buffer).getInt32(32, true)).toBe(11);
    const stateIndex = replica.dlsym(2, "initialization_state");
    expect(stateIndex).not.toBeNull();
    expect((replicaTable.get(stateIndex!) as () => number)()).toBe(11);
  });

  it("retires a replicated staged initializer after authoritative rollback", () => {
    const wasmBytes = buildDylinkWat(`
      (module
        (func (export "__wasm_call_ctors"))
      )
    `, "replicated-process-driven-rollback");
    const makeLinker = (): {
      readonly linker: DynamicLinker;
      readonly table: WebAssembly.Table;
    } => {
      const table = new WebAssembly.Table({ initial: 1, element: "anyfunc" });
      return {
        table,
        linker: new DynamicLinker({
          memory: new WebAssembly.Memory({ initial: 1 }),
          table,
          stackPointer: new WebAssembly.Global(
            { value: "i32", mutable: true },
            65536,
          ),
          heapPointer: { value: 1024 },
          globalSymbols: new Map(),
          got: new Map(),
          loadedLibraries: new Map(),
        }),
      };
    };
    const parent = makeLinker();
    const replica = makeLinker();
    const token = parent.linker.beginDlopenSync(
      "libreplicated-rollback.so",
      wasmBytes,
    );
    const constructors = parent.linker.nextDlopenInitialization(token);
    const issuedState = parent.linker.forkState();
    replica.linker.reconcileForkModules(issuedState);
    replica.linker.reconcileForkHandleState(issuedState);
    expect(typeof replica.table.get(constructors)).toBe("function");

    parent.linker.abortDlopenTransaction(token, new Error("constructor failed"));
    const rolledBackState = parent.linker.forkState();
    replica.linker.reconcileForkModules(rolledBackState);
    replica.linker.reconcileForkHandleState(rolledBackState);
    expect(replica.table.get(constructors)).toBeNull();
    expect(rolledBackState.libraries).toHaveLength(0);
  });

  it("rolls back completed NEEDED objects when the staged root fails", () => {
    const dependencyBytes = buildDylinkWat(`
      (module
        (func (export "__wasm_call_ctors"))
        (func (export "dependency_value") (result i32) i32.const 7)
      )
    `, "staged-needed-rollback-dependency");
    const rootBytes = buildDylinkWat(`
      (module
        (import "env" "missing_root_symbol" (func))
      )
    `, "staged-needed-rollback-root", undefined, 0, 0, [], [], null, [
      "libstaged-needed-dependency.so",
    ]);
    const options = createSideForkLoadOptions();
    options.resolveLibrarySync = (name) =>
      name === "libstaged-needed-dependency.so" ? dependencyBytes : null;
    const linker = new DynamicLinker(options);
    const token = linker.beginDlopenSync("libstaged-needed-root.so", rootBytes);
    const dependencyConstructor = linker.nextDlopenInitialization(token);
    expect(dependencyConstructor).toBeGreaterThan(0);
    (options.table.get(dependencyConstructor) as () => void)();

    expect(linker.nextDlopenInitialization(token)).toBe(-1);
    expect(options.loadedLibraries.size).toBe(0);
    expect(linker.forkState()).toMatchObject({
      nextHandle: 2,
      libraries: [],
    });
    expect(options.table.get(dependencyConstructor)).toBeNull();
  });

  it("preserves an independently committed constructor-nested load", () => {
    const nestedBytes = buildDylinkWat(`
      (module
        (func (export "nested_value") (result i32) i32.const 19)
      )
    `, "staged-independent-nested");
    const outerBytes = buildDylinkWat(`
      (module
        (import "env" "nested_open" (func $nested_open))
        (func (export "__wasm_call_ctors")
          call $nested_open
          unreachable)
      )
    `, "staged-failing-outer-independent");
    const options = createSideForkLoadOptions();
    let linker!: DynamicLinker;
    let nestedHandle = 0;
    options.globalSymbols.set("nested_open", () => {
      const token = linker.beginDlopenSync(
        "libindependent-nested.so",
        nestedBytes,
      );
      const result = linker.advanceDlopenSync(token);
      expect(result.entry).toBe(0);
      nestedHandle = result.handle;
    });
    linker = new DynamicLinker(options);

    const outerToken = linker.beginDlopenSync(
      "libfailing-outer-independent.so",
      outerBytes,
    );
    const constructor = linker.nextDlopenInitialization(outerToken);
    let failure: unknown;
    try {
      (options.table.get(constructor) as () => void)();
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(WebAssembly.RuntimeError);
    linker.abortDlopenTransaction(outerToken, failure);

    expect(nestedHandle).toBe(2);
    expect(Array.from(options.loadedLibraries.keys())).toEqual([
      "libindependent-nested.so",
    ]);
    const nestedValue = linker.dlsym(nestedHandle, "nested_value");
    expect(nestedValue).not.toBeNull();
    expect((options.table.get(nestedValue!) as () => number)()).toBe(19);
  });

  it("preserves an independently committed nested GLOBAL promotion", () => {
    const localBytes = buildDylinkWat(`
      (module
        (func (export "promoted_value") (result i32) i32.const 31)
      )
    `, "staged-independent-promotion");
    const outerBytes = buildDylinkWat(`
      (module
        (import "env" "nested_promote" (func $nested_promote))
        (func (export "__wasm_call_ctors")
          call $nested_promote
          unreachable)
      )
    `, "staged-failing-outer-promotion");
    const options = createSideForkLoadOptions();
    let linker!: DynamicLinker;
    let promotedHandle = 0;
    options.globalSymbols.set("nested_promote", () => {
      const token = linker.beginDlopenSync(
        "libpromoted-local.so",
        localBytes,
        true,
      );
      const result = linker.advanceDlopenSync(token);
      expect(result.entry).toBe(0);
      promotedHandle = result.handle;
    });
    linker = new DynamicLinker(options);
    const localHandle = linker.dlopenSync(
      "libpromoted-local.so",
      localBytes,
      undefined,
      false,
    );
    expect(localHandle).toBeGreaterThan(0);
    expect(linker.dlsym(0, "promoted_value")).toBeNull();

    const outerToken = linker.beginDlopenSync(
      "libfailing-outer-promotion.so",
      outerBytes,
    );
    const constructor = linker.nextDlopenInitialization(outerToken);
    let failure: unknown;
    try {
      (options.table.get(constructor) as () => void)();
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(WebAssembly.RuntimeError);
    linker.abortDlopenTransaction(outerToken, failure);

    expect(promotedHandle).toBe(localHandle);
    const promoted = options.loadedLibraries.get("libpromoted-local.so")!;
    expect(promoted.globalVisibility).toBe(true);
    expect(promoted.committedGlobalRoot).toBe(true);
    expect(linker.forkLibraryState("libpromoted-local.so")).toMatchObject({
      globalVisibility: true,
      committedGlobalRoot: true,
      handle: localHandle,
      refCount: 2,
    });
    const value = linker.dlsym(0, "promoted_value");
    expect(value).not.toBeNull();
    expect((options.table.get(value!) as () => number)()).toBe(31);
  });

  it("cascades rollback into a constructor-nested load bound to the outer", () => {
    const nestedBytes = buildDylinkWat(`
      (module
        (import "env" "outer_value" (func $outer_value (result i32)))
        (func (export "nested_value") (result i32) call $outer_value)
      )
    `, "staged-dependent-nested");
    const outerBytes = buildDylinkWat(`
      (module
        (import "env" "nested_open" (func $nested_open))
        (func (export "outer_value") (result i32) i32.const 23)
        (func (export "__wasm_call_ctors")
          call $nested_open
          unreachable)
      )
    `, "staged-failing-outer-dependent");
    const options = createSideForkLoadOptions();
    let linker!: DynamicLinker;
    let nestedHandle = 0;
    options.globalSymbols.set("nested_open", () => {
      const token = linker.beginDlopenSync(
        "libdependent-nested.so",
        nestedBytes,
      );
      const result = linker.advanceDlopenSync(token);
      expect(result.entry).toBe(0);
      nestedHandle = result.handle;
    });
    linker = new DynamicLinker(options);

    const outerToken = linker.beginDlopenSync(
      "libfailing-outer-dependent.so",
      outerBytes,
    );
    const constructor = linker.nextDlopenInitialization(outerToken);
    let failure: unknown;
    try {
      (options.table.get(constructor) as () => void)();
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(WebAssembly.RuntimeError);
    linker.abortDlopenTransaction(outerToken, failure);

    expect(nestedHandle).toBe(2);
    expect(options.loadedLibraries.size).toBe(0);
    expect(linker.dlsym(nestedHandle, "nested_value")).toBeNull();
    expect(linker.dlerror()).toBe("invalid handle");
  });

  it("reserves a stable handle for the main program symbol scope", () => {
    const memory = new WebAssembly.Memory({ initial: 1, maximum: 100, shared: true });
    const table = new WebAssembly.Table({ initial: 1, element: "anyfunc" });
    const stackPointer = new WebAssembly.Global(
      { value: "i32", mutable: true },
      65536,
    );
    const mainData = new WebAssembly.Global({ value: "i32", mutable: false }, 0x2340);
    const linker = new DynamicLinker({
      memory,
      table,
      stackPointer,
      heapPointer: { value: 1024 },
      globalSymbols: new Map([["main_data", mainData]]),
      got: new Map(),
      loadedLibraries: new Map(),
    });

    const handle = linker.dlopenMain();
    expect(handle).toBeGreaterThan(0);
    expect(linker.dlopenMain()).toBe(handle);
    expect(linker.dlsym(handle, "main_data")).toBe(0x2340);
    expect(linker.dlsym(0, "main_data")).toBe(0x2340);
    expect(linker.dlclose(handle)).toBe(0);
    expect(linker.dlerror()).toBeNull();
  });

  it("uses the supplied allocator for side-module memory", () => {
    const memory = new WebAssembly.Memory({ initial: 1, maximum: 100, shared: true });
    const table = new WebAssembly.Table({ initial: 1, element: "anyfunc" });
    const stackPointer = new WebAssembly.Global(
      { value: "i32", mutable: true },
      65536,
    );
    let allocSize = 0;
    let allocAlign = 0;
    const linker = new DynamicLinker({
      memory,
      table,
      stackPointer,
      allocateMemory: (size, align) => {
        allocSize = size;
        allocAlign = align;
        return 0x2000;
      },
      globalSymbols: new Map(),
      got: new Map(),
      loadedLibraries: new Map(),
    });
    const wasmBytes = buildSharedLib(
      `
      int value = 7;
      int get_value(void) { return value; }
      `,
      "dl-allocator",
    );

    const handle = linker.dlopenSync("liballoc.so", wasmBytes);
    expect(handle).toBeGreaterThan(0);
    expect(allocSize).toBeGreaterThan(0);
    expect(allocAlign).toBeGreaterThan(0);
  });

  it("adopts copied mmap ownership and releases it on child dlclose", () => {
    const wasmBytes = buildSharedLib(
      `
      int value = 7;
      int get_value(void) { return value; }
      `,
      "dl-fork-allocation-owner",
    );
    const parentMemory = new WebAssembly.Memory({
      initial: 2,
      maximum: 100,
      shared: true,
    });
    const parentTable = new WebAssembly.Table({ initial: 1, element: "anyfunc" });
    const parentAllocations = new Map<
      number,
      { mappingAddress: number; mappingSize: number }
    >();
    const parent = new DynamicLinker({
      memory: parentMemory,
      table: parentTable,
      stackPointer: new WebAssembly.Global(
        { value: "i32", mutable: true },
        65536,
      ),
      allocateMemory: (size) => {
        const address = 0x3000;
        parentAllocations.set(address, {
          mappingAddress: 0x2ff0,
          mappingSize: size + 31,
        });
        return address;
      },
      describeMemoryAllocation: (address) => parentAllocations.get(address)!,
      deallocateMemory: () => {},
      globalSymbols: new Map(),
      got: new Map(),
      loadedLibraries: new Map(),
    });
    const handle = parent.dlopenSync("libfork-allocation.so", wasmBytes);
    expect(handle).toBeGreaterThan(0);
    const forkState = parent.forkState();
    expect(forkState.libraries[0]?.allocations).toEqual([{
      address: 0x3000,
      size: expect.any(Number),
      mappingAddress: 0x2ff0,
      mappingSize: expect.any(Number),
    }]);

    const childMemory = new WebAssembly.Memory({
      initial: 2,
      maximum: 100,
      shared: true,
    });
    new Uint8Array(childMemory.buffer).set(
      new Uint8Array(parentMemory.buffer),
    );
    const adopted = new Map<
      number,
      { mappingAddress: number; mappingSize: number }
    >();
    const released: Array<{
      address: number;
      mappingAddress: number;
      mappingSize: number;
    }> = [];
    const child = new DynamicLinker({
      memory: childMemory,
      table: new WebAssembly.Table({ initial: 1, element: "anyfunc" }),
      stackPointer: new WebAssembly.Global(
        { value: "i32", mutable: true },
        65536,
      ),
      adoptMemoryAllocation: (allocation) => {
        adopted.set(allocation.address, {
          mappingAddress: allocation.mappingAddress,
          mappingSize: allocation.mappingSize,
        });
      },
      deallocateMemory: (address) => {
        const mapping = adopted.get(address);
        if (!mapping) throw new Error("missing adopted mmap owner");
        released.push({ address, ...mapping });
        adopted.delete(address);
      },
      globalSymbols: new Map(),
      got: new Map(),
      loadedLibraries: new Map(),
    });
    child.reconcileForkModules(forkState);
    child.reconcileForkHandleState(forkState);
    expect(adopted.get(0x3000)).toEqual({
      mappingAddress: 0x2ff0,
      mappingSize: forkState.libraries[0]!.allocations![0]!.mappingSize,
    });
    expect(child.dlclose(handle)).toBe(0);
    expect(released).toEqual([{
      address: 0x3000,
      mappingAddress: 0x2ff0,
      mappingSize: forkState.libraries[0]!.allocations![0]!.mappingSize,
    }]);
    expect(adopted.size).toBe(0);
  });

  it("dlerror reports failures", () => {
    const linker = createLinker();

    // Invalid Wasm bytes
    const handle = linker.dlopenSync("bad.so", new Uint8Array([1, 2, 3]));
    expect(handle).toBe(0);
    expect(linker.dlerror()).not.toBeNull();

    // dlerror clears after read
    expect(linker.dlerror()).toBeNull();
  });

  it("dlsym for non-existent symbol returns null", () => {
    const linker = createLinker();
    const wasmBytes = buildSharedLib(
      `int foo(void) { return 1; }`,
      "dl-nosym",
    );

    const handle = linker.dlopenSync("libfoo.so", wasmBytes);
    expect(handle).toBeGreaterThan(0);

    expect(linker.dlsym(handle, "nonexistent")).toBeNull();
    expect(linker.dlerror()).toContain("not found");
  });

  it("deduplicates handles for the same library", () => {
    const linker = createLinker();
    const wasmBytes = buildSharedLib(
      `int bar(void) { return 2; }`,
      "dl-dedup",
    );

    const h1 = linker.dlopenSync("libbar.so", wasmBytes);
    const h2 = linker.dlopenSync("libbar.so", wasmBytes);
    expect(h1).toBe(h2);
  });
});

function hasWat2Wasm(): boolean {
  try {
    execFileSync("wat2wasm", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

// A minimal dylink.0 section (MEM_INFO: mem/table size + align all 0), which
// marks a module as a side module. wat2wasm emits custom sections last, but the
// loader requires dylink.0 first, so it is injected as raw bytes below rather
// than declared in the WAT.
const DYLINK_SECTION = new Uint8Array([
  0x00, 0x0f,                                            // custom section, size 15
  0x08, 0x64, 0x79, 0x6c, 0x69, 0x6e, 0x6b, 0x2e, 0x30, // name "dylink.0"
  0x01, 0x04, 0x00, 0x00, 0x00, 0x00,                   // MEM_INFO subsection
]);

/**
 * Assemble a hand-written side module. Using WAT (rather than a compiled C/C++
 * fixture) lets these tests reproduce the exact import shapes a real C++ side
 * module produces — a self-defined symbol that is *also* an env import, and an
 * env.__cpp_exception tag — which no self-contained C fixture can emit.
 */
function assembleSideModule(wat: string, name: string): Uint8Array {
  const dir = join(tmpdir(), "wasm-dylink-test");
  mkdirSync(dir, { recursive: true });
  const watPath = join(dir, `${name}.wat`);
  const wasmPath = join(dir, `${name}.wasm`);
  writeFileSync(watPath, wat);
  execFileSync("wat2wasm", ["--enable-exceptions", watPath, "-o", wasmPath],
    { stdio: "pipe" });
  const raw = new Uint8Array(readFileSync(wasmPath));
  const out = new Uint8Array(8 + DYLINK_SECTION.length + (raw.length - 8));
  out.set(raw.subarray(0, 8), 0);                          // magic + version
  out.set(DYLINK_SECTION, 8);                              // dylink.0 first
  out.set(raw.subarray(8), 8 + DYLINK_SECTION.length);
  return out;
}

describe.skipIf(!hasWat2Wasm())("weak self-import handling", () => {
  function createLoadOptions(): LoadSharedLibraryOptions {
    return {
      memory: new WebAssembly.Memory({ initial: 1, maximum: 100, shared: true }),
      table: new WebAssembly.Table({ initial: 1, element: "anyfunc" }),
      stackPointer: new WebAssembly.Global({ value: "i32", mutable: true }, 65536),
      heapPointer: { value: 1024 },
      globalSymbols: new Map(),
      got: new Map(),
      loadedLibraries: new Map(),
    };
  }

  it("routes an unresolved env import to the module's own export", () => {
    // `self_fn` is both imported from env and exported: the shape wasm-ld emits
    // for an interposable weak C++ symbol the module also defines.
    const lib = loadSharedLibrarySync("self-import.so", assembleSideModule(`
      (module
        (import "env" "self_fn" (func $self_fn (result i32)))
        (func (export "self_fn") (result i32) (i32.const 42))
        (func (export "call_self") (result i32) (call $self_fn)))
    `, "self-import"), createLoadOptions());
    expect((lib.exports.call_self as Function)()).toBe(42);
  });

  it("rejects a genuinely absent env import during instantiation", () => {
    // Only an import that the side module itself exports gets a trampoline.
    // A real ABI gap must remain an eager load failure rather than hiding on
    // an unexecuted path behind a delayed stub.
    expect(() => loadSharedLibrarySync(
      "missing-import.so",
      assembleSideModule(`
        (module
          (import "env" "missing_fn" (func $missing (result i32)))
          (func (export "call_missing") (result i32) (call $missing)))
      `, "missing-import"),
      createLoadOptions(),
    )).toThrow();
  });

  it("does not mistake an imported-function re-export for a definition", () => {
    // A same-name export can point straight back at the imported function.
    // Treating that shape as a definition would recurse forever through the
    // host trampoline instead of rejecting the unresolved import at dlopen.
    expect(() => loadSharedLibrarySync(
      "reexported-import.so",
      assembleSideModule(`
        (module
          (import "env" "reexported_fn" (func $reexported (result i32)))
          (export "reexported_fn" (func $reexported))
          (func (export "call_reexported") (result i32) (call $reexported)))
      `, "reexported-import"),
      createLoadOptions(),
    )).toThrow();
  });

  it("provides the __cpp_exception tag to -fwasm-exceptions modules", () => {
    // C++ side modules import this i32-payload tag. Exercise an actual
    // throw/catch so both the supplied signature and engine behavior are
    // covered, not merely WebAssembly.Instance's value-type check.
    const lib = loadSharedLibrarySync("tag.so", assembleSideModule(`
      (module
        (import "env" "__cpp_exception" (tag $exc (param i32)))
        (func (export "throw_and_catch") (result i32)
          (try (result i32)
            (do
              (throw $exc (i32.const 42)))
            (catch $exc))))
    `, "tag"), createLoadOptions());
    expect((lib.exports.throw_and_catch as Function)()).toBe(42);
  });
});
