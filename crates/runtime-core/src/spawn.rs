//! Non-forking spawn — types shared between the host-side blob parser
//! (in `host/src/kernel-worker.ts`) and the kernel's
//! `ProcessTable::spawn_child` implementation.
//!
//! See `docs/plans/2026-05-04-non-forking-posix-spawn-design.md`.

extern crate alloc;

use alloc::vec::Vec;
use spin::Mutex;
use wasm_posix_shared::{Errno, spawn_contract};

/// Kernel-owned reusable transport for SYS_SPAWN blobs larger than the normal
/// syscall-channel scratch region.
///
/// A positive token represents the one reservation whose bytes the host may
/// currently replace. Growing is allowed only while idle, and parsing consumes
/// the matching token before any process-table or host-import work begins.
struct SpawnScratchBuffer {
    bytes: Vec<u8>,
    reservation: Option<i64>,
    next_token: Option<i64>,
}

impl SpawnScratchBuffer {
    const fn new() -> Self {
        Self {
            bytes: Vec::new(),
            reservation: None,
            next_token: Some(1),
        }
    }

    fn begin(&mut self, minimum_capacity: usize) -> Result<i64, Errno> {
        self.begin_with_reserve(minimum_capacity, |bytes, additional| {
            bytes
                .try_reserve_exact(additional)
                .map_err(|_| Errno::ENOMEM)
        })
    }

    fn begin_with_reserve(
        &mut self,
        minimum_capacity: usize,
        reserve: impl FnOnce(&mut Vec<u8>, usize) -> Result<(), Errno>,
    ) -> Result<i64, Errno> {
        if minimum_capacity == 0 {
            return Err(Errno::EINVAL);
        }
        if minimum_capacity > spawn_contract::WIRE_MAX_BYTES {
            return Err(Errno::E2BIG);
        }
        if self.reservation.is_some() {
            return Err(Errno::EBUSY);
        }
        let token = self.next_token.ok_or(Errno::EOVERFLOW)?;
        if self.bytes.len() < minimum_capacity {
            let additional = minimum_capacity - self.bytes.len();
            reserve(&mut self.bytes, additional)?;
            // Expose only initialized bytes to the host. `try_reserve_exact`
            // has already proven this resize cannot allocate or fail.
            let capacity = self.bytes.capacity();
            self.bytes.resize(capacity, 0);
        }
        self.reservation = Some(token);
        self.next_token = token.checked_add(1);
        Ok(token)
    }

    fn pointer(&mut self, token: i64) -> Result<usize, Errno> {
        if token <= 0 || self.reservation != Some(token) {
            return Err(Errno::EINVAL);
        }
        Ok(self.bytes.as_mut_ptr() as usize)
    }

    fn capacity(&self, token: i64) -> Result<usize, Errno> {
        if token <= 0 || self.reservation != Some(token) {
            return Err(Errno::EINVAL);
        }
        Ok(self.bytes.len())
    }

    fn retained_capacity(&self) -> usize {
        self.bytes.len()
    }

    fn cancel(&mut self, token: i64) -> Result<(), Errno> {
        if token <= 0 || self.reservation != Some(token) {
            return Err(Errno::EINVAL);
        }
        self.reservation = None;
        Ok(())
    }

    fn parse_reserved(&mut self, token: i64, length: usize) -> Result<ParsedBlob, Errno> {
        if token <= 0 || self.reservation != Some(token) {
            return Err(Errno::EINVAL);
        }

        // WHY: a matching commit consumes the reservation even when its
        // length or wire bytes are malformed. A failed caller cannot strand
        // the reusable allocation in Busy forever, while a stale token cannot
        // cancel or consume the current operation.
        self.reservation = None;
        let bytes = self.bytes.get(..length).ok_or(Errno::E2BIG)?;
        parse_blob(bytes)
    }
}

struct GlobalSpawnScratch {
    inner: Mutex<SpawnScratchBuffer>,
}

impl GlobalSpawnScratch {
    const fn new() -> Self {
        Self {
            inner: Mutex::new(SpawnScratchBuffer::new()),
        }
    }

    fn begin(&self, minimum_capacity: usize) -> Result<i64, Errno> {
        self.inner
            .try_lock()
            .ok_or(Errno::EBUSY)?
            .begin(minimum_capacity)
    }

    fn pointer(&self, token: i64) -> Result<usize, Errno> {
        self.inner.try_lock().ok_or(Errno::EBUSY)?.pointer(token)
    }

    fn capacity(&self, token: i64) -> Result<usize, Errno> {
        self.inner.try_lock().ok_or(Errno::EBUSY)?.capacity(token)
    }

    fn retained_capacity(&self) -> Result<usize, Errno> {
        Ok(self
            .inner
            .try_lock()
            .ok_or(Errno::EBUSY)?
            .retained_capacity())
    }

    fn cancel(&self, token: i64) -> Result<(), Errno> {
        // WHY: cancellation is the fail-safe that releases host write
        // authority. This critical section performs no host import or callback,
        // so a blocking lock cannot re-enter this mutex and cannot strand a
        // matching reservation merely because another Wasm thread contended.
        self.inner.lock().cancel(token)
    }

    fn parse_reserved(&self, token: i64, length: usize) -> Result<ParsedBlob, Errno> {
        // WHY: commit must either consume the matching token or establish that
        // the token is stale. Nothing under this guard imports host code; keep
        // that no-callback property so blocking contention cannot deadlock or
        // return before the host has a definitive reservation state.
        self.inner.lock().parse_reserved(token, length)
    }
}

static SPAWN_SCRATCH: GlobalSpawnScratch = GlobalSpawnScratch::new();

/// Begin one exclusive host-write reservation for a complete spawn blob.
pub fn begin_spawn_scratch(minimum_capacity: usize) -> Result<i64, Errno> {
    SPAWN_SCRATCH.begin(minimum_capacity)
}

/// Pointer owned by exactly the reservation named by `token`.
pub fn spawn_scratch_pointer(token: i64) -> Result<usize, Errno> {
    SPAWN_SCRATCH.pointer(token)
}

/// Writable byte capacity of exactly the reservation named by `token`.
pub fn spawn_scratch_capacity(token: i64) -> Result<usize, Errno> {
    SPAWN_SCRATCH.capacity(token)
}

/// Retained byte capacity of the reusable allocation.
///
/// This diagnostic reveals no pointer and grants no authority to mutate the
/// allocation. Active reservation access remains token-gated.
pub fn spawn_scratch_retained_capacity() -> Result<usize, Errno> {
    SPAWN_SCRATCH.retained_capacity()
}

/// Cancel exactly the reservation named by `token`.
pub fn cancel_spawn_scratch(token: i64) -> Result<(), Errno> {
    SPAWN_SCRATCH.cancel(token)
}

/// Consume and parse exactly the reservation named by `token`.
///
/// The returned representation owns all argv, environment, and action bytes,
/// so the scratch mutex is released before callers enter the process table or
/// invoke any host import.
pub fn parse_reserved_spawn_blob(token: i64, length: usize) -> Result<ParsedBlob, Errno> {
    SPAWN_SCRATCH.parse_reserved(token, length)
}

/// Implemented bits from `posix_spawnattr_t::__flags`.
///
/// `posix_spawn.c` transports every musl flag bit unmodified, and the complete
/// numeric contract lives in `wasm_posix_shared::spawn_contract`. Reexport only
/// the subset the process table actually interprets so a transport constant
/// cannot be mistaken for implemented POSIX behavior.
pub mod attr_flags {
    pub use wasm_posix_shared::spawn_contract::{
        ATTR_RESETIDS as RESETIDS, ATTR_SETPGROUP as SETPGROUP, ATTR_SETSID as SETSID,
        ATTR_SETSIGDEF as SETSIGDEF, ATTR_SETSIGMASK as SETSIGMASK,
    };
}

