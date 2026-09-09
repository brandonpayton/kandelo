//! Decoder for the linked fork continuation-frame chain.
//!
//! Ported from `host/src/fork-continuation.ts` (`LinkedForkContinuation`,
//! specifically its `attachForReplay`/`beginReplay` walk). The wire format is
//! documented in `docs/fork-instrumentation.md` ("Save buffer format" and
//! "Frame format") and its structural constants live in
//! `crates/shared/src/lib.rs` (`WPK_FORK_LINKED_FRAME_*`).
//!
//! Layout recap (all little-endian, `P` = pointer width in bytes):
//!
//! Chunk header (`chunk_header_size` bytes: 32 on wasm32, 56 on wasm64):
//! `+0` magic `KFCH`, `+4` version, `+6` flags(0), `+8` root ptr,
//! `+8+P` previous ptr, `+8+2P` next ptr, `+8+3P` capacity, `+8+4P` used,
//! `+8+5P` committed-tail node (meaningful on the root chunk).
//!
//! Node header (`node_header_size` bytes: 24 on wasm32, 32 on wasm64):
//! `+0` magic `KFCN`, `+4` version, `+6` transactional state, `+8` previous
//! node ptr, `+8+P` payload size, `+8+2P` total aligned node size. The payload
//! begins at `node + node_header_size` and opens with the ABI frame header
//! (`func_index`, `call_index`, catch selector, reference-vector ordinal).

use wasm_posix_shared::abi;
use wasm_posix_shared::Errno;

use alloc::collections::BTreeSet;
use alloc::vec::Vec;

const PAGE_SIZE: u64 = 65_536;
const ALIGNMENT: u64 = abi::WPK_FORK_LINKED_FRAME_RECORD_ALIGNMENT as u64;
const CHUNK_MAGIC: u32 = 0x4843_464b; // "KFCH", little-endian
const NODE_MAGIC: u32 = 0x4e43_464b; // "KFCN", little-endian
const NODE_COMMITTED: u16 = 2;

/// Parsed `kandelo.wpk_fork.linked_frames` descriptor: the per-module geometry
/// the decoder needs. Mirrors `readLinkedFrameFormat` in fork-continuation.ts.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LinkedFrameFormat {
    pub pointer_width: u8,
    pub chunk_header_size: u32,
    pub node_header_size: u32,
    pub fixed_prefix_size: u32,
}

impl LinkedFrameFormat {
    /// Parse the 24-byte custom-section descriptor. Mirrors the TS
    /// `readLinkedFrameFormat` and the xtask publication guard
    /// (`parse_linked_frame_descriptor` in `tools/xtask/src/build_deps.rs`).
    pub fn parse_descriptor(descriptor: &[u8]) -> Result<Self, Errno> {
        if descriptor.len() != abi::WPK_FORK_LINKED_FRAME_DESCRIPTOR_SIZE as usize {
            return Err(Errno::EINVAL);
        }
        if descriptor[0..4] != abi::WPK_FORK_LINKED_FRAME_FORMAT_MAGIC {
            return Err(Errno::EINVAL);
        }
        let version = u16::from_le_bytes([descriptor[4], descriptor[5]]);
        if version != abi::WPK_FORK_LINKED_FRAME_FORMAT_VERSION {
            return Err(Errno::EINVAL);
        }
        let declared_size = u16::from_le_bytes([descriptor[6], descriptor[7]]);
        if declared_size != abi::WPK_FORK_LINKED_FRAME_DESCRIPTOR_SIZE {
            return Err(Errno::EINVAL);
        }
        let pointer_width = descriptor[8];
        let chunk_header_size = match abi::wpk_fork_linked_chunk_header_size(pointer_width) {
            Some(size) => size,
            None => return Err(Errno::EINVAL),
        };
        let node_header_size = abi::wpk_fork_linked_node_header_size(pointer_width).ok_or(Errno::EINVAL)?;
        if descriptor[9] != abi::WPK_FORK_LINKED_FRAME_RECORD_ALIGNMENT {
            return Err(Errno::EINVAL);
        }
        let flags = u16::from_le_bytes([descriptor[10], descriptor[11]]);
        if flags != abi::WPK_FORK_LINKED_FRAME_REQUIRED_FLAGS {
            return Err(Errno::EINVAL);
        }
        let declared_chunk = u32::from_le_bytes([
            descriptor[12],
            descriptor[13],
            descriptor[14],
            descriptor[15],
        ]);
        let declared_node = u32::from_le_bytes([
            descriptor[16],
            descriptor[17],
            descriptor[18],
            descriptor[19],
        ]);
        if declared_chunk != chunk_header_size || declared_node != node_header_size {
            return Err(Errno::EINVAL);
        }
        let fixed_prefix_size = u32::from_le_bytes([
            descriptor[20],
            descriptor[21],
            descriptor[22],
            descriptor[23],
        ]);
        Ok(LinkedFrameFormat {
            pointer_width,
            chunk_header_size,
            node_header_size,
            fixed_prefix_size,
        })
    }
}

