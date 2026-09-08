# Host Runtime Contract

The host runtime is part of the platform, not demo scaffolding. It owns worker
lifecycle, Wasm instantiation, process memory, syscall channel dispatch,
blocking retry, VFS/network/device adapters, process-worker launch, and the
Node/browser bridge to platform APIs. Changes here can change POSIX behavior
even when kernel Rust code is untouched.

The kernel must run in a dedicated worker on every host. `CentralizedKernelWorker`
must not be instantiated on the main thread. The main thread is a proxy for
setup, UI, and I/O routing; it is not the syscall engine.

Node.js and browser hosts are peers. A host-runtime behavior change is
incomplete until both hosts have the same platform-observable behavior or the
difference is explicitly justified by a real platform boundary. Do not land
Node-first or browser-later host changes.

Before and after host work, ask: "What does this look like on the other host?"

| Concern | Node.js | Browser |
|---|---|---|
| Host proxy | `host/src/node-kernel-host.ts` | `host/src/browser-kernel-host.ts` |
| Kernel-worker entry | `host/src/node-kernel-worker-entry.ts` | `host/src/browser-kernel-worker-entry.ts` |
| Worker adapter | `host/src/worker-adapter.ts` | `host/src/worker-adapter-browser.ts` |
| Process-worker runtime | shared `host/src/worker-main.ts` | shared `host/src/worker-main.ts` |
| Kernel worker | shared `host/src/kernel-worker.ts` | shared `host/src/kernel-worker.ts` |

Worker protocols are contracts. Spawn, fork, exec, clone, exit, terminate,
thread exit, crash, syscall trace, PTY, framebuffer, audio, network, VFS, and
service-worker messages must have symmetric request, response, error, and
cleanup behavior. A missing message handler is a platform bug.

Stdio descriptor type is chosen when the process is created. Hosts that launch
without a PTY must create fds 0, 1, and 2 as pipe-backed descriptors so
`isatty()` and terminal ioctls observe non-terminal semantics; hosts that
allocate a PTY must create terminal descriptors and then attach the PTY before
user code runs. Do not create terminal-like stdio and repair it later.

Failure must surface. Wasm traps, worker crashes, failed exec/spawn, missing
binaries, ABI mismatches, service-worker failures, blocked retries, and process
exits must become observable errors, exit statuses, or logs through the normal
host APIs. Silent hangs are contract failures.

Browser restrictions are real platform boundaries, not excuses for different
semantics where parity is possible. Browser-specific code may handle
cross-origin isolation, service workers, OPFS, fetch bridges, canvas, audio,
pointer lock, and unavailable raw sockets, but POSIX-visible behavior should
match Node unless documented otherwise.

Shared files are cross-host changes by default. Changes to
`host/src/kernel-worker.ts`, `host/src/worker-main.ts`, VFS behavior,
networking, framebuffer, generated ABI constants, or worker protocol types need
Node and browser consideration even when only one host-specific file changed.

`BrowserKernel` is host/runtime code. Browser demos consume it; they do not own
it. Fix runtime bugs in `host/src`, not inside demo pages, unless the bug is
truly presentation-specific.

## Rust-first for kernel and fork control flow

Kernel and fork control flow are Rust-first. Do NOT add kernel or fork
control-flow TypeScript unless it is the irreducible host floor:

- worker spawn and lifecycle,
- the `fork()`/`vfork()` syscall + the syscall-channel transport,
- `resolve_externref(handle) -> externref` identity materialization (the one
  true engine-floor seam),
- anyref-transit `Table.grow` sizing (host must grow STORE #2 before drive),
- PIC placement globals (`__memory_base`/`__stack_pointer`/`__table_base`/
  `__indirect_function_table`) chosen at instantiation,
- the resume `WebAssembly.Table` (host-built import of guest funcref thunks),
- the guest run-loop + the fork-unwind exception catch (a JS-level throw a Wasm
  module cannot `try/catch`), and
- the Node/browser worker-message bridges.

New capture/replay/orchestration logic belongs in the Rust fork-module
(`crates/fork-module`) and `crates/fork-codec`, driven through the `fm_*`
host↔module contract — not in new TypeScript sequencing in
`host/src/fork-module-backend.ts`, `host/src/fork-process-continuation.ts`, or
the fork paths of `host/src/worker-main.ts`. The `fm_*` surface is the internal
host↔module contract (rebuilt in lockstep with the module), NOT the guest ABI;
the frozen guest contract is the `__wpk_fork_*` exports and `kandelo.wpk_fork.*`
custom sections. Prefer a coarse module entry that sequences guest-export drive
steps over a new host-side call sequence.

The direction of travel is one way: this TS glue shrinks toward the floor over
time (see `docs/plans/2026-09-08-fork-controlflow-into-module-scope.md`); it does
not grow. When you face a dilemma about whether something must be TypeScript,
STOP and discuss with the maintainer rather than growing the host surface.
