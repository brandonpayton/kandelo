# F1: Module Abort-Replay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a fork that must abort *after capture* (a gated `EOPNOTSUPP`
reference kind, or a kernel-rejected `childPid < 0`) return its errno cleanly
when `WASM_POSIX_FORK_MODULE` is ON — instead of throwing
`"fork-module path does not own abort replay"` and crashing the parent worker.

**Architecture:** Abort-replay is a mechanical mirror of parent-replay at every
layer: the guest already exports `wpk_fork_abort_begin`/`wpk_fork_abort_end`
(frozen, identical frame-pulling to `wpk_fork_rewind_begin/end`, differing only
in the runtime-state tag), and the Rust frame driver + journal are
abort-agnostic. So the module abort path = the module replay path with the
guest export names + a runtime-state assertion swapped. Two real design points:
(T0) the abort errno is stored on the coordinator, because on the module path
the JS `LinkedForkContinuation` is unrooted and cannot hold it; (T1) the
fork-module gets nominal `fm_begin_abort`/`fm_finish_abort` exports that
delegate to the shared replay implementation but set/assert an `in_abort` flag,
so a mis-sequenced abort fails loudly (truthful state) rather than silently
reusing replay. vfork/borrowed abort stays UNSUPPORTED (rejected loudly on the
module path too). Mid-capture ENOMEM (`beginCaptureAbort`) is out of scope.

**Tech Stack:** Rust (`crates/fork-module` cdylib, no_std+alloc; built via
`crates/fork-module/build-wasm.sh`, unit-tested via `tests/harness.mjs` under
Node/V8), TypeScript host (`host/src/fork-*.ts`, `host/src/worker-main.ts`),
Vitest (`host/test/*.test.ts`, run in the dev-shell). All builds/tests run
under `scripts/dev-shell.sh` with `KANDELO_SOURCE_CACHE_ROOT` set to this
worktree's isolated cache.

**Spec:** `docs/plans/2026-09-04-rust-first-remaining-purpose-framed.md` §4/F
(F1) and the campaign Bar §2 (soundness over build cost; re-instrumentation
first-class; truthful failure).

## Global Constraints

- **Branch/worktree:** `brandonpayton/rust-first-abi44-reconcile` at
  `/Users/brandon/kandelo-abi44-reconcile`. `ABI_VERSION = 44` (in dev; shape
  freely). New fork-module exports change the shipped `fork_module{32,64}.wasm`
  digest — regenerate/rebuild it; no `ABI_VERSION` bump needed for the shipped
  side-module's own exports (host-co-shipped), but rebuild the module.
- **Flag-gated:** all behavior change is behind `WASM_POSIX_FORK_MODULE`
  (default currently OFF). Flag-off behavior must stay byte-identical.
- **Rust tests run on the host target:** `cargo test --target
  $(rustc -vV | sed -n 's/^host: //p') …` — the workspace defaults to a wasm
  target; without `--target` the tests build under `panic=abort` and fail
  spuriously.
- **fork-module rebuild:** after editing `crates/fork-module/src/lib.rs`, run
  `crates/fork-module/build-wasm.sh` (builds `fork_module{32,64}.wasm` + runs
  `tests/harness.mjs`) before host tests that instantiate the module.
- **Scope:** simple + multi-activation (dlopen) forks. vfork/borrowed abort
  stays unsupported. Mid-capture `beginCaptureAbort` untouched.
- No silent fallback to JS on the module path — abort either drives through the
  module or fails loudly.

---

### Task 1: fork-module `fm_begin_abort` / `fm_finish_abort` exports

**Files:**
- Modify: `crates/fork-module/src/lib.rs` (add exports + impls + `in_abort` flag on `ForkModule`)
- Test: `crates/fork-module/tests/harness.mjs` (add an abort-drive cycle)
- Build/run: `crates/fork-module/build-wasm.sh`

**Interfaces:**
- Produces (wasm exports consumed by Task 2): `fm_begin_abort()`,
  `fm_finish_abort()` — same calling convention as `fm_begin_replay`/
  `fm_finish_replay` (no args; result via `fm_last_errno`). `fm_begin_abort`
  sets `ForkModule.in_abort = true` then runs the replay-begin logic;
  `fm_finish_abort` asserts `in_abort` (else `Errno::EINVAL`), runs the
  replay-finish logic, clears `in_abort`. `fm_abort` (existing) also clears
  `in_abort`.

