;; N1 refcomplete (last gated native kind): a STATIC ROOT — an IMMUTABLE
;; `(ref $node)` global whose init expression is `struct.new` — reached
;; through a mutable HOLDER edge and held live across a native `kernel_fork`,
;; re-IDENTIFIED (never reconstructed) by coordinate in the child. Mirrors
;; `host/test/fixtures/static-root-local-fork-fresh-worker.wat`'s shape
;; exactly (see `docs/plans/2026-09-05-n1-static-root-capture-grounding.md`
;; §7) and this crate's own `native_fork_gc_struct_cycle.wat` for the
;; process/channel boilerplate.
;;
;; What makes `$static_root` a STATIC root and not an ordinary dynamic
;; `Struct` recipe is mutability of the GLOBAL, not the shape of its init
;; expression: an immutable `ref`-typed global whose init is anything other
;; than `ref.null`/`ref.func` is one of the instrumenter's three harvested
;; static-root sources (`crates/fork-instrument/src/static_reference_
;; catalog.rs`). A *mutable* global holding the exact same `struct.new` would
;; instead be captured as an ordinary dynamic Struct recipe.
;;
;; The fixture:
;;   1. At instantiation, `$static_root` is created ONCE by Wasm's own
;;      global-init semantics: `struct.new $node (i32.const 123)`.
;;   2. Builds a HOLDER struct whose one mutable field points at
;;      `$static_root` — the realistic "heap object pointing at a
;;      module-instance constant" shape — and keeps the holder live in a
;;      local across `kernel_fork`.
;;   3. In the CHILD: `holder.field` must be non-null, its scalar field must
;;      read 123, and it must be IDENTITY-EQUAL (`ref.eq`) to the CHILD's OWN
;;      fresh `global.get $static_root` — proving the reference was
;;      RE-IDENTIFIED by coordinate (both generations' instantiation
;;      independently re-creates their own canonical `$static_root`), not
;;      reconstructed as a fresh, non-identical struct.
;;   4. In the PARENT (after fork returns): re-checks its own holder against
;;      its own (unaffected) `$static_root`, then reaps the child and
;;      propagates a nonzero child status.
;;
;; Exit codes (parent-observed; `WEXITSTATUS` unwraps the child's own
;; `kernel_exit` code):
;;   0  = success (identity + scalar round-tripped in the child by
;;        coordinate, parent unaffected)
;;   91 = CHILD: reconstructed holder failed verification (null field, wrong
;;        scalar, or not identity-equal to the child's own static root)
;;   95 = PARENT: post-fork holder failed the same verification
;;   92 = wait4 did not reap the expected child, or the child's own exit
;;        status (as observed by the parent) was nonzero
;;
;; Regenerate (from within `scripts/dev-shell.sh` — the dev shell's WABT
;; `wat2wasm` does not accept current Wasm-GC syntax even with `--enable-gc`;
;; use the Rust `wat` crate via the committed generator test instead):
;;   cargo test -p host-native --lib -- --ignored \
;;     regenerate_native_fork_gc_static_root_fixture --nocapture
;;   scripts/run-wasm-fork-instrument.sh \
;;     crates/host-native/fixtures/native_fork_gc_static_root.wasm \
;;     -o crates/host-native/fixtures/native_fork_gc_static_root.instrumented.wasm \
;;     --entry kernel.kernel_fork
(module
  (import "env" "memory" (memory 1 16384 shared))
  (import "env" "__channel_base" (global $__channel_base (mut i32)))
  (import "kernel" "kernel_fork"
    (func $kernel_fork (param i32) (result i32)))

  (type $node
    (struct
      (field i32)))

  (type $holder
    (struct
      (field (mut (ref null $node)))))

  ;; The static root: IMMUTABLE, init'd by an allocating expression — this is
  ;; the exact discriminant the instrumenter's catalog uses to distinguish a
  ;; static root from an ordinary dynamic Struct global.
  (global $static_root (ref $node) (struct.new $node (i32.const 123)))

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

  ;; Verifies `$h`'s field is non-null, reads scalar 123, and is
  ;; IDENTITY-EQUAL (`ref.eq`) to THIS instance's own `$static_root` global —
  ;; i.e., whichever generation calls this (parent or child) checks against
  ;; its OWN freshly (re-)harvested canonical root. Returns 1 on success, 0
  ;; on any mismatch.
  (func $verify_holder (param $h (ref $holder)) (result i32)
    (local $root (ref null $node))

    local.get $h
    struct.get $holder 0
    local.set $root

    local.get $root
    ref.is_null
    if
      i32.const 0
      return
    end

    local.get $root
    ref.as_non_null
    struct.get $node 0
    i32.const 123
    i32.ne
    if
      i32.const 0
      return
    end

    local.get $root
    ref.as_non_null
    global.get $static_root
    ref.eq
    i32.eqz
    if
      i32.const 0
      return
    end

    i32.const 1)

  (func $test_static_root
    (local $holder (ref null $holder))
    (local $pid i32)

    ;; holder = struct.new $holder(global.get $static_root)
    global.get $static_root
    struct.new $holder
    local.set $holder

    ;; Fork with the holder local live across the boundary.
    i32.const 0
    call $kernel_fork
    local.set $pid

    local.get $pid
    i32.eqz
    if
      ;; CHILD: the reconstructed holder must verify against the CHILD's own
      ;; fresh static root.
      local.get $holder
      ref.as_non_null
      call $verify_holder
      i32.eqz
      if
        i32.const 91
        call $exit_group
      end
      i32.const 0
      call $exit_group
      unreachable
    end

    ;; PARENT: its own holder must be unaffected by forking.
    local.get $holder
    ref.as_non_null
    call $verify_holder
    i32.eqz
    if
      i32.const 95
      call $exit_group
    end

    local.get $pid
    call $require_child_ok)

  (func (export "_start")
    call $test_static_root
    i32.const 0
    call $exit_group
    unreachable))
