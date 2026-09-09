//! Regenerates the committed multi-node Wasm-GC guest fixture bytes for the
//! Phase 6 item 3c equivalence vehicle
//! (`host/test/fixtures/gc-reference-cycle-fresh-worker-bytes.ts`).
//!
//! WHY a Rust generator: the dev shell's WABT parser (`wat2wasm`) does not
//! accept current typed-reference / Wasm-GC syntax even with `--enable-gc`
//! (no `rec` groups, `ref.i31`, `array.new`, mutually recursive struct/array
//! types). The Rust `wat` crate DOES, so the reviewed
//! `gc-reference-cycle-fresh-worker.wat` source is compiled here into the exact
//! deterministic bytes the Node and browser integration tests share, exactly
//! like the adjacent `gc-reference-state-fresh-worker` fixture.
//!
//! This test does NOT write any file; it prints the hex so the committed
//! `-bytes.ts` can be refreshed. Regenerate with (from repo root):
//!   cargo test -p fork-codec --features gen-fixtures \
//!     --test gen_gc_reference_cycle_fixture -- --ignored --nocapture
//! then paste the printed hex (chunked) into
//! `host/test/fixtures/gc-reference-cycle-fresh-worker-bytes.ts`.

use std::path::Path;

#[test]
#[ignore = "prints the committed gc-reference-cycle-fresh-worker guest bytes as hex"]
fn regenerate_gc_reference_cycle_fixture() {
    let wat_path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../host/test/fixtures/gc-reference-cycle-fresh-worker.wat");
    let wat_src = std::fs::read_to_string(&wat_path)
        .unwrap_or_else(|e| panic!("read {}: {e}", wat_path.display()));
    let wasm = wat::parse_str(&wat_src).expect("compile multi-node GC guest WAT");

    eprintln!("wrote {} bytes of wasm", wasm.len());
    // Print the raw bytes as hex, chunked into 128-hex-char lines so the
    // committed TypeScript fixture stays reviewable.
    let hex: String = wasm.iter().map(|b| format!("{b:02x}")).collect();
    for chunk in hex.as_bytes().chunks(128) {
        eprintln!("  \"{}\",", std::str::from_utf8(chunk).unwrap());
    }
}
