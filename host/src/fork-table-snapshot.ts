// Staying glue: the PEER-TABLE snapshot capture + restore lifecycles for the
// module-on path (Path-A A3/A4 — "Wall 1" migration).
//
// WHY THIS FILE EXISTS. `DylinkForkTableReplica` replicates a process's
// cumulative Wasm indirect-function-table state across peer Workers whenever a
// `dlopen`'d side module publishes a new generation. Its two full-checkpoint
// operations (`captureTableState` / `restoreTableState`) used to construct the
// JS `ForkReferenceTransaction` reference engine directly. That engine is being
// deleted, so the peer-table snapshot must run through the SAME co-resident
// `fork_module` the fork path already uses, with ZERO new `fm_*` exports.
//
// THE SEAM THAT SHAPES THIS FILE. A peer-table restore runs in a LIVE,
// already-instantiated worker (the process parent, a pthread, or a fork child).
// Its guest's reference-decode imports (`__wpk_fork_ref_decode_funcref` /
// `_externref`) were bound at instantiation. Only a freshly-instantiated
// QUALIFYING fork child binds them to the module; every other worker binds them
// to the JS registry surface (`registry.currentReferences()`). So — unlike the
// fork child, whose module-bound imports never call back into the host decode —
// the guest `restoreTables` walk here calls `currentReferences().decodeFuncref`
// / `decodeExternref` on the host. The reconstruction surface therefore cannot
// be the throwing `ForkModuleReconstructionFloor`; it must DECODE:
//   - funcref: resolved from the module's RESIDENT decoded-graph oracle
//     (`fm_decoded_node_*`) against THIS worker's own per-activation function
//     catalogs, so the `(activation, ordinal)` coordinate maps to the worker's
//     own table.get by construction (funcref-ordinal stability across workers).
//   - externref/GC: reconstructed by the module drive (`fm_drive_execute`) into
//     the shared anyref transit (STORE #2), then read back from that transit —
//     exactly where the module-bound child path would have left them.
//
// This file OWNS the backend composition (`decodeReferenceGraph` +
// `restoreFromArena` + `driveRestoredPlan`) and the reconstruction surface; the
// registry still owns the activation loop, arena validation, and the guest
// `saveTables` / `restoreTables` calls (they read deep registry-private state).

import type { ForkModuleContinuationBackend } from "./fork-module-backend";
import type { ForkModuleStateArena } from "./fork-module-state";
import type { ForkFunctionCatalog } from "./fork-function-catalog";
import type { ForkReferenceChildReplayAdoption } from "./fork-reference-contracts";
import type { ForkReferenceCaptureSurface } from "./fork-capture-session";
import {
  ForkModuleReconstructionFloor,
  type ForkModuleReconstructionTransitOwner,
} from "./fork-module-reconstruction";
import type {
  ForkReferenceScratchAllocate,
  ForkReferenceScratchDeallocate,
} from "./fork-reference-scratch";

/**
 * Wire node-kind discriminants of the module's resident decoded reference graph
 * (`fm_decoded_node_kind`): null 0, funcref 1, externref 2, exnref 3, i31 4,
 * struct 5, array 6, static-root 7.
 */
const WIRE_NODE_KIND_NULL = 0;
const WIRE_NODE_KIND_FUNCREF = 1;

/**
 * Read the module's RESIDENT decoded reference graph by canonical node id (==
 * recipe id). Backed by `fm_decoded_node_kind` / `_module_activation` /
 * `_ordinal` once `decodeReferenceGraph` has made the graph resident.
 */
export interface ForkTableDecodedGraphOracle {
  kind(recipeId: number): number;
  moduleActivation(recipeId: number): number;
  ordinal(recipeId: number): number;
}

/**
 * The module-composed inputs `restoreTableState` needs to reconstruct a peer
 * snapshot without the JS reference engine. Produced by `ForkTableSnapshot`.
 */
export interface ForkTableRestoreDependencies {
  /** Read the module's resident decoded graph for funcref coordinate lookup. */
  readonly oracle: ForkTableDecodedGraphOracle;
  /** Execute the module's reconstruction drive plan into the shared transit. */
  readonly drive: () => void;
  /** Node count of the resident decoded graph (STORE #2 transit sizing). */
  readonly decodedNodeCount: number;
}

/**
 * Module-on PEER-TABLE reconstruction surface. Sizes the shared anyref transit
 * and hands the whole typed reconstruction to the co-resident module (like
 * `ForkModuleReconstructionFloor`), but ALSO answers the guest `restoreTables`
 * decode imports — because a peer-table worker's guest imports are JS-bound, so
 * `decodeFuncref` / `decodeExternref` route here, not to the module.
 */
