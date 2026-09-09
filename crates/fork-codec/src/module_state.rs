//! Decoder for the fork module-state (KFMS) arena.
//!
//! Ported from `host/src/fork-module-state.ts` (`ForkModuleStateArena`,
//! specifically its `attachWithOwnership` -> `validateChunks` / `decodeRecords`
//! read path, plus `decodeForkModuleStateDescriptor`). The wire format is
//! documented in `docs/fork-instrumentation.md` ("Module-state arena") and its
//! structural constants live in `crates/shared/src/lib.rs`
//! (`WPK_FORK_MODULE_STATE_*`).
//!
//! Layout recap (all little-endian, `P` = pointer width in bytes):
//!
//! Descriptor (custom section, 24 bytes): `+0` magic `KFMD`, `+4` version,
//! `+6` declared size, `+8` pointer width, `+9` record alignment, `+10` flags,
//! `+12` arena version, `+14` record version, `+16` root-pointer word offset,
//! `+20` reserved(0).
//!
//! Chunk header (`chunk_header_size` bytes: 40 on wasm32, 56 on wasm64):
//! `+0` magic `KFMC`, `+4` arena version, `+6` flags, `+8` root ptr,
//! `+8+P` previous ptr, `+8+2P` next ptr, `+8+3P` capacity, `+8+4P` used,
//! `+8+5P` record count (u32), `+12+5P` reserved (u32), then zero padding.
//!
//! Record TLV header (`RECORD_HEADER_SIZE` = 24 bytes): `+0` magic `KFMR`,
//! `+4` record version, `+6` kind, `+8` total (aligned) size, `+12` payload
//! size, `+16` activation id, `+20` owner id. The payload begins at
//! `record + RECORD_HEADER_SIZE`; the alignment padding after it must be zero.
//!
//! Like `linked_frames`, this decoder validates the STRUCTURAL envelope: the
//! sealed chunk chain and the per-record TLV framing. It exposes each record's
//! kind, ownership coordinates, and payload byte range but treats the payload
//! itself as opaque. The record-kind SEMANTIC layer (`validateRecordOwnership`
//! and the per-kind sub-decoders: module template identity, table descriptors,
//! sparse pages, mutable globals, segment bitmaps, replay events, imported
//! bindings, activation continuations) is a separate follow-on increment for
//! the co-resident module (Phase 6 D5+), exactly as `linked_frames` deferred
//! the live allocator half.

use wasm_posix_shared::abi;
use wasm_posix_shared::Errno;

use alloc::collections::BTreeSet;
use alloc::vec::Vec;

const PAGE_SIZE: u64 = 65_536;
const RECORD_ALIGNMENT: u64 = abi::WPK_FORK_MODULE_STATE_RECORD_ALIGNMENT as u64;
const RECORD_HEADER_SIZE: u64 = abi::WPK_FORK_MODULE_STATE_RECORD_HEADER_SIZE as u64;
const CHUNK_MAGIC: u32 = 0x434d_464b; // "KFMC", little-endian
const RECORD_MAGIC: u32 = 0x524d_464b; // "KFMR", little-endian
const CHUNK_FLAG_ROOT: u16 = abi::WPK_FORK_MODULE_STATE_CHUNK_FLAG_ROOT;
const CHUNK_FLAG_SEALED: u16 = abi::WPK_FORK_MODULE_STATE_CHUNK_FLAG_SEALED;

/// Parsed `kandelo.wpk_fork.module_state` descriptor: the per-module geometry
/// the decoder needs. Mirrors `decodeForkModuleStateDescriptor` in
/// fork-module-state.ts.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ModuleStateFormat {
    pub pointer_width: u8,
    pub chunk_header_size: u32,
}

