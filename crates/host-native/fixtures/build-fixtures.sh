#!/bin/bash
# Rebuild the host-native guest fixtures (*.c -> *.wasm) through the SDK, using
# the same compile/link recipe scripts/build-programs.sh uses for the example
# programs. Run from inside scripts/dev-shell.sh (which sets $LLVM_BIN).
#
#   SYSROOT=<repo>/sysroot scripts/dev-shell.sh \
#     crates/host-native/fixtures/build-fixtures.sh
#
# SYSROOT must be a sysroot built for the CURRENT ABI (this branch's libc).
# The committed .wasm files must match the running kernel's ABI or the native
# host rejects them at load — see fixtures/README.md.
set -euo pipefail

FIXTURES_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$FIXTURES_DIR/../../.." && pwd)"
SYSROOT="${SYSROOT:-$REPO_ROOT/sysroot}"
GLUE="$REPO_ROOT/libc/glue"

: "${LLVM_BIN:?run inside scripts/dev-shell.sh so LLVM_BIN is set}"
if [ ! -f "$SYSROOT/lib/libc.a" ]; then
    echo "error: no sysroot at $SYSROOT (set SYSROOT=<repo>/sysroot)" >&2
    exit 1
fi

for src in "$FIXTURES_DIR"/*.c; do
    name="$(basename "$src" .c)"
    echo "building $name.wasm"
    "$LLVM_BIN/clang" \
        --target=wasm32-unknown-unknown --sysroot="$SYSROOT" -nostdlib -O2 \
        -matomics -mbulk-memory -fno-trapping-math \
        -mllvm -wasm-enable-sjlj -mllvm -wasm-use-legacy-eh=false \
        "$src" \
        "$GLUE/channel_syscall.c" "$GLUE/compiler_rt.c" "$SYSROOT/lib/crt1.o" \
        "$SYSROOT/lib/libc.a" \
        -Wl,--no-entry -Wl,--export=_start -Wl,--import-memory -Wl,--shared-memory \
        -Wl,--max-memory=1073741824 -Wl,--allow-undefined -Wl,--table-base=3 \
        -Wl,--export-table -Wl,--growable-table \
        -Wl,--export=__wasm_init_tls -Wl,--export=__tls_base -Wl,--export=__tls_size \
        -Wl,--export=__tls_align -Wl,--export=__stack_pointer \
        -Wl,--export=__wasm_thread_init -Wl,--export=__abi_version \
        -o "$FIXTURES_DIR/$name.wasm"
done
echo "done"
