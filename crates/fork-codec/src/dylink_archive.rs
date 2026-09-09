//! Decoder for the KFLA dylink-fork archive memory image.
//!
//! Ported from `host/src/dylink-fork-archive.ts` (`DylinkForkArchive`,
//! specifically its `ensureIndexed` -> `readModule` / `readTransaction` /
//! `readTablePatch` read path, plus `decodeProviderDependencies` and the
//! per-record `validate*` structural checks). This is the archive a process
//! copies through linear memory when it forks after having `dlopen`ed shared
//! side modules: it names every live side module (its immutable Wasm bytes,
//! memory/table/TLS bases, allocator mappings, runtime-provider edges,
//! refcount, and any in-flight initialization), every staged loader
//! transaction, the sealed typed-table checkpoint root, and the bounded funcref
//! table-patch journal published after that checkpoint.
//!
//! Layout recap (all little-endian; every stored pointer and size is a full
//! `u64` byte offset into the guest linear memory regardless of pointer width,
//! matching the TS `writeU64`/`readU64`):
//!
//! Archive header (KFLA, 104 bytes at `head`): `+0` magic `KFLA`, `+4` version
//! (4), `+6` header size (104), `+8` pointer width (4 or 8), `+9..16` reserved
//! zero, `+16` next handle, `+24` module count (u32), `+28` header flags (0),
//! `+32` first module ptr, `+40` publication generation, `+48` table-state root
//! (a sealed KFMS arena address, opaque here), `+56` first table patch ptr,
//! `+64` last table patch ptr, `+72` table patch count (u32), `+76` declared
//! table patch bytes (u32), `+80` table checkpoint generation, `+88`
//! transaction count (u32), `+92` transaction flags (0), `+96` first
//! transaction ptr.
//!
//! Module record (KFLM, 136-byte header): `+0` magic `KFLM`, `+4` version (5),
//! `+6` header size (136), `+8` next ptr, `+16` total (record) size, `+24`
//! memory base, `+32` table base, `+40` TLS base (0 = none), `+48` activation
//! id (u32, 0 = none), `+52` handle (u32, 0 = none), `+56` refcount (u32),
//! `+60` name length (u32), `+64` module bytes length (u32), `+68` flags (u32:
//! initializing | global | committed-global-root), `+72..104` SHA-256 module
//! template digest, `+104` initialization transaction token (u32), `+108`
//! initialization stage code (u32), `+112` initialization table index, `+120`
//! provider bytes length (u32), `+124` provider count (u32), `+128` allocation
//! bytes length (u32), `+132` allocation count (u32). Payload: name (padded to
//! 8), module bytes (padded to 8), provider blob (padded to 8), then
//! `allocation count` 32-byte allocation descriptors (`address`, `size`,
//! `mappingAddress`, `mappingSize`). The provider blob is a run of `(u32 len,
//! utf-8 bytes)` names in strictly ascending order.
//!
//! Transaction record (KFLT, 80-byte header): `+0` magic `KFLT`, `+4` version
//! (2), `+6` header size (80), `+8` next ptr, `+16` total size, `+24` token
//! (u32), `+28` name length (u32), `+32` module bytes length (u32), `+36` flags
//! (u32: global), `+40..72` SHA-256 digest. Payload: name (padded to 8) then
//! module bytes.
//!
//! Table patch record (KFJP, 64-byte header): `+0` magic `KFJP`, `+4` version
//! (1), `+6` header size (64), `+8` next ptr, `+16` total size, `+24`
//! generation, `+32` activation id (u32), `+36` owner id (u32), `+40` start,
//! `+48` table length, `+56` run count (u32), `+60` reserved (0). Payload:
//! `run count` 24-byte runs (`length`, `kind` u32 with 0 = null / 1 = function,
//! `activationId` u32, `ordinal` u32, reserved u32).
//!
//! Like the other Phase 6 D1 decoders this validates the STRUCTURAL image only:
//! the pointer-linked record chains, per-record framing, and the cross-record
//! integrity the TS reader enforces before it exposes any bytes (magic /
//! version / size agreement, cycle and overlap rejection, duplicate identity
//! rejection, handle-range and initialization consistency, monotonic table
//! patch generations, and provider/transaction referential closure). It
//! materializes every pure-byte field: names, module bytes, allocation
//! descriptors, provider names, table-patch runs, and the raw 32-byte digest.
//!
//! The LIVE half is a separate follow-on increment for the co-resident module
//! (Phase 6 D5+): recomputing and verifying each record's SHA-256 template
//! digest, actually compiling/instantiating each side module, allocating its
//! real memory/table/TLS bases, applying GOT relocations, and re-establishing
//! funcref identity from the table checkpoint and patch journal. This decoder
//! reproduces the archive IMAGE and its structural invariants; it does not
//! recompute the cryptographic digest and it exposes the table-state root as an
//! opaque pointer rather than walking the KFMS arena it names.

use wasm_posix_shared::Errno;

use alloc::collections::{BTreeMap, BTreeSet};
use alloc::string::String;
use alloc::vec::Vec;

// Structural constants (KFLA is a TypeScript-only wire format; unlike KFMS it
// has no mirror in crates/shared, so its constants live here next to the
// decoder, matching host/src/dylink-fork-archive.ts).
const ARCHIVE_MAGIC: u32 = 0x414c_464b; // "KFLA"
const ARCHIVE_VERSION: u16 = 4;
const ARCHIVE_HEADER_SIZE: u64 = 104;

const MODULE_MAGIC: u32 = 0x4d4c_464b; // "KFLM"
const MODULE_VERSION: u16 = 5;
const MODULE_HEADER_SIZE: u64 = 136;
const MODULE_DIGEST_OFFSET: u64 = 72;
const MODULE_DIGEST_SIZE: usize = 32;
const MODULE_ALLOCATION_SIZE: u64 = 32;
const MODULE_FLAG_INITIALIZING: u32 = 1;
const MODULE_FLAG_GLOBAL: u32 = 1 << 1;
const MODULE_FLAG_COMMITTED_GLOBAL_ROOT: u32 = 1 << 2;
const MODULE_FLAG_KNOWN_MASK: u32 =
    MODULE_FLAG_INITIALIZING | MODULE_FLAG_GLOBAL | MODULE_FLAG_COMMITTED_GLOBAL_ROOT;

const TRANSACTION_MAGIC: u32 = 0x544c_464b; // "KFLT"
const TRANSACTION_VERSION: u16 = 2;
const TRANSACTION_HEADER_SIZE: u64 = 80;
const TRANSACTION_DIGEST_OFFSET: u64 = 40;
const TRANSACTION_FLAG_GLOBAL: u32 = 1;

