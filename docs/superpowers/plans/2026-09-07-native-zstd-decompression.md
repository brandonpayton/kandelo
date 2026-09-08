# Native zstd decompression on spidermonkey-node (Milestone 2 Phase I) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add native zstd *decompression* to spidermonkey-node so headless `claude -p` gets past `Error: embedded text asset is missing or corrupt` (the app reads zstd-compressed embedded text assets via `Bun.zstdDecompressSync`).

**Architecture:** A `kind="library"` `libzstd` dep (decompress-only, built from the in-tree zstd single-file decoder amalgamation — proven to compile for wasm32) is linked into node.wasm exactly as `zlib` already is; a self-contained `__kandeloZstdDecompress` C seam (patch 0021) exposes `ZSTD_decompress`; node-compat's `zlib` zstd stub graduates to real over the seam, and `Bun.zstd*` routes through it.

**Tech Stack:** SpiderMonkey ESR 140 shell C++ (`js/src/shell/js.cpp` via patch), libzstd 1.5.6 (decode amalgamation), node-compat `bootstrap.js`/`adapter.js`, `runtime/bun-run/bun-run.js`, in-kernel Vitest via `runCentralizedProgram`.

**Spec:** `docs/superpowers/specs/2026-09-07-native-zstd-decompression-design.md`

## Global Constraints

- Faithful/holistic, no app-shaped compromises. Compress is out of scope and stays an **honest not-impl** (documented in `docs/posix-status.md`), never a silent no-op.
- ABI-neutral: shell C++ + a linked lib compiled into node.wasm; no kernel export/syscall/`repr(C)` struct/`abi/snapshot.json` change; no `ABI_VERSION` bump.
- Patch 0021 applies **sequentially** after 0015–0020. **Author it via a real `diff`** (base = post-0020 source `js/` subtree at `~/.cache/kandelo/source-only/source-only-v1/compiled/programs/.spidermonkey-*/recipe-work/spidermonkey-source`; new = edited copy), never hand-authored hunks. Verify the chain applies (non-`js/` patches "fail" file-not-found on a `js/`-only copy — expected).
- Seam added before `DefineKandeloNodeNative` (early in js.cpp) must be self-contained (uses only `<zstd.h>` + public JS APIs). Reuse patch 0012's proven byte-in / `Uint8Array`-out marshalling (the zlib seam).
- SpiderMonkey include-order style check (`check_spidermonkey_style.py`, misc tier): `#include <zstd.h>` is an angle-bracket third-party include — place it beside the precedent `#include <zlib.h>` from patch 0012 (same group/ordering).
- Delegate every new native through `packages/registry/spidermonkey/node-compat/adapter.js`'s `_nodeNative` whitelist (an undelegated native is `undefined` to bootstrap.js).
- `_nodeNative` is accessible inside `bootstrap.js` module defs (the `zlib` module already does `const z = _nodeNative`).
- `run.sh` truncates build logs — build to a file: `scripts/dev-shell.sh ./run.sh build spidermonkey-node > /tmp/zstd-build.log 2>&1` and grep it for `error:`/`Error 2`/`check_spidermonkey_style`/`does not apply`/`Build complete`.
- BUILD GUARDRAILS: targeted build only (NEVER a full `local-build`/`./run.sh setup`); build in the implementer's turn foreground (~35 min, wait); batch ALL of Task 2's edits into ONE rebuild.
- Throwaway `claude -p` acceptance: isolated env (`HOME=/root`, `CLAUDE_CONFIG_DIR=/root/.claude`, `PATH=/usr/bin:/bin`), dummy `ANTHROPIC_API_KEY`, `enableTcpNetwork:true`, `CLAUDE_BUN_ELF=/tmp/cc-inspect/lx259/package/claude`. Never commit throwaways; never use real creds.
- Foundation: patch 0012 (zlib native seam via `<zlib.h>` + `LDFLAGS` `libz.a` — the exact pattern), 0015–0020 committed; `packages/registry/zlib/` is the `kind="library"` exemplar; zstd source is in-tree at `packages/registry/zstd/zstd-src`; zstd tarball is `https://github.com/facebook/zstd/archive/refs/tags/v1.5.6.tar.gz` sha256 `30f35f71c1203369dc979ecde0400ffea93c27391bfd2ac5a9715d2173d92ff7`; the spike proved the decode amalgamation compiles clean for wasm32 with `wasm32posix-cc`.

