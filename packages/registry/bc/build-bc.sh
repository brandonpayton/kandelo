#!/usr/bin/env bash
set -euo pipefail

# Build GNU bc 1.07.1 for wasm32-posix-kernel.
#
# Uses the SDK's wasm32posix-configure wrapper for cross-compilation.
# Output: packages/registry/bc/bin/bc.wasm for a direct build, or
# WASM_POSIX_DEP_OUT_DIR for a resolver/Formula build.
#
# bc needs a host-native build first: during compilation, it builds 'fbc'
# (a temporary bc binary) to process libmath.b into libmath.h. Since fbc
# must run on the host, we do a native build first to generate libmath.h,
# then cross-compile with that pre-generated file.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/package-build-roots.sh"
kandelo_package_prepare_build_roots "$SCRIPT_DIR" wasm32
WORK_DIR="$KANDELO_PACKAGE_WORK_DIR"
SRC_DIR="$WORK_DIR/bc-src"
HOST_BUILD_DIR="$WORK_DIR/bc-host-build"
BIN_DIR="$WORK_DIR/bin"
LIBMATH_HEADER="$WORK_DIR/libmath.h"
SYSROOT="$REPO_ROOT/sysroot"
BC_VERSION="${WASM_POSIX_DEP_VERSION:-${BC_VERSION:-1.07.1}}"
SOURCE_URL="${WASM_POSIX_DEP_SOURCE_URL:-https://ftpmirror.gnu.org/gnu/bc/bc-${BC_VERSION}.tar.gz}"
SOURCE_SHA256="${WASM_POSIX_DEP_SOURCE_SHA256:-62adfca89b0a1c0164c2cdca59ca210c1d44c3ffc46daf9931cf4942664cb02a}"
VERIFIED_SOURCE_DIR="${WASM_POSIX_DEP_SOURCE_DIR:-}"
SOURCE_MARKER="$SRC_DIR/.kandelo-bc-source"

