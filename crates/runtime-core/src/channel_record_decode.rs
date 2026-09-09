//! Bounds-checked decoder for the opaque channel record (record ABI v1).
//!
//! Phase 2 of the Rust-first runtime takes the host out of the syscall data
//! path: the guest glue self-marshals its pointer arguments into a single,
//! bounded, self-describing record (see
//! [`wasm_posix_shared::channel_record`]) placed at the channel data region.
//! The host transports that byte region blindly. This module is the SOLE
//! validator of that region.
//!
//! [`decode`] is a pure, panic-free, `unsafe`-free function over an
//! already-copied-in `&[u8]`. The read-once/copy-in happens at the call site
//! (a later task); the decoder never touches the live shared buffer, so it is
//! immune to a concurrent mutator (TOCTOU-safe by construction). It validates
//! every offset, length, and count against a caller-supplied `data_capacity`
//! using checked arithmetic, rejects out-of-range and overlapping spans, caps
//! nested counts, and returns slices that borrow the input.
//!
//! # Security contract
//!
//! This is a load-bearing security boundary. Every rule below is mandatory:
//!
//! - The header is read only when the input and `data_capacity` are large
//!   enough to contain it.
//! - `magic` and `record_abi` must match the format's sentinels.
//! - `span_count` must not exceed [`MAX_SPANS`], and the descriptor array must
//!   fit within `data_capacity` (checked arithmetic).
//! - Every span's `[offset, offset + len)` range is validated with `u32`
//!   checked arithmetic (so `offset = u32::MAX, len = 1` is [`DecodeError::Arith`],
//!   not a wrap) and bounded by `data_capacity`.
//! - Top-level span byte ranges may not overlap each other, and may not
//!   collide with the reserved header+descriptor region.
//! - Nested [`SPAN_KIND_IOVEC_ARRAY`]/[`SPAN_KIND_MSGHDR`] regions are parsed
//!   with the same bounds/overlap/checked-arithmetic rules; the iovec entry
//!   count is capped at [`MAX_IOVEC`].
//! - No `data[i]` indexing that can panic: all reads go through
//!   [`slice::get`], mapping a miss to the appropriate error.

use alloc::vec::Vec;

use wasm_posix_shared::channel_record::{
    span_kind_is_valid, IOVEC_ARRAY_COUNT_OFFSET, IOVEC_ARRAY_ENTRIES_OFFSET,
    IOVEC_ARRAY_ENTRY_BYTES, MAX_IOVEC, MAX_SPANS, MSGHDR_IOVEC_BLOCK_OFFSET,
    MSGHDR_NAME_LEN_OFFSET, MSGHDR_NAME_OFF_OFFSET, RECORD_ABI, RECORD_HEADER_BYTES, RECORD_MAGIC,
    SPAN_DESCRIPTOR_BYTES, SPAN_KIND_IOVEC_ARRAY, SPAN_KIND_MSGHDR,
};

// Field byte offsets within `RecordHeader` (mirrors the documented `#[repr(C)]`
// layout in `wasm_posix_shared::channel_record`: magic 0, record_abi 4,
// syscall 6, span_count 8, flags 10, _reserved 12, scalar_args 16..64).
const H_MAGIC: usize = 0;
const H_RECORD_ABI: usize = 4;
const H_SYSCALL: usize = 6;
const H_SPAN_COUNT: usize = 8;
const H_FLAGS: usize = 10;
const H_SCALARS: usize = 16;

// Field byte offsets within a 12-byte `SpanDescriptor` (kind 0, arg_index 1,
// _pad 2, offset 4, len 8).
const D_KIND: usize = 0;
const D_ARG_INDEX: usize = 1;
const D_OFFSET: usize = 4;
const D_LEN: usize = 8;

/// A fully validated syscall record. All byte slices borrow the input `data`.
#[derive(Debug, PartialEq, Eq)]
pub struct DecodedSyscall<'a> {
    /// Linux-compatible syscall number from the record header.
    pub syscall: u16,
    /// Record-level flags carried unchanged from the header.
    pub flags: u16,
    /// The six syscall scalar words, carried unchanged.
    pub scalars: [i64; 6],
    /// The validated pointer-argument spans, in descriptor order.
    pub spans: Vec<ResolvedSpan<'a>>,
}

/// One validated span resolved to a byte slice that borrows the input.
#[derive(Debug, PartialEq, Eq)]
pub struct ResolvedSpan<'a> {
    /// One of the `SPAN_KIND_*` values.
    pub kind: u8,
    /// The guest's original pointer argument index (0..=5).
    pub arg_index: u8,
    /// The span's flat byte range `[offset, offset + len)`. For nested kinds
    /// this covers the region's structural prefix; the resolved sub-buffers
    /// live in [`ResolvedSpan::nested`].
    pub bytes: &'a [u8],
    /// Parsed nested structure for `IOVEC_ARRAY`/`MSGHDR`; `None` for flat
    /// spans.
    pub nested: Option<Nested<'a>>,
}

/// Parsed nested structure for a nested span kind.
#[derive(Debug, PartialEq, Eq)]
pub enum Nested<'a> {
    /// An iovec array: the validated list of buffer slices, in order.
    Iovec(Vec<&'a [u8]>),
    /// A msghdr: socket name, iovec buffers, ancillary control data, flags.
    MsgHdr {
        /// Socket address bytes (empty if absent).
        name: &'a [u8],
        /// The scatter/gather buffers.
        iov: Vec<&'a [u8]>,
        /// Ancillary control-message bytes (empty if absent).
        control: &'a [u8],
        /// `msg_flags`.
        flags: u32,
    },
}