- [ ] **Step 1: Write the failing test.** In `crates/fork-module/tests/harness.mjs`,
  add an abort-cycle test modeled on the existing replay cycle (the block that
  calls `fm_begin_unwind`→`fm_finish_unwind`→`fm_begin_replay`→`fm_finish_replay`,
  ~lines 128-132/354). Duplicate that drive but call `fm_begin_abort()` in place
  of `fm_begin_replay()` and `fm_finish_abort()` in place of `fm_finish_replay()`,
  and assert `fm_last_errno() === 0` after each. Also add a negative case:
  calling `fm_finish_abort()` without a preceding `fm_begin_abort()` (e.g. right
  after `fm_finish_unwind`) sets `fm_last_errno()` to EINVAL (22).

- [ ] **Step 2: Run to verify it fails.** Run:
  `KANDELO_SOURCE_CACHE_ROOT="$HOME/.cache/kandelo/reconcile-abi44" scripts/dev-shell.sh bash -lc 'crates/fork-module/build-wasm.sh'`
  Expected: FAIL — `fm_begin_abort`/`fm_finish_abort` are not exported (harness
  throws `TypeError: fm_begin_abort is not a function`).

- [ ] **Step 3: Add the `in_abort` flag + impls + exports.** In `lib.rs`:
  add `in_abort: bool` to `struct ForkModule` (init `false` wherever the struct
  is constructed / reset). Add, next to `begin_replay_impl`/`finish_replay_impl`:

```rust
fn begin_abort_impl() -> Result<(), Errno> {
    // Abort replay drives the exact same frames/journal as parent replay;
    // the only difference is the guest export the host calls
    // (wpk_fork_abort_begin vs wpk_fork_rewind_begin). Record the abort state
    // so finish_abort_impl can assert the pairing is honored.
    begin_replay_impl()?;
    let st = state().as_mut().ok_or(Errno::EINVAL)?;
    st.in_abort = true;
    Ok(())
}

fn finish_abort_impl() -> Result<(), Errno> {
    {
        let st = state().as_mut().ok_or(Errno::EINVAL)?;
        if !st.in_abort {
            // fm_finish_abort without a matching fm_begin_abort: loud, not silent.
            return Err(Errno::EINVAL);
        }
    }
    finish_replay_impl()?;
    if let Some(st) = state().as_mut() {
        st.in_abort = false;
    }
    Ok(())
}
```

  And the exports (mirror `fm_begin_replay`/`fm_finish_replay` at
  `lib.rs:2853-2868`):

```rust
/// Begin an abort-replay: identical frame/journal mechanics to fm_begin_replay,
/// tagged so fm_finish_abort can assert the pairing.
#[unsafe(no_mangle)]
pub extern "C" fn fm_begin_abort() {
    match begin_abort_impl() {
        Ok(()) => set_ok(),
        Err(errno) => set_err(errno),
    }
}

/// Finish an abort-replay: require it was begun as an abort, then finish + release.
#[unsafe(no_mangle)]
pub extern "C" fn fm_finish_abort() {
    match finish_abort_impl() {
        Ok(()) => set_ok(),
        Err(errno) => set_err(errno),
    }
}
```

  Also clear `in_abort` in `abort_impl` (add `st.in_abort = false;` inside the
  `if let Some(st) = state().as_mut()` block at `lib.rs:1659-1664`).

- [ ] **Step 4: Run to verify it passes.** Run the same build-wasm.sh command as
  Step 2. Expected: PASS — the harness abort cycle drives clean (errno 0) and the
  negative case reports EINVAL. `fork_module32.wasm`/`fork_module64.wasm`
  regenerated.

- [ ] **Step 5: Commit.**

```bash
git add crates/fork-module/src/lib.rs crates/fork-module/tests/harness.mjs
git commit -m "Fork: add fm_begin_abort/fm_finish_abort module exports (F1)"
```

---