impl ModuleStateFormat {
    /// Parse the 24-byte custom-section descriptor. Mirrors the TS
    /// `decodeForkModuleStateDescriptor`.
    pub fn parse_descriptor(descriptor: &[u8]) -> Result<Self, Errno> {
        if descriptor.len() != abi::WPK_FORK_MODULE_STATE_DESCRIPTOR_SIZE as usize {
            return Err(Errno::EINVAL);
        }
        if descriptor[0..4] != abi::WPK_FORK_MODULE_STATE_FORMAT_MAGIC {
            return Err(Errno::EINVAL);
        }
        let version = u16::from_le_bytes([descriptor[4], descriptor[5]]);
        if version != abi::WPK_FORK_MODULE_STATE_FORMAT_VERSION {
            return Err(Errno::EINVAL);
        }
        let declared_size = u16::from_le_bytes([descriptor[6], descriptor[7]]);
        if declared_size != abi::WPK_FORK_MODULE_STATE_DESCRIPTOR_SIZE {
            return Err(Errno::EINVAL);
        }
        let pointer_width = descriptor[8];
        let chunk_header_size = match abi::wpk_fork_module_state_chunk_header_size(pointer_width) {
            Some(size) => size,
            None => return Err(Errno::EINVAL),
        };
        if descriptor[9] != abi::WPK_FORK_MODULE_STATE_RECORD_ALIGNMENT {
            return Err(Errno::EINVAL);
        }
        let flags = u16::from_le_bytes([descriptor[10], descriptor[11]]);
        // WHY: the required-ownership features are also the only known flags, so
        // an exact match rejects both unknown and missing feature bits.
        if flags & !abi::WPK_FORK_MODULE_STATE_KNOWN_FLAGS != 0
            || flags & abi::WPK_FORK_MODULE_STATE_REQUIRED_FLAGS
                != abi::WPK_FORK_MODULE_STATE_REQUIRED_FLAGS
        {
            return Err(Errno::EINVAL);
        }
        let arena_version = u16::from_le_bytes([descriptor[12], descriptor[13]]);
        if arena_version != abi::WPK_FORK_MODULE_STATE_ARENA_VERSION {
            return Err(Errno::EINVAL);
        }
        let record_version = u16::from_le_bytes([descriptor[14], descriptor[15]]);
        if record_version != abi::WPK_FORK_MODULE_STATE_RECORD_VERSION {
            return Err(Errno::EINVAL);
        }
        let root_pointer_word_offset =
            u32::from_le_bytes([descriptor[16], descriptor[17], descriptor[18], descriptor[19]]);
        if root_pointer_word_offset != abi::WPK_FORK_MODULE_STATE_ROOT_POINTER_WORD_OFFSET {
            return Err(Errno::EINVAL);
        }
        if u32::from_le_bytes([descriptor[20], descriptor[21], descriptor[22], descriptor[23]]) != 0
        {
            return Err(Errno::EINVAL);
        }
        Ok(ModuleStateFormat {
            pointer_width,
            chunk_header_size,
        })
    }
}

/// One sealed arena chunk: a page-rounded anonymous mapping that holds a chunk
/// header and a run of record TLVs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ModuleStateChunk {
    pub addr: u64,
    pub capacity: u64,
    pub used: u64,
    pub record_count: u32,
    pub previous: u64,
    pub next: u64,
}

/// One decoded record envelope. `payload_offset`/`payload_size` are byte
/// offsets into the guest linear memory; the payload itself is opaque at this
/// structural layer (see the module doc comment).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ModuleStateRecord {
    pub kind: u16,
    pub activation_id: u32,
    pub owner_id: u32,
    pub payload_offset: u64,
    pub payload_size: u64,
    pub total_size: u64,
    pub chunk_index: usize,
}

/// The fully decoded module-state arena: the validated sealed chunk chain plus
/// every record envelope in arena order, matching what `ForkModuleStateArena`
/// yields from `records()` / `recordViews()`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModuleState {
    pub pointer_width: u8,
    pub root: u64,
    pub chunks: Vec<ModuleStateChunk>,
    pub records: Vec<ModuleStateRecord>,
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

/// Bounds-checked little-endian pointer read of `width` bytes (4 or 8).
fn r_ptr(mem: &[u8], off: u64, width: u8) -> Result<u64, Errno> {
    let off = usize::try_from(off).map_err(|_| Errno::EINVAL)?;
    let end = off.checked_add(width as usize).ok_or(Errno::EINVAL)?;
    let slice = mem.get(off..end).ok_or(Errno::EINVAL)?;
    let mut value: u64 = 0;
    for (index, byte) in slice.iter().enumerate() {
        value |= (*byte as u64) << (8 * index);
    }
    Ok(value)
}

/// Round `value` up to the next multiple of `align`, checked.
fn align_up(value: u64, align: u64) -> Result<u64, Errno> {
    let rem = value % align;
    if rem == 0 {
        Ok(value)
    } else {
        value.checked_add(align - rem).ok_or(Errno::EINVAL)
    }
}

/// `addr + size`, rejecting overflow. Mirrors the TS `checkedEnd`.
fn checked_end(addr: u64, size: u64) -> Result<u64, Errno> {
    addr.checked_add(size).ok_or(Errno::EINVAL)
}

/// True if `kind` is one of the 13 defined KFMS record kinds. Mirrors the TS
/// `RECORD_KINDS.has(kind)` membership check.
fn is_known_kind(kind: u16) -> bool {
    abi::WPK_FORK_MODULE_STATE_RECORD_KINDS
        .iter()
        .any(|entry| entry.number == kind)
}

/// `chunkOffset(ptrWidth, field)`: the byte offset of a chunk-header pointer
/// field. Fields 0..=4 are root, previous, next, capacity, used.
fn chunk_field(field: u64, pw: u64) -> u64 {
    8 + field * pw
}

