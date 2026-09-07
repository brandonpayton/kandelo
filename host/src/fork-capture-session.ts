// Staying glue: the fork CAPTURE floor for the module-on path.
//
// WHY THIS FILE EXISTS (capture-session extraction / Path-A A2). On the
// module-on fork path the co-resident `fork_module` is the SOLE capture graph
// (the `fm_capture_*` exports build/dedup/close/validate/serialize it). What
// stays irreducibly host-side is the per-host identity FLOOR: the funcref /
// static-root catalog host-reads, the externref value->handle `WeakMap`
// identity + broker handle mint, the STORE #2 anyref-transit publish, the
// dedup->static-root->provenance layering that inspects live JS values
// (`lookupGcSlot`), the `capturedValues` round-trip that hands the PARENT its
// ORIGINAL live reference on its own post-fork replay, and the
// live-object/exception dedup maps. This session OWNS that floor and drives the
// module for all graph work, with NO JS reference-graph engine and NO JS
// fallback at the externref-identity seam.
//
// The parent worker's fork transaction constructs ONE session per capture (see
// `ForkActivationRegistry.beginCapture`) and every capture / parent-replay
// import routes to it via `registry.currentReferences()`. The flag-off fork and
// the peer-table snapshot paths keep the JS `ForkReferenceTransaction` (they
// pass no capture module), so this session is the module-on capture path only.
// Child reconstruction is a SEPARATE instance and never touches this session;
// the reconstruction-only methods here are present solely to satisfy the shared
// `ForkReferenceCaptureSurface` and throw if ever reached on the capture path.

import {
  type ForkModuleStateArena,
  type ForkModuleStateRecordKind,
} from "./fork-module-state";
import {
  decodeSegmentedForkReferenceTransaction,
  PagedForkReferenceDirectory,
  type DecodedSegmentedForkReferenceTransaction,
} from "./fork-reference-segments";
import { ForkFunctionCatalog } from "./fork-function-catalog";
import {
  FORK_GC_LAYOUT_REQUIRES_PROVENANCE,
  type ForkGcCodecDescriptor,
} from "./fork-gc-codec";
import { ForkStaticRootCatalog } from "./fork-static-root-catalog";
import type { ForkExternrefProvenanceTable } from "./fork-externref-provenance";
import {
  FORK_CAPTURE_KIND_ARRAY,
  FORK_CAPTURE_KIND_EXNREF,
  FORK_CAPTURE_KIND_STRUCT,
  type ForkReferenceCaptureModule,
} from "./fork-reference-capture-module";
import { WPK_FORK_REFERENCE_TRANSACTION_OWNER } from "./generated/abi";
import {
  ForkReferenceScratchArena,
  type ForkReferenceScratchAllocate,
  type ForkReferenceScratchDeallocate,
} from "./fork-reference-scratch";
import { FORK_HOST_EXCEPTION_ACTIVATION_ID } from "./fork-reference-wire";
import type {
  ForkExceptionSlotProvider,
  ForkExternrefRecipeProvider,
  ForkGcDefinitionProvenance,
  ForkReferenceChildReplayAdoption,
} from "./fork-reference-contracts";

/**
 * Per-segment copy window for the module's `fm_capture_serialize` (bytes).
 * Mirrors the JS engine's window; it only affects segment COUNT, never content.
 */
const FORK_CAPTURE_SEGMENT_WINDOW = 1 << 16;

const FORK_REFERENCE_TRANSACTION_OWNER_ID = WPK_FORK_REFERENCE_TRANSACTION_OWNER;

function assertRecipeId(value: number): void {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new RangeError(`invalid fork reference recipe id ${value}`);
  }
}

type CaptureSessionPhase =
  | "idle"
  | "capture"
  | "sealed-parent"
  | "parent-replay";

/**
 * The full reference-capture/replay surface the process worker's fork imports
 * call through `ForkActivationRegistry.currentReferences()`. Both the JS
 * `ForkReferenceTransaction` (flag-off + peer-table) and the module-on
 * `ForkCaptureSession` implement it, so the registry can hold either behind one
 * type without the callers knowing which engine is active.
 */
