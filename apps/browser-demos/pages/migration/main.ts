/**
 * Tab-to-tab machine handover demo (T2.4).
 *
 * Tab 1 boots a machine, runs fbDOOM on /dev/fb0, and offers its machine on
 * the local handover channel. Tab 2 asks, receives the frozen checkpoint over
 * BroadcastChannel, and boots a receiver machine from it; tab 1 stops. The
 * game continues from the captured frame, keyboard included. Audio stays
 * disabled: this page wires no PCM consumer, and a working /dev/dsp would
 * park fbDOOM in a write nobody drains.
 *
 * The tab that holds the machine also mirrors its frames on the local
 * framebuffer channel, and every tab without a machine watches that stream
 * live — before its first takeover and after handing over alike. Watching
 * carries no input authority: the keyboard is attached only in the owning
 * tab, and "Take over" is what moves it.
 */
import { BrowserKernel } from "@host/browser-kernel-host";
import {
  FramebufferRegistry,
  attachCanvas,
  attachLinuxMediumRawKeyboard,
} from "@host/framebuffer";
import type { MachineCheckpoint } from "@host/migration/checkpoint";
import { LocalFramebufferMirror } from "@host/migration/mirror-local";
import { LocalCheckpointHandover } from "@host/migration/transport-local";
import kernelWasmUrl from "@kernel-wasm?url";
import fbdoomUrl from "@binaries/programs/wasm32/fbdoom.wasm?url";
import {
  createBuildFsWithEtc,
  finalizeKernelOwnedImage,
  settleWebKitReclaim,
} from "../../lib/kernel-owned-boot";

/** Same pinned shareware IWAD as `host/test/support/doom-shareware.ts`. */
const DOOM_WAD_URL =
  "https://cdn.jsdelivr.net/gh/gaborbata/vanilla-mocha-doom@15825a07a48806bcfb242a42afd5ee7cb3c9a3a4/wads/doom1.wad";
const CAPTURE_TIMEOUTS = { unwindTimeoutMs: 10_000, vforkTimeoutMs: 5_000 };
const WATCHING_STATUS = "Watching the other tab's machine live. Take over to play.";
const HANDED_OVER_STATUS =
  "Handed over — watching the machine live in the other tab. Take it back any time.";

declare global {
  interface Window {
    __migrationDemo: {
      state: () => string;
      hasInput: () => boolean;
      framePixelSum: () => number;
      snapshotFrame: () => number;
      frameDiffCount: () => number;
    };
  }
}

const statusLine = document.getElementById("status") as HTMLDivElement;
const startButton = document.getElementById("start") as HTMLButtonElement;
const takeButton = document.getElementById("take") as HTMLButtonElement;
const canvas = document.getElementById("screen") as HTMLCanvasElement;

let kernel: BrowserKernel | null = null;
let pid = 0;
let detachCanvas: (() => void) | null = null;
let detachKeyboard: (() => void) | null = null;
let stopOffer: (() => void) | null = null;
let stopPublish: (() => void) | null = null;
let stopWatch: (() => void) | null = null;
let watchRegistry: FramebufferRegistry | null = null;
let watchPid = 0;
const handover = new LocalCheckpointHandover();
const mirror = new LocalFramebufferMirror();

function setStatus(text: string): void {
  statusLine.textContent = text;
}

