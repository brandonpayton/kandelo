/**
 * BrowserKernel — Thin proxy that communicates with a dedicated kernel
 * web worker via MessagePort. The kernel worker owns the Wasm instance
 * and all process lifecycle (fork/exec/clone/exit).
 *
 * The main thread handles only UI, filesystem setup, and application-level
 * clients (MySQL, Redis) via async pipe operations.
 */

import {
  MemoryFileSystem,
  type LazyDownloadEvent,
} from "./vfs/memory-fs";
import { FramebufferRegistry } from "./framebuffer/registry";
import type { ProcessSnapshot, SyscallTraceEvent } from "./kernel-worker";
import type {
  HostDiagnostic,
  MainToKernelMessage,
  KernelToMainMessage,
  VfsFileSnapshot,
} from "./browser-kernel-protocol";
import type { HttpRequest, HttpResponse } from "./networking/in-kernel-http";
import {
  type BrowserCorsProxyConfig,
  validateBrowserCorsProxyConfig,
} from "./networking/browser-cors-proxy";

export type { HttpRequest, HttpResponse };
import workerEntryUrl from "./worker-entry-browser.ts?worker&url";
import kernelWorkerEntryUrl from "./browser-kernel-worker-entry.ts?worker&url";
import {
  DEFAULT_MAX_PAGES,
  DEFAULT_MAX_WORKERS,
  WASM_PAGE_SIZE,
} from "./constants";
import {
  snapshotClosedLazyAssets,
  type ClosedLazyAsset,
} from "./vfs/closed-lazy-assets";
import { awaitGracefulKernelRealmDestroy } from "./kernel-realm-destroy";
import type { MountSpec } from "./vfs/default-mounts";
import { FILE_MODES } from "./generated/abi";
import { BrowserPcmDriver } from "./audio/browser-pcm-driver";
import type { PcmOutputState } from "./audio/pcm-driver";
import type { PcmTransportDescriptor } from "./audio/pcm-transport";

const DESTROY_REQUEST_TIMEOUT_MS = 2_000;
const MAX_PENDING_PTY_OUTPUT_BYTES = 64 * 1024;
const MAX_PENDING_PTY_OUTPUT_CHUNKS = 4_096;
const defaultPcmWorkletUrl = new URL(
  "./audio/pcm-audio-worklet.js",
  import.meta.url,
);

export interface BrowserKernelOptions {
  /** Maximum concurrent workers (default: 4) */
  maxWorkers?: number;
  /** Maximum wasm memory pages per process (default: 16384 = 1GB). This caps
   *  guest brk/mmap growth; initial process memory is computed separately. */
  maxMemoryPages?: number;
  /**
   * Allocation-admission budget sampled from simultaneously live process
   * address spaces before each new allocation.
   *
   * A running guest can grow its own memory without a JavaScript callback, so
   * aggregate growth may cross this value until the next allocation observes
   * it. `maxMemoryPages` remains the hard per-process growth cap.
   *
   * Retired generations are never reused and pass through a separate short,
   * admission-threshold window before new churn proceeds.
   */
  maxProcessMemoryBytes?: number;
  /** Host default pthread slots when a wasm binary declares -1 (default: 16). */
  defaultThreadSlots?: number;
  /** Additional VFS mount points */
  extraMounts?: Array<{ mountPoint: string; backend: { open: Function } }>;
  /** Environment variables for spawned processes */
  env?: string[];
  /** Called when a process writes to stdout */
  onStdout?: (data: Uint8Array) => void;
  /** Called when a process writes to stderr */
  onStderr?: (data: Uint8Array) => void;
  /** PID-attributed stdout for protected runners and process-aware consumers. */
  onProcessStdout?: (pid: number, data: Uint8Array) => void;
  /** PID-attributed stderr for protected runners and process-aware consumers. */
  onProcessStderr?: (pid: number, data: Uint8Array) => void;
  /** Called for host-runtime diagnostics that are not guest stderr. */
  onHostDiagnostic?: (diagnostic: HostDiagnostic) => void;
  /** Called when a process requests a TCP listener (for service worker bridging) */
  onListenTcp?: (pid: number, fd: number, port: number) => void;
  /** Called when the service-worker HTTP bridge gains or completes preview requests. */
  onHttpBridgePendingRequests?: (count: number) => void;
  /** Called as lazy VFS files or archives are fetched on demand. */
  onLazyDownload?: (event: LazyDownloadEvent) => void;
  /** Called when a process is spawned, execs a new program, or exits.
   *  Used by Inspector-style UIs to refresh their process table without
   *  polling. Source feeds:
   *    - main-thread BrowserKernel.spawn / .boot → "spawn"
   *    - worker-side fork / posix_spawn → "spawn" with `ppid` (via proc_event message)
   *    - worker-side execve → "exec"
   *    - worker-side exit → "exit" (via existing exit message)
   *  Main-thread root spawns do not carry `ppid`.
   */
  onProcessEvent?: (event: { kind: "spawn" | "exec" | "exit"; pid: number; ppid?: number; exitStatus?: number }) => void;
  /** Pre-compiled thread module for clone(). Avoids recompiling large wasm for each thread. */
  threadModule?: WebAssembly.Module;
  /** The kernel worker always owns the VFS exclusively: the main thread holds
   *  no VFS SharedArrayBuffer, so it is reclaimed by `Worker.terminate()` and
   *  never accumulates across image switches (Safari OOM fix). Demos build a
   *  VFS image with {@link MemoryFileSystem} + `saveImage()` and pass it to
   *  {@link BrowserKernel.boot} / {@link BrowserKernel.initFromImage}. Accepted
   *  for backward compatibility; the value is ignored (there is no other mode). */
  kernelOwnedFs?: boolean;
  /** Debug: log every syscall to the kernel-worker console. Noisy. */
  enableSyscallLog?: boolean;
  /** Debug: only log syscalls for processes of the given pointer width
   *  (4=wasm32, 8=wasm64). Use 8 to focus on a single wasm64 process in a
   *  mixed-arch demo. */
  syscallLogPtrWidth?: 4 | 8;
  /** Forwarded to TlsNetworkBackendOptions.dnsAliases. */
  dnsAliases?: Record<string, string>;
  /** Browser pages that are not controlled by Kandelo's service worker can
   *  use this to route guest HTTP(S) and external lazy VFS downloads through
   *  a CORS-capable proxy. Same-origin lazy assets remain direct. */
  corsProxy?: BrowserCorsProxyConfig;
  /** Override the packaged PCM AudioWorklet asset URL. */
  audioWorkletUrl?: string | URL;
}

/** Options for {@link BrowserKernel.boot}. */
export interface BrowserKernelBootOptions {
  /** Kernel wasm bytes; if omitted, fetched from the bundled URL. */
  kernelWasm?: ArrayBuffer;
  /**
   * Pre-built VFS image bytes from {@link MemoryFileSystem.saveImage}, OR
   * the literal `"default"` to fetch the canonical `host/wasm/rootfs.vfs`
   * shipped with the worker entry. The worker takes ownership; the main
   * thread no longer has FS access.
   */
  vfsImage: Uint8Array | "default";
  /** Base URL used to resolve relative lazy file/archive URLs in `vfsImage`. */
  lazyUrlBase?: string;
  /**
   * Exhaustive exact URL-to-byte transport for lazy entries in `vfsImage`.
   * When set, an unbound URL fails instead of using ambient browser fetch.
   */
  closedLazyAssets?: readonly ClosedLazyAsset[];
  /** Exact image/scratch mount contract for this boot. */
  rootfsMountSpec?: readonly MountSpec[];
  /** Argv for the first (and currently only "init") process. argv[0] should
   *  be a path inside the VFS image. */
  argv: string[];
  /** Override the kernel's default environment for the first process. */
  env?: string[];
  /** Working directory for the first process. */
  cwd?: string;
  /** Initial real/effective user ID for the first process. */
  uid?: number;
  /** Initial real/effective group ID for the first process. */
  gid?: number;
  /** Allocate a PTY for the first process. */
  pty?: boolean;
  /** Initial stdin bytes (with implicit EOF). */
  stdin?: Uint8Array;
}

