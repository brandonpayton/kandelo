/**
 * End-to-end `/dev/dsp` playback through the same paced Node sink used by the
 * worker-thread host. No legacy pull drain participates in these tests: the
 * shared-clock transport is claimed before the guest starts, and descriptor
 * close cannot complete until the null sink's wall clock consumes the tail.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { NodePcmDriver } from "../src/audio/node-pcm-driver";
import {
  pcmControlWords,
  readConsumerPosition,
  readDiscardPosition,
  readPcmConfig,
  readProducerPosition,
  type PcmTransportDescriptor,
} from "../src/audio/pcm-transport";
import { NodePlatformIO } from "../src/platform/node";
import { resolveBinary } from "../src/binary-resolver";
import type { CentralizedKernelWorker } from "../src/kernel-worker";
import { ABI_SYSCALLS } from "../src/generated/abi";
import { runCentralizedProgram } from "./centralized-test-helper";
import { ensureSdlDspFixtures } from "./sdl-dsp-fixtures";

const SNDCTL_DSP_SPEED = 0xc004_5002;
const SNDCTL_DSP_SETFMT = 0xc004_5005;
const SNDCTL_DSP_CHANNELS = 0xc004_5006;
const SNDCTL_DSP_SETFRAGMENT = 0xc004_500a;
const SNDCTL_DSP_GETFMTS = 0x8004_500b;
const SNDCTL_DSP_GETOSPACE = 0x8010_500c;

interface AudioProgramResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  elapsedMs: number;
  consumed: Uint8Array;
  sampleRate: number;
  channels: number;
  frameBytes: number;
  fragmentBytes: number;
  fragments: number;
  activeCapacityBytes: number;
  drainedAtExit: boolean;
  cleanTail: boolean;
  producerBytes: number;
  consumerBytes: number;
  discardedBytes: number;
  ioctlRequests: number[];
}

async function runAudioProgram(
  relativePath: string,
  argv: string[],
  timeoutMs = 15_000,
  replicationBehind = false,
): Promise<AudioProgramResult> {
  const consumedChunks: Uint8Array[] = [];
  let kernel: CentralizedKernelWorker | null = null;
  let pcmDriver: NodePcmDriver | null = null;
  let transport: PcmTransportDescriptor | null = null;
  let initialProducer = 0n;
  let initialConsumer = 0n;
  let initialDiscard = 0n;
  const start = performance.now();
  try {
    const result = await runCentralizedProgram({
      programPath: resolveBinary(relativePath),
      argv,
      env: ["SDL_AUDIODRIVER=dsp"],
      timeout: timeoutMs,
      io: new NodePlatformIO(),
      onKernelReady: async (readyKernel) => {
        kernel = readyKernel;
        // This opt-in trace is scoped to the fixture process and is drained
        // after exit. It proves which unmodified upstream backend path ran
        // without adding a production-only ioctl counter or weakening the ABI.
        readyKernel.enableSyscallTrace();
        if (replicationBehind) {
          readyKernel.setReplicationBehindProbe(() => true);
        }
        transport = readyKernel.claimPcmTransport(false);
        const words = pcmControlWords(transport);
        initialProducer = readProducerPosition(words);
        initialConsumer = readConsumerPosition(words);
        initialDiscard = readDiscardPosition(words);
        pcmDriver = new NodePcmDriver({
          clockUpdate: (frames) => readyKernel.pcmClockUpdate(frames),
          onConsume: ({ bytes }) => consumedChunks.push(bytes.slice()),
        });
        await pcmDriver.prepare(transport);
      },
    });
    const elapsedMs = performance.now() - start;
    const activeKernel = kernel as CentralizedKernelWorker | null;
    if (!activeKernel) throw new Error("PCM kernel hook did not run");
    const activeTransport = transport as PcmTransportDescriptor | null;
    if (!activeTransport) throw new Error("PCM transport hook did not run");
    const words = pcmControlWords(activeTransport);
    const config = readPcmConfig(words);
    // Snapshot before the teardown helper gets any opportunity to finish an
    // orphan drain. The fixture's explicit SDL device close must itself have
    // reached the audio clock and released the OFD before process exit.
    const drainedAtExit =
      readProducerPosition(words) === readConsumerPosition(words) &&
      readDiscardPosition(words) === initialDiscard;
    const cleanTail = await activeKernel.waitForPcmDrain(1000);
    const producerBytes = Number(readProducerPosition(words) - initialProducer);
    const consumerBytes = Number(readConsumerPosition(words) - initialConsumer);
    const discardedBytes = Number(readDiscardPosition(words) - initialDiscard);
    const ioctlRequests = activeKernel
      .drainSyscallTrace()
      .filter((event) => event.nr === ABI_SYSCALLS.Ioctl)
      .map((event) => event.args[1] >>> 0);
    const total = consumedChunks.reduce(
      (sum, chunk) => sum + chunk.byteLength,
      0,
    );
    const consumed = new Uint8Array(total);
    let offset = 0;
    for (const chunk of consumedChunks) {
      consumed.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return {
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      elapsedMs,
      consumed,
      sampleRate: activeKernel.audioSampleRate(),
      channels: activeKernel.audioChannels(),
      frameBytes: config.frameBytes,
      fragmentBytes: config.fragmentBytes,
      fragments: config.fragments,
      activeCapacityBytes: config.activeCapacityBytes,
      drainedAtExit,
      cleanTail,
      producerBytes,
      consumerBytes,
      discardedBytes,
      ioctlRequests,
    };
  } finally {
    await pcmDriver?.close().catch(() => {});
    kernel?.shutdownPcmTransport();
  }
}

interface WaveFixture {
  bytes: Uint8Array;
  pcm: Uint8Array;
  sampleRate: number;
  channels: number;
  bitsPerSample: 8 | 16;
  frameBytes: number;
  periodFrames: number;
  periodBytes: number;
  durationMs: number;
  silenceByte: number;
}

function deterministicWave(
  sampleRate: number,
  channels: 1 | 2,
  bitsPerSample: 8 | 16,
  periods: number,
): WaveFixture {
  const periodFrames = 4096;
  const sampleBytes = bitsPerSample / 8;
  const frameBytes = channels * sampleBytes;
  const frames = periodFrames * periods;
  const pcm = new Uint8Array(frames * frameBytes);
  const pcmView = new DataView(pcm.buffer);

  for (let frame = 0; frame < frames; frame++) {
    if (bitsPerSample === 8) {
      // Stay away from unsigned 8-bit silence (0x80), making the exact
      // beginning and end of playwave's sample observable in the sink.
      for (let channel = 0; channel < channels; channel++) {
        pcm[frame * frameBytes + channel] =
          32 + ((frame + channel * 17) % 64);
      }
    } else {
      const left = ((frame % 257) - 128) * 123;
      const offset = frame * frameBytes;
      pcmView.setInt16(offset, left, true);
      if (channels === 2) pcmView.setInt16(offset + 2, -left, true);
    }
  }

  const bytes = new Uint8Array(44 + pcm.byteLength);
  const view = new DataView(bytes.buffer);
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) bytes[offset + i] = text.charCodeAt(i);
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + pcm.byteLength, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * frameBytes, true);
  view.setUint16(32, frameBytes, true);
  view.setUint16(34, bitsPerSample, true);
  ascii(36, "data");
  view.setUint32(40, pcm.byteLength, true);
  bytes.set(pcm, 44);

  return {
    bytes,
    pcm,
    sampleRate,
    channels,
    bitsPerSample,
    frameBytes,
    periodFrames,
    periodBytes: periodFrames * frameBytes,
    durationMs: (frames * 1000) / sampleRate,
    silenceByte: bitsPerSample === 8 ? 0x80 : 0,
  };
}

function expectExactPlaywavePcm(
  consumed: Uint8Array,
  fixture: WaveFixture,
): void {
  const start = consumed.findIndex((byte) => byte !== fixture.silenceByte);
  expect(
    start,
    "playwave never produced non-silent sample data",
  ).toBeGreaterThanOrEqual(0);
  expect(start % fixture.periodBytes).toBe(0);
  expect(consumed.byteLength % fixture.periodBytes).toBe(0);
  expect(
    (consumed.byteLength - fixture.pcm.byteLength) % fixture.periodBytes,
  ).toBe(0);
  expect(start + fixture.pcm.byteLength).toBeLessThanOrEqual(
    consumed.byteLength,
  );

  expect(consumed.slice(0, start)).toEqual(
    new Uint8Array(start).fill(fixture.silenceByte),
  );
  expect(consumed.slice(start, start + fixture.pcm.byteLength)).toEqual(
    fixture.pcm,
  );
  expect(consumed.slice(start + fixture.pcm.byteLength)).toEqual(
    new Uint8Array(consumed.byteLength - start - fixture.pcm.byteLength).fill(
      fixture.silenceByte,
    ),
  );

  // SDL2 may prime its device or race one final callback while playwave polls
  // Mix_Playing(). Bound that behavior while accepting only whole periods.
  expect(consumed.byteLength - fixture.pcm.byteLength).toBeLessThanOrEqual(
    fixture.periodBytes * 8,
  );
}

describe("audio integration", () => {
  beforeAll(() => ensureSdlDspFixtures(), 20 * 60_000);

  it("paces and consumes the deterministic OSS PCM fixture verbatim", async () => {
    const result = await runAudioProgram("programs/audiotest.wasm", [
      "audiotest",
    ]);
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout.trim().split("\n")).toEqual([
      "ready 44100 2",
      "wrote 256",
    ]);
    expect(result.sampleRate).toBe(44_100);
    expect(result.channels).toBe(2);
    expect(result.drainedAtExit).toBe(true);
    expect(result.cleanTail).toBe(true);
    expect(result.consumed.byteLength).toBe(256);
    expect(result.producerBytes).toBe(256);
    expect(result.consumerBytes).toBe(256);
    expect(result.discardedBytes).toBe(0);
    for (let i = 0; i < result.consumed.byteLength; i++) {
      expect(result.consumed[i]).toBe(i & 0xff);
    }
  }, 30_000);

  for (const fixture of [
    {
      relativePath: "programs/sdl-dsp-test/sdl2-dsp-test.wasm",
      argv0: "sdl2-dsp-test",
      sdlMajor: 2,
      rate: 22_050,
      format: "U8",
      channels: 1,
    },
    {
      relativePath: "programs/sdl-dsp-test/sdl3-dsp-test.wasm",
      argv0: "sdl3-dsp-test",
      sdlMajor: 3,
      rate: 48_000,
      format: "S16LE",
      channels: 2,
    },
  ]) {
    it(`runs upstream SDL${fixture.sdlMajor}'s dsp backend at real-time pace`, async () => {
      const result = await runAudioProgram(
        fixture.relativePath,
        [fixture.argv0],
        20_000,
      );
      expect(result.exitCode, result.stderr).toBe(0);
      const resultLines = result.stdout
        .split("\n")
        .filter((line) => line.startsWith("SDL_DSP_RESULT "));
      expect(resultLines, result.stdout).toHaveLength(1);
      const report = JSON.parse(
        resultLines[0]!.slice("SDL_DSP_RESULT ".length),
      ) as {
        sdl_major: number;
        requested_rate: number;
        requested_format: string;
        requested_channels: number;
        actual_rate: number;
        actual_format: string;
        actual_channels: number;
        callbacks: number;
        frames: number;
        pcm_bytes: number;
        period_frames?: number;
        elapsed_ms: number;
        close_ms: number;
        paced: boolean;
      };

      expect(report).toMatchObject({
        sdl_major: fixture.sdlMajor,
        requested_rate: fixture.rate,
        requested_format: fixture.format,
        requested_channels: fixture.channels,
        actual_rate: fixture.rate,
        actual_format: fixture.format,
        actual_channels: fixture.channels,
        paced: true,
      });
      expect(report.callbacks).toBeGreaterThanOrEqual(2);
      expect(report.frames).toBeGreaterThan(0);
      expect(report.elapsed_ms).toBeGreaterThanOrEqual(750);
      expect(report.elapsed_ms).toBeLessThan(2500);
      expect(report.close_ms).toBeLessThan(2000);
      expect(result.elapsedMs).toBeGreaterThanOrEqual(750);
      expect(result.elapsedMs).toBeLessThan(5000);
      expect(report.pcm_bytes).toBe(
        report.frames * (fixture.sdlMajor === 2 ? 1 : 4),
      );
      expect(result.producerBytes).toBeGreaterThan(0);
      const startupSilenceBytes =
        fixture.sdlMajor === 2 ? result.producerBytes - report.pcm_bytes : 0;
      if (fixture.sdlMajor === 2) {
        // SDL2 primes OSS playback with callback-sized silent periods before
        // it starts delivering application callback data. The count depends
        // on how many device periods elapse while its audio thread starts,
        // but each period and every following pattern byte remain exact.
        expect(report.period_frames).toBeGreaterThan(0);
        expect(startupSilenceBytes).toBeGreaterThanOrEqual(
          report.period_frames!,
        );
        expect(startupSilenceBytes % report.period_frames!).toBe(0);
        expect(startupSilenceBytes).toBeLessThanOrEqual(
          report.period_frames! * 4,
        );
        expect(result.producerBytes).toBe(
          report.pcm_bytes + startupSilenceBytes,
        );
      } else {
        // SDL3 may retain a callback-produced suffix in its AudioStream when
        // it destroys the stream; every byte that reached /dev/dsp is still
        // verified below and drained according to the transport cursors.
        expect(result.producerBytes).toBeLessThanOrEqual(report.pcm_bytes);
      }
      expect(result.consumerBytes).toBe(result.producerBytes);
      expect(result.discardedBytes).toBe(0);
      expect(result.consumed.byteLength).toBe(result.producerBytes);
      const expectedPcm = new Uint8Array(result.consumed.byteLength);
      for (let offset = 0; offset < result.consumed.byteLength; offset++) {
        if (fixture.sdlMajor === 2) {
          expectedPcm[offset] =
            offset < startupSilenceBytes
              ? 0x80
              : 32 + ((offset - startupSilenceBytes) % 192);
        } else {
          const phase = Math.floor(offset / 4) % 200;
          const sample = (phase - 100) * 240;
          const right = -sample;
          expectedPcm[offset] = [
            sample & 0xff,
            (sample >> 8) & 0xff,
            right & 0xff,
            (right >> 8) & 0xff,
          ][offset % 4]!;
        }
      }
      expect(result.consumed).toEqual(expectedPcm);
      expect(result.drainedAtExit).toBe(true);
      expect(result.cleanTail).toBe(true);
      if (fixture.sdlMajor === 3) {
        expect(result.ioctlRequests).toContain(SNDCTL_DSP_GETOSPACE);
      }
    }, 30_000);
  }

  for (const playwave of [
    {
      name: "default S16 stereo",
      fixture: deterministicWave(44_100, 2, 16, 5),
      args: [] as string[],
      opened: "Opened audio at 44100 Hz 16 bit stereo",
    },
    {
      name: "requested U8 mono",
      fixture: deterministicWave(22_050, 1, 8, 3),
      args: ["-8", "-m", "-r", "22050"],
      opened: "Opened audio at 22050 Hz 8 bit mono",
    },
  ]) {
    it(
      `plays upstream SDL_mixer playwave's ${playwave.name} WAV exactly`,
      async () => {
        const tempDir = mkdtempSync(join(tmpdir(), "kandelo-playwave-"));
        const wavePath = join(tempDir, "deterministic.wav");
        writeFileSync(wavePath, playwave.fixture.bytes);

        let result: AudioProgramResult;
        try {
          result = await runAudioProgram(
            "programs/playwave.wasm",
            ["playwave", ...playwave.args, wavePath],
            20_000,
          );
        } finally {
          rmSync(tempDir, { recursive: true, force: true });
        }

        expect(result.exitCode, result.stderr).toBe(0);
        expect(`${result.stdout}\n${result.stderr}`).toContain(playwave.opened);
        expect(result.sampleRate).toBe(playwave.fixture.sampleRate);
        expect(result.channels).toBe(playwave.fixture.channels);
        expect(result.frameBytes).toBe(playwave.fixture.frameBytes);
        expect(result.fragmentBytes).toBe(playwave.fixture.periodBytes);
        expect(result.fragments).toBe(2);
        expect(result.activeCapacityBytes).toBe(
          playwave.fixture.periodBytes * 2,
        );

        // The sample itself must take approximately this much audio-clock
        // time; startup periods and process setup may make the total longer.
        expect(result.elapsedMs).toBeGreaterThanOrEqual(
          playwave.fixture.durationMs * 0.75,
        );
        expect(result.elapsedMs).toBeLessThan(5000);
        expect(result.producerBytes).toBeGreaterThanOrEqual(
          playwave.fixture.pcm.byteLength,
        );
        expect(result.consumerBytes).toBe(result.producerBytes);
        expect(result.consumed.byteLength).toBe(result.producerBytes);
        expect(result.discardedBytes).toBe(0);
        expect(result.drainedAtExit).toBe(true);
        expect(result.cleanTail).toBe(true);
        expectExactPlaywavePcm(result.consumed, playwave.fixture);

        for (const request of [
          SNDCTL_DSP_GETFMTS,
          SNDCTL_DSP_SETFMT,
          SNDCTL_DSP_CHANNELS,
          SNDCTL_DSP_SPEED,
          SNDCTL_DSP_SETFRAGMENT,
        ]) {
          expect(result.ioctlRequests).toContain(request);
        }
      },
      30_000,
    );
  }

  it("frees a replica's audio backlog instead of re-serving its waits", async () => {
    const fixture = deterministicWave(44_100, 2, 16, 120);
    const tempDir = mkdtempSync(join(tmpdir(), "kandelo-playwave-"));
    const wavePath = join(tempDir, "deterministic.wav");
    writeFileSync(wavePath, fixture.bytes);

    let result: AudioProgramResult;
    try {
      result = await runAudioProgram(
        "programs/playwave.wasm",
        ["playwave", wavePath],
        20_000,
        true,
      );
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }

    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.producerBytes).toBeGreaterThanOrEqual(
      fixture.pcm.byteLength,
    );
    // A replica behind the log discards the samples the primary's listener
    // already heard instead of waiting out the physical clock again, so the
    // whole sample finishes in far less than its audio-clock duration.
    expect(result.discardedBytes).toBeGreaterThan(0);
    expect(result.elapsedMs).toBeLessThan(fixture.durationMs * 0.75);
  }, 30_000);

  it("paces SDL through the production dedicated Node kernel worker", async () => {
    const start = performance.now();
    const result = await runCentralizedProgram({
      programPath: resolveBinary("programs/sdl-dsp-test/sdl2-dsp-test.wasm"),
      argv: ["sdl2-dsp-test"],
      env: ["SDL_AUDIODRIVER=dsp"],
      timeout: 20_000,
      useDefaultRootfs: false,
    });
    const elapsedMs = performance.now() - start;

    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain('\"sdl_major\":2');
    expect(result.stdout).toContain('\"paced\":true');
    expect(elapsedMs).toBeGreaterThanOrEqual(750);
    expect(elapsedMs).toBeLessThan(5000);
    expect(result.hostDiagnostics).toEqual([]);
  }, 30_000);
});
