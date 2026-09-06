import {
  PCM_FORMAT_S16_BE,
  PCM_FORMAT_S16_LE,
  PCM_FORMAT_U8,
  PCM_FORMAT_UNKNOWN,
  PCM_FLAG_CONFIGURING,
  PCM_FLAG_FATAL_ERROR,
  PCM_FLAG_UNDERRUN_ACTIVE,
  PCM_SHARED_CONTROL_FIELDS,
  PCM_STATE_CLOSED,
  PCM_STATE_DRAINING,
  PCM_STATE_RUNNING,
  PCM_STATE_STOPPED,
  PCM_TRANSPORT_HEADER_BYTES,
  PCM_TRANSPORT_LEGACY_PULL,
  PCM_TRANSPORT_MAGIC,
  PCM_TRANSPORT_RING_BYTES,
  PCM_TRANSPORT_SHARED_CLOCK,
  PCM_TRANSPORT_UNCLAIMED,
  PCM_TRANSPORT_VERSION,
} from "../generated/abi.js";

/**
 * Shared kernel/host PCM transport.
 *
 * The control header lives in the kernel's shared WebAssembly memory. Rust is
 * the sole writer for stream configuration and the producer cursor; the host
 * sink is the sole writer for the consumer cursor. Cursor halves are guarded
 * by 32-bit sequence counters so AudioWorklet code never depends on 64-bit JS
 * atomics.
 */

export const PCM_CONTROL_MAGIC = PCM_TRANSPORT_MAGIC;
export const PCM_CONTROL_VERSION = PCM_TRANSPORT_VERSION;
export const PCM_CONTROL_BYTES = PCM_TRANSPORT_HEADER_BYTES;
export const PCM_PHYSICAL_CAPACITY_BYTES = PCM_TRANSPORT_RING_BYTES;

/** Word indices within the fixed-width control header. */
export const PCM_CONTROL = {
  magic: PCM_SHARED_CONTROL_FIELDS.magic.offset / 4,
  version: PCM_SHARED_CONTROL_FIELDS.version.offset / 4,
  headerBytes: PCM_SHARED_CONTROL_FIELDS.headerBytes.offset / 4,
  physicalCapacityBytes:
    PCM_SHARED_CONTROL_FIELDS.physicalCapacityBytes.offset / 4,
  activeCapacityBytes: PCM_SHARED_CONTROL_FIELDS.activeCapacityBytes.offset / 4,
  format: PCM_SHARED_CONTROL_FIELDS.format.offset / 4,
  sampleRate: PCM_SHARED_CONTROL_FIELDS.sampleRate.offset / 4,
  channels: PCM_SHARED_CONTROL_FIELDS.channels.offset / 4,
  frameBytes: PCM_SHARED_CONTROL_FIELDS.frameBytes.offset / 4,
  fragmentBytes: PCM_SHARED_CONTROL_FIELDS.fragmentBytes.offset / 4,
  fragments: PCM_SHARED_CONTROL_FIELDS.fragments.offset / 4,
  state: PCM_SHARED_CONTROL_FIELDS.state.offset / 4,
  generation: PCM_SHARED_CONTROL_FIELDS.generation.offset / 4,
  flags: PCM_SHARED_CONTROL_FIELDS.flags.offset / 4,
  transportMode: PCM_SHARED_CONTROL_FIELDS.transportMode.offset / 4,
  producerSeq: PCM_SHARED_CONTROL_FIELDS.producerSeq.offset / 4,
  producerLo: PCM_SHARED_CONTROL_FIELDS.producerLo.offset / 4,
  producerHi: PCM_SHARED_CONTROL_FIELDS.producerHi.offset / 4,
  consumerSeq: PCM_SHARED_CONTROL_FIELDS.consumerSeq.offset / 4,
  consumerLo: PCM_SHARED_CONTROL_FIELDS.consumerLo.offset / 4,
  consumerHi: PCM_SHARED_CONTROL_FIELDS.consumerHi.offset / 4,
  discardSeq: PCM_SHARED_CONTROL_FIELDS.discardSeq.offset / 4,
  discardLo: PCM_SHARED_CONTROL_FIELDS.discardLo.offset / 4,
  discardHi: PCM_SHARED_CONTROL_FIELDS.discardHi.offset / 4,
  underruns: PCM_SHARED_CONTROL_FIELDS.underruns.offset / 4,
  wakeSeq: PCM_SHARED_CONTROL_FIELDS.wakeSeq.offset / 4,
} as const;

