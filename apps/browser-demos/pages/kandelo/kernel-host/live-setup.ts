// Builds a LiveKernelHost over a real BrowserKernel for the Kandelo page.

import { BrowserKernel } from "@host/browser-kernel-host";
import type { MachineCheckpoint } from "@host/migration/checkpoint";
import type { ReplicationLogEntry } from "@host/replication/log";
import type { ReplicationReplaySpec } from "@host/replication/worker";
import { ensureServiceWorkerReady } from "../../../lib/init/service-worker-bridge";
import { setupServiceWorkerFetchBridge } from "../../../lib/init/sw-bridge-fetch";
import {
  bindImageOwnedRuntimeUrls,
  type ImageOwnedRuntimeLazyAssets,
} from "../../../lib/init/image-owned-runtime-urls";
import {
  WORDPRESS_CONFIG_INIT_SCRIPT,
  WORDPRESS_URL_MU_PLUGIN,
  patchWordPressMysqliPersistentSource,
  renderWordPressConfig,
  wordpressConfigTemplate,
  type WordPressDatabaseKind,
} from "../../../lib/init/wordpress-runtime-config";
import { MYSQL_BENCHMARK_PHP } from "../../../lib/init/mysql-benchmark";
import {
  WORDPRESS_MARIADB_READY_FILE,
  WORDPRESS_MARIADB_READY_PATH,
  WORDPRESS_MARIADB_READY_PHP,
  WORDPRESS_MARIADB_SOCKET_PATH,
} from "../../../lib/init/wordpress-mariadb-readiness";
import { MemoryFileSystem } from "../../../../../host/src/vfs/memory-fs";
import {
  resolveBrowserCorsProxyConfig,
} from "../../../lib/browser-cors-proxy";
import {
  finalizeKernelOwnedImage,
  settleWebKitReclaim,
  trackTransientImageBuffer,
} from "../../../lib/kernel-owned-boot";
import {
  ensureDirRecursive,
  writeVfsBinary,
  writeVfsFile,
} from "../../../../../host/src/vfs/image-helpers";
import { ABI_VERSION } from "../../../../../host/src/generated/abi";
import {
  LiveKernelHost,
  type BootDescriptor,
  type DemoPresentation,
  type GalleryItem,
} from "../../../../../web-libs/kandelo-session/src/kernel-host";
import { validateBootDescriptor } from "../../../../../web-libs/kandelo-session/src/boot-descriptor";
import {
  genericDemoPresentation,
  resolveDemoAssets,
  resolveDemoGuide,
  resolveDemoIngest,
  resolveDemoPresentation,
  type KandeloDemoConfig,
} from "../../../../../web-libs/kandelo-session/src/demo-config";
import { readKandeloDemoConfigFromVfs } from "../../../../../web-libs/kandelo-session/src/demo-config-vfs";
import {
  EXPERIMENTAL_TERMINAL_SESSION_PATH,
  MAX_EXPERIMENTAL_TERMINAL_SESSION_BYTES,
  experimentalTerminalSessionPolicy,
  parseExperimentalTerminalSession,
  type ExperimentalTerminalProgram,
  type ExperimentalTerminalSession,
} from "../../../../../web-libs/kandelo-session/src/experimental-terminal-session";
import {
  CUSTOM_VFS_PROFILE_MAX_BYTES,
  DEFAULT_VFS_PROFILE_MAX_BYTES,
  MAIN_SHELL_VFS_PROFILE_MAX_BYTES,
  SHELL_DERIVED_VFS_PROFILE_MAX_BYTES,
  assertVfsImageFitsProfile,
  declaredVfsMaxByteLength,
} from "../../../../../web-libs/kandelo-session/src/vfs-capacity";
import {
  builtinDemoAssets,
  builtinDemoGuide,
  builtinDemoPresentation,
} from "../../../../../web-libs/kandelo-session/src/demo-guides";
import { PRESET_LIBRARY } from "../presets";
import {
  descriptorWithVfsImageUrl,
  demoIdFromVfsImageUrl,
  matchTrustedVfsSourceId,
  normalizeVfsImageUrl,
  titleFromVfsImageUrl,
  vfsImageUrlFromDescriptor,
} from "../url-state";
import { verifyImportedSealsForCurrentBoot } from "./boot-current-boundary";
import {
  candidateEvidenceBootDescriptor,
  candidateEvidenceKernelInitOptions,
  candidateEvidenceLiveDemoId,
  createProtectedCandidatePagesVfsPlacement,
  installProtectedCandidatePagesActivation,
  fetchProtectedCandidateVfs,
  PROTECTED_BROWSER_EVIDENCE_MAX_PROCESS_MEMORY_BYTES,
  readInjectedProtectedBrowserEvidence,
  type InjectedProtectedCandidateVfsV1,
  type ProtectedCandidatePagesVfsPlacement,
} from "./candidate-evidence-vfs";
import {
  resolveOptionalDemoVfsUrl,
  type OptionalDemoVfsImage,
} from "./optional-demo-vfs";
import {
  createPagesVfsProductLoader,
  type PagesVfsProductEntry,
} from "./pages-vfs-product-loader";
import { stageConfiguredAssets } from "./configured-assets";
import {
  deploymentScopeFromServiceWorkerUrl,
} from "../../../../../web-libs/kandelo-session/src/deployment-scope";
import { createCoiReloadSessionState } from "./coi-reload-session-state";
import {
  DinitBootStatusTracker,
  REQUIRED_DINIT_SERVICES,
} from "./dinit-boot-status";

import kernelWasmUrl from "@kernel-wasm?url";
import shellVfsUrl from "@binaries/programs/wasm32/shell.vfs.zst?url";
import dinitWasmUrl from "@binaries/programs/wasm32/dinit/dinit.wasm?url";
// @ts-expect-error Vite owns this virtual module in both canonical and normal mode.
import canonicalPagesVfsProducts from "virtual:kandelo-pages-vfs-products";

const CANONICAL_PAGES_VFS_PRODUCTS = canonicalPagesVfsProducts as
  | readonly PagesVfsProductEntry[]
  | null;
const CANONICAL_PAGES_VFS_LOADER = CANONICAL_PAGES_VFS_PRODUCTS === null
  ? undefined
  : createPagesVfsProductLoader(
    CANONICAL_PAGES_VFS_PRODUCTS,
    (url, init) => fetch(url, init),
  );

const OPTIONAL_BINARY_URLS = {
  ...import.meta.glob(
    "../../../../../local-binaries/programs/wasm32/fbtest.wasm",
    {
      query: "?url",
      import: "default",
    },
  ),
  ...import.meta.glob("../../../../../binaries/programs/wasm32/fbtest.wasm", {
    query: "?url",
    import: "default",
  }),
  ...import.meta.glob(
    "../../../../../local-binaries/programs/wasm32/nginx-vfs.vfs.zst",
    {
      query: "?url",
      import: "default",
    },
  ),
  ...import.meta.glob(
    "../../../../../binaries/programs/wasm32/nginx-vfs.vfs.zst",
    {
      query: "?url",
      import: "default",
    },
  ),
  ...import.meta.glob(
    "../../../../../local-binaries/programs/wasm32/nginx-php-vfs.vfs.zst",
    {
      query: "?url",
      import: "default",
    },
  ),
  ...import.meta.glob(
    "../../../../../binaries/programs/wasm32/nginx-php-vfs.vfs.zst",
    {
      query: "?url",
      import: "default",
    },
  ),
} as Record<string, () => Promise<string>>;

async function optionalBinaryUrl(
  relPaths: string[],
  label: string,
): Promise<string> {
  for (const relPath of relPaths) {
    const loader = OPTIONAL_BINARY_URLS[relPath];
    if (loader) return loader();
  }
  throw new Error(`${label} is not built. Run: ./run.sh build programs`);
}

const HTTP_PORT = 8080;
const PHP_FPM_PORT = 9000;
const MARIADB_SOCKET_PATH = WORDPRESS_MARIADB_SOCKET_PATH;
const MARIADB_READY_SERVICE = "mariadb-ready";
const MARIADB_READY_SCRIPT_PATH = "/usr/local/bin/mariadb-ready";
const ROOT_UID = 0;
const ROOT_GID = 0;
const ROOT_HOME = "/root";
const PHP_FPM_UID = 65534;
const PHP_FPM_GID = 65534;
const MYSQL_UID = 101;
const MYSQL_GID = 101;
const DEMO_UID = 1000;
const DEMO_GID = 1000;
const DEMO_USER = "maker";
const DEMO_HOME = "/home/maker";

class BootSuperseded extends Error {
  constructor() {
    super("boot superseded");
  }
}

type LiveVfsImage =
  "shell" | "node" | "nginx" | "nginx-php" | "wordpress" | "lamp";

type PagesVfsProductId =
  | "platform-rootfs"
  | "browser-main-shell"
  | "browser-node"
  | "browser-nginx"
  | "browser-nginx-php"
  | "browser-wordpress"
  | "browser-lamp";

type LiveVfsSource =
  | { kind: "url"; productId: PagesVfsProductId; url: string }
  | { kind: "optional-demo"; image: OptionalDemoVfsImage; productId: PagesVfsProductId }
  | {
    kind: "optional-binary";
    label: string;
    productId: PagesVfsProductId;
    relPaths: string[];
  };

type ShellProfile = "default" | "node";
type InitEnvProfile = "service" | "wordpress";

interface LiveDemoSpec {
  image: LiveVfsImage;
  shell?: ShellProfile;
  autoCommand?: string;
  memoryPages?: number;
  maxVfsByteLength?: number;
  network?: boolean;
  features?: string[];
  init?: {
    argv: string[];
    env?: InitEnvProfile;
    cwd?: string;
    programUrl?: string;
    uid?: number;
    gid?: number;
    maxWorkers?: number;
    maxMemoryPages?: number;
    web?: {
      requiredPorts: number[];
      requiredServices?: string[];
      probeHttp?: boolean;
      probePath?: string;
    };
  };
}

