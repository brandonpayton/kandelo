/**
 * Kernel worker entry points.
 *
 * Programs compiled with channel_syscall.c run in Worker threads.
 * All syscalls go through a shared-memory channel to the
 * CentralizedKernelWorker on the main thread.
 */
import {
  EXEC_RETIRE_SIGNAL_CODE,
  type CentralizedWorkerInitMessage,
  type CentralizedThreadInitMessage,
  type WorkerToHostMessage,
} from "./worker-protocol";
import { BorrowedVforkWorkspace } from "./vfork-workspace";
import {
  createCppExceptionTag,
  createLongjmpTag,
  DynamicLinker,
  FORK_CAP_DYLINK_MAIN,
  forkInstrumentRoleAvailable,
  readForkInstrumentCapabilityClaim,
  requireCppExceptionTag,
  requireLongjmpTag,
  type DylinkForkActivationOwner,
  type DylinkForkState,
  type LoadedSharedLibrary,
} from "./dylink";
import {
  DylinkForkArchive,
  DylinkForkTableReplica,
  type DylinkForkArchiveSnapshot,
} from "./dylink-fork-archive";
import {
  describeWasmArtifactPolicyFailures,
  extractAbiVersion,
  readWasmFunctionArity,
  readWasmImportDescriptors,
  WASM_PAGE_SIZE,
} from "./constants";
import {
  ABI_SYSCALLS,
  CHANNEL_STATUS_IDLE,
  CHANNEL_STATUS_PENDING,
  CH_ARG_SIZE,
  CH_ARGS,
  CH_DATA,
  CH_ERRNO,
  CH_REQUEST_FLAGS,
  CH_REQUEST_FLAG_DEFER_SIGNAL_DELIVERY,
  CH_RETURN,
  CH_SIG_SI_CODE,
  CH_SIG_SIGNUM,
  CH_STATUS,
  CH_SYSCALL,
  CH_TOTAL_SIZE,
  HOST_INTERCEPTED_SYSCALLS,
  POSIX_ARG_MAX_BYTES,
  PROCESS_FORK_MODE_FORK,
  PROCESS_FORK_MODE_VFORK,
  PROCESS_METADATA_ENTRY_MAX_BYTES,
  PROCESS_STARTUP_MAX_ARGV_COUNT,
  PROCESS_STARTUP_MAX_ENVP_COUNT,
  WPK_FORK_EXPORT_MODULE_THREAD_BOOTSTRAP,
  WPK_FORK_EXPORT_MODULE_STATE_RESTORE,
  WPK_FORK_EXPORT_MODULE_STATE_FINISH_RESTORE,
  WPK_FORK_EXCEPTION_EXPORT_MATERIALIZE,
  WPK_FORK_GC_CODEC_SECTION,
  WPK_FORK_REFERENCE_EXPORT_GC_ALLOCATE,
  WPK_FORK_REFERENCE_EXPORT_GC_FILL,
  WPK_FORK_MODULE_STATE_IMPORT_RECORD_COMMIT,
  WPK_FORK_MODULE_STATE_IMPORT_RECORD_FIND,
  WPK_FORK_MODULE_STATE_IMPORT_RECORD_RESERVE,
  WPK_FORK_REQUIRED_EXPORTS,
  WPK_FORK_REQUIRED_IMPORTS,
  WPK_FORK_CAP_ACTIVATION_STATE_SAFE,
  type ProcessForkMode,
} from "./generated/abi";
import {
  FORK_SAVE_BUFFER_SIZE,
  FORK_SAVE_CONTROL_PREFIX_SIZE,
} from "./process-memory";
import {
  ContinuationAllocationError,
  readLinkedFrameFormat,
  writeForkContinuationAnchor,
} from "./fork-continuation";
import {
  createForkUnwindTag,
  FORK_UNWIND_TAG_IMPORT_MODULE,
  FORK_UNWIND_TAG_IMPORT_NAME,
  isForkUnwindException,
  requireForkUnwindTag,
} from "./fork-unwind-transport";
import { waitForForkReplayCommit } from "./fork-replay-gate";
import {
  type ForkModuleExports,
  type ForkModuleInstance,
  instantiateForkModule,
} from "./fork-module-instance";
import { ForkReferenceCaptureModule } from "./fork-reference-capture-module";
import { ForkModuleTrampolines } from "./fork-module-trampoline";
import {
  FORK_MODULE_RESUME_CATALOG_CAP,
  ForkModuleContinuationBackend,
} from "./fork-module-backend";
import { ForkTableSnapshot } from "./fork-table-snapshot";
import {
  type ForkModuleHostCapabilities,
  createForkModuleHostCapabilities,
} from "./fork-module-host-capabilities";
import {
  computeForkModuleTemplateId,
  computeForkModuleTemplateIdSync,
  ForkModuleStateArena,
  readForkModuleStateDescriptor,
  readForkModuleStateRoot,
} from "./fork-module-state";
import {
  buildForkActivationStateImports,
  ForkActivationRegistry,
  forkActivationRegistrationFromInstance,
  type ForkActivationTableReplication,
  type ForkActivationReferenceReplayImports,
  type ForkActivationRegistration,
} from "./fork-activation-registry";
import { ForkAnyrefTransitTable } from "./fork-anyref-transit";
import {
  buildForkExceptionImports,
  ForkExceptionBroker,
  forkExceptionProviderFromInstance,
  readForkExceptionCodecDescriptor,
  type ForkExceptionReferenceReplayImports,
  type ForkExceptionProvider,
} from "./fork-exception-provider";
import {
  assertForkModuleExnrefTagsDeclared,
  type ForkExnrefNode,
} from "./fork-module-exnref-admission";
import { ForkEarlyChildReferenceProvider } from "./fork-early-reference-provider";
import {
  decodeSegmentedForkReferenceTransaction,
  type DecodedSegmentedForkReferenceTransaction,
} from "./fork-reference-segments";
import { FORK_REFERENCE_TRANSACTION_OWNER_ID } from "./fork-reference-wire";
import {
  forkGcCodecProviderFromInstance,
  readForkGcCodecDescriptor,
  type ForkGcCodecProvider,
} from "./fork-gc-codec";
import {
  type ForkActivationContinuation,
  ForkProcessContinuationCoordinator,
  type ForkBorrowedReplayWorkspaceRequirements,
} from "./fork-process-continuation";
import {
  forkResumeTargetsFromInstance,
  readForkResumeCatalog,
} from "./fork-resume-catalog";
import {
  ForkExternrefTokenCache,
  ForkExternrefTokenRecipeProvider,
} from "./fork-reference-broker";
import { ForkHostImportWorkerRuntime } from "./fork-host-import-runtime";
import {
  ForkImportedGlobalCapture,
  ForkImportedGlobalPlanner,
  type ForkWasmImports,
  type PreparedForkParentActivation,
} from "./fork-imported-globals";
import {
  checkedWasmGuestPointerOffset,
  type WasmGuestPointer,
} from "./wasm-guest-pointer";
// WASI detection helpers are tiny and live in their own file so we can
// import them eagerly without dragging in the 1300-line WasiShim class.
// The shim itself is dynamically imported below, only when a worker
// actually needs to host a wasi_snapshot_preview1 module — which our
// native channel-syscall binaries (mariadbd, dinit, dash, coreutils,
// everything compiled by wasm32-posix) never trigger.
import { isWasiModule, wasiModuleDefinesMemory } from "./wasi-detect";
import { synchronizeReceivedSharedWasmMemory } from "./shared-wasm-memory-growth";
import {
  registerWasmModuleReflection,
  wasmModuleExports,
  wasmModuleImports,
} from "./wasm-module-reflection";
export interface MessagePort {
  postMessage(msg: unknown, transferList?: unknown[]): void;
  on(event: string, handler: (...args: unknown[]) => void): void;
}

function alignUp(value: number, align: number): number {
  return Math.ceil(value / align) * align;
}

const SYS_MMAP_NR = ABI_SYSCALLS.Mmap;
const PROT_READ_WRITE = 3;
const MAP_PRIVATE_ANONYMOUS = 0x22;
const SIGKILL = 9;

class ExecRetirement extends Error {}

/** @internal Exported so cross-engine exit-trap recognition is tested. */
export function isWasmUnreachableTrap(error: unknown): boolean {
  // WHY: WebKit describes the same Wasm `unreachable` trap as
  // "Unreachable code should not be executed" while V8 uses lowercase
  // "unreachable". The RuntimeError guard keeps an ordinary JavaScript Error
  // containing that word from masquerading as a committed guest exit.
  return error instanceof WebAssembly.RuntimeError
    && /\bunreachable\b/i.test(error.message);
}

/** @internal Exported so ABI-generated retirement-marker decoding is tested. */
export function isExecRetirementMarker(
  view: DataView,
  channelOffset: number,
): boolean {
  return view.getUint32(channelOffset + CH_SIG_SIGNUM, true) === SIGKILL
    && view.getUint32(channelOffset + CH_SIG_SI_CODE, true)
      === EXEC_RETIRE_SIGNAL_CODE;
}

function markDeferredSignalDelivery(
  view: DataView,
  channelOffset: number,
): void {
  view.setUint32(
    channelOffset + CH_REQUEST_FLAGS,
    CH_REQUEST_FLAG_DEFER_SIGNAL_DELIVERY,
    true,
  );
}

function clearDeferredSignalDelivery(
  view: DataView,
  channelOffset: number,
): void {
  view.setUint32(channelOffset + CH_REQUEST_FLAGS, 0, true);
}

function continuationMmap(
  memory: WebAssembly.Memory,
  channelOffset: number,
  size: number,
  label: string,
): number {
  const base = channelOffset;
  let view = new DataView(memory.buffer);
  view.setInt32(base + CH_SYSCALL, SYS_MMAP_NR, true);
  view.setBigInt64(base + CH_ARGS + 0 * CH_ARG_SIZE, 0n, true);
  view.setBigInt64(base + CH_ARGS + 1 * CH_ARG_SIZE, BigInt(size), true);
  view.setBigInt64(
    base + CH_ARGS + 2 * CH_ARG_SIZE,
    BigInt(PROT_READ_WRITE),
    true,
  );
  view.setBigInt64(
    base + CH_ARGS + 3 * CH_ARG_SIZE,
    BigInt(MAP_PRIVATE_ANONYMOUS),
    true,
  );
  view.setBigInt64(base + CH_ARGS + 4 * CH_ARG_SIZE, -1n, true);
  view.setBigInt64(base + CH_ARGS + 5 * CH_ARG_SIZE, 0n, true);
  markDeferredSignalDelivery(view, base);
  let i32 = new Int32Array(memory.buffer);
  Atomics.store(i32, (base + CH_STATUS) / 4, CHANNEL_STATUS_PENDING);
  Atomics.notify(i32, (base + CH_STATUS) / 4, 1);
  while (
    Atomics.wait(i32, (base + CH_STATUS) / 4, CHANNEL_STATUS_PENDING) === "ok"
  ) {
    /* */
  }

  view = new DataView(memory.buffer);
  i32 = new Int32Array(memory.buffer);
  const result = Number(view.getBigInt64(base + CH_RETURN, true));
  const err = view.getUint32(base + CH_ERRNO, true);
  clearDeferredSignalDelivery(view, base);
  Atomics.store(i32, (base + CH_STATUS) / 4, CHANNEL_STATUS_IDLE);
  if (err || result < 0) {
    const errno = err || -result;
    throw new ContinuationAllocationError(
      errno,
      size,
      `${label}: mmap(${size}) failed errno=${errno}`,
    );
  }
  return result;
}

function continuationMunmap(
  memory: WebAssembly.Memory,
  channelOffset: number,
  addr: number,
  size: number,
  label: string,
): void {
  const base = channelOffset;
  const view = new DataView(memory.buffer);
  view.setInt32(base + CH_SYSCALL, ABI_SYSCALLS.Munmap, true);
  view.setBigInt64(base + CH_ARGS + 0 * CH_ARG_SIZE, BigInt(addr), true);
  view.setBigInt64(base + CH_ARGS + 1 * CH_ARG_SIZE, BigInt(size), true);
  for (let i = 2; i < 6; i++) {
    view.setBigInt64(base + CH_ARGS + i * CH_ARG_SIZE, 0n, true);
  }
  markDeferredSignalDelivery(view, base);
  const i32 = new Int32Array(memory.buffer);
  Atomics.store(i32, (base + CH_STATUS) / 4, CHANNEL_STATUS_PENDING);
  Atomics.notify(i32, (base + CH_STATUS) / 4, 1);
  while (
    Atomics.wait(i32, (base + CH_STATUS) / 4, CHANNEL_STATUS_PENDING) === "ok"
  ) {
    /* */
  }
  const resultView = new DataView(memory.buffer);
  const resultI32 = new Int32Array(memory.buffer);
  const result = Number(resultView.getBigInt64(base + CH_RETURN, true));
  const err = resultView.getUint32(base + CH_ERRNO, true);
  clearDeferredSignalDelivery(resultView, base);
  Atomics.store(resultI32, (base + CH_STATUS) / 4, CHANNEL_STATUS_IDLE);
  if (err || result < 0) {
    throw new Error(
      `${label}: munmap(0x${addr.toString(16)}, ${size}) failed errno=${err || -result}`,
    );
  }
}

/**
 * Build kernel.* import stubs for channel-mode Wasm modules.
 * Both process and thread workers need these because the musl overlay CRT
 * imports kernel.* functions for argc/argv, environ, fork state, and clone.
 *
 * Startup metadata pointers are checked against their declared process
 * pointer width before any guest-memory view is created.
 */
type KernelImports = Record<string, WebAssembly.ExportValue> & {
  kernel_exit: (status: number) => void;
  kernel_fork: (mode: number) => number;
};

const STARTUP_E2BIG = 7;
const STARTUP_EAGAIN = 11;
const STARTUP_ENOMEM = 12;
const STARTUP_EFAULT = 14;
const STARTUP_EINVAL = 22;
const STARTUP_ERANGE = 34;
// Errno::EOPNOTSUPP (crates/shared/src/lib.rs; POSIX ENOTSUP shares this value).
// Returned to a guest fork() that carries a reference kind the platform cannot
// faithfully reconstruct in a fresh child (see the capture-side record-stubs in
// fork-activation-registry.ts). No host-generated numeric errno constant exists
// for this seam, so it is defined symbolically here.
const FORK_REFERENCE_EOPNOTSUPP = 95;

function processForkMode(value: number): ProcessForkMode | null {
  if (value === PROCESS_FORK_MODE_FORK) return PROCESS_FORK_MODE_FORK;
  if (value === PROCESS_FORK_MODE_VFORK) return PROCESS_FORK_MODE_VFORK;
  return null;
}

function processForkSyscall(mode: ProcessForkMode): number {
  return mode === PROCESS_FORK_MODE_VFORK
    ? HOST_INTERCEPTED_SYSCALLS.SYS_VFORK
    : HOST_INTERCEPTED_SYSCALLS.SYS_FORK;
}

interface EncodedStartupMetadata {
  argv: readonly Uint8Array[];
  env: readonly Uint8Array[];
}

function encodeStartupMetadata(
  argv: readonly string[],
  env: readonly string[],
  ptrWidth: 4 | 8,
): EncodedStartupMetadata {
  if (argv.length > PROCESS_STARTUP_MAX_ARGV_COUNT) {
    throw new RangeError(
      `startup argv count exceeds ${PROCESS_STARTUP_MAX_ARGV_COUNT}: errno ${STARTUP_E2BIG}`,
    );
  }
  if (env.length > PROCESS_STARTUP_MAX_ENVP_COUNT) {
    throw new RangeError(
      `startup environment count exceeds ${PROCESS_STARTUP_MAX_ENVP_COUNT}: errno ${STARTUP_E2BIG}`,
    );
  }

  const encoder = new TextEncoder();
  // The two terminating null pointers count even for empty vectors.
  let representedBytes = 2 * ptrWidth;
  const encodeVector = (
    values: readonly string[],
    label: string,
  ): readonly Uint8Array[] => values.map((value, index) => {
    if (typeof value !== "string") {
      throw new TypeError(`${label}[${index}] must be a string`);
    }
    const encoded = encoder.encode(value);
    if (encoded.byteLength > PROCESS_METADATA_ENTRY_MAX_BYTES) {
      throw new RangeError(
        `${label}[${index}] exceeds the per-entry startup transfer limit: ` +
          `errno ${STARTUP_E2BIG}`,
      );
    }
    representedBytes += ptrWidth + encoded.byteLength + 1;
    if (
      !Number.isSafeInteger(representedBytes)
      || representedBytes > POSIX_ARG_MAX_BYTES
    ) {
      throw new RangeError(
        `startup argv/environment representation exceeds ARG_MAX: ` +
          `errno ${STARTUP_E2BIG}`,
      );
    }
    return encoded;
  });

  // WHY: startup imports can be queried twice (size, then exact copy). Encode
  // once so no caller mutation or coercion can make the second observation
  // name different bytes after the guest has allocated its lifetime region.
  return {
    argv: encodeVector(argv, "startup argv"),
    env: encodeVector(env, "startup environment"),
  };
}

function buildKernelImports(
  memory: WebAssembly.Memory,
  channelOffset: number,
  ptrWidth: 4 | 8,
  argv: string[] | undefined,
  envVars: string[] | undefined,
  secureExec: boolean,
  onKernelExit?: (status: number) => void,
): KernelImports {
  const metadata = encodeStartupMetadata(argv ?? [], envVars ?? [], ptrWidth);
  // The legacy clone payload remains a fixed wasm32 pair in CH_DATA.
  const n = (value: number | bigint): number =>
    typeof value === "bigint" ? Number(value) : value;
  const copyEntry = (
    entries: readonly Uint8Array[],
    index: number,
    bufPtr: WasmGuestPointer,
    bufCapacity: number,
    label: string,
  ): number => {
    if (
      !Number.isSafeInteger(index)
      || index < 0
      || index >= entries.length
      || !Number.isSafeInteger(bufCapacity)
      || bufCapacity < 0
    ) {
      return -STARTUP_EINVAL;
    }
    const encoded = entries[index];
    if (bufCapacity === 0) {
      // Zero capacity is a side-effect-free complete-length query. The CRT
      // follows it with one exact-capacity copy into its mmap-owned region.
      return encoded.byteLength;
    }
    if (bufCapacity < encoded.byteLength) return -STARTUP_ERANGE;
    if (bufPtr === 0 || bufPtr === 0n) return -STARTUP_EFAULT;

    let range: { offset: number; length: number };
    try {
      range = checkedWasmMemoryRange(
        memory,
        bufPtr,
        encoded.byteLength,
        ptrWidth,
        label,
      );
    } catch {
      return -STARTUP_EFAULT;
    }
    // The encoded source is an immutable launch snapshot, and this direct
    // import has no await or callback between the range proof and full copy.
    new Uint8Array(memory.buffer, range.offset, range.length).set(encoded);
    return encoded.byteLength;
  };

  return {
    // CRT argv support
    kernel_get_argc: (): number => metadata.argv.length,
    kernel_argv_read: (index: number, bufPtr: number | bigint, bufMax: number): number => {
      return copyEntry(metadata.argv, index, bufPtr, bufMax, "kernel_argv_read");
    },

    // CRT environ support
    kernel_environ_count: (): number => metadata.env.length,
    kernel_environ_get: (index: number, bufPtr: number | bigint, bufMax: number): number => {
      return copyEntry(metadata.env, index, bufPtr, bufMax, "kernel_environ_get");
    },

    // Sticky kernel-owned state captured for this exact process image.
    kernel_get_secure_exec: (): number => secureExec ? 1 : 0,

    // Fork/exec state — not a fork child.
    kernel_is_fork_child: (): number => 0,
    kernel_apply_fork_fd_actions: (): number => 0,
    kernel_get_fork_exec_path: (_buf: number | bigint, _max: number): number =>
      0,
    kernel_get_fork_exec_argc: (): number => 0,
    kernel_get_fork_exec_argv: (
      _index: number,
      _buf: number | bigint,
      _max: number,
    ): number => 0,
    kernel_push_argv: (_ptr: number | bigint, _len: number): void => {},
    kernel_clear_fork_exec: (): number => 0,

    // Exec dispatches through channel
    kernel_execve: (_pathPtr: number | bigint): number => -38, // ENOSYS

    // Exit dispatches through channel (SYS_EXIT)
    kernel_exit: (status: number): void => {
      const view = new DataView(memory.buffer);
      const base = channelOffset;
      if (isExecRetirementMarker(view, base)) {
        // Exec keeps the kernel Process alive. The old browser Worker must
        // unwind without publishing SYS_EXIT, then its wrapper emits the
        // exact-generation memory_quiescent ownership fence.
        view.setUint32(base + CH_SIG_SIGNUM, 0, true);
        view.setUint32(base + CH_SIG_SI_CODE, 0, true);
        throw new ExecRetirement();
      }
      view.setInt32(base + CH_SYSCALL, ABI_SYSCALLS.Exit, true);
      view.setBigInt64(base + CH_ARGS, BigInt(status), true);
      const i32 = new Int32Array(memory.buffer);
      Atomics.store(i32, (base + CH_STATUS) / 4, CHANNEL_STATUS_PENDING);
      Atomics.notify(i32, (base + CH_STATUS) / 4, 1);
      // Wait until the reusable kernel transaction returns and the host has
      // committed the exit before terminating this disposable process Worker.
      while (
        Atomics.wait(i32, (base + CH_STATUS) / 4, CHANNEL_STATUS_PENDING) ===
        "ok"
      ) {
        /* */
      }
      onKernelExit?.(status);
      // WHY: this trap belongs at the disposable guest-Worker boundary, not in
      // the reusable kernel Wasm. It enforces `_Noreturn` even if a caller was
      // built without the compiler's trailing unreachable, and prevents
      // libc's SYS_exit retry loop from parking on a channel already removed
      // by the host.
      throw new WebAssembly.RuntimeError("unreachable");
    },

    // Clone dispatches through channel (SYS_CLONE)
    kernel_clone: (
      fnPtr: number | bigint,
      stackPtr: number | bigint,
      flags: number,
      arg: number | bigint,
      ptidPtr: number | bigint,
      tlsPtr: number | bigint,
      ctidPtr: number | bigint,
    ): number => {
      const SYS_CLONE_NR = ABI_SYSCALLS.Clone;
      const view = new DataView(memory.buffer);
      const base = channelOffset;
      view.setInt32(base + CH_SYSCALL, SYS_CLONE_NR, true);
      view.setBigInt64(base + CH_ARGS + 0 * CH_ARG_SIZE, BigInt(flags), true);
      view.setBigInt64(
        base + CH_ARGS + 1 * CH_ARG_SIZE,
        BigInt(stackPtr),
        true,
      );
      view.setBigInt64(base + CH_ARGS + 2 * CH_ARG_SIZE, BigInt(ptidPtr), true);
      view.setBigInt64(base + CH_ARGS + 3 * CH_ARG_SIZE, BigInt(tlsPtr), true);
      view.setBigInt64(base + CH_ARGS + 4 * CH_ARG_SIZE, BigInt(ctidPtr), true);
      view.setBigInt64(base + CH_ARGS + 5 * CH_ARG_SIZE, 0n, true);
      // Write fn_ptr and arg_ptr to CH_DATA area for handleClone
      view.setUint32(base + CH_DATA, n(fnPtr), true);
      view.setUint32(base + CH_DATA + 4, n(arg), true);

      markDeferredSignalDelivery(view, base);
      const i32 = new Int32Array(memory.buffer);
      Atomics.store(i32, (base + CH_STATUS) / 4, CHANNEL_STATUS_PENDING);
      Atomics.notify(i32, (base + CH_STATUS) / 4, 1);
      while (
        Atomics.wait(i32, (base + CH_STATUS) / 4, CHANNEL_STATUS_PENDING) ===
        "ok"
      ) {
        /* */
      }

      const result = Number(view.getBigInt64(base + CH_RETURN, true));
      const err = view.getUint32(base + CH_ERRNO, true);
      clearDeferredSignalDelivery(view, base);
      Atomics.store(i32, (base + CH_STATUS) / 4, CHANNEL_STATUS_IDLE);

      if (err) return -err;
      return result;
    },

    // Fork dispatches through the mode's dedicated channel syscall.
    kernel_fork: (rawMode: number): number => {
      const mode = processForkMode(rawMode);
      if (mode === null) return -STARTUP_EINVAL;
      const view = new DataView(memory.buffer);
      const base = channelOffset;
      view.setInt32(
        base + CH_SYSCALL,
        processForkSyscall(mode),
        true,
      );
      for (let i = 0; i < 6; i++)
        view.setBigInt64(base + CH_ARGS + i * CH_ARG_SIZE, 0n, true);

      markDeferredSignalDelivery(view, base);
      const i32 = new Int32Array(memory.buffer);
      Atomics.store(i32, (base + CH_STATUS) / 4, CHANNEL_STATUS_PENDING);
      Atomics.notify(i32, (base + CH_STATUS) / 4, 1);
      while (
        Atomics.wait(i32, (base + CH_STATUS) / 4, CHANNEL_STATUS_PENDING) ===
        "ok"
      ) {
        /* */
      }

      const result = Number(view.getBigInt64(base + CH_RETURN, true));
      const err = view.getUint32(base + CH_ERRNO, true);
      clearDeferredSignalDelivery(view, base);
      Atomics.store(i32, (base + CH_STATUS) / 4, CHANNEL_STATUS_IDLE);

      if (err) return -err;
      return result;
    },
  };
}

/** @internal Exported for focused startup import contract tests. */
export function buildKernelImportsForTest(
  memory: WebAssembly.Memory,
  channelOffset: number,
  ptrWidth: 4 | 8,
  argv: string[] = [],
  env: string[] = [],
  secureExec: boolean = false,
): Record<string, WebAssembly.ExportValue> {
  return buildKernelImports(
    memory,
    channelOffset,
    ptrWidth,
    argv,
    env,
    secureExec,
  );
}

export interface DlopenSupport {
  imports: Record<string, WebAssembly.ExportValue>;
  /** Validate and return the compact copied live-module closure. */
  readForkState: () => DylinkForkState;
  /** Recreate the parent's live module and handle state from linear memory. */
  replayDlopens: (
    validatedState?: DylinkForkState,
    options?: { readonly memoryOwnership?: "copied" | "borrowed" },
  ) => void;
  /** Clear a fork parent's copied archive lock in ordinary child memory. */
  resetForkChildLock: () => void;
  readonly archive: DylinkForkArchive;
  /** Acquire one reentrant process-archive writer depth, blocking if needed. */
  acquireArchiveWriter(): void;
  /** Release exactly one writer depth acquired by this Worker. */
  releaseArchiveWriter(): void;
  /** Acquire one process-archive reader token, blocking behind a writer. */
  acquireArchiveReader(): void;
  /** Release one reader token acquired by this Worker. */
  releaseArchiveReader(): void;
  withArchiveWriter<T>(operation: () => T): T;
  withArchiveReader<T>(operation: () => T): T;
  writerOwned(): boolean;
  /** Run after a fresh writer acquisition and before the protected operation. */
  setWriterAcquireObserver(observer: () => void): void;
  /** Clean up state owned by a failed linker operation before releasing it. */
  setOperationAbortObserver(observer: () => void): void;
  setCommitObserver(
    observer: (
      linkerPublication: DylinkForkArchiveSnapshot | undefined,
      tableMutationCommitted: boolean,
    ) => void,
  ): void;
}

interface ProcessDylinkActivationOwnerOptions {
  readonly memory: WebAssembly.Memory;
  readonly ptrWidth: 4 | 8;
  readonly channelOffset: number;
  readonly forkUnwindTag: WebAssembly.Tag | undefined;
  readonly coordinator: ForkProcessContinuationCoordinator;
  readonly registry: ForkActivationRegistry;
  readonly exceptionBroker: ForkExceptionBroker;
  readonly importedStateCapture?: ForkImportedGlobalCapture;
  readonly tableReplication?: ForkActivationTableReplication;
  /**
   * The child planner needs the copied dlopen archive, while the archive
   * reader needs the activation owner installed first. Resolve it lazily at
   * the actual side-module instantiation boundary to break that construction
   * cycle without permitting a side activation to instantiate unplanned.
   */
  readonly importedStatePlanner?: () => ForkImportedGlobalPlanner | null;
  readonly referenceReplay?: () => ProcessReferenceReplayImports;
  readonly registerChildReferenceActivation?: (
    activationId: number,
    module: WebAssembly.Module,
    registration: ForkActivationRegistration,
    typedReferenceProvider: ForkGcCodecProvider,
  ) => void;
  readonly isForkChild: boolean;
  /**
   * A pthread owns a separate instance graph but adopts the process archive's
   * stable activation coordinates. Unlike a fork child it captures live state
   * and therefore uses the parent imported-state owner and bootstrap path.
   */
  readonly isPthreadReplica?: boolean;
  readonly invokeProcessFork: () => number;
  /**
   * Phase 6 D7a.1a: when present (a qualifying module-backed dlopen fork), each
   * side activation's five frozen frame/resume imports are flipped to its own
   * trampoline (wasm->wasm), and its resume catalog is seeded into the module so
   * its slot numbering matches its JS `__wpk_fork_resume_table`. Null keeps the
   * byte-identical JS continuation closures for the activation's frames.
   */
  readonly forkModuleFrameFlip?: {
    readonly trampolines: ForkModuleTrampolines;
    readonly backend: ForkModuleContinuationBackend;
  };
  /**
   * Phase 6 D7a.1b: when a dlopen fork's whole reference graph is admitted for
   * module reconstruction (`moduleReferenceKindsSupported`), every side
   * activation's `__wpk_fork_ref_decode_funcref` import is flipped to the SAME
   * shared module export — the merged, activation-namespaced catalog makes one
   * export correct for every activation. Returns the import override to spread
   * into each side activation's env, or `{}` to keep the JS reference decode.
   * Resolved lazily at side-module instantiation (which happens AFTER the
   * predicate is computed), so it reads the final `moduleReferenceKindsSupported`.
   */
  readonly forkModuleReferenceFlip?: () => Record<
    string,
    WebAssembly.ImportValue
  >;
  readonly label: string;
}

interface ProcessReferenceReplayImports
  extends
    ForkActivationReferenceReplayImports,
    ForkExceptionReferenceReplayImports {}

/**
 * Bind every instrumented side-module instance to the one process
 * continuation transaction.
 *
 * Activation IDs are monotonic in a parent and copied verbatim through the
 * dlopen replay archive. They are coordinates in KFMS recipes and replay
 * events, not reusable loader handles.
 */