const TABLE_PATCH_MAGIC: u32 = 0x504a_464b; // "KFJP"
const TABLE_PATCH_VERSION: u16 = 1;
const TABLE_PATCH_HEADER_SIZE: u64 = 64;
const TABLE_PATCH_RUN_SIZE: u64 = 24;
const MAX_TABLE_PATCH_RECORDS: u32 = 256;
const MAX_TABLE_PATCH_BYTES: u32 = 1024 * 1024;

const FIRST_DYLINK_HANDLE: u64 = 2;
const EXHAUSTED_DYLINK_HANDLE: u64 = 0x1_0000_0000;

/// The exact-integer ceiling the TS controller enforces on every stored `u64`
/// (`Number.MAX_SAFE_INTEGER`, `2^53 - 1`). Larger values cannot round-trip
/// through the host's Number-based reader, so the wire format never emits them
/// and the decoder rejects them, mirroring `readU64`.
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

/// Initialization stage of an in-flight `dlopen`. Mirrors the TS
/// `DylinkInitializationStage` string union.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DylinkInitializationStage {
    Bootstrap,
    Relocations,
    Constructors,
}

/// One durable continuation point for a libc-driven initialization call.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DylinkInitialization {
    pub transaction_token: u32,
    pub stage: DylinkInitializationStage,
    pub table_index: u64,
}

/// Exact allocator ownership copied into a fork child: the logical allocation
/// and the process mapping that backs it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DylinkAllocation {
    pub address: u64,
    pub size: u64,
    pub mapping_address: u64,
    pub mapping_size: u64,
}

/// One archived side module (KFLM record), materialized field-for-field from
/// the `DylinkForkLibraryState` the TS reader reconstructs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DylinkModule {
    pub name: String,
    pub module_bytes: Vec<u8>,
    /// Raw SHA-256 template digest bytes as stored; NOT recomputed here.
    pub digest: [u8; MODULE_DIGEST_SIZE],
    pub memory_base: u64,
    pub table_base: u64,
    pub tls_base: Option<u64>,
    pub activation_id: Option<u32>,
    pub handle: Option<u32>,
    pub ref_count: Option<u32>,
    pub global_visibility: bool,
    pub committed_global_root: bool,
    pub provider_dependencies: Vec<String>,
    pub allocations: Vec<DylinkAllocation>,
    pub initialization: Option<DylinkInitialization>,
}

/// One staged loader transaction (KFLT record).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DylinkTransaction {
    pub token: u32,
    pub name: String,
    pub module_bytes: Vec<u8>,
    /// Raw SHA-256 digest bytes as stored; NOT recomputed here.
    pub digest: [u8; MODULE_DIGEST_SIZE],
    pub global_visibility: bool,
}

/// A single funcref coordinate inside a table-patch run.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DylinkTableFunction {
    pub activation_id: u32,
    pub ordinal: u32,
}

/// One run within a table patch: `length` consecutive slots set to `function`
/// (or cleared to null when `function` is `None`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DylinkTablePatchRun {
    pub length: u64,
    pub function: Option<DylinkTableFunction>,
}

/// One published funcref table patch (KFJP record).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DylinkTablePatch {
    pub generation: u64,
    pub activation_id: u32,
    pub owner_id: u32,
    pub start: u64,
    pub table_length: u64,
    pub runs: Vec<DylinkTablePatchRun>,
}

/// The fully decoded dylink-fork archive image: the validated header scalars
/// plus every record chain in archive (publication) order, matching what
/// `DylinkForkArchive.read()` yields.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DylinkArchive {
    pub pointer_width: u8,
    pub generation: u64,
    pub next_handle: u64,
    /// Sealed table-state KFMS arena address, or 0 before the first checkpoint.
    pub table_state_root: u64,
    pub table_checkpoint_generation: u64,
    pub modules: Vec<DylinkModule>,
    pub transactions: Vec<DylinkTransaction>,
    pub table_patches: Vec<DylinkTablePatch>,
}

/// A half-open `[start, end)` byte interval of archive storage.
#[derive(Clone, Copy)]
struct Interval {
    start: u64,
    end: u64,
}

/// Bounds-checked little-endian `u8` read.
fn r_u8(mem: &[u8], off: u64) -> Result<u8, Errno> {
    let off = usize::try_from(off).map_err(|_| Errno::EINVAL)?;
    mem.get(off).copied().ok_or(Errno::EINVAL)
}

/// Bounds-checked little-endian `u16` read.
fn r_u16(mem: &[u8], off: u64) -> Result<u16, Errno> {
    let off = usize::try_from(off).map_err(|_| Errno::EINVAL)?;
    let end = off.checked_add(2).ok_or(Errno::EINVAL)?;
    let slice = mem.get(off..end).ok_or(Errno::EINVAL)?;
    Ok(u16::from_le_bytes([slice[0], slice[1]]))
}

/// Bounds-checked little-endian `u32` read.
fn r_u32(mem: &[u8], off: u64) -> Result<u32, Errno> {
    let off = usize::try_from(off).map_err(|_| Errno::EINVAL)?;
    let end = off.checked_add(4).ok_or(Errno::EINVAL)?;
    let slice = mem.get(off..end).ok_or(Errno::EINVAL)?;
    Ok(u32::from_le_bytes([slice[0], slice[1], slice[2], slice[3]]))
}

/// Bounds-checked little-endian `u64` read that rejects values above the host's
/// exact-integer ceiling. Mirrors the TS `readU64`.
fn r_u64(mem: &[u8], off: u64) -> Result<u64, Errno> {
    let off = usize::try_from(off).map_err(|_| Errno::EINVAL)?;
    let end = off.checked_add(8).ok_or(Errno::EINVAL)?;
    let slice = mem.get(off..end).ok_or(Errno::EINVAL)?;
    let value = u64::from_le_bytes([
        slice[0], slice[1], slice[2], slice[3], slice[4], slice[5], slice[6], slice[7],
    ]);
    if value > MAX_SAFE_INTEGER {
        return Err(Errno::EINVAL);
    }
    Ok(value)
}

/// Read a fixed byte range, bounds-checked.
fn r_bytes(mem: &[u8], off: u64, len: u64) -> Result<&[u8], Errno> {
    let off = usize::try_from(off).map_err(|_| Errno::EINVAL)?;
    let len = usize::try_from(len).map_err(|_| Errno::EINVAL)?;
    let end = off.checked_add(len).ok_or(Errno::EINVAL)?;
    mem.get(off..end).ok_or(Errno::EINVAL)
}

