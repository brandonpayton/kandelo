#!/bin/bash
set -euo pipefail

# Build user programs (programs/*.c) into local-binaries/programs/.
# The resolver (host/src/binary-resolver.ts) prefers local-binaries/
# over binaries/, so locally-built binaries automatically override
# whatever the fetcher placed under `binaries/`.
# Uses the same toolchain and flags as libc-test builds.

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SYSROOT="$REPO_ROOT/sysroot"
GLUE_DIR="$REPO_ROOT/libc/glue"
BROWSER_MEMORY64_FIXTURES_REPO_ROOT="$REPO_ROOT"
BROWSER_MEMORY64_FIXTURES_MANIFEST="$REPO_ROOT/scripts/browser-memory64-example-fixtures.txt"
# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/browser-memory64-example-fixtures.sh"
# Per-arch output dirs match the layout the resolver's
# `place_binaries_symlinks` writes:
# binaries/programs/<arch>/ and local-binaries/programs/<arch>/.
# wasm32 and wasm64 builds share program names (e.g. hello64.wasm)
# so they MUST live in separate trees — a flat OUT_DIR would
# last-write-wins across arches.
OUT_DIR_32="$REPO_ROOT/local-binaries/programs/wasm32"
OUT_DIR_64="$REPO_ROOT/local-binaries/programs/wasm64"
TEST_FIXTURE_DIR="$REPO_ROOT/local-binaries/test-fixtures"
mkdir -p "$OUT_DIR_32" "$OUT_DIR_64" "$TEST_FIXTURE_DIR/wasm32"

# Package-owned resolver paths must never be populated by this developer/test
# compiler. A regular file at one of those paths has no immutable package
# generation identity, and later package materialization must correctly refuse
# to replace it. Derive the complete ownership set from the generated package
# projection so new package-owned programs cannot recreate that collision.
PROGRAM_PACKAGE_INDEX="$REPO_ROOT/packages/registry/program-packages.json"
if [ -L "$PROGRAM_PACKAGE_INDEX" ]; then
    echo "Error: program package ownership index must be a regular file, not a symlink: $PROGRAM_PACKAGE_INDEX" >&2
    exit 1
fi
if [ ! -f "$PROGRAM_PACKAGE_INDEX" ]; then
    # The index is a generated artifact (gitignored). build.sh / local-build
    # normally emit it first; regenerate it here so a standalone invocation
    # still derives the ownership set from an up-to-date projection.
    HOST_TARGET="$(rustc -vV | awk '/^host/ {print $2}')"
    cargo run -p xtask --target "$HOST_TARGET" --quiet -- \
        build-deps program-index \
        --source-repo-root "$REPO_ROOT" \
        "$REPO_ROOT/packages/registry" \
        "$PROGRAM_PACKAGE_INDEX"
fi
PACKAGE_OWNED_PROGRAM_MIRRORS="$(
    node - "$PROGRAM_PACKAGE_INDEX" <<'NODE'
const fs = require("node:fs");
const indexPath = process.argv[2];
const document = JSON.parse(fs.readFileSync(indexPath, "utf8"));
if (
  document.format !== "kandelo-program-packages-v2" ||
  document.packages === null ||
  typeof document.packages !== "object" ||
  Array.isArray(document.packages)
) {
  throw new Error(`Invalid program package ownership index: ${indexPath}`);
}
const claims = new Map();
for (const [packageName, entry] of Object.entries(document.packages)) {
  if (
    entry === null ||
    typeof entry !== "object" ||
    !Array.isArray(entry.arches) ||
    !Array.isArray(entry.members)
  ) {
    throw new Error(`Invalid program package projection for ${packageName}`);
  }
  for (const arch of entry.arches) {
    if (arch !== "wasm32" && arch !== "wasm64") {
      throw new Error(`Invalid program package architecture for ${packageName}`);
    }
    for (const member of entry.members) {
      if (
        member === null ||
        typeof member !== "object" ||
        typeof member.mirrorPath !== "string" ||
        member.mirrorPath.length === 0
      ) {
        throw new Error(`Invalid program package member for ${packageName}`);
      }
      const claim = `${arch}/${member.mirrorPath}`;
      const previous = claims.get(claim);
      if (previous !== undefined && previous !== packageName) {
        throw new Error(
          `Program mirror ${claim} is claimed by ${previous} and ${packageName}`,
        );
      }
      claims.set(claim, packageName);
    }
  }
}
process.stdout.write([...claims.keys()].sort().join("\n"));
NODE
)" || {
    echo "Error: could not derive package-owned program mirrors" >&2
    exit 1
}

