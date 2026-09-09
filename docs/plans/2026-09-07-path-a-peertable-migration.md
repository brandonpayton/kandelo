# Path A — peer-table migration + kernel externref-scan re-home (plan of record)

**Date:** 2026-09-07
**Worktree:** `/Users/brandon/kandelo-abi44-reconcile`
**Branch:** `brandonpayton/rust-first-abi44-reconcile`
**HEAD verified:** `3000e52573` (the detach report was written at
`215e96923`; the branch has advanced and one of that report's load-bearing
claims is now stale — see §2).
**Status:** grounding + sizing pass. READ-ONLY except this doc. No source
edited, no build run, no cross-host validation run.

**Companion inputs (read + reconciled against code at HEAD):**
`.superpowers/sdd/2026-09-05-n1-f5-externref-capture/task-cohesive-detach-report.md`
(the two walls), `task-capture-rewire-report.md` (capture already
module-owned), and `docs/plans/2026-09-07-fork-orchestration-migration.md`
(the Path-B flip plan). Path A is the sub-project that makes
`fork-activation-registry.ts` + `fork-reference-transaction.ts` deletable by
migrating their two production NON-FORK consumers (peer-table replication and
the kernel externref scan), so the Path-B delete step (P6) can actually run.

---

## 0. What this doc settles

The detach report identified two walls that keep the JS reference engine
load-bearing regardless of fork work:

- **Wall 1** — `DylinkForkTableReplica` peer-table replication
  (`captureTableState` / `restoreTableState` / `applyFuncrefTablePatch` /
  `captureFuncrefTablePatch`) drives the JS `ForkReferenceTransaction` with no
  module path.
- **Wall 2** — the kernel-worker externref-handle scan
  (`scanSegmentedForkReferenceExternrefHandles` +
  `FORK_REFERENCE_TRANSACTION_OWNER_ID`) in `fork-externref-process-owner.ts`.

This doc verifies both against code, **corrects a now-stale premise in the
detach report** (the peer-table restore's "opens a fork externref generation"
gap no longer exists — §2), produces the reuse map the user asked for (§3),
fixes the minimal new module surface (§4), gives the Wall-2 re-home verdict
(§5), and sequences increments **A1..A6** with size/risk/deps and an honest
Path-A-vs-Path-B total (§6–§8).

---

## 1. The two consumers, verified at HEAD

### Wall 1 — `DylinkForkTableReplica` and what drives it

`DylinkForkTableReplica` (`host/src/dylink-fork-archive.ts:112`) is a
per-Worker generation gate for dlopen/dynamic-linking. When a peer Worker
(pthread or fork child) `dlopen`s a side module, the loader publishes the new
funcref/loader table state into a shared-memory dylink archive
(`DylinkForkArchive`, `dylink-fork-archive.ts:399`) as a monotonic
**generation**. Every other Worker must catch its own instance-local funcref
table up to that generation **without a function object ever crossing the
Worker boundary** — each Worker re-materializes the recipes into its own table.
That is the "table state must be replicated across workers" driver.

The replica is constructed in per-process setup at
`worker-main.ts:2966`, inside `createProcessTableReplicationOwner`
(`worker-main.ts:2935`), on the **same** `activationRegistry` the fork path
uses (`options.registry`, typed `ForkActivationRegistry`,
`worker-main.ts:2937`). Its production calls into the registry:

- `worker-main.ts:2985` `options.registry.restoreTableState(arena)` — apply a
  peer's full typed table checkpoint (inside the replica `materialize`
  callback, `:2968-2994`).
- `worker-main.ts:2991` `options.registry.applyFuncrefTablePatch(patch)` —
  apply an incremental funcref-range patch.
- `worker-main.ts:3031` `options.registry.captureTableState(arena)` — publish
  this Worker's full typed table checkpoint (`publishLocked`, `:3026`).
- `worker-main.ts:3121` `options.registry.captureFuncrefTablePatch(...)` —
  emit an incremental funcref patch (`commit`, `:3106`).

