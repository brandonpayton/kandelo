# Rust `std` Target for Kandelo — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to
> implement this plan task-by-task.

**Goal:** Ship a `wasm32-unknown-kandelo` Rust target with full `std`
parity so generic Rust programs build and run on Kandelo through the
normal platform path.

**Architecture:** Kandelo is a POSIX/musl kernel, so route Rust's
existing `std::sys::pal::unix` backend to a new honest
`target_os = "kandelo"`. Because `std`'s `libc` cannot be overridden by
a user-project `[patch]` under `-Zbuild-std` (proven in the spike), the
`libc` fork and the `library/std` change are delivered together as one
overlay applied to a **linked private copy** of the pinned toolchain's
`rust-src` — never the shared toolchain. Each `std` feature that hits a
Kandelo gap is triaged as an honest documented boundary or a kernel
POSIX-completeness task.

**Tech Stack:** Rust `nightly-2026-04-27` (`rust-src`, `-Zbuild-std`,
`-Zjson-target-spec`), `libc` 0.2.185, the Kandelo SDK
(`wasm32posix-cc`, musl sysroot, `channel_syscall.c`), `NodeKernelHost`.

**Design reference:** `docs/plans/2026-09-06-rust-std-target-design.md`
(read it first — it carries the decisions, the capability matrix, and
the spike findings this plan executes).

---

## Conventions used in this plan

- Run every build/verify command under `scripts/dev-shell.sh` (the
  repo-declared toolchain). Example:
  `bash scripts/dev-shell.sh <cmd>`.
- The "test" for toolchain-porting tasks is behavioral: **a Rust
  fixture compiles, links via the SDK, and runs on the kernel with the
  expected stdout and exit code.** Where a unit-testable Rust helper
  exists, use ordinary `#[test]`; otherwise the fixture-on-kernel run is
  the acceptance check. This satisfies the validation contract
  (`docs/agent-guidance/validation.md`): a fixture actually running on
  the kernel, not code reasoning.
- Commit after each task with an `Area:` prefix (`SDK:`, `Docs:`,
  `Packages:`).
- The spike proved P0/P1 already; artifacts are in the gitignored
  `.context/rust-p0/`. This plan moves that work into supported in-repo
  locations and pushes through P2–P5.

## Known facts from the spike (do not re-derive)

- Kandelo's crt1 (`libc/musl-overlay/crt/crt1.c`) calls
  `__main_argc_argv(int argc, char **argv)` — Clang's mangling of
  `int main(int,char**)`. A Rust guest with no C `main` must export that
  symbol, OR (once `std` works) a normal `fn main` compiles because
  `std`'s runtime provides the C entry.
- The SDK link contract (`sdk/src/lib/flags.ts`) forces
  `--shared-memory`, so **all** Rust objects must be built with
  `+atomics,+bulk-memory` and `core` rebuilt via `-Zbuild-std`.
- Target spec must set `target-family = ["unix","wasm"]` (both): `unix`
  selects `std`'s unix pal; `wasm` keeps `stdarch`'s `core::arch::wasm32`
  compiling. `["unix"]` alone breaks the `core` build.
- `.json` specs need `-Zjson-target-spec` on this nightly.
- `std`'s `libc` (0.2.185) lives in a separate sysroot crate graph;
  user `[patch.crates-io]` does NOT reach it. Fork it inside `rust-src`.
- `libc` dispatch points to touch (v0.2.185):
  - `src/lib.rs` — `cfg(unix)` already routes to `mod unix` (OK once
    family includes `unix`).
  - `src/unix/mod.rs:~2452` — selects `linux_like` for
    `{linux,l4re,android,emscripten}`.
  - `src/new/mod.rs:~90` (`target_os="linux"`) and `~154`
    (`target_env="musl"`); `src/new/common/mod.rs:~21-27` gates
    `linux_like` on `{android,emscripten,l4re,linux}`.
  - `musl/b32` has per-`target_arch` leaves (arm/x86/…); **no `wasm32`
    leaf exists** — one must be authored.

