//! Rewind frame reader/driver: the read-side counterpart to
//! `linked_frames_writer`, driving the child-rewind per-frame walk.
//!
//! Ported from the two live TypeScript authorities that provide the guest's
//! `__wpk_fork_frame_next` / `__wpk_fork_frame_peek` / `__wpk_fork_resume_peek`
//! imports during child rewind:
//!
//! * `host/src/fork-continuation.ts` — `LinkedForkContinuation.peekFrame` /
//!   `nextFrame` (and their private `validateNextFrame`,
//!   `previousReplayPosition`, `setReplayCursor`): the tail-first walk of the
//!   committed linked-frame chain that the writer published, one node per guest
//!   call, validating each node's live header and its `expectedSize` before the
//!   payload is exposed.
//! * `host/src/fork-process-continuation.ts` —
//!   `ForkProcessContinuationController.continuationImports` (its `PEEK` / `NEXT`
//!   / `RESUME_PEEK` handlers plus `readFunctionOrdinal` /
//!   `requireSelectedEvent`): the validation gate that ties each frame walk to
//!   the journal-selected replay event before the guest `br_table`-jumps to the
//!   saved call site.
//!
//! The driver is the reader that ties the already-landed D1/D2 pure-logic pieces
//! together for rewind: it consumes exactly what `linked_frames_writer` produces
//! (`decode_linked_frames` validates the chain and yields the committed nodes in
//! tail-first == outermost-first replay order), reads each node's function
//! ordinal at the payload offset `readFunctionOrdinal` uses, and validates it
//! against the `ReplayEventJournal` (via `require_selected_event` / `consume`)
//! and the `ResumeSlotTable` (`slot_for` for the resume-peek path). Together with
//! the writer's reserve/commit and the journal's capture/replay, this COMPLETES
//! the pure-logic frame-driver core.
//!
//! This slice is PURELY ADDITIVE and validated-but-unused. TypeScript still
//! drives every fork at runtime; nothing here is wired into the host or kernel.
//! The driver is pure over a `&[u8]` guest-memory buffer: the byte slice is the
//! guest linear memory and every stored pointer is a byte offset into it,
//! exactly as the TS controller reads `WebAssembly.Memory.buffer`. It is
//! bounds-checked and panic-free; malformed input returns `Err(Errno::EINVAL)`,
//! never panics.
//!
//! DEFERRED to the engine-floor half (Phase 6 D5+, mirroring how
//! `linked_frames_writer` deferred its live allocator and `replay_journal`
//! deferred its live `WebAssembly.Table`): the live `WebAssembly.Instance` /
//! `Memory` the guest and this module share; the actual guest `br_table` jump to
//! the resumed call site; reference/exception/GC materialization; the live
//! funcref resume table's engine identity (this driver selects only the slot
//! *index* via `ResumeSlotTable`); and the owned-replay `NODE_CONSUMED` scrub
//! `nextFrame` performs on the live mutable memory (this reader walks an
//! immutable `&[u8]`). Those are runtime instance state, not pure logic over the
//! byte buffer.

use wasm_posix_shared::abi;
use wasm_posix_shared::Errno;

use crate::linked_frames::{decode_linked_frames, LinkedFrameFormat, LinkedFrames};
use crate::replay_journal::{ReplayEventJournal, ResumeSlotTable};

const ALIGNMENT: u64 = abi::WPK_FORK_LINKED_FRAME_RECORD_ALIGNMENT as u64;
const NODE_MAGIC: u32 = 0x4e43_464b; // "KFCN", little-endian
const NODE_COMMITTED: u16 = 2;

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

/// Stateful rewind cursor over a guest-memory byte buffer.
///
/// Attach it to the module-buffer anchor the writer published, then drive it
/// exactly like the child rewind path: one `peek_frame` / `next_frame` per torn
/// stack frame, outermost first, or the journal-gated `drive_peek` /
/// `drive_next` that additionally validate each frame against the selected
/// replay event. The cursor advances tail-first through the committed chain and
/// exhausts when the innermost frame (whose `previous == 0`) has been consumed —
/// the same order and terminating condition `LinkedForkContinuation` observes.
#[derive(Debug)]
pub struct RewindDriver {
    format: LinkedFrameFormat,
    /// The decoded chain: chunk geometry plus committed nodes in tail-first
    /// replay order. `decode_linked_frames` validated the whole chain on attach,
    /// exactly as `attachForReplayWithOwnership` decodes chunks before replay.
    frames: LinkedFrames,
    /// Index of the current node in `frames.nodes` (tail-first order). Equals
    /// `frames.nodes.len()` once the chain is fully rewound. Mirrors the live
    /// `replayNode` cursor: index in-range == a non-zero `replayNode`.
    cursor: usize,
}

