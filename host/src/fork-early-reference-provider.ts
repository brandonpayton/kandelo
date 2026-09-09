import {
  WPK_FORK_MODULE_STATE_GLOBAL_TYPE_ANYREF,
  WPK_FORK_MODULE_STATE_GLOBAL_TYPE_EXNREF,
  WPK_FORK_MODULE_STATE_GLOBAL_TYPE_EXTERNREF,
  WPK_FORK_MODULE_STATE_GLOBAL_TYPE_FUNCREF,
} from "./generated/abi";
import type {
  ForkImportedReferenceProvider,
} from "./fork-imported-globals";
import {
  FORK_GC_FIELD_ALLOCATION_DEPENDENCY,
  FORK_GC_FIELD_REFERENCE,
  FORK_GC_LAYOUT_DEFAULTABLE_SHELL,
  ForkGcConstructorKind,
  type ForkGcCodecDescriptor,
  type ForkGcCodecProvider,
  type ForkGcLayoutDescriptor,
} from "./fork-gc-codec";
import type {
  ForkExceptionCodecDescriptor,
} from "./fork-exception-provider";
import {
  ForkImportedGlobalBindingKind,
  ForkModuleStateRecordKind,
  importedGlobalBindingsForChild,
  type ForkModuleStateRecordView,
} from "./fork-module-state";
import {
  type ForkReferenceRecipeEntry,
  type ForkReferenceRecipeNode,
} from "./fork-reference-recipes";
// Staying-glue reference contracts + the host-exception sentinel + the shared
// scratch types. Re-homed out of the deletable JS reference engine
// (`fork-reference-transaction.ts` / `fork-activation-registry.ts`) so this
// pre-instantiation imported-global reconstruction FLOOR no longer imports the
// engine files the A5 delete step removes. `adoptInto` is typed against the
// minimal `ForkReferenceReplayAdoptionTarget` (which the deletable
// `ForkReferenceTransaction` satisfies structurally) so the runtime handoff is
// unchanged while the deletable value import is gone.
import { FORK_HOST_EXCEPTION_ACTIVATION_ID } from "./fork-reference-wire";
import type {
  ForkActivationExceptionProvider,
  ForkExternrefRecipeProvider,
  ForkReferenceChildReplayAdoption,
  ForkReferenceReplayAdoptionTarget,
} from "./fork-reference-contracts";
import type {
  ForkReferenceScratchAllocate,
  ForkReferenceScratchDeallocate,
} from "./fork-reference-scratch";
import {
  PagedForkReferenceDirectory,
  type ForkReferenceDirectory,
  type MutableForkReferenceVectorInternIndex,
} from "./fork-reference-wire";
// The read-only vector-directory materialization utilities the reconstruction
// floor genuinely needs still live in `fork-reference-segments.ts` (moving them
// would drag the encode-side vector subsystem — an A5-full extraction). They are
// floor infrastructure, NOT the deletable JS reference ENGINE (registry +
// transaction).
import {
  findForkReferenceVectorOrdinal,
  forkReferenceVectorFrom,
  ForkReferenceDirectoryOverlay,
  indexForkReferenceVector,
  type DecodedSegmentedForkReferenceTransaction,
  type ForkReferenceVector,
} from "./fork-reference-segments";

const MAX_REFERENCE_VECTOR_ORDINAL = 0xffff_ffff;

type ReferenceTypeCode =
  | typeof WPK_FORK_MODULE_STATE_GLOBAL_TYPE_FUNCREF
  | typeof WPK_FORK_MODULE_STATE_GLOBAL_TYPE_EXTERNREF
  | typeof WPK_FORK_MODULE_STATE_GLOBAL_TYPE_EXNREF
  | typeof WPK_FORK_MODULE_STATE_GLOBAL_TYPE_ANYREF;

type ProviderPhase = "active" | "adopted" | "aborted";

export interface ForkEarlyReferenceActivationDeclaration {
  readonly activationId: number;
  /**
   * Descriptor-only type evidence is available from the module before its
   * instance exists. It is what makes owner planning and graph validation an
   * actual pre-instantiation operation.
   */
  readonly gcDescriptor?: ForkGcCodecDescriptor;
  readonly exceptionDescriptor?: ForkExceptionCodecDescriptor;
}

export interface ForkEarlyFunctionProvider {
  decode(ordinal: number): CallableFunction;
}

export interface ForkEarlyStaticRootProvider {
  decode(ordinal: number): unknown;
}

/**
 * View of the same anyref transit table imported by generated activation
 * codecs. Implementations must map recipe N to the canonical slot N + 1.
 */
export interface ForkEarlyReferenceTransit {
  prepare(maxRecipeId: number): void;
  /**
   * Route an already-instantiated GC root at canonical slot `recipeId + 1`.
   * Only instrumenter-proven anyref-compatible static roots use this path.
   */
  publish(recipeId: number, value: unknown): void;
  read(recipeId: number): unknown;
  /** Release every early typed root if launch fails before adoption. */
  abort(): void;
}

export interface ForkEarlyReferenceActivationProviders {
  readonly activationId: number;
  readonly functions?: ForkEarlyFunctionProvider;
  readonly staticRoots?: ForkEarlyStaticRootProvider;
  readonly typed?: ForkGcCodecProvider;
  readonly exceptions?: ForkActivationExceptionProvider;
  /**
   * Optional activation-owned rollback for roots created before the registry
   * takes over. It is not called after successful adoption.
   */
  readonly abort?: () => void;
}

export interface ForkEarlyChildReferenceProviderOptions {
  readonly records: readonly ForkModuleStateRecordView[];
  /** One decoder result shared verbatim with ordinary child replay adoption. */
  readonly transaction: DecodedSegmentedForkReferenceTransaction;
  readonly declarations: readonly ForkEarlyReferenceActivationDeclaration[];
  readonly externrefs: ForkExternrefRecipeProvider;
  readonly transit: ForkEarlyReferenceTransit;
  readonly memory: WebAssembly.Memory;
  readonly allocateScratch: ForkReferenceScratchAllocate;
  readonly deallocateScratch: ForkReferenceScratchDeallocate;
  readonly label?: string;
}

interface RegisteredActivation extends ForkEarlyReferenceActivationProviders {}

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

function assertU32(value: number, context: string): number {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new RangeError(`${context} is not a u32`);
  }
  return value;
}