---

## Milestone 0 — In-repo homes and a green baseline

Goal: a fresh worktree can build and run a Rust guest, and the spike's
P0/P1 are reproduced from supported locations (not `.context/`).

### Task 0.1: Provisioning check script note

**Files:**
- Modify: `docs/plans/2026-09-06-rust-std-target-design.md` (add a
  one-line pointer to this plan under "Validation log").

**Steps:**
1. Confirm a fresh worktree needs: `git submodule update --init
   libc/musl`, `scripts/build-musl.sh`, `npm ci`, `./run.sh setup` (all
   under dev-shell). Verify `sysroot/lib/crt1.o`, `sysroot/lib/libc.a`,
   and `local-binaries/source-only-v1/kernel.wasm` exist.
2. Commit the doc pointer. `Docs:` prefix.

### Task 0.2: Create the Rust guest fixture directory

**Files:**
- Create: `programs/rust/README.md` (explains these are Rust guest
  fixtures for `wasm32-unknown-kandelo`, built via the SDK).
- Create: `programs/rust/hello/Cargo.toml`, `programs/rust/hello/src/lib.rs`.

**Steps:**
1. Port the P0 `no_std` program from `.context/rust-p0/src/lib.rs`
   (exports `__main_argc_argv`, writes a greeting, panic handler).
2. Add an empty `[workspace]` table so the repo-root workspace does not
   capture it.
3. Commit. `Packages:` prefix.

### Task 0.3: Add the in-repo target spec

**Files:**
- Create: `sdk/rust/wasm32-unknown-kandelo.json` (from
  `.context/rust-p0/wasm32-unknown-kandelo.json`: `os="kandelo"`,
  `env="musl"`, `features="+atomics,+bulk-memory,+mutable-globals"`,
  `target-family=["unix","wasm"]`, `panic-strategy="abort"`,
  `metadata.std=false` for now).
- Create: `sdk/rust/README.md` (how the Rust target is built/used).

**Steps:**
1. Write the spec. Keep `llvm-target="wasm32-unknown-unknown"` (LLVM has
   no kandelo triple).
2. Commit. `SDK:` prefix.

### Task 0.4: Reproduce P0 from in-repo locations (acceptance)

**Steps:**
1. Build: `bash scripts/dev-shell.sh cargo build --release
   -Z json-target-spec -Z build-std=core,compiler_builtins
   --target sdk/rust/wasm32-unknown-kandelo.json` in
   `programs/rust/hello`.
2. Link: `bash scripts/dev-shell.sh wasm32posix-cc empty.c
   target/wasm32-unknown-kandelo/release/libhello.a -o hello.wasm`
   (keep the empty-TU trick to trigger SDK linking of an archive).
3. Run via the minimal runner (Task 0.5).
   Expected stdout: the greeting; exit 0.
4. Commit any glue. `Packages:` prefix.

### Task 0.5: Land a supported single-program runner (fixes a real bug)

**Context:** `examples/run-example.ts` currently crashes on *any*
program because its builtin list references flat `programs/wasm32/
perl.wasm` while `perl` is a multi-member package needing
`programs/wasm32/perl/perl.wasm` (see design doc findings).

**Files:**
- Modify: the run-example builtin definition that references
  `perl.wasm` (search `host/src` / `examples` for `perl.wasm`) to use
  the multi-member path, OR
- Create: `examples/run-wasm.ts` — a minimal `NodeKernelHost` runner
  that boots and spawns one `.wasm` with no builtin discovery (port
  `.context/rust-p0/run.mts`).

**Steps:**
1. Prefer fixing the stale `perl` reference if it is a one-line path
   correction (it restores the stock runner for everyone). If the fix is
   larger than a path change, land `examples/run-wasm.ts` instead and
   file the perl bug separately.