const VFS_SOURCES: Record<LiveVfsImage, LiveVfsSource> = {
  shell: { kind: "url", productId: "browser-main-shell", url: shellVfsUrl },
  node: { kind: "optional-demo", image: "node", productId: "browser-node" },
  nginx: {
    kind: "optional-binary",
    label: "nginx-vfs.vfs.zst",
    productId: "browser-nginx",
    relPaths: [
      "../../../../../local-binaries/programs/wasm32/nginx-vfs.vfs.zst",
      "../../../../../binaries/programs/wasm32/nginx-vfs.vfs.zst",
    ],
  },
  "nginx-php": {
    kind: "optional-binary",
    label: "nginx-php-vfs.vfs.zst",
    productId: "browser-nginx-php",
    relPaths: [
      "../../../../../local-binaries/programs/wasm32/nginx-php-vfs.vfs.zst",
      "../../../../../binaries/programs/wasm32/nginx-php-vfs.vfs.zst",
    ],
  },
  wordpress: {
    kind: "optional-demo",
    image: "wordpress",
    productId: "browser-wordpress",
  },
  lamp: { kind: "optional-demo", image: "lamp", productId: "browser-lamp" },
};

const DINIT_NGINX_ARGV = [
  "/sbin/dinit",
  "--container",
  "-p",
  "/tmp/dinitctl",
  "nginx",
];

const LIVE_DEMO_IDS = [
  "shell",
  "node",
  "nginx",
  "nginx-php",
  "wordpress-sqlite",
  "wordpress-mariadb",
  "doom",
  "modeset",
] as const;

type LiveDemoId = (typeof LIVE_DEMO_IDS)[number];

// Boot-resource reclamation (worker-owned live filesystems and transient
// image-build buffers) lives in the shared helper so every kernel-owned demo
// shares one implementation, including failures before a kernel exists.
async function settleAfterBootResourcesReleased(): Promise<void> {
  await settleWebKitReclaim();
}

const LIVE_DEMO_SPECS: Record<LiveDemoId, LiveDemoSpec> = {
  shell: {
    image: "shell",
  },
  node: {
    image: "node",
    shell: "node",
    memoryPages: 4096,
    maxVfsByteLength: SHELL_DERIVED_VFS_PROFILE_MAX_BYTES,
    network: true,
    features: ["js-workers"],
  },
  nginx: {
    image: "nginx",
    maxVfsByteLength: SHELL_DERIVED_VFS_PROFILE_MAX_BYTES,
    network: true,
    init: {
      argv: DINIT_NGINX_ARGV,
      env: "service",
      programUrl: dinitWasmUrl,
      maxWorkers: 6,
      web: {
        requiredPorts: [HTTP_PORT],
        requiredServices: [...REQUIRED_DINIT_SERVICES.nginx],
      },
    },
  },
  "nginx-php": {
    image: "nginx-php",
    maxVfsByteLength: SHELL_DERIVED_VFS_PROFILE_MAX_BYTES,
    network: true,
    init: {
      argv: DINIT_NGINX_ARGV,
      env: "service",
      programUrl: dinitWasmUrl,
      maxWorkers: 12,
      web: {
        requiredPorts: [HTTP_PORT],
        requiredServices: [...REQUIRED_DINIT_SERVICES["nginx-php"]],
      },
    },
  },
  "wordpress-sqlite": {
    image: "wordpress",
    maxVfsByteLength: SHELL_DERIVED_VFS_PROFILE_MAX_BYTES,
    network: true,
    init: {
      argv: DINIT_NGINX_ARGV,
      env: "wordpress",
      programUrl: dinitWasmUrl,
      maxWorkers: 12,
      maxMemoryPages: 4096,
      web: {
        requiredPorts: [HTTP_PORT],
        requiredServices: [...REQUIRED_DINIT_SERVICES["wordpress-sqlite"]],
      },
    },
  },
  "wordpress-mariadb": {
    image: "lamp",
    // MariaDB's Aria recovery can grow beyond the 4096-page cap used by
    // lighter PHP presets.
    memoryPages: 16384,
    maxVfsByteLength: SHELL_DERIVED_VFS_PROFILE_MAX_BYTES,
    network: true,
    init: {
      argv: DINIT_NGINX_ARGV,
      env: "wordpress",
      programUrl: dinitWasmUrl,
      maxWorkers: 24,
      maxMemoryPages: 16384,
      web: {
        requiredPorts: [HTTP_PORT, PHP_FPM_PORT],
        requiredServices: [...REQUIRED_DINIT_SERVICES["wordpress-mariadb"]],
        probeHttp: true,
        probePath: WORDPRESS_MARIADB_READY_PATH,
      },
    },
  },
  doom: {
    image: "shell",
    features: ["framebuffer"],
  },
  modeset: {
    image: "shell",
    features: ["kms"],
  },
};

const DEFAULT_DEMO_FOR_VFS_IMAGE: Record<LiveVfsImage, LiveDemoId> = {
  shell: "shell",
  node: "node",
  nginx: "nginx",
  "nginx-php": "nginx-php",
  wordpress: "wordpress-sqlite",
  lamp: "wordpress-mariadb",
};

const DEMO_ALIASES: Record<string, LiveDemoId> = {
  spidermonkey: "node",
  "spidermonkey-node": "node",
  wordpress: "wordpress-sqlite",
  lamp: "wordpress-mariadb",
};

const WEB_BOOT_LOG_DEMO_IDS = new Set<LiveDemoId>([
  "nginx",
  "nginx-php",
  "wordpress-sqlite",
  "wordpress-mariadb",
]);

interface LiveProfile {
  id: string;
  /** Canonical built-in image family, or null for custom images. */
  image: LiveVfsImage | null;
  vfsUrl: string;
  vfsSource?: LiveVfsSource;
  candidateEvidence?: InjectedProtectedCandidateVfsV1;
  candidateVfsPlacement?: ProtectedCandidatePagesVfsPlacement;
  descriptor: BootDescriptor;
  shell: ShellProfile;
  maxVfsByteLength: number;
  maxMemoryPages?: number;
  autoCommand?: string;
  fallbackPresentation?: DemoPresentation;
  init?: {
    argv: string[];
    env?: string[];
    cwd?: string;
    programUrl?: string;
    uid?: number;
    gid?: number;
    maxWorkers?: number;
    maxMemoryPages?: number;
    web?: {
      label: string;
      requiredPorts: number[];
      requiredServices?: string[];
      probeHttp: boolean;
      probePath?: string;
    };
  };
  framebufferTest: boolean;
}

interface WebReadinessState {
  ready: boolean;
  probing: boolean;
  failed: boolean;
}

const APP_PREFIX = import.meta.env.BASE_URL + "app/";
const APP_PATH = import.meta.env.BASE_URL + "app";
const PROTO = window.location.protocol === "https:" ? "https" : "http";
const SW_URL = import.meta.env.BASE_URL + "service-worker.js";
const SW_SCOPE = deploymentScopeFromServiceWorkerUrl(
  new URL(SW_URL, window.location.href).href,
  window.location.href,
);
const BROWSER_CORS_PROXY = resolveBrowserCorsProxyConfig({
  configuredUrl: import.meta.env.VITE_CORS_PROXY_URL,
  development: import.meta.env.DEV,
  baseUrl: import.meta.env.BASE_URL,
  pageUrl: window.location.href,
});
const COI_RELOAD_SESSION_STATE = createCoiReloadSessionState(
  SW_SCOPE,
  sessionStorage,
);
const PHP_FPM_WORKERS = 6;
const PATCHED_PHP_FPM_CONF = `[global]
daemonize = no
error_log = /dev/stderr
log_level = notice

[www]
user = nobody
group = nobody
listen = 127.0.0.1:9000
pm = static
pm.max_children = ${PHP_FPM_WORKERS}
clear_env = no
slowlog = /dev/null
request_slowlog_trace_depth = 0
`;

const SHELL_ENV: string[] = [
  `HOME=${DEMO_HOME}`,
  "TMPDIR=/tmp",
  "TERM=xterm-256color",
  "LANG=en_US.UTF-8",
  "PATH=/usr/local/bin:/usr/bin:/bin:/sbin:/usr/sbin",
  `USER=${DEMO_USER}`,
  `LOGNAME=${DEMO_USER}`,
  "PS1=kandelo$ ",
  `HISTFILE=${DEMO_HOME}/.bash_history`,
  "SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt",
  "SSL_CERT_DIR=/etc/ssl/certs",
];

const NODE_SHELL_ENV: string[] = [
  `HOME=${DEMO_HOME}`,
  `PWD=${DEMO_HOME}`,
  "TMPDIR=/tmp",
  "TERM=xterm-256color",
  "LANG=en_US.UTF-8",
  "PATH=/usr/local/bin:/usr/bin:/bin:/sbin:/usr/sbin",
  `USER=${DEMO_USER}`,
  `LOGNAME=${DEMO_USER}`,
  "PS1=spidermonkey-node$ ",
  `HISTFILE=${DEMO_HOME}/.bash_history`,
  "SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt",
  "SSL_CERT_DIR=/etc/ssl/certs",
  "npm_config_cache=/tmp/.npm-cache",
  "npm_config_registry=https://registry.npmjs.org/",
  "npm_config_fund=false",
  "npm_config_audit=false",
  "npm_config_progress=false",
  "npm_config_update_notifier=false",
  "NPM_CONFIG_FUND=false",
  "NPM_CONFIG_AUDIT=false",
  "NPM_CONFIG_PROGRESS=false",
  "NPM_CONFIG_UPDATE_NOTIFIER=false",
];

const SERVICE_ENV: string[] = [
  `HOME=${ROOT_HOME}`,
  "TMPDIR=/tmp",
  "TERM=xterm-256color",
  "USER=root",
  "LOGNAME=root",
  "PATH=/usr/local/bin:/usr/bin:/bin:/sbin:/usr/sbin",
  "SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt",
  "SSL_CERT_DIR=/etc/ssl/certs",
];

const SHELL_PROFILES: Record<ShellProfile, { env: string[]; cwd: string }> = {
  default: { env: SHELL_ENV, cwd: DEMO_HOME },
  node: { env: NODE_SHELL_ENV, cwd: DEMO_HOME },
};

const INIT_ENV_PROFILES: Record<InitEnvProfile, () => string[]> = {
  service: () => SERVICE_ENV,
  wordpress: () => [
    ...SERVICE_ENV,
    `WP_APP_PATH=${APP_PATH}`,
    `WP_PROTO=${PROTO}`,
  ],
};

