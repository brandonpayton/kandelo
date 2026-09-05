;; N1-I5 Task 3: a REAL reference (funcref + externref) held LIVE across a
;; native `kernel_fork`, run through the SAME production instrumentation
;; pipeline as `native_fork.c` (`run-wasm-fork-instrument.sh`).
;;
;; Why hand-written WAT, unlike every other `host-native` fixture (which are
;; plain C built through `build-fixtures.sh`): a genuine WASM `funcref`/
;; `externref` VALUE (not an i32 table index — this ABI represents ordinary C
;; function pointers as i32 indices into the shared indirect-function table,
;; never as a first-class `funcref`) is not reachable from portable C on the
;; clang/LLVM 21 toolchain this SDK ships. `__funcref`-qualified pointer types
;; are accepted by the parser but ICE (internal compiler error) on every
;; realistic use this task tried — an implicit or explicit conversion from an
;; ordinary function designator, and even a plain `call`/`return` of an
;; already-`__funcref`-typed value obtained from an extern import — reproduced
;; on this exact toolchain (clang 21.1.7, `--target=wasm32-unknown-unknown`).
;; `__externref_t` fares better (a bare `resolve_externref(handle) ->
;; __externref_t` extern call, with no conversion, compiles and links cleanly
;; — see `native_fork_refs.c`'s sibling design note — but the SAME toolchain
;; gap makes a genuine, hand-verified `funcref` local impossible from C here).
;;
;; The Node/browser host hit this identical C-unreachability wall for its own
;; ABI-44 integration proof and solved it the same way: hand-written WAT,
;; assembled with `wat2wasm`, then run through the real
;; `wasm-fork-instrument` tool — see `host/test/fixtures/
;; funcref-local-fork-fresh-worker.wat` (funcref) and `host/test/fixtures/
;; externref-local-fork-fresh-worker.wat` (externref), and their drivers
;; `host/test/funcref-fork-module-worker.test.ts` /
;; `externref-fork-module-worker.test.ts`. This fixture is the host-native
;; analogue of BOTH, combined into one program, over the exact same
;; `kernel`/`env` import surface (`kernel_fork`, `kernel_exit`,
;; `__channel_base`, raw `wait4` over the syscall channel) those Node/browser
;; fixtures use, because it is the same kernel ABI (ABI 44) on every host.
;;
;; funcref: the sentinel funcref is loaded DYNAMICALLY from a table with
;; `table.get` (not a rematerializable `ref.func` constant), so the
;; instrumenter cannot fold it away and must emit a genuine
;; `__wpk_fork_ref_decode_funcref` reconstruction on the child rewind. The
;; child (and, symmetrically, the parent after the fork returns) stores the
;; local back into a call table and `call_indirect`s it; the sentinel returns
;; 77.
;;
;; externref: the externref is obtained through `env.resolve_externref` —
;; native's REAL production host import (`crates/host-native/src/
;; guest.rs::define_resolve_externref`), wired to the guest's OWN import
;; here (not just the fork-module's internal use of the same import during
;; reconstruction) so this fixture exercises the identical `handle -> value`
;; map on both sides of the fork: the value is minted for handle 7 BEFORE the
;; fork, carried live in a local across it, and reconstructed via the
;; module's `__wpk_fork_ref_decode_externref` -> `resolve_externref(7)` path
;; on rewind. `env.native_test_externref_payload` (also native-only, see
;; `guest.rs::define_externref_payload_probe`) is the observable side channel
;; that proves identity: it unwraps the handle the externref was minted from,
;; so "did the reconstructed externref carry handle 7" is directly
;; observable from wasm, without needing a wasm-level `ref.eq` (the
;; documented externref-identity floor this project's grounding docs already
;; route around — see `docs/plans/2026-09-05-n1-i5-references-grounding.md`
;; §5).
;;
;; Exit codes (parent-observed, after `WEXITSTATUS` unwraps the child's own
;; `kernel_exit` code):
;;   0  = success (both references round-tripped through both processes)
;;   91 = CHILD: reconstructed funcref call returned the wrong value
;;   94 = CHILD: reconstructed externref payload was not handle 7
;;   95 = PARENT: post-fork funcref call returned the wrong value (parent's
;;        own carried reference must be unaffected by forking)
;;   96 = PARENT: post-fork externref payload was not handle 7
;;   92 = wait4 did not reap the expected child, or the child's own exit
;;        status (as observed by the parent) was nonzero
;;
;; STATUS (N1-I5 Task 3, 2026-09-05): this fixture ASSEMBLES and INSTRUMENTS
;; cleanly (both steps below succeed), and `crates/host-native/src/lib.rs`'s
;; `smoke_fork_reconstructs_references` runs it — but the run currently TRAPS
;; during CAPTURE, inside the guest's OWN `kernel_fork()` call, on `unknown
;; import: env::__wpk_fork_ref_vector_begin has not been defined`. This is
;; NOT a bug in this fixture or in the module's replay/decode machinery
;; (`fm_begin_reference_replay`/`fm_build_gc_plan`/`fm_drive_execute`, all
;; already wired and exercised by `native_fork.instrumented.wasm`'s frames-only
;; proof) — it is native's PRE-EXISTING, DOCUMENTED capture-side gap:
;; `guest.rs`'s `write_empty_module_state_arena` doc comment already states
;; "Native has no module-state CAPTURE mechanism yet ... A future task that
;; adds real native module-state capture (out of this task's scope) replaces
;; this with the guest's own captured arena." `__wpk_fork_ref_vector_begin`/
;; `_append`/`_finish` (the reference-vector CAPTURE builder) and
;; `__wpk_fork_ref_encode_funcref`/`__wpk_fork_ref_encode_externref` (the
;; per-kind CAPTURE encoders) are exactly that missing family: on Node/browser
;; they are host JS functions (`host/src/fork-activation-registry.ts`'s
;; `beginReferenceVector`/`appendReferenceVector`/`finishReferenceVector`),
;; with no fork-module-exported counterpart to bind to — native genuinely has
;; nothing to wire them to yet. The REPLAY side this task DID wire (funcref/
;; externref table mirroring, the guest reference-import flip, `env.
;; resolve_externref`, `drive_reference_replay`) is real and unit-tested
;; (`fork_module_tests::resolve_externref_is_idempotent_per_handle`); this
;; fixture is what a FUTURE capture-side task should point
;; `smoke_fork_reconstructs_references` (currently `#[ignore]`d, see its own
;; doc comment) at once that gap closes — no changes to this file should be
;; needed then, only to `guest.rs`'s capture wiring.
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
  (import "kernel" "kernel_exit" (func $kernel_exit (param i32)))
  (import "kernel" "kernel_fork"
    (func $kernel_fork (param i32) (result i32)))
  ;; Native's REAL production `env.resolve_externref` import (not a test-only
  ;; shim) — see `guest.rs::define_resolve_externref`'s doc comment on why
  ;; this fixture's DIRECT call and the fork-module's internal reconstruction
  ;; call share one `ExternrefRegistry`.
  (import "env" "resolve_externref"
    (func $resolve_externref (param i32) (result externref)))
  ;; Native test-only diagnostic: unwraps the `u32` handle an externref
  ;; `resolve_externref` minted carries, so a plain-WASM fixture (no `ref.eq`)
  ;; can observe identity. See `guest.rs::define_externref_payload_probe`.
  (import "env" "native_test_externref_payload"
    (func $native_test_externref_payload (param externref) (result i32)))

  (type $sentinel_type (func (result i32)))

  ;; The source table the funcref is dynamically loaded from before fork.
  (table $source 1 funcref)
  ;; The destination table both parent and child store the (carried or
  ;; reconstructed) funcref into and call through `call_indirect`.
  (table $verify 1 funcref)

  (global $__stack_pointer (export "__stack_pointer") (mut i32)
    (i32.const 65536))

  (func (export "__abi_version") (result i32)
    i32.const 44)

  (func $sentinel (type $sentinel_type) (result i32)
    i32.const 77)
  ;; Populate the source table slot 0 with the sentinel so `table.get` returns
  ;; a real, callable funcref identity the reconstruction must reproduce.
  (elem (table $source) (i32.const 0) func $sentinel)

  ;; Calls the funcref currently in `$verify` slot 0 and traps with
  ;; `$exit_code` if it does not return 77.
  (func $check_funcref (param $exit_code i32)
    i32.const 0
    call_indirect $verify (type $sentinel_type)
    i32.const 77
    i32.ne
    if
      local.get $exit_code
      call $kernel_exit
      unreachable
    end)

  ;; Calls `native_test_externref_payload` on `$ref` and traps with
  ;; `$exit_code` if the returned handle is not 7.
  (func $check_externref (param $ref externref) (param $exit_code i32)
    local.get $ref
    call $native_test_externref_payload
    i32.const 7
    i32.ne
    if
      local.get $exit_code
      call $kernel_exit
      unreachable
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
      call $kernel_exit
      unreachable
    end

    i32.const 1024
    i32.load
    if
      i32.const 92
      call $kernel_exit
      unreachable
    end)

  (func $test_references
    (local $funcref_local funcref)
    (local $ext_local externref)
    (local $pid i32)

    ;; Dynamically load the sentinel funcref from the source table into a
    ;; LOCAL.
    i32.const 0
    table.get $source
    local.set $funcref_local

    ;; Mint a genuine externref for handle 7 into a LOCAL.
    i32.const 7
    call $resolve_externref
    local.set $ext_local

    ;; Fork with BOTH reference locals live across the boundary.
    i32.const 0
    call $kernel_fork
    local.set $pid

    local.get $pid
    i32.eqz
    if
      ;; CHILD: both references must have been reconstructed correctly.
      i32.const 0
      local.get $funcref_local
      table.set $verify
      i32.const 91
      call $check_funcref
      local.get $ext_local
      i32.const 94
      call $check_externref
      i32.const 0
      call $kernel_exit
      unreachable
    end

    ;; PARENT: its own carried references must be unaffected by forking.
    i32.const 0
    local.get $funcref_local
    table.set $verify
    i32.const 95
    call $check_funcref
    local.get $ext_local
    i32.const 96
    call $check_externref

    local.get $pid
    call $require_child_ok)

  (func (export "_start")
    call $test_references
    i32.const 0
    call $kernel_exit
    unreachable))
