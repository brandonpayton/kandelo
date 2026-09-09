//! In-kernel overlay for the image-backed root filesystem `/`.
//!
//! Part of Phase 5 (Increment 2) of the rust-first runtime migration: filesystem
//! *authority* for `/` moves from the TypeScript host into the portable Rust
//! kernel core. Where `tmpfs.rs` owns the empty scratch mounts, this module owns
//! the rootfs tree — which is **not** empty, so it is an *overlay*:
//!
//! - an **immutable base layer** — dirs, symlinks, and regular-file *metadata*
//!   owned in Rust, populated at boot from a host-supplied manifest. A base
//!   regular file carries a `blob_id` + `size`; its bytes are fetched on demand
//!   through a `blob_read` host callback (the host stays the byte store). Base
//!   bytes are never mutated.
//! - a **mutable overlay layer** — Rust-owned, identical to the tmpfs model:
//!   files created under `/`, and base files copied-on-write on first write.
//!   (Increment 2b.)
//! - **whiteouts** hiding deleted base entries. (Increment 2b.)
//!
//! Increment 2a added the read-only base layer (data model, base-tree builder,
//! and read-path ops). Increment 2b-i adds the file-mutation core: an
//! overlay `Regular` inode kind, copy-on-write of a base file on first write,
//! `O_CREAT`/`O_TRUNC`, `write`, and `truncate`. Directory/metadata mutation
//! (mkdir/rmdir/unlink/rename/chmod/chown/utimensat/symlink/link) lands in
//! Increment 2b-ii. The store is **dormant by default** (`set_enabled`, default
//! off) and not yet wired into syscall dispatch, so behavior is unchanged until
//! the cutover increment. See `docs/plans/2026-08-28-phase5-vfs-to-rust.md`.
//!
//! # Handle encoding
//! Disjoint negative-handle bands, 1e9 wide, below the tmpfs bands:
//! rootfs file `(-5e9, -4e9]`, rootfs dir `(-6e9, -5e9]`. The read/write cursor
//! lives in the per-OFD `OpenFileDesc::offset` field (like host and tmpfs
//! files), so rootfs is not a shared-cursor backing.

use alloc::collections::BTreeMap;
use alloc::vec::Vec;
use core::cell::UnsafeCell;
use core::hint::spin_loop;
use core::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};

use wasm_posix_shared::mode::{S_IFDIR, S_IFLNK, S_IFMT, S_IFREG, S_IFSOCK};
use wasm_posix_shared::Errno;
use wasm_posix_shared::WasmStat;
use wasm_posix_shared::WasmStatfs;

// Open-file creation flags we honor here (mirrors syscalls.rs / tmpfs.rs).
const O_ACCMODE: u32 = 0o3;
const O_RDONLY: u32 = 0o0;
const O_WRONLY: u32 = 0o1;
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
        InodeKind::BaseRegular { .. } | InodeKind::Regular(_) | InodeKind::LazyMember { .. } => {
            DT_REG as u8
        }
        InodeKind::Special(type_bits) => {
            if type_bits & S_IFMT == S_IFSOCK {
                DT_SOCK as u8
            } else {
                DT_FIFO as u8
            }
        }
    }
}

/// Disjoint negative-handle bands, below the tmpfs bands (see `tmpfs.rs`).
pub const ROOTFS_FILE_HANDLE_BASE: i64 = 4_000_000_000;
pub const ROOTFS_DIR_HANDLE_BASE: i64 = 5_000_000_000;
use crate::tmpfs::HANDLE_BAND_WIDTH;

/// Sentinel host handle marking an open rootfs *directory* descriptor. Distinct
/// from procfs (-150), devfs (-160), and tmpfs (-170) directory sentinels.
pub const ROOTFS_DIR_SENTINEL: i64 = -180;

/// `st_dev` for the rootfs overlay (one filesystem identity). Distinct from the
/// per-scratch-mount tmpfs devs (`0x7400_0000`+).
const ROOTFS_DEV: u64 = 0x7300_0000;

/// An inode in the rootfs overlay. Increment 2a carries only base (immutable)
/// kinds; the mutable overlay kinds (`Regular(Vec<u8>)` for COW/created files)
/// arrive in Increment 2b.
enum InodeKind {
    Dir(BTreeMap<Vec<u8>, u32>),
    /// A base regular file: bytes live in the host byte store, addressed by
    /// `blob_id`; `size` is authoritative metadata from the manifest.
    BaseRegular { blob_id: u64, size: u64 },
    /// A Rust-owned mutable regular file: either created under `/` at runtime or
    /// a base file copied-on-write on first write. Bytes live in kernel memory.
    Regular(Vec<u8>),
    /// Symbolic link holding its target path bytes.
    Symlink(Vec<u8>),
    /// A metadata-only special file (AF_UNIX socket or FIFO). The `S_IF*` type
    /// bits are stored; the communication endpoint lives in the socket registry
    /// or fifo table, keyed by path — mirrors the tmpfs `Special` node.
    Special(u32),
    /// A lazy-archive placeholder (RTFS v3, manifest `KIND_LAZY_FILE`): metadata
    /// (`size`, mode, etc.) is authoritative from the manifest like
    /// `BaseRegular`, but the bytes live in a not-yet-fetched archive
    /// (`archive_id`) at `source_path` within it. Materializing the bytes is
    /// Increment 3b-wiring.2 (`fetch_archive`); this increment only places the
    /// node and serves its metadata.
    LazyMember {
        archive_id: u32,
        source_path: Vec<u8>,
        size: u64,
    },
}

struct Inode {
    kind: InodeKind,
    /// Permission bits only (no `S_IFMT`).
    mode: u32,
    uid: u32,
    gid: u32,
    /// Number of directory entries (hard links) referencing this inode.
    nlink: u32,
    /// Live open descriptions (for handle validity / future unlink-while-open).
    open_count: u32,
    ino: u64,
    atime_sec: u64,
    atime_nsec: u32,
    mtime_sec: u64,
    mtime_nsec: u32,
    ctime_sec: u64,
    ctime_nsec: u32,
}

impl Inode {
    fn new(kind: InodeKind, mode: u32, uid: u32, gid: u32, nlink: u32, ino: u64) -> Self {
        let (sec, nsec) = now();
        Inode {
            kind,
            mode,
            uid,
            gid,
            nlink,
            open_count: 0,
            ino,
            atime_sec: sec,
            atime_nsec: nsec,
            mtime_sec: sec,
            mtime_nsec: nsec,
            ctime_sec: sec,
            ctime_nsec: nsec,
        }
    }

    fn stat(&self) -> WasmStat {
        let type_bits = match self.kind {
            InodeKind::Dir(_) => S_IFDIR,
            InodeKind::BaseRegular { .. } | InodeKind::Regular(_) | InodeKind::LazyMember { .. } => {
                S_IFREG
            }
            InodeKind::Symlink(_) => S_IFLNK,
            InodeKind::Special(type_bits) => type_bits,
        };
        let size = match &self.kind {
            InodeKind::Dir(entries) => entries.len() as u64,
            InodeKind::BaseRegular { size, .. } => *size,
            InodeKind::Regular(data) => data.len() as u64,
            InodeKind::Symlink(target) => target.len() as u64,
            InodeKind::Special(_) => 0,
            InodeKind::LazyMember { size, .. } => *size,
        };
        WasmStat {
            st_dev: ROOTFS_DEV,
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

    /// Stamp mtime and ctime (a content mutation: write, truncate).
    fn touch_modified(&mut self) {
        let (sec, nsec) = now();
        self.mtime_sec = sec;
        self.mtime_nsec = nsec;
        self.ctime_sec = sec;
        self.ctime_nsec = nsec;
    }

    /// Stamp ctime only (a metadata mutation: chmod, chown, link).
    fn touch_changed(&mut self) {
        let (sec, nsec) = now();
        self.ctime_sec = sec;
        self.ctime_nsec = nsec;
    }

    /// Clear set-user-ID, and set-group-ID on a group-executable file, on a
    /// content-modifying operation — the POSIX "a successful write clears
    /// set-user-ID" rule, matching the host path and tmpfs.
    fn clear_setid_on_modify(&mut self) {
        const S_ISUID: u32 = 0o4000;
        const S_ISGID: u32 = 0o2000;
        const S_IXGRP: u32 = 0o0010;
        self.mode &= !S_ISUID;
        if self.mode & S_IXGRP != 0 {
            self.mode &= !S_ISGID;
        }
    }
}

/// A materialized directory stream: a snapshot of entries plus a cursor.
struct DirIter {
    entries: Vec<(Vec<u8>, u64, u32)>,
    cursor: usize,
}

struct RootfsState {
    inodes: Vec<Option<Inode>>,
    free_inodes: Vec<u32>,
    /// Root ("/") inode index, created on first use.
    root: Option<u32>,
    dir_iters: Vec<Option<DirIter>>,
    free_dir_iters: Vec<u32>,
    /// Inode numbers for overlay-created inodes; base inos come from the
    /// manifest. Starts high to avoid colliding with typical manifest inos.
    next_ino: u64,
    /// Lazy-archive registry populated from a v3 manifest's trailing archive
    /// table: `archive_id -> ArchiveEntry`. Consumed by the byte-serving path
    /// (Increment 3b-wiring.2, `fetch_archive`); cleared by `reset()` like the
    /// rest of the store, so a failed manifest load never leaves stale entries.
    archives: BTreeMap<u32, ArchiveEntry>,
}

/// Registry entry for one lazy archive: manifest-authoritative `size`, plus a
/// fetch/decode cache populated lazily on first touch of any member.
///
/// `size` comes from the v3 manifest's trailing archive table and is always
/// present. `raw`, `directory`, and `members` start empty and are filled in by
/// the byte-serving path (Increment 3b-wiring.2 Task 2): `raw` holds the whole
/// fetched archive blob (fetched once, on first touch of any member of this
/// archive), `directory` holds the parsed central directory, and `members`
/// caches each member's inflated bytes on first read of that member.
struct ArchiveEntry {
    size: u64,
    raw: Option<Vec<u8>>,
    directory: Option<Vec<crate::zip::ZipEntry>>,
    members: BTreeMap<Vec<u8>, Vec<u8>>,
}

impl RootfsState {
    fn new() -> Self {
        RootfsState {
            inodes: Vec::new(),
            free_inodes: Vec::new(),
            root: None,
            dir_iters: Vec::new(),
            free_dir_iters: Vec::new(),
            next_ino: 1,
            archives: BTreeMap::new(),
        }
    }

    fn bump_next_ino(&mut self, seen: u64) {
        if seen >= self.next_ino {
            self.next_ino = seen + 1;
        }
    }

    /// Allocate a fresh inode number for an overlay-created file (base inos come
    /// from the manifest; `bump_next_ino` keeps this ahead of them).
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

    /// Root ("/") inode index, created on first touch with default 0755 root:root
    /// metadata. A manifest `/` entry refines that metadata via
    /// [`insert_base_dir`].
    fn mount_root(&mut self) -> u32 {
        if let Some(root) = self.root {
            return root;
        }
        let ino = 1;
        self.bump_next_ino(ino);
        let root = self.insert_inode(Inode::new(
            InodeKind::Dir(BTreeMap::new()),
            0o755,
            0,
            0,
            2,
            ino,
        ));
        self.root = Some(root);
        root
    }

    /// Walk `components` from the root, returning the target inode index. Every
    /// intermediate component must be an existing directory.
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
    /// The root itself is returned as `(root, None, Some(root))`. Mirrors the
    /// tmpfs resolver.
    fn resolve<'a>(
        &mut self,
        rel: &'a [&'a [u8]],
    ) -> Result<(u32, Option<&'a [u8]>, Option<u32>), Errno> {
        let root = self.mount_root();
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

    /// Free an inode if it has no remaining names and no open descriptions
    /// (POSIX unlink-while-open). Base and overlay inodes alike: a base file's
    /// bytes live in the host, so dropping the inode just forgets the mapping.
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

    /// Recompute a directory's link count from scratch: 2 (self + `.`) plus one
    /// per child subdirectory (each child dir's `..`). Robust against any move,
    /// replace, or removal.
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
}

/// Walk to a rootfs inode index for a metadata update. The final component is
/// not followed (the kernel already resolved symlinks per the syscall's FOLLOW
/// policy before calling), so lchown-style callers land on the link itself.
fn walk_to_inode(path: &[u8]) -> Result<u32, Errno> {
    let comps = split_components(path);
    ROOTFS.with(|state| {
        let root = state.mount_root();
        state.walk(root, &comps)
    })
}

struct RootfsGlobal {
    locked: AtomicBool,
    state: UnsafeCell<Option<RootfsState>>,
}

struct UnlockOnDrop<'a>(&'a AtomicBool);

impl Drop for UnlockOnDrop<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

impl RootfsGlobal {
    const fn new() -> Self {
        RootfsGlobal {
            locked: AtomicBool::new(false),
            state: UnsafeCell::new(None),
        }
    }

    fn with<R>(&'static self, f: impl FnOnce(&mut RootfsState) -> R) -> R {
        while self
            .locked
            .compare_exchange_weak(false, true, Ordering::Acquire, Ordering::Relaxed)
            .is_err()
        {
            spin_loop();
        }
        let _unlock = UnlockOnDrop(&self.locked);
        // SAFETY: `locked` serializes every access; Kandelo enters one kernel
        // instance at a time, exactly like tmpfs and the other global stores.
        let slot = unsafe { &mut *self.state.get() };
        f(slot.get_or_insert_with(RootfsState::new))
    }
}

// SAFETY: identical invariant to tmpfs's TmpfsGlobal — the spinlock is the sole
// gate and no reference escapes the closure.
unsafe impl Sync for RootfsGlobal {}

static ROOTFS: RootfsGlobal = RootfsGlobal::new();

/// Registry of *foreign* mount prefixes: the canonical mount points of every
/// other filesystem still mounted under `/` after the host hands `/` to the
/// overlay (for example `/dev/shm` shmfs, `/run/kandelo-run` session-seed host
/// mounts, and extra `HostFileSystem` mounts). Once the overlay is the sole `/`
/// authority it would otherwise greedily claim these sibling paths and shadow
/// the real mount, so `owns_path` returns false for any path at or under a
/// registered prefix and the syscall falls through to the host mount exactly as
/// before the cutover.
///
/// Populated once by the host at overlay-configure time via
/// `set_foreign_prefixes`. tmpfs scratch mounts are excluded separately by
/// `tmpfs::owns_path`; a tmpfs prefix appearing here too is harmless (either
/// check independently disqualifies the path).
struct ForeignMounts {
    locked: AtomicBool,
    prefixes: UnsafeCell<Vec<Vec<u8>>>,
}

impl ForeignMounts {
    const fn new() -> Self {
        ForeignMounts {
            locked: AtomicBool::new(false),
            prefixes: UnsafeCell::new(Vec::new()),
        }
    }

    fn with<R>(&'static self, f: impl FnOnce(&mut Vec<Vec<u8>>) -> R) -> R {
        while self
            .locked
            .compare_exchange_weak(false, true, Ordering::Acquire, Ordering::Relaxed)
            .is_err()
        {
            spin_loop();
        }
        let _unlock = UnlockOnDrop(&self.locked);
        // SAFETY: same invariant as RootfsGlobal — the spinlock is the sole gate
        // and no reference escapes the closure.
        let slot = unsafe { &mut *self.prefixes.get() };
        f(slot)
    }
}

// SAFETY: identical invariant to RootfsGlobal / TmpfsGlobal.
unsafe impl Sync for ForeignMounts {}

static FOREIGN_MOUNTS: ForeignMounts = ForeignMounts::new();

/// Register the set of foreign mount prefixes (see [`ForeignMounts`]). `buf` is
/// a NUL-separated list of canonical absolute mount points supplied by the host
/// at overlay-configure time. Replaces any previously registered set. Entries
/// that are empty, non-absolute, or exactly `/` are ignored (`/` is the
/// overlay's own root, never foreign); trailing slashes are trimmed and
/// duplicates dropped. Returns the number of prefixes registered.
pub fn set_foreign_prefixes(buf: &[u8]) -> usize {
    let mut prefixes: Vec<Vec<u8>> = Vec::new();
    for part in buf.split(|&b| b == 0) {
        if part.first() != Some(&b'/') {
            continue;
        }
        let mut p = part.to_vec();
        while p.len() > 1 && p.last() == Some(&b'/') {
            p.pop();
        }
        if p == b"/" {
            continue;
        }
        if !prefixes.iter().any(|e| e == &p) {
            prefixes.push(p);
        }
    }
    let count = prefixes.len();
    FOREIGN_MOUNTS.with(|slot| *slot = prefixes);
    count
}

/// Whether `path` lies at or under a registered foreign mount prefix. The match
/// respects path-component boundaries, so a foreign mount at `/run/kandelo-run`
/// matches `/run/kandelo-run` and `/run/kandelo-run/...` but not
/// `/run/kandelo-runner` or a sibling `/run/other`.
fn path_under_foreign(path: &[u8]) -> bool {
    FOREIGN_MOUNTS.with(|prefixes| {
        prefixes.iter().any(|p| {
            path == p.as_slice()
                || (path.len() > p.len() && path.starts_with(p) && path[p.len()] == b'/')
        })
    })
}

/// Split a canonical absolute path into non-empty components.
fn split_components(path: &[u8]) -> Vec<&[u8]> {
    path.split(|&b| b == b'/').filter(|c| !c.is_empty()).collect()
}

/// Master switch for in-kernel rootfs authority over `/`. Defaults OFF; the
/// cutover increment enables it at boot (and drops the host `/` image backend).
static ROOTFS_ENABLED: AtomicBool = AtomicBool::new(false);

/// Enable or disable in-kernel rootfs authority. Returns the previous value.
pub fn set_enabled(enabled: bool) -> bool {
    ROOTFS_ENABLED.swap(enabled, Ordering::SeqCst)
}

/// Whether in-kernel rootfs authority is currently active.
pub fn is_enabled() -> bool {
    ROOTFS_ENABLED.load(Ordering::SeqCst)
}

