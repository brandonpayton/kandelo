import type { DemoGuideConfig, DemoIngestConfig } from "./demo-config";
import { advanceLazyDownloadSummary } from "./lazy-download";

// KernelHost — the contract between Kandelo session UI and the kernel/host runtime.
//
// Every Kandelo UI surface (Sidebar, LiveURLBar, MachineView, Inspector tabs,
// Gallery, Share dialog, System Config, EmptyState) consumes this one
// interface. LiveKernelHost wraps the real host runtime in host/src/.
//
// The full schema for BootDescriptor is `docs/plans/2026-05-11-shareable-
// computer-url-design.md`. The encode/decode/snapshot machinery lives under
// web-libs/kandelo-session/src/{boot-descriptor,snapshot}.ts;
// LiveKernelHost.snapshot will call into those.
//
// This file is the reusable session surface shared by the browser app and
// future embedders. Runtime-specific boot wiring lives in the consuming page.

// ── Kernel surface this file consumes ──────────────────────────────────────
//
// LiveKernelHost wraps a "browser-kernel-shaped" object. We don't import the
// browser demo kernel here. Instead we describe the minimum surface the UI
// needs so any concrete kernel (KernelLike today, a thinner host-side wrapper
// later) satisfies it.
//
// All methods match `BrowserKernel`'s existing signatures verbatim.

/**
 * Synchronous VFS subset LiveKernelHost reaches into for inspector + readDir.
 * Matches MemoryFileSystem (host/src/vfs/memory-fs.ts).
 */
export interface FileSystemLike {
  /** Throws on missing path. */
  stat(path: string): { mode: number; size: number; mtimeMs: number; uid: number; gid: number };
  open(path: string, flags: number, mode: number): number;
  close(handle: number): number;
  /** Returns bytes read, 0 on EOF. */
  read(handle: number, buffer: Uint8Array, offset: number | null, length: number): number;
  /** Read symlink target. Throws if path isn't a symlink. */
  readlink(path: string): string;
  /** Open a directory handle for use with readdir/closedir. Throws on missing. */
  opendir(path: string): number;
  /** Returns next entry or null at end-of-dir. */
  readdir(handle: number): { name: string; type: number; ino: number } | null;
  closedir(handle: number): void;
}

/**
 * Snapshot record returned by `KernelLike.enumProcs`. Mirrors
 * `host/src/kernel-worker.ts: ProcessSnapshot`. Duplicated as a local
 * structural type so this file doesn't depend on host/'s wire types.
 */
export interface KernelProcessSnapshot {
  pid: number;
  ppid: number;
  uid: number;
  gid: number;
  vsizeBytes: number;
  memoryBytes?: number;
  state: "R" | "Z" | "S" | "D" | "T" | "I";
  comm: string;
  cmdline: string;
}

/**
 * Minimum FramebufferRegistry surface the canvas attacher needs. Match
 * `host/src/framebuffer/registry.ts`; redefined as a structural type so
 * kandelo-session doesn't drag the concrete class into UI bundles.
 */
export interface FramebufferRegistryLike {
  list(): Array<{ pid: number }>;
  onChange(fn: (pid: number, ev: "bind" | "unbind") => void): () => void;
  /**
   * The binding for `pid`, or undefined when nothing is bound. `hostBuffer`
   * holds the pixels of a write-based binding and is null for an mmap-based
   * one, whose pixels live in the process's own memory instead.
   */
  get(pid: number): {
    readonly w: number;
    readonly h: number;
    readonly stride: number;
    readonly hostBuffer: Uint8ClampedArray | null;
  } | undefined;
  /** Subscribe to the pixel writes of every write-based binding. */
  onWrite(fn: (pid: number, offset: number, bytes: Uint8Array) => void): () => void;
}

/**
 * Raw syscall trace event surfaced by `KernelLike.subscribeSyscalls`.
 * Mirrors host/src/kernel-worker.ts: SyscallTraceEvent — duplicated
 * as a structural type so kandelo-session doesn't pull host's wire types.
 */
export interface KernelSyscallEvent {
  t: number;
  pid: number;
  nr: number;
  args: [
    number | bigint,
    number | bigint,
    number | bigint,
    number | bigint,
    number | bigint,
    number | bigint,
  ];
}

export type LazyDownloadKind = "file" | "tree" | "archive";
export type LazyDownloadStatus = "started" | "progress" | "complete" | "error";

export interface LazyDownloadEvent {
  id: string;
  kind: LazyDownloadKind;
  status: LazyDownloadStatus;
  url: string;
  path?: string;
  mountPrefix?: string;
  loadedBytes: number;
  totalBytes?: number;
  error?: string;
  t: number;
}

/**
 * Authoritative latest state for one lazy VFS transport asset.
 *
 * `lazyDownloadHistory()` is intentionally a bounded chronological event log,
 * so a large streamed response can evict an earlier asset's events. Summaries
 * collapse every event for one stable download id into one record. Summary
 * storage grows with the number of distinct assets observed by the currently
 * attached kernel, rather than with response chunk count; it has no fixed
 * asset cap.
 */
export interface LazyDownloadSummary extends LazyDownloadEvent {
  /** Timestamp of the first event observed for this asset. */
  firstSeenAt: number;
  /** Most recent `started` event, or first observation if no start was seen. */
  startedAt: number;
  /** Number of raw events observed for this asset, including this state. */
  eventCount: number;
}

export interface KernelLike {
  /** Legacy synchronous VFS surface; worker-owned hosts intentionally omit it. */
  readonly fs?: FileSystemLike;
  /** /dev/fb0 binding registry. Used by attachFramebuffer. */
  readonly framebuffers?: FramebufferRegistryLike;
  /**
   * Per-pid wasm Memory accessor. Needed for mmap-based framebuffer
   * bindings; write-based bindings (fbDOOM) don't reach into this.
   */
  getProcessMemory?(pid: number): WebAssembly.Memory | undefined;
  /**
   * Deliver a POSIX signal to `pid` through the kernel's signal path (not a
   * host-side worker teardown). Resolves false when the process is already
   * gone. Used to stop a process that owns a single-owner device — e.g. the
   * /dev/fb0 holder — before launching its replacement.
   */
  signalProcess?(pid: number, signum: number): Promise<boolean>;
  /**
   * Write `bytes` to `path` in the kernel-owned VFS. Its parent must already
   * exist. The kernel worker owns the filesystem, so this is an async
   * round-trip (unlike the deprecated synchronous {@link fs}).
   */
  writeFileToVfs?(path: string, bytes: Uint8Array, mode?: number): Promise<void>;
  /**
   * Freeze this machine, read it whole, and resume it. The machine keeps
   * running: every buffer in the result is a copy the freeze took, which is
   * what a restore on another computer consumes. Mirrors
   * `host/src/migration/checkpoint.ts: CheckpointFreezeResult`.
   */
  captureCheckpointBytes?(options: {
    unwindTimeoutMs: number;
    vforkTimeoutMs: number;
  }): Promise<
    | { readonly status: "captured"; readonly checkpoint: MachineCheckpointLike }
    | { readonly status: "timed-out" | "failed"; readonly reason: string }
  >;
  /**
   * Read this machine and start publishing its decisions from that state.
   *
   * One operation, not a read followed by a start: the recorder begins while
   * the machine is still parked inside the freeze, so a replica that restores
   * the checkpoint and replays from the log's first entry meets the machine at
   * one instant. Mirrors
   * `host/src/browser-kernel-host.ts: captureAndStreamReplicationLog`.
   */
  captureAndStreamReplicationLog?(
    options: { unwindTimeoutMs: number; vforkTimeoutMs: number },
    onEntries: (entries: readonly ReplicationLogEntryLike[]) => void,
  ): Promise<{
    readonly capture:
      | { readonly status: "captured"; readonly checkpoint: MachineCheckpointLike }
      | { readonly status: "timed-out" | "failed"; readonly reason: string };
    readonly stop: () => Promise<void>;
  }>;
  /**
   * Stop replaying a primary's log, and report how much of it this machine
   * took.
   *
   * Two replicas given one log and left at different counts ran different
   * machines, so a viewer that stops following says how far it got rather than
   * stopping silently. Mirrors
   * `host/src/browser-kernel-host.ts: stopReplicationReplay`.
   */
  stopReplicationReplay?(): Promise<{
    readonly consumed: number;
    readonly total: number;
  }>;
  /**
   * Tell a replaying machine its log grew, so it applies what needs no guest.
   *
   * A keystroke or a resize the primary recorded has no guest request to
   * answer, and a replica whose guest sits at a prompt would never pull it
   * through on its own. Mirrors
   * `host/src/browser-kernel-host.ts: drainReplicationReplay`.
   */
  drainReplicationReplay?(): void;
  /**
   * Append bytes to a process's stdin buffer. Used by the framebuffer
   * input path so DOM key events on the canvas reach the fb-bound
   * process (fbDOOM reads scancodes from stdin).
   */
  appendStdinData?(pid: number, data: Uint8Array): void;
  /**
   * Inject one PS/2 mouse event into `/dev/input/mice`. Deltas use the
   * device convention: positive X is right, positive Y is up; buttons are
   * bit0=left, bit1=right, bit2=middle.
   */
  injectMouseEvent?(dx: number, dy: number, buttons: number): void;
  /**
   * Hand an `OffscreenCanvas` to the kernel worker as the scanout
   * target for KMS CRTC `crtcId`. Optional `stats` SAB receives
   * blit + page-flip telemetry. `opts.mode` declares how the canvas
   * is painted (see `CentralizedKernelWorker.attachKmsCanvas`):
   * `"auto"` (default) defers context acquisition to whichever path
   * arrives first; `"2d"` opts into the legacy CPU-blit pump; `"webgl2"`
   * tells the pump the canvas is GL-owned so it stays hands-off and
   * lets a libdrm/libgbm/EGL program (e.g. modeset.c) claim it.
   */
  kmsAttachCanvas?(
    crtcId: number,
    canvas: OffscreenCanvas,
    stats?: SharedArrayBuffer,
    opts?: { mode?: "auto" | "2d" | "webgl2" },
  ): void;
  /**
   * Register a stats SAB for `crtcId` without binding a scanout
   * canvas. Used by WebGL-rendered demos that want page-flip
   * telemetry without a 2D blit.
   */
  kmsAttachStats?(crtcId: number, stats: SharedArrayBuffer): void;
  /**
   * Legacy main-thread PCM drain endpoint.
   *
   * @deprecated PCM playback is owned by the machine-level host and its
   * AudioWorklet transport. New callers should use `resumeAudio`.
   */
  drainAudio?(maxBytes: number): Promise<{
    bytes: Uint8Array;
    sampleRate: number;
    channels: number;
  }>;
  prepareAudio?(): Promise<void>;
  resumeAudio?(): Promise<void>;
  suspendAudio?(): Promise<void>;
  getAudioState?(): MachineAudioState;
  onAudioStateChange?(cb: (state: MachineAudioState) => void): () => void;
  /**
   * Subscribe to the kernel-worker's live syscall trace. Each event
   * carries the raw syscall number + args + firing pid. The underlying
   * ring buffer is enabled lazily; nothing runs on the syscall hot path
   * when nobody's watching.
   */
  subscribeSyscalls?(cb: (event: KernelSyscallEvent) => void): () => void;
  /**
   * Subscribe to lazy VFS file/archive downloads. The worker emits these
   * when it materializes content on first exec/open.
   */
  subscribeLazyDownloads?(cb: (event: LazyDownloadEvent) => void): () => void;
  spawn(
    programBytes: ArrayBuffer,
    argv: string[],
    options?: {
      env?: string[];
      cwd?: string;
      uid?: number;
      gid?: number;
      pty?: boolean;
      stdin?: Uint8Array;
      ptyCols?: number;
      ptyRows?: number;
      onStarted?: (pid: number) => void | Promise<void>;
    },
  ): Promise<number>;
  spawnFromVfs?(
    programPath: string,
    argv: string[],
    options?: {
      env?: string[];
      cwd?: string;
      uid?: number;
      gid?: number;
      pty?: boolean;
      stdin?: Uint8Array;
      ptyCols?: number;
      ptyRows?: number;
    },
  ): Promise<{ pid: number; exit: Promise<number> }>;
  onPtyOutput(pid: number, callback: (data: Uint8Array) => void): void;
  ptyWrite(pid: number, data: Uint8Array): void;
  ptyResize(pid: number, rows: number, cols: number): void;
  terminateProcess(pid: number, status?: number): Promise<void>;
  destroy?(): Promise<void>;
  /**
   * Snapshot the kernel's process table. Returns an empty array if the
   * kernel doesn't expose `kernel_enum_procs` yet (older ABI).
   */
  enumProcs?(): Promise<KernelProcessSnapshot[]>;
  /**
   * Read `/proc/[pid]/maps` for a foreign process. Returns null if the
   * pid is gone or the export isn't available.
   */
  readProcMaps?(pid: number): Promise<string | null>;
}

// ── Status & lifecycle ─────────────────────────────────────────────────────

export type MachineStatus =
  | "idle"      // no descriptor applied yet
  | "booting"   // applyBootDescriptor is in progress; dmesg streams
  | "running"   // init reached steady state
  | "halted"    // explicit shutdown
  | "error";

// ── Boot descriptor (mirrors docs/plans/2026-05-11-shareable-computer-url-design.md) ──

export interface BootDescriptor {
  version: 1;
  id: string;                       // short handle, e.g. "lamp-php84"
  title: string;
  base: string;                     // "kandelo:shell@abi8"
  runtime: RuntimeConfig;
  packages: string[];               // ["python@sha256:..."]
  mounts: DescriptorMount[];
  boot: BootCommand;
  caps?: Capabilities;
}

export interface RuntimeConfig {
  arch: "wasm32" | "wasm64";
  kernel: string;                   // "kernel@sha256:..."
  memoryPages: number;              // process memory in 64 KiB pages
  features: string[];               // ["shared-array-buffer","pty","tcp-bridge"]
  time: "real" | "frozen" | "deterministic";
}

export type MountSource =
  | "image"           | "package-layer" | "inline-overlay" | "remote-overlay"
  | "scratch"         | "opfs"          | "lazy-http"      | "archive"
  | "git"             | "cas"           | "encrypted"      | "device";

export interface DescriptorMount {
  path: string;
  source: MountSource;
  ref?: string;                     // content hash for image / package-layer / cas
  name?: string;                    // workspace name for opfs
  url?: string;                     // immutable package-layer descriptor URL
  bytes?: number;                   // exact package-layer descriptor byte count
  data?: string;                    // base64url(zstd(cbor(...))) for inline-overlay
  readonly?: boolean;
  ephemeral?: boolean;
}

export interface BootCommand {
  argv: string[];
  cwd: string;
  env: Record<string, string>;
  uid?: number;
  gid?: number;
}

export interface Capabilities {
  network?: boolean;
  persistence?: boolean;
  clipboard?: boolean;
  camera?: boolean;
  microphone?: boolean;
  filesystem?: boolean;
  signedSources?: string[];         // required signature roots
}

// ── Machine handover ───────────────────────────────────────────────────────

/**
 * A frozen machine, as the wrapped kernel produced it.
 *
 * The session layer never reads inside one. It carries the value from the
 * capture that made it to the restore that consumes it, and the host runtime
 * owns its schema (`host/src/migration/checkpoint.ts: MachineCheckpoint`).
 * Only the pid list is named here, because the UI reports which processes
 * moved and nothing else.
 */
export interface MachineCheckpointLike {
  readonly processes: ReadonlyArray<{ readonly pid: number }>;
}

/**
 * One decision a machine's host made for it, as the wrapped kernel recorded it.
 *
 * Read no more here than the checkpoint above is: the session layer carries
 * entries from the machine that recorded them to the replica that replays
 * them, and the host runtime owns their schema
 * (`host/src/replication/log.ts: ReplicationLogEntry`). Only the sequence
 * number is named, because ordering is the one property this layer must not
 * disturb.
 */
export interface ReplicationLogEntryLike {
  readonly seq: number;
}

/**
 * What a replica needs to run on the user's decisions instead of its own.
 *
 * `entries` is what the user had already recorded when the replica joined, and
 * `queue` is where everything it records afterwards arrives. The queue is
 * shared memory because the replica's kernel worker blocks on it: a guest
 * clock read is synchronous, so a replica that has caught up with the user
 * cannot await the next decision and cannot receive it as a message. The host
 * runtime owns the ring's layout
 * (`host/src/replication/log-queue.ts`).
 */
