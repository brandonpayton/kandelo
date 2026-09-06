#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/package-build-roots.sh"
kandelo_package_prepare_build_roots "$SCRIPT_DIR" wasm32
kandelo_package_select_source_root "$REPO_ROOT"

SOURCE="$KANDELO_PACKAGE_SOURCE_ROOT/programs/sudo-lite.c"
OUTPUT="$KANDELO_PACKAGE_WORK_DIR/sudo-lite.wasm"
if [ ! -f "$SOURCE" ] || [ -L "$SOURCE" ]; then
    echo "ERROR: sudo-lite source must be a regular file: $SOURCE" >&2
    exit 1
fi

if [ -n "${WASM_POSIX_DEP_WORK_DIR:-}" ] &&
   [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
    export WASM_POSIX_INSTALL_LOCAL_MIRROR=0
    export WASM_POSIX_INSTALL_FORK_INSTRUMENTATION=auto
fi

source "$REPO_ROOT/sdk/activate.sh"
export WASM_POSIX_SYSROOT="$REPO_ROOT/sysroot"
wasm32posix-cc -std=c11 -O2 -Wall -Wextra "$SOURCE" -lcrypt -o "$OUTPUT"

source "$REPO_ROOT/scripts/install-local-binary.sh"
install_local_binary sudo-lite "$OUTPUT" sudo-lite.wasm
