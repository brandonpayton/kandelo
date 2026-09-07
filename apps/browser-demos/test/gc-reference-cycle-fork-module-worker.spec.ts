import { expect, test, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { RAW_GC_REFERENCE_CYCLE_FRESH_WORKER_HEX } from "../../../host/test/fixtures/gc-reference-cycle-fresh-worker-bytes";

// Phase 6 item 3c (browser parity): the browser analogue of the Node live proof
// `host/test/gc-reference-cycle-fresh-worker.test.ts`. A fork-instrumented
// MULTI-NODE Wasm-GC guest (a struct<->array reference CYCLE plus an i31 leaf)
// forks, and the fresh CHILD reconstructs its typed-GC graph inside a REAL
// browser BrowserKernel worker with the co-resident `fork-module` ENABLED. On
// flag-on the child's typed reconstruction is DRIVEN by the module's
// `fm_build_gc_plan` + `fm_drive_execute` plan instead of the JS
// `materializeAllTyped` sub-loop. It asserts, in real Chromium:
//
//   (a) CORRECTNESS / PARITY — the child self-verifies every alias (reference
//       param carryover, mutable reference global, mutated reference table), the
//       struct<->array cycle (node.array[0] === node), the scalar struct field,
//       and the i31 leaf, then exits 0 exactly as the flag-off (JS typed path)
//       run does. A wrong or absent reconstruction makes the child exit nonzero,
//       which the parent turns into a nonzero exit.
//   (b) PROOF OF USE — two counters forwarded as `fork-module` host diagnostics:
//         * `gc_nodes_reconstructed=<n>` (n > 0): the graph was ADMITTED through
//           the module (the item 3a data feed).
//         * `drive_steps_executed=<n>` (n > 0): the module actually DROVE the
//           typed allocate/fill topological order (the item 3c DRIVE proof), in
//           place of the JS fallback. A silent JS fallback leaves this at zero.
//
// This closes the browser-validation gap on the item 3c production flip
// (Node-validated at commit 344ca9403 with drive_steps_executed=5): the typed-GC
// drive is now proven to run in a real browser, not just Node.

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
const instrumenter = resolve(
  __dirname,
  "../../../tools/bin/wasm-fork-instrument",
);

const ARGV0 = "gc-reference-cycle-fresh-worker";

interface BrowserForkModuleResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  diagnostics: Array<{ source: string; message: string }>;
}

// Build the fork-instrumented fixture UNDER repoRoot so Vite's `@fs` (fs.allow
// includes repoRoot) will serve it. The Wasm-GC source cannot be assembled by
// the dev shell's WABT (`wat2wasm` rejects `rec` groups / `ref.i31` /
// `array.new` / mutually recursive struct/array types), so — exactly as the
// Node fixture does — we write the reviewed `wat`-crate deterministic bytes and
// instrument those. Kept in `local-binaries/` (gitignored build tree), cleaned
// up after the run.
let workDir = "";
let programPath = "";

test.beforeAll(() => {
  workDir = mkdtempSync(
    join(repoRoot, "local-binaries", "kandelo-gc-cycle-browser-"),
  );
  const rawPath = join(workDir, "gc-reference-cycle.raw.wasm");
  programPath = join(workDir, "gc-reference-cycle.wasm");
  writeFileSync(
    rawPath,
    Buffer.from(RAW_GC_REFERENCE_CYCLE_FRESH_WORKER_HEX, "hex"),
  );
  execFileSync(instrumenter, [rawPath, "-o", programPath]);
});

test.afterAll(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

async function runGcCycleFork(
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
      // The item 3c DRIVE proof-of-use frame carries `drive_steps_executed=<n>`.
      const hasForkModuleDriveDiagnostic = () =>
        diagnostics.some(
          (d) =>
            d.source === "fork-module" &&
            /drive_steps_executed=/.test(d.message),
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

        // The child posts its typed-GC proof-of-use AFTER the guest's exit
        // resolves `spawn`; give that best-effort diagnostic a bounded window to
        // arrive before teardown.
        const started = Date.now();
        const windowMs = 8_000;
        while (Date.now() - started < windowMs) {
          if (hasForkModuleDriveDiagnostic()) break;
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
 * Read one kind of the co-resident fork-module's typed-GC proof-of-use, matching
 * the Node reader `host/test/fork-module-reference-proof.ts`. The CHILD worker
 * posts a single `fork-module` diagnostic listing every kind's count; `gc` is
 * the graph-admitted counter and `drive` is the item 3c drive-executed counter.
 * Returns the count, or `null` when the module never drove that reconstruction
 * (silent JS fallback / flag off).
 */
function moduleReferenceProof(
  diagnostics: readonly { source: string; message: string }[],
  kind: "gc" | "drive",
): number | null {
  const pattern =
    kind === "gc"
      ? /gc_nodes_reconstructed=(\d+)/
      : /drive_steps_executed=(\d+)/;
  for (const diagnostic of diagnostics) {
    if (diagnostic.source !== "fork-module") continue;
    const match = pattern.exec(diagnostic.message);
    if (match) return Number(match[1]);
  }
  return null;
}

test("Chromium drives the multi-node typed-GC fork reconstruction through the module", async ({
  page,
  baseURL,
  browserName,
}) => {
  test.skip(browserName !== "chromium", "the aggregate browser gate uses Chromium");
  test.setTimeout(180_000);
  expect(baseURL).toBeTruthy();

  const result = await runGcCycleFork(page, baseURL!);

  // (a) CORRECTNESS: the child reconstructed the struct<->array cycle + i31 leaf
  // and self-verified every alias, exiting 0 with empty stderr.
  expect(
    result.exitCode,
    `GC cycle fork exited unexpectedly\n${JSON.stringify(result, null, 2)}`,
  ).toBe(0);
  expect(result.stderr).toBe("");

  // (b) PROOF OF USE — admitted through the module.
  const gcNodes = moduleReferenceProof(result.diagnostics, "gc");
  expect(
    gcNodes,
    `expected a fork-module typed-GC proof-of-use diagnostic; the module did ` +
      `not admit the multi-node GC reconstruction\n${JSON.stringify(result, null, 2)}`,
  ).not.toBeNull();
  expect(gcNodes!).toBeGreaterThan(0);

  // (b) PROOF OF USE — the item 3c DRIVE proof: the module executed the typed-GC
  // drive plan (allocate/fill order), not the JS fallback.
  const driveSteps = moduleReferenceProof(result.diagnostics, "drive");
  expect(
    driveSteps,
    `expected a fork-module DRIVE proof-of-use diagnostic; the module admitted ` +
      `the graph but did not drive the typed allocate/fill order (item 3c)\n${JSON.stringify(result, null, 2)}`,
  ).not.toBeNull();
  expect(driveSteps!).toBeGreaterThan(0);
});
