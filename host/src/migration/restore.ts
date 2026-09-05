import { detectPtrWidth, WASM_PAGE_SIZE } from "../constants";
import { CH_TOTAL_SIZE } from "../generated/abi";
import {
  FORK_CAP_ACTIVATION_STATE_SAFE,
  readForkInstrumentCapabilityClaim,
} from "../dylink";
import { readForkContinuationAnchor } from "../fork-continuation";
import { FORK_SAVE_BUFFER_SIZE } from "../process-memory";
import {
  MACHINE_CHECKPOINT_FORMAT,
  type CheckpointProcessBucket,
  type MachineCheckpoint,
} from "./checkpoint";

/**
 * Refuse an untrusted checkpoint, on either host.
 *
 * A checkpoint arriving over a peer link carries kernel memory, process
 * memory, and program images, so it is the same input class as a boot
 * descriptor and a far more powerful one. A receiver validates everything it
 * can prove without instantiating any of it, and refuses with the exact
 * boundary that failed. The checks reuse the validators the local fork path
 * already trusts — `readForkContinuationAnchor` for the continuation root
 * geometry, `readForkInstrumentCapabilityClaim` for the activation-state
 * capability — rather than growing a second set that can drift.
 */
export class CheckpointRefusedError extends Error {}

function refuse(reason: string): never {
  throw new CheckpointRefusedError(`checkpoint refused: ${reason}`);
}

/**
 * Validate a checkpoint before any of it is instantiated.
 *
 * Compiling a bucket's program is validation, not instantiation: no import is
 * called and no memory is attached. The compiled modules are returned keyed
 * by pid so the boot path that accepts the checkpoint does not compile the
 * same bytes twice.
 */
export async function validateMachineCheckpoint(
  checkpoint: MachineCheckpoint,
  expected: { readonly kernelAbiVersion: number },
): Promise<ReadonlyMap<number, WebAssembly.Module>> {
  if (checkpoint.format !== MACHINE_CHECKPOINT_FORMAT) {
    refuse(
      `unknown checkpoint format ${String(checkpoint.format)}; `
      + `this host reads format ${MACHINE_CHECKPOINT_FORMAT}`,
    );
  }
  if (checkpoint.kernelAbiVersion !== expected.kernelAbiVersion) {
    refuse(
      `kernel ABI ${String(checkpoint.kernelAbiVersion)} does not match `
      + `this host's ABI ${expected.kernelAbiVersion}`,
    );
  }
  if (
    checkpoint.kernelMemory.byteLength === 0
    || checkpoint.kernelMemory.byteLength % WASM_PAGE_SIZE !== 0
  ) {
    refuse(
      `kernel memory is ${checkpoint.kernelMemory.byteLength} bytes, `
      + `not a whole number of pages`,
    );
  }
  if (checkpoint.filesystem.byteLength === 0) {
    refuse("the filesystem buffer is empty");
  }
  if (
    !Number.isSafeInteger(checkpoint.monotonicNs)
    || checkpoint.monotonicNs < 0
  ) {
    refuse(
      `the captured monotonic clock ${String(checkpoint.monotonicNs)} `
      + "is unusable",
    );
  }

  const modules = new Map<number, WebAssembly.Module>();
  for (const bucket of checkpoint.processes) {
    if (modules.has(bucket.pid)) {
      refuse(`pid ${bucket.pid} appears in more than one process bucket`);
    }
    modules.set(bucket.pid, await validateProcessBucket(bucket));
  }

  if (!Array.isArray(checkpoint.framebuffers)) {
    refuse("the checkpoint carries no framebuffer list");
  }
  const framebufferPids = new Set<number>();
  for (const framebuffer of checkpoint.framebuffers) {
    validateFramebuffer(
      framebuffer,
      checkpoint.processes.find((bucket) => bucket.pid === framebuffer.pid),
    );
    if (framebufferPids.has(framebuffer.pid)) {
      refuse(`pid ${framebuffer.pid} carries two framebuffer bindings`);
    }
    framebufferPids.add(framebuffer.pid);
  }
  validateKmsState(checkpoint.kms, checkpoint.processes);
  return modules;
}

/**
 * Refuse a modeset display the receiver cannot rebuild faithfully.
 *
 * A CRTC binding outlives `rmFb` on its framebuffer, so a CRTC naming an
 * absent `fb_id` is DRM-correct and accepted. Everything else must close: a
 * framebuffer names a buffer that travels, a buffer's pixels fill it, and a
 * mapped range fits the memory of a process the checkpoint carries.
 */
