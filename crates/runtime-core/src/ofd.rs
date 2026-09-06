extern crate alloc;

use alloc::boxed::Box;
use alloc::collections::{BTreeMap, VecDeque};
use alloc::rc::Rc;
use alloc::vec::Vec;
use core::cell::{Cell, UnsafeCell};
use core::sync::atomic::{AtomicU64, Ordering};
use wasm_posix_shared::Errno;
use wasm_posix_shared::flags::{O_ACCMODE, O_APPEND, O_NONBLOCK, O_PATH};

use crate::fd::FdTable;
use crate::lock::{FileId, OfdId};

// OFD table slots are process-local and reusable, so they cannot identify an
// open file description across fork or over its lifetime. Keep a separate
// machine-wide, monotonically increasing identity. Zero is reserved as an
// invalid/uninitialized value in serialized process state.
static LAST_OFD_ID: AtomicU64 = AtomicU64::new(0);

/// References held by descriptors queued in SCM_RIGHTS ancillary data.
///
/// Advisory-lock records remain solely in `ProcessTable`; this table is only
/// descriptor-lifetime state.  A high-water `Vec` avoids allocator churn in
/// the Wasm kernel while the sorted OfdId key keeps lookups bounded by the
/// number of simultaneously in-flight descriptions.
struct InFlightOfdRefs(UnsafeCell<Option<Vec<(OfdId, u32)>>>);
unsafe impl Sync for InFlightOfdRefs {}

static IN_FLIGHT_OFD_REFS: InFlightOfdRefs = InFlightOfdRefs(UnsafeCell::new(None));

fn in_flight_ofd_refs() -> &'static mut Vec<(OfdId, u32)> {
    let slot = unsafe { &mut *IN_FLIGHT_OFD_REFS.0.get() };
    slot.get_or_insert_with(Vec::new)
}

fn allocate_ofd_id() -> OfdId {
    let previous = LAST_OFD_ID
        .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |last| {
            last.checked_add(1)
        })
        .expect("OFD identity space exhausted");
    OfdId(previous + 1)
}

fn observe_ofd_id(id: OfdId) {
    assert_ne!(id.0, 0, "OFD identity zero is reserved");
    LAST_OFD_ID.fetch_max(id.0, Ordering::Relaxed);
}

/// Add one SCM_RIGHTS queue reference for an existing open description.
pub fn retain_in_flight_ofd(id: OfdId) -> Result<(), Errno> {
    if id.0 == 0 {
        return Err(Errno::EINVAL);
    }
    let refs = in_flight_ofd_refs();
    match refs.binary_search_by_key(&id, |(candidate, _)| *candidate) {
        Ok(index) => {
            refs[index].1 = refs[index].1.checked_add(1).ok_or(Errno::EOVERFLOW)?;
        }
        Err(index) => {
            refs.try_reserve(1).map_err(|_| Errno::ENOMEM)?;
            refs.insert(index, (id, 1));
        }
    }
    Ok(())
}

/// Drop one SCM_RIGHTS queue reference. Returns true when no queued reference
/// for this identity remains.
pub fn release_in_flight_ofd(id: OfdId) -> bool {
    let refs = in_flight_ofd_refs();
    let Ok(index) = refs.binary_search_by_key(&id, |(candidate, _)| *candidate) else {
        debug_assert!(false, "released an OfdId without an in-flight reference");
        return false;
    };
    if refs[index].1 > 1 {
        refs[index].1 -= 1;
        false
    } else {
        refs.remove(index);
        true
    }
}

pub fn has_in_flight_ofd(id: OfdId) -> bool {
    in_flight_ofd_refs()
        .binary_search_by_key(&id, |(candidate, _)| *candidate)
        .is_ok()
}

// ── Global host handle refcount table ──
//
// Tracks how many processes share each host file handle (host_handle >= 0).
// Handles NOT in this table have an implicit refcount of 1 (single owner).
//
// - fork_process: increments for each inherited host_handle >= 0
// - sys_close: decrements; only calls host_close when the count reaches 0
//
// This prevents fork children from invalidating host file handles that the
// parent (or other children) still use.

struct HostHandleRefs(UnsafeCell<Option<BTreeMap<i64, u32>>>);
unsafe impl Sync for HostHandleRefs {}

static HOST_HANDLE_REFS: HostHandleRefs = HostHandleRefs(UnsafeCell::new(None));

fn get_host_handle_refs() -> &'static mut BTreeMap<i64, u32> {
    let opt = unsafe { &mut *HOST_HANDLE_REFS.0.get() };
    opt.get_or_insert_with(BTreeMap::new)
}

/// Register that a host handle is now shared by one more process (fork).
/// If the handle is being forked for the first time, sets count to 2
/// (parent + child). Otherwise increments by 1.
pub fn host_handle_fork_ref(h: i64) {
    let refs = get_host_handle_refs();
    let count = refs.entry(h).or_insert(1); // 1 = the parent already has it
    *count += 1; // +1 for the child
}

/// Decrement the cross-process refcount for a host handle.
/// Returns `true` if the handle should be closed (refcount reached 0 or
/// the handle was never shared).
pub fn host_handle_close_ref(h: i64) -> bool {
    let refs = get_host_handle_refs();
    if let Some(count) = refs.get_mut(&h) {
        *count -= 1;
        if *count == 0 {
            refs.remove(&h);
            return true;
        }
        return false;
    }
    // Not in the table → single owner, safe to close
    true
}

#[cfg(test)]
pub fn host_handle_ref_count(h: i64) -> u32 {
    get_host_handle_refs().get(&h).copied().unwrap_or(0)
}

