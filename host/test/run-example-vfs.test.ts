import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  buildRunExampleGuestEnvironment,
  resolveRunExampleFilesystem,
} from "../../examples/run-example-vfs";
import { DEFAULT_MOUNT_SPEC } from "../src/vfs/default-mounts";


describe("run-example isolated filesystem", () => {
  it("preserves the legacy raw-host mode unless isolation is explicit", () => {
    expect(resolveRunExampleFilesystem({}, "/host/cwd")).toEqual({
      guestCwd: "/host/cwd",
      isolated: false,
    });
    expect(resolveRunExampleFilesystem({
      KANDELO_RUNNER_VFS: "raw",
      KERNEL_CWD: "/explicit/raw/cwd",
    }, "/host/cwd")).toEqual({
      guestCwd: "/explicit/raw/cwd",
      isolated: false,
    });
  });

  it("uses the canonical rootfs and lifecycle-owned /tmp without a fixture cwd", () => {
    expect(resolveRunExampleFilesystem({
      KANDELO_RUNNER_VFS: "isolated",
    }, "/host/cwd")).toEqual({
      guestCwd: "/tmp",
      isolated: true,
      rootfsImage: "default",
    });
  });

  it("snapshots an explicit fixture root and resolves the initial program inside it", () => {
    const sourceRoot = mkdtempSync(join(tmpdir(), "kandelo-runner-fixture-"));
    const sourceCwd = join(sourceRoot, "basic");
    const sourceProgram = join(sourceCwd, "stdio", "fopen");
    mkdirSync(join(sourceCwd, "stdio"), { recursive: true });
    writeFileSync(sourceProgram, "wasm fixture");
    try {
      expect(resolveRunExampleFilesystem({
        KANDELO_RUNNER_VFS: "isolated",
        KANDELO_RUNNER_FIXTURE_ROOT: sourceRoot,
        KANDELO_RUNNER_FIXTURE_CWD: "basic",
        KANDELO_RUNNER_GUEST_PROGRAM: "basic/stdio/fopen",
      }, "/ignored")).toEqual({
        guestCwd: "/run/kandelo-run/basic",
        guestProgram: "/run/kandelo-run/basic/stdio/fopen",
        isolated: true,
        rootfsImage: "default",
        // The isolated fixture is seeded under `/run` (a host-backed mount the
        // in-kernel tmpfs never claims), so it stays visible across the cutover.
        rootfsMountSpec: [
          ...DEFAULT_MOUNT_SPEC,
          { path: "/run", source: "scratch", mode: 0o755, nosuid: true },
        ],
        sessionSeedTrees: [{
          destinationPath: "/run/kandelo-run",
          sourcePath: realpathSync(sourceRoot),
        }],
      });
    } finally {
      rmSync(sourceRoot, { recursive: true, force: true });
    }
  });

  it("rejects ambiguous modes and guest programs outside the owned snapshot", () => {
    expect(() =>
      resolveRunExampleFilesystem({
        KANDELO_RUNNER_VFS: "sometimes",
      }, "/host/cwd")
    ).toThrow(/KANDELO_RUNNER_VFS/);

    expect(() =>
      resolveRunExampleFilesystem({
        KANDELO_RUNNER_VFS: "isolated",
        KANDELO_RUNNER_GUEST_PROGRAM: "program",
      }, "/host/cwd")
    ).toThrow(/requires KANDELO_RUNNER_FIXTURE_ROOT/);

    expect(() =>
      resolveRunExampleFilesystem({
        KANDELO_RUNNER_VFS: "isolated",
        KERNEL_CWD: "/",
      }, "/host/cwd")
    ).toThrow(/KERNEL_CWD.*raw/i);
  });

  it("does not leak runner controls or host-only path variables into a guest", () => {
    const entries = buildRunExampleGuestEnvironment(
      {
        KEEP: "yes",
        PATH: "/host/bin",
        PWD: "/host/cwd",
        OLDPWD: "/host/old",
        TMPDIR: "/host/tmp",
        TMP: "/host/tmp-short",
        TEMP: "/host/temp",
        HOME: "/host/home",
        KERNEL_CWD: "/host/fixtures",
        KERNEL_PATH: "/host/programs",
        KERNEL_UID: "1000",
        KERNEL_GID: "1000",
        KANDELO_GUEST_OUTPUT_FILE: "/host/output",
        KANDELO_RUNNER_VFS: "isolated",
        KANDELO_RUNNER_FIXTURE_ROOT: "/host/fixture-root",
        KANDELO_RUNNER_FIXTURE_CWD: "suite",
        KANDELO_RUNNER_GUEST_PROGRAM: "suite/test",
      },
      "/guest/cwd",
      true,
      "/usr/bin:/bin",
    );

    expect(entries).toContain("KEEP=yes");
    expect(entries).toContain("PATH=/usr/bin:/bin");
    expect(entries).toContain("PWD=/guest/cwd");
    expect(entries).toContain("TMPDIR=/tmp");
    expect(entries).toContain("HOME=/root");
    expect(entries.some((entry) => entry.startsWith("OLDPWD="))).toBe(false);
    expect(entries.some((entry) => entry.startsWith("KERNEL_CWD="))).toBe(false);
    expect(entries.some((entry) => entry.startsWith("KERNEL_"))).toBe(false);
    expect(entries.some((entry) => entry.startsWith("KANDELO_"))).toBe(false);
  });

  it("keeps legacy KERNEL_* guest entries only in raw-host mode", () => {
    const raw = buildRunExampleGuestEnvironment(
      {
        KERNEL_APPLICATION_VALUE: "visible",
        KANDELO_RUNNER_VFS: "raw",
      },
      "/host/cwd",
      false,
      "/guest/bin",
    );
    expect(raw).toContain("KERNEL_APPLICATION_VALUE=visible");
    expect(raw).not.toContain("KANDELO_RUNNER_VFS=raw");

    const isolated = buildRunExampleGuestEnvironment(
      { KERNEL_APPLICATION_VALUE: "hidden" },
      "/tmp",
      true,
      "/guest/bin",
    );
    expect(isolated).not.toContain("KERNEL_APPLICATION_VALUE=hidden");
  });
});
