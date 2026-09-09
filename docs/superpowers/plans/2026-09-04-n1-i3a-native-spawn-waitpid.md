# N1-I3a: Native host process spawn (posix_spawn) + waitpid

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Checkbox (`- [ ]`) steps.

**Goal:** The native wasmtime host (`crates/host-native`) runs **multiple processes**: a parent program `posix_spawn`s a child program, the child runs to completion in its own process, and the parent `waitpid`s its exit status. This is the fresh-image process-launch path (NOT fork — no continuation replay; that's I4). Proven by a parent+child fixture asserting the child's output + `WEXITSTATUS`.

**Architecture (host-side-only; no kernel/ABI change — verified by grounding):** The kernel owns spawn authority (`kernel_spawn_process`/`kernel_spawn_blob_decode`/`kernel_publish_spawn_child`, `crates/kernel/src/wasm_api.rs:2023/2142/2075`) and delegates reaping to `host_waitpid` (`crates/runtime-core/src/process.rs:170`; `sys_waitpid` at `syscalls.rs:18302`). host-native today runs ONE process + N thread-channels over one shared memory (`run_pump`, `spawn_guest_thread`, the `channels` vec, `guest.rs`). I3a generalizes that to **N processes, each with its own `SharedMemory` + pid + scratch + channel(s)**, intercepts `SYS_SPAWN` (500) in the pump to launch a child process from a host-provided program map, and implements `host_waitpid` as a **parked/retried** op (mirroring the existing blocking-poll/read table, `guest.rs` blocked-ops ~:2152) — a true block would deadlock the single-threaded pump that must also service the child's channel. Mirrors the Node reference: `#handleSpawn`/`handlePosixSpawn` + `#hostWaitpid` (`host/src/kernel-worker.ts`, `node-kernel-worker-entry.ts:3023`).

**Tech Stack:** Rust + `wasmtime = "35"` (host-only, `--target <host>`), Kandelo SDK for the C fixtures (build-fixtures.sh — already working in this worktree), `wasm-posix-shared`.

**Spec:** `docs/plans/2026-09-04-rust-first-remaining-purpose-framed.md` §6 (N1 roadmap, I3) + the I3 grounding.

## Global Constraints
- Worktree `/Users/brandon/kandelo-abi44-reconcile` (branch `brandonpayton/rust-first-abi44-reconcile`). Dev-shell + isolated cache: `export KANDELO_SOURCE_CACHE_ROOT="$HOME/.cache/kandelo/reconcile-abi44"; scripts/dev-shell.sh bash -lc '<cmd>'`. Test: `cargo test -p host-native --target $(rustc -vV|sed -n 's/^host: //p')`.
- **Host-side-only in `crates/host-native`.** No `crates/kernel`/`runtime-core`/`abi` change. Uses existing kernel exports (`kernel_spawn_process`, `kernel_publish_spawn_child`, `kernel_spawn_blob_decode`, `kernel_reap_exited_child`, `kernel_get_process_exit_status`) + defines the guest imports `kernel_execve`/`kernel_wait4` (post on channel, mirroring `kernel_clone`) + the `host_waitpid` import.
- **Scope: posix_spawn + waitpid only.** execve (image replacement), spawn-bytes-from-VFS, shebang/execveat = later increments (I3b/c/d). Child program bytes come from a `GuestOptions.programs: HashMap<String, Vec<u8>>` host map (mirrors Node's `execPrograms`).
- **No fork machinery** (`sys_clone` rejects non-thread clones; spawn is fresh-image). Sandbox + in-memory VFS (I1/I2) unchanged; each process gets the same overlay/tmpfs enablement.
- SDK-built fixtures committed (`.c` + `.wasm`). The default (no spawn) path stays exactly I1/I2. All pre-existing host-native tests stay green.

---

### Task 1: Generalize the pump to N processes

**Files:** Modify `crates/host-native/src/guest.rs` (the pump's process/channel bookkeeping: per-process `pid`, scratch region, `SharedMemory`, `ProcessLayout`, channels — factor the single-process assumptions in `run_guest`/`run_pump`/`spawn_guest_thread` into a per-process struct).

**Interfaces:** Produces a pump that tracks a set of processes (each `{ pid, memory, scratch, channels, layout, exit_status }`) and can host >1; a helper to launch a guest instance for a given (program bytes, pid, memory) — extracted from `spawn_guest_thread` — reusable by Task 2. Name the per-process struct + the launch helper in your report.

- [ ] **Step 1: Write the failing/guard test.** This is a refactor with no new behavior; add a structural assertion if useful, but the gate is NO REGRESSION: the existing tests (`smoke_runs_inmemory_vfs`, `smoke_reads_base_file`, `smoke_runs_native_dir_mount*`, the thread/pipe/poll/epoll tests) must all still pass after the refactor. (Optionally add a test that two independent `run_guest` calls don't share state.)
- [ ] **Step 2: Run baseline.** `cargo test -p host-native --target <host>` — record the current pass count (should be 15) as the bar.
- [ ] **Step 3: Refactor.** Introduce a per-process representation (e.g. `struct GuestProcess { pid: i32, memory: SharedMemory, scratch_base: usize, layout: ProcessLayout, channels: Vec<PumpChannel> }`) and thread it through `run_pump` (the pump loops over all processes' channels), factoring out the single `pid`/scratch/memory globals. Extract the instance-launch logic from `spawn_guest_thread` into a reusable `launch_process(program_bytes, pid, memory, entry) -> thread handle` (Task 2 reuses it). Keep behavior identical for the single-process case. Do NOT add spawn/wait yet.
- [ ] **Step 4: Run GREEN.** Same command — all pre-existing tests pass (same count), no behavior change.
- [ ] **Step 5: Commit.** `git commit -m "Host-native: generalize the channel pump to N processes (N1-I3a)"`

---

### Task 2: Intercept SYS_SPAWN + launch the child process

**Files:** Modify `crates/host-native/src/guest.rs` (SYS_SPAWN interception in the pump; the `kernel_execve`/`kernel_wait4` guest imports; `GuestOptions.programs` map).

**Interfaces:** Consumes Task 1's per-process launch helper. Produces: on `SYS_SPAWN`, the pump decodes the blob, resolves the program, creates the child via the kernel, and launches it as a new `GuestProcess`. (Reaping is Task 3 — until then a spawned child runs but the parent's `wait` isn't serviced.)

- [ ] **Step 1: Write the (partial) failing test.** Add a `native_spawn_parent.c` that `posix_spawn`s `"child"` and a `native_spawn_child.c` that writes a known line to stdout + `_exit(7)`; build both. A test that runs the parent with `programs = {"child": <child.wasm>}` and asserts the CHILD's stdout line appears (proving the child launched + ran). (waitpid assertion comes in Task 3.) Fails first (SYS_SPAWN unhandled → channel error / parent hangs or errors).
- [ ] **Step 2: RED** — `cargo test -p host-native --target <host> <spawn_test>`.
- [ ] **Step 3: Implement.** Intercept `SYS_SPAWN` (500) in the pump (parse wire args per `libc/musl-overlay/src/process/wasm32posix/posix_spawn.c:13-19`: path ptr/len, blob ptr/len, pid_out_ptr): call `kernel_spawn_blob_decode` to get framed argv/envp, resolve `argv[0]` (or the path) in `GuestOptions.programs`, call `kernel_spawn_process(parent_pid, caller_tid, blob_ptr, blob_len)` for the child pid, launch the child program bytes as a new `GuestProcess` (Task 1's helper: fresh SharedMemory + create_process + overlay/tmpfs enable + base image + spawn thread + register its channel), write the child pid to `pid_out_ptr`, and `kernel_publish_spawn_child(parent_pid, child_pid)`. Define the `kernel_execve`/`kernel_wait4` guest imports to post their syscalls on the channel (mirror `kernel_clone`, `guest.rs:1744`) — `kernel_execve` may still route to a not-yet-implemented path (I3c) but must not trap the build; `kernel_wait4` posts SYS_WAIT4 for Task 3.
- [ ] **Step 4: GREEN** (child stdout appears) + full suite green.
- [ ] **Step 5: Commit.** `git commit -m "Host-native: intercept SYS_SPAWN and launch the child process (N1-I3a)"`

---

### Task 3: host_waitpid (parked reaping) + the spawn/wait e2e

**Files:** Modify `crates/host-native/src/guest.rs` (the `host_waitpid` import + parked-wait servicing in the pump; child-exit → publish → reap → status writeback); Test in `crates/host-native/src/lib.rs`.

**Interfaces:** Consumes Tasks 1-2. Produces `host_waitpid(pid, options, status_ptr) -> i32` returning the reaped child pid (or `-ECHILD`) + writing the 4-byte wait status, serviced as a parked op so the pump keeps running the child.

- [ ] **Step 1: Write the failing test.** `smoke_spawn_waitpid`: parent fixture `posix_spawn`s `"child"` (child writes `"child ok\n"` + `_exit(7)`), then `waitpid`s and prints e.g. `"status=7\n"`; assert combined stdout contains `"child ok"` AND `WEXITSTATUS==7` (parent prints `status=7`), parent exit 0. Fails first (host_waitpid unimplemented / parent hangs).
- [ ] **Step 2: RED** — `cargo test -p host-native --target <host> smoke_spawn_waitpid`.
- [ ] **Step 3: Implement.** Define the `host_waitpid` import (currently trapped): when the parent's channel dispatches SYS_WAIT4 → host_waitpid, if the target child hasn't exited, PARK the request (record it in a wait table keyed by parent pid, like the blocking-poll/read table at `guest.rs:~2152`) and return control to the pump so it keeps servicing the child's channel; when the child's main channel posts exit (record its `kernel_get_process_exit_status`), resolve any parked wait for it: write the wait status (encode per waitpid's status convention — see `sys_waitpid`/the reference `#hostWaitpid`), `kernel_reap_exited_child(0, child_pid)`, complete the parent's parked channel with the child pid. Handle `-ECHILD` when no child exists. Get the exit→publish→reap→writeback ordering right so the parent resolves exactly once with the correct status.
- [ ] **Step 4: GREEN** (parent prints status=7, child stdout present) + full suite green.
- [ ] **Step 5: Commit.** `git commit -m "Host-native: host_waitpid parked reaping; posix_spawn+waitpid e2e (N1-I3a)"`

---

## Notes for the executor
- Reference the Node/browser host: `host/src/kernel-worker.ts` `#handleSpawn`/`#handleSpawnAfterResolve`/`handleWaitpid`, `host/src/node-kernel-worker-entry.ts` `handlePosixSpawn` (`:3023`) + `resolveExecutableForLaunch` (`:1069`), and `host/src/kernel.ts` `#hostWaitpid` (`:3593`) + `host-owned-process-reap.ts` — these are the exact spawn-launch + parked-wait + reap shapes to mirror natively.
- The SINGLE-THREADED pump is the crux: `host_waitpid` must NOT truly block (it would deadlock the loop that services the child). Model it as a parked op resolved when the child's channel reports exit — the same pattern the pump already uses for blocking poll/read.
- Do NOT implement execve/image-replacement here (I3c) or read spawn bytes from the VFS (I3b) — child bytes come from the `GuestOptions.programs` host map for I3a.
- Fixtures are SDK-built (build-fixtures.sh); the parent+child pair are new. Commit `.c` + `.wasm`.