/// Move the cross-process refcount entry from a remapped handle to its
/// replacement. A handle absent from the table has one implicit owner, so
/// absence needs no migration.
pub fn host_handle_migrate_refs(old: i64, new: i64) {
    let refs = get_host_handle_refs();
    if let Some(count) = refs.remove(&old) {
        debug_assert!(
            !refs.contains_key(&new),
            "remap target handle already has a shared refcount entry",
        );
        refs.insert(new, count);
    }
}

/// The set of flags that F_SETFL is allowed to modify (POSIX semantics).
const SETFL_MODIFIABLE: u32 = O_APPEND | O_NONBLOCK;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FileType {
    Regular,
    Directory,
    Pipe,
    CharDevice,
    Socket,
    EventFd,
    Epoll,
    TimerFd,
    SignalFd,
    MemFd,
    PtyMaster,
    PtySlave,
    /// Playback-only PCM stream backing used by the OSS `/dev/dsp` frontend.
    PcmPlayback,
}

/// Live cmdbuf mapping for a process's GLES2 fd.
///
/// Populated by the GLIO_INIT path and the cmdbuf mmap path. The
/// `submit_seq` counter is bumped by every successful `GLIO_SUBMIT`
/// and is used for host-side debug-ring correlation.
#[derive(Clone, Copy, Debug)]
pub struct CmdbufBinding {
    /// Offset within the process's wasm `Memory`.
    pub addr: usize,
    /// Length in bytes.
    pub len: usize,
    /// Monotonic `GLIO_SUBMIT` counter — used for host-side debug ring
    /// correlation; never read by user space.
    pub submit_seq: u64,
}

/// Per-fd GL state for `/dev/dri/renderD128` handles, hung off
/// [`DriFdState`] below. Each fresh `open()` of renderD128 yields a
/// new `GlState`; `dup` / fork-inherit shares one.
#[derive(Clone, Debug, Default)]
pub struct GlState {
    pub initialized: bool,
    pub context_id: Option<u32>,
    pub surface_id: Option<u32>,
    pub current: bool,
    pub cmdbuf: Option<CmdbufBinding>,
}

/// State for a prime-fd OFD: capability cookie binding fd → bo.
///
/// Set when a `DRM_IOCTL_PRIME_HANDLE_TO_FD` allocates a new
/// `/dev/dri/renderD128`-derived fd. Subsequent
/// `PRIME_FD_TO_HANDLE` on this OFD verifies the cookie matches
/// the bo's recorded `prime_cookie` and bumps the bo's refcount.
#[derive(Clone, Debug)]
pub struct PrimeBoState {
    pub bo_id: crate::dri::BoId,
    pub cookie: crate::dri::PrimeCookie,
}

/// Per-fd state for `/dev/dri/renderD128` opens.
///
/// Multiple fds pointing at the same OFD (`dup`, fork-inherit) share
/// the same `DriFdState`; a fresh `open()` yields a new OFD with
/// `DriFdState::default()`. This matches Linux per-fd handle
/// namespacing.
#[derive(Clone, Debug)]
pub struct DriFdState {
    /// GEM-handle → global `BoId` map for this fd.
    pub handles: BTreeMap<u32, crate::dri::BoId>,
    /// Next handle id to issue on this fd. Linux numbers from 1.
    pub next_handle: u32,
    /// GL session state for this fd's renderD128 handle. `None`
    /// until `GLIO_INIT` succeeds; `Some` until `GLIO_TERMINATE` /
    /// last close / exec.
    pub gl: Option<GlState>,
}

impl Default for DriFdState {
    fn default() -> Self {
        DriFdState {
            handles: BTreeMap::new(),
            next_handle: 1,
            gl: None,
        }
    }
}

/// A KMS framebuffer object — i.e. one slot in the per-fd `fbs` map,
/// keyed by the `fb_id` MODE_ADDFB2 returned.
#[derive(Clone, Copy, Debug)]
pub struct KmsFb {
    pub bo_id: crate::dri::BoId,
    pub width: u32,
    pub height: u32,
    pub pixel_format: u32,
    pub stride: u32,
}

/// A page-flip queued by `DRM_IOCTL_MODE_PAGE_FLIP` and not yet
/// drained as a `DRM_EVENT_FLIP_COMPLETE` to the caller.
#[derive(Clone, Copy, Debug)]
pub struct PendingFlip {
    pub crtc_id: u32,
    pub fb_id: u32,
    pub user_data: u64,
}

/// Per-fd KMS state for `/dev/dri/card0` opens.
#[derive(Clone, Debug, Default)]
pub struct KmsFdState {
    pub holds_master: bool,
    pub fbs: BTreeMap<u32, KmsFb>,
    pub next_fb_id: u32,
    pub pending_flips: Vec<PendingFlip>,
    pub event_ring: VecDeque<u8>,
}

/// DRI sidecar on [`OpenFileDesc::dri_state`]. A card0 OFD needs both
/// a GEM-handle namespace (for `MODE_ADDFB2` lookups against
/// `PRIME_FD_TO_HANDLE`-imported bos) and a KMS scope, so the three
/// DRI fd kinds share a single sum type.
#[derive(Clone, Debug)]
pub enum DriOfdState {
    /// fd allocated by `DRM_IOCTL_PRIME_HANDLE_TO_FD`.
    PrimeBo(PrimeBoState),
    /// fd from `open("/dev/dri/renderD128")`.
    RenderNode(DriFdState),
    /// fd from `open("/dev/dri/card0")`.
    Card { dri: DriFdState, kms: KmsFdState },
}

