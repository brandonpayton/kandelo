;; ABI 43 integration fixture for reference-bearing exception payloads.
;;
;; Each path catches a reference payload through CatchRef, forks from that
;; handler, and waits for the child. The funcref is non-null; the externref
;; exercises the nullable/null recipe. The child has a fresh Wasm instance, so
;; success requires the complete exception recipe to reconstruct the payload
;; and create a fresh child-local exnref.
(module
  (import "env" "memory" (memory 1 16384 shared))
  (import "env" "__channel_base" (global $__channel_base (mut i32)))
  (import "kernel" "kernel_exit" (func $kernel_exit (param i32)))
  (import "kernel" "kernel_fork"
    (func $kernel_fork (param i32) (result i32)))

  (tag $func_payload (param funcref))
  (tag $extern_payload (param externref))
  (type $sentinel_type (func (result i32)))
  (table $verify 1 funcref)

  (global $__stack_pointer (export "__stack_pointer") (mut i32)
    (i32.const 65536))

  (func (export "__abi_version") (result i32)
    i32.const 44)

  (func $sentinel (type $sentinel_type) (result i32)
    i32.const 77)
  (elem declare func $sentinel)

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

  (func $test_funcref_payload
    (local $caught funcref)
    (local $pid i32)

    (block $handler (result funcref exnref)
      (try_table (result funcref exnref)
          (catch_ref $func_payload $handler)
        ref.func $sentinel
        throw $func_payload
        unreachable))
    drop
    local.set $caught

    i32.const 0
    call $kernel_fork
    local.set $pid
    local.get $pid
    i32.eqz
    if
      i32.const 0
      local.get $caught
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

  (func $test_externref_payload
    (local $caught externref)
    (local $pid i32)

    (block $handler (result externref exnref)
      (try_table (result externref exnref)
          (catch_ref $extern_payload $handler)
        ref.null extern
        throw $extern_payload
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
      ref.is_null
      i32.eqz
      if
        i32.const 93
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
    call $test_funcref_payload
    call $test_externref_payload
    i32.const 0
    call $kernel_exit
    unreachable))
