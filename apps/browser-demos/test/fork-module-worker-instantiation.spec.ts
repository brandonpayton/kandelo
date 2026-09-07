import { expect, test, type Page } from "@playwright/test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveBinary } from "../../../host/src/binary-resolver";

// Phase 6 D5 (browser parity): prove the co-resident `fork-module` drives a
// qualifying fork inside a REAL browser BrowserKernel worker when the host is
// constructed with `forkModuleEnabled`, exactly mirroring the Node parity test
// `host/test/fork-module-worker-instantiation.test.ts`. A default (flag-off)
// boot must stay byte-identical: no fork-module artifact fetch, no module
// compile, and no proof-of-use diagnostic.

const __dirname = dirname(fileURLToPath(import.meta.url));
const browserKernelModulePath = resolve(
  __dirname,
  "../../../host/src/browser-kernel-host.ts",
);
const memoryFsModulePath = resolve(
  __dirname,
  "../../../host/src/vfs/memory-fs.ts",
);

const FIXTURE = "programs/d_01_single_fork.wasm";
const EXPECT = ["PRE_FORK", "CHILD: ok", "PASS: D-01"];

interface BrowserForkModuleResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  diagnostics: Array<{ source: string; message: string }>;
}

async function runSingleFork(
  page: Page,
  baseURL: string,
): Promise<BrowserForkModuleResult> {
  const asViteFsUrl = (path: string) => new URL(`/@fs/${path}`, baseURL).href;

  await page.goto(new URL("/trap-signal-test.html", baseURL).href);
  return page.evaluate(
    async ({
      browserKernelModuleUrl,
      memoryFsModuleUrl,
      fixtureUrl,
      argv0,
    }) => {
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
      const hasForkModuleDiagnostic = () =>
        diagnostics.some((d) => d.source === "fork-module");
      const kernel = new BrowserKernel({
        maxWorkers: 4,
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
        // A minimal image keeps this a BrowserKernel integration proof without
        // coupling it to the much larger shell image; d_01 is a self-contained
        // single-fork fixture that needs no rootfs.
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
        const exitCode = await kernel.spawn(await response.arrayBuffer(), [
          argv0,
        ]);

        // The browser reports process exit via kernel-owned exit handling as
        // soon as the guest calls SYS_exit_group, which resolves `spawn` BEFORE
        // the parent worker finishes its post-guest JS and posts the fork-module
        // proof-of-use frame count. Give that best-effort diagnostic a bounded
        // window to arrive before teardown so the test observes the real
        // module-drove-the-fork evidence rather than racing the worker. Poll up
        // to 8s for the proof-of-use diagnostic.
        const started = Date.now();
        const windowMs = 8_000;
        while (Date.now() - started < windowMs) {
          if (hasForkModuleDiagnostic()) break;
          await new Promise((r) => setTimeout(r, 50));
        }
        return { exitCode, stdout, stderr, diagnostics };
      } finally {
        if (initialized) await kernel.destroy();
      }
    },
    {
      browserKernelModuleUrl: asViteFsUrl(browserKernelModulePath),
      memoryFsModuleUrl: asViteFsUrl(memoryFsModulePath),
      fixtureUrl: asViteFsUrl(resolveBinary(FIXTURE)),
      argv0: FIXTURE,
    },
  );
}

/**
 * Read the co-resident fork-module's proof-of-use diagnostic. The parent worker
 * posts `fork_module_frames=<n>` after a qualifying fork; the browser kernel
 * worker forwards it as a `fork-module` host diagnostic. Returns the committed
 * frame count, or `null` when the module never drove a fork.
 */
function moduleFramesCommitted(
  diagnostics: readonly { source: string; message: string }[],
): number | null {
  for (const diagnostic of diagnostics) {
    if (diagnostic.source !== "fork-module") continue;
    const match = /fork_module_frames=(\d+)/.exec(diagnostic.message);
    if (match) return Number(match[1]);
  }
  return null;
}

test("Chromium drives a qualifying fork through the co-resident module", async ({
  page,
  baseURL,
  browserName,
}) => {
  test.skip(browserName !== "chromium", "the aggregate browser gate uses Chromium");
  test.setTimeout(180_000);
  expect(baseURL).toBeTruthy();

  const result = await runSingleFork(page, baseURL!);

  expect(
    result.exitCode,
    `fork exited unexpectedly\n${JSON.stringify(result, null, 2)}`,
  ).toBe(0);
  for (const fragment of EXPECT) {
    expect(result.stdout).toContain(fragment);
  }
  // PROOF the module actually served the fork: the parent worker reported a
  // nonzero committed-frame count, forwarded by the browser kernel worker as a
  // `fork-module` diagnostic.
  const frames = moduleFramesCommitted(result.diagnostics);
  expect(
    frames,
    `expected a fork-module proof-of-use diagnostic; the module did not drive ` +
      `the fork\n${JSON.stringify(result, null, 2)}`,
  ).not.toBeNull();
  expect(frames!).toBeGreaterThan(0);
});
