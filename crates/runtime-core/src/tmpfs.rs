//! In-kernel tmpfs backing Kandelo's scratch mounts (`/tmp`, `/var/tmp`,
//! `/var/log`, `/var/run`, `/home/maker`, `/root`, `/srv`).
//!
//! Part of Phase 5 of the rust-first runtime migration: filesystem *authority*
//! moves from the TypeScript host into the portable Rust kernel core. Scratch
//! mounts start empty, so this first slice needs no tar/zip/image parser — it is
//! a pure in-memory inode tree. See
//! `docs/plans/2026-08-28-phase5-vfs-to-rust.md`.
//!
//! Path resolution, symlink walking, `..`/mount crossing, and access checks are
//! already owned by `syscalls::resolve_namespace_path_from`; every path this
//! module receives is therefore an already-canonical, mount-relative-resolved
//! absolute path. This module owns only the *flat store* for scratch prefixes:
//! given a canonical path it serves lstat/open/read/write/mkdir/readdir/unlink.
//!
//! # Handle encoding
//! An open tmpfs regular file is named by a negative host handle
//! `-(TMPFS_FILE_HANDLE_BASE + inode_index)`; an open tmpfs directory stream by
//! `-(TMPFS_DIR_HANDLE_BASE + dir_iter_index)`. These ranges are disjoint from
//! every other negative-handle class (pipes, devices, procfs bufs, synthetic
//! regulars at `1e9`). The read/write cursor lives in the per-OFD
//! `OpenFileDesc::offset` field (like host files), so tmpfs is not a
//! shared-cursor backing.
//!
//! # NOTE on the mount table
//! The scratch mount layout is currently mirrored from
//! `host/src/vfs/default-mounts.ts`. Until the host passes mount config to the
//! kernel (a later increment), this list is the single Rust-side source of truth
//! and must be kept in sync with that file.

use alloc::collections::BTreeMap;
use alloc::vec::Vec;
use core::cell::UnsafeCell;
use core::hint::spin_loop;
use core::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};

use wasm_posix_shared::mode::{S_IFDIR, S_IFLNK, S_IFMT, S_IFREG, S_IFSOCK};
use wasm_posix_shared::Errno;
use wasm_posix_shared::WasmStat;
use wasm_posix_shared::WasmStatfs;

// Open-file creation flags we honor here (mirrors syscalls.rs values).
const O_ACCMODE: u32 = 0o3;
const O_RDONLY: u32 = 0o0;
const O_CREAT: u32 = 0o100;
const O_EXCL: u32 = 0o200;
const O_TRUNC: u32 = 0o1000;
const O_DIRECTORY: u32 = 0o200000;

/// Directory entry type codes as reported through getdents64 `d_type`.
const DT_FIFO: u32 = 1;
const DT_DIR: u32 = 4;
const DT_REG: u32 = 8;
const DT_LNK: u32 = 10;
const DT_SOCK: u32 = 12;

/// Dirent `d_type` for an inode.
fn dirent_type(inode: &Inode) -> u8 {
    match inode.kind {
        InodeKind::Dir(_) => DT_DIR as u8,
        InodeKind::Symlink(_) => DT_LNK as u8,
        InodeKind::Regular(_) => DT_REG as u8,
        InodeKind::Special(type_bits) => {
            if type_bits & S_IFMT == S_IFSOCK {
                DT_SOCK as u8
            } else {
                DT_FIFO as u8
            }
        }
    }
}

/// Disjoint negative-handle bases. Kept far from the small pipe/device/procfs
/// sentinels and from `SYNTHETIC_REGULAR_HANDLE_BASE` (1e9).
pub const TMPFS_FILE_HANDLE_BASE: i64 = 2_000_000_000;
pub const TMPFS_DIR_HANDLE_BASE: i64 = 3_000_000_000;

/// One synthetic `st_dev` per scratch mount so cross-mount `rename`/`link`
/// correctly raise EXDEV and `st_dev`-based file identity stays distinct.
const TMPFS_DEV_BASE: u64 = 0x7400_0000;

struct ScratchMount {
    /// Canonical mount point, no trailing slash (except the impossible "/").
    prefix: &'static [u8],
    /// Permission bits only (no `S_IFMT`).
    mode: u32,
    uid: u32,
    gid: u32,
    st_dev: u64,
}

/// Mirror of the `scratch` entries in `host/src/vfs/default-mounts.ts`.
const SCRATCH_MOUNTS: &[ScratchMount] = &[
    ScratchMount { prefix: b"/tmp", mode: 0o1777, uid: 0, gid: 0, st_dev: TMPFS_DEV_BASE },
    ScratchMount { prefix: b"/var/tmp", mode: 0o1777, uid: 0, gid: 0, st_dev: TMPFS_DEV_BASE + 1 },
    ScratchMount { prefix: b"/var/log", mode: 0o755, uid: 0, gid: 0, st_dev: TMPFS_DEV_BASE + 2 },
    ScratchMount { prefix: b"/var/run", mode: 0o755, uid: 0, gid: 0, st_dev: TMPFS_DEV_BASE + 3 },
    ScratchMount { prefix: b"/home/maker", mode: 0o755, uid: 1000, gid: 1000, st_dev: TMPFS_DEV_BASE + 4 },
    ScratchMount { prefix: b"/root", mode: 0o700, uid: 0, gid: 0, st_dev: TMPFS_DEV_BASE + 5 },
    ScratchMount { prefix: b"/srv", mode: 0o755, uid: 0, gid: 0, st_dev: TMPFS_DEV_BASE + 6 },
];

enum InodeKind {
    Dir(BTreeMap<Vec<u8>, u32>),
    Regular(Vec<u8>),
    /// Symbolic link holding its target path bytes.
    Symlink(Vec<u8>),
    /// A metadata-only special file (AF_UNIX socket or FIFO). The `S_IF*` type
    /// bits are stored; the communication endpoint lives in the socket registry
    /// or fifo table, keyed by path.
    Special(u32),
}

struct Inode {
    kind: InodeKind,
    /// Permission bits only (no `S_IFMT`).
    mode: u32,
    uid: u32,
    gid: u32,
    /// Number of directory entries (hard links) referencing this inode. A
    /// directory counts `.` plus one per child subdir plus its parent's entry.
    nlink: u32,
    /// Live open descriptions. The inode is freed only when both `nlink` and
    /// `open_count` reach zero (POSIX unlink-while-open).
    open_count: u32,
    st_dev: u64,
    ino: u64,
    atime_sec: u64,
    atime_nsec: u32,
    mtime_sec: u64,
    mtime_nsec: u32,
    ctime_sec: u64,
    ctime_nsec: u32,
}

impl Inode {
    /// Create an inode, stamping all three timestamps with the current
    /// published wall-clock time (see `set_now`).
    fn new(kind: InodeKind, mode: u32, uid: u32, gid: u32, nlink: u32, st_dev: u64, ino: u64) -> Self {
        let (sec, nsec) = now();
        Inode {
            kind,
            mode,
            uid,
            gid,
            nlink,
            open_count: 0,
            st_dev,
            ino,
            atime_sec: sec,
            atime_nsec: nsec,
            mtime_sec: sec,
            mtime_nsec: nsec,
            ctime_sec: sec,
            ctime_nsec: nsec,
        }
    }

    /// Stamp mtime and ctime with the current published wall-clock time (a
    /// content mutation: write, truncate).
    fn touch_modified(&mut self) {
        let (sec, nsec) = now();
        self.mtime_sec = sec;
        self.mtime_nsec = nsec;
        self.ctime_sec = sec;
        self.ctime_nsec = nsec;
    }

    /// Stamp ctime only (a metadata mutation: chmod, chown).
    fn touch_changed(&mut self) {
        let (sec, nsec) = now();
        self.ctime_sec = sec;
        self.ctime_nsec = nsec;
    }

    /// Clear the set-user-ID bit, and the set-group-ID bit on a group-executable
    /// file, on a content-modifying operation (write/truncate) — the POSIX
    /// "a successful write clears set-user-ID" rule, matching the host path.
    fn clear_setid_on_modify(&mut self) {
        const S_ISUID: u32 = 0o4000;
        const S_ISGID: u32 = 0o2000;
        const S_IXGRP: u32 = 0o0010;
        self.mode &= !S_ISUID;
        if self.mode & S_IXGRP != 0 {
            self.mode &= !S_ISGID;
        }
    }

    fn stat(&self) -> WasmStat {
        let type_bits = match self.kind {
            InodeKind::Dir(_) => S_IFDIR,
            InodeKind::Regular(_) => S_IFREG,
            InodeKind::Symlink(_) => S_IFLNK,
            InodeKind::Special(type_bits) => type_bits,
        };
        let size = match &self.kind {
            InodeKind::Dir(entries) => entries.len() as u64,
            InodeKind::Regular(data) => data.len() as u64,
            InodeKind::Symlink(target) => target.len() as u64,
            InodeKind::Special(_) => 0,
        };
        WasmStat {
            st_dev: self.st_dev,
            st_ino: self.ino,
            st_mode: type_bits | (self.mode & 0o7777),
            st_nlink: self.nlink,
            st_uid: self.uid,
            st_gid: self.gid,
            st_size: size,
            st_atime_sec: self.atime_sec,
            st_atime_nsec: self.atime_nsec,
            st_mtime_sec: self.mtime_sec,
            st_mtime_nsec: self.mtime_nsec,
            st_ctime_sec: self.ctime_sec,
            st_ctime_nsec: self.ctime_nsec,
            _pad: 0,
        }
    }