package_owns_direct_program_path() {
    local arch="$1"
    local mirror="$2"
    [ -n "$PACKAGE_OWNED_PROGRAM_MIRRORS" ] &&
        grep -Fxq -- "$arch/$mirror" <<<"$PACKAGE_OWNED_PROGRAM_MIRRORS"
}

find_llvm_bin() {
    if [ -n "${LLVM_BIN:-}" ] && [ -x "$LLVM_BIN/clang" ]; then
        echo "$LLVM_BIN"
        return
    fi
    if [ -n "${LLVM_PREFIX:-}" ] && [ -x "$LLVM_PREFIX/bin/clang" ]; then
        echo "$LLVM_PREFIX/bin"
        return
    fi
    if command -v clang >/dev/null 2>&1; then
        dirname "$(command -v clang)"
        return
    fi
    echo "Error: LLVM/clang not found. Run scripts/dev-shell.sh or set LLVM_BIN/LLVM_PREFIX." >&2
    exit 1
}

LLVM_BIN="$(find_llvm_bin)"
CC="$LLVM_BIN/clang"
WASM_OPT="$(command -v wasm-opt 2>/dev/null || true)"

# Verify prerequisites
if [ ! -f "$SYSROOT/lib/libc.a" ]; then
    echo "Error: sysroot not found. Run scripts/build-musl.sh first." >&2
    exit 1
fi

CFLAGS=(
    --target=wasm32-unknown-unknown
    --sysroot="$SYSROOT"
    -nostdlib
    -O2
    -matomics -mbulk-memory
    -fno-trapping-math
    -mllvm -wasm-enable-sjlj
    -mllvm -wasm-use-legacy-eh=false
)

LINK_PRE_LIBS=(
    "$GLUE_DIR/channel_syscall.c"
    "$GLUE_DIR/compiler_rt.c"
    "$SYSROOT/lib/crt1.o"
)

# libc.a + linker flags. Per-program extra archives (libdrm.a, libgbm.a,
# libEGL.a, libGLESv2.a) are spliced BEFORE libc.a so the stubs'
# internal references (mmap, ioctl, calloc, …) resolve in a single
# linker pass.
LINK_POST_LIBS=(
    "$SYSROOT/lib/libc.a"
    -Wl,--no-entry
    -Wl,--export=_start
    -Wl,--import-memory
    -Wl,--shared-memory
    -Wl,--max-memory=1073741824
    -Wl,--allow-undefined
    -Wl,--table-base=3
    -Wl,--export-table
    -Wl,--growable-table
    -Wl,--export=__wasm_init_tls
    -Wl,--export=__tls_base
    -Wl,--export=__tls_size
    -Wl,--export=__tls_align
    -Wl,--export=__stack_pointer
    -Wl,--export=__wasm_thread_init
    -Wl,--export=__abi_version
)

# Fork support comes from wasm-fork-instrument. The tool auto-discovers the
# functions it must instrument via call-graph analysis from the seed imports;
# no onlylist is needed. Both seeds are named, because a program that never
# forks still reaches its unwind through `kernel.kernel_checkpoint`, and
# seeding only the fork boundary leaves such a program with no instrumentation
# at all. See docs/fork-instrumentation.md.
FORK_INSTRUMENT="$REPO_ROOT/scripts/run-wasm-fork-instrument.sh"
FORK_INSTRUMENT_SEEDS=(--checkpoint-entry kernel.kernel_checkpoint)

