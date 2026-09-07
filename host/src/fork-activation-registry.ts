import {
  WPK_FORK_EXPORT_MODULE_STATE_FINISH_RESTORE,
  WPK_FORK_MODULE_STATE_IMPORT_RECORD_COMMIT,
  WPK_FORK_MODULE_STATE_IMPORT_RECORD_FIND,
  WPK_FORK_MODULE_STATE_IMPORT_RECORD_RESERVE,
  WPK_FORK_MODULE_STATE_IMPORT_TABLE_DIRTY_COUNT,
  WPK_FORK_MODULE_STATE_IMPORT_TABLE_DIRTY_MARK,
  WPK_FORK_MODULE_STATE_IMPORT_TABLE_DIRTY_PAGE,
  WPK_FORK_MODULE_STATE_IMPORT_TABLE_STATE_OWNED,
  WPK_FORK_MODULE_STATE_TABLE_PAGE_SHIFT,
  WPK_FORK_REFERENCE_IMPORT_DECODE_EXTERNREF,
  WPK_FORK_REFERENCE_IMPORT_DECODE_FUNCREF,
  WPK_FORK_REFERENCE_IMPORT_ENCODE_EXTERNREF,
  WPK_FORK_REFERENCE_IMPORT_ENCODE_FUNCREF,
  WPK_FORK_REFERENCE_IMPORT_GC_BROKER_ENCODE,
  WPK_FORK_REFERENCE_IMPORT_GC_CAPTURE_LAYOUT,
  WPK_FORK_REFERENCE_IMPORT_GC_CLAIM,
  WPK_FORK_REFERENCE_IMPORT_GC_DEFINE,
  WPK_FORK_REFERENCE_IMPORT_GC_I31,
  WPK_FORK_REFERENCE_IMPORT_GC_LOAD,
  WPK_FORK_REFERENCE_IMPORT_GC_LOOKUP,
  WPK_FORK_REFERENCE_IMPORT_GC_PAYLOAD_LEN,
  WPK_FORK_REFERENCE_IMPORT_GC_PROVENANCE_BEGIN,
  WPK_FORK_REFERENCE_IMPORT_GC_PROVENANCE_END,
  WPK_FORK_REFERENCE_IMPORT_GC_PROVENANCE_REF,
  WPK_FORK_REFERENCE_IMPORT_GC_ROUTE,
  WPK_FORK_REFERENCE_IMPORT_PROVENANCE_EXTERNREF,
  WPK_FORK_REFERENCE_IMPORT_VECTOR_APPEND,
  WPK_FORK_REFERENCE_IMPORT_VECTOR_BEGIN,
  WPK_FORK_REFERENCE_IMPORT_VECTOR_FINISH,
  WPK_FORK_REFERENCE_IMPORT_VECTOR_GET,
  WPK_FORK_TABLE_CATALOG_EXPORT_PREFIX,
} from "./generated/abi";
import {
  FORK_ANYREF_TRANSIT_IMPORT,
  ForkAnyrefTransitTable,
} from "./fork-anyref-transit";
import {
  ForkModuleStateArena,
  ForkModuleStateRecordKind,
  ForkTableDirtyTracker,
  requireForkModuleTemplate,
} from "./fork-module-state";
import {
  FORK_FUNCTION_CATALOG_EXPORT,
  ForkFunctionCatalog,
} from "./fork-function-catalog";
import type {
  DylinkForkTablePatch,
  DylinkForkTablePatchRun,
} from "./dylink-fork-archive";
import {
  FORK_GC_LAYOUT_REQUIRES_PROVENANCE,
  ForkGcProvenanceRegistry,
  forkGcCodecProviderFromInstance,
  type ForkGcCodecProvider,
} from "./fork-gc-codec";
import {
  FORK_HOST_EXCEPTION_ACTIVATION_ID,
  ForkReferenceTransaction,
  type ForkExternrefRecipeProvider,
  type ForkGcDefinitionProvenance,
  type ForkReferenceScratchAllocate,
  type ForkReferenceScratchDeallocate,
} from "./fork-reference-transaction";
import { ForkExternrefProvenanceTable } from "./fork-externref-provenance";
import type { ForkReferenceCaptureModule } from "./fork-reference-capture-module";
import type {
  DecodedSegmentedForkReferenceTransaction,
} from "./fork-reference-segments";
import {
  clearForkStaticRootTable,
  FORK_STATIC_ROOT_CATALOG_EXPORT,
  FORK_STATIC_ROOT_HARVEST_EXPORT,
  ForkStaticRootCatalog,
} from "./fork-static-root-catalog";

export const FORK_MODULE_BOOTSTRAP_EXPORT = "wpk_fork_module_bootstrap";
export const FORK_MODULE_STATE_SAVE_EXPORT = "wpk_fork_module_state_save";
export const FORK_MODULE_STATE_RESTORE_EXPORT = "wpk_fork_module_state_restore";
export const FORK_MODULE_STATE_FINISH_RESTORE_EXPORT =
  WPK_FORK_EXPORT_MODULE_STATE_FINISH_RESTORE;
export const FORK_MODULE_TABLE_STATE_SAVE_EXPORT =
  "wpk_fork_module_table_state_save";
export const FORK_MODULE_TABLE_STATE_RESTORE_EXPORT =
  "wpk_fork_module_table_state_restore";
export const FORK_MODULE_TABLE_GENERATION_ADDR_IMPORT =
  "__wpk_fork_module_state_table_generation_addr";
export const FORK_MODULE_TABLE_MUTATION_BEGIN_IMPORT =
  "__wpk_fork_module_state_table_mutation_begin";
export const FORK_MODULE_TABLE_MUTATION_COMMIT_IMPORT =
  "__wpk_fork_module_state_table_mutation_commit";
export const FORK_MODULE_TABLE_MUTATION_ABORT_IMPORT =
  "__wpk_fork_module_state_table_mutation_abort";
export const FORK_MODULE_TABLE_RECONCILE_IMPORT =
  "__wpk_fork_module_state_table_reconcile";

export interface ForkActivationTableReplication {
  /** Immutable pointer-width address of the shared generation fence. */
  readonly generationAddress: WebAssembly.Global;
  /**
   * Acquire the process writer, apply the latest snapshot, and return its
   * exact generation. Ownership remains live until commit() or abort().
   */
  beginMutation(): bigint;
  /** Apply the latest process snapshot and return its exact generation. */
  reconcile(): bigint;
  /** Publish a successful guest mutation and release writer ownership. */
  commit(
    activationId: number,
    ownerId: number,
    firstIndex: number | bigint,
    length: number | bigint,
  ): void;
  /** Release mutation writer ownership after a non-mutating failure/no-op. */
  abort(): void;
}

export interface ForkActivationExceptionProvider {
  /** Throw the exact exception currently rooted in an activation-local slot. */
  throwSlot(slot: number): never;
  /** Throw an exception reconstructed from the process recipe graph. */
  throwRecipe(recipeId: number): never;
  /** Route a host/JSTag ingress token into the process recipe graph. */
  encodeIngress(token: number): number;
  /** Decode/cache a recipe without returning an `exnref` through JavaScript. */
  materialize?(recipeId: number): void;
  /** Release transient roots after the outermost replay frame is restored. */
  clear(): void;
  /** Release the same roots when capture or replay aborts. */
  abort(): void;
}

export interface ForkActivationTypedReferenceProvider {
  readonly activationId?: number;
  readonly descriptor?: ForkGcCodecProvider["descriptor"];
  probe?(slot: number): bigint;
  encodeSlot?(slot: number): number;
  allocate?(recipeId: number): void;
  fill?(recipeId: number): void;
  publishExternref?(recipeId: number, value: unknown): void;
  /** Release transient GC/reference codec roots after successful replay. */
  clear?(): void;
  /** Release the same roots when capture or replay aborts. */
  abort?(): void;
}

export interface ForkActivationModuleState {
  /** Parent-only initialization: active segments followed by the original start. */
  bootstrap(): void;
  /** Append this activation's globals, sparse tables, and segment lifetimes. */
  save(activationId: number): void;
  /** Restore this activation before any continuation frame executes. */
  restore(activationId: number): void;
  /** Drop passive segments after typed constructor replay has completed. */
  finishRestore(activationId: number): void;
  /** Append only cumulative sparse table state to a peer-replication arena. */
  saveTables(activationId: number): void;
  /** Restore only cumulative sparse table state in another Worker instance. */
  restoreTables(activationId: number): void;
}

