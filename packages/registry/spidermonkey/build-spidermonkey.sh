#!/usr/bin/env bash
# Build Mozilla SpiderMonkey's JS shell for the Kandelo wasm32 POSIX target.
#
# It produces `js.wasm` plus `node.wasm`, a Node-compatible shell entry point
# that runs the Kandelo CommonJS bootstrap when invoked as node.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
# shellcheck source=/dev/null
source "$REPO_ROOT/sdk/activate.sh"
# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/package-build-roots.sh"

VERSION="${WASM_POSIX_DEP_VERSION:-$(tr -d '[:space:]' < "$SCRIPT_DIR/VERSION")}"
SOURCE_URL="${WASM_POSIX_DEP_SOURCE_URL:-https://ftp.mozilla.org/pub/firefox/releases/$VERSION/source/firefox-$VERSION.source.tar.xz}"
SOURCE_SHA256="${WASM_POSIX_DEP_SOURCE_SHA256:-}"
ARCH="${WASM_POSIX_DEP_TARGET_ARCH:-wasm32}"

if [ "$ARCH" != "wasm32" ]; then
    echo "ERROR: SpiderMonkey package currently supports wasm32 only, got '$ARCH'." >&2
    exit 1
fi

RESOLVER_BUILD=0
if [ -n "${WASM_POSIX_DEP_WORK_DIR:-}" ]; then
    RESOLVER_BUILD=1
fi
SYSROOT="${WASM_POSIX_SYSROOT:-$REPO_ROOT/sysroot}"
if [ -n "${WASM_POSIX_DEP_WORK_DIR:-}" ]; then
    WORK_DIR="$WASM_POSIX_DEP_WORK_DIR"
    BIN_DIR="$WORK_DIR/bin"
    DOWNLOAD_DIR="$WORK_DIR/downloads"
    SRC_PARENT="$WORK_DIR/source"
    OBJ_DIR="$WORK_DIR/obj-wasm32"
    MOZCONFIG_PATH="$WORK_DIR/mozconfig-wasm32"
    MOZBUILD_STATE_PATH="$WORK_DIR/.mozbuild"
else
    BIN_DIR="$SCRIPT_DIR/bin"
    DOWNLOAD_DIR="$SCRIPT_DIR/downloads"
    SRC_PARENT="$SCRIPT_DIR/source"
    OBJ_DIR="$SCRIPT_DIR/obj-wasm32"
    MOZCONFIG_PATH="$SCRIPT_DIR/mozconfig-wasm32"
    MOZBUILD_STATE_PATH="$SCRIPT_DIR/.mozbuild"
fi
SRC_DIR="${SPIDERMONKEY_SRC_DIR:-${WASM_POSIX_DEP_SOURCE_DIR:-}}"
if [ "${WASM_POSIX_RESOLUTION_POLICY:-}" = "source-only-v1" ]; then
    if [ -z "${WASM_POSIX_DEP_SOURCE_DIR:-}" ]; then
        echo "ERROR: SpiderMonkey SourceOnly resolver source is empty" >&2
        exit 2
    fi
    if [ -z "${WASM_POSIX_DEP_SOURCE_ARCHIVE:-}" ]; then
        echo "ERROR: SpiderMonkey SourceOnly resolver archive is empty" >&2
        exit 2
    fi
    if [ ! -f "$WASM_POSIX_DEP_SOURCE_DIR/mach" ]; then
        echo "ERROR: Formula-owned SpiderMonkey source has no mach entry point: $WASM_POSIX_DEP_SOURCE_DIR" >&2
        exit 2
    fi
    VERIFIED_SRC_DIR="$WASM_POSIX_DEP_SOURCE_DIR"
    SRC_DIR="$WORK_DIR/spidermonkey-source"
    echo "==> Staging verified SpiderMonkey source into the build work root..."
    kandelo_package_stage_verified_source spidermonkey "$SRC_DIR" \
        "$VERIFIED_SRC_DIR" "$SOURCE_URL" "$SOURCE_SHA256" "$WORK_DIR"
fi
HOST_OS="$(uname -s)"
MACOS_SDK_DIR="${WASM_POSIX_MACOS_SDK_DIR:-}"

