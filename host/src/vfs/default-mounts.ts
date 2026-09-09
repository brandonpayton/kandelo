/**
 * Declarative mount layout shared by Node and Browser hosts.
 *
 * The same `MountSpec[]` produces a `Promise<MountConfig[]>` via
 * per-environment resolvers — Node materialises scratch backends as host
 * directories under a session dir; the browser uses ephemeral memfs SABs.
 *
 * `readonly` is currently advisory: `VirtualPlatformIO` does not enforce it
 * on writes. The resolver still propagates the flag for backends and routers
 * that choose to enforce it.
 */

import type { MountConfig } from "./types";
import { FILE_MODES, OPEN_FLAGS } from "../generated/abi";
import { MemoryFileSystem } from "./memory-fs";
import { restoreVerifiedVfsImage } from "./load-image";

/**
 * Scratch prefixes the in-kernel tmpfs (Phase 5) claims. MUST stay in exact
 * sync with the `SCRATCH_MOUNTS` table in `crates/runtime-core/src/tmpfs.rs`; a
 * mount whose path is one of these is served entirely by the kernel, so the
 * host must not also materialise a backend for it (that would be a second
 * authority the kernel never consults). A scratch mount at any other path (e.g.
 * `/run`) stays host-backed.
 */
export const KERNEL_TMPFS_OWNED_PREFIXES: readonly string[] = [
  "/tmp",
  "/var/tmp",
  "/var/log",
  "/var/run",
  "/home/maker",
  "/root",
  "/srv",
];

/** True when the in-kernel tmpfs owns `mountPath` exactly (a scratch prefix). */
export function kernelTmpfsOwnsMountPath(mountPath: string): boolean {
  return KERNEL_TMPFS_OWNED_PREFIXES.includes(mountPath);
}

const O_WRONLY_CREAT_TRUNC =
  OPEN_FLAGS.O_WRONLY | OPEN_FLAGS.O_CREAT | OPEN_FLAGS.O_TRUNC;

export interface MountSpec {
  /** Absolute VFS mount point (e.g., "/etc"). No trailing slash except "/". */
  path: string;
  /**
   * `image`   — asynchronously restore and authenticate the supplied image.
   * `scratch` — empty writable backend (host dir on Node, memfs in browser).
   */
  source: "image" | "scratch";
  /** Advisory mount intent; the ordinary image-backed root remains writable. */
  readonly?: boolean;
  /** Ignore set-ID mode bits. Omission preserves normal set-ID semantics. */
  nosuid?: boolean;
  /** Directory mode for scratch mount roots. Mirrors MANIFEST for defaults. */
  mode?: number;
  /** Virtual owner for scratch mount roots. Defaults to root. */
  uid?: number;
  /** Virtual group for scratch mount roots. Defaults to root. */
  gid?: number;
  /** Documentation hint that the mount is wiped on kernel destroy. */
  ephemeral?: boolean;
}

/**
 * Canonical mount layout. Mirrors the top-level system directories declared
 * in `MANIFEST`: `/` is the writable rootfs image; `/tmp`, `/var/*`,
 * `/home/maker`, `/root`, and `/srv` are scratch mounts.
 */
export const DEFAULT_MOUNT_SPEC: MountSpec[] = [
  { path: "/", source: "image", readonly: false },
  {
    path: "/tmp",
    source: "scratch",
    mode: 0o1777,
    ephemeral: true,
    nosuid: true,
  },
  { path: "/var/tmp", source: "scratch", mode: 0o1777, nosuid: true },
  { path: "/var/log", source: "scratch", mode: 0o755, nosuid: true },
  {
    path: "/var/run",
    source: "scratch",
    mode: 0o755,
    ephemeral: true,
    nosuid: true,
  },
  {
    path: "/home/maker",
    source: "scratch",
    mode: 0o755,
    uid: 1000,
    gid: 1000,
    nosuid: true,
  },
  {
    path: "/root",
    source: "scratch",
    mode: 0o700,
    uid: 0,
    gid: 0,
    nosuid: true,
  },
  { path: "/srv", source: "scratch", mode: 0o755, nosuid: true },
];

/** Default growth ceiling for the rootfs image-backed memfs (1 GiB). */
export const IMAGE_MEMFS_MAX_BYTES = 1 * 1024 * 1024 * 1024;

