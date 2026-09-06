;; N1-F5 Task 2: a REAL WASM `externref` held LIVE across a native
;; `kernel_fork`, reconstructed IDENTITY-PRESERVED in the child — the
;; externref analogue of `native_fork_refs.wat`'s funcref success fixture.
;;
;; STATUS: BLOCKED — see `crates/host-native/src/lib.rs`'s
;; `smoke_fork_externref_reconstructs` (`#[ignore]`d) and
;; `.superpowers/sdd/2026-09-05-n1-f5-externref-capture/task-2-report.md`
;; for the full writeup. Short version: this fixture's CAPTURE half is sound
;; and was verified to work (mint-time provenance recording via
;; `__wpk_fork_ref_provenance_externref` + a `gc_lookup`-side identity check
;; — see `guest.rs`'s doc comment on its `gc_lookup` binding for exactly why
;; `gc_lookup`, not `__wpk_fork_ref_encode_externref`, is the real capture
;; entry point a plain externref local reaches). What's NOT sound yet is
;; DECODE: the frozen/shared replay drive-plan builder
;; (`crates/fork_codec::drive_plan::build_drive_plan`) only schedules a
;; transit-publish for an externref reachable from a GC struct/array field
;; or exception payload, not one reachable only from an ordinary frame
;; reference vector (this fixture's case) — so lifting the encode-side gate
;; without a companion fix there makes BOTH the parent's resume and the
;; child's rewind trap reading an unpopulated transit slot, instead of the
;; clean, parent-survives `EOPNOTSUPP` `native_fork_externref_gate.wat`
;; still proves today. That companion fix lives outside `crates/host-native`
;; (in `crates/fork-codec`/`crates/fork-module`/`crates/fork-instrument`),
;; so this fixture and its test stay unwired/ignored until it lands.
;;
;; Once the decode-side gap above closes, this fixture is expected to prove:
;; mint a live externref via `env.resolve_externref` into a local, fork,
;; and observe the SAME handle (42) resolve in BOTH the reconstructed CHILD
;; and the unaffected PARENT — mirroring `native_fork_refs.wat`'s funcref
;; proof shape exactly (fork, branch on child/parent, verify identity via a
;; native test probe, reap the child).
;;
;; The fixture:
;;   1. Mints a live externref via the guest's own `env.resolve_externref`
;;      import (the production site the T1 instrumenter pass wraps) into a
;;      LOCAL, using handle 42 — an arbitrary constant distinct from every
;;      other fixture's.
;;   2. Forks with that local live across `kernel_fork`.
;;   3. In the CHILD: the reconstructed externref must resolve to the SAME
;;      handle (42) via `native_test_externref_payload`. A wrong
;;      reconstruction (including a null externref, reported as `-1`) exits
;;      91.
;;   4. In the PARENT (after fork returns): re-checks its OWN carried
;;      externref is unaffected by forking (exits 95 on a mismatch), then
;;      reaps the child and propagates a nonzero child status as 92.
;;
;; Exit codes (parent-observed; `WEXITSTATUS` unwraps the child's own
;; `kernel_exit` code):
;;   0  = success (the externref round-tripped, identity-preserved, through
;;        both processes)
;;   91 = CHILD: reconstructed externref reported the wrong handle (or null)
;;   95 = PARENT: post-fork externref reported the wrong handle
;;   92 = wait4 did not reap the expected child, or the child's own exit
;;        status (as observed by the parent) was nonzero
;;
;; Regenerate (from within `scripts/dev-shell.sh`):
;;   wat2wasm --enable-exceptions --enable-threads \
;;     crates/host-native/fixtures/native_fork_externref_reconstruct.wat \
;;     -o crates/host-native/fixtures/native_fork_externref_reconstruct.wasm
;;   scripts/run-wasm-fork-instrument.sh \
;;     crates/host-native/fixtures/native_fork_externref_reconstruct.wasm \
;;     -o crates/host-native/fixtures/native_fork_externref_reconstruct.instrumented.wasm \
;;     --entry kernel.kernel_fork
(module
  (import "env" "memory" (memory 1 16384 shared))
  (import "env" "__channel_base" (global $__channel_base (mut i32)))
  (import "kernel" "kernel_fork"
    (func $kernel_fork (param i32) (result i32)))
  ;; Mints a live externref wrapping the given `u32` handle — native's own
  ;; test-only broker (`guest.rs::define_resolve_externref`), shared with the
  ;; fork-module's own `env.resolve_externref` so a directly-held externref
  ;; the guest itself minted resolves identically after reconstruction. This
  ;; is also the PRODUCTION SITE `wasm-fork-instrument`'s N1-F5 pass wraps
  ;; with a provenance-recording call — see this file's doc comment.
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

  ;; Calls `native_test_externref_payload` on `$v` and traps (via
  ;; `$exit_group`) with `$exit_code` if it does not report the expected
  ;; handle (42).
  (func $check_externref (param $v externref) (param $exit_code i32)
    local.get $v
    call $native_test_externref_payload
    i32.const 42
    i32.ne
    if
      local.get $exit_code
      call $exit_group
    end)

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

  (func $test_externref
    (local $externref_local externref)
    (local $pid i32)

    ;; Mint a live externref (handle 42) and hold it in a LOCAL, live across
    ;; the fork call below. Routed through the N1-F5 provenance wrapper by
    ;; `wasm-fork-instrument` (this call site is rewritten to call the real
    ;; `resolve_externref` import, then `__wpk_fork_ref_provenance_
    ;; externref`, before the value reaches this local).
    i32.const 42
    call $resolve_externref
    local.set $externref_local

    ;; Fork with the externref local live across the boundary.
    i32.const 0
    call $kernel_fork
    local.set $pid

    local.get $pid
    i32.eqz
    if
      ;; CHILD: the reconstructed externref must resolve to the SAME handle
      ;; (42) the parent minted.
      local.get $externref_local
      i32.const 91
      call $check_externref
      i32.const 0
      call $exit_group
      unreachable
    end

    ;; PARENT: its own carried externref must be unaffected by forking.
    local.get $externref_local
    i32.const 95
    call $check_externref

    local.get $pid
    call $require_child_ok)

  (func (export "_start")
    call $test_externref
    i32.const 0
    call $exit_group
    unreachable))