2. Verify: the chosen runner runs `programs/rust/hello/hello.wasm`.
3. Commit. `Browser:` or `Packages:` prefix as appropriate.

### Task 0.6: Reproduce P1 (alloc) from in-repo locations

**Files:**
- Create: `programs/rust/alloc-demo/` (port the P1 malloc-backed
  `#[global_allocator]` + `Vec`/`String`/`format!` program).

**Steps:**
1. Build with `-Z build-std=core,alloc,compiler_builtins`, link, run.
   Expected stdout: `sum(1..=5) = 15, vec = [1, 2, 3, 4, 5]`; exit 0.
2. Commit. `Packages:` prefix.

---

## Milestone 1 — Linked private toolchain + `rust-src` overlay plumbing

Goal: build `std` from a **forked copy** of `rust-src` without touching
the shared toolchain, and PROVE the forked `libc` is the one `std` uses.

### Task 1.1: Copy the toolchain and link it

**Files:**
- Create: `scripts/build-rust-sysroot.sh` (new; encapsulates all of
  Milestone 1 so it is reproducible).

**Steps:**
1. Resolve the pinned toolchain dir:
   `TC=$(rustc +nightly-2026-04-27 --print sysroot)`.
2. Copy to a work location outside git (e.g.
   `$HOME/.kandelo/rust/kandelo-dev`) — do NOT copy into the repo
   (~1–2 GB). Make it writable.
3. `rustup toolchain link kandelo-dev <copy>`.
4. Verify `cargo +kandelo-dev --version` works.
5. Commit the script (not the copy). `SDK:` prefix.

### Task 1.2: Vendor the `libc` fork into the copied `rust-src`

**Files:**
- Create: `sdk/rust/libc-kandelo/` — the forked `libc` source, tracked
  in-repo (this is the maintained overlay). Seed it by copying
  `libc-0.2.185` from the cargo cache
  (`~/.cargo/registry/src/*/libc-0.2.185`).
- Modify (in the copied toolchain, via the script): the `rust-src`
  `library/Cargo.toml` workspace so `std`'s `libc` dependency resolves to
  `sdk/rust/libc-kandelo` (add a `[patch.crates-io] libc = { path = … }`
  to the **sysroot workspace** manifest, or repoint the dep). Re-run
  `cargo update` inside `rust-src/library` if needed to refresh its lock.

**Steps:**
1. Script copies `sdk/rust/libc-kandelo` into place / patches the
   sysroot workspace manifest to point at it.
2. Inject a temporary probe: `#[cfg(target_os="kandelo")]
   compile_error!("KANDELO_FORK_ACTIVE");` at the top of
   `sdk/rust/libc-kandelo/src/lib.rs`.
3. Build std: `cargo +kandelo-dev build --release -Z json-target-spec
   -Z build-std=std,panic_abort --target sdk/rust/
   wasm32-unknown-kandelo-std.json` (a `std` variant spec with
   `metadata.std=true`).
4. **Acceptance:** the build fails with `KANDELO_FORK_ACTIVE` — proving
   `std` compiled the FORKED libc (the spike's negative result becomes
   positive here). Remove the probe.
5. Commit `sdk/rust/libc-kandelo` (seed, unmodified) + the script.
   `SDK:` prefix.

---

## Milestone 2 — `libc` compiles for `wasm32-unknown-kandelo`

Goal: `-Z build-std=std` gets past `libc` (no `libc` errors). Iterative
compile-fix loop; the acceptance is "zero `libc` errors."

### Task 2.1: Add `kandelo` arms to the `libc` dispatch trees

**Files (all in `sdk/rust/libc-kandelo/src/`):**
- Modify: `unix/mod.rs:~2452` — add `target_os = "kandelo"` to the
  `linux_like` arm.
- Modify: `new/common/mod.rs:~21-27` — add `kandelo` to the
  `linux_like` gate.
