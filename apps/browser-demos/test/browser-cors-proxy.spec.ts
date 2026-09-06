import { expect, test } from "@playwright/test";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolveBinary } from "../../../host/src/binary-resolver";

const curlPath = resolveBinary("programs/curl.wasm");
const wgetPath = resolveBinary("programs/wget.wasm");
const serviceWorkerPath = fileURLToPath(
  new URL("../public/service-worker.js", import.meta.url),
);

const ALLOWED_PREFLIGHT_HEADERS = [
  "Accept",
  "Authorization",
  "Content-Type",
  "git-protocol",
  "wp_blog",
  "wp_install",
  "x-cors-proxy-allowed-request-headers",
  "x-cors-proxy-content-type",
].join(", ");

const EFFECTIVE_PROXY_CONFIG = {
  allowedRequestHeaderNames: [
    "accept",
    "content-type",
    "git-protocol",
    "wp_blog",
    "wp_install",
  ],
  allowAnonymousGetHeaderOmission: true,
} as const;

type TestResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  combined: string;
  hostDiagnostics: Array<{ message: string }>;
};

type TestRunnerWindow = Window & {
  __testRunnerReady: boolean;
  __runTest(
    wasmBytes: ArrayBuffer,
    argv: string[],
    timeoutMs: number,
    options?: {
      corsProxy?: {
        url: string;
        allowedRequestHeaderNames: string[];
        allowAnonymousGetHeaderOmission: boolean;
      };
    },
  ): Promise<TestResult>;
};

interface ProxyRequest {
  method: string;
  url: string;
  headers: IncomingMessage["headers"];
  body: string;
}

function listen(server: Server): Promise<string> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const { port } = server.address() as AddressInfo;
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeIdleConnections();
  });
}

async function requestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function constrainedProxyFixture(observed: ProxyRequest[]): Server {
  return createServer(async (request, response) => {
    observed.push({
      method: request.method ?? "",
      url: request.url ?? "",
      headers: request.headers,
      body: await requestBody(request),
    });
    const origin = request.headers.origin ?? "*";
    if (request.method === "OPTIONS") {
      response.writeHead(204, {
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Methods":
          request.headers["access-control-request-method"] ?? "GET",
        "Access-Control-Allow-Headers": ALLOWED_PREFLIGHT_HEADERS,
        Vary: "Origin",
      });
      response.end();
      return;
    }
    const proxied = request.url?.startsWith("/?") === true;
    response.writeHead(200, {
      ...(proxied ? { "Access-Control-Allow-Origin": origin } : {}),
      "Content-Type": "text/plain",
      "Cross-Origin-Resource-Policy": "cross-origin",
      Vary: "Origin",
    });
    response.end("constrained proxy response\n");
  });
}

function corsOpenTargetFixture(observed: ProxyRequest[]): Server {
  return createServer(async (request, response) => {
    observed.push({
      method: request.method ?? "",
      url: request.url ?? "",
      headers: request.headers,
      body: await requestBody(request),
    });
    response.writeHead(200, {
      "Access-Control-Allow-Origin": "*",
      "Content-Type": "text/plain",
      "Cross-Origin-Resource-Policy": "cross-origin",
    });
    response.end("cors-open target response\n");
  });
}

test("Vite serves a service worker with the complete proxy profile", async ({
  request,
}) => {
  const response = await request.get("/service-worker.js");
  expect(response.ok()).toBe(true);
  const source = await response.text();
  expect(source).not.toContain("__CORS_PROXY_CONFIG__");
  expect(source).not.toContain("__CORS_PROXY_URL__");
  expect(source).toContain(
    '"allowedRequestHeaderNames":["accept","content-type","git-protocol","wp_blog","wp_install"]',
  );
  expect(source).toContain('"allowAnonymousGetHeaderOmission":true');
});

