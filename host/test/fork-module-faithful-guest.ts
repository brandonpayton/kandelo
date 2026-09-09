// A FAITHFUL guest double for the co-resident fork-module GC drive tests.
//
// The co-resident module's injected `fm_drive_execute` shim `call_indirect`s the
// guest's `_gc_allocate`/`_gc_fill`/`exception_materialize` exports through the
// host-bound drive table, and — after each ALLOC step — reads STORE #2 (the
// shared Wasm-GC transit table `__wpk_fork_ref_gc_transit`) at slot `recipe + 1`
// with a wasm `table.get` + `ref.is_null` to assert the guest published a live GC
// object there. For that check to pass the guest double must actually populate
// store #2 when its `gc_allocate` runs — a plain mock guest that only records its
// call does NOT, which is exactly the gap that made every typed drive trap.
//
// PRODUCTION publishes with a wasm `table.set(recipe+1, ref.i31 ...)` inside the
// guest's generated `_gc_allocate` (see `crates/fork-instrument/src/module_gc_
// codec.rs` `emit_allocate_layout` / `emit_allocate_i31`). The test toolchain's
// `wat2wasm` (wabt 1.0.36) predates GC wasm (no `anyref` tables, no `ref.i31`), so
// this double routes the publish through a host import (`env.__wpk_fork_publish`)
// that performs the anyref `table.set` on the SAME `ForkAnyrefTransitTable` the
// shim reads. The TIMING (guest-`gc_allocate`-driven, mid-drive) and the STORE
// (the identical table object) match production; only the instruction that writes
// the slot differs. The guest's real wasm publish is covered by fork-instrument's
// module_gc_codec tests.

import { ForkAnyrefTransitTable } from "../src/fork-anyref-transit";

// Deterministic wat2wasm encoding of the module in
// `host/test/fork-module-faithful-guest.wat.txt` (kept alongside for reference):
// exports gc_allocate/gc_fill/exception_materialize ((i32)->()), each recording
// its last arg and packing an ordered call trace (alloc=1, fill=2, exn=3 ->
// `order()` = order*10+code) plus a call counter (`seq()`); `gc_allocate` also
// calls the host `__wpk_fork_publish(arg)` import to publish a live identity into
// store #2 at `arg + 1`.
// prettier-ignore
export const FAITHFUL_GUEST_BYTES = new Uint8Array([
  0,97,115,109,1,0,0,0,1,9,2,96,1,127,0,96,0,1,127,2,
  26,1,3,101,110,118,18,95,95,119,112,107,95,102,111,114,107,95,112,117,
  98,108,105,115,104,0,0,3,9,8,0,0,0,1,1,1,1,1,6,26,
  5,127,1,65,127,11,127,1,65,127,11,127,1,65,127,11,127,1,65,0,
  11,127,1,65,0,11,7,96,8,11,103,99,95,97,108,108,111,99,97,116,
  101,0,1,7,103,99,95,102,105,108,108,0,2,21,101,120,99,101,112,116,
  105,111,110,95,109,97,116,101,114,105,97,108,105,122,101,0,3,9,97,108,
  108,111,99,95,97,114,103,0,4,8,102,105,108,108,95,97,114,103,0,5,
  7,101,120,110,95,97,114,103,0,6,5,111,114,100,101,114,0,7,3,115,
  101,113,0,8,10,102,8,27,0,32,0,36,0,35,4,65,1,106,36,4,
  35,3,65,10,108,65,1,106,36,3,32,0,16,0,11,23,0,32,0,36,
  1,35,4,65,1,106,36,4,35,3,65,10,108,65,2,106,36,3,11,23,
  0,32,0,36,2,35,4,65,1,106,36,4,35,3,65,10,108,65,3,106,
  36,3,11,4,0,35,0,11,4,0,35,1,11,4,0,35,2,11,4,0,
  35,3,11,4,0,35,4,11,
]);

let compiledModule: WebAssembly.Module | undefined;

export interface FaithfulGuest {
  gc_allocate: WebAssembly.ExportValue;
  gc_fill: WebAssembly.ExportValue;
  exception_materialize: WebAssembly.ExportValue;
  alloc_arg: () => number;
  fill_arg: () => number;
  exn_arg: () => number;
  order: () => number;
  seq: () => number;
}

export interface FaithfulGuestHandle {
  guest: FaithfulGuest;
  /** Recipe ids the guest's `gc_allocate` published into store #2, in order. */
  readonly published: readonly number[];
}

/**
 * Instantiate the faithful guest double, wiring its `__wpk_fork_publish(recipe)`
 * import to publish a distinct live identity into `transit` (STORE #2) at slot
 * `recipe + 1` — exactly what the drive's post-ALLOC store-#2 read expects to
 * find. `transit` MUST be the same table the fork-module imports.
 */
export function instantiateFaithfulGuest(
  transit: ForkAnyrefTransitTable,
): FaithfulGuestHandle {
  if (!compiledModule) {
    compiledModule = new WebAssembly.Module(FAITHFUL_GUEST_BYTES);
  }
  const published: number[] = [];
  const instance = new WebAssembly.Instance(compiledModule, {
    env: {
      __wpk_fork_publish: (recipe: number) => {
        // The guest's allocate published a live GC object; mirror it into the
        // shared anyref transit at `recipe + 1` (the slot the shim reads back).
        // A fresh object gives the slot a distinct, non-null internalized
        // identity, so `ref.is_null` reads false.
        transit.ensureRecipeSlot(recipe);
        transit.set(recipe + 1, { gcRecipe: recipe });
        published.push(recipe);
      },
    },
  });
  return {
    guest: instance.exports as unknown as FaithfulGuest,
    published,
  };
}
