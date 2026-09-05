/**
 * Rebuild a captured GL context into a fresh WebGL2 context.
 *
 * The inverse of `webgl/snapshot.ts`. A restored guest resumes believing
 * its GL objects exist, and its next cmdbuf names them, so everything the
 * checkpoint carries is recreated before the guest runs: shaders from
 * their sources, programs relinked with the captured attribute locations
 * pinned, buffer and texture contents re-uploaded, vertex-array and
 * framebuffer wiring rebound, and the pipeline state reapplied. The
 * binding's name maps and retention — texture shapes, the pairs behind
 * the uniform-location indices — are repopulated so the next capture of
 * this machine reads as much as the last one did.
 *
 * Uploads go through targets that cannot poison guest state: buffer
 * contents through `COPY_WRITE_BUFFER`, because WebGL permanently locks a
 * buffer bound to `ELEMENT_ARRAY_BUFFER` against every other non-copy
 * target, and an upload through `ARRAY_BUFFER` would make each index
 * buffer unusable as one.
 *
 * What cannot be rebuilt is returned as boundary lines for the caller to
 * report, never absorbed: a uniform whose location a fresh link no longer
 * answers, a value type this module has no setter for.
 */
import type { GlBinding } from "./registry.js";
import { defaultShadow, GL_FRAMEBUFFER, GL_TEXTURE0, GL_TEXTURE_2D } from "./shadow.js";
import {
  GL_FLOAT,
  GL_LINE_WIDTH,
  GL_TEXTURE_MAG_FILTER,
  GL_TEXTURE_MIN_FILTER,
  GL_TEXTURE_WRAP_S,
  GL_TEXTURE_WRAP_T,
  type CheckpointGlContext,
  type CheckpointGlPipelineState,
  type CheckpointGlTexture,
  type CheckpointGlUniform,
} from "./snapshot.js";

const GL_ARRAY_BUFFER = 0x8892;
const GL_ELEMENT_ARRAY_BUFFER = 0x8893;
const GL_COPY_WRITE_BUFFER = 0x8f37;
const GL_READ_FRAMEBUFFER = 0x8ca8;
const GL_RENDERBUFFER = 0x8d41;
const GL_UNPACK_ALIGNMENT = 0x0cf5;
const GL_PACK_ALIGNMENT = 0x0d05;

const GL_DEPTH_TEST = 0x0b71;
const GL_STENCIL_TEST = 0x0b90;
const GL_BLEND = 0x0be2;
const GL_CULL_FACE = 0x0b44;
const GL_SCISSOR_TEST = 0x0c11;
const GL_POLYGON_OFFSET_FILL = 0x8037;

const GL_FLOAT_VEC2 = 0x8b50;
const GL_FLOAT_VEC3 = 0x8b51;
const GL_FLOAT_VEC4 = 0x8b52;
const GL_INT = 0x1404;
const GL_INT_VEC2 = 0x8b53;
const GL_INT_VEC3 = 0x8b54;
const GL_INT_VEC4 = 0x8b55;
const GL_BOOL = 0x8b56;
const GL_BOOL_VEC2 = 0x8b57;
const GL_BOOL_VEC3 = 0x8b58;
const GL_BOOL_VEC4 = 0x8b59;
const GL_FLOAT_MAT2 = 0x8b5a;
const GL_FLOAT_MAT3 = 0x8b5b;
const GL_FLOAT_MAT4 = 0x8b5c;
const GL_SAMPLER_2D = 0x8b5e;
const GL_SAMPLER_CUBE = 0x8b60;

/**
 * Recreate the captured context inside `gl` and fill `b`'s maps from it.
 *
 * `b` is a fresh binding whose `gl` the caller has just built; on return
 * its object maps, retention, shadow, and uniform-location table hold the
 * captured machine's state. Returns what could not be rebuilt.
 */