export interface ForkActivationRegistration {
  readonly activationId: number;
  readonly instance: WebAssembly.Instance;
  /** SHA-256 of the exact instrumented module bytes. */
  readonly templateId: Uint8Array;
  readonly functionCatalog: WebAssembly.Table;
  /**
   * Immutable GC/reference roots recreated by this exact instantiation.
   *
   * Recipes name these by activation and ordinal so `ref.eq` aliases resolve
   * to the child's own canonical root instead of a structural clone.
   */
  readonly staticRootCatalog: WebAssembly.Table;
  /** Populate the one-shot static-root observation table before registration. */
  readonly staticRootHarvest: () => void;
  readonly moduleState: ForkActivationModuleState;
  readonly exceptionProvider?: ForkActivationExceptionProvider;
  readonly typedReferenceProvider?: ForkActivationTypedReferenceProvider;
  /**
   * One journal per activation because generated owner ordinals are local to
   * an artifact. Imported/shared table identity is deduplicated by the loader
   * before it binds an activation to a journal.
   */
  readonly tableDirty: ForkTableDirtyTracker;
}

/**
 * Replay-only scalar callbacks needed while a fresh child is still
 * instantiating its activation graph.
 *
 * Capture callbacks deliberately remain registry-owned. Before `attachChild`
 * there is no capture transaction, so invoking one is a phase error rather
 * than an invitation to mutate the copied recipe graph.
 */
export interface ForkActivationReferenceReplayImports {
  decodeFuncref(recipeId: number): CallableFunction | null;
  decodeExternref(recipeId: number): unknown;
  getReferenceVector(ordinal: number, index: number): number;
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
}

type RegistryPhase =
  | "idle"
  | "capture"
  | "table-capture"
  | "sealed-parent"
  | "parent-replay"
  | "child-replay"
  | "table-replay";

function assertActivationId(value: number): void {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new RangeError(`invalid fork module activation id ${value}`);
  }
}

function checkedTableMutationIndex(
  value: number | bigint,
  context: string,
): bigint {
  if (
    typeof value === "number"
    && (!Number.isSafeInteger(value) || value < 0)
  ) {
    throw new RangeError(`${context} must be an exact non-negative integer`);
  }
  const result = typeof value === "bigint" ? value : BigInt(value);
  if (result < 0n || result >= (1n << 64n)) {
    throw new RangeError(`${context} exceeds the WebAssembly table64 index space`);
  }
  return result;
}

interface ForkRegisteredTableCoordinate {
  readonly activationId: number;
  readonly ownerId: number;
  readonly tracker: ForkTableDirtyTracker;
}

interface ForkActivationTableCatalogEntry {
  readonly ownerId: number;
  readonly table: WebAssembly.Table;
}

function activationTableCatalog(
  registration: ForkActivationRegistration,
  label: string,
): ForkActivationTableCatalogEntry[] {
  const entries: ForkActivationTableCatalogEntry[] = [];
  for (const [name, value] of Object.entries(registration.instance.exports)) {
    if (!name.startsWith(WPK_FORK_TABLE_CATALOG_EXPORT_PREFIX)) continue;
    const suffix = name.slice(WPK_FORK_TABLE_CATALOG_EXPORT_PREFIX.length);
    const ownerId = Number(suffix);
    if (
      !/^[1-9][0-9]*$/.test(suffix)
      || !Number.isSafeInteger(ownerId)
      || ownerId > 0xffff_ffff
    ) {
      throw new Error(`${label}: malformed private table catalog export ${name}`);
    }
    if (!(value instanceof WebAssembly.Table)) {
      throw new Error(`${label}: private table catalog ${name} is not a Table`);
    }
    entries.push({ ownerId, table: value });
  }
  entries.sort((left, right) => left.ownerId - right.ownerId);
  return entries;
}

function copyTemplateId(value: Uint8Array): Uint8Array {
  if (!(value instanceof Uint8Array) || value.byteLength !== 32) {
    throw new TypeError("fork module template id must contain exactly 32 bytes");
  }
  return value.slice();
}

function requireExportFunction(
  instance: WebAssembly.Instance,
  name: string,
): CallableFunction {
  const value = instance.exports[name];
  if (typeof value !== "function") {
    throw new Error(`fork module activation is missing function export ${name}`);
  }
  return value as CallableFunction;
}

function requireExportTable(
  instance: WebAssembly.Instance,
  name: string,
): WebAssembly.Table {
  const value = instance.exports[name];
  if (!(value instanceof WebAssembly.Table)) {
    throw new Error(`fork module activation is missing table export ${name}`);
  }
  return value;
}

/**
 * Resolve the uniform ABI 43 activation exports after instantiation.
 *
 * Keeping this reflection in one place makes main modules, pthread instances,
 * and dlopen activations obey the same state-ownership contract.
 */
export function forkActivationRegistrationFromInstance(options: {
  activationId: number;
  module?: WebAssembly.Module;
  instance: WebAssembly.Instance;
  templateId: Uint8Array;
  tableDirty?: ForkTableDirtyTracker;
  exceptionProvider?: ForkActivationExceptionProvider;
  typedReferenceProvider?: ForkActivationTypedReferenceProvider;
}): ForkActivationRegistration {
  const {
    activationId,
    instance,
    exceptionProvider,
    typedReferenceProvider,
  } = options;
  assertActivationId(activationId);
  const bootstrap = requireExportFunction(instance, FORK_MODULE_BOOTSTRAP_EXPORT);
  const save = requireExportFunction(instance, FORK_MODULE_STATE_SAVE_EXPORT);
  const restore = requireExportFunction(instance, FORK_MODULE_STATE_RESTORE_EXPORT);
  const finishRestore = requireExportFunction(
    instance,
    FORK_MODULE_STATE_FINISH_RESTORE_EXPORT,
  );
  const saveTables = requireExportFunction(
    instance,
    FORK_MODULE_TABLE_STATE_SAVE_EXPORT,
  );
  const restoreTables = requireExportFunction(
    instance,
    FORK_MODULE_TABLE_STATE_RESTORE_EXPORT,
  );
  const harvestStaticRoots = requireExportFunction(
    instance,
    FORK_STATIC_ROOT_HARVEST_EXPORT,
  );
  return {
    activationId,
    instance,
    templateId: copyTemplateId(options.templateId),
    functionCatalog: requireExportTable(instance, FORK_FUNCTION_CATALOG_EXPORT),
    staticRootCatalog: requireExportTable(
      instance,
      FORK_STATIC_ROOT_CATALOG_EXPORT,
    ),
    staticRootHarvest: () => { harvestStaticRoots(); },
    moduleState: {
      bootstrap: () => { bootstrap(); },
      save: (id) => { save(id); },
      restore: (id) => { restore(id); },
      finishRestore: (id) => { finishRestore(id); },
      saveTables: (id) => { saveTables(id); },
      restoreTables: (id) => { restoreTables(id); },
    },
    exceptionProvider,
    typedReferenceProvider: typedReferenceProvider ?? (
      options.module
        ? forkGcCodecProviderFromInstance(activationId, options.module, instance)
        : undefined
    ),
    tableDirty: options.tableDirty ?? new ForkTableDirtyTracker(),
  };
}

/**
 * Scalar/JS-callable imports shared by every activation.
 *
 * Typed GC and exception codecs are activation-local Wasm functions and are
 * bound separately by their providers. Keeping this helper to callbacks that
 * JavaScript can represent prevents an accidental exnref/anyref round-trip
 * through the embedding API.
 */
