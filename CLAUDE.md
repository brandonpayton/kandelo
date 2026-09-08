# Kandelo Agent Guidance

This file is the loaded guidance for agents working in this repository. Treat
it as a contract router: it names the platform contracts that must be preserved
and points to the focused guidance and reference docs that carry the full
detail.

Kandelo is a POSIX-compatible multi-process kernel for WebAssembly. The project
is built around contracts between the platform and processes, between hosts and
the kernel, between packages and the build system, and between the platform and
users. When in doubt, identify which contract a change touches before editing.

If work touches a contract below, read the linked agent guide before making
substantive edits. The short rules here are the invariants agents must keep in
working memory; the linked files hold the operational detail.

## Platform Values Contract

Kandelo's north star is complete POSIX conformance for the system surface it
exposes. Known gaps and browser-imposed limits must be documented as gaps or
boundaries, not hidden behind package- or demo-specific behavior. Missing or
incomplete POSIX behavior is a platform gap to close, not permission to weaken
the model or add software-specific behavior.

Correct behavior must come from accurate internal system state. Process tables,
file descriptors, address spaces, signals, VFS metadata, devices, networking,
packages, and host adapters should reflect the real state of the system. Do not
shape terminal output, preset behavior, UI state, wrappers, or package scripts
to create the appearance of correctness when the underlying platform is wrong
or incomplete.

Prefer truthful failure over convenient illusion. A missing feature, failed
build, unsupported syscall, unavailable host capability, ABI mismatch, or stale
artifact should be visible as the real boundary it is, not disguised as success
through special-case behavior.

User software should build and run through the normal platform path: SDK, libc,
package resolver, VFS image, syscalls, host runtime, and kernel. A fix that
only makes one program, demo, package script, or button work is suspect unless
the special case is explicitly the product behavior being implemented.

When user software fails to build or run, first ask what the failure reveals
about Kandelo. Is a POSIX API missing? Is a syscall semantically wrong? Is
libc or the SDK misrepresenting the target? Is package resolution incomplete?
Is the VFS image wrong? Is Node/browser behavior diverging? Treat porting
failures as platform feedback before treating them as package quirks.

Workarounds are acceptable only at explicit compatibility boundaries: upstream
defects, browser sandbox limits, host platform constraints, unavailable
hardware capabilities, or intentionally unsupported behavior. A workaround must
document the boundary it belongs to and must not hide a platform defect.

Demos are consumers of Kandelo, not alternate implementations of Kandelo. Demo
code must not bypass, simulate, or paper over runtime, VFS, package, libc,
syscall, kernel, or host defects.

## Agent Work Loop

For nontrivial work:

1. Identify the contract touched.
2. Read the local implementation, the focused agent guide, and the relevant
   reference docs.
3. Trace root causes through the normal platform path.
4. Preserve Node.js/browser parity unless a documented platform boundary says
   otherwise.
5. Update the authoritative docs for any changed behavior.
6. Run validation that supports the exact claim you will make.
7. Report what changed, what was run, and what was not run.

Do not stop at code reasoning for browser demo bugs, syscall semantics, ABI
changes, package artifacts, or performance claims.

## Contract Map

