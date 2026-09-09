import { fileURLToPath } from "url";
import path from "path";
import fs from "fs";
import { execSync } from "child_process";
import {
  defineConfig,
  normalizePath,
  type Plugin,
  type PreviewServer,
  type ViteDevServer,
} from "vite";
import react from "@vitejs/plugin-react";
import {
  binaryProgramCacheRoot,
  createSourceOnlyBinarySnapshotSession,
  sourceOnlyBinaryRoot,
  tryResolveBinary,
  tryResolveBinaries,
} from "../../host/src/binary-resolver";
import { browserBinariesImports } from "./browser-binary-imports.mjs";
import {
  browserForkModule32ModuleSpecifier,
  browserKernelModuleSpecifier,
  browserRepositoryAliases,
  browserRootfsModuleSpecifier,
} from "./browser-module-contract.mjs";
import {
  createBinaryDevAccess,
  pathIsWithin as pathIsWithinWithCasePolicy,
  type BinaryDevAccess,
} from "./binary-dev-access";
import {
  createSourceOnlyPublicSnapshot,
  createSourceOnlyViteAssets,
} from "./source-only-vite-assets";
import {
  createBatchedBrowserBinaryResolution,
  type BrowserBinaryResolution,
} from "./vite-binary-resolution";
import { DEFAULT_BROWSER_CORS_PROXY_CONFIG } from "./lib/browser-cors-proxy";
import { handleDevCorsProxyRequest } from "./vite/dev-cors-proxy";
import { normalizeDeploymentBase } from "../../web-libs/kandelo-session/src/deployment-scope";
import {
  createVfsProductDeploymentPlugin,
  loadVfsProductDeploymentMap,
} from "../../scripts/vfs-product-deployment.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");
const authoredBrowserBinaryRelPaths = browserBinariesImports(repoRoot);

// The browser demos import the VFS product catalog through this virtual
// module. It is populated only by the removed Pages-deployment product map;
// in every normal build it resolves to `null`, and consumers (live-setup,
// network-demo-worker) already treat `null` as "no scoped product loader".
const VFS_PRODUCTS_VIRTUAL_MODULE = "virtual:kandelo-pages-vfs-products";
const RESOLVED_VFS_PRODUCTS_VIRTUAL_MODULE = `\0${VFS_PRODUCTS_VIRTUAL_MODULE}`;

function vfsProductsVirtualModule(): Plugin {
  return {
    name: "kandelo-vfs-products-virtual-module",
    enforce: "pre",
    resolveId(source) {
      return source === VFS_PRODUCTS_VIRTUAL_MODULE
        ? RESOLVED_VFS_PRODUCTS_VIRTUAL_MODULE
        : null;
    },
    load(id) {
      return id === RESOLVED_VFS_PRODUCTS_VIRTUAL_MODULE
        ? "export default null;\n"
        : null;
    },
  };
}

/**
 * Resolve the VFS product plugin for the current build.
 *
 * Without `KANDELO_PAGES_PRODUCT_MAP` this is an ordinary build: the virtual
 * `virtual:kandelo-pages-vfs-products` module resolves to `null` and consumers
 * fall back to their default (unscoped) loaders. When a private product map is
 * supplied, the build is a directory-scoped VFS product deployment: the map is
 * validated against the catalog and served through the deployment plugin, which
 * rewrites product URLs under the deployment base and (for grouped maps) copies
 * the authenticated asset group into the build output.
 */
function vfsProductsPlugin(base: string): Plugin {
  const configuredMap = process.env.KANDELO_PAGES_PRODUCT_MAP;
  if (configuredMap === undefined) {
    return vfsProductsVirtualModule();
  }
  const configuredAssetGroup = process.env.KANDELO_PAGES_VFS_ASSET_GROUP_DIR;
  if (!path.isAbsolute(configuredMap)) {
    throw new Error(
      "KANDELO_PAGES_PRODUCT_MAP must be an absolute private map path",
    );
  }
  const map = loadVfsProductDeploymentMap({
    mapPath: configuredMap,
    sourceRoot: repoRoot,
  });
  const declaresAssetGroup = map.products[0]?.asset_group !== undefined;
  if (declaresAssetGroup !== (configuredAssetGroup !== undefined)) {
    throw new Error(
      declaresAssetGroup
        ? "grouped KANDELO_PAGES_PRODUCT_MAP requires KANDELO_PAGES_VFS_ASSET_GROUP_DIR"
        : "legacy KANDELO_PAGES_PRODUCT_MAP must omit KANDELO_PAGES_VFS_ASSET_GROUP_DIR",
    );
  }
  if (
    configuredAssetGroup !== undefined &&
    !path.isAbsolute(configuredAssetGroup)
  ) {
    throw new Error(
      "KANDELO_PAGES_VFS_ASSET_GROUP_DIR must be an absolute directory path",
    );
  }
  return createVfsProductDeploymentPlugin({
    assetGroupDirectory: configuredAssetGroup,
    base,
    map,
    mirrorRoots: binaryMirrorRoots,
  });
}