export type BrowserKernelOwnedImageBootOptions = Omit<
  BrowserKernelBootOptions,
  "vfsImage"
> & {
  /**
   * One whole ordinary ArrayBuffer whose ownership is transferred to the
   * kernel worker. The caller must finish hashing or otherwise inspecting the
   * bytes before this call because the buffer is detached during boot.
   */
  vfsImage: ArrayBuffer;
};

export interface BrowserKernelOwnedImageInitOptions {
  kernelWasm?: ArrayBuffer;
  /**
   * One whole ordinary ArrayBuffer whose ownership is transferred to the
   * kernel worker and detached from the caller.
   */
  vfsImage: ArrayBuffer;
  lazyUrlBase?: string;
  closedLazyAssets?: readonly ClosedLazyAsset[];
  /** Exact image/scratch mount contract for this boot. */
  rootfsMountSpec?: readonly MountSpec[];
}

async function fetchDefaultBrowserKernelArtifact(
  kind: "kernelWasm" | "rootfsVfs",
): Promise<ArrayBuffer> {
  // WHY: explicit-byte consumers, including trust-boundary tests and embedded
  // hosts, must not require the demo build's default kernel/rootfs artifacts.
  // Keep their Vite URL imports behind the branch that actually requests a
  // default while preserving the normal product-build path.
  const { browserKernelDefaultArtifactUrls } = await import(
    "./browser-kernel-default-artifacts"
  );
  return fetch(browserKernelDefaultArtifactUrls[kind]).then((response) =>
    response.arrayBuffer()
  );
}

/**
 * Phase 6 D5: fetch the wasm32 fork-module bytes from its optional bundler URL.
 * Kept behind its own dynamic import so a default boot never requires the
 * fork-module artifact (see `browser-fork-module-artifact`).
 */
async function fetchDefaultBrowserForkModule32(): Promise<ArrayBuffer> {
  const { browserForkModule32ArtifactUrl } = await import(
    "./browser-fork-module-artifact"
  );
  return fetch(browserForkModule32ArtifactUrl).then((response) =>
    response.arrayBuffer()
  );
}

export class BrowserKernel {
  private kernelWorkerHandle!: Worker;
  private workerStarted = false;
  private initialized = false;
  /** POSIX shared-memory / semaphore SAB shared with the kernel worker. Small
   *  and fixed (1 MiB); the live VFS is owned by the worker, not here. */
  private shmSab: SharedArrayBuffer;
  private maxPages: number;
  private options: Required<
    Pick<BrowserKernelOptions, "maxWorkers" | "env">
  > &
    BrowserKernelOptions;
  private exitResolvers = new Map<number, {
    resolve: (status: number) => void;
    reject: (error: Error) => void;
  }>();
  private kernelFatalError: Error | null = null;
  private unclaimedExitStatuses = new Map<number, { status: number; sequence: number }>();
  private exitSequence = 0;
  private pendingRequests = new Map<number, { resolve: (val: any) => void; reject: (err: Error) => void }>();
  private nextRequestId = 1;
  private ptyOutputCallbacks = new Map<number, (data: Uint8Array) => void>();
  /**
   * Mirror of the kernel-worker's FramebufferRegistry, populated by
   * forwarded fb_bind / fb_unbind messages. The renderer
   * (host/src/framebuffer/canvas-renderer.ts) reads from here.
   */
  readonly framebuffers = new FramebufferRegistry();
  private fbMemoryByPid = new Map<
    number,
    { generation: number; memory: WebAssembly.Memory }
  >();
  /**
   * Highest framebuffer execution generation observed for each PID.
   * `released` is a short-lived tombstone that rejects a same-generation bind
   * until the ACK-ordered fb_forget_generation marker arrives.
   */
  private fbGenerationByPid = new Map<
    number,
    { generation: number; released: boolean }
  >();
  /** PTY output that arrived before the main thread registered a callback —
   * happens when `boot()` is awaited (process is running) before
   * PtyTerminal calls onPtyOutput. Drained when a callback registers. */
  private pendingPtyOutput = new Map<number, Uint8Array[]>();
  private pendingPtyOutputBytes = 0;
  private pendingPtyOutputChunks = 0;
  private pendingPtyOutputFailure: Error | undefined;
  private lazyDownloadListeners = new Set<(event: LazyDownloadEvent) => void>();
  private pcmTransport: PcmTransportDescriptor | null = null;
  private pcmDriver: BrowserPcmDriver | null = null;

  constructor(options: BrowserKernelOptions = {}) {
    this.maxPages = options.maxMemoryPages ?? DEFAULT_MAX_PAGES;
    const corsProxy = validateBrowserCorsProxyConfig(options.corsProxy);
    this.options = {
      maxWorkers: DEFAULT_MAX_WORKERS,
      env: [
        "HOME=/root",
        "TMPDIR=/tmp",
        "TERM=xterm-256color",
        "LANG=en_US.UTF-8",
        "USER=root",
        "LOGNAME=root",
        "SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt",
        "SSL_CERT_DIR=/etc/ssl/certs",
      ],
      ...options,
      corsProxy,
    };

    // The kernel worker owns the VFS. The main thread allocates only the
    // small shared-memory SAB (POSIX shm/semaphores), never a VFS buffer, so
    // nothing large accumulates on the main thread across image switches.
    this.shmSab = new SharedArrayBuffer(1024 * 1024);
    MemoryFileSystem.create(this.shmSab); // format shm SAB for kernel worker
  }

  /**
   * Boot the kernel from a pre-built VFS image and spawn the first process.
   * The worker takes ownership of the FS; the main thread no longer has FS
   * access. Returns the first process's exit code.
   *
   * Demos build the VFS image on the main thread using MemoryFileSystem +
   * the helpers in `host/src/vfs/image-helpers`, call `saveImage()` for
   * bytes, then pass them here.
   */
  async boot(options: BrowserKernelBootOptions): Promise<{ pid: number; exit: Promise<number> }> {
    await this.initFromImage(options);

    // The Rust ProcessTable allocates the first PID; the worker transports it
    // in the response and does not maintain an allocation authority of its own.
    return this.spawnFirstProcess(options);
  }

  /**
   * Ownership-taking peer of {@link boot}. This avoids structured-cloning a
   * large VFS image when the caller will never reuse its bytes.
   */
  async bootFromOwnedImage(
    options: BrowserKernelOwnedImageBootOptions,
  ): Promise<{ pid: number; exit: Promise<number> }> {
    await this.initFromOwnedImage(options);
    return this.spawnFirstProcess(options);
  }

  /**
   * Load a pre-built VFS image into the kernel worker WITHOUT spawning a
   * first process. The worker builds and takes ownership of the FS; the main
   * thread holds no FS SharedArrayBuffer, so the whole VFS is reclaimed when
   * the kernel worker is terminated (no dependence on main-thread GC — the
   * fix for the Safari image-switch OOM). Spawn processes afterward with
   * {@link spawnFromVfs}, or call {@link boot} to load + spawn a first process
   * in one step.
   */
  async initFromImage(options: {
    kernelWasm?: ArrayBuffer;
    vfsImage: Uint8Array | "default";
    lazyUrlBase?: string;
    closedLazyAssets?: readonly ClosedLazyAsset[];
    rootfsMountSpec?: readonly MountSpec[];
  }): Promise<void> {
    const [wasmBytes, vfsImage] = await Promise.all([
      options.kernelWasm
        ? Promise.resolve(options.kernelWasm)
        : fetchDefaultBrowserKernelArtifact("kernelWasm"),
      options.vfsImage === "default"
        ? fetchDefaultBrowserKernelArtifact("rootfsVfs")
            .then((b) => new Uint8Array(b))
        : Promise.resolve(options.vfsImage),
    ]);

    await this.bootWorker({
      kernelWasmBytes: wasmBytes,
      vfsImage,
      lazyUrlBase: options.lazyUrlBase ?? import.meta.env.BASE_URL,
      closedLazyAssets: options.closedLazyAssets,
      rootfsMountSpec: options.rootfsMountSpec,
      takeVfsImageOwnership: false,
    });
  }

