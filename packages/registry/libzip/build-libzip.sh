#!/usr/bin/env bash
# Build libzip from its upstream CMake graph as a reproducible PIC archive.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/kandelo-libzip.XXXXXX")"
cleanup() {
    status=$?
    trap - EXIT
    if [ "${WASM_POSIX_KEEP_BUILD_DIR:-0}" = "1" ]; then
        echo "==> Preserving libzip build directory: $WORK_DIR" >&2
    else
        rm -rf "$WORK_DIR"
    fi
    exit "$status"
}
trap cleanup EXIT

LIBZIP_VERSION="${WASM_POSIX_DEP_VERSION:-${LIBZIP_VERSION:-1.11.4}}"
SOURCE_URL="${WASM_POSIX_DEP_SOURCE_URL:-https://libzip.org/download/libzip-${LIBZIP_VERSION}.tar.gz}"
SOURCE_SHA256="${WASM_POSIX_DEP_SOURCE_SHA256:-82e9f2f2421f9d7c2466bbc3173cd09595a88ea37db0d559a9d0a2dc60dc722e}"
TARGET_ARCH="${WASM_POSIX_DEP_TARGET_ARCH:-wasm32}"
OUT_DIR="${WASM_POSIX_DEP_OUT_DIR:-$SCRIPT_DIR/libzip-install}"
SRC_DIR="$WORK_DIR/source"
BUILD_DIR="$WORK_DIR/build"
STAGE_DIR="$WORK_DIR/stage"

if [ "$TARGET_ARCH" != "wasm32" ]; then
    echo "ERROR: libzip currently supports only wasm32, got $TARGET_ARCH" >&2
    exit 1
fi
if [ -z "$SOURCE_SHA256" ]; then
    echo "ERROR: libzip source sha256 must not be empty" >&2
    exit 1
fi

# Use only the worktree-local Kandelo SDK.
# shellcheck source=/dev/null
source "$REPO_ROOT/sdk/activate.sh"

SYSROOT="${WASM_POSIX_SYSROOT:-$REPO_ROOT/sysroot}"
export WASM_POSIX_SYSROOT="$SYSROOT"
for tool in cmake curl wasm-objdump; do
    if ! command -v "$tool" >/dev/null 2>&1; then
        echo "ERROR: required libzip build tool is unavailable: $tool" >&2
        exit 1
    fi
done
if [ ! -f "$SYSROOT/lib/libc.a" ]; then
    echo "ERROR: wasm32 sysroot not found at $SYSROOT" >&2
    exit 1
fi

# The resolver provides every direct dependency. The fallback keeps an
# intentional direct invocation on the same resolver path.
ZLIB_PREFIX="${WASM_POSIX_DEP_ZLIB_DIR:-}"
if [ -z "$ZLIB_PREFIX" ]; then
    for tool in rustc cargo; do
        if ! command -v "$tool" >/dev/null 2>&1; then
            echo "ERROR: $tool is required when zlib is not resolver-injected" >&2
            exit 1
        fi
    done
    HOST_TARGET="$(rustc -vV | awk '/^host/ {print $2}')"
    echo "==> Resolving zlib for $TARGET_ARCH..."
    ZLIB_PREFIX="$(
        cd "$REPO_ROOT"
        cargo run -p xtask --target "$HOST_TARGET" --quiet -- \
            build-deps --arch "$TARGET_ARCH" resolve zlib
    )"
fi
for required in \
    "$ZLIB_PREFIX/lib/libz.a" \
    "$ZLIB_PREFIX/include/zlib.h" \
    "$ZLIB_PREFIX/include/zconf.h"; do
    if [ ! -f "$required" ]; then
        echo "ERROR: resolved zlib output is missing: $required" >&2
        exit 1
    fi
done