    fn is_dir(&self) -> bool {
        matches!(self.kind, InodeKind::Dir(_))
    }
}

/// A materialized directory stream: a snapshot of entries plus a cursor. Taken
/// at `opendir` time; concurrent modifications after that are not reflected,
/// which matches how the host readdir stream behaves.
struct DirIter {
    entries: Vec<(Vec<u8>, u64, u32)>,
    cursor: usize,
}

struct TmpfsState {
    /// Inode slab; index is the inode's stable table index (distinct from `ino`).
    inodes: Vec<Option<Inode>>,
    free_inodes: Vec<u32>,
    /// Root inode index per `SCRATCH_MOUNTS` entry, lazily created on first use.
    mount_roots: Vec<Option<u32>>,
    /// Open directory streams keyed by dir-iter index.
    dir_iters: Vec<Option<DirIter>>,
    free_dir_iters: Vec<u32>,
    next_ino: u64,
}

impl TmpfsState {
    fn new() -> Self {
        TmpfsState {
            inodes: Vec::new(),
            free_inodes: Vec::new(),
            mount_roots: alloc::vec![None; SCRATCH_MOUNTS.len()],
            dir_iters: Vec::new(),
            free_dir_iters: Vec::new(),
            next_ino: 1,
        }
    }

    fn alloc_ino(&mut self) -> u64 {
        let ino = self.next_ino;
        self.next_ino += 1;
        ino
    }

    fn insert_inode(&mut self, inode: Inode) -> u32 {
        if let Some(idx) = self.free_inodes.pop() {
            self.inodes[idx as usize] = Some(inode);
            idx
        } else {
            let idx = self.inodes.len() as u32;
            self.inodes.push(Some(inode));
            idx
        }
    }

    fn get(&self, idx: u32) -> Option<&Inode> {
        self.inodes.get(idx as usize).and_then(|slot| slot.as_ref())
    }

    fn get_mut(&mut self, idx: u32) -> Option<&mut Inode> {
        self.inodes
            .get_mut(idx as usize)
            .and_then(|slot| slot.as_mut())
    }

    /// Recompute a directory's link count from scratch: 2 (self + `.`) plus one
    /// per child subdirectory (each child dir's `..`). Robust against any move,
    /// replace, or removal, avoiding fragile incremental bookkeeping.
    fn recompute_dir_nlink(&mut self, dir_idx: u32) {
        let child_dirs = match self.get(dir_idx) {
            Some(inode) => match &inode.kind {
                InodeKind::Dir(entries) => entries
                    .values()
                    .filter(|&&child| self.get(child).is_some_and(|i| i.is_dir()))
                    .count(),
                _ => return,
            },
            None => return,
        };
        if let Some(inode) = self.get_mut(dir_idx) {
            inode.nlink = 2 + child_dirs as u32;
        }
    }

    /// Free an inode if it has no remaining names and no open descriptions.
    fn maybe_free(&mut self, idx: u32) {
        let drop_it = self
            .get(idx)
            .map(|inode| inode.nlink == 0 && inode.open_count == 0)
            .unwrap_or(false);
        if drop_it {
            self.inodes[idx as usize] = None;
            self.free_inodes.push(idx);
        }
    }

    /// Root inode index for a mount, creating it on first touch.
    fn mount_root(&mut self, mount_idx: usize) -> u32 {
        if let Some(root) = self.mount_roots[mount_idx] {
            return root;
        }
        let mount = &SCRATCH_MOUNTS[mount_idx];
        let ino = self.alloc_ino();
        // A fresh directory has two links: its own entry and `.`.
        let root = self.insert_inode(Inode::new(
            InodeKind::Dir(BTreeMap::new()),
            mount.mode,
            mount.uid,
            mount.gid,
            2,
            mount.st_dev,
            ino,
        ));
        self.mount_roots[mount_idx] = Some(root);
        root
    }

    /// Walk `components` from `mount_root`, returning the target inode index.
    /// Every intermediate component must be an existing directory.
    fn walk(&self, mut cur: u32, components: &[&[u8]]) -> Result<u32, Errno> {
        for comp in components {
            let inode = self.get(cur).ok_or(Errno::ENOENT)?;
            match &inode.kind {
                InodeKind::Dir(entries) => {
                    cur = *entries.get(*comp).ok_or(Errno::ENOENT)?;
                }
                _ => return Err(Errno::ENOTDIR),
            }
        }
        Ok(cur)
    }

    /// Resolve a path to (parent_dir_idx, final_component, target_if_present).
    /// The mount root itself is returned as `(root, None, Some(root))`.
    fn resolve<'a>(
        &mut self,
        mount_idx: usize,
        rel: &'a [&'a [u8]],
    ) -> Result<(u32, Option<&'a [u8]>, Option<u32>), Errno> {
        let root = self.mount_root(mount_idx);
        if rel.is_empty() {
            return Ok((root, None, Some(root)));
        }
        let (parent_comps, last) = rel.split_at(rel.len() - 1);
        let parent = self.walk(root, parent_comps)?;
        let last = last[0];
        let parent_inode = self.get(parent).ok_or(Errno::ENOENT)?;
        let target = match &parent_inode.kind {
            InodeKind::Dir(entries) => entries.get(last).copied(),
            _ => return Err(Errno::ENOTDIR),
        };
        Ok((parent, Some(last), target))
    }
}

struct TmpfsGlobal {
    locked: AtomicBool,
    state: UnsafeCell<Option<TmpfsState>>,
}

struct UnlockOnDrop<'a>(&'a AtomicBool);

impl Drop for UnlockOnDrop<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

impl TmpfsGlobal {
    const fn new() -> Self {
        TmpfsGlobal {
            locked: AtomicBool::new(false),
            state: UnsafeCell::new(None),
        }
    }

    fn with<R>(&'static self, f: impl FnOnce(&mut TmpfsState) -> R) -> R {
        while self
            .locked
            .compare_exchange_weak(false, true, Ordering::Acquire, Ordering::Relaxed)
            .is_err()
        {
            spin_loop();
        }
        let _unlock = UnlockOnDrop(&self.locked);
        // SAFETY: `locked` serializes every access; Kandelo enters one kernel
        // instance at a time, exactly like the other GlobalBackingTable stores.
        let slot = unsafe { &mut *self.state.get() };
        f(slot.get_or_insert_with(TmpfsState::new))
    }
}

// SAFETY: identical invariant to descriptor_backing's GlobalBackingTable — the
// spinlock is the sole gate and no reference escapes the closure.
unsafe impl Sync for TmpfsGlobal {}

static TMPFS: TmpfsGlobal = TmpfsGlobal::new();

/// Split a canonical mount-relative remainder into non-empty components.
fn split_components(rel: &[u8]) -> Vec<&[u8]> {
    rel.split(|&b| b == b'/').filter(|c| !c.is_empty()).collect()
}

/// If `path` lies within a scratch mount, return `(mount_idx, relative_bytes)`.
/// `relative_bytes` is the portion after the mount prefix (may be empty for the
/// mount root). Chooses the longest matching prefix.
fn match_mount(path: &[u8]) -> Option<(usize, &[u8])> {
    let mut best: Option<(usize, &[u8])> = None;
    for (idx, mount) in SCRATCH_MOUNTS.iter().enumerate() {
        let p = mount.prefix;
        let is_match = path == p
            || (path.len() > p.len() && path.starts_with(p) && path[p.len()] == b'/');
        if is_match {
            let better = best.map_or(true, |(_, r)| p.len() > (path.len() - r.len()));
            if better {
                best = Some((idx, &path[p.len()..]));
            }
        }
    }
    best
}

/// Master switch for in-kernel tmpfs authority over the scratch mounts.
///
/// Defaults OFF so this machinery is dormant: real hosts keep serving the
/// scratch mounts from their own backends until the cutover increment enables
/// tmpfs (and removes the host-side scratch mounts) at boot. Tests enable it
/// explicitly. `owns_path` stays a pure prefix predicate; the syscall dispatch
/// gates on `claims_path`, which additionally requires this flag.
static TMPFS_ENABLED: AtomicBool = AtomicBool::new(false);

/// Enable or disable in-kernel tmpfs authority. Returns the previous value.
pub fn set_enabled(enabled: bool) -> bool {
    TMPFS_ENABLED.swap(enabled, Ordering::SeqCst)
}

/// Whether in-kernel tmpfs authority is currently active.
pub fn is_enabled() -> bool {
    TMPFS_ENABLED.load(Ordering::SeqCst)
}

