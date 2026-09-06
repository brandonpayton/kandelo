# host-native test fixtures

## `native_hello.wasm`

The trivial guest the native Wasmtime host runs end-to-end in
`smoke_runs_trivial_guest_through_channel` (see `../src/guest.rs`). Source:
`native_hello.c`.

It is built through the SDK toolchain with the **same** compile/link recipe
`scripts/build-programs.sh` uses for the example C programs — same `CFLAGS`,
the channel syscall glue, `compiler_rt.c`, `crt1.o`, and `libc.a`. A
non-forking standalone program is returned byte-for-byte unchanged by
`wasm-fork-instrument`, so the raw linker output is committed directly (no
fork instrumentation step).

The committed `.wasm` is checked in so the test needs only a built
`kernel.wasm`, not a full guest-program build. Regenerate it from within the
dev shell (`scripts/dev-shell.sh`) whenever `native_hello.c`, the libc glue, or
the ABI changes:

```sh
# From the repo root, inside scripts/dev-shell.sh. SYSROOT must be a sysroot
# built for the current ABI (this branch's libc). $LLVM_BIN is set by the shell.
SYSROOT=<repo>/sysroot
GLUE=<repo>/libc/glue
OUT=crates/host-native/fixtures

"$LLVM_BIN/clang" \
  --target=wasm32-unknown-unknown --sysroot="$SYSROOT" -nostdlib -O2 \
  -matomics -mbulk-memory -fno-trapping-math \
  -mllvm -wasm-enable-sjlj -mllvm -wasm-use-legacy-eh=false \
  "$OUT/native_hello.c" \
  "$GLUE/channel_syscall.c" "$GLUE/compiler_rt.c" "$SYSROOT/lib/crt1.o" \
  "$SYSROOT/lib/libc.a" \
  -Wl,--no-entry -Wl,--export=_start -Wl,--import-memory -Wl,--shared-memory \
  -Wl,--max-memory=1073741824 -Wl,--allow-undefined -Wl,--table-base=3 \
  -Wl,--export-table -Wl,--growable-table \
  -Wl,--export=__wasm_init_tls -Wl,--export=__tls_base -Wl,--export=__tls_size \
  -Wl,--export=__tls_align -Wl,--export=__stack_pointer \
  -Wl,--export=__wasm_thread_init -Wl,--export=__abi_version \
  -o "$OUT/native_hello.wasm"
```

The program's `__abi_version` export must match the kernel's ABI (the host
asserts this at load), so a stale fixture built for an older ABI fails loudly
rather than running wrong.

## `native_fork.instrumented.wasm`