---

### Task 1: `libzstd` (decompress-only) library dependency

**Files:**
- Create: `packages/registry/libzstd/package.toml`
- Create: `packages/registry/libzstd/build-libzstd.sh`

**Interfaces:**
- Produces (for Task 2): a resolvable library `libzstd` — `cargo xtask build-deps resolve libzstd` stages `lib/libzstd.a` (defines `ZSTD_decompress`, `ZSTD_getFrameContentSize`, `ZSTD_isError`, `ZSTD_getErrorName`, `ZSTD_createDStream`, `ZSTD_initDStream`, `ZSTD_decompressStream`, `ZSTD_freeDStream`, `ZSTD_DStreamOutSize`) + `include/zstd.h`.

- [ ] **Step 1: Create `packages/registry/libzstd/package.toml`** (mirror `packages/registry/zlib/package.toml`, kind=library):

```toml
# Per-library manifest consumed by `cargo xtask build-deps`.
# Decompress-only libzstd (the app only decompresses embedded assets); the
# build compiles zstd's official single-file DECODER amalgamation. Compress is
# intentionally absent — see docs/posix-status.md.
kind = "library"

name = "libzstd"
version = "1.5.6"
kernel_abi = 7
depends_on = []
arches = ["wasm32", "wasm64"]

[source]
url = "https://github.com/facebook/zstd/archive/refs/tags/v1.5.6.tar.gz"
sha256 = "30f35f71c1203369dc979ecde0400ffea93c27391bfd2ac5a9715d2173d92ff7"
provider = "archive"

[license]
spdx = "BSD-3-Clause OR GPL-2.0-only"
url = "https://github.com/facebook/zstd/blob/v1.5.6/LICENSE"

[build]
script_path = "packages/registry/libzstd/build-libzstd.sh"

[outputs]
libs = ["lib/libzstd.a"]
headers = ["include/zstd.h"]
```

