import { defineConfig } from "@playwright/test";
import { lstatSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  playwrightTestIgnoreForEnvironment,
  shouldReuseExistingPlaywrightServer,
} from "./playwright-server-policy";

const __dirname = dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.KANDELO_PLAYWRIGHT_PORT ?? 5401);
const protectedBrowserBaseUrl = protectedLoopbackBaseUrl(
  process.env.KANDELO_ABI_STAGING_BROWSER_BASE_URL,
);
const assembledSiteRoot = exactAssembledSiteRoot(
  process.env.KANDELO_ABI_STAGING_ASSEMBLED_SITE_ROOT,
);
if (protectedBrowserBaseUrl !== undefined && assembledSiteRoot !== undefined) {
  throw new Error(
    "assembled-site preview cannot use an external browser base URL",
  );
}
const serveSealedDist = process.env.KANDELO_PLAYWRIGHT_SERVE_DIST === "1";
const scopedDeploymentsRun =
  process.env.KANDELO_SCOPED_DEPLOYMENT_SOURCE_ONLY_ROOT !== undefined;
const effectiveViteMode =
  serveSealedDist || assembledSiteRoot !== undefined
    ? "production"
    : "development";
const webServerEnvironment = playwrightWebServerEnvironment(
  process.env,
);
if (assembledSiteRoot !== undefined) {
  webServerEnvironment.VITE_BASE = "/kandelo/";
}
const viteModeArgument = effectiveViteMode === "production"
  ? " --mode production"
  : "";

const browserEnvironmentKeys = [
  "CI",
  "DEBUG",
  "DISPLAY",
  "FORCE_COLOR",
  "GITHUB_ACTIONS",
  "HOME",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "KANDELO_PLAYWRIGHT_PORT",
  "LANG",
  "LC_ALL",
  "LOGNAME",
  "NO_COLOR",
  "NO_PROXY",
  "PATH",
  "PLAYWRIGHT_BROWSERS_PATH",
  "PWDEBUG",
  "SHELL",
  "TEMP",
  "TMP",
  "TMPDIR",
  "TZ",
  "USER",
  "WAYLAND_DISPLAY",
  "XAUTHORITY",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_RUNTIME_DIR",
  "http_proxy",
  "https_proxy",
  "no_proxy",
];

function playwrightWebServerEnvironment(
  parentEnvironment: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const childEnvironment: Record<string, string> = {};
  for (const [key, value] of Object.entries(parentEnvironment)) {
    if (value !== undefined && key !== "KANDELO_BROWSER_TEST_NO_HMR") {
      childEnvironment[key] = value;
    }
  }
  childEnvironment.KANDELO_BROWSER_TEST_NO_HMR = "1";
  return childEnvironment;
}

const browserLaunchEnv: Record<string, string> = {};
for (const key of browserEnvironmentKeys) {
  const value = process.env[key];
  if (value !== undefined) {
    browserLaunchEnv[key] = value;
  }
}

// Nix dev-shell build/linker paths are for toolchain commands, not
// downloaded Playwright browser binaries. WebKitGTK reads more host
// environment than Chromium/Firefox and can crash before navigation.
const launchOptions = {
  env: browserLaunchEnv,
  args:
    protectedBrowserBaseUrl === undefined
    ? undefined
    : ["--proxy-bypass-list=<-loopback>"],
};