/** Implementation-neutral formats presented to host sinks. */
export const PcmSampleFormat = {
  Unknown: PCM_FORMAT_UNKNOWN,
  U8: PCM_FORMAT_U8,
  S16Le: PCM_FORMAT_S16_LE,
  S16Be: PCM_FORMAT_S16_BE,
} as const;
export type PcmSampleFormat =
  (typeof PcmSampleFormat)[keyof typeof PcmSampleFormat];

export const PcmStreamState = {
  Closed: PCM_STATE_CLOSED,
  Stopped: PCM_STATE_STOPPED,
  Running: PCM_STATE_RUNNING,
  Draining: PCM_STATE_DRAINING,
} as const;
export type PcmStreamState =
  (typeof PcmStreamState)[keyof typeof PcmStreamState];

export const PcmTransportMode = {
  Unclaimed: PCM_TRANSPORT_UNCLAIMED,
  LegacyPull: PCM_TRANSPORT_LEGACY_PULL,
  SharedClock: PCM_TRANSPORT_SHARED_CLOCK,
} as const;
export type PcmTransportMode =
  (typeof PcmTransportMode)[keyof typeof PcmTransportMode];

export const PcmTransportFlag = {
  Configuring: PCM_FLAG_CONFIGURING,
  UnderrunActive: PCM_FLAG_UNDERRUN_ACTIVE,
  FatalError: PCM_FLAG_FATAL_ERROR,
} as const;

export interface PcmTransportDescriptor {
  buffer: SharedArrayBuffer;
  controlOffset: number;
  controlBytes: number;
  dataOffset: number;
  dataBytes: number;
}

export interface PcmTransportConfig {
  activeCapacityBytes: number;
  format: PcmSampleFormat;
  sampleRate: number;
  channels: number;
  frameBytes: number;
  fragmentBytes: number;
  fragments: number;
  state: PcmStreamState;
  generation: number;
  flags: number;
}

export function pcmControlWords(
  descriptor: PcmTransportDescriptor,
): Int32Array<SharedArrayBuffer> {
  validateDescriptorBounds(descriptor);
  return new Int32Array(
    descriptor.buffer,
    descriptor.controlOffset,
    descriptor.controlBytes / Int32Array.BYTES_PER_ELEMENT,
  );
}

export function pcmDataBytes(
  descriptor: PcmTransportDescriptor,
): Uint8Array<SharedArrayBuffer> {
  validateDescriptorBounds(descriptor);
  return new Uint8Array(
    descriptor.buffer,
    descriptor.dataOffset,
    descriptor.dataBytes,
  );
}

export function validatePcmTransport(descriptor: PcmTransportDescriptor): void {
  const words = pcmControlWords(descriptor);
  const magic = loadU32(words, PCM_CONTROL.magic);
  const version = loadU32(words, PCM_CONTROL.version);
  const headerBytes = loadU32(words, PCM_CONTROL.headerBytes);
  const capacityBytes = loadU32(words, PCM_CONTROL.physicalCapacityBytes);
  if (magic !== PCM_CONTROL_MAGIC) {
    throw new Error(`PCM transport has invalid magic 0x${magic.toString(16)}`);
  }
  if (version !== PCM_CONTROL_VERSION) {
    throw new Error(
      `PCM transport version ${version} is not supported (expected ${PCM_CONTROL_VERSION})`,
    );
  }
  if (
    headerBytes !== PCM_CONTROL_BYTES ||
    headerBytes > descriptor.controlBytes
  ) {
    throw new Error(
      `PCM transport header is ${headerBytes} bytes (expected ${PCM_CONTROL_BYTES})`,
    );
  }
  if (capacityBytes !== descriptor.dataBytes) {
    throw new Error(
      `PCM transport capacity ${capacityBytes} does not match descriptor ${descriptor.dataBytes}`,
    );
  }
}