export interface MachineReplayLike {
  readonly entries: readonly ReplicationLogEntryLike[];
  readonly queue: SharedArrayBuffer;
  /**
   * Say that no further decision is coming, and let a waiting replica run on.
   *
   * A replica that has caught up with the user blocks its kernel worker on the
   * queue, and a blocked worker answers nothing — not a stop, not a capture,
   * not the graceful half of its own teardown. So every path that lets go of a
   * replica's kernel calls this first: without it, closing a machine that is
   * merely waiting costs the destroy timeout before the worker is terminated
   * out from under it.
   */
  release(): void;
}

/**
 * One terminal, as it moves with the machine that draws it.
 *
 * A terminal is machine state, not a view of one. The checkpoint restores the
 * process on the far end of the PTY, but which process that is, how large its
 * window was, and what it had already printed are all held by the computer
 * that was showing it. A handover carrying only the checkpoint lands on a
 * computer that knows a shell exists somewhere but not where, so it starts a
 * second one on the same PTY — two processes reading one keyboard, each
 * taking characters the other was meant to get — and draws that new shell's
 * banner over a screen the person was in the middle of reading.
 */
export interface CapturedTerminal {
  /** The key the session was attached under, such as `/dev/pts/0`. */
  readonly path: string;
  /** The process on the far end. A restore preserves pids, so this finds it. */
  readonly pid: number;
  readonly cols: number;
  readonly rows: number;
  /** What the terminal had printed, capped to a screen's worth and more. */
  readonly screen: Uint8Array;
}

/**
 * One machine, ready to move to another computer: the frozen processes, the
 * descriptor naming the image they run on, and the terminals they are talking
 * to.
 *
 * All three travel because a taker may hold nothing at all. A computer that
 * received only the checkpoint would have no image to restore it into, and no
 * way to reach the restored processes through a terminal.
 */
export interface CapturedMachine {
  readonly checkpoint: MachineCheckpointLike;
  readonly boot: BootDescriptor;
  readonly terminals: readonly CapturedTerminal[];
}

// ── Streaming primitives ───────────────────────────────────────────────────

export type DmesgLevel = "info" | "warn" | "err" | "ok" | "debug";

export interface DmesgLine {
  t: number;                        // monotonic ms since boot
  level: DmesgLevel;
  facility: string;                 // "kernel", "systemd", "init", "audit"
  msg: string;
}

/**
 * A second reader for a terminal somebody else is driving.
 *
 * It carries no authority over the session at all. The emulator that attached
 * it owns `cols`/`rows`, and a sharer reads them to size its own view. Nor can
 * a sharer type: the computer holding the machine keeps the keyboard, so
 * everything that could change the session — `write` included — belongs on
 * {@link PtyHandle}.
 */
export interface SharedPtyHandle {
  onData(cb: (bytes: Uint8Array) => void): () => void;
  size(): { cols: number; rows: number };
  /** Detach this handle and its listeners without removing the logical PTY. */
  close(): void;
}

export interface PtyHandle extends SharedPtyHandle {
  write(bytes: string | Uint8Array): void;
  resize(cols: number, rows: number): void;
}

export interface TerminalProgram {
  programPath: string;
  programBytes?: ArrayBuffer;
  argv: string[];
  env?: string[];
  cwd?: string;
  uid?: number;
  gid?: number;
}

export interface TerminalSessionPolicy {
  initial: TerminalProgram;
  afterExit?: TerminalProgram;
  shortRunThresholdMs: number;
  initialRestartDelayMs: number;
  maximumRestartDelayMs: number;
}

/**
 * Handle returned by `attachFramebuffer`. The canvas is wired up to paint
 * frames; this handle lets the embedder bridge input for whichever
 * process is currently bound to `/dev/fb0` (fbDOOM, fbtest, etc.).
 *
 * Keyboard input is delivered as raw bytes to the bound process's stdin —
 * the same channel fbDOOM reads scancodes from. Mouse input goes through
 * `/dev/input/mice`. PCM playback belongs to the machine-level host.
 */
export interface FramebufferHandle {
  /** Send raw bytes to the fb-bound process's stdin. No-op if nothing is bound. */
  sendInput(bytes: Uint8Array): void;
  /**
   * Send one mouse event to `/dev/input/mice`. No-op if no framebuffer
   * process is bound or the wrapped kernel lacks mouse injection support.
   */
  sendMouseEvent(dx: number, dy: number, buttons: number): void;
  /**
   * Return a compatibility handle for the machine-level PCM output.
   *
   * @deprecated PCM is not framebuffer-scoped. Call `KernelHost.resumeAudio`
   * from a trusted user gesture instead. Closing this compatibility handle
   * does not stop machine audio.
   */
  startAudio(): Promise<AudioOutputHandle | null>;
  /** Pid currently bound to /dev/fb0, or null if no binding is live. */
  getBoundPid(): number | null;
  /** Subscribe to bound-pid changes. Fires with the new pid or null on unbind. */
  onBoundPidChange(cb: (pid: number | null) => void): () => void;
  /** Detach the canvas and stop forwarding events. */
  close(): void;
}

/**
 * A second reader for the framebuffer somebody else is driving.
 *
 * It paints nothing and claims no input: the pane that attached the canvas
 * keeps both, and a sharer only reads which process owns `/dev/fb0` and the
 * pixels that process produces. Watching a machine therefore cannot move it.
 * Anything that could change the binding belongs on {@link FramebufferHandle}.
 */
export interface SharedFramebufferHandle {
  /** The live binding registry a framebuffer mirror publishes from. */
  readonly registry: FramebufferRegistryLike;
  /** Pid currently bound to /dev/fb0, or null if no binding is live. */
  getBoundPid(): number | null;
  /** Subscribe to bound-pid changes. Fires with the new pid or null on unbind. */
  onBoundPidChange(cb: (pid: number | null) => void): () => void;
  /** Detach this handle and its listeners without disturbing the binding. */
  close(): void;
}

/**
 * Legacy Web Audio-shaped output handle retained for source compatibility.
 *
 * @deprecated Use the machine-level audio methods on `KernelHost`.
 */
export interface AudioOutputHandle {
  resume(): Promise<void>;
  close(): void;
  getState(): AudioContextState | "unavailable";
}

export type MachineAudioState =
  | "unavailable"
  | "unprepared"
  | "suspended"
  | "running"
  | "interrupted"
  | "closed"
  | "error";

/**
 * Handle returned by `attachKmsDisplay`. The wrapped canvas is wired up
 * as the scanout target for a KMS CRTC; whatever wasm process holds
 * DRM master and commits page-flips drives the pixels.
 *
 * Stats slots (Int32Array view over the SAB the handle owns):
 *   0: frame count (host pump, monotonic)
 *   1: last blit timestamp (ms, performance.now() | 0)
 *   2: current scanout width
 *   3: current scanout height
 *   4: last blit µs
 *   5: kernel-side PAGE_FLIP commit count
 *   6: kernel-side last frame µs (clock at PAGE_FLIP completion)
 */
export interface KmsDisplayHandle {
  /** CRTC the canvas is bound to (matches what the wasm process passes
   *  to `drmModePageFlip(crtc_id, …)`). */
  readonly crtcId: number;
  /** Int32Array view over the stats SAB. Slots above. */
  readonly stats: Int32Array;
  /** Inject one PS/2-style mouse event into the kernel's
   *  `/dev/input/mice`. The renderer (e.g. modeset.c → Pavel's fluid sim)
   *  reads cursor + button state from there. Deltas use the same
   *  convention as `KernelHost.injectMouseEvent` (positive X right,
   *  positive Y up). `buttons` uses PS/2 bits: bit0=left, bit1=right,
   *  bit2=middle. No-op when the wrapped kernel lacks mouse injection. */
  sendMouseEvent(dx: number, dy: number, buttons: number): void;
  /** Detach the canvas. Subsequent vblank ticks no-op for this CRTC. */
  close(): void;
}

export type WebPreviewStatus = "starting" | "running" | "error";

export interface WebPreviewState {
  label: string;
  url: string;
  status: WebPreviewStatus;
  message?: string;
  pendingRequests?: number;
}

// ── Presentation intent ──────────────────────────────────────────────────

export type PrimarySurface = "syslog" | "terminal" | "framebuffer" | "web" | "kms";

export type SurfaceAvailability = Record<PrimarySurface, boolean>;

export interface DemoPresentation {
  /**
   * Surface that should dominate while the machine is booting. Most demos use
   * syslog so users can see real startup progress.
   */
  bootPrimary: PrimarySurface;
  /**
   * Ordered surface preferences once the demo is ready for use. The UI picks
   * the first available surface and falls back as runtime state changes.
   */
  runningPrimary: PrimarySurface[];
  /** Where the terminal lives when it is not the primary surface. */
  terminalAccess: "primary" | "drawer" | "side";
  /** Where detailed system views live when they are not primary. */
  internalsAccess: "primary" | "drawer" | "side";
  /**
   * Optional command to inject into the persistent shell after boot. Used by
   * framebuffer demos so exiting the app returns to the shell command.
   */
  autoCommand?: string;
  /**
   * Whether the demo wants an on-screen touch control overlay on coarse-pointer
   * devices. Used by keyboard-driven framebuffer demos that are otherwise
   * unplayable without a physical keyboard.
   */
  touchControls?: boolean;
}

// ── Process lifecycle events ──────────────────────────────────────────────
//
// Surfaces that render process state (Inspector → Procs, Memory map, top-
// like views) should subscribe to these instead of polling. The kernel
// already emits spawn/exec/exit internally; we just plumb them out so the
// UI can refetch enumProcs() on demand without scheduling timers.

export interface ProcessEvent {
  /** What happened to the process. */
  kind: "spawn" | "exec" | "exit";
  pid: number;
  /** Set when kind === "exit". Same value the kernel returned. */
  exitStatus?: number;
  /** Set when kind === "spawn". The parent that called spawn/fork/exec. */
  ppid?: number;
}

// ── Inspector data ─────────────────────────────────────────────────────────

export interface ProcessInfo {
  pid: number;
  ppid: number;
  user: string;
  cmdline: string;
  state: "R" | "S" | "D" | "T" | "Z" | "I";
  memory: string;                   // WebAssembly.Memory size when available
}

export type VfsKind = "d" | "f" | "l" | "b" | "c" | "p" | "s";

export interface VfsDirent {
  name: string;
  kind: VfsKind;
  mode: string;                     // "drwxr-xr-x"
  owner: string;                    // user name when known, otherwise uid
  group: string;                    // group name when known, otherwise gid
  size: string;                     // human-readable
  mtime?: string;
  target?: string;                  // for symlinks
}

export interface MountInfo {
  source: string;                   // "kandelo-vfs", "tmpfs"
  target: string;                   // "/", "/proc"
  fs: string;
  opts: string;
}

export interface KernelStateKV {
  k: string;
  v: string;
}

export interface MemMapEntry {
  range: string;                    // "00400000-005c2000"
  perm: string;                     // "r-xp", "rw-p"
  offset: string;
  size: string;
  path: string;                     // "/bin/bash", "[heap]", "[stack]"
}

export interface SyscallEvent {
  t: string;                        // "+0.001012"
  pid?: number;
  call: string;                     // "openat", "mmap"
  args: string;                     // formatted args string
  ret: string;                      // "0", "-1 EINVAL"
}

export interface SyscallFilter {
  pid?: number;
  call?: string;
  names?: string[];
}

// ── Sharing ────────────────────────────────────────────────────────────────

export type ShareMode =
  | "preset" | "inline" | "delta" | "manifest" | "private" | "local"
  | "recipe" | "replay" | "live" | "auto";

export interface Snapshot {
  descriptor: BootDescriptor;
  mode: Exclude<ShareMode, "auto">;
  byteSize: number;
  reason: string;                   // human-readable explanation
}

export interface SnapshotOptions {
  preferMode?: ShareMode;
  encryptionKey?: CryptoKey;
}

// ── Gallery ────────────────────────────────────────────────────────────────

export type GalleryTab = "presets" | "recent" | "saved" | "shared" | "public";

export interface GalleryItem {
  id: string;
  title: string;
  summary: string;
  base: string;
  packages: string[];
  bootCommand: string[];
  /** Direct .vfs or .vfs.zst image URL used for bootable deep links. */
  vfsImageUrl?: string;
  /**
   * Resolve an optional local image URL only when the user launches this item.
   * Remote/serialized gallery records should use `vfsImageUrl`; this callback
   * is for in-process providers whose Vite asset may not be materialized.
   */
  resolveVfsImageUrl?: () => Promise<string>;
  accent: string;
  glyph: string;
  estimatedUrlBytes: number;
  lastBootedAt?: string;
  forks?: number;
  author?: string;
}

export interface GalleryQuery {
  tab: GalleryTab;
  q?: string;
}

// ── The interface ──────────────────────────────────────────────────────────

export interface KernelHost {
  // status
  getStatus(): MachineStatus;
  subscribeStatus(cb: (s: MachineStatus) => void): () => void;

  // descriptor lifecycle
  getBootDescriptor(): BootDescriptor;
  applyBootDescriptor(desc: BootDescriptor): Promise<void>;
  halt(): Promise<void>;
  reboot(): Promise<void>;

  // machine handover — one machine moves between computers, whole and running.
  // A mirror only shows a machine; these three methods move one.
  /**
   * Freeze this machine and read it whole, for another computer to restore.
   * Null when there is no machine here, or when the wrapped kernel cannot
   * capture one. Rejects when a capture was attempted and failed.
   *
   * The machine keeps running: a capture that is never delivered must leave it
   * exactly where it was.
   */
  captureMachine(): Promise<CapturedMachine | null>;
  /**
   * Give this machine up because it now runs on another computer. Ends at
   * `idle`, not `halted`: nothing was shut down.
   */
  releaseMachine(): Promise<void>;
  /**
   * Boot `desc` and restore `checkpoint` into it, so a machine another
   * computer froze carries on running here.
   *
   * `terminals` are the sessions that machine had open. The first emulator to
   * attach to one adopts the restored process instead of starting a second on
   * the same PTY, and redraws the screen the other computer was showing.
   * Everything here is another computer's input and is checked before use.
   */
  adoptMachine(
    desc: BootDescriptor,
    checkpoint: MachineCheckpointLike,
    terminals?: readonly CapturedTerminal[],
  ): Promise<void>;
  /**
   * Load what booting `desc` would need, without booting it.
   *
   * Moving a machine is the cheap half of a handover. The expensive half is
   * that a viewer holds no image of its own, so the keeper's has to be fetched
   * and assembled before the checkpoint has anywhere to go — and the person
   * who gave the machine away watches a page with nothing on it for exactly
   * that long. A viewer told early which image its peer runs can have it ready
   * before anyone presses anything.
   *
   * Starts no machine and changes no status: a computer that prewarms an image
   * is still a computer holding no machine, and must not look like one that
   * does. Resolves when there is nothing more to prepare, and rejects if the
   * image cannot be loaded — a caller prewarming speculatively should ignore
   * that rather than report it, because nothing has been asked for yet.
   */
  prewarmBootDescriptor(desc: BootDescriptor): Promise<void>;

  // machine replication — one machine runs on two computers. Handover moves a
  // machine; these three copy one and keep the copy running the same way.
  /**
   * Read this machine for a viewer, and start publishing its decisions from
   * that state.
   *
   * The same value {@link captureMachine} produces, so the viewer restores it
   * exactly as a taker would. What differs is that this computer keeps the
   * machine and keeps deciding for it: the returned `stop` ends the recording.
   *
   * Null when there is no machine here, or when the wrapped kernel cannot
   * publish one. Rejects when a read was attempted and failed.
   */
  captureMachineForViewer(
    onEntries: (entries: readonly ReplicationLogEntryLike[]) => void,
  ): Promise<{
    machine: CapturedMachine;
    stop: () => Promise<void>;
  } | null>;
  /**
   * Boot `desc`, restore `checkpoint` into it, and run it on the user's
   * decisions rather than on this computer's.
   *
   * `replay` is installed before the restored processes resume, because they
   * resume during the boot and read the clock as they do. A replica whose
   * first reading came from its own host is a different machine from the one
   * it claims to be showing.
   *
   * Everything here is another computer's input and is checked exactly as
   * {@link adoptMachine} checks it.
   */
  replicateMachine(
    desc: BootDescriptor,
    checkpoint: MachineCheckpointLike,
    terminals: readonly CapturedTerminal[],
    replay: MachineReplayLike,
  ): Promise<void>;
  /**
   * Stop following the user's machine, and report how much of its log this
   * replica took.
   *
   * Null when this machine was not replaying. A replica left at a different
   * count from the machine it followed ran a different machine, so the count
   * is reported rather than dropped.
   */
  stopReplicatingMachine(): Promise<{ consumed: number; total: number } | null>;
  /**
   * Tell the replica this page runs that the user's log grew.
   *
   * Call it after pushing entries into the replay's queue. A keystroke or a
   * resize the user recorded has no guest request to answer, so a replica
   * whose guest sits at a prompt would never take it from the queue on its
   * own. A no-op on a page that holds no replica.
   */
  drainReplicationReplay(): void;