#[derive(Clone)]
pub struct OpenFileDesc {
    /// Machine-wide identity of this open file description. Independent
    /// opens receive distinct IDs; dup, fork, and exec preserve an ID.
    pub ofd_id: OfdId,
    /// Stable file-object identity used by advisory locks. Host-backed files
    /// populate this from `host_fstat` on the live handle; kernel objects use
    /// their tagged object identity.
    pub file_id: Option<FileId>,
    pub file_type: FileType,
    /// Mutable state shared by every descriptor naming this OFD.
    ///
    /// Descriptor tables and host directory handles remain process-owned,
    /// but `dup`, `fork`, `vfork`, `posix_spawn`, and `SCM_RIGHTS` must all
    /// observe one offset, one set of file-status flags, and one async owner.
    /// The Wasm kernel serializes access on its dedicated worker, while Rc
    /// gives this state exact ownership and retirement without a global map.
    pub shared_state: SharedOfdState,
    pub host_handle: i64,
    pub ref_count: u32,
    pub path: Vec<u8>, // resolved absolute path
    /// Host directory handle for getdents64 iteration (lazily opened).
    /// -1 means not yet opened, -2 means exhausted (EOF).
    pub dir_host_handle: i64,
    /// Synthetic "." / ".." state for getdents64: 0 = emit ".", 1 = emit "..", 2 = host entries
    pub dir_synth_state: u8,
    /// Cumulative entry count across getdents64 calls — used as d_off cookie for seekdir.
    pub dir_entry_offset: i64,
    /// Shared-position generation represented by this process-local iterator.
    pub dir_position_generation: u64,
    /// Host entry already consumed by `host_readdir` but not yet exposed to
    /// the guest because it did not fit in the caller's getdents64 buffer.
    /// The next getdents64 call must retry this exact entry before advancing
    /// the host iterator.
    pub dir_pending_entry: Option<PendingDirEntry>,
    /// DRI sidecar; see [`DriOfdState`]. Boxed so non-DRI OFDs pay
    /// only one pointer slot.
    pub dri_state: Option<Box<DriOfdState>>,
}

struct SharedOfdStateInner {
    status_flags: Cell<u32>,
    offset: Cell<i64>,
    owner_pid: Cell<u32>,
    position_generation: Cell<u64>,
}

/// Exact-ownership handle for the mutable POSIX portion of an OFD.
///
/// This is kernel-internal and does not change the guest/host ABI.
#[derive(Clone)]
pub struct SharedOfdState(Rc<SharedOfdStateInner>);

impl SharedOfdState {
    pub fn new(status_flags: u32, offset: i64, owner_pid: u32) -> Self {
        Self(Rc::new(SharedOfdStateInner {
            status_flags: Cell::new(status_flags),
            offset: Cell::new(offset),
            owner_pid: Cell::new(owner_pid),
            position_generation: Cell::new(0),
        }))
    }

    fn status_flags(&self) -> u32 {
        self.0.status_flags.get()
    }

    fn set_status_flags(&self, value: u32) {
        self.0.status_flags.set(value);
    }

    fn offset(&self) -> i64 {
        self.0.offset.get()
    }

    fn set_offset(&self, value: i64) {
        if self.0.offset.replace(value) != value {
            self.0
                .position_generation
                .set(self.0.position_generation.get().wrapping_add(1));
        }
    }

    fn owner_pid(&self) -> u32 {
        self.0.owner_pid.get()
    }

    fn set_owner_pid(&self, value: u32) {
        self.0.owner_pid.set(value);
    }

