/**
 * Checkpoint validation against a real captured machine.
 *
 * Every corruption case starts from a genuine `captureCheckpointBytes` result,
 * so a refusal proves the validator catches the corruption rather than an
 * artifact of a hand-built fixture. The pristine clone validates at the end,
 * which proves the refusals came from the corruption alone.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NodeKernelHost } from "../../src/node-kernel-host";
import { findRepoRoot } from "../../src/binary-resolver";
import { ABI_VERSION } from "../../src/generated/abi";
import { FORK_SAVE_BUFFER_SIZE } from "../../src/process-memory";
import type { MachineCheckpoint } from "../../src/migration/checkpoint";
import {
  CheckpointRefusedError,
  validateMachineCheckpoint,
} from "../../src/migration/restore";

const TIMEOUTS = { unwindTimeoutMs: 10_000, vforkTimeoutMs: 5_000 };
const EXPECTED = { kernelAbiVersion: ABI_VERSION };

function programBytes(name: string): ArrayBuffer {
  const bytes = readFileSync(join(findRepoRoot(), "examples", name));
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

async function captureRealCheckpoint(): Promise<MachineCheckpoint> {
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
  try {
    await new Promise<void>((resolve) => {
      void host.spawn(programBytes("checkpoint-loop.wasm"), [
        "checkpoint-loop",
      ], { onStarted: () => resolve() });
    });
    await isReady;
    const response = await host.captureCheckpointBytes(TIMEOUTS);
    if (response.status !== "captured") {
      throw new Error(`capture failed: ${JSON.stringify(response)}`);
    }
    return response.checkpoint;
  } finally {
    await host.destroy();
  }
}

/** Deep copy so each corruption starts from the same captured machine. */
function cloneCheckpoint(checkpoint: MachineCheckpoint): MachineCheckpoint {
  return structuredClone(checkpoint);
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

describe("checkpoint validation", () => {
  it(
    "accepts a captured machine and refuses every corruption of it",
    { timeout: 60_000 },
    async () => {
      const captured = await captureRealCheckpoint();

      await expect(
        validateMachineCheckpoint(cloneCheckpoint(captured), EXPECTED),
      ).resolves.toEqual(
        new Map(
          captured.processes.map((bucket) => [
            bucket.pid,
            expect.any(WebAssembly.Module),
          ]),
        ),
      );

      const refusal = async (
        corrupt: (checkpoint: Mutable<MachineCheckpoint>) => void,
        reason: string | RegExp,
      ) => {
        const checkpoint = cloneCheckpoint(captured) as
          Mutable<MachineCheckpoint>;
        corrupt(checkpoint);
        const attempt = validateMachineCheckpoint(checkpoint, EXPECTED);
        await expect(attempt).rejects.toThrow(CheckpointRefusedError);
        await expect(attempt).rejects.toThrow(reason);
      };

      await refusal((checkpoint) => {
        (checkpoint as { format: number }).format = 999;
      }, "unknown checkpoint format 999");

      await refusal((checkpoint) => {
        (checkpoint as { kernelAbiVersion: number }).kernelAbiVersion =
          ABI_VERSION + 1;
      }, `kernel ABI ${ABI_VERSION + 1} does not match`);

      await refusal((checkpoint) => {
        (checkpoint as { kernelMemory: Uint8Array }).kernelMemory =
          checkpoint.kernelMemory.subarray(0, 100);
      }, "not a whole number of pages");

      await refusal((checkpoint) => {
        (checkpoint as { filesystem: Uint8Array }).filesystem =
          new Uint8Array(0);
      }, "the filesystem buffer is empty");

      await refusal((checkpoint) => {
        (checkpoint as { processes: unknown[] }).processes = [
          checkpoint.processes[0]!,
          checkpoint.processes[0]!,
        ];
      }, /appears in more than one process bucket/);

      await refusal((checkpoint) => {
        const bucket = checkpoint.processes[0]! as { memory: Uint8Array };
        bucket.memory = bucket.memory.subarray(1);
      }, /does not cover its whole buffer/);

      await refusal((checkpoint) => {
        const bucket = checkpoint.processes[0]! as { ptrWidth: number };
        bucket.ptrWidth = 5;
      }, /claims pointer width 5/);

      await refusal((checkpoint) => {
        const bucket = checkpoint.processes[0]! as { ptrWidth: number };
        bucket.ptrWidth = 8;
      }, /pointer width 8 but its program declares 4/);

      await refusal((checkpoint) => {
        const bucket = checkpoint.processes[0]! as {
          programBytes: ArrayBuffer;
        };
        bucket.programBytes = new Uint8Array([1, 2, 3, 4]).buffer;
      }, /is not a WebAssembly module/);

      await refusal((checkpoint) => {
        const bucket = checkpoint.processes[0]! as {
          programBytes: ArrayBuffer;
        };
        // Magic and version only: a valid module with no capability claim.
        bucket.programBytes =
          new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]).buffer;
      }, /does not claim activation-state-safe replay/);

      await refusal((checkpoint) => {
        const bucket = checkpoint.processes[0]! as { channelOffset: number };
        bucket.channelOffset = checkpoint.processes[0]!.memory.byteLength;
      }, /does not fit inside/);

      await refusal((checkpoint) => {
        const bucket = checkpoint.processes[0]!;
        new DataView(bucket.memory.buffer).setUint32(
          bucket.channelOffset - FORK_SAVE_BUFFER_SIZE,
          7,
          true,
        );
      }, /continuation root is unusable/);

      // The corruptions above never touched the captured object itself.
      await expect(
        validateMachineCheckpoint(cloneCheckpoint(captured), EXPECTED),
      ).resolves.toBeDefined();
    },
  );
});
