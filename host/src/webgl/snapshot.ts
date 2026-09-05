/**
 * Read one GL binding's guest-visible context state out of WebGL2.
 *
 * A GL guest's screen never reaches a host buffer, but its *state* — the
 * objects it created and the values it set — is what a replica needs to run
 * the same machine, because the replica re-executes the guest and the guest
 * re-issues its own draws. This module reads that state back at checkpoint
 * freeze time: buffer contents via `getBufferSubData`, texture contents via
 * a scratch framebuffer and `readPixels`, shader sources via
 * `getShaderSource`, program uniforms via `getUniform`, vertex-array wiring
 * via `getVertexAttrib`. What WebGL2 refuses to answer — texture level
 * shapes, the pair behind a uniform-location index — comes from the
 * retention the bridge recorded as the state was made.
 *
 * The read runs under the checkpoint freeze, so the guest cannot race it,
 * and it leaves every guest-visible GL binding as it found it: scratch
 * binds go through targets the op set never uses (`COPY_READ_BUFFER`, the
 * read framebuffer) or are restored from the shadow before returning.
 *
 * What cannot be carried is written down instead of dropped: every level,
 * object, or value the read had to leave behind adds one line to
 * `boundaries`, which travels with the checkpoint so a restore can report
 * the machine it rebuilt as exactly as incomplete as it is.
 */
import type { GlBinding } from "./registry.js";
import {
  GL_PACK_ALIGNMENT,
  GL_READ_FRAMEBUFFER,
  GL_TEXTURE_2D,
} from "./shadow.js";

export const GL_ARRAY_BUFFER_BINDING = 0x8894;
export const GL_ELEMENT_ARRAY_BUFFER_BINDING = 0x8895;
export const GL_COPY_READ_BUFFER = 0x8f36;
export const GL_BUFFER_SIZE = 0x8764;
export const GL_BUFFER_USAGE = 0x8765;

export const GL_READ_FRAMEBUFFER_BINDING = 0x8caa;
export const GL_RENDERBUFFER = 0x8d41;
export const GL_RENDERBUFFER_BINDING = 0x8ca7;
export const GL_RENDERBUFFER_WIDTH = 0x8d42;
export const GL_RENDERBUFFER_HEIGHT = 0x8d43;
export const GL_RENDERBUFFER_INTERNAL_FORMAT = 0x8d44;

export const GL_COLOR_ATTACHMENT0 = 0x8ce0;
export const GL_DEPTH_ATTACHMENT = 0x8d00;
export const GL_STENCIL_ATTACHMENT = 0x8d20;
export const GL_DEPTH_STENCIL_ATTACHMENT = 0x821a;
export const GL_FRAMEBUFFER_ATTACHMENT_OBJECT_TYPE = 0x8cd0;
export const GL_FRAMEBUFFER_ATTACHMENT_OBJECT_NAME = 0x8cd1;
export const GL_FRAMEBUFFER_ATTACHMENT_TEXTURE_LEVEL = 0x8cd2;
export const GL_FRAMEBUFFER_COMPLETE = 0x8cd5;
export const GL_TEXTURE = 0x1702;

export const GL_MAX_VERTEX_ATTRIBS = 0x8869;
export const GL_VERTEX_ATTRIB_ARRAY_ENABLED = 0x8622;
export const GL_VERTEX_ATTRIB_ARRAY_SIZE = 0x8623;
export const GL_VERTEX_ATTRIB_ARRAY_STRIDE = 0x8624;
export const GL_VERTEX_ATTRIB_ARRAY_TYPE = 0x8625;
export const GL_VERTEX_ATTRIB_ARRAY_POINTER = 0x8645;
export const GL_VERTEX_ATTRIB_ARRAY_NORMALIZED = 0x886a;
export const GL_VERTEX_ATTRIB_ARRAY_BUFFER_BINDING = 0x889f;

