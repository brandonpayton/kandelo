import {
  type ForkActivationExceptionProvider,
  ForkActivationRegistry,
} from "./fork-activation-registry";
import type { ForkExceptionSlotProvider } from "./fork-reference-contracts";
import { FORK_HOST_EXCEPTION_ACTIVATION_ID } from "./fork-reference-wire";
import {
  WPK_FORK_EXCEPTION_CODEC_HEADER_SIZE,
  WPK_FORK_EXCEPTION_CODEC_SECTION,
  WPK_FORK_EXCEPTION_CODEC_TAG_RECORD_SIZE,
  WPK_FORK_EXCEPTION_CODEC_VERSION,
  WPK_FORK_EXCEPTION_EXPORT_ABORT,
  WPK_FORK_EXCEPTION_EXPORT_CLEAR,
  WPK_FORK_EXCEPTION_EXPORT_DECODE,
  WPK_FORK_EXCEPTION_EXPORT_ENCODE,
  WPK_FORK_EXCEPTION_EXPORT_ENCODE_INGRESS,
  WPK_FORK_EXCEPTION_EXPORT_MATERIALIZE,
  WPK_FORK_EXCEPTION_EXPORT_THROW_RECIPE,
  WPK_FORK_EXCEPTION_EXPORT_THROW_SLOT,
  WPK_FORK_EXCEPTION_IMPORT_ACTIVATION,
  WPK_FORK_EXCEPTION_IMPORT_BROKER_ENCODE,
  WPK_FORK_EXCEPTION_IMPORT_BROKER_THROW_RECIPE,
  WPK_FORK_EXCEPTION_IMPORT_CACHE_INDEX,
  WPK_FORK_EXCEPTION_IMPORT_CLAIM,
  WPK_FORK_EXCEPTION_IMPORT_DEFINE,
  WPK_FORK_EXCEPTION_IMPORT_INGRESS_THROW,
  WPK_FORK_EXCEPTION_IMPORT_LOAD,
  WPK_FORK_EXCEPTION_IMPORT_LOOKUP,
  WPK_FORK_EXCEPTION_IMPORT_ROUTE,
  WPK_FORK_REFERENCE_IMPORT_SCRATCH_RELEASE,
  WPK_FORK_REFERENCE_IMPORT_SCRATCH_RESERVE,
} from "./generated/abi";

export const FORK_EXCEPTION_CODEC_SECTION =
  WPK_FORK_EXCEPTION_CODEC_SECTION;
export const FORK_EXCEPTION_CODEC_VERSION = WPK_FORK_EXCEPTION_CODEC_VERSION;
export const FORK_EXCEPTION_CODEC_HEADER_SIZE =
  WPK_FORK_EXCEPTION_CODEC_HEADER_SIZE;
export const FORK_EXCEPTION_CODEC_TAG_RECORD_SIZE =
  WPK_FORK_EXCEPTION_CODEC_TAG_RECORD_SIZE;

export const FORK_EXCEPTION_ACTIVATION_IMPORT =
  WPK_FORK_EXCEPTION_IMPORT_ACTIVATION;
export const FORK_EXCEPTION_LOOKUP_IMPORT = WPK_FORK_EXCEPTION_IMPORT_LOOKUP;
export const FORK_EXCEPTION_CLAIM_IMPORT = WPK_FORK_EXCEPTION_IMPORT_CLAIM;
export const FORK_EXCEPTION_DEFINE_IMPORT = WPK_FORK_EXCEPTION_IMPORT_DEFINE;
export const FORK_EXCEPTION_LOAD_IMPORT = WPK_FORK_EXCEPTION_IMPORT_LOAD;
export const FORK_EXCEPTION_ROUTE_IMPORT = WPK_FORK_EXCEPTION_IMPORT_ROUTE;
export const FORK_EXCEPTION_CACHE_INDEX_IMPORT =
  WPK_FORK_EXCEPTION_IMPORT_CACHE_INDEX;
export const FORK_EXCEPTION_BROKER_ENCODE_IMPORT =
  WPK_FORK_EXCEPTION_IMPORT_BROKER_ENCODE;
export const FORK_EXCEPTION_BROKER_THROW_RECIPE_IMPORT =
  WPK_FORK_EXCEPTION_IMPORT_BROKER_THROW_RECIPE;