/// Decode the sealed module-state arena rooted at `root`.
///
/// `memory` is the guest linear memory; `root` is the page-aligned address of
/// the sealed root chunk (the value the runtime stores in the module prefix's
/// `+P` word, i.e. what `readForkModuleStateRoot` returns and
/// `attach`/`attachBorrowed` consume). Returns the validated chunk chain and
/// every record envelope in arena order. Malformed input yields
/// `Err(Errno::EINVAL)`; the function never panics.
///
/// The chain is required to be SEALED, matching the child attach path
/// (`attachWithOwnership` uses `requireSealed = true`): the root chunk must
/// carry `CHUNK_FLAG_ROOT | CHUNK_FLAG_SEALED` and every non-root chunk
/// `CHUNK_FLAG_SEALED`.
pub fn decode_module_state(
    memory: &[u8],
    root: u64,
    format: &ModuleStateFormat,
) -> Result<ModuleState, Errno> {
    let p = format.pointer_width;
    if p != 4 && p != 8 {
        return Err(Errno::EINVAL);
    }
    let pw = p as u64;
    let header = format.chunk_header_size as u64;
    let mem_len = memory.len() as u64;

    if root == 0 || !root.is_multiple_of(PAGE_SIZE) {
        return Err(Errno::EINVAL);
    }

    // WHY: each chunk starts on a Wasm page and occupies at least one page, so
    // the memory size bounds the chain length. Mirrors the TS `maxChunks`.
    let max_chunks = mem_len / PAGE_SIZE;

    let mut chunks: Vec<ModuleStateChunk> = Vec::new();
    let mut seen: BTreeSet<u64> = BTreeSet::new();
    let mut chunk = root;
    let mut previous = 0u64;
    loop {
        if seen.contains(&chunk) {
            return Err(Errno::EINVAL); // cycle
        }
        if seen.len() as u64 >= max_chunks {
            return Err(Errno::EINVAL); // chain exceeds memory
        }
        seen.insert(chunk);

        let is_root = chunks.is_empty();
        let decoded = decode_chunk(memory, chunk, root, previous, is_root, header, pw, p, mem_len)?;
        let next = decoded.next;
        chunks.push(decoded);
        if next == 0 {
            break;
        }
        previous = chunk;
        chunk = next;
    }

    // WHY: every declared chunk is walked during record decode. Distinct
    // page-aligned starts are not enough: a forged header inside a multi-page
    // chunk could otherwise overlap another mapping. Reject any overlap.
    let mut by_addr: Vec<&ModuleStateChunk> = chunks.iter().collect();
    by_addr.sort_by_key(|c| c.addr);
    for pair in by_addr.windows(2) {
        if checked_end(pair[0].addr, pair[0].capacity)? > pair[1].addr {
            return Err(Errno::EINVAL);
        }
    }

    let records = decode_records(memory, &chunks, header, pw)?;

    Ok(ModuleState {
        pointer_width: p,
        root,
        chunks,
        records,
    })
}

/// Validate one chunk header and return the decoded chunk. Mirrors the TS
/// `validateChunk` with `requireSealed = true`.
#[allow(clippy::too_many_arguments)]
fn decode_chunk(
    memory: &[u8],
    addr: u64,
    root: u64,
    previous: u64,
    is_root: bool,
    header: u64,
    pw: u64,
    p: u8,
    mem_len: u64,
) -> Result<ModuleStateChunk, Errno> {
    if addr == 0 || !addr.is_multiple_of(PAGE_SIZE) || checked_end(addr, header)? > mem_len {
        return Err(Errno::EINVAL);
    }
    let expected_flags =
        CHUNK_FLAG_SEALED | if is_root { CHUNK_FLAG_ROOT } else { 0 };
    if r_u32(memory, addr)? != CHUNK_MAGIC
        || r_u16(memory, addr + 4)? != abi::WPK_FORK_MODULE_STATE_ARENA_VERSION
        || r_u16(memory, addr + 6)? != expected_flags
        || r_ptr(memory, addr + chunk_field(0, pw), p)? != root
        || r_ptr(memory, addr + chunk_field(1, pw), p)? != previous
    {
        return Err(Errno::EINVAL);
    }
    let next = r_ptr(memory, addr + chunk_field(2, pw), p)?;
    let capacity = r_ptr(memory, addr + chunk_field(3, pw), p)?;
    let used = r_ptr(memory, addr + chunk_field(4, pw), p)?;
    let record_count_off = 8 + 5 * pw;
    let reserved_off = 12 + 5 * pw;
    let record_count = r_u32(memory, addr + record_count_off)?;
    if capacity < PAGE_SIZE
        || !capacity.is_multiple_of(PAGE_SIZE)
        || checked_end(addr, capacity)? > mem_len
        || used < header
        || used > capacity
        || (!is_root && (used == header || record_count == 0))
        || r_u32(memory, addr + reserved_off)? != 0
    {
        return Err(Errno::EINVAL);
    }
    // The chunk-header trailer between the reserved word and the aligned header
    // size must be zero. Mirrors the TS `requireZeroBytes` header check.
    let fields_end = reserved_off + 4;
    for off in fields_end..header {
        if *memory
            .get(usize::try_from(addr + off).map_err(|_| Errno::EINVAL)?)
            .ok_or(Errno::EINVAL)?
            != 0
        {
            return Err(Errno::EINVAL);
        }
    }
    Ok(ModuleStateChunk {
        addr,
        capacity,
        used,
        record_count,
        previous,
        next,
    })
}

