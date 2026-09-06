# Rust-first kernel campaign — plan to completion (2026-09-05)

**Supersedes** `docs/plans/2026-09-04-rust-first-remaining-purpose-framed.md`
(kept for history; its §8.6 decisions are carried forward here). This is the
authoritative remaining-work plan. Branch: `brandonpayton/rust-first-abi44-reconcile`;
PR **#1350** (head `brandonpayton/epoll-kernel-route`). Worktree
`/Users/brandon/kandelo-abi44-reconcile`. Dev-shell + isolated cache:
`export KANDELO_SOURCE_CACHE_ROOT="$HOME/.cache/kandelo/reconcile-abi44"; scripts/dev-shell.sh bash -lc '<cmd>'`.

## Purpose (north star)

Minimize the host API surface every host must implement, and push
version-sensitive/semantic logic into the Rust kernel (deeper typechecking,
one shared implementation). The native wasmtime host (`crates/host-native`) is
the forcing function that proves the platform boundary is not secretly
JavaScript-shaped. POSIX correctness is the deciding rule; Node is a
sequencing cross-check, never a reason to mirror it. Truthful failure over
convenient illusion.

## The Bar (applies to every remaining piece)

- Host TS/Rust is not a home for reducible logic — migrate it into the kernel
  or a shared module; a host capability is the last resort.
- No host-specific replay/reference logic: the co-resident fork-module (shared
  Wasm) owns the algorithm; hosts supply only irreducible capabilities.
- ABI 44 is in-dev/unreleased — shape it freely; regenerate the snapshot;
  additive changes need no version bump; fold semantic changes into 44.
- Re-instrumentation / rebuilds are first-class (soundness > build cost).
- Every increment is green on unit + `host-native` tests before it lands. The
  full cross-host batch validation runs ONCE at the end (see §Decisions).

## Decisions carried forward (2026-09-05, user)

1. **Tier-2 wasmtime dependency acceptable.** Native uses wasmtime 48
   (exceptions proposal + GC); wasm threads/shared-memory is Tier-2. Native is
   the forcing function; V8 hosts stay production. Not gating native on Tier-1.
2. **Reference-completeness bar = ALL kinds, no `EOPNOTSUPP`** (externref incl.
   GC-derived, struct, array, i31, static-root) via the ONE shared module.
   **RECONCILED 2026-09-05 with `docs/fork-reference-support.md`:** that doc
   gates externref/struct/array/i31/static-root to `EOPNOTSUPP` at CAPTURE today
   (census: 0/113 packages carry them across a fork). That gate is the TEMPORARY
   truthful boundary, NOT a permanent exclusion — the bar STANDS. Key facts that
   make it achievable: the RECONSTRUCTION/replay half is ALREADY built + shared
   in the co-resident module for every kind (exercised in `fork-codec` tests);
   only the CAPTURE side + production-site PROVENANCE is missing, and
   re-instrumentation (the doc's "E1 floors") supplies it SOUNDLY (replacing the
   deleted unsound host reverse-lookup). So each kind un-gates by: re-instrument
   to record capture provenance → lift its gate → validate the already-built
   replay, on ALL three hosts. This IS the port-to-Rust of the remaining fork
   CAPTURE logic; nothing is excluded. Path: **I5b** (native capture PARITY —
   funcref/exnref capture in Rust + a real module-state arena; externref/GC/
   static-root cleanly `EOPNOTSUPP` matching Node/browser + fix the test) →
   **F5 = FLOOR-1** (re-instrument funcref/externref provenance → lift externref
   gate, all hosts) → **F6 = FLOOR-2** (GC struct=appended-field /
   array=wrapper-struct provenance → lift struct/array/i31/static-root gates).
   FLOOR-1 tractable; FLOOR-2 = hard whole-program transform (field reindexing
   under subtyping). Both are ABI epochs (rebuild fork packages).
   Capability-ahead-of-demand is intentional (completeness over YAGNI). This
   REPLACES the old B2/B3/M2/M3 framing below (references) with I5b→F5→F6.

   **2a. Capture↔Replay symmetry — the ORGANIZING LENS for all remaining
   reference-type work (user, 2026-09-05; preserve this framing every step).**
   For every reference kind, the replay/decode side is already built, shared,
   and frozen — and it IS the spec for capture. Capture is the inverse encoder
   that must produce exactly the recipe replay consumes. So frame each kind's
   remaining work as "invert the existing replay," which cleanly separates the
   cheap half from the real work:
   - **The mechanical half (often already built):** the wire WRITER is the
     bit-for-bit inverse of the decoder and frequently already exists in
     `fork_codec` (e.g. `ReferenceGraphBuilder::intern_externref` mirrors the
     externref decoder). Emitting the recipe node is essentially free.
   - **The one place symmetry BREAKS (the real work + the ABI floor):** replay
     is `handle/recipe → value` (a pure function of data already in the
     recipe); capture needs `live value → handle/recipe` (a relation replay
     never had to compute). That inverse CANNOT be recovered by inspection
     (that was the deleted unsound reverse-lookup) — it must be RECORDED at the
     value's PRODUCTION SITE via re-instrumentation (the "floor" for that kind).
   Per kind: **funcref** (done, I5b) — ordinal from the catalog. **externref**
   (F5) — handle recorded at the mint/host-import site. **GC struct/array/i31**
   (F6) — the host cannot introspect a live GC object at all, so provenance is
   recorded at construction. **static-root** (F6). Size each step by this split:
   the mechanical inverse is cheap; the provenance recording is the work and the
   reason each floor is an ABI epoch. Every F5/F6 grounding + plan MUST carry a
   "Replay↔Capture symmetry (<kind>)" section making the inverse explicit and
   pinpointing exactly where it breaks.
