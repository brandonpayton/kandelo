//! Encoder (writer) for the linked fork continuation-frame chain.
//!
//! Symmetric with `decode_linked_frames` in `linked_frames.rs`: this module
//! *writes* the page-rounded linked-frame chain (KFCH chunk headers + KFCN node
//! headers) into a guest linear-memory byte buffer, exactly as the parent
//! unwind path does today in TypeScript. It reproduces the byte layout of
//! `LinkedForkContinuation` in `host/src/fork-continuation.ts` field-for-field:
//! `beginUnwind` (fork-continuation.ts:271-299), `reserveFrame` (:448-509),
//! `commitFrame` (:511-537), and `allocateChunk` (:732-771). The reused geometry
//! (header sizes, pointer width, page/record alignment) comes from the D1
//! `LinkedFrameFormat` that the decoder already defines.
//!
//! The writer is a small stateful controller over `&mut [u8]` plus a
//! `ChunkAllocator` (the page-aligned-mapping source the TS controller receives
//! as its `allocate` callback). It is bounds-checked and panic-free: every
//! memory access and every arithmetic step is checked, and malformed requests
//! or an unusable allocation return `Err(Errno::EINVAL)` rather than panicking.
//!
//! DEFERRED to a later D2/D5 slice (see
//! `.superpowers/sdd/2026-09-01-phase6-fork-exec/D2-CORESIDENT-MODULE-DESIGN.md`
//! "Ordered steps" D2 step 3): the live stateful *event journal*
//! (`ForkReplayEventJournal`), resume-slot / funcref-table selection, the
//! reference-recipe machinery, the abort-replay reference-recipe walk, and
//! munmap/release on failure. This slice is JUST the linked-frame byte writer:
//! the transactional reserve → commit tail-pointer publish and page-rounded
//! chunk chaining, cross-checked against the committed TS fixture.

use wasm_posix_shared::abi;
use wasm_posix_shared::Errno;

use alloc::vec::Vec;

use crate::linked_frames::LinkedFrameFormat;

const PAGE_SIZE: u64 = 65_536;
const ALIGNMENT: u64 = abi::WPK_FORK_LINKED_FRAME_RECORD_ALIGNMENT as u64;
const CHUNK_MAGIC: u32 = 0x4843_464b; // "KFCH", little-endian
const NODE_MAGIC: u32 = 0x4e43_464b; // "KFCN", little-endian
const NODE_RESERVED: u16 = 1;
const NODE_COMMITTED: u16 = 2;

/// Source of page-aligned continuation chunks in guest linear memory.
///
/// Mirrors the `allocate` callback the TS `LinkedForkContinuation` receives: on
/// each call, hand back the guest byte offset of a fresh `capacity`-byte,
/// page-aligned anonymous mapping, or a TRUTHFUL `Errno` (`ENOMEM`/`EAGAIN`)
/// when no mapping is available. The writer validates the returned address and
/// reports `Err(Errno::EINVAL)` only for a structurally invalid address (zero,
/// misaligned, or out of bounds); an allocation FAILURE propagates the
/// allocator's own errno unchanged, so a memory-bounded exhaustion surfaces as
/// `ENOMEM`, never a masked `EINVAL`.
///
/// Any `FnMut(u64) -> Result<u64, Errno>` is a `ChunkAllocator`, so tests and
/// callers can pass a plain closure (e.g. a bump allocator over the byte
/// buffer).
///
/// # Growing allocators (Option B — the channel-mmap allocator)
///
/// The module's `ChannelMmapAllocator` issues each chunk's `SYS_MMAP` through
/// the syscall channel, which GROWS the shared linear memory on demand. A grow
/// leaves the writer's previously-formed `&mut [u8]` view too short to cover the
/// freshly mapped high chunk. So after every `allocate`, the writer re-derives
/// its whole-memory slice from [`current_memory`]; an allocator that never grows
/// memory (fixed-arena / host-test allocators) returns `None` and the writer
/// keeps its existing slice. Shared linear memory never relocates its base on a
/// grow, so re-forming the slice at the same base with the larger length is
/// sound.
///
/// [`current_memory`]: ChunkAllocator::current_memory
pub trait ChunkAllocator {
    /// Allocate `capacity` bytes and return the page-aligned guest byte offset,
    /// or a truthful `Errno` on failure.
    fn allocate(&mut self, capacity: u64) -> Result<u64, Errno>;

    /// The whole guest linear memory as `(base_ptr, len_bytes)` AFTER the most
    /// recent [`allocate`] may have grown it. `None` (the default) means the
    /// memory length is stable and the caller's existing slice stays valid —
    /// fixed-arena and host-test allocators. A GROWING allocator (the module's
    /// channel-mmap allocator) overrides this so the writer re-forms its slice
    /// over the grown region instead of wrongly rejecting the new high chunk.
    ///
    /// [`allocate`]: ChunkAllocator::allocate
    fn current_memory(&self) -> Option<(*mut u8, usize)> {
        None
    }
}

impl<F: FnMut(u64) -> Result<u64, Errno>> ChunkAllocator for F {
    fn allocate(&mut self, capacity: u64) -> Result<u64, Errno> {
        self(capacity)
    }
}

