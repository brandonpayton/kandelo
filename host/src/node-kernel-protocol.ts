/**
 * Message protocol for Node.js main thread ↔ kernel worker_thread communication.
 *
 * Mirrors browser-kernel-protocol.ts but adapted for Node.js:
 * - No SharedArrayBuffer VFS (Node uses real filesystem via NodePlatformIO)
 * - No worker entry URLs (Node uses NodeWorkerAdapter)
 * - Pipe/inject operations match the browser peer for protected in-kernel
 *   protocol clients; ambient outbound TCP still uses NodePlatformIO.
 *
 * The `http_request` message is a host-driven HTTP request injected
 * straight into an in-kernel server's accept queue, bypassing real TCP.
 * See docs/plans/2026-04-30-external-kernel-http-request-interface.md.
 */
import type { HttpRequest, HttpResponse } from "./networking/in-kernel-http";
import type { HostDiagnosticMessage } from "./host-diagnostic";
import type { LazyDownloadEvent } from "./vfs/memory-fs";
import type {
  ClosedLazyAsset,
  ClosedLazyAssetSource,
} from "./vfs/closed-lazy-assets";
import type { MountSpec } from "./vfs/default-mounts";
import type { NodeSessionSeedTree } from "./vfs/default-mounts-node";
import type { MachineCheckpoint } from "./migration/checkpoint";
import type { ReplicationLogEntry } from "./replication/log";

export type { HttpRequest, HttpResponse };
export type { HostDiagnostic } from "./host-diagnostic";

// ── Main Thread → Kernel Worker ──

export interface InitMessage {
  type: "init";
  kernelWasmBytes: ArrayBuffer;
  config: {
    maxWorkers: number;
    maxPages?: number;
    /**
     * Sampled live-allocation admission budget. Unmediated memory.grow can
     * cross it until the next allocation observes current byte lengths.
     */
    maxProcessMemoryBytes: number;
    /** Host default pthread slots for process-wasm declarations of -1. */
    defaultThreadSlots?: number;
    dataBufferSize?: number;
    useSharedMemory?: boolean;
  };
  /**
   * Virtual path → immutable host file for spawn-only preflight. Exec never
   * consults this map and uses only a retained kernel VFS target.
   */
  execPrograms?: Record<string, string>;
  /**
   * Virtual path → worker-owned bytes for spawn-only preflight through Task
   * 12. Exec never consults this map.
   */
  execProgramBytes?: Record<string, ArrayBuffer>;
  /**
   * Bytes of `host/wasm/rootfs.vfs`, read on the main thread and forwarded
   * to the worker. When present, the worker materialises the default mount
   * spec (rootfs at `/`, scratch dirs at `/tmp` etc.) and constructs a
   * `VirtualPlatformIO`. Absent → worker falls back to `NodePlatformIO`
   * (custom-io / legacy path).
   */
  rootfsImage?: ArrayBuffer;
  /** Exact image/scratch mount contract. Absent preserves the host default. */
  rootfsMountSpec?: MountSpec[];
  /**
   * Boot this machine from a captured checkpoint instead of fresh state.
   *
   * The worker validates the checkpoint before instantiating anything, then
   * adopts its kernel memory and its rootfs bytes. Requires `rootfsImage`:
   * the mount layout is host configuration a checkpoint does not carry, so
   * the caller supplies the same mounts the captured machine ran with.
   */
  restoreCheckpoint?: MachineCheckpoint;
  /** Base used to resolve relative lazy URLs embedded in rootfsImage. */
  rootfsLazyUrlBase?: string;
  /** Exhaustive exact-byte lazy transport for this rootfs; no network fallback. */
  rootfsLazyAssets?: ClosedLazyAsset[];
  /** Exhaustive verified sources fetched only on first use of their exact URL. */
  rootfsLazyAssetSources?: ClosedLazyAssetSource[];
  extraMounts?: Array<{
    mountPoint: string;
    hostPath: string;
    readonly?: boolean;
    exclusiveNativeWriters?: boolean;
    uid?: number;
    gid?: number;
  }>;
  /**
   * Quiescent host trees copied beneath existing worker-owned scratch mounts
   * before ready. Guest mutations never write back to the source.
   */
  sessionSeedTrees?: NodeSessionSeedTree[];
  /** Attach a real-TCP backend (TcpNetworkBackend) to the worker's PlatformIO
   *  so wasm programs can dial external hosts via Node `net.Socket`. */
  enableTcpNetwork?: boolean;
}

