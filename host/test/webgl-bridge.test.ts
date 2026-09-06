import { describe, expect, it } from "vitest";
import {
  decodeAndDispatch,
  GL_SUBMIT_EINVAL,
} from "../src/webgl/bridge.js";
import { runGlQuery } from "../src/webgl/query.js";
import * as O from "../src/webgl/ops.js";
import { GlContextRegistry } from "../src/webgl/registry.js";

/**
 * Hand-rolled WebGL2 stand-in. Records every dispatched call as
 * [methodName, [...args]] tuples; returns synthetic values for the
 * createX() / getX() shapes the bridge / query handler exercise.
 *
 * Vitest's default node environment has no WebGL implementation;
 * jsdom doesn't either. Real-WebGL coverage lives in Playwright (Task B7)
 * and the optional headless-gl smoke test (Task B6, deferred).
 */
class RecordingGl {
  log: Array<[string, unknown[]]> = [];

  // counters so each create*() returns a unique handle the test can match
  private next = 1;

  // factories
  createBuffer() {
    const v = { kind: "buffer", id: this.next++ };
    this.log.push(["createBuffer", []]);
    return v;
  }
  createTexture() {
    const v = { kind: "texture", id: this.next++ };
    this.log.push(["createTexture", []]);
    return v;
  }
  createShader(type: number) {
    const v = { kind: "shader", type, id: this.next++ };
    this.log.push(["createShader", [type]]);
    return v;
  }
  createProgram() {
    const v = { kind: "program", id: this.next++ };
    this.log.push(["createProgram", []]);
    return v;
  }
  createVertexArray() {
    const v = { kind: "vao", id: this.next++ };
    this.log.push(["createVertexArray", []]);
    return v;
  }
  createFramebuffer() {
    const v = { kind: "fbo", id: this.next++ };
    this.log.push(["createFramebuffer", []]);
    return v;
  }
  createRenderbuffer() {
    const v = { kind: "rbo", id: this.next++ };
    this.log.push(["createRenderbuffer", []]);
    return v;
  }

  // most state functions: capture args verbatim
  clear(m: number) { this.log.push(["clear", [m]]); }
  clearColor(r: number, g: number, b: number, a: number) { this.log.push(["clearColor", [r, g, b, a]]); }
  viewport(...a: number[]) { this.log.push(["viewport", a]); }
  scissor(...a: number[]) { this.log.push(["scissor", a]); }
  enable(c: number) { this.log.push(["enable", [c]]); }
  disable(c: number) { this.log.push(["disable", [c]]); }
  blendFunc(s: number, d: number) { this.log.push(["blendFunc", [s, d]]); }
  depthFunc(f: number) { this.log.push(["depthFunc", [f]]); }
  cullFace(m: number) { this.log.push(["cullFace", [m]]); }
  frontFace(m: number) { this.log.push(["frontFace", [m]]); }
  lineWidth(w: number) { this.log.push(["lineWidth", [w]]); }
  pixelStorei(p: number, v: number) { this.log.push(["pixelStorei", [p, v]]); }

  // buffers / textures
  bindBuffer(t: number, b: unknown) { this.log.push(["bindBuffer", [t, b]]); }
  bufferData(t: number, d: unknown, u: number) { this.log.push(["bufferData", [t, d, u]]); }
  bufferSubData(t: number, o: number, d: unknown) { this.log.push(["bufferSubData", [t, o, d]]); }
  deleteBuffer(b: unknown) { this.log.push(["deleteBuffer", [b]]); }
  bindTexture(t: number, x: unknown) { this.log.push(["bindTexture", [t, x]]); }
  texImage2D(...a: unknown[]) { this.log.push(["texImage2D", a]); }
  texSubImage2D(...a: unknown[]) { this.log.push(["texSubImage2D", a]); }
  texParameteri(t: number, p: number, v: number) { this.log.push(["texParameteri", [t, p, v]]); }
  activeTexture(t: number) { this.log.push(["activeTexture", [t]]); }
  generateMipmap(t: number) { this.log.push(["generateMipmap", [t]]); }
  deleteTexture(x: unknown) { this.log.push(["deleteTexture", [x]]); }

