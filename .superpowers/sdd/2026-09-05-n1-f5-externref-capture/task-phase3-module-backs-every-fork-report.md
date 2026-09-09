# Phase 3 — Make the co-resident module back every fork

**Status:** DONE (case 3 turned out HOST-ONLY, not a guest-artifact change ⇒
no maintainer decision required).

**Branch:** `brandonpayton/rust-first-abi44-reconcile`
**Base HEAD:** `5725e6194`
**Commits:**
- `35a4e95a8` Fork: Make the co-resident module back every fork (Phase 3)
- `974e11c1b` Fork: Prove the raised resume-catalog cap backs large guests

## Goal

Eliminate the three `useForkModule = false` fallbacks at
`host/src/worker-main.ts:~3747` that silently routed a fork to the JS
continuation twin, so the co-resident fork-module backs EVERY fork; a genuine
impossibility must FAIL LOUD rather than silently use JS. Prerequisite for
Phase 4 (module-or-fatal, delete the JS twin). The JS twin is NOT deleted here.

## Starting state (evolved past the task description)

The module was already UNCONDITIONAL (a missing module throws), and a pointer
width mismatch already threw at `worker-main.ts:3599/6702`. The remaining
`useForkModule` predicate had three terms:
`ptrWidth === linkedFrameFormat.ptrWidth && (!isForkFromThreadChild ||
hasResumeThreadExport) && catalogOrdinals.length <= FORK_MODULE_RESUME_CATALOG_CAP`.

## Per-case outcome

### Case 1 — pointer-width mismatch: ALREADY SATISFIED (dead term removed)

The correct-width module is instantiated ON DEMAND per guest: each kernel
worker entry calls `forkModuleInitFields(detectPtrWidth(programBytes))`
(`node-kernel-worker-entry.ts:174-196,1571,1654`, browser
`browser-kernel-worker-entry.ts:151-162`), which lazily compiles/selects
`fork_module32` vs `fork_module64`. Node caches by width in
`forkModuleModuleByWidth`; the browser ships only wasm32 (its only guest width),
so a wasm64 browser guest gets no module and fails loud — a genuine
impossibility. A width mismatch between the guest's ptr width and its own linked
frame format still throws at `worker-main.ts:3599`. The
`ptrWidth === linkedFrameFormat.ptrWidth` predicate term was therefore DEAD
(unreachable-false) and was removed. No create-on-demand work remained.

### Case 2 — resume catalog > 16384: RAISED to 65536 (module-BSS structure)

The cap is a fixed BSS array in the fork-module Rust
(`crates/fork-module/src/lib.rs`: `RESUME_CATALOG: [u32; RESUME_CATALOG_CAP]`,
plus the per-activation `ACT_CATALOG_ORDS: [u32; ACTIVATION_CATALOG_ORD_CAP]`),
sized to survive the per-fork bump-heap reset — not a pure host cap. A truly
dynamic in-module catalog would need a persistent (non-reset) region the module
does not own, so per the plan's "raise / make dynamic" I raised the fixed cap.

**Real data drove the value.** Measuring the `kandelo.wpk_fork.resume_catalog`
(KFRC) section of every shipped fork-instrumented guest:

| guest | catalog entries |
|---|---|
| php-fpm | 19190 |
| php | 19026 |
| node / spidermonkey-node / js | 16555 |
| ruby | 8579 |
| wget | 6833 |
| git-remote-http | 6266 |
| cpython | 6192 |
| (all others) | < 4500 |

php-fpm, php, and node ALREADY exceeded the old 16384 cap — every fork in those
programs was silently taking the JS twin, and would have become FATAL after
Phase 4. Raised to **65536** (~3.4x over the largest, covers upstream growth):
- `crates/fork-module/src/lib.rs`: `RESUME_CATALOG_CAP` and
  `ACTIVATION_CATALOG_ORD_CAP` → `65_536`.