export type FbDemo = "none" | "test";

export interface CreateLiveHostOptions {
  demo?: string | null;
  vfsUrl?: string | null;
  fb?: FbDemo;
}

export async function createLiveHost(
  opts: CreateLiveHostOptions = {},
): Promise<LiveKernelHost> {
  if (CANONICAL_PAGES_VFS_LOADER !== undefined) {
    await Promise.all([
      CANONICAL_PAGES_VFS_LOADER.activate("platform-rootfs"),
      CANONICAL_PAGES_VFS_LOADER.activate("browser-main-shell"),
    ]);
  }
  let currentKernel: BrowserKernel | null = null;
  let bootSeq = 0;
  let serviceWorkerReady: Promise<ServiceWorker> | null = null;
  const candidateEvidence = readInjectedProtectedBrowserEvidence(
    window.__KANDELO_ABI_STAGING_BROWSER_EVIDENCE__,
  );
  const candidateVfsPlacement = candidateEvidence === undefined
    ? undefined
    : createProtectedCandidatePagesVfsPlacement(
      candidateEvidence.vfs,
      async (source) => {
        if (source.pagesLoad === "lazy" && source.optionalImage !== undefined) {
          const resolved = await resolveOptionalDemoVfsUrl(
            source.optionalImage,
            undefined,
            source,
          );
          if (resolved !== source.url) {
            throw new Error("candidate Pages VFS resolver changed its protected URL");
          }
        }
        return fetchProtectedCandidateVfs(source);
      },
    );
  const protectedProfile = candidateEvidence === undefined
    ? undefined
    : profileForCandidateEvidence(candidateEvidence, candidateVfsPlacement!);
  const localGalleryItems = protectedProfile === undefined
    ? liveGalleryItems()
    : [];

  const initialDescriptor = protectedProfile?.descriptor ??
    await descriptorForBootQuery(opts.vfsUrl, opts.demo);
  // A page holds a machine at load only once the boot query or an ABI staging
  // profile asks for one. Booting a default shell for a bare URL spends a
  // whole image download on a choice the visitor never made, and leaves a page
  // that came to watch another computer's machine contending with one of its
  // own. A gallery launch arrives later, through applyBootDescriptor.
  const machineRequested = protectedProfile !== undefined ||
    Boolean(opts.demo?.trim()) || Boolean(opts.vfsUrl?.trim());
  let host: LiveKernelHost;
  let protectedBoot: Promise<void> | undefined;
  const activateProtectedProfile = (): Promise<void> => {
    if (protectedProfile === undefined || candidateVfsPlacement === undefined) {
      return Promise.reject(new Error("protected candidate profile is unavailable"));
    }
    protectedBoot ??= (async () => {
      await candidateVfsPlacement.activate();
      await startBoot(host, protectedProfile, protectedProfile.descriptor);
    })();
    return protectedBoot;
  };
  host = new LiveKernelHost({
    status: machineRequested ? "booting" : "idle",
    descriptor: initialDescriptor,
    galleryItems: localGalleryItems,
    applyBootDescriptor: async (desc, h, restore, replay) => {
      if (protectedProfile !== undefined) {
        assertProtectedCandidateDescriptor(desc, protectedProfile.descriptor);
        await activateProtectedProfile();
        return;
      }
      // The session layer carries a checkpoint it never reads, so it names one
      // by the minimal `MachineCheckpointLike`. This is the layer that knows
      // the value is the host runtime's own `MachineCheckpoint`, because it is
      // the layer that hands it back to a kernel of the kind that produced it.
      await startBoot(
        h,
        profileForDescriptor(desc, "none"),
        desc,
        restore as MachineCheckpoint | undefined,
        // Only the two values the kernel worker runs on. `replay` also carries
        // the session layer's own way of releasing this replica, which is a
        // function and cannot be structured-cloned into a worker.
        replay === undefined
          ? undefined
          : {
            entries: replay.entries as readonly ReplicationLogEntry[],
            queue: replay.queue,
          },
      );
    },
    prewarmBootDescriptor: async (desc) => {
      // A protected page boots the one image that was placed with it. Nothing
      // another computer names should send this one off to load something.
      if (protectedProfile !== undefined) return;
      await prewarmProfileImage(profileForDescriptor(desc, "none"));
    },
  });

  const requireServiceWorker = (
    tick?: (msg: string) => void,
  ): Promise<ServiceWorker> => {
    if (!serviceWorkerReady) {
      tick?.("preparing service worker...");
      serviceWorkerReady = ensureServiceWorkerReady(SW_URL, SW_SCOPE)
        .then(async (controller): Promise<ServiceWorker> => {
          if (window.crossOriginIsolated) {
            COI_RELOAD_SESSION_STATE.clear();
            return controller;
          }

          if (COI_RELOAD_SESSION_STATE.wasAttempted()) {
            COI_RELOAD_SESSION_STATE.clear();
            throw new Error(
              "Kandelo could not enable cross-origin isolation after the service worker became active. " +
                "Reload the page; if this persists, clear site data for this site and check whether a browser extension is blocking service workers or COOP/COEP headers.",
            );
          }

          COI_RELOAD_SESSION_STATE.markAttempted();
          tick?.(
            "service worker active; reloading to enable cross-origin isolation...",
          );
          window.location.reload();
          return new Promise<never>((_, reject) => {
            window.setTimeout(() => {
              reject(
                new Error(
                  "Kandelo requested a reload to enable cross-origin isolation, but the page did not unload.",
                ),
              );
            }, 5_000);
          });
        })
        .catch((err) => {
          serviceWorkerReady = null;
          throw err;
        });
    }
    const ready = serviceWorkerReady;
    if (!ready) {
      throw new Error(
        "Kandelo service worker readiness promise was not initialized.",
      );
    }
    return ready;
  };

  if (protectedProfile === undefined) {
    if (machineRequested) {
      void startBoot(
        host,
        profileForDescriptor(initialDescriptor, opts.fb),
        initialDescriptor,
      );
    }
  } else if (candidateVfsPlacement!.pagesLoad === null) {
    void activateProtectedProfile();
  } else {
    installProtectedCandidatePagesActivation(
      window,
      candidateVfsPlacement!,
      activateProtectedProfile,
    );
  }
  return host;

  async function startBoot(
    h: LiveKernelHost,
    profile: LiveProfile,
    descriptor: BootDescriptor,
    restoreCheckpoint?: MachineCheckpoint,
    replicationReplay?: ReplicationReplaySpec,
  ): Promise<void> {
    const seq = ++bootSeq;
    const previousKernel = currentKernel;
    currentKernel = null;
    // WHY: detach while this activation still owns the previous generation.
    // If we await teardown first, a newer boot can attach its kernel and this
    // superseded activation would detach that newer generation on resume.
    h.detachKernel();
    if (previousKernel) {
      await previousKernel.destroy().catch(() => {});
      await settleAfterBootResourcesReleased();
    }
    const bootStartedAt = performance.now();

    try {
      const kernel = await bootProfile(
        h,
        profile,
        descriptor,
        bootStartedAt,
        () => seq === bootSeq,
        requireServiceWorker,
        restoreCheckpoint,
        replicationReplay,
      );
      if (seq !== bootSeq) {
        await kernel.destroy().catch(() => {});
        await settleAfterBootResourcesReleased();
        return;
      }
      currentKernel = kernel;
    } catch (err) {
      // Failed composition can abandon a private staged filesystem before a
      // BrowserKernel exists. Its discard hook registered the buffer; run the
      // same bounded WebKit reclamation pass used after worker teardown.
      await settleAfterBootResourcesReleased();
      if (err instanceof BootSuperseded || seq !== bootSeq) return;
      currentKernel = null;
      h.detachKernel();
      showBootError(h, descriptor, err, bootStartedAt);
    }
  }
}

function assertProtectedCandidateDescriptor(
  actual: BootDescriptor,
  expected: BootDescriptor,
): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      "protected browser candidate evidence cannot switch boot descriptors",
    );
  }
}

function showBootError(
  host: LiveKernelHost,
  descriptor: BootDescriptor,
  err: unknown,
  bootStartedAt: number,
): void {
  const message = err instanceof Error ? err.message : String(err);
  host.clearDmesg();
  host.setWebPreview(null);
  host.setDemoGuide(null);
  host.setDescriptor(descriptor);
  host.setPresentation({
    bootPrimary: "syslog",
    runningPrimary: ["syslog"],
    terminalAccess: "drawer",
    internalsAccess: "drawer",
  });
  host.pushDmesg({
    t: bootElapsedMs(bootStartedAt),
    level: "err",
    facility: "kandelo",
    msg: `Failed to boot ${descriptor.title || descriptor.id}`,
  });
  host.pushDmesg({
    t: bootElapsedMs(bootStartedAt),
    level: "err",
    facility: "kandelo",
    msg: message,
  });
  host.setStatus("error");
}

function bootElapsedMs(bootStartedAt: number): number {
  return Math.max(0, performance.now() - bootStartedAt);
}

async function descriptorForBootQuery(
  vfsUrl: string | null | undefined,
  demo: string | null | undefined,
): Promise<BootDescriptor> {
  const normalizedVfsUrl = normalizeVfsImageUrl(vfsUrl);
  if (!normalizedVfsUrl) return descriptorFor(normalizeDemoId(demo) ?? "shell");

  const liveId = await liveDemoIdForVfsImageUrl(normalizedVfsUrl, demo);
  const base = descriptorFor(liveId ?? "shell");
  return descriptorWithVfsImageUrl(
    base,
    normalizedVfsUrl,
    liveId
      ? {
          id: liveId,
          title: base.title,
          packages: base.packages,
        }
      : {
          id: demoIdFromVfsImageUrl(normalizedVfsUrl),
          title: titleFromVfsImageUrl(normalizedVfsUrl),
          packages: [],
        },
  );
}

