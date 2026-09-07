import { expect, test, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Phase 6 D6.5 (browser parity): the browser analogue of the Node live proof
// `host/test/funcref-fork-module-worker.test.ts`. A fork-instrumented guest
// loads a funcref into a LOCAL live across `fork()`, and the fresh CHILD calls
// the reconstructed funcref inside a REAL browser BrowserKernel worker with the
// co-resident `fork-module` ENABLED. It asserts:
//
//   (a) CORRECTNESS: the child calls the reconstructed funcref and the program
//       exits 0 (a wrong/absent reconstruction traps or exits nonzero, which the
//       parent turns into exit 92).
//   (b) PROOF OF USE: the child worker reports `fork_module_references=<n>` with
//       n > 0, forwarded by the browser kernel worker as a `fork-module` host
//       diagnostic — the module drove the reference reconstruction, not the JS
//       fallback.
//
// This is the CLAUDE.md-required browser proof for the module-driven reference
// path, absent since D5 (whose browser spec only covered `d_01`, no references).

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../../..");
const browserKernelModulePath = resolve(
  __dirname,
  "../../../host/src/browser-kernel-host.ts",
);
const memoryFsModulePath = resolve(
  __dirname,
  "../../../host/src/vfs/memory-fs.ts",
);
const fixtureSource = resolve(
  __dirname,
  "../../../host/test/fixtures/funcref-local-fork-fresh-worker.wat",
);
const instrumenter = resolve(
  __dirname,
  "../../../tools/bin/wasm-fork-instrument",
);

const ARGV0 = "funcref-local-fork-fresh-worker";

interface BrowserForkModuleResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  diagnostics: Array<{ source: string; message: string }>;
}

// Build the fork-instrumented fixture UNDER repoRoot so Vite's `@fs` (fs.allow
// includes repoRoot) will serve it. Kept in `local-binaries/` (gitignored build
// tree), cleaned up after the run.
let workDir = "";
let programPath = "";

test.beforeAll(() => {
  workDir = mkdtempSync(join(repoRoot, "local-binaries", "kandelo-funcref-browser-"));
  const rawPath = join(workDir, "funcref-local-fork-fresh-worker.raw.wasm");
  programPath = join(workDir, "funcref-local-fork-fresh-worker.wasm");
  execFileSync("wat2wasm", [
    "--enable-exceptions",
    "--enable-threads",
    fixtureSource,
    "-o",
    rawPath,
  ]);
  execFileSync(instrumenter, [rawPath, "-o", programPath]);
});

test.afterAll(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

async function runFuncrefFork(
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
      const hasForkModuleReferenceDiagnostic = () =>
        diagnostics.some(
          (d) =>
            d.source === "fork-module" &&
            /fork_module_references=/.test(d.message),
        );
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
        // A minimal image keeps this a BrowserKernel integration proof; the
        // fixture is self-contained and needs no rootfs.
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

        // The child posts its `fork_module_references` proof-of-use AFTER the
        // guest's exit resolves `spawn`; give that best-effort diagnostic a
        // bounded window to arrive before teardown.
        const started = Date.now();
        const windowMs = 8_000;
        while (Date.now() - started < windowMs) {
          if (hasForkModuleReferenceDiagnostic()) break;
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
      fixtureUrl: asViteFsUrl(programPath),
      argv0: ARGV0,
    },
  );
}

/**
 * Read the co-resident fork-module's funcref REFERENCE proof-of-use diagnostic
 * (`fork_module_references=<n>`), forwarded by the browser kernel worker.
 */
function moduleReferencesReconstructed(
  diagnostics: readonly { source: string; message: string }[],
): number | null {
  for (const diagnostic of diagnostics) {
    if (diagnostic.source !== "fork-module") continue;
    const match = /fork_module_references=(\d+)/.exec(diagnostic.message);
    if (match) return Number(match[1]);
  }
  return null;
}

test("Chromium drives a carried funcref reconstruction through the module", async ({
  page,
  baseURL,
  browserName,
}) => {
  test.skip(browserName !== "chromium", "the aggregate browser gate uses Chromium");
  test.setTimeout(180_000);
  expect(baseURL).toBeTruthy();

  const result = await runFuncrefFork(page, baseURL!);

  // (a) CORRECTNESS: the child called the reconstructed funcref and exited 0.
  expect(
    result.exitCode,
    `funcref fork exited unexpectedly\n${JSON.stringify(result, null, 2)}`,
  ).toBe(0);
  // (b) PROOF OF USE: the module reconstructed the carried funcref.
  const references = moduleReferencesReconstructed(result.diagnostics);
  expect(
    references,
    `expected a fork-module funcref proof-of-use diagnostic; the module did ` +
      `not drive the reference reconstruction\n${JSON.stringify(result, null, 2)}`,
  ).not.toBeNull();
  expect(references!).toBeGreaterThan(0);
});
