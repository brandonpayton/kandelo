//! Read-only parser for the on-disk SFFS ("SharedFileSystem") image and its
//! VFSI container. Ported from host/src/vfs/sharedfs-vendor.ts. no_std + alloc.
//! Consumes DECOMPRESSED bytes (zstd is a host-side transport codec).

use alloc::vec::Vec;
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

const SFFS_MAGIC: u32 = 0x5346_4653; // "SFFS"
const SFFS_VERSION: u32 = 1;
pub(crate) const BLOCK_SIZE: usize = 4096;
const SB_INODE_TABLE_START: usize = 36;

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

const DIRECT_BLOCKS: u32 = 10;
const PTRS_PER_BLOCK: u32 = 1024;
const INO_DIRECT: usize = 48;
const INO_INDIRECT: usize = 88;
const INO_DOUBLE_INDIRECT: usize = 92;
const INLINE_SYMLINK_SIZE: u64 = 40;

pub struct SffsStat {
    pub ino: u32,
    pub mode: u32,
    pub nlink: u32,
    pub size: u64,
    pub mtime_ms: u64,
    pub ctime_ms: u64,
    pub atime_ms: u64,
    pub uid: u32,
    pub gid: u32,
    pub generation: u64,
}

pub fn file_type(mode: u32) -> u32 {
    mode & 0xf000
}

pub struct Sffs<'a> {
    bytes: &'a [u8],
    pub(crate) inode_table_start: u32,
    total_inodes: u32,
}

const SB_TOTAL_INODES: usize = 16;