/// One continuation chunk: a page-rounded anonymous mapping that holds a chunk
/// header and a run of frame nodes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LinkedChunk {
    pub addr: u64,
    pub capacity: u64,
    pub used: u64,
    pub node_start: u64,
    pub previous: u64,
    pub next: u64,
}

/// The ABI frame header at the front of a node payload, decoded when the
/// payload is at least 16 bytes. The linked-frame decoder treats the rest of
/// the payload as opaque scalar bytes, exactly as the TS controller does.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FrameHeader {
    pub func_index: u32,
    pub call_index: u32,
    pub catch_selector: u32,
    pub reference_vector_ordinal: u32,
}

/// One committed frame node, decoded in replay order (outermost first).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LinkedFrameNode {
    pub node_addr: u64,
    pub previous: u64,
    pub payload_offset: u64,
    pub payload_size: u64,
    pub node_size: u64,
    pub chunk_index: usize,
    pub header: Option<FrameHeader>,
}

/// The fully decoded linked continuation: the validated chunk chain plus the
/// committed frame nodes in replay order (tail-first == outermost-first),
/// matching the order `LinkedForkContinuation.nextFrame` yields them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LinkedFrames {
    pub pointer_width: u8,
    pub root: u64,
    pub module_buffer: u64,
    pub committed_tail: u64,
    pub chunks: Vec<LinkedChunk>,
    pub nodes: Vec<LinkedFrameNode>,
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

/// Round `value` up to the next multiple of `ALIGNMENT`, checked.
fn align_up(value: u64) -> Result<u64, Errno> {
    let rem = value % ALIGNMENT;
    if rem == 0 {
        Ok(value)
    } else {
        value.checked_add(ALIGNMENT - rem).ok_or(Errno::EINVAL)
    }
}

/// `addr + size`, rejecting overflow. Mirrors the TS `checkedEnd`.
fn checked_end(addr: u64, size: u64) -> Result<u64, Errno> {
    addr.checked_add(size).ok_or(Errno::EINVAL)
}