export function buildForkActivationStateImports(
  activationId: number,
  registry: ForkActivationRegistry,
  referenceReplay: () => ForkActivationReferenceReplayImports =
    () => registry.currentReferences(),
  tableReplication?: ForkActivationTableReplication,
): Record<string, WebAssembly.ImportValue> {
  assertActivationId(activationId);
  const arena = () => registry.currentArena();
  const references = () => registry.currentReferences();
  const tableDirty = () => registry.tableDirty(activationId);
  return {
    [FORK_ANYREF_TRANSIT_IMPORT]: registry.gcTransitTable(),
    [WPK_FORK_MODULE_STATE_IMPORT_RECORD_RESERVE]: (
      kind: number,
      recordActivationId: number,
      ownerId: number,
      payloadSize: number | bigint,
    ) => {
      if (recordActivationId !== activationId) {
        throw new Error(
          `activation ${activationId} cannot reserve module state for `
          + `activation ${recordActivationId}`,
        );
      }
      return arena().reserveRecord(
        kind,
        recordActivationId,
        ownerId,
        payloadSize,
      );
    },
    [WPK_FORK_MODULE_STATE_IMPORT_RECORD_COMMIT]: (
      payload: number | bigint,
    ): void => arena().commitRecord(payload),
    [WPK_FORK_MODULE_STATE_IMPORT_RECORD_FIND]: (
      kind: number,
      recordActivationId: number,
      ownerId: number,
      ordinal: number,
    ) => {
      if (recordActivationId !== activationId) {
        throw new Error(
          `activation ${activationId} cannot restore module state for `
          + `activation ${recordActivationId}`,
        );
      }
      return arena().findRecord(
        kind,
        recordActivationId,
        ownerId,
        ordinal,
      );
    },
    [WPK_FORK_MODULE_STATE_IMPORT_TABLE_DIRTY_MARK]: (
      ownerId: number,
      firstPage: number | bigint,
      pageCount: number | bigint,
    ): void => tableDirty().markPages(ownerId, firstPage, pageCount),
    [WPK_FORK_MODULE_STATE_IMPORT_TABLE_DIRTY_COUNT]: (
      ownerId: number,
    ): number => tableDirty().pageCount(ownerId),
    [WPK_FORK_MODULE_STATE_IMPORT_TABLE_DIRTY_PAGE]: (
      ownerId: number,
      ordinal: number,
    ): bigint => tableDirty().pageAt(ownerId, ordinal),
    [WPK_FORK_MODULE_STATE_IMPORT_TABLE_STATE_OWNED]: (
      ownerId: number,
    ): number => Number(tableDirty().ownsState(ownerId)),
    [FORK_MODULE_TABLE_GENERATION_ADDR_IMPORT]:
      tableReplication?.generationAddress
      ?? new WebAssembly.Global({ value: "i64", mutable: false }, 0n),
    [FORK_MODULE_TABLE_RECONCILE_IMPORT]: (): bigint =>
      tableReplication?.reconcile() ?? 0n,
    [FORK_MODULE_TABLE_MUTATION_BEGIN_IMPORT]: (): bigint =>
      tableReplication?.beginMutation() ?? 0n,
    [FORK_MODULE_TABLE_MUTATION_COMMIT_IMPORT]: (
      ownerId: number,
      firstIndex: number | bigint,
      length: number | bigint,
    ): void => {
      tableReplication?.commit(
        activationId,
        ownerId,
        firstIndex,
        length,
      );
    },
    [FORK_MODULE_TABLE_MUTATION_ABORT_IMPORT]: (): void => {
      tableReplication?.abort();
    },
    [WPK_FORK_REFERENCE_IMPORT_ENCODE_FUNCREF]: (
      value: unknown,
    ): number => references().encodeFuncref(value),
    [WPK_FORK_REFERENCE_IMPORT_DECODE_FUNCREF]: (
      recipeId: number,
    ): CallableFunction | null => referenceReplay().decodeFuncref(recipeId >>> 0),
    // GATED: dead code for every module `wasm-fork-instrument` currently
    // builds (a plain externref-typed local/global/table entry is routed
    // through `GC_LOOKUP`/`ExternRef::convert_any`, not this raw import —
    // see the architecture correction in
    // `docs/plans/2026-09-05-n1-nodebrowser-reference-parity-grounding.md`).
    // Left gated rather than revived: touching it risks confusing a future
    // reader about which path is live.
    [WPK_FORK_REFERENCE_IMPORT_ENCODE_EXTERNREF]: (
      value: unknown,
    ): number => {
      registry.markUnsupportedReferenceKind("externref");
      return registry.reserveGatedLeafPlaceholder(value);
    },
    // N1 Node/browser parity: real restore body. A fresh child now genuinely
    // reconstructs a plain host externref (recorded provenance, `GC_LOOKUP`'s
    // third branch) or a runtime funcref-as-externref, so this seam is live
    // again — the host-exception externref payload still decodes through the
    // INTERNAL `ForkReferenceTransaction.materializeHostException`, not this
    // guest import.
    [WPK_FORK_REFERENCE_IMPORT_DECODE_EXTERNREF]: (
      recipeId: number,
    ): unknown => referenceReplay().decodeExternref(recipeId >>> 0),
    [WPK_FORK_REFERENCE_IMPORT_VECTOR_BEGIN]: (
      expectedLength: number,
    ): number => references().beginReferenceVector(expectedLength >>> 0),
    [WPK_FORK_REFERENCE_IMPORT_VECTOR_APPEND]: (
      handle: number,
      recipeId: number,
    ): void => references().appendReferenceVector(handle >>> 0, recipeId >>> 0),
    [WPK_FORK_REFERENCE_IMPORT_VECTOR_FINISH]: (
      handle: number,
    ): number => references().finishReferenceVector(handle >>> 0),
    [WPK_FORK_REFERENCE_IMPORT_VECTOR_GET]: (
      ordinal: number,
      index: number,
    ): number => referenceReplay().getReferenceVector(
      ordinal >>> 0,
      index >>> 0,
    ),
    // N1 Node/browser parity: `gc_lookup` is the anyref-transit dedup entry
    // EVERY anyref-lineage value routes through (a plain host externref held
    // in a local/global/table, a static root, or a typed Wasm-GC
    // struct/array/i31). It answers exactly one question: "is this EXACT live
    // value already assigned a recipe id?" — dedup, then static-root, then
    // externref-provenance (see `ForkReferenceTransaction.lookupGcSlot`,
    // mirrors native's `gc_lookup` layering). A miss returns `0` ("unknown"),
    // NOT a gate: the guest's own dispatch reads that as "try i31/struct/
    // array construction next" via `GC_CLAIM`, which is where the real gate
    // for a genuinely unsupported kind still belongs (`encodeGcFromSlot`'s
    // internalized-hostref fallback, F6 scope).
    [WPK_FORK_REFERENCE_IMPORT_GC_LOOKUP]: (
      slot: number,
    ): number => registry.lookupGcSlot(activationId, slot >>> 0),
    [WPK_FORK_REFERENCE_IMPORT_GC_CLAIM]: (
      slot: number,
    ): number => registry.claimGcSlot(slot >>> 0),
    [WPK_FORK_REFERENCE_IMPORT_GC_I31]: (
      value: number,
    ): number => registry.encodeI31(value),
    [WPK_FORK_REFERENCE_IMPORT_GC_DEFINE]: (
      recipeId: number,
      recordActivationId: number,
      typeOrdinal: number,
      layoutId: number,
      kind: number,
      scalarPointer: number | bigint,
      scalarByteLength: number,
      referenceVectorOrdinal: number,
    ): void => {
      registry.defineGc(
        activationId,
        recipeId >>> 0,
        recordActivationId >>> 0,
        typeOrdinal,
        layoutId,
        kind,
        scalarPointer,
        scalarByteLength,
        referenceVectorOrdinal >>> 0,
      );
    },
    // N1 Node/browser parity: real restore bodies. A fresh child now
    // genuinely reconstructs a typed Wasm-GC (struct/array/i31) reference.
    // exnref restore keeps its own separate route/load imports
    // (`ROUTE_EXCEPTION`/`LOAD_EXCEPTION`), untouched here.
    [WPK_FORK_REFERENCE_IMPORT_GC_ROUTE]: (
      recipeId: number,
      expectedActivation: number,
    ): number => referenceReplay().routeGc(
      recipeId >>> 0,
      expectedActivation >>> 0,
    ),
    [WPK_FORK_REFERENCE_IMPORT_GC_PAYLOAD_LEN]: (
      recipeId: number,
      expectedActivation: number,
      expectedLayoutId: number,
    ): number => referenceReplay().gcPayloadLength(
      recipeId >>> 0,
      expectedActivation >>> 0,
      expectedLayoutId,
    ),
    [WPK_FORK_REFERENCE_IMPORT_GC_LOAD]: (
      recipeId: number,
      moduleActivation: number,
      typeOrdinal: number,
      layoutId: number,
      kind: number,
      scalarDestination: number | bigint,
      scalarByteLength: number,
    ): number => referenceReplay().loadGc(
      recipeId >>> 0,
      moduleActivation >>> 0,
      typeOrdinal,
      layoutId,
      kind,
      scalarDestination,
      scalarByteLength,
    ),
    // N1 Node/browser parity: real body. See `encodeGcFromSlot`'s doc
    // comment for the ONE remaining gated boundary this still respects
    // (a GC-internalized hostref with no recorded provenance, F6 scope).
    [WPK_FORK_REFERENCE_IMPORT_GC_BROKER_ENCODE]: (
      slot: number,
    ): number => registry.encodeGcFromSlot(activationId, slot >>> 0),
    [WPK_FORK_REFERENCE_IMPORT_GC_CAPTURE_LAYOUT]: (
      slot: number,
      recordActivationId: number,
      baseLayoutId: number,
    ): number => {
      if (recordActivationId !== activationId) {
        throw new Error(
          `activation ${activationId} cannot select GC layout for `
          + `activation ${recordActivationId}`,
        );
      }
      return registry.captureGcLayout(
        activationId,
        slot >>> 0,
        baseLayoutId,
      );
    },
    [WPK_FORK_REFERENCE_IMPORT_GC_PROVENANCE_BEGIN]: (
      slot: number,
      recordActivationId: number,
      baseLayoutId: number,
      specializedLayoutId: number,
      scalarLo: bigint,
      scalarHi: bigint,
      referenceCount: number,
    ): number => registry.beginGcProvenance(
      activationId,
      slot >>> 0,
      recordActivationId,
      baseLayoutId,
      specializedLayoutId,
      scalarLo,
      scalarHi,
      referenceCount,
    ),
    [WPK_FORK_REFERENCE_IMPORT_GC_PROVENANCE_REF]: (
      token: number,
      index: number,
      slot: number,
    ): void => {
      registry.appendGcProvenanceReference(token, index, slot >>> 0);
    },
    [WPK_FORK_REFERENCE_IMPORT_GC_PROVENANCE_END]: (
      token: number,
    ): void => {
      registry.endGcProvenance(token);
    },
    // N1 Node/browser parity P0: `__wpk_fork_ref_provenance_externref`'s
    // real mint-time body. See `ForkActivationRegistry.recordExternrefProvenance`.
    [WPK_FORK_REFERENCE_IMPORT_PROVENANCE_EXTERNREF]: (
      value: unknown,
    ): unknown => registry.recordExternrefProvenance(value),
  };
}

