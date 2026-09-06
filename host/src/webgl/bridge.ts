/**
 * Cmdbuf TLV walker + per-op dispatch.
 *
 * The kernel forwards a `(pid, offset, length)` triple via
 * `host_gl_submit`. Bytes live in the process's wasm Memory SAB,
 * already viewed through `GlBinding.cmdbufView`. Each entry is a TLV
 * `{u16 op, u16 payload_len, payload[payload_len]}` little-endian; we
 * walk the run, lookup the op, decode its payload, and call the matching
 * `WebGL2RenderingContext` method.
 *
 * Cmdbuf-side u32 names round-trip through `GlBinding.{buffers,
 * textures, shaders, programs, vaos, fbos, rbos}` maps. The C side
 * (Phase C `libGLESv2_stub.c`) picks names itself with a monotonic
 * counter; OP_GEN_BUFFERS / OP_CREATE_SHADER / etc. tell the host
 * which name to allocate.
 *
 * Unknown or malformed opcodes are rejected as guest input. The bridge
 * returns a negative errno so `GLIO_SUBMIT` can fail like any other
 * ioctl-style device operation instead of hiding the failure in host code.
 */
import type { GlBinding, GlTextureLevelShape, GlTextureShape } from "./registry.js";
import * as O from "./ops.js";
import {
  setCap,
  GL_PACK_ALIGNMENT,
  GL_READ_FRAMEBUFFER,
  GL_TEXTURE0,
  GL_UNPACK_ALIGNMENT,
} from "./shadow.js";

export const GL_SUBMIT_OK = 0;
export const GL_SUBMIT_EIO = -5;
export const GL_SUBMIT_EINVAL = -22;

export function decodeAndDispatch(
  b: GlBinding,
  offset: number,
  length: number,
): number {
  if (!b.cmdbufView || !b.gl) return GL_SUBMIT_OK;
  return walkCommandBuffer(b.cmdbufView, offset, length, (payload, op) => {
    try {
      dispatch(b.gl!, b, payload, 0, op);
      return GL_SUBMIT_OK;
    } catch {
      return GL_SUBMIT_EIO;
    }
  });
}

export function validateCommandBuffer(
  buf: Uint8Array,
  offset: number,
  length: number,
): number {
  return walkCommandBuffer(buf, offset, length, () => GL_SUBMIT_OK);
}

function walkCommandBuffer(
  buf: Uint8Array,
  offset: number,
  length: number,
  visit: (payload: DataView, op: number) => number,
): number {
  if (!isSafeSpan(offset, length, buf.byteLength)) return GL_SUBMIT_EINVAL;
  const view = new DataView(buf.buffer, buf.byteOffset + offset, length);
  let p = 0;
  while (p < length) {
    if (length - p < 4) return GL_SUBMIT_EINVAL;
    const op = view.getUint16(p, true);
    const payloadLen = view.getUint16(p + 2, true);
    const payloadStart = p + 4;
    const payloadEnd = payloadStart + payloadLen;
    if (payloadEnd > length) return GL_SUBMIT_EINVAL;
    const payload = new DataView(
      view.buffer,
      view.byteOffset + payloadStart,
      payloadLen,
    );
    if (!validPayload(op, payload)) return GL_SUBMIT_EINVAL;
    const rc = visit(payload, op);
    if (rc !== GL_SUBMIT_OK) return rc;
    p = payloadEnd;
  }
  return GL_SUBMIT_OK;
}

function isSafeSpan(offset: number, length: number, limit: number): boolean {
  return Number.isSafeInteger(offset)
    && Number.isSafeInteger(length)
    && offset >= 0
    && length >= 0
    && offset <= limit
    && length <= limit - offset;
}

function exact(v: DataView, len: number): boolean {
  return v.byteLength === len;
}

function u32ArrayPayload(v: DataView): boolean {
  if (v.byteLength < 4) return false;
  const n = v.getUint32(0, true);
  return v.byteLength === 4 + n * 4;
}

function tailBytesPayload(v: DataView, headerLen: number, lenOffset: number): boolean {
  if (v.byteLength < lenOffset + 4) return false;
  const dataLen = v.getUint32(lenOffset, true);
  return v.byteLength === headerLen + dataLen;
}

