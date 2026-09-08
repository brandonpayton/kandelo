//! Linux-specific definitions.

#![stable(feature = "raw_ext", since = "1.1.0")]
#![doc(cfg(target_os = "linux"))]

pub mod fs;
// kandelo: reuses only `fs` and `raw` from this module. `net` and `process`
// pull in Linux-only sys internals (`os::net::linux_ext`, pidfd via
// `sys::pal::unix::linux`) that Kandelo does not provide, so they stay gated
// to real Linux (and doc builds).
#[cfg(any(target_os = "linux", doc))]
pub mod net;
#[cfg(any(target_os = "linux", doc))]
pub mod process;
pub mod raw;
