# Fork control-flow inversion — capture-seal fold (fm_parent_seal_capture)

Status: DONE (ABI-neutral). The capture unwind-end + serialize fold — the piece
prior passes stopped-and-argued — landed sound and Node-validated. Browser leg
owed to the coordinator.

Worktree `/Users/brandon/kandelo-abi44-reconcile`, branch
`brandonpayton/rust-first-abi44-reconcile`. Built on `8a192b237` (parent
replay/abort coarse entries).

## Commits

- `c47735247` Fork: Add DRIVE_OP_UNWIND_END seal drive op to the drive-plan codec
- `5174f238a` Fork: Teach the drive shim the () -> () UNWIND_END call_indirect
- `acd0b537e` Fork: Add the coarse fm_parent_seal_capture module entry
- `d310fb23c` Fork: Route the capture seal through the coarse module entry

## The coarse entry + the DRIVE_OP_UNWIND_END mechanism

`fm_parent_seal_capture(channel_base) -> ptr` (`crates/fork-module/src/lib.rs`)
folds the whole capture seal into ONE module call:

1. `build_seal_plan_impl` — one `DRIVE_OP_UNWIND_END` step per open activation
   (ascending id order; `activations` is a `BTreeMap`), argument-free.
2. drive the plan through the injector-wired shim (`drive_plan_via_injector` —
   the SAME `__wpk_fork_drive_plan` placeholder → `fm_drive_execute` seam
   `fm_parent_replay` uses). Each step `call_indirect`s the guest
   `wpk_fork_unwind_end()` (UNWINDING → NORMAL).
3. `finish_unwind_impl()` — seal every activation's frame writer + the process
   journal (pure Rust).
4. `serialize_journal_alloc_impl(channel_base)` — channel-mmap + serialize the
   child-inheritable KFRE image (pure Rust). Returns the image ptr.

The NEW drive op is the crux: `wpk_fork_unwind_end` is a `() -> ()` guest export
(`fork_instrument::runtime::emit_end_fn` — empty signature), UNLIKE every prior
drive op. So:

- `crates/fork-codec/src/drive_plan.rs`: `DRIVE_OP_UNWIND_END = 9`,
  `DRIVE_SLOT_UNWIND_END = 7`, `DRIVE_SLOTS_PER_ACTIVATION` bumped 7 → 8, and
  `append_unwind_end_steps`. The stride bump is an EPHEMERAL runtime
  host<->module table-binding contract (every side derives slots from
  `drive_table_base`), so it is additive, not a wire/ABI format change.
- `crates/fork-module-inject/src/main.rs`: the injected `fm_drive_execute` shim
  gains a `void_indirect_ty = () -> ()` and a `DRIVE_OP_UNWIND_END` branch that
  `call_indirect`s the guest export reading ONLY the step slot (no arg). It is
  matched BEFORE the `>= DRIVE_OP_REWIND_BEGIN` pointer-drive branch because op 9
  is also `>= DRIVE_OP_REWIND_BEGIN` (7). Being `>= DRIVE_OP_RESTORE` it is
  excluded from the reconstruction-step proof counter (a control flip, not a
  reference reconstruction).

## Host sequencing deleted

`host/src/fork-process-continuation.ts` `sealModuleCapture`: the per-activation
`requireExportFunction(activation, "wpk_fork_unwind_end")()` loop and the
`backend.finishUnwindAndSerialize()` call are GONE. It now binds each
activation's `wpk_fork_unwind_end` into the drive table
(`bindActivationSealDrive`) then issues ONE coarse call
(`backend.sealCaptureAndSerialize()`), with the per-activation NORMAL assertion
moved to a single post-drive sweep (mirroring `beginModuleParentReplay`).

`host/src/fork-module-backend.ts`: added `sealCaptureAndSerialize()` and
`bindActivationSealDrive()` (binds `wpk_fork_unwind_end` into
`fm_drive_table_base(act) + DRIVE_SLOT_UNWIND_END` — the ref-typed table write is
a host floor). `host/src/fork-module-instance.ts`: `fm_parent_seal_capture` added
to the required-export list. The fine-grained `finishUnwindAndSerialize` /
`sealForAbort` wrappers are RETAINED (module-only unit tests + the partial-abort
path).

## Full-seal vs abort path kept distinct (avoiding the prior traps)