  // dmesg ring
  subscribeDmesg(cb: (line: DmesgLine) => void): () => void;
  dmesgHistory(): DmesgLine[];

  // Lazy VFS materialization progress
  subscribeLazyDownloads(cb: (event: LazyDownloadEvent) => void): () => void;
  /** Bounded chronological log for low-level diagnostics. */
  lazyDownloadHistory(): LazyDownloadEvent[];
  /** Subscribe to summary-ledger changes, including kernel-lifecycle resets. */
  subscribeLazyDownloadSummaries(cb: () => void): () => void;
  /** One authoritative latest record per asset for this kernel lifecycle. */
  lazyDownloadSummaries(): LazyDownloadSummary[];

  // Process lifecycle — fires on spawn/exec/exit. Inspector tabs use this
  // to refetch enumProcs / readMemMap instead of polling on a timer.
  subscribeProcessEvents(cb: (event: ProcessEvent) => void): () => void;

  // shell / pty
  attachPty(path?: string, opts?: { cols: number; rows: number }): Promise<PtyHandle>;
  /** Join an already-attached PTY to share it; null when there is none. */
  sharePty(path: string): SharedPtyHandle | null;
  /** Paths of the terminals that currently exist. */
  getTerminalSessions(): string[];
  subscribeTerminalSessions(cb: (paths: string[]) => void): () => void;
  /** Remove the logical PTY, including its process and pending restart. */
  removePty(path: string): void;
  /** Resolve after a command has been written, without waiting for a prompt. */
  dispatchShellCommand(command: string): Promise<void>;
  runShellCommand(command: string): Promise<void>;

  // VFS / procfs
  readFile(path: string): Promise<Uint8Array>;
  readFileText(path: string): Promise<string>;
  readDir(path: string): Promise<VfsDirent[]>;
  stat(path: string): Promise<VfsDirent | null>;
  /**
   * Write `bytes` to `path` in the live guest VFS. The parent directory must
   * already exist. Callers are responsible for validating both the path and
   * the payload — this is a raw capability, not a policy layer.
   */
  writeFile(path: string, bytes: Uint8Array, mode?: number): Promise<void>;

  // process control
  /**
   * Deliver a POSIX signal to `pid`. Resolves false when the process no longer
   * exists. Rejects when the attached kernel cannot signal.
   */
  signalProcess(pid: number, signum: number): Promise<boolean>;

  // inspector
  enumProcs(): Promise<ProcessInfo[]>;
  readMemMap(pid: number): Promise<MemMapEntry[]>;
  getMounts(): Promise<MountInfo[]>;
  getKernelState(): Promise<KernelStateKV[]>;
  subscribeSyscalls(cb: (e: SyscallEvent) => void, filter?: SyscallFilter): () => void;
  syscallHistory(filter?: SyscallFilter): SyscallEvent[];

  // Machine-level physical/default PCM sink. Browser callers should invoke
  // resumeAudio directly from a trusted user gesture.
  prepareAudio(): Promise<void>;
  resumeAudio(): Promise<void>;
  suspendAudio(): Promise<void>;
  getAudioState(): MachineAudioState;
  subscribeAudioState(cb: (state: MachineAudioState) => void): () => void;

  // framebuffer — mirrors /dev/fb0 into a 2D canvas and returns a handle
  // that the embedder uses to forward keyboard and mouse input for the bound
  // process. PCM output is machine-level; startAudio remains as a deprecated
  // compatibility adapter.
  attachFramebuffer(canvas: HTMLCanvasElement): FramebufferHandle;
  /**
   * Join the framebuffer a pane is already painting, to share it with a peer.
   * Null when the wrapped kernel exposes no binding registry.
   */
  shareFramebuffer(): SharedFramebufferHandle | null;

  // KMS display — registers a canvas as the scanout target for a
  // DRM CRTC. `opts.mode` (default "webgl2") selects how the canvas
  // is painted: "webgl2" hands ownership to the libdrm/libgbm/EGL
  // path (modeset.c etc.); "2d" keeps the legacy CPU-blit pump that
  // copies the kernel's scanout BO into the canvas at 60 Hz; "auto"
  // defers the choice to whichever path arrives first. Returns null
  // when the wrapped kernel does not yet expose `kmsAttachCanvas`
  // (older ABI, Node host without an OffscreenCanvas polyfill, etc.).
  attachKmsDisplay(
    canvas: HTMLCanvasElement,
    crtcId?: number,
    opts?: { mode?: "auto" | "2d" | "webgl2" },
  ): KmsDisplayHandle | null;

  // web preview — service demos can expose an HTTP bridge endpoint.
  getWebPreview(): WebPreviewState | null;
  subscribeWebPreview(cb: (state: WebPreviewState | null) => void): () => void;

  // presentation — declares what users should see by default for this demo.
  getPresentation(): DemoPresentation;
  subscribePresentation(cb: (state: DemoPresentation) => void): () => void;
  getSurfaceAvailability(): SurfaceAvailability;
  subscribeSurfaceAvailability(cb: (state: SurfaceAvailability) => void): () => void;
  getDemoGuide(): DemoGuideConfig | null;
  subscribeDemoGuide(cb: (state: DemoGuideConfig | null) => void): () => void;
  /** File-ingest capability declared by the current VFS image, if any. */
  getDemoIngest(): DemoIngestConfig | null;
  subscribeDemoIngest(cb: (state: DemoIngestConfig | null) => void): () => void;

  // sharing
  snapshot(opts?: SnapshotOptions): Promise<Snapshot>;

  // gallery / library
  subscribeGallery(cb: () => void): () => void;
  galleryQuery(q: GalleryQuery): Promise<GalleryItem[]>;
  saveCurrentToGallery(title: string): Promise<GalleryItem>;
}

// ── A tiny helper for typed subscribe-set bookkeeping ──────────────────────

class ListenerSet<T> {
  private listeners = new Set<(arg: T) => void>();
  add(cb: (arg: T) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
  emit(arg: T): void {
    for (const cb of this.listeners) cb(arg);
  }
  size(): number {
    return this.listeners.size;
  }
}

interface LivePtySession {
  path: string;
  pid: number;
  logicalGeneration: number;
  processGeneration: number;
  autologinConsumed: boolean;
  startedAt: number;
  restartDelayMs: number;
  restartTimer: ReturnType<typeof setTimeout> | null;
  removed: boolean;
  dataListeners: ListenerSet<Uint8Array>;
  history: Uint8Array[];
  closed: boolean;
  cols: number;
  rows: number;
  supervised: boolean;
}

function clampPendingRequestCount(count: number): number {
  return Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
}

function ptyBufferEndsWithPrompt(buffer: string, prompt: string | null = null): boolean {
  const plain = buffer
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\r/g, "\n");
  if (prompt) return plain.endsWith(prompt);
  // Do not treat the shell continuation prompt (`> `) as ready. The demo
  // guide sends heredocs through this path, and PS2 appears before the command
  // has finished.
  return /(?:^|\n)[^\n]*[$#] $/.test(plain);
}

function shellPrompt(shell: NonNullable<LiveKernelHostOptions["shell"]>): string | null {
  const ps1 = shell.env?.find((entry) => entry.startsWith("PS1="));
  return ps1 ? ps1.slice("PS1=".length) : null;
}

function waitForPtyReadiness(
  pty: PtyHandle,
  opts: { includeHistory?: boolean; timeoutMs?: number; prompt?: string | null } = {},
): Promise<void> {
  const includeHistory = opts.includeHistory ?? true;
  const timeoutMs = opts.timeoutMs ?? 1200;
  const prompt = opts.prompt ?? null;
  return new Promise((resolve, reject) => {
    let done = false;
    let buffer = "";
    let off = () => {};
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      off();
      resolve();
    };
    const fail = () => {
      if (done) return;
      done = true;
      off();
      reject(new Error("timed out waiting for PTY prompt"));
    };
    const decoder = new TextDecoder();
    let replayingHistory = true;
    const timer = setTimeout(fail, timeoutMs);
    off = pty.onData((bytes) => {
      if (!includeHistory && replayingHistory) return;
      buffer += decoder.decode(bytes, { stream: true });
      if (ptyBufferEndsWithPrompt(buffer, prompt)) finish();
    });
    replayingHistory = false;
    if (includeHistory && ptyBufferEndsWithPrompt(buffer, prompt)) finish();
  });
}

