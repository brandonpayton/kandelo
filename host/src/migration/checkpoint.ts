import {
  CH_CHECKPOINT_REQUEST,
  CH_CHECKPOINT_REQUEST_RESTART,
} from "../generated/abi";
import type { CheckpointFreezeGateCoordinator } from "../checkpoint-freeze-gate";
import type { ProcessMemoryLayout } from "../process-memory";
import type { ThreadPageAllocatorState } from "../thread-allocator";
import type { CheckpointGlContext } from "../webgl/snapshot";

/**
 * Freeze a running machine and read it, on either host.
 *
 * The three legs of the freeze, the vfork precondition, and the process bucket
 * all already exist in the two kernel-worker entries as module-level
 * singletons. This module owns the ordering between them and nothing else, so
 * Node and browser run the same protocol rather than two copies of it.
 *
 * The protocol is `DESIGN.md` § "The handover protocol" steps 2 to 7.
 */

/** Continuation root a byte copy of process memory does not carry. */
export interface CheckpointForkReplayContext {
  readonly fnPtr: number;
  readonly argPtr: number;
  readonly forkBufAddr: number;
}

/**
 * One live pthread the freeze parked, with its frames in process memory.
 *
 * The parked frames, channel, and TLS travel inside the process memory copy;
 * these are the clone-time launch values that memory does not carry. A restore
 * relaunches the thread's worker from them and rewinds it through the anchor
 * at `channelOffset - FORK_SAVE_BUFFER_SIZE`.
 */
export interface CheckpointProcessThread {
  readonly tid: number;
  readonly channelOffset: number;
  readonly slotStartPage: number;
  readonly fnPtr: number;
  readonly argPtr: number;
  readonly stackPtr: number;
  readonly tlsPtr: number;
  readonly ctidPtr: number;
  readonly tlsOffset: number;
}

/**
 * One live framebuffer binding and, for a write-based binding, its pixels.
 *
 * A write-based binding's current frame lives in a host-allocated buffer —
 * not in process or kernel memory — so the checkpoint must carry the bytes
 * or the receiver's canvas starts black. An mmap-based binding's pixels ride
 * inside the process memory copy; only the binding metadata travels.
 */
export interface CheckpointFramebuffer {
  readonly pid: number;
  readonly addr: number;
  readonly len: number;
  readonly w: number;
  readonly h: number;
  readonly stride: number;
  readonly fmt: "BGRA32";
  readonly hostBuffer: Uint8Array | null;
}

/**
 * One GBM buffer object and its pixels.
 *
 * A bound buffer's bytes also ride inside the process memory copy, but the KMS
 * scanout path reads the host buffer rather than process memory, and an
 * unbound buffer has no mapped range at all. The checkpoint therefore carries
 * every buffer's pixels rather than deriving them from the mapped ranges.
 */
export interface CheckpointGbmBuffer {
  readonly bo_id: number;
  readonly size: number;
  readonly w: number;
  readonly h: number;
  readonly stride: number;
  readonly pids: readonly number[];
  readonly bindings: readonly {
    readonly pid: number;
    readonly addr: number;
    readonly len: number;
  }[];
  readonly pixels: Uint8Array;
}

/** One framebuffer object the guest created with `drmModeAddFB2`. */
export interface CheckpointKmsFramebuffer {
  readonly fb_id: number;
  readonly bo_id: number;
  readonly width: number;
  readonly height: number;
  readonly pixel_format: number;
  readonly pitch: number;
}

/** One CRTC the guest drove `drmModeSetCrtc` on. */
export interface CheckpointKmsCrtc {
  readonly crtc_id: number;
  readonly fb_id: number;
}

/**
 * The modeset display state, which a restore rebuilds before the guest runs.
 *
 * A CRTC binding outlives `rmFb` on its framebuffer, matching DRM, so `crtcs`
 * can name an `fb_id` that `fbs` does not list.
 */
export interface CheckpointKmsState {
  readonly fbs: readonly CheckpointKmsFramebuffer[];
  readonly crtcs: readonly CheckpointKmsCrtc[];
  readonly masterPid: number | null;
  readonly buffers: readonly CheckpointGbmBuffer[];
}

