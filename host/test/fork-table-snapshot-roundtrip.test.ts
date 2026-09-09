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
import { ForkAnyrefTransitTable } from "../src/fork-anyref-transit";
import { ForkFunctionCatalog } from "../src/fork-function-catalog";
import { ForkModuleStateArena } from "../src/fork-module-state";
import { ForkReferenceCaptureModule } from "../src/fork-reference-capture-module";
import { ForkCaptureSession } from "../src/fork-capture-session";
import { ForkExternrefProvenanceTable } from "../src/fork-externref-provenance";
import { ForkTableReconstruction } from "../src/fork-table-snapshot";

const PAGE = 65536;
const PTR_WIDTH = 4 as const;
// The single activation every funcref in this snapshot belongs to.
const ACTIVATION = 7;

// The committed GC-codec (KFGC) fixture. Seeding a GC codec for the activation
// is a prerequisite for building ANY typed-GC drive plan (`fm_build_gc_plan`
// EINVALs otherwise — the documented gate the i31 case below must satisfy),
// even though a scalar i31 leaf consults no struct/array layout itself.
const GC_CODEC = new Uint8Array(
  readFileSync(
    new URL(
      "../../crates/fork-codec/testdata/gc-codec-wasm32.bin",
      import.meta.url,
    ),
  ),
);

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

  it("captures a NON-funcref (externref) table entry through the module and reconstructs its identity via the shared anyref transit (STORE #2)", () => {
    // Coverage gap closed (A6 note a): the funcref round-trip above stubs the
    // externref/GC transit read (its `readTransit` throws), so only
    // funcref-in-tables was exercised. This drives a NON-funcref reference kind —
    // an externref — through the SAME peer-table snapshot path
    // (`ForkCaptureSession` capture -> `ForkTableReconstruction` restore),
    // proving externref-in-tables reconstructs through the module's REAL anyref
    // transit (STORE #2), not just funcref catalog lookup. Capture records the
    // externref's broker handle via production-site provenance and interns it
    // through the module graph; restore's DRIVE_OP_EXTERNREF_TRANSIT step
    // re-resolves the handle through the `env.resolve_externref` seam and
    // republishes the canonical token into the transit, where the table decode
    // surface reads it back.
    const memory = new WebAssembly.Memory({
      initial: 256,
      maximum: 16384,
      shared: true,
    });

    // A funcref catalog is still required (the arena declares an activation and
    // the reconstruction merges per-activation catalogs), even though this
    // snapshot carries no funcref recipe.
    const captureCatalog = catalogTable(100);
    const captureFunctions = new ForkFunctionCatalog();
    captureFunctions.register(ACTIVATION, captureCatalog);

    // The externref this snapshot carries. Its durable broker handle and the
    // canonical token `env.resolve_externref` re-mints for that handle on
    // restore. A worker resolves the handle to its OWN canonical token; here one
    // module instance models both, so the token is shared.
    const EXTERNREF_HANDLE = 55;
    const canonicalToken = { externref: "peer-table-externref-token" };
    const resolveExternref = (handle: number): unknown => {
      if (handle !== EXTERNREF_HANDLE) {
        throw new Error(`unexpected externref handle ${handle}`);
      }
      return canonicalToken;
    };

    const reserveBase = 8 * 1024 * 1024;
    const module = new WebAssembly.Module(
      readFileSync(resolveBinary("fork_module32.wasm")),
    );
    const fm = instantiateForkModule({
      module,
      memory,
      ptrWidth: PTR_WIDTH,
      reserve: () => reserveBase,
      label: "table-roundtrip-externref-test",
      functionCatalog: captureCatalog,
      resolveExternref,
    });
    (fm.exports.fm_set_format as (pw: number, fixedPrefix: number) => void)(
      PTR_WIDTH,
      0,
    );

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

    // The module's OWN exported anyref transit (STORE #2), where the drive
    // republishes the reconstructed externref identity at slot `recipe + 1`.
    const transit = new ForkAnyrefTransitTable(
      fm.exports.__wpk_fork_ref_gc_transit as WebAssembly.Table,
    );

    // ---- CAPTURE: intern the externref through the real module graph. ----
    // Production records an externref's broker handle at its host-import mint
    // site; model that with a provenance table mapping the live token -> handle.
    const externrefProvenance = new ForkExternrefProvenanceTable();
    externrefProvenance.register(canonicalToken, EXTERNREF_HANDLE);
    // A guest anyref slot holding the live externref, exactly what the guest
    // `saveTables` walk hands `lookupGcSlot` for an externref table entry.
    const guestExternrefTable = new WebAssembly.Table({
      element: "externref",
      initial: 1,
    });
    guestExternrefTable.set(0, canonicalToken);

    const captureModule = new ForkReferenceCaptureModule(
      fm.exports,
      memory,
      "table-roundtrip externref capture module",
    );
    const externrefsStub = {
      capture: (): number => {
        throw new Error(
          "this externref table snapshot captures via provenance, not the "
            + "exnref-payload seam",
        );
      },
    } as unknown as ConstructorParameters<typeof ForkCaptureSession>[1];
    const session = new ForkCaptureSession(
      captureFunctions,
      externrefsStub,
      captureModule,
      undefined,
      externrefProvenance,
      memory,
      allocate,
      noopFree,
      "table-roundtrip externref capture session",
    );

    const arena = new ForkModuleStateArena(
      memory,
      PTR_WIDTH,
      allocate,
      noopFree,
      "table-roundtrip externref arena",
    );
    const root = arena.begin();
    session.beginCapture();
    arena.appendModule({
      activationId: 0,
      templateId: new Uint8Array(32).fill(0xa0),
    });
    // Capture the externref by (table, slot), resolving its recorded provenance
    // handle and interning it into the shared module graph.
    const externrefRecipe = session.lookupGcSlot(guestExternrefTable, 0);
    // Recipe 0 is the canonical null; the externref is the first real node.
    expect(externrefRecipe).toBe(1);
    session.sealInto(arena);
    arena.seal();

    // Seed the activation's GC codec AFTER the arena is sealed (so the arena's
    // own chunk allocation stays first/aligned), copied from guest memory like a
    // real worker's init does. A prerequisite for building the reconstruction
    // drive plan through the typed-GC substrate.
    const codecPtr = allocate(GC_CODEC.byteLength);
    new Uint8Array(memory.buffer, codecPtr, GC_CODEC.byteLength).set(GC_CODEC);
    (fm.exports.fm_set_activation_gc_codec as (
      act: number,
      ptr: number,
      len: number,
    ) => void)(0, codecPtr, GC_CODEC.byteLength);
    expect(fm.exports.fm_last_errno()).toBe(0);

    // Present the activation's drive-table base slots (the `fm_drive_execute`
    // shim addresses steps at `fm_drive_table_base(0) + op`). The externref
    // transit-publish step re-resolves through the `env.resolve_externref` host
    // seam and needs no guest `_gc_allocate`/`_gc_fill` binding, but the base
    // slots must exist so the shim's table access stays in bounds.
    const driveBase = (fm.exports.fm_drive_table_base as (a: number) => number)(
      0,
    );
    if (fm.driveTable.length < driveBase + 5) {
      fm.driveTable.grow(driveBase + 5 - fm.driveTable.length);
    }

    // ---- RESTORE: drive the module reconstruction into the shared transit,
    // then read the reconstructed externref back through the table decode
    // surface (`decodeExternref` -> `readTransit`). ----
    const restoreOne = (functions: ForkFunctionCatalog) => {
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
      expect(nodeCount).toBe(2); // null + externref
      // The module classifies the node as an externref (wire kind 2), NOT a
      // funcref (kind 1) — the decode surface must route it through the transit,
      // not the funcref catalog.
      expect(
        Number((fm.exports.fm_decoded_node_kind as (x: number) => number)(
          externrefRecipe,
        )),
      ).toBe(2);

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
        // Read the reconstructed identity the drive published into STORE #2.
        (recipeId) => transit.get(recipeId + 1),
        {
          prepareTransit: (maxRecipeId: number) => {
            if (maxRecipeId > 0) transit.ensureRecipeSlot(maxRecipeId);
          },
        },
        () => nodeCount,
        memory,
        allocate,
        noopFree,
        "table-roundtrip externref reconstruction",
      );
      recon.attachChild();
      recon.materializeAllTyped(() => {
        // The externref leaf produces a real drive step (a transit publish),
        // unlike the funcref-only snapshot whose plan is empty.
        const count = Number((fm.exports.fm_gc_plan_count as () => number)());
        expect(count).toBeGreaterThan(0);
        (fm.exports.fm_drive_execute as (ptr: number, count: number) => void)(
          planPtr,
          count,
        );
      });
      return recon;
    };

    // Worker A: reconstruct against the capturer's own catalog. The externref
    // re-resolves through `env.resolve_externref` to the canonical token and is
    // read back from the shared transit through the anyref decode surface.
    const reconA = restoreOne(captureFunctions);
    expect(reconA.decodeExternref(externrefRecipe)).toBe(canonicalToken);
    reconA.finishReplay();

    // Worker B: a DIFFERENT worker (own funcref catalog). The externref handle
    // re-resolves to that worker's own canonical token (here the shared module
    // models both) — externref-in-tables reconstructs through the peer-table
    // snapshot path regardless of the reconstructing worker.
    const peerFunctions = new ForkFunctionCatalog();
    peerFunctions.register(ACTIVATION, catalogTable(200));
    const reconB = restoreOne(peerFunctions);
    expect(reconB.decodeExternref(externrefRecipe)).toBe(canonicalToken);
    reconB.finishReplay();
  });
});
