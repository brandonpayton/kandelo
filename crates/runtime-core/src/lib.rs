//! Engine-agnostic POSIX runtime for Kandelo.
//!
//! This crate holds every POSIX subsystem module and the `HostIO` capability
//! trait (re-exported as `HostCapabilities`). `crates/kernel` is the thin Wasm
//! FFI shell that depends on this crate; `crates/host-native` (a later phase)
//! will depend on it directly.
#![cfg_attr(any(target_arch = "wasm32", target_arch = "wasm64"), no_std)]
#![cfg_attr(target_arch = "wasm64", feature(simd_wasm64))]

extern crate alloc;
extern crate wasm_posix_shared;

pub mod audio;
pub mod blocked_retry;
pub mod channel_record_decode;
pub mod channel_result;
pub mod channel_scratch;
pub mod credentials;
pub mod descriptor_backing;
pub mod devfs;
pub mod dri;
pub mod exec_target;
pub mod fd;
pub mod fifo;
pub mod fork;
pub mod ipc;
pub mod ipc_wire;
pub mod lock;
pub mod memory;
pub mod mouse;
pub mod mqueue;
pub mod netif;
pub mod ofd;
pub mod path;
pub mod complete_copy;
pub mod pipe;
pub mod process;
pub mod process_snapshot_wire;
pub mod process_table;
pub mod process_wire;
pub mod procfs;
pub mod pshared;
pub mod pty;
pub mod rootfs;
pub mod scratch_alloc;
pub mod sffs;
pub mod signal;
pub mod socket;
pub mod socket_wire;
pub mod spawn;
pub mod syscalls;
pub mod terminal;
pub mod tmpfs;
pub mod transfer;
pub mod unix_socket;
pub mod wakeup;
pub mod zip;

// The engine-agnostic capability contract. `HostCapabilities` is the forward
// name for the Rust-first design; `HostIO` is kept as the primary name to
// avoid churning 645+ call sites in this phase.
pub use process::HostIO;
pub use process::HostIO as HostCapabilities;

// ---------------------------------------------------------------------------
// Debug logging (temporary)
// ---------------------------------------------------------------------------

#[cfg(any(target_arch = "wasm32", target_arch = "wasm64"))]
pub fn debug_log(msg: &str) {
    #[link(wasm_import_module = "env")]
    unsafe extern "C" {
        fn host_debug_log(ptr: *const u8, len: u32);
    }
    unsafe {
        host_debug_log(msg.as_ptr(), msg.len() as u32);
    }
}

#[cfg(not(any(target_arch = "wasm32", target_arch = "wasm64")))]
pub fn debug_log(_msg: &str) {}

// ---------------------------------------------------------------------------
// Current time helper
// ---------------------------------------------------------------------------

/// Get current real time in seconds (CLOCK_REALTIME).
/// On wasm32, calls the host import. On native (tests), returns 0.
pub fn current_time_secs() -> i64 {
    #[cfg(any(target_arch = "wasm32", target_arch = "wasm64"))]
    {
        #[link(wasm_import_module = "env")]
        unsafe extern "C" {
            fn host_clock_gettime(clock_id: u32, sec_ptr: *mut i64, nsec_ptr: *mut i64) -> i32;
        }
        let mut sec: i64 = 0;
        let mut nsec: i64 = 0;
        unsafe {
            host_clock_gettime(0, &mut sec as *mut i64, &mut nsec as *mut i64);
        }
        sec
    }
    #[cfg(not(any(target_arch = "wasm32", target_arch = "wasm64")))]
    {
        0
    }
}
