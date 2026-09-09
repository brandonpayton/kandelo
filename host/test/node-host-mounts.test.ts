/**
 * Task 4.3 — Node host wires `host/wasm/rootfs.vfs` and applies
 * `DEFAULT_MOUNT_SPEC` via the fresh-session Node resolver at boot when the caller
 * does not supply a custom `io`.
 *
 * Each probe runs `examples/mount_probe_test.wasm` with a mode argv:
 *
 *   rootfs    /etc/services exists in the rootfs image and matches
 *             the on-disk source under `images/rootfs/etc/services`.
 *
 *   scratch   /tmp/<file> is writable through the mount router and
 *             persists across open/close within the same process. Post-cutover
 *             `/tmp` is served by the unconditional in-kernel tmpfs.
 *
 *   unmounted /no/such/mount returns ENOENT (proves the mount router
 *             enforces VFS-only-lens — no fallthrough to the host fs).
 *
 *   path-resolution resolves symlinks and dot-dot component-wise across the
 *             in-kernel tmpfs `/tmp` and the root image mount boundary.
 *
 *   custom    overriding `io` opts out of the default mount setup —
 *             /etc/services is no longer reachable via the rootfs image.
 */

import { describe, it, expect } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runCentralizedProgram } from "./centralized-test-helper";
import { NodePlatformIO } from "../src/platform/node";
import { NodeKernelHost } from "../src/node-kernel-host";
import { MemoryFileSystem } from "../src/vfs/memory-fs";
import { DEFAULT_MOUNT_SPEC, type MountSpec } from "../src/vfs/default-mounts";
// The in-kernel tmpfs owns its scratch prefixes unconditionally, so scratch
// writes to `/tmp` etc. are served by the kernel. The session-seed case seeds a
// non-tmpfs `/run` scratch mount the host still materialises.


const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "../..");
const probeWasm = join(repoRoot, "examples/mount_probe_test.wasm");
const rootfsImage = join(repoRoot, "host/wasm/rootfs.vfs");
const servicesSource = join(repoRoot, "images/rootfs/etc/services");
const caCertSource = join(repoRoot, "images/rootfs/etc/ssl/cert.pem");
const opensslConfigSource = join(repoRoot, "images/rootfs/etc/ssl/openssl.cnf");

const haveProbe = existsSync(probeWasm);
const haveRootfs = existsSync(rootfsImage);

describe("node session seed configuration", () => {
  it("rejects a custom mount specification without a rootfs before starting a worker", async () => {
    const host = new NodeKernelHost({
      rootfsMountSpec: [],
    });
    try {
      await expect(host.init(new ArrayBuffer(0))).rejects.toThrow(
        "rootfsMountSpec requires rootfsImage",
      );
    } finally {
      await host.destroy();
    }
  });

  it("rejects seeds without a rootfs before starting a worker", async () => {
    const host = new NodeKernelHost({
      sessionSeedTrees: [{
        sourcePath: "/not-consulted",
        destinationPath: "/tmp/seed",
      }],
    });
    try {
      await expect(host.init(new ArrayBuffer(0))).rejects.toThrow(
        "sessionSeedTrees requires rootfsImage",
      );
    } finally {
      await host.destroy();
    }
  });
});

