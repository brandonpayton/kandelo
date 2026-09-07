// Path-A A3/A4 — the REAL-engine peer-table snapshot round-trip.
//
// `process-table-replication.test.ts` MOCKS the capture/restore engine, so it
// proves only the patch-journal / compaction orchestration. This test drives
// the ACTUAL module surface the migration composes — the capture module
// (`fm_capture_*` + `fm_capture_serialize`, through `ForkCaptureSession`) and
// the reconstruction backend (`fm_decode_reference_graph` +
// `fm_restore_from_arena` + `fm_drive_execute`, through
// `ForkTableReconstruction`) — in a real WebAssembly engine (Node/V8), and
// asserts the two invariants a peer-table snapshot must hold:
//
//   (a) CAPTURE ↔ RESTORE identity — a funcref table captured through the
//       module's shared reference-graph builder reconstructs to the SAME
//       funcref identity when restored through the module's resident
//       decoded-graph oracle.
//   (b) CROSS-WORKER FUNCREF-ORDINAL STABILITY — the identical captured graph,
//       restored against a DIFFERENT worker's own per-activation function
//       catalog, resolves each recipe to THAT worker's function at the same
//       (activation, ordinal), never the capturer's. This is the dlopen
//       replication invariant: each Worker re-materializes recipes into its own
//       table by coordinate.
//
// Zero mocks of the reference engine: one co-resident `fork_module` instance
// serves both the capture (`fm_capture_*`) and the restore
// (`fm_restore_from_arena`) halves, exactly as a production worker's does.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { resolveBinary } from "../src/binary-resolver";
import { instantiateForkModule } from "../src/fork-module-instance";
import { ForkFunctionCatalog } from "../src/fork-function-catalog";
import { ForkModuleStateArena } from "../src/fork-module-state";
import { ForkReferenceCaptureModule } from "../src/fork-reference-capture-module";
import { ForkCaptureSession } from "../src/fork-capture-session";
import { ForkTableReconstruction } from "../src/fork-table-snapshot";

const PAGE = 65536;
const PTR_WIDTH = 4 as const;
// The single activation every funcref in this snapshot belongs to.
const ACTIVATION = 7;

/**
 * A guest-like `__wpk_fork_function_catalog` funcref table with four distinct
 * functions returning `base + ordinal`. Two instances built with different
 * bases model two Workers' own tables: same coordinates, distinct identities.
 */
function catalogTable(base: number): WebAssembly.Table {
  const dir = mkdtempSync(join(tmpdir(), "kandelo-table-roundtrip-"));
  const wat = join(dir, "catalog.wat");
  const wasm = join(dir, "catalog.wasm");
  writeFileSync(
    wat,
    `(module
      (table $catalog (export "__wpk_fork_function_catalog") 4 4 funcref)
      (func $f0 (result i32) i32.const ${base + 0})
      (func $f1 (result i32) i32.const ${base + 1})
      (func $f2 (result i32) i32.const ${base + 2})
      (func $f3 (result i32) i32.const ${base + 3})
      (elem (table $catalog) (i32.const 0) func $f0 $f1 $f2 $f3))`,
  );
  execFileSync("wat2wasm", [wat, "-o", wasm]);
  const module = new WebAssembly.Module(readFileSync(wasm));
  return new WebAssembly.Instance(module).exports
    .__wpk_fork_function_catalog as WebAssembly.Table;
}

