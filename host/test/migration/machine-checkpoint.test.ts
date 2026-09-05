/**
 * End-to-end machine checkpoint through `NodeKernelHost.captureCheckpoint`.
 *
 * `checkpoint.test.ts` beside this file drives the freeze protocol against an
 * injected `CheckpointMachine`, which proves the ordering and the reversal but
 * never runs a guest. This file runs one: a real program reaches its unwind
 * hook, parks with its frames in linear memory, and is read and resumed.
 */
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeKernelHost } from "../../src/node-kernel-host";
import { ABI_VERSION } from "../../src/generated/abi";
import { findRepoRoot, resolveBinary } from "../../src/binary-resolver";
import { doomSharewareWad } from "../support/doom-shareware";

const TIMEOUTS = { unwindTimeoutMs: 10_000, vforkTimeoutMs: 5_000 };

/** Where the guest finds the side module the freeze fixture loads. */
const SIDE_MODULE_GUEST_PATH = "/tmp/checkpoint-dlopen-lib.so";

function fileArrayBuffer(path: string): ArrayBuffer {
  const bytes = readFileSync(path);
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

function programBytes(name: string): ArrayBuffer {
  return fileArrayBuffer(join(findRepoRoot(), "examples", name));
}

/**
 * Start a guest and resolve once it has printed READY.
 *
 * The fixtures print it after reaching their nap loop, so waiting for it means
 * the freeze meets a process that is already crossing syscall boundaries
 * rather than one still in its startup path.
 */
async function startReadyGuest(
  program: string,
  options: {
    readonly args?: readonly string[];
    readonly prepare?: (host: NodeKernelHost) => Promise<void>;
  } = {},
): Promise<{ host: NodeKernelHost; pid: number }> {
  let ready = () => {};
  const isReady = new Promise<void>((resolve) => { ready = resolve; });
  let output = "";
  const host = new NodeKernelHost({
    rootfsImage: "default",
    onStdout: (_pid, data) => {
      output += new TextDecoder().decode(data);
      if (output.includes("READY")) ready();
    },
  });
  await host.init();
  await options.prepare?.(host);
  let pid = -1;
  const started = new Promise<void>((resolve) => {
    void host.spawn(programBytes(program), [program, ...(options.args ?? [])], {
      onStarted: (started) => { pid = started; resolve(); },
    });
  });
  await started;
  await isReady;
  return { host, pid };
}

/**
 * Build the side module the checkpoint fixture loads.
 *
 * It goes through the SDK the same way any other shared library does, so the
 * archive generation the guest publishes is a real one. It is instrumented
 * like every loadable Kandelo artifact: a capture saves module state for each
 * live module, and a module without the instrumentation is absent from the
 * process module catalogs.
 */
function buildSideModule(): Uint8Array {
  const buildDir = join(tmpdir(), "wasm-checkpoint-dlopen");
  mkdirSync(buildDir, { recursive: true });
  const soPath = join(buildDir, "checkpoint-dlopen-lib.so");
  execFileSync(
    "wasm32posix-cc",
    [
      "-shared",
      "-fPIC",
      "-O2",
      `-I${join(findRepoRoot(), "libc/glue")}`,
      join(findRepoRoot(), "host/test/fixtures/checkpoint-dlopen-lib.c"),
      "-o",
      soPath,
    ],
    { stdio: "pipe" },
  );
  execFileSync(
    "bash",
    [
      join(findRepoRoot(), "scripts/run-wasm-fork-instrument.sh"),
      soPath,
      "-o",
      soPath,
    ],
    { stdio: "pipe" },
  );
  // A fresh copy, because writeFileToVfs transfers the backing buffer and a
  // readFileSync Buffer sits in a pool it does not own.
  return new Uint8Array(readFileSync(soPath));
}

describe("machine checkpoint of a running guest", () => {
  it(
    "reads a single-threaded process that keeps reaching a syscall boundary",
    { timeout: 60_000 },
    async () => {
      const { host, pid } = await startReadyGuest("checkpoint-loop.wasm");
      try {
        const response = await host.captureCheckpoint(TIMEOUTS);

        expect(response.status).toBe("captured");
        if (response.status !== "captured") return;
        const { summary } = response;
        expect(summary.kernelMemoryBytes).toBeGreaterThan(0);
        expect(summary.filesystemBytes).toBeGreaterThan(0);
        const captured = summary.processes.find((p) => p.pid === pid);
        expect(captured).toBeDefined();
        expect(captured!.memoryBytes).toBeGreaterThan(0);
        expect(captured!.ptrWidth).toBe(4);
        expect(captured!.executionGeneration).toBeGreaterThan(0);

        // The freeze is reversible, so the guest is still running and can be
        // read a second time.
        const second = await host.captureCheckpoint(TIMEOUTS);
        expect(second.status).toBe("captured");
      } finally {
        await host.destroy();
      }
    },
  );

  it(
    "keeps the guest running after the freeze resumes it",
    { timeout: 60_000 },
    async () => {
      const { host } = await startReadyGuest("checkpoint-loop.wasm");
      try {
        expect((await host.captureCheckpoint(TIMEOUTS)).status).toBe(
          "captured",
        );

        // Well past the resume, not immediately after it. A leftover unwind
        // request word — republished by the completions of the capture's own
        // arena mmaps — would make the guest's next syscall begin a second
        // capture with no freeze active and park it forever. An immediate
        // second capture cannot see that: it adopts the spurious unwind as
        // its own.
        await new Promise((resolve) => setTimeout(resolve, 500));

        const second = await host.captureCheckpoint(TIMEOUTS);
        expect(second.status).toBe("captured");
      } finally {
        await host.destroy();
      }
    },
  );

  it(
    "hands the whole checkpoint to the caller",
    { timeout: 60_000 },
    async () => {
      const program = programBytes("checkpoint-loop.wasm");
      const { host, pid } = await startReadyGuest("checkpoint-loop.wasm");
      try {
        const response = await host.captureCheckpointBytes(TIMEOUTS);

        expect(response.status).toBe("captured");
        if (response.status !== "captured") return;
        const { checkpoint } = response;
        expect(checkpoint.format).toBe(1);
        expect(checkpoint.kernelAbiVersion).toBe(ABI_VERSION);
        expect(checkpoint.kernelMemory.byteLength).toBeGreaterThan(0);
        expect(checkpoint.filesystem.byteLength).toBeGreaterThan(0);
        const bucket = checkpoint.processes.find((p) => p.pid === pid);
        expect(bucket).toBeDefined();
        expect(bucket!.memory.byteLength).toBeGreaterThan(0);
        // The exact program image rode along, so a restore can relaunch it.
        expect(new Uint8Array(bucket!.programBytes)).toEqual(
          new Uint8Array(program),
        );

        // The transfer moved copies, not live state: the guest still runs
        // and the machine can be read again.
        expect(await host.signalProcess(pid, 0)).toBe(true);
        expect((await host.captureCheckpoint(TIMEOUTS)).status).toBe(
          "captured",
        );
      } finally {
        await host.destroy();
      }
    },
  );

  it(
    "reads a running fbDOOM",
    { timeout: 120_000 },
    async () => {
      // A real application rather than a fixture written for the freeze: it
      // loads a 4 MB IWAD, renders through /dev/fb0 and crosses a syscall
      // boundary every game tic.
      const fbdoom = fileArrayBuffer(resolveBinary("programs/fbdoom.wasm"));
      const wad = await doomSharewareWad();
      let ptyOutput = "";
      const host = new NodeKernelHost({
        rootfsImage: "default",
        onPtyOutput: (_pid, data) => {
          ptyOutput += new TextDecoder().decode(data);
        },
      });
      await host.init();
      try {
        await host.writeFileToVfs("/doom1.wad", wad);
        let pid = -1;
        const started = new Promise<void>((resolve) => {
          void host.spawn(fbdoom, ["fbdoom", "-iwad", "/doom1.wad"], {
            // fbDOOM's keyboard input needs a controlling terminal or it
            // exits during startup.
            pty: true,
            // NodeKernelHost has no audio consumer, so a working /dev/dsp
            // would fill the kernel's ring and park fbDOOM in a write the
            // kernel never completes — the timed-out case below, not this
            // one. An unopenable AUDIODEV disables sound through fbDOOM's
            // own fallback.
            env: ["AUDIODEV=/nonexistent-dsp"],
            onStarted: (p) => {
              pid = p;
              resolve();
            },
          });
        });
        await started;

        // ST_Init is the last startup line before fbDOOM enters its game
        // loop; the settle lets it reach the demo loop proper so the freeze
        // meets a game in flight rather than a program still initializing.
        await expect
          .poll(() => ptyOutput.includes("ST_Init"), { timeout: 60_000 })
          .toBe(true);
        await new Promise((resolve) => setTimeout(resolve, 1_500));

        const response = await host.captureCheckpoint(TIMEOUTS);

        expect(response.status).toBe("captured");
        if (response.status !== "captured") return;
        const { summary } = response;
        expect(summary.kernelMemoryBytes).toBeGreaterThan(0);
        expect(summary.filesystemBytes).toBeGreaterThan(wad.byteLength);
        const captured = summary.processes.find((p) => p.pid === pid);
        expect(captured).toBeDefined();
        // The guest loaded the IWAD, so its image holds more than the wad.
        expect(captured!.memoryBytes).toBeGreaterThan(wad.byteLength);
        expect(captured!.argv).toEqual(["fbdoom", "-iwad", "/doom1.wad"]);
        expect(captured!.executionGeneration).toBeGreaterThan(0);
        // fbDOOM renders write-based: the current frame lives in a
        // host-owned buffer the checkpoint must carry.
        expect(summary.framebuffers).toEqual([
          {
            pid,
            w: expect.any(Number),
            h: expect.any(Number),
            hostBufferBytes: expect.any(Number),
          },
        ]);
        expect(summary.framebuffers[0]!.hostBufferBytes).toBeGreaterThan(0);

        // The freeze reversed: the game still runs and can be read again.
        expect(await host.signalProcess(pid, 0)).toBe(true);
        const second = await host.captureCheckpoint(TIMEOUTS);
        expect(second.status).toBe("captured");
      } finally {
        await host.destroy();
      }
    },
  );

  it(
    "reads a process whose pthread must unwind too",
    { timeout: 60_000 },
    async () => {
      const { host, pid } = await startReadyGuest("checkpoint-threads.wasm");
      try {
        const response = await host.captureCheckpoint(TIMEOUTS);

        // A threaded process is captured only once every thread has reported.
        // With one thread left running the freeze would time out instead.
        expect(response.status).toBe("captured");
        if (response.status !== "captured") return;
        expect(
          response.summary.processes.find((p) => p.pid === pid),
        ).toBeDefined();

        // The pthread rewound into its own nap loop rather than being left
        // parked on a gate the resume did not reach.
        const second = await host.captureCheckpoint(TIMEOUTS);
        expect(second.status).toBe("captured");
      } finally {
        await host.destroy();
      }
    },
  );

  it(
    "fails rather than hangs when a thread cannot adopt a newer archive",
    { timeout: 60_000 },
    async () => {
      const sideModule = buildSideModule();
      const { host, pid } = await startReadyGuest("checkpoint-dlopen.wasm", {
        args: [SIDE_MODULE_GUEST_PATH],
        prepare: (started) =>
          started.writeFileToVfs(SIDE_MODULE_GUEST_PATH, sideModule),
      });
      try {
        const started = Date.now();
        const response = await host.captureCheckpoint(TIMEOUTS);
        const elapsed = Date.now() - started;

        // The pthread's replica is one generation behind, so it must take the
        // archive writer, which the parked main thread's reader holds shut.
        expect(response.status).toBe("failed");
        if (response.status !== "failed") return;
        expect(response.reason).toContain(
          "the dynamic-loader archive writer stayed held",
        );
        // The refusal is what ended the freeze, not the 10 s unwind deadline.
        expect(elapsed).toBeLessThan(TIMEOUTS.unwindTimeoutMs);

        // The machine is whole: the freeze reversed and the guest still runs.
        expect(await host.signalProcess(pid, 0)).toBe(true);
      } finally {
        await host.destroy();
      }
    },
  );

  it(
    "fails rather than hangs when the main thread cannot adopt a newer archive",
    { timeout: 60_000 },
    async () => {
      // The fixture's "thread" mode makes the pthread load the side module,
      // so the thread whose replica is behind — and whose bounded writer wait
      // refuses the capture — is the main thread. This drives the process
      // kernel_checkpoint site the way the test above drives the pthread one.
      const sideModule = buildSideModule();
      const { host, pid } = await startReadyGuest("checkpoint-dlopen.wasm", {
        args: [SIDE_MODULE_GUEST_PATH, "thread"],
        prepare: (started) =>
          started.writeFileToVfs(SIDE_MODULE_GUEST_PATH, sideModule),
      });
      try {
        const started = Date.now();
        const response = await host.captureCheckpoint(TIMEOUTS);
        const elapsed = Date.now() - started;

        expect(response.status).toBe("failed");
        if (response.status !== "failed") return;
        expect(response.reason).toContain(
          "the dynamic-loader archive writer stayed held",
        );
        // The refusal is what ended the freeze, not the 10 s unwind deadline.
        expect(elapsed).toBeLessThan(TIMEOUTS.unwindTimeoutMs);

        // The machine is whole: the freeze reversed and the guest still runs.
        expect(await host.signalProcess(pid, 0)).toBe(true);
      } finally {
        await host.destroy();
      }
    },
  );

  it(
    "admits no process launch and no rootfs write into the state it reads",
    { timeout: 60_000 },
    async () => {
      const { host, pid } = await startReadyGuest("checkpoint-loop.wasm");
      const qux = new TextEncoder().encode("qux\n");
      try {
        // Both gates close synchronously inside the capture_checkpoint
        // handler, and the worker port delivers these three messages in the
        // order they are posted, so the two admissions below meet a closed
        // gate rather than racing the freeze.
        const capture = host.captureCheckpoint(TIMEOUTS);
        const launch = host.spawn(programBytes("test-pthread.wasm"), [
          "test-pthread",
        ]);
        const write = host.writeFileToVfs("/tmp/qux", qux);

        await expect(launch).rejects.toThrow(
          "checkpoint freeze is in progress",
        );
        await expect(write).rejects.toThrow("cannot write a rootfs file");

        const response = await capture;
        expect(response.status).toBe("captured");
        if (response.status !== "captured") return;
        // The refused launch left no bucket behind.
        expect(response.summary.processes.map((p) => p.pid)).toEqual([pid]);

        // Both admissions come back, so the refusals were the freeze holding
        // them out rather than the machine losing the capability.
        await expect(
          host.spawn(programBytes("test-pthread.wasm"), ["test-pthread"]),
        ).resolves.toBe(0);
        await host.writeFileToVfs("/tmp/qux", qux);
        expect(await host.readFileFromVfs("/tmp/qux")).toEqual(qux);
      } finally {
        await host.destroy();
      }
    },
  );

  it(
    "times out on a process parked in a syscall the kernel has not completed",
    { timeout: 60_000 },
    async () => {
      const exited = new Set<number>();
      const host = new NodeKernelHost({
        rootfsImage: "default",
        onProcessEvent: (event) => {
          if (event.kind === "exit") exited.add(event.pid);
        },
      });
      await host.init();
      try {
        let pid = -1;
        const started = new Promise<void>((resolve) => {
          void host.spawn(programBytes("block-forever.wasm"), ["block-forever"], {
            onStarted: (started) => { pid = started; resolve(); },
          });
        });
        await started;
        await new Promise((resolve) => setTimeout(resolve, 300));

        const response = await host.captureCheckpoint({
          unwindTimeoutMs: 1_000,
          vforkTimeoutMs: 5_000,
        });

        expect(response.status).toBe("timed-out");
        // A timeout reverses the freeze rather than poisoning the machine.
        expect(exited.has(pid)).toBe(false);
        expect(await host.signalProcess(pid, 0)).toBe(true);
      } finally {
        await host.destroy();
      }
    },
  );

  it(
    "keeps forking, exec and pthreads working after a checkpoint times out",
    { timeout: 60_000 },
    async () => {
      const host = new NodeKernelHost({ rootfsImage: "default" });
      await host.init();
      try {
        let pid = -1;
        const started = new Promise<void>((resolve) => {
          void host.spawn(programBytes("block-forever.wasm"), ["block-forever"], {
            onStarted: (started) => { pid = started; resolve(); },
          });
        });
        await started;
        await new Promise((resolve) => setTimeout(resolve, 300));
        expect(
          (await host.captureCheckpoint({
            unwindTimeoutMs: 1_000,
            vforkTimeoutMs: 5_000,
          })).status,
        ).toBe("timed-out");

        // Every leg of the freeze has to have been given back. Worker creation
        // is the one whose original close had no reopen path, and a pthread
        // and a fork are the two admissions it gates.
        await expect(
          host.spawn(programBytes("test-pthread.wasm"), ["test-pthread"]),
        ).resolves.toBe(0);
        await expect(
          host.spawn(programBytes("wait_lifecycle_test.wasm"), [
            "wait-lifecycle-test",
          ]),
        ).resolves.toBe(0);
        expect(await host.signalProcess(pid, 0)).toBe(true);
      } finally {
        await host.destroy();
      }
    },
  );
});
