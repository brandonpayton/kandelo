import {
  lstatSync,
  realpathSync,
} from "node:fs";
import {
  isAbsolute,
  join,
  relative,
  sep,
} from "node:path";
import { posix as guestPath } from "node:path";

import type { NodeSessionSeedTree } from "../host/src/vfs/default-mounts-node";
import {
  DEFAULT_MOUNT_SPEC,
  type MountSpec,
} from "../host/src/vfs/default-mounts";

// The isolated conformance fixture is seeded under `/run`, which the in-kernel
// tmpfs (Phase 5) deliberately does NOT claim — unlike `/tmp` and the other
// scratch prefixes it owns. Seeding under an owned prefix would be shadowed by
// tmpfs once it serves scratch (a spawned child's cwd resolves via `sys_chdir`
// and would ENOENT). `/run` stays host-backed on both sides of the cutover, so
// the fixture is visible whether or not tmpfs owns the scratch mounts.
const ISOLATED_FIXTURE_DESTINATION = "/run/kandelo-run";

/** Host-backed mount that carries the isolated fixture, outside tmpfs's reach. */
const ISOLATED_FIXTURE_MOUNT: MountSpec = {
  path: "/run",
  source: "scratch",
  mode: 0o755,
  nosuid: true,
};
const ISOLATED_PATH_ENV = new Set([
  "GIT_SSL_CAINFO",
  "HOME",
  "NODE_EXTRA_CA_CERTS",
  "NIX_SSL_CERT_FILE",
  "OLDPWD",
  "PWD",
  "SSL_CERT_DIR",
  "SSL_CERT_FILE",
  "TEMP",
  "TMP",
  "TMPDIR",
]);

type RunnerEnvironment = Readonly<Record<string, string | undefined>>;

export interface RunExampleFilesystem {
  isolated: boolean;
  guestCwd: string;
  guestProgram?: string;
  rootfsImage?: "default";
  /** Overrides `DEFAULT_MOUNT_SPEC` when the boot needs an extra fixture mount. */
  rootfsMountSpec?: readonly MountSpec[];
  sessionSeedTrees?: readonly NodeSessionSeedTree[];
}

function nonEmptyControl(
  env: RunnerEnvironment,
  name: string,
): string | undefined {
  const value = env[name];
  return value === undefined || value === "" ? undefined : value;
}

function containsPath(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (
    rel !== ".."
    && !rel.startsWith(`..${sep}`)
    && !isAbsolute(rel)
  );
}

function relativeFixturePath(value: string, name: string): string[] {
  if (value.includes("\0") || guestPath.isAbsolute(value)) {
    throw new Error(`${name} must be a relative guest path`);
  }
  const segments = value.split("/");
  if (
    segments.length === 0
    || segments.some(
      (segment) => segment === "" || segment === "." || segment === "..",
    )
  ) {
    throw new Error(
      `${name} must contain only non-empty relative path segments`,
    );
  }
  return segments;
}

function fixtureEntry(
  sourceRoot: string,
  value: string,
  name: string,
  kind: "directory" | "file",
): { guest: string; host: string } {
  const segments = relativeFixturePath(value, name);
  const candidate = join(sourceRoot, ...segments);
  const stat = lstatSync(candidate);
  if (
    (kind === "directory" && !stat.isDirectory())
    || (kind === "file" && !stat.isFile())
    || stat.isSymbolicLink()
  ) {
    throw new Error(`${name} must name a ${kind} inside the fixture root`);
  }
  const physical = realpathSync(candidate);
  if (!containsPath(sourceRoot, physical)) {
    throw new Error(`${name} escapes the fixture root`);
  }
  return {
    guest: guestPath.join(ISOLATED_FIXTURE_DESTINATION, ...segments),
    host: physical,
  };
}

/**
 * Resolve the CLI runner's filesystem authority before a worker is started.
 *
 * Raw mode preserves the legacy host-filesystem runner. Isolated mode uses the
 * canonical rootfs plus lifecycle-owned scratch. Optional fixtures are copied
 * into that scratch by the worker, so fixture-backed cwd and program paths are
 * guest paths. A byte-launched program may retain its legacy host path as
 * argv[0], but only an immutable exact-path self-exec alias can resolve it.
 */