- [ ] **Step 2: Create `packages/registry/libzstd/build-libzstd.sh`** (mirror `build-zlib.sh`'s structure: source the SDK, download+verify the tarball, build with the target toolchain, stage `$WASM_POSIX_DEP_OUT_DIR`). Use the in-source single-file decoder generator:

```bash
#!/usr/bin/env bash
# Build a decompress-only libzstd as an exact, relocatable resolver package.
# Compiles zstd's official single-file DECODER amalgamation (zstddeclib.c).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/kandelo-libzstd.XXXXXX")"
trap 'rm -rf "$WORK_DIR"' EXIT
SRC_DIR="$WORK_DIR/source"

# shellcheck source=/dev/null
source "$REPO_ROOT/sdk/activate.sh"

ZSTD_VERSION="${WASM_POSIX_DEP_VERSION:-1.5.6}"
INSTALL_DIR="${WASM_POSIX_DEP_OUT_DIR:-$SCRIPT_DIR/libzstd-install}"
SOURCE_URL="${WASM_POSIX_DEP_SOURCE_URL:-https://github.com/facebook/zstd/archive/refs/tags/v${ZSTD_VERSION}.tar.gz}"
SOURCE_SHA256="${WASM_POSIX_DEP_SOURCE_SHA256:-30f35f71c1203369dc979ecde0400ffea93c27391bfd2ac5a9715d2173d92ff7}"
TARGET_ARCH="${WASM_POSIX_DEP_TARGET_ARCH:-wasm32}"

case "$TARGET_ARCH" in
    wasm32) SYSROOT="${WASM_POSIX_SYSROOT:-$REPO_ROOT/sysroot}" ;;
    wasm64) SYSROOT="${WASM_POSIX_SYSROOT:-$REPO_ROOT/sysroot64}" ;;
    *) echo "ERROR: libzstd supports wasm32 and wasm64, got $TARGET_ARCH" >&2; exit 1 ;;
esac
export WASM_POSIX_SYSROOT="$SYSROOT"

CC="${TARGET_ARCH}posix-cc"
AR="${TARGET_ARCH}posix-ar"
RANLIB="${TARGET_ARCH}posix-ranlib"
for tool in "$CC" "$AR" "$RANLIB"; do
    command -v "$tool" >/dev/null || { echo "ERROR: $tool not found after sdk/activate.sh" >&2; exit 1; }
done

echo "==> Downloading zstd $ZSTD_VERSION..."
TARBALL="$WORK_DIR/zstd.tar.gz"
curl --retry 10 --retry-delay 5 --retry-max-time 300 --retry-all-errors -fsSL "$SOURCE_URL" -o "$TARBALL"
echo "==> Verifying source sha256..."
echo "$SOURCE_SHA256  $TARBALL" | shasum -a 256 -c -
mkdir -p "$SRC_DIR"
tar xzf "$TARBALL" -C "$SRC_DIR" --strip-components=1

echo "==> Generating single-file decoder amalgamation..."
( cd "$SRC_DIR/build/single_file_libs" && bash create_single_file_decoder.sh )
test -f "$SRC_DIR/build/single_file_libs/zstddeclib.c"

echo "==> Compiling libzstd.a (decode only) for $TARGET_ARCH..."
"$CC" -O2 -c "$SRC_DIR/build/single_file_libs/zstddeclib.c" -o "$WORK_DIR/zstddeclib.o"
"$AR" rcs "$WORK_DIR/libzstd.a" "$WORK_DIR/zstddeclib.o"
"$RANLIB" "$WORK_DIR/libzstd.a"

echo "==> Staging declared package outputs..."
mkdir -p "$INSTALL_DIR/lib" "$INSTALL_DIR/include"
cp "$WORK_DIR/libzstd.a" "$INSTALL_DIR/lib/"
cp "$SRC_DIR/lib/zstd.h" "$INSTALL_DIR/include/"

test -f "$INSTALL_DIR/lib/libzstd.a"
test -f "$INSTALL_DIR/include/zstd.h"
echo "==> libzstd (decode) build complete!"
ls -lh "$INSTALL_DIR/lib/libzstd.a"
```

- [ ] **Step 3: `chmod +x` the build script and resolve the library.**

Run:
```bash
chmod +x packages/registry/libzstd/build-libzstd.sh
scripts/dev-shell.sh bash -c 'cd "$0" && cargo run -p xtask --quiet -- build-deps resolve libzstd' "$(pwd)" 2>&1 | tail -20
```
Expected: it downloads zstd, generates + compiles the amalgamation, and prints a prefix path. (If the generator needs `python`/`python3`, it is on PATH in the dev shell; the zstd script uses it via `combine.py`.)

- [ ] **Step 4: Verify the outputs exist.**

Run (capture the resolved prefix and assert the artifacts):
```bash
scripts/dev-shell.sh bash -c '
  P="$(cargo run -p xtask --quiet -- build-deps resolve libzstd 2>/dev/null | tail -1)"
  echo "prefix=$P"
  test -f "$P/lib/libzstd.a" && echo "libzstd.a OK"
  test -f "$P/include/zstd.h" && echo "zstd.h OK"
  # confirm ZSTD_decompress is defined in the archive (not just declared)
  '"${TARGET_ARCH:-wasm32}"'posix-nm "$P/lib/libzstd.a" 2>/dev/null | grep -E " T (ZSTD_decompress|ZSTD_getFrameContentSize)$" | head
'
```
Expected: `libzstd.a OK`, `zstd.h OK`, and `nm` shows `ZSTD_decompress` / `ZSTD_getFrameContentSize` as defined text symbols (`T`).

- [ ] **Step 5: Commit.**

```bash
git add packages/registry/libzstd/package.toml packages/registry/libzstd/build-libzstd.sh
git commit -m "Packages: Add libzstd (decompress-only) library dependency

A kind=library dep that builds a decompress-only libzstd.a from zstd 1.5.6's
official single-file decoder amalgamation, for linking into node.wasm (native
zstd decompression). Compress is intentionally absent. Mirrors the zlib
library package.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: link + `__kandeloZstdDecompress` seam + `zlib`/`Bun` zstd + tests

**Files:**
- Modify: `packages/registry/spidermonkey/build-spidermonkey.sh` (resolve + link `libzstd`, mirror the zlib block)
- Create: `packages/registry/spidermonkey/patches/0021-kandelo-zstd-decompress.patch` (js/src/shell/js.cpp)
- Modify: `packages/registry/spidermonkey/node-compat/adapter.js` (delegate the native)
- Modify: `packages/registry/node-compat/bootstrap.js` (real `zlib` zstd over the seam)
- Modify: `runtime/bun-run/bun-run.js` (`Bun.zstd*`)
- Modify: `host/test/esm-probe-guest.test.ts` (tests)
- Modify: `docs/posix-status.md`

**Interfaces:**
- Consumes: Task 1's `libzstd` (`resolve_dep libzstd` → `lib/libzstd.a`, `include/zstd.h`); patch 0012's byte-in/`Uint8Array`-out helpers (search patch 0012 for `JS_GetArrayBufferViewData` / `JS_NewUint8Array` / `JS::GetArrayBufferData` — reuse the same extraction/allocation).
- Produces: `_nodeNative.__kandeloZstdDecompress(bytes) -> Uint8Array`; `require("zlib").zstdDecompressSync(buf)` + `createZstdDecompress()`; `Bun.zstdDecompressSync`/`zstdDecompress`.

- [ ] **Step 1: Wire `libzstd` into `build-spidermonkey.sh`** (mirror the zlib lines identified at ~142–176 and ~366–368). After the zlib resolve block add:

```bash
ZSTD_PREFIX="${WASM_POSIX_DEP_ZSTD_DIR:-}"
if [ -z "$ZSTD_PREFIX" ]; then
    echo "==> Resolving libzstd via cargo xtask build-deps..."
    ZSTD_PREFIX="$(resolve_dep libzstd)"
fi
[ -f "$ZSTD_PREFIX/lib/libzstd.a" ] || { echo "ERROR: libzstd resolve missing libzstd.a at $ZSTD_PREFIX" >&2; exit 1; }
[ -d "$ZSTD_PREFIX/include" ] || { echo "ERROR: libzstd resolve missing include directory at $ZSTD_PREFIX" >&2; exit 1; }
export WASM_POSIX_DEP_ZSTD_DIR="$ZSTD_PREFIX"
```
Add `libzstd` to the build-deps prebuild list (the line containing `libcxx openssl zlib`). Beside the `libz.a` sysroot symlink (`ln -sf "$ZLIB_PREFIX/lib/libz.a" "$SYSROOT/lib/libz.a"`) add:
```bash
ln -sf "$ZSTD_PREFIX/lib/libzstd.a" "$SYSROOT/lib/libzstd.a"
```
Append `libzstd.a` to `LDFLAGS` and the include to CFLAGS/CXXFLAGS (mirror the `libz.a` / `-I$ZLIB_PREFIX/include` entries):
```bash
# in the LDFLAGS export: add  $ZSTD_PREFIX/lib/libzstd.a  after libz.a
# in CFLAGS and CXXFLAGS: add  -I$ZSTD_PREFIX/include  after -I$ZLIB_PREFIX/include
```

- [ ] **Step 2: Author patch 0021 (js.cpp) via real diff.** Build the post-0020 base and edit a copy:

```bash
SRC="$(find ~/.cache/kandelo -path '*recipe-work/spidermonkey-source' -type d | head -1)"
PDIR="$(pwd)/packages/registry/spidermonkey/patches"
W=$(mktemp -d); mkdir -p "$W/base" "$W/new"
cp -R "$SRC/js" "$W/base/js"; cp -R "$SRC/js" "$W/new/js"
for D in base new; do for pf in "$PDIR"/00[01]*.patch; do patch -p1 -N -d "$W/$D" < "$pf" >/dev/null 2>&1; done; done
# edit "$W/new/js/src/shell/js.cpp" (add the include + seam + registration), then:
diff -u --label a/js/src/shell/js.cpp --label b/js/src/shell/js.cpp \
  "$W/base/js/src/shell/js.cpp" "$W/new/js/src/shell/js.cpp" \
  > "$PDIR/0021-kandelo-zstd-decompress.patch"
```

Add `#include <zstd.h>` in the same angle-bracket group as patch 0012's `#include <zlib.h>` (find where `<zlib.h>` lands in the post-0012 js.cpp includes and place `<zstd.h>` alphabetically among the `<...>` third-party includes). Add this seam immediately before `static bool DefineKandeloNodeNative` (self-contained). It reuses patch 0012's input-bytes helper — read patch 0012 to see exactly how it pulls a `uint8_t*`+length out of a `Uint8Array`/`ArrayBuffer` arg and how it returns a `Uint8Array`; use the identical calls here:

```cpp
// Kandelo: native zstd DECOMPRESSION. Input: Uint8Array/ArrayBuffer of a zstd
// frame. Output: a new Uint8Array of the decoded bytes. Fail-loud on any zstd
// error (never partial/garbage). Decompress only (see docs/posix-status.md).
static bool KandeloNativeZstdDecompress(JSContext* cx, unsigned argc, Value* vp) {
  CallArgs args = CallArgsFromVp(argc, vp);
  if (args.length() < 1 || !args[0].isObject()) {
    JS_ReportErrorASCII(cx, "__kandeloZstdDecompress(bytes)");
    return false;
  }

  // --- Copy the input bytes out into a heap buffer, exactly as the zlib seam
  //     (patch 0012) extracts bytes from a Uint8Array/ArrayBuffer arg. Copy
  //     before any GC-capable call. ---
  // (Reuse the 0012 pattern: JS_GetArrayBufferViewData under AutoCheckCannotGC
  //  / JS::GetArrayBufferData, memcpy into std::vector<uint8_t> in.)
  std::vector<uint8_t> in;
  if (!KandeloCopyBytesArg(cx, args[0], in)) {  // helper mirrored from 0012's extraction
    return false;
  }

  unsigned long long contentSize = ZSTD_getFrameContentSize(in.data(), in.size());
  std::vector<uint8_t> out;

  if (contentSize == ZSTD_CONTENTSIZE_ERROR) {
    JS_ReportErrorASCII(cx, "zstd decompression failed: not a valid zstd frame");
    return false;
  } else if (contentSize != ZSTD_CONTENTSIZE_UNKNOWN) {
    out.resize((size_t)contentSize);
    size_t r = ZSTD_decompress(out.data(), out.size(), in.data(), in.size());
    if (ZSTD_isError(r)) {
      JS_ReportErrorUTF8(cx, "zstd decompression failed: %s", ZSTD_getErrorName(r));
      return false;
    }
    out.resize(r);
  } else {
    // Unknown content size: stream-decode into a growable buffer.
    ZSTD_DStream* ds = ZSTD_createDStream();
    if (!ds) { JS_ReportErrorASCII(cx, "zstd: out of memory"); return false; }
    ZSTD_initDStream(ds);
    ZSTD_inBuffer inb = { in.data(), in.size(), 0 };
    size_t chunk = ZSTD_DStreamOutSize();
    for (;;) {
      size_t base = out.size();
      out.resize(base + chunk);
      ZSTD_outBuffer outb = { out.data() + base, chunk, 0 };
      size_t r = ZSTD_decompressStream(ds, &outb, &inb);
      out.resize(base + outb.pos);
      if (ZSTD_isError(r)) {
        ZSTD_freeDStream(ds);
        JS_ReportErrorUTF8(cx, "zstd decompression failed: %s", ZSTD_getErrorName(r));
        return false;
      }
      if (r == 0 && inb.pos == inb.size) break;   // frame fully consumed
      if (inb.pos == inb.size && outb.pos < outb.size) break;  // input exhausted
    }
    ZSTD_freeDStream(ds);
  }

  // --- Return a new Uint8Array of `out`, exactly as the zlib seam builds its
  //     Uint8Array result (patch 0012). ---
  return KandeloBytesToUint8Array(cx, out, args.rval());  // helper mirrored from 0012
}

static bool DefineKandeloNodeNative
```

Notes for the implementer:
- `KandeloCopyBytesArg` / `KandeloBytesToUint8Array` are named for readability — you do NOT need to add new helper functions if patch 0012 already exposes reusable ones; call whatever 0012 uses (e.g. the same `JS_GetArrayBufferViewData` + `JS_NewUint8Array` sequence) inline. If 0012's extraction is inline (not a helper), inline the same sequence here. The point: reuse the *proven* byte marshalling, don't invent a new API.
- `#include <vector>` if not already present (place with the other `<...>` C++ standard includes per the style check).
- Register in the `DefineKandeloNodeNative` funcs list (after the `__kandeloRequireModule` line):
```cpp
      JS_FN("__kandeloZstdDecompress", KandeloNativeZstdDecompress, 1, 0),
```

- [ ] **Step 3: Delegate the native in `adapter.js`** (in the `_nodeNative` object, after the `__kandeloRequireModule` block):

```js
        __kandeloZstdDecompress(bytes) {
            if (typeof native.__kandeloZstdDecompress !== 'function') throw new Error('native __kandeloZstdDecompress is unavailable');
            return native.__kandeloZstdDecompress(bytes);
        },
```

- [ ] **Step 4: Graduate `zlib` zstd in `bootstrap.js`.** Replace the `_notImpl` line
`_builtinModules['zlib'].createZstdDecompress = _notImpl('zlib', 'createZstdDecompress');`
with a real decode `Transform` over the seam, and add `zstdDecompressSync`. Insert near the other post-hoc zlib additions:

```js
_builtinModules['zlib'].zstdDecompressSync = function (buf) {
    const u8 = buf instanceof Uint8Array ? buf
        : buf instanceof ArrayBuffer ? new Uint8Array(buf)
        : Buffer.from(buf);
    return Buffer.from(_nodeNative.__kandeloZstdDecompress(u8));
};
_builtinModules['zlib'].createZstdDecompress = function () {
    const t = new (_builtinModules['stream'].Transform)();
    const parts = [];
    t._transform = function (chunk, _enc, cb) {
        parts.push(chunk instanceof Uint8Array ? chunk : Buffer.from(chunk));
        cb();
    };
    t._flush = function (cb) {
        try {
            const all = Buffer.concat(parts);
            this.push(Buffer.from(_nodeNative.__kandeloZstdDecompress(all)));
            cb();
        } catch (e) { cb(e); }
    };
    return t;
};
```
(Compress-side zstd `createZstdCompress`/`zstdCompressSync` — if present as `_notImpl`, leave them; if absent, add honest `_notImpl('zlib','createZstdCompress')` / `_notImpl('zlib','zstdCompressSync')`. Never a silent no-op.)

- [ ] **Step 5: Wire `Bun.zstd*` in `runtime/bun-run/bun-run.js`.** In the `globalThis.Bun = { ... }` object add (routing through node-compat's zlib to avoid a fresh `_nodeNative` handle):

```js
  zstdDecompressSync: (bytes) => require("zlib").zstdDecompressSync(bytes),
  zstdDecompress: (bytes) => Promise.resolve(require("zlib").zstdDecompressSync(bytes)),
```
(`require` is available in bun-run.js — it uses `require("url")`/`child_process` already.)

- [ ] **Step 6: Add tests to `host/test/esm-probe-guest.test.ts`.** Produce a known zstd blob on the host (once, to embed as a constant): `printf 'hello zstd from kandelo' | zstd -q -c | xxd -p | tr -d '\n'` — put the resulting hex in `ZBLOB_HEX` below (the plan author will paste the real hex; if `zstd` CLI is unavailable, use node `zlib.zstdCompressSync` on the host to produce it). Add fixtures + cases:

```js
// fixtures (add to FIXTURES) — ZBLOB_HEX is the hex of zstd-compressed "hello zstd from kandelo"
  "mainzstd.cjs":
    '(()=>{try{const zlib=require("zlib");const hex="__ZBLOB_HEX__";const b=Buffer.from(hex,"hex");' +
    'const viaZlib=zlib.zstdDecompressSync(b).toString("utf8");' +
    'const viaBun=(typeof Bun!=="undefined"&&Bun.zstdDecompressSync)?Buffer.from(Bun.zstdDecompressSync(b)).toString("utf8"):viaZlib;' +
    'let bad="";try{zlib.zstdDecompressSync(Buffer.from([40,181,47,253,9,9,9,9]));bad="NOTHROW";}catch(e){bad=(e&&e.message||"").indexOf("zstd decompression failed")>=0?"THROW":"WRONG:"+(e&&e.message);}' +
    'console.log("ZSTD",viaZlib===viaBun,viaZlib,bad);' +
    '}catch(e){console.log("ZSTDERR",(e&&e.name)||"",(e&&e.message)||e);}})();',
```
```js
// case (before the closing `});` of the describe block)
  it.runIf(ready)("native zstd: zlib+Bun decode a known blob; corrupt input fails loud", async () => {
    const r = await runOne("/app/mainzstd.cjs");
    // eslint-disable-next-line no-console
    console.log("ZSTD OUT:", JSON.stringify(r.stdout.trim()), "ERR:", r.stderr.trim().split("\n").slice(-6).join(" | "));
    expect(r.stdout).toContain("ZSTD true hello zstd from kandelo THROW");
  }, 90_000);
```
Note: bun-run.js's `Bun` global is not present in this esm-probe harness (that runs plain `node`, not via bun-run), so the fixture falls back to `viaZlib` for the Bun value — the `Bun.zstdDecompressSync` path is exercised by the Step-9 `-p` acceptance (the real app). Keep the `===` assertion meaningful by comparing zlib to the Bun-or-fallback value.

