/**
 * Regression: a setuid/setgid exec target served by the in-kernel rootfs
 * overlay (the unconditional sole `/` authority) must produce correct
 * secure-exec state (AT_SECURE, environment sanitization, euid/egid change)
 * (Phase 5 cutover gap G5).
 *
 * Root cause this pins: `open_prepared_exec_target_rootfs` (and the
 * AT_EMPTY_PATH twin `retain_empty_path_target`) unconditionally forced
 * `ST_NOSUID` onto the overlay exec target's statfs view, so
 * `propose_set_id_transition` never proposed an euid/egid change for an
 * overlay-resident set-ID binary. The kernel therefore left `secure_exec`
 * false, libc did not set AT_SECURE, and a setuid `/usr/bin/login` staged in
 * the overlay ran non-secure (the probe observed `secure=0` and untrusted env
 * still visible, exiting 10). The host `/` mount honored the same bits, so the
 * gap only appeared once the overlay owned `/`.
 *
 * This boots the real Node kernel worker (the path that wires the overlay) and
 * stages the probe as an overlay-resident setuid-root `/usr/bin/login` launched
 * from an ordinary (uid 1000) process. The overlay owns `/`, so the set-ID
 * bits it serves must drive the correct secure-exec state.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { NodeKernelHost } from "../src/node-kernel-host";
import { tryResolveBinary } from "../src/binary-resolver";
import { MemoryFileSystem } from "../src/vfs/memory-fs";
import type { MountSpec } from "../src/vfs/default-mounts";

function asArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "../..");
const probePath = join(
  repoRoot,
  "local-binaries/programs/wasm32/secure-exec-probe.wasm",
);

const kernelPath = tryResolveBinary("kernel.wasm");
const havePrereqs = existsSync(probePath) && kernelPath !== null;

async function stageImage(): Promise<Uint8Array> {
  const probe = new Uint8Array(readFileSync(probePath));
  const fs = MemoryFileSystem.create(
    new SharedArrayBuffer(Math.max(8 * 1024 * 1024, probe.byteLength * 4)),
  );
  fs.mkdir("/bin", 0o755);
  fs.mkdir("/usr", 0o755);
  fs.mkdir("/usr/bin", 0o755);
  // Ordinary launcher (owner root, no set-ID) and a setuid-root target.
  fs.createFileWithOwner("/bin/launcher", 0o755, 0, 0, probe);
  fs.createFileWithOwner("/usr/bin/login", 0o4755, 0, 0, probe);
  return fs.saveImage();
}

async function run(
  image: Uint8Array,
  argv: string[],
  nosuid = false,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  const rootfsMountSpec: MountSpec[] | undefined = nosuid
    ? [{ path: "/", source: "image", readonly: false, nosuid: true }]
    : undefined;
  const host = new NodeKernelHost({
    rootfsImage: image,
    ...(rootfsMountSpec ? { rootfsMountSpec } : {}),
    onStdout: (_pid, bytes) => {
      stdout += new TextDecoder().decode(bytes);
    },
    onStderr: (_pid, bytes) => {
      stderr += new TextDecoder().decode(bytes);
    },
  });
  try {
    await host.init(
      asArrayBuffer(new Uint8Array(readFileSync(kernelPath!))),
    );
    const { exit } = await host.spawnFromVfs("/bin/launcher", argv, {
      uid: 1000,
      gid: 1000,
      env: ["KANDELO_UNTRUSTED=visible-only-outside-secure-startup"],
    });
    const exitCode = await exit;
    return { exitCode, stdout, stderr };
  } finally {
    await host.destroy().catch(() => {});
  }
}

describe.runIf(havePrereqs)(
  "secure-exec for an overlay-served set-ID target",
  () => {
    it(
      "enters secure startup for a setuid-root overlay exec target",
      async () => {
        const image = await stageImage();
        const { exitCode, stdout, stderr } = await run(image, [
          "secure-exec-probe",
          "launch",
          "/usr/bin/login",
          "startup-target",
          "1",
          "0",
        ]);
        expect(exitCode, `stdout:\n${stdout}\nstderr:\n${stderr}`).toBe(0);
        expect(stdout).toBe(
          "secure=1 ctor_secure=1 untrusted_visible=0 ctor_visible=0\n",
        );
      },
      60_000,
    );

    it(
      "keeps an ordinary (non-set-ID) overlay exec target non-secure",
      async () => {
        const image = await stageImage();
        const { exitCode, stdout, stderr } = await run(image, [
          "secure-exec-probe",
          "launch",
          "/bin/launcher",
          "startup-target",
          "0",
          "0",
        ]);
        expect(exitCode, `stdout:\n${stdout}\nstderr:\n${stderr}`).toBe(0);
        expect(stdout).toBe(
          "secure=0 ctor_secure=0 untrusted_visible=1 ctor_visible=1\n",
        );
      },
      60_000,
    );

    it(
      "does not elevate a setuid overlay target on an explicitly nosuid mount",
      async () => {
        const image = await stageImage();
        const { exitCode, stdout, stderr } = await run(
          image,
          [
            "secure-exec-probe",
            "launch",
            "/usr/bin/login",
            "startup-target",
            "0",
            "0",
          ],
          true,
        );
        expect(exitCode, `stdout:\n${stdout}\nstderr:\n${stderr}`).toBe(0);
        expect(stdout).toBe(
          "secure=0 ctor_secure=0 untrusted_visible=1 ctor_visible=1\n",
        );
      },
      60_000,
    );
  },
);
