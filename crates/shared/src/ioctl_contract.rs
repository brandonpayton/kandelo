//! Request-aware `ioctl(2)` marshalling contract.
//!
//! Unlike ordinary syscalls, the third ioctl argument is selected by the
//! request number: it may be absent, an integer value, or a pointer to a
//! request-specific structure.  Keeping that distinction in one table lets
//! both the JavaScript host and Rust dispatcher prove the exact scratch
//! capacity before either side treats the argument as memory.

/// Linux/musl `struct termios` size for Kandelo's wasm32 and wasm64 targets.
///
/// musl uses four `tcflag_t` words, `cc_t c_line`, 32 control characters,
/// three bytes of alignment, and two `speed_t` words.
pub const TERMIOS_SIZE: u32 = 60;

// Generic fd ioctls.
pub const FIONREAD: u32 = 0x541b;
pub const FIONBIO: u32 = 0x5421;
pub const FIONCLEX: u32 = 0x5450;
pub const FIOCLEX: u32 = 0x5451;
pub const FIOASYNC: u32 = 0x5452;
pub const SIOCATMARK: u32 = 0x8905;

// Linux terminal and PTY ioctls.
pub const TCGETS: u32 = 0x5401;
pub const TCSETS: u32 = 0x5402;
pub const TCSETSW: u32 = 0x5403;
pub const TCSETSF: u32 = 0x5404;
pub const TCSBRK: u32 = 0x5409;
pub const TCXONC: u32 = 0x540a;
pub const TCFLSH: u32 = 0x540b;
pub const TIOCSCTTY: u32 = 0x540e;
pub const TIOCGPGRP: u32 = 0x540f;
pub const TIOCSPGRP: u32 = 0x5410;
pub const TIOCGWINSZ: u32 = 0x5413;
pub const TIOCSWINSZ: u32 = 0x5414;
pub const TIOCNOTTY: u32 = 0x5422;
pub const TIOCGSID: u32 = 0x5429;
pub const TIOCGPTN: u32 = 0x8004_5430;
pub const TIOCSPTLCK: u32 = 0x4004_5431;

// Linux VT keyboard ioctls.
pub const KDGKBTYPE: u32 = 0x4b33;
pub const KDGKBMODE: u32 = 0x4b44;
pub const KDSKBMODE: u32 = 0x4b45;

// Network-interface ioctls (fixed-size `struct ifreq` requests only).
// `SIOCGIFCONF` is deliberately absent: its `struct ifconf.ifc_buf` is a
// second, dynamically-sized process-memory pointer nested inside the first,
// which this table's one-static-size-per-request model cannot express. The
// host still decodes that outer pointer (the same reason `sendmsg`/`recvmsg`
// decompose `msghdr` host-side elsewhere), but the content it writes comes
// from `runtime_core::netif` via the dedicated `kernel_network_ifconf_*`
// kernel exports, not from host-side interface/MAC/address logic.
pub const SIOCGIFNAME: u32 = 0x8910;
pub const SIOCGIFCONF: u32 = 0x8912;
pub const SIOCGIFADDR: u32 = 0x8915;
pub const SIOCGIFHWADDR: u32 = 0x8927;
pub const SIOCGIFINDEX: u32 = 0x8933;

/// How the request's third argument is represented by the caller.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IoctlArgKind {
    None,
    ScalarI32,
    Pointer,
}

/// Bytes the host must copy for a pointer request.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IoctlDirection {
    None,
    In,
    Out,
    InOut,
}

/// One supported ioctl request and its caller-data-model-specific wire size.
///
/// A `None` size means that the request number is known but that caller data
/// model is unsupported.  This is intentionally distinct from an unknown
/// request so the dispatcher can reject a would-be lossy conversion.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct IoctlRequestContract {
    pub request: u32,
    pub arg_kind: IoctlArgKind,
    pub direction: IoctlDirection,
    pub wasm32_size: Option<u32>,
    pub wasm64_size: Option<u32>,
}

