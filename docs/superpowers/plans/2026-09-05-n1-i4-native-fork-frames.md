# N1-I4: Native fork (frame replay) via the shared co-resident fork-module

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Checkbox (`- [ ]`) steps.

**Goal:** The native wasmtime host (`crates/host-native`) performs a real `fork()`: the parent captures its continuation, a child process is created with a private copy of the parent's memory, and BOTH parent and child resume correctly — driven by the **shared co-resident fork-module** (`fork_module32.wasm`), with NO host-specific replay logic. Frames only; reference reconstruction + exception tags stay ENOSYS-gated (that is I5). Proven by a real `fork()` fixture where parent and child both run and the parent `waitpid`s the child.

**Architecture (grounded; user-directed co-resident):** The fork-module is a PIC wasm **side module** that links the shared `fork-codec` rlib and owns the replay ALGORITHM; the host only (a) instantiates it co-resident with each guest (sharing the guest's `SharedMemory`), (b) provides `ForkLifecycleCapabilities` (`instantiate_child`, `spawn_thread`) + the `kernel.kernel_fork` import, and (c) drives the `fm_*` coordinator exports in the fixed order the Node/browser host uses. Native guest imports are synchronous `func_wrap` calls, so the module's frame imports resolve directly to its own exports within one `Store`. NO kernel/ABI change (the `kernel_fork_process` child-identity export + the frame/journal contract already exist; `SYS_FORK` is host-intercepted). References/tags are inert on the frame-only path and stay ENOSYS-gated → the I4/I5 boundary is clean (a no-reference fork never touches the ref path; `fm_*_reconstructed` counters stay 0). The child replay-thread teardown reuses N1-R's `reclaim_parked_thread`.

**Tech Stack:** Rust + `wasmtime = "35"` (host-native), the prebuilt `fork_module32.wasm` (`crates/fork-module/build-wasm.sh`), Kandelo SDK for the C fixture.

**Spec:** `docs/plans/2026-09-04-rust-first-remaining-purpose-framed.md` §6 (N1 roadmap, I4) + the I4 grounding (this plan's Confirmed facts). Depends on N1-R (`reclaim_parked_thread`, landed).

## Global Constraints

- Worktree `/Users/brandon/kandelo-abi44-reconcile` (branch `brandonpayton/rust-first-abi44-reconcile`; PR #1350 head = `brandonpayton/epoll-kernel-route`). Dev-shell + isolated cache: `export KANDELO_SOURCE_CACHE_ROOT="$HOME/.cache/kandelo/reconcile-abi44"; scripts/dev-shell.sh bash -lc '<cmd>'`.
- Test: `cargo test -p host-native --target $(rustc -vV|sed -n 's/^host: //p')` (host `aarch64-apple-darwin`).
- **NO host-specific fork replay logic** (user directive): the replay ALGORITHM stays in the co-resident `fork_module32.wasm` (which links `fork-codec`). The native host only instantiates it, supplies capabilities, and drives the `fm_*` coordinator in order. Do NOT link `fork-codec` into `host-native` and do NOT reimplement rewind/journal/replay in Rust.
- **Frames only.** Reference reconstruction (`fm_begin_reference_replay`, `fm_*_ref_*`, funcref/anyref catalogs, `resolve_externref`) and exception tags (`ForkHostCapabilities::{mint_exception_tag, provide_unwind_transport_tag, recognize_unwind_transport}`) stay ENOSYS/inert — they are I5. Wire them as inert stubs (empty tables + `-ENOSYS`/unreachable imports) sufficient to instantiate; a frames-only fork must never call them (assert the `fm_*_reconstructed` counters stay 0).
- **NO kernel/ABI change.** Use `kernel_fork_process` + the existing frame/journal contract. `kernel.kernel_fork` is a HOST import the native pump must define (the guest calls it directly).
- Reuse N1-R `reclaim_parked_thread` for replay-thread teardown; reuse I3a `launch_process`/`spawn_guest_thread`/`compute_guest_memory`.
- SDK fixture committed (`.c` + `.wasm`). All pre-existing host-native tests stay green (29 today).

## Confirmed facts (grounding — do not re-derive; anchors)

- fork-module artifact: `crates/fork-module/build-wasm.sh` builds a PIC (`--pie --experimental-pic`) side module → `local-binaries/fork_module32.wasm` + `host/wasm/fork_module32.wasm` (`:92-100`), post-processed by the `fork-module-inject` tool (walrus) for one funcref shim (`:57-78`). Build it in this tree if absent.
- Placement/imports (`crates/fork-module/src/lib.rs:51-99`): imports `env.memory` (the guest SharedMemory); placement globals `env.__memory_base` (immut i32), `env.__stack_pointer` (mut i32), `env.__table_base` (immut) + `env.__indirect_function_table`. Its own frame chunks come via `SYS_MMAP` on the guest channel (`fm_begin_unwind(activation_id, channel_base)`) — no host frame arena. Size to reserve: read the module's `dylink.0` mem_info (mirror `host/src/fork-module-instance.ts:377-401`).
- Instantiation reference: `host/src/fork-module-instance.ts:415-542` (region reserve via channel mmap, wire globals :447-458, import object :518-531, run start `__wasm_apply_data_relocs` :534-542).
- Frozen frame exports (single-activation, what the guest imports resolve to): `__wpk_fork_frame_reserve/commit/peek/next`, `__wpk_fork_resume_peek` (`lib.rs:2594-2653`).
- Coordinator exports + ORDER (`crates/host-native` must call these as `TypedFunc`s; order per `host/src/fork-module-backend.ts`): setup `fm_set_format` (`lib.rs:2759`) + `fm_set_resume_catalog` (`:3102`) [backend `:131-154`]; parent `fm_begin_unwind` (`:2772`) → `fm_finish_unwind` (`:2883`) → `fm_serialize_journal_alloc` (`:2938`) → `fm_journal_image_len` (`:2974`) → `fm_begin_replay` (`:2892`) → `fm_finish_replay` (`:2901`) [backend `:336-386`]; child `fm_begin_child_replay` (`:3004`) → `fm_finish_replay` [backend `:407-428`]; `fm_last_errno` (`:3550`). Proof-of-use counters `fm_frames_committed/replayed`, `fm_*_reconstructed` (`:3210-3549`).
- Guest side (reference): guest `fork()` raises the private unwind exception, caught at `host/src/worker-main.ts:5081-5100`; guest `__wpk_fork_frame_*` imports flipped to the module's exports at `worker-main.ts:4545-4557`; capture/replay flow in `host/src/fork-process-continuation.ts` (beginModuleCapture :902, sealModuleCapture :945, attachModuleChild :1048-1174).
- Kernel/fork: guest `fork()`/`vfork()` call `kernel.kernel_fork(mode)` import DIRECTLY (`libc/glue/channel_syscall.c:492-493,577-600`); the kernel export for child identity is `kernel_fork_process(parent_pid, caller_tid, mode) -> child_pid` (`crates/kernel/src/wasm_api.rs:1993-2002`); `kernel_is_fork_child`/`kernel_clear_fork_child`/`kernel_get_fork_exec_*`/`kernel_apply_fork_fd_actions` exist (`:2189-12638`). Generic dispatch returns ENOSYS for `SYS_FORK`(212)/`SYS_VFORK`(213) — the host must intercept. Thread-clone (I3a, shares memory) is intercepted at `guest.rs:3075-3135`; a full fork needs a PRIVATE memory copy instead.
- `ForkLifecycleCapabilities` (`crates/fork-codec/src/host_capabilities.rs:252-284`): `instantiate_child(gen, module_ordinal, memory_base) -> HostInstance` (:265), `spawn_thread(instance, entry_ordinal) -> HostThread` (:279). native_sketch stubs ENOSYS (`native_sketch.rs:122-137`). `ForkHostCapabilities` tag methods (:192/:209/:227) = reference/exception path → STAY ENOSYS for I4.
- Native reuse points: `launch_process` (guest.rs:1933, pid-agnostic), `compute_guest_memory` (:1895, fresh SharedMemory+layout), `spawn_guest_thread` (:2104), `reclaim_parked_thread`/`reclaim_all_channels` (N1-R, :2744-2828), the pump SYS_MMAP handling.

---

### Task 1: Instantiate the co-resident fork-module in wasmtime (the PIC-instantiation proof)

**Files:** Modify `crates/host-native/src/guest.rs` (a `fork_module_path()` + an `instantiate_fork_module(engine, store, guest_mem, layout) -> ForkModule` helper that instantiates `fork_module32.wasm` co-resident with a guest instance, sharing `guest_mem`, with the placement globals + inert reference imports); Modify `crates/host-native/src/lib.rs` (path helper + a test). Ensure `local-binaries/fork_module32.wasm` exists (build via `crates/fork-module/build-wasm.sh` if absent).

**Interfaces (Produces):** a `ForkModule` struct holding the instantiated module + its `fm_*` `TypedFunc`s (or an accessor), sharing the guest's `SharedMemory`; and the reserved memory region for the module's `__memory_base`. Name the struct + helper in your report.

- [ ] **Step 1: Ensure the artifact + write the failing test.** In the dev-shell, build the fork-module if `local-binaries/fork_module32.wasm` is absent: `scripts/dev-shell.sh bash -lc 'crates/fork-module/build-wasm.sh'` (report the exact command/output). Add `#[test] smoke_instantiates_fork_module`: boot a trivial guest (as existing tests do), then `instantiate_fork_module(...)` and assert it instantiates and a benign coordinator call works — e.g. `fm_set_format(<default format args>)` returns success and `fm_last_errno()` is 0. Fail first: the helper doesn't exist.
- [ ] **Step 2: RED** — `cargo test -p host-native --target <host> smoke_instantiates_fork_module`.
- [ ] **Step 3: Implement.** Add `fork_module_path()` (→ `local-binaries/fork_module32.wasm`, mirror `kernel_wasm_path`). In `instantiate_fork_module`: read the module's `dylink.0` mem_info to size the region (mirror `fork-module-instance.ts:377-401`); reserve that region from the guest's address space (carve a host-chosen base — reuse the scratch/region mechanism the guest launch already uses, or an mmap via the guest channel per the reference; document the choice); build a `Linker`/import object providing `env.memory` = the guest `SharedMemory`, `env.__memory_base` (immut `Global` i32 = the reserved base), `env.__stack_pointer` (mut `Global` i32), `env.__table_base` (immut) + `env.__indirect_function_table` (a table; empty is fine for frames), and INERT reference imports sufficient to instantiate: empty `__wpk_fork_function_catalog`/`__wpk_fork_drive_table` funcref tables, an inert anyref `__wpk_fork_static_root_catalog`, and a `resolve_externref` stub that traps/`-ENOSYS` (it must never be called on the frame path). Instantiate; run the module start (`__wasm_apply_data_relocs`) so passive-segment relocation happens. Bind the `fm_*` coordinator `TypedFunc`s (Confirmed facts list). Return the `ForkModule`.
  - This is the increment's PRIMARY RISK (co-resident PIC side-module instantiation in wasmtime, never done here). If instantiation cannot be made to work with wasmtime 35 as shaped (e.g. a required import/global cannot be satisfied, or PIC relocation fails), STOP and report BLOCKED with the exact wasmtime error + what's missing — do NOT hack around it.
- [ ] **Step 4: GREEN** (instantiation + `fm_set_format`/`fm_last_errno` succeed) + full suite green (29 + 1).
- [ ] **Step 5: Commit.** `git commit -m "Host-native: instantiate the co-resident fork-module (PIC side module) (N1-I4)"`

---

### Task 2: SYS_FORK path — child identity, private memory copy, child instance + thread, frame-import wiring

**Files:** Modify `crates/host-native/src/guest.rs` (the `kernel.kernel_fork` host import; a `SYS_FORK` pump path; the private memory copy; child guest instance + thread; wire the guest's `__wpk_fork_frame_*` imports to the co-resident module's exports). Fixture: a real `fork()` C program. Test in `crates/host-native/src/lib.rs`.

**Interfaces:** Consumes Task 1's `ForkModule` + N1-R reclaim + I3a launch. Produces: a full-fork path that creates the child (kernel identity + private memory + instance + thread) with the co-resident module instantiated for both parent and child, frame imports wired.

- [ ] **Step 1: Write the failing test.** `native_fork.c`: `pid_t p = fork(); if (p==0) { write(1,"child\n",6); _exit(3);} else { int st; waitpid(p,&st,0); write(1,"parent\n",7); _exit(WEXITSTATUS(st)); }`. Build it. `#[test] smoke_fork_parent_child`: run it; assert stdout contains BOTH `"child"` and `"parent"`, and the process exit code is 3 (parent returns the child's status). Fail first: no `kernel_fork` import / `SYS_FORK` unhandled → the guest's `kernel.kernel_fork` import is missing (instantiation trap) or fork returns ENOSYS.
- [ ] **Step 2: RED** — `cargo test -p host-native --target <host> smoke_fork_parent_child`.
- [ ] **Step 3: Implement.**
  - Define the `kernel.kernel_fork(mode) -> i32` host import the guest calls directly (`channel_syscall.c:492`). It should drive the fork: call `kernel_fork_process(parent_pid, caller_tid, mode)` for the child PID; make a PRIVATE copy of the parent's guest memory into a fresh `SharedMemory` (NOT shared — unlike thread clone; `compute_guest_memory` gives a fresh region, then copy the parent's bytes in); create the child guest `Instance` from the parent `Module` over the copied memory (`launch_process` under the child pid); instantiate a co-resident fork-module for the child (Task 1 helper); wire frame imports. Return per fork ABI (child pid to parent; 0 to child — but note the child's "return" is via replay, not a syscall return; follow the reference's split).
  - Wire the guest's `__wpk_fork_frame_*`/`__wpk_fork_resume_peek` imports to the co-resident module's exported `Func`s (mirror `worker-main.ts:4545-4557`) — both instances in one Store, synchronous.
  - Ensure the module's frame-chunk `SYS_MMAP` on the guest channel is serviced by the existing pump path.
  - Do NOT drive the coordinator yet (Task 3) — Task 2 gets the child created + instances + module wired; the actual capture/replay sequencing is Task 3. (It's acceptable for Step-2 RED→GREEN here to be partial: the test may still not fully pass until Task 3 drives replay; if so, split the assertion — Task 2 asserts the child process is created + both modules instantiated + no trap; Task 3 asserts correct parent/child resume. State clearly what Task 2's test proves.)
- [ ] **Step 4: GREEN (Task 2 scope)** — the child is created with a private memory copy + co-resident module, no instantiation trap; full suite green.
- [ ] **Step 5: Commit.** `git commit -m "Host-native: SYS_FORK — child identity, private memory copy, co-resident child module (N1-I4)"`

---

### Task 3: Drive the fork coordinator (capture → serialize → parent-replay → child-replay) + e2e

**Files:** Modify `crates/host-native/src/guest.rs` (port `ForkModuleContinuationBackend`'s sequencing as native Rust `TypedFunc` calls: parent capture+serialize+replay, child attach+replay; reuse `reclaim_parked_thread` for the replay-thread teardown). Test: complete `smoke_fork_parent_child`.

**Interfaces:** Consumes Tasks 1-2. Produces the full frame-only fork: parent and child both resume correctly.

- [ ] **Step 1: Complete the failing test.** Make `smoke_fork_parent_child` (Task 2) assert the FULL behavior: both `"child"` and `"parent"` in stdout, exit code 3, and (proof the module drove replay) `fm_frames_committed`/`fm_frames_replayed` > 0 and `fm_*_reconstructed` counters == 0 (frames-only, no refs). Also add `smoke_fork_no_reference_path`: assert a fork of a program with no captured references never calls the inert `resolve_externref`/tag imports (e.g. those stubs increment a counter that stays 0).
- [ ] **Step 2: RED** — it fails until the coordinator drives replay.
- [ ] **Step 3: Implement.** Port the coordinator order (Confirmed facts / `fork-module-backend.ts`): once per module — `fm_set_format` + `fm_set_resume_catalog`. Parent path (on `fork()` capture): `fm_begin_unwind(0, channel_base)` → guest raises/unwinds its frames into the module → `fm_finish_unwind` → `fm_serialize_journal_alloc(channel_base)` → `fm_journal_image_len` (record the JournalImage) → `fm_begin_replay` → guest rewinds pulling frames → `fm_finish_replay`. Child path (child instance, inherited JournalImage from the copied memory): `fm_begin_child_replay(root, image_ptr, image_len)` → child guest rewind pulling `fm_frame_next` → `fm_finish_replay`. Launch the child's OS thread (`spawn_guest_thread`/`launch_process`); on any replay-thread teardown (failure/abort) use `reclaim_parked_thread`. Keep references ENOSYS (the ref coordinator calls are NOT made on this path). Get the capture↔replay↔child-attach ordering exactly per the reference; `fm_last_errno` after each stage to surface module errors truthfully.
- [ ] **Step 4: GREEN** — both fixtures pass (parent+child correct, exit 3, frames>0, refs==0, inert imports untouched) + full suite green.
- [ ] **Step 5: Commit.** `git commit -m "Host-native: drive the fork coordinator for frame-only fork; parent+child resume (N1-I4)"`

---

## Notes for the executor
- Reference (cross-check for correct SEQUENCING only — the replay logic is the module's): `host/src/fork-module-backend.ts` (coordinator order), `host/src/fork-process-continuation.ts` (capture/seal/child-attach), `host/src/fork-module-instance.ts` (instantiation/placement), `host/src/worker-main.ts:4545-5153` (guest import flip + fork syscall). Mirror the ORDER + the placement wiring; do NOT port replay logic (there is none to port — it's in the module).
- Task 1 (PIC side-module instantiation) is the make-or-break. If it blocks in wasmtime 35, report BLOCKED with the exact error — that is a "strong doubt" worth surfacing, not something to hack around.
- References + exception tags stay ENOSYS/inert for I4; a frames-only fork must never exercise them (assert counters). That is the I4/I5 boundary — do NOT start reference reconstruction here.
- NO kernel/ABI change; NO linking fork-codec into host-native; NO host-side replay logic.
- Reuse N1-R `reclaim_parked_thread` for replay-thread teardown; reuse I3a launch/thread machinery. Fixtures SDK-built; commit `.c` + `.wasm`.
