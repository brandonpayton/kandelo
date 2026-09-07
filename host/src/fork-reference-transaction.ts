import {
  type ForkModuleStateArena,
  type ForkModuleStateRecordKind,
} from "./fork-module-state";
import {
  type ForkReferenceRecipeEntry,
  type ForkReferenceRecipeNode,
} from "./fork-reference-recipes";
import {
  appendSegmentedForkReferenceTransaction,
  decodeSegmentedForkReferenceTransaction,
  findForkReferenceVectorOrdinal,
  forkReferenceVectorFrom,
  ForkReferenceDirectoryOverlay,
  ForkReferenceVectorBuilder,
  indexForkReferenceVector,
  PagedForkReferenceDirectory,
  PagedForkReferenceVector,
  type DecodedSegmentedForkReferenceTransaction,
  type ForkReferenceDirectory,
  type ForkReferenceVector,
  type MutableForkReferenceVectorInternIndex,
} from "./fork-reference-segments";
import { ForkFunctionCatalog } from "./fork-function-catalog";
import {
  FORK_GC_FIELD_ALLOCATION_DEPENDENCY,
  FORK_GC_FIELD_MUTABLE,
  FORK_GC_FIELD_REFERENCE,
  FORK_GC_LAYOUT_DEFAULTABLE_SHELL,
  FORK_GC_LAYOUT_REQUIRES_PROVENANCE,
  ForkGcConstructorKind,
  type ForkGcCodecDescriptor,
  type ForkGcCodecProvider,
  type ForkGcConstructorProvenance,
  type ForkGcLayoutDescriptor,
} from "./fork-gc-codec";
import { ForkStaticRootCatalog } from "./fork-static-root-catalog";
import type { ForkExternrefProvenanceTable } from "./fork-externref-provenance";
import {
  FORK_CAPTURE_KIND_ARRAY,
  FORK_CAPTURE_KIND_EXNREF,
  FORK_CAPTURE_KIND_STRUCT,
  type ForkReferenceCaptureModule,
} from "./fork-reference-capture-module";
import {
  WPK_FORK_REFERENCE_TRANSACTION_OWNER,
} from "./generated/abi";

/**
 * Per-segment copy window for the module's `fm_capture_serialize` (bytes). A
 * single window per section for the common small graph; the module bounds each
 * KFRS segment to this, so the value only affects segment COUNT, never content.
 */
const FORK_CAPTURE_SEGMENT_WINDOW = 1 << 16;

/**
 * The owner id is local to the ReferenceRecipe record kind. One process fork
 * has one identity space shared by main-module frames, side-module frames,
 * globals, and tables, so aliases never become module-local by accident.
 */
export const FORK_REFERENCE_TRANSACTION_OWNER_ID =
  WPK_FORK_REFERENCE_TRANSACTION_OWNER;
export const FORK_HOST_EXCEPTION_ACTIVATION_ID = 0xffff_ffff;
// Generated Wasm carries recipe IDs and vector ordinals as raw i32 bits. The
// host import boundary normalizes signed JavaScript arguments with `>>> 0`, so
// the complete u32 namespace is available; zero alone is the empty sentinel.
const MAX_REFERENCE_VECTOR_ORDINAL = 0xffff_ffff;

export interface ForkExternrefRecipeProvider {
  /**
   * Move an opaque value under process-owned lifetime management and return
   * the scalar handle that is safe to copy through the continuation.
   */
  capture(value: unknown): number;

  /**
   * Produce this Worker's canonical token for a process-owned handle.
   * The real host value remains with the provider's owner.
   */
  materialize(handle: number): unknown;

  /**
   * Lookup-only handle extraction: read a handle back from a value that is
   * ALREADY self-describing (e.g. a canonical worker-local token), never
   * minting a new handle for a value with none. Used by
   * `ForkActivationRegistry.recordExternrefProvenance` (the
   * `__wpk_fork_ref_provenance_externref` host-import body) so a sound,
   * never-mint provenance recording never risks `capture()`'s unclaimed-value
   * fallback.
   */
  tryEncode(value: unknown): number | undefined;
}

export interface ForkExceptionSlotProvider {
  /** Throw the exact exnref held in a Wasm-only scratch slot. */
  throwSlot(slot: number): never;
  /** Release every Wasm scratch-table root after replay or abort. */
  clearSlots(): void;
}

export type ForkReferenceScratchAllocate = (size: number) => number;
export type ForkReferenceScratchDeallocate = (addr: number, size: number) => void;

/**
 * Late-bound process owner used only in a fresh child. Keeping this scalar
 * interface on the transaction prevents GC/exn references from crossing the
 * JavaScript boundary while still allowing graph-wide validation and ordering.
 */
export interface ForkTypedReferenceReplayOwner {
  prepareTransit(maxRecipeId: number): void;
  /**
   * Publish an instantiation-owned GC root at its canonical recipe slot.
   *
   * Generated codecs publish reconstructed struct/array/i31 identities
   * themselves. Static roots already exist in the fresh activation, so the
   * host must route that exact identity before a constructor or field fill
   * consumes it as a graph edge.
   */
  publishTransit(recipeId: number, value: unknown): void;
  /**
   * Publish an opaque process-owned leaf through a generated
   * `any.convert_extern`, preserving the canonical token without asking
   * JavaScript to manufacture an anyref.
   */
  publishExternref(recipeId: number, value: unknown): void;
  provider(activationId: number): ForkGcCodecProvider;
  providers(): readonly ForkGcCodecProvider[];
  validateExceptionOwner(activationId: number): void;
  materializeException(recipeId: number, activationId: number): void;
}

/**
 * Canonical identities materialized before every fresh activation exists.
 *
 * Imported immutable reference globals must be supplied while their consumer
 * is instantiated. The early child provider therefore reconstructs a strict
 * prefix of the process graph before the full replay transaction can attach.
 * Adoption transfers those identities and typed-codec milestones so replay
 * never allocates a second object for a recipe already visible to Wasm.
 */
export interface ForkReferenceChildReplayAdoption {
  /** Exact decoded KFRV transaction object that produced this state. */
  readonly transaction: DecodedSegmentedForkReferenceTransaction;
  /**
   * Sparse canonical values. A Map is required because `undefined` is a valid
   * externref and must remain distinct from an unmaterialized recipe.
   */
  readonly materializedValues: ReadonlyMap<number, unknown>;
  readonly allocatedTypedRecipes: ReadonlySet<number>;
  readonly filledTypedRecipes: ReadonlySet<number>;
  readonly materializedExceptionRecipes: ReadonlySet<number>;
}

export interface ForkGcDefinitionProvenance {
  readonly record: ForkGcConstructorProvenance;
  readonly recipeIds: readonly number[];
}

interface ScratchChunk {
  readonly addr: number;
  readonly size: number;
  used: number;
}

interface ScratchReservation {
  readonly addr: number;
  readonly requestedSize: number;
  readonly alignedSize: number;
  readonly previousUsed: number;
  readonly chunk: ScratchChunk;
}

interface CaptureReferenceVector {
  readonly expectedLength: number;
  readonly builder: ForkReferenceVectorBuilder;
}

type CanonicalReferenceVector = ForkReferenceVector;

type TransactionPhase =
  | "idle"
  | "capture"
  | "sealed-parent"
  | "parent-replay"
  | "child-replay";

function assertRecipeId(value: number): void {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new RangeError(`invalid fork reference recipe id ${value}`);
  }
}

export type DecodedForkReferenceTransaction =
  DecodedSegmentedForkReferenceTransaction;

/**
 * Validate and expose the one process-wide reference graph in a sealed arena.
 *
 * This is shared by fresh-child reconstruction and the kernel-side externref
 * owner. WHY: the owner must acquire the child's numeric handle lease before
 * starting its Worker, but it must validate the exact same KFRV bytes that the
 * child will later consume rather than maintaining a second permissive parser.
 */
export function decodeForkReferenceTransactionRecord(
  records: Parameters<typeof decodeSegmentedForkReferenceTransaction>[0],
): DecodedForkReferenceTransaction {
  return decodeSegmentedForkReferenceTransaction(
    records,
    FORK_REFERENCE_TRANSACTION_OWNER_ID,
  );
}

/**
 * Per-fork owner for activation reference recipes.
 *
 * Recipe id zero is node zero and the canonical null value. Every nonnull
 * recipe id is its graph node id. Seeding the graph this way keeps reference
 * payload vectors lossless: a null field is an ordinary edge to node zero,
 * while zero remains cheap in every generated typed codec.
 */
export class ForkReferenceTransaction {
  private phase: TransactionPhase = "idle";
  private readonly nodes =
    new PagedForkReferenceDirectory<ForkReferenceRecipeEntry>();
  private readonly capturedValues =
    new PagedForkReferenceDirectory<unknown>();
  private objectIds = new WeakMap<object, number>();
  private readonly primitiveIds = new Map<unknown, number>();
  private decodedNodes: ForkReferenceDirectory<ForkReferenceRecipeEntry> =
    new PagedForkReferenceDirectory();
  private readonly materializedValues = new Map<number, unknown>();
  private readonly pendingExceptions = new Set<number>();
  private readonly pendingGc = new Set<number>();
  private readonly i31Ids = new Map<number, number>();
  private readonly exceptionCacheIndexes = new Map<number, number>();
  private exceptionSlots: ForkExceptionSlotProvider | undefined;
  private readonly scratchChunks: ScratchChunk[] = [];
  private readonly scratchReservations: ScratchReservation[] = [];
  private scratchCapacityBytes = 0;
  private scratchCapacityHighWaterBytes = 0;
  /** Index zero is the canonical empty-vector sentinel. */
  private readonly referenceVectors =
    new PagedForkReferenceDirectory<CanonicalReferenceVector>();
  private readonly pendingReferenceVectors = new Map<
    number,
    CaptureReferenceVector
  >();
  private readonly freeReferenceVectorHandles: number[] = [];
  private nextReferenceVectorHandle = 1;
  /**
   * Path B P3 (module capture): per-open-vector length bookkeeping keyed by the
   * MODULE's vector handle. The module owns the vector contents; the host keeps
   * only the declared/observed length so `finishReferenceVector` still enforces
   * the guest's `expectedLength` contract (the module has no such check).
   */
  private readonly moduleVectorLengths = new Map<
    number,
    { expected: number; count: number }
  >();
  private readonly referenceVectorIntern:
    MutableForkReferenceVectorInternIndex = new Map();
  private readonly decodedReferenceVectors =
    new ForkReferenceDirectoryOverlay<ForkReferenceVector>();
  private readonly decodedReferenceVectorIntern:
    MutableForkReferenceVectorInternIndex = new Map();
  private readonly replayGcVectors = new Map<number, number>();
  private typedMaterialized = false;
  private childTransaction: DecodedSegmentedForkReferenceTransaction | null = null;
  private childReplayAdopted = false;
  private readonly adoptedAllocatedTypedRecipes = new Set<number>();
  private readonly adoptedFilledTypedRecipes = new Set<number>();
  private readonly adoptedMaterializedExceptionRecipes = new Set<number>();

  constructor(
    readonly functions: ForkFunctionCatalog,
    private readonly externrefs: ForkExternrefRecipeProvider,
    private readonly memory?: WebAssembly.Memory,
    private readonly allocateScratch?: ForkReferenceScratchAllocate,
    private readonly deallocateScratch?: ForkReferenceScratchDeallocate,
    private readonly label = "fork reference transaction",
    private readonly staticRoots?: ForkStaticRootCatalog,
    private readonly typedReplay?: ForkTypedReferenceReplayOwner,
    /**
     * Local, same-realm provenance lookup for a plain host externref reached
     * through the anyref-transit `GC_LOOKUP` seam (N1 Node/browser parity).
     * Lookup-only: `lookupGcSlot` never mints through this table.
     */
    private readonly externrefProvenance?: ForkExternrefProvenanceTable,
    /**
     * Path B P3: when present, reference CAPTURE routes through the co-resident
     * fork-module's shared `ReferenceGraphBuilder` (the `fm_capture_*` exports)
     * instead of this class's JavaScript node/vector tables — the module is the
     * SOLE capture graph. The per-host identity floor stays here (the
     * `capturedValues` originals for the parent's own replay, the `objectIds`
     * live-value dedup for a claimed GC value, the externref-provenance `WeakMap`,
     * and the transit publish); only the graph construction/dedup/serialization
     * moves to shared Rust, mirroring native's `guest.rs` capture bodies.
     */
    private readonly captureModule?: ForkReferenceCaptureModule,
  ) {}

