import type {
  ForkHostImportWorkerInit,
} from "./fork-host-import-runtime";
import type {
  ForkExternrefImportWake,
} from "./fork-externref-import-mailbox";
import type { ProcessForkMode } from "./generated/abi";

export type ForkMemoryOwnership = "copied" | "borrowed";

// --- Host → Worker messages ---

/**
 * Host-internal channel marker for retiring an exec-discarded process Worker
 * without issuing SYS_EXIT for the persistent process.
 *
 * WHY: both the kernel worker that publishes the marker and worker-main that
 * consumes it must share one token. A duplicated literal would fail as a
 * silent timeout and lose the exact ownership fence for that old generation.
 */
export const EXEC_RETIRE_SIGNAL_CODE = 0x4b455852; // "KEXR"

export type HostToWorkerMessage =
  | CentralizedWorkerInitMessage
  | CentralizedThreadInitMessage
  | WorkerTerminateMessage
  | ExecReplyMessage;

/**
 * Init message for centralized-mode Workers.
 * These Workers don't instantiate a kernel — they use channel IPC
 * to communicate with the CentralizedKernelWorker.
 */
export interface CentralizedWorkerInitMessage {
  type: "centralized_init";
  pid: number;
  /** User program bytes (compiled with channel_syscall.c — no kernel imports) */
  programBytes: ArrayBuffer;
  /** Pre-compiled WebAssembly module (avoids recompilation in web workers) */
  programModule?: WebAssembly.Module;
  /** Shared Memory for this process (also shared with CentralizedKernelWorker) */
  memory: WebAssembly.Memory;
  /** Channel offset within the shared Memory for this thread's syscall channel */
  channelOffset: number;
  /** Kernel-owned sticky secure-execution state for this exact image. */
  secureExec: boolean;
  /**
   * Exact process-image generation issued by the kernel-side externref owner.
   * Workers use this scalar only when routing token-bearing host imports; the
   * broker capability and real JavaScript values never cross the Worker edge.
   * Optional only for direct non-fork harnesses; an instrumented artifact must
   * reject launch unless this and `forkHostImports` are both present.
   */
  externrefGenerationId?: number;
  /**
   * One fixed owner-import mailbox for this Worker. Side modules reuse it.
   * Optional only for direct non-fork test harnesses that do not create a
   * durable process owner; production Node/browser launch paths always set it.
   */
  forkHostImports?: ForkHostImportWorkerInit;
  /** Optional env vars to set up in the program */
  env?: string[];
  /** Optional argv */
  argv?: string[];
  /** Optional cwd */
  cwd?: string;
  /** If true, this is a fork child — drive wpk_fork_rewind_begin instead of normal _start */
  isForkChild?: boolean;
  /** Exact ordinary/vfork mode captured by the inherited fork import. */
  forkMode?: ProcessForkMode;
  /**
   * Whether this child owns an independent copy or temporarily borrows its
   * parent's exact Memory. Borrowed ownership is valid only for vfork.
   */
  forkMemoryOwnership?: ForkMemoryOwnership;
  /** Address of the fork save-buffer in memory (used for fork child rewind) */
  forkBufAddr?: number;
  /** Parent process-wide archive/control anchor used read-only by a borrower. */
  forkOwnerControlAddr?: number;
  /** First byte of the child-private activation-prefix region. */
  forkPrivatePrefixAddr?: number;
  /** Exact admitted activation-prefix bytes. */
  forkPrivatePrefixBytes?: number;
  /** First byte of child-private reference/exception codec scratch. */
  forkScratchAddr?: number;
  /** Exact admitted scratch capacity. */
  forkScratchBytes?: number;
  /**
   * Two-phase launch gate for a fork child. The child announces that all
   * reconstruction and activation frames reached the inherited fork import,
   * then waits here until the kernel host commits the launch.
   */
  forkReplayGate?: SharedArrayBuffer;
  /**
   * Checkpoint freeze gate for this process.
   *
   * The process announces that its frames are captured, then waits here while
   * the keeper reads its memory. The keeper reopens the gate to rewind the
   * process back into the syscall it left.
   */
  checkpointFreezeGate?: SharedArrayBuffer;
  /**
   * Entry-point override for fork children created by a non-main thread.
   *
   * A pthread worker that calls fork() unwinds through its pthread entry
   * function, not `_start`. The fork child must therefore enter that function
   * directly before `wpk_fork_rewind_begin` can replay back to the saved fork
   * site.
   */
  forkChildThreadFnPtr?: number;
  forkChildThreadArgPtr?: number;
  /** Pointer width: 4 for wasm32, 8 for wasm64. Defaults to 4. */
  ptrWidth?: 4 | 8;
  /**
   * Kernel's advertised ABI version (read from its `__abi_version`
   * export at kernel startup). Worker compares against the program's
   * own `__abi_version` export and refuses mismatches.
   */
  kernelAbiVersion?: number;
  /**
   * Kernel's ABI-contract digest (32 bytes, read from the kernel wasm's own
   * `kandelo.abi.contract` custom section at startup). The worker compares
   * this against the program's own stamp and refuses a mismatch even when the
   * ABI version NUMBERS coincide. Uint8Array clones fine across postMessage.
   * Absent when the kernel build predates the stamp.
   */
  kernelAbiContractDigest?: Uint8Array;
}

/**
 * Init message for thread Workers.
 * Threads share the parent process's Memory and run a function pointer.
 */
