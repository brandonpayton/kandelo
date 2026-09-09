//! Stateful replay-event journal + resume-slot selection (the D2 live half).
//!
//! Ported from the two live classes in `host/src/fork-replay-events.ts`:
//! `ForkReplayEventJournal` (the phase machine that records committed frames
//! during unwind and consumes them in reverse during rewind) and the
//! slot-selection logic of `ForkResumeTable` (`slotFor` + the register /
//! unregister slot allocator). The sibling `replay_events.rs` decodes the KFRE
//! *wire*; this module is the STATEFUL consumer seeded from those decoded
//! events, exactly the coupling
//! `.superpowers/sdd/2026-09-01-phase6-fork-exec/D2-CORESIDENT-MODULE-DESIGN.md`
//! "Frame-allocator hot loop" identifies as load-bearing: the journal must move
//! into the co-resident module alongside the frame allocator, else the Rust
//! allocator would call back into JS per frame.
//!
//! This slice is PURELY ADDITIVE and validated-but-unused. TypeScript still
//! drives every fork at runtime; nothing here is wired into the host or kernel.
//!
//! Semantics reproduced from the TS classes:
//!
//! * The journal is a phase machine `Idle -> Capture -> SealedParent -> Replay`
//!   (parent path) or `Idle -> Replay` (child path via `attach_child`). Every
//!   operation validates its phase and returns `Err(Errno::EINVAL)` on a wrong
//!   phase rather than panicking.
//! * Capture appends `(activation_id, function_ordinal)` events in unwind
//!   (leaf-to-root) order. Replay walks the captured sequence *backwards* — the
//!   last-committed (outermost/root) frame first — matching the tail-first order
//!   `decode_linked_frames` yields, so the journal and the linked-frame chain
//!   advance in lockstep.
//! * `peek` is non-consuming and caches the selected event; `consume` requires a
//!   prior selection and that the caller's `(activation_id, function_ordinal)`
//!   equals the selected event (`ForkReplayEventJournal.consume`'s validation),
//!   then advances the cursor. `require_selected_event` mirrors the coordinator's
//!   `requireSelectedEvent`: it selects the current event and enforces that its
//!   activation matches the frame's activation before the ordinal is compared.
//! * The resume-slot table reproduces `ForkResumeTable`'s allocator: slot 0 is a
//!   reserved sentinel (`slot_for(None) == 0`), registration sorts a batch by
//!   function ordinal and assigns the smallest free slot first (freed slots are
//!   reused, matching the sorted free-list), and `slot_for(Some(event))` returns
//!   the registered slot or `Err(Errno::EINVAL)` for an unknown coordinate.
//!
//! DEFERRED to the engine-floor half (Phase 6 D5+, out of scope here, mirroring
//! how `linked_frames_writer` deferred its live allocator): the live
//! `WebAssembly.Table` of funcref resume thunks (this module owns only the slot
//! *index* selection — an owned index map — not the engine table value), the
//! reference/exception/GC broker that mints and roots externref/anyref/exnref
//! identities during rewind, and any GC/exception materialization. Those are
//! runtime instance state, not pure stateful logic over decoded events.

use wasm_posix_shared::Errno;

use alloc::collections::{BTreeMap, BTreeSet};
use alloc::vec::Vec;

use crate::replay_events::ReplayEvent;

/// Journal lifecycle phase. Mirrors the TS `JournalPhase` union.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum JournalPhase {
    Idle,
    Capture,
    SealedParent,
    Replay,
}

/// Stateful replay-event journal. Mirrors `ForkReplayEventJournal`.
#[derive(Debug)]
pub struct ReplayEventJournal {
    phase: JournalPhase,
    events: Vec<ReplayEvent>,
    remaining: usize,
    selected: Option<ReplayEvent>,
}

impl Default for ReplayEventJournal {
    fn default() -> Self {
        Self::new()
    }
}

impl ReplayEventJournal {
    /// A fresh, idle journal.
    pub fn new() -> Self {
        ReplayEventJournal {
            phase: JournalPhase::Idle,
            events: Vec::new(),
            remaining: 0,
            selected: None,
        }
    }

