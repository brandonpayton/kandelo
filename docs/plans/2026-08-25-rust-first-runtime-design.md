# Rust-First Runtime and Narrow Host Boundary — Design

Status: **Design proposal (research mode). Not approved for
implementation.** This document is the architecture and staged plan for
review. No implementation begins until the written spec is approved.

Related prior art (context and inspiration only, not authority):
`docs/plans/2026-05-20-rust-owned-host-logic-plan.md`,
`docs/plans/2026-05-11-shareable-computer-url-design.md`.

> **Current remaining-work plan:** for what is left in this campaign, why,
> and in what order, see
> `docs/plans/2026-09-04-rust-first-remaining-purpose-framed.md` — the
> authoritative, purpose-framed view of the remaining steps. This design
> doc remains the architecture and staged plan; that document is the live
> status, the decision "Bar," and the current sequence.

## Why

Kandelo's runtime today splits POSIX and ABI responsibility across two
languages. The Rust kernel owns authoritative *state* (process table,
descriptors, signals, memory accounting), but a large amount of
version-sensitive and semantic behavior still lives in TypeScript:

- The host interprets guest syscall numbers and marshals each syscall's
  pointer arguments by hand, driven by generated per-syscall descriptor
  tables (`crates/shared/src/host_abi.rs`, `channel_scalar.rs`,
  consumed by `host/src/kernel-worker.ts`).
- The authoritative filesystem *backend* — inodes, metadata, mount
  routing, image/archive parsing — lives in TypeScript
  (`host/src/vfs/memory-fs.ts`, ~8,200 lines; `host/src/vfs/vfs.ts`).
- Blocking, retry, and readiness policy for `poll`/`select`/`epoll`,
  futex, and advisory locks is reimplemented host-side in TypeScript.
- Fork and exec reconstruct engine-resident Wasm instance state through
  ~30,500 lines of TypeScript codecs.

This split has three costs. First, every guest ABI change ripples into
hand-written TypeScript, so the ABI is not truly owned in one place.
Second, Node and browser each maintain a parallel TypeScript runtime
path, and the two diverge; this is the origin of a recurring class of
parity bugs. Third, there is no third, non-JavaScript host, so the
runtime's portability is asserted rather than proven.

The goal is a **Rust-first runtime**: move version-sensitive behavior and
platform semantics into a reusable Rust core so that JavaScript
eventually only creates workers and Wasm instances, waits for events,
transfers bounded opaque data, and implements explicit host
capabilities. A guest ABI change should then require no JavaScript change
unless it introduces a genuinely new host capability.

This work is the prerequisite for a later, separately specified project:
a stable, self-contained VFS boot protocol. That downstream project needs
a Rust runtime core and a narrow host boundary to depend on. This
document designs that core and boundary. It does **not** design or freeze
the boot protocol.

## Scope and non-goals

In scope:

- A Rust runtime core usable both as Wasm and as a native Rust library.
- A narrow, versioned host capability contract with browser, Node, and
  native (Wasmtime) implementations.
- Moving syscall marshalling, VFS semantics, and blocking/readiness
  policy into Rust.
- Making fork/exec Rust-directed as far as the Wasm engine boundary
  allows.
- A fresh ABI epoch (ABI 44) for the whole cutover.

Non-goals:

