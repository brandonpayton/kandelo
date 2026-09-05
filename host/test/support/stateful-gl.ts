/**
 * Stateful WebGL2 stand-in for the snapshot and rebuild tests.
 *
 * `RecordingGl` in webgl-bridge.test.ts only records calls; the snapshot
 * asks questions and the rebuild makes state the next snapshot must see,
 * so this fake holds real answers: buffers keep their bytes, textures
 * keep RGBA pixels per level, programs keep uniforms and attribute
 * bindings, vertex arrays keep their wiring. That is what lets a test
 * capture one context, rebuild into a fresh one, and capture again
 * expecting equality.
 *
 * Uniform declarations come from `uniformDeclarationsBySource`: a real
 * link discovers active uniforms from the compiled source, and the fake
 * looks the source up in that map instead.
 */
import {
  GL_ARRAY_BUFFER_BINDING,
  GL_BUFFER_SIZE,
  GL_BUFFER_USAGE,
  GL_COLOR_ATTACHMENT0,
  GL_COPY_READ_BUFFER,
  GL_ELEMENT_ARRAY_BUFFER_BINDING,
  GL_FLOAT,
  GL_FRAMEBUFFER_ATTACHMENT_OBJECT_NAME,
  GL_FRAMEBUFFER_ATTACHMENT_OBJECT_TYPE,
  GL_FRAMEBUFFER_ATTACHMENT_TEXTURE_LEVEL,
  GL_FRAMEBUFFER_COMPLETE,
  GL_LINE_WIDTH,
  GL_MAX_VERTEX_ATTRIBS,
  GL_READ_FRAMEBUFFER_BINDING,
  GL_RENDERBUFFER_BINDING,
  GL_RENDERBUFFER_HEIGHT,
  GL_RENDERBUFFER_INTERNAL_FORMAT,
  GL_RENDERBUFFER_WIDTH,
  GL_TEXTURE,
  glChannelCount,
  GL_VERTEX_ATTRIB_ARRAY_BUFFER_BINDING,
  GL_VERTEX_ATTRIB_ARRAY_ENABLED,
  GL_VERTEX_ATTRIB_ARRAY_NORMALIZED,
  GL_VERTEX_ATTRIB_ARRAY_SIZE,
  GL_VERTEX_ATTRIB_ARRAY_STRIDE,
  GL_VERTEX_ATTRIB_ARRAY_TYPE,
} from "../../src/webgl/snapshot.js";
import { GL_READ_FRAMEBUFFER } from "../../src/webgl/shadow.js";

const GL_FRAMEBUFFER = 0x8d40;
const GL_ARRAY_BUFFER = 0x8892;
const GL_ELEMENT_ARRAY_BUFFER = 0x8893;
const GL_COPY_WRITE_BUFFER = 0x8f37;
const GL_TEXTURE0 = 0x84c0;
const GL_PACK_ALIGNMENT = 0x0d05;
const GL_UNPACK_ALIGNMENT = 0x0cf5;
const GL_COMPILE_STATUS = 0x8b81;
const GL_LINK_STATUS = 0x8b82;
const GL_ACTIVE_UNIFORMS = 0x8b86;
const GL_ACTIVE_ATTRIBUTES = 0x8b89;
const GL_SHADER_TYPE = 0x8b4f;
const GL_RENDERBUFFER_OBJECT = 0x8d41;
const GL_FLOAT_VEC2 = 0x8b50;

export type FakeBuffer = { kind: "buffer"; bytes: Uint8Array; usage: number };
export type FakeTexture = {
  kind: "texture";
  params: Map<number, number>;
  /** RGBA data per level, as readPixels answers it. */
  levelRgba: Map<number, Float32Array | Uint8Array>;
};
export type FakeShader = {
  kind: "shader";
  type: number;
  source: string;
  compiled: boolean;
};
export type FakeUniform = {
  name: string;
  type: number;
  size: number;
  values: unknown[];
};
export type FakeProgram = {
  kind: "program";
  attached: FakeShader[];
  linked: boolean;
  attribs: { name: string; location: number }[];
  uniforms: FakeUniform[];
  pendingAttribs: { name: string; location: number }[];
};
export type FakeAttrib = {
  enabled: boolean;
  buffer: FakeBuffer | null;
  size: number;
  type: number;
  normalized: boolean;
  stride: number;
  offset: number;
};
export type FakeVao = {
  kind: "vao";
  element: FakeBuffer | null;
  attribs: Map<number, FakeAttrib>;
};
export type FakeFbo = {
  kind: "fbo";
  attachments: Map<number, { object: FakeTexture | FakeRbo; level: number }>;
};
export type FakeRbo = {
  kind: "rbo";
  internalFormat: number;
  width: number;
  height: number;
};

