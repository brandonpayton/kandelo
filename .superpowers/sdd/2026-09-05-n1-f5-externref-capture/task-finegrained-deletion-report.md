# Fine-grained fm_* deletion — TRUE FLOOR (PARTIAL-FLOOR-ARGUED)

Status: PARTIAL-FLOOR-ARGUED. Landed the safe/dead deletions (fm_* 80 -> 78),
fully Node-validated. The remaining reduction toward 8-12 is blocked by a PROVEN
ARCHITECTURAL WALL: `host-native` drives fork through the fine-grained primitives
by design and CANNOT adopt the coarse-drive entries. Argued below with file:line
evidence for the maintainer's go/no-go. Browser leg owed to the coordinator.

Worktree `/Users/brandon/kandelo-abi44-reconcile`, branch
`brandonpayton/rust-first-abi44-reconcile`. Commit `6da756719`, built on
`ced12f71b`. ABI-neutral (no `ABI_VERSION` bump; abi/snapshot.json + shared
untouched).

## Commit

- `6da756719` Fork: Delete dead + unused fine-grained fm_* exports

## What was DELETED (fm_* 80 -> 78, ABI-neutral)

Both are host<->module exports the guest never binds; no wire/artifact contract
touched.

1. `fm_build_rewind_plan` — a superseded intermediate. The coarse
   `fm_parent_replay`/`fm_parent_abort` entries call `build_rewind_plan_impl`
   (the internal fn, RETAINED) directly; the exported wrapper had ZERO callers
   anywhere (no production, native, host-test, or `.mjs`). Pure dead export.
2. `fm_scan_externref_handles` (+ its whole `scan_externref_handles_impl`) — an
   externref-handle graph walk that was never wired into production (the browser
   uses the TypeScript `scanSegmentedForkReferenceExternrefHandles` fallback) and
   had no native caller. Deleting the impl removes the algorithm from the product
   entirely. Its `fm_stats` slot-10 counter (`EXTERNREF_HANDLES_SCANNED`) is
   RETAINED as a frozen stats-field slot so the `FM_STAT_*` indices native and the
   host depend on are not renumbered.

`fork-module-backend.ts` line delta: **0** — neither deleted export had a backend
wrapper (both `bkwrap=0`), so the host TS surface is unchanged.

## Coverage bookkeeping (no gaps introduced)

- `host/test/fork-module-decode-scan-restore.test.ts` — the 3 `fm_scan_externref_
  handles` cases were removed. **MOOT**: they tested the now-deleted module impl;
  the algorithm no longer exists in the product and was never on a production path
  (browser scan is the TS fallback, which keeps its own tests). No coverage gap.
- `host/test/fork-module-drive-shim.test.ts` — **NOT removed / RESTORED**. See the
  `fm_build_trivial_plan` note below.
- No `.mjs` harness case was removed. All three build-time V8 smoke harnesses
  (`harness.mjs`, `harness-multi-activation.mjs`, `harness-capture.mjs`) run
  green against the rebuilt module via `build-wasm.sh --run`.

### fm_build_trivial_plan / fm_trivial_plan_count — RETAINED with a documented reason