export const GL_COMPILE_STATUS = 0x8b81;
export const GL_LINK_STATUS = 0x8b82;
export const GL_ACTIVE_UNIFORMS = 0x8b86;
export const GL_ACTIVE_ATTRIBUTES = 0x8b89;
export const GL_SHADER_TYPE = 0x8b4f;

export const GL_TEXTURE_MAG_FILTER = 0x2800;
export const GL_TEXTURE_MIN_FILTER = 0x2801;
export const GL_TEXTURE_WRAP_S = 0x2802;
export const GL_TEXTURE_WRAP_T = 0x2803;
export const GL_LINE_WIDTH = 0x0b21;

export const GL_RED = 0x1903;
export const GL_RG = 0x8227;
export const GL_RGB = 0x1907;
export const GL_RGBA = 0x1908;
export const GL_ALPHA = 0x1906;
export const GL_LUMINANCE = 0x1909;
export const GL_LUMINANCE_ALPHA = 0x190a;
export const GL_DEPTH_COMPONENT = 0x1902;
export const GL_DEPTH_STENCIL = 0x84f9;

export const GL_UNSIGNED_BYTE = 0x1401;
export const GL_FLOAT = 0x1406;
export const GL_HALF_FLOAT = 0x140b;
const GL_HALF_FLOAT_OES = 0x8d61;

/** One buffer, with the bytes it held at the freeze. */
export interface CheckpointGlBuffer {
  readonly name: number;
  readonly usage: number;
  readonly bytes: Uint8Array;
}

/**
 * One texture level, upload-ready.
 *
 * `pixels` is stored in the level's own `format`, but in `pixelsType`
 * rather than `type`: a half-float level is read back and carried as
 * floats, which WebGL2 accepts for upload into every half-float
 * internalformat. `null` pixels restore as an unfilled allocation, and
 * the reason is on the context's `boundaries`.
 */
export interface CheckpointGlTextureLevel {
  readonly level: number;
  readonly internalFormat: number;
  readonly width: number;
  readonly height: number;
  readonly format: number;
  readonly type: number;
  readonly pixels: Uint8Array | null;
  readonly pixelsType: number;
}

export interface CheckpointGlTexture {
  readonly name: number;
  readonly levels: readonly CheckpointGlTextureLevel[];
  readonly mipmapped: boolean;
  readonly minFilter: number;
  readonly magFilter: number;
  readonly wrapS: number;
  readonly wrapT: number;
}

export interface CheckpointGlShader {
  readonly name: number;
  readonly type: number;
  readonly source: string;
  readonly compiled: boolean;
}

/**
 * One shader a program has attached, by value.
 *
 * The op set has no detach, so a program's attached shaders are permanent
 * and their sources describe it completely. `shaderName` is set when the
 * attached object is one the guest still names, so a restore attaches the
 * recreated named shader rather than an anonymous twin.
 */
export interface CheckpointGlProgramShader {
  readonly shaderName: number | null;
  readonly type: number;
  readonly source: string;
}

export interface CheckpointGlUniform {
  readonly name: string;
  readonly glType: number;
  readonly values: readonly number[];
}

/**
 * One attribute's post-link location, re-applied with `bindAttribLocation`
 * before the restore relinks. Pinning the recorded locations is what keeps
 * the guest's cmdbuf attribute indices meaning the same thing on a GPU
 * whose driver would have assigned different ones.
 */
export interface CheckpointGlAttribBinding {
  readonly name: string;
  readonly location: number;
}

export interface CheckpointGlProgram {
  readonly name: number;
  readonly linked: boolean;
  readonly shaders: readonly CheckpointGlProgramShader[];
  readonly attribBindings: readonly CheckpointGlAttribBinding[];
  readonly uniforms: readonly CheckpointGlUniform[];
}

export interface CheckpointGlVertexAttrib {
  readonly index: number;
  readonly enabled: boolean;
  readonly bufferName: number | null;
  readonly size: number;
  readonly type: number;
  readonly normalized: boolean;
  readonly stride: number;
  readonly offset: number;
}

