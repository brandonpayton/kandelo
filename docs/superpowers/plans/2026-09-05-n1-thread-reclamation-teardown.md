# N1-R: Native thread reclamation via a cooperative TEARDOWN channel-status sentinel

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Checkbox (`- [ ]`) steps.

**Goal:** Give the native wasmtime host a sound primitive to reclaim a guest OS thread parked in the channel `memory.atomic.wait32`, WITHOUT letting it resume the (superseded/doomed) code it was running — closing the documented thread + `SharedMemory` leak on execve-success and spawn `-ECHILD` rollback, and providing the primitive fork replay-thread teardown (I4) will reuse. Mechanism: a new `TEARDOWN` channel-status value the pump publishes + `atomic_notify`, plus a check in the guest glue that traps so wasmtime unwinds the thread and drops its `Store`.

**Architecture (validated by the spike, `docs/plans/2026-09-05-native-thread-reclamation-spike.md`):** Epoch/fuel provably cannot interrupt a parked `atomic.wait32` (it lowers to a synchronous libcall → `std::thread::park_timeout(MAX)`; no wasm runs while parked). The only sound, hot-path-free reclamation is cooperative: the host writes `CH_TEARDOWN` to the channel status word and `atomic_notify`s it; the guest glue, immediately after its existing wait loop, re-reads the status and — if `TEARDOWN` — `__builtin_trap()`s instead of reading results/returning. wasmtime unwinds, `wait.call` returns `Err(Trap)`, the OS-thread closure ends, and the `Store` + the thread's `SharedMemory` clone drop cleanly (proven end-to-end in the spike's `exp_d`). Reuses the pump's existing notify path and mirrors the existing `REQUEST_FLAG_CANCELLATION_POINT` cooperative-wake plumbing.

**Tech Stack:** Rust (`crates/shared`, `crates/host-native`), C (`libc/glue/channel_syscall.c` + generated `libc/glue/abi_constants.h`), musl rebuild (`scripts/build-musl.sh`), `wasmtime = "35"`, Kandelo SDK.

**Spec:** `docs/plans/2026-09-04-rust-first-remaining-purpose-framed.md` §6 (N1) + the spike doc §Q3(b)/§Q4 (the validated mechanism + precise change sketch). This increment (N1-R) precedes I4 (native fork).

## Global Constraints

