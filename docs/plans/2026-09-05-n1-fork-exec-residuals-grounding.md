# N1 fork/exec residuals grounding (2026-09-05)

**Scope:** read-only audit for campaign Decision 4 (`docs/plans/
2026-09-05-rust-first-campaign-to-completion.md`, §Decisions #4 and §B5): the
three native fork/exec residuals — (1) real vfork, (2) non-main-thread
fork/execve, (3) multi-threaded-execve sibling teardown. Worktree
`/Users/brandon/kandelo-abi44-reconcile`, branch
`brandonpayton/rust-first-abi44-reconcile`, HEAD
`3944c7dbdfd885ec35fc184d361ca64619b263e0` (2026-09-06 04:39:23 -0400). No code
was changed, built, or committed to produce this document.

---

## 1. Is real vfork already implemented anywhere?

**Yes — fully, for Node and browser.** Real vfork (child shares the parent's
address space; parent's syscall blocks until the child execs, exits, or traps)
is implemented via three cooperating, mostly host-agnostic pieces:

### 1a. Kernel authority (host-agnostic, `crates/`)

- `crates/shared/src/lib.rs:186-205` — `fork_contract::Mode::{Fork,Vfork}`,
  `MODE_FORK`/`MODE_VFORK` wire constants shared by every host and by libc.
- `crates/kernel/src/wasm_api.rs:1983-2002` (`kernel_fork_process`) — doc
  comment states the intended split explicitly: *"ordinary fork owns a memory
  clone, while genuine vfork will borrow the parent's memory and suspend only
  its calling thread until exec or exit."*
- `crates/runtime-core/src/process_table.rs:1037-1090`
  (`fork_process_for_caller_with_mode`) — sets `child.vfork_child = mode ==
  Mode::Vfork` (line 1089) and rejects starting a **second** vfork from a
  process that is already a live vfork child (`parent.vfork_child` check,
  line 1059, `Errno::EAGAIN`). This is real, host-independent kernel state.
- `crates/runtime-core/src/syscalls.rs:16025-16027` — `clone()`/pthread-create
  is rejected with `EAGAIN` while `vfork_child` is set (a borrowed child may
  not spin up another memory owner before exec/`_exit`), matching the doc
  comment at `process_table.rs:1039-1041`.
- `crates/fork.rs` clears `vfork_child` on exec (`crates/runtime-core/src/
  fork.rs:1622`, `:2084`) and on ordinary exit paths
  (`crates/runtime-core/src/syscalls.rs:974`, `:28773`, `:38725` are the
  matching test/production set/clear sites).

This kernel-side authority is **not a stub** — it is live, POSIX-shaped
bookkeeping that already gates re-entrant fork/clone during the borrowed
window, for every host including native (any host that calls
`kernel_fork_process(..., MODE_VFORK)` gets it for free).

### 1b. The shared replay substrate — `crates/fork-module/src/lib.rs`

This is the **existing campaign solution to reuse** (do not reinvent) for the
"child replays over borrowed memory" half:

- `fm_begin_child_replay` (COW path) reclaims the heap and owns chunks
  (`begin_child_replay_impl`, `crates/fork-module/src/lib.rs:1799-1816`).
- `fm_begin_borrowed_child_replay` (vfork path, exported at
  `crates/fork-module/src/lib.rs:3030-3047`, impl
  `begin_borrowed_child_replay_impl` at `:1965-1994`) is the **borrowed**
  sibling: it does **not** reclaim the heap (fresh, single-use instance
  sharing the parked parent's memory), decodes the journal image read-only,
  owns **no** chunks (`new_channel(0)` arena so finish/abort munmaps nothing —
  guaranteeing it can never unmap the parent's live storage), and copies the
  parent's mutable "fixed runtime prefix" into a **child-private**
  `private_prefix` region (`copy_borrowed_child_prefix`, `:2003-2041`) so the
  guest's active-frame-pointer rewrites never touch the parked parent's
  prefix. The doc block at `:1943-1964` spells out this exact contract.
- `fm_add_activation_borrowed_child_replay` / `add_activation_borrowed_child_
  replay_impl` (`:3054-3061`, `:2054-2105`) is the dlopen/multi-activation
  ("mode-1") sibling of the same mechanism.

This module is Rust, compiled to Wasm, and **co-resident in every host**
(Node, browser, and — per campaign N1-I4 T1 — native, which already
instantiates this same fork-module binary). Its exports are host-agnostic; any
host that wires the memory-sharing and parent-block plumbing around it gets
the same replay algorithm.

### 1c. Host-specific plumbing that currently exists only for Node/browser

- `host/src/vfork-workspace.ts` (`BorrowedVforkWorkspace`) — host-agnostic TS
  (lives in `host/src/`, not a browser- or Node-only directory) that carves a
  child-private prefix + scratch range out of the **same** `WebAssembly.
  Memory` object, never cloning it.
- `host/src/vfork-lifetime.ts` (`VforkLifetimeCoordinator`,
  `VforkLifetimeDisposition`) — host-agnostic TS state machine: phases
  `starting -> borrowing -> settled`; a `Promise`-based completion that
  resolves to `resume-parent` (child exec'd/exited normally), `return-error`,
  or `contain-address-space` (ambiguous teardown — signal/trap while
  borrowing) once the child reaches exec, exit, signal, or trap
  (`VforkExactCompletionReason`, `host/src/vfork-lifetime.ts:8-13`).
- `handleVfork` is duplicated **per host** — `host/src/node-kernel-worker-
  entry.ts:1881` and `host/src/browser-kernel-worker-entry.ts:2064` — because
  Node `worker_threads` and browser `Worker` have different spawn/lifecycle
  APIs, but both call into the same shared `BorrowedVforkWorkspace` +
  `VforkLifetimeCoordinator` + fork-module exports. Concretely
  (`browser-kernel-worker-entry.ts:2064-2135`): the child gets a **retained
  alias of the parent's own `WebAssembly.Memory`**
  (`parentInfo.memoryLease.retainAlias()`, line 2100 — real sharing, not a
  copy) plus a private "host control workspace" slot
  (`threadAllocator.allocateHostControl`, line 2109) for its prefix/scratch;
  the child Worker instantiates its own fresh module over that shared Memory
  and drives `fm_begin_borrowed_child_replay`. The parent's `SYS_VFORK`
  channel reply is not sent until `await handleVfork(...)`'s promise resolves
  (real, kernel-observable parent blocking — not a busy-poll simulation).
  `finishVforkDisposition`/`containVforkAddressSpace`
  (`browser-kernel-worker-entry.ts:1986-2062`) implement the "settle" side:
  on ambiguous teardown (signal/trap while still borrowing) it force-exits
  both processes with `SIGSEGV` rather than risk two live owners of one
  Memory.

**Conclusion:** real vfork is fully solved as a *design and a working Node +
browser implementation*. It is not "aspirational" prose — `crates/kernel` and
`crates/fork-module` sides are real, host-agnostic Rust; `vfork-workspace.ts` /
`vfork-lifetime.ts` are real, host-agnostic TS; only the two worker-model-
specific `handleVfork` bodies are duplicated because Node and browser have
different worker primitives.

---

## 2. What does NATIVE do for vfork today?

**Native's `mode` argument is threaded through faithfully at the wire/kernel
level, but native's actual memory/lifetime handling treats vfork exactly like
an ordinary COW fork.** There is no borrowed memory, no private-prefix
isolation, and no parent block-until-exec/exit.

Evidence, `crates/host-native/src/guest.rs`:

- `use wasm_posix_shared::fork_contract::MODE_VFORK;` — line 59.
- The `kernel_fork` host import closure (registered at `guest.rs:4765-4841`)
  branches on `ForkCoordPhase` (`Idle`/`Replaying`), **not** on `mode`, for
  everything except which raw syscall number to stamp:
  - Non-instrumented parent (`fork_format.is_none()`, lines 4770-4796): posts
    `SYS_VFORK` vs `SYS_FORK` on the channel (line 4771) purely as a wire
    label, blocks on the channel status word, and returns whatever
    `handle_fork` writes back — **identical shape to a plain fork**.
  - Instrumented parent, `Idle` phase (lines 4798-4821): `coord.set_mode(mode
    as u32)` (line 4808) just remembers the mode for later; capture proceeds
    identically regardless of mode.
- `drive_fork_capture_seal_and_launch_child` (`guest.rs:6916-7207`) is the
  function that actually posts the real `SYS_FORK`/`SYS_VFORK` request
  (`mode == MODE_VFORK` only selects the syscall number at line 7139) and then
  blocks on the channel (lines 7158-7164) **only until `handle_fork` finishes
  creating and launching the child process** — not until the child execs or
  exits. Once that reply arrives it immediately drives the *parent's own*
  rewind (`fm_begin_replay`, `drive_reference_replay`, `wpk_fork_rewind_begin`)
  and returns to running the parent concurrently with the child.
- `handle_fork` (`guest.rs:8702-8860+`) is the function that actually builds
  the child. Regardless of `mode` (read at line 8725 only to forward into
  `kernel_fork_process`, line 8759), it **always**:
  1. Calls `fork_process.call(..., (parent_pid, caller_tid, mode))` — this
     sets the kernel's `vfork_child` bookkeeping correctly (§1a) but has no
     bearing on the host-side memory transaction.
  2. Calls `clone_guest_memory(engine, &guest_mem)` (line 8769) — a **private,
     byte-for-byte copy** of the parent's entire guest memory into a fresh
     `SharedMemory`, unconditionally. This is the COW-fork memory strategy;
     there is no branch that instead hands the child a `clone()` of the same
     `SharedMemory` handle (which is what real sharing would require).
  3. Calls `launch_process` to spin up the child on its own OS thread against
     that private copy, and replies to the parent's blocked channel wait with
     `child_pid` right away — the parent resumes running **concurrently**
     with the child from that point, not "suspended until child exec/exit."

Nowhere in `crates/host-native` does `begin_borrowed_child_replay` /
`BorrowedVforkWorkspace`-equivalent logic appear:

```
$ grep -rn "begin_borrowed_child_replay\|BorrowedVforkWorkspace" crates/host-native/src/*.rs
(no matches)
```

**Net:** native `vfork()` is POSIX-*permissible* (vfork's semantics are a
strict superset restriction of fork's — any correct `fork()` implementation is
also a legal, if suboptimal, `vfork()`), and the `vfork_child` re-entrancy
guard (§1a) is honored because it lives in the shared kernel. But it is not
*real* vfork: a program that depends on the child's writes being visible to
the parent through shared memory before/without an exec, or on the parent
being provably stalled while the child runs, will not observe that behavior on
native today. This is a correctness-observable gap only for programs that rely
on vfork's stronger guarantee (rare, since POSIX only promises well-defined
behavior for a narrow vfork-child code shape) — but it is the one documented
in `crates/kernel/src/wasm_api.rs:1987-1990`'s own comment as still
outstanding.

---

## 3. What native must do to wire into the existing vfork solution

This is a **wiring problem shaped exactly like Node/browser's own
`handleVfork`, not a new algorithm**, with one genuinely new piece: native has
no equivalent of a JS `Worker` + `Promise`-based lifetime coordinator, so that
coordination logic needs a Rust shape. Concretely, in `handle_fork`
(`guest.rs:8702` on) native needs a `mode == MODE_VFORK` branch that:

1. **Does not call `clone_guest_memory`.** Instead give the child the **same**
   `SharedMemory` handle the parent uses (`guest_mem.clone()` — wasmtime's
   `SharedMemory` is already `Arc`-backed / cheaply cloneable as a handle to
   the same backing store; this is the Rust-native analog of `retainAlias()`
   in `browser-kernel-worker-entry.ts:2100`).
2. **Reserve a child-private prefix/scratch region** inside that shared
   memory before instantiating the child — the Rust analog of
   `BorrowedVforkWorkspace` / `threadAllocator.allocateHostControl`
   (`vfork-workspace.ts`). Native's `layout`/scratch allocation code
   (`processes[pi].scratch_base`, `layout.channel_offset`, already used
   throughout `handle_fork`) is the place to model this; the exact sizing
   contract is `copy_borrowed_child_prefix`'s validation
   (`fork-module/src/lib.rs:2003-2041`): non-zero, alignment-checked, and
   non-overlapping with the borrowed continuation storage.
3. **Instantiate the child's fork-module against `fm_begin_borrowed_child_
   replay` instead of `fm_begin_child_replay`.** Native's `ForkModule` wrapper
   already holds `TypedFunc`s for the ordinary child-replay exports (used via
   `fork_entry: ForkEntry::ChildReplay { root, image_ptr, image_len }` at
   `guest.rs:8740-8757`); it needs an analogous `ForkEntry::ChildBorrowedReplay`
   arm that calls the borrowed export with the reserved `private_prefix`
   address, mirroring exactly what `fm_begin_borrowed_child_replay`
   (`fork-module/src/lib.rs:3030-3047`) expects.
4. **Park the parent's OS thread until the child reaches exec, `_exit`, a
   signal, or a trap**, then resolve to one of the same three dispositions
   Node/browser use (`resume-parent` / `return-error` / `contain-address-
   space`). Native has no JS `Promise`; the natural Rust shape is a
   `std::sync::mpsc`/`Condvar`-based one-shot channel the child's exec/exit/
   panic path signals into, analogous to `VforkLifetimeCoordinator`'s
   `completion: Promise<VforkLifetimeDisposition<...>>`
   (`vfork-lifetime.ts:38-49`). **This coordinator does not exist as shared
   Rust today** — it is currently TS-only logic duplicated per host-worker
   model. Porting its *state machine* (not its JS mechanics) into native is
   the one piece that is closer to net-new than "call an existing export,"
   though the *protocol it must implement* (three dispositions, "vfork
   child may only exec-family or `_exit`" enforcement — see
   `worker-main.ts:1215`, `:2355-2361` for the enforcement shape to mirror)
   is already fully specified by the Node/browser implementation, so it is
   porting a known design, not inventing one.
5. **On exec** (the common resolution): the child's `execve` handling already
   replaces its own image in place (native's `handle_exec_common`); what is
   new for the vfork case is that *after* that image replacement, the child
   needs its **own private memory** going forward (the borrow must end) —
   this is the "contain the address space" step
   (`containVforkAddressSpace`/`finishVforkDisposition`,
   `browser-kernel-worker-entry.ts:1986-2062`) that native has no analog of
   yet, since it never had a shared-memory child to un-share.

**Effort characterization:** the *replay algorithm* (item 3) and the *kernel
authority* (§1a) are zero-cost reuse — call the existing exports, no new
logic. Items 1-2 are small, mechanical translations of an existing, fully
specified TS design into Rust using primitives native already has
(`SharedMemory` clone, scratch/layout allocation). Item 4 (the lifetime
coordinator + parent block) and item 5 (address-space containment on exec) are
the real work: not because the design is unknown — Node/browser's
`vfork-lifetime.ts` + `handleVfork` fully specify it — but because native has
no existing scaffolding (no coordinator type, no "OS-thread-park-until-signal"
primitive, no "un-share this memory into a fresh private copy" helper) to hang
it on. This is **moderate, not large**: a genuinely new Rust module modeled
line-for-line on an existing, working design, not blue-sky design work.

---

## 4. Non-main-thread fork/execve

**Native traps/silently mishandles fork, vfork, execve, and execveat when
issued from a non-main channel (a pthread). Node and browser already fully
support fork-from-thread; execve-from-thread parity was not confirmed by
reading alone.**

### Fork-from-thread

- The `kernel_fork` import's own doc comment states the native limitation
  explicitly (`guest.rs:4710-4712`): *"this import is only ever reached from
  the process's main thread — a worker-thread `fork()` is not wired up by
  this host and traps, unchanged from before this task."*
- The non-instrumented-parent branch of that same closure
  (`guest.rs:4770-4796`) has no `ch.is_main` gate at all — it always posts
  directly on `layout.channel_offset` (the **main** channel offset, captured
  once at closure-construction time, `guest.rs:4759-4760`), so even if a
  pthread called `fork()`, it would race/collide with the main channel rather
  than use its own.
- Contrast with Node/browser: `host/src/worker-main.ts` has an entire
  documented "fork-from-thread" subsystem — `wpk_fork_resume_thread`
  (`worker-main.ts:5057-5065`, `:7008-7015`), a per-thread fork lock
  (`worker-main.ts:6233`, `:6271`), and dedicated parent-side plumbing
  (`worker-main.ts:6456-6828`, `:7111-7113`) for "the pthread PARENT worker
  that ran a fork through it." This is real, exercised machinery, not a stub —
  confirmed present in both `node-kernel-worker-entry.ts` (lines 291, 419,
  3314-3332, 3426-3427) and `browser-kernel-worker-entry.ts` (lines 244, 1868,
  3576-3594, 3701-3702), i.e. shared via `worker-main.ts` and wired
  per-host only where Worker-model specifics require it.
- **Historical relevance:** the user's memory index records a
  `fork-from-thread signal-replay OOB` bug (2026-07-10, Node/browser fork-
  instrument rewind underflow when Ruby forks from a pthread). That was a
  **Node/browser** bug in the already-existing fork-from-thread machinery, now
  presumably long since fixed (it predates this campaign and isn't reachable
  from the current code without further git-log digging) — it is evidence
  that fork-from-thread is exercised, real functionality on those hosts, not
  evidence of a currently-open defect. It is not directly about native, which
  has no fork-from-thread implementation to have this bug in.

### Execve-from-thread

- Native's execve/execveat interception is gated `ch.is_main &&
  syscall_nr == SYS_EXECVE` (`guest.rs:8118`) and `ch.is_main && syscall_nr ==
  SYS_EXECVEAT` (`guest.rs:8154`) — a pthread channel (`is_main: false`, set at
  `guest.rs:8037` for cloned threads) never matches either branch.
- If a pthread does post `SYS_EXECVE`/`SYS_EXECVEAT`, control falls through to
  the generic `dispatch_once` (`guest.rs:8176-8179`), which for a non-record
  ("raw") syscall calls `stage_raw` + `bind_and_dispatch`
  (`guest.rs:7539-7541`) — the ordinary marshalled-syscall path. `SYS_EXECVE`/
  `SYS_EXECVEAT` are host-intercepted specifically because the real exec
  transition needs host-side exec-target resolution
  (`kernel_exec_target_prepare`/`read_exec_target_bytes`/`Module::new`/
  `exec_commit`, documented at `guest.rs:8256-8279` for the sibling
  `SYS_SPAWN` case) that the kernel's generic per-syscall dispatcher does not
  perform. **What exactly the kernel's generic dispatch returns for an
  un-intercepted `SYS_EXECVE`/`SYS_EXECVEAT` was not settled by reading alone**
  — it is plausibly `ENOSYS`/`EINVAL` (truthful failure) or it could silently
  misbehave depending on whether the kernel's dispatch table has any entry for
  those syscall numbers at all.
  - **Experiment to settle this:** compile a small pthread test program that
    calls `execve()`/`execveat()` from a non-main thread against
    `host-native`, run it, and observe the actual returned errno/trap (or add
    a targeted `host-native` integration test analogous to
    `smoke_fork_parent_child`).
- No evidence was found (via `grep -rn "execve.*thread\|thread.*execve"` over
  `host/src/worker-main.ts`) of a dedicated "execve-from-thread" subsystem
  comparable to fork-from-thread's `wpk_fork_resume_thread`. POSIX requires
  `execve` to work from any thread of a multithreaded process and to
  terminate every other thread as part of the image replacement — this is
  item 5's teardown concern folded in. Whether Node/browser handle
  thread-originated execve correctly was **not confirmed** by this reading
  pass; it needs its own targeted check (grep did not find a "not main
  thread" execve gate analogous to native's `ch.is_main`, which is weak
  evidence Node/browser do not have the same restriction, but is not
  confirmation they handle it correctly end-to-end).

---

## 5. Multi-threaded-execve sibling teardown

**Native tears down and joins every *parked* sibling channel on a successful
execve, but explicitly and deliberately leaves a *compute-bound* (non-parked)
sibling thread running, unjoined, against the doomed pre-exec image.** This is
a named, documented residual, not an oversight.

- `reclaim_all_channels` (`guest.rs:7684-7733`, doc comment `:7684-7713`):
  called from the execve-success path (`guest.rs:9195-9206`, specifically
  `guest.rs:9205`) with the OLD `GuestProcess` after `processes[pi]` has
  already been swapped to the new (post-exec) process. It walks every channel
  of the old process (`guest.rs:7721`) and, for each one, checks the channel's
  **empirically observed** status word: `STATUS_PENDING` means the sibling's
  OS thread is genuinely parked in `memory.atomic.wait32` and gets `TEARDOWN`
  written + `atomic_notify`'d (`reclaim_parked_thread`, `guest.rs:7651-7657`)
  then `join()`'d (`join_reclaimed_thread`, called at `guest.rs:7732`). Any
  other status means the sibling is **compute-bound inside the guest, not
  parked** — its handle is dropped **unjoined** (`guest.rs:7724-7728`,
  `thread_handles.remove(&ch.offset); continue;`).
- The doc comment (`guest.rs:7703-7713`) states the reason and scope
  explicitly: *"epoch/fuel cannot interrupt [a compute-bound thread]... this
  function deliberately does NOT touch or join a non-parked channel's
  thread — it is the documented, out-of-scope multi-threaded-execve residual."*
- The mechanism that *does* work (`TEARDOWN` sentinel) was derived and
  validated in `docs/plans/2026-09-05-native-thread-reclamation-spike.md`,
  option (b) (`exp_d`, spike doc's Q3/Q4 table) — but that spike's own Q1/Q2
  findings are exactly why compute-bound siblings are excluded:
  - Q1 (spike doc, "Does `Config::epoch_interruption` interrupt a parked
    `atomic.wait32`? NO.") establishes epoch/fuel do not help a **parked**
    thread (irrelevant to this residual, but explains why `TEARDOWN`+notify,
    not epoch, is the mechanism for parked siblings).
  - The **compute-bound** case is different: epoch interruption **does** work
    against *running* wasm (the spike's own `exp_a2` control case: "running
    spin loop trapped by epoch = true"). The blocker for compute-bound
    siblings is not that epoch interruption is technically impossible — it is
    that `crates/host-native`'s `Engine` **has no epoch-interruption or fuel
    configured at all today** (spike doc quoting `guest.rs:3866-3887`'s
    original leak-documentation comment). Turning that on is an engine-wide
    configuration change with performance implications for every guest call
    (every function entry / loop backedge gains an epoch check), not a
    localized fix.
- The campaign plan's own framing (`docs/plans/2026-09-05-rust-first-
  campaign-to-completion.md`, item B5/R3) matches this reading exactly:
  *"multi-threaded execve tears down NON-parked compute-bound siblings (today
  only channel-parked siblings reclaim via TEARDOWN). Likely needs a mechanism
  to force a compute-bound sibling to a reclaim point (revisit the spike's
  alternatives; a bounded cooperative checkpoint)."*
- **Consequence of the current gap:** a genuinely multithreaded native guest
  process where a **non-calling** thread is mid-computation (not blocked in a
  syscall) when another thread calls `execve()` will leak that thread (it
  keeps running against the old, superseded `SharedMemory`/module instance
  forever, or until it happens to reach a blocking syscall on a channel that
  no longer belongs to any live process). It does not corrupt the new
  (post-exec) process's state — the two `GuestProcess`/`SharedMemory`
  instances are already fully separated by the time `reclaim_all_channels`
  runs — but it is a real resource/thread leak and a POSIX violation (POSIX
  requires exec to terminate all other threads, not merely stop caring about
  them).

**What closing this needs:** enabling `Config::epoch_interruption` (or an
equivalent cooperative-checkpoint mechanism) on the native `Engine`, arming a
deadline for exactly the sibling threads of an exec'ing process, and having
their epoch-deadline callback resolve to "trap out" the same way `TEARDOWN`
does for parked threads — i.e., a second reclaim path parallel to
`reclaim_parked_thread`, gated on "compute-bound, belongs to a process whose
image was just replaced." This is genuinely open design work (the spike
explicitly deferred it), not a wiring exercise.

---

## 6. Scope/effort per residual, coupling, and risk ranking

| Residual | Native state today | Reuse vs net-new | Effort | Risk |
|---|---|---|---|---|
| **(1) Real vfork** | `mode` threaded through faithfully to the kernel (real `vfork_child` re-entrancy authority already active for native, §1a); host-side memory/lifetime handling is plain COW fork — no sharing, no parent block | **Mostly reuse.** Kernel authority (zero work) + fork-module borrowed-replay exports (call existing exports, zero new algorithm) + a Rust port of an already-fully-specified TS coordinator design (`vfork-lifetime.ts`/`vfork-workspace.ts`) — known shape, new code | **Moderate.** New Rust module + `handle_fork` branch + child un-share-on-exec step; no unknown design questions | **Medium.** Concurrency-shaped (shared `SharedMemory` handle, thread parking, containment-on-ambiguous-teardown) — the riskiest part to get memory-safety-correct, but the design to copy from is proven in production on two other hosts |
| **(2) Non-main-thread fork/execve** | Fork-from-thread: explicitly documented as unsupported/traps on native (`guest.rs:4710-4712`); Execve-from-thread: silently falls through to generic dispatch, exact failure mode unconfirmed by reading | **Net-new for native** on both halves; Node/browser already have a full, working fork-from-thread subsystem to model native's fork half on (`wpk_fork_resume_thread` + per-thread fork lock, `worker-main.ts`); execve-from-thread has **no** existing reference subsystem to point at even on Node/browser (unconfirmed by this reading pass) | **Moderate-to-large**, and possibly larger for the execve half if Node/browser also lack real support (would then require designing the semantics from scratch, coupled to residual 3) | **Medium-high** — touches channel routing/ownership assumptions (`is_main`) baked into several dispatch sites |
| **(3) Multi-threaded-execve sibling teardown** | Parked siblings reclaimed correctly (`TEARDOWN` sentinel, `reclaim_parked_thread`); compute-bound siblings deliberately left running/unjoined, documented residual | **Net-new.** The parked-sibling mechanism does not extend to compute-bound siblings; needs epoch-interruption (or equivalent) turned on for the first time in this host, plus a second reclaim path | **Moderate-to-large** — an engine-wide configuration change (perf-sensitive: every function call gains a check) plus new coordination logic | **Medium** — the spike already proved epoch interruption *can* stop running wasm (`exp_a2`); the open risk is scoping the deadline/callback to only the exec'd process's siblings without regressing hot-path performance elsewhere |

**Coupling:** (2)'s execve-from-thread half and (3) are coupled — POSIX
execve-from-any-thread inherently requires terminating sibling threads as part
of the same operation, so a real fix to "execve from a pthread" cannot be
correct without also solving "tear down compute-bound siblings" (residual 3).
(1) real vfork is **largely independent** of (2)/(3): it reuses a different
mechanism (borrowed memory + coordinator) and does not depend on epoch
interruption or thread-routing changes, though it does touch the same
`handle_fork` function and the same "child may not be a pthread owner" kernel
authority (§1a) that (2)'s fork-from-thread work would also touch, so
sequencing vfork before or after fork-from-thread avoids merge conflicts in
`handle_fork` and the `kernel_fork` import closure rather than creating a hard
dependency.

**Riskiest of the three:** residual (3) (compute-bound sibling teardown), because
it is the only one requiring a first-time, engine-wide behavioral change
(enabling epoch interruption) with a plausible performance blast radius beyond
the fork/exec path itself — every syscall hot-path call in `crates/host-native`
would gain an epoch check once interruption is turned on, which the
Performance Contract (`docs/agent-guidance/performance.md`) requires
benchmarking before/after, on top of the correctness work. Residual (1) is
next-riskiest for pure memory-safety reasons (a real bug there is a live
shared-memory two-owner hazard, not just a leak), but has the most complete
existing design to copy. Residual (2) is the least-understood in scope (the
execve-from-thread half's current behavior and Node/browser reference
behavior were not settled by reading) and needs the named experiment before
its effort can be sized precisely.