function createProcessDylinkActivationOwner(
  options: ProcessDylinkActivationOwnerOptions,
): DylinkForkActivationOwner {
  let nextActivationId = 1;
  const claimed = new Set<number>();

  const claimActivationId = (
    replayActivationId: number | undefined,
  ): number => {
    const activationId = replayActivationId ?? nextActivationId;
    if (
      !Number.isInteger(activationId) ||
      activationId <= 0 ||
      activationId > 0xffff_ffff
    ) {
      throw new RangeError(
        `${options.label}: side-module activation id ${String(activationId)} is invalid`,
      );
    }
    if (claimed.has(activationId)) {
      throw new Error(
        `${options.label}: side-module activation id ${activationId} was claimed twice`,
      );
    }
    claimed.add(activationId);
    if (activationId >= nextActivationId) {
      if (activationId === 0xffff_ffff) {
        nextActivationId = 0x1_0000_0000;
      } else {
        nextActivationId = activationId + 1;
      }
    }
    return activationId;
  };

  return {
    prepare(request) {
      if (options.isForkChild && request.replayActivationId === undefined) {
        throw new Error(
          `${request.name}: fresh-child replay is missing its activation id`,
        );
      }
      if (
        !options.isForkChild &&
        !options.tableReplication &&
        request.replayActivationId !== undefined
      ) {
        throw new Error(
          `${request.name}: a parent load supplied a replay activation id`,
        );
      }
      // WHY: any live process Worker may reconcile an activation published by
      // a peer or originate dlopen while holding the process archive writer.
      // Its writer-acquire hook first adopts every published activation, so
      // the same monotonic allocator safely claims the next process-wide ID.
      const activationId = claimActivationId(request.replayActivationId);
      let prepared = false;
      let registered = false;
      let released = false;
      let exceptionProvider: ForkExceptionProvider | null = null;
      let importedStatePreparation: PreparedForkParentActivation | null = null;
      let childImportedStatePlanner: ForkImportedGlobalPlanner | null = null;
      let importedStateRegistered = false;
      let importsWrapped = false;
      // The co-resident Rust module owns all linked frames/journal/resume
      // storage (Phase 4 point of no return). The host only carries this
      // activation's linked-frame FORMAT descriptor into the coordinator.
      const continuation: ForkActivationContinuation = {
        format: readLinkedFrameFormat(request.module),
      };
      if (continuation.format.ptrWidth !== options.ptrWidth) {
        throw new Error(
          `${request.name}: linked continuation pointer width ` +
            `${continuation.format.ptrWidth} does not match the process ` +
            `pointer width ${options.ptrWidth}`,
        );
      }
      const moduleState = readForkModuleStateDescriptor(request.module);
      if (moduleState.ptrWidth !== options.ptrWidth) {
        throw new Error(
          `${request.name}: module-state pointer width ${moduleState.ptrWidth} ` +
            `does not match the process pointer width ${options.ptrWidth}`,
        );
      }
      const templateId = computeForkModuleTemplateIdSync(request.moduleBytes);

      try {
        options.coordinator.prepareActivation({
          activationId,
          continuation,
        });
        prepared = true;
      } catch (error) {
        claimed.delete(activationId);
        throw error;
      }

      // Phase 6 D7a.1a: seed THIS side activation's resume catalog into the
      // module once, at instantiation (before any fork drives it), so the
      // module numbers its resume slots from the SAME ordinals as its JS
      // `__wpk_fork_resume_table`. Done on both the parent (dlopen) and the child
      // (replayDlopens), each seeding its own module instance.
      if (options.forkModuleFrameFlip) {
        const activationOrdinals = readForkResumeCatalog(request.module).map(
          (entry) => entry.functionOrdinal,
        );
        options.forkModuleFrameFlip.backend.setActivationResumeCatalog(
          activationId,
          activationOrdinals,
        );
      }

      const env: Record<string, WebAssembly.ImportValue> = {
        fork: (): number => options.invokeProcessFork(),
        [FORK_UNWIND_TAG_IMPORT_NAME]: requireForkUnwindTag(
          options.forkUnwindTag,
          `${request.name}: fork activation`,
        ) as unknown as WebAssembly.ImportValue,
        ...options.coordinator.continuationImports(activationId),
        // Phase 6 D7a.1a FRAME FLIP: for a module-backed dlopen fork, this side
        // activation's five frozen frame/resume imports route through its own
        // trampoline (folding in the activation id) to the shared module. Placed
        // AFTER `continuationImports` so these five keys win; everything else it
        // returns — crucially the JS `__wpk_fork_resume_table` funcref table the
        // module's `resume_peek` indexes — is kept. References stay JS this slice.
        ...(options.forkModuleFrameFlip
          ? options.forkModuleFrameFlip.trampolines.frameImportsFor(activationId)
          : {}),
        ...buildForkActivationStateImports(
          activationId,
          options.registry,
          options.referenceReplay,
          options.tableReplication,
        ),
        ...buildForkExceptionImports({
          activationId,
          ptrWidth: options.ptrWidth,
          registry: options.registry,
          broker: options.exceptionBroker,
          provider: () => {
            if (!exceptionProvider) {
              throw new Error(
                `${request.name}: exception codec called before activation registration`,
              );
            }
            return exceptionProvider;
          },
          referenceReplay: options.referenceReplay,
        }),
        // Phase 6 D7a.1b REFERENCE FLIP: for a module-backed dlopen fork whose
        // whole reference graph is admitted, flip this side activation's
        // `__wpk_fork_ref_decode_funcref` to the SHARED module export (the same
        // one every activation uses — the merged, activation-namespaced catalog
        // resolves each funcref against its own activation's slice). Placed AFTER
        // `buildForkActivationStateImports` so this key wins over the JS decode.
        // `{}` (references on the JS path, or no module) leaves it byte-identical.
        ...(options.forkModuleReferenceFlip
          ? options.forkModuleReferenceFlip()
          : {}),
      };

      return {
        activationId,
        env,
        savedMutableGlobalImport(moduleName, importName) {
          if (!options.isForkChild) return undefined;
          if (!childImportedStatePlanner) {
            throw new Error(
              `${request.name}: activation ${activationId} requested saved `
              + "import state before wrapping its final imports",
            );
          }
          return childImportedStatePlanner.savedMutableGlobalImport(
            activationId,
            moduleName,
            importName,
          );
        },
        wrapImports: (imports) => {
          if (importsWrapped) {
            throw new Error(
              `${request.name}: activation ${activationId} wrapped its imports twice`,
            );
          }
          importsWrapped = true;
          childImportedStatePlanner = options.importedStatePlanner?.() ?? null;
          if (options.isForkChild && !childImportedStatePlanner) {
            throw new Error(
              `${request.name}: child activation ${activationId} has no ` +
                "pre-instantiation imported-state plan",
            );
          }
          let resolvedImports = imports;
          if (childImportedStatePlanner) {
            resolvedImports = childImportedStatePlanner.importsForActivation(
              activationId,
              imports as unknown as ForkWasmImports,
            ) as unknown as WebAssembly.Imports;
          }
          if (!options.importedStateCapture) return resolvedImports;
          // WHY: a fresh child must become a parent-capable owner after replay.
          // Plan the copied identities first, then observe the exact Global and
          // Table objects WebAssembly binds so a later fork can publish fresh
          // provenance instead of depending on its parent's consumed arena.
          importedStatePreparation =
            options.importedStateCapture.prepareActivation(
              activationId,
              request.module,
              resolvedImports,
            );
          return importedStatePreparation.imports as unknown as WebAssembly.Imports;
        },
        register(instance) {
          if (released || registered || !prepared) {
            throw new Error(
              `${request.name}: side-module activation ${activationId} ` +
                "cannot be registered in its current state",
            );
          }
          if (options.importedStateCapture) {
            if (!importedStatePreparation) {
              throw new Error(
                `${request.name}: activation ${activationId} did not wrap its final imports`,
              );
            }
            importedStatePreparation.complete(instance);
            importedStateRegistered = true;
          }
          if (options.isForkChild && !childImportedStatePlanner) {
            throw new Error(
              `${request.name}: child activation ${activationId} did not wrap its final imports`,
            );
          }
          exceptionProvider = forkExceptionProviderFromInstance(
            activationId,
            instance,
          );
          const typedReferenceProvider = forkGcCodecProviderFromInstance(
            activationId,
            request.module,
            instance,
          );
          const registration = forkActivationRegistrationFromInstance({
            activationId,
            module: request.module,
            instance,
            templateId,
            exceptionProvider,
            typedReferenceProvider,
          });
          options.coordinator.registerActivation(
            registration,
            forkResumeTargetsFromInstance(request.module, instance),
          );
          registered = true;
          prepared = false;
          childImportedStatePlanner?.registerInstance(activationId, instance);
          options.registerChildReferenceActivation?.(
            activationId,
            request.module,
            registration,
            typedReferenceProvider,
          );
          options.importedStateCapture?.bindTableDirtyTrackers(
            new Map(
              options.registry
                .activations()
                .map((activation) => [
                  activation.activationId,
                  activation.tableDirty,
                ]),
            ),
          );
          if (
            options.isPthreadReplica &&
            request.replayActivationId !== undefined
          ) {
            const threadBootstrap =
              instance.exports[WPK_FORK_EXPORT_MODULE_THREAD_BOOTSTRAP];
            if (typeof threadBootstrap !== "function") {
              throw new Error(
                `${request.name}: pthread replica is missing its table bootstrap`,
              );
            }
            // WHY: this Worker needs fresh instance-local element functions,
            // but process linear memory and constructors are already live.
            // The thread helper initializes only tables and drops data
            // segments; the parent bootstrap would re-run side effects.
            threadBootstrap();
          }
        },
        unregister() {
          if (released) {
            throw new Error(
              `${request.name}: side-module activation ${activationId} was released twice`,
            );
          }
          released = true;
          let failure: unknown;
          try {
            if (registered) {
              try {
                options.coordinator.unregisterActivation(activationId);
              } catch (error) {
                failure = error;
              }
            } else if (prepared) {
              try {
                options.coordinator.discardPreparedActivation(activationId);
                exceptionProvider?.abort();
              } catch (error) {
                failure = error;
              }
            }
            if (importedStateRegistered) {
              try {
                options.importedStateCapture!.unregisterActivation(
                  activationId,
                );
              } catch (error) {
                failure ??= error;
              }
            } else if (importedStatePreparation) {
              try {
                importedStatePreparation.abort();
              } catch (error) {
                failure ??= error;
              }
            }
          } finally {
            registered = false;
            prepared = false;
            exceptionProvider = null;
            importedStatePreparation = null;
            childImportedStatePlanner = null;
            importedStateRegistered = false;
            importsWrapped = false;
          }
          if (failure !== undefined) throw failure;
        },
      };
    },
  };
}

/**
 * Wasm-owned codecs for reference hierarchies that cannot appear in a
 * JavaScript function signature.
 *
 * These are intentionally dependencies, not optional fallbacks. The
 * activation provider registry must resolve them before instantiating a module
 * that imports the corresponding ABI hook.
 */
const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);

function checkedWasmByteLength(
  value: number | bigint,
  context: string,
): number {
  if (typeof value === "number" && !Number.isSafeInteger(value)) {
    throw new RangeError(
      `${context}: length is not an exact non-negative JavaScript integer`,
    );
  }
  const exact = typeof value === "bigint" ? value : BigInt(value);
  if (exact < 0n || exact > MAX_SAFE_BIGINT) {
    throw new RangeError(
      `${context}: length is not an exact non-negative JavaScript integer`,
    );
  }
  return Number(exact);
}

function checkedWasmMemoryRange(
  memory: WebAssembly.Memory,
  pointer: WasmGuestPointer,
  lengthValue: number | bigint,
  ptrWidth: 4 | 8,
  context: string,
): { offset: number; length: number } {
  const offset = checkedWasmGuestPointerOffset(pointer, ptrWidth, context);
  const length = checkedWasmByteLength(lengthValue, context);
  const memoryLength = memory.buffer.byteLength;
  if (offset > memoryLength || length > memoryLength - offset) {
    throw new RangeError(
      `${context}: memory range [${offset}, ${offset + length}) exceeds ${memoryLength} bytes`,
    );
  }
  return { offset, length };
}

/**
 * Build dlopen host imports for a process. These are called directly from
 * the user program's dlopen/dlsym/dlclose C stubs (libc/glue/dlopen.c).
 *
 * The DynamicLinker is lazily created on first use since most programs
 * don't use dlopen.
 *
 * Each successful dlopen is also persisted into a per-process archive
 * (linked list in linear memory, with control slots below the main process
 * channel's fork buffer) so the fork child can replay them via
 * `replayDlopens`. The archive anchor is deliberately independent of the
 * call-site rewind buffer: a fork issued by a pthread rewinds from that
 * thread's buffer but still inherits the one process-wide dlopen archive.
 */
/** @internal Exported so the pointer-width host import contract can be tested directly. */
export function buildDlopenImports(
  memory: WebAssembly.Memory,
  channelOffset: number,
  archiveControlAddr: number,
  getTable: () => WebAssembly.Table | undefined,
  getStackPointer: () => WebAssembly.Global | undefined,
  getInstance: () => WebAssembly.Instance | undefined,
  ptrWidth: 4 | 8,
  longjmpTag: WebAssembly.Tag | undefined,
  cppExceptionTag: WebAssembly.Tag | undefined,
  forkActivationOwner?: DylinkForkActivationOwner,
  forkActivationOwnerUnavailableReason?: string,
  forkUnwindTag?: WebAssembly.Tag,
  onTableMutation?: (
    table: WebAssembly.Table,
    firstIndex: number,
    length: number,
  ) => void,
  hostImportRuntime?: ForkHostImportWorkerRuntime,
  workerIdentity = 1,
  memoryOwnership: "copied" | "borrowed" = "copied",
): DlopenSupport {
  if (
    !Number.isInteger(workerIdentity) ||
    workerIdentity <= 0 ||
    workerIdentity > 0x7fff_ffff
  ) {
    throw new RangeError(
      `invalid dynamic-loader Worker identity ${String(workerIdentity)}`,
    );
  }
  let linker: DynamicLinker | null = null;
  const loadedLibraries = new Map<string, LoadedSharedLibrary>();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const n = (v: number | bigint): number =>
    typeof v === "bigint" ? Number(v) : v;
  const resolvedLibraryPaths = new Map<string, string>();
  const requireOwnedMemory = (operation: string): void => {
    if (memoryOwnership === "borrowed") {
      throw new Error(
        `borrowed vfork child cannot ${operation} before exec or _exit`,
      );
    }
  };

  const headOffset =
    ptrWidth === 8 ? DLOPEN_HEAD_OFFSET_WASM64 : DLOPEN_HEAD_OFFSET_WASM32;
  const lockOffset =
    ptrWidth === 8 ? DLOPEN_LOCK_OFFSET_WASM64 : DLOPEN_LOCK_OFFSET_WASM32;
  const generationOffset =
    ptrWidth === 8
      ? DLOPEN_GENERATION_OFFSET_WASM64
      : DLOPEN_GENERATION_OFFSET_WASM32;
  const ownerOffset =
    ptrWidth === 8 ? DLOPEN_OWNER_OFFSET_WASM64 : DLOPEN_OWNER_OFFSET_WASM32;
  const headSlot = archiveControlAddr - headOffset;
  const archiveLock = new Int32Array(
    memory.buffer,
    archiveControlAddr - lockOffset,
    1,
  );
  const loaderOwner = new Int32Array(
    memory.buffer,
    archiveControlAddr - ownerOffset,
    1,
  );
  const generationSlot = archiveControlAddr - generationOffset;
  const readGenerationFence = (): number => {
    const value =
      typeof SharedArrayBuffer !== "undefined" &&
      memory.buffer instanceof SharedArrayBuffer
        ? Atomics.load(new BigUint64Array(memory.buffer, generationSlot, 1), 0)
        : new DataView(memory.buffer).getBigUint64(generationSlot, true);
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new RangeError(
        "dlopen process generation exceeds exact host integers",
      );
    }
    return Number(value);
  };
  const writeGenerationFence = (generation: number): void => {
    requireOwnedMemory("publish a dynamic-loader generation");
    if (!Number.isSafeInteger(generation) || generation <= 0) {
      throw new RangeError(
        `invalid dlopen process generation ${String(generation)}`,
      );
    }
    if (
      typeof SharedArrayBuffer !== "undefined" &&
      memory.buffer instanceof SharedArrayBuffer
    ) {
      Atomics.store(
        new BigUint64Array(memory.buffer, generationSlot, 1),
        0,
        BigInt(generation),
      );
    } else {
      new DataView(memory.buffer).setBigUint64(
        generationSlot,
        BigInt(generation),
        true,
      );
    }
  };
  const readArchiveHead = (): number =>
    ptrWidth === 8
      ? Number(Atomics.load(new BigUint64Array(memory.buffer, headSlot, 1), 0))
      : Atomics.load(new Uint32Array(memory.buffer, headSlot, 1), 0);
  const writeArchiveHead = (value: number): void => {
    requireOwnedMemory("replace the dynamic-loader archive");
    if (ptrWidth === 8) {
      Atomics.store(
        new BigUint64Array(memory.buffer, headSlot, 1),
        0,
        BigInt(value),
      );
    } else {
      Atomics.store(new Uint32Array(memory.buffer, headSlot, 1), 0, value);
    }
  };
  const linkerAllocations = new Map<
    number,
    { rawAddr: number; length: number }
  >();
  let hostDlopenError: string | null = null;
  let mainDlopenDepth = 0;
  let mainArchiveReaderDepth = 0;
  const ownedDlopenTransactions = new Set<number>();
  let tableMutationPending = false;
  let commitObserver:
    | ((
        linkerPublication: DylinkForkArchiveSnapshot | undefined,
        tableMutationCommitted: boolean,
      ) => void)
    | null = null;
  let writerAcquireObserver: (() => void) | null = null;
  let operationAbortObserver: (() => void) | null = null;
  const finishFreshWriterAcquisition = (): void => {
    mainDlopenDepth = 1;
    try {
      writerAcquireObserver?.();
    } catch (error) {
      releaseMainDlopenLock();
      throw error;
    }
  };
  const foreignLoaderOwner = (): number => {
    const owner = Atomics.load(loaderOwner, 0);
    return owner !== DLOPEN_OWNER_IDLE && owner !== workerIdentity
      ? owner
      : DLOPEN_OWNER_IDLE;
  };
  const releaseRawWriterLock = (): void => {
    const owner = Atomics.compareExchange(
      archiveLock,
      0,
      DLOPEN_LOCK_WRITER,
      DLOPEN_LOCK_IDLE,
    );
    if (owner !== DLOPEN_LOCK_WRITER) {
      throw new Error(
        `dlopen process lock lost writer ownership (state=${owner})`,
      );
    }
    Atomics.notify(archiveLock, 0);
  };
  const claimLoaderOwnership = (): void => {
    if (mainDlopenDepth <= 0) {
      throw new Error("dynamic-loader ownership requires the archive writer");
    }
    const owner = Atomics.compareExchange(
      loaderOwner,
      0,
      DLOPEN_OWNER_IDLE,
      workerIdentity,
    );
    if (owner !== DLOPEN_OWNER_IDLE && owner !== workerIdentity) {
      throw new Error(`dynamic-loader ownership belongs to Worker ${owner}`);
    }
  };
  const releaseLoaderOwnershipIfIdle = (): void => {
    if (ownedDlopenTransactions.size !== 0) return;
    const owner = Atomics.compareExchange(
      loaderOwner,
      0,
      workerIdentity,
      DLOPEN_OWNER_IDLE,
    );
    if (owner !== workerIdentity && owner !== DLOPEN_OWNER_IDLE) {
      throw new Error(`dynamic-loader ownership changed to Worker ${owner}`);
    }
    Atomics.notify(loaderOwner, 0);
  };
  const acquireMainDlopenLock = (): boolean => {
    // POSIX loader serialization is blocking. Imports run in process Workers,
    // so Atomics.wait can suspend only the contending pthread while the owner
    // continues its staged guest initializer in a different Worker.
    acquireArchiveWriter();
    return true;
  };
  const releaseMainDlopenLock = (): void => {
    if (mainDlopenDepth <= 0) {
      throw new Error("dlopen process lock released without ownership");
    }
    mainDlopenDepth--;
    if (mainDlopenDepth === 0) {
      releaseRawWriterLock();
    }
  };
  const withArchiveWriter = <T>(operation: () => T): T => {
    acquireArchiveWriter();
    try {
      return operation();
    } finally {
      releaseMainDlopenLock();
    }
  };
  const acquireArchiveWriter = (): void => {
    requireOwnedMemory("acquire the dynamic-loader archive writer");
    if (mainArchiveReaderDepth > 0) {
      throw new Error(
        "cannot acquire the process archive writer while owning a reader",
      );
    }
    if (mainDlopenDepth > 0) {
      mainDlopenDepth++;
      return;
    }
    for (;;) {
      const transactionOwner = foreignLoaderOwner();
      if (transactionOwner !== DLOPEN_OWNER_IDLE) {
        Atomics.wait(loaderOwner, 0, transactionOwner);
        continue;
      }
      const owner = Atomics.compareExchange(
        archiveLock,
        0,
        DLOPEN_LOCK_IDLE,
        DLOPEN_LOCK_WRITER,
      );
      if (owner === DLOPEN_LOCK_IDLE) {
        const racedTransactionOwner = foreignLoaderOwner();
        if (racedTransactionOwner === DLOPEN_OWNER_IDLE) break;
        releaseRawWriterLock();
        Atomics.wait(loaderOwner, 0, racedTransactionOwner);
        continue;
      }
      Atomics.wait(archiveLock, 0, owner);
    }
    finishFreshWriterAcquisition();
  };
  const acquireArchiveReader = (): void => {
    requireOwnedMemory("acquire the dynamic-loader archive reader");
    if (mainDlopenDepth > 0) {
      throw new Error(
        "cannot acquire a process archive reader while owning its writer",
      );
    }
    for (;;) {
      const transactionOwner = foreignLoaderOwner();
      if (transactionOwner !== DLOPEN_OWNER_IDLE) {
        // POSIX fork preserves only its calling thread. Waiting here prevents
        // a child from inheriting another thread's half-executed constructor,
        // whose Wasm continuation cannot exist in the child.
        Atomics.wait(loaderOwner, 0, transactionOwner);
        continue;
      }
      const owner = Atomics.load(archiveLock, 0);
      if (owner < 0) {
        Atomics.wait(archiveLock, 0, owner);
        continue;
      }
      if (owner >= DLOPEN_LOCK_MAX_READERS) {
        throw new RangeError("dlopen process archive reader count exhausted");
      }
      if (Atomics.compareExchange(archiveLock, 0, owner, owner + 1) !== owner) {
        continue;
      }
      mainArchiveReaderDepth++;
      return;
    }
  };
  const releaseArchiveReader = (): void => {
    if (mainArchiveReaderDepth <= 0) {
      throw new Error(
        "dlopen process archive reader released without ownership",
      );
    }
    for (;;) {
      const owner = Atomics.load(archiveLock, 0);
      if (owner <= DLOPEN_LOCK_IDLE) {
        throw new Error(
          `dlopen process archive reader lost ownership (state=${owner})`,
        );
      }
      if (Atomics.compareExchange(archiveLock, 0, owner, owner - 1) !== owner) {
        continue;
      }
      mainArchiveReaderDepth--;
      if (owner === 1) Atomics.notify(archiveLock, 0);
      return;
    }
  };
  const withArchiveReader = <T>(operation: () => T): T => {
    acquireArchiveReader();
    try {
      return operation();
    } finally {
      releaseArchiveReader();
    }
  };
  const notifyCommit = (
    publication: DylinkForkArchiveSnapshot | undefined,
  ): void => {
    const mutated = tableMutationPending;
    tableMutationPending = false;
    commitObserver?.(publication, mutated);
  };
  const abortLinkerOperation = (): void => {
    tableMutationPending = false;
    operationAbortObserver?.();
  };

  const invokeChannelSyscall = (
    syscall: number,
    args: readonly (number | bigint)[],
  ): { result: number; errno: number } => {
    const view = new DataView(memory.buffer);
    const base = channelOffset;
    view.setInt32(base + CH_SYSCALL, syscall, true);
    for (let i = 0; i < 6; i++) {
      view.setBigInt64(
        base + CH_ARGS + i * CH_ARG_SIZE,
        BigInt(args[i] ?? 0),
        true,
      );
    }
    markDeferredSignalDelivery(view, base);
    const i32 = new Int32Array(memory.buffer);
    Atomics.store(i32, (base + CH_STATUS) / 4, CHANNEL_STATUS_PENDING);
    Atomics.notify(i32, (base + CH_STATUS) / 4, 1);
    while (
      Atomics.wait(i32, (base + CH_STATUS) / 4, CHANNEL_STATUS_PENDING) === "ok"
    ) {
      /* wait for the kernel Worker */
    }
    const result = Number(view.getBigInt64(base + CH_RETURN, true));
    const errno = view.getUint32(base + CH_ERRNO, true);
    clearDeferredSignalDelivery(view, base);
    Atomics.store(i32, (base + CH_STATUS) / 4, CHANNEL_STATUS_IDLE);
    return { result, errno };
  };

  // The kernel mmap allocator. Shared with the linker, but also used
  // directly by persistArchiveEntry to obtain blocks for the archive.
  const allocateMemory = (size: number, align: number): number => {
    requireOwnedMemory("allocate dynamic-loader memory");
    const requested = size + Math.max(align, 1) - 1;
    const view = new DataView(memory.buffer);
    const base = channelOffset;
    view.setInt32(base + CH_SYSCALL, SYS_MMAP_NR, true);
    view.setBigInt64(base + CH_ARGS + 0 * CH_ARG_SIZE, 0n, true);
    view.setBigInt64(base + CH_ARGS + 1 * CH_ARG_SIZE, BigInt(requested), true);
    view.setBigInt64(
      base + CH_ARGS + 2 * CH_ARG_SIZE,
      BigInt(PROT_READ_WRITE),
      true,
    );
    view.setBigInt64(
      base + CH_ARGS + 3 * CH_ARG_SIZE,
      BigInt(MAP_PRIVATE_ANONYMOUS),
      true,
    );
    view.setBigInt64(base + CH_ARGS + 4 * CH_ARG_SIZE, -1n, true);
    view.setBigInt64(base + CH_ARGS + 5 * CH_ARG_SIZE, 0n, true);

    markDeferredSignalDelivery(view, base);
    const i32 = new Int32Array(memory.buffer);
    Atomics.store(i32, (base + CH_STATUS) / 4, CHANNEL_STATUS_PENDING);
    Atomics.notify(i32, (base + CH_STATUS) / 4, 1);
    while (
      Atomics.wait(i32, (base + CH_STATUS) / 4, CHANNEL_STATUS_PENDING) === "ok"
    ) {
      /* wait for mmap */
    }

    const result = Number(view.getBigInt64(base + CH_RETURN, true));
    const err = view.getUint32(base + CH_ERRNO, true);
    clearDeferredSignalDelivery(view, base);
    Atomics.store(i32, (base + CH_STATUS) / 4, CHANNEL_STATUS_IDLE);

    if (err || result < 0) {
      throw new Error(
        `dlopen: mmap(${requested}) failed errno=${err || -result}`,
      );
    }
    const aligned = alignUp(n(result), Math.max(align, 1));
    linkerAllocations.set(aligned, { rawAddr: n(result), length: requested });
    return aligned;
  };

  const deallocateMemory = (
    addr: number,
    size: number,
    allowCopiedArchiveAllocation = false,
  ): void => {
    requireOwnedMemory("release dynamic-loader memory");
    const allocation = linkerAllocations.get(addr);
    if (!allocation && !allowCopiedArchiveAllocation) {
      throw new Error(
        `dlopen rollback: unknown allocation 0x${addr.toString(16)}`,
      );
    }
    const rawAddr = allocation?.rawAddr ?? addr;
    const length = allocation?.length ?? size;
    if (
      !Number.isSafeInteger(rawAddr) ||
      rawAddr <= 0 ||
      !Number.isSafeInteger(length) ||
      length <= 0 ||
      rawAddr > memory.buffer.byteLength - length
    ) {
      throw new Error("dlopen archive release names an invalid copied mapping");
    }
    const view = new DataView(memory.buffer);
    const base = channelOffset;
    view.setInt32(base + CH_SYSCALL, ABI_SYSCALLS.Munmap, true);
    view.setBigInt64(base + CH_ARGS + 0 * CH_ARG_SIZE, BigInt(rawAddr), true);
    view.setBigInt64(base + CH_ARGS + 1 * CH_ARG_SIZE, BigInt(length), true);
    for (let i = 2; i < 6; i++) {
      view.setBigInt64(base + CH_ARGS + i * CH_ARG_SIZE, 0n, true);
    }

    markDeferredSignalDelivery(view, base);
    const i32 = new Int32Array(memory.buffer);
    Atomics.store(i32, (base + CH_STATUS) / 4, CHANNEL_STATUS_PENDING);
    Atomics.notify(i32, (base + CH_STATUS) / 4, 1);
    while (
      Atomics.wait(i32, (base + CH_STATUS) / 4, CHANNEL_STATUS_PENDING) === "ok"
    ) {
      /* wait */
    }

    const result = Number(view.getBigInt64(base + CH_RETURN, true));
    const err = view.getUint32(base + CH_ERRNO, true);
    clearDeferredSignalDelivery(view, base);
    Atomics.store(i32, (base + CH_STATUS) / 4, CHANNEL_STATUS_IDLE);
    if (err || result < 0) {
      throw new Error(`dlopen rollback: munmap failed errno=${err || -result}`);
    }
    if (allocation) linkerAllocations.delete(addr);
  };

  const describeMemoryAllocation = (
    address: number,
    size: number,
  ): Readonly<{ mappingAddress: number; mappingSize: number }> => {
    const allocation = linkerAllocations.get(address);
    if (!allocation) {
      throw new Error(
        `dlopen: allocation 0x${address.toString(16)} has no mmap owner`,
      );
    }
    if (
      !Number.isSafeInteger(size) ||
      size <= 0 ||
      address > allocation.rawAddr + allocation.length - size
    ) {
      throw new RangeError("dlopen: logical allocation escapes its mmap owner");
    }
    return {
      mappingAddress: allocation.rawAddr,
      mappingSize: allocation.length,
    };
  };

  const adoptMemoryAllocation = (
    allocation: Readonly<{
      address: number;
      size: number;
      mappingAddress: number;
      mappingSize: number;
    }>,
  ): void => {
    const existing = linkerAllocations.get(allocation.address);
    if (existing) {
      if (
        existing.rawAddr === allocation.mappingAddress &&
        existing.length === allocation.mappingSize
      )
        return;
      throw new Error(
        `dlopen replay: allocation 0x${allocation.address.toString(16)} ` +
          "has conflicting mmap ownership",
      );
    }
    if (
      !Number.isSafeInteger(allocation.mappingAddress) ||
      allocation.mappingAddress <= 0 ||
      !Number.isSafeInteger(allocation.mappingSize) ||
      allocation.mappingSize <= 0 ||
      allocation.address < allocation.mappingAddress ||
      allocation.address + allocation.size >
        allocation.mappingAddress + allocation.mappingSize ||
      allocation.mappingAddress >
        memory.buffer.byteLength - allocation.mappingSize
    ) {
      throw new RangeError("dlopen replay: invalid copied mmap ownership");
    }
    linkerAllocations.set(allocation.address, {
      rawAddr: allocation.mappingAddress,
      length: allocation.mappingSize,
    });
  };

  const forgetMemoryAllocation = (
    allocation: Readonly<{
      address: number;
      mappingAddress: number;
      mappingSize: number;
    }>,
  ): void => {
    const existing = linkerAllocations.get(allocation.address);
    if (!existing) return;
    if (
      existing.rawAddr !== allocation.mappingAddress ||
      existing.length !== allocation.mappingSize
    ) {
      throw new Error(
        `dlopen replay: allocation 0x${allocation.address.toString(16)} ` +
          "changed before peer unload",
      );
    }
    linkerAllocations.delete(allocation.address);
  };

  const readDependencyFile = (path: string): Uint8Array | null => {
    if (path.includes("\0")) {
      throw new Error("dlopen dependency path contains NUL");
    }
    const pathBytes = encoder.encode(`${path}\0`);
    const pathAddr = allocateMemory(pathBytes.length, 1);
    let openResult: { result: number; errno: number } | undefined;
    let pathFailure: unknown;
    try {
      new Uint8Array(memory.buffer, pathAddr, pathBytes.length).set(pathBytes);
      openResult = invokeChannelSyscall(ABI_SYSCALLS.Openat, [
        -100,
        pathAddr,
        0,
        0,
      ]);
    } catch (error) {
      pathFailure = error;
    } finally {
      try {
        deallocateMemory(pathAddr, pathBytes.length);
      } catch (error) {
        pathFailure ??= error;
      }
    }
    if (pathFailure !== undefined) {
      if (openResult && openResult.errno === 0 && openResult.result >= 0) {
        try {
          invokeChannelSyscall(ABI_SYSCALLS.Close, [openResult.result]);
        } catch {
          // Preserve the path-allocation failure.
        }
      }
      throw pathFailure;
    }
    if (!openResult) {
      throw new Error(`dlopen dependency open(${path}) returned no result`);
    }
    if (openResult.errno === 2 || openResult.errno === 20) return null;
    if (openResult.errno || openResult.result < 0) {
      throw new Error(
        `dlopen dependency open(${path}) failed errno=` +
          `${openResult.errno || -openResult.result}`,
      );
    }

    const fd = openResult.result;
    const chunkSize = 64 * 1024;
    const maxBytes = 64 * 1024 * 1024;
    let chunkAddr: number | undefined;
    const chunks: Uint8Array[] = [];
    let total = 0;
    let failure: unknown;
    try {
      chunkAddr = allocateMemory(chunkSize, 16);
      for (;;) {
        const read = invokeChannelSyscall(ABI_SYSCALLS.Read, [
          fd,
          chunkAddr,
          chunkSize,
        ]);
        if (read.errno || read.result < 0) {
          throw new Error(
            `dlopen dependency read(${path}) failed errno=` +
              `${read.errno || -read.result}`,
          );
        }
        if (read.result === 0) break;
        if (read.result > chunkSize) {
          throw new Error(
            `dlopen dependency read(${path}) returned ${read.result} bytes`,
          );
        }
        total += read.result;
        if (total > maxBytes) {
          throw new Error(
            `dlopen dependency ${path} exceeds ${maxBytes} bytes`,
          );
        }
        chunks.push(
          new Uint8Array(new Uint8Array(memory.buffer, chunkAddr, read.result)),
        );
      }
    } catch (error) {
      failure = error;
    } finally {
      try {
        if (chunkAddr !== undefined) {
          deallocateMemory(chunkAddr, chunkSize);
        }
      } catch (error) {
        failure ??= error;
      }
      try {
        const close = invokeChannelSyscall(ABI_SYSCALLS.Close, [fd]);
        if ((close.errno || close.result < 0) && failure === undefined) {
          failure = new Error(
            `dlopen dependency close(${path}) failed errno=` +
              `${close.errno || -close.result}`,
          );
        }
      } catch (error) {
        failure ??= error;
      }
    }
    if (failure !== undefined) throw failure;

    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    return bytes;
  };

  const resolveLibrarySync = (
    dependency: string,
    requester?: string,
  ): Uint8Array | null => {
    const candidates: string[] = [];
    const addCandidate = (candidate: string): void => {
      if (!candidates.includes(candidate)) candidates.push(candidate);
    };
    if (dependency.startsWith("/")) {
      addCandidate(dependency);
    } else {
      const requesterPath =
        requester === undefined
          ? undefined
          : (resolvedLibraryPaths.get(requester) ?? requester);
      const slash = requesterPath?.lastIndexOf("/") ?? -1;
      if (requesterPath && slash >= 0) {
        const directory = slash === 0 ? "/" : requesterPath.slice(0, slash);
        addCandidate(
          directory === "/" ? `/${dependency}` : `${directory}/${dependency}`,
        );
      }
      addCandidate(dependency);
      addCandidate(`/lib/${dependency}`);
      addCandidate(`/usr/lib/${dependency}`);
      addCandidate(`/usr/local/lib/${dependency}`);
    }

    for (const candidate of candidates) {
      const bytes = readDependencyFile(candidate);
      if (bytes === null) continue;
      resolvedLibraryPaths.set(dependency, candidate);
      return bytes;
    }
    return null;
  };

  const getLinker = (): DynamicLinker => {
    if (linker) return linker;
    const table = getTable();
    const sp = getStackPointer();
    if (!table || !sp)
      throw new Error("dlopen: program has no table or stack pointer");

    // Register main program's exported functions and data globals as global
    // symbols so shared libraries can resolve references to libc, libphp, etc.
    // Many libc helpers (e.g. __sigsetjmp_save, __errno_location) are __-
    // prefixed by convention but still need to be visible to side modules.
    // RESERVED names are handled per-module by the dylink env Proxy and must
    // not be shadowed by main exports.
    const RESERVED = new Set([
      "memory",
      "__indirect_function_table",
      "__memory_base",
      "__table_base",
      "__stack_pointer",
      "__c_longjmp",
      "__cpp_exception",
      FORK_UNWIND_TAG_IMPORT_NAME,
    ]);
    const globalSymbols = new Map<string, Function | WebAssembly.Global>();
    const globalSymbolOwners = new Map<string, string | undefined>();
    const inst = getInstance();
    if (inst) {
      for (const [name, exp] of Object.entries(inst.exports)) {
        if (RESERVED.has(name)) continue;
        if (typeof exp === "function" || exp instanceof WebAssembly.Global) {
          globalSymbols.set(name, exp);
          globalSymbolOwners.set(name, undefined);
        }
      }
    }

    // A main-defined/exported tag is the process ABI authority. If the main
    // image instead imports and re-exports the host tag, the identity is the
    // same; if it has no export, retain the process-owned fallback created
    // before main instantiation. Every side module must receive this one
    // canonical identity for cross-module exception propagation.
    const exportedLongjmpTag = inst?.exports.__c_longjmp;
    const canonicalLongjmpTag =
      exportedLongjmpTag === undefined
        ? longjmpTag
        : requireLongjmpTag(exportedLongjmpTag, "main module export");
    const exportedCppExceptionTag = inst?.exports.__cpp_exception;
    const canonicalCppExceptionTag =
      exportedCppExceptionTag === undefined
        ? cppExceptionTag
        : requireCppExceptionTag(exportedCppExceptionTag, "main module export");

    linker = new DynamicLinker({
      memory,
      table,
      stackPointer: sp,
      allocateMemory,
      deallocateMemory,
      describeMemoryAllocation,
      adoptMemoryAllocation,
      forgetMemoryAllocation,
      globalSymbols,
      globalSymbolOwners,
      got: new Map(),
      loadedLibraries,
      resolveLibrarySync,
      longjmpTag: canonicalLongjmpTag,
      cppExceptionTag: canonicalCppExceptionTag,
      forkUnwindTag,
      ptrWidth,
      forkActivationOwner,
      forkActivationOwnerUnavailableReason,
      onTableMutation: (table, firstIndex, length) => {
        onTableMutation?.(table, firstIndex, length);
        tableMutationPending = true;
      },
      routeFunctionImport: hostImportRuntime
        ? (imported, implementation) =>
            hostImportRuntime.routeFunction(imported, implementation)
        : undefined,
    });
    return linker;
  };

  const forkArchive = new DylinkForkArchive(
    memory,
    ptrWidth,
    readArchiveHead,
    writeArchiveHead,
    (size) => ({
      address: allocateMemory(size, 1),
      size,
    }),
    ({ address, size }) => {
      deallocateMemory(address, size, true);
    },
    "process dylink archive",
    {
      read: readGenerationFence,
      write: writeGenerationFence,
    },
  );

  const readForkState = (): DylinkForkState => forkArchive.read();

  const replayDlopens = (
    validatedState?: DylinkForkState,
    options: { readonly memoryOwnership?: "copied" | "borrowed" } = {},
  ): void => {
    const state = validatedState ?? readForkState();
    if (
      state.nextHandle === 2 &&
      state.libraries.length === 0 &&
      linker === null
    )
      return;

    // Materialize only missing modules, then replace the Worker-local handle
    // view. Pthread Workers can call this for every process generation.
    const lk = getLinker();
    try {
      lk.reconcileForkModules(state, options);
      lk.reconcileForkHandleState(state);
    } catch (error) {
      abortLinkerOperation();
      throw error;
    } finally {
      // Replay materializes a publication already owned by the archive; its
      // local table writes are not a new source mutation to republish.
      tableMutationPending = false;
    }
  };

  const resetForkChildLock = (): void => {
    requireOwnedMemory("reset the parent's dynamic-loader lock");
    Atomics.store(archiveLock, 0, 0);
    Atomics.notify(archiveLock, 0);
    const copiedOwner = Atomics.load(loaderOwner, 0);
    if (copiedOwner !== DLOPEN_OWNER_IDLE) {
      // The loader continuation belongs to the one thread that survived fork.
      // Rebind its copied process lease to the child's new Worker coordinate.
      Atomics.store(loaderOwner, 0, workerIdentity);
    }
    Atomics.notify(loaderOwner, 0);
  };

  const readDlopenRequest = (
    bytesPtr: WasmGuestPointer,
    bytesLen: number | bigint,
    namePtr: WasmGuestPointer,
    nameLen: number | bigint,
  ): { readonly name: string; readonly bytes: Uint8Array } => {
    const bytesRange = checkedWasmMemoryRange(
      memory,
      bytesPtr,
      bytesLen,
      ptrWidth,
      "__wasm_dlopen_prepare bytes",
    );
    const nameRange = checkedWasmMemoryRange(
      memory,
      namePtr,
      nameLen,
      ptrWidth,
      "__wasm_dlopen_prepare name",
    );
    const bytes = new Uint8Array(
      memory.buffer,
      bytesRange.offset,
      bytesRange.length,
    );
    const nameBytes = new Uint8Array(
      memory.buffer,
      nameRange.offset,
      nameRange.length,
    );
    // WHY: compilation may grow/detach memory, and Firefox/Chrome reject
    // TextDecoder views backed directly by SharedArrayBuffer.
    return {
      // The first Kandelo dlopen import carried only (bytes, length) and
      // historically keyed the module as `dlopen:<buffer>:<length>`. ABI 43's
      // lowering supplies an empty name range for that exact form.
      name: nameRange.length === 0 && bytesRange.length !== 0
        ? `dlopen:${bytesRange.offset}:${bytesRange.length}`
        : decoder.decode(new Uint8Array(nameBytes)),
      bytes: new Uint8Array(bytes),
    };
  };

  const imports: Record<string, WebAssembly.ExportValue> = {
    __wasm_dlopen_main: (): number => {
      if (!acquireMainDlopenLock()) return 0;
      hostDlopenError = null;
      try {
        return getLinker().dlopenMain();
      } finally {
        releaseMainDlopenLock();
      }
    },

    __wasm_dlopen_prepare: (
      bytesPtr: WasmGuestPointer,
      bytesLen: number | bigint,
      namePtr: WasmGuestPointer,
      nameLen: number | bigint,
      flags: number,
    ): number => {
      if (!acquireMainDlopenLock()) return 0;
      hostDlopenError = null;
      let claimedLoader = false;
      try {
        if (!Number.isInteger(flags)) {
          throw new Error(
            "__wasm_dlopen_prepare requires ABI 43 dlopen flags; rebuild the process",
          );
        }
        if (ownedDlopenTransactions.size === 0) {
          claimLoaderOwnership();
          claimedLoader = true;
        }
        const request = readDlopenRequest(bytesPtr, bytesLen, namePtr, nameLen);
        const transaction = getLinker().beginDlopenSync(
          request.name,
          request.bytes,
          (flags & RTLD_GLOBAL) !== 0,
        );
        if (transaction > 0) {
          ownedDlopenTransactions.add(transaction);
        } else if (claimedLoader) {
          releaseLoaderOwnershipIfIdle();
        }
        return transaction;
      } catch (error) {
        if (claimedLoader) releaseLoaderOwnershipIfIdle();
        abortLinkerOperation();
        throw error;
      } finally {
        releaseMainDlopenLock();
      }
    },

    __wasm_dlopen_next: (
      transaction: number,
      handlePtr?: WasmGuestPointer,
    ): number => {
      if (!acquireMainDlopenLock()) return -1;
      hostDlopenError = null;
      try {
        const linker = getLinker();
        if (
          !ownedDlopenTransactions.has(transaction) &&
          Atomics.load(loaderOwner, 0) === workerIdentity &&
          linker.hasPendingDlopen(transaction)
        ) {
          // A fresh fork child reconstructed this token from the copied
          // archive. Its loader lease was rebound before module replay.
          ownedDlopenTransactions.add(transaction);
        }
        if (handlePtr === undefined) {
          // Transitional standalone callers still use the explicit commit
          // import. ABI-43 libc always supplies the output pointer and takes
          // the atomic finish path below.
          const entry = linker.nextDlopenInitialization(transaction);
          if (entry !== 0) {
            notifyCommit(forkArchive.sync(linker.forkState()));
          }
          if (entry < 0) {
            ownedDlopenTransactions.delete(transaction);
            releaseLoaderOwnershipIfIdle();
          }
          return entry;
        }
        const handleRange = checkedWasmMemoryRange(
          memory,
          handlePtr,
          4,
          ptrWidth,
          "__wasm_dlopen_next handle",
        );
        const { entry, handle } = linker.advanceDlopenSync(transaction);
        new DataView(memory.buffer).setInt32(handleRange.offset, handle, true);
        if (entry > 0) {
          // Publish the exact provisional activation/stage before libc can
          // enter it. A fork from that table call can therefore reconstruct
          // both the fresh side instance and the stopped loader generator.
          notifyCommit(forkArchive.sync(linker.forkState()));
        } else {
          // Completion opens the public handle and removes the private
          // transaction in this same host transition. Rollback likewise
          // removes the issued entry before control returns to Wasm.
          notifyCommit(forkArchive.sync(linker.forkState()));
          ownedDlopenTransactions.delete(transaction);
          releaseLoaderOwnershipIfIdle();
        }
        return entry;
      } catch (error) {
        getLinker().abortDlopenTransaction(transaction, error);
        ownedDlopenTransactions.delete(transaction);
        releaseLoaderOwnershipIfIdle();
        abortLinkerOperation();
        throw error;
      } finally {
        releaseMainDlopenLock();
      }
    },

    __wasm_dlopen_commit: (transaction: number): number => {
      if (!acquireMainDlopenLock()) return 0;
      hostDlopenError = null;
      try {
        const linker = getLinker();
        const handle = linker.commitDlopenSync(transaction);
        notifyCommit(forkArchive.sync(linker.forkState()));
        // WHY: commit deliberately returns zero without destroying a
        // transaction whose initializer is still outstanding. Retaining the
        // process lease keeps another pthread from interleaving loader state
        // if arbitrary Wasm calls this transitional import too early.
        if (!linker.hasPendingDlopen(transaction)) {
          ownedDlopenTransactions.delete(transaction);
          releaseLoaderOwnershipIfIdle();
        }
        return handle;
      } catch (error) {
        getLinker().abortDlopenTransaction(transaction, error);
        ownedDlopenTransactions.delete(transaction);
        releaseLoaderOwnershipIfIdle();
        abortLinkerOperation();
        throw error;
      } finally {
        releaseMainDlopenLock();
      }
    },

    __wasm_dlopen: (
      bytesPtr: WasmGuestPointer,
      bytesLen: number | bigint,
      namePtr: WasmGuestPointer,
      nameLen: number | bigint,
      flags = RTLD_GLOBAL,
    ): number => {
      if (!acquireMainDlopenLock()) return 0;
      hostDlopenError = null;
      let claimedLoader = false;
      try {
        if (!Number.isInteger(flags)) {
          throw new Error("__wasm_dlopen received invalid dlopen flags");
        }
        if (ownedDlopenTransactions.size === 0) {
          claimLoaderOwnership();
          claimedLoader = true;
        }
        const bytesRange = checkedWasmMemoryRange(
          memory,
          bytesPtr,
          bytesLen,
          ptrWidth,
          "__wasm_dlopen bytes",
        );
        const nameRange = checkedWasmMemoryRange(
          memory,
          namePtr,
          nameLen,
          ptrWidth,
          "__wasm_dlopen name",
        );
        // dlopen(NULL, ...) asks for the main program's global symbol scope.
        // No module bytes are involved; return the linker's reserved opaque
        // handle while preserving the existing host-import signature.
        if (bytesRange.length === 0 && nameRange.length === 0) {
          return getLinker().dlopenMain();
        }

        const bytes = new Uint8Array(
          memory.buffer,
          bytesRange.offset,
          bytesRange.length,
        );
        // Copy bytes since memory.buffer may detach during Wasm instantiation
        const bytesCopy = new Uint8Array(bytes);
        // TextDecoder.decode() rejects views backed by SharedArrayBuffer
        // in Firefox (and recent Chrome), so copy the name bytes through
        // a non-shared Uint8Array before decoding. Same shape as
        // bytesCopy above.
        const nameBytesView = new Uint8Array(
          memory.buffer,
          nameRange.offset,
          nameRange.length,
        );
        const nameBytesCopy = new Uint8Array(nameBytesView);
        const name = decoder.decode(nameBytesCopy);
        const lk = getLinker();
        const handle = lk.dlopenSync(
          name,
          bytesCopy,
          undefined,
          (flags & RTLD_GLOBAL) !== 0,
        );
        if (handle > 0) {
          notifyCommit(forkArchive.sync(lk.forkState()));
        } else {
          abortLinkerOperation();
        }
        return handle;
      } catch (error) {
        abortLinkerOperation();
        throw error;
      } finally {
        if (claimedLoader) releaseLoaderOwnershipIfIdle();
        releaseMainDlopenLock();
      }
    },

    __wasm_dlsym: (
      handle: number,
      namePtr: WasmGuestPointer,
      nameLen: number | bigint,
    ): number => {
      if (!acquireMainDlopenLock()) return 0;
      hostDlopenError = null;
      try {
        // See __wasm_dlopen above: copy off the shared buffer before
        // TextDecoder.decode() touches it.
        const nameRange = checkedWasmMemoryRange(
          memory,
          namePtr,
          nameLen,
          ptrWidth,
          "__wasm_dlsym name",
        );
        const nameBytesView = new Uint8Array(
          memory.buffer,
          nameRange.offset,
          nameRange.length,
        );
        const nameBytesCopy = new Uint8Array(nameBytesView);
        const name = decoder.decode(nameBytesCopy);
        const result = getLinker().dlsym(handle, name);
        notifyCommit(undefined);
        return result === null ? 0 : (result as number);
      } catch (error) {
        abortLinkerOperation();
        throw error;
      } finally {
        releaseMainDlopenLock();
      }
    },

    __wasm_dlclose: (handle: number): number => {
      if (!acquireMainDlopenLock()) return -1;
      hostDlopenError = null;
      try {
        const lk = getLinker();
        const result = lk.dlclose(handle);
        if (result === 0) {
          notifyCommit(forkArchive.sync(lk.forkState()));
        } else {
          abortLinkerOperation();
        }
        return result;
      } catch (error) {
        abortLinkerOperation();
        throw error;
      } finally {
        releaseMainDlopenLock();
      }
    },

    __wasm_dlerror: (
      bufPtr: WasmGuestPointer,
      bufMax: number | bigint,
    ): number => {
      const err = hostDlopenError ?? getLinker().dlerror();
      hostDlopenError = null;
      if (!err) return 0;
      const encoded = encoder.encode(err);
      const maxLength = checkedWasmByteLength(bufMax, "__wasm_dlerror buffer");
      const range = checkedWasmMemoryRange(
        memory,
        bufPtr,
        Math.min(encoded.length, maxLength),
        ptrWidth,
        "__wasm_dlerror buffer",
      );
      new Uint8Array(memory.buffer, range.offset, range.length).set(
        encoded.subarray(0, range.length),
      );
      return range.length;
    },
  };

  if (memoryOwnership === "borrowed") {
    // POSIX permits a vfork child to call only exec-family functions or
    // _exit(). Keep every dynamic-loader entry point fail-closed so undefined
    // guest behavior cannot mutate the suspended parent's archive or memory.
    for (const name of Object.keys(imports)) {
      imports[name] = () => {
        throw new Error(
          `borrowed vfork child cannot call ${name} before exec or _exit`,
        );
      };
    }
  }

  return {
    imports,
    readForkState,
    replayDlopens,
    resetForkChildLock,
    archive: forkArchive,
    acquireArchiveWriter,
    releaseArchiveWriter: releaseMainDlopenLock,
    acquireArchiveReader,
    releaseArchiveReader,
    withArchiveWriter,
    withArchiveReader,
    writerOwned: () => mainDlopenDepth > 0,
    setWriterAcquireObserver: (observer) => {
      writerAcquireObserver = observer;
    },
    setOperationAbortObserver: (observer) => {
      operationAbortObserver = observer;
    },
    setCommitObserver: (observer) => {
      commitObserver = observer;
    },
  };
}