/// Attributes carried by `posix_spawnattr_t`, parsed out of the SYS_SPAWN
/// blob by the host and handed to the kernel.
///
/// Only the attribute kinds we currently support are interpreted. The
/// transported SETSCHEDPARAM, SETSCHEDULER, and USEVFORK bits remain visible in
/// `flags`, but the process table does not implement their behavior.
#[derive(Debug, Clone, Copy)]
pub struct SpawnAttrs {
    pub flags: u32,
    /// Target process group from POSIX_SPAWN_SETPGROUP. `0` means "make a
    /// new pgrp with pgid == child pid" (POSIX semantics).
    pub pgrp: i32,
    /// 64-bit signal-default mask from POSIX_SPAWN_SETSIGDEF (signals 1..64).
    /// Each set bit means "reset this signal's disposition to SIG_DFL in the
    /// child".
    pub sigdef: u64,
    /// 64-bit blocked-signal mask from POSIX_SPAWN_SETSIGMASK (signals 1..64).
    pub sigmask: u64,
}

impl SpawnAttrs {
    pub const fn empty() -> Self {
        Self {
            flags: 0,
            pgrp: 0,
            sigdef: 0,
            sigmask: 0,
        }
    }
}

/// One entry from a `posix_spawn_file_actions_t`. Path strings (for `Open`
/// and `Chdir`) are owned `Vec<u8>` — the host-side blob parser copies them
/// out of caller memory before handing the parsed action list to the kernel.
#[derive(Debug, Clone)]
pub enum FileAction {
    /// FDOP_OPEN: open `path` with `oflag`/`mode`, then arrange for the
    /// resulting fd to land at `fd` (closing any prior occupant).
    Open {
        fd: i32,
        path: Vec<u8>,
        oflag: i32,
        mode: u32,
    },
    /// FDOP_CLOSE: `close(fd)`. Errors are ignored (POSIX behavior).
    Close { fd: i32 },
    /// FDOP_DUP2: `dup2(srcfd, fd)`. If `srcfd == fd`, clear FD_CLOEXEC on `fd`.
    Dup2 { srcfd: i32, fd: i32 },
    /// FDOP_CHDIR: `chdir(path)` in the child only.
    Chdir { path: Vec<u8> },
    /// FDOP_FCHDIR: `fchdir(fd)` in the child only.
    Fchdir { fd: i32 },
}

// ── SYS_SPAWN blob parser ─────────────────────────────────────────────────
//
// Wire format (little-endian, from
// `docs/plans/2026-05-04-non-forking-posix-spawn-design.md` Section 1):
//
//   header (`spawn_contract::WIRE_HEADER_BYTES`):
//       argc:u32  envc:u32  n_actions:u32  attr_flags:u32
//       pgrp:i32  _pad:u32  sigdef:u64     sigmask:u64
//   argv_offsets:    u32 × argc                (offsets into strings[])
//   envp_offsets:    u32 × envc
//   actions:         action_record × n_actions
//   strings:         u8[]                       (null-terminated entries)
//
// `action_record = { op:u32, fd:i32, newfd:i32, path_off:u32, path_len:u32,
//                    oflag:i32, mode:u32 }`
//
// This is the trust boundary between user code and the kernel — every read
// is range-checked and any malformed offset/length yields `Errno::EINVAL`.

/// File-action `op` codes shared with `libc/glue/posix_spawn.c`.
pub mod fdop {
    pub use wasm_posix_shared::spawn_contract::{
        WIRE_OP_CHDIR as CHDIR, WIRE_OP_CLOSE as CLOSE, WIRE_OP_DUP2 as DUP2,
        WIRE_OP_FCHDIR as FCHDIR, WIRE_OP_OPEN as OPEN,
    };
}

/// Parsed view over a SYS_SPAWN blob. argv/envp/path bytes are owned (copied
/// out of the blob) so the caller is free to drop the underlying buffer
/// before feeding this into `ProcessTable::spawn_child`.
#[derive(Debug)]
pub struct ParsedBlob {
    pub argv: Vec<Vec<u8>>,
    pub envp: Vec<Vec<u8>>,
    pub file_actions: Vec<FileAction>,
    pub attrs: SpawnAttrs,
}

/// Read a little-endian `u32` at `off`, or `Err(EINVAL)` if out of range.
fn read_u32(bytes: &[u8], off: usize) -> Result<u32, Errno> {
    let slice = bytes.get(off..off + 4).ok_or(Errno::EINVAL)?;
    Ok(u32::from_le_bytes([slice[0], slice[1], slice[2], slice[3]]))
}

fn read_i32(bytes: &[u8], off: usize) -> Result<i32, Errno> {
    Ok(read_u32(bytes, off)? as i32)
}

fn read_u64(bytes: &[u8], off: usize) -> Result<u64, Errno> {
    let slice = bytes.get(off..off + 8).ok_or(Errno::EINVAL)?;
    let mut buf = [0u8; 8];
    buf.copy_from_slice(slice);
    Ok(u64::from_le_bytes(buf))
}

/// Resolve an action-path `(off, len)` pair against the strings region.
///
/// `len` is musl's `strlen(path) + 1`, so the referenced range must contain
/// exactly one terminal NUL. WHY: accepting an absent or interior terminator
/// gives the producer and parser different path boundaries for the same wire
/// record.
fn read_action_path(strings: &[u8], off: u32, len: u32) -> Result<Vec<u8>, Errno> {
    let off = off as usize;
    let len = len as usize;
    let raw = strings
        .get(off..off.checked_add(len).ok_or(Errno::EINVAL)?)
        .ok_or(Errno::EINVAL)?;
    let (&terminator, path) = raw.split_last().ok_or(Errno::EINVAL)?;
    if terminator != 0 || path.contains(&0) {
        return Err(Errno::EINVAL);
    }
    if path.len() >= spawn_contract::POSIX_PATH_MAX_BYTES {
        return Err(Errno::ENAMETOOLONG);
    }
    Ok(path.to_vec())
}

