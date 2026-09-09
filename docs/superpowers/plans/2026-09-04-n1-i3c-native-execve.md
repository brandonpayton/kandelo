# N1-I3c: Native host execve (image replacement)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Checkbox (`- [ ]`) steps.

**Goal:** The native wasmtime host (`crates/host-native`) implements `execve` — a running process replaces its own program image in place: same pid, same fds (minus close-on-exec), fresh address space and instance running the new program. Proven by a fixture that `execve`s a second program and observes the NEW program's output + exit code as that process's outcome, plus POSIX-correct `execve` failures (`ENOENT`/`EACCES`/`ENOEXEC`) that RETURN to the calling program (which keeps running).

**Architecture (host-side-only; no kernel/ABI change — verified by grounding):** `SYS_EXECVE` (211) is already classified host-intercepted (`crates/shared/src/host_raw_syscalls.rs`, Tier-A, same bucket as `SYS_CLONE`/`SYS_SPAWN`); the kernel's generic dispatch returns `-ENOSYS` for it (`wasm_api.rs:4801-4809`), forcing host interception exactly like the pump already does for `SYS_CLONE` (`guest.rs:2819`) and `SYS_SPAWN` (`guest.rs:2886`). The pump intercepts `SYS_EXECVE` on the main channel, reads `path`/`argv`/`envp` from guest memory, and drives the NON-spawn exec-target authority: `kernel_exec_target_prepare(pid, caller_tid, AT_FDCWD, path, path_len, 0)` → `kernel_exec_target_size`/`kernel_exec_target_read` (owner_pid == the exec'ing pid; already-wired typed funcs) → `Module::new` → `kernel_exec_commit(pid, caller_tid, token)`. `kernel_exec_commit` does the whole POSIX exec state transition in-kernel (close-on-exec fds, set-ID credentials, `secure_exec`, reset signal dispositions, reset memory accounting, `clear_threads`, bump `exec_generation` — `runtime-core/src/syscalls.rs:875-980`); the host then swaps the image: fresh `SharedMemory`/layout via `compute_guest_memory`, relaunch via the pid-agnostic `launch_process(pid, …)`, replace the `processes[pi]` entry in place. Node's mirror (a cross-check for correct kernel-API sequencing only — POSIX correctness is the goal) is `kernel-worker.ts` `handleExec` (:23986) + `node-kernel-worker-entry.ts` `handleExec`/`startAfterCommit` (:2549/:2636).

**THE THREAD-RECLAMATION GAP (documented, truthful — do NOT try to "fix" it here):** the exec'ing guest thread is parked in a real WASM `memory.atomic.wait32` (a host-level block), and the wasmtime `Engine` (`crates/host-native/src/lib.rs:90-94`) enables neither epoch-interruption nor fuel, so there is NO way to wake it correctly (waking resumes the doomed pre-exec instance) or kill a `std::thread`. On execve SUCCESS the only correct host-side-only strategy is to **abandon the old thread (never notify its channel) and start a fresh thread under the same pid**, dropping the old channels. This is POSIX-*correct* behavior but leaks one parked OS thread + its old `SharedMemory` per `execve`. Node avoids the leak with `Worker.terminate()`; native has no equivalent. The reclamation fix is a cross-cutting `Engine` change (epoch-interruption, uncertain whether it can unblock `atomic.wait`) shared with fork (I4) and the existing spawn-rollback gap — it is DEFERRED to the I4 checkpoint. This increment must DOCUMENT the leak honestly (per the CLAUDE.md truthful-failure contract), not hide it and not attempt the Engine change.

**Tech Stack:** Rust + `wasmtime = "35"` (host-only, `--target <host>`), Kandelo SDK for the C fixtures, `wasm-posix-shared`.

**Spec:** `docs/plans/2026-09-04-rust-first-remaining-purpose-framed.md` §6 (N1 roadmap, I3 → sub-increment **I3c**).

## Global Constraints