/**
 * Reject process artifacts that request a kernel function outside the exact
 * channel-mode CRT contract.
 *
 * WHY: supplying a zero-returning placeholder makes an obsolete or corrupt
 * direct-kernel syscall import look like success. It also cannot safely bridge
 * the process and kernel address spaces. Fail before instantiation so stale
 * artifacts are rebuilt through the supported channel path.
 */
export function assertSupportedKernelFunctionImports(
  module: WebAssembly.Module,
  kernelImports: Record<string, WebAssembly.ExportValue>,
): void {
  for (const imp of wasmModuleImports(module)) {
    if (
      imp.kind === "function"
      && imp.module === "kernel"
      && (
        !Object.hasOwn(kernelImports, imp.name)
        || typeof kernelImports[imp.name] !== "function"
      )
    ) {
      throw new Error(
        `Unsupported kernel import kernel.${imp.name}; `
          + "rebuild this program with the current Kandelo SDK",
      );
    }
  }
}

/**
 * Build the exact import object for a channel-mode Wasm module.
 */
function buildImportObject(
  module: WebAssembly.Module,
  memory: WebAssembly.Memory,
  kernelImports: Record<string, WebAssembly.ExportValue>,
  channelOffset: number,
  dlopenImports?: Record<string, WebAssembly.ExportValue>,
  getInstance?: () => WebAssembly.Instance | undefined,
  ptrWidth: 4 | 8 = 4,
  longjmpTag?: WebAssembly.Tag,
  cppExceptionTag?: WebAssembly.Tag,
  forkUnwindTag?: WebAssembly.Tag,
  postVmInterruptTimer?: (
    timedOutPtr: number,
    vmInterruptPtr: number,
    seconds: number,
  ) => void,
  forkEnvImports?: Record<string, WebAssembly.ImportValue>,
): WebAssembly.Imports {
  assertSupportedKernelFunctionImports(module, kernelImports);

  const envImports: Record<string, WebAssembly.ExportValue> = { memory };
  /** Convert wasm64 BigInt pointer to number (safe since addresses < 4GB) */
  const n = (v: number | bigint): number =>
    typeof v === "bigint" ? Number(v) : v;
  /** Wrap a number as the correct return type for pointer-returning imports */
  const retPtr = (v: number): number | bigint =>
    ptrWidth === 8 ? BigInt(v) : v;

  // Provide __channel_base as a mutable wasm global if the module imports it.
  // Each instance gets its own global, immune to cross-thread shared memory corruption.
  // On wasm64, __channel_base is i64 (BigInt); on wasm32 it's i32 (number).
  const moduleImports = wasmModuleImports(module);
  const importsFunction = (name: string): boolean =>
    moduleImports.some(
      (i) => i.module === "env" && i.name === name && i.kind === "function",
    );
  const linkedFrameImports = WPK_FORK_REQUIRED_IMPORTS.filter(
    ({ module }) => module === "env",
  );
  const linkedFrameImportCount = linkedFrameImports.filter(({ name }) =>
    importsFunction(name),
  ).length;
  if (
    linkedFrameImportCount !== 0 &&
    linkedFrameImportCount !== linkedFrameImports.length
  ) {
    throw new Error(
      "incomplete linked fork instrumentation imports; rebuild the program",
    );
  }
  if (linkedFrameImportCount !== 0) {
    if (!forkEnvImports) {
      throw new Error(
        "linked fork instrumentation requested without continuation and activation-state owners",
      );
    }
    for (const imported of moduleImports) {
      if (
        imported.module !== "env" ||
        !imported.name.startsWith("__wpk_fork_") ||
        (imported.name === FORK_UNWIND_TAG_IMPORT_NAME &&
          (imported.kind as string) === "tag")
      ) {
        continue;
      }
      const value = forkEnvImports[imported.name];
      if (value === undefined) {
        throw new Error(
          `linked fork activation owner is missing env.${imported.name}`,
        );
      }
      if (
        imported.kind !== "function" &&
        imported.kind !== "global" &&
        imported.kind !== "table"
      ) {
        throw new Error(
          `linked fork activation import env.${imported.name} has invalid kind ` +
            `${imported.kind}`,
        );
      }
      envImports[imported.name] = value as WebAssembly.ExportValue;
    }
  }
  if (
    moduleImports.some(
      (i) =>
        i.module === "env" &&
        i.name === "__channel_base" &&
        i.kind === "global",
    )
  ) {
    if (ptrWidth === 8) {
      envImports.__channel_base = new WebAssembly.Global(
        { value: "i64", mutable: true },
        BigInt(channelOffset),
      );
    } else {
      envImports.__channel_base = new WebAssembly.Global(
        { value: "i32", mutable: true },
        channelOffset,
      );
    }
  }

  // LLVM/lld >= 22 import this tag for setjmp users. The process owns its
  // identity so a longjmp thrown through a side module can be caught by the
  // main image (and vice versa).
  if (
    moduleImports.some(
      (i) =>
        i.module === "env" &&
        i.name === "__c_longjmp" &&
        (i.kind as string) === "tag",
    )
  ) {
    envImports.__c_longjmp = requireLongjmpTag(
      longjmpTag,
      "process module",
    ) as unknown as WebAssembly.ExportValue;
  }

  if (
    moduleImports.some(
      (i) =>
        i.module === "env" &&
        i.name === "__cpp_exception" &&
        (i.kind as string) === "tag",
    )
  ) {
    envImports.__cpp_exception = requireCppExceptionTag(
      cppExceptionTag,
      "process module",
    ) as unknown as WebAssembly.ExportValue;
  }
  if (
    moduleImports.some(
      (i) =>
        i.module === FORK_UNWIND_TAG_IMPORT_MODULE &&
        i.name === FORK_UNWIND_TAG_IMPORT_NAME &&
        (i.kind as string) === "tag",
    )
  ) {
    envImports[FORK_UNWIND_TAG_IMPORT_NAME] = requireForkUnwindTag(
      forkUnwindTag,
      "process module",
    ) as unknown as WebAssembly.ExportValue;
  }

  // Add dlopen imports if provided
  if (dlopenImports) {
    Object.assign(envImports, dlopenImports);
  }

  if (
    moduleImports.some(
      (i) =>
        i.module === "env" &&
        i.name === "__wasm_posix_vm_interrupt_after" &&
        i.kind === "function",
    )
  ) {
    if (!postVmInterruptTimer) {
      throw new Error(
        "VM interrupt timer import requested without a host timer route",
      );
    }
    envImports.__wasm_posix_vm_interrupt_after = (
      timedOutPtr: number | bigint,
      vmInterruptPtr: number | bigint,
      seconds: number | bigint,
    ): void => {
      postVmInterruptTimer(n(timedOutPtr), n(vmInterruptPtr), n(seconds));
    };
  }

  // C++ operator new/delete fallbacks — delegate to the wasm instance's malloc/free.
  // Normally resolved by MariaDB's my_new.cc (USE_MYSYS_NEW), but kept as safety net.
  if (getInstance) {
    const cppMalloc = (size: number | bigint): number | bigint => {
      const inst = getInstance();
      const malloc = inst?.exports.malloc as
        ((n: number | bigint) => number | bigint) | undefined;
      if (!malloc) return ptrWidth === 8 ? 0n : 0;
      return malloc(size || (ptrWidth === 8 ? 1n : 1));
    };
    const cppFree = (ptr: number | bigint): void => {
      const inst = getInstance();
      const free = inst?.exports.free as
        ((p: number | bigint) => void) | undefined;
      if (free) free(ptr);
    };
    envImports._Znwm = cppMalloc; // operator new(size_t)
    envImports._Znam = cppMalloc; // operator new[](size_t)
    envImports._ZdlPv = cppFree; // operator delete(void*)
    envImports._ZdlPvm = cppFree; // operator delete(void*, size_t)
    envImports._ZdaPv = cppFree; // operator delete[](void*)
    envImports._ZdaPvm = cppFree; // operator delete[](void*, size_t)
    envImports._ZnwmRKSt9nothrow_t = cppMalloc; // operator new(size_t, nothrow)
    envImports._ZnamRKSt9nothrow_t = cppMalloc; // operator new[](size_t, nothrow)
  }

  // C++ runtime stubs — libc++/libc++abi functions that may be imported when
  // the wasm binary links against empty stub archives.
  // __cxa_guard_acquire/release: thread-safe static initialization.
  // Wasm is single-threaded per instance so no real locking needed.
  envImports.__cxa_guard_acquire = (guardPtr: number | bigint): number => {
    const view = new Uint8Array(memory.buffer);
    if (view[n(guardPtr)]) return 0; // already initialized
    return 1; // needs initialization
  };
  envImports.__cxa_guard_release = (guardPtr: number | bigint): void => {
    const view = new Uint8Array(memory.buffer);
    view[n(guardPtr)] = 1; // mark initialized
  };
  envImports.__cxa_guard_abort = (_guardPtr: number | bigint): void => {
    /* no-op */
  };
  envImports.__cxa_pure_virtual = (): void => {
    throw new Error("pure virtual method called");
  };
  envImports.__cxa_atexit = (): number => 0; // no-op, return success
  envImports.__cxa_thread_atexit = (): number => 0; // no-op, return success

  // libc++ verbose abort — called on internal library errors
  envImports._ZNSt3__122__libcpp_verbose_abortEPKcz = (
    _fmt: number | bigint,
    _args: number | bigint,
  ): void => {
    throw new Error("libc++ verbose abort");
  };

  // libc++ sort — MariaDB doesn't actually call this at runtime
  // (linked from empty stub libc++.a). Signature: sort<less<ull>, ull*>(first, last, comp)
  envImports["_ZNSt3__16__sortIRNS_6__lessIyyEEPyEEvT0_S5_T_"] = (
    _first: number | bigint,
    _last: number | bigint,
    _comp: number | bigint,
  ): void => {
    throw new Error("libc++ sort called unexpectedly");
  };
  const dcTiClassCache = new Map<number, number>(); // typeinfo addr → metaclass (0=leaf, 1=SI, 2=VMI)
  // __dynamic_cast: Itanium C++ ABI dynamic_cast implementation.
  // Reads RTTI from the object's vtable and walks the type hierarchy to
  // check if dst_type is reachable from the object's runtime type.
  // Args: (src_ptr, src_typeinfo*, dst_typeinfo*, src2dst_hint)
  envImports.__dynamic_cast = (
    srcPtr_: number | bigint,
    _srcType: number | bigint,
    dstType_: number | bigint,
    _src2dst: number | bigint,
  ): number | bigint => {
    const srcPtr = n(srcPtr_);
    const dstType = n(dstType_);
    if (srcPtr === 0) return retPtr(0);
    const view = new DataView(memory.buffer);
    const memSize = memory.buffer.byteLength;
    const PS = ptrWidth; // pointer size in bytes
    const readPtr = (addr: number): number =>
      PS === 8
        ? Number(view.getBigUint64(addr, true))
        : view.getUint32(addr, true);
    const readSPtr = (addr: number): number =>
      PS === 8
        ? Number(view.getBigInt64(addr, true))
        : view.getInt32(addr, true);

    // Read vtable pointer from object (Itanium ABI: first word is vtable ptr)
    const vtablePtr = readPtr(srcPtr);
    if (vtablePtr === 0 || vtablePtr >= memSize) return retPtr(0);

    // Itanium ABI vtable layout:
    //   vtable[-PS*2] = offset_to_top (ptrdiff_t)
    //   vtable[-PS]   = RTTI pointer (typeinfo*)
    //   vtable[0]     = first virtual function
    if (vtablePtr < 2 * PS) return retPtr(0);
    const rttiPtr = readPtr(vtablePtr - PS);
    if (rttiPtr === 0 || rttiPtr >= memSize) return retPtr(0);
    const offsetToTop = readSPtr(vtablePtr - 2 * PS);

    // Direct match: runtime type IS the destination type
    if (rttiPtr === dstType) return retPtr(srcPtr + offsetToTop);

    // Walk the type hierarchy from the runtime type, checking if dstType
    // is a base class. typeinfo layout (pointer-sized fields):
    //   [0]      vtable ptr (for the typeinfo meta-class)
    //   [PS]     name ptr (mangled type name)
    //   -- __si_class_type_info adds:
    //   [2*PS]   base typeinfo ptr
    //   -- __vmi_class_type_info adds:
    //   [2*PS]   flags (uint32)
    //   [2*PS+4] base_count (uint32)
    //   [2*PS+8 + i*(PS+4)] base_info[i].base_type (ptr)
    //   [2*PS+8 + i*(PS+4) + PS] base_info[i].offset_flags (long)
    const TI_FIELD2 = 2 * PS; // offset of first field after (vtablePtr, namePtr)
    const BASE_INFO_STRIDE = PS + PS; // base_type(ptr) + offset_flags(long/ptr)

    const tiClassCache = dcTiClassCache;

    const isTypeAncestor = (
      ti: number,
      target: number,
      visited: Set<number>,
    ): boolean => {
      if (ti === target) return true;
      if (ti === 0 || ti >= memSize || visited.has(ti)) return false;
      visited.add(ti);

      if (ti + TI_FIELD2 + PS > memSize) return false;

      const cached = tiClassCache.get(ti);
      if (cached === 0) return false; // leaf
      if (cached === 1) {
        // SI: field at TI_FIELD2 is base typeinfo ptr
        const basePtr = readPtr(ti + TI_FIELD2);
        return isTypeAncestor(basePtr, target, visited);
      }
      if (cached === 2) {
        // VMI: flags(u32) + base_count(u32) then base_info array
        const baseCount = view.getUint32(ti + TI_FIELD2 + 4, true);
        for (let i = 0; i < baseCount; i++) {
          const baseType = readPtr(ti + TI_FIELD2 + 8 + i * BASE_INFO_STRIDE);
          if (baseType > 0 && isTypeAncestor(baseType, target, visited))
            return true;
        }
        return false;
      }

      // Not cached — classify by trying SI first, then VMI
      const field2 = readPtr(ti + TI_FIELD2);

      // Try SI: field2 is a pointer to another typeinfo
      if (field2 > 0x100 && field2 + PS <= memSize) {
        const possibleTiName = readPtr(field2 + PS);
        if (possibleTiName > 0 && possibleTiName < memSize) {
          tiClassCache.set(ti, 1);
          if (isTypeAncestor(field2, target, visited)) return true;
          tiClassCache.delete(ti);
        }
      }

      // Try VMI: field at TI_FIELD2 is flags (u32, 0-3), [TI_FIELD2+4] is base_count
      const flags32 = view.getUint32(ti + TI_FIELD2, true);
      if (flags32 <= 3 && ti + TI_FIELD2 + 8 <= memSize) {
        const baseCount = view.getUint32(ti + TI_FIELD2 + 4, true);
        if (
          baseCount > 0 &&
          baseCount < 100 &&
          ti + TI_FIELD2 + 8 + baseCount * BASE_INFO_STRIDE <= memSize
        ) {
          tiClassCache.set(ti, 2);
          for (let i = 0; i < baseCount; i++) {
            const baseType = readPtr(ti + TI_FIELD2 + 8 + i * BASE_INFO_STRIDE);
            if (baseType > 0 && isTypeAncestor(baseType, target, visited))
              return true;
          }
          return false;
        }
      }

      tiClassCache.set(ti, 0);
      return false;
    };

    if (isTypeAncestor(rttiPtr, dstType, new Set())) {
      return retPtr(srcPtr + offsetToTop);
    }
    return retPtr(0);
  };

  // libc++ sort specialization — sort uint64 array in-place
  envImports["_ZNSt3__16__sortIRNS_6__lessIyyEEPyEEvT0_S5_T_"] = (
    begin_: number | bigint,
    end_: number | bigint,
  ): void => {
    const begin = n(begin_),
      end = n(end_);
    const view = new DataView(memory.buffer);
    const count = (end - begin) / 8;
    const arr: bigint[] = [];
    for (let i = 0; i < count; i++)
      arr.push(view.getBigUint64(begin + i * 8, true));
    arr.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    for (let i = 0; i < count; i++)
      view.setBigUint64(begin + i * 8, arr[i], true);
  };

  // Environment integrations fail at the point of use when the host does not
  // implement them. Kernel imports were validated above and are never faked.
  for (const imp of wasmModuleImports(module)) {
    if (imp.kind !== "function") continue;
    if (imp.module === "env") {
      if (!Object.hasOwn(envImports, imp.name)) {
        envImports[imp.name] = (..._args: unknown[]) => {
          throw new Error(`Unimplemented import: env.${imp.name}`);
        };
      }
    }
  }

  const importObject: WebAssembly.Imports = { env: envImports };
  if (Object.keys(kernelImports).length > 0) {
    importObject.kernel = kernelImports;
  }
  return importObject;
}

/** Legacy control-page geometry retained as the per-channel anchor location. */
const FORK_BUF_SIZE = FORK_SAVE_BUFFER_SIZE;

/**
 * Detect a legacy contiguous fork-save-buffer overrun after unwind.
 *
 * Linked continuations do not use this check. It remains exported for
 * stale-buffer regression coverage. Legacy instrumentation keeps
 * `current_pos` — the pointer-width integer at the
 * base of the save buffer (`forkBufAddr + 0`) — seeded to the absolute address
 * `forkBufAddr + frames_start_offset` and advanced by every saved frame. After
 * unwind it is therefore the high-water linear-memory address written (see
 * crates/fork-instrument/src/runtime.rs, `emit_unwind_begin`). Main-process and
 * pthread buffers sit below their syscall channels; fork-capable side modules
 * use independent allocations. The explicit `forkBufSize` keeps the same
 * bounds check truthful for either placement. Frames grow upward, away from
 * the header, so the base word holding `current_pos` stays readable here.
 *
 * The instrumented unwind carries no bounds check of its own — runtime.rs
 * documents the requirement `frames_start_offset + Σframe ≤ buffer_size` but
 * never enforces it. Without this host check the overrun is silent: it
 * corrupts the channel and only surfaces later as an unexplained trap or a
 * fork child that never makes progress. Returns the overrun in bytes, or 0
 * when the save fit within the buffer.
 */
export function forkSaveBufferOverrun(
  memory: WebAssembly.Memory,
  forkBufAddr: number,
  ptrWidth: 4 | 8,
  forkBufSize: number,
): number {
  const view = new DataView(memory.buffer);
  const currentPos =
    ptrWidth === 8
      ? Number(view.getBigUint64(forkBufAddr, true))
      : view.getUint32(forkBufAddr, true);
  const bufferEnd = forkBufAddr + forkBufSize;
  return currentPos > bufferEnd ? currentPos - bufferEnd : 0;
}