/// Parse a SYS_SPAWN blob. Bails with `Errno::EINVAL` on any malformed
/// offset, length, or op code.
pub fn parse_blob(bytes: &[u8]) -> Result<ParsedBlob, Errno> {
    if bytes.len() > spawn_contract::WIRE_MAX_BYTES {
        return Err(Errno::E2BIG);
    }
    if bytes.len() < spawn_contract::WIRE_HEADER_BYTES {
        return Err(Errno::EINVAL);
    }
    let argc = read_u32(bytes, spawn_contract::WIRE_HEADER_ARGC_OFFSET)? as usize;
    let envc = read_u32(bytes, spawn_contract::WIRE_HEADER_ENVC_OFFSET)? as usize;
    let n_actions = read_u32(bytes, spawn_contract::WIRE_HEADER_ACTION_COUNT_OFFSET)? as usize;
    let attr_flags = read_u32(bytes, spawn_contract::WIRE_HEADER_ATTR_FLAGS_OFFSET)?;
    let pgrp = read_i32(bytes, spawn_contract::WIRE_HEADER_PGRP_OFFSET)?;
    // WIRE_HEADER_PAD_OFFSET names the reserved u32; readers intentionally
    // ignore its value until a later ABI gives that field semantics.
    let sigdef = read_u64(bytes, spawn_contract::WIRE_HEADER_SIGDEF_OFFSET)?;
    let sigmask = read_u64(bytes, spawn_contract::WIRE_HEADER_SIGMASK_OFFSET)?;

    // Cap counts to avoid pathological allocations on malformed input.
    // Real callers would never approach these limits.
    if argc > spawn_contract::MAX_ARGV_COUNT
        || envc > spawn_contract::MAX_ENVP_COUNT
        || n_actions > spawn_contract::MAX_ACTION_COUNT
    {
        return Err(Errno::EINVAL);
    }

    let mut cursor = spawn_contract::WIRE_HEADER_BYTES;

    // Argv offsets table.
    let argv_offsets_size = argc
        .checked_mul(spawn_contract::WIRE_STRING_OFFSET_BYTES)
        .ok_or(Errno::EINVAL)?;
    let argv_offsets_end = cursor.checked_add(argv_offsets_size).ok_or(Errno::EINVAL)?;
    let argv_offsets_bytes = bytes.get(cursor..argv_offsets_end).ok_or(Errno::EINVAL)?;
    let mut argv_offsets: Vec<u32> = Vec::with_capacity(argc);
    for i in 0..argc {
        argv_offsets.push(read_u32(
            argv_offsets_bytes,
            i * spawn_contract::WIRE_STRING_OFFSET_BYTES,
        )?);
    }
    cursor = argv_offsets_end;

    // Envp offsets table.
    let envp_offsets_size = envc
        .checked_mul(spawn_contract::WIRE_STRING_OFFSET_BYTES)
        .ok_or(Errno::EINVAL)?;
    let envp_offsets_end = cursor.checked_add(envp_offsets_size).ok_or(Errno::EINVAL)?;
    let envp_offsets_bytes = bytes.get(cursor..envp_offsets_end).ok_or(Errno::EINVAL)?;
    let mut envp_offsets: Vec<u32> = Vec::with_capacity(envc);
    for i in 0..envc {
        envp_offsets.push(read_u32(
            envp_offsets_bytes,
            i * spawn_contract::WIRE_STRING_OFFSET_BYTES,
        )?);
    }
    cursor = envp_offsets_end;

    // Action records.
    let actions_size = n_actions
        .checked_mul(spawn_contract::WIRE_ACTION_RECORD_BYTES)
        .ok_or(Errno::EINVAL)?;
    let actions_end = cursor.checked_add(actions_size).ok_or(Errno::EINVAL)?;
    let actions_bytes = bytes.get(cursor..actions_end).ok_or(Errno::EINVAL)?;
    cursor = actions_end;

    // Everything left is the strings region.
    let strings = bytes.get(cursor..).ok_or(Errno::EINVAL)?;

    // ARG_MAX accounts for the source pointer arrays as well as the string
    // bytes. Four-byte pointers are the smaller supported representation, so
    // this rejects a blob that could not have been valid on either wasm32 or
    // wasm64 while leaving the host's source-width check authoritative.
    let pointer_bytes = argc
        .checked_add(envc)
        .and_then(|count| count.checked_add(2))
        .and_then(|count| count.checked_mul(core::mem::size_of::<u32>()))
        .ok_or(Errno::E2BIG)?;
    if pointer_bytes > spawn_contract::POSIX_ARG_MAX_BYTES {
        return Err(Errno::E2BIG);
    }
    // First measure every referenced string against one incremental budget,
    // then allocate owned values. WHY: decoding first lets thousands of
    // duplicate offsets copy the same multi-megabyte tail tens of gigabytes
    // before ARG_MAX is checked. Since every scan contributes to this budget,
    // adversarial work and eventual allocations are both bounded by ARG_MAX.
    let mut represented_bytes = pointer_bytes;
    let argv_ranges = measure_strings_by_offset(&argv_offsets, strings, &mut represented_bytes)?;
    let envp_ranges = measure_strings_by_offset(&envp_offsets, strings, &mut represented_bytes)?;
    let argv = decode_measured_strings(&argv_ranges, strings);
    let envp = decode_measured_strings(&envp_ranges, strings);

    // Decode action records.
    let mut file_actions: Vec<FileAction> = Vec::with_capacity(n_actions);
    for i in 0..n_actions {
        let base = i * spawn_contract::WIRE_ACTION_RECORD_BYTES;
        let op = read_u32(actions_bytes, base + spawn_contract::WIRE_ACTION_OP_OFFSET)?;
        let fd = read_i32(actions_bytes, base + spawn_contract::WIRE_ACTION_FD_OFFSET)?;
        let newfd = read_i32(
            actions_bytes,
            base + spawn_contract::WIRE_ACTION_NEWFD_OFFSET,
        )?;
        let path_off = read_u32(
            actions_bytes,
            base + spawn_contract::WIRE_ACTION_PATH_OFF_OFFSET,
        )?;
        let path_len = read_u32(
            actions_bytes,
            base + spawn_contract::WIRE_ACTION_PATH_LEN_OFFSET,
        )?;
        let oflag = read_i32(
            actions_bytes,
            base + spawn_contract::WIRE_ACTION_OFLAG_OFFSET,
        )?;
        let mode = read_u32(
            actions_bytes,
            base + spawn_contract::WIRE_ACTION_MODE_OFFSET,
        )?;
        let action = match op {
            x if x == fdop::OPEN => FileAction::Open {
                fd,
                path: read_action_path(strings, path_off, path_len)?,
                oflag,
                mode,
            },
            x if x == fdop::CLOSE => FileAction::Close { fd },
            x if x == fdop::DUP2 => FileAction::Dup2 {
                srcfd: fd,
                fd: newfd,
            },
            x if x == fdop::CHDIR => FileAction::Chdir {
                path: read_action_path(strings, path_off, path_len)?,
            },
            x if x == fdop::FCHDIR => FileAction::Fchdir { fd },
            _ => return Err(Errno::EINVAL),
        };
        file_actions.push(action);
    }

    Ok(ParsedBlob {
        argv,
        envp,
        file_actions,
        attrs: SpawnAttrs {
            flags: attr_flags,
            pgrp,
            sigdef,
            sigmask,
        },
    })
}

/// Measure NUL-terminated string references without allocating their bytes.
fn measure_strings_by_offset(
    offsets: &[u32],
    strings: &[u8],
    represented_bytes: &mut usize,
) -> Result<Vec<(usize, usize)>, Errno> {
    let mut ranges = Vec::with_capacity(offsets.len());
    for &off in offsets {
        let off = off as usize;
        if off > strings.len() {
            return Err(Errno::EINVAL);
        }
        let tail = &strings[off..];
        let length = tail.iter().position(|&b| b == 0).ok_or(Errno::EINVAL)?;
        *represented_bytes = represented_bytes
            .checked_add(length)
            .and_then(|total| total.checked_add(1))
            .ok_or(Errno::E2BIG)?;
        if *represented_bytes > spawn_contract::POSIX_ARG_MAX_BYTES {
            return Err(Errno::E2BIG);
        }
        ranges.push((off, off + length));
    }
    Ok(ranges)
}

fn decode_measured_strings(ranges: &[(usize, usize)], strings: &[u8]) -> Vec<Vec<u8>> {
    ranges
        .iter()
        .map(|&(start, end)| strings[start..end].to_vec())
        .collect()
}

/// Exact byte length [`serialize_argv_envp`] needs for `parsed`.
///
/// `parse_blob`'s ARG_MAX budget keeps real callers far below `usize`, but the
/// framing size must never wrap, so an oversized aggregate maps to
/// `Errno::EOVERFLOW` instead of a truncated frame.
fn framed_argv_envp_len(parsed: &ParsedBlob) -> Result<usize, Errno> {
    let mut total = 2usize * core::mem::size_of::<u32>();
    for entry in parsed.argv.iter().chain(parsed.envp.iter()) {
        if entry.len() > u32::MAX as usize {
            return Err(Errno::EOVERFLOW);
        }
        total = total
            .checked_add(core::mem::size_of::<u32>())
            .and_then(|running| running.checked_add(entry.len()))
            .ok_or(Errno::EOVERFLOW)?;
    }
    Ok(total)
}

