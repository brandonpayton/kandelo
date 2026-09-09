# Fork control-flow inversion — exnref tag-validity gate moved into fm_attach_child

Status: DONE (ABI-neutral). Plan increment 5 — the follow-up the
child-reconstruct fold correctly stopped-and-argued out of
`fm_child_reconstruct` (the gate is an ADMISSION check that must run BEFORE the
exnref materialize drive; child-reconstruct runs last). The fail-loud SECURITY
boundary now lives inside the co-resident fork-module's child-install entry.
Node-validated on `aarch64-apple-darwin`. Browser leg (Chromium + WebKit
exnref/host-exception path) owed to the coordinator.

Worktree `/Users/brandon/kandelo-abi44-reconcile`, branch
`brandonpayton/rust-first-abi44-reconcile`, built on `c41a156e9`.

## Commits

- `cb3d6ad02` Fork: Add the exnref tag-validity admission gate to the replay driver
- `d9191ef98` Fork: Move the exnref tag-validity gate into fm_attach_child
- `f5342e9e9` Fork: Test the module exnref admission gate rejects corrupt recipes

Authored by Brandon Payton. The wasm artifacts (`local-binaries/`, `host/wasm/`,
`source-only-v1/`) are gitignored local build products; the commits are pure
source. The working tree otherwise carries only the pre-existing `libc/musl`
submodule marker.

## What the gate is, and why it moved here

The exnref tag-validity gate REJECTS any captured exception reference whose wasm
exception tag its owning activation's exception codec never declared. A corrupt
or mismatched exnref recipe must fail loud (`EINVAL`) — truthful failure over a
silent wrong exception reconstruction — never be `call_indirect`-driven blindly
through the guest exception-materialize export.

It was a HOST pre-walk (`assertForkModuleExnrefTagsDeclared` in `worker-main.ts`)
that ran before the module reconstructed a fork child's references. It lived in
the host ONLY because the module had no exception-codec seeding, so it could not
re-check the tag itself. This increment gives the module that seeding and moves
the boundary into the reconstruction ENTRY, before the exnref materialize drive.

## The seeding (`fm_set_activation_exception_tags`)

New export `fm_set_activation_exception_tags(activation_id, ptr, count)`
(`crates/fork-module/src/lib.rs`): `[ptr, ptr + count*4)` is a little-endian
`u32` array of the tag ordinals that activation's
`kandelo.wpk_fork.exception_codec` section declares. Storage mirrors the
per-activation GC-codec / resume catalogs — a fixed BSS ordinal arena
(`ACT_EXN_TAGS_ORDS`, 65 536 ordinals) plus a small `[activation_id, offset,
len]` index (`ACT_EXN_TAGS_INDEX`, 64 activations) — so it survives the per-fork
bump-heap reset. It reuses the GC-codec's idempotent-re-seed semantics: a COW
child inherits the parent's seeded tags through the shared-memory clone AND the
production host re-seeds every child, so an identical re-seed is a no-op; a
CONFLICTING re-seed (same activation, different tags) is `EINVAL`; overflow is
`E2BIG`.

## The gate (`assert_exnref_tags_admissible` in `fm_attach_child`)

`attach_from_arena_impl` (the shared impl behind `fm_attach_child` and
`fm_attach_borrowed_child`) now calls `assert_exnref_tags_admissible()` RIGHT
AFTER `begin_reference_replay_impl` decodes the graph and seeds the driver, and
BEFORE `build_reconstruction_steps()` builds the plan. That ordering guarantees
the check runs before the plan's `DRIVE_OP_EXN` step could materialize the
exception (the plan is only executed later, by `driveRestoredPlan`). The gate
walks the resident replay graph's exnref nodes and fails loud with `EINVAL` on
the first recipe whose `(module_activation, tag_ordinal)` its owning activation's
seeded exception codec does not declare (including an activation that declared no
codec at all).

The decision itself is a pure fork-codec method,
`ReferenceReplayDriver::first_undeclared_exnref(tag_declared)`
(`crates/fork-codec/src/reference_replay.rs`) — `Some((activation, tag))` on the
first violation, `None` when every exnref names a declared tag. This mirrors the
existing driver-owned graph predicates (`all_nodes_module_admissible`,
`funcref_activations`) and is unit-testable without the wasm memory plane.
`assert_exnref_tags_admissible` maps `Some -> EINVAL`, `None -> Ok`, resolving
each activation's tags through `activation_exception_tags` over the seeded arena.

### Placement note (no native bypass)

The native host (`crates/host-native/src/guest.rs`) reconstructs through the
fine-grained `fm_begin_reference_replay` path, not `fm_attach_child`, and cannot
reconstruct an exnref at all (the documented wasmtime exnref/`Exn` heap-type
blocker; native tests assert `exnrefs_reconstructed == 0`). So siting the gate in
the attach entry — the entry the JS/browser exnref path actually uses — leaves no
exnref reconstruction path that bypasses it. Native is unaffected (its graphs
carry no exnref node, so the gate walk is a trivial no-op even if reached).

