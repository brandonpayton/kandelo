# N1-I1 (re-scoped): Native host sandboxed in-memory VFS + argv + native-dir mount

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Checkbox (`- [ ]`) steps.
> **Supersedes** `2026-09-04-n1-i1-native-real-fs-argv.md` (whose real-host-dir-as-default approach was reverted — commit 0a1fd735a reverted by 84d3b4894 — after the user clarified the native host must default to a sandboxed in-memory VFS, not the real host FS).

**Goal:** The native wasmtime host (`crates/host-native`) defaults to a **sandboxed in-memory virtual filesystem** — the same model as the Node/browser hosts — and reaches **parity with Node's native-directory mount** capability. A guest gets an empty writable in-memory `/` + `tmpfs` scratch dirs by default (no host FS), real `argv`/`environ`, and can have a native host directory **explicitly mounted** at a VFS point.

**Architecture (all host-side-only; no kernel/ABI change — verified by grounding):** Phase 5 already made the kernel own the FS (`crates/runtime-core/src/rootfs.rs` overlay + `tmpfs.rs`), both toggled by kernel exports. The overlay creates `/` lazily and stores overlay-created files **inline** (`Regular(Vec<u8>)`), so with the overlay enabled and no manifest, `host_blob_read`/`host_fetch_archive` are never called and `host_open` is never reached — a fully sandboxed empty in-memory `/`. Native-dir mounts use the existing **foreign-prefix** mechanism (`kernel_rootfs_set_foreign_prefixes` → overlay disowns that subtree → dispatch falls through to `host_open`), exactly as Node's `HostFileSystem`/`extraMounts` do; the native host reuses a mount-prefix-aware `HostFs` as the backend.

**Tech Stack:** Rust + `wasmtime = "35"` (host-only crate; `--target <host>`), the Kandelo SDK for C fixtures, `wasm-posix-shared`.

**Spec:** `docs/plans/2026-09-04-rust-first-remaining-purpose-framed.md` §6 (N1 roadmap, increment I1) + the mount-mechanism grounding.

## Global Constraints

- Worktree `/Users/brandon/kandelo-abi44-reconcile` (branch `brandonpayton/rust-first-abi44-reconcile`). Dev-shell + isolated cache: `export KANDELO_SOURCE_CACHE_ROOT="$HOME/.cache/kandelo/reconcile-abi44"; scripts/dev-shell.sh bash -lc '<cmd>'`.
- host-native is host-only: `cargo test -p host-native --target $(rustc -vV|sed -n 's/^host: //p')`. Needs `local-binaries/kernel.wasm` (build if tests skip).
- **Host-side-only in `crates/host-native`.** No `crates/kernel`/`runtime-core`/`abi/` changes. The kernel exports/imports used already exist: `kernel_set_rootfs_enabled`, `kernel_set_tmpfs_enabled`, `kernel_set_rootfs_now`, `kernel_rootfs_set_foreign_prefixes`, `kernel_rootfs_load_manifest` (`crates/kernel/src/wasm_api.rs:1494-1559`).
- **Sandboxed by default:** the in-memory overlay/tmpfs is the default `/`; `host_blob_read`/`host_fetch_archive` stay trap-stubbed (never called); the real host FS is reachable ONLY through an explicit mount (T3). No un-mounted native-FS access.
- SDK-built fixtures committed (`.c` + `.wasm`) via `crates/host-native/fixtures/build-fixtures.sh`. All pre-existing host-native tests stay green.

---

### Task 1 (I1a): In-memory VFS as the default + argv/env

**Files:** Modify `crates/host-native/src/guest.rs` (boot sequence in/around `run_trivial_guest`/`run_guest_with_fs` `:475`/`:506`; the `kernel_get_argc`/argv/environ stubs `:787`+); Create `crates/host-native/fixtures/native_vfs.c` (+ `.wasm`); Test in `crates/host-native/src/lib.rs`.

**Interfaces:** Produces a boot entry point that enables the in-kernel overlay + tmpfs (empty in-memory VFS) and populates argv/env — the default run path. Name it in your report (T3 adds a mount to it).

- [ ] **Step 1: Write the failing test.** `native_vfs.c`: a program that `mkdir("/data")`, `open("/data/f", O_CREAT|O_RDWR)`, writes bytes, `lseek`+reads them back, and also writes+reads a file under `/tmp` (tmpfs), printing a deterministic summary. Also print `argc` + `argv[1]`. Build to `.wasm`. `#[test] smoke_runs_inmemory_vfs`: run it via the boot entry point with `argv=["prog","hello"]` and **no host directory**, asserting the summary (round-tripped file contents from both `/` and `/tmp`) + argc/argv + exit 0.

- [ ] **Step 2: Run RED.** `cargo test -p host-native --target <host> smoke_runs_inmemory_vfs`. Expected: FAIL — today the overlay/tmpfs are not enabled at boot (so `/data` create hits the `host_open` fallback / fake FS, not an in-memory overlay), and `argc` is 0.