export interface SpawnMessage {
  type: "spawn";
  requestId: number;
  /**
   * Supply exactly one program source. `programPath` resolves inside the
   * worker-owned VFS and is the Node peer of BrowserKernel.spawnFromVfs().
   */
  programBytes?: ArrayBuffer;
  programPath?: string;
  /** Optional pre-compiled module for the same bytes. */
  programModule?: WebAssembly.Module;
  argv: string[];
  env?: string[];
  cwd?: string;
  /** Initial real/effective user ID for the process. Defaults to root. */
  uid?: number;
  /** Initial real/effective group ID for the process. Defaults to root. */
  gid?: number;
  pty?: boolean;
  /** Initial PTY winsize. When set with `pty: true`, the kernel applies
   *  the winsize before the wasm program starts so the first ioctl
   *  returns the correct cols/rows. */
  ptyCols?: number;
  ptyRows?: number;
  stdin?: Uint8Array;
  /** Limit heap growth to protect thread channel pages */
  maxAddr?: number;
}

export interface AppendStdinDataMessage {
  type: "append_stdin_data";
  pid: number;
  data: Uint8Array;
}

export interface SetStdinDataMessage {
  type: "set_stdin_data";
  pid: number;
  data: Uint8Array;
}

export interface PtyWriteMessage {
  type: "pty_write";
  pid: number;
  data: Uint8Array;
}

export interface PtyResizeMessage {
  type: "pty_resize";
  pid: number;
  rows: number;
  cols: number;
}

export interface InjectConnectionMessage {
  type: "inject_connection";
  requestId: number;
  pid: number;
  fd: number;
  peerAddr: [number, number, number, number];
  peerPort: number;
}

export interface PipeReadMessage {
  type: "pipe_read";
  requestId: number;
  pid: number;
  pipeIdx: number;
}

export interface PipeWriteMessage {
  type: "pipe_write";
  requestId: number;
  pid: number;
  pipeIdx: number;
  data: Uint8Array;
}

export interface PipeCloseReadMessage {
  type: "pipe_close_read";
  pid: number;
  pipeIdx: number;
}

export interface PipeCloseWriteMessage {
  type: "pipe_close_write";
  pid: number;
  pipeIdx: number;
}

export interface PipeIsWriteOpenMessage {
  type: "pipe_is_write_open";
  requestId: number;
  pid: number;
  pipeIdx: number;
}

export interface WakeBlockedReadersMessage {
  type: "wake_blocked_readers";
  pipeIdx: number;
}

export interface WakeBlockedWritersMessage {
  type: "wake_blocked_writers";
  pipeIdx: number;
}

export interface PickListenerTargetMessage {
  type: "pick_listener_target";
  requestId: number;
  port: number;
}

export interface TerminateProcessMessage {
  type: "terminate_process";
  requestId: number;
  pid: number;
  status: number;
}

export interface DestroyMessage {
  type: "destroy";
  requestId: number;
}

/**
 * Serialize the quiescent worker-owned root filesystem. Boot-scoped scratch
 * and device mounts are intentionally outside this root-image snapshot.
 */
export interface ExportRootfsImageMessage {
  type: "export_rootfs_image";
  requestId: number;
}

/** Read one regular file through the worker-owned VFS. */
export interface ReadVfsFileMessage {
  type: "read_vfs_file";
  requestId: number;
  path: string;
}

/** Create or replace one regular file through the worker-owned VFS. */
export interface WriteVfsFileMessage {
  type: "write_vfs_file";
  requestId: number;
  path: string;
  data: Uint8Array;
  mode: number;
}

/** Request the kernel's per-process fork counter. The kernel-worker entry
 * forwards this to `kernel_get_fork_count` and posts a `response` message
 * with `result` set to a `bigint` (u64 as BigInt). Used by the spawn
 * regression tests to assert SYS_SPAWN doesn't bump the counter. */
export interface GetForkCountRequestMessage {
  type: "get_fork_count";
  requestId: number;
  pid: number;
}

/** Read the kernel Wasm instance's current 64 KiB linear-memory page count. */
export interface GetKernelMemoryPagesRequestMessage {
  type: "get_kernel_memory_pages";
  requestId: number;
}