# Resolve host-side package metadata before assigning the exported CC/AR
# variables below. The dev shell exports those names, so assigning them early
# would make Cargo compile its host dependencies with the wasm SDK wrappers.
CC="$(command -v wasm32posix-cc || true)"
AR="$(command -v wasm32posix-ar || true)"
RANLIB="$(command -v wasm32posix-ranlib || true)"
NM="$(command -v wasm32posix-nm || true)"
STRIP="$(command -v wasm32posix-strip || true)"
for tool in "$CC" "$AR" "$RANLIB" "$NM" "$STRIP"; do
    if [ -z "$tool" ] || ! command -v "$tool" >/dev/null 2>&1; then
        echo "ERROR: required libzip SDK tool is unavailable: ${tool:-<empty>}" >&2
        exit 1
    fi
done

echo "==> Downloading libzip $LIBZIP_VERSION..."
TARBALL="$WORK_DIR/libzip.tar.gz"
curl --retry 10 --retry-delay 5 --retry-max-time 300 --retry-all-errors \
    -fsSL "$SOURCE_URL" -o "$TARBALL"
echo "==> Verifying libzip source sha256..."
echo "$SOURCE_SHA256  $TARBALL" | shasum -a 256 -c -
mkdir -p "$SRC_DIR"
tar xzf "$TARBALL" -C "$SRC_DIR" --strip-components=1

# Kandelo's executable linker deliberately permits unresolved host imports.
# That makes CMake's link-based check_function_exists probes report every
# function as present, including host-only memcpy_s/strncpy_s. Seed the
# wasm32+musl platform truth while leaving compile-only header/type probes to
# upstream CMake.
CMAKE_PLATFORM_FACTS=(
    -DHAVE___PROGNAME=OFF
    -DHAVE__CLOSE=OFF
    -DHAVE__DUP=OFF
    -DHAVE__FDOPEN=OFF
    -DHAVE__FILENO=OFF
    -DHAVE__FSEEKI64=OFF
    -DHAVE__FSTAT64=OFF
    -DHAVE__SETMODE=OFF
    -DHAVE__SNPRINTF=OFF
    -DHAVE__SNPRINTF_S=OFF
    -DHAVE__SNWPRINTF_S=OFF
    -DHAVE__STAT64=OFF
    -DHAVE__STRDUP=OFF
    -DHAVE__STRICMP=OFF
    -DHAVE__STRTOI64=OFF
    -DHAVE__STRTOUI64=OFF
    -DHAVE__UNLINK=OFF
    -DHAVE_ARC4RANDOM=OFF
    -DHAVE_CLONEFILE=OFF
    -DHAVE_EXPLICIT_BZERO=ON
    -DHAVE_EXPLICIT_MEMSET=OFF
    -DHAVE_FCHMOD=ON
    -DHAVE_FICLONERANGE=OFF
    -DHAVE_FILENO=ON
    -DHAVE_FSEEKO=ON
    -DHAVE_FTELLO=ON
    -DHAVE_FTS_H=OFF
    -DHAVE_GETPROGNAME=OFF
    -DHAVE_GETSECURITYINFO=OFF
    -DHAVE_LOCALTIME_R=ON
    -DHAVE_LOCALTIME_S=OFF
    -DHAVE_MEMCPY_S=OFF
    -DHAVE_MKSTEMP=ON
    -DHAVE_RANDOM=ON
    -DHAVE_SETMODE=OFF
    -DHAVE_SNPRINTF=ON
    -DHAVE_SNPRINTF_S=OFF
    -DHAVE_STRCASECMP=ON
    -DHAVE_STRDUP=ON
    -DHAVE_STRERROR_S=OFF
    -DHAVE_STRERRORLEN_S=OFF
    -DHAVE_STRICMP=OFF
    -DHAVE_STRNCPY_S=OFF
    -DHAVE_STRTOLL=ON
    -DHAVE_STRTOULL=ON
    -DHAVE_STRUCT_TM_TM_ZONE=ON
    -DHAVE_DIRENT_H=ON
    -DHAVE_NDIR_H=OFF
    -DHAVE_SYS_DIR_H=OFF
    -DHAVE_SYS_NDIR_H=OFF
    -DWORDS_BIGENDIAN=OFF
)