impl IoctlRequestContract {
    pub const fn size_for_pointer_width(self, pointer_width: u8) -> Option<u32> {
        match pointer_width {
            4 => self.wasm32_size,
            8 => self.wasm64_size,
            _ => None,
        }
    }
}

macro_rules! no_arg {
    ($request:expr) => {
        IoctlRequestContract {
            request: $request,
            arg_kind: IoctlArgKind::None,
            direction: IoctlDirection::None,
            wasm32_size: Some(0),
            wasm64_size: Some(0),
        }
    };
}

macro_rules! scalar_i32 {
    ($request:expr) => {
        IoctlRequestContract {
            request: $request,
            arg_kind: IoctlArgKind::ScalarI32,
            direction: IoctlDirection::None,
            wasm32_size: Some(0),
            wasm64_size: Some(0),
        }
    };
}

macro_rules! pointer {
    ($request:expr, $direction:ident, $size:expr) => {
        IoctlRequestContract {
            request: $request,
            arg_kind: IoctlArgKind::Pointer,
            direction: IoctlDirection::$direction,
            wasm32_size: Some($size),
            wasm64_size: Some($size),
        }
    };
    ($request:expr, $direction:ident, wasm32 $size:expr) => {
        IoctlRequestContract {
            request: $request,
            arg_kind: IoctlArgKind::Pointer,
            direction: IoctlDirection::$direction,
            wasm32_size: Some($size),
            wasm64_size: None,
        }
    };
    ($request:expr, $direction:ident, wasm64 $size:expr) => {
        IoctlRequestContract {
            request: $request,
            arg_kind: IoctlArgKind::Pointer,
            direction: IoctlDirection::$direction,
            wasm32_size: None,
            wasm64_size: Some($size),
        }
    };
    ($request:expr, $direction:ident, $wasm32_size:expr, $wasm64_size:expr) => {
        IoctlRequestContract {
            request: $request,
            arg_kind: IoctlArgKind::Pointer,
            direction: IoctlDirection::$direction,
            wasm32_size: Some($wasm32_size),
            wasm64_size: Some($wasm64_size),
        }
    };
}