export const FORK_EXCEPTION_INGRESS_THROW_IMPORT =
  WPK_FORK_EXCEPTION_IMPORT_INGRESS_THROW;
export const FORK_REFERENCE_SCRATCH_RESERVE_IMPORT =
  WPK_FORK_REFERENCE_IMPORT_SCRATCH_RESERVE;
export const FORK_REFERENCE_SCRATCH_RELEASE_IMPORT =
  WPK_FORK_REFERENCE_IMPORT_SCRATCH_RELEASE;

export const FORK_EXCEPTION_ENCODE_EXPORT = WPK_FORK_EXCEPTION_EXPORT_ENCODE;
export const FORK_EXCEPTION_DECODE_EXPORT = WPK_FORK_EXCEPTION_EXPORT_DECODE;
export const FORK_EXCEPTION_THROW_SLOT_EXPORT =
  WPK_FORK_EXCEPTION_EXPORT_THROW_SLOT;
export const FORK_EXCEPTION_THROW_RECIPE_EXPORT =
  WPK_FORK_EXCEPTION_EXPORT_THROW_RECIPE;
export const FORK_EXCEPTION_ENCODE_INGRESS_EXPORT =
  WPK_FORK_EXCEPTION_EXPORT_ENCODE_INGRESS;
export const FORK_EXCEPTION_MATERIALIZE_EXPORT =
  WPK_FORK_EXCEPTION_EXPORT_MATERIALIZE;
export const FORK_EXCEPTION_CLEAR_EXPORT = WPK_FORK_EXCEPTION_EXPORT_CLEAR;
export const FORK_EXCEPTION_ABORT_EXPORT = WPK_FORK_EXCEPTION_EXPORT_ABORT;

const MAX_RECIPE_ID = 0x7fff_fffe;
const MAX_ACTIVATION_ID = 0x7fff_ffff;

export interface ForkExceptionTagLayout {
  readonly tagOrdinal: number;
  readonly layoutId: number;
  readonly scalarByteLength: number;
  readonly referenceCount: number;
}

export interface ForkExceptionCodecDescriptor {
  readonly version: number;
  readonly tags: readonly ForkExceptionTagLayout[];
}

export interface ForkExceptionProvider
  extends ForkActivationExceptionProvider, ForkExceptionSlotProvider
{
  readonly activationId: number;
  readonly encode: CallableFunction;
  readonly decode: CallableFunction;
}

function assertI32(value: number, context: string): void {
  if (!Number.isInteger(value) || value < -0x8000_0000 || value > 0x7fff_ffff) {
    throw new RangeError(`${context} is not an i32`);
  }
}

function assertU31(value: number, context: string, allowZero = true): void {
  if (
    !Number.isInteger(value)
    || value < (allowZero ? 0 : 1)
    || value > 0x7fff_ffff
  ) {
    throw new RangeError(`${context} is not ${allowZero ? "a" : "a nonzero"} u31`);
  }
}

function assertRecipeId(value: number, allowZero: boolean): void {
  assertU31(value, "fork exception recipe id", allowZero);
  if (value > MAX_RECIPE_ID) {
    throw new RangeError(`fork exception recipe id ${value} is reserved`);
  }
}

function requireFunction(
  exports: WebAssembly.Exports,
  name: string,
): CallableFunction {
  const value = exports[name];
  if (typeof value !== "function") {
    throw new Error(`fork exception provider is missing function export ${name}`);
  }
  return value as CallableFunction;
}

function checkedPointerResult(
  value: number,
  ptrWidth: 4 | 8,
): number | bigint {
  return ptrWidth === 8 ? BigInt(value) : value;
}

/**
 * Parse and validate the exact-tag catalog emitted by the instrumenter.
 *
 * The module template hash binds tag identities and concrete payload types;
 * this descriptor binds their deterministic codec ordinals and byte layout.
 */