prefix_map_flags() {
    local producer_path="$1"
    local stable_path="$2"
    printf '%s' "-ffile-prefix-map=$producer_path=$stable_path -fdebug-prefix-map=$producer_path=$stable_path -fmacro-prefix-map=$producer_path=$stable_path"
}

REPRODUCIBLE_FLAGS="$(prefix_map_flags "$WORK_DIR" /usr/src/libzip-build)"
REPRODUCIBLE_FLAGS+=" $(prefix_map_flags "$REPO_ROOT" /usr/src/kandelo)"
REPRODUCIBLE_FLAGS+=" $(prefix_map_flags "$ZLIB_PREFIX" /usr/src/kandelo-deps/zlib)"

export LC_ALL=C
export TZ=UTC
export SOURCE_DATE_EPOCH="${SOURCE_DATE_EPOCH:-0}"
export ZERO_AR_DATE=1

echo "==> Configuring libzip from the upstream CMake graph..."
cmake -S "$SRC_DIR" -B "$BUILD_DIR" \
    -DCMAKE_SYSTEM_NAME=Generic \
    -DCMAKE_SYSTEM_PROCESSOR=wasm32 \
    -DCMAKE_C_COMPILER="$CC" \
    -DCMAKE_AR="$AR" \
    -DCMAKE_RANLIB="$RANLIB" \
    -DCMAKE_STRIP="$STRIP" \
    -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_C_FLAGS_RELEASE="-O2 -DNDEBUG -fPIC $REPRODUCIBLE_FLAGS" \
    -DCMAKE_FIND_ROOT_PATH="$SYSROOT;$ZLIB_PREFIX" \
    -DCMAKE_FIND_ROOT_PATH_MODE_PROGRAM=NEVER \
    -DCMAKE_FIND_ROOT_PATH_MODE_LIBRARY=ONLY \
    -DCMAKE_FIND_ROOT_PATH_MODE_INCLUDE=ONLY \
    -DCMAKE_FIND_ROOT_PATH_MODE_PACKAGE=ONLY \
    -DCMAKE_INSTALL_PREFIX="$STAGE_DIR" \
    -DCMAKE_INSTALL_LIBDIR=lib \
    -DCMAKE_INSTALL_INCLUDEDIR=include \
    -DBUILD_SHARED_LIBS=OFF \
    -DBUILD_TOOLS=OFF \
    -DBUILD_REGRESS=OFF \
    -DBUILD_OSSFUZZ=OFF \
    -DBUILD_EXAMPLES=OFF \
    -DBUILD_DOC=OFF \
    -DENABLE_BZIP2=OFF \
    -DENABLE_COMMONCRYPTO=OFF \
    -DENABLE_GNUTLS=OFF \
    -DENABLE_LZMA=OFF \
    -DENABLE_MBEDTLS=OFF \
    -DENABLE_OPENSSL=OFF \
    -DENABLE_WINDOWS_CRYPTO=OFF \
    -DENABLE_ZSTD=OFF \
    -DENABLE_FDOPEN=ON \
    -DZLIB_ROOT="$ZLIB_PREFIX" \
    -DZLIB_INCLUDE_DIR="$ZLIB_PREFIX/include" \
    -DZLIB_LIBRARY="$ZLIB_PREFIX/lib/libz.a" \
    -DZLIB_LINK_LIBRARY_NAME=z \
    "${CMAKE_PLATFORM_FACTS[@]}"

JOBS="$(sysctl -n hw.ncpu 2>/dev/null || nproc)"
echo "==> Building and installing libzip (-j$JOBS)..."
cmake --build "$BUILD_DIR" --target install --parallel "$JOBS"