/// The single in-flight reservation between `reserve_frame` and `commit_frame`.
#[derive(Debug, Clone, Copy)]
struct Pending {
    chunk: u64,
    node: u64,
    payload: u64,
    next_used: u64,
}

/// Stateful writer for the linked continuation-frame chain.
///
/// Drive it exactly like the parent unwind path: `begin_unwind` once, then a
/// `reserve_frame` / (caller fills the payload) / `commit_frame` transaction per
/// torn stack frame, innermost first. The outermost frame commits last and
/// becomes the published committed tail — the same order the decoder yields.
#[derive(Debug)]
pub struct LinkedFrameWriter {
    format: LinkedFrameFormat,
    root: u64,
    active_chunk: u64,
    /// Addresses of every allocated chunk, in allocation order. Only the last
    /// (active) address is read — `commit_frame` asserts the pending node still
    /// belongs to it, exactly as the TS controller's chunk-list check does.
    chunks: Vec<u64>,
    pending: Option<Pending>,
    committed_frames: u64,
    committed_bytes: u64,
}

/// Round `value` up to the next multiple of `align`, rejecting overflow.
fn align_up_to(value: u64, align: u64) -> Result<u64, Errno> {
    if align == 0 {
        return Err(Errno::EINVAL);
    }
    let rem = value % align;
    if rem == 0 {
        Ok(value)
    } else {
        value.checked_add(align - rem).ok_or(Errno::EINVAL)
    }
}

/// `addr + size`, rejecting overflow. Mirrors the decoder's `checked_end`.
fn checked_end(addr: u64, size: u64) -> Result<u64, Errno> {
    addr.checked_add(size).ok_or(Errno::EINVAL)
}

/// Re-derive the whole-memory slice after an `allocate` may have grown it.
///
/// A growing allocator (the module's channel-mmap allocator) reports the fresh
/// `(base, len)` via [`ChunkAllocator::current_memory`]; the writer re-forms its
/// slice so a just-mapped high chunk is in bounds. A non-growing allocator
/// returns `None` and the caller's existing slice stays valid.
///
/// This is a FREE FUNCTION returning a bare `&mut [u8]` (not a slice threaded
/// through a tuple return): returning a re-formed `&mut [u8]` from a
/// lifetime-parameterized method's tuple result miscompiles a bare-metal
/// `--pie` wasm side module under release LLVM (the returned slice's fat pointer
/// is corrupted across the multi-value return), so each caller re-derives its
/// own slice locally right after the allocating call instead.
fn resliced<'m, A: ChunkAllocator>(alloc: &A, mem: &'m mut [u8]) -> &'m mut [u8] {
    match alloc.current_memory() {
        // SAFETY: the allocator reports the current base + byte length of the
        // whole guest linear memory it just (possibly) grew; the writer only
        // ever indexes offsets inside chunks that lie within `[base, base+len)`.
        Some((base, len)) => unsafe { core::slice::from_raw_parts_mut(base, len) },
        None => mem,
    }
}

/// Bounds-checked little-endian `u16` write.
fn w_u16(mem: &mut [u8], off: u64, value: u16) -> Result<(), Errno> {
    let off = usize::try_from(off).map_err(|_| Errno::EINVAL)?;
    let end = off.checked_add(2).ok_or(Errno::EINVAL)?;
    let slice = mem.get_mut(off..end).ok_or(Errno::EINVAL)?;
    slice.copy_from_slice(&value.to_le_bytes());
    Ok(())
}

/// Bounds-checked little-endian `u32` write.
fn w_u32(mem: &mut [u8], off: u64, value: u32) -> Result<(), Errno> {
    let off = usize::try_from(off).map_err(|_| Errno::EINVAL)?;
    let end = off.checked_add(4).ok_or(Errno::EINVAL)?;
    let slice = mem.get_mut(off..end).ok_or(Errno::EINVAL)?;
    slice.copy_from_slice(&value.to_le_bytes());
    Ok(())
}