export default defineConfig({
  testDir: join(__dirname, "test"),
  testMatch: "*.spec.ts",
  // The assembled-site and exact-product proofs read protected handoffs during
  // module initialization. Ordinary browser suites have no such inputs; their
  // dedicated gates supply them and must remain their sole callers.
  testIgnore: playwrightTestIgnoreForEnvironment(process.env, process.argv),
  timeout: 120_000,
  workers: process.env.CI ? 1 : undefined,
  use: {
    baseURL:
      protectedBrowserBaseUrl === undefined
        ? `http://127.0.0.1:${port}${assembledSiteRoot === undefined ? "" : "/kandelo/"}`
      : protectedBrowserBaseUrl,
    // VFS product images are already zstd-compressed. Vite preview otherwise
    // dynamically gzips them and switches to chunked transfer, unlike the
    // content-length-bearing static Pages objects this gate models.
    extraHTTPHeaders:
      assembledSiteRoot === undefined
        ? undefined
        : { "Accept-Encoding": "identity" },
    launchOptions,
    proxy:
      protectedBrowserBaseUrl === undefined
      ? undefined
      : { server: new URL(protectedBrowserBaseUrl).origin },
    screenshot:
      protectedBrowserBaseUrl === undefined ? "only-on-failure" : "off",
    trace:
      protectedBrowserBaseUrl === undefined && process.env.CI
      ? "retain-on-failure"
      : "off",
  },
  webServer:
    protectedBrowserBaseUrl === undefined && !scopedDeploymentsRun
    ? {
          command:
            serveSealedDist || assembledSiteRoot !== undefined
              ? assembledSiteRoot === undefined
        ? `npx vite preview${viteModeArgument} --config ${join(__dirname, "vite.config.ts")} --host 127.0.0.1 --port ${port} --strictPort`
                : exactAssembledPreviewCommand(assembledSiteRoot, port)
        : `npx vite${viteModeArgument} --config ${join(__dirname, "vite.config.ts")} --host 127.0.0.1 --port ${port} --strictPort`,
      port,
      env: webServerEnvironment,
          reuseExistingServer:
            assembledSiteRoot === undefined &&
            shouldReuseExistingPlaywrightServer(process.env),
      timeout: 30_000,
    }
    : undefined,
  projects: [
    {
      name: "chromium",
      // Use the `chromium` channel (new headless mode) instead of
      // the default chromium-headless-shell. New-headless supports
      // WebGL2 on transferred OffscreenCanvases inside Web Workers,
      // which the modeset KMS pane relies on; the legacy headless
      // shell silently returns null for getContext("webgl2") on the
      // worker side.
      use: { browserName: "chromium", channel: "chromium" },
    },
    {
      name: "firefox",
      // Playwright launches Chromium with --mute-audio and gives Firefox no
      // equivalent, so a demo with sound plays through the host's speakers
      // during a headless run.
      use: {
        browserName: "firefox",
        launchOptions: {
          ...launchOptions,
          firefoxUserPrefs: { "media.volume_scale": "0.0" },
        },
      },
    },
    {
      name: "webkit",
      use: { browserName: "webkit" },
    },
  ],
});

function protectedLoopbackBaseUrl(
  value: string | undefined,
): string | undefined {
  if (value === undefined) return undefined;
  const parsed = new URL(value);
  if (
    parsed.protocol !== "http:" ||
    parsed.hostname !== "127.0.0.1" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    parsed.pathname !== "/"
  ) {
    throw new Error(
      "KANDELO_ABI_STAGING_BROWSER_BASE_URL must be one protected loopback origin",
    );
  }
  return parsed.href;
}

function exactAssembledSiteRoot(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (value === "" || resolve(value) !== value) {
    throw new Error(
      "KANDELO_ABI_STAGING_ASSEMBLED_SITE_ROOT must be an absolute path",
    );
  }
  const metadata = lstatSync(value);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(
      "KANDELO_ABI_STAGING_ASSEMBLED_SITE_ROOT must be a direct directory",
    );
  }
  return value;
}

function shellWord(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function exactAssembledPreviewCommand(
  root: string,
  previewPort: number,
): string {
  const viteModule = pathToFileURL(
    join(__dirname, "node_modules/vite/dist/node/index.js"),
  ).href;
  const source = `
import { preview } from ${JSON.stringify(viteModule)};
await preview({
  base: "/kandelo/",
  build: { outDir: ${JSON.stringify(root)} },
  configFile: false,
  preview: {
    headers: {
      "Cross-Origin-Embedder-Policy": "require-corp",
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Resource-Policy": "same-origin",
    },
    host: "127.0.0.1",
    port: ${previewPort},
    strictPort: true,
  },
});
`;
  return `node --input-type=module -e ${shellWord(source)}`;
}