  /** Path B P3: is reference capture routed through the shared module builder? */
  private get moduleCapture(): boolean {
    return this.captureModule !== undefined;
  }

  /**
   * Sync the parent's captured-value side table with a recipe id the module just
   * assigned. The module returns dense ids, so a NEW node's id equals the current
   * `capturedValues.length`; a dedup hit returns an existing id and leaves the
   * value already recorded. This keeps `capturedValues[id]` one-to-one with the
   * module graph so the parent's own replay hands back its ORIGINAL live value.
   */
  private recordModuleCapturedValue(id: number, value: unknown): void {
    if (id === this.capturedValues.length) {
      this.capturedValues.push(value);
      return;
    }
    if (id > this.capturedValues.length) {
      // The module assigns dense recipe ids, so a NEW node's id must equal the
      // current captured-value length and a dedup hit must be strictly below it.
      // An id BEYOND the table means the dense id<->value alignment has broken:
      // a later parent-replay decode would read `capturedValues[id]` and hand the
      // parent a WRONG (or absent) live reference. That is exactly the silent
      // identity corruption this whole path must never allow — fail loud.
      throw new Error(
        `fork module capture returned recipe id ${id} beyond the captured-value `
        + `table length ${this.capturedValues.length}; the dense recipe-id / `
        + `captured-value alignment is broken`,
      );
    }
    // `id < length`: a dedup hit — the value is already recorded at this id.
  }

  /**
   * Guard a Wasm-GC structural read that must NEVER be reached during the
   * PARENT's own replay under module capture. In module mode the parent's GC
   * values round-trip through the module-owned transit table (their ORIGINAL
   * live identities), so `routeGc`/`gcPayloadLength` are child-reconstruction
   * reads only; the module owns the graph and this class's `nodes` table is
   * empty. Parent identity RELIES on these never firing here — enforce it with
   * a loud failure rather than silently reading the empty `nodes` and handing
   * back a wrong (missing) recipe. Mirrors the child-replay-only phase guard on
   * `loadGc`.
   */
  private assertNotModuleParentReplay(operation: string): void {
    if (this.moduleCapture && this.phase === "parent-replay") {
      throw new Error(
        `cannot ${operation} during module-capture parent replay: the parent `
        + `round-trips Wasm-GC through the transit table, so this structural `
        + `read must never be reached here`,
      );
    }
  }

  setExceptionSlotProvider(provider: ForkExceptionSlotProvider): void {
    if (this.exceptionSlots && this.exceptionSlots !== provider) {
      throw new Error("fork exception slot provider is already registered");
    }
    this.exceptionSlots = provider;
  }

  beginCapture(): void {
    if (this.phase !== "idle") {
      throw new Error(`cannot begin reference capture while transaction is ${this.phase}`);
    }
    // Recipe 0 is the canonical null; its captured value (null) is kept host-side
    // in BOTH modes so the parent's own replay decode returns it directly.
    this.capturedValues.push(null);
    if (this.moduleCapture) {
      // The module is the SOLE capture graph: seed the shared builder (recipe 0 =
      // null, vector 0 = empty). The JS node/vector tables stay empty and unused.
      this.captureModule!.begin();
    } else {
      this.nodes.push({ id: 0, node: { kind: "null" } });
      this.referenceVectors.push(PagedForkReferenceVector.empty);
    }
    this.phase = "capture";
  }

  encodeFuncref(value: unknown): number {
    this.requirePhase("capture", "encode a funcref");
    if (value === null) return 0;
    if (typeof value !== "function") {
      throw new TypeError("fork funcref encoder received a non-function value");
    }
    if (this.moduleCapture) {
      const recipe = this.functions.encode(value);
      if (!recipe) throw new Error("non-null funcref produced a null catalog recipe");
      const id = this.captureModule!.internFuncref(
        recipe.moduleActivation,
        recipe.ordinal,
      );
      this.recordModuleCapturedValue(id, value);
      return id;
    }
    return this.intern(value, () => {
      const recipe = this.functions.encode(value);
      if (!recipe) throw new Error("non-null funcref produced a null catalog recipe");
      return {
        kind: "funcref",
        moduleActivation: recipe.moduleActivation,
        functionOrdinal: recipe.ordinal,
      };
    });
  }

  /**
   * Reserve one placeholder recipe for a GATED capture kind (externref / i31 /
   * typed Wasm-GC / static-root), keeping the LIVE captured value so the PARENT
   * still resumes faithfully.
   *
   * The gated capture imports no longer run their real encoders: the fork is
   * aborted with `EOPNOTSUPP` before any child restores the graph (see
   * `ForkActivationRegistry`). But the save walk still SEALS the capture (which
   * validates every node) and then REPLAYS the parent continuation, which
   * restores the parent's live reference locals/globals/tables. On the parent
   * that restore is a same-worker round-trip of the ORIGINAL live objects — via
   * the transit table for the module GC codecs and via `capturedValues` for the
   * runtime externref/funcref codecs — so no typed layout, scalar, provenance,
   * or static-root reconstruction is needed here. This reserves a self-contained
   * non-null leaf node (a canonical `i31` node, the cheapest kind that passes
   * `validateCanonicalCapture` without real backing; the sealed graph is
   * discarded unread) and keeps the live value for the parent replay decode.
   * Because a gated `lookup` returns this NONZERO recipe on first sight, the
   * guest takes its alias branch and never recurses into the typed field walk,
   * so leaf placeholders suffice for the whole gated graph.
   */
  reserveGatedPlaceholder(value: unknown): number {
    this.requirePhase("capture", "reserve a gated placeholder recipe");
    if (this.moduleCapture) {
      const id = this.captureModule!.gatedPlaceholder();
      this.recordModuleCapturedValue(id, value);
      return id;
    }
    const id = this.nodes.length;
    if (id > 0xffff_ffff) {
      throw new RangeError("fork reference recipe id space exhausted");
    }
    this.nodes.push({ id, node: { kind: "i31", value: 0 } });
    this.capturedValues.push(value);
    return id;
  }

  /**
   * Dedup/static-root/externref-provenance lookup for an anyref-lineage value
   * held in the module's Wasm-GC transit table.
   *
   * Mirrors native's `gc_lookup` layering
   * (`crates/host-native/src/guest.rs`): (1) has this exact live value already
   * been assigned a recipe id this capture (cycle/alias back onto an
   * already-claimed node)? (2) is it a registered static root (a harvest-time
   * reverse index, `ForkStaticRootCatalog.encode`)? (3) is it a plain host
   * externref with mint-time-recorded provenance (`externrefProvenance`,
   * lookup-only, never mint here)? A miss on all three returns `0` ("unknown"
   * — not a gate by itself), letting the guest's own dispatch recurse into
   * `claimGcSlot` (real struct/array/i31 construction) next.
   */
  lookupGcSlot(table: WebAssembly.Table, slot: number): number {
    this.requirePhase("capture", "look up a Wasm-GC identity");
    const value = this.gcSlotValue(table, slot);
    const known = this.lookupId(value);
    if (known !== undefined) return known;
    const staticRoot = this.staticRoots?.encode(value);
    if (staticRoot) {
      let id: number;
      if (this.moduleCapture) {
        id = this.captureModule!.internStaticRoot(
          staticRoot.moduleActivation,
          staticRoot.ordinal,
        );
        this.recordModuleCapturedValue(id, value);
        this.rememberId(value, id);
      } else {
        id = this.nodes.length;
        if (id > 0xffff_ffff) {
          throw new RangeError("fork reference recipe id space exhausted");
        }
        this.nodes.push({
          id,
          node: {
            kind: "static-root",
            moduleActivation: staticRoot.moduleActivation,
            staticRootOrdinal: staticRoot.ordinal,
          },
        });
        this.capturedValues.push(value);
        this.rememberId(value, id);
      }
      // Publish the static root into the transit at `id + 1` so PARENT replay's
      // `decode_anyref` (a pure `table.get(transit, recipe + 1)`) reads it. A
      // captured i31 / struct is grown+published for the parent by
      // `encodeI31` / `claimGcSlot`; the static-root lookup path did neither, so a
      // static root held as a bare operand-stack / local value across fork left the
      // parent's transit slot unsized and the resume trapped out of bounds. (The
      // CHILD re-publishes every static root via `materializeAllTyped` PHASE A.)
      if (id + 2 > table.length) {
        table.grow(id + 2 - table.length, null);
      }
      table.set(id + 1, value);
      return id;
    }
    // N1 Node/browser parity: the externref-provenance branch. A hit here
    // means `value` crossed a genuine host-import production site (recorded
    // by `__wpk_fork_ref_provenance_externref`'s import body at mint time),
    // not merely a GC-internalized anyref that happens to reach this seam.
    const externrefHandle = this.externrefProvenance?.lookup(value);
    if (externrefHandle !== undefined) {
      let id: number;
      if (this.moduleCapture) {
        id = this.captureModule!.internExternref(externrefHandle);
        this.recordModuleCapturedValue(id, value);
        this.rememberId(value, id);
      } else {
        id = this.intern(value, () => ({
          kind: "externref",
          handle: externrefHandle,
        }));
      }
      // Publish into the transit at `id + 1`, exactly like the static-root
      // branch above: the guest's generated `decode_externref` bridge (a
      // LOCAL Wasm function, not this file's JS `decodeExternref`) restores a
      // plain host externref by reading the SAME transit table
      // (`decode_anyref`'s `table.get(transit, recipe + 1)`), not by calling
      // back into JS. Skipping this publish leaves the PARENT's transit slot
      // unsized/unset and its resumed continuation traps out of bounds.
      if (id + 2 > table.length) {
        table.grow(id + 2 - table.length, null);
      }
      table.set(id + 1, value);
      return id;
    }
    return 0;
  }

  claimGcSlot(table: WebAssembly.Table, slot: number): number {
    this.requirePhase("capture", "claim a Wasm-GC identity");
    const value = this.gcSlotValue(table, slot);
    const known = this.lookupId(value);
    if (known !== undefined) return known;
    if (this.moduleCapture) {
      // The module publishes the placeholder id first (cycle-closing), exactly
      // like the JS path; the live value + id are remembered host-side so a later
      // field edge that aliases this value resolves to the same recipe.
      const id = this.captureModule!.claimGc();
      this.recordModuleCapturedValue(id, value);
      this.rememberId(value, id);
      return id;
    }
    const id = this.nodes.length;
    if (id > 0xffff_ffff) {
      throw new RangeError("fork reference recipe id space exhausted");
    }
    // WHY: publish graph identity before recursively encoding fields. The
    // placeholder is never serializable; `sealInto` rejects it via pendingGc
    // unless the generated codec completes `defineGc`.
    this.nodes.push({
      id,
      node: {
        kind: "struct",
        moduleActivation: 0,
        typeOrdinal: 0,
        layoutId: 0,
        scalars: new Uint8Array(),
        fields: [],
      },
    });
    this.capturedValues.push(value);
    this.rememberId(value, id);
    this.pendingGc.add(id);
    return id;
  }

  encodeI31(value: number): number {
    this.requirePhase("capture", "encode an i31ref");
    if (
      !Number.isInteger(value)
      || value < -0x4000_0000
      || value > 0x3fff_ffff
    ) {
      throw new RangeError(`invalid signed i31 payload ${value}`);
    }
    if (this.moduleCapture) {
      const id = this.captureModule!.internI31(value);
      this.recordModuleCapturedValue(id, value);
      return id;
    }
    const known = this.i31Ids.get(value);
    if (known !== undefined) return known;
    const id = this.nodes.length;
    if (id > 0xffff_ffff) {
      throw new RangeError("fork reference recipe id space exhausted");
    }
    this.nodes.push({ id, node: { kind: "i31", value } });
    // i31 identity is defined by its 31-bit payload. Keep a scalar here so
    // parent replay and graph aliases use the same canonical recipe id.
    this.capturedValues.push(value);
    this.i31Ids.set(value, id);
    return id;
  }

  capturedGcValue(recipeId: number): unknown {
    this.requirePhase("capture", "read a captured Wasm-GC identity");
    assertRecipeId(recipeId);
    if (recipeId === 0 || recipeId >= this.capturedValues.length) {
      throw new Error(`fork Wasm-GC recipe ${recipeId} is out of bounds`);
    }
    return this.capturedValues.get(recipeId);
  }

