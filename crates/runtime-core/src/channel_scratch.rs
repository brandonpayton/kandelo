//! Capacity-carrying bounds for one live widened-syscall channel allocation.
//!
//! This module is target-independent so the pure ownership checks used by the
//! Wasm dispatcher are exercised by the ordinary native kernel test suite.

use core::mem::{offset_of, size_of};

use wasm_posix_shared::abi::extended_syscalls;
use wasm_posix_shared::host_abi::{
    PROCESS_POINTER_WIDTH_ARG_INDEX, SYSCALL_ARG_DESCRIPTORS, SyscallArgDesc, SyscallArgSize,
};
use wasm_posix_shared::{
    Errno, KernelIovecWire, KernelMsghdrWire, Syscall, WasmEpollEvent, WasmSysvMessageHeader,
    kernel_scratch_wire, platform_limits, prctl,
};

const SCRATCH_ALIGNMENT: usize = 8;
const KERNEL_WIRE_ALIGNMENT: usize = 4;
const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;

/// Numeric bounds of the data area in one live kernel channel allocation.
///
/// Keep the allocation capacity beside its address. A pointer being somewhere
/// in kernel linear memory does not prove that the bytes after it belong to the
/// channel currently being dispatched.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ChannelScratchRegion {
    start: usize,
    capacity: usize,
}

/// One already-proven subrange of a live channel scratch allocation.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ChannelScratchRange {
    start: usize,
    length: usize,
}

impl ChannelScratchRange {
    pub const fn start(self) -> usize {
        self.start
    }
}

impl ChannelScratchRegion {
    pub fn new(start: usize, capacity: usize) -> Result<Self, Errno> {
        start.checked_add(capacity).ok_or(Errno::EFAULT)?;
        Ok(Self { start, capacity })
    }

    pub fn for_channel(channel_offset: usize) -> Result<Self, Errno> {
        use wasm_posix_shared::channel::{DATA_OFFSET, DATA_SIZE};

        let start = channel_offset
            .checked_add(DATA_OFFSET)
            .ok_or(Errno::EFAULT)?;
        Self::new(start, DATA_SIZE)
    }

    pub const fn start(self) -> usize {
        self.start
    }

    pub fn end(self) -> Result<usize, Errno> {
        self.start.checked_add(self.capacity).ok_or(Errno::EFAULT)
    }

    /// Prove a complete byte range against this allocation, independently of
    /// whether it also happens to fit in the kernel's total linear memory.
    pub fn checked_range(
        self,
        pointer: usize,
        length: usize,
    ) -> Result<ChannelScratchRange, Errno> {
        if pointer < self.start {
            return Err(Errno::EFAULT);
        }
        let allocation_end = self.end()?;
        let range_end = pointer.checked_add(length).ok_or(Errno::EFAULT)?;
        if pointer > allocation_end || range_end > allocation_end {
            return Err(Errno::EFAULT);
        }
        if length > 0 && pointer == 0 {
            return Err(Errno::EFAULT);
        }
        Ok(ChannelScratchRange {
            start: pointer,
            length,
        })
    }

    /// Prove a command-dependent payload starts at the allocation base and
    /// fits completely inside its explicit capacity.
    pub fn checked_start_range(
        self,
        pointer: usize,
        length: usize,
    ) -> Result<ChannelScratchRange, Errno> {
        if pointer != self.start {
            return Err(Errno::EFAULT);
        }
        self.checked_range(pointer, length)
    }

    fn remaining_from(self, pointer: usize) -> Result<usize, Errno> {
        if pointer == 0 || pointer < self.start {
            return Err(Errno::EFAULT);
        }
        let end = self.start.checked_add(self.capacity).ok_or(Errno::EFAULT)?;
        if pointer >= end {
            return Err(Errno::EFAULT);
        }
        end.checked_sub(pointer).ok_or(Errno::EFAULT)
    }
}

/// Per-argument evidence produced before channel dispatch dereferences scratch.
///
/// `described[index]` distinguishes a reviewed null pointer from an argument
/// which no descriptor or bespoke wire validator proved.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ValidatedChannelScratchArgs {
    described: [bool; 6],
    ranges: [Option<ChannelScratchRange>; 6],
}

impl ValidatedChannelScratchArgs {
    const fn new() -> Self {
        Self {
            described: [false; 6],
            ranges: [None; 6],
        }
    }

    fn mark_null(&mut self, index: usize) -> Result<(), Errno> {
        if index >= self.ranges.len() {
            return Err(Errno::EINVAL);
        }
        self.described[index] = true;
        self.ranges[index] = None;
        Ok(())
    }

    fn mark_range(&mut self, index: usize, range: ChannelScratchRange) -> Result<(), Errno> {
        if index >= self.ranges.len() {
            return Err(Errno::EINVAL);
        }
        self.described[index] = true;
        self.ranges[index] = Some(range);
        Ok(())
    }

    /// Return a pointer only if the corresponding descriptor or reviewed
    /// bespoke-wire validator proved its exact allocation-owned subrange.
    pub fn pointer(self, index: usize) -> Result<usize, Errno> {
        if index >= self.ranges.len() || !self.described[index] {
            return Err(Errno::EFAULT);
        }
        Ok(self.ranges[index].map_or(0, ChannelScratchRange::start))
    }
}

fn checked_pointer(raw: i64) -> Result<usize, Errno> {
    usize::try_from(raw as u64).map_err(|_| Errno::EFAULT)
}

fn checked_size_scalar(raw: i64) -> Result<usize, Errno> {
    if !(0..=MAX_SAFE_INTEGER).contains(&raw) {
        return Err(Errno::EINVAL);
    }
    usize::try_from(raw).map_err(|_| Errno::EINVAL)
}

fn align_up(value: usize, alignment: usize) -> Result<usize, Errno> {
    if !alignment.is_power_of_two() {
        return Err(Errno::EINVAL);
    }
    value
        .checked_add(alignment - 1)
        .map(|value| value & !(alignment - 1))
        .ok_or(Errno::EFAULT)
}

unsafe fn read_u32(pointer: usize, region: ChannelScratchRegion) -> Result<u32, Errno> {
    let range = region.checked_range(pointer, size_of::<u32>())?;
    let bytes = unsafe { core::slice::from_raw_parts(range.start as *const u8, range.length) };
    Ok(u32::from_le_bytes(
        bytes.try_into().map_err(|_| Errno::EFAULT)?,
    ))
}

unsafe fn descriptor_size(
    descriptor: &SyscallArgDesc,
    args: &[i64; 6],
    region: ChannelScratchRegion,
) -> Result<usize, Errno> {
    match descriptor.size {
        SyscallArgSize::CString {
            max_bytes,
            too_long_errno,
        } => {
            let pointer = checked_pointer(args[descriptor.arg_index as usize])?;
            region.checked_range(pointer, 0)?;
            let remaining = region.end()?.checked_sub(pointer).ok_or(Errno::EFAULT)?;
            let bounded =
                ChannelScratchRegion::new(pointer, remaining.min(max_bytes as usize))?;
            let length = match unsafe { checked_cstr_len(pointer as *const u8, bounded) } {
                Ok(length) => length,
                Err(_) if remaining >= max_bytes as usize => {
                    return Err(Errno::from_u32(too_long_errno).unwrap_or(Errno::EIO));
                }
                Err(error) => return Err(error),
            };
            usize::try_from(length)
                .ok()
                .and_then(|length| length.checked_add(1))
                .ok_or(Errno::EFAULT)
        }
        SyscallArgSize::Arg {
            arg_index,
            multiplier,
            add,
        } => checked_size_scalar(args[arg_index as usize])?
            .checked_mul(multiplier as usize)
            .and_then(|length| length.checked_add(add as usize))
            .ok_or(Errno::EINVAL),
        SyscallArgSize::Deref { arg_index } => {
            let pointer = checked_pointer(args[arg_index as usize])?;
            if pointer == 0 {
                return Err(Errno::EFAULT);
            }
            Ok(unsafe { read_u32(pointer, region) }? as usize)
        }
        SyscallArgSize::Fixed { size } => Ok(size as usize),
        SyscallArgSize::ProcessLayout {
            wasm32_size,
            wasm64_size,
        } => match args[PROCESS_POINTER_WIDTH_ARG_INDEX as usize] {
            4 => Ok(wasm32_size as usize),
            8 => Ok(wasm64_size as usize),
            _ => Err(Errno::EINVAL),
        },
    }
}

unsafe fn validate_descriptor_layout(
    args: &[i64; 6],
    descriptors: &[SyscallArgDesc],
    region: ChannelScratchRegion,
) -> Result<ValidatedChannelScratchArgs, Errno> {
    let mut validated = ValidatedChannelScratchArgs::new();
    let mut cursor = region.start;

    for descriptor in descriptors {
        let index = descriptor.arg_index as usize;
        if index >= args.len() {
            return Err(Errno::EINVAL);
        }
        let pointer = checked_pointer(args[index])?;
        if pointer == 0 {
            if let SyscallArgSize::Arg {
                arg_index,
                multiplier,
                add,
            } = descriptor.size
            {
                let length = checked_size_scalar(args[arg_index as usize])?
                    .checked_mul(multiplier as usize)
                    .and_then(|length| length.checked_add(add as usize))
                    .ok_or(Errno::EINVAL)?;
                if length == 0 {
                    // Preserve the syscall's null-plus-zero semantics while
                    // giving Rust a valid empty-slice address. The normal host
                    // already writes this canonical address itself.
                    validated.mark_range(index, region.checked_range(region.start, 0)?)?;
                    continue;
                }
            }
            if !descriptor.nullable {
                // Shared metadata explicitly classifies every positive-extent
                // pointer as required or nullable. Enforce that classification
                // independently in Rust before dispatch can form a slice.
                return Err(Errno::EFAULT);
            }
            validated.mark_null(index)?;
            continue;
        }

        let length = unsafe { descriptor_size(descriptor, args, region) }?;
        if length == 0 {
            // WHY: the host deliberately canonicalizes every empty borrow to
            // the allocation start. Accepting an arbitrary address here would
            // let a process pointer cross the host/kernel boundary merely
            // because the associated count happened to be zero.
            if pointer != region.start {
                return Err(Errno::EFAULT);
            }
            validated.mark_range(index, region.checked_range(pointer, 0)?)?;
            continue;
        }
        if pointer != cursor {
            return Err(Errno::EFAULT);
        }
        let range = region.checked_range(pointer, length)?;
        validated.mark_range(index, range)?;
        cursor = align_up(
            pointer.checked_add(length).ok_or(Errno::EFAULT)?,
            SCRATCH_ALIGNMENT,
        )?;
        if cursor > region.end()? {
            return Err(Errno::EFAULT);
        }
    }
    Ok(validated)
}

fn checked_exact_range(
    validated: &mut ValidatedChannelScratchArgs,
    args: &[i64; 6],
    index: usize,
    expected_pointer: usize,
    length: usize,
    region: ChannelScratchRegion,
) -> Result<ChannelScratchRange, Errno> {
    let pointer = checked_pointer(args[index])?;
    if pointer != expected_pointer {
        return Err(Errno::EFAULT);
    }
    let range = region.checked_range(pointer, length)?;
    validated.mark_range(index, range)?;
    Ok(range)
}

fn checked_nullable_exact_range(
    validated: &mut ValidatedChannelScratchArgs,
    args: &[i64; 6],
    index: usize,
    expected_pointer: usize,
    length: usize,
    region: ChannelScratchRegion,
) -> Result<(), Errno> {
    let pointer = checked_pointer(args[index])?;
    if pointer == 0 {
        return validated.mark_null(index);
    }
    checked_exact_range(validated, args, index, expected_pointer, length, region)?;
    Ok(())
}

unsafe fn validate_iovec_layout(
    args: &[i64; 6],
    region: ChannelScratchRegion,
) -> Result<ValidatedChannelScratchArgs, Errno> {
    let count = checked_size_scalar(args[2])?;
    if count > platform_limits::IOV_MAX {
        return Err(Errno::EINVAL);
    }
    let mut validated = ValidatedChannelScratchArgs::new();
    if count == 0 {
        // POSIX ignores the iovec pointer when no entries exist. Record a
        // canonical null for dispatch without converting, range-checking, or
        // reading the caller-provided pointer bits.
        validated.mark_null(1)?;
        return Ok(validated);
    }
    let table_bytes = count
        .checked_mul(size_of::<KernelIovecWire>())
        .ok_or(Errno::EINVAL)?;
    let table = checked_exact_range(&mut validated, args, 1, region.start, table_bytes, region)?;
    let table_bytes =
        unsafe { core::slice::from_raw_parts(table.start as *const u8, table.length) };
    let mut cursor = table.start.checked_add(table.length).ok_or(Errno::EFAULT)?;
    for entry in table_bytes.chunks_exact(size_of::<KernelIovecWire>()) {
        let base = read_wire_u32(entry, offset_of!(KernelIovecWire, base))? as usize;
        let length = read_wire_u32(entry, offset_of!(KernelIovecWire, len))? as usize;
        if base != cursor {
            return Err(Errno::EFAULT);
        }
        region.checked_range(base, length)?;
        cursor = align_up(
            base.checked_add(length).ok_or(Errno::EFAULT)?,
            KERNEL_WIRE_ALIGNMENT,
        )?;
        if cursor > region.end()? {
            return Err(Errno::EFAULT);
        }
    }
    Ok(validated)
}

fn read_wire_u32(bytes: &[u8], offset: usize) -> Result<u32, Errno> {
    let end = offset.checked_add(size_of::<u32>()).ok_or(Errno::EFAULT)?;
    let bytes = bytes.get(offset..end).ok_or(Errno::EFAULT)?;
    Ok(u32::from_le_bytes(
        bytes.try_into().map_err(|_| Errno::EFAULT)?,
    ))
}

unsafe fn validate_message_layout(
    args: &[i64; 6],
    region: ChannelScratchRegion,
) -> Result<ValidatedChannelScratchArgs, Errno> {
    let mut validated = ValidatedChannelScratchArgs::new();
    let header = checked_exact_range(
        &mut validated,
        args,
        1,
        region.start,
        size_of::<KernelMsghdrWire>(),
        region,
    )?;
    let header = unsafe { core::slice::from_raw_parts(header.start as *const u8, header.length) };
    unsafe { validate_message_wire_layout(header, region) }?;
    Ok(validated)
}