- [ ] **Step 7: Verify the patch chain applies, then ONE rebuild.**

```bash
SRC="$(find ~/.cache/kandelo -path '*recipe-work/spidermonkey-source' -type d | head -1)"
TMP=$(mktemp -d); cp -R "$SRC/js" "$TMP/js"
for pn in 0012 0015 0016 0017 0018 0019 0020 0021; do pf=$(ls packages/registry/spidermonkey/patches/$pn*.patch|head -1); patch -p1 -N -d "$TMP" < "$pf" >/dev/null 2>&1 && echo "$pn OK" || echo "$pn CHECK"; done; rm -rf "$TMP"
scripts/dev-shell.sh ./run.sh build spidermonkey-node > /tmp/zstd-build.log 2>&1
grep -nE "error:|Error 2|check_spidermonkey_style|does not apply|libzstd|Build complete|\[OK\]" /tmp/zstd-build.log | tail
```
Expected: `check_spidermonkey_style.py | ok`, `Build complete`. If the seam fails to compile, read `/tmp/zstd-build.log` (likely: the byte-extraction API differs from 0012 — recheck 0012; or `<zstd.h>` needs `ZSTD_STATIC_LINKING_ONLY` for the streaming API — it does not for the functions used, all are stable API).

- [ ] **Step 8: Run the full esm-probe suite.**

