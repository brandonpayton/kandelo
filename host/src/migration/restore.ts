import { detectPtrWidth, WASM_PAGE_SIZE } from "../constants";
import {
  CH_TOTAL_SIZE,
  POSIX_ARG_MAX_BYTES,
  PROCESS_METADATA_ENTRY_MAX_BYTES,
  PROCESS_STARTUP_MAX_ARGV_COUNT,
  PROCESS_STARTUP_MAX_ENVP_COUNT,
} from "../generated/abi";
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
import {
  GL_FLOAT,
  GL_UNSIGNED_BYTE,
  glChannelCount,
  type CheckpointGlContext,
} from "../webgl/snapshot";

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

/** Cap on a mount refusal's text, which a restore prints unaltered. */
const MAX_GAP_REASON_LENGTH = 200;

function refuse(reason: string): never {
  throw new CheckpointRefusedError(`checkpoint refused: ${reason}`);
}

/**
 * What a restore must say about the filesystems it did not get.
 *
 * A gap does not refuse the checkpoint: a machine short `/tmp` is still worth
 * moving. It does have to be said out loud, because a restore that reports
 * nothing presents the machine as whole. `null` means every mount arrived.
 *
 * `dropped` names mounts the checkpoint carried that this host cannot accept,
 * which is the same gap seen from the other side: the sender read the bytes
 * and this receiver has nowhere memory-backed to put them.
 */