function canonicalizeFromExistingAncestor(file: string): string {
  const suffix: string[] = [];
  let existing = path.resolve(file);
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) return normalizePath(path.resolve(file));
    suffix.unshift(path.basename(existing));
    existing = parent;
  }
  return normalizePath(path.resolve(fs.realpathSync(existing), ...suffix));
}

const configuredProgramCacheRoot = binaryProgramCacheRoot();
const configuredSourceOnlyRoot = sourceOnlyBinaryRoot();
const sourceOnlyPublicSnapshot = configuredSourceOnlyRoot === null
  ? null
  : createSourceOnlyPublicSnapshot(path.resolve(__dirname, "public"));
const sourceOnlyViteAssets = configuredSourceOnlyRoot === null
  ? null
  : createSourceOnlyViteAssets(
    createSourceOnlyBinarySnapshotSession(),
    [
      "kernel.wasm",
      "programs/wasm32/rootfs.vfs",
      ...authoredBrowserBinaryRelPaths,
    ],
    {
      resolveMirrorImport: (specifier, importer) =>
        relativeBinaryMirrorImport(specifier, importer)?.relPath ?? null,
      denyFallbackGlob: sourceOnlyFallbackArtifactGlob,
      denyPublicPath: (relPath) =>
        sourceOnlyPublicSnapshot!.deniesRequestPath(relPath),
      disposeWith: () => sourceOnlyPublicSnapshot!.dispose(),
    },
  );
const browserExternalArtifactRoot = canonicalizeFromExistingAncestor(
  configuredSourceOnlyRoot ?? configuredProgramCacheRoot,
);
const caseInsensitivePaths = fs.existsSync(
  path.join(__dirname, "VITE.CONFIG.TS"),
);
const preferredLocalPort = 5401;

function pathIsWithin(root: string, file: string): boolean {
  return pathIsWithinWithCasePolicy(root, file, caseInsensitivePaths);
}

const binaryDevAccess = createBinaryDevAccess({
  repoRoot,
  programCacheRoot: browserExternalArtifactRoot,
  caseInsensitivePaths,
});
const authoredBinaryMirrorRoots = [
  path.resolve(repoRoot, "local-binaries"),
  path.resolve(repoRoot, "binaries"),
];
// The scoped-deployment product resolver maps concrete on-disk binary paths
// back to catalog product IDs. Under a SourceOnly projection the projection
// root is the sole mirror; otherwise the authored local/release mirrors are.
const binaryMirrorRoots = configuredSourceOnlyRoot === null
  ? authoredBinaryMirrorRoots
  : [configuredSourceOnlyRoot];

function applyDefaultProgramArch(relPath: string): string {
  if (!relPath.startsWith("programs/")) return relPath;
  const tail = relPath.slice("programs/".length);
  const first = tail.split("/", 1)[0];
  if (first === "wasm32" || first === "wasm64") return relPath;
  return `programs/wasm32/${tail}`;
}

function candidateEntryExists(relPath: string): boolean {
  // Under SourceOnly the aggregate, not an individual pathname, is the
  // candidate tier. Entering the batch whenever that authority exists makes a
  // declared-but-missing member fail its receipt closure instead of looking
  // like an optional unowned path.
  const candidates = configuredSourceOnlyRoot === null
    ? authoredBinaryMirrorRoots.map((root) => path.resolve(root, relPath))
    : [path.resolve(
        configuredSourceOnlyRoot,
        ".kandelo/source-only-program-projection-v1.json",
      )];
  return candidates.some((candidate) => {
    try {
      fs.lstatSync(candidate);
      return true;
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return false;
      }
      throw error;
    }
  });
}

function createBrowserBinaryResolution(
  access: BinaryDevAccess,
): BrowserBinaryResolution {
  const declaredRelPaths = authoredBrowserBinaryRelPaths;
  return createBatchedBrowserBinaryResolution(declaredRelPaths, {
    normalizeRelPath: applyDefaultProgramArch,
    resolveBatch: tryResolveBinaries,
    resolveOne: tryResolveBinary,
    approveBatch: (files) => access.approveBatch(files),
    approve: (file) => access.approve(file),
    candidateEntryExists,
  });
}

const browserBinaryResolution = createBrowserBinaryResolution(binaryDevAccess);