export class ForkTableReconstruction implements ForkReferenceCaptureSurface {
  private readonly floor: ForkModuleReconstructionFloor;

  constructor(
    /**
     * THIS worker's merged per-activation funcref catalogs. `decodeFuncref`
     * resolves the module oracle's `(activation, ordinal)` coordinate against
     * these, so a funcref recipe maps to the worker's own table entry — the
     * cross-worker funcref-ordinal-stability invariant.
     */
    private readonly functions: ForkFunctionCatalog,
    private readonly oracle: ForkTableDecodedGraphOracle,
    /**
     * Read the shared anyref transit (STORE #2) at recipe id `r` (slot `r+1`),
     * where the module drive published this snapshot's externref/GC identities.
     */
    private readonly readTransit: (recipeId: number) => unknown,
    transit: ForkModuleReconstructionTransitOwner,
    decodedNodeCount: () => number,
    memory?: WebAssembly.Memory,
    allocateScratch?: ForkReferenceScratchAllocate,
    deallocateScratch?: ForkReferenceScratchDeallocate,
    private readonly label = "fork table reconstruction",
  ) {
    this.floor = new ForkModuleReconstructionFloor(
      transit,
      decodedNodeCount,
      memory,
      allocateScratch,
      deallocateScratch,
      this.label,
    );
  }

  // --- Lifecycle: the module owns the reconstruction; delegate to the floor. ---

  attachChild(
    // The module owns the decoded graph; the wire `source` is accepted only to
    // satisfy the shared surface (and the registry's `attachChild(records)`
    // call) and is not consumed here.
    _source?: unknown,
  ): void {
    this.floor.attachChild();
  }

  adoptChildReplay(adoption: ForkReferenceChildReplayAdoption): void {
    this.floor.adoptChildReplay(adoption);
  }

  materializeAllTyped(moduleDrive?: () => void): void {
    this.floor.materializeAllTyped(moduleDrive);
  }

  finishReplay(): void {
    this.floor.finishReplay();
  }

  abort(): void {
    this.floor.abort();
  }

  reserveScratch(size: number | bigint): number {
    return this.floor.reserveScratch(size);
  }

  releaseScratch(pointer: number | bigint, size: number | bigint): void {
    this.floor.releaseScratch(pointer, size);
  }

  // --- Decode: answered here (JS-bound guest imports call back into the host). ---

  decodeFuncref(recipeId: number): CallableFunction | null {
    if (recipeId === 0) return null;
    const kind = this.oracle.kind(recipeId);
    if (kind === WIRE_NODE_KIND_NULL) return null;
    if (kind !== WIRE_NODE_KIND_FUNCREF) {
      throw new TypeError(
        `${this.label}: table recipe ${recipeId} is kind ${kind}, not a funcref`,
      );
    }
    return this.functions.decode({
      moduleActivation: this.oracle.moduleActivation(recipeId),
      ordinal: this.oracle.ordinal(recipeId),
    });
  }

  decodeExternref(recipeId: number): unknown {
    if (recipeId === 0) return null;
    // The module drive republished this snapshot's externref/GC identities into
    // the shared anyref transit at `recipe + 1`; read the reconstructed value.
    return this.readTransit(recipeId);
  }

  // --- Capture-only + JS-reconstruction-only surface: never reached here. ---
  // Capture runs in `ForkCaptureSession`; the module owns the typed drive. These
  // exist solely so one `ForkReferenceCaptureSurface` type covers every engine.

  private unavailable(operation: string): never {
    throw new Error(
      `${this.label}: ${operation} does not run on the table reconstruction surface`,
    );
  }

  setExceptionSlotProvider(): never {
    this.unavailable("set exception slot provider");
  }

  beginCapture(): never {
    this.unavailable("begin capture");
  }

  encodeFuncref(): never {
    this.unavailable("encode funcref");
  }

  reserveGatedPlaceholder(): never {
    this.unavailable("reserve gated placeholder");
  }

  lookupGcSlot(): never {
    this.unavailable("look up a Wasm-GC identity");
  }

  claimGcSlot(): never {
    this.unavailable("claim a Wasm-GC identity");
  }

  encodeI31(): never {
    this.unavailable("encode an i31ref");
  }

  capturedGcValue(): never {
    this.unavailable("read a captured Wasm-GC identity");
  }

  defineGc(): never {
    this.unavailable("define a Wasm-GC recipe");
  }

  routeGc(): never {
    this.unavailable("route a Wasm-GC recipe");
  }