test("service worker projects both configured proxy boundaries", async ({
  context,
  page,
}) => {
  const observed: ProxyRequest[] = [];
  const proxy = constrainedProxyFixture(observed);
  const proxyRoot = await listen(proxy);
  const directObserved: ProxyRequest[] = [];
  const directTarget = corsOpenTargetFixture(directObserved);
  const directRoot = await listen(directTarget);
  const rawServiceWorker = await readFile(serviceWorkerPath, "utf8");
  const config = {
    url: `${proxyRoot}/?`,
    ...EFFECTIVE_PROXY_CONFIG,
  };
  const serviceWorker = rawServiceWorker.replace(
    '"__CORS_PROXY_CONFIG__"',
    JSON.stringify(config),
  );
  const app = createServer((request, response) => {
    if (request.url === "/service-worker.js") {
      response.writeHead(200, {
        "Content-Type": "application/javascript",
      });
      response.end(serviceWorker);
      return;
    }
    response.writeHead(200, { "Content-Type": "text/html" });
    response.end(`<!doctype html><script>
      window.ready = navigator.serviceWorker.controller !== null;
      if (!window.ready) {
        navigator.serviceWorker.register('/service-worker.js', {
          scope: '/',
          updateViaCache: 'none',
        }).then(() =>
          navigator.serviceWorker.ready.then(() => location.reload()));
      }
    </script>`);
  });
  const appRoot = await listen(app);
  const warnings: string[] = [];
  const corsErrors: string[] = [];
  context.on("console", (message) => {
    if (message.type() === "warning") warnings.push(message.text());
    if (message.type() === "error" && /cors/i.test(message.text())) {
      corsErrors.push(message.text());
    }
  });

  try {
    await page.goto(appRoot);
    await page.waitForFunction(
      () => (window as Window & { ready?: boolean }).ready === true,
    );
    const results = await page.evaluate(
      async ({ proxyUrl, directUrl }) => {
        async function outcome(url: string, init: RequestInit) {
          const response = await fetch(url, init);
          return { status: response.status, body: await response.text() };
        }
        const target = "https://origin.example/browser-owned";
        const browserOwned = await outcome(target, {
          headers: {
            "Git-Protocol": "version=2",
            "X-Arbitrary-Metadata": "omit",
          },
        });
        const wrappedUrl = `${proxyUrl}/?https://origin.example/already-wrapped`;
        const alreadyWrapped = await outcome(wrappedUrl, {
          headers: {
            "Content-Type": "application/json",
            "X-Arbitrary-Metadata": "omit",
          },
        });
        const allowedPost = await outcome(wrappedUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: '{"message":"preserve this body"}',
        });
        await outcome(target, {
          headers: {
            "Git-Protocol": "version=2",
            "X-Arbitrary-Metadata": "omit",
          },
        });
        const beforeRejected = performance.now();
        const rejected = await outcome(wrappedUrl, {
          method: "POST",
          headers: { "X-Arbitrary-Metadata": "reject" },
          body: "state change",
        });
        // A body-bearing request to a CORS-open server — the signalling
        // piplet's shape — must reach it directly, never the proxy.
        const directPost = await outcome(`${directUrl}/session`, {
          method: "POST",
          body: "kandelo1:offer",
        });
        return {
          browserOwned,
          alreadyWrapped,
          allowedPost,
          rejected,
          beforeRejected,
          directPost,
        };
      },
      { proxyUrl: proxyRoot, directUrl: directRoot },
    );

    expect(results.browserOwned).toEqual({
      status: 200,
      body: "constrained proxy response\n",
    });
    expect(results.alreadyWrapped).toEqual({
      status: 200,
      body: "constrained proxy response\n",
    });
    expect(results.allowedPost).toEqual({
      status: 200,
      body: "constrained proxy response\n",
    });
    expect(results.rejected.status).toBe(502);
    expect(results.directPost).toEqual({
      status: 200,
      body: "cors-open target response\n",
    });
    expect(directObserved).toMatchObject([
      { method: "POST", url: "/session", body: "kandelo1:offer" },
    ]);
    const actual = observed.filter(({ method }) => method !== "OPTIONS");
    expect(actual).toHaveLength(4);
    expect(actual[0]?.headers["git-protocol"]).toBe("version=2");
    expect(actual[0]?.headers["x-arbitrary-metadata"]).toBeUndefined();
    expect(actual[1]?.headers["content-type"]).toBe("application/json");
    expect(actual[1]?.headers["x-arbitrary-metadata"]).toBeUndefined();
    expect(actual[2]).toMatchObject({
      method: "POST",
      body: '{"message":"preserve this body"}',
    });
    expect(actual[2]?.headers["content-type"]).toBe("application/json");
    expect(actual[3]?.headers["git-protocol"]).toBe("version=2");
    expect(
      warnings.filter((message) =>
        message.includes(
          "Browser CORS proxy omitted unsupported request headers",
        ),
      ),
    ).toHaveLength(1);
    expect(
      warnings.every((message) => message.includes("https://origin.example")),
    ).toBe(true);
    expect(corsErrors).toEqual([]);
  } finally {
    await Promise.all([close(app), close(proxy), close(directTarget)]);
  }
});