## Host sequencing deleted

`host/src/worker-main.ts`:

- The exnref admission pre-walk is GONE: the block that ran
  `decodeReferenceGraph` + built `declaredExnrefTags` + walked the exnref nodes +
  `assertForkModuleExnrefTagsDeclared` is replaced by a single
  `forkModuleBackend.decodeReferenceGraph(...)` call that keeps ONLY the
  decoded-graph residency the merged static-root catalog mirror seeding still
  needs.
- The host now SEEDS instead: it captures `childExceptionTags` (each
  activation's declared tag ordinals) in the pre-instantiation planning block
  (where the compiled `modules` are in scope) and seeds them per activation via
  the new `backend.setActivationExceptionTags(...)` in the drive block, alongside
  the GC-codec seeding, before `attachChild` / `attachBorrowedChild`.
- The dead host helper `host/src/fork-module-exnref-admission.ts` and its unit
  test `host/test/fork-module-exnref-admission.test.ts` are DELETED — the
  boundary is no longer host-owned, so leaving the "Host-owned exnref
  tag-validity boundary" file would be misleading. The large design comment that
  described the check as host-owned was corrected in place.

`host/src/fork-module-backend.ts`: added `setActivationExceptionTags(activationId,
ordinals)` (mirrors `setActivationResumeCatalog`'s guest-memory staging; skips an
empty catalog). `host/src/fork-module-instance.ts`:
`fm_set_activation_exception_tags` added to the required-export list (which
types it into `ForkModuleExports`).

## Corrupt-recipe test (proves the boundary stays loud)

Two layers:

- fork-codec unit tests (`reference_replay.rs`, `cargo test -p fork-codec`):
  `first_undeclared_exnref` rejects an unknown tag `Some((0,7))`, rejects an
  exnref naming an activation that declared nothing `Some((3,0))`, admits a
  declared tag `None`, and is a trivial no-op on an exnref-free graph.
- Module-level end-to-end tests (`host/test/fork-module-exnref-replay.test.ts`,
  Node/V8): drive `fm_attach_child` over a sealed exnref-over-externref arena
  with `fm_set_activation_exception_tags` seeded, asserting `fm_last_errno ===
  EINVAL (22)` for a mismatched tag AND for an activation with no declared tags,
  and `errno 0` for the well-formed case (tag declared). The gate rejects before
  the reconstruction plan is built, so a corrupt exception recipe is never
  materialized.

## fm_* surface delta + ABI

`fm_*` exports 78 -> 79 (ADDITIVE: `fm_set_activation_exception_tags`). The
HOST-CALLED sequencing surface dropped: the host's per-node exnref admission walk
collapses to per-activation tag seeding + a module-internal re-check.

ABI-NEUTRAL, no `ABI_VERSION` bump. The new export is a host<->module seeding
call and the drive table binds guest exports by name, so there is no
fork-instrument change and no guest re-instrument. The reinstrument authorization
was not exercised — no needed guest export was ineligible for the drive table.
`scripts/check-abi-version.sh check`: consistent, no new bump.

## Validation (Node; aarch64-apple-darwin; browser owed to the coordinator)

- fork-module wasm rebuilt + re-injected (both widths, build-key `e54705d8…`),
  restaged into `local-binaries` + `host/wasm`. `./run.sh local-build`
  re-finalized the SourceOnly projection. (One gotcha: a manual copy of the new
  wasm into `source-only-v1/` made local-build's byte-currency gate falsely pass,
  skipping the finalizer and leaving the projection manifest's fork-module
  closure key stale; dropping the manual copies and re-running local-build let
  the finalizer re-project + refresh the key.)
- `cargo run -p xtask -- verify-fresh`: exit 0 (CLEAN).
- `scripts/check-abi-version.sh check`: consistent, NO bump.
- `cargo test -p fork-codec` (aarch64): 440 passed / 0 failed (4 new gate tests).
- `cargo test -p host-native --lib` (aarch64): 45 passed / 0 failed / 4 ignored
  (native unaffected — no exnref path).
- Host `npm run build` (tsup + dts): clean.
- Vitest (`--test-timeout=60000`; each fixture cold-boots a kernel ~8–9s):
  - `fork-module-exnref-replay`: 6/6 (3 NEW corrupt-recipe tests through
    `fm_attach_child` — the direct proof of the moved boundary).
  - `fork-capture-session-host-exception`: 4/4.
  - `fork-from-dlopen-side-module-e2e` + `vfork-production-mechanism`: 22/22
    (also covers `fork-continuation`, `fork-module-backend-abort`,
    `fork-module-backend-multi-activation`, `fork-module-gc-replay`,
    `malloc-deep-fork` in the same batch).
  - `fork-instrument-coverage` C-* / K-* / P-* / S-*: 31/31 (D-* filtered for the
    PRE-EXISTING D-01 harness hang unrelated to fm_*/fork_module; C-* is the
    exception-catch floor, S-08 the seal path).