The `applyFuncrefTablePatch` (`fork-activation-registry.ts:1010`) /
`captureFuncrefTablePatch` (`:921`) pair is the **funcref-only fast path** — it
does not touch the JS reference engine and is not part of the deletable
surface. The engine dependency is the two full-checkpoint methods:

- **`captureTableState`** (`fork-activation-registry.ts:1527`): constructs
  `new ForkReferenceTransaction(...)` at `:1537` with **nine** constructor
  args — it deliberately does **not** pass `this.captureModule` (contrast the
  fork `beginCapture` at `:1485`, which passes it as the tenth arg). So peer
  capture forces the **pure-JS** graph. It then loops guest
  `activation.moduleState.saveTables(id)` (`:1561`), `references.sealInto(arena)`
  (`:1563`), `arena.seal()`.
- **`restoreTableState`** (`fork-activation-registry.ts:1578`): constructs the
  same 9-arg JS transaction (`:1609`), `references.attachChild(records)`
  (`:1620`), then **`references.materializeAllTyped()`** at `:1626` — **no
  `moduleDrive` argument**, i.e. the full JS PHASE-A/B + topological
  allocate/fill/cycle reconstruction (`fork-reference-transaction.ts:1916`,
  the JS reconstruction body below `:1966`). Then loops guest
  `activation.moduleState.restoreTables(id)` (`:1628`) and
  `references.finishReplay()` (`:1630`).

`saveTables` / `restoreTables` are uniform guest exports the **host calls
directly** (`fork-activation-registry.ts:158-160` interface; `:344-351`
resolve `FORK_MODULE_TABLE_STATE_SAVE_EXPORT` /
`FORK_MODULE_TABLE_STATE_RESTORE_EXPORT`; `:371-372` bind them). They are
**not** drive-table ops and there is no `finishRestoreTables` — table install
is single-phase.

### Wall 2 — the kernel-worker externref scan

`ForkExternrefProcessOwner.forkGenerationFromContinuation`
(`host/src/fork-externref-process-owner.ts:74-141`) runs in the **kernel
worker** and computes the externref-handle grant a fresh fork child will
inherit, **before** the child process worker is launched. It:

1. reads the copied continuation's module-state root from the blocked parent's
   memory (`:89`),
2. builds a **read-only** arena view (allocation callbacks deliberately throw,
   `:106-112`) and `inspectSealedRecordViews(...)` for the reference-recipe
   record kinds (`:114-120`),
3. `scanSegmentedForkReferenceExternrefHandles(records,
   FORK_REFERENCE_TRANSACTION_OWNER_ID)` (`:121-124`) — a pure wire-bytes scan
   that returns the set of distinct externref broker handles the continuation
   names,
4. `broker.acquireFork(parent, child, handles)` (`:128`) to lease exactly those
   handles to the child generation.

It is called from `node-kernel-worker-entry.ts:1997` and `:2379`, and from
`browser-kernel-worker-entry.ts:2174` and `:2569` — **both hosts**, via the
shared `fork-externref-process-owner.ts` import.

Its two deletable-file imports:
- `scanSegmentedForkReferenceExternrefHandles` from `fork-reference-segments.ts`
  (`fork-externref-process-owner.ts:14`, scan defined
  `fork-reference-segments.ts:1109`),
- `FORK_REFERENCE_TRANSACTION_OWNER_ID` from `fork-reference-transaction.ts`
  (`:11`, defined `fork-reference-transaction.ts:61`, derived from the ABI
  constant `WPK_FORK_REFERENCE_TRANSACTION_OWNER` = `1`,
  `host/src/generated/abi.ts:161`).

**The kernel worker holds fork_module BYTES but no INSTANCE.**
`forkModuleInitFields` (`node-kernel-worker-entry.ts:177-187`) compiles the
`fork_module32/64.wasm` into a `WebAssembly.Module` and **ships it** to the
process worker in the init fields; it never instantiates it. So
`fm_scan_externref_handles` (which reads a resident decoded graph inside an
**instantiated** module and writes that module's guest memory,
`crates/fork-module/src/lib.rs:2494`) is **unreachable** from the kernel
worker. This is why Path-B INC-C's "route the scan to the module" is
architecturally unsound for the kernel side (detach report Wall 2 —
confirmed).

