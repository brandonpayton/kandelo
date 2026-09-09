extern crate alloc;

use alloc::collections::BTreeMap;
use alloc::vec::Vec;

use wasm_posix_shared::flags::{AT_EMPTY_PATH, AT_SYMLINK_NOFOLLOW};
use wasm_posix_shared::mode::{S_ISGID, S_ISUID};
use wasm_posix_shared::statfs_flags::ST_NOSUID;
use wasm_posix_shared::{Errno, WasmStat, WasmStatfs, platform_limits};

use crate::fd::OpenFileDescRef;
use crate::lock::{AdvisoryLockManager, FileId, OfdId};
use crate::ofd::FileType;
use crate::process::{HostIO, Process};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PreparedExecOwner {
    Process {
        pid: u32,
        caller_tid: u32,
        generation: u64,
    },
    Spawn {
        parent_pid: u32,
        child_pid: u32,
        launch: u64,
    },
}

impl PreparedExecOwner {
    pub fn validate_process(
        self,
        pid: u32,
        caller_tid: u32,
        generation: u64,
    ) -> Result<(), Errno> {
        let Self::Process {
            pid: expected_pid,
            caller_tid: expected_tid,
            generation: expected_generation,
        } = self
        else {
            return Err(Errno::EINVAL);
        };
        if pid != expected_pid {
            return Err(Errno::ESRCH);
        }
        if caller_tid != expected_tid || generation != expected_generation {
            return Err(Errno::EINVAL);
        }
        Ok(())
    }

    pub fn validate_spawn(
        self,
        parent_pid: u32,
        child_pid: u32,
        launch: u64,
    ) -> Result<(), Errno> {
        let Self::Spawn {
            parent_pid: expected_parent,
            child_pid: expected_child,
            launch: expected_launch,
        } = self
        else {
            return Err(Errno::EINVAL);
        };
        if parent_pid != expected_parent || child_pid != expected_child {
            return Err(Errno::ESRCH);
        }
        if launch != expected_launch {
            return Err(Errno::EINVAL);
        }
        Ok(())
    }
}

/// One exact executable object retained independently of guest descriptors.
///
/// The pathname is diagnostic only. `ofd_ref` plus `ofd_id` is the object
/// lease, and `observed_bytes` is filled only by positioned reads through that
/// lease. Commit requires complete coverage and compares the same bytes again.
pub struct PreparedExecTarget {
    token: u32,
    owner: PreparedExecOwner,
    ofd_ref: OpenFileDescRef,
    ofd_id: OfdId,
    file_id: Option<FileId>,
    stat: WasmStat,
    statfs: WasmStatfs,
    diagnostic_path: Vec<u8>,
    observed_bytes: Vec<u8>,
    observed_ranges: Vec<(usize, usize)>,
    content_drifted: bool,
}

impl PreparedExecTarget {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        owner: PreparedExecOwner,
        ofd_ref: OpenFileDescRef,
        ofd_id: OfdId,
        file_id: Option<FileId>,
        stat: WasmStat,
        statfs: WasmStatfs,
        diagnostic_path: Vec<u8>,
    ) -> Result<Self, Errno> {
        let size = usize::try_from(stat.st_size).map_err(|_| Errno::EOVERFLOW)?;
        if size > platform_limits::MAX_REPORTABLE_TRANSFER_BYTES {
            return Err(Errno::EFBIG);
        }
        let mut observed_bytes = Vec::new();
        observed_bytes
            .try_reserve_exact(size)
            .map_err(|_| Errno::ENOMEM)?;
        observed_bytes.resize(size, 0);

        Ok(Self {
            token: 0,
            owner,
            ofd_ref,
            ofd_id,
            file_id,
            stat,
            statfs,
            diagnostic_path,
            observed_bytes,
            observed_ranges: Vec::new(),
            content_drifted: false,
        })
    }

    pub fn owner(&self) -> PreparedExecOwner {
        self.owner
    }

    /// The pathname (or `AT_EMPTY_PATH` fd's captured path) this target was
    /// retained from. Diagnostic by origin, but `resolve_shebang` also uses it
    /// as the exact `argv[1]` a `#!` interpreter expects: the script's own
    /// path, not the interpreter's.
    pub fn diagnostic_path(&self) -> &[u8] {
        &self.diagnostic_path
    }

    pub fn ofd_ref(&self) -> OpenFileDescRef {
        self.ofd_ref
    }

    pub fn ofd_id(&self) -> OfdId {
        self.ofd_id
    }

    pub fn file_id(&self) -> Option<FileId> {
        self.file_id
    }

    pub fn stat(&self) -> &WasmStat {
        &self.stat
    }

    pub fn statfs(&self) -> &WasmStatfs {
        &self.statfs
    }

    pub fn size(&self) -> usize {
        self.observed_bytes.len()
    }

    pub fn is_fully_observed(&self) -> bool {
        self.observed_bytes.is_empty()
            || (self.observed_ranges.len() == 1
                && self.observed_ranges[0] == (0, self.observed_bytes.len()))
    }

    pub fn mark_content_drifted(&mut self) {
        self.content_drifted = true;
    }

    pub fn observed_bytes(&self) -> Result<&[u8], Errno> {
        if !self.is_fully_observed() {
            return Err(Errno::EINVAL);
        }
        if self.content_drifted {
            return Err(Errno::ETXTBSY);
        }
        Ok(&self.observed_bytes)
    }

    pub fn record_read(&mut self, offset: usize, bytes: &[u8]) -> Result<(), Errno> {
        let end = offset.checked_add(bytes.len()).ok_or(Errno::EOVERFLOW)?;
        if end > self.observed_bytes.len() {
            return Err(Errno::EINVAL);
        }

        for &(covered_start, covered_end) in &self.observed_ranges {
            let overlap_start = covered_start.max(offset);
            let overlap_end = covered_end.min(end);
            if overlap_start < overlap_end {
                let existing = &self.observed_bytes[overlap_start..overlap_end];
                let incoming = &bytes[overlap_start - offset..overlap_end - offset];
                if existing != incoming {
                    self.content_drifted = true;
                }
            }
        }
        self.observed_bytes[offset..end].copy_from_slice(bytes);
        if offset == end {
            return Ok(());
        }

        let mut merged_start = offset;
        let mut merged_end = end;
        let mut first = 0;
        while first < self.observed_ranges.len() && self.observed_ranges[first].1 < merged_start {
            first += 1;
        }
        let mut last = first;
        while last < self.observed_ranges.len() && self.observed_ranges[last].0 <= merged_end {
            merged_start = merged_start.min(self.observed_ranges[last].0);
            merged_end = merged_end.max(self.observed_ranges[last].1);
            last += 1;
        }
        self.observed_ranges
            .splice(first..last, core::iter::once((merged_start, merged_end)));
        Ok(())
    }

    pub fn is_script(&self) -> Result<bool, Errno> {
        Ok(self.observed_bytes()?.starts_with(b"#!"))
    }
}

