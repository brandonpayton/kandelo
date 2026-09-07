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
  /**
   * Phase 6 D5: the pre-compiled `fork-module` matching this process's pointer
   * width. The kernel host resolves and compiles it once and ships it here so
   * the worker instantiates without recompiling. The co-resident module is the
   * UNCONDITIONAL fork reconstructor + capturer, so it is always shipped to a
   * fork-instrumented worker; a fork-instrumented worker that receives no module
   * fails loud.
   */
  forkModuleModule?: WebAssembly.Module;
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
  /**
   * Phase 6 D7b: the pre-compiled `fork-module` matching this process's pointer
   * width, forwarded exactly as for the process worker. A fork issued FROM this
   * pthread must unwind/serialize/parent-replay through the module — the parent
   * side of a fork-from-thread — so the pthread worker always receives the same
   * co-resident module the process worker gets.
   */
  forkModuleModule?: WebAssembly.Module;
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
  | ForkModuleFramesMessage
  | ForkModuleChildFramesMessage
  | ForkModuleReferencesMessage
  | ForkHostImportWakeMessage;

/**
 * Phase 6 D5: proof-of-use for the co-resident fork-module. A process worker
 * that drove a qualifying fork through the module reports how many frames the
 * module committed, so the host (and tests) can confirm the continuation ran
 * through the module and did not silently fall back to the JS closures.
 */
export interface ForkModuleFramesMessage {
  type: "fork_module_frames";
  pid: number;
  frames: number;
}

/**
 * Phase 6 D7b: replay-side proof-of-use for the co-resident fork-module. A
 * replay-only fork CHILD never commits a frame, so `fork_module_frames` (which
 * the parent commits) cannot prove the CHILD ran its rewind through the module.
 * A fork-from-thread child carries no references either, so
 * `fork_module_references` also stays silent. This distinct message lets a fork
 * CHILD report how many frames the module replayed (consuming rewind advances),
 * so the host (and tests) can confirm both SIDES of a fork-from-thread — the
 * pthread parent (via `fork_module_frames`) and the child (via this) — ran
 * through the module and did not silently fall back to the JS closures. A
 * distinct type (not a second `fork_module_frames`) so a consumer waiting on the
 * parent's committed-frame count is never confused by the child's replay count.
 */
export interface ForkModuleChildFramesMessage {
  type: "fork_module_child_frames";
  pid: number;
  frames: number;
}

/**
 * Phase 6 D6.5: PER-KIND proof-of-use for the co-resident fork-module's
 * REFERENCE reconstruction. A fresh fork CHILD worker whose carried references
 * were reconstructed through the module (the flipped `__wpk_fork_ref_decode_*`
 * exports and `fm_begin_reference_replay`) reports one count per reference kind,
 * so the host (and tests) can confirm the reference decode ran through the
 * module rather than silently falling back to the JS reference path. A single
 * message carries every kind because a graph can mix them (an exnref whose
 * payload is an externref advances both counters). Reference reconstruction
 * happens in the child, so — unlike `fork_module_frames`, which the parent
 * commits — this is posted by the child worker.
 *
 * Emitted ONLY when at least one kind's count is positive (the D7b lesson: a
 * `=0` diagnostic broke the `d_01` poll), so a reference-free fork stays silent.
 */
export interface ForkModuleReferencesMessage {
  type: "fork_module_references";
  pid: number;
  /** Funcref/null count (`fm_references_reconstructed`). */
  references: number;
  /** Externref count (`fm_externrefs_resolved`). */
  externrefs: number;
  /** Exnref-node count (`fm_exnrefs_reconstructed`). */
  exnrefs: number;
  /** Typed-GC node count — struct/array/i31 (`fm_gc_nodes_reconstructed`). */
  gcNodes: number;
  /**
   * Typed-GC DRIVE step count (`fm_drive_steps_executed`, Phase 6 item 3c).
   * Distinct from `gcNodes`: this advances only when the module actually drove
   * the typed allocate/fill/exn order (`fm_build_gc_plan` + `fm_drive_execute`),
   * so a nonzero value proves the module — not the JS `materializeAllTyped`
   * fallback — reconstructed the typed graph.
   */
  driveSteps: number;
  /**
   * Static-root publish count (`fm_static_roots_published`, the static-root
   * binder). Advances only when the module's DRIVE_OP_STATIC_ROOT step
   * republished an immutable static root into the anyref transit, so a nonzero
   * value proves the module — not the JS `publishTransit` fallback — reconstructed
   * the static-root identity.
   */
  staticRoots: number;
}

export interface WorkerReadyMessage {
  type: "ready";
  pid: number;
}

export interface ForkReplayReadyMessage {
  type: "fork_replay_ready";
  pid: number;
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
