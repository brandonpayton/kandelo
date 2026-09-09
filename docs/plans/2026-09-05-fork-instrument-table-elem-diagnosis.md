# Diagnosis: `uninitialized element` trap in native fork-instrumented guest

Date: 2026-09-05
Context: N1-I4 native fork blocker (`crates/host-native`). Follow-up to
`.superpowers/sdd/2026-09-05-n1-i4-native-fork-frames/task-3-report-v2.md`.
Scope: research/diagnosis only. No code changed.

## Verdict

**(a) — NATIVE-HOST INSTANTIATION GAP. Not a `crates/fork-instrument` bug.**

`crates/host-native` never calls the guest's `wpk_fork_module_bootstrap`
export after instantiating a fork-instrumented guest and before calling
`_start`. Node and browser call it (Node/browser: `bootstrapActivation(0)`
before `_start`). fork-instrument intentionally converts the guest's
*active* element and data segments to *passive* segments and defers their
initialization into an exported `wpk_fork_module_bootstrap` function. Without
that call, the guest's `__indirect_function_table` is never populated (and its
`.data`/`.rodata` linear-memory segments are never copied in either), so the
first `call_indirect` traps `uninitialized element`.

Fix is in scope for host-native, fixable, and does NOT affect Node/browser.

Confidence: **very high** — proven from raw wasm decode + fork-instrument
source + shared-ABI constant + the exact host call sites + the absence of any
bootstrap reference in host-native + presence of the export in the fixture.

## The prior report's key interpretation was wrong

Task-3-report-v2 correctly decoded the Element section but mis-identified one
segment and drew the wrong conclusion:

- It claimed "none of the 4 segments target the guest's own function table"
  and "the original active segment is dropped … a `crates/fork-instrument`
  bug."
- In fact the guest's original table-population segment IS present — converted
  from *active* to *passive*. It is passive segment 0, `[64,129,129,65]`, which
  the report misread as "the resume-table catalog." Those four function indices
  are the guest's original indirect-table targets `[30,15,15,29]` renumbered by
  instrumentation (30→64, 15→129, 15→129, 29→65). The prior agent's raw decode
  was accurate; the interpretation was not.

## Evidence

### 1. Raw section decode of both fixtures

Decoded with a purpose-built raw LEB128/element decoder (wabt mis-parses these
GC/exception modules; `wasm-tools` unavailable). Files:
`crates/host-native/fixtures/native_fork.wasm` and
`native_fork.instrumented.wasm`.

Un-instrumented `native_fork.wasm`:
- Table section: 1 defined table `[0]` funcref min=7. Exported as
  `__indirect_function_table` → tableidx 0.
- Element section: **1 segment**, `flags=0` ACTIVE, table=0, offset
  `i32.const 3`, funcs `[30, 15, 15, 29]` (fills slots 3-6).

Instrumented `native_fork.instrumented.wasm`:
- Import section: 67 imports, including **two imported tables**:
  `env.__wpk_fork_ref_gc_transit` (import table[0]) and
  `env.__wpk_fork_resume_table` (import table[1]). These are supplied by the
  co-resident fork module (`crates/fork-module`,
  `host/src/fork-module-instance.ts`) / host.
- Table section (defined, indices continue after the 2 imports):
  - `[2]` funcref min=7 — the guest's original indirect table. Exported as
    BOTH `__indirect_function_table` → 2 and `__wpk_fork_table_1` → 2.
  - `[3]` funcref min=44 — `__wpk_fork_function_catalog`.
  - `[4]` gc-ref min=0 — `__wpk_fork_static_root_catalog`.
  - `[5]`,`[6]` gc-ref; `[7]` funcref min=3 — `__wpk_fork_resume_catalog`.
- Element section: **4 segments**:
  - seg0: `flags=1` PASSIVE, funcs `[64,129,129,65]` — **the guest's original
    active segment `[30,15,15,29]`, converted to passive** (indices renumbered).
  - seg1: `flags=2` ACTIVE table=3 offset 0, 43 funcs — function catalog.
  - seg2: `flags=2` ACTIVE table=7 offset 0, 3 funcs `[117,88,98]` — resume
    catalog.
  - seg3: `flags=2` ACTIVE table=3 offset 43, 1 func — completes the catalog.