    fn position_generation(&self) -> u64 {
        self.0.position_generation.get()
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PendingDirEntry {
    pub ino: u64,
    pub d_type: u8,
    pub name: Vec<u8>,
}

impl OpenFileDesc {
    pub fn status_flags(&self) -> u32 {
        self.shared_state.status_flags()
    }

    pub fn set_status_flags_raw(&self, value: u32) {
        self.shared_state.set_status_flags(value);
    }

    pub fn offset(&self) -> i64 {
        self.shared_state.offset()
    }

    pub fn set_offset(&self, value: i64) {
        self.shared_state.set_offset(value);
    }

    pub fn owner_pid(&self) -> u32 {
        self.shared_state.owner_pid()
    }

    pub fn set_owner_pid(&self, value: u32) {
        self.shared_state.set_owner_pid(value);
    }

    pub fn shared_state(&self) -> SharedOfdState {
        self.shared_state.clone()
    }

    #[cfg(test)]
    pub fn shared_state_ref_count(&self) -> usize {
        Rc::strong_count(&self.shared_state.0)
    }

    /// Restore object identity after fork deserialization preserved only an
    /// OfdId and point-in-time scalar values.
    fn link_shared_state(&mut self, state: SharedOfdState) {
        self.shared_state = state;
        self.reset_directory_iterator_for_reopen();
    }

    /// Whether this open description denotes a terminal endpoint.
    ///
    /// Host-backed standard streams predate the dedicated PTY file types, so
    /// they remain encoded as `CharDevice` OFDs with their canonical stdio
    /// paths and non-negative host stream handles. Kernel-owned character
    /// devices use negative handles instead (`/dev/null`, framebuffer, DRM,
    /// and so on) and must not acquire terminal semantics merely because
    /// `stat(2)` reports `S_IFCHR`.
    pub fn is_terminal(&self) -> bool {
        match self.file_type {
            FileType::PtyMaster | FileType::PtySlave => true,
            FileType::CharDevice => {
                self.host_handle >= 0
                    && matches!(
                        self.path.as_slice(),
                        b"/dev/stdin" | b"/dev/stdout" | b"/dev/stderr"
                    )
            }
            _ => false,
        }
    }

    /// Drop process-local directory-iterator state while preserving the
    /// guest-visible position at which a newly inherited or transferred
    /// descriptor must resume.
    ///
    /// Host directory handles cannot be shared between independently copied
    /// per-process OFD tables: each copy also carries mutable pending-record
    /// and cookie metadata, and either process may close the handle.  Fork,
    /// non-forking spawn, retained legacy exec, and SCM_RIGHTS therefore call
    /// this at the process boundary.  `sys_getdents64` lazily reconstructs a
    /// host iterator from `dir_entry_offset`; kernel-generated directories
    /// retain their stable sentinel instead.
    pub fn reset_directory_iterator_for_reopen(&mut self) {
        if self.file_type != FileType::Directory {
            return;
        }

        debug_assert!(self.offset() >= 0, "directory cookies cannot be negative");
        let cookie = self.offset().max(0);
        self.dir_host_handle = if self.host_handle == crate::procfs::PROCFS_DIR_HANDLE
            || self.host_handle == crate::devfs::DEVFS_DIR_HANDLE
        {
            self.host_handle
        } else {
            -1
        };
        self.dir_synth_state = cookie.min(2) as u8;
        self.dir_entry_offset = cookie;
        self.dir_position_generation = self.shared_state.position_generation();
        self.dir_pending_entry = None;
    }

    pub fn directory_iterator_is_stale(&self) -> bool {
        self.file_type == FileType::Directory
            && self.dir_position_generation != self.shared_state.position_generation()
    }

    pub fn set_directory_offset(&mut self, value: i64) {
        self.set_offset(value);
        self.dir_position_generation = self.shared_state.position_generation();
    }

    /// Whether this OFD is a pathname capability rather than an I/O handle.
    /// Operations that act directly on an fd must reject path-only OFDs unless
    /// their contract explicitly accepts O_PATH/O_SEARCH descriptors.
    pub fn is_path_only(&self) -> bool {
        self.status_flags() & O_PATH != 0
    }

    /// Access the `DriFdState` for renderD128- or card0-backed OFDs.
    /// Returns `None` for prime-bo OFDs and non-DRI fds.
    pub fn dri(&self) -> Option<&DriFdState> {
        match self.dri_state.as_deref()? {
            DriOfdState::RenderNode(d) | DriOfdState::Card { dri: d, .. } => Some(d),
            DriOfdState::PrimeBo(_) => None,
        }
    }

    pub fn dri_mut(&mut self) -> Option<&mut DriFdState> {
        match self.dri_state.as_deref_mut()? {
            DriOfdState::RenderNode(d) | DriOfdState::Card { dri: d, .. } => Some(d),
            DriOfdState::PrimeBo(_) => None,
        }
    }

    pub fn prime_bo(&self) -> Option<&PrimeBoState> {
        match self.dri_state.as_deref()? {
            DriOfdState::PrimeBo(p) => Some(p),
            _ => None,
        }
    }

    /// Extract the prime-bo state and clear `dri_state` so close /
    /// crash cleanup can't double-release.
    pub fn take_prime_bo(&mut self) -> Option<PrimeBoState> {
        if !matches!(self.dri_state.as_deref(), Some(DriOfdState::PrimeBo(_))) {
            return None;
        }
        match *self.dri_state.take().unwrap() {
            DriOfdState::PrimeBo(p) => Some(p),
            _ => unreachable!(),
        }
    }

    pub fn kms(&self) -> Option<&KmsFdState> {
        match self.dri_state.as_deref()? {
            DriOfdState::Card { kms, .. } => Some(kms),
            _ => None,
        }
    }

    pub fn kms_mut(&mut self) -> Option<&mut KmsFdState> {
        match self.dri_state.as_deref_mut()? {
            DriOfdState::Card { kms, .. } => Some(kms),
            _ => None,
        }
    }
}

#[derive(Clone)]
pub struct OfdTable {
    entries: Vec<Option<OpenFileDesc>>,
}

impl OfdTable {
    pub fn new() -> Self {
        OfdTable {
            entries: Vec::new(),
        }
    }

    /// Create a new open file description. Returns the OFD index.
    /// Reuses freed slots when available.
    pub fn create(
        &mut self,
        file_type: FileType,
        status_flags: u32,
        host_handle: i64,
        path: Vec<u8>,
    ) -> usize {
        let ofd = OpenFileDesc {
            ofd_id: allocate_ofd_id(),
            file_id: None,
            file_type,
            shared_state: SharedOfdState::new(status_flags, 0, 0),
            host_handle,
            ref_count: 1,
            path,
            dir_host_handle: -1,
            dir_synth_state: 0,
            dir_entry_offset: 0,
            dir_position_generation: 0,
            dir_pending_entry: None,
            dri_state: None,
        };

        self.insert(ofd)
    }

    /// Install an open description transferred through SCM_RIGHTS. The queued
    /// descriptor already owns one machine-wide backing reference, so this
    /// preserves its identity instead of allocating a new one.
    pub fn create_transferred(
        &mut self,
        ofd_id: OfdId,
        file_id: Option<FileId>,
        file_type: FileType,
        status_flags: u32,
        host_handle: i64,
        _offset: i64,
        shared_state: SharedOfdState,
        path: Vec<u8>,
    ) -> usize {
        observe_ofd_id(ofd_id);
        debug_assert_eq!(
            shared_state.status_flags() & O_ACCMODE,
            status_flags & O_ACCMODE,
            "SCM_RIGHTS changed an OFD's immutable access mode"
        );
        let mut ofd = OpenFileDesc {
            ofd_id,
            file_id,
            file_type,
            shared_state,
            host_handle,
            ref_count: 1,
            path,
            dir_host_handle: -1,
            dir_synth_state: 0,
            dir_entry_offset: 0,
            dir_position_generation: 0,
            dir_pending_entry: None,
            dri_state: None,
        };
        ofd.reset_directory_iterator_for_reopen();
        self.insert(ofd)
    }

    fn insert(&mut self, ofd: OpenFileDesc) -> usize {
        // Search for a free (None) slot to reuse.
        for i in 0..self.entries.len() {
            if self.entries[i].is_none() {
                self.entries[i] = Some(ofd);
                return i;
            }
        }

        // No free slot; append.
        let idx = self.entries.len();
        self.entries.push(Some(ofd));
        idx
    }

    /// Get a reference to the OFD at `idx`, or `None` if the slot is empty or out of range.
    pub fn get(&self, idx: usize) -> Option<&OpenFileDesc> {
        self.entries.get(idx).and_then(|slot| slot.as_ref())
    }

    /// Get a mutable reference to the OFD at `idx`, or `None` if the slot is empty or out of range.
    pub fn get_mut(&mut self, idx: usize) -> Option<&mut OpenFileDesc> {
        self.entries.get_mut(idx).and_then(|slot| slot.as_mut())
    }

    /// Keep only references actually inherited through a descriptor table.
    ///
    /// WHY: `ref_count` also includes kernel-owned blocked-retry pins. A
    /// fork/spawn child does not inherit those capabilities, so cloning the
    /// parent's count would either retain an OFD with no child fd or leave a
    /// phantom reference after the child's last real fd closes.
    pub fn retain_fd_references(&mut self, fd_table: &FdTable) -> Result<(), Errno> {
        let mut inherited_refs = BTreeMap::<usize, u32>::new();
        for (_, entry) in fd_table.iter() {
            let index = entry.ofd_ref.0;
            if self.get(index).is_none() {
                return Err(Errno::EBADF);
            }
            let count = inherited_refs.entry(index).or_insert(0);
            *count = count.checked_add(1).ok_or(Errno::EOVERFLOW)?;
        }

        for (index, slot) in self.entries.iter_mut().enumerate() {
            let Some(ofd) = slot.as_mut() else {
                continue;
            };
            if let Some(count) = inherited_refs.remove(&index) {
                ofd.ref_count = count;
            } else {
                // This clone has not acquired a machine-wide backing
                // reference yet, so dropping an unreferenced local copy must
                // not run ordinary final-close bookkeeping.
                *slot = None;
            }
        }
        debug_assert!(inherited_refs.is_empty());
        Ok(())
    }

    /// Increment the reference count for the OFD at `idx`.
    pub fn inc_ref(&mut self, idx: usize) {
        if let Some(ofd) = self.get_mut(idx) {
            ofd.ref_count = ofd
                .ref_count
                .checked_add(1)
                .expect("open-file-description reference count exhausted");
        }
    }

    /// Fallibly retain one exact live OFD.
    ///
    /// A table index is reusable, so callers that keep authority beyond the
    /// current syscall must also prove the stable [`OfdId`]. This is the
    /// allocation-free ownership primitive used by blocked-syscall bindings.
    pub fn try_inc_ref_exact(&mut self, idx: usize, id: OfdId) -> Result<(), Errno> {
        let ofd = self.get_mut(idx).ok_or(Errno::EBADF)?;
        if ofd.ofd_id != id {
            return Err(Errno::EBADF);
        }
        ofd.ref_count = ofd.ref_count.checked_add(1).ok_or(Errno::EOVERFLOW)?;
        Ok(())
    }

    /// Decrement the reference count for the OFD at `idx`.
    /// Returns `true` if the OFD was freed (ref_count reached 0).
    pub fn dec_ref(&mut self, idx: usize) -> bool {
        let should_free = if let Some(ofd) = self.entries.get_mut(idx).and_then(|s| s.as_mut()) {
            ofd.ref_count -= 1;
            ofd.ref_count == 0
        } else {
            return false;
        };

        if should_free {
            self.entries[idx] = None;
            true
        } else {
            false
        }
    }

    /// Iterate over all open file descriptions with their indices.
    pub fn iter(&self) -> impl Iterator<Item = (usize, &OpenFileDesc)> + '_ {
        self.entries
            .iter()
            .enumerate()
            .filter_map(|(i, e)| e.as_ref().map(|ofd| (i, ofd)))
    }

    /// Mutably iterate over all open file descriptions with their
    /// indices. Used by close-on-exec, signal delivery, and DRI
    /// per-fd cleanup.
    pub fn iter_mut(&mut self) -> impl Iterator<Item = (usize, &mut OpenFileDesc)> + '_ {
        self.entries
            .iter_mut()
            .enumerate()
            .filter_map(|(i, e)| e.as_mut().map(|ofd| (i, ofd)))
    }

