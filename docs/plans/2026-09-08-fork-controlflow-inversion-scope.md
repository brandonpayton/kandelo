# Fork control-flow INVERSION: can the module drive its own sequence?

Status: design/scoping only. READ-ONLY investigation — no source edited, no
build/test run. Worktree `/Users/brandon/kandelo-abi44-reconcile`, branch
`brandonpayton/rust-first-abi44-reconcile`, HEAD `cdddf15fb`.

Companion (supersedes framing, not facts): this doc answers the sharper
*inversion* question that `docs/plans/2026-09-08-fork-controlflow-into-module-scope.md`
gestured at (coarse `fm_*` phase entries) but did not resolve as an
inversion. Where the two differ, this doc corrects the earlier one (noted
inline). The concurrently-edited abort/rewind collapse is treated as "step 1".

---

## Executive summary

The inversion is **already half-built and the other half is bounded, not
open-ended.** The module ALREADY drives the guest (injected `fm_drive_execute`
`call_indirect`s guest reconstruction exports through the imported
`__wpk_fork_drive_table`) AND ALREADY calls back to the host for the one true
reference floor (`env.resolve_externref`, injected by
`crates/fork-module-inject/src/main.rs`). So "module drives + calls host
imports for floor" is a *proven, shipping* pattern at the leaf, not a
speculative refactor. Extending it to the phase level (coarse
`fm_capture`/`fm_reconstruct`/`fm_abort` that internally sequence today's
fine-grained exports) is incremental.

But **full inversion — one module entry owning the whole fork and calling back
for every floor op — is impossible for two concrete reasons**: (1) a fork spans
TWO workers (parent captures/serializes; a *separate* child worker
restores/reconstructs — `initData.isForkChild` gates entirely different setup,
`worker-main.ts:3398/4083/5224`), so no single drive call can span it; and
(2) the guest top-level entry can terminate via EITHER a fork-unwind
`WebAssembly.Exception` (tagged, catchable) OR a `kernel_exit` `unreachable`
**trap** (a `RuntimeError` only JS can catch — Wasm-EH `catch` does not catch
traps), so the entry-invoke + discriminate + phase-re-enter loop
(`worker-main.ts:5253-5316`) must stay in JS.

Realistic verdict: the **host-called `fm_*` surface drops ~74 → ~8-12** (3-5
coarse per-phase entries + ~2-3 setup pushes + 2 diagnostics + the 5 frozen
`__wpk_fork_frame_*` ABI re-exports stay); the module gains **0-1 new host
imports** (it already holds `resolve_externref` + 4 imported tables); the
backend drops **~989 → ~250-350**; `worker-main.ts` fork glue drops
~150-300. The floor is worker spawn, the JS entry/catch/phase loop, the
`fork()` syscall + channel, `resolve_externref`, the 4 ref-typed imported
tables, PIC globals, transit `Table.grow`, and the worker-message bridge.
Effort **L, multi-increment**, ABI-neutral at the core (host↔module contract,
not the guest ABI). Biggest risk: the guest unwind state machine (P-11
territory) under coarser reentrant drive, validated only cross-host.

---

## 1. Current `fm_*` surface, categorized

Enumerated from `crates/fork-module/src/lib.rs` (81 `#[no_mangle]` exports; ~74
`fm_*` + 5 frozen `__wpk_fork_frame_*`/`__wpk_fork_resume_peek` re-exports) and
what `host/src/fork-module-backend.ts` (989 lines of thin 1:1 wrappers:
validate args → call one export → `requireOk`/`fm_last_errno`) actually calls.

**IMPORTANT — the inversion is partly done already.** `lib.rs` declares ZERO
Wasm imports (Rust/LLVM cannot emit a reference-returning import or a
reference-typed `call_indirect`). The module's outward calls are all
**walrus-injected** by `fork-module-inject`:

- `env.resolve_externref(handle:i32)->externref` — the one reference-returning
  host import (`fork-module-inject/src/main.rs:145-164, 237`), called from the
  injected `__wpk_fork_ref_decode_externref` export AND the
  `DRIVE_OP_EXTERNREF_TRANSIT` branch of `fm_drive_execute`.
