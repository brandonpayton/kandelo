# Rust-First Kernel Campaign — Purpose-Framed Remaining Plan

**Status:** authoritative remaining-work plan as of 2026-09-04.
**Branch:** `brandonpayton/epoll-kernel-route` (PR #1350), plus the
un-integrated `rust-first-phase2/3/4` stack (see §5).
**Supersedes** the scattered ledgers listed in §8 as the single source of
truth for *what is left and why*. Per-slice implementation plans are still
written just-in-time via the writing-plans skill as each slice is executed.

This document exists because agents keep drifting off-purpose (choosing
host-TypeScript solutions, fearing ABI bumps, mistaking already-minimal
seams for work). Read §1 and §2 before proposing or classifying any change.

---

## 1. The purpose (north star)

**Primary:** minimize the required host implementation / host API surface
that *every* host (Node, browser, native wasmtime, and future hosts) must
provide. Fewer, smaller, well-typed host obligations = cheaper portability.

**Secondary:** move logic into Rust, whose typechecking is far deeper than
TypeScript's — so the same logic is written once and verified harder.

**A clarification that prevents a common misreading:** "minimize host
surface" targets *reducible logic*, not device-capability count. The host
must always own real devices — filesystem bytes, sockets, wall-clock,
CSPRNG, GPU/display, worker spawn, the `Atomics.wait` primitive, invoking
guest exports. The campaign does **not** try to delete those. It targets
host code that *interprets the guest ABI* or *reimplements kernel
semantics* — logic that could run in Rust and be shared by all hosts.

---

## 2. The Bar (apply to any piece of host logic)

For any host-side logic on a kernel / syscall / fork / VFS / blocking path,
classify it and act accordingly:

1. **IRREDUCIBLE-HOST** — it needs a capability only the instance-holding
   host can provide: invoking guest wasm exports; minting/holding host
   object references (`externref`); creating a `WebAssembly.Tag`; spawning
   a worker/thread; compiling/instantiating a wasm module; the raw
   `Atomics.wait` blocking primitive; or reaching a real device (FS bytes,
   sockets, clock, CSPRNG, GPU). It stays host — but must be **named and
   justified** in the host-seam list, kept minimal and typed.

2. **MIGRATE-TO-RUST** — reducible logic that does *not* need a host-only
   capability. It **must** move to Rust. Preference order:
   `runtime-core` / `fork-codec` (pure typed logic, reused by every host
   including native) → a co-resident or walrus-injected wasm module (when
   wasm-level ref/table ops are needed) → the kernel. **Host TS is not an
   acceptable home for reducible logic** merely because it is faster to
   write or avoids a rebuild. (This rule was violated when abort-replay was
   first scoped as host-TS coordinator glue.)

3. **DELETE-TWIN** — a redundant JS fallback that runs only when a flag is
   off and is already reimplemented in Rust/injected-wasm. Deleted at the
   flip, not preserved.

4. **ABI is not a constraint, and neither is build cost.** ABI 44 is in
   development on this branch; shape it freely (fork-module exports,
   host-adapter trait, kernel plumbing) to best serve the purpose, and
   reconcile `abi/snapshot.json` at the epoch's end like the rest of the 44
   work. **Guest re-instrumentation is a first-class tool, chosen on
   engineering soundness — not avoided for build cost.** The ABI-44 epoch
   already forces a full rebuild of every package, so re-instrumentation's
   marginal cost is ~zero; do not treat it as a "last resort" or dodge it to
   save a build. When re-instrumenting is the soundest design (e.g. recording
   funcref/externref provenance at production sites, inline GC provenance),
   prefer it over a thinner-but-weaker host residue. Momentary build cost
   never outranks the most sound engineering.

5. **Truthful failure over illusion — and gates are temporary.** A shape not
   yet implemented is gated as a loud, defined `EOPNOTSUPP`, never faked. But
   a gate is a temporary truthful state, not a target end-state: the goal is
   the most complete platform (YAGNI deprioritized, user directive
   2026-09-04), so every gated fork reference kind is targeted for real
   implementation (see F6), not left unsupported because "no package needs it
   today."

---

## 3. Where the campaign stands (settled — do not re-open)

Phases 0–5 are done; the fork migration (Phase 6) is far along. Concretely:

- **Phase 0–1** (homebrew decouple, crate split): merged.
- **Phase 2** (opaque syscall transport): **done.** The host no longer
  *defines* the guest ABI — it consumes a `cargo xtask dump-abi`-generated
  mirror (`host/src/generated/abi.ts`, source `crates/shared/src/
  host_abi.rs` + `channel_scalar.rs`). `#handleSyscallInner`
  (`kernel-worker.ts:11750`) branches on syscall numbers only to route to
  host capabilities or cross-memory marshaling; semantics fall through to
  `kernel_handle_channel`. (One residue — §4/H4.)
- **Phase 4** (blocking/readiness): **done for readiness computation.** The
  kernel computes poll/select/epoll readiness (`runSelectKernelAttempt`;
  `handleEpollPwait` now dispatches `SYS_EPOLL_PWAIT`,
  `kernel-worker.ts:19594`). The host retains only the wait/retry
  orchestration and the `Atomics.wait` primitive (`#hostFutexWait`,
  `kernel.ts:4855`) — both irreducible. Async completion-channel park
  (`host_wait`/`host_wake`) remains deferred (§4/H-def).
- **Phase 5** (VFS): **done for the `/` authority.** The in-kernel rootfs +
  tmpfs overlay owns path resolution, metadata, permissions, COW, and
  whiteouts (`crates/runtime-core/src/rootfs.rs`, enabled at
  `kernel-worker.ts:4975`). The host `MemoryFileSystem` survives only as the
  `blob_read` byte-store. (Residues — §4/H5.)
- **Phase 6** (fork/exec → Rust): D1–D7 done; the delete-and-gate pass
  landed (unsupported reference kinds fail loud `EOPNOTSUPP`; their JS
  reconstruction deleted). `WASM_POSIX_FORK_MODULE` is still default OFF.
  See §4/F for what remains.

**The host seam is already sharply minimal for fork.** The fork engine
floor (`ForkHostCapabilities` + `ForkLifecycleCapabilities`) is down to
**five** trait methods — `mint_exception_tag`, `provide_unwind_transport_
tag`, `recognize_unwind_transport` (`crates/fork-codec/src/
host_capabilities.rs:192/209/227`), `instantiate_child`, `spawn_thread`
(`:265/279`) — plus the single residual `env.resolve_externref`
(`fork-module-inject/src/main.rs:144`) and two host-owned wasm objects (the
unwind `Tag` and the `(ref null any)` transit table). Every one is
genuinely irreducible. Eight former methods were already collapsed into
injected wasm by item-5/M2.

**The critical structural fact:** the campaign lives on **two divergent
ABI-44 lines that have never been integrated** — see §5.

---

## 4. Remaining work, classified by the Bar

Each item is tagged with its Bar class and grounded in current code.

### Workstream F — Fork line (finish Phase 6 on `epoll-kernel-route`)

- **F1 — Module abort-replay. [MIGRATE-TO-RUST]** *(first fork slice — begins after N0; see §8)*
  With the flag ON, a fork that must abort after capture — a gated reference
  kind (`EOPNOTSUPP`) or a kernel-rejected fork (`childPid < 0`, e.g.
  `ENOMEM`) — currently crashes the parent: `finishModuleTransaction(true)`
  throws `"fork-module path does not own abort replay"`
  (`fork-process-continuation.ts:1314`), and `beginAbortReplay` drives the
  JS `LinkedForkContinuation` (`:683`). Per the Bar, the abort state machine
  + sequencing + resource lifecycle move into `fork-codec`, exposed by
  `fork-module` exports (mirroring `fm_begin_replay`/`fm_finish_replay`/
  `fm_abort`). The host retains only the irreducible seam: the errno/policy
  decision + invoking the guest's already-frozen `wpk_fork_abort_begin`/
  `wpk_fork_abort_end` exports. No guest re-instrument. Scope: simple +
  multi-activation (dlopen) aborts; vfork/borrowed abort stays unsupported
  by existing design (`finishTransaction:1386`); post-seal trigger first
  (mid-capture `ENOMEM` is likely moot on the module path because the
  qualifying predicate excludes arena-exhausting forks — verify).
  Validation: Node + Chromium, plus a parent-corruption fault-injection test
  (the address-space risk) and un-skipping the flag-on gated-abort test the
  delete-and-gate pass left `.skip`.

- **F2 — The irreversible flip + delete twins. [DELETE-TWIN]**
  Flip `WASM_POSIX_FORK_MODULE` default ON (`node-kernel-worker-entry.ts:
  173`; browser + `node-kernel-host.ts` wiring). Delete the flag-off JS
  reconstruction twins already reimplemented in Rust/injected wasm:
  `materializeAllTyped`, `publishTransit`, `decodeExternref`
  (`fork-reference-transaction.ts`) and their gated call sites, plus the
  dead frame/journal engine (`LinkedForkContinuation` frame driving in
  `fork-continuation.ts`). Convert the reference-kind gate fully to
  `admit | raise | loud-fail` (already mostly there). Depends on F1 (so
  abort works when the module path is unconditional). Both-host validation +
  conformance.

- **F3 — Plain-local externref transit seeding. [FOLDED INTO F6 — ruling 2026-09-04]**
  ~~Move the PHASE-B `owner.publishExternref(...)` seeding into the injected
  drive.~~ **Grounding (post-delete-and-gate) found this premature:** plain-local
  externref is now GATED AT CAPTURE (`fork-activation-registry.ts:477-482` marks
  it unsupported; `worker-main.ts:5121-5138` aborts the fork with `EOPNOTSUPP`
  before any child restore — the F1-proven path). So the transit seeding F3
  targeted is **dead on the flag-on path**, and the surviving PHASE-B loop
  (`fork-reference-transaction.ts:1127-1134`) is live *only* for host-exception
  externref payloads on the **JS** path (not module-driven, not the F3 case).
  The module already carries the externref decode + `DRIVE_OP_EXTERNREF_TRANSIT`
  machinery; the one missing piece (plain-local transit publish) is only
  meaningful once the capture gate is lifted — which is **F6's** charter
  (native backend removes the gate + rebuilds reconstruction). Doing F3 now
  would migrate an aborted-before-it-runs case, untestable end-to-end, and be
  rewritten by F6. **Ruling: F3 is a sub-task of F6, not a standalone slice.**
  (Optional, separate: a truth-in-gating tidy-up of the now-inconsistent
  "admit externref" arms the delete-and-gate left behind — `worker-main.ts:4444`
  `case "externref": return true`, `crates/fork-module/src/lib.rs:2258` — which
  are unreachable-but-untruthful; F6 rewrites them anyway, so this is a small
  optional consistency fix, not F3.)

- **F4 — pthread table-journal reference replay. [FOLDED — ruling 2026-09-04]**
  ~~Route `restoreTableState`'s `materializeAllTyped()` through the module
  drive.~~ **Grounding found no live target for this.** `restoreTableState`
  (`fork-activation-registry.ts:1292-1354`, via `DylinkForkTableReplica`,
  `worker-main.ts:2962-2990`) runs live for cross-Worker table replication
  (dlopen funcref tables + pthread table growth), and its live content is
  **funcref/null** — but the `moduleDrive` seam explicitly does **not** touch
  funcref (`fork-reference-transaction.ts:1071-1075,1145-1146`); funcref goes
  through `ForkFunctionCatalog` + `applyFuncrefTablePatch`, never the module
  drive. So "route it through the module drive" would accomplish nothing for
  its live content; the drive only handles the gated GC/exnref/static-root
  kinds (dead at capture, rebuilt by the native backend). **Ruling:** F4 folds
  into **F6/N1** (the native backend rebuilds the gated-kind reconstruction and
  replaces the transitional `moduleDrive` seam), and its one sound-suspect
  residue — the funcref **capture** reverse-lookup (`ForkFunctionCatalog.encode`
  via `captureTableState → saveTables`) — is **already owned by F5**. The
  restore-side forward funcref decode + table write is correct as-is.
  **Latent gap for F6/N1** (flagged by grounding): if a program mutates an
  externref/anyref table, `captureTableState` publishes gated *placeholder*
  nodes instead of aborting — a truthfulness gap the delete-and-gate left on
  the table-journal path (unlike the fork path, which aborts). Close it in F6/N1
  (or as part of the truth-in-gating tidy-up).

- **F5 — funcref-capture residue → eliminate via re-instrumentation.
  [MIGRATE-TO-RUST, re-instrument]**
  The capture/encode/seal reference seam — including funcref capture via
  `ForkFunctionCatalog.encode` (`fork-activation-registry.ts:463-507`,
  `fork-function-catalog.ts`) — is the one reference residue on the
  *supported* fork path (dlopen packages: php/php-fpm/redis-server). Sound
  elimination = guest **re-instrumentation** to record `(activation, ordinal)`
  provenance at funcref production sites (the E1 "FLOOR-1-funcref" design), so
  capture reads a recorded value instead of a host reverse-lookup. Per the
  recalibrated Bar (§2.4), re-instrumentation is now chosen on soundness, not
  deferred for build cost — the ABI-44 epoch already rebuilds every package.
  So F5 is a real migration slice, not a permanent boundary. **Decision to
  confirm with the user (see the note below):** whether to do F5 in this
  campaign (recommended, since it removes the last supported-path reference
  residue) vs. fold it into the native backend (§6/N).
  The *other*, currently-gated kinds (externref / struct / array / i31 /
  static-root) are **targeted for full implementation** — the goal is the most
  complete platform, so their `EOPNOTSUPP` gate is a **temporary** truthful
  state (§2.5), not a permanent boundary, and YAGNI is explicitly
  deprioritized here (user directive 2026-09-04). See **F6** for how they get
  implemented; the gate stays loud only until that lands.

- **F6 — Full reference-kind reconstruction (remove every `EOPNOTSUPP` gate).
  [MIGRATE-TO-RUST, native + re-instrument]**
  Implement fork reconstruction for all remaining reference kinds — externref
  (broker-held *and* GC-derived), struct, array, i31, static-root — so no fork
  reference shape is unsupported. This is the completeness goal, enabled by two
  tools now both in-scope (cost is no longer a blocker):
  - **The native wasmtime backend (N1) is the substrate.** Native host code
    holds `Func`/`ExternRef`/`AnyRef` in the wasmtime `Store` and can
    deref/compare/root them directly — no instrumentation shadows, no JS
    `WeakMap`, no inline-provenance hack, no weak-ref leak. Per the E1
    feasibility analysis this "beats what re-instrumentation can reach" and is
    the natural home for externref-identity and GC-array provenance (the cases
    pure re-instrumentation cannot reach: a wasm-GC array can't carry inline
    provenance, and a `(ref eq)→provenance` side table is program-lifetime =
    leak).
  - **Re-instrumentation supplies production-site provenance** where it is the
    sound path (funcref = F5; GC struct inline provenance; externref
    shadow-discipline).
  Sequencing: F6 depends on **N1** for the hard GC/externref-identity cases, so
  it lands with/after the native backend; the funcref half (F5) can precede it.
  The delete-and-gate pass removed the *old JS* reconstruction — F6 rebuilds it
  the sound way (native `Store` + recorded provenance), not the JS way.

### Workstream H — Small host-surface migrations (independent, per Bar)

- **H1 — `host_debug_log` → narrow sink. [MIGRATE-TO-RUST]** The decode +
  `console.log` (`kernel.ts:1540`) is reducible glue; only a raw stderr sink
  is irreducible.
- **H2 — `host_is_thread_worker` → init-time config. [MIGRATE-TO-RUST]**
  Static wiring data the host knows at init (`kernel.ts:2043`), not a runtime
  capability — belongs in the kernel init payload, removing a per-query
  import.
- **H3 — `host_last_errno` → in-band return. [MIGRATE-TO-RUST]** An ABI
  artifact of smuggling an `Errno` beside a `u32` handle over wasm imports
  (`fork-module/src/host_capabilities.rs:68`); vanishes in the native backend
  (which returns `Result`); can be folded into a richer in-band encoding.
- **H4 — Synthetic network-interface ioctls → Rust. [MIGRATE-TO-RUST]**
  `SIOCGIFHWADDR/IFCONF/IFNAME/IFADDR/IFINDEX` are computed 100% in host TS
  from a TS-only `VIRTUAL_INTERFACES` table and a TS-generated random MAC
  (`kernel-worker.ts:20017`, `:941`, `:3435`), with no kernel involvement —
  reimplemented kernel semantics needing no host capability. Move to
  `runtime-core` constants + a Rust-owned MAC.
- **H5 — `/dev/shm` + `VirtualPlatformIO`/`MemoryFileSystem` deletion.
  [MIGRATE-leaning, capability-gated]** The `/` authority is done, but the
  design-doc Phase 5.3 goal ("delete `MemoryFileSystem` + `VirtualPlatformIO`;
  collapse FS imports to byte leaves") remains. `/dev/shm` as a host
  `MemoryFileSystem` (`node-kernel-worker-entry.ts:1151`) could be subsumed by
  kernel `tmpfs.rs` once SAB-shared `mmap` is handled in Rust. Larger; gated
  on that capability.
- **H-def — Async completion-channel park (`host_wait`/`host_wake`).
  [deferred]** Not implemented anywhere; not on the critical path for
  blocking correctness (today: `Atomics.waitAsync` retry loops +
  `host_futex_wait`). A cleanliness/perf upgrade; land opportunistically.

### Workstream N — Native backend + ABI-44 convergence (see §5, §6)

### Workstream Z — Phase 7 freeze gate (see §7)

---

## 5. The two-line ABI-44 collision (the biggest structural item)

The campaign advanced on two branches that both stamped `ABI_VERSION = 44`
independently:

| Line | Branch(es) | Carries | Native host? |
|---|---|---|---|
| **Fork line** | `epoll-kernel-route` (`ce5b81449`) | Phase 1 `runtime-core` + Phase 5 VFS overlay + Phase 6 fork/exec codec (`fork-codec`, `fork-module`, `fork-module-inject`) | No — `native_sketch.rs` is `ENOSYS` stubs, no wasmtime dep |
| **Transport line** | `phase2 → phase3 → phase4` (linear stack) | Phase 2 opaque transport + Phase 3 `crates/host-native` (wasmtime 35) + Phase 4 native blocking | Yes — real `crates/host-native` |

- Neither line is an ancestor of the other; their `abi/snapshot.json` files
  **both say `44` but differ by 68 lines** — the same epoch integer for two
  different contracts.
- The real native wasmtime host (`crates/host-native`, `guest.rs` channel
  pump) exists **only** on phase3/phase4 and implements ~20 of ~99 `HostIO`
  methods (~78 trap); it runs trivial/pipe/epoll/thread fixtures, **not**
  fork replay.
- The working-tree `docs/abi-versioning.md` still treats **ABI 43** as the
  open epoch and argues against minting 44 — a doc inconsistency to fix.

**N0 — Reconcile into one canonical ABI-44. [IMMEDIATE PRIORITY — do first]**
Pick a single ABI-44 contract; merge/rebase the transport flip (phase2) +
native host (phase3/4) together with the fork line; regenerate one
`abi/snapshot.json` via `scripts/check-abi-version.sh update`; correct
`docs/abi-versioning.md` to reflect 44 as the epoch under development. This is
substantial branch-integration work and is where the user (sole merger)
decides the merge/rebase strategy.

**Decision (2026-09-04, user):** do N0 **before anything else** — before F1
and the rest of the fork work. Rationale: reconciliation defines the single
tree everything else lands on; doing it first avoids re-basing fork work
twice, and it establishes what is genuinely "last remaining." If, after
reconciliation, the fork work (§4/F) is the last remaining feature work, it
is the agreed next focus. The reconciliation strategy itself gets its own
scoping pass + approval before any history-rewriting git operation runs
(§8).

**STATUS 2026-09-04 — N0 rebase DONE (validation pending).** Reconciliation was
executed as two rebases on the isolated branch
`brandonpayton/rust-first-abi44-reconcile` (worktree
`/Users/brandon/kandelo-abi44-reconcile`; `epoll-kernel-route` + the
`pre-m8-fork-flip` tag left intact):
1. **Transport reconciliation** — rebased the 213-commit fork line onto the
   transport tip (`rust-first-phase4-blocking`: opaque transport + native
   `host-native` + blocking). One real conflict (an `ABI_VERSION` doc comment,
   resolved as the superset) + 5 stale-ABI-43 test fixtures (`rerere` replayed).
2. **Rebase onto latest `origin/main`** — pulled in main's 48 build-fix
   commits. Six conflict stops; resolutions were heterogeneous: main superseded
   the fork's coreutils-docs prototype (took main's merged #1352; the fork
   commit dropped as empty), `.gitignore` union, a genuine merge of main's
   #1358 fail-loud kernel resolution with the fork's tar→ZIP test migration,
   and additive unions in the two worker entries + `centralized-test-helper.ts`.
Result: linear history on `origin/main`, `ABI_VERSION = 44` kept (main is still
43 → 44 is unreleased, so this tree IS the canonical 44), union of both lines
verified present, no stray conflict markers.

REMAINING before N0 is truly closed: regenerate ABI artifacts
(`abi/snapshot.json`, `abi.ts`, `abi_constants.h`, `Cargo.lock`) from merged
source; `HOST_RAW_SYSCALLS` classification audit; `centralized-test-helper.ts`
coherence check (deferred redundancy pass); build + validate on the isolated
worktree, provisioned with its own `KANDELO_SOURCE_CACHE_ROOT` so no stale
ABI-44 artifacts leak in from the machine-wide cache. Main added no new
fork-continuation TS (only a #1359 ABI-mismatch guard and a Ctrl-D EOF fix), so
the fork-TS porting inventory (§4/F) is unchanged by the reconciliation: F1
module abort-replay is still the next port, then F3 externref-transit and A5
pthread-table-journal, with the A1 funcref-capture floor needing the guest
re-instrument.

**STATUS 2026-09-04 (later) — N0 CLOSED. Next step = F1 (module abort-replay).**
The reconciled branch was pushed to PR #1350 (force-updated
`origin/brandonpayton/epoll-kernel-route`; pre-reconciliation tip preserved as
tag `pre-m8-fork-flip`; PR retitled + described). Validation done at the agreed
level ("decision B" — sufficient-for-reconciliation, defer heavy end-to-end):
- Merged Rust compiles; full Rust suite **2604 pass / 0 fail** (33 binaries).
- One failure found + fixed (`bce056261`): the `WPK_FORK_MODULE_STATE_RECORD_KINDS`
  count assertion was stale at 13 vs the real 14 (JOURNAL_IMAGE #14) — a
  PRE-EXISTING fork-line bug, not a merge artifact, surfaced by running the suite.
- Native `host-native` (wasmtime) crate compiles + tests pass.
- ABI 44 snapshot regenerates byte-identical from merged source (coherent).
- `HOST_RAW_SYSCALLS` × in-kernel-VFS audit: safe (byte-serving FS syscalls are
  RAW → stay off the opaque-record fast-path → keep the blob_read/EAGAIN path).
- `host/src` TypeScript typechecks with zero errors (worker-entry + kernel-worker
  unions are type-clean).
DEFERRED to the next build (decision B — run when F1 needs a build anyway): host
Vitest behavior + the `centralized-test-helper.ts` coherence check, and browser
Playwright. These need a full cold ABI-44 package projection on the isolated
`KANDELO_SOURCE_CACHE_ROOT` (~1-2h), not worth the wall-clock purely to reconfirm
a merge that already passes Rust tests + typecheck.
So the campaign sequence now advances to **F1 module abort-replay** on this
reconciled tree (worktree `/Users/brandon/kandelo-abi44-reconcile`, branch
`brandonpayton/rust-first-abi44-reconcile` = PR #1350 content), per §4/F and §8.

---

## 6. Native wasmtime backend (campaign item 7 / Phase 3 completion) — the main remaining thrust

Depends on N0 (native host present on the integrated tree — DONE; the
reconciliation brought `crates/host-native` + `native_sketch.rs` onto this tree).

**Grounding correction (2026-09-04):** `crates/host-native` is much further
along than "loads kernel + ~20 methods." It already boots the real ABI-44
`kernel.wasm` and runs 8 real SDK-built guest fixtures end-to-end through the
real channel — the hard spine (wasmtime kernel load, atomic wait/notify channel,
RAW + opaque-record marshalling, multi-threaded blocking/epoll) is DONE + green
(`cargo test -p host-native --target <host>`; `guest.rs` pump, `lib.rs` boot).
13 `HostIO` methods implemented; ~69 trap (truthful `define_unknown_imports_as_traps`).
The fork core (`crates/fork-codec`) is host-agnostic `no_std`; the engine floor
is 5 methods (3 tag + 2 lifecycle) in `ForkHostCapabilities`/`ForkLifecycleCapabilities`;
`native_sketch.rs` maps each to wasmtime (`Tag::new`/`Tag::eq`, `RootScope`,
`Rooted<ExternRef>`, `Instance::new`, `thread::spawn`).

**N1 increment roadmap** (I1–I3 = predictable breadth on the proven spine;
I4–I5 = the deep research where the co-resident-module-vs-direct-drive question
is answered empirically and where the plan CHECKPOINTS with the user):
- **I1** — **sandboxed in-memory VFS as the native default** (CORRECTED
  2026-09-04 per user: the native host is a VIRTUAL FS, it must NOT reach the
  real host FS by default). Two host-side-only sub-parts, no kernel change:
  - **I1a** — enable the in-kernel overlay + tmpfs at boot
    (`kernel_set_rootfs_enabled(1)` + `kernel_set_tmpfs_enabled(1)` +
    `kernel_set_rootfs_now`): the overlay creates `/` lazily and stores
    overlay-created files INLINE (`Regular(Vec)`), so `host_blob_read`/
    `host_fetch_archive` are NEVER called (stay trap-stubbed) and `host_open` is
    never reached → fully sandboxed empty writable `/` + tmpfs scratch. No
    manifest, no blob provider. + argv/env wiring (`kernel_get_argc`/`argv_read`/
    `environ_*`, drop the argc=0 fallback).
  - **I1b** — explicit native-dir MOUNT at a VFS point, **at parity with the
    Node host** (which ALREADY does this: `host/src/vfs/host-fs.ts`
    `HostFileSystem` via `extraMounts` + a rootfs foreign prefix). Host-side-only:
    register the mount point via `kernel_rootfs_set_foreign_prefixes` (overlay
    disowns that subtree → routes to `host_open`), reuse a mount-prefix-aware
    `HostFs` (the reverted real-dir FS impls, re-added correctly-scoped as a
    mount backend — commit 0a1fd735a has them). Top-level mount (`/host`) needs
    no seeding; a nested mount needs a dir-only manifest for the parent chain.
  (The reverted commit 0a1fd735a made a real dir the DEFAULT `/` — wrong; I1
  makes the in-memory VFS the default and native dirs an explicit mount.)
- **I2** — serve a real VFS IMAGE natively via `blob_read`/`fetch_archive` (the
  heavy alternative to I1a's empty overlay) — needed to run a shipped binary that
  reads real base files from the image.
- **I3** — process spawn/exec/`host_waitpid` (multi-instance, argv hand-off,
  the ABI-44 exec-authority path). Sub-increments:
  - **I3a — posix_spawn + waitpid (DONE 2026-09-04).** Pump generalized to N
    `GuestProcess`es (each own `SharedMemory`/pid/scratch/channels, blocking ops
    routed by `process_index`); `SYS_SPAWN` decodes the blob, resolves `argv[0]`
    in `GuestOptions.programs`, launches the child via `launch_process`, publishes
    it, and rolls back the kernel process-table entry via `kernel_remove_process`
    on `-ECHILD`; `host_waitpid` is a PARKED op (never blocks the single-threaded
    pump) resolved on child exit → `kernel_get_process_exit_status`/`_signal` →
    `encode_wait_status` (WEXITSTATUS) → `kernel_reap_exited_child(real_ppid,…)` →
    status writeback → resolve the parent's parked channel. 17/17 host-native
    tests (`smoke_spawn_waitpid` e2e: child `_exit(7)` → parent `WEXITSTATUS==7`).
    Host-side-only; child bytes from the `programs` map. Commits 66672e254 /
    9618b2f0e / f71c314bb / 5dee3f0b0.
    - **Native-surfaced platform follow-up (the point of N1):** `runtime-core`'s
      `blocked_retry.rs` has NO `wait4` (syscall 139) entry and `wait4` is not in
      `is_explicit_host_only_snapshot_syscall`, so `kernel_blocking_retry_token(139)`
      returns `-EINVAL`. I3a worked around it host-side (`token: 0`, poll's
      "nothing to pin" convention) under the host-native-only constraint — sound
      (the pump re-dispatches every parked op each iteration, no lost wakeup) but
      it leaves a gap: a parked `wait4` is not representable through the kernel's
      reviewed retry-token classification. FOLLOW-UP: add `wait4` to that reviewed
      host-only-snapshot list in `runtime-core` so `token_for_syscall(139)`
      succeeds for ALL hosts (native + Node + browser), removing the host-side
      special case. Not on the I3 critical path; do when a `runtime-core` build is
      already warranted.
    - **Process-lifecycle follow-ups (opus whole-increment review, PARKED as I3
      work — genuine POSIX gaps, both fail truthfully today so not blocking):**
      (1) The native pump returns only once every spawned child has quiesced
      (`guest.rs:2930-2934`), so a parent that exits while a child still holds a
      live channel (infinite loop, indefinite `read`/`wait4`, detached parked
      pthread) yields a LOUD 30s pump timeout rather than the POSIX behavior of
      the parent exiting immediately and its orphans reparenting to init. Task 2
      widened the drain deliberately to avoid a parent-vs-child exit race, so the
      correct fix is the larger lifecycle piece — **orphan reparenting to init
      (PID 1) + parent exit returning immediately** — best done with the I3b+
      exec-authority work, not bolted on mid-increment.
      (2) Relatedly, a child that exits but is never `wait`ed leaves a kernel
      zombie + host `WaitTable` entries unreaped (bounded to the `run_guest`
      lifetime; mirrors real POSIX zombie semantics). Folds into the same
      reparent-to-init work — init reaps orphaned zombies.
  - **I3b — spawn bytes from the VFS (DONE 2026-09-04).** `posix_spawn`
    sources the child's program bytes from the in-kernel VFS via the SPAWN
    exec-target authority (`kernel_spawn_exec_target_prepare` →
    `kernel_exec_target_size`/`read` → `kernel_spawn_exec_commit`), replacing
    I3a's host-side `programs` map (removed). `X_OK`/set-ID/close-on-exec
    delegated to the kernel; POSIX-correct `ENOENT`/`EACCES`/`ENOEXEC`
    failures with leak-free rollback (cancel + `kernel_remove_process` on
    every branch); the spawn `path` is authoritative (empty → `ENOENT`, no
    `argv[0]` fallback). Host-side-only, 20/20 tests. Commits ee1a0031b /
    9749ed480 / d4db3e8a5. Plan:
    `docs/superpowers/plans/2026-09-04-n1-i3b-native-spawn-from-vfs.md`.
  - **I3c — execve/image-replacement (DONE 2026-09-04).** A running process
    replaces its own image in place (same pid, fresh address space) via the
    non-spawn `kernel_exec_target_prepare` → read → `kernel_exec_commit`; the
    pump intercepts `SYS_EXECVE` (Tier-A host-intercepted), reads
    `path`/`argv`/`envp` from guest memory, and swaps the `GuestProcess` under
    the same pid via `launch_process`. POSIX success/failure asymmetry: a
    successful execve abandons the calling thread and never returns; a failed
    execve (`ENOENT`/`EACCES`/`ENOEXEC`) completes the channel so the caller
    resumes its old image. Host-side-only, 24/24 tests. Commits 14d088c55 /
    b45ef44eb. Plan: `docs/superpowers/plans/2026-09-04-n1-i3c-native-execve.md`.
    Documented follow-ups (opus review, PARKED — none compromise correctness
    for real programs): (a) a NULL/out-of-bounds `path`/`argv` pointer surfaces
    as `ENOENT` rather than POSIX `EFAULT` (degenerate input musl never
    produces); (b) **multi-threaded execve** — execve from a worker/pthread
    channel falls through to the kernel's `-ENOSYS` (only main-thread execve is
    handled) and sibling channels are not reconciled against the kernel's
    `clear_threads`; this folds into the I4 thread-lifecycle work below.
  - **N1-R — native thread reclamation (DONE 2026-09-05).** Resolved the
    thread-reclamation gap (successful `execve`, `-ECHILD` spawn-rollback, and
    the fork replay threads I4 will spawn all need to reclaim a guest thread
    parked in a WASM `memory.atomic.wait32`). A spike proved epoch AND fuel
    provably CANNOT interrupt a parked `atomic.wait32` (it lowers to a
    synchronous libcall → `std::thread::park_timeout(MAX)`; no wasm runs while
    parked — empirical + wasmtime-35 source + docs; see
    `docs/plans/2026-09-05-native-thread-reclamation-spike.md`). Fix shipped: a
    **cooperative `TEARDOWN` channel-status sentinel** — the pump writes
    `TEARDOWN` + `atomic_notify`s the parked channel, and a check after the wait
    loop in `channel_syscall.c` traps so the guest thread unwinds instead of
    resuming the superseded image (`reclaim_parked_thread`/`reclaim_all_channels`
    + `thread_handles` join bookkeeping). Race-free (opus-reviewed:
    `wait32`'s value-compare-on-entry is immune to lost wakeups; notify address
    matches `complete_channel`; single-threaded pump; no join-deadlock).
    Closes the documented execve-success + spawn `-ECHILD` thread/`SharedMemory`
    leaks. **Additive ABI (`Teardown=4`), folded into in-dev ABI 44 — NO
    `ABI_VERSION` bump** (unreleased; all guests rebuilt: musl + 16 fixtures);
    NO new host import. host-native 29/29. Commits d8981e940 (ABI/glue) +
    c556f763d (host wiring) + the map-prune fix. Plan:
    `docs/superpowers/plans/2026-09-05-n1-thread-reclamation-teardown.md`.
    Residual (documented, out of scope): multi-threaded execve does not tear
    down a NON-parked compute-bound sibling until its next syscall (writing
    `TEARDOWN` to a non-parked channel would be clobbered / could hang a join).
    I4's fork replay-thread teardown REUSES `reclaim_parked_thread`.
  - **I3d — execveat + kernel-owned `#!` shebang (DONE 2026-09-05).** execveat
    (dirfd/`AT_EMPTY_PATH`) shares `handle_exec_common` with execve. Shebang
    resolution is **kernel-owned** (campaign-altitude correction, per user): a
    new additive export `kernel_exec_target_resolve_shebang` resolves the whole
    chain in-kernel (decode + interpreter retarget + one-level limit + argv
    prefix), leaving the host only byte-fetch/instantiate/commit/launch — the
    host has zero shebang decision logic. Leak-free (zero retained target on any
    error, incl. the export's EOVERFLOW path). Additive ABI (no `ABI_VERSION`
    bump; snapshot regenerated). host-native 28/28, runtime-core 1755/1755.
    Commits f0696f6f2 / 6568864a3 / 53f447f05 / 62ecf6188 / a859c8e1d. Plan:
    `docs/superpowers/plans/2026-09-04-n1-i3d-native-execveat-shebang.md`.
    Follow-up (batched-test later, approved): migrate Node/browser's TS shebang
    (`host/src/exec-target.ts`) to call this kernel export.
  - **N1 "predictable breadth" (I1–I3) is now COMPLETE.** The native process
    model — in-memory VFS default, real base image, spawn+waitpid, spawn-from-VFS,
    execve, execveat, shebang — is all in. What remains in N1 is the deep
    research (I4 fork frames, I5 fork references) + conformance (I6).
- **I4** — fork frames natively (no refs): drive `fork-codec`
  `rewind_driver`/`replay_journal`/`linked_frames` + `instantiate_child`
  (`Instance::new`) + `spawn_thread` (`thread::spawn`), replacing the
  `native_sketch` ENOSYS stubs. **Research; checkpoint.**
- **I5** — fork references (the F6 substrate): native `ForkHostCapabilities`
  (`Tag::new`/`Tag::eq`, `RootScope`/`Rooted<ExternRef>`), answering whether the
  co-resident fork-module is needed natively and whether wasmtime's ref/exnref
  behavior matches the documented floors. **Highest research; checkpoint.**
- **I6** — conformance suites (libc/posix/sortix) on native vs the Node host
  (the freeze-gate acid test); net-new native runner harness.

Detail on the fork-capability impl (folded into I4/I5):

- **N1 — Real native backend.** Turn `native_sketch.rs`'s `ENOSYS` stubs
  into a working `ForkHostCapabilities`/`ForkLifecycleCapabilities` impl:
  hold `Rooted<ExternRef>/AnyRef/Func/Tag/Instance` in a `wasmtime::Store`
  with `RootScope`-based generations, `Instance::new` for children,
  `std::thread::spawn` for replay; add the `wasmtime = "35"` dep to the fork
  line (it has none today). Extend `crates/host-native` to implement the full
  `HostIO`/`HostCapabilities` surface (the ~78 currently-trapped methods) and
  wire fork replay through it. This is also the natural home for the *true*
  elimination of the F5 funcref-capture floor and the H3 errno artifact —
  native host code holds/derefs/compares refs directly via the Store, with no
  instrumentation shadows and no JS WeakMap.
- **N2 — ABI-44 finalization.** Confirm `ABI_VERSION` + regenerated snapshot
  in one commit; rebuild all binaries; cut the immutable `binaries-abi-v44`
  release + `index.toml` ledger via the Prepare-Merge / post-merge-activation
  flow (`docs/abi-versioning.md`).

---

## 7. Phase 7 — freeze gate (last; depends on §5, §6)

Prove Decision #4: the **same** `kernel.wasm` boots under browser + Node +
native wasmtime — the platform boundary is not secretly JavaScript-shaped.

- **Z1** — Extend the host-adapter manifest: ABI 44, capability-discovery
  bitset, resource limits, channel checksum.
- **Z2** — Same image boots on all three hosts.
- **Z3** — Verify the seven completion criteria (TS out of the dispatch
  path; a guest-ABI reshape needs zero `host/src` edits unless it adds a host
  capability; three hosts share `runtime-core`; Node/browser parity at every
  green commit; unsupported capabilities fail with a defined error; perf
  claims backed by before/after benchmarks on Node **and** browser; the
  record decoder is fuzzed + property-tested).
- **Z4** — Curate history; rebase-merge (contributor attribution preserved).

---

## 8. Sequence and dependencies

Per the 2026-09-04 decision, the work is **serial**, not two parallel tracks:
reconcile first, establish the single tree, then everything else lands on it.

```
N0 (reconcile the two ABI-44 lines into one canonical tree)   ← DONE
     ▼
F1 (module abort-replay)                                       ← DONE (on PR)
     ▼
[RESHAPED 2026-09-04 after grounding F3/F4]
     F3 (externref transit) and F4 (pthread table-journal) are NO LONGER
     standalone slices — the delete-and-gate already did their *deletion* half
     (the gated kinds abort at capture); their *rebuild* half is F6/N1's, and
     F4's funcref-capture residue is F5's. So the "quick testable migrations
     before the flip" have evaporated. What actually remains before the flip:
       • F5 (funcref-capture re-instrument) — the ONE live supported-path
         reference residue, but HEAVY + ABI-affecting (guest re-instrument =
         rebuild all fork packages) + strategically entangled with N1 (native
         host holds Func directly, so funcref-capture is also a native-backend
         candidate; re-instrument only helps Node/browser).
       • Truth-in-gating tidy-up (small, sound): tighten the delete-and-gate's
         leftover untruthful "admit externref" arms (worker-main.ts:4444,
         lib.rs:2258) + make the table-journal path abort truthfully on gated
         kinds instead of publishing placeholders (F4 §latent-gap).
     F2 (flip default-on + delete dead frame/journal JS engine) is HELD for the
     user (dogfood + full browser/conformance validation).
     ▼
N1 (real native wasmtime backend — completes the host-native impl; the
     substrate for F6; also folds in the H3 errno artifact). Absorbs F3 + F4.
     ▼
F6 (full reference-kind reconstruction — remove every EOPNOTSUPP gate:
     externref incl. GC-derived, struct, array, i31, static-root — via the
     native Store + re-instrumented provenance). Depends on N1 for the hard
     GC/externref-identity cases. This is the completeness goal.
     ▼
N2 (ABI-44 finalization: snapshot + ABI_VERSION in one commit; rebuild all
     binaries; cut binaries-abi-v44 release; fix docs/abi-versioning.md)
     ▼
Z1..Z4 (Phase 7 freeze gate: manifest extension; same kernel.wasm on
     browser + Node + native; seven completion criteria; benchmarks;
     curate history → rebase-merge)
```

**Why N0 first:** reconciliation defines the single tree every later slice
lands on. Doing fork work first would force re-basing it onto the reconciled
tree later. Reconciliation also reveals what is genuinely "last remaining."

Fork/exec is the **severable leaf**: if native fork replay (N1) stalls, the
rest (transport + VFS + blocking + native host + ABI 44 + freeze) can still
land without "fork is Rust-directed," per the design doc.

**N0 is not yet a mechanical plan.** It needs its own scoping pass — map the
actual content divergence between the fork line and the transport line,
locate the 68-line snapshot conflict, and choose merge vs. rebase vs.
re-sequence — presented for approval before any branch surgery. That scoping
is the immediate next step.

---

## 8.6 Campaign decisions (2026-09-05, user)

- **Tier-2 wasmtime dependency: acceptable for now.** The native host was
  upgraded to wasmtime 48 (from a stale 35) to gain the exceptions proposal
  (`exnref`, required to load fork-instrumented guests) + GC. wasmtime marks
  wasm threads/shared-memory Tier-2 (no security-update guarantee); the whole
  native pump depends on `SharedMemory` + atomics. Accepted: native is the
  campaign's forcing function / third host; Node+browser (V8) stay the
  production hosts. Not gating native's status on Tier-1.
- **Reference-completeness bar (I5/F6) = ALL kinds, no `EOPNOTSUPP` left.**
  externref (incl. GC-derived), struct, array, i31, static-root — every
  reference kind reconstructs, via the ONE shared co-resident module across all
  hosts. No accepted subset.
- **Batch validation runs ONCE, at campaign completion** (not interleaved at
  I6): when ALL THREE hosts are ready to test the complete finished result —
  Node Vitest, browser Playwright, and the libc/posix/sortix conformance
  suites, on the same `kernel.wasm`. Keep building increments (green unit +
  host-native tests per increment) without the cross-host batch until the end.
- **Close the native fork/exec residuals (do NOT ship them as gaps):**
  1. **Real vfork.** Native currently routes `SYS_VFORK` → the plain-fork
     (private-copy) path; wire the fork-module's BORROWED path
     (`fm_begin_borrowed_child_replay`, `crates/fork-module/src/lib.rs:1803-1822`)
     so vfork shares the parked parent's memory and suspends the parent until
     the child execs/exits — matching Node/browser (vfork already works there).
     **FIRST STEP (user directive 2026-09-05): audit whether vfork was already
     SOLVED during this campaign and wire native to that solution rather than
     reinventing.** Check: the kernel `MODE_VFORK` path + `kernel_fork_process`
     mode semantics; the fork-module `begin_borrowed_child_replay_impl`
     (borrowed/vfork) contract; the Node/browser host vfork branch
     (`handleFork`/`onFork` borrowed path in `host/src/`); the F1 abort-replay
     work; and the "vfork DONE" campaign item. The near-certain conclusion is
     that the vfork ALGORITHM already exists platform-wide and native only needs
     to route `SYS_VFORK` to the borrowed path + provide the parent-suspend +
     borrowed-memory capabilities — confirm before implementing.
  2. **fork/execve from a non-main (worker/pthread) channel** currently traps —
     make it work.
  3. **Multi-threaded execve** must tear down a NON-parked compute-bound sibling
     (today only channel-parked siblings are reclaimed via `TEARDOWN`).
  Sequence these into the native fork/exec completion (after I4 frames + I5
  refs, or as fits); they are campaign scope, not deferred future work.
- **Pre-merge commit curation boundary:** each curated commit is a
  self-contained UNIT OF PROGRESS AND MEANING that stands and passes tests on
  its own (NOT one-per-increment or one-per-phase mechanically). Expect much
  less granular history than the development commits; drop dev-churn/fix-round
  commits; preserve contributor attribution. This is the bar even though it is
  more burdensome.

## 9. This supersedes

For remaining-work framing, this document supersedes (does not delete —
they remain as historical ledgers):

- `.superpowers/sdd/2026-09-01-phase6-fork-exec/*` (PLAN, ITEMS-4-7-PLAN,
  MINIMIZE-HOST-SURFACE-PLAN)
- `.superpowers/sdd/2026-09-03-fork-reference-into-wasm/ROADMAP.md` (the
  M1–M8 slices + the two SCOPE DECISION blocks)
- `docs/superpowers/plans/2026-09-04-fork-references-delete-and-gate.md`
  (executed; its residue is F5)

The master design remains `docs/plans/2026-08-25-rust-first-runtime-
design.md`; this plan is the current, purpose-framed view of what is left.
