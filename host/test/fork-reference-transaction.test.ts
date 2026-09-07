import { describe, expect, it } from "vitest";
import { ForkFunctionCatalog } from "../src/fork-function-catalog";
import {
  ForkReferenceTransaction,
  type ForkExternrefRecipeProvider,
} from "../src/fork-reference-transaction";
import {
  ForkModuleStateArena,
  type ForkModuleStateRecord,
} from "../src/fork-module-state";

// Minimal Wasm module exporting one zero-arg function `f`, used to mint
// distinct WebAssembly function identities for `encodeFuncref` fixtures.
const MINIMAL_WASM_FUNCTION_BYTES = Uint8Array.from([
  0, 97, 115, 109, 1, 0, 0, 0,
  1, 4, 1, 96, 0, 0,
  3, 2, 1, 0,
  7, 5, 1, 1, 102, 0, 0,
  10, 4, 1, 2, 0, 11,
]);

function makeWasmFunction(): CallableFunction {
  return new WebAssembly.Instance(
    new WebAssembly.Module(MINIMAL_WASM_FUNCTION_BYTES),
  ).exports.f as CallableFunction;
}

function makeFunctionCatalog(
  moduleActivation: number,
  functions: readonly CallableFunction[],
): ForkFunctionCatalog {
  const table = new WebAssembly.Table({
    element: "anyfunc",
    initial: functions.length,
    maximum: functions.length,
  });
  functions.forEach((fn, index) => table.set(index, fn));
  const catalog = new ForkFunctionCatalog();
  catalog.register(moduleActivation, table);
  return catalog;
}

function makeExternrefs(): {
  provider: ForkExternrefRecipeProvider;
  values: Map<number, unknown>;
} {
  let next = 1;
  const values = new Map<number, unknown>();
  const handles = new WeakMap<object, number>();
  const provider: ForkExternrefRecipeProvider = {
    capture(value) {
      if ((typeof value === "object" && value !== null) || typeof value === "function") {
        const known = handles.get(value as object);
        if (known) return known;
        const handle = next++;
        handles.set(value as object, handle);
        values.set(handle, value);
        return handle;
      }
      const handle = next++;
      values.set(handle, value);
      return handle;
    },
    materialize(handle) {
      if (!values.has(handle)) throw new Error(`missing handle ${handle}`);
      return values.get(handle);
    },
    tryEncode(value) {
      if ((typeof value !== "object" || value === null) && typeof value !== "function") {
        return undefined;
      }
      return handles.get(value as object);
    },
  };
  return { provider, values };
}

function withArena(
  run: (arena: ForkModuleStateArena) => void,
): ForkModuleStateRecord[] {
  const memory = new WebAssembly.Memory({ initial: 16 });
  let next = 0x1_0000;
  const arena = new ForkModuleStateArena(
    memory,
    4,
    (size) => {
      const addr = next;
      next += Number(size);
      return addr;
    },
    () => {},
    "reference transaction test",
  );
  arena.begin();
  arena.appendModule({
    activationId: 0,
    templateId: new Uint8Array(32),
  });
  run(arena);
  arena.seal();
  return arena.records();
}

