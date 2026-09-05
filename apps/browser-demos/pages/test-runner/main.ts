/**
 * Browser test runner — runs individual wasm test programs via BrowserKernel.
 *
 * Exposes window.__runTest(wasmBytes) for Playwright to call.
 * Each call creates a fresh BrowserKernel, runs the program, cleans up,
 * and returns { exitCode, stdout, stderr, hostDiagnostics }.
 */
import { BrowserKernel } from "@host/browser-kernel-host";
import type { HostDiagnostic } from "@host/host-diagnostic";
import type { BrowserCorsProxyConfig } from "@host/networking/browser-cors-proxy";
import pcmAudioWorkletUrl from "@host/audio/pcm-audio-worklet.js?url";
import {
  pcmControlWords,
  readConsumerPosition,
  readDiscardPosition,
  readPcmConfig,
  readProducerPosition,
  type PcmTransportDescriptor,
} from "@host/audio/pcm-transport";
import {
  createBuildFsWithEtc,
  finalizeKernelOwnedImage,
  settleWebKitReclaim,
} from "../../lib/kernel-owned-boot";
import { resolveBrowserCorsProxyConfig } from "../../lib/browser-cors-proxy";
import kernelWasmUrl from "@kernel-wasm?url";
import type { MachineCheckpoint } from "@host/migration/checkpoint";
import type { ExecBinarySupport } from "./exec-binaries";

interface DataFile {
  path: string;
  data?: number[]; // byte array (transferred as JSON-safe array)
  useWasmBytes?: boolean; // if true, use the wasmBytes as file content
}

interface MigrationDataFile {
  path: string;
  base64: string;
}

interface MigrationRestoreOptions {
  dataFiles?: MigrationDataFile[];
  env?: string[];
  pty?: boolean;
  readyMarker: string;
  settleMs?: number;
}

interface MachineCheckpointThreadsSummary {
  pids: number[];
  threads: { pid: number; tids: number[]; activeCount: number }[];
}

interface MigrationRestoreResult {
  captured: MachineCheckpointThreadsSummary;
  signaled: boolean;
  recaptured: MachineCheckpointThreadsSummary;
  output: string;
  hostDiagnostics: string[];
}

interface PtyInput {
  data: Uint8Array;
  readyMarker: string;
}

interface AudioTestSnapshot {
  audioState: ReturnType<BrowserKernel["getAudioState"]>;
  audioStates: ReturnType<BrowserKernel["getAudioState"]>[];
  workletAssetUrl: string;
  workletPrepared: boolean;
  producerBytes: number;
  consumerBytes: number;
  discardBytes: number;
  queuedBytes: number;
  activeCapacityBytes: number;
  settled: boolean;
  resumeAttempts: number;
  trustedResumeAttempts: number;
  lastResumeError: string | null;
  stdout: string;
  stderr: string;
  hostDiagnostics: string[];
}

interface AudioTestResult extends AudioTestSnapshot {
  exitCode: number;
  elapsedMs: number;
}

interface AudioTestSession {
  kernel: BrowserKernel;
  transport: PcmTransportDescriptor;
  stdout: string;
  stderr: string;
  hostDiagnostics: string[];
  audioStates: ReturnType<BrowserKernel["getAudioState"]>[];
  workletPrepared: boolean;
  settled: boolean;
  resumeAttempts: number;
  trustedResumeAttempts: number;
  lastResumeError: string | null;
  result?: Promise<AudioTestResult>;
  unsubscribeAudioState?: () => void;
}

declare global {
  interface Window {
    __testRunnerReady: boolean;
    __runTest: (
      wasmBytes: ArrayBuffer,
      argv?: string[],
      timeoutMs?: number,
      options?: {
        dataFiles?: DataFile[];
        cwd?: string;
        env?: string[];
        ptyInput?: PtyInput;
        corsProxy?: BrowserCorsProxyConfig;
      },
    ) => Promise<{
      exitCode: number;
      stdout: string;
      stderr: string;
      combined: string;
      hostDiagnostics: HostDiagnostic[];
    }>;
    __testCount: number;
    /**
     * Freeze a running guest into a machine checkpoint, tear the machine
     * down, boot a second machine from the checkpoint, and prove the restored
     * guest resumed by recapturing it — a capture completes only when every
     * task crosses a syscall boundary and unwinds again.
     */
    __runMigrationRestoreTest: (
      wasmBytes: ArrayBuffer,
      argv: string[],
      options: MigrationRestoreOptions,
    ) => Promise<MigrationRestoreResult>;
    /**
     * Start one real-browser `/dev/dsp` run with the AudioContext deliberately
     * suspended. The guest is allowed to fill the bounded PCM ring and block
     * in close; `#resume-audio` is the only path that resumes the audio clock.
     */
    __prepareAudioTest: (
      wasmBytes: ArrayBuffer,
      argv?: string[],
      timeoutMs?: number,
    ) => Promise<AudioTestSnapshot>;
    __audioTestSnapshot: () => AudioTestSnapshot;
    __waitForAudioTest: () => Promise<AudioTestResult>;
    __suspendAudioTest: () => Promise<AudioTestSnapshot>;
    __finishAudioTest: () => Promise<void>;
  }
}