/// The largest `#!` header prefix the shebang decoder ever inspects.
///
/// `parse_shebang` scans at most to byte index 4096 for the terminating
/// newline, so reading the first `min(size, 4096)` bytes of a target is
/// sufficient to decode the interpreter line exactly.
const SHEBANG_HEADER_MAX_BYTES: usize = 4096;

/// One decoded `#!` interpreter line.
///
/// This is the Rust-owned replacement for the host's former `parseShebang`
/// byte interpretation: the kernel decodes the interpreter path and its single
/// optional argument, and the host merely assembles argv from these fields.
pub struct Shebang {
    pub interpreter: alloc::string::String,
    pub argument: Option<alloc::string::String>,
}

/// The JavaScript `\s` / `String.prototype.trim` whitespace set.
///
/// ECMAScript's `WhiteSpace` + `LineTerminator` production and the RegExp `\s`
/// class cover the exact same code points, so one predicate faithfully mirrors
/// both the `.trim()` and `\S`/`\s` behavior of the former `parseShebang`.
fn is_js_whitespace(c: char) -> bool {
    matches!(
        c,
        '\u{0009}'
            | '\u{000A}'
            | '\u{000B}'
            | '\u{000C}'
            | '\u{000D}'
            | '\u{0020}'
            | '\u{00A0}'
            | '\u{1680}'
            | '\u{2000}'..='\u{200A}'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{202F}'
            | '\u{205F}'
            | '\u{3000}'
            | '\u{FEFF}'
    )
}

/// The code points a JavaScript `.` (no `s` flag) refuses to match.
fn is_js_line_terminator(c: char) -> bool {
    matches!(c, '\u{000A}' | '\u{000D}' | '\u{2028}' | '\u{2029}')
}

/// Decode a `#!` interpreter line exactly as the host's former `parseShebang`
/// did (`host/src/exec-target.ts`).
///
/// Contract, ported byte-for-byte:
///   * require the `#!` magic (`0x23 0x21`); fewer than two bytes → `None`.
///   * scan for the terminating newline, bounded at index 4096.
///   * decode the scanned bytes as UTF-8 with replacement (`TextDecoder`),
///     drop exactly one trailing `\r` (`/\r$/`), then trim JS whitespace.
///   * apply `/^(\S+)(?:\s+(.*))?$/`: the first non-whitespace run is the
///     interpreter, and the remainder after the following whitespace run is a
///     single optional argument. A trimmed line that is empty, or whose
///     argument would contain an internal line terminator (so JS `$` cannot
///     match), yields `None`.
pub fn parse_shebang(bytes: &[u8]) -> Option<Shebang> {
    if bytes.len() < 2 || bytes[0] != 0x23 || bytes[1] != 0x21 {
        return None;
    }
    let mut end = 2usize;
    while end < bytes.len() && end < SHEBANG_HEADER_MAX_BYTES && bytes[end] != 0x0A {
        end += 1;
    }
    // `new TextDecoder().decode(...)`: UTF-8, invalid sequences → U+FFFD.
    let decoded = alloc::string::String::from_utf8_lossy(&bytes[2..end]);
    // `.replace(/\r$/, "")`: drop exactly one trailing carriage return.
    let without_cr = decoded.strip_suffix('\r').unwrap_or(&decoded);
    // `.trim()`: strip leading and trailing JS whitespace.
    let line = without_cr.trim_matches(|c: char| is_js_whitespace(c));
    if line.is_empty() {
        return None;
    }

    // `\S+`: the leading non-whitespace run (non-empty, the line is trimmed).
    let interp_end = line
        .char_indices()
        .find(|&(_, c)| is_js_whitespace(c))
        .map(|(offset, _)| offset)
        .unwrap_or(line.len());
    let interpreter = &line[..interp_end];
    if interp_end == line.len() {
        return Some(Shebang {
            interpreter: interpreter.into(),
            argument: None,
        });
    }

    // `\s+`: consume the whitespace run separating interpreter and argument.
    let arg_start = line[interp_end..]
        .char_indices()
        .find(|&(_, c)| !is_js_whitespace(c))
        .map(|(offset, _)| interp_end + offset)
        // Only whitespace remained (impossible after `.trim()`); no argument.
        .unwrap_or(line.len());
    let argument = &line[arg_start..];
    // `.*` stops at a line terminator, so an internal one leaves `$` unmatched
    // and the whole pattern fails — exactly as JS returns null.
    if argument.chars().any(is_js_line_terminator) {
        return None;
    }
    Some(Shebang {
        interpreter: interpreter.into(),
        argument: Some(argument.into()),
    })
}

