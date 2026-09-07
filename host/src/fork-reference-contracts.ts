// Staying glue: the shared fork reference-reconstruction CONTRACTS that both
// the deletable JS reference engine (`fork-reference-transaction.ts` /
// `fork-activation-registry.ts`, the A5 delete targets) and the staying
// pre-instantiation imported-global reconstruction floor
// (`fork-early-reference-provider.ts`) reference.
//
// WHY THIS FILE EXISTS (Path-A INC-C wiring, part 2). Imported-global
// materialization is genuine HOST FLOOR: `ForkEarlyChildReferenceProvider`
// reconstructs reference-typed imported globals in a topological
// `WebAssembly.Instance` order BEFORE any child guest instance exists (the
// co-resident fork-module is instantiated ahead of the guests and holds no live
// reference to hand a guest import), so it can never be a fork-module export.
// It therefore must STAY when the JS reference engine is deleted (A5). Its only
// couplings to the deletable engine were these interface + constant DEFINITIONS
// living inside the engine files; re-homing them here (with the engine files
// re-exporting for unchanged surfaces) lets the floor provider stop importing
// the deletable engine. These are pure type/const contracts — no reconstruction
// LOGIC moves — so nothing here is engine behavior.

import type { DecodedSegmentedForkReferenceTransaction } from "./fork-reference-segments";

/**
 * The externref recipe provider the reference reconstruction floor uses to move
 * opaque values under process-owned lifetime management and to recover this
 * Worker's canonical token for a process-owned handle.
 */
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

/**
 * The one method the pre-instantiation floor calls on the full replay
 * transaction when it hands its materialized prefix over. Typing `adoptInto`
 * against this minimal contract (which the deletable `ForkReferenceTransaction`
 * satisfies structurally) is what lets the floor provider stop importing the
 * deletable engine while worker-main still passes the real transaction at
 * runtime.
 */
export interface ForkReferenceReplayAdoptionTarget {
  adoptChildReplay(adoption: ForkReferenceChildReplayAdoption): void;
}

/**
 * Per-activation exception codec surface the reference reconstruction floor and
 * the JS engine both drive. Keeping `exnref` values inside Wasm scratch slots
 * (never returned through JavaScript) is the reason the throw/materialize
 * methods take slots/recipes rather than values.
 */
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