/// `Math.ceil(value / 8) * 8`, checked. Mirrors the TS `align8`.
fn align8(value: u64) -> Result<u64, Errno> {
    let rem = value % 8;
    if rem == 0 {
        Ok(value)
    } else {
        value.checked_add(8 - rem).ok_or(Errno::EINVAL)
    }
}

/// `addr + size`, rejecting overflow.
fn checked_end(addr: u64, size: u64) -> Result<u64, Errno> {
    addr.checked_add(size).ok_or(Errno::EINVAL)
}

/// Require `[addr, addr+size)` to lie within `[1, mem_len]`. Mirrors the TS
/// `checkedRange` (address strictly positive, `size > 0`, no overflow).
fn checked_range(addr: u64, size: u64, mem_len: u64) -> Result<(), Errno> {
    if addr == 0 || size == 0 {
        return Err(Errno::EINVAL);
    }
    let end = checked_end(addr, size)?;
    if end > mem_len {
        return Err(Errno::EINVAL);
    }
    Ok(())
}

/// Decode a UTF-8 string of `len` bytes at `off`, rejecting invalid UTF-8.
fn decode_utf8(mem: &[u8], off: u64, len: u64) -> Result<String, Errno> {
    let bytes = r_bytes(mem, off, len)?;
    core::str::from_utf8(bytes)
        .map(String::from)
        .map_err(|_| Errno::EINVAL)
}

/// Register `[start, end)` after confirming it overlaps no prior interval.
/// Mirrors the TS interval-overlap guard shared across record decoders.
fn push_interval(intervals: &mut Vec<Interval>, start: u64, end: u64) -> Result<(), Errno> {
    for interval in intervals.iter() {
        if start < interval.end && interval.start < end {
            return Err(Errno::EINVAL);
        }
    }
    intervals.push(Interval { start, end });
    Ok(())
}

/// Decode the strictly-ascending provider-dependency blob. Mirrors the TS
/// `decodeProviderDependencies`.
fn decode_provider_dependencies(
    mem: &[u8],
    base: u64,
    byte_len: u64,
    count: u32,
) -> Result<Vec<String>, Errno> {
    let mut names: Vec<String> = Vec::new();
    let mut cursor = 0u64;
    for _ in 0..count {
        // Need at least the 4-byte length prefix.
        if cursor.checked_add(4).ok_or(Errno::EINVAL)? > byte_len {
            return Err(Errno::EINVAL);
        }
        let length = r_u32(mem, checked_end(base, cursor)?)? as u64;
        cursor += 4;
        if length == 0 || checked_end(cursor, length)? > byte_len {
            return Err(Errno::EINVAL);
        }
        let name = decode_utf8(mem, checked_end(base, cursor)?, length)?;
        if names
            .last()
            .is_some_and(|previous| previous.as_str() >= name.as_str())
        {
            return Err(Errno::EINVAL); // noncanonical ordering
        }
        names.push(name);
        cursor += length;
    }
    if cursor != byte_len {
        return Err(Errno::EINVAL); // trailing bytes
    }
    Ok(names)
}

fn decode_stage(code: u32) -> Result<DylinkInitializationStage, Errno> {
    match code {
        1 => Ok(DylinkInitializationStage::Bootstrap),
        2 => Ok(DylinkInitializationStage::Relocations),
        3 => Ok(DylinkInitializationStage::Constructors),
        _ => Err(Errno::EINVAL),
    }
}

