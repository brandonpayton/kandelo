/**
 * Node-only resolver for {@link MountSpec}: lives in its own module so
 * the universal `default-mounts.ts` doesn't drag `node:fs` /
 * `node:path` / `HostFileSystem` into browser bundles.
 */

import {
  constants,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  renameSync,
  rmSync,
} from "node:fs";
import {
  dirname,
  isAbsolute,
  join,
  posix as guestPath,
  relative,
  sep,
} from "node:path";
import type { MountConfig } from "./types";
import { MemoryFileSystem } from "./memory-fs";
import {
  createSessionOwnedHostFileSystem,
  HostFileSystem,
} from "./host-fs";
import {
  filterMountSpecForKernelTmpfs,
  restoreVerifiedImageMounts,
  validateSpec,
  type MountSpec,
} from "./default-mounts";

/**
 * Materialise `spec` for the Node host. Image mounts get a fresh,
 * cryptographically verified `MemoryFileSystem`; scratch mounts get a
 * `HostFileSystem` rooted at `<sessionDir><spec.path>` (the directory is
 * created with `mkdirSync({recursive:true})` so `safePath` is happy on first
 * access).
 *
 * The public resolver treats `sessionDir` as caller-owned. Exact native append
 * authority is reserved for the internal resolver whose caller already owns a
 * runtime-created random root.
 */
export function resolveForNode(
  spec: MountSpec[],
  rootfsImage: Uint8Array,
  sessionDir: string,
): Promise<MountConfig[]> {
  validateSpec(spec);
  return resolveValidatedForNode(spec, rootfsImage, sessionDir, false);
}

