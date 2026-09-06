/**
 * Machine checkpoint against processes that keep replacing themselves.
 *
 * An execve retires the process's instance and channel, and the next image
 * opens a new one only at its first syscall. A freeze that meets the pid
 * inside that window has nothing to park, and the browser suite observed the
 * aftermath as workers dying with "checkpoint import reached while process
 * continuation is capture". This file holds machines under repeated captures
 * while guests re-exec forever, and requires every round to leave a machine
 * that still runs.
 */
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeKernelHost } from "../../src/node-kernel-host";
import { findRepoRoot } from "../../src/binary-resolver";

const TIMEOUTS = { unwindTimeoutMs: 10_000, vforkTimeoutMs: 5_000 };
const CAPTURE_ROUNDS = 12;

function buildStormFixture(name: string): Uint8Array {
  const buildDir = join(tmpdir(), "wasm-checkpoint-exec");
  mkdirSync(buildDir, { recursive: true });
  const wasmPath = join(buildDir, `${name}.wasm`);
  execFileSync(
    "wasm32posix-cc",
    [
      join(findRepoRoot(), `host/test/fixtures/${name}.c`),
      "-o",
      wasmPath,
    ],
    { stdio: "pipe" },
  );
  execFileSync(
    "bash",
    [
      join(findRepoRoot(), "scripts/run-wasm-fork-instrument.sh"),
      wasmPath,
      "-o",
      wasmPath,
    ],
    { stdio: "pipe" },
  );
  return new Uint8Array(readFileSync(wasmPath));
}

async function waitFor(
  condition: () => boolean,
  what: string,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

interface StormMachine {
  host: NodeKernelHost;
  failures: string[];
  progressCount: () => number;
}

async function startStorm(
  fixture: string,
  progressMarker: string,
): Promise<StormMachine> {
  const failures: string[] = [];
  let output = "";
  const host = new NodeKernelHost({
    rootfsImage: "default",
    onStdout: (_pid, data) => {
      output += new TextDecoder().decode(data);
    },
    onHostDiagnostic: (diagnostic) => {
      failures.push(diagnostic.message);
    },
  });
  await host.init();
  const guestPath = `/tmp/${fixture}.wasm`;
  await host.writeFileToVfs(guestPath, buildStormFixture(fixture), 0o755);
  void host.spawnFromVfs(guestPath, [guestPath]);
  await waitFor(() => output.includes("READY"), `${fixture}'s first image`);
  return {
    host,
    failures,
    progressCount: () =>
      output.split("\n").filter((line) => line.startsWith(progressMarker))
        .length,
  };
}

async function captureRounds(machine: StormMachine): Promise<void> {
  for (let round = 0; round < CAPTURE_ROUNDS; round++) {
    const response = await machine.host.captureCheckpoint(TIMEOUTS);
    expect(
      response.status,
      `round ${round}: ${JSON.stringify(response)}`,
    ).toBe("captured");
    const before = machine.progressCount();
    await waitFor(
      () => machine.progressCount() > before,
      `progress after capture round ${round}`,
    );
    expect(machine.failures, `after capture round ${round}`).toEqual([]);
  }
}

describe("machine checkpoint during an exec storm", () => {
  it(
    "leaves a running machine after every capture of a re-execing process",
    { timeout: 240_000 },
    async () => {
      const machine = await startStorm("exec-storm", "GEN ");
      try {
        await captureRounds(machine);
      } finally {
        await machine.host.destroy();
      }
    },
  );

  it(
    "leaves a running machine after every capture of a forking supervisor",
    { timeout: 240_000 },
    async () => {
      const machine = await startStorm("fork-exec-storm", "ROUND ");
      try {
        await captureRounds(machine);
      } finally {
        await machine.host.destroy();
      }
    },
  );

  it(
    "leaves a recording machine after every replication join of a forking supervisor",
    { timeout: 240_000 },
    async () => {
      const machine = await startStorm("fork-exec-storm", "ROUND ");
      try {
        for (let round = 0; round < CAPTURE_ROUNDS; round++) {
          const joined = await machine.host.captureAndStreamReplicationLog(
            TIMEOUTS,
            () => {},
          );
          const capture = joined.capture;
          expect(
            capture.status === "captured"
              ? "captured"
              : `${capture.status}: ${capture.reason}`,
            `round ${round}`,
          ).toBe("captured");
          const before = machine.progressCount();
          await waitFor(
            () => machine.progressCount() > before,
            `progress while recording, round ${round}`,
          );
          await joined.stop();
          expect(machine.failures, `after join round ${round}`).toEqual([]);
        }
      } finally {
        await machine.host.destroy();
      }
    },
  );
});