export interface CentralizedThreadInitMessage {
  type: "centralized_thread_init";
  pid: number;
  tid: number;
  programBytes: ArrayBuffer;
  programModule?: WebAssembly.Module;
  memory: WebAssembly.Memory;
  /** Main process channel offset. The thread reads the process-wide dlopen
   * archive head relative to this live shared-memory anchor before fork. */
  processChannelOffset: number;
  channelOffset: number;
  /** Same sticky image marker as the process worker. */
  secureExec: boolean;
  /**
   * Same process-image externref generation as the process's main Worker.
   * Optional only for direct non-fork harnesses.
   */
  externrefGenerationId?: number;
  /** Distinct pthread mailbox; side modules in this pthread reuse it. */
  forkHostImports?: ForkHostImportWorkerInit;
  fnPtr: number;
  argPtr: number;
  stackPtr: number;
  tlsPtr: number;
  ctidPtr: number;
  /** Pre-allocated address in shared memory for Wasm TLS initialization. */
  tlsOffset: number;
  /** @deprecated Use tlsOffset. */
  tlsAllocAddr: number;
  /** Pointer width: 4 for wasm32, 8 for wasm64. Defaults to 4. */
  ptrWidth?: 4 | 8;
  /** See [`CentralizedWorkerInitMessage#kernelAbiVersion`]. */
  kernelAbiVersion?: number;
  /** See [`CentralizedWorkerInitMessage#kernelAbiContractDigest`]. */
  kernelAbiContractDigest?: Uint8Array;
  /**
   * This thread's own checkpoint freeze gate, minted by
   * `CheckpointFreezeGateCoordinator.registerThread`. A resume is consumed by
   * the worker it wakes, so no two workers can share one gate.
   */
  checkpointFreezeGate?: SharedArrayBuffer;
  /**
   * Launch root of a checkpointed pthread relaunched in a restored machine.
   *
   * Its frames are already parked in the restored memory behind the anchor at
   * `channelOffset - FORK_SAVE_BUFFER_SIZE`. When present, the worker attaches
   * that captured continuation and rewinds through `wpk_fork_resume_thread`
   * instead of entering `fnPtr` fresh.
   */
  restoredForkBufAddr?: number;
}

export interface WorkerTerminateMessage {
  type: "terminate";
}

// --- Worker → Host messages ---

export type WorkerToHostMessage =
  | WorkerReadyMessage
  | ForkReplayReadyMessage
  | WorkerExitMessage
  | ThreadExitMessage
  | WorkerMemoryQuiescentMessage
  | WorkerExecRetiredMessage
  | WorkerErrorMessage
  | ExecRequestMessage
  | ExecCompleteMessage
  | AlarmSetMessage
  | VmInterruptTimerMessage
  | ForkHostImportWakeMessage
  | CheckpointUnwoundMessage
  | CheckpointRefusedMessage;

export interface WorkerReadyMessage {
  type: "ready";
  pid: number;
}

export interface ForkReplayReadyMessage {
  type: "fork_replay_ready";
  pid: number;
}

/**
 * The worker has sealed its continuation capture and is parked on its
 * checkpoint freeze gate with its frames still in linear memory.
 *
 * A process reports every one of its threads, so the keeper reads the memory
 * only once all of them are parked.
 */
export interface CheckpointUnwoundMessage {
  type: "checkpoint_unwound";
  pid: number;
  /** Absent for the process's main thread. */
  tid?: number;
}

/**
 * The worker read its unwind request and could not reach its capture.
 *
 * The freeze fails on this rather than on its own deadline, so the caller is
 * told why the machine could not be read instead of only that nobody reported
 * in time. The guest keeps running; a refusal is not a process failure.
 */
export interface CheckpointRefusedMessage {
  type: "checkpoint_refused";
  pid: number;
  /** Absent for the process's main thread. */
  tid?: number;
  reason: string;
}

export interface WorkerExitMessage {
  type: "exit";
  pid: number;
  status: number;
}

export interface ThreadExitMessage {
  type: "thread_exit";
  pid: number;
  tid: number;
}

/**
 * Process-worker ownership fence emitted only after worker-main has returned
 * and can no longer access its Shared WebAssembly.Memory.
 */
export interface WorkerMemoryQuiescentMessage {
  type: "memory_quiescent";
  pid: number;
  tid?: number;
}

/** Internal acknowledgement that an exec-discarded process Worker unwound. */
export interface WorkerExecRetiredMessage {
  type: "exec_retired";
  pid: number;
  tid?: number;
}

export interface WorkerErrorMessage {
  type: "error";
  pid: number;
  message: string;
}

export interface ExecRequestMessage {
  type: "exec_request";
  pid: number;
  path: string;
}

export interface ExecCompleteMessage {
  type: "exec_complete";
  pid: number;
}

export interface AlarmSetMessage {
  type: "alarm_set";
  pid: number;
  seconds: number;
}

export interface VmInterruptTimerMessage {
  type: "vm_interrupt_timer";
  pid: number;
  timedOutPtr: number;
  vmInterruptPtr: number;
  seconds: number;
}

export interface ForkHostImportWakeMessage {
  type: "fork_host_import";
  /** Contains scalar identity/sequence fields only; the SAB moved at init. */
  wake: ForkExternrefImportWake;
}

export interface ExecReplyMessage {
  type: "exec_reply";
  wasmBytes: ArrayBuffer;
  programBytes?: ArrayBuffer;
}