describe("ForkReferenceTransaction", () => {
  it("returns original identities in the parent and fresh catalog identities in the child", () => {
    const parentFunction = makeWasmFunction();
    const childFunction = makeWasmFunction();
    const parent = new ForkReferenceTransaction(
      makeFunctionCatalog(0, [parentFunction]),
      makeExternrefs().provider,
    );
    parent.beginCapture();
    const functionId = parent.encodeFuncref(parentFunction);

    const records = withArena((arena) => parent.sealInto(arena));
    parent.beginParentReplay();
    expect(parent.decodeFuncref(functionId)).toBe(parentFunction);
    parent.finishReplay();

    const child = new ForkReferenceTransaction(
      makeFunctionCatalog(0, [childFunction]),
      makeExternrefs().provider,
    );
    child.attachChild(records);
    expect(child.decodeFuncref(functionId)).toBe(childFunction);
    expect(child.decodeFuncref(functionId)).not.toBe(parentFunction);
    child.finishReplay();
  });

  it("round-trips compact call-specific recipe vectors with O(1) lookup", () => {
    const firstFn = makeWasmFunction();
    const secondFn = makeWasmFunction();
    const parent = new ForkReferenceTransaction(
      makeFunctionCatalog(0, [firstFn, secondFn]),
      makeExternrefs().provider,
    );
    parent.beginCapture();
    const first = parent.encodeFuncref(firstFn);
    const second = parent.encodeFuncref(secondFn);
    const builder = parent.beginReferenceVector(2);
    expect(builder).toBe(1);
    parent.appendReferenceVector(builder, first);
    parent.appendReferenceVector(builder, second);
    const vector = parent.finishReferenceVector(builder);
    expect(vector).toBe(1);
    const duplicateBuilder = parent.beginReferenceVector(2);
    // Completed builder handles are reused, while the frame-visible result is
    // the canonical content ordinal.
    expect(duplicateBuilder).toBe(builder);
    parent.appendReferenceVector(duplicateBuilder, first);
    parent.appendReferenceVector(duplicateBuilder, second);
    expect(parent.finishReferenceVector(duplicateBuilder)).toBe(vector);
    const records = withArena((arena) => parent.sealInto(arena));
    parent.beginParentReplay();
    expect(parent.getReferenceVector(vector, 0)).toBe(first);
    expect(parent.getReferenceVector(vector, 1)).toBe(second);

    const child = new ForkReferenceTransaction(
      makeFunctionCatalog(0, []),
      makeExternrefs().provider,
    );
    child.attachChild(records);
    expect((child as unknown as {
      decodedReferenceVectors: Array<readonly number[]>;
    }).decodedReferenceVectors).toHaveLength(2);
    expect(child.getReferenceVector(vector, 0)).toBe(first);
    expect(child.getReferenceVector(vector, 1)).toBe(second);
    expect(() => child.getReferenceVector(vector, 2)).toThrow(/out of bounds/);
    child.finishReplay();
    parent.finishReplay();
  });

  it("does not seal a partially appended reference vector", () => {
    const fn = makeWasmFunction();
    const transaction = new ForkReferenceTransaction(
      makeFunctionCatalog(0, [fn]),
      makeExternrefs().provider,
    );
    transaction.beginCapture();
    const recipe = transaction.encodeFuncref(fn);
    const builder = transaction.beginReferenceVector(2);
    transaction.appendReferenceVector(builder, recipe);
    expect(() => transaction.finishReferenceVector(builder)).toThrow(
      /expected 2/,
    );
    expect(() => withArena((arena) => transaction.sealInto(arena))).toThrow(
      /unfinished reference vector/,
    );
    transaction.abort();
  });

  it("drops strong temporary roots after abort", () => {
    const reused = makeWasmFunction();
    const transaction = new ForkReferenceTransaction(
      makeFunctionCatalog(0, [reused]),
      makeExternrefs().provider,
    );
    transaction.beginCapture();
    transaction.encodeFuncref(reused);
    transaction.abort();
    transaction.beginCapture();
    expect(transaction.encodeFuncref(reused)).toBe(1);
    transaction.abort();
  });

  it("owns reentrant shared-memory scratch with LIFO release and zeroing", () => {
    const memory = new WebAssembly.Memory({ initial: 8 });
    let next = 0x1_0000;
    const released: Array<[number, number]> = [];
    const transaction = new ForkReferenceTransaction(
      makeFunctionCatalog(0, []),
      makeExternrefs().provider,
      memory,
      (size) => {
        const addr = next;
        next += size;
        return addr;
      },
      (addr, size) => released.push([addr, size]),
      "scratch test",
    );
    transaction.beginCapture();
    const outer = transaction.reserveScratch(24);
    const inner = transaction.reserveScratch(32);
    expect(inner).toBe(outer + 32);
    new Uint8Array(memory.buffer, outer, 24).fill(0xaa);
    new Uint8Array(memory.buffer, inner, 32).fill(0xbb);

    expect(() => transaction.releaseScratch(outer, 24)).toThrow(
      /most recent reservation/,
    );
    transaction.releaseScratch(inner, 32);
    expect(new Uint8Array(memory.buffer, inner, 32)).toEqual(new Uint8Array(32));
    transaction.releaseScratch(outer, 24);
    expect(new Uint8Array(memory.buffer, outer, 32)).toEqual(new Uint8Array(32));

    // The common page remains transaction-owned for reuse, then is cleared
    // and returned exactly once on abort.
    expect(transaction.reserveScratch(16)).toBe(outer);
    new Uint8Array(memory.buffer, outer, 16).fill(0xcc);
    transaction.abort();
    expect(new Uint8Array(memory.buffer, outer, 16)).toEqual(new Uint8Array(16));
    expect(released).toEqual([[0x1_0000, 65_536]]);
  });

  it("reports the exact capture scratch high-water before borrowed replay", () => {
    const memory = new WebAssembly.Memory({ initial: 8 });
    let next = 0x1_0000;
    const released: Array<[number, number]> = [];
    const transaction = new ForkReferenceTransaction(
      makeFunctionCatalog(0, []),
      makeExternrefs().provider,
      memory,
      (size) => {
        const addr = next;
        next += size;
        return addr;
      },
      (addr, size) => released.push([addr, size]),
      "borrowed scratch high-water test",
    );
    transaction.beginCapture();
    const outer = transaction.reserveScratch(65_520);
    const inner = transaction.reserveScratch(32);
    transaction.releaseScratch(inner, 32);
    transaction.releaseScratch(outer, 65_520);

    withArena((arena) => transaction.sealInto(arena));
    expect(transaction.borrowedReplayScratchCapacity()).toBe(2 * 65_536);
    transaction.abort();
    expect(released).toEqual([
      [0x2_0000, 65_536],
      [0x1_0000, 65_536],
    ]);
  });

  it("interns Wasm-only exception identity and transfers exact scalar/reference payloads", () => {
    const memory = new WebAssembly.Memory({ initial: 2 });
    const thrown = new WebAssembly.Exception(
      new WebAssembly.Tag({ parameters: ["i32"] }),
      [17],
    );
    let cleared = 0;
    const externrefs = makeExternrefs();
    const parent = new ForkReferenceTransaction(
      makeFunctionCatalog(0, []),
      externrefs.provider,
      memory,
    );
    parent.setExceptionSlotProvider({
      throwSlot(slot): never {
        if (slot !== 3 && slot !== 4) throw new Error(`invalid slot ${slot}`);
        throw thrown;
      },
      clearSlots() {
        cleared++;
      },
    });
    parent.beginCapture();
    expect(parent.lookupExceptionSlot(3)).toBe(0);
    const exceptionId = parent.claimExceptionSlot(3);
    expect(exceptionId).toBe(1);
    expect(parent.lookupExceptionSlot(4)).toBe(exceptionId);
    expect(parent.claimExceptionSlot(4)).toBe(exceptionId);

    const sourceScalars = Uint8Array.of(
      0x78, 0x56, 0x34, 0x12,
      0, 1, 2, 3, 4, 5, 6, 7,
      8, 9, 10, 11, 12, 13, 14, 15,
    );
    new Uint8Array(memory.buffer, 0x100, sourceScalars.length).set(sourceScalars);
    new DataView(memory.buffer).setUint32(0x200, 0, true);
    parent.defineException(
      exceptionId,
      7,
      5,
      9,
      0x100,
      sourceScalars.length,
      0x200,
      1,
    );
    const records = withArena((arena) => parent.sealInto(arena));
    parent.beginParentReplay();
    expect(parent.routeException(exceptionId, 7)).toBe(9);
    expect(parent.routeException(exceptionId, 8)).toBe(-1);
    expect(
      parent.loadException(
        exceptionId,
        7,
        5,
        9,
        0x300,
        sourceScalars.length,
        0x400,
        1,
      ),
    ).toBe(1);
    expect(new Uint8Array(memory.buffer, 0x300, sourceScalars.length)).toEqual(
      sourceScalars,
    );
    expect(new DataView(memory.buffer).getUint32(0x400, true)).toBe(0);
    parent.finishReplay();
    expect(cleared).toBe(1);

    const childMemory = new WebAssembly.Memory({ initial: 2 });
    const child = new ForkReferenceTransaction(
      makeFunctionCatalog(0, []),
      makeExternrefs().provider,
      childMemory,
    );
    child.attachChild(records);
    expect(child.routeException(exceptionId, 7)).toBe(9);
    expect(
      child.loadException(
        exceptionId,
        7,
        5,
        9,
        0x100,
        sourceScalars.length,
        0x200,
        1,
      ),
    ).toBe(1);
    expect(
      new Uint8Array(childMemory.buffer, 0x100, sourceScalars.length),
    ).toEqual(sourceScalars);
    expect(() =>
      child.loadException(
        exceptionId,
        7,
        5,
        10,
        0x100,
        sourceScalars.length,
        0x200,
        1,
      )
    ).toThrow(/coordinate does not match/);
    child.finishReplay();
  });

  it("fails loud when module capture returns a recipe id beyond the captured-value table", () => {
    // Path B P3b hardening (finding A): the module assigns dense recipe ids, so
    // a new node's id must equal the current captured-value length. An id BEYOND
    // the table means the dense id<->value alignment broke — a later parent
    // replay would hand the parent a WRONG live reference. That silent identity
    // corruption must fail loud, never no-op.
    const fn = makeWasmFunction();
    // A stub capture module that returns a bogus (too-large) recipe id.
    const badCaptureModule = {
      begin(): void {},
      internFuncref(): number {
        return 5; // capturedValues.length is 1 after beginCapture — 5 is a gap.
      },
    } as unknown as ConstructorParameters<typeof ForkReferenceTransaction>[9];
    const parent = new ForkReferenceTransaction(
      makeFunctionCatalog(0, [fn]),
      makeExternrefs().provider,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      badCaptureModule,
    );
    parent.beginCapture();
    expect(() => parent.encodeFuncref(fn)).toThrow(
      /alignment is broken/,
    );
  });
});