    /// Reconstruct an OfdTable from raw entries. Used by fork deserialization.
    pub fn from_raw(entries: Vec<Option<OpenFileDesc>>) -> Self {
        for ofd in entries.iter().flatten() {
            observe_ofd_id(ofd.ofd_id);
        }
        OfdTable { entries }
    }

    /// Update status flags with F_SETFL semantics.
    ///
    /// Per POSIX, only `O_APPEND` and `O_NONBLOCK` are modifiable via F_SETFL.
    /// The access mode (O_RDONLY/O_WRONLY/O_RDWR) and all other flags are preserved.
    pub fn set_status_flags(&mut self, idx: usize, new_flags: u32) {
        if let Some(ofd) = self.get_mut(idx) {
            // Preserve everything except the modifiable bits.
            let preserved = ofd.status_flags() & !SETFL_MODIFIABLE;
            // Take only the modifiable bits from new_flags.
            let updated = new_flags & SETFL_MODIFIABLE;
            ofd.set_status_flags_raw(preserved | updated);
        }
    }

    /// Relink fork-deserialized entries to the source process's live shared
    /// state. Fork preserves table slots; an identity mismatch is corruption.
    pub fn link_shared_states_from(&mut self, source: &OfdTable) -> Result<(), Errno> {
        for (index, ofd) in self.iter_mut() {
            let source_ofd = source.get(index).ok_or(Errno::EINVAL)?;
            if source_ofd.ofd_id != ofd.ofd_id {
                return Err(Errno::EINVAL);
            }
            ofd.link_shared_state(source_ofd.shared_state());
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use wasm_posix_shared::flags::*;

    #[test]
    fn test_create_ofd() {
        let mut table = OfdTable::new();
        let idx = table.create(FileType::Regular, O_RDWR | O_APPEND, 42, b"/test".to_vec());
        assert_eq!(idx, 0);

        let ofd = table.get(idx).expect("OFD should exist at index 0");
        assert_eq!(ofd.file_type, FileType::Regular);
        assert_eq!(ofd.status_flags(), O_RDWR | O_APPEND);
        assert_eq!(ofd.host_handle, 42);
        assert_ne!(ofd.ofd_id.0, 0);
        assert_eq!(ofd.file_id, None);
        assert_eq!(ofd.offset(), 0);
        assert_eq!(ofd.ref_count, 1);
        assert_eq!(ofd.path, b"/test");
    }

    #[test]
    fn test_ref_counting() {
        let mut table = OfdTable::new();
        let idx = table.create(FileType::Regular, O_RDONLY, 10, Vec::new());

        // Initially ref_count = 1
        assert_eq!(table.get(idx).unwrap().ref_count, 1);

        // inc_ref -> 2
        table.inc_ref(idx);
        assert_eq!(table.get(idx).unwrap().ref_count, 2);

        // dec_ref -> 1, not freed
        let freed = table.dec_ref(idx);
        assert!(!freed);
        assert_eq!(table.get(idx).unwrap().ref_count, 1);

        // dec_ref -> 0, freed
        let freed = table.dec_ref(idx);
        assert!(freed);
        assert!(
            table.get(idx).is_none(),
            "OFD should be freed when ref_count hits 0"
        );
    }

    #[test]
    fn inherited_table_counts_only_real_fd_aliases() {
        let mut table = OfdTable::new();
        let inherited = table.create(FileType::Regular, O_RDONLY, 11, Vec::new());
        let retry_only = table.create(FileType::Regular, O_RDONLY, 12, Vec::new());
        table.inc_ref(inherited);
        table.inc_ref(inherited);
        table.inc_ref(retry_only);

        let mut fds = FdTable::new();
        fds.alloc(crate::fd::OpenFileDescRef(inherited), 0)
            .unwrap();
        fds.alloc(crate::fd::OpenFileDescRef(inherited), 0)
            .unwrap();

        table.retain_fd_references(&fds).unwrap();
        assert_eq!(table.get(inherited).unwrap().ref_count, 2);
        assert!(table.get(retry_only).is_none());
    }

    #[test]
    fn inherited_table_rejects_a_dangling_fd_without_partial_rewrite() {
        let mut table = OfdTable::new();
        let retained = table.create(FileType::Regular, O_RDONLY, 13, Vec::new());
        table.inc_ref(retained);

        let mut fds = FdTable::new();
        fds.alloc(crate::fd::OpenFileDescRef(99), 0).unwrap();

        assert_eq!(table.retain_fd_references(&fds), Err(Errno::EBADF));
        assert_eq!(table.get(retained).unwrap().ref_count, 2);
    }

    #[test]
    fn test_set_status_flags_preserves_access_mode() {
        let mut table = OfdTable::new();
        let idx = table.create(FileType::Regular, O_RDWR | O_APPEND, 5, Vec::new());

        // Verify initial state: access mode is O_RDWR, O_APPEND is set
        let ofd = table.get(idx).unwrap();
        assert_eq!(ofd.status_flags() & O_ACCMODE, O_RDWR);
        assert_ne!(ofd.status_flags() & O_APPEND, 0);

        // set_status_flags with O_NONBLOCK (no O_APPEND, different access mode bits)
        // Per POSIX F_SETFL: access mode must be preserved, only O_APPEND/O_NONBLOCK modifiable
        table.set_status_flags(idx, O_NONBLOCK);

        let ofd = table.get(idx).unwrap();
        // Access mode should still be O_RDWR
        assert_eq!(ofd.status_flags() & O_ACCMODE, O_RDWR);
        // O_APPEND should be removed (caller did not include it)
        assert_eq!(ofd.status_flags() & O_APPEND, 0);
        // O_NONBLOCK should be added
        assert_ne!(ofd.status_flags() & O_NONBLOCK, 0);
    }

    #[test]
    fn test_slot_reuse() {
        let mut table = OfdTable::new();
        let idx0 = table.create(FileType::Regular, O_RDONLY, 1, Vec::new());
        assert_eq!(idx0, 0);
        let first_id = table.get(idx0).unwrap().ofd_id;

        // Free slot 0
        let freed = table.dec_ref(idx0);
        assert!(freed);

        // Create again; should reuse slot 0
        let idx_reused = table.create(FileType::Pipe, O_RDWR, 2, Vec::new());
        assert_eq!(idx_reused, 0);
        let ofd = table.get(idx_reused).unwrap();
        assert_eq!(ofd.file_type, FileType::Pipe);
        assert_eq!(ofd.host_handle, 2);
        assert_ne!(ofd.ofd_id, first_id);
    }

    #[test]
    fn test_multiple_ofds() {
        let mut table = OfdTable::new();
        let idx0 = table.create(FileType::Regular, O_RDONLY, 10, Vec::new());
        let idx1 = table.create(FileType::Pipe, O_RDWR, 20, Vec::new());
        let idx2 = table.create(FileType::Socket, O_RDWR | O_NONBLOCK, 30, Vec::new());

        assert_eq!(idx0, 0);
        assert_eq!(idx1, 1);
        assert_eq!(idx2, 2);

        assert_eq!(table.get(0).unwrap().host_handle, 10);
        assert_eq!(table.get(1).unwrap().host_handle, 20);
        assert_eq!(table.get(2).unwrap().host_handle, 30);
    }

    #[test]
    fn test_iter_returns_open_ofds() {
        let mut table = OfdTable::new();
        let idx0 = table.create(FileType::Regular, O_RDONLY, 10, Vec::new());
        let idx1 = table.create(FileType::Pipe, O_RDWR, 20, Vec::new());

        let ofds: Vec<(usize, &OpenFileDesc)> = table.iter().collect();
        assert_eq!(ofds.len(), 2);
        assert_eq!(ofds[0].0, idx0);
        assert_eq!(ofds[0].1.host_handle, 10);
        assert_eq!(ofds[1].0, idx1);
        assert_eq!(ofds[1].1.host_handle, 20);
    }

    #[test]
    fn test_iter_skips_freed_slots() {
        let mut table = OfdTable::new();
        table.create(FileType::Regular, O_RDONLY, 10, Vec::new());
        table.create(FileType::Pipe, O_RDWR, 20, Vec::new());
        table.dec_ref(0); // free slot 0

        let ofds: Vec<(usize, &OpenFileDesc)> = table.iter().collect();
        assert_eq!(ofds.len(), 1);
        assert_eq!(ofds[0].0, 1);
    }

    #[test]
    fn test_from_raw_roundtrip() {
        let mut table = OfdTable::new();
        table.create(FileType::Regular, O_RDONLY, 10, b"/a".to_vec());
        table.create(FileType::Socket, O_RDWR, 30, b"/b".to_vec());

        // Build raw entries from iteration
        let max_idx = table.iter().map(|(i, _)| i).max().unwrap_or(0);
        let mut raw: Vec<Option<OpenFileDesc>> = (0..=max_idx).map(|_| None).collect();
        for (i, ofd) in table.iter() {
            raw[i] = Some(OpenFileDesc {
                ofd_id: ofd.ofd_id,
                file_id: ofd.file_id,
                file_type: ofd.file_type,
                shared_state: ofd.shared_state(),
                host_handle: ofd.host_handle,
                ref_count: ofd.ref_count,
                path: ofd.path.clone(),
                dir_host_handle: -1,
                dir_synth_state: 0,
                dir_entry_offset: 0,
                dir_position_generation: 0,
                dir_pending_entry: None,
                dri_state: None,
            });
        }

        let rebuilt = OfdTable::from_raw(raw);
        assert_eq!(rebuilt.get(0).unwrap().host_handle, 10);
        assert_eq!(rebuilt.get(1).unwrap().host_handle, 30);
    }

    #[test]
    fn transferred_directories_preserve_cookie_without_aliasing_an_iterator() {
        let mut source = OfdTable::new();
        let source_idx = source.create(
            FileType::Directory,
            O_RDONLY,
            41,
            b"/transferred".to_vec(),
        );
        let source_ofd = source.get_mut(source_idx).unwrap();
        source_ofd.set_directory_offset(7);
        source_ofd.dir_host_handle = 99;
        source_ofd.dir_synth_state = 2;
        source_ofd.dir_entry_offset = 7;
        source_ofd.dir_pending_entry = Some(PendingDirEntry {
            ino: 123,
            d_type: 8,
            name: b"pending".to_vec(),
        });
        let source_snapshot = source_ofd.clone();

        let mut receiver = OfdTable::new();
        let received_idx = receiver.create_transferred(
            source_snapshot.ofd_id,
            source_snapshot.file_id,
            source_snapshot.file_type,
            source_snapshot.status_flags(),
            source_snapshot.host_handle,
            source_snapshot.offset(),
            source_snapshot.shared_state(),
            source_snapshot.path.clone(),
        );
        let received = receiver.get(received_idx).unwrap();
        assert_eq!(received.ofd_id, source_snapshot.ofd_id);
        assert_eq!(received.offset(), 7);
        assert_eq!(received.dir_entry_offset, 7);
        assert_eq!(received.dir_synth_state, 2);
        assert_eq!(received.dir_host_handle, -1);
        assert!(received.dir_pending_entry.is_none());

        // Reconstructing the recipient must not mutate or take ownership of
        // the sender's live iterator or staged record.
        let source = source.get(source_idx).unwrap();
        assert_eq!(source.dir_host_handle, 99);
        assert_eq!(source.dir_pending_entry.as_ref().unwrap().name, b"pending");
    }

    #[test]
    fn transferred_kernel_directories_keep_their_sentinel_and_cookie() {
        for sentinel in [
            crate::devfs::DEVFS_DIR_HANDLE,
            crate::procfs::PROCFS_DIR_HANDLE,
        ] {
            let mut source = OfdTable::new();
            let source_idx = source.create(
                FileType::Directory,
                O_RDONLY,
                sentinel,
                b"/virtual".to_vec(),
            );
            let ofd_id = source.get(source_idx).unwrap().ofd_id;
            let mut table = OfdTable::new();
            let idx = table.create_transferred(
                ofd_id,
                None,
                FileType::Directory,
                O_RDONLY,
                sentinel,
                5,
                SharedOfdState::new(O_RDONLY, 5, 0),
                b"/virtual".to_vec(),
            );
            let ofd = table.get(idx).unwrap();
            assert_eq!(ofd.dir_host_handle, sentinel);
            assert_eq!(ofd.dir_entry_offset, 5);
            assert_eq!(ofd.dir_synth_state, 2);
        }
    }

    #[test]
    fn from_raw_advances_ofd_identity_high_water() {
        let mut original = OfdTable::new();
        let idx = original.create(FileType::Regular, O_RDONLY, 10, b"/a".to_vec());
        let mut restored_ofd = original.get(idx).unwrap().clone();
        let observed = OfdId(restored_ofd.ofd_id.0.checked_add(10_000).unwrap());
        restored_ofd.ofd_id = observed;

        let restored = OfdTable::from_raw(alloc::vec![Some(restored_ofd)]);
        assert_eq!(restored.get(0).unwrap().ofd_id, observed);

        let mut later = OfdTable::new();
        let later_idx = later.create(FileType::Regular, O_RDONLY, 11, b"/b".to_vec());
        assert!(later.get(later_idx).unwrap().ofd_id > observed);
    }

    #[test]
    fn ofd_default_has_no_dri_state() {
        let mut table = OfdTable::new();
        let idx = table.create(FileType::CharDevice, O_RDONLY, -8, b"/dev/dri/renderD128".to_vec());
        let ofd = table.get(idx).unwrap();
        assert!(ofd.dri_state.is_none());
        assert!(ofd.dri().is_none());
        assert!(ofd.kms().is_none());
        assert!(ofd.prime_bo().is_none());
    }

    #[test]
    fn dri_accessors_route_by_variant() {
        let mut table = OfdTable::new();
        let render = table.create(FileType::CharDevice, O_RDWR, -8, b"/dev/dri/renderD128".to_vec());
        let card = table.create(FileType::CharDevice, O_RDWR, -9, b"/dev/dri/card0".to_vec());
        let prime = table.create(FileType::Regular, O_RDWR, -100, b"<prime>".to_vec());

        table.get_mut(render).unwrap().dri_state =
            Some(Box::new(DriOfdState::RenderNode(DriFdState::default())));
        table.get_mut(card).unwrap().dri_state = Some(Box::new(DriOfdState::Card {
            dri: DriFdState::default(),
            kms: KmsFdState::default(),
        }));
        table.get_mut(prime).unwrap().dri_state =
            Some(Box::new(DriOfdState::PrimeBo(PrimeBoState {
                bo_id: 7,
                cookie: 0xdead_beef,
            })));

        // render node: dri() yes, kms() no, prime_bo() no
        let ro = table.get(render).unwrap();
        assert!(ro.dri().is_some());
        assert_eq!(ro.dri().unwrap().next_handle, 1);
        assert!(ro.kms().is_none());
        assert!(ro.prime_bo().is_none());

        // card: dri() yes, kms() yes, prime_bo() no
        let co = table.get(card).unwrap();
        assert!(co.dri().is_some());
        assert!(co.kms().is_some());
        assert!(!co.kms().unwrap().holds_master);
        assert!(co.prime_bo().is_none());

        // prime-bo: dri() no, kms() no, prime_bo() yes
        let po = table.get(prime).unwrap();
        assert!(po.dri().is_none());
        assert!(po.kms().is_none());
        let p = po.prime_bo().unwrap();
        assert_eq!(p.bo_id, 7);
        assert_eq!(p.cookie, 0xdead_beef);
    }

    #[test]
    fn dri_mut_lets_you_register_a_handle() {
        let mut table = OfdTable::new();
        let render = table.create(FileType::CharDevice, O_RDWR, -8, b"/dev/dri/renderD128".to_vec());
        table.get_mut(render).unwrap().dri_state =
            Some(Box::new(DriOfdState::RenderNode(DriFdState::default())));

        let dri = table.get_mut(render).unwrap().dri_mut().unwrap();
        let h = dri.next_handle;
        dri.handles.insert(h, 42);
        dri.next_handle += 1;

        let dri_again = table.get(render).unwrap().dri().unwrap();
        assert_eq!(dri_again.handles.get(&1).copied(), Some(42));
        assert_eq!(dri_again.next_handle, 2);
    }

    #[test]
    fn take_prime_bo_clears_state() {
        let mut table = OfdTable::new();
        let idx = table.create(FileType::Regular, O_RDWR, -100, b"<prime>".to_vec());
        table.get_mut(idx).unwrap().dri_state =
            Some(Box::new(DriOfdState::PrimeBo(PrimeBoState {
                bo_id: 5,
                cookie: 0xcafe_1234,
            })));

        let taken = table.get_mut(idx).unwrap().take_prime_bo().unwrap();
        assert_eq!(taken.bo_id, 5);
        assert!(table.get(idx).unwrap().dri_state.is_none());

        // Idempotent: second take returns None.
        assert!(table.get_mut(idx).unwrap().take_prime_bo().is_none());
    }

    #[test]
    fn take_prime_bo_is_none_for_non_prime() {
        let mut table = OfdTable::new();
        let render = table.create(FileType::CharDevice, O_RDWR, -8, b"/dev/dri/renderD128".to_vec());
        table.get_mut(render).unwrap().dri_state =
            Some(Box::new(DriOfdState::RenderNode(DriFdState::default())));
        assert!(table.get_mut(render).unwrap().take_prime_bo().is_none());
        // dri_state must NOT have been cleared.
        assert!(table.get(render).unwrap().dri_state.is_some());
    }

    #[test]
    fn iter_mut_visits_every_live_ofd() {
        let mut table = OfdTable::new();
        table.create(FileType::Regular, O_RDONLY, 1, Vec::new());
        table.create(FileType::Regular, O_RDONLY, 2, Vec::new());
        table.create(FileType::Regular, O_RDONLY, 3, Vec::new());
        table.dec_ref(1); // free middle slot

        let mut visited = Vec::new();
        for (i, ofd) in table.iter_mut() {
            ofd.set_offset((i as i64) * 100);
            visited.push((i, ofd.host_handle));
        }
        assert_eq!(visited, vec![(0, 1), (2, 3)]);
        assert_eq!(table.get(0).unwrap().offset(), 0);
        assert_eq!(table.get(2).unwrap().offset(), 200);
    }
}
