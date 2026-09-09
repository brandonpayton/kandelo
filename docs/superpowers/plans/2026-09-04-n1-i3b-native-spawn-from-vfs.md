# N1-I3b: Native host resolves the spawn child through the in-kernel VFS

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Checkbox (`- [ ]`) steps.

**Goal:** The native wasmtime host (`crates/host-native`) sources a
`posix_spawn` child's program bytes from the **in-kernel VFS** (the I1/I2
overlay + tmpfs + base image), resolved by path through the kernel's
exec-target authority — not from the host-side `GuestOptions.programs`
map that I3a used as a placeholder. A parent that `posix_spawn`s an
absolute path (e.g. `/bin/child`) launches the executable that lives at
that path in the VFS, with the kernel performing path resolution and the
`X_OK` permission check.

**Architecture (host-side-only; no kernel/ABI change — verified by
grounding):** The kernel already owns spawn-image resolution and exposes
it as host-callable exports. I3b replaces the `programs`-map lookup in
`handle_spawn` with the exec-target sequence **because it is the most
POSIX-compliant path** — `prepare` runs the `X_OK` permission check (a
non-executable file → `EACCES`) and `spawn_exec_commit` applies the
set-UID/set-GID credential transition and close-on-exec fd handling POSIX
requires of a spawn. (The Node host runs the same kernel exports; that is
a cross-check that this is the correct kernel-API sequence, NOT a reason to
mirror Node. Where POSIX-correctness and Node behavior diverge, follow
POSIX — e.g. treat `-EAGAIN` as a hard error here since N1 has no lazy
archives, rather than copying Node's archive-fetch retry.) Reference:
`host/src/exec-target.ts` `launchPreparedExecTarget`
`:389` + `readPreparedExecTarget` `:110`; `host/src/kernel-worker.ts`
`spawnExecTargetPrepare` `:8630` / `spawnExecCommit` `:9015`):
`kernel_spawn_exec_target_prepare(parent_pid, child_pid, path)` → a
positive **token** (resolved in the CHILD's namespace, with `X_OK`), then
`kernel_exec_target_size(child_pid, token)` + a
`kernel_exec_target_read(child_pid, token, offset, buf, len)` loop to pull
the bytes out of kernel memory, then `kernel_spawn_exec_commit(parent_pid,
child_pid, token)` to commit that target as the child's initial image,
then the existing `kernel_publish_spawn_child`. On any failure the token is
released with `kernel_exec_target_cancel(child_pid, token)` and the
child process-table entry is rolled back with `kernel_remove_process`
(the seam I3a's `-ECHILD` path already uses). Byte source works for BOTH
a base-image executable (bytes flow back through host-native's already-live
`host_blob_read` import) and an overlay-created executable (bytes copied
kernel-internally, no host callback) — no new host import.

**Tech Stack:** Rust + `wasmtime = "35"` (host-only, `--target <host>`),
Kandelo SDK for the C fixtures, `wasm-posix-shared`.

**Spec:** `docs/plans/2026-09-04-rust-first-remaining-purpose-framed.md`
§6 (N1 roadmap, I3 → sub-increment **I3b**).

## Global Constraints

- Worktree `/Users/brandon/kandelo-abi44-reconcile` (branch
  `brandonpayton/rust-first-abi44-reconcile`; PR #1350 head is
  `brandonpayton/epoll-kernel-route`). Dev-shell + isolated cache:
  `export KANDELO_SOURCE_CACHE_ROOT="$HOME/.cache/kandelo/reconcile-abi44"; scripts/dev-shell.sh bash -lc '<cmd>'`.
- Test: `cargo test -p host-native --target $(rustc -vV|sed -n 's/^host: //p')`
  (host target is `aarch64-apple-darwin`).
- **Host-side-only in `crates/host-native`.** NO change to
  `crates/kernel`, `crates/runtime-core`, `abi`, `crates/shared`. Uses
  ONLY existing kernel exports (`kernel_spawn_exec_target_prepare`,
  `kernel_exec_target_size`, `kernel_exec_target_read`,
  `kernel_spawn_exec_commit`, `kernel_exec_target_cancel`,
  `kernel_remove_process`) + the exports/imports I3a already wired.
- **The VFS is the source of truth.** Remove `GuestOptions.programs` and
  its resolution entirely; the I3a spawn tests are converted to place the
  child executable in the VFS base image and spawn it by its VFS path. Do
  NOT keep the host program map as a fallback — that would be a
  native-only shortcut the campaign explicitly rejects.
- **Scope: spawn-image bytes from the VFS + POSIX-correct spawn failures.**
  NO shebang/`#!` interpreter handling (that is I3d, via
  `kernel_exec_target_shebang`) — a `#!` script spawned here fails
  truthfully at the wasm-compile step as `ENOEXEC`. NO `execve`/
  image-replacement of a running process (that is I3c, via
  `kernel_exec_target_prepare`/`kernel_exec_commit`). `waitpid` reaping,
  the N-process pump, and the sandboxed in-memory VFS default are all
  unchanged from I1/I2/I3a.
- SDK-built fixtures committed (`.c` + `.wasm`). All pre-existing
  host-native tests stay green (17 today).

## Confirmed kernel contract (verified against source — do not re-derive)

- `kernel_spawn_exec_target_prepare(parent_pid: u32, child_pid: u32, path_ptr: usize, path_len: usize) -> i32`
  (`crates/kernel/src/wasm_api.rs:3066`). Resolves `path` in the CHILD's
  namespace at `AT_FDCWD`, flags `0`, retains the target, returns a
  positive token or `-errno`. Requires the child to exist with
  `ppid == parent_pid` (else `-ESRCH`). Empty path → `-ENOENT`. A
  non-executable file → `-EACCES` (the `X_OK`/search-path check lives
  inside `exec_target::prepare`).
- `kernel_exec_target_size(owner_pid: u32, target: u32) -> i64`
  (`:3104`). For a spawn-prepared target, **`owner_pid == child_pid`**
  (confirmed: `spawnExecCommit` calls `size(childPid, target)`,
  `kernel-worker.ts:9063`). Returns byte size or `-errno`.
- `kernel_exec_target_read(owner_pid: u32, target: u32, offset_lo: u32, offset_hi: i32, buffer_ptr: usize, buffer_len: usize) -> i32`
  (`:3116`). `owner_pid == child_pid`. Writes up to `buffer_len` bytes at
  the 64-bit `offset` INTO KERNEL LINEAR MEMORY at `buffer_ptr`; returns
  bytes written, `0` at EOF, or `-errno`. `-EAGAIN` means a backing lazy
  archive is still fetching — NOT reachable in N1 (no lazy archives;
  `host_fetch_archive` is trapped), so treat `-EAGAIN` as a hard error
  here rather than looping.
- `kernel_spawn_exec_commit(parent_pid: u32, child_pid: u32, target: u32) -> i32`
  (`:3245`). Commits the retained target as the child's initial image and
  CONSUMES the token (no cancel needed after a successful commit).
  `0` or `-errno`.
- `kernel_exec_target_cancel(owner_pid: u32, target: u32) -> i32`
  (`:3210`). `owner_pid == child_pid`. Releases a retained (uncommitted)
  target. `0` or `-errno`.
- `kernel_remove_process(pid: u32) -> i32` — the rollback seam I3a wired
  (`crates/kernel/src/wasm_api.rs:1970`).

## Confirmed native call-site (verified — do not re-derive)

- `handle_spawn` is at `crates/host-native/src/guest.rs:2983`. The
  `programs`-map resolution to REPLACE is at `guest.rs:3046-3053`
  (tries `path_str`, then decoded `argv0`, into `programs`). `path_str`
  is the raw `SYS_SPAWN` path argument; `argv_list`/`envp_list` come from
  `kernel_spawn_blob_decode`. The child pid comes from
  `kernel_spawn_process` (already called earlier in `handle_spawn`; grep
  the `spawn_process`/`child_pid` binding). `launch_process(...)` is the
  I3a helper that instantiates+starts the child from program bytes; its
  parameter list is at the I3a call site `guest.rs:3072-3086`.
- `GuestOptions.programs` is declared at `guest.rs:568-575`.
- I3a already binds the TypedFuncs it uses inside `handle_spawn`'s prologue
  (`guest.rs:2992-2998`) via `kernel.get_typed_func::<Args, Ret>(&mut kernel_store, "name")`;
  add the new exec-target funcs the same way.
- Reading kernel-memory bytes out / writing in uses the same
  `read_bytes`/`write_bytes` + `alloc_scratch` pattern I2 used to load the
  manifest (grep `alloc_scratch` in `guest.rs`; `handle_spawn` already
  receives an `alloc_scratch` closure parameter).

---

### Task 1: Source the spawn child's bytes from the VFS (happy path)

**Files:** Modify `crates/host-native/src/guest.rs` (replace the
`programs`-map lookup in `handle_spawn` with the exec-target byte flow;
add the exec-target TypedFuncs; add a `read_exec_target_bytes` helper;
delete `GuestOptions.programs` and the `programs` param threading);
Modify `crates/host-native/src/lib.rs` (convert the I3a spawn tests to
place the child in the VFS base image; drop `programs` from their setup).
Fixtures: reuse the existing `native_spawn_parent.c` / child from I3a but
ensure the parent spawns an ABSOLUTE VFS path.

**Interfaces:**
- Consumes: I3a's `handle_spawn` skeleton (`kernel_spawn_process` →
  child_pid, `launch_process`, `kernel_publish_spawn_child`,
  `kernel_remove_process`), I2's `BaseImage`/`build_base_image` +
  boot-time `kernel_rootfs_load_manifest`, the `alloc_scratch` closure +
  `read_bytes`/`write_bytes` helpers.
- Produces (for Task 2): a `read_exec_target_bytes(kernel_store, kernel_mem, size_fn, read_fn, alloc_scratch, owner_pid: u32, token: u32) -> anyhow::Result<Vec<u8>>` helper (name it exactly this in your report) that returns the full target bytes; and the established prepare→read→commit→publish ordering that Task 2's failure paths hook into.

- [ ] **Step 1: Write the failing test.** In `crates/host-native/src/lib.rs`,
  rewrite `smoke_spawn_launches_child` (and leave `smoke_spawn_waitpid`
  for Step 5's full-suite run) so the child executable is placed in the
  VFS instead of a `programs` map. Read the existing child fixture bytes
  (the `.wasm` I3a built — the one that writes `"child ok\n"` and
  `_exit(7)`), and add it to the `BaseImage` via `build_base_image` at an
  absolute path — e.g. entries: `/` (dir, ino 1), `/bin` (dir, ino 2),
  `/bin/child` (file, ino 3, mode `0o755`, bytes = child wasm). Run the
  parent fixture (which `posix_spawn`s the ABSOLUTE path `/bin/child`)
  with NO `programs` map, and assert the child's `"child ok"` appears in
  stdout. This will not compile/pass yet (Step 3 removes `programs` and
  wires the VFS read).

- [ ] **Step 2: Run RED.** `cargo test -p host-native --target <host> smoke_spawn_launches_child`.
  Expected: FAIL — either the test doesn't compile (no `programs` field /
  new base entry helper) or, once it compiles, the spawn resolves nothing
  from the VFS yet and the child never runs.

- [ ] **Step 3: Implement.**
  1. In `handle_spawn`, bind the new TypedFuncs alongside the existing
     ones (`guest.rs:2992` area):
     ```rust
     let spawn_exec_target_prepare = kernel
         .get_typed_func::<(u32, u32, u32, u32), i32>(&mut *kernel_store, "kernel_spawn_exec_target_prepare")?;
     let exec_target_size = kernel
         .get_typed_func::<(u32, u32), i64>(&mut *kernel_store, "kernel_exec_target_size")?;
     let exec_target_read = kernel
         .get_typed_func::<(u32, u32, u32, i32, u32, u32), i32>(&mut *kernel_store, "kernel_exec_target_read")?;
     let spawn_exec_commit = kernel
         .get_typed_func::<(u32, u32, u32), i32>(&mut *kernel_store, "kernel_spawn_exec_commit")?;
     let exec_target_cancel = kernel
         .get_typed_func::<(u32, u32), i32>(&mut *kernel_store, "kernel_exec_target_cancel")?;
     ```
     (Match the ptr/len ABI width host-native already uses for other
     `usize` args — I3a passes kernel pointers as `u32`; keep that.)
  2. DELETE the `programs`-map lookup at `guest.rs:3046-3053` and the
     `programs` field on `GuestOptions` (`:568-575`) plus every place it
     is threaded through `run_guest`/`handle_spawn`. The path to resolve
     is `path_str` (the spawn path arg); if it is empty, fall back to the
     decoded `argv0` for the resolve path string. Write the resolved
     path bytes into a scratch region in kernel memory (reuse the
     `alloc_scratch` + `write_bytes` pattern) so you can pass
     `(path_ptr, path_len)` to the kernel.
  3. Call `kernel_spawn_exec_target_prepare(parent_pid, child_pid, path_ptr, path_len)`.
     If the token is `< 0`, this is a resolution failure — roll back and
     fail (Task 2 hardens the full matrix; for Task 1 just do:
     `kernel_remove_process(child_pid)` best-effort, then
     `fail_spawn(..., -token)`), and RETURN.
  4. Read the bytes with the new helper:
     ```rust
     fn read_exec_target_bytes(
         kernel_store: &mut Store<...>,
         kernel_mem: &Memory,          // kernel linear memory
         size_fn: &TypedFunc<(u32, u32), i64>,
         read_fn: &TypedFunc<(u32, u32, u32, i32, u32, u32), i32>,
         scratch_ptr: u32,             // a pre-allocated kernel-mem scratch region
         scratch_len: u32,             // its length (chunk size, e.g. 65536)
         owner_pid: u32,               // == child_pid for spawn
         token: u32,
     ) -> anyhow::Result<Vec<u8>> {
         let size = size_fn.call(&mut *kernel_store, (owner_pid, token))?;
         if size < 0 { anyhow::bail!("exec_target_size failed: {size}"); }
         let total = size as usize;
         let mut out = Vec::with_capacity(total);
         let mut offset: i64 = 0;
         while (out.len() as i64) < size {
             let want = core::cmp::min(scratch_len as i64, size - offset) as u32;
             let n = read_fn.call(
                 &mut *kernel_store,
                 (owner_pid, token, offset as u32, (offset >> 32) as i32, scratch_ptr, want),
             )?;
             if n < 0 { anyhow::bail!("exec_target_read failed: {n}"); }
             if n == 0 { break; } // EOF
             let mut chunk = vec![0u8; n as usize];
             read_bytes(kernel_mem, kernel_store, scratch_ptr, &mut chunk); // copy OUT of kernel mem
             out.extend_from_slice(&chunk);
             offset += n as i64;
         }
         Ok(out)
     }
     ```
     (Adapt `read_bytes`'s exact signature to host-native's existing
     helper — the point is: kernel writes into `scratch_ptr`, you copy
     those `n` bytes out into `out`. Allocate `scratch_ptr` once via
     `alloc_scratch` with a fixed chunk size such as 64 KiB.)
  5. Feed `out` to `launch_process(...)` exactly as I3a fed the
     `programs` bytes (same parameter list, `guest.rs:3072`).
  6. Call `kernel_spawn_exec_commit(parent_pid, child_pid, token)` BEFORE
     `kernel_publish_spawn_child` and BEFORE launching would be fine too,
     but keep this order: prepare → read → **commit** → `launch_process`
     → `kernel_publish_spawn_child`. (Commit records the child's initial
     image/creds while the parent still exists; a successful commit
     consumes the token, so do NOT cancel after it.) If commit returns
     `< 0`, roll back: `kernel_remove_process(child_pid)` + `fail_spawn`.
  7. Leave `kernel_publish_spawn_child` + the I3a `-ECHILD` rollback +
     `wait_table.parent_of` insert + `pid_out` write exactly as they are.

- [ ] **Step 4: Run GREEN.** `cargo test -p host-native --target <host> smoke_spawn_launches_child`.
  Expected: PASS — the child launches from `/bin/child` in the VFS, no
  `programs` map.

- [ ] **Step 5: Convert the remaining spawn test + full suite.** Update
  `smoke_spawn_waitpid` the same way (child in the VFS base image at
  `/bin/child`, spawn the absolute path, assert `"child ok"` +
  `WEXITSTATUS==7`). Run the FULL suite:
  `cargo test -p host-native --target <host>` — expect the same count as
  before (17), all green, with the two spawn tests now VFS-backed and
  `programs` gone.

- [ ] **Step 6: Commit.** `git commit -m "Host-native: resolve the posix_spawn child through the in-kernel VFS (N1-I3b)"`

---

### Task 2: POSIX-correct spawn failures + no-leak rollback

**Files:** Modify `crates/host-native/src/guest.rs` (harden the
failure/rollback matrix in `handle_spawn`: prepare-failure,
size/read-failure, non-wasm bytes, commit-failure — each reports the
correct errno to the parent AND leaves no leaked kernel process-table
entry or retained exec target); Create
`crates/host-native/fixtures/native_spawn_badexec.c` if a distinct parent
fixture is needed (or parameterize the existing parent to spawn a
configurable path); Test in `crates/host-native/src/lib.rs`.

**Interfaces:**
- Consumes Task 1's prepare→read→commit→publish flow +
  `read_exec_target_bytes` + the `kernel_exec_target_cancel` /
  `kernel_remove_process` seams.
- Produces: a `handle_spawn` whose every failure path (a) reports a
  truthful errno to the parent via `fail_spawn`, (b) cancels a retained
  (uncommitted) target with `kernel_exec_target_cancel(child_pid, token)`,
  and (c) removes the child entry with `kernel_remove_process(child_pid)`
  — so a failed spawn leaks neither a zombie/pending child nor a retained
  target.

- [ ] **Step 1: Write the failing tests.** Add to `crates/host-native/src/lib.rs`:
  - `smoke_spawn_missing_path_enoent`: base image has `/bin` but NOT
    `/bin/nope`; parent `posix_spawn`s `/bin/nope`; assert the parent's
    `posix_spawn` reports `ENOENT` (the child never runs; the parent
    prints e.g. `spawn errno=2` and exits 0). The child pid must not
    linger — assert the run completes cleanly (no 30s pump timeout).
  - `smoke_spawn_non_executable_eacces`: base image has `/etc/data`
    (mode `0o644`, some bytes); parent spawns `/etc/data`; assert the
    parent reports `EACCES` (errno 13).
  - `smoke_spawn_not_wasm_enoexec`: base image has `/bin/notwasm`
    (mode `0o755`, bytes = `b"#!/bin/sh\necho hi\n"` or any non-wasm
    bytes); parent spawns `/bin/notwasm`; assert the parent reports
    `ENOEXEC` (errno 8) — the bytes read fine but `Module::new` rejects
    them.
  (Give the parent fixture a way to spawn a path passed via argv/env so
  one `.c` covers all three, OR add small dedicated fixtures. Whichever,
  commit `.c` + `.wasm`.)

- [ ] **Step 2: Run RED.** `cargo test -p host-native --target <host> smoke_spawn_missing_path_enoent smoke_spawn_non_executable_eacces smoke_spawn_not_wasm_enoexec`.
  Expected: FAIL — e.g. the non-wasm case currently `?`-propagates the
  `Module::new` error and `bail!`s the whole pump (a run error, not a
  clean `ENOEXEC` to the parent); the ENOENT/EACCES cases may already
  pass from Task 1's minimal prepare-failure handling but assert the
  clean-completion (no leak / no timeout) property.

- [ ] **Step 3: Implement.** In `handle_spawn`:
  1. **prepare returns `< 0`:** map `-token` to the errno; call
     `kernel_remove_process(child_pid)` (best-effort, log on failure);
     `fail_spawn(..., errno)`; return. (No target to cancel — prepare
     failed.)
  2. **`read_exec_target_bytes` errors, OR `Module::new(&bytes)` fails:**
     the target IS retained. Call
     `kernel_exec_target_cancel(child_pid, token)` (best-effort), then
     `kernel_remove_process(child_pid)` (best-effort), then
     `fail_spawn(..., ENOEXEC)` for the compile failure (mirror Node's
     `isWasmModuleBytes` → `ENOEXEC`, `exec-target.ts:453`) or the
     mapped errno for a read error; return. Wrap `Module::new` so its
     error becomes `ENOEXEC` rather than a pump `bail!`.
  3. **commit returns `< 0`:** the child was NOT launched yet (commit is
     before `launch_process` per Task 1 ordering) — the token is consumed
     by a successful commit but on FAILURE it may still be retained;
     cancel best-effort, `kernel_remove_process(child_pid)`,
     `fail_spawn(..., -commit)`; return.
  Use the existing `libc_errno::{ENOENT, EACCES, ENOEXEC}` constants
  host-native already imports; the errno for prepare/read/commit failures
  is `-result` (they return `-errno`).

- [ ] **Step 4: Run GREEN.** Re-run the three new tests + the full suite
  `cargo test -p host-native --target <host>` — expect all green (20
  total: 17 prior + 3 new). Confirm none of the failure tests hit the 30s
  pump cap (a leaked child channel would cause that).

- [ ] **Step 5: Commit.** `git commit -m "Host-native: POSIX-correct spawn failures + no-leak rollback (N1-I3b)"`

---

## Notes for the executor

- The authoritative reference for the whole sequence is
  `host/src/exec-target.ts` (`readPreparedExecTarget` `:110`,
  `launchPreparedExecTarget` `:389`) and `host/src/kernel-worker.ts`
  (`spawnExecTargetPrepare` `:8630`, `spawnExecCommit` `:9015`, which
  proves `owner_pid == child_pid` via `size(childPid, target)` at
  `:9063`). Read them; do not invent the ordering.
- `kernel_exec_target_read` writes into KERNEL linear memory at
  `buffer_ptr` (`wasm_api.rs:3133`) — allocate a kernel-memory scratch
  region (host-native's `alloc_scratch`) and copy the bytes OUT into your
  host `Vec`, the mirror of I2's manifest write-IN pattern.
- Do NOT implement `#!` shebang (`kernel_exec_target_shebang`) — that is
  I3d. A `#!` file spawned in I3b correctly fails `ENOEXEC` at
  `Module::new`. Do NOT implement `execve` image replacement
  (`kernel_exec_target_prepare`/`kernel_exec_commit` on a running process)
  — that is I3c.
- Removing `GuestOptions.programs` is intentional and required: the VFS is
  the single source of truth. If some other test or caller still
  references `programs`, update it to place its program in the VFS base
  image instead.
- Fixtures are SDK-built (`fixtures/build-fixtures.sh`); commit `.c` +
  `.wasm`. The child fixture is the I3a one (writes `"child ok\n"`,
  `_exit(7)`); the parent must spawn an ABSOLUTE VFS path and, for Task 2,
  be able to spawn a configurable path + print the `posix_spawn` errno.