These were deleted mid-increment, then RESTORED. They are a test-only plan
builder, but they are the ONLY thing that exercises the injected `fm_drive_execute`
shim's **store-#2 GC-integrity trap** at runtime (`host/test/fork-module-drive-
shim.test.ts`): the load-bearing `table.get`+`ref.is_null` guard that turns a guest
`_gc_allocate` which failed to publish a live GC object into a truthful trap
instead of a silent wrong reconstruction. `fork-module-inject`'s tests are purely
STRUCTURAL (walrus module inspection), so they do not cover this at runtime, and no
other test forces the null-slot fault. This coverage is wasmtime-runnable (the
guard is injected wasm, not V8-specific) and SHOULD migrate to a host-native
wasmtime instantiation test built on `fork_codec::drive_plan`'s public
`trivial_struct_plan` + `serialize_plan` (both already `pub`); once it does, both
exports can be deleted. A retention note is inlined on the export in `lib.rs`.
Flagged as a bounded follow-up rather than dropping a safety-guard regression test
in a Node-only, browser-unvalidatable session.

## THE WALL: why host-native cannot migrate onto the coarse entries

The coarse entries (`fm_parent_replay`, `fm_parent_abort`, `fm_parent_seal_capture`,
`fm_child_reconstruct`, `fm_attach_child`) drive the guest FROM the module via the
walrus-injected `fm_drive_execute` shim, which `call_indirect`s the guest's
`wpk_fork_*` exports through the host-bound `__wpk_fork_drive_table`. They were
purpose-built for the TS host's drive-table model. `host-native` uses a
fundamentally different, wasmtime-native model:

1. **Native wires the module's reference-decode EXPORTS as the GUEST'S IMPORTS.**
   `crates/host-native/src/guest.rs:5554-5580` binds `fm_ref_vector_get`,
   `fm_ref_gc_route`, `fm_ref_gc_payload_len`, `fm_ref_gc_load`, `fm_ref_exn_route`,
   `fm_ref_exn_load`, `fm_ref_exn_cache_index` (and `fm_funcref_ordinal` /
   `fm_static_root_slot` / `fm_externref_handle`) into `env.WPK_FORK_REFERENCE_
   IMPORT_*` / `env.WPK_FORK_EXCEPTION_IMPORT_*`. The GUEST calls these during its
   OWN frame restore. This reference-DECODE plane has NO analog in the coarse-drive
   entries (which drive frame REWIND, not decode). These ~10 exports are an
   irreducible native floor regardless of any coarse entry.

2. **Native drives the guest phase exports DIRECTLY, not through the drive table.**
   It binds ONLY the reference-reconstruction slots (GC ALLOC/FILL/EXN) into
   `__wpk_fork_drive_table` (`guest.rs:6773-6817`) and calls `wpk_fork_rewind_begin`
   by direct `TypedFunc` (`guest.rs:7772`, `guest.rs:7874`). The coarse entries
   require the phase exports (rewind_begin/abort_begin/unwind_end) bound into the
   table — native does not bind them.

3. **Native interleaves wasmtime-native reference materialization BETWEEN begin
   and the rewind drive.** Both the normal and gated-abort parent-replay paths run
   `fm_begin_replay` -> `drive_reference_replay` (transit-table `grow` +
   gated-original restore via wasmtime's `Ref` API + `fm_build_gc_plan` +
   `fm_drive_execute`) -> direct `wpk_fork_rewind_begin` (`guest.rs:7846-7877`;
   gated: `:7617-7776`). The GC objects must be published into store-#2 (the
   `(ref null any)` transit table) BEFORE the guest reads them during rewind. The
   coarse `fm_parent_replay` folds begin+rewind ATOMICALLY with no seam for that
   materialization, so it would rewind before references exist -> wrong value / trap.

4. **Native cannot use `fm_attach_child` at all** — it reconstructs exnref, which
   wasmtime's `Exn`/exnref heap type blocks (documented; native tests assert
   `exnrefs_reconstructed == 0`). This is why the exnref admission gate lives in
   `fm_attach_child` (JS/browser-only) and native was deliberately left off it.

Migrating native onto the coarse entries would be a ground-up rewrite of native's
fork engine to adopt the drive-table model AND to reorder/reshape reference
materialization — a large change that (a) cannot be browser-validated in this
session, (b) risks the green 45-test native battery + the whole fork suite, and
(c) STILL could not delete the ~10 reference-DECODE import exports. Per the task's
own gate ("If native genuinely needs a distinct sequence the coarse entry doesn't
expose, STOP and ARGUE"), this is a floor item, not a forced migration.

`.mjs` harnesses likewise cannot use the coarse entries: they have NO guest
instance and NO drive-table binding (they synthesize frames directly via
`fm_frame_*`), so `call_indirect` drive is impossible. They test module internals
in isolation by construction.

## THE TRUE FLOOR: 78 survivors, per-survivor justification

Legend: (c) native-specific need · (a) genuine runtime primitive no coarse entry
subsumes · (i) module-internal runtime mechanism · FLAG = should-delete, deferred.

### Native reference-decode import plane — (c), irreducible

`fm_ref_vector_get`, `fm_ref_gc_route`, `fm_ref_gc_payload_len`, `fm_ref_gc_load`,
`fm_ref_exn_route`, `fm_ref_exn_load`, `fm_ref_exn_cache_index`,
`fm_funcref_ordinal`, `fm_static_root_slot`, `fm_externref_handle` (10). The guest's
own frame-restore imports on native (guest.rs:5554-5580). No coarse analog.

### Per-worker / per-activation SEEDERS — (c)+(a)

`fm_set_format`, `fm_set_resume_catalog`, `fm_set_activation_gc_codec`,
`fm_set_activation_catalog_base`, `fm_set_activation_static_root_base`,
`fm_set_host_exception_owner` (native + TS), plus `fm_set_activation_resume_catalog`,
`fm_set_activation_exception_tags` (TS reconstruction/gate seeding). The coarse
entries fold DRIVE loops, never seeding.

### Phase begin/finish — (c)+(a)

`fm_begin_replay`, `fm_begin_child_replay`, `fm_begin_reference_replay`,
`fm_begin_unwind`, `fm_finish_replay`, `fm_finish_unwind` — native drives these as
discrete steps around its interleaved reference materialization; TS production also
still calls the SEED/FINISH halves (the coarse entries fold only the guest drive
loop, not begin/finish). `fm_begin_borrowed_child_replay`,
`fm_add_activation_child_replay`, `fm_add_activation_borrowed_child_replay`,
`fm_add_activation_unwind` — TS-production child/vfork/capture SEED (fork-process-
continuation.ts:924-940, 1125-1142, 621-622). `fm_begin_abort`, `fm_finish_abort`,
`fm_abort` — the partial-capture ABORT path, kept deliberately DISTINCT from the
seal fold to avoid the mid-unwind `wpk_fork_unwind_end` trap.

### Plan build / drive-table / serialize / introspection — (c)+(a)+(i)

`fm_build_gc_plan`, `fm_gc_plan_count`, `fm_drive_table_base` (native + TS reference
reconstruction), `fm_serialize_journal_alloc`, `fm_journal_image_len` (native + TS
KFRE image), `fm_last_errno`, `fm_stats` (introspection), `fm_drive_bump` (the
injected shim `call`s it once per drive step — module-internal runtime counter).

### Coarse control-flow-inversion entries — (a), the products of this campaign

`fm_parent_replay`, `fm_parent_abort`, `fm_parent_seal_capture`,
`fm_child_reconstruct` — TS host fork drive (fork-process-continuation.ts).

### Reconstruction / decoded-graph readout — (a)

`fm_attach_child`, `fm_attach_borrowed_child`, `fm_restore_from_arena`,
`fm_decode_reference_graph`, `fm_decoded_node_count`, `fm_decoded_node_kind`,
`fm_decoded_node_module_activation`, `fm_decoded_node_ordinal` — the browser child
reconstruction + exnref-tag gate + static-root mirror seeding.

### Reference CAPTURE session — (a)

`fm_capture_begin`, `fm_capture_intern_funcref`, `fm_capture_intern_externref`,
`fm_capture_intern_i31`, `fm_capture_intern_static_root`, `fm_capture_claim_gc`,
`fm_capture_gated_placeholder`, `fm_capture_define_gc`, `fm_capture_begin_vector`,
`fm_capture_append_vector`, `fm_capture_finish_vector`, `fm_capture_vector_get`,
`fm_capture_validate`, `fm_capture_serialize`, `fm_capture_serialized_len`,
`fm_capture_record_header_size`, `fm_capture_interned` (17). Called by the browser
reference-capture wrapper `host/src/fork-reference-capture-module.ts`.

### Frame writer — (a)

`fm_frame_reserve`, `fm_frame_commit`, `fm_frame_peek`, `fm_frame_next`,
`fm_resume_peek` — the guest's per-activation frame allocator/writer, driven during
capture unwind (host/src + native).

### Test-retained — flagged for wasmtime migration

`fm_build_trivial_plan`, `fm_trivial_plan_count` (2) — see coverage note above. NOT
justified by "a .mjs tests it": they enable the sole runtime regression of the
injected shim's store-#2 integrity trap (wasmtime-runnable; migration flagged).

### JS-harness-only — (FLAG) should-delete, deferred

`fm_begin_unwind_fixed_arena`, `fm_add_activation_unwind_fixed_arena`,
`fm_serialize_journal_fixed_arena` (3) — the "in-realm, no-servicer" siblings of the
channel-based unwind/serialize, used ONLY by the `.mjs` build-time harnesses +
`fork-module-trampoline.test.ts`. No production or native caller. Per the sharpened
criterion these are NOT validly retained. Deletion DEFERRED: it requires retiring or
rewiring the three V8 build-time smoke harnesses' entire unwind driver onto the
channel path (a mock servicer in Node), which balloons well beyond this increment.
FLAGGED as the next concrete reduction. The V8 co-residency/PIC-placement coverage
those harnesses provide is itself wasmtime-coverable (native does real forks), so
the harnesses are candidates for retirement in favor of native tests.

## Why 8-12 is not reachable without a native rewrite

The 8-12 target assumed both remaining consumers could adopt the coarse entries.
They cannot: native is a second, complete fork engine that uses the fine-grained
primitives as its actual API (reference-decode import plane + interleaved
wasmtime-native materialization + direct guest phase calls), and TS production
still calls the SEED/FINISH/ABORT/CAPTURE/RECONSTRUCTION primitives the coarse
entries never subsumed (they fold only guest DRIVE loops). The realistic floor is
dominated by native (~29) + the TS-production runtime API. Pushing below ~75
requires either (1) rewriting host-native onto the drive-table model — large,
browser-unvalidatable here, and still leaves the ~10 decode-import exports — or
(2) retiring the JS harnesses + migrating the trivial-plan/scan/fixed-arena test
coverage into Rust wasmtime tests (the flagged follow-ups, worth ~5 exports).

## Validation (Node; aarch64-apple-darwin; browser owed to the coordinator)

All run against the clean `6da756719` tree.

- fork-module wasm rebuilt + re-injected both widths (build-key `9f0e8e70…`),
  restaged into local-binaries + host/wasm; `./run.sh local-build` reprojected
  SourceOnly (98/98 cache hits); `xtask verify-fresh`: CLEAN (no stale).
- `scripts/check-abi-version.sh check`: snapshot in sync, ABI_VERSION consistent,
  NO new bump. `git status` shows abi/ + crates/shared untouched.
- `cargo test -p fork-codec --target aarch64-apple-darwin`: 440 passed / 0 failed.
- `cargo test -p host-native --lib --target aarch64-apple-darwin`: 45 passed /
  0 failed / 4 ignored (the KEY native signal — native unaffected by the deletions).
- `cargo build -p fork-module` (via build-wasm.sh): clean (only pre-existing xtask
  warnings).
- `host` `npm run build` (tsup + dts): clean.
- `.mjs` build-time harnesses (harness / multi-activation / capture): all pass.
- Vitest (`--testTimeout=60000` where kernel-booting):
  - `fork-module-decode-scan-restore` + `fork-module-drive-shim` +
    `fork-module-backend-abort` + `fork-module-backend-multi-activation`: 10/10.
  - `fork-continuation` + `vfork-production-mechanism` +
    `fork-from-dlopen-side-module-e2e` + `fork-module-gc-replay` +
    `fork-module-exnref-replay` + `malloc-deep-fork`: 24/24.
  - `fork-instrument-coverage` P-*/C-*/S-*/K-*: 31 passed / 20 skipped (D-*
    excluded for the PRE-EXISTING D-01 harness hang unrelated to fm_*).

## STOP-AND-ARGUE (maintainer go/no-go)

The native migration (step 2) is a floor, not a forced task. Deferring per the
"deferrals are the maintainer's call" discipline, with the file:line argument above.
Recommendation: accept the 80->78 reduction now; take the JS-harness retirement +
trivial-plan/fixed-arena wasmtime-test migration as a separate bounded increment
(~5 more exports, needs new host-native wasmtime instantiation tests); treat a
host-native drive-table rewrite as its own major, browser-validated effort if the
maintainer wants to reclaim the native seed/phase exports.