function nowMs(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

function cloneTerminalProgram(program: TerminalProgram): TerminalProgram {
  return {
    ...program,
    argv: program.argv.slice(),
    ...(program.env ? { env: program.env.slice() } : {}),
  };
}

function validateTerminalSessionPolicy(policy: TerminalSessionPolicy): void {
  const programs: Array<readonly [string, TerminalProgram]> = [
    ["initial", policy.initial],
    ...(policy.afterExit === undefined
      ? []
      : [["afterExit", policy.afterExit] as const]),
  ];
  for (const [label, program] of programs) {
    if (!program.programPath.startsWith("/")) {
      throw new Error(
        `LiveKernelHost.setTerminalSessionPolicy ${label}.programPath must be absolute`,
      );
    }
    if (program.argv.length === 0) {
      throw new Error(
        `LiveKernelHost.setTerminalSessionPolicy ${label}.argv must not be empty`,
      );
    }
  }
  if (
    !Number.isFinite(policy.shortRunThresholdMs) ||
    policy.shortRunThresholdMs < 0 ||
    !Number.isFinite(policy.initialRestartDelayMs) ||
    policy.initialRestartDelayMs < 0 ||
    !Number.isFinite(policy.maximumRestartDelayMs) ||
    policy.maximumRestartDelayMs < policy.initialRestartDelayMs
  ) {
    throw new Error(
      "LiveKernelHost.setTerminalSessionPolicy requires bounded non-negative restart timings",
    );
  }
}

// ── LiveKernelHost — wraps the real host runtime in host/src/ ──────────────
//
// LiveKernelHost owns the UI-facing session state: status, descriptor,
// presentation, dmesg, gallery data, web preview, and per-surface availability.
// When attached to a KernelLike it exposes PTY, VFS, process, syscall, and
// framebuffer surfaces through the KernelHost contract. Calls that depend on
// an unavailable kernel capability fail loudly so the UI can render a specific
// missing-endpoint state.

export interface LiveKernelHostOptions {
  /**
   * The browser-side kernel to wrap. Once provided, attachPty will spawn its
   * shell on this kernel. May be set/replaced later via attachKernel() — the
   * UI is expected to construct a LiveKernelHost early (so subscriptions can
   * attach) and hand the kernel over once it has booted.
   */
  kernel?: KernelLike;
  /**
   * What to spawn when attachPty is called with no explicit program. Defaults
   * to bash; pages that ship dash or another shell should override.
   */
  shell?: {
    programPath?: string;
    /**
     * Fallback bytes for kernels that cannot spawn programPath from their VFS.
     * VFS-backed shells do not need a redundant main-thread copy.
     */
    programBytes?: ArrayBuffer;
    argv: string[];
    env?: string[];
    cwd?: string;
    uid?: number;
    gid?: number;
  };
  /** Initial status. Defaults to "idle". */
  status?: MachineStatus;
  /** Initial boot descriptor surfaced to the UI. */
  descriptor?: BootDescriptor;
  /** Initial presentation intent surfaced to the UI. */
  presentation?: DemoPresentation;
  /**
   * Live-mode reboot hook supplied by the browser page.
   *
   * `restore` is present only when the descriptor is being booted to adopt a
   * machine another computer froze. A page that receives one must skip the
   * programs it would otherwise start: the checkpoint already carries them,
   * and a second copy would fight the restored one over the same devices.
   *
   * `replay` is present when that machine is being copied rather than moved,
   * and the copy is to run on the other computer's decisions. It must reach
   * the kernel as part of the boot rather than after it: the restored
   * processes resume inside the boot and read the clock as they do.
   */
  applyBootDescriptor?: (
    desc: BootDescriptor,
    host: LiveKernelHost,
    restore?: MachineCheckpointLike,
    replay?: MachineReplayLike,
  ) => Promise<void>;
  /**
   * Load what booting a descriptor would need, without booting it.
   *
   * Supplied by the browser page, because the page is the layer that knows how
   * a descriptor becomes an image. A host without one prewarms nothing, which
   * is slower but never wrong.
   */
  prewarmBootDescriptor?: (desc: BootDescriptor) => Promise<void>;
  /** Preset list for galleryQuery("presets"). */
  galleryItems?: GalleryItem[];
}

/**
 * How long a freeze waits for the machine to reach a readable state.
 *
 * `unwindTimeoutMs` bounds unwinding every process out of its syscall;
 * `vforkTimeoutMs` bounds waiting for a vfork child to exec or exit, because
 * a parent suspended inside vfork holds a stack no checkpoint can read.
 */
const HANDOVER_CAPTURE_TIMEOUTS = {
  unwindTimeoutMs: 10_000,
  vforkTimeoutMs: 5_000,
};

/**
 * How much of a terminal's output moves with the machine.
 *
 * A screen is a suffix of everything a terminal printed, so a bounded tail
 * always redraws what the person was looking at; what it drops is scrollback
 * older than that. The number matches the replay budget the terminal mirror
 * keeps in `host/src/migration/terminal-local.ts`, because both carry the same
 * thing for the same reason.
 */
const HANDOVER_TERMINAL_BYTES = 128 * 1024;

/** The last `limit` bytes of `chunks`, joined. */
function tailBytes(chunks: readonly Uint8Array[], limit: number): Uint8Array {
  let taken = 0;
  let first = chunks.length;
  while (first > 0 && taken < limit) {
    taken += chunks[first - 1]!.byteLength;
    first--;
  }
  const joined = new Uint8Array(Math.min(taken, limit));
  let offset = 0;
  for (let index = first; index < chunks.length; index++) {
    const chunk = chunks[index]!;
    // Only the first chunk can overhang the limit; the rest were counted whole.
    const usable = chunk.subarray(Math.max(0, chunk.byteLength - (joined.byteLength - offset)));
    joined.set(usable, offset);
    offset += usable.byteLength;
  }
  return joined;
}

/**
 * Read a peer's terminal set, or refuse it.
 *
 * These arrive over a link from another computer and are acted on directly:
 * the pid decides which process a keyboard reaches, and the screen is written
 * into an emulator unread. Anything malformed fails the take rather than
 * becoming a terminal that misbehaves later.
 */
function checkedTerminals(
  terminals: readonly CapturedTerminal[],
): readonly CapturedTerminal[] {
  if (!Array.isArray(terminals)) {
    throw new Error("the peer's terminal list is not a list");
  }
  return terminals.map((terminal, index) => {
    const where = `the peer's terminal ${index}`;
    if (typeof terminal?.path !== "string" || terminal.path.length === 0) {
      throw new Error(`${where} has no path`);
    }
    if (!isPositiveInteger(terminal.pid)) {
      throw new Error(`${where} names no process`);
    }
    if (!isPositiveInteger(terminal.cols) || !isPositiveInteger(terminal.rows)) {
      throw new Error(`${where} has no size`);
    }
    if (!(terminal.screen instanceof Uint8Array)) {
      throw new Error(`${where} carries no screen`);
    }
    if (terminal.screen.byteLength > HANDOVER_TERMINAL_BYTES) {
      throw new Error(
        `${where} carries ${terminal.screen.byteLength} bytes of screen, `
        + `over the ${HANDOVER_TERMINAL_BYTES} allowed`,
      );
    }
    return {
      path: terminal.path,
      pid: terminal.pid,
      cols: terminal.cols,
      rows: terminal.rows,
      screen: terminal.screen,
    };
  });
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

const DEFAULT_DESCRIPTOR: BootDescriptor = {
  version: 1,
  id: "untitled",
  title: "Untitled machine",
  base: "kandelo:shell@abi8",
  runtime: {
    arch: "wasm32",
    kernel: "kernel@sha256:unknown",
    memoryPages: 4096,
    features: ["shared-array-buffer", "pty"],
    time: "real",
  },
  packages: [],
  mounts: [],
  boot: {
    argv: ["/bin/sh"],
    cwd: "/root",
    env: { HOME: "/root", USER: "root", LOGNAME: "root" },
    uid: 0,
    gid: 0,
  },
  caps: {},
};

const DEFAULT_PRESENTATION: DemoPresentation = {
  bootPrimary: "syslog",
  runningPrimary: ["terminal"],
  terminalAccess: "primary",
  internalsAccess: "drawer",
};

const DEFAULT_SURFACE_AVAILABILITY: SurfaceAvailability = {
  syslog: true,
  terminal: false,
  framebuffer: false,
  web: false,
  kms: false,
};

const NOT_IMPLEMENTED = (m: string) =>
  new Error(
    `LiveKernelHost.${m} is not implemented yet. ` +
    `Wire it to host/src/ when the matching kernel endpoint lands ` +
    `(see docs/plans/2026-05-14-kandelo-ui-followups.md).`
  );

export class LiveKernelHost implements KernelHost {
  private _status: MachineStatus;
  private statusListeners = new ListenerSet<MachineStatus>();

  private dmesgRing: DmesgLine[] = [];
  private dmesgListeners = new ListenerSet<DmesgLine>();
  private dmesgCapacity = 4096;
  private lazyDownloadRing: LazyDownloadEvent[] = [];
  private lazyDownloadSummariesById = new Map<string, LazyDownloadSummary>();
  private lazyDownloadListeners = new ListenerSet<LazyDownloadEvent>();
  private lazyDownloadSummaryListeners = new ListenerSet<void>();
  private lazyDownloadCapacity = 512;
  private processListeners = new ListenerSet<ProcessEvent>();
  private webPreviewListeners = new ListenerSet<WebPreviewState | null>();
  private presentationListeners = new ListenerSet<DemoPresentation>();
  private surfaceListeners = new ListenerSet<SurfaceAvailability>();
  private terminalSessionListeners = new ListenerSet<string[]>();
  private ptyOwnerListeners = new ListenerSet<void>();
  private galleryListeners = new ListenerSet<void>();
  private demoGuideListeners = new ListenerSet<DemoGuideConfig | null>();
  private demoIngestListeners = new ListenerSet<DemoIngestConfig | null>();
  private audioStateListeners = new ListenerSet<MachineAudioState>();

  private _descriptor: BootDescriptor;
  private presentation: DemoPresentation;
  private applyBootDescriptorImpl?: NonNullable<LiveKernelHostOptions["applyBootDescriptor"]>;
  private prewarmBootDescriptorImpl?: NonNullable<LiveKernelHostOptions["prewarmBootDescriptor"]>;
  private galleryItems: GalleryItem[];
  private webPreview: WebPreviewState | null = null;
  private demoGuide: DemoGuideConfig | null = null;
  private demoIngest: DemoIngestConfig | null = null;
  private surfaceAvailability: SurfaceAvailability = { ...DEFAULT_SURFACE_AVAILABILITY };
  private offFramebufferAvailability: (() => void) | null = null;
  private offLazyDownloads: (() => void) | null = null;
  private offAudioState: (() => void) | null = null;

  private kernel?: KernelLike;
  private shell?: NonNullable<LiveKernelHostOptions["shell"]>;
  private terminalSessions?: TerminalSessionPolicy;
  private ptySessions = new Map<string, LivePtySession>();
  private ptyAttachPromises = new Map<string, Promise<LivePtySession>>();
  private ptyCommandQueues = new Map<string, Promise<void>>();
  /**
   * Active PTY shell pids keyed by pid. Used by attachFramebuffer to route
   * input through the PTY master so a framebuffer-bound process forked from
   * any terminal (e.g. `fbdoom` typed at bash) gets keystrokes — its fd 0 is
   * the PTY slave, not a host-side stdin buffer.
   */
  private shellPids = new Map<number, string>();
  /**
   * Terminals handed over with a machine that is arriving, before its kernel
   * is attached.
   *
   * Two slots rather than one, because `attachKernel` clears every session the
   * previous kernel owned and would clear these with them. A machine on its
   * way in parks here; `attachKernel` moves it to {@link restoredTerminals}
   * once that clearing is done.
   */
  private arrivingTerminals: readonly CapturedTerminal[] = [];
  /**
   * The gate a replica is waiting on, for the two moments around its boot.
   *
   * `arriving` is set while the replica is being booted and moves to `held` in
   * `attachKernel`, for the same reason the terminals do: the boot detaches
   * the previous kernel first, and a single slot would have that detach
   * release the gate of the replica that is arriving.
   *
   * `held` is what every path that lets go of a kernel calls before it does.
   * See {@link MachineReplayLike.release}.
   */
  private arrivingReplicaRelease: (() => void) | null = null;
  private heldReplicaRelease: (() => void) | null = null;
  /**
   * Terminals of the restored machine, keyed by path, each waiting for the
   * first emulator to attach to it. Consumed once, by `ensurePtySession`.
   */
  private restoredTerminals = new Map<string, CapturedTerminal>();
  /**
   * KMS display handles keyed by their canvas DOM node. React 18 StrictMode
   * double-invokes effects, and `transferControlToOffscreen()` may only run
   * once per canvas, so attachKmsDisplay memoizes the handle here. A WeakMap
   * lets the handle drop naturally when the canvas itself is GC'd.
   */
  private kmsHandles = new WeakMap<HTMLCanvasElement, KmsDisplayHandle>();

  constructor(opts: LiveKernelHostOptions = {}) {
    this._status = opts.status ?? "idle";
    this._descriptor = opts.descriptor ?? DEFAULT_DESCRIPTOR;
    this.presentation = opts.presentation ?? DEFAULT_PRESENTATION;
    this.kernel = undefined;
    this.shell = opts.shell;
    this.applyBootDescriptorImpl = opts.applyBootDescriptor;
    this.prewarmBootDescriptorImpl = opts.prewarmBootDescriptor;
    this.galleryItems = opts.galleryItems ?? [];
    if (opts.kernel) {
      this.attachKernel(opts.kernel);
    } else {
      this.refreshTerminalAvailability();
      this.refreshFramebufferAvailability();
    }
    this.refreshWebAvailability();
    this.refreshKmsAvailability();
  }

  // ── owner-facing wiring helpers ──────────────────────────────────────────

  /** Replace the wrapped KernelLike. Used after `boot` resolves. */
  attachKernel(kernel: KernelLike): void {
    const previousKernel = this.kernel;
    this.cancelLazyDownloads("kernel replaced");
    this.clearLazyDownloadState();
    this.offFramebufferAvailability?.();
    this.offFramebufferAvailability = null;
    this.offLazyDownloads?.();
    this.offLazyDownloads = null;
    this.offAudioState?.();
    this.offAudioState = null;
    this.invalidatePtySessions(previousKernel);
    // After the clearing, never before: a machine arriving with terminals is
    // replacing the kernel whose sessions were just discarded.
    this.restoredTerminals = new Map(
      this.arrivingTerminals.map((terminal) => [terminal.path, terminal]),
    );
    this.arrivingTerminals = [];
    this.releaseReplica();
    this.heldReplicaRelease = this.arrivingReplicaRelease;
    this.arrivingReplicaRelease = null;
    this.kernel = kernel;
    // Everything the user decided while this replica was booting is already
    // in the replay's queue, and the nudges that announced it found no
    // machine here to pass them on to. If the user then went quiet, no later
    // entry will nudge again — so a replica's first drain happens now.
    if (this.holdsReplica()) kernel.drainReplicationReplay?.();
    if (kernel.framebuffers) {
      this.offFramebufferAvailability = kernel.framebuffers.onChange(() => {
        this.refreshFramebufferAvailability();
      });
    }
    if (kernel.subscribeLazyDownloads) {
      this.offLazyDownloads = kernel.subscribeLazyDownloads((event) => {
        this.emitLazyDownloadEvent(event);
      });
    }
    if (kernel.onAudioStateChange) {
      this.offAudioState = kernel.onAudioStateChange((state) => {
        this.audioStateListeners.emit(state);
      });
    }
    this.audioStateListeners.emit(this.getAudioState());
    this.refreshTerminalAvailability();
    this.refreshFramebufferAvailability();
    this.refreshKmsAvailability();
  }

  /** Clear the wrapped kernel after a failed boot without changing status. */
  detachKernel(): void {
    // Before anything reaches the kernel worker. A replica waiting for the
    // user's next decision answers nothing until this runs.
    this.releaseReplica();
    const detachedKernel = this.kernel;
    this.cancelLazyDownloads("kernel detached");
    this.clearLazyDownloadState();
    this.offFramebufferAvailability?.();
    this.offFramebufferAvailability = null;
    this.offLazyDownloads?.();
    this.offLazyDownloads = null;
    this.offAudioState?.();
    this.offAudioState = null;
    this.invalidatePtySessions(detachedKernel);
    this.kernel = undefined;
    this.audioStateListeners.emit("unavailable");
    this.refreshTerminalAvailability();
    this.refreshFramebufferAvailability();
    this.setSurfaceAvailability({ web: false, kms: false });
    this.setDemoGuide(null);
    this.setDemoIngest(null);
  }

  /** Configure the program attachPty spawns by default. */
  setDefaultShell(shell: NonNullable<LiveKernelHostOptions["shell"]>): void {
    if (!shell.programPath && !shell.programBytes) {
      throw new Error("LiveKernelHost.setDefaultShell requires programPath or programBytes");
    }
    this.shell = shell;
    this.terminalSessions = undefined;
    this.refreshTerminalAvailability();
  }

  /** Configure initial and post-exit programs for every logical PTY. */
  setTerminalSessionPolicy(policy: TerminalSessionPolicy): void {
    validateTerminalSessionPolicy(policy);
    this.terminalSessions = {
      initial: cloneTerminalProgram(policy.initial),
      ...(policy.afterExit === undefined
        ? {}
        : { afterExit: cloneTerminalProgram(policy.afterExit) }),
      shortRunThresholdMs: policy.shortRunThresholdMs,
      initialRestartDelayMs: policy.initialRestartDelayMs,
      maximumRestartDelayMs: policy.maximumRestartDelayMs,
    };
    this.shell = undefined;
    this.refreshTerminalAvailability();
  }

  /** Update the presentation intent and fan out to subscribers. */
  setPresentation(presentation: DemoPresentation): void {
    this.presentation = { ...presentation, runningPrimary: presentation.runningPrimary.slice() };
    this.presentationListeners.emit(this.getPresentation());
  }

  /** Replace gallery presets and notify views that cache galleryQuery results. */
  setGalleryItems(items: GalleryItem[]): void {
    this.galleryItems = items.map((item) => ({ ...item, packages: item.packages.slice(), bootCommand: item.bootCommand.slice() }));
    this.galleryListeners.emit(undefined);
  }

  /** Update the optional guide metadata exposed by the current VFS image. */
  setDemoGuide(guide: DemoGuideConfig | null): void {
    this.demoGuide = guide ? structuredClone(guide) : null;
    this.demoGuideListeners.emit(this.getDemoGuide());
  }

  /** Update the optional file-ingest capability exposed by the current image. */
  setDemoIngest(ingest: DemoIngestConfig | null): void {
    this.demoIngest = ingest ? structuredClone(ingest) : null;
    this.demoIngestListeners.emit(this.getDemoIngest());
  }

  private async startShellCommand(
    command: string,
  ): Promise<{ completion: Promise<void> }> {
    const sessionKey = "/dev/pts/0";
    const previousCommandDone =
      this.ptyCommandQueues.get(sessionKey) ?? Promise.resolve();
    let resolveCommandDone!: () => void;
    let rejectCommandDone!: (err: unknown) => void;
    const commandDone = new Promise<void>((resolve, reject) => {
      resolveCommandDone = resolve;
      rejectCommandDone = reject;
    });
    this.ptyCommandQueues.set(sessionKey, commandDone);
    void commandDone.catch(() => {});
    void commandDone.finally(() => {
      if (this.ptyCommandQueues.get(sessionKey) === commandDone) {
        this.ptyCommandQueues.delete(sessionKey);
      }
    }).catch(() => {});

    try {
      await previousCommandDone.catch(() => {});
      const pty = await this.attachPty(sessionKey, { cols: 100, rows: 30 });
      const terminalProgram = this.shell ?? this.terminalSessions?.initial;
      const prompt = terminalProgram ? shellPrompt(terminalProgram) : null;
      await waitForPtyReadiness(pty, {
        includeHistory: true,
        timeoutMs: 1200,
        prompt,
      }).catch(() => {});
      const completion = waitForPtyReadiness(pty, {
        includeHistory: false,
        timeoutMs: 300_000,
        prompt,
      });
      void completion.then(resolveCommandDone, rejectCommandDone);
      pty.write(command.endsWith("\n") ? command : `${command}\n`);
      return { completion: commandDone };
    } catch (err) {
      rejectCommandDone(err);
      throw err;
    }
  }

  /**
   * Write a command into the persistent PTY-backed shell and resolve once the
   * write has succeeded. This is the truthful dispatch surface for long-lived
   * foreground programs that intentionally do not return to a shell prompt.
   */
  async dispatchShellCommand(command: string): Promise<void> {
    await this.startShellCommand(command);
  }

  /** Write a command and wait until the shell presents its next prompt. */
  async runShellCommand(command: string): Promise<void> {
    const { completion } = await this.startShellCommand(command);
    await completion;
  }

  /** Update the status and fan out to subscribers. */
  setStatus(s: MachineStatus): void {
    if (s === this._status) return;
    this._status = s;
    this.refreshTerminalAvailability();
    this.statusListeners.emit(s);
  }

  /**
   * Emit a process lifecycle event. The kernel host (BrowserKernel /
   * NodeKernelHost / future surfaces) calls this when the kernel-worker
   * reports a spawn, exec, or exit so subscribed UI panes can refresh
   * their view of the process table.
   */
  emitProcessEvent(event: ProcessEvent): void {
    this.processListeners.emit(event);
  }

  /** Emit lazy VFS materialization progress from the wrapped kernel. */
  emitLazyDownloadEvent(event: LazyDownloadEvent): void {
    const copy = { ...event };
    const summary = advanceLazyDownloadSummary(
      this.lazyDownloadSummariesById.get(copy.id),
      copy,
    );
    this.lazyDownloadSummariesById.set(copy.id, summary);
    this.lazyDownloadRing.push(copy);
    if (this.lazyDownloadRing.length > this.lazyDownloadCapacity) {
      this.lazyDownloadRing.splice(0, this.lazyDownloadRing.length - this.lazyDownloadCapacity);
    }
    this.lazyDownloadListeners.emit(copy);
    this.lazyDownloadSummaryListeners.emit(undefined);
  }

  private cancelLazyDownloads(reason: string): void {
    const active = Array.from(this.lazyDownloadSummariesById.values()).filter(
      ({ status }) => status !== "complete" && status !== "error",
    );
    for (const summary of active) {
      this.emitLazyDownloadEvent({
        id: summary.id,
        kind: summary.kind,
        status: "error",
        url: summary.url,
        path: summary.path,
        mountPrefix: summary.mountPrefix,
        loadedBytes: summary.loadedBytes,
        totalBytes: summary.totalBytes,
        error: reason,
        t: nowMs(),
      });
    }
  }

  private clearLazyDownloadState(): void {
    const hadSummaries = this.lazyDownloadSummariesById.size > 0;
    this.lazyDownloadRing = [];
    this.lazyDownloadSummariesById.clear();
    if (hadSummaries) {
      this.lazyDownloadSummaryListeners.emit(undefined);
    }
  }

  /** Push a dmesg line into the ring and fan out to subscribers. */
  pushDmesg(line: DmesgLine): void {
    this.dmesgRing.push(line);
    if (this.dmesgRing.length > this.dmesgCapacity) {
      this.dmesgRing.splice(0, this.dmesgRing.length - this.dmesgCapacity);
    }
    this.dmesgListeners.emit(line);
  }

  /** Replace the boot descriptor without performing an apply. */
  setDescriptor(desc: BootDescriptor): void {
    this._descriptor = desc;
  }

  clearDmesg(): void {
    this.dmesgRing = [];
  }

  setWebPreview(state: WebPreviewState | null): void {
    if (!state) {
      this.webPreview = null;
      this.webPreviewListeners.emit(this.getWebPreview());
      this.refreshWebAvailability();
      return;
    }
    this.webPreview = {
      ...state,
      pendingRequests: clampPendingRequestCount(
        state.pendingRequests ?? this.webPreview?.pendingRequests ?? 0,
      ),
    };
    this.webPreviewListeners.emit(this.getWebPreview());
    this.refreshWebAvailability();
  }

  setWebPreviewPendingRequests(count: number): void {
    if (!this.webPreview) return;
    const pendingRequests = clampPendingRequestCount(count);
    if ((this.webPreview.pendingRequests ?? 0) === pendingRequests) return;
    this.webPreview = { ...this.webPreview, pendingRequests };
    this.webPreviewListeners.emit(this.getWebPreview());
  }

  private setSurfaceAvailability(patch: Partial<SurfaceAvailability>): void {
    const next = { ...this.surfaceAvailability, ...patch };
    if (
      next.syslog === this.surfaceAvailability.syslog &&
      next.terminal === this.surfaceAvailability.terminal &&
      next.framebuffer === this.surfaceAvailability.framebuffer &&
      next.web === this.surfaceAvailability.web &&
      next.kms === this.surfaceAvailability.kms
    ) {
      return;
    }
    this.surfaceAvailability = next;
    this.surfaceListeners.emit(this.getSurfaceAvailability());
  }

  private refreshTerminalAvailability(): void {
    this.setSurfaceAvailability({
      terminal:
        this._status === "running" &&
        Boolean(this.kernel && (this.shell || this.terminalSessions)),
    });
  }

  private refreshFramebufferAvailability(): void {
    this.setSurfaceAvailability({
      framebuffer: Boolean(this.kernel?.framebuffers?.list().length),
    });
  }

  private refreshWebAvailability(): void {
    this.setSurfaceAvailability({ web: this.webPreview?.status === "running" });
  }

  /**
   * KMS surface is treated as "available" once the wrapped kernel exposes
   * `kmsAttachCanvas`. The kernel-side CRTC always advertises one CRTC, so
   * there is no separate per-CRTC availability event; the Modeset pane
   * surfaces "waiting for PAGE_FLIP" until a process binds DRM master.
   */
  private refreshKmsAvailability(): void {
    this.setSurfaceAvailability({
      kms: Boolean(this.kernel?.kmsAttachCanvas),
    });
  }

  // ── KernelHost: status ───────────────────────────────────────────────────

  getStatus(): MachineStatus {
    return this._status;
  }

  subscribeStatus(cb: (s: MachineStatus) => void): () => void {
    return this.statusListeners.add(cb);
  }

  // ── KernelHost: descriptor lifecycle ─────────────────────────────────────

  getBootDescriptor(): BootDescriptor {
    return structuredClone(this._descriptor);
  }

  async applyBootDescriptor(desc: BootDescriptor): Promise<void> {
    if (!this.applyBootDescriptorImpl) {
      this.setDescriptor(desc);
      return;
    }
    await this.applyBootDescriptorImpl(desc, this);
  }

  async halt(): Promise<void> {
    await this.dropMachine("halted", "kernel halted");
  }

  async reboot(): Promise<void> {
    this.invalidatePtySessions(this.kernel);
    await this.applyBootDescriptor(this.getBootDescriptor());
  }

  // ── KernelHost: machine handover ─────────────────────────────────────────

  async captureMachine(): Promise<CapturedMachine | null> {
    const kernel = this.kernel;
    if (!kernel?.captureCheckpointBytes) return null;
    const result = await kernel.captureCheckpointBytes(HANDOVER_CAPTURE_TIMEOUTS);
    if (result.status !== "captured") {
      throw new Error(`freezing this machine ${result.status}: ${result.reason}`);
    }
    return {
      checkpoint: result.checkpoint,
      boot: this.getBootDescriptor(),
      terminals: this.captureTerminals(),
    };
  }

  /**
   * Every terminal this machine is talking to, as the taker will need it.
   *
   * A session whose process has gone carries nothing: there is no pid on the
   * far end to adopt, and the taker starts one of its own exactly as this
   * computer would have.
   */
  private captureTerminals(): CapturedTerminal[] {
    const captured: CapturedTerminal[] = [];
    for (const [path, session] of this.ptySessions) {
      if (session.closed || session.pid <= 0) continue;
      captured.push({
        path,
        pid: session.pid,
        cols: session.cols,
        rows: session.rows,
        screen: tailBytes(session.history, HANDOVER_TERMINAL_BYTES),
      });
    }
    // A terminal that arrived with this machine and never had an emulator
    // attached is running exactly like the rest of it: `ptySessions` lists the
    // emulators, not the terminals. On a machine showing a screen nobody opens
    // a terminal pane, so leaving these out drops the shell that owns the PTY
    // on the next handover, and the computer after that has no keyboard.
    const attached = new Set(captured.map((terminal) => terminal.path));
    for (const [path, terminal] of this.restoredTerminals) {
      if (attached.has(path) || terminal.pid <= 0) continue;
      captured.push(terminal);
    }
    return captured;
  }

  /**
   * Give this machine up because it now runs on another computer.
   *
   * Unlike {@link halt} this ends at `idle`, not `halted`: no process was shut
   * down, they moved. A page holding no machine of its own is also the page
   * that can watch the peer which now holds this one.
   */
  async releaseMachine(): Promise<void> {
    await this.dropMachine("idle", "machine handed over");
  }

  /**
   * Load what booting `desc` would need, without booting it.
   *
   * A no-op on a host the page gave no way to do it: prewarming is an
   * optimisation, and a machine that has to load its image when it arrives is
   * slower to arrive, never wrong when it does.
   */
  async prewarmBootDescriptor(desc: BootDescriptor): Promise<void> {
    await this.prewarmBootDescriptorImpl?.(desc);
  }

  async adoptMachine(
    desc: BootDescriptor,
    checkpoint: MachineCheckpointLike,
    terminals: readonly CapturedTerminal[] = [],
  ): Promise<void> {
    await this.bootAdopted(desc, checkpoint, terminals);
  }

  // ── KernelHost: machine replication ──────────────────────────────────────

  async captureMachineForViewer(
    onEntries: (entries: readonly ReplicationLogEntryLike[]) => void,
  ): Promise<{ machine: CapturedMachine; stop: () => Promise<void> } | null> {
    const kernel = this.kernel;
    if (!kernel?.captureAndStreamReplicationLog) return null;
    const { capture, stop } = await kernel.captureAndStreamReplicationLog(
      HANDOVER_CAPTURE_TIMEOUTS,
      onEntries,
    );
    if (capture.status !== "captured") {
      throw new Error(`reading this machine ${capture.status}: ${capture.reason}`);
    }
    return {
      machine: {
        checkpoint: capture.checkpoint,
        boot: this.getBootDescriptor(),
        terminals: this.captureTerminals(),
      },
      stop,
    };
  }

  async replicateMachine(
    desc: BootDescriptor,
    checkpoint: MachineCheckpointLike,
    terminals: readonly CapturedTerminal[],
    replay: MachineReplayLike,
  ): Promise<void> {
    await this.bootAdopted(desc, checkpoint, terminals, replay);
  }

  /**
   * Stop following another computer's machine, and let go of the copy.
   *
   * The copy goes with the replay rather than outliving it. A replica taken off
   * its log is a machine no computer is deciding for: its guests read a clock
   * that answers `EIO`, they die, and `init` starts fresh ones — so what is left
   * on the screen is a second machine wearing the first one's name, and this
   * computer can type into it. Ending at `idle` says the true thing instead:
   * the machine this page was watching is gone, and this page holds none.
   *
   * Returns how far the replay got, or null on a page holding no replica.
   *
   * Holding one is the condition, not merely having a kernel. A take-over is
   * also a replica ending, and it ends by replacing the copy with the machine
   * itself: the boot has already let go of the replica's gate by the time
   * anything calls this, and dropping the machine arriving in its place would
   * take away what the person just took.
   */
  async stopReplicatingMachine(): Promise<
    { consumed: number; total: number } | null
  > {
    const kernel = this.kernel;
    if (!this.holdsReplica() || !kernel?.stopReplicationReplay) return null;
    const progress = await kernel.stopReplicationReplay();
    await this.dropMachine("idle", "replication ended");
    return progress;
  }

  drainReplicationReplay(): void {
    if (!this.holdsReplica()) return;
    this.kernel?.drainReplicationReplay?.();
  }

  /**
   * Boot a machine that arrived from another computer, moved or copied.
   *
   * The two differ in one value and in nothing else: a copy carries the log it
   * is to run on. Everything before that — checking the terminals, parking
   * them for the kernel that is about to attach, and clearing them if no
   * kernel ever does — is the same job and is done once here.
   */
  private async bootAdopted(
    desc: BootDescriptor,
    checkpoint: MachineCheckpointLike,
    terminals: readonly CapturedTerminal[],
    replay?: MachineReplayLike,
  ): Promise<void> {
    if (!this.applyBootDescriptorImpl) {
      throw new Error(
        "this host cannot boot a descriptor, so it cannot adopt a machine",
      );
    }
    // Checked before it is parked, not when it is read: these name processes
    // to route a keyboard to and carry bytes to write into an emulator, and
    // they came from another computer. A malformed set must fail the take,
    // where someone is waiting for an answer, rather than surface later as a
    // terminal that misbehaves.
    this.arrivingTerminals = checkedTerminals(terminals);
    this.arrivingReplicaRelease = replay?.release ?? null;
    try {
      await this.applyBootDescriptorImpl(desc, this, checkpoint, replay);
    } finally {
      // `attachKernel` takes them. Anything still parked belongs to a boot
      // that never reached one, and must not be adopted by a later machine.
      this.arrivingTerminals = [];
      this.arrivingReplicaRelease?.();
      this.arrivingReplicaRelease = null;
    }
  }

  /**
   * Whether the machine attached here is a copy of one another computer holds.
   *
   * A replica is kept the same as the machine it copies by that computer's
   * decision log, and nothing this computer does is in that log. So a keystroke
   * typed here, or a mouse moved here, is a decision the machine it copies
   * never made: the two stop being one machine, and only this screen shows it.
   * Input therefore follows the machine — take it over to type into it.
   *
   * Resizing a terminal is such a decision too. A window change delivers
   * `SIGWINCH` and a new `TIOCGWINSZ`, so a program that redraws on it takes a
   * turn the primary's program never took, and the copy is a different machine
   * from the next reading onwards. The emulator keeps its own size; the
   * machine's terminal keeps the primary's.
   *
   * The gate is the replay's own release hook, because that is what a replica
   * has and a machine this computer holds does not: `attachKernel` sets it from
   * the arriving replay, and every path that lets go of a kernel clears it.
   */
  private holdsReplica(): boolean {
    return this.heldReplicaRelease !== null;
  }

  /** Let a replica waiting on this machine's gate run on, once. */
  private releaseReplica(): void {
    const release = this.heldReplicaRelease;
    this.heldReplicaRelease = null;
    release?.();
  }

  private async dropMachine(
    status: "halted" | "idle",
    reason: string,
  ): Promise<void> {
    this.releaseReplica();
    this.setStatus(status);
    this.cancelLazyDownloads(reason);
    this.offFramebufferAvailability?.();
    this.offFramebufferAvailability = null;
    this.offLazyDownloads?.();
    this.offLazyDownloads = null;
    this.offAudioState?.();
    this.offAudioState = null;
    this.setSurfaceAvailability({ terminal: false, framebuffer: false, web: false, kms: false });
    this.setDemoGuide(null);
    this.setDemoIngest(null);
    const kernel = this.kernel;
    this.invalidatePtySessions(kernel);
    this.kernel = undefined;
    await kernel?.destroy?.();
  }

  // ── KernelHost: dmesg ────────────────────────────────────────────────────

  subscribeDmesg(cb: (line: DmesgLine) => void): () => void {
    return this.dmesgListeners.add(cb);
  }

  dmesgHistory(): DmesgLine[] {
    return this.dmesgRing.slice();
  }

  subscribeLazyDownloads(cb: (event: LazyDownloadEvent) => void): () => void {
    return this.lazyDownloadListeners.add(cb);
  }

  lazyDownloadHistory(): LazyDownloadEvent[] {
    return this.lazyDownloadRing.map((event) => ({ ...event }));
  }

  subscribeLazyDownloadSummaries(cb: () => void): () => void {
    return this.lazyDownloadSummaryListeners.add(cb);
  }

  lazyDownloadSummaries(): LazyDownloadSummary[] {
    return Array.from(
      this.lazyDownloadSummariesById.values(),
      (summary) => ({ ...summary }),
    );
  }

  subscribeProcessEvents(cb: (event: ProcessEvent) => void): () => void {
    return this.processListeners.add(cb);
  }

  // ── KernelHost: PTY ──────────────────────────────────────────────────────

  async attachPty(
    path: string = "/dev/pts/0",
    opts: { cols: number; rows: number } = { cols: 80, rows: 24 },
  ): Promise<PtyHandle> {
    if (!this.kernel) {
      throw new Error(
        "LiveKernelHost.attachPty: no kernel attached. " +
        "Call attachKernel(browserKernel) once the kernel has booted, " +
        "or pass { kernel } to the constructor."
      );
    }
    if (!this.shell && !this.terminalSessions) {
      throw new Error(
        "LiveKernelHost.attachPty: no terminal program configured. " +
        "Call setDefaultShell(...) or setTerminalSessionPolicy(...) before attachPty()."
      );
    }
    const kernel = this.kernel;
    const sessionKey = path || "/dev/pts/0";
    const session = await this.withPtyAttachLock(sessionKey, () =>
      this.ensurePtySession(
        sessionKey,
        kernel,
        this.shell,
        this.terminalSessions,
        opts,
      ),
    );

    // The emulator's own size, unless it is looking at a machine it only
    // copies. A window here is not the machine's window: the primary's log
    // carries no resize this one made, so the geometry belongs to the machine
    // and the emulator renders what the machine's terminal holds.
    if (!this.holdsReplica()) {
      session.cols = opts.cols;
      session.rows = opts.rows;
      if (session.pid > 0 && !session.closed) {
        kernel.ptyResize(session.pid, opts.rows, opts.cols);
      }
    }

    const encoder = new TextEncoder();
    let closed = false;
    const dataSubscriptions = new Set<() => void>();

    return {
      write: (bytes) => {
        if (closed || this.holdsReplica()) return;
        const buf = typeof bytes === "string" ? encoder.encode(bytes) : bytes;
        if (!this.isCurrentPtySession(sessionKey, session) || session.closed) return;
        kernel.ptyWrite(session.pid, buf);
      },
      onData: (cb) => {
        if (closed) return () => {};
        const off = session.dataListeners.add(cb);
        const detach = () => {
          dataSubscriptions.delete(detach);
          off();
        };
        dataSubscriptions.add(detach);
        for (const chunk of session.history.slice()) cb(chunk);
        return detach;
      },
      resize: (cols, rows) => {
        if (closed || this.holdsReplica()) return;
        session.cols = cols;
        session.rows = rows;
        if (!this.isCurrentPtySession(sessionKey, session) || session.closed) return;
        kernel.ptyResize(session.pid, rows, cols);
      },
      size: () => ({ cols: session.cols, rows: session.rows }),
      close: () => {
        if (closed) return;
        closed = true;
        for (const detach of Array.from(dataSubscriptions)) detach();
        // Detach this UI handle only. The PTY-backed shell intentionally
        // persists across drawer open/close so users keep command history.
      },
    };
  }

  getTerminalSessions(): string[] {
    return [...this.ptySessions.keys()];
  }

  subscribeTerminalSessions(cb: (paths: string[]) => void): () => void {
    return this.terminalSessionListeners.add(cb);
  }

  /**
   * Every pid that owns a terminal's PTY.
   *
   * The shells this host started or adopted, and the terminals a machine
   * arrived with that no emulator has attached to yet. Both are running: a
   * restored terminal's shell is alive from the moment the checkpoint is
   * restored, and only its emulator is missing.
   *
   * Counting the second kind is what gives a taken-over machine a keyboard. A
   * framebuffer program launched from a shell reads its keystrokes from that
   * shell's PTY, and on a machine showing a screen nobody opens a terminal
   * pane: left out, the shell that owns the PTY would stay unknown for as long
   * as the person stayed on the screen, and every key they pressed would go to
   * a stdin buffer the program never reads.
   */
  private ptyOwnerPids(): Set<number> {
    const pids = new Set(this.shellPids.keys());
    for (const terminal of this.restoredTerminals.values()) pids.add(terminal.pid);
    return pids;
  }

  /**
   * Record a shell as the owner of its terminal's PTY, and say so.
   *
   * Anything that routes input by PTY answers from {@link ptyOwnerPids}, and a
   * shell does not always exist by the time that question is first asked: a
   * program can bind `/dev/fb0` before the shell that will launch the next one
   * has started. Announcing lets those answers be taken again.
   *
   * Only growth is announced. A pid that leaves takes a route away rather than
   * creating one, and the binding it belonged to is torn down by its own
   * unbind and exit paths.
   */
  private registerShellPid(pid: number, sessionKey: string): void {
    this.shellPids.set(pid, sessionKey);
    this.ptyOwnerListeners.emit(undefined);
  }

  private emitTerminalSessions(): void {
    this.terminalSessionListeners.emit(this.getTerminalSessions());
  }

  /**
   * Join a terminal that is already attached, to share it with a peer.
   *
   * Unlike {@link attachPty} it starts nothing, resizes nothing and writes
   * nothing: the emulator that attached the session keeps geometry authority
   * and the keyboard, and a sharer adopts what is already there. Returns null
   * when no session holds that path, because a terminal nobody opened is not
   * one to share.
   */
  sharePty(path: string): SharedPtyHandle | null {
    const sessionKey = path || "/dev/pts/0";
    const session = this.ptySessions.get(sessionKey);
    const kernel = this.kernel;
    if (!session || !kernel) return null;

    let closed = false;
    const dataSubscriptions = new Set<() => void>();

    return {
      onData: (cb) => {
        if (closed) return () => {};
        const off = session.dataListeners.add(cb);
        const detach = () => {
          dataSubscriptions.delete(detach);
          off();
        };
        dataSubscriptions.add(detach);
        for (const chunk of session.history.slice()) cb(chunk);
        return detach;
      },
      size: () => ({ cols: session.cols, rows: session.rows }),
      close: () => {
        if (closed) return;
        closed = true;
        for (const detach of Array.from(dataSubscriptions)) detach();
      },
    };
  }

  removePty(path: string): void {
    const sessionKey = path || "/dev/pts/0";
    const session = this.ptySessions.get(sessionKey);
    if (!session) return;
    this.invalidatePtySession(session, this.kernel);
    this.ptySessions.delete(sessionKey);
    this.ptyAttachPromises.delete(sessionKey);
    this.ptyCommandQueues.delete(sessionKey);
    this.emitTerminalSessions();
  }

  private async withPtyAttachLock(
    sessionKey: string,
    ensureSession: () => Promise<LivePtySession>,
  ): Promise<LivePtySession> {
    const previous = this.ptyAttachPromises.get(sessionKey);
    const current = (previous ?? Promise.resolve())
      .catch(() => undefined)
      .then(ensureSession);
    this.ptyAttachPromises.set(sessionKey, current);
    try {
      return await current;
    } finally {
      if (this.ptyAttachPromises.get(sessionKey) === current) {
        this.ptyAttachPromises.delete(sessionKey);
      }
    }
  }

  private async ensurePtySession(
    sessionKey: string,
    kernel: KernelLike,
    shell: LiveKernelHostOptions["shell"],
    policy: TerminalSessionPolicy | undefined,
    opts: { cols: number; rows: number },
  ): Promise<LivePtySession> {
    // A machine that arrived from another computer brought this terminal with
    // it. Adopting the process it named is what keeps a second one from being
    // started on the same PTY below.
    const arrived = this.restoredTerminals.get(sessionKey);
    if (arrived !== undefined && !this.ptySessions.has(sessionKey)) {
      this.restoredTerminals.delete(sessionKey);
      const adopted = await this.adoptRestoredTerminal(sessionKey, arrived, kernel, policy);
      if (adopted) return adopted;
    }

    let session = this.ptySessions.get(sessionKey);
    if (session && !session.closed && !(await this.isPtySessionAlive(session.pid))) {
      if (session.supervised) {
        this.handlePtyProcessExit(
          sessionKey,
          session,
          kernel,
          session.logicalGeneration,
          session.processGeneration,
          session.pid,
        );
      } else {
        this.shellPids.delete(session.pid);
        session.pid = 0;
        session.closed = true;
        session.processGeneration++;
      }
    }

    if (!session) {
      session = {
        path: sessionKey,
        pid: 0,
        logicalGeneration: 1,
        processGeneration: 0,
        autologinConsumed: false,
        startedAt: 0,
        restartDelayMs: policy?.initialRestartDelayMs ?? 0,
        restartTimer: null,
        removed: false,
        dataListeners: new ListenerSet<Uint8Array>(),
        history: [],
        closed: true,
        cols: opts.cols,
        rows: opts.rows,
        supervised: policy !== undefined,
      };
      this.ptySessions.set(sessionKey, session);
      this.emitTerminalSessions();
    } else {
      session.cols = opts.cols;
      session.rows = opts.rows;
    }

    if (!session.closed) return session;
    if (session.restartTimer !== null) return session;

    if (session.supervised) {
      if (session.autologinConsumed || !policy) return session;
      session.autologinConsumed = true;
      try {
        await this.startPtyProgram(sessionKey, session, kernel, policy.initial);
      } catch (error) {
        this.reportPtyStartFailure(sessionKey, session, error);
        throw error;
      }
    } else if (shell) {
      await this.startPtyProgram(sessionKey, session, kernel, shell);
    }
    return session;
  }

  /**
   * Take over a terminal that arrived with a restored machine.
   *
   * Starts nothing: the process is already running, because the checkpoint
   * restored it. This records where it is, how large its window was and what
   * it had printed, so the emulator attaching now continues that session
   * rather than opening a new one beside it. Returns null when the pid is not
   * there after all, which leaves the ordinary path to start a program — a
   * restore that lost the process should give the person a working terminal,
   * not an empty one wired to nothing.
   *
   * One thing does not survive the move. `startPtyProgram` follows a process
   * through the exit promise it got back when it spawned it, and a restored
   * process hands out no such promise, so a terminal adopted here is not
   * relaunched by the policy's `afterExit` when its program ends.
   */
  private async adoptRestoredTerminal(
    sessionKey: string,
    arrived: CapturedTerminal,
    kernel: KernelLike,
    policy: TerminalSessionPolicy | undefined,
  ): Promise<LivePtySession | null> {
    if (!(await this.isPtySessionAlive(arrived.pid))) return null;

    const session: LivePtySession = {
      path: sessionKey,
      pid: arrived.pid,
      logicalGeneration: 1,
      processGeneration: 1,
      // The arriving process is this session's login. Saying so is what stops
      // `ensurePtySession` starting the policy's initial program beside it.
      autologinConsumed: true,
      startedAt: nowMs(),
      restartDelayMs: policy?.initialRestartDelayMs ?? 0,
      restartTimer: null,
      removed: false,
      dataListeners: new ListenerSet<Uint8Array>(),
      history: arrived.screen.byteLength > 0 ? [arrived.screen] : [],
      closed: false,
      cols: arrived.cols,
      rows: arrived.rows,
      supervised: policy !== undefined,
    };
    this.ptySessions.set(sessionKey, session);
    this.registerShellPid(arrived.pid, sessionKey);
    kernel.onPtyOutput(arrived.pid, (data) => {
      if (this.ptySessions.get(sessionKey) !== session) return;
      this.emitPtyData(session, data);
    });
    this.emitTerminalSessions();
    return session;
  }

  private async startPtyProgram(
    sessionKey: string,
    session: LivePtySession,
    kernel: KernelLike,
    program: NonNullable<LiveKernelHostOptions["shell"]>,
  ): Promise<void> {
    const logicalGeneration = session.logicalGeneration;
    const processGeneration = ++session.processGeneration;
    let pid: number;
    let exitPromise: Promise<number>;
    if (program.programPath && kernel.spawnFromVfs) {
      const spawned = await kernel.spawnFromVfs(program.programPath, program.argv, {
        pty: true,
        env: program.env,
        cwd: program.cwd,
        uid: program.uid,
        gid: program.gid,
        ptyCols: session.cols,
        ptyRows: session.rows,
      });
      pid = spawned.pid;
      exitPromise = spawned.exit;
    } else {
      if (!program.programBytes) {
        throw new Error(
          "LiveKernelHost.attachPty: the configured terminal program is VFS-only, " +
          "but this kernel does not support spawnFromVfs().",
        );
      }
      let resolveStarted!: (pid: number) => void;
      let rejectStarted!: (reason?: unknown) => void;
      const started = new Promise<number>((resolve, reject) => {
        resolveStarted = resolve;
        rejectStarted = reject;
      });
      exitPromise = kernel.spawn(program.programBytes, program.argv, {
        pty: true,
        env: program.env,
        cwd: program.cwd,
        uid: program.uid,
        gid: program.gid,
        ptyCols: session.cols,
        ptyRows: session.rows,
        onStarted: resolveStarted,
      });
      void exitPromise.catch(rejectStarted);
      pid = await started;
    }

    if (
      !this.isCurrentPtySession(sessionKey, session) ||
      session.logicalGeneration !== logicalGeneration ||
      session.processGeneration !== processGeneration ||
      this.kernel !== kernel
    ) {
      void kernel.terminateProcess(pid).catch(() => {});
      throw new Error(`LiveKernelHost.attachPty: ${sessionKey} was removed during launch`);
    }

    session.pid = pid;
    session.closed = false;
    session.startedAt = nowMs();
    this.registerShellPid(pid, sessionKey);
    kernel.onPtyOutput(pid, (data) => {
      if (!this.isCurrentPtyProcess(
        sessionKey,
        session,
        logicalGeneration,
        processGeneration,
        pid,
      )) return;
      this.emitPtyData(session, data);
    });
    void exitPromise.then(
      () => this.handlePtyProcessExit(
        sessionKey,
        session,
        kernel,
        logicalGeneration,
        processGeneration,
        pid,
      ),
      (error) => this.handlePtyProcessExit(
        sessionKey,
        session,
        kernel,
        logicalGeneration,
        processGeneration,
        pid,
        error,
      ),
    );
  }

  private handlePtyProcessExit(
    sessionKey: string,
    session: LivePtySession,
    kernel: KernelLike,
    logicalGeneration: number,
    processGeneration: number,
    pid: number,
    exitError?: unknown,
  ): void {
    if (!this.isCurrentPtyProcess(
      sessionKey,
      session,
      logicalGeneration,
      processGeneration,
      pid,
    )) return;

    session.pid = 0;
    session.closed = true;
    this.shellPids.delete(pid);
    if (exitError !== undefined) {
      this.emitPtyDiagnostic(
        session,
        `kandelo: terminal process failed: ${String(exitError)}`,
      );
    }
    if (!session.supervised || !this.terminalSessions || this.kernel !== kernel) {
      return;
    }

    const policy = this.terminalSessions;
    if (policy.afterExit === undefined) return;
    const runtimeMs = Math.max(0, nowMs() - session.startedAt);
    const delayMs = runtimeMs >= policy.shortRunThresholdMs
      ? policy.initialRestartDelayMs
      : session.restartDelayMs;
    session.restartDelayMs = runtimeMs >= policy.shortRunThresholdMs
      ? policy.initialRestartDelayMs
      : Math.min(
          policy.maximumRestartDelayMs,
          Math.max(policy.initialRestartDelayMs, session.restartDelayMs * 2),
        );
    if (session.restartTimer !== null) return;

    session.restartTimer = setTimeout(() => {
      session.restartTimer = null;
      if (
        !this.isCurrentPtySession(sessionKey, session) ||
        session.logicalGeneration !== logicalGeneration ||
        session.processGeneration !== processGeneration ||
        !session.closed ||
        this.kernel !== kernel
      ) return;
      void this.withPtyAttachLock(sessionKey, async () => {
        if (
          !this.isCurrentPtySession(sessionKey, session) ||
          session.logicalGeneration !== logicalGeneration ||
          session.processGeneration !== processGeneration ||
          !session.closed ||
          this.kernel !== kernel
        ) return session;
        try {
          await this.startPtyProgram(
            sessionKey,
            session,
            kernel,
            policy.afterExit,
          );
        } catch (error) {
          this.reportPtyStartFailure(sessionKey, session, error);
        }
        return session;
      });
    }, delayMs);
  }

  private reportPtyStartFailure(
    sessionKey: string,
    session: LivePtySession,
    error: unknown,
  ): void {
    if (!this.isCurrentPtySession(sessionKey, session)) return;
    session.pid = 0;
    session.closed = true;
    session.restartTimer = null;
    this.emitPtyDiagnostic(
      session,
      `kandelo: unable to start terminal process: ${String(error)}`,
    );
  }

  private emitPtyDiagnostic(session: LivePtySession, message: string): void {
    this.emitPtyData(session, new TextEncoder().encode(`\r\n${message}\r\n`));
  }

  private emitPtyData(session: LivePtySession, data: Uint8Array): void {
    const copy = data.slice();
    session.history.push(copy);
    if (session.history.length > 2048) session.history.shift();
    session.dataListeners.emit(copy);
  }

  private isCurrentPtySession(
    sessionKey: string,
    session: LivePtySession,
  ): boolean {
    return !session.removed && this.ptySessions.get(sessionKey) === session;
  }

  private isCurrentPtyProcess(
    sessionKey: string,
    session: LivePtySession,
    logicalGeneration: number,
    processGeneration: number,
    pid: number,
  ): boolean {
    return (
      this.isCurrentPtySession(sessionKey, session) &&
      session.logicalGeneration === logicalGeneration &&
      session.processGeneration === processGeneration &&
      !session.closed &&
      session.pid === pid
    );
  }

  private invalidatePtySession(
    session: LivePtySession,
    kernel: KernelLike | undefined,
  ): void {
    session.removed = true;
    session.logicalGeneration++;
    session.processGeneration++;
    if (session.restartTimer !== null) {
      clearTimeout(session.restartTimer);
      session.restartTimer = null;
    }
    const pid = session.pid;
    session.pid = 0;
    session.closed = true;
    if (pid > 0) {
      this.shellPids.delete(pid);
      void kernel?.terminateProcess(pid).catch(() => {});
    }
  }

  private invalidatePtySessions(kernel: KernelLike | undefined): void {
    for (const session of this.ptySessions.values()) {
      this.invalidatePtySession(session, kernel);
    }
    this.ptySessions.clear();
    this.ptyAttachPromises.clear();
    this.ptyCommandQueues.clear();
    this.shellPids.clear();
    // A terminal nobody attached to belongs to the machine being discarded. It
    // must not be adopted by whatever runs here next.
    this.restoredTerminals.clear();
    this.emitTerminalSessions();
  }

  private async isPtySessionAlive(pid: number): Promise<boolean> {
    if (pid <= 0 || this.kernel?.enumProcs === undefined) return true;
    try {
      const procs = await this.kernel.enumProcs();
      if (procs.length === 0) return true;
      return procs.some((proc) => proc.pid === pid);
    } catch {
      return true;
    }
  }

  // ── KernelHost: VFS ──────────────────────────────────────────────────────

  async readFile(path: string): Promise<Uint8Array> {
    return readFileSync(this.requireFs(), path);
  }

  async readFileText(path: string): Promise<string> {
    return new TextDecoder().decode(await this.readFile(path));
  }

  /**
   * Create or replace one live guest file through the VFS-owning worker. The
   * parent must already exist. Completion proves that the worker closed the
   * file and applied its requested mode; no reboot or image rebuild is needed.
   */
  async writeFile(path: string, bytes: Uint8Array, mode = 0o644): Promise<void> {
    if (!this.kernel?.writeFileToVfs) {
      throw new Error(
        `LiveKernelHost.writeFile(${path}): the attached kernel cannot write ` +
        `to the VFS (no writeFileToVfs).`,
      );
    }
    await this.kernel.writeFileToVfs(path, bytes, mode);
  }

  // ── KernelHost: process control ─────────────────────────────────────────

  async signalProcess(pid: number, signum: number): Promise<boolean> {
    if (!this.kernel?.signalProcess) {
      throw new Error(
        "LiveKernelHost.signalProcess: the attached kernel cannot deliver signals.",
      );
    }
    return this.kernel.signalProcess(pid, signum);
  }

  async readDir(path: string): Promise<VfsDirent[]> {
    const fs = this.requireFs();
    const names = loadIdNameMaps(fs);
    const handle = fs.opendir(path);
    try {
      const out: VfsDirent[] = [];
      while (true) {
        const entry = fs.readdir(handle);
        if (!entry) break;
        if (entry.name === "." || entry.name === "..") continue;
        const childPath = path.endsWith("/")
          ? path + entry.name
          : path + "/" + entry.name;
        let mode: number;
        let size: number;
        let uid: number;
        let gid: number;
        let target: string | undefined;
        try {
          const st = fs.stat(childPath);
          mode = st.mode;
          size = st.size;
          uid = st.uid;
          gid = st.gid;
        } catch {
          // Disappearing entries (race with another process) shouldn't blow
          // up the whole listing.
          continue;
        }
        const kind = direntKind(entry.type, mode);
        if (kind === "l") {
          try { target = fs.readlink(childPath); } catch { /* ignore */ }
        }
        out.push({
          name: entry.name,
          kind,
          mode: formatMode(mode, kind),
          owner: idToLabel(uid, names.users),
          group: idToLabel(gid, names.groups),
          size: kind === "d" ? "—" : humanSize(size),
          target,
        });
      }
      return out;
    } finally {
      fs.closedir(handle);
    }
  }

  async stat(path: string): Promise<VfsDirent | null> {
    const fs = this.requireFs();
    const names = loadIdNameMaps(fs);
    try {
      const st = fs.stat(path);
      const kind = direntKind(0, st.mode);
      return {
        name: path.split("/").pop() || "/",
        kind,
        mode: formatMode(st.mode, kind),
        owner: idToLabel(st.uid, names.users),
        group: idToLabel(st.gid, names.groups),
        size: kind === "d" ? "—" : humanSize(st.size),
      };
    } catch {
      return null;
    }
  }

  private requireFs(): FileSystemLike {
    if (!this.kernel?.fs) {
      throw new Error(
        "LiveKernelHost: the attached kernel has no synchronous VFS surface.",
      );
    }
    return this.kernel.fs;
  }

  // ── KernelHost: inspector ────────────────────────────────────────────────

  async enumProcs(): Promise<ProcessInfo[]> {
    // Prefer the direct kernel snapshot (kernel_enum_procs). Falls back to
    // walking /proc only when an older kernel is wrapped — the fallback
    // sees no procfs entries unless the static rootfs has them, so it's
    // mostly a no-op. The fast path lands when both this kandelo-session
    // version and the kernel ship together (ABI ≥ 9).
    if (this.kernel?.enumProcs) {
      const snaps = await this.kernel.enumProcs();
      const users = this.kernel.fs
        ? loadIdNameMaps(this.kernel.fs).users
        : new Map<number, string>([[0, "root"]]);
      return snaps.map((s) => toProcessInfo(s, users));
    }
    const fs = this.requireFs();
    const names = loadIdNameMaps(fs);
    const entries = await this.readDir("/proc").catch(() => [] as VfsDirent[]);
    const out: ProcessInfo[] = [];
    for (const e of entries) {
      const pid = Number(e.name);
      if (!Number.isInteger(pid) || pid <= 0) continue;
      try {
        out.push(parseProcEntry(fs, pid, names.users));
      } catch {
        // Process may have exited between readdir and read.
      }
    }
    out.sort((a, b) => a.pid - b.pid);
    return out;
  }

  async readMemMap(pid: number): Promise<MemMapEntry[]> {
    // Direct kernel call when available; falls back to /proc/[pid]/maps
    // read on older kernels.
    if (this.kernel?.readProcMaps) {
      const text = await this.kernel.readProcMaps(pid);
      if (text === null) return [];
      return parseMaps(text);
    }
    const text = await this.readFileText(`/proc/${pid}/maps`).catch(() => "");
    return parseMaps(text);
  }

  async getMounts(): Promise<MountInfo[]> {
    // Mounts are configured at boot time from the BootDescriptor; the
    // kernel doesn't grow new mounts dynamically. Source-of-truth is
    // descriptor.mounts. If a future kernel adds runtime mount/umount
    // syscalls and exposes /proc/mounts, the catch falls through to
    // the kernel view.
    const fromDesc = descriptorMountsToInfo(this._descriptor.mounts);
    if (fromDesc.length > 0) return fromDesc;
    const text = await this.readFileText("/proc/mounts").catch(() => "");
    return parseMounts(text);
  }

  async getKernelState(): Promise<KernelStateKV[]> {
    // sysctl-style flat view, filled out as procfs paths become available.
    const probes: Array<[key: string, path: string]> = [
      ["kernel.hostname", "/proc/sys/kernel/hostname"],
      ["kernel.version", "/proc/version"],
      ["kernel.osrelease", "/proc/sys/kernel/osrelease"],
      ["kernel.pid_max", "/proc/sys/kernel/pid_max"],
      ["kernel.threads_max", "/proc/sys/kernel/threads-max"],
      ["fs.file-max", "/proc/sys/fs/file-max"],
    ];
    const out: KernelStateKV[] = [];
    for (const [k, p] of probes) {
      try {
        const v = (await this.readFileText(p)).trim();
        if (v) out.push({ k, v });
      } catch {
        // Path doesn't exist yet — skip silently. Once the kernel grows the
        // /proc/sys tree, more rows show up automatically.
      }
    }
    // Synthetic kandelo.* keys for image/url metadata. The image hash and
    // url size are computed from the current descriptor; they're not
    // sysctls so we synthesize them on every call.
    out.push({ k: "kandelo.image_hash", v: this._descriptor.runtime.kernel });
    return out;
  }

  subscribeSyscalls(cb: (e: SyscallEvent) => void, filter?: SyscallFilter): () => void {
    if (!this.kernel?.subscribeSyscalls) {
      throw new Error(
        "LiveKernelHost.subscribeSyscalls: kernel exposes no syscall trace. " +
        "Wrap a BrowserKernel/NodeKernelHost ≥ ABI 9 to enable.",
      );
    }
    const t0 = performance.now();
    const traceOff = this.kernel.subscribeSyscalls((raw) => {
      // Filter on the raw event before formatting — most of the cost is
      // in syscallNumberName() and arg formatting, which we want to skip
      // when the subscriber's filter rejects the event.
      if (filter?.pid !== undefined && raw.pid !== filter.pid) return;
      const name = syscallNumberName(raw.nr);
      if (filter?.call !== undefined && filter.call !== name) return;
      if (filter?.names && !filter.names.includes(name)) return;
      const event: SyscallEvent = {
        t: `+${((raw.t - t0) / 1000).toFixed(6)}`,
        pid: raw.pid,
        call: name,
        args: raw.args
          .filter((a) => a !== 0 && a !== 0n)
          .join(", ") || "—",
        // Return value isn't available at trace-emit time (we only see
        // the entry, not the completion). v0 leaves this blank; future
        // work can pair entry/return events.
        ret: "",
      };
      this.syscallHistoryRing.push(event);
      if (this.syscallHistoryRing.length > 1024) this.syscallHistoryRing.shift();
      cb(event);
    });
    return traceOff;
  }

  /**
   * Ring of recent syscall events that subscribers can replay against
   * when they first attach. Today this is a soft history (filled by
   * `subscribeSyscalls` callbacks); a v1 syscallHistory()-from-the-
   * kernel would dump the active trace ring without requiring a
   * subscription.
   */
  private syscallHistoryRing: SyscallEvent[] = [];

  syscallHistory(filter?: SyscallFilter): SyscallEvent[] {
    let history = this.syscallHistoryRing;
    if (filter?.pid !== undefined) history = history.filter((e) => e.pid === filter.pid);
    if (filter?.call !== undefined) history = history.filter((e) => e.call === filter.call);
    if (filter?.names) {
      const allowed = new Set(filter.names);
      history = history.filter((e) => allowed.has(e.call));
    }
    return history.slice();
  }

  async prepareAudio(): Promise<void> {
    if (!this.kernel?.prepareAudio) {
      throw new Error("PCM output is unavailable");
    }
    await this.kernel.prepareAudio();
  }

  async resumeAudio(): Promise<void> {
    if (!this.kernel?.resumeAudio) {
      throw new Error("PCM output is unavailable");
    }
    await this.kernel.resumeAudio();
  }

  async suspendAudio(): Promise<void> {
    await this.kernel?.suspendAudio?.();
  }

  getAudioState(): MachineAudioState {
    return this.kernel?.getAudioState?.() ?? "unavailable";
  }

  subscribeAudioState(cb: (state: MachineAudioState) => void): () => void {
    const off = this.audioStateListeners.add(cb);
    cb(this.getAudioState());
    return off;
  }

  /**
   * Walk the parent chain of `pid` and return the shell pid it descends from
   * when it shares a terminal PTY for stdin. Used by attachFramebuffer to pick
   * the right stdin-routing path.
   *
   * Returns null if there's no active shell, or the bound pid is itself
   * the shell, or enumProcs can't reach the kernel.
   */
  private async findPtyRoutingPid(pid: number): Promise<number | null> {
    const owners = this.ptyOwnerPids();
    if (owners.size === 0) return null;
    if (owners.has(pid)) return null;
    try {
      const procs = await this.enumProcs();
      const byPid = new Map(procs.map((p) => [p.pid, p.ppid]));
      // Walk up the parent chain; bounded by the table size so a
      // cycle (shouldn't happen but defensive) can't loop forever.
      let cur: number | undefined = byPid.get(pid);
      const seen = new Set<number>();
      while (cur !== undefined && cur !== 0 && !seen.has(cur)) {
        if (owners.has(cur)) return cur;
        seen.add(cur);
        cur = byPid.get(cur);
      }
    } catch {
      // Kernel introspection unavailable; default to the non-PTY path.
    }
    return null;
  }

  // ── KernelHost: framebuffer ──────────────────────────────────────────────

  attachFramebuffer(canvas: HTMLCanvasElement): FramebufferHandle {
    if (!this.kernel?.framebuffers || !this.kernel.getProcessMemory) {
      throw new Error(
        "LiveKernelHost.attachFramebuffer: kernel exposes no framebuffer " +
        "registry. Wire BrowserKernel's `framebuffers` + `getProcessMemory` " +
        "through KernelLike before calling.",
      );
    }
    const registry = this.kernel.framebuffers;
    const kernel = this.kernel;
    // Narrow the optional-on-interface getProcessMemory down to a concrete
    // function for the renderer (whose contract requires it to be defined).
    const getProcessMemoryImpl = kernel.getProcessMemory!.bind(kernel);
    const getMemory = (pid: number): WebAssembly.Memory | undefined =>
      getProcessMemoryImpl(pid);

    let stop: (() => void) | null = null;
    let attachedPid: number | null = null;
    /**
     * Shell pid when the bound fb process inherits stdin from a terminal PTY
     * (forked from bash). In that case sendInput routes bytes through
     * `ptyWrite(shellPid)` so they reach the foreground process. Null for
     * standalone host-spawned processes (e.g. fbdoom #1 from
     * createLiveHost's auto-spawn) which read from their own stdin
     * buffer; we route to `appendStdinData(pid)` and skip the PTY to
     * avoid leaking scancode bytes into the shell after exit.
     */
    let attachedPtyPid: number | null = null;
    const boundPidListeners = new ListenerSet<number | null>();

    const setBoundPid = (pid: number | null) => {
      if (pid === attachedPid) return;
      attachedPid = pid;
      if (pid === null) attachedPtyPid = null;
      boundPidListeners.emit(pid);
    };

    // Decide which stdin path the bound process reads from: a pid that
    // descends from a shell's PTY is fed through the PTY master, and a
    // standalone one through its own host-side stdin buffer.
    //
    // Re-answered whenever a PTY-owning pid appears, because the binding does
    // not always come last. A machine restored from a checkpoint has its
    // framebuffer bound by the restore itself, before the terminals it arrived
    // with are registered: answered once at bind time, every keystroke on a
    // machine that arrived by handover goes to a stdin buffer nothing reads.
    const resolveRouting = (pid: number) => {
      void this.findPtyRoutingPid(pid).then((ptyPid) => {
        if (attachedPid === pid) attachedPtyPid = ptyPid;
      });
    };
    const offPtyOwners = this.ptyOwnerListeners.add(() => {
      if (attachedPid !== null) resolveRouting(attachedPid);
    });

    const tryAttach = (pid: number) => {
      if (attachedPid !== null) return; // already attached
      setBoundPid(pid);
      resolveRouting(pid);
      // Lazy-import the host renderer so it is not pulled into Kandelo
      // bundles that do not render framebuffers.
      void import("../../../host/src/framebuffer/canvas-renderer.js").then(({ attachCanvas }) => {
        if (attachedPid !== pid) return; // raced with unbind
        stop = attachCanvas(canvas, registry as unknown as Parameters<typeof attachCanvas>[1], pid, {
          getProcessMemory: getMemory,
        });
      });
    };

    // Attach to any pid already bound when the pane mounts.
    const existing = registry.list()[0];
    if (existing) tryAttach(existing.pid);

    const clearCanvas = () => {
      // Drop the last painted frame so the "waiting for /dev/fb0"
      // placeholder can render through. Renderer is stopped before this.
      const ctx = canvas.getContext("2d");
      if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
    };

    const offChange = registry.onChange((pid, ev) => {
      if (ev === "bind") {
        tryAttach(pid);
      } else if (ev === "unbind" && pid === attachedPid) {
        stop?.();
        stop = null;
        clearCanvas();
        setBoundPid(null);
      }
    });
    const offProcessExit = this.processListeners.add((event) => {
      if (event.kind !== "exit" || event.pid !== attachedPid) return;
      stop?.();
      stop = null;
      clearCanvas();
      setBoundPid(null);
    });

    const ensureStillBound = (): number | null => {
      if (attachedPid === null) return null;
      const stillBound = registry.list().some((entry) => entry.pid === attachedPid);
      if (!stillBound) {
        stop?.();
        stop = null;
        clearCanvas();
        setBoundPid(null);
        return null;
      }
      return attachedPid;
    };

    return {
      sendInput: (bytes) => {
        if (this.holdsReplica()) return;
        const pid = ensureStillBound();
        if (pid === null) return;
        // Route input to the source the bound process actually reads from.
        // Sending to both would leak unread bytes into bash's PTY buffer
        // when a standalone fb process exits, polluting the next bash
        // command line.
        if (attachedPtyPid !== null) {
          kernel.ptyWrite(attachedPtyPid, bytes);
        } else if (kernel.appendStdinData) {
          kernel.appendStdinData(pid, bytes);
        }
      },
      sendMouseEvent: (dx, dy, buttons) => {
        if (this.holdsReplica()) return;
        if (ensureStillBound() === null) return;
        kernel.injectMouseEvent?.(dx, dy, buttons);
      },
      startAudio: async () => {
        if (!kernel.resumeAudio) return null;
        return {
          resume: () => kernel.resumeAudio!(),
          // Audio is a machine resource shared by all Unix applications. A
          // framebuffer-scoped compatibility handle must not tear it down.
          close: () => {},
          getState: () => {
            switch (kernel.getAudioState?.() ?? "unavailable") {
              case "running":
                return "running";
              case "closed":
                return "closed";
              case "suspended":
              case "interrupted":
              case "unprepared":
                return "suspended";
              case "unavailable":
              case "error":
                return "unavailable";
            }
          },
        };
      },
      getBoundPid: () => attachedPid,
      onBoundPidChange: (cb) => boundPidListeners.add(cb),
      close: () => {
        offChange();
        offProcessExit();
        offPtyOwners();
        stop?.();
        stop = null;
        setBoundPid(null);
      },
    };
  }

  /**
   * Join the framebuffer a pane is already painting, to share it with a peer.
   *
   * Unlike {@link attachFramebuffer} it starts no renderer and forwards no
   * input: it reports which process owns `/dev/fb0` and hands back the
   * registry a mirror publishes from. A machine can therefore be watched by
   * a peer while the pane that attached the canvas keeps input authority.
   */
  shareFramebuffer(): SharedFramebufferHandle | null {
    const registry = this.kernel?.framebuffers;
    if (!registry) return null;

    const boundPidListeners = new ListenerSet<number | null>();
    let boundPid: number | null = registry.list()[0]?.pid ?? null;
    const setBoundPid = (pid: number | null) => {
      if (pid === boundPid) return;
      boundPid = pid;
      boundPidListeners.emit(pid);
    };

    const offChange = registry.onChange((pid, ev) => {
      if (ev === "bind") setBoundPid(pid);
      else if (pid === boundPid) setBoundPid(null);
    });
    // A process can die without the kernel emitting an unbind, and a mirror
    // that kept publishing a dead pid would show its last frame as live.
    const offProcessExit = this.processListeners.add((event) => {
      if (event.kind !== "exit" || event.pid !== boundPid) return;
      setBoundPid(null);
    });

    return {
      registry,
      getBoundPid: () => boundPid,
      onBoundPidChange: (cb) => boundPidListeners.add(cb),
      close: () => {
        offChange();
        offProcessExit();
      },
    };
  }

  // ── KernelHost: KMS display ──────────────────────────────────────────────

  attachKmsDisplay(
    canvas: HTMLCanvasElement,
    crtcId: number = 1,
    opts: { mode?: "auto" | "2d" | "webgl2" } = { mode: "webgl2" },
  ): KmsDisplayHandle | null {
    if (!this.kernel?.kmsAttachCanvas) return null;
    if (typeof canvas.transferControlToOffscreen !== "function") return null;
    // React 18 StrictMode double-invokes effects: mount → cleanup → mount,
    // and the second mount hits this method again on the same DOM canvas.
    // `transferControlToOffscreen()` can only be called once per canvas, so
    // memoize the handle here. The cached handle keeps the original
    // statsSab/OffscreenCanvas alive across the StrictMode unmount.
    const cached = this.kmsHandles.get(canvas);
    if (cached) return cached;
    // 7 i32 slots × 4 bytes = 28 bytes; align to 64 so atomics are happy.
    const statsSab = new SharedArrayBuffer(64);
    const stats = new Int32Array(statsSab);
    const offscreen = canvas.transferControlToOffscreen();
    this.kernel.kmsAttachCanvas(crtcId, offscreen, statsSab, opts);
    const kernel = this.kernel;
    const handle: KmsDisplayHandle = {
      crtcId,
      stats,
      sendMouseEvent: (dx, dy, buttons) => {
        if (this.holdsReplica()) return;
        kernel.injectMouseEvent?.(dx, dy, buttons);
      },
      close: () => {
        // The worker auto-stops the pump tick for unused CRTCs on the
        // next teardown; there's no explicit detach API yet. Closing
        // the handle just drops the local view so callers can drop
        // their reference.
      },
    };
    this.kmsHandles.set(canvas, handle);
    return handle;
  }

  getWebPreview(): WebPreviewState | null {
    return this.webPreview ? { ...this.webPreview } : null;
  }

  subscribeWebPreview(cb: (state: WebPreviewState | null) => void): () => void {
    return this.webPreviewListeners.add(cb);
  }

  getPresentation(): DemoPresentation {
    return { ...this.presentation, runningPrimary: this.presentation.runningPrimary.slice() };
  }

  subscribePresentation(cb: (state: DemoPresentation) => void): () => void {
    return this.presentationListeners.add(cb);
  }

  getSurfaceAvailability(): SurfaceAvailability {
    return { ...this.surfaceAvailability };
  }

  subscribeSurfaceAvailability(cb: (state: SurfaceAvailability) => void): () => void {
    return this.surfaceListeners.add(cb);
  }

  getDemoGuide(): DemoGuideConfig | null {
    return this.demoGuide ? structuredClone(this.demoGuide) : null;
  }

  getDemoIngest(): DemoIngestConfig | null {
    return this.demoIngest ? structuredClone(this.demoIngest) : null;
  }

  subscribeDemoIngest(cb: (state: DemoIngestConfig | null) => void): () => void {
    return this.demoIngestListeners.add(cb);
  }

  subscribeDemoGuide(cb: (state: DemoGuideConfig | null) => void): () => void {
    return this.demoGuideListeners.add(cb);
  }

  // ── KernelHost: sharing ──────────────────────────────────────────────────

  async snapshot(opts: SnapshotOptions = {}): Promise<Snapshot> {
    // Lazy import so the snapshot module isn't loaded for the (rare) caller
    // that only wants status/dmesg/pty.
    const { takeSnapshot } = await import("./snapshot");
    return takeSnapshot(this.getBootDescriptor(), opts);
  }

  // ── KernelHost: gallery ──────────────────────────────────────────────────

  subscribeGallery(cb: () => void): () => void {
    return this.galleryListeners.add(cb);
  }

  async galleryQuery(q: GalleryQuery): Promise<GalleryItem[]> {
    if (q.tab !== "presets") return [];
    const items = this.galleryItems.map((item) => ({ ...item, packages: item.packages.slice(), bootCommand: item.bootCommand.slice() }));
    const needle = q.q?.toLowerCase().trim();
    if (!needle) return items;
    return items.filter((i) =>
      i.title.toLowerCase().includes(needle) ||
      i.summary.toLowerCase().includes(needle),
    );
  }

  async saveCurrentToGallery(_title: string): Promise<GalleryItem> {
    throw NOT_IMPLEMENTED("saveCurrentToGallery");
  }
}

// ── VFS read helpers ───────────────────────────────────────────────────────

// posix open flags — copied locally to avoid a dependency on the host's
// channel.ts constants. O_RDONLY = 0.
const O_RDONLY = 0;

function readFileSync(fs: FileSystemLike, path: string): Uint8Array {
  const st = fs.stat(path);
  const chunks: Uint8Array[] = [];
  const handle = fs.open(path, O_RDONLY, 0);
  try {
    const total = st.size;
    // For files of unknown / streaming size we read in chunks; procfs files
    // sometimes report size 0 but have content.
    if (total > 0) {
      const buf = new Uint8Array(total);
      let off = 0;
      while (off < total) {
        const n = fs.read(handle, buf.subarray(off), null, total - off);
        if (n <= 0) break;
        off += n;
      }
      return buf.subarray(0, off);
    }
    const tmp = new Uint8Array(8192);
    let totalRead = 0;
    while (true) {
      const n = fs.read(handle, tmp, null, tmp.byteLength);
      if (n <= 0) break;
      chunks.push(tmp.slice(0, n));
      totalRead += n;
    }
    const out = new Uint8Array(totalRead);
    let off = 0;
    for (const c of chunks) { out.set(c, off); off += c.byteLength; }
    return out;
  } finally {
    try { fs.close(handle); } catch { /* ignore */ }
  }
}

// d_type values from MemoryFileSystem.readdir: DT_REG=8, DT_DIR=4, DT_LNK=10.
function direntKind(dtype: number, mode: number): "d" | "f" | "l" | "b" | "c" | "p" | "s" {
  if (dtype === 4 || (mode & 0xf000) === 0x4000) return "d";
  if (dtype === 10 || (mode & 0xf000) === 0xa000) return "l";
  if ((mode & 0xf000) === 0x6000) return "b";
  if ((mode & 0xf000) === 0x2000) return "c";
  if ((mode & 0xf000) === 0x1000) return "p";
  if ((mode & 0xf000) === 0xc000) return "s";
  return "f";
}

function formatMode(mode: number, kind: ReturnType<typeof direntKind>): string {
  const typeChar = (
    kind === "d" ? "d"
    : kind === "l" ? "l"
    : kind === "b" ? "b"
    : kind === "c" ? "c"
    : kind === "p" ? "p"
    : kind === "s" ? "s"
    : "-"
  );
  const perm = (bits: number) =>
    (bits & 4 ? "r" : "-") +
    (bits & 2 ? "w" : "-") +
    (bits & 1 ? "x" : "-");
  return (
    typeChar +
    perm((mode >> 6) & 7) +
    perm((mode >> 3) & 7) +
    perm(mode & 7)
  );
}

function humanSize(n: number): string {
  if (n < 1024) return String(n);
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}K`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}M`;
  return `${(n / 1024 / 1024 / 1024).toFixed(1)}G`;
}

/**
 * Resolve a raw syscall number to a printable name. Falls through to
 * `syscall_<nr>` for any number not in the table — the table is hand-
 * maintained against `crates/shared/src/lib.rs:Syscall`, so a brand-new
 * syscall would show up as `syscall_NNN` until the name is added.
 */
function syscallNumberName(nr: number): string {
  return SYSCALL_NAMES_LOCAL[nr] ?? `syscall_${nr}`;
}

// Hardcoded shim of the most common syscalls. The authoritative table
// lives in host/src/kernel-worker.ts:SYSCALL_NAMES. We duplicate the
// common subset here to keep kandelo-session from importing the heavyweight
// kernel-worker module (which transitively pulls in Node-only imports).
const SYSCALL_NAMES_LOCAL: Record<number, string> = {
  1: "open", 2: "close", 3: "read", 4: "write", 5: "lseek", 6: "fstat",
  7: "dup", 8: "dup2", 9: "pipe", 10: "fcntl", 11: "stat", 12: "lstat",
  13: "mkdir", 14: "rmdir", 15: "unlink", 16: "rename", 17: "link",
  18: "symlink", 19: "readlink", 20: "chmod", 21: "chown", 22: "access",
  23: "getcwd", 24: "chdir", 25: "opendir", 26: "readdir", 27: "closedir",
  28: "getpid", 29: "getppid", 30: "getuid", 31: "geteuid", 32: "getgid",
  33: "getegid", 34: "exit", 35: "kill", 36: "sigaction", 37: "sigprocmask",
  38: "raise", 39: "alarm", 40: "clock_gettime", 41: "nanosleep",
  42: "isatty", 43: "getenv", 44: "setenv", 45: "unsetenv",
  46: "mmap", 47: "munmap", 48: "brk", 49: "mprotect",
  50: "socket", 51: "bind", 52: "listen", 53: "accept", 54: "connect",
  55: "send", 56: "recv", 57: "shutdown", 58: "getsockopt", 59: "setsockopt",
  60: "poll", 61: "socketpair", 62: "sendto", 63: "recvfrom",
  64: "pread", 65: "pwrite", 66: "time", 67: "gettimeofday", 68: "usleep",
  69: "openat", 70: "tcgetattr", 71: "tcsetattr", 72: "ioctl",
  73: "signal", 74: "umask", 75: "uname", 76: "sysconf",
  77: "dup3", 78: "pipe2", 79: "ftruncate", 80: "fsync", 81: "writev",
  82: "readv", 83: "getrlimit", 84: "setrlimit", 85: "truncate",
  86: "fdatasync", 87: "fchmod", 88: "fchown", 89: "getpgrp",
  90: "setpgid", 91: "getsid", 92: "setsid", 93: "fstatat",
  94: "unlinkat", 95: "mkdirat", 96: "renameat", 97: "faccessat",
  98: "fchmodat", 99: "fchownat", 100: "linkat", 101: "symlinkat",
  102: "readlinkat", 103: "select", 104: "setuid", 105: "setgid",
  106: "seteuid", 107: "setegid", 108: "getrusage", 109: "realpath",
  110: "sigsuspend", 111: "pause", 112: "pathconf", 113: "fpathconf",
  114: "getsockname", 115: "getpeername", 116: "rewinddir", 117: "telldir",
  118: "seekdir", 122: "getdents64", 123: "clock_getres", 124: "clock_nanosleep",
  125: "utimensat", 126: "mremap", 127: "fchdir", 128: "madvise",
  129: "statfs", 130: "fstatfs", 131: "setresuid", 132: "getresuid",
  133: "setresgid", 134: "getresgid", 135: "getgroups", 136: "setgroups",
  137: "sendmsg", 138: "recvmsg", 139: "wait4", 140: "getaddrinfo",
};

// ── KernelProcessSnapshot → ProcessInfo ───────────────────────────────────

function toProcessInfo(s: KernelProcessSnapshot, users: IdNameMap): ProcessInfo {
  return {
    pid: s.pid,
    ppid: s.ppid,
    user: idToLabel(s.uid, users),
    cmdline: s.cmdline,
    state: s.state,
    memory: humanSize(s.memoryBytes ?? s.vsizeBytes),
  };
}

// ── /proc parsers ──────────────────────────────────────────────────────────

function parseProcEntry(fs: FileSystemLike, pid: number, users: IdNameMap): ProcessInfo {
  // Linux /proc/[pid]/stat format: pid (comm) state ppid ... — the comm
  // field is parenthesized and may contain spaces. We scan from the last
  // ')' to skip the executable name field, then split the rest.
  const statText = decodeBytes(readFileSync(fs, `/proc/${pid}/stat`));
  const closeParen = statText.lastIndexOf(")");
  const rest = closeParen === -1 ? statText : statText.slice(closeParen + 2);
  const fields = rest.trim().split(/\s+/);
  const state = (fields[0] ?? "S") as ProcessInfo["state"];

  const status = decodeBytes(readFileSync(fs, `/proc/${pid}/status`)).split("\n");
  const statusMap: Record<string, string> = {};
  for (const line of status) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    statusMap[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  const user = statusMap.Uid?.split(/\s+/)[1] ?? statusMap.Uid?.split(/\s+/)[0] ?? "0";
  const memory = parseStatusBytes(statusMap.VmSize);

  let cmdline = "";
  try {
    const raw = readFileSync(fs, `/proc/${pid}/cmdline`);
    cmdline = decodeBytes(raw).replace(/\0+$/, "").replace(/\0/g, " ");
  } catch { /* keep blank */ }
  if (!cmdline) cmdline = statusMap.Name ? `[${statusMap.Name}]` : "[unknown]";

  return {
    pid,
    ppid: Number(statusMap.PPid ?? 0) || 0,
    user: numericIdStringToLabel(user, users),
    cmdline,
    state,
    memory,
  };
}

function parseStatusBytes(raw: string | undefined): string {
  if (!raw) return "0";
  const m = /(\d+)\s*kB/.exec(raw);
  if (!m) return raw;
  const kb = Number(m[1]);
  if (kb < 1024) return `${kb}K`;
  if (kb < 1024 * 1024) return `${(kb / 1024).toFixed(1)}M`;
  return `${(kb / 1024 / 1024).toFixed(1)}G`;
}

type IdNameMap = Map<number, string>;

interface IdNameMaps {
  users: IdNameMap;
  groups: IdNameMap;
}

function loadIdNameMaps(fs: FileSystemLike): IdNameMaps {
  return {
    users: loadColonIdMap(fs, "/etc/passwd", 2, new Map([[0, "root"]])),
    groups: loadColonIdMap(fs, "/etc/group", 2, new Map([[0, "root"]])),
  };
}

function loadColonIdMap(
  fs: FileSystemLike,
  path: string,
  idField: number,
  fallback: IdNameMap,
): IdNameMap {
  const out: IdNameMap = new Map();
  let text: string;
  try {
    text = decodeBytes(readFileSync(fs, path));
  } catch {
    return new Map(fallback);
  }
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const fields = line.split(":");
    const name = fields[0];
    const rawId = fields[idField];
    if (!name || rawId === undefined) continue;
    const id = Number(rawId);
    if (!Number.isInteger(id) || id < 0) continue;
    if (!out.has(id)) out.set(id, name);
  }
  for (const [id, name] of fallback) {
    if (!out.has(id)) out.set(id, name);
  }
  return out;
}

function numericIdStringToLabel(rawId: string, names: IdNameMap): string {
  const id = Number(rawId);
  if (!Number.isInteger(id) || id < 0) return rawId;
  return idToLabel(id, names);
}

function idToLabel(id: number, names: IdNameMap): string {
  return names.get(id) ?? String(id);
}

function decodeBytes(b: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: false }).decode(b);
}