/// Serialize a parsed blob's argv and envp into the host-private read-back
/// framing consumed by the `kernel_spawn_blob_decode` kernel export.
///
/// Layout: `[argc: u32 LE][envc: u32 LE]`, then every argv entry followed by
/// every envp entry, each encoded as `[len: u32 LE][raw bytes]`. The raw bytes
/// are exactly the NUL-delimited argument/environment bytes `parse_blob`
/// measured; the host `TextDecode`s them, reproducing the deleted TypeScript
/// `decodeSpawnBlobStrings` byte-for-byte. Duplicate wire offsets are emitted
/// as duplicate bytes, matching that decoder.
///
/// Returns the number of bytes written, or `Errno::EOVERFLOW` when `out` cannot
/// hold the complete framing. WHY a loud boundary rather than a partial write:
/// a truncated frame would decode as a different argv/envp — a silent program
/// substitution — so a short buffer must be retryable, never partial.
pub fn serialize_argv_envp(parsed: &ParsedBlob, out: &mut [u8]) -> Result<usize, Errno> {
    let framed_len = framed_argv_envp_len(parsed)?;
    if framed_len > out.len() {
        return Err(Errno::EOVERFLOW);
    }
    let argc = parsed.argv.len() as u32;
    let envc = parsed.envp.len() as u32;
    let mut cursor = 0usize;
    out[cursor..cursor + 4].copy_from_slice(&argc.to_le_bytes());
    cursor += 4;
    out[cursor..cursor + 4].copy_from_slice(&envc.to_le_bytes());
    cursor += 4;
    for entry in parsed.argv.iter().chain(parsed.envp.iter()) {
        let len = entry.len() as u32;
        out[cursor..cursor + 4].copy_from_slice(&len.to_le_bytes());
        cursor += 4;
        out[cursor..cursor + entry.len()].copy_from_slice(entry);
        cursor += entry.len();
    }
    Ok(cursor)
}

#[cfg(test)]
mod parser_tests {
    use super::*;

    #[test]
    fn scratch_queries_reject_invalid_bounds_and_lock_contention() {
        let scratch = GlobalSpawnScratch::new();
        assert_eq!(scratch.begin(0), Err(Errno::EINVAL));
        assert_eq!(
            scratch.begin(spawn_contract::WIRE_MAX_BYTES + 1),
            Err(Errno::E2BIG)
        );

        let guard = scratch.inner.try_lock().expect("hold scratch lock");
        assert_eq!(scratch.begin(84 * 1024), Err(Errno::EBUSY));
        assert_eq!(scratch.pointer(1), Err(Errno::EBUSY));
        assert_eq!(scratch.capacity(1), Err(Errno::EBUSY));
        assert_eq!(scratch.retained_capacity(), Err(Errno::EBUSY));
        // Commit and cancellation deliberately block instead of returning
        // EBUSY. Calling either while this test owns the lock would deadlock;
        // the next two threaded tests prove their settlement under contention.
        drop(guard);
    }

    #[test]
    fn scratch_cancel_waits_for_contention_then_definitively_releases_token() {
        use std::sync::{Arc, mpsc};
        use std::time::Duration;

        let scratch = Arc::new(GlobalSpawnScratch::new());
        let token = scratch
            .begin(spawn_contract::WIRE_HEADER_BYTES)
            .expect("begin reservation");
        let guard = scratch.inner.lock();
        let (started_tx, started_rx) = mpsc::sync_channel(0);
        let (result_tx, result_rx) = mpsc::sync_channel(0);
        let cancel_scratch = Arc::clone(&scratch);
        let cancel_thread = std::thread::spawn(move || {
            started_tx.send(()).expect("announce cancellation");
            let result = cancel_scratch.cancel(token);
            result_tx.send(result).expect("report cancellation");
        });

        started_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("cancellation thread started");
        assert!(
            result_rx.recv_timeout(Duration::from_millis(50)).is_err(),
            "cancellation must not return before the contended lock settles",
        );
        drop(guard);
        assert_eq!(
            result_rx
                .recv_timeout(Duration::from_secs(1))
                .expect("cancellation settled"),
            Ok(()),
        );
        cancel_thread.join().expect("cancellation thread joined");
        assert_eq!(scratch.pointer(token), Err(Errno::EINVAL));

        let retry = scratch
            .begin(spawn_contract::WIRE_HEADER_BYTES)
            .expect("reservation reusable after cancellation");
        scratch.cancel(retry).expect("cancel retry");
    }

    #[test]
    fn scratch_commit_waits_for_contention_then_definitively_consumes_token() {
        use std::sync::{Arc, mpsc};
        use std::time::Duration;

        let scratch = Arc::new(GlobalSpawnScratch::new());
        let blob = build_basic_blob();
        let token = scratch.begin(blob.len()).expect("begin reservation");
        {
            let mut writable = scratch.inner.lock();
            writable.bytes[..blob.len()].copy_from_slice(&blob);
        }

        let guard = scratch.inner.lock();
        let (started_tx, started_rx) = mpsc::sync_channel(0);
        let (result_tx, result_rx) = mpsc::sync_channel(0);
        let commit_scratch = Arc::clone(&scratch);
        let commit_thread = std::thread::spawn(move || {
            started_tx.send(()).expect("announce commit");
            let result = commit_scratch
                .parse_reserved(token, blob.len())
                .map(|parsed| parsed.argv);
            result_tx.send(result).expect("report commit");
        });

        started_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("commit thread started");
        assert!(
            result_rx.recv_timeout(Duration::from_millis(50)).is_err(),
            "commit must not return before the contended lock settles",
        );
        drop(guard);
        assert_eq!(
            result_rx
                .recv_timeout(Duration::from_secs(1))
                .expect("commit settled"),
            Ok(alloc::vec![b"/bin/ls".to_vec()]),
        );
        commit_thread.join().expect("commit thread joined");
        assert_eq!(scratch.pointer(token), Err(Errno::EINVAL));
        assert_eq!(scratch.cancel(token), Err(Errno::EINVAL));

        let retry = scratch
            .begin(spawn_contract::WIRE_HEADER_BYTES)
            .expect("reservation reusable after commit");
        scratch.cancel(retry).expect("cancel retry");
    }

    #[test]
    fn scratch_reserve_failure_preserves_idle_state_and_token() {
        let mut scratch = SpawnScratchBuffer::new();
        let requested = 84 * 1024;

        assert_eq!(
            scratch.begin_with_reserve(requested, |bytes, additional| {
                assert!(bytes.is_empty());
                assert_eq!(bytes.capacity(), 0);
                assert_eq!(additional, requested);
                Err(Errno::ENOMEM)
            }),
            Err(Errno::ENOMEM),
        );
        assert_eq!(scratch.reservation, None);
        assert_eq!(scratch.next_token, Some(1));
        assert_eq!(scratch.retained_capacity(), 0);
        assert_eq!(scratch.bytes.capacity(), 0);

        let token = scratch
            .begin(spawn_contract::WIRE_HEADER_BYTES)
            .expect("retry after reserve failure");
        assert_eq!(token, 1);
        assert_eq!(scratch.reservation, Some(token));
        assert_eq!(scratch.next_token, Some(2));
        assert!(scratch.retained_capacity() >= spawn_contract::WIRE_HEADER_BYTES,);
        scratch.cancel(token).expect("cancel successful retry");
    }

    #[test]
    fn scratch_reservation_parses_exact_capacity_and_releases_on_capacity_plus_one() {
        let scratch = GlobalSpawnScratch::new();
        let blob = build_basic_blob();
        let token = scratch.begin(blob.len()).expect("begin exact");
        let pointer = scratch.pointer(token).expect("reservation pointer");
        let capacity = scratch.capacity(token).expect("reservation capacity");
        assert_ne!(pointer, 0);
        assert!(capacity >= blob.len());

        let mut padded = blob;
        padded.resize(capacity, 0);
        scratch.inner.try_lock().expect("write reservation").bytes[..capacity]
            .copy_from_slice(&padded);
        let parsed = scratch
            .parse_reserved(token, capacity)
            .expect("parse exact capacity");
        assert_eq!(parsed.argv, alloc::vec![b"/bin/ls".to_vec()]);
        assert_eq!(scratch.pointer(token), Err(Errno::EINVAL));
        assert_eq!(scratch.capacity(token), Err(Errno::EINVAL));
        assert_eq!(scratch.retained_capacity(), Ok(capacity));

        let overflow_token = scratch.begin(capacity).expect("begin overflow case");
        assert!(matches!(
            scratch.parse_reserved(overflow_token, capacity + 1),
            Err(Errno::E2BIG)
        ));
        assert_eq!(scratch.pointer(overflow_token), Err(Errno::EINVAL));
        assert!(scratch.begin(capacity).is_ok());
    }

