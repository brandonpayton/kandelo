;; ABI 44 real-worker integration fixture for the STATIC-ROOT binder.
;;
;; `$static_root` is an IMMUTABLE `(ref $node)` global initialized with
;; `struct.new` at instantiation — a genuine Wasm-GC STATIC ROOT (unlike the
;; gc-*-fresh-worker fixtures, whose reference globals are MUTABLE and so are
;; reconstructed as dynamic Struct recipes, not static roots). The instrumenter
;; harvests it into `__wpk_fork_static_root_catalog` (ordinal 0).
;;
;; A dynamically constructed `$holder` struct whose field REFERENCES the static
;; root is aliased across `kernel_fork` (the realistic WasmGC shape: a heap
;; object pointing at a module-instance constant such as a vtable). The holder
;; forks as a Struct recipe whose field edge is a StaticRoot recipe. A fresh
;; child recreates its own canonical static root at instantiation; the
;; fork-module's static-root binder must publish THAT identity into the anyref
;; transit at slot `recipe + 1` BEFORE the holder's `_gc_fill` reads the field
;; edge. The child asserts `ref.eq` between the holder's field and the fresh
;; instance's `$static_root`, plus the static root's struct field value.
;; A JS `publishTransit` fallback would leave `fm_static_roots_published` at 0.
(module
  (import "env" "memory" (memory 1 16384 shared))
  (import "env" "__channel_base" (global $__channel_base (mut i32)))
  (import "kernel" "kernel_exit" (func $kernel_exit (param i32)))
  (import "kernel" "kernel_fork"
    (func $kernel_fork (param i32) (result i32)))

  (type $node (struct (field (mut i32))))
  (type $holder (struct (field (mut (ref null $node)))))

  ;; The static root: immutable, concrete struct reference, struct.new init.
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

  (func $fork_with_static_root (result i32)
    (local $held (ref null $holder))
    (local $pid i32)
    (local $valid i32)

    ;; Build a heap object whose field points at the immutable static root, then
    ;; keep it live across the fork. It forks as a Struct recipe whose field edge
    ;; is a StaticRoot recipe.
    ref.null $node
    struct.new $holder
    local.set $held
    local.get $held
    global.get $static_root
    struct.set $holder 0

    i32.const 0
    call $kernel_fork
    local.set $pid

    local.get $pid
    i32.eqz
    if
      ;; child: the holder's field must be ref.eq the fresh instance's OWN
      ;; canonical static root (the binder republished it into the transit so
      ;; the holder fill read it), and the static root's field must be preserved.
      local.get $held
      struct.get $holder 0
      ref.as_non_null
      global.get $static_root
      ref.eq

      local.get $held
      struct.get $holder 0
      ref.as_non_null
      struct.get $node 0
      i32.const 123
      i32.eq
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