impl RewindDriver {
    /// Attach to the continuation the writer published and position the cursor at
    /// the committed tail (outermost frame). Decodes and validates the whole
    /// chunk/node chain via `decode_linked_frames`; a malformed continuation
    /// yields `Err(Errno::EINVAL)`. Mirrors `attachForReplayWithOwnership`
    /// (fork-continuation.ts:363) followed by `setReplayCursor` to the committed
    /// tail (:853).
    pub fn attach(
        memory: &[u8],
        module_buffer: u64,
        format: &LinkedFrameFormat,
    ) -> Result<Self, Errno> {
        let frames = decode_linked_frames(memory, module_buffer, format)?;
        Ok(RewindDriver {
            format: *format,
            frames,
            cursor: 0,
        })
    }

    /// The committed-tail node address (the outermost frame the rewind visits
    /// first), or `0` for an empty continuation. Mirrors `committedTail`.
    pub fn committed_tail(&self) -> u64 {
        self.frames.committed_tail
    }

    /// Whether `[start, start + len)` overlaps ANY of the decoded continuation
    /// chunks or the module-buffer anchor — the borrowed-replay guard a vfork
    /// child's PRIVATE module prefix must pass so it never aliases (and thus
    /// never corrupts) the parked parent's continuation storage. Mirrors the
    /// per-chunk overlap check in `attachForBorrowedReplay`
    /// (fork-continuation.ts:336-340), extended to the anchor itself because the
    /// borrowed child reads the parent's fixed prefix FROM `module_buffer` while
    /// writing its own copy TO `[start, start + len)`. A length that overflows is
    /// `Err(Errno::EINVAL)`.
    pub fn borrowed_prefix_conflicts(&self, start: u64, len: u64) -> Result<bool, Errno> {
        let end = start.checked_add(len).ok_or(Errno::EINVAL)?;
        let anchor_end = self
            .frames
            .module_buffer
            .checked_add(len)
            .ok_or(Errno::EINVAL)?;
        if start < anchor_end && end > self.frames.module_buffer {
            return Ok(true); // aliases the parent's fixed-prefix source region
        }
        for chunk in &self.frames.chunks {
            let chunk_end = chunk.addr.checked_add(chunk.capacity).ok_or(Errno::EINVAL)?;
            if start < chunk_end && end > chunk.addr {
                return Ok(true); // aliases borrowed continuation storage
            }
        }
        Ok(false)
    }

    /// Number of frames not yet consumed by `next_frame`.
    pub fn remaining(&self) -> usize {
        self.frames.nodes.len().saturating_sub(self.cursor)
    }

    /// Whether the whole chain has been rewound. Mirrors the live `replayNode
    /// === 0` terminal state.
    pub fn is_exhausted(&self) -> bool {
        self.cursor >= self.frames.nodes.len()
    }

    /// Read the current node's live header and validate it against
    /// `expected_size`, returning `(payload_offset, node_addr)` without
    /// advancing. Mirrors `validateNextFrame` (fork-continuation.ts:565): the
    /// node must be a committed KFCN whose stored payload size equals the guest's
    /// `expected_size` and whose node size is the aligned header+payload. The
    /// header is re-read from live memory (not trusted from the attach-time
    /// decode) so a post-attach corruption is caught here, exactly as the TS
    /// reader re-reads `this.view()` each call.
    fn validate_current(&self, memory: &[u8], expected_size: u64) -> Result<(u64, u64), Errno> {
        let node = self.frames.nodes.get(self.cursor).ok_or(Errno::EINVAL)?; // exhausted early
        let p = self.format.pointer_width;
        let pw = p as u64;
        let node_header = self.format.node_header_size as u64;
        let addr = node.node_addr;

        if r_u32(memory, addr)? != NODE_MAGIC
            || r_u16(memory, addr + 4)? != abi::WPK_FORK_LINKED_FRAME_FORMAT_VERSION
            || r_u16(memory, addr + 6)? != NODE_COMMITTED
        {
            return Err(Errno::EINVAL); // invalid or uncommitted node
        }
        let payload_size = r_ptr(memory, addr + 8 + pw, p)?;
        if payload_size != expected_size {
            return Err(Errno::EINVAL); // frame size does not match the guest request
        }
        let node_size = r_ptr(memory, addr + 8 + 2 * pw, p)?;
        if node_size != align_up(node_header.checked_add(payload_size).ok_or(Errno::EINVAL)?)? {
            return Err(Errno::EINVAL); // invalid node bounds
        }
        let payload = addr.checked_add(node_header).ok_or(Errno::EINVAL)?;
        Ok((payload, addr))
    }