    #[test]
    fn scratch_reservation_reuses_then_grows_one_owned_allocation() {
        let scratch = GlobalSpawnScratch::new();
        let first_token = scratch.begin(84 * 1024).expect("first begin");
        let first_pointer = scratch.pointer(first_token).expect("first pointer");
        let first_capacity = scratch.capacity(first_token).expect("first capacity");
        assert_ne!(first_pointer, 0);
        assert!(first_capacity >= 84 * 1024);
        scratch.cancel(first_token).expect("cancel first");

        let reused_token = scratch.begin(80 * 1024).expect("reuse begin");
        let reused_pointer = scratch.pointer(reused_token).expect("reused pointer");
        let reused_capacity = scratch.capacity(reused_token).expect("reused capacity");
        assert_eq!(reused_pointer, first_pointer);
        assert_eq!(reused_capacity, first_capacity);
        scratch.cancel(reused_token).expect("cancel reuse");

        let grown_token = scratch.begin(first_capacity + 1).expect("grow begin");
        let grown_pointer = scratch.pointer(grown_token).expect("grown pointer");
        let grown_capacity = scratch.capacity(grown_token).expect("grown capacity");
        assert_ne!(grown_pointer, 0);
        assert!(grown_capacity > first_capacity);
        scratch.cancel(grown_token).expect("cancel grown");
        assert_eq!(scratch.retained_capacity(), Ok(grown_capacity));
    }

    #[test]
    fn scratch_reservation_rejects_overlap_and_stale_tokens() {
        let scratch = GlobalSpawnScratch::new();
        let first = scratch.begin(84 * 1024).expect("first begin");
        assert_eq!(scratch.begin(84 * 1024), Err(Errno::EBUSY));
        assert_eq!(scratch.pointer(first + 1), Err(Errno::EINVAL));
        assert_eq!(scratch.capacity(first + 1), Err(Errno::EINVAL));
        assert_eq!(scratch.cancel(0), Err(Errno::EINVAL));
        scratch.cancel(first).expect("cancel first");

        let second = scratch.begin(84 * 1024).expect("second begin");
        assert!(second > first);
        assert_eq!(scratch.cancel(first), Err(Errno::EINVAL));
        assert!(matches!(
            scratch.parse_reserved(first, spawn_contract::WIRE_HEADER_BYTES),
            Err(Errno::EINVAL)
        ));
        assert_eq!(scratch.pointer(first), Err(Errno::EINVAL));
        assert_eq!(scratch.capacity(first), Err(Errno::EINVAL));
        assert_ne!(scratch.pointer(second).expect("current pointer"), 0,);
        assert_eq!(
            scratch.capacity(second).expect("current capacity"),
            scratch.retained_capacity().expect("retained capacity"),
        );
        scratch.cancel(second).expect("cancel second");
    }

    #[test]
    fn malformed_reserved_blob_releases_the_matching_reservation() {
        let scratch = GlobalSpawnScratch::new();
        let token = scratch
            .begin(spawn_contract::WIRE_HEADER_BYTES)
            .expect("begin malformed");
        assert!(matches!(
            scratch.parse_reserved(token, spawn_contract::WIRE_HEADER_BYTES - 1),
            Err(Errno::EINVAL)
        ));
        assert_eq!(scratch.pointer(token), Err(Errno::EINVAL));

        let retry = scratch
            .begin(spawn_contract::WIRE_HEADER_BYTES)
            .expect("retry after malformed parse");
        scratch.cancel(retry).expect("cancel retry");
    }

    #[test]
    fn reservation_tokens_exhaust_without_wrapping_to_a_stale_value() {
        let scratch = GlobalSpawnScratch::new();
        scratch
            .inner
            .try_lock()
            .expect("set token cursor")
            .next_token = Some(i64::MAX);

        let last = scratch
            .begin(spawn_contract::WIRE_HEADER_BYTES)
            .expect("last token");
        assert_eq!(last, i64::MAX);
        scratch.cancel(last).expect("cancel last token");
        assert_eq!(
            scratch.begin(spawn_contract::WIRE_HEADER_BYTES),
            Err(Errno::EOVERFLOW)
        );
    }

    /// Build a well-formed blob with a single argv entry, a single envp
    /// entry, one Close action, and SETPGROUP attrs. Used to anchor the
    /// happy-path round-trip test.
    fn build_basic_blob() -> Vec<u8> {
        let mut blob: Vec<u8> = Vec::new();
        // ── header ──
        blob.extend_from_slice(&1u32.to_le_bytes()); // argc
        blob.extend_from_slice(&1u32.to_le_bytes()); // envc
        blob.extend_from_slice(&1u32.to_le_bytes()); // n_actions
        blob.extend_from_slice(&attr_flags::SETPGROUP.to_le_bytes()); // attr_flags
        blob.extend_from_slice(&7i32.to_le_bytes()); // pgrp
        blob.extend_from_slice(&0u32.to_le_bytes()); // _pad
        blob.extend_from_slice(&0u64.to_le_bytes()); // sigdef
        blob.extend_from_slice(&0u64.to_le_bytes()); // sigmask
        // ── argv offsets (1) ──
        blob.extend_from_slice(&0u32.to_le_bytes()); // argv[0] @ strings[0]
        // ── envp offsets (1) ──
        blob.extend_from_slice(&8u32.to_le_bytes()); // envp[0] @ strings[8]
        // ── actions (1) ──   FDOP_CLOSE on fd 5
        blob.extend_from_slice(&fdop::CLOSE.to_le_bytes());
        blob.extend_from_slice(&5i32.to_le_bytes()); // fd
        blob.extend_from_slice(&0i32.to_le_bytes()); // newfd
        blob.extend_from_slice(&0u32.to_le_bytes()); // path_off
        blob.extend_from_slice(&0u32.to_le_bytes()); // path_len
        blob.extend_from_slice(&0i32.to_le_bytes()); // oflag
        blob.extend_from_slice(&0u32.to_le_bytes()); // mode
        // ── strings ──
        blob.extend_from_slice(b"/bin/ls\0"); // strings[0..7]
        blob.extend_from_slice(b"PATH=/usr/bin\0"); // strings[7..]
        blob
    }

    #[test]
    fn parse_blob_basic_round_trip() {
        let blob = build_basic_blob();
        let parsed = parse_blob(&blob).expect("parse");
        assert_eq!(parsed.argv, alloc::vec![b"/bin/ls".to_vec()]);
        assert_eq!(parsed.envp, alloc::vec![b"PATH=/usr/bin".to_vec()]);
        assert_eq!(parsed.file_actions.len(), 1);
        match &parsed.file_actions[0] {
            FileAction::Close { fd } => assert_eq!(*fd, 5),
            _ => panic!("expected Close action"),
        }
        assert_eq!(parsed.attrs.flags, attr_flags::SETPGROUP);
        assert_eq!(parsed.attrs.pgrp, 7);
    }

