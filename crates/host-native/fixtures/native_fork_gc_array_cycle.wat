;; N1-F6 Task 5 (refcomplete FLOOR-2, array un-gate): real Wasm-GC ARRAY
;; capture across a native `kernel_fork`. Exercises three distinct array
;; constructor forms in ONE fixture, each landing on a different
;; `constructor_provenance` branch (`crates/fork-instrument/src/module_gc_
;; codec.rs`):
;;
;;   1. `$scalars_fixed = array.new_fixed $scalars 3 (11 22 33)` — REQUIRED
;;      minimum per the task. `$scalars` is IMMUTABLE (`array i32`, no
;;      `mut`), so `defaultable_shell == false` (`defaultable_field(field) &&
;;      field.mutable` — immutability alone disqualifies the shell-then-
;;      `array.set` replay strategy) and replay MUST re-invoke `array.new_
;;      fixed` directly from the snapshot bytes. `ArrayFixed` over a scalar
;;      element type needs provenance_scalar_length == 0 (its arity is
;;      static, so the snapshot alone is the constructor's arguments).
;;   2. `$data_bytes = array.new_data $databytes $seg (offset=0, len=4)` —
;;      `ArrayData` over an IMMUTABLE `i8` element type, sourced from a
;;      PASSIVE data segment. provenance_scalar_length == 8 (the segment
;;      `(offset, length)` pair, packed into one `i64` — see `module_gc_
;;      codec.rs`'s `emit_provenance_scalars`'s `ArrayData`/`ArrayElement`
;;      arm). This is the genuinely LOAD-BEARING case: `$databytes` is
;;      immutable, so replay CANNOT `array.set` its way to the right
;;      content — it MUST re-invoke `array.new_data` with the EXACT
;;      original `(offset, length)`, which is NOT recoverable from the
;;      array's current element values (a data-segment coordinate, not a
;;      snapshot-derivable fact). Corrupting or truncating these 8 bytes to
;;      the WRONG length (what the old always-gated code could not safely
;;      avoid without decoding the GC-codec descriptor) would silently
;;      reconstruct the array from the wrong segment offset/length — this is
;;      the case that actually exercises the fix in this task.
;;   3. `$refs = array.new_fixed $refs 2 (struct.new $item 7) (struct.new
;;      $item 8)` — `ArrayFixed` over a MUTABLE NON-NULL INTERNAL-GC-
;;      reference element type: provenance_scalar_length == 0 but
;;      provenance_reference_count == 2 (one provenance REFERENCE per
;;      element) — the array-of-references / reference-child path.
;;
;; Held live across the fork boundary, reconstructed in the CHILD, and
;; re-verified in the PARENT afterward (post-fork non-interference).
;;
;; Exit codes (parent-observed; `WEXITSTATUS` unwraps the child's own
;; `kernel_exit`/`exit_group` code):
;;   0  = success
;;   91 = CHILD: `$scalars_fixed` failed verification
;;   93 = CHILD: `$data_bytes` failed verification
;;   94 = CHILD: `$refs` failed verification
;;   95 = PARENT: post-fork re-verification failed (any of the three)
;;   92 = wait4 did not reap the expected child, or the child's own exit
;;        status (as observed by the parent) was nonzero
;;
;; Regenerate (from within `scripts/dev-shell.sh` — see `native_fork_gc_
;; struct_cycle.wat`'s doc comment for why a Rust generator, not WABT):
;;   cargo test -p host-native --lib -- --ignored \
;;     regenerate_native_fork_gc_array_cycle_fixture --nocapture
;;   scripts/run-wasm-fork-instrument.sh \
;;     crates/host-native/fixtures/native_fork_gc_array_cycle.wasm \
;;     -o crates/host-native/fixtures/native_fork_gc_array_cycle.instrumented.wasm \
;;     --entry kernel.kernel_fork
(module
  (import "env" "memory" (memory 1 16384 shared))
  (import "env" "__channel_base" (global $__channel_base (mut i32)))
  (import "kernel" "kernel_fork"
    (func $kernel_fork (param i32) (result i32)))

  (type $item
    (struct
      (field (mut i32))))

  (type $scalars (array i32))
  (type $databytes (array i8))
  (type $refs (array (mut (ref $item))))

  ;; Passive data segment backing the `array.new_data` test: bytes
  ;; [100, 101, 102, 103].
  (data $seg "\64\65\66\67")

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

  ;; `$scalars_fixed`: length 3, elements [11, 22, 33].
  (func $verify_scalars_fixed (param $arr (ref $scalars)) (result i32)
    local.get $arr
    array.len
    i32.const 3
    i32.ne
    if
      i32.const 0
      return
    end
    local.get $arr
    i32.const 0
    array.get $scalars
    i32.const 11
    i32.ne
    if
      i32.const 0
      return
    end
    local.get $arr
    i32.const 1
    array.get $scalars
    i32.const 22
    i32.ne
    if
      i32.const 0
      return
    end
    local.get $arr
    i32.const 2
    array.get $scalars
    i32.const 33
    i32.ne
    if
      i32.const 0
      return
    end
    i32.const 1)

  ;; `$data_bytes`: length 4, elements [100, 101, 102, 103] — the exact
  ;; content of the passive data segment at offset 0, length 4. A WRONG
  ;; provenance (offset, length) at replay time would either trap (bad
  ;; segment bounds) or produce different byte VALUES here.
  (func $verify_data_bytes (param $arr (ref $databytes)) (result i32)
    local.get $arr
    array.len
    i32.const 4
    i32.ne
    if
      i32.const 0
      return
    end
    local.get $arr
    i32.const 0
    array.get_u $databytes
    i32.const 100
    i32.ne
    if
      i32.const 0
      return
    end
    local.get $arr
    i32.const 1
    array.get_u $databytes
    i32.const 101
    i32.ne
    if
      i32.const 0
      return
    end
    local.get $arr
    i32.const 2
    array.get_u $databytes
    i32.const 102
    i32.ne
    if
      i32.const 0
      return
    end
    local.get $arr
    i32.const 3
    array.get_u $databytes
    i32.const 103
    i32.ne
    if
      i32.const 0
      return
    end
    i32.const 1)

  ;; `$refs`: length 2, elements are `$item` structs holding 7 and 8.
  (func $verify_refs (param $arr (ref $refs)) (result i32)
    (local $item0 (ref null $item))
    (local $item1 (ref null $item))
    local.get $arr
    array.len
    i32.const 2
    i32.ne
    if
      i32.const 0
      return
    end
    local.get $arr
    i32.const 0
    array.get $refs
    local.set $item0
    local.get $arr
    i32.const 1
    array.get $refs
    local.set $item1
    local.get $item0
    ref.is_null
    if
      i32.const 0
      return
    end
    local.get $item1
    ref.is_null
    if
      i32.const 0
      return
    end
    local.get $item0
    ref.as_non_null
    struct.get $item 0
    i32.const 7
    i32.ne
    if
      i32.const 0
      return
    end
    local.get $item1
    ref.as_non_null
    struct.get $item 0
    i32.const 8
    i32.ne
    if
      i32.const 0
      return
    end
    i32.const 1)

  (func $test_gc_array
    (local $scalars_fixed (ref null $scalars))
    (local $data_bytes (ref null $databytes))
    (local $refs (ref null $refs))
    (local $pid i32)

    ;; $scalars_fixed = array.new_fixed $scalars 3 (11, 22, 33)
    i32.const 11
    i32.const 22
    i32.const 33
    array.new_fixed $scalars 3
    local.set $scalars_fixed

    ;; $data_bytes = array.new_data $databytes $seg (offset=0, len=4)
    i32.const 0
    i32.const 4
    array.new_data $databytes $seg
    local.set $data_bytes

    ;; $refs = array.new_fixed $refs 2 (struct.new $item 7, struct.new $item 8)
    i32.const 7
    struct.new $item
    i32.const 8
    struct.new $item
    array.new_fixed $refs 2
    local.set $refs

    ;; Fork with all three arrays held live across the boundary.
    i32.const 0
    call $kernel_fork
    local.set $pid

    local.get $pid
    i32.eqz
    if
      ;; CHILD: all three reconstructed arrays must verify.
      local.get $scalars_fixed
      ref.as_non_null
      call $verify_scalars_fixed
      i32.eqz
      if
        i32.const 91
        call $exit_group
      end
      local.get $data_bytes
      ref.as_non_null
      call $verify_data_bytes
      i32.eqz
      if
        i32.const 93
        call $exit_group
      end
      local.get $refs
      ref.as_non_null
      call $verify_refs
      i32.eqz
      if
        i32.const 94
        call $exit_group
      end
      i32.const 0
      call $exit_group
      unreachable
    end

    ;; PARENT: its own arrays must be unaffected by forking.
    local.get $scalars_fixed
    ref.as_non_null
    call $verify_scalars_fixed
    i32.eqz
    if
      i32.const 95
      call $exit_group
    end
    local.get $data_bytes
    ref.as_non_null
    call $verify_data_bytes
    i32.eqz
    if
      i32.const 95
      call $exit_group
    end
    local.get $refs
    ref.as_non_null
    call $verify_refs
    i32.eqz
    if
      i32.const 95
      call $exit_group
    end

    local.get $pid
    call $require_child_ok)

  (func (export "_start")
    call $test_gc_array
    i32.const 0
    call $exit_group
    unreachable))