/// The wall-clock time (CLOCK_REALTIME) the syscall layer stamps onto inode
/// metadata mutations. The tmpfs core is host-free, so the kernel reads the host
/// clock once per mutating syscall and publishes it here; the store reads it
/// when stamping atime/mtime/ctime. Defaults to the epoch until first set.
static TMPFS_NOW_SEC: AtomicU64 = AtomicU64::new(0);
static TMPFS_NOW_NSEC: AtomicU32 = AtomicU32::new(0);

/// Publish the current wall-clock time for subsequent metadata stamps.
pub fn set_now(sec: u64, nsec: u32) {
    TMPFS_NOW_SEC.store(sec, Ordering::Relaxed);
    TMPFS_NOW_NSEC.store(nsec, Ordering::Relaxed);
}

fn now() -> (u64, u32) {
    (
        TMPFS_NOW_SEC.load(Ordering::Relaxed),
        TMPFS_NOW_NSEC.load(Ordering::Relaxed),
    )
}

/// Whether a canonical path lies within a scratch-mount prefix. Pure predicate;
/// does not consider whether tmpfs authority is enabled.
pub fn owns_path(path: &[u8]) -> bool {
    match_mount(path).is_some()
}

/// Whether the in-kernel tmpfs currently claims authority over a path: tmpfs is
/// enabled AND the path is within a scratch mount. The syscall dispatch gates
/// every path-op interception on this.
pub fn claims_path(path: &[u8]) -> bool {
    is_enabled() && owns_path(path)
}

/// Whether a host handle names an open tmpfs regular file.
pub fn is_tmpfs_file_handle(handle: i64) -> bool {
    handle <= -TMPFS_FILE_HANDLE_BASE && handle > -TMPFS_DIR_HANDLE_BASE
}

/// Whether a host handle names an open tmpfs directory stream.
///
/// Bounded on both sides so the band `(-4e9, -3e9]` stays disjoint from the
/// rootfs overlay handle bands below it (`rootfs.rs`: file `(-5e9, -4e9]`, dir
/// `(-6e9, -5e9]`). The dir-iter index never approaches 1e9, so the 1e9-wide
/// band is never exhausted. Mirrors the synthetic-regular bounding from
/// Increment 1b.
pub fn is_tmpfs_dir_handle(handle: i64) -> bool {
    handle <= -TMPFS_DIR_HANDLE_BASE
        && handle > -(TMPFS_DIR_HANDLE_BASE + HANDLE_BAND_WIDTH)
}

/// Width of each disjoint negative-handle band (see `is_tmpfs_dir_handle`).
pub(crate) const HANDLE_BAND_WIDTH: i64 = 1_000_000_000;

fn file_handle_to_inode(handle: i64) -> Result<u32, Errno> {
    if !is_tmpfs_file_handle(handle) {
        return Err(Errno::EBADF);
    }
    u32::try_from(-handle - TMPFS_FILE_HANDLE_BASE).map_err(|_| Errno::EBADF)
}

fn inode_to_file_handle(idx: u32) -> i64 {
    -(TMPFS_FILE_HANDLE_BASE + idx as i64)
}

fn dir_handle_to_iter(handle: i64) -> Result<u32, Errno> {
    if !is_tmpfs_dir_handle(handle) {
        return Err(Errno::EBADF);
    }
    u32::try_from(-handle - TMPFS_DIR_HANDLE_BASE).map_err(|_| Errno::EBADF)
}

fn iter_to_dir_handle(idx: u32) -> i64 {
    -(TMPFS_DIR_HANDLE_BASE + idx as i64)
}

/// lstat a canonical tmpfs path. (No symlinks in this increment, so `stat`
/// resolves identically.)
pub fn lstat(path: &[u8]) -> Result<WasmStat, Errno> {
    let (mount_idx, rel) = match_mount(path).ok_or(Errno::ENOENT)?;
    let comps = split_components(rel);
    TMPFS.with(|state| {
        let root = state.mount_root(mount_idx);
        let idx = state.walk(root, &comps)?;
        Ok(state.get(idx).ok_or(Errno::ENOENT)?.stat())
    })
}

/// Open (optionally creating) a tmpfs regular file. Returns the encoded host
/// handle and the inode number. The caller is responsible for building the OFD
/// and honoring the access mode; `open_count` is incremented here and released
/// via [`release_handle`].
pub fn open(path: &[u8], flags: u32, mode: u32, uid: u32, gid: u32) -> Result<i64, Errno> {
    let (mount_idx, rel) = match_mount(path).ok_or(Errno::ENOENT)?;
    let comps = split_components(rel);
    TMPFS.with(|state| {
        let (parent, last, target) = state.resolve(mount_idx, &comps)?;
        let st_dev = SCRATCH_MOUNTS[mount_idx].st_dev;
        let inode_idx = match target {
            Some(existing) => {
                if flags & O_CREAT != 0 && flags & O_EXCL != 0 {
                    return Err(Errno::EEXIST);
                }
                let inode = state.get(existing).ok_or(Errno::ENOENT)?;
                // A socket node cannot be opened as a file; FIFOs are handled by
                // the fifo path before tmpfs::open is ever reached.
                if matches!(inode.kind, InodeKind::Special(_)) {
                    return Err(Errno::ENXIO);
                }
                if inode.is_dir() {
                    if flags & O_ACCMODE != O_RDONLY {
                        return Err(Errno::EISDIR);
                    }
                } else if flags & O_DIRECTORY != 0 {
                    return Err(Errno::ENOTDIR);
                }
                if flags & O_TRUNC != 0 && !inode.is_dir() && flags & O_ACCMODE != O_RDONLY {
                    if let Some(node) = state.get_mut(existing) {
                        if let InodeKind::Regular(data) = &mut node.kind {
                            // O_TRUNC on an already-empty file is a no-op and
                            // preserves set-ID bits; a real shrink clears them.
                            let shrank = !data.is_empty();
                            data.clear();
                            if shrank {
                                node.clear_setid_on_modify();
                            }
                        }
                    }
                }
                existing
            }
            None => {
                if flags & O_CREAT == 0 {
                    return Err(Errno::ENOENT);
                }
                if flags & O_DIRECTORY != 0 {
                    return Err(Errno::ENOTDIR);
                }
                let last = last.ok_or(Errno::ENOENT)?;
                let ino = state.alloc_ino();
                let new_idx = state.insert_inode(Inode::new(
                    InodeKind::Regular(Vec::new()),
                    mode & 0o7777,
                    uid,
                    gid,
                    1,
                    st_dev,
                    ino,
                ));
                if let Some(InodeKind::Dir(entries)) = state.get_mut(parent).map(|i| &mut i.kind) {
                    entries.insert(last.to_vec(), new_idx);
                } else {
                    return Err(Errno::ENOTDIR);
                }
                new_idx
            }
        };
        // A directory opened O_RDONLY is legal (e.g. for fstat/fchdir) but this
        // increment routes directory descriptors through opendir; refuse here so
        // callers use the right path and never treat a dir handle as a file.
        if state.get(inode_idx).ok_or(Errno::ENOENT)?.is_dir() {
            return Err(Errno::EISDIR);
        }
        state.get_mut(inode_idx).ok_or(Errno::ENOENT)?.open_count += 1;
        Ok(inode_to_file_handle(inode_idx))
    })
}

/// Read up to `buf.len()` bytes at `offset`. Returns the number read (0 at EOF).
pub fn read(handle: i64, offset: i64, buf: &mut [u8]) -> Result<usize, Errno> {
    let idx = file_handle_to_inode(handle)?;
    if offset < 0 {
        return Err(Errno::EINVAL);
    }
    TMPFS.with(|state| {
        let inode = state.get(idx).ok_or(Errno::EBADF)?;
        let InodeKind::Regular(data) = &inode.kind else {
            return Err(Errno::EISDIR);
        };
        let start = offset as usize;
        if start >= data.len() {
            return Ok(0);
        }
        let n = core::cmp::min(buf.len(), data.len() - start);
        buf[..n].copy_from_slice(&data[start..start + n]);
        Ok(n)
    })
}

/// Write `buf` at `offset`, growing (and zero-filling any gap) as needed.
pub fn write(handle: i64, offset: i64, buf: &[u8]) -> Result<usize, Errno> {
    let idx = file_handle_to_inode(handle)?;
    if offset < 0 {
        return Err(Errno::EINVAL);
    }
    TMPFS.with(|state| {
        let inode = state.get_mut(idx).ok_or(Errno::EBADF)?;
        {
            let InodeKind::Regular(data) = &mut inode.kind else {
                return Err(Errno::EISDIR);
            };
            let start = offset as usize;
            let end = start.checked_add(buf.len()).ok_or(Errno::EFBIG)?;
            if end > data.len() {
                data.resize(end, 0);
            }
            data[start..end].copy_from_slice(buf);
        }
        // A zero-length write is not a modification and preserves set-ID bits.
        if !buf.is_empty() {
            inode.clear_setid_on_modify();
        }
        inode.touch_modified();
        Ok(buf.len())
    })
}

