# Validation Contract

Validation is evidence for a specific claim. Do not say "tests pass", "the
branch is complete", "the browser works", "ABI is fine", or "performance
improved" unless the evidence for that exact claim has been run and reported.

Use precise language:

- "I ran `X`; it passed."
- "I did not run `Y`."
- "This change is docs-only; I did not run runtime tests."
- "This is not fully merge-validated because `Z` remains unrun."

Do not use a narrow check to support a broad claim. A passing unit test does
not prove POSIX behavior. A passing Node/Vitest path does not prove browser
behavior. A passing browser demo does not prove ABI compatibility. A
micro-benchmark does not prove application performance.

Core validation surface:

| Suite | Command | Primary evidence for |
|---|---|---|
| Workspace Rust tests | `cargo test --workspace --exclude xtask --target <host-target>` | Any change under `crates/`: kernel, fork-instrument, shared, wasm-local-root-spill, and future workspace crates. `--target` is required because the default wasm32 target has no host runner; xtask has its own always-run suite. |
| Package-system automation tests | `cargo test -p xtask --target <host-target>` | `tools/xtask/**` changes: package resolver, binaries-dir placement, cache/output artifact validation, archive staging + canonical filename |
| Host integration tests | `cd host && npx vitest run` | Host/runtime behavior |
| Browser app/runtime tests | `cd apps/browser-demos && npx playwright test --grep-invert "@slow" --project=chromium` | Browser host, UI, demo, service worker, VFS image behavior |
| Browser package-tree contract | `cd apps/browser-demos && npx playwright test test/package-deferred-tree-browser.spec.ts --project=chromium --project=firefox --project=webkit` | Browser lazy/eager package-tree parity, including Safari/WebKit |
| Browser asset check | `bash scripts/ci-check-browser-assets.sh` | Browser asset/import changes |
| musl libc-test | `scripts/run-libc-tests.sh` | libc, syscall, and kernel semantic changes |
| Open POSIX Test Suite | `scripts/run-posix-tests.sh` | POSIX API behavior |
| Sortix os-test | `scripts/run-sortix-tests.sh --all` | Broad POSIX/kernel regression coverage |
| ABI snapshot | `bash scripts/check-abi-version.sh` | ABI-adjacent changes |

For CI-shaped local runs, prefer:

```bash
bash scripts/dev-shell.sh bash scripts/ci-run-test-suite.sh <cargo-workspace|cargo-xtask|vitest|browser|libc|posix|sortix> [group]
```

The optional group reproduces CI's deterministic suite partitions. Vitest
accepts `1/2`, `2/2`, or `resource-isolated`; libc accepts
`functional-regression` or `math`; and Sortix accepts `include`, `basic`, or
`runtime`. Omitting the group runs the complete suite, including Vitest's full
test inventory and `--all` for Sortix. Vitest's complete run excludes each
file declared in `scripts/ci-vitest-resource-isolated-cases.tsv` from its main
worker and then runs every declared case in a fresh worker process. Each row
names a regex-safe identifier that occurs in exactly one test. Before excluding
a file, the runner requires those identifiers to map one-to-one onto its full
machine-readable `vitest list --json` inventory.

For direct Cargo commands, compute `<host-target>` with:

```bash
rustc -vV | awk '/^host/ {print $2}'
```

`scripts/ci-run-test-suite.sh` does not currently expose an `abi` suite; run
`bash scripts/check-abi-version.sh` separately for ABI-adjacent changes.

## Preparing a fresh checkout or worktree to run the suites

The Vitest, browser, libc, posix, and sortix suites need built artifacts and
submodules that a fresh checkout — and every new `git worktree` — does **not**
inherit. This project builds everything locally; no CI status check
pre-materializes these artifacts for you. Missing artifacts surface as `Binary
not found: …/kernel.wasm` (or a program `.wasm`), `sysroot not found`, or
`libc/musl/src: No such file`. These are not "cannot validate" conditions, and
they are not a reason to stop short of a goal (running a suite, reproducing a
failure, or validating a branch before a merge). Building what a task needs is
part of the task. Build or fetch what is missing:

1. **Submodules** (musl, libc-test, os-test) — worktrees do not check them out:
   ```bash
   git submodule update --init --recursive
   ```
   If `libc/musl` exists but is not a valid checkout (a stray dir from a partial
   build blocks the clone), reset it: `rm -rf libc/musl && git submodule update
   --init libc/musl`.
2. **Kernel wasm + host + rootfs + musl sysroot** — ~1.5min; `./run.sh setup`
   builds the musl sysroot from scratch on a fresh checkout (or just
   re-syncs overlay headers when a sysroot already exists), then the
   kernel, every package, and the rootfs, producing
   `local-binaries/kernel.wasm` (the binary resolver prefers it over
   `binaries/`) and `host/wasm/rootfs.vfs`:
   ```bash
   scripts/dev-shell.sh ./run.sh setup
   ```
   If a sysroot already exists and you just edited
   `libc/musl-overlay/` or `libc/glue/channel_syscall.c`, `setup` will
   not rebuild musl for you — rebuild it explicitly first:
   ```bash
   scripts/dev-shell.sh bash scripts/build-musl.sh
   ```
