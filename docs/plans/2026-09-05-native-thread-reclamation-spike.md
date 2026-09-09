# Native thread reclamation spike — interrupting a parked `memory.atomic.wait32`

**Date:** 2026-09-05
**Branch:** `brandonpayton/rust-first-abi44-reconcile`
**Worktree:** `/Users/brandon/kandelo-abi44-reconcile`
**Scope:** RESEARCH ONLY. No campaign code changed. Empirical experiments ran
from a throwaway, uncommitted integration test
(`crates/host-native/tests/zz_scratch_reclaim_spike.rs`) — delete before commit.
**wasmtime:** 35.0.0, host target `aarch64-apple-darwin`.

## The problem

`crates/host-native` runs each guest process/thread as an OS `std::thread`
driving a wasmtime `Instance` over a shared `SharedMemory`. When a guest thread
makes a blocking syscall, its libc glue (`libc/glue/channel_syscall.c`) parks in
a real Wasm `memory.atomic.wait32` on the channel status word
(`__builtin_wasm_memory_atomic_wait32`, `channel_syscall.c:1871`). The
single-threaded pump wakes it by writing `COMPLETE` and calling
`SharedMemory::atomic_notify`.

Three campaign cases need to *reclaim* a thread that is currently parked in that
wait, WITHOUT letting it resume the code it was running:

1. **execve success** — the kernel already performed the POSIX image swap; the
   old thread must never wake into the doomed pre-exec instance. Today it is
   deliberately abandoned. The leak is documented in
   `crates/host-native/src/guest.rs:3866-3887`:
   > "Wasmtime's `Engine` here has no epoch-interruption or fuel configured …
   > so there is also no way to preempt or forcibly join that parked
   > `std::thread` from the outside. … one parked OS thread plus its backing
   > shared memory leaks per successful call."
2. **fork replay threads** — replay/continuation threads that must be torn down.
3. **spawn rollback (`-ECHILD`)** — a just-launched child thread that parked and
   must be unwound when `kernel_publish_spawn_child` rejects the edge.

Node's host solves all three trivially with `Worker.terminate()` (kills the
isolate). `std::thread` has no equivalent.

## Q1 — Does `Config::epoch_interruption` interrupt a parked `atomic.wait32`?

**NO. Empirically confirmed and root-caused in source.**

### Empirical (test output, `--test-threads=1 --nocapture`)

```
exp_a2 (control): running spin loop trapped by epoch = true
exp_a: waiter STILL PARKED after 20 epoch increments — epoch does NOT interrupt atomic.wait
exp_a cleanup: notify woke 1 waiter(s), wait32 returned 0 (0=woken)
```

- `exp_a` parks a guest thread in `memory.atomic.wait32(addr, 0, -1)`, then from
  the main thread hammers `engine.increment_epoch()` 20 times over ~1s with an
  epoch deadline set. The waiter never returns (channel `recv_timeout` expires).
  A subsequent `notify` wakes it (return code 0), proving the thread was
  genuinely parked and only a notify releases it.
- `exp_a2` is the control: the SAME engine config traps a *running* wasm spin
  loop via the epoch (`trapped = true`), proving epoch interruption is correctly
  configured and functional — it simply does not reach a parked wait.

### Root cause (wasmtime 35 source)

The guest instruction lowers to the libcall
`memory_atomic_wait32` (`runtime/vm/libcalls.rs:1074`), which is an **ordinary
synchronous host libcall** (`_store: &mut dyn VMStore` is unused; not async). It
calls `SharedMemory::atomic_wait32` → `ParkingSpot::wait`
(`runtime/vm/parking_spot.rs`), which blocks the OS thread in
`std::thread::park_timeout(Duration::MAX)` for an infinite (`timeout < 0`) wait.

Epoch checks are compiled into *running* wasm at loop backedges / function
entries. While the thread sits inside the `park_timeout` libcall, **no wasm
executes**, so no epoch check is ever reached. wasmtime documents this exactly
(`src/config.rs`, "Interaction with blocking host calls"):