/// Why a record failed to decode.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DecodeError {
    /// `magic` did not equal [`RECORD_MAGIC`].
    BadMagic,
    /// `record_abi` did not equal [`RECORD_ABI`].
    UnsupportedRecordAbi,
    /// `span_count` exceeded [`MAX_SPANS`].
    SpanCountOverflow,
    /// A structural offset lay beyond `data_capacity` (or the input length).
    OffsetOob,
    /// A payload length ran past `data_capacity` (or the input length).
    LenOob,
    /// Two top-level span ranges overlapped, or a span collided with the
    /// reserved header+descriptor region.
    OverlappingSpans,
    /// A nested count (e.g. iovec entries) exceeded its cap.
    CountCap,
    /// Checked arithmetic overflowed (e.g. `offset + len` wraps `u32`).
    Arith,
}

/// Decode and fully validate a channel record.
///
/// `data` is the channel DATA region (bytes starting at the channel's
/// `DATA_OFFSET`), already copied out of the shared buffer by the caller.
/// `data_capacity` is the usable data-region length (`<= 65480` for an inline
/// channel, larger for a scratch-backed channel). All record offsets are
/// relative to the start of `data`.
///
/// Returns [`DecodedSyscall`] whose slices borrow `data`, or the first
/// [`DecodeError`] encountered. Never panics for any `(data, data_capacity)`.
pub fn decode(data: &[u8], data_capacity: usize) -> Result<DecodedSyscall<'_>, DecodeError> {
    // Header presence: both the input and the logical capacity must hold it.
    if data.len() < RECORD_HEADER_BYTES || RECORD_HEADER_BYTES > data_capacity {
        return Err(DecodeError::OffsetOob);
    }

    let magic = read_u32(data, H_MAGIC, data_capacity)?;
    if magic != RECORD_MAGIC {
        return Err(DecodeError::BadMagic);
    }
    let record_abi = read_u16(data, H_RECORD_ABI, data_capacity)?;
    if record_abi != RECORD_ABI {
        return Err(DecodeError::UnsupportedRecordAbi);
    }

    let syscall = read_u16(data, H_SYSCALL, data_capacity)?;
    let span_count = read_u16(data, H_SPAN_COUNT, data_capacity)? as usize;
    let flags = read_u16(data, H_FLAGS, data_capacity)?;

    let mut scalars = [0i64; 6];
    for (i, slot) in scalars.iter_mut().enumerate() {
        let off = H_SCALARS
            .checked_add(i.checked_mul(8).ok_or(DecodeError::Arith)?)
            .ok_or(DecodeError::Arith)?;
        *slot = read_i64(data, off, data_capacity)?;
    }

    if span_count > MAX_SPANS {
        return Err(DecodeError::SpanCountOverflow);
    }

    // The descriptor array must fit entirely within the capacity.
    let desc_bytes = span_count
        .checked_mul(SPAN_DESCRIPTOR_BYTES)
        .ok_or(DecodeError::Arith)?;
    let desc_end = RECORD_HEADER_BYTES
        .checked_add(desc_bytes)
        .ok_or(DecodeError::Arith)?;
    if desc_end > data_capacity {
        return Err(DecodeError::OffsetOob);
    }

    // The header+descriptor region is reserved; a payload span may not collide
    // with it. Seed the top-level occupied set with that interval.
    let mut occupied: Vec<(usize, usize)> = Vec::new();
    occupied.push((0, desc_end));

    let mut spans: Vec<ResolvedSpan<'_>> = Vec::new();
    for i in 0..span_count {
        // Descriptor position is within `desc_end <= data_capacity`.
        let dpos = RECORD_HEADER_BYTES
            .checked_add(i.checked_mul(SPAN_DESCRIPTOR_BYTES).ok_or(DecodeError::Arith)?)
            .ok_or(DecodeError::Arith)?;

        let kind = read_u8(data, dpos + D_KIND, data_capacity)?;
        let arg_index = read_u8(data, dpos + D_ARG_INDEX, data_capacity)?;
        let offset = read_u32(data, dpos + D_OFFSET, data_capacity)?;
        let len = read_u32(data, dpos + D_LEN, data_capacity)?;

        if !span_kind_is_valid(kind) {
            return Err(DecodeError::OffsetOob);
        }

        let (start, end) = checked_span(offset, len, data_capacity)?;
        let bytes = data.get(start..end).ok_or(DecodeError::LenOob)?;

        // Only non-empty ranges occupy space and can overlap.
        if end > start {
            check_no_overlap(&occupied, start, end)?;
            occupied.push((start, end));
        }

        let nested = match kind {
            SPAN_KIND_IOVEC_ARRAY => {
                let mut local: Vec<(usize, usize)> = Vec::new();
                let (bufs, _block_end) = parse_iovec(data, data_capacity, start, &mut local)?;
                Some(Nested::Iovec(bufs))
            }
            SPAN_KIND_MSGHDR => Some(parse_msghdr(data, data_capacity, start)?),
            _ => None,
        };

        spans.push(ResolvedSpan {
            kind,
            arg_index,
            bytes,
            nested,
        });
    }

    Ok(DecodedSyscall {
        syscall,
        flags,
        scalars,
        spans,
    })
}