3. **Batch validation runs once, at campaign completion**, when all three hosts
   test the finished result on the same `kernel.wasm` (Node Vitest + browser
   Playwright + libc/posix/sortix). No interleaved cross-host validation.
4. **Close the native fork/exec residuals** (campaign scope, not shipped gaps):
   real vfork, non-main-thread fork/execve, multi-threaded-execve sibling
   teardown. For vfork, FIRST audit the existing campaign solution and wire
   native to it (do not reinvent).
5. **Pre-merge curation:** each curated commit is a self-contained unit of
   progress that stands + passes tests on its own (less granular than
   per-increment); drop dev-churn; preserve contributor attribution.

---

## Milestone map — from here to ship

Linear spine from the current state to a shippable, merge-ready rust-first
kernel. Each milestone has a completion GATE (how we know it's done). Detail
for each is in Part B (the `B*` references). "Shippable" = §Ship-definition
below. Cross-host validation happens ONCE, at M8 (§Decisions #3).

- **M0 — YOU ARE HERE (2026-09-05).** N1 breadth (I1–I3d) + N1-R done & pushed.
  wasmtime upgraded 35→48 + I4 T1 (co-resident module instantiation) + I4 T2
  (SYS_FORK/private-copy/child) committed locally (`f24d1e492`, not yet pushed).
  **I4 Task 3 (frame replay coordinator) is running.**
- **M1 — Native fork works, frames-only.** [B1] Gate: `smoke_fork_parent_child`
  green (parent+child resume, exit 3, `fm_frames_*>0`, refs inert/`==0`);
  concern-B guard; I4 whole-increment review (incl. the wasmtime-48 diff) clean;
  I4 + upgrade **pushed**.
- **M2 — Native fork references.** [B2/I5] Gate: funcref + externref + anyref
  reconstruct across a fork via the shared module; externref identity preserved;
  `ForkHostCapabilities` (tags) live, `native_sketch` ENOSYS gone.
- **M3 — All reference kinds (completeness).** [B3/F6 + B6 tidy + B4/F5] Gate:
  NO `EOPNOTSUPP` reference gate anywhere; externref (incl. GC-derived), struct,
  array, i31, static-root all fork correctly; funcref-capture residue eliminated
  (re-instrument); truth-in-gating arms fixed.
- **M4 — Fork/exec residuals closed.** [B5] Gate: real vfork (borrowed path,
  parent-suspend — audit-first); fork/execve from a non-main channel works;
  multi-threaded execve tears down non-parked siblings.
- **M5 — Host surface minimized.** [B-H] Gate: reducible host imports migrated
  out (H1 debug_log, H2 is_thread_worker, H3 last_errno, H4 net ioctls, H5
  /dev/shm+MemoryFileSystem; H-def opportunistic); host surface = irreducible
  device/engine capabilities only.
- **M6 — ABI 44 finalized.** [B7/N2] Gate: `ABI_VERSION`=44 + regenerated
  `abi/snapshot.json` committed together; all ABI-adjacent changes reconciled;
  all binaries rebuilt. (Cutting the public `binaries-abi-v44` release = user's
  call.)
- **M7 — Flip default-on + delete twins.** [B8/F2] Gate:
  `WASM_POSIX_FORK_MODULE` default ON (Node+browser); dead flag-off JS
  reconstruction + frame/journal engine deleted; user dogfood. (HELD for user.)
- **M8 — Freeze gate + FULL cross-host validation.** [B9/Z1–Z3] Gate: the SAME
  `kernel.wasm` boots on Node + browser + native; the seven completion criteria
  hold (incl. TS out of the dispatch path, benchmarks on Node+browser); the ONE
  batch validation is GREEN on all three hosts (Node Vitest + browser Playwright
  + libc/posix/sortix). This is the acceptance gate for "shippable."
- **M-SHIP — Curate + merge.** [B9/Z4] Gate: history curated into self-contained
  testable units (attribution preserved; `git range-diff` verified); **user
  rebase-merges PR #1350** (+ ABI-44 release, user's call). **= SHIPPED.**

Critical path: M1→M2→M3 (fork+refs are the deep core, the main remaining risk).
M4 shares that machinery. M5 (Workstream H) is largely parallel (H1/H2/H4 any
time). M6 gates on everything ABI-adjacent settling. M7 (flip) is held for you
and pairs with M8 (validate the shippable default-on config). M-SHIP is yours.

## Ship-definition (what "completely finished, shippable" means)

The rust-first kernel is shippable when: the SAME `kernel.wasm` runs on Node,
browser, and native wasmtime; TS is out of the syscall dispatch path and the
host surface is down to irreducible device/engine capabilities; fork / vfork /
exec fully work with ALL reference kinds (no `EOPNOTSUPP`); the fork-module path
is default-ON (F2) with the JS twins deleted; ABI 44 is finalized; the full
batch validation passes on all three hosts; and history is curated for a clean
rebase-merge of PR #1350 (which the user performs, along with the ABI-44
release decision).

## Part A — DONE (landed on the PR branch; do not redo)

| Item | What | Commits (head) |
|---|---|---|
| Reconciliation | one canonical ABI-44 tree (transport + fork lines) | (pushed) |
| F1 | fork abort-replay into Rust (`fork-codec`/`fork-module`) | (pushed) |
| N1-I1 | native sandboxed in-memory VFS default + native-dir mount | 1307157ea / 11057f0aa / 9f3ac79ea |
| N1-I2 | native real in-memory base image via `host_blob_read` | 937216230 / 16ed9cea4 |
| N1-I3a | native posix_spawn + parked `host_waitpid` (N-process pump) | 66672e254 / 9618b2f0e / f71c314bb / 5dee3f0b0 |
| N1-I3b | spawn bytes from the in-kernel VFS (exec-target authority) | ee1a0031b / 9749ed480 / d4db3e8a5 |
| N1-I3c | native execve (image replacement) | 14d088c55 / b45ef44eb |
| N1-I3d | execveat + KERNEL-owned `#!` shebang (`kernel_exec_target_resolve_shebang`) | f0696f6f2 / 6568864a3 / 53f447f05 / 62ecf6188 / a859c8e1d |
| N1-R | native thread reclamation (cooperative `TEARDOWN` sentinel) | d8981e940 / c556f763d / a65021be9 |
| wasmtime upgrade | host-native 35 → 48 (exceptions + GC enabled) | f24d1e492 |
| N1-I4 (partial) | co-resident fork-module instantiation (T1) + SYS_FORK path/private-copy/child (T2) | 9c9856c3e / 6761030d3 |

**N1 "predictable breadth" (I1–I3) is complete.** All above are pushed EXCEPT
I4 T1/T2 + the wasmtime upgrade (committed locally on `f24d1e492`, not yet
pushed — will push when I4 lands).

---

## Part B — REMAINING work, sequenced, with concrete steps

Each item below becomes its own `superpowers:subagent-driven-development`
increment (fresh implementer per task, task review, whole-increment review,
push) unless noted. "Green" = the item's tests + no host-native regression.

### B1. N1-I4 — native fork FRAMES (finish)  — IN PROGRESS
Co-resident module drives frame-only replay; references stay `EOPNOTSUPP`.
- **T3 (in flight, agent a0d91a7098827572b):** instrument the `native_fork`
  fixture (`scripts/run-wasm-fork-instrument.sh`) + drive the `fm_*` coordinator
  (capture → serialize → parent-replay → child-replay). Acceptance:
  `smoke_fork_parent_child` — both "child" + "parent", exit 3, `fm_frames_*>0`,
  `fm_*_reconstructed==0`, inert ref imports untouched.
- **Guard** Task-2 concern B (`launch_process` failure after
  `kernel_fork_process` → reclaim/rollback the kernel record).
- Whole-increment review (opus) over the I4 range INCLUDING the wasmtime-upgrade
  diff (confirm the Tier-2 `shared_memory`/threads + exceptions/GC config
  doesn't change kernel/guest behavior). Then **push** I4 + upgrade.
- If T3 re-blocks: surface (strong doubt).

### B2. N1-I5 — native fork REFERENCES (frames→refs)
Reconstruct references through the SAME co-resident module (Path B): no
host-specific reference logic. This is where the module's ref path
(`fm_begin_reference_replay`, `fm_ref_*`, funcref/anyref catalogs,
`resolve_externref`, the `ForkHostCapabilities` tag methods) goes live natively.
- **Step 1 — audit + wire the module ref path:** map the module's reference
  exports/imports (grounding: `fork-module/src/lib.rs:3210-3549`,
  `host_capabilities.rs`) and what native must provide: the funcref
  `__wpk_fork_function_catalog` + `__wpk_fork_drive_table`, the anyref
  `__wpk_fork_static_root_catalog` + `__wpk_fork_ref_gc_transit`, and
  `resolve_externref(handle)->externref`. wasmtime 48 GC (`Rooted`/`RootScope`)
  backs these host-side.
- **Step 2 — `ForkHostCapabilities` (replace the `native_sketch` ENOSYS):**
  `mint_exception_tag`/`provide_unwind_transport_tag`/`recognize_unwind_transport`
  via wasmtime `Tag::new`/`Tag::eq`; hold refs via `Rooted<ExternRef>`/`RootScope`
  generations. These are CAPABILITIES; the reconstruction ALGORITHM stays in the
  module.
- **Step 3 — externref identity floor:** honor the one documented floor
  (internalized externref not eq-comparable; handle→externref host
  materialization). Prove eq/identity across a fork.
- **Acceptance:** a fork fixture that captures references (funcref + externref +
  anyref) reconstructs them correctly across the fork; `fm_*_reconstructed>0`;
  identity preserved.

### B3. F6 — full reference-kind reconstruction (remove EVERY `EOPNOTSUPP` gate)
Completeness goal (bar: ALL kinds). Builds on I5's substrate.
- Enable + prove each kind end-to-end across a fork, on native AND (module is
  shared) available to Node/browser: externref incl. **GC-derived**, **struct**,
  **array**, **i31**, **static-root**. Remove each `EOPNOTSUPP`/gated-abort arm
  as its kind is proven (`worker-main.ts` gated arms + `lib.rs` gates + the
  module's `fm_build_gc_plan`/`fm_drive_*`).
- **Acceptance:** no `EOPNOTSUPP` reference-kind gate remains; a fixture
  exercising every kind forks correctly.

### B4. F5 — funcref-capture re-instrument (supported-path residue)
The one live supported-path reference residue; ABI-affecting (guest
re-instrument → rebuild fork packages). Determine if native's direct
`Func`-in-Store handling (I5) subsumes it for native and re-instrument is only
needed for Node/browser; scope accordingly. Re-instrument via
`scripts/run-wasm-fork-instrument.sh`; rebuild affected packages.

### B5. Close the native fork/exec residuals (§Decisions #4)
- **R1 — real vfork.** FIRST audit the existing solution (kernel `MODE_VFORK` +
  `kernel_fork_process` mode; fork-module `begin_borrowed_child_replay_impl`;
  Node/browser vfork branch; F1). Then wire native `SYS_VFORK` → the borrowed
  path: child shares the parked parent's memory; parent SUSPENDS until child
  exec/exit. Acceptance: a vfork fixture where the child modifies shared state +
  execs, parent resumes after, matching Node/browser.
- **R2 — fork/execve from a non-main (worker/pthread) channel** (currently
  traps). Make the pump handle fork/exec initiated off the main channel.
- **R3 — multi-threaded execve** tears down NON-parked compute-bound siblings
  (today only channel-parked siblings reclaim via `TEARDOWN`). Likely needs a
  mechanism to force a compute-bound sibling to a reclaim point (revisit the
  spike's alternatives; a bounded cooperative checkpoint).
- May share one increment or split; sequence after B1–B2 (shared machinery).

### B6. Truth-in-gating tidy-up (small)
Tighten leftover untruthful "admit externref" arms (`worker-main.ts:4444`,
`lib.rs:2258`) + make the table-journal path abort truthfully on gated kinds
instead of publishing placeholders. Folds naturally into F6.

### B-H. Workstream H — small independent host-surface migrations
Pure "minimize host surface" work, independent of fork/native; each removes a
reducible host import or TS-computed semantic. Land before N2 (the host surface
must settle before ABI finalization + the Z3 "TS out of dispatch path"
criterion). Small ones can batch into one increment.
- **H1 — `host_debug_log` → narrow sink.** The decode + `console.log`
  (`kernel.ts:1540`) is reducible glue; keep only a raw stderr sink. Move the
  formatting into the kernel; host provides a byte sink.
- **H2 — `host_is_thread_worker` → init-time config.** Static wiring the host
  knows at init (`kernel.ts:2043`); move into the kernel init payload, removing
  a per-query import.
- **H3 — `host_last_errno` → in-band return.** ABI artifact of smuggling an
  `Errno` beside a `u32` handle (`fork-module/src/host_capabilities.rs:68`).
  Native already returns `Result`; fold the Node/browser side into a richer
  in-band encoding so the import vanishes everywhere. (Confirm what N1/I5 already
  removed vs. what remains for Node/browser.)
- **H4 — synthetic network-interface ioctls → Rust.**
  `SIOCGIFHWADDR/IFCONF/IFNAME/IFADDR/IFINDEX` are computed 100% in host TS from
  a TS `VIRTUAL_INTERFACES` table + a TS random MAC (`kernel-worker.ts:20017`,
  `:941`, `:3435`) — reimplemented kernel semantics needing no host capability.
  Move to `runtime-core` constants + a Rust-owned MAC.
- **H5 — `/dev/shm` + `VirtualPlatformIO`/`MemoryFileSystem` deletion.** Larger,
  capability-gated: the `/` authority is done, but Phase 5.3's goal (delete
  `MemoryFileSystem` + `VirtualPlatformIO`; collapse FS imports to byte leaves)
  + subsuming `/dev/shm` (`node-kernel-worker-entry.ts:1151`) into kernel
  `tmpfs.rs` needs SAB-shared `mmap` handled in Rust first. Sequence after the
  mmap capability exists; may be its own increment.
- **H-def — async completion-channel park (`host_wait`/`host_wake`).** Deferred
  cleanliness/perf upgrade (today: `Atomics.waitAsync` + `host_futex_wait`).
  Land opportunistically; not required for correctness or the freeze gate.
- **Acceptance:** each migrated import is gone from the host surface (grep the
  host import list); behavior unchanged (unit + host-native green; cross-host
  proven in the final batch). Every removed import advances Z3.

### B7. N2 — ABI-44 finalization
- Confirm `ABI_VERSION` (44) + regenerated `abi/snapshot.json` in one commit;
  reconcile every ABI-adjacent change accrued (kernel exports incl.
  `kernel_exec_target_resolve_shebang`, the `TEARDOWN` status value, fork
  contract). Rebuild all binaries; cut the immutable `binaries-abi-v44` release
  + `index.toml` ledger per `docs/abi-versioning.md` (release step is the
  user's call — do NOT cut a public release without confirmation).

### B8. F2 — the flip (HELD for the user)
Default-on flip + delete the dead frame/journal JS engine. HELD for user
dogfood + the full validation below. Not scheduled by the agent.

### B9. Phase 7 — freeze gate + FINAL BATCH VALIDATION
- **Z1** host-adapter manifest (ABI 44, capability bitset, resource limits,
  channel checksum). **Z2** the SAME `kernel.wasm` boots on browser + Node +
  native. **Z3** the seven completion criteria (TS out of dispatch; guest-ABI
  reshape needs zero `host/src` edits unless it adds a host capability; three
  hosts share `runtime-core`; parity at every green commit; unsupported caps
  fail with a defined error; perf claims backed by before/after benchmarks on
  Node AND browser; the record decoder fuzzed + property-tested).
- **FINAL BATCH VALIDATION (§Decisions #3):** Node Vitest + browser Playwright +
  libc/posix/sortix conformance, all three hosts, same image. This is the ONE
  cross-host validation gate. (Also builds/uses the native conformance runner —
  the former "I6".)
- **Z4 — curate history** (§Decisions #5: self-contained testable units;
  preserve attribution; `git range-diff` + `git log --format=fuller` before
  force-push) → rebase-merge (the user is sole merger).

---

## Part C — Sequence

```
B1 N1-I4 frames (finish + push)         ← in progress
   ▼
B2 N1-I5 references (native ref path + ForkHostCapabilities + externref floor)
   ▼
B3 F6 full reference-kind reconstruction (remove all EOPNOTSUPP)  [+ B6 tidy-up]
   ▼
B4 F5 funcref re-instrument (scope by whether I5 subsumes native)
   ▼
B5 residuals R1 vfork (audit-first) / R2 non-main-thread / R3 multi-thread execve
   ▼
B-H Workstream H host-surface migrations (H1/H2/H4 small batch; H3 finish;
    H5 gated on Rust SAB-mmap; H-def opportunistic)   [largely independent —
    H1/H2/H4 can run in parallel with B2–B5]
   ▼
B7 N2 ABI-44 finalization (snapshot + version + rebuild; release = user's call)
   ▼
B9 Z1–Z3 freeze gate + FINAL BATCH VALIDATION (all 3 hosts) + Z4 curate → merge
   (B8 F2 flip: HELD for user, folded in around dogfood/validation)
```

Dependencies: B2 needs B1 (frames before refs). B3 needs B2 (ref substrate). B5
shares B1–B2 machinery. **B-H is mostly independent** — H1/H2/H4 can land any
time (parallel with B2–B5); H3 finishes after I5; H5 waits on a Rust SAB-`mmap`
capability. **B7 (N2) must come after both the fork/ref work AND Workstream H**,
since every removed host import + ABI-adjacent change must settle before the
snapshot is finalized. B9 last.

## Part D — Execution discipline (how each item lands)

- One `subagent-driven-development` increment per B-item (its own plan doc under
  `docs/superpowers/plans/`, SDD ledger, fresh implementer per task, task review
  + whole-increment review). Consolidated review cadence (per-increment, not
  per-task) unless a task is high-risk/ABI/concurrency — then review it directly.
- Ground each item first (read source; a read-only research agent for the hard
  ones — as done for thread-reclamation + I4) before writing its plan.
- Push each increment to the PR branch on green (FF). Keep the PR description
  current.
- Surface as a strong-doubt: any wasmtime/kernel wall, any ABI-version-bump
  demand, any need to add host surface, or any place the co-resident/shared
  model can't hold.

## Part E — Definition of done (campaign complete)

All `EOPNOTSUPP` reference gates removed (B3); native fork/vfork/exec fully
work incl. residuals (B1/B2/B5); the reducible host imports migrated out
(Workstream H — B-H); ABI 44 finalized (B7); the same `kernel.wasm` boots +
passes the full batch validation on Node + browser + native (B9); **TS is out
of the syscall dispatch path and the host surface is down to genuinely
irreducible device/engine capabilities** (the north star); history curated;
ready for the user to rebase-merge PR #1350. F2 flip executed around user
dogfood.