    /// Validate and expose the current frame's payload pointer without advancing
    /// the cursor. Mirrors `peekFrame` (fork-continuation.ts:546).
    pub fn peek_frame(&self, memory: &[u8], expected_size: u64) -> Result<u64, Errno> {
        let (payload, _addr) = self.validate_current(memory, expected_size)?;
        Ok(payload)
    }

    /// Validate the current frame, advance the cursor to its predecessor, and
    /// return the payload pointer. Mirrors `nextFrame` (fork-continuation.ts:552).
    ///
    /// The advance follows the node's live `previous` pointer (the terminating
    /// condition is `previous == 0`, the innermost frame) and cross-checks it
    /// against the decoded tail-first order: the predecessor address must be the
    /// next decoded node, or `0` exactly when the decoded chain ends. A live
    /// `previous` that disagrees with the decoded chain (a post-attach
    /// corruption) is `Err(Errno::EINVAL)`, not a panic; the cursor is only moved
    /// once every check passes.
    pub fn next_frame(&mut self, memory: &[u8], expected_size: u64) -> Result<u64, Errno> {
        let (payload, addr) = self.validate_current(memory, expected_size)?;
        let p = self.format.pointer_width;
        let previous = r_ptr(memory, addr + 8, p)?;
        let next_index = self.cursor.checked_add(1).ok_or(Errno::EINVAL)?;
        match self.frames.nodes.get(next_index) {
            Some(next) => {
                if next.node_addr != previous {
                    return Err(Errno::EINVAL); // live chain disagrees with decoded order
                }
            }
            None => {
                if previous != 0 {
                    return Err(Errno::EINVAL); // chain claims more frames than were committed
                }
            }
        }
        self.cursor = next_index;
        Ok(payload)
    }

    /// Read a frame's function ordinal from its payload. Mirrors
    /// `readFunctionOrdinal` (fork-process-continuation.ts:995): the ordinal is
    /// the little-endian `u32` at the payload pointer (the ABI frame header's
    /// leading `func_index`). Bounds-checked; an out-of-range payload is
    /// `Err(Errno::EINVAL)`.
    pub fn read_function_ordinal(memory: &[u8], payload: u64) -> Result<u32, Errno> {
        r_u32(memory, payload)
    }

    /// Journal-gated non-consuming peek. Mirrors the `PEEK` import handler
    /// (fork-process-continuation.ts:261): select the current replay event for
    /// `activation_id` (`require_selected_event`), expose the current frame
    /// (`peek_frame`), and require the frame's function ordinal to equal the
    /// selected event's before returning the payload pointer. Neither the cursor
    /// nor the journal advances.
    pub fn drive_peek(
        &self,
        memory: &[u8],
        journal: &mut ReplayEventJournal,
        activation_id: u32,
        expected_size: u64,
    ) -> Result<u64, Errno> {
        let event = journal.require_selected_event(activation_id)?;
        let payload = self.peek_frame(memory, expected_size)?;
        let ordinal = Self::read_function_ordinal(memory, payload)?;
        if ordinal != event.function_ordinal {
            return Err(Errno::EINVAL); // frame belongs to a different function
        }
        Ok(payload)
    }

    /// Journal-gated consuming advance. Mirrors the `NEXT` import handler
    /// (fork-process-continuation.ts:277): select the current replay event, then
    /// validate the frame's function ordinal through the NON-consuming peek FIRST
    /// (a bad coordinate must not advance the linked cursor), advance the frame
    /// cursor (`next_frame`), and only then `consume` the journal event. The
    /// frame walk and the journal advance in lockstep.
    pub fn drive_next(
        &mut self,
        memory: &[u8],
        journal: &mut ReplayEventJournal,
        activation_id: u32,
        expected_size: u64,
    ) -> Result<u64, Errno> {
        let event = journal.require_selected_event(activation_id)?;
        // Validate identity through the non-consuming path first so a bad
        // coordinate cannot advance the linked cursor.
        let peeked = self.peek_frame(memory, expected_size)?;
        let ordinal = Self::read_function_ordinal(memory, peeked)?;
        if ordinal != event.function_ordinal {
            return Err(Errno::EINVAL); // frame belongs to a different function
        }
        let payload = self.next_frame(memory, expected_size)?;
        journal.consume(activation_id, ordinal)?;
        Ok(payload)
    }