| Contract | Agent guide | Reference docs |
|---|---|---|
| Validation and completion claims | `docs/agent-guidance/validation.md` | `docs/repository-organization.md` |
| Debugging, POSIX, process, VFS, devices | `docs/agent-guidance/debugging-and-posix.md` | `docs/architecture.md`, `docs/posix-status.md` |
| ABI versioning and snapshot policy | `docs/agent-guidance/abi.md` | `docs/abi-versioning.md`, `docs/fork-instrumentation.md` |
| Host runtime and Node/browser parity | `docs/agent-guidance/host-runtime.md` | `docs/architecture.md`, `docs/browser-support.md` |
| Package schema, builds, resolver, cache | `docs/agent-guidance/packages-and-builds.md` | `docs/package-management.md`, `docs/porting-guide.md`, `docs/sdk-guide.md` |
| Browser demos, VFS images, sharing, users | `docs/agent-guidance/browser-and-user.md` | `docs/browser-support.md` |
| Performance claims and benchmarks | `docs/agent-guidance/performance.md` | `docs/profiling.md` |
| Dev shell, docs, PR/final reports | `docs/agent-guidance/build-docs-and-prs.md` | `docs/repository-organization.md`, `README.md` |
| Rust-first kernel & fork control flow | `docs/agent-guidance/host-runtime.md`, `docs/agent-guidance/debugging-and-posix.md` | `docs/plans/2026-09-08-fork-controlflow-into-module-scope.md`, `docs/plans/2026-09-08-rust-first-fork-point-of-no-return.md` |
| Rust-first kernel migration (in progress) | — | `docs/plans/2026-09-04-rust-first-remaining-purpose-framed.md` (remaining work + the decision Bar), `docs/plans/2026-08-25-rust-first-runtime-design.md` |

## Validation Contract

Validation is evidence for a specific claim. Do not say "tests pass", "the
branch is complete", "the browser works", "ABI is fine", or "performance
improved" unless the evidence for that exact claim has been run and reported.

Do not use a narrow check to support a broad claim. A passing unit test does
not prove POSIX behavior. A passing Node/Vitest path does not prove browser
behavior. A passing browser demo does not prove ABI compatibility. A
micro-benchmark does not prove application performance.

Runtime/kernel changes are not fully validated until the relevant conformance
suites have been considered. If a change touches syscall behavior, process
lifecycle, memory layout, fd semantics, VFS semantics, signals, libc glue, or
ABI-adjacent code, do not stop at unit tests and Vitest.

Browser-facing fixes are not complete from code reasoning alone. Use browser
tests where possible and manually verify user-visible browser demo fixes with
`./run.sh browser`.

See `docs/agent-guidance/validation.md` for suite selection and exact command
guidance.

## Debugging And POSIX Contract

Fix the platform failure, not the presentation of the failure. A bug is not
understood until the failing path has been traced to its real layer: user
program, package artifact, VFS image, SDK/libc glue, syscall semantics, kernel
state, host runtime, Node/browser adapter, service worker, or UI.

Start from POSIX semantics. POSIX conformance is the north star. Linux
compatibility is valuable, but secondary: when multiple designs are equivalent
for POSIX correctness, internal integrity, maintainability, and performance,
prefer the design that best matches Linux-observable behavior.

A POSIX gap should stay visible as a platform gap until it is implemented. Do
not convert an unsupported or partially supported API into silent success just
because that lets a package continue. Stubs must be honest: return the correct
failure mode for unsupported behavior unless the API's correct compatibility
behavior is a no-op.

Process state is authoritative. `fork`, `exec`, `posix_spawn`, `clone`, `exit`,
`waitpid`, fd tables, OFDs, locks, sockets, PTYs, memory layout, and
zombie/reaping state must remain coherent across transitions.

See `docs/agent-guidance/debugging-and-posix.md` before changing syscall,
process, VFS, memory, device, or root-cause debugging behavior.

## ABI Contract

Every incompatible ABI change requires an `ABI_VERSION` bump in
`crates/shared/src/lib.rs` and a regenerated `abi/snapshot.json` in the same
change. Do not ship incompatible ABI changes under an existing `ABI_VERSION`.

The ABI includes syscall numbers and marshalling, channel layout, process
memory layout, host-reserved control regions, `repr(C)` structs, kernel Wasm
exports, ABI custom sections, process-expected globals, `wpk_fork_*` exports,
generated TypeScript ABI constants, and VFS image metadata that binds Wasm
programs to a kernel ABI.

The snapshot check is necessary but not sufficient. Semantic changes to an
existing syscall, errno, blocking behavior, fd inheritance, memory ownership,
or pointer interpretation can require an ABI bump even if the structural
snapshot is unchanged.