pub struct PreparedExecLedger {
    entries: BTreeMap<u32, PreparedExecTarget>,
    next_token: Option<u32>,
}

impl PreparedExecLedger {
    pub const fn new() -> Self {
        Self {
            entries: BTreeMap::new(),
            next_token: Some(1),
        }
    }

    pub fn insert(&mut self, mut target: PreparedExecTarget) -> Result<u32, Errno> {
        let token = self.next_token.ok_or(Errno::EOVERFLOW)?;
        debug_assert_ne!(token, 0);
        debug_assert!(token <= i32::MAX as u32);
        self.next_token = token.checked_add(1).filter(|next| *next <= i32::MAX as u32);
        target.token = token;
        if self.entries.insert(token, target).is_some() {
            return Err(Errno::EOVERFLOW);
        }
        Ok(token)
    }

    pub fn ensure_insert_capacity(&self) -> Result<(), Errno> {
        self.next_token.map(|_| ()).ok_or(Errno::EOVERFLOW)
    }

    pub fn get(&self, token: u32) -> Result<&PreparedExecTarget, Errno> {
        self.entries.get(&token).ok_or(Errno::EINVAL)
    }

    pub fn get_mut(&mut self, token: u32) -> Result<&mut PreparedExecTarget, Errno> {
        self.entries.get_mut(&token).ok_or(Errno::EINVAL)
    }

    pub fn take(&mut self, token: u32) -> Result<PreparedExecTarget, Errno> {
        self.entries.remove(&token).ok_or(Errno::EINVAL)
    }

    pub fn drain(&mut self) -> impl Iterator<Item = PreparedExecTarget> + '_ {
        core::mem::take(&mut self.entries).into_values()
    }

    #[cfg(test)]
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    #[cfg(test)]
    fn set_next_token_for_test(&mut self, next: u32) {
        self.next_token = Some(next);
    }
}

fn owner_matches_ledger_pid(owner: PreparedExecOwner, pid: u32) -> Result<(), Errno> {
    let expected_pid = match owner {
        PreparedExecOwner::Process { pid, .. } => pid,
        PreparedExecOwner::Spawn { child_pid, .. } => child_pid,
    };
    if pid == expected_pid {
        Ok(())
    } else {
        Err(Errno::ESRCH)
    }
}

fn release_target(
    proc: &mut Process,
    locks: &mut AdvisoryLockManager,
    host: &mut dyn HostIO,
    target: &PreparedExecTarget,
) {
    let _ =
        crate::syscalls::release_prepared_exec_ofd_with_locks(proc, locks, host, target.ofd_ref());
}

fn insert_opened_target(
    proc: &mut Process,
    locks: &mut AdvisoryLockManager,
    host: &mut dyn HostIO,
    owner: PreparedExecOwner,
    opened: crate::syscalls::PreparedExecOpen,
) -> Result<u32, Errno> {
    let ofd_ref = opened.ofd_ref;
    let target = match PreparedExecTarget::new(
        owner,
        opened.ofd_ref,
        opened.ofd_id,
        opened.file_id,
        opened.stat,
        opened.statfs,
        opened.diagnostic_path,
    ) {
        Ok(target) => target,
        Err(error) => {
            let _ =
                crate::syscalls::release_prepared_exec_ofd_with_locks(proc, locks, host, ofd_ref);
            return Err(error);
        }
    };
    match proc.prepared_exec_targets.insert(target) {
        Ok(token) => Ok(token),
        Err(error) => {
            let _ =
                crate::syscalls::release_prepared_exec_ofd_with_locks(proc, locks, host, ofd_ref);
            Err(error)
        }
    }
}

