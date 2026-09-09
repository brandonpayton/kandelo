import { createHash } from "node:crypto";
import { createServer } from "node:http";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { zipSync } from "fflate";
import { describe, expect, it } from "vitest";

import { NodeKernelHost } from "../src/node-kernel-host";
import { MemoryFileSystem } from "../src/vfs/memory-fs";
import { parseZipCentralDirectory } from "../src/vfs/zip";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "../..");
const mountProbe = join(repoRoot, "examples/mount_probe_test.wasm");
const kernel = [
  join(repoRoot, "local-binaries/kernel.wasm"),
  join(repoRoot, "target/wasm32-unknown-unknown/release/kandelo_kernel.wasm"),
].find(existsSync) ?? join(repoRoot, "local-binaries/kernel.wasm");
const available = [mountProbe, kernel].every(existsSync);

function arrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

function integrity(bytes: Uint8Array): { sha256: string; bytes: number } {
  return {
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.byteLength,
  };
}

describe.skipIf(!available)("Node lazy archive runtime paths", () => {
  // Phase 5 cutover: with the in-kernel rootfs overlay owning `/`
  // unconditionally, a closed-source lazy ZIP archive must (a) be fetched from
  // its bound source exactly once even across repeated guest reads of the same
  // archive (the overlay's archive provider caches the raw archive after the
  // first fetch), and (b) fail CLOSED — a real guest read fails with EIO — when
  // the archive's transport URL is not bound to any allowed source. This
  // migrates the pre-cutover System-A `registerLazyTree` (tar-gzip) coverage of
  // closed-source binding + fetch-once dedup onto the overlay's ZIP archive
  // path (`registerLazyArchiveFromEntries` -> `buildRootfsLazyWiring` ->
  // `host_fetch_archive`), the only lazy-archive format the kernel decodes.
  it("fetches a closed source only once and fails closed for an unbound archive", async () => {
    const probeBytes = new Uint8Array(readFileSync(mountProbe));
    const boundFile = new TextEncoder().encode("bound lazy archive\n");
    const unboundFile = new TextEncoder().encode("unbound lazy archive\n");
    const boundArchive = zipSync({ "etc/closed-bound": boundFile });
    const unboundArchive = zipSync({ "etc/closed-unbound": unboundFile });

    let sourceRequests = 0;
    const server = createServer((request, response) => {
      sourceRequests += 1;
      if (request.url !== "/v1/bound.zip") {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, {
        "content-length": String(boundArchive.byteLength),
      });
      response.end(boundArchive);
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("lazy source fixture lacks a TCP address");
    }
    const sourceUrl = `http://127.0.0.1:${address.port}/v1/bound.zip`;
    const boundUrl =
      "https://github.com/example/project/releases/download/v1/bound.zip";
    const unboundUrl =
      "https://github.com/example/project/releases/download/v1/unbound.zip";

    const fs = MemoryFileSystem.create(new SharedArrayBuffer(32 * 1024 * 1024));
    // The bound archive's transport is `boundUrl`, which the closed-source
    // fetcher maps to the local `sourceUrl`; the unbound archive's transport is
    // `unboundUrl`, absent from `rootfsLazyAssetSources`, so the fetcher rejects
    // it and the read must surface EIO rather than silently succeeding.
    fs.registerLazyArchiveFromEntries(
      boundUrl,
      parseZipCentralDirectory(boundArchive),
      "/",
      undefined,
      integrity(boundArchive),
    );
    fs.registerLazyArchiveFromEntries(
      unboundUrl,
      parseZipCentralDirectory(unboundArchive),
      "/",
      undefined,
      integrity(unboundArchive),
    );

    let stdout = "";
    const host = new NodeKernelHost({
      rootfsImage: await fs.saveImage(),
      rootfsLazyAssetSources: [{
        url: boundUrl,
        sourceUrl,
        sha256: integrity(boundArchive).sha256,
        size: boundArchive.byteLength,
      }],
      onStdout: (_pid, bytes) => {
        stdout += new TextDecoder().decode(bytes);
      },
    });

    try {
      await host.init(arrayBuffer(new Uint8Array(readFileSync(kernel))));
      expect(sourceRequests).toBe(0);

      // First guest read of the bound archive materializes it (fetch #1).
      expect(await host.spawn(arrayBuffer(probeBytes), [
        "mount_probe_test",
        "rootfs",
        "/etc/closed-bound",
      ])).toBe(0);
      expect(stdout).toContain(`ROOTFS size=${boundFile.byteLength}`);
      expect(sourceRequests).toBe(1);

      // A second guest read of the same archive is served from cache — the
      // bound source is NOT fetched again (fetch-once dedup).
      stdout = "";
      expect(await host.spawn(arrayBuffer(probeBytes), [
        "mount_probe_test",
        "rootfs",
        "/etc/closed-bound",
      ])).toBe(0);
      expect(stdout).toContain(`ROOTFS size=${boundFile.byteLength}`);
      expect(sourceRequests).toBe(1);

      // The unbound archive's transport is not bound to any source, so the
      // fetcher fails closed. The lazy member's metadata is known, so `open`
      // succeeds and the failure surfaces as EIO when the bytes are read (the
      // archive fetch cannot complete): `ROOTFS read-errno=5`.
      stdout = "";
      expect(await host.spawn(arrayBuffer(probeBytes), [
        "mount_probe_test",
        "rootfs",
        "/etc/closed-unbound",
      ])).toBe(1);
      expect(stdout).toContain("ROOTFS read-errno=5");
      // The unbound source is never even attempted against the local server.
      expect(sourceRequests).toBe(1);
    } finally {
      await host.destroy().catch(() => {});
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  // Phase 5 Increment 3a: with the in-kernel rootfs overlay owning `/`, a read of
  // a lazy (not-yet-materialized) base file must park and retry until the host
  // materializes it — not fail with a spurious EIO. This exercises the whole
  // chain: overlay-owned `/` -> blob_read -> provider -> backend.open throws
  // EAGAIN (kicking off the async fetch) -> provider returns -EAGAIN -> kernel
  // parks the read -> host default poll-retry re-drives it -> materialized bytes.
  // Without the provider's EAGAIN propagation this fails (the first blob_read
  // returns EIO and the read never retries), so it pins the fix.
  it("materializes a lazy base file read through the kernel rootfs overlay", async () => {
    const probeBytes = new Uint8Array(readFileSync(mountProbe));
    const payload = new TextEncoder().encode("lazy-node-data"); // 14 bytes
    const dataArchive = zipSync({ "etc/lazy-runtime-data": payload });

    // Serve the archive from a local file:// URL the Node lazy transport can read.
    const temp = mkdtempSync(join(tmpdir(), "kandelo-lazy-rootfs-"));
    const dataArchivePath = join(temp, "data.zip");
    writeFileSync(dataArchivePath, dataArchive);

    const fs = MemoryFileSystem.create(new SharedArrayBuffer(32 * 1024 * 1024));
    fs.registerLazyArchiveFromEntries(
      pathToFileURL(dataArchivePath).href,
      parseZipCentralDirectory(dataArchive),
      "/",
      undefined,
      integrity(dataArchive),
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
      await host.init(arrayBuffer(new Uint8Array(readFileSync(kernel))));
      expect(await host.spawn(arrayBuffer(probeBytes), [
        "mount_probe_test",
        "rootfs",
        "/etc/lazy-runtime-data",
      ])).toBe(0);
      expect(stdout).toContain(`ROOTFS size=${payload.byteLength}`);
      expect(stderr).toBe("");
    } finally {
      await host.destroy().catch(() => {});
      rmSync(temp, { recursive: true, force: true });
    }
  });

  // Phase 5 Increment 2e-S3: with the overlay owning `/`, host-side reads and
  // writes of `/` must route THROUGH the overlay (the authority), not the
  // demoted base-image MemoryFileSystem. The decisive proof is cross-authority:
  // a file the host writes must be visible to a live guest, and read back
  // through the overlay round-trips.
  it("routes host read/write of `/` through the overlay, visible to guests", async () => {
    const probeBytes = new Uint8Array(readFileSync(mountProbe));
    // A minimal eager `/` image (just the root dir); the file under test does
    // not exist in it, so a guest seeing it proves the host write reached the
    // authoritative overlay.
    const fs = MemoryFileSystem.create(new SharedArrayBuffer(32 * 1024 * 1024));
    const image = await fs.saveImage();

    let stdout = "";
    const host = new NodeKernelHost({
      rootfsImage: image,
      onStdout: (_pid, bytes) => {
        stdout += new TextDecoder().decode(bytes);
      },
    });

    try {
      await host.init(arrayBuffer(new Uint8Array(readFileSync(kernel))));
      const payload = new TextEncoder().encode("host-written-body");
      await host.writeFileToVfs("/host-written", payload, 0o644);
      // Host read-back through the overlay round-trips the exact bytes.
      const readBack = await host.readFileFromVfs("/host-written");
      expect(readBack).not.toBeNull();
      expect(new TextDecoder().decode(readBack!)).toBe("host-written-body");
      // A guest reads the same path and sees the host's write via the overlay.
      expect(await host.spawn(arrayBuffer(probeBytes), [
        "mount_probe_test",
        "rootfs",
        "/host-written",
      ])).toBe(0);
      expect(stdout).toContain(`ROOTFS size=${payload.byteLength}`);
    } finally {
      await host.destroy().catch(() => {});
    }
  });

  // Phase 5 Increment 2e-S1: exec-target reads program bytes through the overlay.
  // The decisive proof is an executable that exists ONLY in the overlay (planted
  // via the host write RPC), absent from the base image: `host_open` on its path
  // would ENOENT, so a successful exec-resolve proves exec-target opened + read
  // it from the overlay, not the host `/` mount.
  it("execs an overlay-only `/` binary the base image lacks", async () => {
    const probeBytes = new Uint8Array(readFileSync(mountProbe));
    const fs = MemoryFileSystem.create(new SharedArrayBuffer(32 * 1024 * 1024));
    const image = await fs.saveImage();

    let stdout = "";
    const host = new NodeKernelHost({
      rootfsImage: image,
      onStdout: (_pid, bytes) => {
        stdout += new TextDecoder().decode(bytes);
      },
    });

    try {
      await host.init(arrayBuffer(new Uint8Array(readFileSync(kernel))));
      // Plant a real executable under `/` that the base image does not contain.
      await host.writeFileToVfs("/planted", probeBytes, 0o755);
      // Exec-resolve it by path from the overlay and run it (it reads itself).
      const { exit } = await host.spawnFromVfs("/planted", [
        "planted",
        "rootfs",
        "/planted",
      ]);
      expect(await exit).toBe(0);
      expect(stdout).toContain(`ROOTFS size=${probeBytes.byteLength}`);
    } finally {
      await host.destroy().catch(() => {});
    }
  });
});