const crossOriginIsolationHeaders = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
  // WebKit revalidates a module worker when a kernel is rebooted on the same
  // page. Mark every dev/preview response same-origin so that cached worker
  // responses remain admissible under COEP, including a 304 revalidation.
  "Cross-Origin-Resource-Policy": "same-origin",
};

function configuredCorsProxyUrl(): string | undefined {
  return process.env.VITE_CORS_PROXY_URL?.trim() || undefined;
}

function browserCorsProxyConfig(url: string) {
  return {
    ...DEFAULT_BROWSER_CORS_PROXY_CONFIG,
    allowedRequestHeaderNames: [
      ...DEFAULT_BROWSER_CORS_PROXY_CONFIG.allowedRequestHeaderNames,
    ],
    url,
  };
}

function buildCorsProxyConfig() {
  return browserCorsProxyConfig(
    configuredCorsProxyUrl() || DEFAULT_BROWSER_CORS_PROXY_CONFIG.url,
  );
}

function serviceWorkerPathForBase(base: string): string {
  return `${normalizeDeploymentBase(base)}service-worker.js`;
}

function devCorsProxyPathForBase(base: string): string {
  return `${normalizeDeploymentBase(base)}__kandelo_cors_proxy`;
}

function devCorsProxyFetchUrlForBase(base: string): string {
  return `${devCorsProxyPathForBase(base)}?url=`;
}

function injectCorsProxyConfigPlaceholder(
  content: string,
  corsProxyConfig: ReturnType<typeof browserCorsProxyConfig>,
): string {
  return content.replace(
    '"__CORS_PROXY_CONFIG__"',
    JSON.stringify(corsProxyConfig),
  );
}

const blobIframeInterceptorPath = path.resolve(
  __dirname,
  "public",
  "blob-iframe-interceptor.js",
);

/**
 * Inline the reusable blob-iframe interceptor (public/blob-iframe-interceptor.js)
 * into the service worker in place of the `"__BLOB_IFRAME_INTERCEPTOR__"`
 * placeholder. The service worker injects this source into every bridged HTML
 * document so app-created `blob:` iframes become service-worker-controlled
 * `about:srcdoc` documents. Kept as a separate file so it stays independently
 * readable and testable.
 */
function injectBlobIframeInterceptorPlaceholder(content: string): string {
  if (!content.includes('"__BLOB_IFRAME_INTERCEPTOR__"')) {
    return content;
  }
  const interceptor = fs.readFileSync(blobIframeInterceptorPath, "utf-8");
  return content.replace(
    '"__BLOB_IFRAME_INTERCEPTOR__"',
    JSON.stringify(interceptor),
  );
}

/**
 * Vite plugin: resolve `@kernel-wasm` and `@rootfs-vfs` lazily.
 *
 * `@kernel-wasm` resolves through the same authoritative path as every other
 * host consumer: the SourceOnly-v1 projection when
 * `WASM_POSIX_SOURCE_ONLY_BINARY_ROOT` is configured, otherwise
 * `tryResolveBinary("kernel.wasm")` (the shared resolver's ordered
 * `local-binaries/source-only-v1` → `local-binaries` → `binaries` →
 * installed-package tiers). There is no legacy fallback path; a missing
 * kernel fails loudly instead.
 *
 * `@rootfs-vfs` resolves to `<repoRoot>/host/wasm/rootfs.vfs` (built by
 * mkrootfs during `./run.sh setup`).
 *
 * Resolution is deferred until import time so pages that don't consume
 * these aliases can run without a kernel build present. Pages that do
 * import them get a clear error pointing at the build script.
 */
