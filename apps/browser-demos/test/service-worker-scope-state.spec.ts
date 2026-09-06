import {
  expect,
  test,
  type BrowserContext,
  type Page,
  type Worker,
} from "@playwright/test";
import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";

const FIXTURE_PORT = 55_431;
const FIXTURE_ORIGIN = `http://127.0.0.1:${FIXTURE_PORT}`;
const SESSION_A = "11111111-1111-4111-8111-111111111111";
const SESSION_A_NEXT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SESSION_B = "22222222-2222-4222-8222-222222222222";
const CACHE_A = "kandelo-sw:%2Fa%2F:bridge-v2";
const CACHE_B = "kandelo-sw:%2Fb%2F:bridge-v2";
const LAZY_CACHE_A = "kandelo-sw:%2Fa%2F:lazy-assets-v1";
const LAZY_CACHE_CANDIDATE_B = "kandelo-sw:%2Fcandidate-b%2F:lazy-assets-v1";
const VFS_LAZY_CACHE_VERSION_PLACEHOLDER =
  "__KANDELO_VFS_LAZY_CACHE_VERSION__";
const GROUP_A_SHA256 = "a".repeat(64);
const GROUP_B_SHA256 = "b".repeat(64);
const BRIDGE_AUTHORITY_KEY = "bridge-authority-v1";
const BRIDGE_AUTHORITY_MAX_BYTES = 64 * 1024;
const BRIDGE_AUTHORITY_MAX_COOKIES = 32;
const BRIDGE_APP_PREFIX_MAX_BYTES = 4_096;
const BRIDGE_COOKIE_NAME_MAX_BYTES = 256;
const BRIDGE_COOKIE_VALUE_MAX_BYTES = 4_096;
const BRIDGE_COOKIE_PATH_MAX_BYTES = 4_096;

const cleanupMatrix = [
  "unrelated-site-cache",
  CACHE_B,
  "kandelo-sw:%2Fa%2F:bridge-v1",
  CACHE_A,
  LAZY_CACHE_A,
  "sw-bridge-config",
] as const;

let fixtureServer: Server;
let workerSource = "";
let groupedWorkerCacheVersion: string | undefined;

type LazyAssetResponse =
  | { kind: "ok"; body: string }
  | { kind: "failed"; body: string }
  | { kind: "partial"; body: string }
  | { kind: "truncated"; body: string };

const lazyAssetResponses = new Map<string, LazyAssetResponse>();

function resetLazyAssetResponses(): void {
  lazyAssetResponses.clear();
  lazyAssetResponses.set("/a/vfs-groups/release-1/assets/shared.bin", {
    kind: "ok",
    body: "scope-a shared bytes",
  });
  lazyAssetResponses.set("/candidate-b/vfs-groups/release-1/assets/shared.bin", {
    kind: "ok",
    body: "candidate-b shared bytes",
  });
  lazyAssetResponses.set("/a/vfs-groups/release-1/assets/failed.bin", {
    kind: "failed",
    body: "lazy asset upstream failure",
  });
  lazyAssetResponses.set("/a/vfs-groups/release-1/assets/partial.bin", {
    kind: "partial",
    body: "partial lazy asset bytes",
  });
  lazyAssetResponses.set("/a/vfs-groups/release-1/assets/truncated.bin", {
    kind: "truncated",
    body: "short lazy asset",
  });
}

test.beforeAll(async () => {
  workerSource = await readFile(
    new URL("../public/service-worker.js", import.meta.url),
    "utf8",
  );
  fixtureServer = createServer((request, response) => {
    const url = new URL(request.url ?? "/", FIXTURE_ORIGIN);
    if (url.pathname.endsWith("/service-worker.js")) {
      response.writeHead(200, {
        "Cache-Control": "no-store",
        "Content-Type": "application/javascript; charset=utf-8",
      });
      response.end(groupedWorkerSource());
      return;
    }

    const lazyAsset = lazyAssetResponses.get(url.pathname);
    if (lazyAsset) {
      if (lazyAsset.kind === "failed") {
        response.writeHead(503, {
          "Cache-Control": "no-store",
          "Content-Type": "application/octet-stream",
        });
        response.end(lazyAsset.body);
        return;
      }
      const bytes = Buffer.from(lazyAsset.body);
      response.writeHead(lazyAsset.kind === "partial" ? 206 : 200, {
        "Cache-Control": "no-store",
        "Content-Type": "application/octet-stream",
        "Content-Length": String(
          bytes.byteLength + (lazyAsset.kind === "truncated" ? 1 : 0),
        ),
        ...(lazyAsset.kind === "partial"
          ? { "Content-Range": `bytes 0-${bytes.byteLength - 1}/99` }
          : {}),
      });
      response.end(bytes);
      return;
    }

    response.writeHead(200, {
      "Cache-Control": "no-store",
      "Content-Type": request.headers.accept?.includes("text/html")
        ? "text/html; charset=utf-8"
        : "text/plain; charset=utf-8",
    });
    response.end(
      request.headers.accept?.includes("text/html")
        ? `<!doctype html><title>${url.pathname}</title>`
        : `network:${url.pathname}`,
    );
  });
  await new Promise<void>((resolve, reject) => {
    fixtureServer.once("error", reject);
    fixtureServer.listen(FIXTURE_PORT, "127.0.0.1", () => {
      fixtureServer.off("error", reject);
      resolve();
    });
  });
});

test.beforeEach(() => {
  resetLazyAssetResponses();
  groupedWorkerCacheVersion = undefined;
});

test.afterAll(async () => {
  if (!fixtureServer) return;
  await new Promise<void>((resolve, reject) => {
    fixtureServer.close((error) => error ? reject(error) : resolve());
  });
});

test("activation removes only obsolete caches in its exact scope namespace", async ({
  page,
}) => {
  await page.goto(`${FIXTURE_ORIGIN}/a/`);
  await seedCaches(page, cleanupMatrix);
  await registerScope(page, "/a/");

  expect((await cacheNames(page)).sort()).toEqual([
    "unrelated-site-cache",
    CACHE_B,
    CACHE_A,
    LAZY_CACHE_A,
    "sw-bridge-config",
  ].sort());
});

test("a scoped lazy VFS asset cache preserves full bytes and Content-Length during an origin failure", async ({
  page,
}) => {
  await page.goto(`${FIXTURE_ORIGIN}/a/`);
  await registerScope(page, "/a/");
  const assetPath = "/a/vfs-groups/release-1/assets/shared.bin";
  const expectedBody = "scope-a shared bytes";

  expect(await fetchResponse(page, assetPath)).toEqual({
    status: 200,
    body: expectedBody,
    contentLength: String(Buffer.byteLength(expectedBody)),
  });
  lazyAssetResponses.set(assetPath, {
    kind: "failed",
    body: "origin is unavailable after the first full response",
  });

  expect(await fetchResponse(page, assetPath)).toEqual({
    status: 200,
    body: expectedBody,
    contentLength: String(Buffer.byteLength(expectedBody)),
  });
  expect(await lazyCacheEntries(page, LAZY_CACHE_A)).toEqual([assetPath]);
});

test("a grouped deployment replaces an old unversioned lazy cache at the same public URL", async ({
  page,
}) => {
  const assetPath = "/a/vfs-groups/release-1/assets/shared.bin";
  const legacyBody = "same public URL from the old group";
  const replacementBody = "same public URL from the new group";
  lazyAssetResponses.set(assetPath, { kind: "ok", body: legacyBody });

  await page.goto(`${FIXTURE_ORIGIN}/a/`);
  await registerScope(page, "/a/");
  expect(await fetchResponse(page, assetPath)).toMatchObject({
    body: legacyBody,
    status: 200,
  });
  expect(await lazyCacheEntries(page, LAZY_CACHE_A)).toEqual([assetPath]);

  groupedWorkerCacheVersion = GROUP_B_SHA256;
  lazyAssetResponses.set(assetPath, { kind: "ok", body: replacementBody });
  await updateScope(page, "/a/");

  expect(await fetchResponse(page, assetPath)).toMatchObject({
    body: replacementBody,
    status: 200,
  });
  await expect.poll(() => cacheNames(page)).not.toContain(LAZY_CACHE_A);
  expect(await lazyCacheEntries(page, lazyCacheName("/a/", GROUP_B_SHA256)))
    .toEqual([assetPath]);
});

test("a grouped deployment replaces its prior manifest-version cache at the same public URL", async ({
  page,
}) => {
  const assetPath = "/a/vfs-groups/release-1/assets/shared.bin";
  const firstBody = "same public URL from group A";
  const nextBody = "same public URL from group B";
  groupedWorkerCacheVersion = GROUP_A_SHA256;
  lazyAssetResponses.set(assetPath, { kind: "ok", body: firstBody });

  await page.goto(`${FIXTURE_ORIGIN}/a/`);
  await registerScope(page, "/a/");
  expect(await fetchResponse(page, assetPath)).toMatchObject({
    body: firstBody,
    status: 200,
  });
  expect(await lazyCacheEntries(page, lazyCacheName("/a/", GROUP_A_SHA256)))
    .toEqual([assetPath]);

  groupedWorkerCacheVersion = GROUP_B_SHA256;
  lazyAssetResponses.set(assetPath, { kind: "ok", body: nextBody });
  await updateScope(page, "/a/");

  expect(await fetchResponse(page, assetPath)).toMatchObject({
    body: nextBody,
    status: 200,
  });
  await expect.poll(() => cacheNames(page)).not.toContain(
    lazyCacheName("/a/", GROUP_A_SHA256),
  );
  expect(await lazyCacheEntries(page, lazyCacheName("/a/", GROUP_B_SHA256)))
    .toEqual([assetPath]);
});

test("scoped lazy VFS caches keep identical filenames distinct across deployment prefixes", async ({
  context,
  page: pageA,
}) => {
  await pageA.goto(`${FIXTURE_ORIGIN}/a/`);
  await registerScope(pageA, "/a/");
  const assetSuffix = "/vfs-groups/release-1/assets/shared.bin";
  expect(await fetchResponse(pageA, `/a${assetSuffix}`)).toMatchObject({
    status: 200,
    body: "scope-a shared bytes",
  });

  const pageCandidateB = await context.newPage();
  await pageCandidateB.goto(`${FIXTURE_ORIGIN}/candidate-b/`);
  await registerScope(pageCandidateB, "/candidate-b/");
  expect(await fetchResponse(pageCandidateB, `/candidate-b${assetSuffix}`))
    .toMatchObject({
      status: 200,
      body: "candidate-b shared bytes",
    });

  expect(await lazyCacheEntries(pageA, LAZY_CACHE_A)).toEqual([
    `/a${assetSuffix}`,
  ]);
  expect(await lazyCacheEntries(pageCandidateB, LAZY_CACHE_CANDIDATE_B)).toEqual([
    `/candidate-b${assetSuffix}`,
  ]);
});

test("failed and truncated lazy VFS responses create no cache entry", async ({
  page,
}) => {
  await page.goto(`${FIXTURE_ORIGIN}/a/`);
  await registerScope(page, "/a/");

  expect(await fetchResponse(page, "/a/vfs-groups/release-1/assets/failed.bin"))
    .toMatchObject({ status: 503, body: "lazy asset upstream failure" });
  await expect(fetchBytes(page, "/a/vfs-groups/release-1/assets/truncated.bin"))
    .rejects.toThrow();

  expect(await lazyCacheEntries(page, LAZY_CACHE_A)).toEqual([]);
});

test("a 206 lazy VFS response returns raw bytes without creating a cache entry", async ({
  page,
}) => {
  await page.goto(`${FIXTURE_ORIGIN}/a/`);
  await registerScope(page, "/a/");

  expect(await fetchResponse(page, "/a/vfs-groups/release-1/assets/partial.bin"))
    .toEqual({
      status: 206,
      body: "partial lazy asset bytes",
      contentLength: String(Buffer.byteLength("partial lazy asset bytes")),
    });
  expect(await lazyCacheEntries(page, LAZY_CACHE_A)).toEqual([]);
});