# Publish only manifest-declared outputs. Upstream also installs CMake package
# metadata; it is intentionally excluded from this resolver package.
mkdir -p "$OUT_DIR/lib/pkgconfig" "$OUT_DIR/include"
cp "$STAGE_DIR/lib/libzip.a" "$OUT_DIR/lib/libzip.a"
cp "$STAGE_DIR/include/zip.h" "$OUT_DIR/include/zip.h"
cp "$STAGE_DIR/include/zipconf.h" "$OUT_DIR/include/zipconf.h"
# The pkg-config variable must remain literal in the generated descriptor.
# shellcheck disable=SC2016
sed \
    -e 's|^prefix=.*|prefix=${pcfiledir}/../..|' \
    -e '/^zipcmp=/d' \
    "$STAGE_DIR/lib/pkgconfig/libzip.pc" \
    > "$OUT_DIR/lib/pkgconfig/libzip.pc"

EXPECTED_OUTPUTS=(
    lib/libzip.a
    include/zip.h
    include/zipconf.h
    lib/pkgconfig/libzip.pc
)
for relative in "${EXPECTED_OUTPUTS[@]}"; do
    if [ ! -s "$OUT_DIR/$relative" ]; then
        echo "ERROR: libzip declared output is missing or empty: $relative" >&2
        exit 1
    fi
done
actual_count="$(find "$OUT_DIR" -type f | wc -l | tr -d ' ')"
if [ "$actual_count" != "${#EXPECTED_OUTPUTS[@]}" ]; then
    echo "ERROR: libzip staged $actual_count files; expected only ${#EXPECTED_OUTPUTS[@]} declared outputs" >&2
    find "$OUT_DIR" -type f -print >&2
    exit 1
fi

symbols="$($NM "$OUT_DIR/lib/libzip.a" 2>/dev/null)"
REQUIRED_LIBZIP_SYMBOLS=(
    zip_open
    zip_file_set_mtime
    zip_file_set_encryption
    zip_libzip_version
    zip_register_progress_callback_with_state
    zip_register_cancel_callback_with_state
    zip_compression_method_supported
)
for required_symbol in "${REQUIRED_LIBZIP_SYMBOLS[@]}"; do
    if ! grep -q " T ${required_symbol}\$" <<<"$symbols"; then
        echo "ERROR: libzip.a does not export $required_symbol" >&2
        exit 1
    fi
done

# Link every archive member into a real Kandelo executable. The SDK compiler
# driver groups linker flags ahead of archive operands, so wrapping libzip.a in
# --whole-archive on this command line would not preserve their relative order.
# Extracting the archive makes every member an explicit linker input instead.
# Disable section GC as well so an unresolved reference in an otherwise-unused
# member cannot disappear before the import audit below.
SMOKE_SOURCE="$WORK_DIR/libzip-smoke.c"
SMOKE_WASM="$WORK_DIR/libzip-smoke.wasm"
SMOKE_MEMBER_DIR="$WORK_DIR/libzip-smoke-members"
cat > "$SMOKE_SOURCE" <<'EOF'
#include <zip.h>

int main(void) {
    int error = 0;
    zip_t *archive = zip_open("/tmp/libzip-smoke.zip", ZIP_CREATE | ZIP_TRUNCATE, &error);
    if (archive == NULL) {
        return error == 0 ? 1 : error;
    }
    return zip_close(archive) == 0 ? 0 : 2;
}
EOF
mkdir -p "$SMOKE_MEMBER_DIR"
(
    cd "$SMOKE_MEMBER_DIR"
    "$AR" x "$OUT_DIR/lib/libzip.a"
)
archive_member_count="$($AR t "$OUT_DIR/lib/libzip.a" | wc -l | tr -d ' ')"
member_objects=()
while IFS= read -r member; do
    member_objects+=("$member")
done < <(find "$SMOKE_MEMBER_DIR" -type f -print | LC_ALL=C sort)
if [ "$archive_member_count" -eq 0 ] ||
   [ "${#member_objects[@]}" -ne "$archive_member_count" ]; then
    echo "ERROR: failed to extract every libzip archive member: archive=$archive_member_count extracted=${#member_objects[@]}" >&2
    exit 1