    /// Parse the host-private read-back framing back into argv/envp so tests
    /// assert on decoded strings rather than raw offsets.
    fn decode_framing(framed: &[u8]) -> (Vec<Vec<u8>>, Vec<Vec<u8>>) {
        let argc = u32::from_le_bytes(framed[0..4].try_into().unwrap()) as usize;
        let envc = u32::from_le_bytes(framed[4..8].try_into().unwrap()) as usize;
        let mut cursor = 8;
        let take = |count: usize, cursor: &mut usize| {
            let mut out = Vec::with_capacity(count);
            for _ in 0..count {
                let len =
                    u32::from_le_bytes(framed[*cursor..*cursor + 4].try_into().unwrap()) as usize;
                *cursor += 4;
                out.push(framed[*cursor..*cursor + len].to_vec());
                *cursor += len;
            }
            out
        };
        let argv = take(argc, &mut cursor);
        let envp = take(envc, &mut cursor);
        assert_eq!(cursor, framed.len(), "framing must be fully consumed");
        (argv, envp)
    }

    #[test]
    fn serialize_argv_envp_frames_header_then_length_prefixed_entries() {
        let parsed = parse_blob(&build_basic_blob()).expect("parse");
        let mut out = alloc::vec![0u8; 256];
        let written = serialize_argv_envp(&parsed, &mut out).expect("serialize");
        assert_eq!(&out[0..4], &1u32.to_le_bytes()); // argc
        assert_eq!(&out[4..8], &1u32.to_le_bytes()); // envc
        assert_eq!(&out[8..12], &7u32.to_le_bytes()); // argv[0].len
        assert_eq!(&out[12..19], b"/bin/ls");
        assert_eq!(&out[19..23], &13u32.to_le_bytes()); // envp[0].len
        assert_eq!(&out[23..36], b"PATH=/usr/bin");
        assert_eq!(written, 36);
        let (argv, envp) = decode_framing(&out[..written]);
        assert_eq!(argv, alloc::vec![b"/bin/ls".to_vec()]);
        assert_eq!(envp, alloc::vec![b"PATH=/usr/bin".to_vec()]);
    }

    #[test]
    fn serialize_argv_envp_reports_overflow_instead_of_a_partial_frame() {
        let parsed = parse_blob(&build_basic_blob()).expect("parse");
        let mut header_only = alloc::vec![0u8; 8];
        assert_eq!(
            serialize_argv_envp(&parsed, &mut header_only),
            Err(Errno::EOVERFLOW),
        );
    }

    #[test]
    fn serialize_argv_envp_duplicates_shared_offsets_beyond_the_blob_length() {
        // Two argv entries reference the same string offset. `parse_blob`
        // yields the duplicated argv, and the framing must emit the bytes twice
        // even though the source blob stored them once — a framed length that
        // exceeds the compact blob length.
        let mut blob: Vec<u8> = Vec::new();
        blob.extend_from_slice(&2u32.to_le_bytes()); // argc
        blob.extend_from_slice(&0u32.to_le_bytes()); // envc
        blob.extend_from_slice(&0u32.to_le_bytes()); // n_actions
        blob.extend_from_slice(&0u32.to_le_bytes()); // attr_flags
        blob.extend_from_slice(&0i32.to_le_bytes()); // pgrp
        blob.extend_from_slice(&0u32.to_le_bytes()); // _pad
        blob.extend_from_slice(&0u64.to_le_bytes()); // sigdef
        blob.extend_from_slice(&0u64.to_le_bytes()); // sigmask
        blob.extend_from_slice(&0u32.to_le_bytes()); // argv[0] @ 0
        blob.extend_from_slice(&0u32.to_le_bytes()); // argv[1] @ 0
        blob.extend_from_slice(b"AB\0");

        let parsed = parse_blob(&blob).expect("parse duplicated offsets");
        assert_eq!(parsed.argv, alloc::vec![b"AB".to_vec(), b"AB".to_vec()]);
        let mut out = alloc::vec![0u8; 64];
        let written = serialize_argv_envp(&parsed, &mut out).expect("serialize");
        assert_eq!(written, 8 + (4 + 2) + (4 + 2));
        let (argv, envp) = decode_framing(&out[..written]);
        assert_eq!(argv, alloc::vec![b"AB".to_vec(), b"AB".to_vec()]);
        assert!(envp.is_empty());
    }

    #[test]
    fn parse_blob_round_trips_the_complete_sortix_file_action_surface_in_order() {
        fn append_action(
            blob: &mut Vec<u8>,
            op: u32,
            fd: i32,
            newfd: i32,
            path_off: u32,
            path_len: u32,
            oflag: i32,
            mode: u32,
        ) {
            let mut record = [0u8; spawn_contract::WIRE_ACTION_RECORD_BYTES];
            record
                [spawn_contract::WIRE_ACTION_OP_OFFSET..spawn_contract::WIRE_ACTION_OP_OFFSET + 4]
                .copy_from_slice(&op.to_le_bytes());
            record
                [spawn_contract::WIRE_ACTION_FD_OFFSET..spawn_contract::WIRE_ACTION_FD_OFFSET + 4]
                .copy_from_slice(&fd.to_le_bytes());
            record[spawn_contract::WIRE_ACTION_NEWFD_OFFSET
                ..spawn_contract::WIRE_ACTION_NEWFD_OFFSET + 4]
                .copy_from_slice(&newfd.to_le_bytes());
            record[spawn_contract::WIRE_ACTION_PATH_OFF_OFFSET
                ..spawn_contract::WIRE_ACTION_PATH_OFF_OFFSET + 4]
                .copy_from_slice(&path_off.to_le_bytes());
            record[spawn_contract::WIRE_ACTION_PATH_LEN_OFFSET
                ..spawn_contract::WIRE_ACTION_PATH_LEN_OFFSET + 4]
                .copy_from_slice(&path_len.to_le_bytes());
            record[spawn_contract::WIRE_ACTION_OFLAG_OFFSET
                ..spawn_contract::WIRE_ACTION_OFLAG_OFFSET + 4]
                .copy_from_slice(&oflag.to_le_bytes());
            record[spawn_contract::WIRE_ACTION_MODE_OFFSET
                ..spawn_contract::WIRE_ACTION_MODE_OFFSET + 4]
                .copy_from_slice(&mode.to_le_bytes());
            blob.extend_from_slice(&record);
        }

        let all_attr_bits = spawn_contract::ATTR_RESETIDS
            | spawn_contract::ATTR_SETPGROUP
            | spawn_contract::ATTR_SETSIGDEF
            | spawn_contract::ATTR_SETSIGMASK
            | spawn_contract::ATTR_SETSCHEDPARAM
            | spawn_contract::ATTR_SETSCHEDULER
            | spawn_contract::ATTR_USEVFORK
            | spawn_contract::ATTR_SETSID;
        let mut blob = header(0, 0, 5);
        blob[spawn_contract::WIRE_HEADER_ATTR_FLAGS_OFFSET
            ..spawn_contract::WIRE_HEADER_ATTR_FLAGS_OFFSET + 4]
            .copy_from_slice(&all_attr_bits.to_le_bytes());
        blob[spawn_contract::WIRE_HEADER_PGRP_OFFSET..spawn_contract::WIRE_HEADER_PGRP_OFFSET + 4]
            .copy_from_slice(&(-17i32).to_le_bytes());
        blob[spawn_contract::WIRE_HEADER_SIGDEF_OFFSET
            ..spawn_contract::WIRE_HEADER_SIGDEF_OFFSET + 8]
            .copy_from_slice(&0x0102_0304_0506_0708u64.to_le_bytes());
        blob[spawn_contract::WIRE_HEADER_SIGMASK_OFFSET
            ..spawn_contract::WIRE_HEADER_SIGMASK_OFFSET + 8]
            .copy_from_slice(&0x8877_6655_4433_2211u64.to_le_bytes());

        append_action(&mut blob, fdop::OPEN, 3, 0, 0, 12, 0x1234, 0o640);
        append_action(&mut blob, fdop::CLOSE, 4, 0, 0, 0, 0, 0);
        append_action(&mut blob, fdop::DUP2, 5, 6, 0, 0, 0, 0);
        append_action(&mut blob, fdop::CHDIR, 0, 0, 12, 7, 0, 0);
        append_action(&mut blob, fdop::FCHDIR, 7, 0, 0, 0, 0, 0);
        blob.extend_from_slice(b"open-target\0subdir\0");

        let parsed = parse_blob(&blob).expect("complete action surface");
        assert_eq!(parsed.attrs.flags, all_attr_bits);
        assert_eq!(parsed.attrs.pgrp, -17);
        assert_eq!(parsed.attrs.sigdef, 0x0102_0304_0506_0708);
        assert_eq!(parsed.attrs.sigmask, 0x8877_6655_4433_2211);
        assert_eq!(parsed.file_actions.len(), 5);

        match &parsed.file_actions[0] {
            FileAction::Open {
                fd,
                path,
                oflag,
                mode,
            } => {
                assert_eq!((*fd, *oflag, *mode), (3, 0x1234, 0o640));
                assert_eq!(path, b"open-target");
            }
            _ => panic!("first action must be Open"),
        }
        assert!(matches!(
            &parsed.file_actions[1],
            FileAction::Close { fd: 4 }
        ));
        assert!(matches!(
            &parsed.file_actions[2],
            FileAction::Dup2 { srcfd: 5, fd: 6 }
        ));
        match &parsed.file_actions[3] {
            FileAction::Chdir { path } => assert_eq!(path, b"subdir"),
            _ => panic!("fourth action must be Chdir"),
        }
        assert!(matches!(
            &parsed.file_actions[4],
            FileAction::Fchdir { fd: 7 }
        ));
    }