Do not add compatibility shims for stale ABI artifacts unless the compatibility
boundary is explicit, documented, and intentionally supported. Legacy Asyncify
exports, stale fork instrumentation exports, wrong ABI custom sections, old
package archives, and ABI-mismatched VFS images should fail loudly and be
rebuilt through the normal package/release path.

See `docs/agent-guidance/abi.md` and `docs/abi-versioning.md` before changing
ABI-adjacent code or artifacts.

## Host Runtime Contract

The host runtime is part of the platform, not demo scaffolding. It owns worker
lifecycle, Wasm instantiation, process memory, syscall channel dispatch,
blocking retry, VFS/network/device adapters, process-worker launch, and the
Node/browser bridge to platform APIs.

The kernel must run in a dedicated worker on every host. `CentralizedKernelWorker`
must not be instantiated on the main thread. The main thread is a proxy for
setup, UI, and I/O routing; it is not the syscall engine.

Node.js and browser hosts are peers. A host-runtime behavior change is
incomplete until both hosts have the same platform-observable behavior or the
difference is explicitly justified by a real platform boundary. Do not land
Node-first or browser-later host changes.

Shared files are cross-host changes by default. Changes to
`host/src/kernel-worker.ts`, `host/src/worker-main.ts`, VFS behavior,
networking, framebuffer, generated ABI constants, or worker protocol types need
Node and browser consideration even when only one host-specific file changed.

See `docs/agent-guidance/host-runtime.md` before changing host runtime,
worker protocol, or Node/browser adapter behavior.

## Rust-First Kernel And Fork Contract

Kernel and fork control flow are Rust-first. Do NOT add kernel or fork
control-flow TypeScript unless it is the irreducible host floor: worker spawn,
the `fork()` syscall + syscall-channel transport, `resolve_externref` identity
materialization, anyref-transit `Table.grow` sizing, PIC placement globals, the
resume `WebAssembly.Table`, and the Node/browser platform bridges. New
capture/replay/orchestration logic belongs in the Rust fork-module
(`crates/fork-module`) and `crates/fork-codec`, driven through the `fm_*`
host↔module contract, not in new TypeScript sequencing.

When you face a dilemma about whether something must be TypeScript, STOP and
discuss with the maintainer rather than growing the host surface. The direction
of travel is one way: TS fork/kernel glue shrinks toward the floor over time; it
does not grow.

## Package And Build Contract

Packages are consumers of the platform and distribution units for reproducible
artifacts. A package build should exercise the SDK, libc, resolver, sysroot,
VFS image tooling, fork instrumentation, and kernel assumptions through the
normal path. Do not make a package succeed by bypassing the SDK, libc,
resolver, VFS image, syscall, host, or kernel behavior that user software
normally relies on.

Package failures are platform feedback. Do not use package patches to
compensate for ordinary Kandelo POSIX gaps. If Kandelo has a documented
limitation because today's WebAssembly runtimes make the POSIX behavior
infeasible to implement faithfully, a package patch may adapt at that boundary
only when the limitation is documented and the patch stays scoped to it.

`package.toml` owns the portable recipe contract: package identity, upstream
source, license, direct deps, target arches, ABI expectation, declared outputs,
and default source-build hook. `build.toml` owns Kandelo project build/publish
state: selected script path, source provenance, publish revision, cache
invalidation, and binary index location.

Build scripts must honor the resolver contract, use the worktree-local SDK,
declare every dependency they use, install only into `WASM_POSIX_DEP_OUT_DIR`,
and produce the outputs declared in package metadata. Fork-using packages must
be instrumented with `scripts/run-wasm-fork-instrument.sh`; legacy Asyncify
artifacts are stale and must be rebuilt, not supported.

See `docs/agent-guidance/packages-and-builds.md` before changing package
metadata, build scripts, package patches, binary resolution, indexes, or VFS
image package artifacts.