function resolveKernelArtifactsAlias(access: BinaryDevAccess): Plugin {
  const KERNEL = browserKernelModuleSpecifier;
  const ROOTFS = browserRootfsModuleSpecifier;
  const FORK_MODULE32 = browserForkModule32ModuleSpecifier;
  return {
    name: "resolve-kernel-artifacts-alias",
    enforce: "pre",
    resolveId(source) {
      const queryIdx = source.indexOf("?");
      const pathPart = queryIdx === -1 ? source : source.slice(0, queryIdx);
      const query = queryIdx === -1 ? "" : source.slice(queryIdx);

      if (pathPart === KERNEL) {
        if (sourceOnlyViteAssets !== null) {
          return sourceOnlyViteAssets.resolve("kernel.wasm");
        }
        const resolved = tryResolveBinary("kernel.wasm");
        if (resolved) return access.approve(resolved) + query;
        if (configuredSourceOnlyRoot !== null) {
          this.error(
            "kernel.wasm is not owned by the SourceOnly projection at " +
              configuredSourceOnlyRoot,
          );
        }
        this.error(
          "kernel.wasm not found. Build it with ./run.sh setup (or cargo xtask bootstrap kernel).",
        );
      }
      if (pathPart === FORK_MODULE32) {
        // Phase 6 D5: the wasm32 co-resident fork-module, staged next to the
        // kernel by `crates/fork-module/build-wasm.sh`. Optional: only demos
        // that enable WASM_POSIX_FORK_MODULE import it, so a missing artifact
        // is a loud error pointing at the build script.
        if (sourceOnlyViteAssets !== null) {
          return sourceOnlyViteAssets.resolve("fork_module32.wasm");
        }
        const resolved = tryResolveBinary("fork_module32.wasm");
        if (resolved) return access.approve(resolved) + query;
        const local = path.resolve(repoRoot, "local-binaries/fork_module32.wasm");
        const hosted = path.resolve(repoRoot, "host/wasm/fork_module32.wasm");
        this.error(
          "fork_module32.wasm not found. Run " +
            "`scripts/dev-shell.sh bash crates/fork-module/build-wasm.sh`.\n" +
            `  Looked at: ${local}\n  Looked at: ${hosted}`,
        );
      }
      if (pathPart === ROOTFS) {
        if (configuredSourceOnlyRoot !== null) {
          return sourceOnlyViteAssets!.resolve(
            "programs/wasm32/rootfs.vfs",
          );
        }
        const candidates = [
          path.resolve(repoRoot, "host/wasm/rootfs.vfs"),
          path.resolve(repoRoot, "local-binaries/rootfs.vfs"),
          path.resolve(repoRoot, "binaries/rootfs.vfs"),
          path.resolve(repoRoot, "local-binaries/programs/wasm32/rootfs.vfs"),
          path.resolve(repoRoot, "binaries/programs/wasm32/rootfs.vfs"),
        ];
        for (const file of candidates) {
          if (fs.existsSync(file)) return access.approve(file) + query;
        }
        this.error(
          "rootfs.vfs not found. Run `bash build.sh` from the repo root, or fetch/build the rootfs package.\n" +
            candidates.map((file) => `  Looked at: ${file}`).join("\n"),
        );
      }
      return null;
    },
    configureServer(server) {
      access.attachServer(server);
    },
  };
}

/**
 * Vite plugin (worker build only): strip the dead `export { … }` that rolldown
 * synthesizes on worker entry chunks.
 *
 * A worker entry is a terminal module — nothing imports it — so the export is
 * dead. But its presence makes WebKit/Safari evaluate the module worker TWICE:
 * the second (uninitialized) evaluation reinstalls `self.onmessage` bound to a
 * fresh module state whose `initReady` is false, which shadows the first
 * evaluation's handler and silently parks the kernel's lazy-VFS registration
 * messages — deadlocking `kernel.init()` so the shell never boots. Chromium and
 * Firefox evaluate the module once and are unaffected. Dropping the export
 * makes the worker a plain single-evaluation module on every engine.
 *
 * The "proper" lever for this is `preserveEntrySignatures: false`, but as of
 * 2026-07-02 (Vite 8 / rolldown 1.0.3) setting it under `worker.rollupOptions`
 * had zero effect here (byte-identical output): rolldown-vite does not thread
 * that option into the worker build. So we strip the artifact at `renderChunk`
 * instead — a build-time output transform, not a runtime workaround. Revisit
 * once rolldown-vite honors `preserveEntrySignatures` for worker builds (or
 * stops emitting the dead export), and this plugin can be dropped for the
 * option.
 */
function dropWorkerEntryExports(): Plugin {
  const strippedEntryFacades = new Set<string>();
  return {
    name: "drop-worker-entry-exports",
    enforce: "post",
    renderChunk(code, chunk) {
      if (!chunk.isEntry) return null;
      const stripped = code.replace(/\bexport\s*\{[^}]*\}\s*;?\s*$/, "");
      if (stripped === code) return null;
      if (chunk.facadeModuleId === null) {
        this.error(
          `stripped worker entry ${chunk.fileName} lacks a stable facade identity`,
        );
      }
      strippedEntryFacades.add(chunk.facadeModuleId);
      return { code: stripped, map: null };
    },
    generateBundle(_options, bundle) {
      const strippedEntries = new Set<string>();
      const emittedEntryByFacade = new Map<string, string>();
      for (const output of Object.values(bundle)) {
        if (
          output.type !== "chunk" || !output.isEntry ||
          output.facadeModuleId === null ||
          !strippedEntryFacades.has(output.facadeModuleId)
        ) continue;
        const prior = emittedEntryByFacade.get(output.facadeModuleId);
        if (prior !== undefined && prior !== output.fileName) {
          this.error(
            `stripped worker entry ${output.facadeModuleId} resolves to multiple emitted chunks: ${prior}, ${output.fileName}`,
          );
        }
        emittedEntryByFacade.set(output.facadeModuleId, output.fileName);
        strippedEntries.add(output.fileName);
      }
      for (const facade of strippedEntryFacades) {
        if (!emittedEntryByFacade.has(facade)) {
          this.error(
            `stripped worker entry ${facade} has no emitted entry chunk`,
          );
        }
      }
      for (const output of Object.values(bundle)) {
        if (output.type !== "chunk") continue;
        for (const imported of output.dynamicImports) {
          if (strippedEntries.has(imported)) {
            this.error(
              `worker chunk ${output.fileName} imports worker entry ${imported} whose exports are stripped`,
            );
          }
        }
        for (const imported of output.imports) {
          if (!strippedEntries.has(imported)) continue;
          if (output.importedBindings === undefined) {
            this.error(
              `worker chunk ${output.fileName} does not report imported bindings for stripped worker entry ${imported}`,
            );
          }
          this.error(
            `worker chunk ${output.fileName} imports worker entry ${imported} whose exports are stripped`,
          );
        }
      }
    },
  };
}