build_program() {
    local src="$1"
    local out_dir="$2"
    shift 2
    local extra_libs=("$@")
    local name arch=""
    name=$(basename "$src" .c)
    local wasm="$out_dir/${name}.wasm"
    local raw_wasm="$out_dir/${name}.raw.wasm"
    local next_wasm="$out_dir/${name}.next.wasm"

    case "$out_dir" in
        "$OUT_DIR_32") arch=wasm32 ;;
        "$OUT_DIR_64") arch=wasm64 ;;
    esac
    if [ -n "$arch" ] &&
       package_owns_direct_program_path "$arch" "${name}.wasm"; then
        # WHY: this path is a package mirror, not a compiler output directory.
        # Its owning recipe will publish a generation-backed symlink through
        # build-deps when a consumer actually selects the package.
        if [ -L "$wasm" ]; then
            echo "  Keeping $name: package resolver already owns $arch/${name}.wasm"
            return 0
        fi
        if [ -e "$wasm" ]; then
            echo "Error: package-owned resolver mirror is already occupied: $wasm" >&2
            return 1
        fi
        echo "  Skipping $name: package resolver owns $arch/${name}.wasm"
        return 0
    fi

    # Auto-append GL stubs when the source pulls in EGL/GLES headers.
    # Static linking won't pick symbols out of libEGL.a / libGLESv2.a
    # unless the program references them, so this is a no-op for
    # non-GL programs even if the archives are appended.
    if grep -qE '^[[:space:]]*#[[:space:]]*include[[:space:]]*[<"](EGL|GLES[23]?)/' "$src" 2>/dev/null; then
        if [ -f "$SYSROOT/lib/libEGL.a" ] && [ -f "$SYSROOT/lib/libGLESv2.a" ]; then
            extra_libs+=("$SYSROOT/lib/libEGL.a" "$SYSROOT/lib/libGLESv2.a")
        else
            echo "  Skipping $name: GL archives missing — run scripts/build-gles-stubs.sh." >&2
            return 0
        fi
    fi

    echo "  Compiling $name..."
    # WHY: a failed compile or instrumentation pass must not leave a raw or
    # stale-ABI module at the resolver-visible final path.
    rm -f "$wasm" "$raw_wasm" "$next_wasm"
    # Bash 3.2 (macOS system bash) under `set -u` treats expansion of
    # an empty array as unbound; the `${arr[@]+...}` guard suppresses
    # that when extra_libs is empty.
    "$CC" "${CFLAGS[@]}" "$src" \
        "${LINK_PRE_LIBS[@]}" \
        ${extra_libs[@]+"${extra_libs[@]}"} \
        "${LINK_POST_LIBS[@]}" \
        -o "$raw_wasm"

    # Apply fork instrumentation if the program can participate in fork. The
    # tool returns standalone executables without a fork or dynamic-loader
    # boundary byte-for-byte unchanged, so it is safe to run unconditionally.
    # Side modules and loader-capable mains still receive process-image state
    # helpers even when they have no local fork import.
    "$FORK_INSTRUMENT" "${FORK_INSTRUMENT_SEEDS[@]}" "$raw_wasm" -o "$next_wasm"
    mv "$next_wasm" "$wasm"
    rm -f "$raw_wasm"
}

# Build a C++ program via the SDK's wasm32posix-c++ wrapper. The SDK
# injects the toolchain's standard compile + link flags, the channel
# syscall glue, the C++ runtime stubs (cxxrt.c), and the sysroot path.
# The default include search includes the sysroot's libc++ headers so
# no extra -isystem is needed; we only have to supply -lc++ / -lc++abi
# at link time.
build_cpp_program() {
    local src="$1"
    local out_dir="$2"
    local name
    name=$(basename "$src" .cpp)
    local wasm="$out_dir/${name}.wasm"
    local raw_wasm="$out_dir/${name}.raw.wasm"
    local next_wasm="$out_dir/${name}.next.wasm"

    echo "  Compiling $name (C++)..."
    rm -f "$wasm" "$raw_wasm" "$next_wasm"
    # -fwasm-exceptions is required for clang to lower C++ try/catch
    # to wasm-EH `try`/`catch` instructions. Without it clang emits
    # `__cxa_throw; unreachable` and DCEs the catch handlers, so the
    # whole exception-propagation chain (libunwind + libc++abi) never
    # runs.
    wasm32posix-c++ \
        -O2 \
        -fwasm-exceptions \
        "$src" \
        -lc++ -lc++abi \
        -o "$raw_wasm"

    # Preserve a raw no-fork control for issue #918 independently of the
    # normally instrumented fork-bearing program.
    if [ "$name" = "sjlj_noexcept_boundary" ]; then
        mkdir -p "$TEST_FIXTURE_DIR/wasm32"
        wasm32posix-c++ \
            -O2 \
            -fwasm-exceptions \
            -DKANDELO_SJLJ_NO_FORK_ANCHOR \
            "$src" \
            -lc++ -lc++abi \
            -o "$TEST_FIXTURE_DIR/wasm32/${name}.raw.wasm"
    fi

    # Publish the resolver-visible path only after instrumentation and its
    # complete ABI 43 artifact contract succeed.
    "$FORK_INSTRUMENT" "${FORK_INSTRUMENT_SEEDS[@]}" "$raw_wasm" -o "$next_wasm"
    mv "$next_wasm" "$wasm"
    rm -f "$raw_wasm"
}