if [ "$HOST_OS" = "Darwin" ] && [ -z "$MACOS_SDK_DIR" ] && command -v xcrun >/dev/null 2>&1; then
    SYSTEM_DEVELOPER_DIR="/Applications/Xcode.app/Contents/Developer"
    if [ -d "$SYSTEM_DEVELOPER_DIR" ]; then
        MACOS_SDK_DIR="$(DEVELOPER_DIR="$SYSTEM_DEVELOPER_DIR" xcrun --sdk macosx --show-sdk-path 2>/dev/null || true)"
        if [ -n "$MACOS_SDK_DIR" ]; then
            export DEVELOPER_DIR="$SYSTEM_DEVELOPER_DIR"
            export SDKROOT="$MACOS_SDK_DIR"
        fi
    else
        MACOS_SDK_DIR="$(xcrun --sdk macosx --show-sdk-path 2>/dev/null || true)"
    fi
fi

if [ -n "$MACOS_SDK_DIR" ] && [ ! -d "$MACOS_SDK_DIR" ]; then
    echo "ERROR: macOS SDK not found at $MACOS_SDK_DIR." >&2
    exit 1
fi

if [ ! -f "$SYSROOT/lib/libc.a" ]; then
    echo "ERROR: sysroot not found at $SYSROOT. Run 'bash build.sh' first." >&2
    exit 1
fi

for required_tool in python3 rustc cargo cbindgen node curl make; do
    if ! command -v "$required_tool" >/dev/null 2>&1; then
        echo "ERROR: required host tool '$required_tool' not found in PATH." >&2
        exit 1
    fi
done

HOST_TARGET="$(rustc -vV | awk '/^host/ {print $2}')"
resolve_dep() {
    local name="$1"
    (cd "$REPO_ROOT" && cargo run -p xtask --target "$HOST_TARGET" --quiet -- build-deps resolve "$name")
}

LIBCXX_PREFIX="${WASM_POSIX_DEP_LIBCXX_DIR:-}"
if [ -z "$LIBCXX_PREFIX" ]; then
    echo "==> Resolving libcxx via cargo xtask build-deps..."
    LIBCXX_PREFIX="$(resolve_dep libcxx)"
fi
[ -f "$LIBCXX_PREFIX/lib/libc++.a" ] || {
    echo "ERROR: libcxx resolve missing libc++.a at $LIBCXX_PREFIX" >&2
    exit 1
}
[ -f "$LIBCXX_PREFIX/lib/libc++abi.a" ] || {
    echo "ERROR: libcxx resolve missing libc++abi.a at $LIBCXX_PREFIX" >&2
    exit 1
}
[ -d "$LIBCXX_PREFIX/include/c++/v1" ] || {
    echo "ERROR: libcxx resolve missing include/c++/v1 at $LIBCXX_PREFIX" >&2
    exit 1
}

OPENSSL_PREFIX="${WASM_POSIX_DEP_OPENSSL_DIR:-}"
if [ -z "$OPENSSL_PREFIX" ]; then
    echo "==> Resolving openssl via cargo xtask build-deps..."
    OPENSSL_PREFIX="$(resolve_dep openssl)"
fi
[ -f "$OPENSSL_PREFIX/lib/libssl.a" ] || {
    echo "ERROR: openssl resolve missing libssl.a at $OPENSSL_PREFIX" >&2
    exit 1
}
[ -f "$OPENSSL_PREFIX/lib/libcrypto.a" ] || {
    echo "ERROR: openssl resolve missing libcrypto.a at $OPENSSL_PREFIX" >&2
    exit 1
}
[ -d "$OPENSSL_PREFIX/include" ] || {
    echo "ERROR: openssl resolve missing include directory at $OPENSSL_PREFIX" >&2
    exit 1
}

ZLIB_PREFIX="${WASM_POSIX_DEP_ZLIB_DIR:-}"
if [ -z "$ZLIB_PREFIX" ]; then
    echo "==> Resolving zlib via cargo xtask build-deps..."
    ZLIB_PREFIX="$(resolve_dep zlib)"
fi
[ -f "$ZLIB_PREFIX/lib/libz.a" ] || {
    echo "ERROR: zlib resolve missing libz.a at $ZLIB_PREFIX" >&2
    exit 1
}
[ -d "$ZLIB_PREFIX/include" ] || {
    echo "ERROR: zlib resolve missing include directory at $ZLIB_PREFIX" >&2
    exit 1
}

ZSTD_PREFIX="${WASM_POSIX_DEP_LIBZSTD_DIR:-}"
if [ -z "$ZSTD_PREFIX" ]; then
    echo "==> Resolving libzstd via cargo xtask build-deps..."
    ZSTD_PREFIX="$(resolve_dep libzstd)"
