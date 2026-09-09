//! Opaque, self-describing syscall record format (record ABI v1).
//!
//! Phase 2 of the Rust-first runtime takes the host out of the syscall data
//! path. Instead of the host reading per-syscall descriptor tables to copy
//! pointer arguments out of guest memory, the guest glue self-marshals its
//! arguments into a single, bounded, self-describing record placed at
//! [`crate::channel::DATA_OFFSET`]. The host transports that byte region
//! blindly; a single bounds-checked decoder in `runtime-core` (Task 2) reads
//! the region once, copies it in, then validates the copy (TOCTOU-safe).
//!
//! This module is the wire-format definition only: the structs, the version
//! and magic sentinels, the span-kind taxonomy, and the nested sub-layout
//! byte maps. It is purely additive and is NOT on the live transport path yet;
//! the decoder (Task 2), the kernel wiring (Task 4), the guest encoder
//! (Task 5), and the atomic ABI-44 flip (Task 6) come later. Nothing here
//! reads or writes a channel.
//!
//! # Record layout (all offsets relative to [`crate::channel::DATA_OFFSET`])
//!
//! ```text
//! +-----------------------------+  offset 0
//! | RecordHeader (64 bytes)     |
//! +-----------------------------+  offset RECORD_HEADER_BYTES
//! | SpanDescriptor[span_count]  |  (span_count <= MAX_SPANS)
//! +-----------------------------+  offset RECORD_HEADER_BYTES + span_count*12
//! | payload bytes               |  each SpanDescriptor.offset points here
//! +-----------------------------+
//! ```
//!
//! The header carries the six scalar words unchanged (`scalar_args`); span
//! descriptors REPLACE only the host's former pointer-copy step. Every span
//! `offset` is relative to `DATA_OFFSET`, and the whole record tail must stay
//! below the reserved signal area (the inline budget is
//! `DATA_SIZE - SIG_AREA_SIZE = 65480` bytes). Payloads too large for the
//! inline budget reuse the SAME record encoded into a transfer-scratch-backed
//! channel (`kernel_transfer_scratch_begin` / `kernel_transfer_channel_execute`);
//! the span offsets are simply larger `u32`s and the decoder is identical.
//! There is therefore no `Scratch` span kind.
//!
//! # Completeness contract — pointer-bearing syscall shapes → six span kinds
//!
//! Self-marshalling moves per-syscall *semantic* knowledge to the guest, which
//! already owns it (the ioctl request, the sem/shm/msg `cmd`, the fcntl lock
//! `cmd`, select's `nfds`, the epoll count, etc.). So the host's former
//! "special layout" families collapse into generic bounded spans; the decoder
//! only bounds-checks, it never interprets syscall semantics. Every
//! pointer-bearing syscall from the grounding note maps to exactly one of the
//! six kinds below:
//!
//! | Syscall shape | Span kind(s) |
//! |---|---|
//! | ioctl / semctl / shmctl / msgctl / prctl / fcntl-lock / sigaction / termios / rlimit / stat / most struct-by-pointer (guest supplies the exact `len`) | `IN_PTR` / `OUT_PTR` / `IN_OUT_PTR` |
//! | select / pselect6 fd_sets (guest sizes from `nfds`); optional timeout / sigmask | `IN_OUT_PTR`; optional `IN_PTR` (or omitted span) |
//! | epoll_ctl (one event) | `IN_PTR` |
//! | epoll_pwait (event array + optional sigmask) | `OUT_PTR` (array) + optional `IN_PTR` (mask) |
//! | path arguments (NUL-terminated, `len <= PATH_MAX_BYTES`) | `PATH_STR` |
//! | writev / readv / preadv / pwritev | one nested `IOVEC_ARRAY` |
//! | sendmsg / recvmsg | one nested `MSGHDR` |
//!
//! Because the guest owns each command-dependent buffer's size and direction,
//! command-dependent buffers are plain `IN_PTR` / `OUT_PTR` / `IN_OUT_PTR`
//! spans of the exact guest-computed length. There is no dedicated
//! FdSet / EpollEvents / IpcControl kind.

use core::mem::size_of;

/// Version of this record format. Bumped when the record byte layout changes
/// in a way the decoder must distinguish. Starts at 1.
pub const RECORD_ABI: u16 = 1;

/// Fixed non-zero sentinel stamped in [`RecordHeader::magic`].
///
/// Value is ASCII `"KCR1"` (Kandelo Channel Record, format 1) read as a
/// little-endian `u32`: byte 0 = `b'K'` (0x4B), byte 1 = `b'C'` (0x43),
/// byte 2 = `b'R'` (0x52), byte 3 = `b'1'` (0x31). A wrong or zero magic is a
/// decode error; it guards against an uninitialized or stale channel region
/// being interpreted as a record.
pub const RECORD_MAGIC: u32 = 0x3152_434B;