    /// Current phase. Mirrors `phaseName`.
    pub fn phase(&self) -> JournalPhase {
        self.phase
    }

    /// Begin a capture. `Idle -> Capture`. Mirrors `beginCapture`.
    pub fn begin_capture(&mut self) -> Result<(), Errno> {
        self.require_phase(JournalPhase::Idle)?;
        self.events.clear();
        self.remaining = 0;
        self.selected = None;
        self.phase = JournalPhase::Capture;
        Ok(())
    }

    /// Record a committed frame during unwind (leaf-to-root order). Capture only.
    /// Mirrors `recordCommit`; the `u32` arguments are inherently valid, so the
    /// TS `assertU32` range check has no Rust analogue.
    pub fn record_commit(&mut self, activation_id: u32, function_ordinal: u32) -> Result<(), Errno> {
        self.require_phase(JournalPhase::Capture)?;
        self.events.push(ReplayEvent { activation_id, function_ordinal });
        Ok(())
    }

    /// Seal the captured journal. `Capture -> SealedParent`. Mirrors `sealCapture`.
    pub fn seal_capture(&mut self) -> Result<(), Errno> {
        self.require_phase(JournalPhase::Capture)?;
        self.phase = JournalPhase::SealedParent;
        Ok(())
    }

    /// Number of captured events. Readable while capturing or sealed. Mirrors
    /// `capturedEventCount`.
    pub fn captured_event_count(&self) -> Result<u64, Errno> {
        self.require_capture_readable()?;
        Ok(self.events.len() as u64)
    }

    /// Distinct activation ids among the captured events. Readable while
    /// capturing or sealed. Mirrors `capturedActivationIds`.
    pub fn captured_activation_ids(&self) -> Result<BTreeSet<u32>, Errno> {
        self.require_capture_readable()?;
        Ok(self.events.iter().map(|event| event.activation_id).collect())
    }

    /// The captured events, in capture (leaf-to-root) order. Readable while
    /// capturing or sealed (the same phases `capturedSegmentPayloads` /
    /// `capturedManifestPayload` are readable in TS). This is the source the
    /// co-resident fork module serializes with `encode_replay_events` so a
    /// forked child can seed its own journal from the copied guest memory.
    pub fn captured_events(&self) -> Result<&[ReplayEvent], Errno> {
        self.require_capture_readable()?;
        Ok(&self.events)
    }

    /// Begin replaying the parent's own captured events. `SealedParent ->
    /// Replay`. Mirrors `beginParentReplay`.
    pub fn begin_parent_replay(&mut self) -> Result<(), Errno> {
        self.require_phase(JournalPhase::SealedParent)?;
        self.begin_replay();
        Ok(())
    }

    /// Attach a child's decoded (capture-order) events and begin replay.
    /// `Idle -> Replay`. Mirrors `attachChild`, whose wire inspection is exactly
    /// what `decode_replay_events` performs; the caller passes the decoded
    /// `ReplayEvents::events` here.
    pub fn attach_child(&mut self, events: &[ReplayEvent]) -> Result<(), Errno> {
        self.require_phase(JournalPhase::Idle)?;
        self.events.clear();
        self.events.extend_from_slice(events);
        self.begin_replay();
        Ok(())
    }

    /// Non-consuming peek at the current replay event, selecting (caching) it.
    /// Replay only. Returns `None` when the stream is exhausted. Mirrors `peek`.
    pub fn peek(&mut self) -> Result<Option<ReplayEvent>, Errno> {
        self.require_phase(JournalPhase::Replay)?;
        if let Some(event) = self.selected {
            return Ok(Some(event));
        }
        if self.remaining == 0 {
            return Ok(None);
        }
        // Replay walks the captured sequence backwards: the last-committed
        // (outermost) frame first. With `remaining` events left, the current one
        // is at index `remaining - 1`.
        let event = self.events[self.remaining - 1];
        self.selected = Some(event);
        Ok(Some(event))
    }