  gcPayloadLength(): never {
    this.unavailable("read a Wasm-GC payload length");
  }

  loadGc(): never {
    this.unavailable("load a Wasm-GC recipe");
  }

  sealInto(): never {
    this.unavailable("seal a capture");
  }

  beginParentReplay(): never {
    this.unavailable("begin parent replay");
  }

  borrowedReplayScratchCapacity(): never {
    this.unavailable("read borrowed replay scratch capacity");
  }

  beginReferenceVector(): never {
    this.unavailable("begin a reference vector");
  }

  appendReferenceVector(): never {
    this.unavailable("append a reference vector");
  }

  finishReferenceVector(): never {
    this.unavailable("finish a reference vector");
  }

  getReferenceVector(): never {
    this.unavailable("read a reference vector");
  }

  lookupExceptionSlot(): never {
    this.unavailable("look up an exception identity");
  }

  claimExceptionSlot(): never {
    this.unavailable("claim an exception identity");
  }

  captureHostException(): never {
    this.unavailable("capture a host exception");
  }

  exceptionOwner(): never {
    this.unavailable("read an exception owner");
  }

  materializeHostException(): never {
    this.unavailable("materialize a host exception");
  }

  exceptionCacheIndex(): never {
    this.unavailable("read an exception cache index");
  }

  defineException(): never {
    this.unavailable("define an exception recipe");
  }

  routeException(): never {
    this.unavailable("route an exception recipe");
  }

  loadException(): never {
    this.unavailable("load an exception recipe");
  }
}

/**
 * The narrow registry surface `ForkTableSnapshot` drives. The registry still
 * owns the activation loop, arena validation, and the guest `saveTables` /
 * `restoreTables` calls (all deep registry-private state); this snapshot owns
 * the module composition that feeds them.
 */
export interface ForkTableSnapshotRegistry {
  /** Seal one process-wide, module-graph table snapshot for peer Workers. */
  captureTableState(arena: ForkModuleStateArena): number;
  /** Apply one validated peer snapshot, reconstructing through the module. */
  restoreTableState(
    arena: ForkModuleStateArena,
    deps: ForkTableRestoreDependencies,
  ): void;
}

/**
 * Peer-table snapshot lifecycle over the co-resident fork module. Capture is
 * delegated straight to the registry (its `ForkCaptureSession` + guest
 * `saveTables` build the module graph). Restore composes the module surface —
 * `decodeReferenceGraph` (resident graph for the funcref oracle + node count),
 * `restoreFromArena` (seed the replay driver + build the drive plan, both
 * generation-free), `driveRestoredPlan` (reconstruct externref/GC into the
 * shared transit) — and hands those to the registry's module reconstruction.
 */
export class ForkTableSnapshot {
  constructor(
    private readonly registry: ForkTableSnapshotRegistry,
    /**
     * The co-resident module reconstruction backend. Null when the fork module
     * is disabled for this worker; peer-table replication then fails loudly
     * (there is no JS reference-engine fallback — that engine is being deleted).
     */
    private readonly backend: ForkModuleContinuationBackend | null,
    private readonly label: string,
  ) {}

  capture(arena: ForkModuleStateArena): number {
    return this.registry.captureTableState(arena);
  }

  restore(arena: ForkModuleStateArena): void {
    const backend = this.requireBackend();
    const root = arena.rootAddress();
    // Seed the replay driver + build the reconstruction drive plan (this is the
    // reconstruction-only entry — it appends NO guest restore/finish steps,
    // because a table install is single-phase and the guest `restoreTables`
    // loop runs host-side, not as a drive-plan op).
    const planPtr = backend.restoreFromArena(root);
    // Make the read-only decoded graph resident for the funcref oracle AND get
    // its node count for STORE #2 transit sizing. Distinct from the driver
    // seed above; it survives the drive.
    const decodedNodeCount = backend.decodeReferenceGraph(root);
    this.registry.restoreTableState(arena, {
      oracle: {
        kind: (recipeId) => backend.decodedNodeKind(recipeId),
        moduleActivation: (recipeId) =>
          backend.decodedNodeModuleActivation(recipeId),
        ordinal: (recipeId) => backend.decodedNodeOrdinal(recipeId),
      },
      drive: () => {
        backend.driveRestoredPlan(planPtr);
      },
      decodedNodeCount,
    });
  }

  private requireBackend(): ForkModuleContinuationBackend {
    if (!this.backend) {
      throw new Error(
        `${this.label}: peer table replication requires the co-resident fork `
          + "module (no JS reference-engine fallback exists)",
      );
    }
    return this.backend;
  }
}
