;; N1 refcomplete substrate (2026-09-05): a REAL WASM `externref` still
;; hits the platform's gate (`-EOPNOTSUPP`) when it carries NO recorded
;; mint-time provenance, and — the specific pre-existing bug this fixture
;; targets — the PARENT must survive that gate cleanly (no hang) rather than
;; the guest OS thread silently dying and the host's 30s `run_pump`
;; watchdog firing.
;;
;; WHY THIS FIXTURE, NOT `native_fork_externref_gate.wat`: that older
;; fixture mints its externref via a DIRECT `call $resolve_externref`. Since
;; the N1-F5 T1 provenance-wrapper pass
;; (`crates/fork-instrument/src/externref_provenance.rs`) rewrites every
;; DIRECT call to a declared externref-returning host import, that fixture's
;; mint site now DOES get its identity recorded — so, now that
;; `crates/host-native/src/guest.rs`'s `gc_lookup` binding performs the
;; capture short-circuit (peek the transit slot, recover the externref,
;; check provenance, `intern_externref` on a hit), that fixture's fork
;; actually SUCCEEDS (reconstructs) rather than gating. It is superseded, as
;; a GATE proof, by `native_fork_externref_reconstruct.wat`'s success proof.
;;
;; This fixture instead mints its externref through a `call_indirect`
;; against a one-element funcref table whose sole slot is populated (via an
;; ACTIVE element segment) with the SAME `resolve_externref` import. This is
;; the documented residual gap the provenance-wrapper pass's own module doc
;; comment records: "This pass only rewrites DIRECT `call` instructions
;; whose static target is a declared function import. It does not attempt
;; to prove anything about `call_indirect`/`call_ref` landing on an
;; externref-returning import placed into a `funcref` table." So this
;; production site is NEVER wrapped, `ExternrefProvenance` never records an
;; entry for the resulting value, and `gc_lookup`'s lookup-by-identity
;; correctly MISSES — falling through, exactly as designed, to the
;; unconditional `mark_unsupported` + `gated_placeholder` gate. This
;; exercises the SOUNDNESS GUARD (no fabricated handle on a provenance miss)
;; and the gate-hang fix (`drive_fork_capture_seal_and_launch_child`'s
;; gated-abort branch no longer drives `fm_build_gc_plan`/`fm_drive_execute`
;; against the sealed placeholder graph) together, end to end.
;;
;; The fixture:
;;   1. Mints a live externref (handle 42) via `call_indirect` through the
;;      one-element `$indirect` table (populated by an active element
;;      segment with `resolve_externref` itself), into a LOCAL live across
;;      the fork call below.
;;   2. Forks with that local live across `kernel_fork`.
;;   3. Asserts the fork's OWN return value is EXACTLY `-95` (`-EOPNOTSUPP`)
;;      — never `0` (would mean a child actually ran) and never a positive
;;      pid (would mean a real child was spawned despite the gate).
;;   4. PARENT: touches the (now-gated) externref local through the native
;;      test probe `native_test_externref_payload`, just to prove the
;;      resume path completed without trapping or hanging. The result is
;;      NOT asserted against the original handle — a gated capture does not
;;      preserve identity across the aborted fork's unwind/rewind.
;;
;; Exit codes (parent-observed; there is never a child to reap):
;;   0  = success (fork cleanly EOPNOTSUPP'd, no child spawned, parent
;;        resumed and ran to completion without hanging)
;;   90 = fork() returned something other than exactly -95 (either it looks
;;        like a child (`0`) or a real child pid (positive) — the gate did
;;        not fire, or fired with the wrong errno)
;;   93 = touching the parent's own (gated) externref local after resume
;;        trapped or otherwise misbehaved instead of completing cleanly
;;
;; Regenerate (from within `scripts/dev-shell.sh`):
;;   wat2wasm --enable-exceptions --enable-threads \
;;     crates/host-native/fixtures/native_fork_externref_gate_indirect.wat \
;;     -o crates/host-native/fixtures/native_fork_externref_gate_indirect.wasm
;;   scripts/run-wasm-fork-instrument.sh \
;;     crates/host-native/fixtures/native_fork_externref_gate_indirect.wasm \
;;     -o crates/host-native/fixtures/native_fork_externref_gate_indirect.instrumented.wasm \
;;     --entry kernel.kernel_fork
(module
  (import "env" "memory" (memory 1 16384 shared))
  (import "env" "__channel_base" (global $__channel_base (mut i32)))
  (import "kernel" "kernel_fork"
    (func $kernel_fork (param i32) (result i32)))
  ;; Mints a live externref wrapping the given `u32` handle — native's own
  ;; test-only broker (`guest.rs::define_resolve_externref`). Called ONLY
  ;; via `call_indirect` below (never a direct `call`), so the T1
  ;; provenance-wrapper pass never rewrites this call site — see this
  ;; file's doc comment.
  (import "env" "resolve_externref"
    (func $resolve_externref (param i32) (result externref)))
  ;; Native test-only diagnostic: unwraps the `u32` handle payload an
  ;; externref minted by `resolve_externref` carries, or reports `-1` for a
  ;; null externref — see `guest.rs::define_externref_payload_probe`'s doc
  ;; comment.
  (import "env" "native_test_externref_payload"
    (func $native_test_externref_payload (param externref) (result i32)))

  (type $resolve_ty (func (param i32) (result externref)))

  ;; The one-element indirect-call table: slot 0 is the SAME
  ;; `resolve_externref` import, populated via an ACTIVE element segment
  ;; (bootstrap-time `table.init`, not a runtime `table.set`) so the T1
  ;; provenance pass's direct-call rewrite has no call site to find here —
  ;; only the `call_indirect` below ever reaches it.
  (table $indirect 1 funcref)
  (elem (table $indirect) (i32.const 0) func $resolve_externref)

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

  (func $test_gate
    (local $externref_local externref)
    (local $pid i32)

    ;; Mint a live externref (handle 42) via `call_indirect`, NOT a direct
    ;; `call` — see this file's doc comment for why that leaves it with no
    ;; recorded provenance. Args first, then the table index.
    i32.const 42
    i32.const 0
    call_indirect $indirect (type $resolve_ty)
    local.set $externref_local

    ;; Fork with the externref local live across the boundary. With no
    ;; recorded provenance, `gc_lookup`'s capture short-circuit misses and
    ;; falls through to `mark_unsupported` + `gated_placeholder`, so this
    ;; call returns normally with a forced EOPNOTSUPP.
    i32.const 0
    call $kernel_fork
    local.set $pid

    ;; The fork must abort with EOPNOTSUPP (errno 95) BEFORE any child is
    ;; spawned: `pid` must be EXACTLY -95 — never `0` (would mean this is
    ;; actually a running child) and never positive (would mean a real
    ;; child was spawned despite the gate).
    local.get $pid
    i32.const -95
    i32.ne
    if
      i32.const 90
      call $exit_group
    end

    ;; PARENT continues: touch its own (now-gated) externref local through
    ;; the native test probe, just to prove the resume path completed
    ;; without trapping OR hanging (the gate-hang fix under test). The
    ;; result is deliberately NOT asserted against the original handle (42)
    ;; — a gated capture does not preserve identity across the aborted
    ;; fork's unwind/rewind.
    local.get $externref_local
    call $native_test_externref_payload
    drop)

  (func (export "_start")
    call $test_gate
    i32.const 0
    call $exit_group
    unreachable))