- Imported tables: `__wpk_fork_drive_table` (funcref; guest reconstruction
  exports the shim `call_indirect`s, `main.rs:63`),
  `__wpk_fork_ref_gc_transit` (anyref STORE #2, `main.rs:82`),
  `__wpk_fork_static_root_catalog` (anyref, `main.rs:92`),
  `__wpk_fork_function_catalog` (funcref, `main.rs:138`).
- Injected shims that drive: `fm_drive_execute` walks the Rust-built drive plan
  (`fork_codec::drive_plan`) and `call_indirect`s each step (`main.rs:39-50,
  65`); `__wpk_fork_ref_decode_funcref` (`main.rs:132`), `..._externref`.

So the module→guest drive and module→host floor callback ALREADY EXIST. The
question is only how far up the phase stack that pattern can be pushed.

### (a) Collapsible into module-internal sequencing (the inversion target)

These are called by the host **in a specific ORDER**; the module could sequence
them itself behind a coarse entry (the leaf drive already does exactly this).

- Parent capture/serialize sequence: `fm_capture_begin` (4127),
  `fm_capture_intern_funcref/externref/i31/static_root` (4169-4207),
  `fm_capture_claim_gc` (4222), `fm_capture_gated_placeholder` (4239),
  `fm_capture_define_gc` (4261), `fm_capture_begin/append/finish_vector`
  (4324-4349), `fm_capture_vector_get` (4371), `fm_capture_validate` (4397),
  `fm_capture_serialize` (4429), `fm_capture_serialized_len` (4469),
  `fm_capture_record_header_size` (4479), `fm_capture_interned` (4489).
- Unwind/journal sequence: `fm_begin_unwind` (3350),
  `fm_add_activation_unwind` (3373), `fm_finish_unwind` (3461),
  `fm_serialize_journal_alloc` (3516), `fm_journal_image_len` (3552).
- Replay sequence: `fm_begin_replay` (3470), `fm_finish_replay` (3479).
- Abort sequence: `fm_begin_abort` (3489), `fm_finish_abort` (3498),
  `fm_abort` (3563).
- Child install sequence: `fm_restore_from_arena` (4652), `fm_attach_child`
  (4674), `fm_attach_borrowed_child` (4697), `fm_begin_child_replay` (3582),
  `fm_begin_borrowed_child_replay` (3606),
  `fm_add_activation_(borrowed_)child_replay` (3630/3660),
  `fm_begin_reference_replay` (3801).
- Reconstruction drive + leaf feeds (already module-internal via the shim, but
  still exported/host-visible): `fm_drive_table_base` (3949),
  `fm_build_trivial_plan` (3961), `fm_trivial_plan_count` (3977),
  `fm_build_gc_plan` (3990), `fm_gc_plan_count` (4006), `fm_drive_bump` (4018),
  `fm_drive_execute` (injected), `fm_ref_vector_get` (3861),
  `fm_ref_gc_route/payload_len/load` (3867-3884),
  `fm_ref_exn_route/load/cache_index` (3906-3938), `fm_funcref_ordinal` (3816),
  `fm_static_root_slot` (3828), `fm_externref_handle` (3844).
- Decode + exnref-gate feed: `fm_decode_reference_graph` (4512),
  `fm_decoded_node_count` (4533), `fm_scan_externref_handles` (4557),
  `fm_decoded_node_kind/module_activation/ordinal` (4581-4628).

Verdict: essentially the whole ~74 minus the four items in (b). These are the
host↔module *ordering* contract; the module can own the ordering.

### (b) Stays a host boundary (setup + diagnostics + ABI floor)

- **Custom-section codec/catalog seeding** — `fm_set_format` (3337),
  `fm_set_resume_catalog` (3680), `fm_set_activation_resume_catalog` (3700),
  `fm_set_activation_catalog_base` (3725), `fm_set_activation_static_root_base`
  (3745), `fm_set_activation_gc_codec` (3764),
  `fm_set_activation_exception_codec`, `fm_set_host_exception_owner` (3778).
  These carry host-decoded custom-section bytes into the module. The module
  cannot parse the guest's Wasm binary itself (it never sees the guest's module
  ArrayBuffer; the host does). This is once-per-worker SETUP, not per-fork
  sequencing, so it does not benefit from inversion. Collapse the 8 into 1-2
  descriptor pushes but keep host→module direction.