export interface ForkReferenceCaptureSurface {
  setExceptionSlotProvider(provider: ForkExceptionSlotProvider): void;
  beginCapture(): void;
  encodeFuncref(value: unknown): number;
  reserveGatedPlaceholder(value: unknown): number;
  lookupGcSlot(table: WebAssembly.Table, slot: number): number;
  claimGcSlot(table: WebAssembly.Table, slot: number): number;
  encodeI31(value: number): number;
  capturedGcValue(recipeId: number): unknown;
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
  ): void;
  routeGc(recipeId: number, expectedActivation: number): number;
  gcPayloadLength(
    recipeId: number,
    expectedActivation: number,
    expectedLayoutId: number,
  ): number;
  loadGc(
    recipeId: number,
    moduleActivation: number,
    typeOrdinal: number,
    layoutId: number,
    kind: number,
    scalarDestination: number | bigint,
    scalarByteLength: number,
  ): number;
  sealInto(arena: ForkModuleStateArena): Uint8Array;
  beginParentReplay(): void;
  borrowedReplayScratchCapacity(): number;
  attachChild(
    source:
      | Parameters<typeof decodeSegmentedForkReferenceTransaction>[0]
      | DecodedSegmentedForkReferenceTransaction,
  ): void;
  adoptChildReplay(adoption: ForkReferenceChildReplayAdoption): void;
  decodeFuncref(recipeId: number): CallableFunction | null;
  decodeExternref(recipeId: number): unknown;
  beginReferenceVector(expectedLength: number): number;
  appendReferenceVector(handle: number, recipeId: number): void;
  finishReferenceVector(handle: number): number;
  getReferenceVector(ordinal: number, index: number): number;
  reserveScratch(size: number | bigint): number;
  releaseScratch(pointer: number | bigint, size: number | bigint): void;
  lookupExceptionSlot(slot: number, provider?: ForkExceptionSlotProvider): number;
  claimExceptionSlot(slot: number, provider?: ForkExceptionSlotProvider): number;
  captureHostException(value: unknown, childPayloadValue?: unknown): number;
  exceptionOwner(recipeId: number): number;
  materializeHostException(recipeId: number): unknown;
  exceptionCacheIndex(recipeId: number): number;
  defineException(
    recipeId: number,
    moduleActivation: number,
    tagOrdinal: number,
    layoutId: number,
    scalarPointer: number | bigint,
    scalarByteLength: number,
    referenceIdsPointer: number | bigint,
    referenceCount: number,
  ): void;
  routeException(recipeId: number, expectedActivation: number): number;
  loadException(
    recipeId: number,
    moduleActivation: number,
    tagOrdinal: number,
    layoutId: number,
    scalarPointer: number | bigint,
    scalarByteLength: number,
    referenceIdsDestination: number | bigint,
    referenceCount: number,
  ): number;
  materializeAllTyped(moduleDrive?: () => void): void;
  finishReplay(): void;
  abort(): void;
}

/**
 * Module-on fork capture floor. Drives `captureModule` for all graph work and
 * owns the irreducible per-host identity floor described in the file header.
 */
export class ForkCaptureSession implements ForkReferenceCaptureSurface {
  private phase: CaptureSessionPhase = "idle";
  /**
   * Dense id -> ORIGINAL live value. Kept 1:1 with the module graph so the
   * PARENT's own post-fork replay decode returns the exact live reference.
   */
  private readonly capturedValues = new PagedForkReferenceDirectory<unknown>();
  private objectIds = new WeakMap<object, number>();
  private readonly primitiveIds = new Map<unknown, number>();
  /** Exnref recipe id -> its process-wide cache index (assigned in claim order). */
  private readonly exceptionCacheIndexes = new Map<number, number>();
  /**
   * Recipe ids captured as raw HOST/JSTag exceptions
   * (`FORK_HOST_EXCEPTION_ACTIVATION_ID`).
   *
   * WHY: the module owns the graph, so the JS node table is empty here. The JS
   * engine answered `exceptionOwner` / `materializeHostException` from that
   * table, which is EMPTY under module capture — a latent break at the
   * host-exception parent-replay seam (A2). The session instead records each
   * HOST exception AT ITS CAPTURE SITE so parent replay resolves the host owner
   * and returns the parent's ORIGINAL exception (via `capturedValues`) by
   * construction. A Wasm-owned exnref is NOT tracked here: like the JS engine's
   * empty-node-table behavior, `exceptionOwner` reports "not an exception" for
   * it during parent replay (the parent's own live Wasm exnref locals round-trip
   * through the exception codec's cache, not this owner query), so the two
   * engines stay behavior-identical outside the host-exception fix.
   */
  private readonly hostExceptionRecipes = new Set<number>();
  private readonly pendingExceptions = new Set<number>();
  /**
   * Per-open-vector length bookkeeping keyed by the MODULE's vector handle. The
   * module owns the vector contents; the host keeps only the declared/observed
   * length so `finishReferenceVector` still enforces the guest's
   * `expectedLength` contract (the module has no such check).
   */
  private readonly moduleVectorLengths = new Map<
    number,
    { expected: number; count: number }
  >();
  private readonly scratch: ForkReferenceScratchArena;
  private exceptionSlots: ForkExceptionSlotProvider | undefined;

