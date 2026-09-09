# Phase 2: Opaque Self-Marshalled Syscall Transport — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Take the host out of the syscall data path — the guest glue
self-marshals its pointer arguments into a bounded, self-describing record in
the channel; the host transports that region blindly; the Rust kernel
(`runtime-core`) decodes and validates it. This deletes host-side per-syscall
ABI interpretation and forces ABI 44.

**Architecture:** Today `libc/glue/channel_syscall.c` writes the syscall number
and six i64 args into a per-thread SharedArrayBuffer channel; the host reads
`SYSCALL_ARG_DESCRIPTORS` (`crates/shared/src/host_abi.rs`) to copy pointer
bytes from guest memory into kernel scratch and normalizes the six words via
`channel_scalar`, then calls `kernel_handle_channel`. Phase 2 moves that
marshalling knowledge into the two components already ABI-locked together — the
guest glue and the kernel — and reduces the host to a byte transporter. A new
versioned wire record is authored by the guest and decoded by a single,
fuzzed, bounds-checked `runtime-core` decoder that reads the shared buffer
once, copies in, then validates the copy (TOCTOU-safe).

**Tech Stack:** Rust (`no_std` in `runtime-core`/`kernel`; `std` host-side for
tests), C (musl glue), TypeScript (host worker), `wasm32-unknown-unknown` with
`-Z build-std`, `cargo test --target <host>`, `cargo-fuzz`/`arbitrary` or an
in-tree property harness, Vitest (host), Playwright (browser parity),
`tests/libc` + `tests/posix` + `tests/sortix` conformance suites.

**Spec:** `docs/plans/2026-08-25-rust-first-runtime-design.md` (sub-boundary 1;
"Recommended end-state architecture" → data path; "Security analysis"; roadmap
row 2; completion criteria 1, 2, 7). The plan argues from that spec; executors
read both.

## Global Constraints

- **ABI epoch:** bump `ABI_VERSION` `43 → 44` in `crates/shared/src/lib.rs:114`
  and regenerate `abi/snapshot.json` in the SAME commit as the transport flip
  (per the ABI contract in `CLAUDE.md`). The flip is one atomic commit.
- **Stays byte-stable across the cutover:** the atomic handshake
  (`STATUS_OFFSET` u32 + `Atomics.wait32`/`memory.atomic.notify`), the syscall
  numbers, the imported `__channel_base` global, the `REQUEST_FLAGS` semantics
  (`crates/shared/src/lib.rs:1260-1280`), the signal-delivery tail
  (`SIG_BASE`…), and the `wpk_fork_*` / fork contract. Do not touch them.
- **Large transfers keep the existing capacity-bound kernel-scratch mechanism**
  (`kernel_scratch_wire` / the ABI-43 scratch path). The record references
  scratch for oversized payloads rather than inlining them into the 64 KiB
  data buffer (`DATA_SIZE = 65536`).
- **Decoder is the sole validator and load-bearing:** it MUST validate every
  offset/length/count against the bounded buffer, reject out-of-range and
  overlapping spans, cap counts (e.g. iovec), use checked arithmetic, and
  **read-once-then-validate** (copy the shared region in once; never re-read
  after validation). It MUST be fuzzed AND property-tested (completion
  criterion 7).
- **Parity every green commit:** Node and browser must stay at parity; no
  Node-only or browser-only landing (completion criterion 4). The native host
  does not exist yet (Phase 3), so parity here = Node + browser.
- **No syscall-hot-path regression:** synchronous leaves stay direct; do not
  introduce a queue round-trip. Benchmarks before/after on Node + browser gate
  any perf claim (completion criterion 6; performance contract).
- **musl rebuild:** any edit to `libc/glue/channel_syscall.c` or the overlay
  requires `scripts/build-musl.sh` before `build.sh`/Vitest/conformance are
  meaningful (`CLAUDE.md` build contract).