  // shaders / programs
  shaderSource(s: unknown, src: string) { this.log.push(["shaderSource", [s, src]]); }
  compileShader(s: unknown) { this.log.push(["compileShader", [s]]); }
  deleteShader(s: unknown) { this.log.push(["deleteShader", [s]]); }
  attachShader(p: unknown, s: unknown) { this.log.push(["attachShader", [p, s]]); }
  linkProgram(p: unknown) { this.log.push(["linkProgram", [p]]); }
  useProgram(p: unknown) { this.log.push(["useProgram", [p]]); }
  bindAttribLocation(p: unknown, i: number, n: string) { this.log.push(["bindAttribLocation", [p, i, n]]); }
  deleteProgram(p: unknown) { this.log.push(["deleteProgram", [p]]); }

  // uniforms
  uniform1i(l: unknown, x: number) { this.log.push(["uniform1i", [l, x]]); }
  uniform1f(l: unknown, x: number) { this.log.push(["uniform1f", [l, x]]); }
  uniform2f(l: unknown, x: number, y: number) { this.log.push(["uniform2f", [l, x, y]]); }
  uniform3f(l: unknown, x: number, y: number, z: number) { this.log.push(["uniform3f", [l, x, y, z]]); }
  uniform4f(l: unknown, x: number, y: number, z: number, w: number) { this.log.push(["uniform4f", [l, x, y, z, w]]); }
  uniformMatrix4fv(l: unknown, t: boolean, m: Float32Array) { this.log.push(["uniformMatrix4fv", [l, t, [...m]]]); }
  uniform4fv(l: unknown, v: Float32Array) { this.log.push(["uniform4fv", [l, [...v]]]); }

  // attribs / draws
  enableVertexAttribArray(i: number) { this.log.push(["enableVertexAttribArray", [i]]); }
  disableVertexAttribArray(i: number) { this.log.push(["disableVertexAttribArray", [i]]); }
  vertexAttribPointer(i: number, sz: number, t: number, n: boolean, st: number, off: number) { this.log.push(["vertexAttribPointer", [i, sz, t, n, st, off]]); }
  drawArrays(m: number, f: number, c: number) { this.log.push(["drawArrays", [m, f, c]]); }
  drawElements(m: number, c: number, t: number, off: number) { this.log.push(["drawElements", [m, c, t, off]]); }

  // VAOs / FBOs / RBOs
  bindVertexArray(v: unknown) { this.log.push(["bindVertexArray", [v]]); }
  deleteVertexArray(v: unknown) { this.log.push(["deleteVertexArray", [v]]); }
  bindFramebuffer(t: number, f: unknown) { this.log.push(["bindFramebuffer", [t, f]]); }
  framebufferTexture2D(...a: unknown[]) { this.log.push(["framebufferTexture2D", a]); }
  bindRenderbuffer(t: number, r: unknown) { this.log.push(["bindRenderbuffer", [t, r]]); }
  renderbufferStorage(...a: number[]) { this.log.push(["renderbufferStorage", a]); }
  framebufferRenderbuffer(...a: unknown[]) { this.log.push(["framebufferRenderbuffer", a]); }

  // queries
  getError() { return 0; }
  getParameter(p: number) {
    if (p === 0x1F03 /* GL_EXTENSIONS */) return "WEBGL_test";
    return 42;
  }
  getUniformLocation(_p: unknown, name: string) {
    return name === "u_unknown" ? null : { kind: "uloc", name };
  }
  getAttribLocation(_p: unknown, _name: string) { return 7; }
  getShaderParameter(_s: unknown, _p: number) { return true; }
  getShaderInfoLog(_s: unknown) { return "shader log"; }
  getProgramParameter(_p: unknown, _q: number) { return 1; }
  getProgramInfoLog(_p: unknown) { return "program log"; }
  readPixels(_x: number, _y: number, _w: number, _h: number, _f: number, _t: number, dst: Uint8Array) {
    for (let i = 0; i < dst.length; i++) dst[i] = (i & 0xff);
  }
  checkFramebufferStatus(_t: number) { return 0x8CD5 /* GL_FRAMEBUFFER_COMPLETE */; }
}

