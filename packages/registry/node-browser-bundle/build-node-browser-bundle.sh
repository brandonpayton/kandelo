#!/usr/bin/env bash
#
# Build the browser lazy-archive bundle for Node.js. Reshapes the node
# package's node.wasm plus npm (this package's [source]) into a root-relative
# node.zip (bin/node + bin/npm + bin/npx + local/lib/npm/…). Consumers see the
# bare zip at programs/wasm32/node.zip.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
OUT_DIR="${WASM_POSIX_DEP_OUT_DIR:-}"
WORK_DIR="${WASM_POSIX_DEP_WORK_DIR:-}"
NODE_DIR="${WASM_POSIX_DEP_NODE_DIR:-}"
SOURCE_DIR="${WASM_POSIX_DEP_SOURCE_DIR:-}"
SOURCE_URL="${WASM_POSIX_DEP_SOURCE_URL:-}"
SOURCE_SHA256="${WASM_POSIX_DEP_SOURCE_SHA256:-}"
TARGET_ARCH="${WASM_POSIX_DEP_TARGET_ARCH:-}"

fail() { echo "build-node-browser-bundle: $*" >&2; exit 2; }

require_real_directory() {
    local label="$1" path="$2"
    case "$path" in /*) ;; *) fail "$label must be an absolute resolver-owned directory: $path" ;; esac
    if [ ! -d "$path" ] || [ -L "$path" ]; then fail "$label must be a real directory: $path"; fi
}

[ "$TARGET_ARCH" = wasm32 ] || fail "browser bundle supports only wasm32"
require_real_directory WASM_POSIX_DEP_OUT_DIR "$OUT_DIR"
require_real_directory WASM_POSIX_DEP_WORK_DIR "$WORK_DIR"
require_real_directory WASM_POSIX_DEP_NODE_DIR "$NODE_DIR"

# The source-only resolver hands the verified npm dist as
# WASM_POSIX_DEP_SOURCE_DIR; the default-policy resolver hands only the
# declared URL and sha256 and the recipe acquires its own source.
if [ -z "$SOURCE_DIR" ]; then
    [ -n "$SOURCE_URL" ] && [ -n "$SOURCE_SHA256" ] \
        || fail "WASM_POSIX_DEP_SOURCE_DIR or WASM_POSIX_DEP_SOURCE_URL and WASM_POSIX_DEP_SOURCE_SHA256 are required"
    tarball="$WORK_DIR/npm-dist.tgz"
    curl --retry 10 --retry-delay 5 --retry-max-time 300 \
        -fsSL "$SOURCE_URL" -o "$tarball"
    echo "$SOURCE_SHA256  $tarball" | shasum -a 256 -c -
    SOURCE_DIR="$WORK_DIR/npm-dist"
    rm -rf "$SOURCE_DIR"
    mkdir -p "$SOURCE_DIR"
    tar xzf "$tarball" -C "$SOURCE_DIR" --strip-components=1
fi
require_real_directory WASM_POSIX_DEP_SOURCE_DIR "$SOURCE_DIR"

node_wasm="$NODE_DIR/node.wasm"
[ -f "$node_wasm" ] || fail "node.wasm not found under $NODE_DIR"
[ -f "$SOURCE_DIR/bin/npm-cli.js" ] || fail "npm dist not found at $SOURCE_DIR/bin/npm-cli.js"

# Run the memfs->zip staging through the repo-locked tsx (never `npx`, which
# would download a fresh tsx and fail offline). Point TMPDIR at a short /tmp
# scratch dir so tsx's IPC socket path stays under the macOS unix-socket limit.
DECLARED_TOOL_PATH="${KANDELO_DEV_SHELL_TOOL_PATH:-$PATH}"
NODE_BIN="$(PATH="$DECLARED_TOOL_PATH" type -P node || true)"
[ -n "$NODE_BIN" ] || fail "node is not available from KANDELO_DEV_SHELL_TOOL_PATH"
TSX_CLI="$REPO_ROOT/node_modules/tsx/dist/cli.mjs"
[ -f "$TSX_CLI" ] || fail "locked tsx CLI not found at $TSX_CLI"
TSX_TMP="$(mktemp -d /tmp/kandelo-node.XXXXXX)"
trap 'rm -rf -- "$TSX_TMP"' EXIT

archive="$WORK_DIR/node.zip"
TMPDIR="$TSX_TMP" PATH="$DECLARED_TOOL_PATH" \
    "$NODE_BIN" "$TSX_CLI" \
    "$REPO_ROOT/images/vfs/scripts/build-node-zip.ts" \
    "$node_wasm" "$SOURCE_DIR" "$archive"

export WASM_POSIX_INSTALL_LOCAL_MIRROR=0
export WASM_POSIX_INSTALL_FORK_INSTRUMENTATION=disabled
# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/install-local-binary.sh"
install_local_binary node-browser-bundle "$archive" node.zip