test("lazy VFS cache excludes bridge, static, query, navigation, sibling, and cross-origin routes", async ({
  page,
}) => {
  await page.goto(`${FIXTURE_ORIGIN}/a/`);
  await registerScope(page, "/a/");
  expect(await installBridge(page, "/a/vfs-groups/", SESSION_A, "excluded"))
    .toMatchObject({ body: "bridge:excluded" });

  expect(await fetchText(page, "/a/vfs-groups/release-1/assets/shared.bin"))
    .toBe("bridge:excluded");
  expect(await installBridge(page, "/a/app/", SESSION_A_NEXT, "excluded-reset"))
    .toMatchObject({ body: "bridge:excluded-reset" });
  await fetchText(page, "/a/static.txt");
  await fetchText(page, "/a/vfs-groups/release-1/assets/shared.bin?revision=1");
  await fetchText(page, "/a/vfs-groups-sibling/release-1/assets/shared.bin");
  await fetchText(
    page,
    "/a/products/demo/sha256-" + "a".repeat(64) + "/demo-1.vfs.zst",
  );
  await page.goto(`${FIXTURE_ORIGIN}/a/vfs-groups/release-1/navigation.html`);
  await page.goto(`${FIXTURE_ORIGIN}/a/`);
  await page.evaluate(async () => {
    await fetch(
      "http://localhost:55431/a/vfs-groups/release-1/assets/shared.bin",
      { mode: "no-cors" },
    ).catch(() => undefined);
  });

  expect(await lazyCacheEntries(page, LAZY_CACHE_A)).toEqual([]);
});

test("a restarted worker restores a VFS-group bridge before classifying lazy cache routes", async ({
  context,
  page,
}) => {
  await page.goto(`${FIXTURE_ORIGIN}/a/`);
  await registerScope(page, "/a/");
  expect(await installBridge(page, "/a/vfs-groups/", SESSION_A, "before-restart"))
    .toMatchObject({ body: "bridge:before-restart" });
  await installRestoreResponder(page, {
    appPrefix: "/a/vfs-groups/",
    sessionId: SESSION_A,
    label: "restored-vfs-groups",
  });
  await stopWorker(context, page, `${FIXTURE_ORIGIN}/a/service-worker.js`);

  expect(await fetchText(page, "/a/vfs-groups/release-1/assets/shared.bin"))
    .toBe("bridge:restored-vfs-groups");
  expect(await lazyCacheEntries(page, LAZY_CACHE_A)).toEqual([]);
});

test("sibling workers persist independent bridge records and garbage collect locally", async ({
  context,
  page: pageA,
}) => {
  await pageA.goto(`${FIXTURE_ORIGIN}/a/`);
  await registerScope(pageA, "/a/");
  expect(await installBridge(pageA, "/a/app/", SESSION_A, "a-first"))
    .toEqual({ reply: { type: "bridge-ready" }, body: "bridge:a-first" });

  const pageB = await context.newPage();
  await pageB.goto(`${FIXTURE_ORIGIN}/b/`);
  await registerScope(pageB, "/b/");
  expect(await installBridge(pageB, "/b/app/", SESSION_B, "b"))
    .toEqual({ reply: { type: "bridge-ready" }, body: "bridge:b" });

  expect(await installBridge(pageA, "/a/app/", SESSION_A_NEXT, "a-next"))
    .toEqual({ reply: { type: "bridge-ready" }, body: "bridge:a-next" });

  expect(await readBridgeAuthority(pageA, CACHE_A)).toMatchObject({
    version: 1,
    appPrefix: "/a/app/",
    sessionId: SESSION_A_NEXT,
    cookies: [{ name: "a-next", value: "1", path: "/a/app/" }],
  });
  expect(await readBridgeAuthority(pageA, CACHE_B)).toMatchObject({
    version: 1,
    appPrefix: "/b/app/",
    sessionId: SESSION_B,
    cookies: [{ name: "b", value: "1", path: "/b/app/" }],
  });
  expect((await readBridgeCaches(pageA, [CACHE_A, CACHE_B]))).toEqual({
    [CACHE_A]: { appPrefix: null, entries: [BRIDGE_AUTHORITY_KEY] },
    [CACHE_B]: { appPrefix: null, entries: [BRIDGE_AUTHORITY_KEY] },
  });
});

test("invalid persisted app-prefix state never configures or restores the bridge", async ({
  page,
}) => {
  await page.goto(`${FIXTURE_ORIGIN}/a/`);
  await seedAppPrefix(page, CACHE_A, "/b/app/");
  await seedAppPrefix(page, "sw-bridge-config", "/b/app/");
  await installRestoreResponder(page, {
    appPrefix: "/b/app/",
    sessionId: SESSION_A,
    label: "invalid-persisted",
  });
  await registerScope(page, "/a/");

  const result = await page.evaluate(async () => {
    const response = await fetch("/b/app/persisted-probe", {
      cache: "no-store",
    });
    return {
      body: await response.text(),
      needBridgeCount: (window as typeof window & {
        __needBridgeCount?: number;
      }).__needBridgeCount ?? 0,
    };
  });
  expect(result).toEqual({
    body: "network:/b/app/persisted-probe",
    needBridgeCount: 0,
  });
  expect((await readBridgeCaches(page, [CACHE_A]))[CACHE_A]).toEqual({
    appPrefix: "/b/app/",
    entries: ["app-prefix"],
  });
});

test("an invalid committed authority never falls back to legacy bridge records", async ({
  page,
}) => {
  await page.goto(`${FIXTURE_ORIGIN}/a/`);
  await seedAppPrefix(page, CACHE_A, "/a/app/");
  await seedCookieJar(page, CACHE_A, SESSION_A, [
    { name: "legacy", value: "1", path: "/a/app/" },
  ]);
  await seedBridgeAuthority(page, CACHE_A, {
    version: 1,
    revision: 1,
    appPrefix: "/b/app/",
    sessionId: SESSION_A,
    cookies: [],
  });
  const durableBefore = await cacheSnapshot(page);
  await installRestoreResponder(page, {
    appPrefix: "/a/app/",
    sessionId: SESSION_A,
    label: "legacy-fallback",
  });
  await registerScope(page, "/a/");

  expect(await fetchText(page, "/a/app/invalid-authority"))
    .toBe("network:/a/app/invalid-authority");
  expect(await page.evaluate(() => (
    window as typeof window & { __needBridgeCount?: number }
  ).__needBridgeCount ?? 0)).toBe(0);
  expect(await cacheSnapshot(page)).toEqual(durableBefore);
});

test("invalid handshakes preserve the valid live port and every durable byte", async ({
  page,
}) => {
  await page.goto(`${FIXTURE_ORIGIN}/a/`);
  await registerScope(page, "/a/");
  expect(await installBridge(page, "/a/app/", SESSION_A, "valid"))
    .toEqual({ reply: { type: "bridge-ready" }, body: "bridge:valid" });
  const durableBefore = await cacheSnapshot(page);

  const invalidPrefixes: unknown[] = [
    "/a/",
    "/app/",
    "/a",
    "/ab/app/",
    "/b/app/",
    "a/app/",
    "https://example.test/a/app/",
    "//example.test/a/app/",
    "/a//app/",
    "/a/./app/",
    "/a/%2e/app/",
    "/a/%2f/app/",
    "/a/%5c/app/",
    "/a/%252e%252e/app/",
    "/a/app/?q=1",
    "/a/app/#x",
    "/a/\0/app/",
    null,
    42,
  ];
  const invalidSessions: unknown[] = [
    "",
    "11111111-1111-1111-8111-111111111111",
    "11111111-1111-4111-7111-111111111111",
    "11111111-1111-4111-8111-11111111111A",
    "HTTPS://EXAMPLE.TEST/",
    "cookie-jar-app-prefix",
    "x".repeat(200),
    null,
    42,
    undefined,
  ];

  for (const appPrefix of invalidPrefixes) {
    expect.soft(
      await initAttempt(page, appPrefix, SESSION_A, `prefix:${appPrefix}`),
      `invalid prefix ${JSON.stringify(appPrefix)}`,
    ).toEqual({ type: "bridge-error", code: "invalid-scope-config" });
    expect.soft(await fetchText(page, "/a/app/live-port"))
      .toBe("bridge:valid");
  }
  for (const sessionId of invalidSessions) {
    expect.soft(
      await initAttempt(page, "/a/app/", sessionId, `session:${sessionId}`),
      `invalid session ${JSON.stringify(sessionId)}`,
    ).toEqual({ type: "bridge-error", code: "invalid-scope-config" });
    expect.soft(await fetchText(page, "/a/app/live-port"))
      .toBe("bridge:valid");
  }

  await initAttempt(page, "/a/app/", SESSION_A, "missing-reply", 1);
  await initAttempt(page, "/a/app/", SESSION_A, "missing-ports", 0);
  expect(await fetchText(page, "/a/app/live-port")).toBe("bridge:valid");
  expect((await capturedCookies(page, "valid")).at(-1)).toBe("valid=1");
  expect(await cacheSnapshot(page)).toEqual(durableBefore);
  expect(await page.evaluate(() => (
    window as typeof window & { __replacementBridgeRequests?: number }
  ).__replacementBridgeRequests ?? 0)).toBe(0);
});

for (const [operation, failAfter] of [
  ["open", 0],
  ["put", 0],
] as const) {
  test(`a ${operation} failure preserves the prior live and durable bridge transaction`, async ({
    context,
    page,
  }) => {
    await page.goto(`${FIXTURE_ORIGIN}/a/`);
    await registerScope(page, "/a/");
    expect(await installBridge(page, "/a/app/", SESSION_A, "stable"))
      .toEqual({ reply: { type: "bridge-ready" }, body: "bridge:stable" });
    expect(await fetchText(page, "/a/app/seeded-cookie"))
      .toBe("bridge:stable");
    expect((await capturedCookies(page, "stable")).at(-1)).toBe("stable=1");

    await seedCookieJar(page, CACHE_A, SESSION_A_NEXT, [
      { name: "next", value: "1", path: "/a/next/" },
    ]);
    await seedCookieJar(page, CACHE_A, SESSION_B, [
      { name: "wrong-session", value: "1", path: "/a/app/" },
    ]);
    const durableBefore = await cacheSnapshot(page);
    await injectCacheOperation(context, operation, "reject", failAfter);

    expect(
      await transitionAttempt(
        page,
        "/a/next/",
        SESSION_A_NEXT,
        `failed-${operation}`,
      ),
    ).toEqual({ type: "bridge-error", code: "bridge-init-failed" });
    expect(await fetchText(page, "/a/app/after-failure"))
      .toBe("bridge:stable");
    expect((await capturedCookies(page, "stable")).at(-1)).toBe("stable=1");
    expect(await cacheSnapshot(page)).toEqual(durableBefore);
    expect(await replacementBridgeRequestCount(page)).toBe(0);
  });
}

test("a legacy jar match failure cannot create a first bridge authority", async ({
  context,
  page,
}) => {
  await page.goto(`${FIXTURE_ORIGIN}/a/`);
  await registerScope(page, "/a/");
  await seedCookieJar(page, CACHE_A, SESSION_A, [
    { name: "legacy", value: "1", path: "/a/app/" },
  ]);
  const durableBefore = await cacheSnapshot(page);
  await injectCacheOperation(context, "match", "reject", 0);

  expect(await transitionAttempt(
    page,
    "/a/app/",
    SESSION_A,
    "failed-match",
  )).toEqual({ type: "bridge-error", code: "bridge-init-failed" });
  expect(await readBridgeAuthority(page)).toBeNull();
  expect(await fetchText(page, "/a/app/after-match-failure"))
    .toBe("network:/a/app/after-match-failure");
  expect(await cacheSnapshot(page)).toEqual(durableBefore);
  expect(await replacementBridgeRequestCount(page)).toBe(0);
});