So table 2 (the guest indirect table) has **no active segment**. Its populating
segment exists but is passive (seg0), awaiting a `table.init` from the
bootstrap. The transport helper `__wpk_fork_unwind_transport_indirect_0_3`
performs the guest's original `call_indirect` (constant slot index 6 →
un-instrumented func 29 / instrumented func 65). With table 2 empty, slot 6 is
null → `uninitialized element`.

### 2. fork-instrument deliberately converts active→passive and emits a bootstrap

`crates/fork-instrument/src/module_state.rs`:
- `inject()` (line 564) walks every element segment and, for each ACTIVE one,
  records `(table, offset, len)` and **flips it to `ElementKind::Passive`**
  (line 279). Same for ACTIVE data segments (line 305+). It also *takes* the
  module's `start` function: `original_start: module.start.take()` (line 420).
- `emit_bootstrap_helper()` (line 2422) emits a function that, guarded by a
  `bootstrap_done` global (runs once), calls `emit_active_element_initializers`
  (→ `TableInit` per segment, line 2502) then `emit_active_data_initializers`
  (→ memory init) then `original_start`. Its own comment (line 2435): *"Native
  instantiation applies element segments, then data segments, then invokes the
  start function."* i.e. this function IS the deferred module-instantiation
  init step.
- `emit_thread_bootstrap_helper()` (line 2454): for pthread instances that
  share the parent's already-initialized linear memory — re-inits
  instance-local tables via `TableInit`, `DataDrop`s the data segments without
  copying, and does NOT re-run start.
- `export_helpers()` (line 801) exports these as
  `WPK_FORK_EXPORT_MODULE_BOOTSTRAP` / `WPK_FORK_EXPORT_MODULE_THREAD_BOOTSTRAP`
  — **exported functions, NOT the module `start`**. The module has no `start`
  after instrumentation, by design (so state save/restore and per-activation /
  per-thread re-init can manage tables + data).

Rationale for the design (`static_reference_catalog.rs` lines 78-84): active
segments are converted to passive precisely so the static-root harvest and
module-state save/restore can copy/re-init roots deterministically without
re-evaluating allocating const-expressions. This is intentional, not a defect.

Shared-ABI constants (`crates/shared/src/lib.rs`):
- line 2457: `WPK_FORK_EXPORT_MODULE_BOOTSTRAP = "wpk_fork_module_bootstrap"`
- line 2458: `WPK_FORK_EXPORT_MODULE_THREAD_BOOTSTRAP =
  "wpk_fork_module_thread_bootstrap"`

Both strings are present in `native_fork.instrumented.wasm`'s export section
(verified), so the native host *can* call them.

### 3. Node/browser CALL the bootstrap; host-native does NOT

Node/browser (`host/src/`):
- `fork-activation-registry.ts:317` captures the guest's
  `wpk_fork_module_bootstrap` export; `:833`
  `registration.moduleState.bootstrap()` invokes it inside
  `bootstrapActivation(activationId)`.
- `worker-main.ts:4678` builds `mainRegistration`; `:4714`
  `activationRegistry.bootstrapActivation(0)` runs the bootstrap; `:5036`
  calls `_start` **after** it. So order is: instantiate → register →
  `wpk_fork_module_bootstrap` → `_start`.
- `worker-main.ts:6898-6920` calls `wpk_fork_module_thread_bootstrap` for new
  guest threads (pthread children).
- `dylink.ts:1943` also calls `wpk_fork_module_bootstrap` on the dlopen path.

host-native (`crates/host-native/src/`):
- `grep` for `wpk_fork_module_bootstrap` / `module_bootstrap` /
  `thread_bootstrap` / `WPK_FORK_EXPORT_MODULE_BOOTSTRAP` → **zero matches**.