/** One live execution image the freeze can read. */
export interface CheckpointProcessSource {
  readonly pid: number;
  /** Serialisable execution identity; a PID survives exec, this does not. */
  readonly executionGeneration: number;
  readonly ptrWidth: 4 | 8;
  readonly channelOffset: number;
  readonly layout: ProcessMemoryLayout;
  readonly argv: readonly string[];
  /**
   * Launch environment for this exact image. A guest captured inside `_start`
   * re-reads argv and environment from its worker's startup imports when it
   * resumes, so a restore must relaunch the worker with the same values or
   * the CRT's startup contract truthfully traps.
   */
  readonly env: readonly string[];
  readonly memory: WebAssembly.Memory;
  /**
   * The exact program image this generation runs. Read under the freeze:
   * after the machine resumes, an exec can retire the generation and a bucket
   * keyed to it must not pick up the successor's program.
   */
  readonly programBytes: () => ArrayBuffer;
  readonly threadAllocatorState: () => ThreadPageAllocatorState;
  /** Read under the freeze: a thread can exit once the machine resumes. */
  readonly threads: () => readonly CheckpointProcessThread[];
  readonly forkReplayContext?: CheckpointForkReplayContext;
  readonly checkpointFreeze: CheckpointFreezeGateCoordinator;
}

/** Everything the freeze drives, supplied by the host entry that owns it. */
export interface CheckpointMachine {
  /** Leg 3: `ProcessMemoryCreatorGate.runExclusive`. */
  readonly runWithoutWorkerCreation: <T>(
    operation: string,
    exclusive: () => Promise<T>,
  ) => Promise<T>;
  /** Leg 2: `RootfsSnapshotGate.runSnapshot`. */
  readonly runWithoutRootfsMutation: <T>(operation: () => Promise<T>) => Promise<T>;
  /** Step 2's precondition: `VforkLifetimeCoordinator.settleActiveBorrows`. */
  readonly settleActiveVforkBorrows: () => Promise<void>;
  /** Leg 1: the stopped-process dispatch gate. */
  readonly holdProcessDispatch: () => number[];
  /**
   * Give the held processes back, which the kernel entry may have to queue.
   *
   * The read leaves work waiting to enter the kernel, so the release takes its
   * place in that queue rather than demanding the kernel be free at once.
   */
  readonly releaseProcessDispatch: () => Promise<number[]>;
  readonly armUnwindRequests: () => number[];
  readonly disarmUnwindRequests: () => void;
  readonly copyKernelMemory: () => Uint8Array;
  /**
   * Every mount this machine writes to, `/` first, whether or not it answers.
   *
   * A machine's files are spread across mounts, not held in one: `/` carries
   * the image while `/home/maker`, `/root`, `/tmp`, `/var/*` and `/srv` are
   * separate scratch filesystems with buffers of their own. Reading only `/`
   * would move a machine whose processes survive but whose working files do
   * not.
   *
   * A mount whose backend holds no shared buffer stays in this list and says
   * why. Dropping it here would leave the checkpoint unable to tell a restore
   * that the machine it rebuilds is short a filesystem.
   */
  readonly filesystemBuffers: () => readonly CheckpointMountSource[];
  /** Read under the freeze: bindings and write-based pixels are quiescent. */
  readonly framebuffers: () => readonly CheckpointFramebuffer[];
  /** Read under the freeze: the display is quiescent. */
  readonly kmsState: () => CheckpointKmsState;
  /** Read under the freeze: every GL binding's context state, read back out
   *  of WebGL2 plus what the bridge retained; see `webgl/snapshot.ts`.
   *
   *  A GL guest's pixels never reach a host buffer, but the checkpoint does
   *  not need them: the guest's context state travels here, a restore
   *  rebuilds it, and the restored guest's own draws repaint the screen. */
  readonly glContexts: () => readonly CheckpointGlContext[];
  /** This machine's CLOCK_MONOTONIC in nanoseconds. */
  readonly monotonicNowNs: () => number;
  readonly kernelAbiVersion: () => number;
  readonly liveProcesses: () => readonly CheckpointProcessSource[];
  /**
   * Whether a process launch is waiting out the freeze's exclusivity.
   *
   * A fork, exec, posix_spawn, or pthread launch that arrives during the
   * freeze queues on the worker-creation gate rather than failing — the read
   * must never be visible to the machine as a failed launch. Its initiating
   * process is parked inside that launch, so the freeze's park can never
   * complete while one is queued. The freeze checks here and listens below to
   * give the machine back at once and retry, instead of timing out.
   */
  readonly hasQueuedLaunch?: () => boolean;
  /** Listen for a launch queueing during the freeze. Returns an unsubscribe. */
  readonly onLaunchQueuedDuringFreeze?: (listener: () => void) => () => void;
}