/// Decode the dylink-fork archive rooted at `head`.
///
/// `memory` is the guest linear memory; `head` is the absolute byte offset of
/// the KFLA archive header (the value the process stores in its dylink fork
/// state slot, i.e. what the TS `readHead` returns). `pointer_width` is the
/// process pointer width (4 or 8) and must match the width byte the archive
/// records. Returns the validated header scalars and every record chain in
/// publication order. Malformed input yields `Err(Errno::EINVAL)`; the function
/// never panics.
///
/// The archive must be PUBLISHED: `head` names a real header whose generation
/// is nonzero. An unpublished/empty slot (`head == 0`) is out of scope for this
/// image decoder and rejected.
pub fn decode_dylink_archive(
    memory: &[u8],
    head: u64,
    pointer_width: u8,
) -> Result<DylinkArchive, Errno> {
    if pointer_width != 4 && pointer_width != 8 {
        return Err(Errno::EINVAL);
    }
    let mem_len = memory.len() as u64;
    checked_range(head, ARCHIVE_HEADER_SIZE, mem_len)?;

    if r_u32(memory, head)? != ARCHIVE_MAGIC
        || r_u16(memory, head + 4)? != ARCHIVE_VERSION
        || r_u16(memory, head + 6)? != ARCHIVE_HEADER_SIZE as u16
        || r_u8(memory, head + 8)? != pointer_width
    {
        return Err(Errno::EINVAL);
    }
    for off in 9..16 {
        if r_u8(memory, head + off)? != 0 {
            return Err(Errno::EINVAL);
        }
    }

    let next_handle = r_u64(memory, head + 16)?;
    if !(FIRST_DYLINK_HANDLE..=EXHAUSTED_DYLINK_HANDLE).contains(&next_handle) {
        return Err(Errno::EINVAL);
    }
    let count = r_u32(memory, head + 24)?;
    let max_physical_modules = mem_len.saturating_sub(ARCHIVE_HEADER_SIZE) / MODULE_HEADER_SIZE;
    if count as u64 > max_physical_modules {
        return Err(Errno::EINVAL);
    }
    if r_u32(memory, head + 28)? != 0 {
        return Err(Errno::EINVAL);
    }
    let mut module_cursor = r_u64(memory, head + 32)?;
    let generation = r_u64(memory, head + 40)?;
    if generation == 0 {
        return Err(Errno::EINVAL);
    }
    let table_state_root = r_u64(memory, head + 48)?;
    if table_state_root != 0 {
        checked_range(table_state_root, 1, mem_len)?;
    }
    let mut table_patch_cursor = r_u64(memory, head + 56)?;
    let table_patch_tail = r_u64(memory, head + 64)?;
    let table_patch_count = r_u32(memory, head + 72)?;
    let declared_table_patch_bytes = r_u32(memory, head + 76)?;
    let table_checkpoint_generation = r_u64(memory, head + 80)?;
    let transaction_count = r_u32(memory, head + 88)?;
    if r_u32(memory, head + 92)? != 0 {
        return Err(Errno::EINVAL);
    }
    let mut transaction_cursor = r_u64(memory, head + 96)?;

    let max_physical_transactions =
        mem_len.saturating_sub(ARCHIVE_HEADER_SIZE) / TRANSACTION_HEADER_SIZE;
    if transaction_count as u64 > max_physical_transactions {
        return Err(Errno::EINVAL);
    }
    if (transaction_count == 0) != (transaction_cursor == 0) {
        return Err(Errno::EINVAL);
    }
    if table_checkpoint_generation > generation
        || (table_state_root == 0) != (table_checkpoint_generation == 0)
    {
        return Err(Errno::EINVAL);
    }
    if table_patch_count > MAX_TABLE_PATCH_RECORDS
        || declared_table_patch_bytes > MAX_TABLE_PATCH_BYTES
    {
        return Err(Errno::EINVAL);
    }
    if (table_patch_count == 0) != (table_patch_cursor == 0 && table_patch_tail == 0) {
        return Err(Errno::EINVAL);
    }
    if (count == 0) != (module_cursor == 0) {
        return Err(Errno::EINVAL);
    }

    let mut intervals: Vec<Interval> = Vec::new();
    intervals.push(Interval {
        start: head,
        end: head + ARCHIVE_HEADER_SIZE,
    });
    let mut seen_addresses: BTreeSet<u64> = BTreeSet::new();

    // --- Modules --------------------------------------------------------
    let mut modules: Vec<DylinkModule> = Vec::new();
    let mut seen_names: BTreeSet<String> = BTreeSet::new();
    let mut seen_activations: BTreeSet<u32> = BTreeSet::new();
    let mut seen_handles: BTreeSet<u32> = BTreeSet::new();
    for _ in 0..count {
        if module_cursor == 0 || !seen_addresses.insert(module_cursor) {
            return Err(Errno::EINVAL); // cyclic or truncated
        }
        let module = read_module(
            memory,
            module_cursor,
            mem_len,
            next_handle,
            &mut intervals,
        )?;
        if !seen_names.insert(module.name.clone()) {
            return Err(Errno::EINVAL); // duplicate module name
        }
        if module
            .activation_id
            .is_some_and(|activation| !seen_activations.insert(activation))
        {
            return Err(Errno::EINVAL); // duplicate activation
        }
        if module
            .handle
            .is_some_and(|handle| !seen_handles.insert(handle))
        {
            return Err(Errno::EINVAL); // duplicate handle
        }
        module_cursor = r_u64(memory, checked_end(module_cursor, 8)?)?;
        modules.push(module);
    }
    if module_cursor != 0 {
        return Err(Errno::EINVAL); // more records than declared
    }

    // --- Transactions ---------------------------------------------------
    let mut transactions: Vec<DylinkTransaction> = Vec::new();
    let mut seen_tokens: BTreeSet<u32> = BTreeSet::new();
    for _ in 0..transaction_count {
        if transaction_cursor == 0 || !seen_addresses.insert(transaction_cursor) {
            return Err(Errno::EINVAL);
        }
        let transaction = read_transaction(memory, transaction_cursor, mem_len, &mut intervals)?;
        if !seen_tokens.insert(transaction.token) {
            return Err(Errno::EINVAL); // duplicate transaction token
        }
        transaction_cursor = r_u64(memory, checked_end(transaction_cursor, 8)?)?;
        transactions.push(transaction);
    }
    if transaction_cursor != 0 {
        return Err(Errno::EINVAL);
    }

    // --- Table patch journal --------------------------------------------
    let mut table_patches: Vec<DylinkTablePatch> = Vec::new();
    let mut previous_patch_generation = table_checkpoint_generation;
    let mut table_patch_bytes = 0u64;
    let mut last_patch_addr = 0u64;
    for _ in 0..table_patch_count {
        if table_patch_cursor == 0 || !seen_addresses.insert(table_patch_cursor) {
            return Err(Errno::EINVAL);
        }
        let (patch, size) = read_table_patch(memory, table_patch_cursor, mem_len, &mut intervals)?;
        if patch.generation <= previous_patch_generation || patch.generation > generation {
            return Err(Errno::EINVAL); // non-monotonic generation
        }
        previous_patch_generation = patch.generation;
        table_patch_bytes = checked_end(table_patch_bytes, size)?;
        if table_patch_bytes > MAX_TABLE_PATCH_BYTES as u64 {
            return Err(Errno::EINVAL);
        }
        last_patch_addr = table_patch_cursor;
        table_patch_cursor = r_u64(memory, checked_end(table_patch_cursor, 8)?)?;
        table_patches.push(patch);
    }
    if table_patch_cursor != 0 {
        return Err(Errno::EINVAL);
    }
    if last_patch_addr != table_patch_tail
        || table_patch_bytes != declared_table_patch_bytes as u64
    {
        return Err(Errno::EINVAL);
    }

    // --- Cross-record referential closure -------------------------------
    // Runtime-provider edges and initialization tokens must resolve to present
    // records, and every staged transaction must be claimed by exactly one
    // initialization. Mirrors the TS `validateState`.
    for module in &modules {
        for dependency in &module.provider_dependencies {
            if !seen_names.contains(dependency) {
                return Err(Errno::EINVAL);
            }
        }
    }
    let mut initialization_counts: BTreeMap<u32, u32> = BTreeMap::new();
    for module in &modules {
        if let Some(init) = &module.initialization {
            if !seen_tokens.contains(&init.transaction_token) {
                return Err(Errno::EINVAL);
            }
            *initialization_counts.entry(init.transaction_token).or_insert(0) += 1;
        }
    }
    for transaction in &transactions {
        if initialization_counts.get(&transaction.token) != Some(&1) {
            return Err(Errno::EINVAL);
        }
    }

    // Process mappings owned by archived modules must not overlap archive
    // storage (the header or any record). Mirrors the TS mapping/storage guard.
    for module in &modules {
        for allocation in &module.allocations {
            let start = allocation.mapping_address;
            let end = checked_end(start, allocation.mapping_size)?;
            for interval in &intervals {
                if start < interval.end && interval.start < end {
                    return Err(Errno::EINVAL);
                }
            }
        }
    }

    Ok(DylinkArchive {
        pointer_width,
        generation,
        next_handle,
        table_state_root,
        table_checkpoint_generation,
        modules,
        transactions,
        table_patches,
    })
}