function setupBinding(gl: RecordingGl, capacity = 4096) {
  const reg = new GlContextRegistry();
  reg.bind({ pid: 1, cmdbufAddr: 0, cmdbufLen: capacity });
  const b = reg.get(1)!;
  const sab = new ArrayBuffer(capacity);
  b.cmdbufView = new Uint8Array(sab, 0, capacity);
  b.gl = gl as unknown as WebGL2RenderingContext;
  return { reg, b };
}

/** TLV writer helper. Returns the final length (header + payload). */
class Tlv {
  view: DataView;
  p = 0;
  constructor(buf: ArrayBuffer) { this.view = new DataView(buf); }
  op(op: number, payloadLen: number): { p: number } {
    this.view.setUint16(this.p, op, true);
    this.view.setUint16(this.p + 2, payloadLen, true);
    const start = this.p + 4;
    this.p = start + payloadLen;
    return { p: start };
  }
}

describe("cmdbuf decoder — TLV walker", () => {
  it("walks ClearColor + Clear + Viewport in order", () => {
    const gl = new RecordingGl();
    const { b } = setupBinding(gl);
    const t = new Tlv(b.cmdbufView!.buffer);
    let h = t.op(O.OP_CLEAR_COLOR, 16);
    t.view.setFloat32(h.p, 0.1, true); t.view.setFloat32(h.p + 4, 0.2, true);
    t.view.setFloat32(h.p + 8, 0.3, true); t.view.setFloat32(h.p + 12, 1.0, true);
    h = t.op(O.OP_CLEAR, 4);
    t.view.setUint32(h.p, 0x4000, true);
    h = t.op(O.OP_VIEWPORT, 16);
    t.view.setInt32(h.p, 0, true); t.view.setInt32(h.p + 4, 0, true);
    t.view.setInt32(h.p + 8, 640, true); t.view.setInt32(h.p + 12, 400, true);

    decodeAndDispatch(b, 0, t.p);

    expect(gl.log[0][0]).toBe("clearColor");
    expect((gl.log[0][1] as number[]).map((x) => +x.toFixed(3))).toEqual([0.1, 0.2, 0.3, 1.0]);
    expect(gl.log[1]).toEqual(["clear", [0x4000]]);
    expect(gl.log[2]).toEqual(["viewport", [0, 0, 640, 400]]);
  });

  it("GenBuffers + BindBuffer + BufferData round-trips a u32 name", () => {
    const gl = new RecordingGl();
    const { b } = setupBinding(gl);
    const t = new Tlv(b.cmdbufView!.buffer);

    // Gen with one synthesized name = 42.
    let h = t.op(O.OP_GEN_BUFFERS, 8);
    t.view.setUint32(h.p, 1, true);
    t.view.setUint32(h.p + 4, 42, true);

    // Bind GL_ARRAY_BUFFER (0x8892) to name 42.
    h = t.op(O.OP_BIND_BUFFER, 8);
    t.view.setUint32(h.p, 0x8892, true);
    t.view.setUint32(h.p + 4, 42, true);

    // BufferData payload: u32 target, u32 dataLen=12, 12 bytes data, u32 usage.
    h = t.op(O.OP_BUFFER_DATA, 8 + 12 + 4);
    t.view.setUint32(h.p, 0x8892, true);
    t.view.setUint32(h.p + 4, 12, true);
    for (let i = 0; i < 12; i++) {
      t.view.setUint8(h.p + 8 + i, (i + 1) * 17);
    }
    t.view.setUint32(h.p + 8 + 12, 0x88E4 /* GL_STATIC_DRAW */, true);

    decodeAndDispatch(b, 0, t.p);

    expect(b.buffers.has(42)).toBe(true);
    const bufObj = b.buffers.get(42);
    expect(gl.log[1]).toEqual(["bindBuffer", [0x8892, bufObj]]);
    const data = (gl.log[2][1] as unknown[])[1] as Uint8Array;
    expect(data.byteLength).toBe(12);
    expect(data[0]).toBe(17);
  });

  it("CreateShader + ShaderSource decodes UTF-8 source", () => {
    const gl = new RecordingGl();
    const { b } = setupBinding(gl);
    const t = new Tlv(b.cmdbufView!.buffer);
    const src = "void main(){gl_Position=vec4(0);}";
    const srcBytes = new TextEncoder().encode(src);

    let h = t.op(O.OP_CREATE_SHADER, 8);
    t.view.setUint32(h.p, 0x8B30 /* GL_FRAGMENT_SHADER */, true);
    t.view.setUint32(h.p + 4, 1, true); // cmdbuf-name = 1

    h = t.op(O.OP_SHADER_SOURCE, 8 + srcBytes.byteLength);
    t.view.setUint32(h.p, 1, true);
    t.view.setUint32(h.p + 4, srcBytes.byteLength, true);
    new Uint8Array(t.view.buffer).set(srcBytes, h.p + 8);

    decodeAndDispatch(b, 0, t.p);

    expect(b.shaders.has(1)).toBe(true);
    const sh = b.shaders.get(1);
    expect(gl.log.find((r) => r[0] === "shaderSource")?.[1]).toEqual([sh, src]);
  });

  it("ShaderSource decodes over a SharedArrayBuffer-backed cmdbuf", () => {
    // Regression: TextDecoder rejects views over SharedArrayBuffer
    // (the native cmdbuf when the user program runs against shared
    // memory — i.e. always, in this kernel). The bridge must copy
    // before decoding. Without the fix the dispatch throws
    // "The provided ArrayBufferView value must not be shared".
    const gl = new RecordingGl();
    const reg = new GlContextRegistry();
    reg.bind({ pid: 1, cmdbufAddr: 0, cmdbufLen: 4096 });
    const b = reg.get(1)!;
    const sab = new SharedArrayBuffer(4096);
    b.cmdbufView = new Uint8Array(sab, 0, 4096);
    b.gl = gl as unknown as WebGL2RenderingContext;

    const t = new Tlv(b.cmdbufView.buffer);
    const src = "void main(){gl_FragColor=vec4(1.0);}";
    const srcBytes = new TextEncoder().encode(src);

    let h = t.op(O.OP_CREATE_SHADER, 8);
    t.view.setUint32(h.p, 0x8B30, true);
    t.view.setUint32(h.p + 4, 1, true);

    h = t.op(O.OP_SHADER_SOURCE, 8 + srcBytes.byteLength);
    t.view.setUint32(h.p, 1, true);
    t.view.setUint32(h.p + 4, srcBytes.byteLength, true);
    new Uint8Array(t.view.buffer).set(srcBytes, h.p + 8);

    expect(() => decodeAndDispatch(b, 0, t.p)).not.toThrow();
    expect(gl.log.find((r) => r[0] === "shaderSource")?.[1][1]).toBe(src);
  });

  it("BindAttribLocation decodes over a SharedArrayBuffer-backed cmdbuf", () => {
    const gl = new RecordingGl();
    const reg = new GlContextRegistry();
    reg.bind({ pid: 1, cmdbufAddr: 0, cmdbufLen: 4096 });
    const b = reg.get(1)!;
    const sab = new SharedArrayBuffer(4096);
    b.cmdbufView = new Uint8Array(sab, 0, 4096);
    b.gl = gl as unknown as WebGL2RenderingContext;

    const t = new Tlv(b.cmdbufView.buffer);
    const name = "a_pos";
    const nameBytes = new TextEncoder().encode(name);

    let h = t.op(O.OP_CREATE_PROGRAM, 4);
    t.view.setUint32(h.p, 7, true);

    h = t.op(O.OP_BIND_ATTRIB_LOCATION, 12 + nameBytes.byteLength);
    t.view.setUint32(h.p, 7, true);
    t.view.setUint32(h.p + 4, 0, true);
    t.view.setUint32(h.p + 8, nameBytes.byteLength, true);
    new Uint8Array(t.view.buffer).set(nameBytes, h.p + 12);

    expect(() => decodeAndDispatch(b, 0, t.p)).not.toThrow();
    expect(gl.log.find((r) => r[0] === "bindAttribLocation")?.[1][2]).toBe(name);
  });

  it("UniformMatrix4fv reads the right number of floats", () => {
    const gl = new RecordingGl();
    const { b } = setupBinding(gl);
    // Fake a uniform location at index 1.
    b.uniformLocations.set(1, { kind: "uloc", name: "u" } as unknown as WebGLUniformLocation);
    const mat: number[] = [];
    for (let i = 0; i < 16; i++) mat.push(i * 0.5);

    const t = new Tlv(b.cmdbufView!.buffer);
    const h = t.op(O.OP_UNIFORM_MATRIX4FV, 12 + 16 * 4);
    t.view.setInt32(h.p, 1, true);
    t.view.setUint32(h.p + 4, 1, true); // count
    t.view.setUint32(h.p + 8, 0, true); // transpose=false
    for (let i = 0; i < 16; i++) {
      t.view.setFloat32(h.p + 12 + i * 4, mat[i], true);
    }

    decodeAndDispatch(b, 0, t.p);

    const call = gl.log.find((r) => r[0] === "uniformMatrix4fv");
    expect(call).toBeDefined();
    const recordedMat = (call![1] as unknown[])[2] as number[];
    expect(recordedMat).toEqual(mat);
  });

  it("DrawArrays(GL_TRIANGLES, 0, 3) decodes correctly", () => {
    const gl = new RecordingGl();
    const { b } = setupBinding(gl);
    const t = new Tlv(b.cmdbufView!.buffer);
    const h = t.op(O.OP_DRAW_ARRAYS, 12);
    t.view.setUint32(h.p, 0x0004 /* GL_TRIANGLES */, true);
    t.view.setInt32(h.p + 4, 0, true);
    t.view.setInt32(h.p + 8, 3, true);

    decodeAndDispatch(b, 0, t.p);

    expect(gl.log[0]).toEqual(["drawArrays", [0x0004, 0, 3]]);
  });

  it("unknown opcode returns EINVAL without throwing", () => {
    const gl = new RecordingGl();
    const { b } = setupBinding(gl);
    const t = new Tlv(b.cmdbufView!.buffer);
    const h = t.op(0xCAFE, 4);
    t.view.setUint32(h.p, 0, true);
    expect(decodeAndDispatch(b, 0, t.p)).toBe(GL_SUBMIT_EINVAL);
    expect(gl.log).toEqual([]);
  });

  it("truncated TLV header returns EINVAL", () => {
    const gl = new RecordingGl();
    const { b } = setupBinding(gl);
    expect(decodeAndDispatch(b, 0, 3)).toBe(GL_SUBMIT_EINVAL);
    expect(gl.log).toEqual([]);
  });

  it("overlong payload returns EINVAL", () => {
    const gl = new RecordingGl();
    const { b } = setupBinding(gl);
    const view = new DataView(b.cmdbufView!.buffer);
    view.setUint16(0, O.OP_CLEAR, true);
    view.setUint16(2, 4, true);
    view.setUint32(4, 0x4000, true);
    expect(decodeAndDispatch(b, 0, 7)).toBe(GL_SUBMIT_EINVAL);
    expect(gl.log).toEqual([]);
  });

  it("short array payload returns EINVAL before partial dispatch", () => {
    const gl = new RecordingGl();
    const { b } = setupBinding(gl);
    const t = new Tlv(b.cmdbufView!.buffer);
    const h = t.op(O.OP_GEN_BUFFERS, 8);
    t.view.setUint32(h.p, 2, true);
    t.view.setUint32(h.p + 4, 10, true);
    expect(decodeAndDispatch(b, 0, t.p)).toBe(GL_SUBMIT_EINVAL);
    expect(gl.log).toEqual([]);
    expect(b.buffers.size).toBe(0);
  });

  it("submit with no live context is a silent no-op", () => {
    const gl = new RecordingGl();
    const { b } = setupBinding(gl);
    b.gl = null;
    const t = new Tlv(b.cmdbufView!.buffer);
    t.op(O.OP_CLEAR, 4);
    expect(() => decodeAndDispatch(b, 0, t.p)).not.toThrow();
    expect(gl.log).toEqual([]);
  });
});

