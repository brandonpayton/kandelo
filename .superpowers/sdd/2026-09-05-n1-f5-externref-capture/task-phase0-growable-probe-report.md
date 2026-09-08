# Task: Phase 0 growable frame-allocator probe (Node) — VERDICT: PROBE-GREEN

Worktree: `/Users/brandon/kandelo-abi44-reconcile`
Branch: `brandonpayton/rust-first-abi44-reconcile`, base HEAD `a064d78ea`.
Probe commits (scaffolding only; Fix X + production behavior UNCHANGED):
- `a103464dc` — growable channel-arena backend toggle + `malloc-deep-fork.c`
  fixture (+ global-setup entry).
- `8818be7fd` — the four-scenario probe test.

---

## VERDICT: PROBE-GREEN

For a REAL program (heap grown via kernel-tracked `SYS_mmap`, as musl mallocng
does), the module's growable channel frame allocator places fork frames
coherently, grows the guest cleanly PAST the 2 MiB Fix X cap, and fails
truthfully on genuine OOM. The 2 MiB cap is a **FIXTURE ARTIFACT** of
`fork-memory-clone.c`'s raw `__builtin_wasm_memory_grow`, not a real
headroom/placement constraint. Fix X can be reverted in Phase 1.

**Crux (one line):** the fix-y clobber happens ONLY because the fixture grows
via `__builtin_wasm_memory_grow` (which the kernel MemoryManager never records,
so `find_gap` reuses those live pages); real growth is `SYS_mmap`-tracked, so
`find_gap` skips it and places frames in genuinely-free space above it.

---

## Where the growable path lives + how it was enabled

- The growable "Option B" channel allocator is fully intact in the module Rust
  `crates/fork-module/src/lib.rs`: `FrameArena::new_channel` (line ~1459),
  `begin_unwind_impl` (~1667), `serialize_journal_alloc_impl` (~2013), exported
  as `fm_begin_unwind` (3343), `fm_add_activation_unwind` (3366),
  `fm_serialize_journal_alloc` (3509). All three are still in
  `FORK_MODULE_REQUIRED_EXPORTS` (`host/src/fork-module-instance.ts:57/69/75`).
  Fix X did not remove them — it just stopped the backend from calling them.
- The backend `host/src/fork-module-backend.ts` under Fix X always drives the
  `fm_*_fixed_arena` exports. I added a `probeGrowableChannelArena` option that,
  when set, drives the channel exports instead (in `beginUnwind`,
  `addActivationUnwind`, `finishUnwindAndSerialize`) and skips
  `frameArena.allocate`.
- `host/src/worker-main.ts` reads `KANDELO_FORK_PROBE_GROWABLE_ARENA === "1"`,
  passes it into both backend construction sites (process + pthread parent), and
  routes the module-state arena to the growing `newModuleStateArena()`
  (`forkFixedFrameArena && !probeGrowableChannelArena`) so ALL THREE fork-time
  allocations (frame chunks, journal image, module-state page) channel-mmap.
- **NOTE:** the worker runs the COMPILED `host/dist/worker-entry.js`, so the
  probe requires `cd host && npm run build` after toggling (done here). The Rust
  module was NOT rebuilt — the channel exports already ship in the current
  `fork_module32.wasm` (133903 B, in sync across `host/wasm/` +
  `local-binaries/` + `local-binaries/source-only-v1/`).

This was a contained toggle + build, not surgery.

## The fixture

`host/test/fixtures/malloc-deep-fork.c` (fork-instrumented via global-setup):
grows the heap the REAL way — `malloc(6 MiB)` routes through mallocng to
`mmap(0, ...)` → `SYS_mmap` → kernel `find_gap` (a TRACKED mapping), faults every
page, then forks from a `target`-deep recursion so the continuation capture is
large. The child verifies the whole 6 MiB survived and writes privately; the
parent checks snapshot isolation. Unlike `fork-memory-clone.c`, it makes NO
strict zero-growth assertion — a real program never does.

## Observed placement / growth / OOM (concrete pages; `KERNEL_SYSCALL_LOG=1`)

Layout at fork under the growable path (page = 64 KiB; addr ÷ 0x10000):

| region | mmap | page | note |
|---|---|---|---|
| fork-module region | `7869488 → 0x950000` | 149 (~120 pp) | co-resident module |
| module setup scratch | `134 → 0x10e0000` | 270 | 1 page |
| **guest malloc (6 MiB)** | `6291476 → 0x10f0000` | **271..366** | TRACKED `SYS_mmap` |
| mallocng meta (PROT_NONE) | `131072 → 0x1700000` | 368..369 | |
| **fork-time frame chunks** | `65536 → 0x1720000 …` | **370, 371, …** | channel-mmap'd |
| journal image | `131072 → 0x18b0000` | 395..396 | |