function parseMaps(text: string): MemMapEntry[] {
  // Each line: "00400000-005c2000 r-xp 00000000 fe:00 14222 /bin/bash"
  const out: MemMapEntry[] = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    const parts = line.split(/\s+/);
    if (parts.length < 5) continue;
    const [range, perm, offset] = parts;
    const path = parts.slice(5).join(" ") || "";
    const sizeBytes = parseRangeSize(range);
    out.push({
      range,
      perm,
      offset,
      size: humanSize(sizeBytes),
      path,
    });
  }
  return out;
}

function parseRangeSize(range: string): number {
  const m = /^([0-9a-f]+)-([0-9a-f]+)$/i.exec(range);
  if (!m) return 0;
  return Math.max(0, parseInt(m[2], 16) - parseInt(m[1], 16));
}

/**
 * Render the boot descriptor's mount table as the inspector view.
 * Source-of-truth for mounts is the descriptor — the kernel applies
 * them at boot and there's no live mount/umount syscall path yet.
 */
function descriptorMountsToInfo(mounts: DescriptorMount[]): MountInfo[] {
  return mounts.map((m) => {
    // source string: prefer the human-readable kind plus any ref/data/name.
    const ref = m.ref ?? m.data ?? m.name;
    const source = ref ? `${m.source}:${shortenRef(ref)}` : m.source;
    const optsParts: string[] = [];
    if (m.readonly) optsParts.push("ro");
    else optsParts.push("rw");
    if (m.ephemeral) optsParts.push("ephemeral");
    if (m.source === "scratch") optsParts.push("tmpfs");
    if (m.source === "image") optsParts.push("relatime");
    return {
      source,
      target: m.path,
      fs: fsForMountSource(m.source),
      opts: optsParts.join(","),
    };
  });
}

