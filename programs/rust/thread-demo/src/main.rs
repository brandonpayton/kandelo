//! Kandelo Rust guest fixture (P4): std::thread + std::sync.
//! Spawns worker threads that increment a shared counter under a Mutex,
//! joins them, and checks the deterministic total. Exercises
//! pthread_create->clone, futex-based Mutex, Arc, and thread TLS.
use std::sync::{Arc, Mutex};
use std::thread;

fn main() {
    const THREADS: usize = 4;
    const PER_THREAD: u64 = 10_000;

    let counter = Arc::new(Mutex::new(0u64));
    let mut handles = Vec::new();
    for t in 0..THREADS {
        let c = Arc::clone(&counter);
        handles.push(thread::spawn(move || {
            for _ in 0..PER_THREAD {
                let mut g = c.lock().unwrap();
                *g += 1;
            }
            t
        }));
    }
    let mut joined = Vec::new();
    for h in handles {
        joined.push(h.join().expect("thread panicked"));
    }
    joined.sort_unstable();

    let total = *counter.lock().unwrap();
    let expected = THREADS as u64 * PER_THREAD;
    println!("threads joined = {joined:?}");
    println!("counter total = {total} (expected {expected})");
    assert_eq!(total, expected, "shared-counter race or lost update");
    println!("std::thread + Mutex OK");
}