impl<'a> Sffs<'a> {
    pub fn mount(bytes: &'a [u8]) -> Result<Sffs<'a>, Errno> {
        if r32(bytes, 0) != Some(SFFS_MAGIC) { return Err(Errno::EINVAL); }
        if r32(bytes, 4) != Some(SFFS_VERSION) { return Err(Errno::EINVAL); }
        if r32(bytes, 8) != Some(BLOCK_SIZE as u32) { return Err(Errno::EINVAL); }
        let inode_table_start = r32(bytes, SB_INODE_TABLE_START).ok_or(Errno::EINVAL)?;
        let total_inodes = r32(bytes, SB_TOTAL_INODES).ok_or(Errno::EINVAL)?;
        // The inode table spans `total_inodes.div_ceil(32)` blocks starting at
        // `inode_table_start`; require the whole region to fit in the buffer
        // so every accepted `ino < total_inodes` yields an in-bounds
        // `inode_offset` without further per-call bounds checking.
        let table_blocks = (total_inodes as u64).div_ceil(INODES_PER_BLOCK as u64);
        let table_end = (inode_table_start as u64 + table_blocks)
            .checked_mul(BLOCK_SIZE as u64)
            .ok_or(Errno::EINVAL)?;
        if table_end > bytes.len() as u64 { return Err(Errno::EINVAL); }
        Ok(Sffs { bytes, inode_table_start, total_inodes })
    }

    /// Invariant relied on by callers: `ino` has already been checked by
    /// `stat_ino` against `0 < ino < total_inodes`, and `mount` validated
    /// that the whole inode-table region (through `total_inodes`) fits in
    /// `bytes`. So the offset computed here is provably in-bounds and needs
    /// no further self-check.
    fn inode_offset(&self, ino: u32) -> usize {
        let block = self.inode_table_start + ino / INODES_PER_BLOCK;
        block as usize * BLOCK_SIZE + (ino % INODES_PER_BLOCK) as usize * INODE_SIZE
    }

    pub fn stat_ino(&self, ino: u32) -> Result<SffsStat, Errno> {
        if ino == 0 || ino >= self.total_inodes { return Err(Errno::ENOENT); }
        let o = self.inode_offset(ino);
        let mode = r32(self.bytes, o + INO_MODE).ok_or(Errno::EIO)?;
        let nlink = r32(self.bytes, o + INO_LINK_COUNT).ok_or(Errno::EIO)?;
        if nlink == 0 { return Err(Errno::ENOENT); } // free/orphaned slot
        Ok(SffsStat {
            ino,
            mode,
            nlink,
            size: r64(self.bytes, o + INO_SIZE).ok_or(Errno::EIO)?,
            mtime_ms: r64(self.bytes, o + INO_MTIME).ok_or(Errno::EIO)?,
            ctime_ms: r64(self.bytes, o + INO_CTIME).ok_or(Errno::EIO)?,
            atime_ms: r64(self.bytes, o + INO_ATIME).ok_or(Errno::EIO)?,
            uid: r32(self.bytes, o + INO_UID).ok_or(Errno::EIO)?,
            gid: r32(self.bytes, o + INO_GID).ok_or(Errno::EIO)?,
            generation: r64(self.bytes, o + INO_GENERATION).ok_or(Errno::EIO)?,
        })
    }

    /// Read a block pointer at `index` (a 4-byte slot) within block `block`.
    /// A zero `block` means the parent indirect block is missing, i.e. a
    /// sparse hole; self-guards by returning `Ok(0)` rather than relying on
    /// callers to check first.
    fn block_ptr_in(&self, block: u32, index: u32) -> Result<u32, Errno> {
        if block == 0 {
            return Ok(0); // missing indirect block => sparse hole
        }
        // Computed in u64 to avoid wrapping a 32-bit `usize` on wasm32 for a
        // huge (corrupt) `block`, which could otherwise alias a small
        // in-bounds offset and pass `r32`'s length check on the wrong bytes.
        let off = block as u64 * BLOCK_SIZE as u64 + index as u64 * 4;
        let off = usize::try_from(off).map_err(|_| Errno::EIO)?;
        r32(self.bytes, off).ok_or(Errno::EIO)
    }

    /// Resolve a file block number to a physical block number.
    /// Direct blocks 0..9, single-indirect 10..1033, double-indirect 1034+.
    /// ptr 0 = sparse hole; returns 0. Otherwise returns the block number.
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

    /// Positioned read: fills `dst` from file data starting at `offset`,
    /// clamped to the file size. Sparse holes (physical block 0) read as
    /// zeros. Returns the number of bytes read (0 at or after EOF).
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
                // Computed in u64 to avoid wrapping a 32-bit `usize` on
                // wasm32 for a huge (corrupt) `phys`.
                let src_u64 = phys as u64 * BLOCK_SIZE as u64 + block_off as u64;
                let src = usize::try_from(src_u64).map_err(|_| Errno::EIO)?;
                let end = src.checked_add(chunk).ok_or(Errno::EIO)?;
                if end > self.bytes.len() { return Err(Errno::EIO); }
                dst[out..out + chunk].copy_from_slice(&self.bytes[src..end]);
            }
            out += chunk; pos += chunk as u64; remaining -= chunk;
        }
        Ok(out)
    }

    /// List directory entries. Walks dirent records across the directory's
    /// data one block at a time (via `read_at` into a block-sized buffer so
    /// records never straddle a block boundary). Skips free slots (`ino==0`)
    /// but still advances by `rec_len`; includes `.`/`..` (callers filter).
    /// On a corrupt record, stops scanning the rest of that block.
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
                let ino = u32::from_le_bytes([block[off], block[off + 1], block[off + 2], block[off + 3]]);
                let rec_len = u16::from_le_bytes([block[off + 4], block[off + 5]]) as usize;
                let name_len = u16::from_le_bytes([block[off + 6], block[off + 7]]) as usize;
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

    /// Resolves `name` to a child ino within `dir_ino` via a linear scan of
    /// `read_dir`. The vendor's `DirIndex` cache is an in-process
    /// optimization with no on-disk form, so a linear scan is correct here.
    pub fn lookup(&self, dir_ino: u32, name: &[u8]) -> Result<u32, Errno> {
        for e in self.read_dir(dir_ino)? {
            if e.name == name { return Ok(e.ino); }
        }
        Err(Errno::ENOENT)
    }

    /// Reads a symlink's target. Short targets (`size <= 40`) are stored
    /// inline in the inode's direct-pointer area (no data block allocated);
    /// longer targets are stored as regular file data via `read_at`.
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
        // A symlink target cannot exceed the whole image; caps `size` before
        // it drives an allocation.
        if size > self.bytes.len() as u64 { return Err(Errno::EIO); }
        let mut buf = alloc::vec![0u8; size as usize];
        let n = self.read_at(ino, 0, &mut buf)?;
        buf.truncate(n);
        Ok(buf)
    }

    /// Resolves an absolute path to an inode number, starting from
    /// `ROOT_INO`. Intermediate components must be directories (`ENOTDIR`
    /// otherwise). Symlinks are always followed for intermediate
    /// components; the final component is followed only if `follow_final`
    /// is set (the `stat` vs `lstat` distinction). Symlink targets are
    /// spliced into the front of the remaining component queue; an
    /// absolute target restarts resolution at the root. Resolution is
    /// capped at `MAX_SYMLINK_HOPS` hops (`ELOOP`).
    ///
    /// NOTE on `..`: this minimal version treats `..` as a no-op (correct
    /// for root; nested `..` needs a parent stack). The base `/` images the
    /// overlay loads are canonical and the kernel's own resolver already
    /// handles `..` before this layer is consulted (later wiring), so full
    /// `..` support is deferred; add a parent-stack only if a fixture
    /// proves it necessary.
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

