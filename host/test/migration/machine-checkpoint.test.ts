/**
 * End-to-end machine checkpoint through `NodeKernelHost.captureCheckpoint`.
 *
 * `checkpoint.test.ts` beside this file drives the freeze protocol against an
 * injected `CheckpointMachine`, which proves the ordering and the reversal but
 * never runs a guest. This file runs one: a real program reaches its unwind
 * hook, parks with its frames in linear memory, and is read and resumed.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NodeKernelHost } from "../../src/node-kernel-host";
import { findRepoRoot } from "../../src/binary-resolver";

const TIMEOUTS = { unwindTimeoutMs: 10_000, vforkTimeoutMs: 5_000 };

function programBytes(name: string): ArrayBuffer {
  const bytes = readFileSync(join(findRepoRoot(), "examples", name));
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
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
  let pid = -1;
  const started = new Promise<void>((resolve) => {
    void host.spawn(programBytes(program), [program], {
      onStarted: (started) => { pid = started; resolve(); },
    });
  });
  await started;
  await isReady;
  return { host, pid };
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
