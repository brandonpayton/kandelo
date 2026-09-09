;; N1-F6 (refcomplete FLOOR-2): a real Wasm-GC STRUCT holding a scalar, an
;; i31, and a SELF-CYCLE reference field, held live across a native
;; `kernel_fork`, reconstructed IDENTITY-PRESERVED (the cycle intact) in the
;; child. Mirrors the already-validated `create_cycle`/`verify_cycle` shape
;; in `crates/fork-instrument/tests/module_gc_codec_node.rs` (a single
;; mutable, NULLABLE self-referencing struct field — nullable means
;; `struct.new` can seed it with `ref.null` and `struct.set` the real
;; self-reference afterward, so this fixture's construction needs no
;; constructor-provenance wrapper at all; see `native_fork_gc_two_object_
;; cycle.wat` for the provenance-exercising sibling).
;;
;; The fixture:
;;   1. Constructs `$node { scalar: 77, boxed: i31(99), self: null }`.
;;   2. Closes the cycle: `node.self = node`.
;;   3. Forks with `node` held live in a local across the boundary.
;;   4. In the CHILD: the reconstructed node must report the same scalar
;;      (77), the same i31 payload (99), and `node.self` must be
;;      IDENTITY-EQUAL (`ref.eq`) to `node` itself — a plain structural copy
;;      would produce a DIFFERENT (non-identical) self object here.
;;   5. In the PARENT (after fork returns): re-checks its own node is
;;      unaffected, then reaps the child and propagates a nonzero child
;;      status.
;;
;; Exit codes (parent-observed; `WEXITSTATUS` unwraps the child's own
;; `kernel_exit` code):
;;   0  = success (identity + cycle round-tripped in the child, parent
;;        unaffected)
;;   91 = CHILD: reconstructed node failed verification (wrong scalar/i31,
;;        or the self field is not identity-equal to the node)
;;   95 = PARENT: post-fork node failed the same verification
;;   92 = wait4 did not reap the expected child, or the child's own exit
;;        status (as observed by the parent) was nonzero
;;
;; Regenerate (from within `scripts/dev-shell.sh` — the dev shell's WABT
;; `wat2wasm` does not accept current Wasm-GC syntax even with `--enable-gc`;
;; use the Rust `wat` crate via the committed generator test instead, exactly
;; like `host/test/fixtures/gc-reference-cycle-fresh-worker.wat`'s own doc
;; comment explains):
;;   cargo test -p host-native --lib -- --ignored \
;;     regenerate_native_fork_gc_struct_cycle_fixture --nocapture
;;   scripts/run-wasm-fork-instrument.sh \
;;     crates/host-native/fixtures/native_fork_gc_struct_cycle.wasm \
;;     -o crates/host-native/fixtures/native_fork_gc_struct_cycle.instrumented.wasm \
;;     --entry kernel.kernel_fork
(module
  (import "env" "memory" (memory 1 16384 shared))
  (import "env" "__channel_base" (global $__channel_base (mut i32)))
  (import "kernel" "kernel_fork"
    (func $kernel_fork (param i32) (result i32)))

  (type $node
    (struct
      (field (mut i32))
      (field (mut (ref null i31)))
      (field (mut (ref null $node)))))

  (global $__stack_pointer (export "__stack_pointer") (mut i32)
    (i32.const 65536))

  (func (export "__abi_version") (result i32)
    i32.const 44)

  ;; Post a REAL `SYS_EXIT_GROUP($code)` on the process's main syscall
  ;; channel — see `native_fork_refs.wat`'s `$exit_group` doc comment for why
  ;; this (not `kernel.kernel_exit`) is the replay-safe normal-exit protocol
  ;; every fixture in this crate uses.
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

  ;; Verifies `$n`'s scalar (77), i31 payload (99), and that its self field
  ;; is IDENTITY-EQUAL to `$n` itself. Returns 1 on success, 0 on any
  ;; mismatch.
  (func $verify_node (param $n (ref $node)) (result i32)
    (local $self (ref null $node))

    local.get $n
    struct.get $node 0
    i32.const 77
    i32.ne
    if
      i32.const 0
      return
    end

    local.get $n
    struct.get $node 1
    ref.as_non_null
    i31.get_s
    i32.const 99
    i32.ne
    if
      i32.const 0
      return
    end

    local.get $n
    struct.get $node 2
    local.set $self

    local.get $self
    ref.is_null
    if
      i32.const 0
      return
    end

    local.get $n
    local.get $self
    ref.as_non_null
    ref.eq
    i32.eqz
    if
      i32.const 0
      return
    end

    i32.const 1)

  (func $test_gc_struct
    (local $node (ref null $node))
    (local $pid i32)

    ;; node = struct.new $node(77, i31(99), null)
    i32.const 77
    i32.const 99
    ref.i31
    ref.null $node
    struct.new $node
    local.set $node

    ;; Close the cycle: node.self = node.
    local.get $node
    ref.as_non_null
    local.get $node
    struct.set $node 2

    ;; Fork with the node local live across the boundary.
    i32.const 0
    call $kernel_fork
    local.set $pid

    local.get $pid
    i32.eqz
    if
      ;; CHILD: the reconstructed node must verify.
      local.get $node
      ref.as_non_null
      call $verify_node
      i32.eqz
      if
        i32.const 91
        call $exit_group
      end
      i32.const 0
      call $exit_group
      unreachable
    end

    ;; PARENT: its own node must be unaffected by forking.
    local.get $node
    ref.as_non_null
    call $verify_node
    i32.eqz
    if
      i32.const 95
      call $exit_group
    end

    local.get $pid
    call $require_child_ok)

  (func (export "_start")
    call $test_gc_struct
    i32.const 0
    call $exit_group
    unreachable))
