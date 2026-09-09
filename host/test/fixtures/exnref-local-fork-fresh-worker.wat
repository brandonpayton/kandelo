;; ABI 44 integration fixture that holds a real exnref LIVE across kernel_fork.
;;
;; Unlike catch-ref-fresh-worker.wat (which catches an exception, DROPS the
;; exnref, and forks carrying only the scalar payload), this fixture keeps the
;; caught `exnref` in a reference LOCAL that is live across `kernel_fork`. The
;; fresh child therefore has NO way to reconstruct the exnref from copied linear
;; memory alone: the module (or the JS reference path) must rebuild an
;; instance-local exnref in the child. The child PROVES the exnref survived by
;; re-throwing it with `throw_ref` and re-catching it to recover the scalar
;; payload 42; a wrong or absent reconstruction makes the child exit 91 (bad
;; payload) or trap (null exnref), which the parent turns into exit 92.
(module
  (import "env" "memory" (memory 1 16384 shared))
  (import "env" "__channel_base" (global $__channel_base (mut i32)))
  (import "kernel" "kernel_exit" (func $kernel_exit (param i32)))
  (import "kernel" "kernel_fork"
    (func $kernel_fork (param i32) (result i32)))

  (tag $payload (param i32))

  (global $__stack_pointer (export "__stack_pointer") (mut i32)
    (i32.const 65536))

  (func (export "__abi_version") (result i32)
    i32.const 44)

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

  (func (export "_start")
    (local $exn exnref)
    (local $pid i32)
    (local $recovered i32)

    ;; Catch a scalar tag through CatchRef and KEEP the exnref in a local. The
    ;; exnref (not just its scalar payload) is what must survive the fork.
    (block $handler (result i32 exnref)
      (try_table (result i32 exnref)
          (catch_ref $payload $handler)
        i32.const 42
        throw $payload
        unreachable))
    local.set $exn
    drop

    i32.const 0
    call $kernel_fork
    local.set $pid

    local.get $pid
    i32.eqz
    if
      ;; Child: re-throw the reconstructed exnref and re-catch it to recover the
      ;; scalar payload. This exercises the exnref VALUE, not just its bytes.
      (block $rehandler (result i32)
        (try_table (result i32)
            (catch $payload $rehandler)
          local.get $exn
          throw_ref
          unreachable))
      local.set $recovered

      local.get $recovered
      i32.const 42
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
    end

    i32.const 0
    call $kernel_exit
    unreachable))
