# Debugging And POSIX Contract

## Debugging

Fix the platform failure, not the presentation of the failure. A bug is not
understood until the failing path has been traced to its real layer: user
program, package artifact, VFS image, SDK/libc glue, syscall semantics, kernel
state, host runtime, Node/browser adapter, service worker, or UI.

Generic symptoms are not root causes. Treat messages like `Segmentation fault`,
`Maximum call stack size exceeded`, hung panes, missing binaries, silent worker
exits, blocked `waitpid`, or empty browser output as entry points for
investigation. Before editing behavior, identify what operation failed, which
process issued it, which syscall or host operation carried it, and where the
expected state diverged from actual state.

Prefer evidence from the normal runtime path: package resolver output, VFS
image contents, browser console/page errors, service-worker request failures,
worker exit/crash messages, syscall traces, kernel process/fd/VFS state, and
minimized C or package-level repros. A test that only asserts final UI text is
weak evidence unless the bug is actually in UI rendering.

Do not special-case outputs, preset buttons, wrapper scripts, terminal
transcripts, package launchers, or demo state to hide a platform defect. A demo
may adapt presentation to product requirements, but it must not become an
alternate implementation of runtime behavior.

Standard triage shape:

1. Reproduce through the normal path.
2. Identify the failing layer.
3. Reduce to the smallest platform behavior that is wrong.
4. Fix shared behavior at the lowest correct layer.
5. Validate both the original user-visible symptom and the lower-level
   contract.
6. Report what was run and what was not run.

## POSIX And Process

Kandelo presents an OS contract to user programs. Syscalls, libc glue, process
lifecycle, file descriptors, signals, memory, devices, and VFS behavior must be
implemented as platform behavior, not accommodations for a particular package.

Start from POSIX semantics. POSIX conformance is the north star. Linux
compatibility is valuable, but secondary: when multiple designs are equivalent
for POSIX correctness, internal integrity, maintainability, and performance,
prefer the design that best matches Linux-observable behavior. Preserve
documented errno values, blocking behavior, inheritance rules, atomicity
guarantees, ownership, permissions, and observable state. If Kandelo
intentionally diverges, document the divergence in `docs/posix-status.md` or
the relevant architecture doc.

A POSIX gap should stay visible as a platform gap until it is implemented. Do
not convert an unsupported or partially supported API into silent success just
because that lets a package continue. Stubs must be honest: return the correct
failure mode for unsupported behavior unless the API's correct compatibility
behavior is a no-op.

Process state is authoritative. `fork`, `exec`, `posix_spawn`, `clone`, `exit`,
`waitpid`, process groups, sessions, credentials, CWD, umask, rlimits, signal
dispositions, fd tables, OFDs, locks, sockets, PTYs, memory layout, and
zombie/reaping state must remain coherent across transitions.

The Rust `ProcessTable` is the sole PID/TID authority. Its one monotonic task-ID
sequence allocates top-level process, fork, spawn, and clone identities; host
code and callbacks may only consume those assigned IDs and attach worker state.
Do not add a host allocator, caller-selected identity, collision-retry loop, or
watermark API. PID 1 remains the kernel-created synthetic init
reservation, outside the user task sequence that starts at 100.
Keep this boundary compile-enforced inside Rust: production process and thread
construction must consume the opaque allocation token minted by `ProcessTable`,
identity fields and thread membership must remain read-only elsewhere, and raw
caller-selected constructors may exist only as `cfg(test)` fixtures. Fork-state
deserialization must populate a process whose identity was already allocated;
it must not accept or construct a child PID independently.
Host-transported caller TIDs must be validated against the parent process's live
kernel task records before fork, spawn, clone, or exact-thread signaling; they
identify existing state and never delegate allocation authority. An unknown,
exited, or
cross-process exact-thread target must fail with `ESRCH`, not fall back to a
process-wide operation. A host channel that cannot bind to a task while its
kernel Process is live is a fatal host/kernel protocol failure; do not turn it
into an ordinary guest `EIO` and continue. Channels retained only while an
already-Exited Process's Workers are being terminated may complete musl's final
exit handshake, but must never dispatch another syscall into that zombie.
Thread-channel attachment must consume a one-shot transport proof bound to the
exact TID returned by that clone allocation. Do not expose a numeric attachment
API that lets host code substitute another valid sibling TID, reuse a proof, or
map one task to multiple mailboxes.
Likewise, the host may publish a Worker crash only after Rust accepts the
signal-death transition, and a trapped kernel exit path must be checked for an
authoritative `Exited` state before the host wakes a parent or reports success.

`fork()` means continuation preservation. If a change touches fork, fork
instrumentation, pthread fork, fd/resource inheritance, signal state, or memory
copying, verify that the child resumes at the correct call site with correct
process state and that the parent observes correct wait/reap behavior.

`exec()` means replacement without identity loss. Preserve PID and inherited
open fds, close `FD_CLOEXEC`, reset exec-defined process state, install the new
binary's memory layout, and do not leak the previous program's heap, stack,
handlers, or host worker assumptions into the new image.

`posix_spawn()` may be non-forking, but it must preserve POSIX spawn semantics.
It must not silently fall back to fork unless the contract explicitly changes.
File actions, attrs, signal behavior, CWD, fd inheritance, and
rollback-on-failure must remain correct.

File descriptors and open file descriptions are real shared state. `dup`,
`fork`, `exec`, `close`, `fcntl`, locks, append mode, nonblocking mode,
pipe/socket readiness, and device ownership must operate on the correct fd/OFD
boundary. Do not paper over fd bugs in package code.

The VFS must report honest filesystem state. `/etc` files, package files, VFS
image contents, device nodes, symlinks, modes, uid/gid, and mount behavior
should be visible through ordinary filesystem operations. Do not add synthetic
answers that disagree with what a program can read from the filesystem.

Memory layout is part of the process contract. `brk`, `mmap`, `munmap`,
`mremap`, pthread control slots, fork-save areas, syscall channels, and
guest-visible exported globals must not overlap or rely on browser reloads,
garbage collection, or host cleanup timing for correctness.

Devices are kernel/platform behavior. PTYs, framebuffer, mouse, audio, random,
null/zero/full, procfs, shm, sockets, and service-worker bridges should behave
through normal file/syscall/device paths. Demo code may present devices, but
must not implement substitute device semantics.

## Rust-first for kernel and fork control flow

When debugging or extending fork, exec, clone, or kernel behavior, keep new
logic in Rust. Kernel and fork control flow are Rust-first: do NOT add kernel or
fork control-flow TypeScript unless it is the irreducible host floor (worker
spawn, the `fork()` syscall + syscall-channel transport, `resolve_externref`
identity materialization, anyref-transit `Table.grow` sizing, PIC placement
globals, the resume `WebAssembly.Table`, the guest run-loop + fork-unwind
exception catch, and the Node/browser platform bridges). New
capture/replay/orchestration logic belongs in the Rust fork-module
(`crates/fork-module`) and `crates/fork-codec`, driven through the `fm_*`
host↔module contract, not in new TypeScript sequencing.

A fork bug that seems to need more host-side sequencing is usually a signal that
the module should own that step. When you face a dilemma about whether something
must be TypeScript, STOP and discuss with the maintainer rather than growing the
host surface. See `docs/agent-guidance/host-runtime.md` for the full floor list.