/// Decode and validate one KFLM module record. Mirrors the TS `readModule`
/// plus the structural half of `validateLibrary` / `canonicalMemoryAllocations`.
fn read_module(
    memory: &[u8],
    address: u64,
    mem_len: u64,
    next_handle: u64,
    intervals: &mut Vec<Interval>,
) -> Result<DylinkModule, Errno> {
    checked_range(address, MODULE_HEADER_SIZE, mem_len)?;
    if r_u32(memory, address)? != MODULE_MAGIC
        || r_u16(memory, address + 4)? != MODULE_VERSION
        || r_u16(memory, address + 6)? != MODULE_HEADER_SIZE as u16
    {
        return Err(Errno::EINVAL);
    }
    let allocation_size = r_u64(memory, address + 16)?;
    let name_length = r_u32(memory, address + 60)? as u64;
    let bytes_length = r_u32(memory, address + 64)? as u64;
    let provider_bytes_length = r_u32(memory, address + 120)? as u64;
    let provider_count = r_u32(memory, address + 124)?;
    let allocation_bytes_length = r_u32(memory, address + 128)? as u64;
    let allocation_count = r_u32(memory, address + 132)?;
    if allocation_bytes_length != allocation_count as u64 * MODULE_ALLOCATION_SIZE {
        return Err(Errno::EINVAL);
    }
    let expected_size = MODULE_HEADER_SIZE
        + align8(name_length)?
        + align8(bytes_length)?
        + align8(provider_bytes_length)?
        + allocation_bytes_length;
    if allocation_size != expected_size {
        return Err(Errno::EINVAL);
    }
    checked_range(address, allocation_size, mem_len)?;
    let end = checked_end(address, allocation_size)?;
    push_interval(intervals, address, end)?;

    let flags = r_u32(memory, address + 68)?;
    if flags & !MODULE_FLAG_KNOWN_MASK != 0 {
        return Err(Errno::EINVAL);
    }

    let name_off = checked_end(address, MODULE_HEADER_SIZE)?;
    let name = decode_utf8(memory, name_off, name_length)?;
    if name.is_empty() {
        return Err(Errno::EINVAL);
    }
    let bytes_off = checked_end(name_off, align8(name_length)?)?;
    let module_bytes = r_bytes(memory, bytes_off, bytes_length)?.to_vec();
    let provider_off = checked_end(bytes_off, align8(bytes_length)?)?;
    let provider_dependencies =
        decode_provider_dependencies(memory, provider_off, provider_bytes_length, provider_count)?;

    let allocation_off = checked_end(provider_off, align8(provider_bytes_length)?)?;
    let mut allocations: Vec<DylinkAllocation> = Vec::new();
    let mut previous_mapping_end = 0u64;
    for index in 0..allocation_count as u64 {
        let off = checked_end(allocation_off, index * MODULE_ALLOCATION_SIZE)?;
        let allocation = DylinkAllocation {
            address: r_u64(memory, off)?,
            size: r_u64(memory, checked_end(off, 8)?)?,
            mapping_address: r_u64(memory, checked_end(off, 16)?)?,
            mapping_size: r_u64(memory, checked_end(off, 24)?)?,
        };
        // canonicalMemoryAllocations: strictly positive fields, the logical
        // allocation nested inside its mapping, canonical (ascending, gap-free)
        // mapping order, and the mapping inside linear memory.
        if allocation.address == 0
            || allocation.size == 0
            || allocation.mapping_address == 0
            || allocation.mapping_size == 0
            || allocation.address < allocation.mapping_address
        {
            return Err(Errno::EINVAL);
        }
        let logical_end = checked_end(allocation.address, allocation.size)?;
        let mapping_end = checked_end(allocation.mapping_address, allocation.mapping_size)?;
        if logical_end > mapping_end
            || allocation.mapping_address < previous_mapping_end
            || mapping_end > mem_len
        {
            return Err(Errno::EINVAL);
        }
        previous_mapping_end = mapping_end;
        allocations.push(allocation);
    }

    let mut digest = [0u8; MODULE_DIGEST_SIZE];
    digest.copy_from_slice(r_bytes(
        memory,
        checked_end(address, MODULE_DIGEST_OFFSET)?,
        MODULE_DIGEST_SIZE as u64,
    )?);

    let activation_raw = r_u32(memory, address + 48)?;
    let handle_raw = r_u32(memory, address + 52)?;
    let ref_count_raw = r_u32(memory, address + 56)?;
    if (handle_raw == 0) != (ref_count_raw == 0) {
        return Err(Errno::EINVAL);
    }
    let handle = if handle_raw == 0 {
        None
    } else {
        if (handle_raw as u64) < FIRST_DYLINK_HANDLE || handle_raw as u64 >= next_handle {
            return Err(Errno::EINVAL);
        }
        Some(handle_raw)
    };

    let memory_base = r_u64(memory, address + 24)?;
    let table_base = r_u64(memory, address + 32)?;
    let tls_raw = r_u64(memory, address + 40)?;
    let tls_base = if tls_raw == 0 { None } else { Some(tls_raw) };

    let initializing = flags & MODULE_FLAG_INITIALIZING != 0;
    let transaction_token = r_u32(memory, address + 104)?;
    let stage_code = r_u32(memory, address + 108)?;
    let table_index = r_u64(memory, address + 112)?;
    if initializing != (transaction_token != 0 && stage_code != 0 && table_index != 0) {
        return Err(Errno::EINVAL);
    }
    let initialization = if initializing {
        // An initializing module has not yet been assigned a handle.
        if handle.is_some() {
            return Err(Errno::EINVAL);
        }
        Some(DylinkInitialization {
            transaction_token,
            stage: decode_stage(stage_code)?,
            table_index,
        })
    } else {
        None
    };

    let global_visibility = flags & MODULE_FLAG_GLOBAL != 0;
    let committed_global_root = flags & MODULE_FLAG_COMMITTED_GLOBAL_ROOT != 0;
    if committed_global_root && !global_visibility {
        return Err(Errno::EINVAL);
    }

    Ok(DylinkModule {
        name,
        module_bytes,
        digest,
        memory_base,
        table_base,
        tls_base,
        activation_id: if activation_raw == 0 {
            None
        } else {
            Some(activation_raw)
        },
        handle,
        ref_count: if ref_count_raw == 0 {
            None
        } else {
            Some(ref_count_raw)
        },
        global_visibility,
        committed_global_root,
        provider_dependencies,
        allocations,
        initialization,
    })
}

