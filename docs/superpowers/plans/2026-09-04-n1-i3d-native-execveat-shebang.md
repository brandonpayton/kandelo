# N1-I3d: Native execveat + kernel-owned `#!` shebang resolution

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Checkbox (`- [ ]`) steps.

**Goal:** Complete the native exec/spawn family: (1) `execveat` (done — Task 1), and (2) `#!` shebang support where the **kernel** owns the whole resolution (decode + interpreter retarget + one-level limit + argv-prefix assembly) and the native host keeps only the irreducible byte-fetch / wasm-instantiate / commit / launch. A `#!/interp [arg]` script run via spawn, execve, or execveat launches the interpreter with argv `[interp, arg?, script_path, orig_argv[1..]]`; a script whose interpreter is itself a script is `ENOEXEC`.

**Architecture:** The `#!` decode is already Rust-owned in the kernel (`crates/runtime-core/src/exec_target.rs:287` `parse_shebang`). This increment adds a kernel function that RESOLVES the shebang chain — given a prepared (possibly-script) target token, if it is a script the kernel cancels the script target, prepares the interpreter in-process (same owner, `AT_FDCWD`), enforces the one-level limit, and returns the final interpreter token + the argv prefix `[interp, arg?, script_path]` — exposed as a new additive kernel export `kernel_exec_target_resolve_shebang`. The native host, after `prepare`, calls this once and then does only `size`/`read` → `Module::new` → `commit` → `launch_process` with `prefix + orig_argv[1..]`. This is the campaign-correct altitude: the interpreter-retarget orchestration (previously host-side in Node's TS and in a discarded host-only draft) moves INTO the kernel; the host's shebang-specific logic drops to ≈zero. **This is a kernel + `runtime-core` + `abi/snapshot.json` change** (additive; ABI 44 is in dev, so regenerate the snapshot — the drift gate's `dump-abi --classify-compat` confirms a new export is additive, no `ABI_VERSION` bump). Kept additive so the Node host's existing TS shebang path is untouched (ripping it out is a documented follow-up, not part of this increment).

**Tech Stack:** Rust (kernel + runtime-core), `wasmtime = "35"` (host-native), Kandelo SDK for the C fixtures.

**Spec:** `docs/plans/2026-09-04-rust-first-remaining-purpose-framed.md` §6 (N1 roadmap, I3 → I3d). Last increment before the **I4 checkpoint**.

## Global Constraints

- Worktree `/Users/brandon/kandelo-abi44-reconcile` (branch `brandonpayton/rust-first-abi44-reconcile`; PR #1350 head = `brandonpayton/epoll-kernel-route`). Dev-shell + isolated cache: `export KANDELO_SOURCE_CACHE_ROOT="$HOME/.cache/kandelo/reconcile-abi44"; scripts/dev-shell.sh bash -lc '<cmd>'`.
- Test: `cargo test -p host-native --target $(rustc -vV|sed -n 's/^host: //p')` (host `aarch64-apple-darwin`); kernel/runtime-core: `cargo test -p wasm-posix-runtime-core` (+ `-p kandelo-kernel` as relevant).
- **Kernel-owned resolution is the point.** The interpreter retarget + one-level limit + argv-prefix assembly live in `crates/runtime-core`/`crates/kernel`, NOT the host. The host must NOT reimplement shebang orchestration.
- **ABI:** adding `kernel_exec_target_resolve_shebang` is additive. Regenerate `abi/snapshot.json` (`scripts/check-abi-version.sh update`) and commit it; do NOT bump `ABI_VERSION` (44, unreleased; the change is additive/compatible — verify via the check script's classifier). Rebuild `local-binaries/kernel.wasm` so host-native loads a kernel that exports the new symbol.
- **POSIX correctness is the goal**, Node is a sequencing cross-check only. Preserve the I3c exec success/failure asymmetry and the I3b spawn rollback through the shebang step (a shebang-stage failure — bad interpreter, nested script — is an exec/spawn failure reported the same way).
- Scope: one-level `#!` only (kernel-enforced `ENOEXEC` beyond). NOT in scope: the multi-threaded-execve gap, the thread-reclamation fix (I4-checkpoint items), and ripping out Node's now-redundant TS shebang (follow-up). Do NOT enable wasmtime epoch/fuel.
- SDK fixtures committed (`.c` + `.wasm`). All pre-existing host-native tests stay green (25 today).

## Confirmed facts (verified — do not re-derive)

- Kernel primitives in `crates/runtime-core/src/exec_target.rs`: `prepare(proc, locks, host, owner, dirfd, path, flags) -> Result<u32,Errno>` (:492); `shebang(proc, host, owner_pid, token) -> Result<Option<Shebang>,Errno>` (:608, decodes via `parse_shebang`); `cancel(proc, locks, host, owner_pid, token)` (:636); `size`/`read` (:561/:567); the `PreparedExecLedger` (`take`/`get`/`insert`, :338); `PreparedExecTarget::owner()` and its `diagnostic_path` (add a `pub fn diagnostic_path(&self) -> &[u8]` accessor if none exists). `Shebang { interpreter: String, argument: Option<String> }` (:238).
- `resolve_shebang` leaves NO retained target on ANY error: on a script it `cancel`s the script token BEFORE preparing the interpreter; if the interpreter `prepare` fails it returns that errno (nothing retained); if the interpreter is itself a script it `cancel`s the interpreter token and returns `ENOEXEC`. On success it retains exactly one token (interpreter for a script, or the original for a non-script).
- Owner is read from the script target (`target.owner()`) so the interpreter target is prepared with the SAME owner (Process or Spawn) → `commit` validates correctly. Interpreter path is prepared at `AT_FDCWD`, flags 0 (interpreters are absolute).
- host-native loads `local-binaries/kernel.wasm` (`crates/host-native/src/lib.rs:220` `kernel_wasm_path`). The new export must be in that artifact for the native tests to bind it.
- The native exec path is `handle_exec_common` (guest.rs, from Task 1, shared by execve+execveat); the spawn path is `handle_spawn` (I3b). Both call `prepare` then `read_exec_target_bytes` → `Module::new` → commit → launch. The resolve call slots in right after `prepare`.

---

### Task 1: execveat (SYS_EXECVEAT) — DONE

Committed `f0696f6f2`. `handle_exec_common` shared by `SYS_EXECVE` (AT_FDCWD, flags 0) and `SYS_EXECVEAT` (real dirfd/flags); 25/25. No further work.

---

### Task 2: Kernel-owned shebang resolution (`kernel_exec_target_resolve_shebang`)

**Files:** Modify `crates/runtime-core/src/exec_target.rs` (add `resolve_shebang` + a `ShebangArgvPrefix`/`ResolvedShebang` type + the `diagnostic_path` accessor if missing); Modify `crates/kernel/src/wasm_api.rs` (add the `#[unsafe(no_mangle)] pub extern "C" fn kernel_exec_target_resolve_shebang` export near the other exec-target exports ~:3158); regenerate `abi/snapshot.json`; rebuild `local-binaries/kernel.wasm`. Test: a `runtime-core` unit test.

**Interfaces (Produces, for Task 3):**
- `kernel_exec_target_resolve_shebang(owner_pid: u32, token: u32, out_ptr: usize, out_len: usize) -> i64`. Resolves the retained target `token`. Writes a record to `out_ptr` and returns the record byte length (>0), or `-errno` (`< 0`), incl. `-ENOEXEC` for a nested script and `-EOVERFLOW` if `out_len` is too small. Record format (LE):
  `[kind: u8][final_token: u32]` then, only if `kind==1` (script): `[has_arg: u8][interp_len: u32][arg_len: u32][script_path_len: u32][interp bytes][arg bytes][script_path bytes]`. `kind==0` (not a script) → just `[0][final_token]` (final_token == input token). Name the record layout in your report.

- [ ] **Step 1: Write the failing test.** In `crates/runtime-core/src/exec_target.rs` tests (mirror the existing `parse_shebang`/`prepare` unit-test harness in that file), add a test that: builds a process with a rootfs overlay containing `/usr/bin/script` = `b"#!/bin/interp scriptarg\n..."` and `/bin/interp` = valid bytes; `prepare`s `/usr/bin/script`; calls `resolve_shebang`; asserts it returns a `ResolvedShebang` whose `final_token` is a DIFFERENT retained token that is NOT a script, with `prefix = Some { interpreter: "/bin/interp", argument: Some("scriptarg"), script_path: b"/usr/bin/script" }`, and that the original script token is gone from the ledger. Add a second case: `/usr/bin/script2` whose interpreter is itself a `#!` script → `resolve_shebang` returns `Err(ENOEXEC)` and leaves the ledger empty (no leak). (If the in-file test harness cannot mount an overlay easily, use the same fixture pattern the existing exec_target prepare/shebang tests use — match that file's conventions.)
- [ ] **Step 2: RED** — `cargo test -p wasm-posix-runtime-core resolve_shebang` (fn doesn't exist).
- [ ] **Step 3: Implement.**
  - Add `pub fn diagnostic_path(&self) -> &[u8]` to `PreparedExecTarget` if not present.
  - Add `resolve_shebang(proc, locks, host, owner_pid, token) -> Result<ResolvedShebang, Errno>`:
    1. `match shebang(proc, host, owner_pid, token)? { None => Ok(ResolvedShebang { final_token: token, prefix: None }), Some(sb) => { ... } }`.
    2. Script case: capture `owner = get(token)?.owner()` and `script_path = get(token)?.diagnostic_path().to_vec()`. `cancel(proc, locks, host, owner_pid, token)?` (releases the script target — its set-ID is never committed). `let interp_token = prepare(proc, locks, host, owner, AT_FDCWD, sb.interpreter.as_bytes(), 0)?;` One-level limit: `if shebang(proc, host, owner_pid, interp_token)?.is_some() { cancel(proc, locks, host, owner_pid, interp_token)?; return Err(Errno::ENOEXEC); }`. `Ok(ResolvedShebang { final_token: interp_token, prefix: Some(ShebangArgvPrefix { interpreter: sb.interpreter, argument: sb.argument, script_path }) })`.
  - Add the `wasm_api.rs` export: validate `out_ptr`/`out_len` like the other exec-target exports (EFAULT/EOVERFLOW checks mirroring `kernel_exec_target_shebang` at :3158), call `crate::exec_target::resolve_shebang`, serialize the record into kernel memory at `out_ptr`, return the length or `-errno`. Reuse `WasmHostIO` + the `PROCESS_TABLE`/advisory-lock access pattern the sibling exports use.
- [ ] **Step 4: GREEN** — `cargo test -p wasm-posix-runtime-core resolve_shebang` + the full runtime-core/kernel suites green (no regression).
- [ ] **Step 5: Rebuild + snapshot.** Rebuild `local-binaries/kernel.wasm` through the repo's kernel build+install path (find it: the artifact is "produced by `install_local_binary kernel`"; use the dev-shell kernel build then `scripts/install-local-binary.sh`, or `./run.sh local-build` if that refreshes it). Regenerate the ABI snapshot: `scripts/dev-shell.sh bash -lc 'scripts/check-abi-version.sh update'` and confirm it reports the new export as an additive/compatible drift (NO `ABI_VERSION` bump). Verify host-native still loads the kernel: `cargo test -p host-native --target <host> smoke_loads_real_kernel_and_reads_abi`. Commit `abi/snapshot.json`.
- [ ] **Step 6: Commit.** `git commit -m "Kernel: resolve #! shebang chains in the kernel (kernel_exec_target_resolve_shebang) (N1-I3d)"` (include `abi/snapshot.json` + the rebuilt `local-binaries/kernel.wasm` if the repo tracks it; if `local-binaries/` is gitignored, note that in the report).

---

### Task 3: Native host uses kernel shebang resolution (execve, execveat, spawn)

**Files:** Modify `crates/host-native/src/guest.rs` (bind `kernel_exec_target_resolve_shebang`; add a small `apply_shebang(owner_pid, token, orig_argv) -> Result<(u32 final_token, Vec<Vec<u8>> launch_argv), i32>` host helper that calls the export, decodes the record, and returns `final_token` + `[interp, arg?, script_path] + orig_argv[1..]` (or `(token, orig_argv)` if `kind==0`); call it right after `prepare` in BOTH `handle_exec_common` and `handle_spawn`). Create `crates/host-native/fixtures/native_interp.c` (already drafted, untracked — an interpreter that prints its argv) + `#!` script files placed in the BaseImage. Test in `crates/host-native/src/lib.rs`.

**Interfaces:** Consumes Task 2's export. The host helper does NO shebang decision logic beyond decoding the record + concatenating argv — all resolution/one-level/errno is the kernel's.

- [ ] **Step 1: Write the failing tests.** Build `native_interp.c` (prints `argv[i]` one per line, `_exit(0)`) → `/bin/interp` (0o755) in the BaseImage; a `#!` script `/usr/bin/script` = `b"#!/bin/interp scriptarg\n...\n"` (0o755). Tests:
  - `smoke_execve_shebang`: parent execve's `/usr/bin/script`; assert the interpreter ran with argv `["/bin/interp","scriptarg","/usr/bin/script"]`.
  - `smoke_spawn_shebang`: parent posix_spawns `/usr/bin/script`; assert same argv + the child is reaped (exit 0).
  - `smoke_execve_shebang_nested_enoexec`: a script whose interpreter is itself `#!` → the caller observes `ENOEXEC` (errno 8) and survives.
- [ ] **Step 2: RED** — run them (today `Module::new` on `#!` bytes → the exec/spawn reports `ENOEXEC`; the interpreter never runs).
- [ ] **Step 3: Implement.** Bind `kernel_exec_target_resolve_shebang` as a TypedFunc `(u32,u32,u32,u32)->i64`. Add `apply_shebang(owner_pid, token, orig_argv)`: alloc a scratch out buffer (8 KiB), call the export; `< 0` → return the errno; decode `[kind][final_token]...`; if `kind==0` → `Ok((final_token, orig_argv.clone()))`; if `kind==1` → decode `[has_arg][interp_len][arg_len][script_path_len][interp][arg][script_path]`, build `launch_argv = [interp] + (arg if has_arg) + [script_path] + orig_argv[1..]`, `Ok((final_token, launch_argv))`. In `handle_exec_common` and `handle_spawn`, after `prepare`→`token`, call `apply_shebang(owner_pid, token, &argv)`; on `Err(errno)` take the existing exec-failure / spawn-failure path (the kernel already released all tokens, so do NOT cancel); on `Ok((final_token, launch_argv))`, use `final_token` for `read_exec_target_bytes`/`Module::new`/commit and `launch_argv` for `launch_process`. `owner_pid` = the exec'ing pid (exec) or child pid (spawn).
- [ ] **Step 4: GREEN** — all three tests + full suite (28: 25 + 3). No 30s-cap hangs.
- [ ] **Step 5: Commit.** `git commit -m "Host-native: use kernel shebang resolution for execve/execveat/spawn (N1-I3d)"`

---

## Notes for the executor
- The kernel owns ALL shebang decision logic (decode, interpreter retarget, one-level limit, argv-prefix assembly). The host helper only decodes the record + concatenates `orig_argv[1..]` — if you find yourself re-deciding "is this a script" or re-preparing an interpreter host-side, stop: that belongs in `resolve_shebang`.
- `resolve_shebang` must leave the ledger with exactly one retained token on success and ZERO on any error (cancel-before-prepare for the script; cancel the interpreter on the nested-script `ENOEXEC`). Get this right so the host never leaks or double-cancels.
- Preserve the exec success/failure asymmetry (I3c) and spawn rollback (I3b): a shebang-stage `Err` is an exec/spawn failure — exec completes the channel with the errno (caller resumes); spawn does `fail_spawn` + `kernel_remove_process`. Since the kernel released all tokens on error, the host cancels nothing extra there.
- Rebuilding `local-binaries/kernel.wasm` is required (host-native loads it) and is build-heavy — that is expected and endorsed. Regenerate `abi/snapshot.json` and confirm the classifier calls the new export additive (no `ABI_VERSION` bump).
- Do NOT rip out Node's TS shebang (`host/src/exec-target.ts:406-450`) — that is a follow-up; keep it working (additive kernel export).
- Fixtures SDK-built (`fixtures/build-fixtures.sh`); commit `.c` + `.wasm`.