## Browser And User Contract

The browser UI is a consumer and presentation layer for the platform. It should
expose the real state of a Kandelo machine, not synthesize success or implement
alternate runtime behavior.

`web-libs/kandelo-session` owns reusable browser-facing contracts: `KernelHost`,
boot descriptors, snapshots, demo configuration parsing, gallery metadata, and
sharing behavior. App-specific React wiring and page fixtures belong under
`apps/browser-demos`.

Boot descriptors and shared URLs are untrusted input. They need explicit
versioning, size caps, mount limits, path validation, allowed source kinds, and
loud failures for malformed or oversized payloads.

Browser persistence and sharing are part of the platform contract, not
presentation details. Do not present ephemeral, user-local, remote-fetched, or
URL-encoded state as if it were a durable, private, verified platform image.

VFS images are product artifacts and system state. Demo presentation metadata
belongs in `/etc/kandelo/demo.json` via the VFS image builder, not in
package-specific app-loader fallbacks.

See `docs/agent-guidance/browser-and-user.md` before changing browser demo
behavior, `KernelHost`, boot descriptors, sharing, persistence, service-worker
bridges, VFS image metadata, or user-visible browser failures.

## Performance Contract

Performance is subordinate to correctness, POSIX behavior, internal integrity,
and host parity. A faster path that weakens syscall semantics, hides wakeups,
drops diagnostics, changes observable process behavior, or diverges Node and
browser is not an acceptable optimization.

Do not make performance claims without benchmark evidence. "Faster," "no
regression," "neutral," and "harmless" are claims when presented as facts. If
you did not measure, say that performance was not measured.

Explicit performance work, broad performance claims, and syscall hot-path
changes require all benchmark suites on both Node and browser, with before/after
comparison. Narrower benchmark scopes are acceptable only for non-performance
changes with plausible performance risk, or for claims that are explicitly
bounded to one app, host, or subsystem.

Do not repeat known-bad syscall hot-path "optimizations" in
`host/src/kernel-worker.ts`: syscall argument count tables, syscall
classification sets, cached channel `DataView`/`Int32Array` objects, or
conditional debug-ring logging for "trivial" syscalls.

See `docs/agent-guidance/performance.md` before making or evaluating
performance claims.

## Build, Documentation, And PR Contract

The build environment is part of the platform contract. Build and verification
commands should run from repo-declared tools, not undeclared host state. Use
`scripts/dev-shell.sh` for build and verification claims; direnv is acceptable
as a local interactive convenience, but it is not the verification contract.

Building artifacts is expected work, not scope creep. This project builds
everything locally: no CI status check pre-materializes the sysroots, kernel
wasm, program and test-fixture binaries (`local-binaries/`), rootfs image, or
fetched binaries, and a fresh checkout or `git worktree` inherits none of
them. When a goal — running a suite, reproducing a failure, validating before
a merge — needs an artifact that is missing, build it and continue. A missing
artifact is a `./run.sh setup` / `build-musl.sh` / `build-programs.sh` /
`fetch-binaries.sh` step away (under `scripts/dev-shell.sh`), not a "cannot
proceed" boundary and not a reason to hand the task back. Distinguish this
from a genuine platform defect: a missing artifact you can produce is
provisioning; an artifact that fails to build, or an ABI-mismatched one that
must be rebuilt through the normal path, is the truthful failure the
platform-values contract tells you to surface. Report what you built to reach
a claim, then make the claim. See `docs/agent-guidance/validation.md` for the
fresh-worktree provisioning steps.

CI runs only reviewed code. Every third-party action in `.github/` is pinned to
a full 40-character commit SHA with the version in a trailing comment
(`uses: actions/checkout@9c091bb… # v7.0.0`). Never introduce or restore a tag
or branch ref (`@v4`, `@v7.0.0`, `@master`): those re-resolve on every run, so
whoever can move the ref can change what executes in a job holding
`GITHUB_TOKEN` and repository secrets. Same-repo `./.github/...` references are
the sole exception; they resolve to the running commit. Dependabot keeps the
pins current.