/// Ioctls that may reach the Rust kernel dispatcher.
///
/// Keep entries sorted by unsigned request number. `SIOCGIFCONF` is
/// deliberately absent — see the comment above the `SIOCGIF*` constants.
pub const IOCTL_REQUEST_CONTRACTS: &[IoctlRequestContract] = &[
    // Kandelo GLES requests use small private request numbers.
    pointer!(crate::gl::GLIO_INIT, In, 4),
    no_arg!(crate::gl::GLIO_TERMINATE),
    pointer!(crate::gl::GLIO_CREATE_CONTEXT, In, 16),
    no_arg!(crate::gl::GLIO_DESTROY_CONTEXT),
    pointer!(crate::gl::GLIO_CREATE_SURFACE, In, 32),
    no_arg!(crate::gl::GLIO_DESTROY_SURFACE),
    no_arg!(crate::gl::GLIO_MAKE_CURRENT),
    pointer!(crate::gl::GLIO_SUBMIT, In, 8),
    no_arg!(crate::gl::GLIO_PRESENT),
    // WHY: GlQueryInfo contains wasm32 pointers. Until a native wasm64 wire
    // structure exists, rejecting the known request is safer than truncating.
    pointer!(crate::gl::GLIO_QUERY, In, wasm32 24),
    pointer!(crate::fbdev::FBIOGET_VSCREENINFO, Out, 160),
    pointer!(crate::fbdev::FBIOPUT_VSCREENINFO, In, 160),
    pointer!(crate::fbdev::FBIOGET_FSCREENINFO, Out, 80),
    pointer!(crate::fbdev::FBIOPAN_DISPLAY, In, 160),
    pointer!(KDGKBTYPE, Out, 1),
    pointer!(KDGKBMODE, Out, 4),
    scalar_i32!(KDSKBMODE),
    no_arg!(crate::oss::SNDCTL_DSP_RESET),
    no_arg!(crate::oss::SNDCTL_DSP_SYNC),
    no_arg!(crate::oss::SNDCTL_DSP_POST),
    no_arg!(crate::oss::SNDCTL_DSP_NONBLOCK),
    no_arg!(crate::oss::SNDCTL_DSP_SETSYNCRO),
    no_arg!(crate::oss::SNDCTL_DSP_SETDUPLEX),
    pointer!(TCGETS, Out, TERMIOS_SIZE),
    pointer!(TCSETS, In, TERMIOS_SIZE),
    pointer!(TCSETSW, In, TERMIOS_SIZE),
    pointer!(TCSETSF, In, TERMIOS_SIZE),
    scalar_i32!(TCSBRK),
    scalar_i32!(TCXONC),
    scalar_i32!(TCFLSH),
    scalar_i32!(TIOCSCTTY),
    pointer!(TIOCGPGRP, Out, 4),
    pointer!(TIOCSPGRP, In, 4),
    pointer!(TIOCGWINSZ, Out, 8),
    pointer!(TIOCSWINSZ, In, 8),
    pointer!(FIONREAD, Out, 4),
    pointer!(FIONBIO, In, 4),
    no_arg!(TIOCNOTTY),
    pointer!(TIOCGSID, Out, 4),
    no_arg!(FIONCLEX),
    no_arg!(FIOCLEX),
    pointer!(FIOASYNC, In, 4),
    no_arg!(crate::dri::DRM_IOCTL_SET_MASTER),
    no_arg!(crate::dri::DRM_IOCTL_DROP_MASTER),
    pointer!(SIOCATMARK, Out, 4),
    // ifreqSize differs by pointer width: `struct ifmap`'s `unsigned long`
    // members double from 4 to 8 bytes under wasm64.
    pointer!(SIOCGIFNAME, InOut, 32, 40),
    pointer!(SIOCGIFADDR, InOut, 32, 40),
    pointer!(SIOCGIFHWADDR, InOut, 32, 40),
    pointer!(SIOCGIFINDEX, InOut, 32, 40),
    pointer!(crate::oss::SNDCTL_DSP_SETBLKSIZE, In, 4),
    pointer!(crate::oss::SNDCTL_DSP_SETTRIGGER, In, 4),
    pointer!(TIOCSPTLCK, In, 4),
    pointer!(crate::dri::DRM_IOCTL_GEM_CLOSE, In, 8),
    pointer!(crate::oss::SOUND_PCM_READ_RATE, Out, 4),
    pointer!(crate::oss::SOUND_PCM_READ_BITS, Out, 4),
    pointer!(crate::oss::SOUND_PCM_READ_CHANNELS, Out, 4),
    pointer!(crate::oss::SOUND_PCM_READ_FILTER, Out, 4),
    pointer!(crate::oss::SNDCTL_DSP_GETFMTS, Out, 4),
    pointer!(crate::oss::SNDCTL_DSP_GETCAPS, Out, 4),
    pointer!(crate::oss::SNDCTL_DSP_GETTRIGGER, Out, 4),
    pointer!(crate::oss::SNDCTL_DSP_GETODELAY, Out, 4),
    pointer!(TIOCGPTN, Out, 4),
    pointer!(crate::oss::SNDCTL_DSP_MAPINBUF, Out, 8),
    pointer!(crate::oss::SNDCTL_DSP_MAPOUTBUF, Out, 8),
    pointer!(crate::oss::SNDCTL_DSP_GETIPTR, Out, 12),
    pointer!(crate::oss::SNDCTL_DSP_GETOPTR, Out, 12),
    pointer!(crate::oss::SNDCTL_DSP_GETOSPACE, Out, 16),
    pointer!(crate::oss::SNDCTL_DSP_GETISPACE, Out, 16),
    pointer!(crate::oss::SNDCTL_DSP_SPEED, InOut, 4),
    pointer!(crate::oss::SNDCTL_DSP_STEREO, InOut, 4),
    pointer!(crate::oss::SNDCTL_DSP_GETBLKSIZE, Out, 4),
    pointer!(crate::oss::SNDCTL_DSP_SETFMT, InOut, 4),
    pointer!(crate::oss::SNDCTL_DSP_CHANNELS, InOut, 4),
    pointer!(crate::oss::SOUND_PCM_WRITE_FILTER, InOut, 4),
    pointer!(crate::oss::SNDCTL_DSP_SUBDIVIDE, InOut, 4),
    pointer!(crate::oss::SNDCTL_DSP_SETFRAGMENT, InOut, 4),
    pointer!(crate::dri::DRM_IOCTL_MODE_RMFB, In, 4),
    pointer!(crate::dri::DRM_IOCTL_MODE_DESTROY_DUMB, In, 4),
    pointer!(crate::dri::DRM_IOCTL_PRIME_HANDLE_TO_FD, InOut, 12),
    pointer!(crate::dri::DRM_IOCTL_PRIME_FD_TO_HANDLE, InOut, 12),
    pointer!(crate::dri::DRM_IOCTL_GET_CAP, InOut, 16),
    pointer!(crate::dri::DRM_IOCTL_WAIT_VBLANK, InOut, 16),
    pointer!(crate::dri::DRM_IOCTL_MODE_MAP_DUMB, InOut, 16),
    pointer!(crate::dri::DRM_IOCTL_MODE_GETENCODER, InOut, 20),
    pointer!(crate::dri::DRM_IOCTL_MODE_PAGE_FLIP, In, 24),
    pointer!(crate::dri::DRM_IOCTL_MODE_CREATE_DUMB, InOut, 32),
    // Linux encodes pointer-sized fields into DRM_IOCTL_VERSION itself.
    pointer!(crate::dri::DRM_IOCTL_VERSION, InOut, wasm32 36),
    pointer!(crate::dri::DRM_IOCTL_VERSION_WASM64, InOut, wasm64 64),
    pointer!(crate::dri::DRM_IOCTL_MODE_GETRESOURCES, InOut, 64),
    pointer!(crate::dri::DRM_IOCTL_MODE_GETCONNECTOR, InOut, 80),
    pointer!(crate::dri::DRM_IOCTL_MODE_GETCRTC, InOut, 104),
    pointer!(crate::dri::DRM_IOCTL_MODE_SETCRTC, In, 104),
    pointer!(crate::dri::DRM_IOCTL_MODE_ADDFB2, InOut, 104),
];

