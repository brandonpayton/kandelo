/**
 * An injected HTTP request is a machine input, and it replicates as one.
 *
 * The primary's bridge injects a connection its guest observes three ways —
 * the accept, the peer port, the request bytes — so all three travel on the
 * decision log. The replica applies the injection to its own machine, whose
 * server computes the response again; a viewer's fetch on the replica reads
 * that copy and never injects, because an injection the primary never made
 * is a machine that is silently no longer the same machine.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { NodeKernelHost } from "../../src/node-kernel-host";
import { tryResolveBinary } from "../../src/binary-resolver";
import type { HttpRequest } from "../../src/networking";
import type { ReplicationLogEntry } from "../../src/replication/log";
import {
  ReplicationLogQueueWriter,
  createReplicationLogQueue,
} from "../../src/replication/log-queue";
import { captureWhenIdle, pause } from "../support/replication-machine";

const tinyServerPath = tryResolveBinary("programs/tiny-http-server.wasm");

const PORT = 8087;
const REQUEST: HttpRequest = {
  method: "GET",
  url: "/replicated",
  headers: { Host: "kernel.local" },
  body: null,
};

/** How long a replica may still need the primary before the test gives up. */
const FOLLOW_LIMIT_MS = 60_000;

function loadWasm(path: string): ArrayBuffer {
  const buf = readFileSync(path);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

async function until(
  ready: () => boolean,
  limitMs: number,
  describeWait: () => string,
): Promise<void> {
  const deadline = Date.now() + limitMs;
  while (!ready()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting: ${describeWait()}`);
    }
    await pause(25);
  }
}

describe.skipIf(!tinyServerPath)("http exchange replication", () => {
  it(
    "serves a viewer's fetch from the machine's own replayed exchange",
    { timeout: 300_000 },
    async () => {
      const primary = new NodeKernelHost({ rootfsImage: "default" });
      await primary.init();
      let replica: NodeKernelHost | null = null;
      const queue = createReplicationLogQueue();
      const writer = new ReplicationLogQueueWriter(queue);
      const published: ReplicationLogEntry[] = [];
      try {
        const checkpoint = await captureWhenIdle(primary);
        const stopStream = await primary.streamReplicationLog((entries) => {
          published.push(...entries);
          writer.push(entries);
        });

        replica = new NodeKernelHost({
          rootfsImage: "default",
          restoreCheckpoint: checkpoint,
        });
        await replica.init();
        await replica.startReplicationReplay([], queue);

        // Both machines are told to run the same single-shot server. The
        // primary's serves the live fetch below; the replica's serves the
        // injection the log carries, and nothing else.
        const serverBytes = loadWasm(tinyServerPath!);
        const primaryExit = primary.spawn(serverBytes, [
          "tiny-http-server",
          String(PORT),
        ]);
        const replicaExit = replica.spawn(serverBytes.slice(0), [
          "tiny-http-server",
          String(PORT),
        ]);

        let response: Awaited<ReturnType<typeof primary.fetchInKernel>> | null =
          null;
        let lastError: unknown = null;
        for (let i = 0; i < 100 && !response; i++) {
          try {
            response = await primary.fetchInKernel(PORT, REQUEST, {
              timeoutMs: 5_000,
            });
          } catch (e) {
            lastError = e;
            await pause(100);
          }
        }
        if (!response) {
          throw new Error(`the primary's fetch never succeeded: ${lastError}`);
        }
        expect(response.status).toBe(200);
        expect(await primaryExit).toBe(0);

        // The log carries the injection: the port, the peer port the primary
        // drew, and the raw request bytes.
        await until(
          () => published.some((entry) => entry.decision.kind === "http"),
          FOLLOW_LIMIT_MS,
          () => `the log holds ${published.length} entries and no http one`,
        );
        const injection = published.find(
          (entry) => entry.decision.kind === "http",
        )!.decision;
        if (injection.kind !== "http") throw new Error("unreachable");
        expect(injection.port).toBe(PORT);
        expect(injection.remotePort).toBeGreaterThan(1023);
        expect(new TextDecoder().decode(injection.request)).toContain(
          "GET /replicated HTTP/1.1",
        );

        // The queue is shared memory the kernel worker only reads when asked.
        replica.drainReplicationReplay();

        // The replica's server accepted the replayed injection and exited the
        // way the primary's did.
        expect(
          await Promise.race([
            replicaExit,
            pause(FOLLOW_LIMIT_MS).then(() => "still parked" as const),
          ]),
        ).toBe(0);

        // A viewer's fetch on the replica reads the response this machine
        // computed for the replayed injection. It does not inject: the
        // single-shot server is gone, so a live injection could only fail.
        const replayed = await replica.fetchInKernel(PORT, REQUEST, {
          timeoutMs: 5_000,
        });
        expect(replayed.status).toBe(200);
        expect(new TextDecoder().decode(replayed.body)).toBe(
          new TextDecoder().decode(response.body),
        );

        await stopStream();
        writer.end();
        const progress = await replica.stopReplicationReplay();
        expect(progress.consumed).toBeGreaterThan(0);
      } finally {
        writer.end();
        await replica?.destroy();
        await primary.destroy();
      }
    },
  );
});