/**
 * What a mount answers when a checkpoint asks for its bytes.
 *
 * A backend that keeps its files in a SharedArrayBuffer answers `bytes`. One
 * that keeps them anywhere else answers `none` with the reason a restore
 * reports.
 */
export type CheckpointBytes =
  | { readonly kind: "bytes"; readonly buffer: SharedArrayBuffer }
  | { readonly kind: "none"; readonly reason: string };

/** One mount, as the freeze finds it. */
export interface CheckpointMountSource {
  /** Absolute mount point, exactly as the mount layout names it. */
  readonly mountPoint: string;
  readonly bytes: CheckpointBytes;
}

/**
 * Ask every mount for its bytes, in the order the mount layout names them.
 *
 * Both host entries build `filesystemBuffers` from this rather than reading
 * buffers themselves, so a backend that cannot answer produces the same
 * recorded refusal on Node and in the browser.
 */
export function askMountsForCheckpointBytes(
  mounts: readonly {
    readonly mountPoint: string;
    readonly backend: { checkpointBytes?(): CheckpointBytes };
  }[],
): readonly CheckpointMountSource[] {
  return mounts.map((mount) => ({
    mountPoint: mount.mountPoint,
    bytes: mount.backend.checkpointBytes?.() ?? {
      kind: "none",
      reason: "this mount's backend reports no checkpoint bytes",
    },
  }));
}

/** One memory-backed mount, as a checkpoint carries it. */
export interface CheckpointMount {
  readonly mountPoint: string;
  readonly bytes: Uint8Array;
}

/**
 * One mount a checkpoint could not carry, and what its backend said.
 *
 * Carrying nothing for a host directory is defensible; saying nothing about it
 * is not, so the refusal travels with the checkpoint.
 */
export interface CheckpointMountGap {
  readonly mountPoint: string;
  readonly reason: string;
}

export interface CheckpointProcessBucket {
  readonly pid: number;
  readonly executionGeneration: number;
  readonly ptrWidth: 4 | 8;
  readonly channelOffset: number;
  readonly layout: ProcessMemoryLayout;
  readonly argv: readonly string[];
  /** Launch environment; a guest resumed inside `_start` re-reads it. */
  readonly env: readonly string[];
  readonly memory: Uint8Array;
  /** Live reference, never mutated: exec replaces the buffer, in place. */
  readonly programBytes: ArrayBuffer;
  readonly threadAllocator: ThreadPageAllocatorState;
  readonly threads: readonly CheckpointProcessThread[];
  readonly forkReplayContext?: CheckpointForkReplayContext;
}

/**
 * The version of this checkpoint layout, carried in every checkpoint.
 *
 * A checkpoint is untrusted input on every path that consumes one. A restore
 * refuses a checkpoint whose format it does not know rather than guessing at
 * the missing or extra fields.
 */
export const MACHINE_CHECKPOINT_FORMAT = 6;