---

## 2. CORRECTION: the peer-table restore's "opens a generation" gap is STALE

The detach report's Wall-1 enumeration says the fork exports are wrong for a
peer table snapshot because "`fm_restore_from_arena(root, pid)` opens a fork
externref **root generation** (`begin_generation(pid)`), which is fork-identity
semantics, wrong for an in-place peer table snapshot." **At HEAD `3000e52573`
that is no longer true.** The M2 externref host-generation seam has retired:

- `crates/fork-module/src/lib.rs:2325-2328`: "`pid` … is retained in the export
  signature for the host call site's contract, but M2 no longer opens a host
  root generation scoped by it — the externref host seam retired … so it is
  unused inside this impl."
- `begin_reference_replay_impl(module_state_root: u64, _pid: u32)`
  (`:2374`) — `pid` is `_pid`, unused.
- `:2443-2446`: the externref bookkeeping pass "is now a host-free pass over the
  decoded graph — it calls no `wpk_fork_host` import and opens no host
  generation (that seam retired)."
- `restore_from_arena_impl` (`:2545`) = `begin_reference_replay_impl` +
  `build_gc_plan_impl`; both generation-free.

Consequence: the module reconstruction entries (`fm_restore_from_arena`,
`fm_attach_child`) are **already generation-free, table-neutral reference
reconstruction**. The only genuine fork-vs-table differences that remain are
(a) which guest export the install drives (`restore`+`finishRestore` vs
`restoreTables`) and (b) the capture-side guest export (`save` vs `saveTables`)
— both of which are host-side direct guest calls, not module internals. This
is what makes Path A far smaller than the detach report implied.

---

## 3. REUSE MAP — how much capture↔replay infra is reusable for a table snapshot

A peer table snapshot is a **same-process, same-generation, in-place** copy of
the cumulative typed table state. Its wire graph carries exactly the reference
kinds fork already handles: funcref, externref, i31, static-root, GC
(struct/array), exnref, and reference vectors (`captureTableState` doc,
`fork-activation-registry.ts:1519-1526`). So the capture↔replay engine is the
same engine; only the guest export the host drives differs.

### Reusable AS-IS (no new Rust)

| Concern | Existing Rust / export | Location |
|---|---|---|
| Capture graph build (intern funcref/externref/i31/static-root, claim/define GC, vector begin/append/finish, dedup, cycle-close) | `reference_graph_builder.rs` `intern_*` / `claim_gc` / `define_gc` / `begin_vector` / `append_vector` / `finish_vector` / `validate` | `crates/fork-codec/src/reference_graph_builder.rs:140-344` |
| Capture graph exports (the host-facing surface) | `fm_capture_begin` / `fm_capture_intern_*` / `fm_capture_claim_gc` / `fm_capture_gated_placeholder` / `fm_capture_define_gc` / `fm_capture_begin_vector`/`append_vector`/`finish_vector` / `fm_capture_vector_get` / `fm_capture_validate` | `crates/fork-module/src/lib.rs:3945-4234` |
| Wire serialization of the captured graph | `fm_capture_serialize` / `fm_capture_serialized_len` / `fm_capture_record_header_size` | `crates/fork-module/src/lib.rs:4234-4294` |
| Wire-graph decode | `fm_decode_reference_graph` / `fm_decoded_node_count` (decode impl `decode_reference_transaction_from_arena`) | `crates/fork-module/src/lib.rs:4317-4355`, `:2342-2372` |
| Externref-handle scan (process-worker side) | `fm_scan_externref_handles` | `crates/fork-module/src/lib.rs:4362`, impl `:2494` |
| Reference reconstruction (generation-free): seed driver/feed + build the topological drive plan (Phase 0 static-root, Phase 0b externref transit, Phase 3-5 alloc/fill/cycle) | `fm_restore_from_arena` = `fm_begin_reference_replay` + `fm_build_gc_plan`; drive via `fm_drive_execute` | `crates/fork-module/src/lib.rs:4386`, `:2545`, `drive_plan.rs::build_drive_plan:453` |
| Host backend wrappers already wired for the fork child | `restoreFromArena` / `driveRestoredPlan` (transit sizing via `prepareTransit` floor) | `host/src/fork-module-backend.ts:331`, `:388` |