fn retain_empty_path_target(
    proc: &mut Process,
    host: &mut dyn HostIO,
    fd: i32,
) -> Result<crate::syscalls::PreparedExecOpen, Errno> {
    let ofd_ref = proc.fd_table.get(fd)?.ofd_ref;
    let (ofd_id, file_type, host_handle, diagnostic_path) = {
        let ofd = proc.ofd_table.get(ofd_ref.0).ok_or(Errno::EBADF)?;
        (ofd.ofd_id, ofd.file_type, ofd.host_handle, ofd.path.clone())
    };
    let invalid_handle =
        host_handle < 0 && !crate::rootfs::is_rootfs_file_handle(host_handle);
    if file_type != FileType::Regular || invalid_handle {
        return Err(Errno::EACCES);
    }
    let stat = target_fstat(host, host_handle)?;
    crate::syscalls::check_prepared_exec_stat(proc, &stat)?;
    let statfs = if crate::rootfs::is_rootfs_file_handle(host_handle) {
        // The overlay statfs carries the `/` mount's real `nosuid` flag, so an
        // AT_EMPTY_PATH exec of a set-ID overlay binary honors (or, on a nosuid
        // mount, drops) the set-ID bits exactly like the pathname exec path.
        crate::rootfs::statfs(&diagnostic_path)?
    } else {
        crate::syscalls::host_fstatfs_or_default(host, host_handle)?
    };
    let file_id = (stat.st_ino != 0).then_some(FileId::Host {
        dev: stat.st_dev,
        ino: stat.st_ino,
    });
    proc.ofd_table.try_inc_ref_exact(ofd_ref.0, ofd_id)?;
    Ok(crate::syscalls::PreparedExecOpen {
        ofd_ref,
        ofd_id,
        file_id,
        stat,
        statfs,
        diagnostic_path,
    })
}

/// Retain the exact object selected by one pathname or `AT_EMPTY_PATH`
/// request. The returned token is process-local, positive, and one-shot.
pub fn prepare(
    proc: &mut Process,
    locks: &mut AdvisoryLockManager,
    host: &mut dyn HostIO,
    owner: PreparedExecOwner,
    dirfd: i32,
    path: &[u8],
    flags: u32,
) -> Result<u32, Errno> {
    proc.prepared_exec_targets.ensure_insert_capacity()?;
    if flags & !(AT_EMPTY_PATH | AT_SYMLINK_NOFOLLOW) != 0 {
        return Err(Errno::EINVAL);
    }
    let opened = if path.is_empty() {
        if flags & AT_EMPTY_PATH == 0 {
            return Err(Errno::ENOENT);
        }
        retain_empty_path_target(proc, host, dirfd)?
    } else {
        crate::syscalls::open_prepared_exec_target(proc, host, dirfd, path, flags)?
    };
    insert_opened_target(proc, locks, host, owner, opened)
}

fn retained_host_handle(proc: &Process, target: &PreparedExecTarget) -> Result<i64, Errno> {
    let ofd = proc
        .ofd_table
        .get(target.ofd_ref().0)
        .ok_or(Errno::ETXTBSY)?;
    // A rootfs-overlay exec target carries a negative rootfs handle, which is a
    // valid backing (not the "no host handle" sentinel).
    let invalid_handle =
        ofd.host_handle < 0 && !crate::rootfs::is_rootfs_file_handle(ofd.host_handle);
    if ofd.ofd_id != target.ofd_id() || ofd.file_type != FileType::Regular || invalid_handle {
        return Err(Errno::ETXTBSY);
    }
    Ok(ofd.host_handle)
}

/// fstat the retained exec target, honoring in-kernel rootfs overlay handles
/// (a negative rootfs handle is served by the overlay, not the host).
fn target_fstat(host: &mut dyn HostIO, host_handle: i64) -> Result<WasmStat, Errno> {
    if crate::rootfs::is_rootfs_file_handle(host_handle) {
        crate::rootfs::fstat(host_handle)
    } else {
        host.host_fstat(host_handle)
    }
}

/// Positioned read of the retained exec target, honoring overlay handles: base
/// bytes come from the blob provider, copy-on-written bytes from the overlay.
fn target_pread(
    host: &mut dyn HostIO,
    host_handle: i64,
    buf: &mut [u8],
    offset: i64,
) -> Result<usize, Errno> {
    if crate::rootfs::is_rootfs_file_handle(host_handle) {
        crate::rootfs::read(host_handle, offset, buf, |req, b| match req {
            crate::rootfs::ByteReq::Base { blob_id, offset } => host.blob_read(blob_id, b, offset),
            crate::rootfs::ByteReq::Archive { archive_id, offset } => {
                host.fetch_archive(archive_id, b, offset)
            }
        })
    } else {
        host.host_pread(host_handle, buf, offset)
    }
}

pub fn size(proc: &Process, owner_pid: u32, token: u32) -> Result<i64, Errno> {
    let target = proc.prepared_exec_targets.get(token)?;
    owner_matches_ledger_pid(target.owner(), owner_pid)?;
    i64::try_from(target.size()).map_err(|_| Errno::EOVERFLOW)
}

