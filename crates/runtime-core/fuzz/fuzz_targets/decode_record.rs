//! Fuzz target for the bounds-checked channel record decoder.
//!
//! Feeds arbitrary `(bytes, capacity)` pairs into
//! [`runtime_core::channel_record_decode::decode`]. The decoder is the sole
//! validator of the opaque syscall record and must be panic-free and
//! `unsafe`-free for every input. This target asserts the same runtime
//! invariants the in-tree seeded property tests check under `cargo test`:
//!
//! - `decode` never panics for any input slice and any capacity.
//! - On `Ok`, every returned top-level and nested span slice lies fully within
//!   the input bytes, and no two top-level span ranges overlap.
//!
//! Run (host target, from this directory):
//!   cargo +nightly fuzz run decode_record
//!
//! The CI-friendly equivalent is the in-tree `property_*` tests in
//! `crates/runtime-core/src/channel_record_decode.rs`, which run under plain
//! `cargo test` without cargo-fuzz.

#![no_main]

use libfuzzer_sys::fuzz_target;

use runtime_core::channel_record_decode::{decode, DecodedSyscall, Nested};

/// Byte offset of a subslice within `data` (valid: every returned slice
/// borrows `data`).
fn sub_offset(data: &[u8], sub: &[u8]) -> usize {
    (sub.as_ptr() as usize) - (data.as_ptr() as usize)
}

fn assert_within_and_disjoint(data: &[u8], decoded: &DecodedSyscall<'_>) {
    let base = data.as_ptr() as usize;
    let end = base + data.len();
    let within = |s: &[u8]| {
        let p = s.as_ptr() as usize;
        p >= base && p + s.len() <= end
    };

    let mut top: Vec<(usize, usize)> = Vec::new();
    for span in &decoded.spans {
        assert!(within(span.bytes));
        if !span.bytes.is_empty() {
            let so = sub_offset(data, span.bytes);
            top.push((so, so + span.bytes.len()));
        }
        match &span.nested {
            Some(Nested::Iovec(bufs)) => {
                for buf in bufs {
                    assert!(within(buf));
                }
            }
            Some(Nested::MsgHdr {
                name,
                iov,
                control,
                ..
            }) => {
                assert!(within(name));
                assert!(within(control));
                for buf in iov {
                    assert!(within(buf));
                }
            }
            None => {}
        }
    }
    for i in 0..top.len() {
        for j in (i + 1)..top.len() {
            let (a0, a1) = top[i];
            let (b0, b1) = top[j];
            assert!(!(a0 < b1 && b0 < a1), "top-level spans overlap");
        }
    }
}

fuzz_target!(|input: (&[u8], usize)| {
    let (bytes, capacity) = input;
    // Clamp so the fuzzer spends its budget on meaningful capacities (<= len is
    // the real contract), while still occasionally exceeding len via the raw
    // value to exercise the caller-misuse branch.
    let capacities = [capacity, capacity % (bytes.len() + 1), bytes.len()];
    for cap in capacities {
        if let Ok(decoded) = decode(bytes, cap) {
            assert_within_and_disjoint(bytes, &decoded);
        }
    }
});
