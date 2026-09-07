# Fork Reference Support

This document describes which kinds of live Wasm references `fork()`
can carry across the process boundary today, which kinds it cannot,
why that split is safe for real Kandelo workloads, and what closing
the remaining gap would take. It exists so the boundary is a visible,
documented platform gap rather than a silently swallowed failure —
see the Platform Values Contract in `CLAUDE.md` ("truthful failure
over convenient illusion").

## Overview

During `fork()`, the host and kernel reconstruct the child's live
program state, including every Wasm reference reachable from the
forking activation: table entries, globals, locals, and exception
payloads. Every reference kind Wasm can express — `null`, `funcref`,
`exnref`, `externref`, typed Wasm-GC (`struct`/`array`/`i31`), and
static-root references — is reconstructed, on every host (native,
Node, and browser). One narrow residual case (an anyref-lineage value
with no recoverable production-site identity) remains an explicit,
loud, unsupported boundary rather than something silently patched
together by host JS; see "One remaining gated boundary" below.

## Supported across fork

- **`null` and `funcref`.** Ordinary programs get a static
  `__indirect_function_table` re-derived from the module's element
  segments. Programs that mutate their function table at runtime
  (`dlopen`/runtime-table-mutating programs such as `php`, `php-fpm`,
  and `redis-server`) are covered separately via the funcref ordinal
  catalog, which records the ordinal assigned to each table entry as
  it is installed.
- **`exnref` for wasm-tag / C++ exceptions.** Exceptions compiled with
  `-fwasm-exceptions` (see `docs/posix-status.md`'s "C++ exception
  support" section) are reconstructed via the exception codec
  (`exception_codec` / KFEC), which serializes scalar exception
  payloads and rebuilds the corresponding `exnref` in the child.
- **Simple (COW) and `vfork()` forks.** Both fork styles carry the
  supported reference kinds above; see `docs/fork-instrumentation.md`
  for how reconstruction fits into the broader replay design.

## Supported across fork (externref, GC, static-root)

`externref`, typed Wasm-GC (`struct`/`array`/`i31`), and static-root
references are also reconstructed across fork, on every host (native,
Node, and browser):

- **A plain host externref with recorded provenance.** Every
  externref-returning host-import call site is wrapped by
  `wasm-fork-instrument` (`crates/fork-instrument/src/externref_provenance.rs`)
  to record `(value -> handle)` at the exact moment the import produces
  the value — the only sound moment to observe that association. Fork
  capture (the anyref-transit `gc_lookup`/`GC_LOOKUP` seam; native:
  `crates/host-native/src/guest.rs`, Node/browser:
  `ForkReferenceTransaction.lookupGcSlot` in
  `host/src/fork-reference-transaction.ts`) looks the value up in that
  provenance record — never mints a handle by inspecting an
  already-live value — and interns it as a real `externref` recipe
  node on a hit.
- **Static roots.** An immutable Wasm-GC global/local/table entry
  reachable from module-level `elem`/`global` initializers is recorded
  by a harvest-time reverse index (`ForkStaticRootCatalog`/
  `StaticRootProvenance`) and reconstructed via the same `gc_lookup`
  seam.
- **Typed Wasm-GC struct/array/i31.** A genuinely new (not dedup, not
  static-root, not externref-provenance) anyref-lineage value falls
  through to real construction: the guest's generated GC codec walks
  its fields, and the host's `claimGcSlot`/`defineGc`/`encodeI31`
  (Node/browser) or equivalent native methods build the real recipe
  node, restored in the child via the injected codec's
  allocate/fill drive.

The Node/browser and native hosts share the same capture-time
layering: dedup, then static-root, then externref-provenance, then a
genuine miss recurses into real struct/array/i31 construction instead
of gating. See
`docs/plans/2026-09-05-n1-nodebrowser-reference-parity-grounding.md`
for the Node/browser parity work and its test coverage.

### One remaining gated boundary

A single case still gates cleanly with `EOPNOTSUPP`
(`ForkReferenceUnsupportedError`, errno 95;
`host/src/fork-reference-unsupported.ts`), on every host: an
anyref-lineage value that is **not** a dedup hit, **not** a static
root, and **not** a plain externref with recorded provenance — i.e. a
Wasm-GC-internalized value produced by `any.convert_extern` with no
production-site provenance to recover (a `call_indirect`/`call_ref`
landing on an externref-returning host import that the instrumenter's
static pass could not identify, or a genuinely engine-internalized
value). Fabricating a handle for this case would be the unsound
capture-time reverse lookup this design deliberately avoids, so it
gates instead of mis-capturing. This is detected on the **parent**
side during capture, before any child is spawned; in the default
configuration (`WASM_POSIX_FORK_MODULE` unset) it surfaces as a clean
fork-abort (`beginAbortReplay`) with no crash and no partially
constructed child.

## Known gaps and residuals

- **Module-mode abort for the one remaining gated case — VERIFIED
  (Path B P4, 2026-09-07).** With `WASM_POSIX_FORK_MODULE=1` set (an
  opt-in mode, not the default), the one still-gated case above now
  aborts cleanly through the co-resident fork module's OWN
  continuation-journal abort path (`beginAbortReplay` ->
  `beginModuleAbortReplay` -> `fm_begin_abort`), not the JS
  reconstruction engine that P6 deletes. This is proven end to end on
  V8 by `host/test/externref-gated-fork-module-worker.test.ts` — the
  Node/V8 mate of native's
  `crates/host-native/src/lib.rs::smoke_fork_gated_externref_parent_
  survives`. Under `forkModuleEnabled: true`, a live host externref
  minted via `call_indirect` (so the provenance-wrapper pass records
  nothing and it reaches the gate) forked across `kernel_fork`
  returns exactly `-EOPNOTSUPP`, spawns no child, leaves the parent's
  own externref identity intact, completes within a bounded
  wall-clock budget (guarding the gate-hang regression against a ~30s
  pump cap), and reports a nonzero co-resident-module committed-frame
  count (the positive proof the module — not a silent JS fallback —
  drove the abort). The earlier "module-mode abort-replay deferred to
  M8" limitation is closed for this residual case.
- **Host-exception externref payloads remain a narrow, synthetic-only
  path.** A raw host (JS `JSTag`) exception whose payload is an
  externref reconstructs through the retained exception machinery
  (`ForkReferenceTransaction.materializeHostException`), independent of
  the `GC_LOOKUP`/provenance path above. Only synthetic fixtures
  exercise this; no real package hits it.
- **A host-import-returned externref that is not object-shaped has no
  handle to record.** The provenance table is keyed by JS object
  identity (`WeakMap`); a hypothetical future host import that returns
  a primitive (number/string/boolean) as an externref has no key to
  register against. No current or near-term host import does this
  (checked against `host/src/fork-externref-import-mailbox.ts`'s
  import descriptor shapes); native has the identical limitation.

## Package-level validation

A census of all 113 built package programs in the registry found
**zero** packages that produce `externref`/GC/static-root references
across a fork: the fork instrumenter's own computed sections for these
kinds are empty for every program in the census, host/syscall imports
are scalar, and guest C++ exception handling in the package set is
tag-based. Real workloads that fork — WordPress/PHP via `dlopen`,
LXDE, and the language interpreters (Python, Ruby, Node, Perl) — fall
entirely within the funcref/exnref set that was already supported
before this reconstruction work, so this document's history is not a
correctness concern for any package validated to date; it does mean
the reconstruction paths above are proven only by synthetic test
fixtures, not a real package, as of this writing.