  defineGc(
    recipeId: number,
    moduleActivation: number,
    typeOrdinal: number,
    layoutId: number,
    kind: number,
    scalarPointer: number | bigint,
    scalarByteLength: number,
    referenceVectorOrdinal: number,
    descriptor: ForkGcCodecDescriptor,
    provenance: ForkGcDefinitionProvenance | null,
  ): void {
    this.requirePhase("capture", "define a Wasm-GC recipe");
    assertRecipeId(recipeId);
    this.assertU32(moduleActivation, "GC module activation");
    this.assertU32(typeOrdinal, "GC type ordinal");
    this.assertU31(layoutId, "GC layout id", false);
    this.assertU32(referenceVectorOrdinal, "GC reference vector ordinal");
    if (this.moduleCapture) {
      this.defineGcModule(
        recipeId,
        moduleActivation,
        typeOrdinal,
        layoutId,
        kind,
        scalarPointer,
        scalarByteLength,
        referenceVectorOrdinal,
        descriptor,
        provenance,
      );
      return;
    }
    if (!this.pendingGc.has(recipeId)) {
      throw new Error(`fork Wasm-GC recipe ${recipeId} is not pending definition`);
    }
    const layout = descriptor.require(layoutId);
    if (
      layout.typeOrdinal !== typeOrdinal
      || layout.kind !== kind
    ) {
      throw new Error(
        `fork Wasm-GC recipe ${recipeId} coordinate does not match `
        + `${moduleActivation}:${typeOrdinal}:${layoutId}:${kind}`,
      );
    }
    const snapshotScalars = this.readBytes(
      scalarPointer,
      scalarByteLength,
      "fork Wasm-GC scalar payload",
    );
    const vector = this.referenceVectors.get(referenceVectorOrdinal);
    if (!vector) {
      throw new Error(
        `fork Wasm-GC recipe ${recipeId} names an unavailable reference vector`,
      );
    }
    this.validateGcSnapshot(
      layout,
      snapshotScalars,
      vector,
      `fork Wasm-GC recipe ${recipeId}`,
    );

    const requiresProvenance =
      (layout.flags & FORK_GC_LAYOUT_REQUIRES_PROVENANCE) !== 0;
    if (requiresProvenance !== (provenance !== null)) {
      throw new Error(
        `fork Wasm-GC recipe ${recipeId} has `
        + `${provenance ? "unexpected" : "missing"} constructor provenance`,
      );
    }
    let provenanceScalars: Uint8Array = new Uint8Array();
    let provenanceIds: readonly number[] = [];
    if (provenance) {
      const selected = descriptor.requireCaptureLayout(
        layout.baseLayoutId,
        provenance.record.layoutId,
      );
      if (
        selected.id !== layout.id
        || provenance.record.activationId !== moduleActivation
        || provenance.record.baseLayoutId !== layout.baseLayoutId
        || provenance.record.scalars.byteLength
          !== layout.provenanceScalarLength
        || provenance.record.references.length
          !== layout.provenanceReferenceCount
        || provenance.recipeIds.length
          !== layout.provenanceReferenceCount
      ) {
        throw new Error(
          `fork Wasm-GC recipe ${recipeId} provenance does not match `
          + `layout ${layout.id}`,
        );
      }
      provenance.recipeIds.forEach((id, index) => {
        assertRecipeId(id);
        if (id >= this.nodes.length) {
          throw new Error(
            `fork Wasm-GC provenance ${index} names missing recipe ${id}`,
          );
        }
      });
      provenanceScalars = provenance.record.scalars;
      provenanceIds = provenance.recipeIds;
    }

    const scalars = new Uint8Array(
      provenanceScalars.byteLength + snapshotScalars.byteLength,
    );
    scalars.set(provenanceScalars);
    scalars.set(snapshotScalars, provenanceScalars.byteLength);
    const references = [...provenanceIds, ...vector];
    const node: ForkReferenceRecipeNode =
      layout.kind === 1
        ? {
            kind: "struct",
            moduleActivation,
            typeOrdinal,
            layoutId,
            scalars,
            fields: references,
          }
        : {
            kind: "array",
            moduleActivation,
            typeOrdinal,
            layoutId,
            scalars,
            elements: references,
          };
    this.nodes.set(recipeId, { id: recipeId, node });
    this.pendingGc.delete(recipeId);
  }

  /**
   * Module-capture `defineGc`: complete a claimed struct/array placeholder in the
   * shared builder. Keeps the cheap host-side layout-coordinate + provenance
   * consistency checks (the module cannot re-derive them), assembles the COMBINED
   * scalar span (constructor-provenance seed then live snapshot) and the
   * provenance recipe ids in guest memory, and routes the graph node construction
   * to the module — which reads the interned field vector and prepends the
   * provenance ids itself, exactly as native's `gc_define`. The JS
   * `validateGcSnapshot` reference-count/scalar-shape check is intentionally NOT
   * duplicated here (native does not run it either); the module validates edge
   * bounds and the guest produces the field data.
   */
  private defineGcModule(
    recipeId: number,
    moduleActivation: number,
    typeOrdinal: number,
    layoutId: number,
    kind: number,
    scalarPointer: number | bigint,
    scalarByteLength: number,
    referenceVectorOrdinal: number,
    descriptor: ForkGcCodecDescriptor,
    provenance: ForkGcDefinitionProvenance | null,
  ): void {
    const layout = descriptor.require(layoutId);
    if (layout.typeOrdinal !== typeOrdinal || layout.kind !== kind) {
      throw new Error(
        `fork Wasm-GC recipe ${recipeId} coordinate does not match `
        + `${moduleActivation}:${typeOrdinal}:${layoutId}:${kind}`,
      );
    }
    const requiresProvenance =
      (layout.flags & FORK_GC_LAYOUT_REQUIRES_PROVENANCE) !== 0;
    if (requiresProvenance !== (provenance !== null)) {
      throw new Error(
        `fork Wasm-GC recipe ${recipeId} has `
        + `${provenance ? "unexpected" : "missing"} constructor provenance`,
      );
    }
    const kindArg =
      layout.kind === 1 ? FORK_CAPTURE_KIND_STRUCT : FORK_CAPTURE_KIND_ARRAY;
    if (!provenance) {
      // No constructor provenance: the combined scalars ARE the live field
      // snapshot the guest already wrote to `scalarPointer`.
      this.captureModule!.defineGc({
        recipeId,
        activation: moduleActivation,
        typeOrdinal,
        layoutId,
        kind: kindArg,
        scalarPtr: Number(scalarPointer),
        scalarLen: scalarByteLength,
        referenceVectorOrdinal,
        hasProvenance: false,
        provPtr: 0,
        provCount: 0,
      });
      return;
    }
    // Provenance: validate against the layout exactly as the JS path does, then
    // assemble (provenance scalars ++ live snapshot) and the provenance recipe
    // ids into a scratch span the module reads.
    const selected = descriptor.requireCaptureLayout(
      layout.baseLayoutId,
      provenance.record.layoutId,
    );
    if (
      selected.id !== layout.id
      || provenance.record.activationId !== moduleActivation
      || provenance.record.baseLayoutId !== layout.baseLayoutId
      || provenance.record.scalars.byteLength !== layout.provenanceScalarLength
      || provenance.record.references.length !== layout.provenanceReferenceCount
      || provenance.recipeIds.length !== layout.provenanceReferenceCount
    ) {
      throw new Error(
        `fork Wasm-GC recipe ${recipeId} provenance does not match layout ${layout.id}`,
      );
    }
    const provenanceScalars = provenance.record.scalars;
    const provenanceIds = provenance.recipeIds;
    const snapshot = this.readBytes(
      scalarPointer,
      scalarByteLength,
      "fork Wasm-GC scalar payload",
    );
    const combined = new Uint8Array(
      provenanceScalars.byteLength + snapshot.byteLength,
    );
    combined.set(provenanceScalars);
    combined.set(snapshot, provenanceScalars.byteLength);
    const provBytes = provenanceIds.length * 4;
    // One scratch reservation holds the combined scalars then the provenance ids.
    const scalarSpan = Math.max(1, combined.byteLength);
    const total = scalarSpan + provBytes;
    const base = this.reserveScratch(total);
    try {
      if (combined.byteLength > 0) {
        this.writeBytes(base, combined, "fork Wasm-GC combined scalars");
      }
      const provPtr = base + scalarSpan;
      if (provBytes > 0) {
        const provBuf = new Uint8Array(provBytes);
        const provView = new DataView(provBuf.buffer);
        provenanceIds.forEach((id, index) =>
          provView.setUint32(index * 4, id >>> 0, true),
        );
        this.writeBytes(provPtr, provBuf, "fork Wasm-GC provenance ids");
      }
      this.captureModule!.defineGc({
        recipeId,
        activation: moduleActivation,
        typeOrdinal,
        layoutId,
        kind: kindArg,
        scalarPtr: base,
        scalarLen: combined.byteLength,
        referenceVectorOrdinal,
        hasProvenance: true,
        provPtr,
        provCount: provenanceIds.length,
      });
    } finally {
      this.releaseScratch(base, total);
    }
  }

  routeGc(recipeId: number, expectedActivation: number): number {
    assertRecipeId(recipeId);
    this.assertU32(expectedActivation, "GC route activation");
    this.assertNotModuleParentReplay("route a Wasm-GC recipe");
    const node = this.recipeNode(recipeId);
    if (node?.kind === "i31") return 0;
    if (
      (node?.kind !== "struct" && node?.kind !== "array")
      || node.moduleActivation !== expectedActivation
    ) {
      return -1;
    }
    const layoutId = node.layoutId ?? 0;
    this.assertU31(layoutId, `fork Wasm-GC recipe ${recipeId} layout`, false);
    return layoutId;
  }

  gcPayloadLength(
    recipeId: number,
    expectedActivation: number,
    expectedLayoutId: number,
  ): number {
    assertRecipeId(recipeId);
    this.assertU32(expectedActivation, "GC payload activation");
    this.assertU31(expectedLayoutId, "GC payload layout");
    this.assertNotModuleParentReplay("read a Wasm-GC payload length");
    const node = this.recipeNode(recipeId);
    if (node?.kind === "i31") {
      if (expectedLayoutId !== 0) {
        throw new Error(`fork i31 recipe ${recipeId} has a nonzero layout`);
      }
      return 4;
    }
    if (
      (node?.kind !== "struct" && node?.kind !== "array")
      || node.moduleActivation !== expectedActivation
      || (node.layoutId ?? 0) !== expectedLayoutId
    ) {
      throw new Error(
        `fork Wasm-GC recipe ${recipeId} does not match payload route `
        + `${expectedActivation}:${expectedLayoutId}`,
      );
    }
    return (node.scalars ?? new Uint8Array()).byteLength;
  }