test("guest HTTP uses the test runner's same-origin CORS proxy", async ({
  page,
}) => {
  const upstreamRequests: string[] = [];
  const upstream = createServer((request, response) => {
    upstreamRequests.push(request.url ?? "");
    response.writeHead(200, { "Content-Type": "text/plain" });
    response.end("Kandelo CORS proxy regression\n");
  });
  await new Promise<void>((resolve, reject) => {
    upstream.once("error", reject);
    upstream.listen(0, "::1", () => {
      upstream.off("error", reject);
      resolve();
    });
  });

  try {
    const { port } = upstream.address() as AddressInfo;
    // The trailing root dot avoids the guest's /etc/hosts localhost entry, so
    // Kandelo delegates the connection to its browser backend. Node still
    // resolves the proxy's upstream target to this test-only ::1 listener.
    const targetUrl = `http://localhost.:${port}/probe`;
    const wgetBytes = Array.from(await readFile(wgetPath));

    await page.goto("/pages/test-runner/", {
      waitUntil: "domcontentloaded",
    });
    await page.waitForFunction(
      () => (window as unknown as TestRunnerWindow).__testRunnerReady === true,
    );
    expect(
      await page.evaluate(() => navigator.serviceWorker.controller),
      "the regression must exercise explicit BrowserKernel proxy configuration",
    ).toBeNull();

    const result = await page.evaluate(
      async ({ bytes, url }) =>
        (window as unknown as TestRunnerWindow).__runTest(
          new Uint8Array(bytes).buffer,
          ["wget", "-qO-", url],
          60_000,
        ),
      { bytes: wgetBytes, url: targetUrl },
    );

    expect(
      result.exitCode,
      JSON.stringify({ result, upstreamRequests }, null, 2),
    ).toBe(0);
    expect(result.stdout).toBe("Kandelo CORS proxy regression\n");
    expect(upstreamRequests).toEqual(["/probe"]);
  } finally {
    await new Promise<void>((resolve, reject) => {
      upstream.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

test("guest proxy fallback completes real preflight with name-only projection", async ({
  page,
}) => {
  const observed: ProxyRequest[] = [];
  const proxy = constrainedProxyFixture(observed);
  const proxyRoot = await listen(proxy);
  const targetRoot = proxyRoot.replace("127.0.0.1", "localtest.me");
  const consoleErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" && /cors/i.test(message.text())) {
      consoleErrors.push(message.text());
    }
  });

  try {
    const curlBytes = Array.from(await readFile(curlPath));
    await page.goto("/pages/test-runner/", { waitUntil: "domcontentloaded" });
    await page.waitForFunction(
      () => (window as unknown as TestRunnerWindow).__testRunnerReady === true,
    );
    const result = await page.evaluate(
      async ({ bytes, proxyUrl, proxyConfig, targetUrl }) =>
        (window as unknown as TestRunnerWindow).__runTest(
          new Uint8Array(bytes).buffer,
          [
            "curl",
            "-sS",
            "-H",
            "Git-Protocol: version=2",
            "-H",
            'Content-Type: application/json; profile="a very long arbitrary value preserved without interpretation"',
            "-H",
            "X-Arbitrary-Metadata: omitted",
            targetUrl,
          ],
          60_000,
          {
            corsProxy: {
              url: `${proxyUrl}/?`,
              ...proxyConfig,
            },
          },
        ),
      {
        bytes: curlBytes,
        proxyUrl: proxyRoot,
        proxyConfig: EFFECTIVE_PROXY_CONFIG,
        targetUrl: `${targetRoot}/direct-probe`,
      },
    );

    expect(result.exitCode, JSON.stringify({ result, observed }, null, 2)).toBe(
      0,
    );
    expect(result.stdout).toBe("constrained proxy response\n");
    expect(result.hostDiagnostics).toHaveLength(1);
    expect(result.hostDiagnostics[0]?.message).toContain(
      `Browser CORS proxy omitted unsupported request headers for ${targetRoot}:`,
    );
    expect(result.hostDiagnostics[0]?.message).toContain(
      "x-arbitrary-metadata",
    );
    const actual = observed.find(
      ({ method, url }) => method === "GET" && url.startsWith("/?"),
    );
    expect(observed.some(({ method }) => method === "OPTIONS")).toBe(true);
    expect(actual?.headers["git-protocol"]).toBe("version=2");
    expect(actual?.headers["content-type"]).toBe(
      'application/json; profile="a very long arbitrary value preserved without interpretation"',
    );
    expect(actual?.headers["x-arbitrary-metadata"]).toBeUndefined();
    expect(consoleErrors).toEqual([]);
  } finally {
    await close(proxy);
  }
});

test("guest proxy rejects lossy credentials and state-changing requests", async ({
  page,
}) => {
  const observed: ProxyRequest[] = [];
  const proxy = constrainedProxyFixture(observed);
  const proxyRoot = await listen(proxy);
  const targetRoot = proxyRoot.replace("127.0.0.1", "localtest.me");
  try {
    const curlBytes = Array.from(await readFile(curlPath));
    await page.goto("/pages/test-runner/", { waitUntil: "domcontentloaded" });
    await page.waitForFunction(
      () => (window as unknown as TestRunnerWindow).__testRunnerReady === true,
    );
    const run = (args: string[]) =>
      page.evaluate(
        async ({ bytes, argv, proxyUrl, proxyConfig }) =>
          (window as unknown as TestRunnerWindow).__runTest(
            new Uint8Array(bytes).buffer,
            argv,
            60_000,
            {
              corsProxy: {
                url: `${proxyUrl}/?`,
                ...proxyConfig,
              },
            },
          ),
        {
          bytes: curlBytes,
          argv: args,
          proxyUrl: proxyRoot,
          proxyConfig: EFFECTIVE_PROXY_CONFIG,
        },
      );
    const authorization = await run([
      "curl",
      "-sS",
      "-H",
      "Authorization: Bearer secret",
      `${targetRoot}/direct-auth`,
    ]);
    const post = await run([
      "curl",
      "-sS",
      "-X",
      "POST",
      "-H",
      "X-Arbitrary: reject",
      "--data-binary",
      "state-changing",
      `${targetRoot}/direct-post`,
    ]);

    expect(authorization.exitCode).not.toBe(0);
    expect(post.exitCode).not.toBe(0);
    expect(observed.filter(({ url }) => url.startsWith("/?"))).toEqual([]);
  } finally {
    await close(proxy);
  }
});