export interface MachineCheckpoint {
  readonly format: typeof MACHINE_CHECKPOINT_FORMAT;
  /** The ABI the captured kernel ran; a restore refuses any other. */
  readonly kernelAbiVersion: number;
  readonly kernelMemory: Uint8Array;
  /**
   * Every memory-backed mount, `/` first.
   *
   * A restore rebuilds each mount from its own bytes. Carrying only `/` would
   * hand over a machine whose processes continue but whose `/home/maker`,
   * `/root`, `/tmp`, `/var/*` and `/srv` came up empty underneath them.
   *
   * How much of that a host reaches follows from how it resolves
   * `DEFAULT_MOUNT_SPEC`. `resolveForBrowser` backs every scratch mount with a
   * `MemoryFileSystem`; `resolveForNodeKernelSession` backs each one with a
   * `HostFileSystem` under the per-boot session directory, which owns no
   * SharedArrayBuffer for the freeze to read. Only memory-backed mounts reach
   * this field, so a Node checkpoint carries `/` alone and a Node machine
   * moves without its working directories. Every mount that stayed behind is
   * named in {@link unreadableFilesystems}.
   */
  readonly filesystems: readonly CheckpointMount[];
  /**
   * Every mount the freeze asked for bytes and did not get, with the reason.
   *
   * A machine short a filesystem is still a machine worth moving, so a gap
   * here does not refuse the checkpoint. It does mean a restore must say what
   * it did not get: presenting a machine missing `/tmp` as if it were whole is
   * the convenient illusion the platform values contract forbids.
   */
  readonly unreadableFilesystems: readonly CheckpointMountGap[];
  readonly framebuffers: readonly CheckpointFramebuffer[];
  /** The modeset display, empty for a machine that never drove `/dev/dri`. */
  readonly kms: CheckpointKmsState;
  /**
   * Every GL binding's context state, empty for a machine that never drove
   * the EGL to WebGL2 bridge.
   *
   * A GL guest's pixels stay behind — a replica re-executes the guest and
   * renders its own — but the objects the guest created and the values it
   * set are machine state, and a restored guest resumes believing they
   * exist. Each context also carries `boundaries`: what its read could not
   * take, which a restore reports rather than absorbs.
   */
  readonly gl: readonly CheckpointGlContext[];
  /**
   * The captured machine's CLOCK_MONOTONIC at the freeze, in nanoseconds.
   *
   * Kernel state carries monotonic deadlines (an armed interval timer), and
   * POSIX forbids a guest's monotonic clock from running backwards. The
   * receiver advances its own monotonic clock to at least this value before
   * adopting the kernel memory.
   */
  readonly monotonicNs: number;
  readonly processes: readonly CheckpointProcessBucket[];
}

/**
 * What a checkpoint holds, without the bytes.
 *
 * This is what crosses the worker port when the caller only needs proof the
 * freeze read a whole machine. A caller that will rebuild a machine asks for
 * the full {@link MachineCheckpoint} instead.
 */
export interface MachineCheckpointSummary {
  readonly kernelMemoryBytes: number;
  /** Every mount's bytes added together. */
  readonly filesystemBytes: number;
  readonly filesystems: readonly {
    readonly mountPoint: string;
    readonly bytes: number;
  }[];
  /** The mounts the freeze could not read, so a caller holding no bytes sees them. */
  readonly unreadableFilesystems: readonly CheckpointMountGap[];
  readonly framebuffers: readonly {
    readonly pid: number;
    readonly w: number;
    readonly h: number;
    readonly hostBufferBytes: number;
  }[];
  readonly kms: {
    readonly crtcs: readonly number[];
    readonly fbs: readonly number[];
    readonly buffers: readonly {
      readonly bo_id: number;
      readonly w: number;
      readonly h: number;
      readonly pixelBytes: number;
    }[];
  };
  readonly gl: readonly {
    readonly pid: number;
    readonly buffers: number;
    readonly textures: number;
    readonly programs: number;
    readonly pixelBytes: number;
    readonly boundaries: readonly string[];
  }[];
  readonly processes: readonly {
    readonly pid: number;
    readonly executionGeneration: number;
    readonly ptrWidth: 4 | 8;
    readonly channelOffset: number;
    readonly argv: readonly string[];
    readonly memoryBytes: number;
    readonly threadAllocator: ThreadPageAllocatorState;
    readonly threads: readonly CheckpointProcessThread[];
    readonly forkReplayContext?: CheckpointForkReplayContext;
  }[];
}

