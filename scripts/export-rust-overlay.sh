#!/bin/bash
set -euo pipefail

# export-rust-overlay.sh — Capture edits made to the private sysroot's
# rust-src `library/` into the tracked overlay `sdk/rust/std-overlay/`.
#
# The std port is developed by editing files directly in the writable
# private sysroot (fast iteration). This script diffs that library tree
# against the pristine read-only toolchain rust-src and copies every
# changed file into sdk/rust/std-overlay/, mirroring the `library/`
# layout. build-rust-sysroot.sh re-applies the overlay by copying it
# back over a fresh rust-src copy, so the port survives sysroot rebuilds.
#
# Usage (inside scripts/dev-shell.sh):
#   scripts/export-rust-overlay.sh

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OVERLAY="$REPO_ROOT/sdk/rust/std-overlay"
OUT_DIR="${KANDELO_RUST_DIR:-$HOME/.kandelo/rust}"
MYSYS="$OUT_DIR/sysroot"

command -v rustc >/dev/null || { echo "run inside scripts/dev-shell.sh" >&2; exit 1; }
REALSYS="$(rustc --print sysroot)"
PRISTINE="$REALSYS/lib/rustlib/src/rust/library"
EDITED="$MYSYS/lib/rustlib/src/rust/library"
[ -d "$EDITED" ] || { echo "no private sysroot at $EDITED; run build-rust-sysroot.sh" >&2; exit 1; }

count=0
# Compare only files that exist pristine (we do not add new std files).
while IFS= read -r -d '' f; do
  rel="${f#"$EDITED/"}"
  base="$PRISTINE/$rel"
  [ -f "$base" ] || continue
  if ! cmp -s "$f" "$base"; then
    dest="$OVERLAY/$rel"
    mkdir -p "$(dirname "$dest")"
    cp "$f" "$dest"
    echo "  captured library/$rel"
    count=$((count + 1))
  fi
done < <(find "$EDITED" -type f -name '*.rs' -print0)

echo "==> Exported $count changed file(s) to $OVERLAY"