function assertRecipeId(value: number, nodeCount: number): number {
  if (
    !Number.isInteger(value)
    || value < 0
    || value > 0xffff_ffff
    || value >= nodeCount
  ) {
    throw new RangeError(`invalid fork reference recipe id ${value}`);
  }
  return value;
}

function requireReferenceTypeCode(value: number): ReferenceTypeCode {
  switch (value) {
    case WPK_FORK_MODULE_STATE_GLOBAL_TYPE_FUNCREF:
    case WPK_FORK_MODULE_STATE_GLOBAL_TYPE_EXTERNREF:
    case WPK_FORK_MODULE_STATE_GLOBAL_TYPE_EXNREF:
    case WPK_FORK_MODULE_STATE_GLOBAL_TYPE_ANYREF:
      return value;
    default:
      throw new Error(`invalid imported reference ABI type code ${value}`);
  }
}

function nodeEdges(node: ForkReferenceRecipeNode): readonly number[] {
  switch (node.kind) {
    case "exnref":
      return node.payloads;
    case "struct":
      return node.fields;
    case "array":
      return node.elements;
    case "null":
    case "funcref":
    case "externref":
    case "i31":
    case "static-root":
      return [];
  }
}

function sameGcDescriptor(
  left: ForkGcCodecDescriptor,
  right: ForkGcCodecDescriptor,
): boolean {
  if (left.layouts.length !== right.layouts.length) return false;
  return left.layouts.every((layout, index) => {
    const other = right.layouts[index]!;
    return (
      layout.id === other.id
      && layout.typeOrdinal === other.typeOrdinal
      && layout.kind === other.kind
      && layout.constructor === other.constructor
      && layout.flags === other.flags
      && layout.scalarLengthOrStride === other.scalarLengthOrStride
      && layout.superTypeOrdinal === other.superTypeOrdinal
      && layout.baseLayoutId === other.baseLayoutId
      && layout.auxiliary === other.auxiliary
      && layout.provenanceScalarLength === other.provenanceScalarLength
      && layout.provenanceReferenceCount === other.provenanceReferenceCount
      && layout.fields.length === other.fields.length
      && layout.fields.every((field, fieldIndex) => {
        const otherField = other.fields[fieldIndex]!;
        return (
          field.storage === otherField.storage
          && field.flags === otherField.flags
          && field.scalarOffset === otherField.scalarOffset
          && field.referenceOrdinal === otherField.referenceOrdinal
        );
      })
    );
  });
}