/// Validate the nested extents described by one canonical message header.
///
/// Keeping this separate from the outer header-range proof lets native tests
/// exercise wasm32 wire addresses without requiring the test allocator itself
/// to return an address below 4 GiB.
///
/// # Safety
///
/// When the header describes one iovec, that iovec must name readable memory
/// for the complete `KernelIovecWire` after this function proves its range.
unsafe fn validate_message_wire_layout(
    header: &[u8],
    region: ChannelScratchRegion,
) -> Result<(), Errno> {
    if header.len() != size_of::<KernelMsghdrWire>() {
        return Err(Errno::EFAULT);
    }
    let name = read_wire_u32(header, offset_of!(KernelMsghdrWire, name))? as usize;
    let name_len = read_wire_u32(header, offset_of!(KernelMsghdrWire, name_len))? as usize;
    let iov = read_wire_u32(header, offset_of!(KernelMsghdrWire, iov))? as usize;
    let iov_len = read_wire_u32(header, offset_of!(KernelMsghdrWire, iov_len))? as usize;
    let control = read_wire_u32(header, offset_of!(KernelMsghdrWire, control))? as usize;
    let control_len = read_wire_u32(header, offset_of!(KernelMsghdrWire, control_len))? as usize;

    let mut cursor = region
        .start
        .checked_add(size_of::<KernelMsghdrWire>())
        .ok_or(Errno::EFAULT)?;
    let mut append = |pointer: usize, length: usize| -> Result<(), Errno> {
        if length == 0 {
            // A null pointer means the optional field is absent. The current
            // cursor is the one canonical allocation-owned zero-capacity
            // address and preserves presence without lending any bytes.
            return if pointer == 0 || pointer == cursor {
                Ok(())
            } else {
                Err(Errno::EFAULT)
            };
        }
        if pointer != cursor {
            return Err(Errno::EFAULT);
        }
        region.checked_range(pointer, length)?;
        cursor = align_up(
            pointer.checked_add(length).ok_or(Errno::EFAULT)?,
            KERNEL_WIRE_ALIGNMENT,
        )?;
        if cursor > region.end()? {
            return Err(Errno::EFAULT);
        }
        Ok(())
    };

    append(name, name_len)?;
    append(control, control_len)?;
    if iov_len > wasm_posix_shared::socket::KERNEL_MESSAGE_WIRE_FLATTENED_IOVEC_COUNT as usize {
        return Err(Errno::EINVAL);
    }
    let iov_bytes = iov_len
        .checked_mul(size_of::<KernelIovecWire>())
        .ok_or(Errno::EINVAL)?;
    append(iov, iov_bytes)?;
    if iov_len == 1 {
        let iovec =
            unsafe { core::slice::from_raw_parts(iov as *const u8, size_of::<KernelIovecWire>()) };
        let base = read_wire_u32(iovec, offset_of!(KernelIovecWire, base))? as usize;
        let length = read_wire_u32(iovec, offset_of!(KernelIovecWire, len))? as usize;
        if length == 0 {
            if base != 0 {
                return Err(Errno::EFAULT);
            }
        } else {
            append(base, length)?;
        }
    }
    Ok(())
}

fn validate_select_layout(
    args: &[i64; 6],
    region: ChannelScratchRegion,
    has_mask: bool,
) -> Result<ValidatedChannelScratchArgs, Errno> {
    let mut validated = ValidatedChannelScratchArgs::new();
    let fd_set_bytes = wasm_posix_shared::select::FD_SET_BYTES;
    for index in 1usize..=3 {
        let offset = (index - 1).checked_mul(fd_set_bytes).ok_or(Errno::EFAULT)?;
        checked_nullable_exact_range(
            &mut validated,
            args,
            index,
            region.start.checked_add(offset).ok_or(Errno::EFAULT)?,
            fd_set_bytes,
            region,
        )?;
    }
    if has_mask {
        let mask_pointer = region
            .start
            .checked_add(3 * fd_set_bytes)
            .ok_or(Errno::EFAULT)?;
        checked_nullable_exact_range(
            &mut validated,
            args,
            5,
            mask_pointer,
            kernel_scratch_wire::SIGNAL_MASK_BYTES as usize,
            region,
        )?;
    }
    Ok(validated)
}

fn validate_ioctl_layout(
    args: &[i64; 6],
    region: ChannelScratchRegion,
) -> Result<ValidatedChannelScratchArgs, Errno> {
    use wasm_posix_shared::ioctl_contract::IoctlArgKind;

    let mut validated = ValidatedChannelScratchArgs::new();
    let request = args[1] as u32;
    let Some(contract) = wasm_posix_shared::ioctl_contract::request_contract(request) else {
        return Ok(validated);
    };
    if contract.arg_kind != IoctlArgKind::Pointer {
        return Ok(validated);
    }
    let width = u8::try_from(args[5]).map_err(|_| Errno::EINVAL)?;
    let size = contract
        .size_for_pointer_width(width)
        .ok_or(Errno::EINVAL)? as usize;
    if checked_size_scalar(args[3])? != size {
        return Err(Errno::EINVAL);
    }
    checked_exact_range(&mut validated, args, 2, region.start, size, region)?;
    Ok(validated)
}

fn validate_ipc_control_layout(
    args: &[i64; 6],
    region: ChannelScratchRegion,
    syscall_number: u32,
) -> Result<ValidatedChannelScratchArgs, Errno> {
    let mut validated = ValidatedChannelScratchArgs::new();
    let command = (args[1] as i32) & !0x100;
    if !matches!(command, 1 | 2) {
        validated.mark_null(2)?;
        return Ok(validated);
    }
    let width = u32::try_from(args[5]).map_err(|_| Errno::EINVAL)?;
    let size = if syscall_number == extended_syscalls::SYS_MSGCTL {
        crate::ipc_wire::msqid_ds_size(width)?
    } else {
        crate::ipc_wire::shmid_ds_size(width)?
    };
    checked_exact_range(&mut validated, args, 2, region.start, size, region)?;
    Ok(validated)
}

fn validate_special_layout(
    syscall_number: u32,
    args: &[i64; 6],
    region: ChannelScratchRegion,
) -> Result<ValidatedChannelScratchArgs, Errno> {
    match syscall_number {
        number if number == Syscall::Fcntl as u32 => {
            let mut validated = ValidatedChannelScratchArgs::new();
            if matches!(args[1] as u32, 5 | 6 | 7 | 12 | 13 | 14 | 36 | 37 | 38) {
                checked_exact_range(
                    &mut validated,
                    args,
                    2,
                    region.start,
                    kernel_scratch_wire::FCNTL_FLOCK_BYTES as usize,
                    region,
                )?;
            }
            Ok(validated)
        }
        number if number == Syscall::Ioctl as u32 => validate_ioctl_layout(args, region),
        number
            if matches!(
                number,
                x if x == Syscall::Writev as u32
                    || x == Syscall::Readv as u32
                    || x == extended_syscalls::SYS_PREADV
                    || x == extended_syscalls::SYS_PWRITEV
                    || x == extended_syscalls::SYS_PREADV2
                    || x == extended_syscalls::SYS_PWRITEV2
            ) =>
        unsafe { validate_iovec_layout(args, region) },
        number if number == Syscall::Sendmsg as u32 || number == Syscall::Recvmsg as u32 => unsafe {
            validate_message_layout(args, region)
        },
        number if number == Syscall::Select as u32 => validate_select_layout(args, region, false),
        extended_syscalls::SYS_PSELECT6 => validate_select_layout(args, region, true),
        extended_syscalls::SYS_MSGRCV | extended_syscalls::SYS_MSGSND => {
            if !matches!(args[5], 4 | 8) {
                return Err(Errno::EINVAL);
            }
            let payload = checked_size_scalar(args[2])?;
            let length = size_of::<WasmSysvMessageHeader>()
                .checked_add(payload)
                .ok_or(Errno::EINVAL)?;
            let mut validated = ValidatedChannelScratchArgs::new();
            checked_exact_range(&mut validated, args, 1, region.start, length, region)?;
            Ok(validated)
        }
        extended_syscalls::SYS_MSGCTL | extended_syscalls::SYS_SHMCTL => {
            validate_ipc_control_layout(args, region, syscall_number)
        }
        extended_syscalls::SYS_EPOLL_CTL => {
            let mut validated = ValidatedChannelScratchArgs::new();
            checked_nullable_exact_range(
                &mut validated,
                args,
                3,
                region.start,
                size_of::<WasmEpollEvent>(),
                region,
            )?;
            Ok(validated)
        }
        extended_syscalls::SYS_EPOLL_PWAIT | extended_syscalls::SYS_EPOLL_WAIT => {
            let count = checked_size_scalar(args[2])?;
            let length = count
                .checked_mul(size_of::<WasmEpollEvent>())
                .ok_or(Errno::EINVAL)?;
            let mut validated = ValidatedChannelScratchArgs::new();
            checked_exact_range(&mut validated, args, 1, region.start, length, region)?;
            if syscall_number == extended_syscalls::SYS_EPOLL_PWAIT {
                let mask_pointer = align_up(
                    region.start.checked_add(length).ok_or(Errno::EFAULT)?,
                    SCRATCH_ALIGNMENT,
                )?;
                checked_nullable_exact_range(
                    &mut validated,
                    args,
                    4,
                    mask_pointer,
                    kernel_scratch_wire::SIGNAL_MASK_BYTES as usize,
                    region,
                )?;
            }
            Ok(validated)
        }
        _ => Ok(ValidatedChannelScratchArgs::new()),
    }
}

fn validate_prctl_layout(
    args: &[i64; 6],
    region: ChannelScratchRegion,
) -> Result<ValidatedChannelScratchArgs, Errno> {
    let mut validated = ValidatedChannelScratchArgs::new();
    if args[0] == i64::from(prctl::PR_SET_NAME) || args[0] == i64::from(prctl::PR_GET_NAME) {
        checked_exact_range(
            &mut validated,
            args,
            1,
            region.start,
            kernel_scratch_wire::PRCTL_NAME_BYTES as usize,
            region,
        )?;
    }
    Ok(validated)
}

/// Validate every ordinary descriptor-backed channel suballocation and the
/// reviewed nested/manual wire formats before syscall dispatch.
///
/// # Safety
///
/// `region` must describe the complete live kernel-owned allocation and no
/// concurrent host operation may replace its bytes during this call or the
/// immediately following synchronous dispatch.
pub unsafe fn validate_channel_scratch_arguments(
    syscall_number: u32,
    args: &[i64; 6],
    region: ChannelScratchRegion,
) -> Result<ValidatedChannelScratchArgs, Errno> {
    if matches!(
        syscall_number,
        number if number == Syscall::Getgroups as u32 || number == Syscall::Setgroups as u32
    ) && checked_size_scalar(args[0])? > crate::credentials::NGROUPS_MAX
    {
        return Err(Errno::EINVAL);
    }
    // PR_SET_NAME and PR_GET_NAME use arg 1 as the generated fixed-size name
    // pointer, while other prctl options use the same slot as a scalar. A
    // generic pointer descriptor would either dereference a scalar or fail to
    // prove the name allocation, so keep this option-dependent contract
    // explicit.
    if syscall_number == extended_syscalls::SYS_PRCTL {
        return validate_prctl_layout(args, region);
    }
    if let Ok(index) = SYSCALL_ARG_DESCRIPTORS
        .binary_search_by_key(&syscall_number, |descriptor| descriptor.syscall_number)
    {
        return unsafe {
            validate_descriptor_layout(args, SYSCALL_ARG_DESCRIPTORS[index].args, region)
        };
    }
    validate_special_layout(syscall_number, args, region)
}

/// Compute the length of a bounded, null-terminated C string in kernel memory.
///
/// The host stages channel strings into a live kernel-owned allocation before
/// synchronous dispatch. This scanner proves the exact remaining allocation
/// capacity before each dereference; semantic limits such as `PATH_MAX` remain
/// the responsibility of the syscall consuming the string.
///
/// # Safety
///
/// `region` must describe the live channel allocation for this synchronous
/// dispatch.
pub unsafe fn checked_cstr_len(
    ptr: *const u8,
    region: ChannelScratchRegion,
) -> Result<u32, Errno> {
    let remaining = region.remaining_from(ptr as usize)?;
    for len in 0..remaining {
        if unsafe { *ptr.add(len) } == 0 {
            return u32::try_from(len).map_err(|_| Errno::EFAULT);
        }
    }
    Err(Errno::EFAULT)
}

/// Copy-back instruction for one record output span (Phase 2 opaque transport).
///
/// After dispatch, the result bytes sitting in the contiguous scratch layout at
/// `scratch_src` are copied into the channel data region at `channel_dest` (the
/// span's original record offset), where a record-path caller reads its outputs
/// -- mirroring the host copy-out (`finish`) step.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ChannelRecordCopyBack {
    pub channel_dest: usize,
    pub scratch_src: usize,
    pub len: usize,
}

/// Inputs for the legacy channel dispatch, reconstructed kernel-side from an
/// opaque self-marshalled record.
#[derive(Debug, PartialEq, Eq)]
pub struct PreparedChannelRecord {
    pub syscall_nr: u32,
    pub args: [i64; 6],
    pub copy_back: alloc::vec::Vec<ChannelRecordCopyBack>,
}

/// Write a little-endian `u32` into scratch at `addr`.
///
/// # Safety
///
/// The caller must have bounds-checked the four-byte `[addr, addr + 4)` range
/// against the live allocation before calling.
unsafe fn write_scratch_u32(addr: usize, value: u32) {
    let bytes = value.to_le_bytes();
    unsafe { core::ptr::copy_nonoverlapping(bytes.as_ptr(), addr as *mut u8, bytes.len()) };
}

/// True when this syscall's iovec buffers are kernel outputs (the kernel writes
/// received bytes into them), so each sub-buffer needs a post-dispatch copy-back
/// to its original record offset. `readv`/`preadv`/`preadv2` scatter into the
/// buffers; `writev`/`pwritev`/`pwritev2` only read from them.
fn iovec_syscall_is_output(syscall: u16) -> bool {
    let nr = syscall as u32;
    nr == Syscall::Readv as u32
        || nr == extended_syscalls::SYS_PREADV
        || nr == extended_syscalls::SYS_PREADV2
}

