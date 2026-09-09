# Task 1 report: native `execve` (happy-path image swap)

Branch: `brandonpayton/rust-first-abi44-reconcile`. Worktree:
`/Users/brandon/kandelo-abi44-reconcile`.

## Summary

Implemented `SYS_EXECVE` interception in the native Wasmtime host's channel
pump (`crates/host-native/src/guest.rs`): the pump now drives the kernel's
`kernel_exec_target_prepare` / `read_exec_target_bytes` / `Module::new` /
`kernel_exec_commit` sequence against the CALLING process's own pid, and on
success swaps that pid's `GuestProcess` in place with a fresh
module/memory/argv/envp — POSIX image replacement, not a new process. Task 1
covers the happy path plus a basic (non-matrix) failure completion for a
`token < 0` / read / commit failure; `execveat` and `#!` shebang stay
unimplemented (documented, deferred to I3d).

## Exact edits

### `crates/host-native/src/guest.rs`

- **Imports** (top of file): added `SYS_EXECVE` to the
  `wasm_posix_shared::abi::host_intercepted` import, and added
  `use wasm_posix_shared::platform_limits::PROCESS_STARTUP_MAX_ARGV_COUNT;`.

- **TypedFunc bindings** (~guest.rs:747-764, right after the existing
  `exec_target_cancel` binding at the old line 745-746): bound the two
  non-spawn exec-target exports —
  ```rust
  let exec_target_prepare = kernel.get_typed_func::<(u32, u32, i32, u32, u32, u32), i32>(
      &mut kernel_store, "kernel_exec_target_prepare",
  )?;
  let exec_commit =
      kernel.get_typed_func::<(u32, u32, u32), i32>(&mut kernel_store, "kernel_exec_commit")?;
  ```
  Confirmed against the actual kernel export signatures in
  `crates/kernel/src/wasm_api.rs:3024` (`kernel_exec_target_prepare(pid,
  caller_tid, dirfd, path_ptr, path_len, flags) -> i32`) and
  `wasm_api.rs:3224` (`kernel_exec_commit(pid, caller_tid, target) -> i32`).

- **`run_guest`'s `run_pump` call site** (~guest.rs:922-943): threaded
  `&exec_target_prepare, &exec_commit` in right after the existing
  `&exec_target_cancel` argument.

- **`run_pump`'s signature** (~guest.rs:2660-2680): added
  `exec_target_prepare: &wasmtime::TypedFunc<(u32, u32, i32, u32, u32, u32), i32>`
  and `exec_commit: &wasmtime::TypedFunc<(u32, u32, u32), i32>` parameters,
  positioned right after `exec_target_cancel`.

- **Guest-memory readers** (new, placed right after `atomic_u32`,
  ~guest.rs:465-527):
  - `fn read_guest_cstring(mem: &SharedMemory, ptr: u32) -> Vec<u8>` — reads
    to the first NUL byte, bounded by `mem.data().len()` (the guest memory's
    actual current size, not a fixed cap); an out-of-range `ptr` returns an
    empty `Vec` rather than panicking.
  - `fn read_guest_string_array(mem: &SharedMemory, arr_ptr: u32, max: usize)
    -> Result<Vec<Vec<u8>>, i32>` — walks 4-byte-LE guest pointers from
    `arr_ptr` until a NULL entry, calling `read_guest_cstring` on each.
    `arr_ptr == 0` returns `Ok(vec![])` (NULL argv/envp, matching
    `execve`/`posix_spawn` convention). Returns `Err(-E2BIG)` if more than
    `max` non-null entries appear before a NULL terminator, `Err(-EFAULT)` if
    the pointer-array scan would run past the end of guest memory first. The
    `Err` value is NEGATIVE, matching every other kernel-call result in this
    file (`token < 0`, `commit < 0`, ...) so callers uniformly do `-err` to
    get a positive errno for `complete_channel`.
  - Both are pinned to `PROCESS_STARTUP_MAX_ARGV_COUNT` (4096,
    `crates/shared/src/lib.rs:154`) at the call site, mirroring the reference
    reader's ceiling (`host/src/kernel-worker.ts`'s
    `readStringArrayFromProcess`, `:23781`).

