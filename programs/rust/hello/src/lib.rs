//! Kandelo Rust guest fixture (P0): no_std, proves rustc wasm32 codegen
//! links against Kandelo's musl sysroot and runs on the kernel.
//!
//! Kandelo's crt1 calls `__main_argc_argv(int argc, char **argv)` — the
//! symbol Clang mangles `int main(int, char**)` into. Rust has no such
//! mangling, so we export that exact symbol ourselves.
#![no_std]

use core::ffi::{c_char, c_int};
use core::panic::PanicInfo;

extern "C" {
    fn write(fd: c_int, buf: *const u8, count: usize) -> isize;
    fn _exit(code: c_int) -> !;
}

#[no_mangle]
pub extern "C" fn __main_argc_argv(_argc: c_int, _argv: *const *const c_char) -> c_int {
    let msg = b"Hello from no_std Rust on Kandelo!\n";
    unsafe {
        write(1, msg.as_ptr(), msg.len());
    }
    0
}

#[panic_handler]
fn panic(_info: &PanicInfo) -> ! {
    unsafe { _exit(101) }
}
