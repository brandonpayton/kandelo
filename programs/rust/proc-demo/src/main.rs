//! Kandelo Rust guest fixture (P3): std::process::Command.
//! The parent spawns itself with `--child` and checks the child's exit
//! status. Exercises std::process (which prefers posix_spawn on musl) and
//! process-lifecycle (spawn/wait/exit) through Kandelo.
//!
//! REQUIRES fork instrumentation: std::process on musl uses fork+exec
//! (the module imports kernel_fork + kernel_execve), and the kernel
//! refuses to exec a non-instrumented artifact. Build, then run:
//!   scripts/run-wasm-fork-instrument.sh <build>.wasm -o <build>.inst.wasm
//!   npx tsx examples/run-wasm.ts <build>.inst.wasm
//! wasm-fork-instrument is verified to work on Rust/LLVM codegen.
use std::env;
use std::process::{exit, Command};

fn main() {
    let args: Vec<String> = env::args().collect();
    if args.iter().any(|a| a == "--child") {
        println!("child: hello from the spawned child");
        exit(42);
    }
    let exe = &args[0];
    println!("parent: spawning {exe} --child");
    let status = Command::new(exe)
        .arg("--child")
        .status()
        .expect("spawn failed");
    println!("parent: child exit code = {:?}", status.code());
    assert_eq!(status.code(), Some(42), "unexpected child exit status");
    println!("std::process::Command OK");
}