function countedFloatPayload(
  v: DataView,
  headerLen: number,
  countOffset: number,
  floatsPerCount: number,
): boolean {
  if (v.byteLength < countOffset + 4 || v.byteOffset % 4 !== 0) return false;
  const count = v.getUint32(countOffset, true);
  return v.byteLength === headerLen + count * floatsPerCount * 4;
}

function validPayload(op: number, v: DataView): boolean {
  switch (op) {
    case O.OP_CLEAR:
    case O.OP_ENABLE:
    case O.OP_DISABLE:
    case O.OP_DEPTH_FUNC:
    case O.OP_CULL_FACE:
    case O.OP_FRONT_FACE:
    case O.OP_LINE_WIDTH:
    case O.OP_ACTIVE_TEXTURE:
    case O.OP_GENERATE_MIPMAP:
    case O.OP_COMPILE_SHADER:
    case O.OP_DELETE_SHADER:
    case O.OP_CREATE_PROGRAM:
    case O.OP_LINK_PROGRAM:
    case O.OP_USE_PROGRAM:
    case O.OP_DELETE_PROGRAM:
    case O.OP_ENABLE_VERTEX_ATTRIB_ARRAY:
    case O.OP_DISABLE_VERTEX_ATTRIB_ARRAY:
    case O.OP_BIND_VERTEX_ARRAY:
      return exact(v, 4);

    case O.OP_BLEND_FUNC:
    case O.OP_PIXEL_STOREI:
    case O.OP_BIND_BUFFER:
    case O.OP_BIND_TEXTURE:
    case O.OP_CREATE_SHADER:
    case O.OP_ATTACH_SHADER:
    case O.OP_UNIFORM1I:
    case O.OP_UNIFORM1F:
    case O.OP_BIND_FRAMEBUFFER:
    case O.OP_BIND_RENDERBUFFER:
      return exact(v, 8);

    case O.OP_TEX_PARAMETERI:
    case O.OP_UNIFORM2F:
    case O.OP_DRAW_ARRAYS:
      return exact(v, 12);

    case O.OP_CLEAR_COLOR:
    case O.OP_VIEWPORT:
    case O.OP_SCISSOR:
    case O.OP_UNIFORM3F:
    case O.OP_DRAW_ELEMENTS:
    case O.OP_RENDERBUFFER_STORAGE:
    case O.OP_FRAMEBUFFER_RENDERBUFFER:
      return exact(v, 16);

    case O.OP_UNIFORM4F:
    case O.OP_FRAMEBUFFER_TEXTURE_2D:
      return exact(v, 20);

    case O.OP_VERTEX_ATTRIB_POINTER:
      return exact(v, 24);

    case O.OP_GEN_BUFFERS:
    case O.OP_DELETE_BUFFERS:
    case O.OP_GEN_TEXTURES:
    case O.OP_DELETE_TEXTURES:
    case O.OP_GEN_VERTEX_ARRAYS:
    case O.OP_DELETE_VERTEX_ARRAYS:
    case O.OP_GEN_FRAMEBUFFERS:
    case O.OP_GEN_RENDERBUFFERS:
      return u32ArrayPayload(v);

    case O.OP_BUFFER_DATA:
      return tailBytesPayload(v, 12, 4);
    case O.OP_BUFFER_SUB_DATA:
      return tailBytesPayload(v, 12, 8);
    case O.OP_TEX_IMAGE_2D:
    case O.OP_TEX_SUB_IMAGE_2D:
      return tailBytesPayload(v, 36, 32);
    case O.OP_SHADER_SOURCE:
      return tailBytesPayload(v, 8, 4);
    case O.OP_BIND_ATTRIB_LOCATION:
      return tailBytesPayload(v, 12, 8);

    case O.OP_UNIFORM_MATRIX4FV:
      return countedFloatPayload(v, 12, 4, 16);
    case O.OP_UNIFORM4FV:
      return countedFloatPayload(v, 8, 4, 4);

    default:
      return false;
  }
}