pub fn request_contract(request: u32) -> Option<&'static IoctlRequestContract> {
    IOCTL_REQUEST_CONTRACTS
        .binary_search_by_key(&request, |entry| entry.request)
        .ok()
        .map(|index| &IOCTL_REQUEST_CONTRACTS[index])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn contracts_are_strictly_sorted_and_unique() {
        assert!(IOCTL_REQUEST_CONTRACTS
            .windows(2)
            .all(|pair| pair[0].request < pair[1].request));
    }

    #[test]
    fn native_drm_version_layouts_are_request_specific() {
        let wasm32 = request_contract(crate::dri::DRM_IOCTL_VERSION).unwrap();
        assert_eq!(wasm32.size_for_pointer_width(4), Some(36));
        assert_eq!(wasm32.size_for_pointer_width(8), None);

        let wasm64 = request_contract(crate::dri::DRM_IOCTL_VERSION_WASM64).unwrap();
        assert_eq!(wasm64.size_for_pointer_width(4), None);
        assert_eq!(wasm64.size_for_pointer_width(8), Some(64));
    }

    #[test]
    fn gl_query_refuses_wasm64_until_it_has_a_native_wire() {
        let query = request_contract(crate::gl::GLIO_QUERY).unwrap();
        assert_eq!(query.size_for_pointer_width(4), Some(24));
        assert_eq!(query.size_for_pointer_width(8), None);
    }
}
