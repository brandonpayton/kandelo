> **SUPERSEDED (2026-09-04).** This plan's real-host-directory-as-default
> approach was wrong (the native host must default to a sandboxed in-memory
> VFS). Its Task 1 was implemented (commit 0a1fd735a) and then REVERTED
> (84d3b4894). Replaced by
> `2026-09-04-n1-i1-native-inmemory-vfs.md`. Kept for history only.

# N1-I1: Native host real filesystem + argv/env — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Make the native wasmtime host (`crates/host-native`) serve a real host
*directory* (not a single hardcoded file) and populate real `argv`/`environ`, so
a guest can open/list/stat arbitrary files, follow symlinks, seek, and read its
arguments — the capability breadth every real program needs and the prerequisite
for I2 (rootfs overlay) and I3 (spawn/exec).

**Architecture:** `crates/host-native` boots the real `kernel.wasm` and runs
guests through a channel pump (`src/guest.rs`); its `HostIO` `host_*` imports are
implemented in `define_kernel_host_imports` (`guest.rs:494`). Today the FS is a
single fixed file (`HostFs`, `guest.rs:186`; `/native.txt`, `:174`) and `argv` is
hard-zeroed (`kernel_get_argc` returns 0, `guest.rs:787`, forcing crt1's "a.out"
fallback). I1 replaces `HostFs` with a real directory-rooted backend, implements
the currently-trapped FS syscalls (`host_opendir`/`readdir`/`closedir`,
`host_seek`, `host_readlink`) and generalizes the existing ones
(`host_open`/`read`/`pread`/`stat`/`lstat`/`fstat`/`close`) to resolve paths
under a root `std::path::Path`, and wires `argv`/`environ` from a caller-supplied
list. Each capability is proven by a purpose-built SDK fixture (the host-native
convention: a `.c` in `crates/host-native/fixtures/` built to `.wasm` via
`build-fixtures.sh`, driven by a `#[test]` through `run_trivial_guest`).

**Tech Stack:** Rust + `wasmtime = "35"` (host-only crate; build/test with
`--target <host-triple>`), the Kandelo SDK (`sdk/`) to compile C fixtures to
wasm32, `wasm-posix-shared` (authoritative ABI).

**Spec:** `docs/plans/2026-09-04-rust-first-remaining-purpose-framed.md` §6 (N1
roadmap, increment I1) + the N1 grounding.

## Global Constraints

- **Worktree:** `/Users/brandon/kandelo-abi44-reconcile` (branch
  `brandonpayton/rust-first-abi44-reconcile`).
- **Everything runs in the dev-shell with the isolated cache:**
  `export KANDELO_SOURCE_CACHE_ROOT="$HOME/.cache/kandelo/reconcile-abi44"; scripts/dev-shell.sh bash -lc '<cmd>'`
