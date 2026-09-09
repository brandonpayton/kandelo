# Task: Guest-allocator continuation frames — PROBE VERDICT: BLOCKED-NEEDS-GUEST-ABI

Worktree: `/Users/brandon/kandelo-abi44-reconcile`
Branch: `brandonpayton/rust-first-abi44-reconcile`, HEAD includes `823c20086`.
No product code changed. Probe-only. Fix X remains in place as the fallback.

---

## VERDICT

**PROBE-BLOCKED — BLOCKED-NEEDS-GUEST-ABI.** The guest-allocator hypothesis is
blocked at Phase-1.1 (Reach) by a required guest-artifact-contract change, AND
its core mechanism premise is refuted independently. Do NOT proceed to Phase 2.
Keep the documented Fix X bounded arena.

Three independent, verified blockers — any one is a STOP:

### Blocker 1 (Reach → guest-ABI gate): guest programs export no allocator, and the module is instantiated before the guest

- The guest wasm exports NO `malloc` / `free` / `__mmap`. Verified on the built
  fixture `host/test/fixtures/fork-memory-clone.wasm`: `wasm-objdump -x` shows a
  53-entry Export section (`_start`, `__heap_base`, TLS globals,
  `__stack_pointer`, `__abi_version`, the full `wpk_fork_*`/`__wpk_fork_*`
  surface, catalogs) and ZERO allocator exports. `__mmap` exists as `func[97]`
  and sits in `__indirect_function_table` at `elem[104]`, but it is not exported
  and its table index is not a stable ABI slot.
- This is STRUCTURAL, not fixture-specific. The exported set is fixed by the SDK
  link flags (`sdk/src/lib/flags.ts:265+`, `sdk/kandelo/bin/wasm32posix-cc:370+`
  — `_start`, `__heap_base`, TLS, `__stack_pointer`, `__wasm_thread_init`,
  `__abi_version`) plus what `crates/fork-instrument/` adds (only the
  `wpk_fork_*` unwind/rewind/abort/state exports and the GC/exn codec stubs +
  catalogs). NOTHING in either path force-exports `malloc`/`free`/`__mmap`.
- The fork-module is a PIC side module. Its imports are host-supplied at
  instantiation (`host/src/fork-module-instance.ts:681` — `env.memory`,
  `__indirect_function_table`, the fork catalogs/drive/static-root tables, the
  `__memory_base`/`__table_base`/`__stack_pointer` globals, and
  `resolve_externref`). There is NO allocator import today, and the module's
  Rust (`crates/fork-module/src/lib.rs`) imports no guest `malloc`/`free`
  (its only guest coupling is `env.memory` + the wasm→wasm frame-flip imports).
- Ordering compounds it: the module is instantiated BEFORE the guest ("the
  module must precede the guest to supply the frame-flip imports",
  fork-module-instance.ts:310-324), so the guest's `malloc` export does not even
  exist when the module is instantiated. A late-bind through a table is
  mechanically possible (the code already does this for `functionCatalog` /
  `driveTable`), but it STILL requires the guest to export `malloc`/`free` (or
  publish them at a contracted table slot).

  => Reaching the guest allocator requires adding `-Wl,--export=malloc,--export=free`
  (or equivalent) to the SDK link flags, relinking every guest program, and
  re-instrumenting/rebuilding every fork-capable package. That changes the
  fork-capable-guest artifact contract (new required guest exports the host and
  module depend on). This is exactly the Phase-1.1 STOP gate the task defines
  ("NO guest-ABI change; a guest-export requirement must be surfaced").

### Blocker 2 (mechanism refuted): the guest allocator is NOT a second, coherent view of memory-0 — it bottoms out at the same kernel `SYS_MMAP` `find_gap` that already collides

The hypothesis assumes "guest malloc = one allocator = one coherent view of
memory-0, distinct from the kernel mmap the module's channel path uses." That is
false on this platform:

- musl here is `mallocng`. It sources ALL memory from anonymous
  `mmap(0, ...)` — `libc/musl/src/malloc/mallocng/malloc.c:249` and `:310`
  (`mmap(0, needed, PROT_READ|PROT_WRITE, MAP_PRIVATE|MAP_ANON, -1, 0)`), i.e.
  hint = 0 (kernel chooses placement). mallocng does not use `brk` for its
  groups.
- `mmap` -> `__mmap` (`libc/musl/src/mman/mmap.c`) -> `__syscall(SYS_mmap...)`
  -> `SYS_MMAP` (glue `libc/glue/syscall_glue.c:831`) -> `kernel_mmap` ->
  kernel `find_gap` (`crates/runtime-core/src/memory.rs`, cursor at
  `mmap_base.max(program_break)`, lowest-gap-first).