fi
[ -f "$ZSTD_PREFIX/lib/libzstd.a" ] || {
    echo "ERROR: libzstd resolve missing libzstd.a at $ZSTD_PREFIX" >&2
    exit 1
}
[ -d "$ZSTD_PREFIX/include" ] || {
    echo "ERROR: libzstd resolve missing include directory at $ZSTD_PREFIX" >&2
    exit 1
}
export WASM_POSIX_DEP_LIBZSTD_DIR="$ZSTD_PREFIX"

if [ "$RESOLVER_BUILD" -eq 1 ]; then
    export WASM_POSIX_DEP_WORK_DIR="$WORK_DIR"
    export WASM_POSIX_DEP_LIBCXX_DIR="$LIBCXX_PREFIX"
    export WASM_POSIX_DEP_OPENSSL_DIR="$OPENSSL_PREFIX"
    export WASM_POSIX_DEP_ZLIB_DIR="$ZLIB_PREFIX"
    export WASM_POSIX_DEP_LIBZSTD_DIR="$ZSTD_PREFIX"
    SYSROOT="$(
        kandelo_package_prepare_private_sysroot spidermonkey "$SYSROOT" \
            libcxx openssl zlib libzstd
    )"
    export WASM_POSIX_SYSROOT="$SYSROOT"
fi

# Mozilla's build uses the compiler driver directly and expects libc++ to be
# visible from the target sysroot. Keep the sysroot as an index of cache-managed
# libcxx artifacts, matching the MariaDB and C++ program build paths.
mkdir -p "$SYSROOT/lib" "$SYSROOT/include/c++"
ln -sf "$LIBCXX_PREFIX/lib/libc++.a" "$SYSROOT/lib/libc++.a"
ln -sf "$LIBCXX_PREFIX/lib/libc++abi.a" "$SYSROOT/lib/libc++abi.a"
ln -sf "$OPENSSL_PREFIX/lib/libssl.a" "$SYSROOT/lib/libssl.a"
ln -sf "$OPENSSL_PREFIX/lib/libcrypto.a" "$SYSROOT/lib/libcrypto.a"
ln -sf "$ZLIB_PREFIX/lib/libz.a" "$SYSROOT/lib/libz.a"
ln -sf "$ZSTD_PREFIX/lib/libzstd.a" "$SYSROOT/lib/libzstd.a"
rm -rf "$SYSROOT/include/c++/v1"
ln -sfn "$LIBCXX_PREFIX/include/c++/v1" "$SYSROOT/include/c++/v1"

mkdir -p "$BIN_DIR" "$DOWNLOAD_DIR" "$SRC_PARENT"

find_mach_dir() {
    local mach_path
    mach_path="$(find "$SRC_PARENT" -mindepth 1 -maxdepth 3 -type f -name mach -print -quit)"
    if [ -n "$mach_path" ]; then
        dirname "$mach_path"
    fi
}

if [ "${WASM_POSIX_RESOLUTION_POLICY:-}" != "source-only-v1" ]; then
    if [ -n "${WASM_POSIX_DEP_SOURCE_DIR:-}" ] && [ ! -f "$SRC_DIR/mach" ]; then
        echo "ERROR: Formula-owned SpiderMonkey source has no mach entry point: $SRC_DIR" >&2
        exit 1
    fi
    if [ -z "$SRC_DIR" ] || [ ! -f "$SRC_DIR/mach" ]; then
        SRC_DIR="$(find_mach_dir || true)"
    fi

    if [ -z "$SRC_DIR" ] || [ ! -f "$SRC_DIR/mach" ]; then
        archive="$DOWNLOAD_DIR/firefox-$VERSION.source.tar.xz"
        if [ ! -f "$archive" ]; then
            echo "==> Downloading Firefox ESR $VERSION source..."
            curl -fL "$SOURCE_URL" -o "$archive"
        fi
        if [ -n "$SOURCE_SHA256" ]; then
            actual_sha="$(python3 - "$archive" <<'PY'
import hashlib
import sys

h = hashlib.sha256()
with open(sys.argv[1], "rb") as f:
    for chunk in iter(lambda: f.read(1024 * 1024), b""):
        h.update(chunk)