/**
 * Vite plugin: resolve `@binaries/...` imports and authored relative imports
 * into the resolver-managed binaries trees.
 *
 * Lookup order, first hit wins:
 *   1. `<repoRoot>/local-binaries/<rest>` — populated by xtask while
 *      installing into the resolver cache, plus any direct
 *      `install_local_binary` writes from build scripts.
 *   2. `<repoRoot>/binaries/<rest>` — populated by xtask when given
 *      `--binaries-dir`; mirrors release archives via symlinks.
 *
 * The fallback is what makes the alias useful for both release-shipped
 * artifacts and local-only ones (e.g. dev builds, test fixtures): a
 * page just imports `@binaries/programs/wasm32/<x>` (or uses an optional
 * relative `import.meta.glob()` into either mirror) and gets whichever copy
 * is present.
 *
 * Doing this with a custom plugin (rather than `resolve.alias`) is
 * deliberate: `@rollup/plugin-alias` has a single `replacement` string,
 * which can't express "try this directory first, then that one." A
 * `resolveId` hook can.
 */
interface BinaryMirrorImport {
  relPath: string;
  query: string;
}

function relativeBinaryMirrorImport(
  source: string,
  importer: string | undefined,
): BinaryMirrorImport | null {
  if (importer === undefined || source.startsWith("\0")) return null;
  const queryIndex = source.indexOf("?");
  const pathPart = queryIndex === -1 ? source : source.slice(0, queryIndex);
  const query = queryIndex === -1 ? "" : source.slice(queryIndex);
  if (!pathPart.startsWith(".") && !path.isAbsolute(pathPart)) return null;

  const importerPath = importer.split("?", 1)[0];
  if (!path.isAbsolute(importerPath)) return null;
  const candidate = path.isAbsolute(pathPart)
    ? path.resolve(pathPart)
    : path.resolve(path.dirname(importerPath), pathPart);

  for (const mirrorRoot of authoredBinaryMirrorRoots) {
    if (!pathIsWithin(mirrorRoot, candidate)) continue;
    const relPath = normalizePath(path.relative(mirrorRoot, candidate));
    if (
      relPath === "" ||
      relPath === ".." ||
      relPath.startsWith("../") ||
      path.isAbsolute(relPath)
    ) {
      return null;
    }
    return { relPath: applyDefaultProgramArch(relPath), query };
  }
  return null;
}

