/**
 * Message protocol for main thread ↔ kernel worker communication.
 *
 * The kernel worker hosts the CentralizedKernelWorker and all process
 * lifecycle. The main thread is a thin UI proxy that sends messages here.
 */
import type { HttpRequest, HttpResponse } from "./networking/in-kernel-http";
import type {
  LazyDownloadEvent,
  SerializedLazyArchiveEntry,
} from "./vfs/memory-fs";
import type { HostDiagnostic, HostDiagnosticMessage } from "./host-diagnostic";
import type { ClosedLazyAsset } from "./vfs/closed-lazy-assets";
import type { PcmTransportDescriptor } from "./audio/pcm-transport";
import type { MountSpec } from "./vfs/default-mounts";
import type { MachineCheckpoint } from "./migration/checkpoint";
import type { ReplicationLogEntry } from "./replication/log";
import type { ReplicationReplaySpec } from "./replication/worker";
import {
  type BrowserCorsProxyConfig,
  validateBrowserCorsProxyConfig,
} from "./networking/browser-cors-proxy";

export type { HttpRequest, HttpResponse };
export type { HostDiagnostic } from "./host-diagnostic";

export function initializeBrowserCorsProxyForWorker<TLazyFetcher, TTlsBackend>(
  value: BrowserCorsProxyConfig | undefined,
  consumers: {
    useLazyFetcher: boolean;
    createLazyFetcher: (config: BrowserCorsProxyConfig) => TLazyFetcher;
    createTlsBackend: (options: {
      corsProxy?: BrowserCorsProxyConfig;
      onCorsProxyDiagnostic: (message: string) => void;
    }) => TTlsBackend;
    reportHostDiagnostic: (diagnostic: HostDiagnostic, level: "warn") => void;
  },
): {
  corsProxy: BrowserCorsProxyConfig | undefined;
  lazyFetcher: TLazyFetcher | undefined;
  tlsBackend: TTlsBackend;
} {
  const corsProxy = validateBrowserCorsProxyConfig(value);
  const lazyFetcher =
    corsProxy !== undefined && consumers.useLazyFetcher
      ? consumers.createLazyFetcher(corsProxy)
      : undefined;
  const tlsBackend = consumers.createTlsBackend({
    corsProxy,
    onCorsProxyDiagnostic: (message) => {
      consumers.reportHostDiagnostic(
        {
          pid: 0,
          source: "browser CORS proxy",
          message,
        },
        "warn",
      );
    },
  });
  return { corsProxy, lazyFetcher, tlsBackend };
}

// ── Main Thread → Kernel Worker ──

export interface InitMessage {
  type: "init";
  kernelWasmBytes: ArrayBuffer;
  /**
   * Pre-built VFS image bytes from MemoryFileSystem.saveImage(). The worker
   * restores and authenticates an owned memfs through the verified image-mount
   * resolver — no VFS SAB is shared with the main thread. Demos that need
   * `/etc/{passwd,group,hosts,services}` bake it into the image (see
   * apps/browser-demos/lib/kernel-owned-boot.ts::overlayEtcFromRootfs).
   */
  vfsImage: Uint8Array;
  /** Exact image/scratch mount contract. Absent preserves the host default. */
  rootfsMountSpec?: MountSpec[];
  /**
   * Boot this machine from a captured checkpoint instead of fresh state.
   *
   * The worker validates the checkpoint before instantiating anything, then
   * adopts its kernel memory and its rootfs bytes. `vfsImage` is still
   * required: the mount layout is host configuration a checkpoint does not
   * carry, so the caller supplies the same mounts the captured machine ran
   * with.
   */
  restoreCheckpoint?: MachineCheckpoint;
  /**
   * Run this machine on a primary's decisions from its very first instruction.
   *
   * A replica joining a machine that is already running restores that
   * machine's processes, and those processes resume inside this `init`. A
   * `replication_replay_start` sent afterwards therefore arrives after they
   * have read this computer's clock. Passing the replay here installs it
   * between the machine's own setup and the first restored process, so the
   * replica's first reading is the primary's.
   */
  replicationReplay?: ReplicationReplaySpec;
  /** Base URL for relative lazy file/archive URLs stored in vfsImage. */
  lazyUrlBase?: string;
  /** Exhaustive exact-byte lazy transport for this image; no network fallback. */
  closedLazyAssets?: ClosedLazyAsset[];
  shmSab: SharedArrayBuffer;
  workerEntryUrl: string;
  bridgePort?: MessagePort;
  config: {
    maxWorkers: number;
    maxMemoryPages: number;
    /**
     * Sampled live-allocation admission budget. Unmediated memory.grow can
     * cross it until the next allocation observes current byte lengths.
     */
    maxProcessMemoryBytes: number;
    /** Host default pthread slots for process-wasm declarations of -1. */
    defaultThreadSlots?: number;
    env: string[];
    /** Forwarded to KernelConfig.enableSyscallLog — log every syscall. */
    enableSyscallLog?: boolean;
    /** Forwarded to KernelConfig.syscallLogPtrWidth — only log for processes
     *  of the given pointer width. */
    syscallLogPtrWidth?: 4 | 8;
    /** Forwarded to TlsNetworkBackendOptions.dnsAliases. */
    dnsAliases?: Record<string, string>;
    /** Routes guest HTTP(S) and external lazy VFS downloads through a browser
     *  proxy when the page is not controlled by Kandelo's service worker. */
    corsProxy?: BrowserCorsProxyConfig;
  };
}