/// Decode the linked continuation-frame chain rooted at `module_buffer`.
///
/// `memory` is the guest linear memory; `module_buffer` is the guest pointer
/// the runtime stores as the continuation anchor (the root chunk address plus
/// one chunk header). Returns the validated chunk chain and the committed frame
/// nodes in replay order. Malformed input yields `Err(Errno::EINVAL)`; the
/// function never panics.
pub fn decode_linked_frames(
    memory: &[u8],
    module_buffer: u64,
    format: &LinkedFrameFormat,
) -> Result<LinkedFrames, Errno> {
    let p = format.pointer_width;
    if p != 4 && p != 8 {
        return Err(Errno::EINVAL);
    }
    let pw = p as u64;
    let chunk_header = format.chunk_header_size as u64;
    let node_header = format.node_header_size as u64;
    let prefix = format.fixed_prefix_size as u64;
    let mem_len = memory.len() as u64;

    let root = module_buffer.checked_sub(chunk_header).ok_or(Errno::EINVAL)?;
    let first_node_start = align_up(chunk_header.checked_add(prefix).ok_or(Errno::EINVAL)?)?;

    // WHY: address zero is reserved and each chunk starts on a Wasm page and
    // occupies at least one page, so the memory size bounds the chain length.
    let max_chunks = (mem_len / PAGE_SIZE).saturating_sub(1);

    let mut chunks: Vec<LinkedChunk> = Vec::new();
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

        if chunk == 0 || chunk % PAGE_SIZE != 0 {
            return Err(Errno::EINVAL);
        }
        if checked_end(chunk, chunk_header)? > mem_len {
            return Err(Errno::EINVAL);
        }
        if r_u32(memory, chunk)? != CHUNK_MAGIC
            || r_u16(memory, chunk + 4)? != abi::WPK_FORK_LINKED_FRAME_FORMAT_VERSION
            || r_u16(memory, chunk + 6)? != 0
            || r_ptr(memory, chunk + 8, p)? != root
            || r_ptr(memory, chunk + 8 + pw, p)? != previous
        {
            return Err(Errno::EINVAL);
        }
        let capacity = r_ptr(memory, chunk + 8 + 3 * pw, p)?;
        let used = r_ptr(memory, chunk + 8 + 4 * pw, p)?;
        if capacity < PAGE_SIZE
            || capacity % PAGE_SIZE != 0
            || checked_end(chunk, capacity)? > mem_len
            || used < chunk_header
            || used > capacity
        {
            return Err(Errno::EINVAL);
        }
        let node_start = if chunks.is_empty() {
            first_node_start
        } else {
            chunk_header
        };
        if used < node_start || (!chunks.is_empty() && used == node_start) {
            return Err(Errno::EINVAL);
        }
        let next = r_ptr(memory, chunk + 8 + 2 * pw, p)?;
        chunks.push(LinkedChunk {
            addr: chunk,
            capacity,
            used,
            node_start,
            previous,
            next,
        });
        if next == 0 {
            break;
        }
        previous = chunk;
        chunk = next;
    }

    // WHY: release/consume walks every declared chunk. Distinct page-aligned
    // starts are not enough: a forged header inside a multi-page chunk could
    // otherwise overlap another mapping. Reject any overlap.
    let mut by_addr: Vec<&LinkedChunk> = chunks.iter().collect();
    by_addr.sort_by_key(|c| c.addr);
    for pair in by_addr.windows(2) {
        if checked_end(pair[0].addr, pair[0].capacity)? > pair[1].addr {
            return Err(Errno::EINVAL);
        }
    }

    let committed_tail = r_ptr(memory, root + 8 + 5 * pw, p)?;

    let contains_frames = chunks.iter().any(|c| c.used > c.node_start);
    if committed_tail == 0 {
        if contains_frames {
            return Err(Errno::EINVAL); // nonempty continuation without a tail
        }
        return Ok(LinkedFrames {
            pointer_width: p,
            root,
            module_buffer,
            committed_tail,
            chunks,
            nodes: Vec::new(),
        });
    }
    if !contains_frames {
        return Err(Errno::EINVAL); // empty continuation with a tail
    }

    // Validate the tail node sits at the end of the last chunk.
    let last_index = chunks.len() - 1;
    let last = chunks[last_index];
    let (tail_payload_size, tail_node_size, _) =
        read_node_fields(memory, committed_tail, &last, node_header, pw, p)?;
    if checked_end(committed_tail, tail_node_size)? != checked_end(last.addr, last.used)? {
        return Err(Errno::EINVAL);
    }
    let _ = tail_payload_size;

    // Walk the committed chain backward (tail == outermost first) exactly as
    // `LinkedForkContinuation.nextFrame` does, validating reverse ordering and
    // cross-chunk adjacency at each step.
    let mut nodes: Vec<LinkedFrameNode> = Vec::new();
    let mut current = committed_tail;
    let mut chunk_index = last_index;
    loop {
        let chunk = chunks[chunk_index];
        let (payload_size, node_size, prev) =
            read_node_fields(memory, current, &chunk, node_header, pw, p)?;
        let payload_offset = current.checked_add(node_header).ok_or(Errno::EINVAL)?;
        let header = read_frame_header(memory, payload_offset, payload_size)?;
        nodes.push(LinkedFrameNode {
            node_addr: current,
            previous: prev,
            payload_offset,
            payload_size,
            node_size,
            chunk_index,
            header,
        });

        if prev == 0 {
            // Only the first node of the earliest frame-bearing chunk may have
            // no predecessor. Every non-root chunk is created for a frame, so
            // an earlier chunk with frames means replay ended too early.
            let earlier_has_frames = chunk_index > 1
                || (chunk_index == 1 && chunks[0].used > chunks[0].node_start);
            if current != chunk.addr + chunk.node_start || earlier_has_frames {
                return Err(Errno::EINVAL);
            }
            break;
        }

        // Predecessor must be strictly earlier and adjacent (its end is exactly
        // where a later node starts), in the same chunk or the prior one.
        let same_lo = chunk.addr + chunk.node_start;
        let same_hi = checked_end(chunk.addr, chunk.used)?;
        if prev >= same_lo && checked_end(prev, node_header)? <= same_hi {
            if prev >= current {
                return Err(Errno::EINVAL); // not reverse-ordered
            }
            let (_, prev_node_size, _) =
                read_node_fields(memory, prev, &chunk, node_header, pw, p)?;
            if checked_end(prev, prev_node_size)? != current {
                return Err(Errno::EINVAL); // skipped a frame
            }
            current = prev;
            continue;
        }

        if chunk_index == 0 {
            return Err(Errno::EINVAL); // predecessor outside any earlier chunk
        }
        let prior = chunks[chunk_index - 1];
        let prior_lo = prior.addr + prior.node_start;
        let prior_hi = checked_end(prior.addr, prior.used)?;
        if prev >= prior_lo && checked_end(prev, node_header)? <= prior_hi {
            // A reverse cross-chunk step is only legal from the first node of a
            // chunk to the last node of the immediately preceding chunk.
            if current != chunk.addr + chunk.node_start {
                return Err(Errno::EINVAL);
            }
            let (_, prev_node_size, _) =
                read_node_fields(memory, prev, &prior, node_header, pw, p)?;
            if checked_end(prev, prev_node_size)? != prior_hi {
                return Err(Errno::EINVAL); // skipped a frame across the boundary
            }
            current = prev;
            chunk_index -= 1;
            continue;
        }

        return Err(Errno::EINVAL); // predecessor is outside the expected chunk
    }

    Ok(LinkedFrames {
        pointer_width: p,
        root,
        module_buffer,
        committed_tail,
        chunks,
        nodes,
    })
}