describe("query handler", () => {
  function out(n: number) {
    return new Uint8Array(new ArrayBuffer(n));
  }
  function input(bytes: number[]) {
    return new Uint8Array(bytes);
  }
  function setup() {
    const gl = new RecordingGl();
    const { b } = setupBinding(gl);
    return { gl, b };
  }

  it("QOP_GET_ERROR writes 4 bytes", () => {
    const { b } = setup();
    const o = out(4);
    expect(runGlQuery(b, O.QOP_GET_ERROR, input([]), o)).toBe(4);
    expect(o[0]).toBe(0); // RecordingGl.getError() returns 0
  });

  it("QOP_GET_INTEGERV reads a u32 pname and writes an i32", () => {
    const { b } = setup();
    const o = out(4);
    const pname = new Uint8Array(4);
    new DataView(pname.buffer).setUint32(0, 0x0D33 /* MAX_TEXTURE_SIZE */, true);
    expect(runGlQuery(b, O.QOP_GET_INTEGERV, pname, o)).toBe(4);
    expect(new DataView(o.buffer).getInt32(0, true)).toBe(42);
  });

  it("QOP_GET_UNIFORM_LOC allocates monotonic indices", () => {
    const { b } = setup();
    // Plant a "program" object so the lookup succeeds.
    const prog = { kind: "program", id: 1 } as unknown as WebGLProgram;
    b.programs.set(7, prog);

    const name = new TextEncoder().encode("u_color");
    const inp = new Uint8Array(8 + name.byteLength);
    new DataView(inp.buffer).setUint32(0, 7, true);
    new DataView(inp.buffer).setUint32(4, name.byteLength, true);
    inp.set(name, 8);

    const o1 = out(4);
    expect(runGlQuery(b, O.QOP_GET_UNIFORM_LOC, inp, o1)).toBe(4);
    const idx1 = new DataView(o1.buffer).getInt32(0, true);
    expect(idx1).toBe(1);
    expect(b.uniformLocations.has(1)).toBe(true);

    const o2 = out(4);
    expect(runGlQuery(b, O.QOP_GET_UNIFORM_LOC, inp, o2)).toBe(4);
    const idx2 = new DataView(o2.buffer).getInt32(0, true);
    expect(idx2).toBe(2);

    // Delete idx1; next lookup should be idx 3, not reused 1.
    b.uniformLocations.delete(1);
    const o3 = out(4);
    expect(runGlQuery(b, O.QOP_GET_UNIFORM_LOC, inp, o3)).toBe(4);
    expect(new DataView(o3.buffer).getInt32(0, true)).toBe(3);
  });

  it("QOP_GET_UNIFORM_LOC returns -1 for a missing uniform", () => {
    const { b } = setup();
    const prog = { kind: "program" } as unknown as WebGLProgram;
    b.programs.set(1, prog);
    const name = new TextEncoder().encode("u_unknown");
    const inp = new Uint8Array(8 + name.byteLength);
    new DataView(inp.buffer).setUint32(0, 1, true);
    new DataView(inp.buffer).setUint32(4, name.byteLength, true);
    inp.set(name, 8);
    const o = out(4);
    runGlQuery(b, O.QOP_GET_UNIFORM_LOC, inp, o);
    expect(new DataView(o.buffer).getInt32(0, true)).toBe(-1);
  });

  it("QOP_GET_SHADER_INFO_LOG writes string-len header + bytes", () => {
    const { b } = setup();
    b.shaders.set(1, {} as unknown as WebGLShader);
    const inp = new Uint8Array(4);
    new DataView(inp.buffer).setUint32(0, 1, true);
    const o = out(64);
    const n = runGlQuery(b, O.QOP_GET_SHADER_INFO_LOG, inp, o);
    const len = new DataView(o.buffer).getUint32(0, true);
    expect(len).toBe("shader log".length);
    expect(n).toBe(4 + len);
    expect(new TextDecoder().decode(o.subarray(4, 4 + len))).toBe("shader log");
  });

  it("returns -EPERM when the binding has no live context", () => {
    const { b } = setup();
    b.gl = null;
    expect(runGlQuery(b, O.QOP_GET_ERROR, input([]), out(4))).toBe(-1);
  });

  it("returns -EINVAL for an unknown query op", () => {
    const { b } = setup();
    expect(runGlQuery(b, 0xfe, input([]), out(4))).toBe(-22);
  });

  it("QOP_GET_UNIFORM_LOC retains the (program, uniform) behind each index", () => {
    const { b } = setup();
    b.programs.set(7, { kind: "program", id: 1 } as unknown as WebGLProgram);

    const name = new TextEncoder().encode("u_color");
    const inp = new Uint8Array(8 + name.byteLength);
    new DataView(inp.buffer).setUint32(0, 7, true);
    new DataView(inp.buffer).setUint32(4, name.byteLength, true);
    inp.set(name, 8);
    runGlQuery(b, O.QOP_GET_UNIFORM_LOC, inp, out(4));

    expect(b.uniformLocationNames.get(1)).toEqual({
      program: 7,
      uniform: "u_color",
    });
  });

  it("QOP_GET_UNIFORM_LOC retains nothing for a missing uniform", () => {
    const { b } = setup();
    b.programs.set(1, { kind: "program" } as unknown as WebGLProgram);
    const name = new TextEncoder().encode("u_unknown");
    const inp = new Uint8Array(8 + name.byteLength);
    new DataView(inp.buffer).setUint32(0, 1, true);
    new DataView(inp.buffer).setUint32(4, name.byteLength, true);
    inp.set(name, 8);
    runGlQuery(b, O.QOP_GET_UNIFORM_LOC, inp, out(4));
    expect(b.uniformLocationNames.size).toBe(0);
  });
});