export interface SpawnMessage {
  type: "spawn";
  requestId: number;
  programPath?: string;
  programBytes?: ArrayBuffer;
  argv: string[];
  env: string[];
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
  maxPages?: number;
}

export interface TerminateProcessMessage {
  type: "terminate_process";
  requestId: number;
  pid: number;
  status: number;
}

export interface VfsFileSnapshot {
  data: Uint8Array;
  mode: number;
}

export interface ReadVfsFileMessage {
  type: "read_vfs_file";
  requestId: number;
  path: string;
  /** Return the file's permission bits with its bytes for lossless restore. */
  includeMode?: boolean;
}

export interface WriteVfsFileMessage {
  type: "write_vfs_file";
  requestId: number;
  /** Normalized absolute guest path whose parent already exists. */
  path: string;
  data: Uint8Array;
  mode: number;
}

export interface UnlinkVfsFileMessage {
  type: "unlink_vfs_file";
  requestId: number;
  path: string;
}

/**
 * Serialize the quiescent worker-owned root filesystem.
 *
 * This deliberately captures only the `/` image backend. Scratch and device
 * mounts are boot-scoped and are recreated by the host on the next boot.
 */
export interface ExportRootfsImageMessage {
  type: "export_rootfs_image";
  requestId: number;
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

export interface IsStdinConsumedMessage {
  type: "is_stdin_consumed";
  requestId: number;
  pid: number;
}

/** Deliver `signum` to `pid`. Responds `true` when the process existed. */
export interface SignalProcessMessage {
  type: "signal_process";
  requestId: number;
  pid: number;
  signum: number;
}

export interface PickListenerTargetMessage {
  type: "pick_listener_target";
  requestId: number;
  port: number;
}

export interface DestroyMessage {
  type: "destroy";
  requestId: number;
}

export interface RegisterPtyOutputMessage {
  type: "register_pty_output";
  pid: number;
}

export interface RegisterLazyFilesMessage {
  type: "register_lazy_files";
  requestId?: number;
  entries: Array<{ ino: number; path: string; url: string; size: number }>;
}

/**
 * Main-thread → kernel-worker mouse injection. The main thread captures
 * canvas mouse events and forwards them here; the worker calls
 * `CentralizedKernelWorker.injectMouseEvent` which appends a 3-byte PS/2
 * frame to the kernel queue and wakes any blocked reader of
 * `/dev/input/mice`.
 */
export interface MouseInjectMessage {
  type: "mouse_inject";
  dx: number;
  dy: number;
  buttons: number;
}

/**
 * Main-thread → kernel-worker audio drain request. The main thread's
 * AudioContext scheduler ticks every ~50 ms, asks the kernel ring for
 * up to `maxBytes` of PCM samples, and feeds them to a chained
 * `AudioBufferSourceNode`. The worker responds with the bytes plus the
 * configured (rate, channels) so the main thread can size its
 * AudioBuffer correctly.
 */
export interface AudioDrainMessage {
  type: "audio_drain";
  requestId: number;
  maxBytes: number;
}

export interface RegisterLazyArchivesMessage {
  type: "register_lazy_archives";
  requestId?: number;
  entries: SerializedLazyArchiveEntry[];
}

/** Read kernel-side per-process fork counter. Mirrors the Node host's
 * `get_fork_count` request in node-kernel-protocol.ts. The kernel-worker
 * forwards to `kernel_get_fork_count` and posts a `response` whose
 * `result` is a `bigint`. Used by the spawn regression tests to assert
 * SYS_SPAWN didn't fall back to fork. */
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

/** Snapshot the kernel's process table. The kernel-worker forwards to
 * `CentralizedKernelWorker.enumProcs()`; the response carries `ProcessSnapshot[]`.
 * Used by Kandelo's Inspector → Procs tab. */
export interface EnumProcsRequestMessage {
  type: "enum_procs";
  requestId: number;
}

/** Read `/proc/[pid]/maps` for a foreign process via the host. The kernel-
 * worker forwards to `CentralizedKernelWorker.readProcMaps(pid)`; response
 * carries a string (Linux smaps-ish text) or `null` if the pid is gone. */
export interface ReadProcMapsRequestMessage {
  type: "read_proc_maps";
  requestId: number;
  pid: number;
}

/**
 * Freeze the machine, read it, and resume it. Mirrors the Node host's
 * capture_checkpoint request in node-kernel-protocol.ts.
 *
 * Response carries a `CheckpointCaptureResponse`: a summary when the freeze
 * completed, or the reason it timed out or failed. A process that makes no
 * syscall never reaches its unwind hook, so a timeout is an ordinary outcome
 * and the machine keeps running.
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
  /**
   * Begin streaming the decision log from the state this capture reads.
   *
   * This is how a replica joins a running machine: it restores the checkpoint
   * and replays from the log's first entry, so the two have to meet at one
   * instant. The recorder starts while the machine is still parked, which no
   * caller on the main thread can arrange for itself.
   */
  beginReplicationStream?: true;
}