/// Fixed-size record header at the start of the record region.
///
/// `_reserved` is explicit padding so `scalar_args` starts at an 8-byte
/// boundary (offset 16) and the whole struct is exactly 64 bytes with 8-byte
/// alignment. Field offsets: `magic` 0, `record_abi` 4, `syscall` 6,
/// `span_count` 8, `flags` 10, `_reserved` 12, `scalar_args` 16..64.
#[repr(C)]
pub struct RecordHeader {
    /// Must equal [`RECORD_MAGIC`].
    pub magic: u32,
    /// Must equal [`RECORD_ABI`] for the decoder to proceed.
    pub record_abi: u16,
    /// Linux-compatible syscall number, mirrored from the channel header.
    pub syscall: u16,
    /// Number of [`SpanDescriptor`]s that follow the header (`<= MAX_SPANS`).
    pub span_count: u16,
    /// Reserved record-level flags; must be zero in record ABI v1.
    pub flags: u16,
    /// Explicit pad so `scalar_args` is 8-byte aligned; must be zero.
    pub _reserved: u32,
    /// The six syscall scalar words, carried unchanged from the channel.
    pub scalar_args: [i64; 6],
}

/// One pointer-argument span. `offset` is relative to
/// [`crate::channel::DATA_OFFSET`] (or the equivalent base of a
/// transfer-scratch-backed channel); `len` is the payload byte length. For
/// nested kinds (`IOVEC_ARRAY`, `MSGHDR`) `offset`/`len` bound the nested
/// region, whose internal layout is described by the `*_OFFSET` consts below.
#[repr(C)]
pub struct SpanDescriptor {
    /// One of the `SPAN_KIND_*` values; see [`span_kind_is_valid`].
    pub kind: u8,
    /// Which of the six scalar args this span replaces (the guest's original
    /// pointer argument index, 0..=5).
    pub arg_index: u8,
    /// Explicit pad to align `offset`; must be zero.
    pub _pad: u16,
    /// Byte offset of the payload, relative to `DATA_OFFSET`.
    pub offset: u32,
    /// Payload byte length.
    pub len: u32,
}

/// Flat span: guest-owned input bytes the kernel reads (never writes).
pub const SPAN_KIND_IN_PTR: u8 = 1;
/// Flat span: output bytes the kernel writes back into the channel.
pub const SPAN_KIND_OUT_PTR: u8 = 2;
/// Flat span: bytes read as input and written back as output.
pub const SPAN_KIND_IN_OUT_PTR: u8 = 3;
/// Flat span: NUL-terminated path string, `len <= PATH_MAX_BYTES`.
pub const SPAN_KIND_PATH_STR: u8 = 4;
/// Nested span: an iovec array region (see the `IOVEC_ARRAY_*` consts).
pub const SPAN_KIND_IOVEC_ARRAY: u8 = 5;
/// Nested span: a msghdr region (see the `MSGHDR_*` consts).
pub const SPAN_KIND_MSGHDR: u8 = 6;

/// True for a recognized span kind (`SPAN_KIND_IN_PTR..=SPAN_KIND_MSGHDR`).
pub const fn span_kind_is_valid(kind: u8) -> bool {
    matches!(
        kind,
        SPAN_KIND_IN_PTR
            | SPAN_KIND_OUT_PTR
            | SPAN_KIND_IN_OUT_PTR
            | SPAN_KIND_PATH_STR
            | SPAN_KIND_IOVEC_ARRAY
            | SPAN_KIND_MSGHDR
    )
}

/// True for a nested kind (`IOVEC_ARRAY` / `MSGHDR`) whose payload has an
/// internal sub-layout the decoder must parse; false for the flat byte-span
/// kinds. Only meaningful for a kind that [`span_kind_is_valid`].
pub const fn span_kind_is_nested(kind: u8) -> bool {
    matches!(kind, SPAN_KIND_IOVEC_ARRAY | SPAN_KIND_MSGHDR)
}

/// Byte size of [`RecordHeader`] (64).
pub const RECORD_HEADER_BYTES: usize = size_of::<RecordHeader>();
/// Byte size of [`SpanDescriptor`] (12).
pub const SPAN_DESCRIPTOR_BYTES: usize = size_of::<SpanDescriptor>();

/// Maximum span descriptors in one record.
///
/// Eight is ample because span_count stays small by construction: the widest
/// flat syscall shapes need at most a few spans (e.g. epoll_pwait = array +
/// mask; select = up to three fd_sets + timeout), and the two nested shapes
/// (iovec arrays, msghdr) fold an unbounded number of buffers into a SINGLE
/// span whose count is bounded internally by [`MAX_IOVEC`]. Keeping the cap
/// small also keeps the descriptor block trivially within the inline budget.
pub const MAX_SPANS: usize = 8;

/// Maximum iovec entries in a nested iovec region; equals the platform
/// `IOV_MAX`.
pub const MAX_IOVEC: usize = crate::platform_limits::IOV_MAX;

// ---------------------------------------------------------------------------
// Nested sub-layouts (byte maps only; the decoder is Task 2).
// ---------------------------------------------------------------------------

