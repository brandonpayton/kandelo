import { expect, test, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveBinary } from "../../../host/src/binary-resolver";
import { ABI_VERSION } from "../../../host/src/generated/abi";
import { buildAbiStampedFixture } from "../../../host/test/fixtures/abi-stamped-wat";
import {
  rawGcReferenceStateFreshWorkerBytes,
} from "../../../host/test/fixtures/gc-reference-state-fresh-worker-bytes";

const __dirname = dirname(fileURLToPath(import.meta.url));
const browserKernelModulePath = resolve(
  __dirname,
  "../../../host/src/browser-kernel-host.ts",
);
const memoryFsModulePath = resolve(
  __dirname,
  "../../../host/src/vfs/memory-fs.ts",
);
const catchRefFixtureSource = resolve(
  __dirname,
  "../../../host/test/fixtures/catch-ref-fresh-worker.wat",
);
const referenceCatchPayloadFixtureSource = resolve(
  __dirname,
  "../../../host/test/fixtures/reference-catch-payload-fresh-worker.wat",
);
const forkInstrumenterPath = resolve(
  __dirname,
  "../../../tools/bin/wasm-fork-instrument",
);

interface BrowserFixtureResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  diagnostics: Array<{ source: string; message: string }>;
}

async function runBrowserFixture(
  page: Page,
  baseURL: string,
  fixturePath: string,
  argv0: string,
  maxMemoryPages?: number,
): Promise<BrowserFixtureResult> {
  const asViteFsUrl = (path: string) =>
    new URL(`/@fs/${path}`, baseURL).href;

  await page.goto(new URL("/trap-signal-test.html", baseURL).href);
  return page.evaluate(
    async ({
      browserKernelModuleUrl,
      memoryFsModuleUrl,
      fixtureUrl,
      argv0,
      maxMemoryPages,
    }) => {
      // WHY: BrowserKernel already imports MemoryFileSystem. Loading the host
      // entry first avoids asking a cold Vite server to optimize the same
      // dependency graph through two concurrent dynamic imports.
      const { BrowserKernel } = await import(
        /* @vite-ignore */ browserKernelModuleUrl
      );
      const { MemoryFileSystem } = await import(
        /* @vite-ignore */ memoryFsModuleUrl
      );
      const decoder = new TextDecoder();
      let stdout = "";
      let stderr = "";
      const diagnostics: Array<{ source: string; message: string }> = [];
      const kernel = new BrowserKernel({
        maxWorkers: 4,
        ...(maxMemoryPages === undefined ? {} : { maxMemoryPages }),
        onStdout: (data: Uint8Array) => {
          stdout += decoder.decode(data);
        },
        onStderr: (data: Uint8Array) => {
          stderr += decoder.decode(data);
        },
        onHostDiagnostic: (diagnostic: { source: string; message: string }) => {
          diagnostics.push({
            source: diagnostic.source,
            message: diagnostic.message,
          });
        },
      });
      let initialized = false;

      try {
        // WHY: these fixtures do not use files. A minimal image keeps this a
        // BrowserKernel integration proof without coupling it to the much
        // larger shell image or its package publication state.
        const imageOwner = MemoryFileSystem.create(
          new SharedArrayBuffer(1024 * 1024),
        );
        const vfsImage = await imageOwner.saveImage();
        await kernel.initFromImage({ vfsImage });
        initialized = true;

        const response = await fetch(fixtureUrl);
        if (!response.ok) {
          throw new Error(
            `fixture fetch failed: ${response.status} ${fixtureUrl}`,
          );
        }
        const exitCode = await kernel.spawn(
          await response.arrayBuffer(),
          [argv0],
        );
        return { exitCode, stdout, stderr, diagnostics };
      } finally {
        if (initialized) await kernel.destroy();
      }
    },
    {
      browserKernelModuleUrl: asViteFsUrl(browserKernelModulePath),
      memoryFsModuleUrl: asViteFsUrl(memoryFsModulePath),
      fixtureUrl: asViteFsUrl(fixturePath),
      argv0,
      maxMemoryPages,
    },
  );
}

test("Chromium grows and replays a continuation beyond ABI 41's fixed reserve", async ({
  page,
  baseURL,
  browserName,
}) => {
  test.skip(browserName !== "chromium", "the aggregate browser gate uses Chromium");
  test.setTimeout(180_000);
  expect(baseURL).toBeTruthy();

  const result = await runBrowserFixture(
    page,
    baseURL!,
    resolveBinary("programs/p_10_deep_linked_continuation.wasm"),
    "p_10_deep_linked_continuation",
  );

  expect(result.exitCode, JSON.stringify(result, null, 2)).toBe(0);
  expect(result.stdout).toContain("PRE_DEEP_FORK");
  expect(result.stdout).toContain("DEEP_CHILD: ok");
  expect(result.stdout).toContain("DEEP_PARENT: child=");
  expect(result.stdout).toContain("PASS: P-10");
  expect(result.stderr).toBe("");
  expect(result.diagnostics).toEqual([]);
});