/** Enable / disable the syscall trace ring buffer. Off by default — flip
 * on when a subscriber attaches, off when the last one detaches. */
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
 * The guest clock and pointer movement are recorded today. Randomness and
 * external bytes are not routed through the log yet, so a machine that reads
 * either produces a log that is complete for what it holds and silent about
 * the rest. See `host/src/replication/log.ts`.
 */
export interface ReplicationRecordStartMessage {
  type: "replication_record_start";
  requestId: number;
  /**
   * Publish each decision as it is made, and keep none.
   *
   * A live replica joins at boot and needs the log from sequence 0, so
   * somebody must hold all of it. Streaming moves that holder to the main
   * thread, where the wire is, rather than keeping a second copy here.
   */
  stream?: boolean;
}

/**
 * Stop recording and take the log.
 *
 * Response carries the entries this recorder retained, which is none of them
 * when it was started with `stream`.
 */
export interface ReplicationRecordStopMessage {
  type: "replication_record_stop";
  requestId: number;
}

/** Decisions a streaming recorder made, in the order it made them. */
export interface ReplicationRecordedMessage {
  type: "replication_recorded";
  entries: readonly ReplicationLogEntry[];
}

/**
 * Serve the machine's decisions from a primary's log instead of from this host.
 *
 * Sent after `init` and before the replayed guest runs, which covers a machine
 * this host booted fresh. A replica that adopted a checkpoint cannot use it:
 * its restored processes resume inside `init` and read the clock before this
 * message could arrive, so it passes `replicationReplay` on {@link InitMessage}
 * instead.
 */
export interface ReplicationReplayStartMessage extends ReplicationReplaySpec {
  type: "replication_replay_start";
  requestId: number;
}

/**
 * Stop replaying and report how far the replica got.
 *
 * The response is a {@link ReplicationReplayProgress}. Two replicas that
 * consumed different amounts of one log ran different machines, which is the
 * divergence this measures.
 */
export interface ReplicationReplayStopMessage {
  type: "replication_replay_stop";
  requestId: number;
}

/**
 * Say the primary's log grew, so the replica applies what needs no guest.
 *
 * A keystroke or a resize has no guest request to answer: a guest that is not
 * reading the clock would never pull it out of the queue, and the queue is
 * shared memory the kernel worker only looks at when asked. Fire-and-forget —
 * the entries themselves travel on the queue, not here.
 */
export interface ReplicationReplayDrainMessage {
  type: "replication_replay_drain";
}