pub fn read(
    proc: &mut Process,
    host: &mut dyn HostIO,
    owner_pid: u32,
    token: u32,
    offset: i64,
    buffer: &mut [u8],
) -> Result<usize, Errno> {
    if offset < 0 {
        return Err(Errno::EINVAL);
    }
    let offset = usize::try_from(offset).map_err(|_| Errno::EOVERFLOW)?;
    let (handle, size) = {
        let target = proc.prepared_exec_targets.get(token)?;
        owner_matches_ledger_pid(target.owner(), owner_pid)?;
        (retained_host_handle(proc, target)?, target.size())
    };
    if offset >= size || buffer.is_empty() {
        return Ok(0);
    }
    let wanted = buffer.len().min(size - offset);
    let read = target_pread(host, handle, &mut buffer[..wanted], offset as i64)?;
    if read > wanted {
        return Err(Errno::EIO);
    }
    let target = proc.prepared_exec_targets.get_mut(token)?;
    if read == 0 && offset < size {
        target.mark_content_drifted();
    }
    target.record_read(offset, &buffer[..read])?;
    Ok(read)
}

/// Decode the retained target's `#!` interpreter line, reading the header
/// bytes internally through the retained handle.
///
/// This deliberately does not consult `observed_bytes` or `record_read`: the
/// kernel owns the shebang decode independently of whatever positioned reads
/// the host has issued, so decoding never depends on host read ordering. A
/// positioned read of the first `min(size, 4096)` bytes is all `parse_shebang`
/// ever inspects.
pub fn shebang(
    proc: &Process,
    host: &mut dyn HostIO,
    owner_pid: u32,
    token: u32,
) -> Result<Option<Shebang>, Errno> {
    let (handle, size) = {
        let target = proc.prepared_exec_targets.get(token)?;
        owner_matches_ledger_pid(target.owner(), owner_pid)?;
        (retained_host_handle(proc, target)?, target.size())
    };
    let want = size.min(SHEBANG_HEADER_MAX_BYTES);
    let mut header = [0u8; SHEBANG_HEADER_MAX_BYTES];
    let mut filled = 0usize;
    while filled < want {
        let read = target_pread(host, handle, &mut header[filled..want], filled as i64)?;
        if read == 0 {
            // A short read cannot advance the header; decode what is present.
            break;
        }
        if read > want - filled {
            return Err(Errno::EIO);
        }
        filled += read;
    }
    Ok(parse_shebang(&header[..filled]))
}

/// The `#!` argv-prefix pieces the caller assembles ahead of the resolved
/// interpreter's own argv: the decoded interpreter path, its single optional
/// argument, and the original script's path (a `#!` script's own path is
/// always the interpreter's first argument, exactly as the host's former
/// `resolveShebangChain` assembled it in `host/src/exec-target.ts`).
pub struct ShebangArgvPrefix {
    pub interpreter: alloc::string::String,
    pub argument: Option<alloc::string::String>,
    pub script_path: Vec<u8>,
}

/// The outcome of resolving one retained target's `#!` chain.
///
/// `final_token` is the token the caller should actually instantiate and
/// commit — either the input token unchanged (not a script) or a freshly
/// prepared interpreter token (a script, resolved exactly one level).
pub struct ResolvedShebang {
    pub final_token: u32,
    pub prefix: Option<ShebangArgvPrefix>,
}

/// Resolve `token`'s `#!` chain end-to-end.
///
/// A non-script target passes through unchanged. A script target is resolved
/// by canceling the script's own retained target (a script's set-ID bits are
/// never honored, so nothing about the script object survives past
/// resolution) and preparing its decoded interpreter under the same owner.
/// Exactly one level of `#!` is permitted: if the freshly prepared
/// interpreter is itself a script, the half-resolved interpreter token is
/// canceled and resolution fails `ENOEXEC` — the kernel's long-standing
/// nested-shebang limit. On every error path, zero tokens from this call are
/// left retained; on success, exactly one (`final_token`) is.
pub fn resolve_shebang(
    proc: &mut Process,
    locks: &mut AdvisoryLockManager,
    host: &mut dyn HostIO,
    owner_pid: u32,
    token: u32,
) -> Result<ResolvedShebang, Errno> {
    match shebang(proc, host, owner_pid, token)? {
        None => Ok(ResolvedShebang {
            final_token: token,
            prefix: None,
        }),
        Some(sb) => {
            let owner = proc.prepared_exec_targets.get(token)?.owner();
            let script_path = proc
                .prepared_exec_targets
                .get(token)?
                .diagnostic_path()
                .to_vec();
            cancel(proc, locks, host, owner_pid, token)?;
            let interp_token = prepare(
                proc,
                locks,
                host,
                owner,
                wasm_posix_shared::flags::AT_FDCWD,
                sb.interpreter.as_bytes(),
                0,
            )?;
            match shebang(proc, host, owner_pid, interp_token) {
                Ok(Some(_)) => {
                    // The interpreter is itself a `#!` script — one level too
                    // deep. Release the half-resolved interpreter token before
                    // reporting the nested chain as `ENOEXEC`.
                    cancel(proc, locks, host, owner_pid, interp_token)?;
                    return Err(Errno::ENOEXEC);
                }
                Ok(None) => {}
                Err(error) => {
                    // The header read on the freshly-prepared interpreter
                    // failed. Release it too — the caller must see zero
                    // retained tokens on every error path, not just the
                    // nested-script one. Best-effort: a cancel failure here
                    // must not mask the original read error.
                    let _ = cancel(proc, locks, host, owner_pid, interp_token);
                    return Err(error);
                }
            }
            Ok(ResolvedShebang {
                final_token: interp_token,
                prefix: Some(ShebangArgvPrefix {
                    interpreter: sb.interpreter,
                    argument: sb.argument,
                    script_path,
                }),
            })
        }
    }
}