- Worktree `/Users/brandon/kandelo-abi44-reconcile` (branch `brandonpayton/rust-first-abi44-reconcile`; PR #1350 head = `brandonpayton/epoll-kernel-route`). Dev-shell + isolated cache: `export KANDELO_SOURCE_CACHE_ROOT="$HOME/.cache/kandelo/reconcile-abi44"; scripts/dev-shell.sh bash -lc '<cmd>'`.
- Test: `cargo test -p host-native --target $(rustc -vV|sed -n 's/^host: //p')` (host `aarch64-apple-darwin`).
- **musl glue change ⇒ rebuild musl** (`scripts/build-musl.sh`) before relying on `build.sh`/Vitest/native fixtures (per CLAUDE.md: `bash build.sh` does NOT rebuild musl). The native fixtures (`crates/host-native/fixtures/*.wasm`) must be **rebuilt** so they carry the new glue check; commit the rebuilt `.wasm`.
- **ABI:** the `TEARDOWN` status value is the source-of-truth in `crates/shared` and is emitted into `libc/glue/abi_constants.h`. **Fold into the in-dev ABI 44 — do NOT bump `ABI_VERSION` to 45** (44 is unreleased; every guest rebuilds together; there is no released artifact to be incompatible with; the user explicitly authorized changing 44 in place). Regenerate `abi/snapshot.json` (`scripts/check-abi-version.sh update`) and confirm it stays 44.
- **Cooperative, not preemptive (accepted limitation, document it):** reclamation reaches a thread only at the channel-wait boundary. A compute-bound sibling not at a syscall is not torn down until its next syscall — the known multi-threaded-execve residual. Every case wired here (execve caller, spawn child) IS parked at the wait, so reclamation is immediate. Do not claim immediate teardown of arbitrary compute-bound threads.
- Node/browser reclaim via `Worker.terminate()` and are unaffected behaviorally; but the shared `TEARDOWN` constant + snapshot change touch all hosts and must be regenerated consistently. Do NOT change Node/browser reclamation in this increment.
- No new host import (the trap path needs none — keeps host surface minimal). All pre-existing host-native tests stay green (28 today).

## Confirmed facts (verified — do not re-derive)

- Guest wait loop + notify: `libc/glue/channel_syscall.c` (the `__builtin_wasm_memory_atomic_wait32` loop ~:1862-1874, parking on the channel status word at `CH_STATUS`). The pump wakes it by writing `COMPLETE` + `SharedMemory::atomic_notify`.
- The documented leak to replace: `crates/host-native/src/guest.rs:3866-3887` (execve-success abandons the old thread; `JoinHandle` dropped ~:3881). The spawn `-ECHILD` rollback seam is in `handle_spawn` (grep `rollback_spawned_child` / `-ECHILD`).
- Channel status constants live in `crates/shared/src/lib.rs` (the `channel` module) + are emitted to `libc/glue/abi_constants.h` by the generator; existing cooperative-wake plumbing: `REQUEST_FLAG_CANCELLATION_POINT` (`crates/shared/src/lib.rs:1273`).
- `SharedMemory::atomic_notify(addr, count)` is callable from host Rust (spike `exp_c`). The pump already computes channel status-word addresses to notify.
- Spike scratch test is DELETED; the mechanism is validated. Do NOT reintroduce scratch tests under `crates/host-native/tests/` (cargo compiles them).

---

### Task 1: Add the `TEARDOWN` channel-status value + the guest-glue trap check

**Files:** Modify `crates/shared/src/lib.rs` (add the `TEARDOWN` channel status constant to the source of truth + the generator that emits `abi_constants.h`); regenerate/commit `libc/glue/abi_constants.h`; Modify `libc/glue/channel_syscall.c` (the post-wait teardown check); rebuild musl (`scripts/build-musl.sh`) + rebuild the native fixtures; regenerate `abi/snapshot.json`. Test: the full host-native suite (no-regression — a guest that is NEVER sent TEARDOWN behaves exactly as before).

**Interfaces (Produces, for Task 2):** the constant `CH_TEARDOWN` (name it exactly; pick the next free channel-status value — verify it does not collide with existing `COMPLETE`/`PENDING`/etc.) available in Rust (`crates/shared`) and C (`abi_constants.h`), and a guest glue that traps out of the wait when it observes `CH_TEARDOWN`.

- [ ] **Step 1: Write the guard test.** This step is NO-REGRESSION: adding the constant + an inert glue check must not change any existing behavior (no guest is sent TEARDOWN yet). Run the baseline `cargo test -p host-native --target <host>` and record 28 passing as the bar. (Optionally add a Rust unit test in `crates/shared` asserting `CH_TEARDOWN` is distinct from every other channel-status constant.)
- [ ] **Step 2: Baseline.** `cargo test -p host-native --target <host>` → 28 pass.
- [ ] **Step 3: Implement.**
  1. `crates/shared/src/lib.rs`: add the `TEARDOWN` channel-status constant next to the other `CH_*`/channel-status values in the `channel` module (choose the next unused value; document it). Wire it into whatever generator emits `libc/glue/abi_constants.h` so the C side gets `#define ... CH_TEARDOWN <n>` (or the project's naming). Regenerate `abi_constants.h` and commit it.
  2. `libc/glue/channel_syscall.c`: immediately after the existing wait loop and BEFORE reading `CH_RETURN`/`CH_ERRNO`, add the teardown check (spike §sketch step 2), using the same inline-asm-from-global discipline the surrounding code uses for `__channel_base`:
     ```c
     /* Host-driven thread reclamation (execve-abandon / fork-replay /
      * spawn-rollback): the pump published TEARDOWN + notified us precisely to
      * unwind this thread WITHOUT resuming the superseded/doomed image. Do not
      * read results or return. Trap so wasmtime unwinds and the host OS thread
      * exits, dropping its Store + SharedMemory. */
     if (__c11_atomic_load((_Atomic uint32_t *)(uintptr_t)(get_channel_base() + CH_STATUS),
             __ATOMIC_SEQ_CST) == CH_TEARDOWN) {
         __builtin_trap();
     }
     ```
     (Match the file's actual accessor for the status word + base; `get_channel_base()`/`__channel_base` per the surrounding code.)
  3. Rebuild musl: `scripts/dev-shell.sh bash -lc 'scripts/build-musl.sh'`. Rebuild the native fixtures (`crates/host-native/fixtures/build-fixtures.sh`) so they carry the new glue; commit the rebuilt `.wasm`.
  4. Regenerate the ABI snapshot: `scripts/dev-shell.sh bash -lc 'scripts/check-abi-version.sh update'`. Confirm `ABI_VERSION` stays **44** (do not bump) and commit `abi/snapshot.json`. If the check demands a bump, STOP and report (that is a signal about the classifier's view — do not force).
- [ ] **Step 4: GREEN (no regression).** `cargo test -p host-native --target <host>` → still 28 pass (fixtures rebuilt with the inert check, never sent TEARDOWN, behave identically).
- [ ] **Step 5: Commit.** `git commit -m "ABI/glue: add the TEARDOWN channel-status sentinel for thread reclamation (N1-R)"` (include `crates/shared`, `libc/glue/abi_constants.h`, `libc/glue/channel_syscall.c`, rebuilt fixtures, `abi/snapshot.json`).

---

### Task 2: Host `reclaim_parked_thread` + wire execve-success & spawn `-ECHILD` rollback

**Files:** Modify `crates/host-native/src/guest.rs` (a `reclaim_parked_thread(mem, ch)` helper; call it in the execve-success path replacing the documented leak at `:3866-3887`, and in the spawn `-ECHILD` rollback; retain + `join()` the thread deterministically). Test in `crates/host-native/src/lib.rs`.

**Interfaces:** Consumes Task 1's `CH_TEARDOWN`. Produces reclamation at execve-success and spawn-rollback: publish `TEARDOWN` + `atomic_notify` the parked channel, then `join()` (or reap) the old OS thread so it is deterministically reclaimed (no leak).

- [ ] **Step 1: Write the failing/stress test.** `smoke_execve_reclaims_thread`: a parent execve's `/bin/exectarget` (the I3c fixture) in a LOOP — e.g. a fixture that execve's a chain, or run `run_guest` repeatedly and assert success each time — designed so that WITHOUT reclamation the abandoned threads accumulate. Assert: (a) each execve still produces the correct exit/output (functional — the new image runs, the old thread does NOT resume), and (b) reclamation actually happens — assert the pump `join()`s the reclaimed thread (e.g. a test hook/counter that the reclaimed thread's closure ran to completion / the `JoinHandle` joined), OR, if a thread-count probe is feasible, that live OS threads stay bounded across N iterations rather than growing by one per execve. Pick the strongest assertion you can actually make deterministically; document what it proves. Fail first: before wiring, the old thread is abandoned (not joined) — the join-hook/counter assertion fails.
- [ ] **Step 2: RED** — `cargo test -p host-native --target <host> smoke_execve_reclaims_thread`.
- [ ] **Step 3: Implement.** Add `reclaim_parked_thread(mem: &SharedMemory, ch: &PumpChannel)` (or the right shapes): store `CH_TEARDOWN` (release ordering) into the channel's status word, then `mem.atomic_notify(<ch status-word addr>, 1)`. In `handle_exec_common`'s success path (replace `guest.rs:3866-3887`): after `kernel_exec_commit`, for the OLD GuestProcess's channel(s), call `reclaim_parked_thread` and then `join()` the thread's `JoinHandle` (keep it instead of dropping at `:3881`) — or record it in a reaper set the pump joins — so reclamation is deterministic, before/while replacing `processes[pi]`. In the spawn `-ECHILD` rollback path: reclaim the just-launched child's parked thread the same way (in addition to the existing `kernel_remove_process`). Remove the "documented leak" comment now that it is fixed.
  - Ordering care: publish TEARDOWN + notify BEFORE dropping/joining; the thread must observe the sentinel on wake. Ensure you notify the exact channel status-word address the guest parks on.
- [ ] **Step 4: GREEN** — the reclaim test passes (old thread joined/reclaimed, new image correct) + full suite green (execve/execveat/spawn/waitpid/shebang all still pass; the reclamation is transparent to their assertions).
- [ ] **Step 5: Commit.** `git commit -m "Host-native: reclaim parked threads on execve-success and spawn rollback via TEARDOWN (N1-R)"`

---

## Notes for the executor
- The mechanism is validated (spike `exp_d`); the risk is integration, not soundness. Keep the wait hot path untouched (infinite wait stays; only the post-wait teardown branch is new — zero cost when TEARDOWN is never sent).
- `join()`-ing the reclaimed thread is the deterministic choice; if a join could deadlock (it should not — the thread traps and returns promptly after notify), fall back to a reaper set drained by the pump, and say so.
- Do NOT wire fork replay-thread teardown here — that lands in I4 and reuses `reclaim_parked_thread`. This increment covers execve-success + spawn `-ECHILD`.
- Do NOT bump `ABI_VERSION`; fold into 44 + regen snapshot. Do NOT add a host import. Do NOT touch Node/browser reclamation.
- musl glue changed ⇒ `scripts/build-musl.sh` + rebuild fixtures before trusting native tests. Commit rebuilt `.wasm`.