function sourceOnlyFallbackArtifactGlob(
  specifier: string,
  importer: string,
): boolean {
  const pathPart = specifier.split(/[?#]/, 1)[0];
  if (!pathPart.startsWith(".") || !path.isAbsolute(importer)) return false;
  const candidate = path.resolve(
    path.dirname(importer.split("?", 1)[0]),
    pathPart,
  );
  return [
    path.resolve(repoRoot, "packages/registry"),
    path.resolve(__dirname, "public"),
  ].some((fallbackRoot) => pathIsWithin(fallbackRoot, candidate));
}

function resolveBinariesAlias(
  access: BinaryDevAccess,
  resolution: BrowserBinaryResolution,
): Plugin {
  const PREFIX = "@binaries/";

  return {
    name: "resolve-binaries-alias",
    enforce: "pre",
    resolveId(source, importer, options) {
      let request: BinaryMirrorImport | null = null;
      if (source.startsWith(PREFIX)) {
        const queryIndex = source.indexOf("?");
        const pathPart =
          queryIndex === -1 ? source : source.slice(0, queryIndex);
        request = {
          relPath: applyDefaultProgramArch(pathPart.slice(PREFIX.length)),
          query: queryIndex === -1 ? "" : source.slice(queryIndex),
        };
      } else {
        // Vite expands import.meta.glob() before normal alias resolution and
        // follows matching mirror symlinks lexically. Convert those concrete
        // mirror paths back into package-relative requests so they receive the
        // same provenance check and exact-file capability as @binaries.
        request = relativeBinaryMirrorImport(source, importer);
      }
      if (request === null) return null;
      if (options.scan) {
        // Vite's dependency scanner only classifies the import graph; it does
        // not load these assets. Explicitly mark the authored specifier
        // external: returning null makes Vite classify the @binaries prefix as
        // a missing bare dependency before it recognizes the ?url query.
        // The real transform request returns here without `scan` and performs
        // the complete resolver/capability check before any bytes are served.
        return { id: source, external: true };
      }

      if (sourceOnlyViteAssets !== null) {
        return sourceOnlyViteAssets.resolve(request.relPath);
      }

      const resolved = resolution.resolve(request.relPath);
      if (resolved) return resolved + request.query;
      if (configuredSourceOnlyRoot !== null) {
        this.error(
          `Browser binary ${request.relPath} is not owned by the SourceOnly ` +
            `projection at ${configuredSourceOnlyRoot}`,
        );
      }
      const local = path.resolve(repoRoot, "local-binaries", request.relPath);
      const fetched = path.resolve(repoRoot, "binaries", request.relPath);
      this.error(
        `Browser binary ${request.relPath} not found, or every candidate is stale. ` +
          `Looked at:\n  ${local}\n  ${fetched}\n` +
          `Run \`./run.sh fetch\` to install release archives, or build the artifact locally.`,
      );
    },
    configureServer(server) {
      access.attachServer(server);
    },
  };
}

/**
 * Vite plugin: rewrite absolute nav links in HTML to include the base path.
 * In dev mode (base="/") this is a no-op. In production with a custom base
 * (e.g. "/kandelo/"), it rewrites href="/" → href="/kandelo/".
 */
function rewriteNavLinks(): Plugin {
  let base = "/";
  return {
    name: "rewrite-nav-links",
    configResolved(config) {
      base = config.base;
    },
    transformIndexHtml(html) {
      if (base === "/") return html;
      // Rewrite href="/..." links to href="${base}..." but skip links that
      // Vite has already prefixed with the base path (e.g. asset preloads)
      const baseRest = base.slice(1); // "kandelo/"
      const escaped = baseRest.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const re = new RegExp(`href="\\/(?!${escaped})(?!\\/)`, "g");
      return html.replace(re, `href="${base}`);
    },
  };
}

/**
 * Vite plugin: inject a git revision tag into the sidebar of every HTML page.
 * The revision is read at build/serve time and rendered as a link to the
 * GitHub commit.
 */
function injectGitRevision(): Plugin {
  let shortRev = "";
  let commitUrl = "";
  return {
    name: "inject-git-revision",
    configResolved() {
      try {
        shortRev = execSync("git rev-parse --short HEAD", {
          cwd: repoRoot,
          encoding: "utf-8",
        }).trim();
        const remoteUrl = execSync("git remote get-url origin", {
          cwd: repoRoot,
          encoding: "utf-8",
        }).trim();
        // Convert git@github.com:user/repo.git or https://github.com/user/repo.git
        const match = remoteUrl.match(/github\.com[:/](.+?)(?:\.git)?$/);
        const repoPath = match ? match[1] : "brandonpayton/kandelo";
        const fullRev = execSync("git rev-parse HEAD", {
          cwd: repoRoot,
          encoding: "utf-8",
        }).trim();
        commitUrl = `https://github.com/${repoPath}/commit/${fullRev}`;
      } catch {
        shortRev = "unknown";
        commitUrl = "";
      }
    },
    transformIndexHtml(html) {
      if (!shortRev) return html;
      const tag = commitUrl
        ? `<a class="sidebar-revision" href="${commitUrl}" target="_blank" rel="noopener">rev: ${shortRev}</a>`
        : `<span class="sidebar-revision">rev: ${shortRev}</span>`;
      return html.replace("</nav>", `  ${tag}\n  </nav>`);
    },
  };
}

/**
 * Vite plugin: inject the COI (Cross-Origin Isolation) service worker bootstrap
 * script into HTML pages during production builds. The service worker adds
 * COOP/COEP headers to all responses, enabling SharedArrayBuffer on hosts
 * like GitHub Pages that don't support custom HTTP headers.
 *
 * Skipped in dev mode because Vite's dev server sets the headers directly.
 */
function injectCoiServiceWorker(): Plugin {
  let base = "/";
  let isDev = false;
  return {
    name: "inject-coi-service-worker",
    configResolved(config) {
      base = config.base;
      isDev = config.command === "serve";
    },
    transformIndexHtml(html) {
      if (isDev) return html;
      const tag = `<script src="${base}service-worker.js"></script>`;
      return html.replace("<head>", `<head>\n  ${tag}`);
    },
  };
}

/**
 * Keep local module-worker reloads usable under COEP in WebKit.
 *
 * WebKit 26.5 rejects a second same-page module Worker load when it
 * conditionally revalidates Vite's transformed worker response, even though
 * both the original response and the page carry matching COEP/CORP headers.
 * Removing only the worker request validators makes Vite return the same
 * transformed bytes with a normal 200 response. Production assets do not use
 * this middleware; the deployed service worker adds the isolation headers to
 * its cached response itself.
 */
function forceFreshDevWorkerResponses(): Plugin {
  function attachMiddleware(
    middlewares: ViteDevServer["middlewares"] | PreviewServer["middlewares"],
  ): void {
    middlewares.use((req, _res, next) => {
      if (req.headers["sec-fetch-dest"] === "worker") {
        delete req.headers["if-none-match"];
        delete req.headers["if-modified-since"];
      }
      next();
    });
  }

  return {
    name: "force-fresh-dev-worker-responses",
    configureServer(server) {
      attachMiddleware(server.middlewares);
    },
    configurePreviewServer(server) {
      attachMiddleware(server.middlewares);
    },
  };
}

/**
 * Vite plugin: inject the service worker CORS proxy profile. Local dev/preview
 * uses the Vite same-origin proxy by default so the service worker can read
 * the response from whichever port Vite selected. Production builds use the
 * configured external proxy unless VITE_CORS_PROXY_URL overrides it.
 */
function injectCorsProxyConfig(): Plugin {
  let servedCorsProxyConfig = buildCorsProxyConfig();
  let outputCorsProxyConfig = buildCorsProxyConfig();
  let outputRoot = path.resolve(__dirname, "dist");
  let base = "/";
  const sourceSwPath = path.resolve(__dirname, "public", "service-worker.js");

  function serviceWorkerSource(): string {
    return injectBlobIframeInterceptorPlaceholder(
      injectCorsProxyConfigPlaceholder(
        fs.readFileSync(sourceSwPath, "utf-8"),
        servedCorsProxyConfig,
      ),
    );
  }

  function attachMiddleware(
    middlewares: ViteDevServer["middlewares"] | PreviewServer["middlewares"],
  ): void {
    const serviceWorkerPath = serviceWorkerPathForBase(base);
    middlewares.use((req, res, next) => {
      if (!req.url) {
        next();
        return;
      }
      const pathname = new URL(req.url, "http://localhost").pathname;
      if (pathname !== serviceWorkerPath) {
        next();
        return;
      }
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/javascript; charset=utf-8");
      res.setHeader("Cache-Control", "no-store");
      res.end(serviceWorkerSource());
    });
  }

  return {
    name: "inject-cors-proxy-config",
    configResolved(config) {
      base = config.base;
      outputRoot = path.resolve(config.root, config.build.outDir);
      servedCorsProxyConfig = browserCorsProxyConfig(
        configuredCorsProxyUrl() || devCorsProxyFetchUrlForBase(base),
      );
      outputCorsProxyConfig = buildCorsProxyConfig();
    },
    configureServer(server) {
      attachMiddleware(server.middlewares);
    },
    configurePreviewServer(server) {
      attachMiddleware(server.middlewares);
    },
    writeBundle() {
      // service-worker.js is in public/ and Vite copies it to the resolved outDir.
      const swPath = path.resolve(outputRoot, "service-worker.js");
      if (fs.existsSync(swPath)) {
        let content = fs.readFileSync(swPath, "utf-8");
        content = injectCorsProxyConfigPlaceholder(
          content,
          outputCorsProxyConfig,
        );
        content = injectBlobIframeInterceptorPlaceholder(content);
        fs.writeFileSync(swPath, content);
      }
    },
  };
}

function devCorsProxyMiddleware(): Plugin {
  let base = "/";

  function attachMiddleware(
    middlewares: ViteDevServer["middlewares"] | PreviewServer["middlewares"],
  ): void {
    const proxyPath = devCorsProxyPathForBase(base);
    middlewares.use(async (req, res, next) => {
      if (!(await handleDevCorsProxyRequest(req, res, proxyPath))) next();
    });
  }

  return {
    name: "dev-cors-proxy-middleware",
    configResolved(config) {
      base = config.base;
    },
    configureServer(server) {
      attachMiddleware(server.middlewares);
    },
    configurePreviewServer(server) {
      attachMiddleware(server.middlewares);
    },
  };
}

const defaultDemoInputs = {
  main: path.resolve(__dirname, "index.html"),
  kandelo: path.resolve(__dirname, "pages/kandelo/index.html"),
  network: path.resolve(__dirname, "pages/network/index.html"),
};

const demoInputs = {
  ...defaultDemoInputs,
  "sqlite-test": path.resolve(__dirname, "pages/sqlite-test/index.html"),
  benchmark: path.resolve(__dirname, "pages/benchmark/index.html"),
  "php-test": path.resolve(__dirname, "pages/php-test/index.html"),
  // The perl, python, ruby, erlang, texlive, and redis demos are not bundled
  // into this static build while their slow builds live in package sources.
  // The demo app exposes only repository-defined gallery entries.
};

function sourceOnlyDemoInputs<T extends Record<string, string>>(
  selected: T,
): T {
  if (configuredSourceOnlyRoot === null) return selected;
  const unsupported = Object.keys(selected).filter(
    (name) => !(name in defaultDemoInputs),
  );
  if (unsupported.length > 0) {
    throw new Error(
      "SourceOnly browser builds admit only the root main, kandelo, and network inputs; " +
        `these inputs still depend on ambient build outputs: ${unsupported.join(", ")}`,
    );
  }
  return selected;
}

function selectedDemoInputs(): typeof demoInputs | Record<string, string> {
  const requested = process.env.KANDELO_BROWSER_DEMO_INPUTS?.split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  if (!requested || requested.length === 0) {
    return sourceOnlyDemoInputs(defaultDemoInputs);
  }

  const selected: Record<string, string> = {};
  for (const name of requested) {
    if (!(name in demoInputs)) {
      throw new Error(`Unknown KANDELO_BROWSER_DEMO_INPUTS entry: ${name}`);
    }
    selected[name] = demoInputs[name as keyof typeof demoInputs];
  }
  return sourceOnlyDemoInputs(selected);
}

const disableBrowserTestHmr = process.env.KANDELO_BROWSER_TEST_NO_HMR === "1";

export default defineConfig(() => {
  const base = normalizeDeploymentBase(process.env.VITE_BASE ?? "/");

  return {
    base,
    publicDir: sourceOnlyPublicSnapshot?.path ?? "public",
    resolve: {
      alias: browserRepositoryAliases(repoRoot),
    },
    plugins: [
      vfsProductsPlugin(base),
      react(),
      ...(sourceOnlyViteAssets === null
        ? []
        : [sourceOnlyViteAssets.plugin()]),
      resolveKernelArtifactsAlias(binaryDevAccess),
      resolveBinariesAlias(binaryDevAccess, browserBinaryResolution),
      rewriteNavLinks(),
      injectGitRevision(),
      injectCoiServiceWorker(),
      forceFreshDevWorkerResponses(),
      injectCorsProxyConfig(),
      devCorsProxyMiddleware(),
    ],
    server: {
      host: "127.0.0.1",
      port: preferredLocalPort,
      headers: crossOriginIsolationHeaders,
      hmr: disableBrowserTestHmr ? false : undefined,
      watch: disableBrowserTestHmr
        ? {
            ignored: ["**/test-runs/**", "**/host/dist/**"],
          }
        : undefined,
      fs: {
        // Multi-member package resolution returns canonical generation paths so
        // a live mirror swap cannot change the bytes after validation. Resolver
        // plugins approve exact files, and the pre-serving guard rejects every
        // other cache path (including symlinks and approved-path descendants).
        allow: [repoRoot, browserExternalArtifactRoot],
      },
    },
    preview: {
      host: "127.0.0.1",
      port: preferredLocalPort,
      headers: crossOriginIsolationHeaders,
    },
    build: {
      // Use terser instead of esbuild for minification. esbuild's minifier
      // drops variable declarations from TypeScript const-enum IIFEs in
      // @xterm/xterm's pre-built ESM bundle, producing assignments to
      // undeclared variables that throw ReferenceError in strict mode
      // (Firefox).
      minify: "terser",
      rollupOptions: {
        input: selectedDemoInputs(),
      },
    },
    worker: {
      format: "es",
      rollupOptions: {
        output: {
          inlineDynamicImports: true,
        },
      },
      plugins: () => [
        vfsProductsPlugin(base),
        ...(sourceOnlyViteAssets === null
          ? []
          : [sourceOnlyViteAssets.plugin()]),
        resolveKernelArtifactsAlias(binaryDevAccess),
        resolveBinariesAlias(binaryDevAccess, browserBinaryResolution),
        dropWorkerEntryExports(),
      ],
    },
    assetsInclude: [
      "**/*.wasm",
      "**/*.sql",
      "**/*.vfs",
      "**/*.vfs.zst",
      "**/*.zip",
    ],
  };
});
