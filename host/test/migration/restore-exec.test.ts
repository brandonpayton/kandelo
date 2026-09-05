/**
 * Restore side of the exec/capture race.
 *
 * checkpoint-exec.test.ts proves the PRIMARY survives captures that race an
 * exec. This file proves the RESTORED machine does too: each round captures
 * the storm mid-flight and boots a fresh machine from the checkpoint. A
 * capture that lands while the guest is inside _start's argv/environ
 * marshalling must restore into a guest that finishes _start: the resumed
 * copy loops re-read the worker's startup imports, and the restored channel
 * must not carry the freeze's recalled unwind request.
 */
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeKernelHost } from "../../src/node-kernel-host";
import { findRepoRoot } from "../../src/binary-resolver";
import type { MachineCheckpoint } from "../../src/migration/checkpoint";

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

describe("machine restore during an exec storm", () => {
  for (const fixture of ["exec-restore-storm", "exec-storm"]) {
  it(
    `restored machines carry on a guest captured mid-exec (${fixture})`,
    { timeout: 240_000 },
    async () => {
      let output = "";
      const primaryFailures: string[] = [];
      const host = new NodeKernelHost({
        rootfsImage: "default",
        onStdout: (_pid, data) => {
          output += new TextDecoder().decode(data);
        },
        onHostDiagnostic: (diagnostic) => {
          primaryFailures.push(diagnostic.message);
        },
      });
      await host.init();
      // On /, a captured mount: a Node restore truthfully drops the
      // host-backed scratch mounts, and a storm parked under /tmp could
      // never find its own binary for the next exec.
      const guestPath = `/${fixture}.wasm`;
      await host.writeFileToVfs(
        guestPath,
        buildStormFixture(fixture),
        0o755,
      );
      void host.spawnFromVfs(guestPath, [guestPath]);
      await waitFor(() => output.includes("READY"), "the storm's first image");

      const trapRounds: string[] = [];
      try {
        for (let round = 0; round < CAPTURE_ROUNDS; round++) {
          const response = await host.captureCheckpointBytes(TIMEOUTS);
          expect(
            response.status,
            `round ${round}: ${JSON.stringify(response)}`,
          ).toBe("captured");
          const checkpoint = (response as { checkpoint: MachineCheckpoint })
            .checkpoint;

          let restoredOutput = "";
          const restoredEvents: string[] = [];
          const restoredFailures: string[] = [];
          const replica = new NodeKernelHost({
            rootfsImage: "default",
            restoreCheckpoint: checkpoint,
            onStdout: (_pid, data) => {
              restoredOutput += new TextDecoder().decode(data);
            },
            onStderr: (_pid, data) => {
              restoredOutput += new TextDecoder().decode(data);
            },
            onProcessEvent: (event) => {
              restoredEvents.push(`${event.kind}:${event.pid}`);
            },
            onHostDiagnostic: (diagnostic) => {
              // A Node restore truthfully reports host-backed mounts it could
              // not carry; that boundary is not the defect under test.
              if (diagnostic.message.startsWith("this machine was restored without")) {
                return;
              }
              restoredFailures.push(diagnostic.message);
            },
          });
          await replica.init();
          try {
            const progressed = await waitFor(
              () => (restoredOutput.match(/^GEN /gm)?.length ?? 0) >= 2,
              `restored progress, round ${round}`,
            ).then(() => true, (e) => {
              trapRounds.push(
                `round ${round}: ${e}; output=${JSON.stringify(restoredOutput.slice(-120))}; `
                + `events=${JSON.stringify(restoredEvents.slice(0, 8))}; `
                + `diagnostics=${JSON.stringify(restoredFailures)}`,
              );
              return false;
            });
            if (progressed && restoredFailures.length > 0) {
              trapRounds.push(
                `round ${round}: diagnostics=${JSON.stringify(restoredFailures)}`,
              );
            }
          } finally {
            await replica.destroy();
          }
        }
      } finally {
        await host.destroy();
      }

      expect(primaryFailures).toEqual([]);
      expect(trapRounds, trapRounds.join("\n")).toEqual([]);
    },
  );
  }
});
