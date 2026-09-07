/**
 * Test helper for running Wasm programs via CentralizedKernelWorker.
 *
 * By default, runs the kernel in a dedicated worker_thread via NodeKernelHost
 * for optimal performance. Falls back to main-thread mode when a custom
 * PlatformIO is provided (PlatformIO can't be serialized across threads).
 */
import { readFileSync, existsSync, mkdtempSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { CAPTURED_STDIO, CentralizedKernelWorker } from "../src/kernel-worker";
import { resolveBinary } from "../src/binary-resolver";
import { NodePlatformIO } from "../src/platform/node";
import { NodeWorkerAdapter } from "../src/worker-adapter";
import { ThreadPageAllocator } from "../src/thread-allocator";
import { detectPtrWidth, extractHeapBase, PAGES_PER_THREAD, WASM_PAGE_SIZE } from "../src/constants";
import {
  computeProcessMemoryLayout,
  createProcessMemory,
  type ProcessMemoryLayout,
} from "../src/process-memory";
import {
  NodeKernelHost,
  resolveRootfsArtifact,
} from "../src/node-kernel-host";
import { MemoryFileSystem } from "../src/vfs/memory-fs";
import {
  ensureDirRecursive,
  writeVfsBinary,
} from "../src/vfs/image-helpers";
import {
  ForkHostImportOwnerRuntime,
  type ForkHostImportOwnerWorker,
} from "../src/fork-host-import-runtime";
import { ForkExternrefProcessOwner } from "../src/fork-externref-process-owner";
import {
  ForkReplayGateCoordinator,
  observeForkReplayWorker,
} from "../src/fork-replay-gate";
import type { ForkExternrefGeneration } from "../src/fork-reference-broker";
import type { HostDiagnostic } from "../src/host-diagnostic";
import type { CentralizedWorkerInitMessage, CentralizedThreadInitMessage, WorkerToHostMessage } from "../src/worker-protocol";
import type { PlatformIO } from "../src/types";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Create a fresh host temp directory that the in-kernel tmpfs never claims.
 *
 * The in-kernel tmpfs (Phase 5 cutover) is the unconditional authority for its
 * scratch prefixes (`/tmp`, `/var/tmp`, `/var/log`, `/var/run`, `/home/maker`,
 * `/root`, `/srv`). `os.tmpdir()` frequently resolves under `/tmp` (the nix dev
 * shell sets `TMPDIR=/tmp/nix-shell.*`, and Linux defaults to `/tmp`), so a
 * kernel-routed guest open of a path there is served by the empty in-kernel
 * tmpfs, not the host directory. Tests that need the guest to reach a real host
 * file through `NodePlatformIO` must therefore stage it outside every scratch
 * prefix. `<repoRoot>/target` is git-ignored and never a scratch prefix, so it
 * gives raw host-filesystem coverage on every platform. Callers own cleanup.
 */
export function makeHostScratchTempRoot(prefix: string): string {
  const base = join(__dirname, "../..", "target", "host-fs-test-scratch");
  mkdirSync(base, { recursive: true });
  return mkdtempSync(join(base, prefix));
}

const MAX_PAGES = 16384;
const SIGSEGV = 11;
const CH_TOTAL_SIZE = 72 + 65536;

function createSharedProcessMemory(
  ptrWidth: 4 | 8,
  initialPages: number,
  maximumPages: number,
): WebAssembly.Memory {
  if (ptrWidth === 8) {
    return new WebAssembly.Memory({
      initial: BigInt(initialPages) as any,
      maximum: BigInt(maximumPages) as any,
      shared: true,
      address: "i64",
    } as any);
  }
  return new WebAssembly.Memory({
    initial: initialPages,
    maximum: maximumPages,
    shared: true,
  });
}

function threadAllocatorForLayout(
  layout: ProcessMemoryLayout,
  ptrWidth: 4 | 8,
  reserveSlotStartPage?: () => number,
): ThreadPageAllocator {
  return new ThreadPageAllocator({
    firstBasePage: layout.firstThreadBasePage,
    maxPageExclusive: layout.threadArenaEndPage,
    ptrWidth,
    reservedSlots: layout.threadSlotCount,
    reserveSlotStartPage,
  });
}

function createFreshProcessMemory(
  programBytes: ArrayBuffer,
  ptrWidth: 4 | 8,
  reserveSlotStartPage?: () => number,
  maximumPages: number = MAX_PAGES,
): {
  memory: WebAssembly.Memory;
  layout: ProcessMemoryLayout;
  threadAllocator: ThreadPageAllocator;
} {
  const heapBase = extractHeapBase(programBytes);
  const layout = computeProcessMemoryLayout({
    maxPages: maximumPages,
    ptrWidth,
    programBytes,
    heapBase,
  });
  const memory = createProcessMemory(ptrWidth, layout);
  new Uint8Array(memory.buffer, layout.channelOffset, CH_TOTAL_SIZE).fill(0);
  return {
    memory,
    layout,
    threadAllocator: threadAllocatorForLayout(layout, ptrWidth, reserveSlotStartPage),
  };
}

function loadKernelWasm(): ArrayBuffer {
  const buf = readFileSync(resolveBinary("kernel.wasm"));
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

function loadProgramWasm(path: string): ArrayBuffer {
  const buf = readFileSync(path);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

/** Proxy for sending stdin data to the kernel when it runs in a worker_thread */
export interface KernelStdinProxy {
  appendStdinData(pid: number, data: Uint8Array): void;
}

export interface RunProgramOptions {
  /** Path to the .wasm program file */
  programPath: string;
  /** Optional pre-compiled module for programPath. */
  programModule?: WebAssembly.Module;
  /**
   * Explicit path to the kernel `.wasm` to boot. When omitted the kernel is
   * resolved through the binary resolver. Build-time callers (e.g. package
   * recipes running under the scrubbed source-only resolver, where the
   * projection root is intentionally unavailable) pass the kernel they
   * declared as a build dependency so they never depend on projection state.
   */
  kernelWasmPath?: string;
  /** Environment variables as KEY=VALUE strings */
  env?: string[];
  /** Program arguments */
  argv?: string[];
  /** Initial real/effective user ID. */
  uid?: number;
  /** Initial real/effective group ID. */
  gid?: number;
  /** Timeout in ms (default: 30000) */
  timeout?: number;
  /** Process memory ceiling for bounded allocation-failure tests. */
  maxPages?: number;
  /** Aggregate process-memory admission budget for allocation-path tests. */
  maxProcessMemoryBytes?: number;
  /** Custom PlatformIO (defaults to NodePlatformIO).
   *  When provided, forces main-thread mode (PlatformIO can't be serialized). */
  io?: PlatformIO;
  /** Attach `TcpNetworkBackend` inside the kernel worker_thread so wasm
   *  programs can dial external hosts via real Node sockets. Worker-thread
   *  mode only — incompatible with `io`. */
  enableTcpNetwork?: boolean;
  /**
   * Map of virtual path → .wasm file path staged into the test rootfs for
   * exact-target exec. The map also remains available to spawn preflight.
   */
  execPrograms?: Map<string, string>;
  /** Data to provide on stdin (process will see EOF after this data) */
  stdin?: string;
  /** Binary data to provide on stdin (alternative to stdin string) */
  stdinBytes?: Uint8Array;
  /** Callback invoked after the process starts.
   *  Use this to call appendStdinData() for interactive stdin testing. */
  onStarted?: (kernelProxy: KernelStdinProxy, pid: number) => void | Promise<void>;
  /**
   * Main-thread harness hook invoked after process registration but before its
   * Worker starts. Supplying this forces main-thread mode so tests can attach
   * host devices that need direct access to `CentralizedKernelWorker` while
   * retaining the production-equivalent pthread/fork/exec worker wiring.
   */
  onKernelReady?: (
    kernelWorker: CentralizedKernelWorker,
    pid: number,
  ) => void | Promise<void>;
  /** If `true`, the helper queries `kernel_get_fork_count(pid)` whenever
   *  the running program creates a guest child and surfaces those live-parent
   *  snapshots on `RunProgramResult.forkCountSamples`. Used by the
   *  non-forking-spawn regression tests. Worker-thread mode uses live samples;
   *  main-thread fixtures still return the final value as `forkCount`. */
  captureForkCount?: boolean;
  /** Capture kernel-owned large-spawn retention and memory pages immediately
   * after program exit, before the dedicated kernel worker is destroyed. */
  captureSpawnScratchStats?: boolean;
  /** Use the canonical rootfs image in worker-thread mode. Defaults to true. */
  useDefaultRootfs?: boolean;
  /** Exact VFS image for tests that stage package runtime files. Overrides
   * `useDefaultRootfs`; omitted means the canonical image. */
  rootfsImage?: "default" | ArrayBuffer | Uint8Array;
  /** Exact kernel wasm to boot (worker-thread mode). Omitted resolves the
   * kernel through the normal binary resolver. A caller that already holds
   * the kernel artifact — e.g. a build-time step that cannot rely on the
   * source-only program projection — passes it here to avoid resolution. */
  kernelWasmBytes?: ArrayBuffer | Uint8Array;
  /** Observe process lifecycle events emitted by NodeKernelHost. Worker-thread mode only. */
  onProcessEvent?: (event: {
    kind: "spawn" | "exec" | "exit";
    pid: number;
    ppid?: number;
    exitStatus?: number;
  }) => void;
  /**
   * Phase 6 D6.5: register owner-side fork host-import handlers (e.g. a
   * broker-backed `env.get_ext` / `env.check_ext`) before any Worker is created,
   * so a test-provided HOST externref becomes broker-tracked and survives a real
   * fork through the `wpk_fork_host` / `host_resolve_externref` seam. Supplying
   * this forces main-thread mode (the test helper owns the
   * `ForkHostImportOwnerRuntime` there) and makes the child fork Worker's
   * `fork_module_references` proof-of-use surface on
   * `RunProgramResult.hostDiagnostics`, mirroring the Node/browser worker
   * entries. The registrar runs once, before the process main Worker, while the
   * catalog is still unsealed.
   */
  forkHostImportRegistrar?: (owner: ForkHostImportOwnerRuntime) => void;
}

export interface RunProgramResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** Host-owned lifecycle/protocol diagnostics, never guest fd 2 bytes. */
  hostDiagnostics: HostDiagnostic[];
  /** Raw stdout bytes (for binary output like compressed data) */
  stdoutBytes: Uint8Array;
  /** Per-process fork-counter snapshots captured after guest child-creation
   *  events while the worker-hosted parent still exists. Only populated when
   *  `captureForkCount: true` is set in worker-thread mode. */
  forkCountSamples?: bigint[];
  /** Final fork counter captured before main-thread-mode teardown. Main-thread
   *  test fixtures do not use the production host-owned reaping path. */
  forkCount?: bigint;
  spawnScratchCapacity?: number;
  kernelMemoryPages?: number;
}

/**
 * Phase 6 D5: resolve, compile (once per width), and package the co-resident
 * `fork-module` init fields, mirroring what the kernel host ships. The module is
 * the UNCONDITIONAL fork reconstructor, so it is always shipped — exactly as the
 * production kernel host does.
 */
const forkModuleModuleByWidth = new Map<4 | 8, WebAssembly.Module>();
function centralizedForkModuleFields(
  ptrWidth: 4 | 8,
): { forkModuleModule: WebAssembly.Module } {
  let mod = forkModuleModuleByWidth.get(ptrWidth);
  if (!mod) {
    const name = `fork_module${ptrWidth === 8 ? 64 : 32}.wasm`;
    mod = new WebAssembly.Module(readFileSync(resolveBinary(name)));
    forkModuleModuleByWidth.set(ptrWidth, mod);
  }
  return { forkModuleModule: mod };
}

/**
 * Run a Wasm program using the shared-kernel architecture.
 *
 * By default, spawns the kernel in a dedicated worker_thread for optimal
 * syscall throughput. Falls back to main-thread mode when `options.io` is
 * provided (custom PlatformIO instances can't be serialized across threads).
 */
export async function runCentralizedProgram(
  options: RunProgramOptions,
): Promise<RunProgramResult> {
  if (options.io || options.onKernelReady || options.forkHostImportRegistrar) {
    return runOnMainThread(options);
  }
  return runInWorkerThread(options);
}

// ---------------------------------------------------------------------------
// Worker-thread mode (default, fast path) — uses NodeKernelHost
// ---------------------------------------------------------------------------

async function runInWorkerThread(options: RunProgramOptions): Promise<RunProgramResult> {
  const programBytes = loadProgramWasm(options.programPath);
  const timeout = options.timeout ?? 30_000;

  let stdout = "";
  let stderr = "";
  const hostDiagnostics: HostDiagnostic[] = [];
  const stdoutChunks: Uint8Array[] = [];
  let capturedPid: number | undefined;
  const forkCountSamplePromises: Promise<bigint>[] = [];

  // Convert execPrograms Map to plain object for the worker
  let execPrograms: Record<string, string> | undefined;
  if (options.execPrograms) {
    execPrograms = {};
    for (const [k, v] of options.execPrograms) {
      execPrograms[k] = v;
    }
  }

  const rootfsImage = await prepareExecTargetTestRootfs(options);

  // Prepare stdin
  let stdinData: Uint8Array | undefined;
  if (options.stdinBytes != null) {
    stdinData = options.stdinBytes;
  } else if (options.stdin != null) {
    stdinData = new TextEncoder().encode(options.stdin);
  } else if (!options.onStarted) {
    stdinData = new Uint8Array();
  }

  // Default to mount-based VFS (rootfs.vfs at /, scratch dirs at /tmp etc.).
  // Tests that need raw host filesystem access opt out by passing
  // `io: new NodePlatformIO()` (which routes through `runOnMainThread` and
  // does not engage NodeKernelHost at all).
  const host = new NodeKernelHost({
    maxWorkers: 4,
    maxPages: options.maxPages,
    maxProcessMemoryBytes: options.maxProcessMemoryBytes,
    execPrograms,
    rootfsImage,
    enableTcpNetwork: options.enableTcpNetwork,
    onStdout: (_pid: number, data: Uint8Array) => {
      stdout += new TextDecoder().decode(data);
      stdoutChunks.push(new Uint8Array(data));
    },
    onStderr: (_pid: number, data: Uint8Array) => {
      stderr += new TextDecoder().decode(data);
    },
    onHostDiagnostic: (diagnostic) => {
      hostDiagnostics.push(diagnostic);
    },
    onProcessEvent: (event) => {
      // A top-level host spawn has event.pid === capturedPid (or arrives
      // before onStarted captures it). Every other spawn is a guest child.
      // Snapshot the monotonic parent counter now: host-owned top-level
      // processes are correctly reaped before a post-exit query is reliable.
      if (
        options.captureForkCount &&
        capturedPid !== undefined &&
        event.kind === "spawn" &&
        event.pid !== capturedPid
      ) {
        forkCountSamplePromises.push(host.getForkCount(capturedPid));
      }
      options.onProcessEvent?.(event);
    },
  });

  let kernelInitBytes: ArrayBuffer | undefined;
  if (options.kernelWasmBytes !== undefined) {
    const src = options.kernelWasmBytes;
    if (src instanceof Uint8Array) {
      // Copy into a fresh, non-shared ArrayBuffer: the source may be a Buffer
      // view over a larger/pooled (or shared) allocation, which the worker
      // init protocol does not accept.
      const out = new ArrayBuffer(src.byteLength);
      new Uint8Array(out).set(src);
      kernelInitBytes = out;
    } else {
      kernelInitBytes = src;
    }
  }
  await host.init(kernelInitBytes);

  // Capture the spawned pid so child process events can sample its
  // kernel-side fork_count. The user-supplied onStarted (if any) still runs.
  const onStartedWrapper = (pid: number) => {
    capturedPid = pid;
    if (!options.onStarted) return;
    const proxy: KernelStdinProxy = {
      appendStdinData(stdinPid: number, data: Uint8Array) {
        host.appendStdinData(stdinPid, data);
      },
    };
    return options.onStarted(proxy, pid);
  };

  const exitPromise = host.spawn(programBytes, options.argv ?? [options.programPath], {
    env: options.env,
    uid: options.uid,
    gid: options.gid,
    stdin: stdinData,
    programModule: options.programModule,
    onStarted: onStartedWrapper,
  });

  // Race spawn exit against timeout
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(
      () => reject(new Error(`Program timed out after ${timeout}ms`)),
      timeout,
    );
  });

  let exitCode: number;
  let forkCountSamples: bigint[] | undefined;
  let spawnScratchCapacity: number | undefined;
  let kernelMemoryPages: number | undefined;
  try {
    exitCode = await Promise.race([exitPromise, timeoutPromise]);
    if (options.captureForkCount) {
      forkCountSamples = await Promise.all(forkCountSamplePromises);
      if (forkCountSamples.length === 0) {
        throw new Error("captureForkCount observed no guest child creation");
      }
    }
    if (options.captureSpawnScratchStats) {
      spawnScratchCapacity = await host.getSpawnScratchCapacity();
      kernelMemoryPages = await host.getKernelMemoryPages();
    }
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
    await host.destroy().catch(() => {});
  }

  const totalLen = stdoutChunks.reduce((sum, c) => sum + c.length, 0);
  const stdoutBytes = new Uint8Array(totalLen);
  let offset = 0;
  for (const chunk of stdoutChunks) {
    stdoutBytes.set(chunk, offset);
    offset += chunk.length;
  }

  return {
    exitCode,
    stdout,
    stderr,
    hostDiagnostics,
    stdoutBytes,
    forkCountSamples,
    spawnScratchCapacity,
    kernelMemoryPages,
  };
}