  constructor(
    private readonly functions: ForkFunctionCatalog,
    private readonly externrefs: ForkExternrefRecipeProvider,
    private readonly captureModule: ForkReferenceCaptureModule,
    private readonly staticRoots: ForkStaticRootCatalog | undefined,
    private readonly externrefProvenance: ForkExternrefProvenanceTable | undefined,
    memory?: WebAssembly.Memory,
    allocateScratch?: ForkReferenceScratchAllocate,
    deallocateScratch?: ForkReferenceScratchDeallocate,
    private readonly label = "fork capture session",
  ) {
    this.scratch = new ForkReferenceScratchArena(
      memory,
      allocateScratch,
      deallocateScratch,
      this.label,
    );
  }

  /**
   * Sync the captured-value side table with a recipe id the module just
   * assigned. A NEW node's id equals the current `capturedValues.length`; a
   * dedup hit returns an existing id and leaves the value already recorded.
   */
  private recordCapturedValue(id: number, value: unknown): void {
    if (id === this.capturedValues.length) {
      this.capturedValues.push(value);
      return;
    }
    if (id > this.capturedValues.length) {
      throw new Error(
        `fork module capture returned recipe id ${id} beyond the captured-value `
        + `table length ${this.capturedValues.length}; the dense recipe-id / `
        + `captured-value alignment is broken`,
      );
    }
    // `id < length`: a dedup hit — the value is already recorded at this id.
  }

  setExceptionSlotProvider(provider: ForkExceptionSlotProvider): void {
    if (this.exceptionSlots && this.exceptionSlots !== provider) {
      throw new Error("fork exception slot provider is already registered");
    }
    this.exceptionSlots = provider;
  }

  beginCapture(): void {
    if (this.phase !== "idle") {
      throw new Error(`cannot begin reference capture while session is ${this.phase}`);
    }
    // Recipe 0 is the canonical null; its captured value (null) is kept host-side
    // so the parent's own replay decode returns it directly.
    this.capturedValues.push(null);
    // The module is the SOLE capture graph: seed the shared builder (recipe 0 =
    // null, vector 0 = empty).
    this.captureModule.begin();
    this.phase = "capture";
  }

  encodeFuncref(value: unknown): number {
    this.requirePhase("capture", "encode a funcref");
    if (value === null) return 0;
    if (typeof value !== "function") {
      throw new TypeError("fork funcref encoder received a non-function value");
    }
    const recipe = this.functions.encode(value);
    if (!recipe) throw new Error("non-null funcref produced a null catalog recipe");
    const id = this.captureModule.internFuncref(
      recipe.moduleActivation,
      recipe.ordinal,
    );
    this.recordCapturedValue(id, value);
    return id;
  }

  reserveGatedPlaceholder(value: unknown): number {
    this.requirePhase("capture", "reserve a gated placeholder recipe");
    const id = this.captureModule.gatedPlaceholder();
    this.recordCapturedValue(id, value);
    return id;
  }

