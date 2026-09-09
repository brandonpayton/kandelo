import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { tryResolveBinary } from "../src/binary-resolver";
import { NodeKernelHost } from "../src/node-kernel-host";
import { MemoryFileSystem } from "../src/vfs/memory-fs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "../..");
const kernelPath = tryResolveBinary("kernel.wasm");
const blockForeverPath = join(repoRoot, "examples/block-forever.wasm");
const spawnSmokePath = join(repoRoot, "examples/spawn-smoke.wasm");
const wasiHelloPath = join(here, "fixtures/wasi-hello.wasm");
const haveKernel = kernelPath !== null;
const haveBlockForever = existsSync(blockForeverPath);
const haveSpawnSmoke = existsSync(spawnSmokePath);
const haveWasiHello = existsSync(wasiHelloPath);

function asArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

function writeFile(
  fs: MemoryFileSystem,
  path: string,
  bytes: Uint8Array,
  mode = 0o644,
): void {
  const fd = fs.open(path, 0o1101 /* O_WRONLY|O_CREAT|O_TRUNC */, mode);
  try {
    expect(fs.write(fd, bytes, null, bytes.byteLength)).toBe(bytes.byteLength);
  } finally {
    fs.close(fd);
  }
}

function readFile(fs: MemoryFileSystem, path: string): Uint8Array {
  const stat = fs.stat(path);
  const bytes = new Uint8Array(stat.size);
  const fd = fs.open(path, 0, 0);
  try {
    expect(fs.read(fd, bytes, null, bytes.byteLength)).toBe(bytes.byteLength);
  } finally {
    fs.close(fd);
  }
  return bytes;
}

async function createRootfs(): Promise<Uint8Array> {
  const fs = MemoryFileSystem.create(new SharedArrayBuffer(8 * 1024 * 1024));
  fs.mkdir("/var", 0o755);
  fs.mkdir("/var/lib", 0o755);
  writeFile(
    fs,
    "/var/lib/persisted-state",
    new TextEncoder().encode("survives reboot\n"),
    0o640,
  );
  fs.registerLazyFile(
    "/opt/lazy-tool",
    "https://packages.example.test/lazy-tool.wasm",
    123_456,
    0o755,
  );
  return fs.saveImage();
}

async function createExecutableRootfs(
  path: string,
  program: Uint8Array,
): Promise<Uint8Array> {
  const fs = MemoryFileSystem.create(new SharedArrayBuffer(8 * 1024 * 1024));
  fs.mkdir("/bin", 0o755);
  fs.mkdir("/etc", 0o755);
  fs.mkdir("/etc/kandelo", 0o755);
  writeFile(fs, path, program, 0o755);
  writeFile(
    fs,
    "/etc/kandelo/experimental-terminal-session.json",
    new TextEncoder().encode(JSON.stringify({
      kind: "kandelo-experimental-terminal-session",
      version: 1,
      initial: {
        path,
        argv: ["wasi-hello"],
        uid: 0,
        gid: 0,
      },
    })),
  );
  return fs.saveImage();
}

