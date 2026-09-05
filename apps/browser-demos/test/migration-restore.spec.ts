import { expect, test, type Page } from "@playwright/test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveBinary } from "../../../host/src/binary-resolver";
import { doomSharewareWad } from "../../../host/test/support/doom-shareware";

const __dirname = dirname(fileURLToPath(import.meta.url));
const examplesDir = resolve(__dirname, "../../../examples");

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

async function openTestRunner(page: Page, baseURL: string): Promise<void> {
  await page.goto(new URL("/pages/test-runner/?minimal=1", baseURL).href);
  await page.waitForFunction(() => (window as any).__testRunnerReady === true);
}

async function runMigrationRestore(
  page: Page,
  baseURL: string,
  programPath: string,
  argv: string[],
  options: {
    dataFiles?: { path: string; base64: string }[];
    env?: string[];
    pty?: boolean;
    readyMarker: string;
    settleMs?: number;
  },
): Promise<MigrationRestoreResult> {
  const programUrl = new URL(`/@fs/${programPath}`, baseURL).href;
  return page.evaluate(
    async ({ programUrl, argv, options }) => {
      const response = await fetch(programUrl);
      if (!response.ok) {
        throw new Error(`program fetch failed: ${response.status}`);
      }
      return (window as any).__runMigrationRestoreTest(
        await response.arrayBuffer(),
        argv,
        options,
      );
    },
    { programUrl, argv, options },
  );
}

test("restores a checkpointed process that keeps running", async ({
  page,
  baseURL,
}) => {
  test.setTimeout(180_000);
  expect(baseURL).toBeTruthy();
  await openTestRunner(page, baseURL!);

  const result = await runMigrationRestore(
    page,
    baseURL!,
    resolve(examplesDir, "checkpoint-loop.wasm"),
    ["checkpoint-loop"],
    { readyMarker: "READY" },
  );

  expect(result.signaled, result.output).toBe(true);
  expect(result.recaptured.pids).toEqual(result.captured.pids);
});

test("restores a checkpointed process whose pthread keeps running", async ({
  page,
  baseURL,
}) => {
  test.setTimeout(180_000);
  expect(baseURL).toBeTruthy();
  await openTestRunner(page, baseURL!);

  const result = await runMigrationRestore(
    page,
    baseURL!,
    resolve(examplesDir, "checkpoint-threads.wasm"),
    ["checkpoint-threads"],
    { readyMarker: "READY" },
  );

  expect(result.captured.threads.length).toBe(1);
  const capturedThreads = result.captured.threads[0]!;
  expect(capturedThreads.activeCount).toBeGreaterThan(0);
  expect(capturedThreads.tids.length).toBe(capturedThreads.activeCount);

  expect(result.signaled, result.output).toBe(true);
  expect(result.recaptured.pids).toEqual(result.captured.pids);
  // A capture completes only when every task of the process unwinds again,
  // so a recapture carrying the same TIDs proves the restored pthread
  // genuinely resumed alongside the main thread.
  expect(result.recaptured.threads[0]!.tids).toEqual(capturedThreads.tids);
});

test("restores a running fbDOOM that keeps playing", async ({
  page,
  baseURL,
}) => {
  test.setTimeout(300_000);
  expect(baseURL).toBeTruthy();

  let wad: Uint8Array;
  try {
    wad = await doomSharewareWad();
  } catch {
    test.skip(true, "doom1.wad unavailable (offline) — fbDOOM can't run");
    return;
  }

  await openTestRunner(page, baseURL!);

  const result = await runMigrationRestore(
    page,
    baseURL!,
    resolveBinary("programs/fbdoom.wasm"),
    ["fbdoom", "-iwad", "/doom1.wad"],
    {
      dataFiles: [
        { path: "/doom1.wad", base64: Buffer.from(wad).toString("base64") },
      ],
      env: ["AUDIODEV=/nonexistent-dsp"],
      pty: true,
      readyMarker: "ST_Init",
      settleMs: 1_500,
    },
  );

  expect(result.signaled, result.output).toBe(true);
  // The game keeps playing only if it keeps crossing syscall boundaries
  // every tic; a capture completes only then, so a captured recapture is
  // the proof the demo loop resumed.
  expect(result.recaptured.pids).toEqual(result.captured.pids);
});
