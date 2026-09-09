// Generates the committed cross-language round-trip fixture used by the
// in-kernel (Rust) RTFS v3 loader tests under
// crates/runtime-core/src/testdata/rtfs-v3-lazy.bin.
//
// This is the drift guard for the RTFS wire format (see the format doc
// comment atop host/src/vfs/rootfs-manifest.ts and the mirrored constants in
// crates/runtime-core/src/rootfs.rs): the fixture is emitted by the REAL TS
// emitter (`emitRootfsManifest`), then a Rust test `include_bytes!`-loads it
// and asserts the tree + the lazy file's (archive_id, source_path) and the
// archive table round-trip byte-for-byte.
//
// Tree produced:
//   /a           -> dir, mode 0755
//   /a/f         -> base file, b"hello\n" (6 bytes), mode 0644
//   /a/g         -> KIND_LAZY_FILE (archive_id=7, source_path="bin/g"),
//                   backing content b"lazy content" (12 bytes) so `st.size`
//                   is well-defined; the archive table separately records
//                   archive 7's total size as 1234 bytes.
//
// Regenerate with:
//   cd host && npx tsx scripts/gen-rtfs-v3-fixture.mts
// (or `scripts/dev-shell.sh bash -c 'cd host && npx tsx scripts/gen-rtfs-v3-fixture.mts'`
// if running outside a shell that already has tsx on PATH).

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MemoryFileSystem } from "../src/vfs/memory-fs";
import { emitRootfsManifest, RTFS_MAGIC, RTFS_VERSION } from "../src/vfs/rootfs-manifest";
import type { RootfsLazyInput } from "../src/vfs/rootfs-manifest";

const O_WRONLY = 0x0001,
  O_CREAT = 0x0040,
  O_TRUNC = 0x0200;

const sab = new SharedArrayBuffer(256 * 1024);
const mfs = MemoryFileSystem.create(sab);

function write(path: string, data: Uint8Array, mode = 0o644): void {
  const fd = mfs.open(path, O_WRONLY | O_CREAT | O_TRUNC, mode);
  mfs.write(fd, data, null, data.length);
  mfs.close(fd);
}

const enc = new TextEncoder();
mfs.mkdir("/a", 0o755);
write("/a/f", enc.encode("hello\n"));
// /a/g's own backing content stands in for the pre-lazy-conversion base file;
// only its size (12 bytes) flows into the manifest entry. The archive it will
// be served from once materialized is a separate, unrelated size (1234) in
// the trailing archive table.
write("/a/g", enc.encode("lazy content"));

const lazy: RootfsLazyInput = {
  files: new Map([["/a/g", { archiveId: 7, sourcePath: "bin/g" }]]),
  archives: [{ archiveId: 7, size: 1234 }],
};

const { buffer } = emitRootfsManifest(mfs, (p) => p, lazy);

// Sanity: magic "RTFS" LE + version 3 LE, matching the brief's byte check.
const dv = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
if (dv.getUint32(0, true) !== RTFS_MAGIC) {
  throw new Error("generated fixture: bad magic");
}
if (dv.getUint32(4, true) !== RTFS_VERSION) {
  throw new Error("generated fixture: bad version");
}

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "../../crates/runtime-core/src/testdata/rtfs-v3-lazy.bin");
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, buffer);
console.log(`wrote ${out} (${buffer.byteLength} bytes)`);
console.log(
  `first 8 bytes: ${Buffer.from(buffer.subarray(0, 8)).toString("hex")}`,
);
