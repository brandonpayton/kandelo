#!/usr/bin/env bash
set -euo pipefail
repo="$(cd "$(dirname "$0")/../.." && pwd)"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/bin" "$tmp/etc"
printf 'hello\n' > "$tmp/etc/small.txt"          # tiny -> stored
head -c 4096 /dev/zero | tr '\0' 'a' > "$tmp/bin/big.txt"  # compressible -> deflate
chmod 755 "$tmp/bin/big.txt"
( cd "$tmp/bin" && ln -s big.txt link )          # symlink, target = content "big.txt"
out="$repo/crates/runtime-core/src/testdata/tiny.zip"
mkdir -p "$(dirname "$out")"
bash "$repo/images/vfs/scripts/create-deterministic-zip.sh" "$tmp" "$out"
echo "wrote $out"