  /**
   * Load an image by transferring its one whole ordinary ArrayBuffer to the
   * VFS-owning worker. Unlike {@link initFromImage}, this deliberately
   * detaches the caller's buffer. Keeping the two entry points explicit
   * preserves restart-friendly copy semantics for existing callers while
   * allowing reboot pipelines to avoid an aggregate-sized structured clone.
   */
  async initFromOwnedImage(
    options: BrowserKernelOwnedImageInitOptions,
  ): Promise<void> {
    if (!(options.vfsImage instanceof ArrayBuffer)) {
      throw new Error(
        "owned VFS image must be one whole ordinary ArrayBuffer",
      );
    }
    const wasmBytes = options.kernelWasm
      ? options.kernelWasm
      : await fetchDefaultBrowserKernelArtifact("kernelWasm");
    await this.bootWorker({
      kernelWasmBytes: wasmBytes,
      vfsImage: new Uint8Array(options.vfsImage),
      lazyUrlBase: options.lazyUrlBase ?? import.meta.env.BASE_URL,
      closedLazyAssets: options.closedLazyAssets,
      rootfsMountSpec: options.rootfsMountSpec,
      takeVfsImageOwnership: true,
    });
  }

  /**
   * Internal: set up the kernel worker, attach handlers, send the init
   * message (with the demo's `vfsImage`), and await ready.
   */
  private async bootWorker(opts: {
    kernelWasmBytes: ArrayBuffer;
    vfsImage: Uint8Array;
    lazyUrlBase?: string;
    closedLazyAssets?: readonly ClosedLazyAsset[];
    rootfsMountSpec?: readonly MountSpec[];
    takeVfsImageOwnership: boolean;
  }): Promise<void> {
    if (
      opts.takeVfsImageOwnership &&
      (
        !(opts.vfsImage.buffer instanceof ArrayBuffer) ||
        opts.vfsImage.byteOffset !== 0 ||
        opts.vfsImage.byteLength !== opts.vfsImage.buffer.byteLength
      )
    ) {
      throw new Error(
        "owned VFS image must be one whole ordinary ArrayBuffer",
      );
    }
    this.kernelFatalError = null;
    const closedLazyAssets = opts.closedLazyAssets === undefined
      ? undefined
      : snapshotClosedLazyAssets(opts.closedLazyAssets);
    // The co-resident fork-module is the UNCONDITIONAL fork reconstructor on the
    // browser V8 host too: fetch the wasm32 module bytes and ship them to the
    // kernel worker, which compiles them once and hands the compiled module to
    // every fork-instrumented process worker. There is no kill switch and no JS
    // reference engine behind it.
    const forkModuleBytes = await fetchDefaultBrowserForkModule32();
    // Create the kernel worker
    this.kernelWorkerHandle = new Worker(kernelWorkerEntryUrl, { type: "module" });
    this.workerStarted = true;

    this.kernelWorkerHandle.onmessage = (e: MessageEvent) => {
      this.handleWorkerMessage(e.data as KernelToMainMessage);
    };
    this.kernelWorkerHandle.onerror = (e: ErrorEvent) => {
      const err = new Error(`Kernel worker error: ${e.message}`);
      this.failKernelHost(err);
      this.kernelWorkerHandle.terminate();
      this.options.onHttpBridgePendingRequests?.(0);
      const diagnostic: HostDiagnostic = {
        pid: 0,
        source: "kernel worker",
        message: `[BrowserKernel] kernel worker error: ${e.message}`,
      };
      // A worker-level error cannot send a typed message itself. Preserve the
      // same callback contract and a visible default without treating the
      // failure as guest stderr.
      console.error(diagnostic.message);
      try {
        this.options.onHostDiagnostic?.(diagnostic);
      } catch (callbackError) {
        console.error("[BrowserKernel] onHostDiagnostic callback failed:", callbackError);
      }
    };

    try {
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const cleanup = () => {
          this.kernelWorkerHandle.removeEventListener("message", readyHandler);
          this.kernelWorkerHandle.removeEventListener("error", errorHandler);
          this.kernelWorkerHandle.removeEventListener("messageerror", messageErrorHandler);
        };
        const settleResolve = () => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve();
        };
        const settleReject = (err: Error) => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(err);
        };
        const readyHandler = (e: MessageEvent) => {
          if (e.data?.type === "ready") {
            settleResolve();
          } else if (e.data?.type === "init_error") {
            settleReject(new Error(`Kernel worker init failed: ${e.data.error}`));
          } else if (e.data?.type === "kernel_fatal") {
            settleReject(new Error(`Kernel worker failed: ${e.data.error}`));
          }
        };
        const errorHandler = (e: ErrorEvent) => {
          settleReject(new Error(`Kernel worker error during init: ${e.message}`));
        };
        const messageErrorHandler = () => {
          settleReject(new Error("Kernel worker failed to deserialize an init message"));
        };
        this.kernelWorkerHandle.addEventListener("message", readyHandler);
        this.kernelWorkerHandle.addEventListener("error", errorHandler);
        this.kernelWorkerHandle.addEventListener("messageerror", messageErrorHandler);