// Host-private control slots below the process main channel's fork buffer.
// Fork's memcpy carries the parent's dlopen archive into the child intact;
// the child walks it to replay each module before wpk_fork rewind. These are
// intentionally not relative to a pthread's rewind buffer.
const DLOPEN_HEAD_OFFSET_WASM32 = 12;
const DLOPEN_HEAD_OFFSET_WASM64 = 24;
// Atomic host-private reader/writer arbitration between process-main dlopen
// and pthread fork. A negative value is the exclusive main-worker dlopen
// writer; a positive value counts concurrent pthread forks from their
// pre-unwind archive check through memory-copy/SYS_FORK and parent rewind.
// This preserves Kandelo's existing concurrent-pthread-fork behavior while
// preventing a new archive entry from racing any fork snapshot. A fork child
// clears its copied value before replay because its memory is independent.
const DLOPEN_LOCK_OFFSET_WASM32 = 20;
const DLOPEN_LOCK_OFFSET_WASM64 = 40;
// Positive identity of the Worker whose ordinary Wasm stack owns every live
// staged loader transaction. Unlike the short archive writer, this lease spans
// guest bootstrap/relocation/constructor calls. Same-owner fork is legal;
// another pthread must wait because its child cannot inherit the owner's stack.
const DLOPEN_OWNER_OFFSET_WASM32 = 24;
const DLOPEN_OWNER_OFFSET_WASM64 = 36;
// One fixed, naturally aligned u64 fence lets instrumented Wasm detect a
// newer process table snapshot without crossing into JavaScript on the steady
// state path. The archive header remains the authoritative validated value.
const DLOPEN_GENERATION_OFFSET_WASM32 = 32;
const DLOPEN_GENERATION_OFFSET_WASM64 = 48;
const DLOPEN_MAX_CONTROL_OFFSET = Math.max(
  DLOPEN_HEAD_OFFSET_WASM32,
  DLOPEN_HEAD_OFFSET_WASM64,
  DLOPEN_LOCK_OFFSET_WASM32,
  DLOPEN_LOCK_OFFSET_WASM64,
  DLOPEN_OWNER_OFFSET_WASM32,
  DLOPEN_OWNER_OFFSET_WASM64,
  DLOPEN_GENERATION_OFFSET_WASM32,
  DLOPEN_GENERATION_OFFSET_WASM64,
);
if (
  FORK_BUF_SIZE % 16 !== 0 ||
  FORK_SAVE_CONTROL_PREFIX_SIZE + FORK_BUF_SIZE !== WASM_PAGE_SIZE ||
  DLOPEN_MAX_CONTROL_OFFSET > FORK_SAVE_CONTROL_PREFIX_SIZE
) {
  throw new Error("invalid fork-save scratch-page geometry");
}
const DLOPEN_LOCK_IDLE = 0;
const DLOPEN_LOCK_WRITER = -1;
const DLOPEN_LOCK_MAX_READERS = 0x7fff_ffff;
const DLOPEN_OWNER_IDLE = 0;
const RTLD_GLOBAL = 0x100;
const WPK_FORK_EXPORTS = WPK_FORK_REQUIRED_EXPORTS.map(({ name }) => name);

interface ProcessTableReplicationOwner extends ForkActivationTableReplication {
  /** Bring this Worker to the latest complete process generation. */
  reconcileNow(): number;
  /** Check the archive fence while the caller already excludes writers. */
  isCurrentUnderLock(): boolean;
  /** Release any mutation writer depths unwound by a Wasm trap. */
  abortActiveMutations(): void;
}

function createProcessTableReplicationOwner(options: {
  readonly generationAddress: number;
  readonly registry: ForkActivationRegistry;
  /**
   * Module-composed peer-table snapshot lifecycle (Path-A A3/A4). Owns the full
   * table checkpoint capture/restore through the co-resident fork module; the
   * `registry` above is retained only for the funcref-only patch fast path
   * (`captureFuncrefTablePatch` / `applyFuncrefTablePatch`), which never touched
   * the reference engine.
   */
  readonly tableSnapshot: ForkTableSnapshot;
  readonly dlopen: DlopenSupport;
  readonly newArena: () => ForkModuleStateArena;
  readonly materializeModules: (snapshot: DylinkForkArchiveSnapshot) => void;
  readonly restoreSnapshots: boolean;
  /**
   * The vfork parent holds the archive reader from capture until its parked
   * fork syscall returns, so the borrowed child's already-materialized
   * snapshot cannot change. Generation guards may observe that local
   * generation without mutating the parent's reader/writer lock words.
   */
  readonly borrowedImmutableSnapshot?: boolean;
  readonly label: string;
}): ProcessTableReplicationOwner {
  const generationAddress = new WebAssembly.Global(
    { value: "i64", mutable: false },
    BigInt(options.generationAddress),
  );
  let deferredPublication = false;
  let replicaMaterializing = false;
  let suppressInitialSnapshotRestore = !options.restoreSnapshots;
  const mutationContexts: Array<{ readonly deferPublication: boolean }> = [];

  const releaseArena = (root: number): void => {
    if (root === 0) return;
    const arena = options.newArena();
    arena.attach(root);
    arena.release();
  };
  const replica = new DylinkForkTableReplica(
    options.dlopen.archive,
    (snapshot, previousGeneration) => {
      options.materializeModules(snapshot);
      if (suppressInitialSnapshotRestore) {
        // WHY: a fork child restores the exact capture-time table graph from
        // its normal KFMS arena after all activations exist. The archive
        // generation is still adopted now; only this first redundant restore
        // is suppressed. Later pthread/process mutations must be applied.
        suppressInitialSnapshotRestore = false;
        return;
      }
      let patchFloor = previousGeneration;
      if (
        snapshot.tableStateRoot !== 0 &&
        snapshot.tableCheckpointGeneration > previousGeneration
      ) {
        const arena = options.newArena();
        arena.attach(snapshot.tableStateRoot);
        options.tableSnapshot.restore(arena);
        // The archive, not this temporary validated view, owns the mappings.
        patchFloor = snapshot.tableCheckpointGeneration;
      }
      for (const patch of snapshot.tablePatches) {
        if (patch.generation! > patchFloor) {
          options.registry.applyFuncrefTablePatch(patch);
        }
      }
    },
    `${options.label}: table replica`,
  );
  if (options.borrowedImmutableSnapshot) {
    // Capture holds the parent's process-archive reader until the parked
    // syscall returns. Adopt the exact immutable generation the child has
    // already materialized so side-module guards report truthful state
    // without attempting to mutate either archive lock word.
    replica.adoptPublishedGeneration(options.dlopen.archive.generation());
  }

  const reconcileLocked = (): number => {
    replicaMaterializing = true;
    try {
      const suppressingInitialRestore = suppressInitialSnapshotRestore;
      const changed = replica.reconcile();
      if (suppressingInitialRestore && !changed) {
        // A child whose copied process has never published a dylink/table
        // archive still completed its one startup reconciliation. Do not
        // suppress the first real peer mutation published later.
        suppressInitialSnapshotRestore = false;
      }
      return replica.generation();
    } finally {
      replicaMaterializing = false;
      // Module constructors and loader table writes performed while applying
      // a validated archive snapshot are effects of that publication, not a
      // new mutation authored by this Worker.
      deferredPublication = false;
    }
  };

  const publishLocked = (): DylinkForkArchiveSnapshot => {
    const arena = options.newArena();
    arena.begin();
    let root: number;
    try {
      root = options.tableSnapshot.capture(arena);
    } catch (error) {
      if (arena.hasActiveArena()) arena.release();
      throw error;
    }
    let publication;
    try {
      publication = options.dlopen.archive.publishTableState(root);
    } catch (error) {
      arena.release();
      throw error;
    }
    replica.adoptPublishedGeneration(publication.snapshot.generation);
    if (
      publication.previousTableStateRoot !== 0 &&
      publication.previousTableStateRoot !== root
    ) {
      releaseArena(publication.previousTableStateRoot);
    }
    deferredPublication = false;
    return publication.snapshot;
  };

  options.dlopen.setCommitObserver(
    (linkerPublication, tableMutationCommitted) => {
      if (linkerPublication) {
        replica.adoptPublishedGeneration(linkerPublication.generation);
      }
      const hasPriorGuestOverlay =
        linkerPublication?.tableStateRoot !== undefined &&
        (linkerPublication.tableStateRoot !== 0 ||
          linkerPublication.tablePatches.length !== 0);
      // Loader-owned table entries are already deterministic module recipes in
      // the dylink archive. Until a guest/dlsym overlay exists, publishing the
      // same entries again as a typed KFMS snapshot would turn ordinary dlopen
      // into an O(table closure) operation. Once an overlay exists, a module-set
      // change still needs a fresh exact activation manifest.
      if (
        deferredPublication ||
        (!linkerPublication && tableMutationCommitted) ||
        hasPriorGuestOverlay
      ) {
        publishLocked();
      }
    },
  );
  options.dlopen.setWriterAcquireObserver(() => {
    // Called with exclusive process ownership. Reconcile before any linker or
    // guest mutation reads this Worker's instance-local table so the protected
    // operation cannot overwrite a newer peer publication.
    reconcileLocked();
  });

  const reconcileNow = (): number =>
    options.borrowedImmutableSnapshot
      ? replica.generation()
      : options.dlopen.withArchiveWriter(reconcileLocked);
  const abortActiveMutations = (): void => {
    while (mutationContexts.length > 0) {
      mutationContexts.pop();
      options.dlopen.releaseArchiveWriter();
    }
    deferredPublication = false;
  };
  options.dlopen.setOperationAbortObserver(abortActiveMutations);

  return {
    generationAddress,
    beginMutation: (): bigint => {
      const deferPublication = options.dlopen.writerOwned();
      options.dlopen.acquireArchiveWriter();
      mutationContexts.push({ deferPublication });
      return BigInt(replica.generation());
    },
    reconcile: (): bigint => BigInt(reconcileNow()),
    commit: (activationId, ownerId, firstIndex, length): void => {
      const context = mutationContexts.pop();
      if (!context) {
        throw new Error(
          `${options.label}: table mutation committed without ownership`,
        );
      }
      try {
        // Dlopen/start mutations occur before the module manifest and handle
        // graph are publishable. The enclosing linker transaction snapshots
        // once at its commit. Replica materialization is already represented
        // by the generation being applied and must not echo a publication.
        if (context.deferPublication) {
          if (!replicaMaterializing) deferredPublication = true;
        } else {
          const patch = options.registry.captureFuncrefTablePatch(
            activationId,
            ownerId,
            firstIndex,
            length,
          );
          if (
            patch !== null &&
            options.dlopen.archive.canPublishTablePatch(patch)
          ) {
            const publication = options.dlopen.archive.publishTablePatch(patch);
            replica.adoptPublishedGeneration(publication.snapshot.generation);
          } else {
            // Typed/opaque entries stay on the Wasm codec path. The same full
            // checkpoint transparently compacts a bounded patch journal; no
            // table shape or mutation is rejected at either threshold.
            publishLocked();
          }
        }
      } finally {
        options.dlopen.releaseArchiveWriter();
      }
    },
    abort: (): void => {
      const context = mutationContexts.pop();
      if (!context) {
        throw new Error(
          `${options.label}: table mutation aborted without ownership`,
        );
      }
      options.dlopen.releaseArchiveWriter();
    },
    reconcileNow,
    isCurrentUnderLock: () =>
      replica.generation() === options.dlopen.archive.generation(),
    abortActiveMutations,
  };
}

/** @internal Exact publication-lifecycle seam; not re-exported by the host API. */
export function __testCreateProcessTableReplicationOwner(
  options: unknown,
): unknown {
  return createProcessTableReplicationOwner(
    options as Parameters<typeof createProcessTableReplicationOwner>[0],
  );
}

function hasCompleteForkInstrumentation(
  module: WebAssembly.Module,
  pid: number,
): boolean {
  const moduleExports = wasmModuleExports(module);
  const exportNames = new Set(moduleExports.map((e) => e.name));
  const legacyAsyncifyExports = [...exportNames].filter((name) =>
    name.startsWith("asyncify_"),
  );
  if (legacyAsyncifyExports.length > 0) {
    throw new Error(
      `pid=${pid}: user program exports legacy Asyncify instrumentation ` +
        `(${legacyAsyncifyExports.join(", ")}). This host requires ` +
        "wasm-fork-instrument artifacts exporting wpk_fork_*; rebuild the package for the current ABI.",
    );
  }

  const presentWpkExports = WPK_FORK_EXPORTS.filter((name) =>
    exportNames.has(name),
  );
  if (
    presentWpkExports.length > 0 &&
    presentWpkExports.length !== WPK_FORK_EXPORTS.length
  ) {
    const missing = WPK_FORK_EXPORTS.filter((name) => !exportNames.has(name));
    throw new Error(
      `pid=${pid}: incomplete wasm-fork-instrument exports; missing ${missing.join(", ")}. ` +
        "Rebuild the package for the current ABI.",
    );
  }

  const complete = presentWpkExports.length === WPK_FORK_EXPORTS.length;
  if (complete) {
    const claim = readForkInstrumentCapabilityClaim(module);
    if (
      !claim.present ||
      (claim.flags & WPK_FORK_CAP_ACTIVATION_STATE_SAFE) === 0
    ) {
      throw new Error(
        `pid=${pid}: wasm-fork-instrument artifact lacks the required ` +
          "activation-state-safe capability; rebuild it for ABI 43.",
      );
    }
  }
  return complete;
}

/**
 * Verify that a user program was built against an ABI compatible with the
 * running kernel.
 *
 * Three outcomes:
 *   - Program exports `__abi_version` matching the kernel: silent pass.
 *   - Program exports `__abi_version` with a different value: hard error.
 *     A known mismatch is always worse than silent misbehavior — we would
 *     rather refuse to run.
 *   - Program doesn't export `__abi_version` at all: warn and continue.
 *     This is for rolling out the marker: legacy binaries built before
 *     channel_syscall.c gained the export don't have it. Once all
 *     published binaries carry the marker, this path can be flipped to
 *     a hard error — see docs/abi-versioning.md.
 *
 * Reads the marker directly from the Wasm bytes instead of calling the
 * `__abi_version` export. LLVM/lld may wrap exported functions with
 * `__wasm_call_ctors`; invoking the export here would run C++ constructors
 * before `_start`, which breaks runtimes such as SpiderMonkey.
 */
function verifyProgramAbi(
  programBytes: ArrayBuffer,
  expected: number | undefined,
  pid: number,
): void {
  if (expected === undefined) {
    // Older host driver didn't populate the field — skip silently.
    // Will be removed once all callers are updated.
    return;
  }
  const actual = extractAbiVersion(programBytes);
  if (actual === null) {
    if (!abiMissingWarned) {
      abiMissingWarned = true;
      console.warn(
        `[worker] pid=${pid}: user program lacks __abi_version export — ` +
          "legacy binary predates ABI marker rollout. Rebuild against the " +
          "current glue (channel_syscall.c) to pick up the check. " +
          "See docs/abi-versioning.md.",
      );
    }
    return;
  }
  if (actual !== expected) {
    throw new Error(
      `pid=${pid}: ABI version mismatch — kernel advertises ${expected}, ` +
        `user program built against ${actual}. Rebuild the program against the ` +
        "current kernel, or roll back the kernel to the matching version. " +
        "See docs/abi-versioning.md.",
    );
  }
}

/** Warn once per worker process, not once per program load. */
let abiMissingWarned = false;

/**
 * Main process worker entry point.
 */