export type CheckpointCaptureResponse =
  | { readonly status: "captured"; readonly summary: MachineCheckpointSummary }
  | { readonly status: "timed-out"; readonly reason: string }
  | { readonly status: "failed"; readonly reason: string };

function summarizeMachineCheckpoint(
  checkpoint: MachineCheckpoint,
): MachineCheckpointSummary {
  return {
    kernelMemoryBytes: checkpoint.kernelMemory.byteLength,
    filesystemBytes: checkpoint.filesystems.reduce(
      (total, mount) => total + mount.bytes.byteLength,
      0,
    ),
    filesystems: checkpoint.filesystems.map((mount) => ({
      mountPoint: mount.mountPoint,
      bytes: mount.bytes.byteLength,
    })),
    unreadableFilesystems: checkpoint.unreadableFilesystems,
    framebuffers: checkpoint.framebuffers.map((framebuffer) => ({
      pid: framebuffer.pid,
      w: framebuffer.w,
      h: framebuffer.h,
      hostBufferBytes: framebuffer.hostBuffer?.byteLength ?? 0,
    })),
    kms: {
      crtcs: checkpoint.kms.crtcs.map((crtc) => crtc.crtc_id),
      fbs: checkpoint.kms.fbs.map((fb) => fb.fb_id),
      buffers: checkpoint.kms.buffers.map((buffer) => ({
        bo_id: buffer.bo_id,
        w: buffer.w,
        h: buffer.h,
        pixelBytes: buffer.pixels.byteLength,
      })),
    },
    gl: checkpoint.gl.map((context) => ({
      pid: context.pid,
      buffers: context.buffers.length,
      textures: context.textures.length,
      programs: context.programs.length,
      pixelBytes: context.textures.reduce(
        (total, texture) => total + texture.levels.reduce(
          (levelTotal, level) => levelTotal + (level.pixels?.byteLength ?? 0),
          0,
        ),
        0,
      ) + context.buffers.reduce(
        (total, buffer) => total + buffer.bytes.byteLength,
        0,
      ),
      boundaries: context.boundaries,
    })),
    processes: checkpoint.processes.map((bucket) => ({
      pid: bucket.pid,
      executionGeneration: bucket.executionGeneration,
      ptrWidth: bucket.ptrWidth,
      channelOffset: bucket.channelOffset,
      argv: bucket.argv,
      memoryBytes: bucket.memory.byteLength,
      threadAllocator: bucket.threadAllocator,
      threads: bucket.threads,
      ...(bucket.forkReplayContext
        ? { forkReplayContext: bucket.forkReplayContext }
        : {}),
    })),
  };
}

export type CheckpointFreezeResult =
  | { readonly status: "captured"; readonly checkpoint: MachineCheckpoint }
  | { readonly status: "timed-out"; readonly reason: string }
  | { readonly status: "failed"; readonly reason: string };

/**
 * The buffers a worker port should transfer rather than clone.
 *
 * Every buffer here is a copy the freeze took, so the worker gives it away.
 * `programBytes` stays out: each is the live program image its generation
 * still runs, and transferring it would detach the running process's copy.
 */
export function machineCheckpointTransferList(
  checkpoint: MachineCheckpoint,
): ArrayBuffer[] {
  return [
    checkpoint.kernelMemory.buffer as ArrayBuffer,
    ...checkpoint.filesystems.map((mount) => mount.bytes.buffer as ArrayBuffer),
    ...checkpoint.framebuffers.flatMap((framebuffer) =>
      framebuffer.hostBuffer === null
        ? []
        : [framebuffer.hostBuffer.buffer as ArrayBuffer]
    ),
    ...checkpoint.kms.buffers.map(
      (buffer) => buffer.pixels.buffer as ArrayBuffer,
    ),
    ...checkpoint.gl.flatMap((context) => [
      ...context.buffers.map((buffer) => buffer.bytes.buffer as ArrayBuffer),
      ...context.textures.flatMap((texture) =>
        texture.levels.flatMap((level) =>
          level.pixels === null ? [] : [level.pixels.buffer as ArrayBuffer]
        )
      ),
    ]),
    ...checkpoint.processes.map(
      (bucket) => bucket.memory.buffer as ArrayBuffer,
    ),
  ];
}