/// Current size of an open tmpfs file (for `SEEK_END`).
pub fn size(handle: i64) -> Result<i64, Errno> {
    let idx = file_handle_to_inode(handle)?;
    TMPFS.with(|state| {
        let inode = state.get(idx).ok_or(Errno::EBADF)?;
        match &inode.kind {
            InodeKind::Regular(data) => Ok(data.len() as i64),
            _ => Err(Errno::EISDIR),
        }
    })
}

/// fstat an open tmpfs file handle.
pub fn fstat(handle: i64) -> Result<WasmStat, Errno> {
    let idx = file_handle_to_inode(handle)?;
    TMPFS.with(|state| Ok(state.get(idx).ok_or(Errno::EBADF)?.stat()))
}

/// Truncate an open tmpfs regular file to `length`, zero-filling any growth.
/// The caller enforces access mode and RLIMIT_FSIZE.
pub fn truncate_handle(handle: i64, length: i64) -> Result<(), Errno> {
    let idx = file_handle_to_inode(handle)?;
    let new_len = usize::try_from(length).map_err(|_| Errno::EINVAL)?;
    TMPFS.with(|state| {
        let inode = state.get_mut(idx).ok_or(Errno::EBADF)?;
        let changed = match &mut inode.kind {
            InodeKind::Regular(data) => {
                let old_len = data.len();
                data.resize(new_len, 0);
                old_len != new_len
            }
            _ => return Err(Errno::EISDIR),
        };
        // A truncate to the current size is a no-op and preserves set-ID bits.
        if changed {
            inode.clear_setid_on_modify();
        }
        inode.touch_modified();
        Ok(())
    })
}

/// Add an owning reference (fork/dup inheriting a tmpfs fd). Returns whether the
/// handle was recognized as a tmpfs file handle.
pub fn add_ref_handle(handle: i64) -> bool {
    let Ok(idx) = file_handle_to_inode(handle) else {
        return false;
    };
    TMPFS.with(|state| {
        if let Some(inode) = state.get_mut(idx) {
            inode.open_count += 1;
            true
        } else {
            false
        }
    })
}

/// Drop one owning reference (close/exec-cloexec). Frees the inode if it was the
/// last reference and the file had already been unlinked. Returns `true` when
/// this drop released the final open reference (open_count reached zero),
/// mirroring `descriptor_backing::release_for_ofd` so the caller knows to
/// release this description's advisory locks. A stale/unrecognized handle
/// returns `false`.
pub fn release_handle(handle: i64) -> bool {
    let Ok(idx) = file_handle_to_inode(handle) else {
        return false;
    };
    TMPFS.with(|state| {
        let Some(inode) = state.get_mut(idx) else {
            return false;
        };
        inode.open_count = inode.open_count.saturating_sub(1);
        let was_last = inode.open_count == 0;
        state.maybe_free(idx);
        was_last
    })
}

/// Whether a tmpfs handle still names a live backing (trust-boundary check).
pub fn handle_is_live(handle: i64) -> bool {
    if let Ok(idx) = file_handle_to_inode(handle) {
        return TMPFS.with(|state| state.get(idx).is_some());
    }
    if let Ok(idx) = dir_handle_to_iter(handle) {
        return TMPFS.with(|state| {
            state
                .dir_iters
                .get(idx as usize)
                .map(|slot| slot.is_some())
                .unwrap_or(false)
        });
    }
    false
}

/// mkdir a tmpfs directory.
pub fn mkdir(path: &[u8], mode: u32, uid: u32, gid: u32) -> Result<(), Errno> {
    let (mount_idx, rel) = match_mount(path).ok_or(Errno::ENOENT)?;
    let comps = split_components(rel);
    if comps.is_empty() {
        // The mount root already exists.
        return Err(Errno::EEXIST);
    }
    TMPFS.with(|state| {
        let (parent, last, target) = state.resolve(mount_idx, &comps)?;
        if target.is_some() {
            return Err(Errno::EEXIST);
        }
        let last = last.ok_or(Errno::ENOENT)?;
        let st_dev = SCRATCH_MOUNTS[mount_idx].st_dev;
        let ino = state.alloc_ino();
        let new_idx = state.insert_inode(Inode::new(
            InodeKind::Dir(BTreeMap::new()),
            mode & 0o7777,
            uid,
            gid,
            2,
            st_dev,
            ino,
        ));
        match state.get_mut(parent).map(|i| &mut i.kind) {
            Some(InodeKind::Dir(entries)) => {
                entries.insert(last.to_vec(), new_idx);
            }
            _ => return Err(Errno::ENOTDIR),
        }
        // A new subdirectory bumps the parent's link count (its `..`).
        if let Some(parent_inode) = state.get_mut(parent) {
            parent_inode.nlink += 1;
        }
        Ok(())
    })
}

/// Remove an empty tmpfs directory.
pub fn rmdir(path: &[u8]) -> Result<(), Errno> {
    let (mount_idx, rel) = match_mount(path).ok_or(Errno::ENOENT)?;
    let comps = split_components(rel);
    if comps.is_empty() {
        return Err(Errno::EBUSY); // cannot remove a mount root
    }
    TMPFS.with(|state| {
        let (parent, last, target) = state.resolve(mount_idx, &comps)?;
        let target = target.ok_or(Errno::ENOENT)?;
        let last = last.ok_or(Errno::ENOENT)?;
        match &state.get(target).ok_or(Errno::ENOENT)?.kind {
            InodeKind::Dir(entries) => {
                if !entries.is_empty() {
                    return Err(Errno::ENOTEMPTY);
                }
            }
            _ => return Err(Errno::ENOTDIR),
        }
        if let Some(InodeKind::Dir(entries)) = state.get_mut(parent).map(|i| &mut i.kind) {
            entries.remove(last);
        }
        if let Some(parent_inode) = state.get_mut(parent) {
            parent_inode.nlink = parent_inode.nlink.saturating_sub(1);
        }
        if let Some(inode) = state.get_mut(target) {
            inode.nlink = 0;
        }
        state.maybe_free(target);
        Ok(())
    })
}

/// Unlink a tmpfs non-directory name.
pub fn unlink(path: &[u8]) -> Result<(), Errno> {
    let (mount_idx, rel) = match_mount(path).ok_or(Errno::ENOENT)?;
    let comps = split_components(rel);
    if comps.is_empty() {
        return Err(Errno::EISDIR);
    }
    TMPFS.with(|state| {
        let (parent, last, target) = state.resolve(mount_idx, &comps)?;
        let target = target.ok_or(Errno::ENOENT)?;
        let last = last.ok_or(Errno::ENOENT)?;
        if state.get(target).ok_or(Errno::ENOENT)?.is_dir() {
            return Err(Errno::EISDIR);
        }
        if let Some(InodeKind::Dir(entries)) = state.get_mut(parent).map(|i| &mut i.kind) {
            entries.remove(last);
        }
        if let Some(inode) = state.get_mut(target) {
            inode.nlink = inode.nlink.saturating_sub(1);
        }
        state.maybe_free(target);
        Ok(())
    })
}

/// Create a metadata-only special node (AF_UNIX socket or FIFO) at a tmpfs path.
/// `type_bits` selects S_IFSOCK or S_IFIFO. EEXIST if the name is already taken.
/// The communication endpoint (registry entry / fifo pipe) is owned elsewhere,
/// keyed by path; this only creates the filesystem node.
pub fn mknod_special(
    path: &[u8],
    mode: u32,
    uid: u32,
    gid: u32,
    type_bits: u32,
) -> Result<(), Errno> {
    let (mount_idx, rel) = match_mount(path).ok_or(Errno::ENOENT)?;
    let comps = split_components(rel);
    if comps.is_empty() {
        return Err(Errno::EEXIST);
    }
    TMPFS.with(|state| {
        let (parent, last, existing) = state.resolve(mount_idx, &comps)?;
        if existing.is_some() {
            return Err(Errno::EEXIST);
        }
        let last = last.ok_or(Errno::ENOENT)?;
        let st_dev = SCRATCH_MOUNTS[mount_idx].st_dev;
        let ino = state.alloc_ino();
        let new_idx = state.insert_inode(Inode::new(
            InodeKind::Special(type_bits & S_IFMT),
            mode & 0o7777,
            uid,
            gid,
            1,
            st_dev,
            ino,
        ));
        match state.get_mut(parent).map(|i| &mut i.kind) {
            Some(InodeKind::Dir(entries)) => {
                entries.insert(last.to_vec(), new_idx);
            }
            _ => return Err(Errno::ENOTDIR),
        }
        Ok(())
    })
}

/// statfs for a tmpfs scratch mount: a memory-backed, nosuid filesystem.
/// Reports a generous nominal capacity (the store grows within kernel Wasm
/// memory, not a fixed reservation), so free-space precondition checks pass.
pub fn statfs(path: &[u8]) -> Result<WasmStatfs, Errno> {
    match_mount(path).ok_or(Errno::ENOENT)?;
    Ok(WasmStatfs {
        f_type: 0x0102_1994, // TMPFS_MAGIC
        f_bsize: 4096,
        f_blocks: 262_144, // 1 GiB nominal at 4 KiB blocks
        f_bfree: 262_144,
        f_bavail: 262_144,
        f_files: 65_536,
        f_ffree: 65_536,
        f_fsid: 0,
        f_namelen: 255,
        f_frsize: 4096,
        f_flags: wasm_posix_shared::statfs_flags::ST_NOSUID,
        _pad: 0,
    })
}