test("worker termination before the authority commit preserves the prior transaction", async ({
  context,
  page,
}) => {
  await page.goto(`${FIXTURE_ORIGIN}/a/`);
  await registerScope(page, "/a/");
  expect(await installBridge(page, "/a/app/", SESSION_A, "stable-lifetime"))
    .toEqual({
      reply: { type: "bridge-ready" },
      body: "bridge:stable-lifetime",
    });
  expect(await fetchText(page, "/a/app/seeded-cookie"))
    .toBe("bridge:stable-lifetime");
  await seedCookieJar(page, CACHE_A, SESSION_A_NEXT, [
    { name: "next", value: "1", path: "/a/next/" },
  ]);
  await seedCookieJar(page, CACHE_A, SESSION_B, [
    { name: "wrong-session", value: "1", path: "/a/app/" },
  ]);
  const durableBefore = await cacheSnapshot(page);
  await installRestoreResponder(page, {
    appPrefix: "/a/app/",
    sessionId: SESSION_A,
    label: "lifetime-restore",
  });
  const worker = await injectCacheOperation(context, "put", "block", 0);

  const transition = transitionAttempt(
    page,
    "/a/next/",
    SESSION_A_NEXT,
    "terminated-replacement",
    1_000,
  );
  await expect.poll(() => worker.evaluate(() => (
    globalThis as typeof globalThis & { __cacheOperationEntered?: boolean }
  ).__cacheOperationEntered ?? false)).toBe(true);
  await stopWorker(context, page, `${FIXTURE_ORIGIN}/a/service-worker.js`);

  expect(await transition).toBeNull();
  expect(await cacheSnapshot(page)).toEqual(durableBefore);
  expect(await fetchText(page, "/a/app/after-terminated-init"))
    .toBe("bridge:lifetime-restore");
  expect((await capturedCookies(page, "lifetime-restore")).at(-1))
    .toBe("stable-lifetime=1");
  expect(await replacementBridgeRequestCount(page)).toBe(0);
});

test("a cleanup failure cannot corrupt the single committed bridge authority", async ({
  context,
  page,
}) => {
  await page.goto(`${FIXTURE_ORIGIN}/a/`);
  await registerScope(page, "/a/");
  expect(await installBridge(page, "/a/app/", SESSION_A, "rollback-stable"))
    .toEqual({
      reply: { type: "bridge-ready" },
      body: "bridge:rollback-stable",
    });
  await seedAppPrefix(page, CACHE_A, "/a/app/");
  await seedCookieJar(page, CACHE_A, SESSION_A_NEXT, [
    { name: "next", value: "1", path: "/a/next/" },
  ]);
  await seedCookieJar(page, CACHE_A, SESSION_B, [
    { name: "obsolete", value: "1", path: "/a/app/" },
  ]);
  await injectRollbackFailure(context);

  expect(await transitionAttempt(
    page,
    "/a/next/",
    SESSION_A_NEXT,
    "rollback-next",
    1_000,
  )).toEqual({ type: "bridge-ready" });
  expect(await fetchText(page, "/a/next/after-cleanup-failure"))
    .toBe("replacement:rollback-next");
  expect(await readBridgeAuthority(page)).toMatchObject({
    version: 1,
    appPrefix: "/a/next/",
    sessionId: SESSION_A_NEXT,
    cookies: [],
  });
});

test("termination during partial cleanup restarts from the new complete authority", async ({
  context,
  page,
}) => {
  await page.goto(`${FIXTURE_ORIGIN}/a/`);
  await registerScope(page, "/a/");
  expect(await installBridge(page, "/a/app/", SESSION_A, "cleanup-stable"))
    .toEqual({
      reply: { type: "bridge-ready" },
      body: "bridge:cleanup-stable",
    });
  await seedAppPrefix(page, CACHE_A, "/a/app/");
  await seedCookieJar(page, CACHE_A, SESSION_A_NEXT, [
    { name: "legacy-next", value: "1", path: "/a/next/" },
  ]);
  await seedCookieJar(page, CACHE_A, SESSION_B, [
    { name: "legacy-obsolete", value: "1", path: "/a/app/" },
  ]);
  await installRestoreResponder(page, {
    appPrefix: "/a/next/",
    sessionId: SESSION_A_NEXT,
    label: "cleanup-restore",
  });
  const worker = await injectReleasableCacheOperation(
    context,
    "delete",
    1,
  );

  const transition = transitionAttempt(
    page,
    "/a/next/",
    SESSION_A_NEXT,
    "cleanup-next",
    1_000,
  );
  await expect.poll(() => worker.evaluate(() => (
    globalThis as typeof globalThis & { __cacheOperationEntered?: boolean }
  ).__cacheOperationEntered ?? false)).toBe(true);
  expect(await transition).toEqual({ type: "bridge-ready" });
  await stopWorker(context, page, `${FIXTURE_ORIGIN}/a/service-worker.js`);

  expect(await readBridgeAuthority(page)).toMatchObject({
    version: 1,
    appPrefix: "/a/next/",
    sessionId: SESSION_A_NEXT,
    cookies: [],
  });
  expect(await fetchText(page, "/a/next/after-partial-cleanup"))
    .toBe("bridge:cleanup-restore");
  expect((await capturedCookies(page, "cleanup-restore")).at(-1)).toBe("");
});

test("an obsolete live bridge cookie write serializes before a newer init", async ({
  context,
  page,
}) => {
  await page.goto(`${FIXTURE_ORIGIN}/a/`);
  await registerScope(page, "/a/");
  expect(await installBridge(page, "/a/app/", SESSION_A, "cookie-race"))
    .toEqual({
      reply: { type: "bridge-ready" },
      body: "bridge:cookie-race",
    });
  await setBridgeCookieValue(page, "cookie-race", "2");
  const worker = await injectReleasableCacheOperation(context, "put", 0);

  const oldFetch = fetchText(page, "/a/app/blocked-cookie-write");
  await expect.poll(() => worker.evaluate(() => (
    globalThis as typeof globalThis & { __cacheOperationEntered?: boolean }
  ).__cacheOperationEntered ?? false)).toBe(true);
  let transitionSettled = false;
  const transition = transitionAttempt(
    page,
    "/a/next/",
    SESSION_A_NEXT,
    "cookie-race-next",
    2_000,
  ).then((reply) => {
    transitionSettled = true;
    return reply;
  });
  await page.waitForTimeout(200);
  const settledBeforeOldWrite = transitionSettled;
  await releaseCacheOperation(worker);

  expect(await oldFetch).toBe("bridge:cookie-race");
  expect(settledBeforeOldWrite).toBe(false);
  expect(await transition).toEqual({ type: "bridge-ready" });
  expect(await readBridgeAuthority(page)).toMatchObject({
    version: 1,
    appPrefix: "/a/next/",
    sessionId: SESSION_A_NEXT,
    cookies: [],
  });
  await expect.poll(async () =>
    (await readBridgeCaches(page, [CACHE_A]))[CACHE_A]?.entries ?? []
  ).not.toContain(`cookie-jar-${SESSION_A}`);
});

test("an old port response during init preparation cannot mutate the new authority", async ({
  context,
  page,
}) => {
  await page.goto(`${FIXTURE_ORIGIN}/a/`);
  await registerScope(page, "/a/");
  expect(await installBridge(page, "/a/app/", SESSION_A, "preparing-old"))
    .toEqual({
      reply: { type: "bridge-ready" },
      body: "bridge:preparing-old",
    });
  await setBridgeCookieValue(page, "preparing-old", "2");
  const worker = await injectReleasableCacheOperation(context, "put", 0);

  const transition = transitionAttempt(
    page,
    "/a/app/",
    SESSION_A,
    "prepared-new",
    2_000,
  );
  await expect.poll(() => worker.evaluate(() => (
    globalThis as typeof globalThis & { __cacheOperationEntered?: boolean }
  ).__cacheOperationEntered ?? false)).toBe(true);
  let oldFetchSettled = false;
  const oldFetch = fetchText(
    page,
    "/a/app/old-port-during-preparation",
  ).then((body) => {
    oldFetchSettled = true;
    return body;
  });
  await expect.poll(async () =>
    (await capturedCookies(page, "preparing-old")).length
  ).toBe(2);
  await page.waitForTimeout(200);
  const settledBeforeTransitionCommit = oldFetchSettled;
  await releaseCacheOperation(worker);

  expect(settledBeforeTransitionCommit).toBe(false);
  expect(await transition).toEqual({ type: "bridge-ready" });
  expect(await oldFetch).toBe("bridge:preparing-old");
  expect(await readBridgeAuthority(page)).toMatchObject({
    version: 1,
    appPrefix: "/a/app/",
    sessionId: SESSION_A,
    cookies: [{
      name: "preparing-old",
      value: "1",
      path: "/a/app/",
    }],
  });
  expect(await fetchText(page, "/a/app/new-port-after-preparation"))
    .toBe("replacement:prepared-new");
});

test("a navigation reset cannot be undone by an in-flight cookie commit", async ({
  context,
  page,
}) => {
  await page.goto(`${FIXTURE_ORIGIN}/a/`);
  await registerScope(page, "/a/");
  expect(await installBridge(page, "/a/app/", SESSION_A, "reset-race"))
    .toEqual({
      reply: { type: "bridge-ready" },
      body: "bridge:reset-race",
    });
  await setBridgeCookieValue(page, "reset-race", "2");
  const worker = await injectReleasableCacheOperation(context, "put", 0);

  const oldFetch = fetchText(page, "/a/app/before-navigation-reset");
  await expect.poll(() => worker.evaluate(() => (
    globalThis as typeof globalThis & { __cacheOperationEntered?: boolean }
  ).__cacheOperationEntered ?? false)).toBe(true);
  const resetPage = await context.newPage();
  try {
    await resetPage.goto(`${FIXTURE_ORIGIN}/a/navigation-reset`, {
      waitUntil: "domcontentloaded",
    });
  } finally {
    await resetPage.close();
  }
  await releaseCacheOperation(worker);

  expect(await oldFetch).toBe("bridge:reset-race");
  expect(await fetchText(page, "/a/app/after-navigation-reset"))
    .toBe("bridge:reset-race");
  expect((await capturedCookies(page, "reset-race")).at(-1)).toBe("");
});

test("two same-profile windows route app requests to their own bridges", async ({
  context,
  page,
}) => {
  await page.goto(`${FIXTURE_ORIGIN}/a/`);
  await registerScope(page, "/a/");
  expect(await installBridge(page, "/a/app/", SESSION_A, "window-a"))
    .toEqual({
      reply: { type: "bridge-ready" },
      body: "bridge:window-a",
    });

  const second = await context.newPage();
  try {
    await second.goto(`${FIXTURE_ORIGIN}/a/`);
    await registerScope(second, "/a/");
    expect(await installBridge(second, "/a/app/", SESSION_B, "window-b"))
      .toEqual({
        reply: { type: "bridge-ready" },
        body: "bridge:window-b",
      });

    expect(await fetchText(page, "/a/app/first-window-after-second-init"))
      .toBe("bridge:window-a");
    expect(await fetchText(page, "/a/app/first-window-own-cookie"))
      .toBe("bridge:window-a");
    expect((await capturedCookies(page, "window-a")).at(-1))
      .toBe("window-a=1");
    expect(await fetchText(second, "/a/app/second-window"))
      .toBe("bridge:window-b");
    expect((await capturedCookies(second, "window-b")).at(-1))
      .toBe("window-b=1");
    expect(await readBridgeAuthority(page)).toMatchObject({
      version: 1,
      appPrefix: "/a/app/",
      sessionId: SESSION_B,
    });
  } finally {
    await second.close();
  }
});