> "Epochs (and fuel) do not assist in handling WebAssembly code blocked in a
> call to the host. … Epochs intentionally only affect running WebAssembly code
> itself and it's left to the embedder to determine how best to wake up
> indefinitely blocking code in the host."

## Q2 — Does fuel / async / any wait-hook help?

**Fuel: NO** — same mechanism and the same doc paragraph groups fuel with
epochs. Fuel is consumed by *executing* wasm; a parked thread executes nothing,
so it can never run out of fuel or reach the `out_of_gas` hook.

**Async / `call_async`: NO (for this primitive).** `Config::async_support` +
the async host-function model turns *host-defined* imports into Rust `Future`s
so that blocking in the host suspends the fiber and yields to the executor
(where `tokio::time::timeout` etc. can cancel it). But `memory.atomic.wait32` is
a **Wasm instruction**, not a host import — it lowers to the synchronous
`memory_atomic_wait32` libcall shown above, which calls `park_timeout` and does
**not** yield to any async executor. There is no async variant of the atomic
wait libcall. So moving the pump to `call_async` would not make the parked
`atomic.wait` cancellable; it would only help if the *blocking primitive itself*
were reshaped into an async host import (that is option (a)/(c) below, i.e. a
design change, not a config flag).

**Wait-hook / max-wait / callback surface in wasmtime 35:**
- `SharedMemory::atomic_wait32(addr, expected, timeout: Option<Duration>)` and
  `atomic_wait64` (`runtime/memory.rs:983`) — the host CAN itself perform a wait
  with a finite deadline and observe `WaitResult::{Ok, Mismatch, TimedOut}`
  (`runtime/vm.rs:489`). There is **no** external-cancel argument.
- `SharedMemory::atomic_notify(addr, count)` — the host CAN wake parked waiters
  from Rust (validated in `exp_c`: `atomic_notify` woke the parked guest,
  `wait32` returned 0).
- The **only** ways a `ParkingSpot` waiter is released (`parking_spot.rs`):
  (1) a `notify` on the **same address** (sets `notified=true` then
  `thread.unpark()`), or (2) the optional **deadline** (`WaitResult::TimedOut`).
  A bare OS-level `Thread::unpark()` is defeated: after any wakeup the loop
  rechecks `ptr.as_ref().notified` and, if false, re-parks. So there is no
  side-channel interrupt — you must either notify the address or arm a deadline.
- `Store::epoch_deadline_callback` / `set_epoch_deadline` /
  `Engine::increment_epoch` all operate on the epoch mechanism, which (Q1)
  cannot reach a parked wait.

**Finite-timeout lever works (`exp_b`):** a `wait32` with a finite timeout
operand self-releases with `WaitResult::TimedOut` (return code 2). Today the
glue passes `-1` (infinite), so this lever is unused. A finite timeout would
turn the wait into a *polling* wait — a possible but undesirable mitigation
(spurious wakeups + latency/throughput cost on the syscall hot path).

## Q3 — Alternatives (feasibility / cost / soundness)