The wire codec (`reference_segments.rs` / `reference_segments_writer.rs` /
`reference_recipes.rs`), the replay/drive engine (`drive_plan.rs`,
`reference_replay.rs`, `reference_feed.rs`), and the GC/exn codecs
(`gc_codec.rs`, `exception_codec.rs`) are **all** consumed by the exports above.
No table-specific variant of any of them is needed — the wire format is the
same frozen format.

### Intrinsically fork-generation-specific (NOT reused; and NOT needed)

- The child-install drive tail `append_attach_steps` (`drive_plan.rs:577`,
  `DRIVE_OP_RESTORE`=5 / `DRIVE_OP_FINISH_RESTORE`=6, `:109-116`) drives the
  guest `wpk_fork_module_state_restore` / `finish_restore` two-phase install.
  A table snapshot drives the single-phase `restoreTables` guest export
  instead — but that guest call is a **host-side direct call**
  (`fork-activation-registry.ts:1628`), not a drive-table op, so no
  `append_attach_steps` analogue is required in the host-loop design (§4).

### Net reuse verdict

**~100% of the proven capture↔replay engine is reusable with zero new Rust**,
because the fork-vs-table difference is entirely in which guest export the host
calls (`saveTables`/`restoreTables` vs `save`/`restore`/`finishRestore`), and
those are already host-driven direct guest calls. The migration is a **host-TS
re-home**: point the peer-table capture/restore at the same module capture +
module reconstruction the fork child already uses, and keep the
`saveTables`/`restoreTables` guest loop on the host.

---

## 4. Minimal new module surface for table snapshots

**Primary design (recommended): ZERO new `fm_*` exports.** A new **staying**
host glue file (`host/src/fork-table-snapshot.ts`, a `fork-module-*.ts`-class
file) owns the peer-table capture and restore lifecycles by reusing the
existing module surface:

- **Capture** (`captureTableState` replacement): construct the capture against
  the module (pass the existing `this.captureModule` so encode imports route to
  `fm_capture_*`), loop guest `saveTables(id)`, then seal via
  `fm_capture_serialize` into the arena — the identical sequence the fork
  `beginCapture`/`sealCapture` path already runs on the module, minus frame
  unwind. **Runtime-confirm** that the guest encode imports dispatch to the
  currently-active capture (they read `this.references` set by `beginCapture`,
  `fork-activation-registry.ts:1497-1499`) so passing `captureModule` is
  sufficient — this is the one claim I could not verify purely statically.
