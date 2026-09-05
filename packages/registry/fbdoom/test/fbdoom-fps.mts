/**
 * Measure fbDOOM's frame rate.
 *
 * fbDOOM writes the whole surface through `/dev/fb0` every frame, so the bytes
 * pushed through `FramebufferRegistry` divided by the surface size is the frame
 * count. fbDOOM writes the surface twice per DOOM tic, so attract mode reports
 * 70 surface writes per second on any build that keeps DOOM's 35-tic pace.
 *
 * Frames are bucketed per second. DOOM's attract mode alternates static title
 * and credit screens with recorded gameplay demos, and the two do not cost the
 * same. A single mean over the whole run hides that, so the buckets are
 * reported too.
 *
 * The kernel runs on the main thread, for the same reason
 * `host/test/framebuffer-integration.test.ts` does it: the framebuffer registry
 * lives inside `CentralizedKernelWorker` and this harness reads it directly.
 * Process workers still run in real worker threads.
 *
 * Two things must be supplied or fbDOOM stops early.
 *
 * 1. A terminal on fd 0. `kbd_init` in `fbdoom-src/fbdoom/i_input_tty.c` scans
 *    `/dev/tty`, `/dev/tty0` and `/dev/console`, and calls `exit(0)` when a
 *    later ioctl fails. `ptyrun.wasm` supplies one.
 * 2. A consumer for `/dev/dsp`. fbDOOM writes PCM from its main loop.
 *    `crates/kernel/src/audio.rs` returns `EAGAIN` once the ring is full and
 *    the host turns that into a blocking retry, so a run with no audio consumer
 *    renders one frame and then stops forever.
 *
 * A fourth argument names a file for fbDOOM's terminal output. The test helper
 * only surfaces captured stdout when the program exits, so a stalled run
 * reports nothing without it.
 *
 * Any further arguments go to fbDOOM. `-timedemo demo1` runs the demo uncapped
 * and reports gametics against realtics. Use it to measure a cost that fits
 * inside DOOM's frame budget: the capped attract-mode run cannot show one.
 *
 * Build `ptyrun.wasm` beside this file first. It forks, so it needs
 * instrumentation:
 *   wasm32posix-cc -O2 packages/registry/fbdoom/test/ptyrun.c -o ptyrun.raw.wasm
 *   tools/bin/wasm-fork-instrument ptyrun.raw.wasm \
 *       -o packages/registry/fbdoom/test/ptyrun.wasm
 *
 * Usage:
 *   tsx fbdoom-fps.mts <fbdoom.wasm> <iwad> <seconds> [log] [fbdoom args...]
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { NodePlatformIO } from "../../../../host/src/platform/node";
import { runCentralizedProgram } from "../../../../host/test/centralized-test-helper";

const HERE = dirname(fileURLToPath(import.meta.url));
const PTYRUN = join(HERE, "ptyrun.wasm");

const [programPath, wadPath, secondsArg, logPath] = process.argv.slice(2);
const doomArgs = process.argv.slice(6);
const seconds = Number(secondsArg ?? 60);

let surfaceBytes = 0;
let startedAt = 0;
const perSecond: number[] = [];

function report(): void {
  const elapsed = (performance.now() - startedAt) / 1000;
  const bytes = perSecond.reduce((sum, value) => sum + value, 0);
  const frames = surfaceBytes === 0 ? 0 : bytes / surfaceBytes;
  console.log(`surface_bytes\t${surfaceBytes}`);
  console.log(`elapsed_s\t${elapsed.toFixed(2)}`);
  console.log(`frames\t${frames.toFixed(1)}`);
  console.log(`fps_mean\t${(frames / elapsed).toFixed(2)}`);
  console.log("second\tfps");
  for (const [index, written] of perSecond.entries()) {
    console.log(`${index}\t${(written / surfaceBytes).toFixed(1)}`);
  }
  process.exit(0);
}

void runCentralizedProgram({
  programPath: PTYRUN,
  // `NodePlatformIO` maps guest paths onto the host filesystem, so the exec
  // target is the real path of the binary under measurement.
  argv: [
    "ptyrun",
    ...(logPath ? ["-l", logPath] : []),
    programPath,
    "fbdoom",
    "-iwad",
    wadPath,
    ...doomArgs,
  ],
  timeout: (seconds + 30) * 1000,
  io: new NodePlatformIO(),
  onKernelReady: (kernelWorker) => {
    const sink = new Uint8Array(65536);
    setInterval(() => {
      while (kernelWorker.drainAudio(sink) > 0);
    }, 10).unref();

    kernelWorker.framebuffers.onChange((pid, event) => {
      if (event !== "bind") return;
      const binding = kernelWorker.framebuffers.list().find((b) => b.pid === pid);
      if (!binding) return;
      surfaceBytes = binding.stride * binding.h;
      console.error(
        `bound ${binding.w}x${binding.h} stride=${binding.stride} `
          + `surface=${surfaceBytes}B`,
      );
    });
    kernelWorker.framebuffers.onWrite((_pid, _offset, bytes) => {
      if (startedAt === 0) {
        startedAt = performance.now();
        setTimeout(report, seconds * 1000).unref();
      }
      const bucket = Math.floor((performance.now() - startedAt) / 1000);
      while (perSecond.length <= bucket) perSecond.push(0);
      perSecond[bucket] += bytes.length;
    });
  },
}).then((result) => {
  console.error(`program exited early: ${result.exitCode}`);
  console.error(`--- stdout ---\n${result.stdout}`);
  console.error(`--- stderr ---\n${result.stderr}`);
  report();
});
