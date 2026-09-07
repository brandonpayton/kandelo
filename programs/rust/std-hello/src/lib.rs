//! Kandelo Rust guest fixture (P2): a `std` program (staticlib, linked
//! via the SDK) exercising the "generic CLI" surface — stdio, fs, args,
//! time, and a HashMap (getrandom seeding) — against Kandelo's musl.
use std::collections::HashMap;
use std::ffi::{c_char, c_int};
use std::fs;
use std::io::Write;
use std::time::Instant;

fn run() -> i32 {
    println!("std::println works on Kandelo");

    // args — KNOWN GAP: empty here. This staticlib exports
    // `__main_argc_argv` directly and never runs std's `lang_start`,
    // which on musl is what captures argv for `std::env::args` (musl,
    // unlike glibc, does not pass argc/argv to `.init_array` fns). A
    // normal `fn main` bin entry fixes this but needs SDK-driven linking
    // (bin crates currently fail rust-lld on `-lc`). Tracked as M6.
    let args: Vec<String> = std::env::args().collect();
    println!("argc = {} (KNOWN GAP: empty until fn-main/SDK linking), args = {:?}", args.len(), args);

    // fs round-trip
    let path = "/tmp/kandelo-rust-std.txt";
    let payload = "round-trip through std::fs\n";
    if let Err(e) = fs::File::create(path).and_then(|mut f| f.write_all(payload.as_bytes())) {
        eprintln!("write failed: {e}");
        return 1;
    }
    match fs::read_to_string(path) {
        Ok(s) if s == payload => println!("std::fs round-trip OK"),
        Ok(s) => { eprintln!("round-trip mismatch: {s:?}"); return 2; }
        Err(e) => { eprintln!("read failed: {e}"); return 3; }
    }

    // time (monotonic clock)
    let t = Instant::now();
    let mut acc: u64 = 0;
    for i in 0..100_000u64 { acc = acc.wrapping_add(i); }
    println!("std::time elapsed for 1e5 adds = {:?} (acc={})", t.elapsed(), acc);

    // HashMap exercises getrandom-seeded SipHash
    let mut m: HashMap<String, i32> = HashMap::new();
    for (i, w) in ["alpha", "beta", "gamma"].iter().enumerate() {
        m.insert((*w).to_string(), i as i32);
    }
    let sum: i32 = m.values().sum();
    println!("HashMap len={}, value-sum={} (getrandom-seeded)", m.len(), sum);

    0
}

#[no_mangle]
pub extern "C" fn __main_argc_argv(_argc: c_int, _argv: *const *const c_char) -> c_int {
    run()
}