The two prior traps were (a) driving `wpk_fork_unwind_end` during a mid-
`select_unwind_frame` PARTIAL capture and (b) `beginModuleCaptureAbort` on a
partial capture. `fm_parent_seal_capture` seals a COMPLETE unwind (every frame
committed) — it is called ONLY from `sealModuleCapture`, which the coordinator
reaches only after capture completed. The partial/aborted path is untouched: a
mid-unwind `frame_reserve` failure still routes through the reserve wrapper →
`beginModuleCaptureAbort` → `backend.sealForAbort()` (`fm_finish_unwind` ONLY, NO
unwind-end drive) + abort-replay. The two paths share no code and neither drives
`wpk_fork_unwind_end` on a partial capture. The doc comments on
`DRIVE_OP_UNWIND_END`, `append_unwind_end_steps`, `seal_capture_impl`,
`fm_parent_seal_capture`, and `sealCaptureAndSerialize` all state this contract.

## Host-visible floors preserved

- JS run-loop exception catch (catchable tagged unwind Exception vs uncatchable
  `kernel_exit` trap): untouched. It lives in the worker run-loop and fires when
  the capture unwind reaches the top of the stack, BEFORE seal — the fold does
  not touch it. Validated by the C-* (fork-in-EH-catch) fixtures passing.
- Seal-time `ContinuationAllocationError` OOM reroute: preserved.
  `fm_parent_seal_capture` returns 0 with `fm_last_errno` set on a journal-image
  mmap failure (AFTER `finish_unwind` sealed + guest at NORMAL) rather than
  trapping; `sealCaptureAndSerialize` reads `lastErrno()` and throws the typed
  `ContinuationAllocationError`, and `sealModuleCapture`'s catch reroutes to
  `sealed-parent` + rethrow so the caller drives `beginAbortReplay`. Validated by
  P-11.

## fm_* surface delta

`fm_*` exports 76 → 77 (ADDITIVE: `fm_parent_seal_capture`). The HOST-CALLED
sequencing surface dropped: a per-activation guest `wpk_fork_unwind_end` loop +
`fm_finish_unwind` + `fm_serialize_journal_alloc` collapse to one coarse call.
The fine-grained exports stay exported (unit tests + partial-abort).

## ABI status

ABI-NEUTRAL, no `ABI_VERSION` bump. `fm_parent_seal_capture` and
`DRIVE_SLOT_UNWIND_END` are the host<->module contract, not the ABI snapshot; the
drive table binds guest exports BY NAME so there is no fork-instrument change and
no guest re-instrument. `check-abi-version.sh`: consistent. No needed guest
export was ineligible for the drive table, so the reinstrument authorization was
not exercised.

## Validation (Node; aarch64-apple-darwin; browser owed at Phase 6)

- `cargo test -p fork-codec`: 436/0 (was 434; +2 for the stride + unwind-end
  plan tests).
- `cargo test -p fork-module-inject`: 2/0.
- `cargo test -p host-native --lib`: 45/0/4 (unchanged; native stays on the
  fine-grained exports).
- Vitest, real forks through the coarse seal:
  - `fork-continuation` + `vfork-production-mechanism` + `fork-module-backend-abort`
    + `fork-module-gc-replay`: 12/12.
  - `fork-from-dlopen-side-module-e2e` + `malloc-deep-fork`: 9/9 (multi-activation
    dlopen exercises the new stride).
  - `fork-module-backend-abort` + `fork-module-backend-multi-activation`: 4/4
    (retained fine-grained wrappers + new coarse method).
  - `fork-instrument-coverage` P-* / C-* / S-* / K-*: 31/31 with
    `--testTimeout=60000` (each fixture cold-boots a kernel ~8.7s > the default
    5s; the default-timeout batch failures were cold-boot timeouts, NOT a hang —
    confirmed by P-10 passing alone). P-10 = deep multi-chunk continuation seal;
    P-11 = the seal-time ENOMEM reroute (the ContinuationAllocationError floor);
    C-* = the exception-catch floor. The D-* dispatch fixtures were skipped:
    D-01 has a PRE-EXISTING harness timeout (documented at the base) unrelated to
    fm_*/fork_module.
- fork-module wasm rebuilt + re-injected (both widths, build-key
  `0e3fb408…`), restaged into `local-binaries`, `host/wasm`, `source-only-v1`.
- `./run.sh local-build` re-finalized the SourceOnly projection (the manual `cp`
  updates bytes but not the projection manifest closure key).
- `cargo run -p xtask --target aarch64-apple-darwin -- verify-fresh`: CLEAN (exit
  0) after reproject.