- **The `SYS_EXECVE` pump branch** (in `run_pump`, immediately after the
  existing `SYS_SPAWN` branch, ~guest.rs:2917-2939): guarded by `ch.is_main
  && syscall_nr == SYS_EXECVE`, calls `handle_execve(...)` then
  `ci += 1; continue;` — mirrors the `SYS_SPAWN` branch's structure exactly
  (dispatch to a dedicated function, never falls into `dispatch_once`).

- **`handle_execve`** (new function, ~guest.rs:3457-3618, placed right after
  `fail_spawn`/before `rollback_spawned_child` — next to the spawn family it
  parallels):
  1. `path_bytes = read_guest_cstring(&guest_mem, args[0] as u32)`;
     `argv_ptr = args[1] as u32`; `envp_ptr = args[2] as u32` (wire args per
     `libc/musl/src/process/execve.c`'s plain `syscall(SYS_execve, path,
     argv, envp)` — confirmed there is NO wasm32posix override for
     `execve`/`execveat` in `libc/glue/channel_syscall.c`, so this really is
     the generic RAW-args channel path, exactly like `SYS_SPAWN`).
  2. `argv_list`/`envp_list` via `read_guest_string_array(..., 4096)`; a
     `Err(errno)` here calls `fail_execve(..., -errno)` and returns.
  3. Stage `path_bytes` into a fresh KERNEL-memory scratch region
     (`alloc_scratch` + `write_bytes(kernel_mem, ...)`), exactly like
     `handle_spawn`'s `resolve_bytes` staging.
  4. `token = exec_target_prepare.call(kernel_store, (pid, caller_tid,
     open_flags::AT_FDCWD, path_scratch, path_len, 0))`. `token < 0` ->
     `fail_execve(..., -token)` (Task 1: no cancel needed — no target was
     ever retained on a `prepare` failure).
  5. `program_bytes = read_exec_target_bytes(kernel_store, kernel_mem,
     exec_target_size, exec_target_read, read_scratch, EXEC_TARGET_READ_CHUNK,
     pid, token)` (owner_pid = the exec'ing `pid`, reusing I3b's
     owner-generic helper verbatim). A returned `Err(errno)` calls
     `exec_target_cancel.call((pid, token))` (best-effort, ignored result)
     then `fail_execve(..., errno)`.
  6. `new_module = Module::new(engine, &program_bytes)?` — Task 1
     `?`-propagates a compile failure (ends the whole pump run); Task 2 is
     expected to turn this into `fail_execve(..., ENOEXEC)` after a cancel,
     mirroring `handle_spawn`'s `Module::new` handling.
  7. `commit = exec_commit.call(kernel_store, (pid, caller_tid, token))`.
     `commit < 0` -> `fail_execve(..., -commit)`.
  8. On `commit == 0`: `compute_guest_memory(engine, &new_module)` ->
     `launch_process(engine, kernel_store, alloc_scratch, set_brk_base,
     set_mmap_base, set_max_addr, new_module, new_mem, new_layout, pid,
     Arc::new(Mutex::new(None)), Arc::new(argv_list), Arc::new(envp_list))?`
     -> `processes[pi] = new_proc;` (SAME pid, same index `pi`). The old
     channel `ch` is never completed.

- **`fail_execve`** (new function, ~guest.rs:3620-3636): `complete_channel(
  guest_mem, kernel_mem, 0, ch, SYS_EXECVE, args, &[], -1, errno as u32)` —
  identical shape to `fail_spawn`.

### `crates/host-native/src/lib.rs`

- Added `#[test] fn smoke_execve_replaces_image()` (inserted right after
  `smoke_spawn_waitpid`, before the N1-I3b Task 2 failure-matrix tests):
  boots `native_exec_parent.wasm` with a `BaseImage` containing
  `/bin/exectarget` (`native_exec_target.wasm`, mode `0o755`); asserts
  combined stdout contains `"exec ok"`, does NOT contain `"execve
  returned"`, and `outcome.exit_code == 9`.

### New fixtures

- `crates/host-native/fixtures/native_exec_target.c` — `write(1, "exec
  ok\n", 8); _exit(9);`