export function rebuildGlContext(
  gl: WebGL2RenderingContext,
  b: GlBinding,
  context: CheckpointGlContext,
): string[] {
  const boundaries: string[] = [];

  for (const carried of context.buffers) {
    const buffer = gl.createBuffer();
    if (!buffer) {
      boundaries.push(`buffer ${carried.name} could not be created`);
      continue;
    }
    gl.bindBuffer(GL_COPY_WRITE_BUFFER, buffer);
    gl.bufferData(GL_COPY_WRITE_BUFFER, carried.bytes, carried.usage);
    b.buffers.set(carried.name, buffer);
  }
  gl.bindBuffer(GL_COPY_WRITE_BUFFER, null);

  for (const carried of context.textures) {
    const texture = rebuildTexture(gl, carried, boundaries);
    if (texture) b.textures.set(carried.name, texture);
  }

  for (const carried of context.rbos) {
    const rbo = gl.createRenderbuffer();
    if (!rbo) {
      boundaries.push(`renderbuffer ${carried.name} could not be created`);
      continue;
    }
    gl.bindRenderbuffer(GL_RENDERBUFFER, rbo);
    if (carried.width > 0 && carried.height > 0) {
      gl.renderbufferStorage(
        GL_RENDERBUFFER,
        carried.internalFormat,
        carried.width,
        carried.height,
      );
    }
    b.rbos.set(carried.name, rbo);
  }
  gl.bindRenderbuffer(GL_RENDERBUFFER, null);

  for (const carried of context.shaders) {
    const shader = gl.createShader(carried.type);
    if (!shader) {
      boundaries.push(`shader ${carried.name} could not be created`);
      continue;
    }
    gl.shaderSource(shader, carried.source);
    if (carried.compiled) gl.compileShader(shader);
    b.shaders.set(carried.name, shader);
  }

  for (const carried of context.programs) {
    const program = gl.createProgram();
    if (!program) {
      boundaries.push(`program ${carried.name} could not be created`);
      continue;
    }
    for (const attached of carried.shaders) {
      const named = attached.shaderName === null
        ? null
        : b.shaders.get(attached.shaderName) ?? null;
      let shader = named;
      if (!shader) {
        shader = gl.createShader(attached.type);
        if (!shader) {
          boundaries.push(
            `program ${carried.name}'s attached shader could not be created`,
          );
          continue;
        }
        gl.shaderSource(shader, attached.source);
        gl.compileShader(shader);
      }
      gl.attachShader(program, shader);
    }
    for (const binding of carried.attribBindings) {
      gl.bindAttribLocation(program, binding.location, binding.name);
    }
    if (carried.linked) {
      gl.linkProgram(program);
      applyUniforms(gl, program, carried.name, carried.uniforms, boundaries);
    }
    b.programs.set(carried.name, program);
  }

  for (const carried of context.vaos) {
    let vao: WebGLVertexArrayObject | null = null;
    if (carried.name !== 0) {
      vao = gl.createVertexArray();
      if (!vao) {
        boundaries.push(`vertex array ${carried.name} could not be created`);
        continue;
      }
      b.vaos.set(carried.name, vao);
    }
    gl.bindVertexArray(vao);
    gl.bindBuffer(
      GL_ELEMENT_ARRAY_BUFFER,
      carried.elementArrayBufferName === null
        ? null
        : b.buffers.get(carried.elementArrayBufferName) ?? null,
    );
    for (const attrib of carried.attribs) {
      if (attrib.bufferName !== null) {
        const buffer = b.buffers.get(attrib.bufferName) ?? null;
        gl.bindBuffer(GL_ARRAY_BUFFER, buffer);
        gl.vertexAttribPointer(
          attrib.index,
          attrib.size,
          attrib.type,
          attrib.normalized,
          attrib.stride,
          attrib.offset,
        );
      }
      if (attrib.enabled) gl.enableVertexAttribArray(attrib.index);
      else gl.disableVertexAttribArray(attrib.index);
    }
  }
  gl.bindVertexArray(null);

  for (const carried of context.fbos) {
    const fbo = gl.createFramebuffer();
    if (!fbo) {
      boundaries.push(`framebuffer ${carried.name} could not be created`);
      continue;
    }
    gl.bindFramebuffer(GL_FRAMEBUFFER, fbo);
    for (const attachment of carried.attachments) {
      if (attachment.kind === "texture") {
        gl.framebufferTexture2D(
          GL_FRAMEBUFFER,
          attachment.attachment,
          GL_TEXTURE_2D,
          b.textures.get(attachment.objectName) ?? null,
          attachment.level,
        );
      } else {
        gl.framebufferRenderbuffer(
          GL_FRAMEBUFFER,
          attachment.attachment,
          GL_RENDERBUFFER,
          b.rbos.get(attachment.objectName) ?? null,
        );
      }
    }
    b.fbos.set(carried.name, fbo);
  }
  gl.bindFramebuffer(GL_FRAMEBUFFER, null);

  b.nextUniformLoc = context.nextUniformLoc;
  for (const entry of context.uniformLocationNames) {
    b.uniformLocationNames.set(entry.index, {
      program: entry.program,
      uniform: entry.uniform,
    });
    const program = b.programs.get(entry.program);
    if (!program) continue;
    const location = gl.getUniformLocation(program, entry.uniform);
    if (!location) {
      boundaries.push(
        `uniform ${entry.uniform} of program ${entry.program} no longer `
          + "answers a location; cmdbuf writes to it will be dropped",
      );
      continue;
    }
    b.uniformLocations.set(entry.index, location);
  }

  for (const carried of context.textures) {
    if (carried.levels.length === 0 && !carried.mipmapped) continue;
    b.textureShapes.set(carried.name, {
      mipmapped: carried.mipmapped,
      levels: new Map(carried.levels.map((level) => [level.level, {
        internalFormat: level.internalFormat,
        width: level.width,
        height: level.height,
        format: level.format,
        type: level.type,
      }])),
    });
  }

  if (context.state) applyPipelineState(gl, b, context.state);
  return boundaries;
}