/// Parse and validate an iovec-array region beginning at `region_start`.
///
/// Layout: `{ u32 count; count*(u32 buf_off, u32 buf_len); buffers }`.
/// `buf_off` is absolute (relative to the start of `data`), so each buffer is
/// bounds-checked exactly like a flat span. Returns the buffer slices and the
/// end offset of the structural block (count + entry table). Accumulates each
/// buffer range into `occupied` and rejects overlap among them.
fn parse_iovec<'a>(
    data: &'a [u8],
    cap: usize,
    region_start: usize,
    occupied: &mut Vec<(usize, usize)>,
) -> Result<(Vec<&'a [u8]>, usize), DecodeError> {
    let count_pos = region_start
        .checked_add(IOVEC_ARRAY_COUNT_OFFSET)
        .ok_or(DecodeError::Arith)?;
    let count = read_u32(data, count_pos, cap)? as usize;
    if count > MAX_IOVEC {
        return Err(DecodeError::CountCap);
    }

    let entries_start = region_start
        .checked_add(IOVEC_ARRAY_ENTRIES_OFFSET)
        .ok_or(DecodeError::Arith)?;
    let entries_bytes = count
        .checked_mul(IOVEC_ARRAY_ENTRY_BYTES)
        .ok_or(DecodeError::Arith)?;
    let entries_end = entries_start
        .checked_add(entries_bytes)
        .ok_or(DecodeError::Arith)?;
    if entries_end > cap {
        return Err(DecodeError::LenOob);
    }

    let mut bufs: Vec<&'a [u8]> = Vec::new();
    for i in 0..count {
        let epos = entries_start
            .checked_add(i.checked_mul(IOVEC_ARRAY_ENTRY_BYTES).ok_or(DecodeError::Arith)?)
            .ok_or(DecodeError::Arith)?;
        let buf_off = read_u32(data, epos, cap)?;
        let buf_len = read_u32(data, epos + 4, cap)?;
        let (s, e) = checked_span(buf_off, buf_len, cap)?;
        let buf = data.get(s..e).ok_or(DecodeError::LenOob)?;
        if e > s {
            check_no_overlap(occupied, s, e)?;
            occupied.push((s, e));
        }
        bufs.push(buf);
    }

    Ok((bufs, entries_end))
}

/// Parse and validate a msghdr region beginning at `region_start`.
///
/// Layout: `{ u32 name_off; u32 name_len; <iovec-block>; u32 control_off;
/// u32 control_len; u32 flags }`. The name, iovec buffers, and control bytes
/// are validated with the same bounds/overlap rules; overlap is checked among
/// all of them within this region.
fn parse_msghdr<'a>(data: &'a [u8], cap: usize, region_start: usize) -> Result<Nested<'a>, DecodeError> {
    let name_off = read_u32(
        data,
        region_start
            .checked_add(MSGHDR_NAME_OFF_OFFSET)
            .ok_or(DecodeError::Arith)?,
        cap,
    )?;
    let name_len = read_u32(
        data,
        region_start
            .checked_add(MSGHDR_NAME_LEN_OFFSET)
            .ok_or(DecodeError::Arith)?,
        cap,
    )?;

    let block_start = region_start
        .checked_add(MSGHDR_IOVEC_BLOCK_OFFSET)
        .ok_or(DecodeError::Arith)?;

    // Overlap set shared across name, iovec buffers, and control.
    let mut occupied: Vec<(usize, usize)> = Vec::new();
    let (iov, block_end) = parse_iovec(data, cap, block_start, &mut occupied)?;

    let control_off = read_u32(data, block_end, cap)?;
    let control_len = read_u32(
        data,
        block_end.checked_add(4).ok_or(DecodeError::Arith)?,
        cap,
    )?;
    let flags = read_u32(
        data,
        block_end.checked_add(8).ok_or(DecodeError::Arith)?,
        cap,
    )?;

    let (ns, ne) = checked_span(name_off, name_len, cap)?;
    let name = data.get(ns..ne).ok_or(DecodeError::LenOob)?;
    if ne > ns {
        check_no_overlap(&occupied, ns, ne)?;
        occupied.push((ns, ne));
    }

    let (cs, ce) = checked_span(control_off, control_len, cap)?;
    let control = data.get(cs..ce).ok_or(DecodeError::LenOob)?;
    if ce > cs {
        check_no_overlap(&occupied, cs, ce)?;
        occupied.push((cs, ce));
    }

    Ok(Nested::MsgHdr {
        name,
        iov,
        control,
        flags,
    })
}

/// Validate a `[offset, offset + len)` span with `u32` checked arithmetic and
/// bound it by `cap`. `offset` past `cap` is [`DecodeError::OffsetOob`];
/// `offset + len` past `cap` is [`DecodeError::LenOob`]; a `u32` wrap on the
/// sum is [`DecodeError::Arith`].
fn checked_span(offset: u32, len: u32, cap: usize) -> Result<(usize, usize), DecodeError> {
    let end_u32 = offset.checked_add(len).ok_or(DecodeError::Arith)?;
    let start = offset as usize;
    let end = end_u32 as usize;
    if start > cap {
        return Err(DecodeError::OffsetOob);
    }
    if end > cap {
        return Err(DecodeError::LenOob);
    }
    Ok((start, end))
}

/// Reject a new non-empty range that overlaps any range already occupied.
fn check_no_overlap(occupied: &[(usize, usize)], start: usize, end: usize) -> Result<(), DecodeError> {
    for &(os, oe) in occupied {
        // Half-open ranges overlap iff each starts before the other ends.
        if start < oe && os < end {
            return Err(DecodeError::OverlappingSpans);
        }
    }
    Ok(())
}