/// Whether the overlay's `/` mount was configured `nosuid`. Defaults OFF: a
/// normal boot mounts `/` set-ID-honoring, so a setuid/setgid binary staged in
/// the overlay (for example `/usr/bin/login`, `su`, `passwd`) elevates through
/// exec exactly as it does on the host `/` mount. The host publishes the mount's
/// real flag at overlay-configure time via `set_nosuid`; `statfs` then reports
/// `ST_NOSUID` so the exec-target set-ID proposal drops the bits on a `nosuid`
/// mount and honors them otherwise. Cleared by `reset()`/`load_manifest`.
static ROOTFS_NOSUID: AtomicBool = AtomicBool::new(false);

/// Publish whether the overlay's `/` mount is `nosuid`. Returns the previous
/// value. The host calls this once at boot, after loading the manifest (which
/// resets it) and before enabling rootfs authority.
pub fn set_nosuid(nosuid: bool) -> bool {
    ROOTFS_NOSUID.swap(nosuid, Ordering::SeqCst)
}

/// Whether the overlay's `/` mount is currently `nosuid`.
pub fn is_nosuid() -> bool {
    ROOTFS_NOSUID.load(Ordering::SeqCst)
}

static ROOTFS_NOW_SEC: AtomicU64 = AtomicU64::new(0);
static ROOTFS_NOW_NSEC: AtomicU32 = AtomicU32::new(0);

/// Publish the current wall-clock time for subsequent metadata stamps (the core
/// stays host-free; the syscall layer reads the host clock once per mutating op).
pub fn set_now(sec: u64, nsec: u32) {
    ROOTFS_NOW_SEC.store(sec, Ordering::Relaxed);
    ROOTFS_NOW_NSEC.store(nsec, Ordering::Relaxed);
}

fn now() -> (u64, u32) {
    (
        ROOTFS_NOW_SEC.load(Ordering::Relaxed),
        ROOTFS_NOW_NSEC.load(Ordering::Relaxed),
    )
}

/// Whether a canonical path belongs to the rootfs overlay: an absolute path
/// that is owned neither by the tmpfs scratch mounts nor by a registered foreign
/// mount (a sibling filesystem still mounted under `/`, see [`ForeignMounts`]).
/// Pure predicate; does not consider whether rootfs authority is enabled.
/// Synthetic namespaces (procfs, devfs, pty, `/dev/fd`, synthetic regulars) are
/// matched *before* rootfs in `namespace_lstat_raw`, exactly where the host `/`
/// fall-through sits today, so they never reach this predicate in dispatch.
pub fn owns_path(path: &[u8]) -> bool {
    path.first() == Some(&b'/')
        && !crate::tmpfs::owns_path(path)
        && !path_under_foreign(path)
}

/// Whether the in-kernel rootfs currently claims authority over a path: rootfs
/// is enabled AND the path is a rootfs path.
pub fn claims_path(path: &[u8]) -> bool {
    is_enabled() && owns_path(path)
}

/// Whether a host handle names an open rootfs regular file.
pub fn is_rootfs_file_handle(handle: i64) -> bool {
    handle <= -ROOTFS_FILE_HANDLE_BASE && handle > -ROOTFS_DIR_HANDLE_BASE
}

/// Whether a host handle names an open rootfs directory stream.
pub fn is_rootfs_dir_handle(handle: i64) -> bool {
    handle <= -ROOTFS_DIR_HANDLE_BASE
        && handle > -(ROOTFS_DIR_HANDLE_BASE + HANDLE_BAND_WIDTH)
}

fn file_handle_to_inode(handle: i64) -> Result<u32, Errno> {
    if !is_rootfs_file_handle(handle) {
        return Err(Errno::EBADF);
    }
    u32::try_from(-handle - ROOTFS_FILE_HANDLE_BASE).map_err(|_| Errno::EBADF)
}

fn inode_to_file_handle(idx: u32) -> i64 {
    -(ROOTFS_FILE_HANDLE_BASE + idx as i64)
}

fn dir_handle_to_iter(handle: i64) -> Result<u32, Errno> {
    if !is_rootfs_dir_handle(handle) {
        return Err(Errno::EBADF);
    }
    u32::try_from(-handle - ROOTFS_DIR_HANDLE_BASE).map_err(|_| Errno::EBADF)
}

fn iter_to_dir_handle(idx: u32) -> i64 {
    -(ROOTFS_DIR_HANDLE_BASE + idx as i64)
}

// ---------------------------------------------------------------------------
// Base-tree builder (populated at boot from the host manifest; used directly by
// unit tests). Parents must be inserted before their children (a manifest is
// walked parent-first). Each insert refuses to clobber an existing entry.
// ---------------------------------------------------------------------------

/// Clear the whole overlay (drops every inode and open stream). Used before
/// repopulating from a fresh manifest and by tests for isolation.
pub fn reset() {
    ROOTFS.with(|state| *state = RootfsState::new());
    FOREIGN_MOUNTS.with(|slot| slot.clear());
    ROOTFS_NOSUID.store(false, Ordering::SeqCst);
}

/// Split an absolute path into (parent components, final component). Returns
/// `None` for the root itself.
fn parent_and_last(path: &[u8]) -> Option<(Vec<&[u8]>, &[u8])> {
    let comps = split_components(path);
    if comps.is_empty() {
        return None;
    }
    let last = comps[comps.len() - 1];
    let parent = comps[..comps.len() - 1].to_vec();
    Some((parent, last))
}

fn link_into_parent(
    state: &mut RootfsState,
    parent_comps: &[&[u8]],
    last: &[u8],
    child: u32,
) -> Result<(), Errno> {
    let root = state.mount_root();
    let parent = state.walk(root, parent_comps)?;
    match state.get_mut(parent).map(|i| &mut i.kind) {
        Some(InodeKind::Dir(entries)) => {
            if entries.contains_key(last) {
                return Err(Errno::EEXIST);
            }
            entries.insert(last.to_vec(), child);
            Ok(())
        }
        Some(_) => Err(Errno::ENOTDIR),
        None => Err(Errno::ENOENT),
    }
}

/// Insert a base directory. For `/` this sets the root's metadata (creating the
/// root if needed) rather than adding a child.
pub fn insert_base_dir(
    path: &[u8],
    mode: u32,
    uid: u32,
    gid: u32,
    ino: u64,
) -> Result<(), Errno> {
    ROOTFS.with(|state| {
        state.bump_next_ino(ino);
        let Some((parent_comps, last)) = parent_and_last(path) else {
            // Root: create-or-update its metadata.
            let root = state.mount_root();
            if let Some(inode) = state.get_mut(root) {
                inode.mode = mode & 0o7777;
                inode.uid = uid;
                inode.gid = gid;
                inode.ino = ino;
            }
            return Ok(());
        };
        let child = state.insert_inode(Inode::new(
            InodeKind::Dir(BTreeMap::new()),
            mode & 0o7777,
            uid,
            gid,
            2,
            ino,
        ));
        let comps: Vec<&[u8]> = parent_comps.iter().map(|c| &**c).collect();
        match link_into_parent(state, &comps, last, child) {
            Ok(()) => {
                // Bump the parent's link count for the new subdirectory's `..`.
                let root = state.mount_root();
                if let Ok(parent) = state.walk(root, &comps) {
                    if let Some(p) = state.get_mut(parent) {
                        p.nlink += 1;
                    }
                }
                Ok(())
            }
            Err(e) => {
                // Roll back the orphaned inode.
                state.inodes[child as usize] = None;
                state.free_inodes.push(child);
                Err(e)
            }
        }
    })
}

/// Insert a base regular file whose bytes are served from the host byte store
/// (`blob_id`, `size` authoritative from the manifest).
pub fn insert_base_file(
    path: &[u8],
    blob_id: u64,
    size: u64,
    mode: u32,
    uid: u32,
    gid: u32,
    ino: u64,
) -> Result<(), Errno> {
    ROOTFS.with(|state| {
        state.bump_next_ino(ino);
        let (parent_comps, last) = parent_and_last(path).ok_or(Errno::EINVAL)?;
        let child = state.insert_inode(Inode::new(
            InodeKind::BaseRegular { blob_id, size },
            mode & 0o7777,
            uid,
            gid,
            1,
            ino,
        ));
        let comps: Vec<&[u8]> = parent_comps.iter().map(|c| &**c).collect();
        if let Err(e) = link_into_parent(state, &comps, last, child) {
            state.inodes[child as usize] = None;
            state.free_inodes.push(child);
            return Err(e);
        }
        Ok(())
    })
}

/// Insert a base symlink holding `target` bytes.
pub fn insert_base_symlink(
    path: &[u8],
    target: &[u8],
    mode: u32,
    uid: u32,
    gid: u32,
    ino: u64,
) -> Result<(), Errno> {
    ROOTFS.with(|state| {
        state.bump_next_ino(ino);
        let (parent_comps, last) = parent_and_last(path).ok_or(Errno::EINVAL)?;
        let child = state.insert_inode(Inode::new(
            InodeKind::Symlink(target.to_vec()),
            mode & 0o7777,
            uid,
            gid,
            1,
            ino,
        ));
        let comps: Vec<&[u8]> = parent_comps.iter().map(|c| &**c).collect();
        if let Err(e) = link_into_parent(state, &comps, last, child) {
            state.inodes[child as usize] = None;
            state.free_inodes.push(child);
            return Err(e);
        }
        Ok(())
    })
}

/// Insert a lazy-archive placeholder file (RTFS v3 `KIND_LAZY_FILE`): `size` is
/// authoritative metadata from the manifest (like [`insert_base_file`]'s
/// `size`), while the bytes live at `source_path` within archive `archive_id`,
/// not yet fetched. Placed exactly like a base file; reading its bytes is
/// Increment 3b-wiring.2.
#[allow(clippy::too_many_arguments)]
pub fn insert_lazy_file(
    path: &[u8],
    archive_id: u32,
    source_path: &[u8],
    size: u64,
    mode: u32,
    uid: u32,
    gid: u32,
    ino: u64,
) -> Result<(), Errno> {
    ROOTFS.with(|state| {
        state.bump_next_ino(ino);
        let (parent_comps, last) = parent_and_last(path).ok_or(Errno::EINVAL)?;
        let child = state.insert_inode(Inode::new(
            InodeKind::LazyMember {
                archive_id,
                source_path: source_path.to_vec(),
                size,
            },
            mode & 0o7777,
            uid,
            gid,
            1,
            ino,
        ));
        let comps: Vec<&[u8]> = parent_comps.iter().map(|c| &**c).collect();
        if let Err(e) = link_into_parent(state, &comps, last, child) {
            state.inodes[child as usize] = None;
            state.free_inodes.push(child);
            return Err(e);
        }
        Ok(())
    })
}

/// The `(archive_id, source_path)` of a lazy-file placeholder at `path`. Used
/// by the byte-serving path (Increment 3b-wiring.2) to resolve which archive
/// to fetch and which member within it to extract; exposed now as an accessor
/// for the loader's own tests.
pub fn lazy_member_source(path: &[u8]) -> Result<(u32, Vec<u8>), Errno> {
    let comps = split_components(path);
    ROOTFS.with(|state| {
        let root = state.mount_root();
        let idx = state.walk(root, &comps)?;
        match &state.get(idx).ok_or(Errno::ENOENT)?.kind {
            InodeKind::LazyMember {
                archive_id,
                source_path,
                ..
            } => Ok((*archive_id, source_path.clone())),
            _ => Err(Errno::EINVAL),
        }
    })
}

/// The size (in bytes) of archive `archive_id` as recorded in a v3 manifest's
/// trailing archive table, or `None` if no such archive was registered.
/// Consumed by the byte-serving path (Increment 3b-wiring.2, `fetch_archive`).
pub fn archive_size(archive_id: u32) -> Option<u64> {
    ROOTFS.with(|state| state.archives.get(&archive_id).map(|entry| entry.size))
}

// ---------------------------------------------------------------------------
// Boot manifest ingestion (Increment 2c).
//
// The host hands the kernel the whole `/` tree once at boot as a compact binary
// buffer, which this module parses into the base layer. One host->kernel
// crossing for the entire tree (not one call per entry). The wire format is a
// purpose-built fixed-field record stream we own — deliberately NOT a
// general-purpose archive parser (that is Increment 3). Little-endian.
//
//   header:  magic u32 = "RTFS" | version u32 = 2 or 3 | entry_count u32
//   entry:   kind u8 (1=dir, 2=file, 3=symlink, 4=lazy file [v3 only])
//            mode u32 | uid u32 | gid u32 | ino u64 | blob_id u64 | size u64
//            mtime_sec u64 | mtime_nsec u32   (real per-file times from the image)
//            path_len u32 | path[path_len]
//            target_len u32 | target[target_len]   (target_len=0 unless symlink)
//            -- kind=4 (lazy file) only, appended after target --
//            archive_id u32 | source_path_len u32 | source_path[source_path_len]
//
// Every entry carries all fields (zero when not applicable) so the parser stays
// uniform and bounds-checkable. Entries are parent-first (the host walks the
// tree pre-order), so each insert's parent already exists.
//
// v3 adds one trailing section after the entry stream, present iff version>=3
// (Increment 3b-wiring.1 — RTFS v3, lazy archives):
//
//   archive_table: archive_count u32
//   archive:       archive_id u32 | archive_size u64
//
// The archive table records the total byte size of each lazy archive referenced
// by a kind=4 entry's `archive_id`; fetching and extracting those bytes is
// Increment 3b-wiring.2 (`fetch_archive`). This increment only parses and
// stores the table.
// ---------------------------------------------------------------------------

/// Manifest header magic ("RTFS", little-endian).
const MANIFEST_MAGIC: u32 = 0x5346_5452;
const MANIFEST_VERSION: u32 = 2;
/// RTFS v3: adds `KIND_LAZY_FILE` (4) entries and a trailing archive table.
const MANIFEST_VERSION_V3: u32 = 3;
/// Defensive cap on a single path/target length (bytes).
const MANIFEST_NAME_MAX: usize = 65_536;

fn rd_u8(buf: &[u8], pos: &mut usize) -> Result<u8, Errno> {
    let v = *buf.get(*pos).ok_or(Errno::EINVAL)?;
    *pos += 1;
    Ok(v)
}

fn rd_u32(buf: &[u8], pos: &mut usize) -> Result<u32, Errno> {
    let end = pos.checked_add(4).ok_or(Errno::EINVAL)?;
    let slice = buf.get(*pos..end).ok_or(Errno::EINVAL)?;
    let mut b = [0u8; 4];
    b.copy_from_slice(slice);
    *pos = end;
    Ok(u32::from_le_bytes(b))
}

fn rd_u64(buf: &[u8], pos: &mut usize) -> Result<u64, Errno> {
    let end = pos.checked_add(8).ok_or(Errno::EINVAL)?;
    let slice = buf.get(*pos..end).ok_or(Errno::EINVAL)?;
    let mut b = [0u8; 8];
    b.copy_from_slice(slice);
    *pos = end;
    Ok(u64::from_le_bytes(b))
}

fn rd_bytes<'a>(buf: &'a [u8], pos: &mut usize, len: usize) -> Result<&'a [u8], Errno> {
    if len > MANIFEST_NAME_MAX {
        return Err(Errno::EINVAL);
    }
    let end = pos.checked_add(len).ok_or(Errno::EINVAL)?;
    let slice = buf.get(*pos..end).ok_or(Errno::EINVAL)?;
    *pos = end;
    Ok(slice)
}

/// Replace the base layer from a boot manifest buffer. Clears any prior state,
/// then inserts every entry parent-first. Returns the number of entries loaded.
/// A malformed buffer or a rejected insert yields `EINVAL` with the store reset
/// to empty (a partial tree is never left behind).
pub fn load_manifest(buf: &[u8]) -> Result<usize, Errno> {
    reset();
    let result = load_manifest_inner(buf);
    if result.is_err() {
        reset();
    }
    result
}

fn load_manifest_inner(buf: &[u8]) -> Result<usize, Errno> {
    let mut pos = 0usize;
    if rd_u32(buf, &mut pos)? != MANIFEST_MAGIC {
        return Err(Errno::EINVAL);
    }
    let version = rd_u32(buf, &mut pos)?;
    if version != MANIFEST_VERSION && version != MANIFEST_VERSION_V3 {
        return Err(Errno::EINVAL);
    }
    let count = rd_u32(buf, &mut pos)? as usize;
    for _ in 0..count {
        let kind = rd_u8(buf, &mut pos)?;
        let mode = rd_u32(buf, &mut pos)?;
        let uid = rd_u32(buf, &mut pos)?;
        let gid = rd_u32(buf, &mut pos)?;
        let ino = rd_u64(buf, &mut pos)?;
        let blob_id = rd_u64(buf, &mut pos)?;
        let size = rd_u64(buf, &mut pos)?;
        let mtime_sec = rd_u64(buf, &mut pos)?;
        let mtime_nsec = rd_u32(buf, &mut pos)?;
        let path_len = rd_u32(buf, &mut pos)? as usize;
        let path = rd_bytes(buf, &mut pos, path_len)?.to_vec();
        let target_len = rd_u32(buf, &mut pos)? as usize;
        let target = rd_bytes(buf, &mut pos, target_len)?.to_vec();
        match kind {
            1 => insert_base_dir(&path, mode, uid, gid, ino)?,
            2 => insert_base_file(&path, blob_id, size, mode, uid, gid, ino)?,
            3 => insert_base_symlink(&path, &target, mode, uid, gid, ino)?,
            4 => {
                let archive_id = rd_u32(buf, &mut pos)?;
                let source_path_len = rd_u32(buf, &mut pos)? as usize;
                let source_path = rd_bytes(buf, &mut pos, source_path_len)?.to_vec();
                insert_lazy_file(&path, archive_id, &source_path, size, mode, uid, gid, ino)?
            }
            _ => return Err(Errno::EINVAL),
        }
        // Overwrite the create-time stamp with the image's real times so `ls -l`,
        // `make`, and `find -mtime` see accurate file metadata after cutover.
        set_base_times(&path, mtime_sec, mtime_nsec);
    }
    if version >= MANIFEST_VERSION_V3 {
        let archive_count = rd_u32(buf, &mut pos)? as usize;
        for _ in 0..archive_count {
            let archive_id = rd_u32(buf, &mut pos)?;
            let archive_size = rd_u64(buf, &mut pos)?;
            ROOTFS.with(|state| {
                state.archives.insert(
                    archive_id,
                    ArchiveEntry {
                        size: archive_size,
                        raw: None,
                        directory: None,
                        members: BTreeMap::new(),
                    },
                );
            });
        }
    }
    Ok(count)
}

