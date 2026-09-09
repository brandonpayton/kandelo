// Phase 6 D6.2 / M2 — the single REAL `env.resolve_externref` import body that
// backs the co-resident fork-module's externref reconstruction.
//
// M2 collapsed the externref host seam. The module used to drive externref
// identity across FIVE opaque `wpk_fork_host` imports keyed by `u32`
// ordinals (`host_begin_generation` / `host_resolve_externref(gen, handle)` /
// `host_transit_publish` / `host_transit_read` / `host_release_generation`)
// because a Wasm module cannot hold a live `externref` directly. M2 moved the
// decode + transit-publish logic into the INJECTED binder
// (`crates/fork-module-inject`), which can express a reference-typed import
// call and a `table.set` on the module-owned anyref transit itself. The only
// residual host import is a single reference-returning call:
//
//   `resolve_externref(handle: i32) -> externref`
//
// `ForkExternrefTokenCache.materialize(handle)` is idempotent (a `WeakRef`
// cache keyed by broker handle), so this import returns the SAME canonical
// token every time it is asked for a given handle — identity is guaranteed at
// the SOURCE, not by a host-side round-trip/`Object.is` guard. See the M2
// design ruling in
// `docs/superpowers/plans/2026-09-03-m2-externref-into-module.md`.
//
// An invalid handle is a truthful `RangeError` out of `materialize` (not a
// soft failure sentinel): there is no `host_last_errno` cell in this seam
// any more, and the injected binder's non-null check is the R1 guard for a
// value that resolved but was not reachable, not for a malformed handle.

import type { ForkExternrefTokenCache } from "./fork-reference-broker";

export interface ForkModuleHostCapabilitiesBacking {
  /**
   * The child worker's externref token cache (broker handle -> canonical
   * worker-local token). `materialize` is idempotent, so the token
   * `resolve_externref` returns for a handle is the SAME object the JS
   * decode path (and any other caller) returns for that handle.
   */
  readonly tokens: ForkExternrefTokenCache;
}

export interface ForkModuleHostCapabilities {
  /** The single `env.resolve_externref` import body to hand `instantiateForkModule`. */
  readonly imports: Readonly<{
    resolve_externref: (handle: number) => unknown;
  }>;
  /** Number of externrefs resolved through the seam (proof-of-use inspector). */
  readonly resolvedCount: number;
}

/**
 * Build the real `env.resolve_externref` body backed by `backing`. Pass
 * `result.imports.resolve_externref` as
 * `instantiateForkModule({ resolveExternref })`; the module's injected binder
 * calls it directly from `__wpk_fork_ref_decode_externref` and the
 * externref-transit drive step.
 */
export function createForkModuleHostCapabilities(
  backing: ForkModuleHostCapabilitiesBacking,
): ForkModuleHostCapabilities {
  let resolved = 0;

  const resolve_externref = (handle: number): unknown => {
    const token = backing.tokens.materialize(handle);
    resolved += 1;
    return token;
  };

  return {
    imports: { resolve_externref },
    get resolvedCount() {
      return resolved;
    },
  };
}
