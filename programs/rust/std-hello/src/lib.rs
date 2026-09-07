//! Kandelo Rust guest fixture (P2 first cut): a `std` program built as a
//! staticlib and linked through the SDK. Exercises std stdio, formatting,
//! and std::fs against Kandelo's musl. Exports `__main_argc_argv` (the
//! entry Kandelo's crt1 calls); std's allocator and panic handler come
//! from std itself.
use std::ffi::{c_char, c_int};
use std::fs;
use std::io::Write;

#[no_mangle]
pub extern "C" fn __main_argc_argv(_argc: c_int, _argv: *const *const c_char) -> c_int {
    println!("std::println works on Kandelo");

    let path = "/tmp/kandelo-rust-std.txt";
    let payload = "round-trip through std::fs\n";
    match fs::File::create(path).and_then(|mut f| f.write_all(payload.as_bytes())) {
        Ok(()) => {}
        Err(e) => {
            eprintln!("write failed: {e}");
            return 1;
        }
    }
    match fs::read_to_string(path) {
        Ok(s) if s == payload => println!("std::fs round-trip OK: {:?}", s.trim_end()),
        Ok(s) => {
            eprintln!("round-trip mismatch: {s:?}");
            return 2;
        }
        Err(e) => {
            eprintln!("read failed: {e}");
            return 3;
        }
    }
    0
}
