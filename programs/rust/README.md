# Rust guest fixtures

Standalone Rust programs that build for `wasm32-unknown-kandelo` and run
on the kernel. They validate the Rust target end-to-end (codegen → SDK
link against musl → syscall channel → kernel).

- `hello/` — P0: `no_std`, exports `__main_argc_argv`, writes a greeting.
- `alloc-demo/` — P1: `no_std` + `alloc` via a malloc-backed global
  allocator (`Vec`/`String`/`format!`).

Build/run: see `sdk/rust/README.md`. Run with
`npx tsx examples/run-wasm.ts <fixture>/<name>.wasm` (a self-contained
runner that skips builtin-program discovery).