/**
 * Process-worker owner for every Wasm module activation participating in fork.
 *
 * The registry owns no copied Wasm references. It rebuilds a transient
 * function-identity catalog for each fork transaction, while durable state is
 * represented only by bytes in the linked continuation/KFMS arena. Main,
 * side-module, and pthread paths all register here before state restore.
 */
export class ForkActivationRegistry {
  private readonly registrations = new Map<number, ForkActivationRegistration>();
  private readonly bootstrapped = new Set<number>();
  private tableCoordinates = new WeakMap<
    WebAssembly.Table,
    ForkRegisteredTableCoordinate[]
  >();
  private readonly activationTables =
    new Map<number, ForkActivationTableCatalogEntry[]>();
  /**
   * Live process catalog used only for short table-delta recipes.
   *
   * Unlike a fork transaction catalog, this catalog follows dlopen/dlclose so
   * a successful guest mutation can be encoded in O(changed range) without
   * rebuilding every activation's function index on each table.set/fill.
   */
  private readonly tablePatchFunctions = new ForkFunctionCatalog();
  private phase: RegistryPhase = "idle";
  private arena: ForkModuleStateArena | null = null;
  private references: ForkReferenceTransaction | null = null;
  private functions: ForkFunctionCatalog | null = null;
  private readonly staticRoots = new ForkStaticRootCatalog();
  // The process-worker-owned Wasm-GC transit table bound to every activation's
  // guest `__wpk_fork_ref_gc_transit` import (see `bindActivationImports` /
  // `gcTransitTable()`). The co-resident fork-module's injected `fm_drive_execute`
  // must read this SAME table object (STORE #2) to see what a guest's
  // `_gc_allocate` published, so the worker can pass it in via the constructor and
  // hand the identical table to `instantiateForkModule`. When not supplied a fresh
  // one is minted, preserving every existing caller.
  private gcTransit: ForkAnyrefTransitTable;
  private readonly gcProvenance = new ForkGcProvenanceRegistry();
  /**
   * N1 Node/browser parity: local, same-realm provenance table for a plain
   * host externref reached through the anyref-transit `GC_LOOKUP` seam.
   * Populated only by the `PROVENANCE_EXTERNREF` host import's body at
   * mint time; consulted (lookup-only) by `ForkReferenceTransaction.lookupGcSlot`.
   */
  private readonly externrefProvenance = new ForkExternrefProvenanceTable();
  /**
   * First gated reference kind observed by a capture-side record-stub during
   * the active capture, or `null` when the fork carries only supported kinds.
   *
   * A raw `throw` from a capture import cannot unwind an errno through the Wasm
   * fork save walk (see `fork-continuation.ts`), so the gated import bodies in
   * `buildForkActivationStateImports` RECORD the kind here and return a benign
   * sentinel instead of throwing. The parent run loop reads and clears this
   * after `sealCapture` and, when set, aborts the fork cleanly with
   * `EOPNOTSUPP` via `beginAbortReplay` instead of launching a child. Read-and-
   * clear (`takeUnsupportedReferenceKind`) guarantees it never leaks into the
   * next fork; capture entry also clears it defensively.
   */
  private unsupportedReferenceKind: string | null = null;

  /**
   * Path B P3: when set, a FORK capture (`beginCapture`) routes reference
   * interning through the co-resident fork-module's shared builder (the module
   * is the SOLE capture graph). The peer-table snapshot paths
   * (`captureTableState`/`restoreTableState`) are unaffected and stay on the JS
   * transaction. Set by the worker once the fork-module instance exists.
   */
  private captureModule: ForkReferenceCaptureModule | undefined;

  /** Route FORK reference capture through the co-resident module (Path B P3). */
  setCaptureModule(captureModule: ForkReferenceCaptureModule): void {
    this.captureModule = captureModule;
  }

  constructor(
    private readonly memory: WebAssembly.Memory,
    private readonly externrefs: ForkExternrefRecipeProvider,
    private readonly label: string,
    private readonly allocateScratch?: ForkReferenceScratchAllocate,
    private readonly deallocateScratch?: ForkReferenceScratchDeallocate,
    gcTransit?: ForkAnyrefTransitTable,
  ) {
    this.gcTransit = gcTransit ?? new ForkAnyrefTransitTable();
  }

  registerActivation(registration: ForkActivationRegistration): void {
    this.requireIdle("register a module activation");
    assertActivationId(registration.activationId);
    if (this.registrations.has(registration.activationId)) {
      throw new Error(
        `${this.label}: module activation ${registration.activationId} is already registered`,
      );
    }
    const ownedRegistration = {
      ...registration,
      templateId: copyTemplateId(registration.templateId),
    };
    const tableCatalog = activationTableCatalog(ownedRegistration, this.label);
    try {
      ownedRegistration.staticRootHarvest();
      this.staticRoots.register(
        ownedRegistration.activationId,
        ownedRegistration.staticRootCatalog,
      );
    } catch (error) {
      // A trapping harvest can have populated a strict prefix. Never let a
      // failed dlopen/activation registration retain those temporary roots.
      clearForkStaticRootTable(ownedRegistration.staticRootCatalog);
      throw error;
    }
    try {
      this.tablePatchFunctions.register(
        ownedRegistration.activationId,
        ownedRegistration.functionCatalog,
      );
    } catch (error) {
      this.staticRoots.unregister(ownedRegistration.activationId);
      throw error;
    }
    this.registrations.set(registration.activationId, ownedRegistration);
    this.activationTables.set(registration.activationId, tableCatalog);
    const affectedTables = new Set<WebAssembly.Table>();
    for (const { ownerId, table } of tableCatalog) {
      const coordinates = this.tableCoordinates.get(table) ?? [];
      coordinates.push({
        activationId: registration.activationId,
        ownerId,
        tracker: ownedRegistration.tableDirty,
      });
      coordinates.sort(
        (left, right) =>
          left.activationId - right.activationId
          || left.ownerId - right.ownerId,
      );
      this.tableCoordinates.set(table, coordinates);
      affectedTables.add(table);
    }
    for (const table of affectedTables) {
      this.bindTableCoordinates(table);
    }
  }

  getActivation(activationId: number): ForkActivationRegistration {
    assertActivationId(activationId);
    const registration = this.registrations.get(activationId);
    if (!registration) {
      throw new Error(`${this.label}: module activation ${activationId} is not registered`);
    }
    return registration;
  }

  activations(): readonly ForkActivationRegistration[] {
    return [...this.registrations.values()].sort(
      (left, right) => left.activationId - right.activationId,
    );
  }

  unregisterActivation(activationId: number): void {
    this.requireIdle("unregister a module activation");
    const registration = this.getActivation(activationId);
    // A provider may retain scratch roots even when no fork is active (for
    // example, a caught exception awaiting an ingress callback). Abort is the
    // stronger teardown operation and is therefore correct for dlclose/exec.
    registration.exceptionProvider?.abort();
    registration.typedReferenceProvider?.abort?.();
    const affectedTables = new Set<WebAssembly.Table>();
    for (const { table } of this.activationTables.get(activationId) ?? []) {
      const remaining = (this.tableCoordinates.get(table) ?? [])
        .filter((coordinate) => coordinate.activationId !== activationId);
      if (remaining.length === 0) this.tableCoordinates.delete(table);
      else {
        this.tableCoordinates.set(table, remaining);
        affectedTables.add(table);
      }
    }
    this.activationTables.delete(activationId);
    for (const table of affectedTables) {
      this.bindTableCoordinates(table);
    }
    this.registrations.delete(activationId);
    this.tablePatchFunctions.unregister(activationId);
    this.bootstrapped.delete(activationId);
    this.staticRoots.unregister(activationId);
  }

  bootstrapActivation(activationId: number): void {
    this.requireIdle("bootstrap a module activation");
    if (this.bootstrapped.has(activationId)) {
      throw new Error(`${this.label}: module activation ${activationId} was bootstrapped twice`);
    }
    const registration = this.getActivation(activationId);
    registration.moduleState.bootstrap();
    this.bootstrapped.add(activationId);
  }

  tableDirty(activationId: number): ForkTableDirtyTracker {
    return this.getActivation(activationId).tableDirty;
  }