/// Rename `old` to `new` within the tmpfs. Both paths must lie in the *same*
/// scratch mount; a caller must map a cross-mount or tmpfs/host rename to EXDEV
/// before reaching here (this returns EXDEV defensively for cross-mount). POSIX
/// replace semantics: an existing destination of a compatible type is atomically
/// replaced; type mismatches yield ENOTDIR/EISDIR and a non-empty destination
/// directory yields ENOTEMPTY.
pub fn rename(old: &[u8], new: &[u8]) -> Result<(), Errno> {
    let (old_mount, old_rel) = match_mount(old).ok_or(Errno::ENOENT)?;
    let (new_mount, new_rel) = match_mount(new).ok_or(Errno::ENOENT)?;
    if old_mount != new_mount {
        return Err(Errno::EXDEV);
    }
    // A directory cannot be moved into its own subtree.
    if new.len() > old.len() && new.starts_with(old) && new[old.len()] == b'/' {
        return Err(Errno::EINVAL);
    }
    let old_comps = split_components(old_rel);
    let new_comps = split_components(new_rel);
    if old_comps.is_empty() || new_comps.is_empty() {
        return Err(Errno::EBUSY); // cannot rename a mount root
    }
    TMPFS.with(|state| {
        let (old_parent, old_name, old_target) = state.resolve(old_mount, &old_comps)?;
        let old_target = old_target.ok_or(Errno::ENOENT)?;
        let old_name = old_name.ok_or(Errno::ENOENT)?.to_vec();
        let (new_parent, new_name, new_existing) = state.resolve(new_mount, &new_comps)?;
        let new_name = new_name.ok_or(Errno::ENOENT)?.to_vec();

        // Renaming a name to itself (same inode) is a no-op.
        if new_existing == Some(old_target) {
            return Ok(());
        }

        let old_is_dir = state.get(old_target).ok_or(Errno::ENOENT)?.is_dir();

        if let Some(existing) = new_existing {
            let new_is_dir = state.get(existing).ok_or(Errno::ENOENT)?.is_dir();
            if old_is_dir && !new_is_dir {
                return Err(Errno::ENOTDIR);
            }
            if !old_is_dir && new_is_dir {
                return Err(Errno::EISDIR);
            }
            if new_is_dir {
                let empty = matches!(
                    &state.get(existing).ok_or(Errno::ENOENT)?.kind,
                    InodeKind::Dir(entries) if entries.is_empty()
                );
                if !empty {
                    return Err(Errno::ENOTEMPTY);
                }
            }
            // Detach and free the replaced destination.
            if let Some(InodeKind::Dir(entries)) = state.get_mut(new_parent).map(|i| &mut i.kind) {
                entries.remove(&new_name);
            }
            if let Some(inode) = state.get_mut(existing) {
                inode.nlink = 0;
            }
            state.maybe_free(existing);
        }

        // Detach the source name and reattach under the destination name.
        if let Some(InodeKind::Dir(entries)) = state.get_mut(old_parent).map(|i| &mut i.kind) {
            entries.remove(&old_name);
        }
        match state.get_mut(new_parent).map(|i| &mut i.kind) {
            Some(InodeKind::Dir(entries)) => {
                entries.insert(new_name, old_target);
            }
            _ => return Err(Errno::ENOTDIR),
        }

        // Parent link counts change when a subdirectory moves or a destination
        // directory is replaced; recompute both robustly.
        state.recompute_dir_nlink(old_parent);
        if new_parent != old_parent {
            state.recompute_dir_nlink(new_parent);
        }
        Ok(())
    })
}

/// Create a hard link `new` to the existing file `old` within one scratch mount.
/// Cross-mount links are EXDEV; hard links to directories are EPERM; an existing
/// destination is EEXIST. `old` is not dereferenced (the kernel already applied
/// the syscall's follow policy), so a link to a symlink links the symlink.
pub fn link(old: &[u8], new: &[u8]) -> Result<(), Errno> {
    let (old_mount, old_rel) = match_mount(old).ok_or(Errno::ENOENT)?;
    let (new_mount, new_rel) = match_mount(new).ok_or(Errno::ENOENT)?;
    if old_mount != new_mount {
        return Err(Errno::EXDEV);
    }
    let old_comps = split_components(old_rel);
    let new_comps = split_components(new_rel);
    if new_comps.is_empty() {
        return Err(Errno::EEXIST); // cannot link over a mount root
    }
    TMPFS.with(|state| {
        let old_idx = {
            let root = state.mount_root(old_mount);
            state.walk(root, &old_comps)?
        };
        if state.get(old_idx).ok_or(Errno::ENOENT)?.is_dir() {
            return Err(Errno::EPERM); // no hard links to directories
        }
        let (new_parent, new_name, new_existing) = state.resolve(new_mount, &new_comps)?;
        if new_existing.is_some() {
            return Err(Errno::EEXIST);
        }
        let new_name = new_name.ok_or(Errno::ENOENT)?.to_vec();
        match state.get_mut(new_parent).map(|i| &mut i.kind) {
            Some(InodeKind::Dir(entries)) => {
                entries.insert(new_name, old_idx);
            }
            _ => return Err(Errno::ENOTDIR),
        }
        if let Some(inode) = state.get_mut(old_idx) {
            inode.nlink += 1;
            inode.touch_changed();
        }
        Ok(())
    })
}

/// Open a directory stream over a tmpfs directory, returning an encoded handle.
pub fn opendir(path: &[u8]) -> Result<i64, Errno> {
    let (mount_idx, rel) = match_mount(path).ok_or(Errno::ENOENT)?;
    let comps = split_components(rel);
    TMPFS.with(|state| {
        let root = state.mount_root(mount_idx);
        let idx = state.walk(root, &comps)?;
        let entries = match &state.get(idx).ok_or(Errno::ENOENT)?.kind {
            InodeKind::Dir(map) => {
                let mut out: Vec<(Vec<u8>, u64, u32)> = Vec::with_capacity(map.len());
                for (name, &child_idx) in map.iter() {
                    let child = state.get(child_idx).ok_or(Errno::ENOENT)?;
                    out.push((name.clone(), child.ino, dirent_type(child) as u32));
                }
                out
            }
            _ => return Err(Errno::ENOTDIR),
        };
        let iter = DirIter { entries, cursor: 0 };
        let slot_idx = if let Some(i) = state.free_dir_iters.pop() {
            state.dir_iters[i as usize] = Some(iter);
            i
        } else {
            let i = state.dir_iters.len() as u32;
            state.dir_iters.push(Some(iter));
            i
        };
        Ok(iter_to_dir_handle(slot_idx))
    })
}

/// Read the next entry from a tmpfs directory stream. Returns
/// `Ok(Some((ino, d_type, name_len)))` after copying the name into `name_buf`,
/// or `Ok(None)` at end of stream. Mirrors the `host_readdir` contract.
pub fn readdir(handle: i64, name_buf: &mut [u8]) -> Result<Option<(u64, u32, usize)>, Errno> {
    let iter_idx = dir_handle_to_iter(handle)?;
    TMPFS.with(|state| {
        let iter = state
            .dir_iters
            .get_mut(iter_idx as usize)
            .and_then(|slot| slot.as_mut())
            .ok_or(Errno::EBADF)?;
        let Some((name, ino, d_type)) = iter.entries.get(iter.cursor) else {
            return Ok(None);
        };
        let n = name.len();
        if n > name_buf.len() {
            return Err(Errno::EINVAL);
        }
        name_buf[..n].copy_from_slice(name);
        let result = (*ino, *d_type, n);
        iter.cursor += 1;
        Ok(Some(result))
    })
}

/// Walk to a tmpfs inode index for a metadata update. The final component is
/// not followed (the kernel already resolved symlinks per the syscall's FOLLOW
/// policy before calling), so lchown-style callers land on the link itself.
fn walk_to_inode(path: &[u8]) -> Result<u32, Errno> {
    let (mount_idx, rel) = match_mount(path).ok_or(Errno::ENOENT)?;
    let comps = split_components(rel);
    TMPFS.with(|state| {
        let root = state.mount_root(mount_idx);
        state.walk(root, &comps)
    })
}

/// chmod a tmpfs path (permission bits only).
pub fn chmod(path: &[u8], mode: u32) -> Result<(), Errno> {
    let idx = walk_to_inode(path)?;
    TMPFS.with(|state| {
        let inode = state.get_mut(idx).ok_or(Errno::ENOENT)?;
        inode.mode = mode & 0o7777;
        inode.touch_changed();
        Ok(())
    })
}