/** Read the retained capacity of the kernel-owned large-spawn region. */
export interface GetSpawnScratchCapacityRequestMessage {
  type: "get_spawn_scratch_capacity";
  requestId: number;
}

/** Deliver `signum` to `pid`. Responds `true` when the process existed. */
export interface SignalProcessMessage {
  type: "signal_process";
  requestId: number;
  pid: number;
  signum: number;
}

export interface ResolveExecResponseMessage {
  type: "resolve_exec_response";
  requestId: number;
  programBytes: ArrayBuffer | null;
}

/** Snapshot the kernel's process table. Mirrors the browser host's
 * enum_procs request in browser-kernel-protocol.ts.
 * Response carries `ProcessSnapshot[]`. */
export interface EnumProcsRequestMessage {
  type: "enum_procs";
  requestId: number;
}

/** Read `/proc/[pid]/maps` for a foreign process via the host. Response
 * carries a string (Linux maps text) or `null` if the pid is gone. */
export interface ReadProcMapsRequestMessage {
  type: "read_proc_maps";
  requestId: number;
  pid: number;
}

/**
 * Freeze the machine, read it, and resume it. Mirrors the browser host's
 * capture_checkpoint request in browser-kernel-protocol.ts.
 *
 * Response carries a {@link CheckpointCaptureResponse}: a summary when the
 * freeze completed, or the reason it timed out or failed. A process that makes
 * no syscall never reaches its unwind hook, so a timeout is an ordinary
 * outcome and the machine keeps running.
 *
 * With `includeBytes`, a captured response carries the full
 * `MachineCheckpoint` instead of the summary, its kernel, filesystem, and
 * process buffers in the transfer list. Every transferred buffer is a copy
 * the freeze took; the worker keeps only live state.
 */
export interface CaptureCheckpointRequestMessage {
  type: "capture_checkpoint";
  requestId: number;
  unwindTimeoutMs: number;
  vforkTimeoutMs: number;
  includeBytes?: true;
}

/** Enable / disable the syscall trace ring. Mirrors the browser host. */
export interface SetSyscallTraceMessage {
  type: "set_syscall_trace";
  enabled: boolean;
}

/** Drain pending syscall trace events. Response carries SyscallTraceEvent[]. */
export interface DrainSyscallTraceMessage {
  type: "drain_syscall_trace";
  requestId: number;
}

/**
 * Start recording the machine's decision log.
 *
 * Only the guest clock is recorded today, because it is the only pulled
 * decision routed through the log. A machine that also reads randomness or
 * external bytes produces a log that is complete for its clock and silent
 * about the rest, so a replay of such a machine will diverge rather than
 * mislead. See `host/src/replication/log.ts`.
 */
export interface ReplicationRecordStartMessage {
  type: "replication_record_start";
  requestId: number;
}

/** Stop recording and take the log. Response carries ReplicationLogEntry[]. */
export interface ReplicationRecordStopMessage {
  type: "replication_record_stop";
  requestId: number;
}

/**
 * Serve the guest clock from `entries` instead of from this host's clock.
 *
 * Sent after `init` and before the replayed guest runs. A restore has already
 * happened by then, so one message covers both a fresh machine and a replica
 * that adopted a checkpoint.
 */
export interface ReplicationReplayStartMessage {
  type: "replication_replay_start";
  requestId: number;
  entries: readonly ReplicationLogEntry[];
}

/**
 * Stop replaying and report how far the replica got.
 *
 * The response is `{ consumed, total }`. Two replicas that consumed different
 * amounts of one log ran different machines, which is the divergence this
 * measures.
 */
export interface ReplicationReplayStopMessage {
  type: "replication_replay_stop";
  requestId: number;
}

/** What a replica took from the log it was replaying. */
export interface ReplicationReplayProgress {
  readonly consumed: number;
  readonly total: number;
}

/** Send an HTTP request to a server running in the kernel and wait for the
 *  response. Reply arrives as a `response` message whose `result` is an
 *  {@link HttpResponse}, or with `error` set if no listener was found. */
export interface HttpRequestMessage {
  type: "http_request";
  requestId: number;
  /** Port the in-kernel server is listening on. */
  port: number;
  request: HttpRequest;
  /** Optional timeout in ms (default 60_000). */
  timeoutMs?: number;
  /** Optional raw response byte ceiling. */
  maxResponseBytes?: number;
}