export interface CheckpointFreezeOptions {
  /**
   * Cap on the wait for every process to reach UNWINDING.
   *
   * A process that makes no syscall never reaches the hook, and a process
   * blocked in a syscall the kernel has not completed does not either. Both
   * end here, and the machine resumes.
   */
  readonly unwindTimeoutMs: number;
  /**
   * Cap on the wait for in-flight vforks to resolve.
   *
   * `noteFailedExec` caps nothing, so a child looping on a failing `execve`
   * holds its parent for as long as it likes. T0.6 question 3.
   */
  readonly vforkTimeoutMs: number;
  /**
   * Run once the machine's bytes have been read, while it is still parked.
   *
   * A replica restores this checkpoint and replays the decision log from its
   * first entry, so the recorder has to start at exactly the state that was
   * read. Starting it after the capture returned would leave every decision
   * the machine made between the read and the resume in neither the state nor
   * the log. Throwing here fails the capture, and the machine still resumes.
   */
  readonly onRead?: () => void;
}

class CheckpointTimeout extends Error {}

/**
 * A launch raced the freeze; the capture gives the machine back and retries.
 *
 * This is the freeze answering the fork-during-freeze gap truthfully: the
 * launch is never refused (the guest would see a failure the read caused),
 * and the freeze never waits out a park that cannot complete.
 */
class CheckpointLaunchRace extends Error {}

const LAUNCH_RACE_RETRY_LIMIT = 10;

const LAUNCH_RACE_REASON =
  "a process launch (fork, exec, posix_spawn, or pthread start) arrived "
  + "while the freeze was parking the machine; the launch waits out the "
  + "freeze, so its process cannot park";

/**
 * `message` may be a function so a timeout can describe the state it found.
 * A reason built when the race was set up would name what was true before the
 * wait, which is the opposite of what the caller needs.
 */
function withTimeout(
  operation: Promise<unknown>,
  ms: number,
  message: string | (() => string),
): Promise<void> {
  let handle: ReturnType<typeof setTimeout>;
  const expiry = new Promise<never>((_resolve, reject) => {
    handle = setTimeout(
      () =>
        reject(
          new CheckpointTimeout(
            typeof message === "string" ? message : message(),
          ),
        ),
      ms,
    );
  });
  return Promise.race([operation, expiry])
    .then(() => undefined)
    .finally(() => clearTimeout(handle));
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Name the processes that had not reached UNWINDING, and what each was doing.
 *
 * A freeze fails because of particular processes, and a caller cannot find
 * them from a count. A real machine runs an init, a shell, and the program
 * the user came for at the same time, so `argv[0]` says which program is
 * holding the machine and the phase says how far its freeze reached.
 */
function describeUnwindStragglers(
  sources: readonly CheckpointProcessSource[],
): string {
  const stuck = sources
    .filter((source) => source.checkpointFreeze.currentPhase !== "unwound")
    .map(
      (source) =>
        `pid ${source.pid} (${source.argv[0] ?? "unknown"}) is `
        + source.checkpointFreeze.currentPhase,
    );
  const reason = "a process did not reach UNWINDING before the checkpoint "
    + "freeze timed out";
  // Every process can report unwound between the expiry and this line. Say so
  // rather than print an empty list that reads like a missing diagnostic.
  if (stuck.length === 0) return `${reason}, then every process unwound`;
  return `${reason}: ${stuck.join(", ")}`;
}

/**
 * Run the freeze, read the machine, and give the machine back.
 *
 * Every leg is reversible, so a timeout or a failure resumes rather than
 * poisons. The caller is told which happened; nothing here reports a capture
 * it did not take.
 */
export async function captureMachineCheckpoint(
  machine: CheckpointMachine,
  options: CheckpointFreezeOptions,
): Promise<CheckpointFreezeResult> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await machine.runWithoutWorkerCreation(
        "checkpoint freeze",
        () => machine.runWithoutRootfsMutation(
          () => freezeAndRead(machine, options),
        ),
      );
    } catch (error) {
      if (error instanceof CheckpointLaunchRace) {
        // Exclusivity was just given back, so the queued launch runs now and
        // the next attempt's drain waits for it. A machine that launches
        // faster than the freeze can park is reported, not waited out.
        if (attempt < LAUNCH_RACE_RETRY_LIMIT) continue;
        return { status: "failed", reason: error.message };
      }
      if (error instanceof CheckpointTimeout) {
        return { status: "timed-out", reason: error.message };
      }
      return { status: "failed", reason: describe(error) };
    }
  }
}