export async function centralizedWorkerMain(
  port: MessagePort,
  initData: CentralizedWorkerInitMessage,
): Promise<void> {
  let processHostImportRuntime: ForkHostImportWorkerRuntime | null = null;
  try {
    const { memory, programBytes, channelOffset, pid } = initData;
    const ptrWidth = initData.ptrWidth ?? 4;
    const artifactFailures = describeWasmArtifactPolicyFailures(programBytes, {
      expectedAbi: initData.kernelAbiVersion,
      expectedAbiContractDigest: initData.kernelAbiContractDigest,
    });
    if (artifactFailures.length > 0) {
      throw new Error(
        `pid=${pid}: refusing unsafe program artifact before execution: ` +
          artifactFailures.join("; "),
      );
    }
    // Use pre-compiled module if provided (avoids recompilation in workers)
    const module = initData.programModule
      ? initData.programModule
      : await WebAssembly.compile(programBytes);
    registerWasmModuleReflection(module, programBytes);
    // --- WASI module detection and handling ---
    if (isWasiModule(module)) {
      if (wasiModuleDefinesMemory(module)) {
        throw new Error(
          "WASI module defines its own memory. Only modules that import memory " +
            "(compiled with --import-memory) are supported.",
        );
      }

      // Lazy-import the heavy shim only when we actually have a WASI
      // module to host. Native channel-syscall workers (the common
      // case) skip this import entirely.
      const { WasiShim, WasiExit } = await import("./wasi-shim");

      const wasiShim = new WasiShim(
        memory,
        channelOffset,
        initData.argv || [],
        initData.env || [],
      );
      const wasiImports = wasiShim.getImports();

      // Build import object: provide wasi_snapshot_preview1 namespace + env.memory
      const importObject: WebAssembly.Imports = {
        wasi_snapshot_preview1: wasiImports as Record<
          string,
          WebAssembly.ExportValue
        >,
        env: { memory },
      };

      // Stub any additional env imports the module needs
      const moduleImports = wasmModuleImports(module);
      for (const imp of moduleImports) {
        if (imp.module === "env" && imp.name !== "memory") {
          if (!(importObject.env as Record<string, unknown>)[imp.name]) {
            (importObject.env as Record<string, unknown>)[imp.name] =
              imp.kind === "function"
                ? (..._args: unknown[]) => {
                    throw new Error(
                      `Unimplemented WASI env import: ${imp.name}`,
                    );
                  }
                : undefined;
          }
        }
      }

      const instance = await WebAssembly.instantiate(module, importObject);

      // Initialize preopened directories
      wasiShim.init();

      // Signal ready
      port.postMessage({ type: "ready", pid } satisfies WorkerToHostMessage);

      // Run _start
      let exitCode = 0;
      try {
        const start = instance.exports._start as (() => void) | undefined;
        if (start) start();
      } catch (e) {
        if (e instanceof WasiExit) {
          exitCode = e.code;
        } else {
          throw e;
        }
      }

      port.postMessage({
        type: "exit",
        pid,
        status: exitCode,
      } satisfies WorkerToHostMessage);
      return;
    }

    // --- SDK module path (existing) ---
    const processLongjmpTag = createLongjmpTag(ptrWidth);
    const processCppExceptionTag = createCppExceptionTag(ptrWidth);
    const processForkUnwindTag = createForkUnwindTag();
    let kernelExitStatus: number | null = null;
    const kernelImports = buildKernelImports(
      memory,
      channelOffset,
      ptrWidth,
      initData.argv || [],
      initData.env || [],
      initData.secureExec,
      (status) => {
        kernelExitStatus = status;
      },
    );

    // Check if the module has complete wpk_fork_* instrumentation exports,
    // and reject stale legacy fork artifacts before they can run.
    const hasForkInstrumentation = hasCompleteForkInstrumentation(module, pid);
    const forkCapabilityClaim = readForkInstrumentCapabilityClaim(module);
    const hasDylinkForkRole = forkInstrumentRoleAvailable(
      forkCapabilityClaim,
      FORK_CAP_DYLINK_MAIN,
    );
    // Fork state — captured by kernel_fork closure
    let forkResult = 0;
    let forkMode: ProcessForkMode = initData.isForkChild
      ? (processForkMode(initData.forkMode ?? -1) ?? (() => {
          throw new Error(`pid=${pid}: fork child is missing a valid fork mode`);
        })())
      : PROCESS_FORK_MODE_FORK;
    let forkBufAddr = initData.forkBufAddr ?? 0;
    const forkMemoryOwnership = initData.isForkChild
      ? (initData.forkMemoryOwnership ?? "copied")
      : "copied";
    const borrowedForkChild = forkMemoryOwnership === "borrowed";
    if (borrowedForkChild && forkMode !== PROCESS_FORK_MODE_VFORK) {
      throw new Error(`pid=${pid}: only a vfork child may borrow process memory`);
    }
    if (
      borrowedForkChild
      && !wasmModuleImports(module).some(
        (entry) =>
          entry.module === "env"
          && entry.name === "__channel_base"
          && entry.kind === "global",
      )
    ) {
      throw new Error(
        `pid=${pid}: borrowed vfork requires imported env.__channel_base`,
      );
    }
    const requiredBorrowedNumber = (
      value: number | undefined,
      name: string,
      allowZero = false,
    ): number => {
      if (
        !Number.isSafeInteger(value)
        || value === undefined
        || (allowZero ? value < 0 : value <= 0)
      ) {
        throw new Error(`pid=${pid}: borrowed vfork has invalid ${name}`);
      }
      return value;
    };
    const dlopenArchiveControlAddr = borrowedForkChild
      ? requiredBorrowedNumber(
          initData.forkOwnerControlAddr,
          "owner control address",
        )
      : channelOffset - FORK_BUF_SIZE;
    const borrowedWorkspace = borrowedForkChild
      ? new BorrowedVforkWorkspace(
          memory,
          ptrWidth,
          {
            prefixAddress: requiredBorrowedNumber(
              initData.forkPrivatePrefixAddr,
              "private prefix address",
            ),
            prefixBytes: requiredBorrowedNumber(
              initData.forkPrivatePrefixBytes,
              "private prefix bytes",
            ),
            scratchAddress: requiredBorrowedNumber(
              initData.forkScratchAddr,
              "scratch address",
            ),
            scratchBytes: requiredBorrowedNumber(
              initData.forkScratchBytes,
              "scratch bytes",
              true,
            ),
          },
          `pid=${pid}: borrowed vfork workspace`,
        )
      : null;
    if (borrowedForkChild) {
      // A vfork child may not create another pthread owner before exec. Keep
      // the request off its channel entirely; Rust's Process marker remains a
      // second defense for malformed or direct host traffic.
      kernelImports.kernel_clone = () => -STARTUP_EAGAIN;
    }

    if (hasForkInstrumentation) {
      const linkedFrameFormat = readLinkedFrameFormat(module);
      const moduleStateFormat = readForkModuleStateDescriptor(module);
      if (moduleStateFormat.ptrWidth !== linkedFrameFormat.ptrWidth) {
        throw new Error(
          `pid=${pid}: module-state pointer width ${moduleStateFormat.ptrWidth} ` +
            `does not match linked frames ${linkedFrameFormat.ptrWidth}`,
        );
      }
      // Phase 6 D5: eagerly instantiate the co-resident `fork-module` once, at
      // process init, behind `initData.forkModuleEnabled`. It is placed into a
      // host-reserved region of the shared memory (via the same channel
      // `continuationMmap` the fork arena uses), so its static/BSS/stack never
      // collide with live guest data. Assert exports loudly here, never mid-fork.
      // For a QUALIFYING fork (see the predicate below) step 4b/5 then flips the
      // guest's five frame/resume imports to this instance and routes the
      // coordinator through it. Flag-off is byte-identical: this whole branch is
      // skipped, no region is reserved, and no import is flipped.
      let forkModuleInstance: ForkModuleInstance | null = null;
      // The process worker's single Wasm-GC transit table (STORE #2). It is the
      // SAME object the guest publishes struct/array/i31 identities into (bound to
      // every activation's `__wpk_fork_ref_gc_transit` import via the registry
      // below) AND the object the co-resident fork-module's injected
      // `fm_drive_execute` reads back after each ALLOC step, so the drive's
      // post-allocate integrity check sees what the guest published. On flag-on
      // this WRAPS the fork-module's own exported table (assigned below, once the
      // module exists) so all three parties — guest import, module export, and
      // this host seam — share one object; on flag-off (no fork-module) it mints
      // its own table, exactly as before.
      let forkGcTransit: ForkAnyrefTransitTable;
      // Phase 6 D6.2: the real engine-floor `wpk_fork_host.*` seam backing (the
      // externref side table + broker token materialization). Null when the
      // fork-module is not instantiated (flag-off / borrowed child).
      let forkModuleHostCapabilities: ForkModuleHostCapabilities | null = null;
      // Phase 6 D5 step 4b/5: when the fork qualifies, this backend drives the
      // continuation through the co-resident module and the coordinator takes
      // its module-backed branches. Null (non-qualifying / flag-off) => the
      // byte-identical JavaScript continuation.
      let forkModuleBackend: ForkModuleContinuationBackend | null = null;
      // Phase 6 D7a.1a: per-activation frame trampolines for a dlopen fork. Each
      // dlopen'd side activation's five frozen frame/resume imports are flipped
      // to its own trampoline (wasm->wasm), folding in the activation id so its
      // frames route to its own writer/driver in the shared module. Null unless
      // the module-backed path is active.
      let forkModuleTrampolines: ForkModuleTrampolines | null = null;
      let useForkModule = false;
      // Phase 6 item 4: a borrowed (vfork) child instantiates its OWN fork-module
      // at a distinct `__memory_base` by channel-mmapping a fresh region on
      // demand. Captured here so the child releases it (channel-munmap) the moment
      // its single replay finishes, instead of leaking ~5.4 MiB into the parked
      // parent's restored address space (the kernel never shrinks memory —
      // reclamation is free-list reuse, so an un-munmap'd region persists).
      let forkModuleBorrowedRegion: { base: number; bytes: number } | null = null;
      // Phase 6 D6.1: true only for a CHILD fork whose decoded reference graph is
      // FUNCREF + NULL only (no externref/gc/exnref/static-root to reconstruct).
      // Gates flipping the guest's `__wpk_fork_ref_decode_funcref` import to the
      // module AND seeding the module's reference graph on the child. Stays false
      // for the parent (its guest was instantiated at parent init, before any
      // fork transaction existed) and for any fork with a non-funcref reference,
      // so those keep the byte-identical JS reference path.
      let moduleReferenceKindsSupported = false;
      // The child worker's externref token cache (broker handle -> canonical
      // worker-local token). Created BEFORE the fork-module so the D6.2
      // engine-floor seam can close over it; also owned by the JS reference path
      // (the still-JS `__wpk_fork_ref_decode_externref` materializes the SAME
      // idempotent token, so the module and JS agree on identity).
      if (
        initData.forkHostImports === undefined ||
        initData.externrefGenerationId === undefined
      ) {
        throw new Error(
          `pid=${pid}: ABI 43 fork artifact requires its process owner ` +
            "host-import mailbox and externref generation",
        );
      }
      const externrefTokens = new ForkExternrefTokenCache(
        initData.externrefGenerationId,
      );
      // Phase 6 item 4: a vfork/borrowed child now ALSO instantiates the
      // co-resident module, so its ONE continuation replay runs through the
      // module (wasm->wasm) instead of the JS engine. The original gate skipped
      // the borrowed child on two grounds: (1) it execs almost immediately, so a
      // module was "pointless overhead" — but it still has one real replay to
      // drive, which is exactly what item 4 moves onto the module; and (2) it
      // "must not reserve or own a co-resident region" in the parked parent's
      // shared memory — the real invariant. We honor (2) with an ON-DEMAND
      // region: `instantiateForkModule` channel-mmaps a FRESH, kernel-allocated,
      // guaranteed-non-overlapping ~5.4 MiB region (it cannot alias the parent's
      // live data), and the child channel-munmaps it the moment its replay
      // finishes (see `forkModuleBorrowedRegion` release after `finishReplay`) so
      // nothing is durably owned in the parent's restored address space. A
      // FOLLOW-UP (see ITEMS-4-7-PLAN.md) makes even the parent's instantiation
      // lazy until first fork so a worker that never forks pays nothing.
      {
        // The co-resident fork-module is the UNCONDITIONAL fork reconstructor +
        // capturer: there is no kill switch and no JS reference engine behind it,
        // so every fork-instrumented worker MUST receive it. A missing module
        // fails loud rather than silently dropping to a deleted JS path.
        const forkModuleModule = initData.forkModuleModule;
        if (!forkModuleModule) {
          throw new Error(
            `pid=${pid}: fork-instrumented worker requires the co-resident ` +
              "fork module",
          );
        }
        if (ptrWidth !== linkedFrameFormat.ptrWidth) {
          throw new Error(
            `pid=${pid}: fork-module width mismatch: process ptrWidth ` +
              `${ptrWidth} vs linked frames ${linkedFrameFormat.ptrWidth}`,
          );
        }
        // M2: the single REAL `env.resolve_externref(handle) -> externref`
        // import body backing the module's externref reconstruction. It
        // closes over this worker's externref token cache so
        // `resolve_externref` re-roots the SAME canonical token the still-JS
        // `__wpk_fork_ref_decode_externref` returns (identity parity;
        // `ForkExternrefTokenCache.materialize` is idempotent). The FIVE old
        // `wpk_fork_host` externref/transit imports (`host_begin_generation`,
        // the 2-arg `host_resolve_externref`, `host_transit_publish`,
        // `host_transit_read`, `host_release_generation`) are gone from the
        // rebuilt module (M2 t1-t4): the injected binder now performs the
        // decode + anyref-transit `table.set` itself
        // (`__wpk_fork_ref_decode_externref` export, flipped in below), so
        // this host seam no longer routes through `activationRegistry`'s
        // early-GC transit at all.
        forkModuleHostCapabilities = createForkModuleHostCapabilities({
          tokens: externrefTokens,
        });
        // A COPIED fork child INHERITS the parent's co-resident fork-module
        // region through its full memory clone (the region is present both in
        // the inherited bytes and in the inherited kernel mapping table). It
        // MUST reuse that exact base instead of reserving a fresh one: a fresh
        // `mmap` would allocate a SECOND module region on top of the inherited
        // one (the inherited region's base is already mapped, so first-fit skips
        // it and grows the memory), double-counting ~88 pages and inflating the
        // child's observable `memory.size` — which breaks the fork memory-clone
        // invariant (a forked child must observe the parent's EXACT size). The
        // kernel host passes the parent's base via `forkModuleInheritedBase`
        // (see `handleOrdinaryFork`). A borrowed (vfork) child is excluded: it
        // does not clone memory and reserves its own on-demand region that it
        // munmaps after replay, so it never inherits a durable base.
        const inheritForkModuleRegion =
          initData.isForkChild === true &&
          !borrowedForkChild &&
          initData.forkModuleInheritedBase !== undefined;
        const inheritedForkModuleBase = initData.forkModuleInheritedBase;
        forkModuleInstance = instantiateForkModule({
          module: forkModuleModule,
          memory,
          ptrWidth,
          reserve: (size) => {
            if (inheritForkModuleRegion) {
              // Reuse the inherited region rather than mmapping a fresh one. The
              // size is deterministic (same module) so a mismatch against the
              // parent's reserved byte length is a fork-plumbing bug, not a
              // resource condition — fail loud instead of silently re-reserving.
              if (
                initData.forkModuleInheritedBytes !== undefined &&
                initData.forkModuleInheritedBytes !== size
              ) {
                throw new Error(
                  `pid=${pid}: inherited fork-module region size ` +
                    `${initData.forkModuleInheritedBytes} does not match this ` +
                    `worker's computed size ${size}`,
                );
              }
              return inheritedForkModuleBase!;
            }
            return continuationMmap(
              memory,
              channelOffset,
              size,
              `pid=${pid}: fork-module`,
            );
          },
          label: `pid=${pid}: fork-module`,
          resolveExternref: forkModuleHostCapabilities.imports.resolve_externref,
        });
        // Publish this worker's co-resident fork-module region so the kernel
        // host can hand a COPIED fork child the SAME base to reuse (above). A
        // borrowed (vfork) child's region is temporary (munmapped after replay),
        // so it is never reported as an inheritable base.
        if (!borrowedForkChild) {
          port.postMessage({
            type: "fork_module_region",
            pid,
            base: forkModuleInstance.memoryBase,
            bytes: forkModuleInstance.regionBytes,
          } satisfies WorkerToHostMessage);
        }
        // STORE #2: wrap the fork-module's OWN exported transit table so the
        // registry binds the guest's `__wpk_fork_ref_gc_transit` import (and this
        // host's `host_transit_publish`/`host_transit_read` seam) to the exact
        // same table the module's drive integrity check reads after each ALLOC
        // step. Before this, a distinct table was minted here and handed to the
        // registry while the module used its own — a mismatch on flag-on.
        forkGcTransit = new ForkAnyrefTransitTable(forkModuleInstance.gcTransitTable);
        if (borrowedForkChild) {
          // Remember the ON-DEMAND region so the child releases it when its one
          // borrowed replay finishes (channel-munmap; see after `finishReplay`).
          forkModuleBorrowedRegion = {
            base: forkModuleInstance.memoryBase,
            bytes: forkModuleInstance.regionBytes,
          };
        }

        // Phase 3 (rust-first fork point-of-no-return): the co-resident module
        // is the UNCONDITIONAL reconstructor + capturer, so it backs EVERY fork
        // on this worker path. The three former `useForkModule=false` fallbacks
        // that silently dropped to the byte-identical JS continuation twin are
        // now closed; the only reason a fork does not go through the module is a
        // genuine impossibility, which FAILS LOUD (never silent JS):
        //  - Case 1 (pointer width): the CORRECT-width module is instantiated on
        //    demand per guest (`forkModuleInitFields(ptrWidth)` in the kernel
        //    worker entries selects `fork_module32` vs `fork_module64`), and a
        //    genuine width mismatch already threw above. No fallback remains.
        //  - Case 2 (resume catalog > cap): raised to hold every real guest's
        //    catalog (php-fpm/node were the only programs past the old 16384
        //    cap). The cap is a module-BSS structure, enforced loudly by the
        //    backend constructor below; a catalog past the (raised) cap is a
        //    fail-loud module-capacity boundary, not a JS fallback.
        //  - Case 3 (fork-from-thread child): its module replay path needs the
        //    guest's `wpk_fork_resume_thread` export, which fork-instrument emits
        //    for any guest exporting `__indirect_function_table` — i.e. every
        //    pthread-capable (hence fork-from-thread-capable) guest. A thread
        //    child missing it is a stale / mis-instrumented artifact; fail loud
        //    so it is rebuilt through the current fork-instrument path.
        // Single-activation admission is UNCHANGED (Phase 6 D7a.1a): a dlopen
        // fork's side activations seed their OWN resume catalogs through the
        // module, and multi-activation REFERENCES still take the JS reference
        // path via `moduleReferenceKindsSupported` (gated below). Single-thread
        // and not-vfork hold by construction here: this is the main process
        // worker path (the pthread coordinator is separate) and a borrowed vfork
        // child is admitted like any other (item 4).
        const catalogOrdinals = readForkResumeCatalog(module).map(
          (entry) => entry.functionOrdinal,
        );
        const isForkFromThreadChild =
          initData.isForkChild === true &&
          initData.forkChildThreadFnPtr != null;
        // Use the exact-bytes reflection registered above (line ~3310) rather
        // than WebAssembly.Module.exports(module) directly: WebKit throws
        // "unable to produce export descriptors for the given module" when the
        // engine cannot describe an ABI 44 fork artifact's export types as
        // descriptors, which blocked all fork on WebKit. wasmModuleExports()
        // returns the ordered descriptors Kandelo already parsed and validated
        // from the program bytes, matching every other reflection site here.
        const hasResumeThreadExport = wasmModuleExports(module).some(
          (entry) => entry.name === "wpk_fork_resume_thread",
        );
        // Case 3 fail-loud (see the block comment above): a fork-from-thread
        // child without the module resume export is a stale/mis-instrumented
        // artifact, not a routine fallback.
        if (isForkFromThreadChild && !hasResumeThreadExport) {
          throw new Error(
            `pid=${pid}: fork-from-thread child is missing the ` +
              "`wpk_fork_resume_thread` module resume export; rebuild the " +
              "program through the current fork-instrument path",
          );
        }
        useForkModule = true;
        // Phase 6 item 4: a borrowed (vfork) child is admitted like any other —
        // single-activation via `beginBorrowedChildReplay`, and multi-activation
        // dlopen-vfork ("mode-1") via `addActivationBorrowedChildReplay`. The
        // coordinator's `attachBorrowedModuleChild` handles both.
        if (useForkModule) {
          // Stage the backend's small pre-fork guest buffers into the dedicated
          // slab reserved inside the fork-module region rather than mmapping a
          // fresh, memory-growing region per staging. The slab is part of the
          // single reused region, so a COPIED fork child (which reuses the whole
          // region via `forkModuleInheritedBase`) stages into the SAME slab and
          // its `memory.size` stays equal to the parent's — a growing channel
          // mmap here would land at the child's inherited (higher) mmap cursor
          // and inflate the clone. A staging request larger than the slab (a
          // large GC codec) falls back to the growing channel mmap; that path
          // never asserts an exact memory size, so its growth is invisible.
          const forkModuleStagingBase = forkModuleInstance.stagingBase;
          const forkModuleStagingBytes = forkModuleInstance.stagingBytes;
          forkModuleBackend = new ForkModuleContinuationBackend({
            exports: forkModuleInstance.exports,
            // The coarse `parentReplay`/`parentAbort` entries drive each
            // activation's guest begin export through this table (host binds the
            // ref-typed slots; the module `call_indirect`s them).
            driveTable: forkModuleInstance.driveTable,
            memory,
            ptrWidth,
            format: linkedFrameFormat,
            catalogOrdinals,
            // Option B: the module channel-mmaps its per-fork frame chunks + the
            // journal image on demand via `SYS_mmap` → the kernel `find_gap`
            // allocator (dynamic, kernel-tracked placement — no fork-depth cap
            // and no carved-out guest region). `channelBase` also backs the
            // small pre-fork catalog scratch and GC-codec staging.
            channelBase: channelOffset,
            reserveRegion: (size) =>
              size <= forkModuleStagingBytes
                ? forkModuleStagingBase
                : continuationMmap(
                    memory,
                    channelOffset,
                    size,
                    `pid=${pid}: fork-module catalog scratch`,
                  ),
            releaseRegion: (addr, size) => {
              if (addr === forkModuleStagingBase) return;
              continuationMunmap(
                memory,
                channelOffset,
                addr,
                size,
                `pid=${pid}: fork-module catalog scratch`,
              );
            },
            pid,
            label: `pid=${pid}: fork-module`,
          });
          // Seed the linked-frame format + full resume catalog once, now, before
          // any fork drives the module. Both are host-known custom sections.
          forkModuleBackend.setup();
          // Per-activation frame trampolines share this one module instance.
          forkModuleTrampolines = new ForkModuleTrampolines(
            forkModuleInstance.exports,
          );
        }
      }
      // Phase 6 item 3a (minimize host surface): the RESTORE data-feed FLIP. When
      // a child's whole reference graph is admitted through the module
      // (`moduleReferenceKindsSupported`), the guest's typed-GC/exnref codec reads
      // the decoded reference graph (vector entries, GC/exnref routes, scalar +
      // edge loads, exnref cache indices) through the module's seven `fm_ref_*`
      // exports instead of the JS reference provider (`referenceReplay`). The
      // still-JS drive-order (`materializeTypedGraph`) is UNCHANGED — it now calls
      // the guest `_gc_allocate`/`_gc_fill` exports, which call back into these
      // module exports (module->guest->module; safe because the feed only READS
      // the immutable decoded graph and WRITES guest memory). Flipped alongside
      // `__wpk_fork_ref_decode_funcref`, per-activation (every activation's codec
      // reads the SAME whole-graph module feed), and only when the whole graph is
      // admitted; a flag-off / non-admitted fork keeps the byte-identical JS
      // reference path (this returns `{}`, leaving the JS provider imports intact).
      const moduleReferenceFeedFlip = (): Record<
        string,
        WebAssembly.ImportValue
      > =>
        moduleReferenceKindsSupported && forkModuleInstance
          ? {
              __wpk_fork_ref_vector_get:
                forkModuleInstance.exports.fm_ref_vector_get,
              __wpk_fork_ref_gc_route:
                forkModuleInstance.exports.fm_ref_gc_route,
              __wpk_fork_ref_gc_payload_len:
                forkModuleInstance.exports.fm_ref_gc_payload_len,
              __wpk_fork_ref_gc_load: forkModuleInstance.exports.fm_ref_gc_load,
              __wpk_fork_ref_exn_route:
                forkModuleInstance.exports.fm_ref_exn_route,
              __wpk_fork_ref_exn_load:
                forkModuleInstance.exports.fm_ref_exn_load,
              __wpk_fork_ref_exn_cache_index:
                forkModuleInstance.exports.fm_ref_exn_cache_index,
            }
          : {};
      const mainTemplateId = await computeForkModuleTemplateId(programBytes);
      // The co-resident Rust module owns all frame/journal/resume storage
      // (Phase 4 point of no return); the coordinator only needs the format.
      const forkContinuation: ForkActivationContinuation = {
        format: linkedFrameFormat,
      };
      let processInstance: WebAssembly.Instance | null = null;

      const newModuleStateArena = (): ForkModuleStateArena =>
        new ForkModuleStateArena(
          memory,
          ptrWidth,
          (size) => {
            if (borrowedForkChild) {
              throw new Error(
                `pid=${pid}: borrowed child cannot allocate module state`,
              );
            }
            return continuationMmap(
              memory,
              channelOffset,
              size,
              `pid=${pid}: module state`,
            );
          },
          (addr, size) => {
            if (borrowedForkChild) {
              throw new Error(
                `pid=${pid}: borrowed child cannot release parent module state`,
              );
            }
            continuationMunmap(
              memory,
              channelOffset,
              addr,
              size,
              `pid=${pid}: module state`,
            );
          },
          `pid=${pid}`,
        );

      processHostImportRuntime = new ForkHostImportWorkerRuntime(
        initData.forkHostImports,
        pid,
        initData.externrefGenerationId,
        externrefTokens,
        (wake) => {
          port.postMessage({
            type: "fork_host_import",
            wake,
          } satisfies WorkerToHostMessage);
        },
      );
      const externrefRecipes = new ForkExternrefTokenRecipeProvider(
        externrefTokens,
        (value) =>
          processHostImportRuntime!.localExceptions.normalizeUnclaimedForkValue(
            value,
          ),
      );
      const activationRegistry = new ForkActivationRegistry(
        memory,
        externrefRecipes,
        `pid=${pid}: fork activations`,
        (size) => borrowedWorkspace
          ? borrowedWorkspace.allocateScratch(size)
          : continuationMmap(
              memory,
              channelOffset,
              size,
              `pid=${pid}: reference scratch`,
            ),
        (addr, size) => {
          if (borrowedWorkspace) {
            borrowedWorkspace.deallocateScratch(addr, size);
            return;
          }
          continuationMunmap(
            memory,
            channelOffset,
            addr,
            size,
            `pid=${pid}: reference scratch`,
          );
        },
        // Bind the guest's transit table to the SAME object the fork-module reads.
        forkGcTransit,
      );
      // Every process instance, including a freshly reconstructed child, owns
      // the provenance manifest for any fork it may issue later.
      const importedStateCapture = new ForkImportedGlobalCapture(
        `pid=${pid}: imported activation state`,
      );
      let importedStatePlanner: ForkImportedGlobalPlanner | null = null;
      let earlyChildReferences: ForkEarlyChildReferenceProvider | null = null;
      let decodedChildReferences: DecodedSegmentedForkReferenceTransaction | null =
        null;
      let childDylinkState: DylinkForkState | null = null;
      // Phase 6 item 3c: the raw KFGC (`kandelo.wpk_fork.gc_codec`) section bytes
      // per activation and the host-exception owner, captured in the child's
      // pre-instantiation planning block (where the compiled activation `modules`
      // are in scope) so the later instantiation/attach block can seed the
      // co-resident fork-module's typed-GC drive planner. Null until a fork child
      // computes them.
      let childGcCodecBytes: Map<number, Uint8Array> | null = null;
      let childHostExceptionOwner = 0xffff_ffff;
      const referenceReplay = (): ProcessReferenceReplayImports =>
        earlyChildReferences ?? activationRegistry.currentReferences();
      const processContinuation = new ForkProcessContinuationCoordinator(
        memory,
        activationRegistry,
        `pid=${pid}: process continuation`,
      );
      if (forkModuleBackend) {
        // Route this worker's next fork through the co-resident module. The
        // coordinator's module-backed branches then own the journal/frames/
        // resume slots; every non-qualifying fork stays on the JS path. A dlopen
        // fork also evicts a side activation's trampoline when it unregisters.
        const trampolines = forkModuleTrampolines;
        processContinuation.enableModuleBacking(
          forkModuleBackend,
          trampolines ? (id) => trampolines.evict(id) : undefined,
        );
      }
      // Path B P3: route this worker's next fork's reference CAPTURE through the
      // co-resident module's shared builder (the module is the SOLE capture
      // graph). The parent reads its own vectors back from the resident builder
      // (`fm_capture_vector_get`) during its post-fork replay; leaf values still
      // come from `capturedValues` / the transit table (originals), so the
      // parent's live-reference identity is preserved. Non-module forks (flag
      // off) keep the JS capture graph.
      if (forkModuleInstance) {
        activationRegistry.setCaptureModule(
          new ForkReferenceCaptureModule(
            forkModuleInstance.exports,
            memory,
            `pid=${pid}: fork reference capture module`,
          ),
        );
      }
      let processDlopenSupport: DlopenSupport | null = null;
      let processForkArchiveReaderHeld = false;
      const tableGenerationOffset =
        ptrWidth === 8
          ? DLOPEN_GENERATION_OFFSET_WASM64
          : DLOPEN_GENERATION_OFFSET_WASM32;
      const tableGenerationAddress =
        dlopenArchiveControlAddr - tableGenerationOffset;
      let processTableReplication: ProcessTableReplicationOwner | null = null;
      const tableReplicationImports: ForkActivationTableReplication = {
        generationAddress: new WebAssembly.Global(
          { value: "i64", mutable: false },
          BigInt(tableGenerationAddress),
        ),
        reconcile: (): bigint => processTableReplication?.reconcile() ?? 0n,
        beginMutation: (): bigint =>
          processTableReplication?.beginMutation() ?? 0n,
        commit: (activationId, ownerId, firstIndex, length): void => {
          processTableReplication?.commit(
            activationId,
            ownerId,
            firstIndex,
            length,
          );
        },
        abort: (): void => {
          processTableReplication?.abort();
        },
      };
      const exceptionBroker = new ForkExceptionBroker(
        activationRegistry,
        `pid=${pid}: exception broker`,
        () => earlyChildReferences ?? activationRegistry.currentReferences(),
        (value) =>
          processHostImportRuntime!.localExceptions.normalizeUnclaimedForkException(
            value,
          ),
      );
      let mainExceptionProvider: ForkExceptionProvider | null = null;
      const registerChildReferenceActivation = (
        activationId: number,
        activationModule: WebAssembly.Module,
        registration: ForkActivationRegistration,
        typedReferenceProvider: ForkGcCodecProvider,
      ): void => {
        const early = earlyChildReferences;
        if (!early) {
          throw new Error(
            `pid=${pid}: child activation ${activationId} registered ` +
              "outside early reference reconstruction",
          );
        }
        if (
          registration.activationId !== activationId ||
          typedReferenceProvider.activationId !== activationId
        ) {
          throw new Error(
            `pid=${pid}: child activation ${activationId} provider coordinate mismatch`,
          );
        }
        // Parse against this exact compiled module before publishing any
        // provider. ForkEarlyChildReferenceProvider compares the resulting
        // descriptor to the pre-instantiation declaration.
        readForkGcCodecDescriptor(activationModule);
        // WHY: these catalogs contain fresh-instance identities. Register the
        // activation only after the full registry has harvested static roots,
        // but before a later module's immutable import getter can request one.
        early.registerActivation({
          activationId,
          functions: {
            decode(ordinal) {
              if (
                !Number.isInteger(ordinal) ||
                ordinal < 0 ||
                ordinal >= registration.functionCatalog.length
              ) {
                throw new RangeError(
                  `pid=${pid}: function recipe ${activationId}:` +
                    `${String(ordinal)} is out of bounds`,
                );
              }
              const value = registration.functionCatalog.get(ordinal);
              if (typeof value !== "function") {
                throw new TypeError(
                  `pid=${pid}: function recipe ${activationId}:${ordinal} ` +
                    "did not resolve to a function",
                );
              }
              return value as CallableFunction;
            },
          },
          staticRoots: {
            decode: (ordinal) =>
              activationRegistry.decodeStaticRoot(activationId, ordinal),
          },
          typed: typedReferenceProvider,
          exceptions: registration.exceptionProvider,
        });
      };

      const readProcessLaunchRoot = (): number => {
        if (borrowedForkChild) return forkBufAddr;
        const view = new DataView(memory.buffer);
        return ptrWidth === 8
          ? Number(view.getBigUint64(dlopenArchiveControlAddr, true))
          : view.getUint32(dlopenArchiveControlAddr, true);
      };
      let inheritedLaunchRoot = 0;
      let childArena: ForkModuleStateArena | null = null;
      if (initData.isForkChild) {
        if (
          !borrowedForkChild &&
          initData.forkChildThreadFnPtr !== undefined &&
          initData.forkBufAddr !== undefined
        ) {
          // A pthread continuation is rooted in the caller's channel page,
          // not the process-main anchor copied into the child. Publish the
          // kernel-validated launch root under activation zero before any
          // child reconstruction recipe is inspected.
          writeForkContinuationAnchor(
            memory,
            dlopenArchiveControlAddr,
            ptrWidth,
            initData.forkBufAddr,
          );
        }
        inheritedLaunchRoot = readProcessLaunchRoot();
        if (
          initData.forkBufAddr !== undefined &&
          inheritedLaunchRoot !== initData.forkBufAddr
        ) {
          throw new Error(
            `pid=${pid}: inherited process launch root ${inheritedLaunchRoot} ` +
              `does not match launch root ${initData.forkBufAddr}`,
          );
        }
        if (
          !Number.isSafeInteger(inheritedLaunchRoot)
          || inheritedLaunchRoot <= 0
        ) {
          throw new Error(
            `pid=${pid}: fork child has no inherited process launch root`,
          );
        }
        const moduleStateRoot = readForkModuleStateRoot(
          memory,
          inheritedLaunchRoot,
          ptrWidth,
        );
        // A COW child never allocates module state here (it `attach`es the
        // inherited arena the parent channel-mmap'd), so this arena's allocator
        // is unused on the child; it only provides the release/attach surface.
        childArena = newModuleStateArena();
        const arenaRoot = ptrWidth === 8
          ? BigInt(moduleStateRoot)
          : moduleStateRoot;
        if (borrowedForkChild) childArena.attachBorrowed(arenaRoot);
        else childArena.attach(arenaRoot);
      }
      processContinuation.prepareActivation({
        activationId: 0,
        continuation: forkContinuation,
        ...(borrowedForkChild
          ? {}
          : {
              publishProcessLaunchRoot: (address: number) => {
                // WHY: this copied control-page word is the fresh child's
                // route to the main activation. No JavaScript closure
                // survives fork. A borrowed vfork child receives no writer
                // because this word still belongs to its suspended parent.
                writeForkContinuationAnchor(
                  memory,
                  dlopenArchiveControlAddr,
                  ptrWidth,
                  address,
                );
                forkBufAddr = address;
              },
            }),
        readProcessLaunchRoot,
      });

      const releaseProcessForkArchiveReader = (): void => {
        if (!processForkArchiveReaderHeld) return;
        processForkArchiveReaderHeld = false;
        processDlopenSupport?.releaseArchiveReader();
      };
      const acquireCurrentProcessForkArchiveReader = (): void => {
        if (!processDlopenSupport || !processTableReplication) {
          throw new Error(`pid=${pid}: fork archive owner is not initialized`);
        }
        for (;;) {
          processTableReplication.reconcileNow();
          processDlopenSupport.acquireArchiveReader();
          processForkArchiveReaderHeld = true;
          if (processTableReplication.isCurrentUnderLock()) return;
          releaseProcessForkArchiveReader();
        }
      };

      kernelImports.kernel_fork = (rawMode: number): number => {
        if (!processInstance) return -38; // ENOSYS
        const mode = processForkMode(rawMode);
        if (mode === null) return -STARTUP_EINVAL;

        const phase = processContinuation.phaseName();
        if (phase === "parent-replay" || phase === "child-replay") {
          if (mode !== forkMode) {
            throw new Error(
              `pid=${pid}: fork replay mode ${mode} does not match captured mode ${forkMode}`,
            );
          }
          try {
            processContinuation.finishReplay();
          } finally {
            releaseProcessForkArchiveReader();
          }
          // Phase 6 item 4: the borrowed (vfork) child's ONE replay is done, so
          // release its on-demand fork-module region NOW (channel-munmap), before
          // the child proceeds to exec/_exit. Leaving it mapped would leak
          // ~5.4 MiB into the parked parent's restored shared address space (the
          // kernel never shrinks memory). The parent instead keeps its region for
          // the worker's lifetime (fork is repeated); only the transient borrowed
          // child releases. Idempotent: cleared so a later path never double-frees.
          if (borrowedForkChild && forkModuleBorrowedRegion) {
            const region = forkModuleBorrowedRegion;
            forkModuleBorrowedRegion = null;
            continuationMunmap(
              memory,
              channelOffset,
              region.base,
              region.bytes,
              `pid=${pid}: borrowed fork-module region`,
            );
          }
          if (initData.isForkChild) {
            const gate = initData.forkReplayGate;
            if (!gate) {
              throw new Error(
                `pid=${pid}: fork child is missing its replay commit gate`,
              );
            }
            // Every outer activation has already restored its frame before
            // descending to this import. Reaching here is therefore the exact
            // point at which the host may commit the fresh child.
            port.postMessage({
              type: "fork_replay_ready",
              pid,
            } satisfies WorkerToHostMessage);
            waitForForkReplayCommit(gate, `pid=${pid}`);
          }
          return forkResult;
        }
        if (phase === "abort-replay") {
          if (mode !== forkMode) {
            throw new Error(
              `pid=${pid}: fork abort mode ${mode} does not match captured mode ${forkMode}`,
            );
          }
          const errno = processContinuation.abortErrno();
          try {
            processContinuation.finishAbortReplay();
          } finally {
            releaseProcessForkArchiveReader();
          }
          return -errno;
        }
        if (phase !== "idle") {
          throw new Error(
            `pid=${pid}: fork import reached while process continuation is ${phase}`,
          );
        }
        if (borrowedForkChild) return -STARTUP_EAGAIN;
        forkMode = mode;

        // The arena and every activation prefix are allocated before any user
        // frame commits. If this fails, fork returns errno with no partially
        // published activation graph.
        acquireCurrentProcessForkArchiveReader();
        const arena = newModuleStateArena();
        try {
          arena.begin();
          processContinuation.beginCapture(arena);
          importedStateCapture?.appendTo(arena);
        } catch (error) {
          if (processContinuation.phaseName() !== "idle") {
            try {
              processContinuation.abort();
            } catch {
              // Preserve the capture failure; abort has already made the
              // transaction unreachable before attempting cleanup.
            }
          } else if (arena.hasActiveArena()) {
            arena.release();
          }
          releaseProcessForkArchiveReader();
          forkBufAddr = 0;
          if (error instanceof ContinuationAllocationError) return -error.errno;
          throw error;
        }
        return 0; // ignored during unwind
      };

      const dylinkForkActivationOwner = hasDylinkForkRole
        ? createProcessDylinkActivationOwner({
            memory,
            ptrWidth,
            channelOffset,
            forkUnwindTag: processForkUnwindTag,
            coordinator: processContinuation,
            registry: activationRegistry,
            exceptionBroker,
            importedStateCapture,
            tableReplication: tableReplicationImports,
            importedStatePlanner: initData.isForkChild
              ? () => importedStatePlanner
              : undefined,
            referenceReplay,
            registerChildReferenceActivation: initData.isForkChild
              ? registerChildReferenceActivation
              : undefined,
            isForkChild: Boolean(initData.isForkChild),
            invokeProcessFork: () => {
              const fork = processInstance?.exports.fork;
              if (typeof fork !== "function") {
                throw new Error(
                  `pid=${pid}: dylink fork role is missing the main libc fork export`,
                );
              }
              return Number((fork as () => number)());
            },
            forkModuleFrameFlip:
              useForkModule && forkModuleBackend && forkModuleTrampolines
                ? {
                    trampolines: forkModuleTrampolines,
                    backend: forkModuleBackend,
                  }
                : undefined,
            // Phase 6 D7a.1b: resolved lazily per side-module instantiation,
            // AFTER `moduleReferenceKindsSupported` is computed for this child.
            // When the whole reference graph is admitted, every side activation's
            // funcref decode flips to the ONE shared module export (correct for
            // all activations because the merged catalog is activation-namespaced).
            forkModuleReferenceFlip: forkModuleInstance
              ? (): Record<string, WebAssembly.ImportValue> =>
                  moduleReferenceKindsSupported
                    ? {
                        __wpk_fork_ref_decode_funcref:
                          forkModuleInstance.exports
                            .__wpk_fork_ref_decode_funcref,
                        // M2: mirror the funcref flip for externref decode —
                        // every side activation's codec reads the SAME
                        // whole-graph module export (activation-namespaced by
                        // recipe coordinate, not per instance).
                        __wpk_fork_ref_decode_externref:
                          forkModuleInstance.exports
                            .__wpk_fork_ref_decode_externref,
                        // Phase 6 item 3a: each dlopen'd side activation's guest
                        // codec also reads the RESTORE data-feed through the SAME
                        // whole-graph module exports (the feed is activation-
                        // namespaced by recipe coordinate, not per instance).
                        ...moduleReferenceFeedFlip(),
                      }
                    : {}
              : undefined,
            label: `pid=${pid}: dylink activations`,
          })
        : undefined;

      // Build import object and instantiate
      const dlopenSupport = buildDlopenImports(
        memory,
        channelOffset,
        dlopenArchiveControlAddr,
        () =>
          processInstance?.exports.__indirect_function_table as
            WebAssembly.Table | undefined,
        () =>
          processInstance?.exports.__stack_pointer as
            WebAssembly.Global | undefined,
        () => processInstance ?? undefined,
        ptrWidth,
        processLongjmpTag,
        processCppExceptionTag,
        dylinkForkActivationOwner,
        hasDylinkForkRole
          ? undefined
          : `pid=${pid}: main artifact lacks the dylink fork role capability`,
        processForkUnwindTag,
        (table, firstIndex, length) => {
          activationRegistry.markTableMutation(table, firstIndex, length);
        },
        processHostImportRuntime,
        pid,
        forkMemoryOwnership,
      );
      processDlopenSupport = dlopenSupport;
      processTableReplication = createProcessTableReplicationOwner({
        generationAddress: tableGenerationAddress,
        registry: activationRegistry,
        tableSnapshot: new ForkTableSnapshot(
          activationRegistry,
          forkModuleBackend,
          `pid=${pid}: peer table snapshot`,
        ),
        dlopen: dlopenSupport,
        newArena: newModuleStateArena,
        materializeModules: (snapshot) => {
          dlopenSupport.replayDlopens(snapshot, {
            memoryOwnership: forkMemoryOwnership,
          });
        },
        // The inherited fork arena restores a child process's complete
        // global/table/reference graph and preserves aliases with live frames.
        // The process table journal is for separately instantiated pthread
        // Workers and later generations, not a second initial child restore.
        restoreSnapshots: !initData.isForkChild,
        borrowedImmutableSnapshot: borrowedForkChild,
        label: `pid=${pid}`,
      });
      if (initData.isForkChild) {
        if (!childArena) {
          throw new Error(
            `pid=${pid}: fork child lost its validated module-state arena`,
          );
        }
        if (!borrowedForkChild) {
          // A parent can be copied while the archive mutex word names its
          // now-nonexistent Worker. The validated archive bytes are immutable
          // for this child launch, so clear that private lock before creating
          // any loader state. A borrower must leave the parent's lock intact.
          dlopenSupport.resetForkChildLock();
        }
        childDylinkState = dlopenSupport.readForkState();
        const records = childArena.recordViews();
        decodedChildReferences = decodeSegmentedForkReferenceTransaction(
          records,
          FORK_REFERENCE_TRANSACTION_OWNER_ID,
        );
        const modules = new Map<number, WebAssembly.Module>([[0, module]]);
        for (const library of childDylinkState.libraries) {
          if (library.activationId === undefined) continue;
          if (modules.has(library.activationId)) {
            throw new Error(
              `pid=${pid}: archived activation ${library.activationId} ` +
                "is duplicated or aliases the main activation",
            );
          }
          const activationModule = new WebAssembly.Module(
            library.moduleBytes as unknown as BufferSource,
          );
          registerWasmModuleReflection(
            activationModule,
            library.moduleBytes,
          );
          modules.set(library.activationId, activationModule);
        }
        const declarations = [...modules]
          .sort(([left], [right]) => left - right)
          .map(([activationId, activationModule]) => ({
            activationId,
            gcDescriptor: readForkGcCodecDescriptor(activationModule),
            exceptionDescriptor:
              readForkExceptionCodecDescriptor(activationModule),
          }));
        // Phase 6 item 3c: capture each activation's raw KFGC section bytes and
        // the host-exception owner HERE, where the compiled `modules` (and their
        // custom sections) are in scope, so the later instantiation/attach block
        // can seed the co-resident fork-module's drive planner. The
        // host-exception owner is the smallest activation that declared an
        // exception codec descriptor — the JS `directOwner` for a host exnref —
        // or 0xffff_ffff (the JS `null`) if none did.
        const gcCodecBytes = new Map<number, Uint8Array>();
        for (const [activationId, activationModule] of modules) {
          const sections = WebAssembly.Module.customSections(
            activationModule,
            WPK_FORK_GC_CODEC_SECTION,
          );
          if (sections.length !== 1) {
            throw new Error(
              `pid=${pid}: activation ${activationId} has ${sections.length} ` +
                "GC codec sections; expected exactly one",
            );
          }
          gcCodecBytes.set(activationId, new Uint8Array(sections[0]!));
        }
        childGcCodecBytes = gcCodecBytes;
        childHostExceptionOwner =
          declarations
            .filter((entry) => entry.exceptionDescriptor !== undefined)
            .map((entry) => entry.activationId)
            .sort((left, right) => left - right)[0] ?? 0xffff_ffff;
        // P2 (Path B): the co-resident module is the SOLE reconstructor whenever
        // it is active for this fork — there is no longer a per-kind host
        // admission gate, and no JS reconstruction fallback behind it. The former
        // all-or-nothing predicate iterated every graph node and, on a single
        // unadmitted node (e.g. an exnref whose activation lacked a matching
        // exception descriptor, or a struct/array whose layout the host could not
        // pre-validate), routed the WHOLE fork onto the JS reference engine. That
        // fallback is deleted: native proves the shared module admits and
        // reconstructs the entire reference kind set (null / funcref / externref /
        // i31 / exnref / struct / array / static-root; see
        // `fork-module/src/lib.rs` "the whole reference kind set the module
        // reconstructs"). The kind-set the module admits is NOT a fresh
        // engine-floor callback per kind; the module re-checks most kinds and
        // fails loud where IT can see the fault — GC layout validity in
        // `GcCodecHints::require_layout` (`EINVAL`) and externref
        // production-provenance in `fm_begin_reference_replay`. Two validity checks
        // remain HOST-OWNED by the module's own contract
        // (`fork_codec::reference_replay.rs:210-212, 261-263` — "a check it alone
        // can see"): the GC-descriptor layout gate (still enforced by the module's
        // `require_layout`) and the EXNREF exception-descriptor tag gate. The
        // module has NO exception-codec seeding, so it CANNOT re-check that an
        // exnref recipe's tag is declared by its owning activation; that check is
        // restored below as a fail-loud host boundary
        // (`assertForkModuleExnrefTagsDeclared`), NOT as a JS reconstruction
        // fallback. Whenever the module instantiated for this child it owns the
        // whole reference graph: wire decode (module-internal
        // `fork_codec::reference_segments`, seeded from the KFMS arena by
        // `fm_begin_reference_replay`), the full topological drive-order
        // (`fm_build_gc_plan` + `fm_drive_execute` over `drive_plan` Phase
        // 0/0b/3-5 — static-root publish, EVERY externref transit publish, then
        // typed allocate/fill/exn), and every `fm_ref_*` restore data feed. The
        // `decodedChildReferences` decode the host keeps no longer drives the two
        // host-side STRUCTURAL consumers — the exnref tag gate and the static-root
        // catalog mirror seeding both read node kinds + coordinates from the
        // module's `fm_decoded_*` accessors now (Path-A INC-C) — but it is still
        // held for the reconstruction WIRING it feeds (`ForkEarlyChildReferenceProvider`
        // + the continuation `attachChild`), not for the reconstruction algorithm
        // itself. Multi-activation (dlopen) forks are covered identically: the
        // merged, activation-namespaced funcref/static-root catalogs resolve each
        // node against its owning activation.
        moduleReferenceKindsSupported =
          useForkModule &&
          forkModuleInstance !== null &&
          decodedChildReferences !== null;
        // HOST-OWNED exnref tag-validity boundary (see
        // `fork-module-exnref-admission.ts` for the full contract). The module
        // cannot re-check exnref tag validity — it has no exception-codec seeding
        // and `GcCodecHints`'s exnref arm assigns the DRIVE_OP_EXN owner
        // unconditionally — so a corrupt / mismatched exnref recipe would
        // otherwise be `call_indirect`-driven blindly. Fail loud here instead
        // (EINVAL), before the module drives reconstruction, so the parent's fork
        // child dies truthfully rather than silently mis-reconstructing an
        // exception value. Normal forks always name a declared tag, so this never
        // fires on a well-formed fork. Survives P6 (host glue).
        if (
          moduleReferenceKindsSupported &&
          decodedChildReferences &&
          forkModuleBackend
        ) {
          // Path-A INC-C: make the MODULE's decoded reference graph resident so
          // BOTH structural consumers — this exnref tag-validity gate and the
          // merged static-root catalog mirror seeding below — read node kinds +
          // coordinates from the module's `fm_decoded_*` accessors instead of
          // walking the JS `decodeSegmentedForkReferenceTransaction` structure.
          // One decode here serves both: the resident graph survives the later
          // attach (which seeds the replay DRIVER, not this read-only graph), and
          // both consumers run under the same `moduleReferenceKindsSupported`
          // guard, so the exnref gate always runs when the static-root block does.
          const nodeCount = forkModuleBackend.decodeReferenceGraph(
            childArena.rootAddress(),
          );
          const declaredExnrefTags = new Map<number, ReadonlySet<number>>(
            declarations.map((declaration) => [
              declaration.activationId,
              new Set(
                declaration.exceptionDescriptor.tags.map((tag) => tag.tagOrdinal),
              ),
            ]),
          );
          // WireNodeKind.Exnref (`fork-reference-recipes.ts`): the module's
          // `fm_decoded_node_kind` returns the same discriminant the JS decode's
          // `entry.node.kind === "exnref"` filter selected.
          const WIRE_NODE_KIND_EXNREF = 3;
          const exnrefNodes: ForkExnrefNode[] = [];
          for (let index = 0; index < nodeCount; index += 1) {
            if (
              forkModuleBackend.decodedNodeKind(index) !== WIRE_NODE_KIND_EXNREF
            ) {
              continue;
            }
            exnrefNodes.push({
              moduleActivation:
                forkModuleBackend.decodedNodeModuleActivation(index),
              tagOrdinal: forkModuleBackend.decodedNodeOrdinal(index),
            });
          }
          assertForkModuleExnrefTagsDeclared(
            declaredExnrefTags,
            exnrefNodes,
            `pid=${pid}: fork exnref admission`,
          );
        }
        earlyChildReferences = new ForkEarlyChildReferenceProvider({
          records,
          transaction: decodedChildReferences,
          declarations,
          externrefs: externrefRecipes,
          transit: {
            prepare: (maxRecipeId) =>
              activationRegistry.prepareEarlyGcTransit(maxRecipeId),
            publish: (recipeId, value) =>
              activationRegistry.publishEarlyGcTransit(recipeId, value),
            read: (recipeId) => activationRegistry.readEarlyGcTransit(recipeId),
            abort: () => activationRegistry.abortEarlyGcTransit(),
          },
          memory,
          allocateScratch: (size) => borrowedWorkspace
            ? borrowedWorkspace.allocateScratch(size)
            : continuationMmap(
                memory,
                channelOffset,
                size,
                `pid=${pid}: early reference scratch`,
              ),
          deallocateScratch: (addr, size) => {
            if (borrowedWorkspace) {
              borrowedWorkspace.deallocateScratch(addr, size);
              return;
            }
            continuationMunmap(
              memory,
              channelOffset,
              addr,
              size,
              `pid=${pid}: early reference scratch`,
            );
          },
          label: `pid=${pid}: early child references`,
        });
        importedStatePlanner = new ForkImportedGlobalPlanner(
          records,
          modules,
          earlyChildReferences,
          `pid=${pid}: child imported activation state`,
        );
        const archivedOrder = [
          0,
          ...childDylinkState.libraries.flatMap(({ activationId }) =>
            activationId === undefined ? [] : [activationId],
          ),
        ];
        const plannedOrder = importedStatePlanner.instantiationOrder();
        if (
          archivedOrder.length !== plannedOrder.length ||
          archivedOrder.some(
            (activationId, index) => activationId !== plannedOrder[index],
          )
        ) {
          throw new Error(
            `pid=${pid}: inherited activation import dependencies require order ` +
              `${plannedOrder.join(",")}, but the replay archive provides ` +
              archivedOrder.join(","),
          );
        }
      }
      const forkEnvImports: Record<string, WebAssembly.ImportValue> = {
        ...processContinuation.continuationImports(0),
        // Phase 6 D5 IMPORT FLIP: the guest calls the co-resident module's
        // frame/resume exports directly (wasm->wasm over shared memory); the
        // module is the ONLY frame/journal implementation. `continuationImports`
        // contributes only the host-owned `__wpk_fork_resume_table` funcref
        // table the module's `resume_peek` indexes. Guest ABI names and
        // signatures are unchanged; no guest re-instrumentation.
        ...(useForkModule && forkModuleInstance
          ? {
              // MODULE-MODE PARTIAL-CAPTURE ABORT: the module reserve returns 0
              // (no throw, no JS callback) when a mid-unwind frame allocation
              // fails. The guest's reserve==0 contract then branches into its
              // abort restart loop EXPECTING the host to have already moved to
              // abort replay (fork-instrument `__wpk_fork_select_unwind_frame`).
              // Wrap the raw module export so that, exactly like the JS
              // `onReservationAbort` above, a 0 result synchronously drives the
              // module-mode partial-capture abort — reading the module errno
              // FIRST (before any further module call overwrites it) so the
              // guest's re-entry into `kernel_fork` finds the coordinator in
              // `abort-replay` and `fork()` returns `-errno` with the parent
              // intact. A successful reserve is byte-identical to the raw export.
              __wpk_fork_frame_reserve: (size: number | bigint) => {
                const payload = (
                  forkModuleInstance.exports
                    .__wpk_fork_frame_reserve as (s: number | bigint) => number | bigint
                )(size);
                if (payload === 0 || payload === 0n) {
                  const moduleErrno = forkModuleBackend
                    ? forkModuleBackend.lastErrno()
                    : STARTUP_ENOMEM;
                  processContinuation.beginModuleCaptureAbort(
                    moduleErrno > 0 ? moduleErrno : STARTUP_ENOMEM,
                  );
                }
                return payload;
              },
              __wpk_fork_frame_commit:
                forkModuleInstance.exports.__wpk_fork_frame_commit,
              __wpk_fork_frame_peek:
                forkModuleInstance.exports.__wpk_fork_frame_peek,
              __wpk_fork_frame_next:
                forkModuleInstance.exports.__wpk_fork_frame_next,
              __wpk_fork_resume_peek:
                forkModuleInstance.exports.__wpk_fork_resume_peek,
            }
          : {}),
        ...buildForkActivationStateImports(
          0,
          activationRegistry,
          referenceReplay,
          tableReplicationImports,
        ),
        ...buildForkExceptionImports({
          activationId: 0,
          ptrWidth,
          registry: activationRegistry,
          broker: exceptionBroker,
          provider: () => {
            if (!mainExceptionProvider) {
              throw new Error(
                `pid=${pid}: exception codec called before registration`,
              );
            }
            return mainExceptionProvider;
          },
          referenceReplay,
        }),
        // Phase 6 D6.1 REFERENCE IMPORT FLIP: for a funcref-only child fork,
        // replace ONLY the JS `__wpk_fork_ref_decode_funcref` (supplied by
        // `buildForkActivationStateImports` above) with the module export, which
        // reads the imported `__wpk_fork_function_catalog` mirror table with
        // `table.get`. Placed AFTER `buildForkActivationStateImports` so this
        // key wins. Every other reference import stays JS (unused for a
        // funcref/null graph). Flag-off / non-funcref forks skip this entirely.
        //
        // M2: `__wpk_fork_ref_decode_externref` flips alongside it, to the
        // module's own injected decode export (calls the single
        // `env.resolve_externref` host import instead of the JS
        // `referenceReplay().decodeExternref`). Same gate, same "every other
        // reference import stays JS" scoping.
        ...(moduleReferenceKindsSupported && forkModuleInstance
          ? {
              __wpk_fork_ref_decode_funcref:
                forkModuleInstance.exports.__wpk_fork_ref_decode_funcref,
              __wpk_fork_ref_decode_externref:
                forkModuleInstance.exports.__wpk_fork_ref_decode_externref,
            }
          : {}),
        // Phase 6 item 3a REFERENCE DATA-FEED FLIP: replace the seven JS RESTORE
        // data-feed imports (supplied by `buildForkActivationStateImports` /
        // `buildForkExceptionImports` above) with the module exports for an
        // admitted graph. Placed AFTER those builders so these keys win. Flag-off
        // / non-admitted forks get `{}` and keep the JS reference path.
        ...moduleReferenceFeedFlip(),
      };
      const importObject = buildImportObject(
        module,
        memory,
        kernelImports,
        channelOffset,
        dlopenSupport.imports,
        () => processInstance ?? undefined,
        ptrWidth,
        processLongjmpTag,
        processCppExceptionTag,
        processForkUnwindTag,
        (timedOutPtr, vmInterruptPtr, seconds) => {
          port.postMessage({
            type: "vm_interrupt_timer",
            pid,
            timedOutPtr,
            vmInterruptPtr,
            seconds,
          } satisfies WorkerToHostMessage);
        },
        forkEnvImports,
      );
      const routedImportObject = processHostImportRuntime.routeImportObject(
        programBytes,
        importObject,
      );
      const reconstructedMainImports = importedStatePlanner
        ? importedStatePlanner.importsForActivation(
            0,
            routedImportObject as unknown as ForkWasmImports,
          )
        : routedImportObject;
      // WHY: reconstruction supplies copied identities; capture wraps that
      // resolved view so this child can safely become the parent of another
      // fresh instance without retaining the previous fork arena.
      const mainImportedStatePreparation =
        importedStateCapture.prepareActivation(
          0,
          module,
          reconstructedMainImports,
        );
      const mainInstantiationImports = mainImportedStatePreparation.imports;
      let instance: WebAssembly.Instance;
      try {
        instance = await WebAssembly.instantiate(
          module,
          mainInstantiationImports as unknown as WebAssembly.Imports,
        );
      } catch (error) {
        mainImportedStatePreparation?.abort();
        if (earlyChildReferences) {
          try {
            earlyChildReferences.abort();
          } catch {
            // Preserve the instantiation failure. No replay can proceed, and
            // the outer process teardown still clears registered providers.
          }
          earlyChildReferences = null;
        }
        importedStatePlanner?.clear();
        throw error;
      }
      processInstance = instance;
      mainImportedStatePreparation?.complete(instance);
      mainExceptionProvider = forkExceptionProviderFromInstance(0, instance);
      const mainTypedReferenceProvider = forkGcCodecProviderFromInstance(
        0,
        module,
        instance,
      );
      const mainRegistration = forkActivationRegistrationFromInstance({
        activationId: 0,
        module,
        instance,
        templateId: mainTemplateId,
        exceptionProvider: mainExceptionProvider,
        typedReferenceProvider: mainTypedReferenceProvider,
      });
      processContinuation.registerActivation(
        mainRegistration,
        forkResumeTargetsFromInstance(module, instance),
      );
      importedStatePlanner?.registerInstance(0, instance);
      if (initData.isForkChild) {
        registerChildReferenceActivation(
          0,
          module,
          mainRegistration,
          mainTypedReferenceProvider,
        );
      }
      importedStateCapture?.bindTableDirtyTrackers(
        new Map(
          activationRegistry
            .activations()
            .map((activation) => [
              activation.activationId,
              activation.tableDirty,
            ]),
        ),
      );
      if (!initData.isForkChild) {
        try {
          // Registration harvests static roots before bootstrap consumes the
          // converted active segments, and installs the dirty-table owner
          // before the original start can mutate a table.
          activationRegistry.bootstrapActivation(0);
        } catch (error) {
          processTableReplication.abortActiveMutations();
          processContinuation.unregisterActivation(0);
          mainExceptionProvider = null;
          throw error;
        }
      }
      verifyProgramAbi(programBytes, initData.kernelAbiVersion, pid);

      if (!initData.isForkChild) {
        setupChannelBase(
          instance,
          module,
          memory,
          channelOffset,
          programBytes as ArrayBuffer,
          ptrWidth,
        );
      } else {
        // Every side activation must exist before the process transaction is
        // attached: module/reference recipes name activation coordinates, not
        // whichever instance happens to load first in the child.
        try {
          if (!childDylinkState) {
            throw new Error("inherited dynamic-linker state was not prepared");
          }
          dlopenSupport.replayDlopens(childDylinkState, {
            memoryOwnership: forkMemoryOwnership,
          });
          // Ordinary children reconcile a copied archive under their private
          // lock. Borrowed children already replayed the validated snapshot;
          // taking either archive lock would mutate the suspended parent.
          if (!borrowedForkChild) processTableReplication.reconcileNow();
        } catch (error) {
          throw new Error(
            `fork-replay-dlopen failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
        if (!childArena) {
          throw new Error(
            `pid=${pid}: fork child lost its validated module-state arena`,
          );
        }
        if (!importedStatePlanner || !earlyChildReferences) {
          throw new Error(
            `pid=${pid}: fork child lost its pre-instantiation reference plan`,
          );
        }
        importedStatePlanner.bindTableDirtyTrackers(
          new Map(
            activationRegistry
              .activations()
              .map((activation) => [
                activation.activationId,
                activation.tableDirty,
              ]),
          ),
        );
        const early = earlyChildReferences;
        const adoptEarlyReferences = (): void => {
          early.adoptInto(activationRegistry.currentReferences());
          earlyChildReferences = null;
        };
        if (moduleReferenceKindsSupported && forkModuleInstance) {
          // Phase 6 D6.1/D7a.1b: the guest instances now exist, so mirror every
          // activation's `__wpk_fork_function_catalog` funcref table into the ONE
          // host-owned merged table the fork-module imported at init (the module
          // could not import the guest exports directly — it is instantiated
          // BEFORE the guests to supply the frame-flip imports). Copying preserves
          // funcref identity (`table.get` returns the same functions), so the
          // module's reconstruction matches the JS catalog byte for byte.
          //
          // MERGED, ACTIVATION-NAMESPACED CATALOG: each activation `a`'s catalog
          // occupies slots `[base[a], base[a] + len_a)`, where `base[a]` is the
          // running sum of every prior (sorted) activation's catalog length. The
          // module is seeded that base via `setActivationCatalogBase`, and
          // `fm_funcref_ordinal` then returns the global slot
          // `base(module_activation) + function_ordinal` — so a funcref minted in
          // one activation but held by another's frame resolves against its own
          // activation's slice. A SINGLE-activation fork seeds NO base (the module
          // defaults base 0), so its mirror + reconstruction is byte-identical to
          // D6.1. Activation 0 is registered first (sorted), so its base is 0 and
          // its funcrefs still map to raw ordinals.
          const sortedActivations = [...activationRegistry.activations()].sort(
            (left, right) => left.activationId - right.activationId,
          );
          const mirror = forkModuleInstance.functionCatalog;
          const multiActivation = sortedActivations.length > 1;
          let base = 0;
          for (const activation of sortedActivations) {
            const guestCatalog = activation.functionCatalog;
            const needed = base + guestCatalog.length;
            if (mirror.length < needed) {
              mirror.grow(needed - mirror.length);
            }
            for (let slot = 0; slot < guestCatalog.length; slot += 1) {
              mirror.set(base + slot, guestCatalog.get(slot));
            }
            // Only seed bases for a multi-activation fork; keeping the base map
            // EMPTY for a single activation makes its funcref mapping provably
            // byte-identical to D6.1 (base defaults to 0 in the module).
            if (multiActivation && forkModuleBackend) {
              forkModuleBackend.setActivationCatalogBase(
                activation.activationId,
                base,
              );
            }
            base += guestCatalog.length;
          }
          // Phase 6 item 3b/3c: bind each activation's guest
          // `_gc_allocate`/`_gc_fill`/`_exception_materialize` exports into the
          // module's imported drive table at
          // `fm_drive_table_base(act) + {ALLOC, FILL, EXN}`, so the injected
          // `fm_drive_execute` shim can `call_indirect` them. The module could not
          // import the guest exports directly — it is instantiated BEFORE the
          // guests to supply the frame-flip imports. The absolute slot numbers
          // match the ones the Rust drive PLAN encodes (`fork_codec::drive_plan`).
          //
          // Item 3c makes this LIVE: the module now drives the typed
          // allocate/fill/exn topological order (`fm_build_gc_plan` +
          // `fm_drive_execute`) in place of the JS `materializeAllTyped` sub-loop
          // for a flag-on qualifying child. A flag-off fork skips this entirely.
          const driveTable = forkModuleInstance.driveTable;
          const driveTableBase = forkModuleInstance.exports
            .fm_drive_table_base as (activation: number) => number;
          // Op / slot offsets within an activation's drive-table slice (see
          // `fork_codec::drive_plan` DRIVE_OP_ALLOC / DRIVE_OP_FILL / DRIVE_OP_EXN
          // and DRIVE_SLOT_RESTORE / DRIVE_SLOT_FINISH_RESTORE).
          const DRIVE_OP_ALLOC = 0;
          const DRIVE_OP_FILL = 1;
          const DRIVE_OP_EXN = 2;
          const DRIVE_SLOT_RESTORE = 3;
          const DRIVE_SLOT_FINISH_RESTORE = 4;
          for (const activation of sortedActivations) {
            const slotBase = driveTableBase(activation.activationId);
            const allocate =
              activation.instance.exports[WPK_FORK_REFERENCE_EXPORT_GC_ALLOCATE];
            const fill =
              activation.instance.exports[WPK_FORK_REFERENCE_EXPORT_GC_FILL];
            // A fork whose guest carries no typed-GC codec exports no
            // allocate/fill; leave those slots empty (they are never driven).
            if (typeof allocate !== "function" || typeof fill !== "function") {
              continue;
            }
            // The exnref materialize export is present only when the guest ships
            // an exception codec; bind it when it exists so an exnref DRIVE step
            // (`DRIVE_OP_EXN`) resolves. A struct/array/i31-only guest omits it,
            // and no exnref step is ever emitted for it.
            const materialize =
              activation.instance.exports[WPK_FORK_EXCEPTION_EXPORT_MATERIALIZE];
            const hasExn = typeof materialize === "function";
            const needed = slotBase + (hasExn ? DRIVE_OP_EXN : DRIVE_OP_FILL) + 1;
            if (driveTable.length < needed) {
              driveTable.grow(needed - driveTable.length);
            }
            driveTable.set(slotBase + DRIVE_OP_ALLOC, allocate);
            driveTable.set(slotBase + DRIVE_OP_FILL, fill);
            if (hasExn) {
              driveTable.set(slotBase + DRIVE_OP_EXN, materialize);
            }
          }
          // Child-install binding (Phase 6 `fm_attach_child`): bind EVERY
          // activation's guest `wpk_fork_module_state_restore` /
          // `wpk_fork_module_state_finish_restore` into its drive-table slice so
          // the module-owned attach plan's `DRIVE_OP_RESTORE` /
          // `DRIVE_OP_FINISH_RESTORE` steps `call_indirect` them. UNLIKE the
          // allocate/fill/exn binding above this is NOT gated on a typed-GC codec:
          // restore/finish reconstruct an activation's global/table state (which
          // exists even for a reference-free activation in a multi-activation
          // fork), so every `Module`-record activation the module enumerates for
          // the plan must have its restore/finish bound.
          for (const activation of sortedActivations) {
            const slotBase = driveTableBase(activation.activationId);
            const restore =
              activation.instance.exports[WPK_FORK_EXPORT_MODULE_STATE_RESTORE];
            const finishRestore =
              activation.instance.exports[
                WPK_FORK_EXPORT_MODULE_STATE_FINISH_RESTORE
              ];
            if (
              typeof restore !== "function" ||
              typeof finishRestore !== "function"
            ) {
              throw new Error(
                `pid=${pid}: activation ${activation.activationId} is missing ` +
                  "module-state restore/finish exports for the module attach drive",
              );
            }
            const needed = slotBase + DRIVE_SLOT_FINISH_RESTORE + 1;
            if (driveTable.length < needed) {
              driveTable.grow(needed - driveTable.length);
            }
            driveTable.set(slotBase + DRIVE_SLOT_RESTORE, restore);
            driveTable.set(slotBase + DRIVE_SLOT_FINISH_RESTORE, finishRestore);
          }
          // The module-backed reference replay path always carries a backend (it
          // was set up alongside `forkModuleInstance` and `enableModuleReferenceReplay`
          // below drives through it). Assert it so the seed calls are well-typed
          // and a missing backend fails loudly rather than silently skipping the
          // drive seed.
          if (!forkModuleBackend) {
            throw new Error(
              `pid=${pid}: fork-module reference replay requires a backend`,
            );
          }
          // Phase 6 item 3c: seed the module's typed-GC drive planner from the
          // raw KFGC section bytes captured in the pre-instantiation planning
          // block (`childGcCodecBytes`). Each activation's codec supplies the
          // per-recipe layout facts (constructor deps, defaultable shells, the i31
          // owner) `fm_build_gc_plan` needs to reproduce the JS drive-order. Seeded
          // here — once per worker — so the coordinator's per-fork drive seam only
          // builds + executes the plan. Re-seeding an activation would fail
          // `EINVAL`, and this worker seeds each exactly once.
          if (!childGcCodecBytes) {
            throw new Error(
              `pid=${pid}: fork-module drive lost the captured GC codec bytes`,
            );
          }
          for (const activation of sortedActivations) {
            const bytes = childGcCodecBytes.get(activation.activationId);
            if (!bytes) {
              throw new Error(
                `pid=${pid}: fork-module drive seed lost activation ` +
                  `${activation.activationId}'s GC codec bytes`,
              );
            }
            forkModuleBackend.setActivationGcCodec(
              activation.activationId,
              bytes,
            );
          }
          // The host-exception owner (the JS `directOwner` for a host exnref) was
          // captured alongside the codec bytes: the smallest activation that
          // declared an exception codec descriptor, or 0xffff_ffff if none.
          forkModuleBackend.setHostExceptionOwner(childHostExceptionOwner);
          // Static-root binder: populate the merged anyref catalog mirror the
          // module's injected `fm_drive_execute` reads on a DRIVE_OP_STATIC_ROOT
          // step. The child's static roots were harvested + registered during
          // activation registration (above), so `decodeStaticRoot` derefs the live
          // child root here; publishing it into the transit stays in wasm (the
          // binder), replacing the JS `publishTransit` for static roots. Only the
          // REFERENCED ordinals are pinned into the mirror, so an unreferenced
          // (and possibly collected) root is never derefed. Each static-root-
          // bearing activation gets a contiguous slice `[base, base + width)`
          // (`width` = its max referenced ordinal + 1); the module's
          // `fm_static_root_slot` returns `base(activation) + ordinal`. A single
          // static-root activation seeds NO base (module defaults base 0),
          // byte-identical to the raw-ordinal mapping. The mirror is cleared right
          // after the attach drives the plan so it never pins a child root past
          // replay.
          // `moduleReferenceKindsSupported` (this block's guard) is only true on
          // the module path, where the exnref gate above already made the module's
          // decoded reference graph resident. Read the static-root nodes from the
          // module's `fm_decoded_*` accessors (node index == canonical node id)
          // instead of walking the JS `decodeSegmentedForkReferenceTransaction`
          // structure. The resident graph survived the intervening guest
          // instantiation + attach (which seed the replay DRIVER, not this
          // read-only graph). WireNodeKind.StaticRoot (`fork-reference-recipes.ts`)
          // is 7 — the same discriminant the JS `entry.node.kind === "static-root"`
          // filter selected.
          const WIRE_NODE_KIND_STATIC_ROOT = 7;
          const decodedNodeCount = forkModuleBackend.decodedNodeCount();
          const staticRootNodes: { activation: number; ordinal: number }[] = [];
          for (let index = 0; index < decodedNodeCount; index += 1) {
            if (
              forkModuleBackend.decodedNodeKind(index) !==
              WIRE_NODE_KIND_STATIC_ROOT
            ) {
              continue;
            }
            staticRootNodes.push({
              activation: forkModuleBackend.decodedNodeModuleActivation(index),
              ordinal: forkModuleBackend.decodedNodeOrdinal(index),
            });
          }
          if (staticRootNodes.length > 0) {
            const mirror = forkModuleInstance.staticRootCatalog;
            const maxOrdinalByActivation = new Map<number, number>();
            for (const entry of staticRootNodes) {
              maxOrdinalByActivation.set(
                entry.activation,
                Math.max(
                  maxOrdinalByActivation.get(entry.activation) ?? 0,
                  entry.ordinal,
                ),
              );
            }
            const staticRootActivations = [
              ...maxOrdinalByActivation.keys(),
            ].sort((left, right) => left - right);
            const staticRootBase = new Map<number, number>();
            let staticRootWidth = 0;
            for (const activation of staticRootActivations) {
              staticRootBase.set(activation, staticRootWidth);
              staticRootWidth += maxOrdinalByActivation.get(activation)! + 1;
            }
            if (mirror.length < staticRootWidth) {
              mirror.grow(staticRootWidth - mirror.length, null);
            }
            for (const entry of staticRootNodes) {
              mirror.set(
                staticRootBase.get(entry.activation)! + entry.ordinal,
                activationRegistry.decodeStaticRoot(
                  entry.activation,
                  entry.ordinal,
                ),
              );
            }
            // Seed bases only for a multi-activation static-root fork; a single
            // static-root activation keeps the empty base map (module base 0).
            if (staticRootActivations.length > 1) {
              for (const activation of staticRootActivations) {
                forkModuleBackend.setActivationStaticRootBase(
                  activation,
                  staticRootBase.get(activation)!,
                );
              }
            }
          }
          processContinuation.enableModuleReferenceReplay();
        }
        if (borrowedWorkspace) {
          processContinuation.attachBorrowedChild(
            childArena,
            borrowedWorkspace.reservePrefix,
            adoptEarlyReferences,
            decodedChildReferences ?? undefined,
          );
          borrowedWorkspace.assertAttachComplete();
        } else {
          processContinuation.attachChild(
            childArena,
            adoptEarlyReferences,
            decodedChildReferences ?? undefined,
          );
        }
        // Static-root binder: the attach synchronously drove the plan, so the
        // static roots are now rooted in the anyref transit (and the child
        // instance holds them as immutable roots). Null the merged catalog mirror
        // so it never extends a child root's lifetime past replay — the same
        // no-leak contract the harvest-table clear and `finishReplay` transit
        // clear keep for the JS path.
        if (moduleReferenceKindsSupported && forkModuleInstance) {
          const mirror = forkModuleInstance.staticRootCatalog;
          for (let slot = 0; slot < mirror.length; slot += 1) {
            mirror.set(slot, null);
          }
        }
        decodedChildReferences = null;
        importedStatePlanner.clear();
        importedStatePlanner = null;
        forkResult = 0;

        // Child attach restores __tls_base/__stack_pointer for every
        // activation before any continuation frame can execute.
        setupChannelBase(
          instance,
          module,
          memory,
          channelOffset,
          programBytes as ArrayBuffer,
          ptrWidth,
        );
      }

      // Signal ready
      port.postMessage({ type: "ready", pid } satisfies WorkerToHostMessage);

      // Run with wpk_fork_* instrumentation
      let exitCode = 0;
      try {
        const start = instance.exports._start as () => void;
        const resumeStart = instance.exports.wpk_fork_resume_start as
          (() => void) | undefined;
        if (typeof resumeStart !== "function") {
          throw new Error(
            `pid=${pid}: fork-capable program is missing wpk_fork_resume_start`,
          );
        }

        // Choose entry: normal _start, or — for a fork-from-non-main-thread
        // child — call the parent thread's thread function directly. _start
        // is not in the thread's fork-path call chain, so rewinding through
        // it would never reach the saved fork() call site. The thread
        // function's instrumented body sees state==REWINDING on entry and
        // replays the saved frames back to fork().
        let lexicalEntry: () => void;
        let replayEntry: () => void;
        if (initData.isForkChild && initData.forkChildThreadFnPtr != null) {
          const fnIdx = initData.forkChildThreadFnPtr;
          const childArgPtr = initData.forkChildThreadArgPtr ?? 0;
          const threadArg = ptrWidth === 8 ? BigInt(childArgPtr) : childArgPtr;
          const resumeThread = instance.exports.wpk_fork_resume_thread as
            | ((tableIndex: number, arg: number | bigint) => number | bigint)
            | undefined;
          if (typeof resumeThread !== "function") {
            throw new Error(
              "Fork-from-thread child: missing wpk_fork_resume_thread",
            );
          }
          // A fork child never executes the lexical pthread entry. Keep the
          // two closures structurally complete so the loop can select solely
          // from coordinator phase below.
          lexicalEntry = () => {
            throw new Error(
              "Fork-from-thread child entered lexical thread path",
            );
          };
          replayEntry = () => {
            resumeThread(fnIdx, threadArg);
          };
        } else {
          lexicalEntry = start;
          replayEntry = resumeStart;
        }

        for (;;) {
          let transportedForkUnwind = false;
          try {
            const phaseBeforeEntry = processContinuation.phaseName();
            const entry =
              phaseBeforeEntry === "idle" ? lexicalEntry : replayEntry;
            entry();
          } catch (e) {
            if (isForkUnwindException(e, processForkUnwindTag)) {
              transportedForkUnwind = true;
            } else if (isWasmUnreachableTrap(e)) {
              if (kernelExitStatus !== null) {
                exitCode = kernelExitStatus;
                break; // Normal exit via kernel_exit -> unreachable trap
              }
              throw e;
            } else {
              throw e;
            }
          }

          const phase = processContinuation.phaseName();
          if (transportedForkUnwind && phase !== "capture") {
            throw new Error(
              `pid=${pid}: private fork-unwind exception escaped while ` +
                `process continuation is ${phase}`,
            );
          }
          if (phase === "capture") {
            try {
              processContinuation.sealCapture();
            } catch (sealError) {
              // SEAL-TIME TRUTHFUL FAILURE (Phase 2 carry / Phase 4): the unwind
              // completed but the module could not channel-mmap the
              // child-inheritable journal image. The coordinator sealed to
              // `sealed-parent` WITHOUT launching a child; replay the parent's
              // already-committed frames and return `-errno` (parent intact, no
              // child). This is the seal-time sibling of the mid-unwind
              // `beginModuleCaptureAbort` reserve==0 path, so NO module failure
              // site traps once the JS continuation fallback is gone.
              if (sealError instanceof ContinuationAllocationError) {
                const errno =
                  sealError.errno > 0 ? sealError.errno : STARTUP_ENOMEM;
                forkResult = -errno;
                processContinuation.beginAbortReplay(errno);
                if (forkModuleBackend && !initData.isForkChild) {
                  port.postMessage({
                    type: "fork_module_frames",
                    pid,
                    frames: Number(forkModuleBackend.framesCommitted()),
                  } satisfies WorkerToHostMessage);
                }
                continue;
              }
              throw sealError;
            }
            // GATED REFERENCE KIND: a capture-side record-stub in
            // `buildForkActivationStateImports` marked this fork as carrying a
            // reference kind the platform cannot faithfully reconstruct in a
            // fresh child (e.g. a live externref or typed Wasm-GC value). Abort
            // the fork cleanly with EOPNOTSUPP instead of launching a child:
            // the guest's `kernel_fork` re-enters in `abort-replay` and returns
            // `-EOPNOTSUPP`. This reaches the exact post-abort handling the
            // `childPid < 0` branch below uses; it never throws (a throw cannot
            // unwind an errno through the Wasm fork save walk) and never
            // silently succeeds.
            const unsupportedKind =
              activationRegistry.takeUnsupportedReferenceKind();
            if (unsupportedKind !== null) {
              // Make the platform boundary VISIBLE to a developer (Platform
              // Values: truthful failure over silent illusion). Marker-gated:
              // this fires ONLY when a capture-side record-stub marked an
              // unsupported reference kind, never on a supported (funcref /
              // exnref / simple) fork. One concise line per aborted fork.
              console.warn(
                `[worker] pid=${pid}: fork aborted with EOPNOTSUPP — carried a ` +
                  `live '${unsupportedKind}' reference across the fork boundary, ` +
                  `which the platform cannot reconstruct in a fresh child yet. ` +
                  `No child was spawned; the parent continues. ` +
                  `See docs/fork-reference-support.md.`,
              );
              forkResult = -FORK_REFERENCE_EOPNOTSUPP;
              processContinuation.beginAbortReplay(FORK_REFERENCE_EOPNOTSUPP);
              // Path B P4 proof-of-use: when the co-resident module is enabled,
              // `beginAbortReplay` above routed through the module's OWN abort
              // path (`beginModuleAbortReplay` -> `fm_begin_abort`), replaying
              // the parent's committed frames rather than the JS engine that P6
              // deletes. Emit the committed-frame count INLINE here — symmetric
              // with the success branch's inline emission below — so the proof
              // is deterministic for a gated parent that spawns no child and
              // may exit immediately (its worker-tail emission can race the
              // `kernel_exit` teardown). A silent JS-only abort (no module
              // backend) constructs no backend and emits nothing.
              if (forkModuleBackend && !initData.isForkChild) {
                port.postMessage({
                  type: "fork_module_frames",
                  pid,
                  frames: Number(forkModuleBackend.framesCommitted()),
                } satisfies WorkerToHostMessage);
              }
              continue;
            }
            const borrowedReplay = Number(forkMode) === PROCESS_FORK_MODE_VFORK
              ? processContinuation.borrowedReplayWorkspaceRequirements()
              : undefined;
            const childPid = sendForkSyscall(
              memory,
              channelOffset,
              forkMode,
              borrowedReplay,
            );
            forkResult = childPid;
            if (childPid < 0) {
              processContinuation.beginAbortReplay(-childPid);
            } else {
              processContinuation.beginParentReplay();
              // Phase 6 D5/D7a.1a proof-of-use, emitted from the PARENT's active
              // run loop (not the worker tail). A fork parent stays alive and its
              // channel is drained normally, so this reaches the host reliably
              // even in main-thread hosts where the fork parent's worker tail is
              // torn down before it runs (the tail-scoped `fork_module_frames`
              // below is the worker-thread-host mirror). A nonzero committed
              // count here proves the module drove THIS fork's unwind; a silent
              // JS fallback (`useForkModule === false`) never constructs the
              // backend and emits nothing.
              if (forkModuleBackend && !initData.isForkChild) {
                port.postMessage({
                  type: "fork_module_frames",
                  pid,
                  frames: Number(forkModuleBackend.framesCommitted()),
                } satisfies WorkerToHostMessage);
              }
            }
            continue;
          }
          if (phase !== "idle") {
            throw new Error(
              `pid=${pid}: process entry returned while continuation is ${phase}`,
            );
          }

          // Normal return — program finished
          if (kernelExitStatus === null) {
            kernelImports.kernel_exit(0);
            exitCode = kernelExitStatus ?? 0;
          }
          break;
        }
      } catch (e) {
        processTableReplication.abortActiveMutations();
        releaseProcessForkArchiveReader();
        if (isWasmUnreachableTrap(e) && kernelExitStatus !== null) {
          exitCode = kernelExitStatus;
        } else {
          if (processContinuation.phaseName() !== "idle") {
            try {
              processContinuation.abort();
            } catch {
              // Preserve the execution failure; abort already made its
              // transaction state unreachable before attempting deallocation.
            }
          }
          throw e;
        }
      }

      // Phase 6 D5 proof-of-use: a parent worker that ran a qualifying fork
      // through the co-resident module reports how many frames the module
      // committed. Only the parent commits (a replay-only child never does), so
      // scope this to the non-child worker. A silent JS fallback would leave
      // the counter at zero and fail the flag-on proof test.
      if (forkModuleBackend && !initData.isForkChild) {
        port.postMessage({
          type: "fork_module_frames",
          pid,
          frames: Number(forkModuleBackend.framesCommitted()),
        } satisfies WorkerToHostMessage);
      }

      // Phase 6 D6.5 proof-of-use: a fresh fork CHILD whose carried references
      // were reconstructed through the co-resident module reports the count. The
      // reference decode runs in the CHILD (the flipped
      // `__wpk_fork_ref_decode_funcref` / `fm_begin_reference_replay`), so —
      // unlike the parent-committed frame count above — scope this to the child
      // worker. Emitted ONLY when the module actually reconstructed a reference
      // (count > 0): a reference-free fork (the common case, e.g. `d_01`) leaves
      // the counter at zero and must stay silent, so it does not add a second
      // `fork-module` diagnostic that could race a consumer waiting for the
      // parent's frame count. A nonzero value is the positive proof the module
      // drove the reconstruction rather than the JS reference fallback.
      if (forkModuleBackend && initData.isForkChild) {
        // Per-kind proof-of-use (Phase 6 D6.5): report each reference kind the
        // module reconstructed — funcref/null, externref, exnref, and typed-GC.
        // A graph can mix kinds (an exnref whose payload is an externref advances
        // both), so all four ride one message. Emitted ONLY when at least one is
        // positive: a reference-free fork (the common case, e.g. `d_01`) leaves
        // every counter at zero and must stay silent, so it does not add a second
        // `fork-module` diagnostic that could race a consumer waiting for the
        // parent's frame count. A nonzero value is the positive proof the module
        // drove that kind's reconstruction rather than the JS reference fallback.
        const references = Number(forkModuleBackend.referencesReconstructed());
        const externrefs = Number(forkModuleBackend.externrefsResolved());
        const exnrefs = Number(forkModuleBackend.exnrefsReconstructed());
        const gcNodes = Number(forkModuleBackend.gcNodesReconstructed());
        // Phase 6 item 3c DRIVE proof-of-use: the module executed the typed-GC
        // drive plan (`fm_drive_execute`) rather than falling back to the JS
        // `materializeAllTyped` order. Distinct from `gcNodes`, which advances
        // merely by admitting the graph.
        const driveSteps = Number(forkModuleBackend.driveStepsExecuted());
        // Static-root binder proof-of-use: the module republished an immutable
        // static root into the anyref transit (`fm_static_root_slot`) rather than
        // the JS `publishTransit` fallback.
        const staticRoots = Number(forkModuleBackend.staticRootsPublished());
        if (
          references > 0 ||
          externrefs > 0 ||
          exnrefs > 0 ||
          gcNodes > 0 ||
          driveSteps > 0 ||
          staticRoots > 0
        ) {
          port.postMessage({
            type: "fork_module_references",
            pid,
            references,
            externrefs,
            exnrefs,
            gcNodes,
            driveSteps,
            staticRoots,
          } satisfies WorkerToHostMessage);
        }
        // Phase 6 D7b replay-side proof-of-use: a fork CHILD (crucially a
        // fork-from-thread child, which carries no references) drives its rewind
        // through the module's flipped `__wpk_fork_frame_next`, but never commits
        // a frame — so `framesCommitted()` is 0 on a child and the parent-scoped
        // `fork_module_frames` above cannot prove the child ran through the
        // module. Report the module's REPLAYED frame count instead. A nonzero
        // value is the positive proof the child rewound through the module rather
        // than the JS fallback; a reference-free non-thread child that fell back
        // would leave this at 0 and stay silent.
        const replayed = Number(forkModuleBackend.framesReplayed());
        if (replayed > 0) {
          port.postMessage({
            type: "fork_module_child_frames",
            pid,
            frames: replayed,
          } satisfies WorkerToHostMessage);
        }
      }

      processContinuation.clear();
      releaseProcessForkArchiveReader();
      importedStateCapture?.clear();
      externrefTokens.clear();
      processHostImportRuntime.clear();
      port.postMessage({
        type: "exit",
        pid,
        status: exitCode,
      } satisfies WorkerToHostMessage);
    } else {
      // No fork instrumentation: fork cannot be represented safely because
      // the child cannot resume at the fork call site. Fail loudly if the
      // program reaches kernel_fork instead of silently degrading.
      kernelImports.kernel_fork = (_mode: number): number => {
        throw new Error(
          `pid=${pid}: kernel_fork reached without complete wasm-fork-instrument ` +
            "exports. Rebuild the program with scripts/run-wasm-fork-instrument.sh.",
        );
      };

      let processInstance: WebAssembly.Instance | null = null;
      const dlopenSupport = buildDlopenImports(
        memory,
        channelOffset,
        dlopenArchiveControlAddr,
        () =>
          processInstance?.exports.__indirect_function_table as
            WebAssembly.Table | undefined,
        () =>
          processInstance?.exports.__stack_pointer as
            WebAssembly.Global | undefined,
        () => processInstance ?? undefined,
        ptrWidth,
        processLongjmpTag,
        processCppExceptionTag,
        undefined,
        `pid=${pid}: main artifact has no fork activation coordinator`,
        processForkUnwindTag,
        undefined,
        undefined,
        pid,
      );
      const importObject = buildImportObject(
        module,
        memory,
        kernelImports,
        channelOffset,
        dlopenSupport.imports,
        () => processInstance ?? undefined,
        ptrWidth,
        processLongjmpTag,
        processCppExceptionTag,
        processForkUnwindTag,
        (timedOutPtr, vmInterruptPtr, seconds) => {
          port.postMessage({
            type: "vm_interrupt_timer",
            pid,
            timedOutPtr,
            vmInterruptPtr,
            seconds,
          } satisfies WorkerToHostMessage);
        },
      );
      const instance = await WebAssembly.instantiate(module, importObject);
      processInstance = instance;
      verifyProgramAbi(programBytes, initData.kernelAbiVersion, pid);

      setupChannelBase(
        instance,
        module,
        memory,
        channelOffset,
        programBytes as ArrayBuffer,
        ptrWidth,
      );

      port.postMessage({ type: "ready", pid } satisfies WorkerToHostMessage);

      let exitCode = 0;
      try {
        const start = instance.exports._start as (() => void) | undefined;
        if (start) start();
        if (kernelExitStatus !== null) {
          exitCode = kernelExitStatus;
        }
      } catch (e) {
        if (isWasmUnreachableTrap(e)) {
          if (kernelExitStatus !== null) {
            exitCode = kernelExitStatus;
          } else {
            throw e;
          }
        } else {
          throw e;
        }
      }
      if (kernelExitStatus === null) {
        kernelImports.kernel_exit(exitCode);
        exitCode = kernelExitStatus ?? exitCode;
      }

      port.postMessage({
        type: "exit",
        pid,
        status: exitCode,
      } satisfies WorkerToHostMessage);
    }
  } catch (err) {
    processHostImportRuntime?.clear();
    if (err instanceof ExecRetirement) {
      port.postMessage({
        type: "exec_retired",
        pid: initData.pid,
      } satisfies WorkerToHostMessage);
      return;
    }
    let errMsg: string;
    if (err instanceof Error) {
      errMsg = `${err.message}\n${err.stack}`;
    } else if (
      (WebAssembly as any).Exception &&
      err instanceof (WebAssembly as any).Exception
    ) {
      // WebAssembly.Exception isn't an Error subclass in V8, so String(err)
      // produces the useless "[object WebAssembly.Exception]". Surface
      // anything we can read off it for build-time debugging.
      const wex = err as { message?: string; stack?: string };
      errMsg = `WebAssembly.Exception: ${wex.message ?? "<no message>"}\n${wex.stack ?? "<no stack>"}`;
    } else {
      errMsg = String(err);
    }
    port.postMessage({
      type: "error",
      pid: initData.pid,
      message: `Kernel worker failed: ${errMsg}`,
    } satisfies WorkerToHostMessage);
  }
}