- **host-native is host-only:** build/test with
  `cargo test -p host-native --target $(rustc -vV | sed -n 's/^host: //p')`
  (the workspace defaults to a wasm target; without `--target` it fails to build
  Cranelift). Tests need `local-binaries/kernel.wasm` present — build it if the
  tests skip (`scripts/dev-shell.sh bash -lc 'cargo build --release -p kandelo -Z build-std=core,alloc'` then install to `local-binaries/kernel.wasm`; the test's skip hint at `crates/host-native/src/lib.rs:238` shows the exact steps).
- **Fixtures are SDK-built + committed:** add `crates/host-native/fixtures/<name>.c`,
  build via `crates/host-native/fixtures/build-fixtures.sh` (or the SDK `cc`),
  commit both the `.c` and the resulting `.wasm` (matching the 8 existing
  fixtures). Fixture builds go through the normal SDK/libc path — no bespoke
  toolchain.
- **No kernel/ABI change:** I1 is purely additive host-capability impls
  (replacing traps) + FS/argv wiring in `crates/host-native`. Do not touch
  `crates/kernel`, `crates/runtime-core`, or `abi/`.
- **Truthful boundary preserved:** methods still genuinely unsupported stay
  trapped (`define_unknown_imports_as_traps`); do not stub them to fake success.
- **No product regression:** the 8 existing host-native tests must stay green.

---

### Task 1: Real host-directory-backed filesystem

**Files:**
- Modify: `crates/host-native/src/guest.rs` (`HostFs` `:186`, its impls, the FS
  arms of `define_kernel_host_imports` `:494`, and `run_trivial_guest`'s FS setup)
- Create: `crates/host-native/fixtures/native_realfs.c` (+ built `.wasm`)
- Test: a `#[test]` in `crates/host-native/src/lib.rs` (the `mod tests`)

**Interfaces:**
- Consumes: the existing pump + `run_trivial_guest` machinery.
- Produces (for Task 2 + later increments): a `HostFs` rooted at a real
  `std::path::PathBuf` with real `host_open/read/pread/lseek/close/stat/lstat/
  fstat/opendir/readdir/closedir/readlink` over that tree; and a
  `run_trivial_guest` (or a new sibling `run_guest_with_fs`) that accepts a
  host-directory root. Name the entry point and its signature explicitly in your
  report so Task 2 threads argv through the same entry point.

- [ ] **Step 1: Write the failing test.** Add `native_realfs.c`: a program that
  `open`s a file by path under a root, `read`s it, `lseek`s and re-reads, opens a
  directory and iterates entries (`getdents64`), `readlink`s a symlink, and
  writes a deterministic summary to stdout (e.g. the file contents, the sorted
  dir entry names, the symlink target). Build it to `.wasm`. Add a `#[test]
  smoke_runs_real_host_fs` that creates a temp dir with a known file, a
  subdirectory with 2 files, and a symlink, runs the fixture via the FS-rooted
  entry point pointed at that temp dir, and asserts stdout equals the expected
  summary + exit 0.

- [ ] **Step 2: Run RED.**
  `cargo test -p host-native --target $(rustc -vV|sed -n 's/^host: //p') smoke_runs_real_host_fs`
  Expected: FAIL — the trapped `host_opendir`/`readdir`/`readlink`/`seek` abort
  (or the FS still serves only `/native.txt`), so the fixture can't list/seek/
  readlink.

- [ ] **Step 3: Implement.** Replace `HostFs` (`guest.rs:186`) with a
  directory-rooted backend: a `root: PathBuf`, open-handle table mapping host
  handles → `(std::fs::File | Dir iterator | cursor)`. Resolve guest absolute
  paths under `root` (reject escapes). Implement/generalize the FS host imports in
  `define_kernel_host_imports` (`:494`): `host_open` (real files/dirs under root),
  `host_read`/`host_pread` (from the real file at the handle's cursor/offset),
  `host_seek` (currently trapped), `host_close`, `host_stat`/`host_lstat`/
  `host_fstat` (real `std::fs` metadata → `write_wasm_stat`, incl. dir mode
  `S_IFDIR` and symlink mode for `lstat`), `host_opendir`/`host_readdir`/
  `host_closedir` (currently trapped — iterate `std::fs::read_dir`, marshal the
  kernel's dirent layout the same way `host/src/kernel.ts` does; verify the exact
  readdir return contract against the trait/ts host), `host_readlink` (currently
  trapped — `std::fs::read_link`). Preserve the existing blocking-stdin behavior
  (`HostPipe`/`stdin_reads`). Thread the `root` in via the FS-rooted entry point.

- [ ] **Step 4: Run GREEN** (same command as Step 2). Expected: PASS. Then run
  the full host-native suite (`cargo test -p host-native --target <host>`) — all
  8 pre-existing tests + the new one green (the single-file `/native.txt` test,
  if it exists, may need its temp-dir equivalent — keep an equivalent assertion,
  do not delete coverage).

- [ ] **Step 5: Commit.**

```bash
git add crates/host-native/src/guest.rs crates/host-native/src/lib.rs crates/host-native/fixtures/native_realfs.c crates/host-native/fixtures/native_realfs.wasm
git commit -m "Host-native: real host-directory filesystem (opendir/readdir/seek/readlink) (N1-I1)"
```

---

### Task 2: argv / environ population

**Files:**
- Modify: `crates/host-native/src/guest.rs` (the `kernel_*` argv/environ imports
  `:787`+ and `:857`; the FS-rooted entry point from Task 1 to also accept
  argv/env)
- Create: `crates/host-native/fixtures/native_argv.c` (+ built `.wasm`)
- Test: a `#[test]` in `crates/host-native/src/lib.rs`

**Interfaces:**
- Consumes (Task 1): the FS-rooted entry point.
- Produces: that entry point additionally accepts `argv: &[&str]` (or `Vec<String>`)
  and `envp`, populating `kernel_get_argc`/`kernel_argv_read`/
  `kernel_environ_count`/`kernel_environ_get` so the guest's crt1 sees real args.

- [ ] **Step 1: Write the failing test.** Add `native_argv.c`: a program that
  prints its `argc`, each `argv[i]`, and a chosen environ var to stdout. Build to
  `.wasm`. Add `#[test] smoke_runs_with_argv` running it with
  `argv = ["prog", "alpha", "beta"]` and one env var, asserting stdout reflects
  argc=3, the argv values, and the env var.

- [ ] **Step 2: Run RED** (same command form, `smoke_runs_with_argv`). Expected:
  FAIL — `kernel_get_argc` returns 0 (`guest.rs:787`), so crt1 sees the "a.out"
  fallback and the program prints argc=1/no args.

- [ ] **Step 3: Implement.** Store the caller-supplied argv/env on the process
  context; implement `kernel_get_argc` (real count), `kernel_argv_read` (copy the
  i-th arg into guest memory per the kernel's read contract — verify the exact
  signature/contract against `crates/kernel`/`wasm-posix-shared` and how the TS
  host serves it), `kernel_environ_count`, `kernel_environ_get`. Remove the
  hardcoded `-> 0` fallbacks at `:787-788`. Follow the marshalling the pump
  already uses for copying bytes into guest memory.

- [ ] **Step 4: Run GREEN** (same command). Expected: PASS. Full host-native
  suite green.

- [ ] **Step 5: Commit.**

```bash
git add crates/host-native/src/guest.rs crates/host-native/src/lib.rs crates/host-native/fixtures/native_argv.c crates/host-native/fixtures/native_argv.wasm
git commit -m "Host-native: populate real argv/environ (N1-I1)"
```

---

## Notes for the executor

- This is additive breadth on a proven spine — read the existing implemented FS
  imports in `define_kernel_host_imports` (`guest.rs:494`) and mirror their style
  for the new ones; read how the TS host (`host/src/kernel.ts`) serves
  `host_readdir`/`host_readlink`/argv to get the exact return/marshalling
  contracts right (the kernel expects the same byte layouts on both hosts).
- The readdir dirent layout and the argv read contract are the two spots where
  getting the byte layout wrong will fail silently-ish (garbled entries) — verify
  them against the shared ABI / the TS host, don't guess.
- The "run an unmodified shipped coreutils binary natively" milestone is **I2's**
  (it needs the real VFS image via `blob_read`/`fetch_archive`, or a coreutils
  package build) — I1 proves the capability breadth via purpose-built fixtures,
  which is the host-native convention. Do not add a heavy package build to I1.