function profileForDescriptor(desc: BootDescriptor, fb?: FbDemo): LiveProfile {
  const vfsUrl = vfsImageUrlFromDescriptor(desc);
  if (!vfsUrl) return profileFor(desc.id, fb);

  const knownDemo = normalizeDemoId(desc.id);
  const profile = knownDemo
    ? profileFor(knownDemo, fb)
    : customVfsProfile(desc, vfsUrl, fb);

  return {
    ...profile,
    id: knownDemo ?? desc.id,
    vfsUrl,
    descriptor: desc,
    init: profile.init === undefined
      ? undefined
      : {
        ...profile.init,
        // WHY: an explicit VFS image is a complete product closure. Fetching
        // the built-in init binary would hide an incomplete image and makes
        // canonical Pages depend on the forbidden legacy binary graph.
        programUrl: undefined,
      },
  };
}

function profileForCandidateEvidence(
  evidence: InjectedProtectedCandidateVfsV1,
  placement: ProtectedCandidatePagesVfsPlacement,
): LiveProfile {
  const liveDemoId = candidateEvidenceLiveDemoId(evidence.vfs.profile);
  const base = profileFor(liveDemoId, "none");
  const descriptor = candidateEvidenceBootDescriptor(base.descriptor, evidence);
  return {
    ...base,
    vfsUrl: evidence.vfs.url,
    vfsSource: undefined,
    descriptor,
    candidateEvidence: evidence,
    candidateVfsPlacement: placement,
    init: base.init === undefined
      ? undefined
      : {
        ...base.init,
        argv: evidence.boot.argv.slice(),
        env: envArray(evidence.boot.env),
        cwd: evidence.boot.cwd,
        uid: evidence.boot.uid,
        gid: evidence.boot.gid,
        // Candidate products own their complete executable closure. Pulling
        // dinit or another program from the default Vite graph would make
        // evidence pass with an incomplete candidate image.
        programUrl: undefined,
      },
  };
}

function customVfsProfile(
  desc: BootDescriptor,
  vfsUrl: string,
  fb?: FbDemo,
): LiveProfile {
  return {
    id: desc.id,
    image: null,
    vfsUrl,
    descriptor: desc,
    shell: "default",
    maxVfsByteLength: CUSTOM_VFS_PROFILE_MAX_BYTES,
    framebufferTest: fb === "test",
  };
}

function profileFor(id: string, fb?: FbDemo): LiveProfile {
  const normalized = normalizeDemoId(id) ?? "shell";
  const spec = LIVE_DEMO_SPECS[normalized];
  const desc = descriptorFor(normalized);
  const vfsSource = VFS_SOURCES[spec.image];
  return {
    id: normalized,
    image: spec.image,
    vfsUrl: vfsSource.kind === "url" ? vfsSource.url : "",
    vfsSource,
    descriptor: desc,
    shell: spec.shell ?? "default",
    maxVfsByteLength:
      spec.maxVfsByteLength ??
      (spec.image === "shell"
        ? MAIN_SHELL_VFS_PROFILE_MAX_BYTES
        : DEFAULT_VFS_PROFILE_MAX_BYTES),
    // WHY: memoryPages is a runtime cap, not just descriptor presentation.
    // Preserve Node's WebKit-safe 256 MiB process ceiling when it is launched
    // through the shared boot assembler.
    maxMemoryPages: spec.memoryPages,
    autoCommand: spec.autoCommand,
    init: spec.init && {
      argv: spec.init.argv.slice(),
      env: initEnv(spec.init.env),
      cwd: spec.init.cwd,
      // Canonical Pages products own their complete executable closure just
      // like an explicit VFS descriptor does. The legacy URL is available
      // only when the ordinary checked-out binary graph owns the image.
      programUrl: CANONICAL_PAGES_VFS_LOADER === undefined
        ? spec.init.programUrl
        : undefined,
      uid: spec.init.uid,
      gid: spec.init.gid,
      maxWorkers: spec.init.maxWorkers,
      maxMemoryPages: spec.init.maxMemoryPages,
      web: spec.init.web && {
        label: desc.title,
        requiredPorts: spec.init.web.requiredPorts.slice(),
        requiredServices: spec.init.web.requiredServices?.slice(),
        probeHttp: spec.init.web.probeHttp ?? true,
        probePath: spec.init.web.probePath,
      },
    },
    framebufferTest: fb === "test",
  };
}

function initEnv(profile: InitEnvProfile | undefined): string[] | undefined {
  if (!profile) return undefined;
  return INIT_ENV_PROFILES[profile]();
}

function shellEnvFor(profile: ShellProfile): string[] {
  return SHELL_PROFILES[profile].env;
}

function shellCwdFor(profile: ShellProfile): string {
  return SHELL_PROFILES[profile].cwd;
}

function shellIdentityForProfile(
  profile: LiveProfile,
  boot?: BootDescriptor["boot"],
): {
  env: string[];
  cwd: string;
  uid: number;
  gid: number;
} {
  let identity: { env: string[]; cwd: string; uid: number; gid: number };
  if (profile.shell === "node") {
    identity = {
      env: shellEnvFor(profile.shell),
      cwd: shellCwdFor(profile.shell),
      uid: DEMO_UID,
      gid: DEMO_GID,
    };
  } else {
    identity = {
      env: shellEnvFor(profile.shell),
      cwd: shellCwdFor(profile.shell),
      uid: DEMO_UID,
      gid: DEMO_GID,
    };
  }
  if (!boot) return identity;
  return {
    env: mergeEnvArrays(identity.env, envArray(boot.env)),
    cwd: boot.cwd || identity.cwd,
    uid: boot.uid ?? identity.uid,
    gid: boot.gid ?? identity.gid,
  };
}

function envArray(env: Record<string, string>): string[] {
  return Object.entries(env).map(([key, value]) => `${key}=${value}`);
}

function mergeEnvArrays(base: string[], override: string[]): string[] {
  const out = new Map<string, string>();
  for (const kv of base) {
    const idx = kv.indexOf("=");
    if (idx > 0) out.set(kv.slice(0, idx), kv.slice(idx + 1));
  }
  for (const kv of override) {
    const idx = kv.indexOf("=");
    if (idx > 0) out.set(kv.slice(0, idx), kv.slice(idx + 1));
  }
  return Array.from(out, ([key, value]) => `${key}=${value}`);
}

function presentationForProfile(
  profile: LiveProfile,
  presentation: DemoPresentation,
): DemoPresentation {
  // Older released VFS images put Terminal before Syslog for web demos,
  // which briefly focuses a shell while dinit is still bringing services up.
  const demoId = normalizeDemoId(profile.id);
  if (
    !demoId ||
    !WEB_BOOT_LOG_DEMO_IDS.has(demoId) ||
    !profile.init?.web ||
    presentation.bootPrimary !== "syslog" ||
    presentation.runningPrimary[0] !== "web"
  ) {
    return presentation;
  }

  return {
    ...presentation,
    runningPrimary: [
      "web",
      "syslog",
      ...presentation.runningPrimary.filter(
        (surface) => surface !== "web" && surface !== "syslog",
      ),
    ],
  };
}

function reportInitError(
  host: LiveKernelHost,
  profile: LiveProfile,
  message: string,
  tick: (msg: string) => void,
): void {
  tick(message);
  if (profile.init?.web) {
    host.setWebPreview({
      label: profile.init.web.label,
      url: APP_PREFIX,
      status: "error",
      message,
    });
  }
  host.setStatus("error");
}

