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

  const modules = new Map<number, WebAssembly.Module>();
  for (const bucket of checkpoint.processes) {
    if (modules.has(bucket.pid)) {
      refuse(`pid ${bucket.pid} appears in more than one process bucket`);
    }
    modules.set(bucket.pid, await validateProcessBucket(bucket));
  }
  return modules;
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
