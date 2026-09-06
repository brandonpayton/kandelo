/**
 * A replica's kernel worker, reduced to the one thing under test: it blocks.
 *
 * `ReplicationLogQueueReader.take` parks on `Atomics.wait`, which a Node main
 * thread would serve by stalling the test that has to write the entry. The
 * reader therefore has to run somewhere else, the way it runs on a real
 * machine.
 */
import { parentPort, workerData } from "node:worker_threads";
import { ReplicationLogQueueReader } from "../../src/replication/log-queue";
import type { ReplicationLogEntry } from "../../src/replication/log";

const { queue, count } = workerData as {
  queue: SharedArrayBuffer;
  count: number;
};

const reader = new ReplicationLogQueueReader(queue);
// Said before the first take, so a test measuring the block measures the
// block and not this thread starting up.
parentPort!.postMessage({ kind: "parked" });

const startedAt = Date.now();
const taken: (ReplicationLogEntry | null)[] = [];
for (let at = 0; at < count; at++) taken.push(reader.take());

parentPort!.postMessage({ kind: "taken", taken, waitedMs: Date.now() - startedAt });