test("an app iframe follows its window's bridge across a demotion", async ({
  context,
  page,
}) => {
  await page.goto(`${FIXTURE_ORIGIN}/a/`);
  await registerScope(page, "/a/");
  expect(await installBridge(page, "/a/app/", SESSION_A, "frame-owner"))
    .toEqual({
      reply: { type: "bridge-ready" },
      body: "bridge:frame-owner",
    });
  await page.evaluate(() => new Promise<void>((resolve, reject) => {
    const frame = document.createElement("iframe");
    frame.src = "/a/app/frame";
    frame.onload = () => resolve();
    frame.onerror = () => reject(new Error("iframe failed to load"));
    document.body.appendChild(frame);
  }));

  const second = await context.newPage();
  try {
    await second.goto(`${FIXTURE_ORIGIN}/a/`);
    await registerScope(second, "/a/");
    expect(await installBridge(second, "/a/app/", SESSION_B, "frame-other"))
      .toEqual({
        reply: { type: "bridge-ready" },
        body: "bridge:frame-other",
      });

    const frame = page.frames().find((candidate) =>
      candidate.url().endsWith("/a/app/frame")
    );
    expect(frame).toBeTruthy();
    await frame!.evaluate(() => {
      location.assign("/a/app/frame-article");
    }).catch(() => {
      // The navigation may tear down the evaluation context first.
    });
    await frame!.waitForURL("**/a/app/frame-article");
    expect(await frame!.evaluate(() => document.body.textContent))
      .toBe("bridge:frame-owner");
    expect(await frame!.evaluate(async () => {
      const response = await fetch("/a/app/from-frame", { cache: "no-store" });
      return response.text();
    })).toBe("bridge:frame-owner");
    expect(await fetchText(second, "/a/app/second-window-own"))
      .toBe("bridge:frame-other");
  } finally {
    await second.close();
  }
});

test("a demoted window's departure keeps the live session's cookies", async ({
  context,
  page,
}) => {
  await page.goto(`${FIXTURE_ORIGIN}/a/`);
  await registerScope(page, "/a/");
  expect(await installBridge(page, "/a/app/", SESSION_A, "departing"))
    .toEqual({
      reply: { type: "bridge-ready" },
      body: "bridge:departing",
    });

  const second = await context.newPage();
  try {
    await second.goto(`${FIXTURE_ORIGIN}/a/`);
    await registerScope(second, "/a/");
    expect(await installBridge(second, "/a/app/", SESSION_B, "kept"))
      .toEqual({
        reply: { type: "bridge-ready" },
        body: "bridge:kept",
      });

    await page.goto(`${FIXTURE_ORIGIN}/a/departing-away`, {
      waitUntil: "domcontentloaded",
    });

    expect(await fetchText(second, "/a/app/after-first-window-left"))
      .toBe("bridge:kept");
    expect((await capturedCookies(second, "kept")).at(-1)).toBe("kept=1");
  } finally {
    await second.close();
  }
});

test("a second window's departure ends only its own session", async ({
  context,
  page,
}) => {
  await page.goto(`${FIXTURE_ORIGIN}/a/`);
  await registerScope(page, "/a/");
  expect(await installBridge(page, "/a/app/", SESSION_A, "staying"))
    .toEqual({
      reply: { type: "bridge-ready" },
      body: "bridge:staying",
    });

  const second = await context.newPage();
  try {
    await second.goto(`${FIXTURE_ORIGIN}/a/`);
    await registerScope(second, "/a/");
    expect(await installBridge(second, "/a/app/", SESSION_B, "leaving"))
      .toEqual({
        reply: { type: "bridge-ready" },
        body: "bridge:leaving",
      });
    expect(await fetchText(page, "/a/app/before-departure"))
      .toBe("bridge:staying");
    await second.goto(`${FIXTURE_ORIGIN}/a/departure`, {
      waitUntil: "domcontentloaded",
    });
  } finally {
    await second.close();
  }

  expect(await fetchText(page, "/a/app/after-departure"))
    .toBe("bridge:staying");
});

test("a delayed restoration cannot overwrite a newer acknowledged init", async ({
  context,
  page,
}) => {
  await page.goto(`${FIXTURE_ORIGIN}/a/`);
  await registerScope(page, "/a/");
  expect(await installBridge(page, "/a/app/", SESSION_A, "restore-old"))
    .toEqual({
      reply: { type: "bridge-ready" },
      body: "bridge:restore-old",
    });
  await installControlledRestoreResponder(page, {
    appPrefix: "/a/app/",
    sessionId: SESSION_A,
    label: "stale-restore",
  });
  await stopWorker(context, page, `${FIXTURE_ORIGIN}/a/service-worker.js`);

  const pendingFetch = fetchText(page, "/a/app/pending-restoration");
  await expect.poll(() => restoreResponderPending(page)).toBe(true);
  expect(await transitionAttempt(
    page,
    "/a/app/",
    SESSION_A_NEXT,
    "newer-init",
    1_000,
  )).toEqual({ type: "bridge-ready" });
  await releaseRestoreResponder(page);

  expect(await pendingFetch).toBe("replacement:newer-init");
  expect(await fetchText(page, "/a/app/after-stale-restoration"))
    .toBe("replacement:newer-init");
  expect(await staleRestoreBridgeRequestCount(page)).toBe(0);
  expect(await readBridgeAuthority(page)).toMatchObject({
    version: 1,
    appPrefix: "/a/app/",
    sessionId: SESSION_A_NEXT,
    cookies: [],
  });
});

test("a restoration begun during a blocked init cannot replace its committed port", async ({
  context,
  page,
}) => {
  await page.goto(`${FIXTURE_ORIGIN}/a/`);
  await registerScope(page, "/a/");
  expect(await installBridge(page, "/a/app/", SESSION_A, "pending-init-old"))
    .toEqual({
      reply: { type: "bridge-ready" },
      body: "bridge:pending-init-old",
    });
  await installRestoreResponder(page, {
    appPrefix: "/a/app/",
    sessionId: SESSION_A_NEXT,
    label: "pending-init-restore",
  });
  const worker = await injectReleasableCacheOperation(context, "put", 0);
  await worker.evaluate(() => {
    (globalThis as typeof globalThis & { bridgePort: MessagePort | null })
      .bridgePort = null;
  });

  const transition = transitionAttempt(
    page,
    "/a/app/",
    SESSION_A_NEXT,
    "pending-init-new",
    2_000,
  );
  await expect.poll(() => worker.evaluate(() => (
    globalThis as typeof globalThis & { __cacheOperationEntered?: boolean }
  ).__cacheOperationEntered ?? false)).toBe(true);
  const pendingFetch = fetchText(page, "/a/app/restore-during-init");
  await expect.poll(() => page.evaluate(() => (
    window as typeof window & { __needBridgeCount?: number }
  ).__needBridgeCount ?? 0)).toBe(1);
  await releaseCacheOperation(worker);

  expect(await transition).toEqual({ type: "bridge-ready" });
  const pendingBody = await Promise.race([
    pendingFetch,
    new Promise<string>((resolve) => setTimeout(
      () => resolve("fixture:pending-fetch-timeout"),
      3_000,
    )),
  ]);
  expect(pendingBody).toBe("replacement:pending-init-new");
  expect(await fetchText(page, "/a/app/after-pending-init-restore"))
    .toBe("replacement:pending-init-new");
  expect(await capturedCookies(page, "pending-init-restore")).toEqual([]);
  expect(await readBridgeAuthority(page)).toMatchObject({
    appPrefix: "/a/app/",
    sessionId: SESSION_A_NEXT,
    cookies: [],
  });
});

test("a claimed legacy authority commit outlives the discovery timeout", async ({
  context,
  page,
}) => {
  await page.goto(`${FIXTURE_ORIGIN}/a/`);
  await seedAppPrefix(page, CACHE_A, "/a/app/");
  await seedCookieJar(page, CACHE_A, SESSION_A, [
    { name: "claimed-legacy", value: "1", path: "/a/app/" },
  ]);
  await installRestoreResponder(page, {
    appPrefix: "/a/app/",
    sessionId: SESSION_A,
    label: "claimed-legacy",
  });
  await registerScope(page, "/a/");
  const worker = await injectReleasableCacheOperation(context, "put", 0);

  let fetchSettled = false;
  const pendingFetch = fetchText(page, "/a/app/claimed-legacy-timeout").then(
    (body) => {
      fetchSettled = true;
      return body;
    },
  );
  await expect.poll(() => worker.evaluate(() => (
    globalThis as typeof globalThis & { __cacheOperationEntered?: boolean }
  ).__cacheOperationEntered ?? false)).toBe(true);
  await page.waitForTimeout(5_250);
  const settledBeforeRelease = fetchSettled;
  const authorityBeforeRelease = await readBridgeAuthority(page);
  await releaseCacheOperation(worker);
  const body = await pendingFetch;
  const authorityAfterRelease = await readBridgeAuthority(page);

  expect(settledBeforeRelease).toBe(false);
  expect(authorityBeforeRelease).toBeNull();
  expect(body).toBe("bridge:claimed-legacy");
  expect((await capturedCookies(page, "claimed-legacy")).at(-1))
    .toBe("claimed-legacy=1");
  expect(authorityAfterRelease).toMatchObject({
    version: 1,
    appPrefix: "/a/app/",
    sessionId: SESSION_A,
    cookies: [{ name: "claimed-legacy", value: "1", path: "/a/app/" }],
  });
});

test("a newer init queued behind a claimed legacy commit remains final", async ({
  context,
  page,
}) => {
  await page.goto(`${FIXTURE_ORIGIN}/a/`);
  await seedAppPrefix(page, CACHE_A, "/a/app/");
  await seedCookieJar(page, CACHE_A, SESSION_A, [
    { name: "legacy-before-init", value: "1", path: "/a/app/" },
  ]);
  await installRestoreResponder(page, {
    appPrefix: "/a/app/",
    sessionId: SESSION_A,
    label: "legacy-before-init",
  });
  await registerScope(page, "/a/");
  const worker = await injectReleasableCacheOperation(context, "put", 0);

  const pendingFetch = fetchText(page, "/a/app/claimed-before-new-init");
  await expect.poll(() => worker.evaluate(() => (
    globalThis as typeof globalThis & { __cacheOperationEntered?: boolean }
  ).__cacheOperationEntered ?? false)).toBe(true);
  let initSettled = false;
  const newerInit = transitionAttempt(
    page,
    "/a/next/",
    SESSION_A_NEXT,
    "newer-after-legacy",
    10_000,
  ).then((reply) => {
    initSettled = true;
    return reply;
  });
  await page.waitForTimeout(200);
  const initSettledBeforeRelease = initSettled;
  await releaseCacheOperation(worker);

  expect(initSettledBeforeRelease).toBe(false);
  expect(await pendingFetch).toBe("bridge:legacy-before-init");
  expect(await newerInit).toEqual({ type: "bridge-ready" });
  expect(await fetchText(page, "/a/next/final-init-port"))
    .toBe("replacement:newer-after-legacy");
  expect(await capturedCookies(page, "legacy-before-init"))
    .toEqual(["legacy-before-init=1"]);
  expect(await readBridgeAuthority(page)).toMatchObject({
    version: 1,
    appPrefix: "/a/next/",
    sessionId: SESSION_A_NEXT,
    cookies: [],
  });
});

test("a timeout before a legacy candidate claim closes its port without mutation", async ({
  context,
  page,
}) => {
  await page.goto(`${FIXTURE_ORIGIN}/a/`);
  await seedAppPrefix(page, CACHE_A, "/a/app/");
  await seedCookieJar(page, CACHE_A, SESSION_A, [
    { name: "unclaimed-legacy", value: "1", path: "/a/app/" },
  ]);
  await installRestoreResponder(page, {
    appPrefix: "/a/app/",
    sessionId: SESSION_A,
    label: "unclaimed-legacy",
  });
  await registerScope(page, "/a/");
  expect(await fetchText(page, "/a/startup-ready"))
    .toBe("network:/a/startup-ready");
  const durableBefore = await cacheSnapshot(page);
  const worker = await injectReleasableCacheOperation(context, "match", 0);
  await observeWorkerPortCloses(worker);

  const timedOutFetch = fetchText(page, "/a/app/unclaimed-timeout");
  await expect.poll(() => worker.evaluate(() => (
    globalThis as typeof globalThis & { __cacheOperationEntered?: boolean }
  ).__cacheOperationEntered ?? false)).toBe(true);
  expect(await timedOutFetch)
    .toBe("Service worker bridge unavailable — please reload the page");
  const closesAtTimeout = await workerPortCloseCount(worker);
  await releaseCacheOperation(worker);

  expect(closesAtTimeout).toBe(1);
  await expect.poll(() => workerPortCloseCount(worker))
    .toBe(2);
  expect(await worker.evaluate(() => (
    globalThis as typeof globalThis & { bridgePort: MessagePort | null }
  ).bridgePort === null)).toBe(true);
  expect(await readBridgeAuthority(page)).toBeNull();
  expect(await cacheSnapshot(page)).toEqual(durableBefore);
});

