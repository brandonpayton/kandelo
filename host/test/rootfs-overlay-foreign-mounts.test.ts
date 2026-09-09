/**
 * Regression: the in-kernel rootfs overlay must NOT claim paths that belong to
 * a sibling filesystem still mounted under `/` after the host drops its `/`
 * mount (Phase 5 3b-wiring / cutover gap G2).
 *
 * The overlay is the unconditional sole `/` authority. Before the fix,
 * `rootfs::owns_path` treated *any* non-tmpfs absolute path as overlay-owned,
 * so it shadowed host-backed sibling mounts such as the `/run/kandelo-run`
 * session-seed tree the isolated-fixture harness uses to stage test programs.
 * The concrete symptom was `spawnFromVfs("/run/kandelo-run/...") -> ENOENT`,
 * which broke the entire POSIX + sortix conformance runners (they exec every
 * test program from that seeded tree).
 *
 * This boots the real Node kernel worker (the path that wires the overlay) and
 * spawns a program that lives ONLY under the `/run/kandelo-run` host mount. It
 * must run and exit 0 — the sibling mount stays visible even though the overlay
 * owns `/`. The kernel-side predicate itself is covered by
 * `rootfs::tests::owns_path_excludes_registered_foreign_mounts`.
 */

import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { NodeKernelHost } from "../src/node-kernel-host";
import { DEFAULT_MOUNT_SPEC } from "../src/vfs/default-mounts";
import { tryResolveBinary } from "../src/binary-resolver";

function asArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "../..");
const rootfsImagePath = join(repoRoot, "host/wasm/rootfs.vfs");
const helloWasmPath = join(repoRoot, "examples/hello.wasm");

const kernelPath = tryResolveBinary("kernel.wasm");
const havePrereqs = existsSync(rootfsImagePath) &&
  existsSync(helloWasmPath) && kernelPath !== null;

describe.runIf(havePrereqs)(
  "rootfs overlay foreign sibling mounts",
  () => {
    it(
      "spawns a program that lives only under the /run/kandelo-run host mount",
      async () => {
        // Stage the guest program in a host directory and seed it under
        // `/run/kandelo-run` — a host-backed scratch mount, exactly like the
        // isolated conformance fixture harness (`resolveRunExampleFilesystem`).
        const seedRoot = mkdtempSync(join(tmpdir(), "kandelo-foreign-seed-"));
        cpSync(helloWasmPath, join(seedRoot, "prog.wasm"));

        let stdout = "";
        const host = new NodeKernelHost({
          rootfsImage: new Uint8Array(readFileSync(rootfsImagePath)),
          rootfsMountSpec: [
            ...DEFAULT_MOUNT_SPEC,
            { path: "/run", source: "scratch", mode: 0o755, nosuid: true },
          ],
          sessionSeedTrees: [
            { destinationPath: "/run/kandelo-run", sourcePath: seedRoot },
          ],
          onStdout: (_pid, bytes) => {
            stdout += new TextDecoder().decode(bytes);
          },
        });

        try {
          await host.init(
            asArrayBuffer(new Uint8Array(readFileSync(kernelPath!))),
          );
          const { exit } = await host.spawnFromVfs(
            "/run/kandelo-run/prog.wasm",
            ["prog"],
          );
          const exitCode = await exit;
          expect(exitCode).toBe(0);
          // hello.wasm prints its greeting; proves it actually ran, not just
          // resolved.
          expect(stdout.toLowerCase()).toContain("hello");
        } finally {
          await host.destroy().catch(() => {});
          rmSync(seedRoot, { recursive: true, force: true });
        }
      },
      60_000,
    );
  },
);