  /**
   * Record a successful host-side mutation of an activation-owned Table.
   *
   * Dynamic-linker helpers can call `Table.grow`/`Table.set` without executing
   * an instrumented Wasm opcode. Resolve the actual Table identity back to all
   * live catalog coordinates and mark the same sparse pages the guest hook
   * would have marked. Marking aliases is idempotent after journal union and
   * also preserves mutations made before a newly loaded alias is bound.
   */
  markTableMutation(
    table: WebAssembly.Table,
    firstIndexValue: number | bigint,
    lengthValue: number | bigint,
  ): void {
    this.requireIdle("record a host table mutation");
    if (!(table instanceof WebAssembly.Table)) {
      throw new TypeError(`${this.label}: host table mutation target is not a Table`);
    }
    const coordinates = this.tableCoordinates.get(table);
    if (!coordinates || coordinates.length === 0) {
      throw new Error(
        `${this.label}: host mutated a Table outside the registered fork catalogs`,
      );
    }
    const firstIndex = checkedTableMutationIndex(
      firstIndexValue,
      "fork table mutation first index",
    );
    const length = checkedTableMutationIndex(
      lengthValue,
      "fork table mutation length",
    );
    if (length === 0n) return;
    const end = firstIndex + length;
    if (end > (1n << 64n)) {
      throw new RangeError("fork table mutation range exceeds table64");
    }
    const shift = BigInt(WPK_FORK_MODULE_STATE_TABLE_PAGE_SHIFT);
    const firstPage = firstIndex >> shift;
    const finalPage = (end - 1n) >> shift;
    const pageCount = finalPage - firstPage + 1n;
    const canonical = coordinates[0]!;
    canonical.tracker.markPages(canonical.ownerId, firstPage, pageCount);
  }

  /**
   * Encode one successful null/funcref mutation using stable activation
   * coordinates.
   *
   * `null` means that this exact range needs the full typed KFMS checkpoint:
   * externref, exnref, GC values, and engine-hidden table kinds deliberately
   * stay on the Wasm-owned codec path instead of crossing JavaScript.
   */
  captureFuncrefTablePatch(
    activationId: number,
    ownerId: number,
    firstIndexValue: number | bigint,
    lengthValue: number | bigint,
  ): DylinkForkTablePatch | null {
    this.requireIdle("capture a table mutation patch");
    const table = this.requireActivationTable(activationId, ownerId);
    const firstIndex = checkedTableMutationIndex(
      firstIndexValue,
      "fork table patch first index",
    );
    const length = checkedTableMutationIndex(
      lengthValue,
      "fork table patch length",
    );
    if (length === 0n) {
      throw new Error(`${this.label}: cannot publish an empty table mutation`);
    }
    const end = firstIndex + length;
    if (
      end > BigInt(table.length)
      || firstIndex > BigInt(Number.MAX_SAFE_INTEGER)
      || end > BigInt(Number.MAX_SAFE_INTEGER)
    ) {
      throw new RangeError(
        `${this.label}: table patch range does not match its final Table`,
      );
    }

    const start = Number(firstIndex);
    const count = Number(length);
    const runs: DylinkForkTablePatchRun[] = [];
    for (let offset = 0; offset < count; offset++) {
      let value: unknown;
      try {
        value = table.get(start + offset);
      } catch {
        return null;
      }
      let recipe: DylinkForkTablePatchRun["function"];
      if (value === null) {
        recipe = null;
      } else if (typeof value === "function") {
        try {
          const encoded = this.tablePatchFunctions.encode(value);
          if (!encoded) return null;
          recipe = {
            activationId: encoded.moduleActivation,
            ordinal: encoded.ordinal,
          };
        } catch {
          return null;
        }
      } else {
        return null;
      }
      const previous = runs.at(-1);
      if (
        previous
        && (
          previous.function === null
            ? recipe === null
            : recipe !== null
              && previous.function.activationId === recipe.activationId
              && previous.function.ordinal === recipe.ordinal
        )
      ) {
        runs[runs.length - 1] = {
          length: previous.length + 1,
          function: previous.function,
        };
      } else {
        runs.push({ length: 1, function: recipe });
      }
    }
    return {
      activationId,
      ownerId,
      start,
      tableLength: table.length,
      runs,
    };
  }

  /**
   * Apply one stable null/funcref patch with this Worker's own function
   * objects. The process writer lock is held by the caller.
   */
  applyFuncrefTablePatch(patch: DylinkForkTablePatch): void {
    this.requireIdle("apply a table mutation patch");
    const table = this.requireActivationTable(
      patch.activationId,
      patch.ownerId,
    );
    if (
      patch.generation === undefined
      || !Number.isSafeInteger(patch.start)
      || patch.start < 0
      || !Number.isSafeInteger(patch.tableLength)
      || patch.tableLength < 0
    ) {
      throw new Error(`${this.label}: table patch is not a published recipe`);
    }
    const decodedRuns: Array<{
      readonly length: number;
      readonly value: CallableFunction | null;
    }> = [];
    let changedLength = 0;
    for (const run of patch.runs) {
      if (!Number.isSafeInteger(run.length) || run.length <= 0) {
        throw new Error(`${this.label}: table patch has an invalid run`);
      }
      const value = run.function === null
        ? null
        : this.tablePatchFunctions.decode({
            moduleActivation: run.function.activationId,
            ordinal: run.function.ordinal,
          });
      changedLength += run.length;
      if (!Number.isSafeInteger(changedLength)) {
        throw new Error(`${this.label}: table patch changed range is inexact`);
      }
      decodedRuns.push({ length: run.length, value });
    }
    if (patch.start + changedLength > patch.tableLength) {
      throw new Error(`${this.label}: table patch exceeds its final length`);
    }
    if (table.length > patch.tableLength) {
      throw new Error(`${this.label}: local Table is longer than its patch`);
    }
    if (table.length < patch.tableLength) {
      const growthOffset = table.length - patch.start;
      if (growthOffset < 0 || growthOffset >= changedLength) {
        throw new Error(
          `${this.label}: table patch cannot reconstruct its growth gap`,
        );
      }
      let remaining = growthOffset;
      const initializer = decodedRuns.find((run) => {
        if (remaining < run.length) return true;
        remaining -= run.length;
        return false;
      })?.value;
      if (initializer === undefined) {
        throw new Error(`${this.label}: table patch has no growth initializer`);
      }
      // WHY: nullable tables accept null, but a non-nullable typed function
      // table requires a real instance-local initializer. The patch covers
      // every new entry from the old length, so any value at that coordinate
      // is a safe temporary initializer before the exact runs are applied.
      table.grow(
        patch.tableLength - table.length,
        initializer,
      );
    }
    let index = patch.start;
    for (const run of decodedRuns) {
      for (let offset = 0; offset < run.length; offset++) {
        table.set(index++, run.value);
      }
    }
    this.markTableMutation(table, patch.start, changedLength);
  }

  currentArena(): ForkModuleStateArena {
    if (!this.arena) {
      throw new Error(`${this.label}: no fork module-state transaction is active`);
    }
    return this.arena;
  }

  currentReferences(): ForkReferenceTransaction {
    if (!this.references) {
      throw new Error(`${this.label}: no fork reference transaction is active`);
    }
    return this.references;
  }

  /** Host-owned typed scratch table imported by every activation codec. */
  gcTransitTable(): WebAssembly.Table {
    return this.gcTransit.table;
  }

  /**
   * Replace this registry's transit table with one that WRAPS an externally
   * owned table — used on the thread-fork path, where a co-resident
   * fork-module is instantiated AFTER this registry already exists (the
   * module's own `enableModuleBacking` gate needs a process-continuation
   * coordinator built from this registry first). Once adopted, the guest's
   * `__wpk_fork_ref_gc_transit` import (bound later via
   * `gcTransitTable()`/`buildForkActivationStateImports`) and the
   * fork-module's own exported table are the same object, matching the
   * process path's single-table invariant. Must be called before any
   * activation import is built and before any fork capture; the mint-time
   * default remains a self-owned table when this is never called (flag-off
   * or non-qualifying fork).
   */
  adoptGcTransit(table: WebAssembly.Table): void {
    this.gcTransit = new ForkAnyrefTransitTable(table);
  }

  /**
   * Reserve/read the same transit slots used by the normal replay owner while
   * imported references are reconstructed before every activation exists.
   */
  prepareEarlyGcTransit(maxRecipeId: number): void {
    if (
      !Number.isInteger(maxRecipeId)
      || maxRecipeId < 0
      || maxRecipeId > 0x7fff_fffe
    ) {
      throw new RangeError(`invalid early GC recipe maximum ${maxRecipeId}`);
    }
    this.gcTransit.clear();
    if (maxRecipeId > 0) this.gcTransit.ensureRecipeSlot(maxRecipeId);
  }

  readEarlyGcTransit(recipeId: number): unknown {
    if (
      !Number.isInteger(recipeId)
      || recipeId <= 0
      || recipeId > 0x7fff_fffe
    ) {
      throw new RangeError(`invalid early GC recipe id ${recipeId}`);
    }
    return this.gcTransit.get(recipeId + 1);
  }

