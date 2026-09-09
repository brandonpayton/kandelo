import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test, type Page } from "@playwright/test";
import { zipSync, type Zippable } from "fflate";

import { resolveBinary } from "../../../host/src/binary-resolver";
import { ABI_VERSION } from "../../../host/src/generated/abi";
import { MemoryFileSystem } from "../../../host/src/vfs/memory-fs";
import {
  derivePackageDeferredZipTree,
  materializePackageDeferredZipTree,
  registerPackageDeferredZipTree,
  type PackageDeferredZipTreeSpec,
} from "../../../host/src/vfs/package-deferred-tree";
import { parseZipCentralDirectory } from "../../../host/src/vfs/zip";

interface LazyAcceptanceResult {
  readText: string;
  firstReadError?: string;
  exitCode?: number;
  stdout: string;
  stderr: string;
}

declare global {
  interface Window {
    __lazyArchiveVfsTestReady: boolean;
    __runLazyVfsAcceptance: (request: {
      vfsUrl: string;
      readPath: string;
      executable?: string;
      argv?: string[];
      env?: string[];
      corsProxyExternalLazyUrls?: boolean;
      retryReadAfterFailure?: boolean;
      timeoutMs: number;
    }) => Promise<LazyAcceptanceResult>;
  }
}

const here = dirname(fileURLToPath(import.meta.url));
const environmentProgram = join(
  here,
  "../../../examples/environment_lifecycle_test.wasm",
);
function tryResolveKernelWasm(): string | null {
  try {
    return resolveBinary("kernel.wasm");
  } catch {
    return null;
  }
}
const kernel = tryResolveKernelWasm();
const available = existsSync(environmentProgram) && kernel !== null;

// The production preview itself supplies the cross-origin isolation headers.
// Keep Playwright's byte routes authoritative for these same-origin fixtures;
// the dedicated proxy test below separately exercises external transport.
test.use({ serviceWorkers: "block" });

function identity(bytes: Uint8Array): { sha256: string; bytes: number } {
  return {
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.byteLength,
  };
}

function sameOriginFixtureUrl(baseURL: string, name: string): string {
  return new URL(`__kandelo_lazy_fixture__/${name}`, baseURL).href;
}

// Phase 5 cutover: the in-kernel rootfs overlay is the sole `/` authority and
// its lazy-archive decoder is ZIP-only (tar-gzip System-A registration was
// dropped). Every lazy group is registered through the overlay's ZIP path
// (`registerLazyArchiveFromEntries` -> `buildRootfsLazyWiring` ->
// `host_fetch_archive`), the only format the kernel decodes.
async function lazyImage(groups: Array<{
  url: string;
  archive: Uint8Array;
}>): Promise<Uint8Array> {
  const fs = MemoryFileSystem.create(new SharedArrayBuffer(32 * 1024 * 1024));
  fs.setImageMetadata({ version: 1, kernelAbi: ABI_VERSION });
  for (const group of groups) {
    fs.registerLazyArchiveFromEntries(
      group.url,
      parseZipCentralDirectory(group.archive),
      "/",
      undefined,
      identity(group.archive),
    );
  }
  return fs.saveImage();
}

async function packageTreeImages(
  archive: Uint8Array,
): Promise<{ lazy: Uint8Array; eager: Uint8Array }> {
  const spec = {
    schema: 1,
    kind: "kandelo-package-deferred-zip-tree",
    id: "browser/package-runtime",
    content_role: "runtime-tree",
    package: {
      name: "package-runtime",
      output: "package-runtime.zip",
    },
    archive: {
      url: "package-runtime.zip",
      mode_policy: "portable-posix-v1",
    },
    mount_prefix: "/opt/package-runtime",
    owner: {
      uid: 1000,
      gid: 1000,
    },
    activation: {
      mode: "first-use",
      capabilities: ["package:runtime"],
      roots: ["/opt/package-runtime/bin/environment-lifecycle"],
    },
  } as const satisfies PackageDeferredZipTreeSpec;
  const derived = derivePackageDeferredZipTree(spec, archive);
  const createFs = () => {
    const fs = MemoryFileSystem.create(
      new SharedArrayBuffer(1024 * 1024),
    );
    fs.setImageMetadata({ version: 1, kernelAbi: ABI_VERSION });
    // The environment lifecycle fixture re-execs itself through this stable
    // path. Keep the package-owned executable under its mount prefix while
    // exercising normal VFS symlink resolution for the fixture's re-exec.
    fs.mkdir("/bin", 0o755);
    fs.symlink(
      "/opt/package-runtime/bin/environment-lifecycle",
      "/bin/environment-lifecycle",
    );
    return fs;
  };

  const lazyFs = createFs();
  registerPackageDeferredZipTree(lazyFs, derived);

  const eagerFs = createFs();
  const registered = registerPackageDeferredZipTree(eagerFs, derived);
  await materializePackageDeferredZipTree(eagerFs, registered, archive);

  return {
    lazy: await lazyFs.saveImage(),
    eager: await eagerFs.saveImage(),
  };
}