  loadGc(
    recipeId: number,
    moduleActivation: number,
    typeOrdinal: number,
    layoutId: number,
    kind: number,
    scalarDestination: number | bigint,
    scalarByteLength: number,
  ): number {
    this.requirePhase("child-replay", "load a Wasm-GC recipe");
    assertRecipeId(recipeId);
    this.assertU32(moduleActivation, "GC load activation");
    // WHY the coercion: an i31 recipe carries the type ordinal `0xffff_ffff` (the
    // "no struct/array type" sentinel). A wasm caller that passes it as a signed
    // i32 delivers `-1` at the wasm->JS boundary, which `assertU32` (value < 0)
    // would reject BEFORE the i31 branch below could accept the sentinel — so an
    // i31 load through the module drive would spuriously fail. Coerce to unsigned
    // first; this is a no-op for the genuine u32 type ordinals struct/array carry.
    typeOrdinal = typeOrdinal >>> 0;
    this.assertU32(typeOrdinal, "GC load type ordinal");
    this.assertU31(layoutId, "GC load layout id");
    this.assertU32(kind, "GC load kind");
    const node = this.recipeNode(recipeId);
    if (node?.kind === "i31") {
      if (
        layoutId !== 0
        || typeOrdinal !== 0xffff_ffff
        || kind !== 0
        || scalarByteLength !== 4
      ) {
        throw new Error(`fork i31 recipe ${recipeId} has an invalid load coordinate`);
      }
      const bytes = new Uint8Array(4);
      new DataView(bytes.buffer).setInt32(0, node.value, true);
      this.writeBytes(
        scalarDestination,
        bytes,
        "fork i31 scalar destination",
      );
      return 0;
    }
    if (node?.kind !== "struct" && node?.kind !== "array") {
      throw new Error(`fork recipe ${recipeId} is not a Wasm-GC aggregate`);
    }
    const nodeKind = node.kind === "struct" ? 1 : 2;
    const scalars = node.scalars ?? new Uint8Array();
    if (
      node.moduleActivation !== moduleActivation
      || node.typeOrdinal !== typeOrdinal
      || (node.layoutId ?? 0) !== layoutId
      || nodeKind !== kind
      || scalars.byteLength !== scalarByteLength
    ) {
      throw new Error(
        `fork Wasm-GC recipe ${recipeId} payload does not match `
        + `the generated codec`,
      );
    }
    this.writeBytes(
      scalarDestination,
      scalars,
      "fork Wasm-GC scalar destination",
    );
    const edges = node.kind === "struct" ? node.fields : node.elements;
    if (edges.length === 0) return 0;
    const known = this.replayGcVectors.get(recipeId);
    if (known !== undefined) return known;
    const existing = findForkReferenceVectorOrdinal(
      [
        this.childTransaction!.vectorIntern,
        this.decodedReferenceVectorIntern,
      ],
      this.decodedReferenceVectors,
      forkReferenceVectorFrom(edges, edges.length),
    );
    if (existing !== undefined) {
      this.replayGcVectors.set(recipeId, existing);
      return existing;
    }
    const ordinal = this.decodedReferenceVectors.length;
    if (ordinal > MAX_REFERENCE_VECTOR_ORDINAL) {
      throw new RangeError("fork reference vector ordinal space exhausted");
    }
    const canonical = forkReferenceVectorFrom(edges, edges.length);
    this.decodedReferenceVectors.push(canonical);
    indexForkReferenceVector(
      this.decodedReferenceVectorIntern,
      canonical,
      ordinal,
    );
    this.replayGcVectors.set(recipeId, ordinal);
    return ordinal;
  }

  sealInto(arena: ForkModuleStateArena): Uint8Array {
    this.requirePhase("capture", "seal reference capture");
    if (this.scratchReservations.length !== 0) {
      throw new Error(
        `cannot seal with ${this.scratchReservations.length} live reference scratch reservation(s)`,
      );
    }
    if (this.pendingExceptions.size !== 0) {
      throw new Error(
        `cannot seal ${this.pendingExceptions.size} incomplete exception recipe(s)`,
      );
    }
    if (this.moduleCapture) {
      if (this.moduleVectorLengths.size !== 0) {
        throw new Error(
          `cannot seal ${this.moduleVectorLengths.size} unfinished reference vector(s)`,
        );
      }
      // The shared builder owns the canonical-capture validation (pending GC
      // placeholders, open vectors, edge bounds); it fails loud on any fault.
      this.captureModule!.validate();
      const records = this.captureModule!.serializeRecords(
        FORK_REFERENCE_TRANSACTION_OWNER_ID,
        FORK_CAPTURE_SEGMENT_WINDOW,
      );
      let manifest: Uint8Array = new Uint8Array();
      for (const record of records) {
        arena.appendRecord({
          kind: record.kind as ForkModuleStateRecordKind,
          activationId: record.activationId,
          ownerId: record.ownerId,
          payload: record.payload,
        });
        manifest = record.payload;
      }
      this.phase = "sealed-parent";
      return manifest;
    }
    if (this.pendingGc.size !== 0) {
      throw new Error(
        `cannot seal ${this.pendingGc.size} incomplete Wasm-GC recipe(s)`,
      );
    }
    if (this.pendingReferenceVectors.size !== 0) {
      throw new Error(
        `cannot seal ${this.pendingReferenceVectors.size} unfinished reference vector(s)`,
      );
    }
    const manifest = appendSegmentedForkReferenceTransaction(
      arena,
      FORK_REFERENCE_TRANSACTION_OWNER_ID,
      this.nodes,
      this.referenceVectors,
    );
    this.phase = "sealed-parent";
    return manifest;
  }

  beginParentReplay(): void {
    this.requirePhase("sealed-parent", "begin parent reference replay");
    this.phase = "parent-replay";
  }

  /**
   * Exact page-rounded scratch capacity observed while capturing this graph.
   *
   * Encode and replay use the same generated, stack-disciplined codecs. A
   * vfork host can therefore reserve this capacity before the child may touch
   * shared memory instead of discovering scratch exhaustion during replay.
   */
  borrowedReplayScratchCapacity(): number {
    this.requirePhase(
      "sealed-parent",
      "read borrowed replay scratch capacity",
    );
    return this.scratchCapacityHighWaterBytes;
  }

  attachChild(
    source:
      | Parameters<typeof decodeSegmentedForkReferenceTransaction>[0]
      | DecodedSegmentedForkReferenceTransaction,
  ): void {
    if (this.phase !== "idle") {
      throw new Error(`cannot attach child reference state while transaction is ${this.phase}`);
    }
    const decoded = "identity" in source
      ? source
      : decodeForkReferenceTransactionRecord(source);
    const { graph } = decoded;
    this.decodedNodes = graph.nodes;
    // WHY: generated GC codecs need an appendable tail, but copying every
    // decoded vector into a mutable directory would retain a redundant
    // transaction-wide index. The immutable decoded directory remains the
    // shared base used by both early and ordinary replay.
    this.decodedReferenceVectors.reset(decoded.vectors);
    this.decodedReferenceVectorIntern.clear();
    for (const entry of graph.nodes) {
      if (entry.node.kind === "exnref") {
        this.exceptionCacheIndexes.set(
          entry.id,
          this.exceptionCacheIndexes.size + 1,
        );
      }
    }
    this.materializedValues.clear();
    for (const entry of graph.nodes) {
      if (entry.node.kind !== "static-root") continue;
      if (!this.staticRoots) {
        throw new Error(
          `fork recipe ${entry.id} requires a static-root catalog`,
        );
      }
      // WHY: module-state restore can overwrite a template table and the
      // second restore phase can drop its element segment before activation
      // locals decode. Pin only roots actually named by this continuation,
      // then release them with the rest of the transaction after replay.
      this.materializedValues.set(entry.id, this.staticRoots.decode({
        moduleActivation: entry.node.moduleActivation,
        ordinal: entry.node.staticRootOrdinal,
      }));
    }
    this.childTransaction = decoded;
    this.phase = "child-replay";
  }

  /**
   * Take ownership of identities reconstructed for imported globals.
   *
   * This is deliberately a separate one-shot step after `attachChild`: the
   * transaction first validates the authoritative wire itself, then accepts
   * only state proven to come from those exact bytes.
   */
  adoptChildReplay(adoption: ForkReferenceChildReplayAdoption): void {
    this.requirePhase("child-replay", "adopt early child reference replay");
    if (this.typedMaterialized) {
      throw new Error("cannot adopt child references after typed materialization");
    }
    if (this.childReplayAdopted) {
      throw new Error("early child reference replay was adopted twice");
    }
    if (!this.childTransaction || adoption.transaction !== this.childTransaction) {
      throw new Error(
        "early child reference replay does not share the attached transaction",
      );
    }

    const requireNodeKind = (
      recipeId: number,
      kinds: readonly ForkReferenceRecipeNode["kind"][],
      context: string,
    ): ForkReferenceRecipeNode => {
      assertRecipeId(recipeId);
      const node = this.decodedNodes.get(recipeId)?.node;
      if (!node) {
        throw new Error(`${context} names missing recipe ${recipeId}`);
      }
      if (!kinds.includes(node.kind)) {
        throw new Error(
          `${context} recipe ${recipeId} is ${node.kind}, expected `
          + kinds.join(" or "),
        );
      }
      return node;
    };

    const stagedValues = new Map<number, unknown>();
    for (const [recipeId, value] of adoption.materializedValues) {
      const node = requireNodeKind(
        recipeId,
        ["null", "funcref", "externref", "i31", "struct", "array", "static-root"],
        "early materialized value",
      );
      if (
        (node.kind === "null" && value !== null)
        || (node.kind === "funcref" && typeof value !== "function")
      ) {
        throw new TypeError(
          `early materialized recipe ${recipeId} has an invalid ${node.kind} value`,
        );
      }
      if (this.materializedValues.has(recipeId)) {
        if (!Object.is(this.materializedValues.get(recipeId), value)) {
          throw new Error(
            `early materialized recipe ${recipeId} conflicts with its child catalog`,
          );
        }
        continue;
      }
      stagedValues.set(recipeId, value);
    }

    const stagedAllocated = new Set<number>();
    for (const recipeId of adoption.allocatedTypedRecipes) {
      requireNodeKind(
        recipeId,
        ["i31", "struct", "array"],
        "early allocated typed reference",
      );
      stagedAllocated.add(recipeId);
    }
    const stagedFilled = new Set<number>();
    for (const recipeId of adoption.filledTypedRecipes) {
      requireNodeKind(
        recipeId,
        ["struct", "array"],
        "early filled typed reference",
      );
      if (!stagedAllocated.has(recipeId)) {
        throw new Error(
          `early filled typed recipe ${recipeId} was not allocated`,
        );
      }
      stagedFilled.add(recipeId);
    }
    const stagedExceptions = new Set<number>();
    for (const recipeId of adoption.materializedExceptionRecipes) {
      requireNodeKind(
        recipeId,
        ["exnref"],
        "early materialized exception",
      );
      stagedExceptions.add(recipeId);
    }
    for (const recipeId of stagedAllocated) {
      if (
        !stagedValues.has(recipeId)
        && !this.materializedValues.has(recipeId)
      ) {
        throw new Error(
          `early allocated typed recipe ${recipeId} has no canonical value`,
        );
      }
    }
    for (const [recipeId] of stagedValues) {
      const kind = this.decodedNodes.get(recipeId)!.node.kind;
      if (
        (kind === "i31" || kind === "struct" || kind === "array")
        && !stagedAllocated.has(recipeId)
      ) {
        throw new Error(
          `early materialized typed recipe ${recipeId} was not allocated`,
        );
      }
    }

    for (const [recipeId, value] of stagedValues) {
      // Assign even when value is undefined: the own property is the cache bit.
      this.materializedValues.set(recipeId, value);
    }
    stagedAllocated.forEach((id) => this.adoptedAllocatedTypedRecipes.add(id));
    stagedFilled.forEach((id) => this.adoptedFilledTypedRecipes.add(id));
    stagedExceptions.forEach((id) =>
      this.adoptedMaterializedExceptionRecipes.add(id)
    );
    this.childReplayAdopted = true;
  }

  decodeFuncref(recipeId: number): CallableFunction | null {
    const value = this.decode(recipeId, "funcref");
    if (value !== null && typeof value !== "function") {
      throw new TypeError(`fork recipe ${recipeId} did not reconstruct a funcref`);
    }
    return value as CallableFunction | null;
  }

  decodeExternref(recipeId: number): unknown {
    return this.decode(recipeId, "externref");
  }

  beginReferenceVector(expectedLength: number): number {
    this.requirePhase("capture", "begin a reference vector");
    this.assertU32(expectedLength, "reference vector length");
    if (expectedLength === 0) {
      throw new RangeError("reference vector zero is the canonical empty vector");
    }
    if (this.moduleCapture) {
      const handle = this.captureModule!.beginVector();
      this.moduleVectorLengths.set(handle, { expected: expectedLength, count: 0 });
      return handle;
    }
    let handle = this.freeReferenceVectorHandles.pop();
    if (handle === undefined) {
      if (this.nextReferenceVectorHandle > MAX_REFERENCE_VECTOR_ORDINAL) {
        throw new RangeError("fork reference vector builder handle space exhausted");
      }
      handle = this.nextReferenceVectorHandle++;
    }
    this.pendingReferenceVectors.set(handle, {
      expectedLength,
      builder: new ForkReferenceVectorBuilder(expectedLength),
    });
    return handle;
  }