```bash
scripts/dev-shell.sh bash -c 'cd host && npx vitest run test/esm-probe-guest.test.ts 2>&1 | tail -30'
```
Expected: `ZSTD true hello zstd from kandelo THROW` and all Phase A–H cases green.

- [ ] **Step 9: Throwaway `claude -p` acceptance — capture the Phase J seed.** Create `host/test/zz-claude-p-acceptance.throwaway.test.ts` (mirror `host/test/claude-run-native-guest.test.ts`: stage `/usr/bin/claude`=ELF, `/usr/bin/bun-extract`, `/usr/lib/kandelo/bun-run.js`, `/bin/sh`; empty 460 MB image; argv `["node","/usr/lib/kandelo/bun-run.js","/usr/bin/claude","-p","say hi"]`; env `HOME=/root`,`CLAUDE_CONFIG_DIR=/root/.claude`,`PATH=/usr/bin:/bin`,`ANTHROPIC_API_KEY=sk-ant-dummy-not-a-real-key`; `enableTcpNetwork:true`; `useDefaultRootfs:false`; log EXIT + last stderr). Run it; confirm `embedded text asset is missing or corrupt` is gone; record the new first blocker verbatim as the Phase J seed; then `rm -f` the throwaway.

- [ ] **Step 10: Update `docs/posix-status.md`.** Add a node-compat entry: native zstd **decompression** is supported (`zlib.zstdDecompressSync`/`createZstdDecompress`, `Bun.zstdDecompressSync`/`zstdDecompress`), backed by a linked decompress-only libzstd; zstd **compression** is not implemented (honest not-impl, out of scope).