(a) **Coherent placement, no clobber.** Every fork-time frame chunk lands at
page 370+ — ABOVE the tracked malloc region (ends 366) and its meta (368-369).
`find_gap` (only sees `mappings`/`reserved`/brk, `crates/runtime-core/src/memory.rs:178`)
skips the tracked malloc region entirely. The child re-verified all 96 malloc
pages intact (exit 0), so no live page was overwritten.

(b) **Grows cleanly past the 2 MiB cap.** depth=16000 (16007 captured frames):
GROWABLE completes, `pages=397`, child replays all 16007 frames, exit 0. The
frame chunks span pages 370..394 (~1.6 MiB) + journal — past Fix X's
single-activation frame budget. The SAME fork under default Fix X FAILS: the
bounded arena exhausts (between depth 8000 = pass and 16000 = fail) and the
capture crashes (`fork import reached while process continuation is capture`,
worker exit -1). So the cap genuinely bites deep forks; the growable path does
not.

(c) **Parent survives, child replays correctly.** All growable runs (depth 300 /
2000 / 4000 / 8000 / 16000) return exit 0 with `fork_module_child_frames ==
fork_module_frames` and preserved parent snapshot isolation.

(d) **Truthful OOM.** With `maxProcessMemoryBytes = 40 MiB`, the depth-16000
growable fork grows until the kernel refuses the child clone
(`ProcessMemoryCapacityError: admission budget 41943040 exhausted`); `fork()`
returns -1 to the guest (`recurse_and_fork rc=-1`, exit 2), the parent survives,
no clobber. A real `find_gap`/`max_addr` exhaustion surfaces the same way
(module `ChunkAllocator` → `channel_mmap` Err → capture aborts).

## Crux: fixture artifact vs. real constraint — EVIDENCE

- **Real (tracked) growth:** GROWABLE `malloc-deep-fork` depth 16000 → exit 0,
  coherent, unbounded. (scenario 1)
- **Untracked growth (the fixture):** running the UNCHANGED `fork-memory-clone`
  (raw `__builtin_wasm_memory_grow`) under the growable path → exit 6, "child
  lost grown-page boundary byte" (exit 4). The collision reproduces ONLY for the
  raw-grow fixture. (scenario 3)
- Mechanism confirmed in code: `find_gap` (`memory.rs:178-234`) merges only
  `mappings` + `reserved_regions` and starts at `mmap_base.max(program_break)`;
  it has no knowledge of raw `memory.grow` pages. mallocng sources heap from
  `mmap(0,…)`/brk — both tracked (`libc/musl/src/malloc/mallocng/malloc.c:249,308`).

So the fix-y/fixed-arena-mirror clobber was a property of the torture fixture's
untracked grow, NOT a general placement constraint. The module occupying low
pages only means frames grow the top for a real program — which is fine (the top
is genuinely free; no live page is touched).

## What this does NOT claim

- Node only. No browser, no conformance suites, no ABI check (no ABI-relevant
  code changed; the channel exports already ship).
- Fix X's cap, when a single deep fork exceeds it, currently manifests as a
  capture-state crash (worker exit -1), not a clean guest `-ENOMEM`. That is a
  Fix X robustness nuance (reinforces preferring the growable path), separate
  from the growable path's own behavior.
- The probe kept `forkFixedFrameArena` constructed (so the module region still
  reserves ~2 MiB even with the probe on); a Phase 1 revert would reclaim that.

## Validation run

- `host/test/malloc-deep-fork-probe.test.ts` (4 scenarios) → 4/4 pass:
  GROWABLE d16000 exit 0 pages=397; FIXED d16000 exit -1 (arena exhausted);
  CONTROL raw-grow-under-growable exit 6 (clobber); GROWABLE OOM exit 2
  (truthful fork=-1).
- Depth sweep 4000/8000/16000 (fixed vs growable): fixed passes 4000/8000
  (pages=370, no growth), FAILS 16000; growable passes all (pages 378/384/397).
- Placement trace via `KERNEL_SYSCALL_LOG=1` (pages above).
- Regression (probe OFF = production Fix X): `fork-memory-clone-guest`,
  `vfork-production-mechanism`, `fork-module-backend-abort`,
  `fork-module-backend-multi-activation` → 5/5 pass. Production behavior
  unchanged.
- `cd host && npm run build` (tsup) → typechecks + rebuilds dist.

## Recommendation

Proceed to Phase 1: revert Fix X and restore the growable channel allocator as
the production path, keeping a truthful `ENOMEM`/`MAP_FAILED` failure mode when
`find_gap`/admission cannot grant. Batch browser + conformance validation at
campaign end per the coordinator's plan.
