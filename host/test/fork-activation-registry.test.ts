import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  buildForkActivationStateImports,
  ForkActivationRegistry,
  type ForkActivationRegistration,
} from "../src/fork-activation-registry";
import {
  ForkModuleStateArena,
  ForkTableDirtyTracker,
} from "../src/fork-module-state";
import {
  WPK_FORK_REFERENCE_IMPORT_GC_CAPTURE_LAYOUT,
} from "../src/generated/abi";

const PAGE_SIZE = 65_536;

function makeArena(memory: WebAssembly.Memory, label: string): ForkModuleStateArena {
  let next = PAGE_SIZE;
  return new ForkModuleStateArena(
    memory,
    4,
    (size) => {
      const address = next;
      next += size;
      if (next > memory.buffer.byteLength) {
        memory.grow(Math.ceil((next - memory.buffer.byteLength) / PAGE_SIZE));
      }
      return address;
    },
    () => {},
    label,
  );
}

function emptyCatalog(): WebAssembly.Table {
  return new WebAssembly.Table({
    element: "anyfunc",
    initial: 0,
    maximum: 0,
  });
}

function emptyStaticRootCatalog(): WebAssembly.Table {
  return new WebAssembly.Table({
    element: "externref",
    initial: 0,
    maximum: 0,
  });
}

function funcrefTableActivation(): {
  readonly instance: WebAssembly.Instance;
  readonly functionCatalog: WebAssembly.Table;
  readonly mutableTable: WebAssembly.Table;
} {
  const dir = mkdtempSync(join(tmpdir(), "kandelo-table-patch-"));
  const wat = join(dir, "table-patch.wat");
  const wasm = join(dir, "table-patch.wasm");
  writeFileSync(wat, `(module
    (table $catalog (export "__wpk_fork_function_catalog") 2 2 funcref)
    (table $mutable (export "__wpk_fork_table_3") 2 4 funcref)
    (func $first (result i32) i32.const 17)
    (func $second (result i32) i32.const 29)
    (elem (table $catalog) (i32.const 0) func $first $second)
  )`);
  execFileSync("wat2wasm", [wat, "-o", wasm]);
  const instance = new WebAssembly.Instance(
    new WebAssembly.Module(readFileSync(wasm)),
  );
  return {
    instance,
    functionCatalog:
      instance.exports.__wpk_fork_function_catalog as WebAssembly.Table,
    mutableTable: instance.exports.__wpk_fork_table_3 as WebAssembly.Table,
  };
}

function registration(
  activationId: number,
  calls: string[],
  options: {
    clear?: () => void;
    abort?: () => void;
  } = {},
): ForkActivationRegistration {
  return {
    activationId,
    instance: { exports: {} } as unknown as WebAssembly.Instance,
    templateId: new Uint8Array(32).fill(activationId + 1),
    functionCatalog: emptyCatalog(),
    staticRootCatalog: emptyStaticRootCatalog(),
    staticRootHarvest: () => {},
    tableDirty: new ForkTableDirtyTracker(),
    moduleState: {
      bootstrap: () => { calls.push(`bootstrap:${activationId}`); },
      save: (id) => { calls.push(`save:${id}`); },
      restore: (id) => { calls.push(`restore:${id}`); },
      finishRestore: (id) => { calls.push(`finish-restore:${id}`); },
      saveTables: (id) => { calls.push(`save-tables:${id}`); },
      restoreTables: (id) => { calls.push(`restore-tables:${id}`); },
    },
    typedReferenceProvider: {
      clear: options.clear ?? (() => { calls.push(`clear:${activationId}`); }),
      abort: options.abort ?? (() => { calls.push(`abort:${activationId}`); }),
    },
  };
}

function registry(memory: WebAssembly.Memory, label: string): ForkActivationRegistry {
  return new ForkActivationRegistry(
    memory,
    {
      capture: () => {
        throw new Error("fixture has no externrefs");
      },
      materialize: () => {
        throw new Error("fixture has no externrefs");
      },
    },
    label,
  );
}