test("Chromium preserves the parent across root and later continuation ENOMEM", async ({
  page,
  baseURL,
  browserName,
}) => {
  test.skip(browserName !== "chromium", "the aggregate browser gate uses Chromium");
  test.setTimeout(180_000);
  expect(baseURL).toBeTruthy();

  const result = await runBrowserFixture(
    page,
    baseURL!,
    resolveBinary("programs/p_11_fork_continuation_enomem.wasm"),
    "p_11_fork_continuation_enomem",
    // Keep the exhaustion loop bounded while leaving enough initial pages for
    // the program and BrowserKernel-owned channel/control memory.
    384,
  );

  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("ROOT_CONTINUATION_ENOMEM: ok");
  expect(result.stdout).toContain("ROOT_NO_PHANTOM_CHILD: ok");
  expect(result.stdout).toContain("ROOT_PARENT_USABLE: ok");
  expect(result.stdout).toContain("CONTINUATION_ENOMEM: ok");
  expect(result.stdout).toContain("NO_PHANTOM_CHILD: ok");
  expect(result.stdout).toContain("CONTINUATION_PAGE_REUSED: ok");
  expect(result.stdout).toContain("RECOVERY_CHILD: ok");
  expect(result.stdout).toContain("RECOVERY_PARENT: child=");
  expect(result.stdout).toContain("PASS: P-11");
  expect(result.stderr).toBe("");
  expect(result.diagnostics).toEqual([]);
});

test("Chromium reconstructs CatchRef state in a fresh child worker", async ({
  page,
  baseURL,
  browserName,
}) => {
  test.skip(browserName !== "chromium", "the aggregate browser gate uses Chromium");
  test.setTimeout(180_000);
  expect(baseURL).toBeTruthy();

  const workDir = mkdtempSync(
    // Vite deliberately refuses to serve arbitrary host temporary paths.
    // Keep this generated fixture under the checked-out test tree so the
    // browser receives bytes from this exact worktree's allow-listed root.
    resolve(__dirname, ".catch-ref-fresh-worker-"),
  );
  try {
    const programPath = buildAbiStampedFixture(
      catchRefFixtureSource,
      workDir,
      "catch-ref-fresh-worker",
      ABI_VERSION,
    );

    // The parent waits for the child, whose exit 91 means CatchRef payload
    // reconstruction failed after the browser worker instantiated a fresh
    // module. The parent reports that wait failure as exit 92.
    const result = await runBrowserFixture(
      page,
      baseURL!,
      programPath,
      "catch-ref-fresh-worker",
    );
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.diagnostics).toEqual([]);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

test("Chromium reconstructs reference-bearing catches in fresh child workers", async ({
  page,
  baseURL,
  browserName,
}) => {
  test.skip(browserName !== "chromium", "the aggregate browser gate uses Chromium");
  test.setTimeout(180_000);
  expect(baseURL).toBeTruthy();

  const workDir = mkdtempSync(
    resolve(__dirname, ".reference-catch-payload-fresh-worker-"),
  );
  try {
    const programPath = buildAbiStampedFixture(
      referenceCatchPayloadFixtureSource,
      workDir,
      "reference-catch-payload-fresh-worker",
      ABI_VERSION,
    );

    // One fresh child calls the reconstructed non-null funcref; a second
    // verifies the nullable externref path. Either child exits nonzero if its
    // caught exception recipe depended on the parent's module instance.
    const result = await runBrowserFixture(
      page,
      baseURL!,
      programPath,
      "reference-catch-payload-fresh-worker",
    );
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.diagnostics).toEqual([]);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

test("Chromium reconstructs aliased Wasm GC state in a fresh child worker", async ({
  page,
  baseURL,
  browserName,
}) => {
  test.skip(browserName !== "chromium", "the aggregate browser gate uses Chromium");
  test.setTimeout(180_000);
  expect(baseURL).toBeTruthy();

  const workDir = mkdtempSync(
    resolve(__dirname, ".gc-reference-state-fresh-worker-"),
  );
  try {
    const rawPath = resolve(workDir, "gc-reference-state.raw.wasm");
    const programPath = resolve(workDir, "gc-reference-state.wasm");
    writeFileSync(rawPath, rawGcReferenceStateFreshWorkerBytes(ABI_VERSION));
    execFileSync(forkInstrumenterPath, [rawPath, "-o", programPath]);

    // The child verifies one cyclic identity through a live parameter,
    // operand-stack carryover, mutable reference global, and mutated typed
    // table. Any fresh-instance alias break exits 91; its waiting parent then
    // exits 92.
    const result = await runBrowserFixture(
      page,
      baseURL!,
      programPath,
      "gc-reference-state-fresh-worker",
    );
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.diagnostics).toEqual([]);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});
