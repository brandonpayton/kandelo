;; ABI 44 integration fixture that holds a real HOST externref LIVE across
;; kernel_fork.
;;
;; The guest obtains a genuine host reference from the `env.get_ext` import
;; (which the test wires to the process externref owner / broker), keeps it in a
;; reference LOCAL that is live across `kernel_fork`, and in the fresh CHILD
;; verifies — through `env.check_ext` — that the SAME host identity survived the
;; fork. A module-instance externref has no linear-memory representation, so
;; copying the child's memory byte-for-byte cannot carry it: the fresh child must
;; reconstruct the broker-tracked externref from the reference recipe. With the
;; co-resident fork-module enabled that reconstruction re-roots the externref
;; through the `wpk_fork_host` engine-floor seam (`host_resolve_externref` over
;; the worker's externref token cache), driving the module's
;; `fm_externrefs_resolved` proof-of-use counter.
;;
;; Because the value comes from a host import it is a genuine broker externref
;; (an opaque host object, not a GC-internalized value), so the fork codec
;; classifies it as an `externref` node — exactly the D6.2 broker seam — rather
;; than a typed-GC node. `check_ext` returns 1 only when the reconstructed
;; reference is the SAME host identity the owner minted; the child exits 94 on an
;; identity divergence and 91 on a null reference, which the parent turns into
;; exit 92.
;;
;; Unlike the funcref/exnref/GC fixtures this needs no GC opcodes, so WABT
;; assembles it directly from this source (no committed byte fixture).
(module
  (import "env" "memory" (memory 1 16384 shared))
  (import "env" "__channel_base" (global $__channel_base (mut i32)))
  (import "kernel" "kernel_exit" (func $kernel_exit (param i32)))
  (import "kernel" "kernel_fork"
    (func $kernel_fork (param i32) (result i32)))
  ;; Host reference producer/verifier, wired by the test to the process
  ;; externref owner (broker).
  (import "env" "get_ext" (func $get_ext (result externref)))
  (import "env" "check_ext" (func $check_ext (param externref) (result i32)))

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
    (local $ref externref)
    (local $pid i32)

    ;; Obtain a genuine host externref through the broker-backed import.
    call $get_ext
    local.set $ref

    ;; Parent guard: the reference must exist and already resolve to the
    ;; owner-minted identity before forking.
    local.get $ref
    ref.is_null
    if
      i32.const 90
      call $kernel_exit
      unreachable
    end
    local.get $ref
    call $check_ext
    i32.eqz
    if
      i32.const 93
      call $kernel_exit
      unreachable
    end

    i32.const 0
    call $kernel_fork
    local.set $pid

    local.get $pid
    i32.eqz
    if
      ;; Child: the externref carried live across the fork must be non-null and
      ;; must resolve to the SAME host identity through the broker seam.
      local.get $ref
      ref.is_null
      if
        i32.const 91
        call $kernel_exit
        unreachable
      end
      local.get $ref
      call $check_ext
      i32.eqz
      if
        i32.const 94
        call $kernel_exit
        unreachable
      end
      i32.const 0
      call $kernel_exit
      unreachable
    end

    ;; PARENT post-abort assertion (delete-and-gate slice, 2026-09-04).
    ;; When the fork carries a gated externref, capture marks it unsupported and
    ;; the parent run loop aborts the fork with -EOPNOTSUPP after seal: control
    ;; returns HERE in the parent with no child spawned. The headline claim is
    ;; that the parent continues UNAFFECTED — its carried reference survives the
    ;; aborted capture/restore. Prove it directly: the parent's `$ref` must still
    ;; be non-null and still resolve to the SAME owner-minted host identity
    ;; through the broker. A lost or divergent parent reference exits with a
    ;; DISTINCT nonzero code (96 = null, 97 = identity divergence) so the test's
    ;; exit-92 assertion is load-bearing for parent-reference survival, not just
    ;; for the never-reaped child.
    local.get $ref
    ref.is_null
    if
      i32.const 96
      call $kernel_exit
      unreachable
    end
    local.get $ref
    call $check_ext
    i32.eqz
    if
      i32.const 97
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