function rebuildTexture(
  gl: WebGL2RenderingContext,
  carried: CheckpointGlTexture,
  boundaries: string[],
): WebGLTexture | null {
  const texture = gl.createTexture();
  if (!texture) {
    boundaries.push(`texture ${carried.name} could not be created`);
    return null;
  }
  gl.bindTexture(GL_TEXTURE_2D, texture);
  gl.pixelStorei(GL_UNPACK_ALIGNMENT, 1);
  const upload = (level: (typeof carried.levels)[number]): void => {
    const data = level.pixels === null
      ? null
      : level.pixelsType === GL_FLOAT
        ? new Float32Array(
          level.pixels.buffer,
          level.pixels.byteOffset,
          level.pixels.byteLength / 4,
        )
        : level.pixels;
    gl.texImage2D(
      GL_TEXTURE_2D,
      level.level,
      level.internalFormat,
      level.width,
      level.height,
      0,
      level.format,
      data === null ? level.type : level.pixelsType,
      data,
    );
  };
  // The base level first, the derived chain regenerated from it, then any
  // explicitly uploaded higher levels over the derived ones. A guest that
  // both generated mipmaps and uploaded a level has an order this record
  // does not carry; explicit uploads win, matching the last thing the
  // fluid-sim-shaped guests do.
  const base = carried.levels.find((level) => level.level === 0);
  if (base) upload(base);
  if (carried.mipmapped) gl.generateMipmap(GL_TEXTURE_2D);
  for (const level of carried.levels) {
    if (level.level !== 0) upload(level);
  }
  gl.texParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, carried.minFilter);
  gl.texParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, carried.magFilter);
  gl.texParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, carried.wrapS);
  gl.texParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, carried.wrapT);
  return texture;
}

function applyUniforms(
  gl: WebGL2RenderingContext,
  program: WebGLProgram,
  programName: number,
  uniforms: readonly CheckpointGlUniform[],
  boundaries: string[],
): void {
  if (uniforms.length === 0) return;
  gl.useProgram(program);
  for (const uniform of uniforms) {
    const location = gl.getUniformLocation(program, uniform.name);
    if (!location) {
      boundaries.push(
        `program ${programName}'s uniform ${uniform.name} no longer `
          + "answers a location; its captured value was dropped",
      );
      continue;
    }
    if (!setUniform(gl, location, uniform)) {
      boundaries.push(
        `program ${programName}'s uniform ${uniform.name} holds type `
          + `0x${uniform.glType.toString(16)}, which this rebuild cannot set`,
      );
    }
  }
  gl.useProgram(null);
}

function setUniform(
  gl: WebGL2RenderingContext,
  location: WebGLUniformLocation,
  uniform: CheckpointGlUniform,
): boolean {
  const v = uniform.values;
  switch (uniform.glType) {
    case GL_FLOAT:
      gl.uniform1f(location, v[0] ?? 0);
      return true;
    case GL_FLOAT_VEC2:
      gl.uniform2f(location, v[0] ?? 0, v[1] ?? 0);
      return true;
    case GL_FLOAT_VEC3:
      gl.uniform3f(location, v[0] ?? 0, v[1] ?? 0, v[2] ?? 0);
      return true;
    case GL_FLOAT_VEC4:
      gl.uniform4f(location, v[0] ?? 0, v[1] ?? 0, v[2] ?? 0, v[3] ?? 0);
      return true;
    case GL_INT:
    case GL_BOOL:
    case GL_SAMPLER_2D:
    case GL_SAMPLER_CUBE:
      gl.uniform1i(location, v[0] ?? 0);
      return true;
    case GL_INT_VEC2:
    case GL_BOOL_VEC2:
      gl.uniform2i(location, v[0] ?? 0, v[1] ?? 0);
      return true;
    case GL_INT_VEC3:
    case GL_BOOL_VEC3:
      gl.uniform3i(location, v[0] ?? 0, v[1] ?? 0, v[2] ?? 0);
      return true;
    case GL_INT_VEC4:
    case GL_BOOL_VEC4:
      gl.uniform4i(location, v[0] ?? 0, v[1] ?? 0, v[2] ?? 0, v[3] ?? 0);
      return true;
    case GL_FLOAT_MAT2:
      gl.uniformMatrix2fv(location, false, new Float32Array(v));
      return true;
    case GL_FLOAT_MAT3:
      gl.uniformMatrix3fv(location, false, new Float32Array(v));
      return true;
    case GL_FLOAT_MAT4:
      gl.uniformMatrix4fv(location, false, new Float32Array(v));
      return true;
    default:
      return false;
  }
}

