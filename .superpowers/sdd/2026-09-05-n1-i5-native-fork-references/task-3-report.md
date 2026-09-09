# N1-I5 Task 3 report: native fork reference reconstruction (fixture + tests)

Branch: `brandonpayton/rust-first-abi44-reconcile`. Base: `a7c798aa5`
("Host-native: reference-drive sequence compiles").

## What was asked

Build a fork-with-references fixture and the tests proving reconstruction,
on top of an already-compiling `drive_reference_replay` sequence. No more
drive logic to write "unless a real gap surfaces."

## What was found: the drive logic is real, but capture doesn't exist yet

Before writing anything, I re-checked the state at `a7c798aa5` plus
uncommitted WIP already in the worktree (a prior agent had gone further:
`env.resolve_externref` and a `native_test_externref_payload` test probe were
already scaffolded but not fully wired). I completed that wiring, then wrote
the fixture. Building it surfaced a genuine, previously undiscovered gap:
**native has no reference CAPTURE mechanism at all** — only REPLAY. This is
consistent with, and turned out to already be explicitly documented by, the
prior task's own doc comment on `write_empty_module_state_arena`
(`crates/host-native/src/guest.rs`): *"Native has no module-state CAPTURE
mechanism yet ... A future task that adds real native module-state capture
(out of this task's scope) replaces this with the guest's own captured
arena."* I did not know this sentence existed until the fixture's own runtime
trap led me to it.

Concretely: `drive_reference_replay` (the code this task's predecessor
wrote and I did not touch) always seeds `fm_begin_reference_replay` with
`fm.empty_module_state_root` — a synthesized, canonical NULL-ONLY reference
graph, regardless of what a real fork's live state was. There is no code path
in `host-native` that builds a REAL reference graph from a guest's actual
live funcref/externref/GC locals at fork time. The REPLAY-side machinery this
task DID complete (table mirroring, the guest reference-import flip, `env.
resolve_externref`, the `fm_begin_reference_replay`/`fm_build_gc_plan`/
`fm_drive_execute` sequence) is real and correctly wired against that
documented floor — but a fixture that actually captures a live reference
needs the CAPTURE side, which this task's own predecessor already scoped out.

## The fixture: `crates/host-native/fixtures/native_fork_refs.{wat,wasm,instrumented.wasm}`

Hand-written WAT, not C. `crates/host-native/fixtures/native_fork.c` (the
frame fixture) was the model per the assignment, but a genuine WASM
`funcref`/`externref` *value* (this ABI represents an ordinary C function
pointer as an i32 table index, never a first-class `funcref`) is not
reachable from portable C on this SDK's clang/LLVM 21.1.7 toolchain:

- `__externref_t` DOES compile and link cleanly for a bare
  `resolve_externref(handle) -> __externref_t` extern call with no
  conversion (verified: a standalone C program using it built, linked, and
  the compiled function had a genuine `local[N] type=externref` in its wasm
  bytecode — confirmed with `wasm-objdump`).
- `__funcref`-qualified pointer types (`typedef int (*__funcref fnptr)(void);`)
  parse, but **every realistic use reproducibly crashes clang with an
  internal compiler error** (SIGSEGV in `Sema::DiagnoseAssignmentResult`/
  codegen) on this toolchain: converting an ordinary function designator to a
  `__funcref`-typed pointer, and even a bare `call`+`return` of an
  already-`__funcref`-typed value obtained from an extern import. This was
  reproduced multiple times with different syntax variants; none produced a
  usable object file.

The Node/browser hosts hit the identical wall for their own ABI-44
integration proof and solved it the same way: hand-written WAT, assembled
with `wat2wasm`, then run through the real `wasm-fork-instrument` tool — see
`host/test/fixtures/funcref-local-fork-fresh-worker.wat` and
`externref-local-fork-fresh-worker.wat`, and their drivers
`host/test/funcref-fork-module-worker.test.ts` /
`externref-fork-module-worker.test.ts`. `native_fork_refs.wat` is the
host-native analogue of both, combined into one program, reusing the exact
same `kernel`/`env` import surface (`kernel_fork`, `kernel_exit`,
`__channel_base`, a hand-rolled `wait4` over the syscall channel) those
fixtures use, because it is the same kernel ABI (ABI 44) on every host.

What it captures and how (full design + exit-code table is in the file's own
doc comment):

- **funcref**: a sentinel funcref loaded from a table via `table.get` (not a
  rematerializable `ref.func` constant, mirroring the Node fixture's own
  anti-fold discipline), held in a local live across `kernel_fork`, called
  via `call_indirect` in both the child and the (post-fork) parent.
- **externref**: obtained via native's REAL production `env.resolve_externref`
  import (not a test-only shim) for handle `7`, held in a local live across
  `kernel_fork`, checked via `env.native_test_externref_payload` (a
  native-only diagnostic — see `guest.rs::define_externref_payload_probe` —
  that unwraps the `u32` handle the externref was minted from, since a plain
  WASM fixture has no `ref.eq` to check identity directly).

Pipeline used (mirrors `native_fork.c`'s C→instrument pipeline exactly, with
`wat2wasm` standing in for the SDK's `clang`):

```sh
wat2wasm --enable-exceptions --enable-threads \
  native_fork_refs.wat -o native_fork_refs.wasm
scripts/run-wasm-fork-instrument.sh \
  native_fork_refs.wasm -o native_fork_refs.instrumented.wasm \
  --entry kernel.kernel_fork
```

Both steps succeed cleanly. The fixture assembles and instruments without
error; the resulting module's import list (dumped via a temporary diagnostic
test, removed before the final commit) is a completely normal ABI-44
fork-instrumented import surface.

## Host-side wiring completed (guest.rs)

The uncommitted WIP already in the worktree had defined
`define_resolve_externref` (parameterized over a shared `ExternrefRegistry`)
and `define_externref_payload_probe`, and passed an `Arc<Mutex<
ExternrefRegistry>>` into `instantiate_fork_module`, but never actually bound
either import for the GUEST's own module (only for the fork-module's
internal use during reconstruction). I completed that: in
`spawn_guest_thread`'s existing "N1-I5 Task 1" reference-import-flip block,
added two `guest_declares(...)`-gated calls so a fixture that directly
imports `env.resolve_externref` / `env.native_test_externref_payload` gets
them wired to the SAME shared registry the fork-module's own decode path
uses — this is what makes "the guest mints handle 7 before the fork" and
"the module reconstructs handle 7 after the fork" resolve to the identical
`Rooted<ExternRef>` (the identity discipline `docs/plans/
2026-09-05-n1-i5-references-grounding.md` §5 requires).