/** The shape record of the texture on the active unit, made on first touch. */
function boundTextureShape(b: GlBinding): GlTextureShape | null {
  const name = b.textureUnitNames.get(b.shadow.activeTexture);
  if (name === undefined) return null;
  let shape = b.textureShapes.get(name);
  if (!shape) {
    shape = { levels: new Map(), mipmapped: false };
    b.textureShapes.set(name, shape);
  }
  return shape;
}

function recordTextureLevelShape(
  b: GlBinding,
  level: number,
  levelShape: GlTextureLevelShape,
): void {
  const shape = boundTextureShape(b);
  if (shape) shape.levels.set(level, levelShape);
}

function dispatch(
  gl: WebGL2RenderingContext,
  b: GlBinding,
  v: DataView,
  p: number,
  op: number,
): void {
  switch (op) {
    // ----- state ----------------------------------------------------------
    case O.OP_CLEAR:
      gl.clear(v.getUint32(p, true));
      return;
    case O.OP_CLEAR_COLOR:
      b.shadow.clearColor = [
        v.getFloat32(p, true), v.getFloat32(p + 4, true),
        v.getFloat32(p + 8, true), v.getFloat32(p + 12, true),
      ];
      gl.clearColor(...b.shadow.clearColor);
      return;
    case O.OP_VIEWPORT:
      b.shadow.viewport = [
        v.getInt32(p, true), v.getInt32(p + 4, true),
        v.getInt32(p + 8, true), v.getInt32(p + 12, true),
      ];
      gl.viewport(...b.shadow.viewport);
      return;
    case O.OP_SCISSOR: {
      const x = v.getInt32(p, true);
      const y = v.getInt32(p + 4, true);
      const w = v.getInt32(p + 8, true);
      const h = v.getInt32(p + 12, true);
      gl.scissor(x, y, w, h);
      b.shadow.scissor.rect = [x, y, w, h];
      return;
    }
    case O.OP_ENABLE: {
      const cap = v.getUint32(p, true);
      gl.enable(cap);
      setCap(b.shadow, cap, true);
      return;
    }
    case O.OP_DISABLE: {
      const cap = v.getUint32(p, true);
      gl.disable(cap);
      setCap(b.shadow, cap, false);
      return;
    }
    case O.OP_BLEND_FUNC: {
      const s = v.getUint32(p, true), d = v.getUint32(p + 4, true);
      gl.blendFunc(s, d);
      b.shadow.blendFunc = { srcRGB: s, dstRGB: d, srcA: s, dstA: d };
      return;
    }
    case O.OP_DEPTH_FUNC:
      b.shadow.depthFunc = v.getUint32(p, true);
      gl.depthFunc(b.shadow.depthFunc);
      return;
    case O.OP_CULL_FACE:
      b.shadow.cullFace = v.getUint32(p, true);
      gl.cullFace(b.shadow.cullFace);
      return;
    case O.OP_FRONT_FACE:
      b.shadow.frontFace = v.getUint32(p, true);
      gl.frontFace(b.shadow.frontFace);
      return;
    case O.OP_LINE_WIDTH:
      gl.lineWidth(v.getFloat32(p, true));
      return;
    case O.OP_PIXEL_STOREI: {
      const pname = v.getUint32(p, true);
      const param = v.getInt32(p + 4, true);
      gl.pixelStorei(pname, param);
      if (pname === GL_UNPACK_ALIGNMENT) b.shadow.unpackAlignment = param;
      else if (pname === GL_PACK_ALIGNMENT) b.shadow.packAlignment = param;
      return;
    }

    // ----- buffers --------------------------------------------------------
    // Payload: u32 n, u32 names[n]
    case O.OP_GEN_BUFFERS: {
      const n = v.getUint32(p, true);
      for (let i = 0; i < n; i++) {
        const name = v.getUint32(p + 4 + i * 4, true);
        const buf = gl.createBuffer();
        if (buf) b.buffers.set(name, buf);
      }
      return;
    }
    case O.OP_DELETE_BUFFERS: {
      const n = v.getUint32(p, true);
      for (let i = 0; i < n; i++) {
        const name = v.getUint32(p + 4 + i * 4, true);
        const obj = b.buffers.get(name);
        if (obj) gl.deleteBuffer(obj);
        b.buffers.delete(name);
      }
      return;
    }
    case O.OP_BIND_BUFFER:
      gl.bindBuffer(
        v.getUint32(p, true),
        b.buffers.get(v.getUint32(p + 4, true)) ?? null,
      );
      return;
    // Payload: u32 target, u32 dataLen, u8 data[dataLen], u32 usage
    case O.OP_BUFFER_DATA: {
      const target = v.getUint32(p, true);
      const dataLen = v.getUint32(p + 4, true);
      const usage = v.getUint32(p + 8 + dataLen, true);
      if (dataLen === 0) {
        gl.bufferData(target, 0, usage);
      } else {
        const data = new Uint8Array(v.buffer, v.byteOffset + p + 8, dataLen);
        gl.bufferData(target, data, usage);
      }
      return;
    }
    // Payload: u32 target, i32 dstOffset, u32 dataLen, u8 data[dataLen]
    case O.OP_BUFFER_SUB_DATA: {
      const target = v.getUint32(p, true);
      const dstOff = v.getInt32(p + 4, true);
      const dataLen = v.getUint32(p + 8, true);
      const data = new Uint8Array(v.buffer, v.byteOffset + p + 12, dataLen);
      gl.bufferSubData(target, dstOff, data);
      return;
    }

    // ----- textures -------------------------------------------------------
    case O.OP_GEN_TEXTURES: {
      const n = v.getUint32(p, true);
      for (let i = 0; i < n; i++) {
        const name = v.getUint32(p + 4 + i * 4, true);
        const tex = gl.createTexture();
        if (tex) b.textures.set(name, tex);
      }
      return;
    }
    case O.OP_DELETE_TEXTURES: {
      const n = v.getUint32(p, true);
      for (let i = 0; i < n; i++) {
        const name = v.getUint32(p + 4 + i * 4, true);
        const obj = b.textures.get(name);
        if (obj) gl.deleteTexture(obj);
        b.textures.delete(name);
        b.textureShapes.delete(name);
        for (const [unit, unitName] of b.textureUnitNames) {
          if (unitName === name) b.textureUnitNames.delete(unit);
        }
      }
      return;
    }
    case O.OP_BIND_TEXTURE: {
      const name = v.getUint32(p + 4, true);
      const tex = b.textures.get(name) ?? null;
      gl.bindTexture(v.getUint32(p, true), tex);
      const unit = b.shadow.activeTexture;
      if (unit >= 0 && unit < b.shadow.textureUnits.length) {
        b.shadow.textureUnits[unit] = tex;
        if (tex) b.textureUnitNames.set(unit, name);
        else b.textureUnitNames.delete(unit);
      }
      return;
    }
    // Payload: u32 target, i32 level, i32 internalFormat, i32 width,
    //          i32 height, i32 border, u32 format, u32 type,
    //          u32 dataLen, u8 data[dataLen]
    case O.OP_TEX_IMAGE_2D: {
      const target = v.getUint32(p, true);
      const level = v.getInt32(p + 4, true);
      const internalFormat = v.getInt32(p + 8, true);
      const width = v.getInt32(p + 12, true);
      const height = v.getInt32(p + 16, true);
      const border = v.getInt32(p + 20, true);
      const format = v.getUint32(p + 24, true);
      const type = v.getUint32(p + 28, true);
      const dataLen = v.getUint32(p + 32, true);
      const data = dataLen === 0
        ? null
        : new Uint8Array(v.buffer, v.byteOffset + p + 36, dataLen);
      gl.texImage2D(
        target, level, internalFormat, width, height, border,
        format, type, data,
      );
      recordTextureLevelShape(b, level, {
        internalFormat, width, height, format, type,
      });
      return;
    }
    // Payload: u32 target, i32 level, i32 xoff, i32 yoff, i32 width,
    //          i32 height, u32 format, u32 type,
    //          u32 dataLen, u8 data[dataLen]
    case O.OP_TEX_SUB_IMAGE_2D: {
      const target = v.getUint32(p, true);
      const level = v.getInt32(p + 4, true);
      const xoff = v.getInt32(p + 8, true);
      const yoff = v.getInt32(p + 12, true);
      const width = v.getInt32(p + 16, true);
      const height = v.getInt32(p + 20, true);
      const format = v.getUint32(p + 24, true);
      const type = v.getUint32(p + 28, true);
      const dataLen = v.getUint32(p + 32, true);
      const data = new Uint8Array(v.buffer, v.byteOffset + p + 36, dataLen);
      gl.texSubImage2D(
        target, level, xoff, yoff, width, height, format, type, data,
      );
      return;
    }
    case O.OP_TEX_PARAMETERI:
      gl.texParameteri(
        v.getUint32(p, true),
        v.getUint32(p + 4, true),
        v.getInt32(p + 8, true),
      );
      return;
    case O.OP_ACTIVE_TEXTURE: {
      const unit = v.getUint32(p, true);
      gl.activeTexture(unit);
      b.shadow.activeTexture = unit - GL_TEXTURE0;
      return;
    }
    case O.OP_GENERATE_MIPMAP: {
      gl.generateMipmap(v.getUint32(p, true));
      const shape = boundTextureShape(b);
      if (shape) shape.mipmapped = true;
      return;
    }

    // ----- shaders / programs --------------------------------------------
    // Payload: u32 type, u32 cmdbufName
    case O.OP_CREATE_SHADER: {
      const type = v.getUint32(p, true);
      const name = v.getUint32(p + 4, true);
      const sh = gl.createShader(type);
      if (sh) b.shaders.set(name, sh);
      return;
    }
    // Payload: u32 cmdbufName, u32 srcLen, u8 src[srcLen] (UTF-8)
    case O.OP_SHADER_SOURCE: {
      const name = v.getUint32(p, true);
      const srcLen = v.getUint32(p + 4, true);
      // TextDecoder rejects views over SharedArrayBuffer, which the
      // cmdbuf is when the user program runs against shared memory
      // (the wasm-posix-kernel default). Copy into a fresh
      // Uint8Array — also detaches from SAB grow races.
      const srcBytes = new Uint8Array(srcLen);
      srcBytes.set(new Uint8Array(v.buffer, v.byteOffset + p + 8, srcLen));
      const src = new TextDecoder().decode(srcBytes);
      const sh = b.shaders.get(name);
      if (sh) gl.shaderSource(sh, src);
      return;
    }
    case O.OP_COMPILE_SHADER: {
      const sh = b.shaders.get(v.getUint32(p, true));
      if (sh) gl.compileShader(sh);
      return;
    }
    case O.OP_DELETE_SHADER: {
      const name = v.getUint32(p, true);
      const sh = b.shaders.get(name);
      if (sh) gl.deleteShader(sh);
      b.shaders.delete(name);
      return;
    }
    case O.OP_CREATE_PROGRAM: {
      const name = v.getUint32(p, true);
      const prog = gl.createProgram();
      if (prog) b.programs.set(name, prog);
      return;
    }
    case O.OP_ATTACH_SHADER: {
      const prog = b.programs.get(v.getUint32(p, true));
      const sh = b.shaders.get(v.getUint32(p + 4, true));
      if (prog && sh) gl.attachShader(prog, sh);
      return;
    }
    case O.OP_LINK_PROGRAM: {
      const prog = b.programs.get(v.getUint32(p, true));
      if (prog) gl.linkProgram(prog);
      return;
    }
    case O.OP_USE_PROGRAM: {
      const prog = b.programs.get(v.getUint32(p, true)) ?? null;
      gl.useProgram(prog);
      b.currentProgram = prog;
      b.shadow.currentProgram = prog;
      return;
    }
    // Payload: u32 program, u32 index, u32 nameLen, u8 name[nameLen]
    case O.OP_BIND_ATTRIB_LOCATION: {
      const prog = b.programs.get(v.getUint32(p, true));
      const index = v.getUint32(p + 4, true);
      const nameLen = v.getUint32(p + 8, true);
      // Copy off the (possibly shared) cmdbuf — TextDecoder rejects
      // views over SharedArrayBuffer.
      const nameBytes = new Uint8Array(nameLen);
      nameBytes.set(new Uint8Array(v.buffer, v.byteOffset + p + 12, nameLen));
      const name = new TextDecoder().decode(nameBytes);
      if (prog) gl.bindAttribLocation(prog, index, name);
      return;
    }
    case O.OP_DELETE_PROGRAM: {
      const name = v.getUint32(p, true);
      const prog = b.programs.get(name);
      if (prog) gl.deleteProgram(prog);
      b.programs.delete(name);
      return;
    }

    // ----- uniforms -------------------------------------------------------
    // Locations are kernel-routed indices issued by `runGlQuery` for
    // `QOP_GET_UNIFORM_LOC`; they round-trip back here as i32.
    case O.OP_UNIFORM1I: {
      const loc = b.uniformLocations.get(v.getInt32(p, true)) ?? null;
      gl.uniform1i(loc, v.getInt32(p + 4, true));
      return;
    }
    case O.OP_UNIFORM1F: {
      const loc = b.uniformLocations.get(v.getInt32(p, true)) ?? null;
      gl.uniform1f(loc, v.getFloat32(p + 4, true));
      return;
    }
    case O.OP_UNIFORM2F: {
      const loc = b.uniformLocations.get(v.getInt32(p, true)) ?? null;
      gl.uniform2f(loc, v.getFloat32(p + 4, true), v.getFloat32(p + 8, true));
      return;
    }
    case O.OP_UNIFORM3F: {
      const loc = b.uniformLocations.get(v.getInt32(p, true)) ?? null;
      gl.uniform3f(
        loc,
        v.getFloat32(p + 4, true),
        v.getFloat32(p + 8, true),
        v.getFloat32(p + 12, true),
      );
      return;
    }
    case O.OP_UNIFORM4F: {
      const loc = b.uniformLocations.get(v.getInt32(p, true)) ?? null;
      gl.uniform4f(
        loc,
        v.getFloat32(p + 4, true),
        v.getFloat32(p + 8, true),
        v.getFloat32(p + 12, true),
        v.getFloat32(p + 16, true),
      );
      return;
    }
    // Payload: i32 location, u32 count, u32 transposeBool, f32 mat[count*16]
    case O.OP_UNIFORM_MATRIX4FV: {
      const loc = b.uniformLocations.get(v.getInt32(p, true)) ?? null;
      const count = v.getUint32(p + 4, true);
      const transpose = v.getUint32(p + 8, true) !== 0;
      const mat = new Float32Array(
        v.buffer,
        v.byteOffset + p + 12,
        count * 16,
      );
      gl.uniformMatrix4fv(loc, transpose, mat);
      return;
    }
    // Payload: i32 location, u32 count, f32 v[count*4]
    case O.OP_UNIFORM4FV: {
      const loc = b.uniformLocations.get(v.getInt32(p, true)) ?? null;
      const count = v.getUint32(p + 4, true);
      const arr = new Float32Array(
        v.buffer,
        v.byteOffset + p + 8,
        count * 4,
      );
      gl.uniform4fv(loc, arr);
      return;
    }

    // ----- vertex attribs / draws -----------------------------------------
    case O.OP_ENABLE_VERTEX_ATTRIB_ARRAY:
      gl.enableVertexAttribArray(v.getUint32(p, true));
      return;
    case O.OP_DISABLE_VERTEX_ATTRIB_ARRAY:
      gl.disableVertexAttribArray(v.getUint32(p, true));
      return;
    // Payload: u32 index, i32 size, u32 type, u32 normalizedBool,
    //          i32 stride, i32 offset
    case O.OP_VERTEX_ATTRIB_POINTER: {
      const index = v.getUint32(p, true);
      const size = v.getInt32(p + 4, true);
      const type = v.getUint32(p + 8, true);
      const normalized = v.getUint32(p + 12, true) !== 0;
      const stride = v.getInt32(p + 16, true);
      const off = v.getInt32(p + 20, true);
      gl.vertexAttribPointer(index, size, type, normalized, stride, off);
      return;
    }
    case O.OP_DRAW_ARRAYS:
      gl.drawArrays(
        v.getUint32(p, true),
        v.getInt32(p + 4, true),
        v.getInt32(p + 8, true),
      );
      return;
    case O.OP_DRAW_ELEMENTS:
      gl.drawElements(
        v.getUint32(p, true),
        v.getInt32(p + 4, true),
        v.getUint32(p + 8, true),
        v.getUint32(p + 12, true),
      );
      return;

    // ----- VAOs -----------------------------------------------------------
    case O.OP_GEN_VERTEX_ARRAYS: {
      const n = v.getUint32(p, true);
      for (let i = 0; i < n; i++) {
        const name = v.getUint32(p + 4 + i * 4, true);
        const vao = gl.createVertexArray();
        if (vao) b.vaos.set(name, vao);
      }
      return;
    }
    case O.OP_DELETE_VERTEX_ARRAYS: {
      const n = v.getUint32(p, true);
      for (let i = 0; i < n; i++) {
        const name = v.getUint32(p + 4 + i * 4, true);
        const obj = b.vaos.get(name);
        if (obj) gl.deleteVertexArray(obj);
        b.vaos.delete(name);
      }
      return;
    }
    case O.OP_BIND_VERTEX_ARRAY: {
      const vao = b.vaos.get(v.getUint32(p, true)) ?? null;
      gl.bindVertexArray(vao);
      b.shadow.vao = vao;
      return;
    }

    // ----- framebuffers / renderbuffers -----------------------------------
    case O.OP_GEN_FRAMEBUFFERS: {
      const n = v.getUint32(p, true);
      for (let i = 0; i < n; i++) {
        const name = v.getUint32(p + 4 + i * 4, true);
        const fbo = gl.createFramebuffer();
        if (fbo) b.fbos.set(name, fbo);
      }
      return;
    }
    case O.OP_BIND_FRAMEBUFFER: {
      const target = v.getUint32(p, true);
      const fbo = b.fbos.get(v.getUint32(p + 4, true)) ?? null;
      gl.bindFramebuffer(target, fbo);
      if (target !== GL_READ_FRAMEBUFFER) b.shadow.fbo = fbo;
      return;
    }
    // Payload: u32 target, u32 attachment, u32 textarget, u32 textureName,
    //          i32 level
    case O.OP_FRAMEBUFFER_TEXTURE_2D: {
      const target = v.getUint32(p, true);
      const attachment = v.getUint32(p + 4, true);
      const textarget = v.getUint32(p + 8, true);
      const tex = b.textures.get(v.getUint32(p + 12, true)) ?? null;
      const level = v.getInt32(p + 16, true);
      gl.framebufferTexture2D(target, attachment, textarget, tex, level);
      return;
    }
    case O.OP_GEN_RENDERBUFFERS: {
      const n = v.getUint32(p, true);
      for (let i = 0; i < n; i++) {
        const name = v.getUint32(p + 4 + i * 4, true);
        const rbo = gl.createRenderbuffer();
        if (rbo) b.rbos.set(name, rbo);
      }
      return;
    }
    case O.OP_BIND_RENDERBUFFER:
      gl.bindRenderbuffer(
        v.getUint32(p, true),
        b.rbos.get(v.getUint32(p + 4, true)) ?? null,
      );
      return;
    // Payload: u32 target, u32 internalformat, i32 width, i32 height
    case O.OP_RENDERBUFFER_STORAGE:
      gl.renderbufferStorage(
        v.getUint32(p, true),
        v.getUint32(p + 4, true),
        v.getInt32(p + 8, true),
        v.getInt32(p + 12, true),
      );
      return;
    // Payload: u32 target, u32 attachment, u32 rbtarget, u32 rboName
    case O.OP_FRAMEBUFFER_RENDERBUFFER: {
      const target = v.getUint32(p, true);
      const attachment = v.getUint32(p + 4, true);
      const rbtarget = v.getUint32(p + 8, true);
      const rbo = b.rbos.get(v.getUint32(p + 12, true)) ?? null;
      gl.framebufferRenderbuffer(target, attachment, rbtarget, rbo);
      return;
    }

    default:
      throw new Error(
        `gl bridge: unknown op 0x${op.toString(16).padStart(4, "0")} at offset ${p - 4}`,
      );
  }
}
