;; ABI 44 real-worker integration fixture for activation-owned Wasm GC state.
;;
;; One cyclic object is aliased simultaneously by a reference parameter, an
;; operand-stack carryover across kernel_fork, a mutable reference global, and
;; a mutated reference table. A fresh child must rebuild one canonical local
;; identity for every alias; copying only linear memory cannot make any of
;; these module-instance values survive.
(module
  (import "env" "memory" (memory 1 16384 shared))
  (import "env" "__channel_base" (global $__channel_base (mut i32)))
  (import "kernel" "kernel_exit" (func $kernel_exit (param i32)))
  (import "kernel" "kernel_fork"
    (func $kernel_fork (param i32) (result i32)))

  (type $node
    (struct
      (field (mut i32))
      (field (mut (ref null $node)))))

  (global $saved (mut (ref null $node)) (ref.null $node))
  (table $saved_table 1 1 (ref null $node))
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

  (func $fork_with_reference_state
    (param $node (ref $node))
    (result i32)
    (local $carried (ref null $node))
    (local $pid i32)
    (local $valid i32)

    ;; Leave the reference below the fork result on the operand stack. This is
    ;; a real call carryover, not merely a local that happens to stay live.
    local.get $node
    i32.const 0
    call $kernel_fork
    local.set $pid
    local.set $carried

    local.get $pid
    i32.eqz
    if
      local.get $carried
      local.get $node
      ref.eq

      global.get $saved
      local.get $node
      ref.eq
      i32.and

      i32.const 0
      table.get $saved_table
      local.get $node
      ref.eq
      i32.and

      local.get $node
      struct.get $node 0
      i32.const 77
      i32.eq
      i32.and

      local.get $node
      local.get $node
      struct.get $node 1
      ref.as_non_null
      ref.eq
      i32.and
      local.set $valid

      local.get $valid
      i32.eqz
      if
        i32.const 91
        call $kernel_exit
        unreachable
      end
      i32.const 0
      call $kernel_exit
      unreachable
    end

    local.get $pid)

  (func (export "_start")
    (local $node (ref null $node))
    (local $pid i32)

    i32.const 77
    ref.null $node
    struct.new $node
    local.set $node

    local.get $node
    ref.as_non_null
    local.get $node
    struct.set $node 1

    local.get $node
    global.set $saved
    i32.const 0
    local.get $node
    table.set $saved_table

    local.get $node
    ref.as_non_null
    call $fork_with_reference_state
    local.set $pid

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