/** Register an `OffscreenCanvas` as the scanout target for a KMS CRTC.
 *  Mirrors the Browser-side handler. Under Node, OffscreenCanvas is only
 *  available when the host wires a polyfill; without one the worker
 *  ignores the canvas and only `attachKmsStats` is meaningful. */
export interface KmsAttachCanvasMessage {
  type: "kms_attach_canvas";
  crtcId: number;
  canvas: OffscreenCanvas;
  stats?: SharedArrayBuffer;
  opts?: { mode?: "auto" | "2d" | "webgl2" };
}

/** Register a stats SAB for a CRTC without binding a scanout canvas. */
export interface KmsAttachStatsMessage {
  type: "kms_attach_stats";
  crtcId: number;
  stats: SharedArrayBuffer;
}

export type MainToKernelMessage =
  | InitMessage
  | SpawnMessage
  | AppendStdinDataMessage
  | SetStdinDataMessage
  | PtyWriteMessage
  | PtyResizeMessage
  | InjectConnectionMessage
  | PipeReadMessage
  | PipeWriteMessage
  | PipeCloseReadMessage
  | PipeCloseWriteMessage
  | PipeIsWriteOpenMessage
  | WakeBlockedReadersMessage
  | WakeBlockedWritersMessage
  | PickListenerTargetMessage
  | TerminateProcessMessage
  | DestroyMessage
  | ExportRootfsImageMessage
  | ReadVfsFileMessage
  | WriteVfsFileMessage
  | GetForkCountRequestMessage
  | GetKernelMemoryPagesRequestMessage
  | GetSpawnScratchCapacityRequestMessage
  | SignalProcessMessage
  | ResolveExecResponseMessage
  | EnumProcsRequestMessage
  | ReadProcMapsRequestMessage
  | CaptureCheckpointRequestMessage
  | SetSyscallTraceMessage
  | DrainSyscallTraceMessage
  | ReplicationRecordStartMessage
  | ReplicationRecordStopMessage
  | ReplicationReplayStartMessage
  | ReplicationReplayStopMessage
  | HttpRequestMessage
  | KmsAttachCanvasMessage
  | KmsAttachStatsMessage;

// ── Kernel Worker → Main Thread ──

export interface ReadyMessage {
  type: "ready";
}

/** Initialization failed before the worker could publish a usable kernel. */
export interface InitErrorMessage {
  type: "init_error";
  error: string;
}

/** The dedicated kernel instance is poisoned and has stopped permanently. */
export interface KernelFatalMessage {
  type: "kernel_fatal";
  error: string;
}

export interface ResponseMessage {
  type: "response";
  requestId: number;
  result: unknown;
  error?: string;
}

export interface ExitMessage {
  type: "exit";
  pid: number;
  status: number;
}

export interface StdoutMessage {
  type: "stdout";
  pid: number;
  data: Uint8Array;
}

export interface StderrMessage {
  type: "stderr";
  pid: number;
  data: Uint8Array;
}

export interface PtyOutputMessage {
  type: "pty_output";
  pid: number;
  data: Uint8Array;
}

export interface ResolveExecRequestMessage {
  type: "resolve_exec";
  requestId: number;
  path: string;
}

/** Lazy VFS transport progress forwarded by the worker-owned root filesystem. */
export interface LazyDownloadMessage {
  type: "lazy_download";
  event: LazyDownloadEvent;
}

/**
 * Posted whenever the kernel forks, execs, or posix_spawns. Mirrors the
 * browser-side ProcEventMessage. Exit events come via the existing
 * ExitMessage; we don't duplicate them here. Spawn events always carry the
 * authoritative parent pid; exec events preserve process identity and do not.
 */
export type ProcEventMessage =
  | { type: "proc_event"; kind: "spawn"; pid: number; ppid: number }
  | { type: "proc_event"; kind: "exec"; pid: number };

export type KernelToMainMessage =
  | ReadyMessage
  | InitErrorMessage
  | KernelFatalMessage
  | ResponseMessage
  | ExitMessage
  | StdoutMessage
  | StderrMessage
  | HostDiagnosticMessage
  | PtyOutputMessage
  | ResolveExecRequestMessage
  | ProcEventMessage
  | LazyDownloadMessage;