async function fetchBytes(url: string, what: string): Promise<ArrayBuffer> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${what} fetch failed: ${response.status}`);
  }
  return response.arrayBuffer();
}

function attachScreen(machine: BrowserKernel, screenPid: number): void {
  detachCanvas?.();
  detachKeyboard?.();
  detachCanvas = attachCanvas(canvas, machine.framebuffers, screenPid, {
    getProcessMemory: (candidate) => machine.getProcessMemory(candidate),
  });
  const keyboard = attachLinuxMediumRawKeyboard(
    canvas,
    { sendInput: (bytes) => machine.ptyWrite(screenPid, bytes) },
    { getEnabled: () => kernel === machine },
  );
  detachKeyboard = () => keyboard.close();
  canvas.focus();
}

function startWatching(bindStatus: string): void {
  stopWatching();
  const registry = new FramebufferRegistry();
  watchRegistry = registry;
  const stopChange = registry.onChange((boundPid, event) => {
    if (event !== "bind" || kernel) return;
    watchPid = boundPid;
    detachCanvas?.();
    detachCanvas = attachCanvas(canvas, registry, boundPid, {
      getProcessMemory: () => undefined,
    });
    setStatus(bindStatus);
  });
  const stopMirror = mirror.watch(registry);
  stopWatch = () => {
    stopChange();
    stopMirror();
  };
}

function stopWatching(): void {
  stopWatch?.();
  stopWatch = null;
  watchRegistry = null;
  watchPid = 0;
}

function startPublishing(machine: BrowserKernel, publishPid: number): void {
  stopPublish?.();
  stopPublish = mirror.publish(machine.framebuffers, publishPid);
}

function offerThisMachine(): void {
  stopOffer?.();
  stopOffer = handover.offer(
    async () => {
      if (!kernel) return null;
      const capture = await kernel.captureCheckpointBytes(CAPTURE_TIMEOUTS);
      if (capture.status !== "captured") {
        throw new Error(`capture ${capture.status}: ${"reason" in capture ? capture.reason : ""}`);
      }
      return capture.checkpoint;
    },
    () => {
      // The machine now lives in the taking tab. Truthfully stop this one
      // rather than keep a second divergent copy running.
      const handedOver = kernel;
      kernel = null;
      stopOffer?.();
      stopOffer = null;
      stopPublish?.();
      stopPublish = null;
      detachCanvas?.();
      detachCanvas = null;
      detachKeyboard?.();
      detachKeyboard = null;
      startWatching(HANDED_OVER_STATUS);
      setStatus(HANDED_OVER_STATUS);
      takeButton.disabled = false;
      void handedOver?.destroy().then(() => settleWebKitReclaim());
    },
  );
}

async function start(): Promise<void> {
  startButton.disabled = true;
  takeButton.disabled = true;
  stopWatching();
  try {
    setStatus("Fetching fbDOOM and the shareware IWAD...");
    const [kernelWasm, fbdoom, wad] = await Promise.all([
      fetchBytes(kernelWasmUrl as string, "kernel"),
      fetchBytes(fbdoomUrl as string, "fbdoom"),
      fetchBytes(DOOM_WAD_URL, "doom1.wad"),
    ]);
    setStatus("Booting the machine...");
    const buildFs = await createBuildFsWithEtc();
    const wadBytes = new Uint8Array(wad);
    const fd = buildFs.open("/doom1.wad", 0x241 /* O_WRONLY|O_CREAT|O_TRUNC */, 0o644);
    buildFs.write(fd, wadBytes, null, wadBytes.length);
    buildFs.close(fd);
    const image = await finalizeKernelOwnedImage(buildFs);
    const machine = new BrowserKernel({ kernelOwnedFs: true });
    await machine.initFromOwnedImage({
      kernelWasm,
      vfsImage: (image.byteOffset === 0
        && image.byteLength === image.buffer.byteLength
        ? image.buffer
        : image.slice().buffer) as ArrayBuffer,
    });
    kernel = machine;
    await new Promise<void>((resolve) => {
      void machine.spawn(fbdoom, ["fbdoom", "-iwad", "/doom1.wad"], {
        pty: true,
        env: ["AUDIODEV=/nonexistent-dsp"],
        onStarted: (startedPid) => {
          pid = startedPid;
          resolve();
        },
      });
    });
    attachScreen(machine, pid);
    offerThisMachine();
    startPublishing(machine, pid);
    setStatus("Running. Open this page in a second tab and take over there.");
  } catch (error) {
    setStatus(`Start failed: ${error instanceof Error ? error.message : String(error)}`);
    startButton.disabled = false;
    startWatching(WATCHING_STATUS);
  }
}

async function take(): Promise<void> {
  startButton.disabled = true;
  takeButton.disabled = true;
  try {
    setStatus("Asking the other tab for its machine...");
    const checkpoint: MachineCheckpoint = await handover.take(30_000);
    if (checkpoint.processes.length === 0) {
      throw new Error("the checkpoint carries no process");
    }
    setStatus("Received the checkpoint; booting the receiver...");
    const kernelWasm = await fetchBytes(kernelWasmUrl as string, "kernel");
    const buildFs = await createBuildFsWithEtc();
    const image = await finalizeKernelOwnedImage(buildFs);
    const machine = new BrowserKernel({ kernelOwnedFs: true });
    await machine.initFromOwnedImage({
      kernelWasm,
      vfsImage: (image.byteOffset === 0
        && image.byteLength === image.buffer.byteLength
        ? image.buffer
        : image.slice().buffer) as ArrayBuffer,
      restoreCheckpoint: checkpoint,
    });
    kernel = machine;
    pid = checkpoint.processes[0]!.pid;
    stopWatching();
    attachScreen(machine, pid);
    offerThisMachine();
    startPublishing(machine, pid);
    setStatus("Running the restored machine — taken over from the other tab.");
  } catch (error) {
    setStatus(`Take over failed: ${error instanceof Error ? error.message : String(error)}`);
    startButton.disabled = false;
    takeButton.disabled = false;
  }
}

startButton.addEventListener("click", () => void start());
takeButton.addEventListener("click", () => void take());
startWatching(WATCHING_STATUS);

function sampleFrame(): Uint8Array | null {
  const binding = kernel
    ? kernel.framebuffers.get(pid)
    : watchRegistry?.get(watchPid);
  if (!binding?.hostBuffer) return null;
  // Sampling every 97th byte keeps the probes cheap while any animation
  // still changes them.
  const samples = new Uint8Array(Math.ceil(binding.hostBuffer.length / 97));
  for (let i = 0; i < binding.hostBuffer.length; i += 97) {
    samples[i / 97 | 0] = binding.hostBuffer[i]!;
  }
  return samples;
}

let frameSnapshot: Uint8Array | null = null;

window.__migrationDemo = {
  state: () => statusLine.textContent ?? "",
  hasInput: () => detachKeyboard !== null,
  framePixelSum: () => {
    const samples = sampleFrame();
    if (!samples) return -1;
    let sum = 0;
    for (const byte of samples) sum += byte;
    return sum;
  },
  // The pixel sum cannot tell a small idle animation from a real scene
  // change, so input tests snapshot a frame and count differing samples:
  // a keypress the game acted on rewrites the whole viewport.
  snapshotFrame: () => {
    frameSnapshot = sampleFrame();
    return frameSnapshot?.length ?? -1;
  },
  frameDiffCount: () => {
    const samples = sampleFrame();
    if (!samples || !frameSnapshot || samples.length !== frameSnapshot.length) {
      return -1;
    }
    let differing = 0;
    for (let i = 0; i < samples.length; i++) {
      if (samples[i] !== frameSnapshot[i]) differing += 1;
    }
    return differing;
  },
};