describe.skipIf(!haveProbe || !haveRootfs)("node-host default mount setup", () => {
  it("stores exact root-owned OpenSSL files in the canonical image", () => {
    const fs = MemoryFileSystem.fromImage(
      new Uint8Array(readFileSync(rootfsImage)),
    );
    for (const [path, source] of [
      ["/etc/ssl/openssl.cnf", opensslConfigSource],
      ["/etc/ssl/cert.pem", caCertSource],
      ["/etc/ssl/certs/ca-certificates.crt", caCertSource],
    ] as const) {
      const expected = readFileSync(source);
      const st = fs.stat(path);
      expect(st.mode & 0xf000).toBe(0x8000);
      expect(st.mode & 0o7777).toBe(0o644);
      expect(st.uid).toBe(0);
      expect(st.gid).toBe(0);
      expect(st.size).toBe(expected.byteLength);

      const actual = new Uint8Array(st.size);
      const fd = fs.open(path, 0, 0);
      try {
        expect(fs.read(fd, actual, null, actual.length)).toBe(actual.length);
      } finally {
        fs.close(fd);
      }
      expect(Buffer.from(actual)).toEqual(expected);
    }
  });

  it("stat + read /etc/services from the mounted rootfs image", async () => {
    const expected = readFileSync(servicesSource);
    const expectedHead = Array.from(expected.subarray(0, 16))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    const result = await runCentralizedProgram({
      programPath: probeWasm,
      argv: ["mount_probe_test", "rootfs", "/etc/services"],
      timeout: 10_000,
    });

    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain(`ROOTFS size=${expected.length}`);
    expect(result.stdout).toContain(`head=${expectedHead}`);
  });

  it("/tmp scratch mount round-trips a write through the in-kernel tmpfs", async () => {
    const result = await runCentralizedProgram({
      programPath: probeWasm,
      argv: ["mount_probe_test", "scratch", "/tmp/mount-probe.txt"],
      timeout: 10_000,
    });

    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain("SCRATCH size=24");
    expect(result.stdout).toContain("content=scratch-mount-roundtrip");
  });

  it("gives concurrent boots independent private copies of one seed tree", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "kandelo-node-seed-"));
    const sourceFile = join(fixtureRoot, "suite", "fixture");
    mkdirSync(dirname(sourceFile), { recursive: true });
    writeFileSync(sourceFile, "seed");
    const program = readFileSync(probeWasm);
    const programBytes = program.buffer.slice(
      program.byteOffset,
      program.byteOffset + program.byteLength,
    );
    // Seed a `/run` scratch mount: the in-kernel tmpfs owns `/tmp` and the other
    // canonical scratch prefixes unconditionally, so host-materialised session
    // seeds live on a non-tmpfs scratch mount the host still owns.
    const rootfsMountSpec: MountSpec[] = [
      ...DEFAULT_MOUNT_SPEC,
      { path: "/run", source: "scratch", mode: 0o755, nosuid: true },
    ];
    const seedPath = "/run/kandelo-run/suite/fixture";
    // Verify through the guest, not `readFileFromVfs`: the in-kernel rootfs
    // overlay is the sole `/` authority and disowns the `/run` foreign mount, so
    // the host-side `readFileFromVfs` (which reads only the overlay) never sees
    // seeded host-mount bytes. A guest `mount_probe rootfs` read routes through
    // the `/run` backend and reports `ROOTFS size=<n> ... head=<hex>`.
    function makeSeededHost(): { host: NodeKernelHost; readOut: () => string } {
      let out = "";
      const host = new NodeKernelHost({
        rootfsImage: "default",
        rootfsMountSpec,
        sessionSeedTrees: [{
          sourcePath: fixtureRoot,
          destinationPath: "/run/kandelo-run",
        }],
        onStdout: (_pid, data) => {
          out += new TextDecoder().decode(data);
        },
      });
      return { host, readOut: () => out };
    }
    async function guestRead(
      host: NodeKernelHost,
      readOut: () => string,
    ): Promise<string> {
      const before = readOut().length;
      expect(
        await host.spawn(programBytes, ["mount_probe_test", "rootfs", seedPath]),
      ).toBe(0);
      return readOut().slice(before);
    }
    const first = makeSeededHost();
    const second = makeSeededHost();
    // "seed" is 4 bytes; probe_rootfs prints the leading bytes as hex.
    const seedHex = "73656564";

    try {
      await Promise.all([first.host.init(), second.host.init()]);
      writeFileSync(sourceFile, "external");

      for (const boot of [first, second]) {
        const output = await guestRead(boot.host, boot.readOut);
        expect(output).toContain("ROOTFS size=4");
        expect(output).toContain(`head=${seedHex}`);
      }

      // Mutating the private copy in the first boot must not reach the second.
      expect(
        await first.host.spawn(programBytes, [
          "mount_probe_test",
          "scratch",
          seedPath,
        ]),
      ).toBe(0);

      const firstAfter = await guestRead(first.host, first.readOut);
      // "scratch-mount-roundtrip\n" is 24 bytes.
      expect(firstAfter).toContain("ROOTFS size=24");
      const secondAfter = await guestRead(second.host, second.readOut);
      expect(secondAfter).toContain("ROOTFS size=4");
      expect(secondAfter).toContain(`head=${seedHex}`);

      // The already-copied seed is independent of later source mutation.
      expect(readFileSync(sourceFile, "utf8")).toBe("external");
    } finally {
      await Promise.allSettled([first.host.destroy(), second.host.destroy()]);
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it.each([
    ["/etc/ssl/openssl.cnf", opensslConfigSource],
    ["/etc/ssl/cert.pem", caCertSource],
    ["/etc/ssl/certs/ca-certificates.crt", caCertSource],
  ])("serves rootfs-owned OpenSSL data at %s", async (path, source) => {
    const expected = readFileSync(source);
    const expectedHead = Array.from(expected.subarray(0, 16))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    const result = await runCentralizedProgram({
      programPath: probeWasm,
      argv: ["mount_probe_test", "rootfs", path],
      timeout: 10_000,
    });

    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain(`ROOTFS size=${expected.length}`);
    expect(result.stdout).toContain(`head=${expectedHead}`);
  });

  it.each(["/etc/ssl/openssl.cnf", "/etc/ssl/cert.pem"])(
    "does not fabricate caller-missing OpenSSL data at %s",
    async (path) => {
      const fs = MemoryFileSystem.create(new SharedArrayBuffer(1024 * 1024));
      fs.mkdir("/etc", 0o755);
      const image = await fs.saveImage();
      const program = readFileSync(probeWasm);
      let stdout = "";
      const host = new NodeKernelHost({
        rootfsImage: image,
        onStdout: (_pid, data) => {
          stdout += new TextDecoder().decode(data);
        },
      });

      try {
        await host.init();
        const exitCode = await host.spawn(
          program.buffer.slice(
            program.byteOffset,
            program.byteOffset + program.byteLength,
          ),
          ["mount_probe_test", "rootfs", path],
        );
        expect(exitCode).toBe(1);
        expect(stdout).toContain("ROOTFS stat-errno=2");
      } finally {
        await host.destroy();
      }
    },
  );

  it("returns ENOENT for paths outside every mount (no fallthrough)", async () => {
    const result = await runCentralizedProgram({
      programPath: probeWasm,
      argv: ["mount_probe_test", "unmounted", "/no/such/mount/point"],
      timeout: 10_000,
    });

    expect(result.exitCode, result.stderr).toBe(0);
    // ENOENT is 2 on the wasm32 musl ABI used by user programs.
    expect(result.stdout).toContain("UNMOUNTED errno=2");
  });

  it("resolves pathname components across scratch and rootfs mounts", async () => {
    const result = await runCentralizedProgram({
      programPath: probeWasm,
      argv: [
        "mount_probe_test",
        "path-resolution",
        "/tmp/kandelo-path-resolution",
      ],
      timeout: 10_000,
    });

    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain("PATH_RESOLUTION_PASS");
    expect(result.stderr).toBe("");
  });

  it("rejects invalid initial cwd without leaking a registered process", async () => {
    const program = readFileSync(probeWasm);
    const programBytes = program.buffer.slice(
      program.byteOffset,
      program.byteOffset + program.byteLength,
    );
    const host = new NodeKernelHost({ rootfsImage: "default" });

    try {
      await host.init();
      // The kernel creates its persistent init process when the first guest is
      // registered, not when the worker itself is initialized. Warm that path
      // before taking the baseline so the assertion below measures only the
      // failed child registration.
      expect(
        await host.spawn(programBytes, [
          "mount_probe_test",
          "rootfs",
          "/etc/services",
        ]),
      ).toBe(0);
      const before = await host.enumProcs();

      await expect(
        host.spawn(programBytes, ["mount_probe_test", "rootfs", "/etc/services"], {
          cwd: "/no/such/cwd",
        }),
      ).rejects.toThrow(/setCwd failed for pid \d+: errno 2/);
      expect(await host.enumProcs()).toEqual(before);

      await expect(
        host.spawn(programBytes, ["mount_probe_test", "rootfs", "/etc/services"], {
          cwd: "/root",
          uid: 1000,
          gid: 1000,
        }),
      ).rejects.toThrow(/setCwd failed for pid \d+: errno 13/);
      expect(await host.enumProcs()).toEqual(before);
    } finally {
      await host.destroy();
    }
  });

  it("custom `io` override bypasses the default mount setup", async () => {
    // NodePlatformIO has no synthetic /etc/services entry and the host
    // filesystem doesn't have one at the root either, so it must fail.
    const result = await runCentralizedProgram({
      programPath: probeWasm,
      argv: ["mount_probe_test", "rootfs", "/etc/services"],
      io: new NodePlatformIO(),
      timeout: 10_000,
    });

    // The probe prints ROOTFS stat-errno=<n> when stat fails. We just
    // assert the success line is absent — the precise errno depends on
    // the host's /etc/services (macOS has one, Linux too), so we can't
    // hard-code a value. The point is: with a custom `io`, the call no
    // longer goes through the rootfs.vfs image we built for these tests
    // (size differs from the host's /etc/services).
    if (result.exitCode === 0) {
      const expected = readFileSync(servicesSource);
      // If somehow it succeeded, it must NOT match the rootfs image
      // (which is what the default-mount path would have returned).
      expect(result.stdout).not.toContain(`ROOTFS size=${expected.length}`);
    }
  });
});