pub fn cancel(
    proc: &mut Process,
    locks: &mut AdvisoryLockManager,
    host: &mut dyn HostIO,
    owner_pid: u32,
    token: u32,
) -> Result<(), Errno> {
    {
        let target = proc.prepared_exec_targets.get(token)?;
        owner_matches_ledger_pid(target.owner(), owner_pid)?;
    }
    let target = proc.prepared_exec_targets.take(token)?;
    release_target(proc, locks, host, &target);
    Ok(())
}

fn metadata_matches(prepared: &WasmStat, live: &WasmStat) -> bool {
    prepared.st_dev == live.st_dev
        && prepared.st_ino == live.st_ino
        && prepared.st_mode == live.st_mode
        && prepared.st_uid == live.st_uid
        && prepared.st_gid == live.st_gid
        && prepared.st_size == live.st_size
        && prepared.st_mtime_sec == live.st_mtime_sec
        && prepared.st_mtime_nsec == live.st_mtime_nsec
}

fn mount_matches(prepared: &WasmStatfs, live: &WasmStatfs) -> bool {
    prepared.f_type == live.f_type
        && prepared.f_fsid == live.f_fsid
        && prepared.f_flags == live.f_flags
}

fn has_credential_transition(target: &PreparedExecTarget) -> Result<bool, Errno> {
    if target.is_script()? || target.stat().st_mode & (S_ISUID | S_ISGID) == 0 {
        return Ok(false);
    }
    let proposal = crate::syscalls::propose_set_id_transition(target.stat(), target.statfs());
    Ok(proposal.effective_uid.is_some() || proposal.effective_gid.is_some())
}

fn validate_stable_privileged_source(target: &PreparedExecTarget) -> Result<(), Errno> {
    if target.statfs().f_flags & ST_NOSUID != 0 {
        return Ok(());
    }
    match target.file_id() {
        Some(FileId::Host { dev, ino })
            if dev == target.stat().st_dev && ino == target.stat().st_ino && ino != 0 =>
        {
            Ok(())
        }
        _ => Err(Errno::ENOTSUP),
    }
}

fn revalidate(
    proc: &Process,
    host: &mut dyn HostIO,
    target: &PreparedExecTarget,
) -> Result<(), Errno> {
    let expected = target.observed_bytes()?;
    let handle = retained_host_handle(proc, target)?;
    let is_rootfs = crate::rootfs::is_rootfs_file_handle(handle);
    let before = target_fstat(host, handle)?;
    if !metadata_matches(target.stat(), &before) {
        return Err(Errno::ETXTBSY);
    }

    let credential_bearing = has_credential_transition(target)?;
    if credential_bearing {
        validate_stable_privileged_source(target)?;
    }
    // The rootfs overlay is a single fixed in-kernel mount; it cannot remount
    // under the kernel, so its mount identity is the prepared value by
    // construction. Host mounts are still re-checked for a remount race.
    let live = if is_rootfs {
        *target.statfs()
    } else {
        host.host_fstatfs(handle).map_err(|_| Errno::ENOTSUP)?
    };
    if !mount_matches(target.statfs(), &live) {
        return Err(Errno::ETXTBSY);
    }

    let mut offset = 0usize;
    let mut scratch = [0u8; 64 * 1024];
    while offset < expected.len() {
        let wanted = scratch.len().min(expected.len() - offset);
        let read = target_pread(host, handle, &mut scratch[..wanted], offset as i64)?;
        if read == 0 || read > wanted || scratch[..read] != expected[offset..offset + read] {
            return Err(Errno::ETXTBSY);
        }
        offset += read;
    }
    let after = target_fstat(host, handle)?;
    if !metadata_matches(target.stat(), &after) {
        return Err(Errno::ETXTBSY);
    }
    Ok(())
}

fn proposed_credentials(
    proc: &Process,
    target: &PreparedExecTarget,
) -> Result<crate::credentials::Credentials, Errno> {
    let mut candidate = proc.credentials().clone();
    if !target.is_script()? {
        let proposal = crate::syscalls::propose_set_id_transition(target.stat(), target.statfs());
        if let Some(uid) = proposal.effective_uid {
            candidate.euid = uid;
        }
        if let Some(gid) = proposal.effective_gid {
            candidate.egid = gid;
        }
    }
    candidate.suid = candidate.euid;
    candidate.sgid = candidate.egid;
    Ok(candidate)
}

