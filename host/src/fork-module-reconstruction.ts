// Staying glue: the fork CHILD-RECONSTRUCTION floor for the module-on path.
//
// WHY THIS FILE EXISTS (child-reconstruction severance / Path-A). On the
// module-on fork path the co-resident `fork_module` is the SOLE reconstructor:
// the reference decode (`__wpk_fork_ref_decode_*`) and the seven RESTORE
// data-feed imports are flipped to the module, and the whole topological
// drive-order (`fm_build_gc_plan` + `fm_drive_execute`) runs in Rust. The JS
// reconstruction ALGORITHM therefore does not run on this path
// (`materializeAllTyped(moduleDrive)` delegates the whole walk to the module).
//
// What remained was a `ForkReferenceTransaction` OBJECT constructed on the
// child path purely as a FLOOR WRAPPER, playing three roles that are all
// module-backed now:
//   1. Decoded graph — the module holds its own RESIDENT decoded graph
//      (`fm_decode_reference_graph`, made resident in `worker-main` before the
//      attach), so no JS decode is needed for reconstruction.
//   2. Transit sizing — the anyref STORE #2 table is grown to cover every
//      recipe id; the size is `fm_decoded_node_count() - 1` (the module's
//      resident graph node count), not a JS-decoded node-directory length.
//   3. Early-provider adoption target — imported-global identities the
//      pre-instantiation floor reconstructed are coordinated through the SHARED
//      anyref transit (`publishEarlyGcTransit`), NOT through this object, so on
//      the module path the adopted state is inert; the target is validate-only.
//
// This floor owns exactly those three roles with no JS reference-graph engine.
// It satisfies the shared `ForkReferenceCaptureSurface` so the registry can
// hold it behind `currentReferences()` like the capture/flag-off engines; every
// capture-only and JS-reconstruction-only method throws (the module owns them),
// exactly as `ForkCaptureSession` stubs its reconstruction-only surface.

import type { ForkReferenceCaptureSurface } from "./fork-capture-session";
import type { ForkReferenceChildReplayAdoption } from "./fork-reference-contracts";
import {
  ForkReferenceScratchArena,
  type ForkReferenceScratchAllocate,
  type ForkReferenceScratchDeallocate,
} from "./fork-reference-scratch";

/**
 * The one transit operation the reconstruction floor needs from the registry's
 * typed replay owner: grow the shared anyref STORE #2 table to cover every
 * recipe id before the module's injected drive shim writes `table.set(recipe+1)`
 * (the shim writes, it does not grow). Structurally satisfied by the registry's
 * `typedReplayOwner()`; typed minimally here so this floor never imports the
 * deletable JS engine.
 */
export interface ForkModuleReconstructionTransitOwner {
  prepareTransit(maxRecipeId: number): void;
}

type ReconstructionPhase = "idle" | "child-replay" | "done";

/**
 * Module-on fork child-reconstruction floor. Sizes the shared anyref transit
 * from the module's resident decoded graph and lets the co-resident module drive
 * the whole reconstruction; holds NO decoded graph and NO reconstructed
 * identities of its own.
 */