  lookupGcSlot(table: WebAssembly.Table, slot: number): number {
    this.requirePhase("capture", "look up a Wasm-GC identity");
    const value = this.gcSlotValue(table, slot);
    const known = this.lookupId(value);
    if (known !== undefined) return known;
    const staticRoot = this.staticRoots?.encode(value);
    if (staticRoot) {
      const id = this.captureModule.internStaticRoot(
        staticRoot.moduleActivation,
        staticRoot.ordinal,
      );
      this.recordCapturedValue(id, value);
      this.rememberId(value, id);
      // Publish the static root into the transit at `id + 1` so PARENT replay's
      // `decode_anyref` (a pure `table.get(transit, recipe + 1)`) reads it.
      if (id + 2 > table.length) {
        table.grow(id + 2 - table.length, null);
      }
      table.set(id + 1, value);
      return id;
    }
    // N1 Node/browser parity: the externref-provenance branch. A hit means
    // `value` crossed a genuine host-import production site (recorded at mint
    // time), not merely a GC-internalized anyref reaching this seam.
    const externrefHandle = this.externrefProvenance?.lookup(value);
    if (externrefHandle !== undefined) {
      const id = this.captureModule.internExternref(externrefHandle);
      this.recordCapturedValue(id, value);
      this.rememberId(value, id);
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
    // The module publishes the placeholder id first (cycle-closing); the live
    // value + id are remembered host-side so a later aliasing edge resolves to
    // the same recipe.
    const id = this.captureModule.claimGc();
    this.recordCapturedValue(id, value);
    this.rememberId(value, id);
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
    const id = this.captureModule.internI31(value);
    this.recordCapturedValue(id, value);
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
      this.captureModule.defineGc({
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
      this.captureModule.defineGc({
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

  sealInto(arena: ForkModuleStateArena): Uint8Array {
    this.requirePhase("capture", "seal reference capture");
    if (this.scratch.liveReservationCount !== 0) {
      throw new Error(
        `cannot seal with ${this.scratch.liveReservationCount} live reference scratch reservation(s)`,
      );
    }
    if (this.pendingExceptions.size !== 0) {
      throw new Error(
        `cannot seal ${this.pendingExceptions.size} incomplete exception recipe(s)`,
      );
    }
    if (this.moduleVectorLengths.size !== 0) {
      throw new Error(
        `cannot seal ${this.moduleVectorLengths.size} unfinished reference vector(s)`,
      );
    }
    // The shared builder owns the canonical-capture validation (pending GC
    // placeholders, open vectors, edge bounds); it fails loud on any fault.
    this.captureModule.validate();
    const records = this.captureModule.serializeRecords(
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

  beginParentReplay(): void {
    this.requirePhase("sealed-parent", "begin parent reference replay");
    this.phase = "parent-replay";
  }

  borrowedReplayScratchCapacity(): number {
    this.requirePhase(
      "sealed-parent",
      "read borrowed replay scratch capacity",
    );
    return this.scratch.highWaterBytes;
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
    const handle = this.captureModule.beginVector();
    this.moduleVectorLengths.set(handle, { expected: expectedLength, count: 0 });
    return handle;
  }

  appendReferenceVector(handle: number, recipeId: number): void {
    this.requirePhase("capture", "append a reference vector");
    this.assertU32(handle, "reference vector builder handle");
    assertRecipeId(recipeId);
    const rec = this.moduleVectorLengths.get(handle);
    if (!rec) {
      throw new Error(`fork reference vector builder ${handle} is not allocated`);
    }
    // The module validates `recipeId` names an existing recipe.
    this.captureModule.appendVector(handle, recipeId);
    rec.count += 1;
  }

  finishReferenceVector(handle: number): number {
    this.requirePhase("capture", "finish a reference vector");
    this.assertU32(handle, "reference vector builder handle");
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
    const ordinal = this.captureModule.finishVector(handle);
    this.moduleVectorLengths.delete(handle);
    return ordinal;
  }

  getReferenceVector(ordinal: number, index: number): number {
    this.assertU32(ordinal, "reference vector ordinal");
    this.assertU32(index, "reference vector index");
    // The parent reads its OWN just-built vectors back from the resident shared
    // builder; the recipe id then resolves to the ORIGINAL live value via
    // `capturedValues` in `decode`.
    this.requirePhase("parent-replay", "read a reference vector");
    return this.captureModule.vectorGet(ordinal, index);
  }

  reserveScratch(size: number | bigint): number {
    this.requireActivePhase("reserve reference scratch");
    return this.scratch.reserve(size);
  }

  releaseScratch(pointer: number | bigint, size: number | bigint): void {
    this.requireActivePhase("release reference scratch");
    this.scratch.release(pointer, size);
  }

  lookupExceptionSlot(
    slot: number,
    provider: ForkExceptionSlotProvider = this.requireExceptionSlotProvider(),
  ): number {
    this.requirePhase("capture", "look up an exception identity");
    const value = this.exceptionValue(provider, slot);
    const known = this.lookupExceptionId(value);
    // The module owns the graph; a known id is an exnref iff it carries an
    // exception cache index (assigned only to exnref recipes).
    return known !== undefined && this.exceptionCacheIndexes.has(known)
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
    if (known !== undefined && this.exceptionCacheIndexes.has(known)) {
      return known;
    }
    // Claim a fresh placeholder in the shared builder (redefined as exnref by
    // `defineException`). The externref->exnref upgrade-in-place case is not
    // expressible against the module graph and is out of scope here; a fresh
    // claim keeps the common path sound.
    const id = this.captureModule.claimGc();
    this.recordCapturedValue(id, value);
    this.rememberExceptionId(value, id);
    this.pendingExceptions.add(id);
    this.exceptionCacheIndexes.set(id, this.exceptionCacheIndexes.size + 1);
    return id;
  }

  captureHostException(
    value: unknown,
    childPayloadValue: unknown = value,
  ): number {
    this.requirePhase("capture", "capture a host exception");
    const known = this.lookupExceptionId(value);
    if (known !== undefined && this.exceptionCacheIndexes.has(known)) {
      return known;
    }
    // A host JS exception is an exnref whose sole payload is the externref
    // carrying its (owner-normalized) JS value. Intern the payload, claim the
    // exnref placeholder, then complete it referencing that payload.
    const handle = this.externrefs.capture(childPayloadValue);
    const payloadId = this.captureModule.internExternref(handle);
    this.recordCapturedValue(payloadId, childPayloadValue);
    const recipeId = this.captureModule.claimGc();
    this.recordCapturedValue(recipeId, value);
    this.rememberId(value, recipeId);
    this.exceptionCacheIndexes.set(recipeId, this.exceptionCacheIndexes.size + 1);
    // Record the HOST ownership at the capture site so parent replay resolves it
    // without an empty JS node table (the host-exception replay fix).
    this.hostExceptionRecipes.add(recipeId);
    const vectorHandle = this.captureModule.beginVector();
    this.captureModule.appendVector(vectorHandle, payloadId);
    const vectorOrdinal = this.captureModule.finishVector(vectorHandle);
    this.captureModule.defineGc({
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

  exceptionOwner(recipeId: number): number {
    assertRecipeId(recipeId);
    // Only HOST exceptions are answerable from the session floor. A Wasm-owned
    // exnref has no host-side node (the module owns the graph), so — exactly as
    // the JS engine's empty node table did during parent replay — report "not an
    // exception". The parent never resolves its own live Wasm exnref locals
    // through this query.
    if (this.hostExceptionRecipes.has(recipeId)) {
      return FORK_HOST_EXCEPTION_ACTIVATION_ID;
    }
    throw new Error(`fork recipe ${recipeId} is not an exception`);
  }

  materializeHostException(recipeId: number): unknown {
    const owner = this.exceptionOwner(recipeId);
    if (owner !== FORK_HOST_EXCEPTION_ACTIVATION_ID) {
      throw new Error(`fork exception recipe ${recipeId} is not host-owned`);
    }
    if (this.phase === "parent-replay") {
      // The parent still owns the original JavaScript/Wasm exception and must
      // retain its exact tag and identity; hand back its captured original.
      if (recipeId >= this.capturedValues.length) {
        throw new Error(`fork host exception recipe ${recipeId} is out of bounds`);
      }
      return this.capturedValues.get(recipeId);
    }
    // A fresh child consumes the owner-normalized externref payload; that is the
    // reconstruction path, which never runs on this capture session.
    throw new Error(
      "fork host exception child materialization is not available on the capture session",
    );
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
    if (recipeId === 0) {
      throw new Error("the null recipe cannot be defined as an exception");
    }
    this.assertU32(moduleActivation, "exception module activation");
    this.assertU32(tagOrdinal, "exception tag ordinal");
    this.assertU31(layoutId, "exception layout id");
    if (!this.pendingExceptions.has(recipeId)) {
      throw new Error(`fork exception recipe ${recipeId} is not pending definition`);
    }
    // In module-capture mode the shared `ReferenceGraphBuilder` owns every
    // recipe, so the payload ids are read with only the host-generic bounds and
    // the module's own `append_vector` is the authority (EINVAL on a missing
    // recipe). See the JS engine's `readModuleRecipeIds` doc.
    const payloads = this.readModuleRecipeIds(
      referenceIdsPointer,
      referenceCount,
      "fork exception reference payloads",
    );
    let vectorOrdinal = 0;
    if (payloads.length > 0) {
      const handle = this.captureModule.beginVector();
      for (const payload of payloads) {
        this.captureModule.appendVector(handle, payload);
      }
      vectorOrdinal = this.captureModule.finishVector(handle);
    }
    this.captureModule.defineGc({
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
  }

  finishReplay(): void {
    if (this.phase !== "parent-replay") {
      throw new Error(`cannot finish reference replay while session is ${this.phase}`);
    }
    this.clear();
  }

  abort(): void {
    if (this.phase === "idle") return;
    this.clear();
  }

  // --- Reconstruction-only surface: never reached on the capture path. ---
  // Child reconstruction is a separate instance (the JS transaction on the
  // flag-off path, the co-resident module on the module-on path). These exist
  // solely so a single `ForkReferenceCaptureSurface` type covers both engines.

  attachChild(): never {
    throw new Error("fork child reconstruction does not run on the capture session");
  }

  adoptChildReplay(): never {
    throw new Error("fork child adoption does not run on the capture session");
  }

  materializeAllTyped(): never {
    throw new Error("fork typed reconstruction does not run on the capture session");
  }

  routeGc(): never {
    throw new Error("fork GC route does not run on the capture session");
  }

  gcPayloadLength(): never {
    throw new Error("fork GC payload length does not run on the capture session");
  }

  loadGc(): never {
    throw new Error("fork GC load does not run on the capture session");
  }

  /**
   * Exnref route on the PARENT's own post-fork replay. The module owns the
   * graph, so there is no host-side exnref node to route: return -1 ("not an
   * exnref for this activation"), exactly as the JS engine did on its
   * (empty-in-module-mode) node table during parent replay. The parent's own
   * live exnref locals round-trip through the exception codec's cache, not a
   * typed rebuild, so a -1 here is the benign parent path — never a throw. (A
   * FRESH CHILD reconstructs exnrefs through the module's flipped
   * `fm_ref_exn_route`, never this session.)
   */
  routeException(recipeId: number, expectedActivation: number): number {
    assertRecipeId(recipeId);
    this.assertU32(expectedActivation, "exception route activation");
    return -1;
  }

  loadException(): never {
    // Unreachable on the parent: `routeException` returns -1 for every
    // activation, so the guest never proceeds to a typed exnref load here (that
    // is the fresh-child module path). Loud if the invariant ever breaks.
    throw new Error("fork exception load does not run on the capture session");
  }

  // --- Private helpers (copied verbatim from the JS engine's floor). ---

  private decode(recipeId: number, expected: "funcref" | "externref"): unknown {
    assertRecipeId(recipeId);
    if (recipeId === 0) return null;
    this.requirePhase("parent-replay", `decode a ${expected}`);
    if (recipeId >= this.capturedValues.length) {
      throw new Error(`fork ${expected} recipe ${recipeId} is out of bounds`);
    }
    return this.capturedValues.get(recipeId);
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

  private readBytes(
    pointer: number | bigint,
    byteLength: number,
    context: string,
  ): Uint8Array {
    return this.scratch.readBytes(pointer, byteLength, context);
  }

  private writeBytes(
    pointer: number | bigint,
    bytes: Uint8Array,
    context: string,
  ): void {
    this.scratch.writeBytes(pointer, bytes, context);
  }

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

  private requirePhase(expected: CaptureSessionPhase, operation: string): void {
    if (this.phase !== expected) {
      throw new Error(
        `cannot ${operation} while capture session is ${this.phase}; expected ${expected}`,
      );
    }
  }

  private requireActivePhase(operation: string): void {
    if (this.phase !== "capture" && this.phase !== "parent-replay") {
      throw new Error(`cannot ${operation} while capture session is ${this.phase}`);
    }
  }

  private clear(): void {
    this.exceptionSlots?.clearSlots();
    const firstScratchError = this.scratch.reset();
    this.pendingExceptions.clear();
    this.exceptionCacheIndexes.clear();
    this.hostExceptionRecipes.clear();
    this.moduleVectorLengths.clear();
    this.capturedValues.clear();
    this.objectIds = new WeakMap<object, number>();
    this.primitiveIds.clear();
    this.phase = "idle";
    if (firstScratchError !== undefined) throw firstScratchError;
  }
}