/// Decode and validate one KFLT transaction record. Mirrors the TS
/// `readTransaction`.
fn read_transaction(
    memory: &[u8],
    address: u64,
    mem_len: u64,
    intervals: &mut Vec<Interval>,
) -> Result<DylinkTransaction, Errno> {
    checked_range(address, TRANSACTION_HEADER_SIZE, mem_len)?;
    if r_u32(memory, address)? != TRANSACTION_MAGIC
        || r_u16(memory, address + 4)? != TRANSACTION_VERSION
        || r_u16(memory, address + 6)? != TRANSACTION_HEADER_SIZE as u16
    {
        return Err(Errno::EINVAL);
    }
    let allocation_size = r_u64(memory, address + 16)?;
    let token = r_u32(memory, address + 24)?;
    let name_length = r_u32(memory, address + 28)? as u64;
    let bytes_length = r_u32(memory, address + 32)? as u64;
    let flags = r_u32(memory, address + 36)?;
    let expected_size = TRANSACTION_HEADER_SIZE + align8(name_length)? + bytes_length;
    if allocation_size != expected_size || flags & !TRANSACTION_FLAG_GLOBAL != 0 {
        return Err(Errno::EINVAL);
    }
    if token == 0 {
        return Err(Errno::EINVAL);
    }
    checked_range(address, allocation_size, mem_len)?;
    let end = checked_end(address, allocation_size)?;
    push_interval(intervals, address, end)?;

    let name_off = checked_end(address, TRANSACTION_HEADER_SIZE)?;
    let name = decode_utf8(memory, name_off, name_length)?;
    if name.is_empty() {
        return Err(Errno::EINVAL);
    }
    let bytes_off = checked_end(name_off, align8(name_length)?)?;
    let module_bytes = r_bytes(memory, bytes_off, bytes_length)?.to_vec();
    if module_bytes.is_empty() {
        return Err(Errno::EINVAL);
    }

    let mut digest = [0u8; MODULE_DIGEST_SIZE];
    digest.copy_from_slice(r_bytes(
        memory,
        checked_end(address, TRANSACTION_DIGEST_OFFSET)?,
        MODULE_DIGEST_SIZE as u64,
    )?);

    Ok(DylinkTransaction {
        token,
        name,
        module_bytes,
        digest,
        global_visibility: flags & TRANSACTION_FLAG_GLOBAL != 0,
    })
}