async function bootProfile(
  host: LiveKernelHost,
  profile: LiveProfile,
  requestedDescriptor: BootDescriptor,
  bootStartedAt: number,
  isCurrent: () => boolean,
  requireServiceWorker: (
    tick?: (msg: string) => void,
  ) => Promise<ServiceWorker>,
  restoreCheckpoint?: MachineCheckpoint,
  replicationReplay?: ReplicationReplaySpec,
): Promise<BrowserKernel> {
  const assertCurrent = () => {
    if (!isCurrent()) throw new BootSuperseded();
  };

  assertCurrent();
  validateBootDescriptor(requestedDescriptor);
  host.clearDmesg();
  host.setWebPreview(null);
  host.setDemoGuide(null);
  const effectiveBoot = {
    ...profile.descriptor.boot,
    ...requestedDescriptor.boot,
    env: {
      ...profile.descriptor.boot.env,
      ...requestedDescriptor.boot.env,
    },
  };
  host.setDescriptor({
    ...profile.descriptor,
    title: requestedDescriptor.title || profile.descriptor.title,
    packages:
      requestedDescriptor.packages.length > 0
        ? requestedDescriptor.packages
        : profile.descriptor.packages,
    mounts: requestedDescriptor.mounts,
    boot: effectiveBoot,
  });
  const genericPresentation =
    profile.fallbackPresentation ?? genericPresentationForProfile(profile);
  host.setPresentation(genericPresentation);
  host.setStatus("booting");

  const tick = (msg: string) => {
    if (!isCurrent()) return;
    host.pushDmesg({
      t: bootElapsedMs(bootStartedAt),
      level: "info",
      facility: "kandelo",
      msg,
    });
  };
  const webReadiness: WebReadinessState = {
    ready: false,
    probing: false,
    failed: false,
  };
  let maybeUpdateWebReadiness = () => {};
  const requiredServices = new Set(
    profile.init?.web?.requiredServices ?? [],
  );
  const dinitBootTracker = new DinitBootStatusTracker(tick, (completion) => {
    if (
      completion.outcome === "failed" &&
      requiredServices.has(completion.serviceName)
    ) {
      if (webReadiness.failed) return;
      webReadiness.failed = true;
      reportInitError(
        host,
        profile,
        `Required service ${completion.serviceName} failed to start`,
        tick,
      );
      return;
    }
    maybeUpdateWebReadiness();
  });
  const recordProcessOutput = (data: Uint8Array, fallback: string) => {
    const text = new TextDecoder().decode(data);
    dinitBootTracker.observeProcessOutput(text, fallback);
    tick(text.trimEnd() || fallback);
  };

  await requireServiceWorker(tick);
  assertCurrent();

  tick("service worker active and cross-origin isolated");
  tick(`loading ${profile.id} profile...`);
  const [kernelBytes, loadedVfs] = await Promise.all([
    fetch(kernelWasmUrl)
      .then(failOn("kernel.wasm"))
      .then((r) => r.arrayBuffer()),
    loadVfsImage(profile),
  ]);
  assertCurrent();

  tick(
    `kernel: ${kib(kernelBytes.byteLength)} · vfs: ${kib(loadedVfs.imageBytes.byteLength)}`,
  );
  const fetchedVfsImageBytes = new Uint8Array(loadedVfs.imageBytes);
  const vfsMetadata = MemoryFileSystem.readImageMetadata(fetchedVfsImageBytes);
  assertVfsImageFitsProfile(
    MemoryFileSystem.readImageCapacity(fetchedVfsImageBytes),
    profile.maxVfsByteLength,
    declaredVfsMaxByteLength(vfsMetadata),
    `${profile.id}.vfs.zst`,
  );
  MemoryFileSystem.assertImageKernelAbi(
    fetchedVfsImageBytes,
    ABI_VERSION,
    `${profile.id}.vfs.zst`,
  );
  // Assemble the demo image in a TRANSIENT build-time filesystem. Its
  // SharedArrayBuffer never becomes the machine's live VFS — after
  // `saveImage()` it is dropped, and the kernel worker rebuilds+owns the live
  // FS from the serialized bytes (kernelOwnedFs). This keeps the main thread
  // out of the live-VFS ownership set so WebKit reclaims it on teardown via
  // Worker.terminate() rather than lazy GC — the root fix for the Safari
  // image-switch OOM.
  const buildFs = MemoryFileSystem.fromImage(fetchedVfsImageBytes, {
    maxByteLength: profile.maxVfsByteLength,
  });
  // Track as soon as the caller owns the staged filesystem. This covers every
  // later fetch, staging, supersession, and serialization failure; finalizing
  // the image is intentionally an idempotent second registration.
  trackTransientImageBuffer(buildFs.sharedBuffer);
  // WHY: register cleanup before rejecting a composition superseded while its
  // asynchronous layer loads were in flight. Otherwise its completed buffer
  // becomes unreachable without entering the WebKit reclamation ledger.
  assertCurrent();
  // WHY: establish cleanup ownership first, then reject forged imported seals
  // before URL rewriting or asset registration can trust their lazy metadata.
  await verifyImportedSealsForCurrentBoot(buildFs);
  // WHY: this check must live in the same continuation as the effects below.
  // Moving it into an async helper creates a microtask gap where a newer boot
  // can take ownership before this boot resumes mutating its staged image.
  assertCurrent();
  const terminalSession = readImageExperimentalTerminalSession(buildFs);
  if (profile.candidateEvidence === undefined) {
    if (
      profile.id === "nginx-php" ||
      profile.id === "wordpress-sqlite" ||
      profile.id === "wordpress-mariadb"
    ) {
      writeVfsFile(buildFs, "/etc/php-fpm.conf", PATCHED_PHP_FPM_CONF);
      ensureDirRecursive(buildFs, "/var/cache/opcache");
    }
    if (profile.id === "wordpress-sqlite") {
      patchWordPressRuntimeConfig(buildFs, "sqlite");
    } else if (profile.id === "wordpress-mariadb") {
      patchMariaDbUnixSocketConfig(buildFs);
      patchWordPressRuntimeConfig(buildFs, "mariadb");
    }
    if (profile.init?.programUrl) {
      tick(`staging ${profile.init.argv[0]}...`);
      const bytes = await fetch(profile.init.programUrl)
        .then(failOn(profile.init.argv[0]))
        .then((r) => r.arrayBuffer());
      assertCurrent();
      ensureDirRecursive(buildFs, dirname(profile.init.argv[0]));
      writeVfsBinary(buildFs, profile.init.argv[0], new Uint8Array(bytes), 0o755);
    }
    ensureDemoHomes(buildFs);
  }
  assertImageTerminalProgram(buildFs, terminalSession.initial);
  if (terminalSession.afterExit !== undefined) {
    assertImageTerminalProgram(buildFs, terminalSession.afterExit);
  }
  const imageConfig = readImageConfig(buildFs);
  const rawPresentation =
    (imageConfig ? resolveDemoPresentation(imageConfig, profile.id) : null) ??
    builtinDemoPresentation(profile.id) ??
    genericPresentation;
  const presentation = presentationForProfile(profile, rawPresentation);
  host.setPresentation(presentation);
  const demoGuide =
    (imageConfig ? resolveDemoGuide(imageConfig, profile.id) : null) ??
    builtinDemoGuide(profile.id);
  host.setDemoGuide(demoGuide);
  // Ingest is an image-owned capability. Absence is valid and must not be
  // replaced with a package- or profile-name-specific UI promise.
  host.setDemoIngest(
    imageConfig ? resolveDemoIngest(imageConfig, profile.id) : null,
  );
  const imageAssets = imageConfig
    ? resolveDemoAssets(imageConfig, profile.id)
    : [];
  const assets =
    imageAssets.length > 0 ? imageAssets : builtinDemoAssets(profile.id);
  if (profile.candidateEvidence === undefined) {
    await stageConfiguredAssets(buildFs, assets, tick, assertCurrent);
    assertCurrent();
  }

  // Serialize the assembled image to transferable bytes, then let `buildFs`
  // go out of scope. `saveImage()` emits raw (uncompressed) bytes that
  // `MemoryFileSystem.fromImage` restores directly in the worker.
  // WHY: this is the final synchronous image mutation. Binding before any
  // later staging could leave newly-added lazy metadata outside the manifest
  // authority copied from the authenticated product activation.
  bindImageOwnedRuntimeUrls(buildFs, loadedVfs.lazyAssets);
  tick("assembling kernel-owned VFS image...");
  // Serialize to transferable bytes + register the transient build buffer for
  // reclamation tracking, then let `buildFs` fall out of scope when bootProfile
  // returns. `settleAfterKernelDestroy` reclaims it on WebKit.
  const vfsImageBytes = await finalizeKernelOwnedImage(buildFs);
  assertCurrent();

  tick("instantiating kernel...");
  const seenPorts = new Set<number>();
  let bridgeSent = false;
  maybeUpdateWebReadiness = () => {
    maybeMarkWebReady(
      host,
      profile,
      seenPorts,
      bridgeSent,
      webReadiness,
      dinitBootTracker,
      tick,
      isCurrent,
    );
  };
  let kernel: BrowserKernel | null = null;
  try {
    kernel = new BrowserKernel({
      kernelOwnedFs: true,
      ...(profile.candidateEvidence === undefined
        ? {}
        : {
          maxProcessMemoryBytes:
            PROTECTED_BROWSER_EVIDENCE_MAX_PROCESS_MEMORY_BYTES,
        }),
      // WHY: the service worker, guest sockets, and lazy VFS are separate
      // transports. The live shell must explicitly give its kernel the same
      // deployment proxy or release-hosted lazy bottles bypass it under COEP.
      corsProxy: BROWSER_CORS_PROXY,
      maxWorkers: profile.init?.maxWorkers ?? 4,
      maxMemoryPages:
        profile.init?.maxMemoryPages ?? profile.maxMemoryPages,
      onStdout: (data) => recordProcessOutput(data, "stdout"),
      onStderr: (data) => recordProcessOutput(data, "stderr"),
      onHostDiagnostic: (diagnostic) => {
        if (!isCurrent()) return;
        host.pushDmesg({
          t: bootElapsedMs(bootStartedAt),
          level: "warn",
          facility: "kernel",
          msg: diagnostic.message,
        });
      },
      onProcessEvent: (event) => {
        if (isCurrent()) host.emitProcessEvent(event);
      },
      onHttpBridgePendingRequests: (count) => {
        if (isCurrent()) host.setWebPreviewPendingRequests(count);
      },
      onListenTcp: (pid, _fd, port) => {
        if (!isCurrent()) return;
        seenPorts.add(port);
        void reportTcpListener(kernel!, pid, port, tick, isCurrent).finally(
          () => {
            maybeUpdateWebReadiness();
          },
        );
      },
    });
    const kernelInitOptions = profile.candidateEvidence === undefined
      ? {
        kernelWasm: kernelBytes,
        vfsImage: vfsImageBytes,
      }
      : candidateEvidenceKernelInitOptions(
        profile.candidateEvidence,
        kernelBytes,
        vfsImageBytes,
      );
    await kernel.initFromImage({
      ...kernelInitOptions,
      // A checkpoint reaching this boot came from another computer and is
      // restored exactly once, so hand its buffers to the worker: cloning a
      // large machine's checkpoint is an allocation the browser can refuse.
      ...(restoreCheckpoint === undefined
        ? {}
        : { restoreCheckpoint, takeRestoreCheckpointOwnership: true }),
      ...(replicationReplay === undefined ? {} : { replicationReplay }),
    });
    assertCurrent();
    host.attachKernel(kernel);
    host.setTerminalSessionPolicy(
      experimentalTerminalSessionPolicy(terminalSession),
    );

    if (profile.init?.web) {
      tick("initializing HTTP bridge...");
      host.setWebPreview({
        label: profile.init.web.label,
        url: APP_PREFIX,
        status: "starting",
        message: "Waiting for services",
      });
      try {
        // Unique id for this machine instance. Scopes the service worker's
        // cookie jar so sessions never share cookies. Temporary instances get a
        // fresh random id per boot; when machines become persistable this is
        // where their durable id would be passed instead.
        const sessionId = crypto.randomUUID();
        await setupServiceWorkerFetchBridge(
          SW_URL,
          SW_SCOPE,
          APP_PREFIX,
          kernel,
          HTTP_PORT,
          sessionId,
          {
            timeoutMs: 90_000,
            debugLog: (line) => tick(line),
            onPendingRequests: (count) => {
              if (isCurrent()) host.setWebPreviewPendingRequests(count);
            },
          },
        );
        assertCurrent();
        bridgeSent = true;
        maybeUpdateWebReadiness();
      } catch (err) {
        if (!isCurrent()) throw err;
        const message = err instanceof Error ? err.message : String(err);
        tick(`HTTP bridge failed: ${message}`);
        host.setWebPreview({
          label: profile.init.web.label,
          url: APP_PREFIX,
          status: "error",
          message: "HTTP bridge unavailable",
        });
      }
    }

    // A restored machine arrives with its processes already running, so this
    // boot starts none of the programs the profile would normally start.
    // Spawning init or the demo's command again would put a second copy of
    // each beside the restored one, and the two would fight over the same
    // console, the same ports, and the same /dev/fb0.
    if (profile.init && restoreCheckpoint === undefined) {
      const initArgv =
        effectiveBoot.argv.length > 0 ? effectiveBoot.argv : profile.init.argv;
      tick(`spawning ${initArgv[0]}...`);
      // The init binary lives in the kernel-owned VFS; spawn it by path rather
      // than shipping bytes the kernel already has.
      const { exit: initExit } = await kernel.spawnFromVfs(
        initArgv[0],
        initArgv,
        {
          env: mergeEnvArrays(
            profile.init.env ?? [],
            envArray(effectiveBoot.env),
          ),
          cwd: effectiveBoot.cwd || profile.init.cwd || ROOT_HOME,
          uid: effectiveBoot.uid ?? profile.init.uid ?? ROOT_UID,
          gid: effectiveBoot.gid ?? profile.init.gid ?? ROOT_GID,
          stdin: new Uint8Array(),
        },
      );
      // WHY: spawning crosses the worker boundary. A newer boot may own the
      // host by the time the acknowledgement returns, so do not attach exit
      // handlers to this superseded activation.
      assertCurrent();
      void initExit.then(
        (code) => {
          if (!isCurrent()) return;
          reportInitError(
            host,
            profile,
            `${initArgv[0] ?? "init"} exited with code ${code}`,
            tick,
          );
        },
        (err) => {
          if (!isCurrent()) return;
          reportInitError(
            host,
            profile,
            `init failed: ${err instanceof Error ? err.message : String(err)}`,
            tick,
          );
        },
      );
    }

    maybeUpdateWebReadiness();

    if (restoreCheckpoint !== undefined) {
      tick(
        replicationReplay === undefined
          ? `restored ${restoreCheckpoint.processes.length} process(es) handed `
            + `over by the other computer`
          : `replicating ${restoreCheckpoint.processes.length} process(es) from `
            + `the other computer's decisions`,
      );
    } else if (profile.framebufferTest) {
      const fbtestWasmUrl = await optionalBinaryUrl(
        [
          "../../../../../local-binaries/programs/wasm32/fbtest.wasm",
          "../../../../../binaries/programs/wasm32/fbtest.wasm",
        ],
        "fbtest.wasm",
      );
      assertCurrent();
      void spawnLazy(
        kernel,
        "/usr/local/bin/fbtest",
        fbtestWasmUrl,
        ["fbtest"],
        tick,
        assertCurrent,
      );
    } else if (presentation?.autoCommand) {
      tick("starting configured command from the default shell...");
      void host.runShellCommand(presentation.autoCommand).catch((err) => {
        tick(
          `configured command failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    } else if (profile.autoCommand) {
      tick(`running ${profile.autoCommand}...`);
      void host.runShellCommand(profile.autoCommand).catch((err) => {
        tick(
          `command failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    }

    if (!webReadiness.failed) {
      tick("ready");
      host.setStatus("running");
    }
    return kernel;
  } catch (err) {
    if (kernel) {
      await kernel.destroy().catch(() => {});
    }
    throw err;
  }
}

function genericPresentationForProfile(profile: LiveProfile): DemoPresentation {
  if (profile.init?.web) return genericDemoPresentation("web");
  if (profile.descriptor.runtime.features.includes("kms")) {
    return genericDemoPresentation("kms");
  }
  if (
    profile.framebufferTest ||
    profile.descriptor.runtime.features.includes("framebuffer")
  ) {
    return genericDemoPresentation("framebuffer");
  }
  return genericDemoPresentation("terminal");
}

function stageShellUtilities(
  fs: MemoryFileSystem,
  dashBytes: ArrayBuffer,
  bashBytes: ArrayBuffer,
): void {
  ensureDemoHomes(fs);
  ensureDirRecursive(fs, "/bin");
  ensureDirRecursive(fs, "/usr/bin");
  writeVfsBinary(fs, "/bin/dash", new Uint8Array(dashBytes), 0o755);
  try {
    fs.symlink("/bin/dash", "/bin/sh");
  } catch {
    /* exists */
  }
  try {
    fs.symlink("/bin/dash", "/usr/bin/dash");
  } catch {
    /* exists */
  }
  try {
    fs.symlink("/bin/dash", "/usr/bin/sh");
  } catch {
    /* exists */
  }
  writeVfsBinary(fs, "/bin/bash", new Uint8Array(bashBytes), 0o755);
  try {
    fs.symlink("/bin/bash", "/usr/bin/bash");
  } catch {
    /* exists */
  }
}

function ensureDemoHomes(fs: MemoryFileSystem): void {
  ensureDirRecursive(fs, "/home");
  ensureOwnedDir(fs, DEMO_HOME, 0o755, DEMO_UID, DEMO_GID);
  ensureOwnedDir(fs, ROOT_HOME, 0o700, ROOT_UID, ROOT_GID);
}

function ensureOwnedDir(
  fs: MemoryFileSystem,
  path: string,
  mode: number,
  uid: number,
  gid: number,
): void {
  ensureDirRecursive(fs, path);
  fs.chown(path, uid, gid);
  fs.chmod(path, mode);
}

function patchWordPressRuntimeConfig(
  fs: MemoryFileSystem,
  kind: WordPressDatabaseKind,
): void {
  writeVfsFile(fs, "/etc/wp-config-init.sh", WORDPRESS_CONFIG_INIT_SCRIPT);
  writeVfsFile(
    fs,
    "/etc/wp-config-template.php",
    wordpressConfigTemplate(kind),
  );
  writeVfsFile(
    fs,
    "/var/www/html/wp-config.php",
    renderWordPressConfig(kind, APP_PATH, PROTO),
  );
  if (kind === "sqlite") {
    ensureOwnedDir(
      fs,
      "/var/www/html/wp-content/database",
      0o775,
      PHP_FPM_UID,
      PHP_FPM_GID,
    );
  } else if (kind === "mariadb") {
    for (const dir of ["/data", "/data/mysql", "/data/tmp", "/data/test"]) {
      ensureOwnedDir(fs, dir, 0o775, MYSQL_UID, MYSQL_GID);
    }
    patchWordPressPersistentMysqli(fs);
    writeVfsFile(
      fs,
      "/var/www/html/kandelo-mysql-bench.php",
      MYSQL_BENCHMARK_PHP,
    );
  }
  ensureDirRecursive(fs, "/var/www/html/wp-content/mu-plugins");
  writeVfsFile(
    fs,
    "/var/www/html/wp-content/mu-plugins/kandelo-url.php",
    WORDPRESS_URL_MU_PLUGIN,
  );
}

function patchMariaDbUnixSocketConfig(fs: MemoryFileSystem): void {
  ensureDirRecursive(fs, "/tmp");
  fs.chmod("/tmp", 0o1777);
  ensureDirRecursive(fs, dirname(WORDPRESS_MARIADB_READY_FILE));
  writeVfsFile(fs, WORDPRESS_MARIADB_READY_FILE, WORDPRESS_MARIADB_READY_PHP);

  const phpIniPath = "/etc/php.ini";
  const phpIni = readOptionalVfsText(fs, phpIniPath);
  if (phpIni !== null) {
    let patched = phpIni;
    if (!/^mysqli\.default_socket\s*=/m.test(patched)) {
      patched += `${patched.endsWith("\n") ? "" : "\n"}mysqli.default_socket=${MARIADB_SOCKET_PATH}\n`;
    }
    if (!/^mysqli\.allow_persistent\s*=/m.test(patched)) {
      patched += `mysqli.allow_persistent=1\n`;
    }
    if (!/^mysqli\.max_persistent\s*=/m.test(patched)) {
      patched += `mysqli.max_persistent=-1\n`;
    }
    if (!/^pdo_mysql\.default_socket\s*=/m.test(patched)) {
      patched += `pdo_mysql.default_socket=${MARIADB_SOCKET_PATH}\n`;
    }
    if (patched !== phpIni) writeVfsFile(fs, phpIniPath, patched);
  }

  const mariadbServicePath = "/etc/dinit.d/mariadb";
  const mariadbService = readOptionalVfsText(fs, mariadbServicePath);
  if (mariadbService !== null) {
    const patched = mariadbService
      .replace(/--socket=(?:\S*)?/g, `--socket=${MARIADB_SOCKET_PATH}`)
      .replace(/\s*--thread-handling=no-threads\b/g, "");
    if (patched !== mariadbService)
      writeVfsFile(fs, mariadbServicePath, patched);
  }

  ensureMariaDbReadyService(fs);
  patchPhpFpmMariaDbDependency(fs);
}

function ensureMariaDbReadyService(fs: MemoryFileSystem): void {
  ensureDirRecursive(fs, dirname(MARIADB_READY_SCRIPT_PATH));
  writeVfsFile(
    fs,
    MARIADB_READY_SCRIPT_PATH,
    `#!/bin/sh
set -u

i=0
while [ "$i" -lt 60 ]; do
    if [ -S "${MARIADB_SOCKET_PATH}" ] || [ -e "${MARIADB_SOCKET_PATH}" ]; then
        exit 0
    fi
    sleep 1
    i=$((i + 1))
done

echo "MariaDB readiness timed out waiting for ${MARIADB_SOCKET_PATH}" >&2
exit 1
`,
    0o755,
  );
  writeVfsFile(
    fs,
    `/etc/dinit.d/${MARIADB_READY_SERVICE}`,
    `type = scripted
command = /bin/sh ${MARIADB_READY_SCRIPT_PATH}
depends-on = mariadb
restart = false
`,
  );
}

function patchPhpFpmMariaDbDependency(fs: MemoryFileSystem): void {
  const phpFpmServicePath = "/etc/dinit.d/php-fpm";
  const phpFpmService = readOptionalVfsText(fs, phpFpmServicePath);
  if (phpFpmService === null) return;
  if (
    new RegExp(`^depends-on\\s*=\\s*${MARIADB_READY_SERVICE}$`, "m").test(
      phpFpmService,
    )
  ) {
    return;
  }
  const patched = phpFpmService.replace(
    /^depends-on\s*=\s*mariadb\s*$/m,
    `depends-on = ${MARIADB_READY_SERVICE}`,
  );
  if (patched !== phpFpmService) {
    writeVfsFile(fs, phpFpmServicePath, patched);
  } else {
    writeVfsFile(
      fs,
      phpFpmServicePath,
      `${phpFpmService}${phpFpmService.endsWith("\n") ? "" : "\n"}depends-on = ${MARIADB_READY_SERVICE}\n`,
    );
  }
}

function patchWordPressPersistentMysqli(fs: MemoryFileSystem): void {
  for (const path of [
    "/var/www/html/wp-includes/class-wpdb.php",
    "/var/www/html/wp-includes/wp-db.php",
  ]) {
    const source = readOptionalVfsText(fs, path);
    if (source === null) continue;
    const patched = patchWordPressMysqliPersistentSource(source);
    if (patched !== source) writeVfsFile(fs, path, patched);
  }
}

interface LoadedVfsImage {
  imageBytes: ArrayBuffer;
  lazyAssets?: ImageOwnedRuntimeLazyAssets;
}

/**
 * Images fetched before anything asked to boot them, keyed by their URL.
 *
 * Only the plain-URL images need this. A canonical Pages product is already
 * cached by its loader, which is the cache a boot reads too, so prewarming one
 * is a call and not a copy. An image named by a bare URL has no such cache,
 * and `loadVfsImage` would fetch it again.
 *
 * One entry at a time: a viewer prewarms the one image its peer is running,
 * and holding others would spend a machine's worth of memory on machines
 * nobody is offering.
 */
const prewarmedVfsImages = new Map<string, Promise<ArrayBuffer>>();

/**
 * Fetch what booting `profile` would need, so that booting it does not have to.
 *
 * Warms exactly the paths `loadVfsImage` and the boot read from, so a prewarm
 * that succeeded is time the boot no longer spends. Rejects if the image
 * cannot be loaded; a speculative caller is expected to ignore that, because
 * nothing has been asked for yet.
 */
async function prewarmProfileImage(profile: LiveProfile): Promise<void> {
  // The kernel is the same Wasm whatever machine arrives, and a computer that
  // has only ever watched one has never fetched it. Warmed through the HTTP
  // cache rather than held here: the boot fetches the same URL, and a second
  // copy of the kernel in memory buys nothing the cache does not.
  const kernel = fetch(kernelWasmUrl)
    .then(failOn("kernel.wasm"))
    .then((r) => r.arrayBuffer())
    .then(() => undefined);

  if (profile.vfsSource !== undefined && CANONICAL_PAGES_VFS_LOADER !== undefined) {
    await Promise.all([
      kernel,
      CANONICAL_PAGES_VFS_LOADER.activate(profile.vfsSource.productId),
    ]);
    return;
  }

  const vfsUrl = await resolveProfileVfsUrl(profile);
  if (!prewarmedVfsImages.has(vfsUrl)) {
    prewarmedVfsImages.clear();
    prewarmedVfsImages.set(
      vfsUrl,
      fetch(vfsUrl)
        .then(failOn(`${profile.id}.vfs.zst`))
        .then((r) => r.arrayBuffer()),
    );
  }
  // A failed prewarm must not be remembered as one that worked, or the boot
  // would wait on a rejected promise instead of fetching for itself.
  try {
    await Promise.all([kernel, prewarmedVfsImages.get(vfsUrl)]);
  } catch (error) {
    prewarmedVfsImages.delete(vfsUrl);
    throw error;
  }
}

async function loadVfsImage(profile: LiveProfile): Promise<LoadedVfsImage> {
  if (profile.candidateEvidence !== undefined) {
    if (profile.candidateVfsPlacement === undefined) {
      throw new Error("candidate evidence VFS lacks its Pages placement boundary");
    }
    return { imageBytes: await profile.candidateVfsPlacement.bytes() };
  }
  if (profile.vfsSource !== undefined && CANONICAL_PAGES_VFS_LOADER !== undefined) {
    const activation = await CANONICAL_PAGES_VFS_LOADER.activate(
      profile.vfsSource.productId,
    );
    return {
      imageBytes: activation.imageBytes.slice(0),
      lazyAssets:
        activation.lazyAssets === undefined
          ? undefined
          : Object.freeze({ ...activation.lazyAssets }),
    };
  }
  const vfsUrl = await resolveProfileVfsUrl(profile);
  const prewarmed = prewarmedVfsImages.get(vfsUrl);
  if (prewarmed !== undefined) {
    // Taken, not read: this image is being booted, so nothing is waiting for
    // it any more, and a viewer that keeps a copy of the machine it just
    // adopted holds that memory for nothing.
    prewarmedVfsImages.delete(vfsUrl);
    // Copied for the same reason the canonical loader copies: the caller
    // assembles the machine out of these bytes, and a buffer handed straight
    // from a cache would be one a second boot could no longer trust.
    return { imageBytes: (await prewarmed).slice(0) };
  }
  return {
    imageBytes: await fetch(vfsUrl)
      .then(failOn(`${profile.id}.vfs.zst`))
      .then((r) => r.arrayBuffer()),
  };
}

async function resolveProfileVfsUrl(profile: LiveProfile): Promise<string> {
  if (profile.vfsSource) return resolveLiveVfsSourceUrl(profile.vfsSource);
  if (profile.vfsUrl) return profile.vfsUrl;
  throw new Error(`No VFS image URL configured for ${profile.id}`);
}

function dirname(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx <= 0 ? "/" : path.slice(0, idx);
}

async function reportTcpListener(
  kernel: BrowserKernel,
  pid: number,
  port: number,
  tick: (msg: string) => void,
  isCurrent: () => boolean,
): Promise<void> {
  const processName = await processNameForPid(kernel, pid).catch(() => null);
  if (!isCurrent()) return;
  tick(`${processName ?? "service"} listening on :${port}`);
}

async function processNameForPid(
  kernel: BrowserKernel,
  pid: number,
): Promise<string | null> {
  if (pid <= 0) return null;
  const proc = (await kernel.enumProcs()).find((entry) => entry.pid === pid);
  if (!proc) return null;
  const comm = proc.comm.trim();
  if (comm && !comm.startsWith("[")) return comm;
  const arg0 = basename(proc.cmdline.trim().split(/\s+/)[0] ?? "").trim();
  return arg0 && !arg0.startsWith("[") ? arg0 : null;
}

function basename(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx < 0 ? path : path.slice(idx + 1);
}

async function spawnLazy(
  kernel: BrowserKernel,
  path: string,
  url: string,
  argv: string[],
  tick: (msg: string) => void,
  assertCurrent: () => void,
): Promise<void> {
  try {
    tick(`fetching ${argv[0]}...`);
    const bytes = await fetch(url)
      .then(failOn(argv[0]))
      .then((r) => r.arrayBuffer());
    assertCurrent();
    tick(`spawning ${argv[0]}...`);
    await kernel.spawn(bytes, argv, {
      env: SHELL_ENV,
      cwd: DEMO_HOME,
      uid: DEMO_UID,
      gid: DEMO_GID,
    });
    assertCurrent();
    tick(`${argv[0]} exited`);
  } catch (err) {
    tick(
      `${argv[0]} failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function maybeMarkWebReady(
  host: LiveKernelHost,
  profile: LiveProfile,
  seenPorts: Set<number>,
  bridgeSent: boolean,
  readiness: WebReadinessState,
  dinitBootTracker: DinitBootStatusTracker,
  tick: (msg: string) => void,
  isCurrent: () => boolean,
): void {
  const web = profile.init?.web;
  if (!web) return;
  if (readiness.failed) return;
  const portsReady = web.requiredPorts.every((p) => seenPorts.has(p));
  const servicesReady = (web.requiredServices ?? []).every((serviceName) =>
    dinitBootTracker.hasSucceeded(serviceName),
  );
  if (!portsReady || !servicesReady || !bridgeSent) return;
  const readyMessage = web.probeHttp
    ? "HTTP bridge ready"
    : "Service stack ready";
  if (readiness.ready) {
    if (!isCurrent()) return;
    host.setWebPreview({
      label: web.label,
      url: APP_PREFIX,
      status: "running",
      message: readyMessage,
    });
    return;
  }
  if (!web.probeHttp) {
    readiness.ready = true;
    tick("Web preview ready");
    host.setWebPreview({
      label: web.label,
      url: APP_PREFIX,
      status: "running",
      message: readyMessage,
    });
    return;
  }
  if (readiness.probing) return;
  readiness.probing = true;
  const probeUrl = previewUrlForPath(web.probePath ?? "/");
  host.setWebPreview({
    label: web.label,
    url: APP_PREFIX,
    status: "starting",
    message: web.probePath
      ? "Waiting for application readiness"
      : "Waiting for HTTP response",
  });
  void waitForHttpPreview(probeUrl, 90_000, {
    requireOk: Boolean(web.probePath),
  })
    .then(
      () => {
        if (!isCurrent() || readiness.failed) return;
        readiness.ready = true;
        tick("HTTP preview ready");
        host.setWebPreview({
          label: web.label,
          url: APP_PREFIX,
          status: "running",
          message: "HTTP bridge ready",
        });
      },
      (err) => {
        if (!isCurrent()) return;
        const message = err instanceof Error ? err.message : String(err);
        host.setWebPreview({
          label: web.label,
          url: APP_PREFIX,
          status: "error",
          message: "HTTP preview did not become ready",
        });
        tick(`HTTP preview readiness failed: ${message}`);
      },
    )
    .finally(() => {
      if (!isCurrent()) return;
      readiness.probing = false;
    });
}

async function waitForHttpPreview(
  url: string,
  timeoutMs = 90_000,
  options: { requireOk?: boolean } = {},
): Promise<void> {
  const started = performance.now();
  let delayMs = 250;
  let lastError = "";

  while (performance.now() - started < timeoutMs) {
    try {
      const response = await fetchWithTimeout(url, 5_000);
      if (options.requireOk ? response.ok : response.status < 500) return;
      lastError = `HTTP ${response.status}`;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    await sleep(delayMs);
    delayMs = Math.min(1_500, Math.floor(delayMs * 1.4));
  }

  throw new Error(lastError || "timed out");
}

function previewUrlForPath(path: string): string {
  const root = new URL(APP_PREFIX, window.location.href);
  const normalized = path.startsWith("/") ? path.slice(1) : path;
  return new URL(normalized || ".", root).href;
}

async function fetchWithTimeout(
  url: string,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      cache: "no-store",
      redirect: "follow",
      signal: controller.signal,
    });
  } finally {
    window.clearTimeout(timer);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function descriptorBootIdentity(
  id: string,
  shell: ShellProfile,
): { env: string[]; cwd: string; uid: number; gid: number } {
  const serviceIds = new Set([
    "nginx",
    "nginx-php",
    "wordpress-sqlite",
    "wordpress-mariadb",
  ]);
  if (serviceIds.has(id)) {
    return {
      env: SERVICE_ENV,
      cwd: ROOT_HOME,
      uid: ROOT_UID,
      gid: ROOT_GID,
    };
  }
  if (id === "node" || shell === "node") {
    return {
      env: shellEnvFor(shell),
      cwd: shellCwdFor(shell),
      uid: DEMO_UID,
      gid: DEMO_GID,
    };
  }
  return {
    env: shellEnvFor(shell),
    cwd: shellCwdFor(shell),
    uid: DEMO_UID,
    gid: DEMO_GID,
  };
}

function envRecord(env: string[]): Record<string, string> {
  return Object.fromEntries(
    env.map((kv) => {
      const idx = kv.indexOf("=");
      return [kv.slice(0, idx), kv.slice(idx + 1)];
    }),
  );
}

function descriptorFor(id: string): BootDescriptor {
  const normalized = normalizeDemoId(id) ?? "shell";
  const spec = LIVE_DEMO_SPECS[normalized];
  const item =
    liveGalleryItems().find((p) => p.id === normalized) ??
    liveGalleryItems()[0];
  const shell = spec.shell ?? "default";
  const network = spec.network ?? false;
  const bootIdentity = descriptorBootIdentity(normalized, shell);
  return {
    version: 1,
    id: item.id,
    title: item.title,
    base: item.base,
    runtime: {
      arch: "wasm32",
      kernel: "kernel@local",
      memoryPages: spec.memoryPages ?? 2048,
      features: [
        "shared-array-buffer",
        "pty",
        ...(spec.features ?? []),
        ...(network ? ["tcp-bridge"] : []),
      ],
      time: "real",
    },
    packages: item.packages,
    mounts: [
      {
        path: "/",
        source: "image",
        ref: `${item.id}.vfs@local`,
        readonly: false,
      },
      { path: "/tmp", source: "scratch", ephemeral: true },
    ],
    boot: {
      argv: item.bootCommand,
      cwd: bootIdentity.cwd,
      env: envRecord(bootIdentity.env),
      uid: bootIdentity.uid,
      gid: bootIdentity.gid,
    },
    caps: { network },
  };
}

function liveGalleryItems(): GalleryItem[] {
  return PRESET_LIBRARY.map((p) => ({
    id: p.id,
    title: p.title,
    summary: p.summary,
    base: p.base,
    packages: p.packages,
    bootCommand: p.bootCommand,
    vfsImageUrl: vfsImageUrlForPreset(p.id),
    resolveVfsImageUrl: vfsImageUrlResolverForPreset(p.id),
    accent: p.accent,
    glyph: p.glyph,
    estimatedUrlBytes: p.estimatedUrlBytes,
  }));
}

function vfsImageUrlForPreset(id: string): string | undefined {
  const liveId = normalizeDemoId(id);
  if (!liveId) return undefined;
  const source = VFS_SOURCES[LIVE_DEMO_SPECS[liveId].image];
  if (source.kind !== "url") return undefined;
  const url = new URL(source.url, location.href);
  url.hash = liveId;
  return url.href;
}

function vfsImageUrlResolverForPreset(
  id: string,
): (() => Promise<string>) | undefined {
  const liveId = normalizeDemoId(id);
  if (!liveId) return undefined;
  const source = VFS_SOURCES[LIVE_DEMO_SPECS[liveId].image];
  if (source.kind !== "optional-demo") return undefined;
  return async () => {
    const url = new URL(
      await resolveLiveVfsSourceUrl(source),
      location.href,
    );
    url.hash = liveId;
    return url.href;
  };
}

async function liveDemoIdForVfsImageUrl(
  vfsUrl: string,
  demo: string | null | undefined,
): Promise<LiveDemoId | null> {
  const image = await matchTrustedVfsSourceId(
    vfsUrl,
    (Object.keys(VFS_SOURCES) as LiveVfsImage[]).map((id) => ({
      id,
      resolveVfsImageUrl: () => resolveTrustedLiveVfsSourceUrl(VFS_SOURCES[id]),
    })),
  );
  if (!image) return null;

  const fragmentDemo = normalizeDemoId(
    new URL(vfsUrl, location.href).hash.slice(1),
  );
  const requestedDemo = normalizeDemoId(demo) ?? fragmentDemo;
  if (!requestedDemo) return DEFAULT_DEMO_FOR_VFS_IMAGE[image];

  // WHY: a demo selects launch behavior, while the matched image owns the VFS
  // bytes and capacity. Never apply a launch profile to a different image.
  return LIVE_DEMO_SPECS[requestedDemo].image === image ? requestedDemo : null;
}

async function resolveLiveVfsSourceUrl(source: LiveVfsSource): Promise<string> {
  if (source.kind === "url") {
    if (CANONICAL_PAGES_VFS_LOADER === undefined) return source.url;
    return (await CANONICAL_PAGES_VFS_LOADER.activate(source.productId)).imageUrl;
  }
  if (source.kind === "optional-demo") {
    return resolveOptionalDemoVfsUrl(
      source.image,
      undefined,
      undefined,
      CANONICAL_PAGES_VFS_LOADER === undefined
        ? undefined
        : async () => (await CANONICAL_PAGES_VFS_LOADER.activate(source.productId)).imageUrl,
    );
  }
  if (CANONICAL_PAGES_VFS_LOADER !== undefined) {
    return (await CANONICAL_PAGES_VFS_LOADER.activate(source.productId)).imageUrl;
  }
  return optionalBinaryUrl(source.relPaths, source.label);
}

async function resolveTrustedLiveVfsSourceUrl(source: LiveVfsSource): Promise<string> {
  if (CANONICAL_PAGES_VFS_LOADER !== undefined) {
    return (await CANONICAL_PAGES_VFS_LOADER.activate(source.productId)).imageUrl;
  }
  return resolveLiveVfsSourceUrl(source);
}

function normalizeDemoId(id: string | null | undefined): LiveDemoId | null {
  if (!id) return null;
  const normalized = DEMO_ALIASES[id] ?? id;
  return isLiveDemoId(normalized) ? normalized : null;
}

function isLiveDemoId(id: string): id is LiveDemoId {
  return Object.hasOwn(LIVE_DEMO_SPECS, id);
}

function readImageExperimentalTerminalSession(
  fs: MemoryFileSystem,
): ExperimentalTerminalSession {
  let stat;
  try {
    stat = fs.lstat(EXPERIMENTAL_TERMINAL_SESSION_PATH);
  } catch (err) {
    if (isMissingVfsPath(err)) {
      throw new Error(
        `VFS image is missing ${EXPERIMENTAL_TERMINAL_SESSION_PATH}`,
      );
    }
    throw err;
  }
  if ((stat.mode & 0xf000) !== 0x8000) {
    throw new Error(
      `${EXPERIMENTAL_TERMINAL_SESSION_PATH} must be a regular file`,
    );
  }
  if (stat.size > MAX_EXPERIMENTAL_TERMINAL_SESSION_BYTES) {
    throw new Error(
      `${EXPERIMENTAL_TERMINAL_SESSION_PATH} exceeds ` +
        `${MAX_EXPERIMENTAL_TERMINAL_SESSION_BYTES} bytes`,
    );
  }
  const json = new TextDecoder("utf-8", { fatal: true }).decode(
    new Uint8Array(readVfsFile(fs, EXPERIMENTAL_TERMINAL_SESSION_PATH)),
  );
  return parseExperimentalTerminalSession(json);
}

function assertImageTerminalProgram(
  fs: MemoryFileSystem,
  program: ExperimentalTerminalProgram,
): void {
  const path = program.path;
  let stat;
  try {
    stat = fs.stat(path);
  } catch {
    throw new Error(`VFS image terminal program is missing: ${path}`);
  }
  if ((stat.mode & 0xf000) !== 0x8000) {
    throw new Error(`VFS image terminal program is not a regular file: ${path}`);
  }
  if ((stat.mode & 0o111) === 0) {
    throw new Error(`VFS image terminal program is not executable: ${path}`);
  }
}

function readImageConfig(fs: MemoryFileSystem): KandeloDemoConfig | null {
  return readKandeloDemoConfigFromVfs(fs);
}

function readOptionalVfsText(
  fs: MemoryFileSystem,
  path: string,
): string | null {
  const bytes = readOptionalVfsFile(fs, path);
  return bytes === null
    ? null
    : new TextDecoder().decode(new Uint8Array(bytes));
}

function readOptionalVfsFile(
  fs: MemoryFileSystem,
  path: string,
): ArrayBuffer | null {
  try {
    return readVfsFile(fs, path);
  } catch (err) {
    if (isMissingVfsPath(err)) return null;
    throw err;
  }
}

function isMissingVfsPath(err: unknown): boolean {
  if (typeof err === "object" && err !== null) {
    const code = (err as { code?: unknown }).code;
    if (code === -2 || code === "ENOENT") return true;
  }
  const message = err instanceof Error ? err.message : String(err);
  if (/\bENOENT\b/.test(message)) return true;
  return message.includes("No such file or directory");
}

function readVfsFile(fs: MemoryFileSystem, path: string): ArrayBuffer {
  const st = fs.stat(path);
  const fd = fs.open(path, 0, 0);
  try {
    const out = new Uint8Array(st.size);
    let off = 0;
    while (off < out.byteLength) {
      const n = fs.read(fd, out.subarray(off), null, out.byteLength - off);
      if (n <= 0) break;
      off += n;
    }
    return out.buffer.slice(out.byteOffset, out.byteOffset + off);
  } finally {
    fs.close(fd);
  }
}

function failOn(label: string): (r: Response) => Response {
  return (r) => {
    if (!r.ok)
      throw new Error(`fetch failed for ${label}: ${r.status} ${r.statusText}`);
    return r;
  };
}

function kib(bytes: number): string {
  return `${(bytes / 1024).toFixed(0)} KiB`;
}