fi
"$CC" -O2 \
    -I"$OUT_DIR/include" \
    "$SMOKE_SOURCE" \
    -Wl,--no-gc-sections \
    "${member_objects[@]}" \
    "$ZLIB_PREFIX/lib/libz.a" \
    -o "$SMOKE_WASM"

# llvm-nm does not report final WebAssembly imports as undefined symbols.
# Inspect the actual import section and admit only the fixed Kandelo startup
# surface. A parser/count mismatch also fails rather than silently blessing a
# newer wasm-objdump format that this audit did not understand.
import_dump="$(wasm-objdump -x "$SMOKE_WASM")"
declared_import_count="$(
    sed -n 's/^Import\[\([0-9][0-9]*\)\]:$/\1/p' <<<"$import_dump" | head -n 1
)"
wasm_imports="$(
    awk '
        /^Import\[[0-9]+\]:$/ { inside = 1; next }
        inside && /^[[:alpha:]_][[:alnum:]_]*\[/ { exit }
        inside && / <- / { sub(/^.* <- /, ""); print }
    ' <<<"$import_dump"
)"
parsed_import_count="$(
    sed '/^$/d' <<<"$wasm_imports" | wc -l | tr -d ' '
)"
if [ -z "$declared_import_count" ] ||
   [ "$parsed_import_count" -ne "$declared_import_count" ]; then
    echo "ERROR: could not account for every Wasm import: declared=${declared_import_count:-<missing>} parsed=$parsed_import_count" >&2
    exit 1
fi

ALLOWED_WASM_IMPORTS=(
    env.__channel_base
    env.memory
    kernel.kernel_apply_fork_fd_actions
    kernel.kernel_argv_read
    kernel.kernel_checkpoint
    kernel.kernel_clear_fork_exec
    kernel.kernel_environ_count
    kernel.kernel_environ_get
    kernel.kernel_execve
    kernel.kernel_exit
    kernel.kernel_get_argc
    kernel.kernel_get_fork_exec_argc
    kernel.kernel_get_fork_exec_argv
    kernel.kernel_get_fork_exec_path
    kernel.kernel_get_secure_exec
    kernel.kernel_is_fork_child
    kernel.kernel_push_argv
)
unexpected_imports=()
while IFS= read -r wasm_import; do
    [ -n "$wasm_import" ] || continue
    allowed=0
    for candidate in "${ALLOWED_WASM_IMPORTS[@]}"; do
        if [ "$wasm_import" = "$candidate" ]; then
            allowed=1
            break
        fi
    done
    if [ "$allowed" -eq 0 ]; then
        unexpected_imports+=("$wasm_import")
    fi
done <<<"$wasm_imports"
for required_import in env.__channel_base env.memory; do
    if ! grep -Fxq "$required_import" <<<"$wasm_imports"; then
        echo "ERROR: libzip smoke Wasm is missing required import: $required_import" >&2
        exit 1
    fi
done
if [ "${#unexpected_imports[@]}" -ne 0 ]; then
    echo "ERROR: libzip smoke Wasm has unexpected imports:" >&2
    printf '%s\n' "${unexpected_imports[@]}" >&2
    exit 1
fi
echo "==> Validated $archive_member_count libzip members and $declared_import_count Wasm imports"

# The package must be movable between resolver cache roots. Reject producer
# checkout, temporary-build, dependency-cache, and destination paths in every
# declared output.
for forbidden in "$WORK_DIR" "$REPO_ROOT" "$ZLIB_PREFIX" "$OUT_DIR"; do
    if grep -aFq "$forbidden" \
        "$OUT_DIR/lib/libzip.a" \
        "$OUT_DIR/include/zip.h" \
        "$OUT_DIR/include/zipconf.h" \
        "$OUT_DIR/lib/pkgconfig/libzip.pc"; then
        echo "ERROR: libzip output contains producer path: $forbidden" >&2
        exit 1
    fi
done

echo "==> libzip $LIBZIP_VERSION build complete"
shasum -a 256 "$OUT_DIR/lib/libzip.a"