    /// Select the current event (via `peek`) and enforce that its activation
    /// matches the frame's activation, before its ordinal is compared. Mirrors
    /// the coordinator's `requireSelectedEvent`. Replay only.
    pub fn require_selected_event(&mut self, activation_id: u32) -> Result<ReplayEvent, Errno> {
        let event = self.peek()?.ok_or(Errno::EINVAL)?; // stream exhausted
        if event.activation_id != activation_id {
            return Err(Errno::EINVAL); // frame belongs to a different activation
        }
        Ok(event)
    }

    /// Consume the selected replay event, advancing the cursor. Replay only.
    /// Requires a prior `peek`/`require_selected_event` selection whose
    /// `(activation_id, function_ordinal)` equals the caller's. Mirrors
    /// `ForkReplayEventJournal.consume`.
    pub fn consume(&mut self, activation_id: u32, function_ordinal: u32) -> Result<(), Errno> {
        self.require_phase(JournalPhase::Replay)?;
        let event = self.selected.ok_or(Errno::EINVAL)?; // consumed without selecting
        if event.activation_id != activation_id || event.function_ordinal != function_ordinal {
            return Err(Errno::EINVAL); // does not match the selected event
        }
        // `remaining >= 1` whenever a selection exists, so this cannot underflow.
        self.remaining -= 1;
        self.selected = None;
        Ok(())
    }

    /// Finish replay, requiring the stream fully consumed with nothing selected.
    /// `Replay -> Idle`. Mirrors `finishReplay`.
    pub fn finish_replay(&mut self) -> Result<(), Errno> {
        self.require_phase(JournalPhase::Replay)?;
        if self.remaining != 0 || self.selected.is_some() {
            return Err(Errno::EINVAL); // unconsumed entries remain
        }
        self.clear();
        Ok(())
    }

    /// Abandon any phase and return to idle. Mirrors `abort`.
    pub fn abort(&mut self) {
        self.clear();
    }

    fn begin_replay(&mut self) {
        self.remaining = self.events.len();
        self.selected = None;
        self.phase = JournalPhase::Replay;
    }

    fn require_phase(&self, expected: JournalPhase) -> Result<(), Errno> {
        if self.phase != expected {
            return Err(Errno::EINVAL);
        }
        Ok(())
    }

    fn require_capture_readable(&self) -> Result<(), Errno> {
        match self.phase {
            JournalPhase::Capture | JournalPhase::SealedParent => Ok(()),
            _ => Err(Errno::EINVAL),
        }
    }

    fn clear(&mut self) {
        self.events.clear();
        self.remaining = 0;
        self.selected = None;
        self.phase = JournalPhase::Idle;
    }
}

/// Resume-slot index table. Ports the slot-selection logic of `ForkResumeTable`
/// (register/unregister allocation + `slotFor`), modelling the funcref table as
/// an owned index map; the live `WebAssembly.Table` value is deferred (D5+).
#[derive(Debug)]
pub struct ResumeSlotTable {
    slots: BTreeMap<(u32, u32), u32>,
    activation_keys: BTreeMap<u32, Vec<(u32, u32)>>,
    free_slots: BTreeSet<u32>,
    next_slot: u32,
}

impl Default for ResumeSlotTable {
    fn default() -> Self {
        Self::new()
    }
}

impl ResumeSlotTable {
    /// A fresh table whose slot 0 is the reserved no-event sentinel, matching the
    /// TS `WebAssembly.Table({ initial: 1 })`.
    pub fn new() -> Self {
        ResumeSlotTable {
            slots: BTreeMap::new(),
            activation_keys: BTreeMap::new(),
            free_slots: BTreeSet::new(),
            next_slot: 1,
        }
    }