type FakeLocation = { uniform: FakeUniform; element: number };

export function fakeBuffer(bytes: number[], usage = 0x88e4): FakeBuffer {
  return { kind: "buffer", bytes: new Uint8Array(bytes), usage };
}

export function fakeTexture(params: [number, number][] = []): FakeTexture {
  return { kind: "texture", params: new Map(params), levelRgba: new Map() };
}

export function fakeProgram(): FakeProgram {
  return {
    kind: "program",
    attached: [],
    linked: false,
    attribs: [],
    uniforms: [],
    pendingAttribs: [],
  };
}

export class StatefulGl {
  copyReadBuffer: FakeBuffer | null = null;
  copyWriteBuffer: FakeBuffer | null = null;
  arrayBuffer: FakeBuffer | null = null;
  readFbo: FakeFbo | null = null;
  drawFbo: FakeFbo | null = null;
  renderbuffer: FakeRbo | null = null;
  activeUnit = 0;
  unitTextures = new Map<number, FakeTexture>();
  defaultVao: FakeVao = { kind: "vao", element: null, attribs: new Map() };
  boundVao: FakeVao;
  currentProgram: FakeProgram | null = null;
  packAlignment = 4;
  unpackAlignment = 4;
  currentLineWidth = 1;
  /** Active uniforms a link "discovers", by vertex/fragment source. */
  uniformDeclarationsBySource = new Map<string, FakeUniform[]>();

  constructor() {
    this.boundVao = this.defaultVao;
  }

  getExtension(_name: string): null {
    return null;
  }