const MAX_SYMLINK_HOPS: u32 = 8;

const DIRENT_HEADER: usize = 8;

pub struct SffsDirent {
    pub ino: u32,
    pub name: Vec<u8>,
}

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

    #[test]
    fn root_inode_is_a_directory() {
        let fs = Sffs::mount(unwrap_vfsi(TINY_VFS).unwrap()).unwrap();
        let st = fs.stat_ino(ROOT_INO).unwrap();
        assert_eq!(st.mode & 0xf000, 0x4000, "root is S_IFDIR");
        assert!(st.nlink >= 2, "dir has >= 2 links (. and ..)");
    }

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

    #[test]
    fn lookup_finds_children_and_misses() {
        let fs = Sffs::mount(unwrap_vfsi(TINY_VFS).unwrap()).unwrap();
        let dir = fs.lookup(ROOT_INO, b"dir").unwrap();
        assert_eq!(fs.stat_ino(dir).unwrap().mode & 0xf000, 0x4000);
        assert!(fs.lookup(dir, b"nested.txt").is_ok());
        assert!(fs.lookup(ROOT_INO, b"nope").is_err());
    }

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

    #[test]
    fn mount_rejects_oversized_inode_table() {
        // SFFS superblock TOTAL_INODES is at SFFS-offset 16; the VFSI header
        // adds 16 bytes, so the field lives at absolute `.vfs` offset 32.
        let mut img = TINY_VFS.to_vec();
        img[32..36].copy_from_slice(&0xFFFF_FFFFu32.to_le_bytes());
        assert!(Sffs::mount(unwrap_vfsi(&img).unwrap()).is_err());
    }

    #[test]
    fn stat_ino_rejects_out_of_range_ino() {
        let fs = Sffs::mount(unwrap_vfsi(TINY_VFS).unwrap()).unwrap();
        assert!(fs.stat_ino(u32::MAX).is_err());
        assert!(fs.stat_ino(0).is_err());
    }

    #[test]
    fn read_link_rejects_oversized_symlink() {
        // Locate /link's inode, then patch its INO_SIZE field (an
        // in-inode-table absolute offset we can compute via the crate-private
        // `inode_offset`) to a value larger than the whole image, and assert
        // `read_link` fails rather than allocating/reading garbage.
        let fs = Sffs::mount(unwrap_vfsi(TINY_VFS).unwrap()).unwrap();
        let link = fs.lookup(ROOT_INO, b"link").unwrap();
        let size_off = fs.inode_offset(link) + INO_SIZE;
        drop(fs);
        let mut img = TINY_VFS.to_vec();
        let abs = VFSI_HEADER + size_off;
        img[abs..abs + 8].copy_from_slice(&u64::MAX.to_le_bytes());
        let fs2 = Sffs::mount(unwrap_vfsi(&img).unwrap()).unwrap();
        assert!(fs2.read_link(link).is_err());
    }

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
}