        // Slice so the caller's ArrayBuffer isn't detached (allows restart)
        const transferBuf = opts.kernelWasmBytes.slice(0);
        const initMsg: MainToKernelMessage = {
          type: "init",
          kernelWasmBytes: transferBuf,
          ...(forkModuleBytes ? { forkModuleBytes } : {}),
          vfsImage: opts.vfsImage,
          lazyUrlBase: opts.lazyUrlBase,
          closedLazyAssets,
          rootfsMountSpec: opts.rootfsMountSpec === undefined
            ? undefined
            : opts.rootfsMountSpec.map((mount) => ({ ...mount })),
          shmSab: this.shmSab,
          workerEntryUrl,
          config: {
            maxWorkers: this.options.maxWorkers,
            maxMemoryPages: this.maxPages,
            maxProcessMemoryBytes:
              this.options.maxProcessMemoryBytes
              ?? this.options.maxWorkers * this.maxPages * WASM_PAGE_SIZE,
            defaultThreadSlots: this.options.defaultThreadSlots,
            env: this.options.env,
            enableSyscallLog: this.options.enableSyscallLog,
            syscallLogPtrWidth: this.options.syscallLogPtrWidth,
            dnsAliases: this.options.dnsAliases,
            corsProxy: this.options.corsProxy,
          },
        };
        const transfer: Transferable[] = [transferBuf];
        if (forkModuleBytes) {
          transfer.push(forkModuleBytes);
        }
        if (opts.takeVfsImageOwnership) {
          // WHY: this API is used at durable reboot boundaries where the main
          // thread has already hashed the image and will not reuse it. Transfer
          // prevents a second 512 MiB structured-clone allocation while the
          // worker restores its own kernel-owned filesystem.
          transfer.push(opts.vfsImage.buffer as ArrayBuffer);
        }
        for (const asset of closedLazyAssets ?? []) {
          // snapshotClosedLazyAssets always allocates one ordinary ArrayBuffer
          // per binding, so transferring it cannot detach caller-owned bytes.
          transfer.push(asset.bytes.buffer as ArrayBuffer);
        }
        this.kernelWorkerHandle.postMessage(initMsg, transfer);
      });
    } catch (error) {
      // WHY: an init_error leaves no usable kernel, but the browser worker
      // remains alive unless the host explicitly releases it. Mirror Node:
      // failed initialization owns and tears down its half-created worker.
      await this.destroy();
      throw error;
    }
    this.initialized = true;
  }

  /**
   * Internal: send a spawn message for the first user process. The
   * Rust kernel allocates the pid; the worker returns it in the response.
   * The exit promise is wired up after the pid is known.
   */
  private async spawnFirstProcess(
    options: BrowserKernelBootOptions | BrowserKernelOwnedImageBootOptions,
  ): Promise<{ pid: number; exit: Promise<number> }> {
    const requestId = this.nextRequestId++;
    const spawnStartedBeforeExitSequence = this.exitSequence;
    const stdin = options.stdin ?? (!options.pty ? new Uint8Array() : undefined);

    const pid = await this.request(requestId, {
      type: "spawn",
      requestId,
      // No pid — the Rust kernel allocates it and the worker returns it.
      programPath: options.argv[0],
      argv: options.argv,
      env: this.mergeEnv(options.env ?? this.options.env),
      cwd: options.cwd,
      uid: options.uid,
      gid: options.gid,
      pty: options.pty,
      stdin,
      maxPages: this.maxPages,
    }) as number;

    const exit = this.claimExitStatus(pid, spawnStartedBeforeExitSequence);

    if (options.pty) {
      this.sendToKernel({ type: "register_pty_output", pid });
    }

    this.options.onProcessEvent?.({ kind: "spawn", pid });
    return { pid, exit };
  }

  /**
   * Send the HTTP bridge host port to the kernel worker for connection pump handling.
   * Call after init() but before spawning processes that listen on ports.
   * The port should come from HttpBridgeHost.detachHostPort().
   * @param httpPort The specific TCP port to route HTTP bridge requests to (e.g. 8080 for nginx).
   */
  sendBridgePort(hostPort: MessagePort, httpPort?: number): void {
    this.kernelWorkerHandle.postMessage(
      { type: "set_bridge_port", bridgePort: hostPort, httpPort },
      [hostPort],
    );
  }

  /**
   * Spawn a new process and return a promise that resolves with the exit code.
   *
   * `onStarted(pid)` fires once the kernel has registered the process and the
   * spawn request is acknowledged — but BEFORE awaiting the exit promise. Use
   * this to capture the pid for follow-up calls like `getForkCount(pid)` (the
   * spawn-regression-guardrail pattern; see
   * `apps/browser-demos/pages/benchmark/main.ts`).
   * Mirrors `NodeKernelHost.spawn`'s `onStarted` option.
   */
  async spawn(
    programBytes: ArrayBuffer,
    argv: string[],
    options?: {
      env?: string[];
      cwd?: string;
      stdin?: Uint8Array;
      pty?: boolean;
      uid?: number;
      gid?: number;
      onStarted?: (pid: number) => void | Promise<void>;
      ptyCols?: number;
      ptyRows?: number;
    },
  ): Promise<number> {
    const requestId = this.nextRequestId++;
    const spawnStartedBeforeExitSequence = this.exitSequence;
    const stdin =
      options?.stdin ??
      (!options?.pty && !options?.onStarted ? new Uint8Array() : undefined);

    // Clone programBytes since it gets transferred (detached)
    const bytesToSend = programBytes.slice(0);

    const pid = await this.request(requestId, {
      type: "spawn",
      requestId,
      programBytes: bytesToSend,
      argv,
      env: this.mergeEnv(options?.env ?? this.options.env),
      cwd: options?.cwd,
      uid: options?.uid,
      gid: options?.gid,
      pty: options?.pty,
      ptyCols: options?.ptyCols,
      ptyRows: options?.ptyRows,
      stdin,
      maxPages: this.maxPages,
    }, [bytesToSend]) as number;

    const exitPromise = this.claimExitStatus(pid, spawnStartedBeforeExitSequence);

    // Register PTY output callback if pty was requested
    if (options?.pty) {
      this.sendToKernel({ type: "register_pty_output", pid });
    }

    this.options.onProcessEvent?.({ kind: "spawn", pid });

    if (options?.onStarted) {
      await options.onStarted(pid);
    }

    return exitPromise;
  }

  /**
   * Spawn a process whose binary already lives in the kernel-owned VFS.
   * Returns the kernel-allocated pid + an exit promise.
   *
   * This does not transfer any `programBytes` across the worker boundary —
   * the kernel reads the binary out of its own memfs at `programPath`. Use
   * this in `kernelOwnedFs: true` mode (or whenever the binary is already in
   * the VFS) to avoid re-shipping multi-megabyte binaries the kernel already
   * has.
   *
   * Like every top-level spawn path, the Rust kernel allocates the pid and
   * the worker returns it.
   */
  async spawnFromVfs(
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
  ): Promise<{ pid: number; exit: Promise<number> }> {
    const requestId = this.nextRequestId++;
    const spawnStartedBeforeExitSequence = this.exitSequence;
    const pid = await this.request(requestId, {
      type: "spawn",
      requestId,
      programPath,
      argv,
      env: this.mergeEnv(options?.env ?? this.options.env),
      cwd: options?.cwd,
      uid: options?.uid,
      gid: options?.gid,
      pty: options?.pty,
      ptyCols: options?.ptyCols,
      ptyRows: options?.ptyRows,
      stdin: options?.stdin,
      maxPages: this.maxPages,
    }) as number;

    const exit = this.claimExitStatus(pid, spawnStartedBeforeExitSequence);

    if (options?.pty) {
      this.sendToKernel({ type: "register_pty_output", pid });
    }

    return { pid, exit };
  }

  /**
   * Read the kernel's per-process fork counter. Used by the spawn
   * regression tests to assert a `SYS_SPAWN` call didn't fall back to
   * fork — `getForkCount(parentPid)` should return the same value
   * before and after a `posix_spawn`.
   *
   * Returns `u64::MAX` (as `bigint`) if the pid does not exist; callers
   * should compare against an explicit before-value rather than treating
   * "no process" as "0 forks". Mirrors `NodeKernelHost.getForkCount`.
   */
  async getForkCount(pid: number): Promise<bigint> {
    const requestId = this.nextRequestId++;
    const result = await this.request(requestId, {
      type: "get_fork_count",
      requestId,
      pid,
    });
    return typeof result === "bigint" ? result : BigInt(result as number);
  }

  /**
   * Return the kernel Wasm instance's current size in 64 KiB pages.
   * This is kernel allocator telemetry, not guest process memory. Mirrors
   * `NodeKernelHost.getKernelMemoryPages`.
   */
  async getKernelMemoryPages(): Promise<number> {
    const requestId = this.nextRequestId++;
    const result = await this.request(requestId, {
      type: "get_kernel_memory_pages",
      requestId,
    });
    if (!Number.isSafeInteger(result) || result < 0) {
      throw new Error(`kernel worker returned an invalid memory-page count: ${String(result)}`);
    }
    return result;
  }

  /**
   * Return the retained capacity of the kernel-owned large-spawn region.
   * Zero means no spawn has exceeded the ordinary channel-sized scratch.
   */
  async getSpawnScratchCapacity(): Promise<number> {
    const requestId = this.nextRequestId++;
    const result = await this.request(requestId, {
      type: "get_spawn_scratch_capacity",
      requestId,
    });
    if (!Number.isSafeInteger(result) || result < 0) {
      throw new Error(
        `kernel worker returned an invalid spawn scratch capacity: ${String(result)}`,
      );
    }
    return result;
  }

  /**
   * Snapshot the kernel's process table — one row per live process. Used
   * by Kandelo's Inspector → Procs tab. Mirrors `NodeKernelHost.enumProcs`.
   */
  async enumProcs(): Promise<ProcessSnapshot[]> {
    const requestId = this.nextRequestId++;
    const result = await this.request(requestId, {
      type: "enum_procs",
      requestId,
    });
    return (result as ProcessSnapshot[]) ?? [];
  }

  /**
   * Read `/proc/[pid]/maps` for a foreign process. Returns the raw Linux-
   * style text, `""` if the process has no mappings, or `null` if the pid
   * has been reaped and is no longer a process. Mirrors
   * `NodeKernelHost.readProcMaps`.
   */
  async readProcMaps(pid: number): Promise<string | null> {
    const requestId = this.nextRequestId++;
    const result = await this.request(requestId, {
      type: "read_proc_maps",
      requestId,
      pid,
    });
    return (result as string | null) ?? null;
  }

  /**
   * Subscribe to the kernel-worker's syscall trace. Returns an
   * unsubscribe function. Trace is enabled when the first subscriber
   * attaches and disabled after the last one detaches — zero cost on
   * the kernel hot path when nobody's watching.
   *
   * Delivery: the main thread polls the worker every 250ms and fans
   * out batched events to subscribers in the order the kernel saw them.
   * Higher resolution would require a push-style worker message; the
   * poll buys low overhead at the cost of up to one polling-interval
   * of latency.
   */
  subscribeSyscalls(cb: (event: SyscallTraceEvent) => void): () => void {
    this.syscallListeners.add(cb);
    if (this.syscallListeners.size === 1) {
      this.sendToKernel({ type: "set_syscall_trace", enabled: true });
      this.startSyscallPoll();
    }
    return () => {
      this.syscallListeners.delete(cb);
      if (this.syscallListeners.size === 0) {
        this.sendToKernel({ type: "set_syscall_trace", enabled: false });
        this.stopSyscallPoll();
      }
    };
  }

  /** Subscribe to lazy VFS file/archive download progress. */
  subscribeLazyDownloads(cb: (event: LazyDownloadEvent) => void): () => void {
    this.lazyDownloadListeners.add(cb);
    return () => {
      this.lazyDownloadListeners.delete(cb);
    };
  }

  private syscallListeners = new Set<(event: SyscallTraceEvent) => void>();
  private syscallPollTimer: ReturnType<typeof setInterval> | null = null;

  private startSyscallPoll(): void {
    if (this.syscallPollTimer !== null) return;
    this.syscallPollTimer = setInterval(() => {
      void this.drainAndFan();
    }, 250);
  }

  private stopSyscallPoll(): void {
    if (this.syscallPollTimer === null) return;
    clearInterval(this.syscallPollTimer);
    this.syscallPollTimer = null;
  }

  private async drainAndFan(): Promise<void> {
    if (this.syscallListeners.size === 0) return;
    const requestId = this.nextRequestId++;
    let events: SyscallTraceEvent[] = [];
    try {
      const result = await this.request(requestId, {
        type: "drain_syscall_trace",
        requestId,
      });
      events = (result as SyscallTraceEvent[]) ?? [];
    } catch {
      return;
    }
    for (const event of events) {
      for (const cb of this.syscallListeners) {
        try { cb(event); } catch { /* listener errors don't break the loop */ }
      }
    }
  }

  /**
   * Inject an external TCP connection into the kernel's listening socket.
   * Returns the recv pipe index, or -1 on failure.
   */
  async injectConnection(
    pid: number,
    listenerFd: number,
    peerAddr: [number, number, number, number] = [127, 0, 0, 1],
    peerPort: number = 0,
  ): Promise<number> {
    const requestId = this.nextRequestId++;
    return this.request(requestId, {
      type: "inject_connection",
      requestId,
      pid,
      fd: listenerFd,
      peerAddr,
      peerPort,
    }) as Promise<number>;
  }

  /** Write data to a kernel pipe. */
  async pipeWrite(pid: number, pipeIdx: number, data: Uint8Array): Promise<number> {
    const requestId = this.nextRequestId++;
    return this.request(requestId, {
      type: "pipe_write",
      requestId,
      pid,
      pipeIdx,
      data,
    }) as Promise<number>;
  }

  /** Read data from a kernel pipe. */
  async pipeRead(pid: number, pipeIdx: number): Promise<Uint8Array | null> {
    const requestId = this.nextRequestId++;
    return this.request(requestId, {
      type: "pipe_read",
      requestId,
      pid,
      pipeIdx,
    }) as Promise<Uint8Array | null>;
  }

  /** Close the write end of a pipe. */
  pipeCloseWrite(pid: number, pipeIdx: number): void {
    this.sendToKernel({ type: "pipe_close_write", pid, pipeIdx });
  }

  /** Close the read end of a pipe. */
  pipeCloseRead(pid: number, pipeIdx: number): void {
    this.sendToKernel({ type: "pipe_close_read", pid, pipeIdx });
  }

  /** Check if a pipe's write end is still open. */
  async pipeIsWriteOpen(pid: number, pipeIdx: number): Promise<boolean> {
    const requestId = this.nextRequestId++;
    return this.request(requestId, {
      type: "pipe_is_write_open",
      requestId,
      pid,
      pipeIdx,
    }) as Promise<boolean>;
  }

  /** Wake any process blocked on reading the given pipe. */
  wakeBlockedReaders(pipeIdx: number): void {
    this.sendToKernel({ type: "wake_blocked_readers", pipeIdx });
  }

  /** Wake any process blocked on writing to the given pipe. */
  wakeBlockedWriters(pipeIdx: number): void {
    this.sendToKernel({ type: "wake_blocked_writers", pipeIdx });
  }

  /**
   * Send an HTTP request to a server running inside the kernel and return
   * the parsed response. Bypasses real TCP — uses the kernel's
   * `kernel_inject_connection` path directly. Prototype API.
   *
   * The in-kernel server must already be listening on `port`. Each call
   * opens a fresh injected connection (no pipelining).
   */
  async fetchInKernel(
    port: number,
    request: HttpRequest,
    options?: { timeoutMs?: number; maxResponseBytes?: number },
  ): Promise<HttpResponse> {
    const requestId = this.nextRequestId++;
    return this.request(requestId, {
      type: "http_request",
      requestId,
      port,
      request,
      timeoutMs: options?.timeoutMs,
      maxResponseBytes: options?.maxResponseBytes,
    }) as Promise<HttpResponse>;
  }

  /** Pick a listener target for the given port. */
  async pickListenerTarget(port: number): Promise<{ pid: number; fd: number } | null> {
    const requestId = this.nextRequestId++;
    return this.request(requestId, {
      type: "pick_listener_target",
      requestId,
      port,
    }) as Promise<{ pid: number; fd: number } | null>;
  }

  /** Append data to a process's stdin buffer. */
  appendStdinData(pid: number, data: Uint8Array): void {
    this.sendToKernel({ type: "append_stdin_data", pid, data });
  }

  /** Set a process's stdin data (complete buffer with implicit EOF). */
  setStdinData(pid: number, data: Uint8Array): void {
    this.sendToKernel({ type: "set_stdin_data", pid, data });
  }

  /** Check if a process's stdin buffer has been fully consumed. */
  async isStdinConsumed(pid: number): Promise<boolean> {
    const requestId = this.nextRequestId++;
    return this.request(requestId, {
      type: "is_stdin_consumed",
      requestId,
      pid,
    }) as Promise<boolean>;
  }

  /**
   * Deliver a POSIX signal to `pid`. Resolves false when the process is gone
   * (ESRCH). Unlike {@link terminateProcess}, which tears down the wasm worker
   * from the host, this runs the kernel's signal path, so the target's
   * disposition and the kernel's exit cleanup both apply.
   */
  async signalProcess(pid: number, signum: number): Promise<boolean> {
    const requestId = this.nextRequestId++;
    return this.request(requestId, {
      type: "signal_process",
      requestId,
      pid,
      signum,
    }) as Promise<boolean>;
  }

  /**
   * Push a mouse event into the kernel's `/dev/input/mice` queue. Pass
   * deltas in PS/2 sign convention (positive-right, positive-up — invert
   * the browser's deltaY before calling) and a button bitmask
   * (bit0=left, bit1=right, bit2=middle).
   */
  injectMouseEvent(dx: number, dy: number, buttons: number): void {
    this.sendToKernel({ type: "mouse_inject", dx, dy, buttons });
  }

  /**
   * Hand an `OffscreenCanvas` to the kernel worker as the scanout
   * target for KMS CRTC `crtcId`. The worker's vblank pump blits the
   * CRTC's currently-bound framebuffer into this canvas at 60 Hz.
   *
   * `canvas` is transferred — the main thread loses control of it.
   * Pass `stats` to receive blit + page-flip telemetry (see
   * `attachKmsStats` for the slot layout).
   */
  kmsAttachCanvas(
    crtcId: number,
    canvas: OffscreenCanvas,
    stats?: SharedArrayBuffer,
    opts?: { mode?: "auto" | "2d" | "webgl2" },
  ): void {
    this.sendToKernel(
      { type: "kms_attach_canvas", crtcId, canvas, stats, opts },
      [canvas],
    );
  }

  /**
   * Register a stats SAB for KMS CRTC `crtcId` without binding a
   * scanout canvas. The worker still writes `commit_count` and
   * `last_frame_us` into slots 5/6 each vblank tick. Used by demos
   * that render through WebGL rather than the 2D blit path.
   */
  kmsAttachStats(crtcId: number, stats: SharedArrayBuffer): void {
    this.sendToKernel({ type: "kms_attach_stats", crtcId, stats });
  }

  /**
   * Drain up to `maxBytes` of PCM audio buffered in the kernel's
   * `/dev/dsp` ring. Returns the bytes plus the configured sample
   * rate / channel count so the caller can build a correctly-sized
   * `AudioBuffer`. Empty `Uint8Array` if the ring is empty.
   *
   * @deprecated BrowserKernel now claims the shared-clock PCM transport for
   * its machine-level AudioWorklet. This compatibility method returns an
   * empty buffer while that transport is active.
   */
  async drainAudio(maxBytes: number): Promise<{
    bytes: Uint8Array;
    sampleRate: number;
    channels: number;
  }> {
    const requestId = this.nextRequestId++;
    return this.request(requestId, {
      type: "audio_drain",
      requestId,
      maxBytes,
    }) as Promise<{ bytes: Uint8Array; sampleRate: number; channels: number }>;
  }

  /** Preload the machine-level PCM sink without attempting user activation. */
  async prepareAudio(): Promise<void> {
    const transport = this.pcmTransport;
    if (!transport) throw new Error("PCM transport is not available");
    const driver = this.pcmDriver ??= new BrowserPcmDriver({
      workletUrl: this.options.audioWorkletUrl ?? defaultPcmWorkletUrl,
    });
    await driver.prepare(transport);
  }

  /** Resume audible PCM output. Call directly from a trusted user gesture. */
  async resumeAudio(): Promise<void> {
    await this.prepareAudio();
    await this.pcmDriver!.resume();
  }

  /** Suspend the browser audio clock without discarding queued PCM. */
  async suspendAudio(): Promise<void> {
    await this.pcmDriver?.suspend();
  }

  getAudioState(): PcmOutputState {
    return this.pcmDriver?.getState() ??
      (this.pcmTransport ? "unprepared" : "unavailable");
  }

  onAudioStateChange(listener: (state: PcmOutputState) => void): () => void {
    if (!this.pcmDriver && this.pcmTransport) {
      this.pcmDriver = new BrowserPcmDriver({
        workletUrl: this.options.audioWorkletUrl ?? defaultPcmWorkletUrl,
      });
    }
    if (!this.pcmDriver) {
      listener("unavailable");
      return () => {};
    }
    return this.pcmDriver.subscribe(listener);
  }

  // ── PTY methods ──

  /** Write data to the PTY master for a process. */
  ptyWrite(pid: number, data: Uint8Array): void {
    this.sendToKernel({ type: "pty_write", pid, data });
  }

  /** Resize the PTY for a process. */
  ptyResize(pid: number, rows: number, cols: number): void {
    this.sendToKernel({ type: "pty_resize", pid, rows, cols });
  }

  /** Register a callback for PTY output data from a process. Drains any
   * output that arrived before this call (e.g., when boot() returns the
   * process is already running). */
  onPtyOutput(pid: number, callback: (data: Uint8Array) => void): void {
    if (this.pendingPtyOutputFailure) {
      throw this.pendingPtyOutputFailure;
    }
    this.ptyOutputCallbacks.set(pid, callback);
    const pending = this.pendingPtyOutput.get(pid);
    if (pending) {
      this.pendingPtyOutput.delete(pid);
      this.pendingPtyOutputChunks -= pending.length;
      this.pendingPtyOutputBytes -= pending.reduce(
        (total, chunk) => total + chunk.byteLength,
        0,
      );
      for (const chunk of pending) callback(chunk);
    }
  }

  /** Remove any registered or buffered PTY output for a process. */
  clearPtyOutput(pid: number): void {
    this.ptyOutputCallbacks.delete(pid);
    const pending = this.pendingPtyOutput.get(pid);
    if (pending) {
      this.pendingPtyOutput.delete(pid);
      this.pendingPtyOutputChunks -= pending.length;
      this.pendingPtyOutputBytes -= pending.reduce(
        (total, chunk) => total + chunk.byteLength,
        0,
      );
    }
  }

  /** Terminate a specific process. */
  async terminateProcess(pid: number, status = -1): Promise<void> {
    const requestId = this.nextRequestId++;
    await this.request(requestId, {
      type: "terminate_process",
      requestId,
      pid,
      status,
    });
    // Resolve exit promise
    const resolver = this.exitResolvers.get(pid);
    this.exitResolvers.delete(pid);
    if (resolver) resolver.resolve(status);
  }

  /**
   * Read a file out of the kernel-owned VFS from the main thread. Returns the
   * bytes, or `null` if the path does not exist / is not readable. This is the
   * readback path for collecting artifacts a process wrote; the main thread
   * never receives the live VFS SharedArrayBuffer.
   */
  async readFileFromVfs(path: string): Promise<Uint8Array | null> {
    const requestId = this.nextRequestId++;
    const result = await this.request(requestId, {
      type: "read_vfs_file",
      requestId,
      path,
    });
    return (result as Uint8Array | null) ?? null;
  }

  /**
   * Read a file and its permission bits from the worker-owned VFS. This is
   * useful for callers that temporarily replace a path between process spawns
   * and must restore the exact prior state afterward.
   */
  async readFileSnapshotFromVfs(path: string): Promise<VfsFileSnapshot | null> {
    const requestId = this.nextRequestId++;
    const result = await this.request(requestId, {
      type: "read_vfs_file",
      requestId,
      path,
      includeMode: true,
    });
    return (result as VfsFileSnapshot | null) ?? null;
  }

  /**
   * Create or replace a regular file in the worker-owned VFS. The mutation is
   * performed by the kernel worker, preserving exclusive VFS ownership. The
   * parent directory must already exist, and callers must coordinate access
   * with guest processes that may use the same path.
   */
  async writeFileToVfs(
    path: string,
    data: Uint8Array,
    mode = 0o644,
  ): Promise<void> {
    const requestId = this.nextRequestId++;
    const owned = data.slice();
    await this.request(requestId, {
      type: "write_vfs_file",
      requestId,
      path,
      data: owned,
      mode: mode & FILE_MODES.S_MODE_BITS,
    }, [owned.buffer]);
  }

  /**
   * Remove a path from the worker-owned VFS between process spawns. Returns
   * false when the path did not exist.
   */
  async unlinkFileFromVfs(path: string): Promise<boolean> {
    const requestId = this.nextRequestId++;
    const result = await this.request(requestId, {
      type: "unlink_vfs_file",
      requestId,
      path,
    });
    return result === true;
  }

  /**
   * Serialize the quiescent worker-owned root filesystem for a later boot.
   * The root image is durable; boot-scoped scratch and device mounts are not.
   * Callers must wait for every guest process to exit before invoking this.
   */
  async exportRootfsImage(): Promise<Uint8Array> {
    if (!this.initialized) {
      throw new Error("rootfs export requires an initialized kernel");
    }
    const requestId = this.nextRequestId++;
    const result = await this.request(requestId, {
      type: "export_rootfs_image",
      requestId,
    });
    if (!(result instanceof Uint8Array)) {
      throw new Error("kernel worker returned an invalid rootfs image");
    }
    return result;
  }

  /** Destroy the kernel and release all resources. */
  async destroy(): Promise<void> {
    if (!this.workerStarted) return;
    let gracefulDetachFailure: string | undefined;
    if (this.initialized && this.kernelFatalError === null) {
      const requestId = this.nextRequestId++;
      gracefulDetachFailure = await awaitGracefulKernelRealmDestroy(
        () =>
          this.request(requestId, {
            type: "destroy",
            requestId,
          }),
        DESTROY_REQUEST_TIMEOUT_MS,
      );
    }
    this.initialized = false;
    await this.pcmDriver?.settleOutputPipeline().catch(() => {});
    await this.pcmDriver?.close().catch(() => {});
    this.pcmDriver = null;
    this.pcmTransport = null;
    // WHY: process/pthread Workers are owned beneath the kernel worker. After
    // the worker's bounded graceful attempt, terminating this outer realm is
    // the final release fence for aliases that could not be detached exactly.
    let realmTerminationFailure: string | undefined;
    try {
      this.kernelWorkerHandle.terminate();
    } catch (error) {
      realmTerminationFailure =
        "kernel-worker realm termination failed: " +
        (error instanceof Error ? error.message : String(error));
    }
    this.workerStarted = false;
    this.exitResolvers.clear();
    this.unclaimedExitStatuses.clear();
    this.pendingRequests.clear();
    this.ptyOutputCallbacks.clear();
    this.options.onHttpBridgePendingRequests?.(0);
    this.lazyDownloadListeners.clear();
    // Release every main-thread reference to shared buffers this kernel held.
    // `fbMemoryByPid`/`framebuffers` retain typed-array views over process
    // `WebAssembly.Memory` (up to 1 GiB max each) posted from the worker for
    // framebuffer demos; `pendingPtyOutput` holds buffered PTY chunks. On
    // WebKit these are reclaimed only when the page drops them — terminating
    // the worker does not, because the main thread is a co-owner. Leaving
    // them set makes reclamation depend on the whole BrowserKernel being GC'd
    // (and pins the memory outright if anything still references this kernel).
    this.fbMemoryByPid.clear();
    this.fbGenerationByPid.clear();
    this.framebuffers.clear();
    this.pendingPtyOutput.clear();
    this.pendingPtyOutputBytes = 0;
    this.pendingPtyOutputChunks = 0;
    this.pendingPtyOutputFailure = undefined;
    if (gracefulDetachFailure || realmTerminationFailure) {
      const diagnostic: HostDiagnostic = {
        pid: 0,
        source: "kernel worker destroy",
        message:
          `[BrowserKernel] ${
            [gracefulDetachFailure, realmTerminationFailure]
              .filter((failure): failure is string => Boolean(failure))
              .join("; ")
          }` +
          (realmTerminationFailure
            ? ""
            : "; terminated the worker realm as the final release fallback"),
      };
      console.warn(diagnostic.message);
      try {
        this.options.onHostDiagnostic?.(diagnostic);
      } catch (error) {
        console.error(
          "[BrowserKernel] onHostDiagnostic callback failed:",
          error,
        );
      }
    }
  }

  // ── Private helpers ──

  /** Ensure SSL cert env vars select the image-owned platform trust bundle.
   *  OpenSSL's configured directory is `/etc/ssl`; browser sessions replace
   *  only this CA-bundle path with their ephemeral MITM root. */
  private mergeEnv(env: string[]): string[] {
    const sslVars = [
      "SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt",
      "SSL_CERT_DIR=/etc/ssl/certs",
    ];
    const result = [...env];
    for (const v of sslVars) {
      const key = v.split("=")[0];
      if (!result.some(e => e.startsWith(key + "="))) {
        result.push(v);
      }
    }
    return result;
  }

  /** Diagnostic: turn on per-(pid, syscall_nr) timing aggregation in the
   *  kernel worker. Call sysprofDump() afterward to print and reset. */
  sysprofStart(): void {
    this.kernelWorkerHandle.postMessage({ type: "sysprof_start" } as unknown as MainToKernelMessage, []);
  }
  sysprofDump(): void {
    this.kernelWorkerHandle.postMessage({ type: "sysprof_dump" } as unknown as MainToKernelMessage, []);
  }
  pidMapDump(): void {
    this.kernelWorkerHandle.postMessage({ type: "pid_map_dump" } as unknown as MainToKernelMessage, []);
  }

  private sendToKernel(msg: MainToKernelMessage, transfer?: Transferable[]): void {
    if (this.kernelFatalError !== null) throw this.kernelFatalError;
    this.kernelWorkerHandle.postMessage(msg, transfer ?? []);
  }

  private claimExitStatus(pid: number, spawnStartedBeforeExitSequence: number): Promise<number> {
    const unclaimed = this.unclaimedExitStatuses.get(pid);
    this.unclaimedExitStatuses.delete(pid);
    if (unclaimed !== undefined && unclaimed.sequence > spawnStartedBeforeExitSequence) {
      return Promise.resolve(unclaimed.status);
    }
    return new Promise<number>((resolve, reject) => {
      if (this.kernelFatalError !== null) {
        reject(this.kernelFatalError);
        return;
      }
      this.exitResolvers.set(pid, { resolve, reject });
    });
  }

  private request(requestId: number, msg: MainToKernelMessage, transfer?: Transferable[]): Promise<any> {
    return new Promise((resolve, reject) => {
      if (this.kernelFatalError !== null) {
        reject(this.kernelFatalError);
        return;
      }
      this.pendingRequests.set(requestId, { resolve, reject });
      this.sendToKernel(msg, transfer);
    });
  }

  private failKernelHost(error: Error): void {
    if (this.kernelFatalError !== null) return;
    this.kernelFatalError = error;
    for (const { reject } of this.pendingRequests.values()) reject(error);
    this.pendingRequests.clear();
    for (const { reject } of this.exitResolvers.values()) reject(error);
    this.exitResolvers.clear();
  }

  private emitLazyDownload(event: LazyDownloadEvent): void {
    try { this.options.onLazyDownload?.(event); } catch { /* host callbacks should not break delivery */ }
    for (const cb of this.lazyDownloadListeners) {
      try { cb(event); } catch { /* listener errors don't break the loop */ }
    }
  }

  private handleWorkerMessage(msg: KernelToMainMessage): void {
    switch (msg.type) {
      case "ready": {
        if (msg.pcmTransport) {
          this.pcmTransport = msg.pcmTransport;
          if (
            typeof globalThis.AudioContext === "function" ||
            "webkitAudioContext" in globalThis
          ) {
            void this.prepareAudio().catch((error) => {
              this.options.onHostDiagnostic?.({
                pid: 0,
                source: "browser PCM output",
                message: error instanceof Error ? error.message : String(error),
              });
            });
          }
        }
        break;
      }
      case "init_error":
        // The temporary boot listener resolves or rejects initialization. The
        // permanent listener also receives this message, so account for it.
        break;
      case "kernel_fatal": {
        const error = new Error(`Kernel worker failed: ${msg.error}`);
        this.failKernelHost(error);
        this.options.onHttpBridgePendingRequests?.(0);
        this.kernelWorkerHandle.terminate();
        break;
      }
      case "response": {
        const pending = this.pendingRequests.get(msg.requestId);
        if (pending) {
          this.pendingRequests.delete(msg.requestId);
          if (msg.error) {
            pending.reject(new Error(msg.error));
          } else {
            pending.resolve(msg.result);
          }
        }
        break;
      }
      case "exit": {
        // WHY: a crashing process may never run munmap/close and therefore
        // never emit fb_unbind. Drop the main-thread structured-clone Memory
        // and cached typed views at the authoritative process-exit boundary.
        this.releaseProcessFramebuffer(msg.pid, msg.generation);
        const resolver = this.exitResolvers.get(msg.pid);
        if (resolver) {
          this.exitResolvers.delete(msg.pid);
          resolver.resolve(msg.status);
        } else {
          this.unclaimedExitStatuses.set(msg.pid, {
            status: msg.status,
            sequence: ++this.exitSequence,
          });
          while (this.unclaimedExitStatuses.size > 256) {
            const oldest = this.unclaimedExitStatuses.keys().next().value;
            if (oldest === undefined) break;
            this.unclaimedExitStatuses.delete(oldest);
          }
        }
        this.options.onProcessEvent?.({ kind: "exit", pid: msg.pid, exitStatus: msg.status });
        break;
      }
      case "proc_event": {
        // fork / exec / posix_spawn happened inside the kernel — these
        // don't come through BrowserKernel.spawn(), so the worker posts
        // them directly. Exit is delivered separately via the existing
        // "exit" message above.
        const event = msg.kind === "spawn"
          ? { kind: msg.kind, pid: msg.pid, ppid: msg.ppid }
          : { kind: msg.kind, pid: msg.pid };
        this.options.onProcessEvent?.(event);
        break;
      }
      case "http_bridge_pending":
        this.options.onHttpBridgePendingRequests?.(msg.count);
        break;
      case "stdout":
        this.options.onStdout?.(msg.data);
        this.options.onProcessStdout?.(msg.pid, msg.data);
        break;
      case "stderr":
        this.options.onStderr?.(msg.data);
        this.options.onProcessStderr?.(msg.pid, msg.data);
        break;
      case "host_diagnostic": {
        this.options.onHostDiagnostic?.({
          pid: msg.pid,
          source: msg.source,
          message: msg.message,
          ...(msg.status === undefined ? {} : { status: msg.status }),
        });
        break;
      }
      case "pty_output": {
        const cb = this.ptyOutputCallbacks.get(msg.pid);
        if (cb) {
          cb(msg.data);
        } else if (!this.pendingPtyOutputFailure) {
          // Buffer until onPtyOutput registers a callback (race window
          // between worker starting the process and main thread wiring
          // the handler in boot()).
          if (
            !Number.isSafeInteger(msg.pid) ||
            msg.pid < 0 ||
            !(msg.data instanceof Uint8Array)
          ) {
            this.pendingPtyOutput.clear();
            this.pendingPtyOutputBytes = 0;
            this.pendingPtyOutputChunks = 0;
            this.pendingPtyOutputFailure = new Error(
              "kernel worker emitted malformed pre-listener PTY output",
            );
            break;
          }
          if (msg.data.byteLength === 0) break;
          if (
            this.pendingPtyOutputBytes + msg.data.byteLength >
              MAX_PENDING_PTY_OUTPUT_BYTES ||
            this.pendingPtyOutputChunks + 1 > MAX_PENDING_PTY_OUTPUT_CHUNKS
          ) {
            const limit =
              this.pendingPtyOutputBytes + msg.data.byteLength >
              MAX_PENDING_PTY_OUTPUT_BYTES
                ? `${MAX_PENDING_PTY_OUTPUT_BYTES}-byte`
                : `${MAX_PENDING_PTY_OUTPUT_CHUNKS}-chunk`;
            this.pendingPtyOutput.clear();
            this.pendingPtyOutputBytes = 0;
            this.pendingPtyOutputChunks = 0;
            this.pendingPtyOutputFailure = new Error(
              `PTY output exceeded the ${limit} pre-listener limit`,
            );
            break;
          }
          let buf = this.pendingPtyOutput.get(msg.pid);
          if (!buf) {
            buf = [];
            this.pendingPtyOutput.set(msg.pid, buf);
          }
          buf.push(msg.data);
          this.pendingPtyOutputBytes += msg.data.byteLength;
          this.pendingPtyOutputChunks += 1;
        }
        break;
      }
      case "listen_tcp":
        this.options.onListenTcp?.(msg.pid, msg.fd, msg.port);
        break;
      case "fb_bind":
        {
          const observed = this.fbGenerationByPid.get(msg.pid);
          if (
            observed
            && (
              observed.generation > msg.generation
              || (
                observed.generation === msg.generation
                && observed.released
              )
            )
          ) {
            break;
          }
        }
        this.fbGenerationByPid.set(msg.pid, {
          generation: msg.generation,
          released: false,
        });
        this.fbMemoryByPid.set(msg.pid, {
          generation: msg.generation,
          memory: msg.memory,
        });
        this.framebuffers.bind({
          pid: msg.pid,
          addr: msg.addr,
          len: msg.len,
          w: msg.w,
          h: msg.h,
          stride: msg.stride,
          fmt: msg.fmt,
        });
        break;
      case "fb_unbind":
        this.unbindProcessFramebuffer(msg.pid, msg.generation);
        break;
      case "fb_rebind_memory": {
        const binding = this.fbMemoryByPid.get(msg.pid);
        if (!binding || binding.generation !== msg.generation) break;
        this.fbMemoryByPid.set(msg.pid, {
          generation: msg.generation,
          memory: msg.memory,
        });
        this.framebuffers.rebindMemory(msg.pid);
        break;
      }
      case "fb_write":
        if (
          this.fbMemoryByPid.get(msg.pid)?.generation !== msg.generation
        ) {
          break;
        }
        this.framebuffers.fbWrite(msg.pid, msg.offset, msg.bytes);
        break;
      case "fb_release_generation":
        // WHY: the worker's process/threads can be quiescent while this realm
        // still owns a structured-clone Memory wrapper. Delete only the exact
        // generation, then acknowledge that browser-main ownership is gone.
        // See docs/measurements/2026-07-28-process-memory-retirement-rss.md.
        this.releaseProcessFramebuffer(msg.pid, msg.generation);
        this.sendToKernel({
          type: "fb_release_generation_ack",
          requestId: msg.requestId,
        });
        break;
      case "fb_forget_generation":
        this.forgetReleasedFramebufferGeneration(
          msg.pid,
          msg.generation,
        );
        break;
      case "lazy_download":
        this.emitLazyDownload(msg.event);
        break;
      default: {
        // Keep this dispatch coupled to KernelToMainMessage as the protocol
        // grows. Runtime values still originate outside TypeScript, so make a
        // malformed/unknown worker message visible instead of dropping it.
        const exhaustive: never = msg;
        void exhaustive;
        console.error(
          `[BrowserKernel] unknown kernel-worker message type: ${String((msg as { type?: unknown }).type)}`,
        );
        break;
      }
    }
  }

  /**
   * Return the wasm `Memory` for the framebuffer-bound process. Used by
   * the canvas renderer to build typed-array views over the bound
   * region. A caller that retains this wrapper becomes an owner outside
   * BrowserKernel's release-acknowledgement contract.
   */
  getProcessMemory(pid: number): WebAssembly.Memory | undefined {
    return this.fbMemoryByPid.get(pid)?.memory;
  }

  private unbindProcessFramebuffer(pid: number, generation: number): void {
    const binding = this.fbMemoryByPid.get(pid);
    if (binding && binding.generation !== generation) return;
    this.fbMemoryByPid.delete(pid);
    this.framebuffers.unbind(pid);
  }

  private releaseProcessFramebuffer(pid: number, generation: number): void {
    const observed = this.fbGenerationByPid.get(pid);
    if (!observed || observed.generation <= generation) {
      this.fbGenerationByPid.set(pid, {
        generation,
        released: true,
      });
    }
    this.unbindProcessFramebuffer(pid, generation);
  }

  private forgetReleasedFramebufferGeneration(
    pid: number,
    generation: number,
  ): void {
    const observed = this.fbGenerationByPid.get(pid);
    if (
      observed?.generation === generation
      && observed.released
      && this.fbMemoryByPid.get(pid)?.generation !== generation
    ) {
      this.fbGenerationByPid.delete(pid);
    }
  }
}