  appendReferenceVector(handle: number, recipeId: number): void {
    this.requirePhase("capture", "append a reference vector");
    this.assertU32(handle, "reference vector builder handle");
    assertRecipeId(recipeId);
    if (this.moduleCapture) {
      const rec = this.moduleVectorLengths.get(handle);
      if (!rec) {
        throw new Error(`fork reference vector builder ${handle} is not allocated`);
      }
      // The module validates `recipeId` names an existing recipe.
      this.captureModule!.appendVector(handle, recipeId);
      rec.count += 1;
      return;
    }
    const vector = this.pendingReferenceVectors.get(handle);
    if (!vector) {
      throw new Error(`fork reference vector builder ${handle} is not allocated`);
    }
    if (recipeId >= this.nodes.length) {
      throw new Error(
        `fork reference vector builder ${handle} names missing recipe ${recipeId}`,
      );
    }
    vector.builder.append(recipeId);
  }

  /**
   * Intern one complete activation vector and return its stable wire ordinal.
   *
   * WHY: recursive activations commonly carry the same reference-recipe
   * sequence. Frames keep only this canonical ordinal in their existing header
   * word, so recursion grows the linked continuation without duplicating the
   * process-owned vector payload.
   */
  finishReferenceVector(handle: number): number {
    this.requirePhase("capture", "finish a reference vector");
    this.assertU32(handle, "reference vector builder handle");
    if (this.moduleCapture) {
      const rec = this.moduleVectorLengths.get(handle);
      if (!rec) {
        throw new Error(`fork reference vector builder ${handle} is not allocated`);
      }
      if (rec.count !== rec.expected) {
        throw new Error(
          `fork reference vector builder ${handle} has ${rec.count} entries; `
          + `expected ${rec.expected}`,
        );
      }
      const ordinal = this.captureModule!.finishVector(handle);
      this.moduleVectorLengths.delete(handle);
      return ordinal;
    }
    const pending = this.pendingReferenceVectors.get(handle);
    if (!pending) {
      throw new Error(`fork reference vector builder ${handle} is not allocated`);
    }
    if (pending.builder.length !== pending.expectedLength) {
      throw new Error(
        `fork reference vector builder ${handle} has ${pending.builder.length} entries; `
        + `expected ${pending.expectedLength}`,
      );
    }
    const values = pending.builder.finish();

    const existing = findForkReferenceVectorOrdinal(
      [this.referenceVectorIntern],
      this.referenceVectors,
      values,
    );
    if (existing !== undefined) {
      this.releaseReferenceVectorHandle(handle);
      return existing;
    }
    const ordinal = this.referenceVectors.length;
    if (ordinal > MAX_REFERENCE_VECTOR_ORDINAL) {
      throw new RangeError("fork reference vector ordinal space exhausted");
    }
    const canonical = values;
    this.referenceVectors.push(canonical);
    indexForkReferenceVector(this.referenceVectorIntern, canonical, ordinal);
    this.releaseReferenceVectorHandle(handle);
    return ordinal;
  }

  getReferenceVector(ordinal: number, index: number): number {
    this.assertU32(ordinal, "reference vector ordinal");
    this.assertU32(index, "reference vector index");
    let vector: ForkReferenceVector | undefined;
    if (this.phase === "parent-replay") {
      if (this.moduleCapture) {
        // The parent reads its OWN just-built vectors back from the resident
        // shared builder (no re-decode); the recipe id then resolves to the
        // ORIGINAL live value via `capturedValues` in `decode`.
        return this.captureModule!.vectorGet(ordinal, index);
      }
      vector = this.referenceVectors.get(ordinal);
    } else {
      this.requirePhase("child-replay", "read a reference vector");
      vector = this.decodedReferenceVectors.get(ordinal);
    }
    if (!vector) {
      throw new Error(`fork reference vector ${ordinal} is not available`);
    }
    const recipeId = vector.get(index);
    if (recipeId === undefined) {
      throw new Error(
        `fork reference vector ${ordinal} index ${index} is out of bounds`,
      );
    }
    return recipeId;
  }

  /**
   * Reserve transient bytes in the one process memory copied by fork.
   *
   * Reservations are stack-disciplined because generated codecs recurse while
   * walking reference payloads. A retained page amortizes the common case;
   * unusually large or deeply nested payloads allocate extra page-rounded
   * chunks and release those chunks as soon as their nested scope returns.
   */
  reserveScratch(size: number | bigint): number {
    this.requireActivePhase("reserve reference scratch");
    const requestedSize = this.checkedScratchSize(size);
    const alignedSize = this.alignScratch(requestedSize);
    let chunk = this.scratchChunks[this.scratchChunks.length - 1];
    if (!chunk || alignedSize > chunk.size - chunk.used) {
      const allocate = this.allocateScratch;
      if (!allocate || !this.deallocateScratch) {
        throw new Error(`${this.label} has no scratch mapping owner`);
      }
      const chunkSize = this.alignScratch(Math.max(65_536, alignedSize), 65_536);
      const addr = allocate(chunkSize);
      if (
        !Number.isSafeInteger(addr)
        || addr <= 0
        || addr % 16 !== 0
        || addr > this.requireMemory().buffer.byteLength - chunkSize
      ) {
        if (Number.isSafeInteger(addr) && addr > 0) {
          try {
            this.deallocateScratch(addr, chunkSize);
          } catch {
            // Preserve the allocator contract violation.
          }
        }
        throw new RangeError(
          `${this.label} scratch allocator returned an invalid mapping`,
        );
      }
      chunk = { addr, size: chunkSize, used: 0 };
      this.scratchChunks.push(chunk);
      this.scratchCapacityBytes += chunkSize;
      this.scratchCapacityHighWaterBytes = Math.max(
        this.scratchCapacityHighWaterBytes,
        this.scratchCapacityBytes,
      );
    }
    const previousUsed = chunk.used;
    const addr = chunk.addr + previousUsed;
    chunk.used += alignedSize;
    new Uint8Array(this.requireMemory().buffer, addr, alignedSize).fill(0);
    this.scratchReservations.push({
      addr,
      requestedSize,
      alignedSize,
      previousUsed,
      chunk,
    });
    return addr;
  }

  releaseScratch(pointer: number | bigint, size: number | bigint): void {
    this.requireActivePhase("release reference scratch");
    const addr = this.checkedScratchPointer(pointer);
    const requestedSize = this.checkedScratchSize(size);
    const reservation = this.scratchReservations.pop();
    if (
      !reservation
      || reservation.addr !== addr
      || reservation.requestedSize !== requestedSize
    ) {
      if (reservation) this.scratchReservations.push(reservation);
      throw new Error(
        `${this.label} scratch release is not the most recent reservation`,
      );
    }
    new Uint8Array(
      this.requireMemory().buffer,
      reservation.addr,
      reservation.alignedSize,
    ).fill(0);
    reservation.chunk.used = reservation.previousUsed;

    const tail = this.scratchChunks[this.scratchChunks.length - 1];
    if (
      tail === reservation.chunk
      && tail.used === 0
      && this.scratchChunks.length > 1
    ) {
      this.scratchChunks.pop();
      this.scratchCapacityBytes -= tail.size;
      this.deallocateScratch!(tail.addr, tail.size);
    }
  }

  lookupExceptionSlot(
    slot: number,
    provider: ForkExceptionSlotProvider = this.requireExceptionSlotProvider(),
  ): number {
    this.requirePhase("capture", "look up an exception identity");
    const value = this.exceptionValue(provider, slot);
    const known = this.lookupExceptionId(value);
    if (this.moduleCapture) {
      // The module owns the graph; a known id is an exnref iff it carries an
      // exception cache index (assigned only to exnref recipes).
      return known !== undefined && this.exceptionCacheIndexes.has(known)
        ? known
        : 0;
    }
    return known !== undefined && this.nodes.get(known)?.node.kind === "exnref"
      ? known
      : 0;
  }

  claimExceptionSlot(
    slot: number,
    provider: ForkExceptionSlotProvider = this.requireExceptionSlotProvider(),
  ): number {
    this.requirePhase("capture", "claim an exception identity");
    const value = this.exceptionValue(provider, slot);
    const known = this.lookupExceptionId(value);
    if (this.moduleCapture) {
      // Already an exnref this capture (cache index assigned) — reuse its id.
      if (known !== undefined && this.exceptionCacheIndexes.has(known)) {
        return known;
      }
      // Claim a fresh placeholder in the shared builder (redefined as exnref by
      // defineException). The externref->exnref upgrade-in-place case (a value
      // first seen as externref, then as exnref) is not expressible against the
      // module graph and is out of scope here; a fresh claim keeps the common
      // path sound.
      const id = this.captureModule!.claimGc();
      this.recordModuleCapturedValue(id, value);
      this.rememberExceptionId(value, id);
      this.pendingExceptions.add(id);
      this.exceptionCacheIndexes.set(id, this.exceptionCacheIndexes.size + 1);
      return id;
    }
    if (known !== undefined) {
      const existing = this.nodes.get(known)?.node;
      if (existing?.kind === "exnref") return known;
      // WHY: one value may cross the embedding first as externref/anyref and
      // later as exnref. Keep its recipe ID and upgrade the node in place so
      // every view retains one graph identity.
      this.nodes.set(known, {
        id: known,
        node: {
          kind: "exnref",
          moduleActivation: 0,
          tagOrdinal: 0,
          layoutId: 0,
          scalars: new Uint8Array(),
          payloads: [],
        },
      });
      this.pendingExceptions.add(known);
      this.exceptionCacheIndexes.set(
        known,
        this.exceptionCacheIndexes.size + 1,
      );
      return known;
    }
    const id = this.nodes.length;
    if (id > 0xffff_ffff) {
      throw new RangeError("fork reference recipe id space exhausted");
    }
    this.nodes.push({
      id,
      node: {
        kind: "exnref",
        moduleActivation: 0,
        tagOrdinal: 0,
        layoutId: 0,
        scalars: new Uint8Array(),
        payloads: [],
      },
    });
    this.capturedValues.push(value);
    this.rememberExceptionId(value, id);
    this.pendingExceptions.add(id);
    this.exceptionCacheIndexes.set(id, this.exceptionCacheIndexes.size + 1);
    return id;
  }

  /**
   * Encode a raw JavaScript exception caught through `WebAssembly.JSTag`.
   *
   * The exception itself is an exnref recipe; its JS payload is a separate
   * externref node so process-wide broker ownership remains visible to the
   * wire graph and the child receives its canonical local token.
   */
  captureHostException(
    value: unknown,
    childPayloadValue: unknown = value,
  ): number {
    this.requirePhase("capture", "capture a host exception");
    if (this.moduleCapture) {
      const known = this.lookupExceptionId(value);
      if (known !== undefined && this.exceptionCacheIndexes.has(known)) {
        return known;
      }
      // A host JS exception is an exnref whose sole payload is the externref
      // carrying its (owner-normalized) JS value. Intern the payload, claim the
      // exnref placeholder, then complete it referencing that payload — the
      // module-graph mirror of the JS path below. The externref->exnref
      // upgrade-in-place case is out of scope for module capture (see
      // `claimExceptionSlot`); a fresh claim keeps the common path sound.
      const handle = this.externrefs.capture(childPayloadValue);
      const payloadId = this.captureModule!.internExternref(handle);
      this.recordModuleCapturedValue(payloadId, childPayloadValue);
      const recipeId = this.captureModule!.claimGc();
      this.recordModuleCapturedValue(recipeId, value);
      this.rememberId(value, recipeId);
      this.exceptionCacheIndexes.set(
        recipeId,
        this.exceptionCacheIndexes.size + 1,
      );
      const vectorHandle = this.captureModule!.beginVector();
      this.captureModule!.appendVector(vectorHandle, payloadId);
      const vectorOrdinal = this.captureModule!.finishVector(vectorHandle);
      this.captureModule!.defineGc({
        recipeId,
        activation: FORK_HOST_EXCEPTION_ACTIVATION_ID,
        typeOrdinal: 0,
        layoutId: 0,
        kind: FORK_CAPTURE_KIND_EXNREF,
        scalarPtr: 0,
        scalarLen: 0,
        referenceVectorOrdinal: vectorOrdinal,
        hasProvenance: false,
        provPtr: 0,
        provCount: 0,
      });
      return recipeId;
    }
    const known = this.lookupExceptionId(value);
    if (known !== undefined && this.nodes.get(known)?.node.kind === "exnref") {
      return known;
    }
    const recipeId = known ?? this.nodes.length;
    if (recipeId >= 0x7fff_fffe) {
      throw new RangeError("fork reference recipe id space exhausted");
    }
    const payloadId = this.nodes.length + (known === undefined ? 1 : 0);
    const existing = known === undefined
      ? undefined
      : this.nodes.get(known)?.node;
    const handle = (
      existing?.kind === "externref"
      && Object.is(value, childPayloadValue)
    )
      ? existing.handle
      : this.externrefs.capture(childPayloadValue);
    const exceptionEntry: ForkReferenceRecipeEntry = {
      id: recipeId,
      node: {
        kind: "exnref",
        moduleActivation: FORK_HOST_EXCEPTION_ACTIVATION_ID,
        tagOrdinal: 0,
        layoutId: 0,
        scalars: new Uint8Array(),
        payloads: [payloadId],
      },
    };
    if (known === undefined) {
      this.nodes.push(exceptionEntry);
      this.capturedValues.push(value);
      this.rememberId(value, recipeId);
    } else {
      this.nodes.set(known, exceptionEntry);
    }
    this.nodes.push({
      id: payloadId,
      node: {
        kind: "externref",
        handle,
      },
    });
    this.capturedValues.push(childPayloadValue);
    this.exceptionCacheIndexes.set(
      recipeId,
      this.exceptionCacheIndexes.size + 1,
    );
    return recipeId;
  }