function fsForMountSource(s: DescriptorMount["source"]): string {
  switch (s) {
    case "image":           return "kandelo-vfs";
    case "package-layer":   return "overlay";
    case "inline-overlay":  return "overlay";
    case "remote-overlay":  return "overlay";
    case "scratch":         return "tmpfs";
    case "opfs":            return "opfs";
    case "lazy-http":       return "lazyfs";
    case "archive":         return "archivefs";
    case "git":             return "gitfs";
    case "cas":             return "casfs";
    case "encrypted":       return "cryptfs";
    case "device":          return "devfs";
  }
}

function shortenRef(ref: string): string {
  // "rootfs@sha256:9f2a3b81…" is long; trim hashes to short-prefix display.
  const at = ref.indexOf("@");
  if (at < 0) return ref;
  const name = ref.slice(0, at);
  const hash = ref.slice(at + 1).replace(/^sha256:/, "");
  return `${name}@${hash.slice(0, 8)}`;
}

function parseMounts(text: string): MountInfo[] {
  const out: MountInfo[] = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    // /proc/mounts format: source target fs opts dump pass
    const parts = line.split(/\s+/);
    if (parts.length < 4) continue;
    out.push({
      source: parts[0],
      target: parts[1],
      fs: parts[2],
      opts: parts[3],
    });
  }
  return out;
}