export function readPcmConfig(words: Int32Array): PcmTransportConfig {
  for (;;) {
    const flagsBefore = loadU32(words, PCM_CONTROL.flags);
    if ((flagsBefore & PcmTransportFlag.Configuring) !== 0) continue;
    const generation = loadU32(words, PCM_CONTROL.generation);
    const config = {
      activeCapacityBytes: loadU32(words, PCM_CONTROL.activeCapacityBytes),
      format: loadU32(words, PCM_CONTROL.format) as PcmSampleFormat,
      sampleRate: loadU32(words, PCM_CONTROL.sampleRate),
      channels: loadU32(words, PCM_CONTROL.channels),
      frameBytes: loadU32(words, PCM_CONTROL.frameBytes),
      fragmentBytes: loadU32(words, PCM_CONTROL.fragmentBytes),
      fragments: loadU32(words, PCM_CONTROL.fragments),
      state: loadU32(words, PCM_CONTROL.state) as PcmStreamState,
      generation,
      flags: flagsBefore,
    };
    const generationAfter = loadU32(words, PCM_CONTROL.generation);
    const flagsAfter = loadU32(words, PCM_CONTROL.flags);
    if (
      generationAfter === generation &&
      (flagsAfter & PcmTransportFlag.Configuring) === 0
    ) {
      config.flags = flagsAfter;
      return config;
    }
  }
}

export function isPcmGenerationCurrent(
  words: Int32Array,
  generation: number,
): boolean {
  const before = loadU32(words, PCM_CONTROL.generation);
  const flags = loadU32(words, PCM_CONTROL.flags);
  const after = loadU32(words, PCM_CONTROL.generation);
  return (
    before === generation &&
    after === generation &&
    (flags & PcmTransportFlag.Configuring) === 0
  );
}

export function markPcmFatalError(words: Int32Array): void {
  Atomics.and(words, PCM_CONTROL.flags, ~PcmTransportFlag.UnderrunActive);
  Atomics.or(words, PCM_CONTROL.flags, PcmTransportFlag.FatalError);
  signalPcmConsumerProgress(words);
}

export function hasPcmFatalError(words: Int32Array): boolean {
  return (
    (loadU32(words, PCM_CONTROL.flags) & PcmTransportFlag.FatalError) !== 0
  );
}

export function readProducerPosition(words: Int32Array): bigint {
  return readSeqlockedU64(
    words,
    PCM_CONTROL.producerSeq,
    PCM_CONTROL.producerLo,
    PCM_CONTROL.producerHi,
  );
}

export function readConsumerPosition(words: Int32Array): bigint {
  return readSeqlockedU64(
    words,
    PCM_CONTROL.consumerSeq,
    PCM_CONTROL.consumerLo,
    PCM_CONTROL.consumerHi,
  );
}

export function readDiscardPosition(words: Int32Array): bigint {
  return readSeqlockedU64(
    words,
    PCM_CONTROL.discardSeq,
    PCM_CONTROL.discardLo,
    PCM_CONTROL.discardHi,
  );
}

export function readEffectiveConsumerPosition(words: Int32Array): bigint {
  const consumer = readConsumerPosition(words);
  const discard = readDiscardPosition(words);
  const producer = readProducerPosition(words);
  const effective = consumer > discard ? consumer : discard;
  return effective > producer ? producer : effective;
}