This is the only `guest.rs` change in this task; it is additive linker
wiring, not a change to the drive sequence, the fork-module, or fork-codec.

## The test: `smoke_fork_reconstructs_references` (`crates/host-native/src/lib.rs`)

Written to assert both halves of the acceptance bar: correctness
(`exit_code == 0`, both parent and child observe correct identity) and proof
of use (`ForkProofOfUse::references_reconstructed > 0` and
`externrefs_resolved > 0`, so a silent fallback that merely copied bytes
right cannot pass).

**RED, then documented BLOCKED, not GREEN.** Running it produces a hard
Wasmtime trap during the guest's own `kernel_fork()` call — before
`drive_reference_replay` or any `fm_*` module call ever runs:

```
guest entry failed: error while executing at wasm backtrace: ...
unknown import: `env::__wpk_fork_ref_vector_begin` has not been defined
```

I dumped the instrumented fixture's full import list (via a temporary
diagnostic test, since WABT's `wasm-objdump` errors out on this ABI's
GC/exnref types and cannot be trusted for this) and confirmed the missing
surface precisely:

- `__wpk_fork_ref_vector_begin` / `_append` / `_finish` — the CAPTURE-time
  reference-vector builder (used to serialize the list of live references at
  a frame into the KFMS arena). `crates/fork-module/src/lib.rs` exports
  `fm_ref_vector_get` (RESTORE) but no `begin`/`append`/`finish` (CAPTURE) —
  there is no module export to bind these to.
- `__wpk_fork_ref_encode_funcref` — the CAPTURE-time funcref encoder. Also no
  module export.
