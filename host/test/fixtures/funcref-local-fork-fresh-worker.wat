;; ABI 43 integration fixture: a funcref stored in a LOCAL live across fork().
;;
;; Phase 6 D6.5 — the runnable, reference-carrying analogue of the module-level
;; funcref replay proof (`host/test/fork-module-funcref-replay.test.ts`). Where
;; that test drives the injected module's `__wpk_fork_ref_decode_funcref`
;; directly, THIS fixture forces a REAL guest to carry a live funcref across a
;; real `kernel_fork` and CALL it in the fresh child, so the worker's reference
;; reconstruction path (JS by default; the co-resident module when
;; `WASM_POSIX_FORK_MODULE=1`) is exercised end to end.
;;
;; The funcref is loaded DYNAMICALLY from a table with `table.get` (not a
;; rematerializable `ref.func` constant) so the instrumenter cannot fold it away
;; and must emit a `__wpk_fork_ref_decode_funcref` reconstruction on the child
;; rewind. The child stores the reconstructed funcref back into a call table and
;; `call_indirect`s it; the sentinel returns 77. Any reconstruction failure
;; makes the child exit nonzero, which the parent converts to exit 92.
(module
  (import "env" "memory" (memory 1 16384 shared))
  (import "env" "__channel_base" (global $__channel_base (mut i32)))
  (import "kernel" "kernel_exit" (func $kernel_exit (param i32)))
  (import "kernel" "kernel_fork"
    (func $kernel_fork (param i32) (result i32)))

  (type $sentinel_type (func (result i32)))

  ;; The source table the funcref is dynamically loaded from before fork.
  (table $source 1 funcref)
  ;; The destination table the child stores the reconstructed funcref into and
  ;; calls it through `call_indirect`.
  (table $verify 1 funcref)

  (global $__stack_pointer (export "__stack_pointer") (mut i32)
    (i32.const 65536))

  (func (export "__abi_version") (result i32)
    i32.const 44)

  (func $sentinel (type $sentinel_type) (result i32)
    i32.const 77)
  ;; Populate the source table slot 0 with the sentinel so `table.get` returns a
  ;; real, callable funcref identity the reconstruction must reproduce.
  (elem (table $source) (i32.const 0) func $sentinel)

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

  (func $test_funcref_local
    (local $carried funcref)
    (local $pid i32)

    ;; Dynamically load the sentinel funcref from the source table into a LOCAL.
    i32.const 0
    table.get $source
    local.set $carried

    ;; Fork with the funcref local live across the boundary.
    i32.const 0
    call $kernel_fork
    local.set $pid

    local.get $pid
    i32.eqz
    if
      ;; CHILD: the funcref local must have been reconstructed. Store it into the
      ;; call table and invoke it. A wrong/absent reconstruction traps or returns
      ;; the wrong value.
      i32.const 0
      local.get $carried
      table.set $verify
      i32.const 0
      call_indirect $verify (type $sentinel_type)
      i32.const 77
      i32.ne
      if
        i32.const 91
        call $kernel_exit
        unreachable
      end
      i32.const 0
      call $kernel_exit
      unreachable
    end

    local.get $pid
    call $require_child_ok)

  (func (export "_start")
    call $test_funcref_local
    i32.const 0
    call $kernel_exit
    unreachable))