describe("cmdbuf decoder — texture shape retention", () => {
  const GL_TEXTURE_2D = 0x0DE1;
  const GL_RGBA = 0x1908;
  const GL_UNSIGNED_BYTE = 0x1401;

  function genAndBind(t: Tlv, name: number) {
    let h = t.op(O.OP_GEN_TEXTURES, 8);
    t.view.setUint32(h.p, 1, true);
    t.view.setUint32(h.p + 4, name, true);
    h = t.op(O.OP_BIND_TEXTURE, 8);
    t.view.setUint32(h.p, GL_TEXTURE_2D, true);
    t.view.setUint32(h.p + 4, name, true);
  }

  function texImage(t: Tlv, level: number, w: number, h_: number) {
    const h = t.op(O.OP_TEX_IMAGE_2D, 36);
    t.view.setUint32(h.p, GL_TEXTURE_2D, true);
    t.view.setInt32(h.p + 4, level, true);
    t.view.setInt32(h.p + 8, GL_RGBA, true);
    t.view.setInt32(h.p + 12, w, true);
    t.view.setInt32(h.p + 16, h_, true);
    t.view.setInt32(h.p + 20, 0, true);
    t.view.setUint32(h.p + 24, GL_RGBA, true);
    t.view.setUint32(h.p + 28, GL_UNSIGNED_BYTE, true);
    t.view.setUint32(h.p + 32, 0, true);
  }

  it("TexImage2D records the level's shape under the bound name", () => {
    const gl = new RecordingGl();
    const { b } = setupBinding(gl);
    const t = new Tlv(b.cmdbufView!.buffer);
    genAndBind(t, 5);
    texImage(t, 0, 64, 48);

    decodeAndDispatch(b, 0, t.p);

    expect(b.textureUnitNames.get(0)).toBe(5);
    expect(b.textureShapes.get(5)!.levels.get(0)).toEqual({
      internalFormat: GL_RGBA,
      width: 64,
      height: 48,
      format: GL_RGBA,
      type: GL_UNSIGNED_BYTE,
    });
    expect(b.textureShapes.get(5)!.mipmapped).toBe(false);
  });

  it("a re-upload replaces the level's shape", () => {
    const gl = new RecordingGl();
    const { b } = setupBinding(gl);
    const t = new Tlv(b.cmdbufView!.buffer);
    genAndBind(t, 5);
    texImage(t, 0, 64, 48);
    texImage(t, 0, 128, 96);

    decodeAndDispatch(b, 0, t.p);

    expect(b.textureShapes.get(5)!.levels.get(0)!.width).toBe(128);
    expect(b.textureShapes.get(5)!.levels.size).toBe(1);
  });

  it("GenerateMipmap marks the bound texture", () => {
    const gl = new RecordingGl();
    const { b } = setupBinding(gl);
    const t = new Tlv(b.cmdbufView!.buffer);
    genAndBind(t, 5);
    texImage(t, 0, 64, 48);
    const h = t.op(O.OP_GENERATE_MIPMAP, 4);
    t.view.setUint32(h.p, GL_TEXTURE_2D, true);

    decodeAndDispatch(b, 0, t.p);

    expect(b.textureShapes.get(5)!.mipmapped).toBe(true);
  });

  it("DeleteTextures forgets the shape and the unit it was bound on", () => {
    const gl = new RecordingGl();
    const { b } = setupBinding(gl);
    const t = new Tlv(b.cmdbufView!.buffer);
    genAndBind(t, 5);
    texImage(t, 0, 64, 48);
    const h = t.op(O.OP_DELETE_TEXTURES, 8);
    t.view.setUint32(h.p, 1, true);
    t.view.setUint32(h.p + 4, 5, true);

    decodeAndDispatch(b, 0, t.p);

    expect(b.textureShapes.has(5)).toBe(false);
    expect(b.textureUnitNames.has(0)).toBe(false);
  });

  it("tracks names per texture unit", () => {
    const gl = new RecordingGl();
    const { b } = setupBinding(gl);
    const t = new Tlv(b.cmdbufView!.buffer);
    genAndBind(t, 5);
    let h = t.op(O.OP_ACTIVE_TEXTURE, 4);
    t.view.setUint32(h.p, 0x84C1 /* GL_TEXTURE1 */, true);
    genAndBind(t, 6);
    texImage(t, 0, 32, 32);

    decodeAndDispatch(b, 0, t.p);

    expect(b.textureUnitNames.get(0)).toBe(5);
    expect(b.textureUnitNames.get(1)).toBe(6);
    expect(b.textureShapes.has(5)).toBe(false);
    expect(b.textureShapes.get(6)!.levels.get(0)!.width).toBe(32);
  });

  it("binding name 0 clears the unit's name", () => {
    const gl = new RecordingGl();
    const { b } = setupBinding(gl);
    const t = new Tlv(b.cmdbufView!.buffer);
    genAndBind(t, 5);
    const h = t.op(O.OP_BIND_TEXTURE, 8);
    t.view.setUint32(h.p, GL_TEXTURE_2D, true);
    t.view.setUint32(h.p + 4, 0, true);

    decodeAndDispatch(b, 0, t.p);

    expect(b.textureUnitNames.has(0)).toBe(false);
  });
});