- Modify: `new/mod.rs` — ensure the `target_env="musl"` arm (~154) is
  reached for kandelo (no os arm matches), or add an explicit `kandelo`
  arm mirroring `linux`/musl.
- Modify: `unix/linux_like/mod.rs` and
  `unix/linux_like/linux/mod.rs` — add `kandelo` wherever `target_os`
  gates the `linux` → `musl` path.

**Steps:**
1. Make the edits so dispatch reaches `musl/b32`.
2. Rebuild std; capture the new first errors (expected: missing
   `wasm32` arch leaf).
3. Commit. `SDK:` prefix.

### Task 2.2: Author the `wasm32` musl-b32 arch leaf

**Files:**
- Create: `sdk/rust/libc-kandelo/src/unix/linux_like/linux/musl/b32/
  wasm32/mod.rs` (and register it in `.../b32/mod.rs` under a
  `target_arch = "wasm32"` arm).
- Create the matching leaf under the `new/musl` tree if that tree also
  keys on arch.

**Steps:**
1. Model on the `arm` b32 leaf. Define arch-specific items: `c_char`
   signedness (verify against `libc/musl-overlay` — wasm clang treats
   `char` as unsigned by default; confirm), `wchar_t`, `c_long`/`c_ulong`
   widths (32-bit), any arch-tagged struct layouts (`stat`, `sigaction`,
   `jmp_buf`, `pthread_*` sizes) that must match the overlay headers.
2. Cross-check every size/layout against `libc/musl-overlay/`
   (`bits/*.h`, `arch/wasm32posix/*`). Where Kandelo diverges from
   generic musl, this leaf is where it is recorded.
3. Iterate build until arch-selection errors clear.
4. Commit. `SDK:` prefix.

### Task 2.3: Reconcile constants that differ from generic musl

**Files:**
- Modify: `sdk/rust/libc-kandelo/src/…/wasm32/mod.rs` and the shared
  musl module for any constant the overlay defines differently
  (`errno` values, `O_*`, `SOCK_*`, `MAP_*`, `SIG*`, ioctl numbers).

**Steps:**
1. For each `libc` error "cannot find/mismatch", check the overlay
   header and define/override the constant.
2. **Acceptance:** `-Z build-std=std` produces zero errors originating
   in `libc`. (std pal errors are expected and handled in Milestone 3.)
3. Commit. `SDK:` prefix.

---

## Milestone 2 status + a discovered milestone (2026-09-07)

**M1 done** (`60eff3460`): the delivery mechanism had to change for the
Nix toolchain (no rustup). `scripts/build-rust-sysroot.sh` assembles a
private writable sysroot (mirror-by-symlink, `rust-src` copied writable),
points std's `libc` at `sdk/rust/libc-kandelo` via the library-workspace
`[patch.crates-io]`, and emits a `rustc` wrapper injecting `--sysroot`.
The `std` overlay is delivered as full changed files under
`sdk/rust/std-overlay/` (mirroring `library/`), captured from the private
sysroot by `scripts/export-rust-overlay.sh` and re-applied on rebuild.

**M2 done** (`a5d7d87d6`): `-Zbuild-std=std` produces zero errors
originating in `sdk/rust/libc-kandelo/`. Added `kandelo` to the
module-selection gates (reuse `linux_like → linux → musl`) and the
per-item pthread gates.

**DISCOVERY — the wasm32 libc leaf is WALI, not Kandelo musl.** A
`wasm32` arch leaf already existed, routed via `musl/mod.rs` to **`b64`**
(not `b32` as this plan assumed), and it encodes the **WALI ABI**
(WebAssembly Linux Interface — mirrors x86_64 Linux). Only `stat` /
`nlink_t` / `blksize_t` were reconciled to Kandelo's
`libc/musl-overlay/arch/wasm32posix/` (with a passing 112-byte `stat`
size assertion). The leaf's **syscall numbers (x86_64), and many
constants (`O_*`, signals, errno, `ipc_perm`) remain WALI values** — they
compile but are runtime-wrong for Kandelo, whose ABI is pinned in
`crates/shared/src/lib.rs` and `libc/musl-overlay/bits/`.

