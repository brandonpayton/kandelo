# N1 thread-fork/exec residuals grounding (2026-09-05)

**Scope:** read-only grounding for the two remaining, coupled native fork/exec
residuals from `docs/plans/2026-09-05-n1-fork-exec-residuals-grounding.md`
(residuals #4 non-main-thread fork/execve, #5 multi-threaded-execve
compute-bound sibling teardown; that doc's own §4/§5/§6 numbering called them
"(2)" and "(3)"). Worktree `/Users/brandon/kandelo-abi44-reconcile`, branch
`brandonpayton/rust-first-abi44-reconcile`, HEAD `bc8ab8141c4a52e973a0d1695d3ea
661cbd15551` ("Host-native: real vfork (borrowed child + parent suspension)
reusing kernel authority (residual)", 2026-09-06T06:43:14-04:00). No code was
changed, built, or committed to produce this document.

---

## 1. Non-main-thread `fork()` (#4a)

**Native has no `kernel.kernel_fork` import at all on a pthread's `Store`.**
This is not a semantic trap inside fork logic — the import is simply absent
from that thread's linker, so wasmtime's own "call an unknown import" stub
fires.

- The main (process-owning) OS thread's guest `Store`/`Linker` is built in
  `spawn_guest_thread` (`crates/host-native/src/guest.rs:4777`), which
  `func_wrap`s `kernel.kernel_fork` at `guest.rs:5204` (closure body through
  ~`guest.rs:5330`). Its own doc comment states the limitation explicitly
  (`guest.rs:5147-5149`): *"this import is only ever reached from the
  process's main thread — a worker-thread `fork()` is not wired up by this
  host and traps, unchanged from before this task."*
- A pthread's `Store`/`Linker` is built by the SEPARATE function
  `run_worker_thread` (`guest.rs:7918-7936`): it defines only `env.memory`
  and `env.__channel_base`, then calls
  `linker.define_unknown_imports_as_traps(module)` (`guest.rs:7936`) — this
  defines every remaining declared import (including `kernel.kernel_fork`,
  `kernel.kernel_clone`, `kernel.kernel_wait4`, etc.) with a stub matching its
  exact declared `FuncType` that **traps unconditionally when called**
  (comment at `guest.rs:4441-4443` describing the same Wasmtime API used
  elsewhere: *"defines a stub with that signature that traps when called, so
  a real (buggy) call surfaces loudly instead of silently returning a
  wrong-typed default"*).
- Consequence for a guest: musl's `fork()`/`vfork()`/`_Fork()` call
  `kernel.kernel_fork(mode)` **directly** (not through the generic syscall
  channel — confirmed by the sibling doc comment at `guest.rs:5139-5141`:
  *"`fork()`/`vfork()`/`_Fork()` call this import DIRECTLY
  (`libc/glue/channel_syscall.c:492-493,577-600`), never through the generic
  channel dispatcher"*). From a pthread, that direct call reaches the trap
  stub and wasmtime unwinds the pthread's own Wasm call stack. `run_worker_
  thread`'s `match func.call(...)` (`guest.rs:7963-7978`) only special-cases
  the expected clean `unreachable` exit trap
  (`is_unreachable_trap`); an unknown-import trap is a **different** Wasmtime
  error, so it falls to the `Err(e) => Err(e.into())` arm, and
  `spawn_worker_thread`'s wrapper (`guest.rs:7896-7915`) prints
  `"worker thread (channel {channel_offset:#x}) failed: {e:?}"` to stderr and
  the OS thread simply ends.
- **This is worse than a clean POSIX failure.** It is not "fork() returns
  `-1`/`EAGAIN` to the caller" — the calling pthread's entire Wasm execution
  is unwound and its OS thread exits with no signal delivered and no return
  value written back through any channel. A `pthread_join()` on that thread
  elsewhere in the same guest would hang forever (the joined thread's
  channel never reaches a terminal/exit state musl's join logic expects; it
  simply stops responding). This is a truthful-failure-contract gap in its
  own right (a silent, informationless death, not a POSIX-shaped error) —
  distinct from, and additional to, the "unsupported" gap itself.

### Is native's fork machinery reusable from a pthread, or is it main-thread-baked?

**Reusable in principle, main-thread-baked in the closure's current wiring —
this is a wiring gap, not an architectural wall.**

- The `kernel_fork` closure captures `ch = layout.channel_offset` **once, at
  closure-construction time** in `spawn_guest_thread` (`guest.rs:5187-5188`:
  `let mem = guest_mem.clone(); let ch = layout.channel_offset;` — the
  *process's* main channel offset, fixed for the life of that closure). Even
  if the closure WERE defined on a pthread's linker, it would post to the
  wrong (main) channel and race/collide with the real main-thread caller —
  exactly the residuals-audit doc's finding, still true at current line
  numbers.
- The kernel-side authority this closure ultimately drives —
  `ForkCoordState`, `fork_process.call(..., (parent_pid, caller_tid, mode))`
  (`kernel_fork_process`, `crates/kernel/src/wasm_api.rs:1983-2002`),
  `ProcessTable::fork_process_for_caller_with_mode`
  (`crates/runtime-core/src/process_table.rs:1037-1090`) — is
  **caller-tid-parameterized already**: it takes `caller_tid` as an explicit
  argument, not an assumption baked into "the main thread." The kernel does
  not know or care whether the calling channel is a process's main channel
  or a worker channel; `ProcessLayout`/channel offsets are also
  per-channel data the host already tracks per `PumpChannel` (`is_main`,
  `tid`, `offset` — `guest.rs:8022-8027`). Nothing in the shared `crates/`
  layer assumes "fork only happens on the main thread."
- `handle_fork` (pump-side, `guest.rs:~8850` on) already receives a `ch:
  PumpChannel` and reads `ch.tid` generically — it is not hard-coded to the
  main channel's offset; the residual is purely that (a) the `kernel_fork`
  IMPORT is only ever defined on the main thread's `Store`, and (b) even if
  defined on a pthread's `Store`, it would need to be re-closed over THAT
  pthread's own `ch` (not the process's main `ch`), and the pump's dispatch
  gate `ch.is_main && (syscall_nr == SYS_FORK || syscall_nr == SYS_VFORK)`
  (`guest.rs:8824`, confirmed unchanged from the audit doc's finding at the
  now-shifted line number) explicitly excludes non-main channels from ever
  reaching `handle_fork` even if a request DID land there.

### What must be added

1. **Give a pthread's `Store` its own `kernel_fork` import**, closed over
   *that thread's own* channel offset (`channel_offset` — already a
   parameter to `run_worker_thread`/`spawn_worker_thread`, `guest.rs:7896-
   7906`), mirroring `spawn_guest_thread`'s wiring but parameterized per
   thread rather than assuming the process's main channel.
2. **Drop the `ch.is_main` restriction** on the `SYS_FORK`/`SYS_VFORK` pump
   gate (`guest.rs:8824`) — dispatch `handle_fork` for ANY channel's fork
   request, using that channel's own `tid`/`offset` throughout (the
   generalization the kernel side already supports, per above).
3. **Decide the POSIX-correct scope of a forked child from a pthread caller.**
   POSIX: only the calling thread survives into the child; every other
   thread of the parent (main thread included) simply does not exist in the
   child. `handle_fork`'s existing `clone_guest_memory` + single-thread
   child launch (COW path) already produces a **single-threaded child** by
   construction (it launches exactly one guest OS thread for the new
   process) — this part is thread-caller-agnostic already. What is new is
   that the child's ONE thread must be seeded from the CALLING pthread's
   register/stack state (its `layout`, TLS, stack pointer), not the
   process's main-thread state — `handle_fork`'s child launch currently
   reuses `processes[pi].layout` (the process-wide layout) unconditionally;
   whether that already captures a per-thread stack/TLS snapshot correctly
   for a non-main caller needs verification against how COW replay resumes
   the child's single surviving thread (the fork-instrument replay engine
   resumes from the CALLER's own captured frames per-thread already, per
   N1-I4's design — this is very likely already thread-position-agnostic
   since the replay captures the CALLING thread's live call stack
   specifically, not "the main thread's" — but this was not independently
   re-verified line-by-line here and is the one open detail worth a
   targeted check before implementing).
4. Node/browser's already-working model to port from: `wpk_fork_resume_
   thread` (`host/src/worker-main.ts:5057-5065`, `:7008-7015`) + the
   per-thread fork lock (`worker-main.ts:6233`, `:6271`) + parent-side
   plumbing (`worker-main.ts:6456-6828`, `:7111-7113`), wired per-host at
   `node-kernel-worker-entry.ts:291,419,3314-3332,3426-3427` and
   `browser-kernel-worker-entry.ts:244,1868,3576-3594,3701-3702`. This is a
   real, working design to copy the *shape* of (a per-thread coordinator +
   per-thread channel identity), not blue-sky design.

**Effort/risk:** **Moderate.** The kernel-side authority already generalizes;
the work is (a) per-thread `kernel_fork` wiring (mechanical, mirrors existing
main-thread wiring), (b) dropping/generalizing the `ch.is_main` pump gate
(small, same shape as the SYS_CLONE/SYS_EXECVE gates already keyed on
`ch.tid`/`ch.offset` elsewhere), and (c) one verification item (child seeding
from a non-main caller's captured frames) that is very likely already correct
by construction but was not proven by this reading pass. Risk is
medium — it touches the same `handle_fork`/`kernel_fork` closure surface
residual (1) (real vfork) also touches (see §4 coupling below), so the two
should be sequenced to avoid rebasing pain, not because they are logically
coupled.

---

## 2. Non-main-thread `execve()`/`execveat()` (#4b)

### The actual failure on native today — settled by reading, no experiment needed

The prior residuals-audit doc flagged this as "unconfirmed by reading alone."
It is now settled:

- Native's execve/execveat host interception is gated `ch.is_main &&
  syscall_nr == SYS_EXECVE` (`guest.rs:8865`) and `ch.is_main && syscall_nr ==
  SYS_EXECVEAT` (`guest.rs:8901`) — current line numbers (shifted from the
  audit doc's `8118`/`8154` because the vfork commits landed in between; same
  gating logic, unchanged).
- A pthread channel (`is_main: false`, set at channel-creation time in the
  `SYS_CLONE` handler, `guest.rs:8763-8767`) never matches either branch, so
  its `SYS_EXECVE`/`SYS_EXECVEAT` request falls through to the generic
  `dispatch_once` path (`guest.rs:8934` area) exactly as the prior doc
  predicted.
- **`dispatch_once` ultimately calls into the kernel Wasm module's own
  generic syscall table, `crates/kernel/src/wasm_api.rs`'s `match nr { ...
  }`, which has an EXPLICIT arm:**

  ```rust
  // crates/kernel/src/wasm_api.rs:4933-4939
  // Fork/exec/clone
  // Exec launch is a host-orchestrated exact-target transaction. Direct
  // channel dispatch has neither a retained object token nor authority
  // to replace a worker, so it must not revive pathname-only exec.
  211 | 386 => -(Errno::ENOSYS as i32), // SYS_EXECVE / SYS_EXECVEAT
  // The centralized host must intercept fork and ask ProcessTable to
  // allocate the child identity. A direct dispatch cannot create a
  // worker without bypassing that authority, so fail truthfully.
  212 | 213 => -(Errno::ENOSYS as i32), // SYS_FORK / SYS_VFORK
  ```

  This is a **deliberate, documented, truthful stub** — exactly the shape the
  Debugging/POSIX contract asks for ("Stubs must be honest: return the
  correct failure mode"). A pthread calling `execve()`/`execveat()` on native
  today gets a clean **`ENOSYS`** back through the ordinary syscall-return
  path (unlike fork-from-thread, which crashes the calling OS thread — see
  §1). This is a real, if incomplete, POSIX-shaped failure, not a
  silent-success or a hang.

### Node/browser DO already have a real execve-from-thread + full-teardown reference subsystem — the prior audit's "no evidence found" was a search-scope miss

Re-reading `host/src/kernel-worker.ts` and `host/src/node-kernel-worker-entry.ts`
(browser is at parity — see below) settles this fully:

- `kernel-worker.ts`'s syscall dispatch has **no `isMainChannel` gate at all**
  on the `SYS_EXECVE`/`SYS_EXECVEAT` branches (`kernel-worker.ts:12003-12012`):
  any channel — main or a pthread's own — that posts `SYS_EXECVE` reaches
  `this.handleExec(channel, origArgs, entry)` identically. `isMainChannel` is
  used elsewhere (e.g. `SYS_EXIT` handling, `kernel-worker.ts:24883-24885`)
  but never gates exec.
- `handleExec` (`kernel-worker.ts:23986-24192`) reads path/argv/envp from
  the CALLING channel's process memory and, on success, calls
  `this.callbacks.onExec` — it is channel-identity-agnostic beyond "which
  process do I belong to."
- The host-side `onExec` implementation (`node-kernel-worker-entry.ts:1330-
  1408`, delegating to the top-level `handleExec` function at
  `node-kernel-worker-entry.ts:2549-2549+`) performs the FULL POSIX
  image-replacement contract, including sibling-thread teardown, as part of
  its `startAfterCommit` phase (`node-kernel-worker-entry.ts:2636` on):

  ```ts
  // node-kernel-worker-entry.ts:2650-2687
  if (initiatingInfo.worker) {
    intentionallyTerminated.add(initiatingInfo.worker as object);
  }
  for (const thread of threadWorkers.get(pid) ?? []) {
    intentionallyTerminated.add(thread.worker as object);
  }
  ...
  const [mainQuiescent, threadsQuiescent] = await Promise.all([
    mainRetirementStarted
      ? waitForExecRetirement(...)
      : Promise.resolve(false),
    terminateThreadWorkers(pid, true),
  ]);
  ```

  `terminateThreadWorkers` (`node-kernel-worker-entry.ts:505-533`)
  unconditionally calls `Worker.terminate()` (via `terminateTrackedWorker`,
  `node-kernel-worker-entry.ts:474`) on **every** pthread `Worker` belonging
  to `pid`, regardless of whether that worker is parked in an `Atomics.wait`
  or actively executing Wasm — `Worker.terminate()` forcibly halts a Web
  Worker/`worker_threads` Worker at ANY point in its execution, with no
  cooperative checkpoint required. This is the SAME mechanism the browser
  host already uses (`browser-kernel-worker-entry.ts:498-533` mirrors
  `terminateThreadWorkers` byte-for-shape, confirmed present at
  `browser-kernel-worker-entry.ts:498,516,726,2861`).
- **This means residual #5 (compute-bound sibling teardown) is ALREADY
  SOLVED on Node and browser**, and has been solved the whole time, by the
  simple fact that a JS Worker can always be force-terminated from outside
  regardless of what it is doing. There is no "parked vs. compute-bound"
  distinction on those hosts at all — `terminateThreadWorkers` does not care.
  The prior residuals-audit doc's framing ("no evidence found... execve-from
  -thread has no existing reference subsystem even on Node/browser") was a
  grep-scope miss (it searched for the string "thread" near "execve" and
  found nothing, because the real mechanism is named `terminateThreadWorkers`
  / `intentionallyTerminated`, not anything with "execve" in its name). This
  materially changes the residual's shape: it is **not** a case of designing
  novel semantics from scratch — it is a case of native lacking the one
  primitive (forcible cross-thread preemption) that makes Node/browser's
  existing, working design trivial to port in outline, even though native's
  OS-thread model cannot literally reuse `Worker.terminate()`.
- Caveat: no dedicated regression test was found asserting "execve from a
  non-main pthread channel, with a third compute-bound sibling, tears down
  correctly" by name (`grep -rn "execve.*thread\|thread.*execve"` over
  `host/test/*.ts` — no matches). The mechanism is real, general, exercised
  code (not a stub), but this exact scenario's correctness is not
  independently regression-tested today on any host; this is a real
  parity/coverage gap worth closing alongside residual #4b work, not proof
  the code is wrong.

**Effort/risk:** the execve-side change on native (dropping the `ch.is_main`
gate on `SYS_EXECVE`/`SYS_EXECVEAT`, `guest.rs:8865,8901`, and generalizing
`handle_exec_common` to operate on any caller channel) is now **small and
well-scoped in isolation** — it is a straightforward generalization of an
existing, working code path, exactly like §1's fork-from-thread gate. The
REAL difficulty is entirely residual #5 (§3 below): POSIX requires
execve-from-any-thread to also terminate every sibling thread as one atomic
operation, and native has no primitive equivalent to `Worker.terminate()` to
do that for a compute-bound sibling. Sizing #4b's effort independent of #5 is
not meaningful — see §4 (coupling).

---

## 3. Multi-threaded-execve compute-bound sibling teardown (#5) — THE HARD ONE

### Where epoch interruption stands today

- `crates/host-native/src/lib.rs:122-137` (`kernel_engine`) is the ONE place
  the shared `wasmtime::Engine` is constructed. It sets `wasm_threads(true)`,
  `wasm_gc(true)`, `wasm_exceptions(true)`, `shared_memory(true)` — **no
  `Config::epoch_interruption`, no fuel, no epoch deadline of any kind.**
  There is exactly one `Engine` for the whole native host process (shared
  across every guest thread via `engine.clone()`, e.g. `guest.rs:4855` /
  `guest.rs:7908`), so enabling epoch interruption is a single, global,
  engine-wide flip — every `Store<()>` created anywhere in this crate would
  need an epoch deadline set (`Store::set_epoch_deadline`) for the check to
  do anything, and every guest function entry/loop backedge in EVERY
  compiled module gains a compiled-in epoch check once the `Config` flag is
  on (this is a compile-time codegen change, not a per-`Store` opt-in — a
  module compiled under this `Engine` always carries the check).
- Native's own parked-sibling reclamation, `reclaim_all_channels`
  (`guest.rs:7708-7757` — line range in current HEAD; doc comment at
  `guest.rs:7708-7737`), explicitly separates the two cases and calls out
  epoch interruption's irrelevance to the parked case by name
  (`guest.rs:7746-7749`): *"a sibling worker channel that is NOT `PENDING`
  right now means its thread is compute-bound inside the guest, not parked
  — epoch/fuel cannot interrupt it [i.e., a parked thread] ... This function
  deliberately does NOT touch or join a non-parked channel's thread — it is
  the documented, out-of-scope multi-threaded-execve residual."` The
  compute-bound branch (`guest.rs:7750-7754`) drops the thread handle
  unjoined.

### The prior spike's findings, re-verified and reconciled

`docs/plans/2026-09-05-native-thread-reclamation-spike.md` (uncommitted
scratch test `crates/host-native/tests/zz_scratch_reclaim_spike.rs`, deleted
before commit per its own header) already ran the decisive experiment on
wasmtime 35 (native is now on wasmtime 48 per `crates/host-native/Cargo.toml`
lineage referenced in the campaign plan's Decision 1 — the underlying
mechanism the spike documents, "epoch checks are compiled into running Wasm
only," is a stable, longstanding Wasmtime architectural property described in
Wasmtime's own `Config` docs, not a version-specific quirk, so its
qualitative conclusions carry forward, though the exact APIs should be
re-confirmed against wasmtime 48 before implementation):

- **Q1 (parked thread): epoch interruption does NOT reach a thread parked in
  `memory.atomic.wait32`.** `memory_atomic_wait32` lowers to a synchronous
  host libcall (`runtime/vm/libcalls.rs:1074` in the wasmtime source the
  spike inspected) that calls `park_timeout` — no Wasm executes while
  parked, so no epoch check is ever reached. Empirically confirmed
  (`exp_a`: 20 epoch increments over ~1s never releases a parked waiter;
  only `atomic_notify` does). **This is why the existing `TEARDOWN`-sentinel
  mechanism (§ below), not epoch interruption, is what already reclaims
  parked siblings** — the two mechanisms are for two disjoint classes of
  sibling, not competing options for the same problem.
- **Q1 control (running thread): epoch interruption DOES trap a compute-bound
  guest.** `exp_a2` (a genuine running spin loop under the SAME engine
  config) traps via the epoch mechanism (`trapped = true`). This is the
  exact case residual #5 needs, and it is the case the spike proves the
  mechanism handles correctly when the thread is actually executing Wasm
  (not blocked in a host call).
- **Q2: fuel and async host calls do not change either conclusion** — fuel
  is grouped with epochs in Wasmtime's own docs (both are "only checked while
  Wasm code is running"); `call_async` does not make `memory.atomic.wait32`
  itself cancellable, because that instruction is not a host import in the
  async sense — it is a synchronous VM libcall regardless of `Store` async
  mode.
- **Q3's alternative-mechanism survey concluded**: forcibly dropping the
  `Store`/`SharedMemory` out from under a running thread is unsound (a live
  stack frame + a global `ParkingSpot` registration reference that memory);
  a finite-timeout polling wait is a hot-path cost the ABI/perf contract
  would reject as a default; a host-import-based redesign of the blocking
  primitive (moving `memory.atomic.wait32` itself into a cancellable host
  call) is possible but is a strictly larger, ABI-breaking redesign that
  the spike explicitly rejected as overkill for the PARKED case (option
  (b), the `TEARDOWN` sentinel, was recommended and adopted instead for
  parked threads specifically because it needed no new blocking-call
  redesign).

**This spike settles the "is epoch interruption technically capable of
stopping a compute-bound sibling" half of Q3 with HIGH confidence: yes, and
it is validated empirically, not merely asserted from documentation.** It
does **not** settle the two things this task was asked to determine and
which genuinely required new investigation beyond re-reading the spike:

### What the spike did NOT test — the two real open risks

**(a) Interaction with the `TEARDOWN`/`atomic.wait32` parking mechanism.**
The spike's own experiments never combined epoch interruption with the
`TEARDOWN` sentinel design in the same test — they were run as separate,
independent experiments (`exp_a`/`exp_a2` for epoch vs. parking, `exp_d` for
the sentinel). Reading alone shows no logical conflict (they target disjoint
runtime states — a thread is EITHER parked in a host libcall XOR executing
Wasm at any instant; epoch checks only ever fire in the latter state, so
turning on epoch interruption cannot spuriously fire while a thread is
parked in `wait32`, and the sentinel mechanism does not touch the epoch
counter at all). But this is inference from reading, not an executed test —
**genuinely unsettled by reading alone**: does `Store::set_epoch_deadline`
interact with anything else already keyed off the SAME `Store` (e.g., trap
classification / `is_unreachable_trap` at `guest.rs:7981+`, which pattern
-matches on trap kind — an epoch-deadline trap is a DIFFERENT
`wasmtime::Trap` variant than `TrapCode::UnreachableCodeReached`, so
`is_unreachable_trap`'s `match` would need a new arm or the epoch-triggered
teardown path would misclassify as an unexpected error, matching §1's
"unknown-import trap falls to the wrong arm" pattern already found for
fork-from-thread). **Experiment needed:** a scratch integration test
(same style as the deleted spike test) that arms an epoch deadline on a
guest `Store` that is ALSO running the real channel-syscall glue loop
(not a synthetic spin loop), confirms a compute-bound guest thread traps
on schedule, confirms that trap is correctly classified/handled by whatever
new reclaim path is added (not silently treated as a generic guest crash),
and confirms a genuinely PARKED sibling in the same test run is unaffected
by the epoch increments (replicating `exp_a` alongside the new reclaim
path, not in isolation).

**(b) Interaction with fork/vfork replay.** This was NOT investigated by the
spike at all (it predates the vfork landing) and is a genuinely new question
for this task:
  - The fork-instrument replay machinery (`crates/fork-module`,
    `wpk_fork_frame_*`/`wpk_fork_resume_*` exports) drives its own
    multi-phase re-entry of the SAME guest instance across `kernel_fork`'s
    `Idle`→`Replaying` phases (`guest.rs:5139-5330`+) — this is exactly the
    kind of "actively executing Wasm across an extended call sequence"
    period during which an epoch deadline, once armed process-wide, would
    also be ticking. If epoch interruption is enabled with a SHORT deadline
    (needed to preempt a compute-bound sibling promptly at execve), a
    legitimately slow fork-capture/replay sequence (e.g., unwinding a very
    deep call stack, or `fm_begin_borrowed_child_replay`'s guest-side
    replay walk) risks spuriously tripping the SAME epoch deadline on a
    THREAD THAT IS NOT THE ONE #5 IS TARGETING — because Wasmtime's epoch
    check, once compiled in, fires unconditionally in every function on
    every `Store` sharing that `Engine`'s epoch counter (the counter and
    per-`Store` deadline are engine-global/store-scoped, not "scoped to the
    exec'ing process's siblings" — there is no per-thread selectivity built
    into the primitive itself; selectivity has to come from WHICH `Store`s
    get a deadline armed and WHEN). Concretely: the vfork borrowed-child
    replay path (just landed, `guest.rs:8702` doc-comment area, "real
    vfork") runs entirely on the CALLING (parent-blocking) OS thread's
    `Store`, distinct from any sibling being targeted for exec-teardown —
    so a NAIVE "arm a deadline on every Store" policy would risk tripping
    unrelated in-flight fork/vfork replay on a completely different
    process. A correct design must arm the epoch deadline ONLY on the
    specific sibling `Store`s of the exec'ing process, not globally — which
    means the callback/deadline-arming code needs access to exactly the set
    of `thread_handles`/`Store`s `reclaim_all_channels` already iterates
    (`guest.rs:7744` `for ch in &channels`), but there is currently no
    stored `Store` handle per channel to reach into from OUTSIDE that
    thread (each `Store` lives on its owning OS thread's own stack inside
    `run_worker_thread`/`spawn_guest_thread`'s closures, per spike's Q3
    option (d) discussion of exactly this "no external handle" problem for
    `Store` in general). **This is the crux of the wall risk**: Wasmtime's
    epoch API (`Engine::increment_epoch()` is global; `Store::set_epoch_
    deadline` must be called on/by the `Store`'s own owning context) was
    NOT designed for "reach into one specific thread's Store from another
    thread and arm just its deadline" as an ad hoc operation — the deadline
    is normally set once up front on the `Store` before it starts running,
    by the same code that owns it. Arming a deadline reactively, from the
    pump thread, into an ALREADY-RUNNING sibling `Store` it does not own,
    for exactly one exec event, is an API-shape question the spike never
    investigated and this reading pass could not resolve from documentation
    alone — **genuinely unsettled, needs a targeted Wasmtime-48 API read
    and a scratch experiment** (does `Store::epoch_deadline_trap`/
    `epoch_deadline_callback` support being configured AFTER the `Store` is
    already executing on another thread and while a call is in flight? Is
    `Engine::increment_epoch()` alone — without any prior per-`Store`
    deadline configuration — sufficient to make an in-flight call trap the
    NEXT time the global epoch counter is checked, or does every `Store`
    need `set_epoch_deadline` called BEFORE it starts running for the
    check to ever be armed?). If deadlines must be pre-armed per-`Store`
    before that `Store` starts executing (the likely answer, based on how
    `epoch_deadline_trap`/`set_epoch_deadline` are typically used in
    Wasmtime — set once at `Store` construction, then only
    `Engine::increment_epoch()` is called reactively from outside), then the
    fix is tractable but requires PRE-arming a deadline on EVERY guest
    `Store` at spawn time (mirroring `wasm_threads`/`shared_memory` as an
    always-on engine property, not a reactive one), and using `Engine::
    increment_epoch()` (global, callable from any thread, no `Store` handle
    needed) purely as the trigger — sidestepping the "reach into another
    thread's Store" problem entirely. **This resolution (pre-arm at spawn,
    trigger globally) looks likely correct on architecture grounds but was
    not empirically validated here and is exactly the next experiment to
    run before committing to a design.**

**(c) Performance.** Not measured, and per the Performance Contract, cannot
be asserted. Enabling `Config::epoch_interruption` compiles a check into
EVERY function entry and loop backedge of every guest AND kernel module
under this `Engine` (kernel Wasm too, since `kernel_engine()` is the one
engine used for everything, `guest.rs:952` shows the kernel module's own
linker/instantiation sharing this same engine) — this is unconditionally a
syscall-hot-path-adjacent change in the sense the Performance Contract
calls out by name ("Do not repeat known-bad syscall hot-path
'optimizations'..." — the inverse risk, a hot-path REGRESSION from a new
mandatory check, applies with equal force and equal evidentiary
requirements). Full before/after benchmarking on native (Node/browser are
unaffected — they have no epoch mechanism in this codebase's design at all;
their equivalent primitive, `Worker.terminate()`, has no comparable
per-call-site cost) is required before any performance claim, and is
explicitly NOT done by this grounding pass.

### Verdict

**Tractable, not a wall — but not yet de-risked, and the riskiest piece of
both residuals.** Enabling epoch interruption is not unsafe in the sense of
"provably breaks core behavior" — nothing found here contradicts the
spike's conclusion that it is a sound, working mechanism for the
compute-bound case. But two concrete unknowns block a confident "just turn
it on" verdict:

1. Whether Wasmtime 48's epoch API can be armed reactively against an
   already-running sibling `Store` from outside its owning thread, or must
   be pre-armed at every `Store`'s construction (the architecture appears
   to require the latter — pre-arm globally, trigger via `Engine::
   increment_epoch()` alone — but this needs a scratch experiment, not
   more reading, to confirm against wasmtime 48 specifically).
2. Whether pre-arming a deadline on every `Store` (including kernel/fork
   -module `Store`s, and every in-flight fork/vfork replay) introduces
   spurious traps on long-running BUT LEGITIMATE Wasm sequences (deep
   fork-capture unwinds, vfork borrowed-child replay) unless the deadline
   policy is "increment the epoch only when a specific sibling needs
   reclaiming, never on a fixed timer" (i.e., `Engine::increment_epoch()`
   is called ONLY from the exec-success reclaim path, targeted at that
   moment, never on a background cadence) — which the reading here
   suggests IS the correct design (epoch increments are the trigger, not a
   ticking clock; nothing requires a periodic ticker), but this was not
   empirically exercised together with a real fork/replay sequence.

**Named experiment to settle both:** extend the (recreated, still-scratch)
`zz_scratch_reclaim_spike.rs`-style test to (i) pre-arm an epoch deadline on
a `Store` at construction exactly the way `kernel_engine`+`spawn_guest_
thread`/`run_worker_thread` would need to, (ii) drive that `Store` through a
representative fork-capture/replay sequence (using the REAL fork-module, not
a synthetic loop) while NEVER calling `increment_epoch`, confirming no
spurious trap; (iii) then, from a second OS thread, call `Engine::
increment_epoch()` exactly once while a THIRD, genuinely compute-bound
sibling `Store` (same engine) is mid-loop, confirming ONLY that sibling
traps and the fork-replay `Store` from (ii) is unaffected (since it was
never incremented against, if increments are per-deadline-value rather than
truly global — this is itself one of the open API questions). If Wasmtime's
epoch counter is a SINGLE global counter shared by all `Store`s on an
`Engine` (the likely case — `Engine::increment_epoch()` takes no `Store`
argument), then EVERY `Store` with a deadline armed at or below the new
epoch value traps on its next check, not just the targeted sibling — this
would mean deadlines must be armed with DIFFERENT target values per
`Store` (e.g., "trap at epoch N+1" for the doomed sibling, "trap at epoch
N+1_000_000" i.e. effectively never, for everyone else) rather than a
uniform policy, which is an important design detail the spike never needed
to consider (it only ever had one `Store` in flight) and which this
grounding pass surfaces as new, unresolved scope.

---

## 4. Coupling — #4b (execve-from-thread) and #5 (sibling teardown)

**They must ship together; #4b cannot be POSIX-correct without #5, and
#5's only real trigger point IS #4b (plus the already-handled ordinary
main-thread execve case).** Concretely:

- POSIX (`execve(2)`): "All threads other than the calling thread are
  terminated during an `execve()`... no destructors... simply vanish."
  This is not a nice-to-have refinement of #4b — it is `execve`'s definition.
  A native implementation that lets a pthread call `execve()` (closing #4b in
  isolation, e.g. by just dropping the `ch.is_main` gate at `guest.rs:8865,
  8901`) WITHOUT also closing #5 would be **strictly worse than today's
  ENOSYS**: it would let the exec'ing thread succeed while leaking every
  compute-bound sibling exactly as it already does for a MAIN-thread exec
  today (`reclaim_all_channels`'s documented residual, `guest.rs:7746-7754`)
  — except now reachable from every thread, not just the main one, widening
  the existing leak's surface rather than closing anything.
- The reverse is also true: #5's mechanism (epoch-based reclaim) has no
  reason to exist independent of an exec (or a fork/spawn teardown, which
  already has a working answer via the `TEARDOWN` sentinel for the parked
  case and simply abandons the compute-bound case today, same residual).
  The ONLY new trigger #5 needs to serve is "an exec just committed
  (whether initiated by the main channel or, once #4b lands, by any
  channel) and this process's remaining live channels must all die now."
- **Sequencing:** implement #5's mechanism (epoch pre-arming + a second
  reclaim path parallel to `reclaim_parked_thread`) FIRST, validated against
  TODAY's main-thread-only exec path (where it already has a real, if
  incomplete, caller — `reclaim_all_channels`'s compute-bound branch,
  `guest.rs:7750-7754`, is the exact splice point: replace "drop unjoined"
  with "arm this sibling's epoch trap, wait for it to trap, then join").
  THEN lift the `ch.is_main` gate on `SYS_EXECVE`/`SYS_EXECVEAT` (#4b) once
  the reclaim path is proven against the existing (main-thread) trigger —
  at that point #4b is a small, low-risk generalization (§2's conclusion)
  layered on top of an already-validated #5. Doing it in the other order
  (lift the gate first) would make #4b's own validation impossible to trust
  in isolation, since its correctness DEPENDS on #5 already working.

---

## 5. Overall plan, riskiest piece, shippable-now vs. documented-residual

### Ordered implementation plan

1. **#5 core mechanism** (largest, riskiest): resolve the two open Wasmtime
   API questions from §3 via the named scratch experiment; if confirmed
   tractable, pre-arm epoch deadlines on every guest/kernel `Store` at
   construction (`kernel_engine`, `spawn_guest_thread`, `run_worker_thread`,
   `instantiate_fork_module`), add a second reclaim path parallel to
   `reclaim_parked_thread` in `reclaim_all_channels` (`guest.rs:7708-7757`)
   that increments the engine epoch targeted at exactly the doomed sibling
   `Store`(s) and joins them once trapped, and full before/after
   benchmarking (native only; Node/browser unaffected).
2. **#4a fork-from-thread**: per-thread `kernel_fork` import wiring +
   dropping the `ch.is_main` fork/vfork pump gate (`guest.rs:8824`) +
   verifying child-seeding-from-non-main-caller (the one open detail in
   §1). Independent of #5; can land before, after, or interleaved with it —
   sequence to avoid `handle_fork`/`kernel_fork`-closure merge conflicts
   with residual (1) (real vfork, which just landed and touches the exact
   same functions).
3. **#4b execve-from-thread**, gated on #5 being validated first (§4):
   drop the `ch.is_main` gate on `SYS_EXECVE`/`SYS_EXECVEAT`
   (`guest.rs:8865,8901`) and confirm `handle_exec_common` is caller
   -channel-agnostic (it already appears to be, by inspection — it takes
   `ch`/`pi` generically, same as `handle_fork`).
4. Add the missing regression coverage on Node/browser too (§2's caveat):
   an explicit "execve from a pthread with a live compute-bound sibling"
   test, since the mechanism is real but untested by name today on any
   host.

### Riskiest piece

**#5 (epoch interruption), unambiguously**, and specifically the two
unresolved Wasmtime-48 API questions in §3: (a) reactive vs. pre-armed
deadline semantics against an already-running foreign-thread `Store`, and
(b) whether the epoch counter is engine-global in a way that makes
"increment epoch to reclaim ONE sibling" also risk tripping unrelated
long-running-but-legitimate Wasm (kernel calls, fork/vfork replay) sharing
the same `Engine`. Neither is a proven wall — the spike's own control case
(`exp_a2`) proves the primitive works on a running guest, and reasoning from
Wasmtime's documented API shape suggests "pre-arm at spawn, trigger via a
targeted `increment_epoch` only at reclaim time" is the correct resolution
— but this grounding pass could not close them from reading alone, and they
are precisely the kind of "first-time engine-wide behavioral change with
correctness AND performance blast radius" the campaign's own Performance and
ABI contracts require empirical validation for before landing. #4a/#4b are
comparatively low-risk generalizations of existing, working code shapes.

### Shippable-now vs. documented residual, and real-workload frequency

No census or telemetry data on how often real programs fork-from-thread or
execve-from-a-thread-with-compute-bound-siblings was found in this repo
(`grep`s over the campaign plan and `docs/` turned up no such measurement;
the existing "0/113 packages carry [certain reference kinds] across a fork"
census cited elsewhere in the campaign plan is about a DIFFERENT residual,
not this one). Qualitatively: `fork()` from a non-main pthread is legal
POSIX but is well known in the wider Unix ecosystem to be fraught (the
child inherits only the calling thread; mutexes held by other, now-absent
threads can deadlock the child; glibc/musl documentation and most C
library guidance actively discourage it), so most real multithreaded
programs avoid it — this residual is plausibly rare in practice but not
zero (some libraries/runtimes fork-after-thread-creation deliberately in
specific, narrow patterns). `execve()` from a non-main thread with a
genuinely COMPUTE-BOUND (not merely alive) sibling at that exact moment is
rarer still — it requires both "calls exec from a worker thread" (uncommon)
AND "another thread is actively spinning, not blocked in I/O/a mutex/a
wait" at that instant (most multithreaded server/worker-pool designs have
idle threads parked in a wait, which native ALREADY reclaims correctly via
`TEARDOWN`). Given the Platform Values Contract's framing ("Missing or
incomplete POSIX behavior is a platform gap to close, not permission to
weaken the model"), none of these three items should be waved off
permanently — but their low real-workload frequency, combined with #5's
open technical risk, makes a **documented, explicit residual** (matching
the treatment already given to real vfork and today's compute-bound-sibling
leak) the honest interim posture for #4b/#5 specifically, rather than
shipping a rushed epoch-interruption change under time pressure. #4a
(fork-from-thread) is comparatively low-risk and well-scoped enough that it
does not need the same caution — it could reasonably be shipped ahead of
#4b/#5 once its one open verification item (§1, child-seeding-from-non-main
-caller) is confirmed, since it does not touch the epoch mechanism at all
and is not coupled to #5 the way #4b is.

| Residual | Current state | Needed | Verdict |
|---|---|---|---|
| **#4a fork-from-thread** | No `kernel_fork` import on a pthread's `Store` at all; calling `fork()` from a pthread traps the OS thread with no POSIX-shaped error (worse than ENOSYS — a silent, unjoinable thread death) | Per-thread `kernel_fork` wiring + drop `ch.is_main` fork/vfork gate + verify child-seeding from a non-main caller | **Tractable, moderate effort.** Kernel authority already generalizes; mostly wiring |
| **#4b execve-from-thread** | Falls through to generic dispatch, returns a clean, deliberate `ENOSYS` (`wasm_api.rs:4935`) — truthful, not a crash | Drop `ch.is_main` gate on SYS_EXECVE/SYS_EXECVEAT; POSIX-correctness is impossible without #5 | **Tractable in isolation, but gated on #5** — do not ship #4b before #5 |
| **#5 compute-bound sibling teardown** | Parked siblings reclaimed correctly (`TEARDOWN` sentinel); compute-bound siblings deliberately, honestly abandoned unjoined (documented residual, `guest.rs:7746-7754`) | Enable `Config::epoch_interruption` (currently OFF, `lib.rs:122-137`) + a second, epoch-driven reclaim path + resolve 2 open Wasmtime-48 API questions (§3) + full native benchmarking | **Tractable-to-large, headline risk item — NOT a proven wall, but genuinely unresolved by reading alone; needs the named scratch experiment before committing to a design** |

All three are honest documented residuals today (native fails loudly —
crash for #4a, ENOSYS for #4b/#5's trigger path, silent-leak for #5's
existing compute-bound case) rather than silent misbehavior, which satisfies
the Platform Values Contract's "truthful failure over convenient illusion"
bar even before any of this lands; closing them further improves
completeness but is not fixing an active correctness lie.