/**
 * Set up __channel_base in TLS so __do_syscall knows the channel offset.
 */
/**
 * Detect __channel_base's TLS offset by inspecting the Wasm binary.
 *
 * The __get_channel_base_addr function has a simple body:
 *   i32.const <offset>
 *   global.get <__tls_base>
 *   i32.add
 *   return
 *
 * We find this function by looking at the export wrapper's call target.
 * Returns the i32.const value, or -1 if detection fails.
 */
function detectChannelBaseTlsOffset(programBytes: ArrayBuffer): number {
  const src = new Uint8Array(programBytes);
  if (src.length < 8) return -1;

  function readLEB128(buf: Uint8Array, off: number): [number, number] {
    let result = 0,
      shift = 0,
      pos = off;
    for (;;) {
      const byte = buf[pos++];
      result |= (byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) break;
      shift += 7;
    }
    return [result, pos - off];
  }

  // Parse sections to find Export and Code sections
  interface Section {
    id: number;
    contentOffset: number;
    contentSize: number;
  }
  const sections: Section[] = [];
  let numFuncImports = 0;
  let offset = 8;

  while (offset < src.length) {
    const sectionId = src[offset];
    const [sectionSize, sizeBytes] = readLEB128(src, offset + 1);
    sections.push({
      id: sectionId,
      contentOffset: offset + 1 + sizeBytes,
      contentSize: sectionSize,
    });
    offset += 1 + sizeBytes + sectionSize;
  }

  // Count function imports (section 2)
  for (const sec of sections) {
    if (sec.id === 2) {
      let pos = sec.contentOffset;
      const [importCount, countBytes] = readLEB128(src, pos);
      pos += countBytes;
      for (let i = 0; i < importCount; i++) {
        const [modLen, modLenBytes] = readLEB128(src, pos);
        pos += modLenBytes + modLen;
        const [fieldLen, fieldLenBytes] = readLEB128(src, pos);
        pos += fieldLenBytes + fieldLen;
        const kind = src[pos++];
        if (kind === 0) {
          numFuncImports++;
          const [, n] = readLEB128(src, pos);
          pos += n;
        } else if (kind === 1) {
          pos++;
          const f = src[pos++];
          const [, n] = readLEB128(src, pos);
          pos += n;
          if (f & 1) {
            const [, n2] = readLEB128(src, pos);
            pos += n2;
          }
        } else if (kind === 2) {
          const f = src[pos++];
          const [, n] = readLEB128(src, pos);
          pos += n;
          if (f & 1) {
            const [, n2] = readLEB128(src, pos);
            pos += n2;
          }
        } else if (kind === 3) {
          pos += 2;
        }
      }
      break;
    }
  }

  // Find __get_channel_base_addr export
  let channelBaseExportFuncIdx = -1;
  for (const sec of sections) {
    if (sec.id === 7) {
      let pos = sec.contentOffset;
      const [exportCount, countBytes] = readLEB128(src, pos);
      pos += countBytes;
      for (let i = 0; i < exportCount; i++) {
        const [nameLen, nameLenBytes] = readLEB128(src, pos);
        pos += nameLenBytes;
        const name = new TextDecoder().decode(src.subarray(pos, pos + nameLen));
        pos += nameLen;
        const kind = src[pos++];
        const [idx, idxBytes] = readLEB128(src, pos);
        pos += idxBytes;
        if (kind === 0 && name === "__get_channel_base_addr") {
          channelBaseExportFuncIdx = idx;
          break;
        }
      }
      break;
    }
  }

  if (channelBaseExportFuncIdx < 0) return -1;

  // The export may be either:
  // 1. A direct export (no ctors): i32.const <offset>; global.get; i32.add; ...
  // 2. A wrapper: call __wasm_call_ctors; call <actual>; end
  const exportCodeEntry = channelBaseExportFuncIdx - numFuncImports;
  if (exportCodeEntry < 0) return -1;

  for (const sec of sections) {
    if (sec.id !== 10) continue;
    let pos = sec.contentOffset;
    const [, funcCountBytes] = readLEB128(src, pos);
    pos += funcCountBytes;

    // Skip to the exported function's body
    for (let i = 0; i < exportCodeEntry; i++) {
      const [bodySize, bodySizeBytes] = readLEB128(src, pos);
      pos += bodySizeBytes + bodySize;
    }
    const [, bodySizeBytes] = readLEB128(src, pos);
    pos += bodySizeBytes;
    // Skip locals
    const [localCount, lcBytes] = readLEB128(src, pos);
    pos += lcBytes;
    for (let i = 0; i < localCount; i++) {
      const [, n] = readLEB128(src, pos);
      pos += n;
      pos++;
    }

    // i32.const = 0x41, i64.const = 0x42 (wasm64 uses i64 for addresses)
    const I32_CONST = 0x41;
    const I64_CONST = 0x42;

    // Pattern 1: direct export — starts with i32.const/i64.const <offset>
    if (src[pos] === I32_CONST || src[pos] === I64_CONST) {
      pos++;
      const [tlsOffset] = readLEB128(src, pos);
      return tlsOffset;
    }

    // Pattern 3: instrumented/optimized — global.get <tls_base>; i32/i64.const <offset>; i32/i64.add
    if (src[pos] === 0x23) {
      let p3 = pos + 1;
      const [, globalIdxBytes] = readLEB128(src, p3);
      p3 += globalIdxBytes;
      if (src[p3] === I32_CONST || src[p3] === I64_CONST) {
        p3++;
        const [tlsOffset] = readLEB128(src, p3);
        return tlsOffset;
      }
    }

    // Pattern 2: wrapper — call <ctors>; call <actual>; end
    if (src[pos] !== 0x10) return -1;
    pos++;
    const [, ctorIdxBytes] = readLEB128(src, pos);
    pos += ctorIdxBytes;
    if (src[pos] !== 0x10) return -1;
    pos++;
    const [actualFuncIdx] = readLEB128(src, pos);

    const actualCodeEntry = actualFuncIdx - numFuncImports;
    if (actualCodeEntry < 0) return -1;

    let pos2 = sec.contentOffset;
    const [, fcb2] = readLEB128(src, pos2);
    pos2 += fcb2;
    for (let i = 0; i < actualCodeEntry; i++) {
      const [bs, bsb] = readLEB128(src, pos2);
      pos2 += bsb + bs;
    }
    const [, bsb2] = readLEB128(src, pos2);
    pos2 += bsb2;
    const [lc2, lcb2] = readLEB128(src, pos2);
    pos2 += lcb2;
    for (let i = 0; i < lc2; i++) {
      const [, n] = readLEB128(src, pos2);
      pos2 += n;
      pos2++;
    }

    if (src[pos2] !== I32_CONST && src[pos2] !== I64_CONST) return -1;
    pos2++;
    const [tlsOffset] = readLEB128(src, pos2);
    return tlsOffset;
  }

  return -1;
}