    /// Register an activation's resume targets, assigning each a slot. The batch
    /// is sorted by function ordinal and each target takes the smallest free slot
    /// (reused freed slots first, else a freshly grown one). Mirrors
    /// `registerActivation`; rejects a re-registered activation or a repeated
    /// ordinal with `Err(Errno::EINVAL)` instead of throwing.
    pub fn register_activation(&mut self, activation_id: u32, ordinals: &[u32]) -> Result<(), Errno> {
        if self.activation_keys.contains_key(&activation_id) {
            return Err(Errno::EINVAL); // already registered
        }
        let mut sorted: Vec<u32> = ordinals.to_vec();
        sorted.sort_unstable();
        // Reject a repeated ordinal (adjacent equal after sort), matching the TS
        // `previous === target.functionOrdinal` guard.
        for window in sorted.windows(2) {
            if window[0] == window[1] {
                return Err(Errno::EINVAL);
            }
        }
        let mut keys: Vec<(u32, u32)> = Vec::with_capacity(sorted.len());
        for ordinal in sorted {
            let slot = self.allocate_slot();
            self.slots.insert((activation_id, ordinal), slot);
            keys.push((activation_id, ordinal));
        }
        self.activation_keys.insert(activation_id, keys);
        Ok(())
    }

    /// Unregister an activation, freeing its slots for reuse. Mirrors
    /// `unregisterActivation`; rejects an unknown activation with
    /// `Err(Errno::EINVAL)`.
    pub fn unregister_activation(&mut self, activation_id: u32) -> Result<(), Errno> {
        let keys = self.activation_keys.remove(&activation_id).ok_or(Errno::EINVAL)?;
        for key in keys {
            if let Some(slot) = self.slots.remove(&key) {
                self.free_slots.insert(slot);
            }
        }
        Ok(())
    }

    /// Resume-slot for a peeked replay event. `None` (no event) yields the
    /// reserved sentinel slot 0; a registered coordinate yields its slot; an
    /// unknown coordinate is `Err(Errno::EINVAL)`. Mirrors `slotFor` (whose live
    /// recursive-type validation belongs to the Wasm engine, deferred here).
    pub fn slot_for(&self, event: Option<ReplayEvent>) -> Result<u32, Errno> {
        let Some(event) = event else {
            return Ok(0);
        };
        self.slots
            .get(&(event.activation_id, event.function_ordinal))
            .copied()
            .ok_or(Errno::EINVAL)
    }

