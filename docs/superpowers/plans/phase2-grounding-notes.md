# Phase 2 Transport — Grounding Notes (Task 0)

Confirmed against `/Users/brandon/kandelo-phase1` (runtime-core split applied).
Feeds the plan `2026-08-26-rust-first-phase2-opaque-transport.md`.

## Channel layout (`crates/shared/src/lib.rs`, `pub mod channel` @ :1238)

| Const | line | value |
|---|---|---|
| STATUS_OFFSET (u32 atomic) | 1243 | 0 |
| SYSCALL_OFFSET (u32) | 1246 | 4 |
| ARGS_OFFSET | 1249 | 8 |
| ARGS_COUNT / ARG_SIZE | 1251/1253 | 6 / 8 |
| RETURN_OFFSET (i64) | 1255 | 56 |
| ERRNO_OFFSET (u32) | 1258 | 64 |
| REQUEST_FLAGS_OFFSET (u32) | 1261 | 68 |
| HEADER_SIZE = DATA_OFFSET | 1282/1284 | 72 |
| DATA_SIZE | 1286 | 65536 |
| MIN_CHANNEL_SIZE | 1288 | 65608 |
| SIG_BASE (signal tail) | 1301 | DATA_OFFSET+DATA_SIZE-SIG_AREA_SIZE |

`SIG_AREA_SIZE = 56` (from `kernel_scratch_wire::SIGNAL_DELIVERY_BYTES`, lib.rs:1592).
**Record inline budget = DATA_SIZE − SIG_AREA_SIZE = 65480 bytes**; larger →
scratch. Request-flag bits + `REQUEST_FLAGS_KNOWN_MASK` @ 1265–1280 (unchanged).
`ABI_VERSION: u32 = 43` @ **:114**. `platform_limits` @ :128 (PATH_MAX_BYTES=4096,
IOV_MAX=1024).

## Host marshalling to be removed

- `crates/shared/src/host_abi.rs`: `SyscallArgDesc` struct @ :77–93; `SyscallArgSize`
  variants @ :33–52 (`CString`, `Arg{arg_index,multiplier,add}`, `Deref{arg_index}`,
  `Fixed`, `ProcessLayout`); `SyscallArgCopyOutLength` @ :62; table
  `SYSCALL_ARG_DESCRIPTORS: &[SyscallArgDescriptor]` @ :228, **123 entries**, sorted.
  Generated TS mirror = **`SYSCALL_ARGS`** @ `host/src/generated/abi.ts:1639`.
- `crates/shared/src/channel_scalar.rs`: `ChannelScalarKind` @ :13; table `SYSCALLS`
  @ :299, **63 entries**; fail-closed typed readers. Host mirror
  `normalizeChannelScalarArguments` @ `host/src/channel-scalar-contract.ts:103`,
  called from `kernel-worker.ts:11352`.
- `host/src/kernel-worker.ts` `#handleSyscallInner` @ **:11319–13545**: Tier A
  intercepted ladder @ :11485–11739; Tier B descriptor path; copy-in planning
  @ :11983–12543; actual scratch copy in the `stage` closure @ :5831–5848;
  copy-out in `finish` @ :5883–6037; `kernel_handle_channel` call @ :20290.
- `crates/runtime-core/src/channel_scratch.rs`: `validate_descriptor_layout` @ :246,
  `validate_special_layout` @ :576, `validate_channel_scratch_arguments` @ :693 —
  the record decoder REPLACES these as the source of validated spans; the
  `ChannelScratchRegion`/`checked_range` bounds contract is REUSED unchanged.

## Guest glue (`libc/glue/channel_syscall.c`)

`__do_syscall_impl(n,a1..a6,cancellation_point,extra_flags)` @ :756; wrappers
`__syscall0..6` @ :1008–1042, `__syscall_cp` @ :1073. **Pointer args are passed
RAW today** (host copies from guest memory); arg write @ :852–858; handshake
(atomic store CH_PENDING + notify, wait32 loop) @ :881–911; return/errno readback
@ :914–920; pending-signal delivery reads CH_SIG_* tail @ :595,:949. `fork/vfork`
use the `kernel_fork` import (:478); `SYS_EXIT` uses `kernel_exit` (:783). This is
what switches to self-marshalling a record into the data buffer.

## The seam (decoder insertion point)