function setupChannelBase(
  instance: WebAssembly.Instance,
  module: WebAssembly.Module,
  memory: WebAssembly.Memory,
  channelOffset: number,
  programBytes?: ArrayBuffer,
  ptrWidth: 4 | 8 = 4,
): void {
  // If the module imports env.__channel_base as a global, the channel offset was
  // already set at instantiation via WebAssembly.Global in buildImportObject.
  const moduleImports = wasmModuleImports(module);
  if (
    moduleImports.some(
      (i) =>
        i.module === "env" &&
        i.name === "__channel_base" &&
        i.kind === "global",
    )
  ) {
    return;
  }

  // Legacy TLS-based approach: write channelOffset into the TLS slot.
  const tlsBase = instance.exports.__tls_base as WebAssembly.Global | undefined;
  const view = new DataView(memory.buffer);
  const tlsAddr = tlsBase ? Number(tlsBase.value) : 0;

  if (tlsAddr > 0) {
    let detectedOffset = -1;
    if (programBytes) {
      detectedOffset = detectChannelBaseTlsOffset(programBytes);
    }
    const addr = tlsAddr + (detectedOffset >= 0 ? detectedOffset : 0);
    if (ptrWidth === 8) {
      view.setBigUint64(addr, BigInt(channelOffset), true);
    } else {
      view.setUint32(addr, channelOffset, true);
    }
  }
}

/**
 * Send SYS_FORK through the channel and wait for the result.
 * Returns child pid on success, or -errno on failure.
 */
function sendForkSyscall(
  memory: WebAssembly.Memory,
  channelOffset: number,
  mode: ProcessForkMode,
  borrowedReplay?: ForkBorrowedReplayWorkspaceRequirements,
): number {
  const view = new DataView(memory.buffer);
  view.setInt32(
    channelOffset + CH_SYSCALL,
    processForkSyscall(mode),
    true,
  );
  for (let i = 0; i < 6; i++) {
    view.setBigInt64(channelOffset + CH_ARGS + i * CH_ARG_SIZE, 0n, true);
  }
  if (mode === PROCESS_FORK_MODE_VFORK) {
    if (!borrowedReplay) {
      throw new Error("vfork capture is missing borrowed replay workspace");
    }
    view.setBigInt64(
      channelOffset + CH_ARGS,
      BigInt(borrowedReplay.prefixBytes),
      true,
    );
    view.setBigInt64(
      channelOffset + CH_ARGS + CH_ARG_SIZE,
      BigInt(borrowedReplay.scratchBytes),
      true,
    );
  }

  markDeferredSignalDelivery(view, channelOffset);
  const i32 = new Int32Array(memory.buffer);
  Atomics.store(i32, (channelOffset + CH_STATUS) / 4, CHANNEL_STATUS_PENDING);
  Atomics.notify(i32, (channelOffset + CH_STATUS) / 4, 1);
  while (
    Atomics.wait(
      i32,
      (channelOffset + CH_STATUS) / 4,
      CHANNEL_STATUS_PENDING,
    ) === "ok"
  ) {
    /* */
  }

  const result = Number(view.getBigInt64(channelOffset + CH_RETURN, true));
  const err = view.getUint32(channelOffset + CH_ERRNO, true);
  clearDeferredSignalDelivery(view, channelOffset);
  Atomics.store(i32, (channelOffset + CH_STATUS) / 4, CHANNEL_STATUS_IDLE);

  if (err) return -err;
  return result;
}

/**
 * Patch a Wasm binary for use in a thread instance (shared memory).
 *
 * In LLVM's shared-memory Wasm model:
 * - The Start function (section id=8) is `__wasm_init_memory` — it initializes
 *   passive data segments with an atomic guard. Threads must NOT re-run this.
 * - A separate constructor function (`__wasm_call_ctors`) runs C++ global
 *   constructors. LLVM inserts a `call` to this function at the beginning of
 *   every exported function. Threads must NOT re-run constructors either, as
 *   they would clobber shared global state (e.g. resetting LOGGER::file_log_handler
 *   to NULL in MariaDB).
 *
 * This function:
 * 1. Removes the Start section so `__wasm_init_memory` doesn't auto-run.
 * 2. Finds the constructor function by scanning the known LLVM helper exports
 *    for their common call target and replaces that function body with a no-op.
 */
export function patchWasmForThread(bytes: ArrayBuffer): ArrayBuffer {
  const src = new Uint8Array(bytes);
  if (src.length < 8) return bytes;

  function readLEB128(buf: Uint8Array, off: number): [number, number] {
    let result = 0;
    let shift = 0;
    let pos = off;
    for (;;) {
      const byte = buf[pos++];
      result |= (byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) break;
      shift += 7;
    }
    return [result, pos - off];
  }

  function encodeLEB128(value: number): number[] {
    const result: number[] = [];
    do {
      let byte = value & 0x7f;
      value >>>= 7;
      if (value !== 0) byte |= 0x80;
      result.push(byte);
    } while (value !== 0);
    return result;
  }

  // Parse all sections
  interface Section {
    id: number;
    offset: number;
    totalSize: number;
    contentOffset: number;
    contentSize: number;
  }
  const sections: Section[] = [];
  let numFuncImports = 0;
  let hasStartSection = false;
  let offset = 8;

  while (offset < src.length) {
    const sectionId = src[offset];
    const [sectionSize, sizeBytes] = readLEB128(src, offset + 1);
    const contentOffset = offset + 1 + sizeBytes;
    const totalSize = 1 + sizeBytes + sectionSize;
    sections.push({
      id: sectionId,
      offset,
      totalSize,
      contentOffset,
      contentSize: sectionSize,
    });
    if (sectionId === 8) hasStartSection = true;
    offset += totalSize;
  }

  if (!hasStartSection) return bytes;

  // WHY: import descriptors can contain recursive GC types, multi-byte
  // concrete references, table64 limits, and tags. Use the same exact binary
  // parser as ABI admission: WebKit can compile these modules while refusing
  // to expose their import descriptors through engine reflection.
  numFuncImports = readWasmImportDescriptors(bytes)
    .filter((entry) => entry.kind === "function").length;

  // Find the constructor function from executable linker evidence. Custom
  // name sections are optional debug metadata and cannot authorize a body
  // rewrite.
  // Plain lld output puts `call $__wasm_call_ctors` first. After
  // wasm-fork-instrument, wrappers have a rewind prolog before the original
  // body, so scan instructions and choose the call target shared by the known
  // helper exports instead of assuming opcode 0 is the constructor call.
  let ctorFuncIndex = -1;
  let exportedFuncIndices: number[] = [];
  const exportFuncIndicesByName = new Map<string, number>();

  // Collect exported function indices from Export section (id=7)
  for (const sec of sections) {
    if (sec.id === 7) {
      let pos = sec.contentOffset;
      const [exportCount, countBytes] = readLEB128(src, pos);
      pos += countBytes;
      for (let i = 0; i < exportCount; i++) {
        const [nameLen, nameLenBytes] = readLEB128(src, pos);
        pos += nameLenBytes;
        const name = new TextDecoder().decode(src.subarray(pos, pos + nameLen));
        pos += nameLen;
        const kind = src[pos++];
        const [idx, idxBytes] = readLEB128(src, pos);
        pos += idxBytes;
        if (kind === 0) {
          // function export
          exportedFuncIndices.push(idx);
          exportFuncIndicesByName.set(name, idx);
        }
      }
      break;
    }
  }

  function skipLEB(pos: number): number {
    const [, n] = readLEB128(src, pos);
    return pos + n;
  }

  function skipMemArg(pos: number): number {
    pos = skipLEB(pos); // alignment
    return skipLEB(pos); // offset
  }

  function skipValueType(pos: number): number {
    const kind = src[pos++];
    // `(ref null <heaptype>)` and `(ref <heaptype>)` carry a signed
    // heap-type/type-index LEB. Abstract shorthand references and all numeric
    // value types are single-byte encodings.
    return kind === 0x63 || kind === 0x64 ? skipLEB(pos) : pos;
  }

  function skipBlockType(pos: number): number {
    const kind = src[pos];
    if (kind === 0x40) return pos + 1; // empty
    if (
      (kind >= 0x7b && kind <= 0x7f) ||
      (kind >= 0x65 && kind <= 0x70) ||
      kind === 0x63 ||
      kind === 0x64
    ) {
      return skipValueType(pos);
    }
    return skipLEB(pos); // signed type index
  }

  function getInstructionStartAndEnd(
    codeSection: Section,
    funcIndex: number,
  ): { start: number; end: number } | null {
    const codeEntry = funcIndex - numFuncImports;
    if (codeEntry < 0) return null;

    let pos = codeSection.contentOffset;
    const [funcCount, funcCountBytes] = readLEB128(src, pos);
    pos += funcCountBytes;
    if (codeEntry >= funcCount) return null;

    for (let i = 0; i < codeEntry; i++) {
      const [bodySize, bodySizeBytes] = readLEB128(src, pos);
      pos += bodySizeBytes + bodySize;
    }

    const [bodySize, bodySizeBytes] = readLEB128(src, pos);
    pos += bodySizeBytes;
    const bodyEnd = pos + bodySize;

    const [localCount, localCountBytes] = readLEB128(src, pos);
    pos += localCountBytes;
    for (let i = 0; i < localCount; i++) {
      pos = skipLEB(pos); // count
      pos = skipValueType(pos);
    }

    return { start: pos, end: bodyEnd };
  }

  function scanCallTargets(codeSection: Section, funcIndex: number): number[] {
    const bounds = getInstructionStartAndEnd(codeSection, funcIndex);
    if (!bounds) return [];

    const calls: number[] = [];
    let pos = bounds.start;
    while (pos < bounds.end) {
      const op = src[pos++];
      if (op === 0x10) {
        // call
        const [target, n] = readLEB128(src, pos);
        pos += n;
        calls.push(target);
      } else if (op === 0x11 || op === 0x13) {
        // call_indirect / return_call_indirect
        pos = skipLEB(pos);
        pos = skipLEB(pos);
      } else if (op === 0x12 || op === 0x14 || op === 0x15) {
        pos = skipLEB(pos);
      } else if (op === 0x02 || op === 0x03 || op === 0x04) {
        pos = skipBlockType(pos);
      } else if (
        op === 0x0c ||
        op === 0x0d ||
        (op >= 0x20 && op <= 0x26) ||
        op === 0xd0 ||
        op === 0xd2
      ) {
        pos = skipLEB(pos);
      } else if (op === 0x0e) {
        // br_table
        const [count, n] = readLEB128(src, pos);
        pos += n;
        for (let i = 0; i <= count; i++) pos = skipLEB(pos);
      } else if (op >= 0x28 && op <= 0x3e) {
        pos = skipMemArg(pos);
      } else if (op === 0x3f || op === 0x40) {
        pos++;
      } else if (op === 0x41 || op === 0x42) {
        pos = skipLEB(pos);
      } else if (op === 0x43) {
        pos += 4;
      } else if (op === 0x44) {
        pos += 8;
      } else if (op === 0xfc) {
        const [subop, n] = readLEB128(src, pos);
        pos += n;
        if (subop === 8 || subop === 10 || subop === 12 || subop === 14) {
          pos = skipLEB(skipLEB(pos));
        } else if (subop >= 9 && subop <= 17) {
          pos = skipLEB(pos);
        }
      } else if (op === 0xfe) {
        pos = skipLEB(pos);
        pos = skipMemArg(pos);
      } else if (op === 0xfd) {
        // SIMD is not expected in the helper wrappers. Stop before treating
        // SIMD immediates as opcodes and collecting false call targets.
        break;
      } else {
        // Most numeric, parametric, and control opcodes have no immediates.
      }
    }
    return calls;
  }

  const ctorCandidates = new Map<number, string[]>();
  const addCtorCandidate = (index: number | undefined, source: string): void => {
    if (index === undefined) return;
    const sources = ctorCandidates.get(index) ?? [];
    sources.push(source);
    ctorCandidates.set(index, sources);
  };
  addCtorCandidate(
    exportFuncIndicesByName.get("__wasm_call_ctors"),
    "function export",
  );

  // Find the Code section and identify a call target shared by LLVM helper
  // exports. Instrumented wrappers can have a rewind prolog, so a shared
  // executable target is stronger evidence than a fixed instruction offset.
  for (const sec of sections) {
    if (sec.id === 10 && exportedFuncIndices.length > 0) {
      const helperNames = [
        "__wasm_init_tls",
        "__abi_version",
        "__get_channel_base_addr",
        "_start",
        "__wasm_thread_init",
      ];
      const counts = new Map<number, { count: number; firstOrder: number }>();
      let order = 0;
      for (const name of helperNames) {
        const funcIndex = exportFuncIndicesByName.get(name);
        if (funcIndex === undefined) continue;
        const perFunction = new Set(
          scanCallTargets(sec, funcIndex).filter(
            (target) => target >= numFuncImports,
          ),
        );
        for (const target of perFunction) {
          const entry = counts.get(target);
          if (entry) {
            entry.count++;
          } else {
            counts.set(target, { count: 1, firstOrder: order++ });
          }
        }
      }

      let best: { target: number; count: number; firstOrder: number } | null =
        null;
      for (const [target, value] of counts) {
        if (
          value.count >= 2 &&
          (!best ||
            value.count > best.count ||
            (value.count === best.count && value.firstOrder < best.firstOrder))
        ) {
          best = { target, count: value.count, firstOrder: value.firstOrder };
        }
      }

      if (best) addCtorCandidate(best.target, "shared linker wrappers");

      // A validated ABI marker is itself a linker wrapper in small legacy
      // modules. Its leading direct call is authoritative even when there is
      // no second helper export with which to intersect it.
      const abiMarkerIndex = exportFuncIndicesByName.get("__abi_version");
      if (abiMarkerIndex !== undefined && extractAbiVersion(bytes) !== null) {
        const bounds = getInstructionStartAndEnd(sec, abiMarkerIndex);
        if (bounds && src[bounds.start] === 0x10) {
          const [target] = readLEB128(src, bounds.start + 1);
          addCtorCandidate(target, "__abi_version linker wrapper");
        }
      }
      break;
    }
  }

  if (ctorCandidates.size > 1) {
    const evidence = [...ctorCandidates]
      .map(([index, sources]) => `${index} (${sources.join(", ")})`)
      .join("; ");
    throw new Error(`Conflicting __wasm_call_ctors evidence: ${evidence}`);
  }
  ctorFuncIndex = ctorCandidates.keys().next().value ?? -1;

  const ctorCodeEntry =
    ctorFuncIndex >= 0 ? ctorFuncIndex - numFuncImports : -1;
  if (ctorFuncIndex >= 0) {
    const arity = readWasmFunctionArity(bytes, ctorFuncIndex);
    if (ctorCodeEntry < 0 || arity === null) {
      throw new Error(
        `__wasm_call_ctors function ${ctorFuncIndex} has no defined function body`,
      );
    }
    if (arity.parameters !== 0 || arity.results !== 0) {
      throw new Error(
        `__wasm_call_ctors function ${ctorFuncIndex} must have type () -> (), `
          + `found ${arity.parameters} parameter(s) and ${arity.results} result(s)`,
      );
    }
  }

  // Build output: always skip Start section; optionally neuter constructor function
  const chunks: Uint8Array[] = [];
  chunks.push(src.subarray(0, 8)); // Wasm header

  for (const sec of sections) {
    if (sec.id === 8) {
      continue; // Skip start section
    }

    if (sec.id === 10 && ctorCodeEntry >= 0) {
      // Code section: replace constructor function body with no-op
      let pos = sec.contentOffset;
      const [funcCount, funcCountBytes] = readLEB128(src, pos);
      pos += funcCountBytes;

      // Locate the constructor function body
      let targetBodyStart = pos;
      for (let i = 0; i < ctorCodeEntry; i++) {
        const [bodySize, bodySizeBytes] = readLEB128(src, targetBodyStart);
        targetBodyStart += bodySizeBytes + bodySize;
      }
      const [origBodySize, origBodySizeBytes] = readLEB128(
        src,
        targetBodyStart,
      );
      const origBodyEnd = targetBodyStart + origBodySizeBytes + origBodySize;

      // New body: size=2, content = 0x00 (0 locals) + 0x0B (end)
      const newBody = new Uint8Array([2, 0, 0x0b]);

      // Compute new section content size
      const beforeTarget = targetBodyStart - sec.contentOffset;
      const afterTarget = sec.contentOffset + sec.contentSize - origBodyEnd;
      const newContentSize = beforeTarget + newBody.length + afterTarget;
      const newSectionSizeBytes = encodeLEB128(newContentSize);

      chunks.push(new Uint8Array([10])); // section id
      chunks.push(new Uint8Array(newSectionSizeBytes));
      chunks.push(src.subarray(sec.contentOffset, targetBodyStart)); // func count + bodies before target
      chunks.push(newBody); // patched function body
      chunks.push(
        src.subarray(origBodyEnd, sec.contentOffset + sec.contentSize),
      ); // bodies after target
    } else {
      // Copy section as-is
      chunks.push(src.subarray(sec.offset, sec.offset + sec.totalSize));
    }
  }

  // Concatenate chunks
  const totalLen = chunks.reduce((acc, c) => acc + c.length, 0);
  const out = new Uint8Array(totalLen);
  let pos = 0;
  for (const chunk of chunks) {
    out.set(chunk, pos);
    pos += chunk.length;
  }
  return out.buffer;
}

/**
 * Thread worker entry point.
 *
 * Threads share the parent process's Memory. This function:
 * 1. Instantiates the same Wasm module with shared memory (start section stripped)
 * 2. Allocates TLS for the thread
 * 3. Sets the channel base and stack pointer
 * 4. Calls the thread function via the indirect function table
 * 5. On return: performs CLONE_CHILD_CLEARTID (write 0 + futex wake at ctidPtr)
 *
 * If the thread function calls fork(), this entry point drives the
 * `wpk_fork_*` unwind/SYS_FORK/rewind loop just like the main process worker,
 * but rooted at the pthread function and this thread's channel-local fork
 * buffer.
 */
/**
 * Build the JS argument list for calling a wasm pthread entry function through
 * the indirect function table.
 *
 * Kandelo user programs are post-processed with binaryen's `--fpcast-emu` (see
 * optimize_wasm in scripts/ports/*), which rewrites every indirectly-called
 * function — including pthread entry points, which the host reaches via
 * `table.get(fnPtr)` — to a single uniform trampoline signature with N i64
 * parameters and an i64 result. Calling such a trampoline with the plain C ABI
 * (`fn(argPtr)` where argPtr is a JS number) throws
 * `TypeError: Cannot convert <n> to a BigInt`, because the first parameter is
 * i64. This surfaced as the first fork-instrumented *and* threaded program
 * (pcmanfm) crashing on its first worker thread.
 *
 * A plain (un-emulated) entry has exactly one pointer parameter, so the
 * function wrapper's parameter count distinguishes the two: `length <= 1` is the
 * plain C ABI (i32 pointer on wasm32, i64 on wasm64); `length > 1` is the
 * fpcast-emu trampoline, whose parameters are all i64 — pass the pointer arg
 * first as a BigInt and zero-fill the remaining slots.
 */
function buildThreadEntryArgs(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  threadFn: (...args: any[]) => unknown,
  argPtr: number,
  ptrWidth: number,
): (number | bigint)[] {
  const argc = threadFn.length;
  if (argc <= 1) {
    const arg = ptrWidth === 8 ? BigInt(argPtr) : argPtr;
    return argc === 0 ? [] : [arg];
  }
  const args: (number | bigint)[] = new Array(argc).fill(0n);
  args[0] = BigInt(argPtr);
  return args;
}