let kernelWasmBytes: ArrayBuffer | null = null;
let execBinarySupport: ExecBinarySupport | null = null;
let activeAudioTest: AudioTestSession | null = null;

const corsProxy = resolveBrowserCorsProxyConfig({
  configuredUrl: `${import.meta.env.BASE_URL}__kandelo_cors_proxy?url=`,
  development: import.meta.env.DEV,
  baseUrl: import.meta.env.BASE_URL,
  pageUrl: window.location.href,
});

function audioTransportFor(kernel: BrowserKernel): PcmTransportDescriptor {
  // The transport is intentionally not part of BrowserKernel's public app
  // API. This test-only page inspects it to prove that the production
  // AudioWorklet, rather than a main-thread timer or legacy pull drain,
  // advances the consumer clock.
  const transport = (
    kernel as unknown as { pcmTransport: PcmTransportDescriptor | null }
  ).pcmTransport;
  if (!transport) {
    throw new Error("PCM transport was not published by the kernel worker");
  }
  return transport;
}

function safeCursorNumber(value: bigint, label: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) {
    throw new Error(`${label} PCM cursor is outside JavaScript's safe integer range`);
  }
  return number;
}

function snapshotAudioTest(session = activeAudioTest): AudioTestSnapshot {
  if (!session) throw new Error("No browser audio test is active");
  const words = pcmControlWords(session.transport);
  const producer = readProducerPosition(words);
  const consumer = readConsumerPosition(words);
  const discard = readDiscardPosition(words);
  const effectiveConsumer = consumer > discard ? consumer : discard;
  const config = readPcmConfig(words);
  return {
    audioState: session.kernel.getAudioState(),
    audioStates: session.audioStates.slice(),
    workletAssetUrl: pcmAudioWorkletUrl,
    workletPrepared: session.workletPrepared,
    producerBytes: safeCursorNumber(producer, "producer"),
    consumerBytes: safeCursorNumber(consumer, "consumer"),
    discardBytes: safeCursorNumber(discard, "discard"),
    queuedBytes: safeCursorNumber(
      producer > effectiveConsumer ? producer - effectiveConsumer : 0n,
      "queued",
    ),
    activeCapacityBytes: config.activeCapacityBytes,
    settled: session.settled,
    resumeAttempts: session.resumeAttempts,
    trustedResumeAttempts: session.trustedResumeAttempts,
    lastResumeError: session.lastResumeError,
    stdout: session.stdout,
    stderr: session.stderr,
    hostDiagnostics: session.hostDiagnostics.slice(),
  };
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(
      () => reject(new Error(`${label} timed out after ${timeoutMs} ms`)),
      timeoutMs,
    );
    promise.then(
      (value) => {
        window.clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        window.clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function finishAudioTest(): Promise<void> {
  const session = activeAudioTest;
  activeAudioTest = null;
  const resumeButton = document.getElementById("resume-audio") as HTMLButtonElement;
  resumeButton.disabled = true;
  document.getElementById("audio-status")!.textContent = "Audio test idle";
  if (!session) return;
  session.unsubscribeAudioState?.();
  await session.kernel.destroy().catch(() => {});
  await settleWebKitReclaim();
}

function installAudioResumeButton(): void {
  const resumeButton = document.getElementById("resume-audio") as HTMLButtonElement;
  resumeButton.addEventListener("click", (event) => {
    const session = activeAudioTest;
    if (!session) return;
    session.resumeAttempts++;
    if (event.isTrusted && navigator.userActivation?.isActive) {
      session.trustedResumeAttempts++;
    }
    session.lastResumeError = null;
    resumeButton.disabled = true;
    document.getElementById("audio-status")!.textContent = "Resuming audio...";
    void session.kernel.resumeAudio().then(
      () => {
        document.getElementById("audio-status")!.textContent = "Audio running";
      },
      (error) => {
        session.lastResumeError = error instanceof Error ? error.message : String(error);
        document.getElementById("audio-status")!.textContent =
          `Audio resume failed: ${session.lastResumeError}`;
        resumeButton.disabled = false;
      },
    );
  });
}

async function init() {
  const minimal = new URLSearchParams(window.location.search).get("minimal") === "1";
  /*
   * WHY: tests that never exec shell tools must not activate unrelated
   * optional package generations. The default path still imports the checked
   * tool module; minimal mode simply never requests those bytes.
   */
  const execBinarySupportPromise = minimal
    ? Promise.resolve(null)
    : import("./exec-binaries").then((module) =>
      module.loadExecBinarySupport()
    );
  [kernelWasmBytes, execBinarySupport] = await Promise.all([
    fetch(kernelWasmUrl)
      .then((response) => response.arrayBuffer())
      .catch(() => null),
    execBinarySupportPromise,
  ]);

  if (!kernelWasmBytes) {
    throw new Error("Failed to fetch kernel wasm");
  }

  window.__testCount = 0;

  installAudioResumeButton();

  window.__prepareAudioTest = async (
    wasmBytes: ArrayBuffer,
    argv = ["audiotest"],
    timeoutMs = 30_000,
  ) => {
    await finishAudioTest();

    const buildFs = await createBuildFsWithEtc();
    const vfsImage = await finalizeKernelOwnedImage(buildFs);
    let session: AudioTestSession | null = null;
    const decoder = new TextDecoder();
    const hostDiagnostics: string[] = [];
    const kernel = new BrowserKernel({
      kernelOwnedFs: true,
      onStdout: (data: Uint8Array) => {
        if (session) session.stdout += decoder.decode(data);
      },
      onStderr: (data: Uint8Array) => {
        if (session) session.stderr += decoder.decode(data);
      },
      onHostDiagnostic: (diagnostic) => {
        hostDiagnostics.push(`${diagnostic.source}: ${diagnostic.message}`);
      },
    });

    try {
      await kernel.initFromImage({ kernelWasm: kernelWasmBytes!, vfsImage });
      session = {
        kernel,
        transport: audioTransportFor(kernel),
        stdout: "",
        stderr: "",
        hostDiagnostics,
        audioStates: [],
        workletPrepared: false,
        settled: false,
        resumeAttempts: 0,
        trustedResumeAttempts: 0,
        lastResumeError: null,
      };
      activeAudioTest = session;
      session.unsubscribeAudioState = kernel.onAudioStateChange((state) => {
        if (session && session.audioStates.at(-1) !== state) {
          session.audioStates.push(state);
        }
      });

      // Loading the default worklet URL is part of preparation. Force a
      // suspended starting point even in browsers whose autoplay policy lets
      // a newly-created context run, then queue guest PCM behind that clock.
      await kernel.prepareAudio();
      session.workletPrepared = true;
      await kernel.suspendAudio();
      const startedAt = performance.now();
      session.result = withTimeout(
        kernel.spawn(wasmBytes, argv, { env: ["SDL_AUDIODRIVER=dsp"] }),
        timeoutMs,
        "browser /dev/dsp guest",
      ).then((exitCode) => {
        if (!session) throw new Error("Browser audio session disappeared");
        session.settled = true;
        return {
          ...snapshotAudioTest(session),
          exitCode,
          elapsedMs: performance.now() - startedAt,
        };
      });

      const resumeButton = document.getElementById(
        "resume-audio",
      ) as HTMLButtonElement;
      resumeButton.disabled = false;
      document.getElementById("audio-status")!.textContent = "Audio suspended; PCM may queue";
      return snapshotAudioTest(session);
    } catch (error) {
      if (activeAudioTest === session) activeAudioTest = null;
      session?.unsubscribeAudioState?.();
      await kernel.destroy().catch(() => {});
      throw error;
    }
  };

  window.__audioTestSnapshot = () => snapshotAudioTest();
  window.__waitForAudioTest = async () => {
    const result = activeAudioTest?.result;
    if (!result) throw new Error("Browser audio test has not started");
    return result;
  };
  window.__suspendAudioTest = async () => {
    const session = activeAudioTest;
    if (!session) throw new Error("No browser audio test is active");
    await session.kernel.suspendAudio();
    const resumeButton = document.getElementById("resume-audio") as HTMLButtonElement;
    resumeButton.disabled = false;
    document.getElementById("audio-status")!.textContent = "Audio suspended";
    return snapshotAudioTest(session);
  };
  window.__finishAudioTest = finishAudioTest;

  window.__runTest = async (
    wasmBytes: ArrayBuffer,
    argv?: string[],
    timeoutMs = 30_000,
    options?: {
      dataFiles?: DataFile[];
      cwd?: string;
      env?: string[];
      ptyInput?: PtyInput;
      corsProxy?: BrowserCorsProxyConfig;
    },
  ) => {
    let stdout = "";
    let stderr = "";
    let combined = "";
    const hostDiagnostics: HostDiagnostic[] = [];

    // Assemble the test image (exec binaries + /etc + any data files) in a
    // transient build FS, then hand ownership to the kernel worker so the main
    // thread holds no VFS SharedArrayBuffer across the per-test loop.
    const buildFs = await createBuildFsWithEtc();
    execBinarySupport?.populate(buildFs);
    if (options?.dataFiles) {
      for (const file of options.dataFiles) {
        // Ensure parent directories exist
        const parts = file.path.split("/").filter(Boolean);
        let dirPath = "";
        for (let i = 0; i < parts.length - 1; i++) {
          dirPath += "/" + parts[i];
          try {
            buildFs.mkdir(dirPath, 0o755);
          } catch {
            // Directory may already exist
          }
        }
        // Write the file — use wasmBytes if flagged, otherwise use provided data
        const fileData = file.useWasmBytes
          ? new Uint8Array(wasmBytes)
          : new Uint8Array(file.data!);
        const fd = buildFs.open(
          file.path,
          0x241 /* O_WRONLY|O_CREAT|O_TRUNC */,
          0o755,
        );
        buildFs.write(fd, fileData, null, fileData.length);
        buildFs.close(fd);
      }
    }
    const vfsImage = await finalizeKernelOwnedImage(buildFs);

    const kernel = new BrowserKernel({
      kernelOwnedFs: true,
      corsProxy: options?.corsProxy ?? corsProxy,
      onStdout: (data: Uint8Array) => {
        const text = new TextDecoder().decode(data);
        stdout += text;
        combined += text;
      },
      onStderr: (data: Uint8Array) => {
        const text = new TextDecoder().decode(data);
        stderr += text;
        combined += text;
      },
      onHostDiagnostic: (diagnostic: HostDiagnostic) => {
        hostDiagnostics.push(diagnostic);
      },
    });

    try {
      await kernel.initFromImage({ kernelWasm: kernelWasmBytes!, vfsImage });

      // Run the test with a timeout
      const cwd = options?.cwd;
      const ptyInput = options?.ptyInput;
      const spawnOpts: {
        cwd?: string;
        env?: string[];
        pty?: boolean;
        onStarted?: (pid: number) => Promise<void>;
      } = {};
      if (cwd) spawnOpts.cwd = cwd;
      if (options?.env) spawnOpts.env = options.env;
      if (ptyInput) {
        if (!(ptyInput.data instanceof Uint8Array)) {
          throw new TypeError("ptyInput.data must be a Uint8Array");
        }
        if (ptyInput.readyMarker.length === 0) {
          throw new TypeError("ptyInput.readyMarker must not be empty");
        }
        spawnOpts.pty = true;
        spawnOpts.onStarted = async (pid) => {
          let observed = "";
          let markReady: (() => void) | null = null;
          const ready = new Promise<void>((resolve) => {
            markReady = resolve;
          });
          kernel.onPtyOutput(pid, (data) => {
            const text = new TextDecoder().decode(data);
            stdout += text;
            combined += text;
            observed += text;
            if (observed.includes(ptyInput.readyMarker)) markReady?.();
          });
          /*
           * WHY: ptyWrite enters the kernel's current line discipline
           * synchronously. Wait until the guest confirms its terminal mode,
           * and register the callback first so output buffered before the
           * spawn acknowledgement cannot lose the readiness transition.
           */
          await ready;
          kernel.ptyWrite(pid, ptyInput.data);
        };
      }
      const exitCode = await Promise.race([
        kernel.spawn(wasmBytes, argv ?? ["test"], spawnOpts),
        new Promise<number>((_, reject) =>
          setTimeout(() => reject(new Error("TIMEOUT")), timeoutMs),
        ),
      ]);

      return { exitCode, stdout, stderr, combined, hostDiagnostics };
    } finally {
      // Clean up to free memory for the next test
      await kernel.destroy();
      await settleWebKitReclaim();
      window.__testCount++;
    }
  };

  window.__runMigrationRestoreTest = async (
    wasmBytes: ArrayBuffer,
    argv: string[],
    options: MigrationRestoreOptions,
  ) => {
    const decoder = new TextDecoder();
    let output = "";
    const hostDiagnostics: string[] = [];
    const timeouts = { unwindTimeoutMs: 10_000, vforkTimeoutMs: 5_000 };

    const buildImage = async (
      dataFiles?: MigrationDataFile[],
    ): Promise<ArrayBuffer> => {
      const buildFs = await createBuildFsWithEtc();
      for (const file of dataFiles ?? []) {
        const parts = file.path.split("/").filter(Boolean);
        let dirPath = "";
        for (let i = 0; i < parts.length - 1; i++) {
          dirPath += "/" + parts[i];
          try {
            buildFs.mkdir(dirPath, 0o755);
          } catch {
            // Directory may already exist
          }
        }
        const raw = atob(file.base64);
        const bytes = new Uint8Array(raw.length);
        for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
        const fd = buildFs.open(
          file.path,
          0x241 /* O_WRONLY|O_CREAT|O_TRUNC */,
          0o755,
        );
        buildFs.write(fd, bytes, null, bytes.length);
        buildFs.close(fd);
      }
      const image = await finalizeKernelOwnedImage(buildFs);
      const whole = image.buffer instanceof ArrayBuffer
        && image.byteOffset === 0
        && image.byteLength === image.buffer.byteLength;
      return whole ? (image.buffer as ArrayBuffer) : image.slice().buffer;
    };

    const summarize = (
      checkpoint: MachineCheckpoint,
    ): MachineCheckpointThreadsSummary => ({
      pids: checkpoint.processes.map((bucket) => bucket.pid),
      threads: checkpoint.processes.map((bucket) => ({
        pid: bucket.pid,
        tids: bucket.threads.map((thread) => thread.tid),
        activeCount: bucket.threadAllocator.activeCount,
      })),
    });

    let checkpoint: MachineCheckpoint | null = null;
    let pid = 0;
    const keeper = new BrowserKernel({
      kernelOwnedFs: true,
      onStdout: (data: Uint8Array) => {
        output += decoder.decode(data);
      },
      onStderr: (data: Uint8Array) => {
        output += decoder.decode(data);
      },
      onHostDiagnostic: (diagnostic) => {
        hostDiagnostics.push(`${diagnostic.source}: ${diagnostic.message}`);
      },
    });
    try {
      await keeper.initFromOwnedImage({
        kernelWasm: kernelWasmBytes!,
        vfsImage: await buildImage(options.dataFiles),
      });
      const exit = keeper.spawn(wasmBytes, argv, {
        env: options.env,
        pty: options.pty,
        onStarted: async (startedPid: number) => {
          pid = startedPid;
          if (options.pty) {
            keeper.onPtyOutput(startedPid, (data) => {
              output += decoder.decode(data);
            });
          }
        },
      });
      exit.catch(() => {});
      const deadline = performance.now() + 60_000;
      while (!output.includes(options.readyMarker)) {
        if (performance.now() > deadline) {
          throw new Error(
            `guest never printed ${options.readyMarker}: ${output.slice(-2_000)}`,
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if (options.settleMs) {
        await new Promise((resolve) => setTimeout(resolve, options.settleMs));
      }
      const capture = await keeper.captureCheckpointBytes(timeouts);
      if (capture.status !== "captured") {
        throw new Error(`capture failed: ${JSON.stringify(capture)}`);
      }
      checkpoint = capture.checkpoint;
    } finally {
      await keeper.destroy().catch(() => {});
      await settleWebKitReclaim();
    }

    if (!checkpoint) throw new Error("capture returned no checkpoint");

    const receiver = new BrowserKernel({
      kernelOwnedFs: true,
      onHostDiagnostic: (diagnostic) => {
        hostDiagnostics.push(`${diagnostic.source}: ${diagnostic.message}`);
      },
    });
    try {
      await receiver.initFromOwnedImage({
        kernelWasm: kernelWasmBytes!,
        vfsImage: await buildImage(),
        restoreCheckpoint: checkpoint,
      });
      const signaled = await receiver.signalProcess(pid, 0);
      const recapture = await receiver.captureCheckpointBytes(timeouts);
      if (recapture.status !== "captured") {
        throw new Error(`recapture failed: ${JSON.stringify(recapture)}`);
      }
      return {
        captured: summarize(checkpoint),
        signaled,
        recaptured: summarize(recapture.checkpoint),
        output,
        hostDiagnostics,
      };
    } finally {
      await receiver.destroy().catch(() => {});
      await settleWebKitReclaim();
    }
  };

  document.getElementById("status")!.textContent = "Ready";
  window.__testRunnerReady = true;
}

init().catch((err) => {
  document.getElementById("status")!.textContent = `Error: ${err.message}`;
  console.error("Test runner init failed:", err);
});
