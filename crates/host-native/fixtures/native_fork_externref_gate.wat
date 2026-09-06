;; N1-I5b Task 2: a REAL WASM `externref` held LIVE across a native
;; `kernel_fork` — the parity-gate analogue of `native_fork_refs.wat`'s
;; funcref fixture. `docs/fork-reference-support.md` gates `externref` (and
;; the typed-GC family) out of fork reconstruction: a fork that would carry
;; a live value of one of these kinds across the boundary must fail cleanly
;; with `EOPNOTSUPP` (errno 95) on the PARENT, during capture, with NO child
;; ever spawned, and the parent must keep running afterward. This fixture
;; proves that end-to-end on native.
;;
;; Hand-written WAT, not C, for the SAME reason `native_fork_refs.wat` is:
;; a genuine WASM `externref` *value* obtained from `resolve_externref` is
;; usable from C (the fixture's own `local` just holds an opaque
;; `__externref_t`), but this fixture wants full control over exactly which
;; imports are declared and the exact fork-call shape, matching the
;; project's existing hand-written-WAT precedent for ABI-44 reference
;; fixtures (`native_fork_refs.wat`, `host/test/fixtures/
;; funcref-local-fork-fresh-worker.wat`) rather than introducing a second
;; source-language convention for one small fixture.
;;
;; The fixture:
;;   1. Mints a live externref via the guest's own `env.resolve_externref`
;;      import (the SAME primitive `native_fork_refs.wat`'s HISTORY note
;;      describes using before N1-I5b Task 1 trimmed it out) into a LOCAL.
;;   2. Forks with that local live across `kernel_fork`.
;;   3. Asserts the fork's OWN return value is EXACTLY `-95` (`-EOPNOTSUPP`)
;;      — never `0` (would mean a child actually ran) and never a positive
;;      pid (would mean a real child was spawned despite the gate).
;;   4. PARENT: touches the (now-gated) externref local through the native
;;      test probe `native_test_externref_payload`, just to prove the
;;      resume path completed without trapping. N1-I5b's `NativeReference
;;      Capture` does NOT attempt to preserve the gated value's identity
;;      across the aborted fork's unwind/rewind (see its `gated_placeholder`
;;      doc comment: "Do NOT attempt to reconstruct externref/GC — that is
;;      F5/F6"), so the probe result is NOT asserted against the original
;;      handle — only that calling it does not trap.
;;
;; Exit codes (parent-observed; there is never a child to reap):
;;   0  = success (fork cleanly EOPNOTSUPP'd, no child spawned, parent
;;        resumed and ran to completion)
;;   90 = fork() returned something other than exactly -95 (either it looks
;;        like a child (`0`) or a real child pid (positive) — the gate did
;;        not fire, or fired with the wrong errno)
;;   93 = touching the parent's own (gated) externref local after resume
;;        trapped or otherwise misbehaved instead of completing cleanly
;;
;; Regenerate (from within `scripts/dev-shell.sh`):
;;   wat2wasm --enable-exceptions --enable-threads \
;;     crates/host-native/fixtures/native_fork_externref_gate.wat \
;;     -o crates/host-native/fixtures/native_fork_externref_gate.wasm
;;   scripts/run-wasm-fork-instrument.sh \
;;     crates/host-native/fixtures/native_fork_externref_gate.wasm \
;;     -o crates/host-native/fixtures/native_fork_externref_gate.instrumented.wasm \
;;     --entry kernel.kernel_fork
(module
  (import "env" "memory" (memory 1 16384 shared))
  (import "env" "__channel_base" (global $__channel_base (mut i32)))
  (import "kernel" "kernel_fork"
    (func $kernel_fork (param i32) (result i32)))
  ;; Mints a live externref wrapping the given `u32` handle — native's own
  ;; test-only broker (`guest.rs::define_resolve_externref`), shared with the
  ;; fork-module's own `env.resolve_externref` so a directly-held externref
  ;; the guest itself minted resolves identically after a SUPPORTED
  ;; reconstruction. Not exercised here (externref is GATED), but this is
  ;; the guest's only way to obtain a genuine `externref` value at all.
  (import "env" "resolve_externref"
    (func $resolve_externref (param i32) (result externref)))
  ;; Native test-only diagnostic: unwraps the `u32` handle payload an
  ;; externref minted by `resolve_externref` carries, or reports `-1` for a
  ;; null externref — see `guest.rs::define_externref_payload_probe`'s doc
  ;; comment.
  (import "env" "native_test_externref_payload"
    (func $native_test_externref_payload (param externref) (result i32)))

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

    ;; Mint a live externref (handle 42 — an arbitrary constant distinct
    ;; from every other fixture's) and hold it in a LOCAL, live across the
    ;; fork call below.
    i32.const 42
    call $resolve_externref
    local.set $externref_local

    ;; Fork with the externref local live across the boundary. The
    ;; capture-side `__wpk_fork_ref_encode_externref` gate stub
    ;; (`guest.rs`) must mark this kind unsupported and return a benign
    ;; placeholder instead of trapping, so this call returns normally.
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
    ;; without trapping. The result is deliberately NOT asserted against
    ;; the original handle (42) — see this file's doc comment for why a
    ;; gated capture does not preserve identity across the aborted fork's
    ;; unwind/rewind.
    local.get $externref_local
    call $native_test_externref_payload
    drop)

  (func (export "_start")
    call $test_gate
    i32.const 0
    call $exit_group
    unreachable))