/// chown a tmpfs path. A field of `u32::MAX` (-1) is left unchanged.
pub fn chown(path: &[u8], uid: u32, gid: u32, clear_setid: bool) -> Result<(), Errno> {
    let idx = walk_to_inode(path)?;
    TMPFS.with(|state| {
        let inode = state.get_mut(idx).ok_or(Errno::ENOENT)?;
        if uid != u32::MAX {
            inode.uid = uid;
        }
        if gid != u32::MAX {
            inode.gid = gid;
        }
        // POSIX: a chown by a process without appropriate privileges clears the
        // set-user-ID bit, and the set-group-ID bit when the file is group-
        // executable. This mirrors the host chown path (the OS clears them),
        // so a set-ID binary cannot survive a change of owner.
        if clear_setid {
            const S_ISUID: u32 = 0o4000;
            const S_ISGID: u32 = 0o2000;
            const S_IXGRP: u32 = 0o0010;
            inode.mode &= !S_ISUID;
            if inode.mode & S_IXGRP != 0 {
                inode.mode &= !S_ISGID;
            }
        }
        inode.touch_changed();
        Ok(())
    })
}

/// fchmod an open tmpfs file handle.
pub fn fchmod(handle: i64, mode: u32) -> Result<(), Errno> {
    let idx = file_handle_to_inode(handle)?;
    TMPFS.with(|state| {
        let inode = state.get_mut(idx).ok_or(Errno::EBADF)?;
        inode.mode = mode & 0o7777;
        inode.touch_changed();
        Ok(())
    })
}

/// fchown an open tmpfs file handle. A field of `u32::MAX` (-1) is unchanged.
pub fn fchown(handle: i64, uid: u32, gid: u32, clear_setid: bool) -> Result<(), Errno> {
    let idx = file_handle_to_inode(handle)?;
    TMPFS.with(|state| {
        let inode = state.get_mut(idx).ok_or(Errno::EBADF)?;
        if uid != u32::MAX {
            inode.uid = uid;
        }
        if gid != u32::MAX {
            inode.gid = gid;
        }
        // Mirror `chown`: an unprivileged owner change clears set-user-ID and
        // the set-group-ID bit on a group-executable file (host chown parity).
        if clear_setid {
            const S_ISUID: u32 = 0o4000;
            const S_ISGID: u32 = 0o2000;
            const S_IXGRP: u32 = 0o0010;
            inode.mode &= !S_ISUID;
            if inode.mode & S_IXGRP != 0 {
                inode.mode &= !S_ISGID;
            }
        }
        inode.touch_changed();
        Ok(())
    })
}

/// Set a tmpfs inode's timestamps to already-resolved values (the caller has
/// applied UTIME_NOW/UTIME_OMIT). ctime is set to the supplied change time.
pub fn utimensat(
    path: &[u8],
    atime_sec: u64,
    atime_nsec: u32,
    mtime_sec: u64,
    mtime_nsec: u32,
    ctime_sec: u64,
    ctime_nsec: u32,
) -> Result<(), Errno> {
    let idx = walk_to_inode(path)?;
    TMPFS.with(|state| {
        let inode = state.get_mut(idx).ok_or(Errno::ENOENT)?;
        inode.atime_sec = atime_sec;
        inode.atime_nsec = atime_nsec;
        inode.mtime_sec = mtime_sec;
        inode.mtime_nsec = mtime_nsec;
        inode.ctime_sec = ctime_sec;
        inode.ctime_nsec = ctime_nsec;
        Ok(())
    })
}

/// Create a symbolic link at a tmpfs path pointing at `target`.
pub fn symlink(target: &[u8], linkpath: &[u8], uid: u32, gid: u32) -> Result<(), Errno> {
    let (mount_idx, rel) = match_mount(linkpath).ok_or(Errno::ENOENT)?;
    let comps = split_components(rel);
    if comps.is_empty() {
        return Err(Errno::EEXIST);
    }
    if target.is_empty() {
        return Err(Errno::ENOENT);
    }
    TMPFS.with(|state| {
        let (parent, last, existing) = state.resolve(mount_idx, &comps)?;
        if existing.is_some() {
            return Err(Errno::EEXIST);
        }
        let last = last.ok_or(Errno::ENOENT)?;
        let st_dev = SCRATCH_MOUNTS[mount_idx].st_dev;
        let ino = state.alloc_ino();
        let new_idx = state.insert_inode(Inode::new(
            InodeKind::Symlink(target.to_vec()),
            0o777,
            uid,
            gid,
            1,
            st_dev,
            ino,
        ));
        match state.get_mut(parent).map(|i| &mut i.kind) {
            Some(InodeKind::Dir(entries)) => {
                entries.insert(last.to_vec(), new_idx);
            }
            _ => return Err(Errno::ENOTDIR),
        }
        Ok(())
    })
}

/// Read the target of a tmpfs symlink into `buf`, returning the number of bytes
/// copied (truncated to the buffer, matching readlink(2)). The final component
/// is not followed; parents are already resolved by the caller.
pub fn readlink(path: &[u8], buf: &mut [u8]) -> Result<usize, Errno> {
    let (mount_idx, rel) = match_mount(path).ok_or(Errno::ENOENT)?;
    let comps = split_components(rel);
    TMPFS.with(|state| {
        let root = state.mount_root(mount_idx);
        let idx = state.walk(root, &comps)?;
        match &state.get(idx).ok_or(Errno::ENOENT)?.kind {
            InodeKind::Symlink(target) => {
                let n = target.len().min(buf.len());
                buf[..n].copy_from_slice(&target[..n]);
                Ok(n)
            }
            _ => Err(Errno::EINVAL),
        }
    })
}

/// Sentinel host handle marking an open tmpfs *directory* descriptor. Distinct
/// from the procfs (-150) and devfs (-160) directory sentinels. A tmpfs
/// directory OFD carries this in both `host_handle` and `dir_host_handle`;
/// contents are regenerated per getdents from the live store (mirrors devfs), so
/// no per-open backing is needed.
pub const TMPFS_DIR_SENTINEL: i64 = -170;

/// Whether a canonical tmpfs path names an existing directory.
pub fn is_dir(path: &[u8]) -> bool {
    lstat(path)
        .map(|st| st.st_mode & S_IFMT == S_IFDIR)
        .unwrap_or(false)
}

/// getdents64 for a tmpfs directory: build the entry list from the live store
/// and hand it to the shared virtual-dirent formatter, which injects `.`/`..`
/// and honors the cookie/short-buffer protocol. Returns
/// `(bytes_written, new_cookie, exhausted)`.
pub fn getdents64(path: &[u8], buf: &mut [u8], offset: i64) -> Result<(usize, i64, bool), Errno> {
    let (mount_idx, rel) = match_mount(path).ok_or(Errno::ENOENT)?;
    let comps = split_components(rel);
    let (dir_ino, entries) = TMPFS.with(|state| {
        let root = state.mount_root(mount_idx);
        let idx = state.walk(root, &comps)?;
        let dir = state.get(idx).ok_or(Errno::ENOENT)?;
        let InodeKind::Dir(map) = &dir.kind else {
            return Err(Errno::ENOTDIR);
        };
        let dir_ino = dir.ino;
        let mut out: Vec<(Vec<u8>, u8, u64)> = Vec::with_capacity(map.len());
        for (name, &child_idx) in map.iter() {
            let child = state.get(child_idx).ok_or(Errno::ENOENT)?;
            out.push((name.clone(), dirent_type(child), child.ino));
        }
        Ok((dir_ino, out))
    })?;
    // `..` inode is not tracked across the tmpfs/host boundary; report the
    // directory's own inode, which callers never rely on for `..`.
    crate::procfs::write_virtual_dirents64(buf, offset, dir_ino, dir_ino, &entries)
}

