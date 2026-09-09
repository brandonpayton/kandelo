;; ABI 44 real-worker integration fixture for a MULTI-NODE activation-owned Wasm
;; GC graph — the equivalence vehicle for Phase 6 item 3c (the co-resident
;; fork-module typed-GC drive).
;;
;; Unlike the single self-cyclic `$node` struct in
;; `gc-reference-state-fresh-worker.wat`, this graph has TWO typed-GC aggregate
;; kinds joined in a struct<->array CYCLE:
;;
;;   * a `$node` struct  (value + a reference to the array),
;;   * an `$arr`  array   (element 0 references the struct back — the cycle).
;;
;; The struct is aliased simultaneously by a reference parameter, an
;; operand-stack carryover across kernel_fork, a mutable reference global, and a
;; mutated reference table. A fresh child must rebuild ONE canonical local
;; identity for every alias AND rebuild the struct<->array cycle, all from the
;; reconstructed graph — copying linear memory alone makes none of these
;; module-instance values survive.
;;
;; The child self-verifies (ref.eq alias checks + the cyclic array element +
;; the scalar struct field + a module-owned i31 leaf) and exits 0 on success,
;; mirroring the proven `$node` fixture's exit-0/stderr-empty contract.
;;
;; A scalar i31 leaf held in a module-owned global (`$saved_i31`) is now included
;; (Phase 6 item 3c piece 0). It reconstructs through the co-resident
;; fork-module drive as an ALLOC-emitting typed-GC recipe. It was previously left
;; out because `ForkReferenceTransaction.loadGc` ran `assertU32` on the i31
;; sentinel type ordinal (signed -1 at the import boundary) BEFORE its i31 branch
;; could accept the sentinel; that assert now coerces to unsigned first, so an
;; i31 load succeeds on the JS RESTORE path AND the module drive.
(module
  (import "env" "memory" (memory 1 16384 shared))
  (import "env" "__channel_base" (global $__channel_base (mut i32)))
  (import "kernel" "kernel_exit" (func $kernel_exit (param i32)))
  (import "kernel" "kernel_fork"
    (func $kernel_fork (param i32) (result i32)))

  ;; struct <-> array are mutually recursive, so they share one rec group.
  (rec
    (type $node
      (struct
        (field (mut i32))
        (field (mut (ref null $arr)))))
    (type $arr (array (mut (ref null $node)))))

  (global $saved (mut (ref null $node)) (ref.null $node))
  ;; A scalar i31 leaf aliased through a module-owned global (Phase 6 item 3c):
  ;; an ALLOC-emitting typed-GC recipe the fork drive must reconstruct.
  (global $saved_i31 (mut (ref null i31)) (ref.null i31))
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
      ;; carried alias === node
      local.get $carried
      local.get $node
      ref.eq

      ;; mutable reference global === node
      global.get $saved
      local.get $node
      ref.eq
      i32.and

      ;; mutated reference table[0] === node
      i32.const 0
      table.get $saved_table
      local.get $node
      ref.eq
      i32.and

      ;; scalar field survived
      local.get $node
      struct.get $node 0
      i32.const 77
      i32.eq
      i32.and

      ;; struct<->array CYCLE: node.array[0] === node
      local.get $node
      struct.get $node 1
      ref.as_non_null
      i32.const 0
      array.get $arr
      ref.as_non_null
      local.get $node
      ref.eq
      i32.and

      ;; i31 leaf survived with its value (Phase 6 item 3c)
      global.get $saved_i31
      ref.as_non_null
      i31.get_s
      i32.const 42
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
    (local $node (ref null $node))
    (local $arr (ref null $arr))
    (local $pid i32)

    ;; node = struct{ value=77, array=null }
    i32.const 77
    ref.null $arr
    struct.new $node
    local.set $node

    ;; arr = array[1] filled with node  => arr[0] === node
    local.get $node
    i32.const 1
    array.new $arr
    local.set $arr

    ;; node.array = arr  => struct<->array cycle
    local.get $node
    ref.as_non_null
    local.get $arr
    struct.set $node 1

    ;; alias the struct through a global and a table
    local.get $node
    global.set $saved
    i32.const 0
    local.get $node
    table.set $saved_table

    ;; alias a scalar i31 (value 42) through a module-owned global
    i32.const 42
    ref.i31
    global.set $saved_i31

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
