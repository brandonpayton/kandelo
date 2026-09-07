# Rust target for Kandelo (`wasm32-unknown-kandelo`)

This directory holds the Rust cross-compilation target for Kandelo.

- `wasm32-unknown-kandelo.json` — `no_std`/`alloc` target spec
  (`target-family = ["wasm"]`).
- `wasm32-unknown-kandelo-std.json` — full-`std` target spec
  (`target-family = ["unix", "wasm"]`, so `std` selects its unix
  platform layer while `stdarch`'s wasm SIMD still compiles).

Both set `os = "kandelo"`, `env = "musl"`, and bake in
`+atomics,+bulk-memory,+mutable-globals` (required because the SDK link
contract uses `--shared-memory`).

## Building a guest today (spike-stage manual flow)

From the repo root, inside `scripts/dev-shell.sh`:

```
# no_std / alloc
cargo build --release -Z json-target-spec \
  -Z build-std=core,alloc,compiler_builtins \
  --target sdk/rust/wasm32-unknown-kandelo.json

# final link through the SDK (pulls crt1 + libc.a + channel glue)
wasm32posix-cc empty.c target/wasm32-unknown-kandelo/release/lib<name>.a \
  -o <name>.wasm

# run on the kernel
npx tsx examples/run-wasm.ts <name>.wasm
```

`std` builds additionally require the forked `rust-src` overlay (libc +
std) built via a linked private toolchain — see
`docs/plans/2026-09-07-rust-std-target-implementation.md` (Milestone 1)
and `scripts/build-rust-sysroot.sh` once it lands.

## Building a full-`std` program (bin crate)

`std` programs use a normal `fn main` and are linked directly by the SDK
(the target spec sets `linker = wasm32posix-cc`,
`linker-flavor = wasm-lld-cc`, and `entry-name = __main_argc_argv`, so
rustc drives the SDK driver and its `lang_start` entry connects to
Kandelo's crt1). `cargo build` produces a runnable `.wasm` directly — no
staticlib or separate link step. Requires the private sysroot (from
`scripts/build-rust-sysroot.sh`), the `RUSTC` wrapper, and:

```
RUSTC=$HOME/.kandelo/rust/rustc-kandelo \
RUST_LIBC_UNSTABLE_MUSL_V1_2_3=1 \
cargo build --release \
  -Z unstable-options -Z json-target-spec -Z build-std=std,panic_abort \
  --target sdk/rust/wasm32-unknown-kandelo-std.json

npx tsx examples/run-wasm.ts \
  target/wasm32-unknown-kandelo-std/release/<name>.wasm [args...]
```

`std::env::args`, `std::env::var`, `std::fs`, `std::time`, and `HashMap`
all work. See `programs/rust/std-hello/`.

A `wasm32posix-cargo` wrapper (Milestone 6) will hide these flags.