`kernel_handle_channel(scratch_ptr, capacity, pid, retry_token) -> i32` @
`crates/kernel/src/wasm_api.rs:3193` → **`handle_owned_channel_allocation` @ :3049**
— the SINGLE funnel also reached by `kernel_transfer_channel_execute` @ :6879.
Today it assumes the host already copied the whole channel into kernel memory at
`scratch_ptr` with pointer args rewritten to absolute scratch addresses (:3123–3128),
reads SYSCALL + 6 args (:3091–3121), builds `ChannelScratchRegion` (:3072), dispatches
via `dispatch_channel_syscall` @ :3392 / `dispatch_channel_wide_result`, writes
RETURN/ERRNO back (:3181). **The decoder slots in here**, producing the same
validated span evidence `validate_channel_scratch_arguments` yields today.

**Exports:** the ~200 per-syscall `kernel_*` handlers are **internal** (reached only
via `dispatch_channel_syscall`), NOT host-called. Host-called set =
`HOST_ADAPTER_REQUIRED_KERNEL_EXPORTS` (lib.rs:2971–3052, ~78) + optional
(:3054–3059). **So Phase 2 removes host-side TS descriptor logic + the descriptor
tables/validators, NOT any manifest export.** (Corrects plan Task 7.)

## Scratch (the `SpanKind::Scratch` target)

`crates/runtime-core/src/transfer.rs`: `TransferScratchState` @ :63 (positive-i64
token). Exports (wasm_api.rs): `kernel_transfer_scratch_begin` @ :1287, `_pointer`
:1296, `_capacity` :1303, `_cancel` :1309; execute `kernel_transfer_channel_execute`
@ :6879 (routes a full kernel-owned Vec into `handle_owned_channel_allocation` @
:6899 — the opaque model already exists for oversize). `SpanKind::Scratch` resolves
via this token API to a bounded range, exactly like `ChannelScratchRegion`.

## ABI plumbing

`scripts/check-abi-version.sh` builds kernel wasm first, then `xtask dump-abi`
(`tools/xtask/src/dump_abi.rs:49`). `update` rewrites, `check` fails on drift +
classifies compat if snapshot changed without an `ABI_VERSION` bump. **A bump
regenerates 9 files:** `abi/snapshot.json`, `libc/glue/abi_constants.h`,
`libc/musl-overlay/include/bits/{kandelo_limits.h,kandelo_process_layouts.h,
kandelo_channel_scalars.h,kandelo_thread_syscalls.h}`,
`libc/musl-overlay/src/process/wasm32posix/spawn_contract.h`,
`libc/musl-overlay/include/sys/soundcard.h`, `host/src/generated/abi.ts`. Enforced
via `scripts/dev-shell.sh bash scripts/check-abi-version.sh`.

## Tests & fuzzing

- Runtime-core (no Wasm, decoder's home): `channel_scratch.rs` tests @ :747,
  `transfer.rs` @ :383, `scratch_alloc.rs`, `complete_copy.rs`, `channel_result.rs`.
- Host vitest: `channel-scalar-contract.test.ts`, `kernel-scratch-*.test.ts`,
  `kernel-large-transfer-protocol.test.ts`, `kernel-worker-copyback.test.ts`, the
  `kernel-*-entry.test.ts` set; harness `host/test/support/kernel-scratch-instance.ts`
  (builds a Wasm module w/ configurable pointer width, drives `kernel_handle_channel`
  without a guest binary → round-trip home).
- Conformance: `tests/libc`, `tests/posix`, `tests/sortix`; runners
  `scripts/run-{libc,posix,sortix}-tests.sh`, aggregated by `ci-run-test-suite.sh`.
- **Fuzz convention:** cargo-fuzz + libfuzzer + `arbitrary` exists ONLY at
  `crates/fork-instrument/fuzz/` — copy that template for
  `crates/runtime-core/fuzz/` (decode target). No proptest/quickcheck in-tree.

## ⚠ Design gap the flip must close first — SpanKind coverage

The 6 proposed `SpanKind`s (InPtr/OutPtr/InOutPtr/PathStr/IovecArray/Scratch) cover
the 123 descriptor entries but NOT the bespoke `validate_special_layout` families
(channel_scratch.rs:576). Before the atomic flip, the record format must also
express: **ioctl** (request-sized), **msghdr** (sendmsg/recvmsg — nested iovec +
control), **select/pselect6** (fd_sets + optional timeout/mask), **epoll_ctl/
epoll_pwait** (event struct / event array + sigmask), **msgsnd/msgrcv** (SysV
header + payload), **msgctl/shmctl/semctl** (command-dependent IPC control buffers),
**prctl** (PR_SET_NAME/GET_NAME string), **fcntl** (flock struct for lock cmds).
Options: fixed-length InPtr/OutPtr mappings where the shape is static, or dedicated
SpanKinds (`IovecArray` already helps writev/readv/preadv/pwritev). Resolve as an
explicit sub-task of plan Task 1 before Task 6.
