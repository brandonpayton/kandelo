// host/src/fork-module-exnref-admission.ts
//
// Host-owned exnref tag-validity boundary for the co-resident fork-module
// reconstruction path (Bucket C floor glue — stays past the P6 JS deletion).
//
// WHY THIS LIVES IN THE HOST. `crates/fork-codec/src/reference_replay.rs:210-212`
// states the contract explicitly: the host computes the reference-kind predicate
// "plus an exception-descriptor validity check it alone can see" before flipping
// the reference path. The co-resident module has NO exception-codec seeding or
// validation (there is no `fm_set_activation_exception_codec` /
// `decode_exception` in `crates/fork-module`), and `GcCodecHints`'s exnref arm
// (`drive_plan_hints.rs`) assigns the drive owner to the node's activation
// UNCONDITIONALLY and emits a `DRIVE_OP_EXN` step — so `fm_begin_reference_replay`
// / `fm_build_gc_plan` cannot reject an exnref recipe whose tag its owning
// activation's exception codec never declared. Unlike GC (which the module
// re-checks via `GcCodecHints::require_layout` → `EINVAL`), exnref tag-validity
// has no module-side re-check, so the host must own it.
//
// FAIL-LOUD, NOT A JS FALLBACK. When the module is the sole reconstructor a
// corrupt / mismatched exnref recipe must fail loud (truthful failure over a
// silent-wrong exception reconstruction) rather than being driven blindly through
// the guest materialize export (which is only guaranteed to trap when the guest
// lacks the export, i.e. an unbound `call_indirect` slot). In normal operation a
// captured exnref always names a tag its activation declared, so this never fires
// on a well-formed fork; it closes the corrupt-recipe / defense-in-depth boundary.

/** One exnref graph node's admission coordinates. */
export interface ForkExnrefNode {
  /** The activation whose exception codec must declare the tag. */
  readonly moduleActivation: number;
  /** The wasm exception tag ordinal the recipe names. */
  readonly tagOrdinal: number;
}

/**
 * The tags each activation's exception codec descriptor declares, keyed by
 * activation id. Built by the host from every activation's exception-codec
 * custom section (`readForkExceptionCodecDescriptor`).
 */
export type ForkExnrefTagRegistry = ReadonlyMap<number, ReadonlySet<number>>;

/** True iff `node`'s owning activation declares `node`'s exception tag. */
export function forkModuleExnrefTagDeclared(
  registry: ForkExnrefTagRegistry,
  node: ForkExnrefNode,
): boolean {
  return registry.get(node.moduleActivation)?.has(node.tagOrdinal) ?? false;
}

/**
 * Truthful failure for an exnref recipe whose tag its owning activation's
 * exception codec does not declare. Numeric `errno` is `EINVAL` (22): the fork
 * carried a corrupt / mismatched exception recipe, distinct from
 * `ForkReferenceUnsupportedError`'s `EOPNOTSUPP` (95), which means an entire
 * reference KIND is unsupported. The exnref kind IS supported; this specific
 * recipe is invalid.
 */
export class ForkModuleExnrefTagError extends Error {
  readonly errno = 22 as const;
  constructor(
    readonly moduleActivation: number,
    readonly tagOrdinal: number,
    label: string,
  ) {
    super(
      `${label}: fork exnref recipe names exception tag ` +
        `${moduleActivation}:${tagOrdinal}, which activation ` +
        `${moduleActivation}'s exception codec does not declare — refusing to ` +
        `drive a corrupt exception recipe through the co-resident fork-module ` +
        `(EINVAL). See docs/fork-reference-support.md.`,
    );
    this.name = "ForkModuleExnrefTagError";
  }
}

/**
 * Assert every exnref node in the fork's reference graph names a tag its owning
 * activation actually declares, throwing {@link ForkModuleExnrefTagError} on the
 * first violation. Called before the module drives reconstruction, so a corrupt
 * exnref recipe fails loud instead of being `call_indirect`-driven blindly.
 */
export function assertForkModuleExnrefTagsDeclared(
  registry: ForkExnrefTagRegistry,
  nodes: Iterable<ForkExnrefNode>,
  label: string,
): void {
  for (const node of nodes) {
    if (!forkModuleExnrefTagDeclared(registry, node)) {
      throw new ForkModuleExnrefTagError(
        node.moduleActivation,
        node.tagOrdinal,
        label,
      );
    }
  }
}