async function resolveValidatedForNode(
  spec: MountSpec[],
  rootfsImage: Uint8Array,
  sessionDir: string,
  sessionOwned: boolean,
  sessionSeedTrees: readonly NodeSessionSeedTree[] = [],
  shadowingMountPoints: readonly string[] = [],
): Promise<MountConfig[]> {
  const effective = filterMountSpecForKernelTmpfs(spec);
  const imageMounts = await restoreVerifiedImageMounts(effective, rootfsImage);
  for (const m of effective) {
    if (m.source !== "scratch") continue;
    const hostDir = join(sessionDir, m.path);
    mkdirSync(hostDir, { recursive: true, mode: m.mode });
  }
  if (sessionOwned) {
    materializeSessionSeedTrees(
      effective,
      sessionDir,
      sessionSeedTrees,
      shadowingMountPoints,
    );
  } else if (sessionSeedTrees.length > 0) {
    throw new Error("session seed trees require a worker-owned session");
  }

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
      const hostDir = join(sessionDir, m.path);
      const backend = sessionOwned
        ? createSessionOwnedHostFileSystem(hostDir)
        : new HostFileSystem(hostDir);
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

/**
 * Materialise mounts beneath the Node worker's private per-boot session root.
 *
 * @internal The caller must have created a fresh, unshared directory and must
 * retain its cleanup lease for the complete kernel lifetime. This distinct
 * entry point prevents a caller-selected path from acquiring exact native
 * append authority.
 */
export function resolveForNodeKernelSession(
  spec: MountSpec[],
  rootfsImage: Uint8Array,
  sessionDir: string,
  sessionSeedTrees: readonly NodeSessionSeedTree[] = [],
  shadowingMountPoints: readonly string[] = [],
): Promise<MountConfig[]> {
  validateSpec(spec);
  return resolveValidatedForNode(
    spec,
    rootfsImage,
    sessionDir,
    true,
    sessionSeedTrees,
    shadowingMountPoints,
  );
}

export interface NodeSessionSeedTree {
  /** Absolute host path to a quiescent directory. */
  sourcePath: string;
  /** Absolute guest destination strictly beneath a declared scratch mount. */
  destinationPath: string;
}

function containsPath(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (
    rel !== ".."
    && !rel.startsWith(`..${sep}`)
    && !isAbsolute(rel)
  );
}

function guestPathContains(parent: string, child: string): boolean {
  return child === parent || (
    parent === "/"
      ? child.startsWith("/")
      : child.startsWith(`${parent}/`)
  );
}

function guestPathStrictlyContains(parent: string, child: string): boolean {
  return child !== parent && guestPathContains(parent, child);
}

function requireCanonicalGuestPath(path: string, kind: string): void {
  if (path.includes("\0")) {
    throw new Error(`${kind} contains NUL`);
  }
  if (guestPath.normalize(path) !== path) {
    throw new Error(`${kind} must be a canonical POSIX path: ${path}`);
  }
}

function supportedSeedEntry(path: string): boolean {
  const stat = lstatSync(path);
  if (stat.isDirectory() || stat.isFile()) return true;
  throw new Error(
    `session seed source contains a symlink or unsupported special entry: ${path}`,
  );
}

/**
 * Materialize quiescent caller fixtures inside already-declared scratch roots.
 * Every tree is copied to an opaque private staging path first. Only after all
 * copies succeed are they renamed into place, and only after that does the
 * caller construct the session-owned HostFileSystem backends.
 */
function materializeSessionSeedTrees(
  spec: readonly MountSpec[],
  sessionDir: string,
  seeds: readonly NodeSessionSeedTree[],
  shadowingMountPoints: readonly string[],
): void {
  if (seeds.length === 0) return;
  const sessionRoot = realpathSync(sessionDir);
  const routingMounts = [...spec]
    .sort((left, right) => right.path.length - left.path.length);

  validateSpec(seeds.map((seed) => ({
    path: seed.destinationPath,
    source: "scratch" as const,
  })));
  validateSpec(shadowingMountPoints.map((path) => ({
    path,
    source: "scratch" as const,
  })));
  for (const seed of seeds) {
    requireCanonicalGuestPath(
      seed.destinationPath,
      "session seed destination",
    );
  }
  for (const mountPoint of shadowingMountPoints) {
    requireCanonicalGuestPath(mountPoint, "shadowing mount point");
  }
  const prepared = seeds.map((seed, index) => {
    const owner = routingMounts.find(
      (mount) => guestPathContains(mount.path, seed.destinationPath),
    );
    if (
      owner === undefined
      || owner.source !== "scratch"
      || !guestPathStrictlyContains(owner.path, seed.destinationPath)
    ) {
      throw new Error(
        `session seed destination must be below a scratch mount and routed through a scratch mount: ${seed.destinationPath}`,
      );
    }
    // WHY: the VFS routes by longest mount prefix. Even when the destination
    // itself belongs to `owner`, a nested declared mount would hide part of
    // the copied tree and make publication differ from the owned bytes.
    for (const mount of spec) {
      if (
        mount !== owner
        && guestPathContains(seed.destinationPath, mount.path)
      ) {
        throw new Error(
          `session seed destination overlaps another declared mount: ${seed.destinationPath} and ${mount.path}`,
        );
      }
    }
    for (const mountPoint of shadowingMountPoints) {
      if (
        guestPathContains(mountPoint, seed.destinationPath)
        || guestPathContains(seed.destinationPath, mountPoint)
      ) {
        throw new Error(
          `session seed destination overlaps another mount: ${seed.destinationPath} and ${mountPoint}`,
        );
      }
    }
    for (const other of seeds) {
      if (
        other !== seed
        && (
          guestPathContains(seed.destinationPath, other.destinationPath)
          || guestPathContains(other.destinationPath, seed.destinationPath)
        )
      ) {
        throw new Error(
          `session seed destinations overlap: ${seed.destinationPath} and ${other.destinationPath}`,
        );
      }
    }
    if (typeof seed.sourcePath !== "string" || seed.sourcePath.length === 0) {
      throw new Error("session seed source path must not be empty");
    }
    if (!isAbsolute(seed.sourcePath)) {
      throw new Error(
        `session seed source path must be absolute: ${seed.sourcePath}`,
      );
    }
    const sourceStat = lstatSync(seed.sourcePath);
    if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) {
      throw new Error(
        `session seed source must name a directory: ${seed.sourcePath}`,
      );
    }
    const sourceRoot = realpathSync(seed.sourcePath);
    if (
      containsPath(sourceRoot, sessionRoot)
      || containsPath(sessionRoot, sourceRoot)
    ) {
      throw new Error(
        `session seed source overlaps or contains the private session: ${sourceRoot}`,
      );
    }
    const destination = join(sessionRoot, seed.destinationPath);
    if (!containsPath(sessionRoot, destination)) {
      throw new Error(
        `session seed destination escapes the private session: ${seed.destinationPath}`,
      );
    }
    if (existsSync(destination)) {
      throw new Error(
        `session seed destination already exists: ${seed.destinationPath}`,
      );
    }
    return {
      destination,
      sourceRoot,
      staging: join(sessionRoot, `.seed-staging-${index}`),
    };
  });

  for (const { sourceRoot, staging } of prepared) {
    mkdirSync(staging, { mode: 0o700 });
    cpSync(sourceRoot, join(staging, "tree"), {
      recursive: true,
      force: false,
      errorOnExist: true,
      preserveTimestamps: true,
      // COPYFILE_FICLONE falls back to an ordinary copy when the filesystem
      // has no clone primitive; unlike a hardlink, either result owns writes.
      mode: constants.COPYFILE_FICLONE,
      filter: (source) => supportedSeedEntry(source),
    });
  }
  for (const { destination, staging } of prepared) {
    mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
    renameSync(join(staging, "tree"), destination);
    rmSync(staging, { recursive: true, force: true });
  }
}