/// Validate a node header inside `chunk` and return
/// `(payload_size, node_size, previous)`.
fn read_node_fields(
    memory: &[u8],
    node: u64,
    chunk: &LinkedChunk,
    node_header: u64,
    pw: u64,
    p: u8,
) -> Result<(u64, u64, u64), Errno> {
    if !node.is_multiple_of(ALIGNMENT) {
        return Err(Errno::EINVAL);
    }
    let lo = chunk.addr + chunk.node_start;
    let hi = checked_end(chunk.addr, chunk.used)?;
    if node < lo || checked_end(node, node_header)? > hi {
        return Err(Errno::EINVAL);
    }
    if r_u32(memory, node)? != NODE_MAGIC
        || r_u16(memory, node + 4)? != abi::WPK_FORK_LINKED_FRAME_FORMAT_VERSION
        || r_u16(memory, node + 6)? != NODE_COMMITTED
    {
        return Err(Errno::EINVAL);
    }
    let previous = r_ptr(memory, node + 8, p)?;
    let payload_size = r_ptr(memory, node + 8 + pw, p)?;
    let node_size = r_ptr(memory, node + 8 + 2 * pw, p)?;
    if node_size != align_up(node_header.checked_add(payload_size).ok_or(Errno::EINVAL)?)? {
        return Err(Errno::EINVAL);
    }
    if checked_end(node, node_size)? > hi {
        return Err(Errno::EINVAL);
    }
    Ok((payload_size, node_size, previous))
}