/// Walk every record TLV in each chunk. Mirrors the TS `decodeRecords`.
fn decode_records(
    memory: &[u8],
    chunks: &[ModuleStateChunk],
    header: u64,
    _pw: u64,
) -> Result<Vec<ModuleStateRecord>, Errno> {
    let mut records: Vec<ModuleStateRecord> = Vec::new();
    for (chunk_index, chunk) in chunks.iter().enumerate() {
        let mut offset = header;
        let mut record_count: u32 = 0;
        while offset < chunk.used {
            let addr = checked_end(chunk.addr, offset)?;
            if checked_end(offset, RECORD_HEADER_SIZE)? > chunk.used {
                return Err(Errno::EINVAL); // truncated record header
            }
            let kind = r_u16(memory, addr + 6)?;
            if r_u32(memory, addr)? != RECORD_MAGIC
                || r_u16(memory, addr + 4)? != abi::WPK_FORK_MODULE_STATE_RECORD_VERSION
                || !is_known_kind(kind)
            {
                return Err(Errno::EINVAL);
            }
            let total_size = r_u32(memory, addr + 8)? as u64;
            let payload_size = r_u32(memory, addr + 12)? as u64;
            let expected_total = align_up(
                RECORD_HEADER_SIZE.checked_add(payload_size).ok_or(Errno::EINVAL)?,
                RECORD_ALIGNMENT,
            )?;
            if total_size != expected_total
                || total_size < RECORD_HEADER_SIZE
                || checked_end(offset, total_size)? > chunk.used
            {
                return Err(Errno::EINVAL);
            }
            // The alignment padding after the payload must be zero. Mirrors the
            // TS `requireZeroBytes` record check.
            let payload_offset = checked_end(addr, RECORD_HEADER_SIZE)?;
            let padding_start = checked_end(payload_offset, payload_size)?;
            let padding_end = checked_end(addr, total_size)?;
            for off in padding_start..padding_end {
                if *memory
                    .get(usize::try_from(off).map_err(|_| Errno::EINVAL)?)
                    .ok_or(Errno::EINVAL)?
                    != 0
                {
                    return Err(Errno::EINVAL);
                }
            }
            records.push(ModuleStateRecord {
                kind,
                activation_id: r_u32(memory, addr + 16)?,
                owner_id: r_u32(memory, addr + 20)?,
                payload_offset,
                payload_size,
                total_size,
                chunk_index,
            });
            offset = checked_end(offset, total_size)?;
            record_count = record_count.checked_add(1).ok_or(Errno::EINVAL)?;
        }
        if offset != chunk.used || record_count != chunk.record_count {
            return Err(Errno::EINVAL); // record count inconsistent
        }
    }
    Ok(records)
}

#[cfg(test)]
mod tests {
    use super::*;

    const PW: u8 = 4;
    const CHUNK_HEADER: u64 = 40;

    fn wasm32_format() -> ModuleStateFormat {
        ModuleStateFormat {
            pointer_width: PW,
            chunk_header_size: CHUNK_HEADER as u32,
        }
    }

    fn put_u16(mem: &mut [u8], off: u64, value: u16) {
        let off = off as usize;
        mem[off..off + 2].copy_from_slice(&value.to_le_bytes());
    }

    fn put_u32(mem: &mut [u8], off: u64, value: u32) {
        let off = off as usize;
        mem[off..off + 4].copy_from_slice(&value.to_le_bytes());
    }

    fn put_ptr(mem: &mut [u8], off: u64, value: u64) {
        let off = off as usize;
        mem[off..off + PW as usize].copy_from_slice(&(value as u32).to_le_bytes());
    }

    // --- Cross-language fixture (emitted by the real TS arena) ------------