/**
 * A request line this replaying machine was asked for and has no replay of.
 *
 * The page asked its replica for a resource the primary's log does not carry
 * — the primary's browser served it from cache, or served it before this
 * replica joined. The primary can still make that request, so the miss is
 * reported to the main thread, where the wire to the primary is, instead of
 * waiting out the deadline into a 502.
 */
export interface ReplicationHttpMissMessage {
  type: "replication_http_miss";
  /** The request line, `"METHOD target"`, as the replay store keys it. */
  key: string;
}

/**
 * What a replica took from the log it was replaying.
 *
 * `total` is what the replica had been given, which for a live replay is what
 * the primary had recorded by the time it stopped rather than the whole of a
 * finished recording.
 */
export interface ReplicationReplayProgress {
  readonly consumed: number;
  readonly total: number;
  /**
   * Clock reads served the machine-latest reading because their process's
   * own next reading was not coming. See
   * `ReplicationLogReader.borrowedClockReadings`.
   */
  readonly borrowedClockReadings: number;
  /**
   * Accepts taken by whichever worker asked because the primary never said
   * which one won. See `ReplicationLogReader.borrowedAcceptSelections`.
   */
  readonly borrowedAcceptSelections: number;
}

/** Send an HTTP request to a server running in the kernel and wait for the
 *  response. Reply arrives as a `response` message whose `result` is an
 *  {@link HttpResponse}. */