print(h.hexdigest())
PY
)"
            if [ "$actual_sha" != "$SOURCE_SHA256" ]; then
                echo "ERROR: source SHA256 mismatch for $archive" >&2
                echo "  expected: $SOURCE_SHA256" >&2
                echo "  actual:   $actual_sha" >&2
                exit 1
            fi
        fi

        echo "==> Extracting Firefox ESR $VERSION source..."
        rm -rf "$SRC_PARENT"
        mkdir -p "$SRC_PARENT"
        python3 - "$archive" "$SRC_PARENT" <<'PY'
from pathlib import Path
import os
import sys
import tarfile

archive = sys.argv[1]
dest = Path(sys.argv[2]).resolve()
with tarfile.open(archive, "r:xz") as tf:
    for member in tf.getmembers():
        target = (dest / member.name).resolve()
        if os.path.commonpath([str(dest), str(target)]) != str(dest):
            raise SystemExit(f"archive member escapes destination: {member.name}")
    tf.extractall(dest)
PY
        SRC_DIR="$(find_mach_dir || true)"
    fi
fi

if [ -z "$SRC_DIR" ] || [ ! -f "$SRC_DIR/mach" ]; then
    echo "ERROR: could not locate Mozilla source root with mach under $SRC_PARENT." >&2
    exit 1
fi

