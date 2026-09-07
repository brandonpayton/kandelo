//! Co-resident process-worker fork module (Phase 6 D2 scaffold — ADDITIVE).
//!
//! This crate is the cdylib that will (eventually) be instantiated once in each
//! process worker to provide the guest's `__wpk_fork_frame_*` /
//! `__wpk_fork_resume_peek` imports directly, as wasm→wasm calls over the SAME
//! linear memory the guest uses — eliminating the per-frame JS boundary the
//! TypeScript continuation controller has today. See
//! `.superpowers/sdd/2026-09-01-phase6-fork-exec/D2-CORESIDENT-MODULE-DESIGN.md`.
//!
//! What this scaffold PROVES (see `tests/harness.mjs`): a second wasm module can
//! import the guest's linear `Memory` as `env.memory`, export the frozen
//! guest-facing frame functions, and drive the full reserve/commit → next/peek/
//! resume continuation loop against that shared memory, end to end in a real
//! engine, matching the pure-logic expectation the `fork-codec` unit tests pin
//! down. It is the live/stateful half the D1 `fork-codec` decoders deferred: the
//! `LinkedFrameWriter` (reserve/commit), the `RewindDriver` (next/peek), and the
//! `ReplayEventJournal` + `ResumeSlotTable` (the load-bearing journal coupling
//! the design requires to move into the module alongside the allocator).
//!
//! ## Multi-activation frames (Phase 6 D7a.2 — ADDITIVE)
//!
//! A `dlopen` fork has N ACTIVATIONS: activation 0 is the main module, 1..N are
//! the dlopen'd side modules, each with its OWN linked-frame writer, frame
//! arena, fixed runtime prefix, and rewind driver. The module keys those
//! per-activation writers/drivers in a `BTreeMap` (`ForkModule::activations`),
//! while the replay JOURNAL and RESUME-SLOT TABLE stay PROCESS-WIDE — the
//! journal already tags every event with its `activation_id`, so it records the
//! interleaved commit order across all activations and replays the global
//! reverse. `fm_begin_unwind` opens the first activation; `fm_add_activation_
//! unwind` adds the rest to the same fork (no reset). Each activation's guest
//! reaches its own frame state through the activation-parameterized shared
//! exports `fm_frame_{reserve,commit,peek,next}(act, ...)` / `fm_resume_peek(act)`
//! — the targets a per-activation wasm TRAMPOLINE calls with a constant
//! activation-id immediate (see `tests/fork-trampoline.mjs` /
//! `tests/harness-multi-activation.mjs`). The FROZEN guest-facing
//! `__wpk_fork_frame_*` exports remain the single-activation path (they route to
//! `PRIMARY_ACTIVATION`), so no guest re-instrumentation is required. The LIVE
//! host wiring of the trampolines, per-activation references, and the KFLA
//! archive is deferred to D7a.1.
//!
//! ## Memory topology chosen (and why) — PIC side module (D5 gating fix)
//!
//! SINGLE shared imported memory (the production "single-shared-memory" shape),
//! placed by the HOST via position-independent-code globals. This is the gating
//! sub-problem the D2 scaffold did NOT solve: a plain cdylib emits its static
//! data, BSS heap, and `--stack-first` shadow stack at FIXED LOW linear-memory
//! offsets, so instantiating it against the LIVE guest's shared memory would
//! overwrite guest data at those offsets. The scaffold's `tests/harness.mjs`
//! only passed because it ran against an EMPTY memory.
//!
//! The fix is to build this crate as a POSITION-INDEPENDENT (`--pie
//! --experimental-pic`) wasm SIDE MODULE. That makes the module import three
//! HOST-supplied placement globals and relocate itself into a host-chosen
//! region of the shared memory:
//!
//! * `env.memory` — the guest's ONLY memory (shared). All frame reads/writes
//!   happen here at absolute guest byte offsets, exactly as the D1 decoders
//!   assume.
//! * `env.__memory_base` (immutable global) — the host-chosen base for the
//!   module's own data + BSS. The module's data segments are PASSIVE and copied
//!   by the start function to `__memory_base + offset`; every static/BSS access
//!   is `__memory_base`-relative. The host points this into a region the guest
//!   is NOT using, so the module's `Vec`/`BTreeMap`/journal heap never collides
//!   with guest data.
//! * `env.__stack_pointer` (mutable global) — the host-chosen shadow-stack top.
//!   The stack grows DOWN from here, in the host region, not at the fixed low
//!   `--stack-first` offset a plain cdylib would use.
//! * `env.__table_base` + `env.__indirect_function_table` — the PIC ABI table
//!   base and shared function table (no entries added in this slice).
//!
//! With this placement the module's ONLY writes are (a) into its own
//! host-placed `__memory_base` region, (b) onto its own host-placed shadow
//! stack, and (c) into the per-fork FRAME CHUNKS the module maps itself.
//! Option B (minimize host surface): the MODULE owns its frame allocation,
//! issuing each chunk's `SYS_MMAP` through the guest syscall channel
//! (`fm_begin_unwind(activation_id, channel_base)`, in-realm
//! `memory_atomic_wait32`), growing memory ON DEMAND like the JS continuation
//! path — so there is no fixed host-reserved arena and no host arena-reservation
//! surface, and continuation depth is bounded only by available memory. The
//! chunks are released (`munmap`) on replay finish/abort. `tests/harness.mjs`
//! proves co-residency by seeding a sentinel over the whole low region and
//! asserting it is byte-for-byte intact after a full fork loop.
//!
//! Why NOT the D2 §1d multi-memory fallback (module's own default memory +
//! guest memory imported as a second memory): Rust/LLVM lower every ordinary
//! pointer dereference against memory index 0, so the `fork-codec` `&mut [u8]`
//! frame APIs cannot target a second imported memory without hand-written
//! multi-memory instructions. The PIC side module keeps memory 0 as the single
//! shared guest memory AND relocates the module's own state off the guest's low
//! offsets — the only path that both works with Rust codegen and solves the
//! collision.
//!
//! ## Deliberately DEFERRED (NOT done here; see README)
//!
//! * LIVE HOST WIRING: flipping the guest's `env.__wpk_fork_frame_*` imports to
//!   this module's exports in `host/src/worker-main.ts`, and the host code that
//!   reserves the `__memory_base`/stack region, is the risky live-integration
//!   step. Under Option B the host no longer reserves a frame arena — it passes
//!   the syscall channel base and the module maps its own chunks.
//! * The reference / exception / GC engine-floor imports (the JS floor) and the
//!   funcref/anyref engine tables — inert for a no-reference program.
//! * Per-worker instantiation plumbing and the ABI-44 snapshot record.

#![cfg_attr(any(target_arch = "wasm32", target_arch = "wasm64"), no_std)]
#![cfg_attr(any(target_arch = "wasm32", target_arch = "wasm64"), no_main)]
// The wasm64 memory intrinsics (`core::arch::wasm64::memory_size`) are still
// behind the `simd_wasm64` feature gate (rust-lang/rust#90599). Enable it only
// for the wasm64 build; the wasm32 and host builds are unaffected.
#![cfg_attr(target_arch = "wasm64", feature(simd_wasm64))]
// The in-realm channel handshake blocks on `memory_atomic_wait32` and wakes the
// kernel worker with `memory_atomic_notify` (Option B). Both intrinsics are
// still behind this feature gate (rust-lang/rust#77839); enable it for the wasm
// builds (the host build compiles this module out entirely).
#![cfg_attr(
    any(target_arch = "wasm32", target_arch = "wasm64"),
    feature(stdarch_wasm_atomic_wait)
)]

#[cfg(any(target_arch = "wasm32", target_arch = "wasm64"))]
extern crate alloc;

// H3 (host-surface minimization, 2026-09-06): the Wasm-import-backed
// `wpk_fork_host.*` engine-floor seam (Phase 6 D6, `mod host_capabilities`)
// was DELETED here. It declared 6 host imports
// (`host_mint_exception_tag`/`host_provide_unwind_transport_tag`/
// `host_recognize_unwind_transport`/`host_instantiate_child`/
// `host_spawn_thread`/`host_last_errno`) but was never wired to the guest on
// any host, and the completed F5/F6 reference-completeness work bypassed it
// entirely (exnref is handled by a guest-local export; typed-GC reuses the
// pre-existing JS drive-order). Deleting it removes those 6 imports from the
// compiled fork-module artifact on every host.

// On non-wasm targets this crate is intentionally empty: it is a wasm32 cdylib
// (the exports and linear-memory management are wasm-only). Keeping it empty on
// the host lets `cargo build/test --workspace` on a host target stay green while
// the real artifact is produced by `cargo build -p fork-module --target
// wasm32-unknown-unknown`.
#[cfg(any(target_arch = "wasm32", target_arch = "wasm64"))]
mod wasm {
    use core::alloc::{GlobalAlloc, Layout};
    use core::cell::UnsafeCell;
    use core::sync::atomic::{AtomicI32, AtomicU32, AtomicU64, AtomicUsize, Ordering};

    use alloc::collections::BTreeMap;
    use alloc::vec::Vec;

    use fork_codec::{
        decode_module_state, decode_replay_events_image, decode_segmented_reference_transaction,
        drive_plan, encode_replay_events, AggregateKind, ChunkAllocator, GcProvenance,
        LinkedFrameFormat, LinkedFrameWriter, ModuleStateFormat, ReconstructionState,
        ReferenceGraphBuilder, ReferenceRecipeNode, ReferenceReplayDriver, ReferenceReplayFeed,
        ReferenceSegmentsWriter, ReferenceTransactionRecord, ReplayEvent, ReplayEventJournal,
        ResumeSlotTable, RewindDriver, SegmentedReferenceTransaction,
    };
    use wasm_posix_shared::{abi, channel, mmap, ChannelStatus, Errno, Syscall};

    // The wasm memory/trap intrinsics live in an arch-specific module. Alias the
    // correct one so the same code builds for a wasm32 (`pointer_width = 4`) and
    // a wasm64 (`pointer_width = 8`) guest.
    #[cfg(target_arch = "wasm32")]
    use core::arch::wasm32 as wasm_intr;
    #[cfg(target_arch = "wasm64")]
    use core::arch::wasm64 as wasm_intr;

    const PAGE: u64 = 65_536;

    // -- Host-seeded linked-frame format ------------------------------------
    //
    // In production the host reads the guest module's
    // `kandelo.wpk_fork.linked_frames` descriptor (`readLinkedFrameFormat`) and
    // passes the pointer width and fixed-prefix size to the module ONCE via
    // `fm_set_format` before any fork. The chunk/node header sizes are derived
    // from the pointer width by the shared ABI helpers, so those two values are
    // the whole format. `0` means "not seeded yet" — `fm_begin_unwind` refuses
    // to run until the format is set (truthful `EINVAL`, never a guessed
    // geometry).
    static FMT_POINTER_WIDTH: AtomicU32 = AtomicU32::new(0);
    static FMT_FIXED_PREFIX: AtomicU32 = AtomicU32::new(0);

    // -- Host-seeded resume-slot catalog ------------------------------------
    //
    // Resume-slot PARITY (D5 §"Other couplings" 1): the guest imports the JS
    // `__wpk_fork_resume_table` (a `WebAssembly.Table` numbered from the FULL
    // resume catalog, slot 0 reserved, then slots 1..N by sorted function
    // ordinal). The module's `resume_peek` returns an index INTO that JS table,
    // so the module's `ResumeSlotTable` numbering MUST match the JS one exactly
    // or `call_indirect` targets the wrong thunk (silent corruption).
    //
    // The JS table registers the WHOLE catalog; the module, left to its own
    // devices, would number from the COMMITTED ordinals only, diverging whenever
    // committed != catalog. To make the numbering identical BY CONSTRUCTION, the
    // host seeds the same full catalog (the fork-instrumented function ordinals,
    // any order) into the module ONCE per worker via `fm_set_resume_catalog`,
    // and the module registers its resume table from that catalog instead of the
    // committed ordinals. Both sides then sort the identical ordinal set and
    // assign slots 1..N the same way. A committed frame's function always has a
    // resume thunk, so committed is always a subset of the catalog.
    //
    // A fixed BSS buffer holds the catalog so it survives the per-fork heap
    // reset (`fm_begin_unwind` clears the bump heap). A catalog larger than the
    // cap yields a truthful `E2BIG`; the host then declines the module path and
    // keeps the byte-identical JavaScript continuation for that program.
    const RESUME_CATALOG_CAP: usize = 16_384;

    #[repr(C, align(4))]
    struct CatalogCell(UnsafeCell<[u32; RESUME_CATALOG_CAP]>);
    // SAFETY: single-threaded per worker (see HeapCell).
    unsafe impl Sync for CatalogCell {}
    static RESUME_CATALOG: CatalogCell =
        CatalogCell(UnsafeCell::new([0u32; RESUME_CATALOG_CAP]));
    static RESUME_CATALOG_LEN: AtomicU32 = AtomicU32::new(0);

    fn set_resume_catalog_impl(ptr: u64, count: u64) -> Result<(), Errno> {
        let count = usize::try_from(count).map_err(|_| Errno::EINVAL)?;
        if count > RESUME_CATALOG_CAP {
            return Err(Errno::E2BIG);
        }
        let start = usize::try_from(ptr).map_err(|_| Errno::EINVAL)?;
        let byte_len = count.checked_mul(4).ok_or(Errno::EINVAL)?;
        let end = start.checked_add(byte_len).ok_or(Errno::EINVAL)?;
        if end > mem_len_bytes() {
            return Err(Errno::EINVAL); // catalog region past the end of guest memory
        }
        // Copy the little-endian u32 ordinals out of guest memory through raw
        // pointers (the same aliasing-safe idiom the journal image copy uses).
        // SAFETY: `[start, end)` is within guest linear memory (checked above);
        // the destination is the distinct static BSS catalog buffer.
        let dst = unsafe { &mut *RESUME_CATALOG.0.get() };
        let src = core::hint::black_box(start) as *const u8;
        for (index, slot) in dst.iter_mut().take(count).enumerate() {
            let mut bytes = [0u8; 4];
            unsafe {
                core::ptr::copy(src.add(index * 4), bytes.as_mut_ptr(), 4);
            }
            *slot = u32::from_le_bytes(bytes);
        }
        RESUME_CATALOG_LEN.store(count as u32, Ordering::Relaxed);
        Ok(())
    }

