# Design: Full Rust `std` Support for Kandelo (`wasm32-unknown-kandelo`)

Status: Design (validated via brainstorming). Not yet implemented.
Date: 2026-09-06

## Why

Today, the only way to run user software on Kandelo is through the
C/C++ SDK (`wasm32posix-cc`, clang + musl sysroot). Every ported
program in the repository is C or C++; there is no Rust guest target,
no `rustc`/`cargo` SDK wrapper, and no guest `Cargo.toml`. Developers
who want to run generic Rust programs on Kandelo currently cannot,
except by dropping to `no_std` and hand-driving the linker.

This design adds a first-class Rust target that reaches **full `std`
parity** with a native unix target — files, processes, threads, and
networking — so that ordinary Rust crates compile and run on Kandelo
through the normal platform path (SDK → libc → syscalls → kernel →
host).

A secondary, deliberate goal: use Rust `std` as a **forcing function
for POSIX completeness** in the kernel. Every place `std` exercises a
syscall Kandelo does not yet implement becomes either an honest,
documented boundary or a POSIX gap to close in `crates/runtime-core/`.
Rust porting failures are treated as platform feedback, not package
quirks.

## Success criterion

Full `std` parity ("E"): compute + stdio + files + `std::env` +
`std::time` + `std::process` + `std::thread`/`std::sync` +
`std::net`. Where a capability cannot be provided faithfully under
WebAssembly, it is a **documented boundary returning the correct
failure mode**, never a faked success.

## Foundation: Option A — unix-family target on Rust's `unix` pal

The key insight is that Kandelo *is* a POSIX kernel backed by musl.
Rust's `std` already ships a mature `unix` platform-abstraction layer
(`std::sys::pal::unix`) implementing files, `process`, `net`, and
`thread` by calling libc symbols (`open`, `posix_spawn`, `socket`,
`pthread_create`, ...) — exactly the symbols Kandelo's musl exports.

So instead of treating wasm as a bare, no-OS target (the stock
`wasm32-unknown-unknown` / `wasm32-wasi` story), we declare a new
unix-family OS and route `std`'s existing `unix` backend to it. Every
`std` feature in scope is *already written* in the unix pal; we adapt
and gate it, we do not author a backend.

### Approaches considered and rejected