/// Close a tmpfs directory stream.
pub fn closedir(handle: i64) -> Result<(), Errno> {
    let iter_idx = dir_handle_to_iter(handle)?;
    TMPFS.with(|state| {
        let slot = state
            .dir_iters
            .get_mut(iter_idx as usize)
            .ok_or(Errno::EBADF)?;
        if slot.is_none() {
            return Err(Errno::EBADF);
        }
        *slot = None;
        state.free_dir_iters.push(iter_idx);
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const O_RDWR: u32 = 0o2;

    // These tests run against the process-global TMPFS. Each test uses a unique
    // path subtree so they remain independent even when run in one binary.

    fn read_all(handle: i64) -> Vec<u8> {
        let mut out = Vec::new();
        let mut off = 0i64;
        let mut buf = [0u8; 8];
        loop {
            let n = read(handle, off, &mut buf).unwrap();
            if n == 0 {
                break;
            }
            out.extend_from_slice(&buf[..n]);
            off += n as i64;
        }
        out
    }

    #[test]
    fn ownership_matches_scratch_prefixes_only() {
        assert!(owns_path(b"/tmp"));
        assert!(owns_path(b"/tmp/a"));
        assert!(owns_path(b"/var/run/nginx.pid"));
        assert!(owns_path(b"/home/maker/x"));
        assert!(!owns_path(b"/tmpfoo")); // prefix must be a path boundary
        assert!(!owns_path(b"/usr/bin/sh"));
        assert!(!owns_path(b"/var")); // /var itself is not a scratch mount
    }

    #[test]
    fn create_write_read_roundtrip() {
        let p = b"/tmp/roundtrip.txt";
        let h = open(p, O_CREAT | O_RDWR, 0o644, 0, 0).unwrap();
        assert_eq!(write(h, 0, b"hello ").unwrap(), 6);
        assert_eq!(write(h, 6, b"world").unwrap(), 5);
        assert_eq!(read_all(h), b"hello world");
        let st = fstat(h).unwrap();
        assert_eq!(st.st_size, 11);
        assert_eq!(st.st_mode & S_IFMT, S_IFREG);
        assert_eq!(st.st_mode & 0o7777, 0o644);
        // lstat by path agrees with fstat.
        let lst = lstat(p).unwrap();
        assert_eq!(lst.st_ino, st.st_ino);
        assert_eq!(lst.st_size, 11);
        assert!(release_handle(h));
    }

    #[test]
    fn truncate_grows_and_shrinks() {
        let h = open(b"/tmp/trunc_h", O_CREAT | O_RDWR, 0o644, 0, 0).unwrap();
        write(h, 0, b"abcdef").unwrap();
        truncate_handle(h, 3).unwrap();
        assert_eq!(read_all(h), b"abc");
        truncate_handle(h, 5).unwrap();
        assert_eq!(read_all(h), &[b'a', b'b', b'c', 0, 0]);
        assert_eq!(fstat(h).unwrap().st_size, 5);
        release_handle(h);
    }

    #[test]
    fn special_node_socket_semantics() {
        mknod_special(b"/var/run/s.sock", 0o755, 7, 8, S_IFSOCK).unwrap();
        let st = lstat(b"/var/run/s.sock").unwrap();
        assert_eq!(st.st_mode & S_IFMT, S_IFSOCK);
        assert_eq!((st.st_uid, st.st_gid), (7, 8));
        assert_eq!(st.st_size, 0);
        // A socket node cannot be opened as a file.
        assert_eq!(
            open(b"/var/run/s.sock", O_RDWR, 0, 0, 0).unwrap_err(),
            Errno::ENXIO
        );
        // EEXIST on re-create; unlink removes it.
        assert_eq!(
            mknod_special(b"/var/run/s.sock", 0o755, 0, 0, S_IFSOCK).unwrap_err(),
            Errno::EEXIST
        );
        unlink(b"/var/run/s.sock").unwrap();
        assert_eq!(lstat(b"/var/run/s.sock").unwrap_err(), Errno::ENOENT);
    }

    #[test]
    fn hard_link_shares_inode_and_survives_unlink() {
        let h = open(b"/tmp/hl_a", O_CREAT | O_RDWR, 0o644, 0, 0).unwrap();
        write(h, 0, b"shared").unwrap();
        release_handle(h);
        link(b"/tmp/hl_a", b"/tmp/hl_b").unwrap();

        // Both names reference one inode (same ino) with nlink 2.
        let sa = lstat(b"/tmp/hl_a").unwrap();
        let sb = lstat(b"/tmp/hl_b").unwrap();
        assert_eq!(sa.st_ino, sb.st_ino);
        assert_eq!(sa.st_nlink, 2);

        // Write via one name is visible via the other.
        let hb = open(b"/tmp/hl_b", O_RDWR, 0, 0, 0).unwrap();
        write(hb, 0, b"HELLO!").unwrap();
        release_handle(hb);
        let ha = open(b"/tmp/hl_a", O_RDONLY, 0, 0, 0).unwrap();
        assert_eq!(read_all(ha), b"HELLO!");
        release_handle(ha);

        // Unlink one name: content persists under the other; nlink drops to 1.
        unlink(b"/tmp/hl_a").unwrap();
        assert_eq!(lstat(b"/tmp/hl_a").unwrap_err(), Errno::ENOENT);
        assert_eq!(lstat(b"/tmp/hl_b").unwrap().st_nlink, 1);

        // Guards: cross-mount EXDEV, directory EPERM, existing destination EEXIST.
        assert_eq!(link(b"/tmp/hl_b", b"/var/tmp/x").unwrap_err(), Errno::EXDEV);
        mkdir(b"/tmp/hl_d", 0o755, 0, 0).unwrap();
        assert_eq!(link(b"/tmp/hl_d", b"/tmp/hl_e").unwrap_err(), Errno::EPERM);
        let hc = open(b"/tmp/hl_c", O_CREAT | O_RDWR, 0o644, 0, 0).unwrap();
        release_handle(hc);
        assert_eq!(link(b"/tmp/hl_b", b"/tmp/hl_c").unwrap_err(), Errno::EEXIST);
    }

    #[test]
    fn rename_moves_replaces_and_guards() {
        // Simple file rename.
        let h = open(b"/tmp/rn_a", O_CREAT | O_RDWR, 0o644, 0, 0).unwrap();
        write(h, 0, b"data").unwrap();
        release_handle(h);
        rename(b"/tmp/rn_a", b"/tmp/rn_b").unwrap();
        assert_eq!(lstat(b"/tmp/rn_a").unwrap_err(), Errno::ENOENT);
        assert_eq!(lstat(b"/tmp/rn_b").unwrap().st_size, 4);

        // Rename over an existing file replaces it (source content wins).
        let h2 = open(b"/tmp/rn_c", O_CREAT | O_RDWR, 0o644, 0, 0).unwrap();
        write(h2, 0, b"longer").unwrap();
        release_handle(h2);
        rename(b"/tmp/rn_b", b"/tmp/rn_c").unwrap();
        assert_eq!(lstat(b"/tmp/rn_c").unwrap().st_size, 4);
        assert_eq!(lstat(b"/tmp/rn_b").unwrap_err(), Errno::ENOENT);

        // Cross-mount rename → EXDEV.
        assert_eq!(
            rename(b"/tmp/rn_c", b"/var/tmp/rn_c").unwrap_err(),
            Errno::EXDEV
        );

        // Directory rename + into-own-subtree guard.
        mkdir(b"/tmp/rn_d", 0o755, 0, 0).unwrap();
        mkdir(b"/tmp/rn_d/sub", 0o755, 0, 0).unwrap();
        assert_eq!(
            rename(b"/tmp/rn_d", b"/tmp/rn_d/sub/x").unwrap_err(),
            Errno::EINVAL
        );
        rename(b"/tmp/rn_d", b"/tmp/rn_e").unwrap();
        assert_eq!(lstat(b"/tmp/rn_e").unwrap().st_mode & S_IFMT, S_IFDIR);

        // Replacing a non-empty directory fails; type mismatches fail.
        mkdir(b"/tmp/rn_f", 0o755, 0, 0).unwrap();
        assert_eq!(
            rename(b"/tmp/rn_f", b"/tmp/rn_e").unwrap_err(),
            Errno::ENOTEMPTY
        );
        let h3 = open(b"/tmp/rn_g", O_CREAT | O_RDWR, 0o644, 0, 0).unwrap();
        release_handle(h3);
        assert_eq!(rename(b"/tmp/rn_g", b"/tmp/rn_e").unwrap_err(), Errno::EISDIR);
        assert_eq!(rename(b"/tmp/rn_e", b"/tmp/rn_g").unwrap_err(), Errno::ENOTDIR);
    }

    #[test]
    fn timestamps_track_create_write_and_utimensat() {
        set_now(1000, 5);
        let h = open(b"/tmp/ts", O_CREAT | O_RDWR, 0o644, 0, 0).unwrap();
        let st = fstat(h).unwrap();
        assert_eq!((st.st_mtime_sec, st.st_mtime_nsec), (1000, 5));
        assert_eq!(st.st_ctime_sec, 1000);
        assert_eq!(st.st_atime_sec, 1000);

        // A later write bumps mtime and ctime (not atime).
        set_now(2000, 0);
        write(h, 0, b"x").unwrap();
        let st = fstat(h).unwrap();
        assert_eq!(st.st_mtime_sec, 2000);
        assert_eq!(st.st_ctime_sec, 2000);
        assert_eq!(st.st_atime_sec, 1000);

        // utimensat sets explicit atime/mtime; ctime is the change time.
        utimensat(b"/tmp/ts", 500, 1, 600, 2, 2500, 3).unwrap();
        let st = lstat(b"/tmp/ts").unwrap();
        assert_eq!((st.st_atime_sec, st.st_atime_nsec), (500, 1));
        assert_eq!((st.st_mtime_sec, st.st_mtime_nsec), (600, 2));
        assert_eq!((st.st_ctime_sec, st.st_ctime_nsec), (2500, 3));
        release_handle(h);
    }

    #[test]
    fn chmod_chown_update_metadata() {
        let h = open(b"/tmp/meta", O_CREAT | O_RDWR, 0o644, 7, 7).unwrap();
        chmod(b"/tmp/meta", 0o600).unwrap();
        assert_eq!(lstat(b"/tmp/meta").unwrap().st_mode & 0o777, 0o600);
        chown(b"/tmp/meta", 1000, 1001, false).unwrap();
        let st = lstat(b"/tmp/meta").unwrap();
        assert_eq!((st.st_uid, st.st_gid), (1000, 1001));
        // u32::MAX leaves a field unchanged.
        chown(b"/tmp/meta", u32::MAX, 2002, false).unwrap();
        let st = lstat(b"/tmp/meta").unwrap();
        assert_eq!((st.st_uid, st.st_gid), (1000, 2002));
        // fchmod/fchown via the open handle.
        fchmod(h, 0o640).unwrap();
        fchown(h, 3003, u32::MAX, false).unwrap();
        let st = fstat(h).unwrap();
        assert_eq!(st.st_mode & 0o777, 0o640);
        assert_eq!((st.st_uid, st.st_gid), (3003, 2002));
        release_handle(h);
    }

    #[test]
    fn chown_clears_setid_for_unprivileged_caller() {
        let h = open(b"/tmp/setid", O_CREAT | O_RDWR, 0o644, 0, 0).unwrap();
        chmod(b"/tmp/setid", 0o6755).unwrap();
        assert_eq!(lstat(b"/tmp/setid").unwrap().st_mode & 0o7777, 0o6755);
        // Privileged (root-equivalent) chown preserves the set-ID bits.
        chown(b"/tmp/setid", 1000, 1000, false).unwrap();
        assert_eq!(lstat(b"/tmp/setid").unwrap().st_mode & 0o7777, 0o6755);
        // Unprivileged chown clears set-user-ID and (since group-executable)
        // set-group-ID, matching the host chown path.
        chown(b"/tmp/setid", 1000, 1001, true).unwrap();
        assert_eq!(lstat(b"/tmp/setid").unwrap().st_mode & 0o7777, 0o0755);
        release_handle(h);
    }

    #[test]
    fn write_and_truncate_clear_setid_only_on_real_modification() {
        let h = open(b"/tmp/wsetid", O_CREAT | O_RDWR, 0o644, 0, 0).unwrap();
        // A zero-length write preserves the set-ID bits (no modification).
        chmod(b"/tmp/wsetid", 0o6755).unwrap();
        write(h, 0, b"").unwrap();
        assert_eq!(lstat(b"/tmp/wsetid").unwrap().st_mode & 0o7777, 0o6755);
        // A real write clears set-user-ID + (group-exec) set-group-ID.
        write(h, 0, b"data").unwrap();
        assert_eq!(lstat(b"/tmp/wsetid").unwrap().st_mode & 0o7777, 0o0755);
        // A truncate to the current size preserves; a real shrink clears.
        chmod(b"/tmp/wsetid", 0o6755).unwrap();
        truncate_handle(h, 4).unwrap();
        assert_eq!(lstat(b"/tmp/wsetid").unwrap().st_mode & 0o7777, 0o6755);
        truncate_handle(h, 0).unwrap();
        assert_eq!(lstat(b"/tmp/wsetid").unwrap().st_mode & 0o7777, 0o0755);
        release_handle(h);
    }

    #[test]
    fn symlink_create_and_readlink() {
        symlink(b"/tmp/target", b"/tmp/mylink", 0, 0).unwrap();
        let st = lstat(b"/tmp/mylink").unwrap();
        assert_eq!(st.st_mode & S_IFMT, S_IFLNK);
        assert_eq!(st.st_size, 11); // len("/tmp/target")
        let mut buf = [0u8; 64];
        let n = readlink(b"/tmp/mylink", &mut buf).unwrap();
        assert_eq!(&buf[..n], b"/tmp/target");
        // readlink on a non-symlink is EINVAL; on a missing name is ENOENT.
        let f = open(b"/tmp/notlink", O_CREAT | O_RDWR, 0o644, 0, 0).unwrap();
        release_handle(f);
        assert_eq!(readlink(b"/tmp/notlink", &mut buf).unwrap_err(), Errno::EINVAL);
        assert_eq!(readlink(b"/tmp/nolink_x", &mut buf).unwrap_err(), Errno::ENOENT);
        // O_EXCL semantics: a symlink name already taken cannot be recreated.
        assert_eq!(symlink(b"x", b"/tmp/mylink", 0, 0).unwrap_err(), Errno::EEXIST);
    }

    #[test]
    fn write_past_end_zero_fills_gap() {
        let h = open(b"/tmp/sparse.bin", O_CREAT | O_RDWR, 0o644, 0, 0).unwrap();
        assert_eq!(write(h, 4, b"AB").unwrap(), 2);
        assert_eq!(read_all(h), &[0, 0, 0, 0, b'A', b'B']);
        release_handle(h);
    }

    #[test]
    fn o_excl_rejects_existing() {
        let p = b"/tmp/excl.txt";
        let h = open(p, O_CREAT | O_RDWR, 0o644, 0, 0).unwrap();
        release_handle(h);
        assert_eq!(
            open(p, O_CREAT | O_EXCL | O_RDWR, 0o644, 0, 0).unwrap_err(),
            Errno::EEXIST
        );
    }

    #[test]
    fn o_trunc_clears_content() {
        let p = b"/tmp/trunc.txt";
        let h = open(p, O_CREAT | O_RDWR, 0o644, 0, 0).unwrap();
        write(h, 0, b"content").unwrap();
        release_handle(h);
        let h2 = open(p, O_TRUNC | O_RDWR, 0o644, 0, 0).unwrap();
        assert_eq!(read_all(h2), b"");
        release_handle(h2);
    }

    #[test]
    fn open_missing_without_creat_is_enoent() {
        assert_eq!(open(b"/tmp/nope", O_RDONLY, 0, 0, 0).unwrap_err(), Errno::ENOENT);
    }

    #[test]
    fn mkdir_and_readdir() {
        mkdir(b"/srv/d", 0o755, 0, 0).unwrap();
        let a = open(b"/srv/d/a", O_CREAT | O_RDWR, 0o644, 0, 0).unwrap();
        release_handle(a);
        mkdir(b"/srv/d/sub", 0o755, 0, 0).unwrap();

        let dh = opendir(b"/srv/d").unwrap();
        let mut names: Vec<Vec<u8>> = Vec::new();
        let mut namebuf = [0u8; 256];
        while let Some((_ino, _dt, n)) = readdir(dh, &mut namebuf).unwrap() {
            names.push(namebuf[..n].to_vec());
        }
        closedir(dh).unwrap();
        names.sort();
        assert_eq!(names, alloc::vec![b"a".to_vec(), b"sub".to_vec()]);

        // Parent gained a link from the subdirectory's `..`.
        let st = lstat(b"/srv/d").unwrap();
        assert_eq!(st.st_nlink, 3); // self + `.` + sub/..
    }

    #[test]
    fn mkdir_existing_is_eexist() {
        mkdir(b"/var/log/dir1", 0o755, 0, 0).unwrap();
        assert_eq!(mkdir(b"/var/log/dir1", 0o755, 0, 0).unwrap_err(), Errno::EEXIST);
    }

    #[test]
    fn rmdir_nonempty_is_enotempty() {
        mkdir(b"/var/tmp/rd", 0o755, 0, 0).unwrap();
        let f = open(b"/var/tmp/rd/f", O_CREAT | O_RDWR, 0o644, 0, 0).unwrap();
        release_handle(f);
        assert_eq!(rmdir(b"/var/tmp/rd").unwrap_err(), Errno::ENOTEMPTY);
        unlink(b"/var/tmp/rd/f").unwrap();
        rmdir(b"/var/tmp/rd").unwrap();
        assert_eq!(lstat(b"/var/tmp/rd").unwrap_err(), Errno::ENOENT);
    }

    #[test]
    fn unlink_while_open_keeps_data_until_last_close() {
        let p = b"/tmp/unlinked.txt";
        let h = open(p, O_CREAT | O_RDWR, 0o644, 0, 0).unwrap();
        write(h, 0, b"still here").unwrap();
        unlink(p).unwrap();
        // Name is gone...
        assert_eq!(lstat(p).unwrap_err(), Errno::ENOENT);
        // ...but the open handle still reads its data.
        assert_eq!(read_all(h), b"still here");
        assert!(handle_is_live(h));
        release_handle(h);
        assert!(!handle_is_live(h));
    }

    #[test]
    fn handle_ranges_are_disjoint() {
        let fh = open(b"/tmp/disjoint", O_CREAT | O_RDWR, 0o644, 0, 0).unwrap();
        let dh = opendir(b"/tmp").unwrap();
        assert!(is_tmpfs_file_handle(fh));
        assert!(!is_tmpfs_dir_handle(fh));
        assert!(is_tmpfs_dir_handle(dh));
        assert!(!is_tmpfs_file_handle(dh));
        // Neither collides with the synthetic-regular range (1e9): a tmpfs
        // handle must not be misclassified as a synthetic regular, or the
        // synthetic dispatch arms would shadow it.
        assert!(fh <= -TMPFS_FILE_HANDLE_BASE);
        assert!(!crate::descriptor_backing::is_synthetic_regular_handle(fh));
        assert!(!crate::descriptor_backing::is_synthetic_regular_handle(dh));
        closedir(dh).unwrap();
        release_handle(fh);
    }

    #[test]
    fn opening_a_directory_as_file_is_eisdir() {
        mkdir(b"/root/adir", 0o755, 0, 0).unwrap();
        assert_eq!(
            open(b"/root/adir", O_RDONLY, 0, 0, 0).unwrap_err(),
            Errno::EISDIR
        );
    }
}