/**
 * Default size for a browser scratch memfs SAB (16 MiB).
 *
 * 16 MiB is a generous baseline that accommodates real workloads we
 * already ship: SQLite WAL/journal under `/tmp`, MariaDB InnoDB log
 * spillover under `/var/log` and `/var/run`, nginx access/error logs,
 * and PHP session files under `/var/tmp`. The SAB is not pre-allocated
 * — `MemoryFileSystem` only writes used pages — so the wall-clock cost
 * of bumping from the prior 1 MiB is essentially free, while the prior
 * 1 MiB ceiling was already known to ENOSPC on the WordPress install
 * path (Task 4.3 implementer flagged this for cutover).
 *
 * Per-mount overrides can be supplied via `BrowserResolverOptions`
 * once a demo needs more than the default — none do today.
 */
export const BROWSER_SCRATCH_SAB_BYTES = 16 * 1024 * 1024;

function readTextFile(fs: MemoryFileSystem, path: string): string | null {
  let fd: number | null = null;
  try {
    const st = fs.stat(path);
    fd = fs.open(path, 0, 0);
    const bytes = new Uint8Array(st.size);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const n = fs.read(fd, bytes.subarray(offset), null, bytes.byteLength - offset);
      if (n <= 0) break;
      offset += n;
    }
    return new TextDecoder().decode(bytes.subarray(0, offset));
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try { fs.close(fd); } catch {}
    }
  }
}

function writeTextFile(fs: MemoryFileSystem, path: string, text: string): void {
  const bytes = new TextEncoder().encode(text);
  const fd = fs.open(path, O_WRONLY_CREAT_TRUNC, 0o644);
  try {
    if (bytes.byteLength > 0) fs.write(fd, bytes, null, bytes.byteLength);
  } finally {
    fs.close(fd);
  }
}

export function normalizeLegacyRootfs(fs: MemoryFileSystem): void {
  // Compatibility for already-published dinit demo images that contain a
  // nobody user but not the matching nobody group. php-fpm validates
  // `group = nobody` during pool startup and exits EX_CONFIG (78) without it.
  const group = readTextFile(fs, "/etc/group");
  if (group !== null && !/^nobody:/m.test(group)) {
    writeTextFile(fs, "/etc/group", `${group.replace(/\n?$/, "\n")}nobody:x:65534:\n`);
  }
}

function normalizeMountPoint(path: string): string {
  return path === "/" ? path : path.replace(/\/+$/, "");
}

function isDirectoryMode(mode: number): boolean {
  return (mode & FILE_MODES.S_IFMT) === FILE_MODES.S_IFDIR;
}

/**
 * Ensure mount points below image-missing directories are reachable.
 *
 * The kernel checks search permissions on every parent component before
 * opening or statting a final path. Runtime mounts such as
 * `/usr/local/lib/kandelo` therefore need `/usr/local` and
 * `/usr/local/lib` to exist in the root image even though the mounted
 * backend owns the final mount point itself.
 */
export function ensureMountParentDirectories(
  rootfs: MemoryFileSystem,
  mountPoints: readonly string[],
): void {
  for (const mountPoint of mountPoints) {
    const normalized = normalizeMountPoint(mountPoint);
    if (normalized === "/" || !normalized.startsWith("/")) continue;

    const segments = normalized.split("/").filter(Boolean);
    let current = "";
    for (let i = 0; i < segments.length - 1; i++) {
      const segment = segments[i];
      if (segment === "." || segment === "..") break;

      current += `/${segment}`;
      try {
        const st = rootfs.stat(current);
        if (!isDirectoryMode(st.mode)) break;
      } catch {
        rootfs.mkdir(current, 0o755);
      }
    }
  }
}

/**
 * Drop the scratch mounts the in-kernel tmpfs owns, so the host materialises no
 * backend for a prefix the kernel serves — the cutover's "host stops owning
 * scratch" half. The in-kernel tmpfs is the unconditional authority for its
 * scratch prefixes (Phase 5 cutover), so this filtering is always applied.
 * Image mounts, and host-owned scratch mounts outside tmpfs's prefixes (e.g.
 * `/run`), are preserved.
 */
export function filterMountSpecForKernelTmpfs(
  spec: readonly MountSpec[],
): MountSpec[] {
  return spec.filter(
    (m) => !(m.source === "scratch" && kernelTmpfsOwnsMountPath(m.path)),
  );
}