  publishEarlyGcTransit(recipeId: number, value: unknown): void {
    if (
      !Number.isInteger(recipeId)
      || recipeId <= 0
      || recipeId > 0x7fff_fffe
    ) {
      throw new RangeError(`invalid early GC recipe id ${recipeId}`);
    }
    this.gcTransit.ensureRecipeSlot(recipeId);
    this.gcTransit.set(recipeId + 1, value);
  }

  abortEarlyGcTransit(): void {
    this.gcTransit.clear();
  }

  decodeStaticRoot(activationId: number, ordinal: number): unknown {
    return this.staticRoots.decode({
      moduleActivation: activationId,
      ordinal,
    });
  }

  /**
   * `__wpk_fork_ref_provenance_externref`'s host-import body (N1 Node/browser
   * parity, mirrors native's `provenance_externref` wire). Called by the
   * fork-instrument-inserted wrapper immediately after a real host-import
   * call site returns an externref value, BEFORE the value reaches the
   * original caller — the only sound moment to record `(value -> handle)`
   * (see `ForkExternrefProvenanceTable`'s doc comment). Pass-through:
   * returns `value` unchanged.
   *
   * The "handle" is read back, never minted: `value` is expected to already
   * be a self-describing worker-local `ForkExternrefToken` (the shape every
   * current externref-producing host import returns, materialized from a
   * broker handle by `ForkExternrefTokenCache.materialize`/`.encode`). A
   * value with no such self-describing handle simply has nothing to record
   * here — the same documented boundary native's `encode_externref` guard
   * describes for a host import with no self-describing `u32` payload.
   */
  recordExternrefProvenance(value: unknown): unknown {
    if (
      (typeof value !== "object" || value === null)
      && typeof value !== "function"
    ) {
      return value;
    }
    const handle = this.externrefs.tryEncode(value);
    if (handle !== undefined) {
      this.externrefProvenance.register(value, handle);
    }
    return value;
  }

  /**
   * Reserve a gated placeholder recipe for an anyref value that the module GC
   * codec has already published into transit slot 0 (`lookup` / `claim` /
   * broker).
   *
   * The live anyref is republished at `recipe + 1` so the PARENT continuation
   * replay — a same-worker `table.get(transit, recipe + 1)` in the module's
   * `decode_anyref` — restores the identical live object without any typed
   * reconstruction. A gated `lookup` returning this NONZERO recipe makes the
   * guest treat the value as an already-seen alias, so it never recurses into
   * the struct/array field walk: no layout descriptor, provenance, or
   * static-root catalog work runs on the capture side.
   */
  reserveGatedTransitPlaceholder(): number {
    const value = this.gcTransit.get(0);
    const recipeId = this.currentReferences().reserveGatedPlaceholder(value);
    this.gcTransit.ensureRecipeSlot(recipeId);
    this.gcTransit.set(recipeId + 1, value);
    return recipeId;
  }

  /**
   * Reserve a gated placeholder recipe for a value the guest hands directly to
   * a capture import (`encode_externref`) or republishes into transit itself
   * (`i31`).
   *
   * The runtime externref/funcref codec restores the parent from
   * `capturedValues` (kept here), and the i31 bridge publishes its own
   * `i31ref` into `recipe + 1`; both only need the transit slot sized so a later
   * guest `table.set(transit, recipe + 1)` publish store stays in bounds.
   */
  reserveGatedLeafPlaceholder(value: unknown): number {
    const recipeId = this.currentReferences().reserveGatedPlaceholder(value);
    this.gcTransit.ensureRecipeSlot(recipeId);
    return recipeId;
  }

  lookupGcSlot(requestingActivation: number, slot: number): number {
    const provenance = this.gcProvenance.find(this.gcTransit.get(slot));
    if (provenance && provenance.activationId !== requestingActivation) {
      // Canonically equivalent recursive types can test true in more than one
      // instance. Constructor/segment provenance decides the reconstruction
      // owner before the requesting codec claims graph identity.
      return this.requireTypedProvider(provenance.activationId).encodeSlot(slot);
    }
    return this.currentReferences().lookupGcSlot(this.gcTransit.table, slot);
  }

  claimGcSlot(slot: number): number {
    const recipeId = this.currentReferences().claimGcSlot(
      this.gcTransit.table,
      slot,
    );
    this.gcTransit.ensureRecipeSlot(recipeId);
    return recipeId;
  }

  encodeI31(value: number): number {
    const recipeId = this.currentReferences().encodeI31(value);
    this.gcTransit.ensureRecipeSlot(recipeId);
    return recipeId;
  }

  captureGcLayout(
    activationId: number,
    slot: number,
    baseLayoutId: number,
  ): number {
    const provider = this.requireTypedProvider(activationId);
    const base = provider.descriptor.require(baseLayoutId);
    const object = this.gcTransit.get(slot);
    const provenance = this.gcProvenance.lookup(
      object,
      activationId,
      provider.descriptor,
      baseLayoutId,
    );
    if (provenance) return provenance.layoutId;
    if ((base.flags & FORK_GC_LAYOUT_REQUIRES_PROVENANCE) !== 0) {
      throw new Error(
        `${this.label}: GC layout ${activationId}:${baseLayoutId} `
        + "requires constructor provenance",
      );
    }
    return base.id;
  }

  defineGc(
    activationId: number,
    recipeId: number,
    recordActivationId: number,
    typeOrdinal: number,
    layoutId: number,
    kind: number,
    scalarPointer: number | bigint,
    scalarByteLength: number,
    referenceVectorOrdinal: number,
  ): void {
    if (recordActivationId !== activationId) {
      throw new Error(
        `activation ${activationId} cannot define GC state for `
        + `activation ${recordActivationId}`,
      );
    }
    const provider = this.requireTypedProvider(activationId);
    const layout = provider.descriptor.require(layoutId);
    const source = this.currentReferences().capturedGcValue(recipeId);
    const record = this.gcProvenance.lookup(
      source,
      activationId,
      provider.descriptor,
      layout.baseLayoutId,
    );
    let provenance: ForkGcDefinitionProvenance | null = null;
    if (record) {
      const recipeIds = record.references.map((reference) =>
        reference === null ? 0 : this.encodeGcObject(reference)
      );
      provenance = { record, recipeIds };
    }
    this.currentReferences().defineGc(
      recipeId,
      recordActivationId,
      typeOrdinal,
      layoutId,
      kind,
      scalarPointer,
      scalarByteLength,
      referenceVectorOrdinal,
      provider.descriptor,
      provenance,
    );
  }

  routeGc(recipeId: number, expectedActivation: number): number {
    return this.currentReferences().routeGc(recipeId, expectedActivation);
  }

  gcPayloadLength(
    recipeId: number,
    expectedActivation: number,
    expectedLayoutId: number,
  ): number {
    return this.currentReferences().gcPayloadLength(
      recipeId,
      expectedActivation,
      expectedLayoutId,
    );
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
    return this.currentReferences().loadGc(
      recipeId,
      moduleActivation,
      typeOrdinal,
      layoutId,
      kind,
      scalarDestination,
      scalarByteLength,
    );
  }

  /**
   * Route a Wasm-GC value at `slot` to its owning activation's typed provider,
   * or intern it as a plain host externref when no module codec claims it.
   *
   * KEPT GATED (N1/F6 boundary, unlike the rest of this revival): a value
   * reaching the final fallback is an internalized `any.convert_extern`
   * hostref with no recorded production-site provenance, which is the same
   * "GC-internalized externref" case native scopes out to F6. Fabricating a
   * handle here would be exactly the disavowed unsound reverse lookup, so
   * this marks the fork unsupported and returns a survivable placeholder
   * instead of calling the deleted `encodeExternref`.
   */
  encodeGcFromSlot(sourceActivation: number, slot: number): number {
    const provenance = this.gcProvenance.find(this.gcTransit.get(slot));
    if (
      provenance
      && provenance.activationId !== sourceActivation
    ) {
      return this.requireTypedProvider(provenance.activationId).encodeSlot(slot);
    }
    const candidates = this.activations().filter(
      ({ activationId, typedReferenceProvider }) =>
        activationId !== sourceActivation && typedReferenceProvider !== undefined,
    );
    for (const activation of candidates) {
      const provider = this.requireTypedProvider(activation.activationId);
      const packed = provider.probe(slot);
      if (packed === 0n) continue;
      const baseLayoutId = Number(packed & 0xffff_ffffn);
      const typeOrdinal = Number(packed >> 32n);
      const base = provider.descriptor.require(baseLayoutId);
      if (
        base.baseLayoutId !== base.id
        || base.typeOrdinal !== typeOrdinal
      ) {
        throw new Error(
          `${this.label}: activation ${activation.activationId} returned `
          + "an invalid GC probe coordinate",
        );
      }
      return provider.encodeSlot(slot);
    }
    // N1/F6 boundary: no module codec recognized the internal value, so it is
    // a GC-internalized hostref made by `any.convert_extern` with no recorded
    // production-site provenance. This is out of scope for this revival (F5
    // covers only a plain host externref reached with recorded provenance);
    // gate cleanly instead of mis-capturing.
    this.markUnsupportedReferenceKind("gc (internalized externref)");
    return this.reserveGatedTransitPlaceholder();
  }

