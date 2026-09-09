;; N1-F6 (refcomplete FLOOR-2) SETTLING EXPERIMENT: two DIFFERENT live
;; Wasm-GC struct instances, `a` and `b`, forming a MUTUAL cycle
;; (`a.next == b`, `b.next == a`) through a MUTABLE, NON-NULLABLE internal
;; reference field — the one case the grounding doc
;; (`docs/plans/2026-09-05-n1-f6-gc-provenance-grounding.md` §3) flags as not
;; settled by reading alone, because it genuinely exercises the
;; constructor-PROVENANCE mechanism (`gc_provenance_begin`/`_ref`/`_end`),
;; unlike the simpler self-cycle fixture
;; (`native_fork_gc_struct_cycle.wat`), whose NULLABLE self field never
;; triggers it.
;;
;; WHY a supertype "seed" bootstrap (`$node_base`): a struct type cannot
;; supply ITSELF as a `struct.new` argument (the value does not exist yet),
;; so the very first instance of a type whose field is EXACTLY its own
;; concrete type can never be constructed at all — not a platform gap, a
;; genuine WebAssembly-GC constraint (single-pass stack evaluation: a
;; `struct.new` operand must already be a fully-constructed value). Real
;; programs bootstrap a non-nullable, internal-GC-typed back-reference field
;; by typing it as a (possibly trivial) COMMON ANCESTOR type instead:
;; `$node_base` is an empty struct (trivially constructible, no chicken/egg),
;; and `$pair` is declared `(sub $node_base ...)` with its own second field
;; typed `(ref $node_base)` — non-nullable and still a CONCRETE declared GC
;; type (the "internal-GC-typed" condition `requires_provenance` checks for
;; — see the grounding §2.2's "not when it names a concrete internal GC
;; type"), so this is not an abstract-type escape hatch. `$pair <: $node_base`
;; (structural subtyping), so a live `$pair` value satisfies a
;; `$node_base`-typed field, and the injected codec's own `ref.test`-based
;; dispatch (already validated for exactly this "field typed as an
;; ANCESTOR, but the live value is a more specific declared type" shape by
;; `create_externalized_cycle`/`verify_externalized_cycle` in
;; `module_gc_codec_node.rs`) recurses into the value's REAL, most-derived
;; type when capturing it.
;;
;; The fixture:
;;   1. Constructs a shared, field-less `seed: $node_base` (needs no
;;      provenance itself — zero fields, nothing to seed).
;;   2. Constructs `a = $pair { scalar: 11, next: seed }` and
;;      `b = $pair { scalar: 22, next: seed }` — EACH of these `struct.new`
;;      calls is provenance-wrapped (a mutable, non-nullable,
;;      internal-GC-typed field), recording `seed` as the constructor-time
;;      evidence.
;;   3. Rewires the real cycle via ordinary mutation (NOT provenance):
;;      `a.next = b`, `b.next = a`.
;;   4. Forks with `a` and `b` both held live in locals across the boundary.
;;   5. In the CHILD: `a.next` must dynamically be `$pair` (not just
;;      `$node_base`), identity-equal to the reconstructed `b`, with `b`'s
;;      own scalar (22) reachable through it — and symmetrically for
;;      `b.next` naming `a` (11). A structural (non-identity-preserving)
;;      copy, or a reconstruction that stopped at the field's STATIC
;;      `$node_base` type instead of `a`/`b`'s real `$pair` type, both fail
;;      this check.
;;   6. In the PARENT (after fork returns): re-checks its own `a`/`b` are
;;      unaffected, then reaps the child and propagates a nonzero child
;;      status.
;;
;; Exit codes (parent-observed; `WEXITSTATUS` unwraps the child's own
;; `kernel_exit` code):
;;   0  = success (both cross-object identities + the cycle round-tripped in
;;        the child, parent unaffected)
;;   91 = CHILD: reconstructed `a`/`b` failed verification
;;   95 = PARENT: post-fork `a`/`b` failed the same verification
;;   92 = wait4 did not reap the expected child, or the child's own exit
;;        status (as observed by the parent) was nonzero
;;
;; Regenerate (from within `scripts/dev-shell.sh` — see
;; `native_fork_gc_struct_cycle.wat`'s doc comment for why the Rust `wat`
;; crate, not the dev shell's WABT `wat2wasm`, compiles this):
;;   cargo test -p host-native --lib -- --ignored \
;;     regenerate_native_fork_gc_two_object_cycle_fixture --nocapture
;;   scripts/run-wasm-fork-instrument.sh \
;;     crates/host-native/fixtures/native_fork_gc_two_object_cycle.wasm \
;;     -o crates/host-native/fixtures/native_fork_gc_two_object_cycle.instrumented.wasm \
;;     --entry kernel.kernel_fork
(module
  (import "env" "memory" (memory 1 16384 shared))
  (import "env" "__channel_base" (global $__channel_base (mut i32)))
  (import "kernel" "kernel_fork"
    (func $kernel_fork (param i32) (result i32)))

  ;; `sub` with no supertype still marks the type OPEN (subtypable) — a
  ;; plain `(struct)` declaration is FINAL by default and `$pair` could not
  ;; extend it.
  (type $node_base (sub (struct)))
  (type $pair
    (sub $node_base
      (struct
        (field (mut i32))
        (field (mut (ref $node_base))))))

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

  ;; Verifies the mutual cycle `a.next == b`, `b.next == a` (dynamically
  ;; typed as `$pair`, identity-equal, with the expected scalars reachable
  ;; through the cross-reference). Returns 1 on success, 0 on any mismatch.
  (func $verify_pairs (param $a (ref $pair)) (param $b (ref $pair)) (result i32)
    (local $a_next (ref null $node_base))
    (local $b_next (ref null $node_base))
    (local $a_next_pair (ref $pair))
    (local $b_next_pair (ref $pair))

    local.get $a
    struct.get $pair 0
    i32.const 11
    i32.ne
    if
      i32.const 0
      return
    end

    local.get $b
    struct.get $pair 0
    i32.const 22
    i32.ne
    if
      i32.const 0
      return
    end

    local.get $a
    struct.get $pair 1
    local.set $a_next
    local.get $b
    struct.get $pair 1
    local.set $b_next

    local.get $a_next
    ref.test (ref $pair)
    i32.eqz
    if
      i32.const 0
      return
    end
    local.get $b_next
    ref.test (ref $pair)
    i32.eqz
    if
      i32.const 0
      return
    end

    local.get $a_next
    ref.cast (ref $pair)
    local.set $a_next_pair
    local.get $b_next
    ref.cast (ref $pair)
    local.set $b_next_pair

    ;; a.next must be IDENTITY-EQUAL to b, and vice versa.
    local.get $a_next_pair
    local.get $b
    ref.eq
    i32.eqz
    if
      i32.const 0
      return
    end
    local.get $b_next_pair
    local.get $a
    ref.eq
    i32.eqz
    if
      i32.const 0
      return
    end

    ;; The scalar reachable THROUGH the cross-reference must match the
    ;; target's own scalar (proves a full `$pair` reconstruction, not a
    ;; shell stuck at the field's static `$node_base` type).
    local.get $a_next_pair
    struct.get $pair 0
    i32.const 22
    i32.ne
    if
      i32.const 0
      return
    end
    local.get $b_next_pair
    struct.get $pair 0
    i32.const 11
    i32.ne
    if
      i32.const 0
      return
    end

    i32.const 1)

  (func $test_gc_two_object_cycle
    (local $seed (ref $node_base))
    (local $a (ref null $pair))
    (local $b (ref null $pair))
    (local $pid i32)

    struct.new $node_base
    local.set $seed

    ;; a = $pair { 11, seed } -- provenance-wrapped (mutable, non-nullable,
    ;; internal-GC-typed field).
    i32.const 11
    local.get $seed
    struct.new $pair
    local.set $a

    ;; b = $pair { 22, seed } -- likewise provenance-wrapped.
    i32.const 22
    local.get $seed
    struct.new $pair
    local.set $b

    ;; Rewire the REAL cycle via ordinary mutation (not provenance):
    ;; a.next = b, b.next = a.
    local.get $a
    ref.as_non_null
    local.get $b
    ref.as_non_null
    struct.set $pair 1

    local.get $b
    ref.as_non_null
    local.get $a
    ref.as_non_null
    struct.set $pair 1

    ;; Fork with both a and b held live across the boundary.
    i32.const 0
    call $kernel_fork
    local.set $pid

    local.get $pid
    i32.eqz
    if
      ;; CHILD: the reconstructed mutual cycle must verify.
      local.get $a
      ref.as_non_null
      local.get $b
      ref.as_non_null
      call $verify_pairs
      i32.eqz
      if
        i32.const 91
        call $exit_group
      end
      i32.const 0
      call $exit_group
      unreachable
    end

    ;; PARENT: its own a/b must be unaffected by forking.
    local.get $a
    ref.as_non_null
    local.get $b
    ref.as_non_null
    call $verify_pairs
    i32.eqz
    if
      i32.const 95
      call $exit_group
    end

    local.get $pid
    call $require_child_ok)

  (func (export "_start")
    call $test_gc_two_object_cycle
    i32.const 0
    call $exit_group
    unreachable))