### Milestone 2.5 — Reconcile the wasm32 libc leaf to Kandelo's ABI

**This gates M4 runtime correctness.** A `std` program may compile and
link but pass wrong flag/errno/struct values to Kandelo's musl until this
is done.

- Reconcile the `wasm32` leaf's syscall numbers against
  `libc/musl-overlay/bits/syscall.h.in` + `crates/shared/src/lib.rs`.
- Reconcile `O_*`, `SOCK_*`, `MAP_*`, signal numbers, errno values,
  `ioctl` numbers, and `ipc_perm`/other struct layouts against the
  overlay headers.
- Decide the `b32` vs `b64` question honestly: confirm Kandelo
  `wasm32posix` type widths (`c_long`, `time_t`, `off_t`) against the
  overlay and place the leaf in the correct bits module.
- Add compile-time `size_of`/offset assertions against
  `crates/shared/src/process_layout.rs` where layouts are ABI-pinned.
- Validate at runtime via M4/M5 fixtures, not just compilation.

**Refinement (after M4 first cut):** common `O_*` flags coincide between
WALI/x86_64 and Kandelo's generic-like `wasm32posix` musl, so the
function-call path (`open`/`read`/`write`) already works — `std::fs` ran
correctly. M2.5 is therefore narrower: focus on divergent constants,
struct layouts consumed by std (`stat`/metadata already reconciled;
`sigaction`, socket structs next), signal numbers, and any direct
`syscall(SYS_*)` path std uses (the WALI numbers are x86_64, wrong for
Kandelo). Drive each by a failing M4/M5 fixture, not speculation.

## M3/M4 status (2026-09-07)