function applyPipelineState(
  gl: WebGL2RenderingContext,
  b: GlBinding,
  state: CheckpointGlPipelineState,
): void {
  const setCapability = (capability: number, enabled: boolean): void => {
    if (enabled) gl.enable(capability);
    else gl.disable(capability);
  };
  gl.viewport(...(state.viewport as [number, number, number, number]));
  setCapability(GL_SCISSOR_TEST, state.scissorEnabled);
  gl.scissor(...(state.scissorRect as [number, number, number, number]));
  gl.clearColor(...(state.clearColor as [number, number, number, number]));
  setCapability(GL_DEPTH_TEST, state.depthTestEnabled);
  gl.depthFunc(state.depthFunc);
  setCapability(GL_STENCIL_TEST, state.stencilTestEnabled);
  setCapability(GL_BLEND, state.blendEnabled);
  gl.blendFuncSeparate(
    state.blendFunc.srcRGB,
    state.blendFunc.dstRGB,
    state.blendFunc.srcA,
    state.blendFunc.dstA,
  );
  setCapability(GL_CULL_FACE, state.cullFaceEnabled);
  gl.cullFace(state.cullFace);
  gl.frontFace(state.frontFace);
  setCapability(GL_POLYGON_OFFSET_FILL, state.polygonOffsetFillEnabled);
  gl.lineWidth(state.lineWidth);

  const program = state.currentProgramName === null
    ? null
    : b.programs.get(state.currentProgramName) ?? null;
  gl.useProgram(program);
  b.currentProgram = program;

  const vao = state.vaoName === 0 ? null : b.vaos.get(state.vaoName) ?? null;
  gl.bindVertexArray(vao);
  const fbo = state.fboName === 0 ? null : b.fbos.get(state.fboName) ?? null;
  gl.bindFramebuffer(GL_FRAMEBUFFER, fbo);
  gl.bindFramebuffer(
    GL_READ_FRAMEBUFFER,
    state.readFboName === 0 ? null : b.fbos.get(state.readFboName) ?? null,
  );
  gl.bindBuffer(
    GL_ARRAY_BUFFER,
    state.arrayBufferName === null
      ? null
      : b.buffers.get(state.arrayBufferName) ?? null,
  );
  gl.bindRenderbuffer(
    GL_RENDERBUFFER,
    state.renderbufferName === null
      ? null
      : b.rbos.get(state.renderbufferName) ?? null,
  );

  const shadow = defaultShadow();
  shadow.viewport = [...state.viewport];
  shadow.scissor = { enabled: state.scissorEnabled, rect: [...state.scissorRect] };
  shadow.clearColor = [...state.clearColor];
  shadow.depthTestEnabled = state.depthTestEnabled;
  shadow.depthFunc = state.depthFunc;
  shadow.stencilTestEnabled = state.stencilTestEnabled;
  shadow.blendEnabled = state.blendEnabled;
  shadow.blendFunc = { ...state.blendFunc };
  shadow.cullFaceEnabled = state.cullFaceEnabled;
  shadow.cullFace = state.cullFace;
  shadow.frontFace = state.frontFace;
  shadow.polygonOffsetFillEnabled = state.polygonOffsetFillEnabled;
  shadow.currentProgram = program;
  shadow.vao = vao;
  shadow.fbo = fbo;
  shadow.activeTexture = state.activeTexture;
  shadow.unpackAlignment = state.unpackAlignment;
  shadow.packAlignment = state.packAlignment;
  for (const unit of state.textureUnits) {
    const texture = b.textures.get(unit.name) ?? null;
    if (unit.unit >= 0 && unit.unit < shadow.textureUnits.length) {
      shadow.textureUnits[unit.unit] = texture;
      if (texture) b.textureUnitNames.set(unit.unit, unit.name);
    }
    gl.activeTexture(GL_TEXTURE0 + unit.unit);
    gl.bindTexture(GL_TEXTURE_2D, texture);
  }
  gl.activeTexture(GL_TEXTURE0 + state.activeTexture);
  gl.pixelStorei(GL_UNPACK_ALIGNMENT, state.unpackAlignment);
  gl.pixelStorei(GL_PACK_ALIGNMENT, state.packAlignment);
  b.shadow = shadow;
}