- `crates/host-native/fixtures/native_exec_parent.c` — `execve("/bin/
  exectarget", {"/bin/exectarget", NULL}, {NULL})`; on return, `write(1,
  "execve returned\n", 16); _exit(1);`
- Both built via `crates/host-native/fixtures/build-fixtures.sh` (which
  globs every `*.c` in the directory — no script edit needed) using the
  worktree's existing `sysroot/` (already built for this branch's ABI, no
  rebuild required). `.wasm` outputs committed alongside the `.c` sources
  (the repo's root `.gitignore` has a `*.wasm` rule; every existing fixture
  `.wasm` in this directory is force-added, and the two new ones need
  `git add -f` at commit time — done as part of this task's commit).

## `read_guest_*` helper signatures (for Task 2)

```rust
fn read_guest_cstring(mem: &SharedMemory, ptr: u32) -> Vec<u8>;
fn read_guest_string_array(mem: &SharedMemory, arr_ptr: u32, max: usize)
    -> Result<Vec<Vec<u8>>, i32>;   // Err holds a NEGATIVE errno (-E2BIG / -EFAULT)
```

## The `SYS_EXECVE` branch structure

```rust
if ch.is_main && syscall_nr == SYS_EXECVE {
    handle_execve(
        kernel_store, engine, kernel_mem, processes, pi, ch, &args, alloc_scratch,
        set_brk_base, set_mmap_base, set_max_addr, exec_target_prepare, exec_target_size,
        exec_target_read, exec_commit, exec_target_cancel,
    )?;
    ci += 1;
    continue;
}
```
Placed immediately after the existing `SYS_SPAWN` branch, before the
fall-through to `dispatch_once`. On success `handle_execve` overwrites
`processes[pi]` in place (the channel vec at index `pi` is now the fresh
process's single main channel, so `ci += 1` naturally exits the inner
`while ci < processes[pi].channels.len()` loop for this pass — verified by
the passing test, which is single-threaded so the exec'ing process has
exactly one channel at exec time). On failure `handle_execve`/`fail_execve`
already completed `ch` directly (like `fail_spawn`), so `ci += 1; continue;`
is correct either way.

## prepare -> read -> compile -> commit -> swap flow

See `handle_execve`'s doc comment and steps 3-8 above. Order matches the
brief exactly: `kernel_exec_target_prepare` -> `read_exec_target_bytes` ->
`Module::new` -> `kernel_exec_commit` -> `compute_guest_memory` ->
`launch_process` -> `processes[pi] = new_proc`.

## Process swap + abandoned-thread leak

`processes[pi] = new_proc;` replaces the `GuestProcess` struct value at the
same `Vec` index (same `pid`). The OLD `GuestProcess` (its `module`,
`memory`, `scratch_base`, `layout`, `channels`) is dropped by that
assignment; the old guest OS thread (spawned by `spawn_guest_thread` inside
the ORIGINAL `launch_process` call, whose `JoinHandle` was never retained
anywhere — matching the existing pattern for every other guest/worker
thread in this file) is not joined or signaled and keeps existing, parked
forever inside `memory.atomic.wait32` on the OLD channel's status word. The
leak is documented at the swap site in `handle_execve`:

> DOCUMENTED LEAK (deliberate — do not "fix" by waking or killing the old
> thread): the exec'ing guest thread — this channel's OS thread, `ch` — is
> right now parked in a REAL Wasm `memory.atomic.wait32` on `ch`'s status
> word, inside the OLD, now-superseded module instance and memory. We never
> complete `ch`: `kernel_exec_commit` already performed the actual POSIX
> exec transition in the kernel, so waking that parked thread would resume
> execution inside the doomed PRE-exec instance — exactly the image POSIX
> `execve` just replaced. Wasmtime's `Engine` here has no epoch-interruption
> or fuel configured (a deferred, cross-cutting Engine change, out of scope
> for this increment), so there is also no way to preempt or forcibly join
> that parked `std::thread` from the outside. ... one parked OS thread plus
> its backing shared memory leaks per successful `execve`. This is
> POSIX-correct (`execve` truly never returns to the old image on success),
> but it is a real, permanent resource leak per call.

Also documented in `handle_execve`'s top doc comment: Task 1's scope assumes
the exec'ing process has no OTHER live channels at exec time (a concurrent
worker/pthread channel is not reconciled against the kernel's in-kernel
`clear_threads` by this task — flagged as out of scope, not fixed).