    /// Resume-slot for the currently selected replay event. Mirrors the
    /// `RESUME_PEEK` import handler (fork-process-continuation.ts:298):
    /// `resumeTable.slotFor(events.peek())`. A `None` peek (stream exhausted)
    /// yields the reserved sentinel slot 0; an unregistered coordinate is
    /// `Err(Errno::EINVAL)`. Static because the resume selection is a journal +
    /// table concern, independent of the frame cursor, exactly as the controller
    /// wires it.
    pub fn resume_peek(
        journal: &mut ReplayEventJournal,
        table: &ResumeSlotTable,
    ) -> Result<u32, Errno> {
        table.slot_for(journal.peek()?)
    }

    /// Finish the rewind, requiring every committed frame consumed. Mirrors
    /// `finishReplayAndRelease` (fork-continuation.ts:612) — its `replayNode !==
    /// 0` guard — without the owned-storage release, which is engine-floor
    /// (deferred; see module header).
    pub fn finish_rewind(&self) -> Result<(), Errno> {
        if !self.is_exhausted() {
            return Err(Errno::EINVAL); // rewind ended before all frames were consumed
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::linked_frames::decode_linked_frames;
    use crate::linked_frames_writer::{ChunkAllocator, LinkedFrameWriter};
    use crate::replay_events::ReplayEvent;

    use alloc::vec::Vec;

    const PW: u8 = 4;
    const CHUNK_HEADER: u32 = 32;
    const NODE_HEADER: u32 = 24;
    const PREFIX: u32 = 128;
    const PAGE_SIZE: u64 = 65_536;

    fn wasm32_format() -> LinkedFrameFormat {
        LinkedFrameFormat {
            pointer_width: PW,
            chunk_header_size: CHUNK_HEADER,
            node_header_size: NODE_HEADER,
            fixed_prefix_size: PREFIX,
        }
    }

    /// Page-aligned bump allocator over a byte buffer, matching the writer's own
    /// test allocator.
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

    fn w_u32(mem: &mut [u8], off: u64, value: u32) {
        let off = off as usize;
        mem[off..off + 4].copy_from_slice(&value.to_le_bytes());
    }

    fn put_u16(mem: &mut [u8], off: u64, value: u16) {
        let off = off as usize;
        mem[off..off + 2].copy_from_slice(&value.to_le_bytes());
    }

    fn put_ptr(mem: &mut [u8], off: u64, value: u64) {
        let off = off as usize;
        mem[off..off + PW as usize].copy_from_slice(&(value as u32).to_le_bytes());
    }

    /// Write a frame payload: the ABI frame header (leading `func_index`) plus a
    /// scalar-fill tail, mirroring the writer's fixture generator.
    fn write_payload(mem: &mut [u8], payload: u64, func: u32, call: u32, fill: u8, scalar: u64) {
        w_u32(mem, payload, func); // func_index (== function ordinal)
        w_u32(mem, payload + 4, call);
        w_u32(mem, payload + 8, 0); // catch selector
        w_u32(mem, payload + 12, 0); // reference-vector ordinal
        for i in 0..scalar {
            mem[(payload + 16 + i) as usize] = fill;
        }
    }

    struct FrameSpec {
        func: u32,
        call: u32,
        fill: u8,
        scalar: u64,
    }

    impl FrameSpec {
        fn payload_size(&self) -> u64 {
            16 + self.scalar
        }
    }

    /// Write a multi-chunk chain with the real writer and capture the exact
    /// frame commit sequence into a fresh parent journal (leaf-to-root, the same
    /// order `recordCommit` runs during unwind). Returns
    /// `(memory, module_buffer, node_addrs_in_commit_order, journal, table)`.
    ///
    /// The whole point of this closed loop is that the WRITER, the READER, and
    /// the JOURNAL are three independent ports; if any two disagree on the wire
    /// layout or the replay order, driving the reader across the chain fails.
    fn build_closed_loop(
        activation_id: u32,
        specs: &[FrameSpec],
    ) -> (Vec<u8>, u64, Vec<u64>, ReplayEventJournal, ResumeSlotTable) {
        let mut mem = alloc::vec![0u8; (PAGE_SIZE * 8) as usize];
        let mut bump = Bump::new(PAGE_SIZE, PAGE_SIZE * 8);
        let format = wasm32_format();
        let mut writer = LinkedFrameWriter::new(format);

        let module_buffer = writer.begin_unwind(&mut mem, &mut bump).unwrap();

        let mut journal = ReplayEventJournal::new();
        journal.begin_capture().unwrap();

        let mut node_addrs = Vec::new();
        for spec in specs {
            let payload = writer
                .reserve_frame(&mut mem, &mut bump, spec.payload_size())
                .unwrap();
            node_addrs.push(payload - NODE_HEADER as u64);
            write_payload(&mut mem, payload, spec.func, spec.call, spec.fill, spec.scalar);
            writer.commit_frame(&mut mem, payload).unwrap();
            // The controller records the commit's function ordinal (func_index).
            journal.record_commit(activation_id, spec.func).unwrap();
        }
        writer.finish_unwind().unwrap();
        journal.seal_capture().unwrap();
        journal.begin_parent_replay().unwrap();

        // Register the activation's resume targets so slot_for resolves.
        let ordinals: Vec<u32> = specs.iter().map(|s| s.func).collect();
        let mut table = ResumeSlotTable::new();
        table.register_activation(activation_id, &ordinals).unwrap();

        (mem, module_buffer, node_addrs, journal, table)
    }

    // --- Borrowed-replay private-prefix overlap guard ---------------------

    #[test]
    fn borrowed_prefix_conflicts_flags_anchor_and_chunk_overlap() {
        const ACT: u32 = 5;
        let specs = [
            FrameSpec { func: 101, call: 1, fill: 0xa1, scalar: 24 },
            FrameSpec { func: 202, call: 2, fill: 0xb2, scalar: 48 },
        ];
        let (mem, module_buffer, _node_addrs, _journal, _table) = build_closed_loop(ACT, &specs);
        let driver = RewindDriver::attach(&mem, module_buffer, &wasm32_format()).unwrap();
        let decoded = decode_linked_frames(&mem, module_buffer, &wasm32_format()).unwrap();
        let prefix = wasm32_format().fixed_prefix_size as u64;

        // A private prefix landing ON the source anchor aliases the parent's own
        // fixed prefix — the exact corruption the guard prevents.
        assert!(driver.borrowed_prefix_conflicts(module_buffer, prefix).unwrap());

        // A private prefix inside any borrowed continuation chunk aliases live
        // storage the read-only replay still reads.
        for chunk in &decoded.chunks {
            assert!(driver.borrowed_prefix_conflicts(chunk.addr, prefix).unwrap());
            assert!(driver
                .borrowed_prefix_conflicts(chunk.addr + chunk.capacity - 1, prefix)
                .unwrap());
        }

        // A disjoint region (past every chunk) is accepted.
        let past = decoded
            .chunks
            .iter()
            .map(|c| c.addr + c.capacity)
            .max()
            .unwrap();
        assert!(!driver.borrowed_prefix_conflicts(past, prefix).unwrap());

        // An overflowing length is a truthful error, not a silent false.
        assert_eq!(
            driver.borrowed_prefix_conflicts(u64::MAX, prefix),
            Err(Errno::EINVAL)
        );
    }

    // --- Closed loop: writer -> reader -> journal all agree ---------------

    #[test]
    fn closed_loop_drives_full_chain_in_rewind_order() {
        const ACT: u32 = 7;
        // Innermost-first commit order: three small frames, one oversized frame
        // that forces a second chunk, then one small frame in the new chunk.
        let specs = [
            FrameSpec { func: 101, call: 1, fill: 0xa1, scalar: 24 },
            FrameSpec { func: 202, call: 2, fill: 0xb2, scalar: 48 },
            FrameSpec { func: 303, call: 3, fill: 0xc3, scalar: 65_200 }, // forces chunk 2
            FrameSpec { func: 404, call: 4, fill: 0xd4, scalar: 32 },
        ];
        let (mem, module_buffer, node_addrs, mut journal, table) = build_closed_loop(ACT, &specs);

        let decoded = decode_linked_frames(&mem, module_buffer, &wasm32_format()).unwrap();
        assert_eq!(decoded.chunks.len(), 2, "oversized frame must open a second chunk");

        let mut driver = RewindDriver::attach(&mem, module_buffer, &wasm32_format()).unwrap();
        assert_eq!(driver.remaining(), specs.len());
        assert_eq!(driver.committed_tail(), *node_addrs.last().unwrap());

        // Rewind order is tail-first: the last-committed (outermost) frame first,
        // i.e. commit order reversed. Both the journal and the linked chain must
        // yield exactly this sequence, in lockstep.
        for spec in specs.iter().rev() {
            let expected_size = spec.payload_size();

            // resume_peek resolves the current event to its registered slot.
            let slot = RewindDriver::resume_peek(&mut journal, &table).unwrap();
            assert!(slot >= 1, "a registered coordinate must not be the sentinel");
            assert_eq!(table.slot_for(journal.peek().unwrap()).unwrap(), slot);

            // Non-consuming journal-gated peek exposes the payload and validates
            // the ordinal without advancing.
            let peeked = driver.drive_peek(&mem, &mut journal, ACT, expected_size).unwrap();
            assert_eq!(RewindDriver::read_function_ordinal(&mem, peeked).unwrap(), spec.func);

            // Consuming advance returns the same payload and advances both cursors.
            let before = driver.remaining();
            let payload = driver.drive_next(&mem, &mut journal, ACT, expected_size).unwrap();
            assert_eq!(payload, peeked);
            assert_eq!(driver.remaining(), before - 1);
            // The payload's scalar fill round-trips: this really is that frame.
            assert_eq!(mem[(payload + 16) as usize], spec.fill);
        }

        // Both the frame cursor and the journal are exhausted together.
        assert!(driver.is_exhausted());
        assert_eq!(driver.peek_frame(&mem, 0), Err(Errno::EINVAL));
        assert_eq!(RewindDriver::resume_peek(&mut journal, &table).unwrap(), 0); // sentinel
        driver.finish_rewind().unwrap();
        journal.finish_replay().unwrap();
    }

    #[test]
    fn closed_loop_single_frame_round_trips() {
        const ACT: u32 = 3;
        let specs = [FrameSpec { func: 55, call: 1, fill: 0xee, scalar: 8 }];
        let (mem, module_buffer, node_addrs, mut journal, _table) = build_closed_loop(ACT, &specs);

        let mut driver = RewindDriver::attach(&mem, module_buffer, &wasm32_format()).unwrap();
        assert_eq!(driver.committed_tail(), node_addrs[0]);
        let payload = driver.drive_next(&mem, &mut journal, ACT, 24).unwrap();
        assert_eq!(RewindDriver::read_function_ordinal(&mem, payload).unwrap(), 55);
        driver.finish_rewind().unwrap();
        journal.finish_replay().unwrap();
        assert_eq!(driver.remaining(), 0);
    }

    // --- Fixture: real TS-writer output, independent walk vs the decoder ---

    const TS_FIXTURE: &[u8] = include_bytes!("../testdata/linked-frames-wasm32.bin");
    const FIXTURE_ROOT: u64 = 65_536;
    const FIXTURE_MODULE_BUFFER: u64 = 65_568;
    const FIXTURE_CAPACITY: u64 = 65_536;

    fn fixture_memory() -> Vec<u8> {
        let mut mem = alloc::vec![0u8; FIXTURE_ROOT as usize];
        mem.extend_from_slice(TS_FIXTURE);
        mem.resize((FIXTURE_ROOT + FIXTURE_CAPACITY) as usize, 0);
        mem
    }

    #[test]
    fn fixture_walk_matches_decoder_frame_for_frame() {
        let mem = fixture_memory();
        let format = wasm32_format();
        let decoded = decode_linked_frames(&mem, FIXTURE_MODULE_BUFFER, &format).unwrap();
        assert_eq!(decoded.nodes.len(), 3);

        let mut driver = RewindDriver::attach(&mem, FIXTURE_MODULE_BUFFER, &format).unwrap();
        assert_eq!(driver.committed_tail(), decoded.committed_tail);

        // The driver's independent `previous`-pointer walk must visit the same
        // nodes, in the same tail-first order, that the decoder yielded.
        for node in &decoded.nodes {
            assert!(!driver.is_exhausted());
            let expected_size = node.payload_size;
            let peeked = driver.peek_frame(&mem, expected_size).unwrap();
            assert_eq!(peeked, node.payload_offset);
            let ordinal = RewindDriver::read_function_ordinal(&mem, peeked).unwrap();
            assert_eq!(ordinal, node.header.unwrap().func_index);
            let payload = driver.next_frame(&mem, expected_size).unwrap();
            assert_eq!(payload, node.payload_offset);
        }
        assert!(driver.is_exhausted());
        driver.finish_rewind().unwrap();
    }

    // --- Non-vacuity: the walk is order-sensitive -------------------------

    #[test]
    fn walk_is_tail_first_not_innermost_first() {
        let mem = fixture_memory();
        let format = wasm32_format();
        let decoded = decode_linked_frames(&mem, FIXTURE_MODULE_BUFFER, &format).unwrap();
        assert!(decoded.nodes.len() >= 2, "need multiple frames for order to matter");

        let driver = RewindDriver::attach(&mem, FIXTURE_MODULE_BUFFER, &format).unwrap();
        // The first frame the driver exposes is the committed TAIL (outermost),
        // never the innermost frame. A reversed-order oracle would fail here.
        let first = decoded.nodes.first().unwrap();
        let last = decoded.nodes.last().unwrap();
        assert_ne!(first.payload_offset, last.payload_offset);
        assert_eq!(
            driver.peek_frame(&mem, first.payload_size).unwrap(),
            first.payload_offset,
        );
        // The innermost frame's size (if different) does not even validate first.
        if first.payload_size != last.payload_size {
            assert_eq!(driver.peek_frame(&mem, last.payload_size), Err(Errno::EINVAL));
        }
    }

    // --- Adversarial: panic-free Err on every corruption ------------------

    #[test]
    fn attach_rejects_truncated_chain() {
        let mut mem = fixture_memory();
        mem.truncate((FIXTURE_ROOT + 100) as usize);
        assert_eq!(
            RewindDriver::attach(&mem, FIXTURE_MODULE_BUFFER, &wasm32_format()).err(),
            Some(Errno::EINVAL),
        );
    }

    #[test]
    fn peek_rejects_tail_node_corrupted_after_attach() {
        let mem = fixture_memory();
        let format = wasm32_format();
        let driver = RewindDriver::attach(&mem, FIXTURE_MODULE_BUFFER, &format).unwrap();
        // Corrupt the committed tail node's KFCN magic after a valid attach.
        let mut corrupt = mem.clone();
        w_u32(&mut corrupt, driver.committed_tail(), 0xdead_beef);
        let tail_size = corrupt_tail_payload_size(&corrupt, driver.committed_tail());
        assert_eq!(driver.peek_frame(&corrupt, tail_size), Err(Errno::EINVAL));
    }

    fn corrupt_tail_payload_size(mem: &[u8], tail: u64) -> u64 {
        // The tail node's payload size, read directly for the expected-size arg.
        r_ptr(mem, tail + 8 + PW as u64, PW).unwrap()
    }

    #[test]
    fn peek_rejects_expected_size_mismatch() {
        let mem = fixture_memory();
        let driver = RewindDriver::attach(&mem, FIXTURE_MODULE_BUFFER, &wasm32_format()).unwrap();
        // The real tail payload is 40 bytes; a different expected size is rejected.
        assert_eq!(driver.peek_frame(&mem, 39), Err(Errno::EINVAL));
        assert_eq!(driver.peek_frame(&mem, 41), Err(Errno::EINVAL));
        // The correct size still validates.
        assert!(driver.peek_frame(&mem, 40).is_ok());
    }

    #[test]
    fn peek_rejects_uncommitted_tail_node() {
        let mut mem = fixture_memory();
        // Flip the tail node's state from COMMITTED (2) to RESERVED (1).
        put_u16(&mut mem, 65_800 + 6, 1);
        let driver = RewindDriver::attach(&mem, FIXTURE_MODULE_BUFFER, &wasm32_format());
        // decode itself rejects a non-committed tail, so attach already fails.
        assert_eq!(driver.err(), Some(Errno::EINVAL));
    }

    #[test]
    fn next_past_end_errs() {
        let mem = fixture_memory();
        let format = wasm32_format();
        let mut driver = RewindDriver::attach(&mem, FIXTURE_MODULE_BUFFER, &format).unwrap();
        // Consume all three frames with their true sizes (40, 32, 24).
        for size in [40u64, 32, 24] {
            driver.next_frame(&mem, size).unwrap();
        }
        assert!(driver.is_exhausted());
        // One more advance is rejected, not a panic.
        assert_eq!(driver.next_frame(&mem, 24), Err(Errno::EINVAL));
        assert_eq!(driver.peek_frame(&mem, 24), Err(Errno::EINVAL));
    }

    #[test]
    fn peek_on_empty_continuation_errs() {
        // A continuation with a root chunk but no committed frames: begin_unwind
        // then finish with nothing reserved.
        let mut mem = alloc::vec![0u8; (PAGE_SIZE * 2) as usize];
        let mut bump = Bump::new(PAGE_SIZE, PAGE_SIZE * 2);
        let mut writer = LinkedFrameWriter::new(wasm32_format());
        let module_buffer = writer.begin_unwind(&mut mem, &mut bump).unwrap();

        let driver = RewindDriver::attach(&mem, module_buffer, &wasm32_format()).unwrap();
        assert!(driver.is_exhausted());
        assert_eq!(driver.remaining(), 0);
        assert_eq!(driver.committed_tail(), 0);
        assert_eq!(driver.peek_frame(&mem, 0), Err(Errno::EINVAL));
        driver.finish_rewind().unwrap(); // already exhausted
    }

    #[test]
    fn next_rejects_wrong_terminating_previous_pointer() {
        const ACT: u32 = 1;
        // A two-frame chain so the tail node has a non-zero predecessor.
        let specs = [
            FrameSpec { func: 11, call: 1, fill: 0x11, scalar: 8 },
            FrameSpec { func: 22, call: 2, fill: 0x22, scalar: 8 },
        ];
        let (mem, module_buffer, node_addrs, _journal, _table) = build_closed_loop(ACT, &specs);

        // Corrupt the tail node's `previous` pointer AFTER a valid attach, so the
        // live walk disagrees with the decoded order.
        let mut corrupt = mem.clone();
        let tail = *node_addrs.last().unwrap();
        put_ptr(&mut corrupt, tail + 8, 0); // claim the outermost frame is innermost

        let mut driver = RewindDriver::attach(&mem, module_buffer, &wasm32_format()).unwrap();
        assert_eq!(driver.next_frame(&corrupt, 24), Err(Errno::EINVAL));
        // The cursor did not advance on the rejected step.
        assert_eq!(driver.remaining(), specs.len());
    }

    #[test]
    fn drive_next_rejects_ordinal_mismatch_without_advancing() {
        const ACT: u32 = 9;
        let specs = [
            FrameSpec { func: 100, call: 1, fill: 0x10, scalar: 8 },
            FrameSpec { func: 200, call: 2, fill: 0x20, scalar: 8 },
        ];
        let (mut mem, module_buffer, _addrs, mut journal, _table) = build_closed_loop(ACT, &specs);

        let mut driver = RewindDriver::attach(&mem, module_buffer, &wasm32_format()).unwrap();
        // Rewind order: outermost (func 200) first. Corrupt its stored ordinal so
        // it disagrees with the journal-selected event.
        let tail = driver.committed_tail();
        w_u32(&mut mem, tail + NODE_HEADER as u64, 999);
        assert_eq!(driver.drive_next(&mem, &mut journal, ACT, 24), Err(Errno::EINVAL));
        // Neither the frame cursor nor the journal advanced.
        assert_eq!(driver.remaining(), specs.len());
        assert_eq!(journal.peek().unwrap().unwrap(), ReplayEvent { activation_id: ACT, function_ordinal: 200 });
    }

    #[test]
    fn drive_peek_rejects_wrong_activation() {
        const ACT: u32 = 4;
        let specs = [FrameSpec { func: 77, call: 1, fill: 0x77, scalar: 8 }];
        let (mem, module_buffer, _addrs, mut journal, _table) = build_closed_loop(ACT, &specs);

        let driver = RewindDriver::attach(&mem, module_buffer, &wasm32_format()).unwrap();
        // A frame claiming the wrong activation is rejected by the journal gate.
        assert_eq!(driver.drive_peek(&mem, &mut journal, ACT + 1, 24), Err(Errno::EINVAL));
    }

    #[test]
    fn attach_rejects_misaligned_module_buffer() {
        let mem = fixture_memory();
        // A module_buffer that yields a non-page-aligned root: decode rejects it.
        assert_eq!(
            RewindDriver::attach(&mem, FIXTURE_MODULE_BUFFER + 8, &wasm32_format()).err(),
            Some(Errno::EINVAL),
        );
    }

    #[test]
    fn arbitrary_expected_sizes_and_anchors_never_panic() {
        let mem = fixture_memory();
        let format = wasm32_format();
        // Sweep anchors (many invalid) and expected sizes; every outcome must be
        // Ok or Err, never a panic.
        for anchor in (0..200_000u64).step_by(1_111) {
            if let Ok(mut driver) = RewindDriver::attach(&mem, anchor, &format) {
                for size in (0..80u64).step_by(7) {
                    let _ = driver.peek_frame(&mem, size);
                    let _ = driver.next_frame(&mem, size);
                }
            }
        }
    }
}