// Iovec array region, addressed by a `SPAN_KIND_IOVEC_ARRAY` span:
//
//   { u32 count (<= MAX_IOVEC);
//     count * { u32 buf_off; u32 buf_len };   // entry table
//     buffers }                               // referenced payload bytes
//
// `buf_off` in each entry is relative to `DATA_OFFSET`, exactly like a flat
// span offset, so the decoder validates iovec buffers with the same bounds
// contract it uses for flat spans.

/// Offset of the `u32` entry count within an iovec-array region.
pub const IOVEC_ARRAY_COUNT_OFFSET: usize = 0;
/// Offset of the first `{ buf_off, buf_len }` entry within an iovec-array
/// region (immediately after the `u32` count).
pub const IOVEC_ARRAY_ENTRIES_OFFSET: usize = IOVEC_ARRAY_COUNT_OFFSET + size_of::<u32>();
/// Byte size of one iovec entry (`u32 buf_off` + `u32 buf_len`).
pub const IOVEC_ARRAY_ENTRY_BYTES: usize = 2 * size_of::<u32>();

// Msghdr region, addressed by a `SPAN_KIND_MSGHDR` span:
//
//   { u32 name_off; u32 name_len;      // socket address (0/0 if absent)
//     <iovec-block>;                   // an iovec-array region (as above)
//     u32 control_off; u32 control_len;// ancillary data (0/0 if absent)
//     u32 flags }                      // msg_flags
//
// The iovec-block occupies a variable number of bytes, so `control_off`,
// `control_len`, and `flags` follow it at runtime-computed offsets; only the
// fixed prefix (`name_off`, `name_len`) and the block start are constant.

/// Offset of the `u32 name_off` field within a msghdr region.
pub const MSGHDR_NAME_OFF_OFFSET: usize = 0;
/// Offset of the `u32 name_len` field within a msghdr region.
pub const MSGHDR_NAME_LEN_OFFSET: usize = MSGHDR_NAME_OFF_OFFSET + size_of::<u32>();
/// Offset of the embedded iovec-block within a msghdr region (immediately
/// after the name prefix). The block length is variable, so the trailing
/// `control_off`, `control_len`, and `flags` fields are located relative to
/// the end of the block by the decoder, not by a fixed const.
pub const MSGHDR_IOVEC_BLOCK_OFFSET: usize = MSGHDR_NAME_LEN_OFFSET + size_of::<u32>();

#[cfg(test)]
mod tests {
    use super::*;
    use core::mem::{align_of, size_of};

    #[test]
    fn record_header_is_sixty_four_bytes() {
        assert_eq!(RECORD_HEADER_BYTES, 64);
        assert_eq!(size_of::<RecordHeader>(), 64);
        assert_eq!(align_of::<RecordHeader>(), 8);
    }

    #[test]
    fn span_descriptor_is_twelve_bytes() {
        assert_eq!(SPAN_DESCRIPTOR_BYTES, 12);
        assert_eq!(size_of::<SpanDescriptor>(), 12);
    }

    #[test]
    fn record_and_spans_fit_inline_budget() {
        let inline_budget = crate::channel::DATA_SIZE - crate::channel::SIG_AREA_SIZE;
        assert_eq!(inline_budget, 65480);
        assert!(RECORD_HEADER_BYTES + MAX_SPANS * SPAN_DESCRIPTOR_BYTES < inline_budget);
    }

    #[test]
    fn record_abi_is_one() {
        assert_eq!(RECORD_ABI, 1);
    }

    #[test]
    fn record_magic_is_nonzero_kcr1() {
        assert_ne!(RECORD_MAGIC, 0);
        assert_eq!(RECORD_MAGIC.to_le_bytes(), *b"KCR1");
    }

    #[test]
    fn max_iovec_matches_platform_limit() {
        assert_eq!(MAX_IOVEC, crate::platform_limits::IOV_MAX);
    }

    #[test]
    fn span_kind_validity() {
        for kind in 1u8..=6 {
            assert!(span_kind_is_valid(kind));
        }
        assert!(!span_kind_is_valid(0));
        assert!(!span_kind_is_valid(7));
    }

    #[test]
    fn nested_vs_flat_classification() {
        assert!(span_kind_is_nested(SPAN_KIND_IOVEC_ARRAY));
        assert!(span_kind_is_nested(SPAN_KIND_MSGHDR));
        assert!(!span_kind_is_nested(SPAN_KIND_IN_PTR));
        assert!(!span_kind_is_nested(SPAN_KIND_OUT_PTR));
        assert!(!span_kind_is_nested(SPAN_KIND_IN_OUT_PTR));
        assert!(!span_kind_is_nested(SPAN_KIND_PATH_STR));
    }

    #[test]
    fn nested_sublayout_offsets() {
        assert_eq!(IOVEC_ARRAY_COUNT_OFFSET, 0);
        assert_eq!(IOVEC_ARRAY_ENTRIES_OFFSET, 4);
        assert_eq!(IOVEC_ARRAY_ENTRY_BYTES, 8);
        assert_eq!(MSGHDR_NAME_OFF_OFFSET, 0);
        assert_eq!(MSGHDR_NAME_LEN_OFFSET, 4);
        assert_eq!(MSGHDR_IOVEC_BLOCK_OFFSET, 8);
    }
}