- The self-contained boot protocol and boot protocol v1. Deferred to a
  downstream project (decision #6). Boot protocol v1 must not be frozen
  during this work.
- Compatibility with pre-v1 images or with ABI 43. We are in research
  mode; incompatible change is expected and acceptable (decision #1).
- Porting Homebrew composition. Homebrew is **pruned and decoupled**, not
  migrated (see below).
- Making image-supplied JavaScript part of the required runtime.

## Decisions already made

From the project brief:

1. Compatibility begins at boot protocol v1. Pre-v1 images need no
   automatic compatibility.
2. A VFS image may provide its own user-supplied kernel (Wasm).
3. The kernel is untrusted Wasm. Host-owned policy grants capabilities;
   the image may request but cannot grant capabilities.
4. Boot protocol v1 will not be frozen until the same image boots through
   the browser host, the Node.js host, and a minimal JS-free native Rust
   host.
5. We do not retain every old kernel or TypeScript adapter.
6. Self-contained boot media is a downstream project.

Strategy decisions made during design review:

7. **ABI 44, research mode.** Produce one fresh ABI epoch for the cutover.
   No cross-version compatibility shims for the migration.
8. **Single big-bang integration branch**, developed as a coherent whole,
   curated into conceptually separate commits and rebase-merged. Chosen
   because there is no external ABI-compatibility obligation, incremental
   landing would force disallowed compatibility shims and half-migrated
   epochs, the pieces are coupled through the ABI, and the kernel core is
   already native-capable.
9. **Commit-stack guarantee: prefer each commit independently green and
   bisectable** (builds, passes its relevant suites, preserves
   Node/browser parity at that commit). Fall back to green-at-tip
   narrative commits only where per-commit green is not pragmatic.
10. **Fork/exec (Frontier D) is attempted inside the big-bang but
    sequenced last and kept severable.** If it stalls, everything before
    it still ships.
11. **Homebrew is pruned early** to remove churn from the rebase surface.

## Current-state findings

Evidence gathered by five parallel code investigations across
`host/src/`, `crates/`, `libc/glue/`, `abi/`, and `docs/`.

### The kernel core is already native-capable

`crates/kernel/src/lib.rs` gates `no_std`/`no_main`, the `wasm_api`
module, and the dlmalloc allocator on `cfg(wasm32|wasm64)`, with native
fallbacks, and is already unit-tested as a native `rlib`
(`.cargo/config` sets `RUST_TEST_THREADS=1`). Every POSIX subsystem is an
ordinary `pub mod`. Only `wasm_api.rs`, the allocator, and the ~82
`host_*` imports are Wasm-specific. The native reference host (decision
#4) is therefore mostly a matter of providing a native backend for the
capability imports, not restructuring the kernel.

### What Rust already owns

Process table, PIDs/pgrp/sid, credentials; fd/OFD tables, dup, fcntl,
advisory locks; pipes and FIFOs; SysV IPC and POSIX mqueue;
epoll/poll/select readiness bookkeeping; signal disposition, mask,
pending, delivery; brk/mmap address-space accounting; termios and PTY;
procfs and devfs content; fork *state* and fd-action plans; path
canonicalization and the symlink namei walk (`crates/kernel/src/path.rs`,
re-entering the host for `host_readlink`/`host_stat`).

The kernel exposes 320 `pub extern "C"` exports (`wasm_api.rs`); 80 are
required and 4 optional in the host-adapter manifest
(`crates/shared/src/lib.rs`). The kernel imports only module `env`: ~82
`host_*` capability functions.

### The syscall channel ABI

Per-thread SharedArrayBuffer region; base in the imported Wasm global
`__channel_base`. Layout (`crates/shared/src/lib.rs`;
`libc/glue/channel_syscall.c`): status (i32 atomic), syscall (i32), 6×i64
args, return (i64), errno (i32), request flags (u32), then a 64 KiB data
buffer whose tail is the signal-delivery area. Guest and kernel
synchronize with `Atomics.wait32` / `memory.atomic.notify`.

The transport is **syscall-specific, not opaque**. On the host side,
`SYSCALL_ARG_DESCRIPTORS` (`crates/shared/src/host_abi.rs`, 123 entries)
drives per-syscall pointer copies from guest memory into kernel scratch;
`channel_scalar.rs` assigns per-slot meaning to the six i64 words. This
descriptor-driven marshalling is the single reason the host "interprets
guest ABI." All ABI numbers and layouts are generated into one file,
`host/src/generated/abi.ts`, but *interpretation and dispatch* of those
values is hand-written TypeScript in `kernel-worker.ts`.

### The ~82 host_* capability imports

Categories (`crates/kernel/src/wasm_api.rs`): real filesystem, directory,
and metadata I/O (~36 functions); time, random, sleep; timers and signal
scheduling, including invoking guest signal handlers; process control
(`host_waitpid`, `host_is_thread_worker`, proc byte access); networking;
futex wait/wake; graphics and audio device backends; debug logging.

### The four TypeScript frontiers

The remaining TypeScript-owned runtime code falls into four frontiers
that differ sharply in size and difficulty.

**A. Syscall transport / ABI marshalling.** Cleanly scoped. Dispatch on
guest syscall numbers lives in `kernel-worker.ts` `#handleSyscallInner`
(~40 syscalls/families branch); per-slot scalar normalization and
pointer copy into scratch. Moving to opaque bounded records obsoletes
`host_abi.rs` and `channel_scalar.rs` in the host data path, collapses
the required `kernel_*` exports toward `kernel_handle_channel`, and forces
an ABI bump. The atomic handshake, syscall numbers, `__channel_base`, and
the fork contract stay stable.

**B. Blocking / retry / readiness policy.** Medium, entangled.
`poll`/`select`/`epoll` semantics are reimplemented host-side in
TypeScript; `epoll_pwait` is converted to `poll` on the host,
deliberately bypassing `kernel_handle_channel`. Futex, flock, sleep, and
inet-connect retry policy live in TypeScript. The design must separate
the readiness/retry *decision* (Rust) from asynchronous *waiting* (a host
capability using `Atomics.waitAsync`).

**C. VFS backend.** Large but conceptually clean (~21,700 TypeScript
lines). Authoritative normal-filesystem state lives in the TypeScript
`MemoryFileSystem`, inside the kernel worker. Every open/read/write/stat/
readdir is served by TypeScript after Rust canonicalizes the path.
"Kernel-owned FS" means *residency* (the FS SharedArrayBuffer stays in
the worker realm and is never shared with the browser main thread — a
Safari out-of-memory fix), not that Rust serves the filesystem.
`VirtualPlatformIO` (`host/src/vfs/vfs.ts`) owns mount routing, host-side
fd/dirfd handle tables, inode/device qualification, EXDEV, and statfs
overlays. Format and parsing logic to move to Rust: tar/gzip
(`vfs/tar.ts`), zip (`vfs/zip.ts`), the VFS image format plus zstd and
metadata header (`vfs/memory-fs.ts`, `vfs/load-image.ts`), lazy-tree
descriptors, materialization and byte-transform recipes with
source-identity assertions (`vfs/materialization-plan.ts`), deferred-tree
contracts, mount specs and seal verification (`vfs/default-mounts.ts`),
overlay merge, and the hardlink graph. Genuine host leaves that stay in
adapters: OPFS byte I/O via `FileSystemSyncAccessHandle`
(`vfs/opfs-worker.ts`), browser fetch plus CORS proxy for lazy assets
(`vfs/browser-lazy-fetcher.ts`), Node `fs` passthrough (`vfs/host-fs.ts`),
randomness, wall-clock, and client-side zstd decode.

**D. Fork / exec / dylink / threads.** Huge (~30,500 TypeScript lines)
and with a genuine host floor. About 79% is codecs that reconstruct
*engine-resident* Wasm instance state — continuation frames, funcref/
externref/exnref/GC graphs, reference globals, tables, exception state,
and the dynamic-linker instance graph — whose byte formats are defined by
`crates/fork-instrument` (a host-side CLI that rewrites guest modules;
its contract is `WPK_FORK_*` in `crates/shared/src/lib.rs` plus ten
custom sections). Policy is already kernel-directed: `crates/kernel/src/
fork.rs` clones the process table, fd/OFD inheritance, memory image, and
PID/TID. FORK/VFORK/EXECVE/EXECVEAT/SPAWN are the five
`host_intercepted_syscalls`. The genuine host floor is
`WebAssembly.compile`/instantiate, fresh Store-local function/tag/GC
identity creation, and holding real JavaScript objects for externref —
state the Rust kernel structurally cannot serialize. Only ~2,300 lines
are movable POSIX semantics (fork state-machine sequencing, vfork
disposition, shebang resolution, thread-exit ordering, trap-to-signal
mapping).

### Homebrew is cleanly separable

The 27 `homebrew-*.ts` files (~21,200 lines) are a *producer* layer that
builds image bytes and generic lazy-tree entries; none implement POSIX
filesystem semantics. The only runtime boot-path coupling is a single
gated call, `prepareHomebrewFlatLazyBoot(memfs)` in
`browser-kernel-worker-entry.ts`, which early-returns when image metadata
lacks the `homebrewFlatLazy` key. Dependency direction is homebrew →
core; no core VFS semantics are reachable only through homebrew. Pruning
is low-risk.

## Architecture approaches considered

"The host boundary" is really two sub-boundaries, and conflating them is
where designs go wrong.

- **Sub-boundary 1 — Guest ↔ Kernel (the syscall path).** Today the host
  sits *in the middle*: the kernel is a separate Wasm instance with its
  own memory and cannot read guest pointer args directly, so the host
  copies pointer bytes per `SYSCALL_ARG_DESCRIPTORS`. That mediation is
  the entire reason TypeScript interprets guest ABI.
- **Sub-boundary 2 — Kernel ↔ Host (the ~82 capabilities).** Real
  filesystem bytes, time, random, net, futex, timers, invoking guest
  signal handlers, graphics/audio. These are genuine capability leaves.

### Sub-boundary 1: opaque, self-marshalled syscall records

The chosen move: the **guest glue self-marshals its pointer arguments
into the channel's data region as a self-describing bounded record; the
host transports that opaque region blindly; the Rust kernel decodes it.**
Marshalling knowledge moves out of the host and into the guest glue plus
the kernel — the two components that are ABI-locked together anyway. The
host becomes a byte transporter. Large transfers keep using the ABI-43
capacity-bound kernel-scratch mechanism.

Alternative considered and rejected: give the kernel direct access to
guest memory as a second imported memory. Rejected because multi-memory
portability across browser engines is a real risk and it re-introduces
host-mediated memory handles per call. Guest self-marshalling needs no
new engine features.

### Sub-boundary 2: a Rust-defined capability contract

Three encodings were compared.

| Encoding | Fit | Cost |
|---|---|---|
| (A) Rust `HostCapabilities` trait, rendered as versioned Wasm imports (browser/Node) and a native trait impl (native host) | Matches the existing flat `env` import surface; zero per-call overhead for sync leaves; native host is literally the same trait; discovery via the existing host-adapter manifest | Async capabilities need an explicit mechanism; the import list is versioned surface |
| (B) Action/completion command queue with opaque handles for everything | Uniform, naturally async, handles fit the untrusted-kernel model | Adds a queue round-trip to the syscall hot path — the performance contract warns against exactly this in `kernel-worker.ts`. Queuing synchronous `getrandom`/`clock_gettime` is latency for no benefit |
| (C) WIT / Component Model interface | IDL with generated bindings | The brief says not to assume browser Component Model support; adds a toolchain and an indirection the two hosts cannot natively run today. Premature |

**Chosen: (A) as the spine, with a narrow command/completion channel
reserved only for genuinely asynchronous capabilities** — storage that
must await fetch/OPFS, networking, timers, and worker creation. For
those, the **kernel owns the pending-operation state** (reusing the
`crates/kernel/src/blocked_retry.rs` token machinery), the host performs
the effect and signals completion, and authoritative state never returns
to JavaScript. Synchronous leaves stay direct calls, so there is no
syscall-hot-path regression.

## Recommended end-state architecture

### Crate layout

```
crates/
  shared/          ABI constants, syscall numbers, channel layout,
                   ABI 44 snapshot source
  runtime-core/    NEW. Engine-agnostic POSIX runtime + the record
                   decoder + the HostCapabilities trait. All pub mods
                   that today live in crates/kernel.
  kernel/          Shrinks to the Wasm FFI shell: wasm_api.rs + dlmalloc
                   + rendering HostCapabilities as `env` Wasm imports.
                   Depends on runtime-core.
  host-native/     NEW. Wasmtime host: loads kernel.wasm, impls
                   HostCapabilities natively, runs guests as Wasmtime
                   instances over a native shared-memory channel.
  fork-instrument/ Host-side guest-module transform (role unchanged; its
                   section formats become decoded by runtime-core instead
                   of by ~24k lines of TypeScript).
```

### The runtime data path (identical on all three hosts)

```
guest wasm --self-marshalled opaque record--> SAB channel
                                                 | (host transports blindly)
                                                 v
                                   kernel.wasm -> runtime-core::decode + execute
                                                       |
                                     +-----------------+------------------+
                                 sync leaf                            async op
                            HostCapabilities::                  submit -> completion channel
                            clock/random/blob_read/...          (kernel owns pending-op table;
                            (direct call, no queue)              host performs; wakes via retry token)
                                     |                                    |
                         browser adapter / Node adapter / native (Wasmtime)
                                     -- all implement the SAME trait --
```

### How each frontier resolves

**A. Transport.** `host_abi.rs` and `channel_scalar.rs` are removed from
the host data path. The `kernel-worker.ts` `#handleSyscallInner` dispatch
collapses to handing the opaque channel region to `kernel_handle_channel`.
The required `kernel_*` exports shrink toward `kernel_handle_channel` plus
lifecycle. `host/src/generated/abi.ts` is no longer consumed for runtime
dispatch.

**B. Blocking / readiness.** `runtime-core` owns poll/select/epoll/futex/
flock readiness *decisions*; the host provides only a `wait(timeout)` /
`wake` capability (`Atomics.waitAsync` in browser/Node; futex or condvar
natively). `epoll_pwait` stops bypassing the kernel. Readiness is Rust;
asynchronous waiting is a host capability.

**C. VFS backend.** `runtime-core` owns the filesystem — inodes,
metadata, mount routing, EXDEV, tar/zip/image parsing, lazy-tree
descriptors, materialization, and seal verification. The ~36 filesystem
imports collapse to a few byte-leaf capabilities: `blob_read`,
`blob_write`, `blob_stat` (OPFS/Node fs) and `fetch(url) -> bytes` (lazy
assets). Lazy materialization runs through the async completion channel:
the syscall blocks on a retry token until bytes arrive, and Rust verifies
the seal. Safari worker-exclusivity is preserved because filesystem state
lives in the worker's kernel; the host only moves bytes.
`MemoryFileSystem` and `VirtualPlatformIO` are deleted.

**D. Fork / exec (last, severable).** `runtime-core` *directs* fork and
*decodes* the `fork-instrument` section formats (the ~24k TypeScript codec
lines become Rust). The `HostCapabilities` trait exposes the irreducible
engine-floor operations — compile/instantiate a module, create and hold
engine references, reconstruct engine state — which the native host must
also implement. Whatever cannot be expressed engine-agnostically stays as
a per-host capability implementation and is the signal for whether D
fully lands or is severed.

### Version negotiation, discovery, limits, cancellation, failure

The existing Rust-owned host-adapter manifest (`abi/snapshot.json`
`host_adapter`) is extended to carry ABI 44, the `HostCapabilities`
contract version, a capability-discovery bitset (which optional
capabilities the host provides), resource limits, and a channel-layout
checksum. The host validates the manifest at init and **fails loudly** on
mismatch; there is no silent fallback. Cancellation and failure ride the
same completion channel: every async operation is cancellable via its
retry token, and an unsupported capability returns a defined error, never
a simulated success.

## Security analysis: the guest self-marshalled path

Moving marshalling authorship from the host to the guest glue does not
increase host-escape risk, and is arguably a net improvement.

- The guest already fully controls its own argument bytes and channel
  contents; it is untrusted Wasm. Authoring the record gives it no new
  power over data it already owned.
- The parser moves from ~40 bespoke per-syscall TypeScript marshalling
  paths to one Rust record decoder. A single, fuzzable, auditable decoder
  is a smaller attack surface than many hand-written struct readers.
- The true security boundary does not move. The kernel still cannot do
  anything the host does not grant via the capability contract. Per
  decision #3 the kernel is (eventually) untrusted sandboxed Wasm, so a
  decoder bug corrupts the kernel's own state — a POSIX-correctness or
  denial-of-service bug — and cannot escape the Wasm sandbox or exceed
  host-granted capabilities.

Two properties become explicit, tested requirements (they are
obligations today, merely relocated):

1. **The record is fully untrusted input.** The decoder validates every
   offset, length, and count against the bounded buffer, rejects
   out-of-range and overlapping spans, caps counts (for example iovec),
   and uses checked arithmetic. It **must be fuzzed and property-tested**;
   it becomes the load-bearing validator.
2. **Read-once-then-validate.** The channel SharedArrayBuffer is shared;
   a second guest thread can mutate it while the kernel reads
   (time-of-check to time-of-use). The decoder copies in once and
   validates the copy, never re-reading the shared buffer after
   validation.

The one property that genuinely changes: today the host is an incidental
second validator between guest and kernel. In the new model the kernel
decoder is the sole validator. This is acceptable — it concentrates
validation somewhere auditable and fuzzable, and the Wasm sandbox plus
capability policy remain the real perimeter — but it is why requirements
(1) and (2) are mandatory rather than best-effort.

## Native reference host on Wasmtime

Wasmtime supports what the kernel needs: the threads proposal (shared
memory and `memory.atomic.wait32`/notify), bulk-memory, mutable-globals,
imported/exported memory, and custom host functions with no WASI (the
kernel imports only the `env` `host_*` surface, provided directly as the
`HostCapabilities` implementation). No Component Model or WASI Preview is
required. The kernel and each guest run on their own OS threads,
mirroring the worker topology, sharing a native `SharedMemory` for the
channel.

**The conformance host loads the same `kernel.wasm` in Wasmtime**, not
the kernel as a native rlib. Decision #2 requires that an image may
supply its own Wasm kernel, so the native host must run a Wasm kernel
regardless. Running the real artifact, the real ABI, and the real channel
on a third, non-JavaScript engine is what proves the boundary is not
secretly JavaScript-shaped. This is the **freeze gate** (decision #4).
The kernel-as-native-rlib path (possible because the core already
compiles native) remains valuable as a "core is a reusable library" proof
and a potential trusted-built-in-kernel fast path, but it is secondary.

The Wasmtime host is also the acid test that each frontier's boundary is
truly host-agnostic. Porting fork to Wasmtime forces an engine-agnostic
fork capability: no externref-holding tricks and no WebKit-specific
workarounds (the anyref-transit module, `Module.imports()` compatibility).
If fork's boundary cannot be expressed without JS-engine-specific
behavior, Wasmtime exposes it loudly, before any freeze.

### Feasibility spike (2026-08-25) — PASSED

A throwaway Wasmtime harness confirmed the native host has no
engine-feature blockers, measured against the real built kernel
(`local-binaries/kernel.wasm`, ABI 43). Both parts passed on
**Wasmtime 35**:

- **Part 1 — instantiate the real artifact.** Wasmtime compiled and
  instantiated the actual `kernel.wasm` and `__abi_version()` returned
  `43`. Observed import surface the native host must provide: `env.memory`
  is an **imported shared memory, initial = 18 pages, max = 16384 pages
  (1 GiB)**; there are **83 `env.host_*` function imports** (all
  satisfiable — the spike stubbed them via
  `Linker::define_unknown_imports_as_traps`, and `__abi_version` touches
  none). Threads, bulk-memory, and mutable-globals were all accepted.
- **Part 2 — the syscall-channel blocking primitive.** Two instances on
  two OS threads shared one `wasmtime::SharedMemory`; a waiter blocked on
  `memory.atomic.wait32(addr, expected, -1)` and a notifier on the other
  thread woke it with `memory.atomic.notify(addr, 1)`. The notify woke
  exactly one waiter and `wait32` returned `0` (woken). This is the exact
  guest-blocks / kernel-wakes handshake the channel depends on.

Implications for `crates/host-native`: create a `SharedMemory` of type
`MemoryType::shared(18, 16384)`, define it as `env`/`memory`, implement
the 83 `host_*` imports as the `HostCapabilities` trait, and run the
kernel and each guest on their own OS threads over that shared memory. No
Component Model, no WASI. The kernel-as-Wasm topology (not native rlib) is
what the freeze gate must exercise.

Reproducible harness (kept out of the tree; recreate under `/tmp` to
re-run — `cargo run -- <path-to-kernel.wasm>`):

```toml
# Cargo.toml
[package]
name = "kandelo-wasmtime-spike"
version = "0.0.0"
edition = "2021"
[dependencies]
wasmtime = "35"
```

```rust
// src/main.rs
use std::thread;
use std::time::Duration;
use wasmtime::{Config, Engine, Linker, MemoryType, Module, SharedMemory, Store};

fn main() -> wasmtime::Result<()> {
    let mut config = Config::new();
    config.wasm_threads(true);
    let engine = Engine::new(&config)?;

    // Part 1: instantiate the real kernel.wasm.
    let path = std::env::args().nth(1).expect("usage: spike <kernel.wasm>");
    let module = Module::from_file(&engine, &path)?;
    let shared = SharedMemory::new(&engine, MemoryType::shared(18, 16384))?;
    let mut store = Store::new(&engine, ());
    let mut linker = Linker::new(&engine);
    linker.define(&mut store, "env", "memory", shared.clone())?;
    linker.define_unknown_imports_as_traps(&module)?; // stub the 83 host_*
    let instance = linker.instantiate(&mut store, &module)?;
    let abi = instance.get_typed_func::<(), i32>(&mut store, "__abi_version")?;
    assert_eq!(abi.call(&mut store, ())?, 43);

    // Part 2: cross-thread atomic wait/notify on one SharedMemory.
    let wat = r#"(module
        (import "env" "memory" (memory 1 10 shared))
        (func (export "wait") (param i32 i32) (result i32)
          (memory.atomic.wait32 (local.get 0) (local.get 1) (i64.const -1)))
        (func (export "notify") (param i32) (result i32)
          (memory.atomic.notify (local.get 0) (i32.const 1))))"#;
    let m2 = Module::new(&engine, wat)?;
    let shm = SharedMemory::new(&engine, MemoryType::shared(1, 10))?;
    unsafe { std::ptr::write_volatile(shm.data().as_ptr() as *mut u8, 0u8) };
    let waiter = { let (e, m, s) = (engine.clone(), m2.clone(), shm.clone());
        thread::spawn(move || -> wasmtime::Result<i32> {
            let mut st = Store::new(&e, ()); let mut lk = Linker::new(&e);
            lk.define(&mut st, "env", "memory", s)?;
            let i = lk.instantiate(&mut st, &m)?;
            i.get_typed_func::<(i32, i32), i32>(&mut st, "wait")?.call(&mut st, (0, 0))
        }) };
    thread::sleep(Duration::from_millis(300));
    let mut st = Store::new(&engine, ()); let mut lk = Linker::new(&engine);
    lk.define(&mut st, "env", "memory", shm.clone())?;
    let i = lk.instantiate(&mut st, &m2)?;
    let woke = i.get_typed_func::<i32, i32>(&mut st, "notify")?.call(&mut st, 0)?;
    assert_eq!(woke, 1);
    assert_eq!(waiter.join().unwrap()?, 0);
    println!("spike PASS: kernel.wasm abi=43; cross-thread wait/notify OK");
    Ok(())
}
```

## Migration roadmap

A single big-bang integration branch, curated into conceptually separate
commits and rebase-merged. Sequencing: prune first, flip transport early,
then stand up the native host so it becomes the continuous acid test for
everything after it.

| Phase | Goal | Key commits | Green | ABI / parity |
|---|---|---|---|---|
| 0. Decouple homebrew | Remove ~21k churny lines from the rebase surface | Delete the gated boot call, `homebrew-flat-lazy-boot.ts`, and the metadata branch; strip barrel re-exports; drop homebrew consumers of the generic deferred-tree/materialization APIs (kept in core) | per-commit | No ABI change; non-homebrew demos boot; Node+browser parity |
| 1. Crate split + trait | Make "core is a library" structurally true | 1.1 move POSIX `pub mod`s to `crates/runtime-core`; `crates/kernel` becomes the FFI shell. 1.2 define `HostCapabilities` = the exact current ~82 `host_*` surface; `wasm_api.rs` renders it | per-commit | Pure refactor; `kernel.wasm` builds identically |
| 2. Opaque transport (A) | Host out of the syscall data path | Atomic commit: guest self-marshals record (`channel_syscall.c`) + `runtime-core` decoder (fuzzed + property-tested) + host transports blindly + delete `host_abi.rs`/`channel_scalar.rs` from data path + bump ABI 44 + regen snapshot + rebuild musl | per-commit, one large atomic commit | The one unavoidable hard cutover |
| 3. Native (Wasmtime) host | Third-engine conformance + acid test | `crates/host-native`: load real `kernel.wasm`, impl `HostCapabilities` natively (sync leaves + minimal FS/clock/random), run a trivial image through the channel; native smoke suite | per-commit | Implements only the opaque transport; runs continuously against B/C/D |
| 4. Blocking/readiness (B) | Readiness to Rust, waiting to host | 4.1 add Rust readiness (poll/select/epoll/futex/flock) + `wait(timeout)`/`wake` capability + async completion-channel infra (kernel owns pending-op table). 4.2 delete TS reimpls + epoll-as-poll bypass | per-commit, add-then-remove | `epoll_pwait` stops bypassing the kernel; parity on all 3 hosts |
| 5. VFS backend (C) | FS authority to Rust; byte leaves stay host | 5.1 `runtime-core` FS serves syscalls; add `blob_read/write/stat` + `fetch->bytes`. 5.2 move tar/zip/image/lazy-tree/materialization/seal verification to Rust (async lazy via completion channel). 5.3 delete `MemoryFileSystem` + `VirtualPlatformIO`; collapse FS imports to byte leaves | per-commit where possible; FS-authority switch may be one atomic commit per host | Preserve Safari worker-exclusivity + closed-asset-set; parity + WebKit package-tree spec |
| 6. Fork/exec (D) — LAST, SEVERABLE | Fork directed by Rust; engine floor as capability | 6.1 decode `fork-instrument` section formats in `runtime-core`; define engine-floor capabilities; native host implements them. 6.2 migrate the ~24k TS codec lines into Rust | green-at-tip acceptable | If it stalls or the engine floor cannot be expressed host-agnostically → sever; phases 0–5 still ship |
| 7. Finalize / freeze gate | Prove decision #4 | Extend the host-adapter manifest (ABI 44, capability-discovery bitset, resource limits, channel checksum); full conformance on browser+Node+native; benchmarks before/after on Node+browser; curate history → rebase-merge | tip green | Same image boots browser + Node + native = boundary freeze candidate |

Critical-path dependencies: 0 → 1 → 2 → 3, then 3 gates 4 → 5 → 6, each
validated against the native host as it lands. The async
completion-channel infrastructure (phase 4) is shared by B, C, and
networking. D is a leaf; nothing depends on it, which is why it is
severable.

**Severance outcome.** If D is cut, the shipped result is: opaque
transport, Rust-owned VFS and blocking, native host, ABI 44 — every
structural completion criterion except "fork is Rust-directed." Fork
remains the one subsystem where TypeScript still interprets guest-module
layout, documented as the known remaining frontier: a truthful boundary,
not a hidden one.

## Completion criteria for "Rust-first"

Each criterion is verifiable, not aspirational.

1. **TypeScript no longer interprets guest ABI for dispatch.**
   `host_abi.rs`/`channel_scalar.rs` are gone from the host data path;
   `host/src/generated/abi.ts` is not imported by any runtime dispatch
   path. Verify by grep and by confirming `#handleSyscallInner` no longer
   branches on syscall numbers.
2. **A guest ABI bump touches TypeScript only if it adds a new host
   capability.** Verify with a test ABI change that reshapes a syscall's
   marshalling (no new capability): it requires zero edits under
   `host/src/` and still passes conformance. Only a change that adds a
   `HostCapabilities` method requires host edits.
3. **Browser, Node, and native run the same `runtime-core`.** Verify all
   three link the identical crate and the same VFS image plus `kernel.wasm`
   boots on all three.
4. **Node/browser parity is tested at every green commit**, not just the
   tip. Verify the shared Vitest and Playwright parity suites pass per
   phase; no Node-only or browser-only landing.
5. **Unsupported capabilities fail explicitly.** Verify a host that omits
   an optional capability produces a defined error at the manifest
   handshake or a defined errno at the call — never a simulated success. A
   negative test asserts this.
6. **Performance claims are backed by the required benchmarks** on both
   Node and browser, before/after. No "faster" or "no regression"
   statement ships without `benchmarks/run.ts` evidence on both hosts.
7. **The record decoder is fuzzed and property-tested** and enforces
   read-once plus full bounds validation.

## Performance and reliability forecast

This is a pre-implementation forecast — a prediction, not a measurement.
Per the performance contract, each item states mechanism, expected
direction and magnitude, the risk it goes the other way, and the
benchmark that settles it. Nothing here is a claim; all of it must be
measured before/after on Node and browser.

### Performance

| Change | Mechanism | Expected | Regression risk | Validated by |
|---|---|---|---|---|
| A. Opaque transport | Host stops per-syscall descriptor interpretation, multiple small DataView copies, and arg-slot rewrites; guest does one native memcpy; kernel decodes in Rust | Neutral-to-faster on the host hot path, but syscall latency is dominated by the Atomics handshake and worker wakeup, so likely small / near-noise except for pointer-heavy syscalls (readv/writev/sendmsg) | Per-record header overhead on tiny syscalls; whole-record copy vs. selective copy | Syscall micro-benchmarks + app benchmarks, both hosts |
| C. VFS in Rust | In-memory FS ops (the common case) stop making a kernel→JS round-trip per open/read/write/stat/readdir | Faster, potentially significant for FS-heavy workloads (builds, package installs, many small files) | A naive Rust FS data structure could underperform the tuned JS `MemoryFileSystem`; wasm linear-memory growth | FS-heavy app benchmarks + syscall benchmarks; memory profiling |
| B. Blocking/readiness in Rust | Readiness computed in Rust; epoll stops round-tripping through JS poll-conversion | Neutral-to-faster for epoll/poll-heavy servers (nginx); dominant async-wait cost unchanged | Wait/wake handoff latency; a missed wakeup is a hang | Server benchmarks (nginx/WordPress), both hosts |
| Boot | `kernel.wasm` grows (VFS + fork codecs move in) → larger module to compile/instantiate | Boot time may regress slightly | Larger module compile on WebKit | Boot-time measurement on all 3 hosts; watch Safari |

Net performance forecast: the design removes per-syscall JavaScript work
and kernel→JS round-trips, directionally aligned with the performance
contract's own priorities. Predicted neutral-to-positive overall, largest
wins on FS-heavy and epoll-heavy workloads, with the real regression
risks being a naive Rust FS, tiny-syscall record overhead, and
`kernel.wasm` size affecting boot and memory. Measured before any claim.

### Reliability

Expected improvement (structural): POSIX semantics stop being split
across Rust state and TypeScript policy/marshalling/FS, collapsing a whole
class of Rust/TypeScript divergence bugs. One memory-safe implementation
shared by all hosts makes Node/browser parity structural rather than
hand-maintained (the docs cite one-sided-fix failures in PR #388 and PR
#410). The fuzzed record decoder replaces ~40 ad-hoc TypeScript
marshalling paths.

Concentrated short-term risk (integration): the big-bang defers
integration benefits to the end; a deep bug surfaces late. The atomic
transport flip touches every syscall, so a decoder bug is universal. The
wait/wake handoff is the classic missed-wakeup-hang risk. Fork (D) is the
highest-risk area because engine-state reconstruction is fragile.

How the plan manages it: per-commit green plus the native (Wasmtime) host
as a continuous third-engine acid test, full conformance suites
(libc/posix/sortix) at each phase, decoder fuzzing, targeted wakeup stress
tests, and D kept severable so its risk cannot sink A–C. Moving Safari's
filesystem deeper into the already-worker-exclusive kernel realm is
consistent with the existing out-of-memory fix, but must be verified.

Net reliability forecast: long-term improvement (one fuzzed, memory-safe
implementation; structural parity) with concentrated short-term
integration risk that the phasing, native-host acid test, and conformance
gates are designed to contain.

## Validation plan

Per the validation contract, evidence must match the claim. Suites, run
via `scripts/dev-shell.sh`:

- Workspace Rust tests (`cargo test --workspace --exclude xtask`) — every
  `crates/` change, including `runtime-core` unit tests as a native rlib.
- `cargo test -p xtask` — ABI generation and package-system automation.
- Host integration (`cd host && npx vitest run`) — host runtime behavior.
- Browser (`apps/browser-demos`, Playwright, chromium; plus the
  package-deferred-tree spec on chromium/firefox/webkit) — browser host,
  VFS image, lazy/eager parity, Safari.
- Conformance: `scripts/run-libc-tests.sh`, `scripts/run-posix-tests.sh`,
  `scripts/run-sortix-tests.sh --all` — required for phases 2, 4, 5, 6
  (syscall, VFS, blocking, fork semantics).
- ABI: `scripts/check-abi-version.sh` after regenerating the snapshot at
  the ABI 44 bump; plus manual semantic review (the snapshot is necessary
  but not sufficient).
- Native: a new `crates/host-native` conformance suite booting the same
  images used by the browser and Node hosts.
- Performance: `benchmarks/run.ts` on Node and browser, before/after, for
  any performance claim.

Build ordering reminders: `bash build.sh` does not rebuild musl — run
`scripts/build-musl.sh` after editing `libc/musl-overlay/` or
`libc/glue/channel_syscall.c` (phase 2). Rebuild `kernel.wasm` before
Vitest and conformance runs; stale wasm silently runs old code.

## Risks and mitigations

- **Fork host floor (D).** May not be fully expressible engine-agnostically.
  Mitigation: sequenced last, severable; the Wasmtime host forces the
  engine-agnostic contract early.
- **Branch drift over an active main.** The churny files overlap the
  rewrite. Mitigation: prune homebrew first; periodic rebases; a short
  freeze near the end.
- **Atomic transport flip is universal.** A decoder bug affects every
  syscall. Mitigation: fuzzing, property tests, and full conformance at
  that commit.
- **Missed-wakeup hangs (B).** Mitigation: targeted wakeup stress tests;
  keep the kernel authoritative over pending-op state.
- **Safari memory/boot.** Larger `kernel.wasm`. Mitigation: measure boot
  and memory on WebKit; the FS is already worker-exclusive.

## Decisions settled during design review (2026-08-25)

- **Homebrew is removed, not migrated, as a separate standalone PR.**
  `./run.sh browser` and `./run.sh local-build` both go through
  `cmd_local_build` (source-only; `homebrew-bootstrap` is a forbidden
  input), and `prepare_browser_homebrew_bootstrap` is dead code. A
  `local-build` baseline built all 7 formerly-homebrew products
  (`browser-nginx`, `nginx-php`, `wordpress`, `node`, `lamp`,
  `main-shell`, `platform-rootfs`) source-only, proving the
  `[[software.homebrew]]` blocks are vestigial. Ruby (and all real
  packages) are kept. Branch: `brandonpayton/remove-homebrew` off `main`.
- **Branch sequencing:** land the homebrew-removal PR first, rebase the
  rust-first branch onto homebrew-free `main`, then start Phase 1. This is
  the churn-reduction the roadmap's "prune first" step intends.
- **Transport marshalling shape (refines Frontier A / Q6):** the guest
  glue marshals each syscall's args INLINE — each libc/musl wrapper
  statically knows its arg types, generated from `crates/shared`. The
  `host_abi.rs` `SYSCALL_ARG_DESCRIPTORS` table does NOT move to the guest
  as a runtime table; it DISSOLVES into per-syscall glue. The host holds
  zero descriptor knowledge; the kernel decodes the self-describing record
  by syscall number. (Reconsiderable, but the chosen starting shape.)
- **Native host feasibility: confirmed** (see the Wasmtime spike above).
  `crates/host-native` has no engine-feature blockers.
- **Phase 1 crate split is largely mechanical:** the `HostCapabilities`
  contract already exists as the `HostIO` trait
  (`crates/kernel/src/process.rs`), implemented by `WasmHostIO` and test
  mocks. One pre-refactor is required: relocate 6 cross-process `procfs_*`
  helpers and two `include_str!("wasm_api.rs")` guard tests out of the
  core → shell dependency direction. See
  `docs/superpowers/plans/2026-08-25-rust-first-phase1-crate-split.md`.

## To resolve during implementation planning

- The concrete self-describing record wire format and its bound relative
  to the 64 KiB data buffer and the capacity-bound scratch path (the
  marshalling *shape* is settled above; the byte layout is not).
- The exact `HostCapabilities` trait method set after FS-import collapse
  and the sync-vs-async split.
- The async completion-channel protocol details (submission, completion,
  cancellation) layered on the existing retry-token machinery.
- The `runtime-core` module boundary extracted from `crates/kernel`.
- The fork engine-floor capability surface and the severance decision
  procedure.