/// Read `len` bytes at `off`, bounded by both `cap` and the input length.
fn read_bytes<'a>(data: &'a [u8], off: usize, len: usize, cap: usize) -> Result<&'a [u8], DecodeError> {
    let end = off.checked_add(len).ok_or(DecodeError::Arith)?;
    if end > cap {
        return Err(DecodeError::OffsetOob);
    }
    data.get(off..end).ok_or(DecodeError::OffsetOob)
}

fn read_u8(data: &[u8], off: usize, cap: usize) -> Result<u8, DecodeError> {
    let b = read_bytes(data, off, 1, cap)?;
    let arr: [u8; 1] = b.try_into().map_err(|_| DecodeError::OffsetOob)?;
    Ok(arr[0])
}

fn read_u16(data: &[u8], off: usize, cap: usize) -> Result<u16, DecodeError> {
    let b = read_bytes(data, off, 2, cap)?;
    let arr: [u8; 2] = b.try_into().map_err(|_| DecodeError::OffsetOob)?;
    Ok(u16::from_le_bytes(arr))
}

fn read_u32(data: &[u8], off: usize, cap: usize) -> Result<u32, DecodeError> {
    let b = read_bytes(data, off, 4, cap)?;
    let arr: [u8; 4] = b.try_into().map_err(|_| DecodeError::OffsetOob)?;
    Ok(u32::from_le_bytes(arr))
}