async function routeBytes(
  page: Page,
  url: string,
  bytes: Uint8Array,
  contentType: string,
): Promise<void> {
  await page.route(url, async (route) => {
    await route.fulfill({
      status: 200,
      body: Buffer.from(bytes),
      headers: {
        "access-control-allow-origin": "*",
        "content-length": String(bytes.byteLength),
        "content-type": contentType,
      },
    });
  });
}

test.skip(!available, "lazy archive Chromium fixtures are not built");

test("Chromium boots, reads, and execs through verified lazy archives", async ({
  page,
  baseURL,
}) => {
  test.setTimeout(180_000);
  if (!baseURL) throw new Error("Playwright baseURL is required");
  const execUrl = sameOriginFixtureUrl(baseURL, "exec.zip");
  const dataUrl = sameOriginFixtureUrl(baseURL, "data.zip");
  const imageUrl = sameOriginFixtureUrl(baseURL, "lazy.vfs");
  const execBytes = new Uint8Array(readFileSync(environmentProgram));
  // The environment lifecycle fixture re-execs itself through argv[0]
  // (`/bin/environment-lifecycle`), so plant the executable directly at that
  // path in the ZIP archive. (The former tar-gzip hardlink layout is not a ZIP
  // capability, and the overlay decodes ZIP only.)
  const execArchive = zipSync({
    "bin/": unixZipEntry(new Uint8Array(), 0o040755),
    "bin/environment-lifecycle": unixZipEntry(execBytes, 0o100755),
  } satisfies Zippable);
  const dataArchive = zipSync({
    "etc/lazy-browser-data": new TextEncoder().encode("lazy-browser-data"),
  });
  const image = await lazyImage([
    { url: execUrl, archive: execArchive },
    { url: dataUrl, archive: dataArchive },
  ]);
  let execFetches = 0;
  let dataFetches = 0;
  await routeBytes(page, imageUrl, image, "application/octet-stream");
  await page.route(execUrl, async (route) => {
    execFetches++;
    await route.fulfill({
      status: 200,
      body: Buffer.from(execArchive),
      headers: {
        "access-control-allow-origin": "*",
        "content-length": String(execArchive.byteLength),
      },
    });
  });
  await page.route(dataUrl, async (route) => {
    dataFetches++;
    await route.fulfill({
      status: 200,
      body: Buffer.from(dataArchive),
      headers: {
        "access-control-allow-origin": "*",
        "content-length": String(dataArchive.byteLength),
      },
    });
  });

  await page.goto(new URL("/pages/lazy-archive-vfs-test/", baseURL).href);
  await expect.poll(
    () => page.evaluate(() => window.__lazyArchiveVfsTestReady),
    { timeout: 120_000 },
  ).toBe(true);
  const result = await page.evaluate(
    (url) => window.__runLazyVfsAcceptance({
      vfsUrl: url,
      readPath: "/etc/lazy-browser-data",
      executable: "/bin/environment-lifecycle",
      argv: ["/bin/environment-lifecycle"],
      env: ["INITIAL=parent", "REMOVE=before-fork"],
      timeoutMs: 90_000,
    }),
    imageUrl,
  );

  expect(result.readText).toBe("lazy-browser-data");
  expect(result.exitCode, result.stderr).toBe(0);
  expect(result.stdout).toContain("EXEC_ENV_PASS");
  expect(result.stdout).toContain("EMPTY_ENV_PASS");
  expect(result.stderr).toBe("");
  expect(dataFetches).toBe(1);
  expect(execFetches).toBe(1);
});