    /// Bytes are the used prefix of the sealed root arena chunk, emitted by
    /// `ForkModuleStateArena` in host/src/fork-module-state.ts via
    /// `crates/fork-codec/testdata/gen-module-state-fixture.mts`. If the TS
    /// arena and this decoder ever disagree on the KFMS wire format, this test
    /// catches the drift.
    const TS_FIXTURE: &[u8] = include_bytes!("../testdata/module-state-wasm32.bin");
    const FIXTURE_ROOT: u64 = 65_536;
    const FIXTURE_CAPACITY: u64 = 65_536;

    fn fixture_memory() -> Vec<u8> {
        // Reconstitute the guest linear memory: zero the reserved first page up
        // to the page-aligned chunk base, splice the emitted chunk bytes, then
        // pad out to the chunk capacity the header declares.
        let mut mem = alloc::vec![0u8; FIXTURE_ROOT as usize];
        mem.extend_from_slice(TS_FIXTURE);
        mem.resize((FIXTURE_ROOT + FIXTURE_CAPACITY) as usize, 0);
        mem
    }

    #[test]
    fn decodes_ts_emitted_fixture() {
        let mem = fixture_memory();
        let decoded = decode_module_state(&mem, FIXTURE_ROOT, &wasm32_format()).unwrap();

        assert_eq!(decoded.pointer_width, 4);
        assert_eq!(decoded.root, FIXTURE_ROOT);
        assert_eq!(decoded.chunks.len(), 1);
        assert_eq!(decoded.chunks[0].addr, FIXTURE_ROOT);
        assert_eq!(decoded.chunks[0].capacity, FIXTURE_CAPACITY);
        assert_eq!(decoded.chunks[0].used, 144);
        assert_eq!(decoded.chunks[0].record_count, 2);
        assert_eq!(decoded.chunks[0].previous, 0);
        assert_eq!(decoded.chunks[0].next, 0);

        // Records in arena order: Module (kind 1) then MutableGlobal (kind 3).
        assert_eq!(decoded.records.len(), 2);

        let module = decoded.records[0];
        assert_eq!(module.kind, abi::WPK_FORK_MODULE_STATE_RECORD_KIND_MODULE);
        assert_eq!(module.activation_id, 0);
        assert_eq!(module.owner_id, 0);
        assert_eq!(module.payload_offset, FIXTURE_ROOT + 40 + 24);
        assert_eq!(module.payload_size, 40);
        assert_eq!(module.total_size, 64);
        assert_eq!(module.chunk_index, 0);
        // Module template id is filled with 0xa0 in the fixture.
        assert_eq!(mem[module.payload_offset as usize], 0xa0);

        let global = decoded.records[1];
        assert_eq!(
            global.kind,
            abi::WPK_FORK_MODULE_STATE_RECORD_KIND_MUTABLE_GLOBAL
        );
        assert_eq!(global.activation_id, 0);
        assert_eq!(global.owner_id, 2);
        assert_eq!(global.payload_offset, FIXTURE_ROOT + 104 + 24);
        assert_eq!(global.payload_size, 12);
        assert_eq!(global.total_size, 40);
        // Mutable-global payload opens with the i32 type code (1).
        assert_eq!(
            mem[global.payload_offset as usize],
            abi::WPK_FORK_MODULE_STATE_GLOBAL_TYPE_I32
        );
        // The stored i32 value 0x0908_0706 round-trips little-endian.
        let value_off = (global.payload_offset
            + abi::WPK_FORK_MODULE_STATE_GLOBAL_HEADER_SIZE as u64) as usize;
        assert_eq!(
            u32::from_le_bytes([
                mem[value_off],
                mem[value_off + 1],
                mem[value_off + 2],
                mem[value_off + 3],
            ]),
            0x0908_0706
        );
    }

    #[test]
    fn rejects_truncated_fixture_memory() {
        let mut mem = fixture_memory();
        mem.truncate((FIXTURE_ROOT + 100) as usize); // shorter than declared capacity
        assert_eq!(
            decode_module_state(&mem, FIXTURE_ROOT, &wasm32_format()),
            Err(Errno::EINVAL)
        );
    }

    #[test]
    fn rejects_corrupt_chunk_magic() {
        let mut mem = fixture_memory();
        put_u32(&mut mem, FIXTURE_ROOT, 0xdead_beef);
        assert_eq!(
            decode_module_state(&mem, FIXTURE_ROOT, &wasm32_format()),
            Err(Errno::EINVAL)
        );
    }

    #[test]
    fn rejects_unsealed_root_chunk() {
        let mut mem = fixture_memory();
        // Drop the SEALED bit from the root chunk flags.
        put_u16(&mut mem, FIXTURE_ROOT + 6, CHUNK_FLAG_ROOT);
        assert_eq!(
            decode_module_state(&mem, FIXTURE_ROOT, &wasm32_format()),
            Err(Errno::EINVAL)
        );
    }

