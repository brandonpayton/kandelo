//! Wasm export layer -- FFI boundary that the TypeScript host calls.
//!
//! A single kernel instance manages all processes via `kernel_handle_channel`.
//! Process state lives in `PROCESS_TABLE`. User programs use channel IPC
//! (`channel_syscall.c`) instead of direct kernel imports. Fixed-size and
//! ownership-explicit `kernel_*` exports remain for host adapters and tests,
//! but variable-sized scalar/vector I/O is private to bounded channel or
//! tokenized transfer dispatch. All adapters resolve process state through
//! `PROCESS_TABLE`.
//!
//! This module declares:
//! 1. Host function imports (functions the host must provide).
//! 2. A `WasmHostIO` struct implementing the `HostIO` trait via those imports.
//! 3. Process-table backed kernel state.
//! 4. Export functions for syscall dispatch and process lifecycle.

extern crate alloc;

use alloc::vec::Vec;
use core::mem::{align_of, offset_of, size_of};
use core::slice;

use wasm_posix_shared::{
    abi::extended_syscalls as syscall_numbers,
    channel_scalar::{self, ChannelResultKind},
    platform_limits, process_snapshot_wire, Errno, KernelWaitResult, WasmDirent, WasmStat,
    WasmStatfs, WasmTimespec,
};

use crate::channel_result::{checked_mmap_byte_offset, ChannelDispatchOutcome};
use crate::channel_scratch::{
    checked_cstr_len, validate_channel_scratch_arguments, ChannelScratchRegion,
};
use crate::ofd::FileType;
use crate::process::{
    normalize_posix_timer_signo, HostAppendOutcome, HostIO, Process, ProcessState, StdioConfig,
    StdioKind,
};
use crate::process_snapshot_wire::{
    process_snapshot_record_bytes, write_process_snapshot_record, ProcessSnapshotHeader,
};
use crate::signal::{
    apply_default_signal_action_with_locks, deliver_pending_signals_for_tid_with_locks,
    deliver_pending_signals_with_locks, dequeue_signal_for, terminate_process_by_signal_with_locks,
    DefaultSignalOutcome,
};
use crate::socket_wire::validate_canonical_message_iov_len;
use crate::syscalls;

// ---------------------------------------------------------------------------
// 1. Host function imports
// ---------------------------------------------------------------------------

#[link(wasm_import_module = "env")]
unsafe extern "C" {
    fn host_debug_log(ptr: *const u8, len: u32);
    fn host_open(path_ptr: *const u8, path_len: u32, flags: u32, mode: u32) -> i64;
    fn host_close(handle: i64) -> i32;
    fn host_read(handle: i64, buf_ptr: *mut u8, buf_len: u32) -> i32;
    fn host_write(handle: i64, buf_ptr: *const u8, buf_len: u32) -> i32;
    fn host_append(
        handle: i64,
        buf_ptr: *const u8,
        buf_len: u32,
        limit_lo: u32,
        limit_hi: i32,
    ) -> i32;
    fn host_append_position(handle: i64, written: u32) -> i64;
    fn host_pread(
        handle: i64,
        buf_ptr: *mut u8,
        buf_len: u32,
        offset_lo: u32,
        offset_hi: i32,
    ) -> i32;
    fn host_pwrite(
        handle: i64,
        buf_ptr: *const u8,
        buf_len: u32,
        offset_lo: u32,
        offset_hi: i32,
    ) -> i32;
    fn host_seek(handle: i64, offset_lo: u32, offset_hi: i32, whence: u32) -> i64;
    fn host_fstat(handle: i64, stat_ptr: *mut u8) -> i32;
    fn host_stat(path_ptr: *const u8, path_len: u32, stat_ptr: *mut u8) -> i32;
    fn host_lstat(path_ptr: *const u8, path_len: u32, stat_ptr: *mut u8) -> i32;
    fn host_statfs(path_ptr: *const u8, path_len: u32, statfs_ptr: *mut u8) -> i32;
    fn host_fstatfs(handle: i64, statfs_ptr: *mut u8) -> i32;
    fn host_pathconf(path_ptr: *const u8, path_len: u32, name: i32, value_ptr: *mut i64) -> i32;
    fn host_fpathconf(handle: i64, name: i32, value_ptr: *mut i64) -> i32;
    fn host_mkdir(path_ptr: *const u8, path_len: u32, mode: u32) -> i32;
    fn host_rmdir(path_ptr: *const u8, path_len: u32) -> i32;
    fn host_unlink(path_ptr: *const u8, path_len: u32) -> i32;
    fn host_rename(old_ptr: *const u8, old_len: u32, new_ptr: *const u8, new_len: u32) -> i32;
    fn host_link(old_ptr: *const u8, old_len: u32, new_ptr: *const u8, new_len: u32) -> i32;
    fn host_symlink(
        target_ptr: *const u8,
        target_len: u32,
        link_ptr: *const u8,
        link_len: u32,
    ) -> i32;
    fn host_readlink(path_ptr: *const u8, path_len: u32, buf_ptr: *mut u8, buf_len: u32) -> i32;
    fn host_chmod(path_ptr: *const u8, path_len: u32, mode: u32) -> i32;
    fn host_chown(path_ptr: *const u8, path_len: u32, uid: u32, gid: u32) -> i32;
    fn host_lchown(path_ptr: *const u8, path_len: u32, uid: u32, gid: u32) -> i32;
    fn host_access(path_ptr: *const u8, path_len: u32, amode: u32) -> i32;
    fn host_opendir(path_ptr: *const u8, path_len: u32) -> i64;
    fn host_readdir(dir_handle: i64, dirent_ptr: *mut u8, name_ptr: *mut u8, name_len: u32) -> i32;
    fn host_closedir(dir_handle: i64) -> i32;
    fn host_clock_gettime(clock_id: u32, sec_ptr: *mut i64, nsec_ptr: *mut i64) -> i32;
    fn host_nanosleep(sec: i64, nsec: i64) -> i32;
    fn host_ftruncate(handle: i64, length: i64) -> i32;
    fn host_fsync(handle: i64) -> i32;
    fn host_fchmod(handle: i64, mode: u32) -> i32;
    fn host_fchown(handle: i64, uid: u32, gid: u32) -> i32;
    fn host_set_alarm(seconds: u32) -> i32;
    fn host_set_posix_timer(
        timer_id: i32,
        signo: i32,
        value_ms_lo: u32,
        value_ms_hi: u32,
        interval_ms_lo: u32,
        interval_ms_hi: u32,
    ) -> i32;
    fn host_sigsuspend_wait() -> i32;
    fn host_call_signal_handler(handler_index: u32, signum: u32, sa_flags: u32) -> i32;
    fn host_getrandom(buf_ptr: *mut u8, buf_len: u32) -> i32;
    fn host_utimensat(
        path_ptr: *const u8,
        path_len: u32,
        atime_sec: i64,
        atime_nsec: i64,
        mtime_sec: i64,
        mtime_nsec: i64,
    ) -> i32;
    fn host_waitpid(pid: i32, options: u32, status_ptr: *mut i32) -> i32;
    fn host_net_connect(handle: i32, addr_ptr: *const u8, addr_len: u32, port: u32) -> i32;
    fn host_net_connect_status(handle: i32) -> i32;
    fn host_net_send(handle: i32, buf_ptr: *const u8, buf_len: u32, flags: u32) -> i32;
    fn host_net_recv(handle: i32, buf_ptr: *mut u8, buf_len: u32, flags: u32) -> i32;
    fn host_net_poll(handle: i32, events: u32) -> i32;
    fn host_net_close(handle: i32) -> i32;
    fn host_net_listen(
        fd: i32,
        port: u32,
        addr_a: u32,
        addr_b: u32,
        addr_c: u32,
        addr_d: u32,
    ) -> i32;
    fn host_udp_bind(
        handle: i32,
        addr_a: u32,
        addr_b: u32,
        addr_c: u32,
        addr_d: u32,
        port: u32,
    ) -> i32;
    fn host_udp_unbind(handle: i32) -> i32;
    fn host_udp_send(
        src_a: u32,
        src_b: u32,
        src_c: u32,
        src_d: u32,
        src_port: u32,
        dst_a: u32,
        dst_b: u32,
        dst_c: u32,
        dst_d: u32,
        dst_port: u32,
        data_ptr: *const u8,
        data_len: u32,
    ) -> i32;
    fn host_getaddrinfo(
        name_ptr: *const u8,
        name_len: u32,
        result_ptr: *mut u8,
        result_len: u32,
    ) -> i32;
    fn host_futex_wait(addr: usize, expected: u32, timeout_ns_lo: u32, timeout_ns_hi: u32) -> i32;
    fn host_futex_wake(addr: usize, count: u32) -> i32;
    fn host_is_thread_worker() -> i32;
    fn host_bind_framebuffer(
        pid: i32,
        addr: usize,
        len: usize,
        w: u32,
        h: u32,
        stride: u32,
        fmt: u32,
    );
    fn host_unbind_framebuffer(pid: i32);
    fn host_fb_write(pid: i32, offset: usize, src: *const u8, len: usize);
    fn host_gbm_bo_create(
        pid: i32,
        bo_id: u32,
        size: u64,
        width: u32,
        height: u32,
        stride: u32,
    ) -> i32;
    fn host_gbm_bo_destroy(pid: i32, bo_id: u32);
    fn host_gbm_bo_bind(pid: i32, bo_id: u32, addr: usize, len: usize) -> i32;
    fn host_gbm_bo_unbind(pid: i32, bo_id: u32, addr: usize, len: usize);
    fn host_gl_bind(pid: i32, addr: usize, len: usize);
    fn host_gl_unbind(pid: i32);
    fn host_gl_create_context(pid: i32, ctx_id: u32, attrs_ptr: *const u8, attrs_len: usize);
    fn host_gl_destroy_context(pid: i32, ctx_id: u32);
    fn host_gl_create_surface(pid: i32, surface_id: u32, attrs_ptr: *const u8, attrs_len: usize);
    fn host_gl_destroy_surface(pid: i32, surface_id: u32);
    fn host_gl_make_current(pid: i32, ctx_id: u32, surface_id: u32);
    fn host_gl_submit(pid: i32, offset: usize, length: usize) -> i32;
    fn host_gl_present(pid: i32);
    fn host_gl_query(
        pid: i32,
        op: u32,
        in_ptr: *const u8,
        in_len: usize,
        out_ptr: *mut u8,
        out_len: usize,
    ) -> i32;
    fn host_kms_set_master(pid: i32);
    fn host_kms_drop_master(pid: i32);
    fn host_proc_write_bytes(pid: i32, addr: u32, src_ptr: *const u8, len: u32) -> i32;
    fn host_proc_read_bytes(pid: i32, addr: u32, dst_ptr: *mut u8, len: u32) -> i32;
    fn host_kms_mode_info(connector_id: u32, out_ptr: *mut u8);
    fn host_kms_addfb(
        pid: i32,
        fb_id: u32,
        bo_id: u32,
        width: u32,
        height: u32,
        pixel_format: u32,
        pitch: u32,
    ) -> i32;
    fn host_kms_rmfb(pid: i32, fb_id: u32);
    fn host_kms_set_fb(pid: i32, crtc_id: u32, fb_id: u32);
}

// ---------------------------------------------------------------------------
// 2. WasmHostIO -- bridges HostIO trait to the imported host functions
// ---------------------------------------------------------------------------

struct WasmHostIO;

/// Map a negative i32 return value from the host to an `Errno`.
/// Negative means error; the absolute value is the errno code.
fn i32_to_result(val: i32) -> Result<(), Errno> {
    if val < 0 {
        match Errno::from_u32(val.unsigned_abs()) {
            Some(e) => Err(e),
            None => Err(Errno::EIO),
        }
    } else {
        Ok(())
    }
}

fn checked_host_buffer_len(length: usize) -> Result<u32, Errno> {
    u32::try_from(length).map_err(|_| Errno::EOVERFLOW)
}

fn checked_host_transfer_result(result: i32, capacity: usize) -> Result<usize, Errno> {
    if result < 0 {
        return match Errno::from_u32(result.unsigned_abs()) {
            Some(error) => Err(error),
            None => Err(Errno::EIO),
        };
    }
    let transferred = result as usize;
    if transferred > capacity {
        return Err(Errno::EIO);
    }
    Ok(transferred)
}

fn checked_host_i64_result(result: i64) -> Result<i64, Errno> {
    if result >= 0 {
        return Ok(result);
    }
    let raw_errno = u32::try_from(result.unsigned_abs()).map_err(|_| Errno::EIO)?;
    match Errno::from_u32(raw_errno) {
        Some(error) => Err(error),
        None => Err(Errno::EIO),
    }
}

fn split_i64_words(value: i64) -> (u32, i32) {
    (value as u32, (value >> 32) as i32)
}

impl HostIO for WasmHostIO {
    fn host_open(&mut self, path: &[u8], flags: u32, mode: u32) -> Result<i64, Errno> {
        let result = unsafe { host_open(path.as_ptr(), path.len() as u32, flags, mode) };
        checked_host_i64_result(result)
    }

    fn host_close(&mut self, handle: i64) -> Result<(), Errno> {
        let result = unsafe { host_close(handle) };
        i32_to_result(result)
    }

    fn host_read(&mut self, handle: i64, buf: &mut [u8]) -> Result<usize, Errno> {
        let capacity = checked_host_buffer_len(buf.len())?;
        let result = unsafe { host_read(handle, buf.as_mut_ptr(), capacity) };
        checked_host_transfer_result(result, buf.len())
    }

    fn host_write(&mut self, handle: i64, buf: &[u8]) -> Result<usize, Errno> {
        let capacity = checked_host_buffer_len(buf.len())?;
        let result = unsafe { host_write(handle, buf.as_ptr(), capacity) };
        checked_host_transfer_result(result, buf.len())
    }

    fn host_append(
        &mut self,
        handle: i64,
        buf: &[u8],
        limit: Option<u64>,
    ) -> Result<HostAppendOutcome, Errno> {
        let capacity = checked_host_buffer_len(buf.len())?;
        // A finite u64 ceiling above signed off_t cannot constrain a
        // representable file position, so encode it as the unlimited sentinel.
        let encoded_limit = limit
            .and_then(|value| i64::try_from(value).ok())
            .unwrap_or(-1);
        let (limit_lo, limit_hi) = split_i64_words(encoded_limit);
        let result = unsafe { host_append(handle, buf.as_ptr(), capacity, limit_lo, limit_hi) };
        let written = checked_host_transfer_result(result, buf.len())?;
        let written_u32 = u32::try_from(written).map_err(|_| Errno::EIO)?;
        // WHY: the JavaScript host binds this scalar query to the immediately
        // preceding successful append by handle and count, then consumes it.
        // This avoids an additional host write into kernel Wasm memory.
        let end = unsafe { host_append_position(handle, written_u32) };
        let end = checked_host_i64_result(end)?;
        Ok(HostAppendOutcome {
            written,
            end: u64::try_from(end).map_err(|_| Errno::EIO)?,
        })
    }

    fn host_pread(&mut self, handle: i64, buf: &mut [u8], offset: i64) -> Result<usize, Errno> {
        let capacity = checked_host_buffer_len(buf.len())?;
        let (offset_lo, offset_hi) = split_i64_words(offset);
        let result =
            unsafe { host_pread(handle, buf.as_mut_ptr(), capacity, offset_lo, offset_hi) };
        checked_host_transfer_result(result, buf.len())
    }

    fn host_pwrite(&mut self, handle: i64, buf: &[u8], offset: i64) -> Result<usize, Errno> {
        let capacity = checked_host_buffer_len(buf.len())?;
        let (offset_lo, offset_hi) = split_i64_words(offset);
        let result = unsafe { host_pwrite(handle, buf.as_ptr(), capacity, offset_lo, offset_hi) };
        checked_host_transfer_result(result, buf.len())
    }

    fn host_seek(&mut self, handle: i64, offset: i64, whence: u32) -> Result<i64, Errno> {
        let (offset_lo, offset_hi) = split_i64_words(offset);
        let result = unsafe { host_seek(handle, offset_lo, offset_hi, whence) };
        checked_host_i64_result(result)
    }

    fn host_fstat(&mut self, handle: i64) -> Result<WasmStat, Errno> {
        let mut stat = WasmStat {
            st_dev: 0,
            st_ino: 0,
            st_mode: 0,
            st_nlink: 0,
            st_uid: 0,
            st_gid: 0,
            st_size: 0,
            st_atime_sec: 0,
            st_atime_nsec: 0,
            st_mtime_sec: 0,
            st_mtime_nsec: 0,
            st_ctime_sec: 0,
            st_ctime_nsec: 0,
            _pad: 0,
        };
        let stat_ptr = &mut stat as *mut WasmStat as *mut u8;
        let result = unsafe { host_fstat(handle, stat_ptr) };
        i32_to_result(result)?;
        Ok(stat)
    }

    fn host_stat(&mut self, path: &[u8]) -> Result<WasmStat, Errno> {
        let mut stat = WasmStat {
            st_dev: 0,
            st_ino: 0,
            st_mode: 0,
            st_nlink: 0,
            st_uid: 0,
            st_gid: 0,
            st_size: 0,
            st_atime_sec: 0,
            st_atime_nsec: 0,
            st_mtime_sec: 0,
            st_mtime_nsec: 0,
            st_ctime_sec: 0,
            st_ctime_nsec: 0,
            _pad: 0,
        };
        let stat_ptr = &mut stat as *mut WasmStat as *mut u8;
        let result = unsafe { host_stat(path.as_ptr(), path.len() as u32, stat_ptr) };
        i32_to_result(result)?;
        Ok(stat)
    }

    fn host_lstat(&mut self, path: &[u8]) -> Result<WasmStat, Errno> {
        let mut stat = WasmStat {
            st_dev: 0,
            st_ino: 0,
            st_mode: 0,
            st_nlink: 0,
            st_uid: 0,
            st_gid: 0,
            st_size: 0,
            st_atime_sec: 0,
            st_atime_nsec: 0,
            st_mtime_sec: 0,
            st_mtime_nsec: 0,
            st_ctime_sec: 0,
            st_ctime_nsec: 0,
            _pad: 0,
        };
        let stat_ptr = &mut stat as *mut WasmStat as *mut u8;
        let result = unsafe { host_lstat(path.as_ptr(), path.len() as u32, stat_ptr) };
        i32_to_result(result)?;
        Ok(stat)
    }

    fn host_statfs(&mut self, path: &[u8]) -> Result<WasmStatfs, Errno> {
        let mut statfs = WasmStatfs {
            f_type: 0,
            f_bsize: 0,
            f_blocks: 0,
            f_bfree: 0,
            f_bavail: 0,
            f_files: 0,
            f_ffree: 0,
            f_fsid: 0,
            f_namelen: 0,
            f_frsize: 0,
            f_flags: 0,
            _pad: 0,
        };
        let statfs_ptr = &mut statfs as *mut WasmStatfs as *mut u8;
        let result = unsafe { host_statfs(path.as_ptr(), path.len() as u32, statfs_ptr) };
        i32_to_result(result)?;
        Ok(statfs)
    }

    fn host_fstatfs(&mut self, handle: i64) -> Result<WasmStatfs, Errno> {
        let mut statfs = WasmStatfs {
            f_type: 0,
            f_bsize: 0,
            f_blocks: 0,
            f_bfree: 0,
            f_bavail: 0,
            f_files: 0,
            f_ffree: 0,
            f_fsid: 0,
            f_namelen: 0,
            f_frsize: 0,
            f_flags: 0,
            _pad: 0,
        };
        let statfs_ptr = &mut statfs as *mut WasmStatfs as *mut u8;
        let result = unsafe { host_fstatfs(handle, statfs_ptr) };
        i32_to_result(result)?;
        Ok(statfs)
    }

    fn host_pathconf(&mut self, path: &[u8], name: i32) -> Result<Option<i64>, Errno> {
        let mut value = -1i64;
        let result = unsafe {
            host_pathconf(
                path.as_ptr(),
                path.len() as u32,
                name,
                &mut value as *mut i64,
            )
        };
        i32_to_result(result)?;
        Ok((value != -1).then_some(value))
    }

    fn host_fpathconf(&mut self, handle: i64, name: i32) -> Result<Option<i64>, Errno> {
        let mut value = -1i64;
        let result = unsafe { host_fpathconf(handle, name, &mut value as *mut i64) };
        i32_to_result(result)?;
        Ok((value != -1).then_some(value))
    }

    fn host_mkdir(&mut self, path: &[u8], mode: u32) -> Result<(), Errno> {
        let result = unsafe { host_mkdir(path.as_ptr(), path.len() as u32, mode) };
        i32_to_result(result)
    }

    fn host_rmdir(&mut self, path: &[u8]) -> Result<(), Errno> {
        let result = unsafe { host_rmdir(path.as_ptr(), path.len() as u32) };
        i32_to_result(result)
    }

    fn host_unlink(&mut self, path: &[u8]) -> Result<(), Errno> {
        let result = unsafe { host_unlink(path.as_ptr(), path.len() as u32) };
        i32_to_result(result)
    }

    fn host_rename(&mut self, oldpath: &[u8], newpath: &[u8]) -> Result<(), Errno> {
        let result = unsafe {
            host_rename(
                oldpath.as_ptr(),
                oldpath.len() as u32,
                newpath.as_ptr(),
                newpath.len() as u32,
            )
        };
        i32_to_result(result)
    }

    fn host_link(&mut self, oldpath: &[u8], newpath: &[u8]) -> Result<(), Errno> {
        let result = unsafe {
            host_link(
                oldpath.as_ptr(),
                oldpath.len() as u32,
                newpath.as_ptr(),
                newpath.len() as u32,
            )
        };
        i32_to_result(result)
    }

    fn host_symlink(&mut self, target: &[u8], linkpath: &[u8]) -> Result<(), Errno> {
        let result = unsafe {
            host_symlink(
                target.as_ptr(),
                target.len() as u32,
                linkpath.as_ptr(),
                linkpath.len() as u32,
            )
        };
        i32_to_result(result)
    }

    fn host_readlink(&mut self, path: &[u8], buf: &mut [u8]) -> Result<usize, Errno> {
        let result = unsafe {
            host_readlink(
                path.as_ptr(),
                path.len() as u32,
                buf.as_mut_ptr(),
                buf.len() as u32,
            )
        };
        if result < 0 {
            match Errno::from_u32((-result) as u32) {
                Some(e) => Err(e),
                None => Err(Errno::EIO),
            }
        } else {
            Ok(result as usize)
        }
    }

    fn host_chmod(&mut self, path: &[u8], mode: u32) -> Result<(), Errno> {
        let result = unsafe { host_chmod(path.as_ptr(), path.len() as u32, mode) };
        i32_to_result(result)
    }

    fn host_chown(&mut self, path: &[u8], uid: u32, gid: u32) -> Result<(), Errno> {
        let result = unsafe { host_chown(path.as_ptr(), path.len() as u32, uid, gid) };
        i32_to_result(result)
    }

    fn host_lchown(&mut self, path: &[u8], uid: u32, gid: u32) -> Result<(), Errno> {
        let result = unsafe { host_lchown(path.as_ptr(), path.len() as u32, uid, gid) };
        i32_to_result(result)
    }

    fn host_access(&mut self, path: &[u8], amode: u32) -> Result<(), Errno> {
        let result = unsafe { host_access(path.as_ptr(), path.len() as u32, amode) };
        i32_to_result(result)
    }

    fn host_opendir(&mut self, path: &[u8]) -> Result<i64, Errno> {
        let result = unsafe { host_opendir(path.as_ptr(), path.len() as u32) };
        if result < 0 {
            match Errno::from_u32((-result) as u32) {
                Some(e) => Err(e),
                None => Err(Errno::EIO),
            }
        } else {
            Ok(result)
        }
    }

    fn host_readdir(
        &mut self,
        handle: i64,
        name_buf: &mut [u8],
    ) -> Result<Option<(u64, u32, usize)>, Errno> {
        let mut dirent = WasmDirent {
            d_ino: 0,
            d_type: 0,
            d_namlen: 0,
        };
        let dirent_ptr = &mut dirent as *mut WasmDirent as *mut u8;
        let result = unsafe {
            host_readdir(
                handle,
                dirent_ptr,
                name_buf.as_mut_ptr(),
                name_buf.len() as u32,
            )
        };
        if result < 0 {
            match Errno::from_u32((-result) as u32) {
                Some(e) => Err(e),
                None => Err(Errno::EIO),
            }
        } else if result == 0 {
            Ok(None)
        } else {
            Ok(Some((
                dirent.d_ino,
                dirent.d_type,
                dirent.d_namlen as usize,
            )))
        }
    }

    fn host_closedir(&mut self, handle: i64) -> Result<(), Errno> {
        let result = unsafe { host_closedir(handle) };
        i32_to_result(result)
    }

    fn host_clock_gettime(&mut self, clock_id: u32) -> Result<(i64, i64), Errno> {
        let mut sec: i64 = 0;
        let mut nsec: i64 = 0;
        let result =
            unsafe { host_clock_gettime(clock_id, &mut sec as *mut i64, &mut nsec as *mut i64) };
        i32_to_result(result)?;
        Ok((sec, nsec))
    }

    fn host_nanosleep(&mut self, seconds: i64, nanoseconds: i64) -> Result<(), Errno> {
        gkl_release();
        let result = unsafe { host_nanosleep(seconds, nanoseconds) };
        gkl_acquire();
        i32_to_result(result)
    }

    fn host_ftruncate(&mut self, handle: i64, length: i64) -> Result<(), Errno> {
        let result = unsafe { host_ftruncate(handle, length) };
        i32_to_result(result)
    }

    fn host_fsync(&mut self, handle: i64) -> Result<(), Errno> {
        let result = unsafe { host_fsync(handle) };
        i32_to_result(result)
    }

    fn host_fchmod(&mut self, handle: i64, mode: u32) -> Result<(), Errno> {
        let result = unsafe { host_fchmod(handle, mode) };
        i32_to_result(result)
    }

    fn host_fchown(&mut self, handle: i64, uid: u32, gid: u32) -> Result<(), Errno> {
        let result = unsafe { host_fchown(handle, uid, gid) };
        i32_to_result(result)
    }

    fn host_set_alarm(&mut self, seconds: u32) -> Result<(), Errno> {
        let result = unsafe { host_set_alarm(seconds) };
        i32_to_result(result)
    }

    fn host_set_posix_timer(
        &mut self,
        timer_id: i32,
        signo: i32,
        value_ms: i64,
        interval_ms: i64,
    ) -> Result<(), Errno> {
        let result = unsafe {
            host_set_posix_timer(
                timer_id,
                signo,
                value_ms as u32,
                (value_ms >> 32) as u32,
                interval_ms as u32,
                (interval_ms >> 32) as u32,
            )
        };
        i32_to_result(result)
    }

    fn host_sigsuspend_wait(&mut self) -> Result<u32, Errno> {
        gkl_release();
        let result = unsafe { host_sigsuspend_wait() };
        gkl_acquire();
        if result < 0 {
            Err(Errno::from_u32((-result) as u32).unwrap_or(Errno::EINTR))
        } else {
            Ok(result as u32)
        }
    }

    fn host_call_signal_handler(
        &mut self,
        handler_index: u32,
        signum: u32,
        sa_flags: u32,
    ) -> Result<(), Errno> {
        let result = unsafe { host_call_signal_handler(handler_index, signum, sa_flags) };
        i32_to_result(result)
    }

    fn host_getrandom(&mut self, buf: &mut [u8]) -> Result<usize, Errno> {
        let result = unsafe { host_getrandom(buf.as_mut_ptr(), buf.len() as u32) };
        if result < 0 {
            match Errno::from_u32((-result) as u32) {
                Some(e) => Err(e),
                None => Err(Errno::EIO),
            }
        } else {
            Ok(result as usize)
        }
    }

    fn host_utimensat(
        &mut self,
        path: &[u8],
        atime_sec: i64,
        atime_nsec: i64,
        mtime_sec: i64,
        mtime_nsec: i64,
    ) -> Result<(), Errno> {
        let result = unsafe {
            host_utimensat(
                path.as_ptr(),
                path.len() as u32,
                atime_sec,
                atime_nsec,
                mtime_sec,
                mtime_nsec,
            )
        };
        i32_to_result(result)
    }
    fn host_waitpid(&mut self, pid: i32, options: u32) -> Result<(i32, i32), Errno> {
        let mut status: i32 = 0;
        gkl_release();
        let result = unsafe { host_waitpid(pid, options, &mut status) };
        gkl_acquire();
        if result < 0 {
            match Errno::from_u32((-result) as u32) {
                Some(e) => Err(e),
                None => Err(Errno::EIO),
            }
        } else {
            Ok((result, status))
        }
    }

    fn host_net_connect(&mut self, handle: i32, addr: &[u8], port: u16) -> Result<(), Errno> {
        let result =
            unsafe { host_net_connect(handle, addr.as_ptr(), addr.len() as u32, port as u32) };
        i32_to_result(result)
    }

    fn host_net_connect_status(&mut self, handle: i32) -> Result<(), Errno> {
        let result = unsafe { host_net_connect_status(handle) };
        i32_to_result(result)
    }

    fn host_net_send(&mut self, handle: i32, data: &[u8], flags: u32) -> Result<usize, Errno> {
        let result = unsafe { host_net_send(handle, data.as_ptr(), data.len() as u32, flags) };
        if result < 0 {
            match Errno::from_u32((-result) as u32) {
                Some(e) => Err(e),
                None => Err(Errno::EIO),
            }
        } else {
            Ok(result as usize)
        }
    }

    fn host_net_recv(
        &mut self,
        handle: i32,
        _len: u32,
        flags: u32,
        buf: &mut [u8],
    ) -> Result<usize, Errno> {
        let result = unsafe { host_net_recv(handle, buf.as_mut_ptr(), buf.len() as u32, flags) };
        if result < 0 {
            match Errno::from_u32((-result) as u32) {
                Some(e) => Err(e),
                None => Err(Errno::EIO),
            }
        } else {
            Ok(result as usize)
        }
    }

    fn host_net_poll(&mut self, handle: i32, events: i16) -> Result<i16, Errno> {
        let result = unsafe { host_net_poll(handle, events as u32) };
        if result < 0 {
            match Errno::from_u32((-result) as u32) {
                Some(e) => Err(e),
                None => Err(Errno::EIO),
            }
        } else {
            Ok(result as i16)
        }
    }

    fn host_net_close(&mut self, handle: i32) -> Result<(), Errno> {
        let result = unsafe { host_net_close(handle) };
        i32_to_result(result)
    }

    fn host_net_listen(&mut self, fd: i32, port: u16, addr: &[u8; 4]) -> Result<(), Errno> {
        let result = unsafe {
            host_net_listen(
                fd,
                port as u32,
                addr[0] as u32,
                addr[1] as u32,
                addr[2] as u32,
                addr[3] as u32,
            )
        };
        i32_to_result(result)
    }

    fn host_udp_bind(&mut self, handle: i32, addr: &[u8; 4], port: u16) -> Result<(), Errno> {
        let result = unsafe {
            host_udp_bind(
                handle,
                addr[0] as u32,
                addr[1] as u32,
                addr[2] as u32,
                addr[3] as u32,
                port as u32,
            )
        };
        i32_to_result(result)
    }

    fn host_udp_unbind(&mut self, handle: i32) -> Result<(), Errno> {
        let result = unsafe { host_udp_unbind(handle) };
        i32_to_result(result)
    }

    fn host_udp_send(
        &mut self,
        src_addr: &[u8; 4],
        src_port: u16,
        dst_addr: &[u8; 4],
        dst_port: u16,
        data: &[u8],
    ) -> Result<usize, Errno> {
        let result = unsafe {
            host_udp_send(
                src_addr[0] as u32,
                src_addr[1] as u32,
                src_addr[2] as u32,
                src_addr[3] as u32,
                src_port as u32,
                dst_addr[0] as u32,
                dst_addr[1] as u32,
                dst_addr[2] as u32,
                dst_addr[3] as u32,
                dst_port as u32,
                data.as_ptr(),
                data.len() as u32,
            )
        };
        if result < 0 {
            match Errno::from_u32((-result) as u32) {
                Some(e) => Err(e),
                None => Err(Errno::EIO),
            }
        } else {
            Ok(result as usize)
        }
    }

    fn host_getaddrinfo(&mut self, name: &[u8], result_buf: &mut [u8]) -> Result<usize, Errno> {
        let result = unsafe {
            host_getaddrinfo(
                name.as_ptr(),
                name.len() as u32,
                result_buf.as_mut_ptr(),
                result_buf.len() as u32,
            )
        };
        if result < 0 {
            match Errno::from_u32((-result) as u32) {
                Some(e) => Err(e),
                None => Err(Errno::EIO),
            }
        } else {
            Ok(result as usize)
        }
    }

    fn host_futex_wait(
        &mut self,
        addr: usize,
        expected: u32,
        timeout_ns: i64,
    ) -> Result<i32, Errno> {
        let lo = timeout_ns as u32;
        let hi = (timeout_ns >> 32) as u32;
        // Release the GKL before blocking — otherwise no other thread can make
        // progress while this one waits.
        gkl_release();
        let result = unsafe { host_futex_wait(addr, expected, lo, hi) };
        gkl_acquire();
        if result < 0 {
            match Errno::from_u32((-result) as u32) {
                Some(e) => Err(e),
                None => Err(Errno::EIO),
            }
        } else {
            Ok(result)
        }
    }

    fn host_futex_wake(&mut self, addr: usize, count: u32) -> Result<i32, Errno> {
        let result = unsafe { host_futex_wake(addr, count) };
        if result < 0 {
            match Errno::from_u32((-result) as u32) {
                Some(e) => Err(e),
                None => Err(Errno::EIO),
            }
        } else {
            Ok(result)
        }
    }

    fn bind_framebuffer(
        &mut self,
        pid: i32,
        addr: usize,
        len: usize,
        w: u32,
        h: u32,
        stride: u32,
        fmt: u32,
    ) {
        unsafe { host_bind_framebuffer(pid, addr, len, w, h, stride, fmt) }
    }

    fn unbind_framebuffer(&mut self, pid: i32) {
        unsafe { host_unbind_framebuffer(pid) }
    }

    fn fb_write(&mut self, pid: i32, offset: usize, bytes: &[u8]) {
        unsafe { host_fb_write(pid, offset, bytes.as_ptr(), bytes.len()) }
    }

    fn gbm_bo_create(
        &mut self,
        pid: i32,
        bo_id: u32,
        size: u64,
        width: u32,
        height: u32,
        stride: u32,
    ) -> i32 {
        unsafe { host_gbm_bo_create(pid, bo_id, size, width, height, stride) }
    }

    fn gbm_bo_destroy(&mut self, pid: i32, bo_id: u32) {
        unsafe { host_gbm_bo_destroy(pid, bo_id) }
    }

    fn gbm_bo_bind(&mut self, pid: i32, bo_id: u32, addr: usize, len: usize) -> i32 {
        unsafe { host_gbm_bo_bind(pid, bo_id, addr, len) }
    }

    fn gbm_bo_unbind(&mut self, pid: i32, bo_id: u32, addr: usize, len: usize) {
        unsafe { host_gbm_bo_unbind(pid, bo_id, addr, len) }
    }

    fn gl_bind(&mut self, pid: i32, addr: usize, len: usize) {
        unsafe { host_gl_bind(pid, addr, len) }
    }

    fn gl_unbind(&mut self, pid: i32) {
        unsafe { host_gl_unbind(pid) }
    }

    fn gl_create_context(&mut self, pid: i32, ctx_id: u32, attrs: &[u8]) {
        unsafe { host_gl_create_context(pid, ctx_id, attrs.as_ptr(), attrs.len()) }
    }

    fn gl_destroy_context(&mut self, pid: i32, ctx_id: u32) {
        unsafe { host_gl_destroy_context(pid, ctx_id) }
    }

    fn gl_create_surface(&mut self, pid: i32, surface_id: u32, attrs: &[u8]) {
        unsafe { host_gl_create_surface(pid, surface_id, attrs.as_ptr(), attrs.len()) }
    }

    fn gl_destroy_surface(&mut self, pid: i32, surface_id: u32) {
        unsafe { host_gl_destroy_surface(pid, surface_id) }
    }

    fn gl_make_current(&mut self, pid: i32, ctx_id: u32, surface_id: u32) {
        unsafe { host_gl_make_current(pid, ctx_id, surface_id) }
    }

    fn gl_submit(&mut self, pid: i32, offset: usize, length: usize) -> i32 {
        unsafe { host_gl_submit(pid, offset, length) }
    }

    fn gl_present(&mut self, pid: i32) {
        unsafe { host_gl_present(pid) }
    }

    fn gl_query(&mut self, pid: i32, op: u32, input: &[u8], out: &mut [u8]) -> i32 {
        unsafe {
            host_gl_query(
                pid,
                op,
                input.as_ptr(),
                input.len(),
                out.as_mut_ptr(),
                out.len(),
            )
        }
    }

    fn kms_set_master(&mut self, pid: i32) {
        unsafe { host_kms_set_master(pid) }
    }

    fn kms_drop_master(&mut self, pid: i32) {
        unsafe { host_kms_drop_master(pid) }
    }

    fn proc_write_bytes(&mut self, pid: i32, addr: u32, src: &[u8]) -> i32 {
        unsafe { host_proc_write_bytes(pid, addr, src.as_ptr(), src.len() as u32) }
    }

    fn proc_read_bytes(&mut self, pid: i32, addr: u32, dst: &mut [u8]) -> i32 {
        unsafe { host_proc_read_bytes(pid, addr, dst.as_mut_ptr(), dst.len() as u32) }
    }

    fn kms_mode_info(&mut self, connector_id: u32) -> wasm_posix_shared::dri::WpkDrmModeModeinfo {
        let mut info = wasm_posix_shared::dri::WpkDrmModeModeinfo::default();
        unsafe { host_kms_mode_info(connector_id, &mut info as *mut _ as *mut u8) }
        info
    }

    fn kms_addfb(
        &mut self,
        pid: i32,
        fb_id: u32,
        bo_id: u32,
        width: u32,
        height: u32,
        pixel_format: u32,
        pitch: u32,
    ) -> i32 {
        unsafe { host_kms_addfb(pid, fb_id, bo_id, width, height, pixel_format, pitch) }
    }

    fn kms_rmfb(&mut self, pid: i32, fb_id: u32) {
        unsafe { host_kms_rmfb(pid, fb_id) }
    }

    fn kms_set_fb(&mut self, pid: i32, crtc_id: u32, fb_id: u32) {
        unsafe { host_kms_set_fb(pid, crtc_id, fb_id) }
    }
}

// ---------------------------------------------------------------------------
// 3. Global kernel state
// ---------------------------------------------------------------------------

// The kernel's process table lives in `process_table.rs` so that non-export
// modules can reach it. Aliased here for brevity.
use crate::process_table::GLOBAL_PROCESS_TABLE as PROCESS_TABLE;

// ---------------------------------------------------------------------------
// 3a. Compatibility guard
// ---------------------------------------------------------------------------

/// Legacy direct exports still use a guard-shaped value so older wrapper code
/// can keep the same control flow. Kernel execution is serialized by the host,
/// so acquiring or dropping the guard does not take a secondary lock.
fn gkl_acquire() {}

fn gkl_release() {}

/// RAII guard retained for direct-export compatibility.
struct GklGuard;

impl GklGuard {
    fn acquire() -> Self {
        gkl_acquire();
        GklGuard
    }
}

impl Drop for GklGuard {
    fn drop(&mut self) {
        gkl_release();
    }
}

/// Get a mutable reference to the current process.
///
/// SAFETY: Must only be called from kernel export functions.
#[inline]
unsafe fn get_process() -> (GklGuard, &'static mut Process) {
    let guard = GklGuard::acquire();
    let table = unsafe { &mut *PROCESS_TABLE.0.get() };
    match table.current_process() {
        Some(p) => (guard, p),
        #[cfg(any(target_arch = "wasm32", target_arch = "wasm64"))]
        None => core::hint::unreachable_unchecked(),
        #[cfg(not(any(target_arch = "wasm32", target_arch = "wasm64")))]
        None => panic!("no current process in table"),
    }
}

/// Get disjoint mutable references to the current process and the
/// machine-wide advisory-lock manager under the kernel lock.
///
/// SAFETY: Must only be called from kernel export functions.
#[inline]
unsafe fn get_process_and_advisory_locks() -> (
    GklGuard,
    &'static mut Process,
    &'static mut crate::lock::AdvisoryLockManager,
) {
    let guard = GklGuard::acquire();
    let table = unsafe { &mut *PROCESS_TABLE.0.get() };
    match table.current_process_and_advisory_locks() {
        Some((process, locks)) => (guard, process, locks),
        #[cfg(any(target_arch = "wasm32", target_arch = "wasm64"))]
        None => unsafe { core::hint::unreachable_unchecked() },
        #[cfg(not(any(target_arch = "wasm32", target_arch = "wasm64")))]
        None => panic!("no current process in table"),
    }
}

/// Get the current TID and its disjoint process/lock references from one
/// process-table borrow.
///
/// WHY: obtaining `&mut Process` and then calling the global `current_tid()`
/// helper would reborrow the ProcessTable that owns that live reference.
#[inline]
unsafe fn get_process_tid_and_advisory_locks() -> (
    GklGuard,
    u32,
    &'static mut Process,
    &'static mut crate::lock::AdvisoryLockManager,
) {
    let guard = GklGuard::acquire();
    let table = unsafe { &mut *PROCESS_TABLE.0.get() };
    let tid = table.current_tid();
    match table.current_process_and_advisory_locks() {
        Some((process, locks)) => (guard, tid, process, locks),
        #[cfg(any(target_arch = "wasm32", target_arch = "wasm64"))]
        None => unsafe { core::hint::unreachable_unchecked() },
        #[cfg(not(any(target_arch = "wasm32", target_arch = "wasm64")))]
        None => panic!("no current process in table"),
    }
}

/// Finish machine-wide SCM_RIGHTS releases, if any, at an exported operation
/// boundary.
///
/// The caller must end every pipe-table borrow before entering this helper:
/// cleanup can release nested pipe references and invoke host close callbacks.
/// The pending check keeps ordinary channel dispatches and host-TCP pipe
/// operations to one empty-queue branch and avoids walking an empty release
/// queue.
fn finish_machine_scm_rights_cleanup_if_pending() {
    syscalls::finish_scm_rights_cleanup_if_pending(|| {
        let _gkl = GklGuard::acquire();
        let table = unsafe { &mut *PROCESS_TABLE.0.get() };
        let mut host = WasmHostIO;
        syscalls::finish_scm_rights_cleanup(table.advisory_locks_mut(), &mut host);
    });
}

fn current_pid_eids() -> (u32, u32, u32) {
    let table = unsafe { &*PROCESS_TABLE.0.get() };
    let pid = table.current_pid();
    match table.get(pid) {
        Some(p) => (pid, p.effective_uid(), p.effective_gid()),
        None => (pid, 0, 0),
    }
}

// ---------------------------------------------------------------------------
// 3b. Memory growth helper
// ---------------------------------------------------------------------------

/// Grow Wasm memory if `end_addr` exceeds the current memory size.
/// Wasm pages are 64KB each. Returns true if memory was sufficient or grown.
#[cfg(target_arch = "wasm32")]
fn ensure_memory_covers(end_addr: usize) {
    let current_pages = core::arch::wasm32::memory_size(0);
    let current_bytes = current_pages * 65536;
    if end_addr > current_bytes {
        let needed_pages = (end_addr - current_bytes + 65535) / 65536;
        core::arch::wasm32::memory_grow(0, needed_pages);
    }
}

#[cfg(target_arch = "wasm64")]
fn ensure_memory_covers(end_addr: usize) {
    let current_pages = core::arch::wasm64::memory_size(0);
    let current_bytes = current_pages * 65536;
    if end_addr > current_bytes {
        let needed_pages = (end_addr - current_bytes + 65535) / 65536;
        core::arch::wasm64::memory_grow(0, needed_pages);
    }
}

#[cfg(not(any(target_arch = "wasm32", target_arch = "wasm64")))]
fn ensure_memory_covers(_end_addr: usize) {
    // No-op on non-Wasm targets (tests)
}

// 3c. Signal delivery at syscall boundaries
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 4. Exported kernel functions
// ---------------------------------------------------------------------------

/// Kernel's ABI version. The host reads this at instantiation and
/// compares against each user program's `__abi_version` export;
/// mismatches are refused. Mirrors [`wasm_posix_shared::ABI_VERSION`].
#[unsafe(no_mangle)]
pub extern "C" fn __abi_version() -> u32 {
    wasm_posix_shared::ABI_VERSION
}

/// Pointer to the Rust-owned host adapter manifest in kernel Wasm memory.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_host_adapter_manifest_ptr() -> usize {
    &wasm_posix_shared::abi::HOST_ADAPTER_MANIFEST as *const _ as usize
}

/// Size in bytes of the Rust-owned host adapter manifest.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_host_adapter_manifest_len() -> u32 {
    core::mem::size_of::<wasm_posix_shared::abi::HostAdapterManifest>() as u32
}

/// Allocate a scratch buffer from the kernel's own heap allocator.
/// Returns the offset in kernel Wasm memory. The caller must ensure
/// the buffer is not freed (it lives for the lifetime of the kernel).
/// This is critical: the host must NOT use memory.grow() for scratch
/// space, as the kernel's allocator would then treat those grown pages
/// as available heap, leading to overlapping writes and corruption.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_alloc_scratch(size: u32) -> usize {
    extern crate alloc;
    let Some(layout) = crate::scratch_alloc::layout(size as usize) else {
        return 0;
    };
    let ptr = unsafe { alloc::alloc::alloc_zeroed(layout) };
    if ptr.is_null() {
        return 0;
    }
    ptr as usize
}

/// Begin one exclusive initialized reservation for a large I/O payload.
///
/// Returns a positive opaque token on success or a negated errno on failure.
/// The host must query pointer and capacity while the token is Reserved, then
/// either execute it once or cancel it.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_transfer_scratch_begin(minimum_capacity: usize) -> i64 {
    match crate::transfer::begin_transfer_scratch(minimum_capacity) {
        Ok(token) => token,
        Err(error) => -(error as i64),
    }
}

/// Pointer owned by exactly the Reserved large-I/O token, or zero otherwise.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_transfer_scratch_pointer(token: i64) -> usize {
    crate::transfer::transfer_scratch_pointer(token).unwrap_or(0)
}

/// Initialized writable capacity owned by exactly the Reserved large-I/O
/// token, or zero otherwise.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_transfer_scratch_capacity(token: i64) -> usize {
    crate::transfer::transfer_scratch_capacity(token).unwrap_or(0)
}

/// Drop the allocation owned by exactly the Reserved or Ready token.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_transfer_scratch_cancel(token: i64) -> i32 {
    match crate::transfer::cancel_transfer_scratch(token) {
        Ok(()) => 0,
        Err(error) => -(error as i32),
    }
}

/// Begin one exclusive host-write reservation for a complete SYS_SPAWN blob.
///
/// Returns a positive opaque token on success or a negated errno on failure.
/// The host must read the pointer and capacity after this call, then either
/// consume the token with `kernel_spawn_reserved_process` or cancel it.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_spawn_scratch_begin(minimum_capacity: usize) -> i64 {
    match crate::spawn::begin_spawn_scratch(minimum_capacity) {
        Ok(token) => token,
        Err(error) => -(error as i64),
    }
}

/// Pointer owned by exactly the SYS_SPAWN reservation named by `token`, or
/// zero for a stale token or if a reentrant query cannot acquire the mutex.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_spawn_scratch_pointer(token: i64) -> usize {
    crate::spawn::spawn_scratch_pointer(token).unwrap_or(0)
}

/// Writable byte capacity of exactly the SYS_SPAWN reservation named by
/// `token`, or zero for a stale token or lock contention.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_spawn_scratch_capacity(token: i64) -> usize {
    crate::spawn::spawn_scratch_capacity(token).unwrap_or(0)
}

/// Retained allocation capacity for diagnostics. This export reveals no
/// pointer and grants no authority to modify an active reservation.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_spawn_scratch_retained_capacity() -> usize {
    crate::spawn::spawn_scratch_retained_capacity().unwrap_or(0)
}

/// Cancel exactly the current SYS_SPAWN reservation.
///
/// Cancellation waits for the reservation mutex instead of returning a
/// transient EBUSY. The guarded Rust path performs no host imports, so the
/// matching token cannot be stranded by contention.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_spawn_scratch_cancel(token: i64) -> i32 {
    match crate::spawn::cancel_spawn_scratch(token) {
        Ok(()) => 0,
        Err(error) => -(error as i32),
    }
}

/// Read the approximate Wasm stack pointer for debugging.
/// Returns the address of a stack variable, which is close to the current SP.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_get_stack_pointer() -> usize {
    let sentinel: u32 = 0xDEAD;
    &sentinel as *const u32 as usize
}

/// Return the current Wasm memory size in pages using the `memory.size` instruction.
/// This is the true internal page count — may differ from what JS reports for shared memory.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_get_memory_pages() -> u32 {
    #[cfg(target_arch = "wasm32")]
    {
        core::arch::wasm32::memory_size(0) as u32
    }
    #[cfg(target_arch = "wasm64")]
    {
        core::arch::wasm64::memory_size(0) as u32
    }
    #[cfg(not(any(target_arch = "wasm32", target_arch = "wasm64")))]
    {
        0
    }
}

/// Create a new process in the process table with captured pipe stdio.
/// Returns the kernel-allocated pid on success or a negative errno.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_create_process() -> i32 {
    let table = unsafe { &mut *PROCESS_TABLE.0.get() };
    match table.create_process() {
        Ok(pid) => pid as i32,
        Err(e) => -(e as i32),
    }
}

/// Create a new process with explicit stdio wiring.
///
/// Stdio kind values are per-fd:
/// - 0: host-backed pipe semantics (`isatty` false, FIFO stat mode)
/// - 1: host-backed terminal/char-device semantics
///
/// Returns the kernel-allocated pid on success, -EINVAL for an unknown stdio
/// kind, or another negative errno on allocation failure.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_create_process_with_stdio(
    stdin_kind: u32,
    stdout_kind: u32,
    stderr_kind: u32,
) -> i32 {
    let stdio = match (
        StdioKind::from_abi(stdin_kind),
        StdioKind::from_abi(stdout_kind),
        StdioKind::from_abi(stderr_kind),
    ) {
        (Some(stdin), Some(stdout), Some(stderr)) => StdioConfig {
            stdin,
            stdout,
            stderr,
        },
        _ => return -(Errno::EINVAL as i32),
    };

    let table = unsafe { &mut *PROCESS_TABLE.0.get() };
    match table.create_process_with_stdio(stdio) {
        Ok(pid) => pid as i32,
        Err(e) => -(e as i32),
    }
}

/// Set the program's initial brk to the value of its `__heap_base` export.
/// Called by the host once per process — between process creation
/// (or post-exec re-init) and the first syscall from the new program — so
/// `brk(0)` returns a value above the program's data section and stack
/// region. Returns 0 on success, -ESRCH if pid not found.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_set_brk_base(pid: u32, addr: usize) -> i32 {
    let table = unsafe { &mut *PROCESS_TABLE.0.get() };
    if let Some(proc) = table.get_mut(pid) {
        proc.memory.set_brk_base(addr);
        0
    } else {
        -(Errno::ESRCH as i32)
    }
}

/// Set the mmap address space upper bound for a process.
/// Used to prevent mmap from overlapping the channel region.
/// Returns 0 on success, -ESRCH if pid not found.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_set_max_addr(pid: u32, max_addr: usize) -> i32 {
    let table = unsafe { &mut *PROCESS_TABLE.0.get() };
    if let Some(proc) = table.get_mut(pid) {
        proc.memory.set_max_addr(max_addr);
        0
    } else {
        -(Errno::ESRCH as i32)
    }
}

/// Set the mmap lower bound for a process.
/// Compact hosts use this to place automatic mmap allocations immediately
/// after the process's reserved low prefix instead of at the legacy 64MB
/// boundary. Returns 0 on success, -ESRCH if pid not found.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_set_mmap_base(pid: u32, mmap_base: usize) -> i32 {
    let table = unsafe { &mut *PROCESS_TABLE.0.get() };
    if let Some(proc) = table.get_mut(pid) {
        proc.memory.set_mmap_base(mmap_base);
        0
    } else {
        -(Errno::ESRCH as i32)
    }
}

/// Set the brk address space upper bound for a process.
/// Used to prevent brk from overlapping low host control pages.
/// Returns 0 on success, -ESRCH if pid not found.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_set_brk_limit(pid: u32, brk_limit: usize) -> i32 {
    let table = unsafe { &mut *PROCESS_TABLE.0.get() };
    if let Some(proc) = table.get_mut(pid) {
        proc.memory.set_brk_limit(brk_limit);
        0
    } else {
        -(Errno::ESRCH as i32)
    }
}

/// Reserve a host-owned dynamic control range in a process address space.
/// Returns the byte address on success, or MAP_FAILED if the pid is missing
/// or no suitably sized gap exists. The returned range is not a guest mmap
/// mapping and cannot be released by munmap.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_reserve_host_region(pid: u32, len: usize) -> usize {
    let table = unsafe { &mut *PROCESS_TABLE.0.get() };
    if let Some(proc) = table.get_mut(pid) {
        proc.memory.reserve_host_region(len)
    } else {
        wasm_posix_shared::mmap::MAP_FAILED
    }
}

/// Reserve a host-owned dynamic control range at an exact address.
/// Used by fork-from-pthread children to retain only the calling thread's
/// copied TLS/fork-save/channel slot. Returns the byte address on success,
/// or MAP_FAILED if the pid is missing or the range collides with guest
/// brk/mmap state.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_reserve_host_region_at(pid: u32, addr: usize, len: usize) -> usize {
    let table = unsafe { &mut *PROCESS_TABLE.0.get() };
    if let Some(proc) = table.get_mut(pid) {
        proc.memory.reserve_host_region_at(addr, len)
    } else {
        wasm_posix_shared::mmap::MAP_FAILED
    }
}

/// Set the working directory for a process.
/// Called by host to set the initial cwd before the process starts.
/// Returns 0 on success or a negative errno if the process/path is invalid.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_set_cwd(pid: u32, path_ptr: *const u8, path_len: u32) -> i32 {
    let table = unsafe { &mut *PROCESS_TABLE.0.get() };
    if let Some(proc) = table.get_mut(pid) {
        let path = unsafe { core::slice::from_raw_parts(path_ptr, path_len as usize) };
        let mut host = WasmHostIO;
        match syscalls::sys_chdir(proc, &mut host, path) {
            Ok(()) => 0,
            Err(error) => -(error as i32),
        }
    } else {
        -(Errno::ESRCH as i32)
    }
}

/// Set a process's initial real/effective uid and gid.
/// The host calls this after creating the process but before user code starts.
/// Pass `u32::MAX` for either uid or gid to leave that side unchanged.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_set_process_credentials(pid: u32, uid: u32, gid: u32) -> i32 {
    let table = unsafe { &mut *PROCESS_TABLE.0.get() };
    if let Some(proc) = table.get_mut(pid) {
        proc.configure_ids(
            (uid != u32::MAX).then_some(uid),
            (gid != u32::MAX).then_some(gid),
        );
        0
    } else {
        -(Errno::ESRCH as i32)
    }
}

/// Return the sticky secure-execution marker for one committed process image.
///
/// The host queries this only after the kernel has committed the exact exec
/// target (or after creating/copying an initial/fork process record).  The
/// value is kernel-owned: launch paths must not reconstruct it from ids,
/// paths, argv, environment, or host configuration.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_process_secure_exec(pid: u32) -> i32 {
    let table = unsafe { &*PROCESS_TABLE.0.get() };
    match table.get(pid) {
        Some(proc) => i32::from(proc.secure_exec),
        None => -(Errno::ESRCH as i32),
    }
}

/// Begin one Rust-owned argv/environment replacement.
///
/// The returned positive token owns two initially empty staging vectors. The
/// live Process remains unchanged until one matching commit replaces both.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_process_metadata_begin(pid: u32) -> i32 {
    let table = unsafe { &mut *PROCESS_TABLE.0.get() };
    let Some(proc) = table.get_mut(pid) else {
        return -(Errno::ESRCH as i32);
    };
    match proc.begin_metadata_replacement() {
        Ok(token) => token as i32,
        Err(e) => -(e as i32),
    }
}

/// Stage one argv or environment entry from the host's bounded scratch lease.
///
/// Rust copies the complete entry before returning. Empty entries are
/// preserved; a failed stage permanently makes this token uncommittable.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_process_metadata_stage(
    pid: u32,
    token: u32,
    kind: u32,
    data_ptr: *const u8,
    data_len: u32,
) -> i32 {
    let table = unsafe { &mut *PROCESS_TABLE.0.get() };
    let Some(proc) = table.get_mut(pid) else {
        return -(Errno::ESRCH as i32);
    };
    let data = unsafe { core::slice::from_raw_parts(data_ptr, data_len as usize) };
    match proc.stage_metadata_entry(token, kind, data) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    }
}

/// Atomically publish both vectors owned by the matching transaction.
///
/// All entry allocations completed during staging. Commit performs no host
/// import and no fallible allocation between the argv and environment swaps.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_process_metadata_commit(pid: u32, token: u32) -> i32 {
    let table = unsafe { &mut *PROCESS_TABLE.0.get() };
    let Some(proc) = table.get_mut(pid) else {
        return -(Errno::ESRCH as i32);
    };
    match proc.commit_metadata_replacement(token) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    }
}

/// Drop one uncommitted replacement without changing live process metadata.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_process_metadata_cancel(pid: u32, token: u32) -> i32 {
    let table = unsafe { &mut *PROCESS_TABLE.0.get() };
    let Some(proc) = table.get_mut(pid) else {
        return -(Errno::ESRCH as i32);
    };
    match proc.cancel_metadata_replacement(token) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    }
}

fn finish_removed_process(pid: u32, result: crate::process_table::RemoveProcessResult) {
    use core::sync::atomic::Ordering;

    // A process removed without reaching sys_exit (worker crash or explicit
    // host termination) can still own host-side VFS handles. Close directory
    // iterators before their backing file handles,
    // matching sys_close/process-exit ordering. Normal exited zombies already
    // have empty OFD and directory-stream tables, so reaping is a no-op here.
    for dir_handle in result.host_dir_closes {
        unsafe { host_closedir(dir_handle) };
    }
    for handle in result.host_closes {
        unsafe { host_close(handle) };
    }
    // /dev/fb0 cleanup: if the exiting process held a live mmap, tell the host
    // to drop the canvas binding before the process Memory disappears. Then
    // release the global owner claim — best-effort CAS makes this idempotent.
    if result.had_framebuffer_binding {
        unsafe { host_unbind_framebuffer(pid as i32) };
    }
    let _ = crate::process_table::FB0_OWNER.compare_exchange(
        pid as i32,
        -1,
        Ordering::SeqCst,
        Ordering::SeqCst,
    );
    // Tear down host-side AF_INET handles whose cross-process refcount hit zero
    // during teardown. process_table.rs can't call host externs directly; we
    // drain its close-list here.
    for net_handle in result.host_net_closes {
        unsafe { host_net_close(net_handle) };
    }
    // /dev/input/mice cleanup: drop ownership and any pending packets so a
    // successor open starts clean. No host-side unbind — the device is
    // host→kernel only.
    crate::syscalls::maybe_release_mice(pid);
}

fn remove_process_and_cleanup(pid: u32) -> i32 {
    let table = unsafe { &mut *PROCESS_TABLE.0.get() };
    match table.remove_process(pid) {
        Some(result) => {
            finish_removed_process(pid, result);
            0
        }
        None => -(Errno::ESRCH as i32),
    }
}

fn reap_process_and_cleanup(pid: u32) -> i32 {
    let table = unsafe { &mut *PROCESS_TABLE.0.get() };
    match table.reap_process(pid) {
        Some(result) => {
            finish_removed_process(pid, result);
            0
        }
        None => -(Errno::ESRCH as i32),
    }
}

/// Remove a process from the process table.
/// Returns 0 on success, -ESRCH if pid not found.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_remove_process(pid: u32) -> i32 {
    remove_process_and_cleanup(pid)
}

/// Reap a wait-consumed process from the process table.
/// Reaped process-group leaders are retained as limbo records while group
/// members remain, so getpgid/setpgid can still resolve the leader.
/// Returns 0 on success, -ESRCH if pid not found.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_reap_process(pid: u32) -> i32 {
    reap_process_and_cleanup(pid)
}

/// Fork a process in the process table on behalf of a validated parent task.
/// Clones parent's Process state under a kernel-allocated child pid and
/// preserves the calling task's signal mask in the child.
///
/// Both modes inherit the same kernel-owned process state. The distinction is
/// carried explicitly because the host memory/lifetime transaction differs:
/// ordinary fork owns a memory clone, while genuine vfork will borrow the
/// parent's memory and suspend only its calling thread until exec or exit.
/// Returns the child pid on success, negative errno on error.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_fork_process(parent_pid: u32, caller_tid: u32, mode: u32) -> i32 {
    let Some(mode) = wasm_posix_shared::fork_contract::Mode::from_u32(mode) else {
        return -(Errno::EINVAL as i32);
    };
    let table = unsafe { &mut *PROCESS_TABLE.0.get() };
    match table.fork_process_for_caller_with_mode(parent_pid, caller_tid, mode) {
        Ok(child_pid) => child_pid as i32,
        Err(e) => -(e as i32),
    }
}

/// Non-forking `posix_spawn`. Parses the SYS_SPAWN
/// blob (already copied from caller memory into the kernel's address
/// space by the host), allocates a child pid, builds the child Process
/// with attrs and file actions applied, and inserts it into the
/// `ProcessTable`.
///
/// Returns the allocated child pid on success (positive), or a negated
/// errno on failure. The host (`handleSpawn` in `kernel-worker.ts`) is
/// responsible for actually launching the new process worker after this
/// call returns success — see Task 11.
///
/// SAFETY: this ordinary-size entry point is only for the host's checked
/// channel-scratch lease. The caller must prove independently that `blob_ptr`
/// names that kernel-owned allocation, `blob_len` is within its explicit
/// capacity, the complete range is inside current kernel linear memory, and no
/// reentrant operation can replace the bytes for the duration of this call.
/// Merely fitting somewhere in total linear memory is not sufficient. Larger
/// blobs must use the tokenized reservation entry point below.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_spawn_process(
    parent_pid: u32,
    caller_tid: u32,
    blob_ptr: usize,
    blob_len: usize,
) -> i32 {
    if blob_len == 0 {
        return -(Errno::EINVAL as i32);
    }
    if blob_len > wasm_posix_shared::channel::MIN_CHANNEL_SIZE {
        return -(Errno::E2BIG as i32);
    }
    if blob_ptr == 0 || blob_ptr.checked_add(blob_len).is_none() {
        return -(Errno::EFAULT as i32);
    }
    let bytes = unsafe { core::slice::from_raw_parts(blob_ptr as *const u8, blob_len) };
    let parsed = match crate::spawn::parse_blob(bytes) {
        Ok(p) => p,
        Err(e) => return -(e as i32),
    };
    spawn_parsed_for_caller(parent_pid, caller_tid, parsed)
}

/// Consume one tokenized kernel-owned SYS_SPAWN reservation.
///
/// Unlike `kernel_spawn_process`, this entry point never accepts a host-chosen
/// pointer. The reservation validates its token and byte count, parses into an
/// owned representation, restores its Idle state even on malformed input, and
/// releases its mutex before this function enters the process table. Commit
/// waits through mutex contention; no host import occurs while that lock is
/// held, so every matching token is consumed before this export returns.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_spawn_reserved_process(
    parent_pid: u32,
    caller_tid: u32,
    token: i64,
    blob_len: usize,
) -> i32 {
    let parsed = match crate::spawn::parse_reserved_spawn_blob(token, blob_len) {
        Ok(parsed) => parsed,
        Err(error) => return -(error as i32),
    };
    spawn_parsed_for_caller(parent_pid, caller_tid, parsed)
}

/// Publish one fully launched `posix_spawn` child to its exact parent.
///
/// `-1` is the live-child sentinel, `0` identifies a normal zombie, a
/// positive result is the terminating signal, and other negative values are
/// negated errnos. Keeping publication in Rust makes wait selection/reaping
/// atomic with the state transition instead of trusting a host shadow.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_publish_spawn_child(parent_pid: u32, child_pid: u32) -> i32 {
    let table = unsafe { &mut *PROCESS_TABLE.0.get() };
    match table.publish_spawn_child(parent_pid, child_pid) {
        Ok(disposition) => disposition,
        Err(error) => -(error as i32),
    }
}

fn spawn_parsed_for_caller(
    parent_pid: u32,
    caller_tid: u32,
    parsed: crate::spawn::ParsedBlob,
) -> i32 {
    // Borrow argv/envp as &[&[u8]] for the spawn_child API.
    let argv_refs: alloc::vec::Vec<&[u8]> = parsed.argv.iter().map(|v| v.as_slice()).collect();
    let envp_refs: alloc::vec::Vec<&[u8]> = parsed.envp.iter().map(|v| v.as_slice()).collect();

    // The kernel-worker dispatch path that landed us here calls into
    // ProcessTable; reuse the global instance. spawn_child's host trait
    // parameter dispatches file-action-time host I/O (sys_open / sys_chdir
    // / etc) — host imports defined at the top of this module.
    let table = unsafe { &mut *PROCESS_TABLE.0.get() };
    let mut host = WasmHostIO;
    match table.spawn_child_for_caller(
        parent_pid,
        caller_tid,
        &argv_refs,
        &envp_refs,
        &parsed.file_actions,
        &parsed.attrs,
        &mut host,
    ) {
        Ok(child_pid) => child_pid as i32,
        Err(e) => -(e as i32),
    }
}

/// Returns the per-process fork counter (parent side, incremented on
/// successful fork). Used by the non-forking spawn test suite as a
/// regression guardrail. Returns `u64::MAX` as a sentinel if the pid
/// does not exist (so callers can distinguish "no process" from
/// "0 forks").
#[unsafe(no_mangle)]
pub extern "C" fn kernel_get_fork_count(pid: u32) -> u64 {
    let table = unsafe { &*PROCESS_TABLE.0.get() };
    match table.get(pid) {
        Some(proc) => proc.fork_count(),
        None => u64::MAX,
    }
}

/// Check if a process is a fork child.
/// Returns 1 if fork child, 0 otherwise, -ESRCH if not found.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_is_fork_child_pid(pid: u32) -> i32 {
    let table = unsafe { &mut *PROCESS_TABLE.0.get() };
    match table.get(pid) {
        Some(proc) => {
            if proc.fork_child {
                1
            } else {
                0
            }
        }
        None => -(Errno::ESRCH as i32),
    }
}

/// Clear the fork_child flag for a process.
/// Called by the host after returning 0 to a fork child's SYS_FORK call.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_clear_fork_child(pid: u32) -> i32 {
    let table = unsafe { &mut *PROCESS_TABLE.0.get() };
    match table.get_mut(pid) {
        Some(proc) => {
            proc.fork_child = false;
            0
        }
        None => -(Errno::ESRCH as i32),
    }
}

/// Get the shell-style process exit status used by the host lifecycle scan.
/// Returns a normal exit code, 128+signal for signal termination, -1 while
/// alive, or -ESRCH when the process does not exist.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_get_process_exit_status(pid: u32) -> i32 {
    let table = unsafe { &*PROCESS_TABLE.0.get() };
    match table.get(pid) {
        Some(proc) if proc.state == crate::process::ProcessState::Exited => {
            if proc.exit_signal != 0 {
                128 + proc.exit_signal as i32
            } else {
                proc.exit_status
            }
        }
        Some(_) => -1,
        None => -(Errno::ESRCH as i32),
    }
}

/// Return the signal that terminated an exited process, or zero for a normal
/// exit. Returns -1 while the process is alive and -ESRCH when it is absent.
/// Hosts use this explicit cause instead of guessing from high exit codes.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_get_process_exit_signal(pid: u32) -> i32 {
    let table = unsafe { &*PROCESS_TABLE.0.get() };
    match table.get(pid) {
        Some(proc) if proc.state == crate::process::ProcessState::Exited => proc.exit_signal as i32,
        Some(_) => -1,
        None => -(Errno::ESRCH as i32),
    }
}

/// Return the host-visible parent pid for a process, or -ESRCH if absent or
/// still hidden inside an unpublished spawn transaction.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_get_parent_pid(pid: u32) -> i32 {
    let table = unsafe { &*PROCESS_TABLE.0.get() };
    match table.parent_pid(pid) {
        Some(parent_pid) => parent_pid as i32,
        None => -(Errno::ESRCH as i32),
    }
}

/// Return the host-visible lifecycle state. Reaped limbo group identities are
/// not processes and report ESRCH just like an absent pid.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_get_process_state(pid: u32) -> i32 {
    use crate::process::ProcessState;
    use wasm_posix_shared::wait::{
        PROCESS_STATE_EXITED, PROCESS_STATE_RUNNING, PROCESS_STATE_STOPPED,
    };

    let table = unsafe { &*PROCESS_TABLE.0.get() };
    match table.get(pid).map(|proc| proc.state) {
        Some(ProcessState::Running) => PROCESS_STATE_RUNNING,
        Some(ProcessState::Stopped) => PROCESS_STATE_STOPPED,
        Some(ProcessState::Exited) => PROCESS_STATE_EXITED,
        Some(ProcessState::Limbo) | None => -(Errno::ESRCH as i32),
    }
}

/// Pick the next live process/fd that should receive a host-bridged TCP
/// connection for `port`.
///
/// Writes `{ u32 pid, i32 fd }` to `out_ptr`; returns 1 if a target was
/// written, 0 if none exists, or negative errno.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_pick_tcp_listener_target(
    port: u32,
    exclude_pid: u32,
    out_ptr: *mut u8,
    out_capacity: u32,
) -> i32 {
    if out_ptr.is_null() {
        return -(Errno::EFAULT as i32);
    }
    if out_capacity != 8 {
        return -(Errno::EINVAL as i32);
    }
    if port > u16::MAX as u32 {
        return -(Errno::EINVAL as i32);
    }

    let _gkl = GklGuard::acquire();
    let table = unsafe { &mut *PROCESS_TABLE.0.get() };
    match table.pick_tcp_listener_target(port as u16, exclude_pid) {
        Some((pid, fd)) => {
            let out = unsafe { core::slice::from_raw_parts_mut(out_ptr, 8) };
            out[0..4].copy_from_slice(&pid.to_le_bytes());
            out[4..8].copy_from_slice(&fd.to_le_bytes());
            1
        }
        None => 0,
    }
}

/// Drain the complete bounded Rust-owned timer identity list for host teardown.
///
/// Writes `{ u32 cancel_alarm, u32 posix_count, u32 timer_ids[posix_count] }`
/// into the caller's exact scratch capacity. The return value is
/// `posix_count`. If the complete list does not fit, returns `ERANGE` without
/// consuming any timer state.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_take_process_timer_cleanup(
    pid: u32,
    out_ptr: *mut u8,
    out_capacity: u32,
) -> i32 {
    const HEADER_BYTES: usize = 8;
    const TIMER_ID_BYTES: usize = 4;

    if out_ptr.is_null() {
        return -(Errno::EFAULT as i32);
    }
    let out_capacity = out_capacity as usize;
    if out_capacity < HEADER_BYTES + TIMER_ID_BYTES
        || (out_capacity - HEADER_BYTES) % TIMER_ID_BYTES != 0
    {
        return -(Errno::EINVAL as i32);
    }
    let max_timer_ids = (out_capacity - HEADER_BYTES) / TIMER_ID_BYTES;

    let _gkl = GklGuard::acquire();
    let table = unsafe { &mut *PROCESS_TABLE.0.get() };
    let Some(proc) = table.get_mut(pid) else {
        return -(Errno::ESRCH as i32);
    };
    let cleanup = match proc.take_host_timer_cleanup(max_timer_ids) {
        Ok(cleanup) => cleanup,
        Err(error) => return -(error as i32),
    };

    let out_len = HEADER_BYTES + cleanup.posix_timer_ids.len() * TIMER_ID_BYTES;
    let out = unsafe { core::slice::from_raw_parts_mut(out_ptr, out_len) };
    out[0..4].copy_from_slice(&(cleanup.cancel_alarm as u32).to_le_bytes());
    out[4..8].copy_from_slice(&(cleanup.posix_timer_ids.len() as u32).to_le_bytes());
    for (index, timer_id) in cleanup.posix_timer_ids.iter().enumerate() {
        let offset = HEADER_BYTES + index * TIMER_ID_BYTES;
        out[offset..offset + TIMER_ID_BYTES].copy_from_slice(&timer_id.to_le_bytes());
    }
    cleanup.posix_timer_ids.len() as i32
}

/// Mark a process as signal-terminated without removing it from the table.
///
/// Used by the host when the Worker dies before the guest reaches SYS_EXIT.
/// The process remains as an Exited zombie until a parent wait consumes it.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_mark_process_signaled(pid: u32, signum: u32) -> i32 {
    let table = unsafe { &mut *PROCESS_TABLE.0.get() };
    match table.process_and_advisory_locks(pid) {
        Some((proc, advisory_locks)) => {
            let mut host = WasmHostIO;
            terminate_process_by_signal_with_locks(proc, advisory_locks, &mut host, signum);
            0
        }
        None => -(Errno::ESRCH as i32),
    }
}

/// Atomically select and optionally consume one child status record. A
/// consuming exit selection also reaps the child in this serialized kernel
/// operation; WNOWAIT peeks without consuming or reaping.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_wait_child_poll(
    parent_pid: u32,
    caller_tid: u32,
    target_pid: i32,
    event_mask: u32,
    flags: u32,
    out_ptr: *mut KernelWaitResult,
    out_capacity: u32,
) -> i32 {
    if out_ptr.is_null() {
        return -(Errno::EFAULT as i32);
    }
    if out_capacity != wasm_posix_shared::KERNEL_WAIT_RESULT_SIZE {
        return -(Errno::EINVAL as i32);
    }

    let selected = {
        let table = unsafe { &mut *PROCESS_TABLE.0.get() };
        if table.validate_task(parent_pid, caller_tid).is_err() {
            return -(Errno::ESRCH as i32);
        }
        table.poll_wait_event(parent_pid, target_pid, event_mask, flags)
    };

    match selected {
        Ok(Some((child_pid, event))) => {
            let result = KernelWaitResult {
                wait_status: event.wait_status,
                si_code: event.si_code,
                si_status: event.si_status,
                child_uid: event.child_uid,
                rusage: event.rusage,
            };
            unsafe {
                core::ptr::write_unaligned(out_ptr, result);
            }

            if flags & wasm_posix_shared::wait::WNOWAIT == 0
                && event.event_mask == wasm_posix_shared::wait::EVENT_EXITED
            {
                let reaped = reap_process_and_cleanup(child_pid);
                if reaped < 0 {
                    return reaped;
                }
            }
            child_pid as i32
        }
        Ok(None) => 0,
        Err(e) => -(e as i32),
    }
}

/// Reap an exited direct child after wait/waitid consumes it.
///
/// This keeps the parent/child/exited invariant in Rust instead of allowing
/// the host to remove arbitrary process-table entries during wait handling.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_reap_exited_child(parent_pid: u32, child_pid: u32) -> i32 {
    let table = unsafe { &*PROCESS_TABLE.0.get() };
    if !table.is_exited_child_of(parent_pid, child_pid) {
        return -(Errno::ECHILD as i32);
    }
    reap_process_and_cleanup(child_pid)
}

/// Check if a process has SA_NOCLDWAIT set for SIGCHLD.
/// Returns 1 if SA_NOCLDWAIT is set, 0 if not, -ESRCH if process not found.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_has_sa_nocldwait(pid: u32) -> i32 {
    let table = unsafe { &*PROCESS_TABLE.0.get() };
    match table.get(pid) {
        Some(proc) => {
            let action = proc.signals.get_action(wasm_posix_shared::signal::SIGCHLD);
            if action.flags & wasm_posix_shared::signal::SA_NOCLDWAIT != 0 {
                1
            } else {
                // POSIX: setting SIGCHLD to SIG_IGN also implies SA_NOCLDWAIT
                match action.handler {
                    crate::signal::SignalHandler::Ignore => 1,
                    _ => 0,
                }
            }
        }
        None => -(Errno::ESRCH as i32),
    }
}

/// Check whether SIGCHLD stop/continue notifications are suppressed.
/// SA_NOCLDSTOP never suppresses the wait status record itself.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_has_sa_nocldstop(pid: u32) -> i32 {
    let table = unsafe { &*PROCESS_TABLE.0.get() };
    match table.get(pid) {
        Some(proc) => {
            let action = proc.signals.get_action(wasm_posix_shared::signal::SIGCHLD);
            i32::from(action.flags & wasm_posix_shared::signal::SA_NOCLDSTOP != 0)
        }
        None => -(Errno::ESRCH as i32),
    }
}

/// Check if a signal is blocked for a process.
/// Returns 1 if blocked by *every* thread of `pid` (i.e. no thread can
/// currently receive it), 0 if at least one thread has it unblocked,
/// -ESRCH if the process does not exist.
///
/// The host consults this to decide whether to wake a process's channels
/// after queuing a shared signal. If all threads block it, the signal
/// stays queued in the shared-pending set until some thread unblocks it.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_is_signal_blocked(pid: u32, signum: u32) -> i32 {
    let table = unsafe { &mut *PROCESS_TABLE.0.get() };
    match table.get(pid) {
        Some(proc) => {
            if signum == 0 || signum >= 65 {
                return 0;
            }
            if proc.pick_thread_for_shared_signal(signum).is_some() {
                0
            } else {
                1
            }
        }
        None => -(Errno::ESRCH as i32),
    }
}

/// Find a thread of `pid` that currently has `signum` unblocked. Returns
/// a positive TID (the process PID for the main thread, allocated TIDs for
/// worker threads), 0 if no thread accepts it, or -ESRCH if the process
/// does not exist. The host uses this to choose which thread's channel to
/// wake when delivering a shared signal.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_pick_signal_target_tid(pid: u32, signum: u32) -> i32 {
    let table = unsafe { &mut *PROCESS_TABLE.0.get() };
    match table.get(pid) {
        Some(proc) => {
            if signum == 0 || signum >= 65 {
                return 0;
            }
            proc.pick_thread_for_shared_signal(signum)
                .map(|t| t as i32)
                .unwrap_or(0)
        }
        None => -(Errno::ESRCH as i32),
    }
}

/// Returns 1 iff thread `tid` of process `pid` has at least one deliverable
/// signal right now (i.e. pending-for-tid with the thread's own blocked
/// mask applied). Returns 0 otherwise, -ESRCH if the process does not
/// exist. The host uses this after queuing a signal to decide whether a
/// specific thread's channel should be woken from a blocking syscall.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_thread_has_deliverable(pid: u32, tid: u32) -> i32 {
    let table = unsafe { &mut *PROCESS_TABLE.0.get() };
    match table.get(pid) {
        Some(proc) => {
            if !proc.is_live_explicit_tid(tid) {
                return -(Errno::ESRCH as i32);
            }
            if proc.deliverable_for(tid) != 0 {
                1
            } else {
                0
            }
        }
        None => -(Errno::ESRCH as i32),
    }
}

/// Generate one process-directed signal from a host-owned asynchronous event.
///
/// WHY: alarm expiry and child lifecycle notification occur after the guest
/// syscall that armed or caused them has returned. Re-entering the target's
/// syscall channel as a synthetic `kill()` would compete with an exact blocked
/// retry owned by that task and can truthfully fail with EBUSY. This boundary
/// names the target explicitly, creates no caller task authority, and retains
/// the historical self-`kill()` SI_USER metadata until richer event-specific
/// siginfo is represented by the ABI.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_generate_host_signal(pid: u32, signum: u32) -> i32 {
    use wasm_posix_shared::signal::NSIG;

    if signum >= NSIG && signum != 0 {
        return -(Errno::EINVAL as i32);
    }

    let _gkl = GklGuard::acquire();
    let table = unsafe { &mut *PROCESS_TABLE.0.get() };
    let Some((proc, advisory_locks)) = table.process_and_advisory_locks(pid)
    else {
        return -(Errno::ESRCH as i32);
    };
    if !proc.is_live_explicit_tid(proc.pid) {
        return -(Errno::ESRCH as i32);
    }
    if signum == 0 {
        return 0;
    }

    let sender_uid = proc.real_uid();
    proc.raise_signal_with_metadata(signum, 0, 0, pid, sender_uid);
    if let Some(target_tid) = proc.pick_thread_for_shared_signal(signum) {
        let mut host = WasmHostIO;
        let _ = deliver_pending_signals_for_tid_with_locks(
            proc,
            advisory_locks,
            &mut host,
            target_tid,
        );
    }
    0
}

/// Get fork exec path for a specific process.
/// Writes path to buf, returns bytes written, 0 if no exec path, -ESRCH if not found.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_get_fork_exec_path_pid(pid: u32, buf_ptr: *mut u8, buf_len: u32) -> i32 {
    let table = unsafe { &mut *PROCESS_TABLE.0.get() };
    match table.get(pid) {
        Some(proc) => match &proc.fork_exec_path {
            Some(path) => {
                let len = path.len().min(buf_len as usize);
                let buf = unsafe { core::slice::from_raw_parts_mut(buf_ptr, len) };
                buf.copy_from_slice(&path[..len]);
                len as i32
            }
            None => 0,
        },
        None => -(Errno::ESRCH as i32),
    }
}

/// Get the CWD for a specific process.
///
/// A zero capacity queries the complete byte length without dereferencing the
/// pointer. A positive short capacity returns `-ERANGE` without writing.
/// Otherwise this writes the complete CWD and returns its byte length.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_get_cwd(pid: u32, buf_ptr: *mut u8, buf_len: u32) -> i32 {
    let table = unsafe { &mut *PROCESS_TABLE.0.get() };
    match table.get(pid) {
        Some(proc) => unsafe {
            crate::complete_copy::copy_complete_bytes(&proc.cwd, buf_ptr, buf_len)
        },
        None => -(Errno::ESRCH as i32),
    }
}

/// Get the file path for an fd in a specific process.
/// Used by the host to resolve fexecve fd paths.
///
/// The zero-capacity query and complete-or-`ERANGE` copy contract matches
/// `kernel_get_cwd`.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_get_fd_path(pid: u32, fd: i32, buf_ptr: *mut u8, buf_len: u32) -> i32 {
    kernel_copy_fd_path(pid, fd, buf_ptr, buf_len, false)
}

/// Get the directory path for a dirfd in a specific process.
///
/// Relative `execveat` and *at-style host lookups must prove that their base
/// descriptor is a directory before joining its path. This has the same
/// zero-capacity query and complete-or-`ERANGE` copy contract as
/// `kernel_get_fd_path`, but returns `-ENOTDIR` for another file type.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_get_dirfd_path(
    pid: u32,
    fd: i32,
    buf_ptr: *mut u8,
    buf_len: u32,
) -> i32 {
    kernel_copy_fd_path(pid, fd, buf_ptr, buf_len, true)
}

fn kernel_copy_fd_path(
    pid: u32,
    fd: i32,
    buf_ptr: *mut u8,
    buf_len: u32,
    require_directory: bool,
) -> i32 {
    let table = unsafe { &mut *PROCESS_TABLE.0.get() };
    match table.get(pid) {
        Some(proc) => match proc.fd_table.get(fd) {
            Ok(entry) => {
                let ofd_idx = entry.ofd_ref.0;
                match proc.ofd_table.get(ofd_idx) {
                    Some(ofd) => {
                        if require_directory && ofd.file_type != FileType::Directory {
                            return -(Errno::ENOTDIR as i32);
                        }
                        if ofd.path.is_empty() {
                            return -(Errno::ENOENT as i32);
                        }
                        unsafe {
                            crate::complete_copy::copy_complete_bytes(
                                &ofd.path,
                                buf_ptr,
                                buf_len,
                            )
                        }
                    }
                    None => -(Errno::EBADF as i32),
                }
            }
            Err(e) => -(e as i32),
        },
        None => -(Errno::ESRCH as i32),
    }
}

/// Return 1 when `fd` names a live descriptor in `pid`, 0 when it does not,
/// and a negative errno when the process itself is absent.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_fd_is_open(pid: u32, fd: i32) -> i32 {
    let table = unsafe { &mut *PROCESS_TABLE.0.get() };
    match table.get(pid) {
        Some(proc) => i32::from(proc.fd_table.get(fd).is_ok()),
        None => -(Errno::ESRCH as i32),
    }
}

/// Return 1 when `fd` can back host-persisted MAP_SHARED writeback, 0 for an
/// unsupported or absent descriptor, and `-ESRCH` when `pid` is absent.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_fd_supports_mmap_writeback(pid: u32, fd: i32) -> i32 {
    let table = unsafe { &*PROCESS_TABLE.0.get() };
    match table.get(pid) {
        Some(proc) => i32::from(syscalls::fd_supports_mmap_writeback(proc, fd)),
        None => -(Errno::ESRCH as i32),
    }
}

/// Enumerate every live host handle held inside kernel memory.
///
/// A machine checkpoint's kernel memory names host resources through opaque
/// handles the receiver cannot find by scanning bytes. This walk names each
/// one: every open file description slot holding a non-negative handle, per
/// descriptor that can reach it. A handle shared by dup, fork, or spawn
/// appears once per (pid, fd) naming it, so the reader sees the sharing and
/// deduplicates by (kind, handle). Negative handles are kernel-internal
/// encodings (sockets, backing tables, synthetic and sentinel values) and
/// are never emitted.
///
/// Wire format (all integers little-endian):
///
///   u32  count
///   for each record (20 bytes):
///     u32  pid
///     u32  fd
///     u32  kind      -- 0 = stream slot, 1 = directory iterator slot
///     i64  handle
///
/// Returns total bytes written, or -ENOSPC when the buffer is too small.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_enumerate_host_handles(out_ptr: *mut u8, out_len: u32) -> i32 {
    let table = unsafe { &*PROCESS_TABLE.0.get() };
    let out = unsafe { slice::from_raw_parts_mut(out_ptr, out_len as usize) };
    match table.write_host_handle_records(out) {
        Ok(written) => written as i32,
        Err(e) => -(e as i32),
    }
}

/// Remap one live host handle to its receiver-side replacement, machine-wide.
///
/// Generalises `kernel_convert_pipe_to_host`: instead of rewriting one open
/// file description of the current process, this rewrites every description
/// in every process whose slot of the given kind holds `old_handle`, and
/// moves the cross-process refcount entry with them, so shared descriptions
/// stay shared. `kind` 0 names the stream slot (`host_handle`), `kind` 1 the
/// directory iterator slot (`dir_host_handle`).
///
/// Returns the number of rewritten slots (> 0), -EINVAL for a bad kind or a
/// negative handle, -EEXIST when a different resource already answers to
/// `new_handle`, and -EBADF when no slot holds `old_handle`. An identity
/// remap (`old_handle == new_handle`) is legal.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_remap_host_handles(kind: u32, old_handle: i64, new_handle: i64) -> i32 {
    let table = unsafe { &mut *PROCESS_TABLE.0.get() };
    match table.remap_host_handles(kind, old_handle, new_handle) {
        Ok(rewritten) => rewritten as i32,
        Err(e) => -(e as i32),
    }
}

/// Re-arm this machine's host timers for one restored process.
///
/// A restored kernel memory carries armed ITIMER_REAL state — the monotonic
/// deadline and the interval — but the platform timer the captured machine
/// scheduled through `host_set_alarm` died with it. Returns 1 when the
/// interval timer was re-armed with its remaining time, 0 when none was
/// armed, and a negative errno on failure. POSIX timer slots store their
/// original relative value rather than a deadline, so kernel state cannot
/// reproduce their remaining time; that gap stays open until the state
/// carries one.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_rearm_host_timers(pid: u32) -> i32 {
    let table = unsafe { &mut *PROCESS_TABLE.0.get() };
    let Some(proc) = table.get_mut(pid) else {
        return -(Errno::ESRCH as i32);
    };
    let mut host = WasmHostIO;
    match syscalls::rearm_host_interval_timer(proc, &mut host) {
        Ok(rearmed) => i32::from(rearmed),
        Err(e) => -(e as i32),
    }
}

/// Name the PTY pair serving as `pid`'s terminal, for restore.
///
/// A restored kernel memory carries the captured machine's whole PTY table,
/// but the host routing that feeds keyboard input to a PTY master died with
/// the captured machine. Returns the PTY index (>= 0), -ENOENT when the
/// process holds no PTY slave descriptor, and -ESRCH for a dead pid.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_pty_index_for_pid(pid: u32) -> i32 {
    let table = unsafe { &*PROCESS_TABLE.0.get() };
    match table.pty_index_for_pid(pid) {
        Ok(pty_idx) => pty_idx as i32,
        Err(e) => -(e as i32),
    }
}

/// Snapshot the process table for the host (Kandelo Inspector → Procs tab,
/// and any host that wants a `ps`-equivalent view without spawning a user
/// process). Walks every active pid and writes a compact, length-prefixed
/// binary record per process into the host-supplied scratch buffer.
///
/// Zombie (Exited) processes are omitted by default — the kandelo Inspector
/// wants a live-process view, including stopped processes, and the kernel
/// keeps zombies around for waitpid() reap semantics. Procfs still surfaces
/// them via /proc/[pid].
///
/// Wire format (all integers little-endian):
///
///   u32  count
///   for each process:
///     u32  pid
///     u32  ppid
///     u32  uid             -- effective uid for ps-style USER display
///     u32  gid             -- effective gid
///     u64  vsize_bytes    -- sum of mmap-region sizes
///     u32  state          -- 'R' (running) or 'T' (stopped) as ASCII
///     u32  comm_len
///     u32  cmdline_len
///     [comm_len bytes]    -- process_name(proc) — basename of argv[0]
///     [cmdline_len bytes] -- null-separated argv (same shape as /proc/<pid>/cmdline)
///
/// Returns total bytes written on success or -ENOSPC if the buffer is too
/// small (the host can retry with a larger scratch alloc).
#[unsafe(no_mangle)]
pub extern "C" fn kernel_enum_procs(out_ptr: *mut u8, out_len: u32) -> i32 {
    let table = unsafe { &*PROCESS_TABLE.0.get() };
    let pids = table.all_pids();

    // First pass: compute total bytes we need to write so we can fail fast
    // on a too-small buffer rather than partial-writing. Skip zombies on
    // the count too so the size estimate matches what we actually emit.
    let mut need: usize = process_snapshot_wire::RECORDS_OFFSET;
    for pid in &pids {
        let proc = match table.get(*pid) {
            Some(p) => p,
            None => continue,
        };
        if matches!(
            proc.state,
            crate::process::ProcessState::Exited | crate::process::ProcessState::Limbo
        ) {
            continue;
        }
        let cmdline = crate::procfs::generate_cmdline(proc);
        let comm = process_name_bytes(proc);
        let record_bytes = match process_snapshot_record_bytes(comm.len(), cmdline.len()) {
            Ok(bytes) => bytes,
            Err(errno) => return -(errno as i32),
        };
        need = match need.checked_add(record_bytes) {
            Some(size) => size,
            None => return -(Errno::EOVERFLOW as i32),
        };
    }
    if need > out_len as usize {
        return -(Errno::ENOSPC as i32);
    }
    if need > i32::MAX as usize {
        return -(Errno::EOVERFLOW as i32);
    }
    if out_ptr.is_null() {
        return -(Errno::EFAULT as i32);
    }

    let buf = unsafe { core::slice::from_raw_parts_mut(out_ptr, need) };
    let mut off = process_snapshot_wire::RECORDS_OFFSET;

    // count placeholder — patched after we finish walking.
    buf[process_snapshot_wire::COUNT_OFFSET
        ..process_snapshot_wire::COUNT_OFFSET + process_snapshot_wire::COUNT_BYTES]
        .copy_from_slice(&0_u32.to_le_bytes());
    let mut written: u32 = 0;

    for pid in &pids {
        let proc = match table.get(*pid) {
            Some(p) => p,
            None => continue,
        };
        // Drop zombies and reaped limbo identities, but retain stopped
        // processes in the live-process view.
        if matches!(
            proc.state,
            crate::process::ProcessState::Exited | crate::process::ProcessState::Limbo
        ) {
            continue;
        }
        let cmdline = crate::procfs::generate_cmdline(proc);
        let comm = process_name_bytes(proc);
        let state: u32 = match proc.state {
            crate::process::ProcessState::Running => b'R' as u32,
            crate::process::ProcessState::Stopped => b'T' as u32,
            crate::process::ProcessState::Exited | crate::process::ProcessState::Limbo => {
                unreachable!("non-live processes were filtered above")
            }
        };
        let vsize: u64 = proc.memory.mappings().iter().map(|r| r.len as u64).sum();

        let comm_len = match u32::try_from(comm.len()) {
            Ok(length) => length,
            Err(_) => return -(Errno::EOVERFLOW as i32),
        };
        let cmdline_len = match u32::try_from(cmdline.len()) {
            Ok(length) => length,
            Err(_) => return -(Errno::EOVERFLOW as i32),
        };
        if write_process_snapshot_record(
            buf,
            &mut off,
            &ProcessSnapshotHeader {
                pid: proc.pid,
                ppid: proc.ppid,
                uid: proc.effective_uid(),
                gid: proc.effective_gid(),
                vsize,
                state,
                comm_len,
                cmdline_len,
            },
            &comm,
            &cmdline,
        )
        .is_err()
        {
            return -(Errno::EIO as i32);
        }
        written += 1;
    }
    // Patch the count.
    let count_bytes = written.to_le_bytes();
    buf[process_snapshot_wire::COUNT_OFFSET
        ..process_snapshot_wire::COUNT_OFFSET + process_snapshot_wire::COUNT_BYTES]
        .copy_from_slice(&count_bytes);
    off as i32
}

/// Write the contents of `/proc/<pid>/maps` (Linux-style smaps-ish text)
/// into the host buffer. Returns bytes written, or `-ENOSPC` if the buffer
/// is too small, `-ESRCH` if the pid doesn't exist.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_read_proc_maps(pid: u32, out_ptr: *mut u8, out_len: u32) -> i32 {
    let table = unsafe { &*PROCESS_TABLE.0.get() };
    let proc = match table.get(pid) {
        Some(p) => p,
        None => return -(Errno::ESRCH as i32),
    };
    let maps = crate::procfs::generate_maps(proc);
    if maps.len() > out_len as usize {
        return -(Errno::ENOSPC as i32);
    }
    let buf = unsafe { core::slice::from_raw_parts_mut(out_ptr, maps.len()) };
    buf.copy_from_slice(&maps);
    maps.len() as i32
}

// Local helpers for kernel_enum_procs. Kept here (not in procfs.rs) because
// they're tied to the host-callable wire format, not the user-visible procfs
// text generators.

/// Process name (basename of argv[0], or "[kernel]" for an empty argv).
/// Mirrors `process_name(proc)` from procfs.rs but returns bytes directly so
/// we don't bounce through `&str` formatting.
fn process_name_bytes(proc: &crate::process::Process) -> Vec<u8> {
    if let Some(arg0) = proc.argv.first() {
        // Strip directory prefix to match `comm` semantics.
        match arg0.iter().rposition(|&b| b == b'/') {
            Some(i) => arg0[i + 1..].to_vec(),
            None => arg0.clone(),
        }
    } else {
        b"[kernel]".to_vec()
    }
}

/// Dequeue one pending Handler signal for an exact live task.
/// Writes the shared `kernel_scratch_wire` signal-delivery record to `out_ptr`.
/// Applies sa_mask | sig_bit(signum) to the process's blocked mask (POSIX).
/// Returns signum (>0) if a signal was dequeued, 0 if none pending.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_dequeue_signal(
    pid: u32,
    tid: u32,
    out_ptr: *mut u8,
    out_capacity: u32,
) -> i32 {
    use crate::signal::SignalHandler;
    use wasm_posix_shared::kernel_scratch_wire as signal_wire;

    if let Err(error) = crate::process_wire::validate_signal_delivery_output(out_ptr, out_capacity)
    {
        return -(error as i32);
    }
    let table = unsafe { &mut *PROCESS_TABLE.0.get() };
    let (proc, advisory_locks) = match table.task_and_advisory_locks(pid, tid) {
        Some(pair) => pair,
        None => return -(Errno::ESRCH as i32),
    };
    loop {
        // Peek at the lowest-numbered deliverable signal for this thread:
        // directed-pending bits (ThreadInfo.signals.pending) have priority over
        // shared-pending bits (Process.signals.pending), but we collapse to a
        // single bitmask here — the actual dequeue routine below picks the
        // right queue.
        let Some(signum) = proc.next_deliverable_signal(tid) else {
            return 0;
        };
        let action = proc.signals.get_action(signum);
        match action.handler {
            SignalHandler::Handler(idx) => {
                let (_sig, si_value, si_code, siginfo_word_1, siginfo_word_2) =
                    dequeue_signal_for(proc, tid, signum);
                // ppoll, pselect, and sigsuspend keep their replacement mask
                // installed until the logical wait finally completes. Form
                // the handler mask from that current mask and place the same
                // current mask in the delivery record for normal handler
                // return. The saved pre-wait mask stays Rust-owned across an
                // SA_RESTART resubmission and is consumed only by terminal
                // wait completion or exact host-owned cancellation.
                let old_mask = proc.install_caught_handler_mask_for(tid, action.mask, signum);
                // If SA_ONSTACK and alt stack is configured (not SS_DISABLE),
                // mark that we're executing on the alt stack.
                const SA_ONSTACK: u32 = 0x08000000;
                const SS_ONSTACK: u32 = 1;
                const SS_DISABLE: u32 = 2;
                // Track whether we're transitioning onto the alt stack
                let mut switch_to_alt_stack = false;
                if action.flags & SA_ONSTACK != 0
                    && proc.alt_stack_flags & SS_DISABLE == 0
                    && proc.alt_stack_sp != 0
                {
                    // Only switch stacks when first entering alt stack (depth 0 → 1).
                    // Nested signals on the alt stack keep the current __stack_pointer.
                    if proc.alt_stack_depth == 0 {
                        switch_to_alt_stack = true;
                    }
                    proc.alt_stack_depth += 1;
                    proc.alt_stack_flags |= SS_ONSTACK;
                }
                // Encode into owned bytes before touching the destination.
                // The host publishes this complete record from one exclusive
                // lease, so no observer can see a partially replaced wire.
                let encoded = crate::process_wire::encode_signal_delivery_record(
                    crate::process_wire::SignalDeliveryRecord {
                        signum,
                        handler: idx,
                        flags: action.flags,
                        si_value_bits: si_value,
                        old_mask,
                        si_code,
                        siginfo_word_1,
                        siginfo_word_2,
                        alt_sp: if switch_to_alt_stack {
                            proc.alt_stack_sp
                        } else {
                            0
                        },
                        alt_size: if switch_to_alt_stack {
                            proc.alt_stack_size
                        } else {
                            0
                        },
                    },
                );
                let buf = unsafe {
                    slice::from_raw_parts_mut(out_ptr, signal_wire::SIGNAL_DELIVERY_BYTES as usize)
                };
                buf.copy_from_slice(&encoded);
                return signum as i32;
            }
            SignalHandler::Default => {
                let _ = dequeue_signal_for(proc, tid, signum);
                let mut host = WasmHostIO;
                match apply_default_signal_action_with_locks(
                    proc,
                    advisory_locks,
                    &mut host,
                    signum,
                ) {
                    DefaultSignalOutcome::Continue => continue,
                    DefaultSignalOutcome::Stopped | DefaultSignalOutcome::Exited => return 0,
                }
            }
            SignalHandler::Ignore => {
                let _ = dequeue_signal_for(proc, tid, signum);
                continue;
            }
        }
    }
}

fn checked_exec_path<'a>(path_ptr: usize, path_len: usize) -> Result<&'a [u8], Errno> {
    if path_len > wasm_posix_shared::platform_limits::PATH_MAX_BYTES {
        return Err(Errno::ENAMETOOLONG);
    }
    if path_len == 0 {
        return Ok(&[]);
    }
    if path_ptr == 0 || path_ptr.checked_add(path_len).is_none() {
        return Err(Errno::EFAULT);
    }
    Ok(unsafe { core::slice::from_raw_parts(path_ptr as *const u8, path_len) })
}

/// Prepare one exact pathname or `AT_EMPTY_PATH` executable object.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_exec_target_prepare(
    pid: u32,
    caller_tid: u32,
    dirfd: i32,
    path_ptr: usize,
    path_len: usize,
    flags: u32,
) -> i32 {
    let path = match checked_exec_path(path_ptr, path_len) {
        Ok(path) => path,
        Err(error) => return -(error as i32),
    };
    let table = unsafe { &mut *PROCESS_TABLE.0.get() };
    let (proc, advisory_locks) = match table.process_and_advisory_locks(pid) {
        Some(pair) => pair,
        None => return -(Errno::ESRCH as i32),
    };
    if !proc.is_live_explicit_tid(caller_tid) {
        return -(Errno::ESRCH as i32);
    }
    let mut host = WasmHostIO;
    let owner = crate::exec_target::PreparedExecOwner::Process {
        pid,
        caller_tid,
        generation: proc.exec_generation,
    };
    match crate::exec_target::prepare(
        proc,
        advisory_locks,
        &mut host,
        owner,
        dirfd,
        path,
        flags,
    ) {
        Ok(token) => token as i32,
        Err(error) => -(error as i32),
    }
}

/// Prepare the exact initial executable for a newly allocated spawn child.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_spawn_exec_target_prepare(
    parent_pid: u32,
    child_pid: u32,
    path_ptr: usize,
    path_len: usize,
) -> i32 {
    let path = match checked_exec_path(path_ptr, path_len) {
        Ok(path) if !path.is_empty() => path,
        Ok(_) => return -(Errno::ENOENT as i32),
        Err(error) => return -(error as i32),
    };
    let table = unsafe { &mut *PROCESS_TABLE.0.get() };
    let parent_exists = table.get(parent_pid).is_some();
    let (child, advisory_locks) = match table.process_and_advisory_locks(child_pid) {
        Some(pair) if parent_exists && pair.0.ppid == parent_pid => pair,
        _ => return -(Errno::ESRCH as i32),
    };
    let mut host = WasmHostIO;
    let owner = crate::exec_target::PreparedExecOwner::Spawn {
        parent_pid,
        child_pid,
        launch: child.exec_generation,
    };
    match crate::exec_target::prepare(
        child,
        advisory_locks,
        &mut host,
        owner,
        wasm_posix_shared::flags::AT_FDCWD,
        path,
        0,
    ) {
        Ok(token) => token as i32,
        Err(error) => -(error as i32),
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn kernel_exec_target_size(owner_pid: u32, target: u32) -> i64 {
    let table = unsafe { &*PROCESS_TABLE.0.get() };
    let Some(proc) = table.get(owner_pid) else {
        return -(Errno::ESRCH as i64);
    };
    match crate::exec_target::size(proc, owner_pid, target) {
        Ok(size) => size,
        Err(error) => -(error as i64),
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn kernel_exec_target_read(
    owner_pid: u32,
    target: u32,
    offset_lo: u32,
    offset_hi: i32,
    buffer_ptr: usize,
    buffer_len: usize,
) -> i32 {
    if buffer_len > i32::MAX as usize {
        return -(Errno::EOVERFLOW as i32);
    }
    if buffer_len != 0 && (buffer_ptr == 0 || buffer_ptr.checked_add(buffer_len).is_none()) {
        return -(Errno::EFAULT as i32);
    }
    let buffer = if buffer_len == 0 {
        &mut []
    } else {
        unsafe { core::slice::from_raw_parts_mut(buffer_ptr as *mut u8, buffer_len) }
    };
    let offset = ((offset_hi as i64) << 32) | i64::from(offset_lo);
    let table = unsafe { &mut *PROCESS_TABLE.0.get() };
    let Some(proc) = table.get_mut(owner_pid) else {
        return -(Errno::ESRCH as i32);
    };
    let mut host = WasmHostIO;
    match crate::exec_target::read(proc, &mut host, owner_pid, target, offset, buffer) {
        Ok(read) => read as i32,
        Err(error) => -(error as i32),
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn kernel_exec_target_cancel(owner_pid: u32, target: u32) -> i32 {
    let table = unsafe { &mut *PROCESS_TABLE.0.get() };
    let (proc, advisory_locks) = match table.process_and_advisory_locks(owner_pid) {
        Some(pair) => pair,
        None => return -(Errno::ESRCH as i32),
    };
    let mut host = WasmHostIO;
    match crate::exec_target::cancel(proc, advisory_locks, &mut host, owner_pid, target) {
        Ok(()) => 0,
        Err(error) => -(error as i32),
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn kernel_exec_commit(pid: u32, caller_tid: u32, target: u32) -> i32 {
    let table = unsafe { &mut *PROCESS_TABLE.0.get() };
    let (proc, advisory_locks) = match table.process_and_advisory_locks(pid) {
        Some(pair) => pair,
        None => return -(Errno::ESRCH as i32),
    };
    let mut host = WasmHostIO;
    match crate::exec_target::commit_process(
        proc,
        advisory_locks,
        &mut host,
        pid,
        caller_tid,
        target,
    ) {
        Ok(()) => 0,
        Err(error) => -(error as i32),
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn kernel_spawn_exec_commit(
    parent_pid: u32,
    child_pid: u32,
    target: u32,
) -> i32 {
    let table = unsafe { &mut *PROCESS_TABLE.0.get() };
    let parent_exists = table.get(parent_pid).is_some();
    let (child, advisory_locks) = match table.process_and_advisory_locks(child_pid) {
        Some(pair) if parent_exists && pair.0.ppid == parent_pid => pair,
        _ => return -(Errno::ESRCH as i32),
    };
    let mut host = WasmHostIO;
    match crate::exec_target::commit_spawn(
        child,
        advisory_locks,
        &mut host,
        parent_pid,
        child_pid,
        target,
    ) {
        Ok(()) => 0,
        Err(error) => -(error as i32),
    }
}

/// Handle a syscall via the channel protocol.
///
/// Reads the channel layout from kernel Memory at `offset`:
///   - syscall number at offset+4
///   - args[0..6] at offset+8
///
/// `pid` identifies which process to service.
///
/// Given an EAGAIN result from mq_timedsend/mq_timedreceive, decide the errno
/// to surface based on the optional absolute-timeout pointer and the
/// descriptor's non-blocking flag. POSIX rules:
///   * NULL timeout → EAGAIN (host retries forever for blocking mode, returns
///     immediately for non-blocking mode via host_is_mq_nonblock check).
///   * Invalid tv_nsec (negative or >= 1e9) AND the call would have blocked
///     → EINVAL (checked only when queue is full/empty).
///   * Non-blocking descriptor → EAGAIN.
///   * Blocking descriptor + abs_timeout <= now (CLOCK_REALTIME) → ETIMEDOUT.
///   * Otherwise EAGAIN (host retries; subsequent calls re-check the deadline).
fn mq_timed_blocking_errno(timeout_ptr: usize, nonblock: bool) -> i32 {
    let eagain = -(Errno::EAGAIN as i32);
    if timeout_ptr == 0 {
        return eagain;
    }
    let tp = timeout_ptr as *const i64;
    let sec = unsafe { core::ptr::read_unaligned(tp) };
    let nsec = unsafe { core::ptr::read_unaligned(tp.offset(1)) };
    if nsec < 0 || nsec >= 1_000_000_000 {
        return -(Errno::EINVAL as i32);
    }
    if nonblock {
        return eagain;
    }
    let mut now_sec: i64 = 0;
    let mut now_nsec: i64 = 0;
    let rc = unsafe {
        host_clock_gettime(
            0, /* CLOCK_REALTIME */
            &mut now_sec as *mut i64,
            &mut now_nsec as *mut i64,
        )
    };
    if rc == 0 && (sec < now_sec || (sec == now_sec && nsec <= now_nsec)) {
        return -(Errno::ETIMEDOUT as i32);
    }
    eagain
}

fn activate_blocking_retry_for_current_task(
    syscall_nr: u32,
    retry_token: i64,
) -> Result<(), Errno> {
    let table = unsafe { &mut *PROCESS_TABLE.0.get() };
    let tid = table.current_tid();
    let proc = table.current_process().ok_or(Errno::ESRCH)?;
    proc.blocked_retries.begin_dispatch(tid)?;
    let activation = if retry_token == 0 {
        if proc.blocked_retries.has_binding_for_tid(tid) {
            Err(Errno::EBUSY)
        } else {
            Ok(())
        }
    } else if retry_token < 0 {
        Err(Errno::EINVAL)
    } else {
        match crate::blocked_retry::BlockingRetryOperation::from_syscall(syscall_nr) {
            Ok(operation) => proc.blocked_retries.activate(tid, retry_token, operation),
            Err(error) => Err(error),
        }
    };
    if activation.is_err() {
        proc.blocked_retries.clear_dispatch();
    }
    activation
}

fn retain_blocking_retry_target(syscall_nr: u32, args: &[i64; 6]) -> Result<(), Errno> {
    let Ok(operation) = crate::blocked_retry::BlockingRetryOperation::from_syscall(syscall_nr)
    else {
        return Ok(());
    };
    let table = unsafe { &mut *PROCESS_TABLE.0.get() };
    let tid = table.current_tid();
    let (proc, locks) = table
        .current_process_and_advisory_locks()
        .ok_or(Errno::ESRCH)?;
    let mut host = WasmHostIO;
    match operation {
        crate::blocked_retry::BlockingRetryOperation::Read
        | crate::blocked_retry::BlockingRetryOperation::Write
        | crate::blocked_retry::BlockingRetryOperation::Fcntl
        | crate::blocked_retry::BlockingRetryOperation::Pread
        | crate::blocked_retry::BlockingRetryOperation::Pwrite
        | crate::blocked_retry::BlockingRetryOperation::Accept
        | crate::blocked_retry::BlockingRetryOperation::Connect
        | crate::blocked_retry::BlockingRetryOperation::Send
        | crate::blocked_retry::BlockingRetryOperation::Recv
        | crate::blocked_retry::BlockingRetryOperation::Sendto
        | crate::blocked_retry::BlockingRetryOperation::Recvfrom
        | crate::blocked_retry::BlockingRetryOperation::Recvmsg
        | crate::blocked_retry::BlockingRetryOperation::Flock => {
            syscalls::ensure_blocking_retry_ofd_binding(
                proc,
                locks,
                &mut host,
                tid,
                syscall_nr,
                args[0] as i32,
                None,
            )?;
        }
        crate::blocked_retry::BlockingRetryOperation::Sendfile => {
            syscalls::ensure_blocking_retry_ofd_pair_binding(
                proc,
                locks,
                &mut host,
                tid,
                syscall_nr,
                args[1] as i32,
                args[0] as i32,
            )?;
        }
        crate::blocked_retry::BlockingRetryOperation::CopyFileRange
        | crate::blocked_retry::BlockingRetryOperation::Splice => {
            syscalls::ensure_blocking_retry_ofd_pair_binding(
                proc,
                locks,
                &mut host,
                tid,
                syscall_nr,
                args[0] as i32,
                args[2] as i32,
            )?;
        }
        // kernel_sendmsg retains its SCM_RIGHTS template while the complete
        // canonical control wire is still available.
        crate::blocked_retry::BlockingRetryOperation::Sendmsg => return Ok(()),
        crate::blocked_retry::BlockingRetryOperation::MqSend
        | crate::blocked_retry::BlockingRetryOperation::MqReceive => {
            syscalls::ensure_blocking_retry_mqueue_binding(proc, tid, syscall_nr, args[0] as i32)?;
        }
        crate::blocked_retry::BlockingRetryOperation::MsgSend
        | crate::blocked_retry::BlockingRetryOperation::MsgReceive => {
            syscalls::ensure_blocking_retry_sysv_message_binding(
                proc,
                tid,
                syscall_nr,
                args[0] as i32,
            )?;
        }
        crate::blocked_retry::BlockingRetryOperation::Semop => {
            syscalls::ensure_blocking_retry_sysv_semaphore_binding(
                proc,
                tid,
                syscall_nr,
                args[0] as i32,
            )?;
        }
    }
    Ok(())
}

/// Dispatch one already-owned widened-channel allocation.
///
/// `allocation_capacity` covers the header and the complete initialized data
/// area. The ordinary public export keeps its exact fixed-capacity ABI below;
/// the tokenized large-channel export can call this same implementation with a
/// larger Rust-owned allocation without weakening that public boundary.
fn handle_owned_channel_allocation(
    offset: usize,
    allocation_capacity: usize,
    pid: u32,
    retry_token: i64,
) -> i32 {
    use wasm_posix_shared::channel::*;

    if offset == 0 || allocation_capacity < MIN_CHANNEL_SIZE {
        unsafe { &mut *PROCESS_TABLE.0.get() }.clear_current_tid_binding();
        return -(if offset == 0 {
            Errno::EFAULT
        } else {
            Errno::EINVAL
        } as i32);
    }
    let scratch_start = match offset.checked_add(DATA_OFFSET) {
        Some(start) => start,
        None => {
            unsafe { &mut *PROCESS_TABLE.0.get() }.clear_current_tid_binding();
            return -(Errno::EFAULT as i32);
        }
    };
    let scratch_region =
        match ChannelScratchRegion::new(scratch_start, allocation_capacity - DATA_OFFSET) {
            Ok(region) => region,
            Err(error) => {
                unsafe { &mut *PROCESS_TABLE.0.get() }.clear_current_tid_binding();
                return -(error as i32);
            }
        };

    // Every mailbox call consumes an explicit kernel-validated task binding
    // installed by kernel_set_current_tid. Missing or stale ambient state must
    // not silently become main-thread authority.
    let has_task_binding = {
        let table = unsafe { &mut *PROCESS_TABLE.0.get() };
        table.has_current_tid_binding(pid)
    };

    // Read syscall number and args from kernel memory
    let base = offset;
    let (syscall_nr, args) = {
        // Keep this immutable view scoped to header decoding. Dispatch can
        // mutate the same channel allocation through rewritten pointer args.
        let mem = unsafe {
            let ptr = base as *const u8;
            core::slice::from_raw_parts(ptr, DATA_OFFSET)
        };
        let syscall_nr = u32::from_le_bytes([
            mem[SYSCALL_OFFSET],
            mem[SYSCALL_OFFSET + 1],
            mem[SYSCALL_OFFSET + 2],
            mem[SYSCALL_OFFSET + 3],
        ]);

        // Read i64 args (each arg is 8 bytes in the widened channel layout)
        let mut args = [0i64; ARGS_COUNT];
        for (i, arg) in args.iter_mut().enumerate() {
            let off = ARGS_OFFSET + i * ARG_SIZE;
            *arg = i64::from_le_bytes([
                mem[off],
                mem[off + 1],
                mem[off + 2],
                mem[off + 3],
                mem[off + 4],
                mem[off + 5],
                mem[off + 6],
                mem[off + 7],
            ]);
        }
        (syscall_nr, args)
    };

    // Pointer args in the channel reference kernel memory (JS copies data
    // into the data buffer at offset + DATA_OFFSET). Convert relative
    // data-buffer references: if an arg points to offset 0 of the data
    // buffer in the channel, it should be `base + DATA_OFFSET` in absolute
    // kernel memory terms. The JS layer sets pointer args as absolute
    // kernel-memory addresses, so we pass them through unchanged.

    let activation = if has_task_binding {
        activate_blocking_retry_for_current_task(syscall_nr, retry_token)
    } else {
        Err(Errno::ESRCH)
    };
    let mut outcome = if let Err(error) = activation {
        ChannelDispatchOutcome::narrow(-(error as i32))
    } else {
        match channel_scalar::result_kind(syscall_nr) {
            ChannelResultKind::I64 | ChannelResultKind::ProcessAddress => {
                dispatch_channel_wide_result(syscall_nr, &args, scratch_region)
            }
            ChannelResultKind::I32 => ChannelDispatchOutcome::narrow(dispatch_channel_syscall(
                syscall_nr,
                &args,
                scratch_region,
            )),
        }
    };
    if crate::blocked_retry::result_needs_target(syscall_nr, outcome.channel_errno) {
        // connect(2) exposes EINPROGRESS/EALREADY while a host TCP handshake
        // is pending instead of leaking HostIO's internal EAGAIN sentinel.
        // Pin before returning to JavaScript anyway: the host may sleep and
        // retry a blocking socket, and close+reuse must not redirect it.
        if let Err(error) = retain_blocking_retry_target(syscall_nr, &args) {
            outcome = ChannelDispatchOutcome::narrow(-(error as i32));
        }
    }
    if has_task_binding {
        let table = unsafe { &mut *PROCESS_TABLE.0.get() };
        if let Some(proc) = table.current_process() {
            proc.blocked_retries.clear_active();
            proc.blocked_retries.clear_dispatch();
        }
    }
    // Consume ambient task authority before cleanup can invoke a host close
    // callback. Cleanup needs no process identity, and a callback trap must
    // not leave a stale binding available to a later dispatch.
    unsafe { &mut *PROCESS_TABLE.0.get() }.clear_current_tid_binding();
    // WHY: queue mutation cannot re-enter global resource tables while those
    // tables are borrowed. This conditional outer boundary makes every
    // channel syscall fail-safe against a newly introduced ancillary drop,
    // while the ordinary hot path pays only an empty-queue check.
    finish_machine_scm_rights_cleanup_if_pending();

    // Write result back to channel
    let out = unsafe {
        let ptr = base as *mut u8;
        core::slice::from_raw_parts_mut(ptr, DATA_OFFSET)
    };

    out[RETURN_OFFSET..RETURN_OFFSET + 8].copy_from_slice(&outcome.channel_result.to_le_bytes());
    out[ERRNO_OFFSET..ERRNO_OFFSET + 4].copy_from_slice(&outcome.channel_errno.to_le_bytes());

    outcome.export_result
}

/// Dispatches to the appropriate kernel function, then writes:
///   - return value (i64) at offset+56
///   - errno (i32) at offset+64
///
/// Returns the legacy i32 syscall mirror. The channel is authoritative for
/// results wider than i32.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_handle_channel(
    scratch_ptr: usize,
    capacity: u32,
    pid: u32,
    retry_token: i64,
) -> i32 {
    use wasm_posix_shared::channel::MIN_CHANNEL_SIZE;

    if capacity as usize != MIN_CHANNEL_SIZE {
        unsafe { &mut *PROCESS_TABLE.0.get() }.clear_current_tid_binding();
        return -(Errno::EINVAL as i32);
    }
    handle_owned_channel_allocation(scratch_ptr, capacity as usize, pid, retry_token)
}

/// Convert a raw widened-channel pointer without first narrowing it through
/// `i32`.
///
/// WHY: the channel stores all arguments as signed `i64`, including pointer
/// bit patterns. A valid wasm64 pointer with bit 63 set therefore arrives as a
/// negative `i64`; interpreting the value as signed, or routing it through the
/// scalar `a1..a6` aliases below, would either reject it or discard its upper
/// 32 bits. Reinterpreting the bits as `u64` first preserves the pointer, while
/// the checked `usize` conversion rejects values that cannot fit the kernel
/// Wasm target (notably a wasm64 value presented to a wasm32 kernel).
fn checked_channel_pointer_bits(raw: i64, pointer_bits: u32) -> Result<u64, Errno> {
    channel_scalar::process_size_for_pointer_bits(raw as u64, pointer_bits).ok_or(Errno::EFAULT)
}

fn checked_channel_pointer(raw: i64) -> Result<usize, Errno> {
    let pointer = checked_channel_pointer_bits(raw, usize::BITS)?;
    usize::try_from(pointer).map_err(|_| Errno::EFAULT)
}

/// Prove that a raw widened-channel pointer names the start of the current
/// allocation and that the complete requested range belongs to it.
///
/// WHY: SEMCTL's command-dependent payload cannot use the generated fixed
/// descriptor plan, but it must not regain a bare pointer conversion that
/// proves only total Wasm addressability. The allocation start and capacity
/// remain independent requirements.
fn checked_channel_scratch_start_range(
    raw: i64,
    length: usize,
    region: ChannelScratchRegion,
) -> Result<usize, Errno> {
    let pointer = checked_channel_pointer(raw)?;
    region.checked_start_range(pointer, length)?;
    Ok(pointer)
}

fn checked_channel_process_address(
    syscall_number: u32,
    args: &[i64; 6],
    index: usize,
) -> Result<usize, Errno> {
    checked_channel_pointer(channel_scalar::process_address_argument(
        syscall_number,
        args,
        index,
    ))
}

/// Zero-extend a scalar u32 count/length into the kernel target's `usize`.
///
/// Pointer fields must never use this helper.
fn channel_u32_scalar_usize(value: i32) -> usize {
    usize::try_from(value as u32).expect("all supported kernel targets represent u32")
}

fn checked_process_size_bits(raw: u64, pointer_bits: u32) -> Result<u64, Errno> {
    channel_scalar::process_size_for_pointer_bits(raw, pointer_bits).ok_or(Errno::EINVAL)
}

fn checked_channel_process_size(
    syscall_number: u32,
    args: &[i64; 6],
    index: usize,
) -> Result<usize, Errno> {
    // WHY: getBigInt64/setBigInt64 transports the physical 64 bits through a
    // signed i64. Reinterpret before the width check so a valid wasm64 size_t
    // with bit 63 set is not mistaken for a negative length.
    let raw = channel_scalar::process_size_argument(syscall_number, args, index);
    let value = checked_process_size_bits(raw, usize::BITS)?;
    usize::try_from(value).map_err(|_| Errno::EINVAL)
}

fn reportable_channel_transfer_count(requested: usize) -> usize {
    channel_scalar::reportable_transfer_count(requested as u64) as usize
}

fn dispatch_channel_lseek(args: &[i64; 6], scratch_region: ChannelScratchRegion) -> i64 {
    if let Err(error) = unsafe { validate_channel_scratch_arguments(5, args, scratch_region) } {
        return -(error as i64);
    }
    kernel_lseek(
        args[0] as i32,
        channel_scalar::split_i64_low_argument(5, args, 1),
        channel_scalar::split_i64_high_argument(5, args, 2),
        args[3] as u32,
    )
}

fn dispatch_channel_mmap(
    args: &[i64; 6],
    scratch_region: ChannelScratchRegion,
) -> Result<usize, Errno> {
    unsafe { validate_channel_scratch_arguments(46, args, scratch_region) }?;
    let byte_offset = checked_mmap_byte_offset(channel_scalar::i64_argument(46, args, 5))?;
    let address = checked_channel_process_address(46, args, 0)?;
    let length = checked_channel_process_size(46, args, 1)?;
    let protection = args[2] as u32;
    let (_gkl, proc, advisory_locks) = unsafe { get_process_and_advisory_locks() };
    let mut host = WasmHostIO;
    let result = syscalls::sys_mmap(
        proc,
        &mut host,
        address,
        length,
        protection,
        args[3] as u32,
        args[4] as i32,
        byte_offset,
    );
    if let Ok(mapped_address) = result {
        if protection != 0 {
            ensure_memory_covers(mapped_address.saturating_add(length));
        }
    }
    deliver_pending_signals_with_locks(proc, advisory_locks, &mut host);
    result
}

fn dispatch_channel_mremap(
    args: &[i64; 6],
    scratch_region: ChannelScratchRegion,
) -> Result<usize, Errno> {
    unsafe { validate_channel_scratch_arguments(126, args, scratch_region) }?;
    let old_address = checked_channel_process_address(126, args, 0)?;
    let (_gkl, proc, advisory_locks) = unsafe { get_process_and_advisory_locks() };
    let mut host = WasmHostIO;
    let result = syscalls::sys_mremap(
        proc,
        old_address,
        checked_channel_process_size(126, args, 1)?,
        checked_channel_process_size(126, args, 2)?,
        args[3] as u32,
    );
    deliver_pending_signals_with_locks(proc, advisory_locks, &mut host);
    result
}

fn dispatch_channel_wide_result(
    nr: u32,
    args: &[i64; 6],
    scratch_region: ChannelScratchRegion,
) -> ChannelDispatchOutcome {
    match (nr, channel_scalar::result_kind(nr)) {
        (5, ChannelResultKind::I64) => {
            ChannelDispatchOutcome::exact(dispatch_channel_lseek(args, scratch_region))
        }
        (66, ChannelResultKind::I64) => ChannelDispatchOutcome::exact(kernel_time()),
        (46, ChannelResultKind::ProcessAddress) => {
            ChannelDispatchOutcome::process_address(dispatch_channel_mmap(args, scratch_region))
        }
        (48, ChannelResultKind::ProcessAddress) => {
            let result = unsafe { validate_channel_scratch_arguments(48, args, scratch_region) }
                .and_then(|_| checked_channel_process_address(48, args, 0))
                .map(|address| kernel_brk(address));
            ChannelDispatchOutcome::process_address(result)
        }
        (126, ChannelResultKind::ProcessAddress) => {
            ChannelDispatchOutcome::process_address(dispatch_channel_mremap(args, scratch_region))
        }
        (_, kind) => {
            unreachable!("channel {kind:?} result lacks a dedicated dispatcher for syscall {nr}")
        }
    }
}

// WHY: these exports gained explicit capacities together. Keep their exact
// ABI-visible signatures compile-checked beside the channel dispatcher so a
// future pointer-only call or partial signature migration cannot compile.
const _: extern "C" fn(u32, *mut i32, u32) -> i32 = kernel_pipe2;
const _: extern "C" fn(u32, u32, u32, *mut i32, u32) -> i32 = kernel_socketpair;
const _: extern "C" fn(i32, u32, u32, *mut u8, u32, *mut u32, u32) -> i32 = kernel_getsockopt;
const _: extern "C" fn(*mut u8, u32, u32, i32) -> i32 = kernel_poll;
const _: extern "C" fn(i32, *mut u8, u32, *mut u8, u32, *mut u8, u32, i32) -> i32 = kernel_select;

/// Dispatch a syscall by number with raw musl arguments.
///
/// IMPORTANT: The args are in musl's raw format, NOT the kernel_* export format.
/// For path syscalls, musl passes null-terminated string pointers without
/// explicit lengths. This function computes bounded, terminated string
/// lengths because the JS layer has already copied the strings into kernel
/// memory.
///
/// Returns the raw kernel result (negative = -errno, non-negative = success value).
fn dispatch_channel_syscall(nr: u32, args: &[i64; 6], scratch_region: ChannelScratchRegion) -> i32 {
    let validated_scratch =
        match unsafe { validate_channel_scratch_arguments(nr, args, scratch_region) } {
            Ok(validated) => validated,
            Err(error) => return -(error as i32),
        };

    // Scalar arguments retain the syscall ABI's existing i32 interpretation.
    // Pointer and process-size arguments must instead use the checked macros
    // below so wasm64 high bits are never lost through these scalar aliases.
    let a1 = args[0] as i32;
    let a2 = args[1] as i32;
    let a3 = args[2] as i32;
    let a4 = args[3] as i32;
    let a5 = args[4] as i32;
    let a6 = args[5] as i32;

    // Raw pointers below are process-space addresses or signal-handler values,
    // never kernel scratch. Scratch dereferences must use the validated
    // const/mut macros so allocation capacity remains part of their proof.
    macro_rules! process_address {
        ($index:literal) => {
            match checked_channel_process_address(nr, args, $index) {
                Ok(pointer) => pointer,
                Err(error) => return -(error as i32),
            }
        };
    }
    macro_rules! conditional_process_address {
        ($index:literal) => {
            match checked_channel_pointer(args[$index]) {
                Ok(pointer) => pointer,
                Err(error) => return -(error as i32),
            }
        };
    }
    macro_rules! process_size {
        ($index:literal) => {
            match checked_channel_process_size(nr, args, $index) {
                Ok(size) => size,
                Err(error) => return -(error as i32),
            }
        };
    }
    macro_rules! process_size_u32 {
        ($index:literal) => {
            match u32::try_from(process_size!($index)) {
                Ok(size) => size,
                Err(_) => return -(Errno::EINVAL as i32),
            }
        };
    }
    macro_rules! channel_const_ptr {
        ($index:literal, $pointee:ty) => {
            match validated_scratch.pointer($index) {
                Ok(pointer) => pointer as *const $pointee,
                Err(error) => return -(error as i32),
            }
        };
    }
    macro_rules! channel_mut_ptr {
        ($index:literal, $pointee:ty) => {
            match validated_scratch.pointer($index) {
                Ok(pointer) => pointer as *mut $pointee,
                Err(error) => return -(error as i32),
            }
        };
    }
    macro_rules! channel_const_slice {
        ($index:literal, $length:expr) => {{
            let pointer = match validated_scratch.pointer($index) {
                Ok(pointer) => pointer,
                Err(error) => return -(error as i32),
            };
            let length: usize = $length;
            if let Err(error) = scratch_region.checked_range(pointer, length) {
                return -(error as i32);
            }
            // The argument validator and this allocation-capacity check both
            // run before the private slice-based syscall adapter can observe
            // the bytes.
            if length == 0 {
                // WHY: Rust requires a non-null, aligned pointer even for an
                // empty raw slice. Keep that language invariant automatic for
                // every channel transfer instead of relying on each syscall
                // to remember its own zero-length special case.
                &[]
            } else {
                unsafe { slice::from_raw_parts(pointer as *const u8, length) }
            }
        }};
    }
    macro_rules! channel_mut_slice {
        ($index:literal, $length:expr) => {{
            let pointer = match validated_scratch.pointer($index) {
                Ok(pointer) => pointer,
                Err(error) => return -(error as i32),
            };
            let length: usize = $length;
            if let Err(error) = scratch_region.checked_range(pointer, length) {
                return -(error as i32);
            }
            // WHY: a Rust slice, rather than a bare exported pointer, carries
            // the exact live channel extent into the scalar I/O adapter.
            if length == 0 {
                // See channel_const_slice: an ignored zero-length pointer must
                // never be used to construct a raw Rust slice.
                &mut []
            } else {
                unsafe { slice::from_raw_parts_mut(pointer as *mut u8, length) }
            }
        }};
    }
    macro_rules! channel_cstr_len {
        ($pointer:expr) => {{
            let pointer = $pointer;
            match unsafe { checked_cstr_len(pointer, scratch_region) } {
                Ok(length) => length,
                Err(error) => return -(error as i32),
            }
        }};
    }

    // Syscall number constants (must match libc/glue/syscall_glue.c)
    match nr {
        // Process info (0-arg)
        28 => kernel_getpid(),         // SYS_GETPID
        29 => kernel_getppid(),        // SYS_GETPPID
        30 => kernel_getuid() as i32,  // SYS_GETUID
        31 => kernel_geteuid() as i32, // SYS_GETEUID
        32 => kernel_getgid() as i32,  // SYS_GETGID
        33 => kernel_getegid() as i32, // SYS_GETEGID
        89 => kernel_getpgrp() as i32, // SYS_GETPGRP
        92 => kernel_setsid() as i32,  // SYS_SETSID
        214 => {
            // SYS_GETPGID
            let _gkl = GklGuard::acquire();
            let table = unsafe { &*PROCESS_TABLE.0.get() };
            let pid = a1 as u32;
            let effective_pid = if pid == 0 { table.current_pid() } else { pid };
            match table.get(effective_pid) {
                Some(target) => target.pgid as i32,
                None => -(Errno::ESRCH as i32),
            }
        }

        // File operations — musl: (path, flags, mode)
        1 => {
            // SYS_OPEN
            let p = channel_const_ptr!(0, u8);
            let len = channel_cstr_len!(p);
            kernel_open(p, len, a2 as u32, a3 as u32)
        }
        2 => {
            // SYS_CLOSE
            // Check if this is a mqueue descriptor
            let mq_table = unsafe { crate::mqueue::global_mqueue_table() };
            if mq_table.is_mqd(a1 as u32) {
                match mq_table.mq_close(a1 as u32) {
                    Ok(()) => 0,
                    Err(e) => -(e as i32),
                }
            } else {
                kernel_close(a1)
            }
        }
        3 => channel_read(a1, channel_mut_slice!(1, process_size!(2))), // SYS_READ: (fd, buf, count)
        4 => channel_write(a1, channel_const_slice!(1, process_size!(2))), // SYS_WRITE: (fd, buf, count)
        119 => {
            // SYS__LLSEEK: (fd, off_hi, off_lo, result_ptr, whence)
            let result = kernel_lseek(
                a1,
                channel_scalar::split_i64_low_argument(119, args, 2),
                channel_scalar::split_i64_high_argument(119, args, 1),
                a5 as u32,
            );
            if result < 0 {
                result as i32
            } else {
                // Write 64-bit result to result_ptr
                let ptr = channel_mut_ptr!(3, u8);
                unsafe {
                    let bytes = result.to_le_bytes();
                    for i in 0..8 {
                        *ptr.add(i) = bytes[i];
                    }
                }
                0
            }
        }
        6 => {
            let stat_pointer = channel_mut_ptr!(1, u8);
            kernel_fstat(a1, stat_pointer)
        }
        64 => channel_pread(
            a1,
            channel_mut_slice!(1, process_size!(2)),
            channel_scalar::i64_argument(64, args, 3),
        ), // SYS_PREAD: (fd, buf, count, offset)
        65 => channel_pwrite(
            a1,
            channel_const_slice!(1, process_size!(2)),
            channel_scalar::i64_argument(65, args, 3),
        ), // SYS_PWRITE: (fd, buf, count, offset)

        // FD operations
        7 => kernel_dup(a1),                        // SYS_DUP
        8 => kernel_dup2(a1, a2),                   // SYS_DUP2
        77 => kernel_dup3(a1, a2, a3 as u32),       // SYS_DUP3
        9 => kernel_pipe(channel_mut_ptr!(0, i32)), // SYS_PIPE: (pipefd_ptr)
        78 => kernel_pipe2(
            a2 as u32,
            channel_mut_ptr!(0, i32),
            wasm_posix_shared::kernel_scratch_wire::FD_PAIR_BYTES,
        ), // SYS_PIPE2: (pipefd_ptr, flags) → kernel wants (flags, pipefd_ptr, capacity)
        10 => {
            // SYS_FCNTL: (fd, cmd, arg)
            match a2 as u32 {
                // Lock commands: arg is a pointer to struct flock
                // POSIX: 5=F_GETLK, 6=F_SETLK, 7=F_SETLKW; 12-14=64-bit variants
                // OFD:   36=F_OFD_GETLK, 37=F_OFD_SETLK, 38=F_OFD_SETLKW
                5 | 6 | 7 | 12 | 13 | 14 | 36 | 37 | 38 => {
                    kernel_fcntl_lock(a1, a2 as u32, channel_mut_ptr!(2, u8))
                }
                _ => kernel_fcntl(a1, a2 as u32, a3 as u32),
            }
        }
        121 => kernel_flock(a1, a2 as u32), // SYS_FLOCK

        // Stat — musl: (path, stat_buf) / (path, stat_buf) / (dirfd, path, stat_buf, flags)
        11 => {
            // SYS_STAT
            let p = channel_const_ptr!(0, u8);
            let len = channel_cstr_len!(p);
            let stat_pointer = channel_mut_ptr!(1, u8);
            kernel_stat(p, len, stat_pointer)
        }
        12 => {
            // SYS_LSTAT
            let p = channel_const_ptr!(0, u8);
            let len = channel_cstr_len!(p);
            let stat_pointer = channel_mut_ptr!(1, u8);
            kernel_lstat(p, len, stat_pointer)
        }
        93 => {
            // SYS_FSTATAT: (dirfd, path, stat_buf, flags)
            let p = channel_const_ptr!(1, u8);
            let len = channel_cstr_len!(p);
            let stat_pointer = channel_mut_ptr!(2, u8);
            kernel_fstatat(a1, p, len, stat_pointer, a4 as u32)
        }

        // Directory operations — musl passes null-terminated paths
        13 => {
            // SYS_MKDIR: (path, mode)
            let p = channel_const_ptr!(0, u8);
            let len = channel_cstr_len!(p);
            kernel_mkdir(p, len, a2 as u32)
        }
        14 => {
            // SYS_RMDIR: (path)
            let p = channel_const_ptr!(0, u8);
            let len = channel_cstr_len!(p);
            kernel_rmdir(p, len)
        }
        15 => {
            // SYS_UNLINK: (path)
            let p = channel_const_ptr!(0, u8);
            let len = channel_cstr_len!(p);
            kernel_unlink(p, len)
        }
        16 => {
            // SYS_RENAME: (old_path, new_path)
            let old = channel_const_ptr!(0, u8);
            let new = channel_const_ptr!(1, u8);
            kernel_rename(old, channel_cstr_len!(old), new, channel_cstr_len!(new))
        }
        17 => {
            // SYS_LINK: (old_path, new_path)
            let old = channel_const_ptr!(0, u8);
            let new = channel_const_ptr!(1, u8);
            kernel_link(old, channel_cstr_len!(old), new, channel_cstr_len!(new))
        }
        18 => {
            // SYS_SYMLINK: (target, linkpath)
            let tgt = channel_const_ptr!(0, u8);
            let lnk = channel_const_ptr!(1, u8);
            kernel_symlink(tgt, channel_cstr_len!(tgt), lnk, channel_cstr_len!(lnk))
        }
        19 => {
            // SYS_READLINK: (path, buf, bufsiz)
            let p = channel_const_ptr!(0, u8);
            let len = channel_cstr_len!(p);
            kernel_readlink(p, len, channel_mut_ptr!(1, u8), process_size_u32!(2))
        }
        20 => {
            // SYS_CHMOD: (path, mode)
            let p = channel_const_ptr!(0, u8);
            let len = channel_cstr_len!(p);
            kernel_chmod(p, len, a2 as u32)
        }
        21 => {
            // SYS_CHOWN: (path, uid, gid)
            let p = channel_const_ptr!(0, u8);
            let len = channel_cstr_len!(p);
            kernel_chown(p, len, a2 as u32, a3 as u32)
        }
        22 => {
            // SYS_ACCESS: (path, mode)
            let p = channel_const_ptr!(0, u8);
            let len = channel_cstr_len!(p);
            kernel_access(p, len, a2 as u32)
        }
        23 => kernel_getcwd(channel_mut_ptr!(0, u8), process_size_u32!(1)), // SYS_GETCWD: (buf, size)
        24 => {
            // SYS_CHDIR: (path)
            let p = channel_const_ptr!(0, u8);
            let len = channel_cstr_len!(p);
            kernel_chdir(p, len)
        }
        127 => kernel_fchdir(a1), // SYS_FCHDIR
        25 => {
            // SYS_OPENDIR: (path)
            let p = channel_const_ptr!(0, u8);
            let len = channel_cstr_len!(p);
            kernel_opendir(p, len)
        }
        26 => kernel_readdir(
            a1,
            channel_mut_ptr!(1, u8),
            channel_mut_ptr!(2, u8),
            process_size_u32!(3),
        ), // SYS_READDIR
        27 => kernel_closedir(a1), // SYS_CLOSEDIR
        122 => kernel_getdents64(a1, channel_mut_ptr!(1, u8), process_size_u32!(2)), // SYS_GETDENTS64

        // Process control
        34 => {
            kernel_exit(a1);
            0
        } // SYS_EXIT (thread exit)
        387 => {
            kernel_exit(a1);
            0
        } // SYS_EXIT_GROUP (process exit)
        35 => kernel_kill(a1, a2 as u32), // SYS_KILL
        38 => kernel_raise(a1 as u32),    // SYS_RAISE

        // Signals
        36 => kernel_sigaction(
            a1 as u32,
            channel_const_ptr!(1, u8),
            channel_mut_ptr!(2, u8),
        ), // SYS_SIGACTION
        37 => {
            // SYS_SIGPROCMASK: (how, set_ptr, oldset_ptr, sigsetsize)
            // musl passes pointers to sigset_t (8 bytes). Read set from pointer,
            // call kernel, write old set to output pointer.
            // POSIX: if set is NULL, the signal mask is not changed (query only).
            let (_gkl, proc, advisory_locks) = unsafe { get_process_and_advisory_locks() };
            if args[1] != 0 {
                let ptr = channel_const_ptr!(1, u32);
                let (set_lo, set_hi) = unsafe { (*ptr, *ptr.add(1)) };
                let set = ((set_hi as u64) << 32) | (set_lo as u64);
                // Call sys_sigprocmask directly — kernel_sigprocmask returns
                // old mask as i64 which is negative when bit 63 (signal 64) is
                // set, causing the old `if result < 0` check to misfire.
                let old_mask = match syscalls::sys_sigprocmask(proc, a1 as u32, set) {
                    Ok(old) => old,
                    Err(e) => return -(e as i32),
                };
                proc.acknowledge_caught_handler_mask_restore_for(
                    syscalls::current_tid_for_process(proc),
                );
                if args[2] != 0 {
                    let ptr = channel_mut_ptr!(2, u8);
                    unsafe {
                        let bytes = old_mask.to_le_bytes();
                        for i in 0..8 {
                            *ptr.add(i) = bytes[i];
                        }
                    }
                }
                let mut host = WasmHostIO;
                deliver_pending_signals_with_locks(proc, advisory_locks, &mut host);
                0
            } else {
                // set is NULL: just read the current mask without modifying
                if args[2] != 0 {
                    let tid = syscalls::current_tid_for_process(proc);
                    let ptr = channel_mut_ptr!(2, u8);
                    unsafe {
                        let bytes = proc.blocked_for(tid).to_le_bytes();
                        for i in 0..8 {
                            *ptr.add(i) = bytes[i];
                        }
                    }
                }
                0
            }
        }
        73 => {
            let handler = match channel_scalar::exact_u32_argument(73, args, 1) {
                Some(handler) => handler,
                None => return -(Errno::EINVAL as i32),
            };
            kernel_signal(a1 as u32, handler)
        } // SYS_SIGNAL
        39 => kernel_alarm(a1 as u32), // SYS_ALARM
        110 => {
            // SYS_SIGSUSPEND: (mask_ptr, sigsetsize)
            let (mask_lo, mask_hi) = if args[0] != 0 {
                let ptr = channel_const_ptr!(0, u32);
                unsafe { (*ptr, *ptr.add(1)) }
            } else {
                (0u32, 0u32)
            };
            kernel_sigsuspend(mask_lo, mask_hi)
        }
        111 => kernel_pause(), // SYS_PAUSE
        206 => {
            // SYS_RT_SIGPENDING: (set_ptr, sigsetsize)
            let (_gkl, proc, advisory_locks) = unsafe { get_process_and_advisory_locks() };
            if args[0] != 0 {
                let ptr = channel_mut_ptr!(0, u8);
                unsafe {
                    let bytes = proc
                        .pending_for(syscalls::current_tid_for_process(proc))
                        .to_le_bytes();
                    for i in 0..8 {
                        *ptr.add(i) = bytes[i];
                    }
                }
            }
            0
        }
        207 => {
            // SYS_RT_SIGTIMEDWAIT: (mask_ptr, info_ptr, timeout_ptr, sigsetsize)
            let model = match crate::process_wire::ProcessDataModel::from_width(args[5]) {
                Ok(model) => model,
                Err(error) => return -(error as i32),
            };
            let (_gkl, proc, advisory_locks) = unsafe { get_process_and_advisory_locks() };
            let mut host = WasmHostIO;
            // Read the 64-bit signal mask from the pointer
            let mask = if args[0] != 0 {
                let p = channel_const_ptr!(0, u8);
                let mut bytes = [0u8; 8];
                unsafe {
                    for i in 0..8 {
                        bytes[i] = *p.add(i);
                    }
                }
                u64::from_le_bytes(bytes)
            } else {
                0
            };
            // Read timeout from timespec pointer (time64: i64 sec + i64 nsec)
            let timeout_ms = if args[2] != 0 {
                let p = channel_const_ptr!(2, u8);
                let mut sec_bytes = [0u8; 8];
                let mut nsec_bytes = [0u8; 8];
                unsafe {
                    for i in 0..8 {
                        sec_bytes[i] = *p.add(i);
                    }
                    for i in 0..8 {
                        nsec_bytes[i] = *p.add(8 + i);
                    }
                }
                let sec = i64::from_le_bytes(sec_bytes);
                let nsec = i64::from_le_bytes(nsec_bytes);
                (sec * 1000 + nsec / 1_000_000) as i32
            } else {
                -1 // NULL timeout = wait indefinitely
            };
            let result = match syscalls::sys_sigtimedwait(proc, &mut host, mask, timeout_ms) {
                Ok((sig, si_value, si_code, siginfo_word_1, siginfo_word_2)) => {
                    // Write siginfo_t if pointer is non-null
                    if args[1] != 0 {
                        let p = channel_mut_ptr!(1, u8);
                        let mut encoded = alloc::vec![0; model.siginfo_size()];
                        if let Err(error) = crate::process_wire::write_siginfo(
                            &mut encoded,
                            crate::process_wire::NativeSiginfo {
                                signo: sig as i32,
                                code: si_code,
                                word_1: siginfo_word_1,
                                // Keep uid/timer-overrun bits lossless across
                                // the signed/unsigned siginfo union views.
                                word_2_bits: siginfo_word_2 as u32,
                                value_bits: si_value,
                            },
                            model,
                        ) {
                            return -(error as i32);
                        }
                        // WHY: encode the complete native object before
                        // replacing the capacity-checked scratch destination.
                        // The host holds one exclusive synchronous lease.
                        let output = unsafe { slice::from_raw_parts_mut(p, model.siginfo_size()) };
                        output.copy_from_slice(&encoded);
                    }
                    sig as i32
                }
                Err(e) => -(e as i32),
            };
            deliver_pending_signals_with_locks(proc, advisory_locks, &mut host);
            result
        }

        // Time
        40 => kernel_clock_gettime(a1 as u32, channel_mut_ptr!(1, u8)), // SYS_CLOCK_GETTIME
        41 => kernel_nanosleep(channel_const_ptr!(0, u8)),              // SYS_NANOSLEEP
        123 => kernel_clock_getres(a1 as u32, channel_mut_ptr!(1, u8)), // SYS_CLOCK_GETRES
        124 => kernel_clock_nanosleep(a1 as u32, a2 as u32, channel_const_ptr!(2, u8)), // SYS_CLOCK_NANOSLEEP
        125 => {
            // SYS_UTIMENSAT: (dirfd, path, times, flags)
            // path can be NULL (0) for futimens(fd, times) → utimensat(fd, NULL, times, 0)
            let (p, len) = if args[1] == 0 {
                (core::ptr::null(), 0u32)
            } else {
                let p = channel_const_ptr!(1, u8);
                (p, channel_cstr_len!(p))
            };
            kernel_utimensat(a1, p, len, channel_const_ptr!(2, u8), a4 as u32)
        }
        68 => kernel_usleep(a1 as u32), // SYS_USLEEP

        // Memory
        47 => kernel_munmap(process_address!(0), process_size!(1)), // SYS_MUNMAP
        49 => kernel_mprotect(process_address!(0), process_size!(1), a3 as u32), // SYS_MPROTECT
        128 => kernel_madvise(process_address!(0), process_size!(1), a3 as u32), // SYS_MADVISE

        // Environment — musl: name/value are null-terminated strings
        42 => kernel_isatty(a1), // SYS_ISATTY
        43 => {
            // SYS_GETENV: (name, buf, buf_len)
            let p = channel_const_ptr!(0, u8);
            let len = channel_cstr_len!(p);
            kernel_getenv(p, len, channel_mut_ptr!(1, u8), process_size_u32!(2))
        }
        44 => {
            // SYS_SETENV: (name, value, overwrite)
            let n = channel_const_ptr!(0, u8);
            let v = channel_const_ptr!(1, u8);
            kernel_setenv(n, channel_cstr_len!(n), v, channel_cstr_len!(v), a3 as u32)
        }
        45 => {
            // SYS_UNSETENV: (name)
            let p = channel_const_ptr!(0, u8);
            let len = channel_cstr_len!(p);
            kernel_unsetenv(p, len)
        }
        74 => kernel_umask(a1 as u32) as i32, // SYS_UMASK
        75 => kernel_uname(channel_mut_ptr!(0, u8), 390), // SYS_UNAME (musl passes 1 arg; struct utsname = 6x65 = 390)
        76 => kernel_sysconf(a1) as i32,                  // SYS_SYSCONF
        120 => kernel_getrandom(channel_mut_ptr!(0, u8), process_size_u32!(1), a3 as u32), // SYS_GETRANDOM
        109 => {
            // SYS_REALPATH: (path, buf, buf_len)
            let p = channel_const_ptr!(0, u8);
            let len = channel_cstr_len!(p);
            kernel_realpath(p, len, channel_mut_ptr!(1, u8), process_size_u32!(2))
        }

        // Sockets
        50 => kernel_socket(a1 as u32, a2 as u32, a3 as u32), // SYS_SOCKET
        61 => kernel_socketpair(
            a1 as u32,
            a2 as u32,
            a3 as u32,
            channel_mut_ptr!(3, i32),
            wasm_posix_shared::kernel_scratch_wire::FD_PAIR_BYTES,
        ), // SYS_SOCKETPAIR
        51 => kernel_bind(
            a1,
            channel_const_ptr!(1, u8),
            channel_scalar::u32_argument(51, args, 2),
        ), // SYS_BIND
        52 => kernel_listen(a1, a2 as u32),                   // SYS_LISTEN
        53 => kernel_accept4(a1, channel_mut_ptr!(1, u8), channel_mut_ptr!(2, u8), 0), // SYS_ACCEPT
        384 => kernel_accept4(
            a1,
            channel_mut_ptr!(1, u8),
            channel_mut_ptr!(2, u8),
            a4 as u32,
        ), // SYS_ACCEPT4
        54 => kernel_connect(
            a1,
            channel_const_ptr!(1, u8),
            channel_scalar::u32_argument(54, args, 2),
        ), // SYS_CONNECT
        55 => kernel_send(
            a1,
            channel_const_ptr!(1, u8),
            process_size_u32!(2),
            a4 as u32,
        ), // SYS_SEND
        56 => kernel_recv(a1, channel_mut_ptr!(1, u8), process_size_u32!(2), a4 as u32), // SYS_RECV
        57 => kernel_shutdown(a1, a2 as u32),                 // SYS_SHUTDOWN
        58 => {
            let optval_pointer = channel_mut_ptr!(3, u8);
            let optlen_pointer = channel_mut_ptr!(4, u32);
            let optval_capacity = if optval_pointer.is_null() || optlen_pointer.is_null() {
                0
            } else {
                // The descriptor validator proved this exact four-byte slot
                // before the staged value is used as a destination capacity.
                unsafe { core::ptr::read_unaligned(optlen_pointer) }
            };
            kernel_getsockopt(
                a1,
                a2 as u32,
                a3 as u32,
                optval_pointer,
                optval_capacity,
                optlen_pointer,
                if optlen_pointer.is_null() {
                    0
                } else {
                    wasm_posix_shared::kernel_scratch_wire::SOCKLEN_BYTES
                },
            )
        } // SYS_GETSOCKOPT
        59 => kernel_setsockopt_for_process_width(
            a1,
            a2 as u32,
            a3 as u32,
            channel_const_ptr!(3, u8),
            channel_scalar::u32_argument(59, args, 4),
            a6 as u32,
        ), // SYS_SETSOCKOPT
        114 => kernel_getsockname(a1, channel_mut_ptr!(1, u8), channel_mut_ptr!(2, u32)), // SYS_GETSOCKNAME
        115 => kernel_getpeername(a1, channel_mut_ptr!(1, u8), channel_mut_ptr!(2, u32)), // SYS_GETPEERNAME
        140 => {
            // SYS_GETADDRINFO: (name, result_buf)
            let p = channel_const_ptr!(0, u8);
            let len = channel_cstr_len!(p);
            kernel_getaddrinfo(p, len, channel_mut_ptr!(1, u8))
        }
        137 => kernel_sendmsg(a1, channel_const_ptr!(1, u8), a3 as u32, 0), // SYS_SENDMSG
        138 => kernel_recvmsg(a1, channel_mut_ptr!(1, u8), a3 as u32, 0),   // SYS_RECVMSG
        62 => kernel_sendto(
            a1,
            channel_const_ptr!(1, u8),
            process_size_u32!(2),
            a4 as u32,
            channel_const_ptr!(4, u8),
            channel_scalar::u32_argument(62, args, 5),
        ), // SYS_SENDTO
        63 => kernel_recvfrom(
            a1,
            channel_mut_ptr!(1, u8),
            process_size_u32!(2),
            a4 as u32,
            channel_mut_ptr!(4, u8),
            channel_mut_ptr!(5, u32),
        ), // SYS_RECVFROM

        // Poll/select
        60 => {
            let count = process_size_u32!(1);
            let Some(capacity) =
                count.checked_mul(core::mem::size_of::<wasm_posix_shared::WasmPollFd>() as u32)
            else {
                return -(Errno::EOVERFLOW as i32);
            };
            kernel_poll(channel_mut_ptr!(0, u8), capacity, count, a3)
        } // SYS_POLL
        251 => kernel_ppoll(
            channel_mut_ptr!(0, u8),
            process_size_u32!(1),
            a3,
            a4 as u32,
            a5 as u32,
            a6 as u32,
        ), // SYS_PPOLL
        103 => {
            let read_pointer = channel_mut_ptr!(1, u8);
            let write_pointer = channel_mut_ptr!(2, u8);
            let except_pointer = channel_mut_ptr!(3, u8);
            let fd_set_capacity = |pointer: *mut u8| {
                if pointer.is_null() {
                    0
                } else {
                    wasm_posix_shared::select::FD_SET_BYTES as u32
                }
            };
            kernel_select(
                a1,
                read_pointer,
                fd_set_capacity(read_pointer),
                write_pointer,
                fd_set_capacity(write_pointer),
                except_pointer,
                fd_set_capacity(except_pointer),
                a5 as i32,
            )
        } // SYS_SELECT

        // Terminal
        70 => kernel_tcgetattr(
            a1,
            channel_mut_ptr!(1, u8),
            wasm_posix_shared::ioctl_contract::TERMIOS_SIZE,
        ), // SYS_TCGETATTR
        71 => kernel_tcsetattr(
            a1,
            a2 as u32,
            channel_const_ptr!(2, u8),
            wasm_posix_shared::ioctl_contract::TERMIOS_SIZE,
        ), // SYS_TCSETATTR
        72 => {
            let request = a2 as u32;
            let argument = match wasm_posix_shared::ioctl_contract::request_contract(request)
                .map(|contract| contract.arg_kind)
            {
                Some(wasm_posix_shared::ioctl_contract::IoctlArgKind::Pointer) => {
                    channel_mut_ptr!(2, u8)
                }
                // WHY: scalar ioctl values share the pointer slot. The
                // host normalizes them to their low i32 bits, and None or
                // unknown requests carry zero. Pointer validation here
                // would misclassify a negative scalar as an address.
                _ => channel_u32_scalar_usize(a3) as *mut u8,
            };
            kernel_ioctl(a1, request, argument, a4 as u32, a6 as u32)
        } // SYS_IOCTL

        // File system
        79 => kernel_ftruncate(a1, channel_scalar::i64_argument(79, args, 1)), // SYS_FTRUNCATE: (fd, length)
        80 => kernel_fsync(a1),                                                // SYS_FSYNC
        85 => {
            // SYS_TRUNCATE: (path, length)
            let p = channel_const_ptr!(0, u8);
            let plen = channel_cstr_len!(p);
            kernel_truncate(p, plen, channel_scalar::i64_argument(85, args, 1))
        }
        86 => kernel_fdatasync(a1),                    // SYS_FDATASYNC
        87 => kernel_fchmod(a1, a2 as u32),            // SYS_FCHMOD
        88 => kernel_fchown(a1, a2 as u32, a3 as u32), // SYS_FCHOWN
        129 => {
            // SYS_STATFS64: (path, sizeof, statfs_buf)
            let p = channel_const_ptr!(0, u8);
            let len = channel_cstr_len!(p);
            let output = channel_mut_ptr!(2, u8);
            kernel_statfs(p, len, output, args[5])
        }
        130 => {
            // SYS_FSTATFS64: (fd, sizeof, buf)
            let output = channel_mut_ptr!(2, u8);
            kernel_fstatfs(a1, output, args[5])
        }
        81 => channel_writev(a1, channel_const_ptr!(1, u8), a3, scratch_region), // SYS_WRITEV
        82 => channel_readv(a1, channel_mut_ptr!(1, u8), a3, scratch_region),    // SYS_READV
        295 => channel_preadv(
            a1,
            channel_mut_ptr!(1, u8),
            a3,
            channel_scalar::split_i64_low_argument(295, args, 3),
            channel_scalar::split_i64_high_argument(295, args, 4),
            scratch_region,
        ), // SYS_PREADV
        296 => channel_pwritev(
            a1,
            channel_const_ptr!(1, u8),
            a3,
            channel_scalar::split_i64_low_argument(296, args, 3),
            channel_scalar::split_i64_high_argument(296, args, 4),
            scratch_region,
        ), // SYS_PWRITEV
        294 => kernel_sendfile_with_count(
            a1,
            a2,
            channel_mut_ptr!(2, u8),
            reportable_channel_transfer_count(process_size!(3)),
        ), // SYS_SENDFILE

        // *at variants — musl: (dirfd, path, ...) without explicit path_len
        69 => {
            // SYS_OPENAT: (dirfd, path, flags, mode)
            let p = channel_const_ptr!(1, u8);
            let len = channel_cstr_len!(p);
            kernel_openat(a1, p, len, a3 as u32, a4 as u32)
        }
        94 => {
            // SYS_UNLINKAT: (dirfd, path, flags)
            let p = channel_const_ptr!(1, u8);
            let len = channel_cstr_len!(p);
            kernel_unlinkat(a1, p, len, a3 as u32)
        }
        95 => {
            // SYS_MKDIRAT: (dirfd, path, mode)
            let p = channel_const_ptr!(1, u8);
            let len = channel_cstr_len!(p);
            kernel_mkdirat(a1, p, len, a3 as u32)
        }
        96 => {
            // SYS_RENAMEAT: (olddirfd, oldpath, newdirfd, newpath)
            let old = channel_const_ptr!(1, u8);
            let new = channel_const_ptr!(3, u8);
            kernel_renameat(
                a1,
                old,
                channel_cstr_len!(old),
                a3,
                new,
                channel_cstr_len!(new),
            )
        }
        97 => {
            // SYS_FACCESSAT: (dirfd, path, mode, flags)
            let p = channel_const_ptr!(1, u8);
            let len = channel_cstr_len!(p);
            kernel_faccessat(a1, p, len, a3 as u32, a4 as u32)
        }
        98 => {
            // SYS_FCHMODAT: (dirfd, path, mode, flags)
            let p = channel_const_ptr!(1, u8);
            let len = channel_cstr_len!(p);
            kernel_fchmodat(a1, p, len, a3 as u32, a4 as u32)
        }
        99 => {
            // SYS_FCHOWNAT: (dirfd, path, uid, gid, flags)
            let p = channel_const_ptr!(1, u8);
            let len = channel_cstr_len!(p);
            kernel_fchownat(a1, p, len, a3 as u32, a4 as u32, a5 as u32)
        }
        100 => {
            // SYS_LINKAT: (olddirfd, oldpath, newdirfd, newpath, flags)
            let old = channel_const_ptr!(1, u8);
            let new = channel_const_ptr!(3, u8);
            kernel_linkat(
                a1,
                old,
                channel_cstr_len!(old),
                a3,
                new,
                channel_cstr_len!(new),
                a5 as u32,
            )
        }
        101 => {
            // SYS_SYMLINKAT: (target, newdirfd, linkpath)
            let tgt = channel_const_ptr!(0, u8);
            let lnk = channel_const_ptr!(2, u8);
            kernel_symlinkat(tgt, channel_cstr_len!(tgt), a2, lnk, channel_cstr_len!(lnk))
        }
        102 => {
            // SYS_READLINKAT: (dirfd, path, buf, bufsiz)
            let p = channel_const_ptr!(1, u8);
            let len = channel_cstr_len!(p);
            kernel_readlinkat(a1, p, len, channel_mut_ptr!(2, u8), process_size_u32!(3))
        }

        // Resource limits
        83 => kernel_getrlimit(a1 as u32, channel_mut_ptr!(1, u8)), // SYS_GETRLIMIT
        84 => kernel_setrlimit(a1 as u32, channel_const_ptr!(1, u8)), // SYS_SETRLIMIT
        250 => {
            // SYS_PRLIMIT64: (pid, resource, new_rlim_ptr, old_rlim_ptr)
            // Get old limits first, then set new
            let mut ret = 0i32;
            if args[3] != 0 {
                ret = kernel_getrlimit(a2 as u32, channel_mut_ptr!(3, u8));
            }
            if ret >= 0 && args[2] != 0 {
                ret = kernel_setrlimit(a2 as u32, channel_const_ptr!(2, u8));
            }
            ret
        }

        // UID/GID
        90 => {
            // SYS_SETPGID
            let pid = a1 as u32;
            let pgid = a2 as u32;
            let _gkl = GklGuard::acquire();
            let table = unsafe { &mut *PROCESS_TABLE.0.get() };
            let caller_pid = table.current_pid();
            let effective_pid = if pid == 0 { caller_pid } else { pid };
            if effective_pid == caller_pid {
                // Self — use syscalls::sys_setpgid
                match table.current_process_and_advisory_locks() {
                    Some((proc, advisory_locks)) => match syscalls::sys_setpgid(proc, pid, pgid) {
                        Ok(()) => {
                            let mut host = WasmHostIO;
                            deliver_pending_signals_with_locks(proc, advisory_locks, &mut host);
                            0
                        }
                        Err(e) => -(e as i32),
                    },
                    None => -(Errno::ESRCH as i32),
                }
            } else if (pgid as i32) < 0 {
                -(Errno::EINVAL as i32)
            } else {
                let new_pgid = if pgid == 0 { effective_pid } else { pgid };
                let caller_sid = match table.get(caller_pid) {
                    Some(caller) => caller.sid,
                    None => return -(Errno::ESRCH as i32),
                };
                match table.get_mut(effective_pid) {
                    Some(target) => {
                        // POSIX: can only setpgid on a child of the calling process
                        if target.ppid != caller_pid {
                            -(Errno::ESRCH as i32)
                        } else if target.has_exec {
                            // POSIX: cannot setpgid on a child that has called exec
                            -(Errno::EACCES as i32)
                        } else if target.sid != caller_sid {
                            // POSIX: both processes must be in the same session
                            -(Errno::EPERM as i32)
                        } else if target.is_session_leader {
                            // POSIX: cannot change pgid of a session leader
                            -(Errno::EPERM as i32)
                        } else {
                            target.pgid = new_pgid;
                            table.prune_empty_limbo_groups();
                            0
                        }
                    }
                    None => -(Errno::ESRCH as i32),
                }
            }
        }
        91 => {
            // SYS_GETSID
            let _gkl = GklGuard::acquire();
            let table = unsafe { &*PROCESS_TABLE.0.get() };
            let pid = a1 as u32;
            let effective_pid = if pid == 0 { table.current_pid() } else { pid };
            match table.get(effective_pid) {
                Some(target) => target.sid as i32,
                None => -(Errno::ESRCH as i32),
            }
        }
        104 => kernel_setuid(a1 as u32),  // SYS_SETUID
        105 => kernel_setgid(a1 as u32),  // SYS_SETGID
        106 => kernel_seteuid(a1 as u32), // SYS_SETEUID
        107 => kernel_setegid(a1 as u32), // SYS_SETEGID
        108 => kernel_getrusage(
            a1,
            channel_mut_ptr!(1, u8),
            wasm_posix_shared::WASM_RUSAGE_WIRE_SIZE,
        ), // SYS_GETRUSAGE (musl passes 2 args)
        131 => kernel_setresuid(a1 as u32, a2 as u32, a3 as u32), // SYS_SETRESUID
        132 => kernel_getresuid(
            channel_mut_ptr!(0, u32),
            channel_mut_ptr!(1, u32),
            channel_mut_ptr!(2, u32),
        ), // SYS_GETRESUID
        133 => kernel_setresgid(a1 as u32, a2 as u32, a3 as u32), // SYS_SETRESGID
        134 => kernel_getresgid(
            channel_mut_ptr!(0, u32),
            channel_mut_ptr!(1, u32),
            channel_mut_ptr!(2, u32),
        ), // SYS_GETRESGID
        135 => {
            let size = process_size_u32!(0);
            let list_pointer = if size == 0 {
                core::ptr::null_mut()
            } else {
                channel_mut_ptr!(1, u32)
            };
            kernel_getgroups(size, list_pointer)
        } // SYS_GETGROUPS
        136 => kernel_setgroups(process_size_u32!(0), channel_const_ptr!(1, u32)), // SYS_SETGROUPS

        // Wait
        139 => kernel_wait4(
            a1,
            channel_mut_ptr!(1, i32),
            a3 as u32,
            channel_mut_ptr!(3, u8),
        ), // SYS_WAIT4

        // Fork/exec/clone
        // Exec launch is a host-orchestrated exact-target transaction. Direct
        // channel dispatch has neither a retained object token nor authority
        // to replace a worker, so it must not revive pathname-only exec.
        211 | 386 => -(Errno::ENOSYS as i32), // SYS_EXECVE / SYS_EXECVEAT
        // The centralized host must intercept fork and ask ProcessTable to
        // allocate the child identity. A direct dispatch cannot create a
        // worker without bypassing that authority, so fail truthfully.
        212 | 213 => -(Errno::ENOSYS as i32), // SYS_FORK / SYS_VFORK
        201 => kernel_clone(
            0,
            conditional_process_address!(1),
            a1 as u32,
            0,
            conditional_process_address!(2),
            conditional_process_address!(3),
            conditional_process_address!(4),
        ), // SYS_CLONE

        // Futex
        200 => kernel_futex(
            process_address!(0),
            a2 as u32,
            a3 as u32,
            a4 as u32,
            conditional_process_address!(4),
            a6 as u32,
        ), // SYS_FUTEX

        // Thread
        202 => kernel_gettid(),                             // SYS_GETTID
        203 => kernel_set_tid_address(process_address!(0)), // SYS_SET_TID_ADDRESS
        261 => kernel_set_robust_list(process_address!(0), process_size!(1)), // SYS_SET_ROBUST_LIST
        262 => kernel_get_robust_list(a1 as u32, process_address!(1), process_address!(2)), // SYS_GET_ROBUST_LIST

        // prctl
        223 => {
            let option = a1 as u32;
            let arg2 = if option == 15 || option == 16 {
                channel_mut_ptr!(1, u8) as usize
            } else {
                channel_u32_scalar_usize(a2)
            };
            kernel_prctl_from_channel(option, arg2, core::ptr::null_mut(), a4 as u32)
        } // SYS_PRCTL

        // pathconf
        112 => {
            // SYS_PATHCONF
            let p = channel_const_ptr!(0, u8);
            let len = channel_cstr_len!(p);
            kernel_pathconf(p, len as u32, a2, channel_mut_ptr!(2, i64))
        }
        113 => kernel_fpathconf(a1, a2, channel_mut_ptr!(2, i64)), // SYS_FPATHCONF

        215 => kernel_setreuid(a1 as u32, a2 as u32), // SYS_SETREUID
        216 => kernel_setregid(a1 as u32, a2 as u32), // SYS_SETREGID

        // Timer
        225 => {
            let new_pointer = channel_const_ptr!(1, u8);
            let old_pointer = channel_mut_ptr!(2, u8);
            kernel_setitimer(a1 as u32, new_pointer, old_pointer, args[5])
        }
        224 => {
            let current_pointer = channel_mut_ptr!(1, u8);
            kernel_getitimer(a1 as u32, current_pointer, args[5])
        }
        // clock_settime — always return EPERM (cannot set clock in Wasm sandbox)
        226 => -(Errno::EPERM as i32), // SYS_CLOCK_SETTIME
        // sched_yield — no-op in Wasm (single-threaded per worker)
        229 => 0, // SYS_SCHED_YIELD

        // statx — musl: (dirfd, path, flags, mask, statxbuf)
        260 => {
            let p = channel_const_ptr!(1, u8);
            let len = channel_cstr_len!(p);
            kernel_statx(a1, p, len, a3 as u32, a4 as u32, channel_mut_ptr!(4, u8))
        }

        // SysV IPC — handled by kernel IpcTable
        337 => {
            // SYS_MSGGET: (key, flags)
            let ipc = unsafe { crate::ipc::global_ipc_table() };
            let (pid, uid, gid) = current_pid_eids();
            match ipc.msgget(a1, a2 as u32, pid, uid, gid) {
                Ok(id) => id,
                Err(e) => -(e as i32),
            }
        }
        338 => {
            // SYS_MSGRCV: (qid, msgp, msgsz, msgtyp, flags)
            let ipc = unsafe { crate::ipc::global_ipc_table() };
            let (pid, uid, gid) = current_pid_eids();
            let task = unsafe { &*PROCESS_TABLE.0.get() };
            let tid = task.current_tid();
            let active_pin = match task.get(pid).ok_or(Errno::ESRCH).and_then(|proc| {
                proc.blocked_retries.active_sysv_message(
                    tid,
                    crate::blocked_retry::BlockingRetryOperation::MsgReceive,
                )
            }) {
                Ok(pin) => pin,
                Err(error) => return -(error as i32),
            };
            let pointer_width = match args[5] {
                4 => 4,
                8 => 8,
                _ => return -(Errno::EINVAL as i32),
            };
            let msgp = channel_mut_ptr!(1, u8);
            if msgp.is_null() {
                return -(Errno::EFAULT as i32);
            }
            let msgsz = process_size_u32!(2);
            let max_output_mtype = if pointer_width == 4 {
                i32::MAX as i64
            } else {
                i64::MAX
            };
            // WHY: the channel scalar contract requires one exact decode per
            // consumed argument. Retry selection must not duplicate the
            // signed-i64 interpretation of msgtyp.
            let msgtyp = channel_scalar::i64_argument(338, args, 3);
            let receive = if let Some(pin) = active_pin {
                ipc.msgrcv_pinned_with_mtype_max(
                    pin,
                    msgsz,
                    msgtyp,
                    max_output_mtype,
                    args[4] as u32,
                    pid,
                    uid,
                    gid,
                )
            } else {
                ipc.msgrcv_with_mtype_max(
                    a1,
                    msgsz,
                    msgtyp,
                    max_output_mtype,
                    args[4] as u32,
                    pid,
                    uid,
                    gid,
                )
            };
            match receive {
                Ok(result) => {
                    let wire_size = match crate::ipc_wire::sysv_message_wire_size(result.data.len())
                    {
                        Ok(size) => size,
                        Err(error) => return -(error as i32),
                    };
                    let out = unsafe { core::slice::from_raw_parts_mut(msgp, wire_size) };
                    if let Err(error) =
                        crate::ipc_wire::write_sysv_message(out, result.mtype, &result.data)
                    {
                        return -(error as i32);
                    }
                    result.data.len() as i32
                }
                Err(e) => -(e as i32),
            }
        }
        339 => {
            // SYS_MSGSND: (qid, msgp, msgsz, flags)
            let ipc = unsafe { crate::ipc::global_ipc_table() };
            let (pid, uid, gid) = current_pid_eids();
            if !matches!(args[5], 4 | 8) {
                return -(Errno::EINVAL as i32);
            }
            let msgp = channel_const_ptr!(1, u8);
            if msgp.is_null() {
                return -(Errno::EFAULT as i32);
            }
            let msgsz = process_size!(2);
            let wire_size = match crate::ipc_wire::sysv_message_wire_size(msgsz) {
                Ok(size) => size,
                Err(error) => return -(error as i32),
            };
            let message = unsafe { core::slice::from_raw_parts(msgp, wire_size) };
            let mtype = match crate::ipc_wire::read_sysv_message_type(message) {
                Ok(mtype) => mtype,
                Err(error) => return -(error as i32),
            };
            let data = &message[crate::ipc_wire::SYSV_MESSAGE_HEADER_SIZE..];
            let task = unsafe { &*PROCESS_TABLE.0.get() };
            let tid = task.current_tid();
            let active_pin = match task.get(pid).ok_or(Errno::ESRCH).and_then(|proc| {
                proc.blocked_retries
                    .active_sysv_message(tid, crate::blocked_retry::BlockingRetryOperation::MsgSend)
            }) {
                Ok(pin) => pin,
                Err(error) => return -(error as i32),
            };
            let send = if let Some(pin) = active_pin {
                ipc.msgsnd_pinned(pin, mtype, data, args[3] as u32, pid, uid, gid)
            } else {
                ipc.msgsnd(a1, mtype, data, args[3] as u32, pid, uid, gid)
            };
            match send {
                Ok(()) => 0,
                Err(e) => -(e as i32),
            }
        }
        340 => {
            // SYS_MSGCTL: (qid, cmd, buf_ptr)
            let ipc = unsafe { crate::ipc::global_ipc_table() };
            let (pid, uid, gid) = current_pid_eids();
            let cmd = a2 & !0x100; // strip IPC_64
                                   // The host-only sixth slot names the caller data model; it may
                                   // differ from the kernel Wasm's own pointer width.
            let wire_transfer = if cmd == 1 || cmd == 2 {
                let pointer_width = match args[5] {
                    4 => 4,
                    8 => 8,
                    _ => return -(Errno::EINVAL as i32),
                };
                match crate::ipc_wire::msqid_ds_size(pointer_width) {
                    Ok(size) => Some((size, pointer_width)),
                    Err(error) => return -(error as i32),
                }
            } else {
                None
            };
            if cmd == 1 {
                if args[2] == 0 {
                    return -(Errno::EFAULT as i32);
                }
                let Some((size, pointer_width)) = wire_transfer else {
                    return -(Errno::EINVAL as i32);
                };
                let input_pointer = channel_const_ptr!(2, u8);
                // SAFETY: the ABI-43 host copied this exact caller-width
                // structure into its checked channel-scratch lease.
                let input = unsafe { core::slice::from_raw_parts(input_pointer, size) };
                let fields = match crate::ipc_wire::read_msqid_ds_set_fields(input, pointer_width) {
                    Ok(fields) => fields,
                    Err(error) => return -(error as i32),
                };
                return match ipc.msgctl_set(
                    a1,
                    fields.uid,
                    fields.gid,
                    fields.mode,
                    fields.qbytes,
                    uid,
                ) {
                    Ok(()) => 0,
                    Err(error) => -(error as i32),
                };
            }
            match ipc.msgctl(a1, cmd, pid, uid, gid) {
                Ok(Some(info)) => {
                    if args[2] == 0 {
                        return -(Errno::EFAULT as i32);
                    }
                    let Some((size, pointer_width)) = wire_transfer else {
                        return -(Errno::EINVAL as i32);
                    };
                    let output_pointer = channel_mut_ptr!(2, u8);
                    // SAFETY: the ABI-43 host stages this exact-sized output
                    // in its checked, kernel-owned channel-scratch lease.
                    let out = unsafe { core::slice::from_raw_parts_mut(output_pointer, size) };
                    if let Err(error) = crate::ipc_wire::write_msqid_ds(out, &info, pointer_width) {
                        return -(error as i32);
                    }
                    0
                }
                Ok(None) => 0,
                Err(e) => -(e as i32),
            }
        }
        341 => {
            // SYS_SEMGET: (key, nsems, flags)
            let ipc = unsafe { crate::ipc::global_ipc_table() };
            let (pid, uid, gid) = current_pid_eids();
            match ipc.semget(a1, a2 as u32, a3 as u32, pid, uid, gid) {
                Ok(id) => id,
                Err(e) => -(e as i32),
            }
        }
        342 => {
            // SYS_SEMOP: (semid, sops_ptr, nsops)
            let ipc = unsafe { crate::ipc::global_ipc_table() };
            let (pid, uid, gid) = current_pid_eids();
            let nsops = process_size!(2);
            let bytes_len = match nsops.checked_mul(6) {
                Some(length) => length,
                None => return -(Errno::EINVAL as i32),
            };
            let bytes = channel_const_slice!(1, bytes_len);
            let mut sops = alloc::vec::Vec::with_capacity(nsops);
            for i in 0..nsops {
                let base = i * 6;
                let num = u16::from_le_bytes([bytes[base], bytes[base + 1]]);
                let op = i16::from_le_bytes([bytes[base + 2], bytes[base + 3]]);
                let flg = u16::from_le_bytes([bytes[base + 4], bytes[base + 5]]);
                sops.push(crate::ipc::SemOp { num, op, flg });
            }
            let task = unsafe { &*PROCESS_TABLE.0.get() };
            let tid = task.current_tid();
            let active_pin = match task
                .get(pid)
                .ok_or(Errno::ESRCH)
                .and_then(|proc| proc.blocked_retries.active_sysv_semaphore(tid))
            {
                Ok(pin) => pin,
                Err(error) => return -(error as i32),
            };
            let operation = if let Some(pin) = active_pin {
                ipc.semop_pinned(pin, &sops, pid, uid, gid)
            } else {
                ipc.semop(a1, &sops, pid, uid, gid)
            };
            match operation {
                Ok(()) => 0,
                Err(e) => -(e as i32),
            }
        }
        343 => {
            // SYS_SEMCTL: (semid, semnum, cmd, arg)
            let ipc = unsafe { crate::ipc::global_ipc_table() };
            let (pid, uid, gid) = current_pid_eids();
            let cmd = a3 & !0x100; // strip IPC_64
                                   // WHY: the host-only sixth channel slot carries the caller's
                                   // pointer width. The kernel Wasm width is not authoritative
                                   // because one kernel may serve both wasm32 and wasm64 processes.
            let stat_transfer = if cmd == 2 {
                let pointer_width = match args[5] {
                    4 => 4,
                    8 => 8,
                    _ => return -(Errno::EINVAL as i32),
                };
                match crate::ipc_wire::semid_ds_size(pointer_width) {
                    Ok(size) => Some((size, pointer_width)),
                    Err(error) => return -(error as i32),
                }
            } else {
                None
            };
            // SETALL (17): arg points to u16[] in scratch
            if cmd == 17 {
                if args[3] == 0 {
                    return -(Errno::EFAULT as i32);
                }
                let bytes = match ipc.semctl_array_bytes(a1, 17, uid, gid) {
                    Ok(bytes) => bytes,
                    Err(error) => return -(error as i32),
                };
                let values_pointer =
                    match checked_channel_scratch_start_range(args[3], bytes, scratch_region) {
                        Ok(pointer) => pointer as *const u8,
                        Err(error) => return -(error as i32),
                    };
                // SAFETY: the ABI-43 host obtained the same permission-checked
                // byte count before copying into its channel-scratch lease.
                let values = unsafe { core::slice::from_raw_parts(values_pointer, bytes) };
                match ipc.semctl_set_all_bytes(a1, values, uid, gid) {
                    Ok(()) => 0,
                    Err(error) => -(error as i32),
                }
            } else {
                match ipc.semctl(a1, a2, cmd, pid, a4, uid, gid) {
                    Ok(crate::ipc::SemCtlResult::Ok) => 0,
                    Ok(crate::ipc::SemCtlResult::Value(v)) => v,
                    Ok(crate::ipc::SemCtlResult::Stat(info)) => {
                        if args[3] == 0 {
                            return -(Errno::EFAULT as i32);
                        }
                        let Some((size, pointer_width)) = stat_transfer else {
                            return -(Errno::EINVAL as i32);
                        };
                        let output_pointer = match checked_channel_scratch_start_range(
                            args[3],
                            size,
                            scratch_region,
                        ) {
                            Ok(pointer) => pointer as *mut u8,
                            Err(error) => return -(error as i32),
                        };
                        // SAFETY: the ABI-43 host stages this exact-sized
                        // output in its checked channel-scratch lease.
                        let out = unsafe { core::slice::from_raw_parts_mut(output_pointer, size) };
                        if let Err(error) =
                            crate::ipc_wire::write_semid_ds(out, &info, pointer_width)
                        {
                            return -(error as i32);
                        }
                        0
                    }
                    Ok(crate::ipc::SemCtlResult::All(vals)) => {
                        // GETALL: write u16[] to arg pointer
                        if args[3] == 0 {
                            return -(Errno::EFAULT as i32);
                        }
                        let byte_len = match vals.len().checked_mul(core::mem::size_of::<u16>()) {
                            Some(byte_len) => byte_len,
                            None => return -(Errno::EOVERFLOW as i32),
                        };
                        let output_pointer = match checked_channel_scratch_start_range(
                            args[3],
                            byte_len,
                            scratch_region,
                        ) {
                            Ok(pointer) => pointer as *mut u8,
                            Err(error) => return -(error as i32),
                        };
                        // SAFETY: the ABI-43 host obtained this exact byte
                        // count before reserving the channel-scratch lease.
                        let out =
                            unsafe { core::slice::from_raw_parts_mut(output_pointer, byte_len) };
                        for (chunk, value) in out.chunks_exact_mut(2).zip(vals.iter()) {
                            chunk.copy_from_slice(&value.to_le_bytes());
                        }
                        0
                    }
                    Err(e) => -(e as i32),
                }
            }
        }
        344 => {
            // SYS_SHMGET: (key, size, flags)
            let ipc = unsafe { crate::ipc::global_ipc_table() };
            let (pid, uid, gid) = current_pid_eids();
            let size = match u32::try_from(process_size!(1)) {
                Ok(size) => size,
                Err(_) => return -(Errno::EINVAL as i32),
            };
            match ipc.shmget(a1, size, a3 as u32, pid, uid, gid) {
                Ok(id) => id,
                Err(e) => -(e as i32),
            }
        }
        // SYS_SHMAT (345), SYS_SHMDT (346): intercepted by host for process memory management
        345 => {
            // The current kernel implementation ignores the requested attach
            // address, but still validate the complete raw pointer so a future
            // implementation cannot inherit the old i32 truncation.
            let _shmaddr = conditional_process_address!(1);
            kernel_ipc_shmat(a1, a2, a3)
        }
        346 => {
            let shmaddr = conditional_process_address!(0);
            kernel_ipc_shmdt_addr(shmaddr)
        }
        347 => {
            // SYS_SHMCTL: (shmid, cmd, buf_ptr)
            let ipc = unsafe { crate::ipc::global_ipc_table() };
            let (pid, uid, gid) = current_pid_eids();
            let cmd = a2 & !0x100; // strip IPC_64
                                   // The host-only sixth slot names the caller data model; it may
                                   // differ from the kernel Wasm's own pointer width.
            let wire_transfer = if cmd == 1 || cmd == 2 {
                let pointer_width = match args[5] {
                    4 => 4,
                    8 => 8,
                    _ => return -(Errno::EINVAL as i32),
                };
                match crate::ipc_wire::shmid_ds_size(pointer_width) {
                    Ok(size) => Some((size, pointer_width)),
                    Err(error) => return -(error as i32),
                }
            } else {
                None
            };
            if cmd == 1 {
                if args[2] == 0 {
                    return -(Errno::EFAULT as i32);
                }
                let Some((size, pointer_width)) = wire_transfer else {
                    return -(Errno::EINVAL as i32);
                };
                let input_pointer = channel_const_ptr!(2, u8);
                // SAFETY: the ABI-43 host copied this exact caller-width
                // structure into its checked channel-scratch lease.
                let input = unsafe { core::slice::from_raw_parts(input_pointer, size) };
                let fields = match crate::ipc_wire::read_shmid_ds_set_fields(input, pointer_width) {
                    Ok(fields) => fields,
                    Err(error) => return -(error as i32),
                };
                return match ipc.shmctl_set(a1, fields.uid, fields.gid, fields.mode, uid) {
                    Ok(()) => 0,
                    Err(error) => -(error as i32),
                };
            }
            match ipc.shmctl(a1, cmd, pid, uid, gid) {
                Ok(Some(info)) => {
                    if args[2] == 0 {
                        return -(Errno::EFAULT as i32);
                    }
                    let Some((size, pointer_width)) = wire_transfer else {
                        return -(Errno::EINVAL as i32);
                    };
                    let output_pointer = channel_mut_ptr!(2, u8);
                    // SAFETY: the ABI-43 host stages this exact-sized output
                    // in its checked, kernel-owned channel-scratch lease.
                    let out = unsafe { core::slice::from_raw_parts_mut(output_pointer, size) };
                    if let Err(error) = crate::ipc_wire::write_shmid_ds(out, &info, pointer_width) {
                        return -(error as i32);
                    }
                    0
                }
                Ok(None) => 0,
                Err(e) => -(e as i32),
            }
        }

        // epoll
        239 => kernel_epoll_create1(a1 as u32), // SYS_EPOLL_CREATE1: (flags)
        378 => kernel_epoll_create1(0),         // SYS_EPOLL_CREATE: (size) — flags=0
        240 => {
            let event_ptr = channel_const_ptr!(3, u8);
            kernel_epoll_ctl(a1, a2, a3, event_ptr)
        }
        241 => {
            let events_ptr = channel_mut_ptr!(1, u8);
            let sigmask_ptr = channel_const_ptr!(4, u8);
            if !sigmask_ptr.is_null()
                && process_size!(5)
                    != wasm_posix_shared::kernel_scratch_wire::SIGNAL_MASK_BYTES as usize
            {
                return -(Errno::EINVAL as i32);
            }
            kernel_epoll_pwait(a1, events_ptr, a3, a4, sigmask_ptr)
        }
        379 => {
            let events_ptr = channel_mut_ptr!(1, u8);
            kernel_epoll_pwait(a1, events_ptr, a3, a4, core::ptr::null())
        }

        // eventfd
        242 => kernel_eventfd2(a1 as u32, a2 as u32), // SYS_EVENTFD2: (initval, flags)
        380 => kernel_eventfd2(a1 as u32, 0),         // SYS_EVENTFD: (initval) — no flags

        // timerfd
        243 => kernel_timerfd_create(a1 as u32, a2 as u32), // SYS_TIMERFD_CREATE: (clockid, flags)
        244 => kernel_timerfd_settime(
            a1,
            a2 as u32,
            channel_const_ptr!(2, u8),
            channel_mut_ptr!(3, u8),
        ), // SYS_TIMERFD_SETTIME
        245 => kernel_timerfd_gettime(a1, channel_mut_ptr!(1, u8)), // SYS_TIMERFD_GETTIME

        // signalfd
        246 => kernel_signalfd4(a1, channel_const_ptr!(1, u8), process_size!(2), a4 as u32), // SYS_SIGNALFD4: (fd, mask_ptr, sigsetsize, flags)
        377 => kernel_signalfd4(a1, channel_const_ptr!(1, u8), process_size!(2), 0), // SYS_SIGNALFD: (fd, mask_ptr, sigsetsize)

        // tkill — directed (per-thread) signal delivery. (wasm32 musl
        // uses __NR_tkill for pthread_kill too; __NR_tgkill isn't wired up.)
        204 => kernel_tkill(a1 as u32, a2 as u32), // SYS_TKILL (tid, sig)

        // SYS_RT_SIGQUEUEINFO: send signal with si_value (sigqueue).
        // The complete siginfo_t is staged by a generated process-layout
        // descriptor because LP64 alignment moves the common fields.
        205 => {
            let model = match crate::process_wire::ProcessDataModel::from_width(args[5]) {
                Ok(model) => model,
                Err(error) => return -(error as i32),
            };
            let info_pointer = channel_const_ptr!(2, u8);
            if info_pointer.is_null() {
                return -(Errno::EFAULT as i32);
            }
            let info_bytes = unsafe { slice::from_raw_parts(info_pointer, model.siginfo_size()) };
            let info = match crate::process_wire::read_rt_sigqueueinfo(info_bytes, model) {
                Ok(info) => info,
                Err(error) => return -(error as i32),
            };
            // WHY: si_pid/si_uid are parsed to keep the native layout honest,
            // but caller-provided credentials are never authority. The signal
            // path derives sender identity from the current kernel process.
            kernel_kill_with_metadata(a1, a2 as u32, info.value_bits, -1)
        }

        // SYS_RT_SIGRETURN: signal handler return — clean up alt stack state
        208 => {
            let (_gkl, proc, advisory_locks) = unsafe { get_process_and_advisory_locks() };
            proc.return_from_caught_handler_for(syscalls::current_tid_for_process(proc));
            if proc.alt_stack_depth > 0 {
                proc.alt_stack_depth -= 1;
                if proc.alt_stack_depth == 0 {
                    const SS_ONSTACK: u32 = 1;
                    proc.alt_stack_flags &= !SS_ONSTACK;
                }
            }
            0
        }

        // SYS_SIGALTSTACK: store/retrieve alternate stack state
        209 => {
            let stack_pointer = channel_const_ptr!(0, u8);
            let old_stack_pointer = channel_mut_ptr!(1, u8);
            kernel_sigaltstack(stack_pointer, old_stack_pointer, args[5])
        }

        // SYS_SCHED_GET_PRIORITY_MAX: POSIX requires at least 32 levels for SCHED_RR/SCHED_FIFO
        234 => {
            let policy = a1;
            if policy >= 0 && policy <= 2 {
                32
            } else {
                -(Errno::EINVAL as i32)
            }
        }
        // SYS_SCHED_GET_PRIORITY_MIN
        235 => {
            let policy = a1;
            if policy >= 0 && policy <= 2 {
                1
            } else {
                -(Errno::EINVAL as i32)
            }
        }

        // Scheduler parameters use the complete native 48-byte structure.
        230 => {
            let param_pointer = channel_mut_ptr!(1, u8);
            kernel_sched_getparam(a1, param_pointer)
        }
        231 => {
            let param_pointer = channel_const_ptr!(1, u8);
            kernel_sched_setparam(a1, param_pointer)
        }
        // SYS_SCHED_GETSCHEDULER: always SCHED_OTHER (0) for valid PIDs
        232 => kernel_sched_validate_pid(a1),
        233 => {
            let param_pointer = channel_const_ptr!(2, u8);
            kernel_sched_setscheduler(a1, a2, param_pointer)
        }

        // SYS_SCHED_RR_GET_INTERVAL: (pid, timespec_ptr)
        236 => {
            let (_gkl, proc, advisory_locks) = unsafe { get_process_and_advisory_locks() };
            let pid = a1 as u32;
            if pid != 0 && pid != proc.pid {
                -(Errno::ESRCH as i32)
            } else if args[1] == 0 {
                -(Errno::EFAULT as i32)
            } else {
                // Write a reasonable RR interval: 100ms
                let p = channel_mut_ptr!(1, u8);
                let sec: i64 = 0;
                let nsec: i64 = 100_000_000; // 100ms
                unsafe {
                    let sec_bytes = sec.to_le_bytes();
                    let nsec_bytes = nsec.to_le_bytes();
                    for i in 0..8 {
                        *p.add(i) = sec_bytes[i];
                    }
                    for i in 0..8 {
                        *p.add(8 + i) = nsec_bytes[i];
                    }
                }
                0
            }
        }

        // mlock/munlock: no-op in Wasm (all memory is "locked")
        // Return ENOMEM for addresses beyond Wasm memory bounds
        279 | 280 => {
            // mlock, mlock2: (addr, len, ...)
            let addr = process_address!(0);
            let len = process_size!(1);
            if addr
                .checked_add(len)
                .map_or(true, |end| end > 1_073_741_824)
            {
                -(Errno::ENOMEM as i32)
            } else {
                0
            }
        }
        281 => {
            // munlock: (addr, len)
            let addr = process_address!(0);
            let len = process_size!(1);
            if addr
                .checked_add(len)
                .map_or(true, |end| end > 1_073_741_824)
            {
                -(Errno::ENOMEM as i32)
            } else {
                0
            }
        }
        282 | 283 => 0, // mlockall, munlockall: success
        // SYS_GETPRIORITY
        285 => {
            let (_gkl, proc, advisory_locks) = unsafe { get_process_and_advisory_locks() };
            match syscalls::sys_getpriority(proc, a1, a2 as u32) {
                Ok(v) => v,
                Err(e) => -(e as i32),
            }
        }
        286 => {
            // SYS_SETPRIORITY
            let (_gkl, proc, advisory_locks) = unsafe { get_process_and_advisory_locks() };
            match syscalls::sys_setpriority(proc, a1, a2 as u32, a3) {
                Ok(()) => 0,
                Err(e) => -(e as i32),
            }
        }

        252 => {
            // SYS_PSELECT6_TIME64: (nfds, readfds, writefds, exceptfds, timeout_ms, mask_ptr)
            // Args pre-decoded by host: timeout → ms, mask stored at mask_ptr (8 bytes: lo+hi)
            let mask_ptr = channel_const_ptr!(5, u8);
            let (has_mask, mask_lo, mask_hi) = if mask_ptr.is_null() {
                (0u32, 0u32, 0u32)
            } else {
                let mb = unsafe { core::slice::from_raw_parts(mask_ptr, 8) };
                (
                    1u32,
                    u32::from_le_bytes([mb[0], mb[1], mb[2], mb[3]]),
                    u32::from_le_bytes([mb[4], mb[5], mb[6], mb[7]]),
                )
            };
            kernel_pselect6(
                a1,
                channel_mut_ptr!(1, u8),
                channel_mut_ptr!(2, u8),
                channel_mut_ptr!(3, u8),
                a5,
                has_mask,
                mask_lo,
                mask_hi,
            )
        }
        299 => {
            // SYS_LCHOWN: (path, uid, gid)
            let p = channel_const_ptr!(0, u8);
            let len = channel_cstr_len!(p);
            kernel_lchown(p, len, a2 as u32, a3 as u32)
        }
        307 => 0, // SYS_FADVISE64: advisory, always succeed

        // POSIX timers
        326 => kernel_timer_create(
            a1 as u32,
            channel_const_ptr!(1, u8),
            channel_mut_ptr!(2, i32),
            args[5],
        ), // SYS_TIMER_CREATE
        327 => kernel_timer_settime(a1, a2, channel_const_ptr!(2, u8), channel_mut_ptr!(3, u8)), // SYS_TIMER_SETTIME
        328 => kernel_timer_gettime(a1, channel_mut_ptr!(1, u8)), // SYS_TIMER_GETTIME
        329 => kernel_timer_getoverrun(a1 as i32),                // SYS_TIMER_GETOVERRUN
        330 => kernel_timer_delete(a1 as i32),                    // SYS_TIMER_DELETE

        269 => {
            // SYS_SYSINFO
            let model = match crate::process_wire::ProcessDataModel::from_width(args[5]) {
                Ok(model) => model,
                Err(error) => return -(error as i32),
            };
            let output_pointer = channel_mut_ptr!(0, u8);
            if output_pointer.is_null() {
                return -(Errno::EFAULT as i32);
            }
            let info = syscalls::sys_sysinfo();
            let mut encoded = alloc::vec![0; model.sysinfo_size()];
            if let Err(error) = crate::process_wire::write_sysinfo(&mut encoded, &info, model) {
                return -(error as i32);
            }
            // WHY: the host allocated and checked exactly this caller-native
            // record. A fixed wasm32 length would truncate wasm64 sysinfo and
            // leave its tail as stale scratch bytes. Serializing first also
            // prevents a narrowing error from publishing a partial record.
            let output =
                unsafe { core::slice::from_raw_parts_mut(output_pointer, model.sysinfo_size()) };
            output.copy_from_slice(&encoded);
            0
        }

        256 => {
            // SYS_MEMFD_CREATE: (name, flags)
            let (_gkl, proc, advisory_locks) = unsafe { get_process_and_advisory_locks() };
            let name_ptr = channel_const_ptr!(0, u8);
            let name_len = channel_cstr_len!(name_ptr) as usize;
            let name = if name_ptr.is_null() || name_len == 0 {
                &[]
            } else {
                unsafe { slice::from_raw_parts(name_ptr, name_len) }
            };
            match syscalls::sys_memfd_create(proc, name, a2 as u32) {
                Ok(fd) => fd,
                Err(e) => -(e as i32),
            }
        }
        290 => {
            // SYS_COPY_FILE_RANGE: (fd_in, off_in*, fd_out, off_out*, len, flags)
            let (_gkl, proc, advisory_locks) = unsafe { get_process_and_advisory_locks() };
            let mut host = WasmHostIO;
            let off_in_ptr = channel_mut_ptr!(1, u8);
            let off_out_ptr = channel_mut_ptr!(3, u8);
            let off_in = if off_in_ptr.is_null() {
                None
            } else {
                let bytes = unsafe { slice::from_raw_parts(off_in_ptr, 8) };
                Some(i64::from_le_bytes(bytes.try_into().unwrap()))
            };
            let off_out = if off_out_ptr.is_null() {
                None
            } else {
                let bytes = unsafe { slice::from_raw_parts(off_out_ptr, 8) };
                Some(i64::from_le_bytes(bytes.try_into().unwrap()))
            };
            let result = match syscalls::sys_copy_file_range(
                proc,
                &mut host,
                a1,
                off_in,
                a3,
                off_out,
                reportable_channel_transfer_count(process_size!(4)),
            ) {
                Ok(n) => {
                    let advanced_offsets = off_in
                        .map(|offset| syscalls::checked_offset_advance(offset, n))
                        .transpose()
                        .and_then(|advanced_in| {
                            off_out
                                .map(|offset| syscalls::checked_offset_advance(offset, n))
                                .transpose()
                                .map(|advanced_out| (advanced_in, advanced_out))
                        });
                    match advanced_offsets {
                        Ok((advanced_in, advanced_out)) => {
                            // Compute both values before publishing either so
                            // an overflow cannot leave the caller's pair only
                            // partially updated.
                            if let Some(new_off) = advanced_in {
                                let buf = unsafe { slice::from_raw_parts_mut(off_in_ptr, 8) };
                                buf.copy_from_slice(&new_off.to_le_bytes());
                            }
                            if let Some(new_off) = advanced_out {
                                let buf = unsafe { slice::from_raw_parts_mut(off_out_ptr, 8) };
                                buf.copy_from_slice(&new_off.to_le_bytes());
                            }
                            n as i32
                        }
                        Err(error) => -(error as i32),
                    }
                }
                Err(e) => -(e as i32),
            };
            deliver_pending_signals_with_locks(proc, advisory_locks, &mut host);
            result
        }

        291 => {
            // SYS_SPLICE: (fd_in, off_in*, fd_out, off_out*, len, flags)
            let (_gkl, proc, advisory_locks) = unsafe { get_process_and_advisory_locks() };
            let mut host = WasmHostIO;
            let off_in_ptr = channel_mut_ptr!(1, u8);
            let off_out_ptr = channel_mut_ptr!(3, u8);
            let off_in = if off_in_ptr.is_null() {
                None
            } else {
                let bytes = unsafe { slice::from_raw_parts(off_in_ptr, 8) };
                Some(i64::from_le_bytes(bytes.try_into().unwrap()))
            };
            let off_out = if off_out_ptr.is_null() {
                None
            } else {
                let bytes = unsafe { slice::from_raw_parts(off_out_ptr, 8) };
                Some(i64::from_le_bytes(bytes.try_into().unwrap()))
            };
            let result = match syscalls::sys_splice(
                proc,
                &mut host,
                a1,
                off_in,
                a3,
                off_out,
                reportable_channel_transfer_count(process_size!(4)),
                a6 as u32,
            ) {
                Ok(n) => {
                    let advanced_offsets = off_in
                        .map(|offset| syscalls::checked_offset_advance(offset, n))
                        .transpose()
                        .and_then(|advanced_in| {
                            off_out
                                .map(|offset| syscalls::checked_offset_advance(offset, n))
                                .transpose()
                                .map(|advanced_out| (advanced_in, advanced_out))
                        });
                    match advanced_offsets {
                        Ok((advanced_in, advanced_out)) => {
                            if let Some(new_off) = advanced_in {
                                let buf = unsafe { slice::from_raw_parts_mut(off_in_ptr, 8) };
                                buf.copy_from_slice(&new_off.to_le_bytes());
                            }
                            if let Some(new_off) = advanced_out {
                                let buf = unsafe { slice::from_raw_parts_mut(off_out_ptr, 8) };
                                buf.copy_from_slice(&new_off.to_le_bytes());
                            }
                            n as i32
                        }
                        Err(error) => -(error as i32),
                    }
                }
                Err(e) => -(e as i32),
            };
            deliver_pending_signals_with_locks(proc, advisory_locks, &mut host);
            result
        }
        293 => {
            let _count = process_size!(2);
            0
        } // SYS_READAHEAD: advisory, always succeed
        297 => channel_preadv(
            a1,
            channel_mut_ptr!(1, u8),
            a3,
            channel_scalar::split_i64_low_argument(297, args, 3),
            channel_scalar::split_i64_high_argument(297, args, 4),
            scratch_region,
        ), // SYS_PREADV2 (ignore flags in a6)
        298 => channel_pwritev(
            a1,
            channel_const_ptr!(1, u8),
            a3,
            channel_scalar::split_i64_low_argument(298, args, 3),
            channel_scalar::split_i64_high_argument(298, args, 4),
            scratch_region,
        ), // SYS_PWRITEV2 (ignore flags in a6)

        // -- Scheduling stubs (single-CPU Wasm) --
        237 => {
            let _cpusetsize = channel_scalar::u32_argument(237, args, 1);
            0
        } // SYS_SCHED_SETAFFINITY: no-op (single CPU)
        238 => kernel_sched_getaffinity(
            a1,
            channel_scalar::u32_argument(238, args, 1),
            channel_mut_ptr!(2, u8),
        ),

        // -- Memory/sync stubs --
        257 => 0, // SYS_MEMBARRIER: no-op (single-threaded per process in Wasm)
        273 => 0, // SYS_SYNC: no-op (all I/O is synchronous to host)
        274 => 0, // SYS_SYNCFS: no-op
        278 => {
            let _address = process_address!(0);
            let _length = process_size!(1);
            0
        } // SYS_MSYNC: no-op (MAP_PRIVATE changes are private, file-backed writes go through write())

        // -- Process stubs --
        287 => 0, // SYS_PERSONALITY: return 0 (current personality, PER_LINUX)

        // -- Filesystem --
        304 => 0, // SYS_SYSLOG (kernel log): no-op (not the libc syslog)
        306 => {
            // SYS_RENAMEAT2: (olddirfd, oldpath, newdirfd, newpath, flags)
            // Ignore flags (RENAME_NOREPLACE, RENAME_EXCHANGE) — delegate to renameat
            let old = channel_const_ptr!(1, u8);
            let new = channel_const_ptr!(3, u8);
            kernel_renameat(
                a1,
                old,
                channel_cstr_len!(old),
                a3,
                new,
                channel_cstr_len!(new),
            )
        }
        308 => {
            // SYS_FALLOCATE: (fd, mode, offset, len)
            let mode = a2 as u32;
            if mode != 0 {
                -(Errno::EOPNOTSUPP as i32)
            } else {
                let (_gkl, proc, advisory_locks) = unsafe { get_process_and_advisory_locks() };
                let mut host = WasmHostIO;
                let offset = channel_scalar::i64_argument(308, args, 2);
                let len = channel_scalar::i64_argument(308, args, 3);
                let result = match syscalls::sys_fallocate(proc, &mut host, a1, offset, len) {
                    Ok(()) => 0,
                    Err(e) => -(e as i32),
                };
                deliver_pending_signals_with_locks(proc, advisory_locks, &mut host);
                result
            }
        }
        323 => 0, // SYS_SYNC_FILE_RANGE: advisory, no-op
        325 => {
            // SYS_GETCPU: (cpu*, node*, unused)
            let cpu_ptr = channel_mut_ptr!(0, u32);
            let node_ptr = channel_mut_ptr!(1, u32);
            if !cpu_ptr.is_null() {
                unsafe {
                    *cpu_ptr = 0;
                }
            }
            if !node_ptr.is_null() {
                unsafe {
                    *node_ptr = 0;
                }
            }
            0
        }

        // --- xattr stubs: no extended attribute support ---
        // fgetxattr/fsetxattr/fremovexattr/flistxattr
        350 => -(Errno::ENODATA as i32), // SYS_FGETXATTR: no attrs → ENODATA
        351 => 0,                        // SYS_FLISTXATTR: empty list → 0 bytes
        352 => -(Errno::ENODATA as i32), // SYS_FREMOVEXATTR: no attrs → ENODATA
        353 => 0,                        // SYS_FSETXATTR: silently accept
        // getxattr/setxattr/removexattr/listxattr (path-based)
        354 => -(Errno::ENODATA as i32), // SYS_GETXATTR
        355 => 0,                        // SYS_LISTXATTR: empty list
        356 => -(Errno::ENODATA as i32), // SYS_LGETXATTR
        357 => 0,                        // SYS_LLISTXATTR: empty list
        358 => -(Errno::ENODATA as i32), // SYS_LREMOVEXATTR
        359 => 0,                        // SYS_LSETXATTR: silently accept
        360 => -(Errno::ENODATA as i32), // SYS_REMOVEXATTR
        361 => 0,                        // SYS_SETXATTR: silently accept

        // --- setfsuid/setfsgid: return previous fsuid/fsgid (we mirror euid/egid) ---
        370 => {
            let (_gkl, proc, advisory_locks) = unsafe { get_process_and_advisory_locks() };
            proc.effective_uid() as i32
        }
        371 => {
            let (_gkl, proc, advisory_locks) = unsafe { get_process_and_advisory_locks() };
            proc.effective_gid() as i32
        }

        // --- faccessat2/fchmodat2: delegate to existing implementations ---
        382 => {
            // SYS_FACCESSAT2: (dirfd, path, mode, flags)
            let path = channel_const_ptr!(1, u8);
            kernel_faccessat(a1, path, channel_cstr_len!(path), a3 as u32, a4 as u32)
        }
        383 => {
            // SYS_FCHMODAT2: (dirfd, path, mode, flags)
            let path = channel_const_ptr!(1, u8);
            kernel_fchmodat(a1, path, channel_cstr_len!(path), a3 as u32, a4 as u32)
        }

        // --- inotify stubs: create eventfd-like fd ---
        247 | 381 => {
            // SYS_INOTIFY_INIT1 / SYS_INOTIFY_INIT
            let (_gkl, proc, advisory_locks) = unsafe { get_process_and_advisory_locks() };
            match syscalls::sys_inotify_init(proc) {
                Ok(fd) => fd,
                Err(e) => -(e as i32),
            }
        }
        248 => 1, // SYS_INOTIFY_ADD_WATCH: return dummy watch descriptor
        249 => 0, // SYS_INOTIFY_RM_WATCH: no-op success

        // --- mknod/mknodat: create regular files and FIFOs ---
        // S_IFIFO nodes are real named pipes (see `crate::fifo`); other node
        // types fall through to a regular-file marker.
        271 => {
            // SYS_MKNOD: (path, mode, dev)
            let path = channel_const_ptr!(0, u8);
            let mode = a2 as u32;
            let file_type = mode & 0o170000;
            if file_type == 0o010000 {
                kernel_mkfifo(path, channel_cstr_len!(path), mode & 0o7777)
            } else if file_type != 0 && file_type != 0o100000 {
                -(Errno::EPERM as i32)
            } else {
                kernel_mknod(path, channel_cstr_len!(path), mode & 0o7777)
            }
        }
        272 => {
            // SYS_MKNODAT: (dirfd, path, mode, dev)
            let path = channel_const_ptr!(1, u8);
            let mode = a3 as u32;
            let file_type = mode & 0o170000;
            if file_type == 0o010000 {
                kernel_mkfifoat(a1, path, channel_cstr_len!(path), mode & 0o7777)
            } else if file_type != 0 && file_type != 0o100000 {
                -(Errno::EPERM as i32)
            } else {
                kernel_mknodat(a1, path, channel_cstr_len!(path), mode & 0o7777)
            }
        }

        // POSIX message queues
        331 => {
            // SYS_MQ_OPEN: (name_ptr, flags, mode, attr_ptr)
            let model = match crate::process_wire::ProcessDataModel::from_width(args[5]) {
                Ok(model) => model,
                Err(error) => return -(error as i32),
            };
            let p = channel_const_ptr!(0, u8);
            let name_len = channel_cstr_len!(p);
            let name = unsafe {
                core::str::from_utf8_unchecked(core::slice::from_raw_parts(p, name_len as usize))
            };
            let flags = a2 as u32;
            let mode = a3 as u32;
            let has_attr = args[3] != 0 && (flags & 0o100) != 0; // O_CREAT
            let attr_pointer = if has_attr {
                channel_const_ptr!(3, u8)
            } else {
                core::ptr::null()
            };
            let (maxmsg, msgsize) = if has_attr {
                // SAFETY: the generated process-layout descriptor copied this
                // exact caller-native structure into capacity-checked scratch.
                let input =
                    unsafe { core::slice::from_raw_parts(attr_pointer, model.mq_attr_size()) };
                let attr = match crate::process_wire::read_mq_attr(input, model) {
                    Ok(attr) => attr,
                    Err(error) => return -(error as i32),
                };
                (attr.maxmsg, attr.msgsize)
            } else {
                (0, 0)
            };
            let table = unsafe { crate::mqueue::global_mqueue_table() };
            match table.mq_open(name, flags, mode, maxmsg, msgsize, has_attr) {
                Ok(mqd) => mqd as i32,
                Err(e) => -(e as i32),
            }
        }
        332 => {
            // SYS_MQ_UNLINK: (name_ptr)
            let p = channel_const_ptr!(0, u8);
            let name_len = channel_cstr_len!(p);
            let name = unsafe {
                core::str::from_utf8_unchecked(core::slice::from_raw_parts(p, name_len as usize))
            };
            let table = unsafe { crate::mqueue::global_mqueue_table() };
            match table.mq_unlink(name) {
                Ok(()) => 0,
                Err(e) => -(e as i32),
            }
        }
        333 => {
            // SYS_MQ_TIMEDSEND: (mqd, msg_ptr, msg_len, priority, timeout_ptr)
            let data_len = process_size!(2);
            if data_len > channel_scalar::MAX_REPORTABLE_TRANSFER_BYTES as usize {
                return -(Errno::EMSGSIZE as i32);
            }
            let data = channel_const_slice!(1, data_len);
            let table = unsafe { crate::mqueue::global_mqueue_table() };
            let process_table = unsafe { &*PROCESS_TABLE.0.get() };
            let pid = process_table.current_pid();
            let tid = process_table.current_tid();
            let (send, nonblock) =
                match process_table.get(pid).ok_or(Errno::ESRCH).and_then(|proc| {
                    proc.blocked_retries
                        .active_mqueue(tid, crate::blocked_retry::BlockingRetryOperation::MqSend)
                }) {
                    Ok(Some(pin)) => {
                        let nonblock = match table.pinned_is_nonblock(pin) {
                            Ok(nonblock) => nonblock,
                            Err(error) => return -(error as i32),
                        };
                        (table.mq_send_pinned(pin, data, a4 as u32), nonblock)
                    }
                    Ok(None) => (
                        table.mq_send(a1 as u32, data, a4 as u32),
                        table.is_nonblock(a1 as u32).unwrap_or(false),
                    ),
                    Err(error) => return -(error as i32),
                };
            match send {
                Ok(result) => {
                    if let Some(notif) = result.notification {
                        let process_table = unsafe { &mut *PROCESS_TABLE.0.get() };
                        let sender_pid = process_table.current_pid();
                        let sender_uid = process_table
                            .get(sender_pid)
                            .map(Process::real_uid)
                            .unwrap_or(0);
                        if queue_mqueue_signal_notification(
                            process_table,
                            notif,
                            sender_pid,
                            sender_uid,
                        ) {
                            // The host consumes only detached pid/signo wake
                            // metadata. Rust already owns the SI_MESGQ queue
                            // entry and its full-width sigval.
                            table.set_pending_notification(notif);
                        }
                    }
                    0
                }
                Err(Errno::EAGAIN) => {
                    mq_timed_blocking_errno(channel_const_ptr!(4, u8) as usize, nonblock)
                }
                Err(e) => -(e as i32),
            }
        }
        334 => {
            // SYS_MQ_TIMEDRECEIVE: (mqd, msg_ptr, msg_len, prio_ptr, timeout_ptr)
            let capacity = process_size_u32!(2);
            let table = unsafe { crate::mqueue::global_mqueue_table() };
            let process_table = unsafe { &*PROCESS_TABLE.0.get() };
            let pid = process_table.current_pid();
            let tid = process_table.current_tid();
            let (receive, nonblock) =
                match process_table.get(pid).ok_or(Errno::ESRCH).and_then(|proc| {
                    proc.blocked_retries
                        .active_mqueue(tid, crate::blocked_retry::BlockingRetryOperation::MqReceive)
                }) {
                    Ok(Some(pin)) => {
                        let nonblock = match table.pinned_is_nonblock(pin) {
                            Ok(nonblock) => nonblock,
                            Err(error) => return -(error as i32),
                        };
                        (table.mq_receive_pinned(pin, capacity), nonblock)
                    }
                    Ok(None) => (
                        table.mq_receive(a1 as u32, capacity),
                        table.is_nonblock(a1 as u32).unwrap_or(false),
                    ),
                    Err(error) => return -(error as i32),
                };
            match receive {
                Ok(result) => {
                    // WHY: a queued zero-length message has no destination
                    // bytes, so do not make an ignored pointer satisfy Rust's
                    // stronger non-null slice requirement.
                    if !result.data.is_empty() {
                        // SAFETY: mq_receive proved the message fits the
                        // caller-supplied capacity, which the host staged in
                        // checked kernel scratch before dispatch.
                        let dst = unsafe {
                            core::slice::from_raw_parts_mut(
                                channel_mut_ptr!(1, u8),
                                result.data.len(),
                            )
                        };
                        dst.copy_from_slice(&result.data);
                    }
                    // Write priority if pointer provided
                    if args[3] != 0 {
                        let prio_ptr = channel_mut_ptr!(3, u8);
                        let prio_bytes = result.priority.to_le_bytes();
                        unsafe {
                            *prio_ptr = prio_bytes[0];
                            *prio_ptr.add(1) = prio_bytes[1];
                            *prio_ptr.add(2) = prio_bytes[2];
                            *prio_ptr.add(3) = prio_bytes[3];
                        }
                    }
                    match i32::try_from(result.data.len()) {
                        Ok(length) => length,
                        Err(_) => return -(Errno::EOVERFLOW as i32),
                    }
                }
                Err(Errno::EAGAIN) => {
                    mq_timed_blocking_errno(channel_const_ptr!(4, u8) as usize, nonblock)
                }
                Err(e) => -(e as i32),
            }
        }
        335 => {
            // SYS_MQ_NOTIFY: (mqd, sev_ptr)
            let table = unsafe { crate::mqueue::global_mqueue_table() };
            let pid = unsafe { &*PROCESS_TABLE.0.get() }.current_pid();
            let event_pointer = channel_const_ptr!(1, u8);
            if event_pointer.is_null() {
                // NULL sigevent = unregister
                match table.mq_notify(a1 as u32, pid, None, 0, 0) {
                    Ok(()) => 0,
                    Err(e) => -(e as i32),
                }
            } else {
                let model = match crate::process_wire::ProcessDataModel::from_width(args[5]) {
                    Ok(model) => model,
                    Err(error) => return -(error as i32),
                };
                // SAFETY: the host stages the complete native sigevent under
                // the generated pointer-width-dependent descriptor.
                let input =
                    unsafe { core::slice::from_raw_parts(event_pointer, model.sigevent_size()) };
                let event = match crate::process_wire::read_sigevent(input, model) {
                    Ok(event) => event,
                    Err(error) => return -(error as i32),
                };
                match table.mq_notify(
                    a1 as u32,
                    pid,
                    Some(event.notify),
                    event.signo,
                    event.value_bits,
                ) {
                    Ok(()) => 0,
                    Err(e) => -(e as i32),
                }
            }
        }
        336 => {
            // SYS_MQ_GETSETATTR: (mqd, new_attr_ptr, old_attr_ptr)
            let model = match crate::process_wire::ProcessDataModel::from_width(args[5]) {
                Ok(model) => model,
                Err(error) => return -(error as i32),
            };
            let table = unsafe { crate::mqueue::global_mqueue_table() };
            let new_pointer = channel_const_ptr!(1, u8);
            let old_pointer = channel_mut_ptr!(2, u8);
            let new_flags = if !new_pointer.is_null() {
                // SAFETY: generated host metadata copied the exact native
                // mq_attr size into this checked scratch allocation.
                let input =
                    unsafe { core::slice::from_raw_parts(new_pointer, model.mq_attr_size()) };
                let attr = match crate::process_wire::read_mq_attr(input, model) {
                    Ok(attr) => attr,
                    Err(error) => return -(error as i32),
                };
                Some(attr.flags)
            } else {
                None
            };
            match table.mq_getsetattr(a1 as u32, new_flags) {
                Ok(attr) => {
                    if !old_pointer.is_null() {
                        // SAFETY: the host reserved exactly this caller-native
                        // output size in its checked scratch lease.
                        let output = unsafe {
                            core::slice::from_raw_parts_mut(old_pointer, model.mq_attr_size())
                        };
                        let native = crate::process_wire::NativeMqAttr {
                            flags: attr.flags,
                            maxmsg: attr.maxmsg,
                            msgsize: attr.msgsize,
                            curmsgs: attr.curmsgs,
                        };
                        if let Err(error) =
                            crate::process_wire::write_mq_attr(output, native, model)
                        {
                            return -(error as i32);
                        }
                    }
                    0
                }
                Err(e) => -(e as i32),
            }
        }

        // ───── PTHREAD_PROCESS_SHARED primitives ─────
        // See crates/kernel/src/pshared.rs. Blocking ops return EAGAIN so
        // the host retry loop re-invokes them.
        400 => {
            // SYS_PSHARED_MUTEX_INIT: (mtype)
            let t = unsafe { crate::pshared::global_pshared_table() };
            t.mutex_init(a1 as u32) as i32
        }
        401 => {
            // SYS_PSHARED_MUTEX_LOCK: (id)
            let t = unsafe { crate::pshared::global_pshared_table() };
            let pid = unsafe { &*PROCESS_TABLE.0.get() }.current_pid();
            match t.mutex_lock(a1 as u32, pid) {
                Ok(()) => 0,
                Err(e) => -(e as i32),
            }
        }
        402 => {
            // SYS_PSHARED_MUTEX_TRYLOCK: (id)
            let t = unsafe { crate::pshared::global_pshared_table() };
            let pid = unsafe { &*PROCESS_TABLE.0.get() }.current_pid();
            match t.mutex_trylock(a1 as u32, pid) {
                Ok(()) => 0,
                Err(e) => -(e as i32),
            }
        }
        403 => {
            // SYS_PSHARED_MUTEX_UNLOCK: (id)
            let t = unsafe { crate::pshared::global_pshared_table() };
            let pid = unsafe { &*PROCESS_TABLE.0.get() }.current_pid();
            match t.mutex_unlock(a1 as u32, pid) {
                Ok(()) => 0,
                Err(e) => -(e as i32),
            }
        }
        404 => {
            // SYS_PSHARED_MUTEX_DESTROY: (id)
            let t = unsafe { crate::pshared::global_pshared_table() };
            match t.mutex_destroy(a1 as u32) {
                Ok(()) => 0,
                Err(e) => -(e as i32),
            }
        }
        405 => {
            // SYS_PSHARED_COND_INIT: ()
            let t = unsafe { crate::pshared::global_pshared_table() };
            t.cond_init() as i32
        }
        406 => {
            // SYS_PSHARED_COND_WAIT_BEGIN: (cond_id, mutex_id)
            let t = unsafe { crate::pshared::global_pshared_table() };
            let pid = unsafe { &*PROCESS_TABLE.0.get() }.current_pid();
            match t.cond_wait_begin(a1 as u32, a2 as u32, pid) {
                Ok(()) => 0,
                Err(e) => -(e as i32),
            }
        }
        407 => {
            // SYS_PSHARED_COND_WAIT_CHECK: (cond_id, mutex_id)
            let t = unsafe { crate::pshared::global_pshared_table() };
            let pid = unsafe { &*PROCESS_TABLE.0.get() }.current_pid();
            match t.cond_wait_check(a1 as u32, a2 as u32, pid) {
                Ok(()) => 0,
                Err(e) => -(e as i32),
            }
        }
        408 => {
            // SYS_PSHARED_COND_SIGNAL: (cond_id)
            let t = unsafe { crate::pshared::global_pshared_table() };
            match t.cond_signal(a1 as u32) {
                Ok(_pid) => 0,
                Err(e) => -(e as i32),
            }
        }
        409 => {
            // SYS_PSHARED_COND_BROADCAST: (cond_id)
            let t = unsafe { crate::pshared::global_pshared_table() };
            match t.cond_broadcast(a1 as u32) {
                Ok(_n) => 0,
                Err(e) => -(e as i32),
            }
        }
        410 => {
            // SYS_PSHARED_COND_DESTROY: (cond_id)
            let t = unsafe { crate::pshared::global_pshared_table() };
            match t.cond_destroy(a1 as u32) {
                Ok(()) => 0,
                Err(e) => -(e as i32),
            }
        }
        411 => {
            // SYS_PSHARED_BARRIER_INIT: (count)
            let t = unsafe { crate::pshared::global_pshared_table() };
            match t.barrier_init(a1 as u32) {
                Ok(id) => id as i32,
                Err(e) => -(e as i32),
            }
        }
        412 => {
            // SYS_PSHARED_BARRIER_WAIT: (id)
            let t = unsafe { crate::pshared::global_pshared_table() };
            let pid = unsafe { &*PROCESS_TABLE.0.get() }.current_pid();
            match t.barrier_wait(a1 as u32, pid) {
                Ok(v) => v,
                Err(e) => -(e as i32),
            }
        }
        413 => {
            // SYS_PSHARED_BARRIER_DESTROY: (id)
            let t = unsafe { crate::pshared::global_pshared_table() };
            match t.barrier_destroy(a1 as u32) {
                Ok(()) => 0,
                Err(e) => -(e as i32),
            }
        }
        414 => {
            // SYS_PSHARED_COND_WAIT_ABORT: (cond_id)
            let t = unsafe { crate::pshared::global_pshared_table() };
            let pid = unsafe { &*PROCESS_TABLE.0.get() }.current_pid();
            t.cond_wait_abort(a1 as u32, pid);
            0
        }
        syscall_numbers::SYS_THREAD_CANCEL => {
            // SYS_THREAD_CANCEL: (target_tid). Host-owned wait state is woken
            // in kernel-worker.ts; release FIFO reservations and restore a
            // ppoll/pselect temporary mask before the interrupted target can
            // leave kernel-owned state behind.
            let (_gkl, proc) = unsafe { get_process() };
            let Ok(target_tid) = u32::try_from(a1) else {
                return -(Errno::ESRCH as i32);
            };
            match syscalls::cancel_host_owned_wait_for_live_tid(proc, target_tid) {
                Ok(()) => 0,
                Err(error) => -(error as i32),
            }
        }

        253..=254
        | 265..=268
        | 289
        | 292
        | 301..=303
        | 305
        | 309..=322
        | 324
        | 348..=349
        | 362..=369
        | 373..=376 => {
            // Remaining stubs: return ENOSYS
            -(Errno::ENOSYS as i32)
        }

        _ => -(Errno::ENOSYS as i32),
    }
}

#[cfg(test)]
mod channel_pointer_tests {
    use super::*;

    #[test]
    fn host_transfer_counts_are_lossless_and_capacity_bounded() {
        assert_eq!(checked_host_buffer_len(u32::MAX as usize), Ok(u32::MAX));
        if let Some(too_large) = (u32::MAX as usize).checked_add(1) {
            assert_eq!(checked_host_buffer_len(too_large), Err(Errno::EOVERFLOW),);
        }
        assert_eq!(checked_host_transfer_result(4, 4), Ok(4));
        assert_eq!(checked_host_transfer_result(5, 4), Err(Errno::EIO));
        assert_eq!(
            checked_host_transfer_result(-(Errno::EAGAIN as i32), 4),
            Err(Errno::EAGAIN),
        );
        assert_eq!(checked_host_transfer_result(i32::MIN, 4), Err(Errno::EIO),);
        assert_eq!(checked_host_i64_result(17), Ok(17));
        assert_eq!(
            checked_host_i64_result(-(Errno::EAGAIN as i64)),
            Err(Errno::EAGAIN),
        );
        assert_eq!(checked_host_i64_result(i64::MIN), Err(Errno::EIO));
        assert_eq!(
            checked_host_i64_result(-((u32::MAX as i64) + 1)),
            Err(Errno::EIO),
        );
    }

    #[test]
    fn split_i64_words_preserves_offsets_beyond_javascript_number_precision() {
        for offset in [0, (1i64 << 53) + 0x1234_5678, i64::MAX, i64::MIN, -1] {
            let (lo, hi) = split_i64_words(offset);
            let reconstructed = ((hi as i64) << 32) | i64::from(lo);
            assert_eq!(reconstructed, offset);
        }
    }

    #[test]
    fn raw_pointer_conversion_models_both_wasm_widths_without_signed_narrowing() {
        assert_eq!(checked_channel_pointer_bits(0, 32), Ok(0));
        assert_eq!(
            checked_channel_pointer_bits(u32::MAX as i64, 32),
            Ok(u32::MAX as u64)
        );
        assert_eq!(
            checked_channel_pointer_bits((u32::MAX as i64) + 1, 32),
            Err(Errno::EFAULT)
        );
        assert_eq!(checked_channel_pointer_bits(i64::MIN, 64), Ok(1u64 << 63));
        assert_eq!(checked_channel_pointer_bits(-1, 64), Ok(u64::MAX));
        assert_eq!(checked_channel_pointer_bits(0, 16), Err(Errno::EFAULT));
    }

    #[test]
    fn process_size_conversion_is_unsigned_and_exact_or_rejected() {
        let four_gib_plus_page = 0x1_0000_1000u64;
        assert_eq!(checked_process_size_bits(0, 32), Ok(0));
        assert_eq!(
            checked_process_size_bits(u32::MAX as u64, 32),
            Ok(u32::MAX as u64)
        );
        assert_eq!(
            checked_process_size_bits(four_gib_plus_page, 32),
            Err(Errno::EINVAL)
        );
        assert_eq!(
            checked_process_size_bits(four_gib_plus_page, 64),
            Ok(four_gib_plus_page)
        );
        assert_eq!(checked_process_size_bits(1u64 << 63, 64), Ok(1u64 << 63));
        assert_eq!(checked_process_size_bits(u64::MAX, 64), Ok(u64::MAX));
        assert_eq!(checked_process_size_bits(0, 16), Err(Errno::EINVAL));
    }

    #[test]
    fn typed_process_size_reader_preserves_the_physical_channel_bits() {
        let mut mmap_args = [0i64; 6];
        mmap_args[1] = i64::MIN;
        assert_eq!(
            channel_scalar::process_size_argument(46, &mmap_args, 1),
            1u64 << 63
        );

        let mut sendfile_args = [0i64; 6];
        sendfile_args[3] = -1;
        assert_eq!(
            channel_scalar::process_size_argument(294, &sendfile_args, 3),
            u64::MAX
        );
    }

    #[test]
    fn target_pointer_conversion_is_lossless_or_rejected() {
        assert_eq!(checked_channel_pointer(0), Ok(0));
        assert_eq!(
            checked_channel_pointer(u32::MAX as i64),
            Ok(u32::MAX as usize)
        );

        #[cfg(target_pointer_width = "32")]
        assert_eq!(
            checked_channel_pointer((u32::MAX as i64) + 1),
            Err(Errno::EFAULT)
        );

        #[cfg(target_pointer_width = "64")]
        {
            assert_eq!(
                checked_channel_pointer((u32::MAX as i64) + 1),
                Ok((u32::MAX as usize) + 1)
            );
            assert_eq!(checked_channel_pointer(-1), Ok(usize::MAX));
        }
    }

    #[test]
    fn zero_kernel_iovec_count_does_not_require_a_table_pointer() {
        let region = ChannelScratchRegion::new(0x1000, 16).unwrap();
        assert_eq!(
            checked_kernel_iovec_entries(core::ptr::null(), 0, region),
            Ok((Vec::new(), 0)),
        );
        assert_eq!(
            checked_kernel_iovec_entries(core::ptr::null(), -1, region),
            Err(Errno::EINVAL),
        );
        assert_eq!(
            checked_kernel_iovec_entries(
                core::ptr::null(),
                i32::try_from(platform_limits::IOV_MAX + 1).unwrap(),
                region,
            ),
            Err(Errno::EINVAL),
        );
        assert_eq!(
            checked_kernel_iovec_entries(core::ptr::null(), 1, region),
            Err(Errno::EFAULT),
        );
    }

    #[test]
    fn channel_dispatch_propagates_cstr_scan_errors_before_syscall_use() {
        let unterminated = b"unterminated";
        let region =
            ChannelScratchRegion::new(unterminated.as_ptr() as usize, unterminated.len()).unwrap();
        let mut args = [0i64; 6];
        args[0] = unterminated.as_ptr() as usize as i64;
        assert_eq!(
            dispatch_channel_syscall(43, &args, region),
            -(Errno::EFAULT as i32),
        );

        args[0] = 0;
        assert_eq!(
            dispatch_channel_syscall(43, &args, region),
            -(Errno::EFAULT as i32),
        );
    }
}

// ---------------------------------------------------------------------------
// SysV IPC kernel exports
// ---------------------------------------------------------------------------

/// Bind the current kernel/libc thread id for exactly the next
/// `kernel_handle_channel` call. Signal syscalls dispatched by that call use
/// the same validated task context.
///
/// The host tracks `(pid, channelOffset) -> tid` in its own map (`channelTids`)
/// and must call this *before* dispatching a thread-originated syscall. The
/// ProcessTable rejects a TID that it did not allocate for `pid`, so the host
/// mapping remains transport metadata rather than an identity authority.
///
/// This is ambient dispatch context for today's serialized host/kernel entry
/// model. If a single kernel instance ever services channels concurrently or
/// reentrantly, the TID should move into the syscall header or be passed as a
/// `kernel_handle_channel` argument. The main thread uses its explicit leader
/// TID, equal to `pid`. Zero is reserved for kernel-internal unit-test dispatch
/// state and is rejected here.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_set_current_tid(pid: u32, tid: u32) -> i32 {
    let table = unsafe { &mut *PROCESS_TABLE.0.get() };
    match table.bind_current_tid(pid, tid) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    }
}

/// Return the retry authority created by the task's first blocking result.
///
/// The syscall number is normalized to its scalar execution family, so a
/// host-flattened readv/writev request finds the read/write binding Rust
/// created before returning control to JavaScript. A positive value is an
/// opaque stable-target token. Zero means this syscall has no Rust target
/// class and uses only a host-owned immutable request snapshot. A mapped
/// operation with no binding fails instead of silently becoming host-only.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_blocking_retry_token(pid: u32, tid: u32, syscall_nr: u32) -> i64 {
    let _gkl = GklGuard::acquire();
    let table = unsafe { &*PROCESS_TABLE.0.get() };
    if let Err(error) = table.validate_task(pid, tid) {
        return -(error as i64);
    }
    match table
        .get(pid)
        .ok_or(Errno::ESRCH)
        .and_then(|proc| proc.blocked_retries.token_for_syscall(tid, syscall_nr))
    {
        Ok(token) => token,
        Err(error) => -(error as i64),
    }
}

/// Consume one exact blocked-retry target and its kernel-owned references.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_blocking_retry_release(pid: u32, tid: u32, token: i64) -> i32 {
    if token <= 0 {
        return -(Errno::EINVAL as i32);
    }
    let _gkl = GklGuard::acquire();
    let table = unsafe { &mut *PROCESS_TABLE.0.get() };
    let Some((proc, locks)) = table.process_and_advisory_locks(pid) else {
        return -(Errno::ESRCH as i32);
    };
    let mut host = WasmHostIO;
    match syscalls::release_blocking_retry_binding(proc, locks, &mut host, tid, token) {
        Ok(()) => 0,
        Err(error) => -(error as i32),
    }
}

/// Validate a host channel's exact task identity without installing a
/// one-shot dispatch binding.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_validate_task(pid: u32, tid: u32) -> i32 {
    let table = unsafe { &*PROCESS_TABLE.0.get() };
    match table.validate_task(pid, tid) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    }
}

/// Attach to shared memory segment. Returns segment size, or negative errno.
/// Host uses this + kernel_ipc_shm_read_chunk to transfer data to process memory.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_ipc_shmat(shmid: i32, shmaddr: i32, flags: i32) -> i32 {
    let table = unsafe { &*PROCESS_TABLE.0.get() };
    let pid = table.current_pid();
    if !table.has_current_tid_binding(pid) {
        return -(Errno::ESRCH as i32);
    }
    kernel_ipc_shmat_for_process(pid, shmid, shmaddr, flags)
}

/// Host-side SysV attachment with an explicit kernel-owned process identity.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_ipc_shmat_for_process(
    pid: u32,
    shmid: i32,
    _shmaddr: i32,
    flags: i32,
) -> i32 {
    let table = unsafe { &*PROCESS_TABLE.0.get() };
    let (uid, gid) = match table.get(pid) {
        Some(proc)
            if pid != crate::process_table::SYNTHETIC_INIT_PID
                && matches!(proc.state, ProcessState::Running | ProcessState::Stopped) =>
        {
            (proc.effective_uid(), proc.effective_gid())
        }
        _ => return -(Errno::ESRCH as i32),
    };
    let ipc = unsafe { crate::ipc::global_ipc_table() };
    match ipc.shmat(shmid, pid, flags as u32, uid, gid) {
        Ok(size) => match i32::try_from(size) {
            Ok(size) => size,
            Err(_) => {
                let _ = ipc.shmdt(shmid, pid);
                -(Errno::EOVERFLOW as i32)
            }
        },
        Err(e) => -(e as i32),
    }
}

/// Guest-originated SysV attachment for an exact live calling task.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_ipc_shmat_for_task(
    pid: u32,
    tid: u32,
    shmid: i32,
    shmaddr: i32,
    flags: i32,
) -> i32 {
    let table = unsafe { &*PROCESS_TABLE.0.get() };
    if table.validate_task(pid, tid).is_err() {
        return -(Errno::ESRCH as i32);
    }
    kernel_ipc_shmat_for_process(pid, shmid, shmaddr, flags)
}

fn ipc_record_shm_mapping(
    pid: u32,
    addr: usize,
    shmid: i32,
    size: u32,
    require_live_process: bool,
) -> Result<(), Errno> {
    let table = unsafe { &mut *PROCESS_TABLE.0.get() };
    let proc = table.get_mut(pid).ok_or(Errno::ESRCH)?;
    if proc.state == ProcessState::Limbo
        || (require_live_process
            && !matches!(proc.state, ProcessState::Running | ProcessState::Stopped))
    {
        return Err(Errno::ESRCH);
    }
    proc.record_shm_mapping(addr, shmid, size as usize)
}

/// Record one host-materialized attachment for a retained process.
///
/// This process form is used while a fork child exists in Rust but has no
/// running guest task yet. The host byte mirror is not authoritative for
/// attachment identity or lifetime.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_ipc_shm_record_mapping_for_process(
    pid: u32,
    addr: usize,
    shmid: i32,
    size: u32,
) -> i32 {
    let _gkl = GklGuard::acquire();
    match ipc_record_shm_mapping(pid, addr, shmid, size, true) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    }
}

/// Record one host-materialized attachment for an exact live calling task.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_ipc_shm_record_mapping_for_task(
    pid: u32,
    tid: u32,
    addr: usize,
    shmid: i32,
    size: u32,
) -> i32 {
    let _gkl = GklGuard::acquire();
    let table = unsafe { &*PROCESS_TABLE.0.get() };
    if let Err(e) = table.validate_task(pid, tid) {
        return -(e as i32);
    }
    match ipc_record_shm_mapping(pid, addr, shmid, size, true) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    }
}

/// Look up an attachment owned by an exact live task.
///
/// The nonnegative result packs the byte size in the upper 32 bits and the
/// shmid in the lower 32 bits. Sizes are capped when recorded so every valid
/// result remains distinguishable from a negative errno without borrowing the
/// shared scratch channel.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_ipc_shm_lookup_mapping_for_task(
    pid: u32,
    tid: u32,
    addr: usize,
) -> i64 {
    let _gkl = GklGuard::acquire();
    let table = unsafe { &*PROCESS_TABLE.0.get() };
    if let Err(e) = table.validate_task(pid, tid) {
        return -(e as i64);
    }
    let mapping = match table.get(pid).and_then(|proc| proc.shm_mapping_at(addr)) {
        Some(mapping) => mapping,
        None => return -(Errno::EINVAL as i64),
    };
    let size = match u32::try_from(mapping.size) {
        Ok(size) if size <= i32::MAX as u32 => size,
        _ => return -(Errno::EOVERFLOW as i64),
    };
    ((size as i64) << 32) | i64::from(mapping.shmid as u32)
}

fn ipc_shmdt_addr(pid: u32, addr: usize, require_live_process: bool) -> Result<(), Errno> {
    let table = unsafe { &mut *PROCESS_TABLE.0.get() };
    let mapping = {
        let proc = table.get(pid).ok_or(Errno::ESRCH)?;
        if pid == crate::process_table::SYNTHETIC_INIT_PID
            || proc.state == ProcessState::Limbo
            || (require_live_process
                && !matches!(proc.state, ProcessState::Running | ProcessState::Stopped))
        {
            return Err(Errno::ESRCH);
        }
        proc.shm_mapping_at(addr).ok_or(Errno::EINVAL)?
    };

    // Remove metadata only after nattch was released. A failed detach leaves
    // the exact record available for teardown or a truthful retry.
    unsafe { crate::ipc::global_ipc_table() }.shmdt(mapping.shmid, pid)?;
    match table.get_mut(pid).and_then(|proc| proc.remove_shm_mapping(addr)) {
        Some(removed) if removed == mapping => Ok(()),
        _ => Err(Errno::EIO),
    }
}

/// Detach the attachment at an exact address for a retained process.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_ipc_shmdt_addr_for_process(pid: u32, addr: usize) -> i32 {
    let _gkl = GklGuard::acquire();
    match ipc_shmdt_addr(pid, addr, false) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    }
}

/// Detach the attachment at an exact address for a live calling task.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_ipc_shmdt_addr_for_task(pid: u32, tid: u32, addr: usize) -> i32 {
    let _gkl = GklGuard::acquire();
    let table = unsafe { &*PROCESS_TABLE.0.get() };
    if let Err(e) = table.validate_task(pid, tid) {
        return -(e as i32);
    }
    match ipc_shmdt_addr(pid, addr, true) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    }
}

/// Dispatch-bound shmdt wrapper used by the scalar syscall path.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_ipc_shmdt_addr(addr: usize) -> i32 {
    let table = unsafe { &*PROCESS_TABLE.0.get() };
    let pid = table.current_pid();
    let tid = table.current_tid();
    if pid == 0 || tid == 0 || table.validate_task(pid, tid).is_err() {
        return -(Errno::ESRCH as i32);
    }
    match ipc_shmdt_addr(pid, addr, true) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    }
}

/// Detach from shared memory segment.
/// Host should call kernel_ipc_shm_write_chunk first to sync data back.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_ipc_shmdt(shmid: i32) -> i32 {
    let table = unsafe { &*PROCESS_TABLE.0.get() };
    let pid = table.current_pid();
    if !table.has_current_tid_binding(pid) {
        return -(Errno::ESRCH as i32);
    }
    kernel_ipc_shmdt_for_process(pid, shmid)
}

/// Host-side SysV detach with an explicit retained process identity. Exited
/// zombies remain eligible so teardown can release attachments after death.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_ipc_shmdt_for_process(pid: u32, shmid: i32) -> i32 {
    let table = unsafe { &*PROCESS_TABLE.0.get() };
    match table.get(pid) {
        Some(proc)
            if pid != crate::process_table::SYNTHETIC_INIT_PID
                && proc.state != ProcessState::Limbo => {}
        _ => return -(Errno::ESRCH as i32),
    }
    let ipc = unsafe { crate::ipc::global_ipc_table() };
    match ipc.shmdt(shmid, pid) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    }
}

/// Guest-originated SysV detach for an exact live calling task.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_ipc_shmdt_for_task(pid: u32, tid: u32, shmid: i32) -> i32 {
    let table = unsafe { &*PROCESS_TABLE.0.get() };
    if table.validate_task(pid, tid).is_err() {
        return -(Errno::ESRCH as i32);
    }
    kernel_ipc_shmdt_for_process(pid, shmid)
}

/// Read a chunk of shared memory segment data into scratch area.
/// Returns bytes written to out_ptr.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_ipc_shm_read_chunk(
    shmid: i32,
    offset: u32,
    out_ptr: *mut u8,
    max_len: u32,
) -> i32 {
    let ipc = unsafe { crate::ipc::global_ipc_table() };
    let buf = unsafe { core::slice::from_raw_parts_mut(out_ptr, max_len as usize) };
    match ipc.shm_read_chunk(shmid, offset, buf) {
        Ok(n) => n as i32,
        Err(e) => -(e as i32),
    }
}

/// Write a chunk of data from scratch area into shared memory segment.
/// Returns bytes written.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_ipc_shm_write_chunk(
    shmid: i32,
    offset: u32,
    data_ptr: *const u8,
    data_len: u32,
) -> i32 {
    let ipc = unsafe { crate::ipc::global_ipc_table() };
    let data = unsafe { core::slice::from_raw_parts(data_ptr, data_len as usize) };
    match ipc.shm_write_chunk(shmid, offset, data) {
        Ok(n) => n as i32,
        Err(e) => -(e as i32),
    }
}

/// Byte size of the target musl `struct semid_ds`.
///
/// `pointer_width` is the caller process width in bytes, not the kernel Wasm
/// width: one kernel may serve wasm32 and wasm64 processes. wasm32 uses its
/// time64 ILP32 layout; wasm64 uses the LP64 layout. The host queries this
/// before validating or allocating the IPC_STAT transfer.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_semid_ds_bytes(pointer_width: u32) -> i32 {
    match crate::ipc_wire::semid_ds_size(pointer_width) {
        Ok(size) => size as i32,
        Err(error) => -(error as i32),
    }
}

/// Byte size of the target musl `struct msqid_ds`.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_msqid_ds_bytes(pointer_width: u32) -> i32 {
    match crate::ipc_wire::msqid_ds_size(pointer_width) {
        Ok(size) => size as i32,
        Err(error) => -(error as i32),
    }
}

/// Byte size of the target musl `struct shmid_ds`.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_shmid_ds_bytes(pointer_width: u32) -> i32 {
    match crate::ipc_wire::shmid_ds_size(pointer_width) {
        Ok(size) => size as i32,
        Err(error) => -(error as i32),
    }
}

/// Return the exact kernel-owned array size used by semctl GETALL/SETALL.
///
/// The host validates the caller range against this value before moving any
/// bytes into or out of kernel scratch. Permission checking happens here so
/// the sizing preflight cannot disclose metadata the command itself could not
/// access. PID and TID are explicit because a sizing query must not install or
/// consume the one-shot ambient binding reserved for `kernel_handle_channel`.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_semctl_array_bytes(pid: u32, tid: u32, semid: i32, cmd: i32) -> i32 {
    let table = unsafe { &*PROCESS_TABLE.0.get() };
    if let Err(error) = table.validate_task(pid, tid) {
        return -(error as i32);
    }
    let (uid, gid) = match table.get(pid) {
        Some(process) => (process.effective_uid(), process.effective_gid()),
        None => return -(Errno::ESRCH as i32),
    };
    let ipc = unsafe { crate::ipc::global_ipc_table() };
    match ipc.semctl_array_bytes(semid, cmd & !0x100, uid, gid) {
        Ok(bytes) => i32::try_from(bytes).unwrap_or(-(Errno::EOVERFLOW as i32)),
        Err(error) => -(error as i32),
    }
}

// ---------------------------------------------------------------------------
// POSIX mqueue kernel exports
// ---------------------------------------------------------------------------

/// Return the configured maximum message size for one queue descriptor.
///
/// PID and TID are explicit because this is a host sizing preflight, not a
/// channel dispatch: it must validate the caller without installing or
/// consuming the one-shot ambient task binding used by `kernel_handle_channel`.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_mq_descriptor_msgsize(pid: u32, tid: u32, mqd: i32) -> i32 {
    let process_table = unsafe { &*PROCESS_TABLE.0.get() };
    if let Err(error) = process_table.validate_task(pid, tid) {
        return -(error as i32);
    }
    if mqd < 0 {
        return -(Errno::EBADF as i32);
    }
    let table = unsafe { crate::mqueue::global_mqueue_table() };
    match table.descriptor_msgsize(mqd as u32) {
        Ok(size) => i32::try_from(size).unwrap_or(-(Errno::EOVERFLOW as i32)),
        Err(error) => -(error as i32),
    }
}

fn queue_mqueue_signal_notification(
    process_table: &mut crate::process_table::ProcessTable,
    notification: crate::mqueue::MqNotification,
    sender_pid: u32,
    sender_uid: u32,
) -> bool {
    const SI_MESGQ: i32 = -3;

    if notification.signo == 0 {
        return false;
    }
    let Some(target) = process_table.get_mut(notification.pid) else {
        return false;
    };
    target.raise_signal_with_metadata(
        notification.signo,
        notification.value_bits,
        SI_MESGQ,
        sender_pid,
        sender_uid,
    )
}

/// Drain pending mqueue notification. Writes (pid: u32, signo: u32) to out_ptr.
///
/// The signal and its full-width `sigev_value` have already been queued in
/// Rust. This detached record gives the host only the process/signum needed to
/// wake blocked work; it must not synthesize a second signal.
/// Returns 1 if a notification was pending, 0 otherwise.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_mq_drain_notification(out_ptr: *mut u8, out_capacity: u32) -> i32 {
    if out_ptr.is_null() {
        return -(Errno::EFAULT as i32);
    }
    if out_capacity != wasm_posix_shared::kernel_scratch_wire::MQUEUE_NOTIFICATION_BYTES {
        return -(Errno::EINVAL as i32);
    }
    let table = unsafe { crate::mqueue::global_mqueue_table() };
    match table.take_pending_notification() {
        Some(notif) => {
            let pid_bytes = notif.pid.to_le_bytes();
            let signo_bytes = notif.signo.to_le_bytes();
            unsafe {
                for i in 0..4 {
                    *out_ptr.add(i) = pid_bytes[i];
                }
                for i in 0..4 {
                    *out_ptr.add(4 + i) = signo_bytes[i];
                }
            }
            1
        }
        None => 0,
    }
}

/// Check if an fd is a mqueue descriptor.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_mq_is_mqd(fd: i32) -> i32 {
    let table = unsafe { crate::mqueue::global_mqueue_table() };
    if table.is_mqd(fd as u32) {
        1
    } else {
        0
    }
}

/// Serialize current process state for fork. Returns bytes written, or negative errno.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_get_fork_state(buf_ptr: *mut u8, buf_len: u32) -> i32 {
    let (_gkl, proc, advisory_locks) = unsafe { get_process_and_advisory_locks() };
    let buf = unsafe { core::slice::from_raw_parts_mut(buf_ptr, buf_len as usize) };
    match crate::fork::serialize_fork_state(proc, buf) {
        Ok(written) => written as i32,
        Err(e) => -(e as i32),
    }
}

/// Convert a pipe's OFD from kernel-internal to host-delegated.
/// After this, reads/writes for this OFD will go through host_read/host_write.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_convert_pipe_to_host(ofd_idx: u32, new_host_handle: i64) -> i32 {
    let (_gkl, proc, advisory_locks) = unsafe { get_process_and_advisory_locks() };
    let ofd = match proc.ofd_table.get_mut(ofd_idx as usize) {
        Some(ofd) => ofd,
        None => return -(Errno::EBADF as i32),
    };
    if ofd.file_type != FileType::Pipe {
        return -(Errno::EINVAL as i32);
    }
    ofd.host_handle = new_host_handle;
    0
}

/// Enumerate pipe OFDs. Writes (ofd_index: u32, host_handle: i64, is_read: u32) tuples to buf.
/// Returns number of pipe OFDs found.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_get_pipe_ofds(buf_ptr: *mut u8, buf_len: u32) -> i32 {
    let (_gkl, proc, advisory_locks) = unsafe { get_process_and_advisory_locks() };
    let buf = unsafe { core::slice::from_raw_parts_mut(buf_ptr, buf_len as usize) };
    let entry_size = 4 + 8 + 4; // ofd_index(u32) + host_handle(i64) + is_read(u32)
    let max_entries = buf.len() / entry_size;
    let mut count = 0usize;

    for (idx, ofd) in proc.ofd_table.iter() {
        if ofd.file_type == FileType::Pipe && count < max_entries {
            let off = count * entry_size;
            buf[off..off + 4].copy_from_slice(&(idx as u32).to_le_bytes());
            buf[off + 4..off + 12].copy_from_slice(&ofd.host_handle.to_le_bytes());
            // Pipes with offset 0 (or flag-based) are write ends; kernel uses
            // positive host_handle index parity to distinguish read/write.
            // Since pipe pairs share the same |host_handle|, we check status_flags
            // for O_WRONLY (bit 0) to determine end.
            let is_read = if ofd.status_flags() & 1 == 0 {
                1u32
            } else {
                0u32
            };
            buf[off + 12..off + 16].copy_from_slice(&is_read.to_le_bytes());
            count += 1;
        }
    }
    count as i32
}

/// Open a file. Returns fd (>= 0) on success, or negative errno on error.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_open(path_ptr: *const u8, path_len: u32, flags: u32, mode: u32) -> i32 {
    let (_gkl, proc, advisory_locks) = unsafe { get_process_and_advisory_locks() };
    let path = unsafe { slice::from_raw_parts(path_ptr, path_len as usize) };
    let mut host = WasmHostIO;
    let result = match syscalls::sys_open(proc, &mut host, path, flags, mode) {
        Ok(fd) => fd,
        Err(e) => -(e as i32),
    };
    deliver_pending_signals_with_locks(proc, advisory_locks, &mut host);
    result
}

/// mknod — create a regular file node.
/// Only supports S_IFREG (regular files). Creates an empty file via open+close.
fn kernel_mknod(path_ptr: *const u8, path_len: u32, mode: u32) -> i32 {
    use wasm_posix_shared::flags::{O_CREAT, O_EXCL, O_WRONLY};
    let (_gkl, proc, advisory_locks) = unsafe { get_process_and_advisory_locks() };
    let path = unsafe { slice::from_raw_parts(path_ptr, path_len as usize) };
    let mut host = WasmHostIO;
    let flags = O_CREAT | O_EXCL | O_WRONLY;
    match syscalls::sys_open(proc, &mut host, path, flags, mode) {
        Ok(fd) => {
            let _ =
                syscalls::sys_close_implicit_with_locks(proc, advisory_locks, &mut host, fd);
            0
        }
        Err(e) => -(e as i32),
    }
}

/// mkfifo / mknod(S_IFIFO) — create a named FIFO (real pipe semantics).
fn kernel_mkfifo(path_ptr: *const u8, path_len: u32, mode: u32) -> i32 {
    let (_gkl, proc) = unsafe { get_process() };
    let path = unsafe { slice::from_raw_parts(path_ptr, path_len as usize) };
    let mut host = WasmHostIO;
    match syscalls::sys_mkfifo(proc, &mut host, path, mode) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    }
}

/// mkfifoat / mknodat(S_IFIFO) — create a named FIFO relative to a directory fd.
fn kernel_mkfifoat(dirfd: i32, path_ptr: *const u8, path_len: u32, mode: u32) -> i32 {
    let (_gkl, proc) = unsafe { get_process() };
    let path = unsafe { slice::from_raw_parts(path_ptr, path_len as usize) };
    let mut host = WasmHostIO;
    match syscalls::sys_mkfifoat(proc, &mut host, dirfd, path, mode) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    }
}

/// mknodat — create a regular file node relative to directory fd.
fn kernel_mknodat(dirfd: i32, path_ptr: *const u8, path_len: u32, mode: u32) -> i32 {
    use wasm_posix_shared::flags::{O_CREAT, O_EXCL, O_WRONLY};
    let (_gkl, proc, advisory_locks) = unsafe { get_process_and_advisory_locks() };
    let path = unsafe { slice::from_raw_parts(path_ptr, path_len as usize) };
    let mut host = WasmHostIO;
    let flags = O_CREAT | O_EXCL | O_WRONLY;
    match syscalls::sys_openat(proc, &mut host, dirfd, path, flags, mode) {
        Ok(fd) => {
            let _ =
                syscalls::sys_close_implicit_with_locks(proc, advisory_locks, &mut host, fd);
            0
        }
        Err(e) => -(e as i32),
    }
}

/// Close a file descriptor. Returns 0 on success, or negative errno on error.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_close(fd: i32) -> i32 {
    let (_gkl, proc, advisory_locks) = unsafe { get_process_and_advisory_locks() };
    let mut host = WasmHostIO;
    let result = match syscalls::sys_close_with_locks(proc, advisory_locks, &mut host, fd) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    };
    deliver_pending_signals_with_locks(proc, advisory_locks, &mut host);
    result
}

/// Read into one already-proven live channel slice.
///
/// WHY: this adapter is private so no host can supply a bare kernel pointer
/// without the channel dispatcher first proving the allocation and extent.
fn channel_read(fd: i32, buf: &mut [u8]) -> i32 {
    let (_gkl, proc, advisory_locks) = unsafe { get_process_and_advisory_locks() };
    let mut host = WasmHostIO;
    let result = match syscalls::sys_read(proc, &mut host, fd, buf) {
        Ok(n) => n as i32,
        Err(e) => -(e as i32),
    };
    syscalls::drain_deferred_scm_rights_releases(advisory_locks, &mut host);
    deliver_pending_signals_with_locks(proc, advisory_locks, &mut host);
    result
}

/// Write from one already-proven live channel slice.
fn channel_write(fd: i32, buf: &[u8]) -> i32 {
    let (_gkl, proc, advisory_locks) = unsafe { get_process_and_advisory_locks() };
    let mut host = WasmHostIO;
    let result = match syscalls::sys_write(proc, &mut host, fd, buf) {
        Ok(n) => n as i32,
        Err(e) => -(e as i32),
    };
    deliver_pending_signals_with_locks(proc, advisory_locks, &mut host);
    result
}

/// Seek within a file. The 64-bit offset is passed as two 32-bit halves
/// because some Wasm host bindings lack native i64 support.
/// Returns the new offset (i64) or negative errno (i64).
#[unsafe(no_mangle)]
pub extern "C" fn kernel_lseek(fd: i32, offset_lo: u32, offset_hi: i32, whence: u32) -> i64 {
    let (_gkl, proc, advisory_locks) = unsafe { get_process_and_advisory_locks() };
    let mut host = WasmHostIO;
    let offset = ((offset_hi as i64) << 32) | (offset_lo as u64 as i64);
    let result = match syscalls::sys_lseek(proc, &mut host, fd, offset, whence) {
        Ok(pos) => pos,
        Err(e) => -(e as i64),
    };
    deliver_pending_signals_with_locks(proc, advisory_locks, &mut host);
    result
}

/// Positioned read into one already-proven live channel slice.
fn channel_pread(fd: i32, buf: &mut [u8], offset: i64) -> i32 {
    let (_gkl, proc, advisory_locks) = unsafe { get_process_and_advisory_locks() };
    let mut host = WasmHostIO;
    let result = match syscalls::sys_pread(proc, &mut host, fd, buf, offset) {
        Ok(n) => n as i32,
        Err(e) => -(e as i32),
    };
    deliver_pending_signals_with_locks(proc, advisory_locks, &mut host);
    result
}

/// Positioned write from one already-proven live channel slice.
fn channel_pwrite(fd: i32, buf: &[u8], offset: i64) -> i32 {
    let (_gkl, proc, advisory_locks) = unsafe { get_process_and_advisory_locks() };
    let mut host = WasmHostIO;
    let result = match syscalls::sys_pwrite(proc, &mut host, fd, buf, offset) {
        Ok(n) => n as i32,
        Err(e) => -(e as i32),
    };
    deliver_pending_signals_with_locks(proc, advisory_locks, &mut host);
    result
}

fn execute_transfer_io_for_task(
    pid: u32,
    tid: u32,
    original_syscall: u32,
    fd: i32,
    offset: i64,
    bytes: &mut [u8],
    retry_token: i64,
) -> Result<usize, Errno> {
    use crate::transfer::TransferIoOperation;

    let _gkl = GklGuard::acquire();
    let table = unsafe { &mut *PROCESS_TABLE.0.get() };
    table.bind_current_tid(pid, tid)?;
    let activation = (|| {
        let operation =
            crate::blocked_retry::BlockingRetryOperation::from_syscall(original_syscall)?;
        let proc = table.current_process().ok_or(Errno::ESRCH)?;
        proc.blocked_retries.begin_dispatch(tid)?;
        if retry_token == 0 {
            let result = if proc.blocked_retries.has_binding_for_tid(tid) {
                Err(Errno::EBUSY)
            } else {
                Ok(())
            };
            if result.is_err() {
                proc.blocked_retries.clear_dispatch();
            }
            return result;
        }
        if retry_token < 0 {
            proc.blocked_retries.clear_dispatch();
            return Err(Errno::EINVAL);
        }
        let result = proc.blocked_retries.activate(tid, retry_token, operation);
        if result.is_err() {
            proc.blocked_retries.clear_dispatch();
        }
        result
    })();
    if let Err(error) = activation {
        table.clear_current_tid_binding();
        return Err(error);
    }

    // WHY: bind_current_tid installs the same exact-task context consumed by
    // ordinary channel dispatch. write_operation_budget, directed signals,
    // and SCM_RIGHTS cleanup must see the actual issuing TID, not ambient
    // state from the preceding mailbox.
    let result = (|| {
        let (proc, advisory_locks) = table
            .current_process_and_advisory_locks()
            .ok_or(Errno::ESRCH)?;
        let mut host = WasmHostIO;
        let mut result = match crate::transfer::io_operation_for_syscall(original_syscall) {
            Ok(TransferIoOperation::Read) => syscalls::sys_read(proc, &mut host, fd, bytes),
            Ok(TransferIoOperation::Write) => syscalls::sys_write(proc, &mut host, fd, bytes),
            Ok(TransferIoOperation::Pread) => {
                syscalls::sys_pread(proc, &mut host, fd, bytes, offset)
            }
            Ok(TransferIoOperation::Pwrite) => {
                syscalls::sys_pwrite(proc, &mut host, fd, bytes, offset)
            }
            Err(error) => Err(error),
        };
        if result == Err(Errno::EAGAIN) {
            if let Err(error) = syscalls::ensure_blocking_retry_ofd_binding(
                proc,
                advisory_locks,
                &mut host,
                tid,
                original_syscall,
                fd,
                None,
            ) {
                result = Err(error);
            }
        }
        proc.blocked_retries.clear_active();
        proc.blocked_retries.clear_dispatch();
        syscalls::drain_deferred_scm_rights_releases(advisory_locks, &mut host);
        let _ = deliver_pending_signals_for_tid_with_locks(proc, advisory_locks, &mut host, tid);
        result
    })();

    // All ordinary success and errno paths consume this one-shot task
    // authority. A host-import exception traps the Wasm call before cleanup;
    // the host must terminate that failed kernel instance, just as it must not
    // reuse the transfer's irrecoverable Executing token.
    table.clear_current_tid_binding();
    result
}

/// Execute one large scalar or vector I/O operation against a Reserved token.
///
/// Vector syscall numbers deliberately map to exactly one scalar kernel
/// operation because the host has already flattened their iovecs into the
/// reservation. The return is a non-negative byte count or negated errno.
///
/// WHY: this token-only call is a narrowly trusted host-adapter boundary. It
/// carries no raw pointer; the active transfer-region lease remains the sole
/// authority for the Rust-owned allocation.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_transfer_io_execute(
    pid: u32,
    tid: u32,
    token: i64,
    length: usize,
    original_syscall: u32,
    fd: i32,
    offset: i64,
    retry_token: i64,
) -> i32 {
    match crate::transfer::execute_transfer_with(token, length, |bytes| {
        execute_transfer_io_for_task(pid, tid, original_syscall, fd, offset, bytes, retry_token)
    }) {
        Ok(length) => length as i32,
        Err(error) => -(error as i32),
    }
}

/// Execute one complete widened channel in a token-owned Rust allocation.
///
/// The export accepts no pointer or host-supplied capacity. Reserved →
/// Executing atomically yields the Vec's own initialized base and length, and
/// the transfer mutex is released before task binding, syscall dispatch, or
/// any host import. A return value of zero means only that the transport
/// completed; the syscall's exact result and errno are authoritative in the
/// channel header.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_transfer_channel_execute(
    pid: u32,
    tid: u32,
    token: i64,
    retry_token: i64,
) -> i32 {
    use wasm_posix_shared::channel::MIN_CHANNEL_SIZE;

    match crate::transfer::execute_channel_transfer_with(token, |bytes| {
        if bytes.len() < MIN_CHANNEL_SIZE {
            return Err(Errno::EINVAL);
        }

        let _gkl = GklGuard::acquire();
        let table = unsafe { &mut *PROCESS_TABLE.0.get() };
        table.bind_current_tid(pid, tid)?;

        // handle_owned_channel_allocation consumes the exact binding and runs
        // the same SCM_RIGHTS cleanup boundary as the ordinary channel.
        let _syscall_mirror = handle_owned_channel_allocation(
            bytes.as_mut_ptr() as usize,
            bytes.len(),
            pid,
            retry_token,
        );
        Ok(())
    }) {
        Ok(()) => 0,
        Err(error) => -(error as i32),
    }
}

/// Duplicate a file descriptor. Returns new fd (>= 0) or negative errno.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_dup(fd: i32) -> i32 {
    let (_gkl, proc, advisory_locks) = unsafe { get_process_and_advisory_locks() };
    let result = match syscalls::sys_dup(proc, fd) {
        Ok(new_fd) => new_fd,
        Err(e) => -(e as i32),
    };
    let mut host = WasmHostIO;
    deliver_pending_signals_with_locks(proc, advisory_locks, &mut host);
    result
}

/// Duplicate a file descriptor to a specific target fd.
/// Returns newfd (>= 0) or negative errno.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_dup2(oldfd: i32, newfd: i32) -> i32 {
    let (_gkl, proc, advisory_locks) = unsafe { get_process_and_advisory_locks() };
    let mut host = WasmHostIO;
    let result = match syscalls::sys_dup2_with_locks(proc, advisory_locks, &mut host, oldfd, newfd)
    {
        Ok(fd) => fd,
        Err(e) => -(e as i32),
    };
    deliver_pending_signals_with_locks(proc, advisory_locks, &mut host);
    result
}

/// Create a pipe. Writes [read_fd, write_fd] to the pointer.
/// Returns 0 on success, or negative errno on error.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_pipe(fildes_ptr: *mut i32) -> i32 {
    let (_gkl, proc, advisory_locks) = unsafe { get_process_and_advisory_locks() };
    let result = match syscalls::sys_pipe(proc) {
        Ok((read_fd, write_fd)) => {
            unsafe {
                *fildes_ptr = read_fd;
                *fildes_ptr.add(1) = write_fd;
            }
            0
        }
        Err(e) => -(e as i32),
    };
    let mut host = WasmHostIO;
    deliver_pending_signals_with_locks(proc, advisory_locks, &mut host);
    result
}

/// Duplicate a file descriptor to a specific target fd with flags.
/// Returns newfd (>= 0) or negative errno.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_dup3(oldfd: i32, newfd: i32, flags: u32) -> i32 {
    let (_gkl, proc, advisory_locks) = unsafe { get_process_and_advisory_locks() };
    let mut host = WasmHostIO;
    let result =
        match syscalls::sys_dup3_with_locks(proc, advisory_locks, &mut host, oldfd, newfd, flags) {
            Ok(fd) => fd,
            Err(e) => -(e as i32),
        };
    deliver_pending_signals_with_locks(proc, advisory_locks, &mut host);
    result
}

/// Create a pipe with flags. Writes [read_fd, write_fd] to the pointer.
/// Returns 0 on success, or negative errno on error.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_pipe2(flags: u32, fd_ptr: *mut i32, fd_capacity: u32) -> i32 {
    if fd_ptr.is_null() {
        return -(Errno::EFAULT as i32);
    }
    if fd_capacity != wasm_posix_shared::kernel_scratch_wire::FD_PAIR_BYTES {
        return -(Errno::EINVAL as i32);
    }
    if (fd_ptr as usize) % core::mem::align_of::<i32>() != 0 {
        return -(Errno::EFAULT as i32);
    }
    let (_gkl, proc, advisory_locks) = unsafe { get_process_and_advisory_locks() };
    let result = match syscalls::sys_pipe2(proc, flags) {
        Ok((r, w)) => {
            unsafe {
                *fd_ptr = r;
                *fd_ptr.add(1) = w;
            }
            0
        }
        Err(e) => -(e as i32),
    };
    let mut host = WasmHostIO;
    deliver_pending_signals_with_locks(proc, advisory_locks, &mut host);
    result
}

/// Create an eventfd file descriptor.
/// Returns fd (>= 0) on success, or negative errno on error.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_eventfd2(initval: u32, flags: u32) -> i32 {
    let (_gkl, proc, advisory_locks) = unsafe { get_process_and_advisory_locks() };
    let result = match syscalls::sys_eventfd2(proc, initval, flags) {
        Ok(fd) => fd,
        Err(e) => -(e as i32),
    };
    let mut host = WasmHostIO;
    deliver_pending_signals_with_locks(proc, advisory_locks, &mut host);
    result
}

/// Create an epoll instance.
/// Returns fd (>= 0) on success, or negative errno on error.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_epoll_create1(flags: u32) -> i32 {
    let (_gkl, proc, advisory_locks) = unsafe { get_process_and_advisory_locks() };
    let result = match syscalls::sys_epoll_create1(proc, flags) {
        Ok(fd) => fd,
        Err(e) => -(e as i32),
    };
    let mut host = WasmHostIO;
    deliver_pending_signals_with_locks(proc, advisory_locks, &mut host);
    result
}

/// Modify an epoll interest list.
/// Returns 0 on success, or negative errno on error.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_epoll_ctl(epfd: i32, op: i32, fd: i32, event_ptr: *const u8) -> i32 {
    let (_gkl, proc, advisory_locks) = unsafe { get_process_and_advisory_locks() };

    let (events, data) = if !event_ptr.is_null() {
        // The shared record is compiler-checked against both Kandelo musl
        // targets: 16-byte stride, with data at offset 8.
        let event = unsafe {
            core::ptr::read_unaligned(event_ptr.cast::<wasm_posix_shared::WasmEpollEvent>())
        };
        (event.events, event.data)
    } else {
        (0u32, 0u64)
    };

    let result = match syscalls::sys_epoll_ctl(proc, epfd, op, fd, events, data) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    };
    let mut host = WasmHostIO;
    deliver_pending_signals_with_locks(proc, advisory_locks, &mut host);
    result
}

/// Wait for events on an epoll instance.
/// Returns number of ready events (>= 0), or negative errno on error.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_epoll_pwait(
    epfd: i32,
    events_ptr: *mut u8,
    maxevents: i32,
    timeout: i32,
    sigmask_ptr: *const u8,
) -> i32 {
    let (_gkl, proc, advisory_locks) = unsafe { get_process_and_advisory_locks() };
    let mut host = WasmHostIO;

    // Read signal mask if provided
    let sigmask = if !sigmask_ptr.is_null() {
        Some(unsafe { *(sigmask_ptr as *const u64) })
    } else {
        None
    };

    let result = match syscalls::sys_epoll_pwait(proc, &mut host, epfd, maxevents, timeout, sigmask)
    {
        Ok((count, events)) => {
            for (i, (ev, data)) in events.iter().enumerate() {
                let event = wasm_posix_shared::WasmEpollEvent {
                    events: *ev,
                    _pad: 0,
                    data: *data,
                };
                unsafe {
                    core::ptr::write_unaligned(
                        events_ptr
                            .add(i * core::mem::size_of::<wasm_posix_shared::WasmEpollEvent>())
                            .cast::<wasm_posix_shared::WasmEpollEvent>(),
                        event,
                    );
                }
            }
            count
        }
        Err(e) => -(e as i32),
    };
    deliver_pending_signals_with_locks(proc, advisory_locks, &mut host);
    result
}

/// Create a timerfd.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_timerfd_create(clock_id: u32, flags: u32) -> i32 {
    let (_gkl, proc, advisory_locks) = unsafe { get_process_and_advisory_locks() };
    let result = match syscalls::sys_timerfd_create(proc, clock_id, flags) {
        Ok(fd) => fd,
        Err(e) => -(e as i32),
    };
    let mut host = WasmHostIO;
    deliver_pending_signals_with_locks(proc, advisory_locks, &mut host);
    result
}

/// Set or disarm a timerfd timer.
/// new_value_ptr points to itimerspec (32 bytes: interval_sec, interval_nsec, value_sec, value_nsec).
/// old_value_ptr (if non-null) receives the old itimerspec.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_timerfd_settime(
    fd: i32,
    flags: u32,
    new_ptr: *const u8,
    old_ptr: *mut u8,
) -> i32 {
    let (_gkl, proc, advisory_locks) = unsafe { get_process_and_advisory_locks() };
    let mut host = WasmHostIO;

    // Read itimerspec: { it_interval: { tv_sec, tv_nsec }, it_value: { tv_sec, tv_nsec } }
    // On wasm32: each field is i64, so 4 x 8 = 32 bytes total
    let (isec, insec, vsec, vnsec) = unsafe {
        let isec = core::ptr::read_unaligned(new_ptr as *const i64);
        let insec = core::ptr::read_unaligned(new_ptr.add(8) as *const i64);
        let vsec = core::ptr::read_unaligned(new_ptr.add(16) as *const i64);
        let vnsec = core::ptr::read_unaligned(new_ptr.add(24) as *const i64);
        (isec, insec, vsec, vnsec)
    };

    let result =
        match syscalls::sys_timerfd_settime(proc, &mut host, fd, flags, isec, insec, vsec, vnsec) {
            Ok((oisec, oinsec, ovsec, ovnsec)) => {
                if !old_ptr.is_null() {
                    unsafe {
                        core::ptr::write_unaligned(old_ptr as *mut i64, oisec);
                        core::ptr::write_unaligned(old_ptr.add(8) as *mut i64, oinsec);
                        core::ptr::write_unaligned(old_ptr.add(16) as *mut i64, ovsec);
                        core::ptr::write_unaligned(old_ptr.add(24) as *mut i64, ovnsec);
                    }
                }
                0
            }
            Err(e) => -(e as i32),
        };
    deliver_pending_signals_with_locks(proc, advisory_locks, &mut host);
    result
}

/// Get the remaining time of a timerfd timer.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_timerfd_gettime(fd: i32, cur_ptr: *mut u8) -> i32 {
    let (_gkl, proc, advisory_locks) = unsafe { get_process_and_advisory_locks() };
    let mut host = WasmHostIO;

    let result = match syscalls::sys_timerfd_gettime(proc, &mut host, fd) {
        Ok((isec, insec, vsec, vnsec)) => {
            unsafe {
                core::ptr::write_unaligned(cur_ptr as *mut i64, isec);
                core::ptr::write_unaligned(cur_ptr.add(8) as *mut i64, insec);
                core::ptr::write_unaligned(cur_ptr.add(16) as *mut i64, vsec);
                core::ptr::write_unaligned(cur_ptr.add(24) as *mut i64, vnsec);
            }
            0
        }
        Err(e) => -(e as i32),
    };
    deliver_pending_signals_with_locks(proc, advisory_locks, &mut host);
    result
}

/// Create or update a signalfd.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_signalfd4(
    fd: i32,
    mask_ptr: *const u8,
    sigsetsize: usize,
    flags: u32,
) -> i32 {
    if sigsetsize != core::mem::size_of::<u64>() {
        return -(Errno::EINVAL as i32);
    }
    if mask_ptr.is_null() {
        return -(Errno::EFAULT as i32);
    }
    let (_gkl, proc, advisory_locks) = unsafe { get_process_and_advisory_locks() };

    // The descriptor lends exactly one checked sigset word. Use an unaligned
    // read so the Rust access contract does not silently demand more from the
    // scratch allocator than the eight bytes declared by the host.
    let mask = unsafe { core::ptr::read_unaligned(mask_ptr.cast::<u64>()) };

    let result = match syscalls::sys_signalfd4(proc, fd, mask, flags) {
        Ok(fd) => fd,
        Err(e) => -(e as i32),
    };
    let mut host = WasmHostIO;
    deliver_pending_signals_with_locks(proc, advisory_locks, &mut host);
    result
}

fn write_process_stat(stat_ptr: *mut u8, stat: &WasmStat) -> Result<(), Errno> {
    if stat_ptr.is_null() {
        return Err(Errno::EFAULT);
    }
    let bytes = unsafe {
        slice::from_raw_parts_mut(
            stat_ptr,
            wasm_posix_shared::process_layout::stat::SIZE as usize,
        )
    };
    crate::process_wire::write_stat(bytes, stat)
}

/// Get file status. Writes a complete native musl `struct kstat`.
/// Returns 0 on success, or negative errno on error.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_fstat(fd: i32, stat_ptr: *mut u8) -> i32 {
    let (_gkl, proc, advisory_locks) = unsafe { get_process_and_advisory_locks() };
    let mut host = WasmHostIO;
    let result = match syscalls::sys_fstat(proc, &mut host, fd) {
        Ok(stat) => match write_process_stat(stat_ptr, &stat) {
            Ok(()) => 0,
            Err(error) => -(error as i32),
        },
        Err(e) => -(e as i32),
    };
    deliver_pending_signals_with_locks(proc, advisory_locks, &mut host);
    result
}

/// fcntl operations. Returns result (>= 0) or negative errno.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_fcntl(fd: i32, cmd: u32, arg: u32) -> i32 {
    let (_gkl, proc, advisory_locks) = unsafe { get_process_and_advisory_locks() };
    let result = match syscalls::sys_fcntl(proc, fd, cmd, arg) {
        Ok(val) => val,
        Err(e) => -(e as i32),
    };
    let mut host = WasmHostIO;
    deliver_pending_signals_with_locks(proc, advisory_locks, &mut host);
    result
}

/// fcntl lock operations. The flock struct is read from/written to the pointer.
/// Returns 0 on success, or negative errno on error.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_fcntl_lock(fd: i32, cmd: u32, flock_ptr: *mut u8) -> i32 {
    if flock_ptr.is_null() {
        return -(Errno::EFAULT as i32);
    }
    let (_gkl, proc, advisory_locks) = unsafe { get_process_and_advisory_locks() };
    let flock = unsafe { &mut *(flock_ptr as *mut wasm_posix_shared::WasmFlock) };
    let mut host = WasmHostIO;
    let result = match syscalls::sys_fcntl_lock(proc, advisory_locks, fd, cmd, flock, &mut host) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    };
    deliver_pending_signals_with_locks(proc, advisory_locks, &mut host);
    result
}

/// BSD flock() — whole-file advisory locking.
/// Returns 0 on success, or negative errno on error.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_flock(fd: i32, operation: u32) -> i32 {
    let (_gkl, proc, advisory_locks) = unsafe { get_process_and_advisory_locks() };
    let mut host = WasmHostIO;
    let result = match syscalls::sys_flock(proc, advisory_locks, fd, operation, &mut host) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    };
    deliver_pending_signals_with_locks(proc, advisory_locks, &mut host);
    result
}

/// Stat a file by path. Writes a complete native musl `struct kstat`.
/// Returns 0 on success, or negative errno on error.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_stat(path_ptr: *const u8, path_len: u32, stat_ptr: *mut u8) -> i32 {
    let (_gkl, proc, advisory_locks) = unsafe { get_process_and_advisory_locks() };
    let path = unsafe { slice::from_raw_parts(path_ptr, path_len as usize) };
    let mut host = WasmHostIO;
    let result = match syscalls::sys_stat(proc, &mut host, path) {
        Ok(stat) => match write_process_stat(stat_ptr, &stat) {
            Ok(()) => 0,
            Err(error) => -(error as i32),
        },
        Err(e) => -(e as i32),
    };
    deliver_pending_signals_with_locks(proc, advisory_locks, &mut host);
    result
}

/// Lstat a file by path (does not follow symlinks). Writes native `kstat`.
/// Returns 0 on success, or negative errno on error.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_lstat(path_ptr: *const u8, path_len: u32, stat_ptr: *mut u8) -> i32 {
    let (_gkl, proc, advisory_locks) = unsafe { get_process_and_advisory_locks() };
    let path = unsafe { slice::from_raw_parts(path_ptr, path_len as usize) };
    let mut host = WasmHostIO;
    let result = match syscalls::sys_lstat(proc, &mut host, path) {
        Ok(stat) => match write_process_stat(stat_ptr, &stat) {
            Ok(()) => 0,
            Err(error) => -(error as i32),
        },
        Err(e) => -(e as i32),
    };
    deliver_pending_signals_with_locks(proc, advisory_locks, &mut host);
    result
}

/// Create a directory. Returns 0 on success, or negative errno on error.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_mkdir(path_ptr: *const u8, path_len: u32, mode: u32) -> i32 {
    let (_gkl, proc, advisory_locks) = unsafe { get_process_and_advisory_locks() };
    let path = unsafe { slice::from_raw_parts(path_ptr, path_len as usize) };
    let mut host = WasmHostIO;
    let result = match syscalls::sys_mkdir(proc, &mut host, path, mode) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    };
    deliver_pending_signals_with_locks(proc, advisory_locks, &mut host);
    result
}

/// Remove a directory. Returns 0 on success, or negative errno on error.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_rmdir(path_ptr: *const u8, path_len: u32) -> i32 {
    let (_gkl, proc, advisory_locks) = unsafe { get_process_and_advisory_locks() };
    let path = unsafe { slice::from_raw_parts(path_ptr, path_len as usize) };
    let mut host = WasmHostIO;
    let result = match syscalls::sys_rmdir(proc, &mut host, path) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    };
    deliver_pending_signals_with_locks(proc, advisory_locks, &mut host);
    result
}

/// Unlink (delete) a file. Returns 0 on success, or negative errno on error.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_unlink(path_ptr: *const u8, path_len: u32) -> i32 {
    let (_gkl, proc, advisory_locks) = unsafe { get_process_and_advisory_locks() };
    let path = unsafe { slice::from_raw_parts(path_ptr, path_len as usize) };
    let mut host = WasmHostIO;
    let result = match syscalls::sys_unlink(proc, &mut host, path) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    };
    deliver_pending_signals_with_locks(proc, advisory_locks, &mut host);
    result
}

/// Rename a file. Returns 0 on success, or negative errno on error.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_rename(
    old_ptr: *const u8,
    old_len: u32,
    new_ptr: *const u8,
    new_len: u32,
) -> i32 {
    let (_gkl, proc, advisory_locks) = unsafe { get_process_and_advisory_locks() };
    let oldpath = unsafe { slice::from_raw_parts(old_ptr, old_len as usize) };
    let newpath = unsafe { slice::from_raw_parts(new_ptr, new_len as usize) };
    let mut host = WasmHostIO;
    let result = match syscalls::sys_rename(proc, &mut host, oldpath, newpath) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    };
    deliver_pending_signals_with_locks(proc, advisory_locks, &mut host);
    result
}

/// Create a hard link. Returns 0 on success, or negative errno on error.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_link(
    old_ptr: *const u8,
    old_len: u32,
    new_ptr: *const u8,
    new_len: u32,
) -> i32 {
    let (_gkl, proc, advisory_locks) = unsafe { get_process_and_advisory_locks() };
    let oldpath = unsafe { slice::from_raw_parts(old_ptr, old_len as usize) };
    let newpath = unsafe { slice::from_raw_parts(new_ptr, new_len as usize) };
    let mut host = WasmHostIO;
    let result = match syscalls::sys_link(proc, &mut host, oldpath, newpath) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    };
    deliver_pending_signals_with_locks(proc, advisory_locks, &mut host);
    result
}

/// Create a symbolic link. Returns 0 on success, or negative errno on error.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_symlink(
    target_ptr: *const u8,
    target_len: u32,
    link_ptr: *const u8,
    link_len: u32,
) -> i32 {
    let (_gkl, proc, advisory_locks) = unsafe { get_process_and_advisory_locks() };
    let target = unsafe { slice::from_raw_parts(target_ptr, target_len as usize) };
    let linkpath = unsafe { slice::from_raw_parts(link_ptr, link_len as usize) };
    let mut host = WasmHostIO;
    let result = match syscalls::sys_symlink(proc, &mut host, target, linkpath) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    };
    deliver_pending_signals_with_locks(proc, advisory_locks, &mut host);
    result
}

/// Read a symbolic link. Returns bytes read (>= 0) or negative errno.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_readlink(
    path_ptr: *const u8,
    path_len: u32,
    buf_ptr: *mut u8,
    buf_len: u32,
) -> i32 {
    let (_gkl, proc, advisory_locks) = unsafe { get_process_and_advisory_locks() };
    let path = unsafe { slice::from_raw_parts(path_ptr, path_len as usize) };
    let buf = unsafe { slice::from_raw_parts_mut(buf_ptr, buf_len as usize) };
    let mut host = WasmHostIO;
    let result = match syscalls::sys_readlink(proc, &mut host, path, buf) {
        Ok(n) => n as i32,
        Err(e) => -(e as i32),
    };
    deliver_pending_signals_with_locks(proc, advisory_locks, &mut host);
    result
}

/// Change file permissions. Returns 0 on success, or negative errno on error.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_chmod(path_ptr: *const u8, path_len: u32, mode: u32) -> i32 {
    let (_gkl, proc, advisory_locks) = unsafe { get_process_and_advisory_locks() };
    let path = unsafe { slice::from_raw_parts(path_ptr, path_len as usize) };
    let mut host = WasmHostIO;
    let result = match syscalls::sys_chmod(proc, &mut host, path, mode) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    };
    deliver_pending_signals_with_locks(proc, advisory_locks, &mut host);
    result
}

/// Change file ownership. Returns 0 on success, or negative errno on error.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_chown(path_ptr: *const u8, path_len: u32, uid: u32, gid: u32) -> i32 {
    let (_gkl, proc, advisory_locks) = unsafe { get_process_and_advisory_locks() };
    let path = unsafe { slice::from_raw_parts(path_ptr, path_len as usize) };
    let mut host = WasmHostIO;
    let result = match syscalls::sys_chown(proc, &mut host, path, uid, gid) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    };
    deliver_pending_signals_with_locks(proc, advisory_locks, &mut host);
    result
}

/// Change symlink ownership without following the final link.
fn kernel_lchown(path_ptr: *const u8, path_len: u32, uid: u32, gid: u32) -> i32 {
    let (_gkl, proc, advisory_locks) = unsafe { get_process_and_advisory_locks() };
    let path = unsafe { slice::from_raw_parts(path_ptr, path_len as usize) };
    let mut host = WasmHostIO;
    let result = match syscalls::sys_lchown(proc, &mut host, path, uid, gid) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    };
    deliver_pending_signals_with_locks(proc, advisory_locks, &mut host);
    result
}

/// Check file accessibility. Returns 0 on success, or negative errno on error.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_access(path_ptr: *const u8, path_len: u32, amode: u32) -> i32 {
    let (_gkl, proc, advisory_locks) = unsafe { get_process_and_advisory_locks() };
    let path = unsafe { slice::from_raw_parts(path_ptr, path_len as usize) };
    let mut host = WasmHostIO;
    let result = match syscalls::sys_access(proc, &mut host, path, amode) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    };
    deliver_pending_signals_with_locks(proc, advisory_locks, &mut host);
    result
}

/// Change working directory. Returns 0 on success, or negative errno on error.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_chdir(path_ptr: *const u8, path_len: u32) -> i32 {
    let (_gkl, proc, advisory_locks) = unsafe { get_process_and_advisory_locks() };
    let path = unsafe { slice::from_raw_parts(path_ptr, path_len as usize) };
    let mut host = WasmHostIO;
    let result = match syscalls::sys_chdir(proc, &mut host, path) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    };
    deliver_pending_signals_with_locks(proc, advisory_locks, &mut host);
    result
}

/// Change directory by file descriptor. Returns 0 or negative errno.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_fchdir(fd: i32) -> i32 {
    let (_gkl, proc, advisory_locks) = unsafe { get_process_and_advisory_locks() };
    let mut host = WasmHostIO;
    let result = match syscalls::sys_fchdir(proc, fd) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    };
    deliver_pending_signals_with_locks(proc, advisory_locks, &mut host);
    result
}

/// Get current working directory. Returns length written (>= 0) or negative errno.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_getcwd(buf_ptr: *mut u8, buf_len: u32) -> i32 {
    let (_gkl, proc, advisory_locks) = unsafe { get_process_and_advisory_locks() };
    let buf = unsafe { slice::from_raw_parts_mut(buf_ptr, buf_len as usize) };
    let mut host = WasmHostIO;
    let result = match syscalls::sys_getcwd(proc, &mut host, buf) {
        Ok(n) => n as i32,
        Err(e) => -(e as i32),
    };
    deliver_pending_signals_with_locks(proc, advisory_locks, &mut host);
    result
}

/// Open a directory for reading. Returns dir handle (>= 0) or negative errno.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_opendir(path_ptr: *const u8, path_len: u32) -> i32 {
    let (_gkl, proc, advisory_locks) = unsafe { get_process_and_advisory_locks() };
    let path = unsafe { slice::from_raw_parts(path_ptr, path_len as usize) };
    let mut host = WasmHostIO;
    let result = match syscalls::sys_opendir(proc, &mut host, path) {
        Ok(dh) => dh,
        Err(e) => -(e as i32),
    };
    deliver_pending_signals_with_locks(proc, advisory_locks, &mut host);
    result
}

/// Read next directory entry. Returns 1 if entry read, 0 if end, or negative errno.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_readdir(
    dir_handle: i32,
    dirent_ptr: *mut u8,
    name_ptr: *mut u8,
    name_len: u32,
) -> i32 {
    let (_gkl, proc, advisory_locks) = unsafe { get_process_and_advisory_locks() };
    let dirent_buf =
        unsafe { slice::from_raw_parts_mut(dirent_ptr, core::mem::size_of::<WasmDirent>()) };
    let name_buf = unsafe { slice::from_raw_parts_mut(name_ptr, name_len as usize) };
    let mut host = WasmHostIO;
    let result = match syscalls::sys_readdir(proc, &mut host, dir_handle, dirent_buf, name_buf) {
        Ok(n) => n,
        Err(e) => -(e as i32),
    };
    deliver_pending_signals_with_locks(proc, advisory_locks, &mut host);
    result
}

/// Close a directory stream. Returns 0 on success, or negative errno on error.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_closedir(dir_handle: i32) -> i32 {
    let (_gkl, proc, advisory_locks) = unsafe { get_process_and_advisory_locks() };
    let mut host = WasmHostIO;
    let result = match syscalls::sys_closedir(proc, &mut host, dir_handle) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    };
    deliver_pending_signals_with_locks(proc, advisory_locks, &mut host);
    result
}

/// Read directory entries in linux_dirent64 format. Returns bytes written or negative errno.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_getdents64(fd: i32, buf_ptr: *mut u8, buf_len: u32) -> i32 {
    let (_gkl, proc, advisory_locks) = unsafe { get_process_and_advisory_locks() };
    let buf = unsafe { slice::from_raw_parts_mut(buf_ptr, buf_len as usize) };
    let mut host = WasmHostIO;
    let result = match syscalls::sys_getdents64(proc, &mut host, fd, buf) {
        Ok(n) => n as i32,
        Err(e) => -(e as i32),
    };
    deliver_pending_signals_with_locks(proc, advisory_locks, &mut host);
    result
}

/// Rewind a directory stream to the beginning. Returns 0 on success, or negative errno.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_rewinddir(dir_handle: i32) -> i32 {
    let (_gkl, proc, advisory_locks) = unsafe { get_process_and_advisory_locks() };
    let mut host = WasmHostIO;
    let result = match syscalls::sys_rewinddir(proc, &mut host, dir_handle) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    };
    deliver_pending_signals_with_locks(proc, advisory_locks, &mut host);
    result
}

/// Return current position in a directory stream. Returns position (>= 0) or negative errno.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_telldir(dir_handle: i32) -> i64 {
    let (_gkl, proc, advisory_locks) = unsafe { get_process_and_advisory_locks() };
    let mut host = WasmHostIO;
    let result = match syscalls::sys_telldir(proc, dir_handle) {
        Ok(pos) => pos as i64,
        Err(e) => -(e as i64),
    };
    deliver_pending_signals_with_locks(proc, advisory_locks, &mut host);
    result
}

/// Seek to a position in a directory stream. Returns 0 on success, or negative errno.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_seekdir(dir_handle: i32, loc_lo: u32, loc_hi: u32) -> i32 {
    let (_gkl, proc, advisory_locks) = unsafe { get_process_and_advisory_locks() };
    let mut host = WasmHostIO;
    let loc = (loc_hi as u64) << 32 | (loc_lo as u64);
    let result = match syscalls::sys_seekdir(proc, &mut host, dir_handle, loc) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    };
    deliver_pending_signals_with_locks(proc, advisory_locks, &mut host);
    result
}

/// Get the process ID.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_getpid() -> i32 {
    let (_gkl, proc, advisory_locks) = unsafe { get_process_and_advisory_locks() };
    let result = syscalls::sys_getpid(proc);
    let mut host = WasmHostIO;
    deliver_pending_signals_with_locks(proc, advisory_locks, &mut host);
    result
}

/// Get the parent process ID.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_getppid() -> i32 {
    let (_gkl, proc, advisory_locks) = unsafe { get_process_and_advisory_locks() };
    let result = syscalls::sys_getppid(proc);
    let mut host = WasmHostIO;
    deliver_pending_signals_with_locks(proc, advisory_locks, &mut host);
    result
}

/// Get the real user ID.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_getuid() -> u32 {
    let (_gkl, proc, advisory_locks) = unsafe { get_process_and_advisory_locks() };
    let result = syscalls::sys_getuid(proc);
    let mut host = WasmHostIO;
    deliver_pending_signals_with_locks(proc, advisory_locks, &mut host);
    result
}

/// Get the effective user ID.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_geteuid() -> u32 {
    let (_gkl, proc, advisory_locks) = unsafe { get_process_and_advisory_locks() };
    let result = syscalls::sys_geteuid(proc);
    let mut host = WasmHostIO;
    deliver_pending_signals_with_locks(proc, advisory_locks, &mut host);
    result
}

/// Get the real group ID.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_getgid() -> u32 {
    let (_gkl, proc, advisory_locks) = unsafe { get_process_and_advisory_locks() };
    let result = syscalls::sys_getgid(proc);
    let mut host = WasmHostIO;
    deliver_pending_signals_with_locks(proc, advisory_locks, &mut host);
    result
}

/// Get the effective group ID.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_getegid() -> u32 {
    let (_gkl, proc, advisory_locks) = unsafe { get_process_and_advisory_locks() };
    let result = syscalls::sys_getegid(proc);
    let mut host = WasmHostIO;
    deliver_pending_signals_with_locks(proc, advisory_locks, &mut host);
    result
}

/// Get the process group ID.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_getpgrp() -> u32 {
    let (_gkl, proc, advisory_locks) = unsafe { get_process_and_advisory_locks() };
    let result = syscalls::sys_getpgrp(proc);
    let mut host = WasmHostIO;
    deliver_pending_signals_with_locks(proc, advisory_locks, &mut host);
    result
}

/// Get the process group ID of a process. Queries the ProcessTable directly
/// (no current-process context needed). Returns pgid on success, or negative errno.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_getpgid_direct(pid: u32) -> i32 {
    let table = unsafe { &*PROCESS_TABLE.0.get() };
    match table.get(pid) {
        Some(proc) => proc.pgid as i32,
        None => -(Errno::ESRCH as i32),
    }
}

/// Set the process group ID. Returns 0 on success, or negative errno.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_setpgid(pid: u32, pgid: u32) -> i32 {
    let (_gkl, proc, advisory_locks) = unsafe { get_process_and_advisory_locks() };
    let result = match syscalls::sys_setpgid(proc, pid, pgid) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    };
    let mut host = WasmHostIO;
    deliver_pending_signals_with_locks(proc, advisory_locks, &mut host);
    result
}

/// Get the session ID. Returns session ID on success, or negative errno.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_getsid(pid: u32) -> i32 {
    let (_gkl, proc, advisory_locks) = unsafe { get_process_and_advisory_locks() };
    let result = match syscalls::sys_getsid(proc, pid) {
        Ok(sid) => sid as i32,
        Err(e) => -(e as i32),
    };
    let mut host = WasmHostIO;
    deliver_pending_signals_with_locks(proc, advisory_locks, &mut host);
    result
}

/// Create a new session. Returns session ID on success, or negative errno.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_setsid() -> i32 {
    let (_gkl, proc, advisory_locks) = unsafe { get_process_and_advisory_locks() };
    let result = match syscalls::sys_setsid(proc) {
        Ok(sid) => sid as i32,
        Err(e) => -(e as i32),
    };
    let mut host = WasmHostIO;
    deliver_pending_signals_with_locks(proc, advisory_locks, &mut host);
    result
}

/// Send a signal to a process. Returns 0 on success, or negative errno.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_kill(pid: i32, sig: u32) -> i32 {
    kernel_kill_with_metadata(pid, sig, 0, 0)
}

/// Send a process-directed signal with its siginfo metadata.
fn kernel_kill_with_metadata(pid: i32, sig: u32, si_value_bits: u64, si_code: i32) -> i32 {
    use wasm_posix_shared::signal::NSIG;
    let _gkl = GklGuard::acquire();
    let table = unsafe { &mut *PROCESS_TABLE.0.get() };
    let mut host = WasmHostIO;
    let caller_pid = table.current_pid();
    let caller_tid = table.current_tid();
    let (caller_pgid, sender_uid, sender_euid) = match table.get(caller_pid) {
        Some(caller) if caller.is_live_explicit_tid(caller_tid) => {
            (
                caller.pgid,
                caller.real_uid(),
                caller.effective_uid(),
            )
        }
        None => return -(Errno::ESRCH as i32),
        Some(_) => return -(Errno::ESRCH as i32),
    };

    let deliver_caller = |table: &mut crate::process_table::ProcessTable, host: &mut WasmHostIO| {
        if let Some((caller, locks)) = table.process_and_advisory_locks(caller_pid) {
            let _ = deliver_pending_signals_for_tid_with_locks(caller, locks, host, caller_tid);
        }
    };

    // Handle cross-process kill directly via ProcessTable.
    let is_self = pid == caller_pid as i32;
    if !is_self && pid > 0 {
        if sig >= NSIG && sig != 0 {
            deliver_caller(table, &mut host);
            return -(Errno::EINVAL as i32);
        }
        table.ensure_init();
        let target_pid = pid as u32;
        let result = match table.get(target_pid) {
            Some(target)
                if !syscalls::can_signal(
                    sender_uid,
                    sender_euid,
                    target.real_uid(),
                    target.saved_uid(),
                ) =>
            {
                -(Errno::EPERM as i32)
            }
            Some(_) if target_pid == crate::process_table::SYNTHETIC_INIT_PID => 0,
            Some(target) if !target.is_live_explicit_tid(target.pid) => -(Errno::ESRCH as i32),
            Some(_) => {
                if sig > 0 {
                    if let Some((target, locks)) = table.process_and_advisory_locks(target_pid) {
                        target.raise_signal_with_metadata(
                            sig,
                            si_value_bits,
                            si_code,
                            caller_pid,
                            sender_uid,
                        );
                        if let Some(target_tid) = target.pick_thread_for_shared_signal(sig) {
                            let _ = deliver_pending_signals_for_tid_with_locks(
                                target, locks, &mut host, target_tid,
                            );
                        }
                    }
                }
                0
            }
            None => -(Errno::ESRCH as i32),
        };
        deliver_caller(table, &mut host);
        return result;
    }
    // kill(-1, sig) targets every permitted live process except the caller and
    // synthetic init, matching Linux's observable choice within POSIX's
    // implementation-defined system-process exclusions.
    if pid == -1 {
        if sig >= NSIG && sig != 0 {
            deliver_caller(table, &mut host);
            return -(Errno::EINVAL as i32);
        }
        let pids: Vec<u32> = table
            .live_processes_descending()
            .map(|(target_pid, _)| target_pid)
            .filter(|&target_pid| target_pid != caller_pid)
            .collect();
        let mut delivered = false;
        let mut any_perm_denied = false;
        for target_pid in pids {
            let Some(target) = table.get(target_pid) else {
                continue;
            };
            if !syscalls::can_signal(
                sender_uid,
                sender_euid,
                target.real_uid(),
                target.saved_uid(),
            ) {
                any_perm_denied = true;
                continue;
            }
            delivered = true;
            if sig > 0 {
                if let Some((target, locks)) = table.process_and_advisory_locks(target_pid) {
                    target.raise_signal_with_metadata(
                        sig,
                        si_value_bits,
                        si_code,
                        caller_pid,
                        sender_uid,
                    );
                    if let Some(target_tid) = target.pick_thread_for_shared_signal(sig) {
                        let _ = deliver_pending_signals_for_tid_with_locks(
                            target, locks, &mut host, target_tid,
                        );
                    }
                }
            }
        }
        deliver_caller(table, &mut host);
        if delivered {
            return 0;
        }
        if any_perm_denied {
            return -(Errno::EPERM as i32);
        }
        return -(Errno::ESRCH as i32);
    }

    // kill(0, sig) targets the caller's group; kill(-pgid, sig) targets the
    // named group. Every target task is selected from kernel state.
    if pid == 0 || pid < -1 {
        if sig >= NSIG && sig != 0 {
            deliver_caller(table, &mut host);
            return -(Errno::EINVAL as i32);
        }
        let target_pgid = if pid == 0 { caller_pgid } else { (-pid) as u32 };
        let pids = table.pids_in_group(target_pgid);
        if pids.is_empty() {
            deliver_caller(table, &mut host);
            return -(Errno::ESRCH as i32);
        }
        // POSIX: kill(-pgid) returns success if at least one target received
        // the signal, EPERM only if *none* could be signalled due to permission.
        let mut delivered = false;
        let mut any_perm_denied = false;
        for &target_pid in &pids {
            if let Some(target) = table.get(target_pid) {
                if !syscalls::can_signal(
                    sender_uid,
                    sender_euid,
                    target.real_uid(),
                    target.saved_uid(),
                ) {
                    any_perm_denied = true;
                    continue;
                }
                if target_pid == crate::process_table::SYNTHETIC_INIT_PID {
                    delivered = true;
                    continue;
                }
                if !target.is_live_explicit_tid(target.pid) {
                    continue;
                }
                delivered = true;
                if sig > 0 {
                    if let Some((target, locks)) = table.process_and_advisory_locks(target_pid) {
                        target.raise_signal_with_metadata(
                            sig,
                            si_value_bits,
                            si_code,
                            caller_pid,
                            sender_uid,
                        );
                        if let Some(target_tid) = target.pick_thread_for_shared_signal(sig) {
                            let _ = deliver_pending_signals_for_tid_with_locks(
                                target, locks, &mut host, target_tid,
                            );
                        }
                    }
                }
            }
        }
        deliver_caller(table, &mut host);
        if delivered {
            return 0;
        } else if any_perm_denied {
            return -(Errno::EPERM as i32);
        } else {
            return -(Errno::ESRCH as i32);
        }
    }

    // The only remaining target is the exact calling process. Remote target
    // selection never delegates to a host callback.
    if sig >= NSIG && sig != 0 {
        deliver_caller(table, &mut host);
        return -(Errno::EINVAL as i32);
    }
    let Some((caller, locks)) = table.process_and_advisory_locks(caller_pid) else {
        return -(Errno::ESRCH as i32);
    };
    if sig > 0 {
        caller.raise_signal_with_metadata(sig, si_value_bits, si_code, caller_pid, sender_uid);
    }
    let _ = deliver_pending_signals_for_tid_with_locks(caller, locks, &mut host, caller_tid);
    0
}

/// sigaltstack — get/set alternate signal stack state.
///
/// `ss_ptr` and `oss_ptr` name caller-native `stack_t` records in bounded
/// kernel scratch. `process_pointer_width` selects the wasm32 or wasm64 layout.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_sigaltstack(
    ss_ptr: *const u8,
    oss_ptr: *mut u8,
    process_pointer_width: i64,
) -> i32 {
    use crate::process_wire::{
        validate_sigaltstack_range, NativeSigaltstack, ProcessDataModel, SIGALTSTACK_SS_DISABLE,
    };

    let model = match ProcessDataModel::from_width(process_pointer_width) {
        Ok(model) => model,
        Err(error) => return -(error as i32),
    };
    let (_gkl, proc, advisory_locks) = unsafe { get_process_and_advisory_locks() };

    let new_stack = if ss_ptr.is_null() {
        None
    } else {
        // POSIX: cannot modify alt stack while executing on it (SS_ONSTACK)
        const SS_ONSTACK: u32 = 1;
        if proc.alt_stack_flags & SS_ONSTACK != 0 {
            return -(Errno::EPERM as i32);
        }
        // WHY: the host proved this exact record fits the kernel-owned scratch
        // allocation; using the native size here keeps that capacity proof
        // aligned with the parser instead of relying on total Wasm memory.
        let bytes = unsafe { slice::from_raw_parts(ss_ptr, model.sigaltstack_size()) };
        match crate::process_wire::read_sigaltstack(bytes, model) {
            Ok(stack) => {
                if let Err(error) = validate_sigaltstack_range(stack, model) {
                    return -(error as i32);
                }
                Some(stack)
            }
            Err(error) => return -(error as i32),
        }
    };

    if !oss_ptr.is_null() {
        let old_stack = NativeSigaltstack {
            sp: proc.alt_stack_sp,
            flags: proc.alt_stack_flags,
            size: proc.alt_stack_size,
        };
        let mut encoded = alloc::vec![0; model.sigaltstack_size()];
        if let Err(error) = crate::process_wire::write_sigaltstack(&mut encoded, old_stack, model) {
            return -(error as i32);
        }
        // WHY: serialize before touching the caller-visible destination so a
        // narrowing failure cannot leave a partially replaced record.
        let output = unsafe { slice::from_raw_parts_mut(oss_ptr, model.sigaltstack_size()) };
        output.copy_from_slice(&encoded);
    }

    if let Some(stack) = new_stack {
        if stack.flags & SIGALTSTACK_SS_DISABLE != 0 {
            proc.alt_stack_sp = 0;
            proc.alt_stack_flags = SIGALTSTACK_SS_DISABLE;
            proc.alt_stack_size = 0;
        } else {
            proc.alt_stack_sp = stack.sp;
            proc.alt_stack_flags = stack.flags;
            proc.alt_stack_size = stack.size;
        }
    }

    let mut host = WasmHostIO;
    deliver_pending_signals_with_locks(proc, advisory_locks, &mut host);
    0
}

/// Validate a PID and caller's permission to query/modify its scheduling
/// parameters.
///
/// Returns 0 if PID is valid and the caller has permission (pid==0 means
/// current process, always allowed). Returns -ESRCH if the target doesn't
/// exist, -EPERM if the caller's uid doesn't match per `can_signal()`.
fn kernel_sched_validate_pid(pid: i32) -> i32 {
    if pid == 0 {
        return 0; // pid 0 means current process
    }
    let (_gkl, caller) = unsafe { get_process() };
    let sender_euid = caller.effective_uid();
    let table = unsafe { &mut *PROCESS_TABLE.0.get() };
    table.ensure_init();
    match table.get(pid as u32) {
        None => -(Errno::ESRCH as i32),
        Some(target) => {
            if syscalls::can_query_sched(
                sender_euid,
                target.real_uid(),
                target.effective_uid(),
            ) {
                0
            } else {
                -(Errno::EPERM as i32)
            }
        }
    }
}

/// Resolve the Linux task selected by sched_getaffinity.
///
/// Process leaders use their PID as their TID. Worker threads live in their
/// owning Process record, while pid 0 selects the exact calling thread. Limbo
/// records are already reaped and no longer name a task.
fn sched_affinity_target_process(
    table: &crate::process_table::ProcessTable,
    pid: i32,
) -> Result<&Process, Errno> {
    if pid == 0 {
        let caller = table.get(table.current_pid()).ok_or(Errno::ESRCH)?;
        let current_tid = table.current_tid();
        if !matches!(caller.state, ProcessState::Running | ProcessState::Stopped) {
            return Err(Errno::ESRCH);
        }
        if caller.is_main_thread(current_tid) || caller.get_thread(current_tid).is_some() {
            return Ok(caller);
        }
        return Err(Errno::ESRCH);
    }

    if pid < 0 {
        return Err(Errno::ESRCH);
    }

    table
        .get_process_containing_task(pid as u32)
        .ok_or(Errno::ESRCH)
}

/// Linux sched_getaffinity compatibility for Kandelo's one-CPU kernel.
///
/// Linux validates the unsigned byte length against one kernel-word mask,
/// requires kernel-word alignment, and returns the number of bytes copied by
/// the raw syscall. Musl converts that positive raw result to public success 0
/// and zero-fills the caller's remaining cpu_set_t bytes.
fn kernel_sched_getaffinity(pid: i32, cpusetsize: u32, mask_ptr: *mut u8) -> i32 {
    const MASK_SIZE: u32 = wasm_posix_shared::SCHED_AFFINITY_MASK_SIZE;

    if cpusetsize < MASK_SIZE || cpusetsize % MASK_SIZE != 0 {
        return -(Errno::EINVAL as i32);
    }

    let table = unsafe { &*PROCESS_TABLE.0.get() };
    if let Err(error) = sched_affinity_target_process(table, pid) {
        return -(error as i32);
    }
    if mask_ptr.is_null() {
        return -(Errno::EFAULT as i32);
    }

    let mask = unsafe { slice::from_raw_parts_mut(mask_ptr, MASK_SIZE as usize) };
    mask.fill(0);
    mask[0] = 1;
    MASK_SIZE as i32
}

/// `sched_getparam` writes the complete native scheduling-parameter record.
///
/// Kandelo currently exposes SCHED_OTHER only, so every field is zero. Filling
/// all 48 bytes is required: the host copies the descriptor's complete output
/// capacity back to the caller, and a four-byte write would expose stale
/// scratch bytes in the POSIX sporadic-server fields.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_sched_getparam(pid: i32, param_ptr: *mut u8) -> i32 {
    if param_ptr.is_null() {
        return -(Errno::EFAULT as i32);
    }
    let validate = kernel_sched_validate_pid(pid);
    if validate < 0 {
        return validate;
    }
    let bytes = unsafe {
        slice::from_raw_parts_mut(
            param_ptr,
            wasm_posix_shared::process_layout::sched_param::SIZE as usize,
        )
    };
    match crate::process_wire::write_sched_param(
        bytes,
        crate::process_wire::NativeSchedParam::default(),
    ) {
        Ok(()) => 0,
        Err(error) => -(error as i32),
    }
}

fn kernel_sched_setparam(pid: i32, param_ptr: *const u8) -> i32 {
    kernel_sched_accept_param(pid, param_ptr)
}

fn kernel_sched_setscheduler(pid: i32, _policy: i32, param_ptr: *const u8) -> i32 {
    kernel_sched_accept_param(pid, param_ptr)
}

fn kernel_sched_accept_param(pid: i32, param_ptr: *const u8) -> i32 {
    if param_ptr.is_null() {
        return -(Errno::EFAULT as i32);
    }
    let validate = kernel_sched_validate_pid(pid);
    if validate < 0 {
        return validate;
    }
    let bytes = unsafe {
        slice::from_raw_parts(
            param_ptr,
            wasm_posix_shared::process_layout::sched_param::SIZE as usize,
        )
    };
    match crate::process_wire::read_sched_param(bytes) {
        // Scheduling remains a truthful no-op in the one-CPU Wasm model, but
        // the complete caller-owned record is still validated and staged.
        Ok(_param) => 0,
        Err(error) => -(error as i32),
    }
}

/// Send a signal to the current process. Returns 0 on success, or negative errno.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_raise(sig: u32) -> i32 {
    let (_gkl, proc, advisory_locks) = unsafe { get_process_and_advisory_locks() };
    let mut host = WasmHostIO;
    let result = match syscalls::sys_raise(proc, sig) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    };
    deliver_pending_signals_with_locks(proc, advisory_locks, &mut host);
    result
}

/// `tkill(tid, sig)` — deliver `sig` to a specific thread of the current
/// process. POSIX requires that directed signals go to that thread's pending
/// queue, not the process-wide shared queue.
///
/// - `tid == pid` targets the main thread's directed queue.
/// - Other `tid` values look up the thread in `Process::threads` and raise
///   on its own per-thread pending queue.
/// - `tid == 0`, unknown, or stale `tid` → `-ESRCH`.
///
/// Cross-process `tkill` is not supported (returns `-ESRCH`); use `kill` or
/// `tgkill` with the current process's `tgid` for current-process delivery.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_tkill(tid: u32, sig: u32) -> i32 {
    kernel_tkill_with_value(tid, sig, 0, 0)
}

/// `tgkill(tgid, tid, sig)` — like `tkill` but verifies that `tid` belongs
/// to the thread group identified by `tgid`. In the current threading model,
/// this reduces to the same check plus an outer PID match.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_tgkill(tgid: u32, tid: u32, sig: u32) -> i32 {
    let (_gkl, proc, advisory_locks) = unsafe { get_process_and_advisory_locks() };
    if tgid != proc.pid {
        // We don't support cross-process per-thread signalling.
        let mut host = WasmHostIO;
        deliver_pending_signals_with_locks(proc, advisory_locks, &mut host);
        return -(Errno::ESRCH as i32);
    }
    kernel_tkill_with_value(tid, sig, 0, 0)
}

/// Shared implementation of tkill/tgkill/rt_tgsigqueueinfo.
/// When `si_value != 0` or `si_code != 0` the signal is queued with
/// `sigqueue`-style metadata.
fn kernel_tkill_with_value(tid: u32, sig: u32, si_value_bits: u64, si_code: i32) -> i32 {
    use wasm_posix_shared::signal::NSIG;
    let (_gkl, proc, advisory_locks) = unsafe { get_process_and_advisory_locks() };
    let mut host = WasmHostIO;

    if sig >= NSIG {
        deliver_pending_signals_with_locks(proc, advisory_locks, &mut host);
        return -(Errno::EINVAL as i32);
    }

    // Exact-thread signal APIs accept only task IDs that the ProcessTable
    // allocated and that are still live in this process. In particular, the
    // internal tid=0 sentinel used for process-wide dispatch is not a task.
    if !proc.is_live_explicit_tid(tid) {
        deliver_pending_signals_with_locks(proc, advisory_locks, &mut host);
        return -(Errno::ESRCH as i32);
    }

    let sender_pid = proc.pid;
    let sender_uid = proc.real_uid();

    // Main thread: use its directed queue rather than the process-shared set.
    if proc.is_main_thread(tid) {
        if sig > 0 {
            proc.raise_for_thread_with_metadata(
                tid,
                sig,
                si_value_bits,
                si_code,
                sender_pid,
                sender_uid,
            );
        }
        deliver_pending_signals_with_locks(proc, advisory_locks, &mut host);
        return 0;
    }

    // Worker thread: direct deliver to that thread's own pending queue.
    if sig > 0 {
        proc.raise_for_thread_with_metadata(
            tid,
            sig,
            si_value_bits,
            si_code,
            sender_pid,
            sender_uid,
        );
    }
    deliver_pending_signals_with_locks(proc, advisory_locks, &mut host);
    0
}

/// Set signal action. act_ptr/oldact_ptr point to structs:
///   [0..4] handler (u32), [4..8] flags (u32), [8..16] mask (u64)
/// If act_ptr is null (0), only reads the old action.
/// Returns 0 on success, negative errno on error.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_sigaction(sig: u32, act_ptr: *const u8, oldact_ptr: *mut u8) -> i32 {
    let (_gkl, proc, advisory_locks) = unsafe { get_process_and_advisory_locks() };

    // Parse new action from act_ptr (if non-null)
    let (handler_val, flags, mask) = if !act_ptr.is_null() {
        let act = unsafe { core::slice::from_raw_parts(act_ptr, 16) };
        let handler = u32::from_le_bytes([act[0], act[1], act[2], act[3]]);
        let flags = u32::from_le_bytes([act[4], act[5], act[6], act[7]]);
        let mask = u64::from_le_bytes([
            act[8], act[9], act[10], act[11], act[12], act[13], act[14], act[15],
        ]);
        (handler, flags, mask)
    } else {
        // No new action — just read old
        let old_action = proc.signals.get_action(sig);
        if !oldact_ptr.is_null() {
            let old = unsafe { core::slice::from_raw_parts_mut(oldact_ptr, 16) };
            let h = match old_action.handler {
                crate::signal::SignalHandler::Default => 0u32,
                crate::signal::SignalHandler::Ignore => 1u32,
                crate::signal::SignalHandler::Handler(ptr) => ptr,
            };
            old[0..4].copy_from_slice(&h.to_le_bytes());
            old[4..8].copy_from_slice(&old_action.flags.to_le_bytes());
            old[8..16].copy_from_slice(&old_action.mask.to_le_bytes());
        }
        let mut host = WasmHostIO;
        deliver_pending_signals_with_locks(proc, advisory_locks, &mut host);
        return 0;
    };

    let result = match syscalls::sys_sigaction(proc, sig, handler_val, flags, mask) {
        Ok((old_handler, old_flags, old_mask)) => {
            if !oldact_ptr.is_null() {
                let old = unsafe { core::slice::from_raw_parts_mut(oldact_ptr, 16) };
                old[0..4].copy_from_slice(&old_handler.to_le_bytes());
                old[4..8].copy_from_slice(&old_flags.to_le_bytes());
                old[8..16].copy_from_slice(&old_mask.to_le_bytes());
            }
            0
        }
        Err(e) => -(e as i32),
    };
    let mut host = WasmHostIO;
    deliver_pending_signals_with_locks(proc, advisory_locks, &mut host);
    result
}

/// signal() — set signal handler (legacy API). Returns old handler or negative errno.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_signal(signum: u32, handler: u32) -> i32 {
    let (_gkl, proc, advisory_locks) = unsafe { get_process_and_advisory_locks() };
    let result = match syscalls::sys_signal(proc, signum, handler) {
        Ok(old) => old,
        Err(e) => -(e as i32),
    };
    let mut host = WasmHostIO;
    deliver_pending_signals_with_locks(proc, advisory_locks, &mut host);
    result
}

/// Manipulate the signal mask. The 64-bit set is passed as two 32-bit halves.
/// Returns old mask as i64 (>= 0) or negative errno.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_sigprocmask(how: u32, set_lo: u32, set_hi: u32) -> i64 {
    let (_gkl, proc, advisory_locks) = unsafe { get_process_and_advisory_locks() };
    let set = ((set_hi as u64) << 32) | (set_lo as u64);
    let result = match syscalls::sys_sigprocmask(proc, how, set) {
        Ok(old) => {
            proc.acknowledge_caught_handler_mask_restore_for(
                syscalls::current_tid_for_process(proc),
            );
            old as i64
        }
        Err(e) => -(e as i64),
    };
    let mut host = WasmHostIO;
    deliver_pending_signals_with_locks(proc, advisory_locks, &mut host);
    result
}

/// Get the current time from a clock source.
/// Writes a WasmTimespec struct to ts_ptr.
/// Returns 0 on success, or negative errno on error.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_clock_gettime(clock_id: u32, ts_ptr: *mut u8) -> i32 {
    let (_gkl, proc, advisory_locks) = unsafe { get_process_and_advisory_locks() };
    let mut host = WasmHostIO;
    let result = match syscalls::sys_clock_gettime(proc, &mut host, clock_id) {
        Ok(ts) => {
            let ts_bytes = unsafe {
                slice::from_raw_parts(
                    &ts as *const WasmTimespec as *const u8,
                    core::mem::size_of::<WasmTimespec>(),
                )
            };
            unsafe {
                core::ptr::copy_nonoverlapping(ts_bytes.as_ptr(), ts_ptr, ts_bytes.len());
            }
            0
        }
        Err(e) => -(e as i32),
    };
    deliver_pending_signals_with_locks(proc, advisory_locks, &mut host);
    result
}

/// Sleep for a specified duration.
/// Reads a WasmTimespec struct from req_ptr.
/// Returns 0 on success, or negative errno on error.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_nanosleep(req_ptr: *const u8) -> i32 {
    let (_gkl, proc, advisory_locks) = unsafe { get_process_and_advisory_locks() };
    let mut host = WasmHostIO;
    let req = unsafe { &*(req_ptr as *const WasmTimespec) };
    let result = match syscalls::sys_nanosleep(proc, &mut host, req) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    };
    deliver_pending_signals_with_locks(proc, advisory_locks, &mut host);
    result
}

/// Get clock resolution. Returns 0 or negative errno. Writes WasmTimespec to ts_ptr.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_clock_getres(clock_id: u32, ts_ptr: *mut u8) -> i32 {
    let (_gkl, proc, advisory_locks) = unsafe { get_process_and_advisory_locks() };
    let mut host = WasmHostIO;
    let result = match syscalls::sys_clock_getres(proc, clock_id) {
        Ok(ts) => {
            if !ts_ptr.is_null() {
                let ts_bytes = unsafe {
                    slice::from_raw_parts(
                        &ts as *const WasmTimespec as *const u8,
                        core::mem::size_of::<WasmTimespec>(),
                    )
                };
                unsafe {
                    core::ptr::copy_nonoverlapping(ts_bytes.as_ptr(), ts_ptr, ts_bytes.len());
                }
            }
            0
        }
        Err(e) => -(e as i32),
    };
    deliver_pending_signals_with_locks(proc, advisory_locks, &mut host);
    result
}

/// Sleep with clock selection. Returns 0 or negative errno.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_clock_nanosleep(clock_id: u32, flags: u32, req_ptr: *const u8) -> i32 {
    let (_gkl, proc, advisory_locks) = unsafe { get_process_and_advisory_locks() };
    let mut host = WasmHostIO;
    let req = unsafe { &*(req_ptr as *const WasmTimespec) };
    let result = match syscalls::sys_clock_nanosleep(proc, &mut host, clock_id, flags, req, req_ptr)
    {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    };
    deliver_pending_signals_with_locks(proc, advisory_locks, &mut host);
    result
}

/// Set file timestamps. Returns 0 or negative errno.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_utimensat(
    dirfd: i32,
    path_ptr: *const u8,
    path_len: u32,
    times_ptr: *const u8,
    flags: u32,
) -> i32 {
    let (_gkl, proc, advisory_locks) = unsafe { get_process_and_advisory_locks() };
    // WHY: a null path with length zero is the futimens form of utimensat.
    // Rust still requires raw slice pointers to be non-null when empty.
    let path = if path_len == 0 {
        &[]
    } else if path_ptr.is_null() {
        return -(Errno::EFAULT as i32);
    } else {
        // SAFETY: the host staged the complete NUL-terminated caller path in
        // capacity-checked kernel scratch and supplied its measured length.
        unsafe { slice::from_raw_parts(path_ptr, path_len as usize) }
    };
    let times = if times_ptr.is_null() {
        None
    } else {
        Some(unsafe { &*(times_ptr as *const [WasmTimespec; 2]) })
    };
    let mut host = WasmHostIO;
    let result = match syscalls::sys_utimensat(proc, &mut host, dirfd, path, times, flags) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    };
    deliver_pending_signals_with_locks(proc, advisory_locks, &mut host);
    result
}

/// Remap memory. Supports in-place resize and MREMAP_MAYMOVE; unsupported
/// Linux-specific flag combinations are rejected by sys_mremap with EINVAL.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_mremap(
    old_addr: usize,
    old_len: usize,
    new_len: usize,
    flags: u32,
) -> usize {
    let (_gkl, proc, advisory_locks) = unsafe { get_process_and_advisory_locks() };
    let mut host = WasmHostIO;
    let result = match syscalls::sys_mremap(proc, old_addr, old_len, new_len, flags) {
        Ok(addr) => addr,
        Err(e) => (-(e as i32)) as usize,
    };
    deliver_pending_signals_with_locks(proc, advisory_locks, &mut host);
    result
}

/// Memory advice hint. No-op, returns 0.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_madvise(addr: usize, len: usize, advice: u32) -> i32 {
    let (_gkl, proc, advisory_locks) = unsafe { get_process_and_advisory_locks() };
    let mut host = WasmHostIO;
    let result = match syscalls::sys_madvise(proc, addr, len, advice) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    };
    deliver_pending_signals_with_locks(proc, advisory_locks, &mut host);
    result
}

/// statfs — get filesystem statistics in the caller's native `struct statfs`.
/// Returns 0 on success.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_statfs(
    path_ptr: *const u8,
    path_len: u32,
    buf_ptr: *mut u8,
    process_pointer_width: i64,
) -> i32 {
    use crate::process_wire::ProcessDataModel;

    let model = match ProcessDataModel::from_width(process_pointer_width) {
        Ok(model) => model,
        Err(error) => return -(error as i32),
    };
    if path_ptr.is_null() || buf_ptr.is_null() {
        return -(Errno::EFAULT as i32);
    }
    let (_gkl, proc, advisory_locks) = unsafe { get_process_and_advisory_locks() };
    let mut host = WasmHostIO;
    let path = unsafe { slice::from_raw_parts(path_ptr, path_len as usize) };
    let result = match syscalls::sys_statfs(proc, &mut host, path) {
        Ok(statfs) => {
            // WHY: this exact native size is also the allocation capacity the
            // host checked. The kernel's total memory size says nothing about
            // whether bytes past this scratch record belong to this syscall.
            let output = unsafe { slice::from_raw_parts_mut(buf_ptr, model.statfs_size()) };
            match crate::process_wire::write_statfs(output, &statfs, model) {
                Ok(()) => 0,
                Err(error) => -(error as i32),
            }
        }
        Err(e) => -(e as i32),
    };
    deliver_pending_signals_with_locks(proc, advisory_locks, &mut host);
    result
}

/// fstatfs — get filesystem statistics for an open fd.
/// Returns 0 on success, negative errno on error.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_fstatfs(fd: i32, buf_ptr: *mut u8, process_pointer_width: i64) -> i32 {
    use crate::process_wire::ProcessDataModel;

    let model = match ProcessDataModel::from_width(process_pointer_width) {
        Ok(model) => model,
        Err(error) => return -(error as i32),
    };
    if buf_ptr.is_null() {
        return -(Errno::EFAULT as i32);
    }
    let (_gkl, proc, advisory_locks) = unsafe { get_process_and_advisory_locks() };
    let mut host = WasmHostIO;
    let result = match syscalls::sys_fstatfs(proc, &mut host, fd) {
        Ok(statfs) => {
            let output = unsafe { slice::from_raw_parts_mut(buf_ptr, model.statfs_size()) };
            match crate::process_wire::write_statfs(output, &statfs, model) {
                Ok(()) => 0,
                Err(error) => -(error as i32),
            }
        }
        Err(e) => -(e as i32),
    };
    deliver_pending_signals_with_locks(proc, advisory_locks, &mut host);
    result
}

/// setreuid/setregid channel implementations. These remain private because
/// syscall dispatch, not a new Wasm export, is their ABI-43 entry point.
fn kernel_setreuid(ruid: u32, euid: u32) -> i32 {
    let (_gkl, proc, advisory_locks) = unsafe { get_process_and_advisory_locks() };
    let result = match syscalls::sys_setreuid(proc, ruid, euid) {
        Ok(()) => 0,
        Err(error) => -(error as i32),
    };
    let mut host = WasmHostIO;
    deliver_pending_signals_with_locks(proc, advisory_locks, &mut host);
    result
}

fn kernel_setregid(rgid: u32, egid: u32) -> i32 {
    let (_gkl, proc, advisory_locks) = unsafe { get_process_and_advisory_locks() };
    let result = match syscalls::sys_setregid(proc, rgid, egid) {
        Ok(()) => 0,
        Err(error) => -(error as i32),
    };
    let mut host = WasmHostIO;
    deliver_pending_signals_with_locks(proc, advisory_locks, &mut host);
    result
}

/// setresuid — set real, effective, and saved user IDs.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_setresuid(ruid: u32, euid: u32, suid: u32) -> i32 {
    let (_gkl, proc, advisory_locks) = unsafe { get_process_and_advisory_locks() };
    let result = match syscalls::sys_setresuid(proc, ruid, euid, suid) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    };
    let mut host = WasmHostIO;
    deliver_pending_signals_with_locks(proc, advisory_locks, &mut host);
    result
}

/// getresuid — get real, effective, and saved user IDs.
/// Writes three u32 values to the pointers.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_getresuid(
    ruid_ptr: *mut u32,
    euid_ptr: *mut u32,
    suid_ptr: *mut u32,
) -> i32 {
    let (_gkl, proc, advisory_locks) = unsafe { get_process_and_advisory_locks() };
    let (ruid, euid, suid) = syscalls::sys_getresuid(proc);
    unsafe {
        *ruid_ptr = ruid;
        *euid_ptr = euid;
        *suid_ptr = suid;
    }
    let mut host = WasmHostIO;
    deliver_pending_signals_with_locks(proc, advisory_locks, &mut host);
    0
}

/// setresgid — set real, effective, and saved group IDs.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_setresgid(rgid: u32, egid: u32, sgid: u32) -> i32 {
    let (_gkl, proc, advisory_locks) = unsafe { get_process_and_advisory_locks() };
    let result = match syscalls::sys_setresgid(proc, rgid, egid, sgid) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    };
    let mut host = WasmHostIO;
    deliver_pending_signals_with_locks(proc, advisory_locks, &mut host);
    result
}

/// getresgid — get real, effective, and saved group IDs.
/// Writes three u32 values to the pointers.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_getresgid(
    rgid_ptr: *mut u32,
    egid_ptr: *mut u32,
    sgid_ptr: *mut u32,
) -> i32 {
    let (_gkl, proc, advisory_locks) = unsafe { get_process_and_advisory_locks() };
    let (rgid, egid, sgid) = syscalls::sys_getresgid(proc);
    unsafe {
        *rgid_ptr = rgid;
        *egid_ptr = egid;
        *sgid_ptr = sgid;
    }
    let mut host = WasmHostIO;
    deliver_pending_signals_with_locks(proc, advisory_locks, &mut host);
    0
}

/// getgroups — get supplementary group IDs.
/// Returns count on success, negative errno on error.
fn validate_getgroups_destination(size: u32, list_ptr: *mut u32) -> Result<(), Errno> {
    if size as usize > crate::credentials::NGROUPS_MAX {
        return Err(Errno::EINVAL);
    }
    if size > 0 && list_ptr.is_null() {
        return Err(Errno::EFAULT);
    }
    Ok(())
}

#[unsafe(no_mangle)]
pub extern "C" fn kernel_getgroups(size: u32, list_ptr: *mut u32) -> i32 {
    if let Err(error) = validate_getgroups_destination(size, list_ptr) {
        return -(error as i32);
    }
    let (_gkl, proc, advisory_locks) = unsafe { get_process_and_advisory_locks() };
    let result = match syscalls::sys_getgroups(proc, size) {
        // WHY: the shared descriptor lends exactly size * sizeof(gid_t).
        // Count-only queries never name or inspect a destination.
        Ok(groups) => match syscalls::copy_getgroups_to_destination(
            size,
            list_ptr,
            size * size_of::<u32>() as u32,
            groups,
        ) {
            Ok(count) => count as i32,
            Err(error) => -(error as i32),
        },
        Err(e) => -(e as i32),
    };
    let mut host = WasmHostIO;
    deliver_pending_signals_with_locks(proc, advisory_locks, &mut host);
    result
}

#[cfg(test)]
mod getgroups_destination_tests {
    use super::*;

    #[test]
    fn count_query_does_not_require_a_destination() {
        assert_eq!(
            validate_getgroups_destination(0, core::ptr::null_mut()),
            Ok(())
        );
    }

    #[test]
    fn positive_request_requires_a_destination_and_bounded_count() {
        let pointer = core::ptr::NonNull::<u32>::dangling().as_ptr();
        assert_eq!(
            validate_getgroups_destination(1, core::ptr::null_mut()),
            Err(Errno::EFAULT)
        );
        assert_eq!(
            validate_getgroups_destination(
                crate::credentials::NGROUPS_MAX as u32 + 1,
                pointer,
            ),
            Err(Errno::EINVAL)
        );
        assert_eq!(validate_getgroups_destination(1, pointer), Ok(()));
    }
}

/// setgroups — replace the complete ordered supplementary group list.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_setgroups(size: u32, list_ptr: *const u32) -> i32 {
    if size as usize > crate::credentials::NGROUPS_MAX {
        return -(Errno::EINVAL as i32);
    }
    if size > 0 && list_ptr.is_null() {
        return -(Errno::EFAULT as i32);
    }
    let (_gkl, proc, advisory_locks) = unsafe { get_process_and_advisory_locks() };
    let groups = if size == 0 {
        &[][..]
    } else {
        unsafe { core::slice::from_raw_parts(list_ptr, size as usize) }
    };
    let result = match syscalls::sys_setgroups(proc, groups) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    };
    let mut host = WasmHostIO;
    deliver_pending_signals_with_locks(proc, advisory_locks, &mut host);
    result
}

fn read_wire_u32(bytes: &[u8], offset: usize) -> u32 {
    u32::from_le_bytes(
        bytes[offset..offset + size_of::<u32>()]
            .try_into()
            .expect("fixed wire u32 range"),
    )
}

fn write_wire_u32(bytes: &mut [u8], offset: usize, value: u32) {
    bytes[offset..offset + size_of::<u32>()].copy_from_slice(&value.to_le_bytes());
}

fn finish_direct_blocking_retry_dispatch(
    proc: &mut Process,
    owns_active: bool,
    owns_dispatch: bool,
) {
    if owns_active {
        proc.blocked_retries.clear_active();
    }
    if owns_dispatch {
        proc.blocked_retries.clear_dispatch();
    }
}

fn deliver_pending_signals_for_known_tid(
    proc: &mut Process,
    advisory_locks: &mut crate::lock::AdvisoryLockManager,
    host: &mut dyn crate::process::HostIO,
    tid: u32,
) {
    // WHY: direct message exports captured TID before borrowing Process from
    // the table. Re-reading ambient ProcessTable state here would alias that
    // live mutable borrow, especially on activation-error paths that never
    // install dispatch_tid.
    let _ = deliver_pending_signals_for_tid_with_locks(proc, advisory_locks, host, tid);
}

/// Extract SCM_RIGHTS descriptors from one canonical kernel control wire.
///
/// Malformed records and invalid descriptors are errors. Silently skipping
/// either would let the queued message disagree with the sender's request.
fn extract_scm_rights(
    proc: &crate::process::Process,
    control_ptr: usize,
    control_len: usize,
) -> Result<Vec<crate::pipe::InFlightFd>, Errno> {
    let mut result = Vec::new();
    if control_len == 0 {
        return Ok(result);
    }
    if control_ptr == 0 {
        return Err(Errno::EINVAL);
    }

    let control = unsafe { slice::from_raw_parts(control_ptr as *const u8, control_len) };
    // WHY: this visitor only serializes non-owning entries. The caller retains
    // their resources after the complete wire validates, so a malformed later
    // record cannot leave an earlier descriptor partially transferred.
    crate::socket_wire::for_each_canonical_scm_rights_fd(control, |fd_num| {
        result.try_reserve(1).map_err(|_| Errno::ENOMEM)?;
        result.push(crate::syscalls::snapshot_scm_rights_fd(proc, fd_num)?);
        Ok(())
    })?;

    Ok(result)
}

/// sendmsg — send one canonical host-staged message on a socket.
///
/// The host flattens every caller-native iovec into one contiguous leased
/// buffer. Keeping the fixed wire at zero or one iovec preserves datagram
/// atomicity without a second kernel allocation and payload copy.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_sendmsg(fd: i32, msg_ptr: *const u8, flags: u32, retry_token: i64) -> i32 {
    use wasm_posix_shared::{KernelIovecWire, KernelMsghdrWire};

    let (_gkl, tid, proc, advisory_locks) = unsafe { get_process_tid_and_advisory_locks() };
    let mut host = WasmHostIO;
    let operation = crate::blocked_retry::BlockingRetryOperation::Sendmsg;
    let owns_active = match proc
        .blocked_retries
        .activate_direct(tid, retry_token, operation)
    {
        Ok(owns_active) => owns_active,
        Err(error) => {
            deliver_pending_signals_for_known_tid(proc, advisory_locks, &mut host, tid);
            return -(error as i32);
        }
    };
    let owns_dispatch = match proc.blocked_retries.enter_dispatch(tid) {
        Ok(owns_dispatch) => owns_dispatch,
        Err(error) => {
            if owns_active {
                proc.blocked_retries.clear_active();
            }
            deliver_pending_signals_for_known_tid(proc, advisory_locks, &mut host, tid);
            return -(error as i32);
        }
    };

    let msg = unsafe { slice::from_raw_parts(msg_ptr, size_of::<KernelMsghdrWire>()) };
    let name_ptr = read_wire_u32(msg, offset_of!(KernelMsghdrWire, name)) as usize;
    let name_len = read_wire_u32(msg, offset_of!(KernelMsghdrWire, name_len)) as usize;
    let iov_ptr = read_wire_u32(msg, offset_of!(KernelMsghdrWire, iov)) as usize;
    let iov_len = read_wire_u32(msg, offset_of!(KernelMsghdrWire, iov_len));
    let control_ptr = read_wire_u32(msg, offset_of!(KernelMsghdrWire, control)) as usize;
    let control_len = read_wire_u32(msg, offset_of!(KernelMsghdrWire, control_len)) as usize;

    if let Err(err) = validate_canonical_message_iov_len(iov_len) {
        finish_direct_blocking_retry_dispatch(proc, owns_active, owns_dispatch);
        deliver_pending_signals_for_known_tid(proc, advisory_locks, &mut host, tid);
        return -(err as i32);
    }

    let active_ancillary = match syscalls::clone_active_sendmsg_ancillary(proc, tid) {
        Ok(ancillary) => ancillary,
        Err(err) => {
            finish_direct_blocking_retry_dispatch(proc, owns_active, owns_dispatch);
            // A fallible clone may already have retained an earlier rights
            // entry. Its Drop queued exact deferred release metadata; consume
            // that rollback before this exported operation returns.
            syscalls::drain_deferred_scm_rights_releases(advisory_locks, &mut host);
            deliver_pending_signals_for_known_tid(proc, advisory_locks, &mut host, tid);
            return -(err as i32);
        }
    };
    let (ancillary_fds, binding_template) = if let Some(ancillary) = active_ancillary {
        (ancillary, None)
    } else {
        let ancillary = match extract_scm_rights(proc, control_ptr, control_len) {
            Ok(fds) => fds,
            Err(err) => {
                finish_direct_blocking_retry_dispatch(proc, owns_active, owns_dispatch);
                deliver_pending_signals_for_known_tid(proc, advisory_locks, &mut host, tid);
                return -(err as i32);
            }
        };
        let mut template = Vec::new();
        if template.try_reserve_exact(ancillary.len()).is_err() {
            finish_direct_blocking_retry_dispatch(proc, owns_active, owns_dispatch);
            deliver_pending_signals_for_known_tid(proc, advisory_locks, &mut host, tid);
            return -(Errno::ENOMEM as i32);
        }
        for entry in &ancillary {
            match entry.try_clone_retained() {
                Ok(entry) => template.push(entry),
                Err(error) => {
                    finish_direct_blocking_retry_dispatch(proc, owns_active, owns_dispatch);
                    drop(template);
                    syscalls::drain_deferred_scm_rights_releases(advisory_locks, &mut host);
                    deliver_pending_signals_for_known_tid(proc, advisory_locks, &mut host, tid);
                    return -(error as i32);
                }
            }
        }
        (ancillary, Some(template))
    };

    let (base, len) = if iov_len == 0 {
        (0, 0)
    } else {
        let iov =
            unsafe { slice::from_raw_parts(iov_ptr as *const u8, size_of::<KernelIovecWire>()) };
        (
            read_wire_u32(iov, offset_of!(KernelIovecWire, base)) as usize,
            read_wire_u32(iov, offset_of!(KernelIovecWire, len)) as usize,
        )
    };

    let buf = if len == 0 {
        &[]
    } else {
        // SAFETY: the host copied the complete positive-length iovec into the
        // live kernel-owned channel allocation before this synchronous call.
        unsafe { slice::from_raw_parts(base as *const u8, len) }
    };

    let addr = if name_ptr != 0 && name_len > 0 {
        Some(unsafe { slice::from_raw_parts(name_ptr as *const u8, name_len) })
    } else {
        None
    };
    let mut result =
        match syscalls::sys_sendmsg(proc, &mut host, fd, buf, flags, addr, ancillary_fds) {
            Ok(n) => n as i32,
            Err(e) => -(e as i32),
        };
    let cross_process_udp = (result >= 0)
        .then(|| syscalls::cross_process_loopback_udp_route(proc, fd, addr))
        .flatten();
    if result == -(Errno::EAGAIN as i32) {
        if let Err(error) = syscalls::ensure_blocking_retry_ofd_binding(
            proc,
            advisory_locks,
            &mut host,
            tid,
            137,
            fd,
            binding_template,
        ) {
            result = -(error as i32);
        }
    }
    finish_direct_blocking_retry_dispatch(proc, owns_active, owns_dispatch);
    syscalls::drain_deferred_scm_rights_releases(advisory_locks, &mut host);

    deliver_pending_signals_for_known_tid(proc, advisory_locks, &mut host, tid);
    complete_cross_process_loopback_udp(cross_process_udp, buf);
    result
}

/// recvmsg — receive into one canonical host-staged contiguous buffer.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_recvmsg(fd: i32, msg_ptr: *mut u8, flags: u32, retry_token: i64) -> i32 {
    use wasm_posix_shared::fd_flags::FD_CLOEXEC;
    use wasm_posix_shared::socket::{
        MSG_CMSG_CLOEXEC, MSG_CTRUNC, SCM_RIGHTS, SCM_RIGHTS_FD_BYTES, SOL_SOCKET,
    };
    use wasm_posix_shared::{KernelCmsghdrWire, KernelIovecWire, KernelMsghdrWire};

    let (_gkl, tid, proc, advisory_locks) = unsafe { get_process_tid_and_advisory_locks() };
    let mut host = WasmHostIO;
    let operation = crate::blocked_retry::BlockingRetryOperation::Recvmsg;
    let owns_active = match proc
        .blocked_retries
        .activate_direct(tid, retry_token, operation)
    {
        Ok(owns_active) => owns_active,
        Err(error) => {
            deliver_pending_signals_for_known_tid(proc, advisory_locks, &mut host, tid);
            return -(error as i32);
        }
    };
    let owns_dispatch = match proc.blocked_retries.enter_dispatch(tid) {
        Ok(owns_dispatch) => owns_dispatch,
        Err(error) => {
            if owns_active {
                proc.blocked_retries.clear_active();
            }
            deliver_pending_signals_for_known_tid(proc, advisory_locks, &mut host, tid);
            return -(error as i32);
        }
    };

    let msg = unsafe { slice::from_raw_parts(msg_ptr, size_of::<KernelMsghdrWire>()) };
    let name_ptr = read_wire_u32(msg, offset_of!(KernelMsghdrWire, name)) as usize;
    let name_len = read_wire_u32(msg, offset_of!(KernelMsghdrWire, name_len)) as usize;
    let iov_ptr = read_wire_u32(msg, offset_of!(KernelMsghdrWire, iov)) as usize;
    let iov_len = read_wire_u32(msg, offset_of!(KernelMsghdrWire, iov_len));
    let control_ptr = read_wire_u32(msg, offset_of!(KernelMsghdrWire, control)) as usize;
    let control_len = read_wire_u32(msg, offset_of!(KernelMsghdrWire, control_len)) as usize;

    if let Err(err) = validate_canonical_message_iov_len(iov_len) {
        finish_direct_blocking_retry_dispatch(proc, owns_active, owns_dispatch);
        deliver_pending_signals_for_known_tid(proc, advisory_locks, &mut host, tid);
        return -(err as i32);
    }

    let (base, len) = if iov_len == 0 {
        (0, 0)
    } else {
        let iov =
            unsafe { slice::from_raw_parts(iov_ptr as *const u8, size_of::<KernelIovecWire>()) };
        (
            read_wire_u32(iov, offset_of!(KernelIovecWire, base)) as usize,
            read_wire_u32(iov, offset_of!(KernelIovecWire, len)) as usize,
        )
    };

    let buf = if len == 0 {
        &mut []
    } else {
        unsafe { slice::from_raw_parts_mut(base as *mut u8, len) }
    };

    let addr_buf = if name_ptr != 0 && name_len > 0 {
        unsafe { slice::from_raw_parts_mut(name_ptr as *mut u8, name_len) }
    } else {
        &mut []
    };

    let (mut result, mut received) =
        match syscalls::sys_recvmsg(proc, &mut host, fd, buf, flags, addr_buf) {
            Ok(received) => (received.return_len as i32, Some(received)),
            Err(err) => (-(err as i32), None),
        };
    if result == -(Errno::EAGAIN as i32) {
        if let Err(error) = syscalls::ensure_blocking_retry_ofd_binding(
            proc,
            advisory_locks,
            &mut host,
            tid,
            138,
            fd,
            None,
        ) {
            result = -(error as i32);
        }
    }
    finish_direct_blocking_retry_dispatch(proc, owns_active, owns_dispatch);

    // Publish all result metadata even for a zero-byte datagram: a zero-length
    // message can still carry descriptors and output flags.
    let mut ancillary_delivered = false;
    let mut output_msg_flags = received
        .as_ref()
        .map_or(0, |received| received.output_flags);
    if let Some(received) = received.as_mut() {
        let msg_mut = unsafe { slice::from_raw_parts_mut(msg_ptr, size_of::<KernelMsghdrWire>()) };
        if name_ptr != 0 {
            // msg_name presence, not its capacity, controls whether
            // msg_namelen is a value-result field. A canonical non-null
            // zero-capacity pointer still receives the complete length.
            write_wire_u32(
                msg_mut,
                offset_of!(KernelMsghdrWire, name_len),
                received.addr_len as u32,
            );
        }

        if !received.ancillary_fds.is_empty() {
            let mut in_flight = core::mem::take(&mut received.ancillary_fds);
            let control_header_size = size_of::<KernelCmsghdrWire>();
            let control_fd_capacity =
                if control_ptr != 0 && control_len >= control_header_size + SCM_RIGHTS_FD_BYTES {
                    (control_len - control_header_size) / SCM_RIGHTS_FD_BYTES
                } else {
                    0
                };
            let install_count = control_fd_capacity.min(in_flight.len());
            let excess = in_flight.split_off(install_count);
            let had_excess = !excess.is_empty();
            // Dropped entries enqueue allocation-free cleanup. The queue is
            // drained only after the fitting prefix has become receiver OFDs.
            drop(excess);

            let attempted = in_flight.len();
            let new_fds = if attempted == 0 {
                Vec::new()
            } else {
                let fd_flags = if flags & MSG_CMSG_CLOEXEC != 0 {
                    FD_CLOEXEC
                } else {
                    0
                };
                syscalls::install_scm_rights_fds_with_flags(proc, in_flight, fd_flags)
            };
            unsafe {
                crate::pipe::global_pipe_table().finish_ancillary_transition();
            }

            if had_excess || new_fds.len() < attempted {
                output_msg_flags |= MSG_CTRUNC;
            }

            if !new_fds.is_empty() {
                let cmsg_data_len = new_fds.len() * SCM_RIGHTS_FD_BYTES;
                let cmsg_len = control_header_size + cmsg_data_len;
                let alignment = align_of::<KernelCmsghdrWire>();
                let cmsg_space = (cmsg_len + alignment - 1) & !(alignment - 1);
                debug_assert!(cmsg_space <= control_len);
                let ctrl =
                    unsafe { slice::from_raw_parts_mut(control_ptr as *mut u8, control_len) };
                ctrl[..cmsg_space].fill(0);
                write_wire_u32(
                    ctrl,
                    offset_of!(KernelCmsghdrWire, cmsg_len),
                    cmsg_len as u32,
                );
                write_wire_u32(ctrl, offset_of!(KernelCmsghdrWire, cmsg_level), SOL_SOCKET);
                write_wire_u32(ctrl, offset_of!(KernelCmsghdrWire, cmsg_type), SCM_RIGHTS);
                for (i, &new_fd) in new_fds.iter().enumerate() {
                    let off = control_header_size + i * SCM_RIGHTS_FD_BYTES;
                    ctrl[off..off + SCM_RIGHTS_FD_BYTES].copy_from_slice(&new_fd.to_le_bytes());
                }
                let msg_mut =
                    unsafe { slice::from_raw_parts_mut(msg_ptr, size_of::<KernelMsghdrWire>()) };
                write_wire_u32(
                    msg_mut,
                    offset_of!(KernelMsghdrWire, control_len),
                    cmsg_space as u32,
                );
                ancillary_delivered = true;
            }
        }
    }

    if !ancillary_delivered {
        let msg_mut = unsafe { slice::from_raw_parts_mut(msg_ptr, size_of::<KernelMsghdrWire>()) };
        write_wire_u32(msg_mut, offset_of!(KernelMsghdrWire, control_len), 0);
    }
    let msg_mut = unsafe { slice::from_raw_parts_mut(msg_ptr, size_of::<KernelMsghdrWire>()) };
    write_wire_u32(
        msg_mut,
        offset_of!(KernelMsghdrWire, flags),
        output_msg_flags,
    );

    syscalls::drain_deferred_scm_rights_releases(advisory_locks, &mut host);

    deliver_pending_signals_for_known_tid(proc, advisory_locks, &mut host, tid);
    result
}

/// wait4 — wait for child process. Writes status to wstatus_ptr, ignores rusage.
/// Returns child pid on success, negative errno on error.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_wait4(
    pid: i32,
    wstatus_ptr: *mut i32,
    options: u32,
    _rusage_ptr: *mut u8,
) -> i32 {
    let (_gkl, proc, advisory_locks) = unsafe { get_process_and_advisory_locks() };
    let mut host = WasmHostIO;
    let result = match syscalls::sys_waitpid(proc, &mut host, pid, options) {
        Ok((child_pid, status)) => {
            if !wstatus_ptr.is_null() {
                unsafe {
                    *wstatus_ptr = status;
                }
            }
            child_pid
        }
        Err(e) => -(e as i32),
    };
    deliver_pending_signals_with_locks(proc, advisory_locks, &mut host);
    result
}

/// Check if a file descriptor refers to a terminal.
/// Returns 1 if terminal, or negative errno on error (ENOTTY if not a terminal).
#[unsafe(no_mangle)]
pub extern "C" fn kernel_isatty(fd: i32) -> i32 {
    let (_gkl, proc, advisory_locks) = unsafe { get_process_and_advisory_locks() };
    let result = match syscalls::sys_isatty(proc, fd) {
        Ok(v) => v,
        Err(e) => -(e as i32),
    };
    let mut host = WasmHostIO;
    deliver_pending_signals_with_locks(proc, advisory_locks, &mut host);
    result
}

/// Get an environment variable by name.
/// Returns the length of the value on success, or negative errno on error.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_getenv(
    name_ptr: *const u8,
    name_len: u32,
    buf_ptr: *mut u8,
    buf_len: u32,
) -> i32 {
    let (_gkl, proc, advisory_locks) = unsafe { get_process_and_advisory_locks() };
    let name = unsafe { slice::from_raw_parts(name_ptr, name_len as usize) };
    let buf = unsafe { slice::from_raw_parts_mut(buf_ptr, buf_len as usize) };
    let result = match syscalls::sys_getenv(proc, name, buf) {
        Ok(n) => n as i32,
        Err(e) => -(e as i32),
    };
    let mut host = WasmHostIO;
    deliver_pending_signals_with_locks(proc, advisory_locks, &mut host);
    result
}

/// Set an environment variable.
/// Returns 0 on success, or negative errno on error.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_setenv(
    name_ptr: *const u8,
    name_len: u32,
    val_ptr: *const u8,
    val_len: u32,
    overwrite: u32,
) -> i32 {
    let (_gkl, proc, advisory_locks) = unsafe { get_process_and_advisory_locks() };
    let name = unsafe { slice::from_raw_parts(name_ptr, name_len as usize) };
    let value = unsafe { slice::from_raw_parts(val_ptr, val_len as usize) };
    let result = match syscalls::sys_setenv(proc, name, value, overwrite != 0) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    };
    let mut host = WasmHostIO;
    deliver_pending_signals_with_locks(proc, advisory_locks, &mut host);
    result
}

/// Remove an environment variable.
/// Returns 0 on success, or negative errno on error.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_unsetenv(name_ptr: *const u8, name_len: u32) -> i32 {
    let (_gkl, proc, advisory_locks) = unsafe { get_process_and_advisory_locks() };
    let name = unsafe { slice::from_raw_parts(name_ptr, name_len as usize) };
    let result = match syscalls::sys_unsetenv(proc, name) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    };
    let mut host = WasmHostIO;
    deliver_pending_signals_with_locks(proc, advisory_locks, &mut host);
    result
}

/// Return the number of environment variables in proc.environ.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_environ_count() -> u32 {
    let (_gkl, proc, advisory_locks) = unsafe { get_process_and_advisory_locks() };
    proc.environ.len() as u32
}

/// Read the environment variable at `index` as "KEY=VALUE" into buf.
/// The zero-capacity query and complete-or-`ERANGE` copy contract matches
/// `kernel_argv_read`.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_environ_get(index: u32, buf_ptr: *mut u8, buf_len: u32) -> i32 {
    let (_gkl, proc, advisory_locks) = unsafe { get_process_and_advisory_locks() };
    let idx = index as usize;
    if idx >= proc.environ.len() {
        return -(Errno::EINVAL as i32);
    }
    let entry = &proc.environ[idx];
    unsafe { crate::complete_copy::copy_complete_bytes(entry, buf_ptr, buf_len) }
}

// ---------------------------------------------------------------------------
// Argv support — host pushes args, program reads them at startup
// ---------------------------------------------------------------------------

/// Clear all argv entries.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_clear_argv() {
    let (_gkl, proc, advisory_locks) = unsafe { get_process_and_advisory_locks() };
    proc.argv.clear();
}

/// Push an argument string. Called by host before _start.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_push_argv(ptr: *const u8, len: u32) {
    let (_gkl, proc, advisory_locks) = unsafe { get_process_and_advisory_locks() };
    let data = unsafe { slice::from_raw_parts(ptr, len as usize) };
    proc.argv.push(data.to_vec());
}

/// Return the number of arguments.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_get_argc() -> u32 {
    let (_gkl, proc, advisory_locks) = unsafe { get_process_and_advisory_locks() };
    proc.argv.len() as u32
}

/// Copy argument at `index` into `buf_ptr`.
///
/// A zero capacity queries the complete length. A positive short capacity
/// returns `-ERANGE` without writing; otherwise the complete entry is copied.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_argv_read(index: u32, buf_ptr: *mut u8, buf_max: u32) -> i32 {
    let (_gkl, proc, advisory_locks) = unsafe { get_process_and_advisory_locks() };
    match proc.argv.get(index as usize) {
        Some(arg) => unsafe {
            crate::complete_copy::copy_complete_bytes(arg, buf_ptr, buf_max)
        },
        None => -(Errno::EINVAL as i32),
    }
}

/// getrandom — fill buffer with random bytes from the host.
/// Returns number of bytes written, or negative errno on error.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_getrandom(buf_ptr: *mut u8, buf_len: u32, _flags: u32) -> i32 {
    let (_gkl, proc, advisory_locks) = unsafe { get_process_and_advisory_locks() };
    let buf = unsafe { slice::from_raw_parts_mut(buf_ptr, buf_len as usize) };
    let mut host = WasmHostIO;
    let result = match host.host_getrandom(buf) {
        Ok(n) => n as i32,
        Err(e) => -(e as i32),
    };
    deliver_pending_signals_with_locks(proc, advisory_locks, &mut host);
    result
}

/// mmap. Returns address or MAP_FAILED (0xFFFFFFFF).
#[unsafe(no_mangle)]
pub extern "C" fn kernel_mmap(
    addr: usize,
    len: usize,
    prot: u32,
    flags: u32,
    fd: i32,
    offset_lo: u32,
    offset_hi: i32,
) -> usize {
    let (_gkl, proc, advisory_locks) = unsafe { get_process_and_advisory_locks() };
    let offset = ((offset_hi as i64) << 32) | (offset_lo as u64 as i64);
    let mut host = WasmHostIO;
    let result = match syscalls::sys_mmap(proc, &mut host, addr, len, prot, flags, fd, offset) {
        Ok(a) => a,
        Err(_) => wasm_posix_shared::mmap::MAP_FAILED,
    };

    // Ensure Wasm memory covers the mapped region (skip PROT_NONE mappings
    // which only reserve address space without needing physical backing).
    if result != wasm_posix_shared::mmap::MAP_FAILED && prot != 0 {
        let end = result.saturating_add(len);
        ensure_memory_covers(end);
    }

    deliver_pending_signals_with_locks(proc, advisory_locks, &mut host);
    result
}

/// munmap. Returns 0 on success, or negative errno on error.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_munmap(addr: usize, len: usize) -> i32 {
    let (_gkl, proc, advisory_locks) = unsafe { get_process_and_advisory_locks() };
    let mut host = WasmHostIO;
    let result = match syscalls::sys_munmap(proc, &mut host, addr, len) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    };
    deliver_pending_signals_with_locks(proc, advisory_locks, &mut host);
    result
}

/// brk. Returns the current or new program break.
/// Grows Wasm memory if the new break exceeds the current memory size.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_brk(addr: usize) -> usize {
    let (_gkl, proc, advisory_locks) = unsafe { get_process_and_advisory_locks() };
    let result = syscalls::sys_brk(proc, addr);

    // Ensure Wasm memory covers the new program break.
    if result > 0 {
        ensure_memory_covers(result);
    }

    let mut host = WasmHostIO;
    deliver_pending_signals_with_locks(proc, advisory_locks, &mut host);
    result
}

/// mprotect. Returns 0 on success, or negative errno on error.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_mprotect(addr: usize, len: usize, prot: u32) -> i32 {
    let (_gkl, proc, advisory_locks) = unsafe { get_process_and_advisory_locks() };
    let result = match syscalls::sys_mprotect(proc, addr, len, prot) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    };
    let mut host = WasmHostIO;
    deliver_pending_signals_with_locks(proc, advisory_locks, &mut host);
    result
}

/// Commit the current task's exit transition and return its recorded status.
///
/// WHY: the host adapter must be able to verify process exit without treating
/// the deliberate trap required by the guest-facing `_exit` ABI as an
/// arbitrary recoverable WebAssembly exception. Both exported entry points
/// share this exact transition so their cleanup and task-binding lifetime
/// cannot drift.
fn commit_current_task_exit(status: i32) -> i32 {
    let committed_status;
    {
        let (_gkl, proc, advisory_locks) = unsafe { get_process_and_advisory_locks() };
        if unsafe { host_is_thread_worker() } != 0 {
            // Thread exit: don't destroy shared process state (FDs, pipes, etc.).
            // Just set exit status and return — the guest import traps after
            // the host completes its exit-channel handshake.
            proc.exit_status = status & 0xff;
            proc.exit_signal = 0;
        } else {
            let mut host = WasmHostIO;
            syscalls::sys_exit_with_locks(proc, advisory_locks, &mut host, status);
        }
        committed_status = proc.exit_status;
    } // _gkl dropped here — GKL released
    // Consume task authority before deferred descriptor cleanup can invoke a
    // host callback. Cleanup needs no process identity, and a callback trap
    // must not leave the exited task available to a later dispatch.
    unsafe { &mut *PROCESS_TABLE.0.get() }.clear_current_tid_binding();
    finish_machine_scm_rights_cleanup_if_pending();
    committed_status
}

/// Host-adapter exit boundary that returns after committing process state.
///
/// The caller must compare the returned low-eight-bit status and independently
/// verify `kernel_get_process_state(pid) == PROCESS_STATE_EXITED` before
/// publishing lifecycle effects.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_commit_process_exit(status: i32) -> i32 {
    commit_current_task_exit(status)
}

/// Exit the process. Closes all fds and dir streams, sets state to Exited.
/// For thread workers, just sets exit_status without destroying shared state.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_exit(status: i32) -> ! {
    let _ = commit_current_task_exit(status);
    // Halt execution — musl's _exit loops forever if we just return.
    #[cfg(any(target_arch = "wasm32", target_arch = "wasm64"))]
    unsafe {
        core::hint::unreachable_unchecked();
    }
    #[cfg(not(any(target_arch = "wasm32", target_arch = "wasm64")))]
    unreachable!("kernel_exit should not return");
}

/// Get the exit status of the current process (set by kernel_exit).
#[unsafe(no_mangle)]
pub extern "C" fn kernel_get_exit_status() -> i32 {
    let (_gkl, proc, advisory_locks) = unsafe { get_process_and_advisory_locks() };
    proc.exit_status
}

// ---------------------------------------------------------------------------
// Socket and poll exports
// ---------------------------------------------------------------------------

/// Create a socket. Returns fd or negative errno.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_socket(domain: u32, sock_type: u32, protocol: u32) -> i32 {
    let (_gkl, proc, advisory_locks) = unsafe { get_process_and_advisory_locks() };
    let mut host = WasmHostIO;
    let result = match syscalls::sys_socket(proc, &mut host, domain, sock_type, protocol) {
        Ok(fd) => fd,
        Err(e) => -(e as i32),
    };
    deliver_pending_signals_with_locks(proc, advisory_locks, &mut host);
    result
}

/// Create a connected pair of sockets. Returns 0 on success, negative errno on error.
/// Writes the two fds to sv_ptr[0] and sv_ptr[1].
#[unsafe(no_mangle)]
pub extern "C" fn kernel_socketpair(
    domain: u32,
    sock_type: u32,
    protocol: u32,
    sv_ptr: *mut i32,
    sv_capacity: u32,
) -> i32 {
    if sv_ptr.is_null() {
        return -(Errno::EFAULT as i32);
    }
    if sv_capacity != wasm_posix_shared::kernel_scratch_wire::FD_PAIR_BYTES {
        return -(Errno::EINVAL as i32);
    }
    if (sv_ptr as usize) % core::mem::align_of::<i32>() != 0 {
        return -(Errno::EFAULT as i32);
    }
    let (_gkl, proc, advisory_locks) = unsafe { get_process_and_advisory_locks() };
    let mut host = WasmHostIO;
    let result = match syscalls::sys_socketpair(proc, &mut host, domain, sock_type, protocol) {
        Ok((fd0, fd1)) => {
            unsafe {
                *sv_ptr = fd0;
                *sv_ptr.add(1) = fd1;
            }
            0
        }
        Err(e) => -(e as i32),
    };
    deliver_pending_signals_with_locks(proc, advisory_locks, &mut host);
    result
}

/// Bind a socket to an address. Returns 0 on success, negative errno on error.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_bind(fd: i32, addr_ptr: *const u8, addr_len: u32) -> i32 {
    let (_gkl, proc, advisory_locks) = unsafe { get_process_and_advisory_locks() };
    let addr = unsafe { slice::from_raw_parts(addr_ptr, addr_len as usize) };
    let mut host = WasmHostIO;
    let result = match syscalls::sys_bind(proc, &mut host, fd, addr) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    };
    deliver_pending_signals_with_locks(proc, advisory_locks, &mut host);
    result
}

/// Listen for connections. Returns 0 on success, negative errno on error.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_listen(fd: i32, backlog: u32) -> i32 {
    let (_gkl, proc, advisory_locks) = unsafe { get_process_and_advisory_locks() };
    let mut host = WasmHostIO;
    let result = match syscalls::sys_listen(proc, &mut host, fd, backlog) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    };
    deliver_pending_signals_with_locks(proc, advisory_locks, &mut host);
    result
}

/// Return whether `flags` contains only the accept4 flags this kernel supports.
fn accept4_flags_are_valid(flags: u32) -> bool {
    use wasm_posix_shared::socket::{SOCK_CLOEXEC, SOCK_NONBLOCK};

    flags & !(SOCK_CLOEXEC | SOCK_NONBLOCK) == 0
}

/// Accept a connection with flags. Returns new fd or negative errno.
/// Flags: SOCK_CLOEXEC, SOCK_NONBLOCK (same values as socket()).
#[unsafe(no_mangle)]
pub extern "C" fn kernel_accept4(
    fd: i32,
    addr_ptr: *mut u8,
    addrlen_ptr: *mut u8,
    flags: u32,
) -> i32 {
    use wasm_posix_shared::fd_flags::FD_CLOEXEC;
    use wasm_posix_shared::flags::O_NONBLOCK;
    use wasm_posix_shared::socket::{SOCK_CLOEXEC, SOCK_NONBLOCK};

    let (_gkl, proc, advisory_locks) = unsafe { get_process_and_advisory_locks() };
    let mut host = WasmHostIO;
    let address_requested = syscalls::validate_optional_socket_address_output(
        !addr_ptr.is_null(),
        !addrlen_ptr.is_null(),
    );
    let result = if !accept4_flags_are_valid(flags) {
        -(Errno::EINVAL as i32)
    } else if let Err(error) = address_requested {
        // Reject an incomplete active pair before accept can consume a queued
        // connection and publish an unreachable descriptor.
        -(error as i32)
    } else {
        let requested_addr_len = if address_requested.unwrap_or(false) {
            let addrlen_buf = unsafe { slice::from_raw_parts(addrlen_ptr, 4) };
            Some(u32::from_le_bytes(
                addrlen_buf.try_into().unwrap_or([0; 4]),
            ) as usize)
        } else {
            None
        };
        match syscalls::sys_accept(proc, &mut host, fd) {
            Ok(new_fd) => {
                // Apply SOCK_CLOEXEC flag
                if flags & SOCK_CLOEXEC != 0 {
                    if let Ok(entry) = proc.fd_table.get_mut(new_fd) {
                        entry.fd_flags |= FD_CLOEXEC;
                    }
                }
                // Apply SOCK_NONBLOCK flag
                if flags & SOCK_NONBLOCK != 0 {
                    if let Ok(entry) = proc.fd_table.get(new_fd) {
                        if let Some(ofd) = proc.ofd_table.get_mut(entry.ofd_ref.0) {
                            ofd.set_status_flags_raw(ofd.status_flags() | O_NONBLOCK);
                        }
                    }
                }
                let address_result = if let Some(max_len) = requested_addr_len {
                    // A zero-capacity result has no address bytes to lend, but
                    // still reports the complete peer-address length.
                    let addr_buf = if max_len == 0 {
                        &mut []
                    } else {
                        unsafe { slice::from_raw_parts_mut(addr_ptr, max_len) }
                    };
                    syscalls::write_accept_peer_address(proc, new_fd, addr_buf).map(|actual_len| {
                        let addrlen_buf =
                            unsafe { slice::from_raw_parts_mut(addrlen_ptr, 4) };
                        addrlen_buf.copy_from_slice(&actual_len.to_le_bytes());
                    })
                } else {
                    Ok(())
                };
                match address_result {
                    Ok(()) => new_fd,
                    Err(error) => {
                        // A result-marshalling failure cannot publish an fd
                        // whose peer metadata the caller requested but did not
                        // receive. Roll back the accepted descriptor first.
                        let rollback = syscalls::sys_close_with_locks(
                            proc,
                            advisory_locks,
                            &mut host,
                            new_fd,
                        );
                        -(rollback.err().unwrap_or(error) as i32)
                    }
                }
            }
            Err(e) => -(e as i32),
        }
    };
    // WHY: an accepted connection can already carry stream SCM_RIGHTS before
    // accept allocates its fd. If that allocation fails, discarding the
    // accepted socket drops those rights and must finish their deferred
    // backing/lock cleanup in this same exported operation.
    syscalls::finish_scm_rights_cleanup(advisory_locks, &mut host);
    deliver_pending_signals_with_locks(proc, advisory_locks, &mut host);
    result
}

/// Connect to an address. Returns 0 on success, negative errno on error.
///
/// If the same-process loopback connect fails with ECONNREFUSED, searches
/// all processes in the ProcessTable for a matching listener. This enables
/// cross-process loopback (e.g. nginx -> php-fpm).
#[unsafe(no_mangle)]
pub extern "C" fn kernel_connect(fd: i32, addr_ptr: *const u8, addr_len: u32) -> i32 {
    let _gkl = GklGuard::acquire();
    let table = unsafe { &mut *PROCESS_TABLE.0.get() };
    let pid = table.current_pid();
    let mut host = WasmHostIO;
    let addr = unsafe { slice::from_raw_parts(addr_ptr, addr_len as usize) };
    let connect_result = match table.get_mut(pid) {
        Some(proc) => syscalls::sys_connect(proc, &mut host, fd, addr),
        None => return -(Errno::ESRCH as i32),
    };
    let result = match connect_result {
        Ok(()) => 0,
        Err(Errno::ECONNREFUSED) if addr_len >= 3 => {
            let family = u16::from_le_bytes([addr[0], addr[1]]);
            if family == 1 {
                // AF_UNIX — try cross-process connect
                match cross_process_unix_connect(table, pid, &mut host, fd, addr) {
                    Ok(()) => 0,
                    Err(e) => -(e as i32),
                }
            } else if family == 2 && addr_len >= 8 {
                // AF_INET loopback
                let ip = [addr[4], addr[5], addr[6], addr[7]];
                if ip == [127, 0, 0, 1] {
                    match cross_process_loopback_connect(table, pid, fd, addr) {
                        Ok(()) => 0,
                        Err(e) => -(e as i32),
                    }
                } else {
                    -(Errno::ECONNREFUSED as i32)
                }
            } else if family == 10 && addr_len >= 28 {
                // AF_INET6 loopback
                match cross_process_loopback_connect6(table, pid, fd, addr) {
                    Ok(()) => 0,
                    Err(e) => -(e as i32),
                }
            } else {
                -(Errno::ECONNREFUSED as i32)
            }
        }
        Err(e) => -(e as i32),
    };
    if let Some((proc, advisory_locks)) = table.process_and_advisory_locks(pid) {
        // WHY: reconnecting an AF_UNIX datagram socket can discard queued
        // messages and their retained SCM_RIGHTS descriptors. Complete those
        // deferred releases in this dispatch before locks or host handles can
        // remain live until an unrelated later syscall.
        syscalls::finish_scm_rights_cleanup(advisory_locks, &mut host);
        deliver_pending_signals_with_locks(proc, advisory_locks, &mut host);
    }
    result
}

/// Cross-process loopback TCP connect.
///
/// Searches all processes in the ProcessTable for a listening socket on the
/// target port, then creates global pipe pairs to connect the two processes.
fn cross_process_loopback_connect(
    table: &mut crate::process_table::ProcessTable,
    my_pid: u32,
    fd: i32,
    addr: &[u8],
) -> Result<(), Errno> {
    use crate::pipe::PipeBuffer;
    use crate::socket::{SocketDomain, SocketState, SocketType};
    use wasm_posix_shared::socket::{IPPROTO_IPV6, IPV6_V6ONLY};

    let port = u16::from_be_bytes([addr[2], addr[3]]);
    let ip = [addr[4], addr[5], addr[6], addr[7]];

    // Validate the client and snapshot its process-local socket index before
    // searching or mutating any other process.
    let sock_idx = {
        let proc = table.get(my_pid).ok_or(Errno::ESRCH)?;
        let ofd_idx = syscalls::resolve_io_ofd(proc, fd)?;
        let ofd = proc.ofd_table.get(ofd_idx).ok_or(Errno::EBADF)?;
        if ofd.file_type != FileType::Socket {
            return Err(Errno::ENOTSOCK);
        }
        let sock_idx = (-(ofd.host_handle + 1)) as usize;
        let client_sock = proc.sockets.get(sock_idx).ok_or(Errno::EBADF)?;
        if client_sock.domain != SocketDomain::Inet || client_sock.sock_type != SocketType::Stream {
            return Err(Errno::ECONNREFUSED);
        }
        sock_idx
    };

    // Search ALL processes for a listener on the target port.

    // Find the listener process and socket index
    let mut listener_pid: Option<u32> = None;
    let mut listener_sock_idx: Option<usize> = None;

    // Iterate all processes in REVERSE pid order (skip self).
    // Prefer highest pid — when parent and child both inherit a listener
    // (e.g. FPM master forks worker), the child (worker) is the one
    // that actually calls accept().
    for (pid, target_proc) in table.live_processes_descending() {
        if pid == my_pid {
            continue;
        }
        for idx in 0..target_proc.sockets.len() {
            if let Some(s) = target_proc.sockets.get(idx) {
                if s.state == SocketState::Listening
                    && s.bind_port == port
                    && s.sock_type == SocketType::Stream
                    && match s.domain {
                        SocketDomain::Inet => s.bind_addr == [0, 0, 0, 0] || s.bind_addr == ip,
                        SocketDomain::Inet6 => {
                            s.bind_addr6 == [0; 16]
                                && s.get_option(IPPROTO_IPV6, IPV6_V6ONLY).unwrap_or(0) == 0
                        }
                        SocketDomain::Unix => false,
                    }
                {
                    listener_pid = Some(pid);
                    listener_sock_idx = Some(idx);
                    break;
                }
            }
        }
        if listener_pid.is_some() {
            break;
        }
    }

    let listener_pid = listener_pid.ok_or(Errno::ECONNREFUSED)?;
    let listener_sock_idx = listener_sock_idx.ok_or(Errno::ECONNREFUSED)?;

    // Allocate two pipe buffers in the GLOBAL pipe table for bidirectional data:
    //   pipe_a: client writes → server reads
    //   pipe_b: server writes → client reads
    let pipe_table = unsafe { crate::pipe::global_pipe_table() };
    let pipe_a_idx = pipe_table.alloc(PipeBuffer::new(65536));
    let pipe_b_idx = pipe_table.alloc(PipeBuffer::new(65536));

    // Get the current process again (table borrow was released)
    let proc = table.get_mut(my_pid).ok_or(Errno::ESRCH)?;

    // Set up client socket (in current process)
    let client_sock = proc.sockets.get(sock_idx).ok_or(Errno::EBADF)?;
    let client_addr = if client_sock.bind_addr == [0; 4] {
        [127, 0, 0, 1]
    } else {
        client_sock.bind_addr
    };
    let mut client_port = client_sock.bind_port;
    if client_port == 0 {
        client_port = proc.next_ephemeral_port;
        proc.next_ephemeral_port = proc.next_ephemeral_port.wrapping_add(1);
        if proc.next_ephemeral_port == 0 {
            proc.next_ephemeral_port = 49152;
        }
    }

    let client = proc.sockets.get_mut(sock_idx).ok_or(Errno::EBADF)?;
    client.send_buf_idx = Some(pipe_a_idx);
    client.recv_buf_idx = Some(pipe_b_idx);
    client.state = SocketState::Connected;
    client.peer_addr = ip;
    client.peer_port = port;
    client.global_pipes = true; // pipes are in global pipe table
    if client.bind_port == 0 {
        client.bind_port = client_port;
        client.bind_addr = [127, 0, 0, 1];
    }

    // Push the connection metadata to the listener's shared accept queue.
    // The accepting process (any of the listener's fork-inherited copies)
    // creates its own accepted SocketInfo lazily in sys_accept.
    let listener_proc = table.get_mut(listener_pid).ok_or(Errno::ESRCH)?;
    let listener_sock = listener_proc
        .sockets
        .get(listener_sock_idx)
        .ok_or(Errno::ECONNREFUSED)?;
    let shared_idx = listener_sock
        .shared_backlog_idx
        .ok_or(Errno::ECONNREFUSED)?;
    let accept_wake_idx = listener_sock.accept_wake_idx;

    let pc = crate::socket::PendingConnection {
        peer_addr: client_addr,
        peer_addr6: [0; 16],
        peer_is_ipv6: false,
        peer_port: client_port,
        peer_pid: 0,
        peer_sock_idx: None,
        recv_pipe_idx: pipe_a_idx, // server reads client's writes
        send_pipe_idx: pipe_b_idx, // server writes to client's reads
    };
    if !unsafe { crate::socket::shared_listener_backlog_table().push(shared_idx, pc) } {
        return Err(Errno::ECONNREFUSED);
    }

    if let Some(idx) = accept_wake_idx {
        crate::wakeup::push_accept(idx);
    }

    Ok(())
}

/// Cross-process AF_INET6 loopback connect. The listener's shared backlog
/// carries a native IPv6 peer address so accept/getpeername retain the family
/// and do not collapse the connection onto the IPv4 host bridge.
fn cross_process_loopback_connect6(
    table: &mut crate::process_table::ProcessTable,
    my_pid: u32,
    fd: i32,
    addr: &[u8],
) -> Result<(), Errno> {
    use crate::pipe::PipeBuffer;
    use crate::socket::{SocketDomain, SocketState, SocketType};

    let port = u16::from_be_bytes([addr[2], addr[3]]);
    let mut ip = [0u8; 16];
    ip.copy_from_slice(&addr[8..24]);
    let loopback = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1];
    if ip == [0; 16] {
        ip = loopback;
    }
    if ip != loopback {
        return Err(Errno::ECONNREFUSED);
    }

    let sock_idx = {
        let proc = table.get(my_pid).ok_or(Errno::ESRCH)?;
        let ofd_idx = syscalls::resolve_io_ofd(proc, fd)?;
        let ofd = proc.ofd_table.get(ofd_idx).ok_or(Errno::EBADF)?;
        if ofd.file_type != FileType::Socket {
            return Err(Errno::ENOTSOCK);
        }
        let sock_idx = (-(ofd.host_handle + 1)) as usize;
        let client_sock = proc.sockets.get(sock_idx).ok_or(Errno::EBADF)?;
        if client_sock.domain != SocketDomain::Inet6 || client_sock.sock_type != SocketType::Stream
        {
            return Err(Errno::ECONNREFUSED);
        }
        sock_idx
    };
    let mut listener = None;
    for (pid, target_proc) in table.live_processes_descending() {
        if pid == my_pid {
            continue;
        }
        for idx in 0..target_proc.sockets.len() {
            let Some(sock) = target_proc.sockets.get(idx) else {
                continue;
            };
            if sock.domain == SocketDomain::Inet6
                && sock.sock_type == SocketType::Stream
                && sock.state == SocketState::Listening
                && sock.bind_port == port
                && (sock.bind_addr6 == [0; 16] || sock.bind_addr6 == ip)
            {
                listener = Some((pid, idx));
                break;
            }
        }
        if listener.is_some() {
            break;
        }
    }
    let (listener_pid, listener_sock_idx) = listener.ok_or(Errno::ECONNREFUSED)?;

    let pipe_table = unsafe { crate::pipe::global_pipe_table() };
    let pipe_a_idx = pipe_table.alloc(PipeBuffer::new(65536));
    let pipe_b_idx = pipe_table.alloc(PipeBuffer::new(65536));

    let client_proc = table.get_mut(my_pid).ok_or(Errno::ESRCH)?;
    let client_sock = client_proc.sockets.get(sock_idx).ok_or(Errno::EBADF)?;
    let client_addr6 = if client_sock.bind_addr6 == [0; 16] {
        loopback
    } else {
        client_sock.bind_addr6
    };
    let mut client_port = client_sock.bind_port;
    if client_port == 0 {
        client_port = client_proc.next_ephemeral_port;
        client_proc.next_ephemeral_port = client_proc.next_ephemeral_port.wrapping_add(1);
        if client_proc.next_ephemeral_port == 0 {
            client_proc.next_ephemeral_port = 49152;
        }
    }
    let client = client_proc.sockets.get_mut(sock_idx).ok_or(Errno::EBADF)?;
    client.send_buf_idx = Some(pipe_a_idx);
    client.recv_buf_idx = Some(pipe_b_idx);
    client.state = SocketState::Connected;
    client.peer_addr6 = ip;
    client.peer_port = port;
    client.global_pipes = true;
    if client.bind_port == 0 {
        client.bind_addr6 = loopback;
        client.bind_port = client_port;
    }

    let listener_proc = table.get_mut(listener_pid).ok_or(Errno::ESRCH)?;
    let listener_sock = listener_proc
        .sockets
        .get(listener_sock_idx)
        .ok_or(Errno::ECONNREFUSED)?;
    let shared_idx = listener_sock
        .shared_backlog_idx
        .ok_or(Errno::ECONNREFUSED)?;
    let accept_wake_idx = listener_sock.accept_wake_idx;
    let pending = crate::socket::PendingConnection {
        peer_addr: [0; 4],
        peer_addr6: client_addr6,
        peer_is_ipv6: true,
        peer_port: client_port,
        peer_pid: 0,
        peer_sock_idx: None,
        recv_pipe_idx: pipe_a_idx,
        send_pipe_idx: pipe_b_idx,
    };
    if !unsafe { crate::socket::shared_listener_backlog_table().push(shared_idx, pending) } {
        return Err(Errno::ECONNREFUSED);
    }
    if let Some(idx) = accept_wake_idx {
        crate::wakeup::push_accept(idx);
    }
    Ok(())
}

/// Cross-process AF_UNIX connect.
///
/// Looks up the target path in the global UnixSocketRegistry, then creates
/// global pipe pairs to connect the client (current process) to the listener
/// (possibly in a different process).
fn cross_process_unix_connect(
    table: &mut crate::process_table::ProcessTable,
    my_pid: u32,
    host: &mut dyn HostIO,
    fd: i32,
    addr: &[u8],
) -> Result<(), Errno> {
    use crate::pipe::PipeBuffer;
    use crate::socket::{SocketDomain, SocketState, SocketType};

    // sys_connect already validated this address before the cross-process
    // fallback, but retain the family-specific bound at this second parser.
    let path_bytes = syscalls::checked_sockaddr_un_path(addr)?;
    let (resolved, sock_idx) = {
        let proc = table.get_mut(my_pid).ok_or(Errno::ESRCH)?;
        let resolved = if path_bytes.first().copied() == Some(0) {
            if path_bytes.len() < 2 {
                return Err(Errno::ECONNREFUSED);
            }
            path_bytes.to_vec()
        } else {
            let path_end = path_bytes
                .iter()
                .position(|&b| b == 0)
                .unwrap_or(path_bytes.len());
            if path_end == 0 {
                return Err(Errno::ECONNREFUSED);
            }
            syscalls::resolve_existing_namespace_path(proc, host, &path_bytes[..path_end])?
        };

        // Only AF_UNIX stream sockets can enter the cross-process stream-pipe
        // connection path. In particular, never reinterpret a datagram socket
        // as a stream merely because its registry lookup found another process.
        let ofd_idx = syscalls::resolve_io_ofd(proc, fd)?;
        let ofd = proc.ofd_table.get(ofd_idx).ok_or(Errno::EBADF)?;
        if ofd.file_type != FileType::Socket {
            return Err(Errno::ENOTSOCK);
        }
        let sock_idx = (-(ofd.host_handle + 1)) as usize;
        let client = proc.sockets.get(sock_idx).ok_or(Errno::EBADF)?;
        // sys_connect already returned ECONNREFUSED for this attempt. Datagram
        // routing is deliberately not retried through the stream-only path.
        if client.domain == SocketDomain::Unix && client.sock_type == SocketType::Dgram {
            return Err(Errno::ECONNREFUSED);
        }
        if client.domain != SocketDomain::Unix || client.sock_type != SocketType::Stream {
            return Err(Errno::EPROTOTYPE);
        }
        (resolved, sock_idx)
    };

    // Look up in global registry
    let registry = unsafe { crate::unix_socket::global_unix_socket_registry() };
    let entry = registry.lookup(&resolved).ok_or(Errno::ECONNREFUSED)?;
    let listener_pid = entry.pid;
    let listener_sock_idx = entry.sock_idx;

    // Verify listener exists and is listening
    let listener_proc = table.get_mut(listener_pid).ok_or(Errno::ECONNREFUSED)?;
    let listener = listener_proc
        .sockets
        .get(listener_sock_idx)
        .ok_or(Errno::ECONNREFUSED)?;
    if listener.domain != SocketDomain::Unix
        || listener.sock_type != SocketType::Stream
        || listener.state != SocketState::Listening
    {
        return Err(Errno::ECONNREFUSED);
    }
    let shared_idx = listener.shared_backlog_idx.ok_or(Errno::ECONNREFUSED)?;
    let accept_wake_idx = listener.accept_wake_idx;

    // Allocate pipes only after both endpoints have been validated, so a
    // stale or wrong-type registry entry cannot leak global pipe slots.
    let pipe_table = unsafe { crate::pipe::global_pipe_table() };
    let pipe_a_idx = pipe_table.alloc(PipeBuffer::new(65536));
    let pipe_b_idx = pipe_table.alloc(PipeBuffer::new(65536));

    let pending = crate::socket::PendingConnection {
        peer_addr: [0; 4],
        peer_addr6: [0; 16],
        peer_is_ipv6: false,
        peer_port: 0,
        peer_pid: my_pid,
        peer_sock_idx: Some(sock_idx),
        recv_pipe_idx: pipe_a_idx,
        send_pipe_idx: pipe_b_idx,
    };
    if !unsafe { crate::socket::shared_listener_backlog_table().push(shared_idx, pending) } {
        pipe_table.discard_unclaimed(pipe_a_idx);
        pipe_table.discard_unclaimed(pipe_b_idx);
        return Err(Errno::ECONNREFUSED);
    }

    // Set up client socket (in current process)
    let client_proc = table.get_mut(my_pid).ok_or(Errno::ESRCH)?;
    let client = client_proc.sockets.get_mut(sock_idx).ok_or(Errno::EBADF)?;
    client.send_buf_idx = Some(pipe_a_idx);
    client.recv_buf_idx = Some(pipe_b_idx);
    client.state = SocketState::Connected;
    client.peer_idx = None;
    client.global_pipes = true;

    if let Some(idx) = accept_wake_idx {
        crate::wakeup::push_accept(idx);
    }

    Ok(())
}

/// Finish a machine-local IPv4 UDP send after all direct references into the
/// process table have reached their last use.
///
/// WHY: `get_process*()` returns mutable references backed by the global
/// `UnsafeCell`. Re-entering `PROCESS_TABLE` while one of those references is
/// still live could alias the sender. Callers therefore capture only an owned
/// route, finish retry/signal cleanup, and invoke this helper last.
fn complete_cross_process_loopback_udp(
    route: Option<syscalls::CrossProcessLoopbackUdpRoute>,
    data: &[u8],
) {
    let Some(route) = route else {
        return;
    };
    let table = unsafe { &mut *PROCESS_TABLE.0.get() };
    syscalls::deliver_cross_process_loopback_udp(table, route, data);
}

#[cfg(test)]
mod socket_wrapper_tests {
    use super::{cross_process_unix_connect, write_getsockopt_bytes, WasmHostIO};
    use crate::errno::Errno;
    use crate::fd::OpenFileDescRef;
    use crate::ofd::FileType;
    use crate::process_table::ProcessTable;
    use crate::socket::{SocketDomain, SocketInfo, SocketType};
    use wasm_posix_shared::flags::O_RDWR;

    #[test]
    fn unix_datagram_cross_process_retry_preserves_connrefused() {
        let mut table = ProcessTable::new();
        let pid = table.create_process().unwrap();
        let fd = {
            let proc = table.get_mut(pid).unwrap();
            let sock_idx =
                proc.sockets
                    .alloc(SocketInfo::new(SocketDomain::Unix, SocketType::Dgram, 0));
            let ofd_idx = proc.ofd_table.create(
                FileType::Socket,
                O_RDWR,
                -((sock_idx as i64) + 1),
                b"/dev/socket".to_vec(),
            );
            proc.fd_table.alloc(OpenFileDescRef(ofd_idx), 0).unwrap()
        };
        // Abstract names do not touch HostIO, which keeps this wrapper test
        // focused on the retry's socket-type guard.
        let addr = [1, 0, 0, b'm', b'i', b's', b's'];
        let mut host = WasmHostIO;

        assert_eq!(
            cross_process_unix_connect(&mut table, pid, &mut host, fd, &addr),
            Err(Errno::ECONNREFUSED),
        );
    }

    #[test]
    fn getsockopt_copy_honors_short_and_unaligned_lengths() {
        let mut out = [0xaau8; 4];
        let mut length = 2u32;
        write_getsockopt_bytes(out.as_mut_ptr(), &mut length, &[1, 2, 3, 4]).unwrap();
        assert_eq!(out, [1, 2, 0xaa, 0xaa]);
        assert_eq!(length, 2);

        let mut unaligned_storage = [0u8; 5];
        unaligned_storage[1..5].copy_from_slice(&3u32.to_ne_bytes());
        let unaligned_length = unsafe { unaligned_storage.as_mut_ptr().add(1).cast::<u32>() };
        write_getsockopt_bytes(out.as_mut_ptr(), unaligned_length, &[5, 6, 7, 8]).unwrap();
        assert_eq!(&out[..3], &[5, 6, 7]);
        assert_eq!(&unaligned_storage[1..5], &3u32.to_ne_bytes());
    }

    #[test]
    fn getsockopt_copy_rejects_null_guest_pointers() {
        let mut out = [0u8; 4];
        let mut length = 4u32;
        assert_eq!(
            write_getsockopt_bytes(core::ptr::null_mut(), &mut length, &[1, 2, 3, 4]),
            Err(Errno::EFAULT),
        );
        assert_eq!(
            write_getsockopt_bytes(out.as_mut_ptr(), core::ptr::null_mut(), &[1, 2, 3, 4]),
            Err(Errno::EFAULT),
        );
    }
}

/// Send data on a socket. Returns bytes sent or negative errno.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_send(fd: i32, buf_ptr: *const u8, buf_len: u32, flags: u32) -> i32 {
    let (_gkl, proc, advisory_locks) = unsafe { get_process_and_advisory_locks() };
    let mut host = WasmHostIO;
    let buf = unsafe { slice::from_raw_parts(buf_ptr, buf_len as usize) };
    let result = match syscalls::sys_send(proc, &mut host, fd, buf, flags) {
        Ok(n) => n as i32,
        Err(e) => -(e as i32),
    };
    let cross_process_udp = (result >= 0)
        .then(|| syscalls::cross_process_loopback_udp_route(proc, fd, None))
        .flatten();
    deliver_pending_signals_with_locks(proc, advisory_locks, &mut host);
    complete_cross_process_loopback_udp(cross_process_udp, buf);
    result
}

/// Receive data from a socket. Returns bytes received or negative errno.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_recv(fd: i32, buf_ptr: *mut u8, buf_len: u32, flags: u32) -> i32 {
    let (_gkl, proc, advisory_locks) = unsafe { get_process_and_advisory_locks() };
    let mut host = WasmHostIO;
    // WHY: a zero-length receive has no destination bytes. Avoid imposing
    // Rust's non-null raw-slice requirement on its semantically unused pointer.
    let buf = if buf_len == 0 {
        &mut []
    } else {
        unsafe { slice::from_raw_parts_mut(buf_ptr, buf_len as usize) }
    };
    let result = match syscalls::sys_recv(proc, &mut host, fd, buf, flags) {
        Ok(n) => n as i32,
        Err(e) => -(e as i32),
    };
    syscalls::finish_scm_rights_cleanup(advisory_locks, &mut host);
    deliver_pending_signals_with_locks(proc, advisory_locks, &mut host);
    result
}

/// Shut down a socket. Returns 0 on success, negative errno on error.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_shutdown(fd: i32, how: u32) -> i32 {
    let (_gkl, proc, advisory_locks) = unsafe { get_process_and_advisory_locks() };
    let mut host = WasmHostIO;
    let result = match syscalls::sys_shutdown(proc, &mut host, fd, how) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    };
    syscalls::finish_scm_rights_cleanup(advisory_locks, &mut host);
    deliver_pending_signals_with_locks(proc, advisory_locks, &mut host);
    result
}

/// Copy a socket option to the caller without exceeding its guest buffer.
///
/// `optlen` is a value-result parameter: the input bounds the copy and the
/// output reports the number of bytes actually copied, including truncation.
/// Both pointers are required for these option shapes.
fn write_getsockopt_bytes(
    optval_ptr: *mut u8,
    optval_capacity: u32,
    optlen_ptr: *mut u32,
    optlen_capacity: u32,
    value: &[u8],
) -> Result<(), Errno> {
    if optval_ptr.is_null() || optlen_ptr.is_null() {
        return Err(Errno::EFAULT);
    }
    if optlen_capacity != wasm_posix_shared::kernel_scratch_wire::SOCKLEN_BYTES {
        return Err(Errno::EINVAL);
    }

    let available = unsafe { core::ptr::read_unaligned(optlen_ptr) as usize };
    if available > optval_capacity as usize {
        return Err(Errno::EFAULT);
    }
    let write_len = available.min(value.len());
    if write_len > 0 {
        let out = unsafe { slice::from_raw_parts_mut(optval_ptr, write_len) };
        out.copy_from_slice(&value[..write_len]);
    }
    unsafe { core::ptr::write_unaligned(optlen_ptr, write_len as u32) };
    Ok(())
}

/// Get socket option. Returns 0 on success, negative errno on error.
/// Writes the option value to optval_ptr. optlen_ptr points to buffer size
/// on input, receives actual written size on output.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_getsockopt(
    fd: i32,
    level: u32,
    optname: u32,
    optval_ptr: *mut u8,
    optval_capacity: u32,
    optlen_ptr: *mut u32,
    optlen_capacity: u32,
) -> i32 {
    use wasm_posix_shared::socket::*;
    let (_gkl, proc, advisory_locks) = unsafe { get_process_and_advisory_locks() };

    // Handle struct tcp_info (TCP_INFO)
    if level == IPPROTO_TCP && optname == TCP_INFO {
        let result = match syscalls::sys_getsockopt_tcp_info(proc, fd) {
            Ok(info_buf) => match write_getsockopt_bytes(
                optval_ptr,
                optval_capacity,
                optlen_ptr,
                optlen_capacity,
                &info_buf,
            ) {
                Ok(()) => 0,
                Err(e) => -(e as i32),
            },
            Err(e) => -(e as i32),
        };
        let mut host = WasmHostIO;
        deliver_pending_signals_with_locks(proc, advisory_locks, &mut host);
        return result;
    }

    // Handle struct linger (SO_LINGER).
    if level == SOL_SOCKET && optname == SO_LINGER {
        let result = match syscalls::sys_getsockopt_linger(proc, fd) {
            Ok((l_onoff, l_linger)) => {
                let mut tmp = [0u8; 8];
                tmp[0..4].copy_from_slice(&l_onoff.to_le_bytes());
                tmp[4..8].copy_from_slice(&l_linger.to_le_bytes());
                match write_getsockopt_bytes(
                    optval_ptr,
                    optval_capacity,
                    optlen_ptr,
                    optlen_capacity,
                    &tmp,
                ) {
                    Ok(()) => 0,
                    Err(e) => -(e as i32),
                }
            }
            Err(e) => -(e as i32),
        };
        let mut host = WasmHostIO;
        deliver_pending_signals_with_locks(proc, advisory_locks, &mut host);
        return result;
    }

    // Handle string-valued SO_BINDTODEVICE.
    if level == SOL_SOCKET && optname == SO_BINDTODEVICE {
        let result = match syscalls::sys_getsockopt_bindtodevice(proc, fd) {
            Ok(name) => {
                let mut value = name;
                if !value.is_empty() {
                    value.push(0);
                }
                match write_getsockopt_bytes(
                    optval_ptr,
                    optval_capacity,
                    optlen_ptr,
                    optlen_capacity,
                    &value,
                ) {
                    Ok(()) => 0,
                    Err(e) => -(e as i32),
                }
            }
            Err(e) => -(e as i32),
        };
        let mut host = WasmHostIO;
        deliver_pending_signals_with_locks(proc, advisory_locks, &mut host);
        return result;
    }

    // Handle string-valued TCP_CONGESTION.
    if level == IPPROTO_TCP && optname == TCP_CONGESTION {
        let result = match syscalls::sys_getsockopt_tcp_congestion(proc, fd) {
            Ok(mut name) => {
                name.push(0);
                match write_getsockopt_bytes(
                    optval_ptr,
                    optval_capacity,
                    optlen_ptr,
                    optlen_capacity,
                    &name,
                ) {
                    Ok(()) => 0,
                    Err(e) => -(e as i32),
                }
            }
            Err(e) => -(e as i32),
        };
        let mut host = WasmHostIO;
        deliver_pending_signals_with_locks(proc, advisory_locks, &mut host);
        return result;
    }

    // Handle struct timeval options (SO_RCVTIMEO, SO_SNDTIMEO), accepting
    // both musl's wasm32 time64 and wasm64 long64 option numbers.
    if let Some(timeout_optname) = syscalls::canonical_socket_timeout_optname(level, optname) {
        let result = match syscalls::sys_getsockopt_timeout(proc, fd, timeout_optname) {
            Ok(timeout_us) => {
                let tv_sec = (timeout_us / 1_000_000) as i64;
                let tv_usec = (timeout_us % 1_000_000) as i64;
                let mut value = [0u8; 16];
                value[0..8].copy_from_slice(&tv_sec.to_le_bytes());
                value[8..16].copy_from_slice(&tv_usec.to_le_bytes());
                match write_getsockopt_bytes(
                    optval_ptr,
                    optval_capacity,
                    optlen_ptr,
                    optlen_capacity,
                    &value,
                ) {
                    Ok(()) => 0,
                    Err(e) => -(e as i32),
                }
            }
            Err(e) => -(e as i32),
        };
        let mut host = WasmHostIO;
        deliver_pending_signals_with_locks(proc, advisory_locks, &mut host);
        return result;
    }

    let result = match syscalls::sys_getsockopt(proc, fd, level, optname) {
        Ok(val) => match write_getsockopt_bytes(
            optval_ptr,
            optval_capacity,
            optlen_ptr,
            optlen_capacity,
            &val.to_le_bytes(),
        ) {
            Ok(()) => 0,
            Err(e) => -(e as i32),
        },
        Err(e) => -(e as i32),
    };
    let mut host = WasmHostIO;
    deliver_pending_signals_with_locks(proc, advisory_locks, &mut host);
    result
}

/// Set socket option. Returns 0 on success, negative errno on error.
/// optval_ptr points to the option value buffer, optlen is its size.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_setsockopt(
    fd: i32,
    level: u32,
    optname: u32,
    optval_ptr: *const u8,
    optlen: u32,
) -> i32 {
    kernel_setsockopt_for_process_width(
        fd,
        level,
        optname,
        optval_ptr,
        optlen,
        size_of::<usize>() as u32,
    )
}

fn kernel_setsockopt_for_process_width(
    fd: i32,
    level: u32,
    optname: u32,
    optval_ptr: *const u8,
    optlen: u32,
    process_pointer_width: u32,
) -> i32 {
    use wasm_posix_shared::socket::*;
    if !matches!(
        process_pointer_width,
        wasm_posix_shared::process_layout::WASM32_POINTER_WIDTH
            | wasm_posix_shared::process_layout::WASM64_POINTER_WIDTH
    ) {
        return -(Errno::EINVAL as i32);
    }
    let (_gkl, proc, advisory_locks) = unsafe { get_process_and_advisory_locks() };

    // Handle struct timeval options (SO_RCVTIMEO, SO_SNDTIMEO).
    // Both supported ABIs use two 64-bit fields here: wasm32 uses time64,
    // while wasm64 uses native 64-bit long. Their option numbers differ.
    if let Some(timeout_optname) = syscalls::canonical_socket_timeout_optname(level, optname) {
        if optval_ptr.is_null() || optlen < 16 {
            let mut host = WasmHostIO;
            deliver_pending_signals_with_locks(proc, advisory_locks, &mut host);
            return -(Errno::EINVAL as i32);
        }
        let buf = unsafe { slice::from_raw_parts(optval_ptr, 16) };
        let tv_sec = i64::from_le_bytes(buf[0..8].try_into().unwrap());
        let tv_usec = i64::from_le_bytes(buf[8..16].try_into().unwrap());
        if tv_sec < 0 || tv_usec < 0 || tv_usec >= 1_000_000 {
            let mut host = WasmHostIO;
            deliver_pending_signals_with_locks(proc, advisory_locks, &mut host);
            return -(Errno::EINVAL as i32);
        }
        let timeout_us = (tv_sec as u64) * 1_000_000 + (tv_usec as u64);
        let result = match syscalls::sys_setsockopt_timeout(proc, fd, timeout_optname, timeout_us) {
            Ok(()) => 0,
            Err(e) => -(e as i32),
        };
        let mut host = WasmHostIO;
        deliver_pending_signals_with_locks(proc, advisory_locks, &mut host);
        return result;
    }

    // Handle struct linger (SO_LINGER).
    if level == SOL_SOCKET && optname == SO_LINGER {
        if optval_ptr.is_null() || optlen < 8 {
            let mut host = WasmHostIO;
            deliver_pending_signals_with_locks(proc, advisory_locks, &mut host);
            return -(Errno::EINVAL as i32);
        }
        let buf = unsafe { slice::from_raw_parts(optval_ptr, 8) };
        let l_onoff = i32::from_le_bytes(buf[0..4].try_into().unwrap());
        let l_linger = i32::from_le_bytes(buf[4..8].try_into().unwrap());
        let result = match syscalls::sys_setsockopt_linger(proc, fd, l_onoff, l_linger) {
            Ok(()) => 0,
            Err(e) => -(e as i32),
        };
        let mut host = WasmHostIO;
        deliver_pending_signals_with_locks(proc, advisory_locks, &mut host);
        return result;
    }

    // Handle string-valued SO_BINDTODEVICE.
    if level == SOL_SOCKET && optname == SO_BINDTODEVICE {
        if optval_ptr.is_null() {
            let mut host = WasmHostIO;
            deliver_pending_signals_with_locks(proc, advisory_locks, &mut host);
            return -(Errno::EFAULT as i32);
        }
        let buf = unsafe { slice::from_raw_parts(optval_ptr, optlen as usize) };
        let result = match syscalls::sys_setsockopt_bindtodevice(proc, fd, buf) {
            Ok(()) => 0,
            Err(e) => -(e as i32),
        };
        let mut host = WasmHostIO;
        deliver_pending_signals_with_locks(proc, advisory_locks, &mut host);
        return result;
    }

    // Handle string-valued TCP_CONGESTION.
    if level == IPPROTO_TCP && optname == TCP_CONGESTION {
        if optval_ptr.is_null() {
            let mut host = WasmHostIO;
            deliver_pending_signals_with_locks(proc, advisory_locks, &mut host);
            return -(Errno::EFAULT as i32);
        }
        let buf = unsafe { slice::from_raw_parts(optval_ptr, optlen as usize) };
        let result = match syscalls::sys_setsockopt_tcp_congestion(proc, fd, buf) {
            Ok(()) => 0,
            Err(e) => -(e as i32),
        };
        let mut host = WasmHostIO;
        deliver_pending_signals_with_locks(proc, advisory_locks, &mut host);
        return result;
    }

    // Handle IPv4 multicast membership/source-filter options. These options
    // carry struct ip_mreq/ip_mreq_source/group_req/group_source_req payloads,
    // not plain integers, so the wrapper must parse the guest ABI buffer.
    if level == IPPROTO_IP
        && matches!(
            optname,
            IP_ADD_MEMBERSHIP
                | IP_DROP_MEMBERSHIP
                | IP_BLOCK_SOURCE
                | IP_UNBLOCK_SOURCE
                | IP_ADD_SOURCE_MEMBERSHIP
                | IP_DROP_SOURCE_MEMBERSHIP
                | MCAST_JOIN_GROUP
                | MCAST_LEAVE_GROUP
                | MCAST_BLOCK_SOURCE
                | MCAST_UNBLOCK_SOURCE
                | MCAST_JOIN_SOURCE_GROUP
                | MCAST_LEAVE_SOURCE_GROUP
        )
    {
        if optval_ptr.is_null() {
            let mut host = WasmHostIO;
            deliver_pending_signals_with_locks(proc, advisory_locks, &mut host);
            return -(Errno::EFAULT as i32);
        }
        let buf = unsafe { slice::from_raw_parts(optval_ptr, optlen as usize) };

        let parsed =
            syscalls::parse_ipv4_multicast_request(buf, optname, process_pointer_width);

        let result = match parsed.and_then(|(group, interface_addr, source)| {
            syscalls::sys_setsockopt_ipv4_multicast(
                proc,
                fd,
                optname,
                group,
                interface_addr,
                source,
            )
        }) {
            Ok(()) => 0,
            Err(e) => -(e as i32),
        };
        let mut host = WasmHostIO;
        deliver_pending_signals_with_locks(proc, advisory_locks, &mut host);
        return result;
    }
    // Read first 4 bytes as u32 value (covers most int-valued options)
    let optval = if !optval_ptr.is_null() && optlen >= 4 {
        let buf = unsafe { slice::from_raw_parts(optval_ptr, 4) };
        u32::from_le_bytes(buf.try_into().unwrap())
    } else if !optval_ptr.is_null() && optlen > 0 {
        // For options smaller than 4 bytes, read what we have
        let buf = unsafe { slice::from_raw_parts(optval_ptr, optlen as usize) };
        let mut val_bytes = [0u8; 4];
        val_bytes[..optlen as usize].copy_from_slice(buf);
        u32::from_le_bytes(val_bytes)
    } else {
        0
    };
    let result = match syscalls::sys_setsockopt(proc, fd, level, optname, optval) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    };
    let mut host = WasmHostIO;
    deliver_pending_signals_with_locks(proc, advisory_locks, &mut host);
    result
}

/// Poll file descriptors. Returns number of ready fds, or negative errno.
/// fds_ptr points to an array of WasmPollFd structs (8 bytes each: i32 fd, i16 events, i16 revents).
#[unsafe(no_mangle)]
pub extern "C" fn kernel_poll(fds_ptr: *mut u8, fds_capacity: u32, nfds: u32, timeout: i32) -> i32 {
    let Some(required_capacity) =
        nfds.checked_mul(core::mem::size_of::<wasm_posix_shared::WasmPollFd>() as u32)
    else {
        return -(Errno::EOVERFLOW as i32);
    };
    if fds_capacity != required_capacity {
        return -(Errno::EINVAL as i32);
    }
    if fds_ptr.is_null() {
        return -(Errno::EFAULT as i32);
    }
    if (fds_ptr as usize) % core::mem::align_of::<wasm_posix_shared::WasmPollFd>() != 0 {
        return -(Errno::EFAULT as i32);
    }
    let (_gkl, proc, advisory_locks) = unsafe { get_process_and_advisory_locks() };
    let fds = unsafe {
        slice::from_raw_parts_mut(fds_ptr as *mut wasm_posix_shared::WasmPollFd, nfds as usize)
    };
    let mut host = WasmHostIO;
    let result = match syscalls::sys_poll(proc, &mut host, fds, timeout) {
        Ok(n) => n,
        Err(e) => -(e as i32),
    };
    deliver_pending_signals_with_locks(proc, advisory_locks, &mut host);
    result
}

/// Send data to a specific address. Returns bytes sent or negative errno.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_sendto(
    fd: i32,
    buf_ptr: *const u8,
    buf_len: u32,
    flags: u32,
    addr_ptr: *const u8,
    addr_len: u32,
) -> i32 {
    let (_gkl, proc, advisory_locks) = unsafe { get_process_and_advisory_locks() };
    let mut host = WasmHostIO;
    let buf = unsafe { slice::from_raw_parts(buf_ptr, buf_len as usize) };
    let addr = if addr_ptr.is_null() || addr_len == 0 {
        &[]
    } else {
        unsafe { slice::from_raw_parts(addr_ptr, addr_len as usize) }
    };
    let result = match syscalls::sys_sendto(proc, &mut host, fd, buf, flags, addr) {
        Ok(n) => n as i32,
        Err(e) => -(e as i32),
    };
    let cross_process_udp = (result >= 0)
        .then(|| {
            syscalls::cross_process_loopback_udp_route(
                proc,
                fd,
                (!addr.is_empty()).then_some(addr),
            )
        })
        .flatten();
    deliver_pending_signals_with_locks(proc, advisory_locks, &mut host);
    complete_cross_process_loopback_udp(cross_process_udp, buf);
    result
}

/// Receive data with sender address. Returns bytes received or negative errno.
/// Writes sender address to addr_ptr and address length to addr_len_ptr.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_recvfrom(
    fd: i32,
    buf_ptr: *mut u8,
    buf_len: u32,
    flags: u32,
    addr_ptr: *mut u8,
    addrlen_ptr: *mut u32,
) -> i32 {
    let (_gkl, proc, advisory_locks) = unsafe { get_process_and_advisory_locks() };
    let mut host = WasmHostIO;
    // WHY: a zero-length receive has no destination bytes. Avoid imposing
    // Rust's non-null raw-slice requirement on its semantically unused pointer.
    let buf = if buf_len == 0 {
        &mut []
    } else {
        unsafe { slice::from_raw_parts_mut(buf_ptr, buf_len as usize) }
    };
    let address_requested = syscalls::validate_optional_socket_address_output(
        !addr_ptr.is_null(),
        !addrlen_ptr.is_null(),
    );
    let result = match address_requested {
        Err(error) => -(error as i32),
        Ok(address_requested) => {
            // addrlen_ptr is a channel-rewritten pointer only for an active
            // address result. A caller may supply arbitrary ignored bits when
            // addr_ptr is null.
            let addr_len = if address_requested {
                unsafe { *addrlen_ptr }
            } else {
                0
            };
            let addr_buf = if addr_len > 0 {
                unsafe { slice::from_raw_parts_mut(addr_ptr, addr_len as usize) }
            } else {
                &mut []
            };
            match syscalls::sys_recvfrom(proc, &mut host, fd, buf, flags, addr_buf) {
                Ok((n, actual_addr_len)) => {
                    if address_requested {
                        unsafe {
                            *addrlen_ptr = actual_addr_len as u32;
                        }
                    }
                    n as i32
                }
                Err(e) => -(e as i32),
            }
        }
    };
    syscalls::drain_deferred_scm_rights_releases(advisory_locks, &mut host);
    deliver_pending_signals_with_locks(proc, advisory_locks, &mut host);
    result
}

/// time() - returns seconds since epoch as i64.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_time() -> i64 {
    let (_gkl, proc, advisory_locks) = unsafe { get_process_and_advisory_locks() };
    let mut host = WasmHostIO;
    let result = match syscalls::sys_time(proc, &mut host) {
        Ok(t) => t,
        Err(e) => -(e as i64),
    };
    deliver_pending_signals_with_locks(proc, advisory_locks, &mut host);
    result
}

/// gettimeofday() - writes sec and usec to the given pointers.
/// Returns 0 on success, negative errno on error.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_gettimeofday(sec_ptr: *mut i64, usec_ptr: *mut i64) -> i32 {
    let (_gkl, proc, advisory_locks) = unsafe { get_process_and_advisory_locks() };
    let mut host = WasmHostIO;
    let result = match syscalls::sys_gettimeofday(proc, &mut host) {
        Ok((sec, usec)) => {
            unsafe {
                *sec_ptr = sec;
                *usec_ptr = usec;
            }
            0
        }
        Err(e) => -(e as i32),
    };
    deliver_pending_signals_with_locks(proc, advisory_locks, &mut host);
    result
}

/// usleep() - sleep for usec microseconds.
/// Returns 0 on success, negative errno on error.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_usleep(usec: u32) -> i32 {
    let (_gkl, proc, advisory_locks) = unsafe { get_process_and_advisory_locks() };
    let mut host = WasmHostIO;
    let result = match syscalls::sys_usleep(proc, &mut host, usec) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    };
    deliver_pending_signals_with_locks(proc, advisory_locks, &mut host);
    result
}

/// openat() - open relative to directory fd.
/// Returns fd on success, negative errno on error.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_openat(
    dirfd: i32,
    path_ptr: *const u8,
    path_len: u32,
    flags: u32,
    mode: u32,
) -> i32 {
    let (_gkl, proc, advisory_locks) = unsafe { get_process_and_advisory_locks() };
    let mut host = WasmHostIO;
    let path = unsafe { slice::from_raw_parts(path_ptr, path_len as usize) };
    let result = match syscalls::sys_openat(proc, &mut host, dirfd, path, flags, mode) {
        Ok(fd) => fd,
        Err(e) => -(e as i32),
    };
    deliver_pending_signals_with_locks(proc, advisory_locks, &mut host);
    result
}

/// fstatat() - stat relative to directory fd.
/// Returns 0 on success, negative errno on error.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_fstatat(
    dirfd: i32,
    path_ptr: *const u8,
    path_len: u32,
    stat_ptr: *mut u8,
    flags: u32,
) -> i32 {
    let (_gkl, proc, advisory_locks) = unsafe { get_process_and_advisory_locks() };
    let mut host = WasmHostIO;
    let path = unsafe { slice::from_raw_parts(path_ptr, path_len as usize) };
    let result = match syscalls::sys_fstatat(proc, &mut host, dirfd, path, flags) {
        Ok(stat) => match write_process_stat(stat_ptr, &stat) {
            Ok(()) => 0,
            Err(error) => -(error as i32),
        },
        Err(e) => -(e as i32),
    };
    deliver_pending_signals_with_locks(proc, advisory_locks, &mut host);
    result
}

/// unlinkat() - unlink relative to directory fd.
/// Returns 0 on success, negative errno on error.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_unlinkat(
    dirfd: i32,
    path_ptr: *const u8,
    path_len: u32,
    flags: u32,
) -> i32 {
    let (_gkl, proc, advisory_locks) = unsafe { get_process_and_advisory_locks() };
    let mut host = WasmHostIO;
    let path = unsafe { slice::from_raw_parts(path_ptr, path_len as usize) };
    let result = match syscalls::sys_unlinkat(proc, &mut host, dirfd, path, flags) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    };
    deliver_pending_signals_with_locks(proc, advisory_locks, &mut host);
    result
}

/// mkdirat() - mkdir relative to directory fd.
/// Returns 0 on success, negative errno on error.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_mkdirat(dirfd: i32, path_ptr: *const u8, path_len: u32, mode: u32) -> i32 {
    let (_gkl, proc, advisory_locks) = unsafe { get_process_and_advisory_locks() };
    let mut host = WasmHostIO;
    let path = unsafe { slice::from_raw_parts(path_ptr, path_len as usize) };
    let result = match syscalls::sys_mkdirat(proc, &mut host, dirfd, path, mode) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    };
    deliver_pending_signals_with_locks(proc, advisory_locks, &mut host);
    result
}

/// renameat() - rename relative to directory fds.
/// Returns 0 on success, negative errno on error.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_renameat(
    olddirfd: i32,
    old_ptr: *const u8,
    old_len: u32,
    newdirfd: i32,
    new_ptr: *const u8,
    new_len: u32,
) -> i32 {
    let (_gkl, proc, advisory_locks) = unsafe { get_process_and_advisory_locks() };
    let mut host = WasmHostIO;
    let oldpath = unsafe { slice::from_raw_parts(old_ptr, old_len as usize) };
    let newpath = unsafe { slice::from_raw_parts(new_ptr, new_len as usize) };
    let result = match syscalls::sys_renameat(proc, &mut host, olddirfd, oldpath, newdirfd, newpath)
    {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    };
    deliver_pending_signals_with_locks(proc, advisory_locks, &mut host);
    result
}

// ---------------------------------------------------------------------------
// Terminal / ioctl exports
// ---------------------------------------------------------------------------

/// Get terminal attributes. Returns 0 on success, or negative errno on error.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_tcgetattr(fd: i32, buf_ptr: *mut u8, buf_len: u32) -> i32 {
    if buf_len != wasm_posix_shared::ioctl_contract::TERMIOS_SIZE {
        return -(Errno::EINVAL as i32);
    }
    if buf_ptr.is_null() {
        return -(Errno::EFAULT as i32);
    }
    let (_gkl, proc, advisory_locks) = unsafe { get_process_and_advisory_locks() };
    let buf = unsafe { core::slice::from_raw_parts_mut(buf_ptr, buf_len as usize) };
    let result = match syscalls::sys_tcgetattr(proc, fd, buf) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    };
    let mut host = WasmHostIO;
    deliver_pending_signals_with_locks(proc, advisory_locks, &mut host);
    result
}

/// Set terminal attributes. Returns 0 on success, or negative errno on error.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_tcsetattr(fd: i32, action: u32, buf_ptr: *const u8, buf_len: u32) -> i32 {
    if buf_len != wasm_posix_shared::ioctl_contract::TERMIOS_SIZE {
        return -(Errno::EINVAL as i32);
    }
    if buf_ptr.is_null() {
        return -(Errno::EFAULT as i32);
    }
    let (_gkl, proc, advisory_locks) = unsafe { get_process_and_advisory_locks() };
    let buf = unsafe { core::slice::from_raw_parts(buf_ptr, buf_len as usize) };
    let result = match syscalls::sys_tcsetattr(proc, fd, action, buf) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    };
    let mut host = WasmHostIO;
    deliver_pending_signals_with_locks(proc, advisory_locks, &mut host);
    result
}

/// Perform an ioctl operation. Returns 0 on success, or negative errno on error.
///
/// `buf_len` is part of the request contract, not an allocation hint. The
/// process pointer width selects native request layouts such as drm_version.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_ioctl(
    fd: i32,
    request: u32,
    buf_ptr: *mut u8,
    buf_len: u32,
    process_pointer_width: u32,
) -> i32 {
    let (_gkl, proc, advisory_locks) = unsafe { get_process_and_advisory_locks() };
    let mut host = WasmHostIO;
    let result = match wasm_posix_shared::ioctl_contract::request_contract(request) {
        Some(contract) => (|| {
            let pointer_width = u8::try_from(process_pointer_width)
                .ok()
                .filter(|width| *width == 4 || *width == 8)
                .ok_or(Errno::EINVAL)?;
            let expected_size = contract
                .size_for_pointer_width(pointer_width)
                .ok_or(Errno::EOVERFLOW)?;
            use wasm_posix_shared::ioctl_contract::IoctlArgKind;
            match contract.arg_kind {
                IoctlArgKind::None => {
                    if buf_len != 0 {
                        Err(Errno::EINVAL)
                    } else {
                        syscalls::sys_ioctl(proc, &mut host, fd, request, &mut [])
                    }
                }
                IoctlArgKind::ScalarI32 => {
                    if buf_len != 0 {
                        Err(Errno::EINVAL)
                    } else {
                        // WHY: scalar ioctl arguments occupy the same channel
                        // slot as pointers. Decode the value without ever
                        // treating it as an address.
                        let mut scalar = (buf_ptr as usize as u32).to_le_bytes();
                        syscalls::sys_ioctl(proc, &mut host, fd, request, &mut scalar)
                    }
                }
                IoctlArgKind::Pointer => {
                    if buf_len != expected_size {
                        Err(Errno::EINVAL)
                    } else if buf_ptr.is_null() {
                        Err(Errno::EFAULT)
                    } else {
                        let buf = unsafe {
                            core::slice::from_raw_parts_mut(buf_ptr, expected_size as usize)
                        };
                        syscalls::sys_ioctl(proc, &mut host, fd, request, buf)
                    }
                }
            }
        })(),
        // Unknown requests stage no caller pointer. Let the fd/device path
        // choose EBADF/ENOTTY/ENOSYS using an empty slice.
        None => syscalls::sys_ioctl(proc, &mut host, fd, request, &mut []),
    };
    let result = match result {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    };
    deliver_pending_signals_with_locks(proc, advisory_locks, &mut host);
    result
}

/// prctl — process control. Returns 0 on success, or negative errno.
/// buf_ptr is used for PR_SET_NAME (read name from buf) and PR_GET_NAME (write name to buf).
#[unsafe(no_mangle)]
pub extern "C" fn kernel_prctl(option: u32, arg2: u32, _arg3: *mut u8, _arg4: u32) -> i32 {
    kernel_prctl_from_channel(option, arg2 as usize, _arg3, _arg4)
}

/// Channel dispatcher implementation with the complete target-width `arg2`
/// value retained for the PR_SET_NAME/PR_GET_NAME pointer cases.
fn kernel_prctl_from_channel(option: u32, arg2: usize, _arg3: *mut u8, _arg4: u32) -> i32 {
    use wasm_posix_shared::{kernel_scratch_wire, prctl};

    let (_gkl, proc, advisory_locks) = unsafe { get_process_and_advisory_locks() };
    // For the two thread-name operations, arg2 is the pointer to the
    // generated fixed-size name buffer. The other prctl args are
    // option-specific and may be garbage for options that don't use them.
    let is_name_operation = option == prctl::PR_SET_NAME || option == prctl::PR_GET_NAME;
    let buf = if is_name_operation && arg2 != 0 {
        unsafe {
            core::slice::from_raw_parts_mut(
                arg2 as *mut u8,
                kernel_scratch_wire::PRCTL_NAME_BYTES as usize,
            )
        }
    } else {
        &mut []
    };
    let result = match syscalls::sys_prctl(proc, option, arg2 as u32, buf) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    };
    let mut host = WasmHostIO;
    deliver_pending_signals_with_locks(proc, advisory_locks, &mut host);
    result
}

/// Set file creation mask. Returns the previous mask value.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_umask(mask: u32) -> u32 {
    let (_gkl, proc, advisory_locks) = unsafe { get_process_and_advisory_locks() };
    let result = syscalls::sys_umask(proc, mask);
    let mut host = WasmHostIO;
    deliver_pending_signals_with_locks(proc, advisory_locks, &mut host);
    result
}

/// Get system identification. Returns 0 on success, or negative errno on error.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_uname(buf_ptr: *mut u8, buf_len: u32) -> i32 {
    let (_gkl, proc, advisory_locks) = unsafe { get_process_and_advisory_locks() };
    let buf = unsafe { core::slice::from_raw_parts_mut(buf_ptr, buf_len as usize) };
    let result = match syscalls::sys_uname(buf) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    };
    let mut host = WasmHostIO;
    deliver_pending_signals_with_locks(proc, advisory_locks, &mut host);
    result
}

/// Get configurable system variables. Returns the value on success, or negative errno on error.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_sysconf(name: i32) -> i64 {
    let (_gkl, proc, advisory_locks) = unsafe { get_process_and_advisory_locks() };
    let result = match syscalls::sys_sysconf(name) {
        Ok(val) => val,
        Err(e) => -(e as i64),
    };
    let mut host = WasmHostIO;
    deliver_pending_signals_with_locks(proc, advisory_locks, &mut host);
    result
}

/// Truncate a file to a specified length. Returns 0 on success, or negative errno on error.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_ftruncate(fd: i32, length: i64) -> i32 {
    let (_gkl, proc, advisory_locks) = unsafe { get_process_and_advisory_locks() };
    let mut host = WasmHostIO;
    let result = match syscalls::sys_ftruncate(proc, &mut host, fd, length) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    };
    deliver_pending_signals_with_locks(proc, advisory_locks, &mut host);
    result
}

/// Synchronize file state to storage. Returns 0 on success, or negative errno on error.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_fsync(fd: i32) -> i32 {
    let (_gkl, proc, advisory_locks) = unsafe { get_process_and_advisory_locks() };
    let mut host = WasmHostIO;
    let result = match syscalls::sys_fsync(proc, &mut host, fd) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    };
    deliver_pending_signals_with_locks(proc, advisory_locks, &mut host);
    result
}

/// Truncate a file to a specified length (path-based). Returns 0 on success, or negative errno on error.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_truncate(path_ptr: *const u8, path_len: u32, length: i64) -> i32 {
    let (_gkl, proc, advisory_locks) = unsafe { get_process_and_advisory_locks() };
    let mut host = WasmHostIO;
    let path = unsafe { slice::from_raw_parts(path_ptr, path_len as usize) };
    let result = match syscalls::sys_truncate(proc, &mut host, path, length) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    };
    deliver_pending_signals_with_locks(proc, advisory_locks, &mut host);
    result
}

/// Synchronize file data to storage (alias for fsync). Returns 0 on success, or negative errno on error.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_fdatasync(fd: i32) -> i32 {
    let (_gkl, proc, advisory_locks) = unsafe { get_process_and_advisory_locks() };
    let mut host = WasmHostIO;
    let result = match syscalls::sys_fdatasync(proc, &mut host, fd) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    };
    deliver_pending_signals_with_locks(proc, advisory_locks, &mut host);
    result
}

/// Change file mode via file descriptor. Returns 0 on success, or negative errno on error.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_fchmod(fd: i32, mode: u32) -> i32 {
    let (_gkl, proc, advisory_locks) = unsafe { get_process_and_advisory_locks() };
    let mut host = WasmHostIO;
    let result = match syscalls::sys_fchmod(proc, &mut host, fd, mode) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    };
    deliver_pending_signals_with_locks(proc, advisory_locks, &mut host);
    result
}

/// Change file owner and group via file descriptor. Returns 0 on success, or negative errno on error.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_fchown(fd: i32, uid: u32, gid: u32) -> i32 {
    let (_gkl, proc, advisory_locks) = unsafe { get_process_and_advisory_locks() };
    let mut host = WasmHostIO;
    let result = match syscalls::sys_fchown(proc, &mut host, fd, uid, gid) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    };
    deliver_pending_signals_with_locks(proc, advisory_locks, &mut host);
    result
}

// WHY: Vector parsing is private to channel dispatch and always carries the
// allocation-bearing region beside the table pointer. The former public raw
// exports could prove only that a pointer fit somewhere in total kernel
// memory, not that it belonged to the live channel allocation. Current user
// programs use channel_syscall.c and cannot import those obsolete functions.
unsafe fn kernel_iovec_wire_at(iov_ptr: *const u8, index: usize) -> (usize, usize) {
    use wasm_posix_shared::KernelIovecWire;

    let offset = index * size_of::<KernelIovecWire>();
    let iov = unsafe { slice::from_raw_parts(iov_ptr.add(offset), size_of::<KernelIovecWire>()) };
    (
        read_wire_u32(iov, offset_of!(KernelIovecWire, base)) as usize,
        read_wire_u32(iov, offset_of!(KernelIovecWire, len)) as usize,
    )
}

fn checked_kernel_iovec_entries(
    iov_ptr: *const u8,
    iovcnt: i32,
    region: ChannelScratchRegion,
) -> Result<(Vec<(usize, usize)>, usize), Errno> {
    if iovcnt < 0 || iovcnt as usize > platform_limits::IOV_MAX {
        return Err(Errno::EINVAL);
    }
    if iovcnt == 0 {
        // POSIX permits a null iovec pointer when no table entries exist.
        // Return before inspecting the pointer or channel allocation.
        return Ok((Vec::new(), 0));
    }
    if iov_ptr.is_null() {
        return Err(Errno::EFAULT);
    }

    let count = iovcnt as usize;
    let table_bytes = count
        .checked_mul(size_of::<wasm_posix_shared::KernelIovecWire>())
        .ok_or(Errno::EFAULT)?;
    region.checked_range(iov_ptr as usize, table_bytes)?;

    let mut entries = Vec::new();
    entries
        .try_reserve_exact(count)
        .map_err(|_| Errno::ENOMEM)?;
    let mut total = 0usize;
    for index in 0..count {
        let (base, length) = unsafe { kernel_iovec_wire_at(iov_ptr, index) };
        region.checked_range(base, length)?;
        total = total.checked_add(length).ok_or(Errno::EINVAL)?;
        if total > platform_limits::MAX_REPORTABLE_TRANSFER_BYTES {
            return Err(Errno::EINVAL);
        }
        entries.push((base, length));
    }
    Ok((entries, total))
}

fn try_initialized_kernel_io_bytes(length: usize) -> Result<Vec<u8>, Errno> {
    let mut bytes = Vec::new();
    bytes.try_reserve_exact(length).map_err(|_| Errno::ENOMEM)?;
    bytes.resize(length, 0);
    Ok(bytes)
}

unsafe fn gather_kernel_iovec_bytes(
    entries: &[(usize, usize)],
    total: usize,
) -> Result<Vec<u8>, Errno> {
    let mut gathered = Vec::new();
    gathered
        .try_reserve_exact(total)
        .map_err(|_| Errno::ENOMEM)?;
    for &(base, length) in entries {
        if length != 0 {
            let source = unsafe { slice::from_raw_parts(base as *const u8, length) };
            gathered.extend_from_slice(source);
        }
    }
    Ok(gathered)
}

unsafe fn scatter_kernel_iovec_prefix(
    entries: &[(usize, usize)],
    source: &[u8],
    length: usize,
) -> Result<(), Errno> {
    let source = source.get(..length).ok_or(Errno::EIO)?;
    let mut copied = 0usize;
    for &(base, capacity) in entries {
        if copied == source.len() {
            break;
        }
        let count = capacity.min(source.len() - copied);
        if count != 0 {
            // `copy`, unlike `copy_nonoverlapping`, remains sound if a raw
            // compatibility caller supplies overlapping destination iovecs.
            // The table/ranges were checked before the scalar read.
            unsafe {
                core::ptr::copy(source.as_ptr().add(copied), base as *mut u8, count);
            }
            copied += count;
        }
    }
    if copied == source.len() {
        Ok(())
    } else {
        Err(Errno::EIO)
    }
}

/// Write data from multiple fixed kernel-wire buffers in one live channel.
/// Returns total bytes written (>= 0) or negative errno.
fn channel_writev(fd: i32, iov_ptr: *const u8, iovcnt: i32, region: ChannelScratchRegion) -> i32 {
    let (_gkl, proc, advisory_locks) = unsafe { get_process_and_advisory_locks() };
    let mut host = WasmHostIO;

    let result = 'done: {
        let (entries, total) = match checked_kernel_iovec_entries(iov_ptr, iovcnt, region) {
            Ok(entries) => entries,
            Err(error) => break 'done -(error as i32),
        };
        let gathered = match unsafe { gather_kernel_iovec_bytes(&entries, total) } {
            Ok(bytes) => bytes,
            Err(error) => break 'done -(error as i32),
        };
        match syscalls::sys_write(proc, &mut host, fd, &gathered) {
            Ok(n) => n as i32,
            Err(e) => -(e as i32),
        }
    };
    deliver_pending_signals_with_locks(proc, advisory_locks, &mut host);
    result
}

/// Read data into multiple fixed kernel-wire buffers in one live channel.
/// Returns total bytes read (>= 0) or negative errno.
fn channel_readv(fd: i32, iov_ptr: *mut u8, iovcnt: i32, region: ChannelScratchRegion) -> i32 {
    let (_gkl, proc, advisory_locks) = unsafe { get_process_and_advisory_locks() };
    let mut host = WasmHostIO;

    let result = 'done: {
        let (entries, total) = match checked_kernel_iovec_entries(iov_ptr, iovcnt, region) {
            Ok(entries) => entries,
            Err(error) => break 'done -(error as i32),
        };
        let mut gathered = match try_initialized_kernel_io_bytes(total) {
            Ok(bytes) => bytes,
            Err(error) => break 'done -(error as i32),
        };
        match syscalls::sys_read(proc, &mut host, fd, &mut gathered) {
            Ok(n) => match unsafe { scatter_kernel_iovec_prefix(&entries, &gathered, n) } {
                Ok(()) => n as i32,
                Err(error) => -(error as i32),
            },
            Err(e) => -(e as i32),
        }
    };
    syscalls::drain_deferred_scm_rights_releases(advisory_locks, &mut host);
    deliver_pending_signals_with_locks(proc, advisory_locks, &mut host);
    result
}

/// preadv -- scatter-gather read from one live channel at an exact offset.
/// offset is split into (lo, hi) u32 pair.
/// Returns total bytes read or negative errno.
fn channel_preadv(
    fd: i32,
    iov_ptr: *mut u8,
    iovcnt: i32,
    offset_lo: u32,
    offset_hi: i32,
    region: ChannelScratchRegion,
) -> i32 {
    let (_gkl, proc, advisory_locks) = unsafe { get_process_and_advisory_locks() };
    let mut host = WasmHostIO;
    let offset = ((offset_hi as i64) << 32) | (offset_lo as u64 as i64);

    let result = 'done: {
        let (entries, total) = match checked_kernel_iovec_entries(iov_ptr, iovcnt, region) {
            Ok(entries) => entries,
            Err(error) => break 'done -(error as i32),
        };
        let mut gathered = match try_initialized_kernel_io_bytes(total) {
            Ok(bytes) => bytes,
            Err(error) => break 'done -(error as i32),
        };
        match syscalls::sys_pread(proc, &mut host, fd, &mut gathered, offset) {
            Ok(n) => match unsafe { scatter_kernel_iovec_prefix(&entries, &gathered, n) } {
                Ok(()) => n as i32,
                Err(error) => -(error as i32),
            },
            Err(e) => -(e as i32),
        }
    };
    deliver_pending_signals_with_locks(proc, advisory_locks, &mut host);
    result
}

/// pwritev -- scatter-gather write from one live channel at an exact offset.
/// offset is split into (lo, hi) u32 pair.
/// Returns total bytes written or negative errno.
fn channel_pwritev(
    fd: i32,
    iov_ptr: *const u8,
    iovcnt: i32,
    offset_lo: u32,
    offset_hi: i32,
    region: ChannelScratchRegion,
) -> i32 {
    let (_gkl, proc, advisory_locks) = unsafe { get_process_and_advisory_locks() };
    let mut host = WasmHostIO;
    let offset = ((offset_hi as i64) << 32) | (offset_lo as u64 as i64);

    let result = 'done: {
        let (entries, total) = match checked_kernel_iovec_entries(iov_ptr, iovcnt, region) {
            Ok(entries) => entries,
            Err(error) => break 'done -(error as i32),
        };
        let gathered = match unsafe { gather_kernel_iovec_bytes(&entries, total) } {
            Ok(bytes) => bytes,
            Err(error) => break 'done -(error as i32),
        };
        match syscalls::sys_pwrite(proc, &mut host, fd, &gathered, offset) {
            Ok(n) => n as i32,
            Err(e) => -(e as i32),
        }
    };
    deliver_pending_signals_with_locks(proc, advisory_locks, &mut host);
    result
}

/// sendfile -- copy data between file descriptors.
/// offset_ptr points to an i64 offset (or is null to use current position).
/// Returns total bytes copied or negative errno.
fn kernel_sendfile_with_count(out_fd: i32, in_fd: i32, offset_ptr: *mut u8, count: usize) -> i32 {
    let (_gkl, proc, advisory_locks) = unsafe { get_process_and_advisory_locks() };
    let mut host = WasmHostIO;

    let offset = if offset_ptr.is_null() {
        -1i64
    } else {
        let bytes = unsafe { slice::from_raw_parts(offset_ptr, 8) };
        i64::from_le_bytes(bytes.try_into().unwrap())
    };

    let result = match syscalls::sys_sendfile(proc, &mut host, out_fd, in_fd, offset, count) {
        Ok(n) => {
            // Update offset_ptr if provided
            if !offset_ptr.is_null() && offset >= 0 {
                match syscalls::checked_offset_advance(offset, n) {
                    Ok(new_offset) => {
                        let buf = unsafe { slice::from_raw_parts_mut(offset_ptr, 8) };
                        buf.copy_from_slice(&new_offset.to_le_bytes());
                        n as i32
                    }
                    Err(error) => -(error as i32),
                }
            } else {
                n as i32
            }
        }
        Err(e) => -(e as i32),
    };
    // WHY: sendfile without an explicit input offset consumes through the
    // ordinary read path. Crossing stream ancillary data discards its
    // SCM_RIGHTS, so direct callers need the same cleanup as channel dispatch.
    syscalls::finish_scm_rights_cleanup(advisory_locks, &mut host);
    deliver_pending_signals_with_locks(proc, advisory_locks, &mut host);
    result
}

#[unsafe(no_mangle)]
pub extern "C" fn kernel_sendfile(
    out_fd: i32,
    in_fd: i32,
    offset_ptr: *mut u8,
    count: usize,
) -> i32 {
    kernel_sendfile_with_count(out_fd, in_fd, offset_ptr, count)
}

/// statx -- extended file stat.
/// Delegates to fstatat and fills the statx buffer from WasmStat.
/// statx struct layout: we write a simplified version compatible with musl expectations.
/// Returns 0 on success, negative errno on error.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_statx(
    dirfd: i32,
    path_ptr: *const u8,
    path_len: u32,
    flags: u32,
    mask: u32,
    statx_ptr: *mut u8,
) -> i32 {
    let (_gkl, proc, advisory_locks) = unsafe { get_process_and_advisory_locks() };
    let mut host = WasmHostIO;
    let path = unsafe { slice::from_raw_parts(path_ptr, path_len as usize) };

    let result = match syscalls::sys_statx(proc, &mut host, dirfd, path, flags, mask) {
        Ok(st) => {
            // Fill statx struct (256 bytes)
            // We fill the key fields that musl expects
            let buf = unsafe { slice::from_raw_parts_mut(statx_ptr, 256) };
            // Zero out first
            for b in buf.iter_mut() {
                *b = 0;
            }
            // stx_mask (u32 @ 0): STATX_BASIC_STATS = 0x07ff
            buf[0..4].copy_from_slice(&0x07ffu32.to_le_bytes());
            // stx_blksize (u32 @ 4): default 4096
            buf[4..8].copy_from_slice(&4096u32.to_le_bytes());
            // stx_attributes (u64 @ 8): 0
            // stx_nlink (u32 @ 16)
            buf[16..20].copy_from_slice(&st.st_nlink.to_le_bytes());
            // stx_uid (u32 @ 20)
            buf[20..24].copy_from_slice(&st.st_uid.to_le_bytes());
            // stx_gid (u32 @ 24)
            buf[24..28].copy_from_slice(&st.st_gid.to_le_bytes());
            // stx_mode (u16 @ 28)
            buf[28..30].copy_from_slice(&(st.st_mode as u16).to_le_bytes());
            // stx_ino (u64 @ 32)
            buf[32..40].copy_from_slice(&st.st_ino.to_le_bytes());
            // stx_size (u64 @ 40)
            buf[40..48].copy_from_slice(&st.st_size.to_le_bytes());
            // stx_blocks (u64 @ 48): size / 512
            let blocks = (st.st_size + 511) / 512;
            buf[48..56].copy_from_slice(&blocks.to_le_bytes());
            // stx_attributes_mask (u64 @ 56): 0
            // stx_atime (statx_timestamp @ 64): tv_sec(i64) + tv_nsec(u32) + pad(i32) = 16 bytes
            buf[64..72].copy_from_slice(&st.st_atime_sec.to_le_bytes());
            buf[72..76].copy_from_slice(&st.st_atime_nsec.to_le_bytes());
            // stx_btime (@ 80): 0 (birth time not tracked)
            // stx_ctime (@ 96)
            buf[96..104].copy_from_slice(&st.st_ctime_sec.to_le_bytes());
            buf[104..108].copy_from_slice(&st.st_ctime_nsec.to_le_bytes());
            // stx_mtime (@ 112)
            buf[112..120].copy_from_slice(&st.st_mtime_sec.to_le_bytes());
            buf[120..124].copy_from_slice(&st.st_mtime_nsec.to_le_bytes());
            // stx_rdev_major (u32 @ 128), stx_rdev_minor (u32 @ 132)
            // stx_dev_major (u32 @ 136), stx_dev_minor (u32 @ 140)
            buf[136..140].copy_from_slice(&(st.st_dev as u32).to_le_bytes());
            0
        }
        Err(e) => -(e as i32),
    };
    deliver_pending_signals_with_locks(proc, advisory_locks, &mut host);
    result
}

/// Get resource limits. Writes soft and hard limits as two u64 LE values (16 bytes) to rlim_ptr.
/// Returns 0 on success, or negative errno on error.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_getrlimit(resource: u32, rlim_ptr: *mut u8) -> i32 {
    let (_gkl, proc, advisory_locks) = unsafe { get_process_and_advisory_locks() };
    let result = match syscalls::sys_getrlimit(proc, resource) {
        Ok((soft, hard)) => {
            let buf = unsafe { core::slice::from_raw_parts_mut(rlim_ptr, 16) };
            buf[0..8].copy_from_slice(&soft.to_le_bytes());
            buf[8..16].copy_from_slice(&hard.to_le_bytes());
            0
        }
        Err(e) => -(e as i32),
    };
    let mut host = WasmHostIO;
    deliver_pending_signals_with_locks(proc, advisory_locks, &mut host);
    result
}

/// Set resource limits. Reads soft and hard limits as two u64 LE values (16 bytes) from rlim_ptr.
/// Returns 0 on success, or negative errno on error.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_setrlimit(resource: u32, rlim_ptr: *const u8) -> i32 {
    let (_gkl, proc, advisory_locks) = unsafe { get_process_and_advisory_locks() };
    let buf = unsafe { core::slice::from_raw_parts(rlim_ptr, 16) };
    let soft = u64::from_le_bytes([
        buf[0], buf[1], buf[2], buf[3], buf[4], buf[5], buf[6], buf[7],
    ]);
    let hard = u64::from_le_bytes([
        buf[8], buf[9], buf[10], buf[11], buf[12], buf[13], buf[14], buf[15],
    ]);
    let result = match syscalls::sys_setrlimit(proc, resource, soft, hard) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    };
    let mut host = WasmHostIO;
    deliver_pending_signals_with_locks(proc, advisory_locks, &mut host);
    result
}

// ---------------------------------------------------------------------------
// Phase 12: Remaining *at() variants
// ---------------------------------------------------------------------------

/// faccessat — check file accessibility relative to directory fd.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_faccessat(
    dirfd: i32,
    path_ptr: *const u8,
    path_len: u32,
    amode: u32,
    flags: u32,
) -> i32 {
    let (_gkl, proc, advisory_locks) = unsafe { get_process_and_advisory_locks() };
    let mut host = WasmHostIO;
    let path = unsafe { slice::from_raw_parts(path_ptr, path_len as usize) };
    let result = match syscalls::sys_faccessat(proc, &mut host, dirfd, path, amode, flags) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    };
    deliver_pending_signals_with_locks(proc, advisory_locks, &mut host);
    result
}

/// fchmodat — change file mode relative to directory fd.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_fchmodat(
    dirfd: i32,
    path_ptr: *const u8,
    path_len: u32,
    mode: u32,
    flags: u32,
) -> i32 {
    let (_gkl, proc, advisory_locks) = unsafe { get_process_and_advisory_locks() };
    let mut host = WasmHostIO;
    let path = unsafe { slice::from_raw_parts(path_ptr, path_len as usize) };
    let result = match syscalls::sys_fchmodat(proc, &mut host, dirfd, path, mode, flags) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    };
    deliver_pending_signals_with_locks(proc, advisory_locks, &mut host);
    result
}

/// fchownat — change file owner/group relative to directory fd.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_fchownat(
    dirfd: i32,
    path_ptr: *const u8,
    path_len: u32,
    uid: u32,
    gid: u32,
    flags: u32,
) -> i32 {
    let (_gkl, proc, advisory_locks) = unsafe { get_process_and_advisory_locks() };
    let mut host = WasmHostIO;
    let path = unsafe { slice::from_raw_parts(path_ptr, path_len as usize) };
    let result = match syscalls::sys_fchownat(proc, &mut host, dirfd, path, uid, gid, flags) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    };
    deliver_pending_signals_with_locks(proc, advisory_locks, &mut host);
    result
}

/// linkat — create hard link relative to directory fds.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_linkat(
    olddirfd: i32,
    old_ptr: *const u8,
    old_len: u32,
    newdirfd: i32,
    new_ptr: *const u8,
    new_len: u32,
    flags: u32,
) -> i32 {
    let (_gkl, proc, advisory_locks) = unsafe { get_process_and_advisory_locks() };
    let mut host = WasmHostIO;
    let oldpath = unsafe { slice::from_raw_parts(old_ptr, old_len as usize) };
    let newpath = unsafe { slice::from_raw_parts(new_ptr, new_len as usize) };
    let result =
        match syscalls::sys_linkat(proc, &mut host, olddirfd, oldpath, newdirfd, newpath, flags) {
            Ok(()) => 0,
            Err(e) => -(e as i32),
        };
    deliver_pending_signals_with_locks(proc, advisory_locks, &mut host);
    result
}

/// symlinkat — create symbolic link relative to directory fd.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_symlinkat(
    target_ptr: *const u8,
    target_len: u32,
    newdirfd: i32,
    link_ptr: *const u8,
    link_len: u32,
) -> i32 {
    let (_gkl, proc, advisory_locks) = unsafe { get_process_and_advisory_locks() };
    let mut host = WasmHostIO;
    let target = unsafe { slice::from_raw_parts(target_ptr, target_len as usize) };
    let linkpath = unsafe { slice::from_raw_parts(link_ptr, link_len as usize) };
    let result = match syscalls::sys_symlinkat(proc, &mut host, target, newdirfd, linkpath) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    };
    deliver_pending_signals_with_locks(proc, advisory_locks, &mut host);
    result
}

/// readlinkat — read symbolic link relative to directory fd.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_readlinkat(
    dirfd: i32,
    path_ptr: *const u8,
    path_len: u32,
    buf_ptr: *mut u8,
    buf_len: u32,
) -> i32 {
    let (_gkl, proc, advisory_locks) = unsafe { get_process_and_advisory_locks() };
    let mut host = WasmHostIO;
    let path = unsafe { slice::from_raw_parts(path_ptr, path_len as usize) };
    let buf = unsafe { core::slice::from_raw_parts_mut(buf_ptr, buf_len as usize) };
    let result = match syscalls::sys_readlinkat(proc, &mut host, dirfd, path, buf) {
        Ok(n) => n as i32,
        Err(e) => -(e as i32),
    };
    deliver_pending_signals_with_locks(proc, advisory_locks, &mut host);
    result
}

// ---------------------------------------------------------------------------
// Phase 12: select()
// ---------------------------------------------------------------------------

/// select — synchronous I/O multiplexing.
///
/// Each fd_set uses the shared generated width. Null means the set is unused.
/// Returns number of ready fds, or negative errno on error.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_select(
    nfds: i32,
    readfds_ptr: *mut u8,
    readfds_capacity: u32,
    writefds_ptr: *mut u8,
    writefds_capacity: u32,
    exceptfds_ptr: *mut u8,
    exceptfds_capacity: u32,
    timeout_ms: i32,
) -> i32 {
    let (_gkl, proc, advisory_locks) = unsafe { get_process_and_advisory_locks() };

    let fd_set_bytes = wasm_posix_shared::select::FD_SET_BYTES;
    let pointer_range = |ptr: *mut u8, capacity: u32| -> Result<Option<(usize, usize)>, Errno> {
        if ptr.is_null() {
            return if capacity == 0 {
                Ok(None)
            } else {
                Err(Errno::EINVAL)
            };
        }
        if capacity as usize != fd_set_bytes {
            return Err(Errno::EINVAL);
        }
        let start = ptr as usize;
        let end = start.checked_add(fd_set_bytes).ok_or(Errno::EFAULT)?;
        Ok(Some((start, end)))
    };
    let read_range = match pointer_range(readfds_ptr, readfds_capacity) {
        Ok(range) => range,
        Err(error) => return -(error as i32),
    };
    let write_range = match pointer_range(writefds_ptr, writefds_capacity) {
        Ok(range) => range,
        Err(error) => return -(error as i32),
    };
    let except_range = match pointer_range(exceptfds_ptr, exceptfds_capacity) {
        Ok(range) => range,
        Err(error) => return -(error as i32),
    };
    let ranges = [read_range, write_range, except_range];
    for left in 0..ranges.len() {
        let Some((left_start, left_end)) = ranges[left] else {
            continue;
        };
        for right in left + 1..ranges.len() {
            let Some((right_start, right_end)) = ranges[right] else {
                continue;
            };
            if left_start < right_end && left_end > right_start {
                return -(Errno::EINVAL as i32);
            }
        }
    }

    let readfds = if readfds_ptr.is_null() {
        None
    } else {
        Some(unsafe { core::slice::from_raw_parts_mut(readfds_ptr, fd_set_bytes) })
    };
    let writefds = if writefds_ptr.is_null() {
        None
    } else {
        Some(unsafe { core::slice::from_raw_parts_mut(writefds_ptr, fd_set_bytes) })
    };
    let exceptfds = if exceptfds_ptr.is_null() {
        None
    } else {
        Some(unsafe { core::slice::from_raw_parts_mut(exceptfds_ptr, fd_set_bytes) })
    };

    let mut host = WasmHostIO;
    let result = match syscalls::sys_select(
        proc, &mut host, nfds, readfds, writefds, exceptfds, timeout_ms,
    ) {
        Ok(n) => n,
        Err(e) => -(e as i32),
    };
    deliver_pending_signals_with_locks(proc, advisory_locks, &mut host);
    result
}

// ---------------------------------------------------------------------------
// Phase 12: setuid/setgid/seteuid/setegid
// ---------------------------------------------------------------------------

/// setuid — set real and effective user ID.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_setuid(uid: u32) -> i32 {
    let (_gkl, proc, advisory_locks) = unsafe { get_process_and_advisory_locks() };
    let result = match syscalls::sys_setuid(proc, uid) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    };
    let mut host = WasmHostIO;
    deliver_pending_signals_with_locks(proc, advisory_locks, &mut host);
    result
}

/// setgid — set real and effective group ID.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_setgid(gid: u32) -> i32 {
    let (_gkl, proc, advisory_locks) = unsafe { get_process_and_advisory_locks() };
    let result = match syscalls::sys_setgid(proc, gid) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    };
    let mut host = WasmHostIO;
    deliver_pending_signals_with_locks(proc, advisory_locks, &mut host);
    result
}

/// seteuid — set effective user ID.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_seteuid(euid: u32) -> i32 {
    let (_gkl, proc, advisory_locks) = unsafe { get_process_and_advisory_locks() };
    let result = match syscalls::sys_seteuid(proc, euid) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    };
    let mut host = WasmHostIO;
    deliver_pending_signals_with_locks(proc, advisory_locks, &mut host);
    result
}

/// setegid — set effective group ID.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_setegid(egid: u32) -> i32 {
    let (_gkl, proc, advisory_locks) = unsafe { get_process_and_advisory_locks() };
    let result = match syscalls::sys_setegid(proc, egid) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    };
    let mut host = WasmHostIO;
    deliver_pending_signals_with_locks(proc, advisory_locks, &mut host);
    result
}

// ---------------------------------------------------------------------------
// Phase 12: getrusage
// ---------------------------------------------------------------------------

/// getrusage — get resource usage. Writes the shared fixed-width wire record.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_getrusage(who: i32, buf_ptr: *mut u8, buf_len: u32) -> i32 {
    if buf_ptr.is_null() {
        return -(Errno::EFAULT as i32);
    }
    let (_gkl, proc, advisory_locks) = unsafe { get_process_and_advisory_locks() };
    let buf = unsafe { core::slice::from_raw_parts_mut(buf_ptr, buf_len as usize) };
    let result = match syscalls::sys_getrusage(proc, who, buf) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    };
    let mut host = WasmHostIO;
    deliver_pending_signals_with_locks(proc, advisory_locks, &mut host);
    result
}

// ---------------------------------------------------------------------------
// realpath
// ---------------------------------------------------------------------------

/// realpath — resolve canonical path. Returns bytes written, or negative errno.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_realpath(
    path_ptr: *const u8,
    path_len: u32,
    buf_ptr: *mut u8,
    buf_len: u32,
) -> i32 {
    let (_gkl, proc, advisory_locks) = unsafe { get_process_and_advisory_locks() };
    let mut host = WasmHostIO;
    let path = unsafe { slice::from_raw_parts(path_ptr, path_len as usize) };
    let buf = unsafe { core::slice::from_raw_parts_mut(buf_ptr, buf_len as usize) };
    let result = match syscalls::sys_realpath(proc, &mut host, path, buf) {
        Ok(n) => n as i32,
        Err(e) => -(e as i32),
    };
    deliver_pending_signals_with_locks(proc, advisory_locks, &mut host);
    result
}

/// clone — spawn a new thread. Returns child TID in parent, negative errno on error.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_clone(
    fn_ptr: usize,
    stack_ptr: usize,
    flags: u32,
    arg: usize,
    ptid_ptr: usize,
    tls_ptr: usize,
    ctid_ptr: usize,
) -> i32 {
    let _gkl = GklGuard::acquire();
    let table = unsafe { &mut *PROCESS_TABLE.0.get() };
    match syscalls::sys_clone(
        table, fn_ptr, stack_ptr, flags, arg, ptid_ptr, tls_ptr, ctid_ptr,
    ) {
        Ok(tid) => tid,
        Err(e) => -(e as i32),
    }
}

/// Returns 1 if this process is a fork child (should exec on startup), 0 otherwise.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_is_fork_child() -> i32 {
    let (_gkl, proc, advisory_locks) = unsafe { get_process_and_advisory_locks() };
    if proc.fork_child {
        1
    } else {
        0
    }
}

/// Read the saved fork exec path into buf. Returns bytes written, or negative errno.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_get_fork_exec_path(buf_ptr: *mut u8, buf_len: u32) -> i32 {
    let (_gkl, proc, advisory_locks) = unsafe { get_process_and_advisory_locks() };
    match &proc.fork_exec_path {
        Some(path) => {
            let len = path.len().min(buf_len as usize);
            let buf = unsafe { core::slice::from_raw_parts_mut(buf_ptr, len) };
            buf.copy_from_slice(&path[..len]);
            len as i32
        }
        None => 0,
    }
}

/// Read fork exec argv[idx] into buf. Returns bytes written, 0 if index out of range.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_get_fork_exec_argv(idx: u32, buf_ptr: *mut u8, buf_len: u32) -> i32 {
    let (_gkl, proc, advisory_locks) = unsafe { get_process_and_advisory_locks() };
    match &proc.fork_exec_argv {
        Some(argv) => {
            if (idx as usize) < argv.len() {
                let arg = &argv[idx as usize];
                let len = arg.len().min(buf_len as usize);
                let buf = unsafe { core::slice::from_raw_parts_mut(buf_ptr, len) };
                buf.copy_from_slice(&arg[..len]);
                len as i32
            } else {
                0
            }
        }
        None => 0,
    }
}

/// Return the number of fork exec argv entries, or 0 if none.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_get_fork_exec_argc() -> i32 {
    let (_gkl, proc, advisory_locks) = unsafe { get_process_and_advisory_locks() };
    match &proc.fork_exec_argv {
        Some(argv) => argv.len() as i32,
        None => 0,
    }
}

/// Save exec path and argv to be used after fork in the child.
/// argv is passed as a pointer to an array of (ptr, len) pairs.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_set_fork_exec(
    path_ptr: *const u8,
    path_len: u32,
    argv_ptrs: *const u32,
    argc: u32,
) -> i32 {
    let (_gkl, proc, advisory_locks) = unsafe { get_process_and_advisory_locks() };
    let path = unsafe { slice::from_raw_parts(path_ptr, path_len as usize) };
    proc.fork_exec_path = Some(path.to_vec());

    let mut argv = alloc::vec::Vec::new();
    for i in 0..argc {
        let entry_ptr = unsafe { argv_ptrs.add((i * 2) as usize) };
        let arg_ptr = unsafe { *entry_ptr } as *const u8;
        let arg_len = unsafe { *entry_ptr.add(1) } as usize;
        let arg = unsafe { slice::from_raw_parts(arg_ptr, arg_len) };
        argv.push(arg.to_vec());
    }
    proc.fork_exec_argv = Some(argv);
    0
}

/// Add an fd action to apply before exec in fork child.
/// action_type: 0=DUP2(fd1→fd2), 1=CLOSE(fd1), 2=OPEN(fd1, path at fd2 interpreted as ptr+len)
#[unsafe(no_mangle)]
pub extern "C" fn kernel_set_fork_fd_action(action_type: u32, fd1: i32, fd2: i32) -> i32 {
    let (_gkl, proc, advisory_locks) = unsafe { get_process_and_advisory_locks() };
    use crate::process::FdAction;
    match action_type {
        0 => proc.fork_fd_actions.push(FdAction::Dup2 {
            old_fd: fd1,
            new_fd: fd2,
        }),
        1 => proc.fork_fd_actions.push(FdAction::Close { fd: fd1 }),
        _ => return -(wasm_posix_shared::Errno::EINVAL as i32),
    }
    0
}

/// Apply saved fork fd actions (dup2, close). Returns 0 on success, negative errno on error.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_apply_fork_fd_actions() -> i32 {
    let (_gkl, proc, advisory_locks) = unsafe { get_process_and_advisory_locks() };
    let mut host = WasmHostIO;
    let actions: alloc::vec::Vec<_> = proc.fork_fd_actions.drain(..).collect();
    for action in actions {
        match action {
            crate::process::FdAction::Dup2 { old_fd, new_fd } => {
                if let Err(e) =
                    syscalls::sys_dup2_with_locks(proc, advisory_locks, &mut host, old_fd, new_fd)
                {
                    return -(e as i32);
                }
            }
            crate::process::FdAction::Close { fd } => {
                if let Err(e) = syscalls::sys_close_implicit_with_locks(
                    proc,
                    advisory_locks,
                    &mut host,
                    fd,
                ) {
                    return -(e as i32);
                }
            }
            crate::process::FdAction::Open {
                fd,
                ref path,
                flags,
                mode,
            } => match syscalls::sys_open(proc, &mut host, &path, flags as u32, mode as u32) {
                Ok(opened_fd) => {
                    if opened_fd != fd {
                        if let Err(e) = syscalls::sys_dup2_with_locks(
                            proc,
                            advisory_locks,
                            &mut host,
                            opened_fd,
                            fd,
                        ) {
                            return -(e as i32);
                        }
                        let _ = syscalls::sys_close_implicit_with_locks(
                            proc,
                            advisory_locks,
                            &mut host,
                            opened_fd,
                        );
                    }
                }
                Err(e) => return -(e as i32),
            },
        }
    }
    // Clear fork_child flag after applying actions
    proc.fork_child = false;
    0
}

/// Clear saved fork exec state (path, argv, fd_actions).
#[unsafe(no_mangle)]
pub extern "C" fn kernel_clear_fork_exec() -> i32 {
    let (_gkl, proc, advisory_locks) = unsafe { get_process_and_advisory_locks() };
    proc.fork_exec_path = None;
    proc.fork_exec_argv = None;
    proc.fork_fd_actions.clear();
    proc.fork_child = false;
    0
}

// ---------------------------------------------------------------------------
// alarm
// ---------------------------------------------------------------------------

/// Schedule a SIGALRM after `seconds` seconds.
/// Returns the number of seconds remaining from a previous alarm, or negative errno.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_alarm(seconds: u32) -> i32 {
    let (_gkl, proc, advisory_locks) = unsafe { get_process_and_advisory_locks() };
    let mut host = WasmHostIO;
    let result = match syscalls::sys_alarm(proc, &mut host, seconds) {
        Ok(remaining) => remaining as i32,
        Err(e) => -(e as i32),
    };
    deliver_pending_signals_with_locks(proc, advisory_locks, &mut host);
    result
}

// ---------------------------------------------------------------------------
// setitimer / getitimer
// ---------------------------------------------------------------------------

/// setitimer -- set interval timer.
///
/// `new_ptr` and `old_ptr` name the kernel-facing four-native-`long` timer
/// record. wasm32 musl translates its public time64 `itimerval` to this record;
/// wasm64 passes its 32-byte native record directly.
/// Returns 0 on success, negative errno on error.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_setitimer(
    which: u32,
    new_ptr: *const u8,
    old_ptr: *mut u8,
    process_pointer_width: i64,
) -> i32 {
    use crate::process_wire::ProcessDataModel;

    let model = match ProcessDataModel::from_width(process_pointer_width) {
        Ok(model) => model,
        Err(error) => return -(error as i32),
    };
    if new_ptr.is_null() {
        return -(Errno::EFAULT as i32);
    }
    let (_gkl, proc, advisory_locks) = unsafe { get_process_and_advisory_locks() };
    let mut host = WasmHostIO;

    // WHY: consume exactly the capacity described to the host. A fixed
    // 16-byte parse would truncate wasm64 and a fixed 32-byte parse would
    // overrun the wasm32 scratch record.
    let bytes = unsafe { slice::from_raw_parts(new_ptr, model.itimerval_size()) };
    let new_values = match crate::process_wire::read_itimerval(bytes, model) {
        Ok(values) => values,
        Err(error) => return -(error as i32),
    };
    let [interval_sec, interval_usec, value_sec, value_usec] = new_values;

    let result = match syscalls::sys_setitimer(
        proc,
        &mut host,
        which,
        interval_sec,
        interval_usec,
        value_sec,
        value_usec,
    ) {
        Ok((old_isec, old_iusec, old_vsec, old_vusec)) => {
            if !old_ptr.is_null() {
                let mut encoded = alloc::vec![0; model.itimerval_size()];
                if let Err(error) = crate::process_wire::write_itimerval(
                    &mut encoded,
                    [old_isec, old_iusec, old_vsec, old_vusec],
                    model,
                ) {
                    return -(error as i32);
                }
                let output = unsafe { slice::from_raw_parts_mut(old_ptr, model.itimerval_size()) };
                output.copy_from_slice(&encoded);
            }
            0
        }
        Err(e) => -(e as i32),
    };
    deliver_pending_signals_with_locks(proc, advisory_locks, &mut host);
    result
}

/// getitimer -- get current value of interval timer.
/// `curr_ptr` receives the caller's four-native-`long` kernel-facing record.
/// Returns 0 on success, negative errno on error.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_getitimer(
    which: u32,
    curr_ptr: *mut u8,
    process_pointer_width: i64,
) -> i32 {
    use crate::process_wire::ProcessDataModel;

    let model = match ProcessDataModel::from_width(process_pointer_width) {
        Ok(model) => model,
        Err(error) => return -(error as i32),
    };
    if curr_ptr.is_null() {
        return -(Errno::EFAULT as i32);
    }
    let (_gkl, proc, advisory_locks) = unsafe { get_process_and_advisory_locks() };
    let mut host = WasmHostIO;
    let result = match syscalls::sys_getitimer(proc, &mut host, which) {
        Ok((isec, iusec, vsec, vusec)) => {
            let mut encoded = alloc::vec![0; model.itimerval_size()];
            match crate::process_wire::write_itimerval(
                &mut encoded,
                [isec, iusec, vsec, vusec],
                model,
            ) {
                Ok(()) => {
                    let output =
                        unsafe { slice::from_raw_parts_mut(curr_ptr, model.itimerval_size()) };
                    output.copy_from_slice(&encoded);
                    0
                }
                Err(error) => -(error as i32),
            }
        }
        Err(e) => -(e as i32),
    };
    deliver_pending_signals_with_locks(proc, advisory_locks, &mut host);
    result
}

// ---------------------------------------------------------------------------
// POSIX timers (timer_create / timer_settime / timer_gettime / etc.)
// ---------------------------------------------------------------------------

/// Kernel-facing sigevent notification modes used by musl.
const SIGEV_SIGNAL: u32 = 0;
const SIGEV_NONE: u32 = 1;
/// Linux extension used internally by musl to implement POSIX SIGEV_THREAD.
const SIGEV_THREAD_ID: u32 = 4;
/// TIMER_ABSTIME flag for timer_settime.
const TIMER_ABSTIME: i32 = 1;

fn timer_clock_to_host_clock(clock_id: u32) -> Option<u32> {
    use wasm_posix_shared::clock::*;
    match clock_id {
        CLOCK_REALTIME | CLOCK_MONOTONIC => Some(clock_id),
        CLOCK_BOOTTIME => Some(CLOCK_MONOTONIC),
        _ => None,
    }
}

#[cfg(test)]
mod posix_timer_tests {
    use super::*;
    use wasm_posix_shared::clock::*;

    #[test]
    fn boottime_timers_use_monotonic_host_clock() {
        assert_eq!(
            timer_clock_to_host_clock(CLOCK_BOOTTIME),
            Some(CLOCK_MONOTONIC)
        );
    }

    #[test]
    fn timer_create_rejects_unsupported_clock_ids() {
        assert_eq!(timer_clock_to_host_clock(CLOCK_THREAD_CPUTIME_ID), None);
        assert_eq!(timer_clock_to_host_clock(99), None);
    }

    fn directed_timer(target_tid: u32) -> crate::process::PosixTimerState {
        crate::process::PosixTimerState {
            clock_id: CLOCK_MONOTONIC,
            sigev_signo: 10,
            sigev_value_bits: 77,
            sigev_notify: SIGEV_THREAD_ID,
            sigev_tid: target_tid,
            interval_sec: 0,
            interval_nsec: 0,
            value_sec: 0,
            value_nsec: 1,
            notification_pending: false,
            overrun_current: 0,
            overrun_last: 0,
        }
    }

    #[test]
    fn directed_timer_fire_targets_main_and_worker_queues_exactly() {
        let mut proc = Process::new(41);
        proc.add_thread(crate::process::ThreadInfo::new(42, 0, 0, 0));
        proc.posix_timers.push(Some(directed_timer(41)));
        proc.posix_timers.push(Some(directed_timer(42)));

        assert_eq!(queue_posix_timer_fire(&mut proc, 0), 41);
        assert!(proc.main_thread_signals.is_pending(10));
        assert!(!proc.get_thread(42).unwrap().signals.is_pending(10));

        assert_eq!(queue_posix_timer_fire(&mut proc, 1), 42);
        assert!(proc.get_thread(42).unwrap().signals.is_pending(10));
    }

    #[test]
    fn directed_timer_fire_rejects_a_target_that_died_after_create() {
        let mut proc = Process::new(41);
        proc.add_thread(crate::process::ThreadInfo::new(42, 0, 0, 0));
        proc.posix_timers.push(Some(directed_timer(42)));
        proc.remove_thread(42);

        assert_eq!(queue_posix_timer_fire(&mut proc, 0), -(Errno::ESRCH as i32));
        assert!(!proc.posix_timers[0].as_ref().unwrap().notification_pending);
    }
}

/// timer_create(clock_id, sigevent_ptr, timerid_ptr, process_pointer_width)
///
/// `sigevent_ptr` names the complete caller-native structure staged in bounded
/// kernel scratch. The explicit process data model keeps `union sigval`
/// pointer-width lossless on both wasm32 and wasm64.
/// Returns 0 on success, negative errno.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_timer_create(
    clock_id: u32,
    sevp_ptr: *const u8,
    timerid_ptr: *mut i32,
    process_pointer_width: i64,
) -> i32 {
    use crate::process::PosixTimerState;

    let (_gkl, proc, advisory_locks) = unsafe { get_process_and_advisory_locks() };

    let host_clock_id = match timer_clock_to_host_clock(clock_id) {
        Some(id) => id,
        None => return -(Errno::EINVAL as i32),
    };

    // Parse sigevent (default: SIGEV_SIGNAL with SIGALRM)
    let (sigev_signo, sigev_value_bits, sigev_notify, sigev_tid) = if sevp_ptr.is_null() {
        (14u32, 0u64, SIGEV_SIGNAL, 0u32) // default: SIGALRM
    } else {
        let model = match crate::process_wire::ProcessDataModel::from_width(process_pointer_width) {
            Ok(model) => model,
            Err(error) => return -(error as i32),
        };
        let input = unsafe { slice::from_raw_parts(sevp_ptr, model.sigevent_size()) };
        let event = match crate::process_wire::read_sigevent(input, model) {
            Ok(event) => event,
            Err(error) => return -(error as i32),
        };
        (event.signo, event.value_bits, event.notify, event.thread_id)
    };

    let sigev_signo = match normalize_posix_timer_signo(sigev_notify, sigev_signo) {
        Ok(signo) => signo,
        Err(errno) => return -(errno as i32),
    };
    if sigev_notify == SIGEV_THREAD_ID && !proc.is_live_explicit_tid(sigev_tid) {
        return -(Errno::EINVAL as i32);
    }

    // Allocate timer slot
    let timer_id = {
        let mut slot = None;
        for (i, s) in proc.posix_timers.iter().enumerate() {
            if s.is_none() {
                slot = Some(i);
                break;
            }
        }
        match slot {
            Some(i) => i,
            None => {
                let i = proc.posix_timers.len();
                proc.posix_timers.push(None);
                i
            }
        }
    };

    proc.posix_timers[timer_id] = Some(PosixTimerState {
        clock_id: host_clock_id,
        sigev_signo,
        sigev_value_bits,
        sigev_notify,
        sigev_tid,
        interval_sec: 0,
        interval_nsec: 0,
        value_sec: 0,
        value_nsec: 0,
        notification_pending: false,
        overrun_current: 0,
        overrun_last: 0,
    });

    if !timerid_ptr.is_null() {
        unsafe {
            *timerid_ptr = timer_id as i32;
        }
    }

    let mut host = WasmHostIO;
    deliver_pending_signals_with_locks(proc, advisory_locks, &mut host);
    0
}

/// Queue one POSIX timer expiration in the timer owner's signal state.
///
/// The host owns wall-clock scheduling, but the kernel owns notification
/// semantics and siginfo metadata. Return values tell the host which blocked
/// signal-wait channel to wake:
/// - positive TID: thread-directed `SIGEV_THREAD_ID`
/// - zero: process-wide `SIGEV_SIGNAL`
/// - negative: no notification was queued (SIGEV_NONE, overrun, or error)
#[unsafe(no_mangle)]
pub extern "C" fn kernel_posix_timer_fire(pid: u32, timer_id: u32) -> i32 {
    let table = unsafe { &mut *PROCESS_TABLE.0.get() };
    let proc = match table.get_mut(pid) {
        Some(proc) => proc,
        None => return -(Errno::ESRCH as i32),
    };
    queue_posix_timer_fire(proc, timer_id)
}

fn queue_posix_timer_fire(proc: &mut Process, timer_id: u32) -> i32 {
    let (notify, target_tid, signo, value) = {
        let timer = match proc.posix_timers.get_mut(timer_id as usize) {
            Some(Some(timer)) => timer,
            _ => return -(Errno::EINVAL as i32),
        };
        if timer.sigev_notify == SIGEV_NONE {
            return -(Errno::EAGAIN as i32);
        }
        if crate::signal::should_discard_pending(
            timer.sigev_signo,
            &proc.signals.get_handler(timer.sigev_signo),
        ) {
            return -(Errno::EAGAIN as i32);
        }
        if timer.notification_pending {
            timer.overrun_current = timer.overrun_current.saturating_add(1);
            return -(Errno::EAGAIN as i32);
        }
        timer.notification_pending = true;
        (
            timer.sigev_notify,
            timer.sigev_tid,
            timer.sigev_signo,
            timer.sigev_value_bits,
        )
    };

    match notify {
        SIGEV_SIGNAL => {
            proc.signals.raise_timer(signo, value, timer_id);
            0
        }
        SIGEV_THREAD_ID => {
            if proc.raise_timer_for_thread(target_tid, signo, value, timer_id) {
                target_tid as i32
            } else {
                if let Some(Some(timer)) = proc.posix_timers.get_mut(timer_id as usize) {
                    timer.notification_pending = false;
                }
                -(Errno::ESRCH as i32)
            }
        }
        _ => -(Errno::EINVAL as i32),
    }
}

/// timer_settime(timerid, flags, new_value_ptr, old_value_ptr)
/// new/old are itimerspec as 4 × i64 = 32 bytes: {interval_sec, interval_nsec, value_sec, value_nsec}.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_timer_settime(
    timerid: i32,
    flags: i32,
    new_ptr: *const u8,
    old_ptr: *mut u8,
) -> i32 {
    let (_gkl, proc, advisory_locks) = unsafe { get_process_and_advisory_locks() };
    let mut host = WasmHostIO;

    let tid = timerid as usize;
    let timer = match proc.posix_timers.get_mut(tid) {
        Some(Some(t)) => t,
        _ => return -(Errno::EINVAL as i32),
    };

    // Write old value if requested
    if !old_ptr.is_null() {
        let buf = unsafe { slice::from_raw_parts_mut(old_ptr, 32) };
        buf[0..8].copy_from_slice(&timer.interval_sec.to_le_bytes());
        buf[8..16].copy_from_slice(&timer.interval_nsec.to_le_bytes());
        buf[16..24].copy_from_slice(&timer.value_sec.to_le_bytes());
        buf[24..32].copy_from_slice(&timer.value_nsec.to_le_bytes());
    }

    // Read new value
    let (int_sec, int_nsec, val_sec, val_nsec) = if new_ptr.is_null() {
        (0i64, 0i64, 0i64, 0i64)
    } else {
        let buf = unsafe { slice::from_raw_parts(new_ptr, 32) };
        (
            i64::from_le_bytes(buf[0..8].try_into().unwrap()),
            i64::from_le_bytes(buf[8..16].try_into().unwrap()),
            i64::from_le_bytes(buf[16..24].try_into().unwrap()),
            i64::from_le_bytes(buf[24..32].try_into().unwrap()),
        )
    };

    timer.interval_sec = int_sec;
    timer.interval_nsec = int_nsec;
    timer.value_sec = val_sec;
    timer.value_nsec = val_nsec;

    // Convert to milliseconds for the host timer.
    // 0 = disarm, 1+ = armed.
    let value_ms;
    if val_sec == 0 && val_nsec == 0 {
        value_ms = 0i64; // disarm
    } else if flags & TIMER_ABSTIME != 0 {
        // Absolute time: compute relative delay from current clock
        let (now_sec, now_nsec) = host.host_clock_gettime(timer.clock_id).unwrap_or((0, 0));
        let diff_sec = val_sec - now_sec;
        let diff_nsec = val_nsec - now_nsec;
        let total_ms = diff_sec * 1000 + diff_nsec / 1_000_000;
        // Minimum 1ms for armed timers
        value_ms = if total_ms < 1 { 1 } else { total_ms };
    } else {
        // Relative time — minimum 1ms for non-zero values
        let ms = val_sec * 1000 + val_nsec / 1_000_000;
        value_ms = if ms < 1 { 1 } else { ms };
    }

    let interval_ms = if int_sec == 0 && int_nsec == 0 {
        0i64
    } else {
        let ms = int_sec * 1000 + int_nsec / 1_000_000;
        if ms < 1 {
            1
        } else {
            ms
        } // minimum 1ms for repeating
    };

    let signo = timer.sigev_signo as i32;
    let _ = host.host_set_posix_timer(timerid, signo, value_ms, interval_ms);

    deliver_pending_signals_with_locks(proc, advisory_locks, &mut host);
    0
}

/// timer_gettime(timerid, curr_value_ptr)
/// Writes current itimerspec (32 bytes) to curr_value_ptr.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_timer_gettime(timerid: i32, curr_ptr: *mut u8) -> i32 {
    let (_gkl, proc, advisory_locks) = unsafe { get_process_and_advisory_locks() };
    let mut host = WasmHostIO;

    let tid = timerid as usize;
    let timer = match proc.posix_timers.get(tid) {
        Some(Some(t)) => t,
        _ => return -(Errno::EINVAL as i32),
    };

    if !curr_ptr.is_null() {
        let buf = unsafe { slice::from_raw_parts_mut(curr_ptr, 32) };
        buf[0..8].copy_from_slice(&timer.interval_sec.to_le_bytes());
        buf[8..16].copy_from_slice(&timer.interval_nsec.to_le_bytes());
        buf[16..24].copy_from_slice(&timer.value_sec.to_le_bytes());
        buf[24..32].copy_from_slice(&timer.value_nsec.to_le_bytes());
    }

    deliver_pending_signals_with_locks(proc, advisory_locks, &mut host);
    0
}

/// timer_getoverrun(timerid)
/// Returns the overrun count on success, negative errno on error.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_timer_getoverrun(timerid: i32) -> i32 {
    let (_gkl, proc, advisory_locks) = unsafe { get_process_and_advisory_locks() };
    let mut host = WasmHostIO;

    let tid = timerid as usize;
    let result = match proc.posix_timers.get(tid) {
        Some(Some(t)) => t.overrun_last,
        _ => return -(Errno::EINVAL as i32),
    };

    deliver_pending_signals_with_locks(proc, advisory_locks, &mut host);
    result
}

/// timer_delete(timerid)
#[unsafe(no_mangle)]
pub extern "C" fn kernel_timer_delete(timerid: i32) -> i32 {
    let (_gkl, proc, advisory_locks) = unsafe { get_process_and_advisory_locks() };
    let mut host = WasmHostIO;

    let tid = timerid as usize;
    match proc.posix_timers.get(tid) {
        Some(Some(_)) => {}
        _ => return -(Errno::EINVAL as i32),
    }

    // Disarm the host timer
    let _ = host.host_set_posix_timer(timerid, 0, 0, 0);
    proc.remove_posix_timer_notification(timerid as u32);
    proc.posix_timers[tid] = None;

    deliver_pending_signals_with_locks(proc, advisory_locks, &mut host);
    0
}

/// Backward-compatible interval hook for hosts predating
/// `kernel_posix_timer_fire`. Its return contract is unchanged: zero tells the
/// legacy host to queue a process-wide signal, while one suppresses an overrun.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_posix_timer_interval_fire(pid: u32, timer_id: u32) -> i32 {
    let table = unsafe { &mut *PROCESS_TABLE.0.get() };
    match table.get_mut(pid) {
        Some(proc) => proc.note_legacy_posix_timer_interval_fire(timer_id) as i32,
        None => 0,
    }
}

// ---------------------------------------------------------------------------
// sigsuspend
// ---------------------------------------------------------------------------

/// Temporarily replace the signal mask and suspend until a signal is delivered.
/// The mask is passed as two u32 halves (lo, hi) to form a u64.
/// Always returns negative EINTR on success (signal was delivered).
#[unsafe(no_mangle)]
pub extern "C" fn kernel_sigsuspend(mask_lo: u32, mask_hi: u32) -> i32 {
    let (_gkl, proc, advisory_locks) = unsafe { get_process_and_advisory_locks() };
    let mut host = WasmHostIO;
    let mask = ((mask_hi as u64) << 32) | (mask_lo as u64);
    let result = match syscalls::sys_sigsuspend(proc, &mut host, mask) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    };
    deliver_pending_signals_with_locks(proc, advisory_locks, &mut host);
    result
}

/// pause -- suspend until a signal is delivered.
/// Always returns negative EINTR.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_pause() -> i32 {
    let (_gkl, proc, advisory_locks) = unsafe { get_process_and_advisory_locks() };
    let mut host = WasmHostIO;
    let result = match syscalls::sys_pause(proc, &mut host) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    };
    deliver_pending_signals_with_locks(proc, advisory_locks, &mut host);
    result
}

/// rt_sigtimedwait -- wait for a signal from a specified set.
/// mask is passed as (lo, hi) u32 halves. timeout_ms is in milliseconds (-1 for infinite).
/// Returns signal number on success, negative errno on error.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_rt_sigtimedwait(mask_lo: u32, mask_hi: u32, timeout_ms: i32) -> i32 {
    let (_gkl, proc, advisory_locks) = unsafe { get_process_and_advisory_locks() };
    let mut host = WasmHostIO;
    let mask = ((mask_hi as u64) << 32) | (mask_lo as u64);
    let result = match syscalls::sys_sigtimedwait(proc, &mut host, mask, timeout_ms) {
        Ok((sig, ..)) => sig as i32,
        Err(e) => -(e as i32),
    };
    deliver_pending_signals_with_locks(proc, advisory_locks, &mut host);
    result
}

/// pathconf -- get configurable pathname variable for a path.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_pathconf(
    path_ptr: *const u8,
    path_len: u32,
    name: i32,
    value_ptr: *mut i64,
) -> i32 {
    if path_ptr.is_null() || value_ptr.is_null() {
        return -(Errno::EFAULT as i32);
    }
    let (_gkl, proc, advisory_locks) = unsafe { get_process_and_advisory_locks() };
    let path = unsafe { core::slice::from_raw_parts(path_ptr, path_len as usize) };
    let mut host = WasmHostIO;
    let result = match syscalls::sys_pathconf(proc, &mut host, path, name) {
        Ok(value) => {
            unsafe { core::ptr::write_unaligned(value_ptr, value.unwrap_or(-1)) };
            0
        }
        Err(e) => -(e as i32),
    };
    deliver_pending_signals_with_locks(proc, advisory_locks, &mut host);
    result
}

/// fpathconf -- get configurable pathname variable for an open fd.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_fpathconf(fd: i32, name: i32, value_ptr: *mut i64) -> i32 {
    if value_ptr.is_null() {
        return -(Errno::EFAULT as i32);
    }
    let (_gkl, proc, advisory_locks) = unsafe { get_process_and_advisory_locks() };
    let mut host = WasmHostIO;
    let result = match syscalls::sys_fpathconf(proc, &mut host, fd, name) {
        Ok(value) => {
            unsafe { core::ptr::write_unaligned(value_ptr, value.unwrap_or(-1)) };
            0
        }
        Err(e) => -(e as i32),
    };
    deliver_pending_signals_with_locks(proc, advisory_locks, &mut host);
    result
}

/// getsockname -- get local socket address.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_getsockname(fd: i32, buf_ptr: *mut u8, addrlen_ptr: *mut u32) -> i32 {
    let (_gkl, proc, advisory_locks) = unsafe { get_process_and_advisory_locks() };
    // addrlen_ptr points to a u32 containing the buffer size (channel-rewritten pointer)
    let addrlen = if !addrlen_ptr.is_null() {
        unsafe { *addrlen_ptr }
    } else {
        0
    };
    let result = if addrlen == 0 {
        // WHY: callers may use a zero-capacity address buffer. Do not pass its
        // semantically unused pointer to Rust's non-null raw-slice API.
        syscalls::sys_getsockname(proc, fd, &mut [])
    } else if buf_ptr.is_null() {
        Err(Errno::EFAULT)
    } else {
        // SAFETY: the host staged exactly addrlen output bytes in
        // capacity-checked kernel scratch.
        let buf = unsafe { core::slice::from_raw_parts_mut(buf_ptr, addrlen as usize) };
        syscalls::sys_getsockname(proc, fd, buf)
    };
    let result = match result {
        Ok(n) => {
            // Write actual addrlen back
            if !addrlen_ptr.is_null() {
                unsafe {
                    *addrlen_ptr = n as u32;
                }
            }
            0 // getsockname returns 0 on success
        }
        Err(e) => -(e as i32),
    };
    let mut host = WasmHostIO;
    deliver_pending_signals_with_locks(proc, advisory_locks, &mut host);
    result
}

/// getpeername -- get remote socket address.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_getpeername(fd: i32, buf_ptr: *mut u8, addrlen_ptr: *mut u32) -> i32 {
    let (_gkl, proc, advisory_locks) = unsafe { get_process_and_advisory_locks() };
    let addrlen = if !addrlen_ptr.is_null() {
        unsafe { *addrlen_ptr }
    } else {
        0
    };
    let result = if addrlen == 0 {
        // WHY: callers may use a zero-capacity address buffer. Do not pass its
        // semantically unused pointer to Rust's non-null raw-slice API.
        syscalls::sys_getpeername(proc, fd, &mut [])
    } else if buf_ptr.is_null() {
        Err(Errno::EFAULT)
    } else {
        // SAFETY: the host staged exactly addrlen output bytes in
        // capacity-checked kernel scratch.
        let buf = unsafe { core::slice::from_raw_parts_mut(buf_ptr, addrlen as usize) };
        syscalls::sys_getpeername(proc, fd, buf)
    };
    let result = match result {
        Ok(n) => {
            if !addrlen_ptr.is_null() {
                unsafe {
                    *addrlen_ptr = n as u32;
                }
            }
            0
        }
        Err(e) => -(e as i32),
    };
    let mut host = WasmHostIO;
    deliver_pending_signals_with_locks(proc, advisory_locks, &mut host);
    result
}

/// Resolve a hostname to an IP address. Returns bytes written or negative errno.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_getaddrinfo(
    name_ptr: *const u8,
    name_len: u32,
    result_ptr: *mut u8,
) -> i32 {
    const IPV4_RESULT_BYTES: usize = 4;
    let (_gkl, proc, advisory_locks) = unsafe { get_process_and_advisory_locks() };
    let mut host = WasmHostIO;
    let name = unsafe { slice::from_raw_parts(name_ptr, name_len as usize) };
    // WHY: the musl caller owns exactly four bytes for this IPv4-only private
    // syscall. Treating the following scratch bytes as capacity would recreate
    // the allocation-vs-total-memory bug even if today's host writes only IPv4.
    let result_buf = unsafe { slice::from_raw_parts_mut(result_ptr, IPV4_RESULT_BYTES) };
    match syscalls::sys_getaddrinfo(proc, &mut host, name, result_buf) {
        Ok(n) => n as i32,
        Err(e) => -(e as i32),
    }
}

// ---------------------------------------------------------------------------
// Thread identity
// ---------------------------------------------------------------------------

/// gettid - returns pid for the main thread or the host-bound worker TID.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_gettid() -> i32 {
    let (_gkl, proc, advisory_locks) = unsafe { get_process_and_advisory_locks() };
    syscalls::sys_gettid(proc)
}

/// set_tid_address - stores the calling worker thread's clear-TID pointer.
///
/// This is part of the musl pthread syscall ABI Kandelo supports so POSIX
/// pthreads can join and clean up correctly; it is not a promise of Linux
/// kernel compatibility.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_set_tid_address(tidptr: usize) -> i32 {
    let (_gkl, proc, advisory_locks) = unsafe { get_process_and_advisory_locks() };
    syscalls::sys_set_tid_address(proc, tidptr)
}

/// set_robust_list — stores the robust list head pointer (no-op for now).
#[unsafe(no_mangle)]
pub extern "C" fn kernel_set_robust_list(_head: usize, _len: usize) -> i32 {
    match syscalls::sys_set_robust_list() {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    }
}

/// get_robust_list — returns 0 to indicate robust list support.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_get_robust_list(_pid: u32, _head_ptr: usize, _len_ptr: usize) -> i32 {
    0
}

/// thread_exit — clean up thread state in the kernel.
/// Called by the host when a thread Worker exits.
/// Removes the thread from the process's thread table and returns the
/// CLONE_CHILD_CLEARTID pointer recorded in ThreadInfo, or 0 if no clear-tid
/// wake is needed. Errors are returned as negative errno values.
///
/// WHY: an i64 keeps every wasm32 `usize` pointer nonnegative while reserving
/// negative results for errno; narrowing to i32 would make high pointers
/// indistinguishable from failures.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_thread_exit(pid: u32, tid: u32) -> i64 {
    let _gkl = GklGuard::acquire();
    let pt = unsafe { &mut *PROCESS_TABLE.0.get() };
    match kernel_thread_exit_in_table(pt, pid, tid) {
        Ok(ctid_ptr) => ctid_ptr as i64,
        Err(e) => -(e as i64),
    }
}

fn kernel_thread_exit_in_table(
    pt: &mut crate::process_table::ProcessTable,
    pid: u32,
    tid: u32,
) -> Result<usize, Errno> {
    let (proc, locks) = pt.process_and_advisory_locks(pid).ok_or(Errno::ESRCH)?;
    let mut host = WasmHostIO;
    syscalls::cleanup_exiting_thread_with_state(proc, locks, &mut host, tid)
        .map(|thread| thread.ctid_ptr)
}

#[cfg(test)]
mod thread_exit_tests {
    use super::*;

    #[test]
    fn thread_exit_rejects_unknown_or_wrong_owner_and_removes_exact_task() {
        let mut pt = crate::process_table::ProcessTable::new();
        let first = pt.create_process().unwrap();
        let second = pt.create_process().unwrap();
        let tid = pt.create_thread(first, first, 0, 0, 0x2000).unwrap();

        assert_eq!(
            kernel_thread_exit_in_table(&mut pt, second, tid),
            Err(Errno::ESRCH)
        );
        assert!(pt.get(first).unwrap().get_thread(tid).is_some());
        assert_eq!(kernel_thread_exit_in_table(&mut pt, first, tid), Ok(0x2000));
        assert!(pt.get(first).unwrap().get_thread(tid).is_none());
        assert_eq!(
            kernel_thread_exit_in_table(&mut pt, first, tid),
            Err(Errno::ESRCH)
        );
        assert_eq!(
            kernel_thread_exit_in_table(&mut pt, 9_999, tid),
            Err(Errno::ESRCH)
        );
    }
}

/// futex — real implementation via host Atomics.wait/notify.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_futex(
    uaddr: usize,
    op: u32,
    val: u32,
    timeout: u32,
    uaddr2: usize,
    val3: u32,
) -> i32 {
    let _gkl = GklGuard::acquire();
    let mut host = WasmHostIO;
    match syscalls::sys_futex(&mut host, uaddr, op, val, timeout, uaddr2, val3) {
        Ok(n) => n,
        Err(e) => -(e as i32),
    }
}

// ---------------------------------------------------------------------------
// ppoll / pselect6
// ---------------------------------------------------------------------------

/// ppoll — poll with atomic signal mask swap.
/// has_mask: 1 if a signal mask was provided (even if all-zero), 0 if NULL.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_ppoll(
    fds_ptr: *mut u8,
    nfds: u32,
    timeout_ms: i32,
    has_mask: u32,
    mask_lo: u32,
    mask_hi: u32,
) -> i32 {
    let (_gkl, proc, advisory_locks) = unsafe { get_process_and_advisory_locks() };
    let fds = unsafe {
        slice::from_raw_parts_mut(fds_ptr as *mut wasm_posix_shared::WasmPollFd, nfds as usize)
    };
    let mask = if has_mask != 0 {
        Some(((mask_hi as u64) << 32) | (mask_lo as u64))
    } else {
        None
    };
    let mut host = WasmHostIO;
    let result = match syscalls::sys_ppoll(proc, &mut host, fds, timeout_ms, mask) {
        Ok(n) => n,
        Err(e) => -(e as i32),
    };
    deliver_pending_signals_with_locks(proc, advisory_locks, &mut host);
    result
}

/// pselect6 — select with atomic signal mask swap.
/// has_mask: 1 if a signal mask was provided (even if all-zero), 0 if NULL.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_pselect6(
    nfds: i32,
    readfds_ptr: *mut u8,
    writefds_ptr: *mut u8,
    exceptfds_ptr: *mut u8,
    timeout_ms: i32,
    has_mask: u32,
    mask_lo: u32,
    mask_hi: u32,
) -> i32 {
    let (_gkl, proc, advisory_locks) = unsafe { get_process_and_advisory_locks() };

    let readfds = if readfds_ptr.is_null() {
        None
    } else {
        Some(unsafe {
            core::slice::from_raw_parts_mut(readfds_ptr, wasm_posix_shared::select::FD_SET_BYTES)
        })
    };
    let writefds = if writefds_ptr.is_null() {
        None
    } else {
        Some(unsafe {
            core::slice::from_raw_parts_mut(writefds_ptr, wasm_posix_shared::select::FD_SET_BYTES)
        })
    };
    let exceptfds = if exceptfds_ptr.is_null() {
        None
    } else {
        Some(unsafe {
            core::slice::from_raw_parts_mut(exceptfds_ptr, wasm_posix_shared::select::FD_SET_BYTES)
        })
    };

    let mask = if has_mask != 0 {
        Some(((mask_hi as u64) << 32) | (mask_lo as u64))
    } else {
        None
    };

    let mut host = WasmHostIO;
    let result = match syscalls::sys_pselect6(
        proc, &mut host, nfds, readfds, writefds, exceptfds, timeout_ms, mask,
    ) {
        Ok(n) => n,
        Err(e) => -(e as i32),
    };
    deliver_pending_signals_with_locks(proc, advisory_locks, &mut host);
    result
}

// ---------------------------------------------------------------------------
// TCP bridge exports — used by the host to inject external TCP connections
// into the kernel's pipe-buffer-backed socket system.
// ---------------------------------------------------------------------------

/// Inject an external TCP connection into a listening socket's backlog.
///
/// Called by the host when a real TCP connection arrives. Pre-allocates
/// pipe buffers in the global pipe table and pushes a `PendingConnection`
/// onto the listener's shared accept queue. Any process that has the
/// listener fd open (the original bound process or any fork-inherited
/// copy) can then pop the entry via `accept()` and create its own
/// accepted SocketInfo, matching POSIX shared-listener semantics.
///
/// `pid`+`listener_fd` are still required so the host can locate the
/// listener (and so we can fail with ESRCH/EBADF/ENOTSOCK if the host
/// passed something stale), but the routing of which process eventually
/// accepts is no longer determined here — workers race for it via accept().
///
/// Returns the recv_pipe_idx on success (host derives send_pipe_idx = recv_pipe_idx + 1),
/// or negative errno on error.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_inject_connection(
    pid: u32,
    listener_fd: i32,
    peer_addr_a: u32,
    peer_addr_b: u32,
    peer_addr_c: u32,
    peer_addr_d: u32,
    peer_port: u32,
) -> i32 {
    use crate::ofd::FileType;
    use crate::pipe::PipeBuffer;
    use crate::socket::{PendingConnection, SocketState};

    let table = unsafe { &mut *PROCESS_TABLE.0.get() };
    let proc = match table.get_mut(pid) {
        Some(p) => p,
        None => return -(Errno::ESRCH as i32),
    };

    // Look up the listener socket via fd
    let entry = match proc.fd_table.get(listener_fd) {
        Ok(e) => e,
        Err(e) => return -(e as i32),
    };
    let ofd = match proc.ofd_table.get(entry.ofd_ref.0) {
        Some(o) => o,
        None => return -(Errno::EBADF as i32),
    };
    if ofd.file_type != FileType::Socket {
        return -(Errno::ENOTSOCK as i32);
    }
    let listener_idx = (-(ofd.host_handle + 1)) as usize;

    let sock = match proc.sockets.get(listener_idx) {
        Some(s) => s,
        None => return -(Errno::EBADF as i32),
    };
    if sock.state != SocketState::Listening {
        return -(Errno::EINVAL as i32);
    }
    let shared_idx = match sock.shared_backlog_idx {
        Some(i) => i,
        // Should always be set for AF_INET/AF_INET6 listeners (sys_listen allocates
        // it). Defensive: refuse the inject rather than fall back to a
        // per-process backlog that fork siblings can't see.
        None => return -(Errno::EINVAL as i32),
    };
    let accept_wake_idx = sock.accept_wake_idx;

    // Allocate the recv/send pipes in the GLOBAL pipe table so any process
    // sharing this listener can read/write them after accept(). The host
    // TCP bridge assumes the indices are consecutive (it derives
    // sendPipeIdx as recvPipeIdx + 1), so use alloc_pair which preserves
    // that invariant even when the free list is in play.
    let pipe_table = unsafe { crate::pipe::global_pipe_table() };
    let (recv_pipe_idx, send_pipe_idx) =
        pipe_table.alloc_pair(PipeBuffer::new(65536), PipeBuffer::new(65536));

    let pc = PendingConnection {
        peer_addr: [
            peer_addr_a as u8,
            peer_addr_b as u8,
            peer_addr_c as u8,
            peer_addr_d as u8,
        ],
        peer_addr6: [0; 16],
        peer_is_ipv6: false,
        peer_port: peer_port as u16,
        peer_pid: 0,
        peer_sock_idx: None,
        recv_pipe_idx,
        send_pipe_idx,
    };
    let pushed = unsafe { crate::socket::shared_listener_backlog_table().push(shared_idx, pc) };
    if !pushed {
        // Slot was freed (last listener closed concurrently) — release pipes
        pipe_table.discard_unclaimed(recv_pipe_idx);
        pipe_table.discard_unclaimed(send_pipe_idx);
        return -(Errno::EBADF as i32);
    }

    if let Some(idx) = accept_wake_idx {
        crate::wakeup::push_accept(idx);
    }

    recv_pipe_idx as i32
}

/// Inject a UDP datagram into the kernel's AF_INET SOCK_DGRAM receive path.
///
/// The host virtual-network backend calls this after routing a datagram to a
/// machine. The datagram is delivered only to sockets owned by `pid` whose
/// bound address/port and connected-peer filter accept the source.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_inject_datagram(
    pid: u32,
    dst_addr_a: u32,
    dst_addr_b: u32,
    dst_addr_c: u32,
    dst_addr_d: u32,
    dst_port: u32,
    src_addr_a: u32,
    src_addr_b: u32,
    src_addr_c: u32,
    src_addr_d: u32,
    src_port: u32,
    data_ptr: *const u8,
    data_len: u32,
) -> i32 {
    let data = unsafe { slice::from_raw_parts(data_ptr, data_len as usize) };
    let table = unsafe { &mut *PROCESS_TABLE.0.get() };
    let proc = match table.get_mut(pid) {
        Some(p) => p,
        None => return -(Errno::ESRCH as i32),
    };
    syscalls::inject_udp_datagram_into(
        proc,
        [
            dst_addr_a as u8,
            dst_addr_b as u8,
            dst_addr_c as u8,
            dst_addr_d as u8,
        ],
        dst_port as u16,
        [
            src_addr_a as u8,
            src_addr_b as u8,
            src_addr_c as u8,
            src_addr_d as u8,
        ],
        src_port as u16,
        data,
    )
}

/// Read data from a pipe buffer into kernel memory.
/// Returns number of bytes read, or negative errno.
///
/// `pid` is ignored for ABI compatibility; `pipe_idx` addresses the global
/// pipe table.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_pipe_read(
    _pid: u32,
    pipe_idx: u32,
    buf_ptr: *mut u8,
    buf_len: u32,
) -> i32 {
    let buf = unsafe { slice::from_raw_parts_mut(buf_ptr, buf_len as usize) };
    let read = {
        let pipe_table = unsafe { crate::pipe::global_pipe_table() };
        let pipe = match pipe_table.get_mut(pipe_idx as usize) {
            Some(p) => p,
            None => return -(Errno::EBADF as i32),
        };
        pipe.recv_plain(buf, false)
    };
    // WHY: this trusted host path normally addresses only host-injected TCP
    // pipes, but using the message-aware primitive keeps a future caller from
    // silently leaking SCM_RIGHTS if that ownership boundary broadens. The
    // table borrow above must end before cleanup re-enters it.
    finish_machine_scm_rights_cleanup_if_pending();
    read.bytes_read as i32
}

/// Write data from kernel memory into a pipe buffer.
/// Returns number of bytes written, or negative errno.
///
/// `pid` is ignored for ABI compatibility; `pipe_idx` addresses the global
/// pipe table.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_pipe_write(
    _pid: u32,
    pipe_idx: u32,
    buf_ptr: *const u8,
    buf_len: u32,
) -> i32 {
    let buf = unsafe { slice::from_raw_parts(buf_ptr, buf_len as usize) };
    let pipe_table = unsafe { crate::pipe::global_pipe_table() };
    let pipe = match pipe_table.get_mut(pipe_idx as usize) {
        Some(p) => p,
        None => return -(Errno::EBADF as i32),
    };
    pipe.write(buf) as i32
}

/// Close the write end of a pipe buffer (signals EOF to the reader).
/// Returns 0 on success, negative errno on error.
///
/// `pid` is ignored for ABI compatibility; `pipe_idx` addresses the global
/// pipe table.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_pipe_close_write(_pid: u32, pipe_idx: u32) -> i32 {
    {
        let pipe_table = unsafe { crate::pipe::global_pipe_table() };
        let pipe = match pipe_table.get_mut(pipe_idx as usize) {
            Some(p) => p,
            None => return -(Errno::EBADF as i32),
        };
        pipe.close_write_end();
        // free_if_closed also collects ancillary queues whose only remaining
        // readers are themselves in flight.
        pipe_table.free_if_closed(pipe_idx as usize);
    }
    // WHY: collection can recursively drop SCM_RIGHTS even though closing a
    // write end does not directly consume a message. Re-enter resource tables
    // only after the pipe-table borrow above has ended.
    finish_machine_scm_rights_cleanup_if_pending();
    0
}

/// Close the read end of a pipe buffer (signals to the writer that nobody is reading).
/// Returns 0 on success, negative errno on error.
///
/// `pid` is ignored for ABI compatibility; `pipe_idx` addresses the global
/// pipe table.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_pipe_close_read(_pid: u32, pipe_idx: u32) -> i32 {
    {
        let pipe_table = unsafe { crate::pipe::global_pipe_table() };
        let pipe = match pipe_table.get_mut(pipe_idx as usize) {
            Some(p) => p,
            None => return -(Errno::EBADF as i32),
        };
        pipe.close_read_end();
        pipe_table.free_if_closed(pipe_idx as usize);
    }
    // WHY: close_read_end drops any stream rights that can no longer be
    // received. Defer host/backing cleanup until the pipe-table borrow has
    // ended, while keeping the ordinary host-TCP path to one queue check.
    finish_machine_scm_rights_cleanup_if_pending();
    0
}

/// Check if a pipe's write end is still open.
/// Returns 1 if open, 0 if closed, negative errno on error.
///
/// `pid` is ignored for ABI compatibility; `pipe_idx` addresses the global
/// pipe table.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_pipe_is_write_open(_pid: u32, pipe_idx: u32) -> i32 {
    let pipe_table = unsafe { crate::pipe::global_pipe_table() };
    let pipe = match pipe_table.get(pipe_idx as usize) {
        Some(p) => p,
        None => return -(Errno::EBADF as i32),
    };
    if pipe.is_write_end_open() {
        1
    } else {
        0
    }
}

/// Check if a pipe accepts writes through a real reader or TCP discard sink.
/// Returns 1 if open, 0 if closed, negative errno on error.
///
/// `pid` is ignored for ABI compatibility; `pipe_idx` addresses the global
/// pipe table.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_pipe_is_read_open(_pid: u32, pipe_idx: u32) -> i32 {
    let pipe_table = unsafe { crate::pipe::global_pipe_table() };
    let pipe = match pipe_table.get(pipe_idx as usize) {
        Some(p) => p,
        None => return -(Errno::EBADF as i32),
    };
    if pipe.is_read_end_open() {
        1
    } else {
        0
    }
}

/// Check if a pipe has at least one application-owned reader.
/// Returns 1 for a real reader, 0 for a TCP discard sink or closed read end,
/// and negative errno on error.
///
/// `pid` is ignored for ABI compatibility; `pipe_idx` addresses the global
/// pipe table.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_pipe_has_readers(_pid: u32, pipe_idx: u32) -> i32 {
    let pipe_table = unsafe { crate::pipe::global_pipe_table() };
    let pipe = match pipe_table.get(pipe_idx as usize) {
        Some(p) => p,
        None => return -(Errno::EBADF as i32),
    };
    if pipe.has_readers() {
        1
    } else {
        0
    }
}

/// Look up the recv pipe index for a socket fd.
/// Returns the recv_buf_idx or -1 if the fd is not a connected socket.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_get_socket_recv_pipe(pid: u32, fd: i32) -> i32 {
    use crate::ofd::FileType;

    let table = unsafe { &*PROCESS_TABLE.0.get() };
    let proc = match table.get(pid) {
        Some(p) => p,
        None => return -1,
    };
    let entry = match proc.fd_table.get(fd) {
        Ok(e) => e,
        Err(_) => return -1,
    };
    let ofd = match proc.ofd_table.get(entry.ofd_ref.0) {
        Some(o) => o,
        None => return -1,
    };
    if ofd.file_type != FileType::Socket {
        return -1;
    }
    let sock_idx = (-(ofd.host_handle + 1)) as usize;
    let sock = match proc.sockets.get(sock_idx) {
        Some(s) => s,
        None => return -1,
    };
    match sock.recv_buf_idx {
        Some(idx) => idx as i32,
        None => -1,
    }
}

/// Look up the pipe/buffer index for a fd (for reading).
/// For pipe fds: returns the pipe index.
/// For socket fds: returns recv_buf_idx.
/// Returns -1 if the fd is not a pipe or connected socket.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_get_fd_pipe_idx(pid: u32, fd: i32) -> i32 {
    use crate::ofd::FileType;

    let table = unsafe { &*PROCESS_TABLE.0.get() };
    let proc = match table.get(pid) {
        Some(p) => p,
        None => return -1,
    };
    let entry = match proc.fd_table.get(fd) {
        Ok(e) => e,
        Err(_) => return -1,
    };
    let ofd = match proc.ofd_table.get(entry.ofd_ref.0) {
        Some(o) => o,
        None => return -1,
    };
    match ofd.file_type {
        FileType::Pipe if ofd.host_handle < 0 => (-(ofd.host_handle + 1)) as i32,
        FileType::Socket => {
            let sock_idx = (-(ofd.host_handle + 1)) as usize;
            match proc.sockets.get(sock_idx) {
                Some(sock) => match sock.recv_buf_idx {
                    Some(idx) => idx as i32,
                    None => -1,
                },
                None => -1,
            }
        }
        _ => -1,
    }
}

/// Look up the accept-readiness wake token for a listening socket fd.
/// Returns -1 if the fd is not a listening socket with a wake token.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_get_fd_accept_wake_idx(pid: u32, fd: i32) -> i32 {
    let table = unsafe { &*PROCESS_TABLE.0.get() };
    let Some(proc) = table.get(pid) else {
        return -1;
    };
    let Ok(entry) = proc.fd_table.get(fd) else {
        return -1;
    };
    syscalls::listener_accept_wake_for_entry(proc, entry)
        .map(|idx| idx as i32)
        .unwrap_or(-1)
}

/// Find the lowest live listener fd carrying `wake_idx` in `pid`.
///
/// The wake token identifies the shared listener/open-description state across
/// descriptor aliases. Iterating the kernel fd table lets the host remap a
/// listener mirror after exec closes a CLOEXEC alias without guessing the
/// process's current `RLIMIT_NOFILE` ceiling.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_find_listener_fd_by_accept_wake(pid: u32, wake_idx: u32) -> i32 {
    let table = unsafe { &*PROCESS_TABLE.0.get() };
    table
        .get(pid)
        .and_then(|proc| syscalls::find_listener_fd_by_accept_wake(proc, wake_idx))
        .unwrap_or(-1)
}

/// Check if a file descriptor has O_NONBLOCK set.
/// Returns 1 if non-blocking, 0 if blocking, -1 if fd not found.
///
/// Recognizes regular fds from the process fd/ofd tables AND mqueue
/// descriptors (from the global MqueueTable; descriptor numbers are in the
/// 0x40000000+ range and not in any `proc.fd_table`). This lets the host's
/// handleBlockingRetry use a single nonblock check for both real fds and
/// mq_timedsend/mq_timedreceive.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_is_fd_nonblock(pid: u32, fd: i32) -> i32 {
    // mqueue descriptors live in a separate global table.
    let mq_table = unsafe { crate::mqueue::global_mqueue_table() };
    if let Some(nb) = mq_table.is_nonblock(fd as u32) {
        return if nb { 1 } else { 0 };
    }

    let table = unsafe { &*PROCESS_TABLE.0.get() };
    let proc = match table.get(pid) {
        Some(p) => p,
        None => return -1,
    };
    let entry = match proc.fd_table.get(fd) {
        Ok(e) => e,
        Err(_) => return -1,
    };
    let ofd = match proc.ofd_table.get(entry.ofd_ref.0) {
        Some(o) => o,
        None => return -1,
    };
    if ofd.file_type == crate::ofd::FileType::PcmPlayback {
        return match crate::audio::is_nonblock(ofd.host_handle) {
            Ok(true) => 1,
            Ok(false) => 0,
            Err(_) => -1,
        };
    }
    if ofd.status_flags() & wasm_posix_shared::flags::O_NONBLOCK != 0 {
        1
    } else {
        0
    }
}

/// Get socket timeout in milliseconds for a fd.
/// is_recv: 1 = SO_RCVTIMEO, 0 = SO_SNDTIMEO.
/// Returns timeout in ms, 0 if no timeout, -1 if fd is not a socket.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_get_socket_timeout_ms(pid: u32, fd: i32, is_recv: i32) -> i64 {
    use crate::ofd::FileType;

    let table = unsafe { &*PROCESS_TABLE.0.get() };
    let proc = match table.get(pid) {
        Some(p) => p,
        None => return -1,
    };
    let entry = match proc.fd_table.get(fd) {
        Ok(e) => e,
        Err(_) => return -1,
    };
    let ofd = match proc.ofd_table.get(entry.ofd_ref.0) {
        Some(o) => o,
        None => return -1,
    };
    if ofd.file_type != FileType::Socket {
        return -1;
    }
    let sock_idx = (-(ofd.host_handle + 1)) as usize;
    let sock = match proc.sockets.get(sock_idx) {
        Some(s) => s,
        None => return -1,
    };
    let timeout_us = if is_recv != 0 {
        sock.recv_timeout_us
    } else {
        sock.send_timeout_us
    };
    // Convert microseconds to milliseconds (round up to avoid 0ms for non-zero timeouts)
    if timeout_us == 0 {
        0
    } else {
        ((timeout_us + 999) / 1000) as i64
    }
}

/// Look up the send pipe/buffer index for a fd (for writing).
/// For pipe fds: returns the pipe index.
/// For socket fds: returns send_buf_idx. For PCM playback: returns the
/// stream's writable-capacity wake token.
/// Returns -1 if the fd has no targeted writable wake token.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_get_fd_send_pipe_idx(pid: u32, fd: i32) -> i32 {
    use crate::ofd::FileType;

    let table = unsafe { &*PROCESS_TABLE.0.get() };
    let proc = match table.get(pid) {
        Some(p) => p,
        None => return -1,
    };
    let entry = match proc.fd_table.get(fd) {
        Ok(e) => e,
        Err(_) => return -1,
    };
    let ofd = match proc.ofd_table.get(entry.ofd_ref.0) {
        Some(o) => o,
        None => return -1,
    };
    match ofd.file_type {
        FileType::Pipe if ofd.host_handle < 0 => (-(ofd.host_handle + 1)) as i32,
        FileType::Socket => {
            let sock_idx = (-(ofd.host_handle + 1)) as usize;
            match proc.sockets.get(sock_idx) {
                Some(sock) => match sock.send_buf_idx {
                    Some(idx) => idx as i32,
                    None => -1,
                },
                None => -1,
            }
        }
        FileType::PcmPlayback => crate::audio::wake_token_for_handle(ofd.host_handle)
            .map(|token| token as i32)
            .unwrap_or(-1),
        _ => -1,
    }
}

// ── PTY host exports ──
// These exports allow the host to create and drive PTY pairs from outside
// the kernel's syscall channel (e.g. for browser xterm.js integration).

/// Create a PTY pair and wire fds 0/1/2 of `pid` to the slave side.
/// Returns the PTY index on success, or negative errno on failure.
///
/// This replaces the current stdin/stdout/stderr OFDs with a PtySlave so that
/// `isatty()` returns true and the process gets a real terminal.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_pty_create(pid: u32) -> i32 {
    use crate::fd::OpenFileDescRef;
    use crate::ofd::FileType;
    use wasm_posix_shared::flags::O_RDWR;

    let _gkl = GklGuard::acquire();
    let table = unsafe { &mut *PROCESS_TABLE.0.get() };
    let (proc, advisory_locks) = match table.process_and_advisory_locks(pid) {
        Some(fields) => fields,
        None => return -(Errno::ESRCH as i32),
    };

    // Allocate a new PTY pair
    let pty_idx = match crate::pty::alloc_pty(proc.effective_uid(), proc.effective_gid()) {
        Some(idx) => idx,
        None => return -(Errno::ENOSPC as i32),
    };

    // Configure the PTY pair
    {
        let pty = crate::pty::get_pty(pty_idx).unwrap();
        pty.locked = false; // unlockpt equivalent
        pty.slave_refs = 1; // one OFD references the slave
        pty.master_refs = 1; // host holds the master side

        // Set controlling terminal
        pty.terminal.session_id = pid as i32;
        pty.terminal.foreground_pgid = pid as i32;
    }

    // Create a PtySlave OFD. host_handle stores pty_idx for the kernel's
    // read/write handlers to find the right PTY pair.
    let path = {
        extern crate alloc;
        use alloc::format;
        format!("/dev/pts/{}", pty_idx).into_bytes()
    };
    let ofd_idx = proc
        .ofd_table
        .create(FileType::PtySlave, O_RDWR, pty_idx as i64, path);

    // Close the existing stdio descriptors through the normal machine path.
    // Directly replacing fd-table entries would bypass POSIX close-any-fd
    // cleanup, final-OFD/flock cleanup, and host/backing release.
    let mut host = WasmHostIO;
    for fd in 0..3i32 {
        if proc.fd_table.get(fd).is_ok() {
            if let Err(err) = syscalls::sys_close_with_locks(proc, advisory_locks, &mut host, fd) {
                // The close operation may already have consumed the old fd,
                // just as close(2) may report a late I/O failure. Drop the
                // not-yet-installed PTY OFD and its resource references.
                proc.ofd_table.dec_ref(ofd_idx);
                let should_free = if let Some(pty) = crate::pty::get_pty(pty_idx) {
                    if pty.slave_refs > 0 {
                        pty.slave_refs -= 1;
                    }
                    if pty.master_refs > 0 {
                        pty.master_refs -= 1;
                    }
                    !pty.is_alive()
                } else {
                    false
                };
                if should_free {
                    crate::pty::free_pty(pty_idx);
                }
                return -(err as i32);
            }
        }
    }

    // Point fds 0, 1, 2 to the shared PtySlave OFD (ref_count = 3)
    // The OFD was created with ref_count=1, so inc_ref twice more
    proc.ofd_table.inc_ref(ofd_idx);
    proc.ofd_table.inc_ref(ofd_idx);
    let _ = proc.fd_table.set_at(0, OpenFileDescRef(ofd_idx), 0);
    let _ = proc.fd_table.set_at(1, OpenFileDescRef(ofd_idx), 0);
    let _ = proc.fd_table.set_at(2, OpenFileDescRef(ofd_idx), 0);

    // Set the session ID on the process itself. kernel_pty_create implicitly
    // claims a new session (equivalent to setsid() + TIOCSCTTY in POSIX), so
    // mark the process as a session leader — this is what gates the setpgid
    // EPERM check and what forked children correctly DON'T inherit.
    proc.sid = pid;
    proc.is_session_leader = true;

    pty_idx as i32
}

/// Write data from the host (master side) to a PTY's input, processing
/// it through the line discipline. Returns bytes consumed.
///
/// If ISIG is enabled and a signal character is received (Ctrl-C, Ctrl-\,
/// Ctrl-Z), the corresponding signal is raised on the foreground process group.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_pty_master_write(pty_idx: u32, buf_ptr: *const u8, buf_len: u32) -> i32 {
    let pty = match crate::pty::get_pty(pty_idx as usize) {
        Some(p) => p,
        None => return -(Errno::ENOENT as i32),
    };

    let data = unsafe { core::slice::from_raw_parts(buf_ptr, buf_len as usize) };

    // Collect signals generated by ISIG processing.
    // We need the foreground pgid from the PTY before we borrow the process table.
    let mut pending_signals: [(u32, i32); 3] = [(0, 0); 3];
    let mut signal_count = 0usize;

    for &byte in data {
        if let Some(signum) = pty.process_master_input(byte) {
            let fg_pgid = pty.terminal.foreground_pgid;
            if signal_count < pending_signals.len() {
                pending_signals[signal_count] = (signum, fg_pgid);
                signal_count += 1;
            }
        }
    }

    // Deliver any signals to the foreground process group (same pattern as SIGWINCH).
    if signal_count > 0 {
        let table = unsafe { &mut *PROCESS_TABLE.0.get() };
        for i in 0..signal_count {
            let (signum, fg_pgid) = pending_signals[i];
            if fg_pgid > 0 {
                let pids = table.pids_in_group(fg_pgid as u32);
                for pid in pids {
                    if let Some(proc) = table.get_mut(pid) {
                        proc.raise_signal(signum);
                    }
                }
            }
        }
    }

    // After writing input, wake any slave reader by ensuring data is available.
    // The host is responsible for calling scheduleWakeBlockedRetries().
    buf_len as i32
}

/// Read data from the PTY output buffer (master side reads slave's output).
/// Returns bytes read, or 0 if the output buffer is empty.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_pty_master_read(pty_idx: u32, buf_ptr: *mut u8, buf_len: u32) -> i32 {
    let pty = match crate::pty::get_pty(pty_idx as usize) {
        Some(p) => p,
        None => return -(Errno::ENOENT as i32),
    };

    let buf = unsafe { core::slice::from_raw_parts_mut(buf_ptr, buf_len as usize) };
    pty.master_read(buf) as i32
}

/// Set the window size of a PTY and send SIGWINCH to the foreground process group.
/// Returns 0 on success, negative errno on failure.
///
/// SIGWINCH is only raised when the new dimensions differ from the stored
/// dimensions. POSIX SIGWINCH semantics are "on actual size change", and
/// raising it on no-op calls would mid-render-interrupt TUIs that subscribe
/// to it (ink/blessed re-render on 'resize'), corrupting cursor accounting.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_pty_set_winsize(pty_idx: u32, rows: u32, cols: u32) -> i32 {
    let pty = match crate::pty::get_pty(pty_idx as usize) {
        Some(p) => p,
        None => return -(Errno::ENOENT as i32),
    };

    let new_rows = rows as u16;
    let new_cols = cols as u16;
    let changed =
        pty.terminal.winsize.ws_row != new_rows || pty.terminal.winsize.ws_col != new_cols;

    pty.terminal.winsize = crate::terminal::WinSize {
        ws_row: new_rows,
        ws_col: new_cols,
        ws_xpixel: 0,
        ws_ypixel: 0,
    };

    if !changed {
        return 0;
    }

    // Send SIGWINCH to foreground process group
    let fg_pgid = pty.terminal.foreground_pgid;
    if fg_pgid > 0 {
        let table = unsafe { &mut *PROCESS_TABLE.0.get() };
        let pids = table.pids_in_group(fg_pgid as u32);
        for pid in pids {
            if let Some(proc) = table.get_mut(pid) {
                proc.signals.raise(wasm_posix_shared::signal::SIGWINCH);
            }
        }
    }

    0
}

// ---------------------------------------------------------------------------
// /dev/input/mice — host-injected PS/2 packets
// ---------------------------------------------------------------------------

/// Push a single mouse motion / button event into the kernel-side queue
/// for `/dev/input/mice`. The host calls this when a canvas mouse event
/// fires; user processes consume the resulting PS/2 packets via `read()`.
///
/// `dx` / `dy` are in the PS/2 sense (positive dy = mouse moved up — the
/// host inverts browser deltaY before calling). Out-of-range values are
/// clamped to signed 8-bit by the kernel-side encoder. `buttons` is a
/// bitmask: bit 0 = left, 1 = right, 2 = middle.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_inject_mouse_event(dx: i32, dy: i32, buttons: u32) {
    crate::mouse::inject_event(dx, dy, buttons);
}

// ---------------------------------------------------------------------------
// /dev/dsp — host-drained PCM samples
// ---------------------------------------------------------------------------

/// Drain up to `out_len` bytes of PCM audio from the kernel-side ring
/// into the host-provided buffer. Returns the number of bytes copied.
///
/// This compatibility pull path is retained for hosts that do not claim the
/// shared-clock transport. Browser AudioWorklets and the Node clocked sink
/// consume the shared ring directly, and an exclusive transport claim prevents
/// this export from racing them. Reads stop on whole-frame boundaries so a
/// caller never receives a torn PCM frame.
///
/// `out_ptr` points into kernel-wasm memory — same pattern as
/// `kernel_drain_wakeup_events`. The host's scratch allocation is the
/// canonical landing zone.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_drain_audio(out_ptr: *mut u8, out_len: u32) -> u32 {
    let out = unsafe { slice::from_raw_parts_mut(out_ptr, out_len as usize) };
    crate::audio::drain_into(out) as u32
}

/// Read the currently configured `/dev/dsp` sample rate (Hz). Defaults
/// to 48000 Hz before the user program calls `SNDCTL_DSP_SPEED`.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_audio_sample_rate() -> u32 {
    crate::audio::current_config().0
}

/// Read the currently configured `/dev/dsp` channel count. Defaults to
/// 2 (stereo) before the user program calls `SNDCTL_DSP_STEREO` /
/// `SNDCTL_DSP_CHANNELS`.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_audio_channels() -> u32 {
    crate::audio::current_config().1
}

/// Bytes currently buffered in the `/dev/dsp` ring. Lets the host
/// estimate how much audio is queued ahead of the AudioContext clock.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_audio_pending() -> u32 {
    crate::audio::pending_bytes() as u32
}

/// Base pointer and length of the versioned PCM shared transport.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_pcm_transport_ptr() -> u32 {
    crate::audio::transport_ptr() as usize as u32
}

#[unsafe(no_mangle)]
pub extern "C" fn kernel_pcm_transport_len() -> u32 {
    crate::audio::transport_len()
}

/// Claim the single PCM consumer mode (legacy pull or shared audio clock).
#[unsafe(no_mangle)]
pub extern "C" fn kernel_pcm_claim_transport(mode: u32) -> i32 {
    match crate::audio::claim_transport(mode) {
        Ok(()) => 0,
        Err(error) => -(error as i32),
    }
}

/// Reconcile a host-written consumer cursor and publish writer wakeups.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_pcm_reconcile() -> i32 {
    crate::audio::reconcile()
}

/// Advance the Node/headless sink by an audio-clock frame budget.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_pcm_clock_update(frames: u32) -> u32 {
    crate::audio::clock_update(frames)
}

// ---------------------------------------------------------------------------
// Wakeup event drain
// ---------------------------------------------------------------------------

/// Drain pending wakeup events into the output buffer.
///
/// Each event is 5 bytes: wake index (u32 LE) + wake_type (u8).
/// Returns the number of events written.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_drain_wakeup_events(
    out_ptr: *mut u8,
    out_len: u32,
    max_events: u32,
) -> u32 {
    let out = unsafe { slice::from_raw_parts_mut(out_ptr, out_len as usize) };
    crate::wakeup::drain(out, max_events)
}

// ---------------------------------------------------------------------------
// DRI / KMS
// ---------------------------------------------------------------------------

/// Tick the global vblank sequence counter and return the new value.
///
/// The host runs this on a 16.67 ms RAF / setInterval pump in the
/// kernel worker; user programs that posted `DRM_IOCTL_WAIT_VBLANK`
/// observe the new sequence on the next syscall round-trip.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_vblank() -> u32 {
    crate::dri::vblank_tick()
}

/// Number of successful page-flip commits on the given crtc.
///
/// Useful for the host-side stats UI ("how many frames has the
/// compositor produced since boot"). Today only `crtc_id == 1` is
/// tracked; any other value returns 0.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_kms_commit_count(crtc_id: u32) -> u64 {
    crate::dri::kms_commit_count(crtc_id)
}

/// Microseconds between the two most recent successful page-flip
/// commits on the given crtc. Returns 0 if fewer than two flips have
/// landed. Lets the host expose a real wasm-side frame rate without
/// having to sample its own clock.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_kms_last_frame_us(crtc_id: u32) -> u64 {
    crate::dri::kms_last_frame_us(crtc_id)
}