/** One vertex array's wiring; name 0 is the default vertex array. */
export interface CheckpointGlVao {
  readonly name: number;
  readonly elementArrayBufferName: number | null;
  readonly attribs: readonly CheckpointGlVertexAttrib[];
}

export interface CheckpointGlFboAttachment {
  readonly attachment: number;
  readonly kind: "texture" | "renderbuffer";
  readonly objectName: number;
  readonly level: number;
}

export interface CheckpointGlFbo {
  readonly name: number;
  readonly attachments: readonly CheckpointGlFboAttachment[];
}

/** Storage only: renderbuffer contents cannot be read out of WebGL2. */
export interface CheckpointGlRbo {
  readonly name: number;
  readonly internalFormat: number;
  readonly width: number;
  readonly height: number;
}

/** The pipeline state the guest set, with objects replaced by names. */
export interface CheckpointGlPipelineState {
  readonly viewport: readonly [number, number, number, number];
  readonly scissorEnabled: boolean;
  readonly scissorRect: readonly [number, number, number, number];
  readonly clearColor: readonly [number, number, number, number];
  readonly depthTestEnabled: boolean;
  readonly depthFunc: number;
  readonly stencilTestEnabled: boolean;
  readonly blendEnabled: boolean;
  readonly blendFunc: {
    readonly srcRGB: number;
    readonly dstRGB: number;
    readonly srcA: number;
    readonly dstA: number;
  };
  readonly cullFaceEnabled: boolean;
  readonly cullFace: number;
  readonly frontFace: number;
  readonly polygonOffsetFillEnabled: boolean;
  readonly lineWidth: number;
  readonly currentProgramName: number | null;
  readonly vaoName: number;
  readonly fboName: number;
  readonly readFboName: number;
  readonly activeTexture: number;
  readonly textureUnits: readonly { unit: number; name: number }[];
  readonly unpackAlignment: number;
  readonly packAlignment: number;
  readonly arrayBufferName: number | null;
  readonly renderbufferName: number | null;
}

export interface CheckpointGlUniformLocationName {
  readonly index: number;
  readonly program: number;
  readonly uniform: string;
}

/** Everything one GL binding holds, as a checkpoint carries it. */
export interface CheckpointGlContext {
  readonly pid: number;
  readonly cmdbufAddr: number;
  readonly cmdbufLen: number;
  readonly contextId: number | null;
  readonly surfaceId: number | null;
  /** The CRTC whose canvas this context paints, for the restore to find
   *  the replacement canvas; null when the context paints no CRTC. */
  readonly crtcId: number | null;
  readonly buffers: readonly CheckpointGlBuffer[];
  readonly textures: readonly CheckpointGlTexture[];
  readonly shaders: readonly CheckpointGlShader[];
  readonly programs: readonly CheckpointGlProgram[];
  readonly vaos: readonly CheckpointGlVao[];
  readonly fbos: readonly CheckpointGlFbo[];
  readonly rbos: readonly CheckpointGlRbo[];
  readonly uniformLocationNames: readonly CheckpointGlUniformLocationName[];
  readonly nextUniformLoc: number;
  /** Null when the binding never built a context; nothing to rebuild. */
  readonly state: CheckpointGlPipelineState | null;
  /** What the read could not carry, one line each. Travels with the
   *  checkpoint so a restore reports the machine as exactly as
   *  incomplete as it is. */
  readonly boundaries: readonly string[];
}

function reverseOf<T extends object>(map: Map<number, T>): Map<T, number> {
  const reverse = new Map<T, number>();
  for (const [name, object] of map) reverse.set(object, name);
  return reverse;
}

/** Channels a pixel format carries, or null when this read cannot carry it. */
export function glChannelCount(format: number): number | null {
  switch (format) {
    case GL_RED:
    case GL_ALPHA:
    case GL_LUMINANCE:
      return 1;
    case GL_RG:
    case GL_LUMINANCE_ALPHA:
      return 2;
    case GL_RGB:
      return 3;
    case GL_RGBA:
      return 4;
    default:
      return null;
  }
}