fn finish_commit(
    proc: &mut Process,
    locks: &mut AdvisoryLockManager,
    host: &mut dyn HostIO,
    target: PreparedExecTarget,
    caller_tid: Option<u32>,
) -> Result<(), Errno> {
    let next_generation = proc
        .exec_generation
        .checked_add(1)
        .ok_or(Errno::EOVERFLOW)?;
    revalidate(proc, host, &target)?;
    let credentials = proposed_credentials(proc, &target)?;
    match caller_tid {
        Some(tid) => crate::syscalls::commit_exec_state_with_locks(proc, locks, host, tid)?,
        None => crate::syscalls::commit_spawn_exec_state_with_locks(proc, locks, host)?,
    }
    proc.secure_exec = credentials.euid != credentials.ruid || credentials.egid != credentials.rgid;
    proc.install_credentials(credentials);
    proc.exec_generation = next_generation;

    let competing: Vec<_> = proc.prepared_exec_targets.drain().collect();
    for stale in competing {
        release_target(proc, locks, host, &stale);
    }
    Ok(())
}

pub fn commit_process(
    proc: &mut Process,
    locks: &mut AdvisoryLockManager,
    host: &mut dyn HostIO,
    pid: u32,
    caller_tid: u32,
    token: u32,
) -> Result<(), Errno> {
    let target = proc.prepared_exec_targets.take(token)?;
    let validation = target
        .owner()
        .validate_process(pid, caller_tid, proc.exec_generation);
    commit_taken_target(proc, locks, host, target, validation, Some(caller_tid))
}

fn commit_taken_target(
    proc: &mut Process,
    locks: &mut AdvisoryLockManager,
    host: &mut dyn HostIO,
    target: PreparedExecTarget,
    validation: Result<(), Errno>,
    caller_tid: Option<u32>,
) -> Result<(), Errno> {
    if let Err(error) = validation {
        release_target(proc, locks, host, &target);
        return Err(error);
    }
    let ofd_ref = target.ofd_ref();
    let result = finish_commit(proc, locks, host, target, caller_tid);
    let _ = crate::syscalls::release_prepared_exec_ofd_with_locks(proc, locks, host, ofd_ref);
    result
}

pub fn commit_spawn(
    proc: &mut Process,
    locks: &mut AdvisoryLockManager,
    host: &mut dyn HostIO,
    parent_pid: u32,
    child_pid: u32,
    token: u32,
) -> Result<(), Errno> {
    let target = proc.prepared_exec_targets.take(token)?;
    let validation = target
        .owner()
        .validate_spawn(parent_pid, child_pid, proc.exec_generation);
    commit_taken_target(proc, locks, host, target, validation, None)
}

pub fn drain_prepared_exec_targets(
    proc: &mut Process,
    locks: &mut AdvisoryLockManager,
    host: &mut dyn HostIO,
) {
    let targets: Vec<_> = proc.prepared_exec_targets.drain().collect();
    for target in targets {
        release_target(proc, locks, host, &target);
    }
}

impl Default for PreparedExecLedger {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::{
        PreparedExecLedger, PreparedExecOwner, PreparedExecTarget, SHEBANG_HEADER_MAX_BYTES,
        parse_shebang,
    };
    use crate::fd::OpenFileDescRef;
    use crate::lock::{FileId, OfdId};
    use wasm_posix_shared::{Errno, WasmStat, WasmStatfs};

    /// Flatten a decoded shebang into borrowed fields for terse assertions.
    fn decode(bytes: &[u8]) -> Option<(alloc::string::String, Option<alloc::string::String>)> {
        parse_shebang(bytes).map(|shebang| (shebang.interpreter, shebang.argument))
    }

    #[test]
    fn rejects_non_shebang_and_too_short_inputs() {
        // Fewer than two bytes, or without the exact `#!` magic, is never a
        // script — byte-for-byte with the former `parseShebang`.
        assert!(decode(b"").is_none());
        assert!(decode(b"#").is_none());
        assert!(decode(b"!/bin/sh").is_none());
        assert!(decode(b"#x/bin/sh").is_none());
        assert!(decode(b"\0asm").is_none());
        // The two-byte prefix present but nothing else → empty line → None.
        assert!(decode(b"#!").is_none());
    }

    #[test]
    fn splits_interpreter_and_single_argument() {
        assert_eq!(
            decode(b"#!/bin/sh\n"),
            Some(("/bin/sh".into(), None)),
        );
        assert_eq!(
            decode(b"#!/bin/exact-interpreter --script-flag\nignored body\n"),
            Some((
                "/bin/exact-interpreter".into(),
                Some("--script-flag".into()),
            )),
        );
        // The remainder after the first whitespace run is one single argument,
        // internal spaces preserved.
        assert_eq!(
            decode(b"#!/usr/bin/env python -u -B\n"),
            Some(("/usr/bin/env".into(), Some("python -u -B".into()))),
        );
    }

    #[test]
    fn strips_one_trailing_carriage_return_and_surrounding_whitespace() {
        // `/\r$/` removes the CRLF carriage return the newline scan leaves.
        assert_eq!(
            decode(b"#!/bin/sh\r\n"),
            Some(("/bin/sh".into(), None)),
        );
        // `.trim()` removes leading and trailing whitespace around the line.
        assert_eq!(
            decode(b"#!  \t /bin/sh -x \t \n"),
            Some(("/bin/sh".into(), Some("-x".into()))),
        );
    }

    #[test]
    fn treats_a_line_with_only_whitespace_as_no_shebang() {
        // `#!` followed by only spaces/tabs trims to empty → no match → None.
        assert!(decode(b"#!   \n").is_none());
        assert!(decode(b"#!\t \r\n").is_none());
    }