# A resolver/Formula caller owns the declared work and output roots. Keep the
# reviewed checkout read-only and suppress the developer-only local mirror.
if [ -n "${WASM_POSIX_DEP_WORK_DIR:-}" ] && [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
    export WASM_POSIX_INSTALL_LOCAL_MIRROR=0
    export WASM_POSIX_INSTALL_FORK_INSTRUMENTATION=auto
fi

# --- Prerequisites ---
if ! command -v wasm32posix-cc &>/dev/null; then
    echo "ERROR: wasm32posix-cc not found. Run 'npm link' in sdk/ first." >&2
    exit 1
fi

if [ ! -f "$SYSROOT/lib/libc.a" ]; then
    echo "ERROR: sysroot not found. Run: bash build.sh && bash scripts/build-musl.sh" >&2
    exit 1
fi

if ! command -v flex &>/dev/null; then
    echo "ERROR: flex not found. Run through scripts/dev-shell.sh." >&2
    exit 1
fi

if ! command -v yacc &>/dev/null && ! command -v bison &>/dev/null; then
    echo "ERROR: yacc/bison not found. Run through scripts/dev-shell.sh." >&2
    exit 1
fi

# Upstream's host-side fix-libmath_h script uses ed after fbc emits the
# generated table. Keep that real upstream generation path and require the
# repository-declared tool instead of silently borrowing one from the host.
if ! command -v python3 &>/dev/null; then
    echo "ERROR: python3 not found. Run through scripts/dev-shell.sh." >&2
    exit 1
fi

export WASM_POSIX_SYSROOT="$SYSROOT"

expected_source_marker="$(printf '%s\n%s\n%s' "$BC_VERSION" "$SOURCE_URL" "$SOURCE_SHA256")"
if [ -d "$SRC_DIR" ] && [ "$(cat "$SOURCE_MARKER" 2>/dev/null || true)" != "$expected_source_marker" ]; then
    rm -rf "$SRC_DIR" "$HOST_BUILD_DIR" "$BIN_DIR" "$LIBMATH_HEADER"
fi
if [ ! -d "$SRC_DIR" ]; then
    echo "==> Staging verified bc $BC_VERSION source..."
    kandelo_package_stage_verified_source bc "$SRC_DIR" "$VERIFIED_SOURCE_DIR" \
        "$SOURCE_URL" "$SOURCE_SHA256" "$WORK_DIR"
    printf '%s\n' "$expected_source_marker" > "$SOURCE_MARKER"
fi

# --- Step 1: Host-native build to generate libmath.h ---
if [ ! -f "$LIBMATH_HEADER" ]; then
    echo "==> Building host-native bc to generate libmath.h..."
    if [ ! -d "$HOST_BUILD_DIR" ]; then
        mkdir -p "$HOST_BUILD_DIR"
        cp -a "$SRC_DIR/." "$HOST_BUILD_DIR/"
    fi
    cd "$HOST_BUILD_DIR"
    if [ ! -f Makefile ]; then
        ./configure --with-readline=no 2>&1 | tail -10
    fi
    # Upstream uses an unversioned host ed to rewrite fbc's generated table.
    # Install the equivalent tracked helper so the build uses the Python
    # version declared by flake.nix and cannot drift with ambient host tools.
    cp "$SCRIPT_DIR/fix-libmath-h.py" "$HOST_BUILD_DIR/bc/fix-libmath_h"
    chmod 0755 "$HOST_BUILD_DIR/bc/fix-libmath_h"
    make -j"$(sysctl -n hw.ncpu 2>/dev/null || nproc)" 2>&1 | tail -10
    cp "$HOST_BUILD_DIR/bc/libmath.h" "$LIBMATH_HEADER"
    echo "==> libmath.h generated"
fi

# --- Step 2: Cross-compile for wasm32 ---
cd "$SRC_DIR"

# --- Configure ---
if [ ! -f Makefile ]; then
    echo "==> Configuring bc for wasm32..."

    # Cross-compilation values
    export ac_cv_func_malloc_0_nonnull=yes
    export ac_cv_func_realloc_0_nonnull=yes
    export ac_cv_func_calloc_0_nonnull=yes
    export ac_cv_func_strerror_r=yes
    export ac_cv_func_strerror_r_char_p=no
    export ac_cv_have_decl_strerror_r=yes

    # Wasm32 type sizes
    export ac_cv_sizeof_long=4
    export ac_cv_sizeof_long_long=8
    export ac_cv_sizeof_unsigned_long=4
    export ac_cv_sizeof_int=4
    export ac_cv_sizeof_size_t=4

    wasm32posix-configure \
        --with-readline=no \
        2>&1 | tail -30

    echo "==> Configure complete."
fi

# Place libmath.h from host build.
cp "$LIBMATH_HEADER" "$SRC_DIR/bc/libmath.h"

# Patch the Makefile to skip fbc/libmath.h regeneration.
# The Makefile rule rebuilds libmath.h via fbc (a host-native binary) from
# libmath.b. Since fbc is cross-compiled to wasm and can't run on the host,
# we replace the rule with a no-op that uses our pre-generated libmath.h.
sed -i.bak '/^libmath\.h:/,/rm -f \.\/fbc/c\
libmath.h: libmath.b\
	@echo "Using pre-generated libmath.h (cross-compilation)"' "$SRC_DIR/bc/Makefile"

# --- Build ---
echo "==> Building bc..."
make -j"$(sysctl -n hw.ncpu 2>/dev/null || nproc)" 2>&1 | tail -30

echo "==> Collecting binary..."
mkdir -p "$BIN_DIR"

if [ -f "$SRC_DIR/bc/bc" ]; then
    cp "$SRC_DIR/bc/bc" "$BIN_DIR/bc.wasm"
    echo "==> Built bc"
    ls -lh "$BIN_DIR/bc.wasm"
else
    echo "ERROR: bc binary not found after build" >&2
    exit 1
fi

echo ""
echo "==> bc built successfully!"
echo "Binary: $BIN_DIR/bc.wasm"

# Apply normal artifact guards and install either to the direct-build mirror or
# to the caller-owned resolver/Formula output root.
source "$REPO_ROOT/scripts/install-local-binary.sh"
install_local_binary bc "$BIN_DIR/bc.wasm"