    #[test]
    fn rejects_corrupt_record_magic() {
        let mut mem = fixture_memory();
        put_u32(&mut mem, FIXTURE_ROOT + 40, 0x1234_5678); // first record KFMR magic
        assert_eq!(
            decode_module_state(&mem, FIXTURE_ROOT, &wasm32_format()),
            Err(Errno::EINVAL)
        );
    }

    #[test]
    fn rejects_unknown_record_kind() {
        let mut mem = fixture_memory();
        put_u16(&mut mem, FIXTURE_ROOT + 40 + 6, 0xffff); // record kind
        assert_eq!(
            decode_module_state(&mem, FIXTURE_ROOT, &wasm32_format()),
            Err(Errno::EINVAL)
        );
    }

    #[test]
    fn rejects_record_total_size_disagreeing_with_payload() {
        let mut mem = fixture_memory();
        // First record total size is 64; make it disagree with align_up(24+40).
        put_u32(&mut mem, FIXTURE_ROOT + 40 + 8, 72);
        assert_eq!(
            decode_module_state(&mem, FIXTURE_ROOT, &wasm32_format()),
            Err(Errno::EINVAL)
        );
    }

    #[test]
    fn rejects_nonzero_record_padding() {
        let mut mem = fixture_memory();
        // The MutableGlobal record has payload 12, total 40 -> 4 padding bytes
        // at offset 104 + 24 + 12 = 140.
        mem[(FIXTURE_ROOT + 140) as usize] = 0xff;
        assert_eq!(
            decode_module_state(&mem, FIXTURE_ROOT, &wasm32_format()),
            Err(Errno::EINVAL)
        );
    }

    #[test]
    fn rejects_inconsistent_record_count() {
        let mut mem = fixture_memory();
        // Claim three records while only two are framed.
        put_u32(&mut mem, FIXTURE_ROOT + 8 + 5 * PW as u64, 3);
        assert_eq!(
            decode_module_state(&mem, FIXTURE_ROOT, &wasm32_format()),
            Err(Errno::EINVAL)
        );
    }

    #[test]
    fn rejects_nonzero_chunk_reserved_word() {
        let mut mem = fixture_memory();
        put_u32(&mut mem, FIXTURE_ROOT + 12 + 5 * PW as u64, 1);
        assert_eq!(
            decode_module_state(&mem, FIXTURE_ROOT, &wasm32_format()),
            Err(Errno::EINVAL)
        );
    }

    #[test]
    fn rejects_nonzero_chunk_header_trailer() {
        let mut mem = fixture_memory();
        // wasm32 header trailer is bytes 36..40 (after the reserved word).
        mem[(FIXTURE_ROOT + 36) as usize] = 0x7f;
        assert_eq!(
            decode_module_state(&mem, FIXTURE_ROOT, &wasm32_format()),
            Err(Errno::EINVAL)
        );
    }

    #[test]
    fn rejects_misaligned_root() {
        let mem = fixture_memory();
        assert_eq!(
            decode_module_state(&mem, FIXTURE_ROOT + 8, &wasm32_format()),
            Err(Errno::EINVAL)
        );
        assert_eq!(
            decode_module_state(&mem, 0, &wasm32_format()),
            Err(Errno::EINVAL)
        );
    }

    // --- Hand-built two-chunk chain (cross-chunk record walk) -------------