- **WASI preview1 shim** (implement `wasi_snapshot_preview1` on top of
  Kandelo, reuse Rust's WASI `std`): rejected. WASI preview1 has no
  `fork`/`exec` and only a capability-handle socket model; it
  structurally cannot express full processes + BSD sockets. Dead end
  for full parity.
- **Masquerade as `wasm32 linux-musl`** (reuse the `linux` os value so
  no `std` source patch is needed): viable and patch-free, but `std`
  then believes it is Linux and reaches for Linux-only paths
  (`statx`, `pidfd`, `clone3`, `/proc/self/...`) Kandelo lacks.
  Failures surface as un-labeled Linux-assumption mismatches rather
  than honest boundaries, and forcing `wasm32` through the unix pool
  under a `linux` os is unverified. Rejected in favor of an honest new
  os value (see Delivery).

## Delivery: C2 — minimal std overlay, upstreamed as a tier-3 target

Rust has **no out-of-tree "std backend plugin" system**. A target spec
JSON alone (`--target kandelo.json` + `-Z build-std`) can define a
target without forking rustc, but which pal `std` selects is driven by
`cfg(target_os=...)` / `cfg(target_family=...)` arms *inside `std`'s
own source*. A brand-new `os` value `std` does not recognize falls
through to the `unsupported` pal (everything returns `Unsupported`),
which fails full parity. There is no hook to inject a new pal from
outside `std` source.

Therefore an honest new `target_os = "kandelo"` **inherently requires a
small patch to `library/std`**. We keep it minimal and out-of-tree (an
overlay applied to the pinned toolchain's on-disk `rust-src`), *not* a
vendored Rust monorepo. That small diff *is* the upstream contribution:
a tier-3 target needs only a maintainer and "it compiles," so it is
submitted to rust-lang, and once it lands the patch-maintenance burden
ends — the target lives in rustc and users just `build-std`.

We explicitly do **not** vendor Rust as a whole.

## Section 1 — Target definition & compile path

New target `wasm32-unknown-kandelo` (a `wasm64-unknown-kandelo` variant
follows later). Defined by a target-spec JSON — no rustc fork.

Key spec fields:

- `arch = "wasm32"`, `os = "kandelo"`, `env = "musl"`,
  `vendor = "unknown"`, `target_family = ["unix"]`,
  `pointer_width = "32"`.
- `features = "+atomics,+bulk-memory,+mutable-globals,
  +exception-handling"` plus shared memory — required for
  threads/TLS and to match the SDK's clang flags.
- `linker = "rust-lld"` (the same LLVM `wasm-ld` the SDK's
  `wasm32posix-cc` drives), with `pre`/`post-link-args` baking the SDK
  link contract:
  - `-nostdlib --no-entry --export=_start --import-memory
    --shared-memory --max-memory=<cap>`
  - `--table-base=3 --export-table` — the mandatory signal-handler
    dispatch contract (indices 0/1/2 reserved for
    SIG_DFL/SIG_IGN/`__main_void`).
  - the 8 MiB shadow stack, TLS/stack-pointer exports.
  - link Kandelo's `sysroot/lib/crt1.o` + `sysroot/lib/libc.a` +
    `libc/glue/channel_syscall.c`.
- `target-family = ["unix", "wasm"]` (BOTH, deliberately). `unix` makes
  `std` select `sys::pal::unix`; `wasm` keeps `stdarch`'s wasm SIMD
  (`core::arch::wasm32`) compiling, which is gated on
  `target_family = "wasm"`. Declaring only `["unix"]` breaks the `core`
  build (unresolved `core::arch::wasm32`, conflicting `Simd` impls).
  Verified in the P2 spike below — this needs no `core`/`stdarch`
  patch, only the two-element family list.
- `.json` specs require `-Zjson-target-spec` on the pinned nightly, and
  `-Zbuild-std` compiles `core`/`alloc`/`std` from `rust-src`.

Invocation: a `wasm32posix-cargo` / `wasm32posix-rustc` SDK wrapper
(mirroring `sdk/bin/wasm32posix-cc`) injects `--target <spec>.json`,
`-Z build-std=std,panic_abort`, the sysroot path, and the `libc`
`[patch.crates-io]` override. Users then run ordinary `cargo build`.

Toolchain: the pinned `nightly-2026-04-27` from `rust-toolchain.toml`
already ships `rust-src` and supports `-Z build-std`. No toolchain
change. The std overlay is applied to the on-disk `rust-src`, not a
vendored monorepo.

## Section 2 — The std overlay & `libc` crate fork

Two out-of-tree pieces, both small and both upstreamable.

**`libc` crate fork.** Add a `(wasm32, kandelo)` module supplying the
types, constants, and `extern "C"` signatures the unix pal references —
`open/read/write`, `stat`/`dirent`, `sockaddr`/`socket` constants,
`pthread_*`, `sigaction`/`siginfo_t`, `mmap` flags, `poll`/`epoll`,
`clock_gettime`, `errno` values. These must match Kandelo's
`libc/musl-overlay/` headers. Because Kandelo *is* musl, reuse the
`linux_like → linux → musl → b32` definitions (add a `kandelo` arm to
each dispatch: `src/lib.rs` already routes via `cfg(unix)`;
`src/unix/mod.rs:2452` selects `linux_like`; the `new/` tree routes musl
via `target_env = "musl"`), then author a `wasm32` arch leaf under
`musl/b32` (no wasm32 arch exists there today) and override only the
constants the overlay headers diverge on.

**CORRECTION (spike, 2026-09-07): the fork CANNOT be delivered via
`[patch.crates-io]`.** Under `-Zbuild-std`, `std`'s `libc` is resolved
in a separate sysroot crate graph that a user-project `[patch]` does not
reach. Verified: a user `[patch.crates-io] libc` warns "patch was not
used in the crate graph"; even with a direct `libc` dependency added so
the patch applies to the user crate, `std` still compiled the registry
`libc` (all build errors pointed at the registry copy; the fork's
injected `compile_error!` never fired). **Therefore the `libc` fork must
be wired into the `rust-src` std build itself** — alongside the `std`
overlay, by pointing `library/Cargo.toml`'s `libc` dependency at the
vendored fork (or vendoring it into `rust-src`). The `libc` fork is thus
part of the *same* `rust-src` overlay as the `std` patch, not an
independent out-of-tree crate. This also means the spike's next step
mutates a copy of the toolchain's `rust-src`; it must be done against a
local, reversible copy, never the shared rustup toolchain in place.

**std overlay** (patch to `library/std` in `rust-src`): the minimum to
make `sys::pal::unix` accept `target_os = "kandelo"`:

- Add `kandelo` to the `cfg` arms that gate the unix pal and its
  sub-modules (`fs`, `process`, `net`, `thread`, `time`, `os`,
  `stack_overflow`, `rand`).
- Route each sub-module to the closest existing generic-unix behavior;
  where code is gated `cfg(target_os = "linux")`, add `kandelo` only
  where Kandelo actually implements it (epoll: yes; `pidfd` / `clone3`
  / `statx`: no).
- Boundary-ize the unsupported paths: `stack_overflow` → the no-op
  impl (guard pages cannot fault), and any `MAP_SHARED` /
  mprotect-dependent assumptions.

The diff stays small because we add a new match arm alongside the
existing unix OSes and reuse their code — not a new backend. That diff
is the tier-3 upstream submission.

## Section 3 — std subsystem mapping & honest boundaries

Grounded in the current Kandelo capability matrix.

| std area | Backend | Boundary / note |
|---|---|---|
| `fs`, `io`, stdio | musl `open/read/write/stat/getdents64` | Works. `st_rdev/blksize/blocks` read 0 (kernel #928) — cosmetic. |
| `env`, `args` | crt1 argv/envp + `getenv` | Verify `__environ` global is populated for `std::env::vars`. |
| `time` | `clock_gettime` REALTIME/MONOTONIC, `nanosleep` | CPU-time clocks report monotonic, not real CPU. `nanosleep` needs a blockable worker (browser main thread cannot `Atomics.wait`). |
| `rand` / HashMap seed | `getrandom` (Full) | Works out of the box. |
| `process::Command` | **`posix_spawn`** (non-forking, SYS_SPAWN) | Preferred over fork+exec — sidesteps Rust-codegen fork-instrumentation risk. Supports the fdop / setpgroup / sigmask actions `std` needs. |
| `thread`, `sync` | `pthread_create` → `clone()`, TLS via `__wasm_thread_init` | Works (MariaDB/Redis/PHP run threads). No `pthread_cancel` (std does not use it). Uncaught trap in a thread is process-fatal. |
| `net` (TCP) | BSD sockets, `epoll`/`poll` | Works on Node + browser-virtual. External UDP → `ENETUNREACH` (Node); browser has no raw/server sockets; IPv6 loopback-only; `getaddrinfo`/DNS is a stub — resolution needs verification. |
| stack overflow | **no-op guard** | Cannot fault (munmap cannot revoke) → overflow is a generic Wasm trap, not std's clean message. Documented boundary. |
| `panic` | **`panic = "abort"`** initially | Simpler and safer; avoids relying on Wasm EH unwinding through the pal. `panic = "unwind"` is a later stretch (the SDK does enable exception-handling). |

Two decisions baked in:

1. **`std::process::Command` → `posix_spawn`, not fork+exec.** More
   robust and dodges the untested Rust-fork-instrumentation path.
   Fork-instrumentation for Rust codegen (for anyone wanting raw
   `libc::fork`) stays a separate, later investigation.
2. **`panic = "abort"` as the target default**, with `panic = "unwind"`
   deferred.

## Section 4 — Phasing, kernel-completeness loop, validation

Phased delivery (full parity is the target; each phase is a shippable
milestone that de-risks the next and surfaces kernel gaps in order):

1. **P0 — `no_std` + `core`:** prove the target JSON, link contract,
   and `_start` produce a runnable `.wasm` via
   `npx tsx examples/run-example.ts`. No std yet.
2. **P1 — `core + alloc`:** heap via `brk`/`sbrk`; `Vec`/`String`/
   collections.
3. **P2 — std: fs / stdio / env / time / rand:** the "generic CLI"
   tier. First real std-overlay + `libc`-fork work.
4. **P3 — `std::process`** via `posix_spawn`.
5. **P4 — `std::thread` / `sync`.**
6. **P5 — `std::net`**, with boundaries documented.

**Kernel-completeness loop:** each phase runs a std-exercising Rust
fixture set; every failure is triaged as either (a) an honest boundary
→ document in `docs/posix-status.md` / `docs/wasm-limitations.md` and
return the correct errno, or (b) a real POSIX gap → fix in
`crates/runtime-core/` with its ABI impact noted. Rust std becomes the
forcing function for POSIX completeness rather than a pile of
workarounds.

**Validation** (a narrow check does not prove a broad claim):

- Rust fixtures under a new `programs/rust/` (or similar), built
  through the `wasm32posix-cargo` path, run on **both Node and browser**
  hosts.
- Where a std area has a conformance analog, run it (the existing musl
  libc-test precedent).
- Signal / process / thread changes → the relevant conformance suites,
  not just unit tests.
- Any kernel change → ABI snapshot check + the suites the ABI contract
  requires.
- No "std works" claim without the fixture actually running on both
  hosts.

## Explicit non-goals / documented boundaries

- `MAP_SHARED` memfd (returns `ENOTSUP`).
- `mprotect` enforcement (no-op; Wasm has no page protection).
- Guard-page stack-overflow messages (overflow is a generic trap).
- Browser server/raw sockets; external UDP on Node (`ENETUNREACH`).
- `pthread_cancel`.
- Dynamic TLS across `dlopen`.
- Orphan reparenting to init (kernel gap; may be closed opportunistically).

## Validation log (spike, 2026-09-07)

Executed under `scripts/dev-shell.sh` on the Node host via a minimal
`NodeKernelHost` runner (see the `perl` finding below for why the stock
`examples/run-example.ts` was not used). Spike artifacts live in the
gitignored `.context/rust-p0/`.

**P0 — `no_std` + `core`: PASS.** A `no_std` staticlib exporting
`__main_argc_argv` (the symbol Kandelo's crt1 calls — Clang's mangling
of `int main(int, char**)`, which Rust does not emit on its own),
compiled for `wasm32-unknown-unknown` with
`-C target-feature=+atomics,+bulk-memory` and
`-Zbuild-std=core,compiler_builtins` (core rebuilt with atomics so
`--shared-memory` linking does not reject a feature mismatch), linked by
the SDK `wasm32posix-cc`, ran on the kernel and printed via `write(1,…)`,
exit 0. Confirms Rust `wasm32` codegen is link- and run-compatible with
Kandelo's musl + syscall channel.

**P1 — `alloc`: PASS.** A malloc-backed `#[global_allocator]`
(`malloc`/`free`/`realloc`, `posix_memalign` for over-aligned requests)
lit up `Vec`/`String`/`format!`. Built with the custom
`wasm32-unknown-kandelo.json` spec (`os = "kandelo"`, features in the
spec) and `-Zbuild-std=core,alloc,compiler_builtins`; printed
`sum(1..=5) = 15, vec = [1, 2, 3, 4, 5]`, exit 0. Confirms the custom
target JSON and heap allocation through musl.

**P2 — `std`: reconnaissance done, not yet passing.** Two walls found,
in order:
1. `core`/`stdarch` — solved by the `["unix","wasm"]` family list
   (above); no core patch.
2. The `libc` crate — `-Zbuild-std=std` now fails inside `libc`
   (`cannot find linux_like in common`; missing `socklen_t`, `time_t`,
   `mode_t`, `pthread`, …) because there is no `(wasm32, kandelo)` unix
   module. std's unix pal is downstream of this and was not yet reached.
   Strategy: base the fork on the existing `linux_like/.../musl/b32`
   definitions (Kandelo is musl), add a `wasm32` arch leaf under
   `musl/b32`, and override only where the `libc/musl-overlay/` headers
   differ. **Delivery correction:** the fork must be wired into the
   `rust-src` std build (see Section 2), NOT delivered via user
   `[patch.crates-io]` — that was proven not to reach std's libc under
   `-Zbuild-std`. The `library/std` overlay and the `libc` fork are one
   combined `rust-src` overlay.

## Findings surfaced by the spike

- **Missing `kandelo.abi.contract` stamp.** Every SDK-`cc`-linked spike
  binary drew a kernel warning: the program lacks the
  `kandelo.abi.contract` custom section the local-build engine emits.
  Non-fatal in the spike, but the real `wasm32-unknown-kandelo` build
  step must emit that stamp. Belongs in the ABI-section work.
- **Pre-existing `run-example` runner bug (not Rust-related).**
  `examples/run-example.ts` crashes on *any* program — even stock
  `hello` — because its builtin-program list references the flat
  `programs/wasm32/perl.wasm`, but `perl` is now a multi-member package
  requiring `programs/wasm32/perl/perl.wasm`. Worked around with a
  minimal runner; worth filing/fixing separately.

## Open items to verify during implementation

- `__environ` global population for `std::env::vars` (crt1 builds an
  envp array, but `docs/posix-status.md` notes "no C-style `char**`
  environ pointer yet").
- Whether `wasm32` under the unix pal trips any
  `cfg(not(target_arch = "wasm32"))` guards or inline-asm in `std` that
  need `kandelo`-specific handling.
- `getaddrinfo`/DNS resolution behavior for `std::net` name lookups.
- Fork-instrumentation behavior on Rust/LLVM codegen (only needed if a
  raw-`fork` path is pursued later; `posix_spawn` avoids it).

## Key references

- `docs/sdk-guide.md` — SDK link contract and clang flags.
- `docs/posix-status.md` — per-syscall status table and boundaries.
- `docs/wasm-limitations.md` — hard Wasm boundaries.
- `docs/architecture.md` — shared-kernel model, syscall channel.
- `docs/fork-instrumentation.md` — fork instrumentation (deferred).
- `crates/runtime-core/src/` — syscall implementations.
- `libc/musl-overlay/`, `libc/glue/channel_syscall.c` — libc + glue.