/// Set a just-inserted base entry's atime/mtime/ctime to the image's real mtime.
/// (The image carries one meaningful timestamp per entry; atime/ctime distinct
/// from mtime are rarely load-bearing and are not preserved separately.)
fn set_base_times(path: &[u8], mtime_sec: u64, mtime_nsec: u32) {
    let comps = split_components(path);
    ROOTFS.with(|state| {
        let root = state.mount_root();
        if let Ok(idx) = state.walk(root, &comps) {
            if let Some(inode) = state.get_mut(idx) {
                inode.atime_sec = mtime_sec;
                inode.atime_nsec = mtime_nsec;
                inode.mtime_sec = mtime_sec;
                inode.mtime_nsec = mtime_nsec;
                inode.ctime_sec = mtime_sec;
                inode.ctime_nsec = mtime_nsec;
            }
        }
    });
}

// ---------------------------------------------------------------------------
// Read-path operations (Increment 2a).
// ---------------------------------------------------------------------------

/// lstat a canonical rootfs path. The final component is not followed (the
/// caller resolved symlinks per the syscall's FOLLOW policy already).
pub fn lstat(path: &[u8]) -> Result<WasmStat, Errno> {
    let comps = split_components(path);
    ROOTFS.with(|state| {
        let root = state.mount_root();
        let idx = state.walk(root, &comps)?;
        Ok(state.get(idx).ok_or(Errno::ENOENT)?.stat())
    })
}

