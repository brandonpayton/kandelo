/**
 * Local, same-realm provenance table for fork-reference capture (N1
 * Node/browser parity).
 *
 * Mirrors native's `ExternrefProvenanceRegistry`
 * (`crates/host-native/src/guest.rs`): populated ONLY by
 * `__wpk_fork_ref_provenance_externref`'s host-import body, at the exact
 * moment a host-import call site returns an externref value to the guest —
 * NOT by inspecting an already-live value later at capture time. That
 * production-time recording is the sound half of the design (see
 * `docs/plans/2026-09-05-n1-nodebrowser-reference-parity-grounding.md` §1);
 * a lazily-populated reverse lookup at capture time cannot distinguish a
 * genuine host-import production from a GC-internalized value that merely
 * reached the same code path, which is exactly the unsound pattern this
 * table must not reintroduce (see
 * `ForkWorkerLocalImportExceptionNormalizer.normalizeUnclaimedForkValue`).
 *
 * Because production (`__wpk_fork_ref_provenance_externref`'s body) and
 * consumption (`GC_LOOKUP`'s externref-provenance branch) both run
 * synchronously in the same process Worker during one fork's capture pass,
 * a plain identity-keyed `WeakMap` is sufficient — no cross-worker
 * `ForkExternrefProcessOwner` plumbing is needed here.
 */
export class ForkExternrefProvenanceTable {
  private readonly handles = new WeakMap<object, number>();

  /** Record `value -> handle` at the exact moment `value` was minted. */
  register(value: object, handle: number): void {
    this.handles.set(value, handle);
  }

  /** Lookup-only: never mints, never fabricates a handle for a miss. */
  lookup(value: unknown): number | undefined {
    if (
      (typeof value !== "object" || value === null)
      && typeof value !== "function"
    ) {
      return undefined;
    }
    return this.handles.get(value as object);
  }
}
