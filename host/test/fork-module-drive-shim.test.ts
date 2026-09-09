// Phase 6 item 3b — the call_indirect DRIVE-SHIM MECHANISM for driving the guest
// GC exports from the co-resident fork module, proven end to end in a real
// WebAssembly engine (Node/V8).
//
// The module cannot IMPORT the guest's `_gc_allocate`/`_gc_fill` exports (it is
// instantiated BEFORE the guest, to supply the frame-flip imports). So instead of
// the JS `materializeTypedGraph` drive-order calling those guest exports, the
// module drives them through a MUTABLE funcref table (`env.__wpk_fork_drive_table`)
// the host binds post-instantiation. Rust has no `call_indirect` intrinsic, so the
// split is: Rust serializes an ordered PLAN (`fm_build_trivial_plan`); the injected
// walrus shim `fm_drive_execute(plan_ptr, count)` loops the plan, `call_indirect`s
// the table slot for each step, and — after each ALLOC step — reads STORE #2 (the
// shared Wasm-GC transit table `env.__wpk_fork_ref_gc_transit`) at slot `recipe + 1`
// with a wasm `table.get` + `ref.is_null` to assert the guest's `_gc_allocate`
// published a live GC object there.
//
// This slice builds ONLY the mechanism, proven on a TRIVIAL single struct (ALLOC
// then FILL for one recipe). It does NOT flip the real JS drive-order to the module
// (that is item 3c); `materializeTypedGraph` keeps driving production forks.
//
// Assertions:
//   (a) MECHANISM — `fm_drive_execute` `call_indirect`s the GUEST's `_gc_allocate`
//       then `_gc_fill` (bound into the drive table), wasm->wasm, in that order,
//       each with the plan's arg (observable via guest counters/args).
//   (b) STORE-#2 CHECK PASSES — with the guest's `_gc_allocate` publishing a live
//       identity into the transit slot `recipe+1`, the shim's read-back succeeds
//       and the drive completes.
//   (c) STORE-#2 CHECK IS LOAD-BEARING — with a guest that does NOT publish, the
//       shim reads a null slot and TRAPS (`unreachable`), never a silent pass.

import { describe, expect, it } from "vitest";

import { resolveBinary } from "../src/binary-resolver";
import { readFileSync } from "node:fs";
import { instantiateForkModule } from "../src/fork-module-instance";
import { ForkAnyrefTransitTable } from "../src/fork-anyref-transit";
import { instantiateFaithfulGuest } from "./fork-module-faithful-guest";

const PTR_WIDTH = 4 as const;
const PID = 3131;

// A NON-PUBLISHING mock guest: observable `gc_allocate` / `gc_fill` exports, both
// (i32)->() like the frozen guest `__wpk_fork_ref_gc_{allocate,fill}`, but whose
// `gc_allocate` does NOT publish into the transit table. `order()` packs the call
// sequence (alloc=1, fill=2 -> 12), `seq()` counts calls, `alloc_arg()` /
// `fill_arg()` echo the last argument the shim passed via call_indirect. Compiled
// with wat2wasm; embedded so the test needs no build tooling. Used only to prove
// the store-#2 check TRAPS when nothing was published.
// prettier-ignore
const NONPUBLISHING_GUEST_BYTES = new Uint8Array([
  0,97,115,109,1,0,0,0,1,9,2,96,1,127,0,96,0,1,127,3,7,6,0,0,1,1,1,1,6,21,4,
  127,1,65,127,11,127,1,65,127,11,127,1,65,0,11,127,1,65,0,11,7,62,6,11,103,99,
  95,97,108,108,111,99,97,116,101,0,0,7,103,99,95,102,105,108,108,0,1,9,97,108,
  108,111,99,95,97,114,103,0,2,8,102,105,108,108,95,97,114,103,0,3,5,111,114,100,
  101,114,0,4,3,115,101,113,0,5,10,69,6,23,0,32,0,36,0,35,3,65,1,106,36,3,35,2,
  65,10,108,65,1,106,36,2,11,23,0,32,0,36,1,35,3,65,1,106,36,3,35,2,65,10,108,65,
  2,106,36,2,11,4,0,35,0,11,4,0,35,1,11,4,0,35,2,11,4,0,35,3,11,
]);

interface NonPublishingGuest {
  gc_allocate: WebAssembly.ExportValue;
  gc_fill: WebAssembly.ExportValue;
  alloc_arg: () => number;
  fill_arg: () => number;
  order: () => number;
  seq: () => number;
}

interface DriveShimExports {
  fm_build_trivial_plan: (activation: number, recipe: number, pid: number) => number;
  fm_trivial_plan_count: () => number;
  fm_drive_execute: (planPtr: number, count: number) => void;
  fm_drive_table_base: (activation: number) => number;
  fm_last_errno: () => number;
}