PATCH_DIR="$SCRIPT_DIR/patches"
if [ -d "$PATCH_DIR" ]; then
    for patch_file in "$PATCH_DIR"/*.patch; do
        [ -f "$patch_file" ] || continue
        patch_name="$(basename "$patch_file")"
        if patch -p1 -N --dry-run --silent -d "$SRC_DIR" < "$patch_file" >/dev/null 2>&1; then
            echo "==> Applying $patch_name..."
            patch -p1 -N -d "$SRC_DIR" < "$patch_file"
        elif patch -p1 -R --dry-run --silent -d "$SRC_DIR" < "$patch_file" >/dev/null 2>&1; then
            # Reverse-applies cleanly: this patch is already present in the
            # source tree (e.g. a re-run against a previously patched
            # checkout). Nothing to do.
            echo "==> $patch_name already applied, skipping."
        else
            # Neither a forward nor a reverse dry-run succeeded: the patch
            # does not cleanly apply to this source tree at all. Silently
            # continuing here would ship a build missing a platform fix
            # (e.g. 0015/0016/0017) with no signal that it was dropped.
            echo "ERROR: patch $patch_name does not apply to $SRC_DIR (source may have drifted from what the patch expects). Update the patch or the pinned source version." >&2
            exit 1
        fi
    done
fi

NODE_ADAPTER_JS="$SCRIPT_DIR/node-compat/adapter.js"
NODE_SHARED_BOOTSTRAP_JS="$REPO_ROOT/packages/registry/node-compat/bootstrap.js"
NODE_SUFFIX_JS="$SCRIPT_DIR/node-compat/suffix.js"
NODE_BOOTSTRAP_JS="$OBJ_DIR/kandelo-node-bootstrap.generated.js"
NODE_BOOTSTRAP_INC="$SRC_DIR/js/src/shell/kandelo-node-bootstrap.h"
for bootstrap_part in "$NODE_ADAPTER_JS" "$NODE_SHARED_BOOTSTRAP_JS" "$NODE_SUFFIX_JS"; do
    [ -f "$bootstrap_part" ] || {
        echo "ERROR: SpiderMonkey Node bootstrap input missing at $bootstrap_part" >&2
        exit 1
    }
done
mkdir -p "$OBJ_DIR"
echo "==> Generating SpiderMonkey Node bootstrap include..."
python3 - "$NODE_ADAPTER_JS" "$NODE_SHARED_BOOTSTRAP_JS" "$NODE_SUFFIX_JS" "$NODE_BOOTSTRAP_JS" "$NODE_BOOTSTRAP_INC" <<'PY'
from pathlib import Path
import sys

adapter = Path(sys.argv[1]).read_text(encoding="utf-8")
shared = Path(sys.argv[2]).read_text(encoding="utf-8")
suffix = Path(sys.argv[3]).read_text(encoding="utf-8")
generated = Path(sys.argv[4])
dest = Path(sys.argv[5])

shared_lines = [
    line for line in shared.splitlines()
    if not line.startswith("import * as ")
]
source_text = adapter.rstrip() + "\n" + "\n".join(shared_lines) + "\n" + suffix.rstrip() + "\n"
generated.write_text(source_text, encoding="utf-8")
source = source_text.encode("utf-8")
dest.parent.mkdir(parents=True, exist_ok=True)
with dest.open("w", encoding="ascii") as f:
    f.write("#ifndef shell_kandelo_node_bootstrap_h\n")
    f.write("#define shell_kandelo_node_bootstrap_h\n\n")
    f.write("static const unsigned char kKandeloNodeBootstrap[] = {\n")
    for i in range(0, len(source), 12):
        chunk = source[i:i + 12]
        f.write("  " + ", ".join(f"0x{b:02x}" for b in chunk) + ",\n")
    f.write("};\n")
    f.write("static const size_t kKandeloNodeBootstrapLen = sizeof(kKandeloNodeBootstrap);\n")
    f.write("\n#endif  // shell_kandelo_node_bootstrap_h\n")
PY

WASM_RUST_TARGET_FEATURES='-Ctarget-feature=+atomics,+bulk-memory,+mutable-globals'
GETRANDOM_BACKEND_RUSTFLAG='--cfg=getrandom_backend=\"custom\"'
WASM_RUSTFLAGS="$WASM_RUST_TARGET_FEATURES $GETRANDOM_BACKEND_RUSTFLAG"

cat > "$MOZCONFIG_PATH" <<EOF
export RUSTFLAGS="\${RUSTFLAGS:+\$RUSTFLAGS }$WASM_RUSTFLAGS"
ac_add_options --enable-project=js
ac_add_options --target=wasm32-unknown-linux-musl
ac_add_options --disable-debug
ac_add_options --enable-optimize="-O2"
ac_add_options --disable-jit
ac_add_options --disable-jemalloc
ac_add_options --disable-stdcxx-compat
ac_add_options --without-system-zlib
ac_add_options --with-intl-api
ac_add_options --enable-icu4x
ac_add_options --disable-shared-js
ac_add_options --enable-shared-memory
ac_add_options --enable-explicit-resource-management
ac_add_options --disable-clang-plugin
ac_add_options --disable-tests
ac_add_options --disable-debug-symbols
mk_add_options MOZ_OBJDIR=$OBJ_DIR
EOF
if [ -n "$MACOS_SDK_DIR" ]; then
    echo "ac_add_options --with-macos-sdk=$MACOS_SDK_DIR" >> "$MOZCONFIG_PATH"
fi

export MOZCONFIG="$MOZCONFIG_PATH"
export MOZBUILD_STATE_PATH
export MACH_BUILD_PYTHON_NATIVE_PACKAGE_SOURCE=system

TARGET_OS_DEFINES="${WASM_POSIX_TARGET_OS_DEFINES:--D__linux__=1 -D__unix__=1}"
export CC="${WASM_POSIX_TARGET_CC:-wasm32posix-cc} $TARGET_OS_DEFINES"
export CXX="${WASM_POSIX_TARGET_CXX:-wasm32posix-c++} $TARGET_OS_DEFINES"
export AS="${WASM_POSIX_TARGET_AS:-wasm32posix-cc} $TARGET_OS_DEFINES"
export AR="${WASM_POSIX_TARGET_AR:-wasm32posix-ar}"
export RANLIB="${WASM_POSIX_TARGET_RANLIB:-wasm32posix-ranlib}"
export NM="${WASM_POSIX_TARGET_NM:-wasm32posix-nm}"
export STRIP="${WASM_POSIX_TARGET_STRIP:-wasm32posix-strip}"
if [ "$HOST_OS" = "Darwin" ]; then
    export HOST_CC="${HOST_CC:-/usr/bin/cc}"
    export HOST_CXX="${HOST_CXX:-/usr/bin/c++}"
else
    export HOST_CC="${HOST_CC:-cc}"
    export HOST_CXX="${HOST_CXX:-c++}"
fi
export CFLAGS="${CFLAGS:-} -D_GNU_SOURCE -I$OPENSSL_PREFIX/include -I$ZLIB_PREFIX/include -I$ZSTD_PREFIX/include"
export CXXFLAGS="${CXXFLAGS:-} -D_GNU_SOURCE -fexceptions -I$OPENSSL_PREFIX/include -I$ZLIB_PREFIX/include -I$ZSTD_PREFIX/include"
export LDFLAGS="${LDFLAGS:-} -lc++ -lc++abi $OPENSSL_PREFIX/lib/libssl.a $OPENSSL_PREFIX/lib/libcrypto.a $ZLIB_PREFIX/lib/libz.a $ZSTD_PREFIX/lib/libzstd.a -Wl,-z,stack-size=16777216"

if [ -f "$OBJ_DIR/config.status" ] && {
    ! grep -q 'getrandom_backend' "$OBJ_DIR/config.status" ||
        grep -q 'getrandom_backend=custom' "$OBJ_DIR/config.status" ||
        ! grep -q 'target-feature=+atomics' "$OBJ_DIR/config.status"
}; then
    echo "==> Refreshing stale Mozilla configure state for Rust target flags..."
    rm -f "$OBJ_DIR/config.status" "$OBJ_DIR/.mozconfig.json"
fi

RUST_RELEASE_DIR="$OBJ_DIR/wasm32-unknown-unknown/release"
JSRUST_FINGERPRINT="$(
    find "$RUST_RELEASE_DIR/.fingerprint" -path '*/lib-jsrust.json' -type f -print -quit 2>/dev/null || true
)"
if [ -n "$JSRUST_FINGERPRINT" ] && ! grep -q 'target-feature=+atomics' "$JSRUST_FINGERPRINT"; then
    echo "==> Rebuilding stale SpiderMonkey Rust archive for wasm atomics..."
    rm -f "$RUST_RELEASE_DIR/libjsrust.a"
    rm -rf "$RUST_RELEASE_DIR/.fingerprint"/jsrust-*