test("a stale first client cannot starve a later matching restoration", async ({
  context,
  page,
}) => {
  await page.goto(`${FIXTURE_ORIGIN}/a/`);
  await registerScope(page, "/a/");
  expect(await installBridge(page, "/a/app/", SESSION_A, "multi-client-old"))
    .toEqual({
      reply: { type: "bridge-ready" },
      body: "bridge:multi-client-old",
    });

  const matchingPage = await context.newPage();
  let result: {
    body: string;
    staleCookies: string[];
    matchingCookies: string[];
  } | undefined;
  try {
    await matchingPage.goto(`${FIXTURE_ORIGIN}/a/second-client`);
    await installRestoreResponder(page, {
      appPrefix: "/a/app/",
      sessionId: SESSION_A_NEXT,
      label: "stale-first-client",
    });
    await installRestoreResponder(matchingPage, {
      appPrefix: "/a/app/",
      sessionId: SESSION_A,
      label: "matching-second-client",
      delayMs: 150,
    });
    await stopWorker(context, page, `${FIXTURE_ORIGIN}/a/service-worker.js`);

    const body = await fetchText(page, "/a/app/multi-client-restore");
    result = {
      body,
      staleCookies: await capturedCookies(page, "stale-first-client"),
      matchingCookies: await capturedCookies(
        matchingPage,
        "matching-second-client",
      ),
    };
  } finally {
    await matchingPage.close();
  }

  expect(result).toEqual({
    body: "bridge:matching-second-client",
    staleCookies: [],
    matchingCookies: ["multi-client-old=1"],
  });
});

test("a demoted window's answer after the authority commit still routes its own fetch", async ({
  context,
  page,
}) => {
  await page.goto(`${FIXTURE_ORIGIN}/a/`);
  await registerScope(page, "/a/");
  expect(await installBridge(page, "/a/app/", SESSION_A, "demoted-owner"))
    .toEqual({
      reply: { type: "bridge-ready" },
      body: "bridge:demoted-owner",
    });

  const authorityPage = await context.newPage();
  let result: { demotedBody: string; authorityBody: string } | undefined;
  try {
    await authorityPage.goto(`${FIXTURE_ORIGIN}/a/second-client`);
    await registerScope(authorityPage, "/a/");
    expect(await installBridge(authorityPage, "/a/app/", SESSION_B, "authority"))
      .toEqual({
        reply: { type: "bridge-ready" },
        body: "bridge:authority",
      });
    await installRestoreResponder(authorityPage, {
      appPrefix: "/a/app/",
      sessionId: SESSION_B,
      label: "authority-answer",
    });
    await installRestoreResponder(page, {
      appPrefix: "/a/app/",
      sessionId: SESSION_A,
      label: "demoted-answer",
      delayMs: 150,
    });
    await stopWorker(context, page, `${FIXTURE_ORIGIN}/a/service-worker.js`);

    result = {
      demotedBody: await fetchText(page, "/a/app/late-secondary-route"),
      authorityBody: await fetchText(authorityPage, "/a/app/authority-route"),
    };
  } finally {
    await authorityPage.close();
  }

  expect(result).toEqual({
    demotedBody: "bridge:demoted-answer",
    authorityBody: "bridge:authority-answer",
  });
});

test("a complete authority accepts its exact byte, field, count, and revision boundaries", async ({
  page,
}) => {
  const appPrefix = `/a/${"x".repeat(BRIDGE_APP_PREFIX_MAX_BYTES - 4)}/`;
  const boundaryName = "n".repeat(BRIDGE_COOKIE_NAME_MAX_BYTES);
  const boundaryValue = "é".repeat(BRIDGE_COOKIE_VALUE_MAX_BYTES / 2);
  const cookies = Array.from(
    { length: BRIDGE_AUTHORITY_MAX_COOKIES },
    (_, index) => ({
      name: index === 0 ? boundaryName : `cookie-${index}`,
      value: index === 0
        ? boundaryValue
        : String(index),
      path: index === 0 ? appPrefix : "/a/",
    }),
  );
  const authority: BridgeAuthoritySnapshot = {
    version: 1,
    revision: 0,
    appPrefix,
    sessionId: SESSION_A,
    cookies,
  };
  const authorityText = padAuthorityText(
    authority,
    BRIDGE_AUTHORITY_MAX_BYTES,
  );
  expect(new TextEncoder().encode(appPrefix).byteLength)
    .toBe(BRIDGE_APP_PREFIX_MAX_BYTES);
  expect(boundaryValue.length).toBe(BRIDGE_COOKIE_VALUE_MAX_BYTES / 2);
  expect(new TextEncoder().encode(boundaryValue).byteLength)
    .toBe(BRIDGE_COOKIE_VALUE_MAX_BYTES);
  expect(new TextEncoder().encode(authorityText).byteLength)
    .toBe(BRIDGE_AUTHORITY_MAX_BYTES);

  await page.goto(`${FIXTURE_ORIGIN}/a/`);
  await seedRawBridgeAuthority(page, CACHE_A, authorityText);
  await installRestoreResponder(page, {
    appPrefix,
    sessionId: SESSION_A,
    label: "authority-boundary",
  });
  await registerScope(page, "/a/");

  expect(await fetchText(page, `${appPrefix}boundary`))
    .toBe("bridge:authority-boundary");
  const outgoing = (await capturedCookies(page, "authority-boundary")).at(-1);
  expect(outgoing?.split("; ")).toHaveLength(BRIDGE_AUTHORITY_MAX_COOKIES);
  expect(outgoing).toContain(`${boundaryName}=${boundaryValue}`);
});

test("complete authority rejects every over-limit or malformed persisted field", async ({
  browser,
}) => {
  const validAuthority = (): BridgeAuthoritySnapshot => ({
    version: 1,
    revision: 1,
    appPrefix: "/a/app/",
    sessionId: SESSION_A,
    cookies: [{ name: "valid", value: "1", path: "/a/app/" }],
  });
  const invalidCases: Array<{
    label: string;
    authority: BridgeAuthoritySnapshot;
    text?: string;
  }> = [];

  const totalBytes = validAuthority();
  invalidCases.push({
    label: "total serialized bytes",
    authority: totalBytes,
    text: padAuthorityText(totalBytes, BRIDGE_AUTHORITY_MAX_BYTES + 1),
  });
  const cookieCount = validAuthority();
  cookieCount.cookies = Array.from(
    { length: BRIDGE_AUTHORITY_MAX_COOKIES + 1 },
    (_, index) => ({ name: `cookie-${index}`, value: "1", path: "/a/app/" }),
  );
  invalidCases.push({ label: "cookie count", authority: cookieCount });
  const nameBytes = validAuthority();
  nameBytes.cookies[0]!.name = "n".repeat(BRIDGE_COOKIE_NAME_MAX_BYTES + 1);
  invalidCases.push({ label: "cookie name bytes", authority: nameBytes });
  const nameSyntax = validAuthority();
  nameSyntax.cookies[0]!.name = "invalid cookie name";
  invalidCases.push({ label: "cookie name syntax", authority: nameSyntax });
  const valueBytes = validAuthority();
  valueBytes.cookies[0]!.value =
    "é".repeat(BRIDGE_COOKIE_VALUE_MAX_BYTES / 2) + "x";
  expect(valueBytes.cookies[0]!.value.length)
    .toBeLessThan(BRIDGE_COOKIE_VALUE_MAX_BYTES);
  expect(new TextEncoder().encode(valueBytes.cookies[0]!.value).byteLength)
    .toBe(BRIDGE_COOKIE_VALUE_MAX_BYTES + 1);
  invalidCases.push({ label: "cookie value bytes", authority: valueBytes });
  const valueSyntax = validAuthority();
  valueSyntax.cookies[0]!.value = "invalid;\nvalue";
  invalidCases.push({ label: "cookie value syntax", authority: valueSyntax });
  const pathBytes = validAuthority();
  pathBytes.cookies[0]!.path =
    `/a/${"p".repeat(BRIDGE_COOKIE_PATH_MAX_BYTES - 2)}`;
  invalidCases.push({ label: "cookie path bytes", authority: pathBytes });
  const pathSyntax = validAuthority();
  pathSyntax.cookies[0]!.path = "/b/outside-scope";
  invalidCases.push({ label: "cookie path syntax", authority: pathSyntax });
  const prefixBytes = validAuthority();
  prefixBytes.appPrefix =
    `/a/${"x".repeat(BRIDGE_APP_PREFIX_MAX_BYTES - 3)}/`;
  invalidCases.push({ label: "app-prefix bytes", authority: prefixBytes });
  const revision = validAuthority();
  revision.revision = Number.MAX_SAFE_INTEGER;
  invalidCases.push({ label: "MAX_SAFE revision", authority: revision });

  for (const invalid of invalidCases) {
    const isolatedContext = await browser.newContext({ serviceWorkers: "allow" });
    const isolatedPage = await isolatedContext.newPage();
    try {
      await isolatedPage.goto(`${FIXTURE_ORIGIN}/a/`);
      await seedAppPrefix(isolatedPage, CACHE_A, "/a/app/");
      await seedCookieJar(isolatedPage, CACHE_A, SESSION_A, [
        { name: "legacy", value: "1", path: "/a/app/" },
      ]);
      if (invalid.text) {
        await seedRawBridgeAuthority(isolatedPage, CACHE_A, invalid.text);
      } else {
        await seedBridgeAuthority(isolatedPage, CACHE_A, invalid.authority);
      }
      const durableBefore = await cacheSnapshot(isolatedPage);
      await installRestoreResponder(isolatedPage, {
        appPrefix: invalid.authority.appPrefix,
        sessionId: invalid.authority.sessionId,
        label: `invalid-${invalid.label}`,
      });
      await registerScope(isolatedPage, "/a/");
      const probePath = `${invalid.authority.appPrefix}invalid-authority`;

      expect.soft(
        await fetchText(isolatedPage, probePath),
        invalid.label,
      ).toBe(`network:${probePath}`);
      expect.soft(await isolatedPage.evaluate(() => (
        window as typeof window & { __needBridgeCount?: number }
      ).__needBridgeCount ?? 0), invalid.label).toBe(0);
      expect.soft(await cacheSnapshot(isolatedPage), invalid.label)
        .toEqual(durableBefore);
    } finally {
      await isolatedContext.close();
    }
  }
});

test("the highest accepted revision cannot advance to a restart-rejected record", async ({
  page,
}) => {
  const authority: BridgeAuthoritySnapshot = {
    version: 1,
    revision: Number.MAX_SAFE_INTEGER - 1,
    appPrefix: "/a/app/",
    sessionId: SESSION_A,
    cookies: [{ name: "revision", value: "1", path: "/a/app/" }],
  };
  await page.goto(`${FIXTURE_ORIGIN}/a/`);
  await seedBridgeAuthority(page, CACHE_A, authority);
  await installRestoreResponder(page, {
    appPrefix: authority.appPrefix,
    sessionId: authority.sessionId,
    label: "revision-boundary",
  });
  await registerScope(page, "/a/");
  expect(await fetchText(page, "/a/app/revision-before"))
    .toBe("bridge:revision-boundary");
  const durableBefore = await cacheSnapshot(page);

  expect(await transitionAttempt(
    page,
    "/a/app/",
    SESSION_A_NEXT,
    "unsafe-revision",
  )).toEqual({ type: "bridge-error", code: "bridge-init-failed" });
  expect(await fetchText(page, "/a/app/revision-after"))
    .toBe("bridge:revision-boundary");
  expect((await capturedCookies(page, "revision-boundary")).at(-1))
    .toBe("revision=1");
  expect(await cacheSnapshot(page)).toEqual(durableBefore);
  expect(await replacementBridgeRequestCount(page)).toBe(0);
});