    /// Build a valid sealed two-chunk arena: one record in the root chunk and
    /// one in a second chunk, so decode must cross the chunk boundary. Returns
    /// `(memory, root)`.
    fn build_two_chunk() -> (Vec<u8>, u64) {
        const ROOT: u64 = 65_536;
        const SECOND: u64 = 131_072;
        const CAP: u64 = 65_536;
        let mut mem = alloc::vec![0u8; (SECOND + CAP) as usize];

        let r1 = ROOT + CHUNK_HEADER; // first record addr
        let r1_payload = 8u64;
        let r1_total = align_up(RECORD_HEADER_SIZE + r1_payload, RECORD_ALIGNMENT).unwrap(); // 32
        let used_root = CHUNK_HEADER + r1_total;

        let r2 = SECOND + CHUNK_HEADER;
        let r2_payload = 16u64;
        let r2_total = align_up(RECORD_HEADER_SIZE + r2_payload, RECORD_ALIGNMENT).unwrap(); // 40
        let used_second = CHUNK_HEADER + r2_total;

        // Root chunk header.
        put_u32(&mut mem, ROOT, CHUNK_MAGIC);
        put_u16(&mut mem, ROOT + 4, 1);
        put_u16(&mut mem, ROOT + 6, CHUNK_FLAG_ROOT | CHUNK_FLAG_SEALED);
        put_ptr(&mut mem, ROOT + chunk_field(0, PW as u64), ROOT); // root
        put_ptr(&mut mem, ROOT + chunk_field(1, PW as u64), 0); // previous
        put_ptr(&mut mem, ROOT + chunk_field(2, PW as u64), SECOND); // next
        put_ptr(&mut mem, ROOT + chunk_field(3, PW as u64), CAP); // capacity
        put_ptr(&mut mem, ROOT + chunk_field(4, PW as u64), used_root); // used
        put_u32(&mut mem, ROOT + 8 + 5 * PW as u64, 1); // record count

        // Second chunk header.
        put_u32(&mut mem, SECOND, CHUNK_MAGIC);
        put_u16(&mut mem, SECOND + 4, 1);
        put_u16(&mut mem, SECOND + 6, CHUNK_FLAG_SEALED);
        put_ptr(&mut mem, SECOND + chunk_field(0, PW as u64), ROOT);
        put_ptr(&mut mem, SECOND + chunk_field(1, PW as u64), ROOT); // previous chunk
        put_ptr(&mut mem, SECOND + chunk_field(2, PW as u64), 0); // next
        put_ptr(&mut mem, SECOND + chunk_field(3, PW as u64), CAP);
        put_ptr(&mut mem, SECOND + chunk_field(4, PW as u64), used_second);
        put_u32(&mut mem, SECOND + 8 + 5 * PW as u64, 1);

        let mut write_record = |addr: u64, kind: u16, payload: u64, total: u64, owner: u32| {
            put_u32(&mut mem, addr, RECORD_MAGIC);
            put_u16(&mut mem, addr + 4, 1); // record version
            put_u16(&mut mem, addr + 6, kind);
            put_u32(&mut mem, addr + 8, total as u32);
            put_u32(&mut mem, addr + 12, payload as u32);
            put_u32(&mut mem, addr + 16, 0); // activation id
            put_u32(&mut mem, addr + 20, owner);
        };
        write_record(
            r1,
            abi::WPK_FORK_MODULE_STATE_RECORD_KIND_MODULE,
            r1_payload,
            r1_total,
            0,
        );
        write_record(
            r2,
            abi::WPK_FORK_MODULE_STATE_RECORD_KIND_REFERENCE_RECIPE,
            r2_payload,
            r2_total,
            1,
        );

        (mem, ROOT)
    }

    #[test]
    fn decodes_two_chunk_chain_across_boundary() {
        let (mem, root) = build_two_chunk();
        let decoded = decode_module_state(&mem, root, &wasm32_format()).unwrap();

        assert_eq!(decoded.chunks.len(), 2);
        assert_eq!(decoded.chunks[0].addr, 65_536);
        assert_eq!(decoded.chunks[1].addr, 131_072);
        assert_eq!(decoded.chunks[1].previous, 65_536);

        assert_eq!(decoded.records.len(), 2);
        assert_eq!(decoded.records[0].chunk_index, 0);
        assert_eq!(
            decoded.records[0].kind,
            abi::WPK_FORK_MODULE_STATE_RECORD_KIND_MODULE
        );
        assert_eq!(decoded.records[1].chunk_index, 1);
        assert_eq!(
            decoded.records[1].kind,
            abi::WPK_FORK_MODULE_STATE_RECORD_KIND_REFERENCE_RECIPE
        );
        assert_eq!(decoded.records[1].owner_id, 1);
    }

    #[test]
    fn rejects_chunk_cycle() {
        let (mut mem, root) = build_two_chunk();
        // Point the second chunk's next back at the root: a cycle.
        put_ptr(&mut mem, 131_072 + chunk_field(2, PW as u64), 65_536);
        assert_eq!(
            decode_module_state(&mem, root, &wasm32_format()),
            Err(Errno::EINVAL)
        );
    }

    #[test]
    fn rejects_non_root_chunk_with_root_flag() {
        let (mut mem, root) = build_two_chunk();
        // The non-root chunk must not carry CHUNK_FLAG_ROOT.
        put_u16(&mut mem, 131_072 + 6, CHUNK_FLAG_ROOT | CHUNK_FLAG_SEALED);
        assert_eq!(
            decode_module_state(&mem, root, &wasm32_format()),
            Err(Errno::EINVAL)
        );
    }

    #[test]
    fn rejects_empty_non_root_chunk() {
        let (mut mem, root) = build_two_chunk();
        // A non-root chunk with zero records is invalid even if `used` is only
        // the header. Set the second chunk's used == header and count == 0.
        put_ptr(&mut mem, 131_072 + chunk_field(4, PW as u64), CHUNK_HEADER);
        put_u32(&mut mem, 131_072 + 8 + 5 * PW as u64, 0);
        assert_eq!(
            decode_module_state(&mem, root, &wasm32_format()),
            Err(Errno::EINVAL)
        );
    }