  beginGcProvenance(
    expectedActivationId: number,
    slot: number,
    activationId: number,
    baseLayoutId: number,
    specializedLayoutId: number,
    scalarLo: bigint,
    scalarHi: bigint,
    referenceCount: number,
  ): number {
    return this.gcProvenance.begin(
      this.gcTransit.table,
      this.requireTypedProvider(expectedActivationId).descriptor,
      expectedActivationId,
      slot,
      activationId,
      baseLayoutId,
      specializedLayoutId,
      scalarLo,
      scalarHi,
      referenceCount,
    );
  }

  appendGcProvenanceReference(
    token: number,
    index: number,
    slot: number,
  ): void {
    this.gcProvenance.appendReference(
      this.gcTransit.table,
      token,
      index,
      slot,
    );
  }

  endGcProvenance(token: number): void {
    this.gcProvenance.end(token);
  }

  /**
   * Start capture and snapshot every registered module before stack unwind.
   *
   * Frame codecs continue appending reference nodes while unwind walks
   * outward. `sealCapture` publishes the single process graph only after the
   * last committed frame exists.
   */
  beginCapture(arena: ForkModuleStateArena): void {
    this.requirePhase("idle", "begin fork activation capture");
    if (!arena.hasActiveArena() || arena.isSealed()) {
      throw new Error(`${this.label}: capture requires a writable module-state arena`);
    }
    // A prior trap must never make a stale object appear as a recipe hit.
    this.gcProvenance.abortPending();
    // A partially-consumed marker from an aborted prior capture must never
    // gate this fork; the run loop's read-and-clear is the primary owner.
    this.unsupportedReferenceKind = null;
    this.gcTransit.clear();
    const functions = this.buildFunctionCatalog();
    const references = new ForkReferenceTransaction(
      functions,
      this.externrefs,
      this.memory,
      this.allocateScratch,
      this.deallocateScratch,
      `${this.label}: references`,
      this.staticRoots,
      this.typedReplayOwner(),
      this.externrefProvenance,
      this.captureModule,
    );
    references.beginCapture();
    this.functions = functions;
    this.references = references;
    this.arena = arena;
    this.phase = "capture";
    try {
      for (const activation of this.activations()) {
        arena.appendModule({
          activationId: activation.activationId,
          templateId: activation.templateId,
        });
      }
      for (const activation of this.activations()) {
        activation.moduleState.save(activation.activationId);
      }
    } catch (error) {
      this.abort();
      throw error;
    }
  }

  /**
   * Seal one process-wide, table-only snapshot for peer Workers.
   *
   * The generated helpers reuse the same typed reference codecs as fork, so
   * exnref and Wasm-GC entries never cross the JavaScript Table API. Every
   * cumulative dirty page is captured in one reference transaction; aliases
   * therefore remain aliases even when they span tables, pages, or module
   * activations.
   */
  captureTableState(arena: ForkModuleStateArena): number {
    this.requirePhase("idle", "capture peer table state");
    if (!arena.hasActiveArena() || arena.isSealed()) {
      throw new Error(
        `${this.label}: peer table capture requires a writable module-state arena`,
      );
    }
    this.gcProvenance.abortPending();
    this.gcTransit.clear();
    const functions = this.buildFunctionCatalog();
    const references = new ForkReferenceTransaction(
      functions,
      this.externrefs,
      this.memory,
      this.allocateScratch,
      this.deallocateScratch,
      `${this.label}: peer table references`,
      this.staticRoots,
      this.typedReplayOwner(),
      this.externrefProvenance,
    );
    references.beginCapture();
    this.functions = functions;
    this.references = references;
    this.arena = arena;
    this.phase = "table-capture";
    try {
      for (const activation of this.activations()) {
        arena.appendModule({
          activationId: activation.activationId,
          templateId: activation.templateId,
        });
      }
      for (const activation of this.activations()) {
        activation.moduleState.saveTables(activation.activationId);
      }
      references.sealInto(arena);
      const root = arena.seal();
      // No live activation consumes capture-side recipe objects. Drop every
      // transient codec/catalog root after the scalar arena is sealed.
      this.abort();
      return root;
    } catch (error) {
      this.abort();
      throw error;
    }
  }

  /**
   * Apply one validated table-only snapshot to this Worker's instance graph.
   */
  restoreTableState(arena: ForkModuleStateArena): void {
    this.requirePhase("idle", "restore peer table state");
    if (!arena.hasActiveArena() || !arena.isSealed()) {
      throw new Error(
        `${this.label}: peer table replay requires a validated sealed arena`,
      );
    }
    this.gcTransit.clear();
    this.gcProvenance.abortPending();
    const records = arena.recordViews();
    const declared = records
      .filter((record) => record.kind === ForkModuleStateRecordKind.Module)
      .map((record) => record.activationId)
      .sort((left, right) => left - right);
    const registered = this.activations().map(({ activationId }) => activationId);
    if (
      declared.length !== registered.length
      || declared.some((id, index) => id !== registered[index])
    ) {
      throw new Error(
        `${this.label}: peer table snapshot activations do not match the local registry`,
      );
    }
    for (const activation of this.activations()) {
      requireForkModuleTemplate(
        records,
        activation.activationId,
        activation.templateId,
      );
    }
    const functions = this.buildFunctionCatalog();
    const references = new ForkReferenceTransaction(
      functions,
      this.externrefs,
      this.memory,
      this.allocateScratch,
      this.deallocateScratch,
      `${this.label}: peer table references`,
      this.staticRoots,
      this.typedReplayOwner(),
      this.externrefProvenance,
    );
    references.attachChild(records);
    this.functions = functions;
    this.references = references;
    this.arena = arena;
    this.phase = "table-replay";
    try {
      references.materializeAllTyped();
      for (const activation of this.activations()) {
        activation.moduleState.restoreTables(activation.activationId);
      }
      references.finishReplay();
      for (const activation of this.activations()) {
        activation.exceptionProvider?.clear();
        activation.typedReferenceProvider?.clear?.();
      }
      this.gcTransit.clear();
      this.resetTransaction();
    } catch (error) {
      this.abort();
      throw error;
    }
  }

  sealCapture(): void {
    this.requirePhase("capture", "seal fork activation capture");
    const references = this.currentReferences();
    const arena = this.currentArena();
    references.sealInto(arena);
    arena.seal();
    this.phase = "sealed-parent";
  }

  borrowedReplayScratchCapacity(): number {
    this.requirePhase(
      "sealed-parent",
      "read borrowed replay scratch capacity",
    );
    return this.currentReferences().borrowedReplayScratchCapacity();
  }

  beginParentReplay(): void {
    this.requirePhase("sealed-parent", "begin parent activation replay");
    this.currentReferences().beginParentReplay();
    this.phase = "parent-replay";
  }

  /**
   * Attach copied recipes only after every child activation and codec exists.
   */
  attachChild(
    arena: ForkModuleStateArena,
    decodedReferences?: DecodedSegmentedForkReferenceTransaction,
  ): void {
    this.requirePhase("idle", "attach child activation state");
    if (!arena.hasActiveArena() || !arena.isSealed()) {
      throw new Error(`${this.label}: child replay requires a validated sealed arena`);
    }
    this.gcTransit.clear();
    this.gcProvenance.abortPending();
    const records = arena.recordViews();
    const declared = records
      .filter((record) => record.kind === ForkModuleStateRecordKind.Module)
      .map((record) => record.activationId)
      .sort((left, right) => left - right);
    const registered = this.activations().map(({ activationId }) => activationId);
    if (
      declared.length !== registered.length
      || declared.some((id, index) => id !== registered[index])
    ) {
      throw new Error(
        `${this.label}: copied module activations do not match the fresh child registry`,
      );
    }
    for (const activation of this.activations()) {
      requireForkModuleTemplate(
        records,
        activation.activationId,
        activation.templateId,
      );
    }
    const functions = this.buildFunctionCatalog();
    const references = new ForkReferenceTransaction(
      functions,
      this.externrefs,
      this.memory,
      this.allocateScratch,
      this.deallocateScratch,
      `${this.label}: references`,
      this.staticRoots,
      this.typedReplayOwner(),
      this.externrefProvenance,
    );
    references.attachChild(decodedReferences ?? records);
    this.functions = functions;
    this.references = references;
    this.arena = arena;
    this.phase = "child-replay";
  }