`smoke_fork_parent_child`'s fixture (N1-I4 Task 3): the SAME source as
`native_fork.wasm` (`native_fork.c`), but run through the REAL production
fork-instrumentation tool (`scripts/run-wasm-fork-instrument.sh` — the exact
tool every fork-using package build runs its own artifacts through), so its
`fork()` call site can actually unwind/rewind through the co-resident
fork-module's `fm_*` coordinator (`guest.rs`'s `run_fork_capable_entry`).
`native_fork.wasm` itself (this fixture's un-instrumented sibling) stays
committed too — nothing still needs it directly, but it is still produced by
`build-fixtures.sh`'s uniform "every `.c` in this directory" loop, and
removing it would be an unrelated, unforced change.

Regenerate both from within the dev shell:

```sh
# 1. Rebuild every fixture (including native_fork.wasm) through the SDK:
SYSROOT=<repo>/sysroot scripts/dev-shell.sh \
  bash crates/host-native/fixtures/build-fixtures.sh

# 2. Instrument native_fork.wasm specifically:
scripts/dev-shell.sh bash -lc '
  cd crates/host-native/fixtures
  <repo>/scripts/run-wasm-fork-instrument.sh \
    native_fork.wasm -o native_fork.instrumented.wasm --entry kernel.kernel_fork
'
```

Like `native_hello.wasm`, the program's `__abi_version` must match the
kernel's ABI, and re-running step 2 after any `crates/fork-instrument` change
picks up the current instrumentation tool automatically (see
`scripts/run-wasm-fork-instrument.sh`'s own input-hash rebuild check).

## `native_vfork.instrumented.wasm` / `native_vfork_exec.instrumented.wasm`

`smoke_vfork_exit_shares_memory_and_blocks_parent`'s and `smoke_vfork_
execve_releases_parent`'s fixtures (real vfork, N1 residual): the vfork
analogues of `native_fork.instrumented.wasm`. `native_vfork.c`'s child
writes a genuinely SHARED global (`shared_marker`) then `_exit`s; the parent
checks that write is visible after `vfork()` returns — the proof that this
host's `vfork()` borrows the parent's own memory rather than cloning it, as
plain `fork()` does. `native_vfork_exec.c`'s child instead `execve`s the
existing `native_exec_target.wasm` fixture, proving the parent stays
suspended all the way to a successful exec commit, not just to a `_exit`.

Regenerate both from within the dev shell, same recipe as `native_fork.
instrumented.wasm`:

```sh
SYSROOT=<repo>/sysroot scripts/dev-shell.sh bash crates/host-native/fixtures/build-fixtures.sh

scripts/dev-shell.sh bash -lc '
  cd crates/host-native/fixtures
  <repo>/scripts/run-wasm-fork-instrument.sh \
    native_vfork.wasm -o native_vfork.instrumented.wasm --entry kernel.kernel_fork
  <repo>/scripts/run-wasm-fork-instrument.sh \
    native_vfork_exec.wasm -o native_vfork_exec.instrumented.wasm --entry kernel.kernel_fork
'
```

Like every other fixture, `__abi_version` must match the kernel's ABI.

## `native_fork_from_thread.instrumented.wasm` / `native_fork_from_thread.wasm`

`smoke_fork_from_thread`'s (currently `#[ignore]`d) and `smoke_fork_from_
thread_non_instrumented`'s (passing) fixtures (N1 residual #4a,
non-main-thread `fork()`): the SAME real-fork proof as `native_fork.c`,
except `fork()` is called from a PTHREAD `main` creates and joins, never the
main thread itself. `main` calls `pthread_create`, the pthread's own
`forker` function calls `fork()`, and `main`'s `pthread_join` must return
the forking pthread's own reaped exit status — proving the pthread's OS
thread was not silently killed and no joiner hangs. The non-instrumented
`.wasm` sibling is fully working (see that test's doc comment); the
`.instrumented.wasm` variant currently hits a deeper `crates/fork-
instrument`/`crates/fork-codec` resume-slot gap for a `wpk_fork_resume_
thread`-reached (non-`_start`) captured chain — see `smoke_fork_from_
thread`'s own doc comment for the full root-cause trace.

Regenerate both from within the dev shell, same recipe as `native_fork.
instrumented.wasm`:

```sh
SYSROOT=<repo>/sysroot scripts/dev-shell.sh bash crates/host-native/fixtures/build-fixtures.sh

scripts/dev-shell.sh bash -lc '
  cd crates/host-native/fixtures
  <repo>/scripts/run-wasm-fork-instrument.sh \
    native_fork_from_thread.wasm -o native_fork_from_thread.instrumented.wasm \
    --entry kernel.kernel_fork
'
```

Like every other fixture, `__abi_version` must match the kernel's ABI.

## `native_fork_refs.instrumented.wasm`

`smoke_fork_reconstructs_references`'s fixture (N1-I5 Task 3, currently
`#[ignore]`d — see that test's doc comment for why). Unlike every other
fixture here, the source is hand-written WAT
(`native_fork_refs.wat`), not C: a genuine WASM `funcref`/`externref`
*value* held live across `fork()` is not reachable from portable C on this
SDK's clang/LLVM 21 toolchain (`__funcref`-qualified pointer types parse but
reproducibly ICE the compiler on every realistic use tried), matching the
Node/browser hosts' own reason for hand-writing `host/test/fixtures/
funcref-local-fork-fresh-worker.wat` / `externref-local-fork-fresh-worker.wat`.
`native_fork_refs.wat`'s own doc comment has the full design (what each
reference kind proves, exit-code table) and current status (assembles and
instruments cleanly; the RUN currently traps during CAPTURE on native's
documented, pre-existing "no module-state capture mechanism yet" gap — see
`guest.rs`'s `write_empty_module_state_arena` doc comment).

Regenerate from within the dev shell:

```sh
# 1. Assemble the hand-written WAT (WABT's wat2wasm, not the SDK's clang):
scripts/dev-shell.sh bash -lc '
  cd crates/host-native/fixtures
  wat2wasm --enable-exceptions --enable-threads \
    native_fork_refs.wat -o native_fork_refs.wasm
'

# 2. Instrument it, exactly like native_fork.wasm:
scripts/dev-shell.sh bash -lc '
  cd crates/host-native/fixtures
  <repo>/scripts/run-wasm-fork-instrument.sh \
    native_fork_refs.wasm -o native_fork_refs.instrumented.wasm \
    --entry kernel.kernel_fork
'
```

Like every other fixture, `__abi_version` must match the kernel's ABI.