const MODULE = new WebAssembly.Module(
  readFileSync(resolveBinary("fork_module32.wasm")),
);
const NONPUBLISHING_GUEST_MODULE = new WebAssembly.Module(NONPUBLISHING_GUEST_BYTES);

/** Instantiate the fork-module and wrap (not mint) its OWN exported transit
 *  table (STORE #2, M1) so the shim's post-ALLOC read, the guest's publish, and
 *  this test's read-back all reach the same table. */
function setup() {
  const memory = new WebAssembly.Memory({ initial: 256, maximum: 16384, shared: true });
  const fm = instantiateForkModule({
    module: MODULE,
    memory,
    ptrWidth: PTR_WIDTH,
    reserve: () => 8 * 1024 * 1024,
    label: "drive-shim-test",
  });
  const x = fm.exports as unknown as DriveShimExports;
  const transitTable = new ForkAnyrefTransitTable(fm.gcTransitTable);
  return { fm, x, transitTable };
}

describe("fork-module call_indirect drive-shim mechanism (Phase 6 item 3b)", () => {
  it("call_indirects the guest _gc_allocate then _gc_fill via the drive table and passes the store-#2 integrity check", () => {
    const { fm, x, transitTable } = setup();
    const recipe = 7;

    // Bind the FAITHFUL guest (its `gc_allocate` publishes a live identity into
    // STORE #2 at `recipe+1`) into the host-owned drive table (base(0) = 0 ->
    // ALLOC slot 0, FILL slot 1).
    const { guest, published } = instantiateFaithfulGuest(transitTable);
    const base = x.fm_drive_table_base(0);
    expect(base).toBe(0);
    if (fm.driveTable.length < base + 2) {
      fm.driveTable.grow(base + 2 - fm.driveTable.length);
    }
    fm.driveTable.set(base + 0, guest.gc_allocate);
    fm.driveTable.set(base + 1, guest.gc_fill);

    // Rust serializes the trivial ALLOC-then-FILL plan (no host generation is
    // opened; the shim reads store #2 directly).
    const planPtr = x.fm_build_trivial_plan(0, recipe, PID);
    expect(x.fm_last_errno()).toBe(0);
    expect(planPtr).not.toBe(0);
    expect(x.fm_trivial_plan_count()).toBe(2);

    // Nothing has run yet.
    expect(guest.seq()).toBe(0);

    // Drive: the shim loops the plan and call_indirects the bound guest exports.
    x.fm_drive_execute(planPtr, x.fm_trivial_plan_count());

    // (a) MECHANISM — guest _gc_allocate ran first, then _gc_fill, each once, each
    // with the plan's arg (== recipe for the trivial plan).
    expect(guest.seq()).toBe(2);
    expect(guest.order()).toBe(12); // 1 (alloc) then 2 (fill)
    expect(guest.alloc_arg()).toBe(recipe);
    expect(guest.fill_arg()).toBe(recipe);
    // (b) STORE-#2 CHECK PASSED — the guest published slot recipe+1 during
    // allocate, so the shim's read-back found a live object and did not trap.
    expect(published).toEqual([recipe]);
    expect(transitTable.get(recipe + 1)).not.toBeNull();
    expect(x.fm_last_errno()).toBe(0);
  });

  it("TRAPS when the store-#2 slot is null (integrity check is load-bearing)", () => {
    const { fm, x } = setup();
    const recipe = 4;

    // A NON-PUBLISHING guest: `gc_allocate` records its call but never publishes
    // into the transit table, so the shim's post-ALLOC read finds a null slot.
    const guest = new WebAssembly.Instance(NONPUBLISHING_GUEST_MODULE)
      .exports as unknown as NonPublishingGuest;
    const base = x.fm_drive_table_base(0);
    if (fm.driveTable.length < base + 2) {
      fm.driveTable.grow(base + 2 - fm.driveTable.length);
    }
    fm.driveTable.set(base + 0, guest.gc_allocate);
    fm.driveTable.set(base + 1, guest.gc_fill);

    const planPtr = x.fm_build_trivial_plan(0, recipe, PID);
    expect(x.fm_last_errno()).toBe(0);

    // The guest does NOT publish: the shim must read a null store-#2 slot and
    // trap, never silently pass an integrity check with no live identity.
    expect(() => x.fm_drive_execute(planPtr, x.fm_trivial_plan_count())).toThrow();

    // The guest _gc_allocate DID run (call_indirect happened before the trap); the
    // trap fired in the post-ALLOC store-#2 check, before _gc_fill.
    expect(guest.order()).toBe(1); // only alloc, then trap
  });
});