## `caller_tid` acquisition

`let caller_tid = ch.tid;` — identical to `handle_spawn`'s
`let caller_tid = ch.tid;` (the `PumpChannel.tid` field IS the thread's tid;
for the main channel this equals the process's pid-as-tid convention used
throughout this file, e.g. `PumpChannel { offset: ..., tid: pid, is_main:
true }` in `launch_process`).

## RED evidence

With only `crates/host-native/src/lib.rs` (test) applied, `guest.rs`
reverted to `d4db3e8a5` (temporarily `git stash push -- .../guest.rs`),
`cargo test -p host-native --target aarch64-apple-darwin
smoke_execve_replaces_image -- --nocapture`:

```
test tests::smoke_execve_replaces_image ...
thread 'tests::smoke_execve_replaces_image' panicked at crates/host-native/src/lib.rs:902:9:
expected the exec'd target's stdout line to appear: "execve returned\n"
test result: FAILED. 0 passed; 1 failed; 0 ignored; 0 measured; 20 filtered out
```
Confirms today's `SYS_EXECVE` falls through to the kernel's generic dispatch
(`-ENOSYS`), `execve()` returns, and the parent prints `"execve
returned\n"` — exactly the brief's predicted RED state.

## GREEN evidence

After `git stash pop` (restoring the `guest.rs` implementation), same
command:
```
test tests::smoke_execve_replaces_image ... ok
test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 20 filtered out
```

## Full suite

`cargo test -p host-native --target aarch64-apple-darwin` (via
`scripts/dev-shell.sh`, `KANDELO_SOURCE_CACHE_ROOT` set to the isolated
cache root):
```
running 21 tests
... (all 21 named tests) ...
test result: ok. 21 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 10.55s
Doc-tests host_native: 0 passed; 0 failed
```
All 20 pre-existing tests plus the new `smoke_execve_replaces_image` are
green; no regressions.

## Not run

- `cargo clippy` / `cargo fmt --check` — pre-existing failures unrelated to
  this change (toolchain mismatch, per the task instructions); not run, not
  claimed.
- Node/browser hosts — out of scope; this task is host-native (Wasmtime)
  only, no changes to `crates/kernel`, `crates/runtime-core`, `crates/abi`,
  or `crates/shared`.
- `execveat` (386) and `#!` shebang interpretation — explicitly deferred to
  I3d; `execveat` still falls through to the kernel's generic `-ENOSYS` (no
  branch added), unaffected by this change.

## Concerns / follow-ups for Task 2

1. **Multi-threaded `execve`**: if the exec'ing process has live worker
   (pthread) channels at the moment of `execve`, this task does not remove
   them from the OLD `GuestProcess.channels` before the struct is dropped —
   they simply vanish along with the rest of the old `GuestProcess`, but the
   kernel-side `clear_threads` semantics (killing those threads in-kernel)
   are not cross-checked against host-side channel bookkeeping. Not
   exercised by Task 1's single-threaded fixtures; worth an explicit test
   or guard in a later task.
2. **`token < 0` / read / commit failure paths have no `exec_target_cancel`
   on the `prepare`-failure branch** (correctly — no target was ever
   retained there) but the read-failure and commit-failure branches DO call
   `exec_target_cancel` best-effort with the result ignored (`let _ = ...`);
   Task 2 should decide whether a cancel failure there deserves an
   `eprintln!` like `handle_spawn`'s `rollback_exec_target` has, for
   observability parity.
3. **`Module::new` compile failure currently `?`-propagates**, ending the
   whole pump run rather than reporting `ENOEXEC` to the caller — Task 2's
   explicit job, flagged in both the code comment and this report.
4. The abandoned pre-exec `SharedMemory`/thread leak is permanent per
   `execve` call and NOT bounded — a guest that `execve`s in a loop will
   leak one OS thread + one `SharedMemory` reservation per iteration. This
   is called out as intentional/deferred per the task brief, not something
   to silently accept as fine for a long-running host process; worth a
   `docs/` note referencing this report before this path sees any adjacent
   production use.
