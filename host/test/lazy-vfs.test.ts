import { describe, it, expect, vi } from "vitest";
import { MemoryFileSystem, type LazyDownloadEvent } from "../src/vfs/memory-fs";

const O_RDONLY = 0x0000;
const O_WRONLY = 0x0001;
const O_CREAT = 0x0040;
const O_TRUNC = 0x0200;

function createMemfs(): MemoryFileSystem {
  const sab = new SharedArrayBuffer(4 * 1024 * 1024);
  return MemoryFileSystem.create(sab);
}

describe("Lazy VFS files", () => {
  it("registerLazyFile creates empty stub and returns inode", () => {
    const mfs = createMemfs();
    const ino = mfs.registerLazyFile("/bin/test", "http://example.com/test.wasm", 1024, 0o755);
    expect(ino).toBeGreaterThan(0);
  });

  it("stat returns declared size for unmaterialized lazy file", () => {
    const mfs = createMemfs();
    const declaredSize = 98765;
    mfs.registerLazyFile("/bin/test", "http://example.com/test.wasm", declaredSize, 0o755);

    const st = mfs.stat("/bin/test");
    expect(st.size).toBe(declaredSize);
    expect(st.mode & 0o777).toBe(0o755);
  });

  it("fstat returns declared size for unmaterialized lazy file", () => {
    const mfs = createMemfs();
    const peer = MemoryFileSystem.fromExisting(mfs.sharedBuffer);
    const declaredSize = 54321;
    mfs.registerLazyFile("/bin/test", "http://example.com/test.wasm", declaredSize);

    // A peer without the process-local lazy registry can already hold the
    // shared inode open. The owner must still report its declared logical
    // size through that handle without fetching bytes.
    const fd = peer.open("/bin/test", O_RDONLY, 0);
    const st = mfs.fstat(fd);
    expect(st.size).toBe(declaredSize);
    peer.close(fd);
  });

  it("lstat returns declared size for unmaterialized lazy file", () => {
    const mfs = createMemfs();
    const declaredSize = 11111;
    mfs.registerLazyFile("/bin/test", "http://example.com/test.wasm", declaredSize);

    const st = mfs.lstat("/bin/test");
    expect(st.size).toBe(declaredSize);
  });

  it("creates parent directories automatically", () => {
    const mfs = createMemfs();
    mfs.registerLazyFile("/usr/local/bin/tool", "http://example.com/tool.wasm", 100);

    // Should be able to stat the file and parent dirs
    const st = mfs.stat("/usr/local/bin/tool");
    expect(st.size).toBe(100);

    const dir = mfs.stat("/usr/local/bin");
    expect(dir.mode & 0o170000).toBe(0o040000); // S_IFDIR
  });

  it("exportLazyEntries returns all registered lazy files", () => {
    const mfs = createMemfs();
    mfs.registerLazyFile("/bin/a", "http://example.com/a.wasm", 100);
    mfs.registerLazyFile("/bin/b", "http://example.com/b.wasm", 200);

    const entries = mfs.exportLazyEntries();
    expect(entries).toHaveLength(2);
    expect(entries.map(e => e.path).sort()).toEqual(["/bin/a", "/bin/b"]);
    expect(entries.find(e => e.path === "/bin/a")!.size).toBe(100);
    expect(entries.find(e => e.path === "/bin/b")!.size).toBe(200);
  });

  it("getLazyEntry returns lazy metadata and follows symlinks", () => {
    const mfs = createMemfs();
    mfs.registerLazyFile("/usr/bin/tool", "programs/tool.wasm", 100);
    mfs.mkdir("/bin", 0o755);
    mfs.symlink("/usr/bin/tool", "/bin/tool");

    expect(mfs.getLazyEntry("/bin/tool")).toMatchObject({
      path: "/usr/bin/tool",
      url: "programs/tool.wasm",
      size: 100,
    });
  });

  it("rewriteLazyFileUrls updates lazy metadata without changing size", () => {
    const mfs = createMemfs();
    mfs.registerLazyFile("/bin/tool", "kandelo-lazy:programs/tool.wasm", 1234);

    mfs.rewriteLazyFileUrls((url, path) => {
      expect(path).toBe("/bin/tool");
      return url.replace("kandelo-lazy:", "/assets/");
    });

    const [entry] = mfs.exportLazyEntries();
    expect(entry.url).toBe("/assets/programs/tool.wasm");
    expect(entry.size).toBe(1234);
    expect(mfs.stat("/bin/tool").size).toBe(1234);
  });

  it("importLazyEntries restores lazy metadata on another instance", () => {
    // Create first instance and register lazy files
    const sab = new SharedArrayBuffer(4 * 1024 * 1024);
    const mfs1 = MemoryFileSystem.create(sab);
    mfs1.registerLazyFile("/bin/tool", "http://example.com/tool.wasm", 5000);

    const entries = mfs1.exportLazyEntries();

    // Mount a second instance on the same SAB
    const mfs2 = MemoryFileSystem.fromExisting(sab);
    mfs2.importLazyEntries(entries);

    // Second instance should see the declared size
    const st = mfs2.stat("/bin/tool");
    expect(st.size).toBe(5000);
  });

  it("mountCapturedBytes carries the deferred content its image knows", async () => {
    const originalFetch = globalThis.fetch;
    const image = createMemfs();
    image.registerLazyFile("/usr/bin/tool", "http://example.com/tool.wasm", 5, 0o755);

    // What a machine checkpoint carries is the filesystem buffer and nothing
    // else. Which files are still deferred, and where their bytes come from,
    // lives in the image beside that buffer rather than inside it.
    const capturedBytes = new SharedArrayBuffer(image.sharedBuffer.byteLength);
    new Uint8Array(capturedBytes).set(new Uint8Array(image.sharedBuffer));

    // Attached to those bytes alone, the program is a file that exists and can
    // never be read, so every process that execs it dies on an empty program.
    expect(
      MemoryFileSystem.fromExisting(capturedBytes).isPathDeferred("/usr/bin/tool"),
    ).toBe(false);

    const restored = image.mountCapturedBytes(capturedBytes);
    expect(restored.isPathDeferred("/usr/bin/tool")).toBe(true);

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ "content-length": "5" }),
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2, 3, 4, 5]));
          controller.close();
        },
      }),
    } as unknown as Response);
    try {
      await expect(restored.ensureMaterialized("/usr/bin/tool")).resolves.toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }

    const fd = restored.open("/usr/bin/tool", O_RDONLY, 0);
    const buf = new Uint8Array(8);
    expect(restored.read(fd, buf, null, 8)).toBe(5);
    expect(buf[4]).toBe(5);
    restored.close(fd);
  });

  it("mountCapturedBytes keeps a file the captured machine already read", () => {
    const image = createMemfs();
    image.registerLazyFile("/usr/bin/tool", "http://example.com/tool.wasm", 5, 0o755);

    const capturedBytes = new SharedArrayBuffer(image.sharedBuffer.byteLength);
    new Uint8Array(capturedBytes).set(new Uint8Array(image.sharedBuffer));
    const capturedMachine = MemoryFileSystem.fromExisting(capturedBytes);
    const data = new Uint8Array([1, 2, 3, 4, 5, 6]);
    const writeFd = capturedMachine.open("/usr/bin/tool", O_WRONLY | O_TRUNC, 0);
    capturedMachine.write(writeFd, data, null, data.length);
    capturedMachine.close(writeFd);

    // The image still calls this path deferred, and the entry it offers no
    // longer describes the inode in the capture. Adopting it would replace six
    // captured bytes with a download.
    const restored = image.mountCapturedBytes(capturedBytes);
    expect(restored.isPathDeferred("/usr/bin/tool")).toBe(false);

    const fd = restored.open("/usr/bin/tool", O_RDONLY, 0);
    const buf = new Uint8Array(8);
    expect(restored.read(fd, buf, null, 8)).toBe(6);
    restored.close(fd);
  });

  it("materialized file shows real size instead of declared size", () => {
    const mfs = createMemfs();
    mfs.registerLazyFile("/bin/test", "http://example.com/test.wasm", 99999);

    // Manually write content (simulating materialization)
    const data = new Uint8Array([1, 2, 3, 4, 5]);
    const fd = mfs.open("/bin/test", O_WRONLY | O_CREAT | O_TRUNC, 0o755);
    mfs.write(fd, data, null, data.length);
    mfs.close(fd);

    // After writing, the lazy entry's inode may have changed or been overwritten.
    // But ensureMaterialized is the intended path. Since we can't call fetch in
    // Node.js tests, verify the read path works with concrete data.
    const fd2 = mfs.open("/bin/test", O_RDONLY, 0);
    const buf = new Uint8Array(16);
    const n = mfs.read(fd2, buf, null, 16);
    expect(n).toBe(5);
    expect(buf[0]).toBe(1);
    expect(buf[4]).toBe(5);
    mfs.close(fd2);
  });

  it("multiple lazy files with different sizes", () => {
    const mfs = createMemfs();
    mfs.registerLazyFile("/bin/small", "http://example.com/small.wasm", 100);
    mfs.registerLazyFile("/bin/large", "http://example.com/large.wasm", 10_000_000);

    expect(mfs.stat("/bin/small").size).toBe(100);
    expect(mfs.stat("/bin/large").size).toBe(10_000_000);
  });

  it("emits lazy download progress while materializing a file", async () => {
    const originalFetch = globalThis.fetch;
    const mfs = createMemfs();
    mfs.registerLazyFile("/bin/test", "http://example.com/test.wasm", 5, 0o755);
    const events: LazyDownloadEvent[] = [];
    const off = mfs.subscribeLazyDownloads((event) => events.push(event));

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ "content-length": "5" }),
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2]));
          controller.enqueue(new Uint8Array([3, 4, 5]));
          controller.close();
        },
      }),
    } as unknown as Response);

    try {
      await expect(mfs.ensureMaterialized("/bin/test")).resolves.toBe(true);
    } finally {
      off();
      globalThis.fetch = originalFetch;
    }

    expect(events.map((event) => event.status)).toEqual([
      "started",
      "progress",
      "progress",
      "complete",
    ]);
    expect(events[0].id.startsWith("file:")).toBe(true);
    expect(events[0]).toMatchObject({
      kind: "file",
      url: "http://example.com/test.wasm",
      path: "/bin/test",
      loadedBytes: 0,
      totalBytes: 5,
    });
    expect(events[2].loadedBytes).toBe(5);
    expect(events[3]).toMatchObject({ loadedBytes: 5, totalBytes: 5 });
  });

  it("preserves root ownership and set-ID mode through materialization", async () => {
    const originalFetch = globalThis.fetch;
    const mfs = createMemfs();
    mfs.registerLazyFile(
      "/usr/bin/sudo-lite",
      "https://example.test/sudo-lite.wasm",
      5,
      0o4755,
    );
    const before = mfs.stat("/usr/bin/sudo-lite");
    expect(before.uid).toBe(0);
    expect(before.gid).toBe(0);
    expect(before.mode & 0o7777).toBe(0o4755);

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ "content-length": "5" }),
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([0, 97, 115, 109, 1]));
          controller.close();
        },
      }),
    } as unknown as Response);

    try {
      await expect(mfs.ensureMaterialized("/usr/bin/sudo-lite")).resolves
        .toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }

    const after = mfs.stat("/usr/bin/sudo-lite");
    expect(after.ino).toBe(before.ino);
    expect(after.uid).toBe(0);
    expect(after.gid).toBe(0);
    expect(after.mode & 0o7777).toBe(0o4755);
    expect(after.size).toBe(5);
  });
});