async function prepareExecTargetTestRootfs(
  options: RunProgramOptions,
): Promise<"default" | ArrayBuffer | Uint8Array | undefined> {
  const configured = options.rootfsImage
    ?? (options.useDefaultRootfs === false ? undefined : "default");
  if (!options.execPrograms || options.execPrograms.size === 0) {
    return configured;
  }

  let rootfs: MemoryFileSystem;
  if (configured === undefined) {
    let programBytes = 0;
    for (const hostPath of options.execPrograms.values()) {
      programBytes += readFileSync(hostPath).byteLength;
    }
    const unalignedCapacity = Math.max(
      4 * 1024 * 1024,
      programBytes + 1024 * 1024,
    );
    const capacity = Math.ceil(unalignedCapacity / 4) * 4;
    if (!Number.isSafeInteger(capacity)) {
      throw new Error("test exec target rootfs capacity overflows");
    }
    rootfs = MemoryFileSystem.create(new SharedArrayBuffer(capacity));
  } else {
    const image = configured === "default"
      ? new Uint8Array(readFileSync(resolveRootfsArtifact().selectedPath))
      : configured instanceof Uint8Array
        ? configured
        : new Uint8Array(configured);
    rootfs = MemoryFileSystem.fromImagePreservingCapacity(image);
  }

  for (const [path, hostPath] of options.execPrograms) {
    if (!path.startsWith("/") || path.includes("\0")) {
      throw new Error(`test exec target is not an absolute guest path: ${path}`);
    }
    ensureDirRecursive(rootfs, dirname(path));
    writeVfsBinary(rootfs, path, new Uint8Array(readFileSync(hostPath)), 0o755);
  }
  return rootfs.saveImage();
}

