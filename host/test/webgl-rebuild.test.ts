import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GlContextRegistry, type GlBinding } from "../src/webgl/registry.js";
import { rebuildGlContext } from "../src/webgl/rebuild.js";
import {
  captureGlContext,
  GL_COLOR_ATTACHMENT0,
  GL_DEPTH_ATTACHMENT,
  GL_FLOAT,
  GL_RG,
  GL_RGBA,
  GL_TEXTURE_MAG_FILTER,
  GL_TEXTURE_MIN_FILTER,
  GL_TEXTURE_WRAP_S,
  GL_TEXTURE_WRAP_T,
  GL_UNSIGNED_BYTE,
  type CheckpointGlContext,
} from "../src/webgl/snapshot.js";
import { createCentralizedKernelWorkerTestDouble } from "../src/kernel-worker";
import { NodePlatformIO } from "../src/platform/node";
import { installKernelWorkerTestScratch } from "./kernel-worker-test-scratch";
import {
  fakeBuffer,
  fakeProgram,
  fakeTexture,
  StatefulGl,
  type FakeFbo,
  type FakeRbo,
  type FakeShader,
  type FakeUniform,
  type FakeVao,
} from "./support/stateful-gl.js";

const GL_VERTEX_SHADER = 0x8b31;
const GL_FRAGMENT_SHADER = 0x8b30;
const GL_LINEAR = 0x2601;
const GL_NEAREST = 0x2600;
const GL_CLAMP_TO_EDGE = 0x812f;
const GL_REPEAT = 0x2901;
const GL_FLOAT_VEC2 = 0x8b50;
const GL_FLOAT_MAT4 = 0x8b5c;
const GL_SAMPLER_2D = 0x8b5e;
const GL_DEPTH_COMPONENT16 = 0x81a5;

const VERTEX_SOURCE = "void main(){gl_Position=vec4(0.);}";
const FRAGMENT_SOURCE = "void main(){gl_FragColor=vec4(1.);}";

function makeBinding(gl: StatefulGl): GlBinding {
  const reg = new GlContextRegistry();
  reg.bind({ pid: 9, cmdbufAddr: 4096, cmdbufLen: 1024 });
  const b = reg.get(9)!;
  b.gl = gl as unknown as WebGL2RenderingContext;
  b.contextId = 3;
  b.surfaceId = 4;
  return b;
}

function uniformDeclarations(): FakeUniform[] {
  return [
    {
      name: "uTexelSize",
      type: GL_FLOAT_VEC2,
      size: 1,
      values: [new Float32Array([0, 0])],
    },
    { name: "uSampler", type: GL_SAMPLER_2D, size: 1, values: [0] },
    {
      name: "uWeights",
      type: GL_FLOAT_MAT4,
      size: 2,
      values: [new Float32Array(16), new Float32Array(16)],
    },
  ];
}