    /// The seeded resume catalog, or an empty slice if the host never seeded one
    /// (legacy harness path: fall back to committed-ordinal numbering).
    fn resume_catalog() -> &'static [u32] {
        let len = RESUME_CATALOG_LEN.load(Ordering::Relaxed) as usize;
        if len == 0 {
            return &[];
        }
        // SAFETY: single-threaded per worker; `len <= RESUME_CATALOG_CAP` by the
        // `set_resume_catalog_impl` bound. The buffer outlives every borrow.
        let all = unsafe { &*RESUME_CATALOG.0.get() };
        &all[..len]
    }

    // -- Per-activation resume catalogs (Phase 6 D7a.1a — ADDITIVE) ----------
    //
    // A `dlopen` multi-activation fork loads N modules, and EACH module ships
    // its OWN fork-instrumented function catalog (its own imported
    // `__wpk_fork_resume_table`). The single process-wide `RESUME_CATALOG` above
    // cannot number every activation's slots by construction: activation 0's
    // table and activation 1's table are distinct JS `WebAssembly.Table`s with
    // independent slot spaces. So the host seeds a SEPARATE resume catalog PER
    // ACTIVATION via `fm_set_activation_resume_catalog(act, ptr, count)`, and the
    // module registers each activation's `ResumeSlotTable` entry from ITS OWN
    // catalog (see `register_activation_slots`). The resume-slot PARITY contract
    // is unchanged (D5 §"Other couplings" 1): both the JS table and the module
    // sort the identical per-activation ordinal set and assign slots the same
    // way, so `call_indirect` never targets the wrong thunk.
    //
    // Like the global catalog, these live in a fixed BSS region so they survive
    // the per-fork bump-heap reset (`fm_begin_unwind` / `fm_begin_child_replay`
    // clear the heap). Storage is a single flat ordinal arena plus a small index
    // mapping each activation id to its `[offset, len)` slice. Both the ordinal
    // arena and the index are capped; overflow is a truthful `E2BIG` and the host
    // keeps the JavaScript continuation for that program.
    const ACTIVATION_CATALOG_ORD_CAP: usize = 16_384; // total ordinals, all activations
    const ACTIVATION_CATALOG_MAX_ACTS: usize = 64; // distinct activations

    #[repr(C, align(4))]
    struct ActivationCatalogOrds(UnsafeCell<[u32; ACTIVATION_CATALOG_ORD_CAP]>);
    // SAFETY: single-threaded per worker (see HeapCell).
    unsafe impl Sync for ActivationCatalogOrds {}
    static ACT_CATALOG_ORDS: ActivationCatalogOrds =
        ActivationCatalogOrds(UnsafeCell::new([0u32; ACTIVATION_CATALOG_ORD_CAP]));

    /// The index: each entry is `[activation_id, offset, len]` into the ordinal
    /// arena. Only the first `ACT_CATALOG_ACT_COUNT` entries are live.
    #[repr(C, align(4))]
    struct ActivationCatalogIndex(UnsafeCell<[[u32; 3]; ACTIVATION_CATALOG_MAX_ACTS]>);
    // SAFETY: single-threaded per worker (see HeapCell).
    unsafe impl Sync for ActivationCatalogIndex {}
    static ACT_CATALOG_INDEX: ActivationCatalogIndex =
        ActivationCatalogIndex(UnsafeCell::new([[0u32; 3]; ACTIVATION_CATALOG_MAX_ACTS]));

    static ACT_CATALOG_ACT_COUNT: AtomicU32 = AtomicU32::new(0);
    static ACT_CATALOG_ORD_USED: AtomicU32 = AtomicU32::new(0);

    fn set_activation_resume_catalog_impl(
        activation_id: u32,
        ptr: u64,
        count: u64,
    ) -> Result<(), Errno> {
        let count = usize::try_from(count).map_err(|_| Errno::EINVAL)?;
        let act_count = ACT_CATALOG_ACT_COUNT.load(Ordering::Relaxed) as usize;
        let ord_used = ACT_CATALOG_ORD_USED.load(Ordering::Relaxed) as usize;
        if act_count >= ACTIVATION_CATALOG_MAX_ACTS {
            return Err(Errno::E2BIG); // too many distinct activations
        }
        let ord_end = ord_used.checked_add(count).ok_or(Errno::EINVAL)?;
        if ord_end > ACTIVATION_CATALOG_ORD_CAP {
            return Err(Errno::E2BIG); // combined catalogs exceed the arena
        }
        // Reject a re-seeded activation (each is seeded once per worker), matching
        // the once-per-worker `fm_set_format` / `fm_set_resume_catalog` contract.
        // SAFETY: single-threaded; the index is a static buffer read here only.
        let index = unsafe { &*ACT_CATALOG_INDEX.0.get() };
        for entry in index.iter().take(act_count) {
            if entry[0] == activation_id {
                return Err(Errno::EINVAL);
            }
        }
        let start = usize::try_from(ptr).map_err(|_| Errno::EINVAL)?;
        let byte_len = count.checked_mul(4).ok_or(Errno::EINVAL)?;
        let end = start.checked_add(byte_len).ok_or(Errno::EINVAL)?;
        if end > mem_len_bytes() {
            return Err(Errno::EINVAL); // catalog region past the end of guest memory
        }
        // Copy the little-endian u32 ordinals out of guest memory through raw
        // pointers into the flat static arena (the same aliasing-safe idiom the
        // global catalog uses).
        // SAFETY: `[start, end)` is within guest linear memory (checked above);
        // the destination is the distinct static ordinal arena, at a slice
        // `[ord_used, ord_end)` bounded by the cap check above.
        let ords = unsafe { &mut *ACT_CATALOG_ORDS.0.get() };
        let src = core::hint::black_box(start) as *const u8;
        for (index, slot) in ords[ord_used..ord_end].iter_mut().enumerate() {
            let mut bytes = [0u8; 4];
            unsafe {
                core::ptr::copy(src.add(index * 4), bytes.as_mut_ptr(), 4);
            }
            *slot = u32::from_le_bytes(bytes);
        }
        // Publish the index entry, then bump the counters.
        // SAFETY: single-threaded; `act_count < MAX_ACTS` by the check above.
        let index = unsafe { &mut *ACT_CATALOG_INDEX.0.get() };
        index[act_count] = [activation_id, ord_used as u32, count as u32];
        ACT_CATALOG_ACT_COUNT.store((act_count + 1) as u32, Ordering::Relaxed);
        ACT_CATALOG_ORD_USED.store(ord_end as u32, Ordering::Relaxed);
        Ok(())
    }

    /// This activation's seeded resume catalog, or `None` if the host never
    /// seeded one for it (single-activation / legacy paths fall back to the
    /// global catalog then the committed ordinals — see
    /// `register_activation_slots`).
    fn activation_catalog(activation_id: u32) -> Option<&'static [u32]> {
        let act_count = ACT_CATALOG_ACT_COUNT.load(Ordering::Relaxed) as usize;
        // SAFETY: single-threaded per worker; the buffers outlive every borrow
        // and every live entry's `[offset, len)` was bounded on seed.
        let index = unsafe { &*ACT_CATALOG_INDEX.0.get() };
        let ords = unsafe { &*ACT_CATALOG_ORDS.0.get() };
        for entry in index.iter().take(act_count) {
            if entry[0] == activation_id {
                let offset = entry[1] as usize;
                let len = entry[2] as usize;
                return Some(&ords[offset..offset + len]);
            }
        }
        None
    }

    /// Register `activation_id`'s resume targets into `table`, choosing the
    /// ordinal source by the resume-slot parity contract, in precedence order:
    ///
    /// 1. the activation's OWN seeded catalog (`fm_set_activation_resume_catalog`)
    ///    — the multi-activation path, each dlopen module's own catalog;
    /// 2. else the process-wide global catalog (`fm_set_resume_catalog`) —
    ///    back-compat for a single-activation worker that seeded only the global;
    /// 3. else the activation's distinct committed ordinals, sorted — the legacy
    ///    harness path (no catalog seeded at all).
    ///
    /// The single-activation numbering is byte-identical to before this slice:
    /// with no per-activation catalog, precedence falls straight to (2)/(3),
    /// exactly the previous `begin_replay_impl` / `begin_child_replay_impl` logic.
    fn register_activation_slots(
        table: &mut ResumeSlotTable,
        activation_id: u32,
        global_catalog: &[u32],
        committed_ordinals: &[u32],
    ) -> Result<(), Errno> {
        if let Some(catalog) = activation_catalog(activation_id) {
            table.register_activation(activation_id, catalog)
        } else if !global_catalog.is_empty() {
            table.register_activation(activation_id, global_catalog)
        } else {
            let mut distinct: Vec<u32> = committed_ordinals.to_vec();
            distinct.sort_unstable();
            distinct.dedup();
            if distinct.is_empty() {
                Ok(())
            } else {
                table.register_activation(activation_id, &distinct)
            }
        }
    }

    // -- Per-activation function-catalog bases (Phase 6 D7a.1b — ADDITIVE) ---
    //
    // D6.1 imported ONE funcref catalog table and required every funcref to name
    // a single activation (`sole_funcref_activation`). D7a.1b lifts that: the host
    // lays every activation's function catalog into ONE merged imported table,
    // each activation at a distinct BASE, and seeds the module the
    // `activation_id -> base` map once per worker via
    // `fm_set_activation_catalog_base`. `funcref_ordinal_impl` then returns the
    // GLOBAL slot `base(module_activation) + function_ordinal`, so a funcref
    // minted in activation A but held by activation B's frame resolves against
    // A's catalog slice — the coordinate the RECIPE names, never the caller. A
    // dynamic wasm table cannot be selected per funcref, so the single merged
    // table with per-activation bases is the mechanism.
    //
    // Like the resume catalogs, the map lives in a fixed BSS region so it
    // survives the per-fork bump-heap reset. The map stays EMPTY for a
    // single-activation worker (the host seeds no base), and `funcref_ordinal_
    // impl` then defaults `base = 0` — byte-identical to the D6.1 raw-ordinal
    // mapping. Too many distinct activations is a truthful `E2BIG`; a re-seeded
    // activation is a truthful `EINVAL`.
    const FUNC_CATALOG_BASE_MAX_ACTS: usize = 64;

    #[repr(C, align(4))]
    struct ActFuncCatalogBase(UnsafeCell<[[u32; 2]; FUNC_CATALOG_BASE_MAX_ACTS]>);
    // SAFETY: single-threaded per worker (see HeapCell).
    unsafe impl Sync for ActFuncCatalogBase {}
    /// Each live entry is `[activation_id, base]`; only the first
    /// `ACT_FUNC_CATALOG_BASE_COUNT` entries are live.
    static ACT_FUNC_CATALOG_BASE: ActFuncCatalogBase =
        ActFuncCatalogBase(UnsafeCell::new([[0u32; 2]; FUNC_CATALOG_BASE_MAX_ACTS]));
    static ACT_FUNC_CATALOG_BASE_COUNT: AtomicU32 = AtomicU32::new(0);

    fn set_activation_catalog_base_impl(activation_id: u32, base: u32) -> Result<(), Errno> {
        let count = ACT_FUNC_CATALOG_BASE_COUNT.load(Ordering::Relaxed) as usize;
        if count >= FUNC_CATALOG_BASE_MAX_ACTS {
            return Err(Errno::E2BIG); // too many distinct activations
        }
        // Reject a re-seeded activation (each is seeded once per worker), matching
        // the once-per-worker `fm_set_activation_resume_catalog` contract.
        // SAFETY: single-threaded; the map is a static buffer read here only.
        let map = unsafe { &*ACT_FUNC_CATALOG_BASE.0.get() };
        for entry in map.iter().take(count) {
            if entry[0] == activation_id {
                return Err(Errno::EINVAL);
            }
        }
        // Publish the entry, then bump the count.
        // SAFETY: single-threaded; `count < MAX_ACTS` by the check above.
        let map = unsafe { &mut *ACT_FUNC_CATALOG_BASE.0.get() };
        map[count] = [activation_id, base];
        ACT_FUNC_CATALOG_BASE_COUNT.store((count + 1) as u32, Ordering::Relaxed);
        Ok(())
    }

    /// The seeded merged-catalog base for `activation_id`, or `None` if the host
    /// seeded no base for it.
    fn func_catalog_base(activation_id: u32) -> Option<u32> {
        let count = ACT_FUNC_CATALOG_BASE_COUNT.load(Ordering::Relaxed) as usize;
        // SAFETY: single-threaded per worker; the buffer outlives every borrow.
        let map = unsafe { &*ACT_FUNC_CATALOG_BASE.0.get() };
        for entry in map.iter().take(count) {
            if entry[0] == activation_id {
                return Some(entry[1]);
            }
        }
        None
    }

    /// True when the host seeded NO catalog base — the single-activation worker
    /// path, where `funcref_ordinal_impl` defaults `base = 0` (byte-identical to
    /// D6.1). Distinguishes that path from a corrupt multi-activation graph whose
    /// funcref names an un-seeded activation.
    fn func_catalog_base_map_empty() -> bool {
        ACT_FUNC_CATALOG_BASE_COUNT.load(Ordering::Relaxed) == 0
    }

    // -- Per-activation static-root catalog bases (the static-root binder) ------
    //
    // Exactly the funcref merged-catalog mechanism, for static roots. The host
    // lays every activation's instantiation-time static-root catalog into ONE
    // merged imported anyref table (`env.__wpk_fork_static_root_catalog`), each
    // activation at a distinct BASE, and seeds the `activation_id -> base` map
    // once per worker via `fm_set_activation_static_root_base`.
    // `static_root_slot_impl` then returns the GLOBAL catalog index
    // `base(module_activation) + static_root_ordinal`, so a static root minted in
    // activation A but held by activation B's frame resolves against A's catalog
    // slice — the coordinate the RECIPE names, never the caller. The map stays
    // EMPTY for a single-activation worker, and `static_root_slot_impl` then
    // defaults `base = 0` — byte-identical to the raw-ordinal mapping.
    const STATIC_ROOT_BASE_MAX_ACTS: usize = 64;

    #[repr(C, align(4))]
    struct ActStaticRootBase(UnsafeCell<[[u32; 2]; STATIC_ROOT_BASE_MAX_ACTS]>);
    // SAFETY: single-threaded per worker (see HeapCell).
    unsafe impl Sync for ActStaticRootBase {}
    /// Each live entry is `[activation_id, base]`; only the first
    /// `ACT_STATIC_ROOT_BASE_COUNT` entries are live.
    static ACT_STATIC_ROOT_BASE: ActStaticRootBase =
        ActStaticRootBase(UnsafeCell::new([[0u32; 2]; STATIC_ROOT_BASE_MAX_ACTS]));
    static ACT_STATIC_ROOT_BASE_COUNT: AtomicU32 = AtomicU32::new(0);

    fn set_activation_static_root_base_impl(activation_id: u32, base: u32) -> Result<(), Errno> {
        let count = ACT_STATIC_ROOT_BASE_COUNT.load(Ordering::Relaxed) as usize;
        if count >= STATIC_ROOT_BASE_MAX_ACTS {
            return Err(Errno::E2BIG); // too many distinct activations
        }
        // Reject a re-seeded activation (each is seeded once per worker).
        // SAFETY: single-threaded; the map is a static buffer read here only.
        let map = unsafe { &*ACT_STATIC_ROOT_BASE.0.get() };
        for entry in map.iter().take(count) {
            if entry[0] == activation_id {
                return Err(Errno::EINVAL);
            }
        }
        // Publish the entry, then bump the count.
        // SAFETY: single-threaded; `count < MAX_ACTS` by the check above.
        let map = unsafe { &mut *ACT_STATIC_ROOT_BASE.0.get() };
        map[count] = [activation_id, base];
        ACT_STATIC_ROOT_BASE_COUNT.store((count + 1) as u32, Ordering::Relaxed);
        Ok(())
    }

    /// The seeded merged-catalog base for `activation_id`, or `None` if the host
    /// seeded no static-root base for it.
    fn static_root_catalog_base(activation_id: u32) -> Option<u32> {
        let count = ACT_STATIC_ROOT_BASE_COUNT.load(Ordering::Relaxed) as usize;
        // SAFETY: single-threaded per worker; the buffer outlives every borrow.
        let map = unsafe { &*ACT_STATIC_ROOT_BASE.0.get() };
        for entry in map.iter().take(count) {
            if entry[0] == activation_id {
                return Some(entry[1]);
            }
        }
        None
    }

    /// True when the host seeded NO static-root base — the single-activation
    /// worker path, where `static_root_slot_impl` defaults `base = 0`.
    /// Distinguishes that path from a corrupt multi-activation graph whose static
    /// root names an un-seeded activation.
    fn static_root_catalog_base_map_empty() -> bool {
        ACT_STATIC_ROOT_BASE_COUNT.load(Ordering::Relaxed) == 0
    }

    // -- Per-activation GC codec catalogs (Phase 6 item 3c — real drive plan) --
    //
    // The REAL topological GC drive plan (`fm_build_gc_plan`) reproduces the JS
    // `materializeTypedGraph` order, which needs the per-activation GC-layout
    // facts the reference-recipe graph does not carry: which of a struct/array's
    // edges are constructor (allocation-time) dependencies, which layouts are
    // defaultable shells, and the i31 owner. Those live in each activation's
    // decoded `kandelo.wpk_fork.gc_codec` catalog. The host decodes the section
    // for admission already; it seeds the SAME raw section bytes into the module
    // ONCE per activation per worker via `fm_set_activation_gc_codec(act, ptr,
    // count)`, and `build_gc_plan_impl` decodes them into a `GcCodec` per
    // activation to build `fork_codec::GcCodecHints` (the faithful port of the JS
    // `gcAllocationDependencies` / owner derivation).
    //
    // Like the resume catalogs, storage is a fixed BSS byte arena plus a small
    // index (activation id -> `[offset, byte_len)`), so it survives the per-fork
    // bump-heap reset. Both are capped; overflow is a truthful `E2BIG` and the
    // host keeps the JS drive-order for that program. A re-seeded activation is a
    // truthful `EINVAL`.
    const ACT_GC_CODEC_BYTES_CAP: usize = 262_144; // total section bytes, all activations
    const ACT_GC_CODEC_MAX_ACTS: usize = 64; // distinct activations

    #[repr(C, align(8))]
    struct ActGcCodecBytes(UnsafeCell<[u8; ACT_GC_CODEC_BYTES_CAP]>);
    // SAFETY: single-threaded per worker (see HeapCell).
    unsafe impl Sync for ActGcCodecBytes {}
    static ACT_GC_CODEC_BYTES: ActGcCodecBytes =
        ActGcCodecBytes(UnsafeCell::new([0u8; ACT_GC_CODEC_BYTES_CAP]));

    /// Each live entry is `[activation_id, offset, byte_len]` into the byte arena.
    #[repr(C, align(4))]
    struct ActGcCodecIndex(UnsafeCell<[[u32; 3]; ACT_GC_CODEC_MAX_ACTS]>);
    // SAFETY: single-threaded per worker (see HeapCell).
    unsafe impl Sync for ActGcCodecIndex {}
    static ACT_GC_CODEC_INDEX: ActGcCodecIndex =
        ActGcCodecIndex(UnsafeCell::new([[0u32; 3]; ACT_GC_CODEC_MAX_ACTS]));

    static ACT_GC_CODEC_ACT_COUNT: AtomicU32 = AtomicU32::new(0);
    static ACT_GC_CODEC_BYTES_USED: AtomicU32 = AtomicU32::new(0);

    // The `hostExceptionOwner` the host computed (the smallest activation that
    // declared an exception descriptor), used to remap a host-exception exnref's
    // owner, exactly as the JS `directOwner`. `u32::MAX` means "no host-exception
    // owner" (the JS `null`); `build_gc_plan_impl` then leaves such an exnref
    // ownerless so `build_drive_plan` fails loudly. Seeded once per worker.
    static HOST_EXCEPTION_OWNER: AtomicU32 = AtomicU32::new(u32::MAX);

    fn set_activation_gc_codec_impl(activation_id: u32, ptr: u64, byte_len: u64) -> Result<(), Errno> {
        let byte_len = usize::try_from(byte_len).map_err(|_| Errno::EINVAL)?;
        let act_count = ACT_GC_CODEC_ACT_COUNT.load(Ordering::Relaxed) as usize;
        let used = ACT_GC_CODEC_BYTES_USED.load(Ordering::Relaxed) as usize;
        if act_count >= ACT_GC_CODEC_MAX_ACTS {
            return Err(Errno::E2BIG); // too many distinct activations
        }
        let end_used = used.checked_add(byte_len).ok_or(Errno::EINVAL)?;
        if end_used > ACT_GC_CODEC_BYTES_CAP {
            return Err(Errno::E2BIG); // combined catalogs exceed the arena
        }
        // Reject a re-seeded activation (each is seeded once per worker).
        // SAFETY: single-threaded; the index is a static buffer read here only.
        let index = unsafe { &*ACT_GC_CODEC_INDEX.0.get() };
        for entry in index.iter().take(act_count) {
            if entry[0] == activation_id {
                return Err(Errno::EINVAL);
            }
        }
        let start = usize::try_from(ptr).map_err(|_| Errno::EINVAL)?;
        let end = start.checked_add(byte_len).ok_or(Errno::EINVAL)?;
        if end > mem_len_bytes() {
            return Err(Errno::EINVAL); // section region past the end of guest memory
        }
        // Copy the raw section bytes out of guest memory into the flat static arena
        // (the same aliasing-safe idiom the resume catalog uses).
        // SAFETY: `[start, end)` is within guest linear memory (checked above); the
        // destination is the distinct static byte arena slice `[used, end_used)`.
        let bytes = unsafe { &mut *ACT_GC_CODEC_BYTES.0.get() };
        let src = core::hint::black_box(start) as *const u8;
        unsafe {
            core::ptr::copy(src, bytes.as_mut_ptr().add(used), byte_len);
        }
        // Publish the index entry, then bump the counters.
        // SAFETY: single-threaded; `act_count < MAX_ACTS` by the check above.
        let index = unsafe { &mut *ACT_GC_CODEC_INDEX.0.get() };
        index[act_count] = [activation_id, used as u32, byte_len as u32];
        ACT_GC_CODEC_ACT_COUNT.store((act_count + 1) as u32, Ordering::Relaxed);
        ACT_GC_CODEC_BYTES_USED.store(end_used as u32, Ordering::Relaxed);
        Ok(())
    }

    /// Decode every seeded activation's GC codec catalog into a `GcCodec`, keyed by
    /// activation id — the per-activation catalog map `GcCodecHints` consumes. A
    /// section that fails to decode is a truthful `EINVAL` (the host would have
    /// declined admission; a corrupt seed must not silently build a wrong plan).
    fn decoded_gc_codecs() -> Result<BTreeMap<u32, fork_codec::GcCodec>, Errno> {
        let act_count = ACT_GC_CODEC_ACT_COUNT.load(Ordering::Relaxed) as usize;
        // SAFETY: single-threaded per worker; the buffers outlive every borrow and
        // every live entry's `[offset, byte_len)` was bounded on seed.
        let index = unsafe { &*ACT_GC_CODEC_INDEX.0.get() };
        let bytes = unsafe { &*ACT_GC_CODEC_BYTES.0.get() };
        let mut map = BTreeMap::new();
        for entry in index.iter().take(act_count) {
            let offset = entry[1] as usize;
            let len = entry[2] as usize;
            let slice = bytes.get(offset..offset + len).ok_or(Errno::EINVAL)?;
            map.insert(entry[0], fork_codec::decode_gc_codec(slice)?);
        }
        Ok(map)
    }

    fn host_exception_owner() -> Option<u32> {
        match HOST_EXCEPTION_OWNER.load(Ordering::Relaxed) {
            u32::MAX => None,
            owner => Some(owner),
        }
    }

    /// Build the REAL topological GC drive plan for the current fork's reference
    /// graph (Phase 6 item 3c) and serialize it into the module-owned scratch
    /// buffer, returning its guest address for `fm_drive_execute`.
    ///
    /// Reproduces the JS `materializeTypedGraph` drive-order via
    /// `fork_codec::build_drive_plan` over the resident driver's decoded reference
    /// graph, with `GcCodecHints` supplying the per-recipe GC-layout facts from the
    /// seeded per-activation catalogs. Requires `fm_begin_reference_replay` to have
    /// seeded the driver. Since M2 the externref-transit rooting for reachable
    /// leaves is a `DRIVE_OP_EXTERNREF_TRANSIT` step THIS function's
    /// `build_drive_plan` call emits (Phase 0, before any allocate/fill) — not
    /// something `drive_reconstruction` does at seed time; `drive_reconstruction`
    /// is now a host-free bookkeeping pass (see its doc).
    ///
    /// The post-allocate integrity guard the injected `fm_drive_execute` shim runs
    /// after each ALLOC step reads STORE #2 — the guest's shared Wasm-GC transit
    /// table (`__wpk_fork_ref_gc_transit`) at slot `recipe + 1` — which the guest's
    /// `_gc_allocate` publishes into. That is a pure wasm `table.get` + `ref.is_null`
    /// in the shim (Rust holds no `anyref`), so this planner opens no host
    /// generation for it and stores no R1 state.
    /// Build the topological reconstruction steps (Phase 0/0b/3/4/5) for the
    /// resident reference graph. Shared by `build_gc_plan_impl` and the child-
    /// install `attach_from_arena_impl` (which appends the restore/finish steps).
    fn build_reconstruction_steps() -> Result<Vec<drive_plan::DriveStep>, Errno> {
        let driver = reference_state().as_ref().ok_or(Errno::EINVAL)?;
        let nodes = &driver.transaction().nodes;

        let gc_codecs = decoded_gc_codecs()?;
        let hints = fork_codec::GcCodecHints::new(nodes, &gc_codecs, host_exception_owner())?;
        drive_plan::build_drive_plan(nodes, &hints)
    }

    /// Serialize `steps` into the module-owned scratch buffer, root the bytes in
    /// the `DRIVE_PLAN` cell, publish the count via `GC_PLAN_COUNT`, and return the
    /// plan's guest address for `fm_drive_execute`. Shared by every plan producer
    /// (only one plan is live at a time).
    fn serialize_and_store_plan(steps: &[drive_plan::DriveStep]) -> Result<usize, Errno> {
        let mut buf = Vec::new();
        buf.resize(drive_plan::DRIVE_STEP_SIZE * steps.len(), 0u8);
        drive_plan::serialize_plan(steps, &mut buf)?;
        let ptr = buf.as_ptr() as usize;
        GC_PLAN_COUNT.store(steps.len() as u32, Ordering::Relaxed);
        // SAFETY: single-threaded per worker; root the backing bytes so the returned
        // pointer stays valid for the shim's reads (shares the DRIVE_PLAN cell with
        // the trivial-plan path — only one plan is live at a time).
        unsafe {
            *DRIVE_PLAN.0.get() = Some(buf);
        }
        Ok(ptr)
    }

    fn build_gc_plan_impl(_pid: u32) -> Result<usize, Errno> {
        let steps = build_reconstruction_steps()?;
        serialize_and_store_plan(&steps)
    }

    // The step count of the plan `fm_build_gc_plan` last serialized (the `count`
    // argument for `fm_drive_execute`).
    static GC_PLAN_COUNT: AtomicU32 = AtomicU32::new(0);

    // Monotonic count of DRIVE STEPS this module has executed since worker start
    // (Phase 6 item 3c — the production typed-GC drive flip). The injected
    // `fm_drive_execute` shim calls `fm_drive_bump` once per plan step it drives
    // (each `call_indirect` into the guest's `_gc_allocate`/`_gc_fill`/
    // `_exception_materialize`), so a nonzero value is positive proof the MODULE
    // drove the typed allocate/fill/exn topological order — distinct from
    // `GC_NODES_RECONSTRUCTED`, which `fm_begin_reference_replay` bumps merely by
    // ADMITTING a typed-GC graph (the item 3a data feed). A flag-on fork that fell
    // back to the JS `materializeAllTyped` drive-order leaves this at zero. Never
    // resets.
    static DRIVE_STEPS_EXECUTED: AtomicU64 = AtomicU64::new(0);

    // Monotonic count of frames the module has committed since worker start.
    // Proof-of-use for the host: after a flag-on fork drives the continuation
    // through this module, the counter has advanced past its pre-fork value. A
    // silent fallback to the JavaScript path leaves it unchanged.
    static FRAMES_COMMITTED: AtomicU64 = AtomicU64::new(0);

    // Monotonic count of frames the module has REPLAYED (consuming rewind
    // advances via `__wpk_fork_frame_next`) since worker start. The replay-side
    // proof-of-use mirror of `FRAMES_COMMITTED`: a replay-only forked CHILD
    // never commits a frame (`FRAMES_COMMITTED` stays 0 there), so the frame
    // count alone cannot prove the child drove its rewind through this module.
    // A fork-from-thread child (Phase 6 D7b) carries no references either, so
    // `REFERENCES_RECONSTRUCTED` also stays 0. This counter advances once per
    // consumed frame on any worker that rewinds through the module (parent
    // replay AND child replay), so the child worker can positively prove module
    // use; a silent JS fallback leaves it unchanged. Never resets.
    static FRAMES_REPLAYED: AtomicU64 = AtomicU64::new(0);

    // -- Reference reconstruction (Phase 6 D6.1 — funcref + null) -----------
    //
    // The decoded funcref/null reference graph for the current fork, seeded once
    // by `fm_begin_reference_replay` from the KFMS module-state arena and
    // consulted by `fm_funcref_ordinal` (the helper the injected
    // `__wpk_fork_ref_decode_funcref` shim calls) during the guest's rewind.
    // Held in its own static so it is independent of the frame `ForkModule`
    // lifecycle: the guest interleaves reference decode with frame next/peek.
    struct ReferenceStateCell(UnsafeCell<Option<ReferenceReplayDriver>>);
    // SAFETY: single-threaded per worker (see HeapCell).
    unsafe impl Sync for ReferenceStateCell {}
    static REFERENCE_STATE: ReferenceStateCell = ReferenceStateCell(UnsafeCell::new(None));

    #[allow(clippy::mut_from_ref)]
    fn reference_state() -> &'static mut Option<ReferenceReplayDriver> {
        // SAFETY: single-threaded per worker; only one guest drives the imports.
        unsafe { &mut *REFERENCE_STATE.0.get() }
    }

    // Monotonic count of references the module has reconstructed (funcref or
    // null) since worker start. Proof-of-use mirror of `FRAMES_COMMITTED`: after
    // a flag-on funcref fork drives reconstruction through the module this has
    // advanced; a silent JS fallback leaves it unchanged. Never resets.
    static REFERENCES_RECONSTRUCTED: AtomicU64 = AtomicU64::new(0);

    // Monotonic count of externrefs this fork's graph reconstructs since worker
    // start (Phase 6 D6.2, host seam retired M2). Proof-of-use mirror of
    // `REFERENCES_RECONSTRUCTED` for the externref path: `fm_begin_reference_
    // replay` bumps this by `drive_reconstruction`'s graph-derived externref-node
    // count — the GRAPH'S expectation of how many externrefs get resolved, not a
    // live host round trip (since M2 no Rust `wpk_fork_host` seam performs that
    // resolve/publish; it is injected wasm). Since the 2026-09-05 substrate fix,
    // EVERY `Externref` recipe — directly held (frame-vector-only) and
    // GC/exnref-reachable alike — is resolved+published by a
    // `DRIVE_OP_EXTERNREF_TRANSIT` step through `fm_externref_handle`; there is
    // no separate lazy per-value decode import in the built architecture. A
    // silent JS fallback (the module was never asked to drive the reference
    // reconstruction) leaves this unchanged. Never resets.
    static EXTERNREFS_RESOLVED: AtomicU64 = AtomicU64::new(0);

    // Monotonic count of exnref nodes the module has admitted and driven through
    // reference reconstruction since worker start (Phase 6 D6.3a). Proof-of-use
    // mirror of `EXTERNREFS_RESOLVED` for the exnref path: `fm_begin_reference_
    // replay` bumps this by the admitted graph's exnref-node count. The DRIVE
    // itself leaves the Exnref arm inert — the guest export
    // `__wpk_fork_exception_materialize` mints/throws its own module-local tag —
    // so this count (not the externref `reconstructed` count) is what proves the
    // module, not a silent JS fallback, handled an exnref-bearing graph. Its
    // reachable externref payloads are rooted by the same PHASE B transit path.
    // Never resets.
    static EXNREFS_RECONSTRUCTED: AtomicU64 = AtomicU64::new(0);

    // Monotonic count of typed-GC nodes (struct + array + i31) the module has
    // admitted and driven since worker start (Phase 6 D6.4a). Proof-of-use mirror
    // of `EXNREFS_RECONSTRUCTED` for the typed-GC path: `fm_begin_reference_replay`
    // bumps this by the admitted graph's GC-node count. The DRIVE itself leaves the
    // Struct/Array/I31 arms inert — the module precedes the guest, so the guest
    // export drives the GC allocate/fill under the JS order, and i31 is a scalar
    // leaf — so this count (not the externref `reconstructed` count) is what proves
    // the module, not a silent JS fallback, admitted a typed-GC graph. Any
    // struct/array-reachable externref leaves are rooted by the same PHASE B
    // transit path. Never resets.
    static GC_NODES_RECONSTRUCTED: AtomicU64 = AtomicU64::new(0);

    // Monotonic count of static roots the static-root binder has resolved for
    // publish since worker start. Proof-of-use for the static-root DRIVE step: the
    // injected `fm_drive_execute` shim calls `fm_static_root_slot` once per
    // DRIVE_OP_STATIC_ROOT step to get the merged-catalog index it `table.get`s and
    // publishes into the anyref transit, and that helper bumps this. A nonzero
    // value after a flag-on static-root fork proves the module — not a silent JS
    // `publishTransit` fallback — republished the immutable roots. Never resets.
    static STATIC_ROOTS_PUBLISHED: AtomicU64 = AtomicU64::new(0);

    // The bookkeeping result of the last `fm_begin_reference_replay` drive for
    // this fork. Since M2 `ReconstructionState` carries NO host identities and NO
    // host generation (that seam retired — see its doc): it is just the
    // graph-derived externref count already folded into `EXTERNREFS_RESOLVED`.
    // Held alongside `REFERENCE_STATE`, independent of the frame `ForkModule`
    // lifecycle, as a diagnostic anchor for the last drive.
    struct ReconstructionStateCell(UnsafeCell<Option<ReconstructionState>>);
    // SAFETY: single-threaded per worker (see HeapCell).
    unsafe impl Sync for ReconstructionStateCell {}
    static RECONSTRUCTION_STATE: ReconstructionStateCell =
        ReconstructionStateCell(UnsafeCell::new(None));

    #[allow(clippy::mut_from_ref)]
    fn reconstruction_state() -> &'static mut Option<ReconstructionState> {
        // SAFETY: single-threaded per worker; only one guest drives the imports.
        unsafe { &mut *RECONSTRUCTION_STATE.0.get() }
    }

    // -- Reference RESTORE data-feed (Phase 6 item 3a — minimize host surface)
    //
    // The mutable per-fork REPLAY state the seven `fm_ref_*` data-feed exports
    // accumulate on top of the immutable decoded transaction (the growing
    // reference-vector overlay + its intern index + the GC-vector ordinal cache
    // + the exnref cache-index map). Seeded by `fm_begin_reference_replay`
    // alongside the driver and consulted by the guest's typed-GC/exnref codec
    // through the flipped `__wpk_fork_ref_{gc,exn,vector}_*` imports during the
    // JS drive-order's `_gc_allocate`/`_gc_fill` walk. Held in its OWN static so
    // it is independent of the immutable `REFERENCE_STATE` driver: the driver's
    // transaction is READ-ONLY here and the feed's mutation is confined to this
    // cell, so the module->guest->module reentrancy (the still-JS drive calls the
    // guest `_gc_allocate`, which calls back into these module exports) is
    // borrow-safe — each export borrows this cell fresh, does its synchronous
    // work, and returns before the guest can re-enter.
    struct ReferenceFeedCell(UnsafeCell<Option<ReferenceReplayFeed>>);
    // SAFETY: single-threaded per worker (see HeapCell).
    unsafe impl Sync for ReferenceFeedCell {}
    static REFERENCE_FEED: ReferenceFeedCell = ReferenceFeedCell(UnsafeCell::new(None));

    #[allow(clippy::mut_from_ref)]
    fn reference_feed() -> &'static mut Option<ReferenceReplayFeed> {
        // SAFETY: single-threaded per worker; only one guest drives the imports.
        unsafe { &mut *REFERENCE_FEED.0.get() }
    }

    // Monotonic count of RESTORE data-feed reads the module has served since
    // worker start (Phase 6 item 3a). Proof-of-use: after a flag-on GC/exnref
    // fork drives its typed-graph reconstruction, the guest codec reads the graph
    // through the module's `fm_ref_*` feed exports and this advances; a silent JS
    // fallback (the imports stayed on the JS reference provider) leaves it
    // unchanged. Bumped by every route/payload-length/load/vector read. Never
    // resets.
    static REFERENCE_FEED_READS: AtomicU64 = AtomicU64::new(0);

    // -- Module-owned wire-graph decode + externref-handle scan (orchestration
    //    migration increment 1) -------------------------------------------------
    //
    // The decoded reference transaction the module OWNS for the current fork's
    // decode/scan path, seeded by `fm_decode_reference_graph` from the KFMS
    // module-state arena. This is the module-owned equivalent of the JS
    // `decodeSegmentedForkReferenceTransaction` result: it lets the host (in a
    // later host-rewire increment) stop decoding the wire graph in TypeScript
    // (`fork-reference-segments.ts`) and stop scanning externref handles in
    // TypeScript (`scanSegmentedForkReferenceExternrefHandles`,
    // `fork-externref-process-owner.ts`), routing both through the ONE shared
    // `fork_codec` decoder that already backs `fm_begin_reference_replay`. Held
    // in its OWN static, independent of the replay `REFERENCE_STATE` driver: the
    // pre-launch externref-handle scan runs BEFORE any replay driver is seeded,
    // and a decode may be requested purely to inspect the graph.
    struct DecodedGraphCell(UnsafeCell<Option<SegmentedReferenceTransaction>>);
    // SAFETY: single-threaded per worker (see HeapCell).
    unsafe impl Sync for DecodedGraphCell {}
    static DECODED_GRAPH: DecodedGraphCell = DecodedGraphCell(UnsafeCell::new(None));

    #[allow(clippy::mut_from_ref)]
    fn decoded_graph() -> &'static mut Option<SegmentedReferenceTransaction> {
        // SAFETY: single-threaded per worker; only one host drives decode/scan.
        unsafe { &mut *DECODED_GRAPH.0.get() }
    }

    // Monotonic count of reference graphs the module has DECODED from a KFMS
    // arena since worker start. Proof-of-use for the decode flip: after the host
    // routes wire-graph decode through `fm_decode_reference_graph` this has
    // advanced past its pre-fork value; a silent fallback to the TypeScript
    // `decodeSegmentedForkReferenceTransaction` leaves it unchanged. Never resets.
    static REFERENCE_GRAPHS_DECODED: AtomicU64 = AtomicU64::new(0);

    // Monotonic count of externref handles the module has SCANNED out of decoded
    // graphs since worker start. Proof-of-use for the scan flip: after the host
    // routes the pre-launch externref-handle scan through
    // `fm_scan_externref_handles` this has advanced by the graph's distinct
    // externref-handle count; a silent fallback to the TypeScript
    // `scanSegmentedForkReferenceExternrefHandles` leaves it unchanged. Never
    // resets.
    static EXTERNREF_HANDLES_SCANNED: AtomicU64 = AtomicU64::new(0);

    // -- Reference CAPTURE session (Path B P3 — module-owned encode graph) ----
    //
    // The encode-side sibling of `REFERENCE_STATE`/`REFERENCE_FEED`. As the
    // parent's instrumented `wpk_fork_module_state_save` walk discovers Wasm
    // reference values, the host's thin capture-import bodies resolve each value
    // to its recipe COORDINATE using the irreducible per-host identity floor (V8
    // `WeakMap` externref provenance / the transit `table.get`; native's
    // `Rooted`+`ref_eq`) and then intern that coordinate here through the SHARED
    // `fork_codec::ReferenceGraphBuilder` — byte-for-byte the same graph the
    // decoder reconstructs. This is exactly native's shape (`guest.rs`'s capture
    // bodies call `graph.intern_externref`, etc.), lifted to a module export so
    // BOTH V8 hosts route capture interning through the ONE shared builder
    // instead of the per-host TypeScript `ForkReferenceTransaction` capture graph.
    // The floor stays host-side: the module never sees a live reference — only
    // resolved i32/i64 coordinates.
    struct CaptureCell(UnsafeCell<Option<ReferenceGraphBuilder>>);
    // SAFETY: single-threaded per worker (see HeapCell).
    unsafe impl Sync for CaptureCell {}
    static CAPTURE_STATE: CaptureCell = CaptureCell(UnsafeCell::new(None));

    #[allow(clippy::mut_from_ref)]
    fn capture_state() -> &'static mut Option<ReferenceGraphBuilder> {
        // SAFETY: single-threaded per worker; only one guest drives capture.
        unsafe { &mut *CAPTURE_STATE.0.get() }
    }

    // Whether a capture session is live for the current fork. `fm_capture_begin`
    // sets this AND creates the builder EAGERLY (see there); `fm_begin_unwind`
    // consumes it (`swap(0)`) to decide whether it, rather than
    // `fm_capture_begin`, owns the fork's single bump-heap reset. The builder
    // must be allocated from a bump that is reset exactly once per fork, at the
    // true fork start (`fm_capture_begin`), because the guest encodes references
    // BOTH before and after `fm_begin_unwind`; resetting again in
    // `fm_begin_unwind` would reclaim the live builder mid-fork. So the builder
    // survives capture, seal, and the parent's own `fm_capture_vector_get` replay
    // reads (no further reset occurs on the parent path).
    static CAPTURE_ARMED: AtomicU32 = AtomicU32::new(0);

    /// The resident capture builder for the current fork. `fm_capture_begin`
    /// creates it eagerly; this is the accessor the capture exports use. As a
    /// defensive fallback it also creates the builder if a session is armed but
    /// the builder is somehow absent. `Err(EINVAL)` if no capture session is
    /// armed (a misordered host call).
    #[allow(clippy::mut_from_ref)]
    fn capture_builder() -> Result<&'static mut ReferenceGraphBuilder, Errno> {
        let slot = capture_state();
        if slot.is_none() {
            if CAPTURE_ARMED.load(Ordering::Relaxed) == 0 {
                return Err(Errno::EINVAL);
            }
            *slot = Some(ReferenceGraphBuilder::begin());
        }
        Ok(slot.as_mut().unwrap())
    }

    // Owns the serialized KFRV/KFRS record stream `fm_capture_serialize` emits so
    // the pointer it returns stays valid while the host drains the records into
    // its module-state arena (mirrors `DRIVE_PLAN`'s rooting of the drive plan).
    struct CaptureSerializedCell(UnsafeCell<Option<Vec<u8>>>);
    // SAFETY: single-threaded per worker (see HeapCell).
    unsafe impl Sync for CaptureSerializedCell {}
    static CAPTURE_SERIALIZED: CaptureSerializedCell = CaptureSerializedCell(UnsafeCell::new(None));

    // Monotonic count of reference coordinates the module has INTERNED into the
    // shared capture builder since worker start (Path B P3). Proof-of-use mirror
    // of `REFERENCES_RECONSTRUCTED` for the CAPTURE (parent/encode) side: after a
    // flag-on fork routes capture through the module this has advanced past its
    // pre-fork value; a silent fallback to the TypeScript capture graph leaves it
    // unchanged. Bumped once per successful intern/claim/define/gated-placeholder.
    // Never resets.
    static CAPTURE_INTERNED: AtomicU64 = AtomicU64::new(0);

    // The i32 sentinels `fm_funcref_ordinal` returns to the injected wasm shim.
    // A NON-NEGATIVE value is a catalog ordinal for `table.get`; `NULL_ORDINAL`
    // means reconstruct `ref.null func`. The shim treats every other negative as
    // impossible: `fm_funcref_ordinal` traps (unreachable) on any inconsistency
    // rather than hand back a value the shim would misread, so a corrupt graph is
    // a truthful hard failure, never a wrong funcref.
    const NULL_ORDINAL: i32 = -1;

    // -- GC drive-shim state (Phase 6 item 3b — call_indirect drive mechanism) --
    //
    // The injected `fm_drive_execute(plan_ptr, count)` shim (crates/fork-module-
    // inject) loops a serialized drive PLAN and `call_indirect`s the guest's
    // `_gc_allocate`/`_gc_fill` exports through the host-bound
    // `env.__wpk_fork_drive_table`, then — after each ALLOC step — reads STORE #2
    // (the guest's shared Wasm-GC transit table `env.__wpk_fork_ref_gc_transit`)
    // at slot `recipe + 1` with a wasm `table.get` + `ref.is_null` to assert the
    // guest's `_gc_allocate` published a live GC object there, trapping otherwise.
    // That integrity guard lives entirely in the injected wasm (Rust holds no
    // `anyref`), so the module keeps no host-generation R1 state for it.

    // Owns the serialized drive plan's backing bytes so the pointer
    // `fm_build_trivial_plan` returns stays valid while the shim reads it. Held
    // in its OWN static (the bump `dealloc` is a no-op, but keeping the `Vec`
    // rooted here is explicit and independent of the per-fork heap reset).
    struct DrivePlanCell(UnsafeCell<Option<Vec<u8>>>);
    // SAFETY: single-threaded per worker (see HeapCell).
    unsafe impl Sync for DrivePlanCell {}
    static DRIVE_PLAN: DrivePlanCell = DrivePlanCell(UnsafeCell::new(None));

    fn build_trivial_plan_impl(activation: u32, recipe: u32, _pid: u32) -> Result<usize, Errno> {
        // The injected shim's post-ALLOC integrity guard reads STORE #2 (the
        // guest's Wasm-GC transit table) directly, so no host generation is opened
        // here.
        // Serialize the trivial ALLOC-then-FILL plan into a module-owned buffer;
        // its guest address is what `fm_drive_execute` strides over.
        let steps = drive_plan::trivial_struct_plan(activation, recipe);
        let mut buf = Vec::new();
        buf.resize(drive_plan::DRIVE_STEP_SIZE * steps.len(), 0u8);
        drive_plan::serialize_plan(&steps, &mut buf)?;
        let ptr = buf.as_ptr() as usize;
        // SAFETY: single-threaded per worker; rooting the backing bytes so the
        // returned pointer stays valid for the shim's reads.
        unsafe {
            *DRIVE_PLAN.0.get() = Some(buf);
        }
        Ok(ptr)
    }

    fn set_format_impl(pointer_width: u32, fixed_prefix_size: u32) -> Result<(), Errno> {
        // The ABI only defines linked-frame geometry for 32- and 64-bit guests.
        if abi::wpk_fork_linked_chunk_header_size(pointer_width as u8).is_none() {
            return Err(Errno::EINVAL);
        }
        FMT_POINTER_WIDTH.store(pointer_width, Ordering::Relaxed);
        FMT_FIXED_PREFIX.store(fixed_prefix_size, Ordering::Relaxed);
        Ok(())
    }

    fn format() -> Result<LinkedFrameFormat, Errno> {
        let pw = FMT_POINTER_WIDTH.load(Ordering::Relaxed);
        if pw == 0 {
            return Err(Errno::EINVAL);
        }
        Ok(LinkedFrameFormat {
            pointer_width: pw as u8,
            chunk_header_size: abi::wpk_fork_linked_chunk_header_size(pw as u8)
                .ok_or(Errno::EINVAL)?,
            node_header_size: abi::wpk_fork_linked_node_header_size(pw as u8).ok_or(Errno::EINVAL)?,
            fixed_prefix_size: FMT_FIXED_PREFIX.load(Ordering::Relaxed),
        })
    }

    // -- Per-worker bump heap ------------------------------------------------
    //
    // A fixed static region serves the module's own `alloc` allocations (the
    // writer/journal/slot-table `Vec`/`BTreeMap` state). It is reset at each
    // `fm_begin_unwind`, so per-fork state is reclaimed and the module can be
    // reused across forks without unbounded growth. `dealloc` is a no-op (bump);
    // freeing happens only at the per-fork reset.
    //
    // Because this crate is a PIC (`--pie`) side module, this BSS region is NOT
    // at a fixed low linear-memory offset: it lives at `__memory_base + offset`,
    // where the HOST chooses `__memory_base` to point into a region the guest is
    // not using. So the heap no longer collides with guest data (the D5 gating
    // fix; see the module doc comment and `tests/harness.mjs`). 4 MiB comfortably
    // covers a single fork's peak state — including bump waste from `Vec`
    // doubling — for well past the 5000-frame stress workload, and it sets the
    // module's `dylink.0` `mem_size` (how much of the `__memory_base` region the
    // host must reserve).
    const HEAP_SIZE: usize = 4 * 1024 * 1024;

    #[repr(C, align(16))]
    struct HeapCell(UnsafeCell<[u8; HEAP_SIZE]>);
    // SAFETY: the process worker is single-threaded for fork state; all access
    // is serialized by the one guest that calls these exports.
    unsafe impl Sync for HeapCell {}
    static HEAP: HeapCell = HeapCell(UnsafeCell::new([0u8; HEAP_SIZE]));

    struct Bump {
        offset: AtomicUsize,
    }
    // SAFETY: single-threaded per worker (see HeapCell).
    unsafe impl Sync for Bump {}

    unsafe impl GlobalAlloc for Bump {
        unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
            let base = HEAP.0.get() as *mut u8 as usize;
            let cur = self.offset.load(Ordering::Relaxed);
            let align = layout.align();
            let start = match base.checked_add(cur) {
                Some(s) => s,
                None => return core::ptr::null_mut(),
            };
            let aligned = (start.wrapping_add(align - 1)) & !(align - 1);
            match (aligned - base).checked_add(layout.size()) {
                Some(next) if next <= HEAP_SIZE => {
                    self.offset.store(next, Ordering::Relaxed);
                    aligned as *mut u8
                }
                _ => core::ptr::null_mut(),
            }
        }

        unsafe fn dealloc(&self, _ptr: *mut u8, _layout: Layout) {}
    }

    impl Bump {
        fn reset(&self) {
            self.offset.store(0, Ordering::Relaxed);
        }
    }

    #[global_allocator]
    static ALLOC: Bump = Bump {
        offset: AtomicUsize::new(0),
    };

    #[panic_handler]
    fn panic(_info: &core::panic::PanicInfo) -> ! {
        wasm_intr::unreachable()
    }

    // -- Shared guest memory access -----------------------------------------

    fn mem_len_bytes() -> usize {
        wasm_intr::memory_size(0) * 65_536
    }

    /// A mutable view of the whole guest linear memory.
    ///
    /// # Safety
    /// In WebAssembly linear memory byte offset 0 is a valid address and the
    /// whole `[0, size)` range is addressable. `fork-codec` indexes this slice
    /// with ABSOLUTE guest byte offsets (so the base must be offset 0) and only
    /// ever dereferences offsets inside the grown frame arena, which sits above
    /// all module data. The "null" base is an abstract-machine artifact of
    /// wasm's flat address space; the same guest-offset-as-pointer idiom is used
    /// throughout the kernel (`crates/kernel/src/wasm_api.rs`). The crate is
    /// built `--release`, so the debug non-null slice precondition is compiled
    /// out.
    unsafe fn mem_mut() -> &'static mut [u8] {
        // The base is wasm address 0 (see the doc note). It is formed through an
        // opaque zero so the abstract-machine "null base" is not a statically
        // visible null literal — the same guest-offset-as-pointer reality the
        // kernel relies on, expressed without tripping the null-argument lint.
        let base = core::hint::black_box(0usize) as *mut u8;
        unsafe { core::slice::from_raw_parts_mut(base, mem_len_bytes()) }
    }

    /// An immutable view of the whole guest linear memory. See [`mem_mut`].
    ///
    /// # Safety
    /// Same contract as [`mem_mut`].
    unsafe fn mem_ref() -> &'static [u8] {
        // See [`mem_mut`] for the opaque-zero base rationale.
        let base = core::hint::black_box(0usize) as *const u8;
        unsafe { core::slice::from_raw_parts(base, mem_len_bytes()) }
    }

    // -- In-realm channel SYS_MMAP (Option B) --------------------------------
    //
    // The module allocates each frame chunk by issuing `SYS_MMAP` through the
    // SAME syscall channel the guest uses, field-for-field mirroring the JS
    // `continuationMmap` (host/src/worker-main.ts). It publishes the request,
    // blocks in-realm on `memory_atomic_wait32(status, PENDING)` until the
    // kernel worker services it, then reads the result. Every offset comes from
    // the shared `channel` ABI module (no re-hardcoded layout).
    //
    // This replaces Option A's fixed host-reserved arena: the module grows
    // memory ON DEMAND like the JS path, so continuation depth is bounded only
    // by available memory, and the host no longer reserves or threads a
    // per-fork arena. `SYS_MMAP` GROWS the shared linear memory, so the caller
    // MUST re-derive any pre-captured memory view afterward (see the
    // `ChunkAllocator::current_memory` re-slice in `fork-codec`).

    /// The combined `PROT_READ | PROT_WRITE` and `MAP_PRIVATE | MAP_ANONYMOUS`
    /// the JS `continuationMmap` uses, composed from the shared flags.
    const PROT_READ_WRITE: i64 = (mmap::PROT_READ | mmap::PROT_WRITE) as i64;
    const MAP_PRIVATE_ANONYMOUS: i64 = (mmap::MAP_PRIVATE | mmap::MAP_ANONYMOUS) as i64;

    /// Absolute-offset little-endian scalar writes into the channel region (the
    /// same guest-offset-as-pointer idiom the frame paths use; no `&mut [u8]`
    /// slice is formed over the channel, so no aliasing with the atomic below).
    unsafe fn ch_write_u32(base: u64, off: usize, value: u32) {
        let ptr = core::hint::black_box((base as usize).wrapping_add(off)) as *mut u8;
        unsafe { core::ptr::copy_nonoverlapping(value.to_le_bytes().as_ptr(), ptr, 4) };
    }
    unsafe fn ch_write_i64(base: u64, off: usize, value: i64) {
        let ptr = core::hint::black_box((base as usize).wrapping_add(off)) as *mut u8;
        unsafe { core::ptr::copy_nonoverlapping(value.to_le_bytes().as_ptr(), ptr, 8) };
    }
    unsafe fn ch_read_u32(base: u64, off: usize) -> u32 {
        let ptr = core::hint::black_box((base as usize).wrapping_add(off)) as *const u8;
        let mut bytes = [0u8; 4];
        unsafe { core::ptr::copy_nonoverlapping(ptr, bytes.as_mut_ptr(), 4) };
        u32::from_le_bytes(bytes)
    }
    unsafe fn ch_read_i64(base: u64, off: usize) -> i64 {
        let ptr = core::hint::black_box((base as usize).wrapping_add(off)) as *const u8;
        let mut bytes = [0u8; 8];
        unsafe { core::ptr::copy_nonoverlapping(ptr, bytes.as_mut_ptr(), 8) };
        i64::from_le_bytes(bytes)
    }

    const CH_PENDING: i32 = ChannelStatus::Pending as i32;
    const CH_IDLE: i32 = ChannelStatus::Idle as i32;

    /// Issue a channel syscall (`nr` + six i64 args), block in-realm until the
    /// kernel worker services it, and return `(ret, errno)`. Mirrors the JS
    /// `continuationMmap`/`continuationMunmap` handshake exactly: write the
    /// request + the DEFER-SIGNAL flag, atomic-store PENDING + notify, spin in
    /// `memory_atomic_wait32` until the status leaves PENDING, read RETURN/ERRNO,
    /// clear the flag, and atomic-store IDLE.
    fn channel_syscall(channel_base: u64, nr: u32, args: [i64; 6]) -> (i64, u32) {
        // SAFETY: `channel_base` is the guest syscall channel region (page-aligned
        // in production). All accesses are within `[channel_base, +HEADER_SIZE)`.
        unsafe {
            ch_write_u32(channel_base, channel::SYSCALL_OFFSET, nr);
            for (index, value) in args.iter().enumerate() {
                ch_write_i64(
                    channel_base,
                    channel::ARGS_OFFSET + index * channel::ARG_SIZE,
                    *value,
                );
            }
            // Caught signals must remain kernel-pending across this host
            // transition (the guest is mid-continuation), exactly as the JS
            // continuation allocator marks its own channel syscalls.
            ch_write_u32(
                channel_base,
                channel::REQUEST_FLAGS_OFFSET,
                channel::REQUEST_FLAG_DEFER_SIGNAL_DELIVERY,
            );
            let status_ptr =
                core::hint::black_box((channel_base as usize) + channel::STATUS_OFFSET) as *mut i32;
            // Publish PENDING (seq-cst, so the request writes above are visible to
            // the kernel worker) and wake it.
            let status = &*(status_ptr as *const AtomicI32);
            status.store(CH_PENDING, Ordering::SeqCst);
            wasm_intr::memory_atomic_notify(status_ptr, 1);
            // Block until the worker clears PENDING. `== 0` is "woken"; a status
            // that already left PENDING returns "not-equal" and exits the loop.
            while wasm_intr::memory_atomic_wait32(status_ptr, CH_PENDING, -1) == 0 {}
            let ret = ch_read_i64(channel_base, channel::RETURN_OFFSET);
            let err = ch_read_u32(channel_base, channel::ERRNO_OFFSET);
            ch_write_u32(channel_base, channel::REQUEST_FLAGS_OFFSET, 0);
            status.store(CH_IDLE, Ordering::SeqCst);
            (ret, err)
        }
    }

    /// `mmap(NULL, size, RW, MAP_PRIVATE|ANON, -1, 0)` over the channel. Returns
    /// the mapped guest offset, or a TRUTHFUL errno (`ENOMEM`/`EAGAIN`; never a
    /// flattened `EINVAL`) on failure. NOTE: this GROWS shared memory — callers
    /// re-derive their memory view via `ChunkAllocator::current_memory`.
    fn channel_mmap(channel_base: u64, size: u64) -> Result<u64, Errno> {
        let (ret, err) = channel_syscall(
            channel_base,
            Syscall::Mmap as u32,
            [0, size as i64, PROT_READ_WRITE, MAP_PRIVATE_ANONYMOUS, -1, 0],
        );
        if err != 0 || ret < 0 {
            let code = if err != 0 { err } else { (-ret) as u32 };
            return Err(Errno::from_u32(code).unwrap_or(Errno::ENOMEM));
        }
        Ok(ret as u64)
    }

    /// `munmap(addr, size)` over the channel. Symmetric with `channel_mmap`;
    /// returns the truthful errno on failure.
    fn channel_munmap(channel_base: u64, addr: u64, size: u64) -> Result<(), Errno> {
        let (ret, err) = channel_syscall(
            channel_base,
            Syscall::Munmap as u32,
            [addr as i64, size as i64, 0, 0, 0, 0],
        );
        if err != 0 || ret < 0 {
            let code = if err != 0 { err } else { (-ret) as u32 };
            return Err(Errno::from_u32(code).unwrap_or(Errno::EINVAL));
        }
        Ok(())
    }

    // -- Module-owned growing frame-chunk allocator (Option B) --------------
    //
    // Each `allocate` issues a fresh `SYS_MMAP` through the channel, growing the
    // shared memory on demand, and records `(addr, size)` so the chunks can be
    // released (`munmap`) when the fork's replay finishes or aborts. `SYS_MMAP`
    // returns a page-aligned address and every capacity is a page multiple, so
    // the writer's page-alignment invariant holds.
    //
    // A replay-only forked CHILD constructs this with `channel_base == 0` and
    // never calls `allocate` (its `replay_only` guard rejects reserve/commit), so
    // the child mmaps nothing; its `chunks` stays empty and `release_all` is a
    // no-op there.
    struct FrameArena {
        /// Channel mode: issue each chunk's `SYS_MMAP` through this guest syscall
        /// channel base (page-aligned). `0` on a replay-only child (allocates
        /// nothing) and on a FIXED arena (which never touches the channel).
        channel_base: u64,
        chunks: Vec<(u64, u64)>,
        /// FIXED mode (in-realm, NO host servicer): bump-allocate each chunk from a
        /// caller-owned, pre-reserved `[fixed_next, fixed_end)` region instead of
        /// channel-mmap. Because it never grows memory and never issues a channel
        /// syscall, a single-threaded in-process harness (which cannot service the
        /// blocking `memory_atomic_wait32` channel handshake) can drive a full
        /// unwind → replay cycle. `false` selects channel mode (production).
        fixed: bool,
        fixed_next: u64,
        fixed_end: u64,
    }

    impl FrameArena {
        /// The production growing arena: each chunk is `SYS_MMAP`'d through the
        /// guest syscall channel at `channel_base`, growing shared memory on
        /// demand. `0` = a replay-only child that allocates nothing.
        fn new_channel(channel_base: u64) -> Self {
            FrameArena {
                channel_base,
                chunks: Vec::new(),
                fixed: false,
                fixed_next: 0,
                fixed_end: 0,
            }
        }

        /// A caller-owned FIXED arena over `[base, base + len)`; allocations bump
        /// within it and never grow memory or touch the channel, so `release_all`
        /// is a no-op. The caller guarantees the region is already backed and
        /// disjoint from every other activation's arena and the module region.
        fn new_fixed(base: u64, len: u64) -> Self {
            FrameArena {
                channel_base: 0,
                chunks: Vec::new(),
                fixed: true,
                fixed_next: base,
                fixed_end: base.saturating_add(len),
            }
        }

        /// Best-effort release of every chunk this allocator mapped. Called after
        /// a successful replay finish and on abort; a `munmap` hiccup does not
        /// fail an already-complete fork, so errors are ignored here. A FIXED
        /// arena owns no mappings, so it only drops its bookkeeping.
        fn release_all(&mut self) {
            if self.fixed {
                self.chunks.clear();
                return;
            }
            for (addr, size) in self.chunks.drain(..) {
                let _ = channel_munmap(self.channel_base, addr, size);
            }
        }
    }

    impl ChunkAllocator for FrameArena {
        fn allocate(&mut self, capacity: u64) -> Result<u64, Errno> {
            if self.fixed {
                // Bump within the fixed region, page-aligning each chunk so the
                // writer's page-alignment invariant matches the channel path.
                // Exhaustion is a truthful `ENOMEM`, never a masked `EINVAL`.
                let addr = self.fixed_next.checked_add(PAGE - 1).ok_or(Errno::ENOMEM)? & !(PAGE - 1);
                let end = addr.checked_add(capacity).ok_or(Errno::ENOMEM)?;
                if end > self.fixed_end {
                    return Err(Errno::ENOMEM);
                }
                self.fixed_next = end;
                self.chunks.push((addr, capacity));
                return Ok(addr);
            }
            let addr = channel_mmap(self.channel_base, capacity)?;
            self.chunks.push((addr, capacity));
            Ok(addr)
        }

        fn current_memory(&self) -> Option<(*mut u8, usize)> {
            // A FIXED arena never grows memory, so the writer's existing slice
            // stays valid — return `None` and keep it (see the trait doc).
            if self.fixed {
                return None;
            }
            // `channel_mmap` grew the shared linear memory; hand the writer a
            // fresh (base, len) so the just-mapped high chunk is in bounds. Base
            // is wasm address 0 (see `mem_mut`); the length is re-queried live.
            Some((core::hint::black_box(0usize) as *mut u8, mem_len_bytes()))
        }
    }

    // -- Per-worker state: activation-keyed frames + process-wide journal ----
    //
    // Phase 6 D7a.2: a dlopen fork has N ACTIVATIONS (activation 0 = the main
    // module, 1..N = the dlopen'd side modules). Each activation owns its own
    // linked-frame writer, frame arena, fixed runtime prefix, rewind driver, and
    // continuation anchor — its FRAMES are independent. The replay JOURNAL and
    // the RESUME-SLOT TABLE stay PROCESS-WIDE: the journal already tags every
    // event with its `activation_id`, so it records the exact interleaved order
    // frames commit across every activation and replays the reverse; the table
    // keys slots by `(activation_id, function_ordinal)`. A single-activation fork
    // is the degenerate case: one entry in the map (`primary_activation`).

    /// The per-activation frame state (one entry per activation id).
    struct ActivationFrames {
        format: LinkedFrameFormat,
        writer: LinkedFrameWriter,
        arena: FrameArena,
        driver: Option<RewindDriver>,
        committed_ordinals: Vec<u32>,
        module_buffer: u64,
        /// A child (forked) instance seeds its journal from copied guest memory
        /// and only ever replays; it never unwinds, so it has no live frame
        /// arena to reserve into. Guard the reserve/commit exports against it so
        /// a stray guest reserve on a replay-only child is a truthful `EINVAL`
        /// rather than a write into an unowned region.
        replay_only: bool,
    }

    struct ForkModule {
        /// Per-activation frame state, keyed by activation id.
        activations: BTreeMap<u32, ActivationFrames>,
        /// The guest syscall channel base this fork issues chunk `SYS_MMAP`
        /// through (Option B). 0 on a replay-only child, which allocates nothing.
        /// The image chunk `fm_serialize_journal_alloc` maps is released through
        /// this same channel on finish/abort.
        channel_base: u64,
        /// Guest offsets + sizes of any chunk this fork mapped OUTSIDE an
        /// activation's own writer (currently the serialized-journal image
        /// chunk). Released alongside the per-activation chunks on finish/abort.
        extra_chunks: Vec<(u64, u64)>,
        /// The guest offset + byte length of the KFRE journal image
        /// `fm_serialize_journal_alloc` channel-mmap'd (0 until it runs). The
        /// host reads both back (`fm_journal_image_len`) to write the
        /// `JournalImage` KFMS record so the child can find the inherited image.
        journal_image_ptr: u64,
        journal_image_len: u64,
        /// Process-wide replay-event journal (records `(activation_id, ordinal)`
        /// commits across every activation; replays the global reverse order).
        journal: ReplayEventJournal,
        /// Process-wide resume-slot table (slots keyed by activation + ordinal).
        table: ResumeSlotTable,
        /// A forked CHILD's decoded (capture-order) replay events, ALL
        /// activations, retained from `fm_begin_child_replay` so a later
        /// `fm_add_activation_child_replay` can rebuild a side activation's
        /// committed ordinals by filtering on `activation_id` (the journal itself
        /// is already in the Replay phase and no longer exposes its events).
        /// Empty on the parent (unwind) path.
        replay_events: Vec<ReplayEvent>,
        /// Set by `fm_begin_abort`, asserted by `fm_finish_abort`, cleared by
        /// `fm_finish_abort`/`fm_abort`. Abort-replay drives the exact same
        /// frame/journal mechanics as parent replay (`begin_replay_impl`/
        /// `finish_replay_impl` are delegated to, not duplicated); this flag
        /// only tags the drive so a stray `fm_finish_abort` without a matching
        /// `fm_begin_abort` is a loud `EINVAL` rather than a silent pairing
        /// with `fm_finish_replay`'s bookkeeping.
        in_abort: bool,
    }

    struct StateCell(UnsafeCell<Option<ForkModule>>);
    // SAFETY: single-threaded per worker (see HeapCell).
    unsafe impl Sync for StateCell {}
    static STATE: StateCell = StateCell(UnsafeCell::new(None));

    #[allow(clippy::mut_from_ref)]
    fn state() -> &'static mut Option<ForkModule> {
        // SAFETY: the process worker is single-threaded for fork state; only one
        // guest drives these exports, so there is never an overlapping borrow.
        unsafe { &mut *STATE.0.get() }
    }

    // The activation the guest-facing `__wpk_fork_frame_*` exports resolve to.
    // Set by `fm_begin_unwind` / `fm_begin_child_replay`; the legacy
    // single-activation path uses this so the guest ABI is unchanged.
    static PRIMARY_ACTIVATION: AtomicU32 = AtomicU32::new(0);

    fn primary_activation() -> u32 {
        PRIMARY_ACTIVATION.load(Ordering::Relaxed)
    }

    static LAST_ERRNO: AtomicI32 = AtomicI32::new(0);

    fn set_ok() {
        LAST_ERRNO.store(0, Ordering::Relaxed);
    }

    fn set_err(errno: Errno) {
        LAST_ERRNO.store(errno as i32, Ordering::Relaxed);
    }

    // -- Coordinator (JS→wasm, once per phase, not hot) ---------------------

    /// Register a fresh unwind activation into `module` over its own MODULE-OWNED
    /// growing arena (Option B: chunks are channel-mmap'd on demand), using `fmt`
    /// (the activation's own fixed runtime prefix). Publishes the activation's
    /// module-buffer anchor and returns it. Rejects a duplicate activation id
    /// with `EINVAL` (each activation is registered once per fork).
    fn register_unwind_activation(
        module: &mut ForkModule,
        activation_id: u32,
        fmt: LinkedFrameFormat,
        mut arena: FrameArena,
    ) -> Result<u64, Errno> {
        if module.activations.contains_key(&activation_id) {
            return Err(Errno::EINVAL); // activation already open in this fork
        }
        let mut writer = LinkedFrameWriter::new(fmt);
        // `begin_unwind` channel-mmaps the root chunk, which GROWS shared memory;
        // it re-derives its own memory view via `arena.current_memory`, so the
        // stale pre-grow `mem` slice below is only its entry view.
        let mem = unsafe { mem_mut() };
        let module_buffer = writer.begin_unwind(mem, &mut arena)?;
        module.activations.insert(
            activation_id,
            ActivationFrames {
                format: fmt,
                writer,
                arena,
                driver: None,
                committed_ordinals: Vec::new(),
                module_buffer,
                replay_only: false,
            },
        );
        Ok(module_buffer)
    }

    fn begin_unwind_impl(activation_id: u32, channel_base: u64) -> Result<u64, Errno> {
        // Option B: the MODULE owns the per-fork frame allocation, issuing each
        // chunk's `SYS_MMAP` through `channel_base` (the guest syscall channel),
        // growing memory on demand like the JS path — no host arena reservation.
        // `fm_begin_unwind` starts a FRESH fork: it reclaims the previous fork's
        // state + heap and registers this activation as the first (and, for a
        // single-activation fork, only) one. Additional activations (a dlopen
        // fork's side modules) are added to the SAME fork with
        // `fm_add_activation_unwind` — no reset.
        if channel_base == 0 || channel_base % PAGE != 0 {
            return Err(Errno::EINVAL); // the syscall channel is page-aligned
        }

        // The format must have been seeded (once) via `fm_set_format`.
        let fmt = format()?;

        // Reclaim the previous fork's state before this fork. The bump-HEAP reset
        // is skipped when a capture session is armed: `fm_capture_begin` already
        // reset the bump at the true fork start (before the guest began encoding
        // references into the co-resident capture builder), and resetting again
        // here would reclaim that live builder mid-fork. `swap(0)` consumes the
        // arming so a later non-capture fork (or a flag-off fork that never calls
        // `fm_capture_begin`) still reclaims the heap here as before.
        *state() = None;
        if CAPTURE_ARMED.swap(0, Ordering::Relaxed) == 0 {
            ALLOC.reset();
        }

        let mut module = ForkModule {
            activations: BTreeMap::new(),
            channel_base,
            extra_chunks: Vec::new(),
            journal_image_ptr: 0,
            journal_image_len: 0,
            journal: ReplayEventJournal::new(),
            table: ResumeSlotTable::new(),
            replay_events: Vec::new(),
            in_abort: false,
        };
        // One capture spans every activation: commits from all activations are
        // recorded in the single process-wide journal in interleaved order.
        module.journal.begin_capture()?;
        let arena = FrameArena::new_channel(channel_base);
        let module_buffer = register_unwind_activation(&mut module, activation_id, fmt, arena)?;

        *state() = Some(module);
        PRIMARY_ACTIVATION.store(activation_id, Ordering::Relaxed);
        Ok(module_buffer)
    }

    // -- In-realm FIXED-arena unwind (in-process test / no-servicer harness) --
    //
    // The production `fm_begin_unwind` grows the frame arena by issuing each
    // chunk's `SYS_MMAP` through the guest syscall channel and blocking in-realm
    // on `memory_atomic_wait32` until a host servicer wakes it. A single-threaded
    // in-process harness (no worker) cannot service that blocking wait, so these
    // sibling entries take a caller-owned, pre-reserved FIXED arena
    // `[base, base + len)` and bump-allocate chunks within it — no channel, no
    // memory grow, no servicer. They are otherwise byte-identical to the channel
    // path (same journal, writer, resume table), so they exercise the exact
    // multi-activation frame routing the production path does. They never
    // allocate through the channel, so `channel_base` is left `0`; a fork opened
    // this way must NOT also call `fm_serialize_journal_alloc` (which needs a
    // real channel). Used only by host unit harnesses.

    fn begin_unwind_fixed_arena_impl(activation_id: u32, base: u64, len: u64) -> Result<u64, Errno> {
        let fmt = format()?;
        // Reclaim the previous fork's state and heap before this fork.
        *state() = None;
        ALLOC.reset();
        let mut module = ForkModule {
            activations: BTreeMap::new(),
            channel_base: 0,
            extra_chunks: Vec::new(),
            journal_image_ptr: 0,
            journal_image_len: 0,
            journal: ReplayEventJournal::new(),
            table: ResumeSlotTable::new(),
            replay_events: Vec::new(),
            in_abort: false,
        };
        module.journal.begin_capture()?;
        let arena = FrameArena::new_fixed(base, len);
        let module_buffer = register_unwind_activation(&mut module, activation_id, fmt, arena)?;
        *state() = Some(module);
        PRIMARY_ACTIVATION.store(activation_id, Ordering::Relaxed);
        Ok(module_buffer)
    }

    fn add_activation_unwind_fixed_arena_impl(
        activation_id: u32,
        base: u64,
        len: u64,
        fixed_prefix: u32,
    ) -> Result<u64, Errno> {
        let base_fmt = format()?;
        let fmt = LinkedFrameFormat {
            fixed_prefix_size: fixed_prefix,
            ..base_fmt
        };
        let st = state().as_mut().ok_or(Errno::EINVAL)?;
        let arena = FrameArena::new_fixed(base, len);
        register_unwind_activation(st, activation_id, fmt, arena)
    }

    /// Add ANOTHER activation to the fork already begun by `fm_begin_unwind`
    /// (Phase 6 D7a.2 — a dlopen fork's side module). `fixed_prefix` is THIS
    /// activation's own module-buffer fixed runtime prefix (side modules carry
    /// their own). The pointer width is the guest's, shared across activations
    /// (seeded once via `fm_set_format`); the fork's channel base is shared too
    /// (this activation mmaps its chunks through the same channel). No reset: the
    /// process-wide journal stays in its capture phase across every activation.
    fn add_activation_unwind_impl(
        activation_id: u32,
        channel_base: u64,
        fixed_prefix: u32,
    ) -> Result<u64, Errno> {
        // Derive this activation's format from the seeded pointer width plus its
        // own fixed prefix, so a side module with a different prefix is honored.
        let base = format()?;
        let fmt = LinkedFrameFormat {
            fixed_prefix_size: fixed_prefix,
            ..base
        };
        let st = state().as_mut().ok_or(Errno::EINVAL)?;
        // Every activation in one worker shares the one syscall channel; a
        // disagreeing base is a host bug, not a silent second channel.
        if channel_base != st.channel_base {
            return Err(Errno::EINVAL);
        }
        let arena = FrameArena::new_channel(channel_base);
        register_unwind_activation(st, activation_id, fmt, arena)
    }

    fn reserve_impl(activation_id: u32, size: u64) -> Result<u64, Errno> {
        let st = state().as_mut().ok_or(Errno::EINVAL)?;
        let act = st.activations.get_mut(&activation_id).ok_or(Errno::EINVAL)?;
        if act.replay_only {
            return Err(Errno::EINVAL); // a forked child never unwinds
        }
        let mem = unsafe { mem_mut() };
        act.writer.reserve_frame(mem, &mut act.arena, size)
    }

    fn commit_impl(activation_id: u32, payload: u64) -> Result<(), Errno> {
        let st = state().as_mut().ok_or(Errno::EINVAL)?;
        // Split-borrow the disjoint fields: the per-activation writer and the
        // process-wide journal are borrowed together.
        let ForkModule {
            activations, journal, ..
        } = st;
        let act = activations.get_mut(&activation_id).ok_or(Errno::EINVAL)?;
        if act.replay_only {
            return Err(Errno::EINVAL); // a forked child never unwinds
        }
        let mem = unsafe { mem_mut() };
        act.writer.commit_frame(mem, payload)?;
        // The guest fills the frame header before commit; the function ordinal is
        // the leading u32 of the payload. Record it in the process-wide journal
        // TAGGED with this activation, and for the resume-slot registration.
        let ordinal = RewindDriver::read_function_ordinal(mem, payload)?;
        journal.record_commit(activation_id, ordinal)?;
        act.committed_ordinals.push(ordinal);
        FRAMES_COMMITTED.fetch_add(1, Ordering::Relaxed);
        Ok(())
    }

    fn finish_unwind_impl() -> Result<(), Errno> {
        let st = state().as_mut().ok_or(Errno::EINVAL)?;
        // Seal every activation's writer, then the one process-wide journal.
        for act in st.activations.values() {
            act.writer.finish_unwind()?;
        }
        st.journal.seal_capture()?;
        Ok(())
    }

    fn begin_replay_impl() -> Result<(), Errno> {
        let st = state().as_mut().ok_or(Errno::EINVAL)?;
        st.journal.begin_parent_replay()?;
        let mem = unsafe { mem_ref() };
        // Register each activation's resume targets by the parity precedence
        // (per-activation catalog -> global catalog -> distinct committed
        // ordinals). A multi-activation (dlopen) fork gives each activation its
        // OWN seeded catalog; a single-activation fork with no catalog falls
        // straight through to the previous distinct-ordinals numbering, so the
        // single-activation slot assignment is byte-identical.
        let global = resume_catalog();
        let ForkModule {
            activations, table, ..
        } = st;
        for (activation_id, act) in activations.iter_mut() {
            let driver = RewindDriver::attach(mem, act.module_buffer, &act.format)?;
            register_activation_slots(table, *activation_id, global, &act.committed_ordinals)?;
            act.driver = Some(driver);
        }
        Ok(())
    }

    fn peek_impl(activation_id: u32, size: u64) -> Result<u64, Errno> {
        let st = state().as_mut().ok_or(Errno::EINVAL)?;
        let mem = unsafe { mem_ref() };
        let ForkModule {
            activations, journal, ..
        } = st;
        let act = activations.get_mut(&activation_id).ok_or(Errno::EINVAL)?;
        let driver = act.driver.as_ref().ok_or(Errno::EINVAL)?;
        driver.drive_peek(mem, journal, activation_id, size)
    }

    fn next_impl(activation_id: u32, size: u64) -> Result<u64, Errno> {
        let st = state().as_mut().ok_or(Errno::EINVAL)?;
        let mem = unsafe { mem_ref() };
        let ForkModule {
            activations, journal, ..
        } = st;
        let act = activations.get_mut(&activation_id).ok_or(Errno::EINVAL)?;
        let driver = act.driver.as_mut().ok_or(Errno::EINVAL)?;
        let payload = driver.drive_next(mem, journal, activation_id, size)?;
        // Count only a successful consuming advance: this is the replay-side
        // proof-of-use a replay-only child (which never commits) reports.
        FRAMES_REPLAYED.fetch_add(1, Ordering::Relaxed);
        Ok(payload)
    }

    /// The resume slot for the currently selected replay event. This is a
    /// process-wide journal + table concern — the slot is for whichever
    /// activation's event the global journal currently selects — so the
    /// `activation_id` argument (which activation's guest asked) is not needed to
    /// resolve it. It is accepted so the export shape matches the frame ops and
    /// the trampoline can pass a uniform activation immediate.
    fn resume_peek_impl(_activation_id: u32) -> Result<u32, Errno> {
        let st = state().as_mut().ok_or(Errno::EINVAL)?;
        let ForkModule {
            journal, table, ..
        } = st;
        RewindDriver::resume_peek(journal, table)
    }

    /// Release (munmap) every chunk this fork mapped through the channel: each
    /// activation's own frame chunks plus the extra (journal-image) chunk.
    /// Best-effort — a `munmap` hiccup does not fail an already-complete fork. A
    /// replay-only child mapped nothing (empty allocators), so this is a no-op
    /// there. The channel base is captured before the per-activation borrow to
    /// keep the borrow checker happy while draining both.
    fn release_fork_chunks(st: &mut ForkModule) {
        let channel_base = st.channel_base;
        for act in st.activations.values_mut() {
            act.arena.release_all();
        }
        for (addr, size) in st.extra_chunks.drain(..) {
            let _ = channel_munmap(channel_base, addr, size);
        }
    }

    fn finish_replay_impl() -> Result<(), Errno> {
        let st = state().as_mut().ok_or(Errno::EINVAL)?;
        // Every activation's driver must be exhausted, then the one journal.
        for act in st.activations.values() {
            let driver = act.driver.as_ref().ok_or(Errno::EINVAL)?;
            driver.finish_rewind()?;
        }
        st.journal.finish_replay()?;
        // Option B: the module owns the frame + image chunks it mapped; release
        // them now the replay is complete (parent path; a child mapped nothing).
        release_fork_chunks(st);
        Ok(())
    }

    fn begin_abort_impl() -> Result<(), Errno> {
        // Abort replay drives the exact same frames/journal as parent replay;
        // the only difference is the guest export the host calls
        // (wpk_fork_abort_begin vs wpk_fork_rewind_begin). Record the abort state
        // so finish_abort_impl can assert the pairing is honored.
        begin_replay_impl()?;
        let st = state().as_mut().ok_or(Errno::EINVAL)?;
        st.in_abort = true;
        Ok(())
    }

    fn finish_abort_impl() -> Result<(), Errno> {
        {
            let st = state().as_mut().ok_or(Errno::EINVAL)?;
            if !st.in_abort {
                // fm_finish_abort without a matching fm_begin_abort: loud, not silent.
                return Err(Errno::EINVAL);
            }
        }
        finish_replay_impl()?;
        if let Some(st) = state().as_mut() {
            st.in_abort = false;
        }
        Ok(())
    }

    /// Release every channel-mapped chunk WITHOUT requiring the replay to have
    /// finished (the abort path). Idempotent: draining leaves the allocators
    /// empty, so a later finish/abort maps nothing.
    fn abort_impl() -> Result<(), Errno> {
        if let Some(st) = state().as_mut() {
            release_fork_chunks(st);
            st.in_abort = false;
        }
        Ok(())
    }

    // -- Child replay seeding across the fork memory copy -------------------
    //
    // In a live fork the child inherits a COPY of the parent's guest linear
    // memory (including the linked-frame chunks the parent wrote) but runs a
    // FRESH module instance placed at a DIFFERENT `__memory_base`, whose journal
    // starts EMPTY. So the child's module cannot see the parent module's
    // in-memory journal. The parent therefore serializes its sealed journal as a
    // KFRE image into a freshly channel-mmap'd guest-memory chunk BEFORE the
    // fork (`fm_serialize_journal_alloc`); the host records that chunk's
    // `(ptr, len)` in a `JournalImage` KFMS record so the child, after the
    // memory copy, decodes the image from the inherited offset and seeds its own
    // journal + resume-slot table (`fm_begin_child_replay`). With Option B the
    // image no longer sits at a host-computed arena offset — the module mmaps it
    // on demand, exactly like the frame chunks — so the manifest record is how
    // the child finds it. This mirrors the JS path: `sealCapture` ->
    // `arena.appendReplayEvents(events)` (parent) and `attachChild` ->
    // `replayEventsForChild(records)` -> `events.attachChild` (child) in
    // `host/src/fork-process-continuation.ts`.

    fn serialize_journal_alloc_impl(channel_base: u64) -> Result<u64, Errno> {
        let st = state().as_mut().ok_or(Errno::EINVAL)?;
        // One syscall channel per worker; a disagreeing base is a host bug.
        if channel_base != st.channel_base {
            return Err(Errno::EINVAL);
        }
        // The journal must be sealed (post `fm_finish_unwind`) so the captured
        // events are complete and still capture-readable — exactly when JS
        // `sealCapture` serializes them.
        let image = encode_replay_events(st.journal.captured_events()?);
        let len = image.len() as u64;
        // Channel-mmap a page-rounded image chunk. This GROWS shared memory, so
        // the memory length MUST be re-derived AFTER the map before the copy.
        let capacity = len
            .checked_add(PAGE - 1)
            .ok_or(Errno::EINVAL)?
            / PAGE
            * PAGE;
        let capacity = capacity.max(PAGE);
        let addr = channel_mmap(channel_base, capacity)?;
        st.extra_chunks.push((addr, capacity));
        // Re-derive the length after the grow; a stale pre-grow length would
        // wrongly reject the freshly mapped high image chunk.
        let start = usize::try_from(addr).map_err(|_| Errno::EINVAL)?;
        let end = start.checked_add(image.len()).ok_or(Errno::EINVAL)?;
        if end > mem_len_bytes() {
            return Err(Errno::EINVAL); // image chunk past the end of guest memory
        }
        // Copy through raw pointers (never an exclusive whole-memory `&mut [u8]`,
        // which is `noalias` yet aliases the module-heap `image` and miscompiles
        // under release LLVM): source (module heap) and destination (the mapped
        // guest chunk) are distinct byte ranges.
        let dst = core::hint::black_box(start) as *mut u8;
        // SAFETY: `[start, end)` is within the just-mapped guest memory (checked
        // above); `image` is a distinct heap allocation. `copy` (memmove
        // semantics) tolerates any overlap defensively.
        unsafe {
            core::ptr::copy(image.as_ptr(), dst, image.len());
        }
        st.journal_image_ptr = addr;
        st.journal_image_len = len;
        Ok(addr)
    }

    /// The in-realm, no-servicer sibling of `serialize_journal_alloc_impl`:
    /// serialize the sealed journal as a KFRE image into a caller-owned FIXED
    /// region `[base, base + len)` instead of a channel-mmap'd chunk. Used by the
    /// in-process fixed-arena harness (`fm_begin_unwind_fixed_arena`), which has
    /// no host servicer for the blocking channel. The region is NOT recorded as
    /// an owned chunk (no `extra_chunks`), so finish/abort munmap nothing. Returns
    /// `base`; the byte length is read back via `fm_journal_image_len`.
    fn serialize_journal_fixed_arena_impl(base: u64, len: u64) -> Result<u64, Errno> {
        let st = state().as_mut().ok_or(Errno::EINVAL)?;
        let image = encode_replay_events(st.journal.captured_events()?);
        let image_len = image.len() as u64;
        if image_len > len {
            return Err(Errno::ENOMEM); // caller's region is too small for the image
        }
        let start = usize::try_from(base).map_err(|_| Errno::EINVAL)?;
        let end = start.checked_add(image.len()).ok_or(Errno::EINVAL)?;
        if end > mem_len_bytes() {
            return Err(Errno::EINVAL); // image region past the end of guest memory
        }
        // Distinct ranges: module heap `image` vs the caller-owned guest region.
        let dst = core::hint::black_box(start) as *mut u8;
        // SAFETY: `[start, end)` is within guest memory (checked); `image` is a
        // distinct heap allocation. `copy` (memmove) is defensive regardless.
        unsafe {
            core::ptr::copy(image.as_ptr(), dst, image.len());
        }
        st.journal_image_ptr = base;
        st.journal_image_len = image_len;
        Ok(base)
    }

    fn begin_child_replay_impl(
        module_buffer: u64,
        image_ptr: u64,
        image_len: u64,
    ) -> Result<(), Errno> {
        // Reclaim any prior state and heap before this COW child's replay. A
        // BORROWED (vfork) child must NOT do this (it shares the parked parent's
        // memory and its module instance is fresh + single-use), so the reclaim
        // lives here in the COW entry rather than in the shared builder.
        *state() = None;
        ALLOC.reset();

        let (module, activation_id) =
            build_child_replay_module(module_buffer, image_ptr, image_len)?;
        *state() = Some(module);
        PRIMARY_ACTIVATION.store(activation_id, Ordering::Relaxed);
        Ok(())
    }

    /// Seed a replay-only child `ForkModule` from the inherited journal image and
    /// a READ-ONLY rewind driver over the continuation at `module_buffer`, and
    /// return it together with the primary activation id — WITHOUT storing it,
    /// touching `PRIMARY_ACTIVATION`, or reclaiming the heap. Shared by the COW
    /// child (`begin_child_replay_impl`) and the vfork BORROWED child
    /// (`begin_borrowed_child_replay_impl`); the caller stores it and, for the
    /// borrowed path, first isolates its private module prefix. The built module
    /// owns NO chunks (arena `new_channel(0)`, empty `extra_chunks`,
    /// `channel_base == 0`), so its finish/abort munmaps nothing — the invariant a
    /// borrowed child depends on so it never unmaps the parent's live storage.
    fn build_child_replay_module(
        module_buffer: u64,
        image_ptr: u64,
        image_len: u64,
    ) -> Result<(ForkModule, u32), Errno> {
        // The format must have been seeded (once) on THIS fresh child instance,
        // exactly as the host seeds every process-worker instance.
        let fmt = format()?;

        // Decode the KFRE image the parent serialized, read from the child's
        // COPIED guest memory. Copy the image bytes out through raw pointers into
        // a module-heap buffer first: forming a `&[u8]` sub-slice of a
        // whole-guest-memory slice and decoding from it in-place miscompiles the
        // bounds checks under release LLVM (the same aliasing hazard the
        // serialize path avoids). `decode_replay_events_image` then reuses the D1
        // `decode_replay_events` codec — no framing logic is duplicated here.
        let start = usize::try_from(image_ptr).map_err(|_| Errno::EINVAL)?;
        let len = usize::try_from(image_len).map_err(|_| Errno::EINVAL)?;
        let end = start.checked_add(len).ok_or(Errno::EINVAL)?;
        if end > mem_len_bytes() {
            return Err(Errno::EINVAL); // image region past the end of guest memory
        }
        let mut image_bytes = alloc::vec![0u8; len];
        let src = core::hint::black_box(start) as *const u8;
        // SAFETY: `[start, end)` is within guest linear memory (checked above);
        // `image_bytes` is a distinct heap allocation of exactly `len` bytes.
        unsafe {
            core::ptr::copy(src, image_bytes.as_mut_ptr(), len);
        }
        let decoded = decode_replay_events_image(&image_bytes)?;

        // Choose the activation this call SEEDS (the main module). A
        // single-activation fork seeds its sole activation (byte-identical to
        // before this slice — the id may be any value, e.g. the harness's act 7).
        // A multi-activation (dlopen) fork seeds the MAIN module, activation 0,
        // and the host adds each side activation 1..N with
        // `fm_add_activation_child_replay`. An empty journal seeds activation 0.
        let activation_id = match decoded.activation_ids.len() {
            0 => 0, // empty journal: no frames to replay
            1 => *decoded.activation_ids.iter().next().ok_or(Errno::EINVAL)?,
            _ => {
                // Multi-activation: the main module (activation 0) anchors this
                // seed. Its absence is a malformed image, not a guessable anchor.
                if !decoded.activation_ids.contains(&0) {
                    return Err(Errno::EINVAL);
                }
                0
            }
        };

        // Seed the process-wide journal ONCE from ALL decoded events (every
        // activation, capture order); it will replay the exact global reverse,
        // in lockstep with each activation's frame chain. The events are already
        // tagged with their `activation_id`, so one image seeds N activations.
        let mut journal = ReplayEventJournal::new();
        journal.attach_child(&decoded.events)?;

        // This seed activation's committed ordinals (filter the decoded events).
        let committed_ordinals: Vec<u32> = decoded
            .events
            .iter()
            .filter(|event| event.activation_id == activation_id)
            .map(|event| event.function_ordinal)
            .collect();

        // Register the seed activation's resume slots by the parity precedence
        // (per-activation catalog -> global catalog -> distinct committed). For a
        // single-activation fork with no catalog this is byte-identical to the
        // previous distinct-decoded-ordinals numbering.
        let global = resume_catalog();
        let mut table = ResumeSlotTable::new();
        register_activation_slots(&mut table, activation_id, global, &committed_ordinals)?;

        // Attach the rewind driver to the continuation the parent published,
        // read from the COPIED arena at the same guest offset the child
        // inherited. The child mutates none of the guest frame memory.
        let driver = {
            let mem = unsafe { mem_ref() };
            RewindDriver::attach(mem, module_buffer, &fmt)?
        };

        // Seed the first activation into the activation-keyed map (replay-only).
        // Side activations are added by `fm_add_activation_child_replay` against
        // the SAME process-wide journal + table; the decoded events are retained
        // so each add can rebuild its own activation's committed ordinals.
        let mut activations = BTreeMap::new();
        activations.insert(
            activation_id,
            ActivationFrames {
                format: fmt,
                writer: LinkedFrameWriter::new(fmt),
                // A replay-only child mmaps nothing: `channel_base == 0` and the
                // `replay_only` guard rejects any reserve/commit, so `allocate`
                // is never called.
                arena: FrameArena::new_channel(0),
                driver: Some(driver),
                committed_ordinals,
                module_buffer,
                replay_only: true,
            },
        );
        let module = ForkModule {
            activations,
            channel_base: 0,
            extra_chunks: Vec::new(),
            journal_image_ptr: 0,
            journal_image_len: 0,
            journal,
            table,
            replay_events: decoded.events,
            in_abort: false,
        };
        Ok((module, activation_id))
    }

    // -- vfork BORROWED child replay (shares the parked parent's memory) -----
    //
    // A COW fork child inherits a private COPY of the parent's memory, so
    // `begin_child_replay_impl` may reclaim its heap and (harmlessly) own its
    // inherited chunks. A vfork BORROWED child instead runs a FRESH module
    // instance at a DISTINCT `__memory_base` inside the SAME shared memory as the
    // still-parked parent, whose fork-module instance, continuation storage, and
    // frame chunks are live there. So the borrowed child must:
    //   (i)   NOT reclaim the heap (its instance is fresh + single-use, and a
    //         reset is meaningless; the reclaim stays in the COW entry);
    //   (ii)  decode the journal image READ-ONLY (the shared builder already
    //         copies the image bytes out before decoding — no guest write);
    //   (iii) own NO chunks (the shared builder's `new_channel(0)` arena +
    //         `channel_base == 0` guarantee finish/abort munmap nothing);
    //   (iv)  write the guest's mutable fixed runtime prefix (whose offset-0 word
    //         is the active-frame pointer the guest rewind overwrites) into a
    //         CHILD-PRIVATE `private_prefix` region, copied from the parent's
    //         prefix at `module_buffer`, so the parked parent's prefix is never
    //         touched. The rewind driver still reads the BORROWED frame nodes at
    //         the parent's addresses (read-only), exactly as the JS
    //         `attachForBorrowedReplay` does.

    fn begin_borrowed_child_replay_impl(
        module_buffer: u64,
        image_ptr: u64,
        image_len: u64,
        private_prefix: u64,
    ) -> Result<(), Errno> {
        // (i) NO heap reclaim / no `*state() = None` reset here: this is a fresh,
        // single-use borrowed-child instance sharing the parent's memory.
        let (mut module, activation_id) =
            build_child_replay_module(module_buffer, image_ptr, image_len)?;

        // (iv) Isolate the child's mutable module prefix. Copy the parent's fixed
        // runtime prefix from `module_buffer` into the child-private
        // `private_prefix`, after proving the target is in range, aligned, and
        // does NOT overlap the borrowed continuation storage or the source
        // anchor. The guest's `wpk_fork_rewind_begin` is then handed
        // `private_prefix`, so every active-frame-pointer write lands in private
        // scratch, never the parked parent's prefix.
        let fixed_prefix = module
            .activations
            .get(&activation_id)
            .ok_or(Errno::EINVAL)?
            .format
            .fixed_prefix_size as u64;
        copy_borrowed_child_prefix(&module, activation_id, module_buffer, private_prefix, fixed_prefix)?;

        *state() = Some(module);
        PRIMARY_ACTIVATION.store(activation_id, Ordering::Relaxed);
        Ok(())
    }

    /// Validate and copy the parent's fixed runtime prefix from `source`
    /// (`module_buffer`) into the child-private `target` (`private_prefix`), the
    /// module equivalent of `attachForBorrowedReplay`'s prefix copy. Both regions
    /// live in the shared guest memory; the copy goes through raw pointers (never
    /// an exclusive whole-memory `&mut [u8]`, which would `noalias`-miscompile),
    /// and the ranges are proven distinct first, so a bad `private_prefix` fails
    /// truthfully instead of corrupting the parked parent.
    fn copy_borrowed_child_prefix(
        module: &ForkModule,
        activation_id: u32,
        source: u64,
        target: u64,
        len: u64,
    ) -> Result<(), Errno> {
        if len == 0 {
            return Err(Errno::EINVAL); // a borrowed child always has a runtime prefix
        }
        let act = module.activations.get(&activation_id).ok_or(Errno::EINVAL)?;
        let driver = act.driver.as_ref().ok_or(Errno::EINVAL)?;
        let alignment = abi::WPK_FORK_LINKED_FRAME_RECORD_ALIGNMENT as u64;
        if alignment == 0 || target == 0 || target % alignment != 0 {
            return Err(Errno::EINVAL); // target must be nonzero + prefix-aligned
        }
        let src_end = source.checked_add(len).ok_or(Errno::EINVAL)?;
        let tgt_end = target.checked_add(len).ok_or(Errno::EINVAL)?;
        let mem_len = mem_len_bytes() as u64;
        if src_end > mem_len || tgt_end > mem_len {
            return Err(Errno::EINVAL); // either range escapes guest memory
        }
        // The private prefix must not alias the borrowed continuation storage or
        // the parent's prefix source (which includes `module_buffer`).
        if driver.borrowed_prefix_conflicts(target, len)? {
            return Err(Errno::EINVAL);
        }
        let src = usize::try_from(source).map_err(|_| Errno::EINVAL)?;
        let dst = usize::try_from(target).map_err(|_| Errno::EINVAL)?;
        // SAFETY: `[source, source+len)` and `[target, target+len)` are both
        // within guest memory (checked above) and proven non-overlapping by the
        // conflict guard; `copy` (memmove semantics) is defensive regardless.
        unsafe {
            let src_ptr = core::hint::black_box(src) as *const u8;
            let dst_ptr = core::hint::black_box(dst) as *mut u8;
            core::ptr::copy(src_ptr, dst_ptr, len as usize);
        }
        Ok(())
    }

    /// Add a dlopen-vfork ("mode-1") SIDE activation to a BORROWED child replay
    /// begun by `fm_begin_borrowed_child_replay` (Phase 6 item 4). The direct
    /// borrowed sibling of `add_activation_child_replay_impl`: it attaches a
    /// READ-ONLY rewind driver over the PARENT's borrowed continuation at
    /// `module_buffer` and rebuilds this activation's committed ordinals + resume
    /// slots exactly the same way, but additionally copies THIS activation's fixed
    /// runtime prefix into its own child-private `private_prefix` region (so the
    /// guest's per-activation rewind writes its active-frame pointer there, never
    /// the parked parent's prefix). Owns no chunks, so finish/abort release
    /// nothing. `module_buffer` is the side's borrowed anchor; `fixed_prefix` its
    /// own runtime-prefix size.
    fn add_activation_borrowed_child_replay_impl(
        activation_id: u32,
        module_buffer: u64,
        fixed_prefix: u32,
        private_prefix: u64,
    ) -> Result<(), Errno> {
        let base = format()?;
        let fmt = LinkedFrameFormat {
            fixed_prefix_size: fixed_prefix,
            ..base
        };
        let st = state().as_mut().ok_or(Errno::EINVAL)?;
        if st.activations.contains_key(&activation_id) {
            return Err(Errno::EINVAL); // activation already seeded in this child
        }
        let committed_ordinals: Vec<u32> = st
            .replay_events
            .iter()
            .filter(|event| event.activation_id == activation_id)
            .map(|event| event.function_ordinal)
            .collect();
        // Attach the READ-ONLY driver to the parent's BORROWED continuation at
        // this side's inherited anchor, then register its resume slots.
        let mem = unsafe { mem_ref() };
        let driver = RewindDriver::attach(mem, module_buffer, &fmt)?;
        let global = resume_catalog();
        register_activation_slots(&mut st.table, activation_id, global, &committed_ordinals)?;
        st.activations.insert(
            activation_id,
            ActivationFrames {
                format: fmt,
                writer: LinkedFrameWriter::new(fmt),
                // Borrowed side activation: mmaps nothing, releases nothing.
                arena: FrameArena::new_channel(0),
                driver: Some(driver),
                committed_ordinals,
                module_buffer,
                replay_only: true,
            },
        );
        // Isolate this side's mutable prefix into its child-private region (the
        // per-activation mirror of the primary borrowed path); validates the
        // target is in range, aligned, and non-overlapping before copying.
        copy_borrowed_child_prefix(
            st,
            activation_id,
            module_buffer,
            private_prefix,
            fixed_prefix as u64,
        )?;
        Ok(())
    }

    /// Add ANOTHER activation (a dlopen fork's side module) to the child replay
    /// begun by `fm_begin_child_replay` (Phase 6 D7a.1a). `activation_id` is the
    /// side activation (must not already be seeded); `module_buffer` is ITS
    /// continuation anchor, inherited at the same guest offset via the fork
    /// memory copy; `fixed_prefix` is ITS own module-buffer fixed runtime prefix.
    /// (Side modules carry their own prefix — the direct child-side mirror of
    /// `fm_add_activation_unwind`'s `fixed_prefix` — and the rewind decode needs
    /// it to locate the root chunk's first node; the journal image does not carry
    /// it, so the host supplies it.) The process-wide journal is NOT reseeded:
    /// this attaches the activation's replay-only frame state, rebuilds its
    /// committed ordinals from the retained decoded events (filtered by
    /// `activation_id`), and registers its resume slots against the SAME table.
    fn add_activation_child_replay_impl(
        activation_id: u32,
        module_buffer: u64,
        fixed_prefix: u32,
    ) -> Result<(), Errno> {
        // Derive this activation's format from the seeded pointer width plus its
        // own fixed prefix (shared pointer width, per-activation prefix), exactly
        // as the parent's `add_activation_unwind_impl` does.
        let base = format()?;
        let fmt = LinkedFrameFormat {
            fixed_prefix_size: fixed_prefix,
            ..base
        };

        // Rebuild this activation's committed ordinals from the retained decoded
        // events BEFORE taking the mutable field borrows below (the immutable
        // borrow of `replay_events` ends once collected into an owned `Vec`).
        let st = state().as_mut().ok_or(Errno::EINVAL)?;
        if st.activations.contains_key(&activation_id) {
            return Err(Errno::EINVAL); // activation already seeded in this child
        }
        let committed_ordinals: Vec<u32> = st
            .replay_events
            .iter()
            .filter(|event| event.activation_id == activation_id)
            .map(|event| event.function_ordinal)
            .collect();

        // Attach the rewind driver to the COPIED continuation at its inherited
        // anchor, then register the activation's resume slots on the SAME table.
        let mem = unsafe { mem_ref() };
        let driver = RewindDriver::attach(mem, module_buffer, &fmt)?;
        let global = resume_catalog();
        register_activation_slots(&mut st.table, activation_id, global, &committed_ordinals)?;

        st.activations.insert(
            activation_id,
            ActivationFrames {
                format: fmt,
                writer: LinkedFrameWriter::new(fmt),
                // Replay-only side activation: mmaps nothing (see the primary).
                arena: FrameArena::new_channel(0),
                driver: Some(driver),
                committed_ordinals,
                module_buffer,
                replay_only: true,
            },
        );
        Ok(())
    }

    // -- Reference reconstruction impls (Phase 6 D6.1) ----------------------

    /// Decode the funcref/null reference graph for this fork from the KFMS
    /// module-state arena rooted at `module_state_root` (inherited via the fork
    /// memory copy, same as `fm_begin_child_replay`'s frame arena), and seed the
    /// reference-replay driver. Reuses the D6.0 live decode
    /// (`decode_segmented_reference_transaction`) over the arena's reference
    /// records; no framing logic is duplicated here.
    ///
    /// D6.1 admits FUNCREF + NULL only, from a SINGLE activation (one imported
    /// catalog table). A graph with any other kind, or funcrefs spanning more
    /// than one activation, is a truthful `EOPNOTSUPP` — the host predicate keeps
    /// such a fork on the JS path, and this re-check means a disagreeing host can
    /// never drive an unsupported reference through the funcref import.
    // `pid` (the child process image) is retained in the export signature for the
    // host call site's contract, but M2 no longer opens a host root generation
    // scoped by it — the externref host seam retired (see `ReconstructionState`'s
    // doc) — so it is unused inside this impl.
    /// Decode a sealed module-state (KFMS) arena rooted at `module_state_root`
    /// from the COPIED guest memory into the canonical reference transaction.
    ///
    /// This is the arena->records->transaction path shared by
    /// `fm_begin_reference_replay` (the guest-driven replay) and
    /// `fm_decode_reference_graph` / `fm_restore_from_arena` (the module-owned
    /// orchestration entries). It uses the IMMUTABLE whole-memory view (reads
    /// only, so the release-LLVM `&mut`-noalias miscompile the serialize/child
    /// paths avoid does not apply), lifts each module-state record's payload into
    /// a borrowed `ReferenceTransactionRecord`, and reuses the D6.0 transaction
    /// decode. The pointer width was seeded once (with the linked-frame format)
    /// via `fm_set_format`; not seeding it yet is a truthful `EINVAL`, never a
    /// guessed geometry.
    fn decode_reference_transaction_from_arena(
        module_state_root: u64,
    ) -> Result<SegmentedReferenceTransaction, Errno> {
        let pw = FMT_POINTER_WIDTH.load(Ordering::Relaxed);
        if pw == 0 {
            return Err(Errno::EINVAL);
        }
        let chunk_header_size =
            abi::wpk_fork_module_state_chunk_header_size(pw as u8).ok_or(Errno::EINVAL)?;
        let fmt = ModuleStateFormat {
            pointer_width: pw as u8,
            chunk_header_size,
        };
        let mem = unsafe { mem_ref() };
        let module_state = decode_module_state(mem, module_state_root, &fmt)?;
        let mut records: Vec<ReferenceTransactionRecord> =
            Vec::with_capacity(module_state.records.len());
        for record in &module_state.records {
            let start = usize::try_from(record.payload_offset).map_err(|_| Errno::EINVAL)?;
            let size = usize::try_from(record.payload_size).map_err(|_| Errno::EINVAL)?;
            let end = start.checked_add(size).ok_or(Errno::EINVAL)?;
            let payload = mem.get(start..end).ok_or(Errno::EINVAL)?;
            records.push(ReferenceTransactionRecord {
                kind: record.kind,
                activation_id: record.activation_id,
                owner_id: record.owner_id,
                payload,
            });
        }
        decode_segmented_reference_transaction(&records, abi::WPK_FORK_REFERENCE_TRANSACTION_OWNER)
    }

    fn begin_reference_replay_impl(module_state_root: u64, _pid: u32) -> Result<(), Errno> {
        // Reclaim any prior fork's reference state.
        *reference_state() = None;
        *reconstruction_state() = None;
        *reference_feed() = None;

        // Decode the sealed module-state arena into the canonical transaction
        // (shared arena->transaction path; see the helper).
        let transaction = decode_reference_transaction_from_arena(module_state_root)?;
        // Seed the RESTORE data-feed (Phase 6 item 3a) from the SAME decoded
        // transaction before it moves into the driver: the feed reproduces the JS
        // provider's mutable replay state (the reference-vector overlay + intern
        // index + GC-vector cache + exnref cache-index map) that the guest codec
        // reads through the flipped `fm_ref_*` imports.
        let feed = ReferenceReplayFeed::new(&transaction);
        let driver = ReferenceReplayDriver::new(transaction);

        // Module-admissibility gate (defense in depth; the host computes the same
        // predicate, plus a GC-descriptor validity check only the host can see).
        // Admits null/funcref/externref/exnref, typed GC (struct / array / i31),
        // and static-root — the whole reference kind set the module reconstructs.
        // Admitting typed GC adds NO new engine-floor callback and moves NO
        // drive-order into the module: the fork side module is instantiated BEFORE
        // the guest exists, so it cannot import the guest's `_gc_allocate`/
        // `_gc_fill` exports; the PROVEN JS drive-order (reproduced by
        // `build_drive_plan`) keeps the topological allocate/fill walk plus
        // cycle-breaking and aliases. The module's only GC job is leaf identity +
        // transit rooting — a `DRIVE_OP_EXTERNREF_TRANSIT` step (`fm_build_gc_plan`
        // / `build_drive_plan`, Phase 0) roots every struct/array-reachable
        // externref leaf (`transit_rooted_recipes` seeds from Struct/Array edges)
        // with the non-null R1 assert, both wasm (`fm_externref_handle` +
        // `resolve_externref` + `any.convert_extern` + `table.set`, injected in
        // Task 3) — no host seam beyond the single `resolve_externref` import, and
        // i31 is a scalar leaf. A static-root is published into the anyref transit
        // by a DRIVE_OP_STATIC_ROOT step (`table.get` catalog + `table.set`
        // transit, both wasm) — no host seam. An unadmitted kind is a truthful
        // `EOPNOTSUPP` that keeps the fork on the JS path.
        if !driver.all_nodes_module_admissible() {
            return Err(Errno::EOPNOTSUPP);
        }
        // Phase 6 D7a.1b: funcrefs may now span MULTIPLE activations — each
        // resolves against the MERGED, activation-namespaced catalog. Every
        // funcref's activation must therefore have a seeded catalog base, UNLESS
        // the host seeded NO base at all (a single-activation worker, which keeps
        // the byte-identical base-0 mapping). A funcref naming an un-seeded
        // activation in a multi-activation worker is a truthful `EOPNOTSUPP` (the
        // host keeps that fork on the JS reference path), never a silent read
        // against slot 0 / the wrong activation's catalog.
        if !func_catalog_base_map_empty() {
            for activation_id in driver.funcref_activations() {
                if func_catalog_base(activation_id).is_none() {
                    return Err(Errno::EOPNOTSUPP);
                }
            }
        }
        // Static-root binder: every static-root activation must have a seeded
        // merged-catalog base UNLESS the host seeded none at all (a
        // single-activation worker keeps the byte-identical base-0 mapping). A
        // static-root naming an un-seeded activation in a multi-activation worker
        // is a truthful `EOPNOTSUPP` (the host keeps that fork on the JS reference
        // path), never a silent read against the wrong catalog slice.
        if !static_root_catalog_base_map_empty() {
            for activation_id in driver.static_root_activations() {
                if static_root_catalog_base(activation_id).is_none() {
                    return Err(Errno::EOPNOTSUPP);
                }
            }
        }

        // Bookkeeping pass (M2): count the externref nodes this fork's graph
        // reconstructs. This is now a host-free pass over the decoded graph — it
        // calls no `wpk_fork_host` import and opens no host generation (that seam
        // retired; see `ReconstructionState`'s doc). The actual resolve + transit
        // publish happen later, in injected wasm: EVERY externref recipe —
        // directly held (frame-vector-only) and GC/exnref-reachable alike — is
        // published into the anyref transit by a `DRIVE_OP_EXTERNREF_TRANSIT`
        // drive step (via
        // `fm_externref_handle`), both driven by the injected `fm_drive_execute`
        // shim (Task 3), not by this function.
        let reconstruction = driver.drive_reconstruction()?;
        EXTERNREFS_RESOLVED.fetch_add(reconstruction.reconstructed() as u64, Ordering::Relaxed);
        // D6.3a proof-of-use: the drive's Exnref arm is inert (the guest export
        // materializes the exception), so count the admitted exnref nodes here.
        EXNREFS_RECONSTRUCTED.fetch_add(driver.exnref_node_count() as u64, Ordering::Relaxed);
        // D6.4a proof-of-use: the Struct/Array/I31 arms are inert (the guest drives
        // the GC allocate/fill under the JS order), so count the admitted typed-GC
        // nodes here. The struct/array-reachable externref leaves are rooted via
        // the same PHASE B transit path (`EXTERNREFS_RESOLVED` also advances).
        GC_NODES_RECONSTRUCTED.fetch_add(driver.gc_node_count() as u64, Ordering::Relaxed);

        *reference_state() = Some(driver);
        *reconstruction_state() = Some(reconstruction);
        *reference_feed() = Some(feed);
        Ok(())
    }

    // -- Module-owned wire-graph decode / scan / restore impls (orchestration
    //    migration increment 1) -------------------------------------------------

    /// Decode the sealed KFMS arena rooted at `module_state_root` into the
    /// module-owned decoded graph and return its node count (`>= 0`). Reuses the
    /// SAME shared arena decode as `fm_begin_reference_replay`; unlike replay it
    /// seeds NO driver/feed — it only makes the decoded graph resident for
    /// `fm_scan_externref_handles` and host inspection. Reclaims any prior graph.
    fn decode_reference_graph_impl(module_state_root: u64) -> Result<u32, Errno> {
        *decoded_graph() = None;
        let transaction = decode_reference_transaction_from_arena(module_state_root)?;
        let node_count = u32::try_from(transaction.nodes.len()).map_err(|_| Errno::EINVAL)?;
        *decoded_graph() = Some(transaction);
        REFERENCE_GRAPHS_DECODED.fetch_add(1, Ordering::Relaxed);
        Ok(node_count)
    }

    /// Scan the resident decoded graph for its DISTINCT externref broker handles
    /// (first-seen order, deduped exactly like the JS `Set`), write them as a
    /// little-endian `u32` array into guest memory at `dst_ptr`, and return the
    /// count. `dst_cap` is the caller-provided capacity in u32 ELEMENTS (size it
    /// from the decoded node count, an upper bound). A count that would overflow
    /// `dst_cap`, or no resident decoded graph, is a truthful `EINVAL` — never a
    /// partial or fabricated scan.
    fn scan_externref_handles_impl(dst_ptr: usize, dst_cap: usize) -> Result<u32, Errno> {
        let transaction = decoded_graph().as_ref().ok_or(Errno::EINVAL)?;
        let mut handles: Vec<u32> = Vec::new();
        for entry in &transaction.nodes {
            if let ReferenceRecipeNode::Externref { handle } = entry.node {
                if !handles.contains(&handle) {
                    handles.push(handle);
                }
            }
        }
        if handles.len() > dst_cap {
            return Err(Errno::EINVAL);
        }
        let byte_len = handles.len().checked_mul(4).ok_or(Errno::EINVAL)?;
        if byte_len != 0 {
            let end = dst_ptr.checked_add(byte_len).ok_or(Errno::EINVAL)?;
            if end > mem_len_bytes() {
                return Err(Errno::EINVAL); // span past the end of guest memory
            }
            // SAFETY: `[dst_ptr, dst_ptr+byte_len)` is within guest linear memory
            // (checked above); the source is a distinct local `Vec`. Absolute
            // guest-offset writes through an opaque-zero base, the same
            // guest-offset-as-pointer idiom the frame/channel paths use.
            let mut cursor = dst_ptr;
            for handle in &handles {
                unsafe {
                    let ptr = core::hint::black_box(cursor) as *mut u8;
                    core::ptr::copy_nonoverlapping(handle.to_le_bytes().as_ptr(), ptr, 4);
                }
                cursor += 4;
            }
        }
        let count = u32::try_from(handles.len()).map_err(|_| Errno::EINVAL)?;
        EXTERNREF_HANDLES_SCANNED.fetch_add(count as u64, Ordering::Relaxed);
        Ok(count)
    }

    /// Seed the reference replay driver/feed from the KFMS arena rooted at
    /// `module_state_root` AND build the whole topological drive plan in ONE
    /// module call, returning the plan's guest address (the `plan_ptr` argument
    /// for the injected `fm_drive_execute` shim; the step count is
    /// `fm_gc_plan_count`). This is the replay-orchestration ENTRY: it collapses
    /// the JS `beginReferenceReplay` + `restoreModuleState`/`materializeAllTyped`
    /// wrapper — which sized transit and sequenced the drive host-side, looping
    /// leaf drives — into the module, so the module now owns seeding + drive-order
    /// construction and the host issues a SINGLE `fm_drive_execute(plan, count)`.
    /// GC graphs still require each participating activation's
    /// `fm_set_activation_gc_codec` to have run first, exactly as
    /// `fm_build_gc_plan` does today; an un-seeded GC activation, a malformed
    /// arena, or an unadmitted reference kind (`EOPNOTSUPP`, host keeps the JS
    /// path) is a truthful failure, never a wrong plan.
    fn restore_from_arena_impl(module_state_root: u64, pid: u32) -> Result<usize, Errno> {
        begin_reference_replay_impl(module_state_root, pid)?;
        build_gc_plan_impl(pid)
    }

    /// The full ordered activation set of the fork, decoded from the inherited
    /// KFMS arena's `Module` records (kind 1) — one per activation, even for an
    /// activation that carries no references. Sorted + deduped so the child-install
    /// restore/finish steps run in a deterministic per-activation order matching
    /// the host's sorted activation binding. This is the module-owned equivalent of
    /// the JS `records.filter(kind === Module).map(activationId)` the registry
    /// validates the fresh child against.
    fn arena_module_activations(module_state_root: u64) -> Result<Vec<u32>, Errno> {
        let pw = FMT_POINTER_WIDTH.load(Ordering::Relaxed);
        if pw == 0 {
            return Err(Errno::EINVAL);
        }
        let chunk_header_size =
            abi::wpk_fork_module_state_chunk_header_size(pw as u8).ok_or(Errno::EINVAL)?;
        let fmt = ModuleStateFormat {
            pointer_width: pw as u8,
            chunk_header_size,
        };
        let mem = unsafe { mem_ref() };
        let module_state = decode_module_state(mem, module_state_root, &fmt)?;
        let mut activations: Vec<u32> = module_state
            .records
            .iter()
            .filter(|record| record.kind == abi::WPK_FORK_MODULE_STATE_RECORD_KIND_MODULE)
            .map(|record| record.activation_id)
            .collect();
        activations.sort_unstable();
        activations.dedup();
        if activations.is_empty() {
            // A sealed child arena always carries at least activation 0's Module
            // record; none means a corrupt/empty arena, not a valid no-op.
            return Err(Errno::EINVAL);
        }
        Ok(activations)
    }

    /// Child-install ENTRY (the module-owned `fm_attach_child` /
    /// `fm_attach_borrowed_child`). Seeds the reference replay driver/feed AND
    /// builds ONE drive plan that first reconstructs the reference graph
    /// (Phase 0/0b/3/4/5, identical to `restore_from_arena_impl`) and THEN — as the
    /// child-install tail — drives every activation's guest
    /// `wpk_fork_module_state_restore` and `wpk_fork_module_state_finish_restore`
    /// through the host-bound drive table (`append_attach_steps`). This moves the
    /// JS `ForkActivationRegistry.restoreModuleState` two-phase install SEQUENCING
    /// into the module: the guest's own layout-specific restore exports still place
    /// the reconstructed identities into the live child (only the guest knows its
    /// global/table layout), but the ORDER and DRIVE are now module-owned. Returns
    /// the plan's guest address; the step count is read from `fm_gc_plan_count`.
    ///
    /// The COW (`fm_attach_child`) and vfork borrowed (`fm_attach_borrowed_child`)
    /// children share this identical install plan: the only borrowed-specific work
    /// is the host-side child-private replay-prefix reservation (raw memory floor,
    /// no reference values), so both entries delegate here.
    fn attach_from_arena_impl(module_state_root: u64, pid: u32) -> Result<usize, Errno> {
        begin_reference_replay_impl(module_state_root, pid)?;
        let mut steps = build_reconstruction_steps()?;
        let activations = arena_module_activations(module_state_root)?;
        drive_plan::append_attach_steps(&mut steps, &activations);
        serialize_and_store_plan(&steps)
    }

    // -- Reference RESTORE data-feed helpers (Phase 6 item 3a) ---------------
    //
    // Each helper borrows the immutable transaction from the resident driver and
    // the mutable feed from its own cell (two disjoint statics -> no aliasing),
    // then delegates to the field-for-field port in `fork_codec::reference_feed`.
    // On the `Err` the JS provider body would have THROWN, the export TRAPS
    // (`wasm_intr::unreachable`), exactly as `fm_funcref_ordinal` does: the host
    // gate keeps an unadmitted/corrupt graph on the JS reference path, so an Err
    // here is corruption, never a value the guest codec should read. The
    // legitimate routing sentinels (`0` for i31, `-1` for a mismatch) are `Ok`
    // and returned as-is.

    /// The resident transaction (from the driver) and mutable feed, or a trap if
    /// `fm_begin_reference_replay` did not seed them.
    #[allow(clippy::mut_from_ref)]
    fn feed_and_transaction()
    -> (&'static ReferenceReplayFeed, &'static fork_codec::SegmentedReferenceTransaction) {
        let transaction = match reference_state().as_ref() {
            Some(driver) => driver.transaction(),
            None => wasm_intr::unreachable(),
        };
        let feed = match reference_feed().as_ref() {
            Some(feed) => feed,
            None => wasm_intr::unreachable(),
        };
        (feed, transaction)
    }

    fn feed_read<T>(result: Result<T, Errno>) -> T {
        match result {
            Ok(value) => {
                REFERENCE_FEED_READS.fetch_add(1, Ordering::Relaxed);
                value
            }
            Err(_) => wasm_intr::unreachable(),
        }
    }

    fn ref_vector_get_impl(ordinal: u32, index: u32) -> i32 {
        let (feed, transaction) = feed_and_transaction();
        feed_read(feed.vector_get(transaction, ordinal, index))
    }

    fn ref_gc_route_impl(recipe_id: u32, expected_activation: u32) -> i32 {
        let (feed, transaction) = feed_and_transaction();
        feed_read(feed.gc_route(transaction, recipe_id, expected_activation))
    }

    fn ref_gc_payload_len_impl(recipe_id: u32, expected_activation: u32, expected_layout_id: u32) -> i32 {
        let (feed, transaction) = feed_and_transaction();
        feed_read(feed.gc_payload_len(transaction, recipe_id, expected_activation, expected_layout_id))
    }

    #[allow(clippy::too_many_arguments)]
    fn ref_gc_load_impl(
        recipe_id: u32,
        module_activation: u32,
        type_ordinal: u32,
        layout_id: u32,
        kind: u32,
        scalar_destination: usize,
        scalar_byte_length: u32,
    ) -> i32 {
        // The mutable feed and read-only transaction come from disjoint statics;
        // `mem_mut` is the guest linear-memory data plane the writer path uses
        // (frame writes above module data), so the scalar destination never
        // overlaps the module's BSS-resident feed/transaction.
        let transaction = match reference_state().as_ref() {
            Some(driver) => driver.transaction(),
            None => wasm_intr::unreachable(),
        };
        let feed = match reference_feed().as_mut() {
            Some(feed) => feed,
            None => wasm_intr::unreachable(),
        };
        let mem = unsafe { mem_mut() };
        feed_read(feed.gc_load(
            transaction,
            mem,
            recipe_id,
            module_activation,
            type_ordinal,
            layout_id,
            kind,
            scalar_destination,
            scalar_byte_length,
        ))
    }

    fn ref_exn_route_impl(recipe_id: u32, expected_activation: u32) -> i32 {
        let (feed, transaction) = feed_and_transaction();
        feed_read(feed.exn_route(transaction, recipe_id, expected_activation))
    }

    #[allow(clippy::too_many_arguments)]
    fn ref_exn_load_impl(
        recipe_id: u32,
        module_activation: u32,
        tag_ordinal: u32,
        layout_id: u32,
        scalar_destination: usize,
        scalar_byte_length: u32,
        reference_ids_destination: usize,
        reference_count: u32,
    ) -> i32 {
        let (feed, transaction) = feed_and_transaction();
        let mem = unsafe { mem_mut() };
        feed_read(feed.exn_load(
            transaction,
            mem,
            recipe_id,
            module_activation,
            tag_ordinal,
            layout_id,
            scalar_destination,
            scalar_byte_length,
            reference_ids_destination,
            reference_count,
        ))
    }

    fn ref_exn_cache_index_impl(recipe_id: u32) -> i32 {
        let (feed, transaction) = feed_and_transaction();
        feed_read(feed.exn_cache_index(transaction, recipe_id))
    }

    /// Resolve a funcref recipe to a catalog ordinal for the injected shim.
    /// Returns a NON-NEGATIVE catalog ordinal for a Funcref, `NULL_ORDINAL` for
    /// the canonical Null reference, and TRAPS on any inconsistency (missing
    /// reference state, out-of-range recipe, non-funcref kind, or an ordinal that
    /// does not fit `i32`). Every success bumps `REFERENCES_RECONSTRUCTED`.
    fn funcref_ordinal_impl(recipe_id: u32) -> i32 {
        let driver = match reference_state().as_ref() {
            Some(driver) => driver,
            None => wasm_intr::unreachable(),
        };
        match driver.funcref_node(recipe_id) {
            Ok(None) => {
                REFERENCES_RECONSTRUCTED.fetch_add(1, Ordering::Relaxed);
                NULL_ORDINAL
            }
            Ok(Some(target)) => {
                // Merged-catalog GLOBAL slot: `base(module_activation) +
                // function_ordinal`. The base map is EMPTY for a single-activation
                // worker, so `base` defaults to 0 and the mapping is the
                // byte-identical D6.1 raw ordinal. A NON-empty map missing this
                // funcref's activation is corruption — the host gate seeds a base
                // for every funcref activation before replay — so it TRAPS rather
                // than read slot 0 / the wrong activation's catalog.
                let base = match func_catalog_base(target.module_activation) {
                    Some(base) => base,
                    None if func_catalog_base_map_empty() => 0,
                    None => wasm_intr::unreachable(),
                };
                let slot = match base.checked_add(target.function_ordinal) {
                    Some(slot) => slot,
                    None => wasm_intr::unreachable(),
                };
                match i32::try_from(slot) {
                    Ok(ordinal) if ordinal >= 0 => {
                        REFERENCES_RECONSTRUCTED.fetch_add(1, Ordering::Relaxed);
                        ordinal
                    }
                    // A global slot that does not fit a non-negative i32 cannot
                    // index the imported funcref table — a corrupt graph, not a
                    // value.
                    _ => wasm_intr::unreachable(),
                }
            }
            // Out-of-range recipe or a kind D6.1 does not admit: the host gate
            // should have kept this fork on JS, so reaching here is corruption.
            Err(_) => wasm_intr::unreachable(),
        }
    }

    /// Resolve a static-root recipe id to a merged anyref-catalog index for the
    /// injected drive shim (the static-root binder). Returns a NON-NEGATIVE global
    /// slot `base(module_activation) + static_root_ordinal` for the shim to
    /// `table.get(static_root_catalog)` and publish into the transit, and TRAPS on
    /// any inconsistency (missing reference state, out-of-range recipe, a
    /// non-static-root kind, an un-seeded activation in a multi-activation worker,
    /// or a slot that does not fit `i32`). Every success bumps
    /// `STATIC_ROOTS_PUBLISHED`. Mirrors `funcref_ordinal_impl`.
    fn static_root_slot_impl(recipe_id: u32) -> i32 {
        let driver = match reference_state().as_ref() {
            Some(driver) => driver,
            None => wasm_intr::unreachable(),
        };
        let target = match driver.static_root_node(recipe_id) {
            Ok(target) => target,
            // Out-of-range recipe or a non-static-root kind: the host gate should
            // have kept this off the static-root step, so reaching here is
            // corruption, never a value.
            Err(_) => wasm_intr::unreachable(),
        };
        // Merged-catalog GLOBAL slot: `base(module_activation) +
        // static_root_ordinal`. The base map is EMPTY for a single-activation
        // worker, so `base` defaults to 0 (byte-identical raw-ordinal mapping). A
        // NON-empty map missing this static root's activation is corruption — the
        // host gate seeds a base for every static-root activation before replay —
        // so it TRAPS rather than read slot 0 / the wrong activation's catalog.
        let base = match static_root_catalog_base(target.module_activation) {
            Some(base) => base,
            None if static_root_catalog_base_map_empty() => 0,
            None => wasm_intr::unreachable(),
        };
        let slot = match base.checked_add(target.static_root_ordinal) {
            Some(slot) => slot,
            None => wasm_intr::unreachable(),
        };
        match i32::try_from(slot) {
            Ok(index) if index >= 0 => {
                STATIC_ROOTS_PUBLISHED.fetch_add(1, Ordering::Relaxed);
                index
            }
            // A global slot that does not fit a non-negative i32 cannot index the
            // imported anyref catalog table — a corrupt graph, not a value.
            _ => wasm_intr::unreachable(),
        }
    }

    /// Resolve an externref recipe id to its captured broker handle (M2 — the
    /// externref host seam shrunk to a single `resolve_externref(handle) ->
    /// externref` import). This is NOT a guest-facing import: it is the helper
    /// the injected `fm_drive_execute` shim calls on a DRIVE_OP_EXTERNREF_TRANSIT
    /// step — emitted for EVERY externref recipe, directly held and
    /// GC/exnref-reachable alike, since the 2026-09-05 substrate fix — to get
    /// the `u32` handle it passes to the host `resolve_externref` import — a
    /// Rust function cannot itself return an
    /// `externref`, exactly why `fm_funcref_ordinal`/`fm_static_root_slot` hand
    /// back an index rather than a `funcref`/`anyref`. Returns the recipe's
    /// captured broker handle (the same handle a live host-import adapter minted
    /// into the broker before the fork) and TRAPS on any inconsistency (missing
    /// reference state, out-of-range recipe, a non-externref kind, or a handle
    /// that does not fit a non-negative `i32`) — the host gate should have kept an
    /// unadmitted/corrupt graph off the module path, so reaching here is
    /// corruption, never a value the shim should resolve. Mirrors
    /// `funcref_ordinal_impl`/`static_root_slot_impl`.
    fn externref_handle_impl(recipe_id: u32) -> i32 {
        let driver = match reference_state().as_ref() {
            Some(driver) => driver,
            None => wasm_intr::unreachable(),
        };
        let entry = match driver.transaction().nodes.get(recipe_id as usize) {
            // The decoder guarantees canonical id == index; assert it so a corrupt
            // graph reaching here is a loud failure, not a silent mis-resolution.
            Some(entry) if entry.id == recipe_id => entry,
            _ => wasm_intr::unreachable(),
        };
        let handle = match entry.node {
            ReferenceRecipeNode::Externref { handle } => handle,
            // Out-of-range recipe or a non-externref kind: the host gate should
            // have kept this off the externref-transit step, so reaching here is
            // corruption, never a value.
            _ => wasm_intr::unreachable(),
        };
        match i32::try_from(handle) {
            Ok(value) if value >= 0 => value,
            // A handle that does not fit a non-negative i32 cannot cross the
            // `resolve_externref` import boundary as this ABI defines it — a
            // corrupt graph, not a value.
            _ => wasm_intr::unreachable(),
        }
    }

    // -- Guest-facing exports (signatures == WPK_FORK_REQUIRED_IMPORTS) ------
    //
    // These FROZEN, activation-less names are the single-activation path: they
    // route to the fork's `primary_activation`. A multi-activation (dlopen) guest
    // instead reaches its per-activation frame state through a per-activation
    // TRAMPOLINE that folds in the activation id and calls the shared
    // `fm_frame_*(act, ...)` exports below — so these exports are unchanged and
    // no guest re-instrumentation is required.

    /// `__wpk_fork_frame_reserve(size) -> payload`. Reserve the next frame node
    /// and return its payload pointer (0 on failure; check `fm_last_errno`).
    #[unsafe(no_mangle)]
    pub extern "C" fn __wpk_fork_frame_reserve(size: usize) -> usize {
        match reserve_impl(primary_activation(), size as u64) {
            Ok(payload) => {
                set_ok();
                payload as usize
            }
            Err(errno) => {
                set_err(errno);
                0
            }
        }
    }

    /// `__wpk_fork_frame_commit(payload)`. Commit the pending reservation and
    /// record its function ordinal in the replay journal.
    #[unsafe(no_mangle)]
    pub extern "C" fn __wpk_fork_frame_commit(payload: usize) {
        match commit_impl(primary_activation(), payload as u64) {
            Ok(()) => set_ok(),
            Err(errno) => set_err(errno),
        }
    }

    /// `__wpk_fork_frame_peek(size) -> payload`. Journal-gated non-consuming peek
    /// of the current rewind frame (0 on failure; check `fm_last_errno`).
    #[unsafe(no_mangle)]
    pub extern "C" fn __wpk_fork_frame_peek(size: usize) -> usize {
        match peek_impl(primary_activation(), size as u64) {
            Ok(payload) => {
                set_ok();
                payload as usize
            }
            Err(errno) => {
                set_err(errno);
                0
            }
        }
    }

    /// `__wpk_fork_frame_next(size) -> payload`. Journal-gated consuming advance
    /// of the rewind cursor (0 on failure; check `fm_last_errno`).
    #[unsafe(no_mangle)]
    pub extern "C" fn __wpk_fork_frame_next(size: usize) -> usize {
        match next_impl(primary_activation(), size as u64) {
            Ok(payload) => {
                set_ok();
                payload as usize
            }
            Err(errno) => {
                set_err(errno);
                0
            }
        }
    }

    /// `__wpk_fork_resume_peek(type_diagnostic) -> slot`. Resume-slot index for
    /// the currently selected replay event (0 = reserved sentinel; -1 on error,
    /// check `fm_last_errno`). The diagnostic argument is unused here.
    #[unsafe(no_mangle)]
    pub extern "C" fn __wpk_fork_resume_peek(_type_diagnostic: i32) -> i32 {
        match resume_peek_impl(primary_activation()) {
            Ok(slot) => {
                set_ok();
                slot as i32
            }
            Err(errno) => {
                set_err(errno);
                -1
            }
        }
    }

    // -- Shared activation-parameterized frame exports (trampoline targets) --
    //
    // Phase 6 D7a.2 (ADDITIVE): the per-activation TRAMPOLINE for activation
    // `act` calls these, folding in its constant activation id, so each
    // activation's frames route to its OWN writer/driver in the map while the
    // journal + resume table stay process-wide. The single-activation guest-
    // facing exports above are these with `act == primary_activation`.

    /// `fm_frame_reserve(act, size) -> payload`. Reserve into activation `act`'s
    /// own writer/arena (0 on failure; check `fm_last_errno`).
    #[unsafe(no_mangle)]
    pub extern "C" fn fm_frame_reserve(activation_id: u32, size: usize) -> usize {
        match reserve_impl(activation_id, size as u64) {
            Ok(payload) => {
                set_ok();
                payload as usize
            }
            Err(errno) => {
                set_err(errno);
                0
            }
        }
    }

    /// `fm_frame_commit(act, payload)`. Commit activation `act`'s pending
    /// reservation and record its ordinal in the process-wide journal, tagged
    /// with `act`.
    #[unsafe(no_mangle)]
    pub extern "C" fn fm_frame_commit(activation_id: u32, payload: usize) {
        match commit_impl(activation_id, payload as u64) {
            Ok(()) => set_ok(),
            Err(errno) => set_err(errno),
        }
    }

    /// `fm_frame_peek(act, size) -> payload`. Journal-gated non-consuming peek of
    /// activation `act`'s current rewind frame (0 on failure).
    #[unsafe(no_mangle)]
    pub extern "C" fn fm_frame_peek(activation_id: u32, size: usize) -> usize {
        match peek_impl(activation_id, size as u64) {
            Ok(payload) => {
                set_ok();
                payload as usize
            }
            Err(errno) => {
                set_err(errno);
                0
            }
        }
    }

    /// `fm_frame_next(act, size) -> payload`. Journal-gated consuming advance of
    /// activation `act`'s rewind cursor (0 on failure).
    #[unsafe(no_mangle)]
    pub extern "C" fn fm_frame_next(activation_id: u32, size: usize) -> usize {
        match next_impl(activation_id, size as u64) {
            Ok(payload) => {
                set_ok();
                payload as usize
            }
            Err(errno) => {
                set_err(errno);
                0
            }
        }
    }

    /// `fm_resume_peek(act) -> slot`. Resume-slot for the currently selected
    /// process-wide replay event (0 = reserved sentinel; -1 on error). The
    /// `act` argument is accepted for a uniform trampoline shape; the resume slot
    /// is a process-wide journal concern (see `resume_peek_impl`).
    #[unsafe(no_mangle)]
    pub extern "C" fn fm_resume_peek(activation_id: u32) -> i32 {
        match resume_peek_impl(activation_id) {
            Ok(slot) => {
                set_ok();
                slot as i32
            }
            Err(errno) => {
                set_err(errno);
                -1
            }
        }
    }

    // -- Coordinator exports (fm_*) -----------------------------------------

    /// Seed the linked-frame format for subsequent forks. `pointer_width` is 4
    /// (wasm32 guest) or 8 (wasm64 guest); `fixed_prefix_size` is the guest's
    /// module-buffer fixed-prefix size. Called ONCE by the host (from the guest
    /// module's `kandelo.wpk_fork.linked_frames` descriptor) before any
    /// `fm_begin_unwind`.
    #[unsafe(no_mangle)]
    pub extern "C" fn fm_set_format(pointer_width: u32, fixed_prefix_size: u32) {
        match set_format_impl(pointer_width, fixed_prefix_size) {
            Ok(()) => set_ok(),
            Err(errno) => set_err(errno),
        }
    }

    /// Begin a fork unwind for `activation_id`, MODULE-OWNED growing allocation
    /// (Option B): the module issues each frame chunk's `SYS_MMAP` through the
    /// guest syscall channel at `channel_base` (page-aligned), growing memory on
    /// demand — no host arena. Returns the module-buffer anchor (0 on failure;
    /// check `fm_last_errno`).
    #[unsafe(no_mangle)]
    pub extern "C" fn fm_begin_unwind(activation_id: u32, channel_base: usize) -> usize {
        match begin_unwind_impl(activation_id, channel_base as u64) {
            Ok(module_buffer) => {
                set_ok();
                module_buffer as usize
            }
            Err(errno) => {
                set_err(errno);
                0
            }
        }
    }

    /// Add ANOTHER activation to the fork begun by `fm_begin_unwind` (Phase 6
    /// D7a.2 — a dlopen fork's side module). `activation_id` is the new
    /// activation (must not already be open); `channel_base` is the fork's
    /// syscall channel (must equal the one `fm_begin_unwind` opened), through
    /// which this activation mmaps its own frame chunks; `fixed_prefix` is ITS
    /// own module-buffer fixed runtime prefix. The guest pointer width is shared
    /// (seeded once via `fm_set_format`). No reset — the process-wide journal
    /// stays capturing across every activation. Returns the activation's
    /// module-buffer anchor (0 on failure; check `fm_last_errno`).
    #[unsafe(no_mangle)]
    pub extern "C" fn fm_add_activation_unwind(
        activation_id: u32,
        channel_base: usize,
        fixed_prefix: u32,
    ) -> usize {
        match add_activation_unwind_impl(activation_id, channel_base as u64, fixed_prefix) {
            Ok(module_buffer) => {
                set_ok();
                module_buffer as usize
            }
            Err(errno) => {
                set_err(errno);
                0
            }
        }
    }

    /// Begin a fork unwind for `activation_id` over a caller-owned FIXED arena
    /// `[base, base + len)` instead of the channel-mmap growing arena — the
    /// in-realm, no-servicer entry for single-threaded in-process harnesses (see
    /// `begin_unwind_fixed_arena_impl`). Returns the module-buffer anchor (0 on
    /// failure; check `fm_last_errno`). NOT a production fork path: the resulting
    /// fork allocates nothing through the channel and must not serialize its
    /// journal.
    #[unsafe(no_mangle)]
    pub extern "C" fn fm_begin_unwind_fixed_arena(
        activation_id: u32,
        base: usize,
        len: usize,
    ) -> usize {
        match begin_unwind_fixed_arena_impl(activation_id, base as u64, len as u64) {
            Ok(module_buffer) => {
                set_ok();
                module_buffer as usize
            }
            Err(errno) => {
                set_err(errno);
                0
            }
        }
    }

    /// Add ANOTHER activation to a FIXED-arena unwind begun by
    /// `fm_begin_unwind_fixed_arena`, over its own caller-owned FIXED arena
    /// `[base, base + len)` and its own `fixed_prefix`. The in-realm sibling of
    /// `fm_add_activation_unwind`. Returns the activation's module-buffer anchor
    /// (0 on failure; check `fm_last_errno`).
    #[unsafe(no_mangle)]
    pub extern "C" fn fm_add_activation_unwind_fixed_arena(
        activation_id: u32,
        base: usize,
        len: usize,
        fixed_prefix: u32,
    ) -> usize {
        match add_activation_unwind_fixed_arena_impl(
            activation_id,
            base as u64,
            len as u64,
            fixed_prefix,
        ) {
            Ok(module_buffer) => {
                set_ok();
                module_buffer as usize
            }
            Err(errno) => {
                set_err(errno);
                0
            }
        }
    }

    /// Vestigial `__heap_base` export.
    ///
    /// `rustc` unconditionally appends `--export=__heap_base` for a wasm
    /// `cdylib`, but a position-independent (`--pie`) side module has no static
    /// heap base — its heap lives at `__memory_base`-relative offsets the HOST
    /// chooses, so `wasm-ld` does NOT define `__heap_base` and the forced export
    /// would fail to link. Defining this trivial symbol satisfies the export.
    /// The host never consumes it (the module's allocator uses its own
    /// `__memory_base`-relative BSS heap), so its value is meaningless; it exists
    /// only so the `--pie` link succeeds.
    #[unsafe(no_mangle)]
    pub extern "C" fn __heap_base() -> i32 {
        0
    }

    /// Finish the unwind: seal the writer and the captured journal.
    #[unsafe(no_mangle)]
    pub extern "C" fn fm_finish_unwind() {
        match finish_unwind_impl() {
            Ok(()) => set_ok(),
            Err(errno) => set_err(errno),
        }
    }

    /// Begin the (parent) rewind: attach the driver and register resume slots.
    #[unsafe(no_mangle)]
    pub extern "C" fn fm_begin_replay() {
        match begin_replay_impl() {
            Ok(()) => set_ok(),
            Err(errno) => set_err(errno),
        }
    }

    /// Finish the rewind: require every committed frame consumed.
    #[unsafe(no_mangle)]
    pub extern "C" fn fm_finish_replay() {
        match finish_replay_impl() {
            Ok(()) => set_ok(),
            Err(errno) => set_err(errno),
        }
    }

    /// Begin an abort-replay: identical frame/journal mechanics to fm_begin_replay,
    /// tagged so fm_finish_abort can assert the pairing.
    #[unsafe(no_mangle)]
    pub extern "C" fn fm_begin_abort() {
        match begin_abort_impl() {
            Ok(()) => set_ok(),
            Err(errno) => set_err(errno),
        }
    }

    /// Finish an abort-replay: require it was begun as an abort, then finish + release.
    #[unsafe(no_mangle)]
    pub extern "C" fn fm_finish_abort() {
        match finish_abort_impl() {
            Ok(()) => set_ok(),
            Err(errno) => set_err(errno),
        }
    }

    /// Serialize the sealed capture journal as a KFRE image into a FRESH chunk
    /// the module channel-mmaps through `channel_base` (Option B), returning that
    /// chunk's guest offset (0 on failure; check `fm_last_errno`). The PARENT
    /// calls this once after `fm_finish_unwind` and before the fork; the host
    /// then records the returned pointer and `fm_journal_image_len` in a
    /// `JournalImage` KFMS record so the forked child finds the image after the
    /// address-space copy. This is the module equivalent of JS `sealCapture` ->
    /// `arena.appendReplayEvents(events)`, but the image chunk is mmap'd on
    /// demand rather than carved from a fixed host arena. The chunk is released
    /// on `fm_finish_replay`/`fm_abort` with the frame chunks.
    #[unsafe(no_mangle)]
    pub extern "C" fn fm_serialize_journal_alloc(channel_base: usize) -> usize {
        match serialize_journal_alloc_impl(channel_base as u64) {
            Ok(ptr) => {
                set_ok();
                ptr as usize
            }
            Err(errno) => {
                set_err(errno);
                0
            }
        }
    }

    /// In-realm, no-servicer sibling of `fm_serialize_journal_alloc`: serialize
    /// the sealed journal into a caller-owned FIXED region `[base, base + len)`
    /// (no channel-mmap), returning `base` (0 on failure; check `fm_last_errno`).
    /// Read the byte length back via `fm_journal_image_len`. For the in-process
    /// fixed-arena harness only.
    #[unsafe(no_mangle)]
    pub extern "C" fn fm_serialize_journal_fixed_arena(base: usize, len: usize) -> usize {
        match serialize_journal_fixed_arena_impl(base as u64, len as u64) {
            Ok(ptr) => {
                set_ok();
                ptr as usize
            }
            Err(errno) => {
                set_err(errno);
                0
            }
        }
    }

    /// The byte length of the KFRE image the last `fm_serialize_journal_alloc`
    /// wrote (0 if none). The host reads this together with the returned pointer
    /// to write the `JournalImage` KFMS record.
    #[unsafe(no_mangle)]
    pub extern "C" fn fm_journal_image_len() -> i64 {
        match state().as_ref() {
            Some(st) => st.journal_image_len as i64,
            None => 0,
        }
    }

    /// Release every channel-mapped frame/image chunk WITHOUT requiring the
    /// replay to have finished — the host error/abort path (mirrors the JS
    /// backend's `abort()` releasing the frame arena). Idempotent.
    #[unsafe(no_mangle)]
    pub extern "C" fn fm_abort() {
        match abort_impl() {
            Ok(()) => set_ok(),
            Err(errno) => set_err(errno),
        }
    }

    /// Seed a forked CHILD instance's replay from copied guest memory and attach
    /// its rewind driver. `module_buffer` is the continuation anchor the parent
    /// published (inherited at the same guest offset); `[image_ptr, image_ptr +
    /// image_len)` is the KFRE image the parent serialized with
    /// `fm_serialize_journal` (also inherited via the memory copy). The child is
    /// a FRESH instance placed at a DIFFERENT `__memory_base` with an empty
    /// journal; this rebuilds the journal + resume-slot table from the COPIED
    /// bytes only, then drives replay exactly as the parent's committed order
    /// dictates. This is the module equivalent of JS `attachChild` ->
    /// `replayEventsForChild(records)` -> `events.attachChild`. On success the
    /// guest then drives `__wpk_fork_frame_peek/next` + `__wpk_fork_resume_peek`.
    #[unsafe(no_mangle)]
    pub extern "C" fn fm_begin_child_replay(
        module_buffer: usize,
        image_ptr: usize,
        image_len: usize,
    ) {
        match begin_child_replay_impl(module_buffer as u64, image_ptr as u64, image_len as u64) {
            Ok(()) => set_ok(),
            Err(errno) => set_err(errno),
        }
    }

    /// Seed a vfork BORROWED child's replay: like `fm_begin_child_replay`, but
    /// the child SHARES the parked parent's memory (its own module instance at a
    /// distinct `__memory_base`) instead of a private copy. `module_buffer` is the
    /// parent's continuation anchor (borrowed, read-only); `[image_ptr, image_ptr
    /// + image_len)` is the KFRE image the parent serialized (still live in shared
    /// memory); `private_prefix` is a CHILD-PRIVATE, pre-reserved region the module
    /// copies the parent's fixed runtime prefix into, so the guest's rewind writes
    /// its active-frame pointer there and never touches the parked parent's prefix.
    /// The built replay owns no chunks, so finish/abort munmap nothing (the
    /// parent's storage is never unmapped). On success the host hands the guest
    /// `private_prefix` as the rewind root. Failure is truthful (`fm_last_errno`);
    /// the parent's address space is left untouched.
    #[unsafe(no_mangle)]
    pub extern "C" fn fm_begin_borrowed_child_replay(
        module_buffer: usize,
        image_ptr: usize,
        image_len: usize,
        private_prefix: usize,
    ) {
        match begin_borrowed_child_replay_impl(
            module_buffer as u64,
            image_ptr as u64,
            image_len as u64,
            private_prefix as u64,
        ) {
            Ok(()) => set_ok(),
            Err(errno) => set_err(errno),
        }
    }

    /// Add a dlopen-vfork ("mode-1") SIDE activation to a BORROWED child replay
    /// begun by `fm_begin_borrowed_child_replay` (Phase 6 item 4). The borrowed
    /// sibling of `fm_add_activation_child_replay`: read-only rewind over the
    /// parent's borrowed continuation at `module_buffer`, with this activation's
    /// fixed prefix copied into its own child-private `private_prefix`. Owns no
    /// chunks. Check `fm_last_errno`.
    #[unsafe(no_mangle)]
    pub extern "C" fn fm_add_activation_borrowed_child_replay(
        activation_id: u32,
        module_buffer: usize,
        fixed_prefix: u32,
        private_prefix: usize,
    ) {
        match add_activation_borrowed_child_replay_impl(
            activation_id,
            module_buffer as u64,
            fixed_prefix,
            private_prefix as u64,
        ) {
            Ok(()) => set_ok(),
            Err(errno) => set_err(errno),
        }
    }

    /// Add a dlopen fork's SIDE activation to a child replay begun by
    /// `fm_begin_child_replay` (Phase 6 D7a.1a — the multi-activation child).
    /// `activation_id` is the side activation (must not already be seeded);
    /// `module_buffer` is ITS continuation anchor, inherited at the same guest
    /// offset via the fork memory copy; `fixed_prefix` is ITS own module-buffer
    /// fixed runtime prefix (side modules carry their own — the child-side mirror
    /// of `fm_add_activation_unwind`, and required to decode this activation's
    /// linked-frame chain). The process-wide journal is NOT reseeded: this
    /// attaches the activation's replay-only frame state and registers its resume
    /// slots against the SAME journal + table `fm_begin_child_replay` created.
    /// On success the guest then drives this activation's per-activation
    /// trampoline (`fm_frame_peek/next(act, ...)`) in lockstep with the others.
    #[unsafe(no_mangle)]
    pub extern "C" fn fm_add_activation_child_replay(
        activation_id: u32,
        module_buffer: usize,
        fixed_prefix: u32,
    ) {
        match add_activation_child_replay_impl(activation_id, module_buffer as u64, fixed_prefix) {
            Ok(()) => set_ok(),
            Err(errno) => set_err(errno),
        }
    }

    /// Seed the FULL resume catalog for this worker: `[ptr, ptr + count*4)` is a
    /// little-endian `u32` array of the fork-instrumented function ordinals (the
    /// same set the host registers into the JS `__wpk_fork_resume_table`). The
    /// module registers its `ResumeSlotTable` from this catalog at replay so its
    /// slot numbering matches the JS table by construction (resume-slot parity).
    /// Called ONCE per worker (like `fm_set_format`), before any fork. A catalog
    /// larger than the module's cap fails with `E2BIG` (check `fm_last_errno`);
    /// the host then keeps the JavaScript continuation for that program.
    #[unsafe(no_mangle)]
    pub extern "C" fn fm_set_resume_catalog(ptr: usize, count: usize) {
        match set_resume_catalog_impl(ptr as u64, count as u64) {
            Ok(()) => set_ok(),
            Err(errno) => set_err(errno),
        }
    }

    /// Seed ONE activation's resume catalog for this worker (Phase 6 D7a.1a — the
    /// multi-activation path): `[ptr, ptr + count*4)` is a little-endian `u32`
    /// array of `activation_id`'s OWN fork-instrumented function ordinals (the set
    /// the host registers into THAT activation's JS `__wpk_fork_resume_table`).
    /// A dlopen fork loads N modules, each with its own catalog table; the module
    /// registers each activation's resume slots from ITS catalog so the numbering
    /// matches that activation's JS table by construction (resume-slot parity).
    /// Called ONCE per activation per worker, before any fork, alongside
    /// `fm_set_format`. Too many activations, or catalogs that jointly exceed the
    /// module's arena, fail with `E2BIG`; a re-seeded activation fails with
    /// `EINVAL` (check `fm_last_errno`), and the host keeps the JavaScript
    /// continuation for that program.
    #[unsafe(no_mangle)]
    pub extern "C" fn fm_set_activation_resume_catalog(
        activation_id: u32,
        ptr: usize,
        count: usize,
    ) {
        match set_activation_resume_catalog_impl(activation_id, ptr as u64, count as u64) {
            Ok(()) => set_ok(),
            Err(errno) => set_err(errno),
        }
    }

    /// Seed ONE activation's function-catalog BASE for this worker (Phase 6
    /// D7a.1b — the merged-catalog mechanism): the host lays every activation's
    /// funcref catalog into ONE merged `__wpk_fork_function_catalog` table, with
    /// `activation_id`'s catalog occupying slots `[base, base + len)`.
    /// `fm_funcref_ordinal` then returns the GLOBAL slot
    /// `base(module_activation) + function_ordinal` for the injected funcref shim
    /// to `table.get`, so a funcref minted in one activation but held by another's
    /// frame resolves against its OWN activation's slice. Called ONCE per
    /// activation per worker (like `fm_set_activation_resume_catalog`), before any
    /// fork drives reference reconstruction. A SINGLE-activation worker seeds no
    /// base at all; `fm_funcref_ordinal` then defaults `base = 0`, byte-identical
    /// to the D6.1 raw-ordinal mapping. Too many activations fail with `E2BIG`; a
    /// re-seeded activation fails with `EINVAL` (check `fm_last_errno`).
    #[unsafe(no_mangle)]
    pub extern "C" fn fm_set_activation_catalog_base(activation_id: u32, base: u32) {
        match set_activation_catalog_base_impl(activation_id, base) {
            Ok(()) => set_ok(),
            Err(errno) => set_err(errno),
        }
    }

    /// Seed ONE activation's static-root catalog BASE for this worker (the
    /// static-root binder — the funcref merged-catalog mechanism, for static
    /// roots): the host lays every activation's instantiation-time static-root
    /// catalog into ONE merged `env.__wpk_fork_static_root_catalog` anyref table,
    /// with `activation_id`'s catalog occupying slots `[base, base + len)`.
    /// `fm_static_root_slot` then returns the GLOBAL slot
    /// `base(module_activation) + static_root_ordinal` for the injected drive shim
    /// to `table.get`. Called ONCE per activation per worker, before any fork
    /// drives reference reconstruction. A SINGLE-activation worker seeds no base at
    /// all; `fm_static_root_slot` then defaults `base = 0`. Too many activations
    /// fail with `E2BIG`; a re-seeded activation fails with `EINVAL` (check
    /// `fm_last_errno`).
    #[unsafe(no_mangle)]
    pub extern "C" fn fm_set_activation_static_root_base(activation_id: u32, base: u32) {
        match set_activation_static_root_base_impl(activation_id, base) {
            Ok(()) => set_ok(),
            Err(errno) => set_err(errno),
        }
    }

    /// Seed ONE activation's raw `kandelo.wpk_fork.gc_codec` section bytes for this
    /// worker (Phase 6 item 3c — the real GC drive plan). `ptr`/`byte_len` point at
    /// the section bytes the host wrote into guest memory; the module copies them
    /// into its own arena and decodes them (into a `GcCodec`) when
    /// `fm_build_gc_plan` runs, to supply the per-recipe GC-layout facts the JS
    /// `materializeTypedGraph` drive-order needs (constructor dependencies,
    /// defaultable shells, the i31 owner). Called ONCE per activation per worker,
    /// before any fork drives GC reconstruction, alongside `fm_set_format`. Too
    /// many activations, or catalogs that jointly exceed the module's arena, fail
    /// with `E2BIG`; a re-seeded activation fails with `EINVAL` (check
    /// `fm_last_errno`), and the host keeps the JS drive-order for that program.
    #[unsafe(no_mangle)]
    pub extern "C" fn fm_set_activation_gc_codec(activation_id: u32, ptr: usize, byte_len: usize) {
        match set_activation_gc_codec_impl(activation_id, ptr as u64, byte_len as u64) {
            Ok(()) => set_ok(),
            Err(errno) => set_err(errno),
        }
    }

    /// Seed the `hostExceptionOwner` for this worker (Phase 6 item 3c): the
    /// smallest activation that declared an exception descriptor, which
    /// `fm_build_gc_plan` uses to remap a HOST-exception exnref's owner exactly as
    /// the JS `directOwner`. Pass `u32::MAX` (0xffff_ffff) when there is no such
    /// owner (the JS `null`). Called ONCE per worker; a single-activation program
    /// with no host exceptions need not call it at all (the default is "none").
    #[unsafe(no_mangle)]
    pub extern "C" fn fm_set_host_exception_owner(owner: u32) {
        HOST_EXCEPTION_OWNER.store(owner, Ordering::Relaxed);
        set_ok();
    }

    /// Monotonic count of frames this module has committed since worker start.
    /// Proof-of-use: after a flag-on qualifying fork drives the continuation
    /// through the module, this has advanced; a silent JS fallback leaves it
    /// unchanged. Never resets (including across `fm_begin_unwind`).
    #[unsafe(no_mangle)]
    pub extern "C" fn fm_frames_committed() -> i64 {
        FRAMES_COMMITTED.load(Ordering::Relaxed) as i64
    }

    /// Monotonic count of frames this module has REPLAYED (consuming rewind
    /// advances) since worker start. Replay-side proof-of-use mirror of
    /// `fm_frames_committed`: a replay-only forked child never commits a frame,
    /// so this is the counter the child worker reports to prove it drove its
    /// rewind through the module rather than a silent JS fallback (Phase 6 D7b).
    /// Advances on the parent replay too; never resets.
    #[unsafe(no_mangle)]
    pub extern "C" fn fm_frames_replayed() -> i64 {
        FRAMES_REPLAYED.load(Ordering::Relaxed) as i64
    }

    /// Seed the reference graph for this fork from the KFMS module-state arena
    /// rooted at `module_state_root` and run its bookkeeping reconstruction pass
    /// (Phase 6 D6.2, widened from D6.1). The host calls this once on a qualifying
    /// fork after `fm_begin_child_replay`, before the guest rewind reconstructs
    /// references. `pid` names the child process image; retained in this export's
    /// signature for the host call site, but unused since M2 — the reconstruction
    /// no longer opens a host root generation (that seam retired, see
    /// `ReconstructionState`'s doc).
    ///
    /// On success the guest's `__wpk_fork_ref_decode_funcref` is served by this
    /// module; EVERY externref recipe — directly held (frame-vector-only) and
    /// GC/exnref-reachable alike — is published into the anyref transit by a
    /// `DRIVE_OP_EXTERNREF_TRANSIT` drive step (via `fm_externref_handle`) when
    /// `fm_drive_execute` runs the plan `fm_build_gc_plan` built. Failure (check
    /// `fm_last_errno`: `EOPNOTSUPP` for an unadmitted kind, `EINVAL` for a
    /// malformed arena) means the host must keep the byte-identical JS reference
    /// path for this fork.
    #[unsafe(no_mangle)]
    pub extern "C" fn fm_begin_reference_replay(module_state_root: usize, pid: u32) {
        match begin_reference_replay_impl(module_state_root as u64, pid) {
            Ok(()) => set_ok(),
            Err(errno) => set_err(errno),
        }
    }

    /// Resolve a funcref recipe id to a function-catalog ordinal (Phase 6 D6.1).
    /// This is NOT a guest-facing import: it is the helper the injected
    /// `__wpk_fork_ref_decode_funcref` wasm shim calls to get the ordinal, then
    /// does `table.get` on the imported `__wpk_fork_function_catalog` table (a
    /// funcref a Rust function cannot itself return). Returns a non-negative
    /// catalog ordinal for a Funcref, `-1` for the canonical Null reference, and
    /// TRAPS on any inconsistency. See `funcref_ordinal_impl`.
    #[unsafe(no_mangle)]
    pub extern "C" fn fm_funcref_ordinal(recipe_id: u32) -> i32 {
        funcref_ordinal_impl(recipe_id)
    }

    /// Resolve a static-root recipe id to a merged anyref-catalog index (the
    /// static-root binder). This is NOT a guest-facing import: it is the helper the
    /// injected `fm_drive_execute` shim calls on a DRIVE_OP_STATIC_ROOT step to get
    /// the index it `table.get`s on the imported `env.__wpk_fork_static_root_catalog`
    /// table (an anyref a Rust function cannot itself return) before publishing the
    /// value into the transit at slot `recipe + 1`. Returns a non-negative catalog
    /// index and TRAPS on any inconsistency. See `static_root_slot_impl`.
    #[unsafe(no_mangle)]
    pub extern "C" fn fm_static_root_slot(recipe_id: u32) -> i32 {
        static_root_slot_impl(recipe_id)
    }

    /// Resolve an externref recipe id to its captured broker handle (M2 — the
    /// externref host seam). This is NOT a guest-facing import: it is the helper
    /// the injected binder calls to get the `u32` handle it passes to the single
    /// residual host import `resolve_externref(handle) -> externref` (an
    /// `externref` a Rust function cannot itself return) on a
    /// DRIVE_OP_EXTERNREF_TRANSIT step (emitted for EVERY externref recipe —
    /// directly held and GC/exnref-reachable alike — since the 2026-09-05
    /// substrate fix) before `any.convert_extern` + `table.set`-ing the result
    /// into the anyref transit at slot `recipe + 1`. Returns a non-negative
    /// broker handle and TRAPS on any inconsistency. See
    /// `externref_handle_impl`.
    #[unsafe(no_mangle)]
    pub extern "C" fn fm_externref_handle(recipe_id: u32) -> i32 {
        externref_handle_impl(recipe_id)
    }

    // -- Reference RESTORE data-feed exports (Phase 6 item 3a) ---------------
    //
    // These seven exports are guest-facing: the host flips the guest's
    // `__wpk_fork_ref_{vector_get,gc_route,gc_payload_len,gc_load,exn_route,
    // exn_load,exn_cache_index}` imports to them per-activation (the same
    // per-activation flip as `__wpk_fork_ref_decode_funcref`). Unlike the funcref
    // decode (which RETURNS a funcref, so it needs the walrus-injected shim),
    // these have pure i32/i64 signatures, so plain Rust `#[no_mangle]` exports the
    // guest imports directly. Signatures match the guest imports in
    // `host/src/generated/abi.ts` (`ptr` -> `usize`, i32 -> u32/i32).

    /// `__wpk_fork_ref_vector_get(ordinal, index) -> recipe_id`.
    #[unsafe(no_mangle)]
    pub extern "C" fn fm_ref_vector_get(ordinal: u32, index: u32) -> i32 {
        ref_vector_get_impl(ordinal, index)
    }

    /// `__wpk_fork_ref_gc_route(recipe_id, expected_activation) -> layout|0|-1`.
    #[unsafe(no_mangle)]
    pub extern "C" fn fm_ref_gc_route(recipe_id: u32, expected_activation: u32) -> i32 {
        ref_gc_route_impl(recipe_id, expected_activation)
    }

    /// `__wpk_fork_ref_gc_payload_len(recipe_id, activation, layout) -> len`.
    #[unsafe(no_mangle)]
    pub extern "C" fn fm_ref_gc_payload_len(
        recipe_id: u32,
        expected_activation: u32,
        expected_layout_id: u32,
    ) -> i32 {
        ref_gc_payload_len_impl(recipe_id, expected_activation, expected_layout_id)
    }

    /// `__wpk_fork_ref_gc_load(recipe_id, activation, type, layout, kind, dst,
    /// len) -> vector_ordinal|0`. `dst` is an absolute guest byte offset (`ptr`).
    #[unsafe(no_mangle)]
    pub extern "C" fn fm_ref_gc_load(
        recipe_id: u32,
        module_activation: u32,
        type_ordinal: u32,
        layout_id: u32,
        kind: u32,
        scalar_destination: usize,
        scalar_byte_length: u32,
    ) -> i32 {
        ref_gc_load_impl(
            recipe_id,
            module_activation,
            type_ordinal,
            layout_id,
            kind,
            scalar_destination,
            scalar_byte_length,
        )
    }

    /// `__wpk_fork_ref_exn_route(recipe_id, expected_activation) -> layout|-1`.
    #[unsafe(no_mangle)]
    pub extern "C" fn fm_ref_exn_route(recipe_id: u32, expected_activation: u32) -> i32 {
        ref_exn_route_impl(recipe_id, expected_activation)
    }

    /// `__wpk_fork_ref_exn_load(recipe_id, activation, tag, layout, scalar_dst,
    /// scalar_len, ref_ids_dst, ref_count) -> 1`. Both `dst` args are absolute
    /// guest byte offsets (`ptr`).
    #[unsafe(no_mangle)]
    pub extern "C" fn fm_ref_exn_load(
        recipe_id: u32,
        module_activation: u32,
        tag_ordinal: u32,
        layout_id: u32,
        scalar_destination: usize,
        scalar_byte_length: u32,
        reference_ids_destination: usize,
        reference_count: u32,
    ) -> i32 {
        ref_exn_load_impl(
            recipe_id,
            module_activation,
            tag_ordinal,
            layout_id,
            scalar_destination,
            scalar_byte_length,
            reference_ids_destination,
            reference_count,
        )
    }

    /// `__wpk_fork_ref_exn_cache_index(recipe_id) -> index`.
    #[unsafe(no_mangle)]
    pub extern "C" fn fm_ref_exn_cache_index(recipe_id: u32) -> i32 {
        ref_exn_cache_index_impl(recipe_id)
    }

    /// Monotonic count of RESTORE data-feed reads this module has served since
    /// worker start (Phase 6 item 3a). Proof-of-use mirror of
    /// `fm_gc_nodes_reconstructed` for the data-feed move: after a flag-on
    /// GC/exnref fork drives its typed-graph reconstruction, the guest codec reads
    /// the reference graph through this module's `fm_ref_*` exports and this has
    /// advanced; a silent JS fallback (the imports stayed on the JS reference
    /// provider) leaves it unchanged. Never resets.
    #[unsafe(no_mangle)]
    pub extern "C" fn fm_ref_feed_reads() -> i64 {
        REFERENCE_FEED_READS.load(Ordering::Relaxed) as i64
    }

    /// Monotonic count of references (funcref or null) this module has
    /// reconstructed since worker start. Proof-of-use mirror of
    /// `fm_frames_committed`: after a flag-on funcref fork reconstructs its
    /// references through the module, this has advanced; a silent JS fallback
    /// leaves it unchanged. Never resets.
    #[unsafe(no_mangle)]
    pub extern "C" fn fm_references_reconstructed() -> i64 {
        REFERENCES_RECONSTRUCTED.load(Ordering::Relaxed) as i64
    }

    /// Monotonic count of externrefs this module has re-rooted through the
    /// `wpk_fork_host` engine-floor seam since worker start (Phase 6 D6.2).
    /// Proof-of-use mirror of `fm_references_reconstructed` for the externref
    /// path: after a flag-on externref fork drives reconstruction through the
    /// module, this has advanced by the graph's externref-node count; a silent JS
    /// fallback leaves it unchanged. Never resets.
    #[unsafe(no_mangle)]
    pub extern "C" fn fm_externrefs_resolved() -> i64 {
        EXTERNREFS_RESOLVED.load(Ordering::Relaxed) as i64
    }

    /// Monotonic count of exnref nodes this module has admitted and driven since
    /// worker start (Phase 6 D6.3a). Proof-of-use mirror of
    /// `fm_externrefs_resolved` for the exnref path: after a flag-on
    /// exnref-bearing fork drives reconstruction through the module, this has
    /// advanced by the graph's exnref-node count; a silent JS fallback leaves it
    /// unchanged. The exnref's reachable externref payloads are rooted through
    /// the same transit path (`fm_externrefs_resolved` also advances), while the
    /// exnref value itself is materialized by the guest export. Never resets.
    #[unsafe(no_mangle)]
    pub extern "C" fn fm_exnrefs_reconstructed() -> i64 {
        EXNREFS_RECONSTRUCTED.load(Ordering::Relaxed) as i64
    }

    /// Monotonic count of typed-GC nodes (struct + array + i31) this module has
    /// admitted and driven since worker start (Phase 6 D6.4a). Proof-of-use mirror
    /// of `fm_exnrefs_reconstructed` for the typed-GC path: after a flag-on
    /// typed-GC fork drives reconstruction through the module, this has advanced by
    /// the graph's GC-node count; a silent JS fallback leaves it unchanged. The
    /// struct/array-reachable externref leaves are rooted through the same transit
    /// path (`fm_externrefs_resolved` also advances), while the GC allocate/fill is
    /// driven by the guest export under the JS order (i31 is a scalar leaf). Never
    /// resets.
    #[unsafe(no_mangle)]
    pub extern "C" fn fm_gc_nodes_reconstructed() -> i64 {
        GC_NODES_RECONSTRUCTED.load(Ordering::Relaxed) as i64
    }

    /// Monotonic count of static roots the static-root binder has resolved for
    /// publish since worker start. Proof-of-use for the static-root DRIVE step:
    /// after a flag-on static-root fork, the injected shim published every
    /// immutable root into the anyref transit through `fm_static_root_slot`
    /// (`table.get` catalog + `table.set` transit), and this has advanced; a silent
    /// JS `publishTransit` fallback leaves it unchanged. Never resets.
    #[unsafe(no_mangle)]
    pub extern "C" fn fm_static_roots_published() -> i64 {
        STATIC_ROOTS_PUBLISHED.load(Ordering::Relaxed) as i64
    }

    // -- GC drive-shim exports (Phase 6 item 3b) -----------------------------

    /// The first `env.__wpk_fork_drive_table` slot for `activation` (item 3b).
    /// The host reads this to bind each activation's `_gc_allocate`/`_gc_fill`
    /// guest exports at `base + {ALLOC, FILL}`, matching the absolute slot numbers
    /// the Rust drive PLAN encodes. A single-activation fork uses base 0.
    #[unsafe(no_mangle)]
    pub extern "C" fn fm_drive_table_base(activation: u32) -> i32 {
        drive_plan::drive_table_base(activation) as i32
    }

    /// Serialize a TRIVIAL single-struct drive plan (ALLOC then FILL for one
    /// `recipe` in `activation`) into a module-owned scratch buffer and return its
    /// guest address for `fm_drive_execute`. The shim's post-ALLOC integrity guard
    /// reads STORE #2 (the guest's Wasm-GC transit table) directly, so no host
    /// generation is opened here. Returns 0 on failure (check `fm_last_errno`).
    /// This proves the drive MECHANISM; item 3c builds the real plan by walking
    /// the decoded reference graph.
    #[unsafe(no_mangle)]
    pub extern "C" fn fm_build_trivial_plan(activation: u32, recipe: u32, pid: u32) -> usize {
        match build_trivial_plan_impl(activation, recipe, pid) {
            Ok(ptr) => {
                set_ok();
                ptr
            }
            Err(errno) => {
                set_err(errno);
                0
            }
        }
    }

    /// The step count of the plan `fm_build_trivial_plan` wrote (the `count`
    /// argument for `fm_drive_execute`). The trivial plan is exactly ALLOC + FILL.
    #[unsafe(no_mangle)]
    pub extern "C" fn fm_trivial_plan_count() -> i32 {
        2
    }

    /// Build the REAL topological GC drive plan (Phase 6 item 3c) for the fork's
    /// whole reference graph, reproducing the JS `materializeTypedGraph` order, and
    /// return its guest address for `fm_drive_execute`. Requires
    /// `fm_begin_reference_replay` to have seeded the driver and each participating
    /// activation's `fm_set_activation_gc_codec` to have seeded its layout catalog.
    /// Returns 0 on failure (check `fm_last_errno`): a missing driver, an un-seeded
    /// GC activation, a mismatched recipe/layout coordinate, or an unallocatable
    /// constructor/exception cycle is a truthful failure, never a wrong plan.
    #[unsafe(no_mangle)]
    pub extern "C" fn fm_build_gc_plan(pid: u32) -> usize {
        match build_gc_plan_impl(pid) {
            Ok(ptr) => {
                set_ok();
                ptr
            }
            Err(errno) => {
                set_err(errno);
                0
            }
        }
    }

    /// The step count of the plan `fm_build_gc_plan` last serialized (the `count`
    /// argument for `fm_drive_execute`). 0 before the first successful build.
    #[unsafe(no_mangle)]
    pub extern "C" fn fm_gc_plan_count() -> i32 {
        GC_PLAN_COUNT.load(Ordering::Relaxed) as i32
    }

    /// Bump the drive-step proof-of-use counter by one (Phase 6 item 3c). NOT a
    /// guest-facing import: the walrus-injected `fm_drive_execute` shim
    /// (crates/fork-module-inject) `call`s this once per plan step it drives, so
    /// the counter equals the number of `call_indirect`s into the guest's
    /// `_gc_allocate`/`_gc_fill`/`_exception_materialize` exports. Rust cannot
    /// express the drive loop (`call_indirect`), but it CAN own the counter the
    /// loop increments, keeping the proof in one place.
    #[unsafe(no_mangle)]
    pub extern "C" fn fm_drive_bump() {
        DRIVE_STEPS_EXECUTED.fetch_add(1, Ordering::Relaxed);
    }

    /// Monotonic count of drive steps this module has executed since worker start
    /// (Phase 6 item 3c). Proof-of-use for the production typed-GC drive flip: a
    /// nonzero value proves the MODULE drove the typed allocate/fill/exn order via
    /// `fm_drive_execute`, distinct from `fm_gc_nodes_reconstructed` (which
    /// advances merely by admitting the graph in `fm_begin_reference_replay`). A
    /// flag-on fork that fell back to the JS `materializeAllTyped` drive-order
    /// leaves this at zero. Never resets.
    #[unsafe(no_mangle)]
    pub extern "C" fn fm_drive_steps_executed() -> i64 {
        DRIVE_STEPS_EXECUTED.load(Ordering::Relaxed) as i64
    }

    // -- Reference CAPTURE session exports (Path B P3) -----------------------
    //
    // Thin, PURE-SCALAR surfaces over the shared `ReferenceGraphBuilder`. The
    // host's capture-import bodies resolve each live reference to its recipe
    // COORDINATE with the per-host identity floor and then call these to intern
    // it into the ONE shared graph. No export takes or returns a reference: the
    // live-value identity layering stays host-side (Bucket C), exactly as native
    // keeps it in `guest.rs` while calling `graph.intern_*`. Recipe ids are
    // `>= 1` (id 0 is the canonical null the builder seeds); every ID-returning
    // export returns `-1` on failure with the reason in `fm_capture_last_errno`.

    /// GC aggregate kind discriminants `fm_capture_define_gc` accepts. Mirror the
    /// host's `defineGc` kind argument (struct=1, array=2) plus exnref=3.
    const CAPTURE_KIND_STRUCT: u32 = 1;
    const CAPTURE_KIND_ARRAY: u32 = 2;
    const CAPTURE_KIND_EXNREF: u32 = 3;

    /// Fixed header of one record in the `fm_capture_serialize` record stream:
    /// `u16 kind, u16 reserved, u32 activation_id, u32 owner_id, u32 payload_len`.
    const CAPTURE_RECORD_HEADER: usize = 16;

    /// Copy `len` bytes out of guest linear memory at absolute offset `ptr`.
    ///
    /// Uses the module's proven whole-memory read idiom (bounds-check against
    /// `mem_len_bytes` then a raw `ptr::copy`), NOT `<[u8]>::get(range)` on the
    /// whole-memory slice: that slice is based at wasm address 0, and range
    /// indexing/`get` on a null-base slice miscompiles under `--release` (it
    /// reports out-of-bounds for an in-bounds range), whereas single-element
    /// access and raw pointer reads are correct — the same reason
    /// `fm_set_activation_gc_codec` copies via a raw pointer.
    fn read_capture_bytes(ptr: usize, len: usize) -> Result<Vec<u8>, Errno> {
        if len == 0 {
            return Ok(Vec::new());
        }
        let end = ptr.checked_add(len).ok_or(Errno::EINVAL)?;
        if end > mem_len_bytes() {
            return Err(Errno::EINVAL); // span past the end of guest memory
        }
        let mut out = alloc::vec![0u8; len];
        // SAFETY: `[ptr, ptr+len)` is within guest linear memory (checked above);
        // the destination is a distinct freshly-allocated `Vec`.
        let src = core::hint::black_box(ptr) as *const u8;
        unsafe {
            core::ptr::copy(src, out.as_mut_ptr(), len);
        }
        Ok(out)
    }

    fn read_capture_u32_array(ptr: usize, count: usize) -> Result<Vec<u32>, Errno> {
        if count == 0 {
            return Ok(Vec::new());
        }
        let byte_len = count.checked_mul(4).ok_or(Errno::EINVAL)?;
        let raw = read_capture_bytes(ptr, byte_len)?;
        let mut out = Vec::with_capacity(count);
        for chunk in raw.chunks_exact(4) {
            out.push(u32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]));
        }
        Ok(out)
    }

    /// Fold a builder `Result<u32>` into the ID-return convention: on success set
    /// errno OK, bump the capture proof-of-use counter, and return the id (a
    /// recipe id or vector handle/ordinal); on failure record the errno and
    /// return `-1`. A recipe id that would not fit in `i32` is a truthful
    /// `EINVAL` rather than a value the host would misread as an error.
    fn capture_ok_id(result: Result<u32, Errno>) -> i32 {
        match result {
            Ok(id) if id <= i32::MAX as u32 => {
                set_ok();
                CAPTURE_INTERNED.fetch_add(1, Ordering::Relaxed);
                id as i32
            }
            Ok(_) => {
                set_err(Errno::EINVAL);
                -1
            }
            Err(e) => {
                set_err(e);
                -1
            }
        }
    }

    /// Fold a builder `Result<()>` into the VOID-return convention: `0` on
    /// success, `-1` on failure (reason in `fm_capture_last_errno`).
    fn capture_ok_void(result: Result<(), Errno>) -> i32 {
        match result {
            Ok(()) => {
                set_ok();
                CAPTURE_INTERNED.fetch_add(1, Ordering::Relaxed);
                0
            }
            Err(e) => {
                set_err(e);
                -1
            }
        }
    }

    /// Begin (or restart) a reference-capture session: seed a fresh shared
    /// builder (recipe 0 = canonical null, vector 0 = empty sentinel) and drop
    /// any previously serialized record stream. Mirrors the host's `beginCapture`.
    #[unsafe(no_mangle)]
    pub extern "C" fn fm_capture_begin() {
        // `fm_capture_begin` is the FIRST module call of a capture fork (the host
        // issues it in the fork syscall handler, before the guest unwinds). Make
        // it the fork's SINGLE bump-heap reset point: reclaim the previous fork's
        // state here, then ARM the session so `fm_begin_unwind` (which runs LATER,
        // interleaved with the reference encode) does NOT reset again and wipe the
        // capture builder. Empirically the guest encodes references BOTH before
        // and after `fm_begin_unwind`, so the builder must be allocated from a
        // bump that is reset exactly once, at the true fork start — here.
        ALLOC.reset();
        // Create the builder EAGERLY, now that the bump is fresh for this fork:
        // the guest may issue its first reference encode BEFORE `fm_begin_unwind`,
        // and `fm_begin_unwind` consumes the arming (so it won't reset the bump),
        // so a deferred builder could be requested when neither the builder nor
        // the arming is present. Eager creation makes the builder always available
        // for the rest of the fork.
        *capture_state() = Some(ReferenceGraphBuilder::begin());
        CAPTURE_ARMED.store(1, Ordering::Relaxed);
        // SAFETY: single-threaded per worker; only one capture is live at a time.
        unsafe {
            *CAPTURE_SERIALIZED.0.get() = None;
        }
        set_ok();
    }

    /// Intern a function reference by its catalog coordinate. Returns its recipe
    /// id (`>= 1`) or `-1`. The host resolves `(activation, ordinal)` from the
    /// funcref catalog (floor) before calling.
    #[unsafe(no_mangle)]
    pub extern "C" fn fm_capture_intern_funcref(activation: u32, ordinal: u32) -> i32 {
        match capture_builder() {
            Ok(g) => capture_ok_id(g.intern_funcref(activation, ordinal)),
            Err(e) => {
                set_err(e);
                -1
            }
        }
    }

    /// Intern a durable host externref by broker handle (`1..=0xffff_ffff`). The
    /// host resolves the handle from its externref identity floor (V8 `WeakMap`
    /// provenance) before calling; the module never sees the live externref.
    #[unsafe(no_mangle)]
    pub extern "C" fn fm_capture_intern_externref(handle: u32) -> i32 {
        match capture_builder() {
            Ok(g) => capture_ok_id(g.intern_externref(handle)),
            Err(e) => {
                set_err(e);
                -1
            }
        }
    }

    /// Intern an `i31ref` by its signed 31-bit payload.
    #[unsafe(no_mangle)]
    pub extern "C" fn fm_capture_intern_i31(value: i32) -> i32 {
        match capture_builder() {
            Ok(g) => capture_ok_id(g.intern_i31(value)),
            Err(e) => {
                set_err(e);
                -1
            }
        }
    }

    /// Intern a statically-rooted reference by its catalog coordinate.
    #[unsafe(no_mangle)]
    pub extern "C" fn fm_capture_intern_static_root(activation: u32, ordinal: u32) -> i32 {
        match capture_builder() {
            Ok(g) => capture_ok_id(g.intern_static_root(activation, ordinal)),
            Err(e) => {
                set_err(e);
                -1
            }
        }
    }

    /// Claim a fresh graph identity for a GC value before its fields are known,
    /// returning the placeholder recipe id. The host publishes the id first, then
    /// recurses into the value's fields (closing cycles), then completes it with
    /// `fm_capture_define_gc`. Mirrors native's `gc_claim` body.
    #[unsafe(no_mangle)]
    pub extern "C" fn fm_capture_claim_gc() -> i32 {
        match capture_builder() {
            Ok(g) => capture_ok_id(g.claim_gc()),
            Err(e) => {
                set_err(e);
                -1
            }
        }
    }

    /// Reserve a self-contained placeholder leaf for a GATED capture kind (an
    /// externref/anyref with no recoverable production-site provenance). Returns
    /// a fresh distinct recipe id; the host keeps the live value beside it so the
    /// PARENT's own abort-replay hands the exact value back. Mirrors native's
    /// `gated_placeholder`. The soundness gate itself (`EOPNOTSUPP`, no child) is
    /// the host's decision; this only keeps the sealed graph canonical.
    #[unsafe(no_mangle)]
    pub extern "C" fn fm_capture_gated_placeholder() -> i32 {
        match capture_builder() {
            Ok(g) => capture_ok_id(g.push_gated_placeholder()),
            Err(e) => {
                set_err(e);
                -1
            }
        }
    }

    /// Complete a claimed struct/array/exnref placeholder into its final
    /// aggregate recipe. `scalar_ptr`/`scalar_len` is the COMBINED scalar span in
    /// guest linear memory (constructor-provenance seed bytes then the live field
    /// snapshot) the host already assembled. `reference_vector_ordinal` names the
    /// module-interned field/element vector; the edge vector is assembled here
    /// exactly as native's `gc_define` does — provenance recipe ids first, then
    /// that field vector — so the host never re-reads the vector it just interned.
    /// `has_provenance != 0` records a `GcProvenance` for validation (its ids,
    /// read from `prov_ptr`/`prov_count`, must name existing recipes and are the
    /// prepended edges). Returns `0` or `-1`.
    #[allow(clippy::too_many_arguments)]
    #[unsafe(no_mangle)]
    pub extern "C" fn fm_capture_define_gc(
        recipe_id: u32,
        activation: u32,
        type_ordinal: u32,
        layout_id: u32,
        kind: u32,
        scalar_ptr: usize,
        scalar_len: usize,
        reference_vector_ordinal: u32,
        has_provenance: u32,
        prov_ptr: usize,
        prov_count: usize,
    ) -> i32 {
        let kind_enum = match kind {
            CAPTURE_KIND_STRUCT => AggregateKind::Struct,
            CAPTURE_KIND_ARRAY => AggregateKind::Array,
            CAPTURE_KIND_EXNREF => AggregateKind::Exnref,
            _ => {
                set_err(Errno::EINVAL);
                return -1;
            }
        };
        let assembled = (|| -> Result<(), Errno> {
            let scalars = read_capture_bytes(scalar_ptr, scalar_len)?;
            let prov_ids = if has_provenance != 0 {
                read_capture_u32_array(prov_ptr, prov_count)?
            } else {
                Vec::new()
            };
            let g = capture_builder()?;
            // Assemble edges = provenance ids ++ the interned field vector,
            // mirroring native's `gc_define`. Ordinal 0 is the canonical empty
            // vector (no field edges).
            let field_vector = g
                .vectors()
                .get(reference_vector_ordinal as usize)
                .ok_or(Errno::EINVAL)?
                .clone();
            let mut edges = prov_ids.clone();
            edges.extend_from_slice(&field_vector);
            let provenance = if has_provenance != 0 {
                Some(GcProvenance {
                    reference_ids: prov_ids,
                })
            } else {
                None
            };
            g.define_gc(
                recipe_id,
                activation,
                type_ordinal,
                layout_id,
                kind_enum,
                &scalars,
                &edges,
                provenance,
            )
        })();
        capture_ok_void(assembled)
    }

    /// Open a reference-vector builder, returning its handle (`>= 0`).
    #[unsafe(no_mangle)]
    pub extern "C" fn fm_capture_begin_vector() -> i32 {
        match capture_builder() {
            Ok(g) => capture_ok_id(g.begin_vector()),
            Err(e) => {
                set_err(e);
                -1
            }
        }
    }

    /// Append a recipe id to an open vector builder. Returns `0` or `-1`.
    #[unsafe(no_mangle)]
    pub extern "C" fn fm_capture_append_vector(handle: u32, recipe_id: u32) -> i32 {
        match capture_builder() {
            Ok(g) => capture_ok_void(g.append_vector(handle, recipe_id)),
            Err(e) => {
                set_err(e);
                -1
            }
        }
    }

    /// Finish an open vector builder, interning it and returning its stable
    /// ordinal (`>= 1`; identical vectors dedup to one ordinal).
    #[unsafe(no_mangle)]
    pub extern "C" fn fm_capture_finish_vector(handle: u32) -> i32 {
        match capture_builder() {
            Ok(g) => capture_ok_id(g.finish_vector(handle)),
            Err(e) => {
                set_err(e);
                -1
            }
        }
    }

    /// Read entry `index` of interned reference vector `ordinal` from the RESIDENT
    /// capture builder (the graph `fm_capture_*` is still building/has built this
    /// fork), returning the recipe id or `-1` on out-of-bounds. This is the
    /// PARENT's own post-fork replay read: after the parent seals, its frame
    /// rewind asks which recipe ids each frame's reference vector holds so it can
    /// hand back the ORIGINAL live values (kept host-side in `capturedValues`, and
    /// in the module-owned transit table). Unlike `fm_ref_vector_get` — which
    /// reads a DECODED transaction a child reconstructs from the wire — this reads
    /// the live capture builder directly, so the parent never re-decodes its own
    /// graph and never reconstructs (its live references keep their identity by
    /// construction). Requires an active capture session.
    #[unsafe(no_mangle)]
    pub extern "C" fn fm_capture_vector_get(ordinal: u32, index: u32) -> i32 {
        let Some(g) = capture_state().as_ref() else {
            set_err(Errno::EINVAL);
            return -1;
        };
        match g
            .vectors()
            .get(ordinal as usize)
            .and_then(|v| v.get(index as usize))
        {
            Some(&recipe_id) if recipe_id <= i32::MAX as u32 => {
                set_ok();
                recipe_id as i32
            }
            _ => {
                set_err(Errno::EINVAL);
                -1
            }
        }
    }

    /// Validate the built graph as a canonical, sealable capture (no pending GC
    /// placeholder, no open vector, every edge names an existing recipe). Returns
    /// `0` or `-1`. `fm_capture_serialize` validates too; this lets the host gate
    /// early, mirroring the TS `validateCanonicalCapture`.
    #[unsafe(no_mangle)]
    pub extern "C" fn fm_capture_validate() -> i32 {
        // Create-if-armed: an empty capture (no references) is still a valid
        // null-only graph the host may seal.
        match capture_builder() {
            Ok(g) => match g.validate() {
                Ok(()) => {
                    set_ok();
                    0
                }
                Err(e) => {
                    set_err(e);
                    -1
                }
            },
            Err(e) => {
                set_err(e);
                -1
            }
        }
    }

    /// Serialize the built graph into a module-owned KFRV/KFRS record stream and
    /// return its guest address (0 on failure; reason in `fm_capture_last_errno`).
    /// The stream is a sequence of records, each `CAPTURE_RECORD_HEADER` bytes
    /// (`u16 kind, u16 reserved, u32 activation_id, u32 owner_id, u32 payload_len`)
    /// followed by `payload_len` payload bytes, in the exact emit order of the
    /// shared `ReferenceSegmentsWriter` (five KFRS sections then the KFRV
    /// manifest). The host drains each record into its module-state arena via
    /// `appendRecord({kind, activationId, ownerId, payload})` — the same records
    /// the TS `appendSegmentedForkReferenceTransaction` emitted, now from the ONE
    /// shared writer. `fm_capture_serialized_len` reports the stream length.
    #[unsafe(no_mangle)]
    pub extern "C" fn fm_capture_serialize(owner_id: u32, segment_data_bytes: usize) -> usize {
        let built = (|| -> Result<Vec<u8>, Errno> {
            let g = capture_builder()?;
            let writer = ReferenceSegmentsWriter::new(owner_id, segment_data_bytes)?;
            let mut stream: Vec<u8> = Vec::new();
            let mut sink =
                |kind: u16, activation_id: u32, owner: u32, payload: &[u8]| -> Result<(), Errno> {
                    let len = u32::try_from(payload.len()).map_err(|_| Errno::EINVAL)?;
                    stream.extend_from_slice(&kind.to_le_bytes());
                    stream.extend_from_slice(&0u16.to_le_bytes());
                    stream.extend_from_slice(&activation_id.to_le_bytes());
                    stream.extend_from_slice(&owner.to_le_bytes());
                    stream.extend_from_slice(&len.to_le_bytes());
                    stream.extend_from_slice(payload);
                    Ok(())
                };
            writer.write(&mut sink, g)?;
            Ok(stream)
        })();
        match built {
            Ok(stream) => {
                let ptr = stream.as_ptr() as usize;
                // SAFETY: single-threaded per worker; root the bytes so the
                // returned pointer stays valid while the host drains the records.
                unsafe {
                    *CAPTURE_SERIALIZED.0.get() = Some(stream);
                }
                set_ok();
                ptr
            }
            Err(e) => {
                set_err(e);
                0
            }
        }
    }

    /// The byte length of the record stream `fm_capture_serialize` last produced,
    /// or 0 if none is live. The header of each record is `CAPTURE_RECORD_HEADER`.
    #[unsafe(no_mangle)]
    pub extern "C" fn fm_capture_serialized_len() -> usize {
        // SAFETY: single-threaded per worker.
        match unsafe { &*CAPTURE_SERIALIZED.0.get() } {
            Some(stream) => stream.len(),
            None => 0,
        }
    }

    /// The record-stream header size (bytes) preceding each record's payload.
    #[unsafe(no_mangle)]
    pub extern "C" fn fm_capture_record_header_size() -> i32 {
        CAPTURE_RECORD_HEADER as i32
    }

    /// Monotonic count of coordinates the module has interned into the shared
    /// capture builder since worker start (Path B P3). Proof-of-use for the
    /// CAPTURE flip: a value greater than its pre-fork reading proves the parent
    /// routed reference capture through the ONE shared builder; a silent fallback
    /// to the TypeScript capture graph leaves it unchanged. Never resets.
    #[unsafe(no_mangle)]
    pub extern "C" fn fm_capture_interned() -> i64 {
        CAPTURE_INTERNED.load(Ordering::Relaxed) as i64
    }

    // -- Module-owned wire-graph decode + scan + restore exports (orchestration
    //    migration increment 1) -------------------------------------------------
    //
    // Additive `fm_*` surfaces over the EXISTING `fork_codec` decode/replay/drive
    // engine (`reference_segments.rs` decode, `reference_replay.rs` driver/feed,
    // `drive_plan.rs` build_drive_plan). They let a later host-rewire increment
    // retire the TypeScript wire-graph decode (`fork-reference-segments.ts`),
    // externref-handle scan (`scanSegmentedForkReferenceExternrefHandles`), and
    // replay ENTRY wrapper (`restoreModuleState`/`materializeAllTyped`), routing
    // all three through the ONE shared engine that already backs
    // `fm_begin_reference_replay`. The wire format is FROZEN — these carry no new
    // algorithm and no new engine-floor seam.

    /// Decode the sealed KFMS module-state arena rooted at `module_state_root`
    /// into the module-owned decoded reference graph. Returns the graph's node
    /// count (`>= 0`) or `-1` (reason in `fm_last_errno`). The decoded graph
    /// stays resident for `fm_scan_externref_handles` and `fm_decoded_node_count`
    /// until the next decode or replay. See `decode_reference_graph_impl`.
    #[unsafe(no_mangle)]
    pub extern "C" fn fm_decode_reference_graph(module_state_root: usize) -> i32 {
        match decode_reference_graph_impl(module_state_root as u64) {
            Ok(count) if count <= i32::MAX as u32 => {
                set_ok();
                count as i32
            }
            Ok(_) => {
                set_err(Errno::EINVAL);
                -1
            }
            Err(e) => {
                set_err(e);
                -1
            }
        }
    }

    /// The node count of the resident decoded graph (`fm_decode_reference_graph`
    /// result), or `-1` if none is resident. Lets the host size the
    /// `fm_scan_externref_handles` destination buffer without re-decoding.
    #[unsafe(no_mangle)]
    pub extern "C" fn fm_decoded_node_count() -> i32 {
        match decoded_graph().as_ref() {
            Some(t) => match i32::try_from(t.nodes.len()) {
                Ok(n) => {
                    set_ok();
                    n
                }
                Err(_) => {
                    set_err(Errno::EINVAL);
                    -1
                }
            },
            None => {
                set_err(Errno::EINVAL);
                -1
            }
        }
    }

    /// Scan the resident decoded graph for its distinct externref broker handles,
    /// writing them as a little-endian `u32` array into guest memory at `dst_ptr`
    /// (capacity `dst_cap` u32 elements), and return the count (`>= 0`) or `-1`
    /// (reason in `fm_last_errno`). See `scan_externref_handles_impl`.
    #[unsafe(no_mangle)]
    pub extern "C" fn fm_scan_externref_handles(dst_ptr: usize, dst_cap: usize) -> i32 {
        match scan_externref_handles_impl(dst_ptr, dst_cap) {
            Ok(count) if count <= i32::MAX as u32 => {
                set_ok();
                count as i32
            }
            Ok(_) => {
                set_err(Errno::EINVAL);
                -1
            }
            Err(e) => {
                set_err(e);
                -1
            }
        }
    }

    /// Seed the reference replay driver/feed AND build the drive plan from the
    /// KFMS arena rooted at `module_state_root` in one call, returning the drive
    /// plan's guest address (0 on failure; reason in `fm_last_errno`). The step
    /// count is read from `fm_gc_plan_count`. This is the replay-orchestration
    /// ENTRY that collapses the JS `beginReferenceReplay` + `restoreModuleState`
    /// wrapper into the module. See `restore_from_arena_impl`.
    #[unsafe(no_mangle)]
    pub extern "C" fn fm_restore_from_arena(module_state_root: usize, pid: u32) -> usize {
        match restore_from_arena_impl(module_state_root as u64, pid) {
            Ok(ptr) => {
                set_ok();
                ptr
            }
            Err(e) => {
                set_err(e);
                0
            }
        }
    }

    /// Child-install ENTRY for a COW (`fork`/`posix_spawn`) module-backed child:
    /// seed the reference replay driver AND build the drive plan whose tail drives
    /// every activation's guest restore/finish install through the module (see
    /// `attach_from_arena_impl`). Returns the plan's guest address (0 on failure;
    /// reason in `fm_last_errno`); the step count is read from `fm_gc_plan_count`.
    /// Supersedes a separate `fm_restore_from_arena` call on the module-on child
    /// attach path: it does the same reconstruction seed + plan build and then
    /// appends the module-owned restore/finish sequencing.
    #[unsafe(no_mangle)]
    pub extern "C" fn fm_attach_child(module_state_root: usize, pid: u32) -> usize {
        match attach_from_arena_impl(module_state_root as u64, pid) {
            Ok(ptr) => {
                set_ok();
                ptr
            }
            Err(e) => {
                set_err(e);
                0
            }
        }
    }

    /// Child-install ENTRY for a vfork BORROWED module-backed child. The install
    /// plan is byte-identical to `fm_attach_child`: the reconstructed reference
    /// values and the guest restore/finish sequencing are the same for a borrowed
    /// child as for a COW child. The only borrowed-specific work — reserving the
    /// child-private replay prefix so the guest's rewind never writes the parked
    /// parent's storage — is raw host memory management (no reference values), so it
    /// stays on the host and this entry delegates to the shared install impl. It is
    /// a distinct export so the host has a named borrowed entry point and any future
    /// borrowed-specific install divergence has a home.
    #[unsafe(no_mangle)]
    pub extern "C" fn fm_attach_borrowed_child(module_state_root: usize, pid: u32) -> usize {
        match attach_from_arena_impl(module_state_root as u64, pid) {
            Ok(ptr) => {
                set_ok();
                ptr
            }
            Err(e) => {
                set_err(e);
                0
            }
        }
    }

    /// Monotonic count of reference graphs the module has DECODED from a KFMS
    /// arena since worker start (orchestration migration increment 1).
    /// Proof-of-use for the decode flip: a value greater than its pre-fork
    /// reading proves the host routed wire-graph decode through the module; a
    /// silent fallback to the TypeScript `decodeSegmentedForkReferenceTransaction`
    /// leaves it unchanged. Never resets.
    #[unsafe(no_mangle)]
    pub extern "C" fn fm_reference_graphs_decoded() -> i64 {
        REFERENCE_GRAPHS_DECODED.load(Ordering::Relaxed) as i64
    }

    /// Monotonic count of externref handles the module has SCANNED out of decoded
    /// graphs since worker start (orchestration migration increment 1).
    /// Proof-of-use for the scan flip: a value greater than its pre-fork reading
    /// proves the host routed the pre-launch externref-handle scan through the
    /// module; a silent fallback to the TypeScript
    /// `scanSegmentedForkReferenceExternrefHandles` leaves it unchanged. Never
    /// resets.
    #[unsafe(no_mangle)]
    pub extern "C" fn fm_externref_handles_scanned() -> i64 {
        EXTERNREF_HANDLES_SCANNED.load(Ordering::Relaxed) as i64
    }

    /// The sticky errno of the most recent export call (0 == success).
    #[unsafe(no_mangle)]
    pub extern "C" fn fm_last_errno() -> i32 {
        LAST_ERRNO.load(Ordering::Relaxed)
    }

}
