#!/usr/bin/env bash
set -euo pipefail

# Build Kandelo's compact POSIX utility set for wasm32-posix-kernel.
# Output: packages/registry/posix-utils-lite/bin/<utility>.wasm

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/package-build-roots.sh"
kandelo_package_prepare_build_roots "$SCRIPT_DIR" wasm32
kandelo_package_select_source_root "$REPO_ROOT"
SOURCE_ROOT="$KANDELO_PACKAGE_SOURCE_ROOT"
SRC="$SOURCE_ROOT/packages/registry/posix-utils-lite/src/posix-utils-lite.c"
WORK_DIR="$KANDELO_PACKAGE_WORK_DIR"
BIN_DIR="$WORK_DIR/bin"
SYSROOT="$REPO_ROOT/sysroot"

if [ ! -f "$SRC" ] || [ -L "$SRC" ]; then
  echo "ERROR: posix-utils-lite source must be a regular file: $SRC" >&2
  exit 1
fi

# Keep direct and resolver-driven builds pinned to this worktree's SDK.
source "$REPO_ROOT/sdk/activate.sh"

UTILITIES=(
  ar asa cal cflow compress ctags cxref ed ex fuser gencat getconf gettext
  iconv ipcrm ipcs lex locale logger man more msgfmt ngettext nm patch pax
  pgrep ps renice strings strip uncompress uudecode uuencode what xgettext
  yacc
)

if ! command -v wasm32posix-cc &>/dev/null; then
    echo "ERROR: wasm32posix-cc not found. Run 'npm link' in sdk/ first." >&2
    exit 1
fi

if [ ! -f "$SYSROOT/lib/libc.a" ]; then
    echo "ERROR: sysroot not found. Run: bash build.sh && bash scripts/build-musl.sh" >&2
    exit 1
fi

export WASM_POSIX_SYSROOT="$SYSROOT"

mkdir -p "$BIN_DIR"

# A resolver/Formula caller owns the declared work and output roots. Keep the
# reviewed checkout read-only and suppress the developer-only local mirror.
if [ -n "${WASM_POSIX_DEP_WORK_DIR:-}" ] && [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
  export WASM_POSIX_INSTALL_LOCAL_MIRROR=0
  export WASM_POSIX_INSTALL_FORK_INSTRUMENTATION=auto
fi

echo "==> Building posix-utils-lite multicall binary..."
wasm32posix-cc \
    -std=c11 \
    -D_POSIX_C_SOURCE=200809L \
    -O2 \
    -Wall \
    -Wextra \
    -Wno-unused-parameter \
    "$SRC" \
    -o "$BIN_DIR/posix-utils-lite.wasm"

for utility in "${UTILITIES[@]}"; do
    cp "$BIN_DIR/posix-utils-lite.wasm" "$BIN_DIR/$utility.wasm"
done

echo "==> posix-utils-lite built successfully."

source "$REPO_ROOT/scripts/install-local-binary.sh"
for utility in "${UTILITIES[@]}"; do
    install_local_binary posix-utils-lite "$BIN_DIR/$utility.wasm"
done
