// host/src/fork-reference-unsupported.ts

/**
 * Truthful failure for a fork that carries a live reference of a kind whose
 * in-module reconstruction has not yet been built. The delete-and-gate slice
 * (2026-09-04) removed the interim JS reconstruction for externref / struct /
 * array / i31 / static-root; those forks now fail loud here instead of being
 * reconstructed by host JS. Mirrors the module's own EOPNOTSUPP re-check in
 * `fm_begin_reference_replay`. See docs/fork-reference-support.md.
 */
export class ForkReferenceUnsupportedError extends Error {
  // Numeric errno matching the real control path: the parent run loop aborts a
  // gated fork with `-FORK_REFERENCE_EOPNOTSUPP` (95) and the kernel/guest use
  // `Errno::EOPNOTSUPP` (95). Keep this the same numeric convention rather than
  // a symbolic string so a caller comparing against a raw errno matches.
  readonly errno = 95 as const;
  constructor(readonly kind: string) {
    super(
      `fork carries a live '${kind}' reference across the fork boundary, `
      + `which the in-module reconstruction path does not support yet `
      + `(see docs/fork-reference-support.md). Supported reference kinds: `
      + `null, funcref, exnref (wasm-tag exceptions).`,
    );
    this.name = "ForkReferenceUnsupportedError";
  }
}