/// Decode the leading ABI frame header of a payload, if it is present and fully
/// in bounds. The linked-frame decoder itself treats the payload as opaque; the
/// header is a convenience view of its documented first 16 bytes.
fn read_frame_header(
    memory: &[u8],
    payload_offset: u64,
    payload_size: u64,
) -> Result<Option<FrameHeader>, Errno> {
    if payload_size < 16 {
        return Ok(None);
    }
    Ok(Some(FrameHeader {
        func_index: r_u32(memory, payload_offset)?,
        call_index: r_u32(memory, payload_offset + 4)?,
        catch_selector: r_u32(memory, payload_offset + 8)?,
        reference_vector_ordinal: r_u32(memory, payload_offset + 12)?,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    const PW: u8 = 4;
    const CHUNK_HEADER: u64 = 32;
    const NODE_HEADER: u64 = 24;
    const PREFIX: u64 = 128;

    fn wasm32_format() -> LinkedFrameFormat {
        LinkedFrameFormat {
            pointer_width: PW,
            chunk_header_size: CHUNK_HEADER as u32,
            node_header_size: NODE_HEADER as u32,
            fixed_prefix_size: PREFIX as u32,
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

    // --- Cross-language fixture (emitted by the real TS controller) -------

    /// Bytes are the used prefix of the root continuation chunk, emitted by
    /// `LinkedForkContinuation` in host/src/fork-continuation.ts via
    /// `crates/fork-codec/testdata/gen-linked-frames-fixture.mts`. If the TS
    /// allocator and this decoder ever disagree on the linked-frame wire
    /// format, this test catches the drift.
    const TS_FIXTURE: &[u8] = include_bytes!("../testdata/linked-frames-wasm32.bin");
    const FIXTURE_ROOT: u64 = 65_536;
    const FIXTURE_MODULE_BUFFER: u64 = 65_568;
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
        let decoded =
            decode_linked_frames(&mem, FIXTURE_MODULE_BUFFER, &wasm32_format()).unwrap();

        assert_eq!(decoded.pointer_width, 4);
        assert_eq!(decoded.root, FIXTURE_ROOT);
        assert_eq!(decoded.module_buffer, FIXTURE_MODULE_BUFFER);
        assert_eq!(decoded.chunks.len(), 1);
        assert_eq!(decoded.chunks[0].addr, FIXTURE_ROOT);
        assert_eq!(decoded.chunks[0].capacity, FIXTURE_CAPACITY);
        assert_eq!(decoded.chunks[0].used, 328);
        assert_eq!(decoded.chunks[0].node_start, 160);

        // Replay order is tail-first: outermost committed to innermost.
        assert_eq!(decoded.nodes.len(), 3);
        let expected = [
            (65_800u64, 303u32, 3u32, 40u64, 0xc3u8),
            (65_744, 202, 2, 32, 0xb2),
            (65_696, 101, 1, 24, 0xa1),
        ];
        for (node, (addr, func, call, payload, fill)) in decoded.nodes.iter().zip(expected) {
            assert_eq!(node.node_addr, addr);
            assert_eq!(node.payload_size, payload);
            assert_eq!(node.chunk_index, 0);
            let header = node.header.unwrap();
            assert_eq!(header.func_index, func);
            assert_eq!(header.call_index, call);
            assert_eq!(header.catch_selector, 0);
            assert_eq!(header.reference_vector_ordinal, 0);
            // First scalar byte after the 16-byte header round-trips.
            assert_eq!(mem[(node.payload_offset + 16) as usize], fill);
        }

        // The reverse chain terminates at the innermost frame.
        assert_eq!(decoded.nodes.last().unwrap().previous, 0);
        assert_eq!(decoded.committed_tail, 65_800);
    }

    #[test]
    fn rejects_truncated_fixture_memory() {
        let mut mem = fixture_memory();
        mem.truncate((FIXTURE_ROOT + 100) as usize); // shorter than declared capacity
        assert_eq!(
            decode_linked_frames(&mem, FIXTURE_MODULE_BUFFER, &wasm32_format()),
            Err(Errno::EINVAL)
        );
    }

    #[test]
    fn rejects_corrupt_chunk_magic() {
        let mut mem = fixture_memory();
        put_u32(&mut mem, FIXTURE_ROOT, 0xdead_beef);
        assert_eq!(
            decode_linked_frames(&mem, FIXTURE_MODULE_BUFFER, &wasm32_format()),
            Err(Errno::EINVAL)
        );
    }

    #[test]
    fn rejects_corrupt_tail_node_magic() {
        let mut mem = fixture_memory();
        put_u32(&mut mem, 65_800, 0x1234_5678); // tail node KFCN magic
        assert_eq!(
            decode_linked_frames(&mem, FIXTURE_MODULE_BUFFER, &wasm32_format()),
            Err(Errno::EINVAL)
        );
    }

    #[test]
    fn rejects_uncommitted_tail_node() {
        let mut mem = fixture_memory();
        put_u16(&mut mem, 65_800 + 6, 1); // NODE_RESERVED, not COMMITTED
        assert_eq!(
            decode_linked_frames(&mem, FIXTURE_MODULE_BUFFER, &wasm32_format()),
            Err(Errno::EINVAL)
        );
    }

    #[test]
    fn rejects_zero_tail_with_committed_frames() {
        let mut mem = fixture_memory();
        put_ptr(&mut mem, FIXTURE_ROOT + 8 + 5 * PW as u64, 0);
        assert_eq!(
            decode_linked_frames(&mem, FIXTURE_MODULE_BUFFER, &wasm32_format()),
            Err(Errno::EINVAL)
        );
    }

    #[test]
    fn rejects_node_size_that_disagrees_with_payload() {
        let mut mem = fixture_memory();
        // Corrupt the tail node's declared payload size; node_size no longer
        // equals align_up(node_header + payload_size).
        put_ptr(&mut mem, 65_800 + 8 + PW as u64, 41);
        assert_eq!(
            decode_linked_frames(&mem, FIXTURE_MODULE_BUFFER, &wasm32_format()),
            Err(Errno::EINVAL)
        );
    }

    #[test]
    fn rejects_module_buffer_below_chunk_header() {
        let mem = fixture_memory();
        assert_eq!(
            decode_linked_frames(&mem, CHUNK_HEADER - 1, &wasm32_format()),
            Err(Errno::EINVAL)
        );
    }

    #[test]
    fn rejects_misaligned_root() {
        let mem = fixture_memory();
        // module_buffer that yields a non-page-aligned root.
        assert_eq!(
            decode_linked_frames(&mem, FIXTURE_MODULE_BUFFER + 8, &wasm32_format()),
            Err(Errno::EINVAL)
        );
    }

    // --- Hand-built two-chunk chain (cross-chunk reverse linkage) ---------

    /// Build a valid two-chunk continuation: two frames in the root chunk and
    /// one in a second chunk, so decode must cross the chunk boundary in
    /// reverse. Returns `(memory, module_buffer)`.
    fn build_two_chunk() -> (Vec<u8>, u64) {
        const ROOT: u64 = 65_536;
        const SECOND: u64 = 131_072;
        const CAP: u64 = 65_536;
        let mut mem = alloc::vec![0u8; (SECOND + CAP) as usize];

        let node_start_root = align_up(CHUNK_HEADER + PREFIX).unwrap(); // 160
        let f1 = ROOT + node_start_root; // 65696
        let f1_size = align_up(NODE_HEADER + 16).unwrap(); // 40
        let f2 = f1 + f1_size; // 65736
        let f2_size = f1_size;
        let used_root = (f2 + f2_size) - ROOT; // 240

        let f3 = SECOND + CHUNK_HEADER; // 131104
        let f3_size = f1_size;
        let used_second = (f3 + f3_size) - SECOND; // 72

        // Root chunk header.
        put_u32(&mut mem, ROOT, CHUNK_MAGIC);
        put_u16(&mut mem, ROOT + 4, 1);
        put_u16(&mut mem, ROOT + 6, 0);
        put_ptr(&mut mem, ROOT + 8, ROOT); // root
        put_ptr(&mut mem, ROOT + 8 + PW as u64, 0); // previous
        put_ptr(&mut mem, ROOT + 8 + 2 * PW as u64, SECOND); // next
        put_ptr(&mut mem, ROOT + 8 + 3 * PW as u64, CAP); // capacity
        put_ptr(&mut mem, ROOT + 8 + 4 * PW as u64, used_root); // used
        put_ptr(&mut mem, ROOT + 8 + 5 * PW as u64, f3); // committed tail

        // Second chunk header.
        put_u32(&mut mem, SECOND, CHUNK_MAGIC);
        put_u16(&mut mem, SECOND + 4, 1);
        put_u16(&mut mem, SECOND + 6, 0);
        put_ptr(&mut mem, SECOND + 8, ROOT);
        put_ptr(&mut mem, SECOND + 8 + PW as u64, ROOT); // previous chunk
        put_ptr(&mut mem, SECOND + 8 + 2 * PW as u64, 0); // next
        put_ptr(&mut mem, SECOND + 8 + 3 * PW as u64, CAP);
        put_ptr(&mut mem, SECOND + 8 + 4 * PW as u64, used_second);
        put_ptr(&mut mem, SECOND + 8 + 5 * PW as u64, 0);

        let mut write_node = |node: u64, prev: u64, func: u32| {
            put_u32(&mut mem, node, NODE_MAGIC);
            put_u16(&mut mem, node + 4, 1);
            put_u16(&mut mem, node + 6, NODE_COMMITTED);
            put_ptr(&mut mem, node + 8, prev);
            put_ptr(&mut mem, node + 8 + PW as u64, 16); // payload size
            put_ptr(&mut mem, node + 8 + 2 * PW as u64, f1_size); // node size
            put_u32(&mut mem, node + NODE_HEADER, func); // func_index
            put_u32(&mut mem, node + NODE_HEADER + 4, 0); // call_index
        };
        write_node(f1, 0, 11);
        write_node(f2, f1, 22);
        write_node(f3, f2, 33);

        (mem, ROOT + CHUNK_HEADER)
    }

    #[test]
    fn decodes_two_chunk_chain_across_boundary() {
        let (mem, module_buffer) = build_two_chunk();
        let decoded = decode_linked_frames(&mem, module_buffer, &wasm32_format()).unwrap();

        assert_eq!(decoded.chunks.len(), 2);
        assert_eq!(decoded.nodes.len(), 3);
        // Tail-first: f3 (second chunk), then f2, f1 (root chunk).
        assert_eq!(decoded.nodes[0].node_addr, 131_104);
        assert_eq!(decoded.nodes[0].chunk_index, 1);
        assert_eq!(decoded.nodes[0].header.unwrap().func_index, 33);
        assert_eq!(decoded.nodes[1].node_addr, 65_736);
        assert_eq!(decoded.nodes[1].chunk_index, 0);
        assert_eq!(decoded.nodes[1].header.unwrap().func_index, 22);
        assert_eq!(decoded.nodes[2].node_addr, 65_696);
        assert_eq!(decoded.nodes[2].chunk_index, 0);
        assert_eq!(decoded.nodes[2].header.unwrap().func_index, 11);
        assert_eq!(decoded.nodes[2].previous, 0);
    }

    #[test]
    fn rejects_chunk_cycle() {
        let (mut mem, module_buffer) = build_two_chunk();
        // Point the second chunk's next back at the root: a cycle.
        put_ptr(&mut mem, 131_072 + 8 + 2 * PW as u64, 65_536);
        assert_eq!(
            decode_linked_frames(&mem, module_buffer, &wasm32_format()),
            Err(Errno::EINVAL)
        );
    }

    #[test]
    fn rejects_cross_chunk_reverse_skip() {
        let (mut mem, module_buffer) = build_two_chunk();
        // Rewrite f3.previous to point at f1 instead of f2: a skipped frame.
        put_ptr(&mut mem, 131_104 + 8, 65_696);
        assert_eq!(
            decode_linked_frames(&mem, module_buffer, &wasm32_format()),
            Err(Errno::EINVAL)
        );
    }

    #[test]
    fn rejects_non_reverse_ordered_nodes() {
        let (mut mem, module_buffer) = build_two_chunk();
        // Make f2.previous point forward at f3 (>= f2): not reverse-ordered.
        // First redirect the tail's previous so f2 is reached in-chunk.
        put_ptr(&mut mem, 65_736 + 8, 131_104);
        assert_eq!(
            decode_linked_frames(&mem, module_buffer, &wasm32_format()),
            Err(Errno::EINVAL)
        );
    }

    // --- Descriptor parsing ----------------------------------------------

    fn valid_descriptor() -> Vec<u8> {
        let mut d = alloc::vec![0u8; 24];
        d[0..4].copy_from_slice(&abi::WPK_FORK_LINKED_FRAME_FORMAT_MAGIC);
        put_u16(&mut d, 4, abi::WPK_FORK_LINKED_FRAME_FORMAT_VERSION);
        put_u16(&mut d, 6, abi::WPK_FORK_LINKED_FRAME_DESCRIPTOR_SIZE);
        d[8] = PW;
        d[9] = abi::WPK_FORK_LINKED_FRAME_RECORD_ALIGNMENT;
        put_u16(&mut d, 10, abi::WPK_FORK_LINKED_FRAME_REQUIRED_FLAGS);
        put_u32(&mut d, 12, CHUNK_HEADER as u32);
        put_u32(&mut d, 16, NODE_HEADER as u32);
        put_u32(&mut d, 20, PREFIX as u32);
        d
    }

    #[test]
    fn parses_valid_descriptor() {
        assert_eq!(
            LinkedFrameFormat::parse_descriptor(&valid_descriptor()).unwrap(),
            wasm32_format()
        );
    }

    #[test]
    fn rejects_descriptor_bad_magic_and_width_and_flags() {
        let mut bad_magic = valid_descriptor();
        bad_magic[0] = 0;
        assert_eq!(
            LinkedFrameFormat::parse_descriptor(&bad_magic),
            Err(Errno::EINVAL)
        );

        let mut bad_width = valid_descriptor();
        bad_width[8] = 16;
        assert_eq!(
            LinkedFrameFormat::parse_descriptor(&bad_width),
            Err(Errno::EINVAL)
        );

        let mut bad_flags = valid_descriptor();
        bad_flags[10] = 7;
        assert_eq!(
            LinkedFrameFormat::parse_descriptor(&bad_flags),
            Err(Errno::EINVAL)
        );

        assert_eq!(
            LinkedFrameFormat::parse_descriptor(&[0u8; 23]),
            Err(Errno::EINVAL)
        );
    }

    // --- Panic-freedom on arbitrary bytes --------------------------------

    #[test]
    fn arbitrary_module_buffers_never_panic() {
        let mem = fixture_memory();
        let format = wasm32_format();
        // Sweep a range of anchors, including ones that underflow, misalign,
        // or point outside memory. Every outcome must be Ok or Err, no panic.
        for anchor in (0..200_000u64).step_by(97) {
            let _ = decode_linked_frames(&mem, anchor, &format);
        }
    }

    #[test]
    fn single_byte_corruptions_never_panic() {
        let base = fixture_memory();
        let format = wasm32_format();
        // Corrupt each of the first 512 bytes of the live chunk region and
        // confirm the decoder stays panic-free (Ok or Err, either is fine).
        for offset in FIXTURE_ROOT..FIXTURE_ROOT + 512 {
            let mut mem = base.clone();
            mem[offset as usize] ^= 0xff;
            let _ = decode_linked_frames(&mem, FIXTURE_MODULE_BUFFER, &format);
        }
    }
}
