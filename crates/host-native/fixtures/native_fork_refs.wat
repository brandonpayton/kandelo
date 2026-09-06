;; N1-I5b Task 1: a REAL WASM `funcref` held LIVE across a native
;; `kernel_fork`, run through the SAME production instrumentation pipeline
;; as `native_fork.c` (`run-wasm-fork-instrument.sh`).
;;
;; Why hand-written WAT, unlike every other `host-native` fixture (which are
;; plain C built through `build-fixtures.sh`): a genuine WASM `funcref`
;; VALUE (not an i32 table index — this ABI represents ordinary C function
;; pointers as i32 indices into the shared indirect-function table, never as
;; a first-class `funcref`) is not reachable from portable C on the
;; clang/LLVM 21 toolchain this SDK ships. `__funcref`-qualified pointer
;; types are accepted by the parser but ICE (internal compiler error) on
;; every realistic use this task tried — an implicit or explicit conversion
;; from an ordinary function designator, and even a plain `call`/`return` of
;; an already-`__funcref`-typed value obtained from an extern import —
;; reproduced on this exact toolchain (clang 21.1.7,
;; `--target=wasm32-unknown-unknown`).
;;
;; The Node/browser host hit this identical C-unreachability wall for its own
;; ABI-44 integration proof and solved it the same way: hand-written WAT,
;; assembled with `wat2wasm`, then run through the real
;; `wasm-fork-instrument` tool — see `host/test/fixtures/
;; funcref-local-fork-fresh-worker.wat` and its driver
;; `host/test/funcref-fork-module-worker.test.ts`. This fixture is the
;; host-native analogue, over the exact same `kernel`/`env` import surface
;; (`kernel_fork`, `kernel_exit`, `__channel_base`, raw `wait4` over the
;; syscall channel) those Node/browser fixtures use, because it is the same
;; kernel ABI (ABI 44) on every host.
;;
;; funcref: the sentinel funcref is loaded DYNAMICALLY from a table with
;; `table.get` (not a rematerializable `ref.func` constant), so the
;; instrumenter cannot fold it away and must emit a genuine
;; `__wpk_fork_ref_decode_funcref` reconstruction on the child rewind. The
;; child (and, symmetrically, the parent after the fork returns) hands the
;; local straight to native's test-only `env.native_test_funcref_call` import
;; (`crates/host-native/src/guest.rs::define_funcref_call_probe`), which
;; calls it HOST-side and hands the `i32` result back; the sentinel returns
;; 77. This is deliberately NOT a wasm-level `call_indirect`/`call_ref` — see
;; the HISTORY note below for why this fixture avoids ever writing the local
;; into a destination table.
;;
;; Exit codes (parent-observed, after `WEXITSTATUS` unwraps the child's own
;; `kernel_exit` code):
;;   0  = success (the funcref round-tripped through both processes)
;;   91 = CHILD: reconstructed funcref call returned the wrong value
;;   95 = PARENT: post-fork funcref call returned the wrong value (parent's
;;        own carried reference must be unaffected by forking)
;;   92 = wait4 did not reap the expected child, or the child's own exit
;;        status (as observed by the parent) was nonzero
;;
;; HISTORY: through N1-I5 Task 3 this fixture ALSO carried a genuine
;; `externref` (minted via `env.resolve_externref`) live across the same
;; fork, and `smoke_fork_reconstructs_references` was `#[ignore]`d because
;; NEITHER half could run at all — every capture-side reference import
;; (`__wpk_fork_ref_encode_funcref`/`_vector_begin`/`_append`/`_finish`) had
;; no host body and trapped before any replay code ever ran (see git history
;; for that version of this file and of the test's own doc comment). N1-I5b
;; Task 1 gives native a REAL funcref capture path (`crates/host-native/src/
;; guest.rs`'s `NativeReferenceCapture` + the 6 capture-side host bodies) but
;; deliberately stops at funcref — externref/typed-GC/static-root capture
;; stays gated to `EOPNOTSUPP` on every host (`docs/fork-reference-support.
;; md`), matching the current platform contract (see `docs/plans/
;; 2026-09-05-n1-i5b-reference-capture-grounding.md` §0). This fixture was
;; therefore trimmed to funcref-ONLY so `smoke_fork_reconstructs_references`
;; can prove that real capture path without also tripping the
;; still-unimplemented `encode_externref` gate. N1-I5b Task 2 (a later,
;; separate dispatch) adds its OWN externref-carrying fixture to prove the
;; `EOPNOTSUPP` gate fires cleanly instead — it does not need to touch this
;; file.
;;
;; Also during N1-I5b Task 1's own development, an EARLIER version of this
;; fixture verified the reconstructed funcref by storing the local into a
;; destination table and `call_indirect`-ing it (mirroring the original
;; N1-I5 Task 3 design). That tripped a SEPARATE, unrelated native gap:
;; `wasm-fork-instrument` tracks every `table.set` ANYWHERE in the compiled
;; module (`crates/fork-instrument/src/module_state.rs`'s
;; `collect_source_mutated_tables`, over ALL local functions, not just ones
;; reachable from `kernel.kernel_fork`) for module-state (KFMS table-
;; dirty-page) capture/restore — a DIFFERENT, out-of-scope-for-this-task
;; import family (`__wpk_fork_module_state_table_mutation_begin`/`_commit`)
;; with no native host body at all yet (native's whole `__wpk_fork_module_
;; state_*` family "stays inert" — see this repo's N1-I4 doc comments).
;; `docs/plans/2026-09-05-n1-i5b-reference-capture-grounding.md` §4 point 2
;; explicitly scopes solving THAT gap out of this task ("capture the
;; reference graph into an otherwise-still-empty-of-table-state KFMS arena,"
;; not "solve general module-state capture"). This fixture therefore never
;; writes into any table at runtime: `$source` is populated once via an
;; ACTIVE element segment (a one-time bootstrap-time `table.init`, not a
;; `table.set`) and only ever READ; verifying the reconstructed local calls
;; native's test-only `env.native_test_funcref_call` import directly instead
;; of any wasm-level `call_indirect`/`call_ref`.
;;
;; Regenerate (from within `scripts/dev-shell.sh`):
;;   wat2wasm --enable-exceptions --enable-threads \
;;     crates/host-native/fixtures/native_fork_refs.wat \
;;     -o crates/host-native/fixtures/native_fork_refs.wasm
;;   scripts/run-wasm-fork-instrument.sh \
;;     crates/host-native/fixtures/native_fork_refs.wasm \
;;     -o crates/host-native/fixtures/native_fork_refs.instrumented.wasm \
;;     --entry kernel.kernel_fork
(module
  (import "env" "memory" (memory 1 16384 shared))
  (import "env" "__channel_base" (global $__channel_base (mut i32)))
  (import "kernel" "kernel_fork"
    (func $kernel_fork (param i32) (result i32)))
  ;; Native test-only diagnostic: calls the given funcref HOST-side and
  ;; returns its `i32` result — see `guest.rs::define_funcref_call_probe`'s
  ;; doc comment for why this fixture uses it instead of a wasm-level
  ;; `call_indirect`/`call_ref`.
  (import "env" "native_test_funcref_call"
    (func $native_test_funcref_call (param funcref) (result i32)))

  (type $sentinel_type (func (result i32)))

  ;; The source table the funcref is dynamically loaded from before fork.
  ;; Read-only at runtime (see the HISTORY note above for why this fixture
  ;; never `table.set`s any table).
  (table $source 1 funcref)

  (global $__stack_pointer (export "__stack_pointer") (mut i32)
    (i32.const 65536))

  (func (export "__abi_version") (result i32)
    i32.const 44)

  (func $sentinel (type $sentinel_type) (result i32)
    i32.const 77)
  ;; Populate the source table slot 0 with the sentinel so `table.get` returns
  ;; a real, callable funcref identity the reconstruction must reproduce.
  (elem (table $source) (i32.const 0) func $sentinel)

  ;; Post a REAL `SYS_EXIT_GROUP($code)` on the process's main syscall
  ;; channel, mirroring `$wait_child`'s hand-rolled channel protocol (the
  ;; same offsets: `SYSCALL_OFFSET` = base+4, `ARGS_OFFSET` = base+8,
  ;; `STATUS_OFFSET` = base+0). `exit_group` never returns, so this ends in
  ;; `unreachable` unconditionally — a recognized-as-clean
  ;; `Trap::UnreachableCodeReached` on native (`guest.rs::is_unreachable_
  ;; trap`), the SAME outcome a real musl `_exit`/`exit_group` call produces
  ;; for every OTHER (C-built) fixture in this crate.
  ;;
  ;; Deliberately NOT `kernel.kernel_exit`: that import is native's
  ;; SIGKILL-ONLY fast path (`guest.rs`'s own doc comment: "A normal exit
  ;; never calls it"), which returns a raw `wasmtime::Error`, NOT a
  ;; recognized clean trap — using it for a NORMAL exit (as an earlier
  ;; version of this fixture did, inherited from the pre-N1-I5b version)
  ;; surfaces as "guest entry failed" and leaves the real kernel process
  ;; table never told this process exited, hanging any `wait4`er (here, the
  ;; PARENT) forever. `SYS_EXIT_GROUP` is the real, replay-safe protocol
  ;; every other exit in this fixture now goes through.
  (func $exit_group (param $code i32)
    (local $base i32)
    global.get $__channel_base
    local.set $base

    local.get $base
    i32.const 4
    i32.add
    i32.const 387 ;; SYS_EXIT_GROUP
    i32.store

    local.get $base
    i32.const 8
    i32.add
    local.get $code
    i64.extend_i32_s
    i64.store

    local.get $base
    i32.const 16
    i32.add
    i64.const 0
    i64.store

    local.get $base
    i32.const 24
    i32.add
    i64.const 0
    i64.store

    local.get $base
    i32.const 32
    i32.add
    i64.const 0
    i64.store

    local.get $base
    i32.const 40
    i32.add
    i64.const 0
    i64.store

    local.get $base
    i32.const 48
    i32.add
    i64.const 0
    i64.store

    local.get $base
    i32.const 1
    i32.atomic.store
    local.get $base
    i32.const 1
    memory.atomic.notify
    drop

    unreachable)

  ;; Calls `$f` via the native test probe and traps with `$exit_code` if it
  ;; does not return 77.
  (func $check_funcref (param $f funcref) (param $exit_code i32)
    local.get $f
    call $native_test_funcref_call
    i32.const 77
    i32.ne
    if
      local.get $exit_code
      call $exit_group
    end)

  (func $wait_child (param $pid i32) (result i32)
    (local $base i32)
    (local $result i32)

    global.get $__channel_base
    local.set $base

    ;; SYS_wait4(pid, &status, 0, 0)
    local.get $base
    i32.const 4
    i32.add
    i32.const 139
    i32.store

    local.get $base
    i32.const 8
    i32.add
    local.get $pid
    i64.extend_i32_s
    i64.store

    local.get $base
    i32.const 16
    i32.add
    i64.const 1024
    i64.store

    local.get $base
    i32.const 24
    i32.add
    i64.const 0
    i64.store

    local.get $base
    i32.const 32
    i32.add
    i64.const 0
    i64.store

    local.get $base
    i32.const 40
    i32.add
    i64.const 0
    i64.store

    local.get $base
    i32.const 48
    i32.add
    i64.const 0
    i64.store

    local.get $base
    i32.const 1
    i32.atomic.store
    local.get $base
    i32.const 1
    memory.atomic.notify
    drop

    block $complete
      loop $wait
        local.get $base
        i32.atomic.load
        i32.const 1
        i32.ne
        br_if $complete

        local.get $base
        i32.const 1
        i64.const -1
        memory.atomic.wait32
        drop
        br $wait
      end
    end

    local.get $base
    i32.const 64
    i32.add
    i32.load
    if
      i32.const -1
      local.set $result
    else
      local.get $base
      i32.const 56
      i32.add
      i64.load
      i32.wrap_i64
      local.set $result
    end

    local.get $base
    i32.const 0
    i32.atomic.store

    local.get $result)

  (func $require_child_ok (param $pid i32)
    local.get $pid
    call $wait_child
    local.get $pid
    i32.ne
    if
      i32.const 92
      call $exit_group
    end

    i32.const 1024
    i32.load
    if
      i32.const 92
      call $exit_group
    end)

  (func $test_references
    (local $funcref_local funcref)
    (local $pid i32)

    ;; Dynamically load the sentinel funcref from the source table into a
    ;; LOCAL.
    i32.const 0
    table.get $source
    local.set $funcref_local

    ;; Fork with the reference local live across the boundary.
    i32.const 0
    call $kernel_fork
    local.set $pid

    local.get $pid
    i32.eqz
    if
      ;; CHILD: the reference must have been reconstructed correctly.
      local.get $funcref_local
      i32.const 91
      call $check_funcref
      i32.const 0
      call $exit_group
      unreachable
    end

    ;; PARENT: its own carried reference must be unaffected by forking.
    local.get $funcref_local
    i32.const 95
    call $check_funcref

    local.get $pid
    call $require_child_ok)

  (func (export "_start")
    call $test_references
    i32.const 0
    call $exit_group
    unreachable))