test("an oversized live Set-Cookie cannot create restart-invalid authority bytes", async ({
  page,
}) => {
  await page.goto(`${FIXTURE_ORIGIN}/a/`);
  await registerScope(page, "/a/");
  expect(await installBridge(page, "/a/app/", SESSION_A, "bounded-live"))
    .toEqual({
      reply: { type: "bridge-ready" },
      body: "bridge:bounded-live",
    });
  const durableBefore = await cacheSnapshot(page);
  const oversizedValue =
    "é".repeat(BRIDGE_COOKIE_VALUE_MAX_BYTES / 2) + "x";
  expect(oversizedValue.length).toBeLessThan(BRIDGE_COOKIE_VALUE_MAX_BYTES);
  expect(new TextEncoder().encode(oversizedValue).byteLength)
    .toBe(BRIDGE_COOKIE_VALUE_MAX_BYTES + 1);
  await setBridgeCookieValue(
    page,
    "bounded-live",
    oversizedValue,
  );

  expect(await fetchText(page, "/a/app/oversized-live-cookie"))
    .toBe("bridge:bounded-live");
  expect(await cacheSnapshot(page)).toEqual(durableBefore);
  expect(await fetchText(page, "/a/app/after-oversized-live-cookie"))
    .toBe("bridge:bounded-live");
  expect((await capturedCookies(page, "bounded-live")).at(-1))
    .toBe("bounded-live=1");
});

test("restart rejects invalid restoration, then restores only its scoped session", async ({
  context,
  page,
}) => {
  await page.goto(`${FIXTURE_ORIGIN}/a/`);
  await seedCaches(page, [CACHE_B, LAZY_CACHE_A, "sw-bridge-config"]);
  await registerScope(page, "/a/");
  expect(await installBridge(page, "/a/app/", SESSION_A, "before-restart"))
    .toEqual({
      reply: { type: "bridge-ready" },
      body: "bridge:before-restart",
    });
  await seedCookieJar(page, CACHE_A, SESSION_A_NEXT, [
    { name: "wrong-session", value: "1", path: "/a/app/" },
  ]);
  await seedCookieJar(page, CACHE_B, SESSION_A, [
    { name: "wrong-scope", value: "1", path: "/a/app/" },
  ]);
  const before = await cacheSnapshot(page);
  await installRestoreResponder(page, {
    appPrefix: "/b/app/",
    sessionId: SESSION_A,
    label: "invalid-restore",
  });
  await stopWorker(context, page, `${FIXTURE_ORIGIN}/a/service-worker.js`);

  const invalidResponse = await page.evaluate(async () => {
    const response = await fetch("/a/app/after-invalid-restore", {
      cache: "no-store",
    });
    return { status: response.status, body: await response.text() };
  });
  expect(invalidResponse).toEqual({
    status: 503,
    body: "Service worker bridge unavailable — please reload the page",
  });
  expect(await cacheSnapshot(page)).toEqual(before);

  await updateRestoreResponder(page, {
    appPrefix: "/a/app/",
    sessionId: SESSION_A,
    label: "valid-restore",
  });
  expect(await fetchText(page, "/a/app/after-valid-restore"))
    .toBe("bridge:valid-restore");
  expect((await capturedCookies(page, "valid-restore")).at(-1))
    .toBe("before-restart=1");
  expect(await page.evaluate(() => (
    window as typeof window & { __needBridgeCount?: number }
  ).__needBridgeCount ?? 0)).toBe(2);
  expect((await readBridgeCaches(page, [CACHE_B]))[CACHE_B]).toEqual({
    appPrefix: null,
    entries: [
      `cookie-jar-${SESSION_A}`,
      "seed",
    ],
  });
  expect((await cacheNames(page)).sort()).toEqual([
    CACHE_A,
    CACHE_B,
    LAZY_CACHE_A,
    "sw-bridge-config",
  ].sort());
});

test("production COI reload state is scoped while the theme remains origin-wide", async ({
  page,
}) => {
  const { createCoiReloadSessionState } = await import(
    "../pages/kandelo/kernel-host/coi-reload-session-state"
  );
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
  const stateA = createCoiReloadSessionState("/a/", storage);
  const stateB = createCoiReloadSessionState("/b/", storage);
  expect([stateA.wasAttempted(), stateB.wasAttempted()]).toEqual([
    false,
    false,
  ]);
  stateA.markAttempted();
  expect([stateA.wasAttempted(), stateB.wasAttempted()]).toEqual([true, false]);
  stateB.markAttempted();
  stateA.clear();
  expect([stateA.wasAttempted(), stateB.wasAttempted()]).toEqual([false, true]);

  await page.goto(`${FIXTURE_ORIGIN}/a/`);
  await page.evaluate(() => {
    localStorage.setItem("kandelo.theme", "dark");
  });
  await page.goto(`${FIXTURE_ORIGIN}/b/`);
  expect(await page.evaluate(() => localStorage.getItem("kandelo.theme")))
    .toBe("dark");
});

test("the exact worker accepts canonical scopes and rejects noncanonical scope paths", async ({
  page,
}) => {
  await page.goto(`${FIXTURE_ORIGIN}/validator/`);
  for (const [scriptPath, scopePath] of [
    ["/service-worker.js", "/"],
    ["/a/service-worker.js", "/a/"],
    ["/nested/kandelo-2/service-worker.js", "/nested/kandelo-2/"],
    ["/safe%20space/service-worker.js", "/safe%20space/"],
  ]) {
    expect.soft(await registrationOutcome(page, scriptPath, scopePath))
      .toMatchObject({ activated: true, scope: `${FIXTURE_ORIGIN}${scopePath}` });
  }

  for (const scopePath of [
    "/validator/no-trailing",
    "/validator//nested/",
    "/validator/%252e%252e/nested/",
    "/validator/%2f/nested/",
    "/validator/%5c/nested/",
    "/validator/%2500/nested/",
  ]) {
    expect.soft(
      (await registrationOutcome(
        page,
        "/validator/service-worker.js",
        scopePath,
      )).activated,
      `scope ${scopePath}`,
    ).toBe(false);
  }
  expect((await registrationOutcome(
    page,
    "data:text/javascript,worker",
    "/validator/",
  )).activated).toBe(false);
  expect((await registrationOutcome(
    page,
    "ftp://example.invalid/service-worker.js",
    "/validator/",
  )).activated).toBe(false);
  expect((await registrationOutcome(
    page,
    "https://example.invalid/service-worker.js",
    "/validator/",
  )).activated).toBe(false);
});

async function seedCaches(page: Page, names: readonly string[]): Promise<void> {
  await page.evaluate(async (cacheNamesToSeed) => {
    for (const name of cacheNamesToSeed) {
      const cache = await caches.open(name);
      await cache.put("seed", new Response(name));
    }
  }, names);
}

async function seedAppPrefix(
  page: Page,
  cacheName: string,
  appPrefix: string,
): Promise<void> {
  await page.evaluate(async ({ name, prefix }) => {
    const cache = await caches.open(name);
    await cache.put("app-prefix", new Response(prefix));
  }, { name: cacheName, prefix: appPrefix });
}

async function cacheNames(page: Page): Promise<string[]> {
  return page.evaluate(() => caches.keys());
}

function groupedWorkerSource(): string {
  if (groupedWorkerCacheVersion === undefined) return workerSource;
  return workerSource.replace(
    `null /*${VFS_LAZY_CACHE_VERSION_PLACEHOLDER}*/`,
    JSON.stringify(groupedWorkerCacheVersion),
  );
}

function lazyCacheName(scope: string, manifestSha256: string): string {
  return `kandelo-sw:${encodeURIComponent(scope)}:lazy-assets-v1:${manifestSha256}`;
}

async function updateScope(
  page: Page,
  scopePath: "/a/",
): Promise<void> {
  await page.evaluate(async (scope) => {
    const registration = await navigator.serviceWorker.getRegistration(scope);
    if (registration === undefined) {
      throw new Error(`missing service worker registration for ${scope}`);
    }
    const prior = navigator.serviceWorker.controller;
    const changed = new Promise<void>((resolve, reject) => {
      const timeout = window.setTimeout(
        () => reject(new Error("timed out waiting for service worker update")),
        10_000,
      );
      const onControllerChange = () => {
        if (navigator.serviceWorker.controller === prior) return;
        navigator.serviceWorker.removeEventListener(
          "controllerchange",
          onControllerChange,
        );
        window.clearTimeout(timeout);
        resolve();
      };
      navigator.serviceWorker.addEventListener("controllerchange", onControllerChange);
    });
    await registration.update();
    if (navigator.serviceWorker.controller !== prior) return;
    await changed;
  }, scopePath);
}

async function registerScope(
  page: Page,
  scopePath: "/a/" | "/b/" | "/candidate-b/",
): Promise<void> {
  await page.evaluate(async (scope) => {
    const scriptUrl = new URL(`${scope}service-worker.js`, location.href).href;
    const registration = await navigator.serviceWorker.register(scriptUrl, {
      scope,
      updateViaCache: "none",
    });
    if (registration.scope !== new URL(scope, location.href).href) {
      throw new Error(`unexpected registration scope ${registration.scope}`);
    }
    const candidate = registration.installing ?? registration.waiting ??
      registration.active;
    if (candidate && candidate.state !== "activated") {
      await new Promise<void>((resolve, reject) => {
        const timeout = window.setTimeout(
          () => reject(new Error("timed out waiting for activation")),
          10_000,
        );
        candidate.addEventListener("statechange", () => {
          if (candidate.state === "activated") {
            window.clearTimeout(timeout);
            resolve();
          } else if (candidate.state === "redundant") {
            window.clearTimeout(timeout);
            reject(new Error("service worker became redundant"));
          }
        });
      });
    }
    if (navigator.serviceWorker.controller?.scriptURL !== scriptUrl) {
      await new Promise<void>((resolve, reject) => {
        const timeout = window.setTimeout(
          () => reject(new Error("timed out waiting for exact controller")),
          10_000,
        );
        const onControllerChange = () => {
          if (navigator.serviceWorker.controller?.scriptURL !== scriptUrl) return;
          navigator.serviceWorker.removeEventListener(
            "controllerchange",
            onControllerChange,
          );
          window.clearTimeout(timeout);
          resolve();
        };
        navigator.serviceWorker.addEventListener(
          "controllerchange",
          onControllerChange,
        );
      });
    }
  }, scopePath);
}

