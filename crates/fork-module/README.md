# fork-module — co-resident process-worker fork module

**Status: ADDITIVE. NOT wired into the live host/worker.** Nothing in this crate
touches `host/`, `crates/kernel/`, `crates/shared/`, `crates/runtime-core/`,
`crates/fork-codec/`, `abi/`, or `libc/`. It builds standalone
position-independent wasm side modules and is validated in isolation.

See `.superpowers/sdd/2026-09-01-phase6-fork-exec/D2-CORESIDENT-MODULE-DESIGN.md`
(design) and `.../D5-FIRST-SLICE-PLAN.md` (this gating slice) for the full
context.

## What it is

The `crates/fork-module` cdylib is the "live/stateful half" the D1
`crates/fork-codec` decoders deferred. In production it will be instantiated
once per process worker and provide the guest's `__wpk_fork_frame_*` /
`__wpk_fork_resume_peek` imports directly, as **wasm→wasm calls over the same
linear memory the guest uses**, eliminating the per-frame JS boundary the
TypeScript continuation controller has today.

It re-exports the guest-facing frame functions (signatures identical to
`WPK_FORK_REQUIRED_IMPORTS` in `host/src/generated/abi.ts`), backed by the
pure-logic `fork-codec` core:

| Guest import (this module's export) | Backed by |
|---|---|
| `__wpk_fork_frame_reserve(size) -> payload` | `LinkedFrameWriter::reserve_frame` |
| `__wpk_fork_frame_commit(payload)` | `LinkedFrameWriter::commit_frame` + `ReplayEventJournal::record_commit` |
| `__wpk_fork_frame_peek(size) -> payload` | `RewindDriver::drive_peek` |
| `__wpk_fork_frame_next(size) -> payload` | `RewindDriver::drive_next` |
| `__wpk_fork_resume_peek(diag) -> slot` | `RewindDriver::resume_peek` (`ResumeSlotTable`) |

Plus a coordinator surface (JS→wasm, once per phase, not hot):

- `fm_set_format(pointer_width, fixed_prefix_size)` — seed the linked-frame
  geometry ONCE (from the guest's `kandelo.wpk_fork.linked_frames` descriptor)
  before any fork. `pointer_width` is 4 (wasm32 guest) or 8 (wasm64 guest).
- `fm_begin_unwind(activation_id, arena_base, arena_len)` — begin a fork over a
  **host-allocated** frame arena (see "Arena", below).
- `fm_finish_unwind`, `fm_begin_replay`, `fm_finish_replay`, `fm_last_errno`.

## Memory topology — PIC side module (the D5 gating fix)

This is the sub-problem the earlier D2 scaffold did **not** solve. A plain wasm
cdylib emits its static data, its BSS heap, and its `--stack-first` shadow stack
at **fixed low linear-memory offsets**. Instantiated against the LIVE guest's
shared memory (which the module imports as its only memory), those low-offset
writes would **overwrite guest data**. The scaffold's harness only passed
because it ran against an EMPTY memory.

The fix: build this crate as a **position-independent (`--pie
--experimental-pic`) wasm side module**. It then imports three HOST-supplied
placement globals and relocates itself into a host-chosen region:

- `env.memory` — the guest's single shared linear memory (the frame data plane).
- `env.__memory_base` (immutable) — the host-chosen base for the module's own
  data + BSS heap. Data segments are **passive** and copied by the module's
  start function to `__memory_base + offset`; every static/BSS access is
  `__memory_base`-relative. `wasm-objdump` shows **no fixed low-offset active
  data segment** — the property that makes co-residency possible.
- `env.__stack_pointer` (mutable) — the host-chosen shadow-stack top; the stack
  grows down from here, in the host region.
- `env.__table_base` + `env.__indirect_function_table` — PIC table base + shared
  function table (no entries added in this slice; `dylink.0` table_size = 0).

The `dylink.0` section reports the module's `mem_size` (~4 MiB here, dominated by
the reset-per-fork bump heap) so the host knows how much of the `__memory_base`
region to reserve.

### Arena (Option A: the host owns it)

`fm_begin_unwind` takes an explicit `(arena_base, arena_len)`: the **host**
allocates the per-fork frame arena (production: a `continuationMmap` of the
shared memory) and passes it in. The module does **not** grow memory. `arena_base`
must be page-aligned and `arena_len` a non-zero page multiple.

### Why not the multi-memory fallback

Rust/LLVM lower every ordinary pointer dereference against memory index 0, so
the `fork-codec` `&mut [u8]` frame APIs cannot target a second imported memory
without hand-written multi-memory instructions. The PIC side module keeps memory
0 as the single shared guest memory AND relocates the module's own state off the
guest's low offsets — the only path that both works with Rust codegen and solves
the collision.

## Build

Use the crate's build script (it carries the PIC flags; a `RUSTFLAGS` env value
replaces the repo `.cargo/config.toml` target rustflags, so this crate gets its
own PIC flag set without editing the repo-wide, non-PIC kernel/guest config):

```
scripts/dev-shell.sh bash crates/fork-module/build-wasm.sh          # wasm32 (+wasm64 best-effort)
scripts/dev-shell.sh bash crates/fork-module/build-wasm.sh --run    # + co-residency harness
```

Artifacts:
- `target/wasm32-unknown-unknown/release/fork_module.wasm` (pointer_width 4)
- `target/wasm64-unknown-unknown/release/fork_module.wasm` (pointer_width 8;
  built with the nightly `simd_wasm64` feature for the wasm64 memory intrinsic)

Release is required (the whole-memory byte view is based at wasm address 0,
valid in wasm's flat memory but tripping the debug-only non-null slice
precondition).

`rustc` unconditionally appends `--export=__heap_base` for a wasm cdylib, but a
`--pie` side module has no static heap base, so `wasm-ld` doesn't define it and
the forced export would fail to link. The crate defines a trivial vestigial
`__heap_base` export purely to satisfy that; the host never consumes it.

## Validate (end-to-end + co-residency)

`tests/harness.mjs` is the key deliverable: a Node/V8 harness (V8 is the actual
production engine for the Node and browser process workers) that

1. seeds a 32 MiB **sentinel** over the whole LOW region `[0, 0x2000000)` —
   exactly where the old plain-cdylib scaffold's stack/data/BSS lived,
2. instantiates the module placed HIGH via host `__memory_base` /
   `__stack_pointer`, with a host-allocated frame arena,
3. drives the full multi-chunk reserve/commit → next/peek/resume loop and a
   >=5000-frame stress fork, then
4. **asserts the low sentinel is byte-for-byte intact** (co-residency) AND that
   the loop produced the correct frame order and resume slots.

```
scripts/dev-shell.sh bash -c "node crates/fork-module/tests/harness.mjs \
  target/wasm32-unknown-unknown/release/fork_module.wasm"
```

## Deliberately DEFERRED (awaits user review / later slices)

- **LIVE HOST WIRING** — flipping the guest's `env.__wpk_fork_frame_*` imports to
  this module's exports in `host/src/worker-main.ts`, and the host code that
  reserves the `__memory_base`/stack region and `continuationMmap` arena, is the
  risky live-integration step and is **left for user review**.
- **Reference / exception / GC engine-floor imports** (the irreducible JS floor)
  and the funcref/anyref engine tables — inert for a no-reference program.
- **wasm64 harness coverage** — the wasm64 artifact is structurally verified
  (`wasm-objdump`: i64 memory + PIC placement globals), but the harness exercises
  only the wasm32 artifact.
- **Per-worker instantiation plumbing** and the **ABI-44 snapshot record** for
  the shipped `fork_module{32,64}.wasm` artifacts.