/// Lay a `KernelIovecWire` table plus its buffers into scratch, mirroring the
/// exact contiguous layout the legacy host copy-in produces and
/// [`validate_iovec_layout`]/[`validate_message_wire_layout`] consume: a table
/// of `{ u32 base; u32 len }` entries at `table_addr`, then each buffer laid
/// immediately after (each successive buffer aligned to
/// [`KERNEL_WIRE_ALIGNMENT`]). Returns the next free cursor after the final
/// buffer. When `output`, records a copy-back of each non-empty buffer to its
/// original record offset (readv/preadv/recvmsg scatter targets).
///
/// # Safety
///
/// `region` must describe the live kernel-owned allocation; `data_base` must be
/// the base of the owned record snapshot that `bufs` borrow from.
unsafe fn lay_kernel_iovec_block(
    region: ChannelScratchRegion,
    data_base: *const u8,
    region_start: usize,
    table_addr: usize,
    bufs: &[&[u8]],
    output: bool,
    copy_back: &mut alloc::vec::Vec<ChannelRecordCopyBack>,
) -> Result<usize, Errno> {
    let entry_size = size_of::<KernelIovecWire>();
    let table_bytes = bufs.len().checked_mul(entry_size).ok_or(Errno::EINVAL)?;
    region.checked_range(table_addr, table_bytes)?;

    let mut buf_cursor = table_addr.checked_add(table_bytes).ok_or(Errno::EFAULT)?;
    for (index, buf) in bufs.iter().enumerate() {
        let len = buf.len();
        let base = buf_cursor;
        region.checked_range(base, len)?;

        let entry_addr = table_addr
            .checked_add(index.checked_mul(entry_size).ok_or(Errno::EFAULT)?)
            .ok_or(Errno::EFAULT)?;
        // KernelIovecWire is { base: u32, len: u32 }; write it field by field so
        // the bytes match the struct's `repr(C)` layout the validator reads.
        unsafe {
            write_scratch_u32(
                entry_addr
                    .checked_add(offset_of!(KernelIovecWire, base))
                    .ok_or(Errno::EFAULT)?,
                base as u32,
            );
            write_scratch_u32(
                entry_addr
                    .checked_add(offset_of!(KernelIovecWire, len))
                    .ok_or(Errno::EFAULT)?,
                len as u32,
            );
        }

        if len > 0 {
            unsafe { core::ptr::copy_nonoverlapping(buf.as_ptr(), base as *mut u8, len) };
            if output {
                let original_offset = (buf.as_ptr() as usize)
                    .checked_sub(data_base as usize)
                    .ok_or(Errno::EFAULT)?;
                copy_back.push(ChannelRecordCopyBack {
                    channel_dest: region_start
                        .checked_add(original_offset)
                        .ok_or(Errno::EFAULT)?,
                    scratch_src: base,
                    len,
                });
            }
        }

        buf_cursor = align_up(
            base.checked_add(len).ok_or(Errno::EFAULT)?,
            KERNEL_WIRE_ALIGNMENT,
        )?;
        if buf_cursor > region.end()? {
            return Err(Errno::EFAULT);
        }
    }
    Ok(buf_cursor)
}

/// Lay one optional flat msghdr sub-buffer (the socket name or the ancillary
/// control block) into scratch at `cursor`. Returns its wire pointer field
/// (`0` when the buffer is empty, matching the "absent" encoding the validator
/// accepts) and the next cursor. When `output`, records a copy-back to the
/// buffer's original record offset (recvmsg name/control results).
///
/// # Safety
///
/// As for [`lay_kernel_iovec_block`].
unsafe fn lay_msghdr_subbuffer(
    region: ChannelScratchRegion,
    data_base: *const u8,
    region_start: usize,
    cursor: usize,
    buf: &[u8],
    output: bool,
    copy_back: &mut alloc::vec::Vec<ChannelRecordCopyBack>,
) -> Result<(u32, usize), Errno> {
    if buf.is_empty() {
        return Ok((0, cursor));
    }
    let base = cursor;
    region.checked_range(base, buf.len())?;
    unsafe { core::ptr::copy_nonoverlapping(buf.as_ptr(), base as *mut u8, buf.len()) };
    if output {
        let original_offset = (buf.as_ptr() as usize)
            .checked_sub(data_base as usize)
            .ok_or(Errno::EFAULT)?;
        copy_back.push(ChannelRecordCopyBack {
            channel_dest: region_start
                .checked_add(original_offset)
                .ok_or(Errno::EFAULT)?,
            scratch_src: base,
            len: buf.len(),
        });
    }
    let next = align_up(
        base.checked_add(buf.len()).ok_or(Errno::EFAULT)?,
        KERNEL_WIRE_ALIGNMENT,
    )?;
    if next > region.end()? {
        return Err(Errno::EFAULT);
    }
    Ok((base as u32, next))
}

/// Lay a `select`/`pselect6` record's fd_set (and optional pselect6 sigmask)
/// spans at the FIXED disjoint offsets [`validate_select_layout`] re-proves:
/// fd_set arg `i` (`1..=3`) at `region.start + (i - 1) * FD_SET_BYTES`, and the
/// pselect6 sigmask (arg 5) at `region.start + 3 * FD_SET_BYTES`.
///
/// The generic contiguous packing in [`prepare_channel_record`] would shift
/// those offsets whenever a leading fd_set is null (the guest omits the span),
/// so these two syscalls get an explicit by-arg placement pass instead. fd_sets
/// are value-result (the kernel narrows them in place), so an `Out`/`InOut`
/// span records a copy-back to its original record offset exactly like the
/// generic path; the pselect6 sigmask is input-only.
///
/// # Safety
///
/// `region` must describe the live kernel-owned allocation, and every span in
/// `decoded` must borrow the owned snapshot starting at `data_base`.
unsafe fn prepare_select_record(
    region: ChannelScratchRegion,
    region_start: usize,
    is_pselect6: bool,
    decoded: &crate::channel_record_decode::DecodedSyscall<'_>,
    data_base: *const u8,
) -> Result<PreparedChannelRecord, Errno> {
    use wasm_posix_shared::channel_record::{SPAN_KIND_IN_OUT_PTR, SPAN_KIND_OUT_PTR};

    let fd_set_bytes = wasm_posix_shared::select::FD_SET_BYTES;
    let mut args = decoded.scalars;
    let mut copy_back: alloc::vec::Vec<ChannelRecordCopyBack> = alloc::vec::Vec::new();

    for span in &decoded.spans {
        // Neither select nor pselect6 carries a nested iovec/msghdr span.
        if span.nested.is_some() {
            return Err(Errno::EINVAL);
        }
        let arg_index = span.arg_index as usize;
        // fd_sets occupy slots 0..=2; the pselect6 sigmask follows them at slot
        // 3. Any other pointer arg for these syscalls is malformed.
        let slot = if (1..=3).contains(&arg_index) {
            arg_index - 1
        } else if is_pselect6 && arg_index == 5 {
            3
        } else {
            return Err(Errno::EINVAL);
        };
        let dest = region_start
            .checked_add(slot.checked_mul(fd_set_bytes).ok_or(Errno::EFAULT)?)
            .ok_or(Errno::EFAULT)?;
        let length = span.bytes.len();
        region.checked_range(dest, length)?;
        if length > 0 {
            unsafe {
                core::ptr::copy_nonoverlapping(span.bytes.as_ptr(), dest as *mut u8, length);
            }
        }
        args[arg_index] = dest as i64;

        if span.kind == SPAN_KIND_OUT_PTR || span.kind == SPAN_KIND_IN_OUT_PTR {
            let original_offset = (span.bytes.as_ptr() as usize)
                .checked_sub(data_base as usize)
                .ok_or(Errno::EFAULT)?;
            copy_back.push(ChannelRecordCopyBack {
                channel_dest: region_start
                    .checked_add(original_offset)
                    .ok_or(Errno::EFAULT)?,
                scratch_src: dest,
                len: length,
            });
        }
    }

    Ok(PreparedChannelRecord {
        syscall_nr: decoded.syscall as u32,
        args,
        copy_back,
    })
}