`./run.sh setup` does not rebuild musl once a sysroot already exists —
it only re-syncs overlay headers. After editing `libc/musl-overlay/` or
`libc/glue/channel_syscall.c`, run `scripts/build-musl.sh` before relying on
`./run.sh setup`, Vitest, or conformance tests.

PR titles and commit subjects must begin with a concise purpose prefix in the
form `Area: Purpose`, such as `Packages:`, `Kernel:`, `POSIX:`, `CI:`,
`Browser:`, or `Docs:`. Choose the area that best identifies the contract or
capability a reader should notice; the prefix is a routing hint, not a substitute
for a purpose-led title. PR descriptions and commit messages should then lead
with the platform contract, user-visible behavior, system invariant, or project
capability being changed or protected. Every PR description must put a
plain-language `## Why` section before `## What changed`, implementation
details, or validation. Explain the current problem, who or what it affects,
and why fixing it matters before describing the mechanics.

Prefer concise PR titles that remain suitable as merge subjects.
Manually wrap prose in PR descriptions and commit-message bodies at
72 columns. Do not reflow Markdown tables, code blocks, generated
text, or indivisible URLs and identifiers when wrapping would damage
their semantics.

Write PR descriptions so a junior developer can understand them without prior
incident history or repository shorthand. Define necessary terms, expand
acronyms on first use, use concrete examples where they clarify the failure,
and do not make issue or PR links carry the explanation. Technical precision is
required; unexplained jargon is not.

Preserve contributor attribution when rewriting PR history. Inspect original
authorship before restacking, rebasing, amending, cherry-picking, or squashing;
keep contributors as authors of derived commits and the restacker as committer.
Use co-author trailers for materially combined work, and verify attribution
with `git range-diff` and `git log --format=fuller` before force-pushing.

Documentation is part of the platform contract. Do not describe aspirational
behavior as supported behavior, and do not use documentation to create a
platform promise before the implementation, tests, package artifacts, and
browser/Node behavior support it.

See `docs/agent-guidance/build-docs-and-prs.md` before changing build/dev-shell
behavior, documentation, PR descriptions, or final-report framing.

## Key Directories

Use this map to route edits to the component that owns the contract. A symptom
may appear in a demo, package, script, or wrapper, but the fix belongs at the
layer whose platform behavior is wrong.

| Path | Owns |
|---|---|
| `crates/kernel/` | Rust kernel implementation: syscalls, process state, VFS, devices, memory, signals |
| `crates/shared/` | Shared ABI constants, syscall/interface definitions, host/kernel contract types |
| `crates/fork-instrument/` | Wasm fork continuation instrumentation |
| `abi/` | Committed ABI snapshot and generated ABI evidence |
| `host/src/` | TypeScript host runtime shared by Node.js and browser |
| `host/test/` | Host/kernel runtime behavior tests |
| `web-libs/` | Browser-independent reusable UI/session contracts |
| `apps/browser-demos/` | Browser app, demo pages, app-local presentation helpers |
| `packages/registry/<name>/` | Package manifests, builds, patches, package-owned tests |
| `images/` | Rootfs sources, VFS/archive builders, image metadata |
| `sdk/` | Cross-compilation wrapper CLI and SDK support |
| `libc/` | musl submodule, musl overlay, syscall glue |
| `benchmarks/` | Performance suites, harnesses, and benchmark results |
| `tests/libc/`, `tests/posix/`, `tests/sortix/` | External conformance suites |
| `tests/package-system/` | Package registry and binary-fetch automation tests |
| `scripts/` | Build, test, package, release, and developer automation |
| `.github/` | CI workflows and GitHub release automation |
| `docs/` | Authoritative reference documentation and historical plans |
| `docs-site/` | Published documentation site |
