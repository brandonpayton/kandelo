# Registering `wasm32-unknown-kandelo` in rustc (tier-3)

This is the compiler-side half of upstreaming. It must be authored and
compile-tested against a `rust-lang/rust` checkout — it CANNOT be done in
Kandelo's dev-shell (a prebuilt Nix rustc, no `compiler/` source, and
building rustc from source is out of scope here). The authoritative,
already-validated configuration is `sdk/rust/wasm32-unknown-kandelo-std.json`;
this document maps it to rustc's `Target`/`TargetOptions` so nothing is
invented.

## Files a rust-lang/rust PR touches

1. `compiler/rustc_target/src/spec/targets/wasm32_unknown_kandelo.rs`
   — the new target module (see mapping below).
2. `compiler/rustc_target/src/spec/mod.rs` — add
   `("wasm32-unknown-kandelo", wasm32_unknown_kandelo)` to
   `supported_targets!`.
3. `src/doc/rustc/src/platform-support.md` + a
   `platform-support/wasm32-unknown-kandelo.md` page (tier-3 policy:
   named maintainer, "it builds", no CI burden on other tiers).
4. `src/tools/build-manifest` / target lists as the tier-3 process
   requires.

## JSON → `TargetOptions` mapping (from the validated spec)

Base on `crate::spec::base::wasm` (the shared wasm base), then override:

| JSON field | rustc `Target`/`TargetOptions` |
|---|---|
| `llvm-target: wasm32-unknown-unknown` | `llvm_target: "wasm32-unknown-unknown".into()` |
| `arch: wasm32` | `arch: "wasm32".into()` |
| `os: kandelo` | `options.os = "kandelo".into()` |
| `env: musl` | `options.env = "musl".into()` |
| `vendor: unknown` | `options.vendor = "unknown".into()` (default) |
| `target-family: ["unix","wasm"]` | `options.families = cvs!["unix", "wasm"]` |
| `target-pointer-width: 32` | `pointer_width: 32` |
| `data-layout` | copy verbatim from the JSON |
| `features: +atomics,+bulk-memory,+mutable-globals` | `options.features = "+atomics,+bulk-memory,+mutable-globals".into()` |
| `max-atomic-width: 64` | `options.max_atomic_width = Some(64)` |
| `panic-strategy: abort` | `options.panic_strategy = PanicStrategy::Abort` |
| `tls-model: local-exec` | `options.tls_model = TlsModel::LocalExec` |
| `relocation-model: static` | `options.relocation_model = RelocModel::Static` |
| `is-like-wasm: true` | `options.is_like_wasm = true` |
| `dynamic-linking: true` | `options.dynamic_linking = true` |
| `has-thread-local: true` | `options.has_thread_local = true` |
| `linker: wasm32posix-cc` | `options.linker = Some("wasm32posix-cc".into())` |
| `linker-flavor: wasm-lld-cc` | `options.linker_flavor = LinkerFlavor::WasmLld(Cc::Yes)` |
| `entry-name: __main_argc_argv` | `options.entry_name = "__main_argc_argv".into()` |
| `only-cdylib`, `dll-suffix/.exe-suffix .wasm`, `crt-objects-fallback`, `eh-frame-header: false`, `emit-debug-gdb-scripts: false` | as in `base::wasm`, keep/set to match the JSON |

The `-lgcc_s`-drop and the crt1/libc/glue linkage are NOT target-spec
concerns: they live in the SDK driver (`wasm32posix-cc`), which the
target invokes as its linker. Upstream reviewers should know the target
depends on that external driver (like other cc-driver wasm targets).

## Validation the PR must run (in a rustc checkout)

- `./x check` and `./x build` with the target added.
- `-Zbuild-std` compiles for the target using the `libc` fork
  (`libc-kandelo.patch`) + the `std` overlay (`std-overlay.patch`) once
  those land in `rust-lang/libc` and `library/std`.
- The `programs/rust/*` fixtures build and run on the Kandelo kernel
  (the end-to-end check this repo already performs via the JSON spec).

## Why the JSON spec stays authoritative here

Kandelo builds Rust today via `-Zjson-target-spec` + the private-sysroot
overlay (see `docs/rust-target.md`), which is fully validated. Upstream
registration removes the need for the JSON and `build-std` overlay once
merged; until then, the JSON is the tested source of truth this mapping
is derived from.