- `run_fork_capable_entry` (`guest.rs:3610`) fetches `_start` (`:3627`) and
  `wpk_fork_resume_start` (`:3638`) and calls `_start` directly for
  `ForkEntry::Normal`, with no bootstrap step. So the guest's table and data
  are never initialized.

### 4. Why this is universal to native, not fixture-specific

- The trap is on the FIRST `_start`, before `fork()` — nothing fork-path
  specific. Because active DATA segments are ALSO converted to passive,
  **every** static-executable guest (all real fork packages: php-fpm, redis,
  …) built through the normal SDK link shape
  (`--table-base=3 --export-table --growable-table`, confirmed identical in
  `sdk/src/lib/flags.ts` per the prior report) depends on the host calling
  `wpk_fork_module_bootstrap` for correct memory/table init — not just guests
  with an indirect call. Any instrumented guest run natively would fail the
  same way (the indirect-call trap is merely the first observable symptom; a
  guest without an indirect call would instead read uninitialized `.data`).
- Real packages fork correctly on Node/browser precisely because those hosts
  call the bootstrap. This confirms the strong prior: the table (and data) are
  populated by a host/instantiation step native is missing, not by anything in
  the module that native could reach on its own.

## The precise native fix

In `crates/host-native/src/guest.rs`, when the guest is fork-instrumented
(`fork_format.is_some()`), call the guest's own bootstrap export exactly once
after instantiation and BEFORE the first `_start`, mirroring Node/browser's
`bootstrapActivation(0)`-before-`_start` ordering:

1. Primary / boot / spawn / exec instance (`ForkEntry::Normal`): in
   `run_fork_capable_entry` (`guest.rs:3610`), before the `_start.call(...)`
   at `:3627`, fetch and call
   `wasm_posix_shared::abi::WPK_FORK_EXPORT_MODULE_BOOTSTRAP`
   (`"wpk_fork_module_bootstrap"`, type `() -> ()`). It is idempotent
   (guarded by the module's `bootstrap_done` global), applies the passive
   element segments via `table.init` (populating `__indirect_function_table`),
   applies the passive data segments, then runs any original start. Treat a
   missing export on an instrumented guest as a truthful hard error.
   Equivalent alternative: call it in `spawn_guest_thread` right after
   `instantiate_fork_module` succeeds (before entering the run loop). Either
   spot is fine as long as it precedes `_start`.

2. New guest threads and fork/replay children whose instance has fresh,
   instance-local tables but a memory copy already carrying initialized data
   (`ForkEntry::ChildReplay`, and the pthread thread path): call
   `WPK_FORK_EXPORT_MODULE_THREAD_BOOTSTRAP`
   (`"wpk_fork_module_thread_bootstrap"`) instead — it re-inits the
   instance-local tables and `DataDrop`s the data segments without re-copying
   memory or re-running start (matching `worker-main.ts:6898`). Confirm which
   native child instances get a fresh Store/table vs. inherit one, and select
   module- vs. thread-bootstrap accordingly.

This is a pure host-native change (a guest export call). It needs no import
wiring — the bootstrap only reads passive segments + immutable offset globals
already inside the module — and does not touch `crates/fork-instrument`,
`crates/shared`, the ABI snapshot, or Node/browser.

## Notes / open items for the fixing agent

- The frame-engine setup the prior task already wired (`fm_set_format`,
  `fm_set_resume_catalog`, the `catalog_scratch_base`, the tag definition) is
  separate from this bootstrap and remains correct; the bootstrap is a plain
  guest export unrelated to the co-resident frame engine.
- After the bootstrap fix, execution should for the first time actually reach
  `fork()`/`kernel_fork`, at which point the prior task's coordinator sequencing
  (capture → seal → child replay) and the "67 imports / default values"
  concern (task-3-report-v2 concern #3) can finally be validated end-to-end.
- Verifying the fix does not require rebuilding the fixture; the existing
  `native_fork.instrumented.wasm` already exports both bootstrap functions.