- [ ] **Step 11: Commit.**

```bash
git add packages/registry/spidermonkey/build-spidermonkey.sh \
        packages/registry/spidermonkey/patches/0021-kandelo-zstd-decompress.patch \
        packages/registry/spidermonkey/node-compat/adapter.js \
        packages/registry/node-compat/bootstrap.js runtime/bun-run/bun-run.js \
        host/test/esm-probe-guest.test.ts docs/posix-status.md
git commit -m "Host: Native zstd decompression on spidermonkey-node (Bun.zstd* + zlib zstd)

Link a decompress-only libzstd into node.wasm (mirroring zlib) and add a
__kandeloZstdDecompress C seam (ZSTD_getFrameContentSize + ZSTD_decompress,
streaming fallback, fail-loud on error). node-compat zlib.createZstdDecompress
graduates from _notImpl to a real decode Transform + zlib.zstdDecompressSync;
Bun.zstdDecompressSync/zstdDecompress route through it. Unblocks Claude Code's
zstd-compressed embedded text assets (was 'embedded text asset is missing or
corrupt'). Compress remains an honest not-impl. ABI-neutral.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**1. Spec coverage:** libzstd library dep (Task 1) ✓; build-spidermonkey link (Task 2 Step 1) ✓; C seam ZSTD_getFrameContentSize+decompress+streaming+fail-loud (Step 2) ✓; adapter delegation (Step 3) ✓; node-compat zlib zstd graduation (Step 4) ✓; Bun.zstd* (Step 5) ✓; compress honest not-impl (Steps 4/10) ✓; tests known-blob + corrupt-fails-loud + regression (Steps 6/8) ✓; posix-status (Step 10) ✓; -p acceptance + Phase J seed (Step 9) ✓; ABI-neutral / sequential patch / style check / adapter delegation / real-diff / build guardrails (Global Constraints) ✓.

**2. Placeholder scan:** `__ZBLOB_HEX__` is a required real value the implementer generates in Step 6 (the step says exactly how: `printf ... | zstd -c | xxd -p`), not an unfilled TODO. The `KandeloCopyBytesArg`/`KandeloBytesToUint8Array` names are explicitly flagged as "reuse patch 0012's proven extraction inline, don't invent an API" — a concrete instruction, not a placeholder. No `TBD`/`TODO`.

**3. Type/name consistency:** the native `__kandeloZstdDecompress` and `KandeloNativeZstdDecompress` are consistent across Steps 2/3; `zlib.zstdDecompressSync`/`createZstdDecompress` and `Bun.zstdDecompressSync`/`zstdDecompress` match across Steps 4/5/6; the test sentinel `ZSTD true hello zstd from kandelo THROW` matches the fixture.
