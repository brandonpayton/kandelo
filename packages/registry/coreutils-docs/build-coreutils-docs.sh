#!/usr/bin/env bash
# Generate coreutils man(1) pages from the REAL coreutils.wasm binary
# running inside a Kandelo kernel instance, then format with host help2man.
#
# Faithfulness (see CLAUDE.md "Platform Values Contract"): the man page
# content must come from the actual wasm binary, not a hardcoded/fabricated
# text. We can't run the wasm target on the host, so this script boots one
# Kandelo instance (via images/vfs/scripts/generate-coreutils-man.ts) and
# runs each tool's --help/--version for real inside it, capturing the exact
# bytes it printed. help2man then execs a per-tool replay wrapper that
# simply `cat`s the captured file — help2man only reformats that already-
# faithful text into troff; it never talks to the wasm binary or fabricates
# content itself.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/package-build-roots.sh"
kandelo_package_prepare_build_roots "$SCRIPT_DIR" wasm32
WORK="$KANDELO_PACKAGE_WORK_DIR"

COREUTILS_DIR="${WASM_POSIX_DEP_COREUTILS_DIR:?coreutils dependency dir required}"
COREUTILS_WASM="$COREUTILS_DIR/coreutils.wasm"
[ -f "$COREUTILS_WASM" ] || { echo "coreutils.wasm not found under $COREUTILS_DIR" >&2; exit 2; }
command -v help2man >/dev/null || { echo "help2man not on PATH (add pkgs.help2man to flake.nix)" >&2; exit 2; }

# The generator boots a real Kandelo kernel over the base rootfs to run the
# coreutils binary. Both are declared dependencies (see package.toml), so
# pass their exact built artifacts explicitly instead of resolving them
# through the source-only program projection: that projection only exists
# once a whole build finalizes, so a build-time kernel boot cannot rely on
# it. Injecting the declared kernel/rootfs keeps the capture faithful (same
# artifacts the platform ships) while making this package self-contained.
KERNEL_DIR="${WASM_POSIX_DEP_KERNEL_DIR:?kernel dependency dir required}"
KERNEL_WASM="$KERNEL_DIR/kandelo-kernel.wasm"
[ -f "$KERNEL_WASM" ] || { echo "kandelo-kernel.wasm not found under $KERNEL_DIR" >&2; exit 2; }
ROOTFS_DIR="${WASM_POSIX_DEP_ROOTFS_DIR:?rootfs dependency dir required}"
ROOTFS_VFS="$ROOTFS_DIR/rootfs.vfs"
[ -f "$ROOTFS_VFS" ] || { echo "rootfs.vfs not found under $ROOTFS_DIR" >&2; exit 2; }
# The co-resident fork module is the unconditional fork reconstructor every
# process launch needs. It is not a registry package (built out-of-band by
# crates/fork-module/build-wasm.sh, which the local-build engine runs before any
# package build and stages into host/wasm/), so pass its exact artifact
# explicitly, exactly like the kernel/rootfs above: mid-build this boot runs
# under the source-only resolution policy with no source-only binary root, so
# resolving the fork module through the binary resolver would fail.
FORK_MODULE32_WASM="$REPO_ROOT/host/wasm/fork_module32.wasm"
[ -f "$FORK_MODULE32_WASM" ] || { echo "fork_module32.wasm not found at $FORK_MODULE32_WASM (run crates/fork-module/build-wasm.sh)" >&2; exit 2; }

CAP="$WORK/help-capture"; rm -rf "$CAP"
# Point TMPDIR at a short /tmp scratch dir so tsx's IPC socket path stays
# under the macOS unix-socket limit (the resolver's own work dir is a long,
# content-hashed path that overflows sun_path).
TSX_TMP="$(mktemp -d /tmp/kandelo-coreutils-docs.XXXXXX)"
trap 'rm -rf -- "$TSX_TMP"' EXIT
# Capture --help/--version from the real wasm binary running inside Kandelo.
TMPDIR="$TSX_TMP" node "$REPO_ROOT/node_modules/tsx/dist/cli.mjs" \
    "$REPO_ROOT/images/vfs/scripts/generate-coreutils-man.ts" \
    "$COREUTILS_WASM" "$CAP" "$KERNEL_WASM" "$ROOTFS_VFS" "$FORK_MODULE32_WASM"

STAGE="$WORK/stage"; rm -rf "$STAGE"; mkdir -p "$STAGE/share/man/man1"
WRAP="$WORK/wrap"; rm -rf "$WRAP"; mkdir -p "$WRAP"
for helpfile in "$CAP"/*.help; do
    tool="$(basename "$helpfile" .help)"
    verfile="$CAP/$tool.version"
    # Replay wrapper: help2man execs "<wrap>/<tool> --help|--version"; we
    # serve the exact bytes captured from Kandelo, so the man content is
    # 100% derived from the real binary and help2man only formats it.
    cat > "$WRAP/$tool" <<EOF
#!/usr/bin/env bash
case "\$1" in
  --version) cat "$verfile" ;;
  *)         cat "$helpfile" ;;
esac
EOF
    chmod +x "$WRAP/$tool"
    help2man --no-info --source="GNU coreutils 9.6 (Kandelo)" \
        --name="$tool" "$WRAP/$tool" > "$STAGE/share/man/man1/$tool.1" \
        || { echo "help2man failed for $tool" >&2; rm -f "$STAGE/share/man/man1/$tool.1"; }
done
[ -f "$STAGE/share/man/man1/ls.1" ] || { echo "ls.1 not generated" >&2; exit 2; }

ARCHIVE="$WORK/coreutils-docs.zip"; rm -f "$ARCHIVE"
bash "$REPO_ROOT/images/vfs/scripts/create-deterministic-zip.sh" "$STAGE" "$ARCHIVE"

# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/install-local-binary.sh"
if [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
    WASM_POSIX_INSTALL_LOCAL_MIRROR=0 WASM_POSIX_INSTALL_FORK_INSTRUMENTATION=disabled \
        install_local_binary coreutils-docs "$ARCHIVE" coreutils-docs.zip
else
    WASM_POSIX_INSTALL_FORK_INSTRUMENTATION=disabled \
        install_local_binary coreutils-docs "$ARCHIVE" coreutils-docs.zip
fi