export function resolveRunExampleFilesystem(
  env: RunnerEnvironment,
  hostCwd: string,
): RunExampleFilesystem {
  const requestedMode = nonEmptyControl(env, "KANDELO_RUNNER_VFS");
  if (requestedMode !== undefined && requestedMode !== "raw" && requestedMode !== "isolated") {
    throw new Error('KANDELO_RUNNER_VFS must be "raw" or "isolated"');
  }

  const isolated = requestedMode === "isolated";
  const fixtureRootInput = nonEmptyControl(
    env,
    "KANDELO_RUNNER_FIXTURE_ROOT",
  );
  const fixtureCwdInput = nonEmptyControl(
    env,
    "KANDELO_RUNNER_FIXTURE_CWD",
  );
  const guestProgramInput = nonEmptyControl(
    env,
    "KANDELO_RUNNER_GUEST_PROGRAM",
  );

  if (!isolated) {
    if (
      fixtureRootInput !== undefined
      || fixtureCwdInput !== undefined
      || guestProgramInput !== undefined
    ) {
      throw new Error("runner fixture controls require isolated VFS mode");
    }
    return {
      guestCwd: nonEmptyControl(env, "KERNEL_CWD") ?? hostCwd,
      isolated: false,
    };
  }

  if (nonEmptyControl(env, "KERNEL_CWD") !== undefined) {
    throw new Error(
      "KERNEL_CWD is a raw-host control; isolated mode requires runner fixture paths",
    );
  }
  if (fixtureRootInput === undefined) {
    if (fixtureCwdInput !== undefined) {
      throw new Error(
        "KANDELO_RUNNER_FIXTURE_CWD requires KANDELO_RUNNER_FIXTURE_ROOT",
      );
    }
    if (guestProgramInput !== undefined) {
      throw new Error(
        "KANDELO_RUNNER_GUEST_PROGRAM requires KANDELO_RUNNER_FIXTURE_ROOT",
      );
    }
    return {
      guestCwd: "/tmp",
      isolated: true,
      rootfsImage: "default",
    };
  }
  if (fixtureCwdInput === undefined) {
    throw new Error(
      "KANDELO_RUNNER_FIXTURE_ROOT requires KANDELO_RUNNER_FIXTURE_CWD",
    );
  }

  const sourceRoot = realpathSync(fixtureRootInput);
  const sourceStat = lstatSync(sourceRoot);
  if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) {
    throw new Error("KANDELO_RUNNER_FIXTURE_ROOT must name a directory");
  }
  const cwd = fixtureEntry(
    sourceRoot,
    fixtureCwdInput,
    "KANDELO_RUNNER_FIXTURE_CWD",
    "directory",
  );
  const guestProgram = guestProgramInput === undefined
    ? undefined
    : fixtureEntry(
      sourceRoot,
      guestProgramInput,
      "KANDELO_RUNNER_GUEST_PROGRAM",
      "file",
    ).guest;

  return {
    guestCwd: cwd.guest,
    ...(guestProgram === undefined ? {} : { guestProgram }),
    isolated: true,
    rootfsImage: "default",
    rootfsMountSpec: [...DEFAULT_MOUNT_SPEC, ISOLATED_FIXTURE_MOUNT],
    sessionSeedTrees: [{
      destinationPath: ISOLATED_FIXTURE_DESTINATION,
      sourcePath: sourceRoot,
    }],
  };
}

/**
 * Copy host environment values as guest strings without retaining host-only
 * runner controls. Isolated boots replace host path variables with paths that
 * actually exist in the canonical VFS.
 */
export function buildRunExampleGuestEnvironment(
  env: RunnerEnvironment,
  guestCwd: string,
  isolated: boolean,
  kernelPath: string,
  guestHome = "/root",
): string[] {
  const inherited = Object.entries(env)
    .filter(([name, value]) =>
      value !== undefined
      && name !== "PATH"
      && name !== "KANDELO_GUEST_OUTPUT_FILE"
      && !name.startsWith("KANDELO_RUNNER_")
      && (!isolated || !name.startsWith("KERNEL_"))
      && (!isolated || !ISOLATED_PATH_ENV.has(name))
    )
    .map(([name, value]) => `${name}=${value}`);

  return [
    ...inherited,
    `PATH=${kernelPath}`,
    ...(isolated
      ? [
        `PWD=${guestCwd}`,
        "TMPDIR=/tmp",
        `HOME=${guestHome}`,
      ]
      : []),
  ];
}