### Task 2: `ForkModuleContinuationBackend.beginAbort()` / `finishAbort()`

**Files:**
- Modify: `host/src/fork-module-backend.ts` (add two methods near `beginParentReplay`:383 and `finishReplay`:648)
- Test: `host/test/fork-module-backend-abort.test.ts` (new) — or extend an existing `fork-module-backend*.test.ts`

**Interfaces:**
- Consumes (Task 1): `fm_begin_abort`, `fm_finish_abort` exports.
- Produces (Task 3): `backend.beginAbort(): void`, `backend.finishAbort(): void`.

- [ ] **Step 1: Write the failing test.** In a new
  `host/test/fork-module-backend-abort.test.ts`, model the existing backend
  instantiation test (see `host/test/fork-module-worker-instantiation.test.ts`
  for how a `ForkModuleContinuationBackend` is set up with a real module
  instance + fixed arena). Drive `beginUnwind → addActivationUnwind →
  finishUnwindAndSerialize → beginAbort → finishAbort` and assert no throw
  (each wrapper's `requireOk` passes). Assert `finishAbort()` without
  `beginAbort()` throws (EINVAL surfaced by `requireOk`).

- [ ] **Step 2: Run to verify it fails.** Run:
  `KANDELO_SOURCE_CACHE_ROOT=… scripts/dev-shell.sh bash -lc 'cd host && npx vitest run test/fork-module-backend-abort.test.ts --no-file-parallelism'`
  Expected: FAIL — `backend.beginAbort is not a function`.

- [ ] **Step 3: Add the wrappers.** In `fork-module-backend.ts`, after
  `beginParentReplay` (383-386) and `finishReplay` (648-653) respectively:

```typescript
/** Parent abort-replay: begin (mirror of beginParentReplay, abort-tagged). */
beginAbort(): void {
  this.exports.fm_begin_abort();
  this.requireOk("fm_begin_abort");
}
```

```typescript
/** Finish an abort-replay (mirror of finishReplay). */
finishAbort(): void {
  this.exports.fm_finish_abort();
  this.requireOk("fm_finish_abort");
  this.unwindActive = false;
  this.moduleBuffer = 0;
}
```

  Add `fm_begin_abort` and `fm_finish_abort` to the exports type/interface this
  class reads (search the file for where `fm_begin_replay`/`fm_finish_replay`
  are declared on the exports shape and add the two new names with the same
  `() => void` signature).

- [ ] **Step 4: Run to verify it passes.** Same command as Step 2. Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add host/src/fork-module-backend.ts host/test/fork-module-backend-abort.test.ts
git commit -m "Fork: ForkModuleContinuationBackend beginAbort/finishAbort (F1)"
```

---

### Task 3: Coordinator abort seam — errno storage + module abort begin/finish

**Files:**
- Modify: `host/src/fork-process-continuation.ts`
- Test: covered end-to-end by Task 5 (the un-skipped worker test); this task also
  adds a focused coordinator-level assertion where feasible.

**Interfaces:**
- Consumes (Task 2): `backend.beginAbort()`, `backend.finishAbort()`.
- Produces (Task 4): `coordinator.abortErrno(): number` — the errno recorded at
  abort-begin (works on both JS and module paths).

- [ ] **Step 1: Add coordinator errno storage.** Add a private field
  `#abortErrno: number | null = null` (near the `phase` field, ~line 145) and a
  public accessor:

```typescript
/** The errno recorded when abort-replay began (module path: the JS
 *  continuation is unrooted and cannot hold it). Valid only in the
 *  "abort-replay" phase. */
abortErrno(): number {
  if (this.#abortErrno === null) {
    throw new Error(`${this.label}: no abort errno recorded`);
  }
  return this.#abortErrno;
}
```

  Reset `this.#abortErrno = null` in `finishModuleTransaction` and
  `finishTransaction` where `this.phase` is reset to `"idle"` (so it does not
  leak across forks).

- [ ] **Step 2: Record errno + add module branch in `beginAbortReplay`.** At the
  top of `beginAbortReplay(errno)` (683), after the `errno` validation, add:

```typescript
this.#abortErrno = errno;
if (this.moduleBackend) {
  this.beginModuleAbortReplay(errno);
  return;
}
```

  (The existing JS body below stays for the flag-off path.)

- [ ] **Step 3: Add `beginModuleAbortReplay`.** Clone `beginModuleParentReplay`
  (965-987) with these exact substitutions: method name →
  `beginModuleAbortReplay(errno: number)`; `this.phase = "parent-replay"` →
  `this.phase = "abort-replay"`; `backend.beginParentReplay()` →
  `backend.beginAbort()`; guest export `"wpk_fork_rewind_begin"` →
  `"wpk_fork_abort_begin"`; `activation.replayRoot` → `activation.root` (abort
  replays the *parent's committed* frames from `root`, matching the JS
  `beginAbortReplay` which uses `activation.root` at 697); `WPK_FORK_REWINDING`
  → `WPK_FORK_ABORT_UNWINDING`; the label suffix `"replay (module)"` →
  `"abort replay (module)"`. Keep `this.registry.beginParentReplay()` +
  `this.registry.restoreModuleState()` (abort still needs the reference
  transaction wound down deterministically) and the `catch → this.abort()`.

- [ ] **Step 4: Replace the throw in `finishModuleTransaction`.** Replace the
  `if (abortReplay) throw …` guard (1313-1315) with a real path. Reject
  borrowed abort loudly first (relocate the JS-path guard at 1386-1388):

```typescript
if (abortReplay && this.replayOwnership === "borrowed") {
  throw new Error(`${this.label}: borrowed child cannot own abort replay`);
}
```

  Then run the success body (1316-1360) with two substitutions applied to the
  abort case: the per-activation guest export `"wpk_fork_rewind_end"` →
  `"wpk_fork_abort_end"` when `abortReplay`, and `backend.finishReplay()` →
  `backend.finishAbort()` when `abortReplay`. Everything else (assert
  `WPK_FORK_NORMAL`, `registry.finishReplay()`, zero roots, publish launch root
  0 unless borrowed, `releaseArena()`, reset phase→idle, clear `#abortErrno`,
  rethrow `failure`) is shared. Structure it as, e.g.:

```typescript
const endExport = abortReplay ? "wpk_fork_abort_end" : "wpk_fork_rewind_end";
// … loop calling requireExportFunction(activation, endExport)() …
try {
  if (abortReplay) backend.finishAbort();
  else backend.finishReplay();
} catch (error) { failure ??= error; }
```

- [ ] **Step 5: Build host + run the fork-module replay suite (no regression).**
  Run:
  `KANDELO_SOURCE_CACHE_ROOT=… scripts/dev-shell.sh bash -lc 'cd host && npm run typecheck && npx vitest run test/fork-module-funcref-replay.test.ts test/fork-module-borrowed-replay.test.ts test/fork-continuation.test.ts --no-file-parallelism'`
  Expected: PASS — typecheck clean; existing replay + borrowed paths unaffected
  (flag-on replay still works; borrowed still forbids abort).

- [ ] **Step 6: Commit.**

```bash
git add host/src/fork-process-continuation.ts
git commit -m "Fork: drive module abort-replay through the coordinator (F1)"
```

---

### Task 4: `worker-main.ts` — read the abort errno from the coordinator

**Files:**
- Modify: `host/src/worker-main.ts` (the `"abort-replay"` finish site ~4135-4141, and confirm the thread mirror)

**Interfaces:**
- Consumes (Task 3): `processContinuation.abortErrno()`.

- [ ] **Step 1: Repoint the errno read.** At the abort-replay finish site
  (~4135), change the errno source from `forkContinuation.abortErrno()` to the
  coordinator: `processContinuation.abortErrno()` (works on both paths; on the
  module path `forkContinuation` is unrooted and has no errno). Then
  `processContinuation.finishAbortReplay()` and `return -errno` are unchanged.
  Apply the same change to the fork-from-thread mirror if it reads
  `abortErrno()` off the continuation.

- [ ] **Step 2: Typecheck.** Run:
  `KANDELO_SOURCE_CACHE_ROOT=… scripts/dev-shell.sh bash -lc 'cd host && npm run typecheck'`
  Expected: PASS.

- [ ] **Step 3: Commit.**

```bash
git add host/src/worker-main.ts
git commit -m "Fork: read abort errno from the coordinator on the module path (F1)"
```

---

### Task 5: End-to-end tests — un-skip gated abort, add kernel-abort + fault-injection

**Files:**
- Modify: `host/test/externref-fork-module-worker.test.ts:149` (un-skip)
- Create: `host/test/fork-module-kernel-abort.test.ts` (childPid<0 path)
- Create: `host/test/fork-module-abort-corruption.test.ts` (parent-corruption) — or a Rust harness twin

- [ ] **Step 1: Un-skip the gated-abort test.** Change `it.skip(` →  `it(` at
  `externref-fork-module-worker.test.ts:149`. The assertions (162-169:
  `exitCode === 92` for EOPNOTSUPP=... confirm the exact expected exit against
  the flag-off sibling above it; empty stderr; `moduleReferenceProof(...,
  "externref") === null`) are already written. Rebuild the fork-module + kernel
  as needed.

- [ ] **Step 2: Run it.** Run:
  `KANDELO_SOURCE_CACHE_ROOT=… scripts/dev-shell.sh bash -lc 'cd host && npx vitest run test/externref-fork-module-worker.test.ts --no-file-parallelism'`
  Expected: PASS — the flag-on externref fork now aborts cleanly with
  EOPNOTSUPP instead of crashing the worker (this is the primary F1 proof).

- [ ] **Step 3: Add the kernel-abort (childPid<0) test.** In
  `fork-module-kernel-abort.test.ts`, using the `runCentralizedProgram({ …,
  forkModuleEnabled: true })` harness, drive a qualifying simple fork whose
  kernel child launch is forced to fail (model how existing tests inject a
  kernel fork rejection; if none exists, assert via a program that forks under a
  condition the kernel rejects) and assert the parent's `fork()` returns
  `-errno` and the parent process continues (does not crash). If a kernel
  rejection cannot be injected in the harness, mark this test `.skip` with a
  comment pointing at the injection gap and cover the path via Task 3's
  coordinator-level assertion instead — do NOT fake it.

- [ ] **Step 4: Add the parent-corruption fault-injection test.** Prefer a Rust
  harness twin in `crates/fork-module/tests/harness.mjs` (or a `fork-module`
  Rust test): after `fm_begin_unwind`/commit, corrupt a committed frame in the
  arena, then drive `fm_begin_abort`/`fm_finish_abort` and assert it fails loudly
  (nonzero `fm_last_errno`) rather than mis-driving — mirroring the existing
  `rewind_driver.rs` corruption tests (`attach_rejects_truncated_chain:654`,
  `next_rejects_wrong_terminating_previous_pointer:734`). This proves the
  address-space-corruption risk surfaces as a truthful failure.

- [ ] **Step 5: Run the full fork test set + commit.** Run:
  `KANDELO_SOURCE_CACHE_ROOT=… scripts/dev-shell.sh bash -lc 'cd host && npx vitest run test/fork-module-*.test.ts test/externref-fork-module-worker.test.ts --no-file-parallelism'`
  Expected: PASS.

```bash
git add host/test/externref-fork-module-worker.test.ts host/test/fork-module-kernel-abort.test.ts host/test/fork-module-abort-corruption.test.ts crates/fork-module/tests/harness.mjs
git commit -m "Fork: e2e tests for module abort-replay (gated EOPNOTSUPP, kernel abort, corruption) (F1)"
```

---

## Notes for the executor

- The abort path is a **mirror** of the replay path — when in doubt, read the
  replay sibling (`beginModuleParentReplay` 965-987; `finishModuleTransaction`
  success body 1316-1360; backend `beginParentReplay`/`finishReplay`) and apply
  the documented substitutions. Do not invent new mechanics.
- The **only** genuine design decisions are already made here: errno on the
  coordinator (Task 3.1); nominal abort exports with an `in_abort` assertion
  (Task 1). Do not add a fork-codec abort phase — the driver/journal are
  abort-agnostic by construction.
- Keep flag-off byte-identical: every change is inside a `moduleBackend` branch
  or a new export/method; the JS `beginAbortReplay` body and `beginCaptureAbort`
  are untouched.
