# Phase 5 Increment 3b.1 — In-kernel SFFS reader Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port the read-only SFFS ("SharedFileSystem") on-disk parser from the host TypeScript (`host/src/vfs/sharedfs-vendor.ts`) into a new `runtime-core` Rust module, so the in-kernel rootfs overlay can read the base `/` image tree itself (first slice of the Increment 3b parser migration).

**Architecture:** A self-contained, read-only, `no_std + alloc` parser `crates/runtime-core/src/sffs.rs` over a borrowed `&[u8]` of **decompressed** image bytes (zstd stays host-side per decision X). It exposes superblock validation, inode read, block-pointer resolution, positioned read, directory iteration, name lookup, path resolution, and readlink — mirroring the vendor's read path byte-for-byte. It returns lightweight SFFS structs; mapping into kernel `WasmStat`/overlay types is a LATER increment (wiring). No syscall wiring, no ABI change, no host change in this increment — a pure, unit-tested library slice.

**Tech Stack:** Rust (`no_std` on wasm, `std` in tests), `alloc::vec::Vec`; a small Node fixture generator using the existing `MemoryFileSystem` (host package) to emit a committed binary test fixture.

**Spec:** `docs/plans/2026-08-28-phase5-vfs-to-rust.md` (the `# Increment 3b` section — target end-state A, decision X for host-side zstd, and the 7-step slice; this plan implements slice step 1). The authoritative format reference is `host/src/vfs/sharedfs-vendor.ts`.

## Global Constraints

