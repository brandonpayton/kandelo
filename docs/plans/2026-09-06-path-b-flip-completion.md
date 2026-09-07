# Path B — complete the fork "flip": route every host through the shared
# Rust reconstruction engine, then delete the TypeScript fork engine

**Date:** 2026-09-06
**Worktree:** `/Users/brandon/kandelo-abi44-reconcile`
**Branch:** `brandonpayton/rust-first-abi44-reconcile` (HEAD `e6e269960`)
**PR:** #1350 (head `brandonpayton/epoll-kernel-route`)
**Status of this doc:** design + sequenced plan-of-record. READ-ONLY analysis;
no source edited.

**Companion inputs:** the flip-readiness audit
`.superpowers/sdd/2026-09-05-n1-f5-externref-capture/task-19-flip-readiness-audit.md`;
the ledger `.superpowers/sdd/2026-09-05-n1-f5-externref-capture/progress.md`;
the campaign plan `docs/plans/2026-09-05-rust-first-campaign-to-completion.md`
(Decision 2a capture↔replay symmetry; B8/F2 flip; M2/M3/M7); and
`docs/fork-reference-support.md`.

---

## 0. Guiding principle (decisive, from the user)

The reconstruction ORCHESTRATION is host-agnostic and belongs in ONE shared
Rust implementation in the module (`crates/fork-codec` + `crates/fork-module`),
called identically by every host. Each host implements ONLY the irreducible
floor. The campaign's empirical probe established that MOST reference
manipulation (funcref, GC struct/array/i31, static-root, exnref, frame/journal)
is Wasm-doable inside the module, and that the floor reduces to essentially ONE
thing: **externref identity** (an internalized externref is not
`ref.eq`-comparable) + **handle→externref materialization** — plus the raw host
API calls to allocate/write reference values and read/write process memory.

**No plan step re-implements in a host any logic that already exists (or can
exist) in shared Rust.** The central empirical result of this analysis is that
the shared Rust engine is already written and tested, so Path B is now
overwhelmingly a *wiring + deletion* job, not a *porting* job.

---

## 1. The two axes people keep conflating

The audit says "NOT READY / flip blocked"; the ledger says "reference-
completeness DONE on all hosts." Both are correct because they measure
different axes:

- **Capture-completeness axis (ledger).** *Does every reference kind
  capture+reconstruct across a fork on every host?* YES. Native 45/45; Node
  37/37 Vitest; docs updated (`docs/fork-reference-support.md:42-97`). One
  intended permanent gate remains on all hosts (an anyref-lineage value with no
  recoverable production-site provenance).
- **Engine-ownership axis (audit).** *On the V8 hosts, does the shared module
  ENGINE replace the JS engine, so the JS can be deleted?* NO. The un-gating
  that closed the capture axis (commit `283b06917`) did so by **reviving the JS
  capture+reconstruction path** on Node/browser — which made the TypeScript
  engine MORE load-bearing, not less.

Path B / the flip lives entirely on the **engine-ownership axis**. The capture
axis is done; it does not by itself make the JS deletable.

---

## 2. Native-gate reconciliation — VERDICT

**Claim under test.** The audit states native still `EOPNOTSUPP`-gates
externref/GC/static-root at `crates/host-native/src/lib.rs:2282-2287`. The
ledger states native GC-array (`cf397703d`) and static-root (`d718f7533`)
capture are DONE and un-gated (tests 43/43·44/44·45/45).

**Verdict: the ledger is correct; the audit misread a STALE DOC COMMENT as a
live gate. Native reconstructs every reference kind at HEAD. The only thing
still `EOPNOTSUPP` on native is the intended permanent boundary (a reference
with no recorded production-site provenance) — identical on all hosts.**

Pinned with code at HEAD `e6e269960`:

- `crates/host-native/src/lib.rs:2270-2287` is **comment text**, the doc block of
  the funcref-only test `smoke_fork_reconstructs_references`
  (`fn` at `:2289`). It narrates N1-I5b history — "externref/typed-GC/static-root
  capture stays gated … this fixture was trimmed to funcref-only so this test
  does not trip the still-unimplemented `encode_externref` gate." The audit's
  line span `:2282-2287` falls inside this comment. It is **not** a live gate.
- The tests that DO exist at HEAD prove full native reconstruction:
  `smoke_fork_externref_reconstructs` (`:2436`), `smoke_fork_gc_struct_reconstructs`
  (`:2496`), `smoke_fork_gc_two_object_cycle` (`:2554`),
  `smoke_fork_gc_array_reconstructs` (`:2614`),
  `smoke_fork_static_root_reconstructs` (`:2676`).