**M3 done** (`f2798ca86`): `std` compiles for `wasm32-unknown-kandelo`.
10 overlay files under `sdk/rust/std-overlay/` add `kandelo` unix-pal
arms (futex, random→getrandom, paths, args, fs DirEntry, os::linux
fs/raw reuse); `stack_overflow` correctly falls to the no-op impl
(guard pages can't fault); `thread::set_name` → no-op. Verified by a
from-overlay sysroot rebuild producing a clean `libstd` rlib.
Requires `RUST_LIBC_UNSTABLE_MUSL_V1_2_3=1`.

**M4 first cut done** (`941fea22a`): `programs/rust/std-hello` (a `std`
staticlib linked via the SDK) runs on the kernel — `std::println!`,
formatting, and a `std::fs` write/read round-trip all succeed, exit 0.
Verified working in the fixture: `std::println!`, `std::fs`
round-trip, `std::time` (monotonic `Instant`), and `HashMap`
(getrandom-seeded SipHash). **KNOWN GAP:** `std::env::args()` is empty
because the staticlib entry bypasses std's `lang_start`, and on musl
argv is captured by `lang_start` (musl does not pass argc/argv to
`.init_array`, so glibc's arg-capture trick does not apply). The fix is
a normal `fn main` bin entry, which requires SDK-driven linking (bin
crates fail `rust-lld` on `-lc`/`-lgcc_s`). **This makes the SDK linker
integration (Milestone 6, Task 6.1) a prerequisite for `std::env::args`
and `fn main` ergonomics — pull it earlier if generic-CLI arg handling
is needed before P3–P5.**

## Milestone 3 — `std` unix pal compiles for `kandelo`

Goal: `-Z build-std=std,panic_abort` completes; `std` builds.

### Task 3.1: Vendor the `library/std` overlay

**Files:**
- Create: `sdk/rust/std-overlay/` — the tracked `std` patch set. The
  build script applies it onto the copied toolchain's
  `rust-src/library/std` (e.g. a series of `patch`-able files or a
  git-format patch). Keep it MINIMAL (new `cfg` arms only).

**Steps:**
1. Establish the overlay-application step in
   `scripts/build-rust-sysroot.sh` (copy/patch, reversible; the copied
   toolchain is disposable).
2. Commit the (initially empty) overlay + script wiring. `SDK:` prefix.

### Task 3.2: Add `kandelo` to `std`'s pal selection and sub-modules

**Files (overlay onto `rust-src/library/std/src/sys/`):**
- `pal/mod.rs` — ensure `cfg(unix)` selects `pal::unix` for kandelo
  (family `unix` should already do this; confirm).
- `pal/unix/mod.rs` and sub-modules (`fs`, `process`, `net`, `thread`,
  `time`, `os`, `stack_overflow`, `rand`, `pipe`, `fd`) — add `kandelo`
  to `cfg` arms, routing to the closest **generic-unix** behavior. Add
  `kandelo` to Linux-gated code ONLY where Kandelo implements it (epoll:
  yes; `pidfd`/`clone3`/`statx`: no).

**Steps:**
1. Iterate build-std; for each error, add the minimal `kandelo` arm.
2. Commit in logical groups. `SDK:` prefix.

### Task 3.3: Boundary-ize the unsupported pal pieces

**Files:**
- `pal/unix/stack_overflow.rs` — route `kandelo` to the **no-op** guard
  impl (munmap cannot revoke; guard pages cannot fault — matrix §6).
- Any `MAP_SHARED`/`mprotect`-dependent path — ensure it degrades to the
  honest failure, not a fake success.

**Steps:**
1. Add the boundary arms.
2. **Acceptance:** `std` builds cleanly for
   `wasm32-unknown-kandelo`. Capture the exact working invocation into
   `scripts/build-rust-sysroot.sh`.
3. Commit. `SDK:` prefix.

---

## Milestone 4 — First `std` program runs on the kernel (P2 acceptance)

### Task 4.1: Generic-CLI fixture

**Files:**
- Create: `programs/rust/std-cli/src/main.rs` — a normal `fn main()`
  using: `println!`, `std::env::args`/`vars`, `std::fs`
  (write then read back a file under `/tmp`), `std::time::Instant`,
  a `HashMap` (exercises `getrandom` seeding).

**Steps:**
1. Build: `cargo +kandelo-dev build --release -Z json-target-spec
   -Z build-std=std,panic_abort --target …-std.json`.
2. Link via SDK `wasm32posix-cc` (now the archive contains `std`'s C
   entry; confirm whether the empty-TU trick is still needed or a normal
   `fn main` links directly).
3. Run on the kernel (Node host).
   **Acceptance:** correct stdout for args/env/file round-trip; exit 0.
4. Triage any runtime failure via the kernel-completeness loop
   (Task 5.0). Commit. `Packages:` prefix.

### Task 4.2: Verify `__environ`, and document P2 status

**Files:**
- Modify: `docs/posix-status.md` and/or `docs/wasm-limitations.md` for
  any boundary confirmed here.
- Modify: `docs/plans/2026-09-06-rust-std-target-design.md` validation
  log — mark P2 PASS with the exact commands.

**Steps:**
1. Confirm `std::env::vars` works (design open item on `__environ`).
2. Commit docs. `Docs:` prefix.

---

## Milestone 5 — Phases P3–P5 with the kernel-completeness loop

### Task 5.0: The triage loop (reference, applied throughout)

For every std feature that fails at runtime:
1. Trace to the layer (musl glue, syscall, kernel state, host).
2. Classify: (a) honest boundary → document + return correct errno;
   (b) real POSIX gap → fix in `crates/runtime-core/`, note ABI impact,
   bump `ABI_VERSION` + regenerate `abi/snapshot.json` if the change is
   incompatible (see `docs/agent-guidance/abi.md`).
3. Add a regression fixture under `programs/rust/`.
4. Validate on BOTH Node and browser hosts where host-observable.

### Task 5.1: P3 — `std::process` via `posix_spawn`

**Files:** `programs/rust/proc-demo/` — `Command::new(...).spawn()`,
wait, capture status. Confirm `std`'s unix `process` pal routes through
`posix_spawn` (SYS_SPAWN) for kandelo, not fork+exec.

**Acceptance:** a child process runs and its exit status is observed on
the kernel. Commit.

### Task 5.2: P4 — `std::thread` / `std::sync`

**Files:** `programs/rust/thread-demo/` — spawn threads, `join`, a
`Mutex`/`Arc` counter. Requires the target/link to declare thread slots
(`--kandelo-thread-slots`) and shared memory.

**Acceptance:** deterministic sum across threads on the kernel. Commit.

### Task 5.3: P5 — `std::net`

**Files:** `programs/rust/net-demo/` — TCP loopback client/server.
Document boundaries: external UDP `ENETUNREACH` (Node), browser
raw/server sockets unavailable, DNS/`getaddrinfo` status.

**Acceptance:** loopback TCP round-trip on Node; boundaries documented.
Commit.

---

## Milestone 6 — Productization & upstream prep

### Task 6.1: `wasm32posix-cargo` / `wasm32posix-rustc` wrappers

**Files:**
- Create: `sdk/bin/wasm32posix-cargo`, `sdk/bin/wasm32posix-rustc`
  (mirror `sdk/bin/wasm32posix-cc`), injecting the target spec,
  `-Zjson-target-spec`, `-Zbuild-std`, the `+kandelo-dev` toolchain, and
  the sysroot/link flags so a user just runs `cargo build`.

**Acceptance:** `wasm32posix-cargo build` in `programs/rust/std-cli`
produces a runnable `.wasm`. Commit. `SDK:` prefix.

### Task 6.2: Emit the `kandelo.abi.contract` stamp

**Context:** spike binaries drew a kernel warning for a missing
`kandelo.abi.contract` custom section. Determine how the local-build
engine emits it and make the Rust link path emit it too.

**Files:** the link wrapper / a post-link step; reference
`docs/abi-versioning.md`.

**Acceptance:** a Rust guest runs with no ABI-contract warning. Commit.

### Task 6.3: Fork-instrumentation decision for Rust

**Steps:** since `std::process` uses `posix_spawn`, raw `fork` is not on
the default path. Document that fork-using Rust guests need
`scripts/run-wasm-fork-instrument.sh` and that Rust/LLVM codegen is
UNVALIDATED there (design risk). Only spike this if a raw-`fork` use case
appears. `Docs:` prefix.

### Task 6.4: Docs + upstream tier-3 prep

**Files:**
- Create: `docs/rust-target.md` — how to build/run Rust on Kandelo,
  supported std surface, documented boundaries.
- Modify: `docs/software-targets.md` — add Rust.
- Prepare the `libc` + `std` diffs as upstream-shaped patches (tier-3
  target: a maintainer + "it compiles"); once upstreamed, the overlay
  retires.

**Acceptance:** a new developer can follow `docs/rust-target.md` to run
a Rust program. Commit. `Docs:` prefix.

---

## Definition of done

- `programs/rust/std-cli` (files/env/args/time/HashMap),
  `proc-demo`, `thread-demo`, and `net-demo` all build via
  `wasm32posix-cargo` and run on the Node host with correct output;
  host-observable ones also verified on browser.
- Every unsupported behavior returns the correct failure and is listed
  in `docs/posix-status.md` / `docs/wasm-limitations.md`.
- No `kandelo.abi.contract` warning; any kernel changes carry their ABI
  bump + snapshot.
- `docs/rust-target.md` exists; the `libc`/`std` overlay is captured as
  upstream-shaped patches.