ensure_libcxx_in_sysroot() {
    local arch="$1"
    local sysroot="$2"
    echo "==> Resolving libcxx for $arch C++ programs..."
    local host_triple
    local libcxx_prefix
    host_triple="$(rustc -vV | awk '/^host/ {print $2}')"
    (cd "$REPO_ROOT" && cargo run -p xtask --target "$host_triple" --quiet -- \
        build-deps --arch "$arch" resolve libcxx >/dev/null)
    libcxx_prefix="$(cd "$REPO_ROOT" && cargo run -p xtask \
        --target "$host_triple" --quiet -- build-deps --arch "$arch" path libcxx)"
    mkdir -p "$sysroot/lib" "$sysroot/include/c++"
    rm -f "$sysroot/lib/libc++.a" "$sysroot/lib/libc++abi.a"
    cp "$libcxx_prefix/lib/libc++.a" "$sysroot/lib/libc++.a"
    cp "$libcxx_prefix/lib/libc++abi.a" "$sysroot/lib/libc++abi.a"
    rm -rf "$sysroot/include/c++/v1"
    cp -RL "$libcxx_prefix/include/c++/v1" "$sysroot/include/c++/v1"
}

# Resolve libcxx and copy its outputs into the sysroot if there are any .cpp
# programs to build. Refresh every run so an interrupted prior copy cannot be
# mistaken for a complete regular-file projection.
if ls "$REPO_ROOT/programs/"*.cpp >/dev/null 2>&1; then
    ensure_libcxx_in_sysroot wasm32 "$SYSROOT"
fi

echo "Building user programs..."
for src in "$REPO_ROOT/programs/"*.c; do
    [ -f "$src" ] || continue
    # Skip hello64.c — built separately with wasm64 toolchain below
    [ "$(basename "$src")" = "hello64.c" ] && continue
    # DRI programs link against the libdrm / libgbm shims
    # (sysroot/lib/libdrm.a, libgbm.a). EGL/GLES2 stubs are picked up
    # by build_program's header-based auto-detection.
    case "$(basename "$src")" in
        login.c|sudo-lite.c)
            # Package recipes own the image artifacts. Keep ordinary local
            # copies only as runtime test fixtures.
            build_program "$src" "$TEST_FIXTURE_DIR/wasm32"
            ;;
        modeset.c|dri-modeset.c|dumb_roundtrip.c)
            build_program "$src" "$OUT_DIR_32" \
                "$SYSROOT/lib/libgbm.a" "$SYSROOT/lib/libdrm.a"
            ;;
        libdrm-kms-smoke.c)
            build_program "$src" "$OUT_DIR_32" \
                "$SYSROOT/lib/libdrm.a"
            ;;
        posix-timer-thread.c)
            # Keep the fixture's pthread capacity small so its timer-helper
            # churn test proves detached helpers are actually reclaimed.
            build_program "$src" "$OUT_DIR_32" \
                -DWASM_POSIX_THREAD_SLOT_DECL=8
            ;;
        *)
            build_program "$src" "$OUT_DIR_32"
            ;;
    esac
done

for src in "$REPO_ROOT/programs/"*.cpp; do
    [ -f "$src" ] || continue
    build_cpp_program "$src" "$OUT_DIR_32"
done

echo "Building example programs..."
for src in "$REPO_ROOT/examples/"*.c; do
    [ -f "$src" ] || continue
    build_program "$src" "$REPO_ROOT/examples"
done

echo "Building benchmark programs..."
BENCH_OUT_DIR="$REPO_ROOT/benchmarks/wasm"
mkdir -p "$BENCH_OUT_DIR"
for src in "$REPO_ROOT/benchmarks/programs/"*.c; do
    [ -f "$src" ] || continue
    build_program "$src" "$BENCH_OUT_DIR"
done