  exceptionOwner(recipeId: number): number {
    assertRecipeId(recipeId);
    const node = this.recipeNode(recipeId);
    if (node?.kind !== "exnref") {
      throw new Error(`fork recipe ${recipeId} is not an exception`);
    }
    return node.moduleActivation;
  }

  materializeHostException(recipeId: number): unknown {
    const owner = this.exceptionOwner(recipeId);
    if (owner !== FORK_HOST_EXCEPTION_ACTIVATION_ID) {
      throw new Error(`fork exception recipe ${recipeId} is not host-owned`);
    }
    const node = this.recipeNode(recipeId);
    if (node?.kind !== "exnref" || node.payloads.length !== 1) {
      throw new Error(`fork host exception recipe ${recipeId} is malformed`);
    }
    if (this.phase === "parent-replay") {
      // WHY: the parent still owns the original JavaScript/Wasm exception and
      // must retain its exact tag and identity. Only a fresh child consumes
      // the owner-normalized externref payload.
      if (recipeId >= this.capturedValues.length) {
        throw new Error(`fork host exception recipe ${recipeId} is out of bounds`);
      }
      return this.capturedValues.get(recipeId);
    }
    return this.decodeExternref(node.payloads[0]!);
  }

  exceptionCacheIndex(recipeId: number): number {
    assertRecipeId(recipeId);
    const index = this.exceptionCacheIndexes.get(recipeId);
    if (index === undefined) {
      throw new Error(`fork recipe ${recipeId} has no exception cache index`);
    }
    return index;
  }

  defineException(
    recipeId: number,
    moduleActivation: number,
    tagOrdinal: number,
    layoutId: number,
    scalarPointer: number | bigint,
    scalarByteLength: number,
    referenceIdsPointer: number | bigint,
    referenceCount: number,
  ): void {
    this.requirePhase("capture", "define an exception recipe");
    if (this.moduleCapture) {
      if (recipeId === 0) {
        throw new Error("the null recipe cannot be defined as an exception");
      }
      this.assertU32(moduleActivation, "exception module activation");
      this.assertU32(tagOrdinal, "exception tag ordinal");
      this.assertU31(layoutId, "exception layout id");
      if (!this.pendingExceptions.has(recipeId)) {
        throw new Error(`fork exception recipe ${recipeId} is not pending definition`);
      }
      // Path B P5b: in module-capture mode the JS `this.nodes` array is EMPTY —
      // the shared `ReferenceGraphBuilder` owns every recipe. So the exception's
      // reference payload ids (funcref/externref already interned via
      // `fm_capture_intern_*`) must be sourced against the MODULE, not the JS
      // node table. `readRecipeIds` validates `id < this.nodes.length`, which
      // would spuriously reject every real payload here. Read the raw ids with
      // only the host-generic bounds (u32 count, recipe-id space) and let the
      // module's own `append_vector` be the authority: it validates each id
      // against the builder's node count (Rust `reference_graph_builder.rs:305`,
      // EINVAL for a missing recipe), so a bad payload id still fails LOUD via
      // the capture module's errno translation — never a silent mis-capture.
      const payloads = this.readModuleRecipeIds(
        referenceIdsPointer,
        referenceCount,
        "fork exception reference payloads",
      );
      // Intern the payload recipe ids as a module vector (ordinal 0 = empty).
      let vectorOrdinal = 0;
      if (payloads.length > 0) {
        const handle = this.captureModule!.beginVector();
        for (const payload of payloads) {
          this.captureModule!.appendVector(handle, payload);
        }
        vectorOrdinal = this.captureModule!.finishVector(handle);
      }
      this.captureModule!.defineGc({
        recipeId,
        activation: moduleActivation,
        typeOrdinal: tagOrdinal,
        layoutId,
        kind: FORK_CAPTURE_KIND_EXNREF,
        scalarPtr: Number(scalarPointer),
        scalarLen: scalarByteLength,
        referenceVectorOrdinal: vectorOrdinal,
        hasProvenance: false,
        provPtr: 0,
        provCount: 0,
      });
      this.pendingExceptions.delete(recipeId);
      return;
    }
    this.assertExceptionCoordinate(
      recipeId,
      moduleActivation,
      tagOrdinal,
      layoutId,
    );
    if (!this.pendingExceptions.has(recipeId)) {
      throw new Error(`fork exception recipe ${recipeId} is not pending definition`);
    }
    const scalars = this.readBytes(
      scalarPointer,
      scalarByteLength,
      "fork exception scalar payload",
    );
    const payloads = this.readRecipeIds(
      referenceIdsPointer,
      referenceCount,
      "fork exception reference payloads",
    );
    this.nodes.set(recipeId, {
      id: recipeId,
      node: {
        kind: "exnref",
        moduleActivation,
        tagOrdinal,
        layoutId,
        scalars,
        payloads,
      },
    });
    this.pendingExceptions.delete(recipeId);
  }

  routeException(recipeId: number, expectedActivation: number): number {
    assertRecipeId(recipeId);
    this.assertU32(expectedActivation, "exception route activation");
    const node = this.recipeNode(recipeId);
    if (node?.kind !== "exnref" || node.moduleActivation !== expectedActivation) {
      return -1;
    }
    const layoutId = node.layoutId ?? 0;
    if (layoutId > 0x7fff_ffff) {
      throw new Error(`fork exception recipe ${recipeId} has a non-routable layout id`);
    }
    return layoutId;
  }

  loadException(
    recipeId: number,
    moduleActivation: number,
    tagOrdinal: number,
    layoutId: number,
    scalarDestination: number | bigint,
    scalarByteLength: number,
    referenceIdsDestination: number | bigint,
    referenceCount: number,
  ): number {
    this.assertExceptionCoordinate(
      recipeId,
      moduleActivation,
      tagOrdinal,
      layoutId,
    );
    const node = this.recipeNode(recipeId);
    if (node?.kind !== "exnref") {
      throw new Error(`fork recipe ${recipeId} is not an exception`);
    }
    const scalars = node.scalars ?? new Uint8Array();
    if (
      scalars.byteLength !== scalarByteLength
      || node.payloads.length !== referenceCount
    ) {
      throw new Error(
        `fork exception recipe ${recipeId} payload layout does not match `
        + `the generated codec`,
      );
    }
    this.writeBytes(
      scalarDestination,
      scalars,
      "fork exception scalar destination",
    );
    this.writeRecipeIds(
      referenceIdsDestination,
      node.payloads,
      "fork exception reference destination",
    );
    return 1;
  }

