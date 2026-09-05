import { expect, test, type Page } from "@playwright/test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveBinary } from "../../../host/src/binary-resolver";
import { doomSharewareWad } from "../../../host/test/support/doom-shareware";

const __dirname = dirname(fileURLToPath(import.meta.url));
const examplesDir = resolve(__dirname, "../../../examples");

interface MachineCheckpointThreadsSummary {
  mounts: string[];
  unreadableMounts: string[];
  pids: number[];
  threads: { pid: number; tids: number[]; activeCount: number }[];
}

interface MigrationRestoreResult {
  captured: MachineCheckpointThreadsSummary;
  outputAtCapture: string;
  signaled?: boolean;
  recaptured?: MachineCheckpointThreadsSummary;
  framebuffers?: { pid: number; w: number; h: number; hostBufferNonZero: boolean }[];
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
    rootfsMountSpec?: { path: string; source: "image"; readonly: boolean }[];
    finishMarker?: string;
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
  expect(result.recaptured!.pids).toEqual(result.captured.pids);
  // The browser backs every mount with a MemoryFileSystem, so a browser
  // machine moves whole. Node backs all but `/` with a host directory and
  // records the seven it left behind. Same code, different mount topology.
  expect(result.captured.mounts).toEqual([
    "/",
    "/tmp",
    "/var/tmp",
    "/var/log",
    "/var/run",
    "/home/maker",
    "/root",
    "/srv",
  ]);
  expect(result.captured.unreadableMounts).toEqual([]);
  expect(result.hostDiagnostics.filter((d) => d.startsWith("checkpoint restore")))
    .toEqual([]);
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
  expect(result.recaptured!.pids).toEqual(result.captured.pids);
  // A capture completes only when every task of the process unwinds again,
  // so a recapture carrying the same TIDs proves the restored pthread
  // genuinely resumed alongside the main thread.
  expect(result.recaptured!.threads[0]!.tids).toEqual(capturedThreads.tids);
});

test("restores a file mid-write, a directory mid-iteration, and a pending alarm", async ({
  page,
  baseURL,
}) => {
  test.setTimeout(180_000);
  expect(baseURL).toBeTruthy();
  await openTestRunner(page, baseURL!);

  const result = await runMigrationRestore(
    page,
    baseURL!,
    resolve(examplesDir, "checkpoint-handles.wasm"),
    ["checkpoint-handles"],
    {
      readyMarker: "READY",
      finishMarker: "ALARM OK",
      // The fixture needs a writable root: a checkpoint carries the
      // image-backed root filesystem, and scratch mounts do not travel.
      rootfsMountSpec: [{ path: "/", source: "image", readonly: false }],
    },
  );

  expect(result.outputAtCapture, result.output).not.toContain("OK");
  expect(result.output).toContain("MONO OK");
  expect(result.output).toContain("FILE OK");
  expect(result.output).toContain("DIR OK");
  expect(result.output).toContain("ALARM OK");
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
  expect(result.recaptured!.pids).toEqual(result.captured.pids);
  // The receiver's main-thread framebuffer mirror — the seam the canvas
  // renderer draws from — carries the rebound binding with real pixels.
  expect(result.framebuffers).toEqual([
    {
      pid: result.captured.pids[0],
      w: expect.any(Number),
      h: expect.any(Number),
      hostBufferNonZero: true,
    },
  ]);
});