# Build wasm64 programs if sysroot64 exists
SYSROOT64="$REPO_ROOT/sysroot64"
if [ -f "$SYSROOT64/lib/libc.a" ]; then
    echo "Building wasm64 programs..."

    CFLAGS64=(
        --target=wasm64-unknown-unknown
        --sysroot="$SYSROOT64"
        -nostdlib
        -O2
        -matomics -mbulk-memory
        -fno-trapping-math
        -mllvm -wasm-enable-sjlj
        -mllvm -wasm-use-legacy-eh=false
    )

    LINK_FLAGS64=(
        "$GLUE_DIR/channel_syscall.c"
        "$GLUE_DIR/compiler_rt.c"
        "$SYSROOT64/lib/crt1.o"
        "$SYSROOT64/lib/libc.a"
        -Wl,--no-entry
        -Wl,--export=_start
        -Wl,--import-memory
        -Wl,--shared-memory
        -Wl,--max-memory=1073741824
        -Wl,--allow-undefined
        -Wl,--table-base=3
        -Wl,--export-table
        -Wl,--growable-table
        -Wl,--export=__wasm_init_tls
        -Wl,--export=__tls_base
        -Wl,--export=__tls_size
        -Wl,--export=__tls_align
        -Wl,--export=__stack_pointer
        -Wl,--export=__wasm_thread_init
        -Wl,--export=__abi_version
    )

    for src in \
        "$REPO_ROOT/programs/"hello64.c \
        "$REPO_ROOT/programs/"ifhwaddr.c \
        "$REPO_ROOT/programs/"posix-timer-thread.c \
        "$REPO_ROOT/programs/"scm-rights-pipe-lifetime.c \
        "$REPO_ROOT/programs/"scm-rights-semantics.c \
        "$REPO_ROOT/programs/"sched-getaffinity.c; do
        [ -f "$src" ] || continue
        local_name=$(basename "$src" .c)
        echo "  Compiling $local_name (wasm64)..."
        extra_flags=()
        if [ "$local_name" = "posix-timer-thread" ]; then
            extra_flags=(-DWASM_POSIX_THREAD_SLOT_DECL=8)
        fi
        # Keep empty optional flags safe under Bash 3.2 with `set -u`.
        "$CC" "${CFLAGS64[@]}" ${extra_flags[@]+"${extra_flags[@]}"} "$src" "${LINK_FLAGS64[@]}" \
            -o "$OUT_DIR_64/${local_name}.wasm"
    done

    # WHY: owning Vitests can build these on demand, but browser-only and
    # packed CI workspaces cannot depend on a prior test runner leaving ambient
    # artifacts behind. Every browser-owned example comes from the one
    # contract-checked manifest. Their memory64 execution paths do not require
    # fork rewind instrumentation; the wait fixture selects posix_spawn because
    # that instrumentation is currently a wasm32 artifact contract.
    memory64_example_sources="$(browser_memory64_fixture_sources)"
    while IFS= read -r source_rel; do
        source_path="$REPO_ROOT/$source_rel"
        output_path="$REPO_ROOT/${source_rel%.c}.wasm64.wasm"
        echo "  Compiling $(basename "$source_rel" .c) (wasm64)..."
        "$CC" "${CFLAGS64[@]}" "$source_path" "${LINK_FLAGS64[@]}" \
            -o "$output_path"
    done <<< "$memory64_example_sources"

    # Fork continuation instrumentation is currently a wasm32 artifact
    # contract. Still cover the compiler's architecture-independent SjLj /
    # noexcept ordering on wasm64 with a raw fixture that omits the dormant
    # fork anchor. Keep it in the test-only tree for symmetry with wasm32.
    sjlj_noexcept_src="$REPO_ROOT/programs/sjlj_noexcept_boundary.cpp"
    if [ -f "$sjlj_noexcept_src" ]; then
        ensure_libcxx_in_sysroot wasm64 "$SYSROOT64"
        mkdir -p "$TEST_FIXTURE_DIR/wasm64"
        echo "  Compiling sjlj_noexcept_boundary (raw wasm64 test fixture)..."
        wasm64posix-c++ \
            -O2 \
            -fwasm-exceptions \
            -DKANDELO_SJLJ_NO_FORK_ANCHOR \
            "$sjlj_noexcept_src" \
            -lc++ -lc++abi \
            -o "$TEST_FIXTURE_DIR/wasm64/sjlj_noexcept_boundary.raw.wasm"
    fi
fi

echo "Programs built."