/// Decode and validate one KFJP table-patch record. Mirrors the TS
/// `readTablePatch` plus `validateTablePatch`. Returns the patch and its total
/// record byte size.
fn read_table_patch(
    memory: &[u8],
    address: u64,
    mem_len: u64,
    intervals: &mut Vec<Interval>,
) -> Result<(DylinkTablePatch, u64), Errno> {
    checked_range(address, TABLE_PATCH_HEADER_SIZE, mem_len)?;
    if r_u32(memory, address)? != TABLE_PATCH_MAGIC
        || r_u16(memory, address + 4)? != TABLE_PATCH_VERSION
        || r_u16(memory, address + 6)? != TABLE_PATCH_HEADER_SIZE as u16
    {
        return Err(Errno::EINVAL);
    }
    let run_count = r_u32(memory, address + 56)?;
    let total_size = r_u64(memory, address + 16)?;
    let expected_size = TABLE_PATCH_HEADER_SIZE + run_count as u64 * TABLE_PATCH_RUN_SIZE;
    if total_size != expected_size {
        return Err(Errno::EINVAL);
    }
    checked_range(address, total_size, mem_len)?;
    let end = checked_end(address, total_size)?;
    push_interval(intervals, address, end)?;

    let generation = r_u64(memory, address + 24)?;
    if generation == 0 || r_u32(memory, address + 60)? != 0 {
        return Err(Errno::EINVAL);
    }

    // validateTablePatch: owner id is nonzero, run count is nonzero.
    let activation_id = r_u32(memory, address + 32)?;
    let owner_id = r_u32(memory, address + 36)?;
    if owner_id == 0 || run_count == 0 {
        return Err(Errno::EINVAL);
    }
    let start = r_u64(memory, address + 40)?;
    let table_length = r_u64(memory, address + 48)?;

    let mut runs: Vec<DylinkTablePatchRun> = Vec::new();
    let mut changed = 0u64;
    for index in 0..run_count as u64 {
        let off = checked_end(
            checked_end(address, TABLE_PATCH_HEADER_SIZE)?,
            index * TABLE_PATCH_RUN_SIZE,
        )?;
        let length = r_u64(memory, off)?;
        let kind = r_u32(memory, checked_end(off, 8)?)?;
        let run_activation = r_u32(memory, checked_end(off, 12)?)?;
        let run_ordinal = r_u32(memory, checked_end(off, 16)?)?;
        if r_u32(memory, checked_end(off, 20)?)? != 0 || (kind != 0 && kind != 1) {
            return Err(Errno::EINVAL);
        }
        if length == 0 {
            return Err(Errno::EINVAL);
        }
        changed = checked_end(changed, length)?;
        let function = if kind == 0 {
            if run_activation != 0 || run_ordinal != 0 {
                return Err(Errno::EINVAL); // null run carries a coordinate
            }
            None
        } else {
            Some(DylinkTableFunction {
                activation_id: run_activation,
                ordinal: run_ordinal,
            })
        };
        runs.push(DylinkTablePatchRun { length, function });
    }
    if checked_end(start, changed)? > table_length {
        return Err(Errno::EINVAL);
    }

    Ok((
        DylinkTablePatch {
            generation,
            activation_id,
            owner_id,
            start,
            table_length,
            runs,
        },
        total_size,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    const PW: u8 = 4;
    const MEMORY_BYTES: usize = 262_144;

    /// Bytes are the used prefix of the KFLA archive linear memory emitted by
    /// the real `DylinkForkArchive` in host/src/dylink-fork-archive.ts via
    /// `crates/fork-codec/testdata/gen-dylink-archive-fixture.mts`. If the TS
    /// writer and this decoder ever disagree on the KFLA wire format, this test
    /// catches the drift.
    const TS_FIXTURE: &[u8] = include_bytes!("../testdata/dylink-archive-wasm32.bin");
    const FIXTURE_HEAD: u64 = 4096;

    fn fixture_memory() -> Vec<u8> {
        // Every record pointer is an absolute offset from 0, so reconstitute the
        // full guest linear memory by zero-padding the emitted prefix back out
        // to the writer's memory size.
        let mut mem = TS_FIXTURE.to_vec();
        mem.resize(MEMORY_BYTES, 0);
        mem
    }

    fn put_u16(mem: &mut [u8], off: u64, value: u16) {
        let off = off as usize;
        mem[off..off + 2].copy_from_slice(&value.to_le_bytes());
    }

    fn put_u32(mem: &mut [u8], off: u64, value: u32) {
        let off = off as usize;
        mem[off..off + 4].copy_from_slice(&value.to_le_bytes());
    }

    fn put_u64(mem: &mut [u8], off: u64, value: u64) {
        let off = off as usize;
        mem[off..off + 8].copy_from_slice(&value.to_le_bytes());
    }

    fn decode_fixture() -> DylinkArchive {
        decode_dylink_archive(&fixture_memory(), FIXTURE_HEAD, PW).unwrap()
    }

    /// Absolute address of the first module record (header `+32`).
    fn first_module_addr(mem: &[u8]) -> u64 {
        r_u64(mem, FIXTURE_HEAD + 32).unwrap()
    }

    // --- Cross-language fixture, field-for-field --------------------------

    #[test]
    fn decodes_ts_emitted_fixture() {
        let archive = decode_fixture();

        assert_eq!(archive.pointer_width, 4);
        assert_eq!(archive.generation, 3);
        assert_eq!(archive.next_handle, 4);
        assert_eq!(archive.table_state_root, 2048);
        assert_eq!(archive.table_checkpoint_generation, 2);

        assert_eq!(archive.modules.len(), 3);

        let dependency = &archive.modules[0];
        assert_eq!(dependency.name, "libdependency.so");
        assert_eq!(dependency.module_bytes, alloc::vec![0, 97, 115, 109, 1]);
        assert_eq!(dependency.memory_base, 8192);
        assert_eq!(dependency.table_base, 3);
        assert_eq!(dependency.tls_base, None);
        assert_eq!(dependency.activation_id, Some(7));
        assert_eq!(dependency.handle, None);
        assert_eq!(dependency.ref_count, None);
        assert!(dependency.global_visibility);
        assert!(!dependency.committed_global_root);
        assert!(dependency.provider_dependencies.is_empty());
        assert_eq!(dependency.initialization, None);
        assert_eq!(dependency.allocations.len(), 1);
        assert_eq!(
            dependency.allocations[0],
            DylinkAllocation {
                address: 8192,
                size: 64,
                mapping_address: 8176,
                mapping_size: 95,
            }
        );

        let consumer = &archive.modules[1];
        assert_eq!(consumer.name, "libconsumer.so");
        assert_eq!(consumer.module_bytes, alloc::vec![0, 97, 115, 109, 2]);
        assert_eq!(consumer.memory_base, 12288);
        assert_eq!(consumer.table_base, 9);
        assert_eq!(consumer.tls_base, Some(16384));
        assert_eq!(consumer.activation_id, Some(8));
        assert_eq!(consumer.handle, Some(3));
        assert_eq!(consumer.ref_count, Some(2));
        assert!(consumer.global_visibility);
        assert!(consumer.committed_global_root);
        assert_eq!(
            consumer.provider_dependencies,
            alloc::vec![String::from("libdependency.so")]
        );
        assert_eq!(consumer.initialization, None);

        let init = &archive.modules[2];
        assert_eq!(init.name, "libinit.so");
        assert_eq!(init.module_bytes, alloc::vec![0, 97, 115, 109, 43]);
        assert_eq!(init.memory_base, 20480);
        assert_eq!(init.table_base, 20);
        assert!(!init.global_visibility);
        assert_eq!(init.handle, None);
        assert_eq!(
            init.initialization,
            Some(DylinkInitialization {
                transaction_token: 11,
                stage: DylinkInitializationStage::Bootstrap,
                table_index: 19,
            })
        );

        assert_eq!(archive.transactions.len(), 1);
        let transaction = &archive.transactions[0];
        assert_eq!(transaction.token, 11);
        assert_eq!(transaction.name, "libinit.so");
        assert_eq!(transaction.module_bytes, alloc::vec![0, 97, 115, 109, 43]);
        assert!(!transaction.global_visibility);

        assert_eq!(archive.table_patches.len(), 1);
        let patch = &archive.table_patches[0];
        assert_eq!(patch.generation, 3);
        assert_eq!(patch.activation_id, 7);
        assert_eq!(patch.owner_id, 3);
        assert_eq!(patch.start, 5);
        assert_eq!(patch.table_length, 12);
        assert_eq!(
            patch.runs,
            alloc::vec![
                DylinkTablePatchRun {
                    length: 2,
                    function: None,
                },
                DylinkTablePatchRun {
                    length: 3,
                    function: Some(DylinkTableFunction {
                        activation_id: 8,
                        ordinal: 4,
                    }),
                },
            ]
        );
    }

    #[test]
    fn non_vacuous_digest_is_stored_verbatim() {
        // The stored SHA-256 digest is a real, nonzero hash of the module bytes
        // (never recomputed here). Proves the field is materialized, not defaulted.
        let archive = decode_fixture();
        assert!(archive.modules.iter().all(|m| m.digest != [0u8; 32]));
        assert!(archive.transactions.iter().all(|t| t.digest != [0u8; 32]));
        // The two libinit.so records share identical bytes -> identical digests.
        assert_eq!(archive.modules[2].digest, archive.transactions[0].digest);
    }

    // --- Adversarial negatives (Err, never panic) -------------------------

    #[test]
    fn rejects_bad_archive_magic() {
        let mut mem = fixture_memory();
        put_u32(&mut mem, FIXTURE_HEAD, 0xdead_beef);
        assert_eq!(
            decode_dylink_archive(&mem, FIXTURE_HEAD, PW),
            Err(Errno::EINVAL)
        );
    }

    #[test]
    fn rejects_bad_archive_version() {
        let mut mem = fixture_memory();
        put_u16(&mut mem, FIXTURE_HEAD + 4, 99);
        assert_eq!(
            decode_dylink_archive(&mem, FIXTURE_HEAD, PW),
            Err(Errno::EINVAL)
        );
    }

    #[test]
    fn rejects_pointer_width_mismatch() {
        let mem = fixture_memory();
        // The image records width 4; decoding as an 8-byte-pointer process fails.
        assert_eq!(
            decode_dylink_archive(&mem, FIXTURE_HEAD, 8),
            Err(Errno::EINVAL)
        );
    }

    #[test]
    fn rejects_invalid_pointer_width_argument() {
        let mem = fixture_memory();
        assert_eq!(
            decode_dylink_archive(&mem, FIXTURE_HEAD, 2),
            Err(Errno::EINVAL)
        );
    }

    #[test]
    fn rejects_nonzero_header_reserved_byte() {
        let mut mem = fixture_memory();
        mem[(FIXTURE_HEAD + 12) as usize] = 1;
        assert_eq!(
            decode_dylink_archive(&mem, FIXTURE_HEAD, PW),
            Err(Errno::EINVAL)
        );
    }

    #[test]
    fn rejects_zero_generation() {
        let mut mem = fixture_memory();
        put_u64(&mut mem, FIXTURE_HEAD + 40, 0);
        assert_eq!(
            decode_dylink_archive(&mem, FIXTURE_HEAD, PW),
            Err(Errno::EINVAL)
        );
    }

    #[test]
    fn rejects_module_count_exceeding_memory_geometry() {
        let mut mem = fixture_memory();
        put_u32(&mut mem, FIXTURE_HEAD + 24, 0xffff_ffff);
        assert_eq!(
            decode_dylink_archive(&mem, FIXTURE_HEAD, PW),
            Err(Errno::EINVAL)
        );
    }

    #[test]
    fn rejects_module_record_cycle() {
        let mut mem = fixture_memory();
        let first = first_module_addr(&mem);
        // Point the first module's next pointer back at itself.
        put_u64(&mut mem, first + 8, first);
        assert_eq!(
            decode_dylink_archive(&mem, FIXTURE_HEAD, PW),
            Err(Errno::EINVAL)
        );
    }

    #[test]
    fn rejects_bad_module_magic() {
        let mut mem = fixture_memory();
        let first = first_module_addr(&mem);
        put_u32(&mut mem, first, 0x1234_5678);
        assert_eq!(
            decode_dylink_archive(&mem, FIXTURE_HEAD, PW),
            Err(Errno::EINVAL)
        );
    }

    #[test]
    fn rejects_unknown_module_flags() {
        let mut mem = fixture_memory();
        let first = first_module_addr(&mem);
        put_u32(&mut mem, first + 68, 0x8000_0000);
        assert_eq!(
            decode_dylink_archive(&mem, FIXTURE_HEAD, PW),
            Err(Errno::EINVAL)
        );
    }

    #[test]
    fn rejects_module_allocation_size_mismatch() {
        let mut mem = fixture_memory();
        let first = first_module_addr(&mem);
        // Grow the recorded allocation size without adding bytes.
        let size = r_u64(&mem, first + 16).unwrap();
        put_u64(&mut mem, first + 16, size + 8);
        assert_eq!(
            decode_dylink_archive(&mem, FIXTURE_HEAD, PW),
            Err(Errno::EINVAL)
        );
    }

    #[test]
    fn rejects_handle_reaching_next_handle() {
        let mut mem = fixture_memory();
        // Lower nextHandle to 3 so the consumer's handle (3) is out of range.
        put_u64(&mut mem, FIXTURE_HEAD + 16, 3);
        assert_eq!(
            decode_dylink_archive(&mem, FIXTURE_HEAD, PW),
            Err(Errno::EINVAL)
        );
    }

    #[test]
    fn rejects_out_of_range_next_handle() {
        let mut mem = fixture_memory();
        put_u64(&mut mem, FIXTURE_HEAD + 16, 1); // below FIRST_DYLINK_HANDLE
        assert_eq!(
            decode_dylink_archive(&mem, FIXTURE_HEAD, PW),
            Err(Errno::EINVAL)
        );
    }

    #[test]
    fn rejects_oversize_u64_field() {
        let mut mem = fixture_memory();
        // Write a value above Number.MAX_SAFE_INTEGER into the next-handle slot.
        let off = (FIXTURE_HEAD + 16) as usize;
        mem[off..off + 8].copy_from_slice(&u64::MAX.to_le_bytes());
        assert_eq!(
            decode_dylink_archive(&mem, FIXTURE_HEAD, PW),
            Err(Errno::EINVAL)
        );
    }

    #[test]
    fn rejects_inconsistent_table_checkpoint() {
        let mut mem = fixture_memory();
        // Clear the table-state root while leaving the checkpoint generation set.
        put_u64(&mut mem, FIXTURE_HEAD + 48, 0);
        assert_eq!(
            decode_dylink_archive(&mem, FIXTURE_HEAD, PW),
            Err(Errno::EINVAL)
        );
    }

    #[test]
    fn rejects_table_patch_generation_above_archive() {
        let mut mem = fixture_memory();
        let patch = r_u64(&mem, FIXTURE_HEAD + 56).unwrap();
        // Push the patch generation past the archive generation (3).
        put_u64(&mut mem, patch + 24, 4);
        assert_eq!(
            decode_dylink_archive(&mem, FIXTURE_HEAD, PW),
            Err(Errno::EINVAL)
        );
    }

    #[test]
    fn rejects_table_patch_declared_byte_mismatch() {
        let mut mem = fixture_memory();
        let declared = r_u32(&mem, FIXTURE_HEAD + 76).unwrap();
        put_u32(&mut mem, FIXTURE_HEAD + 76, declared + 8);
        assert_eq!(
            decode_dylink_archive(&mem, FIXTURE_HEAD, PW),
            Err(Errno::EINVAL)
        );
    }

    #[test]
    fn rejects_head_zero_and_out_of_range() {
        let mem = fixture_memory();
        assert_eq!(decode_dylink_archive(&mem, 0, PW), Err(Errno::EINVAL));
        assert_eq!(
            decode_dylink_archive(&mem, MEMORY_BYTES as u64, PW),
            Err(Errno::EINVAL)
        );
    }

    #[test]
    fn rejects_truncated_memory() {
        let mut mem = fixture_memory();
        mem.truncate((FIXTURE_HEAD + 50) as usize); // shorter than the header
        assert_eq!(
            decode_dylink_archive(&mem, FIXTURE_HEAD, PW),
            Err(Errno::EINVAL)
        );
    }

    // --- Panic-freedom fuzz sweeps ---------------------------------------

    #[test]
    fn arbitrary_heads_never_panic() {
        let mem = fixture_memory();
        for head in (0..300_000u64).step_by(101) {
            let _ = decode_dylink_archive(&mem, head, PW);
        }
    }

    #[test]
    fn single_byte_corruptions_never_panic() {
        let base = fixture_memory();
        // Corrupt each byte of the header and the first record region; every
        // outcome must be Ok or Err, never a panic.
        for offset in FIXTURE_HEAD..FIXTURE_HEAD + 512 {
            let mut mem = base.clone();
            mem[offset as usize] ^= 0xff;
            let _ = decode_dylink_archive(&mem, FIXTURE_HEAD, PW);
        }
    }

    #[test]
    fn truncation_sweep_never_panics() {
        let base = fixture_memory();
        for len in 0..600usize {
            let mem = &base[..len.min(base.len())];
            let _ = decode_dylink_archive(mem, FIXTURE_HEAD, PW);
        }
    }
}