  /**
   * Eager fresh-child barrier for all Wasm-only reference identities.
   *
   * The graph is validated in full before allocation. Defaultable shells are
   * then allocated globally, remaining constructors follow their exact
   * dependency edges, exceptions are cached in their owning activation, and
   * mutable fields are filled only after every identity exists.
   *
   * P2 (Path B): when `moduleDrive` is supplied (the co-resident fork-module is
   * active for this child), the module is the SOLE typed reconstructor. It owns
   * the WHOLE `drive_plan` walk — Phase 0 static-root publish, Phase 0b externref
   * transit publish (EVERY externref node), then Phase 3-5 defaultable-shell
   * pre-alloc / allocate-identity / fill — via `fm_build_gc_plan` +
   * `fm_drive_execute`, driving the guest `_gc_allocate`/`_gc_fill`/
   * `_exception_materialize` exports through its `call_indirect` drive table. None
   * of the JS descriptor validation, the PHASE A/B publishes, or the topological
   * sub-loop below run in that case: they are the flag-off JS path only (P6
   * deletes them). Earlier this method delegated ONLY the innermost typed sub-loop
   * to the module and still ran PHASE A/B in JS; the drive-plan Phase 0/0b
   * widening lets the module do all of it, so it is now the sole reconstructor.
   * When `moduleDrive` is omitted (flag-off) this is byte-identical to before.
   */
  materializeAllTyped(moduleDrive?: () => void): void {
    this.requirePhase("child-replay", "materialize typed references");
    if (this.typedMaterialized) {
      throw new Error("typed fork references were materialized twice");
    }
    const owner = this.typedReplay;
    if (!owner) {
      if (
        this.decodedNodes.some(({ node }) =>
          node.kind === "i31"
          || node.kind === "struct"
          || node.kind === "array"
          || node.kind === "exnref"
        )
      ) {
        throw new Error(`${this.label} has no typed-reference replay owner`);
      }
      this.typedMaterialized = true;
      return;
    }
    if (moduleDrive) {
      // P2 (Path B): MODULE-SOLE typed reconstruction. The co-resident module
      // owns the ENTIRE typed reconstruction for this fork — no JS reconstruction
      // runs. Previously this method ran the JS descriptor validation, the PHASE
      // A static-root publish, the PHASE B externref publish, and the topological
      // allocate/fill/exn sub-loop, delegating ONLY the innermost typed sub-loop
      // to the module. Now the module's `fm_build_gc_plan` + `fm_drive_execute`
      // reproduce the whole `drive_plan` walk: Phase 0 (static-root publish),
      // Phase 0b (EVERY externref node published into the anyref transit — the
      // widened pass that supersedes the JS PHASE B special-case for directly held
      // externref leaves), then Phase 3-5 (defaultable-shell pre-alloc, the
      // allocate/identity walk with cycle-break, and the fill walk). Kind
      // admission and per-recipe layout validation are re-checked inside
      // `fm_begin_reference_replay` / `fm_build_gc_plan`, which fail loud
      // (`EOPNOTSUPP`/trap) on a genuine disagreement — so the JS validation loop
      // below is redundant defense for a JS drive that no longer runs.
      //
      // The shared anyref transit is SIZED here (the module's injected shim writes
      // slot `recipe+1` but does not grow the table) to cover every recipe id.
      // `driveTypedGraph` builds the plan and returns a no-op (0 steps) for a graph
      // with no drivable node (funcref/null-only), so calling it unconditionally is
      // safe. A pure-externref graph WITH a typed replay owner drives its Phase 0b
      // externref publishes through the module here; a pure-externref graph with NO
      // typed owner took the owner-null early return above and reconstructs its
      // externref frame locals through the flipped `__wpk_fork_ref_decode_externref`
      // module import directly (no transit slot needed).
      owner.prepareTransit(Math.max(0, this.decodedNodes.length - 1));
      moduleDrive();
      this.typedMaterialized = true;
      return;
    }
    const providers = owner.providers();
    const layouts = new Map<number, ForkGcLayoutDescriptor>();
    for (const entry of this.decodedNodes) {
      switch (entry.node.kind) {
        case "struct":
        case "array": {
          const provider = owner.provider(entry.node.moduleActivation);
          layouts.set(
            entry.id,
            this.validateGcRecipeNode(
              entry.node,
              provider.descriptor,
              `fork Wasm-GC recipe ${entry.id}`,
            ),
          );
          break;
        }
        case "exnref":
          owner.validateExceptionOwner(entry.node.moduleActivation);
          break;
        case "i31":
          if (providers.length === 0) {
            throw new Error("fork i31 replay has no generated GC codec");
          }
          break;
        case "null":
        case "funcref":
        case "externref":
        case "static-root":
          break;
      }
    }

    owner.prepareTransit(Math.max(0, this.decodedNodes.length - 1));
    // PHASE A — static-root transit publish. On the MODULE path (`moduleDrive`
    // present) each static root is published into the same anyref transit by the
    // module's DRIVE_OP_STATIC_ROOT step (`table.get` the merged catalog mirror +
    // `table.set` transit, both wasm — the static-root binder), so the JS
    // `publishTransit` is skipped to avoid a redundant double-publish. When
    // `moduleDrive` is omitted (flag-off / non-admitted fork) this is the
    // byte-identical JS path.
    if (!moduleDrive) {
      for (const entry of this.decodedNodes) {
        if (entry.node.kind !== "static-root") continue;
        if (!this.materializedValues.has(entry.id)) {
          throw new Error(
            `fork static-root recipe ${entry.id} was not pinned during child attach`,
          );
        }
        // WHY: generated GC constructors and field fills decode reference edges
        // from recipe+1 in the shared anyref table. Instantiation recreated this
        // identity instead of a codec, so publish the pinned child root before
        // any dynamic object can consume it.
        owner.publishTransit(entry.id, this.materializedValues.get(entry.id));
      }
    }
    // PHASE B — externref transit publish (FLAG-OFF JS path only; the module-sole
    // branch at the top of this method returned before here). `owner.publishExternref`
    // calls the GUEST program's own generated `_gc_publish_externref_transit`
    // export directly (`any.convert_extern` + `table.set` on the shared anyref
    // transit `forkGcTransit` wraps). It publishes EVERY externref node, incl. a
    // directly held externref carried as a plain reference LOCAL (restored through
    // the reference-vector feed, `__wpk_fork_ref_vector_get` +
    // `__wpk_fork_ref_decode_externref`), which no reachability walk would reach.
    // On the MODULE path this JS loop does not run: the co-resident module's
    // `drive_plan` Phase 0b is the same UNCONDITIONAL every-externref pass (see the
    // module-sole branch above), so it publishes those slots itself.
    for (const entry of this.decodedNodes) {
      if (entry.node.kind !== "externref") continue;
      // Externref leaves must exist before immutable GC constructors or
      // exception payload decoders consume their recipe edges. Materializing
      // only the JavaScript token is insufficient: the shared transit table
      // stores anyref, so a generated Wasm helper performs the conversion.
      owner.publishExternref(entry.id, this.decodeExternref(entry.id));
    }
    // P2 (Path B): the module-drive delegation was hoisted to the MODULE-SOLE
    // branch at the top of this method. Everything from here down is the flag-off
    // JS reconstruction path ONLY (reached when `moduleDrive` is undefined); it is
    // slated for deletion in P6 once the flip lands.
    const allocated = new Set(this.adoptedAllocatedTypedRecipes);
    const completedExceptions = new Set(
      this.adoptedMaterializedExceptionRecipes,
    );
    for (const entry of this.decodedNodes) {
      if (entry.node.kind === "i31") {
        if (allocated.has(entry.id)) continue;
        providers[0]!.allocate(entry.id);
        allocated.add(entry.id);
        continue;
      }
      if (
        (entry.node.kind === "struct" || entry.node.kind === "array")
        && (
          layouts.get(entry.id)!.flags
          & FORK_GC_LAYOUT_DEFAULTABLE_SHELL
        ) !== 0
      ) {
        if (allocated.has(entry.id)) continue;
        owner.provider(entry.node.moduleActivation).allocate(entry.id);
        allocated.add(entry.id);
      }
    }

    type PendingTypedRecipe = {
      readonly recipeId: number;
      readonly node: Extract<
        ForkReferenceRecipeNode,
        { kind: "exnref" | "struct" | "array" }
      >;
      readonly dependencies: readonly number[];
      nextDependency: number;
    };
    // A sparse set tracks only the active constructor path. A graph-sized
    // Uint8Array would reintroduce one contiguous allocation cliff.
    const visiting = new Set<number>();
    const beginTypedRecipe = (
      recipeId: number,
    ): PendingTypedRecipe | null => {
      if (allocated.has(recipeId) || completedExceptions.has(recipeId)) {
        return null;
      }
      const node = this.decodedNodes.get(recipeId)?.node;
      if (!node) {
        throw new Error(`typed replay dependency ${recipeId} is missing`);
      }
      if (
        node.kind === "null"
        || node.kind === "funcref"
        || node.kind === "externref"
        || node.kind === "static-root"
        || node.kind === "i31"
      ) {
        return null;
      }
      if (visiting.has(recipeId)) {
        throw new Error(
          `typed replay has an unallocatable constructor cycle at recipe `
          + `${recipeId}`,
        );
      }
      visiting.add(recipeId);
      return {
        recipeId,
        node,
        dependencies: node.kind === "exnref"
          ? node.payloads
          : this.gcAllocationDependencies(node, layouts.get(recipeId)!),
        nextDependency: 0,
      };
    };
    const materialize = (recipeId: number): void => {
      const first = beginTypedRecipe(recipeId);
      if (!first) return;
      const pending: PendingTypedRecipe[] = [first];
      while (pending.length !== 0) {
        const current = pending[pending.length - 1]!;
        let descended = false;
        while (current.nextDependency < current.dependencies.length) {
          const dependency =
            current.dependencies[current.nextDependency++]!;
          const child = beginTypedRecipe(dependency);
          if (!child) continue;
          pending.push(child);
          descended = true;
          break;
        }
        if (descended) continue;

        if (current.node.kind === "exnref") {
          owner.materializeException(
            current.recipeId,
            current.node.moduleActivation,
          );
          completedExceptions.add(current.recipeId);
        } else {
          owner.provider(current.node.moduleActivation).allocate(
            current.recipeId,
          );
          allocated.add(current.recipeId);
        }
        visiting.delete(current.recipeId);
        pending.pop();
      }
    };
    this.decodedNodes.forEach(({ id }) => materialize(id));

    for (const entry of this.decodedNodes) {
      if (entry.node.kind !== "struct" && entry.node.kind !== "array") {
        continue;
      }
      if (this.adoptedFilledTypedRecipes.has(entry.id)) continue;
      owner.provider(entry.node.moduleActivation).fill(entry.id);
    }
    this.typedMaterialized = true;
  }

  /**
   * Drop every temporary strong root after the outermost frame has restored.
   * Module globals/tables/locals now own live reconstructed values; this
   * transaction must not extend their lifetime across a later fork.
   */
  finishReplay(): void {
    if (this.phase !== "parent-replay" && this.phase !== "child-replay") {
      throw new Error(`cannot finish reference replay while transaction is ${this.phase}`);
    }
    this.clear();
  }

  abort(): void {
    if (this.phase === "idle") return;
    this.clear();
  }

  private decode(recipeId: number, expected: "funcref" | "externref"): unknown {
    assertRecipeId(recipeId);
    if (recipeId === 0) return null;
    if (this.phase === "parent-replay") {
      if (recipeId >= this.capturedValues.length) {
        throw new Error(`fork ${expected} recipe ${recipeId} is out of bounds`);
      }
      return this.capturedValues.get(recipeId);
    }
    this.requirePhase("child-replay", `decode a ${expected}`);
    const index = recipeId;
    const node = this.decodedNodes.get(index)?.node;
    if (!node) {
      throw new Error(`fork ${expected} recipe ${recipeId} is out of bounds`);
    }
    if (this.materializedValues.has(index)) {
      return this.materializedValues.get(index);
    }
    const value = this.materializeNode(node, recipeId);
    this.materializedValues.set(index, value);
    return value;
  }

  private recipeNode(recipeId: number): ForkReferenceRecipeNode | undefined {
    if (this.phase === "capture" || this.phase === "sealed-parent" || this.phase === "parent-replay") {
      return this.nodes.get(recipeId)?.node;
    }
    if (this.phase === "child-replay") {
      return this.decodedNodes.get(recipeId)?.node;
    }
    throw new Error("fork reference transaction has no active recipe graph");
  }

  private requireExceptionSlotProvider(): ForkExceptionSlotProvider {
    if (!this.exceptionSlots) {
      throw new Error("fork exception scratch provider is not registered");
    }
    return this.exceptionSlots;
  }

  private exceptionValue(provider: ForkExceptionSlotProvider, slot: number): unknown {
    this.assertU32(slot, "exception scratch slot");
    try {
      provider.throwSlot(slot);
    } catch (value) {
      return value;
    }
    throw new Error(`fork exception scratch slot ${slot} returned without throwing`);
  }

  private assertExceptionCoordinate(
    recipeId: number,
    moduleActivation: number,
    tagOrdinal: number,
    layoutId: number,
  ): void {
    assertRecipeId(recipeId);
    if (recipeId === 0) {
      throw new Error("the null recipe cannot be defined or loaded as an exception");
    }
    this.assertU32(moduleActivation, "exception module activation");
    this.assertU32(tagOrdinal, "exception tag ordinal");
    this.assertU32(layoutId, "exception layout id");
    if (layoutId > 0x7fff_ffff) {
      throw new RangeError(`exception layout id ${layoutId} is not routable`);
    }
    const node = this.recipeNode(recipeId);
    if (!node) {
      throw new Error(`fork exception recipe ${recipeId} is out of bounds`);
    }
    if (
      !this.pendingExceptions.has(recipeId)
      && (
        node.kind !== "exnref"
        || node.moduleActivation !== moduleActivation
        || node.tagOrdinal !== tagOrdinal
        || (node.layoutId ?? 0) !== layoutId
      )
    ) {
      throw new Error(
        `fork exception recipe ${recipeId} coordinate does not match `
        + `${moduleActivation}:${tagOrdinal}:${layoutId}`,
      );
    }
  }

  private validateGcSnapshot(
    layout: ForkGcLayoutDescriptor,
    scalars: Uint8Array,
    references: readonly number[] | ForkReferenceVector,
    context: string,
  ): void {
    references.forEach((id, index) => {
      assertRecipeId(id);
      if (id >= this.nodes.length && id >= this.decodedNodes.length) {
        throw new Error(`${context} reference ${index} names missing recipe ${id}`);
      }
    });
    const referenceFieldCount = layout.fields.filter(
      ({ flags }) => (flags & FORK_GC_FIELD_REFERENCE) !== 0,
    ).length;
    if (layout.kind === 1) {
      if (
        scalars.byteLength !== layout.scalarLengthOrStride
        || references.length !== referenceFieldCount
      ) {
        throw new Error(`${context} does not match struct layout ${layout.id}`);
      }
      return;
    }
    if (scalars.byteLength < 4) {
      throw new Error(`${context} array length is truncated`);
    }
    const length = new DataView(
      scalars.buffer,
      scalars.byteOffset,
      scalars.byteLength,
    ).getUint32(0, true);
    const referenceElements =
      (layout.fields[0]!.flags & FORK_GC_FIELD_REFERENCE) !== 0;
    const expectedScalarLength = referenceElements
      ? 4
      : 4 + length * layout.scalarLengthOrStride;
    if (
      !Number.isSafeInteger(expectedScalarLength)
      || expectedScalarLength > 0xffff_ffff
      || scalars.byteLength !== expectedScalarLength
      || references.length !== (referenceElements ? length : 0)
      || (
        layout.constructor === ForkGcConstructorKind.ArrayFixed
        && layout.auxiliary !== length
      )
    ) {
      throw new Error(`${context} does not match array layout ${layout.id}`);
    }
  }

  private validateGcRecipeNode(
    node: Extract<ForkReferenceRecipeNode, { kind: "struct" | "array" }>,
    descriptor: ForkGcCodecDescriptor,
    context: string,
  ): ForkGcLayoutDescriptor {
    const layout = descriptor.require(node.layoutId ?? 0);
    if (
      layout.typeOrdinal !== node.typeOrdinal
      || (node.kind === "struct" ? 1 : 2) !== layout.kind
    ) {
      throw new Error(`${context} has an invalid type/layout coordinate`);
    }
    const scalars = node.scalars ?? new Uint8Array();
    const references = node.kind === "struct" ? node.fields : node.elements;
    if (
      scalars.byteLength < layout.provenanceScalarLength
      || references.length < layout.provenanceReferenceCount
    ) {
      throw new Error(`${context} has truncated constructor provenance`);
    }
    this.validateGcSnapshot(
      layout,
      scalars.subarray(layout.provenanceScalarLength),
      references.slice(layout.provenanceReferenceCount),
      context,
    );
    return layout;
  }

