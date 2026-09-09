// Generates the committed SFFS test fixture used by the in-kernel (Rust)
// SFFS reader tests under crates/runtime-core/src/testdata/tiny.vfs.
//
// The fixture is an uncompressed VFSI-wrapped SFFS image (see
// MemoryFileSystem.saveImage in host/src/vfs/memory-fs.ts). It must NOT be
// zstd-compressed: the Rust reader tests assert the image's exact bytes,
// starting with the "VFSI" magic (0x56465349 LE -> 49 53 46 56).
//
// Tree produced:
//   /hello.txt       -> b"hello sffs\n" (11 bytes), mode 0644
//   /dir/             -> mode 0755
//   /dir/nested.txt   -> b"nested\n" (7 bytes)
//   /link             -> symlink to "hello.txt" (9 bytes; inline, <= 40)
//   /big.txt          -> 45000 bytes, big[i] = i % 251
//                        (exceeds 10 direct blocks = 40960 bytes, so it
//                        exercises the single-indirect block path)
//
// Regenerate with:
//   cd host && npx tsx scripts/gen-sffs-rust-fixture.mts
// (or `scripts/dev-shell.sh bash -c 'cd host && npx tsx scripts/gen-sffs-rust-fixture.mts'`
// if running outside a shell that already has tsx on PATH).

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MemoryFileSystem } from "../src/vfs/memory-fs";

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
write("/hello.txt", enc.encode("hello sffs\n"));
mfs.mkdir("/dir", 0o755);
write("/dir/nested.txt", enc.encode("nested\n"));
// symlink(target, linkPath) - confirmed against memory-fs.ts.
mfs.symlink("hello.txt", "/link");
const big = new Uint8Array(45000);
for (let i = 0; i < big.length; i++) big[i] = i % 251;
write("/big.txt", big);

// MemoryFileSystem.saveImage() (memory-fs.ts ~L7021) returns the
// UNCOMPRESSED VFSI image bytes directly -- it is async (not sync, as an
// earlier draft of this generator assumed), but it does NOT zstd-compress.
// That compression instead lives in the separate
// vfs-image-helpers.saveImage wrapper, which we deliberately do not use
// here since the fixture must stay uncompressed.
const image: Uint8Array = await mfs.saveImage();

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "../../crates/runtime-core/src/testdata/tiny.vfs");
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, image);
console.log(`wrote ${out} (${image.byteLength} bytes)`);