export function describeCheckpointMountGaps(
  checkpoint: MachineCheckpoint,
  dropped: readonly string[] = [],
): string | null {
  const parts = checkpoint.unreadableFilesystems.map(
    (gap) => `${gap.mountPoint} (${gap.reason})`,
  );
  for (const mountPoint of dropped) {
    parts.push(`${mountPoint} (this host has no memory-backed mount there)`);
  }
  if (parts.length === 0) return null;
  return `this machine was restored without ${parts.join(", ")}`;
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
  // A machine always has a root. Every other mount is optional, but a repeated
  // or relative mount point would leave the restore choosing which bytes win.
  const rootMount = checkpoint.filesystems.find(
    (mount) => mount.mountPoint === "/",
  );
  if (rootMount === undefined) {
    refuse("no / mount was captured");
  } else if (rootMount.bytes.byteLength === 0) {
    refuse("the / mount is empty");
  }
  const seenMountPoints = new Set<string>();
  for (const mount of checkpoint.filesystems) {
    if (!mount.mountPoint.startsWith("/")) {
      refuse(`mount point ${JSON.stringify(mount.mountPoint)} is not absolute`);
    }
    if (seenMountPoints.has(mount.mountPoint)) {
      refuse(`mount point ${JSON.stringify(mount.mountPoint)} appears twice`);
    }
    seenMountPoints.add(mount.mountPoint);
  }
  if (!Array.isArray(checkpoint.unreadableFilesystems)) {
    refuse("the checkpoint carries no unreadable-mount list");
  }
  for (const gap of checkpoint.unreadableFilesystems) {
    if (!gap.mountPoint.startsWith("/")) {
      refuse(
        `unreadable mount point ${JSON.stringify(gap.mountPoint)} `
        + "is not absolute",
      );
    }
    if (seenMountPoints.has(gap.mountPoint)) {
      refuse(
        `mount point ${JSON.stringify(gap.mountPoint)} is both carried and `
        + "unreadable",
      );
    }
    seenMountPoints.add(gap.mountPoint);
    // The reason is text a restore prints. A checkpoint arrives from a peer,
    // so cap it rather than relay an unbounded string into a diagnostic.
    if (gap.reason.length === 0 || gap.reason.length > MAX_GAP_REASON_LENGTH) {
      refuse(
        `the reason for unreadable mount ${JSON.stringify(gap.mountPoint)} `
        + `is ${gap.reason.length} characters`,
      );
    }
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
  if (!Array.isArray(checkpoint.gl)) {
    refuse("the checkpoint carries no GL context list");
  }
  const glPids = new Set<number>();
  for (const context of checkpoint.gl) {
    validateGlContext(
      context,
      checkpoint.processes.find((bucket) => bucket.pid === context.pid),
    );
    if (glPids.has(context.pid)) {
      refuse(`pid ${context.pid} carries two GL contexts`);
    }
    glPids.add(context.pid);
  }
  return modules;
}

/** Caps on a GL context a peer sent, far above anything a real guest makes. */
const MAX_GL_OBJECTS = 65_536;
const MAX_GL_TEXTURE_DIMENSION = 16_384;
const MAX_GL_SOURCE_LENGTH = 1_048_576;
const MAX_GL_UNIFORM_VALUES = 65_536;
const MAX_GL_BOUNDARY_LINES = 10_000;

function glBytesPerChannel(pixelsType: number): number | null {
  if (pixelsType === GL_UNSIGNED_BYTE) return 1;
  if (pixelsType === GL_FLOAT) return 4;
  return null;
}

/**
 * Refuse a GL context the receiver cannot rebuild faithfully.
 *
 * A GL context arrives inside a checkpoint from a peer, so every count,
 * range, and cross-reference is checked before anything touches a real
 * WebGL2 context. References must close within the context: a framebuffer
 * naming a texture the checkpoint does not carry cannot be rebuilt, and
 * accepting it would restore a machine whose render targets are silently
 * gone.
 */
function validateGlContext(
  context: CheckpointGlContext,
  bucket: CheckpointProcessBucket | undefined,
): void {
  const pid = context.pid;
  if (bucket === undefined) {
    refuse(`a GL context names pid ${String(pid)}, which has no process bucket`);
  }
  const rangeUsable = [context.cmdbufAddr, context.cmdbufLen].every(
    (value) => Number.isSafeInteger(value) && value >= 0,
  );
  if (
    !rangeUsable
    || context.cmdbufAddr + context.cmdbufLen > bucket.memory.byteLength
  ) {
    refuse(
      `pid ${pid}'s GL cmdbuf does not fit inside its `
        + `${bucket.memory.byteLength}-byte memory`,
    );
  }
  for (const list of [
    context.buffers,
    context.textures,
    context.shaders,
    context.programs,
    context.vaos,
    context.fbos,
    context.rbos,
    context.uniformLocationNames,
  ]) {
    if (!Array.isArray(list) || list.length > MAX_GL_OBJECTS) {
      refuse(`pid ${pid}'s GL context carries an unusable object list`);
    }
  }
  if (
    !Array.isArray(context.boundaries)
    || context.boundaries.length > MAX_GL_BOUNDARY_LINES
    || context.boundaries.some(
      (line) => typeof line !== "string" || line.length > 500,
    )
  ) {
    refuse(`pid ${pid}'s GL context carries an unusable boundary list`);
  }
  if (
    !Number.isSafeInteger(context.nextUniformLoc)
    || context.nextUniformLoc < 0
  ) {
    refuse(`pid ${pid}'s GL uniform-location counter is unusable`);
  }

  const bufferNames = new Set<number>();
  for (const buffer of context.buffers) {
    if (!Number.isSafeInteger(buffer.name) || bufferNames.has(buffer.name)) {
      refuse(`pid ${pid} carries GL buffer ${String(buffer.name)} twice`);
    }
    bufferNames.add(buffer.name);
    if (!(buffer.bytes instanceof Uint8Array)) {
      refuse(`pid ${pid}'s GL buffer ${buffer.name} carries no bytes`);
    }
  }
  const textureNames = new Set<number>();
  for (const texture of context.textures) {
    if (!Number.isSafeInteger(texture.name) || textureNames.has(texture.name)) {
      refuse(`pid ${pid} carries GL texture ${String(texture.name)} twice`);
    }
    textureNames.add(texture.name);
    if (!Array.isArray(texture.levels) || texture.levels.length > 32) {
      refuse(`pid ${pid}'s GL texture ${texture.name} carries an unusable level list`);
    }
    for (const level of texture.levels) {
      const geometryUsable = [level.level, level.width, level.height].every(
        (value) => Number.isSafeInteger(value) && value >= 0,
      );
      if (
        !geometryUsable
        || level.width > MAX_GL_TEXTURE_DIMENSION
        || level.height > MAX_GL_TEXTURE_DIMENSION
      ) {
        refuse(
          `pid ${pid}'s GL texture ${texture.name} level `
            + `${String(level.level)} has unusable geometry`,
        );
      }
      if (level.pixels === null) continue;
      const channels = glChannelCount(level.format);
      const bytesPerChannel = glBytesPerChannel(level.pixelsType);
      if (channels === null || bytesPerChannel === null) {
        refuse(
          `pid ${pid}'s GL texture ${texture.name} level ${level.level} `
            + "carries pixels in a shape this host does not read",
        );
      }
      const expected = level.width * level.height * channels * bytesPerChannel;
      if (
        !(level.pixels instanceof Uint8Array)
        || level.pixels.byteLength !== expected
      ) {
        refuse(
          `pid ${pid}'s GL texture ${texture.name} level ${level.level} `
            + `carries ${level.pixels?.byteLength ?? 0} pixel bytes for a `
            + `${expected}-byte level`,
        );
      }
    }
  }
  const shaderNames = new Set<number>();
  for (const shader of context.shaders) {
    if (!Number.isSafeInteger(shader.name) || shaderNames.has(shader.name)) {
      refuse(`pid ${pid} carries GL shader ${String(shader.name)} twice`);
    }
    shaderNames.add(shader.name);
    if (typeof shader.source !== "string" || shader.source.length > MAX_GL_SOURCE_LENGTH) {
      refuse(`pid ${pid}'s GL shader ${shader.name} carries an unusable source`);
    }
  }
  const programNames = new Set<number>();
  for (const program of context.programs) {
    if (!Number.isSafeInteger(program.name) || programNames.has(program.name)) {
      refuse(`pid ${pid} carries GL program ${String(program.name)} twice`);
    }
    programNames.add(program.name);
    if (!Array.isArray(program.shaders) || program.shaders.length > 16) {
      refuse(`pid ${pid}'s GL program ${program.name} carries an unusable shader list`);
    }
    for (const attached of program.shaders) {
      if (
        typeof attached.source !== "string"
        || attached.source.length > MAX_GL_SOURCE_LENGTH
      ) {
        refuse(
          `pid ${pid}'s GL program ${program.name} attaches an unusable source`,
        );
      }
      if (attached.shaderName !== null && !shaderNames.has(attached.shaderName)) {
        refuse(
          `pid ${pid}'s GL program ${program.name} attaches shader `
            + `${String(attached.shaderName)}, which the checkpoint does not carry`,
        );
      }
    }
    if (!Array.isArray(program.uniforms) || program.uniforms.length > MAX_GL_OBJECTS) {
      refuse(`pid ${pid}'s GL program ${program.name} carries an unusable uniform list`);
    }
    for (const uniform of program.uniforms) {
      if (
        typeof uniform.name !== "string"
        || uniform.name.length > 1024
        || !Array.isArray(uniform.values)
        || uniform.values.length > MAX_GL_UNIFORM_VALUES
        || uniform.values.some((value) => typeof value !== "number")
      ) {
        refuse(`pid ${pid}'s GL program ${program.name} carries an unusable uniform`);
      }
    }
    if (!Array.isArray(program.attribBindings) || program.attribBindings.length > 256) {
      refuse(`pid ${pid}'s GL program ${program.name} carries an unusable attribute list`);
    }
  }
  const rboNames = new Set<number>();
  for (const rbo of context.rbos) {
    if (!Number.isSafeInteger(rbo.name) || rboNames.has(rbo.name)) {
      refuse(`pid ${pid} carries GL renderbuffer ${String(rbo.name)} twice`);
    }
    rboNames.add(rbo.name);
  }
  const vaoNames = new Set<number>([0]);
  for (const vao of context.vaos) {
    if (!Number.isSafeInteger(vao.name) || (vao.name !== 0 && vaoNames.has(vao.name))) {
      refuse(`pid ${pid} carries GL vertex array ${String(vao.name)} twice`);
    }
    vaoNames.add(vao.name);
    if (
      vao.elementArrayBufferName !== null
      && !bufferNames.has(vao.elementArrayBufferName)
    ) {
      refuse(
        `pid ${pid}'s GL vertex array ${vao.name} indexes buffer `
          + `${String(vao.elementArrayBufferName)}, which the checkpoint does not carry`,
      );
    }
    if (!Array.isArray(vao.attribs) || vao.attribs.length > 256) {
      refuse(`pid ${pid}'s GL vertex array ${vao.name} carries an unusable attribute list`);
    }
    for (const attrib of vao.attribs) {
      if (attrib.bufferName !== null && !bufferNames.has(attrib.bufferName)) {
        refuse(
          `pid ${pid}'s GL vertex array ${vao.name} reads buffer `
            + `${String(attrib.bufferName)}, which the checkpoint does not carry`,
        );
      }
    }
  }
  const fboNames = new Set<number>();
  for (const fbo of context.fbos) {
    if (!Number.isSafeInteger(fbo.name) || fboNames.has(fbo.name)) {
      refuse(`pid ${pid} carries GL framebuffer ${String(fbo.name)} twice`);
    }
    fboNames.add(fbo.name);
    if (!Array.isArray(fbo.attachments) || fbo.attachments.length > 8) {
      refuse(`pid ${pid}'s GL framebuffer ${fbo.name} carries an unusable attachment list`);
    }
    for (const attachment of fbo.attachments) {
      const carried = attachment.kind === "texture"
        ? textureNames.has(attachment.objectName)
        : attachment.kind === "renderbuffer"
          ? rboNames.has(attachment.objectName)
          : false;
      if (!carried) {
        refuse(
          `pid ${pid}'s GL framebuffer ${fbo.name} attaches `
            + `${String(attachment.kind)} ${String(attachment.objectName)}, `
            + "which the checkpoint does not carry",
        );
      }
    }
  }
  for (const entry of context.uniformLocationNames) {
    if (
      !Number.isSafeInteger(entry.index)
      || entry.index <= 0
      || entry.index > context.nextUniformLoc
      || typeof entry.uniform !== "string"
      || entry.uniform.length > 1024
    ) {
      refuse(`pid ${pid} carries an unusable GL uniform-location entry`);
    }
  }
  if (context.state === null) return;
  const state = context.state;
  if (
    state.currentProgramName !== null
    && !programNames.has(state.currentProgramName)
  ) {
    refuse(
      `pid ${pid}'s GL pipeline uses program `
        + `${String(state.currentProgramName)}, which the checkpoint does not carry`,
    );
  }
  if (state.vaoName !== 0 && !vaoNames.has(state.vaoName)) {
    refuse(
      `pid ${pid}'s GL pipeline binds vertex array `
        + `${String(state.vaoName)}, which the checkpoint does not carry`,
    );
  }
  for (const bound of [state.fboName, state.readFboName]) {
    if (bound !== 0 && !fboNames.has(bound)) {
      refuse(
        `pid ${pid}'s GL pipeline binds framebuffer `
          + `${String(bound)}, which the checkpoint does not carry`,
      );
    }
  }
  for (const unit of state.textureUnits) {
    if (!textureNames.has(unit.name)) {
      refuse(
        `pid ${pid}'s GL pipeline binds texture ${String(unit.name)}, `
          + "which the checkpoint does not carry",
      );
    }
  }
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

/**
 * Refuse startup metadata a restored worker cannot serve faithfully.
 *
 * A restored guest parked inside `_start` re-reads these entries through its
 * worker's startup imports, under the same generated caps the CRT enforces.
 * A checkpoint that exceeds them could never have been captured from a real
 * launch.
 */
function validateStartupEntries(
  pid: number,
  what: "argv" | "environment",
  entries: readonly string[],
  maxCount: number,
): void {
  if (!Array.isArray(entries) || entries.length > maxCount) {
    refuse(`pid ${pid}'s ${what} list is unusable`);
  }
  let totalBytes = 0;
  for (const entry of entries) {
    if (typeof entry !== "string") {
      refuse(`pid ${pid}'s ${what} carries a non-string entry`);
    }
    const byteLength = new TextEncoder().encode(entry).byteLength;
    if (byteLength > PROCESS_METADATA_ENTRY_MAX_BYTES) {
      refuse(`pid ${pid}'s ${what} carries a ${byteLength}-byte entry`);
    }
    totalBytes += byteLength + 1;
  }
  if (totalBytes > POSIX_ARG_MAX_BYTES) {
    refuse(`pid ${pid}'s ${what} exceeds ARG_MAX`);
  }
}

async function validateProcessBucket(
  bucket: CheckpointProcessBucket,
): Promise<WebAssembly.Module> {
  const pid = bucket.pid;
  if (bucket.ptrWidth !== 4 && bucket.ptrWidth !== 8) {
    refuse(`pid ${pid} claims pointer width ${String(bucket.ptrWidth)}`);
  }
  validateStartupEntries(pid, "argv", bucket.argv, PROCESS_STARTUP_MAX_ARGV_COUNT);
  validateStartupEntries(pid, "environment", bucket.env, PROCESS_STARTUP_MAX_ENVP_COUNT);
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