- That is the IDENTICAL allocator and placement the fork-module's channel path
  (`FrameArena::new_channel`, Option B) already uses, and that `task-fix-y-report.md`
  proved collides with the guest's `__builtin_wasm_memory_grow`-grown pages
  (kernel never learns of the raw grow -> `find_gap` places frames in the
  guest's grown-but-unwritten live pages -> clobber / +1 growth).

So routing fork frames through guest `malloc` would issue the same
`SYS_MMAP(hint=0)`, land at the same `find_gap` position, and reproduce the same
collision — it would NOT dissolve it, and would NOT deliver the promised
unbounded no-clobber growth. The background's "guest grows its heap via raw
memory.grow/sbrk bypassing the kernel" is true only for the FIXTURE's explicit
`__builtin_wasm_memory_grow`; musl `malloc` never uses that path — it uses
kernel-tracked `SYS_MMAP`. There is no distinct coherent "guest allocator" for
frame-sized linear-memory chunks; the guest malloc IS the kernel mmap allocator.

### Blocker 3 (reentrancy hazard): calling guest malloc mid-fork-capture-unwind is unsafe

The fork capture runs the guest's instrumented unwind with the guest frozen at
an arbitrary point. musl `malloc`/`free` take a global lock and mutate group
freelists; they are not reentrancy/async-safe. If the guest is paused inside
`malloc`/`free` (or holding its lock), a reentrant module->guest-malloc call can
deadlock or corrupt the heap. The probe could not establish item-2 safety
("confirm it is not forking from inside malloc / the allocator is in a
consistent state"); the guest offers no such guarantee at the fork point.

---

## Probe answers for the four gates

1. Reach: BLOCKED. Guest exports no allocator; module imports none and precedes
   the guest; exposing it requires a guest-export/relink = guest-artifact-contract
   change (STOP gate).
2. Reentrancy/state: NOT SAFE / not establishable — musl malloc is lock-holding
   and non-reentrant; guest may be paused inside it at the fork point.
3. Inheritance: N/A behind blockers 1-2, but note guest-malloc chunks WOULD live
   in memory 0 and inherit via COW (this property is not the problem).
4. Unbounded growth: NOT ACHIEVED — the guest allocator's frame-sized path is
   the same kernel `SYS_MMAP find_gap`, so it reproduces Fix Y's collision on the
   torture fixture rather than growing cleanly and unbounded.

## Wiring chosen

None. No code changed. Fix X (the bounded 2 MiB in-guest arena, commits
`b71a80fa0`/`36d69fb21`/`048376339`/`823c20086`) stays as the fallback.

## Guest-ABI / re-instrument impact

Proceeding WOULD require: SDK link-flag change (force-export `malloc`/`free`),
relink of every guest program, re-instrument + rebuild of every fork-capable
package, and a new fork-capable-guest export contract. Explicitly the change the
task says to surface, not assume acceptable.

## Fix X retired?

NO. Fix X's `ForkFixedFrameArena` and bounded-arena reservation are untouched
and remain the shipped mechanism.

## Before/after (P-10 / P-11 / real-fork tests)

Not run — probe stopped at the Phase-1 gate before any code change, so there is
no "after" to measure. Current state is unchanged from HEAD `823c20086`
(P-10 green, P-11 BLOCKED-DESIGN per `task-p10-p11-fix-report.md`).

## cargo / ABI

Not run — no code changed, so the fork-codec/host-native suites and the ABI
snapshot are unchanged by construction. (A future guest-allocator fix WOULD
require an ABI/guest-artifact bump — the guest-export contract change — which is
itself the STOP gate.)

## Browser

Not applicable (no change). No browser claim made.

## Evidence commands run

- `wasm-objdump -x host/test/fixtures/fork-memory-clone.wasm` -> Export[53], no
  malloc/free/__mmap; `__mmap`=func[97], elem[104], unexported.
- Read `libc/musl/src/malloc/mallocng/malloc.c` (mmap(0,...) at :249/:310),
  `libc/musl/src/mman/mmap.c` (`__mmap`->SYS_mmap), `libc/glue/syscall_glue.c`
  (SYS_MMAP=46->kernel_mmap; SYS_BRK=48->kernel_brk).
- Read `host/src/fork-module-instance.ts` (imports; module-precedes-guest),
  `crates/fork-module/src/lib.rs` (no guest-malloc import; Bump ALLOC; channel
  Option B), `sdk/src/lib/flags.ts` + `sdk/kandelo/bin/wasm32posix-cc`
  (fixed export set), `crates/fork-instrument/src/{lib,runtime,module_*_codec,
  static_reference_catalog}.rs` (adds only wpk_fork_* exports).