- On Node/browser these four are host JS functions
  (`host/src/fork-activation-registry.ts`'s `beginReferenceVector`/
  `appendReferenceVector`/`finishReferenceVector`/`encodeFuncref`, backed by
  `ForkActivationRegistry`'s capture-time bookkeeping). Native has no
  equivalent subsystem. `crates/fork-codec::ReferenceGraphBuilder` DOES
  already expose the right primitives (`begin_vector`/`append_vector`/
  `finish_vector`/`intern_funcref`/`intern_externref`), and
  `write_empty_module_state_arena` already shows the serialize-to-guest-memory
  pattern — so a future capture task has real, ready-to-use building blocks —
  but wiring them up requires: (a) a per-fork capture context created at
  `kernel_fork()` time (before any child exists), (b) resolving a captured
  `funcref` param back to a catalog ordinal, (c) writing the resulting KFMS
  arena to guest memory and threading its address into `drive_reference_
  replay` in place of the hardcoded `empty_module_state_root`, for BOTH the
  child's `fm_begin_child_replay`-seeded rewind and the resuming PARENT's
  `fm_begin_replay`-seeded rewind. That is a real, multi-part feature, not a
  "small guest.rs tweak," and the same prior task already declared it out of
  this task's scope in the `write_empty_module_state_arena` doc comment
  quoted above — so I did not build it. Per the assignment's own guidance
  ("do NOT modify the module/fork-codec... report BLOCKED with the failing
  stage"), I stopped here rather than expanding into a new capture subsystem.

The test is marked `#[ignore]` with a doc comment giving this exact root
cause, so a future capture-side task can un-ignore it with (expected) zero
changes to the fixture, imports, or assertions once the gap closes.

`fm_last_errno` is not available as a diagnostic for this failure: the trap
is a raw Wasmtime "unknown import" resolution failure, before any `fm_*`
module call (and therefore before any module-tracked errno) is ever reached.

## Externref identity: proven via the sanctioned fallback

Per the assignment's own guidance for externref ("if it's not reachable from
C, prove reconstruction via the resolve_externref idempotence path instead"),
and independent of the capture-side blocker above (this test needs no fork at
all): `crates/host-native/src/guest.rs`'s pre-existing
`fork_module_tests::resolve_externref_is_idempotent_per_handle` test —
already present in the uncommitted WIP, unmodified by me — asserts that
`env.resolve_externref(7)` returns the exact same externref object on repeat
asks, and a different object for a different handle. Verified passing
standalone:

```
test guest::fork_module_tests::resolve_externref_is_idempotent_per_handle ... ok
```

This is the accepted, current proof of externref identity for this task.
Combined with the (blocked) `native_fork_refs` fixture, the honest state is:
identity-preservation of the underlying primitive is proven; a genuine
cross-fork round trip of a live externref is fixture-ready but blocked on
capture.

## Funcref: no equivalent fallback exists (documented, not skipped)

Unlike externref, there is no unit-level fallback for funcref reconstruction
that avoids needing a real fork (the module's `fm_funcref_ordinal`/decode
path only makes sense against a real captured recipe graph). This is
documented as a gap in `native_fork_refs.wat`'s own doc comment and in the
`#[ignore]`d test; funcref reconstruction is unproven on native pending the
same capture-side work.

## Full-suite result

```
cargo test -p host-native --target aarch64-apple-darwin
test result: ok. 37 passed; 0 failed; 1 ignored; 0 measured; 0 filtered out
```

All 37 pre-existing tests remain green (unchanged). The one new test is
`#[ignore]`d with its blocker documented, not deleted and not faked to pass.

## RED/GREEN summary

- RED: `smoke_fork_reconstructs_references` traps on
  `env::__wpk_fork_ref_vector_begin` — confirmed, root-caused, and it is a
  genuine platform gap (native capture), not a fixture or wiring bug.
- GREEN: `resolve_externref_is_idempotent_per_handle` (externref identity,
  the sanctioned fallback), plus all 37 pre-existing tests unchanged.
- Not attempted: building the capture subsystem itself (out of this task's
  scope per the pre-existing `write_empty_module_state_arena` doc comment;
  a genuinely separate, larger feature).

## Honest gaps / concerns

1. **Native cannot reconstruct ANY real (non-canonical-empty) reference graph
   across a fork today.** This was true before this task and remains true
   after it; this task's contribution is a ready-to-use fixture + a precisely
   root-caused, documented blocker, not a fix for the underlying gap.
2. Funcref reconstruction is entirely unproven on native (no fallback exists
   for it, unlike externref).
3. The `#[ignore]`d test is real code, not a stub — it should be one of the
   first things re-run (removing `#[ignore]`) once a future task adds native
   reference capture, and per its own doc comment should need zero changes to
   pass at that point if the capture-side work is done correctly.
4. `crates/host-native/src/guest.rs` has one pre-existing compiler warning
   (`ExternrefRegistry` visibility narrower than `instantiate_fork_module`'s
   `pub(crate)`) inherited from the prior uncommitted WIP, not introduced or
   fixed by this task — left alone per the instruction to stay scoped.
5. `libc/musl` shows as a modified submodule in `git status` at the start and
   end of this session; untouched by this task.

## Files changed

- `crates/host-native/fixtures/native_fork_refs.wat` (new) — hand-written
  fixture source.
- `crates/host-native/fixtures/native_fork_refs.wasm` (new) — assembled,
  un-instrumented (force-added like every other `*.wasm` fixture here; `*.wasm`
  is repo-gitignored as a build artifact but these are checked-in test
  fixtures, matching `native_fork.wasm`'s existing precedent).
- `crates/host-native/fixtures/native_fork_refs.instrumented.wasm` (new) —
  the fork-instrumented artifact the test actually loads.
- `crates/host-native/fixtures/README.md` — documents the new fixture and its
  current blocked status.
- `crates/host-native/src/guest.rs` — completes the guest's own
  `env.resolve_externref` / `env.native_test_externref_payload` import wiring
  (additive linker binding only; no drive/module/fork-codec change).
- `crates/host-native/src/lib.rs` — adds `smoke_fork_reconstructs_references`
  (`#[ignore]`d, root cause documented in its doc comment).