| # | Approach | Feasible? | Cost | Soundness | Verdict |
|---|---|---|---|---|---|
| (a) | Replace the guest `atomic.wait32` in `channel_syscall.c` with a **host import** the pump returns from with a teardown sentinel | Yes | glue/ABI change + guest rebuild **and** loses the elegant guest-parks-on-shared-memory design; every blocking syscall becomes a host round-trip; the host import must itself block (on the parking spot) so complexity moves, not disappears | Sound | Overkill — (b) achieves the same reclamation with a far smaller change |
| (b) | **Sentinel status value + `atomic_notify` + a guest-side check after the wait loop that cooperatively unwinds the thread (trap / `pthread_exit`)** | **Yes — validated (`exp_d`)** | new channel status value (`TEARDOWN`) in `abi_constants.h` + a few lines in `channel_syscall.c` + guest rebuild → **ABI bump**. Reuses the pump's existing notify path. Zero hot-path cost (wait stays infinite; only the teardown path differs) | **Sound** — the guest runs a few glue instructions in the still-live old instance, then traps; wasmtime unwinds the stack and the `wait.call` returns `Err(Trap)`, the OS thread's closure ends, and `Store` + `SharedMemory` ref drop cleanly | **RECOMMENDED** |
| (c) | Move the pump to `call_async` on an async runtime so the block becomes an awaitable the host can drop/cancel | Partially | large architectural change to the pump; **and** does not by itself make `atomic.wait` cancellable (Q2) — still requires reshaping the blocking primitive into an async host import, i.e. (a) | Sound if done fully | Rejected — biggest change, subsumes (a)'s ABI cost anyway |
| (d) | Drop/deallocate the `Store` + `SharedMemory` from another thread while the guest is parked | **No** | n/a | **Unsound / not expressible.** The parked thread owns its `Store` on its own stack (inside the in-flight `wait.call`); there is no external handle to drop it, and the parking `Waiter` (a `Box<WaiterInner>` referenced by raw `SendSyncPtr` from the global `ParkingSpot` map) lives on that stack too. Dropping the memory out from under a thread that will resume and touch it is a use-after-free/data race | Ruled out |
| (e) | Accept the leak but **bound** it (reaper reusing parked-thread slots, hard cap) | Yes | bookkeeping only | Sound but not a fix — the thread + its `SharedMemory` still leak until process teardown; a cap just fails loudly | Mitigation only, not the fix |

### `exp_d` — recommended mechanism, validated end-to-end

The scratch module models the real glue wait loop (park expecting `PENDING`,
re-check on wake) plus a sentinel check: after the loop, if the status word
holds `TEARDOWN(99)` it executes `unreachable`. The host writes `TEARDOWN` to
the status word and calls `atomic_notify`:

```
exp_d: sentinel+notify woke 1; guest thread trapped-out(reclaimed)=true
```

The parked thread woke, saw the sentinel, trapped; `wait.call` returned
`Err(Trap)`; the spawning closure returned and the OS thread exited — the
`Store` and the thread's `SharedMemory` clone dropped. No leak, no UB.

## Q4 — Recommendation for I4 (native fork) + execve

**Adopt option (b): a cooperative host-driven teardown sentinel.**

It is the only mechanism that is sound, cheap on the hot path, and **unifies all
three cases** — execve-abandon, fork replay-thread teardown, and spawn
`-ECHILD` rollback all become "publish `TEARDOWN`, notify the parked channel,
join/forget the thread." The abandoned-thread note at `guest.rs:3866` and the
fork/spawn rollback seams collapse into one primitive.

**It is ABI-affecting.** It adds a value to the channel status alphabet and
changes the guest blocking glue, so per the ABI contract it requires an
`ABI_VERSION` bump (currently 44 → 45) with a regenerated `abi/snapshot.json`,
and a guest rebuild (musl glue → `scripts/build-musl.sh`, then the package/VFS
rebuild path). No new host import is strictly required (the trap path needs no
import), which keeps the host-surface minimal — consistent with the
minimize-host-surface north star.

### Precise change sketch (to plan from, NOT yet applied)

1. **`libc/glue/abi_constants.h`** (generated from `crates/shared`): add
   `#define WASM_POSIX_CHANNEL_STATUS_TEARDOWN 4u`. Mirror the value in the
   Rust source of truth in `crates/shared/src/lib.rs` (the `channel` module and
   the generator that emits `abi_constants.h`), so host, glue, and snapshot
   agree.