export async function centralizedThreadWorkerMain(
  port: MessagePort,
  initData: CentralizedThreadInitMessage,
): Promise<void> {
  const {
    memory,
    processChannelOffset,
    channelOffset,
    pid,
    tid,
    fnPtr,
    argPtr,
    stackPtr,
    tlsPtr,
    ctidPtr,
  } = initData;
  const tlsOffset = initData.tlsOffset ?? initData.tlsAllocAddr;
  const ptrWidth = initData.ptrWidth ?? 4;

  // WHY: synchronize the received memory before this isolate binds any view
  // or Wasm instance to a possibly stale fixed-length view of its backing.
  synchronizeReceivedSharedWasmMemory(memory, ptrWidth);

  let threadInstance: WebAssembly.Instance | undefined;
  let threadProcessContinuation: ForkProcessContinuationCoordinator | null =
    null;
  let threadTableReplication: ProcessTableReplicationOwner | null = null;
  let threadHostImportRuntime: ForkHostImportWorkerRuntime | null = null;
  let threadExternrefTokens: ForkExternrefTokenCache | null = null;
  let processDlopenLock: Int32Array | undefined;
  let processDlopenOwner: Int32Array | undefined;
  let pthreadForkLockHeld = false;
  const acquirePthreadForkLock = (): boolean => {
    if (!processDlopenLock || !processDlopenOwner) {
      throw new Error(
        `pid=${pid} tid=${tid}: missing process dlopen ownership`,
      );
    }
    if (pthreadForkLockHeld) {
      throw new Error(`pid=${pid} tid=${tid}: pthread fork lock already held`);
    }
    for (;;) {
      const transactionOwner = Atomics.load(processDlopenOwner, 0);
      if (transactionOwner !== DLOPEN_OWNER_IDLE && transactionOwner !== tid) {
        Atomics.wait(processDlopenOwner, 0, transactionOwner);
        continue;
      }
      const owner = Atomics.load(processDlopenLock, 0);
      if (owner < DLOPEN_LOCK_IDLE) {
        // dlopen is finite and publishes the archive generation before
        // releasing this writer token. Waiting preserves ordinary pthread
        // fork/dlopen semantics instead of exposing a scheduler race as
        // ENOTSUP.
        Atomics.wait(processDlopenLock, 0, owner);
        continue;
      }
      if (owner >= DLOPEN_LOCK_MAX_READERS) {
        throw new Error(
          `pid=${pid} tid=${tid}: process dlopen lock reader overflow`,
        );
      }
      if (
        Atomics.compareExchange(processDlopenLock, 0, owner, owner + 1) ===
        owner
      ) {
        pthreadForkLockHeld = true;
        return true;
      }
    }
  };
  const releasePthreadForkLock = (): void => {
    if (!pthreadForkLockHeld || !processDlopenLock) return;
    for (;;) {
      const owner = Atomics.load(processDlopenLock, 0);
      if (owner <= DLOPEN_LOCK_IDLE) {
        pthreadForkLockHeld = false;
        throw new Error(
          `pid=${pid} tid=${tid}: pthread fork lost reader ownership ` +
            `(state=${owner})`,
        );
      }
      if (
        Atomics.compareExchange(processDlopenLock, 0, owner, owner - 1) ===
        owner
      ) {
        pthreadForkLockHeld = false;
        if (owner === 1) Atomics.notify(processDlopenLock, 0);
        return;
      }
    }
  };

  try {
    // Strip the start section AND neuter the constructor function body to prevent
    // constructors from re-running. Thread instances share memory with the main
    // thread; re-running constructors would clobber global state.
    let programBytes: ArrayBuffer | null = null;
    if (!initData.programModule) {
      programBytes = patchWasmForThread(initData.programBytes);
    }
    const module = initData.programModule
      ? initData.programModule
      : new WebAssembly.Module(programBytes!);
    registerWasmModuleReflection(
      module,
      programBytes ?? initData.programBytes,
    );

    const hasForkInstrumentation = hasCompleteForkInstrumentation(module, pid);
    if (hasForkInstrumentation) {
      if (
        initData.forkHostImports === undefined ||
        initData.externrefGenerationId === undefined
      ) {
        throw new Error(
          `pid=${pid} tid=${tid}: ABI 43 fork artifact requires its process ` +
            "owner host-import mailbox and externref generation",
        );
      }
      threadExternrefTokens = new ForkExternrefTokenCache(
        initData.externrefGenerationId,
      );
      threadHostImportRuntime = new ForkHostImportWorkerRuntime(
        initData.forkHostImports,
        pid,
        initData.externrefGenerationId,
        threadExternrefTokens,
        (wake) => {
          port.postMessage({
            type: "fork_host_import",
            wake,
          } satisfies WorkerToHostMessage);
        },
      );
    }
    const threadForkCapabilityClaim = readForkInstrumentCapabilityClaim(module);
    const hasDylinkForkRole = forkInstrumentRoleAvailable(
      threadForkCapabilityClaim,
      FORK_CAP_DYLINK_MAIN,
    );
    let forkBufAddr = 0;
    const forkAnchorAddr = channelOffset - FORK_BUF_SIZE;
    // The co-resident Rust module owns all frame/journal/resume storage
    // (Phase 4 point of no return); the coordinator only needs the format.
    const threadForkContinuation: ForkActivationContinuation | null =
      hasForkInstrumentation
        ? { format: readLinkedFrameFormat(module) }
        : null;
    const threadTemplateId = hasForkInstrumentation
      ? await computeForkModuleTemplateId(initData.programBytes)
      : null;
    const newThreadModuleStateArena = (): ForkModuleStateArena =>
      new ForkModuleStateArena(
        memory,
        ptrWidth,
        (size) =>
          continuationMmap(
            memory,
            channelOffset,
            size,
            `pid=${pid} tid=${tid}: module state`,
          ),
        (addr, size) =>
          continuationMunmap(
            memory,
            channelOffset,
            addr,
            size,
            `pid=${pid} tid=${tid}: module state`,
          ),
        `pid=${pid} tid=${tid}`,
      );
    const threadActivationRegistry = hasForkInstrumentation
      ? new ForkActivationRegistry(
          memory,
          new ForkExternrefTokenRecipeProvider(
            threadExternrefTokens!,
            (value) =>
              threadHostImportRuntime!.localExceptions.normalizeUnclaimedForkValue(
                value,
              ),
          ),
          `pid=${pid} tid=${tid}: fork activations`,
          (size) =>
            continuationMmap(
              memory,
              channelOffset,
              size,
              `pid=${pid} tid=${tid}: reference scratch`,
            ),
          (addr, size) =>
            continuationMunmap(
              memory,
              channelOffset,
              addr,
              size,
              `pid=${pid} tid=${tid}: reference scratch`,
            ),
        )
      : null;
    const threadImportedStateCapture = threadActivationRegistry
      ? new ForkImportedGlobalCapture(
          `pid=${pid} tid=${tid}: imported activation state`,
        )
      : null;
    threadProcessContinuation = threadActivationRegistry
      ? new ForkProcessContinuationCoordinator(
          memory,
          threadActivationRegistry,
          `pid=${pid} tid=${tid}: process continuation`,
        )
      : null;
    const threadExceptionBroker = threadActivationRegistry
      ? new ForkExceptionBroker(
          threadActivationRegistry,
          `pid=${pid} tid=${tid}: exception broker`,
          undefined,
          (value) =>
            threadHostImportRuntime!.localExceptions.normalizeUnclaimedForkException(
              value,
            ),
        )
      : null;
    let threadExceptionProvider: ForkExceptionProvider | null = null;
    if (threadProcessContinuation && threadForkContinuation) {
      threadProcessContinuation.prepareActivation({
        activationId: 0,
        continuation: threadForkContinuation,
        publishProcessLaunchRoot: (address) => {
          writeForkContinuationAnchor(
            memory,
            forkAnchorAddr,
            ptrWidth,
            address,
          );
          forkBufAddr = address;
        },
        readProcessLaunchRoot: () => {
          const view = new DataView(memory.buffer);
          return ptrWidth === 8
            ? Number(view.getBigUint64(forkAnchorAddr, true))
            : view.getUint32(forkAnchorAddr, true);
        },
      });
    }
    // Phase 6 D7b: wire the co-resident fork-module into the PTHREAD PARENT
    // worker so a fork issued FROM a thread unwinds/serializes/parent-replays
    // through the module — the parent SIDE of a fork-from-thread. Without this
    // the parent would journal through the JS closures while the child (admitted
    // above on the main worker path) expects to read the MODULE-serialized KFRE
    // journal image from the frame arena; the two sides must move together. This
    // mirrors the main process worker's instantiate + backend + enableModuleBacking
    // block (width match + catalog fits the cap). The co-resident module is now
    // the UNCONDITIONAL fork engine (no JS reference fallback), so a pthread
    // parent MUST capture through it — including one in a dlopen-capable program
    // (`hasDylinkForkRole`): the pthread parent only unwinds + serializes, and
    // the multi-activation RECONSTRUCTION runs in the fresh child on the main
    // worker path. (The earlier `!hasDylinkForkRole` single-activation gate would
    // now leave a dlopen pthread with no capture module and hang its fork.) The
    // pthread parent never reconstructs references (that happens in the child),
    // so `resolve_externref` is wired (below, for identity parity) but expected
    // to stay idle here. (The `wpk_fork_host.*` seam this comment used to
    // describe was deleted, H3, 2026-09-06 — the module no longer declares those
    // imports at all.) Phase 3: a catalog past the (raised) module cap now FAILS
    // LOUD here — the cap is a module-BSS structure that holds every real guest's
    // catalog, so an overflow is a genuine module-capacity boundary, never a
    // silent drop to the (Phase 4: to-be-deleted) JS continuation twin.
    let threadForkModuleInstance: ForkModuleInstance | null = null;
    let threadForkModuleBackend: ForkModuleContinuationBackend | null = null;
    if (
      hasForkInstrumentation &&
      threadProcessContinuation &&
      threadForkContinuation
    ) {
      const forkModuleModule = initData.forkModuleModule;
      if (!forkModuleModule) {
        throw new Error(
          `pid=${pid} tid=${tid}: fork-instrumented worker requires the ` +
            "co-resident fork module",
        );
      }
      const linkedFrameFormat = readLinkedFrameFormat(module);
      if (ptrWidth !== linkedFrameFormat.ptrWidth) {
        throw new Error(
          `pid=${pid} tid=${tid}: fork-module width mismatch: process ptrWidth ` +
            `${ptrWidth} vs linked frames ${linkedFrameFormat.ptrWidth}`,
        );
      }
      const catalogOrdinals = readForkResumeCatalog(module).map(
        (entry) => entry.functionOrdinal,
      );
      if (catalogOrdinals.length > FORK_MODULE_RESUME_CATALOG_CAP) {
        throw new Error(
          `pid=${pid} tid=${tid}: resume catalog of ${catalogOrdinals.length} ` +
            `exceeds the fork-module cap ${FORK_MODULE_RESUME_CATALOG_CAP}`,
        );
      }
      {
        // M2: wire the same `resolve_externref` body as the process/parent
        // path (using this pthread's own externref token cache, established
        // above alongside `threadHostImportRuntime`). The pthread-parent
        // module never actually reconstructs references (that happens on the
        // fork CHILD side, in the process worker's module instance) — it only
        // drives the frame/KFRE journal — so this seam is expected to stay
        // idle here, but it is wired for real rather than left on the
        // fail-loud default so identity stays consistent if that ever
        // changes.
        threadForkModuleInstance = instantiateForkModule({
          module: forkModuleModule,
          memory,
          ptrWidth,
          reserve: (size) =>
            continuationMmap(
              memory,
              channelOffset,
              size,
              `pid=${pid} tid=${tid}: fork-module`,
            ),
          label: `pid=${pid} tid=${tid}: fork-module`,
          resolveExternref: (handle) =>
            threadExternrefTokens!.materialize(handle),
        });
        // STORE #2: on this path the thread registry is created BEFORE the
        // fork-module (unlike the process path), and its `enableModuleBacking`
        // gate below requires `threadProcessContinuation` — itself built from
        // the registry — to already exist, so the registry cannot simply be
        // constructed after the module. Instead, ADOPT the module's own
        // exported transit table into the already-built registry so the
        // guest's `__wpk_fork_ref_gc_transit` import (bound later by
        // `buildForkActivationStateImports`, well below) and the module's
        // drive integrity check read the exact same table. This happens
        // before any activation import is built and before any fork capture.
        threadActivationRegistry!.adoptGcTransit(
          threadForkModuleInstance.gcTransitTable,
        );
        // Stage into the dedicated slab inside this thread's fork-module region
        // rather than a growing channel mmap (see the process-worker path for
        // the full rationale): keeps the staging from permanently growing the
        // shared process memory a fork-from-thread child would clone.
        const threadForkModuleStagingBase = threadForkModuleInstance.stagingBase;
        const threadForkModuleStagingBytes =
          threadForkModuleInstance.stagingBytes;
        threadForkModuleBackend = new ForkModuleContinuationBackend({
          exports: threadForkModuleInstance.exports,
          driveTable: threadForkModuleInstance.driveTable,
          memory,
          ptrWidth,
          format: linkedFrameFormat,
          catalogOrdinals,
          // Option B: the module channel-mmaps its per-fork frame chunks + the
          // journal image on demand via `SYS_mmap` → the kernel `find_gap`
          // allocator (dynamic, kernel-tracked). `channelBase` also backs the
          // small pre-fork catalog scratch.
          channelBase: channelOffset,
          reserveRegion: (size) =>
            size <= threadForkModuleStagingBytes
              ? threadForkModuleStagingBase
              : continuationMmap(
                  memory,
                  channelOffset,
                  size,
                  `pid=${pid} tid=${tid}: fork-module catalog scratch`,
                ),
          releaseRegion: (addr, size) => {
            if (addr === threadForkModuleStagingBase) return;
            continuationMunmap(
              memory,
              channelOffset,
              addr,
              size,
              `pid=${pid} tid=${tid}: fork-module catalog scratch`,
            );
          },
          pid,
          label: `pid=${pid} tid=${tid}: fork-module`,
        });
        threadForkModuleBackend.setup();
        threadProcessContinuation.enableModuleBacking(threadForkModuleBackend);
        // Path-A A4 parity: route this pthread worker's peer-table CAPTURE
        // through the co-resident module (the process path does this at
        // `setCaptureModule` above). Peer-table replication is module-only now,
        // so a pthread that publishes a full table checkpoint needs the capture
        // module just as the process parent does.
        threadActivationRegistry?.setCaptureModule(
          new ForkReferenceCaptureModule(
            threadForkModuleInstance.exports,
            memory,
            `pid=${pid} tid=${tid}: fork reference capture module`,
          ),
        );
      }
    }
    const processArchiveHeadOffset =
      ptrWidth === 8 ? DLOPEN_HEAD_OFFSET_WASM64 : DLOPEN_HEAD_OFFSET_WASM32;
    const processArchiveHeadAddr =
      processChannelOffset - FORK_BUF_SIZE - processArchiveHeadOffset;
    const processArchiveLockOffset =
      ptrWidth === 8 ? DLOPEN_LOCK_OFFSET_WASM64 : DLOPEN_LOCK_OFFSET_WASM32;
    const processArchiveLockAddr =
      processChannelOffset - FORK_BUF_SIZE - processArchiveLockOffset;
    const processArchiveOwnerOffset =
      ptrWidth === 8 ? DLOPEN_OWNER_OFFSET_WASM64 : DLOPEN_OWNER_OFFSET_WASM32;
    const processArchiveOwnerAddr =
      processChannelOffset - FORK_BUF_SIZE - processArchiveOwnerOffset;
    if (
      !Number.isSafeInteger(processArchiveHeadAddr) ||
      processArchiveHeadAddr <= 0 ||
      processArchiveHeadAddr + ptrWidth > memory.buffer.byteLength ||
      !Number.isSafeInteger(processArchiveLockAddr) ||
      processArchiveLockAddr <= 0 ||
      processArchiveLockAddr + 4 > memory.buffer.byteLength ||
      !Number.isSafeInteger(processArchiveOwnerAddr) ||
      processArchiveOwnerAddr <= 0 ||
      processArchiveOwnerAddr + 4 > memory.buffer.byteLength
    ) {
      throw new Error(
        `pid=${pid} tid=${tid}: invalid process dlopen archive anchor ` +
          `${String(processArchiveHeadAddr)}`,
      );
    }
    processDlopenLock = new Int32Array(
      memory.buffer,
      processArchiveLockAddr,
      1,
    );
    processDlopenOwner = new Int32Array(
      memory.buffer,
      processArchiveOwnerAddr,
      1,
    );
    const processArchiveControlAddr = processChannelOffset - FORK_BUF_SIZE;
    const processGenerationOffset =
      ptrWidth === 8
        ? DLOPEN_GENERATION_OFFSET_WASM64
        : DLOPEN_GENERATION_OFFSET_WASM32;
    const processGenerationAddress =
      processArchiveControlAddr - processGenerationOffset;
    const threadTableReplicationImports: ForkActivationTableReplication = {
      generationAddress: new WebAssembly.Global(
        { value: "i64", mutable: false },
        BigInt(processGenerationAddress),
      ),
      reconcile: (): bigint => threadTableReplication?.reconcile() ?? 0n,
      beginMutation: (): bigint =>
        threadTableReplication?.beginMutation() ?? 0n,
      commit: (activationId, ownerId, firstIndex, length): void => {
        threadTableReplication?.commit(
          activationId,
          ownerId,
          firstIndex,
          length,
        );
      },
      abort: (): void => {
        threadTableReplication?.abort();
      },
    };
    let forkResult = 0;
    let forkMode: ProcessForkMode = PROCESS_FORK_MODE_FORK;

    let kernelThreadExitStatus: number | null = null;
    const kernelImports = buildKernelImports(
      memory,
      channelOffset,
      ptrWidth,
      undefined,
      undefined,
      initData.secureExec,
      (status) => {
        kernelThreadExitStatus = status;
      },
    );
    if (hasForkInstrumentation) {
      kernelImports.kernel_fork = (rawMode: number): number => {
        if (!threadInstance || !threadProcessContinuation) return -38; // ENOSYS
        const mode = processForkMode(rawMode);
        if (mode === null) return -STARTUP_EINVAL;

        const phase = threadProcessContinuation.phaseName();
        if (phase === "parent-replay") {
          if (mode !== forkMode) {
            throw new Error(
              `pid=${pid} tid=${tid}: fork replay mode ${mode} does not ` +
                `match captured mode ${forkMode}`,
            );
          }
          try {
            threadProcessContinuation.finishReplay();
          } finally {
            releasePthreadForkLock();
          }
          return forkResult;
        }
        if (phase === "abort-replay") {
          if (mode !== forkMode) {
            throw new Error(
              `pid=${pid} tid=${tid}: fork abort mode ${mode} does not ` +
                `match captured mode ${forkMode}`,
            );
          }
          const errno = threadProcessContinuation.abortErrno();
          try {
            threadProcessContinuation.finishAbortReplay();
          } finally {
            releasePthreadForkLock();
          }
          return -errno;
        }
        if (phase !== "idle") {
          throw new Error(
            `pid=${pid} tid=${tid}: fork import reached while process ` +
              `continuation is ${phase}`,
          );
        }
        forkMode = mode;

        try {
          // Reconciliation may instantiate a missing side module and execute
          // its start function, so it requires writer ownership. Afterward,
          // acquire the long-lived fork reader and verify no publication won
          // the handoff race before capturing activation state.
          for (;;) {
            threadTableReplication?.reconcileNow();
            acquirePthreadForkLock();
            if (
              !threadTableReplication ||
              threadTableReplication.isCurrentUnderLock()
            ) {
              break;
            }
            releasePthreadForkLock();
          }
        } catch (error) {
          releasePthreadForkLock();
          throw error;
        }

        const arena = newThreadModuleStateArena();
        try {
          arena.begin();
          threadProcessContinuation.beginCapture(arena);
          threadImportedStateCapture?.appendTo(arena);
        } catch (error) {
          if (arena.hasActiveArena()) arena.release();
          releasePthreadForkLock();
          if (error instanceof ContinuationAllocationError) return -error.errno;
          throw error;
        }
        return 0;
      };
    } else {
      kernelImports.kernel_fork = (_mode: number): number => {
        throw new Error(
          `pid=${pid} tid=${tid}: kernel_fork reached without complete ` +
            "wasm-fork-instrument exports. Rebuild the program with " +
            "scripts/run-wasm-fork-instrument.sh.",
        );
      };
    }
    const threadLongjmpTag = createLongjmpTag(ptrWidth);
    const threadCppExceptionTag = createCppExceptionTag(ptrWidth);
    const threadForkUnwindTag = createForkUnwindTag();
    const replicaActivationOwner =
      hasDylinkForkRole &&
      threadProcessContinuation &&
      threadActivationRegistry &&
      threadExceptionBroker
        ? createProcessDylinkActivationOwner({
            memory,
            ptrWidth,
            channelOffset,
            forkUnwindTag: threadForkUnwindTag,
            coordinator: threadProcessContinuation,
            registry: threadActivationRegistry,
            exceptionBroker: threadExceptionBroker,
            importedStateCapture: threadImportedStateCapture ?? undefined,
            tableReplication: threadTableReplicationImports,
            isForkChild: false,
            isPthreadReplica: true,
            invokeProcessFork: () => {
              const fork = threadInstance?.exports.fork;
              if (typeof fork !== "function") {
                throw new Error(
                  `pid=${pid} tid=${tid}: dylink fork role is missing ` +
                    "the main libc fork export",
                );
              }
              return Number((fork as () => number)());
            },
            label: `pid=${pid} tid=${tid}: dylink table activations`,
          })
        : undefined;
    const threadDlopenSupport = buildDlopenImports(
      memory,
      channelOffset,
      processArchiveControlAddr,
      () =>
        threadInstance?.exports.__indirect_function_table as
          WebAssembly.Table | undefined,
      () =>
        threadInstance?.exports.__stack_pointer as
          WebAssembly.Global | undefined,
      () => threadInstance,
      ptrWidth,
      threadLongjmpTag,
      threadCppExceptionTag,
      replicaActivationOwner,
      hasDylinkForkRole
        ? undefined
        : `pid=${pid} tid=${tid}: main artifact lacks the dylink fork role capability`,
      threadForkUnwindTag,
      (table, firstIndex, length) => {
        threadActivationRegistry?.markTableMutation(table, firstIndex, length);
      },
      threadHostImportRuntime ?? undefined,
      tid,
    );
    if (threadActivationRegistry) {
      threadTableReplication = createProcessTableReplicationOwner({
        generationAddress: processGenerationAddress,
        registry: threadActivationRegistry,
        tableSnapshot: new ForkTableSnapshot(
          threadActivationRegistry,
          threadForkModuleBackend,
          `pid=${pid} tid=${tid}: peer table snapshot`,
        ),
        dlopen: threadDlopenSupport,
        newArena: newThreadModuleStateArena,
        materializeModules: (snapshot) => {
          threadDlopenSupport.replayDlopens(snapshot);
        },
        restoreSnapshots: true,
        label: `pid=${pid} tid=${tid}`,
      });
    }
    const threadCoordinator = threadProcessContinuation;
    const threadForkEnvImports =
      threadCoordinator && threadActivationRegistry && threadExceptionBroker
        ? {
            ...threadCoordinator.continuationImports(0),
            // Phase 6 D7b IMPORT FLIP (mirrors the main worker path): when the
            // fork-module is wired into this pthread parent, the thread's guest
            // calls the module's frame/resume exports directly (wasm->wasm over
            // shared memory), replacing exactly the five per-frame JS closures.
            // The coordinator's module-backed capture then journals through the
            // module, and it serializes the KFRE image the fork-from-thread child
            // reads. Everything else stays JS. Guest ABI names/signatures are
            // unchanged; no re-instrumentation. Flag-off skips this entirely.
            ...(threadForkModuleInstance
              ? {
                  // MODULE-MODE PARTIAL-CAPTURE ABORT (mirrors the main worker
                  // path): a 0 result from the module reserve synchronously drives
                  // the module-mode partial-capture abort so the guest's reserve==0
                  // contract finds the thread coordinator already in `abort-replay`.
                  __wpk_fork_frame_reserve: (size: number | bigint) => {
                    const payload = (
                      threadForkModuleInstance!.exports
                        .__wpk_fork_frame_reserve as (
                        s: number | bigint,
                      ) => number | bigint
                    )(size);
                    if (payload === 0 || payload === 0n) {
                      const moduleErrno = threadForkModuleBackend
                        ? threadForkModuleBackend.lastErrno()
                        : STARTUP_ENOMEM;
                      threadCoordinator.beginModuleCaptureAbort(
                        moduleErrno > 0 ? moduleErrno : STARTUP_ENOMEM,
                      );
                    }
                    return payload;
                  },
                  __wpk_fork_frame_commit:
                    threadForkModuleInstance.exports.__wpk_fork_frame_commit,
                  __wpk_fork_frame_peek:
                    threadForkModuleInstance.exports.__wpk_fork_frame_peek,
                  __wpk_fork_frame_next:
                    threadForkModuleInstance.exports.__wpk_fork_frame_next,
                  __wpk_fork_resume_peek:
                    threadForkModuleInstance.exports.__wpk_fork_resume_peek,
                }
              : {}),
            ...buildForkActivationStateImports(
              0,
              threadActivationRegistry,
              undefined,
              threadTableReplicationImports,
            ),
            ...buildForkExceptionImports({
              activationId: 0,
              ptrWidth,
              registry: threadActivationRegistry,
              broker: threadExceptionBroker,
              provider: () => {
                if (!threadExceptionProvider) {
                  throw new Error(
                    `pid=${pid} tid=${tid}: exception codec called before registration`,
                  );
                }
                return threadExceptionProvider;
              },
            }),
          }
        : undefined;
    const importObject = buildImportObject(
      module,
      memory,
      kernelImports,
      channelOffset,
      threadDlopenSupport.imports,
      () => threadInstance,
      ptrWidth,
      threadLongjmpTag,
      threadCppExceptionTag,
      threadForkUnwindTag,
      (timedOutPtr, vmInterruptPtr, seconds) => {
        port.postMessage({
          type: "vm_interrupt_timer",
          pid,
          timedOutPtr,
          vmInterruptPtr,
          seconds,
        } satisfies WorkerToHostMessage);
      },
      threadForkEnvImports,
    );
    const routedThreadImportObject = threadHostImportRuntime
      ? threadHostImportRuntime.routeImportObject(
          initData.programBytes,
          importObject,
        )
      : importObject;
    const threadMainImportedState =
      threadImportedStateCapture?.prepareActivation(
        0,
        module,
        routedThreadImportObject,
      );
    const threadInstanceImports = (threadMainImportedState?.imports ??
      routedThreadImportObject) as WebAssembly.Imports;
    const instance = new WebAssembly.Instance(module, threadInstanceImports);
    threadInstance = instance;
    threadMainImportedState?.complete(instance);
    if (
      hasForkInstrumentation &&
      threadProcessContinuation &&
      threadActivationRegistry &&
      threadTemplateId
    ) {
      const threadBootstrap = instance.exports
        .wpk_fork_module_thread_bootstrap as (() => void) | undefined;
      if (!threadBootstrap) {
        throw new Error(
          `pid=${pid} tid=${tid}: fork module is missing thread bootstrap`,
        );
      }
      threadExceptionProvider = forkExceptionProviderFromInstance(0, instance);
      threadProcessContinuation.registerActivation(
        forkActivationRegistrationFromInstance({
          activationId: 0,
          module,
          instance,
          templateId: threadTemplateId,
          exceptionProvider: threadExceptionProvider,
        }),
        forkResumeTargetsFromInstance(module, instance),
      );
      try {
        // The pthread bootstrap consumes passive element segments, so static
        // root harvesting and table-dirty registration must precede it just as
        // they do for the process-main bootstrap.
        threadBootstrap();
        threadImportedStateCapture?.bindTableDirtyTrackers(
          new Map(
            threadActivationRegistry
              .activations()
              .map((activation) => [
                activation.activationId,
                activation.tableDirty,
              ]),
          ),
        );
      } catch (error) {
        threadTableReplication?.abortActiveMutations();
        threadProcessContinuation.unregisterActivation(0);
        threadExceptionProvider = null;
        throw error;
      }
    }

    const threadTable = instance.exports.__indirect_function_table as
      WebAssembly.Table | undefined;
    const threadStackPointer = instance.exports.__stack_pointer as
      WebAssembly.Global | undefined;
    if (
      (!threadTable || !threadStackPointer) &&
      threadDlopenSupport.archive.generation() !== 0
    ) {
      throw new Error(
        `pid=${pid} tid=${tid}: process has dlopen table recipes but ` +
          "the pthread instance has no shared table/stack binding",
      );
    }
    threadTableReplication?.reconcileNow();

    // Initialize Wasm TLS for this thread in the slot's explicit TLS/control page.
    const wasmInitTls = instance.exports.__wasm_init_tls as
      ((addr: number | bigint) => void) | undefined;
    const tlsBlock = tlsOffset;

    if (wasmInitTls && tlsBlock > 0) {
      wasmInitTls(ptrWidth === 8 ? BigInt(tlsBlock) : tlsBlock);
    }

    // Set __stack_pointer
    const stackPointer = instance.exports.__stack_pointer as
      WebAssembly.Global | undefined;
    if (stackPointer) {
      stackPointer.value = ptrWidth === 8 ? BigInt(stackPtr) : stackPtr;
    }

    // Initialize musl thread pointer if available
    const wasmThreadInit = instance.exports.__wasm_thread_init as
      ((tp: number | bigint) => void) | undefined;
    if (wasmThreadInit && tlsPtr > 0) {
      wasmThreadInit(ptrWidth === 8 ? BigInt(tlsPtr) : tlsPtr);
    }

    // Set __channel_base without calling the exported helper. lld can prefix
    // exported functions with __wasm_call_ctors, and thread workers must not
    // re-run constructors in shared process memory.
    setupChannelBase(
      instance,
      module,
      memory,
      channelOffset,
      initData.programBytes,
      ptrWidth,
    );

    // Call the thread function via indirect function table
    const table = threadTable;
    if (!table) {
      throw new Error(
        "No __indirect_function_table export — cannot call thread function",
      );
    }

    // On wasm64, table indices may require BigInt (table64 extension)
    const tableIdx = ptrWidth === 8 ? BigInt(fnPtr) : fnPtr;
    const threadFn = table.get(tableIdx as number) as
      ((...args: (number | bigint)[]) => number | bigint) | null;
    if (!threadFn) {
      throw new Error(`Thread function at table index ${fnPtr} is null`);
    }

    const threadArg = ptrWidth === 8 ? BigInt(argPtr) : argPtr;
    const threadArgs = buildThreadEntryArgs(threadFn, argPtr, ptrWidth);
    const resumeThread = hasForkInstrumentation
      ? (instance.exports.wpk_fork_resume_thread as
          | ((tableIndex: number, arg: number | bigint) => number | bigint)
          | undefined)
      : undefined;
    if (hasForkInstrumentation && typeof resumeThread !== "function") {
      throw new Error(
        `pid=${pid} tid=${tid}: fork-capable program is missing ` +
          "wpk_fork_resume_thread",
      );
    }
    let result = 0;
    if (hasForkInstrumentation && threadProcessContinuation) {
      for (;;) {
        let transportedForkUnwind = false;
        try {
          const raw =
            threadProcessContinuation.phaseName() === "idle"
              ? threadFn(...threadArgs)
              : resumeThread!(fnPtr, threadArg);
          result = Number(raw);
        } catch (e) {
          if (isForkUnwindException(e, threadForkUnwindTag)) {
            transportedForkUnwind = true;
          } else if (
            isWasmUnreachableTrap(e) && kernelThreadExitStatus !== null
          ) {
            result = kernelThreadExitStatus;
            break;
          } else {
            throw e;
          }
        }

        const phase = threadProcessContinuation.phaseName();
        if (transportedForkUnwind && phase !== "capture") {
          throw new Error(
            `pid=${pid} tid=${tid}: private fork-unwind exception escaped ` +
              `while process continuation is ${phase}`,
          );
        }
        if (phase === "capture") {
          try {
            threadProcessContinuation.sealCapture();
          } catch (sealError) {
            // SEAL-TIME TRUTHFUL FAILURE (fork-from-thread mirror of the main
            // run loop): the unwind completed but the module could not
            // channel-mmap the child-inheritable journal image. The coordinator
            // sealed to `sealed-parent` without launching a child; replay the
            // parent's committed frames and return `-errno` (parent intact).
            if (sealError instanceof ContinuationAllocationError) {
              const errno =
                sealError.errno > 0 ? sealError.errno : STARTUP_ENOMEM;
              forkResult = -errno;
              threadProcessContinuation.beginAbortReplay(errno);
              continue;
            }
            throw sealError;
          }
          // GATED REFERENCE KIND (fork-from-thread mirror of the main run
          // loop): abort cleanly with EOPNOTSUPP when a capture-side record-stub
          // marked an unsupported reference kind, instead of launching a child.
          // The guest fork() re-enters in `abort-replay` and returns
          // `-EOPNOTSUPP`.
          const unsupportedKind =
            threadActivationRegistry?.takeUnsupportedReferenceKind() ?? null;
          if (unsupportedKind !== null) {
            // Make the platform boundary VISIBLE to a developer (Platform
            // Values: truthful failure over silent illusion). Marker-gated:
            // fires ONLY when a capture-side record-stub marked an unsupported
            // reference kind, never on a supported fork. One line per abort.
            console.warn(
              `[worker] pid=${pid} tid=${tid}: fork aborted with EOPNOTSUPP — ` +
                `carried a live '${unsupportedKind}' reference across the fork ` +
                `boundary, which the platform cannot reconstruct in a fresh ` +
                `child yet. No child was spawned; the parent continues. ` +
                `See docs/fork-reference-support.md.`,
            );
            forkResult = -FORK_REFERENCE_EOPNOTSUPP;
            threadProcessContinuation.beginAbortReplay(FORK_REFERENCE_EOPNOTSUPP);
            continue;
          }
          const borrowedReplay = Number(forkMode) === PROCESS_FORK_MODE_VFORK
            ? threadProcessContinuation.borrowedReplayWorkspaceRequirements()
            : undefined;
          const childPid = sendForkSyscall(
            memory,
            channelOffset,
            forkMode,
            borrowedReplay,
          );
          forkResult = childPid;
          if (childPid < 0) {
            threadProcessContinuation.beginAbortReplay(-childPid);
          } else {
            threadProcessContinuation.beginParentReplay();
          }
          continue;
        }
        if (phase !== "idle") {
          throw new Error(
            `pid=${pid} tid=${tid}: pthread entry returned while process ` +
              `continuation is ${phase}`,
          );
        }
        break;
      }
    } else {
      try {
        const raw = threadFn(...threadArgs);
        result = Number(raw);
      } catch (e) {
        if (isWasmUnreachableTrap(e) && kernelThreadExitStatus !== null) {
          result = kernelThreadExitStatus;
        } else {
          throw e;
        }
      }
    }

    // Phase 6 D7b proof-of-use: a pthread PARENT worker that ran a fork through
    // the co-resident module reports how many frames the module committed during
    // its unwind. This is the PARENT side of a fork-from-thread; the child posts
    // its replay-side `fork_module_child_frames`. A silent JS fallback would
    // leave the counter at zero and fail the flag-on proof.
    if (threadForkModuleBackend) {
      port.postMessage({
        type: "fork_module_frames",
        pid,
        frames: Number(threadForkModuleBackend.framesCommitted()),
      } satisfies WorkerToHostMessage);
    }

    // A well-formed replay releases its reader token from the inherited fork
    // import above. Keep normal-return cleanup defensive so an unexpected
    // execution exit cannot strand the process-wide writer lock.
    releasePthreadForkLock();
    threadProcessContinuation?.clear();
    threadExternrefTokens?.clear();
    threadHostImportRuntime?.clear();

    // A normal return has not passed through libc's noreturn kernel_exit
    // import, so publish SYS_EXIT here. When kernel_exit already ran it sent
    // and completed SYS_EXIT before the compiler's trailing unreachable was
    // caught above. Publishing a second exit on that now-removed channel
    // parks this Worker forever; after slot reuse its stale atomic waiter can
    // steal the next pthread's first notify.
    if (kernelThreadExitStatus === null) {
      const view = new DataView(memory.buffer);
      const base = channelOffset;
      view.setInt32(base + CH_SYSCALL, ABI_SYSCALLS.Exit, true);
      view.setInt32(base + CH_ARGS, result ?? 0, true);
      const i32 = new Int32Array(memory.buffer);
      Atomics.store(i32, (base + CH_STATUS) / 4, CHANNEL_STATUS_PENDING);
      Atomics.notify(i32, (base + CH_STATUS) / 4, 1);
      // Wait for kernel to process the exit. The kernel completes the channel
      // (CH_STATUS -> COMPLETE), which returns this Atomics.wait.
      while (
        Atomics.wait(i32, (base + CH_STATUS) / 4, CHANNEL_STATUS_PENDING) ===
        "ok"
      ) {
        /* */
      }
      // Intentionally do NOT reset CH_STATUS back to IDLE here. A normal syscall
      // resets to IDLE so the next syscall can set PENDING, but an exiting thread
      // issues no further syscalls — the channel is torn down and the slot is
      // re-zeroed when it is reclaimed for a future clone(). Writing here would be
      // the thread's only post-exit touch of the channel, so omitting it removes
      // any possibility of a late write landing on a reused slot's status word.
    }

    port.postMessage({
      type: "thread_exit",
      pid,
      tid,
    } satisfies WorkerToHostMessage);
  } catch (err) {
    threadTableReplication?.abortActiveMutations();
    releasePthreadForkLock();
    try {
      threadProcessContinuation?.clear();
    } catch {
      // Preserve the original worker failure after making transaction roots
      // unreachable as far as the coordinator can.
    }
    threadExternrefTokens?.clear();
    threadHostImportRuntime?.clear();
    if (err instanceof ExecRetirement) {
      port.postMessage({
        type: "exec_retired",
        pid,
        tid,
      } satisfies WorkerToHostMessage);
      return;
    }
    const message =
      err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err);
    port.postMessage({
      type: "error",
      pid,
      message: `Thread worker failed: ${message}`,
    } satisfies WorkerToHostMessage);
  }
}
