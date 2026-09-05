import { describe, expect, it } from "vitest";
import { GlContextRegistry, type GlBinding } from "../src/webgl/registry.js";
import {
  captureGlContext,
  GL_COLOR_ATTACHMENT0,
  GL_DEPTH_ATTACHMENT,
  GL_DEPTH_COMPONENT,
  GL_FLOAT,
  GL_RG,
  GL_RGBA,
  GL_TEXTURE_MAG_FILTER,
  GL_TEXTURE_MIN_FILTER,
  GL_TEXTURE_WRAP_S,
  GL_TEXTURE_WRAP_T,
  GL_UNSIGNED_BYTE,
} from "../src/webgl/snapshot.js";
import {
  fakeBuffer,
  fakeProgram,
  fakeTexture,
  StatefulGl,
  type FakeFbo,
  type FakeProgram,
  type FakeRbo,
  type FakeShader,
  type FakeVao,
} from "./support/stateful-gl.js";

const GL_VERTEX_SHADER = 0x8b31;
const GL_FRAGMENT_SHADER = 0x8b30;
const GL_STATIC_DRAW = 0x88e4;
const GL_LINEAR = 0x2601;
const GL_NEAREST = 0x2600;
const GL_CLAMP_TO_EDGE = 0x812f;
const GL_REPEAT = 0x2901;
const GL_FLOAT_VEC2 = 0x8b50;
const GL_FLOAT_MAT4 = 0x8b5c;
const GL_SAMPLER_2D = 0x8b5e;
const GL_DEPTH_COMPONENT16 = 0x81a5;

function makeBinding(gl: StatefulGl | null): GlBinding {
  const reg = new GlContextRegistry();
  reg.bind({ pid: 9, cmdbufAddr: 4096, cmdbufLen: 1024 });
  const b = reg.get(9)!;
  b.gl = gl as unknown as WebGL2RenderingContext | null;
  b.contextId = 3;
  b.surfaceId = 4;
  return b;
}

function filteredTexture() {
  return fakeTexture([
    [GL_TEXTURE_MIN_FILTER, GL_LINEAR],
    [GL_TEXTURE_MAG_FILTER, GL_NEAREST],
    [GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE],
    [GL_TEXTURE_WRAP_T, GL_REPEAT],
  ]);
}