function validateGcSnapshot(
  layout: ForkGcLayoutDescriptor,
  scalars: Uint8Array,
  references: readonly number[],
  context: string,
): void {
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

function validateGcRecipe(
  entry: ForkReferenceRecipeEntry,
  descriptor: ForkGcCodecDescriptor,
): ForkGcLayoutDescriptor {
  const node = entry.node;
  if (node.kind !== "struct" && node.kind !== "array") {
    throw new Error(`fork recipe ${entry.id} is not a GC aggregate`);
  }
  const layout = descriptor.require(node.layoutId ?? 0);
  if (
    layout.typeOrdinal !== node.typeOrdinal
    || (node.kind === "struct" ? 1 : 2) !== layout.kind
  ) {
    throw new Error(
      `fork GC recipe ${entry.id} has an invalid type/layout coordinate`,
    );
  }
  const scalars = node.scalars ?? new Uint8Array();
  const references = node.kind === "struct" ? node.fields : node.elements;
  if (
    scalars.byteLength < layout.provenanceScalarLength
    || references.length < layout.provenanceReferenceCount
  ) {
    throw new Error(
      `fork GC recipe ${entry.id} has truncated constructor provenance`,
    );
  }
  validateGcSnapshot(
    layout,
    scalars.subarray(layout.provenanceScalarLength),
    references.slice(layout.provenanceReferenceCount),
    `fork GC recipe ${entry.id}`,
  );
  return layout;
}

function gcAllocationDependencies(
  node: Extract<ForkReferenceRecipeNode, { kind: "struct" | "array" }>,
  layout: ForkGcLayoutDescriptor,
): readonly number[] {
  const edges = node.kind === "struct" ? node.fields : node.elements;
  const dependencies = edges.slice(0, layout.provenanceReferenceCount);
  const snapshotStart = layout.provenanceReferenceCount;
  if (node.kind === "struct") {
    for (const field of layout.fields) {
      if (
        (field.flags & FORK_GC_FIELD_ALLOCATION_DEPENDENCY) !== 0
        && field.referenceOrdinal !== null
      ) {
        dependencies.push(edges[snapshotStart + field.referenceOrdinal]!);
      }
    }
    return dependencies;
  }
  if ((layout.fields[0]!.flags & FORK_GC_FIELD_REFERENCE) === 0) {
    return dependencies;
  }
  const snapshot = edges.slice(snapshotStart);
  if (layout.constructor === ForkGcConstructorKind.ArrayFixed) {
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

/**
 * Pre-instantiation child owner for raw imported reference globals.
 *
 * It never treats a parent Worker object as reconstruction evidence. Every
 * non-null value comes from a deterministic recipe owner registered from a
 * fresh activation, or from the process externref provider.
 */
export class ForkEarlyChildReferenceProvider
  implements ForkImportedReferenceProvider
{
  private transaction: DecodedSegmentedForkReferenceTransaction | null;
  private nodes: ForkReferenceDirectory<ForkReferenceRecipeEntry>;
  private readonly referenceVectors =
    new ForkReferenceDirectoryOverlay<ForkReferenceVector>();
  private readonly referenceVectorIntern:
    MutableForkReferenceVectorInternIndex = new Map();
  private readonly declarations =
    new Map<number, ForkEarlyReferenceActivationDeclaration>();
  private readonly registrations = new Map<number, RegisteredActivation>();
  private readonly materializedValues = new Map<number, unknown>();
  private readonly publishedExternrefRecipes = new Set<number>();
  private readonly allocatedTypedRecipes = new Set<number>();
  private readonly filledTypedRecipes = new Set<number>();
  private readonly materializedExceptionRecipes = new Set<number>();
  private readonly exceptionCacheIndexes = new Map<number, number>();
  private readonly gcLayouts = new Map<number, ForkGcLayoutDescriptor>();
  private readonly replayGcVectors = new Map<number, number>();
  private readonly scratchChunks: ScratchChunk[] = [];
  private readonly scratchReservations: ScratchReservation[] = [];
  private readonly i31Owner: number | null;
  private readonly hostExceptionOwner: number | null;
  private transitPrepared = false;
  private phase: ProviderPhase = "active";
  private readonly label: string;
  private readonly externrefs: ForkExternrefRecipeProvider;
  private readonly transit: ForkEarlyReferenceTransit;
  private readonly memory: WebAssembly.Memory;
  private readonly allocateScratch: ForkReferenceScratchAllocate;
  private readonly deallocateScratch: ForkReferenceScratchDeallocate;

  constructor(options: ForkEarlyChildReferenceProviderOptions) {
    this.label = options.label ?? "early child references";
    this.externrefs = options.externrefs;
    this.transit = options.transit;
    this.memory = options.memory;
    this.allocateScratch = options.allocateScratch;
    this.deallocateScratch = options.deallocateScratch;
    this.transaction = options.transaction;
    this.nodes = options.transaction.graph.nodes;
    // WHY: keep the exact decoded KFRV vector directory as the immutable base.
    // Early codec vectors append to a small overlay instead of copying every
    // transaction vector into a second page tree.
    this.referenceVectors.reset(options.transaction.vectors);

    const moduleIds = new Set<number>();
    for (const record of options.records) {
      if (record.kind !== ForkModuleStateRecordKind.Module) continue;
      assertU32(record.activationId, "fork module activation");
      if (moduleIds.has(record.activationId)) {
        throw new Error(
          `${this.label}: duplicate module activation ${record.activationId}`,
        );
      }
      moduleIds.add(record.activationId);
    }
    if (moduleIds.size === 0) {
      throw new Error(`${this.label}: reference graph has no module activations`);
    }

    for (const declaration of options.declarations) {
      const activationId = assertU32(
        declaration.activationId,
        "early reference activation",
      );
      if (!moduleIds.has(activationId)) {
        throw new Error(
          `${this.label}: declaration names unknown activation ${activationId}`,
        );
      }
      if (this.declarations.has(activationId)) {
        throw new Error(
          `${this.label}: activation ${activationId} was declared twice`,
        );
      }
      this.declarations.set(activationId, declaration);
    }
    for (const activationId of moduleIds) {
      if (!this.declarations.has(activationId)) {
        throw new Error(
          `${this.label}: module activation ${activationId} has no declaration`,
        );
      }
    }

    this.i31Owner = [...this.declarations.values()]
      .filter(({ gcDescriptor }) => gcDescriptor !== undefined)
      .map(({ activationId }) => activationId)
      .sort((left, right) => left - right)[0] ?? null;
    this.hostExceptionOwner = [...this.declarations.values()]
      .filter(({ exceptionDescriptor }) => exceptionDescriptor !== undefined)
      .map(({ activationId }) => activationId)
      .sort((left, right) => left - right)[0] ?? null;

    for (const binding of importedGlobalBindingsForChild(options.records)) {
      if (
        binding.kind === ForkImportedGlobalBindingKind.RawReference
        && binding.typeCode === WPK_FORK_MODULE_STATE_GLOBAL_TYPE_EXNREF
        && binding.recipeId !== 0
      ) {
        // WHY: JavaScript cannot read a non-null exnref out of a Global or
        // carry one as a raw import value. Parent capture therefore represents
        // every real non-null exnref import as ActivationGlobal/BaseImport; a
        // nonzero raw recipe can only be a malformed provenance manifest.
        throw new Error(
          `${this.label}: imported exnref ${binding.consumerActivation}:`
          + `${binding.consumerOwner} has a non-null raw recipe instead of `
          + "an activation-owned Global carrier",
        );
      }
    }

    for (const entry of this.nodes) {
      this.validateRecipeOwnership(entry, moduleIds);
      if (entry.node.kind === "exnref") {
        this.exceptionCacheIndexes.set(
          entry.id,
          this.exceptionCacheIndexes.size + 1,
        );
      }
    }
  }

  registerActivation(providers: ForkEarlyReferenceActivationProviders): void {
    this.requireActive("register an activation");
    const activationId = assertU32(
      providers.activationId,
      "early reference activation",
    );
    const declaration = this.declarations.get(activationId);
    if (!declaration) {
      throw new Error(
        `${this.label}: activation ${activationId} was not declared`,
      );
    }
    if (this.registrations.has(activationId)) {
      throw new Error(
        `${this.label}: activation ${activationId} was registered twice`,
      );
    }

    let ownsFuncref = false;
    let ownsStaticRoot = false;
    let ownsTyped = false;
    let ownsException = false;
    for (const { node } of this.nodes) {
      if (this.directOwner(node) !== activationId) continue;
      ownsFuncref ||= node.kind === "funcref";
      ownsStaticRoot ||= node.kind === "static-root";
      ownsTyped ||= (
        node.kind === "struct" || node.kind === "array" || node.kind === "i31"
      );
      ownsException ||= node.kind === "exnref";
    }
    if (ownsFuncref && !providers.functions) {
      throw new Error(
        `${this.label}: activation ${activationId} has no function provider`,
      );
    }
    if (
      ownsStaticRoot && !providers.staticRoots
    ) {
      throw new Error(
        `${this.label}: activation ${activationId} has no static-root provider`,
      );
    }
    if (
      (
        ownsTyped
        || this.i31Owner === activationId
      )
    ) {
      if (
        !providers.typed
        || providers.typed.activationId !== activationId
        || !declaration.gcDescriptor
        || !sameGcDescriptor(
          providers.typed.descriptor,
          declaration.gcDescriptor,
        )
      ) {
        throw new Error(
          `${this.label}: activation ${activationId} has no matching GC provider`,
        );
      }
    }
    if (
      (
        ownsException
        || this.hostExceptionOwner === activationId
      )
      && typeof providers.exceptions?.materialize !== "function"
    ) {
      throw new Error(
        `${this.label}: activation ${activationId} has no exception materializer`,
      );
    }

    this.registrations.set(activationId, { ...providers });
  }

  ownerActivation(recipeId: number, typeCode: number): number | null {
    this.requireActive("plan a reference owner");
    const entry = this.requireCompatibleRecipe(recipeId, typeCode);
    return this.directOwner(entry.node);
  }

  /**
   * Every activation needed to reconstruct the complete reachable identity.
   *
   * `ForkImportedReferenceProvider.ownerActivation` predates typed graphs and
   * can name only the direct owner. Loaders should add this full set to their
   * topological dependency graph before resolving a raw reference import.
   */
  activationDependencies(recipeId: number, typeCode: number): number[] {
    this.requireActive("plan reference dependencies");
    const entry = this.requireCompatibleRecipe(recipeId, typeCode);
    const dependencies = new Set<number>();
    const visited = new Set<number>();
    const visit = (id: number): void => {
      if (visited.has(id)) return;
      visited.add(id);
      const node = this.nodes.get(id)!.node;
      const owner = this.directOwner(node);
      if (owner !== null) dependencies.add(owner);
      nodeEdges(node).forEach(visit);
    };
    visit(entry.id);
    return [...dependencies].sort((left, right) => left - right);
  }

  materialize(recipeId: number, typeCode: number): unknown {
    this.requireActive("materialize an imported reference");
    const entry = this.requireCompatibleRecipe(recipeId, typeCode);
    if (
      entry.node.kind === "exnref"
      && entry.id !== 0
    ) {
      throw new Error(
        `${this.label}: non-null exnref recipe ${entry.id} cannot cross `
        + "JavaScript; import its activation-owned WebAssembly.Global instead",
      );
    }
    this.requireRegisteredDependencies(entry.id, typeCode);
    try {
      const value = this.materializeRecipe(entry.id);
      this.validateMaterializedValue(entry.id, typeCode, value);
      return value;
    } catch (error) {
      // A provider that returned a malformed value may already have retained
      // it in a catalog or transit slot. Poison the one-shot owner and release
      // all early roots instead of permitting a retry over ambiguous state.
      this.abortAfterFailure(error);
    }
  }

  decodeFuncref(recipeId: number): CallableFunction | null {
    const value = this.materialize(
      recipeId,
      WPK_FORK_MODULE_STATE_GLOBAL_TYPE_FUNCREF,
    );
    if (value !== null && typeof value !== "function") {
      throw new TypeError(
        `${this.label}: recipe ${recipeId} did not reconstruct a funcref`,
      );
    }
    return value as CallableFunction | null;
  }

  decodeExternref(recipeId: number): unknown {
    return this.materialize(
      recipeId,
      WPK_FORK_MODULE_STATE_GLOBAL_TYPE_EXTERNREF,
    );
  }

  getReferenceVector(ordinal: number, index: number): number {
    this.requireActive("read a reference vector");
    if (
      !Number.isInteger(ordinal)
      || ordinal < 0
      || ordinal > 0xffff_ffff
    ) {
      throw new RangeError(
        `${this.label}: reference vector ordinal is not a u32`,
      );
    }
    assertU32(index, "reference vector index");
    const vector = this.referenceVectors.get(ordinal);
    if (!vector) {
      throw new Error(
        `${this.label}: reference vector ${ordinal} is not available`,
      );
    }
    const recipeId = vector.get(index);
    if (recipeId === undefined) {
      throw new Error(
        `${this.label}: reference vector ${ordinal} index ${index} `
        + "is out of bounds",
      );
    }
    return recipeId;
  }

  routeGc(recipeId: number, expectedActivation: number): number {
    this.requireActive("route a GC recipe");
    const entry = this.requireRecipe(recipeId);
    assertU32(expectedActivation, "GC route activation");
    if (entry.node.kind === "i31") return 0;
    if (
      (entry.node.kind !== "struct" && entry.node.kind !== "array")
      || entry.node.moduleActivation !== expectedActivation
    ) {
      return -1;
    }
    return entry.node.layoutId ?? 0;
  }

  gcPayloadLength(
    recipeId: number,
    expectedActivation: number,
    expectedLayoutId: number,
  ): number {
    this.requireActive("read a GC payload length");
    const entry = this.requireRecipe(recipeId);
    assertU32(expectedActivation, "GC payload activation");
    assertU32(expectedLayoutId, "GC payload layout");
    if (entry.node.kind === "i31") {
      if (expectedLayoutId !== 0) {
        throw new Error(
          `${this.label}: i31 recipe ${recipeId} has a nonzero layout`,
        );
      }
      return 4;
    }
    if (
      (entry.node.kind !== "struct" && entry.node.kind !== "array")
      || entry.node.moduleActivation !== expectedActivation
      || (entry.node.layoutId ?? 0) !== expectedLayoutId
    ) {
      throw new Error(
        `${this.label}: GC recipe ${recipeId} does not match payload route `
        + `${expectedActivation}:${expectedLayoutId}`,
      );
    }
    return (entry.node.scalars ?? new Uint8Array()).byteLength;
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
    this.requireActive("load a GC recipe");
    const entry = this.requireRecipe(recipeId);
    assertU32(moduleActivation, "GC load activation");
    assertU32(typeOrdinal, "GC load type ordinal");
    assertU32(layoutId, "GC load layout");
    assertU32(kind, "GC load kind");
    assertU32(scalarByteLength, "GC scalar byte length");
    if (entry.node.kind === "i31") {
      if (
        layoutId !== 0
        || typeOrdinal !== 0xffff_ffff
        || kind !== 0
        || scalarByteLength !== 4
      ) {
        throw new Error(
          `${this.label}: i31 recipe ${recipeId} has an invalid load coordinate`,
        );
      }
      const bytes = new Uint8Array(4);
      new DataView(bytes.buffer).setInt32(0, entry.node.value, true);
      this.writeBytes(
        scalarDestination,
        bytes,
        "early GC i31 destination",
      );
      return 0;
    }
    if (entry.node.kind !== "struct" && entry.node.kind !== "array") {
      throw new Error(
        `${this.label}: recipe ${recipeId} is not a GC aggregate`,
      );
    }
    const nodeKind = entry.node.kind === "struct" ? 1 : 2;
    const scalars = entry.node.scalars ?? new Uint8Array();
    if (
      entry.node.moduleActivation !== moduleActivation
      || entry.node.typeOrdinal !== typeOrdinal
      || (entry.node.layoutId ?? 0) !== layoutId
      || nodeKind !== kind
      || scalars.byteLength !== scalarByteLength
    ) {
      throw new Error(
        `${this.label}: GC recipe ${recipeId} payload does not match `
        + "the generated codec",
      );
    }
    this.writeBytes(
      scalarDestination,
      scalars,
      "early GC scalar destination",
    );
    const edges =
      entry.node.kind === "struct" ? entry.node.fields : entry.node.elements;
    if (edges.length === 0) return 0;
    const known = this.replayGcVectors.get(recipeId);
    if (known !== undefined) return known;
    const existing = findForkReferenceVectorOrdinal(
      [
        this.transaction!.vectorIntern,
        this.referenceVectorIntern,
      ],
      this.referenceVectors,
      forkReferenceVectorFrom(edges, edges.length),
    );
    if (existing !== undefined) {
      this.replayGcVectors.set(recipeId, existing);
      return existing;
    }
    const ordinal = this.referenceVectors.length;
    if (ordinal > MAX_REFERENCE_VECTOR_ORDINAL) {
      throw new RangeError(
        `${this.label}: reference vector ordinal space exhausted`,
      );
    }
    const canonical = forkReferenceVectorFrom(edges, edges.length);
    this.referenceVectors.push(canonical);
    indexForkReferenceVector(this.referenceVectorIntern, canonical, ordinal);
    this.replayGcVectors.set(recipeId, ordinal);
    return ordinal;
  }

  routeException(recipeId: number, expectedActivation: number): number {
    this.requireActive("route an exception recipe");
    const entry = this.requireRecipe(recipeId);
    assertU32(expectedActivation, "exception route activation");
    if (
      entry.node.kind !== "exnref"
      || entry.node.moduleActivation !== expectedActivation
    ) {
      return -1;
    }
    return entry.node.layoutId ?? 0;
  }

  exceptionOwner(recipeId: number): number {
    this.requireActive("read an exception owner");
    const entry = this.requireRecipe(recipeId);
    if (entry.node.kind !== "exnref") {
      throw new Error(
        `${this.label}: recipe ${recipeId} is not an exception`,
      );
    }
    // WHY: retain the process-graph owner here instead of the activation used
    // to instantiate a host-exception codec. ForkExceptionBroker needs the
    // sentinel to distinguish a host/JSTag value from an activation tag.
    return entry.node.moduleActivation;
  }

  materializeHostException(recipeId: number): unknown {
    const owner = this.exceptionOwner(recipeId);
    if (owner !== FORK_HOST_EXCEPTION_ACTIVATION_ID) {
      throw new Error(
        `${this.label}: exception recipe ${recipeId} is not host-owned`,
      );
    }
    const entry = this.requireRecipe(recipeId);
    if (
      entry.node.kind !== "exnref"
      || entry.node.payloads.length !== 1
      || this.nodes.get(entry.node.payloads[0]!)?.node.kind !== "externref"
    ) {
      throw new Error(
        `${this.label}: host exception recipe ${recipeId} is malformed`,
      );
    }
    // The payload is an opaque process-owned handle; decodeExternref provides
    // the same canonical child token to every early broker invocation.
    return this.decodeExternref(entry.node.payloads[0]!);
  }

  exceptionCacheIndex(recipeId: number): number {
    this.requireActive("read an exception cache index");
    this.requireRecipe(recipeId);
    const index = this.exceptionCacheIndexes.get(recipeId);
    if (index === undefined) {
      throw new Error(
        `${this.label}: recipe ${recipeId} has no exception cache index`,
      );
    }
    return index;
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
    this.requireActive("load an exception recipe");
    const entry = this.requireRecipe(recipeId);
    assertU32(moduleActivation, "exception load activation");
    assertU32(tagOrdinal, "exception load tag ordinal");
    assertU32(layoutId, "exception load layout");
    assertU32(scalarByteLength, "exception scalar byte length");
    assertU32(referenceCount, "exception reference count");
    if (entry.node.kind !== "exnref") {
      throw new Error(
        `${this.label}: recipe ${recipeId} is not an exception`,
      );
    }
    const scalars = entry.node.scalars ?? new Uint8Array();
    if (
      entry.node.moduleActivation !== moduleActivation
      || entry.node.tagOrdinal !== tagOrdinal
      || (entry.node.layoutId ?? 0) !== layoutId
      || scalars.byteLength !== scalarByteLength
      || entry.node.payloads.length !== referenceCount
    ) {
      throw new Error(
        `${this.label}: exception recipe ${recipeId} payload does not match `
        + "the generated codec",
      );
    }
    this.writeBytes(
      scalarDestination,
      scalars,
      "early exception scalar destination",
    );
    this.writeRecipeIds(
      referenceIdsDestination,
      entry.node.payloads,
      "early exception reference destination",
    );
    return 1;
  }

  reserveScratch(size: number | bigint): number {
    this.requireActive("reserve reference scratch");
    const requestedSize = this.checkedScratchSize(size);
    const alignedSize = this.alignScratch(requestedSize);
    let chunk = this.scratchChunks[this.scratchChunks.length - 1];
    if (!chunk || alignedSize > chunk.size - chunk.used) {
      const chunkSize = this.alignScratch(Math.max(65_536, alignedSize), 65_536);
      const addr = this.allocateScratch(chunkSize);
      if (
        !Number.isSafeInteger(addr)
        || addr <= 0
        || addr % 16 !== 0
        || addr > this.memory.buffer.byteLength - chunkSize
      ) {
        if (Number.isSafeInteger(addr) && addr > 0) {
          try {
            this.deallocateScratch(addr, chunkSize);
          } catch {
            // Preserve the allocator contract violation.
          }
        }
        throw new RangeError(
          `${this.label}: scratch allocator returned an invalid mapping`,
        );
      }
      chunk = { addr, size: chunkSize, used: 0 };
      this.scratchChunks.push(chunk);
    }
    const previousUsed = chunk.used;
    const addr = chunk.addr + previousUsed;
    chunk.used += alignedSize;
    new Uint8Array(this.memory.buffer, addr, alignedSize).fill(0);
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
    this.requireActive("release reference scratch");
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
        `${this.label}: scratch release is not the most recent reservation`,
      );
    }
    new Uint8Array(
      this.memory.buffer,
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
      this.deallocateScratch(tail.addr, tail.size);
    }
  }

  /**
   * Adapter target for encode/claim/define imports while the child is still
   * constructing activations. Those callbacks are capture-only by contract.
   */
  captureUnavailable(operation: string): never {
    this.requireActive(`run capture callback ${operation}`);
    throw new Error(
      `${this.label}: capture callback ${operation} is unavailable during `
      + "pre-instantiation child replay",
    );
  }

  adoptInto(transaction: ForkReferenceReplayAdoptionTarget): void {
    this.requireActive("adopt reference replay");
    if (this.scratchReservations.length !== 0) {
      throw new Error(
        `${this.label}: cannot adopt with `
        + `${this.scratchReservations.length} live scratch reservation(s)`,
      );
    }
    this.releaseScratchChunks();
    const adoption: ForkReferenceChildReplayAdoption = {
      transaction: this.transaction!,
      materializedValues: this.materializedValues,
      allocatedTypedRecipes: this.allocatedTypedRecipes,
      filledTypedRecipes: this.filledTypedRecipes,
      materializedExceptionRecipes: this.materializedExceptionRecipes,
    };
    transaction.adoptChildReplay(adoption);
    // WHY: the transaction copied every sparse value and milestone. Clear only
    // this owner's JS collections; the registry now owns codec/transit cleanup.
    this.releaseCollections();
    this.phase = "adopted";
  }

  abort(): void {
    if (this.phase === "aborted") return;
    if (this.phase === "adopted") {
      throw new Error(`${this.label}: adopted reference replay cannot be aborted`);
    }
    const callbacks = [...this.registrations.values()]
      .sort((left, right) => right.activationId - left.activationId)
      .flatMap(({ abort }) => abort ? [abort] : []);
    this.releaseCollections();
    this.phase = "aborted";

    const failures: unknown[] = [];
    try {
      if (this.scratchReservations.length !== 0) {
        // A trapping codec can bypass its generated release. All reservations
        // still belong to this one-shot owner, so zero and release the complete
        // retained chunk set during abort.
        this.scratchReservations.length = 0;
      }
      this.releaseScratchChunks();
    } catch (error) {
      failures.push(error);
    }
    for (const callback of callbacks) {
      try {
        callback();
      } catch (error) {
        failures.push(error);
      }
    }
    try {
      this.transit.abort();
    } catch (error) {
      failures.push(error);
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      throw new AggregateError(
        failures,
        `${this.label}: early reference cleanup was incomplete`,
      );
    }
  }

  private validateRecipeOwnership(
    entry: ForkReferenceRecipeEntry,
    moduleIds: ReadonlySet<number>,
  ): void {
    const node = entry.node;
    const requireModule = (activationId: number, kind: string): void => {
      if (!moduleIds.has(activationId)) {
        throw new Error(
          `${this.label}: ${kind} recipe ${entry.id} names missing `
          + `activation ${activationId}`,
        );
      }
    };
    switch (node.kind) {
      case "funcref":
        requireModule(node.moduleActivation, "funcref");
        break;
      case "static-root":
        requireModule(node.moduleActivation, "static-root");
        break;
      case "struct":
      case "array": {
        requireModule(node.moduleActivation, node.kind);
        const descriptor =
          this.declarations.get(node.moduleActivation)?.gcDescriptor;
        if (!descriptor) {
          throw new Error(
            `${this.label}: ${node.kind} recipe ${entry.id} owner `
            + `${node.moduleActivation} has no GC descriptor`,
          );
        }
        this.gcLayouts.set(entry.id, validateGcRecipe(entry, descriptor));
        break;
      }
      case "exnref": {
        if (node.moduleActivation === FORK_HOST_EXCEPTION_ACTIVATION_ID) {
          if (
            this.hostExceptionOwner === null
            || node.tagOrdinal !== 0
            || (node.layoutId ?? 0) !== 0
            || (node.scalars?.byteLength ?? 0) !== 0
            || node.payloads.length !== 1
            || this.nodes.get(node.payloads[0]!)?.node.kind !== "externref"
          ) {
            throw new Error(
              `${this.label}: host exception recipe ${entry.id} is malformed `
              + "or has no fresh-child codec",
            );
          }
          break;
        }
        requireModule(node.moduleActivation, "exnref");
        const descriptor =
          this.declarations.get(node.moduleActivation)?.exceptionDescriptor;
        const layout = descriptor?.tags[node.tagOrdinal];
        if (
          !layout
          || layout.tagOrdinal !== node.tagOrdinal
          || layout.layoutId !== (node.layoutId ?? 0)
          || layout.scalarByteLength !== (node.scalars?.byteLength ?? 0)
          || layout.referenceCount !== node.payloads.length
        ) {
          throw new Error(
            `${this.label}: exnref recipe ${entry.id} does not match `
            + `activation ${node.moduleActivation}'s exception descriptor`,
          );
        }
        break;
      }
      case "i31":
        if (this.i31Owner === null) {
          throw new Error(
            `${this.label}: i31 recipe ${entry.id} has no fresh-child GC codec`,
          );
        }
        break;
      case "null":
      case "externref":
        break;
    }
  }

  private directOwner(node: ForkReferenceRecipeNode): number | null {
    switch (node.kind) {
      case "funcref":
      case "struct":
      case "array":
      case "static-root":
        return node.moduleActivation;
      case "exnref":
        return node.moduleActivation === FORK_HOST_EXCEPTION_ACTIVATION_ID
          ? this.hostExceptionOwner
          : node.moduleActivation;
      case "i31":
        return this.i31Owner;
      case "null":
      case "externref":
        return null;
    }
  }

  private requireCompatibleRecipe(
    recipeId: number,
    typeCode: number,
  ): ForkReferenceRecipeEntry {
    const id = assertRecipeId(recipeId, this.nodes.length);
    const code = requireReferenceTypeCode(typeCode);
    const entry = this.nodes.get(id)!;
    const kind = entry.node.kind;
    const compatible = kind === "null" || (
      code === WPK_FORK_MODULE_STATE_GLOBAL_TYPE_FUNCREF
        ? kind === "funcref" || kind === "static-root"
        : code === WPK_FORK_MODULE_STATE_GLOBAL_TYPE_EXTERNREF
          ? (
            kind === "funcref"
            || kind === "externref"
            || kind === "static-root"
          )
          : code === WPK_FORK_MODULE_STATE_GLOBAL_TYPE_EXNREF
            ? kind === "exnref"
            : (
              kind === "i31"
              || kind === "struct"
              || kind === "array"
              || kind === "static-root"
            )
    );
    if (!compatible) {
      throw new Error(
        `${this.label}: ${kind} recipe ${id} cannot initialize `
        + `reference type code ${code}`,
      );
    }
    return entry;
  }

  private requireRecipe(recipeId: number): ForkReferenceRecipeEntry {
    return this.nodes.get(assertRecipeId(recipeId, this.nodes.length))!;
  }

  private requireRegisteredDependencies(
    recipeId: number,
    typeCode: number,
  ): void {
    for (const activationId of this.activationDependencies(recipeId, typeCode)) {
      if (!this.registrations.has(activationId)) {
        throw new Error(
          `${this.label}: recipe ${recipeId} needs unregistered activation `
          + `${activationId}`,
        );
      }
    }
  }

  private materializeRecipe(recipeId: number): unknown {
    if (this.materializedValues.has(recipeId)) {
      return this.materializedValues.get(recipeId);
    }
    const entry = this.nodes.get(recipeId)!;
    const node = entry.node;
    let value: unknown;
    switch (node.kind) {
      case "null":
        value = null;
        break;
      case "funcref": {
        value = this.requireRegistration(node.moduleActivation).functions!
          .decode(node.functionOrdinal);
        if (typeof value !== "function") {
          throw new TypeError(
            `${this.label}: funcref recipe ${recipeId} did not produce a function`,
          );
        }
        break;
      }
      case "externref":
        value = this.externrefs.materialize(node.handle);
        break;
      case "static-root":
        this.prepareTransit();
        value = this.requireRegistration(node.moduleActivation).staticRoots!
          .decode(node.staticRootOrdinal);
        // Static-root catalogs contain only GC-domain references accepted by
        // the instrumenter's `(ref null any)` harvest table. Unlike dynamic
        // recipes, no generated allocator exists to publish this identity.
        this.transit.publish(recipeId, value);
        break;
      case "i31":
      case "struct":
      case "array":
        this.materializeTypedGraph(recipeId);
        return this.materializedValues.get(recipeId);
      case "exnref":
        this.materializeException(recipeId, new Set());
        return undefined;
    }
    this.materializedValues.set(recipeId, value);
    return value;
  }

  private materializeTypedGraph(rootRecipeId: number): void {
    this.prepareTransit();
    const reachable = this.reachableRecipes(rootRecipeId);
    for (const entry of this.nodes) {
      if (!reachable.has(entry.id) || entry.node.kind !== "externref") continue;
      this.publishExternref(entry.id);
    }
    for (const entry of this.nodes) {
      if (!reachable.has(entry.id)) continue;
      if (entry.node.kind === "static-root") {
        // WHY: immutable constructors can consume static roots while
        // allocating, before the later identity walk. Publish every reachable
        // instantiation-owned root first so both constructor dependencies and
        // mutable field fills observe the activation's canonical identity.
        this.materializeRecipe(entry.id);
      }
    }
    for (const entry of this.nodes) {
      if (!reachable.has(entry.id)) continue;
      const { node } = entry;
      if (node.kind !== "struct" && node.kind !== "array") continue;
      const layout = this.gcLayouts.get(entry.id)!;
      if (
        (layout.flags & FORK_GC_LAYOUT_DEFAULTABLE_SHELL) !== 0
        && !this.allocatedTypedRecipes.has(entry.id)
      ) {
        this.allocateTyped(entry.id, new Set(), true);
      }
    }

    const visiting = new Set<number>();
    for (const entry of this.nodes) {
      if (reachable.has(entry.id)) this.ensureIdentity(entry.id, visiting);
    }
    for (const entry of this.nodes) {
      if (!reachable.has(entry.id)) continue;
      const { node } = entry;
      if (
        (node.kind !== "struct" && node.kind !== "array")
        || this.filledTypedRecipes.has(entry.id)
      ) {
        continue;
      }
      nodeEdges(node).forEach((edge) => this.ensureIdentity(edge, visiting));
      this.requireRegistration(node.moduleActivation).typed!.fill(entry.id);
      this.filledTypedRecipes.add(entry.id);
    }
  }

  private ensureIdentity(recipeId: number, visiting: Set<number>): void {
    const node = this.nodes.get(recipeId)!.node;
    switch (node.kind) {
      case "null":
      case "funcref":
      case "static-root":
        this.materializeRecipe(recipeId);
        return;
      case "externref":
        this.publishExternref(recipeId);
        return;
      case "exnref":
        this.materializeException(recipeId, visiting);
        return;
      case "i31":
      case "struct":
      case "array":
        this.allocateTyped(recipeId, visiting);
        return;
    }
  }

  private prepareTransit(): void {
    if (this.transitPrepared) return;
    this.transit.prepare(Math.max(0, this.nodes.length - 1));
    this.transitPrepared = true;
  }

  private publishExternref(recipeId: number): void {
    if (this.publishedExternrefRecipes.has(recipeId)) return;
    const entry = this.nodes.get(recipeId);
    if (entry?.node.kind !== "externref") {
      throw new Error(`${this.label}: recipe ${recipeId} is not an externref`);
    }
    const value = this.materializeRecipe(recipeId);
    const publisher = [...this.registrations.values()]
      .filter((registration) => registration.typed !== undefined)
      .sort((left, right) => left.activationId - right.activationId)[0]?.typed;
    if (!publisher) {
      throw new Error(
        `${this.label}: externref recipe ${recipeId} has no generated GC codec`,
      );
    }
    // WHY: the transit table stores anyref. Only generated Wasm can perform
    // the required any.convert_extern for this Worker's canonical token.
    publisher.publishExternref(recipeId, value);
    if (!Object.is(this.transit.read(recipeId), value)) {
      throw new Error(
        `${this.label}: externref recipe ${recipeId} lost token identity `
        + "during anyref publication",
      );
    }
    this.publishedExternrefRecipes.add(recipeId);
  }

  private allocateTyped(
    recipeId: number,
    visiting: Set<number>,
    defaultableShell = false,
  ): void {
    if (this.allocatedTypedRecipes.has(recipeId)) return;
    if (visiting.has(recipeId)) {
      throw new Error(
        `${this.label}: typed replay has an unallocatable constructor cycle `
        + `at recipe ${recipeId}`,
      );
    }
    const node = this.nodes.get(recipeId)!.node;
    if (node.kind !== "i31" && node.kind !== "struct" && node.kind !== "array") {
      throw new Error(`${this.label}: recipe ${recipeId} is not a typed reference`);
    }
    visiting.add(recipeId);
    try {
      let activationId: number;
      if (node.kind === "i31") {
        activationId = this.i31Owner!;
      } else {
        activationId = node.moduleActivation;
        if (!defaultableShell) {
          const layout = this.gcLayouts.get(recipeId)!;
          gcAllocationDependencies(node, layout)
            .forEach((dependency) => this.ensureIdentity(dependency, visiting));
        }
      }
      this.requireRegistration(activationId).typed!.allocate(recipeId);
      const value = this.transit.read(recipeId);
      if (value === null || value === undefined) {
        throw new Error(
          `${this.label}: typed provider did not publish recipe ${recipeId}`,
        );
      }
      this.materializedValues.set(recipeId, value);
      this.allocatedTypedRecipes.add(recipeId);
    } finally {
      visiting.delete(recipeId);
    }
  }

  private materializeException(
    recipeId: number,
    visiting: Set<number>,
  ): void {
    if (this.materializedExceptionRecipes.has(recipeId)) return;
    if (visiting.has(recipeId)) {
      throw new Error(
        `${this.label}: exception replay has an unallocatable cycle at `
        + `recipe ${recipeId}`,
      );
    }
    const node = this.nodes.get(recipeId)!.node;
    if (node.kind !== "exnref") {
      throw new Error(`${this.label}: recipe ${recipeId} is not an exception`);
    }
    visiting.add(recipeId);
    try {
      node.payloads.forEach((payload) => this.ensureIdentity(payload, visiting));
      const owner = this.directOwner(node)!;
      this.requireRegistration(owner).exceptions!.materialize!(recipeId);
      this.materializedExceptionRecipes.add(recipeId);
    } finally {
      visiting.delete(recipeId);
    }
  }

  private reachableRecipes(rootRecipeId: number): ReadonlySet<number> {
    const visited = new Set<number>();
    const visit = (recipeId: number): void => {
      if (visited.has(recipeId)) return;
      visited.add(recipeId);
      nodeEdges(this.nodes.get(recipeId)!.node).forEach(visit);
    };
    visit(rootRecipeId);
    return visited;
  }

  private validateMaterializedValue(
    recipeId: number,
    typeCode: number,
    value: unknown,
  ): void {
    if (
      typeCode === WPK_FORK_MODULE_STATE_GLOBAL_TYPE_FUNCREF
      && value !== null
      && typeof value !== "function"
    ) {
      throw new TypeError(
        `${this.label}: recipe ${recipeId} did not materialize a funcref`,
      );
    }
    if (
      typeCode === WPK_FORK_MODULE_STATE_GLOBAL_TYPE_EXNREF
      && value !== null
    ) {
      throw new TypeError(
        `${this.label}: recipe ${recipeId} did not materialize a nullable exnref`,
      );
    }
  }

  private writeBytes(
    pointer: number | bigint,
    bytes: Uint8Array,
    context: string,
  ): void {
    const { offset } = this.memoryRange(pointer, bytes.byteLength, context);
    new Uint8Array(this.memory.buffer, offset, bytes.byteLength).set(bytes);
  }

  private writeRecipeIds(
    pointer: number | bigint,
    ids: readonly number[],
    context: string,
  ): void {
    const { offset } = this.memoryRange(pointer, ids.length * 4, context);
    const view = new DataView(this.memory.buffer);
    ids.forEach((id, index) => {
      assertRecipeId(id, this.nodes.length);
      view.setUint32(offset + index * 4, id, true);
    });
  }

  private memoryRange(
    pointer: number | bigint,
    byteLength: number,
    context: string,
  ): { readonly offset: number; readonly length: number } {
    assertU32(byteLength, `${context} byte length`);
    const offset = typeof pointer === "bigint" ? Number(pointer) : pointer;
    if (
      !Number.isSafeInteger(offset)
      || offset < 0
      || (typeof pointer === "bigint" && BigInt(offset) !== pointer)
    ) {
      throw new RangeError(`${this.label}: ${context} has an invalid guest pointer`);
    }
    const memoryLength = this.memory.buffer.byteLength;
    if (offset > memoryLength || byteLength > memoryLength - offset) {
      throw new RangeError(`${this.label}: ${context} exceeds WebAssembly memory`);
    }
    return { offset, length: byteLength };
  }

  private checkedScratchPointer(value: number | bigint): number {
    const result = typeof value === "bigint" ? Number(value) : value;
    if (
      !Number.isSafeInteger(result)
      || result <= 0
      || (typeof value === "bigint" && BigInt(result) !== value)
    ) {
      throw new RangeError(`${this.label}: scratch pointer is invalid`);
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
      throw new RangeError(`${this.label}: scratch size is not a nonzero u32`);
    }
    return result;
  }

  private alignScratch(value: number, alignment = 16): number {
    const result = Math.ceil(value / alignment) * alignment;
    if (!Number.isSafeInteger(result) || result < value) {
      throw new RangeError(`${this.label}: scratch alignment overflow`);
    }
    return result;
  }

  private releaseScratchChunks(): void {
    if (this.scratchReservations.length !== 0) {
      throw new Error(
        `${this.label}: cannot release scratch with live reservations`,
      );
    }
    const chunks = this.scratchChunks.splice(0).reverse();
    const failures: unknown[] = [];
    for (const chunk of chunks) {
      try {
        new Uint8Array(this.memory.buffer, chunk.addr, chunk.size).fill(0);
        this.deallocateScratch(chunk.addr, chunk.size);
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      throw new AggregateError(
        failures,
        `${this.label}: scratch cleanup was incomplete`,
      );
    }
  }

  private requireRegistration(activationId: number): RegisteredActivation {
    const registration = this.registrations.get(activationId);
    if (!registration) {
      throw new Error(
        `${this.label}: activation ${activationId} is not registered`,
      );
    }
    return registration;
  }

  private abortAfterFailure(cause: unknown): never {
    try {
      this.abort();
    } catch (cleanupError) {
      throw new AggregateError(
        [cause, cleanupError],
        `${this.label}: reference materialization and cleanup both failed`,
      );
    }
    throw cause;
  }

  private releaseCollections(): void {
    this.materializedValues.clear();
    this.publishedExternrefRecipes.clear();
    this.allocatedTypedRecipes.clear();
    this.filledTypedRecipes.clear();
    this.materializedExceptionRecipes.clear();
    this.exceptionCacheIndexes.clear();
    this.gcLayouts.clear();
    this.replayGcVectors.clear();
    this.referenceVectorIntern.clear();
    this.registrations.clear();
    this.declarations.clear();
    this.nodes = new PagedForkReferenceDirectory();
    this.referenceVectors.clear();
    this.transaction = null;
  }

  private requireActive(operation: string): void {
    if (this.phase !== "active") {
      throw new Error(
        `${this.label}: cannot ${operation} after provider was ${this.phase}`,
      );
    }
  }
}