export function readForkExceptionCodecDescriptor(
  module: WebAssembly.Module,
): ForkExceptionCodecDescriptor {
  const sections = WebAssembly.Module.customSections(
    module,
    FORK_EXCEPTION_CODEC_SECTION,
  );
  if (sections.length !== 1) {
    throw new Error(
      `expected one ${FORK_EXCEPTION_CODEC_SECTION} section, found ${sections.length}`,
    );
  }
  const bytes = new Uint8Array(sections[0]!);
  if (bytes.byteLength < FORK_EXCEPTION_CODEC_HEADER_SIZE) {
    throw new Error("fork exception codec descriptor is truncated");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint8(0);
  if (version !== FORK_EXCEPTION_CODEC_VERSION) {
    throw new Error(`unsupported fork exception codec version ${version}`);
  }
  if (view.getUint8(1) !== 0 || view.getUint16(2, true) !== 0) {
    throw new Error("fork exception codec descriptor reserved fields are nonzero");
  }
  const count = view.getUint32(4, true);
  const expected = FORK_EXCEPTION_CODEC_HEADER_SIZE
    + count * FORK_EXCEPTION_CODEC_TAG_RECORD_SIZE;
  if (!Number.isSafeInteger(expected) || bytes.byteLength !== expected) {
    throw new Error("fork exception codec descriptor has an invalid size");
  }
  const tags: ForkExceptionTagLayout[] = [];
  const layouts = new Set<number>();
  for (let index = 0; index < count; index++) {
    const offset = FORK_EXCEPTION_CODEC_HEADER_SIZE
      + index * FORK_EXCEPTION_CODEC_TAG_RECORD_SIZE;
    const tagOrdinal = view.getUint32(offset, true);
    const layoutId = view.getUint32(offset + 4, true);
    const scalarByteLength = view.getUint32(offset + 8, true);
    const referenceCount = view.getUint32(offset + 12, true);
    if (tagOrdinal !== index) {
      throw new Error(
        `fork exception tag ordinal ${tagOrdinal} is noncanonical at ${index}`,
      );
    }
    if (layoutId > MAX_ACTIVATION_ID || layouts.has(layoutId)) {
      throw new Error(`fork exception layout id ${layoutId} is invalid or duplicated`);
    }
    layouts.add(layoutId);
    tags.push({ tagOrdinal, layoutId, scalarByteLength, referenceCount });
  }
  return { version, tags };
}

/** Resolve one activation's local, exact-tag codec after instantiation. */
export function forkExceptionProviderFromInstance(
  activationId: number,
  instance: WebAssembly.Instance,
): ForkExceptionProvider {
  assertU31(activationId, "fork exception activation id");
  const throwSlot = requireFunction(
    instance.exports,
    FORK_EXCEPTION_THROW_SLOT_EXPORT,
  );
  const throwRecipe = requireFunction(
    instance.exports,
    FORK_EXCEPTION_THROW_RECIPE_EXPORT,
  );
  const encodeIngress = requireFunction(
    instance.exports,
    FORK_EXCEPTION_ENCODE_INGRESS_EXPORT,
  );
  const materialize = requireFunction(
    instance.exports,
    FORK_EXCEPTION_MATERIALIZE_EXPORT,
  );
  const clear = requireFunction(instance.exports, FORK_EXCEPTION_CLEAR_EXPORT);
  const abort = requireFunction(instance.exports, FORK_EXCEPTION_ABORT_EXPORT);
  return {
    activationId,
    encode: requireFunction(instance.exports, FORK_EXCEPTION_ENCODE_EXPORT),
    decode: requireFunction(instance.exports, FORK_EXCEPTION_DECODE_EXPORT),
    throwSlot(slot): never {
      assertI32(slot, "fork exception scratch slot");
      throwSlot(slot);
      throw new Error(`activation ${activationId} exception slot returned without throwing`);
    },
    throwRecipe(recipeId): never {
      assertRecipeId(recipeId, false);
      throwRecipe(recipeId);
      throw new Error(`activation ${activationId} exception recipe returned without throwing`);
    },
    encodeIngress(token): number {
      assertU31(token, "fork exception ingress token", false);
      const recipeId = Number(encodeIngress(token));
      assertRecipeId(recipeId, true);
      return recipeId;
    },
    materialize(recipeId): void {
      assertRecipeId(recipeId, false);
      materialize(recipeId);
    },
    clear(): void {
      clear();
    },
    clearSlots(): void {
      clear();
    },
    abort(): void {
      abort();
    },
  };
}

function catchProviderThrow(
  provider: ForkActivationExceptionProvider,
  slot: number,
): unknown {
  try {
    provider.throwSlot(slot);
  } catch (value) {
    return value;
  }
  throw new Error(`fork exception slot ${slot} returned without throwing`);
}

/**
 * Scalar-only bridge for exceptions whose tag is owned by another activation.
 *
 * Providers are probed in activation order. During a probe, the candidate's
 * own unknown-tag callback returns zero for the same thrown identity instead
 * of recursively restarting discovery. A raw JavaScript/JSTag exception that
 * no Wasm activation owns is represented by a host-owned recipe.
 */
export class ForkExceptionBroker {
  private nextIngressToken = 1;
  private readonly ingress = new Map<number, unknown>();
  private readonly probes: unknown[] = [];

  constructor(
    private readonly registry: ForkActivationRegistry,
    private readonly label: string,
    private readonly replayReferences: () => {
      exceptionOwner(recipeId: number): number;
      materializeHostException(recipeId: number): unknown;
    } = () => registry.currentReferences(),
    /**
     * Called only after every exact activation codec declines an exception.
     * It returns the owner-backed externref payload a fresh child can decode;
     * the parent transaction still retains the original exception identity.
     */
    private readonly normalizeUnclaimedHostException?: (
      value: unknown,
    ) => unknown,
  ) {}

  encodeFromSlot(sourceActivation: number, slot: number): number {
    const source = this.requireProvider(sourceActivation);
    const value = catchProviderThrow(source, slot);
    if (
      this.probes.length !== 0
      && Object.is(this.probes[this.probes.length - 1], value)
    ) {
      return 0;
    }

    const token = this.allocateIngress(value);
    try {
      for (const activation of this.registry.activations()) {
        if (activation.activationId === sourceActivation) continue;
        const provider = activation.exceptionProvider;
        if (!provider) continue;
        this.probes.push(value);
        let recipeId: number;
        try {
          recipeId = provider.encodeIngress(token);
        } finally {
          this.probes.pop();
        }
        assertRecipeId(recipeId, true);
        if (recipeId !== 0) return recipeId;
      }
      const childPayload = this.normalizeUnclaimedHostException
        ? this.normalizeUnclaimedHostException(value)
        : value;
      return this.registry.currentReferences().captureHostException(
        value,
        childPayload,
      );
    } finally {
      this.ingress.delete(token);
    }
  }

  throwIngress(token: number): never {
    assertU31(token, "fork exception ingress token", false);
    if (!this.ingress.has(token)) {
      throw new Error(`${this.label}: unknown exception ingress token ${token}`);
    }
    throw this.ingress.get(token);
  }

  throwRecipe(recipeId: number): never {
    assertRecipeId(recipeId, false);
    const references = this.replayReferences();
    const owner = references.exceptionOwner(recipeId);
    if (owner === FORK_HOST_EXCEPTION_ACTIVATION_ID) {
      throw references.materializeHostException(recipeId);
    }
    return this.requireProvider(owner).throwRecipe(recipeId);
  }

  clear(): void {
    this.ingress.clear();
    this.probes.length = 0;
  }

  private requireProvider(activationId: number): ForkActivationExceptionProvider {
    const provider = this.registry.getActivation(activationId).exceptionProvider;
    if (!provider) {
      throw new Error(
        `${this.label}: activation ${activationId} has no exception provider`,
      );
    }
    return provider;
  }

  private allocateIngress(value: unknown): number {
    if (this.nextIngressToken > MAX_RECIPE_ID) {
      this.nextIngressToken = 1;
    }
    const start = this.nextIngressToken;
    do {
      const token = this.nextIngressToken++;
      if (!this.ingress.has(token)) {
        this.ingress.set(token, value);
        return token;
      }
      if (this.nextIngressToken > MAX_RECIPE_ID) this.nextIngressToken = 1;
    } while (this.nextIngressToken !== start);
    throw new RangeError(`${this.label}: exception ingress token space exhausted`);
  }
}

export interface ForkExceptionImportOptions {
  readonly activationId: number;
  readonly ptrWidth: 4 | 8;
  readonly registry: ForkActivationRegistry;
  readonly broker: ForkExceptionBroker;
  /** Late-bound because imports must exist before the instance exports do. */
  readonly provider: () => ForkExceptionProvider;
  /**
   * Replay owner used before the complete fresh-child registry can attach.
   * Capture-only callbacks remain bound to the registry transaction.
   */
  readonly referenceReplay?: () => ForkExceptionReferenceReplayImports;
}

export interface ForkExceptionReferenceReplayImports {
  loadException(
    recipeId: number,
    moduleActivation: number,
    tagOrdinal: number,
    layoutId: number,
    scalarPointer: number | bigint,
    scalarByteLength: number,
    referenceIdsPointer: number | bigint,
    referenceCount: number,
  ): number;
  routeException(recipeId: number, expectedActivation: number): number;
  exceptionCacheIndex(recipeId: number): number;
  reserveScratch(size: number | bigint): number;
  releaseScratch(pointer: number | bigint, size: number | bigint): void;
}

/**
 * Bind one in-module codec to the active process transaction.
 *
 * Every callback has only scalar parameters. The sole reference transfer is a
 * thrown exception caught by JavaScript and immediately re-thrown into another
 * provider; no reference enters the continuation or module-state arena.
 */
export function buildForkExceptionImports(
  options: ForkExceptionImportOptions,
): Record<string, WebAssembly.ImportValue> {
  const { activationId, ptrWidth, registry, broker } = options;
  assertU31(activationId, "fork exception activation id");
  if (ptrWidth !== 4 && ptrWidth !== 8) {
    throw new TypeError(`invalid fork exception pointer width ${ptrWidth}`);
  }
  const references = () => registry.currentReferences();
  const replayReferences = options.referenceReplay ?? references;
  return {
    [FORK_EXCEPTION_ACTIVATION_IMPORT]: new WebAssembly.Global(
      { value: "i32", mutable: false },
      activationId,
    ),
    [FORK_EXCEPTION_LOOKUP_IMPORT]: (slot: number): number =>
      references().lookupExceptionSlot(slot, options.provider()),
    [FORK_EXCEPTION_CLAIM_IMPORT]: (slot: number): number =>
      references().claimExceptionSlot(slot, options.provider()),
    [FORK_EXCEPTION_DEFINE_IMPORT]: (
      recipeId: number,
      moduleActivation: number,
      tagOrdinal: number,
      layoutId: number,
      scalarPointer: number | bigint,
      scalarByteLength: number,
      referenceIdsPointer: number | bigint,
      referenceCount: number,
    ): void => references().defineException(
      recipeId,
      moduleActivation,
      tagOrdinal,
      layoutId,
      scalarPointer,
      scalarByteLength,
      referenceIdsPointer,
      referenceCount,
    ),
    [FORK_EXCEPTION_LOAD_IMPORT]: (
      recipeId: number,
      moduleActivation: number,
      tagOrdinal: number,
      layoutId: number,
      scalarPointer: number | bigint,
      scalarByteLength: number,
      referenceIdsPointer: number | bigint,
      referenceCount: number,
    ): number => replayReferences().loadException(
      recipeId,
      moduleActivation,
      tagOrdinal,
      layoutId,
      scalarPointer,
      scalarByteLength,
      referenceIdsPointer,
      referenceCount,
    ),
    [FORK_EXCEPTION_ROUTE_IMPORT]: (
      recipeId: number,
      expectedActivation: number,
    ): number => replayReferences().routeException(
      recipeId,
      expectedActivation,
    ),
    [FORK_EXCEPTION_CACHE_INDEX_IMPORT]: (recipeId: number): number =>
      replayReferences().exceptionCacheIndex(recipeId),
    [FORK_EXCEPTION_BROKER_ENCODE_IMPORT]: (slot: number): number =>
      broker.encodeFromSlot(activationId, slot),
    [FORK_EXCEPTION_BROKER_THROW_RECIPE_IMPORT]: (recipeId: number): never =>
      broker.throwRecipe(recipeId),
    [FORK_EXCEPTION_INGRESS_THROW_IMPORT]: (token: number): never =>
      broker.throwIngress(token),
    [FORK_REFERENCE_SCRATCH_RESERVE_IMPORT]: (
      size: number | bigint,
    ): number | bigint =>
      checkedPointerResult(replayReferences().reserveScratch(size), ptrWidth),
    [FORK_REFERENCE_SCRATCH_RELEASE_IMPORT]: (
      pointer: number | bigint,
      size: number | bigint,
    ): void => replayReferences().releaseScratch(pointer, size),
  };
}