  // ---- framebuffers ------------------------------------------------------
  createFramebuffer(): FakeFbo {
    return { kind: "fbo", attachments: new Map() };
  }
  deleteFramebuffer(_fbo: FakeFbo): void {}
  bindFramebuffer(target: number, fbo: FakeFbo | null): void {
    if (target === GL_READ_FRAMEBUFFER) {
      this.readFbo = fbo;
      return;
    }
    if (target === GL_FRAMEBUFFER) {
      this.readFbo = fbo;
      this.drawFbo = fbo;
    }
  }
  #fboAt(target: number): FakeFbo | null {
    return target === GL_READ_FRAMEBUFFER ? this.readFbo : this.drawFbo;
  }
  framebufferTexture2D(
    target: number,
    attachment: number,
    _textarget: number,
    texture: FakeTexture | null,
    level: number,
  ): void {
    const fbo = this.#fboAt(target);
    if (!fbo) return;
    if (texture === null) fbo.attachments.delete(attachment);
    else fbo.attachments.set(attachment, { object: texture, level });
  }
  framebufferRenderbuffer(
    target: number,
    attachment: number,
    _rbtarget: number,
    rbo: FakeRbo | null,
  ): void {
    const fbo = this.#fboAt(target);
    if (!fbo) return;
    if (rbo === null) fbo.attachments.delete(attachment);
    else fbo.attachments.set(attachment, { object: rbo, level: 0 });
  }
  checkFramebufferStatus(_target: number): number {
    return GL_FRAMEBUFFER_COMPLETE;
  }
  readPixels(
    _x: number,
    _y: number,
    _w: number,
    _h: number,
    _format: number,
    _type: number,
    out: Float32Array | Uint8Array,
  ): void {
    const attached = this.readFbo?.attachments.get(GL_COLOR_ATTACHMENT0);
    if (!attached || attached.object.kind !== "texture") return;
    const rgba = attached.object.levelRgba.get(attached.level);
    if (rgba) out.set(rgba.subarray(0, out.length) as never);
  }

  // ---- buffers -----------------------------------------------------------
  createBuffer(): FakeBuffer {
    return { kind: "buffer", bytes: new Uint8Array(0), usage: 0 };
  }
  bindBuffer(target: number, buffer: FakeBuffer | null): void {
    if (target === GL_COPY_READ_BUFFER) this.copyReadBuffer = buffer;
    else if (target === GL_COPY_WRITE_BUFFER) this.copyWriteBuffer = buffer;
    else if (target === GL_ARRAY_BUFFER) this.arrayBuffer = buffer;
    else if (target === GL_ELEMENT_ARRAY_BUFFER) this.boundVao.element = buffer;
  }
  bufferData(target: number, data: Uint8Array, usage: number): void {
    const buffer = target === GL_COPY_WRITE_BUFFER
      ? this.copyWriteBuffer
      : target === GL_ARRAY_BUFFER
        ? this.arrayBuffer
        : this.boundVao.element;
    if (!buffer) return;
    buffer.bytes = new Uint8Array(data);
    buffer.usage = usage;
  }
  getBufferParameter(_target: number, pname: number): number {
    if (pname === GL_BUFFER_SIZE) return this.copyReadBuffer?.bytes.byteLength ?? 0;
    if (pname === GL_BUFFER_USAGE) return this.copyReadBuffer?.usage ?? 0;
    return 0;
  }
  getBufferSubData(_target: number, _offset: number, out: Uint8Array): void {
    if (this.copyReadBuffer) out.set(this.copyReadBuffer.bytes);
  }

  // ---- textures ----------------------------------------------------------
  createTexture(): FakeTexture {
    return fakeTexture();
  }
  activeTexture(unit: number): void {
    this.activeUnit = unit - GL_TEXTURE0;
  }
  bindTexture(_target: number, texture: FakeTexture | null): void {
    if (texture === null) this.unitTextures.delete(this.activeUnit);
    else this.unitTextures.set(this.activeUnit, texture);
  }
  texImage2D(
    _target: number,
    level: number,
    _internalFormat: number,
    width: number,
    height: number,
    _border: number,
    format: number,
    _type: number,
    data: Float32Array | Uint8Array | null,
  ): void {
    const texture = this.unitTextures.get(this.activeUnit);
    if (!texture) return;
    if (data === null) {
      texture.levelRgba.delete(level);
      return;
    }
    const channels = glChannelCount(format) ?? 4;
    const pixelCount = width * height;
    const rgba = data instanceof Float32Array
      ? new Float32Array(pixelCount * 4)
      : new Uint8Array(pixelCount * 4);
    for (let pixel = 0; pixel < pixelCount; pixel++) {
      for (let channel = 0; channel < channels; channel++) {
        rgba[pixel * 4 + channel] = data[pixel * channels + channel]!;
      }
    }
    texture.levelRgba.set(level, rgba);
  }
  texParameteri(_target: number, pname: number, value: number): void {
    this.unitTextures.get(this.activeUnit)?.params.set(pname, value);
  }
  getTexParameter(_target: number, pname: number): number {
    return this.unitTextures.get(this.activeUnit)?.params.get(pname) ?? 0;
  }
  generateMipmap(_target: number): void {}
  pixelStorei(pname: number, value: number): void {
    if (pname === GL_PACK_ALIGNMENT) this.packAlignment = value;
    if (pname === GL_UNPACK_ALIGNMENT) this.unpackAlignment = value;
  }

  // ---- renderbuffers -----------------------------------------------------
  createRenderbuffer(): FakeRbo {
    return { kind: "rbo", internalFormat: 0, width: 0, height: 0 };
  }
  bindRenderbuffer(_target: number, rbo: FakeRbo | null): void {
    this.renderbuffer = rbo;
  }
  renderbufferStorage(
    _target: number,
    internalFormat: number,
    width: number,
    height: number,
  ): void {
    if (!this.renderbuffer) return;
    this.renderbuffer.internalFormat = internalFormat;
    this.renderbuffer.width = width;
    this.renderbuffer.height = height;
  }
  getRenderbufferParameter(_target: number, pname: number): number {
    const rbo = this.renderbuffer;
    if (!rbo) return 0;
    if (pname === GL_RENDERBUFFER_WIDTH) return rbo.width;
    if (pname === GL_RENDERBUFFER_HEIGHT) return rbo.height;
    if (pname === GL_RENDERBUFFER_INTERNAL_FORMAT) return rbo.internalFormat;
    return 0;
  }

  // ---- shaders / programs ------------------------------------------------
  createShader(type: number): FakeShader {
    return { kind: "shader", type, source: "", compiled: false };
  }
  shaderSource(shader: FakeShader, source: string): void {
    shader.source = source;
  }
  compileShader(shader: FakeShader): void {
    shader.compiled = true;
  }
  getShaderSource(shader: FakeShader): string {
    return shader.source;
  }
  getShaderParameter(shader: FakeShader, pname: number): number | boolean {
    if (pname === GL_SHADER_TYPE) return shader.type;
    if (pname === GL_COMPILE_STATUS) return shader.compiled;
    return 0;
  }
  createProgram(): FakeProgram {
    return fakeProgram();
  }
  attachShader(program: FakeProgram, shader: FakeShader): void {
    program.attached.push(shader);
  }
  bindAttribLocation(program: FakeProgram, location: number, name: string): void {
    program.pendingAttribs.push({ name, location });
  }
  linkProgram(program: FakeProgram): void {
    program.linked = true;
    program.attribs = [...program.pendingAttribs];
    program.uniforms = program.attached.flatMap((shader) =>
      (this.uniformDeclarationsBySource.get(shader.source) ?? []).map(
        (declaration) => ({
          ...declaration,
          values: declaration.values.map(cloneUniformValue),
        }),
      )
    );
  }
  useProgram(program: FakeProgram | null): void {
    this.currentProgram = program;
  }
  getAttachedShaders(program: FakeProgram): FakeShader[] {
    return program.attached;
  }
  getProgramParameter(program: FakeProgram, pname: number): number | boolean {
    if (pname === GL_LINK_STATUS) return program.linked;
    if (pname === GL_ACTIVE_ATTRIBUTES) return program.attribs.length;
    if (pname === GL_ACTIVE_UNIFORMS) return program.uniforms.length;
    return 0;
  }
  getActiveAttrib(program: FakeProgram, index: number) {
    const attrib = program.attribs[index];
    return attrib ? { name: attrib.name, type: GL_FLOAT_VEC2, size: 1 } : null;
  }
  getAttribLocation(program: FakeProgram, name: string): number {
    return program.attribs.find((attrib) => attrib.name === name)?.location ?? -1;
  }
  getActiveUniform(program: FakeProgram, index: number) {
    const uniform = program.uniforms[index];
    if (!uniform) return null;
    return {
      name: uniform.size > 1 ? `${uniform.name}[0]` : uniform.name,
      type: uniform.type,
      size: uniform.size,
    };
  }
  getUniformLocation(program: FakeProgram, name: string): FakeLocation | null {
    for (const uniform of program.uniforms) {
      if (uniform.size === 1 && uniform.name === name) {
        return { uniform, element: 0 };
      }
      for (let element = 0; element < uniform.size; element++) {
        if (`${uniform.name}[${element}]` === name) return { uniform, element };
      }
    }
    return null;
  }
  getUniform(_program: FakeProgram, location: FakeLocation): unknown {
    return location.uniform.values[location.element];
  }
  uniform1f(l: FakeLocation, x: number): void { l.uniform.values[l.element] = x; }
  uniform2f(l: FakeLocation, x: number, y: number): void {
    l.uniform.values[l.element] = new Float32Array([x, y]);
  }
  uniform3f(l: FakeLocation, x: number, y: number, z: number): void {
    l.uniform.values[l.element] = new Float32Array([x, y, z]);
  }
  uniform4f(l: FakeLocation, x: number, y: number, z: number, w: number): void {
    l.uniform.values[l.element] = new Float32Array([x, y, z, w]);
  }
  uniform1i(l: FakeLocation, x: number): void { l.uniform.values[l.element] = x; }
  uniform2i(l: FakeLocation, x: number, y: number): void {
    l.uniform.values[l.element] = new Int32Array([x, y]);
  }
  uniform3i(l: FakeLocation, x: number, y: number, z: number): void {
    l.uniform.values[l.element] = new Int32Array([x, y, z]);
  }
  uniform4i(l: FakeLocation, x: number, y: number, z: number, w: number): void {
    l.uniform.values[l.element] = new Int32Array([x, y, z, w]);
  }
  uniformMatrix2fv(l: FakeLocation, _t: boolean, m: Float32Array): void {
    l.uniform.values[l.element] = new Float32Array(m);
  }
  uniformMatrix3fv(l: FakeLocation, _t: boolean, m: Float32Array): void {
    l.uniform.values[l.element] = new Float32Array(m);
  }
  uniformMatrix4fv(l: FakeLocation, _t: boolean, m: Float32Array): void {
    l.uniform.values[l.element] = new Float32Array(m);
  }

  // ---- vertex arrays -----------------------------------------------------
  createVertexArray(): FakeVao {
    return { kind: "vao", element: null, attribs: new Map() };
  }
  bindVertexArray(vao: FakeVao | null): void {
    this.boundVao = vao ?? this.defaultVao;
  }
  #attribAt(index: number): FakeAttrib {
    let attrib = this.boundVao.attribs.get(index);
    if (!attrib) {
      attrib = {
        enabled: false,
        buffer: null,
        size: 4,
        type: GL_FLOAT,
        normalized: false,
        stride: 0,
        offset: 0,
      };
      this.boundVao.attribs.set(index, attrib);
    }
    return attrib;
  }
  vertexAttribPointer(
    index: number,
    size: number,
    type: number,
    normalized: boolean,
    stride: number,
    offset: number,
  ): void {
    const attrib = this.#attribAt(index);
    attrib.buffer = this.arrayBuffer;
    attrib.size = size;
    attrib.type = type;
    attrib.normalized = normalized;
    attrib.stride = stride;
    attrib.offset = offset;
  }
  enableVertexAttribArray(index: number): void {
    this.#attribAt(index).enabled = true;
  }
  disableVertexAttribArray(index: number): void {
    const attrib = this.boundVao.attribs.get(index);
    if (attrib) attrib.enabled = false;
  }
  getVertexAttrib(index: number, pname: number): unknown {
    const attrib = this.boundVao.attribs.get(index);
    if (!attrib) {
      return pname === GL_VERTEX_ATTRIB_ARRAY_BUFFER_BINDING ? null : false;
    }
    switch (pname) {
      case GL_VERTEX_ATTRIB_ARRAY_ENABLED: return attrib.enabled;
      case GL_VERTEX_ATTRIB_ARRAY_BUFFER_BINDING: return attrib.buffer;
      case GL_VERTEX_ATTRIB_ARRAY_SIZE: return attrib.size;
      case GL_VERTEX_ATTRIB_ARRAY_TYPE: return attrib.type;
      case GL_VERTEX_ATTRIB_ARRAY_NORMALIZED: return attrib.normalized;
      case GL_VERTEX_ATTRIB_ARRAY_STRIDE: return attrib.stride;
      default: return 0;
    }
  }
  getVertexAttribOffset(index: number, _pname: number): number {
    return this.boundVao.attribs.get(index)?.offset ?? 0;
  }

  // ---- pipeline state (recorded, not modeled) ----------------------------
  viewport(): void {}
  scissor(): void {}
  clearColor(): void {}
  enable(): void {}
  disable(): void {}
  depthFunc(): void {}
  cullFace(): void {}
  frontFace(): void {}
  blendFuncSeparate(): void {}
  lineWidth(width: number): void {
    this.currentLineWidth = width;
  }

  getFramebufferAttachmentParameter(
    _target: number,
    attachment: number,
    pname: number,
  ): unknown {
    const attached = this.readFbo?.attachments.get(attachment);
    if (!attached) {
      return pname === GL_FRAMEBUFFER_ATTACHMENT_OBJECT_TYPE ? 0 : null;
    }
    if (pname === GL_FRAMEBUFFER_ATTACHMENT_OBJECT_TYPE) {
      return attached.object.kind === "texture"
        ? GL_TEXTURE
        : GL_RENDERBUFFER_OBJECT;
    }
    if (pname === GL_FRAMEBUFFER_ATTACHMENT_OBJECT_NAME) return attached.object;
    if (pname === GL_FRAMEBUFFER_ATTACHMENT_TEXTURE_LEVEL) return attached.level;
    return null;
  }

  getParameter(pname: number): unknown {
    switch (pname) {
      case GL_COPY_READ_BUFFER: return this.copyReadBuffer;
      case GL_READ_FRAMEBUFFER_BINDING: return this.readFbo;
      case GL_RENDERBUFFER_BINDING: return this.renderbuffer;
      case GL_ARRAY_BUFFER_BINDING: return this.arrayBuffer;
      case GL_ELEMENT_ARRAY_BUFFER_BINDING: return this.boundVao.element;
      case GL_MAX_VERTEX_ATTRIBS: return 16;
      case GL_LINE_WIDTH: return this.currentLineWidth;
      default: return 0;
    }
  }
}

function cloneUniformValue(value: unknown): unknown {
  if (value instanceof Float32Array) return new Float32Array(value);
  if (value instanceof Int32Array) return new Int32Array(value);
  return value;
}
