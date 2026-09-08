//! Kandelo Rust guest fixture (P1): no_std + `alloc` via a malloc-backed
//! global allocator. Exercises heap allocation (Vec, String, format!)
//! through Kandelo's musl and syscall channel.
#![no_std]

extern crate alloc;

use alloc::string::String;
use alloc::vec::Vec;
use core::alloc::{GlobalAlloc, Layout};
use core::ffi::{c_char, c_int, c_void};
use core::fmt::Write as _;
use core::panic::PanicInfo;
use core::ptr;

extern "C" {
    fn write(fd: c_int, buf: *const u8, count: usize) -> isize;
    fn _exit(code: c_int) -> !;
    fn malloc(size: usize) -> *mut c_void;
    fn free(ptr: *mut c_void);
    fn realloc(ptr: *mut c_void, size: usize) -> *mut c_void;
    fn posix_memalign(memptr: *mut *mut c_void, align: usize, size: usize) -> c_int;
}

struct MuslAlloc;

// musl malloc guarantees alignment for any object up to 2*sizeof(size_t)
// (8 bytes on wasm32). Stricter alignments go through posix_memalign.
const MALLOC_MIN_ALIGN: usize = 8;

unsafe impl GlobalAlloc for MuslAlloc {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        if layout.align() <= MALLOC_MIN_ALIGN {
            malloc(layout.size()) as *mut u8
        } else {
            let mut p: *mut c_void = ptr::null_mut();
            if posix_memalign(&mut p, layout.align(), layout.size()) != 0 {
                ptr::null_mut()
            } else {
                p as *mut u8
            }
        }
    }
    unsafe fn dealloc(&self, ptr: *mut u8, _layout: Layout) {
        free(ptr as *mut c_void);
    }
    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        if layout.align() <= MALLOC_MIN_ALIGN {
            realloc(ptr as *mut c_void, new_size) as *mut u8
        } else {
            let new_layout = Layout::from_size_align_unchecked(new_size, layout.align());
            let new_ptr = self.alloc(new_layout);
            if !new_ptr.is_null() {
                let copy = core::cmp::min(layout.size(), new_size);
                ptr::copy_nonoverlapping(ptr, new_ptr, copy);
                self.dealloc(ptr, layout);
            }
            new_ptr
        }
    }
}

#[global_allocator]
static ALLOC: MuslAlloc = MuslAlloc;

#[no_mangle]
pub extern "C" fn __main_argc_argv(_argc: c_int, _argv: *const *const c_char) -> c_int {
    let v: Vec<i32> = (1..=5).collect();
    let sum: i32 = v.iter().sum();
    let mut s = String::new();
    let _ = write!(s, "Rust alloc on Kandelo: sum(1..=5) = {}, vec = {:?}\n", sum, v);
    unsafe {
        write(1, s.as_ptr(), s.len());
    }
    0
}

#[panic_handler]
fn panic(_info: &PanicInfo) -> ! {
    let m = b"rust panic\n";
    unsafe {
        write(2, m.as_ptr(), m.len());
        _exit(101)
    }
}
