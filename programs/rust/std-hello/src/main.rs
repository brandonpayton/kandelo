//! Kandelo Rust guest fixture (P2): a full-`std` program with a normal
//! `fn main`, built for wasm32-unknown-kandelo and linked directly by the
//! SDK (rustc drives `wasm32posix-cc`). Exercises the generic-CLI surface
//! — stdio, args, env, fs, time, HashMap — against Kandelo's musl.
use std::collections::HashMap;
use std::fs;
use std::io::Write;
use std::time::Instant;

fn main() {
    println!("std::println works on Kandelo");

    let args: Vec<String> = std::env::args().collect();
    println!("argc = {}, args = {:?}", args.len(), args);
    println!("HOME = {:?}", std::env::var("HOME").ok());

    let path = "/tmp/kandelo-rust-std.txt";
    let payload = "round-trip through std::fs\n";
    fs::File::create(path)
        .and_then(|mut f| f.write_all(payload.as_bytes()))
        .expect("write");
    assert_eq!(fs::read_to_string(path).expect("read"), payload);
    println!("std::fs round-trip OK");

    let t = Instant::now();
    let mut acc: u64 = 0;
    for i in 0..100_000u64 {
        acc = acc.wrapping_add(i);
    }
    println!("std::time elapsed = {:?} (acc={acc})", t.elapsed());

    let mut m: HashMap<String, i32> = HashMap::new();
    for (i, w) in ["alpha", "beta", "gamma"].iter().enumerate() {
        m.insert((*w).to_string(), i as i32);
    }
    println!("HashMap len={}, value-sum={} (getrandom-seeded)", m.len(), m.values().sum::<i32>());
}