async function installBridge(
  page: Page,
  appPrefix: string,
  sessionId: string,
  label: string,
): Promise<{ reply: unknown; body: string }> {
  return page.evaluate(async ({ prefix, session, responseLabel }) => {
    const controller = navigator.serviceWorker.controller;
    if (!controller) throw new Error("service worker does not control fixture");
    const keepAlive = window as typeof window & {
      __bridgePorts?: MessagePort[];
      __bridgeCookies?: Record<string, string[]>;
      __bridgeCookieValues?: Record<string, string>;
    };
    keepAlive.__bridgePorts ??= [];
    keepAlive.__bridgeCookies ??= {};
    keepAlive.__bridgeCookieValues ??= {};
    keepAlive.__bridgeCookies[responseLabel] ??= [];
    const bridge = new MessageChannel();
    bridge.port1.onmessage = (event) => {
      if (event.data?.type !== "http-request") return;
      keepAlive.__bridgeCookies![responseLabel].push(
        event.data.headers?.cookie ?? "",
      );
      bridge.port1.postMessage({
        type: "http-response",
        requestId: event.data.requestId,
        status: 200,
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Set-Cookie": `${responseLabel}=${
            keepAlive.__bridgeCookieValues![responseLabel] ?? "1"
          }; Path=/`,
        },
        body: new TextEncoder().encode(`bridge:${responseLabel}`),
      });
    };
    bridge.port1.start();
    const reply = new MessageChannel();
    const replyData = new Promise<unknown>((resolve, reject) => {
      const timeout = window.setTimeout(
        () => reject(new Error("timed out waiting for bridge reply")),
        2_000,
      );
      reply.port1.onmessage = (event) => {
        window.clearTimeout(timeout);
        resolve(event.data);
      };
      reply.port1.start();
    });
    keepAlive.__bridgePorts.push(bridge.port1, reply.port1);
    controller.postMessage(
      { type: "init-bridge", appPrefix: prefix, sessionId: session },
      [bridge.port2, reply.port2],
    );
    const acknowledged = await replyData;
    const response = await fetch(`${prefix}cookie`, { cache: "no-store" });
    return { reply: acknowledged, body: await response.text() };
  }, { prefix: appPrefix, session: sessionId, responseLabel: label });
}

async function setBridgeCookieValue(
  page: Page,
  label: string,
  value: string,
): Promise<void> {
  await page.evaluate(({ responseLabel, cookieValue }) => {
    const keepAlive = window as typeof window & {
      __bridgeCookieValues?: Record<string, string>;
    };
    keepAlive.__bridgeCookieValues ??= {};
    keepAlive.__bridgeCookieValues[responseLabel] = cookieValue;
  }, { responseLabel: label, cookieValue: value });
}

async function transitionAttempt(
  page: Page,
  appPrefix: string,
  sessionId: string,
  label: string,
  timeoutMs = 500,
): Promise<unknown | null> {
  return page.evaluate(async ({ prefix, session, responseLabel, timeout }) => {
    const controller = navigator.serviceWorker.controller;
    if (!controller) throw new Error("service worker does not control fixture");
    const keepAlive = window as typeof window & {
      __bridgePorts?: MessagePort[];
      __replacementBridgeRequests?: number;
    };
    keepAlive.__bridgePorts ??= [];
    keepAlive.__replacementBridgeRequests ??= 0;
    const bridge = new MessageChannel();
    bridge.port1.onmessage = (event) => {
      if (event.data?.type !== "http-request") return;
      keepAlive.__replacementBridgeRequests! += 1;
      bridge.port1.postMessage({
        type: "http-response",
        requestId: event.data.requestId,
        status: 200,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
        body: new TextEncoder().encode(`replacement:${responseLabel}`),
      });
    };
    bridge.port1.start();
    const reply = new MessageChannel();
    reply.port1.start();
    keepAlive.__bridgePorts.push(bridge.port1, reply.port1);
    const replyData = new Promise<unknown>((resolve) => {
      reply.port1.onmessage = (event) => resolve(event.data);
    });
    controller.postMessage(
      { type: "init-bridge", appPrefix: prefix, sessionId: session },
      [bridge.port2, reply.port2],
    );
    return Promise.race([
      replyData,
      new Promise<null>((resolve) => window.setTimeout(() => resolve(null), timeout)),
    ]);
  }, {
    prefix: appPrefix,
    session: sessionId,
    responseLabel: label,
    timeout: timeoutMs,
  });
}

async function initAttempt(
  page: Page,
  appPrefix: unknown,
  sessionId: unknown,
  label: string,
  portCount = 2,
): Promise<unknown> {
  return page.evaluate(async ({ prefix, session, responseLabel, ports }) => {
    const controller = navigator.serviceWorker.controller;
    if (!controller) throw new Error("service worker does not control fixture");
    const keepAlive = window as typeof window & {
      __bridgePorts?: MessagePort[];
      __replacementBridgeRequests?: number;
    };
    keepAlive.__bridgePorts ??= [];
    keepAlive.__replacementBridgeRequests ??= 0;
    const replacement = new MessageChannel();
    replacement.port1.onmessage = (event) => {
      keepAlive.__replacementBridgeRequests! += 1;
      replacement.port1.postMessage({
        type: "http-response",
        requestId: event.data.requestId,
        status: 200,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
        body: new TextEncoder().encode(`replacement:${responseLabel}`),
      });
    };
    replacement.port1.start();
    keepAlive.__bridgePorts.push(replacement.port1);
    const message = {
      type: "init-bridge",
      appPrefix: prefix,
      sessionId: session,
    };
    if (ports === 0) {
      controller.postMessage(message);
      await new Promise((resolve) => window.setTimeout(resolve, 100));
      return null;
    }
    if (ports === 1) {
      controller.postMessage(message, [replacement.port2]);
      await new Promise((resolve) => window.setTimeout(resolve, 100));
      return null;
    }
    const reply = new MessageChannel();
    keepAlive.__bridgePorts.push(reply.port1);
    const replyData = new Promise<unknown>((resolve, reject) => {
      const timeout = window.setTimeout(
        () => reject(new Error("timed out waiting for invalid reply")),
        2_000,
      );
      reply.port1.onmessage = (event) => {
        window.clearTimeout(timeout);
        resolve(event.data);
      };
      reply.port1.start();
    });
    controller.postMessage(message, [replacement.port2, reply.port2]);
    return replyData;
  }, {
    prefix: appPrefix,
    session: sessionId,
    responseLabel: label,
    ports: portCount,
  });
}

async function fetchText(page: Page, pathname: string): Promise<string> {
  return page.evaluate(async (path) => {
    const response = await fetch(path, { cache: "no-store" });
    return response.text();
  }, pathname);
}

async function fetchResponse(
  page: Page,
  pathname: string,
): Promise<{ status: number; body: string; contentLength: string | null }> {
  return page.evaluate(async (path) => {
    const response = await fetch(path, { cache: "no-store" });
    return {
      status: response.status,
      body: await response.text(),
      contentLength: response.headers.get("content-length"),
    };
  }, pathname);
}

async function fetchBytes(page: Page, pathname: string): Promise<void> {
  await page.evaluate(async (path) => {
    const response = await fetch(path, { cache: "no-store" });
    await response.arrayBuffer();
  }, pathname);
}

async function lazyCacheEntries(page: Page, cacheName: string): Promise<string[]> {
  return page.evaluate(async (name) => {
    if (!(await caches.keys()).includes(name)) return [];
    const cache = await caches.open(name);
    return (await cache.keys()).map((request) => new URL(request.url).pathname)
      .sort();
  }, cacheName);
}

async function readBridgeCaches(
  page: Page,
  names: string[],
): Promise<Record<string, { appPrefix: string | null; entries: string[] }>> {
  return page.evaluate(async (cacheNamesToRead) => {
    const available = new Set(await caches.keys());
    const out: Record<string, { appPrefix: string | null; entries: string[] }> = {};
    for (const name of cacheNamesToRead) {
      if (!available.has(name)) continue;
      const cache = await caches.open(name);
      const requests = await cache.keys();
      const appPrefixRequest = requests.find((request) =>
        (new URL(request.url).pathname.split("/").pop() ?? "") === "app-prefix"
      );
      const appPrefix = appPrefixRequest
        ? await cache.match(appPrefixRequest)
        : undefined;
      out[name] = {
        appPrefix: appPrefix ? await appPrefix.text() : null,
        entries: requests.map((request) =>
          new URL(request.url).pathname.split("/").pop() ?? ""
        ).sort(),
      };
    }
    return out;
  }, names);
}

async function cacheSnapshot(
  page: Page,
): Promise<Record<string, Array<{ key: string; value: string }>>> {
  return page.evaluate(async () => {
    const out: Record<string, Array<{ key: string; value: string }>> = {};
    for (const name of (await caches.keys()).sort()) {
      const cache = await caches.open(name);
      const entries = [];
      for (const request of await cache.keys()) {
        const response = await cache.match(request);
        entries.push({
          key: new URL(request.url).pathname.split("/").pop() ?? "",
          value: response ? await response.text() : "",
        });
      }
      out[name] = entries.sort((a, b) => a.key.localeCompare(b.key));
    }
    return out;
  });
}

interface BridgeAuthoritySnapshot {
  version: number;
  revision: number;
  appPrefix: string;
  sessionId: string;
  cookies: Array<{ name: string; value: string; path: string }>;
}

function padAuthorityText(
  authority: BridgeAuthoritySnapshot,
  targetBytes: number,
): string {
  const text = JSON.stringify(authority);
  const byteLength = new TextEncoder().encode(text).byteLength;
  if (byteLength > targetBytes) {
    throw new Error(
      `authority is ${byteLength} bytes, above target ${targetBytes}`,
    );
  }
  return text + " ".repeat(targetBytes - byteLength);
}

async function readBridgeAuthority(
  page: Page,
  cacheName = CACHE_A,
): Promise<BridgeAuthoritySnapshot | null> {
  return page.evaluate(async ({ cacheName, authorityKey }) => {
    const cache = await caches.open(cacheName);
    const authorityRequest = (await cache.keys()).find((request) =>
      (new URL(request.url).pathname.split("/").pop() ?? "") === authorityKey
    );
    const response = authorityRequest
      ? await cache.match(authorityRequest)
      : undefined;
    return response ? JSON.parse(await response.text()) : null;
  }, { cacheName, authorityKey: BRIDGE_AUTHORITY_KEY });
}

async function seedCookieJar(
  page: Page,
  cacheName: string,
  sessionId: string,
  records: Array<{ name: string; value: string; path: string }>,
): Promise<void> {
  await page.evaluate(async ({ name, session, cookies }) => {
    const cache = await caches.open(name);
    await cache.put(
      `cookie-jar-${session}`,
      new Response(JSON.stringify(cookies), {
        headers: { "Content-Type": "application/json" },
      }),
    );
  }, { name: cacheName, session: sessionId, cookies: records });
}

async function seedBridgeAuthority(
  page: Page,
  cacheName: string,
  authority: BridgeAuthoritySnapshot,
): Promise<void> {
  await page.evaluate(async ({ name, key, record }) => {
    const cache = await caches.open(name);
    await cache.put(
      key,
      new Response(JSON.stringify(record), {
        headers: { "Content-Type": "application/json" },
      }),
    );
  }, { name: cacheName, key: BRIDGE_AUTHORITY_KEY, record: authority });
}

async function seedRawBridgeAuthority(
  page: Page,
  cacheName: string,
  authorityText: string,
): Promise<void> {
  await page.evaluate(async ({ name, key, text }) => {
    const cache = await caches.open(name);
    await cache.put(
      key,
      new Response(text, {
        headers: { "Content-Type": "application/json" },
      }),
    );
  }, { name: cacheName, key: BRIDGE_AUTHORITY_KEY, text: authorityText });
}

async function capturedCookies(page: Page, label: string): Promise<string[]> {
  return page.evaluate((responseLabel) => (
    window as typeof window & { __bridgeCookies?: Record<string, string[]> }
  ).__bridgeCookies?.[responseLabel] ?? [], label);
}

async function replacementBridgeRequestCount(page: Page): Promise<number> {
  return page.evaluate(() => (
    window as typeof window & { __replacementBridgeRequests?: number }
  ).__replacementBridgeRequests ?? 0);
}

async function injectCacheOperation(
  context: BrowserContext,
  operation: "open" | "match" | "put" | "delete",
  outcome: "reject" | "block",
  failAfter: number,
): Promise<Worker> {
  const workerUrl = `${FIXTURE_ORIGIN}/a/service-worker.js`;
  const worker = context.serviceWorkers().find((candidate) =>
    candidate.url() === workerUrl
  );
  if (!worker) throw new Error(`missing exact service worker ${workerUrl}`);
  await worker.evaluate(({ cacheName, operationName, operationOutcome, after }) => {
    const fixtureGlobal = globalThis as typeof globalThis & {
      __cacheOperationEntered?: boolean;
    };
    fixtureGlobal.__cacheOperationEntered = false;
    const originalOpen = caches.open.bind(caches);
    let calls = 0;
    Object.defineProperty(caches, "open", {
      configurable: true,
      value: async (name: string) => {
        if (name === cacheName && operationName === "open") {
          if (calls++ >= after) {
            fixtureGlobal.__cacheOperationEntered = true;
            if (operationOutcome === "block") {
              return new Promise<Cache>(() => {});
            }
            throw new Error("injected CacheStorage.open failure");
          }
        }
        const cache = await originalOpen(name);
        if (name !== cacheName || operationName === "open") return cache;
        return new Proxy(cache, {
          get(target, property) {
            const value = Reflect.get(target, property, target);
            if (property === operationName && typeof value === "function") {
              return (...args: unknown[]) => {
                if (calls++ >= after) {
                  fixtureGlobal.__cacheOperationEntered = true;
                  if (operationOutcome === "block") {
                    return new Promise<never>(() => {});
                  }
                  return Promise.reject(
                    new Error(`injected Cache.${operationName} failure`),
                  );
                }
                return value.apply(target, args);
              };
            }
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
      },
    });
  }, {
    cacheName: CACHE_A,
    operationName: operation,
    operationOutcome: outcome,
    after: failAfter,
  });
  return worker;
}

async function injectRollbackFailure(context: BrowserContext): Promise<void> {
  const workerUrl = `${FIXTURE_ORIGIN}/a/service-worker.js`;
  const worker = context.serviceWorkers().find((candidate) =>
    candidate.url() === workerUrl
  );
  if (!worker) throw new Error(`missing exact service worker ${workerUrl}`);
  await worker.evaluate((cacheName) => {
    const originalOpen = caches.open.bind(caches);
    let putCalls = 0;
    let deleteCalls = 0;
    Object.defineProperty(caches, "open", {
      configurable: true,
      value: async (name: string) => {
        const cache = await originalOpen(name);
        if (name !== cacheName) return cache;
        return new Proxy(cache, {
          get(target, property) {
            const value = Reflect.get(target, property, target);
            if (property === "put") {
              return (...args: unknown[]) => {
                if (putCalls++ >= 1) {
                  return Promise.reject(new Error("injected rollback put failure"));
                }
                return value.apply(target, args);
              };
            }
            if (property === "delete") {
              return (...args: unknown[]) => {
                if (deleteCalls++ >= 1) {
                  return Promise.reject(new Error("injected cleanup delete failure"));
                }
                return value.apply(target, args);
              };
            }
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
      },
    });
  }, CACHE_A);
}

async function injectReleasableCacheOperation(
  context: BrowserContext,
  operation: "match" | "put" | "delete",
  blockAfter: number,
): Promise<Worker> {
  const workerUrl = `${FIXTURE_ORIGIN}/a/service-worker.js`;
  const worker = context.serviceWorkers().find((candidate) =>
    candidate.url() === workerUrl
  );
  if (!worker) throw new Error(`missing exact service worker ${workerUrl}`);
  await worker.evaluate(({ cacheName, operationName, after }) => {
    const fixtureGlobal = globalThis as typeof globalThis & {
      __cacheOperationEntered?: boolean;
      __releaseCacheOperation?: () => void;
    };
    fixtureGlobal.__cacheOperationEntered = false;
    fixtureGlobal.__releaseCacheOperation = undefined;
    const originalOpen = caches.open.bind(caches);
    let calls = 0;
    let blocked = false;
    Object.defineProperty(caches, "open", {
      configurable: true,
      value: async (name: string) => {
        const cache = await originalOpen(name);
        if (name !== cacheName) return cache;
        return new Proxy(cache, {
          get(target, property) {
            const value = Reflect.get(target, property, target);
            if (property === operationName && typeof value === "function") {
              return (...args: unknown[]) => {
                if (!blocked && calls++ >= after) {
                  blocked = true;
                  fixtureGlobal.__cacheOperationEntered = true;
                  return new Promise((resolve, reject) => {
                    fixtureGlobal.__releaseCacheOperation = () => {
                      Promise.resolve(value.apply(target, args)).then(
                        resolve,
                        reject,
                      );
                    };
                  });
                }
                return value.apply(target, args);
              };
            }
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
      },
    });
  }, { cacheName: CACHE_A, operationName: operation, after: blockAfter });
  return worker;
}

async function releaseCacheOperation(worker: Worker): Promise<void> {
  await worker.evaluate(() => {
    const fixtureGlobal = globalThis as typeof globalThis & {
      __releaseCacheOperation?: () => void;
    };
    if (!fixtureGlobal.__releaseCacheOperation) {
      throw new Error("no blocked cache operation to release");
    }
    fixtureGlobal.__releaseCacheOperation();
  });
}

async function observeWorkerPortCloses(worker: Worker): Promise<void> {
  await worker.evaluate(() => {
    const fixtureGlobal = globalThis as typeof globalThis & {
      __portCloseCount?: number;
    };
    fixtureGlobal.__portCloseCount = 0;
    const originalClose = MessagePort.prototype.close;
    Object.defineProperty(MessagePort.prototype, "close", {
      configurable: true,
      value: function (this: MessagePort) {
        fixtureGlobal.__portCloseCount! += 1;
        return originalClose.call(this);
      },
    });
  });
}

async function workerPortCloseCount(worker: Worker): Promise<number> {
  return worker.evaluate(() => (
    globalThis as typeof globalThis & { __portCloseCount?: number }
  ).__portCloseCount ?? 0);
}

async function installControlledRestoreResponder(
  page: Page,
  state: { appPrefix: string; sessionId: string; label: string },
): Promise<void> {
  await page.evaluate((restoreState) => {
    const fixtureWindow = window as typeof window & {
      __bridgePorts?: MessagePort[];
      __restoreResponderPending?: boolean;
      __releaseRestoreResponder?: () => void;
      __staleRestoreBridgeRequests?: number;
    };
    fixtureWindow.__bridgePorts ??= [];
    fixtureWindow.__restoreResponderPending = false;
    fixtureWindow.__staleRestoreBridgeRequests = 0;
    navigator.serviceWorker.addEventListener("message", (event) => {
      if (event.data?.type !== "need-bridge" || !event.ports[0]) return;
      const bridge = new MessageChannel();
      bridge.port1.onmessage = (bridgeEvent) => {
        if (bridgeEvent.data?.type !== "http-request") return;
        fixtureWindow.__staleRestoreBridgeRequests! += 1;
        bridge.port1.postMessage({
          type: "http-response",
          requestId: bridgeEvent.data.requestId,
          status: 200,
          headers: { "Content-Type": "text/plain; charset=utf-8" },
          body: new TextEncoder().encode(`bridge:${restoreState.label}`),
        });
      };
      bridge.port1.start();
      fixtureWindow.__bridgePorts!.push(bridge.port1);
      fixtureWindow.__restoreResponderPending = true;
      fixtureWindow.__releaseRestoreResponder = () => {
        event.ports[0].postMessage(
          {
            type: "bridge-restored",
            appPrefix: restoreState.appPrefix,
            sessionId: restoreState.sessionId,
          },
          [bridge.port2],
        );
      };
    });
  }, state);
}

async function restoreResponderPending(page: Page): Promise<boolean> {
  return page.evaluate(() => (
    window as typeof window & { __restoreResponderPending?: boolean }
  ).__restoreResponderPending ?? false);
}

async function releaseRestoreResponder(page: Page): Promise<void> {
  await page.evaluate(() => {
    const fixtureWindow = window as typeof window & {
      __releaseRestoreResponder?: () => void;
    };
    if (!fixtureWindow.__releaseRestoreResponder) {
      throw new Error("no pending restoration to release");
    }
    fixtureWindow.__releaseRestoreResponder();
  });
}

async function staleRestoreBridgeRequestCount(page: Page): Promise<number> {
  return page.evaluate(() => (
    window as typeof window & { __staleRestoreBridgeRequests?: number }
  ).__staleRestoreBridgeRequests ?? 0);
}

async function installRestoreResponder(
  page: Page,
  state: {
    appPrefix: string;
    sessionId: string;
    label: string;
    delayMs?: number;
  },
): Promise<void> {
  await page.evaluate((initialState) => {
    const fixtureWindow = window as typeof window & {
      __bridgePorts?: MessagePort[];
      __bridgeCookies?: Record<string, string[]>;
      __needBridgeCount?: number;
      __restoreState?: typeof initialState;
    };
    fixtureWindow.__bridgePorts ??= [];
    fixtureWindow.__bridgeCookies ??= {};
    fixtureWindow.__needBridgeCount = 0;
    fixtureWindow.__restoreState = initialState;
    navigator.serviceWorker.addEventListener("message", (event) => {
      if (event.data?.type !== "need-bridge" || !event.ports[0]) return;
      fixtureWindow.__needBridgeCount! += 1;
      const current = fixtureWindow.__restoreState!;
      fixtureWindow.__bridgeCookies![current.label] ??= [];
      const bridge = new MessageChannel();
      bridge.port1.onmessage = (bridgeEvent) => {
        if (bridgeEvent.data?.type !== "http-request") return;
        fixtureWindow.__bridgeCookies![current.label].push(
          bridgeEvent.data.headers?.cookie ?? "",
        );
        bridge.port1.postMessage({
          type: "http-response",
          requestId: bridgeEvent.data.requestId,
          status: 200,
          headers: { "Content-Type": "text/plain; charset=utf-8" },
          body: new TextEncoder().encode(`bridge:${current.label}`),
        });
      };
      bridge.port1.start();
      fixtureWindow.__bridgePorts!.push(bridge.port1);
      window.setTimeout(() => {
        event.ports[0].postMessage(
          {
            type: "bridge-restored",
            appPrefix: current.appPrefix,
            sessionId: current.sessionId,
          },
          [bridge.port2],
        );
      }, current.delayMs ?? 0);
    });
  }, state);
}

async function updateRestoreResponder(
  page: Page,
  state: {
    appPrefix: string;
    sessionId: string;
    label: string;
    delayMs?: number;
  },
): Promise<void> {
  await page.evaluate((nextState) => {
    (window as typeof window & { __restoreState?: typeof nextState })
      .__restoreState = nextState;
  }, state);
}

async function stopWorker(
  context: BrowserContext,
  page: Page,
  scriptUrl: string,
): Promise<void> {
  const client = await context.newCDPSession(page);
  try {
    const versionId = await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error(`timed out finding ${scriptUrl}`)),
        10_000,
      );
      client.on("ServiceWorker.workerVersionUpdated", (event) => {
        const running = (event.versions ?? []).find((version: {
          runningStatus?: string;
          scriptURL?: string;
          versionId: string;
        }) => version.runningStatus === "running" && version.scriptURL === scriptUrl);
        if (!running) return;
        clearTimeout(timeout);
        resolve(String(running.versionId));
      });
      void client.send("ServiceWorker.enable").catch(reject);
    });
    await client.send("ServiceWorker.stopWorker", { versionId });
  } finally {
    await client.detach();
  }
}

async function registrationOutcome(
  page: Page,
  scriptPath: string,
  scopePath: string,
): Promise<{ activated: boolean; scope?: string; error?: string }> {
  return page.evaluate(async ({ script, scope }) => {
    try {
      const registration = await navigator.serviceWorker.register(script, {
        scope,
        updateViaCache: "none",
      });
      const worker = registration.installing ?? registration.waiting ??
        registration.active;
      if (!worker) {
        await registration.unregister();
        return { activated: false, scope: registration.scope };
      }
      if (worker.state !== "activated" && worker.state !== "redundant") {
        await new Promise<void>((resolve) => {
          const timeout = window.setTimeout(resolve, 5_000);
          worker.addEventListener("statechange", () => {
            if (worker.state !== "activated" && worker.state !== "redundant") {
              return;
            }
            window.clearTimeout(timeout);
            resolve();
          });
        });
      }
      const activated = worker.state === "activated";
      const registrationScope = registration.scope;
      await registration.unregister();
      return { activated, scope: registrationScope };
    } catch (error) {
      return {
        activated: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }, { script: scriptPath, scope: scopePath });
}