    // --- Descriptor parsing ----------------------------------------------

    fn valid_descriptor() -> Vec<u8> {
        let mut d = alloc::vec![0u8; 24];
        d[0..4].copy_from_slice(&abi::WPK_FORK_MODULE_STATE_FORMAT_MAGIC);
        put_u16(&mut d, 4, abi::WPK_FORK_MODULE_STATE_FORMAT_VERSION);
        put_u16(&mut d, 6, abi::WPK_FORK_MODULE_STATE_DESCRIPTOR_SIZE);
        d[8] = PW;
        d[9] = abi::WPK_FORK_MODULE_STATE_RECORD_ALIGNMENT;
        put_u16(&mut d, 10, abi::WPK_FORK_MODULE_STATE_REQUIRED_FLAGS);
        put_u16(&mut d, 12, abi::WPK_FORK_MODULE_STATE_ARENA_VERSION);
        put_u16(&mut d, 14, abi::WPK_FORK_MODULE_STATE_RECORD_VERSION);
        put_u32(&mut d, 16, abi::WPK_FORK_MODULE_STATE_ROOT_POINTER_WORD_OFFSET);
        put_u32(&mut d, 20, 0);
        d
    }

    #[test]
    fn parses_valid_descriptor() {
        assert_eq!(
            ModuleStateFormat::parse_descriptor(&valid_descriptor()).unwrap(),
            wasm32_format()
        );
    }

    #[test]
    fn parses_wasm64_descriptor() {
        let mut d = valid_descriptor();
        d[8] = 8;
        assert_eq!(
            ModuleStateFormat::parse_descriptor(&d).unwrap(),
            ModuleStateFormat {
                pointer_width: 8,
                chunk_header_size: 56,
            }
        );
    }

    #[test]
    fn rejects_descriptor_bad_magic_width_flags_and_size() {
        let mut bad_magic = valid_descriptor();
        bad_magic[0] = 0;
        assert_eq!(
            ModuleStateFormat::parse_descriptor(&bad_magic),
            Err(Errno::EINVAL)
        );

        let mut bad_width = valid_descriptor();
        bad_width[8] = 16;
        assert_eq!(
            ModuleStateFormat::parse_descriptor(&bad_width),
            Err(Errno::EINVAL)
        );

        let mut missing_flag = valid_descriptor();
        // Drop a required feature bit.
        put_u16(
            &mut missing_flag,
            10,
            abi::WPK_FORK_MODULE_STATE_REQUIRED_FLAGS
                & !abi::WPK_FORK_MODULE_STATE_FLAG_SPARSE_TABLES,
        );
        assert_eq!(
            ModuleStateFormat::parse_descriptor(&missing_flag),
            Err(Errno::EINVAL)
        );

        let mut unknown_flag = valid_descriptor();
        put_u16(
            &mut unknown_flag,
            10,
            abi::WPK_FORK_MODULE_STATE_REQUIRED_FLAGS | 0x8000,
        );
        assert_eq!(
            ModuleStateFormat::parse_descriptor(&unknown_flag),
            Err(Errno::EINVAL)
        );

        let mut nonzero_reserved = valid_descriptor();
        put_u32(&mut nonzero_reserved, 20, 1);
        assert_eq!(
            ModuleStateFormat::parse_descriptor(&nonzero_reserved),
            Err(Errno::EINVAL)
        );

        assert_eq!(
            ModuleStateFormat::parse_descriptor(&[0u8; 23]),
            Err(Errno::EINVAL)
        );
    }

    // --- Panic-freedom on arbitrary bytes --------------------------------

    #[test]
    fn arbitrary_roots_never_panic() {
        let mem = fixture_memory();
        let format = wasm32_format();
        // Sweep a range of roots, including misaligned, zero, and out-of-range
        // anchors. Every outcome must be Ok or Err, no panic.
        for root in (0..200_000u64).step_by(97) {
            let _ = decode_module_state(&mem, root, &format);
        }
    }

    #[test]
    fn single_byte_corruptions_never_panic() {
        let base = fixture_memory();
        let format = wasm32_format();
        // Corrupt each of the first 256 bytes of the live chunk region and
        // confirm the decoder stays panic-free (Ok or Err, either is fine).
        for offset in FIXTURE_ROOT..FIXTURE_ROOT + 256 {
            let mut mem = base.clone();
            mem[offset as usize] ^= 0xff;
            let _ = decode_module_state(&mem, FIXTURE_ROOT, &format);
        }
    }

    #[test]
    fn descriptor_single_byte_corruptions_never_panic() {
        let base = valid_descriptor();
        for offset in 0..base.len() {
            let mut d = base.clone();
            d[offset] ^= 0xff;
            let _ = ModuleStateFormat::parse_descriptor(&d);
        }
    }
}