  private gcAllocationDependencies(
    node: Extract<ForkReferenceRecipeNode, { kind: "struct" | "array" }>,
    layout: ForkGcLayoutDescriptor,
  ): readonly number[] {
    const edges = node.kind === "struct" ? node.fields : node.elements;
    const dependencies = edges.slice(0, layout.provenanceReferenceCount);
    const snapshotStart = layout.provenanceReferenceCount;
    if (node.kind === "struct") {
      for (const field of layout.fields) {
        if (
          (field.flags & FORK_GC_FIELD_ALLOCATION_DEPENDENCY) === 0
          || field.referenceOrdinal === null
        ) {
          continue;
        }
        dependencies.push(edges[snapshotStart + field.referenceOrdinal]!);
      }
      return dependencies;
    }
    if ((layout.fields[0]!.flags & FORK_GC_FIELD_REFERENCE) === 0) {
      return dependencies;
    }
    const snapshot = edges.slice(snapshotStart);
    if (layout.constructor === ForkGcConstructorKind.ArrayFixed) {
      // Mutable non-null internal arrays use constructor provenance as their
      // seed; immutable arrays use their final (and therefore original)
      // elements directly.
      if (layout.provenanceReferenceCount === 0) {
        dependencies.push(...snapshot);
      }
    } else if (
      layout.constructor === ForkGcConstructorKind.ArrayNew
      && layout.provenanceReferenceCount === 0
      && snapshot.length !== 0
    ) {
      dependencies.push(snapshot[0]!);
    }
    return dependencies;
  }

  private readBytes(
    pointer: number | bigint,
    byteLength: number,
    context: string,
  ): Uint8Array {
    const { offset, length } = this.memoryRange(pointer, byteLength, context);
    return new Uint8Array(
      new Uint8Array(this.requireMemory().buffer, offset, length),
    );
  }

  private writeBytes(
    pointer: number | bigint,
    bytes: Uint8Array,
    context: string,
  ): void {
    const { offset } = this.memoryRange(pointer, bytes.byteLength, context);
    new Uint8Array(this.requireMemory().buffer, offset, bytes.byteLength).set(bytes);
  }

  private readRecipeIds(
    pointer: number | bigint,
    count: number,
    context: string,
  ): number[] {
    this.assertU32(count, `${context} count`);
    const bytes = this.readBytes(pointer, count * 4, context);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const ids: number[] = [];
    for (let index = 0; index < count; index++) {
      const id = view.getUint32(index * 4, true);
      assertRecipeId(id);
      if (id >= this.nodes.length) {
        throw new Error(`${context} entry ${index} names missing recipe ${id}`);
      }
      ids.push(id);
    }
    return ids;
  }

  /**
   * Module-capture variant of {@link readRecipeIds}: reads the raw recipe ids
   * from guest memory with ONLY the host-generic bounds (u32 count and the
   * recipe-id space via `assertRecipeId`), and does NOT check them against the
   * JS `this.nodes` array. In module-capture mode `this.nodes` is empty — the
   * shared `ReferenceGraphBuilder` (behind `fm_capture_*`) owns every recipe —
   * so a `this.nodes.length` bound would spuriously reject every real payload.
   * The module is the authority: whatever consumes these ids (e.g. the capture
   * module's `append_vector`) validates each against the builder's node count
   * and fails loud (EINVAL) on a missing recipe.
   */
  private readModuleRecipeIds(
    pointer: number | bigint,
    count: number,
    context: string,
  ): number[] {
    this.assertU32(count, `${context} count`);
    const bytes = this.readBytes(pointer, count * 4, context);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const ids: number[] = [];
    for (let index = 0; index < count; index++) {
      const id = view.getUint32(index * 4, true);
      assertRecipeId(id);
      ids.push(id);
    }
    return ids;
  }

  private writeRecipeIds(
    pointer: number | bigint,
    ids: readonly number[],
    context: string,
  ): void {
    const { offset } = this.memoryRange(pointer, ids.length * 4, context);
    const view = new DataView(this.requireMemory().buffer);
    ids.forEach((id, index) => {
      assertRecipeId(id);
      view.setUint32(offset + index * 4, id, true);
    });
  }

  private memoryRange(
    pointer: number | bigint,
    byteLength: number,
    context: string,
  ): { offset: number; length: number } {
    this.assertU32(byteLength, `${context} byte length`);
    const offset = typeof pointer === "bigint" ? Number(pointer) : pointer;
    if (
      !Number.isSafeInteger(offset)
      || offset < 0
      || (typeof pointer === "bigint" && BigInt(offset) !== pointer)
    ) {
      throw new RangeError(`${context} has an invalid guest pointer`);
    }
    const memoryLength = this.requireMemory().buffer.byteLength;
    if (offset > memoryLength || byteLength > memoryLength - offset) {
      throw new RangeError(`${context} exceeds WebAssembly memory`);
    }
    return { offset, length: byteLength };
  }

  private requireMemory(): WebAssembly.Memory {
    if (!this.memory) {
      throw new Error("fork reference transaction has no staging memory");
    }
    return this.memory;
  }

  private assertU32(value: number, context: string): void {
    if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) {
      throw new RangeError(`${context} is not a u32`);
    }
  }

  private assertU31(
    value: number,
    context: string,
    allowZero = true,
  ): void {
    if (
      !Number.isInteger(value)
      || value < (allowZero ? 0 : 1)
      || value > 0x7fff_ffff
    ) {
      throw new RangeError(`${context} is not ${allowZero ? "a" : "a nonzero"} u31`);
    }
  }

  private gcSlotValue(table: WebAssembly.Table, slot: number): unknown {
    this.assertU32(slot, "Wasm-GC transit slot");
    if (slot >= table.length) {
      throw new RangeError(`Wasm-GC transit slot ${slot} is out of bounds`);
    }
    const value = table.get(slot);
    if (
      (typeof value !== "object" || value === null)
      && typeof value !== "function"
    ) {
      throw new TypeError("Wasm-GC transit slot is not a non-null reference");
    }
    return value;
  }

  private requireActivePhase(operation: string): void {
    if (
      this.phase !== "capture"
      && this.phase !== "parent-replay"
      && this.phase !== "child-replay"
    ) {
      throw new Error(`cannot ${operation} while reference transaction is ${this.phase}`);
    }
  }

  private checkedScratchPointer(value: number | bigint): number {
    const result = typeof value === "bigint" ? Number(value) : value;
    if (
      !Number.isSafeInteger(result)
      || result <= 0
      || (typeof value === "bigint" && BigInt(result) !== value)
    ) {
      throw new RangeError(`${this.label} scratch pointer is invalid`);
    }
    return result;
  }

  private checkedScratchSize(value: number | bigint): number {
    const result = typeof value === "bigint" ? Number(value) : value;
    if (
      !Number.isSafeInteger(result)
      || result <= 0
      || result > 0xffff_ffff
      || (typeof value === "bigint" && BigInt(result) !== value)
    ) {
      throw new RangeError(`${this.label} scratch size is not a nonzero u32`);
    }
    return result;
  }

  private alignScratch(value: number, alignment = 16): number {
    const result = Math.ceil(value / alignment) * alignment;
    if (!Number.isSafeInteger(result) || result < value) {
      throw new RangeError(`${this.label} scratch alignment overflow`);
    }
    return result;
  }

  private materializeNode(
    node: ForkReferenceRecipeNode,
    recipeId: number,
  ): unknown {
    switch (node.kind) {
      case "funcref":
        return this.functions.decode({
          moduleActivation: node.moduleActivation,
          ordinal: node.functionOrdinal,
        });
      case "externref":
        return this.externrefs.materialize(node.handle);
      case "static-root":
        if (!this.staticRoots) {
          throw new Error(
            `fork recipe ${recipeId} requires a static-root catalog`,
          );
        }
        return this.staticRoots.decode({
          moduleActivation: node.moduleActivation,
          ordinal: node.staticRootOrdinal,
        });
      case "null":
        return null;
      case "exnref":
      case "i31":
      case "struct":
      case "array":
        // Those nodes are materialized by generated Wasm codecs. Reaching one
        // through an abstract JS-compatible import is an ABI/provider mismatch,
        // not a value-shape policy decision.
        throw new Error(
          `fork recipe ${recipeId} requires its generated ${node.kind} codec`,
        );
    }
  }

  private intern(
    value: unknown,
    createNode: () => ForkReferenceRecipeNode,
  ): number {
    const known = this.lookupId(value);
    if (known !== undefined) return known;
    const id = this.nodes.length;
    if (id > 0xffff_ffff) {
      throw new RangeError("fork reference recipe id space exhausted");
    }
    const recipeId = id;
    const staticRoot = this.staticRoots?.encode(value);
    const node: ForkReferenceRecipeNode = staticRoot
      ? {
          kind: "static-root",
          moduleActivation: staticRoot.moduleActivation,
          staticRootOrdinal: staticRoot.ordinal,
        }
      : createNode();
    this.nodes.push({ id, node });
    this.capturedValues.push(value);
    this.rememberId(value, recipeId);
    return recipeId;
  }

  private lookupId(value: unknown): number | undefined {
    return (typeof value === "object" && value !== null) || typeof value === "function"
      ? this.objectIds.get(value as object)
      : this.primitiveIds.get(value);
  }

  private rememberId(value: unknown, recipeId: number): void {
    if ((typeof value === "object" && value !== null) || typeof value === "function") {
      this.objectIds.set(value as object, recipeId);
    } else {
      this.primitiveIds.set(value, recipeId);
    }
  }

  private lookupExceptionId(value: unknown): number | undefined {
    return this.lookupId(value);
  }

  private rememberExceptionId(value: unknown, recipeId: number): void {
    this.rememberId(value, recipeId);
  }

  private releaseReferenceVectorHandle(handle: number): void {
    if (!this.pendingReferenceVectors.delete(handle)) {
      throw new Error(`fork reference vector builder ${handle} is not allocated`);
    }
    // Builder handles are transaction-local and never enter sealed bytes.
    // Reuse keeps deeply repetitive capture bounded by simultaneous nesting
    // instead of total activation count.
    this.freeReferenceVectorHandles.push(handle);
  }

  private requirePhase(expected: TransactionPhase, operation: string): void {
    if (this.phase !== expected) {
      throw new Error(
        `cannot ${operation} while reference transaction is ${this.phase}; expected ${expected}`,
      );
    }
  }

  private clear(): void {
    this.exceptionSlots?.clearSlots();
    // An exception or host callback may have aborted between reserve/release.
    // Zero every transaction-owned byte before returning its mappings.
    for (const chunk of this.scratchChunks) {
      new Uint8Array(this.requireMemory().buffer, chunk.addr, chunk.size).fill(0);
    }
    this.scratchReservations.length = 0;
    const chunks = this.scratchChunks.splice(0).reverse();
    this.scratchCapacityBytes = 0;
    this.scratchCapacityHighWaterBytes = 0;
    let firstScratchError: unknown;
    for (const chunk of chunks) {
      try {
        this.deallocateScratch?.(chunk.addr, chunk.size);
      } catch (error) {
        firstScratchError ??= error;
      }
    }
    this.pendingExceptions.clear();
    this.pendingGc.clear();
    this.i31Ids.clear();
    this.exceptionCacheIndexes.clear();
    this.nodes.clear();
    this.capturedValues.clear();
    this.objectIds = new WeakMap<object, number>();
    this.primitiveIds.clear();
    this.decodedNodes = new PagedForkReferenceDirectory();
    this.referenceVectors.clear();
    this.pendingReferenceVectors.clear();
    this.freeReferenceVectorHandles.length = 0;
    this.nextReferenceVectorHandle = 1;
    this.referenceVectorIntern.clear();
    this.decodedReferenceVectors.clear();
    this.decodedReferenceVectorIntern.clear();
    this.replayGcVectors.clear();
    this.typedMaterialized = false;
    this.childTransaction = null;
    this.childReplayAdopted = false;
    this.adoptedAllocatedTypedRecipes.clear();
    this.adoptedFilledTypedRecipes.clear();
    this.adoptedMaterializedExceptionRecipes.clear();
    this.materializedValues.clear();
    this.phase = "idle";
    if (firstScratchError !== undefined) throw firstScratchError;
  }
}
