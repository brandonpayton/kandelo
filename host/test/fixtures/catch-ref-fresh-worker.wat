;; ABI 43 integration fixture for real process workers.
;;
;; The parent catches a scalar tag through CatchRef, forks from the handler,
;; and waits for the child. Rewind can succeed only if the copied continuation
;; rethrows the tag in the fresh child instance and the original CatchRef clause
;; creates a new instance-local exnref. The child exits 91 if its scalar payload
;; was not restored; the parent exits 92 if wait4 observes any failure.
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
    (local $caught i32)
    (local $pid i32)

    (block $handler (result i32 exnref)
      (try_table (result i32 exnref)
          (catch_ref $payload $handler)
        i32.const 42
        throw $payload
        unreachable))
    drop
    local.set $caught

    i32.const 0
    call $kernel_fork
    local.set $pid

    local.get $pid
    i32.eqz
    if
      local.get $caught
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