/** A populated machine: what a fluid-sim-shaped guest leaves behind. */
function populatedContext(): { gl: StatefulGl; b: GlBinding } {
  const gl = new StatefulGl();
  const b = makeBinding(gl);

  const position = fakeBuffer([1, 2, 3, 4, 5, 6, 7, 8]);
  const indices = fakeBuffer([0, 1], 0x88e8);
  b.buffers.set(30, position as unknown as WebGLBuffer);
  b.buffers.set(31, indices as unknown as WebGLBuffer);

  const dye = fakeTexture([
    [GL_TEXTURE_MIN_FILTER, GL_LINEAR],
    [GL_TEXTURE_MAG_FILTER, GL_LINEAR],
    [GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE],
    [GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE],
  ]);
  dye.levelRgba.set(0, new Uint8Array([10, 20, 30, 40, 50, 60, 70, 80]));
  b.textures.set(5, dye as unknown as WebGLTexture);
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
  const velocity = fakeTexture([
    [GL_TEXTURE_MIN_FILTER, GL_NEAREST],
    [GL_TEXTURE_MAG_FILTER, GL_NEAREST],
    [GL_TEXTURE_WRAP_S, GL_REPEAT],
    [GL_TEXTURE_WRAP_T, GL_REPEAT],
  ]);
  velocity.levelRgba.set(0, new Float32Array([0.5, -0.25, 0, 0, 1.5, 2.5, 0, 0]));
  b.textures.set(6, velocity as unknown as WebGLTexture);
  b.textureShapes.set(6, {
    mipmapped: false,
    levels: new Map([[0, {
      internalFormat: 0x8230, // RG16F
      width: 2,
      height: 1,
      format: GL_RG,
      type: GL_FLOAT,
    }]]),
  });

  const vertex: FakeShader = {
    kind: "shader",
    type: GL_VERTEX_SHADER,
    source: VERTEX_SOURCE,
    compiled: true,
  };
  const fragment: FakeShader = {
    kind: "shader",
    type: GL_FRAGMENT_SHADER,
    source: FRAGMENT_SOURCE,
    compiled: true,
  };
  b.shaders.set(1, vertex as unknown as WebGLShader);

  const program = fakeProgram();
  program.attached = [vertex, fragment];
  program.linked = true;
  program.attribs = [{ name: "aPosition", location: 3 }];
  program.uniforms = uniformDeclarations();
  program.uniforms[0]!.values = [new Float32Array([0.5, 0.25])];
  program.uniforms[1]!.values = [2];
  program.uniforms[2]!.values = [
    new Float32Array(16).fill(1),
    new Float32Array(16).fill(2),
  ];
  b.programs.set(20, program as unknown as WebGLProgram);

  const vao: FakeVao = {
    kind: "vao",
    element: indices,
    attribs: new Map([[3, {
      enabled: true,
      buffer: position,
      size: 2,
      type: GL_FLOAT,
      normalized: false,
      stride: 8,
      offset: 0,
    }]]),
  };
  b.vaos.set(40, vao as unknown as WebGLVertexArrayObject);

  const rbo: FakeRbo = {
    kind: "rbo",
    internalFormat: GL_DEPTH_COMPONENT16,
    width: 2,
    height: 1,
  };
  b.rbos.set(50, rbo as unknown as WebGLRenderbuffer);

  const fbo: FakeFbo = {
    kind: "fbo",
    attachments: new Map([
      [GL_COLOR_ATTACHMENT0, { object: dye, level: 0 }],
      [GL_DEPTH_ATTACHMENT, { object: rbo, level: 0 }],
    ]),
  };
  b.fbos.set(60, fbo as unknown as WebGLFramebuffer);

  b.uniformLocationNames.set(1, { program: 20, uniform: "uTexelSize" });
  b.nextUniformLoc = 1;

  b.shadow.currentProgram = program as unknown as WebGLProgram;
  b.shadow.vao = vao as unknown as WebGLVertexArrayObject;
  b.shadow.fbo = fbo as unknown as WebGLFramebuffer;
  b.shadow.viewport = [0, 0, 320, 200];
  b.shadow.blendEnabled = true;
  b.shadow.activeTexture = 3;
  b.shadow.textureUnits[3] = dye as unknown as WebGLTexture;
  b.textureUnitNames.set(3, 5);
  gl.arrayBuffer = position;
  gl.currentLineWidth = 2;

  return { gl, b };
}

describe("rebuildGlContext", () => {
  it("round-trips: a capture of the rebuilt context equals the original", () => {
    const original = populatedContext();
    const captured = captureGlContext(original.b, 7);

    const gl2 = new StatefulGl();
    gl2.uniformDeclarationsBySource.set(VERTEX_SOURCE, uniformDeclarations());
    const b2 = makeBinding(gl2);
    const boundaries = rebuildGlContext(
      gl2 as unknown as WebGL2RenderingContext,
      b2,
      captured,
    );

    expect(boundaries).toEqual([]);
    const recaptured = captureGlContext(b2, 7);
    expect(recaptured).toEqual(captured);
  });

  it("rebuilds the binding's maps and retention", () => {
    const original = populatedContext();
    const captured = captureGlContext(original.b, 7);

    const gl2 = new StatefulGl();
    gl2.uniformDeclarationsBySource.set(VERTEX_SOURCE, uniformDeclarations());
    const b2 = makeBinding(gl2);
    rebuildGlContext(gl2 as unknown as WebGL2RenderingContext, b2, captured);

    expect([...b2.buffers.keys()]).toEqual([30, 31]);
    expect([...b2.textures.keys()]).toEqual([5, 6]);
    expect([...b2.shaders.keys()]).toEqual([1]);
    expect([...b2.programs.keys()]).toEqual([20]);
    expect([...b2.vaos.keys()]).toEqual([40]);
    expect([...b2.fbos.keys()]).toEqual([60]);
    expect([...b2.rbos.keys()]).toEqual([50]);
    expect(b2.nextUniformLoc).toBe(1);
    expect(b2.uniformLocationNames.get(1)).toEqual({
      program: 20,
      uniform: "uTexelSize",
    });
    expect(b2.uniformLocations.get(1)).not.toBeUndefined();
    expect(b2.textureShapes.get(6)!.levels.get(0)!.format).toBe(GL_RG);
    expect(b2.textureUnitNames.get(3)).toBe(5);
    expect(b2.currentProgram).toBe(b2.programs.get(20)!);
    expect(b2.shadow.viewport).toEqual([0, 0, 320, 200]);
    expect(b2.shadow.blendEnabled).toBe(true);
  });

  it("names a uniform a fresh link no longer answers", () => {
    const original = populatedContext();
    const captured = captureGlContext(original.b, 7);
    const rewritten: CheckpointGlContext = {
      ...captured,
      uniformLocationNames: [
        { index: 1, program: 20, uniform: "uOptimizedOut" },
      ],
    };

    const gl2 = new StatefulGl();
    gl2.uniformDeclarationsBySource.set(VERTEX_SOURCE, uniformDeclarations());
    const b2 = makeBinding(gl2);
    const boundaries = rebuildGlContext(
      gl2 as unknown as WebGL2RenderingContext,
      b2,
      rewritten,
    );

    expect(boundaries.some((line) => line.includes("uOptimizedOut"))).toBe(true);
    expect(b2.uniformLocations.has(1)).toBe(false);
    expect(b2.uniformLocationNames.get(1)).toEqual({
      program: 20,
      uniform: "uOptimizedOut",
    });
  });
});