describe("NodeKernelHost rootfs export contract", () => {
  it("rejects ambiguous path and byte exec sources before starting a worker", async () => {
    const host = new NodeKernelHost({
      execPrograms: { "/bin/tool": wasiHelloPath },
      execProgramBytes: { "/bin/tool": new Uint8Array([0]) },
    });
    try {
      await expect(host.init(new ArrayBuffer(0))).rejects.toThrow(
        'exec program "/bin/tool" has both path and byte sources',
      );
    } finally {
      await host.destroy();
    }
  });

  it("rejects concurrently mutable shared exec bytes before starting a worker", async () => {
    const host = new NodeKernelHost({
      execProgramBytes: {
        "/bin/tool": new Uint8Array(
          new SharedArrayBuffer(1),
        ) as unknown as Uint8Array<ArrayBuffer>,
      },
    });
    try {
      await expect(host.init(new ArrayBuffer(0))).rejects.toThrow(
        "bytes must use an ordinary ArrayBuffer",
      );
    } finally {
      await host.destroy();
    }
  });

  it("rejects export before initialization without starting a worker", async () => {
    const host = new NodeKernelHost({ rootfsImage: new Uint8Array() });
    await expect(host.readFileFromVfs("/missing")).rejects.toThrow(
      "VFS read requires an initialized kernel",
    );
    await expect(
      host.writeFileToVfs("/tmp/file", new Uint8Array([1])),
    ).rejects.toThrow("VFS write requires an initialized kernel");
    await expect(host.exportRootfsImage()).rejects.toThrow(
      "rootfs export requires an initialized kernel",
    );
    await expect(host.destroy()).resolves.toBeUndefined();
  });

  it.skipIf(!haveKernel)(
    "rejects a host-filesystem kernel because it has no VFS image",
    async () => {
      const host = new NodeKernelHost();
      try {
        await host.init(asArrayBuffer(new Uint8Array(readFileSync(kernelPath!))));
        await expect(host.readFileFromVfs("/missing")).resolves.toBeNull();
        await expect(
          host.writeFileToVfs("/tmp/file", new Uint8Array([1])),
        ).rejects.toThrow("VFS is not initialized");
        await expect(host.exportRootfsImage()).rejects.toThrow(
          "rootfs export requires a VFS-backed kernel",
        );
      } finally {
        await host.destroy();
      }
    },
  );

  it.skipIf(!haveKernel)(
    "transfers exact bytes, preserves lazy descriptors, and reboots from the export",
    async () => {
      const kernel = new Uint8Array(readFileSync(kernelPath!));
      const initialImage = await createRootfs();
      const first = new NodeKernelHost({ rootfsImage: initialImage });
      let exported: Uint8Array;
      try {
        await first.init(asArrayBuffer(kernel));
        const staged = new Uint8Array([9, 8, 7, 6]);
        await first.writeFileToVfs("/var/lib/ingested", staged, 0o620);
        await expect(
          first.readFileFromVfs("/var/lib/ingested"),
        ).resolves.toEqual(staged);
        exported = await first.exportRootfsImage();
      } finally {
        await first.destroy();
      }

      expect(exported).toBeInstanceOf(Uint8Array);
      const restored = MemoryFileSystem.fromImage(exported);
      expect(new TextDecoder().decode(
        readFile(restored, "/var/lib/persisted-state"),
      )).toBe("survives reboot\n");
      expect(restored.stat("/var/lib/persisted-state").mode & 0o7777).toBe(0o640);
      expect(readFile(restored, "/var/lib/ingested")).toEqual(
        new Uint8Array([9, 8, 7, 6]),
      );
      expect(restored.stat("/var/lib/ingested").mode & 0o7777).toBe(0o620);
      expect(restored.exportLazyEntries()).toEqual([expect.objectContaining({
        path: "/opt/lazy-tool",
        url: "https://packages.example.test/lazy-tool.wasm",
        size: 123_456,
      })]);

      const rebooted = new NodeKernelHost({ rootfsImage: exported });
      try {
        await rebooted.init(asArrayBuffer(kernel));
        const afterReboot = await rebooted.exportRootfsImage();
        const afterRebootFs = MemoryFileSystem.fromImage(afterReboot);
        expect(new TextDecoder().decode(
          readFile(afterRebootFs, "/var/lib/persisted-state"),
        )).toBe("survives reboot\n");
        expect(afterRebootFs.exportLazyEntries()).toEqual([
          expect.objectContaining({
            path: "/opt/lazy-tool",
            url: "https://packages.example.test/lazy-tool.wasm",
            size: 123_456,
          }),
        ]);
      } finally {
        await rebooted.destroy();
      }
    },
  );

  it.skipIf(!haveKernel || !haveBlockForever)(
    "rejects live and tearing-down processes without racing a snapshot",
    async () => {
      const kernel = new Uint8Array(readFileSync(kernelPath!));
      const program = new Uint8Array(readFileSync(blockForeverPath));
      const host = new NodeKernelHost({ rootfsImage: await createRootfs() });
      try {
        await host.init(asArrayBuffer(kernel));
        let startedPid = -1;
        const exit = host.spawn(asArrayBuffer(program), ["block-forever"], {
          onStarted: (pid) => {
            startedPid = pid;
          },
        });
        for (let tries = 0; startedPid < 0 && tries < 100; tries += 1) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(startedPid).toBeGreaterThan(0);

        await expect(host.exportRootfsImage()).rejects.toThrow(
          "no live or tearing-down processes",
        );

        const terminating = host.terminateProcess(startedPid, 143);
        await expect(host.exportRootfsImage()).rejects.toThrow(
          "no live or tearing-down processes",
        );
        await terminating;
        await expect(exit).resolves.toBe(143);
        await expect(host.exportRootfsImage()).resolves.toBeInstanceOf(Uint8Array);
      } finally {
        await host.destroy();
      }
    },
  );

  it.skipIf(!haveKernel || !haveSpawnSmoke || !haveWasiHello)(
    "uses worker-owned VFS bytes without resolving an ambient executable",
    async () => {
      const kernel = new Uint8Array(readFileSync(kernelPath!));
      const spawnSmoke = new Uint8Array(readFileSync(spawnSmokePath));
      const programSource = new Uint8Array(readFileSync(wasiHelloPath));
      const rootfs = await createExecutableRootfs(
        "/bin/exact-tool",
        programSource,
      );
      let stdout = "";
      let lazyDownloads = 0;
      let ambientResolveRequests = 0;
      const host = new NodeKernelHost({
        rootfsImage: rootfs,
        onLazyDownload: () => {
          lazyDownloads += 1;
        },
        onResolveExec: () => {
          ambientResolveRequests += 1;
          return null;
        },
        onStdout: (_pid, bytes) => {
          stdout += new TextDecoder().decode(bytes);
        },
      });
      try {
        await host.init(asArrayBuffer(kernel));
        // The host copied the exact generation during init. Later caller
        // replacement must not affect sequential reuse, and each overlapping
        // launch must receive an independently transferable copy.
        programSource.fill(0);
        for (let invocation = 0; invocation < 2; invocation += 1) {
          await expect(host.spawn(
            asArrayBuffer(spawnSmoke),
            ["spawn-smoke", "/bin/exact-tool"],
          )).resolves.toBe(0);
        }
        await expect(Promise.all([
          host.spawn(
            asArrayBuffer(spawnSmoke),
            ["spawn-smoke", "/bin/exact-tool"],
          ),
          host.spawn(
            asArrayBuffer(spawnSmoke),
            ["spawn-smoke", "/bin/exact-tool"],
          ),
        ])).resolves.toEqual([0, 0]);
        expect(stdout.match(/Hello from WASI\n/g)).toHaveLength(4);
        expect(stdout.match(/OK\n/g)).toHaveLength(4);
        expect(lazyDownloads).toBe(0);
        expect(ambientResolveRequests).toBe(0);
      } finally {
        await host.destroy();
      }
    },
  );

  it.skipIf(!haveKernel)(
    "exports a faithful image from the in-kernel overlay tree",
    async () => {
      const kernel = new Uint8Array(readFileSync(kernelPath!));

      // Base image: an untouched base file, a base file we will overwrite via
      // copy-on-write, a base symlink, and a lazy per-file descriptor.
      const base = MemoryFileSystem.create(new SharedArrayBuffer(8 * 1024 * 1024));
      base.mkdir("/var", 0o755);
      base.mkdir("/var/lib", 0o755);
      writeFile(
        base,
        "/var/lib/persisted-state",
        new TextEncoder().encode("survives reboot\n"),
        0o640,
      );
      writeFile(
        base,
        "/var/lib/base-to-overwrite",
        new TextEncoder().encode("original bytes\n"),
        0o644,
      );
      base.symlink("persisted-state", "/var/lib/link");
      base.registerLazyFile(
        "/opt/lazy-tool",
        "https://packages.example.test/lazy-tool.wasm",
        4242,
        0o755,
      );
      const baseImage = await base.saveImage();

      const created = new Uint8Array([9, 8, 7, 6]);
      let exported: Uint8Array;
      const host = new NodeKernelHost({ rootfsImage: baseImage });
      try {
        await host.init(asArrayBuffer(kernel));

        await host.writeFileToVfs("/var/lib/ingested", created, 0o620);
        await host.writeFileToVfs(
          "/var/lib/base-to-overwrite",
          new TextEncoder().encode("copy-on-written\n"),
          0o600,
        );

        exported = await host.exportRootfsImage();
      } finally {
        await host.destroy();
      }

      // The exported image round-trips through the normal loader.
      const restored = MemoryFileSystem.fromImage(exported);

      // Untouched base file: bytes and mode preserved.
      expect(new TextDecoder().decode(
        readFile(restored, "/var/lib/persisted-state"),
      )).toBe("survives reboot\n");
      expect(restored.stat("/var/lib/persisted-state").mode & 0o7777).toBe(0o640);

      // Copy-on-written base file: overlay bytes and mode win.
      expect(new TextDecoder().decode(
        readFile(restored, "/var/lib/base-to-overwrite"),
      )).toBe("copy-on-written\n");
      expect(restored.stat("/var/lib/base-to-overwrite").mode & 0o7777).toBe(0o600);

      // Runtime-created file: bytes and mode preserved.
      expect(readFile(restored, "/var/lib/ingested")).toEqual(created);
      expect(restored.stat("/var/lib/ingested").mode & 0o7777).toBe(0o620);

      // Base symlink preserved (target, not the resolved file).
      expect(restored.readlink("/var/lib/link")).toBe("persisted-state");

      // Lazy per-file descriptor preserved without being force-materialized
      // (its URL lives only in the base image, never in the overlay).
      expect(restored.exportLazyEntries()).toEqual([
        expect.objectContaining({
          path: "/opt/lazy-tool",
          url: "https://packages.example.test/lazy-tool.wasm",
          size: 4242,
        }),
      ]);

      // Rebooting from the exported image and re-exporting is idempotent.
      const rebooted = new NodeKernelHost({ rootfsImage: exported });
      try {
        await rebooted.init(asArrayBuffer(kernel));
        const again = await rebooted.exportRootfsImage();
        const againFs = MemoryFileSystem.fromImage(again);
        expect(new TextDecoder().decode(
          readFile(againFs, "/var/lib/base-to-overwrite"),
        )).toBe("copy-on-written\n");
        expect(readFile(againFs, "/var/lib/ingested")).toEqual(created);
        expect(againFs.readlink("/var/lib/link")).toBe("persisted-state");
        expect(againFs.exportLazyEntries()).toEqual([
          expect.objectContaining({
            path: "/opt/lazy-tool",
            url: "https://packages.example.test/lazy-tool.wasm",
            size: 4242,
          }),
        ]);
      } finally {
        await rebooted.destroy();
      }
    },
  );

  it.skipIf(!haveKernel || !haveWasiHello)(
    "spawns an executable by path from the existing worker-owned rootfs",
    async () => {
      const kernel = new Uint8Array(readFileSync(kernelPath!));
      const rootfs = await createExecutableRootfs(
        "/bin/wasi-hello",
        new Uint8Array(readFileSync(wasiHelloPath)),
      );
      let stdout = "";
      let ambientResolveRequests = 0;
      const host = new NodeKernelHost({
        rootfsImage: rootfs,
        // A VFS-path spawn must not fall back to either ambient resolution
        // mechanism, even when both could satisfy the missing path.
        execPrograms: { "/bin/missing": wasiHelloPath },
        onResolveExec: (path) => {
          ambientResolveRequests += 1;
          return path === "/bin/missing"
            ? asArrayBuffer(new Uint8Array(readFileSync(wasiHelloPath)))
            : null;
        },
        onStdout: (_pid, bytes) => {
          stdout += new TextDecoder().decode(bytes);
        },
      });
      try {
        await host.init(asArrayBuffer(kernel));
        const terminalConfig = await host.readFileFromVfs(
          "/etc/kandelo/experimental-terminal-session.json",
        );
        expect(terminalConfig).not.toBeNull();
        expect(JSON.parse(new TextDecoder().decode(terminalConfig!))).toEqual({
          kind: "kandelo-experimental-terminal-session",
          version: 1,
          initial: {
            path: "/bin/wasi-hello",
            argv: ["wasi-hello"],
            uid: 0,
            gid: 0,
          },
        });
        await expect(host.readFileFromVfs("/missing")).resolves.toBeNull();
        const { pid, exit } = await host.spawnFromVfs(
          "/bin/wasi-hello",
          ["wasi-hello"],
        );
        expect(pid).toBeGreaterThan(0);
        await expect(exit).resolves.toBe(0);
        expect(stdout).toBe("Hello from WASI\n");
        await expect(
          host.spawnFromVfs("/bin/missing", ["missing"]),
        ).rejects.toThrow("ENOENT: /bin/missing");
        expect(ambientResolveRequests).toBe(0);
      } finally {
        await host.destroy();
      }
    },
  );
});
