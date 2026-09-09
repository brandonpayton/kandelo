# Rust-First Fork: Point of No Return — Implementation Plan

**Goal:** Make the Rust fork-module the *only* capture/replay implementation —
dynamic (uncapped) frame allocation owned by the module, the movable host-TS
orchestration collapsed into Rust, and **no** TS continuation fallback: `fork()`
with no module in place is a fatal error. This is the irreversible flip that
completes the rust-first kernel campaign (PR #1350) for merge.

**Sole merger:** the maintainer. Nothing is pushed/merged without explicit ask.
All history curation happens at the end (see the separate curation spec).

## Locked decisions (maintainer, 2026-09-08)
- **ABI-44 released-binary rebuild: N/A** — no released binary build is
  maintained; local/source-only builds rebuild packages from source at ABI 44.
- **Final validation: build everything, run as many suites as possible,
  transparently** — announce each test set as it starts, stream progress, report
  per-suite results as they land.
- **Shape:** ~14 phase/feature-narrative commits at curation (see
  `pr1350-curation-spec`). Fix X becomes "dynamic mmap frame allocation" once
  reverted in Phase 1.
- **Validation cadence:** cheap single-host (Node) check after each phase; the
  one heavy cross-host + conformance battery is batched at the end (Phase 6).

## Ship-as-documented-gaps (NOT fixed here; truthful failures, out of fork scope)
- Writable `MAP_SHARED` cross-process at /tmp: already truthful (`EIO` +
  `[MAP_SHARED writeback lost]` diagnostic, no silent corruption); full
  kernel-handle fix is deferred ABI work; relates to the genuine wasm
  cross-process-shared-memory limitation.
- Standard POSIX stubs (`unshare`/`chroot`/`mount`/device nodes/orphan adoption).

---

## Phase 0 — Decisive growable-allocation probe (Node) — IN FLIGHT
Empirically settle whether the module-owned growing frame allocator (in-realm
channel `mmap`, commit `885781746`'s `FrameArena::new_channel`) works for a
**real-program-style** deep fork (heap grown via `malloc`→`SYS_mmap`→`find_gap`),
or whether a real headroom/placement constraint remains. Probe-only; no
production change. **Gates Phase 1.**
- GREEN → revert Fix X in Phase 1. BLOCKED → redesign around the real constraint.

## Phase 0.5 — Build-freshness / stale-artifact fixes (approved)
Close the ship-relevant staleness defects before dozens of fork-module rebuilds
poison validation:
- Kernel package `build.toml` `inputs` must cover the full kernel/runtime-core
  closure (e.g. `netif.rs` is new) — derive from the cargo closure, do not
  hand-list (pattern: `tools/xtask/src/build_deps.rs` fork-instrument closure).
- fork-module verify-fresh gate (deferred `L5`) + closure-track the out-of-band
  `build-wasm.sh` output so a size change invalidates the source-only manifest
  (the projection-freshness seam).
- **Validation:** touch an input → confirm the dependent artifact rebuilds
  not-cached; source-only/browser serve the fresh kernel + fork-module.

## Phase 1 — Restore dynamic mmap frame allocation; retire Fix X
Revert the bounded arena: delete `ForkFixedFrameArena`, the 2 MiB guest-memory
reservation, and the `fm_*_fixed_arena` wiring; finish the module-owned growing
allocator via in-realm channel `mmap`. **No fork-depth cap, no carved-out guest
region.** Realign the `fork-memory-clone` / P-10 / P-11 fixtures to the growable
model (as new correct behavior, not test-relaxing).
- **ABI:** host↔module; verify the frame-geometry change is not guest-observable.
- **Validation (Node):** deep forks grow cleanly past the old 2 MiB; parent
  survives; child replays; genuine OOM is truthful.

## Phase 2 — Module-mode partial-capture-abort (the P-11 / truthful-failure foundation)
Build the module-mode abort via the `worker-main.ts:5354` completion path
(`sealCapture()` + `beginAbortReplay(errno)`), so any mid-capture failure fails
truthfully and preserves the parent **with no fallback**. This is the
BLOCKED-DESIGN item that walled a prior agent (needs fork-instrument
guest-protocol work) and is the safety prerequisite for removing the twin.

## Phase 3 — Make the module back *every* fork (close the `useForkModule:false` gaps)
Eliminate the three fallback conditions at `worker-main.ts:3752`:
- **ptr-width mismatch** → instantiate the correct-width module on demand.
- **resume-catalog > 16384** (`FORK_MODULE_RESUME_CATALOG_CAP`) → raise / make
  dynamic.
- **fork-from-thread child lacking `wpk_fork_resume_thread`** → emit/handle the
  module resume path. ⚠️ May touch guest instrumentation (guest-artifact change /
  re-instrument) — **flag-and-discuss with the maintainer** before proceeding.

## Phase 4 — Point of no return: module-or-fatal + delete the JS continuation twin
Flip `fork()` to require the module (fatal otherwise), and delete the
~800–1000-line JS continuation twin in `fork-process-continuation.ts` (non-module
coordinator branches, `this.events`/`ForkReplayEventJournal`, the
`LinkedForkContinuation` JS frame storage). **Rust capture/replay is now the only
implementation.** Gated on Phases 2+3 being solid.

## Phase 5 — Collapse movable TS orchestration into Rust + add Rust-first agent guidance
- Shrink the `fm_*` surface (84 → ~40–45) by moving drive-sequencing/orchestration
  into the module (coarse `capture-and-seal` / `drive-plan` / `abort` /
  `attach-child` entries), fold the module-owned allocator cursor into Rust, drop
  the 11 proof-of-use counters. Reduce the fork glue toward the ~600–800-line
  irreducible host floor (worker spawn, `fork()` syscall + channel,
  `resolve_externref` identity, anyref-transit `Table.grow`, PIC placement, resume
  `Table`, worker-message bridges).
- **Add durable agent guidance** (in `docs/agent-guidance/host-runtime.md` +
  `debugging-and-posix.md` and the CLAUDE.md contract map): *Rust-first for kernel
  & fork — do not add kernel or fork control-flow TypeScript unless it is the
  irreducible host floor; when in doubt or facing a dilemma, stop and discuss with
  the maintainer.*

## Phase 6 — Batched final validation (transparent) → **manual-use pause** → curate
**6a. Validation.** Build everything, then run as many suites as possible,
**announcing each set as it starts and reporting results as they land**:
host-native (host triple), full Vitest (with `mariadb`/`ruby`/`vim`/network
artifacts built), the fork matrix, cross-host browser (Chromium + WebKit),
libc/posix/sortix conformance, ABI check.

**6b. Manual-use pause (HARD GATE — maintainer explicitly requested).** Build a
complete, fresh Kandelo web app from the campaign result, serve it (`./run.sh
browser --port <N> --strictPort`), hand the maintainer the URL, and **STOP** —
wait for the maintainer to manually exercise the app and sign off. Do not curate
or treat the campaign as done until they do. The built artifacts are tree-content
identical before/after curation, so serving here (pre-curation) is faithful.

**6c. Curate + merge.** On the maintainer's go: curate the campaign into ~14
phase-narrative commits (Fix X → "dynamic mmap frames"), hand over the
`git range-diff` for review, and leave the rebase-merge to the maintainer (sole
merger).

## Ordering rationale
Phase 0 gates everything (don't revert on a guess). 0.5 protects all later
validation from stale artifacts. Phases 2+3 must precede Phase 4 (can't remove the
fallback until the module handles every fork *and* fails honestly). Phase 5 is
cleaner after the twin is gone (one path to move). Validation batched at the end.

## Top risks (honest)
- Phase 0 could find a real headroom/placement constraint → growable isn't free;
  redesign with the maintainer.
- Phase 2 is the genuinely hard, previously-walled piece.
- Phase 3's fork-from-thread export may force a guest-artifact decision.
- Phase 4 removes the last fallback — needs Phases 2+3 rock-solid + the full battery.