- Depends on Phase 1 (crate split, PR #1321). Branch Phase 2 off the Phase 1
  branch; rebase onto it as it merges.

---

## Task 0: Ground the plan against current code (no code change) — ✅ DONE

Grounding is complete: see `docs/superpowers/plans/phase2-grounding-notes.md`
for the confirmed file:line map (channel layout, `SyscallArgDesc` @
`host_abi.rs:77`, the 123-entry `SYSCALL_ARG_DESCRIPTORS`, `channel_scalar`, the
guest glue `__do_syscall_impl` @ `channel_syscall.c:756`, the decoder seam
`handle_owned_channel_allocation` @ `wasm_api.rs:3049`, the scratch token API,
the 9 ABI-regen files, and the test/fuzz homes). Two corrections it forced are
folded into Tasks 1 and 7 below. The remaining steps are retained only as the
record of what was captured.

- [ ] **Step 1: Read and record exact signatures/offsets.** Capture, with
  file:line:
  - `crates/shared/src/lib.rs`: the full channel-layout module (confirmed so
    far: `STATUS_OFFSET=0` u32; `SYSCALL_OFFSET` u32; `ARGS_OFFSET`, `ARGS_COUNT=6`,
    `ARG_SIZE=8`; `RETURN_OFFSET` i64; `ERRNO_OFFSET` u32; `REQUEST_FLAGS_OFFSET`
    u32; `HEADER_SIZE`; `DATA_OFFSET`; `DATA_SIZE=65536`; `SIG_BASE` tail) and
    `ABI_VERSION` (currently `43` at `:114`).
  - `crates/shared/src/host_abi.rs`: the `SYSCALL_ARG_DESCRIPTORS` table type,
    entry count (~123), and the descriptor struct (which arg slots are
    pointers, their length source, in/out direction).
  - `channel_scalar` (grep for the module; it may live in `crates/shared` or
    `crates/runtime-core` after the split): the per-slot normalization applied
    to the six i64 words.
  - `libc/glue/channel_syscall.c`: the syscall issue function(s) — how args are
    written, whether pointer args are passed raw (host copies) or copied by the
    guest, the atomic store/notify/wait handshake, and return/errno readback.
  - `crates/kernel/src/wasm_api.rs`: the `kernel_handle_channel` export and any
    per-syscall `kernel_*` exports the host calls; what it assumes the host
    already did (pointer copy into scratch).
  - `host/src/kernel-worker.ts`: `#handleSyscallInner` — how many syscall
    families branch, where it applies descriptors/`channel_scalar` and copies
    pointers.
- [ ] **Step 2: Write `docs/superpowers/plans/phase2-grounding-notes.md`** with
  those citations and a list of every syscall whose arguments include a pointer
  (from `SYSCALL_ARG_DESCRIPTORS`), grouped by marshalling shape (single
  in-buffer, single out-buffer, iovec array, path string, struct-by-pointer,
  scalar-only). These groups define the record's span kinds.
- [ ] **Step 3: Commit** the grounding note.

```bash
git add docs/superpowers/plans/phase2-grounding-notes.md
git commit -m "Docs: Phase 2 transport grounding notes"
```

---

## Task 1: Define the wire record format (additive, no behavior change)

**Files:**
- Create: `crates/shared/src/channel_record.rs` (new module; `pub mod
  channel_record;` in `crates/shared/src/lib.rs`).
- Test: unit tests in the same file (`#[cfg(test)]`).

**Interfaces:**
- Produces: `pub const RECORD_ABI: u16` (record-format version, starts at 1);
  `#[repr(C)] pub struct RecordHeader { magic: u32, record_abi: u16, syscall:
  u16, span_count: u16, flags: u16, scalar_args: [i64; 6] }`; `#[repr(C)] pub
  struct SpanDescriptor { kind: u8, arg_index: u8, _pad: u16, offset: u32, len:
  u32 }` where `offset` is relative to `DATA_OFFSET` (in-channel) or is a
  scratch handle when `kind == SPAN_KIND_SCRATCH`; `pub enum SpanKind { InPtr=1,
  OutPtr=2, InOutPtr=3, PathStr=4, IovecArray=5, MsgHdr=6 }` as `u8` consts
  (`IovecArray` and `MsgHdr` are nested; everything else is a flat byte span —
  see Step 0 for why the special families collapse to these);
  size/offset consts (`RECORD_HEADER_BYTES`, `SPAN_DESCRIPTOR_BYTES`,
  `MAX_SPANS`, `MAX_IOVEC`); `pub const RECORD_MAGIC: u32`.

Design rules encoded as consts and documented on the module:
- The record lives at `DATA_OFFSET`: `RecordHeader`, then `span_count`
  `SpanDescriptor`s, then the payload bytes each span points at. All offsets are
  relative to `DATA_OFFSET`; the tail must not overrun `SIG_BASE` (the signal
  area is reserved).
- Oversized payloads use `SpanKind::Scratch` (handle into the existing
  kernel-scratch mechanism), never inlined.
- `scalar_args` carries the six i64 words unchanged; span descriptors REPLACE
  the host's pointer-copy step only.

- [ ] **Step 0: SpanKind coverage — RESOLVED (design decision).**
  Key insight: self-marshalling moves per-syscall *semantic* knowledge to the
  guest, which already has it. The reason the HOST needed
  `validate_special_layout` (`channel_scratch.rs:576`) is that it had to infer
  buffer sizes/directions from command args it did not own. The guest owns the
  ioctl request, the semctl/shmctl/msgctl `cmd`, the fcntl lock `cmd`, the
  select `nfds`, and the epoll count — so it simply emits a generic
  `InPtr/OutPtr/InOutPtr` span of the exact length. The decoder then only
  bounds-checks; it never interprets semantics. So the "special families"
  collapse:
  - **ioctl / semctl / shmctl / msgctl / prctl / fcntl-lock / sigaction /
    termios / rlimit / stat / most struct-by-pointer** → `InPtr` / `OutPtr` /
    `InOutPtr` with guest-supplied `len` (fixed or computed guest-side).
  - **select / pselect6** fd_sets → `InOutPtr` (guest sizes from `nfds`);
    optional timeout/sigmask → `InPtr` or omitted span.
  - **epoll_ctl** (one event) → `InPtr`; **epoll_pwait** (event array + sigmask)
    → `OutPtr` (array) + optional `InPtr` (mask).
  - **PathStr** → NUL-terminated, `len ≤ PATH_MAX_BYTES` (4096).
  - **IovecArray** (writev/readv/preadv/pwritev) → ONE nested span: `offset`
    points at `{ u32 count(≤MAX_IOVEC=1024); count×(u32 buf_off,u32 buf_len);
    buffers }`; decoder parses + bounds-checks each sub-span (keeps `span_count`
    small).
  - **MsgHdr** (sendmsg/recvmsg) → ONE nested span: `{ name_off,name_len; an
    embedded iovec block (as above); control_off,control_len; flags }`.
  - **Large transfers** need NO `Scratch` kind: when the marshalled record
    exceeds the inline budget (65480 B), the guest allocates via
    `kernel_transfer_scratch_begin`, marshals the SAME record into that larger
    buffer, and calls `kernel_transfer_channel_execute` — span offsets are just
    larger `u32`s into the scratch-backed channel. The decoder is identical.

  **Final `SpanKind` set:** `InPtr=1, OutPtr=2, InOutPtr=3, PathStr=4,
  IovecArray=5, MsgHdr=6` (drop the earlier `Scratch/FdSet/EpollEvents/
  IpcControl`). Write this mapping table into the module doc comment as the
  record's completeness contract; every pointer-bearing syscall from the
  grounding note must map to exactly one of these six.
- [ ] **Step 1: Write failing tests** for layout invariants (paste real
  asserts): `RECORD_HEADER_BYTES == size_of::<RecordHeader>()`;
  `SPAN_DESCRIPTOR_BYTES == size_of::<SpanDescriptor>()`; header+`MAX_SPANS`
  descriptors fit below `DATA_SIZE - SIG_AREA_SIZE`; `RECORD_ABI == 1`.
- [ ] **Step 2: Run tests, verify they fail** (`cargo test -p wasm-posix-shared
  --target aarch64-apple-darwin channel_record`) — Expected: module not found.
- [ ] **Step 3: Implement** the structs/consts.
- [ ] **Step 4: Run tests, verify pass.**
- [ ] **Step 5: Confirm ABI snapshot picks up the new constants** — run
  `scripts/check-abi-version.sh`; the new module's consts are additive and
  should require regenerating `abi/snapshot.json` (no `ABI_VERSION` bump yet —
  the record is not on the live path). Regenerate and inspect the diff is
  additive-only.
- [ ] **Step 6: Commit** (`Shared: Define the opaque channel record format
  (record ABI v1)`).

---

## Task 2: Implement the record decoder in runtime-core (TDD)

**Files:**
- Create: `crates/runtime-core/src/channel_record_decode.rs` (`pub mod` in
  `crates/runtime-core/src/lib.rs`).
- Test: same file `#[cfg(test)]` + a property/fuzz harness (Task 3).

**Interfaces:**
- Consumes: `wasm_posix_shared::channel_record::{RecordHeader, SpanDescriptor,
  SpanKind, ...}`; the existing scratch API (from grounding notes).
- Produces: `pub struct DecodedSyscall<'a> { pub syscall: u16, pub scalars:
  [i64; 6], pub spans: Spans<'a> }`; `pub fn decode(channel_data: &[u8],
  data_capacity: usize) -> Result<DecodedSyscall<'_>, DecodeError>`; `pub enum
  DecodeError { BadMagic, UnsupportedRecordAbi, SpanCountOverflow, OffsetOob,
  LenOob, OverlappingSpans, CountCap, Arith }`. `decode` takes an already
  copied-in `&[u8]` (read-once happens at the call site, Task 4), so the decoder
  is a pure function over an owned/borrowed copy — never the live SAB.

- [ ] **Step 1: Write failing unit tests** (paste real asserts): a valid
  scalar-only record decodes to the six scalars, zero spans; a single `InPtr`
  span with `offset`+`len` inside the buffer yields the right byte slice; each
  `DecodeError` variant is produced by a crafted bad record — `offset+len >
  data_capacity` → `LenOob`; `span_count > MAX_SPANS` → `SpanCountOverflow`;
  two spans whose byte ranges overlap → `OverlappingSpans`; iovec count >
  `MAX_IOVEC` → `CountCap`; `offset` that overflows on `offset+len` →
  `Arith`; wrong magic → `BadMagic`.
- [ ] **Step 2: Run tests, verify they fail** (`cargo test -p runtime-core
  --target aarch64-apple-darwin channel_record_decode`).
- [ ] **Step 3: Implement `decode`** using only checked arithmetic
  (`checked_add`/`checked_mul`), validating every offset/len against
  `data_capacity`, rejecting overlaps, capping counts. No `unsafe`, no
  re-reading input after validation.
- [ ] **Step 4: Run tests, verify pass.**
- [ ] **Step 5: Commit** (`Runtime-core: Add the bounds-checked channel record
  decoder`).

---

## Task 3: Fuzz + property harness for the decoder (completion criterion 7)

**Files:**
- Create: `crates/runtime-core/fuzz/` (cargo-fuzz target
  `fuzz_targets/decode_record.rs`), modeled on the CONFIRMED in-tree template
  `crates/fork-instrument/fuzz/` (cargo-fuzz + libfuzzer-sys + `arbitrary`;
  `[package.metadata] cargo-fuzz = true`). Plus in-tree seeded property tests in
  `channel_record_decode.rs` `#[cfg(test)]` (no `Math.random`; seed as a const
  array) so the invariants run under normal `cargo test` too. (No proptest/
  quickcheck exists in-tree; do not add one.)
- Test: the harness itself is the deliverable.

**Interfaces:**
- Consumes: `runtime_core::channel_record_decode::decode`.

- [ ] **Step 1: Write the invariant properties** (paste real asserts):
  (a) `decode` never panics on ANY input byte slice of any length ≤
  `data_capacity`; (b) on `Ok`, every returned span slice lies fully within the
  input and no two returned span slices overlap; (c) round-trip — a record
  encoded by a reference encoder (Task 5's shared encoder, or a test-local
  encoder) decodes back to the same syscall/scalars/spans.
- [ ] **Step 2: Run harness, verify it exercises decode** (fuzz for a bounded
  iteration count in CI-friendly mode; property test runs N seeded cases).
- [ ] **Step 3: Fix any panic/overlap the harness finds; re-run to green.**
- [ ] **Step 4: Commit** (`Runtime-core: Fuzz and property-test the record
  decoder`).

---

## Task 4: Wire the decoder into `kernel_handle_channel` behind the record path (still additive)

**Files:**
- Modify: `crates/kernel/src/wasm_api.rs` — `handle_owned_channel_allocation`
  @ :3049 (the single funnel that both `kernel_handle_channel` @ :3193 and
  `kernel_transfer_channel_execute` @ :6879 call). The decoder plugs in HERE and
  must produce the same validated span evidence that
  `validate_channel_scratch_arguments` (`crates/runtime-core/src/channel_scratch.rs:693`)
  yields today, then feed the existing `dispatch_channel_syscall` @ :3392 /
  `dispatch_channel_wide_result` unchanged. Reuse `ChannelScratchRegion` /
  `checked_range` for the span→pointer bounds contract.
- Test: `host/test/` round-trip via `host/test/support/kernel-scratch-instance.ts`
  (Task 6) + runtime-core unit test.

**Interfaces:**
- Consumes: `decode`; the existing dispatch that today receives
  host-pre-copied scratch pointers.
- Produces: an internal `handle_channel_record(channel: &[u8]) -> ()` path that
  (1) copies the record region out of the channel ONCE, (2) `decode`s the copy,
  (3) resolves spans to slices/scratch, (4) calls the same per-syscall handlers
  the descriptor path calls today. Gated by a record-present marker so the old
  path still works until the flip.

- [ ] **Step 1: Write a failing runtime-core test** that feeds a hand-built
  record buffer through `handle_channel_record` and asserts the target syscall
  handler receives the decoded args (use an existing simple syscall, e.g.
  `getpid`/`write`-to-pipe, per grounding).
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement** the read-once copy + decode + span resolution +
  dispatch, reusing existing handlers. Do not delete the old path yet.
- [ ] **Step 4: Run, verify pass; run full `cargo test --workspace --exclude
  xtask --target <host>` (expect the Phase 1 baseline count, unchanged).**
- [ ] **Step 5: Commit** (`Kernel: Decode the opaque record in
  kernel_handle_channel (dual-path)`).

---

## Task 4b: Kernel dispatch of nested spans (iovec/msghdr) — REQUIRED before Task 6

Task 4 wired the flat span kinds into `prepare_channel_record`
(`crates/runtime-core/src/channel_scratch.rs`) but returns `EINVAL` for
`IovecArray`/`MsgHdr` (it deliberately did not reconstruct the host wire
structs `KernelIovecWire`/`KernelMsghdrWire`). Before the Task 6 flip — after
which the record path is the ONLY path — the kernel must dispatch these, or
writev/readv/preadv/pwritev/sendmsg/recvmsg break.

**Files:** `crates/runtime-core/src/channel_scratch.rs` (`prepare_channel_record`
nested arm) + the iovec/msghdr wire types it must produce (grounding: the
legacy validator built `KernelIovecWire`/`KernelMsghdrWire`).

- [ ] Reconstruct, from a decoded `IovecArray` span, the same iovec wire the
  existing `writev`/`readv` dispatch consumes (each sub-buffer laid into scratch,
  the iov array pointing at scratch addresses), and from a `MsgHdr` span the
  msghdr wire (name + iov block + control). Reuse `ChannelScratchRegion` bounds.
- [ ] TDD: a record with a 3-entry `IovecArray` drives `writev` to the same
  result as the legacy path; a `MsgHdr` record drives `sendmsg`. Assert the
  copy-back for readv/recvmsg out-buffers.
- [ ] Validate: `cargo test --workspace --exclude xtask`; kernel.wasm builds;
  ABI snapshot still unchanged (record path still dormant).
- [ ] Commit (`Kernel: Dispatch nested iovec/msghdr record spans`).

## Task 5: Guest self-marshalling in musl glue (additive; validated by round-trip)

**Files:**
- Modify: `libc/glue/channel_syscall.c` — add a record encoder that writes
  `RecordHeader` + span descriptors + payload at `DATA_OFFSET`, mirroring the
  `channel_record` layout.
- Create (optional): a shared encoder reference in `crates/shared` used by
  tests to check the C encoder byte-for-byte.
- Build: `scripts/build-musl.sh` after every edit.

**Interfaces:**
- Produces: the C-side record bytes the decoder in Task 2 consumes.

- [ ] **Step 1: Write a failing round-trip test** (host-side, Node/Vitest or a
  Rust integration test): a fixed syscall+args marshalled by the C encoder
  (compiled to wasm or reproduced by a byte-identical reference), fed to
  `decode`, yields the original args. Assert byte-identical header/span layout
  against `channel_record` consts.
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement the C encoder;** run `scripts/build-musl.sh`.
- [ ] **Step 4: Run, verify pass.**
- [ ] **Step 5: Commit** (`libc: Self-marshal syscall args into the opaque
  channel record`). (Still behind the marker — not yet the live path.)

### Task 5c note — semctl GETALL/SETALL sizing decision (interim)

The record format carries no kernel-computed span length, but the semctl
GETALL/SETALL buffer is `nsems * sizeof(unsigned short)`, where `nsems` is
kernel state absent from the syscall arguments. Three options were weighed:

- **(a)** the guest issues one preliminary `semctl(semid, 0, IPC_STAT, &buf)`
  to read `sem_nsems`, sizes the buffer, and marshals a plain `IN`/`OUT` span
  at the region base (which the kernel semctl dispatch already re-proves via
  `checked_channel_scratch_start_range`);
- **(b)** add a kernel-sized-span record kind the kernel fills in;
- **(c)** leave semctl GETALL/SETALL on the raw fallback path.

**Option (a) is chosen for now** (implemented in Task 5c): it keeps the record
format uniform at the cost of one extra `IPC_STAT` round-trip **on the
GETALL/SETALL path only**. This is deliberately left open to future
reinterpretation as (b) or (c). The decision is also documented at the semctl
marshal site in `libc/glue/channel_syscall.c`. `SETVAL`/`GETVAL` keep arg 3 as
a scalar (no span). This closes the last of the three Task 5b coverage gaps
(ioctl request-sizing, select/pselect6 timeout, semctl GETALL/SETALL); the
encoder remains dormant (not wired into `__do_syscall_impl`) until Task 6.

---

## Task 6: THE ATOMIC FLIP — record path live, host blind, ABI 44 (one commit)

**Files (all in one commit):**
- Modify: `libc/glue/channel_syscall.c` — issue via the record path
  unconditionally (drop the marker).
- Modify: `host/src/kernel-worker.ts` — `#handleSyscallInner` collapses to:
  read status, hand the opaque channel region to `kernel_handle_channel`, wait
  for completion, deliver signals. Delete per-syscall pointer-copy/descriptor
  application from the data path.
- Modify: `crates/kernel/src/wasm_api.rs` — `kernel_handle_channel` uses only
  the record path; remove the dual-path marker.
- Modify: `crates/shared/src/lib.rs:114` — `ABI_VERSION = 44`.
- Regenerate (all 9 `dump-abi` outputs, via `scripts/check-abi-version.sh
  update`): `abi/snapshot.json`, `libc/glue/abi_constants.h`,
  `libc/musl-overlay/include/bits/{kandelo_limits.h,kandelo_process_layouts.h,
  kandelo_channel_scalars.h,kandelo_thread_syscalls.h}`,
  `libc/musl-overlay/src/process/wasm32posix/spawn_contract.h`,
  `libc/musl-overlay/include/sys/soundcard.h`, `host/src/generated/abi.ts`.
- Build: `scripts/build-musl.sh`, then `build.sh`.

**Interfaces:**
- Consumes: Tasks 1–5.
- Produces: the ABI-44 transport. `host/src/generated/abi.ts` is no longer read
  for runtime dispatch (completion criterion 1).

- [ ] **Step 1:** Flip the C glue to the record path; `scripts/build-musl.sh`.
- [ ] **Step 2:** Collapse `#handleSyscallInner` to blind transport; delete
  descriptor application from the host data path (leave the tables for Task 7).
- [ ] **Step 3:** Remove the dual-path marker in `wasm_api.rs`.
- [ ] **Step 4:** Bump `ABI_VERSION` to 44; run `scripts/check-abi-version.sh`;
  regenerate `abi/snapshot.json`; commit the regenerated headers.
- [ ] **Step 5:** `build.sh`; then run the FULL gate (Task 8). Only commit when
  green.
- [ ] **Step 6: Commit** as one atomic commit (`Transport: Opaque
  self-marshalled syscall records; host out of the data path (ABI 44)`).

---

## Task 7: Delete host-side ABI interpretation from the data path

**Correction from grounding:** the ~200 per-syscall `kernel_*` handlers are
already INTERNAL (reached only via `dispatch_channel_syscall`), NOT host-called —
the host-called set is `HOST_ADAPTER_REQUIRED_KERNEL_EXPORTS` (`lib.rs:2971`).
So this task removes host-side TS marshalling + the descriptor tables/validators,
and does NOT touch any manifest export.

**Files:**
- Modify: `host/src/kernel-worker.ts` — delete the copy-in planning (:11983–12543),
  the `stage`/`finish` scratch copy closures (:5831–6037), and the `SYSCALL_ARGS`/
  `normalizeChannelScalarArguments` (:11352) use from the data path; `#handleSyscallInner`
  collapses to blind transport (Task 6 already did most; finish the deletions).
- Delete/prune: `crates/shared/src/host_abi.rs` `SYSCALL_ARG_DESCRIPTORS` and
  `crates/shared/src/channel_scalar.rs` host-facing normalization, plus the
  generated `SYSCALL_ARGS` / `CHANNEL_SCALAR_SLOT_CONTRACTS` in
  `host/src/generated/abi.ts` (keep only if the snapshot still needs the shape;
  confirm by compile + grep — they may remain as snapshot-documented ABI while
  leaving the runtime data path).
- Prune: `crates/runtime-core/src/channel_scratch.rs` `validate_descriptor_layout`
  (:246) and `validate_special_layout` (:576) — superseded by the record decoder;
  keep `ChannelScratchRegion`/`checked_range`.
- Do NOT touch `kernel_*` exports or the host-adapter manifest.

- [ ] **Step 1:** Remove the host TS marshalling + descriptor table + the
  superseded runtime-core validators; `cargo build` + `tsc`/lint to find dead
  references; fix.
- [ ] **Step 2:** Grep-verify completion criterion 1: `host_abi`/`channel_scalar`
  absent from the host data path; `host/src/generated/abi.ts` not imported by
  any runtime dispatch; `#handleSyscallInner` has no syscall-number switch.
- [ ] **Step 3:** Run the full gate (Task 8); commit (`Transport: Remove
  host-side per-syscall ABI marshalling`).

---

## Task 8: Full validation gate (run after Tasks 6 and 7)

- [ ] **Step 1: Build** — `scripts/build-musl.sh` then `bash build.sh` clean.
- [ ] **Step 2: ABI** — `scripts/check-abi-version.sh` EXIT 0; `ABI_VERSION==44`;
  snapshot consistent.
- [ ] **Step 3: Rust** — `cargo test --workspace --exclude xtask --target
  <host>` green; `cargo test -p xtask --target <host>` green.
- [ ] **Step 4: Conformance** — the runtime/kernel suites in `tests/libc`,
  `tests/posix`, `tests/sortix` per `docs/agent-guidance/validation.md` (this
  change touches syscall transport, so unit tests + Vitest are NOT sufficient).
- [ ] **Step 5: Host + parity** — `cd host && npx vitest run` green on Node;
  `./run.sh browser` + the Playwright parity suite for browser. No Node-only or
  browser-only pass.
- [ ] **Step 6: ABI-neutrality-of-marshalling test** (completion criterion 2):
  add/point to a test that reshapes one syscall's marshalling with NO new host
  capability and confirm zero edits under `host/src/` are required and
  conformance still passes.
- [ ] **Step 7: Benchmarks** (completion criterion 6) — `benchmarks/run.ts`
  before/after on Node AND browser; record the syscall-hot-path result. No
  "no regression" claim without this evidence.

---

## Self-review notes (gaps to close at execution)

- **Grounding dependency:** Tasks 1/4/5/7 cite functions (`kernel_handle_channel`,
  `#handleSyscallInner`, the scratch API, the `SYSCALL_ARG_DESCRIPTORS` struct)
  whose exact current signatures are captured in Task 0, not fabricated here —
  do Task 0 first.
- **Record format completeness:** the span kinds (`InPtr/OutPtr/InOutPtr/
  PathStr/IovecArray/Scratch`) must cover every pointer-bearing syscall grouped
  in Task 0 Step 2; if a syscall's shape doesn't fit, extend `SpanKind` before
  Task 6, not during the flip.
- **Out-params:** `OutPtr`/`InOutPtr` spans define where the kernel writes
  results back into the channel; confirm the guest reads them back post-syscall
  exactly as it reads `RETURN`/`ERRNO` today.
- **Scratch bridge:** Task 1's `SpanKind::Scratch` must map cleanly onto the
  existing capacity-bound scratch handles; verify the handle type in Task 0.
- **This is the one hard cutover** (roadmap row 2): Tasks 1–5 are additive and
  independently testable so the risk concentrates only in Task 6.