describe("ForkActivationRegistry", () => {
  it("binds GC layout capture in the generated slot/activation/layout order", () => {
    const memory = new WebAssembly.Memory({ initial: 2 });
    const owner = registry(memory, "GC capture import");
    const capture = vi.spyOn(owner, "captureGcLayout").mockReturnValue(23);
    const imports = buildForkActivationStateImports(7, owner);
    const captureLayout = imports[
      WPK_FORK_REFERENCE_IMPORT_GC_CAPTURE_LAYOUT
    ] as CallableFunction;

    expect(captureLayout(5, 7, 11)).toBe(23);
    expect(capture).toHaveBeenCalledWith(7, 5, 11);
    expect(() => captureLayout(7, 5, 11)).toThrow(
      "activation 7 cannot select GC layout for activation 5",
    );
  });

  it("captures and restores every activation in deterministic id order", () => {
    const memory = new WebAssembly.Memory({ initial: 8 });
    const calls: string[] = [];
    const parent = registry(memory, "parent");
    parent.registerActivation(registration(7, calls));
    parent.registerActivation(registration(0, calls));
    parent.bootstrapActivation(0);
    parent.bootstrapActivation(7);

    const arena = makeArena(memory, "parent arena");
    arena.begin();
    parent.beginCapture(arena);
    expect(calls).toEqual([
      "bootstrap:0",
      "bootstrap:7",
      "save:0",
      "save:7",
    ]);
    parent.sealCapture();
    parent.beginParentReplay();
    parent.restoreModuleState();
    parent.finishReplay();
    expect(calls.slice(-6)).toEqual([
      "restore:0",
      "restore:7",
      "finish-restore:0",
      "finish-restore:7",
      "clear:0",
      "clear:7",
    ]);
    expect(parent.phaseName()).toBe("idle");
  });

  it("attaches a fresh child only after the complete activation set exists", () => {
    const parentMemory = new WebAssembly.Memory({ initial: 8 });
    const parent = registry(parentMemory, "parent");
    parent.registerActivation(registration(0, []));
    parent.registerActivation(registration(2, []));
    const parentArena = makeArena(parentMemory, "parent arena");
    const root = parentArena.begin();
    parent.beginCapture(parentArena);
    parent.sealCapture();

    const childMemory = new WebAssembly.Memory({
      initial: parentMemory.buffer.byteLength / PAGE_SIZE,
    });
    new Uint8Array(childMemory.buffer).set(new Uint8Array(parentMemory.buffer));
    const childArena = new ForkModuleStateArena(
      childMemory,
      4,
      () => { throw new Error("attached child arena must not allocate"); },
      () => {},
      "child arena",
    );
    childArena.attach(root);

    const childCalls: string[] = [];
    const child = registry(childMemory, "child");
    child.registerActivation(registration(0, childCalls));
    expect(() => child.attachChild(childArena)).toThrow(
      "copied module activations do not match",
    );
    child.registerActivation(registration(2, childCalls));
    child.attachChild(childArena);
    child.currentReferences().materializeAllTyped = () => {
      childCalls.push("materialize-typed");
    };
    child.restoreModuleState();
    child.finishReplay();
    expect(childCalls).toEqual([
      "materialize-typed",
      "restore:0",
      "restore:2",
      "finish-restore:0",
      "finish-restore:2",
      "clear:0",
      "clear:2",
    ]);
  });

  it("drops every provider root even when one cleanup reports an error", () => {
    const memory = new WebAssembly.Memory({ initial: 8 });
    const calls: string[] = [];
    const owner = registry(memory, "cleanup");
    owner.registerActivation(registration(0, calls, {
      abort: () => {
        calls.push("abort:0");
        throw new Error("first cleanup failed");
      },
    }));
    owner.registerActivation(registration(1, calls));
    const arena = makeArena(memory, "cleanup arena");
    arena.begin();
    owner.beginCapture(arena);

    expect(() => owner.abort()).toThrow("first cleanup failed");
    expect(calls.slice(-2)).toEqual(["abort:0", "abort:1"]);
    expect(owner.phaseName()).toBe("idle");
  });

  it("keeps weak static identity across later forks and forgets it on unregister", () => {
    const memory = new WebAssembly.Memory({ initial: 8 });
    const root = Object.freeze({ segment: "already dropped" });
    const harvest = new WebAssembly.Table({
      element: "externref",
      initial: 1,
      maximum: 1,
    });
    harvest.set(0, root);
    const owner = registry(memory, "static roots");
    owner.registerActivation({
      ...registration(0, []),
      staticRootCatalog: harvest,
      staticRootHarvest: () => {},
    });
    expect(harvest.get(0)).toBeNull();

    for (const label of ["first fork", "later fork"]) {
      const arena = makeArena(memory, label);
      arena.begin();
      owner.beginCapture(arena);
      expect(owner.currentReferences().encodeExternref(root)).toBe(1);
      owner.abort();
    }

    owner.unregisterActivation(0);
    const afterUnload = makeArena(memory, "after unload");
    afterUnload.begin();
    owner.beginCapture(afterUnload);
    expect(() => owner.currentReferences().encodeExternref(root)).toThrow(
      "fixture has no externrefs",
    );
    owner.abort();
  });

  it("keeps table owner ordinals activation-local", () => {
    const memory = new WebAssembly.Memory({ initial: 2 });
    const owner = registry(memory, "tables");
    owner.registerActivation(registration(0, []));
    owner.registerActivation(registration(1, []));
    owner.tableDirty(0).markPages(3, 1n, 1n);
    owner.tableDirty(1).markPages(3, 9n, 1n);
    expect(owner.tableDirty(0).pageAt(3, 0)).toBe(1n);
    expect(owner.tableDirty(1).pageAt(3, 0)).toBe(9n);
  });

  it("attributes host table mutations to every catalog alias", () => {
    const memory = new WebAssembly.Memory({ initial: 2 });
    const table = new WebAssembly.Table({
      element: "anyfunc",
      initial: 2_048,
      maximum: 4_096,
    });
    const owner = registry(memory, "host table mutation");
    const first = registration(0, []);
    const second = registration(1, []);
    owner.registerActivation({
      ...first,
      instance: {
        exports: { __wpk_fork_table_3: table },
      } as unknown as WebAssembly.Instance,
    });
    owner.registerActivation({
      ...second,
      instance: {
        exports: { __wpk_fork_table_9: table },
      } as unknown as WebAssembly.Instance,
    });
    expect(owner.tableDirty(0).ownsState(3)).toBe(true);
    expect(owner.tableDirty(1).ownsState(9)).toBe(false);

    // The range crosses the ABI-defined 1,024-entry sparse-page boundary.
    owner.markTableMutation(table, 1_023, 2);
    for (const [activationId, tableOwner] of [[0, 3], [1, 9]] as const) {
      expect(owner.tableDirty(activationId).pageCount(tableOwner)).toBe(2);
      expect(owner.tableDirty(activationId).pageAt(tableOwner, 0)).toBe(0n);
      expect(owner.tableDirty(activationId).pageAt(tableOwner, 1)).toBe(1n);
    }

    // Catalog removal must neither retain nor keep writing the unloaded
    // activation's coordinate.
    owner.unregisterActivation(0);
    expect(owner.tableDirty(1).ownsState(9)).toBe(true);
    owner.markTableMutation(table, 2_048, 1);
    expect(owner.tableDirty(1).pageAt(9, 2)).toBe(2n);
  });

  it("retires every table coordinate when a checkpoint gives up ownership", () => {
    const memory = new WebAssembly.Memory({ initial: 2 });
    const first = new WebAssembly.Table({
      element: "anyfunc",
      initial: 8,
      maximum: 8,
    });
    const second = new WebAssembly.Table({
      element: "anyfunc",
      initial: 8,
      maximum: 8,
    });
    const owner = registry(memory, "checkpoint table ownership");
    owner.registerActivation({
      ...registration(0, []),
      instance: {
        exports: { __wpk_fork_table_3: first, __wpk_fork_table_4: second },
      } as unknown as WebAssembly.Instance,
    });
    expect(owner.tableDirty(0).ownsState(3)).toBe(true);
    expect(owner.tableDirty(0).ownsState(4)).toBe(true);

    owner.releaseProcessTableStateOwnership();

    // A pthread that is not the checkpoint's arena owner must neither write the
    // shared sparse state nor reapply it on resume.
    expect(owner.tableDirty(0).ownsState(3)).toBe(false);
    expect(owner.tableDirty(0).ownsState(4)).toBe(false);
  });

  it("re-elects one canonical owner per table when a fork follows a checkpoint", () => {
    const memory = new WebAssembly.Memory({ initial: 2 });
    const shared = new WebAssembly.Table({
      element: "anyfunc",
      initial: 8,
      maximum: 8,
    });
    const unshared = new WebAssembly.Table({
      element: "anyfunc",
      initial: 8,
      maximum: 8,
    });
    const owner = registry(memory, "checkpoint table restore");
    owner.registerActivation({
      ...registration(0, []),
      instance: {
        exports: { __wpk_fork_table_3: shared, __wpk_fork_table_4: unshared },
      } as unknown as WebAssembly.Instance,
    });
    owner.registerActivation({
      ...registration(1, []),
      instance: {
        exports: { __wpk_fork_table_9: shared },
      } as unknown as WebAssembly.Instance,
    });
    expect(owner.tableDirty(0).ownsState(3)).toBe(true);
    expect(owner.tableDirty(1).ownsState(9)).toBe(false);

    owner.releaseProcessTableStateOwnership();
    owner.restoreProcessTableStateOwnership();

    // The election runs again rather than electing every coordinate: the alias
    // at 1:9 stays retired, or one physical table would be written twice.
    expect(owner.tableDirty(0).ownsState(3)).toBe(true);
    expect(owner.tableDirty(0).ownsState(4)).toBe(true);
    expect(owner.tableDirty(1).ownsState(9)).toBe(false);
  });

  it("rejects host mutations of tables outside activation catalogs", () => {
    const memory = new WebAssembly.Memory({ initial: 2 });
    const owner = registry(memory, "unknown host table");
    const table = new WebAssembly.Table({
      element: "anyfunc",
      initial: 1,
      maximum: 1,
    });
    expect(() => owner.markTableMutation(table, 0, 1)).toThrow(
      "outside the registered fork catalogs",
    );
  });

  it("replays funcref/null table patches through fresh activation catalogs", () => {
    const parentMemory = new WebAssembly.Memory({ initial: 2 });
    const parent = registry(parentMemory, "parent table patch");
    const parentModule = funcrefTableActivation();
    parent.registerActivation({
      ...registration(0, []),
      instance: parentModule.instance,
      functionCatalog: parentModule.functionCatalog,
    });
    // A second activation aliases the same physical process Table. The patch
    // target deliberately uses that non-canonical coordinate.
    parent.registerActivation({
      ...registration(1, []),
      instance: {
        exports: { __wpk_fork_table_9: parentModule.mutableTable },
      } as unknown as WebAssembly.Instance,
    });

    const parentFirst = parentModule.functionCatalog.get(0);
    const parentSecond = parentModule.functionCatalog.get(1);
    parentModule.mutableTable.set(0, parentFirst);
    parentModule.mutableTable.set(1, parentFirst);
    const first = parent.captureFuncrefTablePatch(1, 9, 0, 2);
    expect(first).toEqual({
      activationId: 1,
      ownerId: 9,
      start: 0,
      tableLength: 2,
      runs: [{
        length: 2,
        function: { activationId: 0, ordinal: 0 },
      }],
    });
    parentModule.mutableTable.grow(2, parentSecond);
    const growth = parent.captureFuncrefTablePatch(1, 9, 2, 2);

    const childMemory = new WebAssembly.Memory({ initial: 2 });
    const child = registry(childMemory, "child table patch");
    const childModule = funcrefTableActivation();
    child.registerActivation({
      ...registration(0, []),
      instance: childModule.instance,
      functionCatalog: childModule.functionCatalog,
    });
    child.registerActivation({
      ...registration(1, []),
      instance: {
        exports: { __wpk_fork_table_9: childModule.mutableTable },
      } as unknown as WebAssembly.Instance,
    });
    child.applyFuncrefTablePatch({ ...first!, generation: 1 });
    child.applyFuncrefTablePatch({ ...growth!, generation: 2 });

    expect(childModule.mutableTable.length).toBe(4);
    expect(childModule.mutableTable.get(0)).toBe(
      childModule.functionCatalog.get(0),
    );
    expect(childModule.mutableTable.get(1)).toBe(
      childModule.functionCatalog.get(0),
    );
    expect(childModule.mutableTable.get(2)).toBe(
      childModule.functionCatalog.get(1),
    );
    expect(childModule.mutableTable.get(3)).toBe(
      childModule.functionCatalog.get(1),
    );
    expect(childModule.mutableTable.get(0)).not.toBe(parentFirst);
    expect(child.tableDirty(0).pageCount(3)).toBe(1);
    expect(child.tableDirty(1).pageCount(9)).toBe(1);
  });

  it("routes non-funcref table values to the typed checkpoint", () => {
    const memory = new WebAssembly.Memory({ initial: 2 });
    const owner = registry(memory, "typed table fallback");
    const table = new WebAssembly.Table({
      element: "externref",
      initial: 1,
      maximum: 1,
    });
    table.set(0, Object.freeze({ processHandle: 47 }));
    owner.registerActivation({
      ...registration(0, []),
      instance: {
        exports: { __wpk_fork_table_4: table },
      } as unknown as WebAssembly.Instance,
    });
    expect(owner.captureFuncrefTablePatch(0, 4, 0, 1)).toBeNull();
  });
});