describe("CentralizedKernelWorker GL restore", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  function makeWorker() {
    const worker = createCentralizedKernelWorkerTestDouble({
      config: { maxWorkers: 1, dataBufferSize: 65_536, useSharedMemory: true },
      io: new NodePlatformIO(),
    });
    const implementations = { kernel_vblank: () => 0 };
    installKernelWorkerTestScratch(
      worker,
      new WebAssembly.Memory({ initial: 2 }),
      128,
      4,
      {
        kernelExports: implementations,
        kernelExportNames: Object.keys(implementations),
      },
    );
    return worker;
  }

  function capturedContext(crtcId: number | null): CheckpointGlContext {
    const { b } = populatedContext();
    return { ...captureGlContext(b, crtcId), pid: 7 };
  }

  function makeGlCanvas(gl: StatefulGl | null): OffscreenCanvas {
    return {
      width: 0,
      height: 0,
      getContext: (kind: string) => (kind === "webgl2" ? gl : null),
    } as unknown as OffscreenCanvas;
  }

  it("hands a pending context back verbatim until the canvas arrives", () => {
    const worker = makeWorker();
    const context = capturedContext(1);
    const reported: string[] = [];

    worker.restoreGlContextsFromCheckpoint([context], (line) => {
      reported.push(line);
    });

    expect(worker.gl.get(7)).toBeDefined();
    expect(worker.gl.get(7)!.gl).toBeNull();
    expect(worker.captureGlContextsForCheckpoint()).toEqual([context]);
    expect(worker.glOwnedCrtcs()).toEqual([]);
    expect(reported.some((line) => line.includes("renderbuffer contents")))
      .toBe(true);
  });

  it("rebuilds the context when the CRTC's canvas attaches", () => {
    const worker = makeWorker();
    const context = capturedContext(1);
    worker.restoreGlContextsFromCheckpoint([context], () => {});

    const gl2 = new StatefulGl();
    gl2.uniformDeclarationsBySource.set(VERTEX_SOURCE, uniformDeclarations());
    worker.attachKmsCanvas(1, makeGlCanvas(gl2), undefined, { mode: "webgl2" });

    const binding = worker.gl.get(7)!;
    expect(binding.gl).not.toBeNull();
    expect(worker.glOwnedCrtcs()).toEqual([1]);
    expect([...binding.programs.keys()]).toEqual([20]);
    const recaptured = worker.captureGlContextsForCheckpoint();
    expect(recaptured).toEqual([{ ...context, crtcId: 1 }]);
  });

  it("reports a canvas that refuses WebGL2 and stays pending", () => {
    const worker = makeWorker();
    const context = capturedContext(1);
    const reported: string[] = [];
    worker.restoreGlContextsFromCheckpoint([context], (line) => {
      reported.push(line);
    });

    worker.attachKmsCanvas(1, makeGlCanvas(null), undefined, { mode: "webgl2" });

    expect(reported.some((line) => line.includes("refuses a WebGL2"))).toBe(true);
    expect(worker.gl.get(7)!.gl).toBeNull();
    expect(worker.captureGlContextsForCheckpoint()).toEqual([context]);
  });

  it("rebuilds a context-less binding at once with nothing pending", () => {
    const worker = makeWorker();
    const context: CheckpointGlContext = {
      ...capturedContext(null),
      contextId: null,
      state: null,
      buffers: [],
      textures: [],
      shaders: [],
      programs: [],
      vaos: [],
      fbos: [],
      rbos: [],
      boundaries: [],
    };

    worker.restoreGlContextsFromCheckpoint([context], () => {});

    expect(worker.gl.get(7)).toBeDefined();
    expect(worker.gl.get(7)!.nextUniformLoc).toBe(context.nextUniformLoc);
    const captured = worker.captureGlContextsForCheckpoint();
    expect(captured[0]!.contextId).toBeNull();
  });
});
