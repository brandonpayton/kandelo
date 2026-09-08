# Upstream-shaped diffs (tier-3 prep)

These are the changes the `wasm32-unknown-kandelo` target makes to
upstream Rust, isolated as diffs for review and as the basis for
upstreaming the target (rust-lang/libc + rust-lang/rust) as tier-3.

- `libc-kandelo.patch` — diff of `sdk/rust/libc-kandelo/` against
  upstream `libc` 0.2.185. ~9 files: the `kandelo` dispatch arms plus
  the wasm32 arch leaf reconciled to Kandelo's `wasm32posix` ABI (the
  bulk is the 279-entry syscall-number table).
- `std-overlay.patch` — diff of `sdk/rust/std-overlay/` against the
  pinned toolchain's `library/`. ~10 files, ~55 changed lines: `kandelo`
  `cfg` arms in `std`'s unix pal. Small because we reuse the existing
  unix backend rather than authoring one.

Regenerate: build the sysroot (`scripts/build-rust-sysroot.sh`), then
diff `sdk/rust/libc-kandelo` vs the cached `libc-0.2.185` and each
`sdk/rust/std-overlay/` file vs `$(rustc --print sysroot)/lib/rustlib/
src/rust/library/`.

NOTE: upstreaming the target also requires a rustc target-spec
registration (compiler PR); these diffs cover the library side.