  restoreModuleState(typedDrive?: () => void): void {
    if (this.phase !== "parent-replay" && this.phase !== "child-replay") {
      throw new Error(
        `${this.label}: cannot restore module state while registry is ${this.phase}`,
      );
    }
    if (this.phase === "child-replay") {
      // WHY: generated global/table restore helpers decode recipe ids through
      // the fresh instance's transit table. Publish every reconstructed typed
      // identity first, while passive data/element segments are still intact
      // for array.new_data/array.new_elem constructors.
      //
      // P2 (Path B): `typedDrive`, when supplied by the module-backed child
      // coordinator, makes the co-resident fork-module the SOLE typed
      // reconstructor — it drives the whole `drive_plan` walk (static-root
      // publish, EVERY externref transit publish, then the typed allocate/fill/
      // exn order), so no JS reconstruction (validation, PHASE A/B, or the
      // sub-loop) runs on the module path.
      this.currentReferences().materializeAllTyped(typedDrive);
    }
    for (const activation of this.activations()) {
      activation.moduleState.restore(activation.activationId);
    }
    for (const activation of this.activations()) {
      activation.moduleState.finishRestore(activation.activationId);
    }
  }

  finishReplay(): void {
    if (this.phase !== "parent-replay" && this.phase !== "child-replay") {
      throw new Error(
        `${this.label}: cannot finish activation replay while registry is ${this.phase}`,
      );
    }
    let failure: unknown;
    try {
      this.references?.finishReplay();
    } catch (error) {
      failure = error;
    }
    for (const activation of this.activations()) {
      for (const provider of [
        activation.exceptionProvider,
        activation.typedReferenceProvider,
      ]) {
        try {
          provider?.clear?.();
        } catch (error) {
          failure ??= error;
        }
      }
    }
    try {
      this.gcTransit.clear();
    } catch (error) {
      failure ??= error;
    }
    this.resetTransaction();
    if (failure !== undefined) throw failure;
  }

  abort(): void {
    let failure: unknown;
    try {
      this.references?.abort();
    } catch (error) {
      failure = error;
    }
    for (const activation of this.activations()) {
      for (const provider of [
        activation.exceptionProvider,
        activation.typedReferenceProvider,
      ]) {
        try {
          provider?.abort?.();
        } catch (error) {
          failure ??= error;
        }
      }
    }
    try {
      this.gcTransit.clear();
    } catch (error) {
      failure ??= error;
    }
    this.resetTransaction();
    if (failure !== undefined) throw failure;
  }

  clear(): void {
    this.abort();
    this.registrations.clear();
    this.bootstrapped.clear();
    this.activationTables.clear();
    this.tablePatchFunctions.clear();
    this.tableCoordinates = new WeakMap();
    this.staticRoots.clear();
    this.gcProvenance.clear();
  }

  phaseName(): RegistryPhase {
    return this.phase;
  }

  /**
   * Record that the active capture encountered a gated reference kind. First
   * observation wins so the parent run loop reports the first kind the guest's
   * save walk actually reached. Called from the capture-side record-stubs in
   * `buildForkActivationStateImports`; never throws (throwing here cannot carry
   * an errno through the Wasm fork save walk).
   */
  markUnsupportedReferenceKind(kind: string): void {
    this.unsupportedReferenceKind ??= kind;
  }

  /**
   * Read and clear the gated reference kind observed during capture. Returns
   * `null` when the fork carried only supported kinds. Read-and-clear so a
   * gated kind can never leak into a subsequent, supported fork.
   */
  takeUnsupportedReferenceKind(): string | null {
    const kind = this.unsupportedReferenceKind;
    this.unsupportedReferenceKind = null;
    return kind;
  }

  private buildFunctionCatalog(): ForkFunctionCatalog {
    const functions = new ForkFunctionCatalog();
    for (const activation of this.activations()) {
      functions.register(activation.activationId, activation.functionCatalog);
    }
    return functions;
  }

  private requireActivationTable(
    activationId: number,
    ownerId: number,
  ): WebAssembly.Table {
    assertActivationId(activationId);
    if (
      !Number.isInteger(ownerId)
      || ownerId <= 0
      || ownerId > 0xffff_ffff
    ) {
      throw new RangeError(`invalid fork table owner id ${ownerId}`);
    }
    const entry = this.activationTables
      .get(activationId)
      ?.find((candidate) => candidate.ownerId === ownerId);
    if (!entry) {
      throw new Error(
        `${this.label}: table coordinate ${activationId}:${ownerId} is not registered`,
      );
    }
    return entry.table;
  }

  private bindTableCoordinates(table: WebAssembly.Table): void {
    const coordinates = this.tableCoordinates.get(table);
    if (!coordinates || coordinates.length === 0) return;
    const canonical = coordinates[0]!;
    canonical.tracker.setStateOwner(canonical.ownerId, true);
    for (const coordinate of coordinates.slice(1)) {
      coordinate.tracker.aliasOwner(
        coordinate.ownerId,
        canonical.tracker,
        canonical.ownerId,
      );
      coordinate.tracker.setStateOwner(coordinate.ownerId, false);
    }
  }

  private requireTypedProvider(
    activationId: number,
  ): ForkGcCodecProvider & ForkActivationTypedReferenceProvider {
    const provider = this.getActivation(activationId).typedReferenceProvider;
    if (
      !provider
      || provider.activationId !== activationId
      || !provider.descriptor
      || typeof provider.probe !== "function"
      || typeof provider.encodeSlot !== "function"
      || typeof provider.allocate !== "function"
      || typeof provider.fill !== "function"
      || typeof provider.publishExternref !== "function"
    ) {
      throw new Error(
        `${this.label}: module activation ${activationId} has no GC codec`,
      );
    }
    return provider as ForkGcCodecProvider & ForkActivationTypedReferenceProvider;
  }

  private encodeGcObject(value: object): number {
    this.gcTransit.set(0, value);
    try {
      return this.encodeGcFromSlot(-1, 0);
    } finally {
      this.gcTransit.clearSlot(0);
    }
  }

  private typedReplayOwner() {
    return {
      prepareTransit: (maxRecipeId: number): void => {
        if (maxRecipeId > 0) this.gcTransit.ensureRecipeSlot(maxRecipeId);
      },
      publishTransit: (recipeId: number, value: unknown): void => {
        this.gcTransit.ensureRecipeSlot(recipeId);
        this.gcTransit.set(recipeId + 1, value);
      },
      publishExternref: (recipeId: number, value: unknown): void => {
        const provider = this.activations()
          .map(({ activationId, typedReferenceProvider }) =>
            typedReferenceProvider ? this.requireTypedProvider(activationId) : null
          )
          .find((candidate) => candidate !== null);
        if (!provider) {
          throw new Error(
            `${this.label}: externref replay has no generated GC codec`,
          );
        }
        this.gcTransit.ensureRecipeSlot(recipeId);
        provider.publishExternref(recipeId, value);
        if (!Object.is(this.gcTransit.get(recipeId + 1), value)) {
          throw new Error(
            `${this.label}: externref recipe ${recipeId} lost token identity `
            + "during anyref publication",
          );
        }
      },
      provider: (activationId: number): ForkGcCodecProvider =>
        this.requireTypedProvider(activationId),
      providers: (): readonly ForkGcCodecProvider[] =>
        this.activations().flatMap(({ activationId, typedReferenceProvider }) => {
          if (
            !typedReferenceProvider?.descriptor
            || typeof typedReferenceProvider.probe !== "function"
            || typeof typedReferenceProvider.encodeSlot !== "function"
            || typeof typedReferenceProvider.allocate !== "function"
            || typeof typedReferenceProvider.fill !== "function"
            || typeof typedReferenceProvider.publishExternref !== "function"
          ) {
            return [];
          }
          return [this.requireTypedProvider(activationId)];
        }),
      validateExceptionOwner: (activationId: number): void => {
        if (activationId === FORK_HOST_EXCEPTION_ACTIVATION_ID) {
          if (!this.activations().some(({ exceptionProvider }) =>
            exceptionProvider?.materialize
          )) {
            throw new Error(
              `${this.label}: host exception replay has no local codec`,
            );
          }
          return;
        }
        const provider = this.getActivation(activationId).exceptionProvider;
        if (!provider?.materialize) {
          throw new Error(
            `${this.label}: activation ${activationId} cannot materialize `
            + "exception recipes",
          );
        }
      },
      materializeException: (
        recipeId: number,
        activationId: number,
      ): void => {
        const provider = activationId === FORK_HOST_EXCEPTION_ACTIVATION_ID
          ? this.activations()
            .map(({ exceptionProvider }) => exceptionProvider)
            .find((candidate) => candidate?.materialize)
          : this.getActivation(activationId).exceptionProvider;
        if (!provider?.materialize) {
          throw new Error(
            `${this.label}: no exception materializer for activation `
            + `${activationId}`,
          );
        }
        provider.materialize(recipeId);
      },
    };
  }

  private resetTransaction(): void {
    this.functions?.clear();
    this.functions = null;
    this.references = null;
    this.arena = null;
    this.phase = "idle";
  }

  private requireIdle(operation: string): void {
    this.requirePhase("idle", operation);
  }

  private requirePhase(expected: RegistryPhase, operation: string): void {
    if (this.phase !== expected) {
      throw new Error(
        `${this.label}: cannot ${operation} while activation registry is ${this.phase}; `
        + `expected ${expected}`,
      );
    }
  }
}