export class ForkModuleReconstructionFloor
  implements ForkReferenceCaptureSurface
{
  private phase: ReconstructionPhase = "idle";
  private adopted = false;
  private materialized = false;
  /**
   * Stack-disciplined transient allocator over the copied process memory. The
   * module drives reconstruction, but each activation's guest GC codec
   * (`_gc_allocate` / `_gc_fill`) still stages its scalar payload through the
   * host `__wpk_fork_ref_scratch_reserve` / `_release` imports (NOT flipped to
   * the module), so this floor owns the same scratch arena the JS engine did.
   */
  private readonly scratch: ForkReferenceScratchArena;

  constructor(
    private readonly transit: ForkModuleReconstructionTransitOwner,
    /**
     * Node count of the module's RESIDENT decoded reference graph
     * (`fm_decoded_node_count`, made resident by `fm_decode_reference_graph`
     * before this floor attaches). Byte-identical to the JS decode's node
     * directory length — it is the same shared arena decode.
     */
    private readonly decodedNodeCount: () => number,
    memory?: WebAssembly.Memory,
    allocateScratch?: ForkReferenceScratchAllocate,
    deallocateScratch?: ForkReferenceScratchDeallocate,
    private readonly label = "fork module reconstruction floor",
  ) {
    this.scratch = new ForkReferenceScratchArena(
      memory,
      allocateScratch,
      deallocateScratch,
      this.label,
    );
  }

  /**
   * Enter child reconstruction. The module owns the decoded graph, so the wire
   * `source` is not consumed here (the JS engine used it to seed its own decode,
   * exception-cache indexes, and static-root pins — all module-owned now). It is
   * accepted only to satisfy the shared surface.
   */
  attachChild(): void {
    if (this.phase !== "idle") {
      throw new Error(
        `${this.label}: cannot attach child while floor is ${this.phase}`,
      );
    }
    this.phase = "child-replay";
  }

  /**
   * Adopt the pre-instantiation imported-global reconstruction prefix.
   *
   * On the module path the genuine coordination is through the SHARED anyref
   * transit (`publishEarlyGcTransit`), which the early provider already wrote;
   * the adoption payload's staged values / typed milestones are inert here
   * because the module reconstructs the graph in Rust. So this is validate-only:
   * enforce the one-shot ordering (after attach, before typed materialization,
   * at most once) and otherwise take no ownership.
   */
  adoptChildReplay(_adoption: ForkReferenceChildReplayAdoption): void {
    if (this.phase !== "child-replay") {
      throw new Error(
        `${this.label}: cannot adopt early child references while floor is ${this.phase}`,
      );
    }
    if (this.materialized) {
      throw new Error(
        `${this.label}: cannot adopt early child references after typed materialization`,
      );
    }
    if (this.adopted) {
      throw new Error(`${this.label}: early child reference replay was adopted twice`);
    }
    this.adopted = true;
  }

  /**
   * Size the shared anyref transit from the module's resident graph, then hand
   * the ENTIRE typed reconstruction to the co-resident module. The floor is used
   * only on the module-drive path, so a missing `moduleDrive` is a broken
   * invariant (fail loud), never a JS fallback.
   */
  materializeAllTyped(moduleDrive?: () => void): void {
    if (this.phase !== "child-replay") {
      throw new Error(
        `${this.label}: cannot materialize typed references while floor is ${this.phase}`,
      );
    }
    if (this.materialized) {
      throw new Error(`${this.label}: typed fork references were materialized twice`);
    }
    if (!moduleDrive) {
      throw new Error(
        `${this.label}: module reconstruction requires the module drive delegate`,
      );
    }
    const nodeCount = this.decodedNodeCount();
    if (!Number.isInteger(nodeCount) || nodeCount < 0) {
      throw new Error(
        `${this.label}: module reported an invalid decoded node count ${nodeCount}`,
      );
    }
    // STORE #2 sizing: the module's injected drive shim writes slot `recipe+1`
    // but never grows the table, so the host floor sizes it to cover the highest
    // recipe id (node count - 1). Recipe 0 is the canonical null (no slot).
    this.transit.prepareTransit(Math.max(0, nodeCount - 1));
    this.materialized = true;
    moduleDrive();
  }

  finishReplay(): void {
    if (this.phase !== "child-replay") {
      throw new Error(
        `${this.label}: cannot finish reference replay while floor is ${this.phase}`,
      );
    }
    this.reset();
  }

  abort(): void {
    if (this.phase === "idle") return;
    this.reset();
  }

  private reset(): void {
    const firstScratchError = this.scratch.reset();
    this.phase = "done";
    this.adopted = false;
    this.materialized = false;
    if (firstScratchError !== undefined) throw firstScratchError;
  }

  // --- Capture-only + JS-reconstruction-only surface: never reached here. ---
  // Capture runs in `ForkCaptureSession` (module-on) or `ForkReferenceTransaction`
  // (flag-off / peer-table); the fresh-child reference decode + RESTORE data feed
  // are flipped to the co-resident module on this path. These exist solely so one
  // `ForkReferenceCaptureSurface` type covers every engine, and throw if reached.

  private unavailable(operation: string): never {
    throw new Error(
      `${this.label}: ${operation} does not run on the module reconstruction floor`,
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

  decodeFuncref(): never {
    this.unavailable("decode a funcref");
  }

  decodeExternref(): never {
    this.unavailable("decode an externref");
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

  reserveScratch(size: number | bigint): number {
    if (this.phase !== "child-replay") {
      throw new Error(
        `${this.label}: cannot reserve reference scratch while floor is ${this.phase}`,
      );
    }
    return this.scratch.reserve(size);
  }

  releaseScratch(pointer: number | bigint, size: number | bigint): void {
    if (this.phase !== "child-replay") {
      throw new Error(
        `${this.label}: cannot release reference scratch while floor is ${this.phase}`,
      );
    }
    this.scratch.release(pointer, size);
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