function extractChannels(
  rgba: Float32Array | Uint8Array,
  pixelCount: number,
  channels: number,
): Uint8Array {
  if (channels === 4) {
    return new Uint8Array(rgba.buffer, rgba.byteOffset, rgba.byteLength).slice();
  }
  const out = rgba instanceof Float32Array
    ? new Float32Array(pixelCount * channels)
    : new Uint8Array(pixelCount * channels);
  for (let pixel = 0; pixel < pixelCount; pixel++) {
    for (let channel = 0; channel < channels; channel++) {
      out[pixel * channels + channel] = rgba[pixel * 4 + channel]!;
    }
  }
  return new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
}

function uniformValuesOf(value: unknown): number[] | null {
  if (typeof value === "number") return [value];
  if (typeof value === "boolean") return [value ? 1 : 0];
  if (
    value instanceof Float32Array
    || value instanceof Int32Array
    || value instanceof Uint32Array
  ) {
    return [...value];
  }
  if (Array.isArray(value)) {
    return value.map((element) =>
      typeof element === "boolean" ? (element ? 1 : 0) : Number(element)
    );
  }
  return null;
}

/**
 * Read the binding's context state; see the module doc for what and how.
 *
 * `crtcId` is the caller's knowledge — the registry does not know which
 * CRTC a canvas belongs to — and rides through unchanged.
 */