/// Bounds-checked little-endian pointer write of `width` bytes (4 or 8).
///
/// Rejects a value that does not fit the pointer width instead of silently
/// truncating: the TS `writePtr` never writes an out-of-range address because
/// every stored offset is inside the guest memory, so an out-of-range value here
/// is a bug, not something to mask.
fn w_ptr(mem: &mut [u8], off: u64, value: u64, width: u8) -> Result<(), Errno> {
    if width != 4 && width != 8 {
        return Err(Errno::EINVAL);
    }
    if width == 4 && value > u32::MAX as u64 {
        return Err(Errno::EINVAL);
    }
    let off = usize::try_from(off).map_err(|_| Errno::EINVAL)?;
    let end = off.checked_add(width as usize).ok_or(Errno::EINVAL)?;
    let slice = mem.get_mut(off..end).ok_or(Errno::EINVAL)?;
    let bytes = value.to_le_bytes();
    slice.copy_from_slice(&bytes[..width as usize]);
    Ok(())
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

impl LinkedFrameWriter {
    /// Create an inactive writer for the given per-module geometry. The writer
    /// becomes active on `begin_unwind`.
    pub fn new(format: LinkedFrameFormat) -> Self {
        LinkedFrameWriter {
            format,
            root: 0,
            active_chunk: 0,
            chunks: Vec::new(),
            pending: None,
            committed_frames: 0,
            committed_bytes: 0,
        }
    }

    /// Number of committed frames and total committed payload bytes so far.
    pub fn committed(&self) -> (u64, u64) {
        (self.committed_frames, self.committed_bytes)
    }

    /// Begin an unwind: allocate the root chunk, write its header, and return
    /// the module-buffer guest pointer (`root + chunk_header_size`) that the
    /// decoder later takes as its anchor. Mirrors `beginUnwind`
    /// (fork-continuation.ts:271-299).
    pub fn begin_unwind<A: ChunkAllocator>(
        &mut self,
        mut mem: &mut [u8],
        alloc: &mut A,
    ) -> Result<u64, Errno> {
        if self.root != 0 {
            return Err(Errno::EINVAL); // already active
        }
        let p = self.format.pointer_width;
        if p != 4 && p != 8 {
            return Err(Errno::EINVAL);
        }
        let chunk_header = self.format.chunk_header_size as u64;
        let prefix = self.format.fixed_prefix_size as u64;
        let initial_used = align_up_to(chunk_header.checked_add(prefix).ok_or(Errno::EINVAL)?, ALIGNMENT)?;
        let capacity = align_up_to(initial_used.max(PAGE_SIZE), PAGE_SIZE)?;

        let root = self.allocate_chunk(&mut *mem, alloc, capacity, 0, 0)?;
        self.root = root;
        self.active_chunk = root;

        // `allocate_chunk` may have GROWN guest memory (channel-mmap allocator);
        // re-derive our slice so the prefix write below lands in the grown region.
        mem = resliced(alloc, mem);
        // Publish the module-reserved prefix as used, matching beginUnwind.
        let pw = p as u64;
        w_ptr(mem, root + 8 + 4 * pw, initial_used, p)?;

        checked_end(root, chunk_header)?; // guard the returned pointer arithmetic
        Ok(root + chunk_header)
    }

    /// Reserve the next frame node (innermost torn frame first). Writes the KFCN
    /// node header in the `NODE_RESERVED` state and returns the guest byte offset
    /// of the payload the caller must fill before `commit_frame`. Allocates and
    /// chains a fresh chunk when the active chunk cannot hold the node. Mirrors
    /// `reserveFrame` (fork-continuation.ts:448-509).
    pub fn reserve_frame<A: ChunkAllocator>(
        &mut self,
        mut mem: &mut [u8],
        alloc: &mut A,
        payload_size: u64,
    ) -> Result<u64, Errno> {
        if self.root == 0 || self.active_chunk == 0 {
            return Err(Errno::EINVAL); // reservation outside unwind
        }
        if self.pending.is_some() {
            return Err(Errno::EINVAL); // a reservation is already pending
        }
        let p = self.format.pointer_width;
        let pw = p as u64;
        let chunk_header = self.format.chunk_header_size as u64;
        let node_header = self.format.node_header_size as u64;

        let node_size = align_up_to(node_header.checked_add(payload_size).ok_or(Errno::EINVAL)?, ALIGNMENT)?;

        let mut chunk = self.active_chunk;
        let mut used = r_ptr(mem, chunk + 8 + 4 * pw, p)?;
        let mut capacity = r_ptr(mem, chunk + 8 + 3 * pw, p)?;

        if node_size > capacity.saturating_sub(used) {
            let next_capacity = align_up_to(
                PAGE_SIZE.max(chunk_header.checked_add(node_size).ok_or(Errno::EINVAL)?),
                PAGE_SIZE,
            )?;
            // Allocating the fresh chunk may GROW guest memory; re-derive `mem`
            // to the grown slice so the node/header writes below and the final
            // bounds check see the new high chunk in bounds.
            let next = self.allocate_chunk(&mut *mem, alloc, next_capacity, self.root, chunk)?;
            mem = resliced(alloc, mem);
            // Link the previous active chunk to the new one.
            w_ptr(mem, chunk + 8 + 2 * pw, next, p)?;
            self.active_chunk = next;
            chunk = next;
            used = chunk_header;
            capacity = next_capacity;
        }
        if node_size > capacity.saturating_sub(used) {
            return Err(Errno::EINVAL); // allocator returned an undersized chunk
        }

        let node = chunk.checked_add(used).ok_or(Errno::EINVAL)?;
        let payload = node.checked_add(node_header).ok_or(Errno::EINVAL)?;
        let previous = r_ptr(mem, self.root + 8 + 5 * pw, p)?;

        w_u32(mem, node, NODE_MAGIC)?;
        w_u16(mem, node + 4, abi::WPK_FORK_LINKED_FRAME_FORMAT_VERSION)?;
        w_u16(mem, node + 6, NODE_RESERVED)?;
        w_ptr(mem, node + 8, previous, p)?;
        w_ptr(mem, node + 8 + pw, payload_size, p)?;
        w_ptr(mem, node + 8 + 2 * pw, node_size, p)?;

        // Ensure the whole node (header + payload span) is in bounds before the
        // caller writes the payload, so a bad geometry cannot escape as a panic.
        if checked_end(node, node_size)? > mem.len() as u64 {
            return Err(Errno::EINVAL);
        }

        self.pending = Some(Pending {
            chunk,
            node,
            payload,
            next_used: used.checked_add(node_size).ok_or(Errno::EINVAL)?,
        });
        Ok(payload)
    }

    /// Commit the pending reservation: advance the active chunk's `used`, flip
    /// the node to `NODE_COMMITTED`, then publish it as the new committed tail —
    /// the publish is the last write, so replay never observes a half-written
    /// node through the committed chain. Mirrors `commitFrame`
    /// (fork-continuation.ts:511-537).
    pub fn commit_frame(&mut self, mem: &mut [u8], payload: u64) -> Result<(), Errno> {
        let p = self.format.pointer_width;
        let pw = p as u64;
        let pending = self.pending.ok_or(Errno::EINVAL)?;
        if pending.payload != payload {
            return Err(Errno::EINVAL); // does not match the pending reservation
        }
        let active = *self.chunks.last().ok_or(Errno::EINVAL)?;
        if active != pending.chunk {
            return Err(Errno::EINVAL); // pending frame belongs to an inactive chunk
        }

        w_ptr(mem, pending.chunk + 8 + 4 * pw, pending.next_used, p)?;
        let payload_size = r_ptr(mem, pending.node + 8 + pw, p)?;
        w_u16(mem, pending.node + 6, NODE_COMMITTED)?;
        // Final write: publish the new committed tail.
        w_ptr(mem, self.root + 8 + 5 * pw, pending.node, p)?;

        self.committed_frames = self.committed_frames.checked_add(1).ok_or(Errno::EINVAL)?;
        self.committed_bytes = self.committed_bytes.checked_add(payload_size).ok_or(Errno::EINVAL)?;
        self.pending = None;
        Ok(())
    }

    /// End the unwind. Rejects a dangling reservation or an inactive writer,
    /// mirroring `finishUnwind` (fork-continuation.ts:603-610), which performs no
    /// memory writes. The published chain is complete after the last commit.
    pub fn finish_unwind(&self) -> Result<(), Errno> {
        if self.pending.is_some() {
            return Err(Errno::EINVAL); // ended with an uncommitted frame
        }
        if self.root == 0 {
            return Err(Errno::EINVAL); // ended without a continuation
        }
        Ok(())
    }

    /// The module-buffer guest pointer (`root + chunk_header_size`) of the active
    /// continuation. Mirrors `moduleBufferAddress`.
    pub fn module_buffer(&self) -> Result<u64, Errno> {
        if self.root == 0 {
            return Err(Errno::EINVAL);
        }
        checked_end(self.root, self.format.chunk_header_size as u64)
    }

    /// Allocate a chunk, validate the returned address, and write its KFCH
    /// header. Mirrors `allocateChunk` (fork-continuation.ts:732-771). Release on
    /// failure is DEFERRED (see module header); a bad allocation is a truthful
    /// `Err(Errno::EINVAL)`.
    fn allocate_chunk<A: ChunkAllocator>(
        &mut self,
        mem: &mut [u8],
        alloc: &mut A,
        capacity: u64,
        root: u64,
        previous: u64,
    ) -> Result<u64, Errno> {
        let p = self.format.pointer_width;
        let pw = p as u64;
        let chunk_header = self.format.chunk_header_size as u64;

        // Propagate the allocator's OWN errno on failure (memory-bounded
        // exhaustion is a truthful `ENOMEM`/`EAGAIN`, never a masked `EINVAL`).
        let addr = alloc.allocate(capacity)?;
        // The allocation may have GROWN guest memory. Re-derive the whole-memory
        // slice so the freshly mapped high chunk is in bounds; a stale pre-grow
        // slice would wrongly reject it. `None` keeps the caller's slice (fixed
        // arena / host test). Shared memory never relocates its base on grow, so
        // re-forming at the same base with the larger length is sound.
        let mem = resliced(alloc, mem);
        if addr == 0
            || addr % PAGE_SIZE != 0
            || checked_end(addr, capacity)? > mem.len() as u64
        {
            return Err(Errno::EINVAL); // allocator returned an invalid chunk
        }

        w_u32(mem, addr, CHUNK_MAGIC)?;
        w_u16(mem, addr + 4, abi::WPK_FORK_LINKED_FRAME_FORMAT_VERSION)?;
        w_u16(mem, addr + 6, 0)?;
        w_ptr(mem, addr + 8, if root == 0 { addr } else { root }, p)?;
        w_ptr(mem, addr + 8 + pw, previous, p)?;
        w_ptr(mem, addr + 8 + 2 * pw, 0, p)?; // next
        w_ptr(mem, addr + 8 + 3 * pw, capacity, p)?;
        w_ptr(mem, addr + 8 + 4 * pw, chunk_header, p)?; // used
        w_ptr(mem, addr + 8 + 5 * pw, 0, p)?; // committed tail

        self.chunks.push(addr);
        Ok(addr)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::linked_frames::decode_linked_frames;

    const PW: u8 = 4;
    const CHUNK_HEADER: u32 = 32;
    const NODE_HEADER: u32 = 24;
    const PREFIX: u32 = 128;

    fn wasm32_format() -> LinkedFrameFormat {
        LinkedFrameFormat {
            pointer_width: PW,
            chunk_header_size: CHUNK_HEADER,
            node_header_size: NODE_HEADER,
            fixed_prefix_size: PREFIX,
        }
    }

    /// A bump allocator over a byte buffer, matching the TS fixture generator's
    /// page-aligned bump allocator. `None` once the buffer is exhausted.
    struct Bump {
        next: u64,
        limit: u64,
    }

    impl Bump {
        fn new(start: u64, limit: u64) -> Self {
            Bump { next: start, limit }
        }
    }

    impl ChunkAllocator for Bump {
        fn allocate(&mut self, capacity: u64) -> Result<u64, Errno> {
            let addr = self.next;
            let end = addr.checked_add(capacity).ok_or(Errno::ENOMEM)?;
            if end > self.limit {
                return Err(Errno::ENOMEM);
            }
            self.next = end;
            Ok(addr)
        }
    }

    /// Write a frame payload's ABI header + a scalar-fill tail, mirroring the
    /// generator's per-frame payload writes.
    fn write_payload(mem: &mut [u8], payload: u64, func: u32, call: u32, fill: u8, scalar: u64) {
        w_u32(mem, payload, func).unwrap();
        w_u32(mem, payload + 4, call).unwrap();
        w_u32(mem, payload + 8, 0).unwrap(); // catch selector
        w_u32(mem, payload + 12, 0).unwrap(); // reference-vector ordinal
        for i in 0..scalar {
            mem[(payload + 16 + i) as usize] = fill;
        }
    }

    // --- Round-trip across a chunk boundary ------------------------------

    #[test]
    fn round_trip_multi_chunk_decodes_to_written_frames() {
        // Root chunk (cap one page) then a second chunk, so a large frame forces
        // a fresh chunk and the decode must cross the boundary in reverse.
        const ROOT: u64 = PAGE_SIZE;
        let mut mem = alloc::vec![0u8; (PAGE_SIZE * 4) as usize];
        let mut bump = Bump::new(ROOT, PAGE_SIZE * 4);
        let format = wasm32_format();
        let mut w = LinkedFrameWriter::new(format);

        let module_buffer = w.begin_unwind(&mut mem, &mut bump).unwrap();
        assert_eq!(module_buffer, ROOT + CHUNK_HEADER as u64);

        // Frames innermost-first: three small, then one huge (forces a chunk),
        // then one small in the new chunk.
        struct Spec {
            func: u32,
            call: u32,
            fill: u8,
            scalar: u64,
        }
        let specs = [
            Spec { func: 101, call: 1, fill: 0xa1, scalar: 24 },
            Spec { func: 202, call: 2, fill: 0xb2, scalar: 48 },
            Spec { func: 303, call: 3, fill: 0xc3, scalar: 65_200 }, // forces chunk 2
            Spec { func: 404, call: 4, fill: 0xd4, scalar: 32 },
        ];
        let mut node_addrs = alloc::vec![];
        for s in &specs {
            let payload_size = 16 + s.scalar;
            let payload = w.reserve_frame(&mut mem, &mut bump, payload_size).unwrap();
            node_addrs.push(payload - NODE_HEADER as u64);
            write_payload(&mut mem, payload, s.func, s.call, s.fill, s.scalar);
            w.commit_frame(&mut mem, payload).unwrap();
        }
        w.finish_unwind().unwrap();
        assert_eq!(w.committed(), (4, specs.iter().map(|s| 16 + s.scalar).sum()));

        let decoded = decode_linked_frames(&mem, module_buffer, &format).unwrap();

        // Two chunks: the third frame's oversized node did not fit the root
        // page and opened a second chunk carrying frames 3 and 4.
        assert_eq!(decoded.chunks.len(), 2);
        assert_eq!(decoded.chunks[0].addr, ROOT);

        // Replay order is tail-first: outermost committed (frame 4) first.
        assert_eq!(decoded.nodes.len(), 4);
        let expected_tail_first = [
            (404u32, 4u32, 1usize),
            (303, 3, 1),
            (202, 2, 0),
            (101, 1, 0),
        ];
        for (node, (func, call, chunk_index)) in decoded.nodes.iter().zip(expected_tail_first) {
            let header = node.header.unwrap();
            assert_eq!(header.func_index, func);
            assert_eq!(header.call_index, call);
            assert_eq!(node.chunk_index, chunk_index);
        }
        // Node addresses round-trip: decode order is reverse of write order.
        for (node, expected_addr) in decoded.nodes.iter().zip(node_addrs.iter().rev()) {
            assert_eq!(node.node_addr, *expected_addr);
        }
        // The committed tail is the last-committed (outermost) frame.
        assert_eq!(decoded.committed_tail, *node_addrs.last().unwrap());
        assert_eq!(decoded.nodes.last().unwrap().previous, 0);
    }

    // --- Cross-check against the committed TS fixture --------------------

    const TS_FIXTURE: &[u8] = include_bytes!("../testdata/linked-frames-wasm32.bin");
    const FIXTURE_ROOT: u64 = 65_536;
    const FIXTURE_CAPACITY: u64 = 65_536;

    /// Re-encode the exact frame sequence the TS fixture generator
    /// (`gen-linked-frames-fixture.mts`) drives, then assert the used prefix of
    /// the root chunk is byte-for-byte identical to the committed fixture emitted
    /// by the real TS `LinkedForkContinuation`. This proves the Rust writer
    /// reproduces the real TS writer's output, not merely a self-consistent one.
    #[test]
    fn re_encodes_ts_fixture_byte_for_byte() {
        let mut mem = alloc::vec![0u8; (FIXTURE_ROOT + FIXTURE_CAPACITY) as usize];
        let mut bump = Bump::new(FIXTURE_ROOT, FIXTURE_ROOT + FIXTURE_CAPACITY);
        let format = wasm32_format();
        let mut w = LinkedFrameWriter::new(format);

        let module_buffer = w.begin_unwind(&mut mem, &mut bump).unwrap();
        let root = module_buffer - CHUNK_HEADER as u64;
        assert_eq!(root, FIXTURE_ROOT);

        // Exactly the generator's three frames, innermost-first.
        let frames = [(101u32, 1u32, 0xa1u8, 8u64), (202, 2, 0xb2, 16), (303, 3, 0xc3, 24)];
        for (func, call, fill, scalar) in frames {
            let payload_size = 16 + scalar;
            let payload = w.reserve_frame(&mut mem, &mut bump, payload_size).unwrap();
            write_payload(&mut mem, payload, func, call, fill, scalar);
            w.commit_frame(&mut mem, payload).unwrap();
        }
        w.finish_unwind().unwrap();

        let used = r_ptr(&mem, root + 8 + 4 * PW as u64, PW).unwrap();
        let produced = &mem[root as usize..(root + used) as usize];
        assert_eq!(
            produced, TS_FIXTURE,
            "Rust writer output diverged from the committed TS fixture \
             (produced {} bytes, fixture {} bytes)",
            produced.len(),
            TS_FIXTURE.len()
        );

        // And the decoder accepts our re-encoded bytes with the fixture's shape.
        let decoded = decode_linked_frames(&mem, module_buffer, &format).unwrap();
        assert_eq!(decoded.chunks[0].used, 328);
        assert_eq!(decoded.nodes.len(), 3);
        assert_eq!(decoded.committed_tail, 65_800);
    }

    // --- Adversarial: reject bad input without panicking -----------------

    #[test]
    fn rejects_allocation_that_overflows_memory() {
        // Buffer smaller than the first page-sized chunk: begin_unwind's chunk
        // does not fit, so allocation validation must reject it, not panic.
        let mut mem = alloc::vec![0u8; (PAGE_SIZE + 100) as usize];
        let mut bump = Bump::new(PAGE_SIZE, PAGE_SIZE * 8); // ignores mem length
        let mut w = LinkedFrameWriter::new(wasm32_format());
        assert_eq!(w.begin_unwind(&mut mem, &mut bump), Err(Errno::EINVAL));
        assert_eq!(w.module_buffer(), Err(Errno::EINVAL)); // stayed inactive
    }

    #[test]
    fn rejects_misaligned_allocation() {
        let mut mem = alloc::vec![0u8; (PAGE_SIZE * 3) as usize];
        // Allocator hands back a non-page-aligned address.
        let mut alloc = |_cap: u64| Ok(PAGE_SIZE + 1);
        let mut w = LinkedFrameWriter::new(wasm32_format());
        assert_eq!(w.begin_unwind(&mut mem, &mut alloc), Err(Errno::EINVAL));
    }

    #[test]
    fn rejects_exhausted_allocator_with_its_own_errno() {
        // A memory-bounded allocator that fails with ENOMEM must surface ENOMEM
        // (its truthful errno), NOT a masked EINVAL — the Option-B contract.
        let mut mem = alloc::vec![0u8; (PAGE_SIZE * 3) as usize];
        let mut alloc = |_cap: u64| Err(Errno::ENOMEM);
        let mut w = LinkedFrameWriter::new(wasm32_format());
        assert_eq!(w.begin_unwind(&mut mem, &mut alloc), Err(Errno::ENOMEM));
    }

    #[test]
    fn rejects_overflowing_payload_size() {
        let mut mem = alloc::vec![0u8; (PAGE_SIZE * 2) as usize];
        let mut bump = Bump::new(PAGE_SIZE, PAGE_SIZE * 2);
        let mut w = LinkedFrameWriter::new(wasm32_format());
        w.begin_unwind(&mut mem, &mut bump).unwrap();
        // node_header + payload_size overflows u64: rejected, no panic.
        assert_eq!(
            w.reserve_frame(&mut mem, &mut bump, u64::MAX),
            Err(Errno::EINVAL)
        );
    }

    #[test]
    fn rejects_reserve_before_begin_unwind() {
        let mut mem = alloc::vec![0u8; (PAGE_SIZE * 2) as usize];
        let mut bump = Bump::new(PAGE_SIZE, PAGE_SIZE * 2);
        let mut w = LinkedFrameWriter::new(wasm32_format());
        assert_eq!(
            w.reserve_frame(&mut mem, &mut bump, 16),
            Err(Errno::EINVAL)
        );
    }

    #[test]
    fn rejects_double_reservation() {
        let mut mem = alloc::vec![0u8; (PAGE_SIZE * 2) as usize];
        let mut bump = Bump::new(PAGE_SIZE, PAGE_SIZE * 2);
        let mut w = LinkedFrameWriter::new(wasm32_format());
        w.begin_unwind(&mut mem, &mut bump).unwrap();
        w.reserve_frame(&mut mem, &mut bump, 16).unwrap();
        assert_eq!(
            w.reserve_frame(&mut mem, &mut bump, 16),
            Err(Errno::EINVAL)
        );
    }

    #[test]
    fn rejects_begin_unwind_when_already_active() {
        let mut mem = alloc::vec![0u8; (PAGE_SIZE * 2) as usize];
        let mut bump = Bump::new(PAGE_SIZE, PAGE_SIZE * 2);
        let mut w = LinkedFrameWriter::new(wasm32_format());
        w.begin_unwind(&mut mem, &mut bump).unwrap();
        assert_eq!(w.begin_unwind(&mut mem, &mut bump), Err(Errno::EINVAL));
    }

    #[test]
    fn rejects_commit_of_wrong_payload() {
        let mut mem = alloc::vec![0u8; (PAGE_SIZE * 2) as usize];
        let mut bump = Bump::new(PAGE_SIZE, PAGE_SIZE * 2);
        let mut w = LinkedFrameWriter::new(wasm32_format());
        w.begin_unwind(&mut mem, &mut bump).unwrap();
        let payload = w.reserve_frame(&mut mem, &mut bump, 16).unwrap();
        assert_eq!(w.commit_frame(&mut mem, payload + 8), Err(Errno::EINVAL));
    }

    // --- Option B: growth beyond the old fixed 4 MiB arena cap -----------

    /// The old MODULE path capped frames at a fixed 4 MiB host-reserved arena.
    /// Option B is memory-bounded: the writer chains as many page chunks as the
    /// allocator can supply. Drive one-page frames past 4 MiB of chunk storage
    /// (past 64 wasm pages) and prove every frame decodes back — the fixed cap
    /// is gone.
    #[test]
    fn grows_past_the_old_four_mib_cap() {
        const ROOT: u64 = PAGE_SIZE;
        // 12 MiB backing >> the retired 4 MiB cap; enough for >150 page chunks.
        const TOTAL: u64 = 12 * 1024 * 1024;
        let mut mem = alloc::vec![0u8; TOTAL as usize];
        let mut bump = Bump::new(ROOT, TOTAL);
        let format = wasm32_format();
        let mut w = LinkedFrameWriter::new(format);

        let module_buffer = w.begin_unwind(&mut mem, &mut bump).unwrap();
        // Each frame's payload is ~one page, so each forces a fresh chunk; 150
        // frames therefore span ~150 pages (~9.4 MiB), well past the 64-page cap.
        // Payload sized so node_header + payload + chunk_header == one page: each
        // node exactly fills one fresh 1-page chunk (forcing a chunk per frame).
        let one_page_payload = PAGE_SIZE - CHUNK_HEADER as u64 - NODE_HEADER as u64;
        const FRAMES: usize = 150;
        for i in 0..FRAMES {
            let payload = w.reserve_frame(&mut mem, &mut bump, one_page_payload).unwrap();
            write_payload(&mut mem, payload, 500 + i as u32, i as u32, i as u8, 24);
            w.commit_frame(&mut mem, payload).unwrap();
        }
        w.finish_unwind().unwrap();
        assert_eq!(w.committed().0, FRAMES as u64);
        // The total chunk storage bumped past the retired 4 MiB cap.
        assert!(bump.next - ROOT > 4 * 1024 * 1024, "grew past the old 4 MiB cap");

        let decoded = decode_linked_frames(&mem, module_buffer, &format).unwrap();
        assert_eq!(decoded.nodes.len(), FRAMES);
        // Tail-first: last committed (frame 149) decodes first.
        assert_eq!(decoded.nodes[0].header.unwrap().func_index, 500 + (FRAMES as u32 - 1));
        assert_eq!(decoded.nodes.last().unwrap().header.unwrap().func_index, 500);
    }

    /// A 5000-frame chain round-trips (the harness stress workload, at the codec
    /// layer), proving depth is bounded only by available memory, not a cap.
    #[test]
    fn chain_of_5000_frames_round_trips() {
        const ROOT: u64 = PAGE_SIZE;
        const TOTAL: u64 = 8 * 1024 * 1024;
        let mut mem = alloc::vec![0u8; TOTAL as usize];
        let mut bump = Bump::new(ROOT, TOTAL);
        let format = wasm32_format();
        let mut w = LinkedFrameWriter::new(format);

        let module_buffer = w.begin_unwind(&mut mem, &mut bump).unwrap();
        const FRAMES: usize = 5000;
        for i in 0..FRAMES {
            let payload = w.reserve_frame(&mut mem, &mut bump, 32).unwrap();
            write_payload(&mut mem, payload, 1000 + i as u32, i as u32, i as u8, 16);
            w.commit_frame(&mut mem, payload).unwrap();
        }
        w.finish_unwind().unwrap();
        assert_eq!(w.committed().0, FRAMES as u64);

        let decoded = decode_linked_frames(&mem, module_buffer, &format).unwrap();
        assert_eq!(decoded.nodes.len(), FRAMES);
        assert_eq!(decoded.nodes[0].header.unwrap().func_index, 1000 + (FRAMES as u32 - 1));
        assert_eq!(decoded.nodes.last().unwrap().header.unwrap().func_index, 1000);
    }

    // --- Option B CRITICAL RISK: memory grows mid-reserve ----------------

    /// A growing allocator that reports an INCREASING whole-memory length after
    /// each `allocate` — the exact shape of the module's channel-mmap allocator,
    /// where `SYS_MMAP` grows the shared linear memory. The writer forms its view
    /// from a slice that is initially TOO SHORT to cover the chunks this
    /// allocator hands out; only by re-deriving the length from `current_memory`
    /// after each `allocate` can it write into the freshly grown high region.
    struct GrowingArena {
        base: *mut u8,
        total: u64,
        reported: core::cell::Cell<usize>,
        next: u64,
    }

    impl ChunkAllocator for GrowingArena {
        fn allocate(&mut self, capacity: u64) -> Result<u64, Errno> {
            let addr = self.next;
            let end = addr.checked_add(capacity).ok_or(Errno::ENOMEM)?;
            if end > self.total {
                return Err(Errno::ENOMEM);
            }
            self.next = end;
            // Simulate SYS_MMAP growing shared memory: the addressable length now
            // reaches the end of the just-mapped chunk (base is unchanged).
            self.reported.set(end as usize);
            Ok(addr)
        }

        fn current_memory(&self) -> Option<(*mut u8, usize)> {
            Some((self.base, self.reported.get()))
        }
    }

    /// The critical-risk proof: memory grows mid-reserve, and the writer
    /// re-derives its slice so the fresh high chunk is in bounds. Without the
    /// re-derive, the stale short slice would wrongly reject every chunk.
    #[test]
    fn re_derives_slice_after_each_grow() {
        // A large backing buffer the allocator grows INTO one page at a time.
        const TOTAL: u64 = 4 * 1024 * 1024;
        let mut backing = alloc::vec![0u8; TOTAL as usize];
        let base = backing.as_mut_ptr();
        // The initial addressable window is a SINGLE page — far shorter than the
        // chunks the allocator will hand out (which start at page 1).
        let initial_len = PAGE_SIZE as usize;
        let format = wasm32_format();
        let mut w = LinkedFrameWriter::new(format);
        let mut arena = GrowingArena {
            base,
            total: TOTAL,
            reported: core::cell::Cell::new(initial_len),
            next: PAGE_SIZE, // first chunk lands AT the end of the initial window
        };

        // SAFETY: `base` is the live backing buffer; the initial view is one page.
        let mem0: &mut [u8] = unsafe { core::slice::from_raw_parts_mut(base, initial_len) };
        let module_buffer = w.begin_unwind(mem0, &mut arena).unwrap();
        // The root chunk landed at page 1 — beyond the initial one-page window —
        // proving begin_unwind re-derived the grown slice.
        assert_eq!(module_buffer, PAGE_SIZE + CHUNK_HEADER as u64);

        // Drive one-page frames; each forces a fresh chunk that grows memory, so
        // every reserve_frame must re-derive its slice mid-call. Mirror the
        // module: hand each call a fresh view of the CURRENT reported length.
        // One 1-page chunk per node (see grows_past_the_old_four_mib_cap).
        let one_page_payload = PAGE_SIZE - CHUNK_HEADER as u64 - NODE_HEADER as u64;
        const FRAMES: usize = 40; // ~40 pages, well past the initial one-page view
        for i in 0..FRAMES {
            let cur_len = arena.reported.get();
            // SAFETY: `base` + current reported length is the grown memory.
            let mem: &mut [u8] = unsafe { core::slice::from_raw_parts_mut(base, cur_len) };
            let payload = w.reserve_frame(mem, &mut arena, one_page_payload).unwrap();
            let mem: &mut [u8] =
                unsafe { core::slice::from_raw_parts_mut(base, arena.reported.get()) };
            write_payload(mem, payload, 700 + i as u32, i as u32, i as u8, 24);
            w.commit_frame(mem, payload).unwrap();
        }
        w.finish_unwind().unwrap();
        assert_eq!(w.committed().0, FRAMES as u64);

        // Decode over the fully-grown memory: every frame round-trips.
        let mem: &[u8] = unsafe { core::slice::from_raw_parts(base, arena.reported.get()) };
        let decoded = decode_linked_frames(mem, module_buffer, &format).unwrap();
        assert_eq!(decoded.nodes.len(), FRAMES);
        assert_eq!(decoded.nodes[0].header.unwrap().func_index, 700 + (FRAMES as u32 - 1));
        assert_eq!(decoded.nodes.last().unwrap().header.unwrap().func_index, 700);
    }
}