/// Detect and prepare an opaque channel record at the head of a live channel
/// scratch allocation (additive, dormant Phase 2 transport).
///
/// Today the host copies each pointer argument's bytes into the kernel scratch
/// region and rewrites the six channel arg words to absolute scratch addresses
/// before dispatch. When the guest self-marshals its arguments into a
/// self-describing record instead (later tasks flip the guest/host), this
/// reproduces that exact kernel-side state from the record so the UNCHANGED
/// legacy dispatch consumes the same validated scratch layout.
///
/// Returns:
/// - `None` when the region does not begin with
///   [`wasm_posix_shared::channel_record::RECORD_MAGIC`] (fall through to the
///   legacy host-copied-pointer path).
/// - `Some(Ok(prep))` when a well-formed record decoded and its flat spans were
///   laid into the region (`args` rewritten to scratch addresses).
/// - `Some(Err(errno))` when a magic-bearing record is malformed or uses a span
///   shape not yet reconstructable on this dormant path -- a truthful failure,
///   never a silent success.
///
/// The whole data region is copied out ONCE before any validation (the decoder
/// is TOCTOU-safe over that copy), so a concurrent guest mutation cannot change
/// the bytes between validation and use.
///
/// # Safety
///
/// `region` must describe the complete live kernel-owned allocation, and no
/// concurrent host operation may replace its bytes during this call or the
/// immediately following synchronous dispatch.
pub unsafe fn prepare_channel_record(
    region: ChannelScratchRegion,
) -> Option<Result<PreparedChannelRecord, Errno>> {
    use crate::channel_record_decode::{decode, Nested};
    use wasm_posix_shared::channel_record::{
        RECORD_MAGIC, SPAN_KIND_IN_OUT_PTR, SPAN_KIND_OUT_PTR,
    };
    use wasm_posix_shared::socket::KERNEL_MESSAGE_WIRE_FLATTENED_IOVEC_COUNT;

    let region_start = region.start();
    let data_capacity = match region.end() {
        Ok(end) => end - region_start,
        Err(_) => return Some(Err(Errno::EINVAL)),
    };

    // Read-once: copy the entire data region out before touching it, so the
    // decoder and the layout below observe an immutable snapshot.
    let data: alloc::vec::Vec<u8> =
        unsafe { core::slice::from_raw_parts(region_start as *const u8, data_capacity) }.to_vec();

    // Peek the magic from the owned copy; a mismatch is the legacy path.
    if data.len() < 4 || u32::from_le_bytes([data[0], data[1], data[2], data[3]]) != RECORD_MAGIC {
        return None;
    }

    let decoded = match decode(&data, data_capacity) {
        Ok(decoded) => decoded,
        // A malformed record is a truthful failure, never a silent success.
        Err(_) => return Some(Err(Errno::EINVAL)),
    };

    // select/pselect6 place their fd_sets (and the pselect6 sigmask) at FIXED
    // disjoint offsets the unchanged `validate_select_layout` re-proves, not the
    // contiguous packing the generic loop below uses. A leading null fd_set
    // would shift every following contiguous offset, so give these two syscalls
    // an explicit placement pass.
    let is_select = decoded.syscall as u32 == Syscall::Select as u32;
    let is_pselect6 = decoded.syscall as u32 == extended_syscalls::SYS_PSELECT6;
    if is_select || is_pselect6 {
        return Some(unsafe {
            prepare_select_record(region, region_start, is_pselect6, &decoded, data.as_ptr())
        });
    }

    // Start from the six scalar words; pointer arg slots are overwritten below
    // with the absolute scratch addresses their spans are laid at, exactly as
    // the host rewrites `CH_ARGS + argIndex*ARG_SIZE`.
    let mut args = decoded.scalars;
    let mut copy_back: alloc::vec::Vec<ChannelRecordCopyBack> = alloc::vec::Vec::new();
    let mut cursor = region_start;

    macro_rules! bail {
        ($errno:expr) => {
            return Some(Err($errno))
        };
    }
    macro_rules! bail_on {
        ($result:expr) => {
            match $result {
                Ok(value) => value,
                Err(errno) => return Some(Err(errno)),
            }
        };
    }

    for span in &decoded.spans {
        let arg_index = span.arg_index as usize;
        if arg_index >= args.len() {
            return Some(Err(Errno::EINVAL));
        }

        // Nested iovec/msghdr spans are reconstructed into the exact
        // `KernelIovecWire`/`KernelMsghdrWire` scratch layout the UNCHANGED
        // legacy dispatch (and its `validate_channel_scratch_arguments`
        // re-validation) consumes today. The iovec table / msghdr wire must
        // sit at the allocation base, matching the legacy host copy-in, so lay
        // them at `cursor` (which is the region base for these single-span
        // syscalls).
        match &span.nested {
            Some(Nested::Iovec(bufs)) => {
                let table_addr = cursor;
                let output = iovec_syscall_is_output(decoded.syscall);
                let next = bail_on!(unsafe {
                    lay_kernel_iovec_block(
                        region,
                        data.as_ptr(),
                        region_start,
                        table_addr,
                        bufs,
                        output,
                        &mut copy_back,
                    )
                });
                // writev/readv/preadv/pwritev take (fd, iov, iovcnt, ...): the
                // iovec pointer is this span's arg and the count is the next
                // arg word.
                let count_index = match arg_index.checked_add(1) {
                    Some(index) if index < args.len() => index,
                    _ => bail!(Errno::EINVAL),
                };
                args[arg_index] = table_addr as i64;
                args[count_index] = bufs.len() as i64;
                cursor = next;
                continue;
            }
            Some(Nested::MsgHdr {
                name,
                iov,
                control,
                flags,
            }) => {
                // The legacy canonical msghdr wire flattens the scatter/gather
                // list to at most one buffer (KERNEL_MESSAGE_WIRE_FLATTENED_-
                // IOVEC_COUNT). More than one entry is a truthful EINVAL.
                if iov.len() > KERNEL_MESSAGE_WIRE_FLATTENED_IOVEC_COUNT as usize {
                    bail!(Errno::EINVAL);
                }
                let output = decoded.syscall == Syscall::Recvmsg as u16;

                let wire_addr = cursor;
                let wire_bytes = size_of::<KernelMsghdrWire>();
                bail_on!(region.checked_range(wire_addr, wire_bytes));
                // The referenced payloads follow the fixed wire in the exact
                // order the validator walks them: name, control, iovec block.
                let mut sub_cursor = match wire_addr.checked_add(wire_bytes) {
                    Some(value) => value,
                    None => bail!(Errno::EFAULT),
                };

                let (name_field, sub_cursor_after_name) = bail_on!(unsafe {
                    lay_msghdr_subbuffer(
                        region,
                        data.as_ptr(),
                        region_start,
                        sub_cursor,
                        name,
                        output,
                        &mut copy_back,
                    )
                });
                sub_cursor = sub_cursor_after_name;

                let (control_field, sub_cursor_after_control) = bail_on!(unsafe {
                    lay_msghdr_subbuffer(
                        region,
                        data.as_ptr(),
                        region_start,
                        sub_cursor,
                        control,
                        output,
                        &mut copy_back,
                    )
                });
                sub_cursor = sub_cursor_after_control;

                let iov_table_addr = sub_cursor;
                let next = bail_on!(unsafe {
                    lay_kernel_iovec_block(
                        region,
                        data.as_ptr(),
                        region_start,
                        iov_table_addr,
                        iov,
                        output,
                        &mut copy_back,
                    )
                });
                let iov_field = if iov.is_empty() {
                    0u32
                } else {
                    iov_table_addr as u32
                };
                sub_cursor = next;

                // Materialize the KernelMsghdrWire the legacy sendmsg/recvmsg
                // dispatch reads. Fields are u32 offsets into this same live
                // allocation.
                let write_field = |field_offset: usize, value: u32| -> Result<(), Errno> {
                    let addr = wire_addr.checked_add(field_offset).ok_or(Errno::EFAULT)?;
                    unsafe { write_scratch_u32(addr, value) };
                    Ok(())
                };
                bail_on!(write_field(offset_of!(KernelMsghdrWire, name), name_field));
                bail_on!(write_field(
                    offset_of!(KernelMsghdrWire, name_len),
                    name.len() as u32
                ));
                bail_on!(write_field(offset_of!(KernelMsghdrWire, iov), iov_field));
                bail_on!(write_field(
                    offset_of!(KernelMsghdrWire, iov_len),
                    iov.len() as u32
                ));
                bail_on!(write_field(
                    offset_of!(KernelMsghdrWire, control),
                    control_field
                ));
                bail_on!(write_field(
                    offset_of!(KernelMsghdrWire, control_len),
                    control.len() as u32
                ));
                bail_on!(write_field(offset_of!(KernelMsghdrWire, flags), *flags));

                // recvmsg reports value-result lengths and output flags by
                // updating the KernelMsghdrWire in place. Reflect those three
                // fields back to the record's msghdr region so a record-path
                // caller reads them exactly where it marshalled them. The record
                // msghdr region layout is { name_off, name_len, <iovec block>,
                // control_off, control_len, flags }; name_len sits at offset 4
                // and control_len/flags are the final two u32s of the structural
                // prefix (`span.bytes`).
                if output {
                    let struct_prefix = span.bytes.len();
                    let region_offset = match (span.bytes.as_ptr() as usize)
                        .checked_sub(data.as_ptr() as usize)
                    {
                        Some(value) => value,
                        None => bail!(Errno::EFAULT),
                    };
                    let record_field = |field_offset: usize| -> Option<usize> {
                        region_offset
                            .checked_add(field_offset)
                            .and_then(|value| region_start.checked_add(value))
                    };
                    let control_len_off = match struct_prefix.checked_sub(8) {
                        Some(value) => value,
                        None => bail!(Errno::EINVAL),
                    };
                    let flags_off = match struct_prefix.checked_sub(4) {
                        Some(value) => value,
                        None => bail!(Errno::EINVAL),
                    };
                    let scratch_field = |field_offset: usize| -> Option<usize> {
                        wire_addr.checked_add(field_offset)
                    };
                    for (scratch_offset, record_offset) in [
                        (offset_of!(KernelMsghdrWire, name_len), 4usize),
                        (offset_of!(KernelMsghdrWire, control_len), control_len_off),
                        (offset_of!(KernelMsghdrWire, flags), flags_off),
                    ] {
                        let scratch_src = match scratch_field(scratch_offset) {
                            Some(value) => value,
                            None => bail!(Errno::EFAULT),
                        };
                        let channel_dest = match record_field(record_offset) {
                            Some(value) => value,
                            None => bail!(Errno::EFAULT),
                        };
                        copy_back.push(ChannelRecordCopyBack {
                            channel_dest,
                            scratch_src,
                            len: size_of::<u32>(),
                        });
                    }
                }

                args[arg_index] = wire_addr as i64;
                cursor = sub_cursor;
                continue;
            }
            None => {}
        }

        let length = span.bytes.len();
        if length == 0 {
            // The host canonicalizes every empty borrow to the allocation base;
            // mirror that so descriptor validation accepts the empty argument.
            args[arg_index] = region_start as i64;
            continue;
        }

        let dest = cursor;
        // Bounds-check the destination range against the live allocation using
        // the same contract the legacy validator uses.
        if region.checked_range(dest, length).is_err() {
            return Some(Err(Errno::EINVAL));
        }
        // Copy the payload from the owned record snapshot into the scratch
        // layout the legacy dispatch expects (contiguous, in span order).
        unsafe {
            core::ptr::copy_nonoverlapping(span.bytes.as_ptr(), dest as *mut u8, length);
        }
        args[arg_index] = dest as i64;

        if span.kind == SPAN_KIND_OUT_PTR || span.kind == SPAN_KIND_IN_OUT_PTR {
            // The span's original offset within the data region is where a
            // record-path caller reads its output back.
            let original_offset = span.bytes.as_ptr() as usize - data.as_ptr() as usize;
            copy_back.push(ChannelRecordCopyBack {
                channel_dest: region_start + original_offset,
                scratch_src: dest,
                len: length,
            });
        }

        // Advance with the same 8-byte alignment the host copy-in and the
        // descriptor validator use between successive pointer payloads.
        let next = match dest.checked_add(length).and_then(|v| v.checked_add(7)) {
            Some(v) => v & !7usize,
            None => return Some(Err(Errno::EINVAL)),
        };
        match region.end() {
            Ok(end) if next <= end => cursor = next,
            _ => return Some(Err(Errno::EINVAL)),
        }
    }

    Some(Ok(PreparedChannelRecord {
        syscall_nr: decoded.syscall as u32,
        args,
        copy_back,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloc::vec;
    use wasm_posix_shared::platform_limits;

    fn pointer_arg(pointer: usize) -> i64 {
        i64::try_from(pointer).expect("native test pointer fits widened channel slot")
    }

    #[test]
    fn checked_range_accepts_exact_end_and_rejects_capacity_plus_one() {
        let region = ChannelScratchRegion::new(0x1000, 16).unwrap();
        assert_eq!(
            region.checked_range(0x1008, 8),
            Ok(ChannelScratchRange {
                start: 0x1008,
                length: 8,
            }),
        );
        assert_eq!(region.checked_range(0x1008, 9), Err(Errno::EFAULT));
        assert_eq!(region.checked_range(usize::MAX, 1), Err(Errno::EFAULT));
        assert_eq!(region.checked_range(0x1010, 0).unwrap().length, 0);
    }

    #[test]
    fn checked_start_range_requires_the_owned_base_and_explicit_capacity() {
        let region = ChannelScratchRegion::new(0x1000, 16).unwrap();
        assert_eq!(
            region.checked_start_range(0x1000, 16),
            Ok(ChannelScratchRange {
                start: 0x1000,
                length: 16,
            }),
        );
        assert_eq!(
            region.checked_start_range(0x1000, 17),
            Err(Errno::EFAULT),
        );
        assert_eq!(
            region.checked_start_range(0x1001, 15),
            Err(Errno::EFAULT),
        );
        assert_eq!(region.checked_start_range(0, 0), Err(Errno::EFAULT));
    }

    #[test]
    fn dynamic_buffers_reject_positive_null_and_canonicalize_empty_null() {
        let bytes = vec![0u8; 16];
        let start = bytes.as_ptr() as usize;
        let region = ChannelScratchRegion::new(start, bytes.len()).unwrap();

        for syscall in [Syscall::Read as u32, Syscall::Write as u32] {
            let mut positive = [0i64; 6];
            positive[2] = 1;
            assert_eq!(
                unsafe { validate_channel_scratch_arguments(syscall, &positive, region) },
                Err(Errno::EFAULT),
            );

            let empty = [0i64; 6];
            let validated =
                unsafe { validate_channel_scratch_arguments(syscall, &empty, region) }.unwrap();
            assert_eq!(validated.pointer(1), Ok(start));
        }
    }

    #[test]
    fn group_descriptors_prove_complete_vectors_and_reject_oversized_counts() {
        let bytes = vec![0u8; crate::credentials::NGROUPS_MAX * size_of::<u32>()];
        let start = bytes.as_ptr() as usize;
        let region = ChannelScratchRegion::new(start, bytes.len()).unwrap();

        let mut getgroups = [0i64; 6];
        getgroups[0] = 3;
        getgroups[1] = pointer_arg(start);
        let validated = unsafe {
            validate_channel_scratch_arguments(Syscall::Getgroups as u32, &getgroups, region)
        }
        .unwrap();
        assert_eq!(validated.pointer(1), Ok(start));

        getgroups[0] = (crate::credentials::NGROUPS_MAX + 1) as i64;
        getgroups[2] = size_of::<u32>() as i64;
        assert_eq!(
            unsafe {
                validate_channel_scratch_arguments(Syscall::Getgroups as u32, &getgroups, region)
            },
            Err(Errno::EINVAL),
        );

        let mut setgroups = [0i64; 6];
        setgroups[0] = 3;
        setgroups[1] = pointer_arg(start);
        let validated = unsafe {
            validate_channel_scratch_arguments(Syscall::Setgroups as u32, &setgroups, region)
        }
        .unwrap();
        assert_eq!(validated.pointer(1), Ok(start));
    }

    #[test]
    fn zero_iovec_count_ignores_pointer_without_reading_it() {
        let bytes = [0u8; 1];
        let region = ChannelScratchRegion::new(bytes.as_ptr() as usize, bytes.len()).unwrap();
        for ignored_pointer in [0, i64::MIN, -1] {
            let mut args = [0i64; 6];
            args[1] = ignored_pointer;
            args[2] = 0;
            let validated = unsafe { validate_iovec_layout(&args, region) }.unwrap();
            assert_eq!(validated.pointer(1), Ok(0));
        }

        let mut args = [0i64; 6];
        args[2] = -1;
        assert_eq!(
            unsafe { validate_iovec_layout(&args, region) },
            Err(Errno::EINVAL),
        );
        args[2] = i64::try_from(platform_limits::IOV_MAX + 1).unwrap();
        assert_eq!(
            unsafe { validate_iovec_layout(&args, region) },
            Err(Errno::EINVAL),
        );
    }

    #[test]
    fn message_layout_distinguishes_absent_and_present_zero_capacity_names() {
        let start = 0x1000usize;
        let header_size = size_of::<KernelMsghdrWire>();
        let region = ChannelScratchRegion::new(start, header_size).unwrap();
        let canonical_zero_extent = start.checked_add(header_size).unwrap();
        let mut header = vec![0u8; header_size];

        let set_name = |header: &mut [u8], pointer: usize| {
            let pointer = u32::try_from(pointer).unwrap().to_le_bytes();
            let offset = offset_of!(KernelMsghdrWire, name);
            header[offset..offset + pointer.len()].copy_from_slice(&pointer);
        };

        // Both sendmsg and recvmsg use this canonical nested-wire validator.
        // Null encodes absence, while the current checked cursor encodes a
        // present output field whose caller capacity is exactly zero.
        set_name(&mut header, 0);
        assert!(unsafe { validate_message_wire_layout(&header, region) }.is_ok());

        set_name(&mut header, canonical_zero_extent);
        assert!(unsafe { validate_message_wire_layout(&header, region) }.is_ok());

        set_name(&mut header, canonical_zero_extent + 1);
        assert_eq!(
            unsafe { validate_message_wire_layout(&header, region) },
            Err(Errno::EFAULT),
        );
    }

    #[test]
    fn fixed_buffers_require_explicit_nullable_metadata() {
        let bytes = vec![0u8; 512];
        let start = bytes.as_ptr() as usize;
        let region = ChannelScratchRegion::new(start, bytes.len()).unwrap();
        let args = [0i64; 6];

        for syscall in [Syscall::Pipe as u32, Syscall::Uname as u32] {
            assert_eq!(
                unsafe { validate_channel_scratch_arguments(syscall, &args, region) },
                Err(Errno::EFAULT),
            );
        }

        let nullable = unsafe {
            validate_channel_scratch_arguments(extended_syscalls::SYS_SENDFILE, &args, region)
        }
        .unwrap();
        assert_eq!(nullable.pointer(2), Ok(0));
    }

    #[test]
    fn prctl_proves_only_name_buffers_as_scratch() {
        let bytes = vec![0u8; kernel_scratch_wire::PRCTL_NAME_BYTES as usize];
        let start = bytes.as_ptr() as usize;
        let region = ChannelScratchRegion::new(start, bytes.len()).unwrap();
        let mut args = [0i64; 6];
        args[0] = i64::from(prctl::PR_SET_NAME);
        args[1] = pointer_arg(start);

        let validated = unsafe {
            validate_channel_scratch_arguments(extended_syscalls::SYS_PRCTL, &args, region)
        }
        .unwrap();
        assert_eq!(validated.pointer(1), Ok(start));

        args[1] = 0;
        assert_eq!(
            unsafe {
                validate_channel_scratch_arguments(extended_syscalls::SYS_PRCTL, &args, region)
            },
            Err(Errno::EFAULT),
        );

        args[0] = 999;
        args[1] = i64::MAX;
        let scalar = unsafe {
            validate_channel_scratch_arguments(extended_syscalls::SYS_PRCTL, &args, region)
        }
        .unwrap();
        assert_eq!(scalar.pointer(1), Err(Errno::EFAULT));

        let short_region = ChannelScratchRegion::new(start, bytes.len() - 1).unwrap();
        args[0] = i64::from(prctl::PR_GET_NAME);
        args[1] = pointer_arg(start);
        assert_eq!(
            unsafe {
                validate_channel_scratch_arguments(
                    extended_syscalls::SYS_PRCTL,
                    &args,
                    short_region,
                )
            },
            Err(Errno::EFAULT),
        );
    }


    #[test]
    fn descriptor_range_accepts_capacity_and_rejects_capacity_plus_one() {
        let bytes = vec![0u8; 16];
        let start = bytes.as_ptr() as usize;
        let region = ChannelScratchRegion::new(start, bytes.len()).unwrap();
        let mut args = [0i64; 6];
        args[1] = pointer_arg(start);
        args[2] = bytes.len() as i64;

        let validated =
            unsafe { validate_channel_scratch_arguments(Syscall::Read as u32, &args, region) }
                .unwrap();
        assert_eq!(validated.pointer(1), Ok(start));

        args[2] += 1;
        assert_eq!(
            unsafe { validate_channel_scratch_arguments(Syscall::Read as u32, &args, region) },
            Err(Errno::EFAULT),
        );
    }

    #[test]
    fn descriptor_rejects_negative_and_overflowing_dynamic_lengths() {
        let bytes = vec![0u8; 16];
        let start = bytes.as_ptr() as usize;
        let region = ChannelScratchRegion::new(start, bytes.len()).unwrap();
        let mut args = [0i64; 6];
        args[1] = pointer_arg(start);

        args[2] = -1;
        assert_eq!(
            unsafe { validate_channel_scratch_arguments(Syscall::Write as u32, &args, region) },
            Err(Errno::EINVAL),
        );
        args[2] = MAX_SAFE_INTEGER + 1;
        assert_eq!(
            unsafe { validate_channel_scratch_arguments(Syscall::Write as u32, &args, region) },
            Err(Errno::EINVAL),
        );
    }

    #[test]
    fn dereferenced_length_must_preserve_the_canonical_following_slot() {
        let mut bytes = vec![0u8; 64];
        let start = bytes.as_mut_ptr() as usize;
        assert_eq!(start % SCRATCH_ALIGNMENT, 0);
        let region = ChannelScratchRegion::new(start, bytes.len()).unwrap();
        let mut args = [0i64; 6];
        args[1] = pointer_arg(start);
        args[2] = 16;
        args[4] = pointer_arg(start + 16);
        args[5] = pointer_arg(start + 24);
        bytes[24..28].copy_from_slice(&4u32.to_le_bytes());

        assert!(
            unsafe { validate_channel_scratch_arguments(Syscall::Recvfrom as u32, &args, region) }
                .is_ok()
        );

        // This models a second/torn socklen observation after the host sized
        // the address subregion. Growing across the alignment boundary moves
        // the canonical length slot and must be rejected before recvfrom can
        // form its output slice.
        bytes[24..28].copy_from_slice(&12u32.to_le_bytes());
        assert_eq!(
            unsafe { validate_channel_scratch_arguments(Syscall::Recvfrom as u32, &args, region) },
            Err(Errno::EFAULT),
        );
    }

    #[test]
    fn dereferenced_region_rejects_data_without_a_length_pointer() {
        let bytes = vec![0u8; 64];
        let start = bytes.as_ptr() as usize;
        let region = ChannelScratchRegion::new(start, bytes.len()).unwrap();
        let mut args = [0i64; 6];
        args[1] = pointer_arg(start);
        args[2] = 8;
        args[4] = pointer_arg(start + 8);
        args[5] = 0;

        assert_eq!(
            unsafe { validate_channel_scratch_arguments(Syscall::Recvfrom as u32, &args, region) },
            Err(Errno::EFAULT),
        );
    }

    #[test]
    fn select_requires_each_nonnull_fdset_at_its_fixed_disjoint_slot() {
        let bytes = vec![0u8; 3 * wasm_posix_shared::select::FD_SET_BYTES];
        let start = bytes.as_ptr() as usize;
        let region = ChannelScratchRegion::new(start, bytes.len()).unwrap();
        let mut args = [0i64; 6];
        args[1] = pointer_arg(start);
        args[2] = pointer_arg(start + wasm_posix_shared::select::FD_SET_BYTES);
        args[3] = pointer_arg(start + 2 * wasm_posix_shared::select::FD_SET_BYTES);

        assert!(
            unsafe { validate_channel_scratch_arguments(Syscall::Select as u32, &args, region) }
                .is_ok()
        );
        args[2] = args[1];
        assert_eq!(
            unsafe { validate_channel_scratch_arguments(Syscall::Select as u32, &args, region) },
            Err(Errno::EFAULT),
        );
    }

    #[test]
    fn cstr_accepts_a_nul_at_the_last_region_byte() {
        let bytes = b"abc\0";
        let region = ChannelScratchRegion::new(bytes.as_ptr() as usize, bytes.len()).unwrap();
        assert_eq!(unsafe { checked_cstr_len(bytes.as_ptr(), region) }, Ok(3));
    }

    #[test]
    fn cstr_does_not_read_a_sentinel_outside_the_region() {
        let bytes = b"ab\0";
        let shorter_region =
            ChannelScratchRegion::new(bytes.as_ptr() as usize, bytes.len() - 1).unwrap();
        assert_eq!(
            unsafe { checked_cstr_len(bytes.as_ptr(), shorter_region) },
            Err(Errno::EFAULT),
        );
    }

    #[test]
    fn cstr_rejects_pointers_outside_or_overflowing_the_region() {
        let bytes = b"abc\0";
        let start = bytes.as_ptr() as usize;
        let region = ChannelScratchRegion::new(start, bytes.len()).unwrap();

        assert_eq!(
            unsafe { checked_cstr_len(core::ptr::null(), region) },
            Err(Errno::EFAULT),
        );
        assert_eq!(
            unsafe { checked_cstr_len((start - 1) as *const u8, region) },
            Err(Errno::EFAULT),
        );
        assert_eq!(
            unsafe { checked_cstr_len((start + bytes.len()) as *const u8, region) },
            Err(Errno::EFAULT),
        );
        assert_eq!(
            unsafe { checked_cstr_len(usize::MAX as *const u8, region) },
            Err(Errno::EFAULT),
        );
        assert_eq!(ChannelScratchRegion::new(usize::MAX, 1), Err(Errno::EFAULT));
        assert_eq!(
            ChannelScratchRegion::for_channel(usize::MAX),
            Err(Errno::EFAULT),
        );
    }

    #[test]
    fn cstr_accepts_non_path_strings_larger_than_path_max() {
        let mut bytes = vec![b'a'; platform_limits::PATH_MAX_BYTES + 2];
        *bytes.last_mut().unwrap() = 0;
        let region = ChannelScratchRegion::new(bytes.as_ptr() as usize, bytes.len()).unwrap();

        assert_eq!(
            unsafe { checked_cstr_len(bytes.as_ptr(), region) },
            Ok((platform_limits::PATH_MAX_BYTES + 1) as u32),
        );
    }

    #[test]
    fn descriptor_cstr_bound_accepts_exact_capacity_and_rejects_capacity_plus_one() {
        let capacity = platform_limits::PROCESS_METADATA_ENTRY_MAX_BYTES + 1;
        let descriptor = SyscallArgDesc {
            arg_index: 0,
            direction: wasm_posix_shared::host_abi::SyscallArgDirection::In,
            size: SyscallArgSize::CString {
                max_bytes: capacity as u32,
                too_long_errno: Errno::E2BIG as u32,
            },
            nullable: false,
            required: true,
            copy_out_length: None,
        };
        let mut exact = vec![b'a'; capacity];
        *exact.last_mut().unwrap() = 0;
        let exact_region =
            ChannelScratchRegion::new(exact.as_ptr() as usize, exact.len()).unwrap();
        let mut args = [0i64; 6];
        args[0] = pointer_arg(exact.as_ptr() as usize);
        assert_eq!(
            unsafe { descriptor_size(&descriptor, &args, exact_region) },
            Ok(capacity),
        );

        let mut oversized = vec![b'a'; capacity + 1];
        *oversized.last_mut().unwrap() = 0;
        let oversized_region =
            ChannelScratchRegion::new(oversized.as_ptr() as usize, oversized.len()).unwrap();
        args[0] = pointer_arg(oversized.as_ptr() as usize);
        assert_eq!(
            unsafe { descriptor_size(&descriptor, &args, oversized_region) },
            Err(Errno::E2BIG),
        );
    }

    // -----------------------------------------------------------------------
    // Task 4 (Phase 2 opaque transport): kernel-side record preparation.
    //
    // `prepare_channel_record` reconstructs the exact scratch layout + rewritten
    // arg words the host copy-in produces today, from a self-marshalled record.
    // It is exercised only by tests until later tasks flip the guest/host.
    // -----------------------------------------------------------------------
    use wasm_posix_shared::channel_record::{
        RECORD_ABI, RECORD_HEADER_BYTES, RECORD_MAGIC, SPAN_DESCRIPTOR_BYTES,
        SPAN_KIND_IN_PTR, SPAN_KIND_IOVEC_ARRAY, SPAN_KIND_MSGHDR, SPAN_KIND_OUT_PTR,
    };

    struct RecSpan {
        kind: u8,
        arg_index: u8,
        payload: alloc::vec::Vec<u8>,
    }

    /// Build a record (header + descriptors + payloads) into a `capacity`-byte
    /// data region. Mirrors the `channel_record` byte layout.
    fn build_record(
        syscall: u16,
        record_abi: u16,
        scalars: [i64; 6],
        spans: &[RecSpan],
        capacity: usize,
    ) -> alloc::vec::Vec<u8> {
        let n = spans.len();
        let desc_end = RECORD_HEADER_BYTES + n * SPAN_DESCRIPTOR_BYTES;

        let mut descriptors: alloc::vec::Vec<u8> = alloc::vec::Vec::new();
        let mut payload: alloc::vec::Vec<u8> = alloc::vec::Vec::new();
        for span in spans {
            let off = (desc_end + payload.len()) as u32;
            descriptors.push(span.kind);
            descriptors.push(span.arg_index);
            descriptors.extend_from_slice(&0u16.to_le_bytes());
            descriptors.extend_from_slice(&off.to_le_bytes());
            descriptors.extend_from_slice(&(span.payload.len() as u32).to_le_bytes());
            payload.extend_from_slice(&span.payload);
        }

        let mut out: alloc::vec::Vec<u8> = alloc::vec::Vec::new();
        out.extend_from_slice(&RECORD_MAGIC.to_le_bytes());
        out.extend_from_slice(&record_abi.to_le_bytes());
        out.extend_from_slice(&syscall.to_le_bytes());
        out.extend_from_slice(&(n as u16).to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes()); // flags
        out.extend_from_slice(&0u32.to_le_bytes()); // _reserved
        for s in &scalars {
            out.extend_from_slice(&s.to_le_bytes());
        }
        assert_eq!(out.len(), RECORD_HEADER_BYTES);
        out.extend_from_slice(&descriptors);
        out.extend_from_slice(&payload);
        assert!(out.len() <= capacity);
        out.resize(capacity, 0);
        out
    }

    const REC_CAP: usize = 4096;

    #[test]
    fn record_in_ptr_lays_payload_into_scratch_and_rewrites_args() {
        // write(fd=7, buf, count=5): arg1 is the buffer, arg2 the count.
        let mut data = build_record(
            wasm_posix_shared::Syscall::Write as u16,
            RECORD_ABI,
            [7, 0, 5, 0, 0, 0],
            &[RecSpan {
                kind: SPAN_KIND_IN_PTR,
                arg_index: 1,
                payload: b"hello".to_vec(),
            }],
            REC_CAP,
        );
        let start = data.as_mut_ptr() as usize;
        let region = ChannelScratchRegion::new(start, REC_CAP).unwrap();

        let prep = match unsafe { prepare_channel_record(region) } {
            Some(Ok(prep)) => prep,
            other => panic!("expected prepared record, got {other:?}"),
        };
        assert_eq!(prep.syscall_nr, wasm_posix_shared::Syscall::Write as u32);
        assert_eq!(prep.args[0], 7);
        // The buffer arg was rewritten to the scratch base (first span).
        assert_eq!(prep.args[1] as usize, start);
        assert_eq!(prep.args[2], 5);
        assert!(prep.copy_back.is_empty());
        // The payload was copied into the scratch layout at the rewritten addr.
        assert_eq!(&data[0..5], b"hello");
    }

    #[test]
    fn record_out_ptr_plans_copyback_to_original_span_offset() {
        let mut data = build_record(
            wasm_posix_shared::Syscall::Read as u16,
            RECORD_ABI,
            [3, 0, 8, 0, 0, 0],
            &[RecSpan {
                kind: SPAN_KIND_OUT_PTR,
                arg_index: 1,
                payload: alloc::vec![0u8; 8],
            }],
            REC_CAP,
        );
        let start = data.as_mut_ptr() as usize;
        let region = ChannelScratchRegion::new(start, REC_CAP).unwrap();

        let prep = match unsafe { prepare_channel_record(region) } {
            Some(Ok(prep)) => prep,
            other => panic!("expected prepared record, got {other:?}"),
        };
        assert_eq!(prep.args[1] as usize, start);
        assert_eq!(prep.copy_back.len(), 1);
        let cb = prep.copy_back[0];
        // Output is read back from the record's original span offset (after the
        // 64-byte header + one 12-byte descriptor).
        assert_eq!(
            cb.channel_dest,
            start + RECORD_HEADER_BYTES + SPAN_DESCRIPTOR_BYTES
        );
        assert_eq!(cb.scratch_src, start);
        assert_eq!(cb.len, 8);
    }

    #[test]
    fn record_non_magic_region_falls_through_to_legacy_path() {
        let mut data = vec![0u8; REC_CAP];
        let region =
            ChannelScratchRegion::new(data.as_mut_ptr() as usize, REC_CAP).unwrap();
        assert!(unsafe { prepare_channel_record(region) }.is_none());
    }

    #[test]
    fn record_malformed_span_is_a_truthful_einval() {
        let mut data = build_record(
            wasm_posix_shared::Syscall::Write as u16,
            RECORD_ABI,
            [1, 0, 4, 0, 0, 0],
            &[RecSpan {
                kind: SPAN_KIND_IN_PTR,
                arg_index: 1,
                payload: b"abcd".to_vec(),
            }],
            REC_CAP,
        );
        // Corrupt the single descriptor's len to run past the capacity.
        let dpos = RECORD_HEADER_BYTES;
        let huge = ((REC_CAP as u32) + 16).to_le_bytes();
        data[dpos + 8..dpos + 12].copy_from_slice(&huge);
        let region =
            ChannelScratchRegion::new(data.as_mut_ptr() as usize, REC_CAP).unwrap();
        assert_eq!(
            unsafe { prepare_channel_record(region) },
            Some(Err(Errno::EINVAL))
        );
    }

    // -----------------------------------------------------------------------
    // Task 4b (Phase 2 opaque transport): nested iovec/msghdr reconstruction.
    //
    // The record's nested regions are reconstructed into the exact
    // `KernelIovecWire`/`KernelMsghdrWire` scratch layout the UNCHANGED legacy
    // dispatch (and its `validate_channel_scratch_arguments` re-validation)
    // consume. These tests assert that byte layout and the copy-back plan.
    // -----------------------------------------------------------------------

    /// Byte offset of the sole span's referenced region within the record.
    const SINGLE_SPAN_REGION_OFF: usize = RECORD_HEADER_BYTES + SPAN_DESCRIPTOR_BYTES;

    /// Build a one-span record whose descriptor points at `region_payload`.
    /// `descriptor_len` is the span's declared length: the whole region for an
    /// iovec array, or just the structural prefix for a msghdr.
    fn build_single_span_record(
        syscall: u16,
        scalars: [i64; 6],
        kind: u8,
        arg_index: u8,
        region_payload: &[u8],
        descriptor_len: u32,
        capacity: usize,
    ) -> alloc::vec::Vec<u8> {
        let mut out: alloc::vec::Vec<u8> = alloc::vec::Vec::new();
        out.extend_from_slice(&RECORD_MAGIC.to_le_bytes());
        out.extend_from_slice(&RECORD_ABI.to_le_bytes());
        out.extend_from_slice(&syscall.to_le_bytes());
        out.extend_from_slice(&1u16.to_le_bytes()); // span_count
        out.extend_from_slice(&0u16.to_le_bytes()); // flags
        out.extend_from_slice(&0u32.to_le_bytes()); // _reserved
        for s in &scalars {
            out.extend_from_slice(&s.to_le_bytes());
        }
        assert_eq!(out.len(), RECORD_HEADER_BYTES);
        out.push(kind);
        out.push(arg_index);
        out.extend_from_slice(&0u16.to_le_bytes()); // _pad
        out.extend_from_slice(&(SINGLE_SPAN_REGION_OFF as u32).to_le_bytes());
        out.extend_from_slice(&descriptor_len.to_le_bytes());
        assert_eq!(out.len(), SINGLE_SPAN_REGION_OFF);
        out.extend_from_slice(region_payload);
        assert!(out.len() <= capacity);
        out.resize(capacity, 0);
        out
    }

    /// Encode `{ u32 count; count*(u32 buf_off, u32 buf_len); buffers }` with
    /// absolute buffer offsets, exactly as the guest self-marshaller and the
    /// decoder's reference encoder do.
    fn encode_iovec_region(region_off: usize, buffers: &[&[u8]]) -> alloc::vec::Vec<u8> {
        let count = buffers.len();
        let struct_len = 4 + count * 8;
        let mut cursor = region_off + struct_len;
        let mut entries: alloc::vec::Vec<u8> = alloc::vec::Vec::new();
        let mut buf_bytes: alloc::vec::Vec<u8> = alloc::vec::Vec::new();
        for b in buffers {
            entries.extend_from_slice(&(cursor as u32).to_le_bytes());
            entries.extend_from_slice(&(b.len() as u32).to_le_bytes());
            buf_bytes.extend_from_slice(b);
            cursor += b.len();
        }
        let mut out: alloc::vec::Vec<u8> = alloc::vec::Vec::new();
        out.extend_from_slice(&(count as u32).to_le_bytes());
        out.extend_from_slice(&entries);
        out.extend_from_slice(&buf_bytes);
        out
    }

    /// Encode a msghdr region `{ name_off,name_len; <iovec block>;
    /// control_off,control_len; flags; referenced bytes }`. Returns
    /// `(bytes, struct_len)` where `struct_len` is the descriptor length.
    fn encode_msghdr_region(
        region_off: usize,
        name: &[u8],
        iov: &[&[u8]],
        control: &[u8],
        flags: u32,
    ) -> (alloc::vec::Vec<u8>, usize) {
        let count = iov.len();
        let struct_len = 8 + (4 + count * 8) + 12;
        let mut cursor = region_off + struct_len;
        let name_off = if name.is_empty() { 0 } else { cursor as u32 };
        cursor += name.len();

        let mut entries: alloc::vec::Vec<u8> = alloc::vec::Vec::new();
        let mut ref_bytes: alloc::vec::Vec<u8> = alloc::vec::Vec::new();
        ref_bytes.extend_from_slice(name);
        for b in iov {
            entries.extend_from_slice(&(cursor as u32).to_le_bytes());
            entries.extend_from_slice(&(b.len() as u32).to_le_bytes());
            ref_bytes.extend_from_slice(b);
            cursor += b.len();
        }
        let control_off = if control.is_empty() { 0 } else { cursor as u32 };
        ref_bytes.extend_from_slice(control);

        let mut out: alloc::vec::Vec<u8> = alloc::vec::Vec::new();
        out.extend_from_slice(&name_off.to_le_bytes());
        out.extend_from_slice(&(name.len() as u32).to_le_bytes());
        out.extend_from_slice(&(count as u32).to_le_bytes());
        out.extend_from_slice(&entries);
        out.extend_from_slice(&control_off.to_le_bytes());
        out.extend_from_slice(&(control.len() as u32).to_le_bytes());
        out.extend_from_slice(&flags.to_le_bytes());
        assert_eq!(out.len(), struct_len);
        out.extend_from_slice(&ref_bytes);
        (out, struct_len)
    }

    fn read_scratch_u32(data: &[u8], offset: usize) -> u32 {
        u32::from_le_bytes(data[offset..offset + 4].try_into().unwrap())
    }

    #[test]
    fn record_iovec_array_writev_lays_table_and_buffers_and_rewrites_args() {
        let bufs: [&[u8]; 3] = [b"one", b"twotwo", b"three!!"];
        let region = encode_iovec_region(SINGLE_SPAN_REGION_OFF, &bufs);
        let region_len = region.len() as u32;
        let mut data = build_single_span_record(
            wasm_posix_shared::Syscall::Writev as u16,
            [7, 0, 0, 0, 0, 0], // fd, iov(overwritten), iovcnt(overwritten), ...
            SPAN_KIND_IOVEC_ARRAY,
            1,
            &region,
            region_len,
            REC_CAP,
        );
        let start = data.as_mut_ptr() as usize;
        let scratch = ChannelScratchRegion::new(start, REC_CAP).unwrap();

        let prep = match unsafe { prepare_channel_record(scratch) } {
            Some(Ok(prep)) => prep,
            other => panic!("expected prepared record, got {other:?}"),
        };
        assert_eq!(prep.syscall_nr, wasm_posix_shared::Syscall::Writev as u32);
        assert_eq!(prep.args[0], 7);
        // iov pointer rewritten to the table base (== allocation base) and the
        // iovcnt rewritten to the decoded entry count.
        assert_eq!(prep.args[1] as usize, start);
        assert_eq!(prep.args[2], 3);
        // writev only reads; no output copy-back.
        assert!(prep.copy_back.is_empty());

        // The KernelIovecWire table (3 * { u32 base, u32 len }) sits at the
        // allocation base, followed by the buffers, each 4-byte aligned.
        let base0 = start + 24; // after the 3-entry table
        let base1 = (base0 + 3 + 3) & !3; // align_up(base0 + 3, 4)
        let base2 = (base1 + 6 + 3) & !3; // align_up(base1 + 6, 4)
        for (i, (base, len)) in [(base0, 3usize), (base1, 6), (base2, 7)]
            .into_iter()
            .enumerate()
        {
            assert_eq!(read_scratch_u32(&data, i * 8), base as u32, "entry {i} base");
            assert_eq!(read_scratch_u32(&data, i * 8 + 4), len as u32, "entry {i} len");
        }
        assert_eq!(&data[base0 - start..base0 - start + 3], b"one");
        assert_eq!(&data[base1 - start..base1 - start + 6], b"twotwo");
        assert_eq!(&data[base2 - start..base2 - start + 7], b"three!!");
    }

    #[test]
    fn record_iovec_array_readv_plans_copyback_per_subbuffer() {
        let bufs: [&[u8]; 3] = [&[0u8; 3], &[0u8; 6], &[0u8; 7]];
        let region = encode_iovec_region(SINGLE_SPAN_REGION_OFF, &bufs);
        let region_len = region.len() as u32;
        let mut data = build_single_span_record(
            wasm_posix_shared::Syscall::Readv as u16,
            [3, 0, 0, 0, 0, 0],
            SPAN_KIND_IOVEC_ARRAY,
            1,
            &region,
            region_len,
            REC_CAP,
        );
        let start = data.as_mut_ptr() as usize;
        let scratch = ChannelScratchRegion::new(start, REC_CAP).unwrap();

        let prep = match unsafe { prepare_channel_record(scratch) } {
            Some(Ok(prep)) => prep,
            other => panic!("expected prepared record, got {other:?}"),
        };
        assert_eq!(prep.args[1] as usize, start);
        assert_eq!(prep.args[2], 3);
        // readv scatters into every buffer, so each records a copy-back to its
        // original record offset.
        assert_eq!(prep.copy_back.len(), 3);

        // Original record offsets: after region struct (4 + 3*8 = 28 bytes).
        let buffers_base = SINGLE_SPAN_REGION_OFF + 28;
        let expected_dests = [buffers_base, buffers_base + 3, buffers_base + 3 + 6];
        let scratch_bases = [start + 24, (start + 24 + 3 + 3) & !3, {
            let b1 = (start + 24 + 3 + 3) & !3;
            (b1 + 6 + 3) & !3
        }];
        let lens = [3usize, 6, 7];
        for (i, cb) in prep.copy_back.iter().enumerate() {
            assert_eq!(cb.channel_dest, start + expected_dests[i], "copy-back {i} dest");
            assert_eq!(cb.scratch_src, scratch_bases[i], "copy-back {i} src");
            assert_eq!(cb.len, lens[i], "copy-back {i} len");
        }
    }

    #[test]
    fn record_msghdr_sendmsg_reconstructs_wire_and_rewrites_arg() {
        let iov: [&[u8]; 1] = [b"hello"];
        let (region, struct_len) =
            encode_msghdr_region(SINGLE_SPAN_REGION_OFF, b"addr", &iov, b"cm", 0x55);
        let mut data = build_single_span_record(
            wasm_posix_shared::Syscall::Sendmsg as u16,
            [9, 0, 0, 0, 0, 0], // fd, msg(overwritten), flags, ...
            SPAN_KIND_MSGHDR,
            1,
            &region,
            struct_len as u32,
            REC_CAP,
        );
        let start = data.as_mut_ptr() as usize;
        let scratch = ChannelScratchRegion::new(start, REC_CAP).unwrap();

        let prep = match unsafe { prepare_channel_record(scratch) } {
            Some(Ok(prep)) => prep,
            other => panic!("expected prepared record, got {other:?}"),
        };
        assert_eq!(prep.syscall_nr, wasm_posix_shared::Syscall::Sendmsg as u32);
        assert_eq!(prep.args[0], 9);
        // The msghdr pointer arg is rewritten to the KernelMsghdrWire base.
        assert_eq!(prep.args[1] as usize, start);
        // sendmsg only reads; no output copy-back.
        assert!(prep.copy_back.is_empty());

        // KernelMsghdrWire { name, name_len, iov, iov_len, control, control_len,
        // flags } laid at the allocation base; referenced blocks follow in the
        // validator's order: name, control, iov table, iov buffer.
        let name_addr = start + 28; // after the 28-byte wire
        let control_addr = (name_addr + 4 + 3) & !3; // align_up(name + 4, 4)
        let iov_table_addr = (control_addr + 2 + 3) & !3; // align_up(control + 2, 4)
        let iov_buf_addr = iov_table_addr + 8; // after the 1-entry table

        assert_eq!(read_scratch_u32(&data, 0), name_addr as u32, "name");
        assert_eq!(read_scratch_u32(&data, 4), 4, "name_len");
        assert_eq!(read_scratch_u32(&data, 8), iov_table_addr as u32, "iov");
        assert_eq!(read_scratch_u32(&data, 12), 1, "iov_len");
        assert_eq!(read_scratch_u32(&data, 16), control_addr as u32, "control");
        assert_eq!(read_scratch_u32(&data, 20), 2, "control_len");
        assert_eq!(read_scratch_u32(&data, 24), 0x55, "flags");

        assert_eq!(&data[name_addr - start..name_addr - start + 4], b"addr");
        assert_eq!(&data[control_addr - start..control_addr - start + 2], b"cm");
        // The single iovec entry points at the flattened data buffer.
        assert_eq!(
            read_scratch_u32(&data, iov_table_addr - start),
            iov_buf_addr as u32
        );
        assert_eq!(read_scratch_u32(&data, iov_table_addr - start + 4), 5);
        assert_eq!(&data[iov_buf_addr - start..iov_buf_addr - start + 5], b"hello");
    }

    #[test]
    fn record_msghdr_recvmsg_plans_output_and_value_result_copyback() {
        let iov: [&[u8]; 1] = [&[0u8; 5]];
        let (region, struct_len) =
            encode_msghdr_region(SINGLE_SPAN_REGION_OFF, &[0u8; 4], &iov, &[0u8; 2], 0);
        let mut data = build_single_span_record(
            wasm_posix_shared::Syscall::Recvmsg as u16,
            [9, 0, 0, 0, 0, 0],
            SPAN_KIND_MSGHDR,
            1,
            &region,
            struct_len as u32,
            REC_CAP,
        );
        let start = data.as_mut_ptr() as usize;
        let scratch = ChannelScratchRegion::new(start, REC_CAP).unwrap();

        let prep = match unsafe { prepare_channel_record(scratch) } {
            Some(Ok(prep)) => prep,
            other => panic!("expected prepared record, got {other:?}"),
        };
        assert_eq!(prep.args[1] as usize, start);

        // recvmsg output copy-backs: the name, control, and iov data buffers,
        // then the three value-result fields (name_len, control_len, flags)
        // reflected from the KernelMsghdrWire into the record msghdr region.
        assert_eq!(prep.copy_back.len(), 6);

        let name_addr = start + 28;
        let control_addr = (name_addr + 4 + 3) & !3;
        let iov_buf_addr = ((control_addr + 2 + 3) & !3) + 8;

        // Data-buffer copy-backs (name, control, iov) to their record offsets.
        let name_record_off = SINGLE_SPAN_REGION_OFF + struct_len; // ref bytes start
        let iov_record_off = name_record_off + 4;
        let control_record_off = iov_record_off + 5;
        assert_eq!(prep.copy_back[0].scratch_src, name_addr);
        assert_eq!(prep.copy_back[0].channel_dest, start + name_record_off);
        assert_eq!(prep.copy_back[0].len, 4);
        assert_eq!(prep.copy_back[1].scratch_src, control_addr);
        assert_eq!(prep.copy_back[1].channel_dest, start + control_record_off);
        assert_eq!(prep.copy_back[1].len, 2);
        assert_eq!(prep.copy_back[2].scratch_src, iov_buf_addr);
        assert_eq!(prep.copy_back[2].channel_dest, start + iov_record_off);
        assert_eq!(prep.copy_back[2].len, 5);

        // Value-result fields: name_len at record offset +4; control_len/flags
        // are the final two u32s of the 32-byte structural prefix.
        assert_eq!(prep.copy_back[3].scratch_src, start + 4); // wire name_len
        assert_eq!(
            prep.copy_back[3].channel_dest,
            start + SINGLE_SPAN_REGION_OFF + 4
        );
        assert_eq!(prep.copy_back[3].len, 4);
        assert_eq!(prep.copy_back[4].scratch_src, start + 20); // wire control_len
        assert_eq!(
            prep.copy_back[4].channel_dest,
            start + SINGLE_SPAN_REGION_OFF + struct_len - 8
        );
        assert_eq!(prep.copy_back[5].scratch_src, start + 24); // wire flags
        assert_eq!(
            prep.copy_back[5].channel_dest,
            start + SINGLE_SPAN_REGION_OFF + struct_len - 4
        );
    }

    #[test]
    fn record_msghdr_rejects_more_than_one_iovec_entry() {
        // The legacy canonical msghdr wire flattens to a single buffer; a record
        // that presents two iovec entries is a truthful EINVAL.
        let iov: [&[u8]; 2] = [b"a", b"b"];
        let (region, struct_len) =
            encode_msghdr_region(SINGLE_SPAN_REGION_OFF, b"", &iov, b"", 0);
        let mut data = build_single_span_record(
            wasm_posix_shared::Syscall::Sendmsg as u16,
            [9, 0, 0, 0, 0, 0],
            SPAN_KIND_MSGHDR,
            1,
            &region,
            struct_len as u32,
            REC_CAP,
        );
        let scratch =
            ChannelScratchRegion::new(data.as_mut_ptr() as usize, REC_CAP).unwrap();
        assert_eq!(
            unsafe { prepare_channel_record(scratch) },
            Some(Err(Errno::EINVAL))
        );
    }

    // -----------------------------------------------------------------------
    // Task 5 (Phase 2 opaque transport): guest C-encoder byte-layout golden.
    //
    // `__marshal_channel_record` (libc/glue/channel_syscall.c) writes the exact
    // bytes assembled below. That C encoder cannot run inside this native Rust
    // test (it reads the `__channel_base` wasm global and the caller's linear
    // memory), so we hand-encode the record byte-for-byte per the encoder's
    // documented layout and prove the runtime-core decoder +
    // `prepare_channel_record` consume it identically. This is the GOLDEN form
    // of Task 5's round-trip; the "the C encoder actually emits these bytes"
    // end-to-end assertion lands in Task 6, once the guest issues via the
    // record path.
    // -----------------------------------------------------------------------

    use crate::channel_record_decode::{decode, Nested};

    fn golden_header(syscall: u16, span_count: u16, scalars: [i64; 6]) -> alloc::vec::Vec<u8> {
        let mut h = alloc::vec::Vec::new();
        h.extend_from_slice(&RECORD_MAGIC.to_le_bytes());
        h.extend_from_slice(&RECORD_ABI.to_le_bytes());
        h.extend_from_slice(&syscall.to_le_bytes());
        h.extend_from_slice(&span_count.to_le_bytes());
        h.extend_from_slice(&0u16.to_le_bytes()); // flags
        h.extend_from_slice(&0u32.to_le_bytes()); // _reserved
        for s in scalars {
            h.extend_from_slice(&s.to_le_bytes());
        }
        assert_eq!(h.len(), RECORD_HEADER_BYTES);
        h
    }

    fn golden_descriptor(kind: u8, arg_index: u8, offset: u32, len: u32) -> alloc::vec::Vec<u8> {
        let mut d = alloc::vec::Vec::new();
        d.push(kind);
        d.push(arg_index);
        d.extend_from_slice(&0u16.to_le_bytes()); // _pad
        d.extend_from_slice(&offset.to_le_bytes());
        d.extend_from_slice(&len.to_le_bytes());
        assert_eq!(d.len(), SPAN_DESCRIPTOR_BYTES);
        d
    }

    /// Pad a record to `REC_CAP` for `prepare_channel_record` (which reads the
    /// whole live region and decodes with the full capacity).
    fn golden_region(record: &[u8]) -> alloc::vec::Vec<u8> {
        let mut data = record.to_vec();
        data.resize(REC_CAP, 0);
        data
    }

    #[test]
    fn golden_write_flat_in_ptr() {
        // write(fd=7, buf="hello", count=5): the C encoder emits one IN_PTR span
        // for arg 1 (buf), sized by arg 2 (count). Payload packs right after the
        // 64-byte header + single 12-byte descriptor at offset 76.
        let mut record = golden_header(wasm_posix_shared::Syscall::Write as u16, 1, [7, 0, 5, 0, 0, 0]);
        let desc_end = (RECORD_HEADER_BYTES + SPAN_DESCRIPTOR_BYTES) as u32;
        record.extend_from_slice(&golden_descriptor(SPAN_KIND_IN_PTR, 1, desc_end, 5));
        record.extend_from_slice(b"hello");
        assert_eq!(record.len(), 76 + 5);

        // Decoder view.
        let decoded = decode(&record, record.len()).expect("golden write decodes");
        assert_eq!(decoded.syscall, wasm_posix_shared::Syscall::Write as u16);
        assert_eq!(decoded.scalars, [7, 0, 5, 0, 0, 0]);
        assert_eq!(decoded.spans.len(), 1);
        assert_eq!(decoded.spans[0].kind, SPAN_KIND_IN_PTR);
        assert_eq!(decoded.spans[0].arg_index, 1);
        assert_eq!(decoded.spans[0].bytes, b"hello");

        // Kernel reconstruction view.
        let mut data = golden_region(&record);
        let start = data.as_mut_ptr() as usize;
        let region = ChannelScratchRegion::new(start, REC_CAP).unwrap();
        let prep = match unsafe { prepare_channel_record(region) } {
            Some(Ok(prep)) => prep,
            other => panic!("expected prepared record, got {other:?}"),
        };
        assert_eq!(prep.syscall_nr, wasm_posix_shared::Syscall::Write as u32);
        assert_eq!(prep.args[0], 7);
        assert_eq!(prep.args[1] as usize, start);
        assert_eq!(prep.args[2], 5);
        assert!(prep.copy_back.is_empty());
        assert_eq!(&data[0..5], b"hello");
    }

    #[test]
    fn golden_open_path_str() {
        // open("/tmp"): one PATH_STR span for arg 0, len = strlen + NUL = 5.
        let path = b"/tmp\0";
        let mut record = golden_header(wasm_posix_shared::Syscall::Open as u16, 1, [0, 0, 0, 0, 0, 0]);
        let desc_end = (RECORD_HEADER_BYTES + SPAN_DESCRIPTOR_BYTES) as u32;
        record.extend_from_slice(&golden_descriptor(
            wasm_posix_shared::channel_record::SPAN_KIND_PATH_STR,
            0,
            desc_end,
            path.len() as u32,
        ));
        record.extend_from_slice(path);

        let decoded = decode(&record, record.len()).expect("golden open decodes");
        assert_eq!(decoded.syscall, wasm_posix_shared::Syscall::Open as u16);
        assert_eq!(decoded.spans.len(), 1);
        assert_eq!(
            decoded.spans[0].kind,
            wasm_posix_shared::channel_record::SPAN_KIND_PATH_STR
        );
        assert_eq!(decoded.spans[0].arg_index, 0);
        assert_eq!(decoded.spans[0].bytes, path);

        let mut data = golden_region(&record);
        let start = data.as_mut_ptr() as usize;
        let region = ChannelScratchRegion::new(start, REC_CAP).unwrap();
        let prep = match unsafe { prepare_channel_record(region) } {
            Some(Ok(prep)) => prep,
            other => panic!("expected prepared record, got {other:?}"),
        };
        assert_eq!(prep.args[0] as usize, start);
        assert_eq!(&data[0..5], path);
        assert!(prep.copy_back.is_empty());
    }

    #[test]
    fn golden_writev_iovec_array() {
        // writev(fd=3, iov, iovcnt=2) with buffers ["ab", "cde"]. The C encoder
        // emits one IOVEC_ARRAY span at arg 1 whose region is
        //   [u32 count][2 * {u32 buf_off, u32 buf_len}][buffers...]
        // with absolute (record-relative) buffer offsets, len = whole region.
        let region_off = (RECORD_HEADER_BYTES + SPAN_DESCRIPTOR_BYTES) as u32; // 76
        let struct_len = 4u32 + 2 * 8; // count + 2 entries = 20
        let buffers_base = region_off + struct_len; // 96
        let buf0 = b"ab";
        let buf1 = b"cde";
        let off0 = buffers_base;
        let off1 = buffers_base + buf0.len() as u32;
        let region_len = struct_len + (buf0.len() + buf1.len()) as u32; // 25

        let mut iovec_region = alloc::vec::Vec::new();
        iovec_region.extend_from_slice(&2u32.to_le_bytes()); // count
        iovec_region.extend_from_slice(&off0.to_le_bytes());
        iovec_region.extend_from_slice(&(buf0.len() as u32).to_le_bytes());
        iovec_region.extend_from_slice(&off1.to_le_bytes());
        iovec_region.extend_from_slice(&(buf1.len() as u32).to_le_bytes());
        iovec_region.extend_from_slice(buf0);
        iovec_region.extend_from_slice(buf1);
        assert_eq!(iovec_region.len() as u32, region_len);

        let mut record = golden_header(wasm_posix_shared::Syscall::Writev as u16, 1, [3, 0, 2, 0, 0, 0]);
        record.extend_from_slice(&golden_descriptor(
            SPAN_KIND_IOVEC_ARRAY,
            1,
            region_off,
            region_len,
        ));
        record.extend_from_slice(&iovec_region);

        let decoded = decode(&record, record.len()).expect("golden writev decodes");
        assert_eq!(decoded.syscall, wasm_posix_shared::Syscall::Writev as u16);
        assert_eq!(decoded.spans.len(), 1);
        match &decoded.spans[0].nested {
            Some(Nested::Iovec(bufs)) => {
                assert_eq!(bufs.len(), 2);
                assert_eq!(bufs[0], b"ab");
                assert_eq!(bufs[1], b"cde");
            }
            other => panic!("expected iovec nested, got {other:?}"),
        }

        let mut data = golden_region(&record);
        let start = data.as_mut_ptr() as usize;
        let region = ChannelScratchRegion::new(start, REC_CAP).unwrap();
        let prep = match unsafe { prepare_channel_record(region) } {
            Some(Ok(prep)) => prep,
            other => panic!("expected prepared record, got {other:?}"),
        };
        assert_eq!(prep.syscall_nr, wasm_posix_shared::Syscall::Writev as u32);
        // iov pointer rewritten to the scratch table base; count word set.
        assert_eq!(prep.args[1] as usize, start);
        assert_eq!(prep.args[2], 2);
        // writev only reads the buffers -> no copy-back.
        assert!(prep.copy_back.is_empty());
    }

    // -----------------------------------------------------------------------
    // Task 5b (Phase 2 opaque transport): special-layout syscall families.
    //
    // The bespoke `validate_special_layout` families are NOT in the generated
    // descriptor header, so today they marshal scalar-only (their pointer args
    // are lost). These goldens hand-encode the record the guest self-marshaller
    // emits for one representative syscall per family and assert that
    // `prepare_channel_record` lays a scratch layout the UNCHANGED legacy
    // `validate_channel_scratch_arguments` / dispatch accept, including
    // copy-back for value-result buffers. fcntl-lock, prctl, epoll_ctl,
    // epoll_pwait/epoll_wait, msgsnd/msgrcv, msgctl/shmctl reuse the generic
    // flat-span placement (single/ordered spans at the allocation base);
    // select/pselect6 use the dedicated fixed-offset `prepare_select_record`.
    // -----------------------------------------------------------------------

    use wasm_posix_shared::channel_record::SPAN_KIND_IN_OUT_PTR;

    /// Build a flat-span record, run `prepare_channel_record`, and require it to
    /// decode into a prepared record (panics on the legacy/none path or errno).
    fn prep_record(syscall: u32, scalars: [i64; 6], spans: &[RecSpan]) -> (usize, PreparedChannelRecord, alloc::vec::Vec<u8>) {
        let mut data = build_record(syscall as u16, RECORD_ABI, scalars, spans, REC_CAP);
        let start = data.as_mut_ptr() as usize;
        let region = ChannelScratchRegion::new(start, REC_CAP).unwrap();
        let prep = match unsafe { prepare_channel_record(region) } {
            Some(Ok(prep)) => prep,
            other => panic!("expected prepared record, got {other:?}"),
        };
        (start, prep, data)
    }

    #[test]
    fn record_fcntl_getlk_flock_matches_legacy_validator() {
        // fcntl(fd=3, F_GETLK=5, flock): one INOUT flock span at arg 2. F_GETLK
        // returns the conflicting lock in place, so the guest marshals INOUT and
        // the kernel plans a copy-back (F_SETLK would be a plain IN span).
        const FLOCK: usize = kernel_scratch_wire::FCNTL_FLOCK_BYTES as usize;
        let mut flock = alloc::vec![0u8; FLOCK];
        flock[0] = 1; // F_WRLCK marker (content is opaque to the layout)
        let (start, prep, _data) = prep_record(
            Syscall::Fcntl as u32,
            [3, 5, 0, 0, 0, 0],
            &[RecSpan { kind: SPAN_KIND_IN_OUT_PTR, arg_index: 2, payload: flock }],
        );
        assert_eq!(prep.syscall_nr, Syscall::Fcntl as u32);
        assert_eq!(prep.args[2] as usize, start);
        // F_GETLK writes the conflicting lock back -> one copy-back.
        assert_eq!(prep.copy_back.len(), 1);
        let region = ChannelScratchRegion::new(start, REC_CAP).unwrap();
        let validated =
            unsafe { validate_channel_scratch_arguments(prep.syscall_nr, &prep.args, region) }
                .expect("legacy validator accepts the reconstructed fcntl layout");
        assert_eq!(validated.pointer(2), Ok(start));
    }

    #[test]
    fn record_prctl_set_name_matches_legacy_validator() {
        const NAME: usize = kernel_scratch_wire::PRCTL_NAME_BYTES as usize;
        let (start, prep, _data) = prep_record(
            extended_syscalls::SYS_PRCTL,
            [i64::from(prctl::PR_SET_NAME), 0, 0, 0, 0, 0],
            &[RecSpan { kind: SPAN_KIND_IN_OUT_PTR, arg_index: 1, payload: alloc::vec![b'x'; NAME] }],
        );
        assert_eq!(prep.args[1] as usize, start);
        let region = ChannelScratchRegion::new(start, REC_CAP).unwrap();
        let validated =
            unsafe { validate_channel_scratch_arguments(prep.syscall_nr, &prep.args, region) }
                .expect("legacy validator accepts the reconstructed prctl layout");
        assert_eq!(validated.pointer(1), Ok(start));
    }

    #[test]
    fn record_epoll_ctl_event_matches_legacy_validator() {
        let event = size_of::<WasmEpollEvent>();
        let (start, prep, _data) = prep_record(
            extended_syscalls::SYS_EPOLL_CTL,
            // epoll_ctl(epfd, op=EPOLL_CTL_ADD, fd, event)
            [4, 1, 7, 0, 0, 0],
            &[RecSpan { kind: SPAN_KIND_IN_PTR, arg_index: 3, payload: alloc::vec![0u8; event] }],
        );
        assert_eq!(prep.args[3] as usize, start);
        assert!(prep.copy_back.is_empty());
        let region = ChannelScratchRegion::new(start, REC_CAP).unwrap();
        let validated =
            unsafe { validate_channel_scratch_arguments(prep.syscall_nr, &prep.args, region) }
                .expect("legacy validator accepts the reconstructed epoll_ctl layout");
        assert_eq!(validated.pointer(3), Ok(start));
    }

    #[test]
    fn record_epoll_pwait_array_and_mask_match_legacy_validator() {
        // epoll_pwait(epfd, events, maxevents=3, timeout, sigmask, sigsetsize=8).
        let event = size_of::<WasmEpollEvent>();
        let maxevents = 3usize;
        let array_len = maxevents * event;
        let mask_len = kernel_scratch_wire::SIGNAL_MASK_BYTES as usize;
        let (start, prep, _data) = prep_record(
            extended_syscalls::SYS_EPOLL_PWAIT,
            [4, 0, maxevents as i64, 0, 0, mask_len as i64],
            &[
                RecSpan { kind: SPAN_KIND_OUT_PTR, arg_index: 1, payload: alloc::vec![0u8; array_len] },
                RecSpan { kind: SPAN_KIND_IN_PTR, arg_index: 4, payload: alloc::vec![0u8; mask_len] },
            ],
        );
        // Event array at the base; sigmask at align_up(base + array_len, 8),
        // exactly where `validate_special_layout` recomputes it.
        assert_eq!(prep.args[1] as usize, start);
        let expected_mask = (start + array_len + 7) & !7usize;
        assert_eq!(prep.args[4] as usize, expected_mask);
        // Only the OUT event array copies back.
        assert_eq!(prep.copy_back.len(), 1);
        assert_eq!(prep.copy_back[0].scratch_src, start);
        assert_eq!(prep.copy_back[0].len, array_len);
        let region = ChannelScratchRegion::new(start, REC_CAP).unwrap();
        let validated =
            unsafe { validate_channel_scratch_arguments(prep.syscall_nr, &prep.args, region) }
                .expect("legacy validator accepts the reconstructed epoll_pwait layout");
        assert_eq!(validated.pointer(1), Ok(start));
        assert_eq!(validated.pointer(4), Ok(expected_mask));
    }

    #[test]
    fn record_epoll_wait_array_only_matches_legacy_validator() {
        let event = size_of::<WasmEpollEvent>();
        let maxevents = 2usize;
        let (start, prep, _data) = prep_record(
            extended_syscalls::SYS_EPOLL_WAIT,
            [4, 0, maxevents as i64, 0, 0, 0],
            &[RecSpan { kind: SPAN_KIND_OUT_PTR, arg_index: 1, payload: alloc::vec![0u8; maxevents * event] }],
        );
        assert_eq!(prep.args[1] as usize, start);
        assert_eq!(prep.copy_back.len(), 1);
        let region = ChannelScratchRegion::new(start, REC_CAP).unwrap();
        let validated =
            unsafe { validate_channel_scratch_arguments(prep.syscall_nr, &prep.args, region) }
                .expect("legacy validator accepts the reconstructed epoll_wait layout");
        assert_eq!(validated.pointer(1), Ok(start));
    }

    #[test]
    fn record_msgsnd_wire_matches_legacy_validator() {
        // msgsnd(qid, msgp, msgsz, flags): one IN span at arg 1 whose payload is
        // the width-independent wire { i64 mtype; msgsz payload bytes }.
        let msgsz = 12usize;
        let wire_len = size_of::<WasmSysvMessageHeader>() + msgsz;
        let mut wire = alloc::vec![0u8; wire_len];
        wire[0..8].copy_from_slice(&7i64.to_le_bytes()); // mtype
        let (start, prep, _data) = prep_record(
            extended_syscalls::SYS_MSGSND,
            [9, 0, msgsz as i64, 0, 0, 4], // qid, msgp(overwritten), msgsz, flags, _, width=4
            &[RecSpan { kind: SPAN_KIND_IN_PTR, arg_index: 1, payload: wire }],
        );
        assert_eq!(prep.args[1] as usize, start);
        assert!(prep.copy_back.is_empty());
        let region = ChannelScratchRegion::new(start, REC_CAP).unwrap();
        let validated =
            unsafe { validate_channel_scratch_arguments(prep.syscall_nr, &prep.args, region) }
                .expect("legacy validator accepts the reconstructed msgsnd layout");
        assert_eq!(validated.pointer(1), Ok(start));
    }

    #[test]
    fn record_msgrcv_wire_plans_copyback() {
        // msgrcv reserves { i64 mtype; msgsz payload } as an OUT buffer.
        let msgsz = 16usize;
        let wire_len = size_of::<WasmSysvMessageHeader>() + msgsz;
        let (start, prep, _data) = prep_record(
            extended_syscalls::SYS_MSGRCV,
            [9, 0, msgsz as i64, 0, 0, 4],
            &[RecSpan { kind: SPAN_KIND_OUT_PTR, arg_index: 1, payload: alloc::vec![0u8; wire_len] }],
        );
        assert_eq!(prep.args[1] as usize, start);
        assert_eq!(prep.copy_back.len(), 1);
        assert_eq!(prep.copy_back[0].scratch_src, start);
        assert_eq!(prep.copy_back[0].len, wire_len);
        let region = ChannelScratchRegion::new(start, REC_CAP).unwrap();
        let validated =
            unsafe { validate_channel_scratch_arguments(prep.syscall_nr, &prep.args, region) }
                .expect("legacy validator accepts the reconstructed msgrcv layout");
        assert_eq!(validated.pointer(1), Ok(start));
    }

    #[test]
    fn record_msgctl_stat_matches_legacy_validator() {
        // msgctl(qid, IPC_STAT=2, buf): buf sized by msqid_ds width.
        let size = crate::ipc_wire::msqid_ds_size(4).unwrap();
        let (start, prep, _data) = prep_record(
            extended_syscalls::SYS_MSGCTL,
            [9, 2, 0, 0, 0, 4],
            &[RecSpan { kind: SPAN_KIND_OUT_PTR, arg_index: 2, payload: alloc::vec![0u8; size] }],
        );
        assert_eq!(prep.args[2] as usize, start);
        assert_eq!(prep.copy_back.len(), 1);
        let region = ChannelScratchRegion::new(start, REC_CAP).unwrap();
        let validated =
            unsafe { validate_channel_scratch_arguments(prep.syscall_nr, &prep.args, region) }
                .expect("legacy validator accepts the reconstructed msgctl layout");
        assert_eq!(validated.pointer(2), Ok(start));
    }

    #[test]
    fn record_shmctl_stat_matches_legacy_validator() {
        let size = crate::ipc_wire::shmid_ds_size(4).unwrap();
        let (start, prep, _data) = prep_record(
            extended_syscalls::SYS_SHMCTL,
            [9, 2, 0, 0, 0, 4],
            &[RecSpan { kind: SPAN_KIND_OUT_PTR, arg_index: 2, payload: alloc::vec![0u8; size] }],
        );
        assert_eq!(prep.args[2] as usize, start);
        assert_eq!(prep.copy_back.len(), 1);
        let region = ChannelScratchRegion::new(start, REC_CAP).unwrap();
        let validated =
            unsafe { validate_channel_scratch_arguments(prep.syscall_nr, &prep.args, region) }
                .expect("legacy validator accepts the reconstructed shmctl layout");
        assert_eq!(validated.pointer(2), Ok(start));
    }

    #[test]
    fn record_select_places_fdsets_at_fixed_disjoint_slots() {
        // select with readfds NULL, writefds + exceptfds present exercises the
        // fixed-offset placement: a leading null must NOT shift the later slots.
        let fd = wasm_posix_shared::select::FD_SET_BYTES;
        let (start, prep, _data) = prep_record(
            Syscall::Select as u32,
            [16, 0, 0, 0, 0, 0], // nfds, read/write/except(overwritten), timeout, _
            &[
                RecSpan { kind: SPAN_KIND_IN_OUT_PTR, arg_index: 2, payload: alloc::vec![0u8; fd] },
                RecSpan { kind: SPAN_KIND_IN_OUT_PTR, arg_index: 3, payload: alloc::vec![0u8; fd] },
            ],
        );
        // readfds stays null; writefds at base+FD_SET_BYTES; exceptfds at
        // base+2*FD_SET_BYTES -- the offsets the validator re-proves.
        assert_eq!(prep.args[1], 0);
        assert_eq!(prep.args[2] as usize, start + fd);
        assert_eq!(prep.args[3] as usize, start + 2 * fd);
        // Both present fd_sets are value-result -> two copy-backs.
        assert_eq!(prep.copy_back.len(), 2);
        let region = ChannelScratchRegion::new(start, REC_CAP).unwrap();
        let validated =
            unsafe { validate_channel_scratch_arguments(prep.syscall_nr, &prep.args, region) }
                .expect("legacy validator accepts the reconstructed select layout");
        assert_eq!(validated.pointer(1), Ok(0));
        assert_eq!(validated.pointer(2), Ok(start + fd));
        assert_eq!(validated.pointer(3), Ok(start + 2 * fd));
    }

    #[test]
    fn record_pselect6_places_fdsets_and_mask_at_fixed_slots() {
        let fd = wasm_posix_shared::select::FD_SET_BYTES;
        let mask = kernel_scratch_wire::SIGNAL_MASK_BYTES as usize;
        let (start, prep, _data) = prep_record(
            extended_syscalls::SYS_PSELECT6,
            [16, 0, 0, 0, 0, 0],
            &[
                RecSpan { kind: SPAN_KIND_IN_OUT_PTR, arg_index: 1, payload: alloc::vec![0u8; fd] },
                RecSpan { kind: SPAN_KIND_IN_OUT_PTR, arg_index: 3, payload: alloc::vec![0u8; fd] },
                RecSpan { kind: SPAN_KIND_IN_PTR, arg_index: 5, payload: alloc::vec![0u8; mask] },
            ],
        );
        assert_eq!(prep.args[1] as usize, start);
        assert_eq!(prep.args[2], 0); // writefds null
        assert_eq!(prep.args[3] as usize, start + 2 * fd);
        assert_eq!(prep.args[5] as usize, start + 3 * fd); // sigmask after 3 slots
        // Two value-result fd_sets copy back; the input-only sigmask does not.
        assert_eq!(prep.copy_back.len(), 2);
        let region = ChannelScratchRegion::new(start, REC_CAP).unwrap();
        let validated =
            unsafe { validate_channel_scratch_arguments(prep.syscall_nr, &prep.args, region) }
                .expect("legacy validator accepts the reconstructed pselect6 layout");
        assert_eq!(validated.pointer(1), Ok(start));
        assert_eq!(validated.pointer(3), Ok(start + 2 * fd));
        assert_eq!(validated.pointer(5), Ok(start + 3 * fd));
    }

    // -----------------------------------------------------------------------
    // Task 5c (Phase 2 opaque transport): the final three guest-side gaps.
    //
    // One representative golden per gap the C encoder now covers: ioctl
    // request-sized buffers, select's timeout-as-scalar conversion, and semctl
    // GETALL/SETALL. Each hand-encodes the record the guest self-marshaller
    // emits and asserts `prepare_channel_record` produces a scratch layout the
    // UNCHANGED validators / dispatch accept, with copy-back for OUT buffers.
    // -----------------------------------------------------------------------

    #[test]
    fn record_ioctl_tiocgwinsz_matches_legacy_validator() {
        // ioctl(fd=3, TIOCGWINSZ, winsize): the guest sizes arg 2 from the
        // ioctl contract (Out, 8 bytes) and sets arg 3 = size, arg 5 = pointer
        // width -- exactly what the unchanged `validate_ioctl_layout` re-proves.
        let request = wasm_posix_shared::ioctl_contract::TIOCGWINSZ as i64;
        let size = 8usize;
        let (start, prep, _data) = prep_record(
            Syscall::Ioctl as u32,
            // fd, request, arg2(overwritten), size, _, pointer_width
            [3, request, 0, size as i64, 0, 4],
            &[RecSpan {
                kind: SPAN_KIND_OUT_PTR,
                arg_index: 2,
                payload: alloc::vec![0u8; size],
            }],
        );
        assert_eq!(prep.syscall_nr, Syscall::Ioctl as u32);
        // The winsize buffer is rewritten to the allocation base.
        assert_eq!(prep.args[2] as usize, start);
        assert_eq!(prep.args[3], size as i64);
        assert_eq!(prep.args[5], 4);
        // TIOCGWINSZ writes the window size back -> one OUT copy-back.
        assert_eq!(prep.copy_back.len(), 1);
        assert_eq!(prep.copy_back[0].scratch_src, start);
        assert_eq!(prep.copy_back[0].len, size);
        let region = ChannelScratchRegion::new(start, REC_CAP).unwrap();
        let validated =
            unsafe { validate_channel_scratch_arguments(prep.syscall_nr, &prep.args, region) }
                .expect("legacy validator accepts the reconstructed ioctl layout");
        assert_eq!(validated.pointer(2), Ok(start));
    }

    #[test]
    fn record_select_carries_timeout_scalar_and_places_fdset() {
        // select(nfds, readfds, NULL, NULL, &tv): the guest converts the timeval
        // to a millisecond scalar in word 4 and emits an INOUT fd_set span. The
        // kernel `prepare_select_record` places the fd_set and carries the
        // timeout scalar through unchanged (kernel_select reads it from a5).
        let fd = wasm_posix_shared::select::FD_SET_BYTES;
        let timeout_ms = 250i64;
        let (start, prep, _data) = prep_record(
            Syscall::Select as u32,
            // nfds, read(overwritten), write, except, timeout_ms, _
            [8, 0, 0, 0, timeout_ms, 0],
            &[RecSpan {
                kind: SPAN_KIND_IN_OUT_PTR,
                arg_index: 1,
                payload: alloc::vec![0u8; fd],
            }],
        );
        assert_eq!(prep.syscall_nr, Syscall::Select as u32);
        assert_eq!(prep.args[0], 8);
        assert_eq!(prep.args[1] as usize, start); // readfds at the base slot
        assert_eq!(prep.args[2], 0); // writefds null
        assert_eq!(prep.args[3], 0); // exceptfds null
        // The computed timeout millisecond scalar survives reconstruction.
        assert_eq!(prep.args[4], timeout_ms);
        // The value-result fd_set copies back.
        assert_eq!(prep.copy_back.len(), 1);
        assert_eq!(prep.copy_back[0].scratch_src, start);
        assert_eq!(prep.copy_back[0].len, fd);
        let region = ChannelScratchRegion::new(start, REC_CAP).unwrap();
        let validated =
            unsafe { validate_channel_scratch_arguments(prep.syscall_nr, &prep.args, region) }
                .expect("legacy validator accepts the reconstructed select layout");
        assert_eq!(validated.pointer(1), Ok(start));
    }

    #[test]
    fn record_semctl_getall_lays_output_buffer_at_base() {
        // semctl(semid, 0, GETALL, arg): the guest sizes the u16[] array via a
        // preliminary IPC_STAT (nsems), then emits an OUT span at arg 3. The
        // kernel semctl dispatch proves this buffer INLINE via
        // `checked_channel_scratch_start_range` (arg 3 must equal the region
        // base), not through a pre-dispatch special validator, so the golden
        // asserts the base placement and the OUT copy-back directly.
        const GETALL: i64 = 13;
        let nsems = 3usize;
        let bytes = nsems * core::mem::size_of::<u16>();
        let (start, prep, _data) = prep_record(
            extended_syscalls::SYS_SEMCTL,
            // semid, semnum, cmd=GETALL, arg(overwritten), _, _
            [9, 0, GETALL, 0, 0, 0],
            &[RecSpan {
                kind: SPAN_KIND_OUT_PTR,
                arg_index: 3,
                payload: alloc::vec![0u8; bytes],
            }],
        );
        assert_eq!(prep.syscall_nr, extended_syscalls::SYS_SEMCTL);
        assert_eq!(prep.args[2], GETALL);
        // The array buffer is rewritten to the allocation base, which the kernel
        // dispatch's `checked_channel_scratch_start_range(args[3], ...)` requires.
        assert_eq!(prep.args[3] as usize, start);
        // GETALL writes the semaphore values back -> one OUT copy-back to the
        // record's original span offset.
        assert_eq!(prep.copy_back.len(), 1);
        assert_eq!(prep.copy_back[0].scratch_src, start);
        assert_eq!(prep.copy_back[0].len, bytes);
        assert_eq!(
            prep.copy_back[0].channel_dest,
            start + RECORD_HEADER_BYTES + SPAN_DESCRIPTOR_BYTES
        );
    }
}