- [ ] **Step 3: Implement.** In the boot sequence, after kernel instantiation and process creation but before dispatch, resolve + call (via the existing `get_typed_func`/`call` pattern used for the other `kernel_*` exports): `kernel_set_rootfs_now(sec,nsec)`, `kernel_set_tmpfs_enabled(1)`, `kernel_set_rootfs_enabled(1)`. Do NOT load a manifest or install a blob provider (leave `host_blob_read`/`host_fetch_archive` trapped). The fake-file `HostFs` is no longer the default `/` source (the overlay is) — reduce `HostFs` to its stdin/fd-0 duties (keep the blocking-stdin behavior) or gate it behind T3's mount. Wire argv/env: implement `kernel_get_argc`, `kernel_argv_read`, `kernel_environ_count`, `kernel_environ_get` from a caller-supplied argv/env (drop the `->0` fallbacks at `guest.rs:787`); verify the read contract against `crates/kernel`/`wasm-posix-shared` + how the TS host serves it.

- [ ] **Step 4: Run GREEN** (same command). Then full host-native suite green (the pre-existing tests must still pass — some may need the overlay enabled too; adjust their setup, don't delete coverage).

- [ ] **Step 5: Commit.** `git commit -m "Host-native: sandboxed in-memory VFS default (overlay + tmpfs) + argv/env (N1-I1a)"`

---

### Task 2 (I1b): Explicit native-directory mount (parity with Node's HostFileSystem)

**Files:** Modify `crates/host-native/src/guest.rs` (a mount descriptor + register foreign prefix + mount-prefix-aware `HostFs`; re-add the FS-syscall impls from reverted commit 0a1fd735a, scoped to the mount); Create `crates/host-native/fixtures/native_mount.c` (+ `.wasm`); Test in `lib.rs`.

**Interfaces:** Consumes T1's boot entry point; adds an optional mount descriptor `{ mount_point: String (e.g. "/host"), host_dir: PathBuf, readonly? }` (analogous to Node's `extraMounts` `{mountPoint,hostPath}`).

- [ ] **Step 1: Write the failing test.** `native_mount.c`: a program that reads a file at `/host/greeting.txt` and prints it. Build to `.wasm`. `#[test] smoke_runs_native_dir_mount`: create a temp dir with `greeting.txt`, run the fixture with a mount `{mount_point:"/host", host_dir:<temp>}`, assert stdout == the file contents + exit 0. (Use a TOP-LEVEL mount point `/host` so no overlay parent-dir seeding is needed.)

- [ ] **Step 2: Run RED.** `cargo test -p host-native --target <host> smoke_runs_native_dir_mount`. Expected: FAIL — `/host` isn't a foreign prefix, so the overlay claims it → `/host/greeting.txt` ENOENTs (not routed to the host dir).

- [ ] **Step 3: Implement.** When a mount descriptor is provided: (a) re-add the real-dir `HostFs` FS-syscall impls from commit 0a1fd735a (`git show 0a1fd735a -- crates/host-native/src/guest.rs` for `host_open`/`read`/`pread`/`stat`/`lstat`/`fstat`/`close`/`seek`/`opendir`/`readdir`/`closedir`/`readlink` — INCLUDING the `host_readdir` doc-comment fix the review flagged: state the real ERANGE/entry-loss divergence, don't claim the TS host's `pendingDirectoryEntries` behavior) but make `HostFs` **mount-prefix-aware** — carry `mount_point`, and in `resolve` strip that prefix from the incoming VFS path before joining onto `host_dir` (mirrors Node's `HostFileSystem(hostPath, mountPoint)`); (b) call `kernel_rootfs_set_foreign_prefixes(b"<mount_point>\0")` at boot so the overlay disowns the subtree; (c) route the FS `host_*` imports to this mount-aware `HostFs` for paths under the mount (and to nothing/trap otherwise, since the overlay owns the rest). Keep it a top-level mount (no nested-parent seeding) for this increment.

- [ ] **Step 4: Run GREEN** (same command) + full suite green.

- [ ] **Step 5: Commit.** `git commit -m "Host-native: explicit native-directory mount at parity with Node (foreign-prefix + mount-aware HostFs) (N1-I1b)"`

---

## Notes for the executor

- Read the mount routing in `crates/runtime-core/src/syscalls.rs` (`namespace_lstat_raw:2075`, the tmpfs→rootfs→host_open ladder ~`:2133-2141`) and `rootfs.rs` `ForeignMounts` (`:464-548`) to confirm the foreign-prefix routing; read Node's `host/src/vfs/host-fs.ts` + `node-kernel-worker-entry.ts:1116-1217` for the parity reference (mount spec, foreign-prefix wiring, `configureRootfsOverlay`).
- The empty-overlay default calls NO manifest and NO blob provider — if you find yourself needing `host_blob_read`, stop: that's I2 (real VFS image), not I1.
- Argv read contract + (for T2) dirent/stat/readlink layouts: verify against the shared ABI / TS host, don't guess (a wrong byte layout fails silently-ish).
