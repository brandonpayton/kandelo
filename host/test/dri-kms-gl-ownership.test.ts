import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWasmPosixKernelTestHarness, type WasmPosixKernel } from "../src/kernel";
import { createCentralizedKernelWorkerTestDouble } from "../src/kernel-worker";
import { NodePlatformIO } from "../src/platform/node";
import { createKernelScratchTestInstance } from "./support/kernel-scratch-instance";
import { installKernelWorkerTestScratch } from "./kernel-worker-test-scratch";

/**
 * A KMS canvas is GL-owned once a WebGL2 context paints it, and not before.
 *
 * The distinction decides whether a machine can be checkpointed. A GL guest
 * paints the canvas directly and writes nothing back, so a checkpoint has no
 * pixels to read and must refuse. A guest that paints its GBM buffer object by
 * CPU leaves its pixels where the checkpoint does read them, so refusing it
 * would name a boundary that machine has not reached.
 */

const CRTC = 1;
const PID = 7;

function makeFakeCanvas(
  context: unknown,
): OffscreenCanvas & { requested: string[] } {
  const requested: string[] = [];
  return {
    width: 0,
    height: 0,
    requested,
    getContext: (kind: string) => {
      requested.push(kind);
      return context;
    },
  } as unknown as OffscreenCanvas & { requested: string[] };
}

function fakeWebgl2Context(): WebGL2RenderingContext {
  return { getExtension: () => null } as unknown as WebGL2RenderingContext;
}

function makeKernel(canvas: OffscreenCanvas | undefined): {
  kernel: WasmPosixKernel;
  createContext: (pid: number, ctxId: number) => void;
  owned: number[];
} {
  const owned: number[] = [];
  const memory = new WebAssembly.Memory({ initial: 2, maximum: 2 });
  const kernel = createWasmPosixKernelTestHarness({
    memory,
    pointerWidth: 4,
    instance: createKernelScratchTestInstance(4, memory, () => ({}), () => 4096),
    callbacks: {
      getKmsCanvas: () => canvas,
      markKmsCanvasGlOwned: (crtcId: number) => owned.push(crtcId),
    },
  }) as WasmPosixKernel & Record<string, any>;
  const env = kernel.testAuthority.buildImportObject(memory).env as Record<
    string,
    (...args: any[]) => any
  >;
  return {
    kernel,
    createContext: (pid, ctxId) => env.host_gl_create_context!(pid, ctxId, 0, 0),
    owned,
  };
}

/** A guest holding DRM master on a CRTC that scans out a framebuffer. */
function driveModeset(kernel: WasmPosixKernel): void {
  kernel.kms.setMasterPid(PID);
  kernel.kms.addFb({
    fb_id: 10,
    bo_id: 100,
    width: 64,
    height: 48,
    pixel_format: 0,
    pitch: 64 * 4,
  });
  kernel.kms.setFb(CRTC, 10);
  kernel.gl.bind({ pid: PID, cmdbufAddr: 0, cmdbufLen: 0 });
}

describe("KMS canvas GL ownership", () => {
  it("marks the CRTC when eglCreateContext builds a WebGL2 context", () => {
    const canvas = makeFakeCanvas(fakeWebgl2Context());
    const { kernel, createContext, owned } = makeKernel(canvas);
    driveModeset(kernel);

    createContext(PID, 1);

    expect(canvas.requested).toEqual(["webgl2"]);
    expect(owned).toEqual([CRTC]);
    expect(kernel.gl.get(PID)!.gl).not.toBeNull();
  });

  it("leaves the CRTC unmarked when the canvas yields no WebGL2 context", () => {
    const canvas = makeFakeCanvas(null);
    const { kernel, createContext, owned } = makeKernel(canvas);
    driveModeset(kernel);

    createContext(PID, 1);

    expect(canvas.requested).toEqual(["webgl2"]);
    expect(owned).toEqual([]);
    expect(kernel.gl.get(PID)!.gl).toBeNull();
  });

  it("leaves the CRTC unmarked when no canvas is registered for it", () => {
    const { kernel, createContext, owned } = makeKernel(undefined);
    driveModeset(kernel);

    createContext(PID, 1);

    expect(owned).toEqual([]);
  });
});

describe("CentralizedKernelWorker glOwnedCrtcs", () => {
  beforeEach(() => {
    // The worker captures its scheduler during construction, so install fake
    // timers before the double is built and let attachKmsCanvas start the
    // vblank pump against them.
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

  it("reports nothing for a canvas the embedder only reserved for GL", () => {
    const worker = makeWorker();
    worker.attachKmsCanvas(CRTC, makeFakeCanvas(null), undefined, {
      mode: "webgl2",
    });

    expect(worker.glOwnedCrtcs()).toEqual([]);
  });

  it("reports the CRTC once GL claims the canvas", () => {
    const worker = makeWorker();
    worker.attachKmsCanvas(CRTC, makeFakeCanvas(null), undefined, {
      mode: "webgl2",
    });

    worker.markKmsCanvasGlOwned(CRTC);

    expect(worker.glOwnedCrtcs()).toEqual([CRTC]);
    // A second claim is the same claim: the guest may recreate its context.
    worker.markKmsCanvasGlOwned(CRTC);
    expect(worker.glOwnedCrtcs()).toEqual([CRTC]);
  });

  it("reports nothing for a CPU-blit canvas", () => {
    const worker = makeWorker();
    worker.attachKmsCanvas(CRTC, makeFakeCanvas({ putImageData: () => {} }), undefined, {
      mode: "2d",
    });

    expect(worker.glOwnedCrtcs()).toEqual([]);
  });
});