describe("fork peer-table snapshot round-trip (Path-A A3/A4)", () => {
  it("captures a funcref table through the module and restores it with identity + cross-worker ordinal stability", () => {
    const memory = new WebAssembly.Memory({
      initial: 256,
      maximum: 16384,
      shared: true,
    });

    // The capturing Worker's own funcref catalog (identities value 100+ordinal).
    const captureCatalog = catalogTable(100);
    const captureFunctions = new ForkFunctionCatalog();
    captureFunctions.register(ACTIVATION, captureCatalog);

    // One co-resident fork module serves BOTH halves (capture + restore), as a
    // production worker's instance does. Placed HIGH; the KFMS arena is LOW.
    const reserveBase = 8 * 1024 * 1024;
    const module = new WebAssembly.Module(
      readFileSync(resolveBinary("fork_module32.wasm")),
    );
    const fm = instantiateForkModule({
      module,
      memory,
      ptrWidth: PTR_WIDTH,
      reserve: () => reserveBase,
      label: "table-roundtrip-test",
      functionCatalog: captureCatalog,
    });
    // Seed the linked-frame format once (the backend's `setup()` does this in
    // production); `fm_restore_from_arena` needs it to size pointers.
    (fm.exports.fm_set_format as (pw: number, fixedPrefix: number) => void)(
      PTR_WIDTH,
      0,
    );
    expect(fm.exports.fm_last_errno()).toBe(0);

    // A LOW bump arena that never collides with the module's HIGH region.
    let next = PAGE;
    const allocate = (size: number): number => {
      const addr = next;
      next += Math.ceil(size / 8) * 8;
      if (next > memory.buffer.byteLength) {
        memory.grow(Math.ceil((next - memory.buffer.byteLength) / PAGE));
      }
      return addr;
    };
    const noopFree = (): void => {};

    // ---- CAPTURE: drive the real module capture graph (`fm_capture_*`). ----
    const captureModule = new ForkReferenceCaptureModule(
      fm.exports,
      memory,
      "table-roundtrip capture module",
    );
    const externrefsStub = {
      capture: (): number => {
        throw new Error("this funcref-only table snapshot has no externref");
      },
    } as unknown as ConstructorParameters<typeof ForkCaptureSession>[1];
    const session = new ForkCaptureSession(
      captureFunctions,
      externrefsStub,
      captureModule,
      undefined,
      undefined,
      memory,
      allocate,
      noopFree,
      "table-roundtrip capture session",
    );

    const arena = new ForkModuleStateArena(
      memory,
      PTR_WIDTH,
      allocate,
      noopFree,
      "table-roundtrip arena",
    );
    const root = arena.begin();
    session.beginCapture();
    arena.appendModule({
      activationId: 0,
      templateId: new Uint8Array(32).fill(0xa0),
    });
    // Intern each catalog funcref into the module's shared builder — exactly what
    // the guest `saveTables` walk does for a funcref table entry.
    const recipes = [0, 1, 2, 3].map((ordinal) =>
      session.encodeFuncref(captureCatalog.get(ordinal)),
    );
    // The four distinct funcrefs get the four dense recipe ids after null (0).
    expect(recipes).toEqual([1, 2, 3, 4]);
    session.sealInto(arena);
    arena.seal();

    // ---- RESTORE (worker A): reconstruct through the module, decode via the
    // resident-graph oracle against the CAPTURER's own catalog. ----
    const restoreOne = (functions: ForkFunctionCatalog) => {
      // Seed the replay driver + drive plan, then make the read-only decoded
      // graph resident for the funcref oracle (same order as ForkTableSnapshot).
      const planPtr = Number(
        (fm.exports.fm_restore_from_arena as (r: number, pid: number) => number)(
          root,
          1,
        ),
      );
      expect(fm.exports.fm_last_errno()).toBe(0);
      const nodeCount = Number(
        (fm.exports.fm_decode_reference_graph as (r: number) => number)(root),
      );
      expect(fm.exports.fm_last_errno()).toBe(0);
      expect(nodeCount).toBe(5); // null + 4 funcrefs

      const oracle = {
        kind: (i: number) =>
          Number((fm.exports.fm_decoded_node_kind as (x: number) => number)(i)),
        moduleActivation: (i: number) =>
          Number(
            (fm.exports.fm_decoded_node_module_activation as (
              x: number,
            ) => number)(i),
          ),
        ordinal: (i: number) =>
          Number(
            (fm.exports.fm_decoded_node_ordinal as (x: number) => number)(i),
          ),
      };
      const recon = new ForkTableReconstruction(
        functions,
        oracle,
        () => {
          throw new Error("funcref-only snapshot must not read the transit");
        },
        { prepareTransit: () => {} },
        () => nodeCount,
        memory,
        allocate,
        noopFree,
        "table-roundtrip reconstruction",
      );
      recon.attachChild();
      recon.materializeAllTyped(() => {
        // Funcref/null-only graph => the drive plan has no drivable node.
        const count = Number(
          (fm.exports.fm_gc_plan_count as () => number)(),
        );
        expect(count).toBe(0);
      });
      return recon;
    };

    const reconA = restoreOne(captureFunctions);
    for (const ordinal of [0, 1, 2, 3]) {
      const value = reconA.decodeFuncref(recipes[ordinal]!);
      // Capture ↔ restore identity: the exact captured funcref object.
      expect(value).toBe(captureCatalog.get(ordinal));
      expect((value as () => number)()).toBe(100 + ordinal);
    }
    // The canonical null recipe reconstructs null.
    expect(reconA.decodeFuncref(0)).toBe(null);
    reconA.finishReplay();

    // ---- RESTORE (worker B): a DIFFERENT worker with its OWN catalog (values
    // 200+ordinal). The identical captured graph must resolve each recipe to
    // THIS worker's function at the same (activation, ordinal). ----
    const peerCatalog = catalogTable(200);
    const peerFunctions = new ForkFunctionCatalog();
    peerFunctions.register(ACTIVATION, peerCatalog);

    const reconB = restoreOne(peerFunctions);
    for (const ordinal of [0, 1, 2, 3]) {
      const value = reconB.decodeFuncref(recipes[ordinal]!);
      // Cross-worker ordinal stability: the PEER's own function, not the
      // capturer's — resolved by (activation, ordinal) against the peer catalog.
      expect(value).toBe(peerCatalog.get(ordinal));
      expect(value).not.toBe(captureCatalog.get(ordinal));
      expect((value as () => number)()).toBe(200 + ordinal);
    }
    reconB.finishReplay();
  });
});
