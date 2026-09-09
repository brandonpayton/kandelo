/**
 * Regression: a GUEST-initiated spawn (posix_spawn / popen / system, and the
 * PHP popen/proc_open/shell_exec that build on them) must be able to launch a
 * program whose bytes live in the in-kernel rootfs overlay (the unconditional
 * sole `/` authority) (Phase 5 cutover gap G1).
 *
 * Root cause this pins: the kernel handles SYS_SPAWN inside a protocol
 * transaction-start (`CentralizedKernelWorker.#handleSpawn` ->
 * `deferProtocolTransactionStart`). Its side-effect-free resolver
 * (`onResolveSpawn` -> `resolveExecutableForLaunch` -> `resolveExec` ->
 * `readExecFromVfs` -> `readExecFromOverlay`) reads the child's bytes through
 * `kernelWorker.rootfsReadFile`, which is an IMMEDIATE, result-bearing kernel
 * entry. The synchronous prefix of that async resolver runs while
 * `#runningProtocolTransactionStart` is still set, so the entry gate rejected
 * it with `KernelReentrantEntryError` ("kernel rootfs read file cannot run
 * while protocol transaction start is active"). libc surfaced that as
 * `posix_spawn` -> EIO, breaking PHP-FPM/nginx/WordPress worker spawning.
 *
 * Before Phase 5 w5 the resolver read the `/` mount directly (pure host I/O,
 * no kernel entry), so this only regressed once host exec-byte reads were
 * routed through the overlay. Guest `execve` never tripped this because it
 * reads bytes through the deferrable kernel exec-target mechanism, not an
 * immediate mid-transaction re-entry.
 *
 * This boots the real Node kernel worker (the path that wires the overlay) and
 * stages BOTH the spawner and its child as overlay-resident programs. The child
 * is NOT provided via `execPrograms`, so the only way SYS_SPAWN can find it is
 * through the overlay — exactly the failing path. It must run and exit 0.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { NodeKernelHost } from "../src/node-kernel-host";
import { tryResolveBinary } from "../src/binary-resolver";
import { MemoryFileSystem } from "../src/vfs/memory-fs";
import { ensureDirRecursive, writeVfsBinary } from "../src/vfs/image-helpers";

function asArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "../..");
const spawnSmokeWasmPath = join(repoRoot, "examples/spawn-smoke.wasm");
const helloWasmPath = join(repoRoot, "examples/hello.wasm");

const kernelPath = tryResolveBinary("kernel.wasm");
const havePrereqs = existsSync(spawnSmokeWasmPath) &&
  existsSync(helloWasmPath) && kernelPath !== null;

describe.runIf(havePrereqs)(
  "guest-initiated posix_spawn of an overlay-resident program",
  () => {
    it(
      "posix_spawns an overlay-resident child from a guest program",
      async () => {
        // Build a rootfs image where both the spawner and the child live only
        // in the overlay-owned `/` tree — the child is deliberately absent from
        // any host execPrograms map, so SYS_SPAWN must resolve it through the
        // overlay (kernelWorker.rootfsReadFile) to launch it.
        const fs = MemoryFileSystem.create(
          new SharedArrayBuffer(32 * 1024 * 1024),
        );
        ensureDirRecursive(fs, "/bin");
        writeVfsBinary(
          fs,
          "/bin/spawn-smoke",
          new Uint8Array(readFileSync(spawnSmokeWasmPath)),
        );
        writeVfsBinary(
          fs,
          "/bin/hello",
          new Uint8Array(readFileSync(helloWasmPath)),
        );
        const image = await fs.saveImage();

        let stdout = "";
        let stderr = "";
        const host = new NodeKernelHost({
          rootfsImage: image,
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
          // Host-initiated spawn of the spawner works today; the guest-initiated
          // posix_spawn it performs of /bin/hello is the path under test.
          const { exit } = await host.spawnFromVfs(
            "/bin/spawn-smoke",
            ["spawn-smoke", "/bin/hello"],
          );
          const exitCode = await exit;

          // spawn-smoke prints "OK" only after posix_spawn + waitpid of the
          // overlay-resident child succeed. Before the fix the guest posix_spawn
          // failed with EIO and spawn-smoke exited 1 with a strerror diagnostic.
          expect(
            exitCode,
            `stdout:\n${stdout}\nstderr:\n${stderr}`,
          ).toBe(0);
          expect(stdout).toContain("OK");
          // The child actually ran through the overlay (hello.wasm greeting),
          // proving the spawn resolved real bytes rather than a stub.
          expect(stdout.toLowerCase()).toContain("hello");
        } finally {
          await host.destroy().catch(() => {});
        }
      },
      60_000,
    );
  },
);