test("Chromium retries a transient lazy-tree response before surfacing EIO", async ({
  page,
  baseURL,
}) => {
  if (!baseURL) throw new Error("Playwright baseURL is required");
  const archiveUrl = sameOriginFixtureUrl(baseURL, "transient.zip");
  const imageUrl = sameOriginFixtureUrl(baseURL, "transient.vfs");
  const payload = new TextEncoder().encode("verified-after-transient-502");
  const archive = zipSync({ "etc/transient-data": payload });
  const image = await lazyImage([{ url: archiveUrl, archive }]);
  let fetches = 0;
  await routeBytes(page, imageUrl, image, "application/octet-stream");
  await page.route(archiveUrl, async (route) => {
    fetches++;
    if (fetches === 1) {
      await route.fulfill({
        status: 502,
        body: "temporary release edge failure",
        headers: {
          "access-control-allow-origin": "*",
          "retry-after": "0",
        },
      });
      return;
    }
    await route.fulfill({
      status: 200,
      body: Buffer.from(archive),
      headers: {
        "access-control-allow-origin": "*",
        "content-length": String(archive.byteLength),
      },
    });
  });

  await page.goto(new URL("/pages/lazy-archive-vfs-test/", baseURL).href);
  await expect.poll(
    () => page.evaluate(() => window.__lazyArchiveVfsTestReady),
    { timeout: 120_000 },
  ).toBe(true);
  const result = await page.evaluate(
    (url) => window.__runLazyVfsAcceptance({
      vfsUrl: url,
      readPath: "/etc/transient-data",
      timeoutMs: 30_000,
    }),
    imageUrl,
  );

  expect(result.firstReadError).toBeUndefined();
  expect(result.readText).toBe("verified-after-transient-502");
  expect(fetches).toBe(2);
});

// NOTE: The former "browser applies a generic authenticated archive
// transformation" case was DELETED in the Phase 5 cutover. It exercised the
// host-side lazy byte-transform materialization (`archive-byte-transforms-v1`,
// e.g. `@@ROOT@@` -> `/etc` on materialize) that only the removed tar-gzip
// System-A `registerLazyTree` path applied. The in-kernel overlay that now owns
// `/` fetches raw archive bytes and decodes ZIP members verbatim
// (`buildRootfsLazyWiring` has no transform hook), so lazy read-time
// materialization no longer exists as a served behavior. There is no ZIP-overlay
// equivalent to migrate onto.