/**
 * Take a checkpoint and describe it, which is what a host port can carry.
 *
 * Both kernel-worker entries call exactly this, so a checkpoint request means
 * the same thing on Node and in a browser.
 */
export async function captureMachineCheckpointSummary(
  machine: CheckpointMachine,
  options: CheckpointFreezeOptions,
): Promise<CheckpointCaptureResponse> {
  const result = await captureMachineCheckpoint(machine, options);
  if (result.status !== "captured") return result;
  return {
    status: "captured",
    summary: summarizeMachineCheckpoint(result.checkpoint),
  };
}

async function freezeAndRead(
  machine: CheckpointMachine,
  options: CheckpointFreezeOptions,
): Promise<CheckpointFreezeResult> {
  const armed: CheckpointProcessSource[] = [];
  let unwound = false;
  let held = false;
  let unreleased: number[] = [];
  let checkpoint: MachineCheckpoint | undefined;
  let sawQueuedLaunch: (() => void) | undefined;
  const queuedLaunch = new Promise<never>((_resolve, reject) => {
    sawQueuedLaunch = () => reject(new CheckpointLaunchRace(LAUNCH_RACE_REASON));
  });
  // The race can settle on the other side first; a later launch rejection
  // must not surface as an unhandled rejection.
  void queuedLaunch.catch(() => undefined);
  const offQueuedLaunch = sawQueuedLaunch
    ? machine.onLaunchQueuedDuringFreeze?.(sawQueuedLaunch)
    : undefined;
  let sources: readonly CheckpointProcessSource[] = [];
  try {
    // A launch can have queued between the gate turning exclusive and this
    // listener attaching; its process is parked inside the launch already.
    // The vfork settle races the same signal: a vfork child settles its
    // borrow by exec or exit, and that exec is itself a launch that queues
    // behind this freeze — waiting out the settle would wait on it.
    if (machine.hasQueuedLaunch?.()) {
      throw new CheckpointLaunchRace(LAUNCH_RACE_REASON);
    }
    await withTimeout(
      Promise.race([machine.settleActiveVforkBorrows(), queuedLaunch]),
      options.vforkTimeoutMs,
      "a vfork borrow did not resolve before the checkpoint freeze timed out",
    );

    // The borrow set is read after it settles: a vfork child shares its
    // parent's address space, so "one memory per execution generation" only
    // holds here.
    sources = machine.liveProcesses();
    for (const source of sources) {
      source.checkpointFreeze.arm();
      armed.push(source);
    }
    machine.armUnwindRequests();
    await withTimeout(
      Promise.race([
        Promise.all(
          armed.map((source) => source.checkpointFreeze.waitUntilUnwound()),
        ),
        queuedLaunch,
      ]),
      options.unwindTimeoutMs,
      () => describeUnwindStragglers(armed),
    );
    unwound = true;

    // Every process is parked with its frames in its own linear memory. Leg 1
    // closes the last of the dispatch surface — a straggler mailbox, a
    // completion the kernel prepared meanwhile — before any byte is read.
    machine.holdProcessDispatch();
    held = true;
    checkpoint = readMachine(machine, armed);
    options.onRead?.();
  } finally {
    offQueuedLaunch?.();
    machine.disarmUnwindRequests();
    if (held) unreleased = await machine.releaseProcessDispatch();
    for (const source of armed) {
      const freeze = source.checkpointFreeze;
      // A process can die between its unwind report and this line, which
      // abandons its coordinator from the teardown path. Resume only what is
      // still parked; abandoning anything else is idempotent.
      if (unwound && freeze.currentPhase === "unwound") freeze.resume();
      else freeze.abandon();
    }
  }

  // A participant can be abandoned between its unwind report and the end of the
  // read — a thread that dies there is the known case. Nothing rejects in that
  // window, so the torn attempt is only visible as a coordinator that never
  // reached `resumed`.
  const torn = armed.filter(
    (source) => source.checkpointFreeze.currentPhase !== "resumed",
  );
  if (torn.length > 0) {
    return {
      status: "failed",
      reason:
        "checkpoint freeze read a machine that stopped being whole: "
        + torn
          .map((source) =>
            source.checkpointFreeze.abandonReason?.message
            ?? `pid=${source.pid} was abandoned during the read`)
          .join("; "),
    };
  }

  if (unreleased.length > 0) {
    // The bytes are real, but the machine they came from is not whole. Report
    // the boundary rather than hand back a checkpoint and a stuck keeper.
    return {
      status: "failed",
      reason:
        "checkpoint freeze could not release dispatch for pids "
        + unreleased.join(", "),
    };
  }
  return { status: "captured", checkpoint: checkpoint! };
}