function validateKmsState(
  kms: MachineCheckpoint["kms"],
  processes: readonly CheckpointProcessBucket[],
): void {
  if (kms === null || typeof kms !== "object") {
    refuse("the checkpoint carries no KMS state");
  }
  if (
    !Array.isArray(kms.fbs)
    || !Array.isArray(kms.crtcs)
    || !Array.isArray(kms.buffers)
  ) {
    refuse("the KMS state is not a framebuffer, CRTC, and buffer list");
  }

  const bufferIds = new Set<number>();
  for (const buffer of kms.buffers) {
    const geometryUsable = [buffer.bo_id, buffer.size, buffer.w, buffer.h, buffer.stride]
      .every((value) => Number.isSafeInteger(value) && value >= 0);
    if (!geometryUsable || buffer.w === 0 || buffer.h === 0 || buffer.stride < buffer.w * 4) {
      refuse(`buffer object ${String(buffer.bo_id)}'s geometry is unusable`);
    }
    if (bufferIds.has(buffer.bo_id)) {
      refuse(`buffer object ${buffer.bo_id} appears twice`);
    }
    bufferIds.add(buffer.bo_id);
    if (buffer.size < buffer.h * buffer.stride) {
      refuse(
        `buffer object ${buffer.bo_id} is ${buffer.size} bytes, `
        + `too small for a ${buffer.h}-row ${buffer.stride}-byte stride`,
      );
    }
    if (buffer.pixels.byteLength !== buffer.size) {
      refuse(
        `buffer object ${buffer.bo_id} carries ${buffer.pixels.byteLength} `
        + `pixel bytes for a ${buffer.size}-byte buffer`,
      );
    }
    if (buffer.pids.length === 0) {
      refuse(`buffer object ${buffer.bo_id} is held by no process`);
    }
    for (const pid of buffer.pids) {
      if (!processes.some((bucket) => bucket.pid === pid)) {
        refuse(
          `buffer object ${buffer.bo_id} is held by pid ${String(pid)}, `
          + "which has no process bucket",
        );
      }
    }
    for (const binding of buffer.bindings) {
      const bucket = processes.find((candidate) => candidate.pid === binding.pid);
      if (bucket === undefined) {
        refuse(
          `buffer object ${buffer.bo_id} is mapped by pid ${String(binding.pid)}, `
          + "which has no process bucket",
        );
      }
      const rangeUsable = [binding.addr, binding.len].every(
        (value) => Number.isSafeInteger(value) && value >= 0,
      );
      if (!rangeUsable || binding.len === 0 || binding.addr + binding.len > bucket.memory.byteLength) {
        refuse(
          `buffer object ${buffer.bo_id}'s mapping in pid ${binding.pid} does `
          + `not fit inside its ${bucket.memory.byteLength}-byte memory`,
        );
      }
    }
  }

  const fbIds = new Set<number>();
  for (const fb of kms.fbs) {
    const geometryUsable = [fb.fb_id, fb.bo_id, fb.width, fb.height, fb.pitch]
      .every((value) => Number.isSafeInteger(value) && value >= 0);
    if (!geometryUsable || fb.width === 0 || fb.height === 0 || fb.pitch < fb.width * 4) {
      refuse(`framebuffer ${String(fb.fb_id)}'s geometry is unusable`);
    }
    if (fbIds.has(fb.fb_id)) refuse(`framebuffer ${fb.fb_id} appears twice`);
    fbIds.add(fb.fb_id);
    if (!bufferIds.has(fb.bo_id)) {
      refuse(
        `framebuffer ${fb.fb_id} scans out buffer object ${fb.bo_id}, `
        + "which the checkpoint does not carry",
      );
    }
  }

  const crtcIds = new Set<number>();
  for (const crtc of kms.crtcs) {
    if (!Number.isSafeInteger(crtc.crtc_id) || !Number.isSafeInteger(crtc.fb_id)) {
      refuse(`a CRTC binding names ${String(crtc.crtc_id)} and ${String(crtc.fb_id)}`);
    }
    if (crtcIds.has(crtc.crtc_id)) {
      refuse(`CRTC ${crtc.crtc_id} is bound twice`);
    }
    crtcIds.add(crtc.crtc_id);
  }

  if (kms.masterPid === null) return;
  if (!processes.some((bucket) => bucket.pid === kms.masterPid)) {
    refuse(
      `DRM master is pid ${String(kms.masterPid)}, which has no process bucket`,
    );
  }
}

/**
 * Refuse a framebuffer record the receiver cannot rebind faithfully.
 *
 * A write-based binding (the `addr === 0 && len === 0` sentinel) must carry
 * exactly one frame of pixels; an mmap-based binding must name a range inside
 * its process's memory and carries no host pixels — they ride in the memory
 * copy.
 */
function validateFramebuffer(
  framebuffer: MachineCheckpoint["framebuffers"][number],
  bucket: CheckpointProcessBucket | undefined,
): void {
  const { pid, addr, len, w, h, stride, hostBuffer } = framebuffer;
  if (bucket === undefined) {
    refuse(`a framebuffer names pid ${pid}, which has no process bucket`);
  }
  const dimensionsUsable = [addr, len, w, h, stride].every(
    (value) => Number.isSafeInteger(value) && value >= 0,
  );
  if (!dimensionsUsable || w === 0 || h === 0 || stride < w * 4) {
    refuse(`pid ${pid}'s framebuffer geometry is unusable`);
  }
  const writeBased = addr === 0 && len === 0;
  if (writeBased) {
    if (hostBuffer === null || hostBuffer.byteLength !== h * stride) {
      refuse(
        `pid ${pid}'s write-based framebuffer carries `
        + `${hostBuffer?.byteLength ?? 0} pixel bytes for a `
        + `${h * stride}-byte frame`,
      );
    }
    return;
  }
  if (hostBuffer !== null) {
    refuse(
      `pid ${pid}'s mmap-based framebuffer carries host pixels; `
      + "its frame rides in the process memory copy",
    );
  }
  if (len === 0 || addr + len > bucket.memory.byteLength) {
    refuse(
      `pid ${pid}'s framebuffer range does not fit inside its `
      + `${bucket.memory.byteLength}-byte memory`,
    );
  }
}