test("browser workers proxy external lazy archives under cross-origin isolation", async ({
  page,
  baseURL,
}) => {
  if (!baseURL) throw new Error("Playwright baseURL is required");
  const archive = zipSync({
    "etc/proxied-data": new TextEncoder().encode("proxied-lazy-archive"),
  });
  let upstreamFetches = 0;
  const server = createServer((request, response) => {
    upstreamFetches++;
    if (request.url !== "/external.zip") {
      response.writeHead(404).end();
      return;
    }
    // Deliberately omit CORS. Lazy VFS must read the response bytes, and even
    // a CORP header would not make an opaque no-CORS body readable to JS.
    response.writeHead(200, {
      "content-length": String(archive.byteLength),
      "content-type": "application/zip",
    });
    response.end(archive);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  const archiveUrl =
    `http://127.0.0.1:${address.port}/external.zip`;
  const imageUrl =
    "https://fixtures.kandelo.invalid/proxied-lazy.vfs";
  const image = await lazyImage([{ url: archiveUrl, archive }]);
  const browserRequests: string[] = [];
  page.on("request", (request) => browserRequests.push(request.url()));

  try {
    await routeBytes(page, imageUrl, image, "application/octet-stream");
    await page.goto(new URL("/pages/lazy-archive-vfs-test/", baseURL).href);
    await expect.poll(
      () => page.evaluate(() => window.__lazyArchiveVfsTestReady),
      { timeout: 120_000 },
    ).toBe(true);
    const result = await page.evaluate(
      ({ vfsUrl }) => window.__runLazyVfsAcceptance({
        vfsUrl,
        readPath: "/etc/proxied-data",
        corsProxyExternalLazyUrls: true,
        timeoutMs: 30_000,
      }),
      { vfsUrl: imageUrl },
    );

    expect(result.readText).toBe("proxied-lazy-archive");
    expect(upstreamFetches).toBe(1);
    expect(browserRequests).not.toContain(archiveUrl);
    expect(browserRequests.some((requestUrl) => {
      const url = new URL(requestUrl);
      return url.pathname.endsWith("/__kandelo_cors_proxy") &&
        url.searchParams.get("url") === archiveUrl;
    })).toBe(true);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
});

test("Chromium reports digest failure without mutation and retries cleanly", async ({
  page,
  baseURL,
}) => {
  if (!baseURL) throw new Error("Playwright baseURL is required");
  const archiveUrl = sameOriginFixtureUrl(baseURL, "retry.zip");
  const imageUrl = sameOriginFixtureUrl(baseURL, "retry.vfs");
  const archive = zipSync({
    "etc/retry-data": new TextEncoder().encode("verified-after-retry"),
  });
  const image = await lazyImage([{ url: archiveUrl, archive }]);
  const bad = archive.slice();
  bad[0] ^= 0xff;
  let fetches = 0;
  await routeBytes(page, imageUrl, image, "application/octet-stream");
  await page.route(archiveUrl, async (route) => {
    fetches++;
    const bytes = fetches === 1 ? bad : archive;
    await route.fulfill({
      status: 200,
      body: Buffer.from(bytes),
      headers: {
        "access-control-allow-origin": "*",
        "content-length": String(bytes.byteLength),
      },
    });
  });

  await page.goto(new URL("/pages/lazy-archive-vfs-test/", baseURL).href);
  await expect.poll(
    () => page.evaluate(() => window.__lazyArchiveVfsTestReady),
    { timeout: 120_000 },
  ).toBe(true);
  const result = await page.evaluate(
    (url) => window.__runLazyVfsAcceptance({
      vfsUrl: url,
      readPath: "/etc/retry-data",
      retryReadAfterFailure: true,
      timeoutMs: 30_000,
    }),
    imageUrl,
  );

  expect(result.firstReadError).toContain("SHA-256");
  expect(result.readText).toBe("verified-after-retry");
  expect(fetches).toBe(2);
});

test("Chromium consumes lazy and eager package trees derived from one exact ZIP", async ({
  page,
  baseURL,
}) => {
  test.setTimeout(180_000);
  if (!baseURL) throw new Error("Playwright baseURL is required");
  const executable = new Uint8Array(readFileSync(environmentProgram));
  const archive = zipSync({
    "bin/": unixZipEntry(new Uint8Array(), 0o040700),
    "bin/environment-lifecycle": unixZipEntry(executable, 0o100711),
    "share/": unixZipEntry(new Uint8Array(), 0o040777),
    "share/package-runtime.txt": unixZipEntry(
      new TextEncoder().encode("same package tree\n"),
      0o100600,
    ),
  } satisfies Zippable);
  const images = await packageTreeImages(archive);
  const lazyImageUrl = sameOriginFixtureUrl(baseURL, "package-lazy.vfs");
  const eagerImageUrl = sameOriginFixtureUrl(baseURL, "package-eager.vfs");
  const archiveUrl = new URL("package-runtime.zip", baseURL).href;
  let archiveFetches = 0;
  await routeBytes(page, lazyImageUrl, images.lazy, "application/octet-stream");
  await routeBytes(page, eagerImageUrl, images.eager, "application/octet-stream");
  await page.route(archiveUrl, async (route) => {
    archiveFetches++;
    await route.fulfill({
      status: 200,
      body: Buffer.from(archive),
      headers: {
        "content-length": String(archive.byteLength),
        "content-type": "application/zip",
      },
    });
  });

  await page.goto(new URL("/pages/lazy-archive-vfs-test/", baseURL).href);
  await expect.poll(
    () => page.evaluate(() => window.__lazyArchiveVfsTestReady),
    { timeout: 120_000 },
  ).toBe(true);
  const request = {
    readPath: "/opt/package-runtime/share/package-runtime.txt",
    executable: "/opt/package-runtime/bin/environment-lifecycle",
    argv: ["/opt/package-runtime/bin/environment-lifecycle"],
    env: ["INITIAL=parent", "REMOVE=before-fork"],
    timeoutMs: 90_000,
  };
  const lazy = await page.evaluate(
    ({ url, acceptance }) => window.__runLazyVfsAcceptance({
      vfsUrl: url,
      ...acceptance,
    }),
    { url: lazyImageUrl, acceptance: request },
  );
  expect(lazy).toMatchObject({
    readText: "same package tree\n",
    exitCode: 0,
    stderr: "",
  });
  expect(lazy.stdout).toContain("EXEC_ENV_PASS");
  expect(lazy.stdout).toContain("EMPTY_ENV_PASS");
  expect(archiveFetches).toBe(1);

  const eager = await page.evaluate(
    ({ url, acceptance }) => window.__runLazyVfsAcceptance({
      vfsUrl: url,
      ...acceptance,
    }),
    { url: eagerImageUrl, acceptance: request },
  );
  expect(eager).toMatchObject({
    readText: "same package tree\n",
    exitCode: 0,
    stderr: "",
  });
  expect(eager.stdout).toContain("EXEC_ENV_PASS");
  expect(eager.stdout).toContain("EMPTY_ENV_PASS");
  expect(archiveFetches).toBe(1);
});

function unixZipEntry(bytes: Uint8Array, mode: number): Zippable[string] {
  return [bytes, { os: 3, attrs: ((mode << 16) >>> 0) }];
}