export function validateSpec(spec: MountSpec[]): void {
  const seen = new Set<string>();
  for (const m of spec) {
    if (typeof m.path !== "string" || m.path.length === 0) {
      throw new Error(`MountSpec: empty path`);
    }
    if (!m.path.startsWith("/")) {
      throw new Error(`MountSpec: path must be absolute: ${m.path}`);
    }
    if (m.path !== "/" && m.path.endsWith("/")) {
      throw new Error(`MountSpec: trailing slash on non-root path: ${m.path}`);
    }
    const segments = m.path.split("/");
    for (const seg of segments) {
      if (seg === "." || seg === "..") {
        throw new Error(`MountSpec: path contains "${seg}" segment: ${m.path}`);
      }
    }
    if (seen.has(m.path)) {
      throw new Error(`MountSpec: duplicate mount path: ${m.path}`);
    }
    seen.add(m.path);
  }
}

/**
 * Restore and authenticate every image-backed mount before any caller is
 * allowed to normalize an image or construct scratch mounts around it.
 *
 * @internal Shared by the Node and browser resolvers so both hosts enforce the
 * same imported-seal trust boundary.
 */
export async function restoreVerifiedImageMounts(
  spec: MountSpec[],
  rootfsImage: Uint8Array,
): Promise<ReadonlyMap<MountSpec, MemoryFileSystem>> {
  const restored = new Map(
    await Promise.all(
      spec
        .filter((mount) => mount.source === "image")
        .map(async (mount) => [
          mount,
          await restoreVerifiedVfsImage(rootfsImage, {
            maxByteLength: IMAGE_MEMFS_MAX_BYTES,
          }),
        ] as const),
    ),
  );

  // WHY: restore/verify the complete image set before normalization or scratch
  // setup.
  // A later forged mount must not leave an earlier mount or host directory
  // partially mutated when the resolver rejects the boot.
  for (const fs of restored.values()) normalizeLegacyRootfs(fs);
  return restored;
}

/**
 * Per-mount scratch SAB sizing. Defaults to {@link BROWSER_SCRATCH_SAB_BYTES}
 * for any mount not in the map.
 */
export interface BrowserResolverOptions {
  /** Mount path → initial SAB size in bytes. Overrides the default. */
  scratchSabBytes?: Record<string, number>;
}

/**
 * Materialise `spec` for the browser host. Image mounts get a fresh,
 * cryptographically verified `MemoryFileSystem`; scratch mounts get an empty
 * `MemoryFileSystem` over a small SAB (the browser has no host directory to
 * bind to).
 *
 * Asynchronous input → output function with no global state.
 */
export function resolveForBrowser(
  spec: MountSpec[],
  rootfsImage: Uint8Array,
  options: BrowserResolverOptions = {},
): Promise<MountConfig[]> {
  validateSpec(spec);
  return resolveValidatedForBrowser(spec, rootfsImage, options);
}

async function resolveValidatedForBrowser(
  spec: MountSpec[],
  rootfsImage: Uint8Array,
  options: BrowserResolverOptions,
): Promise<MountConfig[]> {
  const effective = filterMountSpecForKernelTmpfs(spec);
  const imageMounts = await restoreVerifiedImageMounts(effective, rootfsImage);
  const out: MountConfig[] = [];
  for (const m of effective) {
    if (m.source === "image") {
      const backend = imageMounts.get(m);
      if (backend === undefined) {
        throw new Error(`verified image mount is missing: ${m.path}`);
      }
      out.push({
        mountPoint: m.path,
        backend,
        readonly: m.readonly,
        nosuid: m.nosuid,
      });
    } else {
      const bytes = options.scratchSabBytes?.[m.path] ?? BROWSER_SCRATCH_SAB_BYTES;
      const sab = new SharedArrayBuffer(bytes);
      const backend = MemoryFileSystem.create(sab);
      if (m.mode !== undefined) backend.chmod("/", m.mode);
      if (m.uid !== undefined || m.gid !== undefined) {
        backend.chown("/", m.uid ?? 0, m.gid ?? 0);
      }
      out.push({
        mountPoint: m.path,
        backend,
        readonly: m.readonly,
        nosuid: m.nosuid,
      });
    }
  }
  return out;
}
