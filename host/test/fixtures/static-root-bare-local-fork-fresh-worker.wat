;; ABI 44 real-worker regression fixture: a static root captured as a BARE local
;; value across kernel_fork (NOT behind a GC struct field).
;;
;; `$static_root` is an IMMUTABLE `(ref $node)` global initialized by struct.new
;; — a genuine Wasm-GC static root harvested at catalog ordinal 0. It is held in
;; a plain local `$held` live across the fork, so the ONLY captured reference is
;; the static root itself (a StaticRoot recipe with no aggregate consumer).
;;
;; This exercised a pre-existing gap: a captured i31/struct is published into the
;; PARENT's anyref transit at capture time (via encodeI31 / claimGcSlot), but the
;; static-root lookup path grew+published nothing, so the parent's resume
;; `decode_anyref` (a pure `table.get(transit, recipe+1)`) read an unsized slot
;; and trapped. Both the PARENT and the CHILD reconstruct `$held` after fork and
;; assert it is ref.eq the fresh instance's `$static_root` (plus the scalar
;; field), so a regression on either side fails the run.
(module
  (import "env" "memory" (memory 1 16384 shared))
  (import "env" "__channel_base" (global $__channel_base (mut i32)))
  (import "kernel" "kernel_exit" (func $kernel_exit (param i32)))
  (import "kernel" "kernel_fork"
    (func $kernel_fork (param i32) (result i32)))

  (type $node (struct (field (mut i32))))

  (global $static_root (ref $node) (struct.new $node (i32.const 123)))

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

  (func $check (param $held (ref null $node)) (result i32)
    (local $valid i32)
    ;; the reconstructed reference must be ref.eq the fresh instance's canonical
    ;; static root, and the static root's scalar field must be preserved.
    local.get $held
    global.get $static_root
    ref.eq

    local.get $held
    struct.get $node 0
    i32.const 123
    i32.eq
    i32.and
    local.set $valid
    local.get $valid)

  (func $fork_with_static_root (result i32)
    (local $held (ref null $node))
    (local $pid i32)

    global.get $static_root
    local.set $held

    i32.const 0
    call $kernel_fork
    local.set $pid

    local.get $pid
    i32.eqz
    if
      ;; child: $held is reconstructed by the fresh instance's reference replay.
      local.get $held
      call $check
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

    ;; parent: $held is reconstructed by the PARENT's own reference replay (the
    ;; path this fixture regresses). A wrong reconstruction fails here.
    local.get $held
    call $check
    i32.eqz
    if
      i32.const 93
      call $kernel_exit
      unreachable
    end

    local.get $pid)

  (func (export "_start")
    (local $pid i32)

    call $fork_with_static_root
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