export function captureGlContext(
  b: GlBinding,
  crtcId: number | null,
): CheckpointGlContext {
  const boundaries: string[] = [];
  const structural = {
    pid: b.pid,
    cmdbufAddr: b.cmdbufAddr,
    cmdbufLen: b.cmdbufLen,
    contextId: b.contextId,
    surfaceId: b.surfaceId,
    crtcId,
    uniformLocationNames: [...b.uniformLocationNames].map(
      ([index, { program, uniform }]) => ({ index, program, uniform }),
    ),
    nextUniformLoc: b.nextUniformLoc,
  };
  const gl = b.gl;
  if (!gl) {
    return {
      ...structural,
      buffers: [],
      textures: [],
      shaders: [],
      programs: [],
      vaos: [],
      fbos: [],
      rbos: [],
      state: null,
      boundaries,
    };
  }

  const bufferNames = reverseOf(b.buffers);
  const textureNames = reverseOf(b.textures);
  const shaderNames = reverseOf(b.shaders);
  const vaoNames = reverseOf(b.vaos);
  const fboNames = reverseOf(b.fbos);
  const rboNames = reverseOf(b.rbos);

  const priorCopyRead = gl.getParameter(GL_COPY_READ_BUFFER) as WebGLBuffer | null;
  const priorReadFbo =
    gl.getParameter(GL_READ_FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
  const priorRenderbuffer =
    gl.getParameter(GL_RENDERBUFFER_BINDING) as WebGLRenderbuffer | null;
  const arrayBufferName = nameOrNull(
    bufferNames,
    gl.getParameter(GL_ARRAY_BUFFER_BINDING) as WebGLBuffer | null,
  );
  const lineWidth = Number(gl.getParameter(GL_LINE_WIDTH) ?? 1);

  const buffers = readBuffers(gl, b, boundaries);
  const rbos = readRenderbuffers(gl, b, priorRenderbuffer, boundaries);
  const textures = readTextures(gl, b, boundaries);
  const shaders = readShaders(gl, b);
  const programs = readPrograms(gl, b, shaderNames, boundaries);
  const vaos = readVaos(gl, b, bufferNames);
  const fbos = readFbos(gl, b, textureNames, rboNames, boundaries);

  gl.bindFramebuffer(GL_READ_FRAMEBUFFER, priorReadFbo);
  gl.bindBuffer(GL_COPY_READ_BUFFER, priorCopyRead);
  gl.bindVertexArray(b.shadow.vao);
  gl.pixelStorei(GL_PACK_ALIGNMENT, b.shadow.packAlignment);

  const shadow = b.shadow;
  const state: CheckpointGlPipelineState = {
    viewport: [...shadow.viewport],
    scissorEnabled: shadow.scissor.enabled,
    scissorRect: [...shadow.scissor.rect],
    clearColor: [...shadow.clearColor],
    depthTestEnabled: shadow.depthTestEnabled,
    depthFunc: shadow.depthFunc,
    stencilTestEnabled: shadow.stencilTestEnabled,
    blendEnabled: shadow.blendEnabled,
    blendFunc: { ...shadow.blendFunc },
    cullFaceEnabled: shadow.cullFaceEnabled,
    cullFace: shadow.cullFace,
    frontFace: shadow.frontFace,
    polygonOffsetFillEnabled: shadow.polygonOffsetFillEnabled,
    lineWidth,
    currentProgramName: shadow.currentProgram === null
      ? null
      : reverseOf(b.programs).get(shadow.currentProgram) ?? null,
    vaoName: shadow.vao === null ? 0 : vaoNames.get(shadow.vao) ?? 0,
    fboName: shadow.fbo === null ? 0 : fboNames.get(shadow.fbo) ?? 0,
    readFboName: priorReadFbo === null ? 0 : fboNames.get(priorReadFbo) ?? 0,
    activeTexture: shadow.activeTexture,
    textureUnits: [...b.textureUnitNames].map(([unit, name]) => ({
      unit,
      name,
    })),
    unpackAlignment: shadow.unpackAlignment,
    packAlignment: shadow.packAlignment,
    arrayBufferName,
    renderbufferName: nameOrNull(rboNames, priorRenderbuffer),
  };

  return {
    ...structural,
    buffers,
    textures,
    shaders,
    programs,
    vaos,
    fbos,
    rbos,
    state,
    boundaries,
  };
}

function nameOrNull<T>(reverse: Map<T, number>, object: T | null): number | null {
  if (object === null) return null;
  return reverse.get(object) ?? null;
}

function readBuffers(
  gl: WebGL2RenderingContext,
  b: GlBinding,
  boundaries: string[],
): CheckpointGlBuffer[] {
  const out: CheckpointGlBuffer[] = [];
  for (const [name, buffer] of b.buffers) {
    gl.bindBuffer(GL_COPY_READ_BUFFER, buffer);
    const size = Number(gl.getBufferParameter(GL_COPY_READ_BUFFER, GL_BUFFER_SIZE) ?? 0);
    const usage = Number(gl.getBufferParameter(GL_COPY_READ_BUFFER, GL_BUFFER_USAGE) ?? 0);
    if (!Number.isSafeInteger(size) || size < 0) {
      boundaries.push(`buffer ${name} reports an unusable size; carried empty`);
      out.push({ name, usage, bytes: new Uint8Array(0) });
      continue;
    }
    const bytes = new Uint8Array(size);
    if (size > 0) gl.getBufferSubData(GL_COPY_READ_BUFFER, 0, bytes);
    out.push({ name, usage, bytes });
  }
  return out;
}

function readRenderbuffers(
  gl: WebGL2RenderingContext,
  b: GlBinding,
  priorRenderbuffer: WebGLRenderbuffer | null,
  boundaries: string[],
): CheckpointGlRbo[] {
  const out: CheckpointGlRbo[] = [];
  for (const [name, rbo] of b.rbos) {
    gl.bindRenderbuffer(GL_RENDERBUFFER, rbo);
    out.push({
      name,
      internalFormat: Number(
        gl.getRenderbufferParameter(GL_RENDERBUFFER, GL_RENDERBUFFER_INTERNAL_FORMAT) ?? 0,
      ),
      width: Number(gl.getRenderbufferParameter(GL_RENDERBUFFER, GL_RENDERBUFFER_WIDTH) ?? 0),
      height: Number(gl.getRenderbufferParameter(GL_RENDERBUFFER, GL_RENDERBUFFER_HEIGHT) ?? 0),
    });
  }
  if (out.length > 0) {
    boundaries.push(
      "renderbuffer contents cannot be read out of WebGL2; restored "
        + "renderbuffers start uninitialized",
    );
  }
  gl.bindRenderbuffer(GL_RENDERBUFFER, priorRenderbuffer);
  return out;
}

function readTextures(
  gl: WebGL2RenderingContext,
  b: GlBinding,
  boundaries: string[],
): CheckpointGlTexture[] {
  const out: CheckpointGlTexture[] = [];
  const scratchFbo = gl.createFramebuffer();
  gl.bindFramebuffer(GL_READ_FRAMEBUFFER, scratchFbo);
  gl.pixelStorei(GL_PACK_ALIGNMENT, 1);
  const activeUnitTexture =
    b.shadow.textureUnits[b.shadow.activeTexture] ?? null;
  for (const [name, texture] of b.textures) {
    gl.bindTexture(GL_TEXTURE_2D, texture);
    const minFilter = Number(gl.getTexParameter(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER) ?? 0);
    const magFilter = Number(gl.getTexParameter(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER) ?? 0);
    const wrapS = Number(gl.getTexParameter(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S) ?? 0);
    const wrapT = Number(gl.getTexParameter(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T) ?? 0);
    // A texture with no recorded shape never saw a TexImage2D: it holds
    // nothing, and carrying it as an empty object is exact, not a gap.
    const shape = b.textureShapes.get(name);
    const levels: CheckpointGlTextureLevel[] = [];
    let mipmapped = false;
    if (shape) {
      mipmapped = shape.mipmapped;
      for (const [level, levelShape] of shape.levels) {
        levels.push(readTextureLevel(
          gl,
          texture,
          name,
          level,
          levelShape,
          boundaries,
        ));
      }
      levels.sort((left, right) => left.level - right.level);
    }
    out.push({ name, levels, mipmapped, minFilter, magFilter, wrapS, wrapT });
  }
  gl.bindTexture(GL_TEXTURE_2D, activeUnitTexture);
  gl.deleteFramebuffer(scratchFbo);
  return out;
}

function readTextureLevel(
  gl: WebGL2RenderingContext,
  texture: WebGLTexture,
  name: number,
  level: number,
  shape: {
    internalFormat: number;
    width: number;
    height: number;
    format: number;
    type: number;
  },
  boundaries: string[],
): CheckpointGlTextureLevel {
  const unreadable = (reason: string): CheckpointGlTextureLevel => {
    boundaries.push(`texture ${name} level ${level} ${reason}`);
    return { level, ...shape, pixels: null, pixelsType: shape.type };
  };
  if (shape.format === GL_DEPTH_COMPONENT || shape.format === GL_DEPTH_STENCIL) {
    return unreadable("holds depth data, which readPixels cannot return");
  }
  const channels = glChannelCount(shape.format);
  if (channels === null) {
    return unreadable(`uses format 0x${shape.format.toString(16)}, which this read does not carry`);
  }
  const asFloat =
    shape.type === GL_FLOAT
    || shape.type === GL_HALF_FLOAT
    || shape.type === GL_HALF_FLOAT_OES;
  if (!asFloat && shape.type !== GL_UNSIGNED_BYTE) {
    return unreadable(`uses type 0x${shape.type.toString(16)}, which this read does not carry`);
  }
  gl.framebufferTexture2D(
    GL_READ_FRAMEBUFFER,
    GL_COLOR_ATTACHMENT0,
    GL_TEXTURE_2D,
    texture,
    level,
  );
  if (gl.checkFramebufferStatus(GL_READ_FRAMEBUFFER) !== GL_FRAMEBUFFER_COMPLETE) {
    gl.framebufferTexture2D(GL_READ_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, null, 0);
    return unreadable("is not attachable for reading on this GPU");
  }
  const pixelCount = shape.width * shape.height;
  const rgba = asFloat
    ? new Float32Array(pixelCount * 4)
    : new Uint8Array(pixelCount * 4);
  gl.readPixels(
    0,
    0,
    shape.width,
    shape.height,
    GL_RGBA,
    asFloat ? GL_FLOAT : GL_UNSIGNED_BYTE,
    rgba,
  );
  gl.framebufferTexture2D(GL_READ_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, null, 0);
  return {
    level,
    ...shape,
    pixels: extractChannels(rgba, pixelCount, channels),
    pixelsType: asFloat ? GL_FLOAT : GL_UNSIGNED_BYTE,
  };
}

function readShaders(
  gl: WebGL2RenderingContext,
  b: GlBinding,
): CheckpointGlShader[] {
  const out: CheckpointGlShader[] = [];
  for (const [name, shader] of b.shaders) {
    out.push({
      name,
      type: Number(gl.getShaderParameter(shader, GL_SHADER_TYPE) ?? 0),
      source: gl.getShaderSource(shader) ?? "",
      compiled: gl.getShaderParameter(shader, GL_COMPILE_STATUS) === true,
    });
  }
  return out;
}

function readPrograms(
  gl: WebGL2RenderingContext,
  b: GlBinding,
  shaderNames: Map<WebGLShader, number>,
  boundaries: string[],
): CheckpointGlProgram[] {
  const out: CheckpointGlProgram[] = [];
  for (const [name, program] of b.programs) {
    const shaders = (gl.getAttachedShaders(program) ?? []).map((shader) => ({
      shaderName: shaderNames.get(shader) ?? null,
      type: Number(gl.getShaderParameter(shader, GL_SHADER_TYPE) ?? 0),
      source: gl.getShaderSource(shader) ?? "",
    }));
    const linked = gl.getProgramParameter(program, GL_LINK_STATUS) === true;
    const attribBindings: CheckpointGlAttribBinding[] = [];
    const uniforms: CheckpointGlUniform[] = [];
    if (linked) {
      const attribCount = Number(
        gl.getProgramParameter(program, GL_ACTIVE_ATTRIBUTES) ?? 0,
      );
      for (let index = 0; index < attribCount; index++) {
        const info = gl.getActiveAttrib(program, index);
        if (!info) continue;
        const location = gl.getAttribLocation(program, info.name);
        if (location >= 0) attribBindings.push({ name: info.name, location });
      }
      const uniformCount = Number(
        gl.getProgramParameter(program, GL_ACTIVE_UNIFORMS) ?? 0,
      );
      for (let index = 0; index < uniformCount; index++) {
        const info = gl.getActiveUniform(program, index);
        if (!info) continue;
        const base = info.name.replace(/\[0\]$/, "");
        for (let element = 0; element < info.size; element++) {
          const elementName = info.size > 1 ? `${base}[${element}]` : base;
          const location = gl.getUniformLocation(program, elementName);
          if (!location) continue;
          const values = uniformValuesOf(gl.getUniform(program, location));
          if (values === null) {
            boundaries.push(
              `program ${name}'s uniform ${elementName} holds a value `
                + "this read does not carry",
            );
            continue;
          }
          uniforms.push({ name: elementName, glType: info.type, values });
        }
      }
    }
    out.push({ name, linked, shaders, attribBindings, uniforms });
  }
  return out;
}

function readVaos(
  gl: WebGL2RenderingContext,
  b: GlBinding,
  bufferNames: Map<WebGLBuffer, number>,
): CheckpointGlVao[] {
  const out: CheckpointGlVao[] = [];
  const maxAttribs = Number(gl.getParameter(GL_MAX_VERTEX_ATTRIBS) ?? 0);
  const sources: [number, WebGLVertexArrayObject | null][] = [
    [0, null],
    ...[...b.vaos].map(
      ([name, vao]) => [name, vao] as [number, WebGLVertexArrayObject],
    ),
  ];
  for (const [name, vao] of sources) {
    gl.bindVertexArray(vao);
    const elementArrayBufferName = nameOrNull(
      bufferNames,
      gl.getParameter(GL_ELEMENT_ARRAY_BUFFER_BINDING) as WebGLBuffer | null,
    );
    const attribs: CheckpointGlVertexAttrib[] = [];
    for (let index = 0; index < maxAttribs; index++) {
      const enabled =
        gl.getVertexAttrib(index, GL_VERTEX_ATTRIB_ARRAY_ENABLED) === true;
      const buffer = gl.getVertexAttrib(
        index,
        GL_VERTEX_ATTRIB_ARRAY_BUFFER_BINDING,
      ) as WebGLBuffer | null;
      if (!enabled && buffer === null) continue;
      attribs.push({
        index,
        enabled,
        bufferName: nameOrNull(bufferNames, buffer),
        size: Number(gl.getVertexAttrib(index, GL_VERTEX_ATTRIB_ARRAY_SIZE) ?? 4),
        type: Number(gl.getVertexAttrib(index, GL_VERTEX_ATTRIB_ARRAY_TYPE) ?? GL_FLOAT),
        normalized:
          gl.getVertexAttrib(index, GL_VERTEX_ATTRIB_ARRAY_NORMALIZED) === true,
        stride: Number(gl.getVertexAttrib(index, GL_VERTEX_ATTRIB_ARRAY_STRIDE) ?? 0),
        offset: Number(gl.getVertexAttribOffset(index, GL_VERTEX_ATTRIB_ARRAY_POINTER) ?? 0),
      });
    }
    out.push({ name, elementArrayBufferName, attribs });
  }
  return out;
}

function readFbos(
  gl: WebGL2RenderingContext,
  b: GlBinding,
  textureNames: Map<WebGLTexture, number>,
  rboNames: Map<WebGLRenderbuffer, number>,
  boundaries: string[],
): CheckpointGlFbo[] {
  const out: CheckpointGlFbo[] = [];
  const attachmentPoints = [
    GL_COLOR_ATTACHMENT0,
    GL_DEPTH_ATTACHMENT,
    GL_STENCIL_ATTACHMENT,
    GL_DEPTH_STENCIL_ATTACHMENT,
  ];
  for (const [name, fbo] of b.fbos) {
    gl.bindFramebuffer(GL_READ_FRAMEBUFFER, fbo);
    const attachments: CheckpointGlFboAttachment[] = [];
    for (const attachment of attachmentPoints) {
      let objectType: number;
      try {
        objectType = Number(gl.getFramebufferAttachmentParameter(
          GL_READ_FRAMEBUFFER,
          attachment,
          GL_FRAMEBUFFER_ATTACHMENT_OBJECT_TYPE,
        ) ?? 0);
      } catch {
        // WebGL2 refuses the combined depth-stencil query when depth and
        // stencil attachments differ; the separate points already covered
        // both.
        continue;
      }
      if (objectType !== GL_TEXTURE && objectType !== GL_RENDERBUFFER) continue;
      const object = gl.getFramebufferAttachmentParameter(
        GL_READ_FRAMEBUFFER,
        attachment,
        GL_FRAMEBUFFER_ATTACHMENT_OBJECT_NAME,
      ) as WebGLTexture | WebGLRenderbuffer | null;
      if (object === null) continue;
      const objectName = objectType === GL_TEXTURE
        ? textureNames.get(object as WebGLTexture)
        : rboNames.get(object as WebGLRenderbuffer);
      if (objectName === undefined) {
        boundaries.push(
          `framebuffer ${name} attaches an object the guest does not name; `
            + "the attachment was not carried",
        );
        continue;
      }
      const level = objectType === GL_TEXTURE
        ? Number(gl.getFramebufferAttachmentParameter(
          GL_READ_FRAMEBUFFER,
          attachment,
          GL_FRAMEBUFFER_ATTACHMENT_TEXTURE_LEVEL,
        ) ?? 0)
        : 0;
      attachments.push({
        attachment,
        kind: objectType === GL_TEXTURE ? "texture" : "renderbuffer",
        objectName,
        level,
      });
    }
    out.push({ name, attachments });
  }
  return out;
}