    #[test]
    fn parse_blob_rejects_short_header() {
        // Truncate to 39 bytes.
        let blob = build_basic_blob();
        let truncated = &blob[..39];
        assert!(matches!(parse_blob(truncated), Err(Errno::EINVAL)));
    }

    #[test]
    fn parse_blob_rejects_truncated_argv_offsets() {
        // argc=4 means we expect 16 bytes of argv_offsets after the header,
        // but we only provide 0 strings region after.
        let mut blob: Vec<u8> = Vec::new();
        blob.extend_from_slice(&4u32.to_le_bytes()); // argc=4 (table will be missing)
        blob.extend_from_slice(&0u32.to_le_bytes()); // envc
        blob.extend_from_slice(&0u32.to_le_bytes()); // n_actions
        blob.extend_from_slice(&0u32.to_le_bytes()); // attr_flags
        blob.extend_from_slice(&0i32.to_le_bytes()); // pgrp
        blob.extend_from_slice(&0u32.to_le_bytes()); // _pad
        blob.extend_from_slice(&0u64.to_le_bytes()); // sigdef
        blob.extend_from_slice(&0u64.to_le_bytes()); // sigmask
        // No argv_offsets follow → out of range.
        assert!(matches!(parse_blob(&blob), Err(Errno::EINVAL)));
    }

    #[test]
    fn parse_blob_rejects_unterminated_argv_and_environment_strings() {
        for (argc, envc) in [(1, 0), (0, 1)] {
            let mut blob = header(argc, envc, 0);
            blob.extend_from_slice(&0u32.to_le_bytes());
            blob.extend_from_slice(b"unterminated");
            assert!(
                matches!(parse_blob(&blob), Err(Errno::EINVAL)),
                "argc={argc}, envc={envc}",
            );
        }
    }

    #[test]
    fn parse_blob_rejects_action_path_out_of_bounds() {
        // n_actions=1, FDOP_CHDIR with path_off=999 (out of range).
        let mut blob: Vec<u8> = Vec::new();
        blob.extend_from_slice(&0u32.to_le_bytes()); // argc
        blob.extend_from_slice(&0u32.to_le_bytes()); // envc
        blob.extend_from_slice(&1u32.to_le_bytes()); // n_actions
        blob.extend_from_slice(&0u32.to_le_bytes()); // attr_flags
        blob.extend_from_slice(&0i32.to_le_bytes()); // pgrp
        blob.extend_from_slice(&0u32.to_le_bytes()); // _pad
        blob.extend_from_slice(&0u64.to_le_bytes()); // sigdef
        blob.extend_from_slice(&0u64.to_le_bytes()); // sigmask
        // No argv/envp offsets, then one action record:
        blob.extend_from_slice(&fdop::CHDIR.to_le_bytes());
        blob.extend_from_slice(&0i32.to_le_bytes()); // fd
        blob.extend_from_slice(&0i32.to_le_bytes()); // newfd
        blob.extend_from_slice(&999u32.to_le_bytes()); // path_off (oversized)
        blob.extend_from_slice(&5u32.to_le_bytes()); // path_len
        blob.extend_from_slice(&0i32.to_le_bytes()); // oflag
        blob.extend_from_slice(&0u32.to_le_bytes()); // mode
        blob.extend_from_slice(b"/x\0"); // small strings region
        assert!(matches!(parse_blob(&blob), Err(Errno::EINVAL)));
    }

    #[test]
    fn parse_blob_rejects_unknown_op() {
        let mut blob: Vec<u8> = Vec::new();
        blob.extend_from_slice(&0u32.to_le_bytes()); // argc
        blob.extend_from_slice(&0u32.to_le_bytes()); // envc
        blob.extend_from_slice(&1u32.to_le_bytes()); // n_actions
        blob.extend_from_slice(&0u32.to_le_bytes()); // attr_flags
        blob.extend_from_slice(&0i32.to_le_bytes()); // pgrp
        blob.extend_from_slice(&0u32.to_le_bytes()); // _pad
        blob.extend_from_slice(&0u64.to_le_bytes()); // sigdef
        blob.extend_from_slice(&0u64.to_le_bytes()); // sigmask
        blob.extend_from_slice(&99u32.to_le_bytes()); // op = 99 (unknown)
        blob.extend_from_slice(&[0u8; spawn_contract::WIRE_ACTION_RECORD_BYTES - 4]);
        assert!(matches!(parse_blob(&blob), Err(Errno::EINVAL)));
    }

    #[test]
    fn parse_blob_rejects_argv_overflow() {
        // argc set to a huge value that would multiply-overflow.
        let mut blob: Vec<u8> = Vec::new();
        blob.extend_from_slice(&u32::MAX.to_le_bytes());
        blob.extend_from_slice(&0u32.to_le_bytes());
        blob.extend_from_slice(&0u32.to_le_bytes());
        blob.extend_from_slice(&[0u8; spawn_contract::WIRE_HEADER_BYTES - 12]);
        assert!(matches!(parse_blob(&blob), Err(Errno::EINVAL)));
    }

    fn header(argc: u32, envc: u32, n_actions: u32) -> Vec<u8> {
        let mut blob = Vec::new();
        blob.extend_from_slice(&argc.to_le_bytes());
        blob.extend_from_slice(&envc.to_le_bytes());
        blob.extend_from_slice(&n_actions.to_le_bytes());
        blob.extend_from_slice(&[0u8; spawn_contract::WIRE_HEADER_BYTES - 12]);
        blob
    }

    fn action_path_blob(op: u32, path_len: u32, strings: &[u8]) -> Vec<u8> {
        let mut blob = header(0, 0, 1);
        blob.extend_from_slice(&op.to_le_bytes());
        blob.extend_from_slice(&0i32.to_le_bytes()); // fd
        blob.extend_from_slice(&0i32.to_le_bytes()); // newfd
        blob.extend_from_slice(&0u32.to_le_bytes()); // path_off
        blob.extend_from_slice(&path_len.to_le_bytes());
        blob.extend_from_slice(&0i32.to_le_bytes()); // oflag
        blob.extend_from_slice(&0u32.to_le_bytes()); // mode
        blob.extend_from_slice(strings);
        blob
    }