- The ONE remaining native gate is the intended boundary:
  `smoke_fork_gated_externref_parent_survives` (`:2345`) asserts `EOPNOTSUPP`
  (errno 95), NO child spawned, parent survives, `externrefs_resolved == 0`, for
  an externref with no recorded mint-time provenance.
- Native capture is implemented in host Rust: `crates/host-native/src/guest.rs`
  carries `ExternrefProvenance` (`:2428`, `:2474`), `StaticRootProvenance`
  (`:2566`), `GcProvenanceRegistry` (`:2711`), the `resolve_externref`
  handle→`Rooted<ExternRef>` cache (`:2307`) and `define_resolve_externref`
  (`:2984`), plus the soundness gate ("no recorded provenance → `mark_unsupported`
  → clean `EOPNOTSUPP`", `:2461`, `:2505`).

**Which path is native complete on — Rust-host or module?** BOTH, split by
half:

- **CAPTURE (live value → recipe) is the NATIVE HOST path** (`guest.rs`
  provenance registries + the `gc_lookup`/`gc_claim`/`gc_define`/`provenance_*`
  host-import bodies). Capture is host-side on *every* host today; it is never
  module-owned (`lib.rs:2270` comment: "capture is never module-owned"). The
  reason is intrinsic: capture must observe live references *inside the running
  instance* at their production sites, using engine identity primitives.
- **REPLAY / RECONSTRUCTION (recipe → live values, drive-order, frames) is the
  SHARED MODULE path** (`fm_begin_reference_replay` / `fm_build_gc_plan` /
  `fm_drive_execute` in `crates/fork-module/src/lib.rs`, over `crates/fork-codec`).

So native is the reference architecture Path B wants everywhere: **thin
host-side capture bodies feeding recipes into the SHARED replay engine.** There
is no separate "native reconstruction engine"; reconstruction is the shared
module. The docs describing "native still gates" (the audit's Q-notes,
`fork-reference-support.md` history) are stale and should be corrected as part
of this work.

---

## 3. Three-bucket map

Legend: **Rust twin exists** = a host-agnostic implementation is already in
`crates/fork-codec`/`crates/fork-module`.

### Bucket A — ALREADY shared Rust (host-callable), and tested

The full reconstruction/replay engine and the wire codec already live in
`crates/fork-codec` (23 source modules, **437 tests**) and are surfaced by
`crates/fork-module` as Wasm exports. Verified at HEAD:

| Capability | Shared Rust (file:line) | Module export | JS twin it replaces |
|---|---|---|---|
| Recipe model / decode | `fork-codec/src/reference_recipes.rs` | consumed by replay | `fork-reference-recipes.ts` |
| Wire (de)serialization of the reference graph | `fork-codec/src/reference_segments.rs` + `reference_segments_writer.rs` | — | `fork-reference-segments.ts` (`materializeReferenceGraph`) |
| Graph build / capture wire-writer (the capture *inverse*) | `fork-codec/src/reference_graph_builder.rs` — `intern_funcref`(:140), `intern_externref`(:154), `intern_i31`(:168), `intern_static_root`(:182), `claim_gc`(:198), `define_gc`(:215), vector builders(:281-329) | **built + unit-proven; native calls it (`guest.rs:5933` `graph.intern_externref`), but there is NO `fm_*` capture export and NO V8 encode-import flip** | the recipe-emission half of `fork-reference-transaction.ts` |
| Topological drive-order (allocate/fill/identity/cycle) | `fork-codec/src/drive_plan.rs` — `build_drive_plan`(:421), Phase 0b externref-transit widening(:454-476, publishes EVERY `Externref` node); `drive_plan_hints.rs` | `fm_build_gc_plan`(:3509) builds the plan; the `fm_drive_execute` shim strides it (an INJECTED Wasm shim from fork-instrument, NOT a Rust export — calls `fm_drive_bump`/`fm_externref_handle`/`fm_static_root_slot` per step) | `fork-early-reference-provider.ts` (`materializeTypedGraph`:1249) AND `fork-reference-transaction.ts` (`materializeAllTyped`:1456) |
| Reference replay driver | `fork-codec/src/reference_replay.rs`; `reference_transaction.rs` | `fm_begin_reference_replay` | `ForkReferenceTransaction` restore |
| Restore admits ALL kinds (funcref/null/externref/exnref/struct/array/i31/static-root) | `fork-module/src/lib.rs:2240-2262` ("the whole reference kind set the module reconstructs") | `fm_begin_reference_replay` | `restoreModuleState`/`materializeAllTyped` |
| Reference data feed (7 leaf reads) | `fork-codec/src/reference_feed.rs` | `fm_ref_*` exports (`lib.rs:834-861`) | JS reference data provider |
| GC layout codec | `fork-codec/src/gc_codec.rs` | via `fm_build_gc_plan` | `fork-gc-codec.ts` |
| Exception codec (exnref) | `fork-codec/src/exception_codec.rs` | `DRIVE_OP_EXN` | `materializeException` in transaction |
| Funcref / static-root catalogs | `fork-codec/src/catalogs.rs`; imported globals/tables | catalog tables | `fork-function-catalog.ts`, `fork-static-root-catalog.ts` |
| Frame / journal engine | `fork-codec/src/linked_frames.rs` + `linked_frames_writer.rs`; `replay_events.rs`; `replay_journal.rs`; `rewind_driver.rs`; `module_state.rs` | `fm_frames_*`, `fm_begin_replay`(:2898), rewind | `fork-continuation.ts` (`LinkedForkContinuation`), `fork-replay-events.ts` |
| externref production-site provenance instrumentation | `crates/fork-instrument/src/externref_provenance.rs` (commit `f8bb088ed`) | wraps guest mint sites | (capture; no reconstruction twin) |
| GC construction-site provenance | `crates/fork-instrument/src/module_gc_codec.rs` (`struct.get`/`array.get` on UNMODIFIED types; no reindexing, no ABI epoch) | injected codec | `ForkGcProvenanceRegistry` |

**Crate-test coverage.** `fork-codec` 437 tests (drive-plan ordering incl.
Phase 0b, segments round-trip, graph builder, replay). `fork-instrument` ~93
tests incl. the un-ignored Node round-trip
`crates/fork-instrument/tests/module_gc_codec_node.rs::fresh_node_instance_reconstructs_gc_cycle_and_identity`
(cyclic mutable struct + externref-via-anyref + two-generation re-fork, PASS).
`host-native` 45/45 (all reference kinds + the gated boundary + frames + vfork).

**Bucket A size: essentially the ENTIRE reconstruction/replay algorithm + wire
codec + frame engine already exists as shared Rust and is proven end-to-end on
native and in crate tests.** This is the single most important fact for sizing
the rest.

### Bucket B — orchestration STUCK in JS (`host/src/fork-*.ts`)

Deletion target (audit Q1 line counts, spot-consistent at HEAD): the *algorithm*
files total ~12k lines (`fork-activation-registry.ts` 2006,
`fork-reference-transaction.ts` 2238, `fork-reference-recipes.ts` 1316,
`fork-reference-segments.ts` 2131, `fork-continuation.ts` 1040,
`fork-replay-events.ts` 738, `fork-gc-codec.ts` 905, `fork-reference-broker.ts`
680, plus `fork-early-reference-provider.ts`, `fork-static-root-catalog.ts`,
`fork-function-catalog.ts`, `fork-anyref-transit.ts`,
`fork-externref-provenance.ts`, `fork-reference-unsupported.ts`). The
`fork-module-*.ts` glue (`-instance`, `-backend`, `-state`, `-trampoline`,
`-host-capabilities`) is NOT in the deletion target — it is the module-driving
host glue that STAYS (see Bucket C).

Per-piece classification — **(i) wiring only** (Rust twin exists, just not the
sole path), **(ii) must-port to shared Rust** (host-agnostic logic with no Rust
twin), **(iii) actually the host floor** (stays; Bucket C):

| JS piece | file:line | Class | Note |
|---|---|---|---|
| Wire-graph decode `materializeReferenceGraph` | `fork-reference-segments.ts:1562` | **(i)** | Rust twin `reference_segments.rs`; module already consumes decoded graph — flip decode to the module. |
| Versioned recipes | `fork-reference-recipes.ts` (`ForkReferenceRecipeCoordinator:363`) | **(i)** | Rust twin `reference_recipes.rs`. |
| `materializeAllTyped` / `materializeTypedGraph` drive-order + cycle-break | `fork-reference-transaction.ts:1456`; `fork-early-reference-provider.ts:1249` | **(i)** | Rust twin `drive_plan.rs::build_drive_plan` (audit: "a Rust port of the JS `materializeTypedGraph`"). Today invoked only as a *sub-loop delegate* (`fm_build_gc_plan`+`fm_drive_execute`, `worker-main.ts:4835-4873`); wire it as the SOLE drive. |
| `restoreModuleState` → admit + replay | `fork-activation-registry.ts:1703-1718` | **(i)** | Rust twin `fm_begin_reference_replay` admits all kinds (`lib.rs:2240-2262`). |
| `attachChild` orchestration | `fork-activation-registry.ts` (`ForkActivationRegistry:675`) | **(i)** mostly | Sequences replay + frame install; module owns the algorithm. Residue that touches the live child instance (install table entries, seed catalogs) is Bucket C floor. |
| PHASE A static-root pin + PHASE B externref publish | `fork-reference-transaction.ts:1517-1590` | **(i)** replay side | Reconstruction ordering is `drive_plan.rs` Phase 0/0b; the *publish primitive* (write value into the instance) is floor. |
| Funcref catalog build/mirror | `worker-main.ts:4803-4824` | **(i)** | Catalog model in `catalogs.rs`; the read of live table ordinals is a floor primitive. |
| GC layout validation | `fork-reference-transaction.ts` | **(i)** | Rust `gc_codec.rs` + module post-alloc integrity guard (`lib.rs:679`). |
| Frame/journal replay | `fork-continuation.ts:248`; `fork-replay-events.ts` | **(i)** | Rust twin `linked_frames.rs`/`replay_events.rs`; module `fm_frames_*` already drives frames flag-on. |
| Exnref materialize | `fork-reference-transaction.ts` (`materializeException`) | **(i)** | Rust `exception_codec.rs`; module `DRIVE_OP_EXN`. |
| **CAPTURE / encode engine** — the parent-side capture graph + the encode import bodies (`ENCODE_FUNCREF`, `GC_LOOKUP`, `GC_CLAIM`, `GC_I31`, `GC_DEFINE`, vector begin/append/finish), layering dedup→static-root→externref-provenance→GC construction, `reserveGatedPlaceholder` gate | `fork-activation-registry.ts:482-547` (encode/`GC_*` import bodies); `fork-reference-transaction.ts` (`sealInto`, `reserveGatedPlaceholder:322`) | **(ii) — the largest remaining item** | The Rust *inverse* twin `reference_graph_builder.rs::intern_*` is **built + unit-proven**, and native already routes through it (`guest.rs:5933`). But `fork-module` exports **no capture/intern function** and `worker-main.ts` flips **only the decode imports** (`:4593`), never the encode ones — so V8 capture runs 100% in JS. Work = add the `fm_*` capture export (or a thin per-host capture body) + flip the V8 encode imports to the shared builder. The *identity primitives* it feeds (ref-equality/provenance lookup/handle mint) stay floor. See §3-note. |
| externref value→handle provenance table | `fork-externref-provenance.ts` (42 lines) | **(iii)** | WeakMap identity — floor (V8 externref identity). Native twin `ExternrefProvenance` (`guest.rs:2428`). |
| externref broker (handles + per-worker tokens) | `fork-reference-broker.ts` (680) | **(iii)** | Handle lifetime/identity — floor; the `resolve_externref` counterpart. |
| Truthful gate error | `fork-reference-unsupported.ts` (27) | **(iii)** | Errno-95 boundary; stays (native mirror is the `mark_unsupported` gate). |
| Runtime module-vs-JS selection (all-or-nothing fallback) | `worker-main.ts:3570,3665,4426-4440` | **(i)/delete** | `moduleReferenceKindsSupported` all-or-nothing + JS fallback disappears once the module is the sole path. |
| Default flag OFF | Node `node-kernel-worker-entry.ts:173`; browser `browser-kernel-worker-entry.ts:151` | **(i)/flip** | The single biggest blocker: module never instantiated by default. |

**§3-note — the one genuine (ii): the capture/encode engine.** Capture cannot be
module-owned wholesale (it observes live values in the running instance), but the
split is clean and asymmetric:

- **RESTORE / decode / drive-order / gc-codec / frames (the CHILD side)** is fully
  ported to `fork-codec` AND already wired into the V8 hosts behind
  `moduleReferenceKindsSupported`/`useForkModule` — pure **(i) wiring + deletion**.
- **CAPTURE / encode (the PARENT side)** is the outstanding chunk. Its Rust
  inverse twin `reference_graph_builder.rs::intern_*` (+ `claim_gc`/`define_gc`/
  vector builders) is built and unit-proven, and native already calls it
  (`guest.rs:5933`). But it has **no `fm_*` capture export** and **no V8
  encode-import flip** — so on Node/browser the parent's reference capture still
  runs entirely in JS (`ENCODE_FUNCREF`/`GC_LOOKUP`/`GC_CLAIM`/`GC_I31`/
  `GC_DEFINE`/vector-begin-append-finish in `fork-activation-registry.ts` +
  `ForkReferenceTransaction`'s capture graph). This is not a from-scratch Rust
  port — the Rust exists — but it IS real export + wiring work, larger than a
  trivial hoist.

Path B can either (a) leave a thin per-host capture body calling the shared
`intern_*` (native already has one; add a thin V8 one), or (b) hoist the capture
layering + soundness gate into `fork-codec` behind a small identity-primitive
trait so both hosts share it. (b) is the fullest expression of the principle;
(a) is the minimum for the flip. Per the probe, the funcref/GC/static-root
identity checks are `ref.eq`-able and could even move into module Wasm; only
externref identity must stay host-side (and holds by idempotent-cache
construction, not by compare — no engine can `ref.eq` an internalized externref).

**Bucket B verdict: the CHILD-side engine is (i) wiring + deletion (the bulk of
the ~12.8k deletable lines, Rust written + already wired flag-on); the PARENT-side
CAPTURE/encode engine is the one real (ii) item (Rust twin built + unit-proven +
proven on native, but unexported and unwired on V8); ~1.2k lines of live-identity
catalogs/brokers are (iii) floor and stay.** The audit's "Large, highest-risk,
the bulk of the ~24k-line fork engine" framing is NOT a 24k-line Rust port — that
Rust is written and tested. The remaining work is: wire the child side as the
SOLE path (delete the JS restore engine + fallback), and export+wire the
already-built capture builder on V8 (delete the JS capture engine) — both
bounded, both following a shape already proven on native.

### Bucket C — irreducible per-host floor

Validated against the probe's claim, and made concrete against the compiled
artifact. `wasm-objdump -x local-binaries/fork_module32.wasm` shows the module
declares ZERO `wpk_fork_host.*` imports (H3 deletion, commit `7003ab575`;
`fork-module/src/lib.rs:122-131`) — every `fm_*`/`__wpk_fork_frame_*` symbol is
an EXPORT. Reference-typed seams are added post-compile by the walrus injector
`crates/fork-module-inject/src/main.rs` because Rust/LLVM cannot express
reference-typed tables/returns. The floor is exactly:

1. **`resolve_externref(handle:i32) → externref`** — the ONE reference-returning
   host function; it IS the "handle→externref materialization." Identity holds
   because the backing cache is **idempotent** (same handle → same canonical
   token), NOT because the host can compare refs — an internalized externref is
   not `ref.eq`-comparable on any engine (`main.rs:581-584`, `:141-143`). Native:
   `define_resolve_externref` + `ExternrefRegistry` (`guest.rs:2984,2338`,
   `OwnedRooted<ExternRef>`). V8: `resolve_externref` →
   `ForkExternrefTokenCache.materialize` (`fork-module-host-capabilities.ts:56-73`,
   `fork-reference-broker.ts:590-606`).
2. **Three host-provided reference-typed TABLES** the module imports because Rust
   can't emit them: funcref `__wpk_fork_function_catalog`, funcref
   `__wpk_fork_drive_table`, anyref `__wpk_fork_static_root_catalog`
   (`main.rs:181-188,424-431,447-454`). Native creates them in
   `instantiate_fork_module` (`guest.rs:4393-4510`), incl.
   `Table::grow(Ref::Any(None))` (`guest.rs:2632-2640`); V8 as `WebAssembly.Table`
   in `fork-module-instance.ts:224-327,446`. NOTE: the GC transit anyref table
   (`__wpk_fork_ref_gc_transit`, STORE #2) is module-OWNED/EXPORTED, so it is NOT
   a floor import.
3. **PIC placement + shared memory** — `env.memory`, `__memory_base`,
   `__stack_pointer`, `__table_base`, `__indirect_function_table`. Process-memory
   read/write is direct linear-memory addressing on `env.memory`
   (`fork-module/src/lib.rs:1027-1044`), not a per-call import.
4. **An exception `Tag`** for fork-instrumented guests (`__wpk_fork_unwind`),
   host-minted: native `Tag::new` (`guest.rs:4947`), V8 `WebAssembly.Tag`. There
   is no `Tag::eq` floor — the guest throws/catches its own module-local tag.

**Capture-side identity bookkeeping is a host-internal cost, not an import.** The
`ExternrefProvenance`/`GcProvenance`/`StaticRootProvenance` tables, the `ref_eq`
linear scans, and the 4096-entry cap (wasmtime 48 has no weak-GC-ref primitive;
`guest.rs:2436-2472`) exist only because the host must answer "live value →
handle" at mint time; on V8 that is a `WeakMap` (`fork-externref-provenance.ts:25`).
This is the capture floor of §3-note, not part of the module's import contract.

**Bucket C size: tiny and closed** — one host func (`resolve_externref`) + three
reference-typed tables + PIC/shared-memory + one `Tag`, per host, plus the
capture-side identity bookkeeping. This confirms (and slightly sharpens) the
probe's "externref identity + handle→externref materialization + raw ref/mem
ops" floor.

---

## 4. Bottom-line sizing (honest)

- **Bucket A (already shared Rust): ~the entire reconstruction engine.**
  Recipe/graph/wire codec + `build_drive_plan` drive-order + replay + frames +
  GC/exn codecs + admit-all restore. ~18k lines across 23 `fork-codec` modules +
  3.5k lines of `fm_*` exports; 437 crate tests; proven end-to-end on native.
- **Bucket B — two parts.** The CHILD-side restore/decode/drive/frame engine
  (bulk of the ~12.8k deletable JS lines) is (i) WIRING + DELETION: the Rust is
  written AND already wired flag-on; nothing to author. The PARENT-side
  CAPTURE/encode engine is the one real (ii): its Rust twin
  (`reference_graph_builder.rs`) is built + unit-proven + already used by native,
  but is UNEXPORTED from `fork-module` and UNWIRED on V8 — so it is real export +
  wiring work (not a from-scratch port).
- **Bucket C (floor): `resolve_externref` + three reference-typed tables +
  PIC/shared-memory + one `Tag`, per host** (+ capture-side identity bookkeeping
  as a host-internal cost). Matches and sharpens the probe.

**So the remaining work is dominated by V8 host WIRING + DELETION plus one
capture-export step, not Rust engine authoring.** Native has already walked the
whole path (thin capture bodies → shared `intern_*` → shared replay), so the V8
work is "make Node/browser look like native" — a de-risked, proven-shape
migration, not the open-ended 24k-line port the pre-audit framing implied.

---

## 5. Sequenced implementation plan-of-record

Discipline per campaign Part D: one `subagent-driven-development` increment
each; green on unit + `host-native` before landing; the FULL cross-host batch
validation runs ONCE at the end (Decision 3). Increments are ordered by
dependency and risk.

### P0 — fork_module build/projection freshness (prerequisite)
- **Goal:** `fork_module32/64.wasm` is a first-class projected/committed artifact
  so a fresh/CI/browser build cannot serve a stale module (today it is built
  out-of-band into gitignored `local-binaries/`; browser dep-scan flags it "not
  owned by the pinned SourceOnly projection").
- **Files:** build pipeline (`build-wasm.sh`, source-only projection, `vite.config`
  fork-module artifact wiring); no fork algorithm change.
- **Shared-Rust vs wiring vs floor:** build wiring only.
- **Validation gate:** fresh `./run.sh prepare-browser` projects a fresh
  `fork_module*.wasm` with the Phase 0b decode fix (`a4fc9599f`); no dep-scan
  error; `verify-fresh` exit 0.
- **Size:** S. **Risk:** Low. **Deps:** none. Unblocks every module-on config.

### P1 — Native module-path wiring audit + close (make native the reference)
- **Goal:** confirm native drives the FULL shared drive plan
  (`fm_build_gc_plan`+`fm_drive_execute` over `build_drive_plan`) for every kind,
  capture via `guest.rs` bodies → shared `intern_*` → shared replay, with the
  gated boundary intact. Correct the stale "native gates" comments
  (`lib.rs:2270-2287`, `fork-reference-support.md`).
- **Files:** `crates/host-native/src/lib.rs` (comment), `guest.rs` (confirm no
  residual host-side reconstruction), `docs/fork-reference-support.md`.
- **Shared-Rust vs wiring vs floor:** mostly confirmation + doc truth; any native
  host-side reconstruction residue found → move to module.
- **Validation gate:** `host-native` 45/45; a fixture that forces the full GC
  drive plan asserts `fm_*_reconstructed>0` with no host-side reconstruction.
- **Size:** S–M. **Risk:** Low (native already passes). **Deps:** P0.

### P2 — V8 REPLAY module-path wiring (make the module the SOLE reconstructor)
- **Goal:** on Node+browser, route ALL reconstruction through
  `fm_begin_reference_replay` + `fm_build_gc_plan` + `fm_drive_execute` +
  `fm_ref_*` — including wire-graph decode and the full topological drive-order,
  not just the typed sub-loop delegate. Remove `moduleReferenceKindsSupported`
  all-or-nothing + the JS fallback so the module admits every kind (native
  proves it does).
- **Files:** `host/src/worker-main.ts` (`:3570,3665,4372-4440,4593,4606,4835-4873`,
  `4803-4824`), `host/src/fork-module-instance.ts`, `-backend.ts`, `-state.ts`,
  `-trampoline.ts`; the JS reconstruction bodies become unreferenced.
- **Shared-Rust vs wiring vs floor:** WIRING only (Bucket A Rust already exists);
  floor primitives from Bucket C stay behind the module glue.
- **Validation gate:** Node Vitest fork suites green with the module as the SOLE
  reconstructor (invert the flag-on tests to be the default); externref/GC/
  static-root/exnref/frames all reconstruct via `fm_*` with `references_
  reconstructed>0` and no JS reconstruction entered.
- **Size:** M. **Risk:** Medium. **Deps:** P0, P1.

### P3 — V8 CAPTURE floor + shared layering (delete JS capture)
- **Goal:** replace the revived JS capture path (`GC_LOOKUP`/`GC_CLAIM`,
  `lookupGcSlot`, `ForkExternrefProvenanceTable`, `reserveGatedPlaceholder`) with
  thin V8 host capture bodies that call the SHARED `fork-codec`
  `ReferenceGraphBuilder::intern_*` + shared capture-layering, using only the
  Bucket C floor primitives (V8 externref identity via `WeakMap`, handle mint).
  This is the one Bucket-B(ii) hoist: lift the capture layering + soundness gate
  from native `guest.rs`/JS into shared `fork-codec` behind an identity-primitive
  trait (option (b) in §3-note), or, minimally, mirror native's thin body on V8.
- **Files:** NEW `fm_*` capture/intern export in `crates/fork-module/src/lib.rs`
  (surfacing the already-built `reference_graph_builder.rs::intern_*`/`claim_gc`/
  `define_gc`/vector builders); optional NEW/extended `crates/fork-codec`
  capture-layering module (host-agnostic decision logic + soundness gate);
  `host/src/worker-main.ts` flip the ENCODE imports (`ENCODE_FUNCREF`/`GC_LOOKUP`/
  `GC_CLAIM`/`GC_I31`/`GC_DEFINE`/vector-begin-append-finish, today only decode is
  flipped at `:4593`) to the module/shared builder; `host/src/fork-module-*.ts`
  capture glue; delete `fork-externref-provenance.ts` capture *logic* (keep only
  the identity primitive), retire JS `lookupGcSlot`/`GC_CLAIM`.
- **Shared-Rust vs wiring vs floor:** the ONE shared-Rust addition of the plan
  (layering + gate); the rest is floor + wiring.
- **Validation gate:** Node Vitest capture parity — externref/GC/static-root
  captured via the shared builder; the no-provenance case still gates
  `EOPNOTSUPP` cleanly; parent survives a gated fork on V8 (parity with native
  `smoke_fork_gated_externref_parent_survives`).
- **Size:** M. **Risk:** Medium-High — **this is the true highest-risk step.**
  Why: it removes the JS capture that `283b06917` deliberately revived, and it is
  where V8 externref-identity semantics (internalized externref not
  `ref.eq`-comparable; `WeakMap` keying vs wasmtime `Rooted`+`ref_eq`) must match
  the shared model exactly, with no JS fallback left. **How the shared-Rust
  reality shrinks it:** the decision logic is already written and proven on
  native; the wire-emission inverse (`intern_*`) is shared; the replay spec is
  frozen. The risk collapses from "invent capture in Rust" to "route V8 through
  the proven shared logic behind two floor primitives." **Deps:** P2.

### P4 — Module-mode abort parity for the gated residual
- **Goal:** the one intended `EOPNOTSUPP` boundary must abort cleanly through the
  co-resident module's own continuation journal (not the JS `beginAbortReplay`),
  since JS is about to be deleted. `fork-reference-support.md:99-111` flags this
  as unverified under module-mode.
- **Files:** `crates/fork-module/src/lib.rs` abort path; `host/src/fork-module-*.ts`.
- **Shared-Rust vs wiring vs floor:** shared-Rust abort path confirmation + V8
  wiring.
- **Validation gate:** a module-mode gated fork on Node AND native aborts cleanly,
  parent survives, no partial child, no 30s pump hang (guard the ledger's
  gate-hang regression).
- **Size:** S–M. **Risk:** Medium. **Deps:** P2, P3.

### P5 — Default-ON flip
- **Goal:** `WASM_POSIX_FORK_MODULE` default ON (Node) and
  `forkModuleEnabledBrowser` default true (browser), incl. the browser main-
  thread→worker flag plumbing (memory: the globalThis→worker forwarding at
  `browser-kernel-worker-entry.ts:1373-1378`).
- **Files:** `node-kernel-worker-entry.ts:173`, `node-kernel-host.ts:300,1270`,
  `browser-kernel-worker-entry.ts:151,1373-1378`.
- **Shared-Rust vs wiring vs floor:** wiring only.
- **Validation gate:** default-config Node Vitest + a browser `./run.sh browser`
  smoke boot with fork exercised; zero JS-reconstruction entries.
- **Size:** S mechanically. **Risk:** Medium (it is the irreversible product-
  default change). **Deps:** P2–P4. **HELD for user dogfood** per M7/B8.

### P6 — Delete the JS twins
- **Goal:** delete the now-dead TypeScript reconstruction + frame/journal engine:
  `fork-activation-registry.ts`, `fork-reference-transaction.ts`,
  `fork-reference-recipes.ts`, `fork-reference-segments.ts`,
  `fork-early-reference-provider.ts`, `fork-continuation.ts`,
  `fork-replay-events.ts`, `fork-gc-codec.ts`, `fork-anyref-transit.ts`,
  `fork-function-catalog.ts`, `fork-static-root-catalog.ts`, and the capture
  *logic* of `fork-externref-provenance.ts`/`fork-reference-broker.ts` (keep only
  the floor identity primitive). KEEP the `fork-module-*.ts` glue and
  `fork-reference-unsupported.ts`.
- **Files:** the above under `host/src/`; `worker-main.ts` fallback branches.
- **Shared-Rust vs wiring vs floor:** deletion only.
- **Validation gate:** `tsc` clean; no import of a deleted symbol; Node Vitest +
  browser smoke green with the code physically gone (not merely unreferenced).
- **Size:** M (mechanical but wide). **Risk:** Low once P2–P5 are green.
  **Deps:** P5.

### P7 — Post-flip cross-host validation gate (M8)
- **Goal:** the ONE batch validation on the SAME `kernel.wasm`+`fork_module*.wasm`:
  Node Vitest full + browser Playwright (the module-on config that has never run
  in CI) + libc/posix/sortix conformance + native `host-native`. Confirm the
  seven completion criteria incl. "TS out of the dispatch path."
- **Files:** none (validation).
- **Validation gate:** all three hosts green on the finished result; benchmarks
  before/after on Node AND browser if any hot-path claim is made.
- **Size:** M (mostly runtime). **Risk:** Medium (first true cross-host module-on
  run; browser is the least-exercised). **Deps:** P6.

### Sequence + critical path
```
P0 fork_module freshness/projection
  ▼
P1 native module-path confirm + doc truth
  ▼
P2 V8 REPLAY wiring (module = sole reconstructor)      ← wiring, Bucket A exists
  ▼
P3 V8 CAPTURE floor + shared layering (delete JS cap)  ← TRUE HIGHEST RISK
  ▼
P4 module-mode gated-abort parity
  ▼
P5 default-ON flip (HELD for user)
  ▼
P6 delete JS twins
  ▼
P7 M8 cross-host batch validation
```
P0/P1 are independent and can start immediately. P2→P3→P4 are the critical path.
P5 is user-held. Everything downstream of P2 is de-risked by native already
having walked the identical shape.

---

## 6. Highest-risk step — honest call

The true highest-risk step is **P3 (V8 capture floor + shared layering)**, not
the historically-feared "port the 24k-line engine to Rust." The engine port does
not exist as risk anymore: `crates/fork-codec` already contains the whole
reconstruction/replay/wire/frame engine with 437 tests and native end-to-end
proof (Bucket A). What remains genuinely risky is removing the JS *capture* path
(revived by `283b06917`) and making V8 honor the externref-identity floor
(internalized externref not `ref.eq`-comparable) through the shared model with
NO JS fallback — the exact seam where capture↔replay symmetry breaks (campaign
Decision 2a). The shared-Rust-already-exists reality shrinks even this: the
capture *decision logic* is written and proven on native, the wire-emission
inverse is shared (`intern_*`), and the replay spec is frozen — so P3 is "route
V8 through proven shared logic behind two floor primitives," a bounded migration
rather than an open-ended design problem.

**Bottom line:** Path B is far closer to done than the pre-audit framing
suggested. The module engine is built, tested, and proven on native across every
reference kind; native is already the target architecture (thin host capture →
shared module replay). The remaining work is V8 wiring + one small
capture-layering hoist + deletion + one honest, de-risked high-risk step (P3),
capped by a single cross-host validation. The flip is a wiring-and-delete
finish, not a re-implementation.