// ---------------------------------------------------------------------------
// Main-thread mode (fallback for custom PlatformIO)
// ---------------------------------------------------------------------------

interface ForkReplayContext {
  fnPtr: number;
  argPtr: number;
  forkBufAddr: number;
}

async function runOnMainThread(options: RunProgramOptions): Promise<RunProgramResult> {
  const kernelWasmBytes = loadKernelWasm();
  const programBytes = loadProgramWasm(options.programPath);
  const timeout = options.timeout ?? 30_000;
  const ptrWidth = detectPtrWidth(programBytes);

  let stdout = "";
  let stderr = "";
  const stdoutChunks: Uint8Array[] = [];
  const workers = new Map<number, ReturnType<NodeWorkerAdapter["createWorker"]>>();

  const io = options.io ?? new NodePlatformIO();
  const workerAdapter = new NodeWorkerAdapter();

  let resolveExit: (status: number) => void;
  let rejectExit: (err: Error) => void;
  const exitPromise = new Promise<number>((resolve, reject) => {
    resolveExit = resolve;
    rejectExit = reject;
  });

  const processProgramBytes = new Map<number, ArrayBuffer>();
  const processMemories = new Map<number, WebAssembly.Memory>();
  const processLayouts = new Map<number, ProcessMemoryLayout>();
  const threadAllocators = new Map<number, ThreadPageAllocator>();
  const processPtrWidths = new Map<number, 4 | 8>();
  const forkReplayContexts = new Map<number, ForkReplayContext>();
  const externrefProcessOwner = new ForkExternrefProcessOwner();
  const forkHostImportOwnerRuntime =
    new ForkHostImportOwnerRuntime(externrefProcessOwner);
  // Phase 6 D6.5: let a test register broker-backed owner host imports (e.g.
  // `env.get_ext` / `env.check_ext`) while the catalog is still unsealed, before
  // any Worker is created. This is how a genuine HOST externref becomes
  // broker-tracked so it survives a real fork through the `host_resolve_externref`
  // seam.
  options.forkHostImportRegistrar?.(forkHostImportOwnerRuntime);
  // Capture the co-resident fork-module's per-kind reference proof-of-use posted
  // by a fork CHILD Worker, mirroring how the Node/browser worker entries forward
  // it as a `fork-module` host diagnostic. Main-thread mode otherwise returns no
  // host diagnostics.
  const mainThreadHostDiagnostics: HostDiagnostic[] = [];
  const recordForkModuleReferences = (
    forPid: number,
    message: Extract<WorkerToHostMessage, { type: "fork_module_references" }>,
  ): void => {
    mainThreadHostDiagnostics.push({
      pid: forPid,
      source: "fork-module",
      message:
        `fork_module_references=${message.references} ` +
        `externrefs_resolved=${message.externrefs} ` +
        `exnrefs_reconstructed=${message.exnrefs} ` +
        `gc_nodes_reconstructed=${message.gcNodes}`,
    });
  };
  // Phase 6 D5/D7a.1a: forward the co-resident module's FRAME proof-of-use — the
  // parent's committed-frame count and a fork child's replayed-frame count — as
  // `fork-module` host diagnostics, mirroring the Node/browser worker entries so
  // main-thread tests (which route here via `io`) can assert module drive.
  const recordForkModuleFrames = (
    forPid: number,
    message: Extract<
      WorkerToHostMessage,
      { type: "fork_module_frames" | "fork_module_child_frames" }
    >,
  ): void => {
    mainThreadHostDiagnostics.push({
      pid: forPid,
      source: "fork-module",
      message:
        message.type === "fork_module_frames"
          ? `fork_module_frames=${message.frames}`
          : `fork_module_child_frames=${message.frames}`,
    });
  };
  const externrefGenerations = new Map<number, ForkExternrefGeneration>();
  const processForkHostImports = new Map<number, ForkHostImportOwnerWorker>();
  let mainThreadForkCount: bigint | undefined;
  let spawnScratchCapacity: number | undefined;
  let kernelMemoryPages: number | undefined;

  let pid = 0;

  // Worker-quiescence teardown for non-main child processes (fork/spawn/exec).
  //
  // The production Node and browser hosts terminate a child's Worker only after
  // it becomes QUIESCENT — i.e. after the child Worker has posted its terminal
  // `exit` message and all of its earlier messages have therefore been drained.
  // A fork child's fork-module reference proof-of-use (`fork_module_references`)
  // is posted from the child Worker's tail, AFTER its guest `kernel_exit` — so
  // the kernel-driven `onExit` fires (and the main thread schedules teardown)
  // while that tail is still running. Terminating the child Worker on that
  // `onExit` turn races the tail: the Worker is frequently killed before it runs
  // the tail at all, dropping the diagnostic (a flaky NULL proof-of-use).
  //
  // Mirror production: a child Worker is reaped only once BOTH the kernel has
  // reported its exit AND the child Worker has posted its own terminal `exit`
  // message. Because a MessagePort delivers in FIFO order, processing that final
  // `exit` message guarantees every earlier message (including the reference
  // proof-of-use) was already delivered and recorded. Abnormal exits never post
  // `exit` (they post `error`/crash, which `finalize*WorkerError` terminates
  // directly, and the overall timeout terminates everything), so this path
  // governs only clean child exits.
  const childKernelExited = new Set<number>();
  const childWorkerQuiesced = new Set<number>();
  const reapChildWorkerIfReady = (childPid: number): void => {
    if (
      !childKernelExited.has(childPid) ||
      !childWorkerQuiesced.has(childPid)
    ) {
      return;
    }
    childKernelExited.delete(childPid);
    childWorkerQuiesced.delete(childPid);
    const worker = workers.get(childPid);
    if (worker) {
      worker.terminate().catch(() => {});
      workers.delete(childPid);
    }
  };

  const releaseProcessReferenceOwner = (releasePid: number): void => {
    processForkHostImports.get(releasePid)?.close();
    processForkHostImports.delete(releasePid);
    const generation = externrefGenerations.get(releasePid);
    if (generation) {
      externrefProcessOwner.releaseGeneration(generation);
      externrefGenerations.delete(releasePid);
    }
  };

  const kernelWorker = new CentralizedKernelWorker(
    { maxWorkers: 4, dataBufferSize: 65536, useSharedMemory: true, enableSyscallLog: !!process.env.KERNEL_SYSCALL_LOG },
    io,
    {
      onResolveSpawn: async (path, argv) => {
        const mappedProgram = options.execPrograms?.get(path);
        if (!mappedProgram) return null;
        const spawnProgramBytes = loadProgramWasm(mappedProgram);
        try {
          return {
            programBytes: spawnProgramBytes,
            programModule: await WebAssembly.compile(spawnProgramBytes),
            argv,
          };
        } catch (error) {
          if (error instanceof WebAssembly.CompileError) return { errno: 8 };
          throw error;
        }
      },
      onSpawn: async (_parentPid, childPid, program, envp) => {
        if (!kernelWorker.shouldLaunchPendingChild(childPid)) return 0;
        const childPtrWidth = detectPtrWidth(program.programBytes);
        const {
          memory: childMemory,
          layout: childLayout,
          threadAllocator: childThreadAllocator,
        } = createFreshProcessMemory(
          program.programBytes,
          childPtrWidth,
          () => kernelWorker.reserveHostRegion(
            childPid,
            PAGES_PER_THREAD * WASM_PAGE_SIZE,
          ) / WASM_PAGE_SIZE,
          options.maxPages,
        );
        if (!kernelWorker.shouldLaunchPendingChild(childPid)) return 0;

        const childChannelOffset = childLayout.channelOffset;
        kernelWorker.registerProcess(childPid, childMemory, [childChannelOffset], {
          ptrWidth: childPtrWidth,
          brkBase: childLayout.brkBase,
          mmapBase: childLayout.mmapBase,
          maxAddr: childLayout.maxAddr,
        });

        const childGeneration = externrefProcessOwner.startGeneration(childPid);
        let childWorker: ReturnType<NodeWorkerAdapter["createWorker"]>;
        const childForkHostImports = forkHostImportOwnerRuntime.createWorker({
          pid: childPid,
          generationId: childGeneration.id,
          authorizeSender: () => {
            if (
              workers.get(childPid) !== childWorker
              || externrefGenerations.get(childPid) !== childGeneration
            ) {
              throw new Error(
                `stale centralized-test host-import sender for spawn pid=${childPid}`,
              );
            }
          },
        });
        const childInitData: CentralizedWorkerInitMessage = {
          type: "centralized_init",
          pid: childPid,
          programBytes: program.programBytes,
          programModule: program.programModule,
          memory: childMemory,
          channelOffset: childChannelOffset,
          secureExec: kernelWorker.processSecureExec(childPid),
          argv: program.argv,
          env: envp,
          ptrWidth: childPtrWidth,
          externrefGenerationId: childGeneration.id,
          forkHostImports: childForkHostImports.init,
          ...centralizedForkModuleFields(childPtrWidth),
        };

        try {
          childWorker = workerAdapter.createWorker(childInitData);
        } catch (error) {
          childForkHostImports.close();
          externrefProcessOwner.releaseGeneration(childGeneration);
          kernelWorker.deactivateProcess(childPid);
          throw error;
        }
        workers.set(childPid, childWorker);
        externrefGenerations.set(childPid, childGeneration);
        processForkHostImports.set(childPid, childForkHostImports);
        processProgramBytes.set(childPid, program.programBytes);
        processMemories.set(childPid, childMemory);
        processLayouts.set(childPid, childLayout);
        threadAllocators.set(childPid, childThreadAllocator);
        processPtrWidths.set(childPid, childPtrWidth);

        const finalizeSpawnWorkerError = (reason: unknown): void => {
          if (workers.get(childPid) !== childWorker) return;
          const message = reason instanceof Error ? reason.message : String(reason);
          stderr += `[spawn child ${childPid}] ${message}\n`;
          try { kernelWorker.notifyHostProcessCrashed(childPid, SIGSEGV); } catch { /* best-effort */ }
          try { kernelWorker.deactivateProcess(childPid); } catch { /* best-effort */ }
          workers.delete(childPid);
          processProgramBytes.delete(childPid);
          processMemories.delete(childPid);
          processLayouts.delete(childPid);
          threadAllocators.delete(childPid);
          processPtrWidths.delete(childPid);
          releaseProcessReferenceOwner(childPid);
          childWorker.terminate().catch(() => {});
        };
        childWorker.on("error", finalizeSpawnWorkerError);
        childWorker.on("message", (msg: unknown) => {
          const message = msg as WorkerToHostMessage;
          if (message.type === "error" && message.pid === childPid) {
            finalizeSpawnWorkerError(message.message);
          } else if (message.type === "fork_host_import") {
            childForkHostImports.dispatch(message.wake);
          } else if (message.type === "exit" && message.pid === childPid) {
            childWorkerQuiesced.add(childPid);
            reapChildWorkerIfReady(childPid);
          }
        });
        return 0;
      },
      onFork: async ({
        parentPid,
        childPid,
        mode,
        parentMemory,
        continuation,
      }) => {
        const parentBuf = new Uint8Array(parentMemory.buffer);
        const parentPages = Math.ceil(parentBuf.byteLength / 65536);
        const childLayout = processLayouts.get(parentPid);
        if (!childLayout) throw new Error(`Unknown layout for parent pid ${parentPid}`);
        const parentPtrWidth = processPtrWidths.get(parentPid) ?? ptrWidth;
        const childMemory = createSharedProcessMemory(
          parentPtrWidth,
          parentPages,
          childLayout.maximumPages,
        );
        new Uint8Array(childMemory.buffer).set(parentBuf);

        const childChannelOffset = childLayout.channelOffset;
        new Uint8Array(childMemory.buffer, childChannelOffset, CH_TOTAL_SIZE).fill(0);

        kernelWorker.registerProcess(childPid, childMemory, [childChannelOffset], {
          ptrWidth: parentPtrWidth,
          maxAddr: childLayout.maxAddr,
          mmapBase: childLayout.mmapBase,
        });
        kernelWorker.inheritProcessSharedMappings(parentPid, childPid);

        const activeForkBufAddr = continuation.forkBufAddr;
        const parentForkReplayContext = forkReplayContexts.get(parentPid);
        const forkReplayContext: ForkReplayContext | undefined =
          continuation.kind === "thread"
          ? {
              fnPtr: continuation.fnPtr,
              argPtr: continuation.argPtr,
              forkBufAddr: activeForkBufAddr,
            }
          : parentForkReplayContext
            ? { ...parentForkReplayContext, forkBufAddr: activeForkBufAddr }
            : undefined;
        const forkBufAddr = activeForkBufAddr;
        const forkReplay = new ForkReplayGateCoordinator(
          `centralized test fork child pid=${childPid}`,
        );

        const parentProgram = processProgramBytes.get(parentPid) ?? programBytes;
        const parentGeneration = externrefGenerations.get(parentPid);
        if (!parentGeneration) {
          throw new Error(
            `Unknown externref generation for fork parent pid ${parentPid}`,
          );
        }
        const childGeneration =
          externrefProcessOwner.forkGenerationFromContinuation(
            parentGeneration,
            childPid,
            parentMemory,
            parentPtrWidth,
            forkBufAddr,
            `centralized test fork child pid=${childPid}`,
          ).generation;
        let childWorker:
          ReturnType<NodeWorkerAdapter["createWorker"]>;
        const childForkHostImports = forkHostImportOwnerRuntime.createWorker({
          pid: childPid,
          generationId: childGeneration.id,
          authorizeSender: () => {
            if (
              workers.get(childPid) !== childWorker
              || externrefGenerations.get(childPid) !== childGeneration
            ) {
              throw new Error(
                `stale centralized-test host-import sender for pid=${childPid}`,
              );
            }
          },
        });

        const childInitData: CentralizedWorkerInitMessage = {
          type: "centralized_init",
          pid: childPid,
          programBytes: parentProgram,
          memory: childMemory,
          channelOffset: childChannelOffset,
          secureExec: kernelWorker.processSecureExec(childPid),
          isForkChild: true,
          forkMode: mode,
          forkBufAddr,
          forkReplayGate: forkReplay.gate,
          forkChildThreadFnPtr: forkReplayContext?.fnPtr,
          forkChildThreadArgPtr: forkReplayContext?.argPtr,
          ptrWidth: parentPtrWidth,
          externrefGenerationId: childGeneration.id,
          forkHostImports: childForkHostImports.init,
          ...centralizedForkModuleFields(parentPtrWidth),
        };

        try {
          childWorker = workerAdapter.createWorker(childInitData);
        } catch (error) {
          childForkHostImports.close();
          externrefProcessOwner.releaseGeneration(childGeneration);
          throw error;
        }
        workers.set(childPid, childWorker);
        externrefGenerations.set(childPid, childGeneration);
        processForkHostImports.set(childPid, childForkHostImports);
        processProgramBytes.set(childPid, parentProgram);
        processMemories.set(childPid, childMemory);
        processLayouts.set(childPid, childLayout);
        threadAllocators.set(childPid, threadAllocatorForLayout(
          childLayout,
          parentPtrWidth,
          () => kernelWorker.reserveHostRegion(
            childPid,
            PAGES_PER_THREAD * WASM_PAGE_SIZE,
          ) / WASM_PAGE_SIZE,
        ));
        processPtrWidths.set(childPid, parentPtrWidth);
        if (forkReplayContext) forkReplayContexts.set(childPid, forkReplayContext);
        const finalizeChildWorkerError = (reason: unknown): void => {
          // Match the production hosts: an unexpected worker failure is a
          // signal-style process death, not an unregister that makes the
          // child disappear while its parent remains blocked in waitpid().
          // The worker identity guard also prevents a late event from an old
          // generation tearing down a replacement process after exec.
          if (workers.get(childPid) !== childWorker) return;
          const message = reason instanceof Error ? reason.message : String(reason);
          stderr += `[fork child ${childPid}] ${message}\n`;
          try { kernelWorker.notifyHostProcessCrashed(childPid, SIGSEGV); } catch { /* best-effort */ }
          try { kernelWorker.deactivateProcess(childPid); } catch { /* best-effort */ }
          workers.delete(childPid);
          processProgramBytes.delete(childPid);
          processMemories.delete(childPid);
          processLayouts.delete(childPid);
          threadAllocators.delete(childPid);
          processPtrWidths.delete(childPid);
          forkReplayContexts.delete(childPid);
          releaseProcessReferenceOwner(childPid);
          childWorker.terminate().catch(() => {});
        };
        childWorker.on("error", finalizeChildWorkerError);
        childWorker.on("message", (msg: unknown) => {
          const m = msg as WorkerToHostMessage;
          if (m.type === "error" && m.pid === childPid) {
            finalizeChildWorkerError(m.message);
          } else if (m.type === "fork_host_import") {
            childForkHostImports.dispatch(m.wake);
          } else if (
            m.type === "fork_module_references" &&
            m.pid === childPid
          ) {
            recordForkModuleReferences(childPid, m);
          } else if (
            (m.type === "fork_module_frames" ||
              m.type === "fork_module_child_frames") &&
            m.pid === childPid
          ) {
            recordForkModuleFrames(childPid, m);
          } else if (m.type === "exit" && m.pid === childPid) {
            // Worker quiescence: every earlier message from this child (e.g. its
            // reference proof-of-use) has been drained in FIFO order. Safe to reap.
            childWorkerQuiesced.add(childPid);
            reapChildWorkerIfReady(childPid);
          }
        });
        observeForkReplayWorker(
          forkReplay,
          childWorker,
          childPid,
          () => workers.get(childPid) === childWorker,
        );

        try {
          await forkReplay.waitUntilReady();
          if (workers.get(childPid) !== childWorker) {
            throw new Error(
              `Fork child ${childPid} changed generation before replay commit`,
            );
          }
          if (!kernelWorker.shouldLaunchPendingChild(childPid)) {
            throw new Error(`Fork child ${childPid} exited before replay commit`);
          }
          // Match the real Node/browser host: the parent cannot observe the
          // child until replay has reached the inherited fork import and this
          // separate commit wakes that exact Worker generation.
          forkReplay.commit();
          return [childChannelOffset];
        } catch (error) {
          forkReplay.cancel(error);
          if (workers.get(childPid) === childWorker) {
            workers.delete(childPid);
            processProgramBytes.delete(childPid);
            processMemories.delete(childPid);
            processLayouts.delete(childPid);
            threadAllocators.delete(childPid);
            processPtrWidths.delete(childPid);
            forkReplayContexts.delete(childPid);
            releaseProcessReferenceOwner(childPid);
          }
          childWorker.terminate().catch(() => {});
          throw error;
        }
      },
      onExec: async (request) => {
        const {
          pid: execPid,
          targetBytes: newProgramBytes,
          targetModule: newProgramModule,
          argv,
          envp,
        } = request;
        const newPtrWidth = detectPtrWidth(newProgramBytes);
        const sourcePtrWidth = processPtrWidths.get(execPid) ?? newPtrWidth;
        const metadataResult = kernelWorker.validateExecMetadata(argv, envp, sourcePtrWidth);
        if (metadataResult < 0) return metadataResult;

        const {
          memory: newMemory,
          layout: newLayout,
          threadAllocator: newThreadAllocator,
        } = createFreshProcessMemory(
          newProgramBytes,
          newPtrWidth,
          () => kernelWorker.reserveHostRegion(
            execPid,
            PAGES_PER_THREAD * WASM_PAGE_SIZE,
          ) / WASM_PAGE_SIZE,
          options.maxPages,
        );
        const newChannelOffset = newLayout.channelOffset;

        const addressSpaceResult = kernelWorker.prepareAddressSpaceForExec(execPid);
        if (addressSpaceResult < 0) return addressSpaceResult;
        const oldMemory = processMemories.get(execPid);
        if (!oldMemory) {
          throw new Error(`Unknown process memory for exec pid ${execPid}`);
        }
        let replacementWorker: ReturnType<NodeWorkerAdapter["createWorker"]> | undefined;
        let replacementGeneration: ForkExternrefGeneration | undefined;
        let replacementForkHostImports: ForkHostImportOwnerWorker | undefined;
        let launchPlanState: "ready" | "discarded" | "started" = "ready";
        return {
          onCommitFailure: () => {
            if (launchPlanState !== "ready") return;
            launchPlanState = "discarded";
          },
          startAfterCommit: async () => {
            if (launchPlanState !== "ready") {
              throw new Error(
                `Centralized-test exec plan for pid ${execPid} was already consumed`,
              );
            }
            launchPlanState = "started";
            try {
              const transition = kernelWorker.takeCommittedExecTransition(
                execPid,
                oldMemory,
              );
              const secureExec = transition.secureExec;
              kernelWorker.prepareProcessForExec(execPid, oldMemory);
              const previousGeneration = externrefGenerations.get(execPid);
              if (!previousGeneration) {
                throw new Error(
                  `Unknown externref generation for exec pid ${execPid}`,
                );
              }
              replacementGeneration =
                externrefProcessOwner.replaceGeneration(previousGeneration);
              externrefGenerations.set(execPid, replacementGeneration);

              if (transition.addressSpaceResult < 0) {
                throw new Error("failed to detach the discarded address space");
              }

              const oldWorker = workers.get(execPid);
              processForkHostImports.get(execPid)?.close();
              processForkHostImports.delete(execPid);
              if (oldWorker) {
                await oldWorker.terminate().catch(() => {});
                workers.delete(execPid);
              }
              if (kernelWorker.finalizeExecHandoffTermination(execPid) > 0) {
                externrefProcessOwner.releaseGeneration(replacementGeneration);
                externrefGenerations.delete(execPid);
                replacementGeneration = undefined;
                return 0;
              }

              kernelWorker.registerProcess(execPid, newMemory, [newChannelOffset], {
                preserveProcessState: true,
                ptrWidth: newPtrWidth,
                metadataPtrWidth: sourcePtrWidth,
                brkBase: newLayout.brkBase,
                mmapBase: newLayout.mmapBase,
                maxAddr: newLayout.maxAddr,
                argv,
                env: envp,
              });
              processProgramBytes.set(execPid, newProgramBytes);
              processMemories.set(execPid, newMemory);
              processLayouts.set(execPid, newLayout);
              threadAllocators.set(execPid, newThreadAllocator);
              processPtrWidths.set(execPid, newPtrWidth);
              forkReplayContexts.delete(execPid);

              replacementForkHostImports =
                forkHostImportOwnerRuntime.createWorker({
                  pid: execPid,
                  generationId: replacementGeneration.id,
                  authorizeSender: () => {
                    if (
                      !replacementWorker
                      || workers.get(execPid) !== replacementWorker
                      || externrefGenerations.get(execPid)
                        !== replacementGeneration
                    ) {
                      throw new Error(
                        `stale centralized-test host-import sender for exec pid=${execPid}`,
                      );
                    }
                  },
                });
              const initData: CentralizedWorkerInitMessage = {
                type: "centralized_init",
                pid: execPid,
                programBytes: newProgramBytes,
                programModule: newProgramModule,
                memory: newMemory,
                channelOffset: newChannelOffset,
                secureExec,
                argv,
                env: envp,
                ptrWidth: newPtrWidth,
                externrefGenerationId: replacementGeneration.id,
                forkHostImports: replacementForkHostImports.init,
                ...centralizedForkModuleFields(newPtrWidth),
              };

              replacementWorker = workerAdapter.createWorker(initData);
              workers.set(execPid, replacementWorker);
              processForkHostImports.set(execPid, replacementForkHostImports);
              replacementWorker.on("error", (err: Error) => {
                console.error(`[exec] worker error for pid ${execPid}:`, err);
              });
              replacementWorker.on("message", (msg: unknown) => {
                const m = msg as WorkerToHostMessage;
                if (m.type === "fork_host_import") {
                  replacementForkHostImports?.dispatch(m.wake);
                } else if (m.type === "exit" && m.pid === execPid) {
                  childWorkerQuiesced.add(execPid);
                  reapChildWorkerIfReady(execPid);
                }
              });
              kernelWorker.finishProcessExecHandoff(execPid);
              return 0;
            } catch (err) {
              replacementForkHostImports?.close();
              try { kernelWorker.prepareProcessForExec(execPid); } catch { /* best-effort */ }
              if (replacementWorker && workers.get(execPid) !== replacementWorker) {
                await replacementWorker.terminate().catch(() => {});
              }
              const currentWorker = workers.get(execPid);
              if (currentWorker) {
                await currentWorker.terminate().catch(() => {});
                workers.delete(execPid);
              }
              try { kernelWorker.notifyHostProcessCrashed(execPid, SIGSEGV); } catch { /* best-effort */ }
              try { kernelWorker.deactivateProcess(execPid); } catch { /* best-effort */ }
              processProgramBytes.delete(execPid);
              processMemories.delete(execPid);
              processLayouts.delete(execPid);
              threadAllocators.delete(execPid);
              processPtrWidths.delete(execPid);
              forkReplayContexts.delete(execPid);
              releaseProcessReferenceOwner(execPid);
              const message = err instanceof Error ? err.message : String(err);
              stderr += `[exec] post-commit transition failed: ${message}\n`;
              if (execPid === pid) resolveExit(128 + SIGSEGV);
              return 0;
            }
          },
        };
      },
      onClone: async (attachment) => {
        const {
          pid: clonePid,
          tid,
          fnPtr,
          argPtr,
          stackPtr,
          tlsPtr,
          ctidPtr,
          memory,
        } = attachment;
        const threadAllocator = threadAllocators.get(clonePid);
        if (!threadAllocator) throw new Error(`Unknown thread allocator for pid ${clonePid}`);
        const clonePtrWidth = processPtrWidths.get(clonePid) ?? ptrWidth;
        const processChannelOffset = processLayouts.get(clonePid)?.channelOffset;
        if (processChannelOffset === undefined) {
          throw new Error(`Unknown process channel for pid ${clonePid}`);
        }
        const alloc = threadAllocator.allocate(memory);
        try {
          kernelWorker.attachThreadChannel(attachment, alloc.channelOffset);
        } catch (err) {
          threadAllocator.free(alloc.basePage);
          throw err;
        }
        const processGeneration = externrefGenerations.get(clonePid);
        if (!processGeneration) {
          threadAllocator.free(alloc.basePage);
          throw new Error(
            `Unknown externref generation for pthread pid ${clonePid}`,
          );
        }
        let threadWorker: ReturnType<NodeWorkerAdapter["createWorker"]>;
        let threadWorkerLive = true;
        const threadForkHostImports = forkHostImportOwnerRuntime.createWorker({
          pid: clonePid,
          generationId: processGeneration.id,
          authorizeSender: () => {
            if (
              !threadWorkerLive
              || externrefGenerations.get(clonePid) !== processGeneration
            ) {
              throw new Error(
                `stale centralized-test pthread host-import sender `
                + `for pid=${clonePid} tid=${tid}`,
              );
            }
          },
        });

        const threadInitData: CentralizedThreadInitMessage = {
          type: "centralized_thread_init",
          pid: clonePid,
          tid,
          programBytes: processProgramBytes.get(clonePid) ?? programBytes,
          memory,
          processChannelOffset,
          channelOffset: alloc.channelOffset,
          secureExec: kernelWorker.processSecureExec(clonePid),
          fnPtr,
          argPtr,
          stackPtr,
          tlsPtr,
          ctidPtr,
          tlsOffset: alloc.tlsOffset,
          tlsAllocAddr: alloc.tlsAllocAddr,
          ptrWidth: clonePtrWidth,
          externrefGenerationId: processGeneration.id,
          forkHostImports: threadForkHostImports.init,
          // Phase 6 D7b: ship the fork-module to a pthread so a fork issued from
          // it unwinds through the module (parent side of a fork-from-thread),
          // mirroring the process-worker init above.
          ...centralizedForkModuleFields(clonePtrWidth),
        };

        try {
          threadWorker = workerAdapter.createWorker(threadInitData);
        } catch (error) {
          threadWorkerLive = false;
          threadForkHostImports.close();
          threadAllocator.free(alloc.basePage);
          throw error;
        }
        threadWorker.on("message", (msg: unknown) => {
          const m = msg as WorkerToHostMessage;
          if (m.type === "thread_exit") {
            threadWorkerLive = false;
            threadForkHostImports.close();
            threadAllocator.free(alloc.basePage);
            threadWorker.terminate().catch(() => {});
          } else if (m.type === "fork_host_import") {
            threadForkHostImports.dispatch(m.wake);
          }
        });
        threadWorker.on("error", () => {
          threadWorkerLive = false;
          threadForkHostImports.close();
          kernelWorker.notifyThreadExit(clonePid, tid);
          kernelWorker.removeChannel(clonePid, alloc.channelOffset);
          threadAllocator.free(alloc.basePage);
        });

      },
      onExit: (exitPid, exitStatus) => {
        if (exitPid === pid) {
          processProgramBytes.delete(exitPid);
          processMemories.delete(exitPid);
          processLayouts.delete(exitPid);
          threadAllocators.delete(exitPid);
          processPtrWidths.delete(exitPid);
          forkReplayContexts.delete(exitPid);
          releaseProcessReferenceOwner(exitPid);
          const w = workers.get(exitPid);
          if (w) {
            w.terminate().catch(() => {});
            workers.delete(exitPid);
          }
          resolveExit(exitStatus);
        } else {
          // WHY: onExit runs as a protocol-publication effect. Its kernel
          // capability is revoked, but the entry gate is still draining that
          // effect batch, so a nested export is correctly rejected as
          // reentrant. Move child deactivation to the next fresh host turn,
          // like the production Node and browser teardown paths do after
          // their worker-quiescence await.
          queueMicrotask(() => {
            try {
              kernelWorker.deactivateProcess(exitPid);
              processProgramBytes.delete(exitPid);
              processMemories.delete(exitPid);
              processLayouts.delete(exitPid);
              threadAllocators.delete(exitPid);
              processPtrWidths.delete(exitPid);
              forkReplayContexts.delete(exitPid);
              releaseProcessReferenceOwner(exitPid);
              // Do NOT terminate the child Worker here — wait for its terminal
              // `exit` message (worker quiescence), mirroring the production
              // hosts, so a fork child's tail-emitted reference proof-of-use is
              // delivered before teardown.
              childKernelExited.add(exitPid);
              reapChildWorkerIfReady(exitPid);
            } catch (error) {
              rejectExit(
                error instanceof Error ? error : new Error(String(error)),
              );
            }
          });
        }
      },
    },
  );

  kernelWorker.setOutputCallbacks({
    onStdout: (data: Uint8Array) => {
      stdout += new TextDecoder().decode(data);
      stdoutChunks.push(new Uint8Array(data));
    },
    onStderr: (data: Uint8Array) => {
      stderr += new TextDecoder().decode(data);
    },
  });

  await kernelWorker.init(kernelWasmBytes);
  pid = kernelWorker.createProcess(CAPTURED_STDIO);

  const {
    memory,
    layout,
    threadAllocator,
  } = createFreshProcessMemory(
    programBytes,
    ptrWidth,
    () => kernelWorker.reserveHostRegion(
      pid,
      PAGES_PER_THREAD * WASM_PAGE_SIZE,
    ) / WASM_PAGE_SIZE,
    options.maxPages,
  );
  const channelOffset = layout.channelOffset;

  kernelWorker.registerProcess(pid, memory, [channelOffset], {
    ptrWidth,
    brkBase: layout.brkBase,
    mmapBase: layout.mmapBase,
    maxAddr: layout.maxAddr,
  });
  kernelWorker.setCredentials(pid, { uid: options.uid, gid: options.gid });
  processProgramBytes.set(pid, programBytes);
  processMemories.set(pid, memory);
  processLayouts.set(pid, layout);
  threadAllocators.set(pid, threadAllocator);
  processPtrWidths.set(pid, ptrWidth);

  if (options.stdinBytes != null) {
    kernelWorker.setStdinData(pid, options.stdinBytes);
  } else if (options.stdin != null) {
    kernelWorker.setStdinData(pid, new TextEncoder().encode(options.stdin));
  }

  if (options.onKernelReady) {
    await options.onKernelReady(kernelWorker, pid);
  }

  const mainGeneration = externrefProcessOwner.startGeneration(pid);
  externrefGenerations.set(pid, mainGeneration);
  let mainWorker: ReturnType<NodeWorkerAdapter["createWorker"]>;
  const mainForkHostImports = forkHostImportOwnerRuntime.createWorker({
    pid,
    generationId: mainGeneration.id,
    authorizeSender: () => {
      if (
        workers.get(pid) !== mainWorker
        || externrefGenerations.get(pid) !== mainGeneration
      ) {
        throw new Error(
          `stale centralized-test host-import sender for pid=${pid}`,
        );
      }
    },
  });
  const initData: CentralizedWorkerInitMessage = {
    type: "centralized_init",
    pid,
    programBytes,
    memory,
    channelOffset,
    secureExec: kernelWorker.processSecureExec(pid),
    env: options.env,
    argv: options.argv ?? [options.programPath],
    ptrWidth,
    externrefGenerationId: mainGeneration.id,
    forkHostImports: mainForkHostImports.init,
    ...centralizedForkModuleFields(ptrWidth),
  };

  try {
    mainWorker = workerAdapter.createWorker(initData);
  } catch (error) {
    mainForkHostImports.close();
    externrefProcessOwner.releaseGeneration(mainGeneration);
    externrefGenerations.delete(pid);
    throw error;
  }
  workers.set(pid, mainWorker);
  processForkHostImports.set(pid, mainForkHostImports);

  if (options.onStarted) {
    await options.onStarted(kernelWorker, pid);
  }

  const timer = setTimeout(() => {
    for (const [, w] of workers) w.terminate().catch(() => {});
    for (const livePid of [...externrefGenerations.keys()]) {
      releaseProcessReferenceOwner(livePid);
    }
    rejectExit(new Error(`Program timed out after ${timeout}ms`));
  }, timeout);

  mainWorker.on("error", (err: Error) => {
    clearTimeout(timer);
    releaseProcessReferenceOwner(pid);
    rejectExit(err);
  });

  // The worker posts {type:"error"} from its top-level catch (e.g. ABI
  // mismatch, instantiate failure). Without a handler here the test would
  // wait for an "exit" message that's never coming and look like a 5s/30s
  // timeout instead of surfacing the real error. Reject the exit promise
  // so the failure shows the kernel's diagnostic verbatim.
  mainWorker.on("message", (msg: unknown) => {
    const m = msg as WorkerToHostMessage;
    if (m.type === "error" && m.pid === pid) {
      clearTimeout(timer);
      for (const [, w] of workers) w.terminate().catch(() => {});
      releaseProcessReferenceOwner(pid);
      rejectExit(new Error(m.message));
    } else if (m.type === "fork_host_import") {
      mainForkHostImports.dispatch(m.wake);
    } else if (m.type === "fork_module_references" && m.pid === pid) {
      recordForkModuleReferences(pid, m);
    } else if (
      (m.type === "fork_module_frames" ||
        m.type === "fork_module_child_frames") &&
      m.pid === pid
    ) {
      recordForkModuleFrames(pid, m);
    }
  });

  const exitCode = await exitPromise;
  clearTimeout(timer);
  // WHY: onExit is a detached protocol-publication callback. A result-bearing
  // kernel query there would be rejected as reentrant, while unregister would
  // merely queue and could retire the zombie before its counter is observed.
  // The resolved promise resumes only after that detached stack has unwound,
  // so capture first from this fresh caller root. Always request unregister
  // even if a broken counter query exposes a separate lifecycle failure.
  try {
    if (options.captureForkCount) {
      mainThreadForkCount = kernelWorker.getForkCount(pid);
    }
  } finally {
    kernelWorker.unregisterProcess(pid);
  }
  if (options.captureSpawnScratchStats) {
    spawnScratchCapacity = kernelWorker.getSpawnScratchCapacity();
    kernelMemoryPages = kernelWorker.getKernelMemoryPages();
  }

  const totalLen = stdoutChunks.reduce((sum, c) => sum + c.length, 0);
  const stdoutBytes = new Uint8Array(totalLen);
  let offset = 0;
  for (const chunk of stdoutChunks) {
    stdoutBytes.set(chunk, offset);
    offset += chunk.length;
  }

  return {
    exitCode,
    stdout,
    stderr,
    hostDiagnostics: mainThreadHostDiagnostics,
    stdoutBytes,
    forkCount: mainThreadForkCount,
    spawnScratchCapacity,
    kernelMemoryPages,
  };
}
