import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { resolveBinary } from "../src/binary-resolver";
import { instantiateForkModule } from "../src/fork-module-instance";
import {
  buildForkActivationStateImports,
  ForkActivationRegistry,
} from "../src/fork-activation-registry";
import {
  FORK_ANYREF_TRANSIT_IMPORT,
  ForkAnyrefTransitTable,
} from "../src/fork-anyref-transit";

/**
 * M1 task 4 review finding: the task brief asked for an explicit unit
 * assertion that the guest import, the fork-module export, and the host
 * registry seam all share ONE `WebAssembly.Table` object (M1's whole point —
 * relocating the GC transit table into the fork-module so there is exactly
 * one, not three, transit tables per process). Task 4 shipped only
 * behavioral proof (the fresh-worker fork tests going green). This test adds
 * the missing structural guard directly, so an accidental future re-mint of
 * any of the three tables fails here even if it happens not to trip the
 * runtime drive integrity check.
 *
 * This mirrors the flag-on wiring in `host/src/worker-main.ts`:
 *   forkGcTransit = new ForkAnyrefTransitTable(forkModuleInstance.gcTransitTable);
 *   const activationRegistry = new ForkActivationRegistry(
 *     memory, externrefRecipes, label, allocateScratch, deallocateScratch,
 *     forkGcTransit,
 *   );
 * without needing a real worker.
 */

function loadForkModule32(): WebAssembly.Module {
  const buf = readFileSync(resolveBinary("fork_module32.wasm"));
  return new WebAssembly.Module(buf);
}

function sharedMemory(pages: number): WebAssembly.Memory {
  return new WebAssembly.Memory({ initial: pages, maximum: 16384, shared: true });
}

/** Same "fixture has no externrefs" stub used by fork-activation-registry.test.ts. */
function unusedExternrefs() {
  return {
    capture: () => {
      throw new Error("fixture has no externrefs");
    },
    materialize: () => {
      throw new Error("fixture has no externrefs");
    },
  };
}

describe("fork transit table relocation (M1)", () => {
  it("shares ONE WebAssembly.Table object across the module export, the wrapping "
    + "ForkAnyrefTransitTable, the registry seam, and the guest import", () => {
    const module = loadForkModule32();
    const memory = sharedMemory(256); // 16 MiB
    const reserveBase = 8 * 1024 * 1024;
    const reserve = (size: number): number => {
      void size;
      return reserveBase;
    };

    const fm = instantiateForkModule({
      module,
      memory,
      ptrWidth: 4,
      reserve,
      label: "test",
    });

    // Mirror worker-main.ts: wrap (not mint) the module's own exported table.
    const forkGcTransit = new ForkAnyrefTransitTable(fm.gcTransitTable);
    expect(forkGcTransit.table).toBe(fm.gcTransitTable);

    const activationRegistry = new ForkActivationRegistry(
      memory,
      unusedExternrefs(),
      "test: fork activations",
      () => {
        throw new Error("fixture does not exercise scratch allocation");
      },
      () => {
        throw new Error("fixture does not exercise scratch deallocation");
      },
      forkGcTransit,
    );

    // Store #2, seam #2: the registry's own accessor must return the exact
    // same object, not an equivalent-but-distinct table.
    expect(activationRegistry.gcTransitTable()).toBe(fm.gcTransitTable);

    // Store #2, seam #3: the value actually bound to the guest's
    // `__wpk_fork_ref_gc_transit` import for a real activation.
    const imports = buildForkActivationStateImports(0, activationRegistry);
    expect(imports[FORK_ANYREF_TRANSIT_IMPORT]).toBe(fm.gcTransitTable);
  });

  /**
   * M1 task 5: the thread-fork path cannot use the task 4 constructor-inject
   * pattern above. There, `threadActivationRegistry` is created BEFORE the
   * thread fork-module is instantiated, because the module's
   * `enableModuleBacking` gate needs a process-continuation coordinator
   * (built from the registry) to already exist. worker-main.ts instead
   * ADOPTS the module's exported table into the already-built registry via
   * `ForkActivationRegistry.adoptGcTransit`. This test proves that adoption
   * — not just construction-time injection — produces the same one-table
   * identity across the module export, the registry seam, and the guest
   * import.
   */
  it("adopting a fork-module's table into an already-built registry shares ONE "
    + "WebAssembly.Table object, mirroring the thread-fork wiring order", () => {
    const module = loadForkModule32();
    const memory = sharedMemory(256); // 16 MiB
    const reserveBase = 8 * 1024 * 1024;
    const reserve = (size: number): number => {
      void size;
      return reserveBase;
    };

    // Mirror worker-main.ts: the thread registry exists first, minting its
    // own default table (nothing to adopt yet).
    const activationRegistry = new ForkActivationRegistry(
      memory,
      unusedExternrefs(),
      "test: thread fork activations",
      () => {
        throw new Error("fixture does not exercise scratch allocation");
      },
      () => {
        throw new Error("fixture does not exercise scratch deallocation");
      },
    );
    const mintedTable = activationRegistry.gcTransitTable();

    // The thread fork-module is instantiated AFTER the registry.
    const fm = instantiateForkModule({
      module,
      memory,
      ptrWidth: 4,
      reserve,
      label: "test",
    });
    expect(fm.gcTransitTable).not.toBe(mintedTable);

    // Adopt the module's own exported table into the already-built registry.
    activationRegistry.adoptGcTransit(fm.gcTransitTable);

    expect(activationRegistry.gcTransitTable()).toBe(fm.gcTransitTable);
    expect(activationRegistry.gcTransitTable()).not.toBe(mintedTable);

    // The value actually bound to the guest's `__wpk_fork_ref_gc_transit`
    // import for a real activation, built AFTER adoption (as worker-main.ts
    // does — well before `buildForkActivationStateImports` runs).
    const imports = buildForkActivationStateImports(0, activationRegistry);
    expect(imports[FORK_ANYREF_TRANSIT_IMPORT]).toBe(fm.gcTransitTable);
  });
});