2. **`libc/glue/channel_syscall.c`** — immediately after the existing wait loop
   (`channel_syscall.c:1862-1874`), before reading `CH_RETURN`/`CH_ERRNO`, add a
   teardown check that re-reads the status word from `__channel_base` (same
   inline-asm-from-global discipline the surrounding code already uses to dodge
   shadow-stack corruption):

   ```c
   /* Host-driven thread reclamation (execve-abandon / fork-replay /
    * spawn-rollback): the pump published TEARDOWN + notified us precisely to
    * unwind this thread WITHOUT resuming the (now-doomed or superseded) image.
    * Do not read results or return to the caller. Trap so wasmtime unwinds the
    * stack and the host OS thread exits, dropping its Store + SharedMemory. */
   if (__c11_atomic_load((_Atomic uint32_t *)(uintptr_t)(get_channel_base()
           + CH_STATUS), __ATOMIC_SEQ_CST) == CH_TEARDOWN) {
       __builtin_trap();
   }
   ```

   (`pthread_exit`/a dedicated host import are alternatives to `__builtin_trap`;
   the trap path is the smallest and needs no new import. If a clean per-thread
   unwind of musl TLS/atexit matters for a specific case, prefer a host import
   `host_thread_exit` that the pump defines to end the thread — but that adds
   host surface, so default to trap unless a concrete need appears.)

3. **`crates/host-native/src/guest.rs`** — add a helper, e.g.
   `reclaim_parked_thread(mem, ch)`, that does
   `store CH_STATUS = TEARDOWN (release)` then `mem.atomic_notify(ch_status_addr, 1)`,
   and call it in place of today's deliberate abandonment:
   - `handle_exec_common` success path (replace the documented leak at
     `guest.rs:3866-3887`): after `kernel_exec_commit`, tear down the old
     channel's thread before/instead of overwriting `processes[pi]`.
     Keep the thread's `JoinHandle` (today it is dropped, `guest.rs:3881`) so the
     pump can `join()` it after teardown for deterministic reclamation, or track
     it in a small reaper set.
   - The fork replay-thread and spawn `-ECHILD` rollback seams call the same
     helper.

4. **`abi/snapshot.json`** — regenerate in the same change; **`ABI_VERSION`**
   44 → 45 in `crates/shared/src/lib.rs`.

5. **Docs** — update `docs/abi-versioning.md` / fork+exec notes; remove the
   "documented leak" wording at `guest.rs:3866` once the reclamation lands.

### Validation this fix will require (not yet run)

Per the validation + ABI contracts: rebuild musl glue and the kernel/guest,
regenerate + check the ABI snapshot, and exercise native execve / fork / spawn
reclamation (assert no thread/`SharedMemory` growth across repeated
execve+fork). Because it is an ABI bump, the package/VFS-image rebuild path and
Node/browser parity must be considered — those hosts already reclaim via
`Worker.terminate()`, so the new `TEARDOWN` status is a native-host reclamation
path, but the shared status-value constant and snapshot change touch all hosts
and must be regenerated consistently.

## Confidence

**High.** Q1/Q2 are proven both empirically (control-checked) and in wasmtime 35
source + docs. The recommended mechanism (b) is validated end-to-end by `exp_d`
and matches machinery the codebase already has (the pump's notify path; the
existing `REQUEST_FLAG_CANCELLATION_POINT` cooperative-wake plumbing in
`channel_syscall.c` and `crates/shared/src/lib.rs:1273`). The residual risk is
scope, not soundness: multi-threaded execve (multiple live channels per process)
must tear down every sibling channel's thread, which the current
single-live-channel assumption at `guest.rs:3646-3652` does not yet handle.

## Scratch artifacts (uncommitted — remove before commit)

- `crates/host-native/tests/zz_scratch_reclaim_spike.rs` — the 5 experiments
  (`exp_a`, `exp_a2` control, `exp_b`, `exp_c`, `exp_d`). Run with:
  `scripts/dev-shell.sh bash -lc 'cd crates/host-native && cargo test --test
  zz_scratch_reclaim_spike --target aarch64-apple-darwin -- --nocapture
  --test-threads=1'`