- **Diagnostics** — `fm_stats` (4739), `fm_last_errno` (4771). Trivial; keep 1-2.
- **Frozen guest-ABI re-exports** — `__wpk_fork_frame_{reserve,commit,peek,next}`
  (3172-3231) + `__wpk_fork_resume_peek`. These are the ABI-44 guest contract;
  they stay verbatim.
- The `*_fixed_arena` variants (`fm_begin_unwind_fixed_arena` 3398,
  `fm_add_activation_unwind_fixed_arena` 3421,
  `fm_serialize_journal_fixed_arena` 3535) are being removed by the in-flight
  abort/rewind collapse (step 1) — not part of the inverted surface.

---

## 2. The true floor (host-IMPORTS under inversion)

Under inversion these are what the module would call BACK to the host for. Some
already exist as imports; the rest are why full inversion stops where it does.

| Floor op | Already an import? | Why it cannot move into the module |
|---|---|---|
| Child worker spawn + COW instantiate (`WebAssembly.instantiate`/`Worker`) | No (host-driven) | No Wasm capability to create a Worker/instance. And the fork spans TWO workers — the child reconstruct runs in a *different* instance (`isForkChild`, `worker-main.ts:3398/4083`), so no single module call can span parent+child. |
| The real `fork()`/`vfork()` syscall + channel (`sendForkSyscall`, `worker-main.ts:5357`) | No | Process-creation syscall over the shared channel; the child worker is spawned by the host in response. Module has no process-creation syscall authority. *Could* in principle become a host-import the module calls mid-sequence, but see §3 — the trap-catch entanglement makes that not worth it. |
| Guest top-level entry + fork-unwind catch + phase re-enter loop (`worker-main.ts:5253-5316`) | Partial (module `call_indirect`s guest *reconstruction* exports, not the top-level entry) | The entry can end via a fork-unwind **`WebAssembly.Exception`** (tagged, `fork-unwind-transport.ts:38-47`, IMPORTABLE tag — a Wasm shim *could* catch it) OR a `kernel_exit` **`unreachable` trap** (`isWasmUnreachableTrap`, `worker-main.ts:5309`). Wasm-EH `catch` does NOT catch traps — only the JS boundary catches a `RuntimeError`. Because the entry can end either way and they must be discriminated, the top loop is JS-only. **(Corrects the prior doc's "a Wasm module cannot try/catch the guest's throw" — it can catch the tagged throw; it cannot catch the trap.)** |
| `resolve_externref(handle)->externref` | **YES** (`env.resolve_externref`, injected) | A Wasm module cannot hold a live `externref` in Rust or mint one from a handle; only the JS engine can (idempotent identity cache, `fork-module-host-capabilities.ts:56-73`). The proven floor seam. |
| Anyref-transit `Table.grow` sizing (STORE #2) | Table is imported; sizing is host | Rust/LLVM does not emit `table.grow` for the host-owned anyref transit table (`prepareTransit`); host must grow before the drive. |
| PIC placement globals (`__memory_base`/`__stack_pointer`/`__table_base`/`__indirect_function_table`, `fork-module-instance.ts:5-9`) | Imports | Host-chosen at instantiation; the module cannot place itself (chicken-and-egg). |
| Ref-typed catalogs/tables (`__wpk_fork_function_catalog`, `__wpk_fork_static_root_catalog`, resume table) | Imports | Host-built from live values (funcref/anyref); the module only ever sees resolved i32/i64 coordinates. externref value→handle provenance (WeakMap, `fork-externref-provenance.ts`) is the live-value→coordinate translation. |
| Node/browser worker-message bridge (`fork_module_frames`/`_proof`/`_region`, ready signal) | No | Host transport. |

---

## 3. The inverted shape

**Two per-worker inversions, not one.** Because the fork spans two workers, the
most the module can drive is two independent sub-sequences, joined by the host:

- **Parent worker.** Host invokes guest `_start`, catches the fork-unwind
  exception (JS — trap discrimination, §2). THEN one coarse call:
  `fm_parent_seal_capture()` internally runs today's
  `fm_capture_*` intern/validate + `fm_begin_unwind`/`fm_add_activation_unwind`/
  `fm_finish_unwind` + `fm_serialize_journal_*`, returning the journal image
  ptr/len. Host reads the image, calls `sendForkSyscall`/spawns the child, then
  invokes guest `wpk_fork_resume_start` and (JS) catches the second unwind, THEN
  one coarse call: `fm_parent_replay()`.
- **Child worker.** Host instantiates, seeds codecs (§1b), invokes the replay
  entry; the module drives via one coarse `fm_child_reconstruct()` that
  internally runs `fm_restore_from_arena`/`fm_attach_(borrowed_)child` +
  `fm_begin_reference_replay` + `fm_decode_reference_graph` + `fm_build_gc_plan`
  + `fm_drive_execute` (already the shipping drive) + the activation-seed loop,
  calling `env.resolve_externref` mid-walk (already happens).
- **Abort.** Folded into the parent path: when the host's spawn/reserve fails,
  one coarse `fm_abort()` (the abort/rewind collapse = step 1 delivers the
  module-mode partial-capture abort, the P-11 fix — precondition here).

**Coarse module entries: 3-5.** `fm_parent_seal_capture`, `fm_parent_replay`,
`fm_child_reconstruct`, `fm_abort` (parent-replay + child-reconstruct could be
one dispatched entry, giving 3). **New host-imports needed: 0-1.** The module
already has every floor import it needs for the *reconstruction* drive
(`resolve_externref` + 4 tables). The only candidate new import would be
`host_do_fork()` if the parent entry were to trigger the syscall itself — but
that is NOT worth adding, because the host must already be on the stack to
catch the unwind/trap and to spawn into a second worker; the host sequencing the
one syscall between two coarse calls is strictly simpler than a
module→host→module reentry.

**Interleaving hazards addressed:**

- *Mid-reconstruction externref materialization* — already solved: the drive
  shim calls `env.resolve_externref` mid-`call_indirect` today. Coarsening does
  not change this seam.
- *Exception catch* — stays JS (trap vs tagged-exception discrimination, §2).
  A walrus shim COULD import the fork-unwind `Tag` and `catch` it, but it cannot
  catch the `kernel_exit` trap, so the discrimination must stay at the JS
  boundary. This bounds the inversion: the module owns everything AFTER the
  catch and BEFORE the next entry, never the entry/catch itself.
- *Guest-unwind state machine (P-11)* — the coarse `fm_parent_seal_capture`
  must NOT drive the guest's `wpk_fork_unwind_end` when a reserve failed
  mid-unwind (corrupts the state machine; `backend.ts:sealForAbort` documents
  this, and two naive attempts trapped/hung per `task-p10-p11-fix-report.md`).
  This is exactly what step 1 (abort/rewind collapse) is landing; the coarse
  entry must inherit its ABORT_UNWINDING discipline.

---

## 4. Payoff

- **`fm_*` host-called surface: ~74 → ~8-12.** 3-5 coarse phase entries +
  ~2-3 setup pushes (§1b, consolidating the 8 `fm_set_*`) + `fm_stats` +
  `fm_last_errno`. The 5 frozen `__wpk_fork_frame_*` re-exports and the injected
  reference-typed decode/drive shims (`__wpk_fork_ref_decode_*`,
  `fm_drive_execute`) remain — they are guest-ABI / walrus-injected, not
  host-sequencing surface. The ~40 fine-grained
  capture/unwind/replay/child/leaf exports either fold behind coarse entries or
  become module-internal (un-exported) once no host caller and no test needs
  them individually.
- **`fork-module-backend.ts`: ~989 → ~250-350.** It is currently thin 1:1
  wrappers (each: arg validation + one export + `requireOk`, e.g.
  `beginChildReplay`/`beginBorrowedChildReplay` at :693/:721). Collapsing to the
  3-5 coarse calls + errno check + `wptr`/`toNum` helpers removes the bulk;
  the in-flight abort/rewind collapse already removes the `*_fixed_arena` set.
- **`worker-main.ts` fork glue: ~150-300 fewer lines.** The seeding block
  shrinks as `fm_set_*` consolidates; the per-node exnref-gate decode feed
  (`fm_decoded_node_*`) deletes if the exnref tag-validity check moves into the
  module (needs exception-codec seeding). The entry/catch/phase loop
  (`:5253-5316`) and the syscall/spawn floor STAY.
- Larger deletions (the JS continuation twin, ~600-900 lines) are a SEPARATE
  policy question (retire the `useForkModule=false` fallback), tracked by the
  companion docs — NOT part of the inversion itself.

---

## 5. Effort, risk, phasing

**Increment sequence** (each independently gated: `cargo test -p fork-codec`/
`-p fork-module` host-native + Node Vitest fork suites + `check-abi-version.sh`;
browser Playwright + conformance batched at the end; every wasm rebuild must
re-sync `local-binaries/source-only-v1/` — the `build-wasm.sh` footgun):

1. **Step 1 (in flight, another agent): abort/rewind collapse + module-mode
   partial-capture abort (P-11).** Precondition — delivers `fm_abort` semantics
   and the ABORT_UNWINDING discipline the coarse parent entry inherits. Retires
   `*_fixed_arena`. Size M.
2. **Consolidate `fm_set_*` seeding into 1-2 descriptor pushes.** S, low risk.
   Pure setup; no sequencing change.
3. **`fm_child_reconstruct` coarse entry.** Absorbs restore/attach/decode/
   reconstruct/seed loop (leaf drive already module-internal). M. Risk: vfork
   borrowed + dlopen multi-activation seeding (`beginBorrowedChildReplay`,
   per-activation catalog) are the subtle cases; A/B on both hosts.
4. **`fm_parent_seal_capture` + `fm_parent_replay` coarse entries.** L, highest
   risk. Collapses capture-intern + unwind + serialize + replay behind two
   entries. Risks: guest-unwind state machine (must not over-drive
   `wpk_fork_unwind_end`); reentrancy/borrow-safety of the widened
   module→guest→module window (`ReferenceFeedCell`/`REFERENCE_STATE`); cross-host
   (Chromium nested-fork + WebKit host-exception were both historically fragile).
5. **Move the exnref tag-validity gate into the module** (seed exception codec;
   delete the `fm_decoded_node_*` feed + `worker-main.ts` per-node loop). M.
   Risk: fail-loud boundary — needs a corrupt-recipe test proving Rust still
   `EINVAL`s; WebKit re-confirm.
6. **Batch validation + M-SHIP:** one cross-host module-on run (Node Vitest full
   + browser Playwright fork smoke Chromium+WebKit + host-native + libc/posix/
   sortix), `check-abi-version.sh`, freshness re-sync, curated commits.

**ABI:** core work is host↔module only (the `fm_*` surface ships in lockstep
with the module; NOT the guest ABI). No `ABI_VERSION` bump, no guest
re-instrument — *provided* the coarse entries only re-order calls to guest
exports already table-eligible in `__wpk_fork_drive_table`. **Flag + stop if**
a coarse entry needs to `call_indirect` a guest export not currently
drive-table-eligible → that is a fork-instrument change → guest re-instrument →
package rebuild → its own ABI-considered increment (`fork-controlflow-into-module-scope.md`
§5.1). New host-imports into the module are host↔module contract (module rebuilt
in lockstep), not guest ABI.

**Top risks:** (1) guest-unwind state machine under coarser reentrant drive
(the P-11 landmine — step 1 must be rock-solid first); (2) cross-host parity —
every phase is Node + browser (campaign repeatedly hit Chromium-only nested-fork
traps + WebKit-only reflection/OOM); (3) reentrancy/borrow-safety of the widened
module→guest→module window; (4) freshness (stale `source-only-v1/` module runs
silently, size change 500s the browser projection).

**Honest uncertainties:**
- Whether the coarse `fm_parent_seal_capture` can catch/own the guest
  reconstruction drive without ANY new drive-table entry — needs a walrus/
  `fork-module-inject` audit of which guest exports are already table-eligible
  (I did not enumerate the drive table's current members).
- Whether pushing the entry/catch into a walrus shim (importing the fork-unwind
  `Tag`) buys anything given the trap-discrimination floor — I judge NO, but the
  Wasm-EH-catches-tagged-but-not-traps boundary should be confirmed empirically
  on WebKit before relying on it either way.
- Exact backend/worker-main line deltas are estimates from structure, not a
  mechanical count of a written refactor.
- I did not run any build or test; all "already works" claims about the leaf
  drive + `resolve_externref` are read from source and the injector's own
  documentation, not re-validated at runtime.
