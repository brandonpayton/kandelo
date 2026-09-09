#!/usr/bin/env bash
# Internal runner for `./run.sh local-build`.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
: "${KANDELO_DEV_SHELL_TOOL_PATH:?local build must run in the repository dev shell}"

# An outer launcher may preserve the dev-shell marker while replacing PATH.
# Use only the exact declared tool set at the final build boundary: appending
# the ambient path would still let an undeclared host executable
# satisfy a package configure probe when the repository omitted that tool.
export PATH="$KANDELO_DEV_SHELL_TOOL_PATH"

host_target=""
while IFS= read -r rustc_version_line; do
    case "$rustc_version_line" in
        "host: "*) host_target="${rustc_version_line#host: }" ;;
    esac
done < <(rustc -vV)
if [ -z "$host_target" ]; then
    echo "run-local-build.sh: could not determine the Rust host target" >&2
    exit 1
fi

# The SourceOnly build cache is shared across every worktree on this machine
# by default (content-addressed, so identical inputs are built once and
# reused everywhere). Set KANDELO_SOURCE_CACHE_ROOT to an absolute path to
# give this worktree its own isolated cache instead -- useful when an
# in-progress change alters cached artifact bytes and you don't want it
# churning the shared cache. Keep it unset to share. Must match the default
# in tools/xtask/src/local_build.rs (default_source_cache_root).
# See docs/agent-guidance/packages-and-builds.md.
source_cache_root="${KANDELO_SOURCE_CACHE_ROOT:-$HOME/.cache/kandelo/source-only}"
case "$source_cache_root" in
    /*) ;;
    *)
        echo "run-local-build.sh: KANDELO_SOURCE_CACHE_ROOT must be an absolute path, got '$source_cache_root'" >&2
        exit 1
        ;;
esac

exec cargo run -p xtask --target "$host_target" -- local-build run \
    --set "$REPO_ROOT/packages/sets/local-supported.toml" \
    --source-cache-root "$source_cache_root" \
    --output-root "$REPO_ROOT/local-binaries/source-only-v1" \
    --product all \
    --jobs "${WASM_POSIX_LOCAL_BUILD_JOBS:-16}"
