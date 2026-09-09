;; P4 (Path-B flip completion): the Node/V8 analogue of native's
;; `crates/host-native/fixtures/native_fork_externref_gate_indirect.wat`.
;;
;; A REAL host `externref` held LIVE across `kernel_fork` still hits the
;; platform's one intended gate (`-EOPNOTSUPP`, errno 95) when it carries NO
;; recorded mint-time provenance, and — the property this fixture proves under
;; the co-resident fork MODULE (`forkModuleEnabled: true`) — the fork aborts
;; cleanly through the module's OWN continuation-journal abort path
;; (`beginModuleAbortReplay` -> `fm_begin_abort`), the PARENT survives
;; UNAFFECTED, and no partial child is spawned. It is the module-mode gated-
;; ABORT end-to-end coverage deferred from P3b (review Finding D) and the
;; V8 parity mate of native's `smoke_fork_gated_externref_parent_survives`.
;;
;; WHY `call_indirect`, NOT a direct `call $get_ext`: the fork-instrument
;; provenance-wrapper pass
;; (`crates/fork-instrument/src/externref_provenance.rs`) only rewrites DIRECT
;; `call` instructions whose static target is a declared externref-returning
;; host import (see that pass's own module doc comment; it explicitly does not
;; reason about `call_indirect`/`call_ref`). A direct `call $get_ext` — as in
;; `externref-local-fork-fresh-worker.wat` — therefore gets its identity
;; recorded and its fork SUCCEEDS (reconstructs). This fixture instead mints
;; its externref through a `call_indirect` against a one-element funcref table
;; whose sole slot is populated (via an ACTIVE element segment) with the SAME
;; `get_ext` import, so the pass finds no call site to wrap: no provenance is
;; recorded, `GC_LOOKUP` misses, `encodeGcFromSlot` finds no recognizing
;; provider, and the fork falls through — exactly as designed — to
;; `markUnsupportedReferenceKind` + a gated placeholder, then a clean
;; `-EOPNOTSUPP` abort. The broker import records NO provenance of its own
;; (the provenance table is fed only by the injected
;; `__wpk_fork_ref_provenance_externref` import body), so bypassing the direct
;; call is sufficient to reach the gate on V8, mirroring native.
;;
;; Exit codes (parent-observed; there is never a child to reap):
;;   0  = success: fork cleanly EOPNOTSUPP'd (returned exactly -95), no child
;;        was spawned, the parent resumed WITHOUT hanging, and its externref
;;        local still resolves to the SAME owner-minted host identity.
;;   90 = the pre-fork parent reference was null (fixture wiring bug).
;;   91 = the pre-fork parent reference did not resolve to the owner identity.
;;   92 = fork() returned something other than exactly -95: either 0 (this is
;;        actually a running child) or a positive pid (a real child was
;;        spawned) — the gate did not fire, or fired with the wrong errno.
;;   93 = the parent's own externref local was NULL after the aborted fork —
;;        the gated fork corrupted parent state (must-not-happen).
;;   94 = the parent's own externref local no longer resolves to the original
;;        owner identity after the aborted fork — parent state was corrupted.
(module
  (import "env" "memory" (memory 1 16384 shared))
  (import "env" "__channel_base" (global $__channel_base (mut i32)))
  (import "kernel" "kernel_exit" (func $kernel_exit (param i32)))
  (import "kernel" "kernel_fork"
    (func $kernel_fork (param i32) (result i32)))
  ;; Host reference producer/verifier, wired by the test to the process
  ;; externref owner (broker). `get_ext` is reached ONLY via `call_indirect`
  ;; below (never a direct `call`), so the provenance-wrapper pass leaves its
  ;; result with no recorded provenance — see this file's doc comment.
  (import "env" "get_ext" (func $get_ext (result externref)))
  (import "env" "check_ext" (func $check_ext (param externref) (result i32)))

  (type $get_ext_ty (func (result externref)))

  ;; The one-element indirect-call table: slot 0 is the SAME `get_ext` import,
  ;; populated via an ACTIVE element segment (bootstrap-time, not a runtime
  ;; `table.set`) so the provenance pass's direct-call rewrite has no call site
  ;; to find here — only the `call_indirect` below ever reaches it.
  (table $indirect 1 funcref)
  (elem (table $indirect) (i32.const 0) func $get_ext)

  (global $__stack_pointer (export "__stack_pointer") (mut i32)
    (i32.const 65536))

  (func (export "__abi_version") (result i32)
    i32.const 44)

  (func (export "_start")
    (local $ref externref)
    (local $pid i32)

    ;; Mint a live host externref via `call_indirect` — NOT a direct `call` —
    ;; so it carries no recorded provenance. Table index 0 -> `$get_ext`.
    i32.const 0
    call_indirect $indirect (type $get_ext_ty)
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
      i32.const 91
      call $kernel_exit
      unreachable
    end

    ;; Fork with the no-provenance externref live across the boundary. Capture
    ;; marks the fork unsupported and the parent run loop aborts it cleanly
    ;; with -EOPNOTSUPP after seal, through the module's own abort path.
    i32.const 0
    call $kernel_fork
    local.set $pid

    ;; The fork must abort with EOPNOTSUPP (errno 95) BEFORE any child is
    ;; spawned: `pid` must be EXACTLY -95 — never 0 (would mean this is a
    ;; running child) and never positive (a real child spawned despite the
    ;; gate).
    local.get $pid
    i32.const -95
    i32.ne
    if
      i32.const 92
      call $kernel_exit
      unreachable
    end

    ;; PARENT survives unaffected: its externref local must still be non-null
    ;; and still resolve to the SAME owner-minted host identity after the
    ;; aborted fork's unwind/rewind. A null (93) or divergent (94) value means
    ;; the gated fork corrupted parent state instead of leaving it alone.
    local.get $ref
    ref.is_null
    if
      i32.const 93
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
    unreachable))