/// readlink a rootfs symlink.
pub fn readlink(path: &[u8], buf: &mut [u8]) -> Result<usize, Errno> {
    let comps = split_components(path);
    ROOTFS.with(|state| {
        let root = state.mount_root();
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

/// Whether a canonical rootfs path names an existing directory.
pub fn is_dir(path: &[u8]) -> bool {
    lstat(path)
        .map(|st| st.st_mode & S_IFMT == S_IFDIR)
        .unwrap_or(false)
}

/// Open (optionally creating/truncating) a rootfs regular file. Returns the
/// encoded host handle; `open_count` is incremented here and released via
/// [`release_handle`]. Copy-on-write of a base file's *bytes* is deferred to the
/// first [`write`]; `O_TRUNC` needs no base bytes (it discards them), so it
/// converts a base file to an empty overlay file directly. Directories go
/// through [`opendir`].
pub fn open(path: &[u8], flags: u32, mode: u32, uid: u32, gid: u32) -> Result<i64, Errno> {
    let comps = split_components(path);
    ROOTFS.with(|state| {
        let (parent, last, target) = state.resolve(&comps)?;
        let inode_idx = match target {
            Some(existing) => {
                if flags & O_CREAT != 0 && flags & O_EXCL != 0 {
                    return Err(Errno::EEXIST);
                }
                let inode = state.get(existing).ok_or(Errno::ENOENT)?;
                if matches!(inode.kind, InodeKind::Symlink(_)) {
                    // The caller resolves symlinks before open; a symlink reaching
                    // here means O_NOFOLLOW on the final component.
                    return Err(Errno::ELOOP);
                }
                if matches!(inode.kind, InodeKind::Special(_)) {
                    // A socket/FIFO node cannot be opened as a regular file; the
                    // fifo path is handled before rootfs::open is reached.
                    return Err(Errno::ENXIO);
                }
                if inode.is_dir() {
                    return Err(Errno::EISDIR);
                }
                if flags & O_DIRECTORY != 0 {
                    return Err(Errno::ENOTDIR);
                }
                if flags & O_TRUNC != 0 && flags & O_ACCMODE != O_RDONLY {
                    if matches!(inode.kind, InodeKind::LazyMember { .. }) {
                        // Truncating a lazy-archive placeholder would silently
                        // discard its (archive_id, source_path, size) and hand
                        // back an empty writable file instead of the real
                        // content. Byte-serving/materialization is
                        // TODO(3b-wiring.2): materialize via fetch_archive, so
                        // this stays a truthful ENOSYS rather than a silent
                        // conversion.
                        return Err(Errno::ENOSYS);
                    }
                    if let Some(node) = state.get_mut(existing) {
                        let shrank = match &node.kind {
                            InodeKind::Regular(d) => !d.is_empty(),
                            InodeKind::BaseRegular { size, .. } => *size > 0,
                            _ => false,
                        };
                        node.kind = InodeKind::Regular(Vec::new());
                        if shrank {
                            node.clear_setid_on_modify();
                        }
                        node.touch_modified();
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
                    ino,
                ));
                match state.get_mut(parent).map(|i| &mut i.kind) {
                    Some(InodeKind::Dir(entries)) => {
                        entries.insert(last.to_vec(), new_idx);
                    }
                    _ => {
                        state.inodes[new_idx as usize] = None;
                        state.free_inodes.push(new_idx);
                        return Err(Errno::ENOTDIR);
                    }
                }
                new_idx
            }
        };
        // A directory opened without opendir is rejected so callers never treat a
        // dir handle as a file.
        if state.get(inode_idx).ok_or(Errno::ENOENT)?.is_dir() {
            return Err(Errno::EISDIR);
        }
        state.get_mut(inode_idx).ok_or(Errno::ENOENT)?.open_count += 1;
        Ok(inode_to_file_handle(inode_idx))
    })
}

/// One raw-byte transport request dispatched through a single `byte_source`
/// closure. Collapses the two formerly-separate `blob_read`/`fetch_archive`
/// closure params into one: two closures each capturing `&mut host` cannot
/// both be live at one call site (borrow-checker E0524), so the kernel now
/// captures `&mut host` exactly once and matches on this enum to route to
/// `HostIO::blob_read` or `HostIO::fetch_archive`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ByteReq {
    /// A rootfs overlay content byte-leaf read (`blob_id` at `offset`).
    Base { blob_id: u64, offset: u64 },
    /// A whole-archive raw-byte fetch for a `LazyMember`'s backing archive
    /// (`archive_id` at `offset`).
    Archive { archive_id: u32, offset: u64 },
}

/// Fetch, decode, and cache one member's inflated bytes from a lazy archive
/// (RTFS v3 `KIND_LAZY_FILE`). Model B: the host is a raw-byte transport
/// (`byte_source(ByteReq::Archive { archive_id, offset }, buf)`); the kernel
/// decodes.
///
/// Per-archive fetch, per-member lazy inflate, both cached: on first touch of
/// ANY member of `archive_id`, the whole archive (`archive_size` bytes) is
/// fetched once and its central directory parsed, and both are cached on the
/// registry entry so a later touch of a *different* member of the same
/// archive skips the fetch and reuses the parsed directory. Each member's
/// inflated bytes are decoded once, on first read of THAT member, and cached
/// in `members` so repeat reads of it never re-inflate. (Archive-cache
/// eviction is out of scope here; future work.)
///
/// Lock discipline mirrors [`ensure_materialized`]: the whole-archive fetch
/// and the zip parse/inflate are heavy and (for fetch) re-enter the host, so
/// they run OUTSIDE the `ROOTFS.with` store lock. Each step captures what it
/// needs under the lock, works outside, then re-acquires to store, re-
/// checking so a value already cached by the time we store is never
/// clobbered.
///
/// Returns `Err(ENOENT)` if `archive_id` is not registered, or if
/// `source_path` names no member of the archive. A `byte_source` error (in
/// particular `EAGAIN`) propagates as-is; the partially filled local buffer is
/// simply dropped without ever reaching the store, so `raw` stays `None` and
/// the next call restarts the whole fetch from scratch — an idempotent
/// restart, matching the 3a poll-retry model. Nothing is ever cached from a
/// failed or partial fetch.
fn ensure_archive_member<F>(
    archive_id: u32,
    source_path: &[u8],
    byte_source: &mut F,
) -> Result<Vec<u8>, Errno>
where
    F: FnMut(ByteReq, &mut [u8]) -> Result<usize, Errno>,
{
    enum Plan {
        /// Already inflated and cached: return this clone directly.
        Member(Vec<u8>),
        /// Not yet inflated; `raw_present` says whether the whole-archive
        /// fetch has already happened for a previous member.
        NeedRaw { size: u64, raw_present: bool },
    }
    let plan = ROOTFS.with(|state| {
        let entry = state.archives.get(&archive_id).ok_or(Errno::ENOENT)?;
        if let Some(bytes) = entry.members.get(source_path) {
            return Ok(Plan::Member(bytes.clone()));
        }
        Ok(Plan::NeedRaw {
            size: entry.size,
            raw_present: entry.raw.is_some(),
        })
    })?;
    let (size, raw_present) = match plan {
        Plan::Member(bytes) => return Ok(bytes),
        Plan::NeedRaw { size, raw_present } => (size, raw_present),
    };

    if !raw_present {
        let mut data = alloc::vec![0u8; size as usize];
        let mut filled = 0usize;
        while filled < data.len() {
            let n = byte_source(
                ByteReq::Archive {
                    archive_id,
                    offset: filled as u64,
                },
                &mut data[filled..],
            )?;
            if n == 0 {
                break; // short read: trust the manifest size but never spin
            }
            filled += n;
        }
        data.truncate(filled);
        ROOTFS.with(|state| {
            if let Some(entry) = state.archives.get_mut(&archive_id) {
                // Re-check: another touch of this archive may have already
                // stored `raw` (no reentrancy in the single-threaded kernel,
                // but keep the store the source of truth).
                if entry.raw.is_none() {
                    entry.raw = Some(data);
                }
            }
        });
    }

    // Clone the now-cached raw archive bytes out to decode outside the lock.
    let raw = ROOTFS
        .with(|state| state.archives.get(&archive_id).and_then(|e| e.raw.clone()))
        .ok_or(Errno::ENOENT)?;

    let cached_directory =
        ROOTFS.with(|state| state.archives.get(&archive_id).and_then(|e| e.directory.clone()));
    let directory = match cached_directory {
        Some(d) => d,
        None => {
            let parsed = crate::zip::read_central_directory(&raw)?;
            ROOTFS.with(|state| {
                if let Some(entry) = state.archives.get_mut(&archive_id) {
                    if entry.directory.is_none() {
                        entry.directory = Some(parsed.clone());
                    }
                }
            });
            parsed
        }
    };

    let zip_entry = directory
        .iter()
        .find(|e| e.name == source_path)
        .ok_or(Errno::ENOENT)?;
    let bytes = crate::zip::extract(&raw, zip_entry)?;

    ROOTFS.with(|state| {
        if let Some(entry) = state.archives.get_mut(&archive_id) {
            entry
                .members
                .entry(source_path.to_vec())
                .or_insert_with(|| bytes.clone());
        }
    });

    Ok(bytes)
}

/// Materialize a base file's or lazy-archive member's bytes into a Rust-owned
/// overlay buffer (copy-on-write) if it has not been materialized yet. The
/// `byte_source` call (host byte read, or archive fetch + decode) runs
/// outside the store lock. A no-op for an already-overlay (`Regular`) file.
fn ensure_materialized<F>(idx: u32, byte_source: &mut F) -> Result<(), Errno>
where
    F: FnMut(ByteReq, &mut [u8]) -> Result<usize, Errno>,
{
    enum Base {
        None,
        BaseRegular(u64, u64),
        LazyMember(u32, Vec<u8>),
    }
    let base = ROOTFS.with(|state| match state.get(idx) {
        Some(inode) => match &inode.kind {
            InodeKind::BaseRegular { blob_id, size } => Ok(Base::BaseRegular(*blob_id, *size)),
            InodeKind::Regular(_) => Ok(Base::None),
            InodeKind::Dir(_) => Err(Errno::EISDIR),
            InodeKind::Symlink(_) => Err(Errno::EINVAL),
            InodeKind::Special(_) => Err(Errno::EINVAL),
            InodeKind::LazyMember {
                archive_id,
                source_path,
                ..
            } => Ok(Base::LazyMember(*archive_id, source_path.clone())),
        },
        None => Err(Errno::EBADF),
    })?;
    match base {
        Base::None => Ok(()),
        Base::BaseRegular(blob_id, size) => {
            let mut data = alloc::vec![0u8; size as usize];
            let mut filled = 0usize;
            while filled < data.len() {
                let n = byte_source(
                    ByteReq::Base {
                        blob_id,
                        offset: filled as u64,
                    },
                    &mut data[filled..],
                )?;
                if n == 0 {
                    break; // short read: trust the manifest size but never spin
                }
                filled += n;
            }
            data.truncate(filled);
            ROOTFS.with(|state| {
                if let Some(inode) = state.get_mut(idx) {
                    // Re-check: only convert if still a base file (no
                    // reentrancy in the single-threaded kernel, but keep the
                    // store the source of truth).
                    if matches!(inode.kind, InodeKind::BaseRegular { .. }) {
                        inode.kind = InodeKind::Regular(data);
                    }
                }
            });
            Ok(())
        }
        Base::LazyMember(archive_id, source_path) => {
            let bytes = ensure_archive_member(archive_id, &source_path, byte_source)?;
            ROOTFS.with(|state| {
                if let Some(inode) = state.get_mut(idx) {
                    // Re-check: only convert if still a lazy member.
                    if matches!(inode.kind, InodeKind::LazyMember { .. }) {
                        inode.kind = InodeKind::Regular(bytes);
                    }
                }
            });
            Ok(())
        }
    }
}

/// Write `buf` at `offset`, copying a base file into the overlay first, then
/// growing (zero-filling any gap) as needed.
pub fn write<F>(handle: i64, offset: i64, buf: &[u8], mut byte_source: F) -> Result<usize, Errno>
where
    F: FnMut(ByteReq, &mut [u8]) -> Result<usize, Errno>,
{
    let idx = file_handle_to_inode(handle)?;
    if offset < 0 {
        return Err(Errno::EINVAL);
    }
    ensure_materialized(idx, &mut byte_source)?;
    ROOTFS.with(|state| {
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
        if !buf.is_empty() {
            inode.clear_setid_on_modify();
        }
        inode.touch_modified();
        Ok(buf.len())
    })
}

/// Truncate an open rootfs regular file to `length`, zero-filling any growth.
/// Truncating to 0 needs no base bytes (a `LazyMember` truncated to 0 needs no
/// archive fetch either); a non-zero truncate copies the base file or lazy-
/// archive member into the overlay first. The caller enforces access mode and
/// RLIMIT_FSIZE.
pub fn truncate_handle<F>(handle: i64, length: i64, mut byte_source: F) -> Result<(), Errno>
where
    F: FnMut(ByteReq, &mut [u8]) -> Result<usize, Errno>,
{
    let idx = file_handle_to_inode(handle)?;
    let new_len = usize::try_from(length).map_err(|_| Errno::EINVAL)?;
    if new_len == 0 {
        return ROOTFS.with(|state| {
            let inode = state.get_mut(idx).ok_or(Errno::EBADF)?;
            let shrank = match &inode.kind {
                InodeKind::Regular(d) => !d.is_empty(),
                InodeKind::BaseRegular { size, .. } => *size > 0,
                InodeKind::LazyMember { size, .. } => *size > 0,
                // Dir/Symlink/Special fall through to EISDIR.
                _ => return Err(Errno::EISDIR),
            };
            inode.kind = InodeKind::Regular(Vec::new());
            if shrank {
                inode.clear_setid_on_modify();
            }
            inode.touch_modified();
            Ok(())
        });
    }
    ensure_materialized(idx, &mut byte_source)?;
    ROOTFS.with(|state| {
        let inode = state.get_mut(idx).ok_or(Errno::EBADF)?;
        let changed = match &mut inode.kind {
            InodeKind::Regular(data) => {
                let old_len = data.len();
                data.resize(new_len, 0);
                old_len != new_len
            }
            _ => return Err(Errno::EISDIR),
        };
        if changed {
            inode.clear_setid_on_modify();
        }
        inode.touch_modified();
        Ok(())
    })
}

/// Read up to `buf.len()` bytes at `offset` from an open rootfs file. Base-file
/// bytes come from the host byte store via
/// `byte_source(ByteReq::Base { blob_id, offset }, buf)`; a lazy-archive
/// member's bytes come from [`ensure_archive_member`] (fetch + decode,
/// cached); the store computes the EOF clamp and releases its lock *before*
/// the host callback so no host boundary call runs under the spinlock.
/// Returns the number of bytes read (0 at EOF).
pub fn read<F>(
    handle: i64,
    offset: i64,
    buf: &mut [u8],
    mut byte_source: F,
) -> Result<usize, Errno>
where
    F: FnMut(ByteReq, &mut [u8]) -> Result<usize, Errno>,
{
    let idx = file_handle_to_inode(handle)?;
    if offset < 0 {
        return Err(Errno::EINVAL);
    }
    // An overlay (Regular) file is copied under the lock; a base file yields
    // its (blob_id, size), and a lazy member its (archive_id, source_path,
    // size), so the host/archive byte fetch runs after the lock is released.
    enum Plan {
        Done(usize),
        Base(u64, u64),
        Lazy(u32, Vec<u8>, u64),
    }
    let plan = ROOTFS.with(|state| {
        let inode = state.get(idx).ok_or(Errno::EBADF)?;
        match &inode.kind {
            InodeKind::Regular(data) => {
                let start = offset as usize;
                if start >= data.len() {
                    return Ok(Plan::Done(0));
                }
                let n = core::cmp::min(buf.len(), data.len() - start);
                buf[..n].copy_from_slice(&data[start..start + n]);
                Ok(Plan::Done(n))
            }
            InodeKind::BaseRegular { blob_id, size } => Ok(Plan::Base(*blob_id, *size)),
            InodeKind::Dir(_) => Err(Errno::EISDIR),
            InodeKind::Symlink(_) => Err(Errno::EINVAL),
            InodeKind::Special(_) => Err(Errno::EINVAL),
            InodeKind::LazyMember {
                archive_id,
                source_path,
                size,
            } => Ok(Plan::Lazy(*archive_id, source_path.clone(), *size)),
        }
    })?;
    match plan {
        Plan::Done(n) => Ok(n),
        Plan::Base(blob_id, size) => {
            let start = offset as u64;
            if start >= size {
                return Ok(0);
            }
            let n = core::cmp::min(buf.len() as u64, size - start) as usize;
            byte_source(ByteReq::Base { blob_id, offset: start }, &mut buf[..n])
        }
        Plan::Lazy(archive_id, source_path, size) => {
            let start = offset as u64;
            if start >= size {
                return Ok(0);
            }
            let bytes = ensure_archive_member(archive_id, &source_path, &mut byte_source)?;
            // Defensive: clamp to the member's actual decoded length too, in
            // case it ever disagrees with the manifest-declared `size`.
            let avail = core::cmp::min(size, bytes.len() as u64);
            if start >= avail {
                return Ok(0);
            }
            let start_us = start as usize;
            let n = core::cmp::min(buf.len() as u64, avail - start) as usize;
            buf[..n].copy_from_slice(&bytes[start_us..start_us + n]);
            Ok(n)
        }
    }
}

/// Current size of an open rootfs file (for `SEEK_END`).
pub fn size(handle: i64) -> Result<i64, Errno> {
    let idx = file_handle_to_inode(handle)?;
    ROOTFS.with(|state| {
        let inode = state.get(idx).ok_or(Errno::EBADF)?;
        match &inode.kind {
            InodeKind::BaseRegular { size, .. } => Ok(*size as i64),
            InodeKind::Regular(data) => Ok(data.len() as i64),
            InodeKind::LazyMember { size, .. } => Ok(*size as i64),
            _ => Err(Errno::EISDIR),
        }
    })
}

/// POSIX `SYMLOOP_MAX`: the maximum number of symlink hops the host-facing read
/// resolver follows before yielding `ELOOP`.
const SYMLOOP_MAX: usize = 40;

/// Resolve a host-facing overlay read path, following a symlinked final
/// component within the overlay up to [`SYMLOOP_MAX`] hops — exactly like a
/// normal `open()` *without* `O_NOFOLLOW`. Returns the canonical absolute path
/// of the first non-symlink target.
///
/// Guest opens do NOT use this. The namespace resolver already follows symlinks
/// before calling [`open`], so [`open`] intentionally refuses a symlinked final
/// component with `ELOOP` (`O_NOFOLLOW` semantics — see [`open`]). But
/// host-initiated reads ([`read_file_at`] → `kernel_rootfs_read_file`, used to
/// materialize exec targets such as `/bin/sh` → `/bin/dash`) pass a RAW path
/// with no pre-resolution, so they would hit that spurious `ELOOP`. This helper
/// closes that host-side gap while leaving the guest `O_NOFOLLOW` path intact.
///
/// A relative link target resolves against the symlink's parent directory; an
/// absolute target restarts at the mount root; `.`/`..` components collapse.
fn resolve_read_symlinks(path: &[u8]) -> Result<Vec<u8>, Errno> {
    let mut comps: Vec<Vec<u8>> = split_components(path).iter().map(|c| c.to_vec()).collect();
    for _ in 0..SYMLOOP_MAX {
        let link_target = ROOTFS.with(|state| {
            let root = state.mount_root();
            let refs: Vec<&[u8]> = comps.iter().map(|c| c.as_slice()).collect();
            let idx = state.walk(root, &refs)?;
            match &state.get(idx).ok_or(Errno::ENOENT)?.kind {
                InodeKind::Symlink(target) => Ok::<_, Errno>(Some(target.clone())),
                _ => Ok(None),
            }
        })?;
        let Some(target) = link_target else {
            // First non-symlink target: rebuild its canonical absolute path.
            let mut out = Vec::new();
            for c in &comps {
                out.push(b'/');
                out.extend_from_slice(c);
            }
            if out.is_empty() {
                out.push(b'/');
            }
            return Ok(out);
        };
        // Rewrite the working path to the link target: an absolute target
        // restarts at the mount root, a relative one resolves against the
        // symlink's parent dir; `.` is dropped and `..` pops a component.
        let mut next: Vec<Vec<u8>> = if target.first() == Some(&b'/') {
            Vec::new()
        } else {
            comps[..comps.len().saturating_sub(1)].to_vec()
        };
        for part in target.split(|&b| b == b'/') {
            match part {
                b"" | b"." => {}
                b".." => {
                    next.pop();
                }
                _ => next.push(part.to_vec()),
            }
        }
        comps = next;
    }
    Err(Errno::ELOOP)
}

/// Read up to `buf.len()` bytes at `offset` from the rootfs file named by
/// `path` (open `O_RDONLY` + [`read`] + [`release_handle`]).
///
/// Host-facing convenience for the 2e cutover: after the host `/` mount is
/// dropped, the host reads authoritative `/` bytes through the overlay with this
/// instead of a stale base-image `MemoryFileSystem`. Copy-on-written bytes come
/// straight from the overlay; an unmodified base file's bytes come from
/// `byte_source` exactly as a guest read would fetch them.
///
/// A symlinked path is followed within the overlay ([`resolve_read_symlinks`],
/// bounded by [`SYMLOOP_MAX`]) so a host-initiated read of `/bin/sh` →
/// `/bin/dash` serves dash's bytes instead of failing `ELOOP` — the guest open
/// path pre-resolves symlinks, but this host-facing raw-path reader must not.
pub fn read_file_at<F>(
    path: &[u8],
    offset: i64,
    buf: &mut [u8],
    byte_source: F,
) -> Result<usize, Errno>
where
    F: FnMut(ByteReq, &mut [u8]) -> Result<usize, Errno>,
{
    let resolved = resolve_read_symlinks(path)?;
    let handle = open(&resolved, O_RDONLY, 0, 0, 0)?;
    let result = read(handle, offset, buf, byte_source);
    release_handle(handle);
    result
}

/// Write `buf` at `offset` to the rootfs file named by `path`, creating it if
/// absent. When `truncate` is set the file is first emptied and its mode set to
/// `mode` ("replace this whole file" — the host `write_vfs_file` contract);
/// otherwise an existing file's mode is preserved and the bytes land at
/// `offset` (chunked continuation). An unmodified base file is copied into the
/// overlay first (via `byte_source`) so a partial write keeps the untouched bytes.
///
/// Host-facing convenience for the 2e cutover so host-side `/` writes land in
/// the authoritative overlay and are visible to live guests.
pub fn write_file_at<F>(
    path: &[u8],
    offset: i64,
    buf: &[u8],
    mode: u32,
    truncate: bool,
    byte_source: F,
) -> Result<usize, Errno>
where
    F: FnMut(ByteReq, &mut [u8]) -> Result<usize, Errno>,
{
    let flags = O_WRONLY | O_CREAT | if truncate { O_TRUNC } else { 0 };
    let handle = open(path, flags, mode & 0o7777, 0, 0)?;
    let result = write(handle, offset, buf, byte_source);
    release_handle(handle);
    // open(O_CREAT) preserves an existing file's mode, so a truncating replace
    // sets it explicitly — create and replace then behave alike, matching the
    // host write_vfs_file handler.
    if truncate {
        chmod(path, mode & 0o7777)?;
    }
    result
}

/// fstat an open rootfs file handle.
pub fn fstat(handle: i64) -> Result<WasmStat, Errno> {
    let idx = file_handle_to_inode(handle)?;
    ROOTFS.with(|state| Ok(state.get(idx).ok_or(Errno::EBADF)?.stat()))
}

/// Add an owning reference (fork/dup inheriting a rootfs fd). Returns whether the
/// handle was recognized.
pub fn add_ref_handle(handle: i64) -> bool {
    let Ok(idx) = file_handle_to_inode(handle) else {
        return false;
    };
    ROOTFS.with(|state| {
        if let Some(inode) = state.get_mut(idx) {
            inode.open_count += 1;
            true
        } else {
            false
        }
    })
}

/// Drop one owning reference (close/exec-cloexec). Frees the inode if it was the
/// last reference and the file had already been unlinked (POSIX unlink-while-
/// open). Returns `true` when this drop released the final open reference.
pub fn release_handle(handle: i64) -> bool {
    let Ok(idx) = file_handle_to_inode(handle) else {
        return false;
    };
    ROOTFS.with(|state| {
        let Some(inode) = state.get_mut(idx) else {
            return false;
        };
        inode.open_count = inode.open_count.saturating_sub(1);
        let was_last = inode.open_count == 0;
        state.maybe_free(idx);
        was_last
    })
}

/// Whether a rootfs handle still names a live backing (trust-boundary check).
pub fn handle_is_live(handle: i64) -> bool {
    if let Ok(idx) = file_handle_to_inode(handle) {
        return ROOTFS.with(|state| state.get(idx).is_some());
    }
    if let Ok(idx) = dir_handle_to_iter(handle) {
        return ROOTFS.with(|state| {
            state
                .dir_iters
                .get(idx as usize)
                .map(|slot| slot.is_some())
                .unwrap_or(false)
        });
    }
    false
}

/// Open a directory stream over a rootfs directory, returning an encoded handle.
pub fn opendir(path: &[u8]) -> Result<i64, Errno> {
    let comps = split_components(path);
    ROOTFS.with(|state| {
        let root = state.mount_root();
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

/// Read the next entry from a rootfs directory stream. Mirrors `host_readdir`.
pub fn readdir(handle: i64, name_buf: &mut [u8]) -> Result<Option<(u64, u32, usize)>, Errno> {
    let iter_idx = dir_handle_to_iter(handle)?;
    ROOTFS.with(|state| {
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

/// getdents64 for a rootfs directory: build the entry list from the live store
/// and hand it to the shared virtual-dirent formatter (which injects `.`/`..`
/// and honors the cookie/short-buffer protocol). Returns
/// `(bytes_written, new_cookie, exhausted)`.
/// getdents64 for a rootfs directory. `extra` entries `(name, d_type, ino)` are
/// appended after the tree's own children (deduplicated by name) — the caller
/// uses this to inject the kernel's synthetic mount points (`/dev`, `/proc`) into
/// the `/` listing, which are not part of the image tree. The combined list flows
/// through the shared dirent formatter, so the cookie/short-buffer protocol
/// covers the injected entries uniformly.
pub fn getdents64(
    path: &[u8],
    buf: &mut [u8],
    offset: i64,
    extra: &[(&[u8], u8, u64)],
) -> Result<(usize, i64, bool), Errno> {
    let comps = split_components(path);
    let (dir_ino, mut entries) = ROOTFS.with(|state| {
        let root = state.mount_root();
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
    for &(name, d_type, ino) in extra {
        if !entries.iter().any(|(n, _, _)| n.as_slice() == name) {
            entries.push((name.to_vec(), d_type, ino));
        }
    }
    crate::procfs::write_virtual_dirents64(buf, offset, dir_ino, dir_ino, &entries)
}

/// Close a rootfs directory stream.
pub fn closedir(handle: i64) -> Result<(), Errno> {
    let iter_idx = dir_handle_to_iter(handle)?;
    ROOTFS.with(|state| {
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

/// mkdir a rootfs directory.
pub fn mkdir(path: &[u8], mode: u32, uid: u32, gid: u32) -> Result<(), Errno> {
    let comps = split_components(path);
    if comps.is_empty() {
        return Err(Errno::EEXIST); // the root already exists
    }
    ROOTFS.with(|state| {
        let (parent, last, target) = state.resolve(&comps)?;
        if target.is_some() {
            return Err(Errno::EEXIST);
        }
        let last = last.ok_or(Errno::ENOENT)?;
        let ino = state.alloc_ino();
        let new_idx = state.insert_inode(Inode::new(
            InodeKind::Dir(BTreeMap::new()),
            mode & 0o7777,
            uid,
            gid,
            2,
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

/// Remove an empty rootfs directory.
pub fn rmdir(path: &[u8]) -> Result<(), Errno> {
    let comps = split_components(path);
    if comps.is_empty() {
        return Err(Errno::EBUSY); // cannot remove the root
    }
    ROOTFS.with(|state| {
        let (parent, last, target) = state.resolve(&comps)?;
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

/// Unlink a rootfs non-directory name.
pub fn unlink(path: &[u8]) -> Result<(), Errno> {
    let comps = split_components(path);
    if comps.is_empty() {
        return Err(Errno::EISDIR);
    }
    ROOTFS.with(|state| {
        let (parent, last, target) = state.resolve(&comps)?;
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

/// Rename `old` to `new` within the rootfs. Both paths must be rootfs paths (the
/// syscall layer maps a rootfs/tmpfs or cross-authority rename to EXDEV before
/// reaching here). POSIX replace semantics: an existing destination of a
/// compatible type is atomically replaced; type mismatches yield ENOTDIR/EISDIR
/// and a non-empty destination directory yields ENOTEMPTY.
pub fn rename(old: &[u8], new: &[u8]) -> Result<(), Errno> {
    // A directory cannot be moved into its own subtree.
    if new.len() > old.len() && new.starts_with(old) && new[old.len()] == b'/' {
        return Err(Errno::EINVAL);
    }
    let old_comps = split_components(old);
    let new_comps = split_components(new);
    if old_comps.is_empty() || new_comps.is_empty() {
        return Err(Errno::EBUSY); // cannot rename the root
    }
    ROOTFS.with(|state| {
        let (old_parent, old_name, old_target) = state.resolve(&old_comps)?;
        let old_target = old_target.ok_or(Errno::ENOENT)?;
        let old_name = old_name.ok_or(Errno::ENOENT)?.to_vec();
        let (new_parent, new_name, new_existing) = state.resolve(&new_comps)?;
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

        state.recompute_dir_nlink(old_parent);
        if new_parent != old_parent {
            state.recompute_dir_nlink(new_parent);
        }
        Ok(())
    })
}

/// Create a hard link `new` to the existing file `old` within the rootfs. Hard
/// links to directories are EPERM; an existing destination is EEXIST. `old` is
/// not dereferenced (the kernel already applied the syscall's follow policy).
pub fn link(old: &[u8], new: &[u8]) -> Result<(), Errno> {
    let old_comps = split_components(old);
    let new_comps = split_components(new);
    if new_comps.is_empty() {
        return Err(Errno::EEXIST); // cannot link over the root
    }
    ROOTFS.with(|state| {
        let old_idx = {
            let root = state.mount_root();
            state.walk(root, &old_comps)?
        };
        if state.get(old_idx).ok_or(Errno::ENOENT)?.is_dir() {
            return Err(Errno::EPERM); // no hard links to directories
        }
        let (new_parent, new_name, new_existing) = state.resolve(&new_comps)?;
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

/// chmod a rootfs path (permission bits only).
pub fn chmod(path: &[u8], mode: u32) -> Result<(), Errno> {
    let idx = walk_to_inode(path)?;
    ROOTFS.with(|state| {
        let inode = state.get_mut(idx).ok_or(Errno::ENOENT)?;
        inode.mode = mode & 0o7777;
        inode.touch_changed();
        Ok(())
    })
}

/// chown a rootfs path. A field of `u32::MAX` (-1) is left unchanged. When
/// `clear_setid` is set, set-user-ID (and set-group-ID on a group-executable
/// file) is cleared, matching the host chown path.
pub fn chown(path: &[u8], uid: u32, gid: u32, clear_setid: bool) -> Result<(), Errno> {
    let idx = walk_to_inode(path)?;
    ROOTFS.with(|state| {
        let inode = state.get_mut(idx).ok_or(Errno::ENOENT)?;
        if uid != u32::MAX {
            inode.uid = uid;
        }
        if gid != u32::MAX {
            inode.gid = gid;
        }
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

/// fchmod an open rootfs file handle.
pub fn fchmod(handle: i64, mode: u32) -> Result<(), Errno> {
    let idx = file_handle_to_inode(handle)?;
    ROOTFS.with(|state| {
        let inode = state.get_mut(idx).ok_or(Errno::EBADF)?;
        inode.mode = mode & 0o7777;
        inode.touch_changed();
        Ok(())
    })
}

/// fchown an open rootfs file handle. A field of `u32::MAX` (-1) is unchanged.
pub fn fchown(handle: i64, uid: u32, gid: u32, clear_setid: bool) -> Result<(), Errno> {
    let idx = file_handle_to_inode(handle)?;
    ROOTFS.with(|state| {
        let inode = state.get_mut(idx).ok_or(Errno::EBADF)?;
        if uid != u32::MAX {
            inode.uid = uid;
        }
        if gid != u32::MAX {
            inode.gid = gid;
        }
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

/// Set a rootfs inode's timestamps to already-resolved values (the caller has
/// applied UTIME_NOW/UTIME_OMIT).
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
    ROOTFS.with(|state| {
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

/// Create a symbolic link at a rootfs path pointing at `target`.
pub fn symlink(target: &[u8], linkpath: &[u8], uid: u32, gid: u32) -> Result<(), Errno> {
    let comps = split_components(linkpath);
    if comps.is_empty() {
        return Err(Errno::EEXIST);
    }
    if target.is_empty() {
        return Err(Errno::ENOENT);
    }
    ROOTFS.with(|state| {
        let (parent, last, existing) = state.resolve(&comps)?;
        if existing.is_some() {
            return Err(Errno::EEXIST);
        }
        let last = last.ok_or(Errno::ENOENT)?;
        let ino = state.alloc_ino();
        let new_idx = state.insert_inode(Inode::new(
            InodeKind::Symlink(target.to_vec()),
            0o777,
            uid,
            gid,
            1,
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

/// Create a metadata-only special node (AF_UNIX socket or FIFO) at a rootfs
/// path. `type_bits` selects S_IFSOCK or S_IFIFO. EEXIST if the name is taken.
/// The communication endpoint (registry entry / fifo pipe) is owned elsewhere,
/// keyed by path; this only creates the filesystem node. Mirrors tmpfs.
pub fn mknod_special(
    path: &[u8],
    mode: u32,
    uid: u32,
    gid: u32,
    type_bits: u32,
) -> Result<(), Errno> {
    let comps = split_components(path);
    if comps.is_empty() {
        return Err(Errno::EEXIST);
    }
    ROOTFS.with(|state| {
        let (parent, last, existing) = state.resolve(&comps)?;
        if existing.is_some() {
            return Err(Errno::EEXIST);
        }
        let last = last.ok_or(Errno::ENOENT)?;
        let ino = state.alloc_ino();
        let new_idx = state.insert_inode(Inode::new(
            InodeKind::Special(type_bits & S_IFMT),
            mode & 0o7777,
            uid,
            gid,
            1,
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

/// statfs for the rootfs overlay: a memory-backed filesystem (its mutable layer
/// grows within kernel Wasm memory). The exact magic/flags are reconciled with
/// the host image backend at cutover (Increment 2e).
pub fn statfs(path: &[u8]) -> Result<WasmStatfs, Errno> {
    if !owns_path(path) {
        return Err(Errno::ENOENT);
    }
    Ok(WasmStatfs {
        f_type: 0x858458f6, // RAMFS_MAGIC (placeholder; reconciled at cutover)
        f_bsize: 4096,
        f_blocks: 262_144,
        f_bfree: 262_144,
        f_bavail: 262_144,
        f_files: 65_536,
        f_ffree: 65_536,
        f_fsid: 0,
        f_namelen: 255,
        f_frsize: 4096,
        f_flags: if is_nosuid() {
            wasm_posix_shared::statfs_flags::ST_NOSUID
        } else {
            0
        },
        _pad: 0,
    })
}

// ---------------------------------------------------------------------------
// Tree export (Phase 5 cutover): serialize the overlay-owned `/` tree so the
// host can rebuild a faithful VFS image from the *authoritative* overlay state
// instead of the frozen base image. See `handleExportRootfsImage` in the host
// worker entries and `host/src/vfs/rootfs-overlay-export.ts` for the matching
// reconciler.
//
// Wire format (little-endian) — the host reconciler must mirror it:
//   header: magic u32 = "RXPT" | version u32 = 1 | entry_count u32
//   entry:  kind u8 | mode u32 (0o7777 perm bits) | uid u32 | gid u32
//           mtime_sec u64 | mtime_nsec u32 | size u64
//           path_len u32 | path[path_len]   (absolute, "/" first)
//           target_len u32 | target[target_len]   (symlink target; else empty)
// Entries are emitted pre-order (parent before child) in the directory's
// BTreeMap order, so the layout is deterministic across chunked reads.
//
// File *bytes* are intentionally absent: the host reads copy-on-written bytes
// back through `kernel_rootfs_read_file`, and keeps base-file/lazy bytes from
// the frozen base image untouched (so a not-yet-materialized lazy file stays
// lazy in the exported image rather than being force-fetched).
// ---------------------------------------------------------------------------

pub const EXPORT_MAGIC: u32 = 0x5450_5852; // "RXPT" little-endian
pub const EXPORT_VERSION: u32 = 1;
/// A directory node.
pub const EXPORT_KIND_DIR: u8 = 1;
/// A base regular file (bytes live in the frozen base image; unchanged).
pub const EXPORT_KIND_BASE_REGULAR: u8 = 2;
/// A copy-on-written or runtime-created regular file (bytes owned by the
/// overlay; the host reads them via `kernel_rootfs_read_file`).
pub const EXPORT_KIND_COW_REGULAR: u8 = 3;
/// A symbolic link (target bytes follow in the record's `target` field).
pub const EXPORT_KIND_SYMLINK: u8 = 4;
/// A metadata-only special node (socket/FIFO). Not representable in a `/`
/// image; the host records it as skipped rather than fabricating bytes.
pub const EXPORT_KIND_SPECIAL: u8 = 5;
/// A lazy-archive member not yet materialized (bytes stay in the base image's
/// lazy archive; the host preserves the linkage rather than fetching).
pub const EXPORT_KIND_LAZY_MEMBER: u8 = 6;

fn export_emit(out: &mut Vec<u8>, inode: &Inode, abs_path: &[u8]) {
    let (kind, target): (u8, &[u8]) = match &inode.kind {
        InodeKind::Dir(_) => (EXPORT_KIND_DIR, b""),
        InodeKind::BaseRegular { .. } => (EXPORT_KIND_BASE_REGULAR, b""),
        InodeKind::Regular(_) => (EXPORT_KIND_COW_REGULAR, b""),
        InodeKind::Symlink(t) => (EXPORT_KIND_SYMLINK, t.as_slice()),
        InodeKind::Special(_) => (EXPORT_KIND_SPECIAL, b""),
        InodeKind::LazyMember { .. } => (EXPORT_KIND_LAZY_MEMBER, b""),
    };
    let size = inode.stat().st_size;
    out.push(kind);
    out.extend_from_slice(&(inode.mode & 0o7777).to_le_bytes());
    out.extend_from_slice(&inode.uid.to_le_bytes());
    out.extend_from_slice(&inode.gid.to_le_bytes());
    out.extend_from_slice(&inode.mtime_sec.to_le_bytes());
    out.extend_from_slice(&inode.mtime_nsec.to_le_bytes());
    out.extend_from_slice(&size.to_le_bytes());
    out.extend_from_slice(&(abs_path.len() as u32).to_le_bytes());
    out.extend_from_slice(abs_path);
    out.extend_from_slice(&(target.len() as u32).to_le_bytes());
    out.extend_from_slice(target);
}

fn export_walk(state: &RootfsState, idx: u32, abs_path: &[u8], out: &mut Vec<u8>, count: &mut u32) {
    let Some(inode) = state.get(idx) else {
        return;
    };
    export_emit(out, inode, abs_path);
    *count += 1;
    if let InodeKind::Dir(entries) = &inode.kind {
        for (name, &child) in entries.iter() {
            let mut child_path = Vec::with_capacity(abs_path.len() + 1 + name.len());
            if abs_path == b"/" {
                child_path.push(b'/');
            } else {
                child_path.extend_from_slice(abs_path);
                child_path.push(b'/');
            }
            child_path.extend_from_slice(name);
            export_walk(state, child, &child_path, out, count);
        }
    }
}

/// Serialize the entire overlay-owned `/` tree into an RXPT metadata buffer (see
/// the format doc above). Only inodes the overlay actually owns are present:
/// foreign mounts and tmpfs scratch keep their bytes in their own subsystems and
/// are never inserted here, so a raw pre-order walk already excludes them while
/// preserving mount-point directories (e.g. an empty `/dev`) exactly as the base
/// image carried them.
pub fn export_tree() -> Vec<u8> {
    ROOTFS.with(|state| {
        let mut out = Vec::new();
        out.extend_from_slice(&EXPORT_MAGIC.to_le_bytes());
        out.extend_from_slice(&EXPORT_VERSION.to_le_bytes());
        let count_pos = out.len();
        out.extend_from_slice(&0u32.to_le_bytes()); // entry_count placeholder
        let mut count = 0u32;
        if let Some(root) = state.root {
            export_walk(state, root, b"/", &mut out, &mut count);
        }
        out[count_pos..count_pos + 4].copy_from_slice(&count.to_le_bytes());
        out
    })
}

/// Chunk cache for [`export_tree_read`]: the host reads the (possibly large)
/// export buffer in scratch-region-sized chunks, so we serialize once on the
/// `offset == 0` chunk and serve the rest from this cache. Export runs only
/// against a quiescent overlay (the host closes the snapshot gate), so the
/// snapshot cannot change between chunks. Freed once the tail chunk is served.
struct ExportCache {
    locked: AtomicBool,
    buf: UnsafeCell<Vec<u8>>,
}

impl ExportCache {
    const fn new() -> Self {
        ExportCache {
            locked: AtomicBool::new(false),
            buf: UnsafeCell::new(Vec::new()),
        }
    }

    fn with<R>(&'static self, f: impl FnOnce(&mut Vec<u8>) -> R) -> R {
        while self
            .locked
            .compare_exchange_weak(false, true, Ordering::Acquire, Ordering::Relaxed)
            .is_err()
        {
            spin_loop();
        }
        let _unlock = UnlockOnDrop(&self.locked);
        // SAFETY: same invariant as RootfsGlobal — the spinlock is the sole gate
        // and no reference escapes the closure.
        let slot = unsafe { &mut *self.buf.get() };
        f(slot)
    }
}

// SAFETY: identical invariant to RootfsGlobal / ForeignMounts.
unsafe impl Sync for ExportCache {}

static EXPORT_CACHE: ExportCache = ExportCache::new();

/// Copy up to `out.len()` bytes of the overlay tree export at byte `offset` into
/// `out`, returning the number of bytes copied (0 at end of the buffer). The
/// `offset == 0` call (re)builds the snapshot; later calls serve from the cache.
/// The cache is freed once a read reaches (or passes) the end of the buffer.
pub fn export_tree_read(offset: i64, out: &mut [u8]) -> Result<usize, Errno> {
    if offset < 0 {
        return Err(Errno::EINVAL);
    }
    let offset = offset as usize;
    EXPORT_CACHE.with(|cache| {
        if offset == 0 {
            *cache = export_tree();
        }
        if offset >= cache.len() {
            cache.clear();
            cache.shrink_to_fit();
            return Ok(0);
        }
        let n = core::cmp::min(out.len(), cache.len() - offset);
        out[..n].copy_from_slice(&cache[offset..offset + n]);
        Ok(n)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Serialize tests: the store is a process-global singleton. Each test
    /// resets first, and no two run concurrently under this guard.
    static TEST_LOCK: AtomicBool = AtomicBool::new(false);

    struct TestGuard;
    impl TestGuard {
        fn acquire() -> Self {
            while TEST_LOCK
                .compare_exchange_weak(false, true, Ordering::Acquire, Ordering::Relaxed)
                .is_err()
            {
                spin_loop();
            }
            reset();
            set_now(1_000, 0);
            TestGuard
        }
    }
    impl Drop for TestGuard {
        fn drop(&mut self) {
            reset();
            set_enabled(false);
            TEST_LOCK.store(false, Ordering::Release);
        }
    }

    /// A small in-memory byte store standing in for the host `byte_source`
    /// dispatch closure — ONE closure serving both `ByteReq::Base` (blob
    /// store) and `ByteReq::Archive` (whole-archive fetch) requests, mirroring
    /// the kernel's single `&mut host` capture (Task 3's `ByteReq` unification
    /// collapses what used to be two separate closures/helpers,
    /// `make_blob_reader` + `make_archive_fetcher`, into this one). A request
    /// kind with no matching entry returns `ENOSYS` ("no backing configured
    /// for this transport op"), not a silent success. Returns the closure
    /// alongside a shared call counter (incremented only for `Archive`
    /// requests) so tests can assert whether an archive fetch actually
    /// happened (vs. served from the archive's `members` cache).
    fn make_byte_source(
        blobs: alloc::vec::Vec<(u64, alloc::vec::Vec<u8>)>,
        archives: alloc::vec::Vec<(u32, alloc::vec::Vec<u8>)>,
    ) -> (
        impl FnMut(ByteReq, &mut [u8]) -> Result<usize, Errno>,
        alloc::rc::Rc<core::cell::Cell<usize>>,
    ) {
        let calls = alloc::rc::Rc::new(core::cell::Cell::new(0usize));
        let counter = calls.clone();
        let source = move |req: ByteReq, buf: &mut [u8]| -> Result<usize, Errno> {
            match req {
                ByteReq::Base { blob_id, offset } => {
                    let (_, data) = blobs
                        .iter()
                        .find(|(id, _)| *id == blob_id)
                        .ok_or(Errno::ENOSYS)?;
                    let start = offset as usize;
                    if start >= data.len() {
                        return Ok(0);
                    }
                    let n = core::cmp::min(buf.len(), data.len() - start);
                    buf[..n].copy_from_slice(&data[start..start + n]);
                    Ok(n)
                }
                ByteReq::Archive { archive_id, offset } => {
                    counter.set(counter.get() + 1);
                    let (_, data) = archives
                        .iter()
                        .find(|(id, _)| *id == archive_id)
                        .ok_or(Errno::ENOSYS)?;
                    let start = offset as usize;
                    if start >= data.len() {
                        return Ok(0);
                    }
                    let n = core::cmp::min(buf.len(), data.len() - start);
                    buf[..n].copy_from_slice(&data[start..start + n]);
                    Ok(n)
                }
            }
        };
        (source, calls)
    }

    fn build_sample_tree() {
        insert_base_dir(b"/", 0o755, 0, 0, 1).unwrap();
        insert_base_dir(b"/usr", 0o755, 0, 0, 2).unwrap();
        insert_base_dir(b"/usr/bin", 0o755, 0, 0, 3).unwrap();
        insert_base_file(b"/usr/bin/hello", 42, 11, 0o755, 0, 0, 4).unwrap();
        insert_base_symlink(b"/usr/bin/hi", b"hello", 0o777, 0, 0, 5).unwrap();
        insert_base_file(b"/etc-issue-blob-empty", 43, 0, 0o644, 0, 0, 6).unwrap();
    }

    /// The real tiny.zip fixture (see `zip.rs` tests for member facts): a
    /// DEFLATE member `bin/big.txt` (4096 bytes, all `b'a'`) and a STORE
    /// member `etc/small.txt` (`b"hello\n"`).
    const TINY_ZIP: &[u8] = include_bytes!("testdata/tiny.zip");

    /// Register archive `archive_id`'s manifest-authoritative `size` directly
    /// in the registry, as `load_manifest_inner`'s v3 archive-table parsing
    /// would. Test-only: production always goes through the manifest loader.
    fn insert_archive_entry(archive_id: u32, size: u64) {
        ROOTFS.with(|state| {
            state.archives.insert(
                archive_id,
                ArchiveEntry {
                    size,
                    raw: None,
                    directory: None,
                    members: BTreeMap::new(),
                },
            );
        });
    }

    /// `/lazy/f` is a `LazyMember` pointing at `bin/big.txt` (size 4096) in
    /// archive 7, whose manifest-recorded size is `TINY_ZIP.len()`.
    fn build_lazy_tree() {
        insert_base_dir(b"/", 0o755, 0, 0, 1).unwrap();
        insert_base_dir(b"/lazy", 0o755, 0, 0, 2).unwrap();
        insert_lazy_file(b"/lazy/f", 7, b"bin/big.txt", 4096, 0o644, 0, 0, 3).unwrap();
        insert_archive_entry(7, TINY_ZIP.len() as u64);
    }

    #[test]
    fn owns_path_excludes_tmpfs_scratch_and_relative() {
        assert!(owns_path(b"/usr/bin/ls"));
        assert!(owns_path(b"/"));
        assert!(owns_path(b"/etc/passwd"));
        // tmpfs scratch prefixes belong to tmpfs, not rootfs.
        assert!(!owns_path(b"/tmp"));
        assert!(!owns_path(b"/tmp/x"));
        assert!(!owns_path(b"/var/run/php.sock"));
        // non-absolute is never a rootfs path.
        assert!(!owns_path(b"relative"));
    }

    #[test]
    fn owns_path_excludes_registered_foreign_mounts() {
        let _g = TestGuard::acquire();
        // Baseline: with nothing registered, sibling `/` paths are overlay-owned.
        assert!(owns_path(b"/run/kandelo-run/work/1-1.wasm"));
        assert!(owns_path(b"/dev/shm/sem.foo"));

        // The host registers the sibling mounts that remain after dropping `/`.
        let n = set_foreign_prefixes(b"/dev/shm\0/run/kandelo-run\0/mnt/data\0");
        assert_eq!(n, 3);

        // Paths at or under a foreign prefix are NOT overlay-owned: they must
        // fall through to the sibling host mount.
        assert!(!owns_path(b"/run/kandelo-run"));
        assert!(!owns_path(b"/run/kandelo-run/work/1-1.wasm"));
        assert!(!owns_path(b"/dev/shm"));
        assert!(!owns_path(b"/dev/shm/sem.foo"));
        assert!(!owns_path(b"/mnt/data/file"));

        // Siblings that share a leading path segment but are NOT under a
        // foreign mount stay overlay-owned (component-boundary match).
        assert!(owns_path(b"/run/other"));
        assert!(owns_path(b"/run/kandelo-runner")); // not `/run/kandelo-run/...`
        assert!(owns_path(b"/mnt/datastore")); // not `/mnt/data/...`
        assert!(owns_path(b"/usr/bin/ls"));
        assert!(owns_path(b"/"));

        // A fresh (empty) registration restores the greedy default.
        assert_eq!(set_foreign_prefixes(b""), 0);
        assert!(owns_path(b"/run/kandelo-run/work/1-1.wasm"));
    }

    #[test]
    fn set_foreign_prefixes_ignores_root_relative_and_dedupes() {
        let _g = TestGuard::acquire();
        // `/` (the overlay's own root) and non-absolute / empty entries are
        // dropped; trailing slashes trimmed; duplicates collapsed.
        let n = set_foreign_prefixes(b"/\0\0relative\0/dev/shm/\0/dev/shm\0");
        assert_eq!(n, 1);
        assert!(!owns_path(b"/dev/shm/x"));
        assert!(owns_path(b"/")); // root is never foreign
    }

    #[test]
    fn claims_path_gated_on_enable() {
        let _g = TestGuard::acquire();
        assert!(!claims_path(b"/usr/bin/ls"));
        set_enabled(true);
        assert!(claims_path(b"/usr/bin/ls"));
        assert!(!claims_path(b"/tmp/x")); // still tmpfs's
    }

    #[test]
    fn lstat_reports_kind_mode_and_size() {
        let _g = TestGuard::acquire();
        build_sample_tree();

        let d = lstat(b"/usr/bin").unwrap();
        assert_eq!(d.st_mode & S_IFMT, S_IFDIR);
        assert_eq!(d.st_mode & 0o7777, 0o755);

        let f = lstat(b"/usr/bin/hello").unwrap();
        assert_eq!(f.st_mode & S_IFMT, S_IFREG);
        assert_eq!(f.st_size, 11);
        assert_eq!(f.st_mode & 0o7777, 0o755);
        assert_eq!(f.st_dev, ROOTFS_DEV);
        assert_eq!(f.st_ino, 4);

        let l = lstat(b"/usr/bin/hi").unwrap();
        assert_eq!(l.st_mode & S_IFMT, S_IFLNK);
        assert_eq!(l.st_size, 5); // "hello"

        assert_eq!(lstat(b"/nope").unwrap_err(), Errno::ENOENT);
        assert_eq!(lstat(b"/usr/bin/hello/x").unwrap_err(), Errno::ENOTDIR);
    }

    #[test]
    fn readlink_returns_target() {
        let _g = TestGuard::acquire();
        build_sample_tree();
        let mut buf = [0u8; 64];
        let n = readlink(b"/usr/bin/hi", &mut buf).unwrap();
        assert_eq!(&buf[..n], b"hello");
        assert_eq!(readlink(b"/usr/bin/hello", &mut buf).unwrap_err(), Errno::EINVAL);
    }

    #[test]
    fn open_read_base_file_through_blob_callback() {
        let _g = TestGuard::acquire();
        build_sample_tree();
        let (mut blob, _) = make_byte_source(alloc::vec![(42u64, b"hello world".to_vec())], alloc::vec::Vec::new());

        let h = open(b"/usr/bin/hello", O_RDONLY, 0, 0, 0).unwrap();
        assert!(is_rootfs_file_handle(h));
        assert!(!crate::tmpfs::is_tmpfs_file_handle(h));
        assert!(!crate::tmpfs::is_tmpfs_dir_handle(h));

        assert_eq!(size(h).unwrap(), 11);
        let st = fstat(h).unwrap();
        assert_eq!(st.st_ino, 4);

        let mut buf = [0u8; 5];
        assert_eq!(read(h, 0, &mut buf, &mut blob).unwrap(), 5);
        assert_eq!(&buf, b"hello");

        let mut buf2 = [0u8; 32];
        assert_eq!(read(h, 6, &mut buf2, &mut blob).unwrap(), 5); // "world" (clamped to size 11)
        assert_eq!(&buf2[..5], b"world");

        // Read at/after EOF returns 0.
        assert_eq!(read(h, 11, &mut buf2, &mut blob).unwrap(), 0);

        assert!(release_handle(h));
    }

    #[test]
    fn empty_base_file_reads_zero_without_touching_blob() {
        let _g = TestGuard::acquire();
        build_sample_tree();
        // A reader that would panic if called proves the EOF clamp short-circuits.
        let mut blob = |_req: ByteReq, _buf: &mut [u8]| -> Result<usize, Errno> {
            panic!("blob_read must not be called for an empty file");
        };
        let h = open(b"/etc-issue-blob-empty", O_RDONLY, 0, 0, 0).unwrap();
        let mut buf = [0u8; 8];
        assert_eq!(read(h, 0, &mut buf, &mut blob).unwrap(), 0);
        assert!(release_handle(h));
    }

    #[test]
    fn open_directory_is_eisdir() {
        let _g = TestGuard::acquire();
        build_sample_tree();
        assert_eq!(open(b"/usr/bin", O_RDONLY, 0, 0, 0).unwrap_err(), Errno::EISDIR);
    }

    #[test]
    fn cow_write_materializes_base_then_overwrites() {
        let _g = TestGuard::acquire();
        build_sample_tree();
        let (mut blob, _) = make_byte_source(alloc::vec![(42u64, b"hello world".to_vec())], alloc::vec::Vec::new());
        // O_RDWR == 2.
        let h = open(b"/usr/bin/hello", 2, 0, 0, 0).unwrap();
        // Overwrite "world" -> "there".
        assert_eq!(write(h, 6, b"there", &mut blob).unwrap(), 5);
        // A reader that panics proves post-COW reads never touch the host.
        let mut panic_blob = |_req: ByteReq, _buf: &mut [u8]| -> Result<usize, Errno> {
            panic!("post-COW read must be served from the overlay");
        };
        let mut buf = [0u8; 16];
        let n = read(h, 0, &mut buf, &mut panic_blob).unwrap();
        assert_eq!(&buf[..n], b"hello there");
        assert_eq!(lstat(b"/usr/bin/hello").unwrap().st_size, 11);
        assert!(release_handle(h));
    }

    #[test]
    fn cow_write_past_eof_zero_fills() {
        let _g = TestGuard::acquire();
        build_sample_tree();
        let (mut blob, _) = make_byte_source(alloc::vec![(42u64, b"hello world".to_vec())], alloc::vec::Vec::new());
        let h = open(b"/usr/bin/hello", 2, 0, 0, 0).unwrap();
        assert_eq!(write(h, 13, b"X", &mut blob).unwrap(), 1);
        let mut buf = [0u8; 32];
        let n = read(h, 0, &mut buf, &mut blob).unwrap();
        assert_eq!(n, 14);
        assert_eq!(&buf[..11], b"hello world");
        assert_eq!(&buf[11..13], &[0u8, 0u8]); // zero-fill gap
        assert_eq!(buf[13], b'X');
        assert!(release_handle(h));
    }

    #[test]
    fn write_clears_setuid_bit() {
        let _g = TestGuard::acquire();
        insert_base_dir(b"/", 0o755, 0, 0, 1).unwrap();
        insert_base_file(b"/suid", 7, 3, 0o4755, 0, 0, 2).unwrap();
        let (mut blob, _) = make_byte_source(alloc::vec![(7u64, b"abc".to_vec())], alloc::vec::Vec::new());
        assert_eq!(lstat(b"/suid").unwrap().st_mode & 0o7777, 0o4755);
        let h = open(b"/suid", 2, 0, 0, 0).unwrap();
        write(h, 0, b"Z", &mut blob).unwrap();
        assert_eq!(lstat(b"/suid").unwrap().st_mode & 0o7777, 0o0755);
        release_handle(h);
    }

    #[test]
    fn otrunc_discards_base_without_reading_blob() {
        let _g = TestGuard::acquire();
        build_sample_tree();
        // O_WRONLY|O_TRUNC == 1|0o1000; blob reader must not be called.
        let mut panic_blob = |_req: ByteReq, _buf: &mut [u8]| -> Result<usize, Errno> {
            panic!("O_TRUNC must not read base bytes");
        };
        let h = open(b"/usr/bin/hello", 1 | O_TRUNC, 0, 0, 0).unwrap();
        assert_eq!(size(h).unwrap(), 0);
        assert_eq!(write(h, 0, b"new", &mut panic_blob).unwrap(), 3);
        let mut buf = [0u8; 8];
        assert_eq!(read(h, 0, &mut buf, &mut panic_blob).unwrap(), 3);
        assert_eq!(&buf[..3], b"new");
        release_handle(h);
    }

    #[test]
    fn create_new_file_under_dir() {
        let _g = TestGuard::acquire();
        build_sample_tree();
        let (mut blob, _) = make_byte_source(alloc::vec![], alloc::vec::Vec::new());
        // O_CREAT|O_WRONLY == 0o100|1.
        let h = open(b"/usr/bin/fresh", O_CREAT | 1, 0o644, 7, 8).unwrap();
        assert_eq!(write(h, 0, b"data", &mut blob).unwrap(), 4);
        release_handle(h);
        let st = lstat(b"/usr/bin/fresh").unwrap();
        assert_eq!(st.st_mode & S_IFMT, S_IFREG);
        assert_eq!(st.st_mode & 0o7777, 0o644);
        assert_eq!(st.st_uid, 7);
        assert_eq!(st.st_gid, 8);
        assert_eq!(st.st_size, 4);
        // O_CREAT|O_EXCL on the now-existing file fails.
        assert_eq!(
            open(b"/usr/bin/fresh", O_CREAT | O_EXCL | 1, 0o644, 0, 0).unwrap_err(),
            Errno::EEXIST
        );
    }

    #[test]
    fn truncate_grow_and_shrink() {
        let _g = TestGuard::acquire();
        build_sample_tree();
        let (mut blob, _) = make_byte_source(alloc::vec![(42u64, b"hello world".to_vec())], alloc::vec::Vec::new());
        let h = open(b"/usr/bin/hello", 2, 0, 0, 0).unwrap();
        // Shrink to 5.
        truncate_handle(h, 5, &mut blob).unwrap();
        assert_eq!(size(h).unwrap(), 5);
        // Grow to 8 (zero-filled).
        truncate_handle(h, 8, &mut blob).unwrap();
        let mut buf = [0u8; 16];
        let n = read(h, 0, &mut buf, &mut blob).unwrap();
        assert_eq!(n, 8);
        assert_eq!(&buf[..5], b"hello");
        assert_eq!(&buf[5..8], &[0u8, 0u8, 0u8]);
        release_handle(h);
    }

    #[test]
    fn create_missing_without_ocreat_is_enoent() {
        let _g = TestGuard::acquire();
        build_sample_tree();
        assert_eq!(open(b"/usr/bin/nope", 1, 0, 0, 0).unwrap_err(), Errno::ENOENT);
    }

    #[test]
    fn mkdir_rmdir_lifecycle() {
        let _g = TestGuard::acquire();
        build_sample_tree();
        mkdir(b"/usr/lib", 0o755, 0, 0).unwrap();
        assert!(is_dir(b"/usr/lib"));
        assert_eq!(mkdir(b"/usr/lib", 0o755, 0, 0).unwrap_err(), Errno::EEXIST);
        // The parent's link count reflects each subdir's `..`.
        let usr = lstat(b"/usr").unwrap();
        assert_eq!(usr.st_nlink, 4); // 2 (self + `.`) + 2 subdirs (bin, lib)
        rmdir(b"/usr/lib").unwrap();
        assert_eq!(lstat(b"/usr/lib").unwrap_err(), Errno::ENOENT);
        assert_eq!(rmdir(b"/usr/bin").unwrap_err(), Errno::ENOTEMPTY);
        assert_eq!(rmdir(b"/").unwrap_err(), Errno::EBUSY);
    }

    #[test]
    fn unlink_base_and_created_files() {
        let _g = TestGuard::acquire();
        build_sample_tree();
        // Unlink a base file: the entry disappears (bytes stay in the host).
        unlink(b"/usr/bin/hello").unwrap();
        assert_eq!(lstat(b"/usr/bin/hello").unwrap_err(), Errno::ENOENT);
        assert_eq!(unlink(b"/usr/bin/hello").unwrap_err(), Errno::ENOENT);
        // Unlinking a directory is EISDIR (use rmdir).
        assert_eq!(unlink(b"/usr/bin").unwrap_err(), Errno::EISDIR);
    }

    #[test]
    fn unlink_while_open_defers_free() {
        let _g = TestGuard::acquire();
        build_sample_tree();
        let (mut blob, _) = make_byte_source(alloc::vec![(42u64, b"hello world".to_vec())], alloc::vec::Vec::new());
        let h = open(b"/usr/bin/hello", O_RDONLY, 0, 0, 0).unwrap();
        unlink(b"/usr/bin/hello").unwrap();
        // Name is gone, but the open handle still reads (unlink-while-open).
        assert_eq!(lstat(b"/usr/bin/hello").unwrap_err(), Errno::ENOENT);
        let mut buf = [0u8; 5];
        assert_eq!(read(h, 0, &mut buf, &mut blob).unwrap(), 5);
        assert_eq!(&buf, b"hello");
        assert!(release_handle(h)); // frees now
        assert!(!handle_is_live(h));
    }

    #[test]
    fn rename_moves_and_replaces() {
        let _g = TestGuard::acquire();
        build_sample_tree();
        // Move a file to a new name in another dir.
        mkdir(b"/opt", 0o755, 0, 0).unwrap();
        rename(b"/usr/bin/hello", b"/opt/hello").unwrap();
        assert_eq!(lstat(b"/usr/bin/hello").unwrap_err(), Errno::ENOENT);
        assert_eq!(lstat(b"/opt/hello").unwrap().st_size, 11);
        // Replace an existing regular destination atomically.
        insert_base_file(b"/opt/other", 44, 3, 0o644, 0, 0, 20).unwrap();
        rename(b"/opt/hello", b"/opt/other").unwrap();
        assert_eq!(lstat(b"/opt/other").unwrap().st_size, 11);
        // Directory-into-own-subtree is EINVAL.
        assert_eq!(rename(b"/opt", b"/opt/sub").unwrap_err(), Errno::EINVAL);
    }

    #[test]
    fn hard_link_shares_inode() {
        let _g = TestGuard::acquire();
        build_sample_tree();
        link(b"/usr/bin/hello", b"/usr/bin/hello2").unwrap();
        let a = lstat(b"/usr/bin/hello").unwrap();
        let b = lstat(b"/usr/bin/hello2").unwrap();
        assert_eq!(a.st_ino, b.st_ino);
        assert_eq!(a.st_nlink, 2);
        // Removing one name leaves the other.
        unlink(b"/usr/bin/hello").unwrap();
        assert_eq!(lstat(b"/usr/bin/hello2").unwrap().st_nlink, 1);
        // No hard links to directories.
        assert_eq!(link(b"/usr/bin", b"/bin2").unwrap_err(), Errno::EPERM);
    }

    #[test]
    fn chmod_chown_and_symlink_creation() {
        let _g = TestGuard::acquire();
        build_sample_tree();
        chmod(b"/usr/bin/hello", 0o600).unwrap();
        assert_eq!(lstat(b"/usr/bin/hello").unwrap().st_mode & 0o7777, 0o600);
        chown(b"/usr/bin/hello", 5, 6, false).unwrap();
        let st = lstat(b"/usr/bin/hello").unwrap();
        assert_eq!((st.st_uid, st.st_gid), (5, 6));
        // -1 leaves a field unchanged.
        chown(b"/usr/bin/hello", u32::MAX, 9, false).unwrap();
        let st = lstat(b"/usr/bin/hello").unwrap();
        assert_eq!((st.st_uid, st.st_gid), (5, 9));
        // chown clears set-uid when asked.
        chmod(b"/usr/bin/hello", 0o4755).unwrap();
        chown(b"/usr/bin/hello", 1, 1, true).unwrap();
        assert_eq!(lstat(b"/usr/bin/hello").unwrap().st_mode & 0o7777, 0o0755);

        symlink(b"../lib/x", b"/usr/bin/newlink", 0, 0).unwrap();
        let mut buf = [0u8; 32];
        let n = readlink(b"/usr/bin/newlink", &mut buf).unwrap();
        assert_eq!(&buf[..n], b"../lib/x");
        assert_eq!(symlink(b"y", b"/usr/bin/newlink", 0, 0).unwrap_err(), Errno::EEXIST);
    }

    #[allow(clippy::too_many_arguments)]
    fn enc_entry(
        out: &mut alloc::vec::Vec<u8>,
        kind: u8,
        mode: u32,
        uid: u32,
        gid: u32,
        ino: u64,
        blob_id: u64,
        size: u64,
        mtime_sec: u64,
        mtime_nsec: u32,
        path: &[u8],
        target: &[u8],
    ) {
        out.push(kind);
        out.extend_from_slice(&mode.to_le_bytes());
        out.extend_from_slice(&uid.to_le_bytes());
        out.extend_from_slice(&gid.to_le_bytes());
        out.extend_from_slice(&ino.to_le_bytes());
        out.extend_from_slice(&blob_id.to_le_bytes());
        out.extend_from_slice(&size.to_le_bytes());
        out.extend_from_slice(&mtime_sec.to_le_bytes());
        out.extend_from_slice(&mtime_nsec.to_le_bytes());
        out.extend_from_slice(&(path.len() as u32).to_le_bytes());
        out.extend_from_slice(path);
        out.extend_from_slice(&(target.len() as u32).to_le_bytes());
        out.extend_from_slice(target);
    }

    #[test]
    fn load_manifest_round_trips_a_tree() {
        let _g = TestGuard::acquire();
        let mut m = alloc::vec::Vec::new();
        m.extend_from_slice(&MANIFEST_MAGIC.to_le_bytes());
        m.extend_from_slice(&MANIFEST_VERSION.to_le_bytes());
        m.extend_from_slice(&4u32.to_le_bytes()); // entry count
        // mtime 315532800 = 1980-01-01 (the image's real deterministic-build time).
        enc_entry(&mut m, 1, 0o755, 0, 0, 1, 0, 0, 315532800, 0, b"/", b"");
        enc_entry(&mut m, 1, 0o755, 0, 0, 2, 0, 0, 315532800, 0, b"/usr", b"");
        enc_entry(&mut m, 2, 0o644, 0, 0, 3, 99, 12, 315532800, 500, b"/usr/greeting", b"");
        enc_entry(&mut m, 3, 0o777, 0, 0, 4, 0, 0, 315532800, 0, b"/usr/link", b"greeting");

        assert_eq!(load_manifest(&m).unwrap(), 4);

        let d = lstat(b"/usr").unwrap();
        assert_eq!(d.st_mode & S_IFMT, S_IFDIR);
        let f = lstat(b"/usr/greeting").unwrap();
        assert_eq!(f.st_mode & S_IFMT, S_IFREG);
        assert_eq!(f.st_size, 12);
        assert_eq!(f.st_ino, 3);
        // The image's real mtime is preserved (not the boot clock).
        assert_eq!((f.st_mtime_sec, f.st_mtime_nsec), (315532800, 500));

        // The base file reads its bytes through blob_id 99.
        let (mut blob, _) = make_byte_source(alloc::vec![(99u64, b"hello, world".to_vec())], alloc::vec::Vec::new());
        let h = open(b"/usr/greeting", O_RDONLY, 0, 0, 0).unwrap();
        let mut buf = [0u8; 16];
        let n = read(h, 0, &mut buf, &mut blob).unwrap();
        assert_eq!(&buf[..n], b"hello, world");
        release_handle(h);

        let mut lbuf = [0u8; 32];
        let ln = readlink(b"/usr/link", &mut lbuf).unwrap();
        assert_eq!(&lbuf[..ln], b"greeting");
    }

    #[test]
    fn load_manifest_rejects_bad_magic_and_leaves_empty() {
        let _g = TestGuard::acquire();
        build_sample_tree(); // pre-existing state that reset() must clear
        let mut m = alloc::vec::Vec::new();
        m.extend_from_slice(&0xDEAD_BEEFu32.to_le_bytes());
        m.extend_from_slice(&MANIFEST_VERSION.to_le_bytes());
        m.extend_from_slice(&0u32.to_le_bytes());
        assert_eq!(load_manifest(&m).unwrap_err(), Errno::EINVAL);
        // Reset-on-failure: the store is empty, not the pre-existing tree.
        assert_eq!(lstat(b"/usr/bin/hello").unwrap_err(), Errno::ENOENT);
    }

    #[test]
    fn load_manifest_rejects_truncated_buffer() {
        let _g = TestGuard::acquire();
        let mut m = alloc::vec::Vec::new();
        m.extend_from_slice(&MANIFEST_MAGIC.to_le_bytes());
        m.extend_from_slice(&MANIFEST_VERSION.to_le_bytes());
        m.extend_from_slice(&2u32.to_le_bytes()); // claims 2 entries
        enc_entry(&mut m, 1, 0o755, 0, 0, 1, 0, 0, 0, 0, b"/", b"");
        // second entry missing entirely -> short read
        assert_eq!(load_manifest(&m).unwrap_err(), Errno::EINVAL);
    }

    #[test]
    fn load_manifest_v3_parses_lazy_file_and_archive_table() {
        let _g = TestGuard::acquire();
        let mut m = alloc::vec::Vec::new();
        m.extend_from_slice(&MANIFEST_MAGIC.to_le_bytes());
        m.extend_from_slice(&MANIFEST_VERSION_V3.to_le_bytes());
        m.extend_from_slice(&4u32.to_le_bytes()); // entry count
        enc_entry(&mut m, 1, 0o755, 0, 0, 1, 0, 0, 0, 0, b"/", b"");
        enc_entry(&mut m, 1, 0o755, 0, 0, 2, 0, 0, 0, 0, b"/a", b"");
        enc_entry(&mut m, 2, 0o644, 0, 0, 3, 55, 6, 0, 0, b"/a/f", b"");
        // Lazy file /a/g: kind=4, size=999 from the manifest, target empty; the
        // archive_id + source_path fields are appended right after `target`.
        enc_entry(&mut m, 4, 0o644, 0, 0, 4, 0, 999, 0, 0, b"/a/g", b"");
        m.extend_from_slice(&7u32.to_le_bytes()); // archive_id
        m.extend_from_slice(&5u32.to_le_bytes()); // source_path_len
        m.extend_from_slice(b"bin/g"); // source_path
        // Trailing archive table (v3 only): count=1, archive_id=7 size=1234.
        m.extend_from_slice(&1u32.to_le_bytes());
        m.extend_from_slice(&7u32.to_le_bytes());
        m.extend_from_slice(&1234u64.to_le_bytes());

        assert_eq!(load_manifest(&m).unwrap(), 4);

        // The lazy file is placed under its parent with the manifest's metadata.
        let g = lstat(b"/a/g").unwrap();
        assert_eq!(g.st_mode & S_IFMT, S_IFREG);
        assert_eq!(g.st_mode & 0o7777, 0o644);
        assert_eq!(g.st_size, 999);
        assert_eq!(g.st_ino, 4);

        // (archive_id, source_path) round-trips via the test accessor.
        let (archive_id, source_path) = lazy_member_source(b"/a/g").unwrap();
        assert_eq!(archive_id, 7);
        assert_eq!(source_path, b"bin/g".to_vec());
        assert_eq!(archive_size(7), Some(1234));
        assert_eq!(archive_size(99), None);

        // Byte-serving is not implemented yet: read is a truthful ENOSYS, not a
        // hidden success or silent zero-fill.
        let h = open(b"/a/g", O_RDONLY, 0, 0, 0).unwrap();
        let mut buf = [0u8; 8];
        let (mut blob, _) = make_byte_source(alloc::vec::Vec::new(), alloc::vec::Vec::new());
        assert_eq!(read(h, 0, &mut buf, &mut blob).unwrap_err(), Errno::ENOSYS);
        release_handle(h);
    }

    #[test]
    fn open_o_trunc_on_lazy_member_is_enosys_not_silent_conversion() {
        let _g = TestGuard::acquire();
        let mut m = alloc::vec::Vec::new();
        m.extend_from_slice(&MANIFEST_MAGIC.to_le_bytes());
        m.extend_from_slice(&MANIFEST_VERSION_V3.to_le_bytes());
        m.extend_from_slice(&2u32.to_le_bytes());
        enc_entry(&mut m, 1, 0o755, 0, 0, 1, 0, 0, 0, 0, b"/", b"");
        enc_entry(&mut m, 4, 0o644, 0, 0, 2, 0, 999, 0, 0, b"/g", b"");
        m.extend_from_slice(&7u32.to_le_bytes()); // archive_id
        m.extend_from_slice(&5u32.to_le_bytes()); // source_path_len
        m.extend_from_slice(b"bin/g"); // source_path
        m.extend_from_slice(&1u32.to_le_bytes()); // archive table: 1 entry
        m.extend_from_slice(&7u32.to_le_bytes());
        m.extend_from_slice(&1234u64.to_le_bytes());
        assert_eq!(load_manifest(&m).unwrap(), 2);

        // Opening the lazy-archive placeholder with O_TRUNC for write must not
        // silently convert it into an empty writable file (which would drop
        // its archive_id/source_path/size and hand back fabricated success).
        assert_eq!(
            open(b"/g", O_WRONLY | O_TRUNC, 0, 0, 0).unwrap_err(),
            Errno::ENOSYS
        );

        // The node is still a LazyMember afterward: metadata and the
        // (archive_id, source_path) mapping are unchanged.
        let st = lstat(b"/g").unwrap();
        assert_eq!(st.st_mode & S_IFMT, S_IFREG);
        assert_eq!(st.st_size, 999);
        let (archive_id, source_path) = lazy_member_source(b"/g").unwrap();
        assert_eq!(archive_id, 7);
        assert_eq!(source_path, b"bin/g".to_vec());
    }

    #[test]
    fn load_manifest_v2_manifest_still_loads() {
        let _g = TestGuard::acquire();
        let mut m = alloc::vec::Vec::new();
        m.extend_from_slice(&MANIFEST_MAGIC.to_le_bytes());
        m.extend_from_slice(&MANIFEST_VERSION.to_le_bytes()); // version 2, no archive table
        m.extend_from_slice(&1u32.to_le_bytes());
        enc_entry(&mut m, 1, 0o755, 0, 0, 1, 0, 0, 0, 0, b"/", b"");
        assert_eq!(load_manifest(&m).unwrap(), 1);
        assert!(is_dir(b"/"));
    }

    #[test]
    fn load_manifest_v3_rejects_truncated_archive_table() {
        let _g = TestGuard::acquire();
        build_sample_tree(); // pre-existing state that reset() must clear
        let mut m = alloc::vec::Vec::new();
        m.extend_from_slice(&MANIFEST_MAGIC.to_le_bytes());
        m.extend_from_slice(&MANIFEST_VERSION_V3.to_le_bytes());
        m.extend_from_slice(&1u32.to_le_bytes());
        enc_entry(&mut m, 1, 0o755, 0, 0, 1, 0, 0, 0, 0, b"/", b"");
        m.extend_from_slice(&2u32.to_le_bytes()); // claims 2 archive entries
        m.extend_from_slice(&7u32.to_le_bytes());
        m.extend_from_slice(&1234u64.to_le_bytes());
        // second archive entry missing -> short read
        assert_eq!(load_manifest(&m).unwrap_err(), Errno::EINVAL);
        // Reset-on-failure covers the archive registry too.
        assert_eq!(lstat(b"/usr/bin/hello").unwrap_err(), Errno::ENOENT);
        assert_eq!(archive_size(7), None);
    }

    #[test]
    fn load_manifest_rejects_unknown_version() {
        let _g = TestGuard::acquire();
        let mut m = alloc::vec::Vec::new();
        m.extend_from_slice(&MANIFEST_MAGIC.to_le_bytes());
        m.extend_from_slice(&4u32.to_le_bytes()); // no such version yet
        m.extend_from_slice(&0u32.to_le_bytes());
        assert_eq!(load_manifest(&m).unwrap_err(), Errno::EINVAL);
    }

    /// Cross-language round-trip fixture: a v3 RTFS manifest emitted by the
    /// REAL TypeScript emitter (`emitRootfsManifest` in
    /// host/src/vfs/rootfs-manifest.ts), committed at
    /// `testdata/rtfs-v3-lazy.bin` and regenerated via
    /// `host/scripts/gen-rtfs-v3-fixture.mts`. If the TS emitter and this
    /// loader ever disagree on the v3 wire format, this test — not just the
    /// hand-built byte vectors above — is what catches the drift.
    const RTFS_V3_FIXTURE: &[u8] = include_bytes!("testdata/rtfs-v3-lazy.bin");

    #[test]
    fn load_manifest_ts_emitted_v3_fixture_round_trips() {
        let _g = TestGuard::acquire();

        assert_eq!(&RTFS_V3_FIXTURE[0..4], &MANIFEST_MAGIC.to_le_bytes());
        assert_eq!(&RTFS_V3_FIXTURE[4..8], &MANIFEST_VERSION_V3.to_le_bytes());

        // Tree: /, /a (dir), /a/f (base file), /a/g (lazy file).
        assert_eq!(load_manifest(RTFS_V3_FIXTURE).unwrap(), 4);

        let root = lstat(b"/").unwrap();
        assert_eq!(root.st_mode & S_IFMT, S_IFDIR);

        let a = lstat(b"/a").unwrap();
        assert_eq!(a.st_mode & S_IFMT, S_IFDIR);
        assert_eq!(a.st_mode & 0o7777, 0o755);

        let f = lstat(b"/a/f").unwrap();
        assert_eq!(f.st_mode & S_IFMT, S_IFREG);
        assert_eq!(f.st_mode & 0o7777, 0o644);
        assert_eq!(f.st_size, 6); // b"hello\n"

        let g = lstat(b"/a/g").unwrap();
        assert_eq!(g.st_mode & S_IFMT, S_IFREG);
        assert_eq!(g.st_mode & 0o7777, 0o644);
        assert_eq!(g.st_size, 12); // b"lazy content"

        let (archive_id, source_path) = lazy_member_source(b"/a/g").unwrap();
        assert_eq!(archive_id, 7);
        assert_eq!(source_path, b"bin/g".to_vec());
        assert_eq!(archive_size(7), Some(1234));
    }

    #[test]
    fn special_socket_and_fifo_nodes() {
        let _g = TestGuard::acquire();
        insert_base_dir(b"/", 0o755, 0, 0, 1).unwrap();
        insert_base_dir(b"/run", 0o755, 0, 0, 2).unwrap();
        mknod_special(b"/run/s.sock", 0o755, 7, 8, S_IFSOCK).unwrap();
        mknod_special(b"/run/f.fifo", 0o644, 0, 0, wasm_posix_shared::mode::S_IFIFO).unwrap();

        let s = lstat(b"/run/s.sock").unwrap();
        assert_eq!(s.st_mode & S_IFMT, S_IFSOCK);
        assert_eq!((s.st_uid, s.st_gid), (7, 8));
        assert_eq!(s.st_size, 0);
        let f = lstat(b"/run/f.fifo").unwrap();
        assert_eq!(f.st_mode & S_IFMT, wasm_posix_shared::mode::S_IFIFO);

        // A special node cannot be opened as a regular file.
        assert_eq!(open(b"/run/s.sock", O_RDONLY, 0, 0, 0).unwrap_err(), Errno::ENXIO);
        // Duplicate mknod is EEXIST.
        assert_eq!(
            mknod_special(b"/run/s.sock", 0o755, 0, 0, S_IFSOCK).unwrap_err(),
            Errno::EEXIST
        );

        // getdents lists both nodes.
        let mut buf = [0u8; 512];
        let (n, _c, _d) = getdents64(b"/run", &mut buf, 0, &[]).unwrap();
        assert!(buf[..n].windows(6).any(|w| w == b"s.sock"));
        assert!(buf[..n].windows(6).any(|w| w == b"f.fifo"));

        unlink(b"/run/s.sock").unwrap();
        assert_eq!(lstat(b"/run/s.sock").unwrap_err(), Errno::ENOENT);
    }

    #[test]
    fn utimensat_sets_times() {
        let _g = TestGuard::acquire();
        build_sample_tree();
        utimensat(b"/usr/bin/hello", 100, 1, 200, 2, 300, 3).unwrap();
        let st = lstat(b"/usr/bin/hello").unwrap();
        assert_eq!((st.st_atime_sec, st.st_atime_nsec), (100, 1));
        assert_eq!((st.st_mtime_sec, st.st_mtime_nsec), (200, 2));
        assert_eq!((st.st_ctime_sec, st.st_ctime_nsec), (300, 3));
    }

    #[test]
    fn opendir_readdir_lists_children() {
        let _g = TestGuard::acquire();
        build_sample_tree();
        let h = opendir(b"/usr/bin").unwrap();
        assert!(is_rootfs_dir_handle(h));
        let mut names: alloc::vec::Vec<alloc::vec::Vec<u8>> = alloc::vec::Vec::new();
        let mut namebuf = [0u8; 256];
        while let Some((_ino, _dt, n)) = readdir(h, &mut namebuf).unwrap() {
            names.push(namebuf[..n].to_vec());
        }
        names.sort();
        assert_eq!(names, alloc::vec![b"hello".to_vec(), b"hi".to_vec()]);
        closedir(h).unwrap();
        assert_eq!(readdir(h, &mut namebuf).unwrap_err(), Errno::EBADF);
    }

    #[test]
    fn getdents64_injects_dot_entries() {
        let _g = TestGuard::acquire();
        build_sample_tree();
        let mut buf = [0u8; 512];
        let (written, _cookie, _done) = getdents64(b"/usr/bin", &mut buf, 0, &[]).unwrap();
        assert!(written > 0);
        // The formatter injects "." and ".."; the raw buffer should contain the
        // child names too.
        let hay = &buf[..written];
        assert!(hay.windows(5).any(|w| w == b"hello"));
        assert!(hay.windows(2).any(|w| w == b"hi"));
    }

    #[test]
    fn getdents64_injects_and_dedups_root_virtuals() {
        let _g = TestGuard::acquire();
        // A root with a real `bin` dir but no `dev`/`proc` (those are synthetic
        // kernel mounts, injected via `extra`), plus a name that collides with an
        // injected virtual to exercise dedup.
        insert_base_dir(b"/", 0o755, 0, 0, 1).unwrap();
        insert_base_dir(b"/bin", 0o755, 0, 0, 2).unwrap();
        insert_base_dir(b"/dev", 0o755, 0, 0, 3).unwrap(); // already present
        let extra: &[(&[u8], u8, u64)] = &[(b"dev", 4, 2), (b"proc", 4, 2)];
        let mut buf = [0u8; 512];
        let (written, _c, _d) = getdents64(b"/", &mut buf, 0, extra).unwrap();
        let hay = &buf[..written];
        assert!(hay.windows(3).any(|w| w == b"bin"));
        assert!(hay.windows(4).any(|w| w == b"proc")); // injected
        // `dev` present exactly once (the base entry; the injected one is deduped).
        let dev_hits = (0..hay.len().saturating_sub(2))
            .filter(|&i| &hay[i..i + 3] == b"dev")
            .count();
        assert_eq!(dev_hits, 1, "dev should appear once, not duplicated");
    }

    #[test]
    fn is_dir_predicate() {
        let _g = TestGuard::acquire();
        build_sample_tree();
        assert!(is_dir(b"/usr/bin"));
        assert!(!is_dir(b"/usr/bin/hello"));
        assert!(!is_dir(b"/nope"));
    }

    #[test]
    fn duplicate_insert_is_eexist_and_missing_parent_enoent() {
        let _g = TestGuard::acquire();
        insert_base_dir(b"/", 0o755, 0, 0, 1).unwrap();
        insert_base_dir(b"/a", 0o755, 0, 0, 2).unwrap();
        assert_eq!(insert_base_dir(b"/a", 0o755, 0, 0, 9).unwrap_err(), Errno::EEXIST);
        assert_eq!(
            insert_base_file(b"/missing/child", 1, 1, 0o644, 0, 0, 9).unwrap_err(),
            Errno::ENOENT
        );
    }

    #[test]
    fn handle_bands_disjoint_from_tmpfs() {
        // A rootfs file/dir handle must not be misread as a tmpfs handle, and
        // vice versa, now that is_tmpfs_dir_handle is bounded.
        let rootfs_file = inode_to_file_handle(0);
        let rootfs_dir = iter_to_dir_handle(0);
        assert!(is_rootfs_file_handle(rootfs_file));
        assert!(is_rootfs_dir_handle(rootfs_dir));
        assert!(!crate::tmpfs::is_tmpfs_file_handle(rootfs_file));
        assert!(!crate::tmpfs::is_tmpfs_dir_handle(rootfs_file));
        assert!(!crate::tmpfs::is_tmpfs_file_handle(rootfs_dir));
        assert!(!crate::tmpfs::is_tmpfs_dir_handle(rootfs_dir));
    }

    #[test]
    fn read_file_at_reads_base_bytes_by_path() {
        let _g = TestGuard::acquire();
        build_sample_tree();
        let (mut blob, _) = make_byte_source(alloc::vec![(42u64, b"hello world".to_vec())], alloc::vec::Vec::new());
        let mut buf = [0u8; 32];
        let n = read_file_at(b"/usr/bin/hello", 0, &mut buf, &mut blob).unwrap();
        assert_eq!(&buf[..n], b"hello world");
        // Positioned read.
        let n = read_file_at(b"/usr/bin/hello", 6, &mut buf, &mut blob).unwrap();
        assert_eq!(&buf[..n], b"world");
    }

    #[test]
    fn write_file_at_truncate_replaces_bytes_and_mode() {
        let _g = TestGuard::acquire();
        build_sample_tree();
        let (mut blob, _) = make_byte_source(alloc::vec![(42u64, b"hello world".to_vec())], alloc::vec::Vec::new());
        let n = write_file_at(b"/usr/bin/hello", 0, b"NEW", 0o600, true, &mut blob).unwrap();
        assert_eq!(n, 3);
        let mut buf = [0u8; 32];
        // A reader that panics proves the replaced file is served from the
        // overlay, never re-fetched from the base blob.
        let mut panic_blob = |_req: ByteReq, _buf: &mut [u8]| -> Result<usize, Errno> {
            panic!("replaced file must be served from the overlay");
        };
        let n = read_file_at(b"/usr/bin/hello", 0, &mut buf, &mut panic_blob).unwrap();
        assert_eq!(&buf[..n], b"NEW");
        assert_eq!(lstat(b"/usr/bin/hello").unwrap().st_mode & 0o7777, 0o600);
    }

    #[test]
    fn write_file_at_partial_over_base_keeps_untouched_tail() {
        let _g = TestGuard::acquire();
        build_sample_tree();
        let (mut blob, _) = make_byte_source(alloc::vec![(42u64, b"hello world".to_vec())], alloc::vec::Vec::new());
        // Non-truncating positioned write copies the base file into the overlay
        // and overwrites only the tail, keeping the leading bytes intact.
        let n = write_file_at(b"/usr/bin/hello", 6, b"WORLD", 0o644, false, &mut blob).unwrap();
        assert_eq!(n, 5);
        let mut buf = [0u8; 32];
        let n = read_file_at(b"/usr/bin/hello", 0, &mut buf, &mut blob).unwrap();
        assert_eq!(&buf[..n], b"hello WORLD");
    }

    #[test]
    fn write_file_at_creates_absent_file() {
        let _g = TestGuard::acquire();
        build_sample_tree();
        let (mut blob, _) = make_byte_source(alloc::vec![], alloc::vec::Vec::new());
        let n = write_file_at(b"/usr/bin/fresh", 0, b"data", 0o644, true, &mut blob).unwrap();
        assert_eq!(n, 4);
        let mut buf = [0u8; 32];
        let n = read_file_at(b"/usr/bin/fresh", 0, &mut buf, &mut blob).unwrap();
        assert_eq!(&buf[..n], b"data");
        assert_eq!(lstat(b"/usr/bin/fresh").unwrap().st_mode & 0o7777, 0o644);
    }

    /// Minimal RXPT record: (kind, mode, uid, gid, mtime_sec, size, path, target).
    #[allow(clippy::type_complexity)]
    fn parse_export(buf: &[u8]) -> Vec<(u8, u32, u32, u32, u64, u64, Vec<u8>, Vec<u8>)> {
        let mut pos = 0usize;
        let rd_u32 = |b: &[u8], p: &mut usize| {
            let v = u32::from_le_bytes(b[*p..*p + 4].try_into().unwrap());
            *p += 4;
            v
        };
        let rd_u64 = |b: &[u8], p: &mut usize| {
            let v = u64::from_le_bytes(b[*p..*p + 8].try_into().unwrap());
            *p += 8;
            v
        };
        assert_eq!(rd_u32(buf, &mut pos), EXPORT_MAGIC);
        assert_eq!(rd_u32(buf, &mut pos), EXPORT_VERSION);
        let count = rd_u32(buf, &mut pos);
        let mut out = Vec::new();
        for _ in 0..count {
            let kind = buf[pos];
            pos += 1;
            let mode = rd_u32(buf, &mut pos);
            let uid = rd_u32(buf, &mut pos);
            let gid = rd_u32(buf, &mut pos);
            let mtime_sec = rd_u64(buf, &mut pos);
            let _mtime_nsec = rd_u32(buf, &mut pos);
            let size = rd_u64(buf, &mut pos);
            let path_len = rd_u32(buf, &mut pos) as usize;
            let path = buf[pos..pos + path_len].to_vec();
            pos += path_len;
            let target_len = rd_u32(buf, &mut pos) as usize;
            let target = buf[pos..pos + target_len].to_vec();
            pos += target_len;
            out.push((kind, mode, uid, gid, mtime_sec, size, path, target));
        }
        assert_eq!(pos, buf.len(), "export buffer had trailing bytes");
        out
    }

    #[test]
    fn export_tree_serializes_overlay_tree_preorder() {
        let _g = TestGuard::acquire();
        build_sample_tree();
        // Copy-on-write `/usr/bin/hello` so it reports as a COW file, not base.
        let (mut blob, _) =
            make_byte_source(alloc::vec![(42u64, b"hello world".to_vec())], alloc::vec::Vec::new());
        write_file_at(b"/usr/bin/hello", 0, b"NEW", 0o600, true, &mut blob).unwrap();

        let buf = export_tree();
        let records = parse_export(&buf);
        let paths: Vec<&[u8]> = records.iter().map(|r| r.6.as_slice()).collect();
        assert_eq!(
            paths,
            alloc::vec![
                &b"/"[..],
                &b"/etc-issue-blob-empty"[..],
                &b"/usr"[..],
                &b"/usr/bin"[..],
                &b"/usr/bin/hello"[..],
                &b"/usr/bin/hi"[..],
            ]
        );
        // Kinds: root+usr+bin dirs, one base file, the COW file, the symlink.
        assert_eq!(records[0].0, EXPORT_KIND_DIR); // /
        assert_eq!(records[1].0, EXPORT_KIND_BASE_REGULAR); // /etc-issue-blob-empty
        assert_eq!(records[2].0, EXPORT_KIND_DIR); // /usr
        assert_eq!(records[3].0, EXPORT_KIND_DIR); // /usr/bin
        assert_eq!(records[4].0, EXPORT_KIND_COW_REGULAR); // /usr/bin/hello (COW)
        assert_eq!(records[5].0, EXPORT_KIND_SYMLINK); // /usr/bin/hi
        // COW file carries the overlay-authoritative mode (0o600) and size (3).
        assert_eq!(records[4].1, 0o600);
        assert_eq!(records[4].5, 3);
        // Symlink carries its target bytes.
        assert_eq!(records[5].7, b"hello");
        // mtime preserved (TestGuard pins now to 1000s).
        assert_eq!(records[0].4, 1000);
    }

    #[test]
    fn export_tree_read_chunks_match_whole_buffer() {
        let _g = TestGuard::acquire();
        build_sample_tree();
        let whole = export_tree();
        // Read the same bytes back in tiny chunks through the cached reader.
        let mut reassembled = Vec::new();
        let mut offset = 0i64;
        loop {
            let mut chunk = [0u8; 7];
            let n = export_tree_read(offset, &mut chunk).unwrap();
            if n == 0 {
                break;
            }
            reassembled.extend_from_slice(&chunk[..n]);
            offset += n as i64;
        }
        assert_eq!(reassembled, whole);
    }

    #[test]
    fn read_file_at_follows_final_symlink() {
        // /bin/dash is a real base file; /bin/sh -> dash (relative). A
        // host-facing read of the symlink must serve dash's bytes, not ELOOP.
        // This is the popen("/bin/sh") exec-materialize path (gap G7).
        let _g = TestGuard::acquire();
        insert_base_dir(b"/", 0o755, 0, 0, 1).unwrap();
        insert_base_dir(b"/bin", 0o755, 0, 0, 2).unwrap();
        insert_base_file(b"/bin/dash", 50, 5, 0o755, 0, 0, 3).unwrap();
        insert_base_symlink(b"/bin/sh", b"dash", 0o777, 0, 0, 4).unwrap();
        let (mut blob, _) = make_byte_source(alloc::vec![(50u64, b"DASH!".to_vec())], alloc::vec::Vec::new());
        let mut buf = [0u8; 32];
        let n = read_file_at(b"/bin/sh", 0, &mut buf, &mut blob).unwrap();
        assert_eq!(&buf[..n], b"DASH!");
    }

    #[test]
    fn read_file_at_follows_symlink_chain_and_absolute_target() {
        // /a -> /b (absolute) -> c (relative to /) -> file. Every hop must be
        // followed to the terminal regular file.
        let _g = TestGuard::acquire();
        insert_base_dir(b"/", 0o755, 0, 0, 1).unwrap();
        insert_base_file(b"/c", 60, 3, 0o644, 0, 0, 2).unwrap();
        insert_base_symlink(b"/b", b"c", 0o777, 0, 0, 3).unwrap();
        insert_base_symlink(b"/a", b"/b", 0o777, 0, 0, 4).unwrap();
        let (mut blob, _) = make_byte_source(alloc::vec![(60u64, b"XYZ".to_vec())], alloc::vec::Vec::new());
        let mut buf = [0u8; 32];
        let n = read_file_at(b"/a", 0, &mut buf, &mut blob).unwrap();
        assert_eq!(&buf[..n], b"XYZ");
    }

    #[test]
    fn read_file_at_self_loop_symlink_is_eloop() {
        // /loop -> loop resolves forever; the bounded resolver returns ELOOP
        // rather than spinning.
        let _g = TestGuard::acquire();
        insert_base_dir(b"/", 0o755, 0, 0, 1).unwrap();
        insert_base_symlink(b"/loop", b"loop", 0o777, 0, 0, 2).unwrap();
        let (mut blob, _) = make_byte_source(alloc::vec::Vec::new(), alloc::vec::Vec::new());
        let mut buf = [0u8; 32];
        assert_eq!(
            read_file_at(b"/loop", 0, &mut buf, &mut blob).unwrap_err(),
            Errno::ELOOP
        );
    }

    // -- LazyMember materialization (Increment 3b-wiring.2) ------------------

    #[test]
    fn lazy_member_read_fetches_decodes_and_serves_bytes() {
        let _g = TestGuard::acquire();
        build_lazy_tree();
        let (mut fetch, calls) =
            make_byte_source(alloc::vec::Vec::new(), alloc::vec![(7u32, TINY_ZIP.to_vec())]);
        let h = open(b"/lazy/f", O_RDONLY, 0, 0, 0).unwrap();
        let mut buf = [0u8; 4096];
        let n = read(h, 0, &mut buf, &mut fetch).unwrap();
        assert_eq!(n, 4096);
        assert!(buf.iter().all(|&b| b == b'a'));
        assert_eq!(calls.get(), 1);
        release_handle(h);
    }

    #[test]
    fn lazy_member_second_read_served_from_cache() {
        let _g = TestGuard::acquire();
        build_lazy_tree();
        let (mut fetch, calls) =
            make_byte_source(alloc::vec::Vec::new(), alloc::vec![(7u32, TINY_ZIP.to_vec())]);
        let h = open(b"/lazy/f", O_RDONLY, 0, 0, 0).unwrap();
        let mut buf = [0u8; 4096];
        read(h, 0, &mut buf, &mut fetch).unwrap();
        let first_calls = calls.get();
        assert_eq!(first_calls, 1);

        let mut buf2 = [0u8; 4096];
        let n = read(h, 0, &mut buf2, &mut fetch).unwrap();
        assert_eq!(n, 4096);
        assert!(buf2.iter().all(|&b| b == b'a'));
        // Served from the archive's `members` cache: no second fetch.
        assert_eq!(calls.get(), first_calls);
        release_handle(h);
    }

    /// Two DIFFERENT members of the SAME archive: the whole-archive fetch is
    /// amortized across both, not repeated per member.
    #[test]
    fn lazy_member_second_different_member_reuses_archive_fetch() {
        let _g = TestGuard::acquire();
        insert_base_dir(b"/", 0o755, 0, 0, 1).unwrap();
        insert_base_dir(b"/lazy", 0o755, 0, 0, 2).unwrap();
        insert_lazy_file(b"/lazy/big", 7, b"bin/big.txt", 4096, 0o644, 0, 0, 3).unwrap();
        insert_lazy_file(b"/lazy/small", 7, b"etc/small.txt", 6, 0o644, 0, 0, 4).unwrap();
        insert_archive_entry(7, TINY_ZIP.len() as u64);
        let (mut fetch, calls) =
            make_byte_source(alloc::vec::Vec::new(), alloc::vec![(7u32, TINY_ZIP.to_vec())]);

        let h1 = open(b"/lazy/big", O_RDONLY, 0, 0, 0).unwrap();
        let mut buf1 = [0u8; 4096];
        let n1 = read(h1, 0, &mut buf1, &mut fetch).unwrap();
        assert_eq!(n1, 4096);
        assert!(buf1.iter().all(|&b| b == b'a'));
        assert_eq!(calls.get(), 1);
        release_handle(h1);

        let h2 = open(b"/lazy/small", O_RDONLY, 0, 0, 0).unwrap();
        let mut buf2 = [0u8; 6];
        let n2 = read(h2, 0, &mut buf2, &mut fetch).unwrap();
        assert_eq!(n2, 6);
        assert_eq!(&buf2, b"hello\n");
        // A different member of the SAME archive reuses the cached
        // whole-archive fetch: the total stays 1, not 2.
        assert_eq!(calls.get(), 1);
        release_handle(h2);
    }

    #[test]
    fn lazy_member_fetch_eagain_is_idempotent_restart() {
        let _g = TestGuard::acquire();
        build_lazy_tree();
        let h = open(b"/lazy/f", O_RDONLY, 0, 0, 0).unwrap();
        let mut buf = [0u8; 4096];
        let mut failing =
            |_req: ByteReq, _buf: &mut [u8]| -> Result<usize, Errno> { Err(Errno::EAGAIN) };
        assert_eq!(
            read(h, 0, &mut buf, &mut failing).unwrap_err(),
            Errno::EAGAIN
        );

        // Nothing partial was cached by the failed attempt: a working fetcher
        // on the very next call re-fetches the whole archive from scratch and
        // succeeds.
        let (mut fetch, calls) =
            make_byte_source(alloc::vec::Vec::new(), alloc::vec![(7u32, TINY_ZIP.to_vec())]);
        let n = read(h, 0, &mut buf, &mut fetch).unwrap();
        assert_eq!(n, 4096);
        assert!(buf.iter().all(|&b| b == b'a'));
        assert_eq!(calls.get(), 1);
        release_handle(h);
    }

    #[test]
    fn lazy_member_missing_source_path_is_enoent() {
        let _g = TestGuard::acquire();
        insert_base_dir(b"/", 0o755, 0, 0, 1).unwrap();
        insert_lazy_file(b"/g", 7, b"bin/nope", 10, 0o644, 0, 0, 2).unwrap();
        insert_archive_entry(7, TINY_ZIP.len() as u64);
        let (mut fetch, _calls) =
            make_byte_source(alloc::vec::Vec::new(), alloc::vec![(7u32, TINY_ZIP.to_vec())]);
        let h = open(b"/g", O_RDONLY, 0, 0, 0).unwrap();
        let mut buf = [0u8; 16];
        assert_eq!(
            read(h, 0, &mut buf, &mut fetch).unwrap_err(),
            Errno::ENOENT
        );
        release_handle(h);
    }

    #[test]
    fn lazy_member_missing_archive_registration_is_enoent() {
        let _g = TestGuard::acquire();
        insert_base_dir(b"/", 0o755, 0, 0, 1).unwrap();
        insert_lazy_file(b"/g", 42, b"bin/big.txt", 4096, 0o644, 0, 0, 2).unwrap();
        // No insert_archive_entry(42, ..): archive_id 42 is not registered.
        let (mut fetch, _calls) =
            make_byte_source(alloc::vec::Vec::new(), alloc::vec![(7u32, TINY_ZIP.to_vec())]);
        let h = open(b"/g", O_RDONLY, 0, 0, 0).unwrap();
        let mut buf = [0u8; 16];
        assert_eq!(
            read(h, 0, &mut buf, &mut fetch).unwrap_err(),
            Errno::ENOENT
        );
        release_handle(h);
    }

    #[test]
    fn lazy_member_write_materializes_then_overwrites() {
        let _g = TestGuard::acquire();
        build_lazy_tree();
        let (mut fetch, calls) =
            make_byte_source(alloc::vec::Vec::new(), alloc::vec![(7u32, TINY_ZIP.to_vec())]);
        // O_RDWR == 2.
        let h = open(b"/lazy/f", 2, 0, 0, 0).unwrap();
        assert_eq!(write(h, 0, b"XYZ", &mut fetch).unwrap(), 3);
        assert_eq!(calls.get(), 1);

        // A fetcher that panics proves the post-materialization node is a
        // Regular overlay file, never re-touching the archive.
        let mut panic_fetch = |_req: ByteReq, _buf: &mut [u8]| -> Result<usize, Errno> {
            panic!("post-materialization read must be served from the overlay");
        };
        let mut buf = [0u8; 4096];
        let n = read(h, 0, &mut buf, &mut panic_fetch).unwrap();
        assert_eq!(n, 4096);
        assert_eq!(&buf[..3], b"XYZ");
        assert!(buf[3..].iter().all(|&b| b == b'a'));
        assert_eq!(lstat(b"/lazy/f").unwrap().st_size, 4096);
        release_handle(h);
    }

    #[test]
    fn lazy_member_truncate_to_zero_converts_to_empty_regular() {
        let _g = TestGuard::acquire();
        build_lazy_tree();
        let (mut fetch, calls) =
            make_byte_source(alloc::vec::Vec::new(), alloc::vec![(7u32, TINY_ZIP.to_vec())]);
        // O_RDWR == 2.
        let h = open(b"/lazy/f", 2, 0, 0, 0).unwrap();
        truncate_handle(h, 0, &mut fetch).unwrap();
        // Truncating to 0 needs no archive bytes.
        assert_eq!(calls.get(), 0);
        assert_eq!(size(h).unwrap(), 0);
        assert_eq!(lstat(b"/lazy/f").unwrap().st_size, 0);
        release_handle(h);
    }
}