- Worktree `/Users/brandon/kandelo-abi44-reconcile` (branch `brandonpayton/rust-first-abi44-reconcile`; PR #1350 head = `brandonpayton/epoll-kernel-route`). Dev-shell + isolated cache: `export KANDELO_SOURCE_CACHE_ROOT="$HOME/.cache/kandelo/reconcile-abi44"; scripts/dev-shell.sh bash -lc '<cmd>'`.
- Test: `cargo test -p host-native --target $(rustc -vV|sed -n 's/^host: //p')` (host `aarch64-apple-darwin`).
- **Host-side-only in `crates/host-native`.** NO change to `crates/kernel`/`runtime-core`/`abi`/`shared`. Uses existing exports `kernel_exec_target_prepare` (`wasm_api.rs:3024`), `kernel_exec_target_size` (:3104), `kernel_exec_target_read` (:3116), `kernel_exec_commit` (:3224), `kernel_exec_target_cancel` (:3210) + the I3a/I3b seams (`launch_process`, `compute_guest_memory`, `read_exec_target_bytes`, `alloc_scratch`, `remove_process`).
- **Scope: `execve` only.** NO `execveat` (dirfd/AT_EMPTY_PATH) and NO `#!` shebang — those are I3d (`kernel_exec_target_shebang`). A `#!` file execve'd here fails `ENOEXEC` at `Module::new` (correct). `SYS_EXECVEAT` (386) stays falling through to the kernel's `-ENOSYS` for now (leave a code comment noting I3d).
- **The failure/success asymmetry is mandatory:** execve FAILURE (bad path, non-exec, non-wasm, commit error) must COMPLETE the exec'ing channel with the errno so the calling program's `execve()` returns `-1`/errno and keeps running. execve SUCCESS must NOT complete that channel (the old thread is abandoned) and swaps the image. Never both.
- **The thread-leak gap must be documented** in code (a comment at the abandon site) and in the task reports; do NOT enable epoch/fuel or attempt reclamation.
- Sandboxed in-memory VFS + N-process pump + waitpid unchanged. SDK fixtures committed (`.c` + `.wasm`). All pre-existing host-native tests stay green (20 today).

## Confirmed facts (verified — do not re-derive)

- Pump interception slot: `run_pump`'s main-channel dispatch special-cases `Syscall::Exit`/`SYS_EXIT_GROUP` (`guest.rs:2763`), thread exit (:2802), `SYS_CLONE` (:2819), `SYS_SPAWN` (:2886); everything else falls to `dispatch_once` (:2897). Add the `SYS_EXECVE` branch here, mirroring `SYS_SPAWN`. `SYS_EXECVE` const = 211 (`crates/shared/src/lib.rs:3620`).
- execve wire args (from guest memory): `arg0 = path` (C-string ptr), `arg1 = argv` (ptr to NULL-terminated array of C-string ptrs), `arg2 = envp` (same). Native guests are wasm32 → pointers are 4 bytes LE. Node's reference readers: `readExecPathFromProcess` + `readStringArrayFromProcess` (`kernel-worker.ts:23995-24023`), bounded by `PROCESS_STARTUP_MAX_ARGV_COUNT`/`_ENVP_COUNT`.
- `kernel_exec_commit` is a pure in-kernel state transition (no host callback); on `0` the host MUST perform the image swap itself. It resets kernel memory *accounting* (`syscalls.rs:956`), so the host must re-push `kernel_set_brk_base`/`kernel_set_mmap_base`/`kernel_set_max_addr` for the new layout — which `launch_process` (`guest.rs:1954-1962`) already does for the pid it's given.
- `launch_process` is pid-agnostic (its doc: "`pid` must already exist as a kernel-side process record — this helper does not create it"): it can relaunch the SAME pid with a new module/memory/argv. `compute_guest_memory` (`guest.rs:1895`) allocates a fresh zeroed `SharedMemory`+layout from the new module — the POSIX-correct fresh address space.
- The new image receives argv/envp via `launch_process`'s host-side argv delivery (native serves `kernel_get_argc`/`argv_read`/`environ_*` from the launch args) — no kernel argv-set call needed.
- caller_tid + channel completion: acquire the exec'ing thread's tid the same way the `SYS_SPAWN`/`SYS_CLONE` branches do; complete/fail the channel with the same `fail_spawn`/`complete_channel` mechanism the pump already uses (that is how a failed execve resumes the caller).

---

### Task 1: Intercept SYS_EXECVE + replace the image (happy path)

**Files:** Modify `crates/host-native/src/guest.rs` (SYS_EXECVE pump branch; the non-spawn exec-target TypedFuncs; guest-memory `argv`/`envp`/path readers; in-place `GuestProcess` swap for the same pid; the documented thread-abandon site). Create `crates/host-native/fixtures/native_exec_parent.c` + `crates/host-native/fixtures/native_exec_target.c` (+ `.wasm`). Test in `crates/host-native/src/lib.rs`.

**Interfaces:**
- Consumes: `launch_process`, `compute_guest_memory`, `read_exec_target_bytes`, `alloc_scratch`, `write_bytes`/`read_bytes`, the `GuestProcess` struct, the pump's caller_tid + channel-complete helpers.
- Produces (for Task 2): the SYS_EXECVE branch structure + a `read_guest_cstring`/`read_guest_string_array` helper (name them in your report) that Task 2's failure tests reuse; the success-path image swap.

- [ ] **Step 1: Write the failing test.** `native_exec_target.c`: `write(1, "exec ok\n", 8); _exit(9);`. `native_exec_parent.c`: `execve("/bin/exectarget", {"/bin/exectarget", NULL}, {NULL})` and, if it returns, `write(1,"execve returned\n",…); _exit(1);` (a successful execve must NOT reach that line). Build both. Place BOTH in the `BaseImage` (`/bin/exectarget` mode `0o755`, and the parent as the booted program). `#[test] smoke_execve_replaces_image`: boot the parent, assert combined stdout contains `"exec ok"`, NOT `"execve returned"`, and the process exit code is 9 (the exec'd image's exit). Fails first: today SYS_EXECVE falls through to the kernel's `-ENOSYS`, so `execve` returns -1 and the parent prints `"execve returned"` + exits 1.
- [ ] **Step 2: RED** — `cargo test -p host-native --target <host> smoke_execve_replaces_image`.
- [ ] **Step 3: Implement.**
  1. Bind the non-spawn TypedFuncs (mirror the spawn ones at `guest.rs:733`): `kernel_exec_target_prepare` as `(u32,u32,i32,u32,u32,u32)->i32` and `kernel_exec_commit` as `(u32,u32,u32)->i32`. Thread them into `run_pump` like the spawn funcs (`guest.rs:2634`). Reuse the already-bound `exec_target_size`/`exec_target_read`/`exec_target_cancel`.
  2. Add guest-memory readers: `read_guest_cstring(mem, ptr: u32) -> Vec<u8>` (read until NUL) and `read_guest_string_array(mem, arr_ptr: u32, max: usize) -> Result<Vec<Vec<u8>>, i32>` (walk 4-byte LE pointers until a NULL entry, bounded by `max` like Node's `PROCESS_STARTUP_MAX_ARGV_COUNT`; return `-E2BIG`/`-EFAULT` on overflow/bad ptr).
  3. Add the `SYS_EXECVE` branch in `run_pump` before `dispatch_once` (mirror the `SYS_SPAWN` branch site, `guest.rs:2886`): read `path`=arg0 (cstring), `argv`=arg1, `envp`=arg2 from the exec'ing process's memory; write the path into a kernel scratch region; `token = kernel_exec_target_prepare(pid, caller_tid, AT_FDCWD, path_ptr, path_len, 0)`. (Task 1: on `token<0`, for now `fail`/complete the channel with `-token` so the caller resumes — Task 2 hardens the full matrix.)
  4. `bytes = read_exec_target_bytes(pid, token)` (owner_pid = the exec'ing pid). `Module::new(engine, &bytes)` — Task 1 may `?`-propagate a compile error for now (Task 2 makes it `ENOEXEC`-to-caller). `kernel_exec_commit(pid, caller_tid, token)`.
  5. On `commit == 0` (SUCCESS): `compute_guest_memory(engine, &new_module)` → fresh mem/layout; `let new_proc = launch_process(engine, kernel_store, alloc_scratch, set_brk_base, set_mmap_base, set_max_addr, new_module, new_mem, new_layout, pid, Arc::new(Mutex::new(None)), Arc::new(argv), Arc::new(envp))?`. Replace `processes[pi]` with `new_proc` (SAME pid). **Do NOT complete the old channel** — abandon the old thread. Drop the old process's channels (they are replaced by `new_proc.channels`). Add a clear comment documenting the thread-abandon leak (see the architecture note).
  6. The pump must continue servicing `new_proc`'s channel from the next iteration (since `processes[pi]` now points at it).
- [ ] **Step 4: GREEN** (`"exec ok"`, no `"execve returned"`, exit 9) + full suite green.
- [ ] **Step 5: Commit.** `git commit -m "Host-native: execve replaces the process image in place (N1-I3c)"`

---

### Task 2: execve failure asymmetry (resume the caller) + no-leak + documented gap

**Files:** Modify `crates/host-native/src/guest.rs` (the SYS_EXECVE failure matrix: prepare/read/compile/commit failures COMPLETE the exec'ing channel with the errno so the caller's `execve()` returns and the OLD image keeps running; cancel a retained target on failure; the documented leak comment). Create `crates/host-native/fixtures/native_exec_fail.c` (or parameterize the parent to execve a configurable path + print the errno if execve returns). Test in `crates/host-native/src/lib.rs`.

**Interfaces:** Consumes Task 1's branch + readers. Produces the POSIX failure semantics: execve failure never swaps the image and always resumes the caller with the correct errno; success never resumes the caller.

- [ ] **Step 1: Write the failing tests.** Parent fixture that `execve`s a configurable path and, on return, prints `"execve errno=N\n"` and `_exit(0)`:
  - `smoke_execve_missing_enoent`: execve `/bin/nope` (absent) → assert stdout `"execve errno=2"`, process exit 0 (caller survived).
  - `smoke_execve_non_executable_eacces`: execve `/etc/data` (mode `0o644`) → `"execve errno=13"`, exit 0.
  - `smoke_execve_not_wasm_enoexec`: execve `/bin/notwasm` (mode `0o755`, non-wasm bytes) → `"execve errno=8"`, exit 0.
  Fails first: Task 1 `?`-propagates the compile error (pump bail) for the ENOEXEC case, and may not resume the caller with the right errno for the others.
- [ ] **Step 2: RED** — run the three new tests.
- [ ] **Step 3: Implement.** In the SYS_EXECVE branch:
  - **prepare `< 0`**: complete the exec'ing channel with `-token` (caller's `execve` returns that errno; old image continues). No target retained → no cancel. NO image swap.
  - **read error / `Module::new` error**: the target IS retained → `kernel_exec_target_cancel(pid, token)` best-effort, then complete the channel with the mapped errno (read error) or `ENOEXEC` (`Module::new`), resuming the caller. Wrap `Module::new` so its `Err` becomes `ENOEXEC`, never a pump `bail!`.
  - **commit `< 0`**: `kernel_exec_target_cancel(pid, token)` best-effort, complete the channel with `-commit`. NO swap.
  - **post-commit `launch_process`/`compute_guest_memory` error** (rare — bytes already compiled + kernel already exec'd, so the process cannot continue): this is a genuinely unrecoverable state (the kernel image is committed but the host can't run it). Truthfully terminate the process: record it exited with a fatal status (e.g. `128 + SIGKILL`) and remove it — do NOT silently resume the doomed old image. Document this edge.
  - Every failure branch that did NOT commit leaves the old thread running (it is the channel we complete). Success (Task 1) abandons it. Document the leak comment at the success abandon site.
- [ ] **Step 4: GREEN** (three new tests: caller survives with the right errno) + full suite (expect 24: 20 + Task-1's 1 + these 3). Confirm no failure test hits the 30s pump cap.
- [ ] **Step 5: Commit.** `git commit -m "Host-native: POSIX-correct execve failures resume the caller; documented thread-leak (N1-I3c)"`

---

## Notes for the executor
- Reference (cross-check ONLY): `host/src/kernel-worker.ts` `handleExec` (:23986, the path/argv/envp reads + the failure-completes-the-channel pattern) and `node-kernel-worker-entry.ts` `handleExec`/`startAfterCommit` (:2549/:2636, the fresh-memory + same-pid relaunch). POSIX correctness is the goal; do not copy Node behavior that is not POSIX-required (e.g. Node's `Worker.terminate()` has no native analog — abandon-and-document instead).
- The failure/success asymmetry is the crux: a failed execve is an ordinary syscall that returns to the caller; a successful execve never returns. Get the channel-completion vs. channel-abandon decision exactly right per branch.
- Do NOT enable wasmtime epoch-interruption/fuel or attempt to reclaim the abandoned thread — that is the deferred cross-cutting I4-checkpoint item. Document the leak; do not hide or "fix" it here.
- Do NOT implement `execveat` or `#!` shebang (I3d). Leave `SYS_EXECVEAT` (386) falling through to the kernel `-ENOSYS` with a comment.
- Fixtures SDK-built (`fixtures/build-fixtures.sh`); commit `.c` + `.wasm`.