- **Read-only.** This module never mutates the image. All write/mutation vendor methods are out of scope (`open`-create, `write`, `mkdir`, `unlink`, `rename`, `mkfs`, allocators, locks). The overlay owns mutations in a later increment.
- **`no_std + alloc`.** `crates/runtime-core` is `no_std` on wasm. Use `alloc::vec::Vec`/`alloc::string`; no `std::` in non-test code. Tests may use `std`.
- **Little-endian, everywhere.** Every multi-byte field is little-endian (the vendor's `DataView` calls all pass `true`).
- **Test target.** `runtime-core` cross-compiles to wasm by default (`.cargo/config.toml` sets `target = "wasm32-unknown-unknown"`), and wasm has no test harness. Run unit tests on the host triple: `cargo test -p runtime-core --target "$(rustc -vV | sed -n 's/^host: //p')" sffs`. Confirm the exact package name in `crates/runtime-core/Cargo.toml` (`[package] name`); use it verbatim for `-p`.
- **Errno type.** Use `wasm_posix_shared::Errno` (the shared errno enum `syscalls.rs` imports via `use wasm_posix_shared::Errno;`); do not invent a parallel error enum. Variants used: `EINVAL`, `ENOENT`, `EIO`, `ENOTDIR`, `ELOOP` (standard POSIX errnos present in the shared enum).
- **Zstd is host-side.** The reader consumes already-**decompressed** bytes. The committed fixture is uncompressed (`.vfs`, no zstd frame). Do not add any decompression to this module.

## Format constants (copy verbatim into `sffs.rs` — from `sharedfs-vendor.ts` and `memory-fs.ts`)

```
Inner SFFS: MAGIC=0x53464653 ("SFFS"), VERSION=1, BLOCK_SIZE=4096, INODE_SIZE=128,
INODES_PER_BLOCK=32, DIRECT_BLOCKS=10, PTRS_PER_BLOCK=1024, INLINE_SYMLINK_SIZE=40,
ROOT_INO=1, MAX_NAME=255, MAX_SYMLINK_HOPS=8.
Superblock u32 offsets: MAGIC=0, VERSION=4, BLOCK_SIZE=8, TOTAL_BLOCKS=12, TOTAL_INODES=16,
  INODE_BITMAP_START=28, BLOCK_BITMAP_START=32, INODE_TABLE_START=36, DATA_START=40, ...
Inode (128B) offsets: MODE(u32)=8, LINK_COUNT(u32)=12, SIZE(u64)=16, MTIME(u64)=24,
  CTIME(u64)=32, ATIME(u64)=40, DIRECT(u32[10])=48, INDIRECT(u32)=88,
  DOUBLE_INDIRECT(u32)=92, UID(u32)=96, GID(u32)=100, GENERATION(u64)=104.
Types: S_IFMT=0xf000, S_IFREG=0x8000, S_IFDIR=0x4000, S_IFLNK=0xa000.
Dirent: +0 ino(u32), +4 rec_len(u16), +6 name_len(u16), +8 name[name_len]. Header=8.
  Valid iff rec_len>=8 && rec_len%4==0 && off+rec_len<=blockEnd && name_len<=rec_len-8.
  ino==0 => free slot (skip, advance by rec_len). Records never straddle a 4096 block.
Outer VFSI container: MAGIC=0x56465349 ("VFSI"), VERSION=1, HEADER=16:
  off0 u32 magic, off4 u32 version, off8 u32 flags, off12 u32 sabLen; SFFS = image[16..16+sabLen].
inodeOffset(ino) = (INODE_TABLE_START + ino/32)*4096 + (ino%32)*128.
inodeBlockMap: fb 0..9 direct; 10..1033 single-indirect via INDIRECT; 1034..1048585 double-indirect
  via DOUBLE_INDIRECT (l1 = fb-10-1024; outer index fb/1024, inner fb%1024). ptr 0 => sparse hole (zeros).
```

---

### Task 1: Committed tiny SFFS fixture + generator

**Files:**
- Create: `host/scripts/gen-sffs-rust-fixture.mts` (Node generator)
- Create (generated, committed): `crates/runtime-core/src/testdata/tiny.vfs`
- Modify: none

**Interfaces:**
- Produces: a binary `tiny.vfs` (uncompressed VFSI-wrapped SFFS) with this exact tree, which every later task asserts against:
  - `/hello.txt` = bytes `b"hello sffs\n"` (11 bytes), mode 0644
  - `/dir` directory, mode 0755
  - `/dir/nested.txt` = bytes `b"nested\n"` (7 bytes)
  - `/link` → symlink target `"hello.txt"` (9 bytes; inline, ≤40)
  - `/big.txt` = 45000 bytes where `big[i] = (i % 251) as u8` (exceeds 10 direct blocks = 40960, exercises single-indirect)

- [ ] **Step 1: Write the generator**

`host/scripts/gen-sffs-rust-fixture.mts`:

```ts
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MemoryFileSystem } from "../src/vfs/memory-fs";

const O_WRONLY = 0x0001, O_CREAT = 0x0040, O_TRUNC = 0x0200;

const sab = new SharedArrayBuffer(4 * 1024 * 1024);
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
// Confirm the symlink signature in memory-fs.ts: symlink(target, linkPath).
mfs.symlink("hello.txt", "/link");
const big = new Uint8Array(45000);
for (let i = 0; i < big.length; i++) big[i] = i % 251;
write("/big.txt", big);

// mfs.saveImage() returns the UNCOMPRESSED VFSI image bytes (no zstd frame).
// Confirm this is the MemoryFileSystem method (memory-fs.ts ~7066/7081), not the
// compressing vfs-image-helpers.saveImage wrapper.
const image: Uint8Array = mfs.saveImage();

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "../../crates/runtime-core/src/testdata/tiny.vfs");
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, image);
console.log(`wrote ${out} (${image.byteLength} bytes)`);
```

- [ ] **Step 2: Run the generator (inside the dev shell) and verify the fixture**

Run:
```bash
scripts/dev-shell.sh bash -c 'cd host && npx tsx scripts/gen-sffs-rust-fixture.mts'
xxd -l 16 crates/runtime-core/src/testdata/tiny.vfs   # expect 49 46 53 56 (VFSI LE) ... at off0
```
Expected: file written; first 4 bytes are `49 46 53 56` (0x56465349 LE = "VFSI"). If `saveImage()` or `symlink` signatures differ, fix per `memory-fs.ts` and re-run. If `tsx` is unavailable, use the repo's standard TS runner (check `host/package.json` scripts).

- [ ] **Step 3: Commit**

```bash
git add host/scripts/gen-sffs-rust-fixture.mts crates/runtime-core/src/testdata/tiny.vfs
git commit -m "VFS: Add SFFS reader test fixture + generator (Phase 5 Inc 3b.1)"
```

---

### Task 2: `sffs` module scaffold, LE readers, VFSI unwrap

**Files:**
- Create: `crates/runtime-core/src/sffs.rs`
- Modify: `crates/runtime-core/src/lib.rs` (add `pub mod sffs;` next to the other `pub mod` lines)
- Test: `crates/runtime-core/src/sffs.rs` (`#[cfg(test)] mod tests`)

**Interfaces:**
- Produces:
  - `pub fn unwrap_vfsi(image: &[u8]) -> Result<&[u8], Errno>` — validates the VFSI header and returns the inner SFFS slice `image[16..16+sabLen]`.
  - `fn r32(b: &[u8], off: usize) -> Option<u32>` / `fn r64(b: &[u8], off: usize) -> Option<u64>` — bounds-checked LE reads (module-private helpers reused by later tasks).
  - `const TINY_VFS: &[u8] = include_bytes!("testdata/tiny.vfs");` in the test module.

- [ ] **Step 1: Write the failing test**

In `sffs.rs`:
```rust
#[cfg(test)]
mod tests {
    use super::*;
    const TINY_VFS: &[u8] = include_bytes!("testdata/tiny.vfs");

    #[test]
    fn unwrap_vfsi_returns_sffs_with_valid_magic() {
        let sffs = unwrap_vfsi(TINY_VFS).expect("VFSI unwrap");
        // Inner SFFS superblock magic "SFFS" (0x53464653) at byte 0, LE.
        assert_eq!(r32(sffs, 0), Some(0x5346_4653));
    }

    #[test]
    fn unwrap_vfsi_rejects_bad_magic() {
        let mut bad = TINY_VFS.to_vec();
        bad[0] ^= 0xff;
        assert!(unwrap_vfsi(&bad).is_err());
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p runtime-core --target "$(rustc -vV | sed -n 's/^host: //p')" sffs::tests::unwrap_vfsi -- --nocapture`
Expected: FAIL to compile (`unwrap_vfsi`/`r32` not found).

- [ ] **Step 3: Write minimal implementation**

At the top of `sffs.rs`:
```rust
//! Read-only parser for the on-disk SFFS ("SharedFileSystem") image and its
//! VFSI container. Ported from host/src/vfs/sharedfs-vendor.ts. no_std + alloc.
//! Consumes DECOMPRESSED bytes (zstd is a host-side transport codec).

extern crate alloc;

use wasm_posix_shared::Errno; // same import syscalls.rs uses

const VFSI_MAGIC: u32 = 0x5646_5349; // "VFSI" LE
const VFSI_VERSION: u32 = 1;
const VFSI_HEADER: usize = 16;

pub(crate) fn r32(b: &[u8], off: usize) -> Option<u32> {
    let e = off.checked_add(4)?;
    if e > b.len() { return None; }
    Some(u32::from_le_bytes([b[off], b[off + 1], b[off + 2], b[off + 3]]))
}

pub(crate) fn r64(b: &[u8], off: usize) -> Option<u64> {
    let e = off.checked_add(8)?;
    if e > b.len() { return None; }
    let mut a = [0u8; 8];
    a.copy_from_slice(&b[off..e]);
    Some(u64::from_le_bytes(a))
}

pub fn unwrap_vfsi(image: &[u8]) -> Result<&[u8], Errno> {
    if r32(image, 0) != Some(VFSI_MAGIC) { return Err(Errno::EINVAL); }
    if r32(image, 4) != Some(VFSI_VERSION) { return Err(Errno::EINVAL); }
    let sab_len = r32(image, 12).ok_or(Errno::EINVAL)? as usize;
    let end = VFSI_HEADER.checked_add(sab_len).ok_or(Errno::EINVAL)?;
    if end > image.len() { return Err(Errno::EINVAL); }
    Ok(&image[VFSI_HEADER..end])
}
```
Add `pub mod sffs;` to `crates/runtime-core/src/lib.rs`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test -p runtime-core --target "$(rustc -vV | sed -n 's/^host: //p')" sffs::tests::unwrap_vfsi`
Expected: PASS (both tests). Then `cargo build -p kandelo -Z build-std=core,alloc` to confirm the wasm no_std build stays clean.

- [ ] **Step 5: Commit**

```bash
git add crates/runtime-core/src/sffs.rs crates/runtime-core/src/lib.rs
git commit -m "VFS: SFFS reader scaffold + VFSI unwrap (Phase 5 Inc 3b.1)"
```

---

### Task 3: `Sffs::mount` — superblock validation + geometry

**Files:**
- Modify: `crates/runtime-core/src/sffs.rs`

**Interfaces:**
- Consumes: `unwrap_vfsi`, `r32` (Task 2).
- Produces:
  - `pub struct Sffs<'a> { bytes: &'a [u8], inode_table_start: u32 }`
  - `pub fn mount(sffs_bytes: &'a [u8]) -> Result<Sffs<'a>, Errno>` — validates magic/version/block-size and caches `INODE_TABLE_START`.

- [ ] **Step 1: Write the failing test**
```rust
#[test]
fn mount_validates_superblock() {
    let sffs = unwrap_vfsi(TINY_VFS).unwrap();
    let fs = Sffs::mount(sffs).expect("mount");
    assert!(fs.inode_table_start >= 1);
}
#[test]
fn mount_rejects_wrong_block_size() {
    let mut bad = unwrap_vfsi(TINY_VFS).unwrap().to_vec();
    bad[8] = 0; bad[9] = 0; bad[10] = 0; bad[11] = 0; // BLOCK_SIZE=0
    assert!(Sffs::mount(&bad).is_err());
}
```

- [ ] **Step 2: Run test to verify it fails**
Run: `cargo test ... sffs::tests::mount`
Expected: FAIL (`Sffs`/`mount` not found).

- [ ] **Step 3: Write minimal implementation**
```rust
const SFFS_MAGIC: u32 = 0x5346_4653; // "SFFS"
const SFFS_VERSION: u32 = 1;
pub(crate) const BLOCK_SIZE: usize = 4096;
const SB_INODE_TABLE_START: usize = 36;

pub struct Sffs<'a> {
    bytes: &'a [u8],
    pub(crate) inode_table_start: u32,
}