/**
 * Recall stale checkpoint-unwind requests from one copied process memory.
 *
 * The read happens while the freeze is still armed, so a channel word that a
 * completion republished after the guest cleared it travels in the bytes.
 * `disarmCheckpointUnwind` recalls those words on the machine that resumes;
 * this is the same recall for the machine a restore boots — a restored guest
 * that read the leftover unwind bit would begin a capture with no freeze to
 * resume it, and park forever. The restart bit stays for the same reason the
 * disarm keeps it: the guest is owed the syscall it was making.
 */
function recallCheckpointRequests(
  memory: Uint8Array,
  channelOffsets: readonly number[],
): void {
  const view = new DataView(memory.buffer, memory.byteOffset, memory.byteLength);
  for (const channelOffset of channelOffsets) {
    const address = channelOffset + CH_CHECKPOINT_REQUEST;
    const published = view.getUint32(address, true);
    view.setUint32(address, published & CH_CHECKPOINT_REQUEST_RESTART, true);
  }
}

function readMachine(
  machine: CheckpointMachine,
  sources: readonly CheckpointProcessSource[],
): MachineCheckpoint {
  const mounts = machine.filesystemBuffers();
  return {
    format: MACHINE_CHECKPOINT_FORMAT,
    kernelAbiVersion: machine.kernelAbiVersion(),
    kernelMemory: machine.copyKernelMemory(),
    filesystems: mounts.flatMap((mount) =>
      mount.bytes.kind === "bytes"
        ? [{
          mountPoint: mount.mountPoint,
          bytes: new Uint8Array(mount.bytes.buffer).slice(),
        }]
        : []
    ),
    unreadableFilesystems: mounts.flatMap((mount) =>
      mount.bytes.kind === "none"
        ? [{ mountPoint: mount.mountPoint, reason: mount.bytes.reason }]
        : []
    ),
    monotonicNs: machine.monotonicNowNs(),
    framebuffers: machine.framebuffers().map((framebuffer) => ({
      ...framebuffer,
      hostBuffer: framebuffer.hostBuffer === null
        ? null
        : framebuffer.hostBuffer.slice(),
    })),
    kms: machine.kmsState(),
    gl: machine.glContexts(),
    processes: sources.map((source) => {
      const memory = new Uint8Array(source.memory.buffer).slice();
      const threads = source.threads();
      recallCheckpointRequests(memory, [
        source.channelOffset,
        ...threads.map((thread) => thread.channelOffset),
      ]);
      return {
        pid: source.pid,
        executionGeneration: source.executionGeneration,
        ptrWidth: source.ptrWidth,
        channelOffset: source.channelOffset,
        layout: source.layout,
        argv: [...source.argv],
        env: [...source.env],
        memory,
        programBytes: source.programBytes(),
        threadAllocator: source.threadAllocatorState(),
        threads,
        ...(source.forkReplayContext
          ? { forkReplayContext: source.forkReplayContext }
          : {}),
      };
    }),
  };
}