fn read_i64(data: &[u8], off: usize, cap: usize) -> Result<i64, DecodeError> {
    let b = read_bytes(data, off, 8, cap)?;
    let arr: [u8; 8] = b.try_into().map_err(|_| DecodeError::OffsetOob)?;
    Ok(i64::from_le_bytes(arr))
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloc::vec;
    use alloc::vec::Vec;
    use wasm_posix_shared::channel_record::{
        SPAN_KIND_IN_PTR, SPAN_KIND_OUT_PTR,
    };

    // -----------------------------------------------------------------------
    // Test-local reference encoder.
    //
    // Mirrors the `channel_record` byte layout so tests can build valid (and
    // deliberately-invalid) records and round-trip them through `decode`.
    // -----------------------------------------------------------------------

    /// A span to encode.
    #[derive(Clone)]
    enum SpanSpec {
        Flat {
            kind: u8,
            arg_index: u8,
            payload: Vec<u8>,
        },
        Iovec {
            arg_index: u8,
            buffers: Vec<Vec<u8>>,
        },
        Msghdr {
            arg_index: u8,
            name: Vec<u8>,
            iov: Vec<Vec<u8>>,
            control: Vec<u8>,
            flags: u32,
        },
    }

    struct RecordBuilder {
        syscall: u16,
        flags: u16,
        record_abi: u16,
        magic: u32,
        scalars: [i64; 6],
        spans: Vec<SpanSpec>,
    }

    impl RecordBuilder {
        fn new() -> Self {
            RecordBuilder {
                syscall: 0,
                flags: 0,
                record_abi: RECORD_ABI,
                magic: RECORD_MAGIC,
                scalars: [0; 6],
                spans: Vec::new(),
            }
        }

        fn build(&self) -> Vec<u8> {
            let n = self.spans.len();
            let desc_end = RECORD_HEADER_BYTES + n * SPAN_DESCRIPTOR_BYTES;

            // Payload region grows after the descriptor array; its absolute
            // base is `desc_end`.
            let mut payload: Vec<u8> = Vec::new();
            let mut descriptors: Vec<u8> = Vec::new();

            let alloc = |payload: &mut Vec<u8>, bytes: &[u8]| -> u32 {
                let off = (desc_end + payload.len()) as u32;
                payload.extend_from_slice(bytes);
                off
            };

            for span in &self.spans {
                match span {
                    SpanSpec::Flat {
                        kind,
                        arg_index,
                        payload: p,
                    } => {
                        let off = if p.is_empty() {
                            (desc_end + payload.len()) as u32
                        } else {
                            alloc(&mut payload, p)
                        };
                        push_descriptor(&mut descriptors, *kind, *arg_index, off, p.len() as u32);
                    }
                    SpanSpec::Iovec { arg_index, buffers } => {
                        let region_off = (desc_end + payload.len()) as u32;
                        let region = encode_iovec_region(desc_end + payload.len(), buffers);
                        let region_len = region.len() as u32;
                        payload.extend_from_slice(&region);
                        push_descriptor(
                            &mut descriptors,
                            SPAN_KIND_IOVEC_ARRAY,
                            *arg_index,
                            region_off,
                            region_len,
                        );
                    }
                    SpanSpec::Msghdr {
                        arg_index,
                        name,
                        iov,
                        control,
                        flags,
                    } => {
                        let region_off = desc_end + payload.len();
                        let (region, struct_len) =
                            encode_msghdr_region(region_off, name, iov, control, *flags);
                        payload.extend_from_slice(&region);
                        push_descriptor(
                            &mut descriptors,
                            SPAN_KIND_MSGHDR,
                            *arg_index,
                            region_off as u32,
                            struct_len as u32,
                        );
                    }
                }
            }

            // Header.
            let mut out: Vec<u8> = Vec::new();
            out.extend_from_slice(&self.magic.to_le_bytes());
            out.extend_from_slice(&self.record_abi.to_le_bytes());
            out.extend_from_slice(&self.syscall.to_le_bytes());
            out.extend_from_slice(&(n as u16).to_le_bytes());
            out.extend_from_slice(&self.flags.to_le_bytes());
            out.extend_from_slice(&0u32.to_le_bytes()); // _reserved
            for s in &self.scalars {
                out.extend_from_slice(&s.to_le_bytes());
            }
            debug_assert_eq!(out.len(), RECORD_HEADER_BYTES);

            out.extend_from_slice(&descriptors);
            out.extend_from_slice(&payload);
            out
        }
    }

    fn push_descriptor(out: &mut Vec<u8>, kind: u8, arg_index: u8, offset: u32, len: u32) {
        out.push(kind);
        out.push(arg_index);
        out.extend_from_slice(&0u16.to_le_bytes()); // _pad
        out.extend_from_slice(&offset.to_le_bytes());
        out.extend_from_slice(&len.to_le_bytes());
    }

    /// Encode `{ count; entries; buffers }` with absolute buffer offsets.
    /// `region_off` is the absolute start of this region within the record.
    fn encode_iovec_region(region_off: usize, buffers: &[Vec<u8>]) -> Vec<u8> {
        let count = buffers.len();
        let struct_len = 4 + count * IOVEC_ARRAY_ENTRY_BYTES;
        let buffers_base = region_off + struct_len;

        let mut entries: Vec<u8> = Vec::new();
        let mut buf_bytes: Vec<u8> = Vec::new();
        let mut cursor = buffers_base;
        for b in buffers {
            entries.extend_from_slice(&(cursor as u32).to_le_bytes());
            entries.extend_from_slice(&(b.len() as u32).to_le_bytes());
            buf_bytes.extend_from_slice(b);
            cursor += b.len();
        }

        let mut out: Vec<u8> = Vec::new();
        out.extend_from_slice(&(count as u32).to_le_bytes());
        out.extend_from_slice(&entries);
        out.extend_from_slice(&buf_bytes);
        out
    }

    /// Encode a msghdr region. Returns `(bytes, struct_len)` where `struct_len`
    /// is the descriptor `len` (the structural prefix, not the referenced
    /// payloads, which follow it).
    fn encode_msghdr_region(
        region_off: usize,
        name: &[u8],
        iov: &[Vec<u8>],
        control: &[u8],
        flags: u32,
    ) -> (Vec<u8>, usize) {
        let count = iov.len();
        // struct = name_off/len (8) + iovec block (4 + count*8) + control
        // off/len + flags (12).
        let struct_len = 8 + (4 + count * IOVEC_ARRAY_ENTRY_BYTES) + 12;
        let ref_base = region_off + struct_len;

        let mut cursor = ref_base;
        let name_off = if name.is_empty() { 0 } else { cursor as u32 };
        cursor += name.len();

        let mut entries: Vec<u8> = Vec::new();
        let mut ref_bytes: Vec<u8> = Vec::new();
        ref_bytes.extend_from_slice(name);
        for b in iov {
            entries.extend_from_slice(&(cursor as u32).to_le_bytes());
            entries.extend_from_slice(&(b.len() as u32).to_le_bytes());
            ref_bytes.extend_from_slice(b);
            cursor += b.len();
        }
        let control_off = if control.is_empty() { 0 } else { cursor as u32 };
        ref_bytes.extend_from_slice(control);

        let mut out: Vec<u8> = Vec::new();
        out.extend_from_slice(&name_off.to_le_bytes());
        out.extend_from_slice(&(name.len() as u32).to_le_bytes());
        out.extend_from_slice(&(count as u32).to_le_bytes());
        out.extend_from_slice(&entries);
        out.extend_from_slice(&control_off.to_le_bytes());
        out.extend_from_slice(&(control.len() as u32).to_le_bytes());
        out.extend_from_slice(&flags.to_le_bytes());
        debug_assert_eq!(out.len(), struct_len);
        out.extend_from_slice(&ref_bytes);
        (out, struct_len)
    }

    // -----------------------------------------------------------------------
    // Task 2 unit tests.
    // -----------------------------------------------------------------------

    #[test]
    fn valid_scalar_only_record() {
        let mut b = RecordBuilder::new();
        b.syscall = 39; // getpid, no pointer args
        b.flags = 0;
        b.scalars = [1, 2, 3, 4, 5, 6];
        let data = b.build();

        let decoded = decode(&data, data.len()).expect("scalar-only record decodes");
        assert_eq!(decoded.syscall, 39);
        assert_eq!(decoded.flags, 0);
        assert_eq!(decoded.scalars, [1, 2, 3, 4, 5, 6]);
        assert!(decoded.spans.is_empty());
    }

    #[test]
    fn single_in_ptr_span_in_bounds() {
        let mut b = RecordBuilder::new();
        b.syscall = 1; // write
        b.scalars = [7, 0, 0, 0, 0, 0];
        b.spans.push(SpanSpec::Flat {
            kind: SPAN_KIND_IN_PTR,
            arg_index: 1,
            payload: b"hello".to_vec(),
        });
        let data = b.build();

        let decoded = decode(&data, data.len()).expect("in-ptr record decodes");
        assert_eq!(decoded.spans.len(), 1);
        let span = &decoded.spans[0];
        assert_eq!(span.kind, SPAN_KIND_IN_PTR);
        assert_eq!(span.arg_index, 1);
        assert_eq!(span.bytes, b"hello");
        assert!(span.nested.is_none());
    }

    #[test]
    fn bad_magic_rejected() {
        let mut b = RecordBuilder::new();
        b.magic = 0xDEAD_BEEF;
        let data = b.build();
        assert_eq!(decode(&data, data.len()), Err(DecodeError::BadMagic));
    }

    #[test]
    fn unsupported_record_abi_rejected() {
        let mut b = RecordBuilder::new();
        b.record_abi = 2;
        let data = b.build();
        assert_eq!(
            decode(&data, data.len()),
            Err(DecodeError::UnsupportedRecordAbi)
        );
    }

    #[test]
    fn span_count_overflow_rejected() {
        let b = RecordBuilder::new();
        // Build a valid empty record, then overwrite span_count with
        // MAX_SPANS + 1.
        let mut data = b.build();
        let bad = (MAX_SPANS as u16 + 1).to_le_bytes();
        data[H_SPAN_COUNT] = bad[0];
        data[H_SPAN_COUNT + 1] = bad[1];
        assert_eq!(
            decode(&data, data.len()),
            Err(DecodeError::SpanCountOverflow)
        );
    }

    #[test]
    fn len_oob_rejected() {
        let mut b = RecordBuilder::new();
        b.spans.push(SpanSpec::Flat {
            kind: SPAN_KIND_IN_PTR,
            arg_index: 0,
            payload: b"abcd".to_vec(),
        });
        let mut data = b.build();
        // Find the single descriptor and enlarge its len past capacity.
        let dpos = RECORD_HEADER_BYTES;
        let huge = ((data.len() as u32) + 16).to_le_bytes();
        data[dpos + D_LEN..dpos + D_LEN + 4].copy_from_slice(&huge);
        assert_eq!(decode(&data, data.len()), Err(DecodeError::LenOob));
    }

    #[test]
    fn offset_alone_oob_rejected() {
        let mut b = RecordBuilder::new();
        b.spans.push(SpanSpec::Flat {
            kind: SPAN_KIND_IN_PTR,
            arg_index: 0,
            payload: b"abcd".to_vec(),
        });
        let mut data = b.build();
        let dpos = RECORD_HEADER_BYTES;
        // offset beyond capacity, len 0 -> OffsetOob (offset alone > cap).
        let off = ((data.len() as u32) + 8).to_le_bytes();
        data[dpos + D_OFFSET..dpos + D_OFFSET + 4].copy_from_slice(&off);
        data[dpos + D_LEN..dpos + D_LEN + 4].copy_from_slice(&0u32.to_le_bytes());
        assert_eq!(decode(&data, data.len()), Err(DecodeError::OffsetOob));
    }

    #[test]
    fn overlapping_spans_rejected() {
        let mut b = RecordBuilder::new();
        b.spans.push(SpanSpec::Flat {
            kind: SPAN_KIND_IN_PTR,
            arg_index: 0,
            payload: b"abcdefgh".to_vec(),
        });
        b.spans.push(SpanSpec::Flat {
            kind: SPAN_KIND_OUT_PTR,
            arg_index: 1,
            payload: b"ignored!".to_vec(),
        });
        let mut data = b.build();
        // Point the second descriptor's range at the first descriptor's bytes.
        let d0 = RECORD_HEADER_BYTES;
        let d1 = RECORD_HEADER_BYTES + SPAN_DESCRIPTOR_BYTES;
        let mut off0 = [0u8; 4];
        off0.copy_from_slice(&data[d0 + D_OFFSET..d0 + D_OFFSET + 4]);
        let mut len0 = [0u8; 4];
        len0.copy_from_slice(&data[d0 + D_LEN..d0 + D_LEN + 4]);
        data[d1 + D_OFFSET..d1 + D_OFFSET + 4].copy_from_slice(&off0);
        data[d1 + D_LEN..d1 + D_LEN + 4].copy_from_slice(&len0);
        assert_eq!(
            decode(&data, data.len()),
            Err(DecodeError::OverlappingSpans)
        );
    }

    #[test]
    fn iovec_count_cap_rejected() {
        let mut b = RecordBuilder::new();
        // One real buffer so the region exists; we then overwrite its count.
        b.spans.push(SpanSpec::Iovec {
            arg_index: 0,
            buffers: vec![b"x".to_vec()],
        });
        let mut data = b.build();
        let dpos = RECORD_HEADER_BYTES;
        let mut off = [0u8; 4];
        off.copy_from_slice(&data[dpos + D_OFFSET..dpos + D_OFFSET + 4]);
        let region_off = u32::from_le_bytes(off) as usize;
        // Overwrite the region's u32 count with MAX_IOVEC + 1.
        let bad = ((MAX_IOVEC as u32) + 1).to_le_bytes();
        data[region_off..region_off + 4].copy_from_slice(&bad);
        assert_eq!(decode(&data, data.len()), Err(DecodeError::CountCap));
    }

    #[test]
    fn offset_plus_len_arith_overflow_rejected() {
        let mut b = RecordBuilder::new();
        b.spans.push(SpanSpec::Flat {
            kind: SPAN_KIND_IN_PTR,
            arg_index: 0,
            payload: b"abcd".to_vec(),
        });
        let mut data = b.build();
        let dpos = RECORD_HEADER_BYTES;
        data[dpos + D_OFFSET..dpos + D_OFFSET + 4].copy_from_slice(&u32::MAX.to_le_bytes());
        data[dpos + D_LEN..dpos + D_LEN + 4].copy_from_slice(&1u32.to_le_bytes());
        assert_eq!(decode(&data, data.len()), Err(DecodeError::Arith));
    }

    #[test]
    fn valid_iovec_array_three_buffers() {
        let mut b = RecordBuilder::new();
        b.syscall = 20; // writev
        b.spans.push(SpanSpec::Iovec {
            arg_index: 1,
            buffers: vec![b"one".to_vec(), b"twotwo".to_vec(), b"three!!".to_vec()],
        });
        let data = b.build();

        let decoded = decode(&data, data.len()).expect("iovec record decodes");
        assert_eq!(decoded.spans.len(), 1);
        match &decoded.spans[0].nested {
            Some(Nested::Iovec(bufs)) => {
                assert_eq!(bufs.len(), 3);
                assert_eq!(bufs[0], b"one");
                assert_eq!(bufs[1], b"twotwo");
                assert_eq!(bufs[2], b"three!!");
            }
            other => panic!("expected iovec nested, got {other:?}"),
        }
    }

    #[test]
    fn valid_msghdr_name_two_iov_control() {
        let mut b = RecordBuilder::new();
        b.syscall = 46; // sendmsg
        b.spans.push(SpanSpec::Msghdr {
            arg_index: 1,
            name: b"addr".to_vec(),
            iov: vec![b"iov0".to_vec(), b"iovone1".to_vec()],
            control: b"cmsg".to_vec(),
            flags: 0x1234,
        });
        let data = b.build();

        let decoded = decode(&data, data.len()).expect("msghdr record decodes");
        assert_eq!(decoded.spans.len(), 1);
        match &decoded.spans[0].nested {
            Some(Nested::MsgHdr {
                name,
                iov,
                control,
                flags,
            }) => {
                assert_eq!(*name, b"addr");
                assert_eq!(iov.len(), 2);
                assert_eq!(iov[0], b"iov0");
                assert_eq!(iov[1], b"iovone1");
                assert_eq!(*control, b"cmsg");
                assert_eq!(*flags, 0x1234);
            }
            other => panic!("expected msghdr nested, got {other:?}"),
        }
    }

    // -----------------------------------------------------------------------
    // Task 3 seeded property tests.
    //
    // Deterministic: a fixed const seed array drives an xorshift64 PRNG. No
    // Math.random, no wall-clock, no thread RNG.
    // -----------------------------------------------------------------------

    const PROP_SEEDS: [u64; 4] = [
        0x0123_4567_89AB_CDEF,
        0xDEAD_BEEF_CAFE_F00D,
        0xA5A5_5A5A_1234_9876,
        0x0F1E_2D3C_4B5A_6978,
    ];

    struct XorShift64(u64);
    impl XorShift64 {
        fn new(seed: u64) -> Self {
            // Avoid the all-zero fixed point.
            XorShift64(if seed == 0 { 0x9E37_79B9_7F4A_7C15 } else { seed })
        }
        fn next(&mut self) -> u64 {
            let mut x = self.0;
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            self.0 = x;
            x
        }
        fn range(&mut self, n: usize) -> usize {
            if n == 0 {
                0
            } else {
                (self.next() % (n as u64)) as usize
            }
        }
    }

    /// Byte offset of a subslice within `data`. Valid because every returned
    /// slice borrows `data`.
    fn sub_offset(data: &[u8], sub: &[u8]) -> usize {
        (sub.as_ptr() as usize) - (data.as_ptr() as usize)
    }

    /// Invariant (b): every returned slice lies fully within `data`, and no two
    /// top-level span byte ranges overlap.
    fn assert_slices_within_and_disjoint(data: &[u8], decoded: &DecodedSyscall<'_>) {
        let base = data.as_ptr() as usize;
        let end = base + data.len();
        let within = |s: &[u8]| {
            let p = s.as_ptr() as usize;
            p >= base && p + s.len() <= end
        };

        let mut top: Vec<(usize, usize)> = Vec::new();
        for span in &decoded.spans {
            assert!(within(span.bytes), "span bytes escape data");
            let so = sub_offset(data, span.bytes);
            if !span.bytes.is_empty() {
                top.push((so, so + span.bytes.len()));
            }
            match &span.nested {
                Some(Nested::Iovec(bufs)) => {
                    for buf in bufs {
                        assert!(within(buf), "iovec buffer escapes data");
                    }
                }
                Some(Nested::MsgHdr {
                    name,
                    iov,
                    control,
                    ..
                }) => {
                    assert!(within(name), "msghdr name escapes data");
                    assert!(within(control), "msghdr control escapes data");
                    for buf in iov {
                        assert!(within(buf), "msghdr iovec escapes data");
                    }
                }
                None => {}
            }
        }
        for i in 0..top.len() {
            for j in (i + 1)..top.len() {
                let (a0, a1) = top[i];
                let (b0, b1) = top[j];
                assert!(
                    !(a0 < b1 && b0 < a1),
                    "top-level spans overlap: {:?} {:?}",
                    top[i],
                    top[j]
                );
            }
        }
    }

    #[test]
    fn property_decode_never_panics_on_arbitrary_input() {
        // Invariant (a): decode never panics on any input slice + any capacity
        // <= slice len. Also feeds capacities > len to exercise that branch.
        for &seed in &PROP_SEEDS {
            let mut rng = XorShift64::new(seed);
            for _ in 0..1000 {
                let len = rng.range(300);
                let mut bytes = Vec::with_capacity(len);
                for _ in 0..len {
                    bytes.push((rng.next() & 0xFF) as u8);
                }
                // Occasionally stamp a valid magic/abi so structural paths run.
                if len >= RECORD_HEADER_BYTES && (rng.next() & 1) == 0 {
                    bytes[H_MAGIC..H_MAGIC + 4].copy_from_slice(&RECORD_MAGIC.to_le_bytes());
                    bytes[H_RECORD_ABI..H_RECORD_ABI + 2]
                        .copy_from_slice(&RECORD_ABI.to_le_bytes());
                    // Small span_count so descriptor paths engage.
                    let sc = (rng.range(MAX_SPANS + 2)) as u16;
                    bytes[H_SPAN_COUNT..H_SPAN_COUNT + 2].copy_from_slice(&sc.to_le_bytes());
                }
                let cap = if bytes.is_empty() {
                    0
                } else {
                    rng.range(bytes.len() + 1)
                };
                // Must not panic. On Ok, invariant (b) must hold.
                if let Ok(decoded) = decode(&bytes, cap) {
                    assert_slices_within_and_disjoint(&bytes, &decoded);
                }
                // Also exercise capacity > len (caller misuse): must not panic.
                let big_cap = bytes.len() + rng.range(64);
                let _ = decode(&bytes, big_cap);
            }
        }
    }

    #[test]
    fn property_roundtrip_encode_decode() {
        // Invariant (c): a record built by the reference encoder decodes back to
        // the same syscall/scalars/spans.
        for &seed in &PROP_SEEDS {
            let mut rng = XorShift64::new(seed);
            for _ in 0..1000 {
                let mut b = RecordBuilder::new();
                b.syscall = (rng.next() & 0xFFFF) as u16;
                b.flags = 0;
                for s in b.scalars.iter_mut() {
                    *s = rng.next() as i64;
                }

                let span_count = rng.range(MAX_SPANS + 1);
                // Track expected spans for comparison.
                let mut expected: Vec<SpanSpec> = Vec::new();
                for _ in 0..span_count {
                    let choice = rng.range(6);
                    let spec = match choice {
                        0 | 1 | 2 | 3 => {
                            let kind = (choice as u8) + 1; // 1..=4 flat kinds
                            let plen = rng.range(24);
                            let mut p = Vec::with_capacity(plen);
                            for _ in 0..plen {
                                p.push((rng.next() & 0xFF) as u8);
                            }
                            SpanSpec::Flat {
                                kind,
                                arg_index: rng.range(6) as u8,
                                payload: p,
                            }
                        }
                        4 => {
                            let nb = rng.range(4);
                            let mut buffers = Vec::new();
                            for _ in 0..nb {
                                let l = rng.range(12);
                                let mut buf = Vec::with_capacity(l);
                                for _ in 0..l {
                                    buf.push((rng.next() & 0xFF) as u8);
                                }
                                buffers.push(buf);
                            }
                            SpanSpec::Iovec {
                                arg_index: rng.range(6) as u8,
                                buffers,
                            }
                        }
                        _ => {
                            let nl = rng.range(6);
                            let mut name = Vec::with_capacity(nl);
                            for _ in 0..nl {
                                name.push((rng.next() & 0xFF) as u8);
                            }
                            let ni = rng.range(3);
                            let mut iov = Vec::new();
                            for _ in 0..ni {
                                let l = rng.range(10);
                                let mut buf = Vec::with_capacity(l);
                                for _ in 0..l {
                                    buf.push((rng.next() & 0xFF) as u8);
                                }
                                iov.push(buf);
                            }
                            let cl = rng.range(6);
                            let mut control = Vec::with_capacity(cl);
                            for _ in 0..cl {
                                control.push((rng.next() & 0xFF) as u8);
                            }
                            SpanSpec::Msghdr {
                                arg_index: rng.range(6) as u8,
                                name,
                                iov,
                                control,
                                flags: rng.next() as u32,
                            }
                        }
                    };
                    expected.push(spec);
                }
                b.spans = expected.clone();
                let data = b.build();

                let decoded = decode(&data, data.len())
                    .unwrap_or_else(|e| panic!("round-trip record failed to decode: {e:?}"));
                assert_slices_within_and_disjoint(&data, &decoded);

                assert_eq!(decoded.syscall, b.syscall);
                assert_eq!(decoded.scalars, b.scalars);
                assert_eq!(decoded.spans.len(), expected.len());
                for (span, spec) in decoded.spans.iter().zip(expected.iter()) {
                    match spec {
                        SpanSpec::Flat {
                            kind,
                            arg_index,
                            payload,
                        } => {
                            assert_eq!(span.kind, *kind);
                            assert_eq!(span.arg_index, *arg_index);
                            assert_eq!(span.bytes, &payload[..]);
                            assert!(span.nested.is_none());
                        }
                        SpanSpec::Iovec { arg_index, buffers } => {
                            assert_eq!(span.kind, SPAN_KIND_IOVEC_ARRAY);
                            assert_eq!(span.arg_index, *arg_index);
                            match &span.nested {
                                Some(Nested::Iovec(bufs)) => {
                                    assert_eq!(bufs.len(), buffers.len());
                                    for (got, want) in bufs.iter().zip(buffers.iter()) {
                                        assert_eq!(*got, &want[..]);
                                    }
                                }
                                other => panic!("expected iovec, got {other:?}"),
                            }
                        }
                        SpanSpec::Msghdr {
                            arg_index,
                            name,
                            iov,
                            control,
                            flags,
                        } => {
                            assert_eq!(span.kind, SPAN_KIND_MSGHDR);
                            assert_eq!(span.arg_index, *arg_index);
                            match &span.nested {
                                Some(Nested::MsgHdr {
                                    name: gname,
                                    iov: giov,
                                    control: gcontrol,
                                    flags: gflags,
                                }) => {
                                    assert_eq!(*gname, &name[..]);
                                    assert_eq!(giov.len(), iov.len());
                                    for (got, want) in giov.iter().zip(iov.iter()) {
                                        assert_eq!(*got, &want[..]);
                                    }
                                    assert_eq!(*gcontrol, &control[..]);
                                    assert_eq!(*gflags, *flags);
                                }
                                other => panic!("expected msghdr, got {other:?}"),
                            }
                        }
                    }
                }
            }
        }
    }
}