- **Restore** (`restoreTableState` replacement): `fm_restore_from_arena(root)`
  to seed + build the drive plan (generation-free, §2), `prepareTransit` +
  `fm_drive_execute` to reconstruct references into the anyref transit (STORE
  #2), then loop guest `restoreTables(id)`, then release transient roots. This
  is `driveRestoredPlan` (`fork-module-backend.ts:388`) with a `restoreTables`
  loop substituted for the fork child's module-driven restore/finish tail.

This design leaves `fm_attach_child`'s restore/finish tail untouched and needs
**no** `DRIVE_OP_RESTORE_TABLES`, because single-phase `restoreTables` has no
interleaving-with-reconstruction requirement (unlike the fork
restore→finishRestore two-phase, which exists to keep passive segments intact
across typed reconstruction).

**Alternative (fuller, if the user wants the module to own the table-install
order too — minimize-host-surface north star):** add one `DRIVE_OP_RESTORE_TABLES`
op (`drive_plan.rs`), a `append_attach_table_steps` (mirrors
`append_attach_steps:577`), and one `fm_attach_table_snapshot` export
(mirrors `fm_attach_child:4408`). This is a **small, additive, ABI-considered**
Rust increment (new export ⇒ `fork_module` rebuild + snapshot check; see §7 ABI
note). Prefer the zero-Rust host-loop design unless the user explicitly wants
table-install order in Rust.

---

## 5. Wall-2 re-home verdict

**Re-home the JS wire scan into a staying glue file; do NOT route it to
`fm_scan_externref_handles`, and do NOT instantiate a fork_module in the kernel
worker.** Grounding: the scan runs pre-launch in the kernel worker, which holds
only compiled `WebAssembly.Module` bytes (`node-kernel-worker-entry.ts:177-187`),
not an instance; `fm_scan_externref_handles` requires a resident decoded graph
inside an instantiated module (`lib.rs:2494`). Instantiating a throwaway
fork_module in the lean kernel worker to scan raw bytes would violate the
host-runtime "kernel worker stays a proxy, not the engine" contract and add
externref-table/host-cap wiring for a pure byte scan.

**What the scan needs (all pure wire-parse, no live refs, no reconstruction):**
`scanSegmentedForkReferenceExternrefHandles`
(`fork-reference-segments.ts:1109`) →
`parseSegmentedForkReferenceTransaction` (`:1128`), `validateReferenceSemantics`
(`:1414`) / `validateNodeSemantics` (`:1421`), `requiredSection` (`:1795`),
`decodeManifest` (`:1250`), `decodeSegment` (`:1348`), `decodeHandle` (`:1781`),
plus `ReferenceSection.Nodes`, `FORK_REFERENCE_NODE_RECORD_SIZE`,
`WireNodeKind.Externref` and the recipe-node types from
`fork-reference-recipes.ts`.

`fork-reference-segments.ts` imports only `fork-module-state` (staying),
`fork-reference-recipes` (types+values), and `generated/abi` (staying);
`fork-reference-recipes.ts` imports `fork-function-catalog` /
`fork-reference-broker` / `fork-static-root-catalog`, which the attach-exports
ruling already reclassified as **floor/staying**. So the scan's transitive deps
already land mostly on staying files.

**Two re-home options:**
- **(A5-min) Reclassify `fork-reference-segments.ts` + `fork-reference-recipes.ts`
  as STAYING** (drop them from the Path-B P6 delete list). Lowest risk; keeps
  encode/graph-materialize/vector code that is dead on the module path.
- **(A5-full) Extract the parse+scan subset** into a new staying
  `host/src/fork-reference-wire.ts` (the parse/validate/section/handle/node-type
  subset + the `FORK_REFERENCE_TRANSACTION_OWNER_ID` /
  `FORK_HOST_EXCEPTION_ACTIVATION_ID` constants), letting the encode / graph /
  vector / recipe-coordinator remainder be deleted with the JS engine. Wider but
  mechanical.

The constant re-home is trivial either way: `FORK_REFERENCE_TRANSACTION_OWNER_ID`
is just the ABI constant (`abi.ts:161`), so the staying file imports it from
`generated/abi` directly rather than from `fork-reference-transaction.ts`.

---

## 6. Increments A1..A6

### A1 — kernel externref-scan re-home  *(host glue; NOT Rust-bearing)*
- **Goal.** Move `scanSegmentedForkReferenceExternrefHandles` + the two leaf
  constants out of the deletable engine files into staying glue so
  `fork-externref-process-owner.ts` (a STAY file on both hosts) no longer
  imports from `fork-reference-segments.ts` / `fork-reference-transaction.ts`.
- **Files.** New `host/src/fork-reference-wire.ts` (A5-full) **or** reclassify
  `fork-reference-segments.ts` + `fork-reference-recipes.ts` as staying
  (A5-min); update `fork-externref-process-owner.ts:11-15` imports.
- **Reuse vs new.** No Rust. Pure TS extraction/reclassification of the existing
  parser (§5).
- **Host wiring.** Both `node-kernel-worker-entry.ts` and
  `browser-kernel-worker-entry.ts` reach it transitively via
  `fork-externref-process-owner.ts` — parity is automatic (shared file).
- **Validation.** `tsc` clean; `fork-from-dlopen-side-module-e2e.test.ts` +
  `borrowed-fork-replay` (the scan feeds the child externref grant);
  Node Vitest fork externref suites; browser `borrowed-fork-replay.spec.ts`.
- **Size.** S (A5-min) / S-M (A5-full). **Risk.** Low. **Deps.** none — do first
  so it stops blocking the delete step independently of Wall 1.

### A2 — finish the fork reconstruction + capture severance  *(host glue; NOT Rust-bearing)*
- **Goal.** Complete the fork-path host-TS severance the capture-rewire and
  detach reports found ready: source the transit-size node count from
  `fm_decoded_node_count` / `fm_decode_reference_graph` (drop
  `materializeAllTyped`'s JS-node-length dependency); re-home the capture floor
  (funcref/static-root catalog reads, externref provenance + handle mint, STORE
  #2 publish, `capturedValues` round-trip, dedup maps) into a staying
  `fork-capture-session.ts`; extract the shared scratch/linear-memory infra out
  of `ForkReferenceTransaction`. This is Path-B INC-A/INC-B host-side work; it
  does not touch Walls 1/2 but is a prerequisite for the engine files reaching
  test-only imports.
- **Files.** `fork-activation-registry.ts` (`beginCapture:1473`,
  `restoreModuleState:1719`), `fork-reference-transaction.ts`,
  `fork-process-continuation.ts`, new `fork-capture-session.ts`.
- **Reuse vs new.** No new Rust — the module already owns the capture graph
  (`fm_capture_*`) and generation-free reconstruction (`fm_restore_from_arena`);
  this is the host re-home of the genuine externref-identity **floor**.
- **Host wiring.** V8 encode/decode imports already flipped to the module on the
  module path; this removes the JS container around them.
- **Validation.** the reference-kind fresh-worker suites (funcref / externref /
  externref-gated / gc-state / gc-cycle / static-root-local /
  static-root-bare-local / exnref-local), capture + gate + abort +
  continuation + vfork; `cargo test -p fork-codec` / `-p fork-module`;
  `host-native`.
- **Size.** M-L. **Risk.** **High** — the atomic, no-fallback externref-identity
  seam (see §7 highest-risk call). **Deps.** none (parallel to A1).

### A3 — author the table-snapshot host glue over the reused module surface  *(host glue; Rust only if fuller variant)*
- **Goal.** Implement §4: a staying `fork-table-snapshot.ts` that performs
  peer-table capture (module `fm_capture_*` + guest `saveTables` + serialize)
  and restore (`fm_restore_from_arena` + `prepareTransit`/`fm_drive_execute` +
  guest `restoreTables`) with **zero** dependency on `ForkReferenceTransaction`.
- **Files.** new `host/src/fork-table-snapshot.ts`; `fork-module-backend.ts`
  (reuse `restoreFromArena`/`driveRestoredPlan`, add a `captureTables`/
  `restoreTables` wrapper if needed).
- **Reuse vs new.** Reused: `fm_capture_*`, `fm_capture_serialize`,
  `fm_restore_from_arena`, `fm_drive_execute`, backend `restoreFromArena` /
  `driveRestoredPlan`. New Rust: **zero** for the recommended host-loop design;
  the fuller variant adds `DRIVE_OP_RESTORE_TABLES` + `append_attach_table_steps`
  + `fm_attach_table_snapshot` (small, additive, ABI-considered).
- **Host wiring.** Node + browser identical (shared file); the guest table
  exports already resolve on both.
- **Validation.** a new host test that exercises the REAL engine table
  round-trip (see §8 — the existing `process-table-replication.test.ts` mocks
  the engine and would not catch a regression here); `cargo test` if the fuller
  variant.
- **Size.** M. **Risk.** Medium — first table snapshot through the module;
  externrefs/GC in a table snapshot must reconstruct in-place against the
  current generation. **Deps.** A2 (shares the capture-session floor + confirms
  the encode-import dispatch assumption).

### A4 — rewire `DylinkForkTableReplica` / the replication owner to the module glue  *(host glue; NOT Rust-bearing)*
- **Goal.** Point `createProcessTableReplicationOwner`'s
  `captureTableState` (`worker-main.ts:3031`) and `restoreTableState`
  (`:2985`) at `fork-table-snapshot.ts` instead of the registry's JS-engine
  methods; leave the funcref-patch fast path (`applyFuncrefTablePatch:2991` /
  `captureFuncrefTablePatch:3121`) unchanged (it never used the engine).
- **Files.** `worker-main.ts:2935-3160`; remove
  `captureTableState`/`restoreTableState` (and their 9-arg
  `ForkReferenceTransaction` constructions, `fork-activation-registry.ts:1527`,
  `:1578`) from the registry.
- **Reuse vs new.** No Rust.
- **Host wiring.** Node + browser share `worker-main.ts`.
- **Validation.** `process-table-replication.test.ts` (orchestration) **plus**
  real dlopen scenarios: `fork-from-dlopen-side-module-e2e.test.ts`,
  `dlopen-main-scope.spec.ts`, `borrowed-fork-replay.spec.ts`,
  `fork-module-multi-activation-funcref-replay.test.ts`; `./run.sh browser`
  with a dlopen demo.
- **Size.** M. **Risk.** Medium-High — this is the increment where a real
  cross-worker dlopen table replication runs entirely through the module
  (§7 dlopen-complexity flags). **Deps.** A3.

### A5 — delete the JS engine files  *(deletion only)*
- **Goal.** Once A1-A4 leave them imported only by tests, delete
  `fork-activation-registry.ts`, `fork-reference-transaction.ts`, and (A5-full)
  the encode/graph/vector remainder of `fork-reference-segments.ts` /
  `fork-reference-recipes.ts`; keep the extracted staying wire/capture-session
  glue. If A5-min was chosen for Wall 2, `segments`/`recipes` stay and only the
  registry + transaction (and their tests) are deleted.
- **Files.** the engine files + their test-only importers.
- **Validation.** `tsc` clean; no import of a deleted symbol; the code is
  physically gone.
- **Size.** M (wide but mechanical). **Risk.** Low once A1-A4 green.
  **Deps.** A1+A2+A3+A4.

### A6 — cross-host + dlopen validation gate  *(validation)*
- **Goal.** The single heavy validation: one `fork_module32/64.wasm` rebuild +
  `verify-fresh` (only if the A3-fuller variant added an export; the host-loop
  design needs no rebuild), then Node Vitest full + browser Playwright
  (`./run.sh browser` exercising both a **fork** and a **dlopen/table-replication**
  scenario, module-on default) + libc/posix/sortix conformance + `host-native`,
  on the same `kernel.wasm` + `fork_module*.wasm`.
- **Validation.** all of the above; specifically the browser dlopen/table
  path, which has the least CI coverage today.
- **Size.** M. **Risk.** Medium (first cross-host module-on table replication).
  **Deps.** A5.

### Sequence / critical path

```
A1 kernel-scan re-home        (host glue, independent)  ─┐
A2 finish fork severance      (host glue, HIGH risk)    ─┤→ A3 table-snapshot glue → A4 rewire replica → A5 delete → A6 cross-host+dlopen
                                                          (A2 shares the capture floor A3 reuses)
```

A1 and A2 are independent and can land in either order; A3 depends on A2 (shared
capture-session floor + the encode-dispatch confirmation); A4 on A3; A5 on
A1+A2+A3+A4; A6 last.

---

## 7. Highest-risk increment, ABI, and dlopen-complexity flags

- **True highest-risk increment: A2** — the fork capture-session floor
  extraction at the V8 externref-identity seam, atomic per capture instance
  with no JS fallback (capture-rewire report §"Why finishing it is bigger than
  one sound pass"; `fork-reference-transaction.ts` is 2721 lines, all
  reference-identity). A4 is the second-highest (first real cross-worker dlopen
  table replication through the module).
- **ABI.** The recommended A3 host-loop design adds **no** export and needs **no**
  `fork_module` rebuild ⇒ no ABI action. The A3-fuller variant
  (`DRIVE_OP_RESTORE_TABLES` + `fm_attach_table_snapshot`) is an **additive**
  export ⇒ `fork_module` rebuild + `check-abi-version.sh`; the wire format is
  unchanged, so it is a snapshot-check-only concern, not an epoch bump — but it
  must be called out and rebuilt once if chosen.
- **dlopen complexity that raises risk (A3/A4/A6):**
  - **funcref-ordinal stability across workers.** The whole point of table
    replication is that each Worker re-materializes recipes into its **own**
    table by `(activation, ordinal)` coordinate; the module reconstruction must
    resolve funcrefs against the same per-activation merged catalog the JS path
    used (`begin_reference_replay_impl` funcref-activation gate,
    `lib.rs:2422-2428`). A multi-activation dlopen worker with an un-seeded
    activation catalog is an `EOPNOTSUPP` that must keep the JS path — verify the
    table glue honors that gate, not a silent slot-0 read.
  - **double-fork / g_spawn and the fork-save buffer** (memory
    `nested-fork-double-fork-gap`): deep dlopen+fork stacks are the known
    overflow class; A6 must include a dlopen-then-fork scenario.
  - **browser dlopen** (`dlopen-main-scope.spec.ts`) is the least-exercised host
    path and the one most likely to surface a first-cross-host module-on
    divergence — it is the load-bearing A6 case.

---

## 8. Honest total size / risk — Path A vs Path B

- **Path A is genuinely small on Rust and moderate on host-TS.** The stale
  "opens a generation" premise (§2) removed the only reason Path A looked like a
  new-Rust project. New Rust for the recommended design is **zero**; the fuller
  variant is one additive drive-op + export. The bulk is host-TS re-home
  (A1-A4) + deletion (A5), reusing the already-landed, native-proven
  `fm_capture_*` + `fm_restore_from_arena` engine.
- **The real cost/risk is concentrated in A2** (the fork capture-session floor
  extraction — the same no-fallback externref-identity seam Path B calls its
  highest-risk increment) and in the **first cross-host module-on dlopen table
  replication** (A4/A6). Neither is dissolved by more analysis; both need the
  single batched cross-host run to discharge.
- **Path A vs Path B relationship.** Path A is **not** an alternative to Path B —
  it is the sub-project that makes Path B's P6 delete step legal by removing the
  two non-fork consumers. A2 here **is** Path-B INC-A/INC-B host-side work; A1
  is Path-B INC-D's constant re-home plus the Wall-2 scan the Path-B INC-C
  wrongly assigned to the module. So Path A's honest total = Path B's remaining
  host-TS severance (A2) + the peer-table-specific glue (A3/A4, small, zero new
  Rust) + the Wall-2 re-home (A1, small) + deletion (A5) + one cross-host gate
  (A6). There is no large hidden Rust port on either path.
- **Validation honesty.** `process-table-replication.test.ts` mocks
  `captureTableState`/`restoreTableState` (`:125-131`) — it proves the patch
  journal / compaction / generation-adoption orchestration, **not** the
  reference engine. A3/A4 therefore REQUIRE a new real-engine table round-trip
  test plus the dlopen e2e + browser dlopen scenarios; the existing unit test
  alone would pass over a broken table-snapshot reconstruction.

### Items needing runtime confirmation (not verifiable read-only)

1. **A3 capture-import dispatch:** that passing `this.captureModule` to the
   table capture routes the guest `saveTables` encode imports to `fm_capture_*`
   (they dispatch through the active `this.references`,
   `fork-activation-registry.ts:1497-1499`). Strongly implied by the two capture
   paths sharing the registry, but confirm before committing A3.
2. **A3 in-place transit reconstruction:** that `fm_restore_from_arena` +
   `fm_drive_execute` reconstructs a table snapshot's externref/GC entries
   correctly against the **current** (same-process) generation's transit
   (STORE #2), with `prepareTransit` sized from `fm_decoded_node_count`. This is
   what the fork child does into a fresh generation; the in-place case needs a
   real run.
3. **A6 browser dlopen table replication:** never run module-on in CI; the A6
   gate is the first real exercise.