describe("captureGlContext", () => {
  it("carries the binding without a context as structure alone", () => {
    const b = makeBinding(null);
    b.uniformLocationNames.set(2, { program: 7, uniform: "u_color" });
    b.nextUniformLoc = 2;

    const captured = captureGlContext(b, 1);

    expect(captured.pid).toBe(9);
    expect(captured.cmdbufAddr).toBe(4096);
    expect(captured.cmdbufLen).toBe(1024);
    expect(captured.contextId).toBe(3);
    expect(captured.surfaceId).toBe(4);
    expect(captured.crtcId).toBe(1);
    expect(captured.state).toBeNull();
    expect(captured.uniformLocationNames).toEqual([
      { index: 2, program: 7, uniform: "u_color" },
    ]);
    expect(captured.nextUniformLoc).toBe(2);
  });

  it("reads buffer contents and usage back", () => {
    const gl = new StatefulGl();
    const b = makeBinding(gl);
    b.buffers.set(42, fakeBuffer([1, 2, 3, 4]) as unknown as WebGLBuffer);

    const captured = captureGlContext(b, null);

    expect(captured.buffers).toEqual([
      { name: 42, usage: GL_STATIC_DRAW, bytes: new Uint8Array([1, 2, 3, 4]) },
    ]);
  });

  it("reads a byte texture level back through the scratch framebuffer", () => {
    const gl = new StatefulGl();
    const b = makeBinding(gl);
    const texture = filteredTexture();
    texture.levelRgba.set(0, new Uint8Array([10, 20, 30, 40, 50, 60, 70, 80]));
    b.textures.set(5, texture as unknown as WebGLTexture);
    b.textureShapes.set(5, {
      mipmapped: false,
      levels: new Map([[0, {
        internalFormat: GL_RGBA,
        width: 2,
        height: 1,
        format: GL_RGBA,
        type: GL_UNSIGNED_BYTE,
      }]]),
    });

    const captured = captureGlContext(b, null);

    expect(captured.textures).toHaveLength(1);
    const level = captured.textures[0]!.levels[0]!;
    expect(level.pixels).toEqual(new Uint8Array([10, 20, 30, 40, 50, 60, 70, 80]));
    expect(level.pixelsType).toBe(GL_UNSIGNED_BYTE);
    expect(captured.textures[0]!.minFilter).toBe(GL_LINEAR);
    expect(captured.textures[0]!.magFilter).toBe(GL_NEAREST);
    expect(captured.textures[0]!.wrapS).toBe(GL_CLAMP_TO_EDGE);
    expect(captured.textures[0]!.wrapT).toBe(GL_REPEAT);
    expect(captured.boundaries).toEqual([]);
  });

  it("extracts the carried channels from a float RG texture", () => {
    const gl = new StatefulGl();
    const b = makeBinding(gl);
    const texture = filteredTexture();
    texture.levelRgba.set(0, new Float32Array([
      0.5, 0.25, 0, 1,
      -1.5, 2.5, 0, 1,
    ]));
    b.textures.set(6, texture as unknown as WebGLTexture);
    b.textureShapes.set(6, {
      mipmapped: true,
      levels: new Map([[0, {
        internalFormat: 0x8230, // RG16F
        width: 2,
        height: 1,
        format: GL_RG,
        type: GL_FLOAT,
      }]]),
    });

    const captured = captureGlContext(b, null);

    const level = captured.textures[0]!.levels[0]!;
    expect(level.pixelsType).toBe(GL_FLOAT);
    expect(new Float32Array(
      level.pixels!.buffer,
      level.pixels!.byteOffset,
      4,
    )).toEqual(new Float32Array([0.5, 0.25, -1.5, 2.5]));
    expect(captured.textures[0]!.mipmapped).toBe(true);
  });

  it("carries a depth texture level as a named boundary, not pixels", () => {
    const gl = new StatefulGl();
    const b = makeBinding(gl);
    b.textures.set(7, filteredTexture() as unknown as WebGLTexture);
    b.textureShapes.set(7, {
      mipmapped: false,
      levels: new Map([[0, {
        internalFormat: GL_DEPTH_COMPONENT16,
        width: 4,
        height: 4,
        format: GL_DEPTH_COMPONENT,
        type: GL_UNSIGNED_BYTE,
      }]]),
    });

    const captured = captureGlContext(b, null);

    expect(captured.textures[0]!.levels[0]!.pixels).toBeNull();
    expect(captured.boundaries.some((line) => line.includes("depth"))).toBe(true);
  });

  it("carries a never-uploaded texture as empty without a boundary", () => {
    const gl = new StatefulGl();
    const b = makeBinding(gl);
    b.textures.set(8, filteredTexture() as unknown as WebGLTexture);

    const captured = captureGlContext(b, null);

    expect(captured.textures[0]!.levels).toEqual([]);
    expect(captured.boundaries).toEqual([]);
  });

  it("reads shaders and programs back, pinning attribute locations", () => {
    const gl = new StatefulGl();
    const b = makeBinding(gl);
    const vertex: FakeShader = {
      kind: "shader",
      type: GL_VERTEX_SHADER,
      source: "void main(){}",
      compiled: true,
    };
    const fragment: FakeShader = {
      kind: "shader",
      type: GL_FRAGMENT_SHADER,
      source: "void main(){gl_FragColor=vec4(1.);}",
      compiled: true,
    };
    b.shaders.set(1, vertex as unknown as WebGLShader);
    const program = fakeProgram();
    program.attached = [vertex, fragment];
    program.linked = true;
    program.attribs = [{ name: "aPosition", location: 3 }];
    program.uniforms = [
      { name: "uTexelSize", type: GL_FLOAT_VEC2, size: 1, values: [new Float32Array([0.5, 0.25])] },
      { name: "uSampler", type: GL_SAMPLER_2D, size: 1, values: [2] },
      { name: "uWeights", type: GL_FLOAT_MAT4, size: 2, values: [
        new Float32Array(16).fill(1),
        new Float32Array(16).fill(2),
      ] },
    ];
    b.programs.set(20, program as unknown as WebGLProgram);

    const captured = captureGlContext(b, null);

    expect(captured.shaders).toEqual([
      {
        name: 1,
        type: GL_VERTEX_SHADER,
        source: "void main(){}",
        compiled: true,
      },
    ]);
    const carried = captured.programs[0]!;
    expect(carried.name).toBe(20);
    expect(carried.linked).toBe(true);
    expect(carried.shaders).toEqual([
      { shaderName: 1, type: GL_VERTEX_SHADER, source: "void main(){}" },
      {
        shaderName: null,
        type: GL_FRAGMENT_SHADER,
        source: "void main(){gl_FragColor=vec4(1.);}",
      },
    ]);
    expect(carried.attribBindings).toEqual([{ name: "aPosition", location: 3 }]);
    expect(carried.uniforms).toEqual([
      { name: "uTexelSize", glType: GL_FLOAT_VEC2, values: [0.5, 0.25] },
      { name: "uSampler", glType: GL_SAMPLER_2D, values: [2] },
      { name: "uWeights[0]", glType: GL_FLOAT_MAT4, values: new Array(16).fill(1) },
      { name: "uWeights[1]", glType: GL_FLOAT_MAT4, values: new Array(16).fill(2) },
    ]);
  });

  it("reads vertex-array wiring back by buffer name", () => {
    const gl = new StatefulGl();
    const b = makeBinding(gl);
    const position = fakeBuffer([0, 0, 0, 0]);
    const indices = fakeBuffer([1, 1]);
    b.buffers.set(30, position as unknown as WebGLBuffer);
    b.buffers.set(31, indices as unknown as WebGLBuffer);
    const vao: FakeVao = {
      kind: "vao",
      element: indices,
      attribs: new Map([[2, {
        enabled: true,
        buffer: position,
        size: 2,
        type: GL_FLOAT,
        normalized: false,
        stride: 8,
        offset: 16,
      }]]),
    };
    b.vaos.set(40, vao as unknown as WebGLVertexArrayObject);
    gl.defaultVao.attribs.set(0, {
      enabled: true,
      buffer: position,
      size: 4,
      type: GL_FLOAT,
      normalized: true,
      stride: 0,
      offset: 0,
    });

    const captured = captureGlContext(b, null);

    expect(captured.vaos).toEqual([
      {
        name: 0,
        elementArrayBufferName: null,
        attribs: [{
          index: 0,
          enabled: true,
          bufferName: 30,
          size: 4,
          type: GL_FLOAT,
          normalized: true,
          stride: 0,
          offset: 0,
        }],
      },
      {
        name: 40,
        elementArrayBufferName: 31,
        attribs: [{
          index: 2,
          enabled: true,
          bufferName: 30,
          size: 2,
          type: GL_FLOAT,
          normalized: false,
          stride: 8,
          offset: 16,
        }],
      },
    ]);
  });

  it("reads framebuffer attachments and renderbuffer storage back", () => {
    const gl = new StatefulGl();
    const b = makeBinding(gl);
    const texture = filteredTexture();
    b.textures.set(5, texture as unknown as WebGLTexture);
    const rbo: FakeRbo = {
      kind: "rbo",
      internalFormat: GL_DEPTH_COMPONENT16,
      width: 64,
      height: 48,
    };
    b.rbos.set(50, rbo as unknown as WebGLRenderbuffer);
    const fbo: FakeFbo = {
      kind: "fbo",
      attachments: new Map([
        [GL_COLOR_ATTACHMENT0, { object: texture, level: 1 }],
        [GL_DEPTH_ATTACHMENT, { object: rbo, level: 0 }],
      ]),
    };
    b.fbos.set(60, fbo as unknown as WebGLFramebuffer);

    const captured = captureGlContext(b, null);

    expect(captured.fbos).toEqual([{
      name: 60,
      attachments: [
        { attachment: GL_COLOR_ATTACHMENT0, kind: "texture", objectName: 5, level: 1 },
        { attachment: GL_DEPTH_ATTACHMENT, kind: "renderbuffer", objectName: 50, level: 0 },
      ],
    }]);
    expect(captured.rbos).toEqual([{
      name: 50,
      internalFormat: GL_DEPTH_COMPONENT16,
      width: 64,
      height: 48,
    }]);
    expect(captured.boundaries.some(
      (line) => line.includes("renderbuffer contents"),
    )).toBe(true);
  });

  it("names the pipeline state through the shadow", () => {
    const gl = new StatefulGl();
    const b = makeBinding(gl);
    const program: FakeProgram = fakeProgram();
    b.programs.set(20, program as unknown as WebGLProgram);
    const vao: FakeVao = { kind: "vao", element: null, attribs: new Map() };
    b.vaos.set(40, vao as unknown as WebGLVertexArrayObject);
    const fbo: FakeFbo = { kind: "fbo", attachments: new Map() };
    b.fbos.set(60, fbo as unknown as WebGLFramebuffer);
    const texture = filteredTexture();
    b.textures.set(5, texture as unknown as WebGLTexture);
    const buffer = fakeBuffer([9]);
    b.buffers.set(30, buffer as unknown as WebGLBuffer);
    gl.arrayBuffer = buffer;
    gl.currentLineWidth = 2;
    b.shadow.currentProgram = program as unknown as WebGLProgram;
    b.shadow.vao = vao as unknown as WebGLVertexArrayObject;
    b.shadow.fbo = fbo as unknown as WebGLFramebuffer;
    b.shadow.viewport = [0, 0, 320, 200];
    b.shadow.blendEnabled = true;
    b.shadow.activeTexture = 3;
    b.textureUnitNames.set(3, 5);

    const captured = captureGlContext(b, null);

    const state = captured.state!;
    expect(state.currentProgramName).toBe(20);
    expect(state.vaoName).toBe(40);
    expect(state.fboName).toBe(60);
    expect(state.readFboName).toBe(0);
    expect(state.viewport).toEqual([0, 0, 320, 200]);
    expect(state.blendEnabled).toBe(true);
    expect(state.activeTexture).toBe(3);
    expect(state.textureUnits).toEqual([{ unit: 3, name: 5 }]);
    expect(state.arrayBufferName).toBe(30);
    expect(state.lineWidth).toBe(2);
  });

  it("leaves the context's bindings as it found them", () => {
    const gl = new StatefulGl();
    const b = makeBinding(gl);
    const buffer = fakeBuffer([1]);
    b.buffers.set(30, buffer as unknown as WebGLBuffer);
    const texture = filteredTexture();
    texture.levelRgba.set(0, new Uint8Array([1, 2, 3, 4]));
    b.textures.set(5, texture as unknown as WebGLTexture);
    b.textureShapes.set(5, {
      mipmapped: false,
      levels: new Map([[0, {
        internalFormat: GL_RGBA,
        width: 1,
        height: 1,
        format: GL_RGBA,
        type: GL_UNSIGNED_BYTE,
      }]]),
    });
    const vao: FakeVao = { kind: "vao", element: null, attribs: new Map() };
    b.vaos.set(40, vao as unknown as WebGLVertexArrayObject);

    const priorCopyRead = fakeBuffer([7]);
    gl.copyReadBuffer = priorCopyRead;
    const priorTexture = filteredTexture();
    gl.unitTextures.set(0, priorTexture);
    b.shadow.textureUnits[0] = priorTexture as unknown as WebGLTexture;
    b.shadow.vao = vao as unknown as WebGLVertexArrayObject;
    gl.boundVao = vao;
    gl.packAlignment = 2;
    b.shadow.packAlignment = 2;

    captureGlContext(b, null);

    expect(gl.copyReadBuffer).toBe(priorCopyRead);
    expect(gl.readFbo).toBeNull();
    expect(gl.unitTextures.get(0)).toBe(priorTexture);
    expect(gl.boundVao).toBe(vao);
    expect(gl.packAlignment).toBe(2);
  });
});