- `host/src/fork-module-backend.ts`: `FORK_MODULE_RESUME_CATALOG_CAP` → `65_536`.
- `crates/host-native/src/guest.rs`: `FORK_MODULE_RESUME_CATALOG_CAP` → `65_536`
  (its `_CATALOG_SCRATCH_BYTES = CAP*4` = 256 KiB auto-scales; carved from the
  module's 1 MiB shadow-stack padding → ~576 KiB shadow stack remains).
- `host/src/fork-module-instance.ts`: `FORK_MODULE_STAGING_BYTES` `1<<16` →
  `1<<18` (256 KiB) so a COPIED fork child stages its catalog into the inherited
  slab in place — a growing `mmap` would break the fork memory-clone size
  invariant.

Removed the silent JS fallback: the process-path predicate no longer gates on
the cap (the backend constructor throws loudly on overflow), and the pthread
coordinator path (`worker-main.ts:~6711`) now throws on overflow instead of
leaving `threadForkModuleInstance` null (which fell to JS via the `{}` import
branch at `~7059`).

**Footprint:** module `dylink.0 mem_info memorySize` grew ~384 KiB
(4592680 → 4985896 bytes); the wasm FILE size is unchanged (133903 bytes) since
BSS is zero-init and not stored. Region reservation is read dynamically from
`mem_info` on both hosts, so parent/child stay consistent.

**Not an ABI / guest-artifact change:** the cap is a fork-module-internal BSS
size; the guest catalog is READ from the guest (`read_fork_resume_catalog_
records`), never re-instrumented; the fork-module is a host-side co-resident
artifact; `dylink.0 mem_info` is read dynamically. `check-abi-version.sh` and
`xtask verify-fresh` both report the snapshot in sync with NO bump.

### Case 3 — fork-from-thread child lacking `wpk_fork_resume_thread`: HOST-ONLY

Investigated the export's origin. `emit_fixed_resume_boundaries`
(`crates/fork-instrument/src/instrument.rs:404,4516-4579`) is called
unconditionally during instrumentation and emits `wpk_fork_resume_thread` for
any guest that exports `__indirect_function_table`. A fork-FROM-thread by
definition has a pthread, created via a function-pointer `pthread_create` ⇒ the
guest necessarily has (and Kandelo's dlopen-capable SDK exports) the indirect
function table ⇒ the export is always present for a genuinely
fork-from-thread-capable guest. It landed with the ABI 43 batch, so all current
fork artifacts carry it.

⇒ Closing case 3 does NOT need a fork-instrument / guest-artifact change. It is
host-only: a fork-from-thread child missing the export is a stale /
mis-instrumented artifact, so the process path now FAILS LOUD (throws, prompting
a rebuild) instead of silently using JS. **No FLAG-AND-STOP required.**

## Files changed

- `host/src/worker-main.ts` — process path: removed the three-term predicate,
  added a case-3 fail-loud throw, set `useForkModule = true`; pthread path:
  fail-loud on catalog overflow.
- `crates/fork-module/src/lib.rs` — `RESUME_CATALOG_CAP`,
  `ACTIVATION_CATALOG_ORD_CAP` → 65536.
- `host/src/fork-module-backend.ts` — cap → 65536.
- `host/src/fork-module-instance.ts` — staging slab → 256 KiB.
- `crates/host-native/src/guest.rs` — cap → 65536.
- `host/test/fork-module-instance.test.ts` — new large-catalog proof test.
- Rebuilt + synced `fork_module{32,64}.wasm` (local-binaries, host/wasm,
  source-only-v1) and re-finalized the SourceOnly projection manifest (all
  gitignored artifacts).

## Commands run + results (dev-shell, host triple aarch64-apple-darwin)

- `cd host && npm run build` — GREEN.
- fork-module rebuild `bash crates/fork-module/build-wasm.sh` — wasm32 + wasm64
  staged; `--verify-fresh` GREEN (both widths match closure
  `2c972a1a…`).
- `cp` wasm to `local-binaries/source-only-v1/`; `./run.sh local-build` —
  98/98 nodes, projection re-finalized (manifest fork_module32 now size 133903 /
  sha `9c66454f…`).
- `cargo run -p xtask -- verify-fresh` — GREEN incl. the L5 projected
  fork-module gate; "abi: snapshot is in sync with sources", no fork-module
  staleness.
- **Large-resume-catalog proof** — `npx vitest run
  test/fork-module-instance.test.ts` — 6/6 PASS. New test seeds the REAL
  fork_module32: 20000 (past old cap) → `fm_last_errno`=0; 65536 (at new cap) →
  0; 65537 → 7 (E2BIG, fail-loud boundary).
- `npx vitest run test/fork-module-worker-instantiation.test.ts` — 1/1 PASS
  (real single fork driven through the module, nonzero committed frames).
- `npx vitest run test/fork-from-thread.test.ts` — 3/3 PASS (incl. module-backed
  concurrent pthread forks).
- `npx vitest run test/fork-continuation.test.ts
  test/fork-process-continuation.test.ts test/fork-resume-catalog.test.ts` —
  44 passed / 6 skipped.
- `npx vitest run test/vfork-fork-module.test.ts test/malloc-deep-fork.test.ts
  test/fork-module-backend-multi-activation.test.ts` — 4/4 PASS.
- `npx vitest run test/host-process-pointer-width.test.ts` — 20/20 PASS.
- fork-module harnesses (harness.mjs, harness-multi-activation.mjs,
  harness-capture.mjs) against the rebuilt wasm — ALL PASS.
- `cargo test -p host-native --lib --target aarch64-apple-darwin` — 45 passed,
  0 failed, 4 ignored.
- `cargo test -p fork-codec --target aarch64-apple-darwin` — 432 passed,
  0 failed.
- `scripts/check-abi-version.sh` — snapshot in sync, ABI_VERSION consistent,
  NO unexpected bump (`abi/snapshot.json` untouched per git status).

## Not run / concerns

- **Browser (Chromium/WebKit) not exercised.** All fork changes validated on
  Node + host-native only. The changes are in shared host files and a shared
  module artifact; the projection manifest was re-finalized so `./run.sh
  browser` should boot, but per the host-runtime contract a browser
  re-validation (fork smoke on both engines) is recommended before Phase 4.
- **Residual cap is still a fixed 65536.** A guest with >65536
  fork-instrumented functions now fails LOUD (no silent JS), consistent with the
  goal, but is not truly unbounded. A fully-dynamic module-owned catalog
  (host-provided persistent region the module retains by pointer) is a possible
  follow-up if a future guest approaches the cap.
- No conformance suites (libc/posix/sortix) run — deferred to the campaign's
  batched validation phase.