3. **Node dependencies** — `node_modules` are per-checkout, and both the repo
   root (the conformance runners load `tsx` from root) and `host/` are needed:
   ```bash
   npm ci            # root — provides tsx used by run-sortix/posix/libc-tests.sh
   (cd host && npm ci)
   ```
4. **Prebuilt test binaries** the source build does not produce, e.g. the
   MariaDB/Perl VFS images a few Vitest cases load:
   ```bash
   scripts/dev-shell.sh bash scripts/fetch-binaries.sh
   ```
5. **Program and test-fixture binaries** under `local-binaries/programs/` and
   `local-binaries/test-fixtures/` — `scripts/build-programs.sh` emits these,
   and several Vitest cases load them directly. The `exact-abi-source` suite,
   for one, reads these program fixtures:
   `local-binaries/programs/wasm32/{exec-child,vfork-lifecycle}.wasm` and
   `local-binaries/test-fixtures/wasm32/login.wasm`. Without them
   `exec-state-tracking`, `spawn-*`, `vfork-production-mechanism`, and
   `demo-login-image` fail with `ENOENT`/`existsSync === false` that has nothing
   to do with your change. The same script builds `hello64.wasm`, the LP64
   program the `wasm64` cases need and that `fetch-binaries.sh` does not carry:
   ```bash
   scripts/dev-shell.sh bash scripts/build-programs.sh
   ```
   `./run.sh setup` already builds the wasm64 sysroot (its bootstrap step plan
   runs `sysroot64` unconditionally, alongside the wasm32 `sysroot`). If the
   wasm64 sysroot is missing (e.g. a partial checkout) or you just edited
   `libc/musl-overlay/` or `libc/glue/channel_syscall.c`, rebuild it explicitly
   first:
   ```bash
   scripts/dev-shell.sh bash scripts/build-musl.sh --arch wasm64posix
   ```

After that the full suites run. Do **not** report "I can't run Vitest / the
conformance suites / the browser" because a fresh worktree lacks artifacts —
build or fetch them with the steps above, then run the suite and report the real
result. If a suite genuinely cannot run (no network for `fetch-binaries.sh`, no
display for browser tests, etc.), name the exact step that failed and why; that
is different from validation being impossible.

Before blaming a suite failure on your change, confirm it actually is your
change: a few package/demo tests (e.g. the Erlang `ring` benchmark) can fail for
environment or artifact reasons unrelated to a given diff. Reproduce the failure
on a pristine `origin/main` build of the same artifact before attributing it —
rebuild just the kernel wasm (`cargo build --release -p kandelo -Z
build-std=core,alloc && cp target/wasm32-unknown-unknown/release/kandelo_kernel.wasm
local-binaries/kernel.wasm`) at `origin/main` and re-run the one test. Report a
pre-existing failure as pre-existing, not as your regression.

After editing kernel Rust, rebuild the kernel wasm (`./run.sh setup`) before the
Vitest/conformance suites — they load `local-binaries/kernel.wasm`, so a stale
wasm silently runs your OLD kernel code. `./run.sh setup` does not rebuild musl;
after editing `libc/musl-overlay/` or `libc/glue/channel_syscall.c`, run
`scripts/build-musl.sh` first. (`bash build.sh` still works as a deprecated
delegator to `./run.sh setup`.)

After editing anything under `host/src`, regenerate the program index before
running a suite that resolves a program binary:

```bash
./target/<host-triple>/release/xtask build-deps program-index \
  --source-repo-root "$PWD" "$PWD/packages/registry" \
  "$PWD/packages/registry/program-packages.json"
```

`host/src` is a build input of the VFS-image packages, so editing a file there
re-keys them and `resolveBinary` fails closed with "Program package source
projection is not current". The suites that hit this are the ones that boot a
machine from a VFS image — `host/test/migration/`, `tests/package-system/` and
the package tests. `packages/registry/lamp/build.toml`,
`nginx-php-vfs/build.toml` and `wordpress/build.toml` declare the whole
`host/src` directory, so any file under it re-keys those three;
`packages/registry/shell/build.toml` and its siblings name individual files,
including `host/src/vfs/memory-fs.ts` and `host/src/vfs/sharedfs-vendor.ts`.

The digest is over content, not mtime. `touch` on a `host/src` file does not
re-key anything, and restoring an edited file byte-for-byte makes the index
current again without regenerating it — so "I touched a host file and the index
stayed current" is not evidence that host edits are safe.

The table names primary evidence, not a universal checklist. Choose the suites
that support the claim you will make, broaden coverage when a change crosses
contract boundaries, and report anything relevant that was not run.

Runtime/kernel changes are not fully validated until the relevant conformance
suites have been considered. If a change touches syscall behavior, process
lifecycle, memory layout, fd semantics, VFS semantics, signals, libc glue, or
ABI-adjacent code, do not stop at unit tests and Vitest.

Browser-facing fixes are not complete from code reasoning alone. Use browser
tests where possible and manually verify user-visible browser demo fixes with:

```bash
./run.sh browser
```