impl<'a> Sffs<'a> {
    pub fn mount(bytes: &'a [u8]) -> Result<Sffs<'a>, Errno> {
        if r32(bytes, 0) != Some(SFFS_MAGIC) { return Err(Errno::EINVAL); }
        if r32(bytes, 4) != Some(SFFS_VERSION) { return Err(Errno::EINVAL); }
        if r32(bytes, 8) != Some(BLOCK_SIZE as u32) { return Err(Errno::EINVAL); }
        let inode_table_start = r32(bytes, SB_INODE_TABLE_START).ok_or(Errno::EINVAL)?;
        Ok(Sffs { bytes, inode_table_start })
    }
}
```

- [ ] **Step 4: Run test to verify it passes**
Run: `cargo test ... sffs::tests::mount` → PASS.

- [ ] **Step 5: Commit**
```bash
git add crates/runtime-core/src/sffs.rs
git commit -m "VFS: SFFS superblock mount/validate (Phase 5 Inc 3b.1)"
```

---

### Task 4: Inode read + `stat`

**Files:** Modify `crates/runtime-core/src/sffs.rs`

**Interfaces:**
- Consumes: `Sffs`, `r32`, `r64`, `inode_table_start` (Task 3).
- Produces:
  - `pub struct SffsStat { pub ino: u32, pub mode: u32, pub nlink: u32, pub size: u64, pub mtime_ms: u64, pub ctime_ms: u64, pub atime_ms: u64, pub uid: u32, pub gid: u32, pub generation: u64 }`
  - `pub fn stat_ino(&self, ino: u32) -> Result<SffsStat, Errno>`
  - private `fn inode_offset(&self, ino: u32) -> usize`
  - `pub const ROOT_INO: u32 = 1;` and `pub fn file_type(mode: u32) -> u32 { mode & 0xf000 }`

- [ ] **Step 1: Write the failing test**
```rust
#[test]
fn root_inode_is_a_directory() {
    let fs = Sffs::mount(unwrap_vfsi(TINY_VFS).unwrap()).unwrap();
    let st = fs.stat_ino(ROOT_INO).unwrap();
    assert_eq!(st.mode & 0xf000, 0x4000, "root is S_IFDIR");
    assert!(st.nlink >= 2, "dir has >= 2 links (. and ..)");
}
```

- [ ] **Step 2: Run test to verify it fails**
Run: `cargo test ... sffs::tests::root_inode` → FAIL (`stat_ino` not found).

- [ ] **Step 3: Write minimal implementation**
```rust
pub const ROOT_INO: u32 = 1;
const INODES_PER_BLOCK: u32 = 32;
const INODE_SIZE: usize = 128;
const INO_MODE: usize = 8;
const INO_LINK_COUNT: usize = 12;
const INO_SIZE: usize = 16;
const INO_MTIME: usize = 24;
const INO_CTIME: usize = 32;
const INO_ATIME: usize = 40;
const INO_UID: usize = 96;
const INO_GID: usize = 100;
const INO_GENERATION: usize = 104;

pub struct SffsStat {
    pub ino: u32, pub mode: u32, pub nlink: u32, pub size: u64,
    pub mtime_ms: u64, pub ctime_ms: u64, pub atime_ms: u64,
    pub uid: u32, pub gid: u32, pub generation: u64,
}
pub fn file_type(mode: u32) -> u32 { mode & 0xf000 }

impl<'a> Sffs<'a> {
    fn inode_offset(&self, ino: u32) -> usize {
        let block = self.inode_table_start + ino / INODES_PER_BLOCK;
        block as usize * BLOCK_SIZE + (ino % INODES_PER_BLOCK) as usize * INODE_SIZE
    }
    pub fn stat_ino(&self, ino: u32) -> Result<SffsStat, Errno> {
        if ino == 0 { return Err(Errno::ENOENT); }
        let o = self.inode_offset(ino);
        let mode = r32(self.bytes, o + INO_MODE).ok_or(Errno::EIO)?;
        let nlink = r32(self.bytes, o + INO_LINK_COUNT).ok_or(Errno::EIO)?;
        if nlink == 0 { return Err(Errno::ENOENT); } // free/orphaned slot
        Ok(SffsStat {
            ino, mode, nlink,
            size: r64(self.bytes, o + INO_SIZE).ok_or(Errno::EIO)?,
            mtime_ms: r64(self.bytes, o + INO_MTIME).ok_or(Errno::EIO)?,
            ctime_ms: r64(self.bytes, o + INO_CTIME).ok_or(Errno::EIO)?,
            atime_ms: r64(self.bytes, o + INO_ATIME).ok_or(Errno::EIO)?,
            uid: r32(self.bytes, o + INO_UID).ok_or(Errno::EIO)?,
            gid: r32(self.bytes, o + INO_GID).ok_or(Errno::EIO)?,
            generation: r64(self.bytes, o + INO_GENERATION).ok_or(Errno::EIO)?,
        })
    }
}
```

- [ ] **Step 4: Run test to verify it passes**
Run: `cargo test ... sffs::tests::root_inode` → PASS.

- [ ] **Step 5: Commit**
```bash
git add crates/runtime-core/src/sffs.rs
git commit -m "VFS: SFFS inode read + stat (Phase 5 Inc 3b.1)"
```

---

### Task 5: Block-pointer resolution (`block_map`)

**Files:** Modify `crates/runtime-core/src/sffs.rs`

**Interfaces:**
- Consumes: `Sffs`, `r32`, `inode_offset` (Task 4).
- Produces: `fn block_map(&self, ino: u32, file_block: u32) -> Result<u32, Errno>` — returns the physical block number for a file block, or `0` for a sparse hole. Direct (0..9), single-indirect (10..1033), double-indirect (1034..).

- [ ] **Step 1: Write the failing test**
```rust
#[test]
fn block_map_direct_and_indirect() {
    let fs = Sffs::mount(unwrap_vfsi(TINY_VFS).unwrap()).unwrap();
    let ino = fs.lookup(ROOT_INO, b"big.txt").unwrap(); // Task 8 dependency: see note
    // big.txt is 45000 bytes => 11 blocks => block 0 (direct) and block 10 (single-indirect)
    assert!(fs.block_map(ino, 0).unwrap() != 0);
    assert!(fs.block_map(ino, 10).unwrap() != 0);
}
```
NOTE: this test calls `lookup` (Task 8). If implementing strictly in order, temporarily hard-resolve `big.txt`'s ino by scanning the root dir, or reorder so Task 8 precedes Task 5. Simplest: move this test's body to after Task 8 lands, and in Task 5 test `block_map` against the root directory inode's block 0 (`fs.block_map(ROOT_INO, 0).unwrap() != 0`), which needs no lookup.

Revised Task-5 test (no lookup dependency). NOTE: a beyond-max file_block must be
`is_err()` (EINVAL), not `.unwrap() == 0` — `block_map` returns `Err(EINVAL)` past
the addressable range (10 + 1024 + 1024*1024 = 1,049,610 blocks), so unwrapping a
beyond-max block panics. Use an in-range unallocated block for the hole assertion:
```rust
#[test]
fn block_map_direct_hole_and_beyond_max() {
    let fs = Sffs::mount(unwrap_vfsi(TINY_VFS).unwrap()).unwrap();
    // Root dir's first data block is allocated (non-zero physical block).
    assert!(fs.block_map(ROOT_INO, 0).unwrap() != 0, "root dir data block 0");
    // An unallocated direct block within range reads as a sparse hole (0).
    assert_eq!(fs.block_map(ROOT_INO, 5).unwrap(), 0, "unallocated direct block is a hole");
    // A file block beyond the double-indirect range is EINVAL, not a hole.
    assert!(fs.block_map(ROOT_INO, 2_000_000).is_err(), "beyond max file blocks -> EINVAL");
}
```

- [ ] **Step 2: Run test to verify it fails**
Run: `cargo test ... sffs::tests::block_map` → FAIL (`block_map` not found).

- [ ] **Step 3: Write minimal implementation**
```rust
const DIRECT_BLOCKS: u32 = 10;
const PTRS_PER_BLOCK: u32 = 1024;
const INO_DIRECT: usize = 48;
const INO_INDIRECT: usize = 88;
const INO_DOUBLE_INDIRECT: usize = 92;

impl<'a> Sffs<'a> {
    fn block_ptr_in(&self, block: u32, index: u32) -> Result<u32, Errno> {
        if block == 0 { return Ok(0); } // missing indirect block => hole
        let off = block as usize * BLOCK_SIZE + index as usize * 4;
        r32(self.bytes, off).ok_or(Errno::EIO)
    }
    fn block_map(&self, ino: u32, file_block: u32) -> Result<u32, Errno> {
        let o = self.inode_offset(ino);
        if file_block < DIRECT_BLOCKS {
            return r32(self.bytes, o + INO_DIRECT + file_block as usize * 4).ok_or(Errno::EIO);
        }
        let fb = file_block - DIRECT_BLOCKS;
        if fb < PTRS_PER_BLOCK {
            let ind = r32(self.bytes, o + INO_INDIRECT).ok_or(Errno::EIO)?;
            return self.block_ptr_in(ind, fb);
        }
        let fb = fb - PTRS_PER_BLOCK;
        let max = PTRS_PER_BLOCK as u64 * PTRS_PER_BLOCK as u64;
        if (fb as u64) < max {
            let dind = r32(self.bytes, o + INO_DOUBLE_INDIRECT).ok_or(Errno::EIO)?;
            let l1 = self.block_ptr_in(dind, fb / PTRS_PER_BLOCK)?;
            return self.block_ptr_in(l1, fb % PTRS_PER_BLOCK);
        }
        Err(Errno::EINVAL) // beyond MAX_FILE_BLOCKS
    }
}
```

- [ ] **Step 4: Run test to verify it passes**
Run: `cargo test ... sffs::tests::block_map` → PASS.

- [ ] **Step 5: Commit**
```bash
git add crates/runtime-core/src/sffs.rs
git commit -m "VFS: SFFS block-pointer resolution (Phase 5 Inc 3b.1)"
```

---

### Task 6: Positioned read (`read_at`)

**Files:** Modify `crates/runtime-core/src/sffs.rs`

**Interfaces:**
- Consumes: `stat_ino`, `block_map` (Tasks 4-5).
- Produces: `pub fn read_at(&self, ino: u32, offset: u64, dst: &mut [u8]) -> Result<usize, Errno>` — mirrors `inodeReadData`: clamps to size, fills sparse holes with zeros, copies per-block. Returns bytes read (0 at/after EOF).

- [ ] **Step 1: Write the failing test**
```rust
#[test]
fn read_at_reads_root_dir_bytes_nonzero() {
    // Directory data is readable via read_at too; assert we get bytes.
    let fs = Sffs::mount(unwrap_vfsi(TINY_VFS).unwrap()).unwrap();
    let size = fs.stat_ino(ROOT_INO).unwrap().size;
    let mut buf = [0u8; 64];
    let n = fs.read_at(ROOT_INO, 0, &mut buf).unwrap();
    assert!(n > 0 && (n as u64) <= size);
    // beyond EOF returns 0
    assert_eq!(fs.read_at(ROOT_INO, size + 10, &mut buf).unwrap(), 0);
}
```
(A content-exact read of `/hello.txt` is asserted in Task 9 once path resolution exists.)

- [ ] **Step 2: Run test to verify it fails**
Run: `cargo test ... sffs::tests::read_at` → FAIL (`read_at` not found).

- [ ] **Step 3: Write minimal implementation**
```rust
impl<'a> Sffs<'a> {
    pub fn read_at(&self, ino: u32, offset: u64, dst: &mut [u8]) -> Result<usize, Errno> {
        let size = self.stat_ino(ino)?.size;
        if offset >= size { return Ok(0); }
        let mut remaining = core::cmp::min(dst.len() as u64, size - offset) as usize;
        let mut pos = offset;
        let mut out = 0usize;
        while remaining > 0 {
            let file_block = (pos / BLOCK_SIZE as u64) as u32;
            let block_off = (pos % BLOCK_SIZE as u64) as usize;
            let chunk = core::cmp::min(BLOCK_SIZE - block_off, remaining);
            let phys = self.block_map(ino, file_block)?;
            if phys == 0 {
                for b in &mut dst[out..out + chunk] { *b = 0; } // sparse hole
            } else {
                let src = phys as usize * BLOCK_SIZE + block_off;
                let end = src.checked_add(chunk).ok_or(Errno::EIO)?;
                if end > self.bytes.len() { return Err(Errno::EIO); }
                dst[out..out + chunk].copy_from_slice(&self.bytes[src..end]);
            }
            out += chunk; pos += chunk as u64; remaining -= chunk;
        }
        Ok(out)
    }
}
```

- [ ] **Step 4: Run test to verify it passes**
Run: `cargo test ... sffs::tests::read_at` → PASS.

- [ ] **Step 5: Commit**
```bash
git add crates/runtime-core/src/sffs.rs
git commit -m "VFS: SFFS positioned read (Phase 5 Inc 3b.1)"
```

---

### Task 7: Directory iteration (`read_dir`)

**Files:** Modify `crates/runtime-core/src/sffs.rs`

**Interfaces:**
- Consumes: `stat_ino`, `read_at` (Tasks 4, 6).
- Produces:
  - `pub struct SffsDirent { pub ino: u32, pub name: alloc::vec::Vec<u8> }`
  - `pub fn read_dir(&self, dir_ino: u32) -> Result<alloc::vec::Vec<SffsDirent>, Errno>` — walks dirent records across the directory's data (via `read_at` into a block-sized buffer per block so records never straddle a block), applying `isValidDirEntry`; skips `ino==0`; INCLUDES `.`/`..` (callers filter). Returns `ENOTDIR` if not a directory.

- [ ] **Step 1: Write the failing test**
```rust
#[test]
fn read_dir_lists_root_entries() {
    let fs = Sffs::mount(unwrap_vfsi(TINY_VFS).unwrap()).unwrap();
    let names: alloc::vec::Vec<alloc::vec::Vec<u8>> =
        fs.read_dir(ROOT_INO).unwrap().into_iter().map(|e| e.name).collect();
    for want in [b"hello.txt".as_slice(), b"dir", b"link", b"big.txt"] {
        assert!(names.iter().any(|n| n.as_slice() == want), "missing {:?}", want);
    }
    // ENOTDIR on a non-directory: hello.txt's inode
    let file_ino = fs.read_dir(ROOT_INO).unwrap().into_iter()
        .find(|e| e.name == b"hello.txt").unwrap().ino;
    assert!(fs.read_dir(file_ino).is_err());
}
```

- [ ] **Step 2: Run test to verify it fails**
Run: `cargo test ... sffs::tests::read_dir` → FAIL.

- [ ] **Step 3: Write minimal implementation**
```rust
use alloc::vec::Vec;
const DIRENT_HEADER: usize = 8;

pub struct SffsDirent { pub ino: u32, pub name: Vec<u8> }

impl<'a> Sffs<'a> {
    pub fn read_dir(&self, dir_ino: u32) -> Result<Vec<SffsDirent>, Errno> {
        let st = self.stat_ino(dir_ino)?;
        if file_type(st.mode) != 0x4000 { return Err(Errno::ENOTDIR); }
        let size = st.size;
        let mut out = Vec::new();
        let mut block_start = 0u64;
        let mut block = [0u8; BLOCK_SIZE];
        while block_start < size {
            let this = core::cmp::min(BLOCK_SIZE as u64, size - block_start) as usize;
            let n = self.read_at(dir_ino, block_start, &mut block[..this])?;
            if n == 0 { break; }
            let mut off = 0usize;
            while off + DIRENT_HEADER <= n {
                let ino = u32::from_le_bytes([block[off], block[off+1], block[off+2], block[off+3]]);
                let rec_len = u16::from_le_bytes([block[off+4], block[off+5]]) as usize;
                let name_len = u16::from_le_bytes([block[off+6], block[off+7]]) as usize;
                // isValidDirEntry: rec_len>=8 && %4==0 && off+rec_len<=blockEnd && name_len<=rec_len-8
                if rec_len < DIRENT_HEADER || rec_len % 4 != 0
                    || off + rec_len > n || name_len > rec_len - DIRENT_HEADER {
                    break; // corrupt: stop scanning this block
                }
                if ino != 0 {
                    out.push(SffsDirent {
                        ino,
                        name: block[off + DIRENT_HEADER..off + DIRENT_HEADER + name_len].to_vec(),
                    });
                }
                off += rec_len;
            }
            block_start += BLOCK_SIZE as u64;
        }
        Ok(out)
    }
}
```

- [ ] **Step 4: Run test to verify it passes**
Run: `cargo test ... sffs::tests::read_dir` → PASS.

- [ ] **Step 5: Commit**
```bash
git add crates/runtime-core/src/sffs.rs
git commit -m "VFS: SFFS directory iteration (Phase 5 Inc 3b.1)"
```

---

### Task 8: Name lookup (`lookup`)

**Files:** Modify `crates/runtime-core/src/sffs.rs`

**Interfaces:**
- Consumes: `read_dir` (Task 7).
- Produces: `pub fn lookup(&self, dir_ino: u32, name: &[u8]) -> Result<u32, Errno>` — returns the child ino or `ENOENT`. (Uses `read_dir`; the vendor's `DirIndex` cache is an in-process optimization with no on-disk form, so a linear scan is correct.)

- [ ] **Step 1: Write the failing test**
```rust
#[test]
fn lookup_finds_children_and_misses() {
    let fs = Sffs::mount(unwrap_vfsi(TINY_VFS).unwrap()).unwrap();
    let dir = fs.lookup(ROOT_INO, b"dir").unwrap();
    assert_eq!(fs.stat_ino(dir).unwrap().mode & 0xf000, 0x4000);
    assert!(fs.lookup(dir, b"nested.txt").is_ok());
    assert!(fs.lookup(ROOT_INO, b"nope").is_err());
}
```

- [ ] **Step 2: Run test to verify it fails**
Run: `cargo test ... sffs::tests::lookup` → FAIL.

- [ ] **Step 3: Write minimal implementation**
```rust
impl<'a> Sffs<'a> {
    pub fn lookup(&self, dir_ino: u32, name: &[u8]) -> Result<u32, Errno> {
        for e in self.read_dir(dir_ino)? {
            if e.name == name { return Ok(e.ino); }
        }
        Err(Errno::ENOENT)
    }
}
```

- [ ] **Step 4: Run test to verify it passes**
Run: `cargo test ... sffs::tests::lookup` → PASS.

- [ ] **Step 5: Commit**
```bash
git add crates/runtime-core/src/sffs.rs
git commit -m "VFS: SFFS name lookup (Phase 5 Inc 3b.1)"
```

---

### Task 9: Readlink (`read_link`) — inline + data-block

**Files:** Modify `crates/runtime-core/src/sffs.rs`

**Interfaces:**
- Consumes: `stat_ino`, `read_at`, `inode_offset` (Tasks 4, 6).
- Produces: `pub fn read_link(&self, ino: u32) -> Result<Vec<u8>, Errno>` — `EINVAL` if not `S_IFLNK`; if `size <= 40` reads the target inline from the inode's DIRECT area (`inode_offset+48 .. +48+size`), else reads via `read_at(ino, 0, size)`.

- [ ] **Step 1: Write the failing test**
```rust
#[test]
fn read_link_inline_target() {
    let fs = Sffs::mount(unwrap_vfsi(TINY_VFS).unwrap()).unwrap();
    let link = fs.lookup(ROOT_INO, b"link").unwrap();
    assert_eq!(fs.stat_ino(link).unwrap().mode & 0xf000, 0xa000);
    assert_eq!(fs.read_link(link).unwrap(), b"hello.txt");
    // non-symlink => EINVAL
    let file = fs.lookup(ROOT_INO, b"hello.txt").unwrap();
    assert!(fs.read_link(file).is_err());
}
```

- [ ] **Step 2: Run test to verify it fails**
Run: `cargo test ... sffs::tests::read_link` → FAIL.

- [ ] **Step 3: Write minimal implementation**
```rust
const INLINE_SYMLINK_SIZE: u64 = 40;
// INO_DIRECT (48) already defined in Task 5.

impl<'a> Sffs<'a> {
    pub fn read_link(&self, ino: u32) -> Result<Vec<u8>, Errno> {
        let st = self.stat_ino(ino)?;
        if file_type(st.mode) != 0xa000 { return Err(Errno::EINVAL); }
        let size = st.size;
        if size <= INLINE_SYMLINK_SIZE {
            let o = self.inode_offset(ino) + INO_DIRECT;
            let end = o.checked_add(size as usize).ok_or(Errno::EIO)?;
            if end > self.bytes.len() { return Err(Errno::EIO); }
            return Ok(self.bytes[o..end].to_vec());
        }
        let mut buf = alloc::vec![0u8; size as usize];
        let n = self.read_at(ino, 0, &mut buf)?;
        buf.truncate(n);
        Ok(buf)
    }
}
```

- [ ] **Step 4: Run test to verify it passes**
Run: `cargo test ... sffs::tests::read_link` → PASS.

- [ ] **Step 5: Commit**
```bash
git add crates/runtime-core/src/sffs.rs
git commit -m "VFS: SFFS readlink (inline + data-block) (Phase 5 Inc 3b.1)"
```

---

### Task 10: Path resolution (`resolve`) — components, ENOTDIR, symlink follow, ELOOP

**Files:** Modify `crates/runtime-core/src/sffs.rs`

**Interfaces:**
- Consumes: `lookup`, `stat_ino`, `read_link` (Tasks 8, 4, 9).
- Produces: `pub fn resolve(&self, path: &[u8], follow_final: bool) -> Result<u32, Errno>` — absolute-path resolution from `ROOT_INO`, splitting on `/`, verifying each intermediate is a directory (`ENOTDIR`), following symlinks (intermediate always; final iff `follow_final`), splicing symlink targets (absolute target restarts at root), capped at `MAX_SYMLINK_HOPS=8` (`ELOOP`). This is the `stat` (follow) vs `lstat` (no-follow-final) entry point later increments wire to.

- [ ] **Step 1: Write the failing test**
```rust
#[test]
fn resolve_paths_and_symlink() {
    let fs = Sffs::mount(unwrap_vfsi(TINY_VFS).unwrap()).unwrap();
    // exact content read through a resolved path
    let ino = fs.resolve(b"/hello.txt", true).unwrap();
    let mut buf = [0u8; 32];
    let n = fs.read_at(ino, 0, &mut buf).unwrap();
    assert_eq!(&buf[..n], b"hello sffs\n");
    // nested
    assert!(fs.resolve(b"/dir/nested.txt", true).is_ok());
    // symlink: follow vs no-follow
    let via_link = fs.resolve(b"/link", true).unwrap();       // -> hello.txt
    let direct = fs.resolve(b"/hello.txt", true).unwrap();
    assert_eq!(via_link, direct);
    let link_itself = fs.resolve(b"/link", false).unwrap();   // the symlink inode
    assert_eq!(fs.stat_ino(link_itself).unwrap().mode & 0xf000, 0xa000);
    // ENOTDIR: descend through a file
    assert!(fs.resolve(b"/hello.txt/x", true).is_err());
    // ENOENT
    assert!(fs.resolve(b"/nope", true).is_err());
}
```

- [ ] **Step 2: Run test to verify it fails**
Run: `cargo test ... sffs::tests::resolve` → FAIL.

- [ ] **Step 3: Write minimal implementation**
```rust
const MAX_SYMLINK_HOPS: u32 = 8;

impl<'a> Sffs<'a> {
    pub fn resolve(&self, path: &[u8], follow_final: bool) -> Result<u32, Errno> {
        // Build the component queue (absolute paths only; leading '/' required).
        if path.first() != Some(&b'/') { return Err(Errno::EINVAL); }
        let mut comps: alloc::collections::VecDeque<Vec<u8>> = path
            .split(|&c| c == b'/').filter(|c| !c.is_empty())
            .map(|c| c.to_vec()).collect();
        let mut cur = ROOT_INO;
        let mut hops = 0u32;
        while let Some(comp) = comps.pop_front() {
            let is_final = comps.is_empty();
            let st = self.stat_ino(cur)?;
            if file_type(st.mode) != 0x4000 { return Err(Errno::ENOTDIR); }
            if comp.as_slice() == b"." { continue; }
            if comp.as_slice() == b".." { continue; } // root's .. is root; nested handled below
            let child = self.lookup(cur, &comp)?;
            let cst = self.stat_ino(child)?;
            let is_link = file_type(cst.mode) == 0xa000;
            if is_link && (!is_final || follow_final) {
                hops += 1;
                if hops > MAX_SYMLINK_HOPS { return Err(Errno::ELOOP); }
                let target = self.read_link(child)?;
                let absolute = target.first() == Some(&b'/');
                let spliced: alloc::collections::VecDeque<Vec<u8>> = target
                    .split(|&c| c == b'/').filter(|c| !c.is_empty())
                    .map(|c| c.to_vec()).collect();
                if absolute { cur = ROOT_INO; }
                // Prepend spliced target components before the remaining ones.
                for c in spliced.into_iter().rev() { comps.push_front(c); }
                continue;
            }
            cur = child;
        }
        Ok(cur)
    }
}
```
NOTE on `..`: this minimal version treats `..` as no-op (correct for root; nested `..` needs a parent stack). The base `/` images the overlay loads are canonical and the kernel's own resolver already handles `..` before this layer is consulted (later wiring), so full `..` support is deferred; add a parent-stack only if a fixture proves it necessary. Document this limit in a code comment.

- [ ] **Step 4: Run test to verify it passes**
Run: `cargo test ... sffs::tests::resolve` → PASS.

- [ ] **Step 5: Commit**
```bash
git add crates/runtime-core/src/sffs.rs
git commit -m "VFS: SFFS path resolution + symlink follow (Phase 5 Inc 3b.1)"
```

---

### Task 11: Real-image integration test (skip-if-available)

**Files:** Modify `crates/runtime-core/src/sffs.rs` (test module only)

**Interfaces:**
- Consumes: the whole public API.
- Produces: an integration test that, when `local-binaries/source-only-v1/programs/wasm32/rootfs.vfs` (uncompressed) exists, parses it and cross-checks against the host — validating the parser on a real ~16 MB image with deep trees, indirect blocks, and many inodes. Skips cleanly when absent (mirrors the `skipIf(!available)` host-test pattern).

- [ ] **Step 1: Write the test**
```rust
#[test]
fn real_rootfs_image_lists_root_and_reads_passwd() {
    // std is available in tests. Locate the uncompressed real image; skip if absent.
    let candidates = [
        "../../local-binaries/source-only-v1/programs/wasm32/rootfs.vfs",
        "../../host/wasm/rootfs.vfs",
    ];
    let path = candidates.iter().find(|p| std::path::Path::new(p).exists());
    let Some(path) = path else { eprintln!("skip: no rootfs.vfs"); return; };
    let image = std::fs::read(path).unwrap();
    let fs = Sffs::mount(unwrap_vfsi(&image).unwrap()).unwrap();
    // Root lists the usual FHS dirs.
    let names: std::collections::BTreeSet<Vec<u8>> =
        fs.read_dir(ROOT_INO).unwrap().into_iter().map(|e| e.name).collect();
    for want in [b"etc".as_slice(), b"usr", b"bin"] {
        assert!(names.iter().any(|n| n.as_slice() == want), "root missing {:?}", want);
    }
    // /etc/passwd resolves and reads non-empty (exercises deeper paths + reads).
    let ino = fs.resolve(b"/etc/passwd", true).unwrap();
    let size = fs.stat_ino(ino).unwrap().size as usize;
    let mut buf = vec![0u8; size];
    let n = fs.read_at(ino, 0, &mut buf).unwrap();
    assert_eq!(n, size);
    assert!(buf.windows(5).any(|w| w == b"root:"), "passwd should contain root:");
}
```
NOTE: adjust the relative candidate paths to be correct from the crate root at test time (Cargo runs tests with CWD = crate dir `crates/runtime-core`). If the uncompressed `rootfs.vfs` is not present in this worktree, generate it via the local build or leave the test to skip — CI coverage of the real image is deferred to the wiring increment where the kernel runs against the projection.

- [ ] **Step 2: Run test**
Run: `cargo test -p runtime-core --target "$(rustc -vV | sed -n 's/^host: //p')" sffs`
Expected: all `sffs` tests PASS (integration test runs if the image exists, else prints skip).

- [ ] **Step 3: Confirm the wasm build stays clean**
Run: `cargo build -p kandelo -Z build-std=core,alloc`
Expected: builds; `sffs` is compiled into the kernel wasm but not yet called (dead-code-eliminated), so no ABI/size surprise.

- [ ] **Step 4: Commit**
```bash
git add crates/runtime-core/src/sffs.rs
git commit -m "VFS: SFFS real-image integration test (Phase 5 Inc 3b.1)"
```

---

## Self-review notes

- **Spec coverage:** Container unwrap (Task 2), superblock (3), inode/stat (4), block map incl. indirect/double-indirect (5), positioned read w/ holes + EOF clamp (6), dirent iteration + validation (7), lookup (8), readlink inline+block (9), path resolve + symlink + ENOTDIR + ELOOP (10), real-image (11). All read-path methods from the SFFS spec §6 are covered except `statfs` (a later wiring concern) and `..`-parent-walk (deferred with a documented limit — the kernel resolver owns `..` above this layer).
- **Deferred, on purpose:** device/special files (SFFS has none — spec §5), the `DirIndex` cache (in-process only), all mutations, `statfs`, full `..`. Each is noted where relevant.
- **Type consistency:** `Sffs<'a>`, `SffsStat`, `SffsDirent`, `unwrap_vfsi`, `mount`, `stat_ino`, `block_map`, `read_at`, `read_dir`, `lookup`, `read_link`, `resolve`, `file_type`, `ROOT_INO` — names are used consistently across tasks.
- **Open confirmations for the executor (verify before/at Task 2-3, do not guess):** (a) the exact `runtime-core` package name for `-p`; (b) the `Errno` import path and that `EINVAL/ENOENT/EIO/ENOTDIR/ELOOP` variants exist; (c) `MemoryFileSystem.saveImage()` returns uncompressed VFSI bytes and `symlink(target, path)` arg order (Task 1). If `saveImage()` compresses, emit uncompressed via the memory-fs raw image path and confirm against `memory-fs.ts`.