    #[test]
    fn caps_the_interpreter_line_scan_at_four_kib() {
        // A newline beyond index 4096 is never seen; the interpreter token is
        // taken from the first 4096 bytes exactly as the host bound did.
        let mut bytes = alloc::vec::Vec::new();
        bytes.extend_from_slice(b"#!");
        bytes.extend(core::iter::repeat(b'a').take(8192));
        bytes.push(b'\n');
        let (interpreter, argument) = decode(&bytes).unwrap();
        assert_eq!(interpreter.len(), SHEBANG_HEADER_MAX_BYTES - 2);
        assert!(argument.is_none());
        assert!(interpreter.bytes().all(|byte| byte == b'a'));
    }

    #[test]
    fn rejects_an_argument_containing_an_internal_line_terminator() {
        // `.*` cannot cross a bare CR, so JS `$` fails and the whole line does
        // not match: the result is None (not a truncated argument).
        assert!(decode(b"#!/bin/sh a\rb\n").is_none());
        // A CR consumed inside the interpreter/argument whitespace run is fine.
        assert_eq!(
            decode(b"#!/bin/sh\rarg\n"),
            Some(("/bin/sh".into(), Some("arg".into()))),
        );
    }

    fn stat() -> WasmStat {
        WasmStat {
            st_dev: 7,
            st_ino: 11,
            st_mode: wasm_posix_shared::mode::S_IFREG | 0o755,
            st_nlink: 1,
            st_uid: 1000,
            st_gid: 1000,
            st_size: 4,
            st_atime_sec: 0,
            st_atime_nsec: 0,
            st_mtime_sec: 1,
            st_mtime_nsec: 2,
            st_ctime_sec: 3,
            st_ctime_nsec: 4,
            _pad: 0,
        }
    }

    fn statfs() -> WasmStatfs {
        WasmStatfs {
            f_type: 1,
            f_bsize: 4096,
            f_blocks: 1,
            f_bfree: 0,
            f_bavail: 0,
            f_files: 1,
            f_ffree: 0,
            f_fsid: 19,
            f_namelen: 255,
            f_frsize: 4096,
            f_flags: wasm_posix_shared::statfs_flags::ST_NOSUID,
            _pad: 0,
        }
    }

    fn target(owner: PreparedExecOwner, index: usize, id: u64) -> PreparedExecTarget {
        PreparedExecTarget::new(
            owner,
            OpenFileDescRef(index),
            OfdId(id),
            Some(FileId::Host { dev: 7, ino: 11 }),
            stat(),
            statfs(),
            b"/bin/program".to_vec(),
        )
        .unwrap()
    }

    #[test]
    fn tokens_are_positive_monotonic_one_shot_authority() {
        let owner = PreparedExecOwner::Process {
            pid: 41,
            caller_tid: 43,
            generation: 9,
        };
        let mut ledger = PreparedExecLedger::new();
        let first = ledger.insert(target(owner, 3, 101)).unwrap();
        let second = ledger.insert(target(owner, 4, 102)).unwrap();

        assert!(first > 0);
        assert_eq!(second, first + 1);
        assert_eq!(ledger.take(first).unwrap().ofd_id(), OfdId(101));
        assert!(matches!(ledger.take(first), Err(Errno::EINVAL)));
        assert_eq!(ledger.take(second).unwrap().ofd_id(), OfdId(102));
        assert!(ledger.is_empty());
    }

    #[test]
    fn token_allocator_exhausts_before_signed_wrap_or_reuse() {
        let owner = PreparedExecOwner::Process {
            pid: 1,
            caller_tid: 1,
            generation: 0,
        };
        let mut ledger = PreparedExecLedger::new();
        ledger.set_next_token_for_test(i32::MAX as u32);

        assert_eq!(ledger.insert(target(owner, 0, 1)).unwrap(), i32::MAX as u32,);
        assert_eq!(ledger.insert(target(owner, 1, 2)), Err(Errno::EOVERFLOW),);
    }

    #[test]
    fn owner_validation_binds_pid_tid_generation_and_spawn_launch() {
        let process_owner = PreparedExecOwner::Process {
            pid: 7,
            caller_tid: 9,
            generation: 11,
        };
        assert_eq!(process_owner.validate_process(7, 9, 11), Ok(()));
        assert_eq!(process_owner.validate_process(8, 9, 11), Err(Errno::ESRCH),);
        assert_eq!(
            process_owner.validate_process(7, 10, 11),
            Err(Errno::EINVAL),
        );
        assert_eq!(process_owner.validate_process(7, 9, 12), Err(Errno::EINVAL),);

        let spawn_owner = PreparedExecOwner::Spawn {
            parent_pid: 3,
            child_pid: 5,
            launch: 13,
        };
        assert_eq!(spawn_owner.validate_spawn(3, 5, 13), Ok(()));
        assert_eq!(spawn_owner.validate_spawn(3, 6, 13), Err(Errno::ESRCH),);
        assert_eq!(spawn_owner.validate_spawn(3, 5, 14), Err(Errno::EINVAL),);
    }
}