fi

echo "==> Building SpiderMonkey JS shell for wasm32..."
(cd "$SRC_DIR" && ./mach --no-interactive build)

JS_BIN=""
for candidate in "$OBJ_DIR/dist/bin/js" "$OBJ_DIR/dist/bin/js.wasm"; do
    if [ -f "$candidate" ]; then
        JS_BIN="$candidate"
        break
    fi
done

if [ -z "$JS_BIN" ]; then
    echo "ERROR: SpiderMonkey build finished but no js shell was found under $OBJ_DIR/dist/bin." >&2
    exit 1
fi

cp "$JS_BIN" "$BIN_DIR/js.wasm"

WASM_OPT="${WASM_OPT:-wasm-opt}"
if command -v "$WASM_OPT" >/dev/null 2>&1; then
    echo "==> Optimizing js.wasm with wasm-opt -O2..."
    "$WASM_OPT" -O2 "$BIN_DIR/js.wasm" -o "$BIN_DIR/js.wasm"
else
    echo "WARNING: wasm-opt not found; leaving unoptimized js.wasm." >&2
fi

FORK_INSTRUMENT="$REPO_ROOT/scripts/run-wasm-fork-instrument.sh"
echo "==> Applying fork instrumentation to js.wasm..."
"$FORK_INSTRUMENT" "$BIN_DIR/js.wasm" -o "$BIN_DIR/js.wasm.instr"
mv "$BIN_DIR/js.wasm.instr" "$BIN_DIR/js.wasm"

JS_SIZE="$(wc -c < "$BIN_DIR/js.wasm" | tr -d ' ')"
echo "==> SpiderMonkey built successfully: $BIN_DIR/js.wasm ($JS_SIZE bytes)"

cp "$BIN_DIR/js.wasm" "$BIN_DIR/node.wasm"
NODE_SIZE="$(wc -c < "$BIN_DIR/node.wasm" | tr -d ' ')"
echo "==> SpiderMonkey Node-compatible runtime staged: $BIN_DIR/node.wasm ($NODE_SIZE bytes)"

# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/install-local-binary.sh"
if [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
    WASM_POSIX_INSTALL_LOCAL_MIRROR=0 \
        WASM_POSIX_INSTALL_FORK_INSTRUMENTATION=auto \
        install_local_binary spidermonkey "$BIN_DIR/js.wasm" js.wasm
    WASM_POSIX_INSTALL_LOCAL_MIRROR=0 \
        WASM_POSIX_INSTALL_FORK_INSTRUMENTATION=auto \
        install_local_binary spidermonkey-node "$BIN_DIR/node.wasm" node.wasm
else
    WASM_POSIX_INSTALL_FORK_INSTRUMENTATION=auto \
        install_local_binary spidermonkey "$BIN_DIR/js.wasm" js.wasm
    WASM_POSIX_INSTALL_FORK_INSTRUMENTATION=auto \
        install_local_binary spidermonkey-node "$BIN_DIR/node.wasm" node.wasm
    WASM_POSIX_INSTALL_FORK_INSTRUMENTATION=auto \
        install_local_binary node "$BIN_DIR/node.wasm" node.wasm
fi