    /// Smallest free slot, or a freshly grown one. Mirrors `allocateSlot` over a
    /// `WebAssembly.Table` that starts at length 1 (slot 0 reserved).
    fn allocate_slot(&mut self) -> u32 {
        if let Some(&slot) = self.free_slots.iter().next() {
            self.free_slots.remove(&slot);
            return slot;
        }
        let slot = self.next_slot;
        self.next_slot += 1;
        slot
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::replay_events::decode_replay_events;

    // --- Genuine cross-language fixture (real TS journal + resume table) ---

    /// Self-describing fixture emitted by `gen-replay-journal-fixture.mts` from
    /// the REAL `ForkReplayEventJournal` + `ForkResumeTable`. See that generator
    /// for the layout. If the Rust port disagrees with the TS classes on replay
    /// order or slot assignment, the cross-check tests below fail.
    const FIXTURE: &[u8] = include_bytes!("../testdata/replay-journal-wasm32.bin");

    struct GoldenEntry {
        activation_id: u32,
        function_ordinal: u32,
        slot: u32,
    }

    enum Op {
        Register { activation_id: u32, ordinals: Vec<u32> },
        Unregister { activation_id: u32 },
    }

    struct Fixture {
        manifest: Vec<u8>,
        segments: Vec<Vec<u8>>,
        ops: Vec<Op>,
        golden: Vec<GoldenEntry>,
    }

    fn take_u32(bytes: &[u8], cursor: &mut usize) -> u32 {
        let slice = &bytes[*cursor..*cursor + 4];
        *cursor += 4;
        u32::from_le_bytes([slice[0], slice[1], slice[2], slice[3]])
    }

    fn parse_fixture() -> Fixture {
        let mut cursor = 0usize;
        let manifest_len = take_u32(FIXTURE, &mut cursor) as usize;
        let manifest = FIXTURE[cursor..cursor + manifest_len].to_vec();
        cursor += manifest_len;
        let segment_count = take_u32(FIXTURE, &mut cursor) as usize;
        let mut segments = Vec::new();
        for _ in 0..segment_count {
            let seg_len = take_u32(FIXTURE, &mut cursor) as usize;
            segments.push(FIXTURE[cursor..cursor + seg_len].to_vec());
            cursor += seg_len;
        }
        let op_count = take_u32(FIXTURE, &mut cursor) as usize;
        let mut ops = Vec::new();
        for _ in 0..op_count {
            let kind = take_u32(FIXTURE, &mut cursor);
            let activation_id = take_u32(FIXTURE, &mut cursor);
            if kind == 0 {
                let ordinal_count = take_u32(FIXTURE, &mut cursor) as usize;
                let mut ordinals = Vec::new();
                for _ in 0..ordinal_count {
                    ordinals.push(take_u32(FIXTURE, &mut cursor));
                }
                ops.push(Op::Register { activation_id, ordinals });
            } else {
                ops.push(Op::Unregister { activation_id });
            }
        }
        let golden_count = take_u32(FIXTURE, &mut cursor) as usize;
        let mut golden = Vec::new();
        for _ in 0..golden_count {
            let activation_id = take_u32(FIXTURE, &mut cursor);
            let function_ordinal = take_u32(FIXTURE, &mut cursor);
            let slot = take_u32(FIXTURE, &mut cursor);
            golden.push(GoldenEntry { activation_id, function_ordinal, slot });
        }
        assert_eq!(cursor, FIXTURE.len(), "fixture had trailing bytes");
        Fixture { manifest, segments, ops, golden }
    }

    fn build_table(ops: &[Op]) -> ResumeSlotTable {
        let mut table = ResumeSlotTable::new();
        for op in ops {
            match op {
                Op::Register { activation_id, ordinals } => {
                    table.register_activation(*activation_id, ordinals).unwrap();
                }
                Op::Unregister { activation_id } => {
                    table.unregister_activation(*activation_id).unwrap();
                }
            }
        }
        table
    }

    /// Drive a journal (already in the Replay phase) + the resume table exactly
    /// as the coordinator hot loop does and assert the produced
    /// (activation, ordinal, slot) sequence equals the TS golden.
    fn drive_replay_and_check(journal: &mut ReplayEventJournal, table: &ResumeSlotTable, golden: &[GoldenEntry]) {
        for entry in golden {
            let event = journal.peek().unwrap().expect("journal exhausted early");
            assert_eq!(event.activation_id, entry.activation_id);
            assert_eq!(event.function_ordinal, entry.function_ordinal);
            // require_selected_event mirrors the coordinator's activation guard.
            let required = journal.require_selected_event(entry.activation_id).unwrap();
            assert_eq!(required, event);
            let slot = table.slot_for(Some(event)).unwrap();
            assert_eq!(slot, entry.slot, "slot mismatch for {}:{}", entry.activation_id, entry.function_ordinal);
            journal.consume(event.activation_id, event.function_ordinal).unwrap();
        }
        assert_eq!(journal.peek().unwrap(), None, "journal not exhausted");
        journal.finish_replay().unwrap();
    }

    #[test]
    fn child_path_matches_ts_journal_and_slots() {
        let fixture = parse_fixture();
        // Decode the genuine TS-encoded wire into capture-order events.
        let seg_refs: Vec<&[u8]> = fixture.segments.iter().map(|s| s.as_slice()).collect();
        let decoded = decode_replay_events(&fixture.manifest, &seg_refs).unwrap();

        let table = build_table(&fixture.ops);
        let mut journal = ReplayEventJournal::new();
        journal.attach_child(&decoded.events).unwrap();
        assert_eq!(journal.phase(), JournalPhase::Replay);
        drive_replay_and_check(&mut journal, &table, &fixture.golden);
        assert_eq!(journal.phase(), JournalPhase::Idle);
    }

    #[test]
    fn parent_path_matches_ts_journal_and_slots() {
        let fixture = parse_fixture();
        let seg_refs: Vec<&[u8]> = fixture.segments.iter().map(|s| s.as_slice()).collect();
        let decoded = decode_replay_events(&fixture.manifest, &seg_refs).unwrap();

        let table = build_table(&fixture.ops);
        let mut journal = ReplayEventJournal::new();
        journal.begin_capture().unwrap();
        // Record the exact capture-order events (as the wire preserves them).
        for event in &decoded.events {
            journal.record_commit(event.activation_id, event.function_ordinal).unwrap();
        }
        assert_eq!(journal.captured_event_count().unwrap(), decoded.events.len() as u64);
        assert_eq!(journal.captured_activation_ids().unwrap(), decoded.activation_ids);
        journal.seal_capture().unwrap();
        journal.begin_parent_replay().unwrap();
        drive_replay_and_check(&mut journal, &table, &fixture.golden);
    }

    /// Non-vacuity: a swapped-order oracle must fail. Proves the cross-check is
    /// asserting the meaningful (reverse-of-capture) order, not any order.
    #[test]
    fn swapped_golden_order_would_fail() {
        let fixture = parse_fixture();
        assert!(fixture.golden.len() >= 2);
        let seg_refs: Vec<&[u8]> = fixture.segments.iter().map(|s| s.as_slice()).collect();
        let decoded = decode_replay_events(&fixture.manifest, &seg_refs).unwrap();
        let mut journal = ReplayEventJournal::new();
        journal.attach_child(&decoded.events).unwrap();
        let first = journal.peek().unwrap().unwrap();
        // The genuine first replay event must differ from the LAST captured
        // event (capture order != replay order), and equal the golden's first.
        assert_ne!(
            (first.activation_id, first.function_ordinal),
            (decoded.events[0].activation_id, decoded.events[0].function_ordinal),
        );
        assert_eq!(first.activation_id, fixture.golden[0].activation_id);
        assert_eq!(first.function_ordinal, fixture.golden[0].function_ordinal);
    }

    // --- Slot-table unit behavior -----------------------------------------

    #[test]
    fn slot_for_none_is_reserved_sentinel() {
        let table = ResumeSlotTable::new();
        assert_eq!(table.slot_for(None).unwrap(), 0);
    }

    #[test]
    fn register_assigns_sorted_ascending_slots() {
        let mut table = ResumeSlotTable::new();
        // Unsorted input; slots follow ordinal-sorted order from slot 1.
        table.register_activation(5, &[8, 2, 4]).unwrap();
        assert_eq!(table.slot_for(Some(ev(5, 2))).unwrap(), 1);
        assert_eq!(table.slot_for(Some(ev(5, 4))).unwrap(), 2);
        assert_eq!(table.slot_for(Some(ev(5, 8))).unwrap(), 3);
    }

    #[test]
    fn unregister_frees_slots_for_reuse_smallest_first() {
        let mut table = ResumeSlotTable::new();
        table.register_activation(1, &[10]).unwrap(); // slot 1
        table.register_activation(2, &[20, 21]).unwrap(); // slots 2, 3
        table.unregister_activation(2).unwrap(); // free {2, 3}
        // New registration reuses the smallest free slots first, in sorted order.
        table.register_activation(3, &[30, 31]).unwrap(); // reuse 2, 3
        assert_eq!(table.slot_for(Some(ev(3, 30))).unwrap(), 2);
        assert_eq!(table.slot_for(Some(ev(3, 31))).unwrap(), 3);
        // The survivor keeps its slot.
        assert_eq!(table.slot_for(Some(ev(1, 10))).unwrap(), 1);
    }

    #[test]
    fn register_empty_activation_is_allowed() {
        let mut table = ResumeSlotTable::new();
        table.register_activation(9, &[]).unwrap();
        // No slots consumed: the next real registration still starts at slot 1.
        table.register_activation(1, &[7]).unwrap();
        assert_eq!(table.slot_for(Some(ev(1, 7))).unwrap(), 1);
    }

    // --- Adversarial: panic-free Err, never a panic -----------------------

    #[test]
    fn slot_for_unknown_event_errs() {
        let mut table = ResumeSlotTable::new();
        table.register_activation(1, &[10]).unwrap();
        assert_eq!(table.slot_for(Some(ev(1, 99))), Err(Errno::EINVAL));
        assert_eq!(table.slot_for(Some(ev(2, 10))), Err(Errno::EINVAL));
    }

    #[test]
    fn register_duplicate_activation_errs() {
        let mut table = ResumeSlotTable::new();
        table.register_activation(1, &[10]).unwrap();
        assert_eq!(table.register_activation(1, &[11]), Err(Errno::EINVAL));
    }

    #[test]
    fn register_repeated_ordinal_errs() {
        let mut table = ResumeSlotTable::new();
        assert_eq!(table.register_activation(1, &[4, 8, 4]), Err(Errno::EINVAL));
    }

    #[test]
    fn unregister_unknown_activation_errs() {
        let mut table = ResumeSlotTable::new();
        assert_eq!(table.unregister_activation(7), Err(Errno::EINVAL));
    }

    #[test]
    fn consume_ordinal_mismatch_errs_without_advancing() {
        let mut journal = ReplayEventJournal::new();
        journal.attach_child(&[ev(1, 10), ev(2, 20)]).unwrap();
        let event = journal.peek().unwrap().unwrap(); // replay order: (2,20) first
        assert_eq!(event, ev(2, 20));
        // Wrong ordinal for the selected event: rejected, cursor unmoved.
        assert_eq!(journal.consume(2, 99), Err(Errno::EINVAL));
        assert_eq!(journal.peek().unwrap().unwrap(), ev(2, 20));
    }

    #[test]
    fn consume_activation_mismatch_errs() {
        let mut journal = ReplayEventJournal::new();
        journal.attach_child(&[ev(1, 10), ev(2, 20)]).unwrap();
        journal.peek().unwrap();
        assert_eq!(journal.consume(9, 20), Err(Errno::EINVAL));
    }

    #[test]
    fn consume_without_selecting_errs() {
        let mut journal = ReplayEventJournal::new();
        journal.attach_child(&[ev(1, 10)]).unwrap();
        // No peek/require_selected_event first: consume must reject.
        assert_eq!(journal.consume(1, 10), Err(Errno::EINVAL));
    }

    #[test]
    fn require_selected_event_wrong_activation_errs() {
        let mut journal = ReplayEventJournal::new();
        journal.attach_child(&[ev(1, 10), ev(2, 20)]).unwrap();
        // Current event is (2,20); a frame claiming activation 5 is rejected.
        assert_eq!(journal.require_selected_event(5), Err(Errno::EINVAL));
    }

    #[test]
    fn peek_empty_journal_is_none() {
        let mut journal = ReplayEventJournal::new();
        journal.attach_child(&[]).unwrap();
        assert_eq!(journal.peek().unwrap(), None);
        journal.finish_replay().unwrap();
    }

    #[test]
    fn peek_past_end_after_consuming_all_is_none() {
        let mut journal = ReplayEventJournal::new();
        journal.attach_child(&[ev(1, 10)]).unwrap();
        journal.peek().unwrap();
        journal.consume(1, 10).unwrap();
        assert_eq!(journal.peek().unwrap(), None);
        // Consuming again (nothing selected, exhausted) is rejected.
        assert_eq!(journal.consume(1, 10), Err(Errno::EINVAL));
    }

    // --- Adversarial: phase violations ------------------------------------

    #[test]
    fn captured_events_readable_in_capture_and_sealed_only() {
        let mut journal = ReplayEventJournal::new();
        assert_eq!(journal.captured_events(), Err(Errno::EINVAL)); // idle
        journal.begin_capture().unwrap();
        journal.record_commit(3, 8).unwrap();
        journal.record_commit(3, 4).unwrap();
        assert_eq!(journal.captured_events().unwrap(), &[ev(3, 8), ev(3, 4)]); // capture
        journal.seal_capture().unwrap();
        assert_eq!(journal.captured_events().unwrap(), &[ev(3, 8), ev(3, 4)]); // sealed
        journal.begin_parent_replay().unwrap();
        assert_eq!(journal.captured_events(), Err(Errno::EINVAL)); // replay
    }

    /// The parent-serialize / child-seed round trip end to end: capture events,
    /// serialize them as a KFRE image (as the fork module does post-seal),
    /// decode that image (as the forked child does over copied memory), and
    /// attach it — the child journal must replay the exact same events.
    #[test]
    fn serialize_image_seeds_child_journal_identically() {
        use crate::replay_events::{decode_replay_events_image, encode_replay_events};
        let mut parent = ReplayEventJournal::new();
        parent.begin_capture().unwrap();
        let events = [ev(7, 101), ev(7, 202), ev(7, 303), ev(7, 404)];
        for e in &events {
            parent.record_commit(e.activation_id, e.function_ordinal).unwrap();
        }
        parent.seal_capture().unwrap();
        // Parent serializes its sealed journal into a KFRE image.
        let image = encode_replay_events(parent.captured_events().unwrap());
        // Child decodes the copied image and seeds its own journal.
        let decoded = decode_replay_events_image(&image).unwrap();
        let mut child = ReplayEventJournal::new();
        child.attach_child(&decoded.events).unwrap();
        // Both replay the exact reverse-of-capture order in lockstep.
        parent.begin_parent_replay().unwrap();
        for e in events.iter().rev() {
            let p = parent.peek().unwrap().unwrap();
            let c = child.peek().unwrap().unwrap();
            assert_eq!(p, c);
            assert_eq!(p, *e);
            parent.consume(e.activation_id, e.function_ordinal).unwrap();
            child.consume(e.activation_id, e.function_ordinal).unwrap();
        }
        assert_eq!(parent.peek().unwrap(), None);
        assert_eq!(child.peek().unwrap(), None);
        parent.finish_replay().unwrap();
        child.finish_replay().unwrap();
    }

    #[test]
    fn record_after_seal_errs() {
        let mut journal = ReplayEventJournal::new();
        journal.begin_capture().unwrap();
        journal.record_commit(1, 2).unwrap();
        journal.seal_capture().unwrap();
        assert_eq!(journal.record_commit(3, 4), Err(Errno::EINVAL));
    }

    #[test]
    fn record_without_capture_errs() {
        let mut journal = ReplayEventJournal::new();
        assert_eq!(journal.record_commit(1, 2), Err(Errno::EINVAL));
    }

    #[test]
    fn begin_capture_twice_errs() {
        let mut journal = ReplayEventJournal::new();
        journal.begin_capture().unwrap();
        assert_eq!(journal.begin_capture(), Err(Errno::EINVAL));
    }

    #[test]
    fn peek_outside_replay_errs() {
        let mut journal = ReplayEventJournal::new();
        assert_eq!(journal.peek(), Err(Errno::EINVAL)); // idle
        journal.begin_capture().unwrap();
        assert_eq!(journal.peek(), Err(Errno::EINVAL)); // capture
    }

    #[test]
    fn attach_child_outside_idle_errs() {
        let mut journal = ReplayEventJournal::new();
        journal.begin_capture().unwrap();
        assert_eq!(journal.attach_child(&[ev(1, 2)]), Err(Errno::EINVAL));
    }

    #[test]
    fn begin_parent_replay_requires_sealed() {
        let mut journal = ReplayEventJournal::new();
        assert_eq!(journal.begin_parent_replay(), Err(Errno::EINVAL)); // idle
        journal.begin_capture().unwrap();
        assert_eq!(journal.begin_parent_replay(), Err(Errno::EINVAL)); // capture
    }

    #[test]
    fn finish_replay_with_unconsumed_errs() {
        let mut journal = ReplayEventJournal::new();
        journal.attach_child(&[ev(1, 10), ev(2, 20)]).unwrap();
        assert_eq!(journal.finish_replay(), Err(Errno::EINVAL));
    }

    #[test]
    fn abort_returns_to_idle_and_allows_recapture() {
        let mut journal = ReplayEventJournal::new();
        journal.attach_child(&[ev(1, 10)]).unwrap();
        journal.peek().unwrap();
        journal.abort();
        assert_eq!(journal.phase(), JournalPhase::Idle);
        // A fresh capture cycle works after abort.
        journal.begin_capture().unwrap();
        journal.record_commit(4, 5).unwrap();
        journal.seal_capture().unwrap();
        journal.begin_parent_replay().unwrap();
        assert_eq!(journal.peek().unwrap().unwrap(), ev(4, 5));
    }

    fn ev(activation_id: u32, function_ordinal: u32) -> ReplayEvent {
        ReplayEvent { activation_id, function_ordinal }
    }
}