export interface HttpRequestMessage {
  type: "http_request";
  requestId: number;
  port: number;
  request: HttpRequest;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

/** Register an `OffscreenCanvas` as the scanout target for a KMS CRTC.
 *  The kernel-worker's vblank pump blits the CRTC's bound framebuffer
 *  into this canvas at 60 Hz. The canvas MUST be transferred (the
 *  `transfer` array contains it) — the browser would otherwise refuse
 *  to hand off control. Optional `stats` SAB receives blit/page-flip
 *  telemetry. */
export interface KmsAttachCanvasMessage {
  type: "kms_attach_canvas";
  crtcId: number;
  canvas: OffscreenCanvas;
  stats?: SharedArrayBuffer;
  opts?: { mode?: "auto" | "2d" | "webgl2" };
}

/** Register a stats SAB for a CRTC without binding a scanout canvas. The
 *  vblank pump still writes kernel-side `commit_count` / `last_frame_us`
 *  into slots 5/6. Used by GL-rendered demos that present via WebGL
 *  rather than the 2D blit path. */
export interface KmsAttachStatsMessage {
  type: "kms_attach_stats";
  crtcId: number;
  stats: SharedArrayBuffer;
}

/**
 * Confirms that BrowserKernel dropped its own structured-clone Memory wrapper
 * and framebuffer-registry views for one exact execution generation. Callers
 * can retain a wrapper returned by getProcessMemory(), so this is not a
 * JavaScript-realm-wide garbage-collection claim.
 */
export interface FbReleaseGenerationAckMessage {
  type: "fb_release_generation_ack";
  requestId: number;
}

export type MainToKernelMessage =
  | InitMessage
  | SpawnMessage
  | TerminateProcessMessage
  | ReadVfsFileMessage
  | WriteVfsFileMessage
  | UnlinkVfsFileMessage
  | ExportRootfsImageMessage
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
  | IsStdinConsumedMessage
  | SignalProcessMessage
  | PickListenerTargetMessage
  | DestroyMessage
  | RegisterPtyOutputMessage
  | RegisterLazyFilesMessage
  | RegisterLazyArchivesMessage
  | GetForkCountRequestMessage
  | GetKernelMemoryPagesRequestMessage
  | GetSpawnScratchCapacityRequestMessage
  | MouseInjectMessage
  | AudioDrainMessage
  | EnumProcsRequestMessage
  | ReadProcMapsRequestMessage
  | CaptureCheckpointRequestMessage
  | SetSyscallTraceMessage
  | DrainSyscallTraceMessage
  | ReplicationRecordStartMessage
  | ReplicationRecordStopMessage
  | ReplicationReplayStartMessage
  | ReplicationReplayStopMessage
  | ReplicationReplayDrainMessage
  | HttpRequestMessage
  | KmsAttachCanvasMessage
  | KmsAttachStatsMessage
  | FbReleaseGenerationAckMessage;

// ── Kernel Worker → Main Thread ──

export interface ReadyMessage {
  type: "ready";
  /** Versioned PCM-only shared transport claimed by the kernel worker. */
  pcmTransport?: PcmTransportDescriptor;
}

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
  /** Host-only execution identity. PIDs persist across exec. */
  generation: number;
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

export interface ListenTcpMessage {
  type: "listen_tcp";
  pid: number;
  fd: number;
  port: number;
}

/**
 * Forwarded /dev/fb0 binding. Fired when a process mmaps the
 * framebuffer; the main thread builds a typed-array view over
 * `memory.buffer` at `[addr, addr+len)` and presents it on a canvas.
 *
 * `memory` is the process's WebAssembly.Memory — a SharedArrayBuffer
 * shared with the kernel worker. Sending the Memory across postMessage
 * is fine; both threads see the same SAB.
 */
export interface FbBindMessage {
  type: "fb_bind";
  pid: number;
  /** Host-only execution identity. PIDs persist across exec. */
  generation: number;
  addr: number;
  len: number;
  w: number;
  h: number;
  stride: number;
  fmt: "BGRA32";
  memory: WebAssembly.Memory;
}

export interface FbUnbindMessage {
  type: "fb_unbind";
  pid: number;
  /** The exact execution generation whose binding was removed. */
  generation: number;
}

/**
 * Fired when a process's WebAssembly.Memory is replaced (memory.grow,
 * exec). The main-thread renderer must invalidate any cached view; the
 * `memory` reference is the new (post-grow) Memory.
 */
export interface FbRebindMemoryMessage {
  type: "fb_rebind_memory";
  pid: number;
  /** The exact execution generation whose Memory grew. */
  generation: number;
  memory: WebAssembly.Memory;
}

/**
 * Forwarded write-based pixel push. Used by software (e.g. fbDOOM)
 * that does `write(fd_fb, …)` rather than mmap. Bytes are copied out
 * of kernel scratch in the worker — `bytes` here is a transferable
 * Uint8Array (non-shared); the main thread copies it into the
 * registry's per-pid hostBuffer.
 */
export interface FbWriteMessage {
  type: "fb_write";
  pid: number;
  /** The exact execution generation that produced these pixels. */
  generation: number;
  offset: number;
  bytes: Uint8Array;
}

/**
 * A process-generation teardown fence. The main thread first drops its
 * structured-clone Memory wrapper and cached framebuffer views, then replies
 * with FbReleaseGenerationAckMessage. The kernel worker does not classify a
 * framebuffer-exposed generation as exactly retired before this round trip.
 */
export interface FbReleaseGenerationMessage {
  type: "fb_release_generation";
  requestId: number;
  pid: number;
  generation: number;
}

/**
 * Clears the short-lived terminal-generation tombstone after the kernel worker
 * receives the release ACK. Exact-generation quiescence plus message ordering
 * guarantee that no bind from this or an older generation can still arrive
 * after this marker.
 */
export interface FbForgetGenerationMessage {
  type: "fb_forget_generation";
  pid: number;
  generation: number;
}

/**
 * Posted whenever the kernel forks, execs, or spawns. The main thread
 * uses this to refresh Inspector-style views without polling. `kind ===
 * "exit"` is delivered via the existing ExitMessage instead; we don't
 * duplicate it here. Spawn events always carry the authoritative parent pid;
 * exec events preserve process identity and do not.
 */
export type ProcEventMessage =
  | { type: "proc_event"; kind: "spawn"; pid: number; ppid: number }
  | { type: "proc_event"; kind: "exec"; pid: number };

/**
 * Number of service-worker preview requests currently being served through
 * the transferred HTTP bridge.
 */
export interface HttpBridgePendingMessage {
  type: "http_bridge_pending";
  count: number;
}

export interface LazyDownloadMessage {
  type: "lazy_download";
  event: LazyDownloadEvent;
}

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
  | ListenTcpMessage
  | FbBindMessage
  | FbUnbindMessage
  | FbRebindMemoryMessage
  | FbWriteMessage
  | FbReleaseGenerationMessage
  | FbForgetGenerationMessage
  | ProcEventMessage
  | HttpBridgePendingMessage
  | LazyDownloadMessage
  | ReplicationRecordedMessage
  | ReplicationHttpMissMessage;
