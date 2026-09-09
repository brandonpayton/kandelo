# Workstream H (host-surface minimization) — grounding (2026-09-06)

Read-only investigation. Grounds Part B item **B-H** of
`docs/plans/2026-09-05-rust-first-campaign-to-completion.md` ("Workstream H —
small independent host-surface migrations", milestone **M5**). Worktree
`/Users/brandon/kandelo-abi44-reconcile`, branch
`brandonpayton/rust-first-abi44-reconcile`, HEAD at grounding time `8b1800bc3`
("Host-native: fork() from a non-main thread (residual #4a)").

## What host-surface minimization means here

The campaign's north star (plan §Purpose) is to minimize the host API surface
every host (Node, browser, native wasmtime) must implement, and push
version-sensitive/semantic logic into the shared Rust kernel
(`crates/runtime-core`, wrapped for wasm by `crates/kernel/src/wasm_api.rs`).
`crates/host-native` is the forcing function: it is a second, independent
implementation of the host contract, so anything it must reimplement in Rust
that is really just formatting, static config, or reimplemented kernel
semantics is host surface that should have been in the kernel instead.

**Current surface, approximately (grep, directional not authoritative):**
- Node/browser (`host/src/kernel.ts`, `#buildImportObject`'s `env` block):
  **85 distinct `host_*` import bindings** the kernel.wasm module can call.
- Native (`crates/host-native/src/guest.rs`): **53 `linker.func_wrap("env", …)`
  registrations** (`grep -c 'func_wrap('` → 54, one of which is a helper, not
  a distinct import).
- The gap between the two lists is dominated by graphics/DRM/GL/KMS/GBM
  imports (`host_gl_*`, `host_kms_*`, `host_gbm_bo_*`, `host_bind_framebuffer`,
  `host_fb_write`) that native does not implement because it targets headless
  conformance, not display output — that gap is a *missing native backend*,
  not evidence of reducible host surface, and is out of scope for Workstream H.

Workstream H targets **reducible** imports: ones whose body is pure formatting,
static host-known config, an ABI-smuggling artifact, or fully-computable logic
that is reimplemented independently by each host today. Each item below is
graded against that bar.

## Important context discovered while grounding (changes item framing)

The campaign has moved substantially past the plan doc's "M0" snapshot since
it was written (2026-09-05). By HEAD `8b1800bc3` (2026-09-06), **B1 (native
fork frames), B2 (native fork references), B3/F5/F6 (all reference kinds
un-gated on Node+browser AND native — externref incl. GC-derived, struct,
array, i31, static-root; commit `283b06917` "Host: un-gate externref/GC/
static-root fork capture on Node+browser (refcomplete parity)") are all
DONE.** B5 residuals: real vfork DONE (`bc8ab8141`), fork-from-a-non-main-
thread DONE (`8b1800bc3`, "#4a"); execve-from-thread ("#4b") and
compute-bound-sibling execve teardown ("#5") remain **documented, deferred
residuals** (`docs/plans/2026-09-05-n1-thread-forkexec-residuals-grounding.md`,
commit `c3e79b8d4`) — not started, explicitly held pending a named scratch
experiment (engine-wide epoch interruption, 2 unresolved safety questions).
This means Workstream H is plausibly the **next actionable increment** on the
critical path to M5/M6, which matches why this grounding was commissioned now.

A second important discovery: the reference-completeness work (F5/F6) reached
"no reference kind remains on the JS path" (`host/src/worker-main.ts:4389`)
via **exnref being handled guest-locally** (`__wpk_fork_exception_materialize`
does the throw/`catch_ref`; the exception tag is guest-module-local) and typed
GC needing **no new engine-floor callback** (host-side JS drive-order,
`materializeTypedGraph`, already existed). Neither path routes through the
`wpk_fork_host.*` import seam that H3 targets. That seam
(`crates/fork-module/src/host_capabilities.rs`) was designed for an
exception-tag/unwind-transport/lifecycle model that reference-completeness
work **did not end up needing** — see H3 below; this is a bigger, more certain
finding than the plan's H3 description assumed.

---

## H1 — `host_debug_log` → narrow sink

**Host requirement today.** `host_debug_log(ptr, len)` is a real, live import:
declared in `crates/kernel/src/wasm_api.rs:56` (extern block) and in
`crates/runtime-core/src/lib.rs:69-77` (`pub fn debug_log(msg: &str)`, wasm32/
wasm64 only; a no-op stub on host-native's own build target,
`lib.rs:79-80`, because `host-native` links `runtime-core` directly rather
than compiling it to wasm — irrelevant to what kernel.wasm itself imports).
- **Node/browser** (`host/src/kernel.ts:1540-1545`): decodes the UTF-8 bytes
  and calls `console.log(\`[KERNEL] ${msg}\`)` — this ADDS a `[KERNEL] ` prefix
  in TS and writes to **stdout** via `console.log`.
- **Native** (`crates/host-native/src/guest.rs:1663-1674`): already the target
  shape — decodes the bytes and writes them **raw, unprefixed, to stderr**
  (`std::io::stderr()`), no added formatting.

**Cross-host inconsistency found:** native and Node/browser disagree today —
native uses stderr with no decoration, Node/browser uses stdout with a
`[KERNEL] ` prefix added in JS. This is exactly the kind of "reducible glue"
Workstream H targets, and it's a live parity bug, not just a style issue.

**Done-state.** Node/browser's `host_debug_log` body becomes a byte-for-byte
raw sink (decode + write to stderr, no prefix, no `console.log`), matching
native. If a `[KERNEL] `-style prefix is wanted for operator readability, it
must be added by the Rust caller (i.e. baked into the `&str` passed to
`debug_log`), not by the transport.

**Current status.** Not started — Node/browser side unchanged since campaign
start (only file: `host/src/kernel.ts`).

**Effort/risk/scope.** Small; essentially a 1-2 line change confined to
`host/src/kernel.ts`; cross-host by the contract (shared file) but the fix is
one-sided (bring Node/browser to native's already-correct shape). Zero
behavioral risk to guest programs (debug-only path). No ABI change (no
signature change). **Shippable now, no dependencies.**

---

## H2 — `host_is_thread_worker` → init-time config

**Host requirement today.** `host_is_thread_worker() -> i32` is a real, live
import called from `crates/kernel/src/wasm_api.rs:204,10009`, inside
`commit_current_task_exit`: it gates whether an exiting task takes the
thread-exit branch (preserve shared process state: FDs, pipes) or the
full-process-exit branch (`syscalls::sys_exit_with_locks`).
- **Node/browser** (`host/src/kernel.ts:903,2043-2044`): a plain mutable field
  `isThreadWorker = false` on the kernel-host class, read by the import body.
- **Native** (`crates/host-native/src/guest.rs:2088`): hardcoded
  `|_c: Caller<'_, ()>| -> i32 { 0 }` with the comment "the single guest is
  the process leader (tid == pid), not a pthread worker."

**Finding: the field is never mutated anywhere in the current tree.** A
repository-wide grep of `host/src/*.ts`, `web-libs/`, and `apps/` for
`isThreadWorker` finds only the declaration and the getter — no assignment
sets it to `true` anywhere in Node or browser code today (only a stale
generated `.d.ts` in `host/dist/` mentions it as a type). Practically, this
import returns `0` unconditionally on **every** host today, same as native's
hardcode. This makes the migration very low-risk (no observable behavior
changes for any currently-exercised path), but it also means the actual
multi-worker pthread-exit model this field exists for is not wired up yet
anywhere in the codebase — worth a note for whoever eventually needs real
per-thread topology here (out of this grounding's scope to resolve; flagged,
not investigated further).

**Done-state.** Move `isThreadWorker` from a per-call host import into
something the kernel receives once at initialization (an init-payload flag or
a kernel-global set at instance construction), removing the per-query import
entirely. Native's existing hardcoded-`0` becomes the same shape trivially
(pass `false`/`0` at init).

**Current status.** Not started.

**Effort/risk/scope.** Small; single call site in the kernel
(`wasm_api.rs:10009`), single field in `host/src/kernel.ts`. Cross-host
(shared `kernel.ts`); native side is a trivial mirror. No ABI-visible ordinal
change if done as an added init field rather than a new import; if it becomes
a kernel-global written at init time by an existing init-payload channel, no
ABI bump is likely needed — confirm exact init-payload shape before treating
this as free. **Shippable now, no dependencies**, but a maintainer should
independently confirm whether the pthread-worker exit path is truly dead code
today or whether some other untested mechanism sets this at runtime (this
grounding did not find one, but a live-multi-thread fixture was not exercised
to double check dynamically).

---

## H3 — `host_last_errno` → in-band return (bigger finding: likely delete, not redesign)

**Host requirement as scoped by the plan** (`fork-module/src/
host_capabilities.rs:68`): a `wpk_fork_host.host_last_errno() -> i32` import
that smuggles an `Errno` beside a `u32` handle for a family of handle-
returning capability calls (`host_mint_exception_tag`,
`host_provide_unwind_transport_tag`, `host_recognize_unwind_transport`,
`host_instantiate_child`, `host_spawn_thread`).

**Finding: this entire seam is dead scaffold, not a live capability.**
- The module (`crates/fork-module/src/host_capabilities.rs`) says so itself:
  "NOT WIRED TO THE GUEST. This slice only DECLARES the imports and proves the
  backend compiles... Actually routing the guest's reference reconstruction
  through these imports is the D6 live-integration step, left for user
  review." The only caller is `fm_host_capabilities_probe`, whose own doc
  comment says it exists "solely so `wasm-ld` retains the (otherwise
  unreferenced) imports; the host never calls it."
- Grepping all of `host/src/*.ts` for `mint_exception_tag`,
  `provide_unwind_transport_tag`, `recognize_unwind_transport`,
  `host_instantiate_child`, `host_spawn_thread` finds **zero** real
  implementations. `instantiateForkModule`'s `hostCapabilities` option
  (`host/src/fork-module-instance.ts:288`, the parameter meant to carry real
  bodies) is **never passed by any caller** in `worker-main.ts` — confirmed by
  grep. So on Node/browser these 6 imports default to the inert `() => 0`
  stub for every fork, always (`fork-module-instance.ts:497-501`).
- Native traps every remaining `wpk_fork_host.*` import
  (`crates/host-native/src/guest.rs:4433-4443`,
  `linker.define_unknown_imports_as_traps`) with the comment "this frames-only
  path never calls any of them, and native's `ForkHostCapabilities` primitives
  ... are direct Rust calls ... not Wasm imports the module reaches."
- Critically, the now-complete reference-completeness work (F5/F6, un-gated on
  all hosts) **did not end up needing this seam at all**: exnref is handled by
  a guest-local export (`__wpk_fork_exception_materialize` does the
  throw/`catch_ref`; the tag is guest-module-local, "adds NO new engine-floor
  callback" — `worker-main.ts:4367-4392`), and typed-GC reconstruction reuses
  the pre-existing JS drive-order (`materializeTypedGraph`), also with no new
  engine-floor callback. The "lifecycle floor"
  (`host_instantiate_child`/`host_spawn_thread`) is likewise not how real fork
  child instantiation works on any host (Node/browser spawn Workers; native
  uses its own `launch_process`/co-resident-module machinery) — nothing calls
  through this scaffold for that either.

**Done-state (revised from the plan's framing).** The plan text ("fold the
Node/browser side into a richer in-band encoding so the import vanishes")
assumes this seam is live and just poorly encoded. It is not live. The
higher-value, lower-risk action is very likely **deletion**: remove
`crates/fork-module/src/host_capabilities.rs` (and the `fm_host_capabilities_
probe` retention export), which removes 6 declared-but-never-implemented
`wpk_fork_host.*` imports from the compiled fork-module artifact, the
`forkHostStubs` stub-loop in `host/src/fork-module-instance.ts:491-501`, and
the corresponding trap-catch-all comment/dead branch in native's
`guest.rs:4433-4443`. This is a bigger, more certain host-surface reduction
(6 imports, all hosts) than the plan's narrower "fix the errno encoding"
framing, and it doesn't require redesigning anything, since nothing depends
on the current shape.
**Caveat:** confirm with whoever owns the exception/unwind design (the
`ForkHostCapabilities`/`ForkLifecycleCapabilities` traits in `crates/fork-
codec`) that no near-term plan intends to actually wire this seam for real
(e.g. a future different exception/thread model). If deletion is premature,
the fallback done-state is the plan's original ask: collapse the handle+errno
pair into one in-band `i64`/tagged return so `host_last_errno` itself
disappears while the rest of the seam stays scaffolded.

**Current status.** Scaffold present, unused on every host; not started
either way (deletion or redesign).

**Effort/risk/scope.** Small if deleting (dead-code removal, no behavior
change on any host since it's never exercised); needs a decision from
whoever holds the exception/unwind-transport design intent before deleting
(this grounding recommends confirming, not deleting unilaterally). Moderate
if instead redesigning the encoding while keeping the seam speculative
(more work for a capability nothing calls). Cross-host by nature (native +
Node/browser + the shared `fork_codec`/`fork-module` Rust). Independent of
B2-B5 (does not block or get blocked by the fork/reference work, since it's
dead code left over from an earlier design that the actual F5/F6 work
bypassed).

---

## H4 — synthetic network-interface ioctls → Rust

**Host requirement today.** `SIOCGIFCONF`/`SIOCGIFNAME`/`SIOCGIFHWADDR`/
`SIOCGIFADDR`/`SIOCGIFINDEX` are decoded and fully computed in
`host/src/kernel-worker.ts`:
- Constant tables: `VIRTUAL_INTERFACES = [{name:"lo",index:1,loopback:true},
  {name:"eth0",index:2,loopback:false}]` (`kernel-worker.ts:947-950`) and the
  ioctl request numbers (`:938-946`).
- A per-boot random MAC generated in TS via `crypto.getRandomValues`
  (`kernel-worker.ts:3447-3454`, `this.virtualMacAddress`), consumed by
  `handleIoctlIfhwaddr` (`:20217-20255`).
- Full `struct ifreq`/`struct ifconf` marshalling and the interface lookup/
  enumeration logic (`handleIoctlIfconf` `:20104-20180`+,
  `handleIoctlIfhwaddr`, `handleIoctlIfaddr`, and an index-lookup handler,
  `:20181-20330`).
- The dispatch is currently split: the syscall-arg pointer-marshalling
  decision (which ioctl argument is a pointer, for retry/blocking purposes)
  is inline in `kernel-worker.ts` (around the `SYS_IOCTL` case,
  `request === SIOCGIFCONF || ...`), not in Rust.

**Verified: zero Rust-side involvement.** `grep -rn "SIOCGIF" crates/` and
`find crates/kernel/src -iname "*net*"` both return nothing. There is no
`runtime-core` module for network-interface ioctls at all; this is 100%
reimplemented, host-computed kernel semantics with no host capability
dependency (no browser/Node/OS network API is actually consulted for the
interface list, index, or hardware type — only `io.network?.localAddress` for
the non-loopback IPv4 address, which genuinely is host-owned network state).

**Done-state.** Move the interface table (`VIRTUAL_INTERFACES`), MAC
generation, and `struct ifreq`/`ifconf` marshalling logic into
`crates/runtime-core` as an authoritative Rust ioctl handler, with the host
providing only the one irreducible piece: the real assigned IPv4 address
(already an existing host capability, `io.network.localAddress`). The MAC
should probably move to a kernel-owned deterministic-or-random-at-boot value
(a `runtime-core`-owned RNG seeded at kernel init) rather than a TS
`crypto.getRandomValues` call, since kernel init already needs some entropy
source for other purposes (`host_getrandom` exists as a capability already,
per `crates/host-native/src/guest.rs` grep — reuse it rather than adding a new
one).

**Current status.** Not started at all; this is the least-touched H item.

**Effort/risk/scope.** Moderate: it's a genuine kernel feature port (new
`runtime-core` module + syscall wiring + removing five TS handler methods and
~400 lines total of `kernel-worker.ts` logic including the `struct` layout
math for wasm32 vs wasm64 `ifreqSize`), not a one-line fix like H1/H2. Risk is
low (self-contained syscall family, well-covered by the existing marshalling
logic to port faithfully) but requires care to preserve exact byte layout
(`ifreqSize` differs 32 vs 40 bytes between pointer widths,
`kernel-worker.ts:20077-20079`). Cross-host (shared `kernel-worker.ts`); once
in `runtime-core` it is automatically available to native as well (native
today implements none of this — not found in `guest.rs`), which would be a
net-new native capability more than a native reduction, but it removes
TS-computed semantics from Node/browser, which is the actual ask. No ABI
version bump expected (internal implementation move, same syscall/ioctl
numbers and wire layout). Independent of B2-B5.

---

## H5 — `/dev/shm` + `MemoryFileSystem`/`VirtualPlatformIO` deletion

**Host requirement today.** `/dev/shm` is backed by a **host-TS**
`MemoryFileSystem` instance wrapping a plain `SharedArrayBuffer`:
`host/src/node-kernel-worker-entry.ts:1150-1152` —
```
const shmSab = new SharedArrayBuffer(16 * 1024 * 1024);
const shmfs = MemoryFileSystem.create(shmSab);
shmfs.chmod("/", 0o1777);
```
mounted at `/dev/shm` alongside the rootfs overlay and `DeviceFileSystem`
(`:1163-1164`). `MemoryFileSystem` (`host/src/vfs/memory-fs.ts`, **8,198
lines**) and `VirtualPlatformIO` (`host/src/vfs/vfs.ts`, 498 lines) are large,
TS-owned filesystem implementations that predate the Phase 5 in-kernel VFS
cutover.

**Where the kernel already is (Phase 5 landed).** `crates/runtime-core/
src/tmpfs.rs` (1,724 lines) is a real, in-kernel, unconditional (flag removed
in "VFS: make in-kernel tmpfs scratch mounts unconditional; delete
WASM_POSIX_TMPFS kill-switch") tmpfs implementation that already backs `/tmp`
and other scratch mounts. `crates/runtime-core/src/rootfs.rs` and
`syscalls.rs` already know about `/dev/shm` as a **foreign-owned** prefix the
in-kernel overlay must not claim (`rootfs.rs:464,2592-2626`,
`syscalls.rs:2070-2122`) — i.e., the kernel already routes `/dev/shm` requests
around itself to the host-owned mount, but does not yet own the backing store
for it.

**Done-state (as scoped by the plan).** Subsume `/dev/shm` into the
already-existing in-kernel `tmpfs.rs` (so it is no longer a host-TS
`MemoryFileSystem`/foreign mount at all), then delete `MemoryFileSystem` and
`VirtualPlatformIO` entirely, collapsing all FS host imports down to byte-leaf
capabilities (raw file/dir syscalls on real host storage, e.g.
`HostFileSystem`/`DeviceFileSystem`) with no host-side "filesystem" abstraction
layer left.

**Open question this grounding could not fully settle.** The plan states this
"needs SAB-shared `mmap` handled in Rust first" as a hard prerequisite. This
grounding found existing in-kernel `MAP_SHARED` support
(`crates/runtime-core/src/syscalls.rs:10273` doc, `pshared.rs`) for
**file-backed** `MAP_SHARED` with msync writeback, but the campaign's own
prior-session finding
(`docs/plans/.../cross-process-shared-memory-vs-opcache.md`, referenced in
user memory) is that genuinely **cross-process** shared anonymous memory is a
Wasm-platform impossibility today (no cross-Worker shared address space
except through the kernel's own single shared wasm `Memory`, which already IS
shared across every worker/thread of one kernel instance via wasm threads).
Since `crates/runtime-core`/`crates/kernel` itself already runs with a shared
wasm `Memory` across all guest-thread workers of one machine (that is how the
existing in-kernel `tmpfs.rs` is visible to every process/thread already), it
is **not obvious from this reading** that `/dev/shm` specifically needs any
*new* mmap capability beyond what `tmpfs.rs` already provides for `/tmp` —
this may be simpler than the plan assumes, or there may be a real distinction
(POSIX `shm_open`+`mmap(MAP_SHARED)` semantics vs. a plain tmpfs file) that
this grounding did not trace far enough to confirm or rule out. **Flagging
this as worth a dedicated, narrower grounding pass before scoping H5's
implementation size**, rather than asserting effort here.

**Current status.** Not started (the `/` authority handoff described as "done"
in the plan item is real — see `rootfs.rs`'s foreign-prefix handling — but the
backing store and the `MemoryFileSystem`/`VirtualPlatformIO` deletion are not).

**Effort/risk/scope.** Large, as the plan says: `MemoryFileSystem` is an
8,198-line file used by more than `/dev/shm` (also the rootfs overlay backing
on the seeded in-memory path, per `binary-resolver.ts`,
`browser-kernel-worker-entry.ts`, and test fixtures) — full deletion is a
substantial, multi-file migration, not a small independent item. It is
reasonably separable from H1-H4 and from B2-B5 (no shared machinery), but it
depends on settling the mmap/shared-memory question above first. Recommend
treating H5 as its own increment with its own grounding, sequenced after
H1-H4, not batched with them.

---

## H-def — async completion-channel park (`host_futex_wait`/`host_futex_wake`, `Atomics.waitAsync`)

**Host requirement today.** `host_futex_wait`/`host_futex_wake` are live,
heavily-used imports (`crates/kernel/src/wasm_api.rs:202-203`). Node/browser
back them with a deep, pervasive `Atomics.waitAsync`-based event loop
threaded through `host/src/kernel-worker.ts` (dozens of call sites: channel
listen/retry, `host-adapter-manifest.ts:105-107` capability-detects
`Atomics.waitAsync` itself, `node-kernel-worker-entry.ts` documents the
independent event loop). This is the deepest, most load-bearing piece of
host-owned scheduling logic in the codebase — genuinely a different order of
magnitude from H1-H4.
**Native:** `grep` found no `host_futex_wait`/`host_futex_wake` wiring at all
in `crates/host-native/src/guest.rs` (only `host_futex_wake`-adjacent
comments about a "current process memory" cell, not a wired import) —
suggesting native's guest threading/futex model does not yet go through this
exact seam, or blocking-wait isn't implemented the same way for the
native (currently single-guest-thread, per the `host_is_thread_worker`
hardcode) target. Not traced further; explicitly out of scope since the plan
already defers this item.

**Done-state.** Per the plan: an eventual cleaner/faster completion-channel
park primitive (`host_wait`/`host_wake`), replacing `Atomics.waitAsync` +
`host_futex_wait` polling. Deferred, "land opportunistically; not required
for correctness or the freeze gate."

**Current status.** Not started; correctly deferred per the plan (this
grounding agrees the item is far larger and riskier than H1-H4 and should
stay out of the M5 gate).

**Effort/risk/scope.** Large, high-risk (touches the syscall hot path and
blocking semantics directly — the Performance Contract's explicitly named
"known-bad" territory: `host/src/kernel-worker.ts` syscall-path
"optimizations" are called out by name in `CLAUDE.md`). Do not schedule this
inside the M5 host-surface gate; it is correctly listed as opportunistic/
deferred.

---

## Ordered recommendation

1. **H1 (`host_debug_log` narrow sink) — do first.** Smallest, best-understood,
   already half-done (native is correct; Node/browser is the only side that
   needs to change), zero dependencies, fixes a genuine live cross-host
   inconsistency (stdout+prefix vs stderr+raw) today.
2. **H2 (`host_is_thread_worker` → init-time config) — do second.** Same size
   class as H1, no dependencies, but flag the "field is never actually set to
   true anywhere" finding to whoever owns pthread-exit semantics before
   trusting this is purely cosmetic.
3. **H3 (`host_last_errno` seam) — do third, but as a confirm-then-delete,
   not a redesign.** Get a one-line confirmation that the
   `wpk_fork_host.*`/`ForkHostCapabilities`/`ForkLifecycleCapabilities`
   exception-tag/lifecycle scaffold in `crates/fork-module/src/
   host_capabilities.rs` is genuinely superseded by the guest-local exnref +
   JS-drive-order design that shipped in F5/F6 (this grounding's evidence
   says yes), then delete the whole scaffold (6 imports, all hosts) rather
   than re-encoding the errno. This is higher-value than the plan assumed
   (deletion, not redesign) but needs that one confirmation first since it
   touches a still-open design area (exception/unwind transport).
4. **H4 (network ioctls → Rust) — do fourth.** Larger than H1-H3 (~400 lines
   to port faithfully, new `runtime-core` module), but self-contained,
   zero real host-capability dependency beyond the one IPv4 address already
   exposed, and a clean, uncontroversial "reimplemented kernel semantics"
   case. No cross-item dependency; can run in parallel with H1-H3 if
   resourcing allows.
5. **H5 (`/dev/shm` + `MemoryFileSystem`/`VirtualPlatformIO` deletion) —
   defer, ground separately.** Confirmed large (8,198-line file, used beyond
   `/dev/shm`) and gated on an unresolved question (does `/dev/shm` actually
   need new SAB-mmap machinery, or can it reuse the kernel's existing shared
   wasm memory the way `tmpfs.rs` already does for `/tmp`?). Recommend a
   dedicated grounding pass for H5 alone before sizing an increment; do not
   batch it with H1-H4.
6. **H-def (async completion-channel park) — leave deferred**, exactly as the
   plan already says. Do not pull into the M5 gate; it's a syscall-hot-path
   redesign, not a small host-surface trim, and the Performance Contract
   specifically warns against ad hoc changes in this exact file
   (`host/src/kernel-worker.ts`).

**Batch shape for one increment:** H1+H2 are small enough and independent
enough to land together in a single `subagent-driven-development` increment
(same "small, obviously safe TS diff" shape). H3 needs its confirm-first step
before it can join that batch (or can follow immediately after as its own
small increment once confirmed). H4 is a full task on its own. H5 should not
be scoped until it has its own grounding. H-def stays parked.