export function writeConsumerPosition(words: Int32Array, value: bigint): void {
  writeSeqlockedU64(
    words,
    PCM_CONTROL.consumerSeq,
    PCM_CONTROL.consumerLo,
    PCM_CONTROL.consumerHi,
    value,
  );
}

/**
 * Raise the discard floor, making every byte below `value` unreachable.
 *
 * The kernel worker calls this on the same thread every kernel entry runs
 * on, so it cannot race Rust's own discard writes; the seqlock covers the
 * consumer-side readers.
 */
export function writeDiscardPosition(words: Int32Array, value: bigint): void {
  writeSeqlockedU64(
    words,
    PCM_CONTROL.discardSeq,
    PCM_CONTROL.discardLo,
    PCM_CONTROL.discardHi,
    value,
  );
}

export function signalPcmConsumerProgress(words: Int32Array): void {
  Atomics.add(words, PCM_CONTROL.wakeSeq, 1);
  // The persistent kernel observer and a bounded teardown drain may both be
  // waiting on the same one-shot cursor transition. Wake every waiter: the
  // sequence check below each wait decides which work remains relevant.
  Atomics.notify(words, PCM_CONTROL.wakeSeq);
}

export function readRingBytes(
  ring: Uint8Array,
  absoluteOffset: bigint,
  length: number,
): Uint8Array {
  const out = new Uint8Array(length);
  if (length === 0 || ring.byteLength === 0) return out;
  let offset = Number(absoluteOffset % BigInt(ring.byteLength));
  let copied = 0;
  while (copied < length) {
    const chunk = Math.min(length - copied, ring.byteLength - offset);
    out.set(ring.subarray(offset, offset + chunk), copied);
    copied += chunk;
    offset = 0;
  }
  return out;
}

export function loadU32(words: Int32Array, index: number): number {
  return Atomics.load(words, index) >>> 0;
}

export function storeU32(
  words: Int32Array,
  index: number,
  value: number,
): void {
  Atomics.store(words, index, value | 0);
}

export function readSeqlockedU64(
  words: Int32Array,
  seqIndex: number,
  loIndex: number,
  hiIndex: number,
): bigint {
  for (;;) {
    const before = loadU32(words, seqIndex);
    if ((before & 1) !== 0) continue;
    const lo = loadU32(words, loIndex);
    const hi = loadU32(words, hiIndex);
    const after = loadU32(words, seqIndex);
    if (before === after && (after & 1) === 0) {
      return (BigInt(hi) << 32n) | BigInt(lo);
    }
  }
}

export function writeSeqlockedU64(
  words: Int32Array,
  seqIndex: number,
  loIndex: number,
  hiIndex: number,
  value: bigint,
): void {
  Atomics.add(words, seqIndex, 1);
  storeU32(words, loIndex, Number(value & 0xffff_ffffn));
  storeU32(words, hiIndex, Number((value >> 32n) & 0xffff_ffffn));
  Atomics.add(words, seqIndex, 1);
}

function validateDescriptorBounds(descriptor: PcmTransportDescriptor): void {
  if (!(descriptor.buffer instanceof SharedArrayBuffer)) {
    throw new TypeError("PCM transport requires SharedArrayBuffer");
  }
  for (const [name, value] of Object.entries({
    controlOffset: descriptor.controlOffset,
    controlBytes: descriptor.controlBytes,
    dataOffset: descriptor.dataOffset,
    dataBytes: descriptor.dataBytes,
  })) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RangeError(`PCM transport ${name} is invalid: ${value}`);
    }
  }
  if (
    (descriptor.controlOffset & 3) !== 0 ||
    (descriptor.controlBytes & 3) !== 0
  ) {
    throw new RangeError("PCM control header must be 32-bit aligned");
  }
  if (
    descriptor.controlOffset + descriptor.controlBytes >
      descriptor.buffer.byteLength ||
    descriptor.dataOffset + descriptor.dataBytes > descriptor.buffer.byteLength
  ) {
    throw new RangeError("PCM transport lies outside shared kernel memory");
  }
}