async function validateProcessBucket(
  bucket: CheckpointProcessBucket,
): Promise<WebAssembly.Module> {
  const pid = bucket.pid;
  if (bucket.ptrWidth !== 4 && bucket.ptrWidth !== 8) {
    refuse(`pid ${pid} claims pointer width ${String(bucket.ptrWidth)}`);
  }
  const memory = bucket.memory;
  if (
    memory.byteOffset !== 0
    || memory.byteLength !== memory.buffer.byteLength
  ) {
    refuse(`pid ${pid}'s memory view does not cover its whole buffer`);
  }
  if (
    memory.byteLength === 0
    || memory.byteLength % WASM_PAGE_SIZE !== 0
  ) {
    refuse(
      `pid ${pid}'s memory is ${memory.byteLength} bytes, `
      + `not a whole number of pages`,
    );
  }
  if (
    !Number.isSafeInteger(bucket.channelOffset)
    || bucket.channelOffset <= FORK_SAVE_BUFFER_SIZE
    || bucket.channelOffset + CH_TOTAL_SIZE > memory.byteLength
  ) {
    refuse(
      `pid ${pid}'s syscall channel at ${String(bucket.channelOffset)} `
      + `does not fit inside its ${memory.byteLength}-byte memory`,
    );
  }

  const module = await WebAssembly.compile(bucket.programBytes).catch(
    (error: unknown) => refuse(
      `pid ${pid}'s program is not a WebAssembly module: `
      + (error instanceof Error ? error.message : String(error)),
    ),
  );
  const claim = (() => {
    try {
      return readForkInstrumentCapabilityClaim(module);
    } catch (error) {
      refuse(
        `pid ${pid}'s program carries a malformed capability claim: `
        + (error instanceof Error ? error.message : String(error)),
      );
    }
  })();
  if (!claim.present || (claim.flags & FORK_CAP_ACTIVATION_STATE_SAFE) === 0) {
    refuse(
      `pid ${pid}'s program does not claim activation-state-safe replay, `
      + `so a fresh instance cannot resume it`,
    );
  }
  if (detectPtrWidth(bucket.programBytes) !== bucket.ptrWidth) {
    refuse(
      `pid ${pid} claims pointer width ${bucket.ptrWidth} but its program `
      + `declares ${detectPtrWidth(bucket.programBytes)}`,
    );
  }

  try {
    readForkContinuationAnchor(
      { buffer: memory.buffer },
      bucket.channelOffset - FORK_SAVE_BUFFER_SIZE,
      bucket.ptrWidth,
    );
  } catch (error) {
    refuse(
      `pid ${pid}'s continuation root is unusable: `
      + (error instanceof Error ? error.message : String(error)),
    );
  }

  if (!Array.isArray(bucket.threads)) {
    refuse(`pid ${pid}'s bucket carries no thread list`);
  }
  if (bucket.threads.length !== bucket.threadAllocator.activeCount) {
    refuse(
      `pid ${pid} carries ${bucket.threads.length} thread record(s) but its `
      + `allocator holds ${bucket.threadAllocator.activeCount} live slot(s)`,
    );
  }
  const tids = new Set<number>();
  for (const thread of bucket.threads) {
    if (
      !Number.isSafeInteger(thread.tid)
      || thread.tid <= 0
      || thread.tid === pid
    ) {
      refuse(
        `pid ${pid} carries a thread with kernel TID ${String(thread.tid)}`,
      );
    }
    if (tids.has(thread.tid)) {
      refuse(`pid ${pid} carries kernel TID ${thread.tid} twice`);
    }
    tids.add(thread.tid);
    if (
      !Number.isSafeInteger(thread.channelOffset)
      || thread.channelOffset <= FORK_SAVE_BUFFER_SIZE
      || thread.channelOffset + CH_TOTAL_SIZE > memory.byteLength
      || thread.channelOffset === bucket.channelOffset
    ) {
      refuse(
        `pid ${pid} tid ${thread.tid}'s syscall channel at `
        + `${String(thread.channelOffset)} does not fit inside its `
        + `${memory.byteLength}-byte memory`,
      );
    }
    try {
      readForkContinuationAnchor(
        { buffer: memory.buffer },
        thread.channelOffset - FORK_SAVE_BUFFER_SIZE,
        bucket.ptrWidth,
      );
    } catch (error) {
      refuse(
        `pid ${pid} tid ${thread.tid}'s continuation root is unusable: `
        + (error instanceof Error ? error.message : String(error)),
      );
    }
  }
  return module;
}