    fn exact_count_blob(argc: usize, envc: usize, n_actions: usize) -> Vec<u8> {
        let mut blob = header(argc as u32, envc as u32, n_actions as u32);
        blob.resize(
            spawn_contract::WIRE_HEADER_BYTES
                + (argc + envc) * spawn_contract::WIRE_STRING_OFFSET_BYTES,
            0,
        );
        for _ in 0..n_actions {
            let mut record = [0u8; spawn_contract::WIRE_ACTION_RECORD_BYTES];
            record
                [spawn_contract::WIRE_ACTION_OP_OFFSET..spawn_contract::WIRE_ACTION_OP_OFFSET + 4]
                .copy_from_slice(&fdop::CLOSE.to_le_bytes());
            blob.extend_from_slice(&record);
        }
        if argc + envc > 0 {
            // Every zero offset deliberately shares one empty NUL-terminated
            // string. Offset aliasing is valid and keeps this boundary test
            // focused on count admission rather than allocation volume.
            blob.push(0);
        }
        blob
    }

    #[test]
    fn parse_blob_accepts_each_exact_count_cap() {
        let argv = parse_blob(&exact_count_blob(spawn_contract::MAX_ARGV_COUNT, 0, 0))
            .expect("exact argv cap");
        assert_eq!(argv.argv.len(), spawn_contract::MAX_ARGV_COUNT);

        let envp = parse_blob(&exact_count_blob(0, spawn_contract::MAX_ENVP_COUNT, 0))
            .expect("exact envp cap");
        assert_eq!(envp.envp.len(), spawn_contract::MAX_ENVP_COUNT);

        let actions = parse_blob(&exact_count_blob(0, 0, spawn_contract::MAX_ACTION_COUNT))
            .expect("exact action cap");
        assert_eq!(actions.file_actions.len(), spawn_contract::MAX_ACTION_COUNT,);
    }

    #[test]
    fn parse_blob_accepts_all_exact_count_caps_together_and_rejects_a_truncated_tail() {
        let exact = exact_count_blob(
            spawn_contract::MAX_ARGV_COUNT,
            spawn_contract::MAX_ENVP_COUNT,
            spawn_contract::MAX_ACTION_COUNT,
        );
        let parsed = parse_blob(&exact).expect("all exact count caps");
        assert_eq!(parsed.argv.len(), spawn_contract::MAX_ARGV_COUNT);
        assert_eq!(parsed.envp.len(), spawn_contract::MAX_ENVP_COUNT);
        assert_eq!(parsed.file_actions.len(), spawn_contract::MAX_ACTION_COUNT);

        let mut truncated = exact;
        truncated.pop();
        assert!(matches!(parse_blob(&truncated), Err(Errno::EINVAL)));
    }

    #[test]
    fn parse_blob_rejects_each_count_at_limit_plus_one() {
        for (argc, envc, n_actions) in [
            ((spawn_contract::MAX_ARGV_COUNT + 1) as u32, 0, 0),
            (0, (spawn_contract::MAX_ENVP_COUNT + 1) as u32, 0),
            (0, 0, (spawn_contract::MAX_ACTION_COUNT + 1) as u32),
        ] {
            assert!(matches!(
                parse_blob(&header(argc, envc, n_actions)),
                Err(Errno::EINVAL)
            ));
        }
    }

    #[test]
    fn parse_blob_rejects_truncated_tables_at_each_exact_count_cap() {
        for (argc, envc, n_actions) in [
            (spawn_contract::MAX_ARGV_COUNT as u32, 0, 0),
            (0, spawn_contract::MAX_ENVP_COUNT as u32, 0),
            (0, 0, spawn_contract::MAX_ACTION_COUNT as u32),
        ] {
            assert!(matches!(
                parse_blob(&header(argc, envc, n_actions)),
                Err(Errno::EINVAL)
            ));
        }
    }

    #[test]
    fn parse_blob_rejects_duplicate_max_count_offsets_before_copying_the_tail() {
        let argc = spawn_contract::MAX_ARGV_COUNT;
        let mut blob = header(argc as u32, 0, 0);
        blob.extend(core::iter::repeat_n(
            0u8,
            argc * spawn_contract::WIRE_STRING_OFFSET_BYTES,
        ));
        blob.extend(core::iter::repeat_n(
            b'a',
            spawn_contract::POSIX_ARG_MAX_BYTES - 1,
        ));
        blob.push(0);

        // Decoding before aggregate accounting would try to allocate this
        // approximately four-megabyte string once for every argv entry.
        assert!(matches!(parse_blob(&blob), Err(Errno::E2BIG)));
    }

    #[test]
    fn parse_blob_accepts_exact_arg_max_and_rejects_arg_max_plus_one() {
        // One argv pointer, one envp pointer, and both terminators consume
        // sixteen bytes of the minimum wasm32 source representation.
        let string_bytes = spawn_contract::POSIX_ARG_MAX_BYTES - 16;
        let argv_bytes = string_bytes / 2;
        let envp_bytes = string_bytes - argv_bytes;
        let mut exact = header(1, 1, 0);
        exact.extend_from_slice(&0u32.to_le_bytes());
        exact.extend_from_slice(&(argv_bytes as u32).to_le_bytes());
        exact.extend(core::iter::repeat_n(b'a', argv_bytes - 1));
        exact.push(0);
        exact.extend(core::iter::repeat_n(b'b', envp_bytes - 1));
        exact.push(0);
        assert!(parse_blob(&exact).is_ok());

        let mut oversized = exact;
        oversized.insert(oversized.len() - 1, b'a');
        assert!(matches!(parse_blob(&oversized), Err(Errno::E2BIG)));
    }

    #[test]
    fn parse_blob_bounds_action_paths_by_path_max() {
        fn action_blob(op: u32, path_bytes: usize) -> Vec<u8> {
            let mut blob = header(0, 0, 1);
            blob.extend_from_slice(&op.to_le_bytes());
            blob.extend_from_slice(&0i32.to_le_bytes());
            blob.extend_from_slice(&0i32.to_le_bytes());
            blob.extend_from_slice(&0u32.to_le_bytes());
            blob.extend_from_slice(&(path_bytes as u32).to_le_bytes());
            blob.extend_from_slice(&0i32.to_le_bytes());
            blob.extend_from_slice(&0u32.to_le_bytes());
            blob.extend(core::iter::repeat_n(b'a', path_bytes - 1));
            blob.push(0);
            blob
        }

        for op in [fdop::OPEN, fdop::CHDIR] {
            assert!(
                parse_blob(&action_blob(op, spawn_contract::POSIX_PATH_MAX_BYTES)).is_ok(),
                "op {op} must accept PATH_MAX bytes including NUL",
            );
            assert!(
                matches!(
                    parse_blob(&action_blob(op, spawn_contract::POSIX_PATH_MAX_BYTES + 1)),
                    Err(Errno::ENAMETOOLONG)
                ),
                "op {op} must reject PATH_MAX+1 bytes including NUL",
            );
        }
    }

    #[test]
    fn parse_blob_action_paths_require_exactly_one_terminal_nul() {
        for op in [fdop::OPEN, fdop::CHDIR] {
            let parsed =
                parse_blob(&action_path_blob(op, 9, b"relative\0")).expect("one terminal NUL");
            let path = match &parsed.file_actions[0] {
                FileAction::Open { path, .. } | FileAction::Chdir { path } => path,
                _ => panic!("expected path-bearing action"),
            };
            assert_eq!(path, b"relative");

            for (case, path_len, strings) in [
                ("zero length", 0, &b"\0"[..]),
                ("missing terminator", 3, &b"abc\0"[..]),
                ("interior NUL", 4, &b"a\0b\0"[..]),
            ] {
                assert!(
                    matches!(
                        parse_blob(&action_path_blob(op, path_len, strings)),
                        Err(Errno::EINVAL)
                    ),
                    "{case} must be rejected for action op {op}",
                );
            }
        }
    }

    #[test]
    fn parse_blob_rejects_whole_blob_limit_plus_one() {
        let blob = alloc::vec![0; spawn_contract::WIRE_MAX_BYTES + 1];
        assert!(matches!(parse_blob(&blob), Err(Errno::E2BIG)));
    }
}
